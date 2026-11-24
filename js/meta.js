// FifTeam Social's extras, each kept in a store message of its own on the feed service (social/config.json):
//   meta:     votes on rebassed songs, who follows whom, and everyone's "about me"
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
export function jsonStore(key, file, label, clean) {
  let queue = Promise.resolve(), seq = 0;
  async function read() {
    const cfg = await api.config();
    if (!cfg[key]) throw new Error("setup");
    const m = await api.dc(`/messages/${cfg[key]}`);
    const a = (m.attachments || []).find((x) => x.filename === file);
    return clean(a ? await (await fetch(a.url, { cache: "no-store" })).json() : null);
  }
  async function write(d) {
    const cfg = await api.config(), f = new FormData();
    f.append("payload_json", JSON.stringify({ content: `${label} (the app keeps this message up to date; please don't delete it)`, attachments: [{ id: 0, filename: file }], allowed_mentions: { parse: [] } }));
    f.append("files[0]", new Blob([JSON.stringify(d)], { type: "application/json" }), file);
    await api.dc(`/messages/${cfg[key]}`, { method: "PATCH", form: f });
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
  const out = { v: 1, votes: {}, follows: {}, about: {} };
  if (!d || typeof d !== "object") return out;
  // votes: the 800 newest posts that have any
  const vs = Object.entries(d.votes || {}).filter(([k]) => POST.test(k)).sort((a, b) => (BigInt(b[0]) > BigInt(a[0]) ? 1 : -1)).slice(0, 800);
  for (const [k, v] of vs) { const l = phones(v, 5000); if (l.length) out.votes[k] = l; }
  for (const [k, v] of Object.entries(d.follows || {}).slice(0, 5000)) if (PHONE.test(k)) { const l = phones(v, 1000).filter((x) => x !== k); if (l.length) out.follows[k] = l; }
  for (const [k, v] of Object.entries(d.about || {}).slice(0, 5000)) if (PHONE.test(k) && typeof v === "string" && v.trim()) out.about[k] = v.slice(0, 160);
  return out;
}
const metaStore = jsonStore("meta", "meta.json", "FifTeam votes, follows and about", cleanMeta);
const M = { d: cleanMeta(null), at: 0, loading: null, pending: new Map() };
export const meta = M;

/** The votes, follows and abouts, fetched again if they're older than maxAge (ms). */
export async function loadMeta(maxAge = 0) {
  if (M.loading) return M.loading;
  if (M.at && Date.now() - M.at < maxAge) return M.d;
  M.loading = (async () => { try { const d = await metaStore.read(); M.d = withPending(d); M.at = Date.now(); return M.d; } finally { M.loading = null; } })();
  return M.loading;
}
// changes from here still on their way: kept showing even if a copy without them comes back in the meantime
function withPending(d) { for (const fn of M.pending.values()) fn(d); return d; }
async function metaChange(key, fn, check) {
  M.pending.set(key, fn); fn(M.d);
  try { const now = await metaStore.change(fn, check); M.pending.delete(key); M.d = withPending(now); M.at = Date.now(); return true; }
  catch { M.pending.delete(key); try { M.d = withPending(await metaStore.read()); M.at = Date.now(); } catch {} return false; }
}

export const votesOf = (post) => M.d.votes[post] || [];
export const followingOf = (phone) => M.d.follows[phone] || [];
export const followersOf = (phone) => Object.keys(M.d.follows).filter((k) => M.d.follows[k].includes(phone));
export const aboutOf = (phone) => M.d.about[phone] || "";

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
export function setAbout(text) {
  const me = api.state.me, t = String(text || "").trim().slice(0, 160);
  const fn = (d) => { if (t) d.about[me] = t; else delete d.about[me]; };
  return metaChange("about", fn, (d) => (d.about[me] || "") === t);
}

// ---------------------------------------------------------------------------------------------------- who's online
// Every few minutes while the app is on screen: this phone's username, device and app version, with the time. Entries
// older than two days are dropped. (Nothing else: no place, no contacts.)
function cleanPresence(d) {
  const out = { v: 1, on: {} };
  const old = Date.now() - 2 * 86400e3;
  for (const [k, v] of Object.entries((d && d.on) || {}).slice(0, 5000)) if (PHONE.test(k) && v && +v.at > old)
    out.on[k] = { n: String(v.n || "").slice(0, 24), d: String(v.d || "").slice(0, 60), v: String(v.v || "").slice(0, 12), at: +v.at };
  return out;
}
const presenceStore = jsonStore("presence", "presence.json", "FifTeam who's online", cleanPresence);
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
