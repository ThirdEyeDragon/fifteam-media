// node test/social.test.mjs - FifTeam Social in headless Edge against a stand-in for Discord (answered here through the
// DevTools protocol; discord.com never sees these requests): picking a username, the feed, posting a picture and a
// rebass, playing and keeping someone's song, deleting, a post deleted in Discord, markup in a post, no pings. Also the
// knob lock on the Player.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { botKeys, openSealed } from "../tools/bot/auth.mjs";
import { createHash } from "node:crypto";
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
const META = "900000000000000003", PRES = "900000000000000004", MOD = "900000000000000005", MARKET = "900000000000000007";
const ACCTS = "900000000000000008";
msgs.set(ACCTS, { id: ACCTS, content: "accounts", attachments: [attach(ACCTS, "accounts.json", Buffer.from(JSON.stringify({ v: 1, a: {} })), "application/json")] });
msgs.set(MARKET, { id: MARKET, content: "market", attachments: [attach(MARKET, "market.json", Buffer.from(JSON.stringify({ v: 1, items: [] })), "application/json")] });
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
// the stand-in for the sign-in service (Google's Firebase Authentication): accounts, the emailed links (a test "taps"
// one with fb.tapLink), sign-in, a new password; and the FifTeam bot's key (for the sealed emails in the check-ins)
const authKeys = await botKeys(mkdtempSync(join(tmpdir(), "ft-auth-")));
const fb = { users: new Map(), links: [], tapLink(email) { const u = this.users.get(email); if (u) u.verified = true; } };
function firebase(u, body) {
  const rnd = () => Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14);
  const fail = (m) => ({ status: 400, type: "application/json", body: Buffer.from(JSON.stringify({ error: { code: 400, message: m } })) });
  const byToken = (t) => [...fb.users.values()].find((x) => x.tokens.has(t) || x.ids.has(t));
  const tokens = (x) => { const id = "id-" + rnd(), rf = "rf-" + rnd(); x.ids.add(id); x.tokens.add(rf); return { id, rf }; };
  if (u.host === "securetoken.googleapis.com") {
    const q = new URLSearchParams(body.toString()), x = byToken(q.get("refresh_token"));
    if (!x) return fail("INVALID_REFRESH_TOKEN");
    if (x.disabled) return fail("USER_DISABLED");
    const t = tokens(x); return json({ id_token: t.id, refresh_token: t.rf, user_id: x.localId });
  }
  const d = JSON.parse(body.toString() || "{}"), op = u.pathname.split(":").pop();
  if (op === "signUp") {
    if (fb.users.has(d.email)) return fail("EMAIL_EXISTS");
    if (String(d.password).length < 6) return fail("WEAK_PASSWORD : Password should be at least 6 characters");
    const x = { email: d.email, pass: d.password, localId: "fb" + rnd() + rnd(), verified: false, displayName: "", ids: new Set(), tokens: new Set() };
    fb.users.set(d.email, x); const t = tokens(x);
    return json({ idToken: t.id, refreshToken: t.rf, localId: x.localId, email: d.email });
  }
  if (op === "signInWithPassword") {
    const x = fb.users.get(d.email);
    if (!x || x.pass !== d.password) return fail("INVALID_LOGIN_CREDENTIALS");
    if (x.disabled) return fail("USER_DISABLED");
    const t = tokens(x); return json({ idToken: t.id, refreshToken: t.rf, localId: x.localId, email: x.email });
  }
  if (op === "sendOobCode") { const x = d.idToken ? byToken(d.idToken) : fb.users.get(d.email); fb.links.push({ type: d.requestType, email: x ? x.email : d.email }); return json({ email: x ? x.email : d.email }); }
  if (op === "lookup") { const x = byToken(d.idToken); if (!x) return fail("INVALID_ID_TOKEN"); return json({ users: [{ localId: x.localId, email: x.email, emailVerified: x.verified, displayName: x.displayName }] }); }
  if (op === "update") { const x = byToken(d.idToken); if (!x) return fail("INVALID_ID_TOKEN"); if (d.displayName != null) x.displayName = d.displayName; return json({ localId: x.localId, displayName: x.displayName }); }
  return fail("UNKNOWN");
}
let clobber = null;
const gets = new Map();
function discord(method, url, headers, body) {
  const u = new URL(url);
  if (u.host === "identitytoolkit.googleapis.com" || u.host === "securetoken.googleapis.com") return firebase(u, body);
  if (u.host === "api.bigdatacloud.net") { const lat = +u.searchParams.get("latitude"); return json(lat > 40.5 ? { city: "City of Toledo", principalSubdivisionCode: "US-OH", countryCode: "US" } : { city: "Columbus", principalSubdivisionCode: "US-OH", countryCode: "US" }); }
  if (u.host === "cdn.discordapp.com") { const f = cdn.get(url.split("?")[0]); return f ? { status: 200, type: f.type, body: f.bytes } : { status: 404, type: "text/plain", body: Buffer.from("no") }; }
  if (u.pathname.endsWith("/social/config.json")) return json({ hook: HOOK, key: Buffer.from(TOKEN.split("").reverse().join("")).toString("base64"), index: INDEX, dm: DM, meta: META, presence: PRES, mod: MOD, links: LINKS, market: MARKET, accounts: ACCTS, auth: authKeys.pub, firebase: { apiKey: "test-key" } });
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
await send("Fetch.enable", { patterns: [{ urlPattern: "https://discord.com/*" }, { urlPattern: "https://cdn.discordapp.com/*" }, { urlPattern: "*social/config.json*" }, { urlPattern: "https://api.bigdatacloud.net/*" }, { urlPattern: "https://identitytoolkit.googleapis.com/*" }, { urlPattern: "https://securetoken.googleapis.com/*" }] });
// (the app's service worker fetches pictures itself: its requests go to the stand-in too)
b.on((m) => { if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "service_worker") send("Fetch.enable", { patterns: [{ urlPattern: "https://cdn.discordapp.com/*" }, { urlPattern: "https://discord.com/*" }] }, m.params.sessionId); });
const until = async (expr, ms, what) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } check(false, "timed out waiting for " + what); return false; };
const text = (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent).join(' | ')`);
const shot = async (name) => { if (!process.env.SHOTS) return; const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(process.env.SHOTS, name + ".png"), Buffer.from(r.result.data, "base64")); };

// creating an account through the sign-in screen: email and password; the link in the email (tapped); Continue
const gateNames = {};
async function signUp(br, email, pass = "bass-head-2026", name = email.split("@")[0].replace(/^./, (c) => c.toUpperCase())) {
  const wait = async (expr, ms, what) => { const t = Date.now(); while (Date.now() - t < ms) { if (await br.ev(expr).catch(() => false)) return true; await sleep(200); } check(false, "timed out waiting for " + what); return false; };
  await wait(`!!document.getElementById('acct')`, 8000, "the sign-in screen");
  await br.ev(`[...document.querySelectorAll('#acct .acct-link')].find(x => x.textContent.includes('Create an account')).click(), 1`); await sleep(200);
  await br.ev(`(() => { const f = document.querySelector('#acct form'), i = f.querySelectorAll('input'); i[0].value = ${JSON.stringify(email)}; i[1].value = ${JSON.stringify(pass)}; i[2].value = ${JSON.stringify(pass)}; f.requestSubmit(); return 1; })()`);
  await wait(`(document.querySelector('#acct .acct-title') || {}).textContent === 'Check your email'`, 15000, "the check-your-email screen");
  // Continue before the link is tapped: not yet
  await br.ev(`document.querySelector('#acct form').requestSubmit(), 1`);
  await wait(`/Not confirmed yet/.test(document.querySelector('#acct .acct-err').textContent)`, 8000, "not confirmed yet");
  const early = await br.ev(`document.querySelector('#acct .acct-err').textContent`);
  fb.tapLink(email);
  await br.ev(`document.querySelector('#acct form').requestSubmit(), 1`);
  await wait(`!document.getElementById('acct') && !!document.getElementById('gate-name')`, 15000, "signed in (then the username screen)");
  const gate = (v) => br.ev(`(() => { const f = document.querySelector('#gate-name form'); f.querySelector('input').value = ${JSON.stringify(v)}; f.requestSubmit(); return 1; })()`);
  await gate("a"); await sleep(300);
  const tooShort = await br.ev(`document.querySelector('#gate-name .acct-err').textContent`);
  const appShut = await br.ev(`document.getElementById('app').inert`);
  await gate(name);
  await wait(`!document.getElementById('gate-name') && !document.getElementById('app').inert`, 15000, "the username picked, the app open");
  gateNames[email] = { tooShort, appShut, kept: await br.ev(`localStorage.getItem('fifteam-social-name')`) };
  return early;
}

try {
  await b.open(`http://127.0.0.1:${port}/#social`, 3000);
  // first: the sign-in screen, over everything, until an account is made
  const shut = await ev(`!!document.getElementById('acct') && document.getElementById('app').inert && document.querySelector('#acct .acct-title').textContent`);
  console.log("first launch:", shut);
  check(shut === "Sign in", "the app opens on the sign-in screen, and can't be used until then");
  const phoneBefore = await ev(`localStorage.getItem('fifteam-social-me')`);
  await shot("d26_signin");
  const early = await signUp(b, "alice@example.com");
  const acc = fb.users.get("alice@example.com") || {};
  console.log("account made:", JSON.stringify({ emails: fb.links.map((l) => `${l.type} to ${l.email}`), beforeTheLink: early, keptOnTheAccount: acc.displayName, phoneWas: phoneBefore }));
  check(acc.displayName === "ft:" + phoneBefore && fb.links.some((l) => l.type === "VERIFY_EMAIL" && l.email === "alice@example.com") && /Not confirmed yet/.test(early), "an account, confirmed by the link in its email (the phone keeps its id, kept on the account)");
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

  // the username: picked on its own screen straight after the account is made (the app shut until then)
  const gn = gateNames["alice@example.com"] || {};
  console.log("username screen:", JSON.stringify(gn), "| post box:", await text("#so-body .so-pill"));
  check(gn.appShut === true && /2 to 24 letters/.test(gn.tooShort || "") && gn.kept === "Alice", "a new account picks its username before anything else (too short refused)");
  check((await text("#so-body .so-pill")) === "What's on your mind, Alice?", "username set (it greets you on the post box)");
  // finding people: the search button, typing part of a name, tapping one opens their page
  await until(`!!document.getElementById('so-find')`, 5000, "the search button");
  await ev(`document.getElementById('so-find').click(), 1`);
  await until(`!!document.querySelector('#sheet-panel .so-findbox input')`, 8000, "the search sheet");
  const typeIn = async (q) => { await ev(`(() => { const i = document.querySelector('#sheet-panel .so-findbox input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); return 1; })()`); await sleep(300); return ev(`[...document.querySelectorAll('#sheet-panel .so-frow .so-fname')].map(r => r.textContent).join(' | ') || document.querySelector('#sheet-panel .so-flist').textContent`); };
  const suggested = await ev(`[...document.querySelectorAll('#sheet-panel .so-frow')].length`);
  const ev1 = await typeIn("ev"), none = await typeIn("zzqq");
  const eve1 = await typeIn("eve");
  await ev(`(document.querySelector('#sheet-panel .so-frow') || { click() {} }).click(), 1`); await sleep(900);
  const page = await ev(`(document.querySelector('#sheet-panel .pf-name') || {}).textContent || ''`);
  console.log("search:", JSON.stringify({ suggested, ev1, eve1, none, page }));
  check(suggested >= 1 && /Eve/.test(ev1) && !/Alice/.test(ev1) && /Nobody called/.test(none) && /Eve/.test(page), "search finds people by name (not yourself), and a tap opens their page");
  await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);

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
  await ev(`document.querySelectorAll('#sheet-panel .cs-c').forEach((c) => (c.__keep = 1)), 1`);
  await ev(`[...document.querySelectorAll('#sheet-panel .cs-c')].find(c => c.textContent.includes('Hard!')).querySelector('.cs-act').click(), 1`);   // Reply
  console.log("replying:", await ev(`document.querySelector('#sheet-panel .cs-to').textContent`));
  await say("Agreed");
  for (let i = 0; i < 40 && eveComments().length < 2; i++) await sleep(200);
  await sleep(300);
  {
    const kept = await ev(`JSON.stringify([...document.querySelectorAll('#sheet-panel .cs-c')].map((c) => [c.textContent.includes('Agreed'), !!c.__keep]))`);
    console.log("comment rows after a new one (new, kept):", kept);
    check(JSON.parse(kept).length === 2 && JSON.parse(kept).every(([n, k]) => n !== k), "a new comment: the rows already there stay as they are (no flash), the new one added");
  }
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
  // @names in a comment: suggested while typing "@", then a highlighted link to their page
  await ev(`(() => { const i = document.querySelector('#sheet-panel .cs-form input'); i.focus(); i.value = 'nice one @Ev'; i.setSelectionRange(12, 12); i.dispatchEvent(new Event('input')); return 1; })()`); await sleep(300);
  const sug = await ev(`[...document.querySelectorAll('.mn-box .mn-row')].map((r) => r.textContent).join(' | ')`);
  await ev(`(() => { const r = document.querySelector('.mn-box .mn-row'); r && r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); return 1; })()`); await sleep(200);
  const typed = await ev(`document.querySelector('#sheet-panel .cs-form input').value`);
  await ev(`(() => { const f = document.querySelector('#sheet-panel .cs-form'); f.querySelector('input').value += 'keep it up'; f.requestSubmit(); return 1; })()`);
  for (let i = 0; i < 40 && !eveComments().some((c) => /@Eve/.test(c.text)); i++) await sleep(200);
  await sleep(500);
  const link = await ev(`(() => { const m = [...document.querySelectorAll('#sheet-panel .cs-c .mention')].find((x) => x.textContent === '@Eve'); return m ? m.textContent : ''; })()`);
  await ev(`[...document.querySelectorAll('#sheet-panel .cs-c .mention')].find((x) => x.textContent === '@Eve').click(), 1`); await sleep(1200);
  const pfOpened = await ev(`(document.querySelector('#sheet-panel .pf-name') || {}).textContent || ''`);
  console.log("@ in a comment:", JSON.stringify({ sug, typed, link, opened: pfOpened }));
  check(/Eve/.test(sug) && typed === "nice one @Eve " && link === "@Eve" && /Eve/.test(pfOpened), "@names in comments: suggested while typing, highlighted, and tapped open their page");
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
  await until(`!!document.querySelector('#sheet-panel .so-pthumb')`, 8000, "the picture in the new post");
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent.includes('Rebassed song')).click(), 1`); await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .item')].find(i => i.textContent.includes('Test Rebass')).click(), 1`); await sleep(500);
  await shot("d2_new_post");
  console.log("new post before sending:", await ev(`document.querySelector('#sheet-panel textarea').value + ' | picture ' + !!document.querySelector('#sheet-panel .so-pthumb') + ' | song ' + (document.querySelector('#sheet-panel .so-song b') || {}).textContent`));
  await ev(`document.querySelectorAll('#so-body .so-post').forEach((c) => (c.__keep = 1)), 1`);
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(b => b.textContent === 'Post').click(), 1`);
  await until(`[...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one'))`, 30000, "the post in the feed");
  await sleep(1500);
  {
    const kept = await ev(`JSON.stringify([...document.querySelectorAll('#so-body .so-post')].map((c) => [c.textContent.includes('Fresh one'), !!c.__keep]))`);
    console.log("cards after a new post (new, kept):", kept);
    check(JSON.parse(kept).length >= 3 && JSON.parse(kept).every(([n, k]) => n !== k), "a new post: the cards already there stay as they are (no flash or reload), the new one added on top");
  }
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
    await other.send("Fetch.enable", { patterns: [{ urlPattern: "https://discord.com/*" }, { urlPattern: "https://cdn.discordapp.com/*" }, { urlPattern: "*social/config.json*" }, { urlPattern: "https://api.bigdatacloud.net/*" }, { urlPattern: "https://identitytoolkit.googleapis.com/*" }, { urlPattern: "https://securetoken.googleapis.com/*" }] });
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
    await signUp(other, "ben@example.com", "ben-subwoofers-1");
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
    const setLook = await ev(`JSON.stringify({ first: document.querySelector('#sheet-panel .set-sec').id, signout: (document.getElementById('set-signout') || {}).textContent, email: document.querySelector('#set-account .set-email').textContent, lock: /Lock app|Set password/.test(document.getElementById('sheet-panel').textContent) || !!document.getElementById('lock') })`).then(JSON.parse);
    console.log("Settings:", JSON.stringify(setLook), "| sections:", await ev(`[...document.querySelectorAll('#sheet-panel .set-head')].map(h => h.textContent.replace(/(On|Off)$/, '').trim()).join(', ')`));
    check(setLook.first === "set-account" && setLook.signout === "Sign out" && setLook.email === "Signed in as alice@example.com" && !setLook.lock, "Settings: the account and Sign out first, no app lock");
    await shot("d7b_settings");
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    // a private message: from the other phone to Alice, by tapping her picture
    await other.ev(`localStorage.setItem('fifteam-social-name', 'Ben'), 1`); await other.open(`http://127.0.0.1:${port}/?again#social`, 3500);
    await other.ev(`new Promise(r => { const t = Date.now(); (function w() { [...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Fresh one')) || Date.now() - t > 15000 ? r(1) : setTimeout(w, 200); })(); })`);
    await other.ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).querySelector('.so-av').click(), 1`); await sleep(400);
    console.log("tapping Alice's picture:", await other.ev(`document.querySelector('#sheet-panel').textContent.replace(/\\s+/g, ' ').trim()`));
    const benPhone = await other.ev(`localStorage.getItem('fifteam-social-me')`);
    const page = JSON.parse(await other.ev(`JSON.stringify({ about: (document.querySelector('#sheet-panel .pf-about') || {}).textContent, tiles: document.querySelectorAll('#sheet-panel .pf-tile').length, tabs: [...document.querySelectorAll('#sheet-panel .pf-seg button')].map(b => b.textContent) })`));
    console.log("Alice's page, seen by Ben:", JSON.stringify(page));
    check(page.about === "Bass head from Ohio" && page.tiles === 1 && page.tabs.join() === "Pics & videos · 1,Songs · 1", "her page: about me, her picture post, her song post");
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
    const fromOthers = (l) => (l || []).filter((w) => w !== meNow).length;
    const likesShould = feedNow().reduce((n, x) => n + (x.by === meNow ? fromOthers(x.likes) : 0), 0);
    console.log("her likes given to her own posts and comments (not counted):", feedNow().reduce((n, x) => n + (x.by === meNow && (x.likes || []).includes(meNow) ? 1 : 0), 0));
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

    // sending a post in a message: Alice's Send on her own post, to Ben
    const benId = await other.ev(`localStorage.getItem('fifteam-social-me')`);
    const freshId = feedNow().find((x) => x.text && x.text.startsWith("Fresh one")).id;
    await ev(`location.hash = '#social', 1`); await sleep(300);
    await ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.dataset.id === ${JSON.stringify(freshId)}).querySelector('.so-send').click(), 1`);
    await until(`[...document.querySelectorAll('#sheet-panel.dm-send .dm-row')].some(r => r.textContent.includes('Ben'))`, 10000, "the Send to list");
    console.log("Send to:", await ev(`document.querySelector('#sheet-panel .dm-what').textContent + ' | ' + [...document.querySelectorAll('#sheet-panel .dm-row')].map(r => r.textContent).join(', ')`));
    await shot("d8b_send_to");
    const nBefore = dmNow().length;
    await ev(`(() => { document.querySelector('#sheet-panel .dm-note').value = 'look at this'; [...document.querySelectorAll('#sheet-panel .dm-row')].find(r => r.textContent.includes('Ben')).querySelector('button').click(); return 1; })()`);
    for (let i = 0; i < 40 && dmNow().length <= nBefore; i++) await sleep(250);
    await until(`[...document.querySelectorAll('#sheet-panel .dm-row')].some(r => r.textContent.includes('Sent'))`, 8000, "Sent");
    const postMsg = dmNow()[dmNow().length - 1];
    check(dmNow().length === nBefore + 1 && postMsg.t === benId && !JSON.stringify(postMsg).includes(freshId) && !/look at this/.test(JSON.stringify(dmNow())), "a post sent in a message, sealed (no post id or words in the store)");
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    // Ben sees it as the post (a tap would show it in Social)
    await other.ev(`import('./js/social.js').then((m) => m.api.ensureProfiles(true)).then(() => 1)`);
    await other.ev(`import('./js/dms.js').then((m) => m.openChat(${JSON.stringify(alice)})).then(() => 1)`);
    let benPost = "";
    for (let i = 0; i < 85 && !benPost; i++) { benPost = await other.ev(`(() => { const b = [...document.querySelectorAll('#sheet-panel .dm-bubble')].find(b => b.querySelector('.dm-post')); return b ? b.textContent : ''; })()`); await sleep(300); }
    console.log("Ben's chat shows:", benPost);
    if (!benPost) console.log("  (his panel:", await other.ev(`(document.getElementById('sheet-panel') || {}).textContent.slice(0, 300) + ' | open ' + document.getElementById('sheet').classList.contains('open') + ' | bubbles ' + document.querySelectorAll('#sheet-panel .dm-bubble').length`), "| his errors:", other.errors.slice(-5).join(" || ").slice(0, 900), ")");
    check(/Post/.test(benPost) && /Fresh one/.test(benPost) && /look at this/.test(benPost), "Ben's chat shows the post, with Alice's words");
    // held down: deleted for both of them
    await other.ev(`[...document.querySelectorAll('#sheet-panel .dm-bubble')].find(b => b.querySelector('.dm-post')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), 1`);
    await sleep(300);
    console.log("held:", await other.ev(`[...document.querySelectorAll('.dm-act .menu-item')].map(b => b.textContent).join(' | ')`));
    await other.ev(`[...document.querySelectorAll('.dm-act .menu-item')].find(b => b.textContent.includes('Delete for both')).click(), 1`);
    for (let i = 0; i < 40 && dmNow().some((x) => x.id === postMsg.id); i++) await sleep(250);
    for (let i = 0; i < 40 && (await other.ev(`[...document.querySelectorAll('#sheet-panel .dm-bubble')].some(b => b.querySelector('.dm-post'))`)); i++) await sleep(250);
    const delList = storeNow(DM).del || [];
    const benGone = await other.ev(`![...document.querySelectorAll('#sheet-panel .dm-bubble')].some(b => b.querySelector('.dm-post'))`);
    await ev(`import('./js/dms.js').then((m) => m.dms.state.check()).then(() => 1)`);
    const aliceStill = await ev(`import('./js/dms.js').then((m) => m.dms.state.msgs.some((x) => x.id === ${JSON.stringify(postMsg.id)}))`);
    console.log("after deleting: in the store:", dmNow().some((x) => x.id === postMsg.id), "| on the deleted list:", delList.includes(postMsg.id), "| on Ben's screen:", !benGone, "| on Alice's phone:", aliceStill);
    check(!dmNow().some((x) => x.id === postMsg.id) && delList.includes(postMsg.id) && benGone && !aliceStill, "held down and deleted: gone for both of them");
    // an older copy written back (a phone that read the store before the delete) doesn't bring it back
    setStore(DM, { v: 1, msgs: [...dmNow(), postMsg], del: delList });
    await ev(`import('./js/dms.js').then((m) => m.dms.state.check()).then(() => 1)`);
    check(!(await ev(`import('./js/dms.js').then((m) => m.dms.state.msgs.some((x) => x.id === ${JSON.stringify(postMsg.id)}))`)), "a deleted message stays deleted when an older copy is written back");
    setStore(DM, { v: 1, msgs: dmNow().filter((x) => x.id !== postMsg.id), del: delList });
    await other.ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    // a rebassed song, sealed for Ben: plays and goes into his library
    const songBytes = Buffer.alloc(24000); songBytes.write("ID3"); for (let i = 3; i < songBytes.length; i++) songBytes[i] = (i * 7) & 255;
    const msgCount = msgs.size;
    await ev(`import('./js/dms.js').then((m) => { m.sendTo({ song: { title: 'Test Rebass', artist: 'Alice', note: '30-60 Hz', duration: 2, cover: null, encode: async () => new File([Uint8Array.from(atob(${JSON.stringify(songBytes.toString("base64"))}), (c) => c.charCodeAt(0))], 'x.mp3', { type: 'audio/mpeg' }) } }); return 1; })`);
    await until(`[...document.querySelectorAll('#sheet-panel.dm-send .dm-row')].some(r => r.textContent.includes('Ben'))`, 10000, "the Send to list for the song");
    const nB2 = dmNow().length;
    await ev(`[...document.querySelectorAll('#sheet-panel .dm-row')].find(r => r.textContent.includes('Ben')).querySelector('button').click(), 1`);
    for (let i = 0; i < 60 && dmNow().length <= nB2; i++) await sleep(250);
    const songMsgId = [...msgs.keys()].slice(msgCount).find((k) => (msgs.get(k).attachments || []).some((a) => /^song(\.bin|-x\.mp4)$/.test(a.filename)));
    const sealedBytes = songMsgId && cdn.get(msgs.get(songMsgId).attachments.find((a) => /^song(\.bin|-x\.mp4)$/.test(a.filename)).url.split("?")[0]).bytes;
    console.log("the song's file:", songMsgId ? `${sealedBytes.length} bytes, sealed: ${!sealedBytes.includes(Buffer.from("ID3"))}` : "none");
    check(!!songMsgId && !sealedBytes.includes(songBytes.subarray(0, 200)) && dmNow().length === nB2 + 1, "a rebassed song sent sealed");
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    await other.ev(`import('./js/dms.js').then((m) => m.openChat(${JSON.stringify(alice)})).then(() => 1)`);
    let benSong = "";
    for (let i = 0; i < 40 && !benSong; i++) { benSong = await other.ev(`(() => { const s = document.querySelector('#sheet-panel .dm-song'); return s ? s.textContent : ''; })()`); await sleep(300); }
    console.log("Ben's chat shows the song:", benSong);
    await other.ev(`document.querySelector('#sheet-panel .dm-song .so-add').click(), 1`);
    let inLib = "";
    for (let i = 0; i < 40 && !inLib; i++) { inLib = await other.ev(`import('./js/library.js').then((m) => { const t = m.library.all().find((x) => x.title === 'Test Rebass'); return t ? t.kind + ' ' + t.size + ' bytes, ' + t.note : ''; })`); await sleep(300); }
    console.log("in Ben's library:", inLib);
    check(/Test Rebass/.test(benSong) && inLib === `rebass ${songBytes.length} bytes, 30-60 Hz`, "Ben opens the song (the same bytes) and adds it to his library");
    // the whole chat, held in Ben's inbox: deleted for both (the song's file too)
    await other.ev(`(window.confirm = () => true, document.getElementById('btn-dms').click(), 1)`);
    for (let i = 0; i < 30 && !(await other.ev(`!!document.querySelector('#sheet-panel .dm-row')`)); i++) await sleep(300);
    await other.ev(`[...document.querySelectorAll('#sheet-panel .dm-row')].find(r => r.textContent.includes('Alice')).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), 1`);
    await sleep(300);
    await other.ev(`[...document.querySelectorAll('.dm-act .menu-item')].find(b => b.textContent.includes('Delete chat')).click(), 1`);
    const between = (x) => (x.f === alice && x.t === benId) || (x.f === benId && x.t === alice);
    for (let i = 0; i < 40 && dmNow().some((x) => between(x) && !x.l); i++) await sleep(250);
    // (the song's file goes after, at low priority: within a few seconds)
    for (let i = 0; i < 24 && msgs.has(songMsgId); i++) await sleep(250);
    await sleep(300);
    console.log("chat deleted: left in the store:", dmNow().filter((x) => between(x) && !x.l).length, "| the song's file:", msgs.has(songMsgId) ? "still there" : "deleted", "| Ben's inbox:", await other.ev(`document.querySelector('#sheet-panel .dm-list').textContent`));
    check(!dmNow().some((x) => between(x) && !x.l) && !msgs.has(songMsgId), "a whole chat deleted for both, with its song file");
    await other.ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);

    // Audio Market: Alice (in Toledo) lists a sub; Ben (about 120 miles away, in Columbus) finds it, asks about it
    const origin = `http://127.0.0.1:${port}`;
    await send("Browser.grantPermissions", { permissions: ["geolocation"], origin });
    await send("Emulation.setGeolocationOverride", { latitude: 41.6528, longitude: -83.5379, accuracy: 30 });
    await other.send("Browser.grantPermissions", { permissions: ["geolocation"], origin });
    await other.send("Emulation.setGeolocationOverride", { latitude: 39.9612, longitude: -82.9988, accuracy: 30 });
    const marketNow = () => storeNow(MARKET).items || [];
    await ev(`document.querySelector('#so-tabs [data-k="market"]').click(), 1`); await sleep(600);
    console.log("Audio Market, empty:", await ev(`document.querySelector('#mk-body .mk-empty').textContent`), "| chips:", await ev(`[...document.querySelectorAll('#mk-body .mk-chips .chip')].map(c => c.textContent).join(' | ')`));
    await ev(`document.querySelector('#mk-body .mk-sell').click(), 1`); await sleep(400);
    {
      await send("Page.setInterceptFileChooserDialog", { enabled: true });
      const ch = new Promise((res) => b.on((m) => { if (m.method === "Page.fileChooserOpened") res(m.params); }));
      await ev(`document.querySelector('#sheet-panel .mk-padd').click(), 1`);
      const fc = await ch;
      await send("DOM.setFileInputFiles", { backendNodeId: fc.backendNodeId, files: [avPng, avPng] });
      await send("Page.setInterceptFileChooserDialog", { enabled: false });
    }
    await until(`document.querySelectorAll('#sheet-panel .mk-pthumb').length === 2`, 6000, "two photos");
    await ev(`(() => { const P = document.getElementById('sheet-panel'); const i = P.querySelectorAll('input.input'); i[0].value = 'Sundown SA-12 D2'; i[1].value = '250'; P.querySelector('textarea').value = 'Barely used, no blown coils. Pick up only.'; [...P.querySelectorAll('.mk-catpick .chip')].find(c => c.textContent === 'Subwoofers').click(); [...P.querySelectorAll('.mk-condpick .chip')].find(c => c.textContent === 'Used – like new').click(); return 1; })()`);
    check(!(await ev(`!!document.querySelector('#sheet-panel input[aria-label="Your town"], #sheet-panel input[placeholder*="town"]')`)), "no place to type a town");
    await until(`(document.querySelector('#sheet-panel .mk-locname') || {}).textContent === '📍 Toledo, OH'`, 8000, "her town, from her location");
    console.log("where (from the phone's location):", await ev(`document.querySelector('#sheet-panel .mk-loc').textContent`));
    await shot("d19_sell");
    const nListed = posted.length;
    await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent === 'List it').click(), 1`);
    for (let i = 0; i < 60 && !marketNow().length; i++) await sleep(250);
    await sleep(400);
    const item = marketNow()[0] || {};
    const lp = posted.slice(nListed).find((x) => x.payload.content && x.payload.content.includes("Audio Market"));
    console.log("listed:", JSON.stringify({ title: item.title, price: item.price, cat: item.cat, cond: item.cond, place: item.place, lat: item.lat, lon: item.lon, n: item.n, by: item.by === meNow }), "| photos:", lp ? lp.files.map(([n]) => n).join(",") : "none");
    check(item.title === "Sundown SA-12 D2" && item.price === 250 && item.cat === "Subwoofers" && item.n === 2 && item.lat === 41.65 && item.lon === -83.55 && lp && lp.files.length === 2, "listed: its photos, price, category and a rough spot (rounded)");
    await until(`!!document.querySelector('#mk-body .mk-tile')`, 6000, "the listing in the grid");
    console.log("Alice's grid:", await ev(`[...document.querySelectorAll('#mk-body .mk-tile')].map(t => t.textContent).join(' | ')`));
    await sleep(600); await shot("d20_market");
    // Ben: the grid, the distance, the filters
    // (opening Audio Market asks for the location by itself)
    await other.ev(`(async () => { localStorage.removeItem('fifteam-market-here'); const m = await import('./js/market.js'); m.showMarket(true); return 1; })()`);
    await sleep(1500);
    await other.ev(`import('./js/market.js').then((m) => m.loadMarket(0)).then(() => import('./js/market.js')).then((m) => { m.renderMarket(); return 1; })`); await sleep(400);
    console.log("Ben's location, asked for on opening Audio Market:", await other.ev(`localStorage.getItem('fifteam-market-here')`));
    const benTile = await other.ev(`[...document.querySelectorAll('#mk-body .mk-tile')].map(t => t.textContent).join(' | ')`);
    console.log("Ben's grid:", benTile);
    check(/\$250.*Sundown.*Toledo, OH · 1[0-9]{2} mi/.test(benTile), "Ben sees it, with how far away it is (about 120 miles)");
    const benFilter = async (fn) => { await other.ev(`import('./js/market.js').then((m) => { const M = m.market.state; ${fn}; m.renderMarket(); return 1; })`); await sleep(200); return other.ev(`document.querySelectorAll('#mk-body .mk-tile').length`); };
    const within50 = await benFilter("M.dist = 50"), within250 = await benFilter("M.dist = 250"), under100 = await benFilter("M.dist = 0; M.max = 100"), sub = await benFilter("M.max = null; M.cat = 'Amplifiers'"), back2 = await benFilter("M.cat = ''");
    console.log("Ben's filters: within 50 mi", within50, "| within 250 mi", within250, "| under $100", under100, "| amplifiers", sub, "| all", back2);
    check(within50 === 0 && within250 === 1 && under100 === 0 && sub === 0 && back2 === 1, "distance, price and category filters");
    // Ben asks about it: an Audio Market chat (apart from their usual messages)
    await other.ev(`document.querySelector('#mk-body .mk-tile').click(), 1`); await sleep(700);
    console.log("the listing, on Ben's phone:", await other.ev(`document.querySelector('#sheet-panel .mk-info').textContent`));
    await other.ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent.includes('Message seller')).click(), 1`); await sleep(1200);
    await other.ev(`(() => { const f = document.querySelector('#sheet-panel .dm-form'); f.querySelector('input').value = 'Is the sub still available?'; f.requestSubmit(); return 1; })()`);
    for (let i = 0; i < 40 && !dmNow().some((x) => x.l === item.id); i++) await sleep(250);
    await sleep(300);
    const mm = dmNow().find((x) => x.l === item.id);
    console.log("the message is about the listing:", !!mm, "| sealed:", mm && !/sub still/.test(JSON.stringify(mm)));
    check(mm && mm.f === benPhone && mm.t === meNow && !/sub still/.test(JSON.stringify(mm)), "an Audio Market chat message, sealed, tied to the listing");
    await other.ev(`document.getElementById('sheet').classList.remove('open'), 1`);
    await ev(`import('./js/dms.js').then((m) => m.dms.state.check()).then(() => 1)`);
    await ev(`document.getElementById('btn-dms').click(), 1`); await sleep(900);
    const inboxAll = await ev(`[...document.querySelectorAll('#sheet-panel .dm-row')].map(r => r.textContent).join(' | ')`);
    await ev(`document.querySelector('#sheet-panel .dm-seg [data-k="chats"]').click(), 1`); await sleep(200);
    const inboxChats = await ev(`[...document.querySelectorAll('#sheet-panel .dm-row')].map(r => r.textContent).join(' | ')`);
    await ev(`document.querySelector('#sheet-panel .dm-seg [data-k="market"]').click(), 1`); await sleep(200);
    const inboxMarket = await ev(`[...document.querySelectorAll('#sheet-panel .dm-row')].map(r => r.textContent).join(' | ')`);
    console.log("Alice's messages: all:", inboxAll, "|| chats:", inboxChats || "(none)", "|| Audio Market:", inboxMarket);
    check(inboxMarket.includes("Audio Market · Sundown SA-12 D2") && inboxMarket.includes("Is the sub still available?") && !inboxChats.includes("Is the sub still available?"), "the Audio Market chat sits under Audio Market, apart from the usual chats");
    await shot("d21_market_inbox");
    await ev(`document.querySelector('#sheet-panel .dm-row.dm-mk').click(), 1`); await sleep(900);
    const chat = await ev(`document.querySelector('#sheet-panel .dm-listing').textContent + ' || ' + [...document.querySelectorAll('#sheet-panel .dm-bubble')].map(b => b.textContent).join(' | ')`);
    console.log("the chat:", chat);
    check(chat.includes("Sundown SA-12 D2") && chat.includes("$250") && chat.includes("Is the sub still available?"), "the chat shows the listing it's about");
    await shot("d22_market_chat");
    await ev(`document.querySelector('#sheet-panel .dm-listing').click(), 1`); await sleep(600);
    // sold: off the grid for buyers
    await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent === 'Mark as sold').click(), 1`);
    for (let i = 0; i < 40 && !(marketNow()[0] || {}).sold; i++) await sleep(250);
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
    const benAfter = await benFilter("0");
    await other.ev(`import('./js/market.js').then((m) => m.loadMarket(0)).then(() => import('./js/market.js')).then((m) => { m.renderMarket(); return 1; })`); await sleep(300);
    const benSold = await other.ev(`document.querySelectorAll('#mk-body .mk-tile').length`);
    console.log("sold:", !!(marketNow()[0] || {}).sold, "| on Ben's grid:", benSold);
    check((marketNow()[0] || {}).sold === 1 && benSold === 0, "sold: off the grid");
    await ev(`document.querySelector('#so-tabs [data-k="feed"]').click(), 1`); await sleep(300);
    await other.ev(`import('./js/market.js').then((m) => { m.showMarket(false); return 1; })`);

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

  // editing her post: the words changed, marked edited
  await ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one')).querySelector('.so-more').click(), 1`); await sleep(300);
  await ev(`document.querySelector('#sheet-panel .so-edit').click(), 1`); await sleep(300);
  await ev(`(() => { document.querySelector('#sheet-panel textarea').value = 'Fresh one (edited) @everyone'; [...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent === 'Save').click(); return 1; })()`);
  for (let i = 0; i < 40 && !(feedNow().find((x) => x.id === p0.id) || {}).edited; i++) await sleep(200);
  await sleep(400);
  const ed = feedNow().find((x) => x.id === p0.id) || {};
  const edCard = await ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Fresh one (edited)'))?.querySelector('.so-name small').textContent || ''`);
  console.log("edited:", JSON.stringify({ text: ed.text, edited: !!ed.edited }), "| on the card:", edCard);
  check(ed.text === "Fresh one (edited) @everyone" && ed.edited && /edited/.test(edCard), "a post edited after it went up (marked edited)");

  // a new username: on this phone's older posts too (the post itself still says who it was sent as)
  const setName = (v) => ev(`(() => { const f = document.querySelector('#so-body .so-nameform'); f.querySelector('input').value = ${JSON.stringify(v)}; f.requestSubmit(); return 1; })()`);
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
  // (someone else's post: its ⋯ menu reports it, and has no Edit or Delete)
  await ev(`document.querySelector('#so-body .so-post .so-more').click(), 1`); await sleep(400);
  const others = await ev(`[...document.querySelectorAll('#sheet-panel .menu-item')].map(b => b.textContent).join(' | ')`);
  console.log("someone else's post, its menu:", others);
  check(!/Delete|Edit/.test(others) && /Report post/.test(others), "Edit and Delete only on your own posts (others' have Report)");
  await ev(`import('./js/ui.js').then(m => { m.closeSheet(); return 1; })`); await sleep(300);

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

  // the slur filter: a comment with one isn't sent (and says why); swearing goes through
  {
    const before = (feedNow().find((x) => x.id === eve) || {}).comments.length;
    await ev(`${`document.querySelector('#so-body .so-post[data-id="${eve}"]')`}.querySelector('.so-cbtn').click(), 1`); await sleep(400);
    const word = ["n", "i", "g", "g", "3", "r"].join("");
    await ev(`(() => { const f = document.querySelector('#sheet-panel .cs-form'); f.querySelector('input').value = 'you ${word}'; f.requestSubmit(); return 1; })()`); await sleep(500);
    const said = await ev(`document.getElementById('toast').textContent`);
    const kept = await ev(`document.querySelector('#sheet-panel .cs-form input').value.length > 0`);
    await sleep(1500);
    console.log("a slur in a comment:", said, "| still in the box:", kept, "| comments saved:", (feedNow().find((x) => x.id === eve) || {}).comments.length - before);
    check(said === "Unable to post due to profanity that is found to be offensive to others" && (feedNow().find((x) => x.id === eve) || {}).comments.length === before, "a slur isn't posted, and it says why");
    await ev(`(() => { const f = document.querySelector('#sheet-panel .cs-form'); f.querySelector('input').value = 'this shit slaps'; f.requestSubmit(); return 1; })()`);
    for (let i = 0; i < 40 && (feedNow().find((x) => x.id === eve) || {}).comments.length === before; i++) await sleep(200);
    check((feedNow().find((x) => x.id === eve) || {}).comments.length === before + 1, "swearing goes through");
    await ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
  }

  // several pictures and a video in one post: a collage; a tap opens the post's own feed of them; full screen, swiped
  await ev(`document.querySelector('#so-body .so-new').click(), 1`); await sleep(400);
  await ev(`(() => { document.querySelector('#sheet-panel textarea').value = 'Three in one'; return 1; })()`);
  {
    await send("Page.setInterceptFileChooserDialog", { enabled: true });
    let ch = new Promise((res) => b.on((m) => { if (m.method === "Page.fileChooserOpened") res(m.params); }));
    await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent.includes('Pictures')).click(), 1`);
    let fc = await ch;
    await send("DOM.setFileInputFiles", { backendNodeId: fc.backendNodeId, files: [avPng, avPng] });
    await until(`document.querySelectorAll('#sheet-panel .so-pthumb').length === 2`, 6000, "two pictures in the new post");
    const vfile = join(mkdtempSync(join(tmpdir(), "ft-v3-")), "clip.webm");
    writeFileSync(vfile, Buffer.from(await ev(`(async () => {
      const c = document.createElement('canvas'); c.width = 160; c.height = 120; const g = c.getContext('2d');
      const st = c.captureStream(20), rec = new MediaRecorder(st, { mimeType: 'video/webm' }), parts = []; rec.ondataavailable = (e) => parts.push(e.data);
      const done = new Promise((r) => rec.onstop = r); rec.start(100);
      const t0 = performance.now(); await new Promise((res) => { const f = () => { g.fillStyle = 'hsl(' + ((performance.now() - t0) / 5) + ',80%,50%)'; g.fillRect(0, 0, 160, 120); if (performance.now() - t0 < 1200) requestAnimationFrame(f); else res(); }; f(); });
      rec.stop(); await done; const u8 = new Uint8Array(await new Blob(parts).arrayBuffer()); let s = ''; for (const x of u8) s += String.fromCharCode(x); return btoa(s); })()`), "base64"));
    ch = new Promise((res) => b.on((m) => { if (m.method === "Page.fileChooserOpened") res(m.params); }));
    await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent.includes('Video')).click(), 1`);
    fc = await ch;
    await send("DOM.setFileInputFiles", { backendNodeId: fc.backendNodeId, files: [vfile] });
    await send("Page.setInterceptFileChooserDialog", { enabled: false });
    await until(`document.querySelectorAll('#sheet-panel .so-pthumb').length === 3`, 8000, "and a video");
  }
  console.log("the new post:", await ev(`document.querySelector('#sheet-panel .so-pstrip').parentElement.textContent`));
  const n3 = posted.length;
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent === 'Post').click(), 1`);
  await until(`[...document.querySelectorAll('#so-body .so-post')].some(p => p.textContent.includes('Three in one'))`, 60000, "the post with three");
  const p3 = posted.slice(n3).find((x) => x.payload.content && x.payload.content.includes("Three in one"));
  const e3 = feedNow().find((x) => x.text === "Three in one") || {};
  console.log("sent:", p3 ? p3.files.map(([nm, b2]) => `${nm} ${b2.length}`).join(", ") : "nothing", "| on the feed:", JSON.stringify(e3.media));
  check(p3 && ["m0.jpg", "m1.jpg", "m2.webm", "m2.poster.jpg"].every((nm) => p3.files.some(([f]) => f === nm)) && JSON.stringify(e3.media) === '["i","i","webm"]', "two pictures and a video, in order, in one post");
  const c3 = `[...document.querySelectorAll('#so-body .so-post')].find(p => p.textContent.includes('Three in one'))`;
  await until(`${c3}.querySelectorAll('.so-col .so-cell').length === 3 && !${c3}.querySelector('.so-cell.so-wait')`, 8000, "the collage");
  await ev(`${c3}.scrollIntoView({ block: 'start' }), 1`); await sleep(300);
  await shot("d23_collage");
  await ev(`${c3}.querySelectorAll('.so-cell')[1].click(), 1`); await sleep(800);
  const feed3 = await ev(`JSON.stringify({ panel: document.querySelector('#sheet-panel').classList.contains('pm-panel'), imgs: document.querySelectorAll('#sheet-panel .pm-img').length, vids: document.querySelectorAll('#sheet-panel .pm-vid').length, loaded: [...document.querySelectorAll('#sheet-panel .pm-img')].every(i => i.naturalWidth > 0) })`);
  console.log("the post's own feed:", feed3);
  check(JSON.parse(feed3).panel && JSON.parse(feed3).imgs === 2 && JSON.parse(feed3).vids === 1, "a tap opens the post's own feed of all three");
  await shot("d24_post_feed");
  await ev(`document.querySelectorAll('#sheet-panel .pm-img')[0].click(), 1`);
  await until(`!!document.querySelector('#viewer .viewer-strip') && document.querySelectorAll('#viewer .viewer-slide').length === 3`, 6000, "full screen, all three");
  await sleep(500);
  const c1 = await ev(`document.querySelector('#viewer .viewer-count').textContent`);
  await ev(`(() => { const s = document.querySelector('#viewer .viewer-strip'); s.scrollLeft = s.clientWidth * 2; return 1; })()`); await sleep(700);
  const c2 = await ev(`document.querySelector('#viewer .viewer-count').textContent`);
  const vplay = await ev(`(() => { const v = document.querySelector('#viewer .viewer-slide:last-child video'); return !!v && !v.paused; })()`);
  console.log("full screen:", c1, "→ swiped:", c2, "| the video plays when it's on screen:", vplay);
  check(c1 === "1 / 3" && c2 === "3 / 3", "full screen, swiping from one to the next");

  // going back: a swipe in from the left edge closes the top layer (the viewer, then the post's feed)
  const swipe = async () => {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 6, y: 420 }] });
    for (let x = 6; x <= 200; x += 24) { await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 424 }] }); await sleep(16); }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await sleep(600);
  };
  await swipe();
  const afterOne = await ev(`JSON.stringify({ viewer: !!document.getElementById('viewer'), sheet: document.getElementById('sheet').classList.contains('open') })`);
  await swipe();
  const afterTwo = await ev(`JSON.stringify({ viewer: !!document.getElementById('viewer'), sheet: document.getElementById('sheet').classList.contains('open'), hash: location.hash })`);
  console.log("swipe back once:", afterOne, "| twice:", afterTwo);
  check(JSON.parse(afterOne).viewer === false && JSON.parse(afterOne).sheet === true && JSON.parse(afterTwo).sheet === false && JSON.parse(afterTwo).hash === "#social", "swiping back closes the viewer, then the post's feed (and stays in Social)");
  // the phone's own back (Android's gesture or button) does the same
  await ev(`document.querySelector('#so-body .so-cbtn').click(), 1`); await sleep(400);
  await ev(`history.back(), 1`); await sleep(500);
  check(!(await ev(`document.getElementById('sheet').classList.contains('open')`)) && (await ev(`location.hash`)) === "#social", "the phone's back closes a sheet");

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
  await ev(`${mcard}.scrollIntoView({ block: 'center' }), 1`);
  await until(`${mcard}.querySelector('.so-music').classList.contains('on')`, 8000, "the music playing by itself, the picture on screen");
  const clipState = () => ev(`import('./js/social.js').then((m) => { const a = m.social.state.clip; return !!a && !a.paused && a.currentTime > 0.2; })`);
  let playing = false;
  for (let i = 0; i < 25 && !playing; i++) { playing = await clipState(); if (!playing) await sleep(200); }
  console.log("the picture on screen, its music:", await ev(`${mcard}.querySelector('.so-music').textContent`), "| playing by itself:", playing);
  check(playing, "the picture's music plays by itself while it's on screen");
  await shot("d18_music");
  await ev(`${mcard}.querySelector('.so-music').click(), 1`); await sleep(1500);
  const pausedStays = await ev(`import('./js/social.js').then((m) => m.social.state.clip.paused)`);
  await ev(`${mcard}.querySelector('.so-music').click(), 1`);
  let resumed = false;
  for (let i = 0; i < 25 && !resumed; i++) { resumed = await clipState(); if (!resumed) await sleep(200); }
  console.log("tapped: paused (and stays paused):", pausedStays, "| tapped again, playing:", resumed);
  check(pausedStays && resumed, "a tap pauses it, another plays it again");
  await ev(`document.getElementById('view-social').scrollTop = 99999, 1`); await sleep(600);
  check(await ev(`import('./js/social.js').then((m) => m.social.state.clip.paused)`), "scrolled away: the music stops");
  await ev(`document.getElementById('view-social').scrollTop = 0, 1`); await sleep(300);

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
  // shared to Social as a playlist
  await ev(`document.querySelector('#lib-cats .more').click(), 1`); await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .menu-item')].find(x => x.textContent.includes('Share to Social')).click(), 1`);
  await until(`document.getElementById('sheet').classList.contains('open') && [...document.querySelectorAll('#sheet-panel .btn')].some(x => x.textContent === 'Share playlist')`, 5000, "the share sheet");
  const nPl = posted.length;
  await ev(`[...document.querySelectorAll('#sheet-panel .btn')].find(x => x.textContent === 'Share playlist').click(), 1`);
  for (let i = 0; i < 6; i++) { await sleep(500); console.log("  sharing:", await ev(`(document.querySelector('#sheet-panel .btn.primary') || {}).textContent + ' | ' + ((document.querySelector('#sheet-panel .set-err') || {}).textContent || '') + ' | open ' + document.getElementById('sheet').classList.contains('open') + ' | ' + location.hash`)); }
  if (!(await until(`location.hash === '#social' && [...document.querySelectorAll('#so-body .so-pl')].length > 0`, 60000, "the playlist on Social"))) console.log("sharing showed:", await ev(`(document.getElementById('sheet-panel') || {}).innerHTML.slice(0, 400) + ' | open ' + document.getElementById('sheet').classList.contains('open') + ' | hash ' + location.hash`), "| page errors:", b.errors.slice(-6).join(" || ").slice(0, 1500));
  const plPost = posted.slice(nPl).find((x) => x.payload.content && x.payload.content.includes("shared a playlist"));
  const plSongs = posted.slice(nPl).filter((x) => x.files.some(([nm]) => nm === "song.mp4"));
  const plEntry = feedNow().find((x) => x.playlist) || {};
  console.log("playlist shared:", plPost && plPost.payload.content.split("\n")[0], "| songs sent:", plSongs.length, "| on the feed:", JSON.stringify(plEntry.playlist && { name: plEntry.playlist.name, n: plEntry.playlist.items.length }));
  check(plPost && plSongs.length === 1 && plEntry.playlist && plEntry.playlist.name === "Car bangers" && plEntry.playlist.items.length === 1, "a category shared as a playlist (each song its own file)");
  // Community Rebass: the Rebasses tab shows only rebassed songs and rebass playlists, apart from the feed
  await ev(`location.hash = '#social', 1`); await sleep(300);
  const feedCards = await ev(`document.querySelectorAll('#so-body .so-post').length`), feedSongs = await ev(`[...document.querySelectorAll('#so-body .so-post')].filter(c => c.querySelector('.so-song, .so-pl')).length`);
  await ev(`document.querySelector('#so-tabs button[data-k="rebass"]').click(), 1`); await sleep(600);
  const rb = JSON.parse(await ev(`JSON.stringify({ title: (document.querySelector('#so-body .so-rbtitle b') || {}).textContent, cards: [...document.querySelectorAll('#so-body .so-post')].map(c => ({ song: !!c.querySelector('.so-song, .so-pl'), text: (c.querySelector('.so-smeta b, .so-pl b, .so-text') || {}).textContent })), on: document.querySelector('#so-tabs button.on').dataset.k })`));
  console.log("Rebasses tab:", JSON.stringify(rb), "| the feed had", feedCards, "posts,", feedSongs, "with songs");
  check(rb.title === "Community Rebass" && rb.cards.length >= 1 && rb.cards.length === feedSongs && rb.cards.every((c) => c.song) && rb.cards.length < feedCards && rb.on === "rebass", "the Rebasses tab: only rebassed songs (and playlists), apart from the feed");
  await ev(`document.querySelector('#so-body .so-rbsort .chip[data-k="liked"]').click(), 1`); await sleep(400);
  const likedOrder = await ev(`[...document.querySelectorAll('#so-body .so-post')].map(c => +((c.querySelector('.so-slikes') || {}).textContent || '0').replace(/[^0-9]/g, '') || 0).join(',')`);
  console.log("sorted by most liked:", likedOrder, "| remembered:", await ev(`localStorage.getItem('fifteam-rebass-sort') + ' / ' + localStorage.getItem('fifteam-social-tab')`));
  check(likedOrder.split(",").map(Number).every((v, k, a) => !k || a[k - 1] >= v), "sorted by most liked");
  await shot("d27_community_rebass");
  await ev(`document.querySelector('#so-body .so-rbsort .chip[data-k="new"]').click(), 1`); await sleep(200);
  await ev(`document.querySelector('#so-tabs button[data-k="feed"]').click(), 1`); await sleep(500);
  check((await ev(`document.querySelectorAll('#so-body .so-post').length`)) === feedCards, "and back to the whole feed");
  const plCard = `document.querySelector('#so-body .so-pl').closest('.so-post')`;
  check(!(await ev(`!!${plCard}.querySelector('.so-vote')`)), "a playlist can't be voted for (so it's never the rebass of the week)");
  await ev(`${plCard}.scrollIntoView({ block: 'start' }), 1`); await sleep(400); await shot("d25_playlist");
  await ev(`${plCard}.querySelector('.so-pltop .btn').click(), 1`);
  await until(`${plCard}.querySelector('.so-pltop .btn').textContent === 'Added'`, 20000, "the playlist added");
  const catsNow = JSON.parse(await ev(`localStorage.getItem('fifteam-cats')`));
  console.log("added all: categories now", catsNow.map((c) => `${c.name} (${c.ids.length})`).join(", "));
  check(catsNow.length === 2 && catsNow[1].ids.length === 1, "added all: the songs, in a category of their own");
  await ev(`location.hash = '#library', 1`); await sleep(400);
  await ev(`document.querySelector('#lib-seg [data-k="rebass"]').click(), 1`); await sleep(300);
  await ev(`(document.querySelector('#lib-cats .cat-tile[data-cat]') || { click() {} }).click(), 1`); await sleep(300);   // (still open from before)
  await ev(`(() => { window.confirm = () => true; document.querySelector('#lib-cats .more').click(); return 1; })()`); await sleep(300);
  await ev(`[...document.querySelectorAll('#sheet-panel .menu-item')].find(x => x.textContent.includes('Delete')).click(), 1`); await sleep(400);
  check(JSON.parse(await ev(`localStorage.getItem('fifteam-cats')`)).length === 1 && (await ev(`document.querySelectorAll('#lib-list .item').length`)) >= 2, "category deleted; its songs still in the library");
  await ev(`location.hash = '#social', 1`); await sleep(300);

  // the account: still signed in after opening again; signed out; back in with the password; a wrong one; banned
  await b.open(`http://127.0.0.1:${port}/?again5#player`, 2500);
  check(!(await ev(`!!document.getElementById('acct')`)), "still signed in after opening again");
  await ev(`document.getElementById('btn-settings').click(), 1`); await sleep(500);
  console.log("Settings:", await ev(`document.querySelector('#sheet-panel .set-email').textContent`));
  await ev(`(() => { window.confirm = () => true; document.getElementById('set-signout').click(); return 1; })()`); await sleep(2500);
  check(await ev(`!!document.getElementById('acct')`), "signed out: the sign-in screen again");
  const signIn = async (email, pass) => { await ev(`(() => { const f = document.querySelector('#acct form'), i = f.querySelectorAll('input'); i[0].value = ${JSON.stringify(email)}; i[1].value = ${JSON.stringify(pass)}; f.requestSubmit(); return 1; })()`); for (let i = 0; i < 50; i++) { await sleep(200); const st = await ev(`document.getElementById('acct') ? document.querySelector('#acct .acct-err').textContent : 'in'`); if (st) return st; } return "timed out"; };
  const wrong = await signIn("alice@example.com", "not-my-password");
  console.log("a wrong password:", wrong);
  check(/don't match/.test(wrong), "a wrong password is refused");
  const right = await signIn("alice@example.com", "bass-head-2026");
  console.log("the right one:", right, "| same phone id:", (await ev(`localStorage.getItem('fifteam-social-me')`)) === phoneBefore);
  check(right === "in" && (await ev(`localStorage.getItem('fifteam-social-me')`)) === phoneBefore, "signed back in with the password (the same id)");
  // the sealed email in her check-in: only the bot's key opens it
  const pe = (storeNow(PRES).on[phoneBefore] || {}).e;
  const opened = pe ? await openSealed(authKeys, pe).catch(() => "") : "";
  console.log("her check-in's email, as stored:", pe ? pe.slice(0, 40) + "…" : "none", "| opened by the bot:", opened);
  check(opened === "alice@example.com" && !pe.includes("alice"), "her email reaches the bot sealed (nobody else can read it)");
  // the account list (the bot's /accounts reads it, with nothing running on a PC): every account, sealed
  await sleep(1500);
  const accts = storeNow(ACCTS).a || {}, rows = [];
  for (const [fid, v] of Object.entries(accts)) rows.push({ fid, email: await openSealed(authKeys, v.e).catch(() => "?"), ok: v.ok, u: v.u, raw: v.e });
  console.log("the account list:", rows.map((r) => `${r.email} (confirmed ${r.ok}, phone ${r.u || "none"})`).join(" | "));
  const ar = rows.find((r) => r.email === "alice@example.com"), br = rows.find((r) => r.email === "ben@example.com");
  check(ar && ar.ok === 1 && ar.u === phoneBefore && ar.fid === fb.users.get("alice@example.com").localId && br && br.ok === 1 && rows.every((r) => !r.raw.includes("@example")), "every account in the account list, confirmed, with its phone, the emails sealed");
  // banned by email (/ban-email): she can't sign in; lifted: she can
  { const d = storeNow(MOD); d.emails = { [createHash("sha256").update("alice@example.com").digest("hex")]: { at: Date.now() } }; setStore(MOD, d); }
  await ev(`import('./js/ban.js').then((m) => m.checkBans()).then(() => 1)`);
  const shutNow = await ev(`!!document.getElementById('ban')`);
  console.log("banned by email: the app shut at once:", shutNow);
  check(shutNow, "an email ban shuts the app on her phone");
  await ev(`(localStorage.removeItem('fifteam-ban'), caches.delete('fifteam-flags')).then ? 1 : 1`);
  await ev(`import('./js/account.js').then((m) => m.signOut()), 1`); await sleep(2500);
  const banned = await signIn("alice@example.com", "bass-head-2026");
  console.log("signing in, banned:", banned);
  check(/banned/.test(banned), "a banned email can't sign in");
  { const d = storeNow(MOD); d.emails = {}; setStore(MOD, d); }
  await ev(`import('./js/ban.js').then((m) => m.checkBans()).then(() => 1)`);
  check(await signIn("alice@example.com", "bass-head-2026") === "in", "and can again once it's unbanned");
  await b.open(`http://127.0.0.1:${port}/?again6#player`, 2500);

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
