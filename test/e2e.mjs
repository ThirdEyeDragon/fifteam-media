// Drives the app in Edge (headless, iPhone-sized) through the DevTools protocol: no third-party packages.
//   node test/e2e.mjs <app url> <songs dir> <out dir>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const [url, songsDir, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const dl = resolve(outDir, "downloads"); mkdirSync(dl, { recursive: true });
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const port = 9333;
const prof = resolve(outDir, "profile");
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required",
  "--window-size=390,844", "--disable-features=Translate", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path) { for (let i = 0; i < 50; i++) { try { return await (await fetch(`http://127.0.0.1:${port}${path}`)).json(); } catch { await sleep(200); } } throw new Error("no devtools"); }
const targets = await json("/json/list");
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0; const pending = new Map(); const errors = []; const logs = [];
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === "Runtime.consoleAPICalled" && (d.params.type === "error" || d.params.type === "warning")) errors.push(d.params.args.map((a) => a.value || a.description).join(" "));
  if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push(`${d.params.entry.text} ${d.params.entry.url || ""}`);
  if (d.method) { events.push(d); if (events.length > 500) events.shift(); }
});
const events = [];
const waitEvent = async (method, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const i = events.findIndex((e) => e.method === method); if (i >= 0) return events.splice(i, 1)[0].params; await sleep(100); } throw new Error("no " + method); };
// pick a file in a chooser the page opens itself (cover images)
const chooseFile = async (sel, path) => {
  await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
  events.length = 0;
  await ev(`document.querySelector(${JSON.stringify(sel)}).click(), 1`);
  const fc = await waitEvent("Page.fileChooserOpened");
  await cdp("DOM.setFileInputFiles", { backendNodeId: fc.backendNodeId, files: [path] });
  await cdp("Page.setInterceptFileChooserDialog", { enabled: false });
};
// the samples of a 16-bit WAV (its "data" chunk, whatever else the file carries)
const wavRate = (b) => { let o = 12; while (o + 8 <= b.length) { const id = b.toString("ascii", o, o + 4), n = b.readUInt32LE(o + 4); if (id === "fmt ") return b.readUInt32LE(o + 12); o += 8 + n + (n & 1); } return 48000; };
const wavData = (b) => { let o = 12; while (o + 8 <= b.length) { const id = b.toString("ascii", o, o + 4), n = b.readUInt32LE(o + 4); if (id === "data") return new Int16Array(b.buffer.slice(b.byteOffset + o + 8, b.byteOffset + o + 8 + n)); o += 8 + n + (n & 1); } return new Int16Array(0); };
const cover = resolve(songsDir, "..", "cover.png");
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const until = async (expr, ms = 30000, what = expr) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(250); } throw new Error("timed out waiting for " + what); };
const shot = async (name) => {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, name + ".png"), Buffer.from(r.data, "base64"));
  console.log("shot", name);
};
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error(${JSON.stringify("no " + sel)}); e.click(); return true; })()`);
// scroll a screen (not the page) so that an element sits near the top
const show = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}), v = e.closest('.view'); v.scrollTop += e.getBoundingClientRect().top - v.getBoundingClientRect().top - 8; return 1; })()`);

await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await cdp("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36" });
await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dl });
await cdp("Page.navigate", { url });
await sleep(2500);
await shot("01_first_open");
try {
  const inst = await cdp("Page.getInstallabilityErrors");
  const man = await cdp("Page.getAppManifest");
  console.log("installable:", inst.installabilityErrors.length ? JSON.stringify(inst.installabilityErrors) : "yes", "| manifest errors:", man.errors.length ? JSON.stringify(man.errors) : "none");
  console.log("service worker:", await ev(`navigator.serviceWorker.getRegistration().then(r => r ? (r.active ? 'active' : 'installing') : 'none')`));
} catch (e) { console.log("install check failed:", e.message); }

// bring two songs in through the real file picker
const doc = await cdp("DOM.getDocument", { depth: -1 });
const { nodeId } = await cdp("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#file-in" });
const files = readdirSync(songsDir).filter((f) => f.endsWith(".wav")).map((f) => resolve(songsDir, f));
await cdp("DOM.setFileInputFiles", { nodeId, files });
await until(`document.querySelectorAll('#lib-list .item').length === ${files.length}`, 30000, "songs in the library");
await sleep(800);
console.log("library:", await ev(`[...document.querySelectorAll('#lib-list .item')].map(li => li.querySelector('.t').textContent + ' / ' + li.querySelector('.a').textContent).join(' | ')`));
await shot("02_library");

// play the first, look at Now Playing with the phone tilted
await click("#lib-list .item");
await sleep(600);
await ev(`location.hash = '#player'`);
const orient = (beta, gamma) => ev(`(() => { const e = new Event('deviceorientation'); Object.assign(e, { alpha: 0, beta: ${beta}, gamma: ${gamma} }); dispatchEvent(e); return 1; })()`);
await orient(40, 0); await sleep(300);
for (let i = 0; i < 12; i++) { await orient(40 - i * 1.5, i * 2.2); await sleep(30); }
await sleep(120);
console.log("tilt debug:", await ev(`JSON.stringify({perm: typeof (window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission), motionBtnHidden: document.getElementById('np-motion').hidden, active: document.getElementById('view-player').classList.contains('active')})`));
console.log("art transform:", await ev(`document.getElementById('art').style.transform`), "| playing:", await ev(`!document.querySelector('#np-play use').getAttribute('href').includes('play')`));
await shot("03_player_tilted");
console.log("sound path, all knobs at 5:", await ev(`import('./js/eq.js').then(m => m.eq.route)`));
// turn BASS up to 8.5 with the keyboard, MIDS down a step, and check the song still plays through them
await ev(`(() => { const k = document.querySelector('#kn-bass .knob'); k.focus(); for (let i = 0; i < 7; i++) k.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); const m = document.querySelector('#kn-mids .knob'); m.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return 1; })()`);
await sleep(800);
console.log("knobs:", await ev(`[...document.querySelectorAll('.knob-wrap')].map(w => w.querySelector('.knob-label').textContent + ' ' + w.querySelector('.knob').getAttribute('aria-valuenow') + ' (' + w.querySelector('.knob-sub').textContent + ')').join(' | ')`),
  "| still playing:", await ev(`!document.querySelector('#np-play use').getAttribute('href').includes('play')`));
console.log("sound path, bass up:", await ev(`import('./js/eq.js').then(m => m.eq.route)`));
// (the knobs' sound itself is measured in test/eq.test.mjs)
await ev(`(() => { const k = document.querySelector('#kn-highs .knob'); k.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); return 1; })()`);
await sleep(300);
console.log("knob labels:", await ev(`[...document.querySelectorAll('.knob-wrap')].map(w => w.querySelector('.knob-label').textContent + ' ' + w.querySelector('.knob').getAttribute('aria-valuenow') + ' ' + w.querySelector('.knob-sub').textContent).join(' | ')`));
console.log("now playing for the system:", await ev(`(() => { const m = navigator.mediaSession && navigator.mediaSession.metadata; return m ? m.title + ' / ' + m.artist + ' / ' + m.album + ' / artwork ' + [...m.artwork].map(a => a.sizes).join(' ') : 'none'; })()`));
await ev(`(() => { const v = document.getElementById('view-player'); v.scrollTop = v.scrollHeight; return 1; })()`); await sleep(300);
await shot("03b_player_knobs");
// press and hold MIDS for 3 s with a finger: muted; hold again: back
const holdKnob = async (sel, ms, midShot) => {
  const [x, y] = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  if (midShot) { await sleep(1700); await shot(midShot); await sleep(ms - 1700); } else await sleep(ms);
  await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(250);
};
await holdKnob("#kn-mids .knob", 3300, "03d_holding_mids");
console.log("held MIDS 3 s:", await ev(`document.querySelector('#kn-mids .knob').getAttribute('aria-valuetext')`), "| muted in the sound:", await ev(`import('./js/eq.js').then(m => m.eq.isMuted('mids'))`), "| path:", await ev(`import('./js/eq.js').then(m => m.eq.route)`));
await shot("03e_mids_muted");
await holdKnob("#kn-bass .knob", 1200);
console.log("held BASS only 1.2 s (no change):", await ev(`document.querySelector('#kn-bass .knob').getAttribute('aria-valuetext')`));
await holdKnob("#kn-mids .knob", 3300);
console.log("held MIDS again:", await ev(`document.querySelector('#kn-mids .knob').getAttribute('aria-valuetext')`), "| muted:", await ev(`import('./js/eq.js').then(m => m.eq.isMuted('mids'))`));
await ev(`(() => { const key = (id, k, n) => { const e = document.querySelector('#' + id + ' .knob'); for (let i = 0; i < n; i++) e.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };
  key('kn-bass', 'ArrowDown', 7); key('kn-mids', 'ArrowUp', 1); key('kn-highs', 'ArrowUp', 10); return 1; })()`);
await sleep(300);
console.log("knobs back to 5:", await ev(`[...document.querySelectorAll('.knob-wrap')].map(w => w.querySelector('.knob-label').textContent + ' ' + w.querySelector('.knob').getAttribute('aria-valuenow') + ' ' + w.querySelector('.knob-sub').textContent).join(' | ')`), "| sound path:", await ev(`import('./js/eq.js').then(m => m.eq.route)`));
// a title too long for the screen glides to the left
const realTitle = await ev(`document.getElementById('np-title').textContent`);
await ev(`(async () => { const { marquee } = await import('./js/ui.js'); marquee(document.getElementById('np-title'), 'Midnight Highway Drive (Extended Club Mix) feat. The Night Riders'); document.getElementById('view-player').scrollTop = 0; return 1; })()`);
await sleep(2600);
console.log("long title:", await ev(`(() => { const h = document.getElementById('np-title'), t = h.querySelector('.mq'); return JSON.stringify({ scrolling: h.classList.contains('mq-on'), copies: t.children.length, anim: getComputedStyle(t).animationName, dur: getComputedStyle(t).animationDuration, shift: Math.round(new DOMMatrix(getComputedStyle(t).transform).m41) }); })()`),
  "| short title:", await ev(`(() => { const h = document.getElementById('np-artist'); return h.classList.contains('mq-on') ? 'scrolling' : 'still'; })()`));
await shot("03c_long_title");
await ev(`import('./js/ui.js').then(m => (m.marquee(document.getElementById('np-title'), ${JSON.stringify(realTitle)}), 1))`);

// rebass it
await ev(`location.hash = '#rebass'`); await sleep(400);
await click("#rb-pick-lib"); await sleep(500);
await click("#sheet-panel .item"); await sleep(600);
await shot("04_rebass_setup");
await click("#rb-go");
// the first time: the bass separator is downloaded (51 MB) and started, then the bass is separated
const sepT0 = Date.now(), seen = new Set();
while (Date.now() - sepT0 < 300000) {
  const st = await ev(`document.getElementById('rb-result').hidden ? document.getElementById('rb-stage').textContent : ''`);
  if (!st) break;
  const label = st.replace(/ · .*$/, ""); if (!seen.has(label)) { seen.add(label); console.log(`  ${((Date.now() - sepT0) / 1000).toFixed(1)} s: ${st}`); }
  await sleep(250);
}
await until(`!document.getElementById('rb-result').hidden`, 5000, "the rebass");
console.log(`first rebass (separator downloaded and run): ${((Date.now() - sepT0) / 1000).toFixed(1)} s | isolated (several cores): ${await ev("self.crossOriginIsolated")}`);
console.log("stats:", await ev(`[...document.querySelectorAll('#rb-stats .stat')].map(s => s.querySelector('span').textContent + ': ' + s.querySelector('b').textContent).join(' | ')`));
await click("#rb-play"); await sleep(2500);
await show('#rb-result'); await sleep(300);
await shot("05_rebass_live");
// a different range and level: it re-renders on its own
await ev(`(() => { const lo = document.getElementById('rb-lo'), hi = document.getElementById('rb-hi'), db = document.getElementById('rb-db');
  lo.value = 20; lo.dispatchEvent(new Event('input')); hi.value = 35; hi.dispatchEvent(new Event('input')); db.value = 0; db.dispatchEvent(new Event('input')); return 1; })()`);
await sleep(600);
await until(`document.getElementById('rb-busy').hidden`, 60000, "the re-render");
console.log("stats at 20-35 Hz, 0 dB:", await ev(`[...document.querySelectorAll('#rb-stats .stat')].map(s => s.querySelector('span').textContent + ': ' + s.querySelector('b').textContent).join(' | ')`));
// slow it to 75% with reverb: the bass is found again on the slowed song
await click('#rb-slow'); await sleep(100);
await click('#rb-speed-presets .chip[data-s="75"]'); await sleep(100);
await click('#rb-reverb');
await sleep(600);
await until(`document.getElementById('rb-busy').hidden`, 90000, "the slowed render");
console.log("stats slowed 75% + reverb:", await ev(`[...document.querySelectorAll('#rb-stats .stat')].map(s => s.querySelector('span').textContent + ': ' + s.querySelector('b').textContent).join(' | ')`));
console.log("name now:", await ev(`document.getElementById('rb-name').value`), "| length:", await ev(`document.getElementById('rb-dur').textContent`));
console.log("slow hint:", await ev(`document.getElementById('rb-speed-hint').textContent`));
console.log("options gone (old-bass switches, keep in key / stretch, snap):", await ev(`['rb-only', 'rb-replace', 'rb-mode', 'rb-snap'].filter(id => document.getElementById(id)).join(', ') || 'all gone'`));
await click("#rb-play"); await sleep(2500);
await show('#rb-result'); await sleep(300);
await shot("05b_rebass_slowed");
await click("#rb-play");
await show('#rb-export'); await sleep(300);
await chooseFile("#rb-cover-pick", cover);
await until(`document.getElementById('rb-cover-note').textContent.includes('your image')`, 10000, "the cover");
console.log("cover:", await ev(`document.getElementById('rb-cover-note').textContent`));
await ev(`(() => { const n = document.getElementById('rb-name'); n.value = 'My Night Drive Rebass'; n.dispatchEvent(new Event('input')); return 1; })()`);
await shot("06_rebass_export");
// the intro: on, the rebass starts with the FifTeam Production tag (5.4 s longer); off, it's gone again
const durOf = () => ev(`document.getElementById('rb-dur').textContent`);
const durNo = await durOf();
await ev(`(() => { const i = document.getElementById('rb-intro'); i.checked = true; i.dispatchEvent(new Event('change')); return 1; })()`);
await until(`document.getElementById('rb-dur').textContent !== ${JSON.stringify(durNo)}`, 10000, "the intro");
const durIntro = await durOf();
await ev(`(() => { const i = document.getElementById('rb-intro'); i.checked = false; i.dispatchEvent(new Event('change')); return 1; })()`); await sleep(500);
console.log("intro:", durNo, "->", durIntro, "with it ->", await durOf(), "without | remembered:", await ev(`localStorage.getItem('fifteam-intro')`));
await ev(`(() => { const i = document.getElementById('rb-intro'); i.checked = true; i.dispatchEvent(new Event('change')); return 1; })()`); await sleep(800);
await show('#rb-intro'); await sleep(300);
await shot("05c_intro_switch");
await show('#rb-ov'); await sleep(300);
await shot("05d_intro_in_strip");
await show('#rb-export'); await sleep(300);
await ev(`delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; 1`);
await click("#rb-save");
let saved = null;
for (let i = 0; i < 60 && !saved; i++) { await sleep(500); saved = readdirSync(dl).find((f) => f.endsWith(".wav")); }
console.log("downloaded:", saved || "nothing");
if (saved) {
  const b = readFileSync(join(dl, saved));
  const data = wavData(b);
  let pk = 0, full = 0; for (const v of data) { const a = Math.abs(v); if (a > pk) pk = a; if (v >= 32767 || v <= -32768) full++; }
  const wr = wavRate(b);
  console.log(`saved WAV: ${(b.length / 1e6).toFixed(1)} MB, ${wr} Hz, ${(data.length / 2 / wr).toFixed(1)} s, peak ${(20 * Math.log10(pk / 32768)).toFixed(2)} dBFS, full-scale samples ${full}, tags ${b.includes("id3 ") ? "id3" : "-"}/${b.includes("INAM") ? "INFO" : "-"}`);
  // the intro's 5.4 s at its start, then the song
  let a1 = 0, a2 = 0; const n1 = Math.round(5.3 * wr) * 2, n2 = Math.round(5.6 * wr) * 2;
  for (let i = 0; i < n1; i++) a1 = Math.max(a1, Math.abs(data[i])); for (let i = n2; i < n2 + 2 * wr; i++) a2 = Math.max(a2, Math.abs(data[i]));
  console.log(`saved WAV starts with the intro: peak of its first 5.3 s ${(20 * Math.log10(a1 / 32768)).toFixed(1)} dBFS, the song after it ${(20 * Math.log10(a2 / 32768)).toFixed(1)} dBFS`);
}
// the same rebass as an MP3 (encoded, decoded again and checked for clipping before it is handed over)
await click('#rb-format button[data-k="mp3"]');
await click("#rb-save");
let mp3 = null;
for (let i = 0; i < 120 && !mp3; i++) { await sleep(500); mp3 = readdirSync(dl).find((f) => f.endsWith(".mp3")); }
console.log("downloaded MP3:", mp3 ? `${mp3} (${(readFileSync(join(dl, mp3)).length / 1e6).toFixed(2)} MB)` : "nothing");
if (mp3) {
  const b = readFileSync(join(dl, mp3));
  const tagLen = ((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127);
  const tag = b.subarray(10, 10 + tagLen), apic = tag.indexOf("APIC"), jpg = tag.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  console.log(`MP3 tag: ${b.subarray(0, 3).toString()} v2.${b[3]}, ${tagLen} bytes, title frame ${tag.indexOf("TIT2") >= 0}, cover ${apic >= 0 && jpg > apic ? "JPEG " + (tagLen - jpg) + " bytes" : "missing"}`);
}
await click('#rb-format button[data-k="wav16"]');
await click("#rb-keep");
await sleep(2500);
await show('#rb-stats'); await sleep(200);
await shot("06b_rebass_stats");

// share: a locked file, sent and opened again as a friend would
const statsLine = () => ev(`[...document.querySelectorAll('#rb-stats .stat')].map(s => s.querySelector('span').textContent.replace(/^(Old bass removed) · .*/, '$1') + ': ' + s.querySelector('b').textContent).join(' | ')`);
const statsBefore = await statsLine();
await ev(`navigator.share = undefined; navigator.canShare = undefined; 1`);
await click("#rb-share"); await sleep(500);
await shot("13_share_sheet");
await ev(`[...document.querySelectorAll('#sheet-panel .menu-item')].find(b => b.textContent.includes('locked')).click(), 1`);
await until(`!!document.querySelector('#sheet-panel .code-box b')`, 60000, "the unlock code");
const code = await ev(`document.querySelector('#sheet-panel .code-box b').textContent`);
console.log("unlock code:", code, "| looks right:", /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code));
await shot("13b_locked_code");
const beforeFiles = new Set(readdirSync(dl));
await ev(`document.querySelector('#sheet-panel [data-send]').click(), 1`);
let lockedName = null;
for (let i = 0; i < 60 && !lockedName; i++) { await sleep(500); lockedName = readdirSync(dl).find((f) => !beforeFiles.has(f) && f.includes("(locked)") && f.endsWith(".wav")); }
console.log("locked file:", lockedName ? `${lockedName} (${(readFileSync(join(dl, lockedName)).length / 1e6).toFixed(1)} MB)` : "nothing");
await ev(`document.getElementById('sheet').classList.remove('open'), 1`);
if (lockedName) {
  // anywhere else it is a second of silence
  const lb = readFileSync(join(dl, lockedName)), pcm = wavData(lb);
  let pk = 0; for (const v of pcm) pk = Math.max(pk, Math.abs(v));
  console.log(`locked file played elsewhere: ${(pcm.length / 8000).toFixed(1)} s, peak ${pk} (silence: ${pk === 0})`);
  // a friend adds it: it asks for the code; a wrong one is refused; the right one opens it into the library
  await ev(`location.hash = '#library'`); await sleep(400);
  const before = await ev(`document.querySelectorAll('#lib-list .item').length`);
  const { nodeId: fin } = await cdp("DOM.querySelector", { nodeId: (await cdp("DOM.getDocument", { depth: -1 })).root.nodeId, selector: "#file-in" });
  await cdp("DOM.setFileInputFiles", { nodeId: fin, files: [join(dl, lockedName)] });
  await until(`!!document.querySelector('#sheet.open .code-in')`, 15000, "the code prompt");
  await shot("14_unlock_prompt");
  await ev(`(() => { const i = document.querySelector('#sheet-panel .code-in'); i.value = 'AAAA-BBBB-CCCC'; [...document.querySelectorAll('#sheet-panel button')].find(b => b.textContent.includes('Open it')).click(); return 1; })()`);
  await sleep(3000);
  console.log("wrong code:", await ev(`document.querySelector('#sheet-panel .set-err').textContent`));
  await ev(`(() => { const i = document.querySelector('#sheet-panel .code-in'); i.value = ${JSON.stringify(code.toLowerCase().replace(/-/g, " "))}; [...document.querySelectorAll('#sheet-panel button')].find(b => b.textContent.includes('Open it')).click(); return 1; })()`);
  await until(`!document.getElementById('sheet').classList.contains('open')`, 30000, "the unlock");
  await sleep(1500);
  await click('#lib-seg button[data-k="rebass"]'); await sleep(600);
  console.log("unlocked into the library:", await ev(`[...document.querySelectorAll('#lib-list .item')].map(li => li.querySelector('.t').textContent + ' / ' + li.querySelector('.a').textContent).join(' | ')`));
  console.log("the same audio as sent:", await ev(`(async () => { const s = await import('./js/store.js'); const all = await s.listTracks(); const u = all.filter(t => t.from === 'locked'); if (!u.length) return 'none'; const b = await s.getBlob(u[u.length - 1].id); return b.size + ' bytes, type ' + b.type; })()`), "| sent:", saved ? readFileSync(join(dl, saved)).length + " bytes" : "?");
  await shot("14b_unlocked");
}

// share: a rebass code, opened again from the library: the same song, set up the same way, rebassed again
await ev(`location.hash = '#rebass'`); await sleep(500);
await click("#rb-share"); await sleep(500);
await ev(`[...document.querySelectorAll('#sheet-panel .menu-item')].find(b => b.textContent.includes('rebass code')).click(), 1`);
await until(`!!document.querySelector('#sheet-panel .code-box.long code')`, 30000, "the rebass code");
const recipe = await ev(`document.querySelector('#sheet-panel .code-box.long code').textContent`);
console.log("rebass code:", recipe.length, "characters:", recipe.slice(0, 40) + "…");
await shot("15_rebass_code");
await ev(`document.getElementById('sheet').classList.remove('open'), 1`);
// change the settings, so opening the code has to put them back
await ev(`(() => { const lo = document.getElementById('rb-lo'); lo.value = 35; lo.dispatchEvent(new Event('input')); return 1; })()`); await sleep(400);
await until(`document.getElementById('rb-busy').hidden`, 90000, "a re-render");
await ev(`location.hash = '#library'`); await sleep(400);
await click("#lib-code"); await sleep(400);
await ev(`(() => { const t = document.querySelector('#sheet-panel .code-in'); t.value = 'Here you go: ' + ${JSON.stringify(recipe)} + ' enjoy'; [...document.querySelectorAll('#sheet-panel button')].find(b => b.textContent.includes('Open the code')).click(); return 1; })()`);
await until(`location.hash === '#rebass'`, 20000, "the rebass screen");
await sleep(1500);
await until(`!document.getElementById('rb-result').hidden && document.getElementById('rb-busy').hidden`, 120000, "the rebass from the code");
const statsAfter = await statsLine();
console.log("from the code:", await ev(`document.getElementById('rb-range-val').textContent + ' · ' + document.getElementById('rb-db-val').textContent + ' · slowed ' + document.getElementById('rb-slow').checked + ' ' + document.getElementById('rb-speed').value + '% · reverb ' + document.getElementById('rb-reverb').checked`));
console.log("same rebass as before:", statsAfter === statsBefore, statsAfter === statsBefore ? "" : `\n    before: ${statsBefore}\n    after:  ${statsAfter}`);
await shot("15b_from_code");
// a link with the code in it opens it too
await cdp("Page.navigate", { url: url.replace(/#.*$/, "").replace(/\/?$/, "/") + "#code=" + recipe }); await sleep(3500);
console.log("a link with the code:", await ev(`location.hash`));

// sharing a file: what happens for each answer the phone can give
console.log("sharing a file:", await ev(`(async () => {
  const { sendFile } = await import('./js/share.js'), { fitFormat, SHARE_MAX } = await import('./js/export.js');
  window.showSaveFilePicker = undefined;
  const f = new File([new Uint8Array(1000)], 'share test.wav', { type: 'audio/wav' }), box = document.createElement('div');
  let calls = 0; navigator.canShare = () => true;
  const as = (name, msg) => async () => { calls++; if (name) throw new DOMException(msg, name); };
  const r = [];
  navigator.share = as(''); r.push('works: ' + await sendFile(f, 't', box));
  navigator.share = as('AbortError', 'Share canceled'); r.push('closed by the person: ' + await sendFile(f, 't', box));
  navigator.share = as('NotAllowedError', 'Must be handling a user gesture to perform a share request.'); r.push('tap ran out: ' + await sendFile(f, 't', box) + (box.querySelector('button') ? ' (button shown)' : ''));
  navigator.share = as('NotAllowedError', 'Permission denied'); r.push('refused: ' + await sendFile(f, 't', box));
  navigator.share = as('AbortError', 'Share failed'); r.push('failed: ' + await sendFile(f, 't', box));
  const c0 = calls; const big = new File([new Uint8Array(SHARE_MAX + 1)], 'big.wav', { type: 'audio/wav' });
  r.push('60 MB file: ' + await sendFile(big, 't', box) + (calls === c0 ? ' (not offered to the sheet)' : ' (offered!)'));
  r.push('5 min slowed WAV 16 shares as ' + fitFormat('wav16', 300, 48000, SHARE_MAX) + ', a 3 min one as ' + fitFormat('wav16', 180, 48000, SHARE_MAX) + ', 3 min WAV 24 as ' + fitFormat('wav24', 180, 48000, SHARE_MAX));
  navigator.share = undefined; navigator.canShare = undefined;
  return r.join(' | ');
})()`));

// tones
await ev(`location.hash = '#tones'`); await sleep(400);
await click("#tg-play"); await sleep(1200);
await ev(`document.querySelector('#view-tones').scrollTop = 0`);
await shot("07_tones");
await click("#tg-play");
await ev(`document.querySelector('#view-tones').scrollTop = 99999`); await sleep(300);
await shot("08_tones_more");
await click('#tg-len .chip[data-s="10"]');
await click("#tg-save");
let tone = null;
for (let i = 0; i < 60 && !tone; i++) { await sleep(500); tone = readdirSync(dl).find((f) => f.endsWith(".wav") && !f.startsWith("My Night") && !/^(share test|big)/.test(f)); }
if (tone) {
  const b = readFileSync(join(dl, tone)), d = wavData(b);
  let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v));
  console.log(`tone file: ${tone}, ${(d.length / 2 / 48000).toFixed(1)} s, peak ${(20 * Math.log10(pk / 32768)).toFixed(1)} dBFS`);
} else console.log("tone file: nothing");

// the library's rebassed list
await ev(`location.hash = '#library'`); await sleep(300);
await click('#lib-seg button[data-k="rebass"]'); await sleep(800);
await shot("09_library_rebassed");

// settings: set a password and lock the app
await click('#btn-settings'); await sleep(800);
console.log("settings, bass separator:", await ev(`document.getElementById('set-sep-pill').textContent`), "| remove button:", await ev(`!document.getElementById('set-sep-del').hidden`));
await shot("10_settings");
await ev(`(() => { const i = document.querySelectorAll('#set-lock input[type=password]'); i[0].value = 'blue42'; i[1].value = 'blue42'; [...document.querySelectorAll('#set-lock button')].find(b => b.textContent.includes('Set password')).click(); return 1; })()`);
await until(`[...document.querySelectorAll('#set-lock button')].some(b => b.textContent.includes('Lock now'))`, 10000, "the password to be set");
await shot("10b_settings_password");
console.log("password kept as:", await ev(`(() => { const r = JSON.parse(localStorage.getItem('fifteam-lock')); return 'PBKDF2 x' + r.it + ', salt ' + atob(r.salt).length + ' bytes, hash ' + atob(r.hash).length + ' bytes, plain text stored: ' + JSON.stringify(localStorage).includes('blue42'); })()`));
await ev(`[...document.querySelectorAll('#set-lock button')].find(b => b.textContent.includes('Lock now')).click(), 1`);
await sleep(500);
const lockState = () => ev(`JSON.stringify({ overlay: !document.getElementById('lock').hidden, appInert: document.getElementById('app').inert, saved: localStorage.getItem('fifteam-locked') })`);
console.log("locked:", await lockState());
// real taps on the Player tab and the play button: nothing may happen
const hashBefore = await ev("location.hash");
for (const sel of ['#tabs a[data-v="player"]', '#lib-list .item']) {
  const [x, y] = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`).catch(() => [195, 800]);
  await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }); await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
await sleep(500);
console.log("taps while locked: hash", hashBefore, "->", await ev("location.hash"), "| playing:", await ev(`import('./js/player.js').then(m => m.player.playing)`));
await shot("11_locked");
// closing and reopening the app: still locked
await cdp("Page.reload"); await sleep(3000);
console.log("after reopening:", await lockState());
await ev(`(() => { document.getElementById('lock-pw').value = 'nope'; document.getElementById('lock-form').requestSubmit(); return 1; })()`); await sleep(900);
console.log("wrong password:", await ev(`document.getElementById('lock-err').textContent`), "| still locked:", await ev(`!document.getElementById('lock').hidden`));
await shot("11b_wrong_password");
await ev(`(() => { document.getElementById('lock-pw').value = 'blue42'; document.getElementById('lock-form').requestSubmit(); return 1; })()`); await sleep(900);
console.log("right password:", await lockState());

// demo mode: on from settings, straight to the player, and rings on the bass hits
await click('#btn-settings'); await sleep(400);
await click('#set-demo'); await sleep(700);
console.log("demo mode on, screen:", await ev("location.hash"));
await ev(`location.hash = '#library'`); await sleep(300);
await click('#lib-seg button[data-k="song"]'); await sleep(500);
await click("#lib-list .item"); await sleep(400);
await ev(`location.hash = '#player'`);
await until(`import('./js/demo.js').then(m => !!m.demo.hits)`, 20000, "the bass hits");
console.log("demo hits:", await ev(`import('./js/demo.js').then(m => { const h = m.demo.hits, t = []; for (let i = 0; i < h.length; i += 2) t.push(h[i]); const d = t.slice(1).map((v, i) => v - t[i]); return (h.length / 2) + ' hits, first ' + t.slice(0, 8).map(v => v.toFixed(2)).join(' ') + ' s, median gap ' + d.sort((a, b) => a - b)[d.length >> 1].toFixed(3) + ' s'; })`));
const st0 = await ev(`import('./js/demo.js').then(m => m.demo.state)`);
await sleep(4000);
const st1 = await ev(`import('./js/demo.js').then(m => m.demo.state)`);
console.log("lava lamp:", JSON.stringify(st1), "| pulses in 4 s:", st1.fired - st0.fired, "| playing:", await ev(`import('./js/player.js').then(m => m.player.playing)`),
  "| canvas:", await ev(`(() => { const c = document.getElementById('lava'); return c ? c.width + 'x' + c.height + ' ' + getComputedStyle(c).opacity : 'none'; })()`));
await until(`import('./js/demo.js').then(m => m.demo.state.pulse > 0.6)`, 5000, "a bass pulse");
await shot("12_demo_lava_hit");
await sleep(2200);
await shot("12b_demo_lava_later");
await click('#np-play'); await sleep(2500);
await shot("12c_demo_lava_paused");
console.log("paused, still drifting:", JSON.stringify(await ev(`import('./js/demo.js').then(m => m.demo.state)`)));

console.log("tones polarity label:", await ev(`document.getElementById('tg-flip').closest('label').textContent.trim()`));
console.log("errors:", errors.length ? errors.join("\n  ") : "none");
ws.close(); edge.kill();
process.exit(0);
