// node test/social.test.mjs - FifTeam Social in headless Edge against a stand-in for Discord (answered here through the
// DevTools protocol; discord.com never sees these requests): picking a username, the feed, posting a picture and a
// rebass, playing and keeping someone's song, deleting, a post deleted in Discord, markup in a post, no pings. Also the
// knob lock on the Player.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser } from "./cdp.mjs";

const port = 8400 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), String(port)], { stdio: "ignore" });
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.log("  FAIL:", what); } };

// ------------------------------------------------------------------------------------------- the stand-in Discord
const HOOK = "111222333", TOKEN = "fake-webhook-token", INDEX = "900000000000000001";
const msgs = new Map(), cdn = new Map(), posted = [];
let nextId = 900000000000001000n;
const attach = (id, name, bytes, type) => { const url = `https://cdn.discordapp.com/attachments/1/${id}/${name}?ex=abc`; cdn.set(url.split("?")[0], { bytes, type }); return { id: String(Math.random()).slice(2), filename: name, url }; };
const tinyJpeg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=", "base64");
const bob = "900000000000000101", eve = "900000000000000102";
msgs.set(bob, { id: bob, content: "**Bob**", attachments: [attach(bob, "picture.jpg", tinyJpeg, "image/jpeg"), attach(bob, "song.mp4", Buffer.alloc(4000, 0xff), "video/mp4")] });
msgs.set(eve, { id: eve, content: "**Eve**", attachments: [] });
const seedFeed = [
  { id: bob, at: Date.now() - 3600e3, user: 'Bob <img src=x onerror="window.__pwned=1">', text: "My first rebass <script>window.__pwned=1</script>", image: true, song: { title: "Night Drive (Rebass)", artist: "Bob", note: "25–45 Hz · −3 dB", duration: 42 } },
  { id: eve, at: Date.now() - 7200e3, user: "Eve", text: "hello all", image: false, song: null },
  { id: "not-a-number", at: 0, user: "x", text: "bad id" },
];
const bobPic = "900000000000000201";
msgs.set(bobPic, { id: bobPic, content: "", attachments: [attach(bobPic, "avatar.jpg", tinyJpeg, "image/jpeg")] });
const seedProfiles = { bobphone001: { name: seedFeed[0].user, av: bobPic, at: Date.now() - 86400e3 } };
msgs.set(INDEX, { id: INDEX, content: "FifTeam Social feed", attachments: [attach(INDEX, "feed.json", Buffer.from(JSON.stringify({ v: 1, posts: seedFeed, profiles: seedProfiles })), "application/json")] });
const feedNow = () => JSON.parse(cdn.get(msgs.get(INDEX).attachments[0].url.split("?")[0]).bytes.toString()).posts;
const profilesNow = () => JSON.parse(cdn.get(msgs.get(INDEX).attachments[0].url.split("?")[0]).bytes.toString()).profiles || {};

function multipart(body, ctype) {
  const bnd = /boundary=(.+)$/.exec(ctype)[1], parts = {}, sep = Buffer.from("--" + bnd);
  let i = body.indexOf(sep);
  while (i >= 0) {
    const next = body.indexOf(sep, i + sep.length); if (next < 0) break;
    const part = body.subarray(i + sep.length + 2, next - 2), he = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, he).toString(), name = /name="([^"]+)"/.exec(head)[1], file = /filename="([^"]+)"/.exec(head);
    parts[name] = { data: part.subarray(he + 4), filename: file && file[1] };
    i = next;
  }
  return parts;
}
const json = (o, status = 200) => ({ status, type: "application/json", body: Buffer.from(JSON.stringify(o)) });
function discord(method, url, headers, body) {
  const u = new URL(url);
  if (u.host === "cdn.discordapp.com") { const f = cdn.get(url.split("?")[0]); return f ? { status: 200, type: f.type, body: f.bytes } : { status: 404, type: "text/plain", body: Buffer.from("no") }; }
  if (u.pathname.endsWith("/social/config.json")) return json({ hook: HOOK, key: Buffer.from(TOKEN.split("").reverse().join("")).toString("base64"), index: INDEX });
  const base = `/api/v10/webhooks/${HOOK}/${TOKEN}`;
  if (!u.pathname.startsWith(base)) return json({ message: "Unknown Webhook", code: 10015 }, 404);
  const rest = u.pathname.slice(base.length), m = /^\/messages\/(\d+)$/.exec(rest);
  if (method === "GET" && m) return msgs.has(m[1]) ? json(msgs.get(m[1])) : json({ message: "Unknown Message" }, 404);
  if (method === "DELETE" && m) { if (!msgs.has(m[1])) return json({ message: "Unknown Message" }, 404); msgs.delete(m[1]); return { status: 204, type: "text/plain", body: Buffer.alloc(0) }; }
  if ((method === "POST" && rest === "") || (method === "PATCH" && m)) {
    const parts = multipart(body, headers["Content-Type"] || headers["content-type"]);
    const payload = JSON.parse(parts.payload_json.data.toString());
    const id = m ? m[1] : String(nextId++);
    const atts = Object.entries(parts).filter(([k]) => k.startsWith("files[")).map(([, p]) => attach(id, p.filename, Buffer.from(p.data), p.filename.endsWith(".json") ? "application/json" : p.filename.endsWith(".mp4") ? "video/mp4" : p.filename.endsWith(".webm") ? "video/webm" : "image/jpeg"));
    msgs.set(id, { id, content: payload.content, attachments: atts });
    if (!m) posted.push({ id, payload, files: atts.map((a) => [a.filename, cdn.get(a.url.split("?")[0]).bytes]) });
    return json(msgs.get(id));
  }
  return json({ message: "405" }, 405);
}

const b = await browser({ profile: mkdtempSync(join(tmpdir(), "ft-so-")) });
const { ev, send, sleep } = b;
const CORS = [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Access-Control-Allow-Headers", value: "Content-Type" }, { name: "Access-Control-Allow-Methods", value: "GET, POST, PATCH, DELETE, OPTIONS" }];
b.on(async (m) => {
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  if (request.method === "OPTIONS") { await send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: CORS }, m.sessionId); return; }
  let body = Buffer.alloc(0);
  if (request.postDataEntries) body = Buffer.concat(request.postDataEntries.map((e) => Buffer.from(e.bytes || "", "base64")));
  else if (request.postData) body = Buffer.from(request.postData);
  const r = discord(request.method, request.url, request.headers, body);
  await send("Fetch.fulfillRequest", { requestId, responseCode: r.status, responseHeaders: [...CORS, { name: "Content-Type", value: r.type }], body: r.body.toString("base64") }, m.sessionId);
});
await send("Fetch.enable", { patterns: [{ urlPattern: "https://discord.com/*" }, { urlPattern: "https://cdn.discordapp.com/*" }, { urlPattern: "*social/config.json*" }] });
const until = async (expr, ms, what) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } check(false, "timed out waiting for " + what); return false; };
const text = (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent).join(' | ')`);
const shot = async (name) => { if (!process.env.SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(process.env.SHOTS, name + ".png"), Buffer.from(r.result.data, "base64")); };

try {
  await b.open(`http://127.0.0.1:${port}/#social`, 3000);
  await until(`document.querySelectorAll('#so-body .so-post').length > 0`, 15000, "the feed");
  console.log("no Me tab:", await ev(`!document.getElementById('so-seg') && !/\\bMe\\b/.test(document.getElementById('view-social').textContent)`));
  const feed = await text("#so-body .so-post");
  console.log("feed:", feed.slice(0, 200));
  check((await ev(`document.querySelectorAll('#so-body .so-post').length`)) === 2, "two good posts (the one with a bad id dropped)");
  check(!(await ev(`!!window.__pwned`)) && !(await ev(`!!document.querySelector('#so-body img[src="x"], #so-body script')`)), "markup in a post stays text");
  await until(`!!document.querySelector('#so-body img.so-img') && document.querySelector('#so-body img.so-img').naturalWidth > 0`, 8000, "the picture");
  await shot("d1_feed");
  await until(`/cdn\.discordapp\.com.*avatar\.jpg/.test(document.querySelector('#so-body .so-post .so-av').style.backgroundImage)`, 8000, "Bob's picture on his post (from his profile)");
  console.log("Bob's picture on his older post:", await ev(`/avatar\.jpg/.test(document.querySelector('#so-body .so-post .so-av').style.backgroundImage)`));

  // the username
  const setName = (v) => ev(`(() => { const f = document.querySelector('#so-body .so-nameform'); f.querySelector('input').value = ${JSON.stringify(v)}; f.requestSubmit(); return 1; })()`);
  await setName("a"); await sleep(200);
  console.log("too short a name:", await text("#so-body .so-you .set-err"));
  await setName("Alice"); await sleep(300);
  console.log("name set:", await text("#so-body .so-you"), "| kept:", await ev(`localStorage.getItem('fifteam-social-name')`));
  check((await text("#so-body .so-yourname")) === "Alice", "username set");

  // a profile picture (goes with each post)
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  const avChooser = new Promise((res) => b.on((m) => { if (m.method === "Page.fileChooserOpened") res(m.params); }));
  await ev(`document.querySelector('#so-body .so-avbtn').click(), 1`);
  const avFc = await avChooser;
  const avPng = join(mkdtempSync(join(tmpdir(), "ft-av-")), "me.png");
  writeFileSync(avPng, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==", "base64"));
  await send("DOM.setFileInputFiles", { backendNodeId: avFc.backendNodeId, files: [avPng] });
  await send("Page.setInterceptFileChooserDialog", { enabled: false });
  await until(`(localStorage.getItem('fifteam-social-avatar') || '').startsWith('data:image/jpeg')`, 8000, "the profile picture");
  console.log("profile picture kept on the phone:", await ev(`localStorage.getItem('fifteam-social-avatar').length + ' characters'`));
  const meId = await ev(`localStorage.getItem('fifteam-social-me')`);
  for (let i = 0; i < 40 && !(profilesNow()[meId] && profilesNow()[meId].av); i++) await sleep(200);
  const myPr = profilesNow()[meId] || {};
  console.log("profile on the feed:", JSON.stringify(myPr), "| its picture:", myPr.av && msgs.has(myPr.av) ? msgs.get(myPr.av).attachments.map((a) => a.filename).join(",") : "missing");
  check(myPr.name === "Alice" && myPr.av && msgs.get(myPr.av).attachments.some((a) => a.filename === "avatar.jpg"), "the picture is on the feed's profiles at once");

  // a like on Eve's post: shown at once, saved to the feed list under this phone; again: gone
  const eveLikes = () => (feedNow().find((x) => x.id === eve) || {}).likes || [];
  await ev(`document.querySelector('#so-body .so-like[data-id="${eve}"]').click(), 1`);
  console.log("like shown at once:", await ev(`document.querySelector('#so-body .so-like[data-id="${eve}"]').textContent`));
  for (let i = 0; i < 40 && !eveLikes().length; i++) await sleep(200);
  const me = await ev(`localStorage.getItem('fifteam-social-me')`);
  console.log("like saved:", JSON.stringify(eveLikes()), "| this phone:", me);
  check(eveLikes().length === 1 && eveLikes()[0] === me, "the like is in the feed list");
  await ev(`document.querySelector('#so-body .so-like[data-id="${eve}"]').click(), 1`);
  for (let i = 0; i < 40 && eveLikes().length; i++) await sleep(200);
  check(eveLikes().length === 0 && (await ev(`document.querySelector('#so-body .so-like[data-id="${eve}"]').textContent`)) === "♥", "unliked");
  await ev(`document.querySelector('#so-body .so-like[data-id="${eve}"]').click(), 1`);
  for (let i = 0; i < 40 && !eveLikes().length; i++) await sleep(200);

  // a comment on Eve's post: shown at once, saved to the feed under this phone; then deleted
  const eveComments = () => (feedNow().find((x) => x.id === eve) || {}).comments || [];
  const eveCard = `document.querySelector('#so-body .so-post[data-id="${eve}"]')`;
  await ev(`${eveCard}.querySelector('.so-cbtn').click(), 1`); await sleep(200);
  await ev(`(() => { const f = ${eveCard}.querySelector('.so-cform'); f.querySelector('input').value = 'Hard!'; f.requestSubmit(); return 1; })()`);
  for (let i = 0; i < 40 && !eveComments().length; i++) await sleep(200);
  await sleep(300);
  console.log("comment saved:", JSON.stringify(eveComments().map((c) => ({ user: c.user, text: c.text, by: c.by === me }))), "| shown:", await ev(`[...${eveCard}.querySelectorAll('.so-comment')].map(c => c.textContent).join(' | ')`), "| count:", await ev(`${eveCard}.querySelector('.so-cbtn').textContent`));
  check(eveComments().length === 1 && eveComments()[0].text === "Hard!" && eveComments()[0].by === me, "the comment is on the feed");
  await shot("d5_comments");
  await ev(`${eveCard}.querySelector('.so-cdel').click(), 1`);
  for (let i = 0; i < 40 && eveComments().length; i++) await sleep(200);
  check(eveComments().length === 0, "own comment deleted");
  await ev(`(() => { const f = ${eveCard}.querySelector('.so-cform'); f.querySelector('input').value = 'Nice one'; f.requestSubmit(); return 1; })()`);
  for (let i = 0; i < 40 && !eveComments().length; i++) await sleep(200);

  // someone's song: play it and keep it
  await ev(`document.querySelector('#so-body .so-song .so-play').click(), 1`); await sleep(800);
  console.log("playing:", await ev(`(import('./js/social.js').then(m => (m.social.state.audio && m.social.state.audio.src || '').slice(0, 20) + ' (the song downloaded)'))`));
  await ev(`document.querySelector('#so-body .so-song .so-add').click(), 1`);
  await until(`import('./js/library.js').then(m => m.library.all().some(t => t.from === 'social'))`, 10000, "the song in the library");
  console.log("kept from the feed:", await ev(`import('./js/library.js').then(m => m.library.all().filter(t => t.from === 'social').map(t => t.title + ' / ' + t.note + ' / ' + t.size + ' bytes').join(''))`));

  // a post: text with a ping in it, a picture, and a rebass from the library
  await ev(`(async () => {
    const lib = await import('./js/library.js'), store = await import('./js/store.js'), { encodeWav } = await import('./js/dsp.js');
    const n = 48000 * 3, x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 40 * i / 48000);
    const f = new File([encodeWav([x, x], 48000, 16)], 'Test Rebass.wav', { type: 'audio/wav' });
    await lib.library.add({ id: store.newId(), kind: 'rebass', title: 'Test Rebass', artist: 'Alice', note: '25–45 Hz · −3 dB', duration: 3, size: f.size, type: f.type, fileName: f.name, added: Date.now(), hasArt: false }, f, null);
    return 1; })()`);
  await ev(`document.querySelector('#so-body .so-new').click(), 1`); await sleep(400);
  await ev(`(() => { document.querySelector('#sheet-panel textarea').value = 'Fresh one @everyone'; return 1; })()`);
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  const chooser = new Promise((res) => b.on((m) => { if (m.method === "Page.fileChooserOpened") res(m.params); }));
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent.includes('Picture')).click(), 1`);
  const fc = await chooser;
  const png = join(mkdtempSync(join(tmpdir(), "ft-img-")), "pic.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==", "base64"));
  await send("DOM.setFileInputFiles", { backendNodeId: fc.backendNodeId, files: [png] });
  await send("Page.setInterceptFileChooserDialog", { enabled: false });
  await until(`!!document.querySelector('#sheet-panel .so-img')`, 8000, "the picture in the new post");
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent.includes('Rebassed song')).click(), 1`); await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .item')].find(i => i.textContent.includes('Test Rebass')).click(), 1`); await sleep(500);
  await shot("d2_new_post");
  console.log("new post before sending:", await ev(`document.querySelector('#sheet-panel textarea').value + ' | picture ' + !!document.querySelector('#sheet-panel .so-img') + ' | song ' + (document.querySelector('#sheet-panel .so-song b') || {}).textContent`));
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent === 'Post').click(), 1`);
  await until(`[...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one'))`, 30000, "the post in the feed");
  const p0 = posted.find((x) => x.payload.content);
  console.log("sent to Discord:", JSON.stringify({ content: p0.payload.content, username: p0.payload.username, pings: p0.payload.allowed_mentions, files: p0.files.map(([n, b]) => `${n} ${b.length} bytes ${n.endsWith(".mp4") ? b.subarray(0, 3).toString("latin1").replace(/[^\x20-\x7e]/g, "?") : ""}`) }));
  check(p0.payload.allowed_mentions && p0.payload.allowed_mentions.parse.length === 0, "nobody pinged");
  // (the song goes up scrambled behind "FTS1"; unscrambled it is the MP3)
  const unmix = (b) => { const u = Buffer.from(b); for (let i = 4; i < u.length; i++) u[i] ^= (0x5a + (i - 4) * 13) & 255; return u.subarray(4); };
  check(p0.files.some(([n]) => n === "picture.jpg") && p0.files.some(([n, b]) => n === "song.mp4" && b.subarray(0, 4).toString() === "FTS1" && /^(ID3|\xff)/.test(unmix(b).subarray(0, 3).toString("latin1"))), "picture and MP3 sent (scrambled)");
  check(feedNow()[0].id === p0.id && feedNow()[0].user === "Alice", "the feed list has the new post first");
  check(feedNow()[0].by === meId && !p0.files.some(([n]) => n === "avatar.jpg"), "the post says whose it is (the picture comes from the profile)");
  await until(`document.querySelector('#so-body .so-post .so-av').style.backgroundImage.startsWith('url("data:image/jpeg')`, 8000, "my picture on my post");
  // another phone sees Alice's picture on her post, from her profile
  {
    const other = await browser();
    await other.send("Fetch.enable", { patterns: [{ urlPattern: "https://discord.com/*" }, { urlPattern: "https://cdn.discordapp.com/*" }, { urlPattern: "*social/config.json*" }] });
    other.on(async (m) => {
      if (m.method !== "Fetch.requestPaused") return;
      const { requestId, request } = m.params;
      if (request.method === "OPTIONS") { await other.send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: CORS }, m.sessionId); return; }
      const r = discord(request.method, request.url, request.headers, Buffer.alloc(0));
      await other.send("Fetch.fulfillRequest", { requestId, responseCode: r.status, responseHeaders: [...CORS, { name: "Content-Type", value: r.type }], body: r.body.toString("base64") }, m.sessionId);
    });
    await other.open(`http://127.0.0.1:${port}/#social`, 3500);
    let seenPic = "";
    for (let i = 0; i < 40; i++) { seenPic = await other.ev(`(() => { const p = [...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')); return p ? p.querySelector('.so-av').style.backgroundImage : ''; })()`); if (/avatar\.jpg/.test(seenPic)) break; await sleep(250); }
    console.log("another phone sees Alice's picture:", /avatar\.jpg/.test(seenPic));
    check(/avatar\.jpg/.test(seenPic), "another phone shows the poster's picture");
    other.close();
  }
  check(eveLikes().length === 1, "the earlier like survived the new post");
  await ev(`document.getElementById('view-social').scrollTop = 0, 1`); await sleep(300);
  await shot("d3_posted");

  // deleting it
  await ev(`(() => { window.confirm = () => true; [...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).querySelector('.so-del').click(); return 1; })()`);
  await until(`![...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one'))`, 10000, "the post deleted");
  for (let i = 0; i < 30 && feedNow().some((x) => x.id === p0.id); i++) await sleep(200);
  check(!msgs.has(p0.id) && !feedNow().some((x) => x.id === p0.id), "deleted from Discord and from the feed list");
  check(!(await ev(`!!document.querySelector('#so-body .so-post .so-del')`)), "Delete only on your own posts");

  // a post deleted in Discord by the owner: gone from the feed
  msgs.delete(bob);
  // pulled down from the top: the ring comes, spins, the feed comes back fresh
  await ev(`document.getElementById('view-social').scrollTop = 0, 1`); await sleep(200);
  const T = (type, y) => send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: 195, y }] });
  await T("touchStart", 300);
  for (let y = 300; y <= 560; y += 20) { await T("touchMove", y); await sleep(16); }
  const pulled = await ev(`JSON.stringify({ ring: getComputedStyle(document.getElementById('so-ptr')).opacity, ready: document.getElementById('so-ptr').classList.contains('ready'), list: document.querySelector('#view-social .view-inner').style.transform })`);
  await shot("d4_pulling");
  await ev(`(() => { window.__spun = false; const r = document.getElementById('so-ptr'); new MutationObserver(() => { if (r.classList.contains('spin')) window.__spun = true; }).observe(r, { attributes: true }); return 1; })()`);
  await T("touchEnd");
  await sleep(600);
  const spinning = await ev(`window.__spun`);
  console.log("pulling:", pulled, "| spinning after letting go:", spinning);
  check(JSON.parse(pulled).ready && spinning, "pull to refresh");
  await until(`![...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('My first rebass'))`, 10000, "bob's post to go");
  console.log("after Bob's message was deleted in Discord:", await text("#so-body .so-post .so-name b"));

  // a video: made here (2 s, canvas), posted as it is (it's small), shown in the feed playing without sound
  const vidB64 = await ev(`(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d');
    const st = c.captureStream(30), type = ['video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(st, { mimeType: type }), parts = []; rec.ondataavailable = e => parts.push(e.data);
    const done = new Promise(r => rec.onstop = r); rec.start(200);
    const t0 = performance.now(); await new Promise(res => { const f = () => { const t = (performance.now() - t0) / 1000; g.fillStyle = 'hsl(' + (t * 120) + ',80%,50%)'; g.fillRect(0, 0, 320, 240); g.fillStyle = '#fff'; g.fillRect(40 + t * 100, 100, 40, 40); if (t < 2) requestAnimationFrame(f); else res(); }; f(); });
    rec.stop(); await done;
    const b = new Blob(parts, { type: 'video/webm' }); const u8 = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const x of u8) s += String.fromCharCode(x); return btoa(s); })()`);
  const vidFile = join(mkdtempSync(join(tmpdir(), "ft-vid-")), "clip.webm");
  writeFileSync(vidFile, Buffer.from(vidB64, "base64"));
  console.log("a test video:", Buffer.from(vidB64, "base64").length, "bytes");
  await ev(`document.getElementById('view-social').scrollTop = 0, 1`); await sleep(200);
  await ev(`document.querySelector('#so-body .so-new').click(), 1`); await sleep(400);
  await ev(`(() => { document.querySelector('#sheet-panel textarea').value = 'Video time'; return 1; })()`);
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  const vChooser = new Promise((res) => b.on((m) => { if (m.method === "Page.fileChooserOpened") res(m.params); }));
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent.includes('Video')).click(), 1`);
  const vfc = await vChooser;
  await send("DOM.setFileInputFiles", { backendNodeId: vfc.backendNodeId, files: [vidFile] });
  await send("Page.setInterceptFileChooserDialog", { enabled: false });
  await until(`!!document.querySelector('#sheet-panel video')`, 8000, "the video in the new post");
  const before = posted.length;
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent === 'Post').click(), 1`);
  await until(`[...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Video time'))`, 30000, "the video post");
  const pv = posted.slice(before).find((x) => x.payload.content);
  console.log("video post sent:", pv ? pv.files.map(([n, b2]) => `${n} ${b2.length} bytes`).join(", ") : "nothing", "| on the feed:", JSON.stringify((feedNow()[0] || {}).video));
  check(pv && pv.files.some(([n]) => n === "video.webm") && pv.files.some(([n]) => n === "poster.jpg") && feedNow()[0].video === "webm", "video posted with its still");
  const vcard = `[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Video time'))`;
  await until(`(() => { const v = ${vcard}.querySelector('video'); return v && /cdn\.discordapp\.com/.test(v.src) && !v.paused; })()`, 10000, "the video playing in the feed");
  console.log("in the feed:", await ev(`(() => { const v = ${vcard}.querySelector('video'); return 'playing ' + !v.paused + ', muted ' + v.muted + ', still ' + /poster\.jpg/.test(v.poster); })()`));
  await shot("d6_video");
  await ev(`${vcard}.querySelector('.so-mute').click(), 1`); await sleep(300);
  const unmuted = await ev(`(() => { const v = ${vcard}.querySelector('video'); return !v.muted && ${vcard}.querySelector('.so-mute use').getAttribute('href') === '#i-vol'; })()`);
  await ev(`${vcard}.querySelector('.so-mute').click(), 1`); await sleep(200);
  const muted = await ev(`${vcard}.querySelector('video').muted`);
  console.log("mute button: sound on", unmuted, "| off again", muted);
  check(unmuted && muted, "the mute button");
  // a video too big to post as it is: played through and recorded again smaller
  const small = JSON.parse(await ev(`(async () => {
    const { social } = await import('./js/social.js');
    // a 4 s video at a high bitrate, called a .mov (so it can't go as it is)
    const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d'), img = g.createImageData(640, 480);
    const st = c.captureStream(30), type = ['video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(st, { mimeType: type, videoBitsPerSecond: 4000000 }), parts = []; rec.ondataavailable = e => parts.push(e.data);
    const done = new Promise(r => rec.onstop = r); rec.start(200);
    const t0 = performance.now(); await new Promise(res => { const f = () => { const t = (performance.now() - t0) / 1000; const gr = g.createLinearGradient(0, 0, 640, 480); gr.addColorStop(0, 'hsl(' + (t * 60) + ',80%,50%)'); gr.addColorStop(1, 'hsl(' + (t * 60 + 120) + ',80%,40%)'); g.fillStyle = gr; g.fillRect(0, 0, 640, 480); for (let k = 0; k < 12; k++) { g.fillStyle = 'hsl(' + (k * 30) + ',90%,60%)'; g.beginPath(); g.arc(320 + 220 * Math.sin(t * 1.3 + k), 240 + 160 * Math.cos(t * 0.9 + k * 2), 30, 0, 7); g.fill(); } if (t < 4) requestAnimationFrame(f); else res(); }; f(); });
    rec.stop(); await done;
    const f = new File(parts, 'big.mov', { type: 'video/quicktime' });
    const budget = 220000;
    const out = await social.prepareVideo(f, budget, () => {});
    return JSON.stringify({ was: f.size, budget, now: out.blob.size, ext: out.ext, still: !!out.poster }); })()`));
  console.log("made smaller:", JSON.stringify(small));
  check(small.now <= small.budget && small.now > 1000 && small.still, "a big video made smaller to fit");

  // the knob lock
  await ev(`location.hash = '#player'`); await sleep(500);
  const knob = () => ev(`document.querySelector('#kn-mids .knob').getAttribute('aria-valuenow')`);
  const turn = (k) => ev(`(() => { document.querySelector('#kn-mids .knob').dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true })); return 1; })()`);
  await ev(`document.getElementById('np-knob-lock').click(), 1`);
  const v0 = await knob(); await turn("ArrowUp"); const v1 = await knob();
  await ev(`document.getElementById('np-knob-lock').click(), 1`);
  await turn("ArrowUp"); const v2 = await knob(); await turn("ArrowDown");
  console.log(`knob lock: locked ${v0} -> ${v1} (no change), unlocked -> ${v2}`);
  check(v0 === v1 && v2 !== v1, "the lock holds the knobs");
  console.log(b.errors.length ? "ERRORS:\n" + b.errors.join("\n") : "errors: none");
  check(!b.errors.filter((e) => !/Failed to load resource|play\(\)|NotSupportedError|no supported source/i.test(e)).length, "browser errors");
} finally { b.close(); server.kill(); }
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
