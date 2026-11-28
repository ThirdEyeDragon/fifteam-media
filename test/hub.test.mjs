// node test/hub.test.mjs - the FifTeam server (tools/bot/hub.mjs and worker.mjs) in Cloudflare's own runtime on this PC
// (wrangler dev), against stand-ins served here: the feed service, its files, Firebase's signing keys, a push service
// and Discord's reply address. Checks: the stores in one request, changes taken only on the latest version, nothing
// for phones to write in the bot's stores, the copy back to the feed service, what an older app writes there merged in,
// the live connection, push notifications (encrypted for the phone, checked here by decrypting them), no push while the
// app is on screen, files for many posts at once, the unlock request, and the bot's /premium through the server.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createSign, createECDH, createHmac, createDecipheriv, randomBytes, sign as edSign, createPublicKey, verify as cverify } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), BOT = join(HERE, "..", "tools", "bot");
const P = 8795, W = 8796, ST = `http://127.0.0.1:${P}`, WK = `http://127.0.0.1:${W}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what) => { console.log(`  ${ok ? "ok" : "FAIL"}: ${what}`); if (!ok) fails++; };
const b64u = (b) => Buffer.from(b).toString("base64url");

// ---------------------------------------------------------------------------------------------------- the stand-ins
const HOOK = "111", TOKEN = "hooktoken", PROJECT = "test-proj";
const msgs = new Map(), files = new Map(), pushes = [], replies = [], posted = [], payments = [], reports = [];
let nextId = 900000000000001000;
const attach = (id, name, text) => { const url = `https://cdn.discordapp.com/attachments/1/${id}/${name}?ex=${Math.floor(Date.now() / 1000 + 86400).toString(16)}&is=0&hm=${Math.random().toString(16).slice(2)}`; files.set(`/attachments/1/${id}/${name}`, Buffer.from(text)); return { id: String(Math.random()).slice(2), filename: name, url }; };
const store = (id, name, data) => msgs.set(id, { id, attachments: [attach(id, name, JSON.stringify(data))] });
const read = (id) => { const a = msgs.get(id).attachments[0]; return JSON.parse(files.get(new URL(a.url).pathname).toString()); };
const IDS = { index: "900000000000000001", dm: "900000000000000002", meta: "900000000000000003", presence: "900000000000000004", mod: "900000000000000005", links: "900000000000000006", market: "900000000000000007", accounts: "900000000000000008" };
const alice = "alicephone1", ben = "benphone001";
const post1 = "900000000000000100", pic = "900000000000000200";
store(IDS.index, "feed.json", { v: 1, posts: [{ id: post1, at: Date.now() - 60e3, user: "Alice", by: alice, text: "my rebass", likes: [], comments: [], image: true }], profiles: { [alice]: { name: "Alice", at: 1 }, [ben]: { name: "Ben", at: 1 } } });
store(IDS.dm, "dm.json", { v: 1, msgs: [] });
store(IDS.meta, "meta.json", { v: 1, votes: {}, follows: {}, about: {} });
store(IDS.presence, "presence.json", { v: 1, on: {} });
store(IDS.mod, "mod.json", { v: 1, bans: {}, nopic: {}, badges: {} });
store(IDS.links, "links.json", { v: 1, links: {} });
store(IDS.market, "market.json", { v: 1, items: [] });
store(IDS.accounts, "accounts.json", { v: 1, a: {} });
msgs.set(post1, { id: post1, attachments: [attach(post1, "picture.jpg", "jpeg-bytes")] });
msgs.set(pic, { id: pic, attachments: [attach(pic, "avatar.jpg", "jpeg")] });

// Firebase: tokens signed with a test key (the server checks them against these keys)
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
function idToken(phone, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })), p = b64u(JSON.stringify({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: "uid-" + phone, iat: now, exp: now + 3600, name: "ft:" + phone, email: phone + "@example.com", email_verified: true, ...extra }));
  const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(rsa.privateKey);
  return `${h}.${p}.${b64u(s)}`;
}
// the notifications' keys (VAPID), Discord's (Ed25519), and the bot's (ECDH, for sealed emails)
const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidJwk = await crypto.subtle.exportKey("jwk", vapid.privateKey);
const vapidPub = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", vapid.publicKey)));
const ed = generateKeyPairSync("ed25519"), edPub = ed.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const botKey = await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"])).privateKey);
// a phone's push sign-up (a browser's keys)
function browserSub(name) { const e = createECDH("prime256v1"); e.generateKeys(); const auth = randomBytes(16); return { ecdh: e, auth, sub: { endpoint: `${ST}/push/${name}`, keys: { p256dh: b64u(e.getPublicKey()), auth: b64u(auth) } } }; }
/** A push, opened the way a browser does (RFC 8291). */
function openPush(b, body) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const shared = b.ecdh.computeSecret(asPub), ua = b.ecdh.getPublicKey();
  const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
  const ikm = hmac(hmac(b.auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1; while (end > 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error("no last-record mark");
  return JSON.parse(plain.subarray(0, end).toString());
}
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
const cfg = { hook: HOOK, key: Buffer.from(TOKEN.split("").reverse().join("")).toString("base64"), ...IDS, auth: "x.y", firebase: { apiKey: "k", projectId: PROJECT }, push: vapidPub, api: WK };
const srv = createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const body = Buffer.concat(chunks), u = new URL(req.url, ST), send = (code, obj, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(typeof obj === "string" || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); };
    if (u.pathname === "/config.json") return send(200, cfg);
    if (u.pathname === "/jwks") return send(200, { keys: [jwk] });
    if (u.pathname.startsWith("/cdn/")) { const f = files.get(u.pathname.slice(4)); return f ? send(200, f, "application/octet-stream") : send(404, "no"); }
    if (u.pathname.startsWith("/push/")) { pushes.push({ to: u.pathname.slice(6), headers: req.headers, body }); return send(u.pathname.endsWith("gone") ? 410 : 201, ""); }
    if (u.pathname === "/api/v10/attachments/refresh-urls") { const { attachment_urls } = JSON.parse(body.toString()); return send(200, { refreshed_urls: attachment_urls.map((x) => ({ original: x, refreshed: x.replace(/ex=[0-9a-f]+/, "ex=" + Math.floor(Date.now() / 1000 + 86400).toString(16)) })) }); }
    if (u.pathname.startsWith("/api/v10/webhooks/app1/")) { replies.push({ method: req.method, body: body.toString() }); return send(200, {}); }
    if (u.pathname === "/api/v10/guilds/1/channels") return send(200, [{ id: "50", type: 0, name: "general" }, { id: "51", type: 0, name: "payments" }, { id: "52", type: 0, name: "reports" }]);
    if (u.pathname === "/api/v10/channels/52/messages" && req.method === "POST") { reports.push(JSON.parse(body.toString())); return send(200, { id: "2" }); }
    if (u.pathname === "/api/v10/channels/51/messages" && req.method === "POST") { payments.push({ auth: req.headers.authorization, ...JSON.parse(body.toString()) }); return send(200, { id: "1" }); }
    const base = `/api/v10/webhooks/${HOOK}/${TOKEN}`;
    if (!u.pathname.startsWith(base)) return send(404, { message: "Unknown Webhook" });
    const rest = u.pathname.slice(base.length), m = /^\/messages\/(\d+)$/.exec(rest);
    if (req.method === "GET" && rest === "") return send(200, { guild_id: "1" });
    if (req.method === "GET" && m) return msgs.has(m[1]) ? send(200, msgs.get(m[1])) : send(404, { message: "Unknown Message" });
    if (req.method === "DELETE" && m) { msgs.delete(m[1]); return send(204, ""); }
    if (req.method === "PATCH" && m) { const parts = multipart(body, req.headers["content-type"]); const f = parts["files[0]"]; msgs.set(m[1], { id: m[1], attachments: [attach(m[1], f.filename, f.data)] }); return send(200, msgs.get(m[1])); }
    if (req.method === "POST" && rest === "") { const id = String(nextId++); const j = /json/.test(req.headers["content-type"] || "") ? JSON.parse(body.toString()) : {}; posted.push(j); msgs.set(id, { id, content: j.content, attachments: [] }); return send(200, msgs.get(id)); }
    send(405, {});
  });
}).listen(P);

// ---------------------------------------------------------------------------------------------------- the server
const dir = mkdtempSync(join(tmpdir(), "ft-hub-"));
for (const f of ["core.mjs", "hub.mjs", "worker.mjs"]) copyFileSync(join(BOT, f), join(dir, f));
writeFileSync(join(dir, "wrangler.toml"), `name = "fifteam-hub-test"\nmain = "worker.mjs"\ncompatibility_date = "2025-06-01"\n[[durable_objects.bindings]]\nname = "HUB"\nclass_name = "Hub"\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["Hub"]\n`);
writeFileSync(join(dir, ".dev.vars"), [`PUBLIC_KEY=${edPub}`, `CONFIG_URL=${ST}/config.json`, `DISCORD_API=${ST}/api/v10`, `CDN_BASE=${ST}/cdn`, `FIREBASE_JWKS=${ST}/jwks`, `REPLY_API=${ST}/api/v10`, `BOT_TOKEN=test`, `VAPID_KEY='${JSON.stringify(vapidJwk)}'`, `BOT_KEY='${JSON.stringify(botKey)}'`].join("\n") + "\n");
const dev = spawn("npx", ["-y", "wrangler@4", "dev", "--port", String(W), "--ip", "127.0.0.1", "--persist-to", join(dir, "state"), "--test-scheduled"], { cwd: dir, shell: true, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; dev.stdout.on("data", (d) => (out += d)); dev.stderr.on("data", (d) => (out += d));
const api = (path, opt = {}) => fetch(WK + path, opt);
const stores = async (k, have = "") => (await (await api(`/v1/stores?k=${k}${have ? "&have=" + have : ""}`)).json()).s;
const put = (k, v, d) => api(`/v1/store/${k}${v == null ? "" : "?v=" + v}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150); } return false; };
const signed = (body) => { const ts = String(Math.floor(Date.now() / 1000)); return api("/", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature-Ed25519": edSign(null, Buffer.from(ts + body), ed.privateKey).toString("hex"), "X-Signature-Timestamp": ts }, body }); };

try {
  for (let i = 0; i < 120; i++) { try { await fetch(WK + "/"); break; } catch { await sleep(1000); } }

  // the stores, several in one request
  let t0 = Date.now();
  const s1 = await stores("index,dm,meta,mod");
  console.log("first read (from the feed service):", Date.now() - t0, "ms |", Object.entries(s1).map(([k, x]) => `${k} v${x.v}`).join(", "));
  check(s1.index.d.posts[0].text === "my rebass" && Array.isArray(s1.dm.d.msgs) && s1.mod.v === 1, "four stores in one request");
  t0 = Date.now(); const s2 = await stores("index,dm,meta,mod", "index:1,dm:1,meta:1,mod:1"); const again = Date.now() - t0;
  console.log("read again (all unchanged):", again, "ms |", JSON.stringify(s2));
  check(!("d" in s2.index) && !("d" in s2.dm) && s2.dm.v === 1, "unchanged stores come back as just their version");

  // a change taken on the latest version only; the bot's stores closed to phones
  const dm1 = { v: 1, msgs: [{ id: "msg0000001", f: ben, t: alice, at: Date.now(), iv: "iv", c: "sealed" }], del: [] };
  const w1 = await put("dm", 1, dm1); const w1j = await w1.json();
  const w2 = await put("dm", 1, dm1); const w2j = await w2.json();
  console.log("write on v1:", w1.status, JSON.stringify(w1j), "| again on v1:", w2.status, JSON.stringify(w2j));
  check(w1.status === 200 && w1j.v === 2 && w2.status === 409 && w2j.conflict && w2j.v === 2, "a change on an old copy is refused (read again, change again)");
  const m1 = await put("mod", 1, { bans: { [alice]: { at: 1 } } }), m2 = await put("dm", null, dm1);
  check(m1.status === 403 && m2.status === 428, "phones can't write bans, and every change says which copy it was made on");
  check(await until(() => read(IDS.dm).msgs.length === 1, 6000), "copied back to the feed service within a few seconds");

  // what an app from before the server writes to the feed service directly: merged in
  store(IDS.dm, "dm.json", { v: 1, msgs: [...read(IDS.dm).msgs, { id: "oldapp0001", f: alice, t: ben, at: Date.now(), iv: "iv", c: "from-an-old-app" }] });
  await api("/__scheduled?cron=*/30+*+*+*+*");
  const merged = await until(async () => (await stores("dm")).dm.d.msgs.some((m) => m.id === "oldapp0001"), 8000);
  const now = (await stores("dm")).dm;
  console.log("after an older app wrote directly:", now.d.msgs.map((m) => m.id).join(", "), `(v${now.v})`);
  check(merged && now.d.msgs.some((m) => m.id === "msg0000001"), "what an older app wrote is merged in, nothing lost");

  // the live connection, and notifications
  const ws = new WebSocket(WK.replace("http", "ws") + "/v1/live"), heard = [];
  ws.onmessage = (e) => heard.push(JSON.parse(e.data));
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: "hi", tk: idToken(alice), vis: true }));
  await until(() => heard.some((x) => x.t === "ok"));
  console.log("live: signed in as Alice:", JSON.stringify(heard.find((x) => x.t === "ok")));
  const bad = await api("/v1/push", { method: "POST", body: JSON.stringify({ tk: idToken(alice).slice(0, -6) + "AAAAAA", sub: browserSub("x").sub }) });
  const expired = await api("/v1/push", { method: "POST", body: JSON.stringify({ tk: idToken(alice, { exp: 1 }), sub: browserSub("x").sub }) });
  const other = await api("/v1/push", { method: "POST", body: JSON.stringify({ tk: idToken(alice, { aud: "someone-else" }), sub: browserSub("x").sub }) });
  console.log("push sign-up with a forged token:", bad.status, "| expired:", expired.status, "| for another app:", other.status);
  check(bad.status === 401 && expired.status === 401 && other.status === 401, "push sign-ups need real proof of the account");
  const aliceB = browserSub("alice"), goneB = browserSub("gone");
  const ok = await api("/v1/push", { method: "POST", body: JSON.stringify({ tk: idToken(alice), sub: aliceB.sub, prefs: { msg: true, act: true } }) });
  await api("/v1/push", { method: "POST", body: JSON.stringify({ tk: idToken(alice), sub: goneB.sub }) });
  check(ok.status === 200, "Alice signs up for notifications");
  // Alice on screen: Ben's message comes over the live connection, not as a push
  let cur = (await stores("dm")).dm;
  heard.length = 0; pushes.length = 0;
  await put("dm", cur.v, { ...cur.d, msgs: [...cur.d.msgs, { id: "msg0000002", f: ben, t: alice, at: Date.now(), iv: "iv", c: "x" }] });
  await until(() => heard.some((x) => x.t === "note"), 4000);
  console.log("Alice on screen, heard:", heard.map((x) => x.t === "v" ? `v ${x.k} ${x.v} to ${x.to}` : `${x.t}: ${x.title} / ${x.body}`).join(" | "), "| pushes:", pushes.length);
  check(heard.some((x) => x.t === "v" && x.k === "dm" && x.to.includes(alice) && x.to.includes(ben)) && heard.some((x) => x.t === "note" && x.title === "Ben") && !pushes.length, "on screen: told at once over the live connection, no push");
  // Alice's app put away: a real push, encrypted for her phone
  ws.send(JSON.stringify({ t: "vis", vis: false })); await sleep(300);
  cur = (await stores("dm")).dm; pushes.length = 0;
  t0 = Date.now();
  await put("dm", cur.v, { ...cur.d, msgs: [...cur.d.msgs, { id: "msg0000003", f: ben, t: alice, at: Date.now(), iv: "iv", c: "x" }] });
  await until(() => pushes.filter((p) => p.to === "alice").length, 5000);
  const pa = pushes.find((p) => p.to === "alice");
  const note = pa ? openPush(aliceB, pa.body) : null;
  const auth = pa ? /vapid t=([^,]+), k=(.+)/.exec(pa.headers.authorization) : null;
  const [jh, jc, js] = auth ? auth[1].split(".") : [];
  const jwtOk = auth ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vapid.publicKey, Buffer.from(js, "base64url"), Buffer.from(`${jh}.${jc}`)) : false;
  console.log(`push to Alice after ${Date.now() - t0} ms:`, JSON.stringify(note), "| encoding:", pa && pa.headers["content-encoding"], "| signed by the app's key:", jwtOk, "| audience:", jc && JSON.parse(Buffer.from(jc, "base64url")).aud);
  check(note && note.title === "Ben" && note.body === "Sent you a message" && note.data.dm === ben && pa.headers["content-encoding"] === "aes128gcm" && jwtOk && auth[2] === vapidPub, "app closed: a real push, encrypted for her phone (opened here), signed with the app's key");
  check(await until(() => pushes.some((p) => p.to === "gone")) && true, "the push service said one sign-up is gone (it's dropped)");
  pushes.length = 0;
  cur = (await stores("dm")).dm;
  await put("dm", cur.v, { ...cur.d, msgs: [...cur.d.msgs, { id: "msg0000004", f: ben, t: alice, at: Date.now(), iv: "iv", c: "x" }] });
  await until(() => pushes.length, 3000);
  check(pushes.length === 1 && pushes[0].to === "alice", "and isn't sent to again");
  // a comment and a like on Alice's post; a follow
  pushes.length = 0;
  const ix = (await stores("index")).index;
  ix.d.posts[0].likes = [ben]; ix.d.posts[0].comments = [{ id: "c1", by: ben, user: "Ben", text: "fire bass", at: Date.now(), likes: [] }];
  await put("index", ix.v, ix.d);
  await until(() => pushes.length >= 2, 5000);
  const acts = pushes.map((p) => openPush(aliceB, p.body)).map((n) => `${n.title}: ${n.body}`);
  const mt = (await stores("meta")).meta; mt.d.follows = { [ben]: [alice] };
  pushes.length = 0; await put("meta", mt.v, mt.d); await until(() => pushes.length, 4000);
  acts.push(...pushes.map((p) => openPush(aliceB, p.body)).map((n) => `${n.title}: ${n.body}`));
  console.log("Alice's activity notifications:", acts.join(" | "));
  check(acts.includes("Ben: Liked your post") && acts.includes("Ben: Commented: fire bass") && acts.includes("Ben: Started following you"), "likes, comments and follows notify the owner");
  // messages switched off in her notifications: none for messages, still for activity
  await api("/v1/push", { method: "POST", body: JSON.stringify({ tk: idToken(alice), sub: aliceB.sub, prefs: { msg: false, act: true } }) });
  cur = (await stores("dm")).dm; pushes.length = 0;
  await put("dm", cur.v, { ...cur.d, msgs: [...cur.d.msgs, { id: "msg0000005", f: ben, t: alice, at: Date.now(), iv: "iv", c: "x" }] });
  await sleep(1500);
  check(!pushes.length, "message notifications off: no push for a message");

  // files for many posts at once (a deleted one says so)
  t0 = Date.now();
  const fr = await (await api("/v1/files", { method: "POST", body: JSON.stringify({ ids: [post1, pic, "900000000000009999"] }) })).json();
  console.log("files:", Date.now() - t0, "ms |", JSON.stringify(Object.fromEntries(Object.entries(fr.files).map(([k, v]) => [k, v && v.map((a) => a.filename)]))));
  check(fr.files[post1][0].filename === "picture.jpg" && fr.files[pic][0].filename === "avatar.jpg" && fr.files["900000000000009999"] === null, "files for three posts in one request; a deleted one is null");
  t0 = Date.now(); await api("/v1/files", { method: "POST", body: JSON.stringify({ ids: [post1, pic] }) }); const fast = Date.now() - t0;
  check(fast < 400, `and from the server's own copy the second time (${fast} ms)`);

  // unlimited rebassing: Ben taps Pay; the owner is told; /premium unlocks him (through the server)
  const pr = await api("/v1/premium", { method: "POST", body: JSON.stringify({ tk: idToken(ben) }) });
  await until(() => payments.some((p) => /wants Premium/.test(p.content || "")));
  console.log("unlock asked:", pr.status, "| in #payments:", (payments[0] || {}).content, "| as the bot:", (payments[0] || {}).auth === "Bot test");
  check(pr.status === 200 && payments.some((p) => /\*\*Ben\*\* wants Premium/.test(p.content || "")) && !posted.some((p) => /unlimited/.test(p.content || "")), "tapping Pay tells the owner in #payments who to look for");
  const r1 = await signed(JSON.stringify({ type: 2, id: "1", token: "t1", application_id: "app1", data: { name: "premiums" }, member: { user: { id: "1", username: "owner" } } }));
  await until(() => replies.length >= 1, 8000);
  console.log("/premiums:", r1.status, (JSON.parse(replies[0].body).content || "").replace(/\n/g, " / "));
  await signed(JSON.stringify({ type: 2, id: "2", token: "t2", application_id: "app1", data: { name: "premium", options: [{ name: "user", value: "Ben" }] }, member: { user: { id: "1", username: "owner" } } }));
  await until(() => replies.length >= 2, 8000);
  const modNow = (await stores("mod")).mod.d;
  console.log("/premium Ben:", (JSON.parse(replies[1].body).content || "").slice(0, 80), "| in the bans store:", JSON.stringify(modNow.premium));
  check(/asked: \*\*Ben\*\*/.test(JSON.parse(replies[0].body).content) && modNow.premium && modNow.premium[ben] && heard.some((x) => x.t === "v" && x.k === "mod"), "/premium unlocks him, and every open app hears it at once");
  check(await until(() => (read(IDS.mod).premium || {})[ben], 6000), "and it's copied back to the feed service");
  console.log("#payments after /premium:", payments.map((p) => p.content).join(" | "));
  check(payments.some((p) => /Unlocked Premium for \*\*Ben\*\* \(by <@1>\)/.test(p.content)), "the unlock is recorded in #payments, with who did it");
  // an app from before 2.16 (which drops what it doesn't know) can't undo a private post, its shares, or the likes setting
  { const ix = (await stores("index")).index; ix.d.posts[0].priv = 1; ix.d.posts[0].shares = [ben]; ix.d.posts[0].box = "eyJ2IjoxLCJ0eXBlIjoicG9ydGVkIn0"; await put("index", ix.v, ix.d);
    const now = (await stores("index")).index, old = { ...now.d, posts: now.d.posts.map(({ priv, shares, box, ...rest }) => rest) };
    pushes.length = 0;
    const w = await put("index", now.v, old);
    const after = (await stores("index")).index.d.posts[0];
    const mt = (await stores("meta")).meta; mt.d.prefs = { ...(mt.d.prefs || {}), [ben]: { dm: "all", priv: 0, lk: 1 } }; await put("meta", mt.v, mt.d);
    const m2 = (await stores("meta")).meta, oldMeta = { ...m2.d, prefs: {} }; await put("meta", m2.v, oldMeta);
    const lk = (((await stores("meta")).meta.d.prefs || {})[ben] || {}).lk;
    console.log("older app's write:", w.status, "| post after:", JSON.stringify({ priv: after.priv, shares: after.shares }), "| likes setting after:", lk);
    check(after.priv === 1 && JSON.stringify(after.shares) === JSON.stringify([ben]) && after.box === "eyJ2IjoxLCJ0eXBlIjoicG9ydGVkIn0" && lk === 1, "an older app's write keeps a post private, its shares, its sub box design, and the likes setting");
    // someone's setup (subs, amps, vehicle, dB): an app from before it leaves the whole thing out; it's kept
    const m3 = (await stores("meta")).meta; m3.d.setup = { ...(m3.d.setup || {}), [ben]: { subs: "2x 15 Skar VXF", db: 148.6 } }; await put("meta", m3.v, m3.d);
    const m4 = (await stores("meta")).meta, noSetup = { ...m4.d }; delete noSetup.setup; await put("meta", m4.v, noSetup);
    const su = ((await stores("meta")).meta.d.setup || {})[ben];
    console.log("setup after an older app's write:", JSON.stringify(su));
    check(su && su.subs === "2x 15 Skar VXF" && su.db === 148.6, "an older app's write keeps everyone's setup (subs, amps, vehicle, dB)");
    await sleep(400);
    check(pushes.length === 0, "and putting them back notifies nobody"); }
  // a share: the post's owner hears about it
  { await api("/v1/push", { method: "POST", body: JSON.stringify({ tk: idToken(alice), sub: aliceB.sub, prefs: { msg: true, act: true } }) });
    ws.send(JSON.stringify({ t: "vis", vis: false })); await sleep(200);
    const ix = (await stores("index")).index; ix.d.posts[0].shares = [ben, "carlphone1"]; pushes.length = 0;
    await put("index", ix.v, ix.d);
    await until(() => pushes.some((p) => p.to === "alice"), 4000);
    const n = pushes.filter((p) => p.to === "alice").map((p) => openPush(aliceB, p.body));
    console.log("share notification:", JSON.stringify(n));
    check(n.some((x) => x.body === "Shared your post" && x.data.post === post1), "sharing a post notifies its owner"); }
  // reports: to #reports, with the reason, the post and their own words; not about yourself; at most 8 an hour
  const rep = (tk, body) => api("/v1/report", { method: "POST", body: JSON.stringify({ tk, ...body }) });
  const r1s = (await rep(idToken(ben), { who: alice, reason: "harass", text: "she keeps posting <@everyone> spam about me", post: post1 })).status;
  await until(() => reports.length, 4000);
  console.log("report:", r1s, "| in #reports:", (reports[0] || {}).content);
  const rc = (reports[0] || {}).content || "";
  check(r1s === 200 && /Report: Harassment or bullying/.test(rc) && /\*\*Reported:\*\* Alice \(`alicephone1`\)/.test(rc) && /\*\*By:\*\* Ben/.test(rc) && /"my rebass"/.test(rc) && /keeps posting \\<\\@everyone\\> spam/.test(rc) && JSON.stringify(reports[0].allowed_mentions) === '{"parse":[]}', "a report reaches #reports: reason, who, the post, their message (no pings)");
  const self = (await rep(idToken(ben), { who: ben, reason: "spam" })).status, noReason = (await rep(idToken(ben), { who: alice, reason: "nope" })).status, forged = (await rep("x.y.z", { who: alice, reason: "spam" })).status;
  const many = []; for (let i = 0; i < 8; i++) many.push((await rep(idToken(ben), { who: alice, reason: "spam" })).status);
  console.log("yourself:", self, "| no reason:", noReason, "| no account:", forged, "| 8 more:", many.join(","));
  check(self === 400 && noReason === 400 && forged === 401 && many.slice(0, 7).every((x) => x === 200) && many[7] === 429, "not about yourself, needs a reason and an account, at most 8 an hour");

  // group chats: what each account may change, checked here (the app sends its account with a message write)
  const putAs = (who, v, d) => api(`/v1/store/dm?v=${v}`, { method: "PUT", headers: { "Content-Type": "application/json", ...(who ? { "X-FT-Auth": idToken(who) } : {}) }, body: JSON.stringify(d) });
  const kk = (b) => ({ b, iv: "aaaaaaaaaaaaaaaa", c: "c" + b });
  const grp = { id: "ghubtest0001", name: "Bass heads", by: alice, at: Date.now(), members: [alice, ben], admins: [alice], kv: 1, keys: { 1: { [alice]: kk(alice), [ben]: kk(alice) } } };
  cur = (await stores("dm")).dm;
  const g1 = await (await putAs(alice, cur.v, { ...cur.d, groups: [grp] })).json();
  cur = (await stores("dm")).dm;
  check(!g1.fixed && cur.d.groups.length === 1 && cur.d.groups[0].name === "Bass heads", "a group made by its owner, with its account: kept");
  const g2 = await (await putAs(ben, cur.v, { ...cur.d, groups: [{ ...grp, name: "Ben's now" }] })).json();
  cur = (await stores("dm")).dm;
  check(g2.fixed === true && cur.d.groups[0].name === "Bass heads", "a member (not an admin) renaming it: put back, and the phone told to read it again");
  heard.length = 0; pushes.length = 0;
  await api("/v1/push", { method: "POST", body: JSON.stringify({ tk: idToken(alice), sub: aliceB.sub, prefs: { msg: true, act: true } }) });
  const gm = { id: "groupmsg0001", f: ben, g: grp.id, kv: 1, at: Date.now(), iv: "iv", c: "x" };
  await putAs(ben, cur.v, { ...cur.d, msgs: [...cur.d.msgs, gm] });
  cur = (await stores("dm")).dm;
  const gotLive = await until(() => heard.some((x) => x.t === "v" && x.k === "dm" && x.to && x.to.includes(alice) && x.to.includes(ben)), 4000);
  await until(() => pushes.filter((p) => p.to === "alice").length, 5000);
  const gp = pushes.find((p) => p.to === "alice"), gnote = gp ? openPush(aliceB, gp.body) : null;
  console.log("group push to Alice:", JSON.stringify(gnote));
  check(cur.d.msgs.some((m) => m.id === gm.id) && gotLive && gnote && gnote.title === "Bass heads" && gnote.body === "Ben sent a message" && gnote.data.g === grp.id, "a member's message to the group: kept, both told live, and Alice (app closed) a push titled with the group's name");
  await putAs("", cur.v, { ...cur.d, msgs: [...cur.d.msgs, { ...gm, id: "groupmsg0002" }] });
  cur = (await stores("dm")).dm;
  await putAs(alice, cur.v, { v: 1, msgs: cur.d.msgs.filter((m) => !m.g), del: cur.d.del });
  cur = (await stores("dm")).dm;
  check(!cur.d.msgs.some((m) => m.id === "groupmsg0002") && cur.d.groups.length === 1 && cur.d.msgs.some((m) => m.id === gm.id), "no account: its group message dropped; a write leaving the groups out (an older app): they're put back");
  // a sealed file sent in a message (the file service won't let the app read a .bin from another site): passed through
  // the server, as it is, with the header the app needs; nothing else is
  const sealedId = "900000000000000777", sealedBytes = "sealed-song-bytes-" + "x".repeat(300);
  msgs.set(sealedId, { id: sealedId, attachments: [attach(sealedId, "song.bin", sealedBytes), attach(sealedId, "notes.txt", "hello")] });
  const sf = await api(`/v1/file?id=${sealedId}&name=song.bin`, { headers: { Origin: "https://thirdeyedragon.github.io" } });
  const sfBody = await sf.text();
  const sfOther = (await api(`/v1/file?id=${sealedId}&name=notes.txt`)).status, sfMissing = (await api(`/v1/file?id=${sealedId}&name=cover.bin`)).status;
  console.log("sealed file through the server:", sf.status, sf.headers.get("access-control-allow-origin"), sfBody.length, "bytes | another kind of file:", sfOther, "| not there:", sfMissing);
  check(sf.status === 200 && sf.headers.get("access-control-allow-origin") === "*" && sfBody === sealedBytes && sfOther === 400 && sfMissing === 404, "a song sent in a message (an older .bin) comes through the server as it is, readable by the app; only sealed message files");
  ws.close();
} catch (e) { console.log("STOPPED:", e.stack); fails++; }
finally {
  srv.close();
  spawn("taskkill", ["/pid", String(dev.pid), "/t", "/f"], { stdio: "ignore", shell: true });
  if (fails && /error|✘/i.test(out)) console.log("wrangler said:\n" + out.split("\n").filter((l) => /error|✘|exception/i.test(l)).slice(0, 12).join("\n"));
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0); }, 1500);
}
