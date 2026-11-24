// FifTeam Social's extras, each kept in a store message of its own on the feed service (social/config.json):
//   meta:     votes on rebassed songs, who follows whom, everyone's "about me", and privacy: who may message whom
//             (everyone, by request, nobody; requests and who's been let in) and private accounts (only followers
//             the owner approves see their posts; follow requests)
//   presence: who has the app open right now, on what device (for the owner's /online)
// They're kept apart from the feed list so that a phone still on an older version of the app (which rewrites the feed
// list with only the fields it knows) can't wipe them.
import { api } from "./social.js";
import { APP_VERSION } from "./app.js";
import { deviceName } from "./device.js";

const PHONE = /^[a-z0-9]{6,16}$/, POST = /^\d{5,25}$/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** One JSON file in one store message: read it fresh, write it, and change it safely (this phone's changes one at a
 * time, each read back to check it took, and looked at again twice a little later in case another phone's copy landed
 * on top of it). */
export function jsonStore(key, file, label, clean, low = false) {
  let queue = Promise.resolve(), seq = 0;
  async function read() {
    const cfg = await api.config();
    if (!cfg[key]) throw new Error("setup");
    const m = await api.dc(`/messages/${cfg[key]}`, { low });
    const a = (m.attachments || []).find((x) => x.filename === file);
    return clean(a ? await (await fetch(a.url, { cache: "no-store" })).json() : null);
  }
  async function write(d) {
    const cfg = await api.config(), f = new FormData();
    f.append("payload_json", JSON.stringify({ content: `${label} (the app keeps this message up to date; please don't delete it)`, attachments: [{ id: 0, filename: file }], allowed_mentions: { parse: [] } }));
    f.append("files[0]", new Blob([JSON.stringify(d)], { type: "application/json" }), file);
    await api.dc(`/messages/${cfg[key]}`, { method: "PATCH", form: f, low });
  }
  async function changeNow(change, check) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const d = await read();
      change(d);
      await write(d);
      if (!check) return d;
      const now = await read();
      if (check(now)) return now;
      await wait(400 + Math.random() * 800);
    }
    throw new Error("busy");
  }
  /** change(d) edits the data in place; check(d) says whether a fresh copy has the change (none: write and done). */
  function change(fn, check) {
    const mine = ++seq;
    const run = queue.then(() => changeNow(fn, check));
    queue = run.catch(() => {});
    if (check) run.then(() => { for (const ms of [3000, 10000]) setTimeout(() => {
      queue = queue.then(async () => { if (seq === mine && !check(await read())) await changeNow(fn, check); }).catch(() => {});
    }, ms); }, () => {});
    return run;
  }
  return { read, write, change };
}

// ---------------------------------------------------------------------------------------------------- votes, follows, about
const phones = (a, n) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === "string" && PHONE.test(x)))].slice(0, n) : []);
function cleanMeta(d) {
  const out = { v: 1, votes: {}, follows: {}, about: {}, prefs: {}, dmok: {}, dmreq: {}, fok: {}, freq: {}, blocks: {} };
  if (!d || typeof d !== "object") return out;
  for (const [k, v] of Object.entries(d.prefs || {}).slice(0, 5000)) if (PHONE.test(k) && v && typeof v === "object") {
    const dm = v.dm === "req" || v.dm === "off" ? v.dm : "all", priv = v.priv ? 1 : 0;
    if (dm !== "all" || priv) out.prefs[k] = { dm, priv };
  }
  for (const key of ["dmok", "dmreq", "fok", "freq", "blocks"]) for (const [k, v] of Object.entries(d[key] || {}).slice(0, 5000)) if (PHONE.test(k)) { const l = phones(v, 2000).filter((x) => x !== k); if (l.length) out[key][k] = l; }
  // votes: the 800 newest posts that have any
  const vs = Object.entries(d.votes || {}).filter(([k]) => POST.test(k)).sort((a, b) => (BigInt(b[0]) > BigInt(a[0]) ? 1 : -1)).slice(0, 800);
  for (const [k, v] of vs) { const l = phones(v, 5000); if (l.length) out.votes[k] = l; }
  for (const [k, v] of Object.entries(d.follows || {}).slice(0, 5000)) if (PHONE.test(k)) { const l = phones(v, 1000).filter((x) => x !== k); if (l.length) out.follows[k] = l; }
  for (const [k, v] of Object.entries(d.about || {}).slice(0, 5000)) if (PHONE.test(k) && typeof v === "string" && v.trim()) out.about[k] = v.slice(0, 160);
  return out;
}
const metaStore = jsonStore("meta", "meta.json", "FifTeam votes, follows and about", cleanMeta);
const M = { d: cleanMeta(null), at: 0, loading: null, pending: new Map() };
// (what it was last time, at once: votes, follows and the rest show before the new copy arrives)
const META_CACHE = "fifteam-meta";
try { const c = localStorage.getItem(META_CACHE); if (c) M.d = cleanMeta(JSON.parse(c)); } catch {}
const saveMeta = () => { try { localStorage.setItem(META_CACHE, JSON.stringify(M.d)); } catch {} };
export const meta = M;

/** The votes, follows and abouts, fetched again if they're older than maxAge (ms). */
export async function loadMeta(maxAge = 0) {
  if (M.loading) return M.loading;
  if (M.at && Date.now() - M.at < maxAge) return M.d;
  // (a copy read while a change from here was on its way, and finished after it, is older than what's on screen: not used)
  const ver = M.ver;
  M.loading = (async () => { try { const d = await metaStore.read(); if (ver !== M.ver || M.pending.size) return M.d; M.d = withPending(d); M.at = Date.now(); saveMeta(); return M.d; } finally { M.loading = null; } })();
  return M.loading;
}
// changes from here still on their way: kept showing even if a copy without them comes back in the meantime
function withPending(d) { for (const fn of M.pending.values()) fn(d); return d; }
async function metaChange(key, fn, check) {
  M.pending.set(key, fn); fn(M.d); M.ver = (M.ver || 0) + 1;
  try { const now = await metaStore.change(fn, check); M.pending.delete(key); M.d = withPending(now); M.at = Date.now(); M.ver++; saveMeta(); return true; }
  catch { M.pending.delete(key); try { M.d = withPending(await metaStore.read()); M.at = Date.now(); } catch {} return false; }
}

export const votesOf = (post) => M.d.votes[post] || [];
export const prefsOf = (phone) => M.d.prefs[phone] || { dm: "all", priv: 0 };
const list = (key, phone) => M.d[key][phone] || [];
/** Whether one follows another: asked for, and (a private account) let in. */
const approved = (who, owner) => !prefsOf(owner).priv || list("fok", owner).includes(who);
export const followingOf = (phone) => list("follows", phone).filter((x) => approved(phone, x));
export const followersOf = (phone) => Object.keys(M.d.follows).filter((k) => M.d.follows[k].includes(phone) && approved(k, phone));
/** "following", "requested" (a private account that hasn't let them in yet) or "". */
export function followState(who, owner) { if (!list("follows", who).includes(owner)) return ""; return approved(who, owner) ? "following" : "requested"; }
export const aboutOf = (phone) => M.d.about[phone] || "";
/** Blocking: either one having blocked the other keeps them apart (posts, comments, messages, follows). */
export const blocksOf = (phone) => list("blocks", phone);
export const blocked = (a, b) => !!a && !!b && (list("blocks", a).includes(b) || list("blocks", b).includes(a));
export function setBlock(phone, on) {
  const me = api.state.me;
  const fn = (d) => {
    d.blocks = d.blocks || {};
    const l = (d.blocks[me] || []).filter((x) => x !== phone); if (on) l.push(phone);
    if (l.length) d.blocks[me] = l; else delete d.blocks[me];
    // (blocked: no longer following each other, and nothing waiting from them)
    if (on) for (const [k, a, b] of [["follows", me, phone], ["follows", phone, me], ["fok", me, phone], ["freq", me, phone], ["dmreq", me, phone], ["dmok", me, phone]]) {
      if (!d[k] || !d[k][a]) continue;
      d[k][a] = d[k][a].filter((x) => x !== b); if (!d[k][a].length) delete d[k][a];
    }
  };
  return metaChange("block|" + phone, fn, (d) => ((d.blocks || {})[me] || []).includes(phone) === on);
}
/** Whether a phone sees someone's posts: their own, a public account's, or a private one's that has let them in. */
export const canSee = (viewer, owner) => !owner || viewer === owner || (!blocked(viewer, owner) && (!prefsOf(owner).priv || list("fok", owner).includes(viewer)));
export const followRequests = (phone) => list("freq", phone).filter((x) => list("follows", x).includes(phone) && !list("fok", phone).includes(x));
export const dmRequests = (phone) => list("dmreq", phone).filter((x) => !list("dmok", phone).includes(x));
/** Whether `from` may write to `to`: "ok", "request" (they'd have to ask), "requested" (asked, not answered) or "off".
 *  (talked: they've written to each other before, which always counts as let in unless messages are off) */
export function dmState(from, to, talked) {
  const pr = prefsOf(to);
  if (pr.dm === "off" || blocked(from, to)) return "off";
  if (pr.dm === "all" || talked || list("dmok", to).includes(from) || list("follows", to).includes(from)) return "ok";
  return list("dmreq", to).includes(from) ? "requested" : "request";
}

/** Vote for a rebassed song, or take the vote back. */
export function setVote(post, on) {
  const me = api.state.me;
  const fn = (d) => { const l = (d.votes[post] || []).filter((x) => x !== me); if (on) l.push(me); if (l.length) d.votes[post] = l; else delete d.votes[post]; };
  return metaChange("vote|" + post, fn, (d) => (d.votes[post] || []).includes(me) === on);
}
export function setFollow(phone, on) {
  const me = api.state.me;
  const fn = (d) => { const l = (d.follows[me] || []).filter((x) => x !== phone); if (on) l.push(phone); if (l.length) d.follows[me] = l; else delete d.follows[me]; };
  return metaChange("follow|" + phone, fn, (d) => (d.follows[me] || []).includes(phone) === on);
}
/** This phone's privacy: { dm: "all" | "req" | "off", priv: true/false }. Going private keeps the followers it has. */
export function setPrefs(next) {
  const me = api.state.me, cur = prefsOf(me), p = { dm: next.dm || cur.dm, priv: next.priv != null ? (next.priv ? 1 : 0) : cur.priv };
  const keep = p.priv && !cur.priv ? followersOf(me) : null;
  const fn = (d) => {
    d.prefs = d.prefs || {}; d.fok = d.fok || {};
    if (p.dm === "all" && !p.priv) delete d.prefs[me]; else d.prefs[me] = p;
    if (keep) d.fok[me] = [...new Set([...(d.fok[me] || []), ...keep])];
  };
  return metaChange("prefs", fn, (d) => { const x = (d.prefs || {})[me] || { dm: "all", priv: 0 }; return x.dm === p.dm && !!x.priv === !!p.priv; });
}
const edit = (key, owner, who, on) => (d) => { d[key] = d[key] || {}; const l = (d[key][owner] || []).filter((x) => x !== who); if (on) l.push(who); if (l.length) d[key][owner] = l; else delete d[key][owner]; };
const has = (key, owner, who) => (d) => ((d[key] || {})[owner] || []).includes(who);
/** Ask a private account to let this phone follow it (Follow on their page does it), or take the request back. */
export function setFollowRequest(owner, on) {
  const me = api.state.me, a = edit("freq", owner, me, on), b = edit("follows", me, owner, on);
  return metaChange("freq|" + owner, (d) => { a(d); b(d); }, (d) => has("freq", owner, me)(d) === on && has("follows", me, owner)(d) === on);
}
/** Someone's request to follow this (private) phone: let in or not. */
export function answerFollow(who, yes) {
  const me = api.state.me, a = edit("freq", me, who, false), b = edit("fok", me, who, yes);
  return metaChange("fans|" + who, (d) => { a(d); b(d); }, (d) => !has("freq", me, who)(d) && has("fok", me, who)(d) === yes);
}
export function requestDm(to) { const me = api.state.me; return metaChange("dmreq|" + to, edit("dmreq", to, me, true), has("dmreq", to, me)); }
/** Someone asking to message this phone: let in, or not. */
export function answerDm(who, yes) {
  const me = api.state.me, a = edit("dmreq", me, who, false), b = edit("dmok", me, who, yes);
  return metaChange("dmans|" + who, (d) => { a(d); b(d); }, (d) => !has("dmreq", me, who)(d) && has("dmok", me, who)(d) === yes);
}
export function setAbout(text) {
  const me = api.state.me, t = String(text || "").trim().slice(0, 160);
  const fn = (d) => { if (t) d.about[me] = t; else delete d.about[me]; };
  return metaChange("about", fn, (d) => (d.about[me] || "") === t);
}

// ---------------------------------------------------------------------------------------------------- who's online
// Every few minutes while the app is on screen: this phone's username, device and app version, with the time. Entries
// older than half a year are dropped (the owner's /devices lists them). (Nothing else: no place, no contacts.)
function cleanPresence(d) {
  const out = { v: 1, on: {} };
  const old = Date.now() - 183 * 86400e3;
  for (const [k, v] of Object.entries((d && d.on) || {}).slice(0, 5000)) if (PHONE.test(k) && v && +v.at > old)
    out.on[k] = { n: String(v.n || "").slice(0, 24), d: String(v.d || "").slice(0, 60), v: String(v.v || "").slice(0, 12), at: +v.at };
  return out;
}
const presenceStore = jsonStore("presence", "presence.json", "FifTeam who's online", cleanPresence, true);
let lastBeat = 0, beating = false;
export async function heartbeat() {
  if (beating || document.visibilityState !== "visible" || !api.state.me || Date.now() - lastBeat < 4 * 60e3) return;
  beating = true;
  try {
    const d = await deviceName(), me = api.state.me, entry = { n: api.state.name || "", d, v: APP_VERSION, at: Date.now() };
    await presenceStore.change((x) => { x.on[me] = entry; });
    lastBeat = Date.now();
  } catch {} finally { beating = false; }
}
export function initPresence() {
  setTimeout(heartbeat, 4000);
  setInterval(heartbeat, 60e3);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") heartbeat(); });
}
