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
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--no-first-run", "--autoplay-policy=no-user-gesture-required",
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
});
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

// rebass it
await ev(`location.hash = '#rebass'`); await sleep(400);
await click("#rb-pick-lib"); await sleep(500);
await click("#sheet-panel .item"); await sleep(600);
await shot("04_rebass_setup");
await click("#rb-go");
await until(`!document.getElementById('rb-result').hidden`, 90000, "the rebass");
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
await show('#rb-export'); await sleep(300);
await ev(`(() => { const n = document.getElementById('rb-name'); n.value = 'My Night Drive Rebass'; n.dispatchEvent(new Event('input')); return 1; })()`);
await shot("06_rebass_export");
await ev(`delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; 1`);
await click("#rb-save");
let saved = null;
for (let i = 0; i < 60 && !saved; i++) { await sleep(500); saved = readdirSync(dl).find((f) => f.endsWith(".wav")); }
console.log("downloaded:", saved || "nothing");
if (saved) {
  const b = readFileSync(join(dl, saved));
  const data = new Int16Array(b.buffer, b.byteOffset + 44, (b.length - 44) >> 1);
  let pk = 0, full = 0; for (const v of data) { const a = Math.abs(v); if (a > pk) pk = a; if (v >= 32767 || v <= -32768) full++; }
  console.log(`saved WAV: ${(b.length / 1e6).toFixed(1)} MB, peak ${(20 * Math.log10(pk / 32768)).toFixed(2)} dBFS, full-scale samples ${full}`);
}
// the same rebass as an MP3 (encoded, decoded again and checked for clipping before it is handed over)
await click('#rb-format button[data-k="mp3"]');
await click("#rb-save");
let mp3 = null;
for (let i = 0; i < 120 && !mp3; i++) { await sleep(500); mp3 = readdirSync(dl).find((f) => f.endsWith(".mp3")); }
console.log("downloaded MP3:", mp3 ? `${mp3} (${(readFileSync(join(dl, mp3)).length / 1e6).toFixed(2)} MB)` : "nothing");
await click('#rb-format button[data-k="wav16"]');
await click("#rb-keep");
await sleep(2500);
await show('#rb-stats'); await sleep(200);
await shot("06b_rebass_stats");

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
for (let i = 0; i < 60 && !tone; i++) { await sleep(500); tone = readdirSync(dl).find((f) => f.endsWith(".wav") && !f.startsWith("My Night")); }
if (tone) {
  const b = readFileSync(join(dl, tone)), d = new Int16Array(b.buffer, b.byteOffset + 44, (b.length - 44) >> 1);
  let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v));
  console.log(`tone file: ${tone}, ${(d.length / 2 / 48000).toFixed(1)} s, peak ${(20 * Math.log10(pk / 32768)).toFixed(1)} dBFS`);
} else console.log("tone file: nothing");

// the library's rebassed list
await ev(`location.hash = '#library'`); await sleep(300);
await click('#lib-seg button[data-k="rebass"]'); await sleep(800);
await shot("09_library_rebassed");

console.log("errors:", errors.length ? errors.join("\n  ") : "none");
ws.close(); edge.kill();
process.exit(0);
