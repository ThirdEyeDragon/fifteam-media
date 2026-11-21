// FifTeam Social: pictures and rebassed songs from everyone using FifTeam Media. No accounts: pick a username, post.
//   Posts go to the feed service (social/config.json). The feed is a list kept in one message there (the "index": a
//   feed.json attached to it), each entry pointing at a post's message; a post's picture and song are read from its
//   own message when it comes into view (file links expire, so they are always fetched fresh). A message deleted on
//   the service is gone from the feed.
//   Everything from other people is shown as text (textContent), never as markup. @mentions never ping anyone.
import { $, toast, openSheet, closeSheet, fmtTime, bus, placeholderArt, getCtx, artUrl } from "./ui.js";
import * as store from "./store.js";
import { library } from "./library.js";
import { player } from "./player.js";
import { fitJpeg, squareJpeg } from "./image.js";
import { makeFile, sizeText } from "./export.js";

const NAME_KEY = "fifteam-social-name", MINE_KEY = "fifteam-social-mine", ME_KEY = "fifteam-social-me", AV_KEY = "fifteam-social-avatar";
const MAX_MSG = 9.5 * 1024 * 1024;   // what one post may carry (10 MB), with room to spare
const MAX_FEED = 300;
const S = {
  cfg: null, name: "", editingName: false, mine: new Set(), feed: [], loadedAt: 0, loading: null, error: "", shown: 30,
  msgs: new Map(), gone: new Set(), queue: [], busy: 0, audio: null, playing: null,
  me: "", avatar: null, avatarUrl: "", liking: new Map(), sig: "", profiles: {}, avSync: null,
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
  S.cfg = { base: `https://discord.com/api/v10/webhooks/${c.hook}/${atob(c.key).split("").reverse().join("")}`, index: c.index };
  return S.cfg;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** A request to the feed service, waiting and trying again if it says "slow down". */
async function dc(path, { method = "GET", form, json } = {}) {
  const { base } = await config();
  for (let attempt = 0; attempt < 5; attempt++) {
    let r;
    try {
      r = await fetch(base + path, { method, body: form || (json ? JSON.stringify(json) : undefined), headers: json ? { "Content-Type": "application/json" } : undefined, cache: "no-store" });
    } catch { throw new Error("You're offline, or the feed can't be reached."); }
    if (r.status === 429) { let s = 1; try { s = (await r.json()).retry_after || 1; } catch {} await wait(Math.min(10, s) * 1000 + 100); continue; }
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
  const f = new FormData();
  f.append("payload_json", JSON.stringify({ content: "FifTeam Social feed (the app keeps this message up to date; please don't delete it)", attachments: [{ id: 0, filename: "feed.json" }], allowed_mentions: { parse: [] } }));
  f.append("files[0]", new Blob([JSON.stringify({ v: 1, posts: posts.slice(0, MAX_FEED), profiles: posts.profiles || {} })], { type: "application/json" }), "feed.json");
  await dc(`/messages/${S.cfg.index}`, { method: "PATCH", form: f });
}
const keepGone = (list) => { const out = list.filter((p) => !S.gone.has(p.id)); out.profiles = list.profiles || {}; return out; };
/** Change the feed list: read it fresh, change it, write it, check it took (someone posting at the same moment). */
async function changeIndex(change, check, quiet) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const posts = keepGone(await readIndex());
    change(posts);
    await writeIndex(posts);
    const now = await readIndex();
    if (check(now)) { S.feed = keepGone(now); S.profiles = now.profiles; return; }
    await wait(400 + Math.random() * 800);
  }
  throw new Error("The feed was busy. Try again.");
}
function cleanProfiles(o) {
  const out = {};
  if (!o || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o).slice(0, 3000)) if (/^[a-z0-9]{6,16}$/.test(k) && v && typeof v === "object")
    out[k] = { name: str(v.name, 24), av: ID.test(v.av) ? v.av : "", at: +v.at || 0 };
  return out;
}
const ID = /^\d{5,25}$/;
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
function clean(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_FEED).map((p) => {
    if (!p || !ID.test(p.id)) return null;
    const s = p.song && typeof p.song === "object" ? { title: str(p.song.title, 120) || "Rebass", artist: str(p.song.artist, 80), note: str(p.song.note, 80), duration: +p.song.duration || 0 } : null;
    const likes = Array.isArray(p.likes) ? [...new Set(p.likes.filter((x) => typeof x === "string" && /^[a-z0-9]{6,16}$/.test(x)))].slice(0, 5000) : [];
    return { id: p.id, at: +p.at || 0, user: str(p.user, 24) || "someone", text: str(p.text, 500), image: !!p.image, avatar: !!p.avatar, song: s, likes, by: /^[a-z0-9]{6,16}$/.test(p.by) ? p.by : "" };
  }).filter(Boolean);
}
/** A post's message (for its picture and song links), fetched once per load, a couple at a time. */
function message(id) {
  if (S.msgs.has(id)) return S.msgs.get(id);
  const p = new Promise((res, rej) => { S.queue.push({ id, res, rej }); pump(); });
  S.msgs.set(id, p);
  return p;
}
function pump() {
  while (S.busy < 2 && S.queue.length) {
    const { id, res, rej } = S.queue.shift();
    S.busy++;
    dc(`/messages/${id}`).then(res, rej).finally(() => { S.busy--; pump(); });
  }
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

let seen = null;
function avatarEl(size, url, name) {
  const a = h("span", "so-av"); a.style.width = a.style.height = size + "px";
  a.style.backgroundImage = `url("${url || placeholderArt(name || "?")}")`;
  return a;
}
function render() {
  const body = $("so-body");
  if (!body) return;
  S.ids = sigIds(S.feed); S.shownError = S.error;
  body.replaceChildren();
  // you: your picture and your username
  const you = h("div", "card so-you");
  const pic = h("button", "so-avbtn"); pic.setAttribute("aria-label", "Profile picture"); pic.append(avatarEl(48, S.avatarUrl, S.name || "?"));
  pic.onclick = pickAvatar;
  if (S.name && !S.editingName) {
    const r = h("div", "so-yourow");
    const t = h("span", "so-yourname"); t.append(h("b", "", S.name));
    const c = h("button", "btn small", "Change"); c.onclick = () => { S.editingName = true; render(); };
    r.append(pic, t, c); you.append(r);
  } else {
    const f = h("form", "so-nameform");
    const inp = h("input", "input"); inp.maxLength = 24; inp.placeholder = "Pick a username"; inp.value = S.name; inp.setAttribute("aria-label", "Username"); inp.autocomplete = "off";
    const go = h("button", "btn primary", "Save"); go.type = "submit";
    const err = h("p", "set-err");
    f.append(pic, inp, go); you.append(f, err);
    f.onsubmit = (e) => {
      e.preventDefault();
      const v = inp.value.trim().replace(/\s+/g, " ");
      if (!NAME_OK.test(v)) { err.textContent = "2 to 24 letters, numbers, spaces, _ . or -"; return; }
      S.name = v; S.editingName = false;
      try { localStorage.setItem(NAME_KEY, v); } catch {}
      render();
      syncProfile();
    };
  }
  body.append(you);
  const nb = h("button", "btn primary block so-new"); nb.append(icon("i-plus"), "New post");
  nb.onclick = () => composer({});
  body.append(nb);
  if (S.error) body.append(h("p", "status", S.error));
  const posts = S.feed.filter((p) => !S.gone.has(p.id));
  if (!posts.length) {
    const e = h("div", "card so-empty");
    e.append(h("b", "", S.loading ? "Loading…" : "Nothing here yet"), h("p", "status", S.loading ? "" : "Be the first to post."));
    body.append(e); return;
  }
  if (seen) seen.disconnect();
  seen = "IntersectionObserver" in window ? new IntersectionObserver((es) => { for (const x of es) if (x.isIntersecting) { seen.unobserve(x.target); x.target._fill && x.target._fill(); } }, { rootMargin: "400px" }) : null;
  for (const p of posts.slice(0, S.shown)) body.append(postCard(p));
  if (posts.length > S.shown) { const m = h("button", "btn block", "Show more"); m.onclick = () => { S.shown += 30; render(); }; body.append(m); }
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
function syncProfile(force) {
  if (S.avSync) return S.avSync;
  S.avSync = (async () => {
    await config();
    const pr = S.profiles[S.me];
    let sent = ""; try { sent = localStorage.getItem(AV_KEY + "-sent") || ""; } catch {}
    const needPic = S.avatar && (force || !pr || !pr.av || sent !== (pr && pr.av));
    const needName = S.name && pr && pr.name !== S.name;
    if (!needPic && !needName && pr) return;
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
    const me = { name: S.name, av, at: Date.now() };
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
  if (mineAs(p) && S.avatarUrl) { av.style.backgroundImage = `url("${S.avatarUrl}")`; return; }
  const id = pictureFor(p);
  if (!id) return;
  try { const m = await message(id), f = fileOf(m, "avatar.jpg"); if (f) av.style.backgroundImage = `url("${f.url}")`; } catch {}
}
function postCard(p) {
  const card = h("article", "card so-post");
  card.dataset.id = p.id;
  const head = h("div", "so-head");
  const who = h("div", "so-who");
  const av = avatarEl(40, "", p.user);
  showPicture(av, p);
  const nm = h("span", "so-name"); nm.append(h("b", "", p.user), h("small", "", ago(p.at)));
  who.append(av, nm); head.append(who);
  if (S.mine.has(p.id)) { const d = h("button", "btn small so-del", "Delete"); d.onclick = () => removePost(p); head.append(d); }
  card.append(head);
  if (p.text) card.append(h("p", "so-text", p.text));
  let img = null, song = null;
  if (p.image) { img = h("div", "so-img so-wait"); card.append(img); }
  if (p.song) { song = songBlock(p); card.append(song); }
  // the like
  const bar = h("div", "so-bar");
  const lk = h("button", "so-like"); lk.dataset.id = p.id;
  lk.append(h("span", "so-heart", "♥"), h("span", "so-count", ""));
  paintLike(lk, p);
  lk.onclick = () => like(p, lk);
  bar.append(lk); card.append(bar);
  // the pictures and song links, from the post's own message, once it is near the screen
  if (p.image || p.song || p.avatar) {
    card._fill = async () => {
      try {
        const m = await message(p.id);
        const pic = fileOf(m, "picture.jpg"), mp3 = songOf(m), cov = fileOf(m, "cover.jpg"), face = fileOf(m, "avatar.jpg");
        if (face && !pictureFor(p) && !(mineAs(p) && S.avatarUrl)) av.style.backgroundImage = `url("${face.url}")`;
        if (img && pic) { const i = h("img", "so-img"); i.alt = p.text ? p.text.slice(0, 80) : "A picture"; i.decoding = "async"; i.src = pic.url; i.onclick = () => viewImage(pic.url); img.replaceWith(i); }
        if (song) { song._url = mp3 && mp3.url; if (cov) song.querySelector(".so-cover").style.backgroundImage = `url("${cov.url}")`; }
      } catch (e) {
        if (e.status === 404) { S.gone.add(p.id); card.remove(); }
        else if (img) img.textContent = "Couldn't load the picture";
      }
    };
    if (seen) seen.observe(card); else card._fill();
  }
  return card;
}
function paintLike(btn, p) {
  const mine = p.likes.includes(S.me), n = p.likes.length;
  btn.classList.toggle("on", mine);
  btn.setAttribute("aria-pressed", String(mine));
  btn.setAttribute("aria-label", mine ? "Unlike" : "Like");
  btn.querySelector(".so-count").textContent = n ? String(n) : "";
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
  document.querySelectorAll("#so-body .so-play").forEach((b) => {
    const on = b.dataset.id === S.playing;
    b.querySelector("use").setAttribute("href", on ? "#i-pause" : "#i-play");
    b.setAttribute("aria-label", on ? "Pause" : "Play");
    b.classList.remove("busy");
  });
}
async function playSong(p, block) {
  if (!S.audio) { S.audio = new Audio(); S.audio.onended = () => { S.playing = null; paintPlay(); }; }
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
function stopSong() { if (S.audio && S.playing) { S.audio.pause(); S.playing = null; paintPlay(); } }
async function addToLibrary(p, block, btn) {
  const s = p.song;
  try {
    btn.disabled = true; btn.classList.add("busy");
    const audio = await songBlob(p, block);
    let cover = null;
    try { const m = await message(p.id), c = fileOf(m, "cover.jpg"); if (c) cover = await (await fetch(c.url, { cache: "no-store" })).blob(); } catch {}
    const file = new File([audio], `${s.title}.mp3`.replace(/[\\/:*?"<>|]+/g, " "), { type: "audio/mpeg" });
    await library.add({ id: store.newId(), kind: "rebass", title: s.title, artist: s.artist || p.user, album: "FifTeam Social", note: s.note || `from ${p.user}`,
      duration: s.duration, size: file.size, type: file.type, fileName: file.name, added: Date.now(), hasArt: !!cover, from: "social" }, file, cover);
    btn.classList.remove("busy"); btn.classList.add("done"); toast("Added to your library, under Rebassed");
  } catch { btn.disabled = false; btn.classList.remove("busy"); toast("Couldn't download that song. Are you online?"); }
}
function viewImage(src) { openSheet((p) => { const i = h("img", "so-full"); i.src = src; i.alt = "Picture"; p.append(i); }); }

// ---------------------------------------------------------------------------------------------------- posting
/** The new-post sheet. preset: { text, img, song: { title, artist, note, duration, cover (Blob), encode(kbps) -> File } } */
function composer(preset) {
  if (!S.name) { toast("Pick a username first"); S.editingName = true; render(); setTimeout(() => { const i = document.querySelector("#so-body .so-nameform input"); if (i) i.focus(); }, 100); return; }
  let img = preset.img || null, song = preset.song || null;
  openSheet((p) => {
    p.append(h("h3", "", "New post"));
    const text = h("textarea", "input so-compose"); text.rows = 3; text.maxLength = 500; text.placeholder = "Say something"; text.setAttribute("aria-label", "Your post");
    text.value = preset.text || "";
    const prev = h("div", "stack-sm");
    const paint = () => {
      prev.replaceChildren();
      if (img) { const i = h("img", "so-img"); i.src = URL.createObjectURL(img); const x = h("button", "btn small", "Remove picture"); x.onclick = () => { img = null; paint(); }; prev.append(i, x); }
      if (song) {
        const s = h("div", "so-song"), c = h("span", "so-cover"); c.style.backgroundImage = `url("${song.cover ? URL.createObjectURL(song.cover) : placeholderArt(song.title, "rebass")}")`;
        const m = h("div", "so-smeta"); m.append(h("b", "", song.title), h("small", "", [song.artist, song.note, song.duration ? fmtTime(song.duration) : ""].filter(Boolean).join(" · ")));
        const x = h("button", "btn small", "Remove"); x.onclick = () => { song = null; paint(); }; s.append(c, m, x); prev.append(s);
      }
    };
    const addRow = h("div", "row wrap");
    const ai = h("button", "btn small"); ai.append(icon("i-image"), "Picture");
    ai.onclick = async () => { const f = await pickAny(); if (f) { try { img = await fitJpeg(f, 1600); paint(); } catch { toast("Couldn't read that picture"); } } };
    const as = h("button", "btn small"); as.append(icon("i-bass"), "Rebassed song");
    as.onclick = () => pickRebass((s) => composer({ song: s, text: text.value, img }));
    addRow.append(ai, as);
    const err = h("p", "set-err"), go = h("button", "btn primary block", "Post");
    go.onclick = async () => {
      if (!img && !song && !text.value.trim()) { err.textContent = "Write something, or add a picture or a song."; return; }
      go.disabled = true; err.textContent = "";
      try {
        await post(text.value.trim(), img, song, (msg) => { go.textContent = msg; });
        closeSheet(); toast("Posted"); render(); $("view-social").scrollTop = 0;
      } catch (e) { err.textContent = e.message === "setup" ? "FifTeam Social isn't switched on yet." : e.message || "Couldn't post."; go.disabled = false; go.textContent = "Post"; }
    };
    p.append(text, addRow, prev, err, go);
    paint();
  });
}
function pickAny() {
  return new Promise((res) => { const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.onchange = () => res(i.files && i.files[0]); i.addEventListener("cancel", () => res(null)); i.click(); });
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
async function libraryMp3(t, kbps) {
  const blob = await store.getBlob(t.id);
  if (!blob) throw new Error("That song's audio is missing.");
  const ctx = getCtx(), buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const chs = [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)];
  return (await makeFile(chs, buf.sampleRate, t.title, "mp3", ctx, null, { title: t.title, artist: t.artist || "", album: "FifTeam Social", kbps })).file;
}
async function post(text, img, song, say) {
  await config();
  const files = [];
  if (img) files.push(["picture.jpg", img]);
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
  const entry = { at: Date.now(), user: S.name, text: text.slice(0, 500), image: !!img, avatar: false, by: S.me, likes: [], song: song ? { title: song.title.slice(0, 120), artist: (song.artist || "").slice(0, 80), note: (song.note || "").slice(0, 80), duration: Math.round(song.duration || 0) } : null };
  // the post's own message
  const lines = [`**${S.name}**`];
  if (entry.text) lines.push(entry.text);
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
  try {
    await dc(`/messages/${p.id}`, { method: "DELETE" }).catch((e) => { if (e.status !== 404) throw e; });
    S.gone.add(p.id); render();
    await changeIndex((posts) => { const i = posts.findIndex((x) => x.id === p.id); if (i >= 0) posts.splice(i, 1); }, (now) => !now.some((x) => x.id === p.id));
    S.mine.delete(p.id); saveMine(); toast("Deleted"); render();
  } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------------------------------------------- wiring
/** The feed again. manual: pulled down (everything fetched fresh). Redraws only what changed. */
async function refresh({ manual = false } = {}) {
  if (S.loading) return S.loading;
  const firstTime = !S.loadedAt;
  S.loading = (async () => {
    S.error = "";
    try { await config(); if (manual) S.msgs.clear(); const list = await readIndex(); S.profiles = list.profiles; S.feed = keepGone(list); S.loadedAt = Date.now(); }
    catch (e) { S.error = e.message === "setup" || e instanceof SyntaxError ? "Social isn't available yet." : e.message; }
  })();
  if (firstTime) render();
  const before = JSON.stringify(S.profiles);
  try { await S.loading; } finally { S.loading = null; }
  if (!S.error && (S.avatar || S.name)) syncProfile();
  if (manual || firstTime || sigIds(S.feed) !== S.ids || S.error !== S.shownError || JSON.stringify(S.profiles) !== before) render();
  else for (const p of S.feed) if (!S.liking.has(p.id)) document.querySelectorAll(`#so-body .so-like[data-id="${p.id}"]`).forEach((btn) => paintLike(btn, p));
}
const sigIds = (feed) => feed.filter((p) => !S.gone.has(p.id)).map((p) => p.id).join(",");

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
      try { await refresh({ manual: true }); } finally {
        ind.classList.remove("spin"); busy = false; set(0, true);
        setTimeout(() => { inner.style.willChange = ""; }, 450);
      }
    } else { set(0, true); setTimeout(() => { inner.style.willChange = ""; }, 450); }
  };
  view.addEventListener("touchend", end); view.addEventListener("touchcancel", end);
  set(0);
}

export function initSocial() {
  bus.on("view", (v) => { if (v === "social") refresh(); else stopSong(); });
  bus.on("music-playing", stopSong);
  // a rebass made just now, posted from the Rebass screen
  bus.on("social-post", (song) => { location.hash = "#social"; setTimeout(() => composer({ song }), 50); });
  pullToRefresh();
  // new posts and likes come in on their own while the feed is open
  setInterval(() => { if (location.hash === "#social" && document.visibilityState === "visible" && !S.loading) refresh(); }, 45000);
}
export const social = { state: S };
