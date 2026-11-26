// node test/live.test.mjs - two phones (Alice and Ben, headless Edge at phone size) using the app through the FifTeam
// server (tools/bot, in Cloudflare's runtime on this PC: wrangler dev), with stand-ins served here for the feed service,
// its files, the sign-in service and a push service. Checks how fast things are (Messages opening, a message arriving
// with no checking every few seconds), that phones don't ask the feed service for each post, real push notifications
// (sent to Alice's phone while her app is put away, opened here, then shown by her app's service worker), a comment's
// notification, and unlimited rebassing: the limit, the unlock sheet, the owner told, /premium, and it unlocking live.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createSign, createECDH, createHmac, createDecipheriv, randomBytes, sign as edSign } from "node:crypto";
import { browser } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), BOT = join(HERE, "..", "tools", "bot");
const P = 8797, W = 8798, APP = 8799, ST = `http://127.0.0.1:${P}`, WK = `http://127.0.0.1:${W}`, SITE = `http://127.0.0.1:${APP}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log(`  ${ok ? "ok" : "FAIL"}: ${what}`); if (!ok) fails++; };
const b64u = (b) => Buffer.from(b).toString("base64url");
const log = (...a) => console.log(...a);
const NL = "\n", CRLF2 = "\r\n\r\n";

// ---------------------------------------------------------------------------------------------------- the stand-ins
const HOOK = "111", TOKEN = "hooktoken", PROJECT = "test-proj";
const msgs = new Map(), files = new Map(), pushes = [], replies = [], posted = [], direct = [], reports = [];
let nextId = 900000000000001000;
const attach = (id, name, bytes) => { const url = `https://cdn.discordapp.com/attachments/1/${id}/${name}?ex=${Math.floor(Date.now() / 1000 + 86400).toString(16)}&is=0&hm=${Math.random().toString(16).slice(2)}`; files.set(`/attachments/1/${id}/${name}`, Buffer.from(bytes)); return { id: String(Math.random()).slice(2), filename: name, url }; };
const store = (id, name, data) => msgs.set(id, { id, attachments: [attach(id, name, JSON.stringify(data))] });
const IDS = { index: "900000000000000001", dm: "900000000000000002", meta: "900000000000000003", presence: "900000000000000004", mod: "900000000000000005", links: "900000000000000006", market: "900000000000000007", accounts: "900000000000000008" };
// (phone ids are 10 letters and numbers, as the app makes them)
const alice = "alicephone", ben = "benphone01", post1 = "900000000000000100";
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
store(IDS.index, "feed.json", { v: 1, posts: [{ id: post1, at: Date.now() - 60e3, user: "Alice", by: alice, text: "my first rebass picture", likes: [], comments: [], image: true }, { id: "900000000000000090", at: Date.now() - 86400e3, user: "Alice", text: "an old post from before", likes: [], comments: [] }], profiles: { [alice]: { name: "Alice", at: Date.now() }, [ben]: { name: "Ben", at: Date.now() } } });
store(IDS.dm, "dm.json", { v: 1, msgs: [] });
store(IDS.meta, "meta.json", { v: 1, votes: {}, follows: {}, about: {} });
store(IDS.presence, "presence.json", { v: 1, on: {} });
store(IDS.mod, "mod.json", { v: 1, bans: {}, nopic: {}, badges: {} });
store(IDS.links, "links.json", { v: 1, links: {} });
store(IDS.market, "market.json", { v: 1, items: [] });
store(IDS.accounts, "accounts.json", { v: 1, a: {} });
msgs.set(post1, { id: post1, attachments: [attach(post1, "picture.jpg", jpeg)] });

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
function idToken(phone) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })), p = b64u(JSON.stringify({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: "uid-" + phone, iat: now, exp: now + 3600, name: "ft:" + phone, email: phone + "@example.com", email_verified: true }));
  return `${h}.${p}.${b64u(createSign("RSA-SHA256").update(`${h}.${p}`).sign(rsa.privateKey))}`;
}
const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidJwk = await crypto.subtle.exportKey("jwk", vapid.privateKey), vapidPub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey)));
const ed = generateKeyPairSync("ed25519"), edPub = ed.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const botKey = await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"])).privateKey);
// Alice's phone's push keys (the browser's own push service can't be reached from here: the app's sign-up is given these)
const ua = createECDH("prime256v1"); ua.generateKeys(); const uaAuth = randomBytes(16);
const aliceSub = { endpoint: `${ST}/push/alice`, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(uaAuth) } };
function openPush(body) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
  const z = Buffer.from([0]), one = Buffer.from([1]);
  const ikm = hmac(hmac(uaAuth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from("WebPush: info"), z, ua.getPublicKey(), asPub, one]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm"), z, one])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce"), z, one])).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}
function multipart(body, ctype) {
  const bnd = /boundary=(.+)$/.exec(ctype)[1], parts = {}, sep = Buffer.from("--" + bnd);
  let i = body.indexOf(sep);
  while (i >= 0) {
    const next = body.indexOf(sep, i + sep.length); if (next < 0) break;
    const part = body.subarray(i + sep.length + 2, next - 2), he = part.indexOf(CRLF2);
    const head = part.subarray(0, he).toString(), name = /name="([^"]+)"/.exec(head)[1], file = /filename="([^"]+)"/.exec(head);
    parts[name] = { data: part.subarray(he + 4), filename: file && file[1] };
    i = next;
  }
  return parts;
}
const cfg = { hook: HOOK, key: Buffer.from(TOKEN.split("").reverse().join("")).toString("base64"), ...IDS, auth: "x.y", firebase: { apiKey: "k", projectId: PROJECT }, push: vapidPub, api: WK };
/** The feed service, its files, the sign-in service: one handler, for the server (over HTTP) and the phones (through DevTools). */
function serve(method, url, headers, body, fromPhone) {
  const u = new URL(url), res = (status, o, type = "application/json") => ({ status, type, body: Buffer.isBuffer(o) ? o : Buffer.from(typeof o === "string" ? o : JSON.stringify(o)) });
  if (u.pathname.endsWith("/social/config.json") || u.pathname === "/config.json") return res(200, cfg);
  if (u.pathname === "/jwks") return res(200, { keys: [jwk] });
  if (u.host === "securetoken.googleapis.com") { const q = new URLSearchParams(body.toString()), ph = String(q.get("refresh_token")).replace(/^rf-/, ""); return res(200, { id_token: idToken(ph), refresh_token: "rf-" + ph, user_id: "uid-" + ph }); }
  if (u.host === "identitytoolkit.googleapis.com") return res(200, { users: [{ localId: "x", emailVerified: true }] });
  const path = u.host === "cdn.discordapp.com" ? u.pathname : u.pathname.startsWith("/cdn/") ? u.pathname.slice(4) : null;
  if (path) { const f = files.get(path); return f ? res(200, f, "application/octet-stream") : res(404, "no", "text/plain"); }
  if (u.pathname.startsWith("/push/")) { pushes.push({ to: u.pathname.slice(6), headers, body }); return res(201, ""); }
  if (u.pathname.startsWith("/api/v10/webhooks/app1/")) { replies.push(body.toString()); return res(200, {}); }
  if (u.pathname === "/api/v10/attachments/refresh-urls") return res(200, { refreshed_urls: [] });
  if (u.pathname === "/api/v10/guilds/1/channels") return res(200, [{ id: "52", type: 0, name: "reports" }]);
  if (u.pathname === "/api/v10/channels/52/messages") { reports.push(JSON.parse(body.toString())); return res(200, { id: "1" }); }
  const base = `/api/v10/webhooks/${HOOK}/${TOKEN}`;
  if (!u.pathname.startsWith(base)) return res(404, { message: "Unknown Webhook" });
  const rest = u.pathname.slice(base.length), m = /^\/messages\/(\d+)$/.exec(rest);
  if (fromPhone) direct.push(`${method} ${rest || "/"}`);
  if (method === "GET" && rest === "") return res(200, { guild_id: "1" });
  if (method === "GET" && m) return msgs.has(m[1]) ? res(200, msgs.get(m[1])) : res(404, { message: "Unknown Message" });
  if (method === "DELETE" && m) { msgs.delete(m[1]); return res(204, ""); }
  if ((method === "POST" && rest === "") || (method === "PATCH" && m)) {
    const ct = headers["content-type"] || headers["Content-Type"] || "";
    if (/json/.test(ct)) { const id = String(nextId++), j = JSON.parse(body.toString()); posted.push(j); msgs.set(id, { id, content: j.content, attachments: [] }); return res(200, msgs.get(id)); }
    const parts = multipart(body, ct), id = m ? m[1] : String(nextId++);
    msgs.set(id, { id, attachments: Object.entries(parts).filter(([k]) => k.startsWith("files[")).map(([, p]) => attach(id, p.filename, p.data)) });
    return res(200, msgs.get(id));
  }
  return res(405, {});
}
const srv = createServer((req, res) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { const r = serve(req.method, ST + req.url, req.headers, Buffer.concat(c), false); res.writeHead(r.status, { "Content-Type": r.type }); res.end(r.body); }); }).listen(P);

// ---------------------------------------------------------------------------------------------------- the server and the site
const dir = mkdtempSync(join(tmpdir(), "ft-live-"));
for (const f of ["core.mjs", "hub.mjs", "worker.mjs"]) copyFileSync(join(BOT, f), join(dir, f));
writeFileSync(join(dir, "wrangler.toml"), ['name = "fifteam-live-test"', 'main = "worker.mjs"', 'compatibility_date = "2025-06-01"', "[[durable_objects.bindings]]", 'name = "HUB"', 'class_name = "Hub"', "[[migrations]]", 'tag = "v1"', 'new_sqlite_classes = ["Hub"]', ""].join(NL));
writeFileSync(join(dir, ".dev.vars"), [`PUBLIC_KEY=${edPub}`, `CONFIG_URL=${ST}/config.json`, `DISCORD_API=${ST}/api/v10`, `CDN_BASE=${ST}/cdn`, `FIREBASE_JWKS=${ST}/jwks`, `REPLY_API=${ST}/api/v10`, "BOT_TOKEN=test", `VAPID_KEY='${JSON.stringify(vapidJwk)}'`, `BOT_KEY='${JSON.stringify(botKey)}'`, ""].join(NL));
const dev = spawn("npx", ["-y", "wrangler@4", "dev", "--port", String(W), "--ip", "127.0.0.1", "--persist-to", join(dir, "state")], { cwd: dir, shell: true, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; dev.stdout.on("data", (d) => (out += d)); dev.stderr.on("data", (d) => (out += d));
const site = spawn(process.execPath, [join(HERE, "serve.mjs"), String(APP)], { stdio: "ignore" });
const signed = (body) => { const ts = String(Math.floor(Date.now() / 1000)); return fetch(WK + "/", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature-Ed25519": edSign(null, Buffer.from(ts + body), ed.privateKey).toString("hex"), "X-Signature-Timestamp": ts }, body }); };
const hubStore = async (k) => (await (await fetch(`${WK}/v1/stores?k=${k}`)).json()).s[k];

/** A phone, signed in as `ph` with username `name`, everything it asks the outside world for answered by the stand-ins. */
async function phone(ph, name) {
  const b = await browser({ profile: mkdtempSync(join(tmpdir(), "ft-lv-")) });
  const CORS = [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Access-Control-Allow-Headers", value: "Content-Type" }, { name: "Access-Control-Allow-Methods", value: "GET, POST, PATCH, DELETE, OPTIONS" }];
  b.on(async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    if (request.method === "OPTIONS") { await b.send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: CORS }, m.sessionId); return; }
    let body = Buffer.alloc(0);
    if (request.postDataEntries) body = Buffer.concat(request.postDataEntries.map((e) => Buffer.from(e.bytes || "", "base64"))); else if (request.postData) body = Buffer.from(request.postData);
    const r = serve(request.method, request.url, request.headers, body, true);
    await b.send("Fetch.fulfillRequest", { requestId, responseCode: r.status, responseHeaders: [...CORS, { name: "Content-Type", value: r.type }], body: r.body.toString("base64") }, m.sessionId);
  });
  const patterns = [{ urlPattern: "https://discord.com/*" }, { urlPattern: "https://cdn.discordapp.com/*" }, { urlPattern: "*social/config.json*" }, { urlPattern: "https://identitytoolkit.googleapis.com/*" }, { urlPattern: "https://securetoken.googleapis.com/*" }];
  await b.send("Fetch.enable", { patterns });
  b.on((m) => { if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "service_worker") b.send("Fetch.enable", { patterns }, m.params.sessionId); });
  await b.send("Browser.grantPermissions", { permissions: ["notifications"], origin: SITE });
  await b.open(`${SITE}/#social`, 1500);
  await b.ev(`(() => { localStorage.setItem('fifteam-social-me', ${JSON.stringify(ph)}); localStorage.setItem('fifteam-social-name', ${JSON.stringify(name)}); localStorage.setItem('fifteam-account', JSON.stringify({ email: ${JSON.stringify(ph + "@example.com")}, uid: ${JSON.stringify(ph)}, token: ${JSON.stringify("rf-" + ph)}, fid: ${JSON.stringify("fid" + ph)}, at: Date.now(), checked: Date.now() })); return 1; })()`);
  await b.open(`${SITE}/?go#social`, 3500);
  b.until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await b.ev(expr).catch(() => false)) return Date.now() - t; await sleep(50); } return -1; };
  return b;
}

let A = null, B = null;
try {
  for (let i = 0; i < 120; i++) { try { await fetch(WK + "/"); break; } catch { await sleep(1000); } }
  A = await phone(alice, "Alice"); B = await phone(ben, "Ben");
  // both phones put their message keys on their profiles (through the server)
  const keyed = async () => { const p = (await hubStore("index")).d.profiles; return !!(p[alice] && p[alice].pk && p[ben] && p[ben].pk); };
  for (let i = 0; i < 60 && !(await keyed()); i++) await sleep(250);
  check(await keyed(), "both phones' profiles saved through the server");
  if (!(await keyed())) { log("profiles on the server:", JSON.stringify((await hubStore("index")).d.profiles).slice(0, 300)); log("Alice's errors:", A.errors.join(" | ").slice(0, 800)); }
  const live = (await A.until(`import('./js/hub.js').then(m => m.live.on)`, 8000)) >= 0 && (await B.until(`import('./js/hub.js').then(m => m.live.on)`, 8000)) >= 0;
  check(live, "both phones have a live connection to the server");
  const feed = await A.until(`!!document.querySelector('#so-body .so-post img.so-img')`, 10000);
  log("Alice's feed with its picture:", feed >= 0 ? "shown" : "not shown");
  check(feed >= 0, "the feed and its picture load through the server");
  direct.length = 0;

  // Ben messages Alice: it reaches her phone at once (no checking every few seconds)
  await B.ev(`import('./js/dms.js').then(m => m.openChat(${JSON.stringify(alice)})).then(() => 1)`);
  await B.until(`!!document.querySelector('#sheet-panel .dm-form')`, 5000);
  await B.ev(`(() => { const f = document.querySelector('#sheet-panel .dm-form'); f.querySelector('input').value = 'hey Alice, nice picture'; f.requestSubmit(); return 1; })()`);
  const sentAt = Date.now();
  const arrived = await A.until(`!document.getElementById('dm-badge').hidden && document.getElementById('dm-badge').textContent === '1'`, 10000);
  log(`Ben's message on Alice's phone (her badge) after ${arrived < 0 ? "never" : Date.now() - sentAt + " ms"}`);
  check(arrived >= 0 && Date.now() - sentAt < 4000, "a message reaches the other phone within a few seconds, by itself");
  // Messages opens at once, and the chat with it
  let t0 = Date.now();
  await A.ev(`document.getElementById('btn-dms').click(), 1`);
  const inbox = await A.until(`[...document.querySelectorAll('#sheet-panel .dm-row')].some(r => r.textContent.includes('Ben'))`, 10000);
  const inboxMs = Date.now() - t0;
  t0 = Date.now();
  if (inbox >= 0) await A.ev(`[...document.querySelectorAll('#sheet-panel .dm-row')].find(r => r.textContent.includes('Ben')).click(), 1`);
  const chat = await A.until(`[...document.querySelectorAll('#sheet-panel .dm-bubble')].some(b => b.textContent.includes('nice picture'))`, 10000);
  const chatMs = Date.now() - t0;
  log(`Alice taps Messages: the list in ${inboxMs} ms; taps Ben: the message in ${chatMs} ms`);
  check(inbox >= 0 && inboxMs < 1500 && chat >= 0 && chatMs < 1500, "Messages and the chat open in well under two seconds");
  await A.ev(`(() => { const f = document.querySelector('#sheet-panel .dm-form'); f.querySelector('input').value = 'thanks Ben!'; f.requestSubmit(); return 1; })()`);
  const back = await B.until(`[...document.querySelectorAll('#sheet-panel .dm-bubble')].some(b => b.textContent.includes('thanks Ben'))`, 8000);
  log(`Alice's reply in Ben's open chat after ${back} ms`);
  check(back >= 0 && back < 4000, "a reply shows in the open chat within seconds");
  log("requests the phones made straight to the feed service meanwhile:", direct.length ? direct.join(", ") : "none");
  check(!direct.some((x) => x.startsWith("GET")), "no reading the feed service directly: everything comes from the server");
  await A.ev(`document.getElementById('sheet').classList.remove('open'), 1`);

  // push notifications: Alice's phone signs up; with her app put away, Ben's message comes as a real push
  await A.ev(`(() => {
    const sub = { endpoint: ${JSON.stringify(aliceSub.endpoint)}, toJSON() { return ${JSON.stringify(aliceSub)}; }, unsubscribe: async () => true };
    let has = null; PushManager.prototype.getSubscription = async function () { return has; }; PushManager.prototype.subscribe = async function () { has = sub; return sub; };
    return 1; })()`);
  await A.ev(`import('./js/push.js').then(m => m.syncPush(true)).then(() => 1)`);
  log("Alice's push sign-up:", await A.ev(`localStorage.getItem('fifteam-push') ? 'sent' : 'not sent'`));
  await A.ev(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); return 1; })()`);
  await sleep(500);
  pushes.length = 0;
  await B.ev(`(() => { const f = document.querySelector('#sheet-panel .dm-form'); f.querySelector('input').value = 'you there?'; f.requestSubmit(); return 1; })()`);
  t0 = Date.now();
  for (let i = 0; i < 80 && !pushes.length; i++) await sleep(100);
  const p1 = pushes[0] ? openPush(pushes[0].body) : null;
  log(`push to Alice's phone after ${pushes.length ? Date.now() - t0 : "-"} ms:`, JSON.stringify(p1));
  check(!!p1 && p1.title === "Ben" && p1.body === "Sent you a message" && p1.data.dm === ben, "app put away: Ben's message arrives as a real push notification");
  // her app's service worker shows it (delivered the way the phone's push service would)
  const regs = [];
  A.on((m) => { if (m.method === "ServiceWorker.workerRegistrationUpdated") regs.push(...m.params.registrations); });
  await A.send("ServiceWorker.enable"); await sleep(800);
  const reg = regs.find((r) => r.scopeURL.startsWith(SITE));
  if (reg && p1) await A.send("ServiceWorker.deliverPushMessage", { origin: SITE, registrationId: reg.registrationId, data: JSON.stringify(p1) });
  await sleep(1200);
  const shown = await A.ev(`navigator.serviceWorker.ready.then(r => r.getNotifications()).then(n => n.map(x => x.title + ': ' + x.body + ' (' + (x.data && x.data.dm) + ')').join(' | '))`);
  log("notifications on Alice's phone:", shown || "none");
  check(shown.includes(`Ben: Sent you a message (${ben})`), "her phone shows it as a notification (a tap opens that chat)");
  // a comment on her post: a push too
  pushes.length = 0;
  await B.ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
  await B.ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.dataset.id === ${JSON.stringify(post1)}).querySelector('.so-cbtn').click(), 1`);
  await B.until(`!!document.querySelector('#sheet-panel .cs-row input')`, 5000);
  await B.ev(`(() => { const i = document.querySelector('#sheet-panel .cs-row input'); i.value = 'this goes hard'; i.closest('form').requestSubmit(); return 1; })()`);
  for (let i = 0; i < 80 && !pushes.length; i++) await sleep(100);
  const p2 = pushes[0] ? openPush(pushes[0].body) : null;
  log("Ben comments; push to Alice:", JSON.stringify(p2));
  check(!!p2 && p2.title === "Ben" && p2.body === "Commented: this goes hard" && p2.data.post === post1, "a comment on her post notifies her");
  await A.ev(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); return 1; })()`);

  // unlimited rebassing: 10 songs this hour, then the unlock sheet; the owner told; /premium; unlocked live
  await A.ev(`(() => { localStorage.setItem('fifteam-rebass-hour', JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ k: 'song' + i, at: Date.now() - i * 1000 })))); return 1; })()`);
  await A.ev(`location.reload(), 1`); await sleep(3500);
  const lim = await A.ev(`import('./js/premium.js').then(m => JSON.stringify({ again: m.rebassAllowed('song3'), next: m.rebassAllowed('a new song'), left: m.leftThisHour() }))`);
  log("after 10 songs this hour:", lim);
  check(lim === '{"again":true,"next":false,"left":0}', "10 songs an hour: the same song again is fine, an eleventh isn't");
  await A.ev(`import('./js/premium.js').then(m => { m.openUnlock(); return 1; })`); await sleep(500);
  const sj = JSON.parse(await A.ev(`(() => { const p = document.getElementById('sheet-panel'); const a = p.querySelector('.pm-pay'); return JSON.stringify({ text: p.textContent.replace(/ +/g, ' ').slice(0, 300), href: a && a.href }); })()`));
  log("the unlock sheet:", JSON.stringify(sj));
  check(/\$10/.test(sj.text) && /Alice/.test(sj.text) && sj.href === "https://www.paypal.com/paypalme/lnewman21s/10USD", "the unlock sheet: $10 once, PayPal, and her username for the note");
  await A.ev(`(() => { const a = document.querySelector('#sheet-panel .pm-pay'); a.addEventListener('click', (e) => e.preventDefault()); a.click(); return 1; })()`);
  for (let i = 0; i < 40 && !posted.some((p) => /wants Premium/.test(p.content || "")); i++) await sleep(150);
  log("the owner was told:", (posted.find((p) => /unlimited/.test(p.content || "")) || {}).content);
  check(posted.some((p) => /\*\*Alice\*\* wants Premium/.test(p.content || "")), "tapping Pay tells the owner who paid");
  await A.ev(`document.getElementById('sheet').classList.remove('open'), 1`);
  await signed(JSON.stringify({ type: 2, id: "2", token: "t2", application_id: "app1", data: { name: "premium", options: [{ name: "user", value: alice }] }, member: { user: { id: "1", username: "owner" } } }));
  t0 = Date.now();
  const unlocked = await A.until(`import('./js/premium.js').then(m => m.rebassAllowed('a new song'))`, 10000);
  const toastNow = await A.ev(`document.getElementById('toast').textContent`);
  log(`/premium Alice: unlocked on her phone after ${unlocked < 0 ? "never" : Date.now() - t0 + " ms"} | toast: ${toastNow}`);
  check(unlocked >= 0 && /unlocked/i.test(toastNow), "/premium unlocks her phone at once, with a thank-you");
  if (unlocked < 0) { log("bot replied:", replies.map((r) => { try { return JSON.parse(r).content; } catch { return r.slice(0, 200); } }).join(" | ")); log("mod on the server:", JSON.stringify((await hubStore("mod")).d)); log("her phone's premium list:", await A.ev(`localStorage.getItem('fifteam-bans-premium')`), "| live:", await A.ev(`import('./js/hub.js').then(m => m.live.on)`)); }
  // tags: /tag-founder Alice; everyone's feed shows it at once, on her new post and her old one (no phone id on it)
  await signed(JSON.stringify({ type: 2, id: "3", token: "t3", application_id: "app1", data: { name: "tag-founder", options: [{ name: "user", value: alice }] }, member: { user: { id: "1", username: "owner" } } }));
  const tagged = await B.until(`(() => { const t = (id) => { const c = document.querySelector('#so-body .so-post[data-id="' + id + '"]'); return c && c.querySelector('.so-head .tag-founder'); }; return !!(t(${JSON.stringify(post1)}) && t('900000000000000090')); })()`, 10000);
  log(`Ben's feed: Alice's founder tag after ${tagged} ms, on`, await B.ev(`[...document.querySelectorAll('#so-body .so-post')].filter(c => c.querySelector('.tag-founder')).map(c => c.querySelector('.so-text') ? c.querySelector('.so-text').textContent : c.dataset.id).join(' | ')`));
  check(tagged >= 0, "a tag shows for everyone at once, on new and old posts");
  await B.ev(`import('./js/profile.js').then(m => { m.openProfile({ by: ${JSON.stringify(alice)}, user: 'Alice' }); return 1; })`); await sleep(800);
  const pfTag = await B.ev(`(document.querySelector('#sheet-panel .pf-name .tag-founder') || {}).textContent || ''`);
  log("on her page:", pfTag);
  check(pfTag === "FifTeam Founder", "and on her page");
  // Ben reports Alice's post (the post's ⋯ menu), with a reason and his own words: it reaches #reports
  await B.ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
  await B.ev(`[...document.querySelectorAll('#so-body .so-post')].find(p => p.dataset.id === ${JSON.stringify(post1)}).querySelector('.so-more').click(), 1`); await sleep(400);
  const menu = await B.ev(`[...document.querySelectorAll('#sheet-panel .menu-item')].map(b => b.textContent).join(' | ')`);
  log("Ben's ⋯ on Alice's post:", menu);
  await B.ev(`document.querySelector('#sheet-panel .so-report').click(), 1`); await sleep(400);
  await B.ev(`(() => { [...document.querySelectorAll('#sheet-panel .rp-reason')].find(b => b.dataset.k === 'spam').click(); document.querySelector('#sheet-panel .rp-text').value = 'posting the same thing over and over'; document.querySelector('#sheet-panel .rp-send').click(); return 1; })()`);
  for (let i = 0; i < 60 && !reports.length; i++) await sleep(100);
  const toastR = await B.ev(`document.getElementById('toast').textContent`);
  log("in #reports:", (reports[0] || {}).content, "| Ben sees:", toastR);
  const rc = (reports[0] || {}).content || "";
  check(/Report: Spam/.test(rc) && rc.includes("Alice (`alicephone`)") && rc.includes("By:** Ben") && rc.includes("my first rebass picture") && rc.includes("posting the same thing over and over") && /Thanks/.test(toastR), "Ben's report reaches #reports with the reason, the post and his message");
  // ---------------------------------------------------------------- private posts, liked posts, shares, photos in messages
  await A.ev(`document.getElementById('sheet').classList.remove('open'), 1`); await B.ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(300);
  // Alice makes her post private: gone from Ben's feed and her page (as he sees it); in her own Private tab
  await A.ev(`import('./js/social.js').then(m => m.api.setPostPrivate(m.api.state.feed.find(p => p.id === ${JSON.stringify(post1)}), true)).then(() => 1)`);
  const goneForBen = await B.until(`![...document.querySelectorAll('#so-body .so-post')].some(p => p.dataset.id === ${JSON.stringify(post1)})`, 8000);
  await B.ev(`import('./js/profile.js').then(m => { m.openProfile({ by: ${JSON.stringify(alice)}, user: 'Alice' }); return 1; })`); await sleep(700);
  const benSeesHer = await B.ev(`document.getElementById('sheet-panel').textContent`);
  await A.ev(`import('./js/profile.js').then(m => { m.openProfile({ by: ${JSON.stringify(alice)}, user: 'Alice' }); return 1; })`); await sleep(700);
  await A.ev(`[...document.querySelectorAll('#sheet-panel .pf-seg button')].find(b => b.textContent.includes('Private')).click(), 1`); await sleep(400);
  const herPrivate = await A.ev(`[...document.querySelectorAll('#sheet-panel .pf-row')].map(r => r.textContent).join(' | ')`);
  log(`private: gone from Ben's feed after ${goneForBen} ms | Ben's view of her page has it: ${/1 song|Pics & videos · 1/.test(benSeesHer)} | her Private tab: ${herPrivate}`);
  check(goneForBen >= 0 && herPrivate.includes("my first rebass picture") && !/Private ·/.test(benSeesHer), "a private post: only she sees it, in her Private tab");
  // and public again, by holding it down there
  await A.ev(`document.querySelector('#sheet-panel .pf-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), 1`); await sleep(400);
  await A.ev(`document.querySelector('#sheet-panel .so-privacy').click(), 1`);
  const backForBen = await B.until(`(document.getElementById('sheet').classList.remove('open'), [...document.querySelectorAll('#so-body .so-post')].some(p => p.dataset.id === ${JSON.stringify(post1)}))`, 8000);
  log(`held down, made public: back in Ben's feed after ${backForBen} ms`);
  check(backForBen >= 0, "held down on her page: public again");
  // Ben likes it; his likes are his own unless he shows them
  await B.ev(`document.querySelector('#so-body .so-post[data-id="${post1}"] .so-like').click(), 1`); await sleep(1200);
  const tabsOf = async () => { await A.ev(`import('./js/profile.js').then(m => { m.openProfile({ by: ${JSON.stringify(ben)}, user: 'Ben' }); return 1; })`); await sleep(700); return A.ev(`[...document.querySelectorAll('#sheet-panel .pf-seg button')].map(b => b.textContent).join(' | ')`); };
  const before = await tabsOf();
  await B.ev(`document.getElementById('btn-settings').click(), 1`); await sleep(500);
  await B.ev(`document.getElementById('set-lk').click(), 1`);
  for (let i = 0; i < 40 && !(((await hubStore("meta")).d.prefs || {})[ben] || {}).lk; i++) await sleep(200);
  await sleep(800);
  const after = await tabsOf();
  if (after.includes("Liked")) await A.ev(`[...document.querySelectorAll('#sheet-panel .pf-seg button')].find(b => b.textContent.includes('Liked')).click(), 1`);
  await sleep(300);
  const likedList = await A.ev(`[...document.querySelectorAll('#sheet-panel .pf-row')].map(r => r.textContent).join(' | ')`);
  log("Ben's page, as Alice sees it: before", JSON.stringify(before), "| after he shows his likes:", JSON.stringify(after), "|", likedList);
  check(!before.includes("Liked") && after.includes("♥ Liked · 1") && likedList.includes("Alice"), "liked posts: hidden by default; shown on his page once he switches it on");
  // an app from before 2.16 writing the feed and the settings can't undo a private post or the likes setting (the server keeps them)
  await A.ev(`import('./js/social.js').then(m => m.api.setPostPrivate(m.api.state.feed.find(p => p.id === ${JSON.stringify(post1)}), true)).then(() => 1)`);
  const ix = await hubStore("index"), oldFeed = { ...ix.d, posts: ix.d.posts.map(({ priv, shares, ...rest }) => rest) };
  const mt = await hubStore("meta"), oldMeta = { ...mt.d, prefs: Object.fromEntries(Object.entries(mt.d.prefs || {}).filter(([, v]) => v.dm !== "all" || v.priv)) };
  await fetch(`${WK}/v1/store/index?v=${ix.v}`, { method: "PUT", body: JSON.stringify(oldFeed) });
  await fetch(`${WK}/v1/store/meta?v=${mt.v}`, { method: "PUT", body: JSON.stringify(oldMeta) });
  const kept = { priv: (await hubStore("index")).d.posts.find((p) => p.id === post1).priv, lk: (((await hubStore("meta")).d.prefs || {})[ben] || {}).lk };
  log("after an older app's writes:", JSON.stringify(kept));
  check(kept.priv === 1 && kept.lk === 1, "an older app's write can't undo a private post or the likes setting");
  await A.ev(`import('./js/social.js').then(m => m.api.setPostPrivate(m.api.state.feed.find(p => p.id === ${JSON.stringify(post1)}), false)).then(() => 1)`); await sleep(800);
  // Ben shares her post (Send, to Alice herself): she hears about it
  await A.ev(`document.getElementById('sheet').classList.remove('open'), 1`); await B.ev(`document.getElementById('sheet').classList.remove('open'), 1`);
  await A.ev(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); return 1; })()`); await sleep(400);
  pushes.length = 0;
  await B.until(`[...document.querySelectorAll('#so-body .so-post')].some(p => p.dataset.id === ${JSON.stringify(post1)})`, 6000);
  await B.ev(`document.querySelector('#so-body .so-post[data-id="${post1}"] .so-send').click(), 1`);
  await B.until(`[...document.querySelectorAll('#sheet-panel .dm-row')].some(r => r.textContent.includes('Alice') && r.querySelector('button.primary'))`, 8000);
  await B.ev(`[...document.querySelectorAll('#sheet-panel .dm-row')].find(r => r.textContent.includes('Alice')).querySelector('button').click(), 1`);
  for (let i = 0; i < 80 && !pushes.some((p) => /Shared/.test(openPush(p.body).body)); i++) await sleep(100);
  const sh = pushes.map((p) => openPush(p.body)).find((n) => /Shared/.test(n.body));
  log("Ben shares her post; to Alice:", JSON.stringify(sh));
  check(!!sh && sh.title === "Ben" && sh.body === "Shared your post" && sh.data.post === post1, "a share notifies the post's owner");
  await A.ev(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); return 1; })()`);
  // a photo in a message: Ben picks one (the real picker), Alice sees it in the chat
  await B.ev(`document.getElementById('sheet').classList.remove('open'), 1`); await sleep(200);
  await B.ev(`import('./js/dms.js').then(m => m.openChat(${JSON.stringify(alice)})).then(() => 1)`);
  await B.until(`!!document.querySelector('#sheet-panel .dm-attach')`, 6000);
  // (the chat's header: their page, and ⋯ to report or block)
  await B.ev(`document.querySelector('#sheet-panel .dm-more').click(), 1`); await sleep(300);
  const moreMenu = await B.ev(`[...document.querySelectorAll('.dm-act .menu-item')].map(b => b.textContent).join(' | ')`);
  await B.ev(`[...document.querySelectorAll('.dm-act .menu-item')].find(b => b.textContent === 'Cancel').click(), 1`);
  log("the chat's ⋯:", moreMenu);
  check(moreMenu.includes("See their page") && moreMenu.includes("Report Alice") && moreMenu.includes("Block Alice"), "in a chat: ⋯ to see their page, report or block them");
  await B.send("Page.setInterceptFileChooserDialog", { enabled: true });
  let chooser = null; B.on((m) => { if (m.method === "Page.fileChooserOpened") chooser = m.params; });
  await B.ev(`document.querySelector('#sheet-panel .dm-attach').click(), 1`);
  for (let i = 0; i < 40 && !chooser; i++) await sleep(100);
  const picFile = join(dir, "photo.jpg");
  const png = await B.ev(`(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 320, 0); gr.addColorStop(0, '#2f78ff'); gr.addColorStop(1, '#bb4dff'); g.fillStyle = gr; g.fillRect(0, 0, 320, 240); g.fillStyle = '#fff'; g.font = 'bold 60px sans-serif'; g.fillText('FT', 110, 140); return c.toDataURL('image/jpeg', 0.9).split(',')[1]; })()`);
  writeFileSync(picFile, Buffer.from(png, "base64"));
  if (chooser) await B.send("DOM.setFileInputFiles", { backendNodeId: chooser.backendNodeId, files: [picFile] });
  await B.send("Page.setInterceptFileChooserDialog", { enabled: false });
  const sentPic = await B.until(`[...document.querySelectorAll('#sheet-panel .dm-bubble.me .dm-pic img')].some(i => i.naturalWidth > 0)`, 15000);
  await A.ev(`import('./js/dms.js').then(m => m.openChat(${JSON.stringify(ben)})).then(() => 1)`);
  const gotPic = await A.until(`[...document.querySelectorAll('#sheet-panel .dm-bubble.them .dm-pic img')].some(i => i.naturalWidth > 0)`, 15000);
  const size = await A.ev(`(() => { const i = [...document.querySelectorAll('#sheet-panel .dm-bubble.them .dm-pic img')].pop(); return i.naturalWidth + 'x' + i.naturalHeight; })()`);
  const bins = [...msgs.values()].flatMap((x) => (x.attachments || []).filter((a) => a.filename === "m.bin")).map((a) => files.get(new URL(a.url).pathname));
  const sealedOnServer = bins.length > 0 && bins.every((b) => b && !(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff));
  log(`photo: on Ben's side after ${sentPic} ms, on Alice's after ${gotPic} ms, ${size} | sent sealed: ${sealedOnServer}`);
  check(sentPic >= 0 && gotPic >= 0 && size === "320x240" && sealedOnServer, "a photo sent in a message, sealed, and seen in the chat");
  // the name in the chat opens their page
  await A.ev(`document.querySelector('#sheet-panel .dm-who').click(), 1`); await sleep(600);
  const pageOpen = await A.ev(`!!document.querySelector('#sheet-panel.pf-panel') && document.querySelector('#sheet-panel .pf-name').textContent`);
  log("Alice taps Ben's name in the chat:", pageOpen);
  check(/Ben/.test(pageOpen || ""), "tapping their name in a chat opens their page");
  log("errors:", [...A.errors, ...B.errors].filter((e) => !/favicon|ERR_|Failed to load resource/i.test(e)).join(" | ").slice(0, 600) || "none");
} catch (e) { log("STOPPED:", e.stack); fails++; }
finally {
  try { if (A) A.close(); if (B) B.close(); } catch {}
  srv.close(); site.kill();
  spawn("taskkill", ["/pid", String(dev.pid), "/t", "/f"], { stdio: "ignore", shell: true });
  if (fails && /error|✘/i.test(out)) log("wrangler said:" + NL + out.split(NL).filter((l) => /error|✘|exception/i.test(l)).slice(0, 12).join(NL));
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0); }, 1500);
}
