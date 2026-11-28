// The FifTeam server (one Cloudflare Durable Object, free): the app's data in one place, close to everyone.
//   Stores: every store the app keeps (the feed, messages, votes and follows, check-ins, bans, file links, Audio Market,
//           accounts) held here, each with a version number. A phone reads any of them in one request, and changes one
//           by sending it back with the version it read: taken if nobody changed it since, otherwise the phone is told
//           to read it again (so two people liking at once can't write over each other). Every change is copied back to
//           its store message a couple of seconds later, so nothing is lost and apps from before the server still work
//           (what they write there is merged back in).
//   Files:  the current links to posts' pictures, videos and songs, for any number of posts in one request (renewed
//           here in bulk when they expire), so phones don't each have to ask for every post.
//   Live:   every open app keeps a connection here and hears at once when something changes (new messages, likes,
//           comments, posts, bans).
//   Push:   real notifications, with the app closed (Web Push): new messages; likes, comments, replies, follows and
//           requests. A phone signs up for them with proof of its account (a Firebase ID token, checked here).
//   Premium: "Get Premium" requests, noted here and told to the owner.
import { DurableObject } from "cloudflare:workers";

const API = "https://discord.com/api/v10";
const PHONE = /^[a-z0-9]{6,16}$/, POST = /^\d{5,25}$/;
// (the files a message can carry, sealed: a song and its cover, a picture or a video and its still)
const SEALED = /^(song|cover|m|p)(\.bin|-x\.mp4)$/;
export const STORES = { index: "feed.json", dm: "dm.json", meta: "meta.json", presence: "presence.json", mod: "mod.json", links: "links.json", market: "market.json", accounts: "accounts.json" };
const LABELS = {
  index: "FifTeam Social feed", dm: "FifTeam messages", meta: "FifTeam votes, follows and about", presence: "FifTeam who's online",
  market: "FifTeam Audio Market", accounts: "FifTeam accounts", mod: "FifTeam bans", links: "FifTeam file links",
};
const label = (k) => `${LABELS[k]} (${k === "mod" || k === "links" ? "kept by the FifTeam bot" : "the app keeps this message up to date"}; please don't delete it)`;
/** What phones may write (bans, tags, premium and file links only come from the bot). */
export const PHONE_WRITES = new Set(["index", "dm", "meta", "presence", "market", "accounts"]);
const MAX_BYTES = 1900 * 1024;
export const REASONS = { spam: "Spam", harass: "Harassment or bullying", hate: "Hate speech or slurs", sexual: "Nudity or sexual content", violence: "Violence or threats", scam: "Scam or fraud", fake: "Pretending to be someone else", underage: "May be under 13", other: "Something else" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
const arr = (x) => (Array.isArray(x) ? x : []);
/** A random id: n letters and digits. */
const rid = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
const expiry = (url) => { try { return parseInt(new URL(url).searchParams.get("ex") || "0", 16) * 1000; } catch { return 0; } };
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };

// ---------------------------------------------------------------------------------------------------- merging
// What an app from before the server wrote to a store message directly: whatever it added is kept (posts, comments,
// likes, messages, follows, listings, accounts); for anything both have, the server's copy stands.
const byId = (mine, theirs, fn) => { const ids = new Set(mine.map((x) => x && x.id)); const out = mine.slice(); for (const t of theirs) if (t && t.id && !ids.has(t.id)) out.push(t); if (fn) for (const x of out) { const t = theirs.find((y) => y && y.id === x.id); if (t && t !== x) fn(x, t); } return out; };
const union = (a, b) => [...new Set([...arr(a), ...arr(b)])];
const MERGE = {
  index(m, t) {
    m = obj(m); t = obj(t);
    m.posts = byId(arr(m.posts), arr(t.posts), (x, y) => { x.likes = union(x.likes, y.likes); x.comments = byId(arr(x.comments), arr(y.comments), (c, d) => { c.likes = union(c.likes, d.likes); }); });
    m.posts.sort((a, b) => (b.at || 0) - (a.at || 0));
    m.profiles = { ...obj(t.profiles), ...obj(m.profiles) };
    return m;
  },
  dm(m, t) { m = obj(m); t = obj(t); const del = union(m.del, t.del), gone = new Set(del); m.msgs = byId(arr(m.msgs), arr(t.msgs)).filter((x) => !gone.has(x.id)).sort((a, b) => (a.at || 0) - (b.at || 0)); m.del = del; return m; },
  meta(m, t) {
    m = obj(m); t = obj(t);
    for (const key of ["votes", "follows", "dmok", "dmreq", "fok", "freq", "blocks"]) { const a = obj(m[key]), b = obj(t[key]); for (const k of Object.keys(b)) a[k] = union(a[k], b[k]); m[key] = a; }
    for (const key of ["about", "prefs", "setup"]) m[key] = { ...obj(t[key]), ...obj(m[key]) };
    return m;
  },
  presence(m, t) { m = obj(m); t = obj(t); const on = obj(m.on); for (const [k, v] of Object.entries(obj(t.on))) if (!on[k] || (+v.at || 0) > (+on[k].at || 0)) on[k] = v; m.on = on; return m; },
  market(m, t) { m = obj(m); t = obj(t); m.items = byId(arr(m.items), arr(t.items)); return m; },
  accounts(m, t) { m = obj(m); t = obj(t); const a = obj(m.a); for (const [k, v] of Object.entries(obj(t.a))) if (!a[k] || (+v.at || 0) > (+a[k].at || 0)) a[k] = v; m.a = a; return m; },
};

/** Fields newer apps write that older ones drop: put back from the copy before, where the change left them out. */
function keepNew(k, prev, d) {
  let changed = false;
  if (k === "index" && prev && Array.isArray(prev.posts) && Array.isArray(d.posts)) {
    const before = new Map(prev.posts.map((p) => [p && p.id, p]));
    for (const p of d.posts) { const q = p && before.get(p.id); if (!q) continue; for (const f of ["priv", "shares", "box"]) if (!(f in p) && f in q) { p[f] = q[f]; changed = true; } }
  }
  // (someone's setup: an app from before it leaves it out entirely)
  if (k === "meta" && prev && prev.setup && typeof prev.setup === "object" && Object.keys(prev.setup).length && !("setup" in d)) { d.setup = prev.setup; changed = true; }
  if (k === "meta" && prev && prev.prefs && typeof prev.prefs === "object") {
    d.prefs = obj(d.prefs);
    for (const [ph, q] of Object.entries(prev.prefs)) {
      if (!q || !("lk" in q)) continue;
      if (!d.prefs[ph]) { d.prefs[ph] = { ...q }; changed = true; } else if (!("lk" in d.prefs[ph])) { d.prefs[ph].lk = q.lk; changed = true; }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------------- group chats
// A group chat (dm.json "groups"): { id, name, by (its owner), at, members, admins, kv (its key's version), keys: { kv:
// { phone: { b (the phone that sealed it), iv, c } } } }: the group's key, sealed for each member with the key that
// member shares with whoever sealed it, so only members can read the group's messages (a new version when someone is
// removed). Its messages sit with everyone else's: { id, f, g, kv, at, iv, c }.
//   What a phone may change, checked here against its account (signed in, a Firebase ID token):
//   - a new group: its own, with itself an admin;
//   - an admin: rename it, add people, remove members (the owner: admins too), make admins (the owner: unmake them);
//   - a member: leave (the owner leaving hands it to an admin, or the next member);
//   - the owner: delete it (and its messages);
//   - a message: sent by a member as itself; deleted by whoever sent it, or an admin.
// Anything else is put back as it was. (An app from before groups leaves them out when it writes: put back too.)
export const GID = /^g[a-z0-9]{8,23}$/;
const MID = /^[a-z0-9]{8,24}$/;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
/** A group as sent, made safe (null if it isn't one). */
export function cleanGroup(g) {
  g = obj(g);
  if (!GID.test(g.id || "") || !PHONE.test(g.by || "")) return null;
  const members = [...new Set(arr(g.members).filter((x) => PHONE.test(x)))].slice(0, 50);
  const admins = [...new Set(arr(g.admins).filter((x) => members.includes(x)))];
  const keys = {};
  for (const [v, per] of Object.entries(obj(g.keys)).slice(-40)) {
    if (!/^\d{1,4}$/.test(v)) continue;
    const o = {};
    for (const [ph, k] of Object.entries(obj(per))) if (PHONE.test(ph) && k && PHONE.test(k.b || "") && typeof k.iv === "string" && k.iv.length < 40 && typeof k.c === "string" && k.c.length < 200) o[ph] = { b: k.b, iv: k.iv, c: k.c };
    keys[v] = o;
  }
  return { id: g.id, name: String(g.name || "Group").replace(/\s+/g, " ").trim().slice(0, 60) || "Group", by: g.by, at: +g.at || 0, members, admins, kv: Math.max(1, Math.min(9999, +g.kv | 0 || 1)), keys };
}
/** Whether `who` may change group p into g. */
function groupChangeOk(p, g, who) {
  if (!who || !p.members.includes(who)) return false;
  const gone = p.members.filter((x) => !g.members.includes(x)), added = g.members.filter((x) => !p.members.includes(x));
  // (keys already handed out stay as they were: a change only adds)
  for (const [v, per] of Object.entries(p.keys)) for (const [ph, k] of Object.entries(per)) { const n = g.keys[v] && g.keys[v][ph]; if (n && (n.c !== k.c || n.iv !== k.iv || n.b !== k.b)) return false; }
  if (g.kv < p.kv || g.kv > p.kv + 1) return false;
  // leaving: only itself out (the owner hands the group on)
  if (gone.length === 1 && gone[0] === who && !added.length && g.name === p.name) {
    const okAdmins = sameSet(g.admins, p.admins.filter((x) => x !== who)) || (who === p.by && g.admins.includes(g.by) && g.admins.every((x) => p.admins.includes(x) || x === g.by));
    const okBy = who === p.by ? g.members.includes(g.by) : g.by === p.by;
    return okAdmins && okBy;
  }
  if (!p.admins.includes(who) || g.by !== p.by || !g.members.includes(p.by) || !g.admins.includes(p.by)) return false;
  // (only the owner removes or unmakes admins)
  if (who !== p.by && (gone.some((x) => p.admins.includes(x)) || p.admins.some((x) => g.members.includes(x) && !g.admins.includes(x)))) return false;
  // (someone removed: the key is new, and only the members left have it)
  if (gone.length && (g.kv !== p.kv + 1 || Object.keys(obj(g.keys[g.kv])).some((x) => !g.members.includes(x)))) return false;
  return true;
}
/** The message store as a phone wants to write it, checked against what was there (`who`: the phone, by its account;
 * "" if it didn't say). Changes it back where it isn't allowed; true if it changed anything. */
export function guardGroups(prev, d, who) {
  prev = obj(prev);
  const before = new Map(arr(prev.groups).map(cleanGroup).filter(Boolean).map((g) => [g.id, g]));
  const sent = "groups" in d ? arr(d.groups).map(cleanGroup).filter(Boolean) : null;
  const out = new Map();
  let changed = false;
  if (!sent) { for (const [id, g] of before) out.set(id, g); if (before.size) changed = true; }
  else {
    for (const g of sent) {
      const p = before.get(g.id);
      if (!p) { if (who && g.by === who && g.members.includes(who) && g.admins.includes(who) && g.kv === 1) out.set(g.id, g); else changed = true; }
      else if (JSON.stringify(p) === JSON.stringify(g)) out.set(g.id, p);
      else if (groupChangeOk(p, g, who)) out.set(g.id, g);
      else { out.set(g.id, p); changed = true; }
    }
    // (a group gone: only its owner deletes it)
    for (const [id, p] of before) if (!out.has(id) && !sent.some((g) => g.id === id) && who !== p.by) { out.set(id, p); changed = true; }
    if (JSON.stringify(sent) !== JSON.stringify(arr(d.groups))) changed = true;
  }
  // the messages
  const del = new Set(arr(d.del)), had = new Map(arr(prev.msgs).filter((m) => m && m.g).map((m) => [m.id, m]));
  const msgs = [];
  for (const m of arr(d.msgs)) {
    if (!m || !m.g) { msgs.push(m); continue; }
    const g = out.get(m.g), p = had.get(m.id);
    if (p) { msgs.push(p); if (JSON.stringify(p) !== JSON.stringify(m)) changed = true; continue; }
    // (new: from a member, as itself)
    const ok = g && who && m.f === who && g.members.includes(who) && MID.test(m.id || "") && +m.kv === g.kv && typeof m.iv === "string" && typeof m.c === "string" && m.c.length < 4000;
    if (ok) msgs.push({ id: m.id, f: m.f, g: m.g, kv: g.kv, at: +m.at || Date.now(), iv: m.iv, c: m.c }); else changed = true;
  }
  const kept = new Set(msgs.map((m) => m && m.id));
  for (const [id, p] of had) {
    if (kept.has(id)) continue;
    const g = out.get(p.g);
    // (deleted: by whoever sent it, an admin, or with its group; left out by an older app: put back)
    const allowed = !g || (del.has(id) && who && (who === p.f || g.admins.includes(who)));
    if (!allowed) { msgs.push(p); del.delete(id); changed = true; }
  }
  if (changed) { msgs.sort((a, b) => (+(a && a.at) || 0) - (+(b && b.at) || 0)); d.msgs = msgs; d.del = [...del]; }
  d.groups = [...out.values()];
  return changed;
}

// ---------------------------------------------------------------------------------------------------- accounts
let JWKS = null;
/** A Firebase ID token, checked (Google's signature, this project, not expired): the account, and its phone id. */
export async function checkIdToken(tok, projectId, jwksUrl) {
  const [h, p, s] = String(tok || "").split(".");
  if (!h || !p || !s) throw new Error("not a token");
  const head = JSON.parse(new TextDecoder().decode(unb64u(h))), claims = JSON.parse(new TextDecoder().decode(unb64u(p)));
  if (head.alg !== "RS256") throw new Error("wrong kind of token");
  if (!JWKS || Date.now() - JWKS.at > 3600e3) JWKS = { at: Date.now(), keys: (await (await fetch(jwksUrl)).json()).keys || [] };
  let jwk = JWKS.keys.find((k) => k.kid === head.kid);
  if (!jwk) { JWKS = { at: Date.now(), keys: (await (await fetch(jwksUrl)).json()).keys || [] }; jwk = JWKS.keys.find((k) => k.kid === head.kid); }
  if (!jwk) throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(s), enc(`${h}.${p}`)))) throw new Error("bad signature");
  const now = Date.now() / 1000;
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` || !(claims.exp > now) || !(claims.iat < now + 300) || !claims.sub) throw new Error("not for this app");
  const phone = (/^ft:([a-z0-9]{6,16})$/.exec(claims.name || "") || [])[1] || "";
  if (!phone) throw new Error("no phone on the account");
  return { phone, uid: claims.sub, email: String(claims.email || "").toLowerCase(), verified: !!claims.email_verified };
}

// ---------------------------------------------------------------------------------------------------- Web Push
/** The payload, encrypted for one browser (RFC 8291, aes128gcm). */
export async function encryptPush(sub, payload) {
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const hmac = async (k, d) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d));
  const ikm = await hmac(await hmac(auth, shared), cat(enc("WebPush: info\0"), ua, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc(JSON.stringify(payload)), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  return cat(head, asPub, ct);
}
/** One notification to one browser: the push service's answer (201 sent; 404 or 410: that sign-up is gone). */
export async function sendPush(sub, payload, vapid) {
  const aud = new URL(sub.endpoint).origin;
  const jh = b64u(enc(JSON.stringify({ typ: "JWT", alg: "ES256" }))), jc = b64u(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://thirdeyedragon.github.io/fifteam-media/" })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.priv, enc(`${jh}.${jc}`)));
  const r = await fetch(sub.endpoint, { method: "POST", headers: { TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: `vapid t=${jh}.${jc}.${b64u(sig)}, k=${vapid.pub}` }, body: await encryptPush(sub, payload) });
  return r.status;
}

// ---------------------------------------------------------------------------------------------------- the hub
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env; this.mem = new Map(); this.loading = new Map(); this.fetching = new Map(); this.cfg = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  async config() {
    if (this.cfg && Date.now() - this.cfg.at < 600e3) return this.cfg.c;
    const c = await (await fetch(this.env.CONFIG_URL, { cf: { cacheTtl: 60 } })).json();
    this.cfg = { at: Date.now(), c };
    return c;
  }
  apiBase() { return this.env.DISCORD_API || API; }
  /** (tests only: files from a stand-in instead of the file service) */
  cdn(u) { return this.env.CDN_BASE ? String(u).replace("https://cdn.discordapp.com", this.env.CDN_BASE) : u; }
  async hook(path, opt = {}) {
    const c = await this.config(), base = `${this.apiBase()}/webhooks/${c.hook}/${atob(c.key).split("").reverse().join("")}`;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(base + path, opt);
      if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep(Math.min(10, j.retry_after || 1) * 1000 + 100); continue; }
      if (r.status === 404) { const e = new Error("gone"); e.status = 404; throw e; }
      if (!r.ok) throw new Error(`store ${opt.method || "GET"} ${r.status}`);
      return r.status === 204 ? null : r.json();
    }
    throw new Error("store busy");
  }

  // ---------------------------------------------------------------- stores
  /** A store: { v, raw (its JSON text), att (the attachment last seen on its message), d (parsed, when needed) }. */
  async load(k) {
    if (this.mem.has(k)) return this.mem.get(k);
    if (this.loading.has(k)) return this.loading.get(k);
    const job = (async () => {
      let s = await this.ctx.storage.get("s:" + k);
      if (!s) {
        const c = await this.config();
        let raw = "null", att = "";
        if (c[k]) { const m = await this.hook(`/messages/${c[k]}`); const a = (m.attachments || []).find((x) => x.filename === STORES[k]); if (a) { raw = await (await fetch(this.cdn(a.url))).text(); att = a.id; } }
        s = { v: 1, raw, att };
        this.ctx.storage.put("s:" + k, s);
      }
      this.mem.set(k, s);
      return s;
    })();
    this.loading.set(k, job);
    try { return await job; } finally { this.loading.delete(k); }
  }
  data(s) { if (s.d === undefined) s.d = parse(s.raw); return s.d; }
  /** Several stores at once: { k: { v, raw } } (only the version for any the phone already has at that version). */
  async read(keys, have = {}) {
    const out = {};
    await Promise.all(keys.filter((k) => STORES[k]).map(async (k) => { const s = await this.load(k); out[k] = have[k] === s.v ? { v: s.v } : { v: s.v, raw: s.raw }; }));
    return out;
  }
  /** A change: taken if the store is still at version v (the one the change was made on). */
  async write(k, v, raw, from = "phone", who = "") {
    if (!STORES[k]) return { status: 404 };
    if (from === "phone" && !PHONE_WRITES.has(k)) return { status: 403 };
    if (from === "phone" && v == null) return { status: 428 };
    if (raw.length > MAX_BYTES) return { status: 413 };
    const d = parse(raw);
    if (!d || typeof d !== "object") return { status: 400 };
    const s = await this.load(k);
    if (v != null && +v !== s.v) return { status: 409, v: s.v };
    const prev = this.data(s);
    // what an older app leaves out because it doesn't know it (a post's privacy and shares; who sees someone's likes):
    // kept as it was, so a phone not yet updated can't undo it
    let fixed = false;
    if (from === "phone" && keepNew(k, prev, d)) { raw = JSON.stringify(d); fixed = true; }
    // (group chats: only what that phone may change)
    if (from === "phone" && k === "dm" && guardGroups(prev, d, who)) { raw = JSON.stringify(d); fixed = true; }
    s.v++; s.raw = raw; s.d = d; s.dirty = true;
    this.ctx.storage.put("s:" + k, { v: s.v, raw, att: s.att, dirty: true });
    this.soon();
    if (k !== "presence" && k !== "accounts" && k !== "links") this.tell(k, s.v, k === "dm" ? this.dmPeople(prev, d) : null);
    this.notify(k, prev, d).catch((e) => console.log("push:", e.message));
    return { status: 200, v: s.v, ...(fixed ? { fixed: true } : {}) };
  }
  /** The bot's change: read, changed by fn, written (again if someone changed it meanwhile). */
  async change(k, fn) {
    for (let i = 0; i < 5; i++) {
      const s = await this.load(k), d = structuredClone(this.data(s) || {});
      fn(d);
      const r = await this.write(k, s.v, JSON.stringify(d), "bot");
      if (r.status === 200) return d;
    }
    throw new Error("busy");
  }
  async readOne(k) { const s = await this.load(k); return this.data(s); }
  soon() { this.ctx.storage.getAlarm().then((a) => { if (!a) this.ctx.storage.setAlarm(Date.now() + 2000); }); }
  /** Copies back to the store messages (and what an older app wrote there, merged in first). */
  async alarm() {
    let again = false;
    for (const k of Object.keys(STORES)) {
      // (from storage too: the hub may have been put to sleep since the change)
      let s = this.mem.get(k);
      if (!s) { s = await this.ctx.storage.get("s:" + k); if (s) this.mem.set(k, s); }
      if (!s || !s.dirty) continue;
      s.dirty = false;
      try { await this.flush(k, s); } catch (e) { console.log("copying back", k, e.message); s.dirty = true; again = true; }
    }
    // (a stream's notifications, a few dozen each time)
    let more = false;
    try { more = await this.pushSome(); } catch (e) { console.log("live notes:", e.message); }
    if (again) this.ctx.storage.setAlarm(Date.now() + (more ? 1000 : 10000));
    else if (more) this.ctx.storage.setAlarm(Date.now() + 1000);
  }
  async flush(k, s) {
    const c = await this.config();
    if (!c[k]) return;
    if (MERGE[k]) await this.pull(k, s);
    const v = s.v, f = new FormData();
    f.append("payload_json", JSON.stringify({ content: label(k), attachments: [{ id: 0, filename: STORES[k] }], allowed_mentions: { parse: [] } }));
    f.append("files[0]", new Blob([s.raw], { type: "application/json" }), STORES[k]);
    const m = await this.hook(`/messages/${c[k]}`, { method: "PATCH", body: f });
    s.att = ((m && m.attachments) || []).find((x) => x.filename === STORES[k])?.id || s.att;
    if (s.v !== v) { s.dirty = true; this.soon(); }
    this.ctx.storage.put("s:" + k, { v: s.v, raw: s.raw, att: s.att, dirty: !!s.dirty });
  }
  /** A store message an older app wrote to since: merged in. */
  async pull(k, s) {
    const c = await this.config();
    const m = await this.hook(`/messages/${c[k]}`), a = (m.attachments || []).find((x) => x.filename === STORES[k]);
    if (!a || a.id === s.att) return false;
    const theirs = parse(await (await fetch(this.cdn(a.url))).text());
    s.att = a.id;
    if (!theirs) return false;
    const merged = MERGE[k](structuredClone(this.data(s) || {}), theirs), raw = JSON.stringify(merged);
    if (raw === s.raw) return false;
    const prev = this.data(s);
    s.v++; s.raw = raw; s.d = merged; s.dirty = true;
    this.ctx.storage.put("s:" + k, { v: s.v, raw, att: s.att, dirty: true });
    if (k !== "presence" && k !== "accounts") this.tell(k, s.v, k === "dm" ? this.dmPeople(prev, merged) : null);
    this.notify(k, prev, merged).catch(() => {});
    return true;
  }
  /** Every half hour: anything older apps wrote, merged in (and copied back). */
  async sync() {
    const c = await this.config();
    for (const k of Object.keys(MERGE)) {
      if (!c[k]) continue;
      try { const s = await this.load(k); if (await this.pull(k, s)) this.soon(); } catch (e) { console.log("sync", k, e.message); }
    }
  }

  // ---------------------------------------------------------------- files
  /** The current file links for these posts' (or pictures') messages: { id: [{ filename, url }] | null (gone) }. */
  /** A sealed message file (a song, its cover, a picture or a video sent in a message), passed through: the file
   * service won't let the app read a .bin file from another site (no cross-origin header for that type), so the app
   * fetches it here. Only these files, only from the app's own messages, at most 12 MB; still sealed (only the phones
   * in the chat can open it). */
  async sealedFile(id, name, token) {
    if (!POST.test(id || "") || !SEALED.test(name || "")) return { status: 400 };
    const a = ((await this.files([id], token))[id] || []).find((x) => x.filename === name);
    if (!a) return { status: 404 };
    const r = await fetch(this.cdn(a.url));
    if (!r.ok) return { status: r.status === 404 ? 404 : 502 };
    if (+(r.headers.get("content-length") || 0) > 12 * 1024 * 1024) return { status: 413 };
    return { status: 200, body: r.body };
  }
  async files(ids, token) {
    ids = [...new Set(ids.filter((x) => POST.test(x)))].slice(0, 60);
    const s = await this.load("links"), d = this.data(s) || {}, links = obj(d.links), out = {}, soon = Date.now() + 15 * 60e3;
    const renew = [], need = [];
    for (const id of ids) {
      const a = links[id];
      if (Array.isArray(a) && a.length && a.every((x) => expiry(x.url) > soon)) out[id] = a;
      else if (Array.isArray(a) && a.length && token) renew.push(id); else need.push(id);
    }
    let changed = false;
    if (renew.length) {
      try {
        const urls = renew.flatMap((id) => links[id].map((x) => x.url));
        const r = await fetch(`${this.apiBase()}/attachments/refresh-urls`, { method: "POST", headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ attachment_urls: urls.slice(0, 50) }) });
        const map = r.ok ? new Map(((await r.json()).refreshed_urls || []).map((x) => [x.original, x.refreshed])) : new Map();
        for (const id of renew) { const a = links[id].map((x) => ({ filename: x.filename, url: map.get(x.url) || x.url })); if (a.every((x) => expiry(x.url) > soon)) { out[id] = links[id] = a; changed = true; } else need.push(id); }
      } catch { need.push(...renew); }
    }
    await Promise.all(need.slice(0, 25).map(async (id) => {
      if (!this.fetching.has(id)) this.fetching.set(id, this.hook(`/messages/${id}`).then((m) => ((m && m.attachments) || []).map(({ filename, url }) => ({ filename, url })), (e) => (e.status === 404 ? null : undefined)).finally(() => this.fetching.delete(id)));
      const a = await this.fetching.get(id);
      if (a === undefined) return;
      out[id] = a;
      if (a && a.length) links[id] = a; else delete links[id];
      changed = true;
    }));
    if (changed) { d.links = links; d.v = 1; await this.write("links", null, JSON.stringify(d), "bot"); }
    return out;
  }

  // ---------------------------------------------------------------- live
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/live") && req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ me: "", vis: true });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not here", { status: 404 });
  }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== "string") {
      // (a slice of a live recording: a little header, its length first, then the bytes)
      try {
        const n = new DataView(msg).getUint32(0), head = JSON.parse(new TextDecoder().decode(new Uint8Array(msg, 4, n)));
        if (head.t === "up") this.streamUp(ws, head, msg.slice(4 + n));
      } catch (e) { console.log("stream slice:", e.message); }
      return;
    }
    let m; try { m = JSON.parse(msg); } catch { return; }
    const at = ws.deserializeAttachment() || {};
    if (m.t === "hi" && m.tk) {
      let me = "";
      try { const c = await this.config(); const who = await checkIdToken(m.tk, c.firebase.projectId, this.env.FIREBASE_JWKS); me = who.phone; } catch {}
      // (read again: something else (watching a stream) may have changed it while the account was checked)
      const now = ws.deserializeAttachment() || {};
      now.me = me; now.vis = m.vis !== false;
      ws.serializeAttachment(now);
      at.me = now.me;
      ws.send(JSON.stringify({ t: "ok", me: at.me ? "yes" : "no" }));
      if (this.streams.size) this.tellStreams(ws);
    } else if (m.t === "vis") { at.vis = !!m.vis; ws.serializeAttachment(at); }
    else if (["watch", "unwatch", "say", "like", "unsay", "peek"].includes(m.t)) await this.streamMessage(ws, at, m);
  }
  webSocketClose(ws) {
    let w = ""; try { w = (ws.deserializeAttachment() || {}).watch || ""; } catch {}
    try { ws.close(); } catch {}
    if (w && this._streams) this.countChanged(w);
  }
  webSocketError() {}
  /** Every open app: store k is at version v now (for messages: whose they are, so only their apps read them). */
  tell(k, v, to) {
    const text = JSON.stringify({ t: "v", k, v, ...(to ? { to } : {}) });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(text); } catch {} }
  }
  /** Whether this phone has the app open and on screen right now. */
  onScreen(phone) { return this.ctx.getWebSockets().some((ws) => { const a = ws.deserializeAttachment(); return a && a.me === phone && a.vis; }); }
  dmPeople(prev, next) {
    const had = new Set(arr(prev && prev.msgs).map((m) => m.id)), now = new Set(arr(next && next.msgs).map((m) => m.id)), out = new Set();
    // (a group's message, or a change to a group: everyone in it, before and after)
    const all = [...arr(prev && prev.groups), ...arr(next && next.groups)].filter((g) => g && g.id);
    const membersOf = (id) => all.filter((g) => g.id === id).flatMap((g) => arr(g.members));
    const add = (m) => { out.add(m.f); if (m.g) membersOf(m.g).forEach((x) => out.add(x)); else out.add(m.t); };
    for (const m of arr(next && next.msgs)) if (!had.has(m.id)) add(m);
    for (const m of arr(prev && prev.msgs)) if (!now.has(m.id)) add(m);
    const pg = new Map(arr(prev && prev.groups).map((g) => [g && g.id, JSON.stringify(g)]));
    for (const g of arr(next && next.groups)) if (g && pg.get(g.id) !== JSON.stringify(g)) { membersOf(g.id).forEach((x) => out.add(x)); }
    for (const g of arr(prev && prev.groups)) if (g && !arr(next && next.groups).some((x) => x && x.id === g.id)) arr(g.members).forEach((x) => out.add(x));
    return [...out].filter((x) => PHONE.test(x));
  }

  // ---------------------------------------------------------------- push
  async subscribe(phone, sub, prefs) {
    if (!sub || typeof sub.endpoint !== "string" || !/^(https:\/\/|http:\/\/127\.0\.0\.1:)/.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error("not a push sign-up");
    const list = arr(await this.ctx.storage.get("sub:" + phone)).filter((x) => x.endpoint !== sub.endpoint);
    list.push({ endpoint: sub.endpoint.slice(0, 1000), keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 60) }, prefs: { msg: prefs && prefs.msg === false ? 0 : 1, act: prefs && prefs.act === false ? 0 : 1 }, at: Date.now() });
    await this.ctx.storage.put("sub:" + phone, list.slice(-6));
    return list.length;
  }
  async unsubscribe(endpoint) {
    const all = await this.ctx.storage.list({ prefix: "sub:" });
    for (const [key, list] of all) { const l = arr(list).filter((x) => x.endpoint !== endpoint); if (l.length !== arr(list).length) { if (l.length) await this.ctx.storage.put(key, l); else await this.ctx.storage.delete(key); } }
  }
  async vapid() {
    if (this.vk) return this.vk;
    const c = await this.config();
    if (!this.env.VAPID_KEY || !c.push) return null;
    this.vk = { pub: c.push, priv: await crypto.subtle.importKey("jwk", JSON.parse(this.env.VAPID_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) };
    return this.vk;
  }
  /** The notifications a change means: who, and what to say. */
  async notify(k, prev, next) {
    if (k !== "dm" && k !== "index" && k !== "meta") return;
    const notes = [];
    const feed = k === "index" ? next : this.data(await this.load("index"));
    const meta = k === "meta" ? next : this.data(await this.load("meta")), mod = this.data(await this.load("mod")) || {};
    const banned = obj(mod.bans), profiles = obj(feed && feed.profiles);
    const name = (ph, fallback) => (profiles[ph] && profiles[ph].name) || fallback || "Someone";
    const lists = (key, ph) => arr(obj(meta && meta[key])[ph]);
    const blocked = (a, b) => lists("blocks", a).includes(b) || lists("blocks", b).includes(a);
    const ok = (from, to) => PHONE.test(from) && PHONE.test(to) && from !== to && !banned[from] && !blocked(from, to);
    if (k === "dm") {
      const had = new Set(arr(prev && prev.msgs).map((m) => m.id)), msgs = arr(next && next.msgs);
      const groups = new Map(arr(next && next.groups).map((g) => [g && g.id, g]));
      for (const m of msgs) {
        // a group's message: everyone else in it (not anyone who blocked the sender)
        if (m.g) {
          const g = groups.get(m.g);
          if (had.has(m.id) || !g || banned[m.f]) continue;
          for (const to of arr(g.members)) if (to !== m.f && ok(m.f, to)) notes.push({ to, kind: "msg", title: String(g.name || "Group").slice(0, 60), body: `${name(m.f)} sent a message`, tag: `g-${g.id}`, data: { g: g.id } });
          continue;
        }
        if (had.has(m.id) || !ok(m.f, m.t)) continue;
        const pr = obj(obj(meta && meta.prefs)[m.t]), dm = pr.dm || "all";
        const talked = msgs.some((x) => x.f === m.t && x.t === m.f), follows = lists("follows", m.t).includes(m.f), let_in = lists("dmok", m.t).includes(m.f);
        if (!m.l && (dm === "off" || (dm === "req" && !talked && !follows && !let_in))) continue;
        notes.push({ to: m.t, kind: "msg", title: m.l ? `${name(m.f)} · Audio Market` : name(m.f), body: m.l ? "Sent you a message about your listing" : "Sent you a message", tag: `dm-${m.f}${m.l ? "-" + m.l : ""}`, data: { dm: m.f, l: m.l || "" } });
      }
    } else if (k === "index") {
      const before = new Map(arr(prev && prev.posts).map((p) => [p.id, p]));
      for (const p of arr(next && next.posts)) {
        const was = before.get(p.id);
        if (!was) continue;                                  // (a new post: nobody to tell)
        const owner = p.by, liked = new Set(arr(was.likes)), shared = new Set(arr(was.shares));
        for (const who of arr(p.likes)) if (!liked.has(who) && ok(who, owner)) notes.push({ to: owner, kind: "act", title: name(who), body: "Liked your post", tag: `like-${p.id}`, data: { post: p.id } });
        for (const who of arr(p.shares)) if (!shared.has(who) && ok(who, owner)) notes.push({ to: owner, kind: "act", title: name(who), body: "Shared your post", tag: `share-${p.id}`, data: { post: p.id } });
        const old = new Set(arr(was.comments).map((c) => c.id)), comments = arr(p.comments);
        for (const c of comments) {
          if (old.has(c.id)) continue;
          const text = String(c.text || "").slice(0, 120), parent = c.re ? comments.find((x) => x.id === c.re) : null;
          if (parent && ok(c.by, parent.by)) notes.push({ to: parent.by, kind: "act", title: name(c.by, c.user), body: `Replied: ${text}`, tag: `c-${p.id}`, data: { post: p.id, c: 1 } });
          if (ok(c.by, owner) && (!parent || parent.by !== owner)) notes.push({ to: owner, kind: "act", title: name(c.by, c.user), body: `Commented: ${text}`, tag: `c-${p.id}`, data: { post: p.id, c: 1 } });
        }
      }
    } else if (k === "meta") {
      const added = (key, fn) => { const a = obj(prev && prev[key]), b = obj(next && next[key]); for (const [ph, l] of Object.entries(b)) { const had = new Set(arr(a[ph])); for (const x of arr(l)) if (!had.has(x)) fn(ph, x); } };
      added("follows", (who, owner) => { if (ok(who, owner)) notes.push({ to: owner, kind: "act", title: name(who), body: obj(obj(next.prefs)[owner]).priv ? "Asked to follow you" : "Started following you", tag: `f-${who}`, data: { act: 1 } }); });
      added("dmreq", (to, who) => { if (ok(who, to)) notes.push({ to, kind: "act", title: name(who), body: "Wants to message you", tag: `r-${who}`, data: { inbox: 1 } }); });
    }
    await this.sendNotes(notes);
  }
  /** Notes for phones: shown by the app if it's on screen, otherwise sent as notifications (if they get that kind). */
  async sendNotes(notes) {
    if (!notes.length) return;
    const vapid = await this.vapid();
    await Promise.all(notes.slice(0, 40).map(async (n) => {
      // (the app open on screen: it shows it itself)
      if (this.onScreen(n.to)) { this.toPhone(n.to, { t: "note", kind: n.kind, title: n.title, body: n.body, data: n.data }); return; }
      if (!vapid) return;
      const subs = arr(await this.ctx.storage.get("sub:" + n.to)).filter((x) => x.prefs[n.kind]);
      for (const sub of subs) {
        try {
          const st = await sendPush(sub, { title: n.title, body: n.body, tag: n.tag, data: n.data }, vapid);
          if (st === 404 || st === 410) await this.unsubscribe(sub.endpoint);
        } catch (e) { console.log("push failed:", e.message); }
      }
    }));
  }
  toPhone(phone, obj) { const text = JSON.stringify(obj); for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.me === phone) { try { ws.send(text); } catch {} } } }

  // ---------------------------------------------------------------- premium
  /** Someone tapped Pay for Premium: noted (for /premiums) and told to the owner in the server. */
  async premiumAsk(phone, how = {}) {
    const asks = obj(await this.ctx.storage.get("premium-asks"));
    const was = asks[phone] && typeof asks[phone] === "object" ? asks[phone] : null;
    const method = how.method === "cash" ? "cash" : "paypal", pay = String(how.pay || "").replace(/\s+/g, " ").trim().slice(0, 60), email = String(how.email || "").slice(0, 120);
    const first = !asks[phone] || !was || was.pay !== pay || was.method !== method;
    asks[phone] = { at: Date.now(), method, pay, email };
    await this.ctx.storage.put("premium-asks", asks);
    if (first) {
      const feed = this.data(await this.load("index")) || {}, nm = (obj(feed.profiles)[phone] || {}).name || phone;
      const esc = (x) => String(x).replace(/[\\*_~`|>#@<:\[\]()]/g, (c) => "\\" + c), clean = esc(nm);
      if (pay) {
        await this.tellPayments([
          `💸 **Premium request** ($10)`,
          `**Username:** ${clean}`,
          `**Email:** ${email ? esc(email) : "(none on the account)"}`,
          `**Paying with:** ${method === "cash" ? "Cash App" : "PayPal"} as **${esc(pay)}**`,
          `-# Look for $10 from ${esc(pay)} in ${method === "cash" ? "Cash App ($ThirdEyeDragon999)" : "PayPal"}, then /premium ${clean} · phone \`${phone}\``,
        ].join("\n"));
        return first;
      }
      await this.tellPayments(`💸 **${clean}** wants Premium ($10: unlimited rebassing and downloads, 4th and 6th-order boxes). Check PayPal and Cash App ($ThirdEyeDragon999) for a $10 payment with "${clean}" in the note, then use /premium ${clean}.`).catch(() => {});
    }
    return first;
  }
  /** A channel in the server, by its name (looked for again every few minutes until it's made). */
  async channelNamed(name) {
    this.chans = this.chans || {};
    const c = this.chans[name];
    if (c && Date.now() - c.at < (c.id ? 3600e3 : 300e3)) return c.id;
    let id = "";
    const tok = this.env.BOT_TOKEN;
    if (tok) {
      const w = await this.hook("");
      const r = await fetch(`${this.apiBase()}/guilds/${w.guild_id}/channels`, { headers: { Authorization: `Bot ${tok}` } });
      const ch = r.ok ? (await r.json()).find((x) => x.type === 0 && (x.name === name || x.name === name.replace(/s$/, ""))) : null;
      id = ch ? ch.id : "";
    }
    this.chans[name] = { at: Date.now(), id };
    return id;
  }
  /** A note for the owner, in that channel (or, until there is one, the app's own channel). */
  async tellChannel(name, content) {
    const id = await this.channelNamed(name).catch(() => "");
    if (id) {
      const r = await fetch(`${this.apiBase()}/channels/${id}/messages`, { method: "POST", headers: { Authorization: `Bot ${this.env.BOT_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }) });
      if (r.ok) return true;
      console.log(`#${name}:`, r.status);
      if (this.chans) delete this.chans[name];
    }
    await this.hook("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "FifTeam", allowed_mentions: { parse: [] }, content: content.slice(0, 2000) }) });
    return false;
  }
  /** Payment news: #payments. */
  tellPayments(content) { return this.tellChannel("payments", content); }

  // ---------------------------------------------------------------- reports
  /** Someone reported a user (or one of their posts or comments): to #reports, with the reason and their own words.
   * At most 8 reports an hour from one account. */
  async report(from, r) {
    r = obj(r);
    const who = String(r.who || ""), reason = REASONS[r.reason] ? r.reason : "", text = String(r.text || "").trim().slice(0, 600);
    if (!PHONE.test(who) || who === from || !reason) return { status: 400 };
    const key = "reports:" + from, recent = arr(await this.ctx.storage.get(key)).filter((t) => Date.now() - t < 3600e3);
    if (recent.length >= 8) return { status: 429 };
    recent.push(Date.now());
    await this.ctx.storage.put(key, recent);
    const feed = this.data(await this.load("index")) || {}, profiles = obj(feed.profiles);
    const esc = (s) => String(s || "").replace(/[\\*_~`|>#@<:\[\]()]/g, (c) => "\\" + c);
    const nm = (ph) => esc((profiles[ph] && profiles[ph].name) || "someone");
    const lines = [`🚩 **Report: ${REASONS[reason]}**`, `**Reported:** ${nm(who)} (\`${who}\`)`, `**By:** ${nm(from)} (\`${from}\`)`];
    const post = POST.test(r.post || "") ? arr(feed.posts).find((p) => p.id === r.post) : null;
    if (post) {
      const c = r.comment ? arr(post.comments).find((x) => x.id === r.comment) : null;
      const what = (x) => (x.text ? `"${esc(String(x.text).slice(0, 200))}"` : x.song ? `a song: ${esc(x.song.title)}` : x.video || (x.media && x.media.length) ? "pictures or a video" : x.image ? "a picture" : "a post");
      if (c) lines.push(`**Comment:** "${esc(String(c.text || "").slice(0, 200))}" on ${nm(post.by)}'s post (\`${post.id}:${c.id}\`)`);
      else lines.push(`**Post:** ${what(post)} (\`${post.id}\`)`);
    }
    lines.push(`**Their message:** ${text ? esc(text) : "(none)"}`);
    lines.push(`-# /posts ${nm(who)} · /delete-post · /delete-comment · /ban ${nm(who)} · /purge ${nm(who)}`);
    await this.tellChannel("reports", lines.join("\n"));
    return { status: 200 };
  }
  async premiumAsks() { return obj(await this.ctx.storage.get("premium-asks")); }

  // ---------------------------------------------------------------- live streams
  // The person the owner lets (/allow streaming) can go live from Social. The phone records its camera as one continuous
  // video (MP4 where it can, else WebM) and sends it here a slice at a time (every quarter second) on its live
  // connection, saying where in it a viewer can start (each fragment or cluster, from a whole frame). The start of the
  // recording (its setup) is kept, and the last dozen seconds. Someone who starts watching gets the setup and the video
  // from the latest place to start; then every slice as it comes, passed straight on. One recording, one timeline:
  // sound and picture stay together. A new recording (the camera flipped, the connection back) starts everyone again.
  // Chat, likes and how many are watching go round on the live connection too. In memory only: a stream that stops
  // sending for 20 seconds has ended.
  get streams() { return (this._streams = this._streams || new Map()); }
  streamList() { return [...this.streams.values()].map((s) => ({ id: s.id, by: s.by, name: s.name, at: s.at, title: s.title, viewers: this.viewers(s), likes: s.likes })); }
  viewers(s) { let n = 0; for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.watch === s.id && a.me !== s.by) n++; } return n; }
  toWatchers(id, o) { const text = JSON.stringify(o); for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.watch === id) { try { ws.send(text); } catch {} } } }
  tellStreams(only) { const text = JSON.stringify({ t: "streams", list: this.streamList() }); for (const ws of only ? [only] : this.ctx.getWebSockets()) { try { ws.send(text); } catch {} } }
  countChanged(id) { const s = this.streams.get(id); if (s) this.toWatchers(id, { t: "viewers", s: id, n: this.viewers(s) }); }
  async streamNames() { const feed = this.data(await this.load("index")) || {}; return obj(feed.profiles); }
  async streamMod() { return this.data(await this.load("mod")) || {}; }
  /** Going live (or carrying on: a new key for the same stream). */
  async streamStart(phone, title) {
    const mod = await this.streamMod();
    if (!obj(mod.stream)[phone] || obj(mod.bans)[phone]) return { status: 403 };
    const name = String(((await this.streamNames())[phone] || {}).name || "FifTeam").slice(0, 24);
    title = String(title || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const key = rid(24);
    let s = [...this.streams.values()].find((x) => x.by === phone);
    if (!s) {
      s = { id: rid(10), by: phone, name, at: Date.now(), title, key, g: null, type: "", init: null, parts: [], joins: [], chat: [], likes: 0, last: Date.now() };
      this.streams.set(s.id, s);
      this.tellStreams();
      this.liveNotes(phone, name).catch((e) => console.log("live notes:", e.message));
    } else { s.key = key; s.last = Date.now(); if (title) s.title = title; }
    this.watchdog();
    return { status: 200, id: s.id, key, at: s.at };
  }
  /** A slice of the recording, from the streamer's phone (head: { s, k (the stream's key), g (which recording), a (where
   * the slice starts in it, in bytes), j (where in it a viewer can start), type (once: its kind, with its codecs) }). */
  streamUp(ws, head, data) {
    const s = this.streams.get(String(head.s || ""));
    if (!s || s.key !== head.k) { try { ws.send(JSON.stringify({ t: "upgone", s: String(head.s || "") })); } catch {} return; }
    const now = Date.now();
    s.last = now;
    if (head.g !== s.g) { s.g = head.g; s.type = ""; s.init = null; s.parts = []; s.joins = []; }
    if (head.type) s.type = String(head.type).slice(0, 120);
    s.parts.push({ a: +head.a || 0, buf: data, at: now });
    for (const j of arr(head.j)) if (+j >= 0) s.joins.push({ a: +j, at: now });
    // (its setup: everything before the first place to start)
    if (!s.init && s.joins.length && s.parts[0].a === 0) s.init = this.range(s, 0, s.joins[0].a);
    // (the last dozen seconds kept)
    while (s.parts.length > 2 && now - s.parts[0].at > 12000) s.parts.shift();
    s.joins = s.joins.filter((x) => x.a >= s.parts[0].a);
    if (!s.init || !s.type) return;
    let more = null;
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (!a || (a.watch !== s.id && a.peek !== s.id) || a.me === s.by) continue;
      if (a.lg === s.g) { more = more || this.frame({ t: "lv", k: "more", s: s.id, g: s.g }, new Uint8Array(data)); try { w.send(more); } catch {} }
      else this.startFor(w, a, s);
    }
  }
  /** The recording's bytes from..to (what's kept). */
  range(s, from, to) {
    const out = new Uint8Array(Math.max(0, to - from));
    for (const p of s.parts) {
      const b = new Uint8Array(p.buf), a0 = p.a, a1 = p.a + b.length;
      if (a1 <= from || a0 >= to) continue;
      const x0 = Math.max(from, a0), x1 = Math.min(to, a1);
      out.set(b.subarray(x0 - a0, x1 - a0), x0 - from);
    }
    return out;
  }
  /** A message with a little header (its length first) and bytes after it. */
  frame(head, bytes) {
    const h = new TextEncoder().encode(JSON.stringify(head)), f = new Uint8Array(4 + h.length + bytes.length);
    new DataView(f.buffer).setUint32(0, h.length); f.set(h, 4); f.set(bytes, 4 + h.length);
    return f.buffer;
  }
  /** Someone starting to watch (or to show the preview): the setup and the video from the latest place to start (one
   * just come in is too fresh to have anything after it: the one before), then every slice as it comes. */
  startFor(w, a, s) {
    if (!s.init || !s.type || !s.joins.length) return;
    const last = s.parts[s.parts.length - 1], endA = last.a + last.buf.byteLength;
    let k = s.joins.length - 1;
    if (k > 0 && endA - s.joins[k].a < 20000) k--;
    while (k < s.joins.length - 1 && endA - s.joins[k].a > 900e3) k++;
    const body = this.range(s, s.joins[k].a, endA), all = new Uint8Array(s.init.length + body.length);
    all.set(s.init); all.set(body, s.init.length);
    try { w.send(this.frame({ t: "lv", k: "start", s: s.id, g: s.g, type: s.type }, all)); } catch { return; }
    const a2 = w.deserializeAttachment() || a; a2.lg = s.g; w.serializeAttachment(a2);
  }
  streamEnd(id, key) { const s = this.streams.get(id); if (!s || s.key !== key) return { status: 404 }; this.endStream(id); return { status: 200 }; }
  /** (the owner took someone's say away: their stream ends) */
  endStreamsOf(phones) { for (const s of [...this.streams.values()]) if (phones.includes(s.by)) this.endStream(s.id); }
  endStream(id) { if (!this.streams.has(id)) return; this.toWatchers(id, { t: "end", s: id }); this.streams.delete(id); this.tellStreams(); }
  watchdog() {
    if (this.wd) return;
    this.wd = setInterval(() => {
      for (const s of [...this.streams.values()]) if (Date.now() - s.last > 20000) this.endStream(s.id);
      if (!this.streams.size) { clearInterval(this.wd); this.wd = 0; }
    }, 5000);
  }
  /** Their followers hear they've gone live (on screen: a note; otherwise a notification, if they get activity ones). */
  async liveNotes(phone, name) {
    const mod = await this.streamMod(), banned = obj(mod.bans);
    const note = { title: `${name} is live`, body: "Tap to watch now", tag: `live-${phone}`, data: { live: phone } };
    // apps open on screen: a note at once (no notification on top)
    const shown = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a || !a.me || a.me === phone || banned[a.me] || !a.vis) continue;
      try { ws.send(JSON.stringify({ t: "note", kind: "live", title: note.title, body: note.body, data: note.data })); shown.add(a.me); } catch {}
    }
    // everyone else with notifications set up, whatever their settings: queued, sent a few dozen at a time (alarm())
    const q = [];
    for (const [key, list] of await this.ctx.storage.list({ prefix: "sub:" })) {
      const ph = key.slice(4);
      if (ph === phone || banned[ph] || shown.has(ph)) continue;
      for (const sub of arr(list)) q.push(sub);
    }
    if (!q.length) return;
    await this.ctx.storage.put("pushq", { note, list: q });
    await this.ctx.storage.setAlarm(Date.now() + 50);
  }
  /** Some of the queued notifications (each wakeup can only reach so many): true if there are more. */
  async pushSome() {
    const pq = await this.ctx.storage.get("pushq");
    if (!pq || !arr(pq.list).length) return false;
    const vapid = await this.vapid();
    const take = pq.list.splice(0, 30), gone = [];
    if (vapid) await Promise.all(take.map(async (sub) => { try { const st = await sendPush(sub, pq.note, vapid); if (st === 404 || st === 410) gone.push(sub.endpoint); } catch (e) { console.log("push failed:", e.message); } }));
    for (const e of gone) await this.unsubscribe(e);
    if (pq.list.length) { await this.ctx.storage.put("pushq", pq); return true; }
    await this.ctx.storage.delete("pushq");
    return false;
  }
  /** What a watcher says or does in a stream: chat (sanitised, at most one a second), likes (taps; at most 8 a second),
   * and (the streamer) taking a chat message down. */
  async streamMessage(ws, at, m) {
    const s = this.streams.get(String(m.s || ""));
    if (m.t === "watch") {
      const old = at.watch; at.watch = s ? s.id : ""; ws.serializeAttachment(at);
      if (old && old !== at.watch) this.countChanged(old);
      if (!s) { try { ws.send(JSON.stringify({ t: "end", s: String(m.s || "") })); } catch {} return; }
      at.lg = -1; ws.serializeAttachment(at);
      try { ws.send(JSON.stringify({ t: "st", s: s.id, by: s.by, name: s.name, title: s.title, at: s.at, chat: s.chat.slice(-40), likes: s.likes, viewers: this.viewers(s) })); } catch {}
      if (at.me !== s.by) this.startFor(ws, at, s);
      this.countChanged(s.id);
      return;
    }
    // the preview at the top of the app: the pieces, without counting as watching
    if (m.t === "peek") {
      const a2 = ws.deserializeAttachment() || {}; a2.peek = s ? s.id : ""; if (s && a2.watch !== s.id) a2.lg = -1; ws.serializeAttachment(a2);
      if (s && a2.watch !== s.id) this.startFor(ws, a2, s);
      return;
    }
    if (m.t === "unwatch") { const old = at.watch; at.watch = ""; ws.serializeAttachment(at); if (old) this.countChanged(old); return; }
    if (!s || !at.me || at.watch !== s.id) return;
    const mod = await this.streamMod();
    if (obj(mod.bans)[at.me]) return;
    const now = Date.now();
    if (m.t === "say") {
      const text = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!text || now - (at.said || 0) < 900) return;
      { const a2 = ws.deserializeAttachment() || {}; a2.said = now; ws.serializeAttachment(a2); }
      const name = String(((await this.streamNames())[at.me] || {}).name || "Someone").slice(0, 24);
      const c = { id: rid(8), by: at.me, name, text, at: now };
      s.chat.push(c); while (s.chat.length > 80) s.chat.shift();
      this.toWatchers(s.id, { t: "chat", s: s.id, m: c });
    } else if (m.t === "like") {
      const w = Math.floor(now / 1000), a2 = ws.deserializeAttachment() || {};
      if (a2.lw !== w) { a2.lw = w; a2.ln = 0; }
      if (++a2.ln > 8) return;
      ws.serializeAttachment(a2);
      s.likes++;
      this.toWatchers(s.id, { t: "like", s: s.id, n: s.likes, by: at.me });
    } else if (m.t === "unsay" && at.me === s.by) {
      const id = String(m.id || ""); s.chat = s.chat.filter((c) => c.id !== id);
      this.toWatchers(s.id, { t: "unsay", s: s.id, id });
    }
  }
  async premiumDone(phones) { const asks = obj(await this.ctx.storage.get("premium-asks")); for (const p of phones) delete asks[p]; await this.ctx.storage.put("premium-asks", asks); }
}
