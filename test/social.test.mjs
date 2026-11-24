// node test/social.test.mjs - FifTeam Social in headless Edge against a stand-in for Discord (answered here through the
// DevTools protocol; discord.com never sees these requests): picking a username, the feed, posting a picture and a
// rebass, playing and keeping someone's song, deleting, a post deleted in Discord, markup in a post, no pings. Also the
// knob lock on the Player.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
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
const attach = (id, name, bytes, type) => { const url = `https://cdn.discordapp.com/attachments/1/${id}/${name}?ex=${Math.floor(Date.now() / 1000 + 86400).toString(16)}&is=0&hm=${Math.random().toString(16).slice(2)}`; cdn.set(url.split("?")[0], { bytes, type }); return { id: String(Math.random()).slice(2), filename: name, url }; };
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
const DM = "900000000000000002";
const META = "900000000000000003", PRES = "900000000000000004", MOD = "900000000000000005";
for (const [id, file, d] of [[META, "meta.json", { v: 1, votes: {}, follows: {}, about: {} }], [PRES, "presence.json", { v: 1, on: {} }], [MOD, "mod.json", { v: 1, bans: {} }]])
  msgs.set(id, { id, content: file, attachments: [attach(id, file, Buffer.from(JSON.stringify(d)), "application/json")] });
// the file links the FifTeam bot keeps (every post's, in one store): seeded with the two posts that have files
const LINKS = "900000000000000006";
msgs.set(LINKS, { id: LINKS, content: "links", attachments: [attach(LINKS, "links.json", Buffer.from(JSON.stringify({ v: 1, at: Date.now(), links: Object.fromEntries([bob, eve].filter((id) => msgs.has(id)).map((id) => [id, msgs.get(id).attachments.map(({ filename, url }) => ({ filename, url }))])) })), "application/json")] });
const storeNow = (id) => JSON.parse(cdn.get(msgs.get(id).attachments[0].url.split("?")[0]).bytes.toString());
const setStore = (id, d) => msgs.set(id, { id, content: "x", attachments: [attach(id, msgs.get(id).attachments[0].filename, Buffer.from(JSON.stringify(d)), "application/json")] });
msgs.set(DM, { id: DM, content: "FifTeam messages", attachments: [attach(DM, "dm.json", Buffer.from(JSON.stringify({ v: 1, msgs: [] })), "application/json")] });
const dmNow = () => JSON.parse(cdn.get(msgs.get(DM).attachments[0].url.split("?")[0]).bytes.toString()).msgs;
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
// another phone's write landing just after this phone checked its own: armed, the next feed write is undone right after it's read back
let clobber = null;
const gets = new Map();
function discord(method, url, headers, body) {
  const u = new URL(url);
  if (u.host === "cdn.discordapp.com") { const f = cdn.get(url.split("?")[0]); return f ? { status: 200, type: f.type, body: f.bytes } : { status: 404, type: "text/plain", body: Buffer.from("no") }; }
  if (u.pathname.endsWith("/social/config.json")) return json({ hook: HOOK, key: Buffer.from(TOKEN.split("").reverse().join("")).toString("base64"), index: INDEX, dm: DM, meta: META, presence: PRES, mod: MOD, links: LINKS });
  const base = `/api/v10/webhooks/${HOOK}/${TOKEN}`;
  if (!u.pathname.startsWith(base)) return json({ message: "Unknown Webhook", code: 10015 }, 404);
  const rest = u.pathname.slice(base.length), m = /^\/messages\/(\d+)$/.exec(rest);
  if (method === "GET" && m) {
    gets.set(m[1], (gets.get(m[1]) || 0) + 1);
    const r = msgs.has(m[1]) ? json(msgs.get(m[1])) : json({ message: "Unknown Message" }, 404);
    if (clobber && clobber.state === "written" && m[1] === INDEX) { msgs.set(INDEX, clobber.before); cdn.set(...clobber.bytes); clobber.state = "done"; }
    return r;
  }
  if (method === "DELETE" && m) { if (!msgs.has(m[1])) return json({ message: "Unknown Message" }, 404); msgs.delete(m[1]); return { status: 204, type: "text/plain", body: Buffer.alloc(0) }; }
  if ((method === "POST" && rest === "") || (method === "PATCH" && m)) {
    const parts = multipart(body, headers["Content-Type"] || headers["content-type"]);
    const payload = JSON.parse(parts.payload_json.data.toString());
    const id = m ? m[1] : String(nextId++);
    if (clobber && clobber.state === "armed" && id === INDEX) { const k = msgs.get(INDEX).attachments[0].url.split("?")[0]; clobber.before = msgs.get(INDEX); clobber.bytes = [k, cdn.get(k)]; clobber.state = "written"; }
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
// (the app's service worker fetches pictures itself: its requests go to the stand-in too)
b.on((m) => { if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "service_worker") send("Fetch.enable", { patterns: [{ urlPattern: "https://cdn.discordapp.com/*" }, { urlPattern: "https://discord.com/*" }] }, m.params.sessionId); });
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
  await until(`document.querySelector('#so-body img.so-img').classList.contains('in')`, 4000, "the picture faded in");
  await shot("d1_feed");
  console.log("first look, reads of the posts themselves:", [bob, eve].map((id) => gets.get(id) || 0).join(","), "| the links store read:", gets.get(LINKS) || 0);
  check(!gets.get(bob) && !gets.get(eve) && gets.get(LINKS) === 1, "a phone's first look: every post's files from the one links store");
  await until(`/cdn\.discordapp\.com.*avatar\.jpg/.test(document.querySelector('#so-body .so-post .so-av').style.backgroundImage)`, 8000, "Bob's picture on his post (from his profile)");
  console.log("Bob's picture on his older post:", await ev(`/avatar\.jpg/.test(document.querySelector('#so-body .so-post .so-av').style.backgroundImage)`));

  // the username
  const setName = (v) => ev(`(() => { const f = document.querySelector('#so-body .so-nameform'); f.querySelector('input').value = ${JSON.stringify(v)}; f.requestSubmit(); return 1; })()`);
  await setName("a"); await sleep(200);
  console.log("too short a name:", await text("#so-body .so-you .set-err"));
  await setName("Alice"); await sleep(300);
  console.log("name set:", await text("#so-body .so-you"), "| kept:", await ev(`localStorage.getItem('fifteam-social-name')`));
  check((await text("#so-body .so-pill")) === "What's on your mind, Alice?", "username set (it greets you on the post box)");

  // a profile picture (goes with each post)
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  const avChooser = new Promise((res) => b.on((m) => { if (m.method === "Page.fileChooserOpened") res(m.params); }));
  await ev(`document.querySelector('#so-body .so-avbtn').click(), 1`); await sleep(400);
  console.log("my page:", await ev(`document.querySelector('#sheet-panel .pf-head').textContent`));
  await ev(`[...document.querySelectorAll('#sheet-panel .pf-btns .btn')].find(b => b.textContent === 'Change picture').click(), 1`);
  const avFc = await avChooser;
  const avPng = join(mkdtempSync(join(tmpdir(), "ft-av-")), "me.png");
  writeFileSync(avPng, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==", "base64"));
  await send("DOM.setFileInputFiles", { backendNodeId: avFc.backendNodeId, files: [avPng] });
  await send("Page.setInterceptFileChooserDialog", { enabled: false });
  await until(`(localStorage.getItem('fifteam-social-avatar') || '').startsWith('data:image/jpeg')`, 8000, "the profile picture");
  await ev(`[...document.querySelectorAll('#sheet-panel .pf-btns .btn')].find(b => b.textContent === 'Add about me').click(), 1`); await sleep(200);
  await ev(`(() => { const f = document.querySelector('#sheet-panel .pf-aboutform'); f.querySelector('textarea').value = 'Bass head from Ohio'; f.requestSubmit(); return 1; })()`);
  const meNow = await ev(`localStorage.getItem('fifteam-social-me')`);
  for (let i = 0; i < 40 && !storeNow(META).about[meNow]; i++) await sleep(200);
  console.log("about me saved:", JSON.stringify(storeNow(META).about), "| my page:", await ev(`document.querySelector('#sheet-panel .pf-about').textContent`));
  check(storeNow(META).about[meNow] === "Bass head from Ohio", "about me saved");
  await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
  for (let i = 0; i < 40 && !storeNow(PRES).on[meNow]; i++) await sleep(250);
  console.log("who's online:", JSON.stringify(storeNow(PRES).on[meNow]));
  check(!!storeNow(PRES).on[meNow] && /^2\.\d/.test(storeNow(PRES).on[meNow].v) && storeNow(PRES).on[meNow].d.length > 3, "this phone shows as online, with its device");
  check(storeNow(PRES).on[meNow].t === 1, "a test browser marks itself (so the owner's /online and /devices leave it out)");
  console.log("profile picture kept on the phone:", await ev(`localStorage.getItem('fifteam-social-avatar').length + ' characters'`));
  const meId = await ev(`localStorage.getItem('fifteam-social-me')`);
  for (let i = 0; i < 40 && !(profilesNow()[meId] && profilesNow()[meId].av); i++) await sleep(200);
  const myPr = profilesNow()[meId] || {};
  console.log("profile on the feed:", JSON.stringify(myPr), "| its picture:", myPr.av && msgs.has(myPr.av) ? msgs.get(myPr.av).attachments.map((a) => a.filename).join(",") : "missing");
  check(myPr.name === "Alice" && myPr.av && msgs.get(myPr.av).attachments.some((a) => a.filename === "avatar.jpg"), "the picture is on the feed's profiles at once");

  // a like on Eve's post: shown at once, saved to the feed list under this phone; again: gone
  const eveLikes = () => (feedNow().find((x) => x.id === eve) || {}).likes || [];
  await ev(`document.querySelector('#so-body .so-like[data-id="${eve}"]').click(), 1`);
  console.log("like shown at once:", await ev(`document.querySelector('#so-body .so-like[data-id="${eve}"]').textContent + ' / ' + document.querySelector('#so-body .so-post[data-id="${eve}"] .so-slikes').textContent`));
  check((await ev(`document.querySelector('#so-body .so-post[data-id="${eve}"] .so-slikes').textContent`)) === "♥ 1" && (await ev(`document.querySelector('#so-body .so-like[data-id="${eve}"]').classList.contains('on')`)), "like shown at once");
  for (let i = 0; i < 40 && !eveLikes().length; i++) await sleep(200);
  const me = await ev(`localStorage.getItem('fifteam-social-me')`);
  console.log("like saved:", JSON.stringify(eveLikes()), "| this phone:", me);
  check(eveLikes().length === 1 && eveLikes()[0] === me, "the like is in the feed list");
  await ev(`document.querySelector('#so-body .so-like[data-id="${eve}"]').click(), 1`);
  for (let i = 0; i < 40 && eveLikes().length; i++) await sleep(200);
  check(eveLikes().length === 0 && (await ev(`document.querySelector('#so-body .so-post[data-id="${eve}"] .so-slikes').textContent`)) === "", "unliked");
  await ev(`document.querySelector('#so-body .so-like[data-id="${eve}"]').click(), 1`);
  for (let i = 0; i < 40 && !eveLikes().length; i++) await sleep(200);

  // votes: Alice votes for Bob's rebassed song, which makes it the rebass of the week, on top
  const bobCard = `document.querySelector('#so-body .so-post[data-id="${bob}"]')`;
  check(!(await ev(`!!document.querySelector('#so-body .so-week')`)), "no rebass of the week before any votes");
  await ev(`${bobCard}.querySelector('.so-vote').click(), 1`);
  for (let i = 0; i < 40 && !(storeNow(META).votes[bob] || []).length; i++) await sleep(200);
  await sleep(300);
  console.log("votes saved:", JSON.stringify(storeNow(META).votes), "| button:", await ev(`${bobCard}.querySelector('.so-vote').textContent`), "| counts:", await ev(`${bobCard}.querySelector('.so-stats').textContent`));
  check((storeNow(META).votes[bob] || [])[0] === me, "the vote is saved");
  const week = await ev(`(() => { const w = document.querySelector('#so-body .so-week'); return w ? w.querySelector('.so-week-h').textContent + ' | ' + w.querySelector('.so-post').dataset.id + ' | on top: ' + (document.getElementById('so-body').children[1] === w) : 'none'; })()`);
  console.log("rebass of the week:", week);
  check(week.includes(bob) && week.endsWith("on top: true"), "the voted song is the rebass of the week, on top");
  check((await ev(`document.querySelectorAll('#so-body .so-post[data-id="${bob}"]').length`)) === 1, "shown once (not again further down)");
  await shot("d10_week");
  // taken back: no rebass of the week; voted again
  await ev(`${bobCard}.querySelector('.so-vote').click(), 1`);
  for (let i = 0; i < 40 && (storeNow(META).votes[bob] || []).length; i++) await sleep(200);
  await sleep(300);
  await until(`!document.querySelector('#so-body .so-week')`, 4000, "the rebass of the week gone");
  check(!(storeNow(META).votes[bob] || []).length && !(await ev(`!!document.querySelector('#so-body .so-week')`)), "vote taken back: no rebass of the week");
  await ev(`${bobCard}.querySelector('.so-vote').click(), 1`);
  for (let i = 0; i < 40 && !(storeNow(META).votes[bob] || []).length; i++) await sleep(200);

  // comments: only in their panel (the comments button); a comment, a reply to it, a like on it, then deleted
  const eveComments = () => (feedNow().find((x) => x.id === eve) || {}).comments || [];
  const eveCard = `document.querySelector('#so-body .so-post[data-id="${eve}"]')`;
  check(!(await ev(`!!${eveCard}.querySelector('.so-comments, .cs-c')`)), "no comments on the post itself");
  await ev(`${eveCard}.querySelector('.so-cbtn').click(), 1`); await sleep(300);
  const say = (t) => ev(`(() => { const f = document.querySelector('#sheet-panel .cs-form'); f.querySelector('input').value = ${JSON.stringify(t)}; f.requestSubmit(); return 1; })()`);
  await say("Hard!");
  for (let i = 0; i < 40 && !eveComments().length; i++) await sleep(200);
  const firstId = (eveComments()[0] || {}).id;
  await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .cs-c')].find(c => c.textContent.includes('Hard!')).querySelector('.cs-act').click(), 1`);   // Reply
  console.log("replying:", await ev(`document.querySelector('#sheet-panel .cs-to').textContent`));
  await say("Agreed");
  for (let i = 0; i < 40 && eveComments().length < 2; i++) await sleep(200);
  await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .cs-c')].find(c => c.textContent.includes('Hard!')).querySelector('.cs-like').click(), 1`);
  for (let i = 0; i < 40 && !(eveComments().find((c) => c.id === firstId) || {}).likes?.length; i++) await sleep(200);
  await sleep(400);
  console.log("comments:", JSON.stringify(eveComments().map((c) => ({ text: c.text, reply: !!c.re, likes: (c.likes || []).length }))), "| panel:", await ev(`[...document.querySelectorAll('#sheet-panel .cs-c')].map(c => (c.classList.contains('reply') ? '  ↳ ' : '') + c.querySelector('p').textContent + ' ' + c.querySelector('.cs-like').textContent.trim()).join(' | ')`));
  const cs = eveComments();
  check(cs.length === 2 && cs[1].re === firstId && cs[0].likes.length === 1 && cs[0].likes[0] === me, "a comment, a reply to it, and a like on it");
  check((await ev(`document.querySelectorAll('#sheet-panel .cs-c.reply').length`)) === 1, "the reply shown under it");
  await shot("d5_comments");
  await ev(`[...document.querySelectorAll('#sheet-panel .cs-c')].find(c => c.textContent.includes('Hard!')).querySelectorAll('.cs-act')[2].click(), 1`);   // Delete (and its reply)
  for (let i = 0; i < 40 && eveComments().length; i++) await sleep(200);
  check(eveComments().length === 0, "own comment deleted (its reply with it)");
  await say("Nice one");
  for (let i = 0; i < 40 && !eveComments().length; i++) await sleep(200);
  // another phone's older copy of the feed lands right after this one was saved: the comment is put back by itself
  clobber = { state: "armed" };
  await say("Second thought");
  for (let i = 0; i < 40 && clobber.state !== "done"; i++) await sleep(100);
  const lost = !eveComments().some((c) => c.text === "Second thought");
  for (let i = 0; i < 60 && !eveComments().some((c) => c.text === "Second thought"); i++) await sleep(200);
  console.log("overwritten by another phone:", lost, "| put back:", eveComments().some((c) => c.text === "Second thought"));
  check(lost && eveComments().some((c) => c.text === "Second thought") && eveComments().some((c) => c.text === "Nice one"), "a comment written over by another phone comes back");
  clobber = null;
  await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
  console.log("count on the post:", await ev(`${eveCard}.querySelector('.so-scom').textContent`));

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
  await until(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).querySelector('.so-av').style.backgroundImage.startsWith('url("data:image/jpeg')`, 8000, "my picture on my post");
  // another phone sees Alice's picture on her post, from her profile
  {
    const other = await browser();
    await other.send("Fetch.enable", { patterns: [{ urlPattern: "https://discord.com/*" }, { urlPattern: "https://cdn.discordapp.com/*" }, { urlPattern: "*social/config.json*" }] });
    other.on(async (m) => {
      if (m.method !== "Fetch.requestPaused") return;
      const { requestId, request } = m.params;
      if (request.method === "OPTIONS") { await other.send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: CORS }, m.sessionId); return; }
      let body = Buffer.alloc(0);
      if (request.postDataEntries) body = Buffer.concat(request.postDataEntries.map((e) => Buffer.from(e.bytes || "", "base64")));
      else if (request.postData) body = Buffer.from(request.postData);
      const r = discord(request.method, request.url, request.headers, body);
      await other.send("Fetch.fulfillRequest", { requestId, responseCode: r.status, responseHeaders: [...CORS, { name: "Content-Type", value: r.type }], body: r.body.toString("base64") }, m.sessionId);
    });
    await other.open(`http://127.0.0.1:${port}/#social`, 3500);
    let seenPic = "";
    for (let i = 0; i < 40; i++) { seenPic = await other.ev(`(() => { const p = [...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')); return p ? p.querySelector('.so-av').style.backgroundImage : ''; })()`); if (/avatar\.jpg/.test(seenPic)) break; await sleep(250); }
    console.log("another phone sees Alice's picture:", /avatar\.jpg/.test(seenPic));
    check(/avatar\.jpg/.test(seenPic), "another phone shows the poster's picture");
    // Alice switches message notifications on, in Settings
    await send("Browser.grantPermissions", { permissions: ["notifications"], origin: `http://127.0.0.1:${port}` });
    await ev(`document.getElementById('btn-settings').click(), 1`); await sleep(400);
    await sleep(300);   // (on by default: nothing to switch, the phone said yes)
    console.log("notifications setting:", await ev(`document.getElementById('set-nt-pill').textContent + ' | ' + document.getElementById('set-nt-why').textContent`));
    check((await ev(`document.getElementById('set-nt').checked && localStorage.getItem('fifteam-dm-notify') === null`)), "message notifications on by default");
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    // a private message: from the other phone to Alice, by tapping her picture
    await other.ev(`localStorage.setItem('fifteam-social-name', 'Ben'), 1`); await other.open(`http://127.0.0.1:${port}/?again#social`, 3500);
    await other.ev(`new Promise(r => { const t = Date.now(); (function w() { [...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one')) || Date.now() - t > 15000 ? r(1) : setTimeout(w, 200); })(); })`);
    await other.ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).querySelector('.so-av').click(), 1`); await sleep(400);
    console.log("tapping Alice's picture:", await other.ev(`document.querySelector('#sheet-panel').textContent.replace(/\\s+/g, ' ').trim()`));
    const benPhone = await other.ev(`localStorage.getItem('fifteam-social-me')`);
    const page = JSON.parse(await other.ev(`JSON.stringify({ about: (document.querySelector('#sheet-panel .pf-about') || {}).textContent, tiles: document.querySelectorAll('#sheet-panel .pf-tile').length, tabs: [...document.querySelectorAll('#sheet-panel .pf-seg button')].map(b => b.textContent) })`));
    console.log("Alice's page, seen by Ben:", JSON.stringify(page));
    check(page.about === "Bass head from Ohio" && page.tiles === 1 && page.tabs.join() === "Pics & videos · 1,Rebassed songs · 1", "her page: about me, her picture post, her song post");
    await other.ev(`document.querySelectorAll('#sheet-panel .pf-seg button')[1].click(), 1`); await sleep(200);
    check((await other.ev(`document.querySelectorAll('#sheet-panel .pf-song .so-song').length`)) === 1, "her rebassed songs tab");
    await other.ev(`document.querySelector('#sheet-panel .pf-follow').click(), 1`);
    for (let i = 0; i < 40 && !(storeNow(META).follows[benPhone] || []).length; i++) await sleep(200);
    await sleep(300);
    const after = await other.ev(`document.querySelector('#sheet-panel .pf-counts').textContent + ' | ' + document.querySelector('#sheet-panel .pf-follow').textContent`);
    console.log("Ben follows Alice:", JSON.stringify(storeNow(META).follows), "|", after);
    check((storeNow(META).follows[benPhone] || []).includes(meNow) && after.startsWith("1 follower") && after.endsWith("Following"), "following, and her follower count");
    await other.ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent.includes('Message')).click(), 1`); await sleep(1500);
    console.log("after Message:", await other.ev(`JSON.stringify({ name: localStorage.getItem('fifteam-social-name'), toast: (document.querySelector('.toast, #toast') || {}).textContent, sheet: document.querySelector('#sheet-panel').className, text: document.querySelector('#sheet-panel').textContent.slice(0, 200) })`));
    await other.ev(`(() => { const f = document.querySelector('#sheet-panel .dm-form'); f.querySelector('input').value = 'hey Alice, sick rebass'; f.requestSubmit(); return 1; })()`);
    for (let i = 0; i < 40 && !dmNow().length; i++) await sleep(250);
    const stored = JSON.stringify(dmNow());
    console.log("in the messages' store:", dmNow().length, "message(s), readable there:", /sick rebass/.test(stored), "| sealed:", dmNow()[0] && dmNow()[0].c.length, "characters");
    check(dmNow().length === 1 && !/sick rebass|Alice/.test(stored), "the message is stored sealed");
    other._sheet = true;
    // Alice: the badge, the inbox, the conversation, an answer
    await ev(`(async () => { const { api } = await import('./js/social.js'); await api.ensureProfiles(); return 1; })()`);
    for (let i = 0; i < 60; i++) { const n = await ev(`document.getElementById('dm-badge').hidden ? 0 : +document.getElementById('dm-badge').textContent`); if (n) break; await ev(`document.dispatchEvent(new Event('visibilitychange')), 1`); await sleep(500); }
    const banner = await ev(`document.getElementById('toast').textContent`);
    console.log("Alice's banner:", banner);
    check(banner.includes("Ben: hey Alice, sick rebass"), "a banner for the new message (notifications on, app open)");
    console.log("Alice's messages badge:", await ev(`document.getElementById('dm-badge').hidden ? 'none' : document.getElementById('dm-badge').textContent`));
    await ev(`document.getElementById('btn-dms').click(), 1`);
    await until(`!!document.querySelector('#sheet-panel .dm-row')`, 10000, "Alice's inbox");
    console.log("Alice's inbox:", await ev(`[...document.querySelectorAll('#sheet-panel .dm-row')].map(r => r.textContent).join(' | ')`));
    await sleep(600); await shot("d7_inbox");
    await ev(`document.querySelector('#sheet-panel .dm-row').click(), 1`);
    await until(`[...document.querySelectorAll('#sheet-panel .dm-bubble')].some(b => b.textContent.includes('sick rebass'))`, 10000, "the message opened on Alice's phone");
    await ev(`(() => { const f = document.querySelector('#sheet-panel .dm-form'); f.querySelector('input').value = 'thanks Ben!'; f.requestSubmit(); return 1; })()`);
    for (let i = 0; i < 40 && dmNow().length < 2; i++) await sleep(250);
    await shot("d8_chat");
    console.log("Alice's conversation:", await ev(`[...document.querySelectorAll('#sheet-panel .dm-bubble')].map(b => (b.classList.contains('me') ? 'me: ' : 'Ben: ') + b.querySelector('span').textContent).join(' | ')`), "| badge now:", await ev(`document.getElementById('dm-badge').hidden ? 'none' : document.getElementById('dm-badge').textContent`));
    // Ben sees the answer (the open conversation checks every few seconds)
    let benSees = false;
    for (let i = 0; i < 40 && !benSees; i++) { benSees = await other.ev(`[...document.querySelectorAll('#sheet-panel .dm-bubble')].some(b => b.textContent.includes('thanks Ben'))`); await sleep(500); }
    console.log("Ben sees the answer:", benSees);
    check(benSees && dmNow().length === 2 && !/thanks Ben/.test(JSON.stringify(dmNow())), "messages both ways, sealed");
    await other.send("Browser.grantPermissions", { permissions: ["notifications"], origin: `http://127.0.0.1:${port}` });
    await other.ev(`(() => { localStorage.setItem('fifteam-dm-notify', '1'); document.getElementById('sheet').classList.remove('open');
      window.__notes = []; ServiceWorkerRegistration.prototype.showNotification = function (t, o) { window.__notes.push({ t, body: o.body, tag: o.tag, dm: o.data && o.data.dm }); return Promise.resolve(); };
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); return 1; })()`);
    await ev(`(() => { const f = document.querySelector('#sheet-panel .dm-form'); f.querySelector('input').value = 'you there?'; f.requestSubmit(); return 1; })()`);
    for (let i = 0; i < 40 && dmNow().length < 3; i++) await sleep(250);
    await sleep(500);
    await other.ev(`import('./js/dms.js').then((m) => m.dms.state.check()).then(() => 1)`);
    const notes = await other.ev(`JSON.stringify(window.__notes)`);
    console.log("Ben's notification (app in the background):", notes);
    const alice = Object.entries(profilesNow()).find(([, v]) => v.name === "Alice")[0];
    const n0 = JSON.parse(notes);
    check(n0.length === 1 && n0[0].t === "Alice" && n0[0].body === "you there?" && n0[0].dm === alice, "a notification for a message while the app is in the background");
    // switched off: nothing
    await other.ev(`(localStorage.setItem('fifteam-dm-notify', '0'), window.__notes = [], 1)`);
    await ev(`(() => { const f = document.querySelector('#sheet-panel .dm-form'); f.querySelector('input').value = 'hello?'; f.requestSubmit(); return 1; })()`);
    for (let i = 0; i < 40 && dmNow().length < 4; i++) await sleep(250);
    await sleep(500);
    await other.ev(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); return 1; })()`);
    await other.ev(`import('./js/dms.js').then((m) => m.dms.state.check()).then(() => 1)`);
    check((await other.ev(`window.__notes.length`)) === 0 && !(await other.ev(`document.getElementById('toast').textContent.includes('hello?')`)), "notifications off: none");
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    // activity: Ben likes Alice's post and comments on it, replies to her comment on Eve's post and likes that comment
    const ben = Object.entries(profilesNow()).find(([, v]) => v.name === "Ben")[0];
    const editFeed = (fn) => { const k = msgs.get(INDEX).attachments[0].url.split("?")[0]; const d = JSON.parse(cdn.get(k).bytes.toString()); fn(d); msgs.set(INDEX, { id: INDEX, content: "FifTeam Social feed", attachments: [attach(INDEX, "feed.json", Buffer.from(JSON.stringify(d)), "application/json")] }); };
    editFeed((d) => {
      const mine = d.posts.find((x) => x.text && x.text.startsWith("Fresh one")), ev2 = d.posts.find((x) => x.id === eve), nice = ev2.comments.find((c) => c.text === "Nice one");
      mine.likes = [...(mine.likes || []), ben];
      mine.comments = [...(mine.comments || []), { id: "bencomment01", by: ben, user: "Ben", text: "Love this", at: Date.now(), likes: [] }];
      ev2.comments.push({ id: "benreply0001", by: ben, user: "Ben", text: "agreed!", at: Date.now() + 1, re: nice.id, likes: [] });
      nice.likes = [...(nice.likes || []), ben];
    });
    await sleep(5200);
    await ev(`import('./js/social.js').then((m) => m.api.ensureProfiles(true)).then(() => 1)`);
    await sleep(300);
    console.log("Alice's bell:", await ev(`document.getElementById('act-badge').hidden ? 'none' : document.getElementById('act-badge').textContent`));
    check((await ev(`document.getElementById('act-badge').textContent`)) === "5" && !(await ev(`document.getElementById('act-badge').hidden`)), "the bell counts 5 new");
    await ev(`document.getElementById('btn-activity').click(), 1`); await sleep(500);
    const acts = await ev(`[...document.querySelectorAll('#sheet-panel .act-row')].map(r => (r.classList.contains('unread') ? '* ' : '') + r.querySelector('.act-what').textContent + ' / ' + r.querySelector('small').textContent).join(' | ')`);
    console.log("Alice's activity:", acts);
    const want = ["Ben started following you", "Ben liked your post", "Ben commented: \u201cLove this\u201d", "Ben replied to your comment: \u201cagreed!\u201d", "Ben liked your comment \u201cNice one\u201d"];
    check(want.every((t) => acts.includes(t)) && acts.split("* ").length - 1 === 5, "activity lists the follow, the likes, the comment and the reply, all new");
    check((await ev(`document.getElementById('act-badge').hidden`)), "the bell's count cleared once looked at");
    await shot("d9_activity");
    await ev(`[...document.querySelectorAll('#sheet-panel .act-row')].find(r => r.textContent.includes('replied')).click(), 1`); await sleep(500);
    console.log("tapping the reply:", await ev(`document.querySelector('#sheet-panel').className + ' | ' + [...document.querySelectorAll('#sheet-panel .cs-c p')].map(p => p.textContent).join(', ')`));
    check((await ev(`document.querySelector('#sheet-panel').classList.contains('cs-panel') && [...document.querySelectorAll('#sheet-panel .cs-c p')].some(p => p.textContent === 'agreed!')`)), "tapping it opens that post's comments");
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    // privacy, set in Alice's Settings: who can message her, and a private account
    const benOpensAlice = async () => { await other.ev(`import('./js/meta.js').then((m) => m.loadMeta(0)).then(() => import('./js/profile.js')).then((m) => { m.openProfile({ by: '${meNow}', user: 'Alice' }); return 1; })`); await sleep(700); };
    const benView = () => other.ev(`JSON.stringify({ msg: (document.querySelector('#sheet-panel .pf-msg') || {}).textContent, off: !!(document.querySelector('#sheet-panel .pf-msg') || {}).disabled, follow: (document.querySelector('#sheet-panel .pf-follow') || {}).textContent, locked: !!document.querySelector('#sheet-panel .pf-locked'), tabs: document.querySelectorAll('#sheet-panel .pf-seg button').length })`).then(JSON.parse);
    const aliceSettings = async (fn) => { await ev(`document.getElementById('btn-settings').click(), 1`); await sleep(500); await ev(fn); await sleep(300); };
    const prefsNow = () => (storeNow(META).prefs || {})[meNow] || { dm: "all", priv: 0 };
    // "Nobody": Ben can't message her
    await aliceSettings(`document.querySelector('#set-dm button[data-v="off"]').click(), 1`);
    for (let i = 0; i < 40 && prefsNow().dm !== "off"; i++) await sleep(200);
    console.log("Alice's privacy:", JSON.stringify(prefsNow()), "|", await ev(`document.getElementById('set-dm-why').textContent`));
    await shot("d13_privacy");
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    await benOpensAlice();
    let seen = await benView();
    console.log("messages off, Ben sees:", JSON.stringify(seen));
    check(prefsNow().dm === "off" && seen.msg === "Not taking messages" && seen.off, "messages off: no Message button for others");
    // "Requests": with no conversation between them yet, Ben asks; Alice says yes in her inbox
    setStore(DM, { v: 1, msgs: [] });
    await other.ev(`import('./js/dms.js').then((m) => m.dms.state.check()).then(() => 1)`);
    await ev(`import('./js/dms.js').then((m) => m.dms.state.check()).then(() => 1)`);
    await aliceSettings(`document.querySelector('#set-dm button[data-v="req"]').click(), 1`);
    for (let i = 0; i < 40 && prefsNow().dm !== "req"; i++) await sleep(200);
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    await benOpensAlice();
    seen = await benView();
    console.log("by request, Ben sees:", JSON.stringify(seen));
    check(seen.msg === "Ask to message" && !seen.off, "by request: Ask to message");
    await other.ev(`document.querySelector('#sheet-panel .pf-msg').click(), 1`);
    for (let i = 0; i < 40 && !((storeNow(META).dmreq || {})[meNow] || []).includes(benPhone); i++) await sleep(200);
    await sleep(300);
    await benOpensAlice();
    seen = await benView();
    check(((storeNow(META).dmreq || {})[meNow] || []).includes(benPhone) && seen.msg === "Asked to message" && seen.off, "asked: shown as asked");
    await ev(`import('./js/meta.js').then((m) => m.loadMeta(0)).then(() => 1)`);
    await ev(`document.getElementById('btn-dms').click(), 1`); await sleep(1200);
    console.log("Alice's inbox:", await ev(`document.querySelector('#sheet-panel .dm-list').textContent`), "| badge:", await ev(`document.getElementById('dm-badge').textContent`));
    await shot("d14_dm_request");
    await ev(`document.querySelector('#sheet-panel .dm-req .btn.primary').click(), 1`);
    for (let i = 0; i < 40 && !((storeNow(META).dmok || {})[meNow] || []).includes(benPhone); i++) await sleep(200);
    await sleep(300);
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    await benOpensAlice();
    seen = await benView();
    console.log("accepted, Ben sees:", JSON.stringify(seen));
    check(((storeNow(META).dmok || {})[meNow] || []).includes(benPhone) && seen.msg === "Message", "accepted: Ben can message her");
    // a private account: Ben (already following) is kept; a new follower has to ask
    await aliceSettings(`document.getElementById('set-priv').click(), 1`);
    for (let i = 0; i < 40 && !prefsNow().priv; i++) await sleep(200);
    await sleep(300);
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    check(((storeNow(META).fok || {})[meNow] || []).includes(benPhone), "going private keeps the followers she had");
    await benOpensAlice();
    seen = await benView();
    check(!seen.locked && seen.tabs === 2 && seen.follow === "Following", "an existing follower still sees her posts");
    // Ben as a new follower: unfollowed and not let in (as if he'd never followed)
    { const d = storeNow(META); d.follows[benPhone] = []; d.fok[meNow] = []; setStore(META, d); }
    await benOpensAlice();
    seen = await benView();
    const benFeed = await other.ev(`import('./js/social.js').then((m) => { m.api.render(); return [...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one')); })`);
    console.log("private, Ben (not let in) sees:", JSON.stringify(seen), "| her post in his feed:", benFeed);
    check(seen.locked && seen.tabs === 0 && seen.follow === "Follow" && !benFeed, "private: her page locked and her posts out of his feed");
    await shot("d15_private");
    await other.ev(`document.querySelector('#sheet-panel .pf-follow').click(), 1`);
    for (let i = 0; i < 40 && !((storeNow(META).freq || {})[meNow] || []).includes(benPhone); i++) await sleep(200);
    await sleep(300);
    await benOpensAlice();
    seen = await benView();
    check(seen.follow === "Requested" && seen.locked, "a follow request, waiting");
    await ev(`import('./js/meta.js').then((m) => m.loadMeta(0)).then(() => import('./js/activity.js')).then((m) => { m.activityChanged(); return 1; })`);
    await ev(`document.getElementById('btn-activity').click(), 1`); await sleep(500);
    console.log("Alice's bell:", await ev(`[...document.querySelectorAll('#sheet-panel .act-req')].map(r => r.textContent).join(' | ')`));
    await ev(`document.querySelector('#sheet-panel .act-req .btn.primary').click(), 1`);
    for (let i = 0; i < 40 && !((storeNow(META).fok || {})[meNow] || []).includes(benPhone); i++) await sleep(200);
    await sleep(300);
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    await benOpensAlice();
    seen = await benView();
    const benFeed2 = await other.ev(`import('./js/social.js').then((m) => { m.api.render(); return [...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one')); })`);
    console.log("accepted, Ben sees:", JSON.stringify(seen), "| her post in his feed:", benFeed2);
    check(!seen.locked && seen.follow === "Following" && benFeed2, "let in: her page and posts open to him");
    // back to public, messages from everyone
    await aliceSettings(`(document.getElementById('set-priv').click(), document.querySelector('#set-dm button[data-v="all"]').click(), 1)`);
    for (let i = 0; i < 40 && (prefsNow().priv || prefsNow().dm !== "all"); i++) await sleep(250);
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    await other.ev(`document.getElementById('sheet').classList.remove('open'), 1`);
    check(!prefsNow().priv && prefsNow().dm === "all", "back to public");

    // the picture in the top bar: your own page, from any tab
    await ev(`location.hash = '#library', 1`); await sleep(300);
    await ev(`document.getElementById('btn-me').click(), 1`); await sleep(500);
    const mine = await ev(`document.querySelector('#sheet-panel .pf-name').textContent + ' | ' + document.querySelector('#sheet-panel .pf-likes').textContent`);
    console.log("top-bar profile button (from the Library):", mine);
    // her likes: on her posts and her comments, counted from the feed list
    const likesShould = feedNow().reduce((n, x) => n + ((x.by === meNow ? (x.likes || []).length : 0) + (x.comments || []).filter((c) => c.by === meNow).reduce((m, c) => m + (c.likes || []).length, 0)), 0);
    check(mine.startsWith("Alice") && mine.endsWith(`${likesShould} like${likesShould === 1 ? "" : "s"}`), `her own page, with her ${likesShould} likes`);
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await ev(`location.hash = '#social', 1`); await sleep(400);

    // tags from the bot (/tag-founder, /tag-member): next to her name, on her posts and her page
    { const d = storeNow(MOD); d.badges = { [meNow]: ["member", "founder"] }; setStore(MOD, d); }
    await ev(`import('./js/ban.js').then((m) => m.checkBans()).then(() => 1)`); await sleep(400);
    const tags = await ev(`[...[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).querySelectorAll('.so-name .tag')].map(t => t.textContent).join(', ')`);
    console.log("tags on her post:", tags);
    check(tags === "FifTeam Founder, FifTeam Member", "the tags next to her name (founder first)");
    await ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).scrollIntoView({ block: 'start' }), 1`); await sleep(400);
    await shot("d16_tags");
    await ev(`document.getElementById('view-social').scrollTop = 0, 1`);

    // blocking: Alice blocks Ben from his page; neither sees the other; unblocked from Settings
    await ev(`import('./js/profile.js').then((m) => { m.openProfile({ by: '${benPhone}', user: 'Ben' }); return 1; })`); await sleep(700);
    await ev(`(() => { window.confirm = () => true; document.querySelector('#sheet-panel .pf-block').click(); return 1; })()`);
    for (let i = 0; i < 40 && !((storeNow(META).blocks || {})[meNow] || []).includes(benPhone); i++) await sleep(200);
    await sleep(400);
    const herView = await ev(`document.querySelector('#sheet-panel .pf-head').textContent`);
    console.log("Alice blocked Ben; his page:", herView);
    check(((storeNow(META).blocks || {})[meNow] || []).includes(benPhone) && herView.includes("You've blocked Ben") && herView.includes("Unblock"), "blocked (saved), shown on his page");
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    await ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).querySelector('.so-cbtn').click(), 1`); await sleep(400);
    const herComments = await ev(`[...document.querySelectorAll('#sheet-panel .cs-c p')].map(p => p.textContent).join(', ')`);
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    await benOpensAlice();
    const hisView = await benView();
    const hisFeed = await other.ev(`import('./js/social.js').then((m) => { m.api.render(); return [...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one')); })`);
    console.log("Alice's comments panel (Ben blocked):", herComments || "(none)", "| Ben's view of her page:", JSON.stringify(hisView), "| her post in his feed:", hisFeed);
    check(!herComments.includes("Love this") && hisView.msg === "Not taking messages" && hisView.off && !hisFeed, "blocked: kept apart both ways");
    await ev(`document.getElementById('btn-settings').click(), 1`); await sleep(500);
    console.log("Settings, blocked people:", await ev(`document.getElementById('set-blocked').textContent`));
    await ev(`document.querySelector('#set-blocked .btn').click(), 1`);
    for (let i = 0; i < 40 && ((storeNow(META).blocks || {})[meNow] || []).includes(benPhone); i++) await sleep(200);
    await sleep(300);
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    check(!((storeNow(META).blocks || {})[meNow] || []).length, "unblocked from Settings");
    await ev(`import('./js/social.js').then((m) => m.api.render()).then(() => 1)`);

    // a ban (the bot's /ban): Ben's phone shut, even after reopening; his comments out of Alice's sight; lifted: open again
    setStore(MOD, { v: 1, bans: { [benPhone]: { at: Date.now(), name: "Ben" } } });
    await other.ev(`import('./js/ban.js').then((m) => m.checkBans()).then(() => 1)`);
    const shut = await other.ev(`document.getElementById('ban') && document.getElementById('app').inert ? document.getElementById('ban').textContent : ''`);
    console.log("Ben's phone, banned:", shut);
    check(shut.includes("banned"), "a banned phone is shut");
    await other.open(`http://127.0.0.1:${port}/?again2#social`, 600);
    check(await other.ev(`!!document.getElementById('ban')`), "and stays shut when the app is opened again");
    await ev(`import('./js/ban.js').then((m) => m.checkBans()).then(() => import('./js/social.js')).then((m) => { m.api.render(); return 1; })`); await sleep(300);
    await ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).querySelector('.so-cbtn').click(), 1`); await sleep(400);
    const seenComments = await ev(`[...document.querySelectorAll('#sheet-panel .cs-c p')].map(p => p.textContent).join(', ')`);
    console.log("Alice's comments panel with Ben banned:", seenComments || "(none)");
    check(!seenComments.includes("Love this"), "a banned phone's comments aren't shown");
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    setStore(MOD, { v: 1, bans: {} });
    await other.ev(`import('./js/ban.js').then((m) => m.checkBans()).then(() => 1)`);
    check(await other.ev(`!document.getElementById('ban') && !document.getElementById('app').inert`), "ban lifted: the app opens again");
    await ev(`import('./js/ban.js').then((m) => m.checkBans()).then(() => import('./js/social.js')).then((m) => { m.api.render(); return 1; })`);
    other.close();
  }
  check(eveLikes().length === 1, "the earlier like survived the new post");
  await ev(`document.getElementById('view-social').scrollTop = 0, 1`); await sleep(300);
  await shot("d3_posted");
  await ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).scrollIntoView({ block: 'start' }), 1`); await sleep(500);
  await shot("d3b_post");
  await ev(`document.getElementById('view-social').scrollTop = 0, 1`);

  // a new username: on this phone's older posts too (the post itself still says who it was sent as)
  const rename = async (v) => {
    await ev(`document.querySelector('#so-body .so-avbtn').click(), 1`); await sleep(400);
    await ev(`[...document.querySelectorAll('#sheet-panel .pf-btns .btn')].find(b => b.textContent === 'Change username').click(), 1`); await sleep(300);
    await setName(v);
    for (let i = 0; i < 40 && (profilesNow()[meId] || {}).name !== v; i++) await sleep(200);
    await sleep(300);
  };
  await rename("Alicia");
  const shownAs = await ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).querySelector('.so-name b').textContent`);
  console.log("renamed: her older post shows", shownAs, "| profile:", profilesNow()[meId].name, "| the post was sent as:", (feedNow().find((x) => x.id === p0.id) || {}).user);
  check(shownAs === "Alicia" && profilesNow()[meId].name === "Alicia", "the new username on the older post");
  await rename("Alice");

  // deleting it
  await ev(`(() => { window.confirm = () => true; [...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).querySelector('.so-more').click(); return 1; })()`); await sleep(300);
  await ev(`document.querySelector('#sheet-panel .so-del').click(), 1`);
  await until(`![...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one'))`, 10000, "the post deleted");
  for (let i = 0; i < 30 && feedNow().some((x) => x.id === p0.id); i++) await sleep(200);
  check(!msgs.has(p0.id) && !feedNow().some((x) => x.id === p0.id), "deleted from Discord and from the feed list");
  check(!(await ev(`!!document.querySelector('#so-body .so-post .so-more')`)), "the Delete menu only on your own posts");

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
  // on her page: the video plays right there (full screen, with sound), not by jumping to the feed
  await ev(`document.getElementById('btn-me').click(), 1`); await sleep(600);
  const tiles = await ev(`[...document.querySelectorAll('#sheet-panel .pf-tile')].map(t => t.classList.contains('vid') ? 'video' : 'picture').join(',')`);
  await ev(`document.querySelector('#sheet-panel .pf-tile.vid').click(), 1`);
  await until(`(() => { const v = document.querySelector('#viewer video'); return v && /cdn\.discordapp\.com/.test(v.src) && !v.paused; })()`, 10000, "the video playing on her page");
  const inViewer = await ev(`(() => { const v = document.querySelector('#viewer video'); return { playing: !v.paused, sound: !v.muted, controls: v.controls, still: /poster\.jpg/.test(v.poster), caption: document.querySelector('#viewer .viewer-foot').textContent, pageStillOpen: document.getElementById('sheet').classList.contains('open') && !!document.querySelector('#sheet-panel .pf-grid'), hash: location.hash }; })()`);
  console.log("her page's tiles:", tiles, "| the video, tapped:", JSON.stringify(inViewer));
  check(inViewer.playing && inViewer.sound && inViewer.controls && inViewer.pageStillOpen, "the video plays on her page, over it, with sound");
  await shot("d17_viewer");
  await ev(`document.querySelector('#viewer .viewer-x').click(), 1`); await sleep(300);
  check(!(await ev(`!!document.getElementById('viewer')`)) && (await ev(`document.getElementById('sheet').classList.contains('open')`)), "closed: back on her page");
  await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
  // a picture in the feed, tapped: full screen too, with its post's words
  {
    const pid = "900000000000000777";
    msgs.set(pid, { id: pid, content: "**Eve**", attachments: [attach(pid, "picture.jpg", readFileSync(avPng), "image/png")] });
    const k = msgs.get(INDEX).attachments[0].url.split("?")[0], d = JSON.parse(cdn.get(k).bytes.toString());
    d.posts.unshift({ id: pid, at: Date.now(), user: "Eve", text: "Pic time", image: true, by: "", likes: [], comments: [] });
    msgs.set(INDEX, { id: INDEX, content: "FifTeam Social feed", attachments: [attach(INDEX, "feed.json", Buffer.from(JSON.stringify(d)), "application/json")] });
  }
  await sleep(5200);
  await ev(`import('./js/social.js').then((m) => m.api.ensureProfiles(true)).then((x) => import('./js/social.js')).then((m) => { m.api.render(); return 1; })`);
  await until(`!!document.querySelector('#so-body img.so-img.in')`, 8000, "the new picture post");
  await ev(`document.querySelector('#so-body img.so-img').click(), 1`);
  await until(`!!document.querySelector('#viewer img') && document.querySelector('#viewer img').naturalWidth > 0`, 8000, "a picture full screen");
  console.log("a feed picture, tapped:", await ev(`document.querySelector('#viewer .viewer-foot').textContent`));
  await ev(`document.querySelector('#viewer .viewer-x').click(), 1`); await sleep(300);

  // music on a picture: a part of a song from her library, chosen and heard before posting; it plays in the feed
  await ev(`document.querySelector('#so-body .so-qbtn').click(), 1`);   // (Photo: straight to choosing a picture)
  await sleep(300);
  {
    await send("Page.setInterceptFileChooserDialog", { enabled: true });
    const ch = new Promise((res) => b.on((m) => { if (m.method === "Page.fileChooserOpened") res(m.params); }));
    await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent.includes('Picture')).click(), 1`);
    const fc = await ch;
    await send("DOM.setFileInputFiles", { backendNodeId: fc.backendNodeId, files: [avPng] });
    await send("Page.setInterceptFileChooserDialog", { enabled: false });
  }
  await until(`!!document.querySelector('#sheet-panel .so-addmusic')`, 6000, "Add music, once there's a picture");
  await ev(`document.querySelector('#sheet-panel .so-addmusic').click(), 1`); await sleep(400);
  console.log("music to choose from:", await ev(`[...document.querySelectorAll('#sheet-panel .so-mlist .t')].map(t => t.textContent).join(', ')`));
  await ev(`[...document.querySelectorAll('#sheet-panel .so-mlist .item')].find(li => li.textContent.includes('Test Rebass')).click(), 1`); await sleep(400);
  await ev(`document.querySelector('#sheet-panel .seg button[data-n="15"]').click(), 1`);
  await ev(`(() => { const r = document.querySelector('#sheet-panel input[type=range]'); r.value = 5; r.dispatchEvent(new Event('input')); return 1; })()`);
  console.log("the part:", await ev(`document.querySelector('#sheet-panel .so-plab').textContent`));
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent.includes('Hear it')).click(), 1`); await sleep(600);
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent === 'Use this part').click(), 1`); await sleep(500);
  console.log("in the new post:", await ev(`document.querySelector('#sheet-panel .so-mchip').textContent`));
  await ev(`(() => { document.querySelector('#sheet-panel textarea').value = 'Pic with music'; return 1; })()`);
  const nPosted = posted.length;
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent === 'Post').click(), 1`);
  await until(`[...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Pic with music')) || !!(document.querySelector('#sheet-panel .set-err') || {}).textContent`, 30000, "the picture with music posted");
  const perr = await ev(`(document.querySelector('#sheet.open #sheet-panel .set-err') || {}).textContent || ''`); if (perr) console.log("posting said:", perr);
  const pm = posted.slice(nPosted).find((x) => x.payload.content && x.payload.content.includes("Pic with music"));
  const mus = pm && pm.files.find(([n]) => n === "music.mp4");
  const entry = feedNow().find((x) => x.text === "Pic with music") || {};
  console.log("posted:", pm ? pm.files.map(([n, b2]) => `${n} ${b2.length} bytes`).join(", ") : "nothing", "| on the feed:", JSON.stringify(entry.music), "| in the channel:", pm && pm.payload.content.split("\n").slice(-1)[0]);
  check(mus && mus[1].subarray(0, 4).toString() === "FTS1" && entry.music && entry.music.len === 3 && entry.music.title === "Test Rebass", "the music clip went up with the picture (15 seconds asked, the whole 3-second song)");
  const mcard = `[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Pic with music'))`;
  await ev(`${mcard}.querySelector('.so-music').click(), 1`);
  await until(`${mcard}.querySelector('.so-music').classList.contains('on')`, 8000, "the music playing");
  await sleep(800);
  const playing = await ev(`import('./js/social.js').then((m) => { const a = m.social.state.clip; return !!a && !a.paused && a.currentTime > 0.2; })`);
  console.log("the music, tapped:", await ev(`${mcard}.querySelector('.so-music').textContent`), "| playing:", playing);
  check(playing, "the picture's music plays in the feed");
  await shot("d18_music");
  await ev(`${mcard}.querySelector('.so-music').click(), 1`); await sleep(300);
  check(await ev(`import('./js/social.js').then((m) => m.social.state.clip.paused)`), "and stops again");

  // the top bar slides away scrolling down, and comes back at the smallest scroll up
  await ev(`(() => { const v = document.getElementById('view-social'); v.scrollTop = 0; return 1; })()`); await sleep(300);
  await ev(`(() => { const v = document.getElementById('view-social'); let y = 0; const step = () => { y += 40; v.scrollTop = y; if (y < 400) requestAnimationFrame(step); }; step(); return 1; })()`); await sleep(900);
  const hidden = await ev(`document.querySelector('.top').classList.contains('hide')`);
  await ev(`(() => { const v = document.getElementById('view-social'); v.scrollTop = v.scrollTop - 2; return 1; })()`); await sleep(400);
  const back = await ev(`!document.querySelector('.top').classList.contains('hide')`);
  console.log("top bar: scrolled down, hidden:", hidden, "| 2 px back up, shown:", back);
  check(hidden && back, "the top bar hides scrolling down and comes back at once scrolling up");
  await ev(`document.getElementById('view-social').scrollTop = 0, 1`);

  // speed: opened again, the posts' files come from what the phone remembers (no request per post), pictures from its cache
  check(Object.keys(JSON.parse(await ev(`localStorage.getItem('fifteam-links') || '{}'`))).length >= 2, "file links remembered on the phone");
  gets.clear();
  await b.open(`http://127.0.0.1:${port}/?again3#social`, 2500);
  await until(`!!document.querySelector('#so-body img.so-img.in')`, 10000, "the pictures after opening again");
  const postReads = [...gets.entries()].filter(([id]) => feedNow().some((x) => x.id === id && (x.image || x.video || x.song))).length;
  const pics = await ev(`caches.open('fifteam-media-pics').then((c) => c.keys()).then((k) => k.length)`);
  console.log("opened again: post reads", postReads, "| pictures kept on the phone:", pics, "| feed kept for an instant start:", await ev(`!!localStorage.getItem('fifteam-feed')`));
  check(postReads === 0 && pics > 0, "opened again: no request per post, pictures from the phone");
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

  // categories for rebassed songs: one made with a cover, a song put in it, opened, then deleted
  await ev(`location.hash = '#library', 1`); await sleep(400);
  await ev(`document.querySelector('#lib-seg [data-k="rebass"]').click(), 1`); await sleep(300);
  check(!(await ev(`document.getElementById('lib-cats').hidden`)), "the categories row on Rebassed");
  await ev(`document.querySelector('#lib-cats .cat-new').click(), 1`); await sleep(300);
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  const catChooser = new Promise((res) => b.on((m) => { if (m.method === "Page.fileChooserOpened") res(m.params); }));
  await ev(`document.querySelector('#sheet-panel .cat-pick').click(), 1`);
  const catFc = await catChooser;
  await send("DOM.setFileInputFiles", { backendNodeId: catFc.backendNodeId, files: [avPng] });
  await send("Page.setInterceptFileChooserDialog", { enabled: false });
  await until(`document.querySelector('#sheet-panel .cat-pick-l').textContent === 'Change cover'`, 6000, "the category's cover");
  await ev(`(() => { const f = document.querySelector('#sheet-panel .cat-form'); f.querySelector('input').value = 'Car bangers'; f.requestSubmit(); return 1; })()`); await sleep(600);
  let cats = JSON.parse(await ev(`localStorage.getItem('fifteam-cats')`));
  console.log("categories:", JSON.stringify(cats));
  check(cats.length === 1 && cats[0].name === "Car bangers" && cats[0].cover, "a category, with its cover");
  await ev(`[...document.querySelectorAll('#lib-list .item')].find(li => li.textContent.includes('Test Rebass')).querySelector('.more').click(), 1`); await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .menu-item')].find(x => x.textContent.includes('category')).click(), 1`); await sleep(400);
  await ev(`document.querySelector('#sheet-panel .cat-check').click(), 1`); await sleep(200);
  cats = JSON.parse(await ev(`localStorage.getItem('fifteam-cats')`));
  check(cats[0].ids.length === 1, "the song put in it");
  await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
  await shot("d11_categories");
  await ev(`document.querySelector('#lib-cats .cat-tile[data-cat]').click(), 1`); await sleep(400);
  const open1 = await ev(`document.getElementById('lib-cats').textContent + ' | ' + [...document.querySelectorAll('#lib-list .item .t')].map(t => t.textContent).join(', ')`);
  console.log("the category open:", open1);
  check(open1.includes("Car bangers") && open1.endsWith("| Test Rebass"), "opened: just its songs");
  await shot("d12_category_open");
  await ev(`(() => { window.confirm = () => true; document.querySelector('#lib-cats .more').click(); return 1; })()`); await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .menu-item')].find(x => x.textContent.includes('Delete')).click(), 1`); await sleep(400);
  check(JSON.parse(await ev(`localStorage.getItem('fifteam-cats')`)).length === 0 && (await ev(`document.querySelectorAll('#lib-list .item').length`)) >= 2, "category deleted; its songs still in the library");
  await ev(`location.hash = '#social', 1`); await sleep(300);

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
