// FifTeam Social: pictures and rebassed songs from everyone using FifTeam Media. No accounts: pick a username, post.
//   Posts go to the feed service (social/config.json). The feed is a list kept in one message there (the "index": a
//   feed.json attached to it), each entry pointing at a post's message; a post's picture and song are read from its
//   own message when it comes into view (file links expire, so they are always fetched fresh). A message deleted on
//   the service is gone from the feed.
//   Everything from other people is shown as text (textContent), never as markup. @mentions never ping anyone.
import { $, toast, openSheet, closeSheet, fmtTime, bus, placeholderArt, getCtx, artUrl, pushLayer, dropLayer } from "./ui.js";
import { downloadAllowed, noteDownload } from "./premium.js";
import * as store from "./store.js";
import { library } from "./library.js";
import { player } from "./player.js";
import { fitJpeg, squareJpeg } from "./image.js";
import { makeFile, sizeText } from "./export.js";
import { myPublicKey, initDms, sendTo } from "./dms.js";
import { openProfile } from "./profile.js";
import { loadMeta, votesOf, setVote, meta, canSee, blocked, followersOf, aboutOf, setupOf } from "./meta.js";
import { initLive, streamsNow, canGoLive, goLive, watch, previewCard } from "./live.js";
import { bannedPhones, noPicPhones, checkBans, badgesOf, isPremium } from "./ban.js";
import { activityChanged, initActivity, openActivity } from "./activity.js";
import { hookFetch, holdFor } from "./limiter.js";
import { offensive, OFFENSIVE } from "./filter.js";
import { showMarket, marketOpen, loadMarket, renderMarket } from "./market.js";
import { hubOn, hubRead, hubWrite, hubFiles, startLive, live } from "./hub.js";
import { openReport } from "./report.js";

const NAME_KEY = "fifteam-social-name", MINE_KEY = "fifteam-social-mine", ME_KEY = "fifteam-social-me", AV_KEY = "fifteam-social-avatar";
const MAX_MSG = 9.5 * 1024 * 1024;   // what one post may carry (10 MB), with room to spare
const MAX_FEED = 300, MAX_VIDEO_SEC = 180, MAX_COMMENTS = 200;
const S = {
  cfg: null, name: "", editingName: false, mine: new Set(), feed: [], loadedAt: 0, loading: null, error: "", shown: 30,
  msgs: new Map(), gone: new Set(), queue: [], busy: 0, audio: null, playing: null,
  me: "", avatar: null, avatarUrl: "", liking: new Map(), sig: "", profiles: {}, avSync: null,
  muted: true, open: new Set(), vids: null,
};
// this phone, for likes (one like per phone and post): a random id, nothing else
try { S.me = localStorage.getItem(ME_KEY) || ""; if (!/^[a-z0-9]{10}$/.test(S.me)) { S.me = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""); localStorage.setItem(ME_KEY, S.me); } } catch {}
// the profile picture, kept on the phone as a small JPEG
try { const d = localStorage.getItem(AV_KEY); if (d && d.startsWith("data:image/jpeg")) { S.avatarUrl = d; S.avatar = dataBlob(d); } } catch {}
function dataBlob(d) { const b = atob(d.slice(d.indexOf(",") + 1)); return new Blob([Uint8Array.from(b, (c) => c.charCodeAt(0))], { type: "image/jpeg" }); }
try { S.name = localStorage.getItem(NAME_KEY) || ""; } catch {}
try { S.mine = new Set(JSON.parse(localStorage.getItem(MINE_KEY) || "[]")); } catch {}
const saveMine = () => { try { localStorage.setItem(MINE_KEY, JSON.stringify([...S.mine].slice(-500))); } catch {} };

// ---------------------------------------------------------------------------------------------------- the feed service
async function config() {
  if (S.cfg) return S.cfg;
  const r = await fetch(new URL("../social/config.json", import.meta.url), { cache: "no-cache" });
  const c = await r.json();
  if (!c.hook || !c.key || !c.index) throw new Error("setup");
  // (the key is kept reversed in the file, so robots that search code for links don't pick it up)
  S.cfg = { base: `https://discord.com/api/v10/webhooks/${c.hook}/${atob(c.key).split("").reverse().join("")}`, index: c.index, dm: c.dm || "", meta: c.meta || "", presence: c.presence || "", mod: c.mod || "", links: c.links || "", market: c.market || "", accounts: c.accounts || "" };
  return S.cfg;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** A request to the feed service, waiting and trying again if it says "slow down". */
async function dc(path, { method = "GET", form, json, low = false } = {}) {
  const { base } = await config();
  for (let attempt = 0; attempt < 5; attempt++) {
    let r;
    try {
      r = await hookFetch(base + path, { method, body: form || (json ? JSON.stringify(json) : undefined), headers: json ? { "Content-Type": "application/json" } : undefined, cache: "no-store" }, low);
    } catch { throw new Error("You're offline, or the feed can't be reached."); }
    if (r.status === 429) { let s = 1; try { s = (await r.json()).retry_after || 1; } catch {} holdFor(Math.min(10, s) * 1000 + 50); continue; }
    if (r.status === 204) return null;
    let data = null; try { data = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(r.status === 404 ? "gone" : r.status === 413 ? "That's too big to post (10 MB at most)." : `Couldn't reach the feed (${r.status}). Try again.`); e.status = r.status; throw e; }
    return data;
  }
  throw new Error("The feed is busy. Try again in a moment.");
}
/** The feed list, fresh: [{ id, at, user, text, image, song, by }] newest first, with .profiles: { phone id: { name,
 * av (the message holding their picture), at } }. */
async function readIndex() {
  await config();
  if (await hubOn()) {
    try {
      const { v, d } = await hubRead("index");
      const posts = clean(d && d.posts);
      posts.profiles = cleanProfiles(d && d.profiles); posts.ver = v;
      return posts;
    } catch (e) { if (!e.down) throw e; }
  }
  const m = await dc(`/messages/${S.cfg.index}`);
  const a = (m.attachments || []).find((x) => x.filename === "feed.json");
  if (!a) { const e = []; e.profiles = {}; return e; }
  const r = await fetch(a.url, { cache: "no-store" });
  const d = await r.json();
  const posts = clean(d && d.posts);
  posts.profiles = cleanProfiles(d && d.profiles);
  return posts;
}
async function writeIndex(posts) {
  // (through the server: taken only if nobody changed the list since it was read)
  if (posts.ver != null) { await hubWrite("index", posts.ver, { v: 1, posts: posts.slice(0, MAX_FEED), profiles: posts.profiles || {} }); return; }
  const f = new FormData();
  f.append("payload_json", JSON.stringify({ content: "FifTeam Social feed (the app keeps this message up to date; please don't delete it)", attachments: [{ id: 0, filename: "feed.json" }], allowed_mentions: { parse: [] } }));
  f.append("files[0]", new Blob([JSON.stringify({ v: 1, posts: posts.slice(0, MAX_FEED), profiles: posts.profiles || {} })], { type: "application/json" }), "feed.json");
  await dc(`/messages/${S.cfg.index}`, { method: "PATCH", form: f });
}
const keepGone = (list) => { const out = list.filter((p) => !S.gone.has(p.id)); out.profiles = list.profiles || {}; if (list.ver != null) out.ver = list.ver; return out; };
/** Change the feed list: read it fresh, change it, write it, check it took (someone posting at the same moment).
 *  This phone's changes go one at a time (a profile update and a comment sent together would otherwise write over
 *  each other), and each is looked at again a moment later: another phone that read the list just before this write
 *  can land its own copy on top of it, and then the change is made again (unless a newer one from here followed it). */
let indexQueue = Promise.resolve(), indexSeq = 0;
// (bumped by every change made here, as it starts and as it lands: a copy of the list read while one was on its way is
// older than what's on screen, and isn't used)
let indexVer = 0;
function changeIndex(change, check) {
  const seq = ++indexSeq;
  indexVer++;
  const run = indexQueue.then(() => changeIndexNow(change, check));
  indexQueue = run.catch(() => {});
  // (twice: the feed can answer with a copy a second or two old just after a write)
  run.then(() => { for (const ms of [3000, 10000]) setTimeout(() => {
    indexQueue = indexQueue.then(async () => {
      if (indexSeq !== seq) return;
      if (!check(await readIndex())) await changeIndexNow(change, check);
    }).catch(() => {});
  }, ms); }, () => {});
  return run;
}
async function changeIndexNow(change, check) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const posts = keepGone(await readIndex());
    change(posts);
    try { await writeIndex(posts); } catch (e) { if (e.conflict) { await wait(60 + Math.random() * 200); continue; } throw e; }
    const now = await readIndex();
    if (check(now)) { indexVer++; S.feed = keepGone(now); S.profiles = now.profiles; return; }
    await wait(400 + Math.random() * 800);
  }
  throw new Error("The feed was busy. Try again.");
}
function cleanProfiles(o) {
  const out = {};
  if (!o || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o).slice(0, 3000)) if (/^[a-z0-9]{6,16}$/.test(k) && v && typeof v === "object")
    out[k] = { name: str(v.name, 24), av: ID.test(v.av) ? v.av : "", at: +v.at || 0, pk: typeof v.pk === "string" && /^[A-Za-z0-9_-]{40,48}\.[A-Za-z0-9_-]{40,48}$/.test(v.pk) ? v.pk : "" };
  return out;
}
const ID = /^\d{5,25}$/;
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
function clean(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_FEED).map((p) => {
    if (!p || !ID.test(p.id)) return null;
    const s = p.song && typeof p.song === "object" ? { title: str(p.song.title, 120) || "Rebass", artist: str(p.song.artist, 80), note: str(p.song.note, 80), duration: +p.song.duration || 0 } : null;
    const likes = Array.isArray(p.likes) ? [...new Set(p.likes.filter((x) => typeof x === "string" && /^[a-z0-9]{6,16}$/.test(x)))].slice(0, 5000) : [];
    const comments = (Array.isArray(p.comments) ? p.comments : []).slice(-MAX_COMMENTS).map((c) => (c && /^[a-z0-9]{6,20}$/.test(c.id) && str(c.text, 300).trim()
      ? { id: c.id, by: /^[a-z0-9]{6,16}$/.test(c.by) ? c.by : "", user: str(c.user, 24) || "someone", text: str(c.text, 300), at: +c.at || 0,
          re: /^[a-z0-9]{6,20}$/.test(c.re) ? c.re : "", likes: Array.isArray(c.likes) ? [...new Set(c.likes.filter((x) => typeof x === "string" && /^[a-z0-9]{6,16}$/.test(x)))].slice(0, 2000) : [] } : null)).filter(Boolean);
    const video = p.video === "mp4" || p.video === "webm" ? p.video : "";
    const pl = p.playlist && typeof p.playlist === "object" && Array.isArray(p.playlist.items) ? {
      name: str(p.playlist.name, 60) || "Playlist",
      items: p.playlist.items.filter((x) => x && ID.test(x.id)).slice(0, 25).map((x) => ({ id: x.id, title: str(x.title, 120) || "Song", artist: str(x.artist, 80), note: str(x.note, 80), duration: +x.duration || 0 })),
    } : null;
    const media = Array.isArray(p.media) ? p.media.filter((k) => k === "i" || k === "mp4" || k === "webm").slice(0, 10) : [];
    const music = (p.image || (media.includes("i") && !media.some((k) => k !== "i"))) && p.music && typeof p.music === "object" ? { title: str(p.music.title, 120) || "Music", artist: str(p.music.artist, 80), len: Math.max(1, Math.min(60, +p.music.len || 0)) } : null;
    // (priv: only the poster sees it; shares: who sent it to someone. Always written, so the server can tell an
    // older app that doesn't know them from a phone that changed them)
    const shares = Array.isArray(p.shares) ? [...new Set(p.shares.filter((x) => typeof x === "string" && /^[a-z0-9]{6,16}$/.test(x)))].slice(0, 500) : [];
    const box = typeof p.box === "string" && /^[A-Za-z0-9_-]{20,8000}$/.test(p.box) ? p.box : "";
    return { ...(box ? { box } : {}), priv: p.priv ? 1 : 0, shares, id: p.id, at: +p.at || 0, edited: +p.edited || 0, user: str(p.user, 24) || "someone", text: str(p.text, 500), image: !!p.image, avatar: !!p.avatar, song: s, likes, by: /^[a-z0-9]{6,16}$/.test(p.by) ? p.by : "", video, comments, music, media, playlist: pl && pl.items.length ? pl : null };
  }).filter(Boolean);
}
/** A post's message (for its picture and song links), fetched once per load, a couple at a time. */
// Each file link says when it stops working (its "ex", in hex seconds); a post's links are kept on the phone until
// shortly before then, so a post seen before needs no request to show its picture, video or song.
const LINKS = "fifteam-links";
let links = {};
try { links = JSON.parse(localStorage.getItem(LINKS) || "{}") || {}; } catch {}
let linksTimer = 0;
function writeLinks() {
  clearTimeout(linksTimer); linksTimer = 0;
  const now = Date.now(), keep = Object.entries(links).filter(([, v]) => v.ex - now > 15 * 60e3).sort((a, b) => b[1].ex - a[1].ex).slice(0, 500);
  links = Object.fromEntries(keep);
  try { localStorage.setItem(LINKS, JSON.stringify(links)); } catch {}
}
function saveLinks() { clearTimeout(linksTimer); linksTimer = setTimeout(writeLinks, 800); }
// (and at once when the app is closed or put away)
addEventListener("pagehide", () => { if (linksTimer) writeLinks(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && linksTimer) writeLinks(); });
function expiryOf(atts) {
  let ex = Infinity;
  for (const a of atts) { const x = /[?&]ex=([0-9a-f]+)/.exec(a.url || ""); if (x) ex = Math.min(ex, parseInt(x[1], 16) * 1000); }
  return ex === Infinity ? Date.now() + 6 * 3600e3 : ex;
}
/** Every post's file links at once, kept fresh by the FifTeam bot: one read instead of one per post (at most every
 * 20 minutes; posts it doesn't have, or that have expired, are still read one by one). */
let linksAt = 0;
try { linksAt = +localStorage.getItem(LINKS + "-at") || 0; } catch {}
async function loadLinks() {
  const cfg = await config();
  if (await hubOn()) return;          // (the server hands out each post's links as they're needed, many at once)
  if (!cfg.links || Date.now() - linksAt < 20 * 60e3) return;
  const m = await dc(`/messages/${cfg.links}`), f = fileOf(m, "links.json");
  if (!f) return;
  const d = await (await fetch(f.url, { cache: "no-store" })).json();
  let n = 0;
  for (const [id, a] of Object.entries((d && d.links) || {})) {
    if (!/^\d{5,25}$/.test(id) || !Array.isArray(a)) continue;
    const at = a.filter((x) => x && typeof x.filename === "string" && /^https:\/\/cdn\.discordapp\.com\//.test(x.url || "")).map(({ filename, url }) => ({ filename, url }));
    const ex = expiryOf(at);
    if (at.length && ex - Date.now() > 15 * 60e3 && (!links[id] || links[id].ex < ex)) { links[id] = { a: at, ex }; S.msgs.delete(id); n++; }
  }
  linksAt = Date.now();
  try { localStorage.setItem(LINKS + "-at", String(linksAt)); } catch {}
  if (n) writeLinks();
}
function message(id, low = false) {
  if (S.msgs.has(id)) return S.msgs.get(id);
  const c = links[id];
  if (c && c.ex - Date.now() > 15 * 60e3) {
    const p = Promise.resolve({ id, attachments: c.a }); S.msgs.set(id, p);
    // (pulled down to refresh: shown from what's remembered at once, and checked again behind it, in case it's gone)
    if (S.recheck) dc(`/messages/${id}`, { low: true }).then((m) => { const a = ((m && m.attachments) || []).map(({ filename, url }) => ({ filename, url })); if (a.length) { links[id] = { a, ex: expiryOf(a) }; saveLinks(); } }, (e) => { if (e && e.status === 404) gone(id); });
    return p;
  }
  const p = (async () => {
    if (await hubOn()) {
      try {
        const a = await hubFiles(id);
        if (a === null) { const e = new Error("gone"); e.status = 404; throw e; }
        return { id, attachments: a };
      } catch (e) { if (e.status === 404) throw e; }
    }
    return dc(`/messages/${id}`, { low });
  })();
  S.msgs.set(id, p);
  p.then((m) => { const a = ((m && m.attachments) || []).map(({ filename, url }) => ({ filename, url })); if (a.length) { links[id] = { a, ex: expiryOf(a) }; saveLinks(); } }, () => { S.msgs.delete(id); });
  return p;
}
/** A post (or picture) whose message is gone: off the screen, and forgotten. */
function gone(id) {
  delete links[id]; saveLinks();
  S.gone.add(id);
  document.querySelectorAll(`#so-body .so-post[data-id="${id}"]`).forEach((c) => c.remove());
}
const fileOf = (m, name) => ((m && m.attachments) || []).find((a) => a.filename === name);
// A song is stored as song.mp4, its MP3 bytes lightly scrambled behind a "FTS1" mark: the file service only lets the app
// download files it doesn't take for audio, and it recognises MP3s by what's inside them.
const songOf = (m) => fileOf(m, "song.mp4") || fileOf(m, "song.mp3");
const MARK = [0x46, 0x54, 0x53, 0x31];
const mix = (u8, from) => { for (let i = from; i < u8.length; i++) u8[i] ^= (0x5a + (i - from) * 13) & 255; return u8; };
async function scramble(blob) {
  const raw = new Uint8Array(await blob.arrayBuffer()), out = new Uint8Array(raw.length + 4);
  out.set(MARK); out.set(raw, 4);
  return new Blob([mix(out, 4)], { type: "video/mp4" });
}
function unscramble(buf) {
  const u8 = new Uint8Array(buf);
  return MARK.every((b, i) => u8[i] === b) ? mix(u8, 4).subarray(4) : u8;
}

// ---------------------------------------------------------------------------------------------------- the screen
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const icon = (id) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + id); s.appendChild(u); return s; };
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + " min"; if (s < 86400) return Math.floor(s / 3600) + " h";
  if (s < 604800) return Math.floor(s / 86400) + " d";
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
const NAME_OK = /^[\p{L}\p{N} _.\-]{2,24}$/u;
/** Who wrote it, by their username now (a username changed later shows on their older posts and comments too). */
const nameOf = (x) => (x.by && x.by === S.me && S.name) || (x.by && S.profiles[x.by] && S.profiles[x.by].name) || x.user;
const hidden = (x) => !!(x.by && (bannedPhones().has(x.by) || blocked(S.me, x.by)));
/** A name with the tags the FifTeam team gave them (FifTeam Founder, FifTeam Media Developer, FifTeam Advertiser,
 * FifTeam Member), and FifTeam Premium on its own for anyone with Premium. */
const TAGS = { founder: "FifTeam Founder", dev: "FifTeam Media Developer", advertiser: "FifTeam Advertiser", member: "FifTeam Member", premium: "FifTeam Premium" };
function nameLine(name, phone) {
  const w = h("span", "nline"); w.append(h("b", "", name));
  if (!phone && name) phone = findPhone(name);      // (older posts and comments don't say which phone: by username)
  for (const t of [...badgesOf(phone), ...(isPremium(phone) ? ["premium"] : [])]) w.append(h("span", "tag tag-" + t, TAGS[t]));
  return w;
}
/** The picture in the top bar (always there): your page, or first a username. */
function paintMe() {
  const b = $("btn-me"); if (!b) return;
  const av = b.querySelector(".me-av");
  av.style.backgroundImage = `url("${S.avatarUrl || placeholderArt(S.name || "?")}")`;
  b.setAttribute("aria-label", S.name ? `Your profile (${S.name})` : "Your profile");
}
function openMe() {
  if (!S.name) { location.hash = "#social"; S.editingName = true; render(); setTimeout(() => { const i = document.querySelector("#so-body .so-nameform input"); if (i) i.focus(); }, 150); toast("Pick a username first"); return; }
  openProfile({ by: S.me, user: S.name });
}
/** A post this phone may see: not from a banned phone, and not from a private account that hasn't let it in. */
const visible = (p) => !hidden(p) && canSee(S.me, p.by) && (!p.priv || mineAs(p));
const commentsOf = (p) => p.comments.filter((c) => !hidden(c));
/** The rebassed song with the most votes from the last seven days (none until one has a vote). */
function weekly(posts) {
  const since = Date.now() - 7 * 86400e3, banned = bannedPhones();
  let best = null, bv = 0;
  for (const p of posts) {
    if (!p.song || p.priv || p.at < since) continue;
    const v = votesOf(p.id).filter((x) => !banned.has(x)).length;
    if (v > bv || (v && v === bv && p.likes.length > best.likes.length)) { best = p; bv = v; }
  }
  return best;
}

let seen = null;
function avatarEl(size, url, name) {
  const a = h("span", "so-av"); a.style.width = a.style.height = size + "px";
  a.style.backgroundImage = `url("${url || placeholderArt(name || "?")}")`;
  return a;
}
// Drawing the feed again keeps what's already on screen: each post's card (with its loaded pictures, a song or video
// playing, where it's scrolled to) stays as it is unless the post itself changed; new posts go in where they belong,
// gone ones come out, and the counts are brought up to date in place. Scrolled down the feed, what you're looking at
// stays where it is (new posts above it don't push it down; a "New posts" button takes you up to them).
let OLD = new Map();
/** The node for key from what's on screen if it was drawn the same way (sig), else a new one from make(). */
function keep(key, sig, make) {
  const o = OLD.get(key);
  if (o && o._sig === sig) { OLD.delete(key); return o; }
  const n = make(); n._key = key; n._sig = sig; return n;
}
/** What a post's card shows apart from its counts: the same, and its card can stay. */
function cardSig(p) {
  const { likes, comments, ...rest } = p;
  return JSON.stringify(rest) + "|" + nameOf(p) + "|" + nameLine(nameOf(p), p.by).textContent + "|" + (pictureFor(p) || "") + "|" + (mineAs(p) ? "me" + (S.avatarUrl || "") : "");
}
/** A post's card: the one on screen if it still fits (its counts and time brought up to date), else a new one. */
function cardFor(p) {
  const c = keep("p:" + p.id, cardSig(p), () => postCard(p));
  if (c._p && c._p !== p) {
    Object.assign(c._p, p);                            // (its buttons hold the post they were made with: kept current)
    const i = S.feed.indexOf(p); if (i >= 0) S.feed[i] = c._p;
  }
  const q = c._p || p;
  if (c._when) c._when.textContent = ago(q.at) + (q.edited ? " · edited" : "") + (q.priv ? " · 🔒 only you" : "");
  if (!S.liking.has(q.id)) { const lk = c.querySelector(".so-like"); if (lk) paintLike(lk, q); }
  paintCount(c, q);
  if (c._fill && seen && !c._filled) seen.observe(c);
  return c;
}
/** Put nodes in parent in order, moving as little as possible (a playing video or song isn't moved). */
function reconcile(parent, nodes) {
  const want = new Set(nodes);
  for (const c of [...parent.children]) if (!want.has(c)) c.remove();
  let ref = parent.firstElementChild;
  for (const n of nodes) { if (n === ref) { ref = ref.nextElementSibling; continue; } parent.insertBefore(n, ref); }
}
/** fresh: everything drawn new (pulled down to refresh: every post's files looked up again). */
function render(fresh = false) {
  paintMe();
  const real = $("so-body");
  if (!real) return;
  S.ids = sigIds(S.feed); S.shownError = S.error;
  // what's on screen now, by key
  OLD = new Map();
  if (fresh === true) { if (seen) seen.disconnect(); seen = null; }
  else {
    for (const c of real.children) if (c._key) OLD.set(c._key, c);
    for (const c of real.querySelectorAll(".so-week .so-post")) if (c._key) OLD.set(c._key, c);
  }
  // where you are: the first thing at least partly on screen, and how far from the top it is
  const view = $("view-social"), vt = view ? view.getBoundingClientRect().top : 0;
  let anchor = null, at = 0;
  if (view && view.scrollTop > 40) for (const c of real.children) { const r = c.getBoundingClientRect(); if (r.bottom > vt + 8) { anchor = c; at = r.top; break; } }
  const before = new Set([...real.querySelectorAll(".so-post")].map((c) => c.dataset.id));
  const out = [];
  renderInto({ append: (...n) => out.push(...n) });
  reconcile(real, out);
  OLD = new Map();
  // kept where you were; told about new posts above it
  if (anchor && anchor.isConnected) {
    const d = anchor.getBoundingClientRect().top - at;
    if (Math.abs(d) > 1) view.scrollTop += d;
    const fresh = [...real.querySelectorAll(".so-post")].filter((c) => !before.has(c.dataset.id) && c.getBoundingClientRect().bottom < vt);
    if (fresh.length && before.size) newPostsPill(fresh.length);
  }
}
/** "New posts" over the feed (scrolled down when they came in): tapped, up to the top. Gone when you get there. */
function newPostsPill(n) {
  const view = $("view-social"); if (!view) return;
  let b = $("so-newpill");
  if (!b) {
    b = h("button", "so-newpill"); b.id = "so-newpill"; b.type = "button";
    b.onclick = () => { view.scrollTo({ top: 0, behavior: "smooth" }); b.remove(); };
    const gone = () => { if (view.scrollTop < 60 || location.hash !== "#social") { b.remove(); view.removeEventListener("scroll", gone); removeEventListener("hashchange", gone); } };
    view.addEventListener("scroll", gone, { passive: true }); addEventListener("hashchange", gone);
    document.body.append(b);
  }
  b.textContent = `↑ New post${n === 1 ? "" : "s"}`;
}
function renderInto(body) {
  if (S.tab === "rebass") { renderRebasses(body); return; }
  // you: your picture (your profile) and "what's on your mind", or first of all a username
  const youSig = [S.name, S.editingName ? 1 : 0, S.avatarUrl || "", canGoLive() ? 1 : 0].join("|");
  const kept = OLD.get("you");
  if (kept && kept._sig === youSig) { OLD.delete("you"); body.append(kept); }
  else body.append(youCard(youSig));
  // who's live now (and, for the people who may, Go live): a row of circles on top of the feed
  const streams = streamsNow().filter((x) => !bannedPhones().has(x.by) && !blocked(S.me, x.by));
  if (streams.length || canGoLive()) {
    const sig = streams.map((x) => `${x.id}:${x.name}:${x.title}`).join("|") + "|" + (canGoLive() ? 1 : 0);
    const o = OLD.get("live");
    if (o && o._sig === sig) { OLD.delete("live"); body.append(o); } else { const n = liveRow(streams); n._key = "live"; n._sig = sig; body.append(n); }
  }
  renderFeed(body);
}
/** Who's live: a circle each (their picture in a red ring, LIVE under it), tapped to watch; Go live first for those
 * who may. */
function liveRow(streams) {
  const box = h("div", "so-livebox");
  // (the stream: a preview of it playing, tapped to watch; any others as circles)
  if (streams.length) box.append(previewCard(streams[0]));
  const row = h("div", "so-liverow"); row.setAttribute("aria-label", "Live now");
  if (canGoLive() && !streams.some((x) => x.by === S.me)) {
    const b = h("button", "so-lv so-golive"); b.type = "button";
    const c = h("span", "so-lvring go"); c.append(icon("i-live"));
    b.append(c, h("small", "", "Go live")); b.onclick = () => goLive();
    row.append(b);
  }
  for (const x of streams.slice(1)) {
    const b = h("button", "so-lv"); b.type = "button"; b.setAttribute("aria-label", `${x.name} is live${x.title ? ": " + x.title : ""}`);
    const ring = h("span", "so-lvring"), av = avatarEl(58, "", x.name);
    showPicture(av, { by: x.by, user: x.name, id: "" });
    ring.append(av, h("span", "so-lvtag", "LIVE"));
    b.append(ring, h("small", "", x.name));
    b.onclick = () => watch(x);
    row.append(b);
  }
  if (row.childElementCount) box.append(row);
  return box;
}
// ---------------------------------------------------------------------------------------------------- finding people
const fold = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
/** Everyone with a username (from the profiles, and anyone who has posted or commented), not you, not banned or
 * blocked: [{ key, ph (their phone; "" for older posts that only have a name), name, n (folded), extra, fans, su }]. */
function peopleList() {
  const people = new Map();
  for (const [ph, pr] of Object.entries(S.profiles || {})) if (pr && pr.name) people.set(ph, pr.name);
  // (older posts and comments may only have a name: found by it, their page opened by it)
  const names = new Set([...people.values()].map(fold));
  const add = (by, user) => { if (!user) return; if (by) { if (!people.has(by)) people.set(by, user); } else if (!names.has(fold(user))) { names.add(fold(user)); people.set("u:" + user, user); } };
  for (const p of S.feed) { if (!hidden(p)) add(p.by, p.user); for (const c of p.comments || []) if (!hidden(c)) add(c.by, c.user); }
  const myName = fold(S.name);
  return [...people].filter(([ph, name]) => ph !== S.me && !(ph.startsWith("u:") && fold(name) === myName) && !bannedPhones().has(ph) && !blocked(S.me, ph)).map(([key, name]) => {
    const ph = key.startsWith("u:") ? "" : key;
    const su = (ph && setupOf(ph)) || {};
    return { key, ph, name, n: fold(name), extra: ph ? fold([aboutOf(ph), su.subs, su.amps, su.vehicle].filter(Boolean).join(" ")) : "", fans: ph ? followersOf(ph).length : 0, su };
  });
}

// ---------------------------------------------------------------------------------------------------- @names
// "@Name" in a post, a comment or a live chat: the name highlighted, tapped for their page (when it's someone's
// username: the longest one that fits, so "@Big Mike" isn't read as "@Big"). While typing "@", names are suggested.
let nameIndex = { sig: "", list: [] };
function knownNames() {
  const sig = Object.keys(S.profiles || {}).length + "|" + S.feed.length + "|" + S.name;
  if (nameIndex.sig !== sig) {
    const list = peopleList().map((x) => ({ ph: x.ph, name: x.name, n: x.name.toLowerCase() }));
    if (S.name && S.me) list.push({ ph: S.me, name: S.name, n: S.name.toLowerCase() });
    nameIndex = { sig, list: list.sort((a, b) => b.n.length - a.n.length) };
  }
  return nameIndex.list;
}
/** Text with its @names as links (before: done first when one's tapped, like closing a live stream). */
export function richText(text, before) {
  const out = document.createDocumentFragment(), t = String(text || "");
  if (!t.includes("@")) { out.append(t); return out; }
  const names = knownNames(), low = t.toLowerCase();
  let i = 0, from = 0;
  while ((i = t.indexOf("@", i)) >= 0) {
    const okBefore = i === 0 || /[\s([{"'.,!?]/.test(t[i - 1]);
    const hit = okBefore ? names.find((x) => low.startsWith(x.n, i + 1) && !/[\p{L}\p{N}_]/u.test(t[i + 1 + x.n.length] || "")) : null;
    if (!hit) { i++; continue; }
    if (i > from) out.append(t.slice(from, i));
    const a = h("button", "mention", "@" + t.substr(i + 1, hit.n.length)); a.type = "button";
    a.onclick = (e) => { e.stopPropagation(); e.preventDefault(); if (before) before(); setTimeout(() => openProfile({ by: hit.ph, user: hit.name }), before ? 250 : 0); };
    out.append(a);
    i = from = i + 1 + hit.n.length;
  }
  if (from < t.length) out.append(t.slice(from));
  return out;
}
/** Names suggested while typing "@" in a box (a list just above it, or below; tapped, the name goes in). */
export function mentionBox(inp, { above = true, z = 140 } = {}) {
  if (!inp || inp._mention) return;
  inp._mention = true;
  let box = null, items = [], sel = 0, start = -1;
  const close = () => { if (box) { box.remove(); box = null; } };
  const place = () => {
    if (!box) return;
    const r = inp.getBoundingClientRect();
    box.style.left = Math.max(8, r.left) + "px"; box.style.width = Math.min(r.width, innerWidth - 16) + "px";
    if (above) { box.style.bottom = (innerHeight - r.top + 6) + "px"; box.style.top = ""; } else { box.style.top = (r.bottom + 6) + "px"; box.style.bottom = ""; }
  };
  const pick = (x) => {
    const pos = inp.selectionStart == null ? inp.value.length : inp.selectionStart, v = inp.value;
    inp.value = v.slice(0, start) + "@" + x.name + " " + v.slice(pos);
    const c = start + x.name.length + 2;
    try { inp.setSelectionRange(c, c); } catch {}
    close(); inp.focus();
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const paint = () => {
    if (!box) { box = h("div", "mn-box"); box.style.zIndex = String(z); box.setAttribute("role", "listbox"); document.body.append(box); }
    box.replaceChildren();
    items.forEach((x, k) => {
      const r = h("button", "mn-row" + (k === sel ? " on" : "")); r.type = "button"; r.setAttribute("role", "option");
      const av = avatarEl(28, "", x.name); if (x.ph) showPicture(av, { by: x.ph, user: x.name, id: "" });
      r.append(av, nameLine(x.name, x.ph));
      r.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(x); });
      box.append(r);
    });
    place();
  };
  const update = () => {
    const pos = inp.selectionStart == null ? inp.value.length : inp.selectionStart, before = inp.value.slice(0, pos);
    const m = /(^|[\s(])@([^@\n]{0,24})$/.exec(before);
    if (!m || /\s$/.test(m[2]) || /\s\S+\s/.test(m[2])) { close(); return; }
    start = pos - m[2].length - 1;
    const q = fold(m[2]);
    const seen = new Set();
    items = peopleList().filter((x) => !q || x.n.startsWith(q) || x.n.includes(q))
      .sort((a, b) => (b.n.startsWith(q) - a.n.startsWith(q)) || b.fans - a.fans || a.n.localeCompare(b.n))
      .filter((x) => { const k = x.n; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
    if (!items.length || (items.length === 1 && items[0].n === q && /\s$/.test(before))) { close(); return; }
    sel = 0; paint();
  };
  inp.addEventListener("input", update);
  inp.addEventListener("click", update);
  inp.addEventListener("blur", () => setTimeout(close, 180));
  inp.addEventListener("keydown", (e) => {
    if (!box) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length; paint(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); pick(items[sel]); }
    else if (e.key === "Escape") close();
  });
  addEventListener("resize", place);
}
/** Search for people by username (and what's in their about me and setup): tapped, their page. With nothing typed, the
 * people who are live and the most followed. */
async function openSearch() {
  try { await ensureProfiles(); } catch {}
  openSheet((panel) => {
    panel.classList.add("so-findpanel");
    panel.append(h("h3", "", "Find people"));
    const box = h("div", "search so-findbox");
    const inp = h("input", "input"); inp.type = "search"; inp.placeholder = "Search usernames"; inp.autocomplete = "off"; inp.setAttribute("aria-label", "Search usernames"); inp.enterKeyHint = "search";
    box.append(icon("i-search"), inp);
    const list = h("div", "so-flist");
    panel.append(box, list);
    const all = peopleList();
    const liveBy = new Set(streamsNow().map((x) => x.by));
    const row = (x) => {
      const r = h("button", "so-frow"); r.type = "button";
      const av = avatarEl(44, "", x.name); showPicture(av, { by: x.ph, user: x.name, id: "" });
      const t = h("div", "so-ftext"), top = h("div", "so-fname");
      top.append(nameLine(x.name, x.ph));
      if (liveBy.has(x.ph)) top.append(h("span", "so-flive", "LIVE"));
      const line = [x.su.vehicle, x.su.subs, x.su.db ? `${x.su.db} dB` : ""].filter(Boolean).join(" · ") || (x.ph && aboutOf(x.ph)) || "";
      t.append(top, h("small", "", `${x.fans} follower${x.fans === 1 ? "" : "s"}${line ? " · " + line : ""}`));
      r.append(av, t);
      r.onclick = () => { closeSheet(); setTimeout(() => openProfile({ by: x.ph, user: x.name }), 260); };
      return r;
    };
    const paint = () => {
      const q = fold(inp.value);
      list.replaceChildren();
      let shown;
      if (!q) {
        shown = [...all].sort((a, b) => (liveBy.has(b.ph) - liveBy.has(a.ph)) || b.fans - a.fans || a.n.localeCompare(b.n)).slice(0, 25);
        if (shown.length) list.append(h("small", "label so-fhead", "Suggested"));
      } else {
        const score = (x) => (x.n === q ? 5 : x.n.startsWith(q) ? 4 : x.n.split(/[ _.\-]/).some((w) => w.startsWith(q)) ? 3 : x.n.includes(q) ? 2 : x.extra.includes(q) ? 1 : 0);
        shown = all.map((x) => [x, score(x)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || b[0].fans - a[0].fans || a[0].n.localeCompare(b[0].n)).slice(0, 40).map(([x]) => x);
      }
      for (const x of shown) list.append(row(x));
      if (!shown.length) list.append(h("p", "status so-fnone", q ? `Nobody called "${inp.value.trim()}".` : "Nobody here yet."));
    };
    let t = 0;
    inp.oninput = () => { clearTimeout(t); t = setTimeout(paint, 80); };
    paint();
    setTimeout(() => inp.focus(), 60);
  });
}
function youCard(sig) {
  const you = h("div", "card so-you"); you._key = "you"; you._sig = sig;
  if (S.name && !S.editingName) {
    const row = h("div", "so-compose-row");
    const me = h("button", "so-avbtn"); me.setAttribute("aria-label", "Your profile"); me.append(avatarEl(42, S.avatarUrl, S.name));
    me.onclick = () => openProfile({ by: S.me, user: S.name });
    const pill = h("button", "so-pill so-new", `What's on your mind, ${S.name.split(" ")[0]}?`); pill.onclick = () => composer({});
    row.append(me, pill);
    const quick = h("div", "so-quick");
    const q = (ic, label, fn) => { const x = h("button", "so-qbtn"); x.append(icon(ic), h("span", "", label)); x.onclick = fn; quick.append(x); };
    q("i-image", "Photo", () => composer({ pick: "image" }));
    q("i-video", "Video", () => composer({ pick: "video" }));
    q("i-bass", "Rebass", () => pickRebass((song) => composer({ song })));
    if (canGoLive()) { q("i-live", "Go live", () => goLive()); quick.classList.add("four"); }
    you.append(row, quick);
  } else {
    const pic = h("button", "so-avbtn so-avpick"); pic.setAttribute("aria-label", "Profile picture"); pic.append(avatarEl(48, S.avatarUrl, S.name || "?"));
    pic.onclick = pickAvatar;
    const f = h("form", "so-nameform");
    const inp = h("input", "input"); inp.maxLength = 24; inp.placeholder = "Pick a username"; inp.value = S.name; inp.setAttribute("aria-label", "Username"); inp.autocomplete = "off";
    const go = h("button", "btn primary", "Save"); go.type = "submit";
    const err = h("p", "set-err");
    f.append(pic, inp, go); you.append(f, err);
    if (S.name) { const x = h("button", "btn small", "Cancel"); x.type = "button"; x.onclick = () => { S.editingName = false; render(); }; f.append(x); }
    f.onsubmit = (e) => {
      e.preventDefault();
      const v = inp.value.trim().replace(/\s+/g, " ");
      if (!NAME_OK.test(v)) { err.textContent = "2 to 24 letters, numbers, spaces, _ . or -"; return; }
      if (offensive(v)) { err.textContent = OFFENSIVE; return; }
      if (nameTaken(v)) { err.textContent = `"${v}" is taken. Try another.`; return; }
      setName(v);
    };
  }
  return you;
}
function renderFeed(body) {
  if (S.error) body.append(h("p", "status", S.error));
  const all = S.feed.filter((p) => !S.gone.has(p.id) && visible(p));
  // the rebass of the week, on top
  const top = weekly(all);
  S.weekId = top ? top.id : "";
  const posts = all.filter((p) => p !== top);
  if (!all.length) {
    const e = h("div", "card so-empty");
    e.append(h("b", "", S.loading ? "Loading…" : "Nothing here yet"), h("p", "status", S.loading ? "" : "Be the first to post."));
    body.append(e); return;
  }
  watcher();
  if (top) body.append(weekBox(top));
  for (const p of posts.slice(0, S.shown)) body.append(cardFor(p));
  if (posts.length > S.shown) { const m = h("button", "btn block", "Show more"); m.onclick = () => { S.shown += 30; render(); }; body.append(m); }
}
// ---------------------------------------------------------------------------------------------------- Community Rebass
// The Rebasses tab: only the rebassed songs people have posted (and their shared rebass playlists), apart from the feed,
// newest first, or the most votes this week, or the most liked. A song that ends starts the next one down.
const RB_SORT = "fifteam-rebass-sort";
try { S.rbSort = localStorage.getItem(RB_SORT) || "new"; } catch { S.rbSort = "new"; }
function rebassList() {
  const all = S.feed.filter((p) => !S.gone.has(p.id) && visible(p) && !p.priv && (p.song || p.playlist));
  const banned = bannedPhones(), votes = (p) => votesOf(p.id).filter((x) => !banned.has(x)).length;
  if (S.rbSort === "top") { const since = Date.now() - 7 * 86400e3; return all.filter((p) => p.at >= since).sort((a, b) => votes(b) - votes(a) || b.likes.length - a.likes.length || b.at - a.at); }
  if (S.rbSort === "liked") return all.sort((a, b) => b.likes.length - a.likes.length || votes(b) - votes(a) || b.at - a.at);
  return all.sort((a, b) => b.at - a.at);
}
function renderRebasses(body) {
  const old = OLD.get("rbhead");
  if (old && old._sig === S.rbSort) { OLD.delete("rbhead"); body.append(old); }
  else body.append(rbHead());
  rebassRest(body);
}
function rbHead() {
  const head = h("div", "card so-rbhead"); head._key = "rbhead"; head._sig = S.rbSort;
  const t = h("div", "so-rbtitle"); t.append(h("span", "so-rbico", "🔥"), h("div", "", null));
  t.lastChild.append(h("b", "", "Community Rebass"), h("small", "", "Every rebassed song people have posted, in one place"));
  const sort = h("div", "chips so-rbsort");
  for (const [k, label] of [["new", "Newest"], ["top", "Top this week"], ["liked", "Most liked"]]) {
    const c = h("button", "chip" + (S.rbSort === k ? " on" : ""), label); c.dataset.k = k;
    c.onclick = () => { S.rbSort = k; try { localStorage.setItem(RB_SORT, k); } catch {} S.shown = 30; render(); };
    sort.append(c);
  }
  const post = h("button", "btn small primary so-rbpost"); post.append(icon("i-bass"), "Post a rebass");
  post.onclick = () => (S.name ? pickRebass((song) => composer({ song })) : toast("Pick a username in the Feed tab first"));
  head.append(t, sort, post);
  return head;
}
function rebassRest(body) {
  if (S.error) body.append(h("p", "status", S.error));
  const list = rebassList();
  S.rbList = list.filter((p) => p.song).map((p) => p.id);
  if (!list.length) {
    const e = h("div", "card so-empty");
    e.append(h("b", "", S.loading ? "Loading…" : S.rbSort === "top" ? "No rebasses this week yet" : "No rebasses yet"), h("p", "status", S.loading ? "" : "Post the first one: tap Post a rebass."));
    body.append(e); return;
  }
  watcher();
  // (newest first: the rebass of the week on top, as in the feed)
  const top = S.rbSort === "new" ? weekly(list) : null;
  if (top) body.append(weekBox(top));
  const rest = list.filter((p) => p !== top);
  for (const p of rest.slice(0, S.shown)) body.append(cardFor(p));
  if (rest.length > S.shown) { const m = h("button", "btn block", "Show more"); m.onclick = () => { S.shown += 30; render(); }; body.append(m); }
}
/** The one watcher that fills in a card's pictures, video and song when it nears the screen. */
function watcher() {
  if (seen || !("IntersectionObserver" in window)) return;
  seen = new IntersectionObserver((es) => { for (const x of es) if (x.isIntersecting) { seen.unobserve(x.target); if (x.target._fill && !x.target._filled) { x.target._filled = true; x.target._fill(); } } }, { rootMargin: "400px" });
}
/** The rebass of the week, on top: kept while it's the same post drawn the same way. */
function weekBox(top) {
  const old = OLD.get("week"), oc = old && old.querySelector(".so-post");
  if (old && oc && oc._key === "p:" + top.id && oc._sig === cardSig(top)) { OLD.delete("week"); cardFor(top); return old; }
  const w = h("section", "so-week"); w._key = "week"; w._sig = top.id;
  const t = h("div", "so-week-h"); t.append(h("span", "so-trophy", "🏆"), h("b", "", "Rebass of the week"), h("small", "", "top votes · 7 days"));
  w.append(t, cardFor(top));
  return w;
}
/** In the Rebasses tab, a song that ends: the next one down plays (scrolled into view). */
function playNextRebass(id) {
  if (S.tab !== "rebass" || location.hash !== "#social" || !S.rbList) return;
  const i = S.rbList.indexOf(id), next = i >= 0 ? S.rbList[i + 1] : null;
  if (!next) return;
  const card = document.querySelector(`#so-body .so-post[data-id="${next}"]`), p = S.feed.find((x) => x.id === next);
  const block = card && card.querySelector(".so-song");
  if (!card || !p || !block) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  playSong(p, block);
}
/** Feed, Rebasses or Audio Market. */
function showTab(k) {
  S.tab = k === "rebass" ? "rebass" : "feed";
  showMarket(k === "market");
  document.querySelectorAll("#so-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
  try { localStorage.setItem("fifteam-social-tab", k); } catch {}
  if (k !== "market") { S.shown = 30; render(); $("view-social").scrollTop = 0; }
}
/** A choice of profile picture: cropped square, small, kept on the phone and put on the feed, where it shows on every
 * post this phone has made or will make, for everyone. */
async function pickAvatar() {
  const f = await pickAny();
  if (!f) return;
  try {
    const b = await squareJpeg(f, 160);
    const d = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); });
    S.avatar = b; S.avatarUrl = d;
    try { localStorage.setItem(AV_KEY, d); localStorage.removeItem(AV_KEY + "-sent"); } catch {}
    render();
    if (S.avSync) await S.avSync;                        // (one being sent already: this one goes after it)
    await syncProfile(true);
    toast("Profile picture set");
  } catch { toast("Couldn't set that picture. Try again."); }
}
/** This phone's picture and name on the feed's profiles (once per change; again later if it couldn't be sent). */
/** Whether someone else already has this username. */
const nameTaken = (v) => Object.entries(S.profiles || {}).some(([ph, p]) => ph !== S.me && p && String(p.name || "").toLowerCase() === v.toLowerCase());
/** This phone's username: kept, shown, and put on its profile. */
export function setName(v) {
  S.name = v; S.editingName = false;
  try { localStorage.setItem(NAME_KEY, v); } catch {}
  try { render(); } catch {}
  dispatchEvent(new Event("fifteam-named"));
  return syncProfile();
}
function syncProfile(force) {
  if (S.avSync) return S.avSync;
  S.avSync = (async () => {
    await config();
    const pr = S.profiles[S.me];
    let sent = ""; try { sent = localStorage.getItem(AV_KEY + "-sent") || ""; } catch {}
    let needPic = S.avatar && !noPicPhones().has(S.me) && (force || !pr || !pr.av || sent !== (pr && pr.av));
    // (before sending a picture: the moderators' latest list, in case they've just taken this phone's down)
    if (needPic) { await checkBans(); needPic = !noPicPhones().has(S.me); }
    const needName = S.name && pr && pr.name !== S.name;
    const pk = await myPublicKey(), needKey = pk && pr && pr.pk !== pk;
    if (!needPic && !needName && !needKey && pr) return;
    if (!S.avatar && !S.name) return;
    let av = pr && pr.av ? pr.av : "";
    if (needPic) {
      const f = new FormData();
      f.append("payload_json", JSON.stringify({ content: "", username: `${S.name || "FifTeam"} · FifTeam`.replace(/discord|clyde/gi, "").slice(0, 80), allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: "avatar.jpg" }] }));
      f.append("files[0]", S.avatar, "avatar.jpg");
      const m = await dc("?wait=true", { method: "POST", form: f });
      const old = av; av = m.id;
      if (old && old !== av) dc(`/messages/${old}`, { method: "DELETE" }).catch(() => {});
    }
    const me = { name: S.name, av, at: Date.now(), pk };
    await changeIndex((posts) => { posts.profiles = posts.profiles || {}; posts.profiles[S.me] = me; }, (now) => now.profiles && now.profiles[S.me] && now.profiles[S.me].av === av, true);
    try { if (av) localStorage.setItem(AV_KEY + "-sent", av); } catch {}
  })().catch(() => {}).finally(() => { S.avSync = null; });
  return S.avSync;
}

/** The message holding a post's poster's picture ("" if none): their profile, found by their phone or (older posts) by name. */
function pictureFor(p) {
  const pr = S.profiles || {};
  if (p.by && pr[p.by] && pr[p.by].av) return pr[p.by].av;
  let best = null;
  for (const v of Object.values(pr)) if (v.av && v.name && v.name === p.user && (!best || v.at > best.at)) best = v;
  return best ? best.av : "";
}
const mineAs = (p) => p.by === S.me || S.mine.has(p.id);
async function showPicture(av, p) {
  if (p.by && noPicPhones().has(p.by)) return;
  if (mineAs(p) && S.avatarUrl) { av.style.backgroundImage = `url("${S.avatarUrl}")`; return; }
  const id = pictureFor(p);
  if (!id) return;
  try { const m = await message(id), f = fileOf(m, "avatar.jpg"); if (f) av.style.backgroundImage = `url("${f.url}")`; } catch {}
}
function postCard(p) {
  const card = h("article", "card so-post");
  card.dataset.id = p.id; card._p = p;
  // (a gentle fade in, the first time a post shows; not again when the list is redrawn)
  S.shownCards = S.shownCards || new Set();
  if (!S.shownCards.has(p.id)) { S.shownCards.add(p.id); card.classList.add("so-enter"); card.addEventListener("animationend", () => card.classList.remove("so-enter"), { once: true }); }
  const name = nameOf(p);
  const head = h("div", "so-head");
  const who = h("div", "so-who");
  const av = avatarEl(40, "", name);
  showPicture(av, p);
  av.classList.add("tap"); av.setAttribute("role", "button"); av.setAttribute("aria-label", `${name}'s profile`);
  const nm = h("span", "so-name tap"), when = h("small", "", ago(p.at) + (p.edited ? " · edited" : "") + (p.priv ? " · 🔒 only you" : ""));
  nm.append(nameLine(name, p.by), when); card._when = when;
  av.onclick = nm.onclick = () => openProfile({ by: p.by, user: p.user });
  who.append(av, nm); head.append(who);
  { const d = h("button", "so-more"); d.setAttribute("aria-label", "More"); d.append(icon("i-more")); d.onclick = () => (S.mine.has(p.id) || mineAs(p) ? postMenu(p) : otherMenu(p)); head.append(d); }
  card.append(head);
  if (p.music) { card.append(musicRow(p)); clipWatch(card, p); }
  if (p.text) { const tx = h("p", "so-text"); tx.append(richText(p.text)); card.append(tx); }
  let img = null, song = null, vid = null;
  let col = null;
  if (p.media.length) { col = collage(p); card.append(col); }
  if (p.image) { img = h("div", "so-img so-wait"); card.append(img); }
  if (p.video) { vid = videoBlock(p); card.append(vid); }
  if (p.song) { song = songBlock(p); card.append(song); }
  if (p.playlist) card.append(playlistBlock(p));
  if (p.box) {
    const ob = h("button", "btn small so-boxopen"); ob.type = "button"; ob.append(icon("i-box"), "Open this build in the box creator");
    ob.onclick = () => import("./box.js").then((m) => m.box.openShared(p.box));
    card.append(ob);
  }
  // the counts, then Like, Comment and (a rebassed song) Vote
  const stats = h("div", "so-stats");
  const sl = h("span", "so-slikes"), sv = h("span", "so-svotes"), sc = h("button", "so-scom");
  sc.onclick = () => openComments(p.id);
  const left = h("span", "so-sleft"); left.append(sl, sv);
  stats.append(left, sc);
  card.append(stats);
  const bar = h("div", "so-bar");
  const lk = h("button", "so-like"); lk.dataset.id = p.id;
  lk.append(h("span", "so-heart", "♥"), h("span", "so-lbl", "Like"));
  lk.onclick = () => like(p, lk);
  const cm = h("button", "so-cbtn"); cm.dataset.id = p.id; cm.setAttribute("aria-label", "Comments");
  cm.append(icon("i-chat"), h("span", "so-lbl", "Comment"));
  cm.onclick = () => openComments(p.id);
  bar.append(lk, cm);
  if (p.song) {
    const vt = h("button", "so-vote"); vt.dataset.id = p.id;
    vt.append(h("span", "so-fire", "🔥"), h("span", "so-lbl", "Vote"));
    vt.onclick = () => vote(p, vt);
    bar.append(vt);
  }
  const sd = h("button", "so-cbtn so-send"); sd.setAttribute("aria-label", "Send in a message");
  sd.append(icon("i-send"), h("span", "so-lbl", "Send"));
  sd.onclick = () => sendTo({ post: p });
  bar.append(sd);
  card.append(bar);
  paintLike(lk, p);
  paintCount(card, p);
  // the pictures, video and song links, from the post's own message, once it is near the screen
  if (p.image || p.song || p.avatar || p.video || p.media.length || p.playlist) {
    card._fill = async () => {
      try {
        const m = await message(p.id);
        const pic = fileOf(m, "picture.jpg"), mp3 = songOf(m), cov = fileOf(m, "cover.jpg"), face = fileOf(m, "avatar.jpg");
        if (face && !pictureFor(p) && !(mineAs(p) && S.avatarUrl)) av.style.backgroundImage = `url("${face.url}")`;
        if (img && pic) { const i = h("img", "so-img"); i.alt = p.text ? p.text.slice(0, 80) : "A picture"; i.decoding = "async"; i.onload = () => i.classList.add("in"); i.onerror = () => i.classList.add("in"); i.src = pic.url; i.onclick = () => openViewer({ post: p, src: pic.url }); img.replaceWith(i); }
        if (song) { song._url = mp3 && mp3.url; if (cov) song.querySelector(".so-cover").style.backgroundImage = `url("${cov.url}")`; }
        if (vid) { const f = fileOf(m, "video." + p.video), po = fileOf(m, "poster.jpg"); vid._attach(f && f.url, po && po.url); }
        if (col) col._attach(m);
        if (p.playlist && cov) card.querySelector(".so-plcover").style.backgroundImage = `url("${cov.url}")`;
      } catch (e) {
        if (e.status === 404) { S.gone.add(p.id); card.remove(); }
        else if (img) img.textContent = "Couldn't load the picture";
      }
    };
    if (seen) seen.observe(card); else { card._filled = true; card._fill(); }
  }
  return card;
}
// ---------------------------------------------------------------------------------------------------- shared playlists
/** A playlist in the feed: its cover, name and songs, each to play or add; or all of them at once, as a category. (No
 * vote: a playlist can't be the rebass of the week.) */
function playlistBlock(p) {
  const pl = p.playlist, box = h("div", "so-pl");
  const top = h("div", "so-pltop");
  const cov = h("span", "so-plcover"); cov.style.backgroundImage = `url("${placeholderArt(pl.name, "rebass")}")`;
  const meta = h("div", "so-smeta"); meta.append(h("small", "so-pltag", "Playlist"), h("b", "", pl.name), h("small", "", `${pl.items.length} song${pl.items.length === 1 ? "" : "s"} · ${fmtTime(pl.items.reduce((a, x) => a + x.duration, 0))}`));
  const all = h("button", "btn small", "Add all"); all.onclick = () => addPlaylist(p, all);
  top.append(cov, meta, all);
  box.append(top);
  const list = h("div", "so-pllist");
  const show = (n) => {
    list.replaceChildren();
    for (const it of pl.items.slice(0, n)) {
      const sb = songBlock({ id: it.id, user: p.user, by: p.by, song: { title: it.title, artist: it.artist, note: it.note, duration: it.duration } });
      message(it.id).then((m) => { const c = fileOf(m, "cover.jpg"); if (c) sb.querySelector(".so-cover").style.backgroundImage = `url("${c.url}")`; }).catch(() => {});
      list.append(sb);
    }
    if (pl.items.length > n) { const more = h("button", "btn small so-plmore", `Show all ${pl.items.length} songs`); more.onclick = () => show(pl.items.length); list.append(more); }
  };
  show(3);
  box.append(list);
  return box;
}
/** Every song in a shared playlist into the library, and a category of them (with its cover). */
async function addPlaylist(p, btn) {
  const pl = p.playlist;
  if (!downloadAllowed(pl.items.map((it) => "post:" + it.id))) return;
  btn.disabled = true;
  const ids = [];
  try {
    for (const [i, it] of pl.items.entries()) {
      btn.textContent = `${i + 1} of ${pl.items.length}…`;
      const q = { id: it.id, user: p.user, by: p.by, song: { title: it.title, artist: it.artist, note: it.note, duration: it.duration } };
      const id = await addToLibrary(q, { _url: null }, null);
      if (id) ids.push(id);
    }
    let cover = null;
    try { const m = await message(p.id), c = fileOf(m, "cover.jpg"); if (c) cover = await (await fetch(c.url, { cache: "no-store" })).blob(); } catch {}
    const { createCategory } = await import("./categories.js");
    await createCategory(pl.name, ids, cover);
    btn.textContent = "Added"; btn.classList.add("done");
    toast(`${ids.length} songs added, in the category ${pl.name} (Library › Rebassed)`, 3500);
  } catch { btn.disabled = false; btn.textContent = "Add all"; toast("Couldn't add them all. Are you online?"); }
}
/** A category from the library, shared to Social: each song goes up on its own (so each fits), then the playlist post. */
export async function sharePlaylist(cat, tracks, cover, text, say) {
  await config();
  if (!S.name) throw new Error("Pick a username in Social first.");
  if (offensive(cat.name, text)) throw new Error(OFFENSIVE);
  const items = [];
  for (const [i, t] of tracks.slice(0, 25).entries()) {
    say(`Song ${i + 1} of ${Math.min(25, tracks.length)}…`);
    const art = t.hasArt ? await store.getArt(t.id) : null;
    const files = [];
    if (art) { try { files.push(["cover.jpg", await squareJpeg(art, 400)]); } catch {} }
    const room = MAX_MSG - files.reduce((a, [, b]) => a + b.size, 0) - 64 * 1024;
    const kbps = [192, 160, 128, 112, 96].find((k) => (k * 1000 / 8) * (t.duration || 0) * 1.03 < room);
    if (!kbps) continue;                                            // (too long to share: left out)
    const f = await libraryMp3(t, kbps);
    if (f.size > room) continue;
    files.push(["song.mp4", await scramble(f)]);
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({ content: `🎵 ${t.title}${t.artist ? " · " + t.artist : ""} (in ${S.name}'s playlist ${cat.name})`.slice(0, 1900), username: `${S.name} · FifTeam`.replace(/discord|clyde/gi, "").slice(0, 80), allowed_mentions: { parse: [] }, attachments: files.map(([n], k) => ({ id: k, filename: n })) }));
    files.forEach(([n, b], k) => fd.append(`files[${k}]`, b, n));
    const m = await dc("?wait=true", { method: "POST", form: fd });
    items.push({ id: m.id, title: t.title.slice(0, 120), artist: (t.artist || "").slice(0, 80), note: (t.note || "").slice(0, 80), duration: Math.round(t.duration || 0) });
  }
  if (!items.length) throw new Error("Those songs are too long to share.");
  say("Sharing the playlist…");
  const fd = new FormData(), files = [];
  if (cover) { try { files.push(["cover.jpg", await squareJpeg(cover, 600)]); } catch {} }
  const entry = { at: Date.now(), user: S.name, text: (text || "").slice(0, 500), image: false, video: "", comments: [], avatar: false, by: S.me, likes: [], song: null, playlist: { name: cat.name.slice(0, 60), items } };
  fd.append("payload_json", JSON.stringify({ content: [`**${S.name}** shared a playlist: ${cat.name} (${items.length} songs)`, entry.text].filter(Boolean).join("\n").slice(0, 1900), username: `${S.name} · FifTeam`.replace(/discord|clyde/gi, "").slice(0, 80), allowed_mentions: { parse: [] }, attachments: files.map(([n], k) => ({ id: k, filename: n })) }));
  files.forEach(([n, b], k) => fd.append(`files[${k}]`, b, n));
  const m = await dc("?wait=true", { method: "POST", form: fd });
  entry.id = m.id;
  S.mine.add(m.id); saveMine();
  try { await changeIndex((posts) => { if (!posts.some((x) => x.id === m.id)) posts.unshift(entry); }, (now) => now.some((x) => x.id === m.id)); }
  catch (e) { dc(`/messages/${m.id}`, { method: "DELETE" }).catch(() => {}); for (const it of items) dc(`/messages/${it.id}`, { method: "DELETE", low: true }).catch(() => {}); throw e; }
  return items.length;
}

// ---------------------------------------------------------------------------------------------------- several pictures and videos
const mediaFile = (p, i, still) => (p.media[i] === "i" ? `m${i}.jpg` : still ? `m${i}.poster.jpg` : `m${i}.${p.media[i]}`);
/** Several pictures and videos in the feed: up to four in a collage (the last one saying how many more); a tap opens
 * the post's own feed of all of them. */
function collage(p) {
  const n = p.media.length, shown = Math.min(4, n);
  const box = h("div", `so-col c${shown}`);
  for (let i = 0; i < shown; i++) {
    const t = h("button", "so-cell so-wait" + (p.media[i] !== "i" ? " vid" : ""));
    t.setAttribute("aria-label", `${p.media[i] === "i" ? "Picture" : "Video"} ${i + 1} of ${n}`);
    if (i === shown - 1 && n > shown) t.append(h("span", "so-more-n", `+${n - shown}`));
    t.onclick = () => openPostMedia(p, i);
    box.append(t);
  }
  box._attach = (m) => box.querySelectorAll(".so-cell").forEach((t, i) => { const f = fileOf(m, mediaFile(p, i, true)); if (f) { t.style.backgroundImage = `url("${f.url}")`; t.classList.remove("so-wait"); } });
  return box;
}
/** A post's own feed: every picture and video in it, one under the other; a tap on one goes full screen, where they
 * swipe from one to the next. */
async function openPostMedia(p, start = 0) {
  const name = nameOf(p);
  openSheet((panel) => {
    panel.classList.add("pf-panel", "pm-panel");
    const head = h("div", "so-head"), who = h("div", "so-who");
    const av = avatarEl(40, "", name); showPicture(av, p);
    const nm = h("span", "so-name"); nm.append(nameLine(name, p.by), h("small", "", ago(p.at)));
    who.append(av, nm); head.append(who); panel.append(head);
    if (p.music) panel.append(musicRow(p));
    if (p.text) panel.append(h("p", "so-text", p.text));
    const list = h("div", "pm-list"); panel.append(list);
    p.media.forEach((k, i) => {
      if (k === "i") { const im = h("img", "pm-img"); im.alt = `Picture ${i + 1}`; im.decoding = "async"; im.onclick = () => openViewer({ post: p, index: i }); list.append(im); }
      else { const v = document.createElement("video"); v.className = "pm-vid"; v.controls = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.preload = "metadata"; list.append(v); }
    });
    const foot = h("button", "btn small pm-foot", [p.likes.length ? `♥ ${p.likes.length}` : "", `💬 ${commentsOf(p).length ? commentsOf(p).length + " comments" : "Comment"}`].filter(Boolean).join("  ·  "));
    foot.onclick = () => openComments(p.id);
    panel.append(foot);
  });
  try {
    const m = await message(p.id), els = document.querySelectorAll("#sheet-panel .pm-list > *");
    els.forEach((el, i) => {
      const f = fileOf(m, mediaFile(p, i)); if (!f) return;
      if (el.tagName === "IMG") el.src = f.url; else { const po = fileOf(m, mediaFile(p, i, true)); if (po) el.poster = po.url; el.src = f.url; }
    });
    if (start && els[start]) els[start].scrollIntoView({ block: "start" });
  } catch { toast("Couldn't load that post. Are you online?"); }
}

/** A post's video: plays by itself, without sound, while it's on screen (looping); tap it to pause; the speaker
 * button turns the sound on or off for every video (and stops the music player while a video has sound). */
function videoBlock(p) {
  const box = h("div", "so-vid so-wait");
  const v = document.createElement("video");
  v.playsInline = true; v.loop = true; v.muted = S.muted; v.preload = "none"; v.setAttribute("playsinline", ""); v.setAttribute("disablepictureinpicture", "");
  const mute = h("button", "so-mute"); mute.setAttribute("aria-label", S.muted ? "Sound on" : "Sound off"); mute.append(icon(S.muted ? "i-mute" : "i-vol"));
  const big = h("span", "so-vplay"); big.append(icon("i-play"));
  box.append(v, big, mute);
  box._attach = (url, poster) => {
    if (poster) v.poster = poster;
    if (!url) { box.textContent = "Couldn't load the video"; return; }
    v.preload = "metadata"; v.src = url; box.classList.remove("so-wait"); box.classList.add("ready");
    videoObserver().observe(box);
  };
  v.onplay = () => box.classList.add("playing");
  v.onpause = () => box.classList.remove("playing");
  v.onclick = () => { if (v.paused) { box._user = false; v.play().catch(() => {}); } else { box._user = true; v.pause(); } };
  big.onclick = v.onclick;
  mute.onclick = (e) => { e.stopPropagation(); setMuted(!S.muted, v); };
  return box;
}
function setMuted(m, playing) {
  S.muted = m;
  document.querySelectorAll("#so-body .so-vid").forEach((b) => {
    const v = b.querySelector("video"), btn = b.querySelector(".so-mute");
    v.muted = m;
    btn.querySelector("use").setAttribute("href", m ? "#i-mute" : "#i-vol");
    btn.setAttribute("aria-label", m ? "Sound on" : "Sound off");
  });
  if (!m) { player.pause(); stopSong(); if (playing && playing.paused) playing.play().catch(() => {}); }
}
// videos play while mostly on screen, and stop when scrolled away
function videoObserver() {
  if (S.vids) return S.vids;
  S.vids = new IntersectionObserver((es) => {
    for (const x of es) {
      const v = x.target.querySelector("video");
      if (!v || !v.src) continue;
      if (x.isIntersecting && x.intersectionRatio >= 0.6 && !x.target._user) v.play().catch(() => {});
      else if (!x.isIntersecting || x.intersectionRatio < 0.6) v.pause();
    }
  }, { threshold: [0, 0.6] });
  return S.vids;
}
function pauseVideos() { document.querySelectorAll("#so-body .so-vid video").forEach((v) => v.pause()); }

/** A post's counts: likes and votes on the left, comments on the right; and whether this phone has voted. */
function paintCount(card, p) {
  const n = p.likes.length, v = votesOf(p.id).filter((x) => !bannedPhones().has(x)).length, c = commentsOf(p).length;
  const sl = card.querySelector(".so-slikes"), sv = card.querySelector(".so-svotes"), sc = card.querySelector(".so-scom");
  if (sl) sl.textContent = n ? `♥ ${n}` : "";
  if (sv) sv.textContent = p.song && v ? `🔥 ${v} vote${v === 1 ? "" : "s"}` : "";
  if (sc) sc.textContent = c ? `${c} comment${c === 1 ? "" : "s"}` : "";
  card.classList.toggle("so-nostats", !n && !c && !(p.song && v));
  const vt = card.querySelector(".so-vote");
  if (vt) { const on = votesOf(p.id).includes(S.me); vt.classList.toggle("on", on); vt.setAttribute("aria-pressed", String(on)); vt.querySelector(".so-lbl").textContent = on ? "Voted" : "Vote"; }
}
/** Vote for a rebassed song (or take it back): shown at once; the rebass of the week follows. */
async function vote(p, btn) {
  if (!S.me) return;
  if (!S.name) { toast("Pick a username first"); S.editingName = true; render(); return; }
  const on = !votesOf(p.id).includes(S.me);
  const was = S.weekId;
  const job = setVote(p.id, on);
  document.querySelectorAll(`#so-body .so-post[data-id="${p.id}"]`).forEach((c) => paintCount(c, p));
  btn.classList.remove("pop"); void btn.offsetWidth; if (on) btn.classList.add("pop");
  if ((weekly(S.feed.filter((x) => !S.gone.has(x.id) && visible(x))) || {}).id !== was) render();
  if (!(await job)) toast("Couldn't save that vote. Try again.");
  document.querySelectorAll(`#so-body .so-post[data-id="${p.id}"]`).forEach((c) => paintCount(c, p));
  if ((weekly(S.feed.filter((x) => !S.gone.has(x.id) && visible(x))) || {}).id !== S.weekId) render();
}
/** Your post's words, changed after it's gone up (marked "edited"). */
function editPost(p) {
  openSheet((panel) => {
    panel.append(h("h3", "", "Edit post"));
    const t = h("textarea", "input so-compose"); t.rows = 4; t.maxLength = 500; t.value = p.text || ""; t.setAttribute("aria-label", "Your post");
    setTimeout(() => mentionBox(t, { above: false, z: 140 }), 0);
    const err = h("p", "set-err"), go = h("button", "btn primary block", "Save");
    go.onclick = async () => {
      const text = t.value.trim().slice(0, 500);
      if (!text && !(p.image || p.video || p.song || p.media.length || p.playlist)) { err.textContent = "Write something."; return; }
      if (offensive(text)) { err.textContent = OFFENSIVE; return; }
      if (text === (p.text || "")) { closeSheet(); return; }
      go.disabled = true; go.textContent = "Saving…";
      const at = Date.now();
      try {
        await changeIndex((posts) => { const q = posts.find((x) => x.id === p.id); if (!q) throw new Error("gone"); q.text = text; q.edited = at; }, (now) => { const q = now.find((x) => x.id === p.id); return !q || q.text === text; });
        p.text = text; p.edited = at;
        closeSheet(); toast("Post updated"); render();
      } catch (x) { err.textContent = x.message === "gone" ? "That post is gone." : "Couldn't save that. Try again."; go.disabled = false; go.textContent = "Save"; }
    };
    panel.append(t, err, go);
    setTimeout(() => { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }, 80);
  });
}
/** Someone else's post: report it (or them), or see their page. */
function otherMenu(p) {
  const who = p.by || findPhone(p.user), name = nameOf(p);
  openSheet((panel) => {
    panel.append(h("h3", "", `${name}'s post`));
    const pg = h("button", "menu-item"); pg.append(icon("i-social"), h("span", "", `See ${name}'s page`));
    pg.onclick = () => openProfile({ by: p.by, user: p.user });
    const rp = h("button", "menu-item danger so-report"); rp.append(icon("i-warn"), h("span", "", "Report post"));
    rp.onclick = () => openReport({ who, name, post: p.id });
    const ru = h("button", "menu-item danger"); ru.append(icon("i-warn"), h("span", "", `Report ${name}`));
    ru.onclick = () => openReport({ who, name });
    panel.append(pg, rp, ru);
  });
}
/** Your post, private (only you see it) or public again. */
async function setPostPrivate(p, on) {
  const want = on ? 1 : 0;
  p.priv = want; render();
  try {
    await changeIndex((posts) => { const q = posts.find((x) => x.id === p.id); if (q) q.priv = want; }, (now) => { const q = now.find((x) => x.id === p.id); return !q || q.priv === want; });
    toast(on ? "Private: only you see it now" : "Public: everyone sees it now", 2200); render();
    return true;
  } catch { p.priv = want ? 0 : 1; render(); toast("Couldn't change that. Try again."); return false; }
}
/** A post sent to someone in a message: its poster hears about it (once per person). */
function noteShare(id) {
  const p = S.feed.find((x) => x.id === id);
  if (!p || mineAs(p) || p.shares.includes(S.me)) return;
  p.shares = [...p.shares, S.me];
  changeIndex((posts) => { const q = posts.find((x) => x.id === id); if (q && !q.shares.includes(S.me)) q.shares = [...q.shares, S.me]; }, (now) => { const q = now.find((x) => x.id === id); return !q || q.shares.includes(S.me); }).catch(() => {});
}
/** Your post's menu. */
function postMenu(p) {
  openSheet((panel) => {
    panel.append(h("h3", "", "Your post"));
    const e = h("button", "menu-item so-edit"); e.append(icon("i-plus"), h("span", "", "Edit post"));
    e.onclick = () => editPost(p);
    const pv = h("button", "menu-item so-privacy"); pv.append(icon("i-lock"), h("span", "", p.priv ? "Make public (everyone sees it)" : "Make private (only you see it)"));
    pv.onclick = () => { closeSheet(); setPostPrivate(p, !p.priv); };
    panel.append(e, pv);
    const d = h("button", "menu-item danger so-del"); d.append(icon("i-trash"), h("span", "", "Delete post"));
    d.onclick = () => { closeSheet(); removePost(p); };
    panel.append(d);
  });
}
const postNow = (id) => S.feed.find((x) => x.id === id);
/** A post's comments, in a panel: each with its replies under it, likes, Reply; your own can be deleted. */
function openComments(id) {
  S.cs = { id, reply: null };
  openSheet((panel) => {
    panel.classList.add("cs-panel");
    panel.append(h("h3", "", "Comments"));
    panel.append(h("div", "cs-list"));
    const f = h("form", "cs-form");
    const to = h("div", "cs-to"); to.hidden = true;
    const inp = h("input", "input"); inp.maxLength = 300; inp.autocomplete = "off"; inp.setAttribute("aria-label", "Comment");
    inp.placeholder = S.name ? "Add a comment (@ to mention someone)" : "Pick a username to comment";
    setTimeout(() => mentionBox(inp, { above: true, z: 140 }), 0);
    const go = h("button", "btn small primary", "Send"); go.type = "submit";
    const row = h("div", "cs-row"); row.append(inp, go);
    f.append(to, row);
    f.onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; if (offensive(v)) { toast(OFFENSIVE, 3500); return; } inp.value = ""; comment(id, v, S.cs && S.cs.reply); setReply(null); };
    panel.append(f);
  });
  paintSheet();
  // the latest comments too (the panel follows once they're in)
  if (!S.loading && Date.now() - S.loadedAt > 4000) refresh();
}
function setReply(c) {
  if (!S.cs) return;
  S.cs.reply = c ? (c.re || c.id) : null;
  const to = document.querySelector("#sheet-panel .cs-to");
  if (!to) return;
  to.hidden = !c;
  to.replaceChildren();
  if (c) {
    const x = h("button", "cs-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Not replying"); x.onclick = () => setReply(null);
    to.append(h("span", "", `Replying to ${nameOf(c)}`), x);
    const inp = document.querySelector("#sheet-panel .cs-form input"); if (inp) inp.focus();
  }
}
function paintSheet() {
  const list = document.querySelector("#sheet.open #sheet-panel .cs-list");
  if (!S.cs || !list) return;
  const p = postNow(S.cs.id);
  if (!p) { list.replaceChildren(h("p", "status", "That post is gone.")); return; }
  const old = new Map(); for (const r of list.children) if (r._key) old.set(r._key, r);
  const scroller = list.closest("#sheet-panel") || list;
  const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40, had = old.size;
  const row = (c, reply) => {
    const key = c.id + (reply ? "r" : ""), sig = JSON.stringify(c) + "|" + nameOf(c) + "|" + nameLine(nameOf(c), c.by).textContent + "|" + S.me;
    const o = old.get(key); if (o && o._sig === sig) { o._time.textContent = ago(c.at); return o; }
    const n = commentRow(p, c, reply); n._key = key; n._sig = sig; return n;
  };
  const shown = commentsOf(p), out = [];
  const tops = shown.filter((c) => !c.re || !shown.some((x) => x.id === c.re)).sort((a, b) => a.at - b.at);
  if (!tops.length) out.push(h("p", "status cs-none", "No comments yet. Be the first."));
  for (const c of tops) {
    out.push(row(c, false));
    for (const r of shown.filter((x) => x.re === c.id).sort((a, b) => a.at - b.at)) out.push(row(r, true));
  }
  const grew = out.filter((n) => n._key && !old.has(n._key)).length;
  reconcile(list, out);
  if (had && grew && atEnd) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
}
function commentRow(p, c, reply) {
  const row = h("div", "cs-c" + (reply ? " reply" : "") + (c.sending ? " sending" : ""));
  const cname = nameOf(c);
  const av = avatarEl(reply ? 28 : 34, "", cname);
  showPicture(av, { by: c.by, user: c.user, id: "" });
  av.classList.add("tap"); av.onclick = () => openProfile({ by: c.by, user: c.user });
  const body = h("div", "cs-body");
  const top = h("div", "cs-name"), when = h("small", "", ago(c.at)); top.append(nameLine(cname, c.by), when); row._time = when;
  const acts = h("div", "cs-acts");
  const rp = h("button", "cs-act", "Reply"); rp.onclick = () => setReply(c);
  const lk = h("button", "cs-act cs-like" + (c.likes.includes(S.me) ? " on" : ""));
  lk.append(h("span", "", "♥"), h("span", "", c.likes.length ? " " + c.likes.length : ""));
  lk.setAttribute("aria-label", c.likes.includes(S.me) ? "Unlike" : "Like");
  lk.onclick = () => likeComment(p.id, c.id);
  acts.append(rp, lk);
  if (c.by && c.by === S.me && !c.sending) { const x = h("button", "cs-act", "Delete"); x.onclick = () => uncomment(p.id, c.id); acts.append(x); }
  const ctext = h("p", ""); ctext.append(richText(c.text, () => closeSheet()));
  body.append(top, ctext, acts);
  row.append(av, body);
  return row;
}
const newCid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
/** A change to one post's comments: shown at once, saved to the feed, the panel and the post's count redrawn. */
async function changeComments(id, change, check, failMsg) {
  const p = postNow(id);
  if (p) { const local = { ...p, comments: p.comments.map((c) => ({ ...c, likes: [...c.likes] })) }; change(local.comments); Object.assign(p, { comments: local.comments }); paintSheet(); }
  try {
    await changeIndex((posts) => {
      const q = posts.find((x) => x.id === id); if (!q) throw new Error("gone");
      q.comments = q.comments || []; change(q.comments); q.comments = q.comments.slice(-MAX_COMMENTS);
    }, (now) => { const q = now.find((x) => x.id === id); return !q || check(q.comments); }, true);
  } catch (e) { toast(e.message === "gone" ? "That post is gone." : failMsg); }
  paintSheet();
  const q = postNow(id), card = document.querySelector(`#so-body .so-post[data-id="${id}"]`);
  if (q && card) paintCount(card, q);
}
function comment(id, text, re) {
  if (!S.name) { toast("Pick a username first"); closeSheet(); S.editingName = true; render(); return; }
  const c = { id: newCid(), by: S.me, user: S.name, text: text.slice(0, 300), at: Date.now(), likes: [], ...(re ? { re } : {}) };
  return changeComments(id, (cs) => { if (!cs.some((x) => x.id === c.id)) cs.push(c); }, (cs) => cs.some((x) => x.id === c.id), "Couldn't send that comment. Try again.");
}
function uncomment(id, cid) {
  // (its replies go with it)
  return changeComments(id, (cs) => { for (let i = cs.length - 1; i >= 0; i--) if (cs[i].id === cid || cs[i].re === cid) cs.splice(i, 1); }, (cs) => !cs.some((x) => x.id === cid), "Couldn't delete that comment. Try again.");
}
function likeComment(id, cid) {
  const p = postNow(id), c = p && p.comments.find((x) => x.id === cid);
  if (!c) return;
  const want = !c.likes.includes(S.me);
  return changeComments(id, (cs) => {
    const x = cs.find((y) => y.id === cid); if (!x) return;
    x.likes = x.likes || [];
    const has = x.likes.includes(S.me);
    if (want && !has) x.likes.push(S.me); else if (!want && has) x.likes = x.likes.filter((y) => y !== S.me);
  }, (cs) => { const x = cs.find((y) => y.id === cid); return !x || (x.likes || []).includes(S.me) === want; }, "Couldn't save that like. Try again.");
}

function paintLike(btn, p) {
  const mine = p.likes.includes(S.me);
  btn.classList.toggle("on", mine);
  btn.setAttribute("aria-pressed", String(mine));
  btn.setAttribute("aria-label", mine ? "Unlike" : "Like");
  btn.querySelector(".so-lbl").textContent = mine ? "Liked" : "Like";
  const card = btn.closest(".so-post"); if (card) paintCount(card, p);
}
/** Like or unlike: shown at once, saved to the feed (the last tap wins if it's tapped again while saving). */
async function like(p, btn) {
  if (!S.me) return;
  const want = !p.likes.includes(S.me);
  p.likes = want ? [...p.likes, S.me] : p.likes.filter((x) => x !== S.me);
  paintLike(btn, p);
  btn.classList.remove("pop"); void btn.offsetWidth; if (want) btn.classList.add("pop");
  if (S.liking.has(p.id)) { S.liking.set(p.id, want); return; }
  S.liking.set(p.id, want);
  try {
    for (;;) {
      const goal = S.liking.get(p.id);
      await changeIndex((posts) => {
        const q = posts.find((x) => x.id === p.id); if (!q) return;
        const has = q.likes.includes(S.me);
        if (goal && !has) q.likes.push(S.me); else if (!goal && has) q.likes = q.likes.filter((x) => x !== S.me);
      }, (now) => { const q = now.find((x) => x.id === p.id); return !q || q.likes.includes(S.me) === goal; }, true);
      if (S.liking.get(p.id) === goal) break;
    }
  } catch { toast("Couldn't save that like. Try again."); }
  S.liking.delete(p.id);
  const q = S.feed.find((x) => x.id === p.id);
  if (q) { p.likes = q.likes; document.querySelectorAll(`#so-body .so-like[data-id="${p.id}"]`).forEach((b) => paintLike(b, q)); }
}
function songBlock(p) {
  const s = p.song;
  const b = h("div", "so-song");
  const cov = h("span", "so-cover"); cov.style.backgroundImage = `url("${placeholderArt(s.title, "rebass")}")`;
  const play = h("button", "so-play"); play.dataset.id = p.id; play.setAttribute("aria-label", "Play"); play.append(icon(S.playing === p.id ? "i-pause" : "i-play"));
  play.onclick = () => playSong(p, b);
  const meta = h("div", "so-smeta"); meta.append(h("b", "", s.title), h("small", "", [s.artist, s.note, s.duration ? fmtTime(s.duration) : ""].filter(Boolean).join(" · ")));
  const add = h("button", "so-add"); add.append(icon("i-plus")); add.setAttribute("aria-label", "Add to my library"); add.title = "Add to my library";
  add.onclick = () => addToLibrary(p, b, add);
  b.append(cov, play, meta, add);
  return b;
}
async function songUrl(p, block) {
  if (block._url) return block._url;
  const m = await message(p.id), f = songOf(m);
  if (!f) throw new Error("no song");
  return (block._url = f.url);
}
/** A song's audio, downloaded once (and kept for a few songs). */
async function songBlob(p, block) {
  if (S.blobs && S.blobs.has(p.id)) return S.blobs.get(p.id);
  const r = await fetch(await songUrl(p, block), { cache: "no-store" });
  if (!r.ok) throw new Error("download");
  const b = new Blob([unscramble(await r.arrayBuffer())], { type: "audio/mpeg" });
  S.blobs = S.blobs || new Map();
  S.blobs.set(p.id, b); if (S.blobs.size > 5) S.blobs.delete(S.blobs.keys().next().value);
  return b;
}
function paintPlay() {
  document.querySelectorAll(".so-play").forEach((b) => {
    const on = b.dataset.id === S.playing;
    b.querySelector("use").setAttribute("href", on ? "#i-pause" : "#i-play");
    b.setAttribute("aria-label", on ? "Pause" : "Play");
    b.classList.remove("busy");
  });
}
async function playSong(p, block) {
  stopClip();
  if (!S.audio) { S.audio = new Audio(); S.audio.onended = () => { const was = S.playing; S.playing = null; paintPlay(); if (was) playNextRebass(was); }; }
  if (S.playing === p.id) { S.audio.pause(); S.playing = null; paintPlay(); return; }
  const btn = block.querySelector(".so-play");
  try {
    if (btn) btn.classList.add("busy");
    const b = await songBlob(p, block);
    player.pause();
    if (S.audioUrl) URL.revokeObjectURL(S.audioUrl);
    S.audioUrl = URL.createObjectURL(b);
    S.audio.src = S.audioUrl; S.playing = p.id;
    await S.audio.play();
  } catch { toast("Couldn't play that song. Are you online?"); S.playing = null; }
  paintPlay();
}
// ---------------------------------------------------------------------------------------------------- a picture's music
/** "♪ Title · Artist" under the poster's name. The clip plays by itself while the picture is on screen (looping), and
 * stops when it scrolls away; a tap pauses it (and it stays paused for that picture until tapped again). */
function musicRow(p) {
  const mu = h("button", "so-music"); mu.dataset.id = p.id; mu.setAttribute("aria-label", `Play or pause the music: ${p.music.title}`);
  mu.append(icon(S.clipOn === p.id ? "i-pause" : "i-play"), h("span", "so-mt", `♪ ${p.music.title}${p.music.artist ? " · " + p.music.artist : ""}`), h("span", "so-eq", ""));
  mu.onclick = (e) => {
    e.stopPropagation();
    S.clipPaused = S.clipPaused || new Set();
    if (S.clipOn === p.id) { S.clipPaused.add(p.id); stopClip(); } else { S.clipPaused.delete(p.id); playClip(p, true); }
  };
  return mu;
}
/** A picture with music in the feed: its clip plays while most of it is on screen (unless it was paused, or the
 * music player is playing a song), and stops when it's scrolled away. */
function clipWatch(card, p) {
  if (!("IntersectionObserver" in window)) return;
  S.clipObs = S.clipObs || new IntersectionObserver((es) => {
    for (const x of es) {
      const q = x.target._post; if (!q) continue;
      if (x.intersectionRatio >= 0.6) {
        if (S.clipOn !== q.id && !(S.clipPaused && S.clipPaused.has(q.id)) && !player.playing && !$("viewer") && location.hash === "#social") playClip(q, true);
      } else if (x.intersectionRatio < 0.35 && S.clipOn === q.id && !$("viewer")) stopClip();
    }
  }, { threshold: [0, 0.35, 0.6, 0.9] });
  card._post = p;
  S.clipObs.observe(card);
}
async function clipUrl(p) {
  S.clips = S.clips || new Map();
  if (S.clips.has(p.id)) return S.clips.get(p.id);
  const m = await message(p.id), f = fileOf(m, "music.mp4");
  if (!f) throw new Error("no music");
  const r = await fetch(f.url, { cache: "no-store" });
  if (!r.ok) throw new Error("download");
  const u = URL.createObjectURL(new Blob([unscramble(await r.arrayBuffer())], { type: "audio/mpeg" }));
  S.clips.set(p.id, u);
  return u;
}
function paintClips() {
  document.querySelectorAll(".so-music").forEach((b) => { const on = b.dataset.id === S.clipOn; b.classList.toggle("on", on); const u = b.querySelector("use"); if (u) u.setAttribute("href", on ? "#i-pause" : "#i-play"); });
}
function stopClip() { if (S.clip) S.clip.pause(); if (S.clipOn) { S.clipOn = null; paintClips(); } }
async function playClip(p, keepOn) {
  if (S.clipOn === p.id && !keepOn) { stopClip(); return; }
  stopSong(); pauseVideos(); try { player.pause(); } catch {}
  if (!S.clip) { S.clip = new Audio(); S.clip.loop = true; }
  S.clipOn = p.id; paintClips();
  try { S.clip.src = await clipUrl(p); if (S.clipOn === p.id) await S.clip.play(); }
  catch { if (S.clipOn === p.id) { S.clipOn = null; toast("Couldn't play the music. Are you online?"); } }
  paintClips();
}
function stopSong() { if (S.audio && S.playing) { S.audio.pause(); S.playing = null; paintPlay(); } }
async function addToLibrary(p, block, btn) {
  const s = p.song, dk = "post:" + p.id;
  // (free accounts: 5 downloads an hour; a playlist is checked as a whole before it starts)
  if (btn && !downloadAllowed(dk)) return null;
  try {
    if (btn) { btn.disabled = true; btn.classList.add("busy"); }
    const audio = await songBlob(p, block);
    let cover = null;
    try { const m = await message(p.id), c = fileOf(m, "cover.jpg"); if (c) cover = await (await fetch(c.url, { cache: "no-store" })).blob(); } catch {}
    const file = new File([audio], `${s.title}.mp3`.replace(/[\\/:*?"<>|]+/g, " "), { type: "audio/mpeg" });
    const id = store.newId();
    await library.add({ id, kind: "rebass", title: s.title, artist: s.artist || nameOf(p), album: "FifTeam Social", note: s.note || `from ${nameOf(p)}`,
      duration: s.duration, size: file.size, type: file.type, fileName: file.name, added: Date.now(), hasArt: !!cover, from: "social" }, file, cover);
    noteDownload(dk);
    if (btn) { btn.classList.remove("busy"); btn.classList.add("done"); toast("Added to your library, under Rebassed"); }
    return id;
  } catch (e) {
    if (!btn) throw e;
    btn.disabled = false; btn.classList.remove("busy"); toast("Couldn't download that song. Are you online?");
    return null;
  }
}
function viewImage(src) { openViewer({ src }); }
/** Full screen: a post's picture, or its video playing with sound (from a profile, or a tap on a picture). */
async function openViewer({ post, src, index }) {
  closeViewer();
  const v = h("div", "viewer"); v.id = "viewer"; v.setAttribute("role", "dialog"); v.setAttribute("aria-modal", "true");
  const x = h("button", "viewer-x"); x.setAttribute("aria-label", "Close"); x.textContent = "×"; x.onclick = () => closeViewer();
  const stage = h("div", "viewer-stage");
  v.append(stage, x);
  if (post) {
    const foot = h("div", "viewer-foot");
    const who = h("div", "viewer-who"); who.append(nameLine(nameOf(post), post.by), h("small", "", ago(post.at)));
    foot.append(who);
    if (post.text) foot.append(h("p", "", post.text));
    const go = h("button", "btn small", "See the post"); go.onclick = () => { closeViewer(); showPost(post.id); };
    const n = h("span", "viewer-n", [post.likes.length ? `♥ ${post.likes.length}` : "", commentsOf(post).length ? `💬 ${commentsOf(post).length}` : ""].filter(Boolean).join("  "));
    const row = h("div", "viewer-row"); row.append(n, go); foot.append(row);
    v.append(foot);
  }
  v.onclick = (e) => { if (e.target === v || e.target === stage) closeViewer(); };
  document.body.append(v);
  pushLayer("viewer", () => closeViewer(true));
  document.body.classList.add("viewing");   // (nothing behind it shows: the app and any open page are hidden meanwhile)
  addEventListener("keydown", viewerKey);
  stage.append(h("div", "viewer-spin"));
  try {
    if (post && post.media && post.media.length) {
      const m = await message(post.id), n = post.media.length;
      const strip = h("div", "viewer-strip"), count = h("span", "viewer-count", `${(index || 0) + 1} / ${n}`);
      post.media.forEach((k, i) => {
        const slide = h("div", "viewer-slide"), f = fileOf(m, mediaFile(post, i));
        if (!f) { slide.append(h("p", "status", "Couldn't load this one")); strip.append(slide); return; }
        if (k === "i") { const im = h("img", ""); im.alt = `Picture ${i + 1}`; im.decoding = "async"; im.src = f.url; slide.append(im); }
        else { const v = document.createElement("video"); v.controls = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.preload = "metadata"; const po = fileOf(m, mediaFile(post, i, true)); if (po) v.poster = po.url; v.src = f.url; slide.append(v); }
        strip.append(slide);
      });
      stage.replaceChildren(strip, count);
      pauseVideos(); stopSong(); try { player.pause(); } catch {}
      // the one on screen plays (a video), the rest wait
      const on = () => { const i = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth)); count.textContent = `${i + 1} / ${n}`; strip.querySelectorAll(".viewer-slide").forEach((sl, j) => { const v = sl.querySelector("video"); if (!v) return; if (j === i) v.play().catch(() => {}); else v.pause(); }); };
      strip.addEventListener("scroll", () => { clearTimeout(strip._t); strip._t = setTimeout(on, 120); }, { passive: true });
      requestAnimationFrame(() => { strip.scrollLeft = (index || 0) * strip.clientWidth; on(); });
      if (post.music && !post.media.some((k) => k !== "i")) { stage.append(musicRow(post)); playClip(post, true); }
    } else if (post && post.video) {
      const m = await message(post.id), f = fileOf(m, "video." + post.video), po = fileOf(m, "poster.jpg");
      if (!f) throw new Error("gone");
      const vid = document.createElement("video");
      vid.controls = true; vid.playsInline = true; vid.setAttribute("playsinline", ""); vid.autoplay = true; vid.preload = "auto";
      if (po) vid.poster = po.url;
      vid.src = f.url;
      pauseVideos(); stopSong(); try { player.pause(); } catch {}
      stage.replaceChildren(vid);
      vid.play().catch(() => {});
    } else {
      let url = src;
      if (!url && post) { const m = await message(post.id), f = fileOf(m, "picture.jpg"); url = f && f.url; }
      if (!url) throw new Error("gone");
      const i = h("img", ""); i.alt = (post && post.text) ? post.text.slice(0, 80) : "Picture"; i.decoding = "async"; i.src = url;
      stage.replaceChildren(i);
      if (post && post.music) { stage.append(musicRow(post)); playClip(post, true); }
    }
  } catch { stage.replaceChildren(h("p", "status", "Couldn't load that. Are you online?")); }
}
function viewerKey(e) { if (e.key === "Escape") closeViewer(); }
function closeViewer(fromBack) {
  const v = $("viewer"); if (!v) return;
  if (!fromBack) dropLayer("viewer");
  removeEventListener("keydown", viewerKey);
  v.querySelectorAll("video").forEach((x) => { x.pause(); x.removeAttribute("src"); x.load(); });
  v.remove();
  document.body.classList.remove("viewing");
  stopClip();
}

// ---------------------------------------------------------------------------------------------------- videos
/** A video's length, worked out by seeking to its end when the file doesn't say (videos recorded in a browser). */
async function lengthOf(v) {
  if (isFinite(v.duration) && v.duration > 0) return v.duration;
  await new Promise((ok) => { const done = () => { if (isFinite(v.duration)) { v.removeEventListener("durationchange", done); ok(); } }; v.addEventListener("durationchange", done); v.currentTime = 1e7; setTimeout(ok, 4000); });
  const d = v.duration;
  v.currentTime = 0;
  return isFinite(d) && d > 0 ? d : 0;
}
/** A video's length (and that this phone can play it). */
function videoInfo(file) {
  return new Promise((ok, bad) => {
    const v = document.createElement("video"), u = URL.createObjectURL(file);
    v.preload = "metadata"; v.muted = true; v.playsInline = true;
    v.onloadedmetadata = async () => { const d = await lengthOf(v); URL.revokeObjectURL(u); if (d > 0) ok({ duration: d, w: v.videoWidth, h: v.videoHeight }); else bad(new Error("video")); };
    v.onerror = () => { URL.revokeObjectURL(u); bad(new Error("video")); };
    v.src = u;
  });
}
const recType = () => ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
/**
 * A video ready to post (at most `budget` bytes) with a still from it for before it plays: { blob, ext, poster }.
 * An MP4 or WebM that already fits goes as it is; anything else is played through once, at normal speed, and recorded
 * again smaller (at most 960 px, its bitrate chosen to fit), so it takes as long as the video.
 */
async function prepareVideo(file, budget, say) {
  const u = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.src = u; v.playsInline = true; v.muted = true; v.preload = "auto"; v.crossOrigin = "anonymous";
  try {
    await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error("This phone can't play that video.")); });
    const dur = await lengthOf(v);
    if (!(dur > 0) || dur > MAX_VIDEO_SEC + 1) throw new Error(`Videos up to ${MAX_VIDEO_SEC / 60} minutes`);
    // the still: a moment in
    await new Promise((ok) => { v.onseeked = ok; v.currentTime = Math.min(0.5, dur / 3); setTimeout(ok, 1500); });
    let poster = null;
    try {
      const k = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement("canvas");
      c.width = Math.max(2, Math.round(v.videoWidth * k)); c.height = Math.max(2, Math.round(v.videoHeight * k));
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      poster = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.8));
    } catch {}
    const ext0 = /webm/.test(file.type) || /\.webm$/i.test(file.name) ? "webm" : /mp4/.test(file.type) || /\.(mp4|m4v)$/i.test(file.name) ? "mp4" : "";
    if (ext0 && file.size <= budget) return { blob: new Blob([file], { type: "video/" + ext0 }), ext: ext0, poster };
    // recorded again, smaller
    const type = recType();
    if (!type || !HTMLCanvasElement.prototype.captureStream) throw new Error(`That video is ${sizeText(file.size)}; this phone can't make it smaller. Videos up to ${sizeText(budget)} post as they are.`);
    // (encoders overshoot a low bitrate, a lot on some phones: aim at 60% of the room, then correct by what came out)
    let vbps = 0, abps = 96000, side = 960;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!attempt) { abps = (budget * 8 * 0.6) / dur < 500000 ? 64000 : 96000; vbps = Math.min(2500000, (budget * 8 * 0.6) / dur - abps); }
      side = vbps > 1200000 ? 960 : vbps > 600000 ? 720 : vbps > 280000 ? 540 : 360;
      if (vbps < 90000) throw new Error("That video is too long to post at a watchable quality. Try a shorter one.");
      const k = Math.min(1, side / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(2, Math.round((v.videoWidth * k) / 2) * 2); c.height = Math.max(2, Math.round((v.videoHeight * k) / 2) * 2);
      const g = c.getContext("2d");
      const stream = c.captureStream(30);
      // its sound, taken from the video into the recording only (not to the speakers)
      try {
        const ctx = getCtx(), src = v._src || (v._src = ctx.createMediaElementSource(v)), dest = ctx.createMediaStreamDestination();
        src.disconnect(); src.connect(dest);
        dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
        v.muted = false;
      } catch {}
      const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: Math.round(vbps), audioBitsPerSecond: abps });
      const parts = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
      const done = new Promise((ok) => { rec.onstop = ok; });
      v.currentTime = 0;
      await new Promise((ok) => { v.onseeked = ok; setTimeout(ok, 1000); });
      let raf = 0;
      const draw = () => { g.drawImage(v, 0, 0, c.width, c.height); say(`Getting the video ready… ${Math.min(99, Math.round((v.currentTime / dur) * 100))}%`); raf = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw); };
      draw();
      rec.start(1000);
      try { await v.play(); } catch { v.muted = true; await v.play(); }      // (a phone that won't play it with sound here)
      await new Promise((ok) => { v.onended = ok; });
      if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(raf); else cancelAnimationFrame(raf);
      rec.stop(); await done;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(parts, { type: type.split(";")[0] });
      if (blob.size <= budget) return { blob, ext: /mp4/.test(type) ? "mp4" : "webm", poster };
      vbps = vbps * (budget / blob.size) * 0.85;          // what came out over: the next go aims that much lower
    }
    throw new Error("That video wouldn't fit. Try a shorter one.");
  } finally { v.pause(); v.removeAttribute("src"); v.load(); URL.revokeObjectURL(u); }
}

// ---------------------------------------------------------------------------------------------------- posting
/** The new-post sheet. preset: { text, img, song: { title, artist, note, duration, cover (Blob), encode(kbps) -> File } } */
const MAX_ITEMS = 10;
function composer(preset) {
  if (!S.name) { toast("Pick a username first"); S.editingName = true; render(); setTimeout(() => { const i = document.querySelector("#so-body .so-nameform input"); if (i) i.focus(); }, 100); return; }
  // what's going up: pictures and videos (up to 10), a rebassed song, music for the pictures
  let items = preset.items ? [...preset.items] : [...(preset.img ? [{ k: "i", blob: preset.img }] : []), ...(preset.video ? [{ k: "v", file: preset.video.file, duration: preset.video.duration }] : [])];
  let song = preset.song || null, music = preset.music || null;
  const pics = () => items.filter((x) => x.k === "i").length, vids = () => items.filter((x) => x.k === "v");
  openSheet((p) => {
    p.append(h("h3", "", "New post"));
    const text = h("textarea", "input so-compose"); text.rows = 3; text.maxLength = 500; text.placeholder = "Say something (@ to mention someone)"; text.setAttribute("aria-label", "Your post");
    setTimeout(() => mentionBox(text, { above: false, z: 140 }), 0);
    text.value = preset.text || "";
    const again = (more) => composer({ items, song, music, text: text.value, priv: preset.priv, box: preset.box, ...more });
    const prev = h("div", "stack-sm");
    const paint = () => {
      prev.replaceChildren();
      if (items.length) {
        const strip = h("div", "so-pstrip");
        items.forEach((it, i) => {
          const t = h("span", "so-pthumb" + (it.k === "v" ? " vid" : ""));
          if (it.k === "i") t.style.backgroundImage = `url("${URL.createObjectURL(it.blob)}")`;
          else { const v = document.createElement("video"); v.src = URL.createObjectURL(it.file); v.muted = true; v.playsInline = true; v.preload = "metadata"; t.append(v, h("small", "", fmtTime(it.duration))); }
          const x = h("button", "mk-px", "×"); x.setAttribute("aria-label", "Remove"); x.onclick = () => { items.splice(i, 1); if (!pics() || vids().length) music = null; paint(); };
          t.append(x); strip.append(t);
        });
        const big = vids().some((v) => v.file.size > MAX_MSG / Math.max(1, items.length));
        prev.append(strip, h("p", "status", `${items.length} of ${MAX_ITEMS}${big ? " · videos are made smaller to fit" : ""}`));
        // music for pictures (not with videos: they have their own sound)
        if (pics() && !vids().length) {
          const mb = h("button", "btn small so-addmusic"); mb.append(h("span", "", "♪"), music ? "Change music" : "Add music");
          mb.onclick = () => pickMusic((m) => { music = m; again(); }, () => again());
          prev.append(mb);
          if (music) {
            const chip = h("div", "so-mchip"); chip.append(h("span", "", `♪ ${music.track.title}${music.track.artist ? " · " + music.track.artist : ""} · ${fmtTime(music.start)}–${fmtTime(music.start + music.len)}`));
            const rm = h("button", "cs-x", "×"); rm.setAttribute("aria-label", "No music"); rm.onclick = () => { music = null; paint(); };
            chip.append(rm); prev.append(chip);
          }
        }
      }
      if (preset.box) {
        const bc = h("div", "so-mchip so-boxchip"); bc.append(icon("i-box"), h("span", "", "Your box design comes with it: anyone can open it in the box creator"));
        const rm = h("button", "cs-x", "×"); rm.setAttribute("aria-label", "Don't attach the design"); rm.onclick = () => { preset.box = ""; paint(); };
        bc.append(rm); prev.append(bc);
      }
      if (song) {
        const sb = h("div", "so-song"), c = h("span", "so-cover"); c.style.backgroundImage = `url("${song.cover ? URL.createObjectURL(song.cover) : placeholderArt(song.title, "rebass")}")`;
        const m = h("div", "so-smeta"); m.append(h("b", "", song.title), h("small", "", [song.artist, song.note, song.duration ? fmtTime(song.duration) : ""].filter(Boolean).join(" · ")));
        const x = h("button", "btn small", "Remove"); x.onclick = () => { song = null; paint(); }; sb.append(c, m, x); prev.append(sb);
      }
    };
    const addRow = h("div", "row wrap");
    const ai = h("button", "btn small"); ai.append(icon("i-image"), "Pictures");
    ai.onclick = async () => {
      if (items.length >= MAX_ITEMS) { toast(`Up to ${MAX_ITEMS} pictures and videos`); return; }
      const fs = await pickMany("image/*");
      for (const f of fs.slice(0, MAX_ITEMS - items.length)) { try { items.push({ k: "i", blob: await fitJpeg(f, 1600) }); } catch { toast("Couldn't read that picture"); } }
      if (fs.length > MAX_ITEMS - items.length + fs.length) toast(`Up to ${MAX_ITEMS} pictures and videos`);
      paint();
    };
    const av = h("button", "btn small"); av.append(icon("i-video"), "Video");
    av.onclick = async () => {
      if (items.length >= MAX_ITEMS) { toast(`Up to ${MAX_ITEMS} pictures and videos`); return; }
      if (song) { toast("A post can have videos or a song"); return; }
      const f = await pickAny("video/*"); if (!f) return;
      try {
        const d = await videoInfo(f);
        if (d.duration + vids().reduce((a, v) => a + v.duration, 0) > MAX_VIDEO_SEC) { toast(`Videos up to ${MAX_VIDEO_SEC / 60} minutes in all`); return; }
        items.push({ k: "v", file: f, duration: d.duration }); music = null; paint();
      } catch { toast("This phone can't play that video."); }
    };
    const as = h("button", "btn small"); as.append(icon("i-bass"), "Rebassed song");
    as.onclick = () => { if (vids().length) { toast("A post can have videos or a song"); return; } pickRebass((sg) => again({ song: sg })); };
    addRow.append(ai, av, as);
    // who sees it: everyone, or only you (you can change it later, from the post or your page)
    const who = h("div", "seg so-who-seg"); who.setAttribute("role", "radiogroup");
    for (const [k, label] of [["pub", "🌐 Public"], ["priv", "🔒 Only me"]]) { const b = h("button", (preset.priv ? k === "priv" : k === "pub") ? "on" : "", label); b.dataset.k = k; b.type = "button"; who.append(b); }
    who.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; preset.priv = b.dataset.k === "priv"; who.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
    const err = h("p", "set-err"), go = h("button", "btn primary block", "Post");
    go.onclick = async () => {
      if (!items.length && !song && !text.value.trim()) { err.textContent = "Write something, or add pictures, a video or a song."; return; }
      if (offensive(text.value)) { err.textContent = OFFENSIVE; return; }
      go.disabled = true; err.textContent = "";
      try {
        await post(text.value.trim(), items, song, (msg) => { go.textContent = msg; }, pics() && !vids().length ? music : null, !!preset.priv, preset.box || "");
        closeSheet(); toast(preset.priv ? "Posted, only you can see it" : "Posted"); render(); $("view-social").scrollTop = 0;
      } catch (e) { err.textContent = e.message === "setup" ? "FifTeam Social isn't switched on yet." : e.message || "Couldn't post."; go.disabled = false; go.textContent = "Post"; }
    };
    p.append(text, addRow, prev, who, err, go);
    paint();
    if (preset.pick === "image") ai.click(); else if (preset.pick === "video") av.click();
  });
}
/** Several files at once (pictures). */
function pickMany(accept) {
  return new Promise((res) => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.multiple = true; i.onchange = () => res([...(i.files || [])]); i.addEventListener("cancel", () => res([])); i.click(); });
}
function pickAny(accept = "image/*") {
  return new Promise((res) => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.onchange = () => res(i.files && i.files[0]); i.addEventListener("cancel", () => res(null)); i.click(); });
}
/** Music for a picture: a song or rebass from the library, then which part (15 or 30 seconds), heard before choosing. */
function pickMusic(done, back) {
  const list = library.all().filter((t) => (t.kind || "song") !== "tone").sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  openSheet((p) => {
    p.append(h("h3", "", "Add music"));
    if (!list.length) { p.append(h("p", "status", "Your library has no songs yet. Add some on the Library tab.")); const b = h("button", "btn block", "Back"); b.onclick = back; p.append(b); return; }
    const q = h("input", "input"); q.type = "search"; q.placeholder = "Search your songs"; q.setAttribute("aria-label", "Search your songs");
    const ul = h("ul", "list so-mlist");
    const fill = () => {
      ul.replaceChildren();
      const w = q.value.trim().toLowerCase();
      for (const t of list.filter((t) => !w || `${t.title} ${t.artist || ""}`.toLowerCase().includes(w)).slice(0, 200)) {
        const li = h("li", "item"), th = h("div", "thumb");
        (async () => { let u = null; if (t.hasArt) u = artUrl(t.id, await store.getArt(t.id)); th.style.backgroundImage = `url("${u || placeholderArt(t.title, t.kind || "song")}")`; })();
        const m = h("div", "meta"); m.append(h("div", "t", t.title), h("div", "a", [t.kind === "rebass" ? "Rebass" : t.artist || "", fmtTime(t.duration)].filter(Boolean).join(" · ")));
        li.append(th, m);
        li.onclick = () => pickPart(t, done, () => pickMusic(done, back));
        ul.append(li);
      }
    };
    q.oninput = fill; fill();
    const b = h("button", "btn small", "Back"); b.onclick = back;
    p.append(q, ul, b);
  });
}
function pickPart(t, done, back) {
  const dur = Math.max(1, t.duration || 0);
  let len = Math.min(30, dur), start = Math.max(0, Math.min(dur - len, dur * 0.3));
  const au = new Audio(); let url = null, stopAt = 0;
  const stop = () => { au.pause(); clearTimeout(stopAt); };
  openSheet((p) => {
    p.append(h("h3", "", "Which part?"));
    p.append(h("p", "status", `${t.title}${t.artist ? " · " + t.artist : ""}`));
    const seg = h("div", "seg");
    for (const n of [15, 30]) { const b = h("button", "", `${n} seconds`); b.dataset.n = n; b.disabled = n > dur + 0.5 && n !== 15; seg.append(b); }
    const range = h("input", ""); range.type = "range"; range.min = "0"; range.step = "0.5"; range.setAttribute("aria-label", "Where the part starts");
    const lab = h("div", "row between so-plab");
    const paint = () => {
      len = Math.min(len, dur); start = Math.max(0, Math.min(start, dur - len));
      range.max = String(Math.max(0, dur - len)); range.value = String(start); range.disabled = dur <= len;
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.n === len || (len < 15 && b.dataset.n === "15")));
      lab.replaceChildren(h("span", "", `${fmtTime(start)} – ${fmtTime(start + len)}`), h("span", "status", `of ${fmtTime(dur)}`));
    };
    seg.onclick = (e) => { const b = e.target.closest("button"); if (!b || b.disabled) return; len = Math.min(+b.dataset.n, dur); paint(); };
    range.oninput = () => { start = +range.value; paint(); };
    const hear = h("button", "btn small"); hear.append(icon("i-play"), "Hear it");
    hear.onclick = async () => {
      try {
        if (!url) { const blob = await store.getBlob(t.id); if (!blob) throw new Error("missing"); url = URL.createObjectURL(blob); au.src = url; }
        stop(); player.pause(); stopSong(); stopClip();
        au.currentTime = start; await au.play();
        stopAt = setTimeout(stop, len * 1000);
      } catch { toast("Couldn't play that song"); }
    };
    const use = h("button", "btn primary block", "Use this part");
    use.onclick = () => { stop(); done({ track: t, start, len }); };
    const b = h("button", "btn small", "Back"); b.onclick = () => { stop(); back(); };
    const row = h("div", "row"); row.append(hear, b);
    p.append(seg, range, lab, row, use);
    paint();
  });
}
/** The part of a library song chosen for a picture, as an MP3 (128 kb/s, a short fade at each end). */
async function clipMp3(m) {
  const blob = await store.getBlob(m.track.id);
  if (!blob) throw new Error("That song's audio is missing.");
  const ctx = getCtx(), buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const sr = buf.sampleRate, i0 = Math.floor(m.start * sr), n = Math.min(buf.length - i0, Math.floor(m.len * sr)), fade = Math.min(Math.floor(0.4 * sr), Math.floor(n / 4));
  const chs = [0, buf.numberOfChannels > 1 ? 1 : 0].map((c) => {
    const x = buf.getChannelData(c).slice(i0, i0 + n);
    for (let i = 0; i < fade; i++) { const g = i / fade; x[i] *= g; x[n - 1 - i] *= g; }
    return x;
  });
  return (await makeFile(chs, sr, m.track.title, "mp3", ctx, null, { title: m.track.title, artist: m.track.artist || "", album: "FifTeam Social", kbps: 128 })).file;
}
/** One of the rebasses in the library. */
function pickRebass(done) {
  const list = library.all().filter((t) => t.kind === "rebass").sort((a, b) => (b.added || 0) - (a.added || 0));
  openSheet((p) => {
    p.append(h("h3", "", "Choose a rebass"));
    if (!list.length) { p.append(h("p", "status", "Your library has no rebasses yet. Make one on the Rebass tab and tap Add to library.")); return; }
    const ul = h("ul", "list"); p.append(ul);
    for (const t of list) {
      const li = h("li", "item"), th = h("div", "thumb");
      (async () => { let u = null; if (t.hasArt) u = artUrl(t.id, await store.getArt(t.id)); th.style.backgroundImage = `url("${u || placeholderArt(t.title, "rebass")}")`; })();
      const m = h("div", "meta"); m.append(h("div", "t", t.title), h("div", "a", [t.note, fmtTime(t.duration)].filter(Boolean).join(" · ")));
      li.append(th, m);
      li.onclick = async () => {
        const cover = t.hasArt ? await store.getArt(t.id) : null;
        done({ title: t.title, artist: t.artist || "", note: t.note || "", duration: t.duration || 0, cover, encode: (kbps) => libraryMp3(t, kbps) });
      };
      ul.append(li);
    }
  });
}
/** A library rebass, ready to send in a message (as for a post). */
async function trackSong(t) {
  const cover = t.hasArt ? await store.getArt(t.id) : null;
  return { title: t.title, artist: t.artist || "", note: t.note || "", duration: t.duration || 0, cover, encode: (kbps) => libraryMp3(t, kbps) };
}
async function libraryMp3(t, kbps) {
  const blob = await store.getBlob(t.id);
  if (!blob) throw new Error("That song's audio is missing.");
  const ctx = getCtx(), buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const chs = [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)];
  return (await makeFile(chs, buf.sampleRate, t.title, "mp3", ctx, null, { title: t.title, artist: t.artist || "", album: "FifTeam Social", kbps })).file;
}
async function post(text, items, song, say, music, priv = false, box = "") {
  await config();
  items = items || [];
  const files = [], imgsOnly = items.filter((x) => x.k === "i"), vidsOnly = items.filter((x) => x.k === "v");
  const img = items.length === 1 && imgsOnly.length ? imgsOnly[0].blob : null;
  const video = items.length === 1 && vidsOnly.length ? vidsOnly[0] : null;
  let media = null;
  if (img) files.push(["picture.jpg", img]);
  if (items.length > 1) {
    // the videos share what's left of the post's room, each by its length
    const room = MAX_MSG - imgsOnly.reduce((a, x) => a + x.blob.size, 0) - vidsOnly.length * 160 * 1024 - 256 * 1024 - (music ? 600 * 1024 : 0);
    const total = vidsOnly.reduce((a, x) => a + x.duration, 0) || 1;
    if (vidsOnly.length && room < vidsOnly.length * 300 * 1024) throw new Error("That's too much to fit in one post. Try fewer pictures or a shorter video.");
    media = [];
    let nv = 0;
    for (const [i, it] of items.entries()) {
      if (it.k === "i") { files.push([`m${i}.jpg`, it.blob]); media.push("i"); continue; }
      nv++;
      const v = await prepareVideo(it.file, Math.max(300 * 1024, Math.floor(room * it.duration / total)), (m) => say(vidsOnly.length > 1 ? `Video ${nv} of ${vidsOnly.length}: ${m}` : m));
      files.push([`m${i}.${v.ext}`, v.blob]);
      if (v.poster) files.push([`m${i}.poster.jpg`, v.poster]);
      media.push(v.ext);
    }
  }
  if ((img || (media && !vidsOnly.length)) && music) {
    say("Getting the music ready…");
    let clip; try { clip = await clipMp3(music); } catch { throw new Error("Couldn't read that song for the music. Try another one."); }
    files.push(["music.mp4", await scramble(clip)]);
  }
  let vtype = "";
  if (video) {
    const v = await prepareVideo(video.file, MAX_MSG - 160 * 1024, say);
    vtype = v.ext;
    files.push(["video." + v.ext, v.blob]);
    if (v.poster) files.push(["poster.jpg", v.poster]);
  }
  if (song && song.cover) { try { files.push(["cover.jpg", await squareJpeg(song.cover, 400)]); } catch {} }
  if (song) {
    // the song as an MP3 small enough for one post (192 kb/s, less for a long one)
    const room = MAX_MSG - files.reduce((a, [, b]) => a + b.size, 0) - 64 * 1024;
    const kbps = [192, 160, 128, 112, 96].find((k) => (k * 1000 / 8) * (song.duration || 0) * 1.03 < room);
    if (!kbps) throw new Error(`That song is too long to post (${fmtTime(song.duration)}). Songs up to about 12 minutes fit.`);
    say("Getting the song ready…");
    const f = await song.encode(kbps);
    if (f.size > room) throw new Error(`That song came out at ${sizeText(f.size)}; it has to fit in 10 MB.`);
    files.push(["song.mp4", await scramble(f)]);
  }
  say(files.length ? `Uploading (${sizeText(files.reduce((a, [, b]) => a + b.size, 0))})…` : "Posting…");
  const entry = { ...(box ? { box } : {}), priv: priv ? 1 : 0, shares: [], at: Date.now(), user: S.name, text: text.slice(0, 500), image: !!img, video: vtype, ...(media ? { media } : {}), ...((img || (media && !vidsOnly.length)) && music ? { music: { title: music.track.title.slice(0, 120), artist: (music.track.artist || "").slice(0, 80), len: Math.round(music.len) } } : {}), comments: [], avatar: false, by: S.me, likes: [], song: song ? { title: song.title.slice(0, 120), artist: (song.artist || "").slice(0, 80), note: (song.note || "").slice(0, 80), duration: Math.round(song.duration || 0) } : null };
  // the post's own message
  const lines = [`**${S.name}**`];
  if (entry.text) lines.push(entry.text);
  if (entry.music) lines.push(`♪ ${entry.music.title}${entry.music.artist ? " · " + entry.music.artist : ""}`);
  if (entry.box) lines.push("📦 Sub box design");
  if (entry.song) lines.push(`🎵 ${entry.song.title}${entry.song.artist ? " · " + entry.song.artist : ""}${entry.song.note ? " · " + entry.song.note : ""}`);
  const f = new FormData();
  f.append("payload_json", JSON.stringify({
    content: lines.join("\n").slice(0, 1900), username: `${S.name} · FifTeam`.replace(/discord|clyde/gi, "").slice(0, 80) || "FifTeam",
    allowed_mentions: { parse: [] }, attachments: files.map(([name], i) => ({ id: i, filename: name })),
  }));
  files.forEach(([name, b], i) => f.append(`files[${i}]`, b, name));
  const m = await dc("?wait=true", { method: "POST", form: f });
  entry.id = m.id;
  S.mine.add(m.id); saveMine();
  say("Adding it to the feed…");
  try { await changeIndex((posts) => posts.unshift(entry), (now) => now.some((x) => x.id === m.id)); }
  catch (e) { dc(`/messages/${m.id}`, { method: "DELETE" }).catch(() => {}); throw e; }
}
async function removePost(p) {
  if (!confirm("Delete this post?")) return;
  // gone from the screen at once (the feed can be slow to answer when it's busy); back if it couldn't be deleted
  S.gone.add(p.id); render();
  try {
    await dc(`/messages/${p.id}`, { method: "DELETE" }).catch((e) => { if (e.status !== 404) { S.gone.delete(p.id); render(); throw e; } });
    if (p.playlist) for (const it of p.playlist.items) dc(`/messages/${it.id}`, { method: "DELETE", low: true }).catch(() => {});
    await changeIndex((posts) => { const i = posts.findIndex((x) => x.id === p.id); if (i >= 0) posts.splice(i, 1); }, (now) => !now.some((x) => x.id === p.id));
    S.mine.delete(p.id); saveMine(); toast("Deleted"); render();
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------------------------------------------- wiring
/** The feed again. manual: pulled down (everything fetched fresh). Redraws only what changed. */
const FEED = "fifteam-feed";
function saveFeed() { try { localStorage.setItem(FEED, JSON.stringify({ at: Date.now(), posts: S.feed.slice(0, 120), profiles: S.profiles })); } catch {} }
/** The feed as it was last time, on screen at once while the new one loads. */
function cachedFeed() {
  if (S.loadedAt || S.feed.length) return;
  try { const c = JSON.parse(localStorage.getItem(FEED) || "null"); if (c && Array.isArray(c.posts)) { S.feed = clean(c.posts); S.profiles = cleanProfiles(c.profiles); } } catch {}
}
async function refresh({ manual = false } = {}) {
  if (S.loading) return S.loading;
  const firstTime = !S.loadedAt;
  if (firstTime) cachedFeed();
  S.loading = (async () => {
    S.error = "";
    try {
      await config(); if (manual) { S.msgs.clear(); S.recheck = true; }
      const ver = indexVer;
      const [list] = await Promise.all([readIndex(), loadMeta(0).catch(() => null), loadLinks().catch(() => null)]);
      if (ver === indexVer) { S.profiles = list.profiles; S.feed = keepGone(list); }
      S.loadedAt = Date.now();
      saveFeed();
    }
    catch (e) { S.error = e.message === "setup" || e instanceof SyntaxError ? "Social isn't available yet." : e.message; }
  })();
  if (firstTime) render();
  const before = JSON.stringify(S.profiles);
  try { await S.loading; } finally { S.loading = null; }
  if (!S.error && (S.avatar || S.name)) syncProfile();
  if (S.cs && !S.loading) paintSheet();
  if (!S.error) activityChanged();
  const week = (weekly(S.feed.filter((x) => !S.gone.has(x.id) && visible(x))) || {}).id || "";
  const seeSig = S.feed.filter(visible).length + "|" + [...noPicPhones()].join();
  if (manual || firstTime || sigIds(S.feed) !== S.ids || S.error !== S.shownError || JSON.stringify(S.profiles) !== before || week !== S.weekId || S.bansSig !== [...bannedPhones()].join() || seeSig !== S.seeSig) { S.bansSig = [...bannedPhones()].join(); S.seeSig = seeSig; render(manual); }
  else for (const p of S.feed) {
    if (!S.liking.has(p.id)) document.querySelectorAll(`#so-body .so-like[data-id="${p.id}"]`).forEach((btn) => paintLike(btn, p));
    const card = document.querySelector(`#so-body .so-post[data-id="${p.id}"]`);
    if (card) paintCount(card, p);
  }
}
const sigIds = (feed) => feed.filter((p) => !S.gone.has(p.id) && visible(p)).map((p) => p.id).join(",");

/** Pull the feed down to refresh it: the list follows the finger (with some weight), a ring turns as it comes, and
 * past the line it spins while the feed loads, then everything springs back. Transforms only, so it stays smooth. */
function pullToRefresh() {
  const view = $("view-social"), inner = view && view.querySelector(".view-inner"), ind = $("so-ptr");
  if (!view || !inner || !ind) return;
  const ring = ind.firstElementChild, GO = 70, MAX = 118;
  let y0 = null, d = 0, active = false, busy = false;
  const set = (px, spring) => {
    const t = spring ? "transform .42s cubic-bezier(.2,.9,.25,1.15), opacity .3s" : "none";
    inner.style.transition = t; ind.style.transition = t;
    inner.style.transform = px ? `translate3d(0,${px.toFixed(1)}px,0)` : "";
    ind.style.transform = `translate3d(-50%,${(px * 0.82 - 52).toFixed(1)}px,0) scale(${Math.min(1, 0.55 + px / GO * 0.45).toFixed(3)})`;
    ind.style.opacity = String(Math.min(1, px / 36));
    if (!busy) ring.style.transform = `rotate(${(px * 4).toFixed(0)}deg)`;
    ind.classList.toggle("ready", px >= GO);
  };
  view.addEventListener("touchstart", (e) => {
    y0 = !busy && view.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
    d = 0; active = false;
  }, { passive: true });
  view.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (!active) {
      if (dy > 6 && view.scrollTop <= 0) { active = true; inner.style.willChange = "transform"; }
      else if (dy < 0) { y0 = null; return; } else return;
    }
    e.preventDefault();
    d = Math.min(MAX, MAX * (1 - Math.exp(-(dy - 6) / 190)));      // heavier the further it goes
    set(d);
    if (d >= GO && !ind._buzzed) { ind._buzzed = true; try { navigator.vibrate && navigator.vibrate(8); } catch {} }
    if (d < GO) ind._buzzed = false;
  }, { passive: false });
  const end = async () => {
    if (y0 == null) return;
    y0 = null;
    if (!active) return;
    active = false;
    if (d >= GO) {
      busy = true; set(58, true); ind.classList.add("spin");
      try { if (marketOpen()) { await loadMarket(0).catch(() => {}); renderMarket(); } else await refresh({ manual: true }); } finally {
        ind.classList.remove("spin"); busy = false; set(0, true);
        setTimeout(() => { inner.style.willChange = ""; }, 450);
      }
    } else { set(0, true); setTimeout(() => { inner.style.willChange = ""; }, 450); }
  };
  view.addEventListener("touchend", end); view.addEventListener("touchcancel", end);
  set(0);
}

/** A sub box from the Box screen: its picture and design, ready to post. */
export function shareBoxPost({ img, box, text }) {
  showTab("feed");
  composer({ items: [{ k: "i", blob: img }], text, box });
}
export function initSocial() {
  cachedFeed();           // (the profiles and posts from last time, at once: Messages and pages open without waiting)
  bus.on("view", (v) => { if (v === "social") refresh(); else { stopSong(); stopClip(); pauseVideos(); } });
  bus.on("music-playing", () => { stopSong(); stopClip(); if (!S.muted) setMuted(true); });
  // a rebass made just now, posted from the Rebass screen
  bus.on("social-post", (song) => { location.hash = "#social"; setTimeout(() => composer({ song }), 50); });
  pullToRefresh();
  // Feed or Audio Market (the last one looked at)
  const tabs = $("so-tabs");
  if (tabs) {
    tabs.onclick = (e) => { const b = e.target.closest("button"); if (b) { stopClip(); showTab(b.dataset.k); } };
    let last = "feed"; try { last = localStorage.getItem("fifteam-social-tab") || "feed"; } catch {}
    if (last === "market" || last === "rebass") showTab(last);
  }
  paintMe();
  const me = $("btn-me"); if (me) me.onclick = openMe;
  // phones only let a page play sound after a tap: the pictures' music player is readied at the first one
  const unlock = () => {
    removeEventListener("click", unlock, true);
    if (!S.clip) { S.clip = new Audio(); S.clip.loop = true; }
    if (!S.clip.src) { S.clip.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="; S.clip.play().then(() => S.clip.pause(), () => {}); }
  };
  addEventListener("click", unlock, true);
  addEventListener("fifteam-badges", () => { render(); });
  initDms();
  initActivity();
  initLive({
    me: () => S.me, name: () => S.name,
    avatar: (phone, name, size) => { const a = avatarEl(size, "", name); showPicture(a, { by: phone, user: name, id: "" }); return a; },
    rich: (text, before) => richText(text, before), mentions: (inp, o) => mentionBox(inp, o),
    changed: () => { if (location.hash === "#social") render(); },
  });
  addEventListener("fifteam-streamers", () => { if (location.hash === "#social") render(); });
  { const f = $("so-find"); if (f) f.onclick = () => openSearch(); }
  // new posts and likes come in on their own while the feed is open: at once with the server's live connection (and
  // every 45 seconds without it, or every 5 minutes with it, in case one was missed)
  let lastLook = 0;
  const look = () => { lastLook = Date.now(); if (location.hash === "#social" && document.visibilityState === "visible" && !marketOpen()) refresh(); else ensureProfiles(true).catch(() => {}); };
  setInterval(() => { if (location.hash === "#social" && document.visibilityState === "visible" && !S.loading && (!live.on || Date.now() - lastLook > 5 * 60e3)) { lastLook = Date.now(); refresh(); } }, 45000);
  let soon = 0;
  addEventListener("hub:index", () => { clearTimeout(soon); soon = setTimeout(look, 150); });
  addEventListener("hub:meta", () => { loadMeta(0).then(() => { if (location.hash === "#social") render(); activityChanged(); }, () => {}); });
  addEventListener("hub:market", () => { if (marketOpen()) loadMarket(0).then(renderMarket, () => {}); });
  addEventListener("hub:mod", () => { checkBans(); });
  // (another phone's like or comment while this one is open: a note at the top, like a notification)
  addEventListener("hub:note", (e) => { const n = e.detail || {}; if (n.kind === "act") toast(`${n.title}: ${n.body}`.slice(0, 90), 3000); });
  addEventListener("hub:open", () => { if (Date.now() - lastLook > 20000) look(); });
  startLive();
  addEventListener("fifteam-signed-in", () => { if (live.ws) { try { live.ws.close(); } catch {} } setTimeout(startLive, 500); });
  // a tap on a notification: that post (or its comments), the requests, or the activity
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type === "open-post" && /^\d{5,25}$/.test(d.post || "")) { location.hash = "#social"; ensureProfiles().catch(() => {}).then(() => (d.c ? openComments(d.post) : showPost(d.post))); }
    else if (d.type === "open-activity") { location.hash = "#social"; openActivity(); }
  });
  const q = new URLSearchParams(location.search), wantPost = q.get("post");
  if ((wantPost && /^\d{5,25}$/.test(wantPost)) || q.has("act")) {
    history.replaceState(null, "", location.pathname + "#social");
    setTimeout(async () => { try { await ensureProfiles(); } catch {} if (wantPost) { if (q.has("c")) openComments(wantPost); else showPost(wantPost); } else openActivity(); }, 1200);
  }
}
/** The profiles (and this phone's on them, with its key for messages), loaded if they haven't been (fresh: unless just now). */
async function ensureProfiles(fresh) {
  await config();
  if (!S.loadedAt || Date.now() - S.loadedAt > (fresh ? 5000 : 40000)) {
    // (the feed too: the bell's activity comes from it; the Social screen redraws from it the next time it refreshes)
    const ver = indexVer;
    const [list] = await Promise.all([readIndex(), loadMeta(0).catch(() => null), loadLinks().catch(() => null)]);
    if (ver === indexVer) { S.profiles = list.profiles; S.feed = keepGone(list); }
    S.loadedAt = Date.now();
    saveFeed(); warm();
    activityChanged();
  }
  if (S.name) syncProfile();
}
/** A phone by its username (older posts don't say which phone made them): the latest profile with that name. */
function findPhone(name) {
  let best = null;
  for (const [k, v] of Object.entries(S.profiles || {})) if (v.name && v.name === name && (!best || v.at > best[1].at)) best = [k, v];
  return best ? best[0] : "";
}
/** With the feed read in the background: the first few posts' links and pictures fetched ahead, so they're there at once. */
let warmed = false;
function warm() {
  if (warmed) return; warmed = true;
  const posts = S.feed.filter((p) => !S.gone.has(p.id) && visible(p)).slice(0, 6);
  const avs = new Set(posts.map(pictureFor).filter(Boolean));
  for (const p of posts) if (p.image || p.video || p.song || p.media.length) message(p.id, true).then((m) => { for (const n of ["picture.jpg", "poster.jpg", "cover.jpg", ...p.media.slice(0, 4).map((k, i) => (k === "i" ? `m${i}.jpg` : `m${i}.poster.jpg`))]) { const f = fileOf(m, n); if (f) { const i = new Image(); i.decoding = "async"; i.src = f.url; } } }).catch(() => {});
  for (const id of avs) message(id, true).then((m) => { const f = fileOf(m, "avatar.jpg"); if (f) new Image().src = f.url; }).catch(() => {});
}
/** A post on the Social screen: scrolled to and lit up (shown further down the list if it has to be). */
function showPost(id) {
  closeSheet();
  if (location.hash !== "#social") location.hash = "#social";
  const i = S.feed.filter((p) => !S.gone.has(p.id) && visible(p)).findIndex((p) => p.id === id);
  if (i >= S.shown) { S.shown = i + 10; render(); }
  setTimeout(() => {
    const card = document.querySelector(`#so-body .so-post[data-id="${id}"]`);
    if (!card) { toast("That post is gone."); return; }
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash");
  }, 350);
}
function editName() { closeSheet(); S.editingName = true; if (location.hash !== "#social") location.hash = "#social"; render(); setTimeout(() => { const i = document.querySelector("#so-body .so-nameform input"); if (i) { i.focus(); i.select(); } }, 120); }
export const api = { setPostPrivate, noteShare, mineAs, openViewer, nameLine, visible, state: S, config, dc, avatarEl, showPicture, ago, icon, findPhone, ensureProfiles, openComments, nameOf, hidden, songBlock, showPost, pickAvatar, editName, fileOf, message, viewImage, render, trackSong };
export const social = { state: S, prepareVideo };
