// FifTeam Social: pictures and rebassed songs from everyone on FifTeam Media, with no server of our own.
//   Each person's account is a free GitHub account with one public repository named "fifteam-social" (their "space").
//   Everything they post lives there: fifteam.json (their profile, posts, likes and comments) and media/ (their
//   pictures and songs). The app writes to it with a key (a fine-grained GitHub token for that one repository) that
//   stays on their phone. Nobody else can write to it: there is no shared password or key anywhere in the app.
//   The feed finds everyone's spaces with GitHub's search and reads them straight from GitHub (raw files, public).
//   Likes and comments are written into the liker's or commenter's own space and added up by every reader.
// Everything shown from other people is text set with textContent and media paths checked against a strict pattern.
import { $, toast, openSheet, closeSheet, fmtTime, bus, placeholderArt, getCtx, artUrl } from "./ui.js";
import * as store from "./store.js";
import { library } from "./library.js";
import { player } from "./player.js";
import { fitJpeg, squareJpeg } from "./image.js";
import { makeFile, sizeText } from "./export.js";

const REPO = "fifteam-social", FILE = "fifteam.json", API = "https://api.github.com", RAW = "https://raw.githubusercontent.com";
const KEY = "fifteam-social-account", HIDE = "fifteam-social-hidden";
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, MEDIA = /^media\/[a-f0-9]{16,64}\.(jpg|mp3)$/, PID = /^[a-z0-9]{6,32}$/;
const MAX_SONG = 40 * 1024 * 1024, MAX_POSTS = 300, MAX_COMMENTS = 1000;
const S = {
  me: null,            // { login, token, branch }
  mine: null,          // my own space's data (fresh from GitHub)
  people: new Map(),   // login (lower case) -> { login, branch, data }
  blocked: new Set(), hidden: new Set(),
  loadedAt: 0, loading: null, error: "", tab: "feed", viewing: null, open: new Set(), shown: 30,
  audio: null, playing: null, blobs: new Map(),
};
try { const a = JSON.parse(localStorage.getItem(KEY) || "null"); if (a && LOGIN.test(a.login) && a.token) S.me = a; } catch {}
try { for (const l of JSON.parse(localStorage.getItem(HIDE) || "[]")) S.hidden.add(String(l).toLowerCase()); } catch {}

// ---------------------------------------------------------------------------------------------------- GitHub
async function gh(path, { method = "GET", body, token = S.me && S.me.token } = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      method, cache: "no-store", body: body ? JSON.stringify(body) : undefined,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: "Bearer " + token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    });
  } catch { return { ok: false, status: 0, data: null }; }
  let data = null; try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data, left: +r.headers.get("x-ratelimit-remaining") };
}
const why = (r) => r.status === 0 ? "You're offline, or GitHub can't be reached."
  : r.status === 401 ? "GitHub didn't accept your key (it may have expired). Sign out and in again with a new key."
  : r.status === 403 && r.left === 0 ? "GitHub is busy for this phone. Try again in a minute."
  : r.status === 403 || r.status === 404 ? "Your key can't write to your space. Make sure it is for the fifteam-social repository with Contents: Read and write."
  : r.status === 409 ? "Your space changed at the same time. Try again."
  : r.status === 422 && /too large|size/i.test(JSON.stringify(r.data || "")) ? "That file is too big for GitHub."
  : `GitHub said: ${(r.data && r.data.message) || r.status}`;
const b64ToText = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
const blobB64 = (blob) => new Promise((ok, bad) => { const f = new FileReader(); f.onload = () => ok(String(f.result).slice(String(f.result).indexOf(",") + 1)); f.onerror = bad; f.readAsDataURL(blob); });
async function hashName(blob, ext) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return `media/${Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")}.${ext}`;
}
const rawUrl = (login, branch, path) => `${RAW}/${login}/${REPO}/${branch || "main"}/${path}`;
const newPid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** One file into my space (a new one, or a new version of one I have the sha of). */
async function putFile(path, blob, message, sha) {
  const r = await gh(`/repos/${S.me.login}/${REPO}/contents/${path}`, { method: "PUT", body: { message, content: await blobB64(blob), ...(sha ? { sha } : {}) } });
  if (!r.ok) throw new Error(why(r));
  return r.data;
}
async function deleteFile(path) {
  const cur = await gh(`/repos/${S.me.login}/${REPO}/contents/${path}`);
  if (!cur.ok) return;
  await gh(`/repos/${S.me.login}/${REPO}/contents/${path}`, { method: "DELETE", body: { message: "Remove " + path, sha: cur.data.sha } });
}
/** My space, fresh from GitHub: { data, sha } (data null if it has none yet). */
async function readMine() {
  const r = await gh(`/repos/${S.me.login}/${REPO}/contents/${FILE}`);
  if (r.status === 404) return { data: null, sha: null, missing: true };
  if (!r.ok) throw new Error(why(r));
  return { data: clean(S.me.login, JSON.parse(b64ToText(r.data.content || ""))), sha: r.data.sha };
}
/** Change my space: read it fresh, change it, write it back (once more if it changed meanwhile). */
async function saveMine(change, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await readMine();
    const d = data || blank();
    change(d);
    d.updated = Date.now();
    try {
      await putFile(FILE, new Blob([JSON.stringify(d)], { type: "application/json" }), message, sha);
      S.mine = d;
      S.people.set(S.me.login.toLowerCase(), { login: S.me.login, branch: S.me.branch, data: d });
      return d;
    } catch (e) { if (attempt || !/changed at the same time/.test(e.message)) throw e; }
  }
}
const blank = () => ({ app: "fifteam-social", v: 1, profile: { name: "", bio: "", avatar: "" }, posts: [], likes: {}, comments: [], updated: 0 });

// what other people's spaces may contain: anything else is dropped
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const media = (v) => (typeof v === "string" && MEDIA.test(v) ? v : "");
function clean(login, d) {
  const o = blank();
  if (!d || d.app !== "fifteam-social") return null;
  const p = d.profile || {};
  o.profile = { name: str(p.name, 40).trim() || login, bio: str(p.bio, 160), avatar: media(p.avatar) };
  o.posts = (Array.isArray(d.posts) ? d.posts : []).slice(0, MAX_POSTS).map((x) => {
    if (!x || !PID.test(x.id)) return null;
    const s = x.song && media(x.song.file).endsWith(".mp3") ? { file: x.song.file, title: str(x.song.title, 120) || "Rebass", artist: str(x.song.artist, 80), note: str(x.song.note, 80), duration: num(x.song.duration), cover: media(x.song.cover) } : null;
    const img = media(x.image).endsWith(".jpg") ? x.image : "";
    if (!s && !img && !str(x.text, 500).trim()) return null;
    return { id: x.id, at: num(x.at), text: str(x.text, 500), image: img, song: s };
  }).filter(Boolean);
  o.likes = {};
  if (d.likes && typeof d.likes === "object") for (const [k, v] of Object.entries(d.likes).slice(0, 5000)) if (/^[A-Za-z0-9-]{1,39}\/[a-z0-9]{6,32}$/.test(k)) o.likes[k] = num(v);
  o.comments = (Array.isArray(d.comments) ? d.comments : []).slice(-MAX_COMMENTS).map((c) => (c && PID.test(c.id) && /^[A-Za-z0-9-]{1,39}\/[a-z0-9]{6,32}$/.test(c.on) && str(c.text, 300).trim() ? { id: c.id, on: c.on, at: num(c.at), text: str(c.text, 300) } : null)).filter(Boolean);
  o.updated = num(d.updated);
  return o;
}

// ---------------------------------------------------------------------------------------------------- finding everyone
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); }
async function load(force) {
  if (S.loading) return S.loading;
  if (!force && Date.now() - S.loadedAt < 60000 && S.people.size) return;
  S.loading = (async () => {
    S.error = "";
    // the app's own list of people hidden for everyone (abuse), kept in this app's repository
    try { const b = await (await fetch("social/blocked.json", { cache: "no-cache" })).json(); S.blocked = new Set((b.logins || []).map((l) => String(l).toLowerCase())); } catch {}
    const found = [];
    for (let page = 1; page <= 3; page++) {
      const r = await gh(`/search/repositories?q=${encodeURIComponent(REPO + " in:name")}&sort=updated&order=desc&per_page=100&page=${page}`);
      if (!r.ok) { if (!found.length) S.error = r.status === 403 || r.status === 429 ? "GitHub is busy. Pull to refresh in a minute." : why(r); break; }
      for (const it of r.data.items || []) if (it.name.toLowerCase() === REPO && !it.fork && it.owner && LOGIN.test(it.owner.login)) found.push({ login: it.owner.login, branch: it.default_branch || "main" });
      if ((r.data.items || []).length < 100) break;
    }
    // my own space, even before GitHub's search has caught up with it
    if (S.me && !found.some((f) => f.login.toLowerCase() === S.me.login.toLowerCase())) found.unshift({ login: S.me.login, branch: S.me.branch || "main" });
    const t = Date.now();
    await pool(found, 8, async ({ login, branch }) => {
      try {
        const r = await fetch(`${rawUrl(login, branch, FILE)}?t=${t}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = clean(login, await r.json());
        if (d) S.people.set(login.toLowerCase(), { login, branch, data: d });
      } catch {}
    });
    if (S.me && S.mine) S.people.set(S.me.login.toLowerCase(), { login: S.me.login, branch: S.me.branch, data: S.mine });
    S.loadedAt = Date.now();
  })().finally(() => { S.loading = null; });
  return S.loading;
}
const visible = (login) => !S.blocked.has(login.toLowerCase()) && !S.hidden.has(login.toLowerCase());
function allPosts() {
  const out = [];
  for (const p of S.people.values()) if (visible(p.login)) for (const post of p.data.posts) out.push({ person: p, post });
  return out.sort((a, b) => b.post.at - a.post.at);
}
function likesOf(key) { let n = 0; for (const p of S.people.values()) if (visible(p.login) && p.data.likes[key]) n++; return n; }
function commentsOf(key) {
  const out = [];
  for (const p of S.people.values()) if (visible(p.login)) for (const c of p.data.comments) if (c.on === key) out.push({ person: p, c });
  return out.sort((a, b) => a.c.at - b.c.at);
}

// ---------------------------------------------------------------------------------------------------- the screen
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const icon = (id) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + id); s.appendChild(u); return s; };
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + " min"; if (s < 86400) return Math.floor(s / 3600) + " h";
  if (s < 604800) return Math.floor(s / 86400) + " d";
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: s > 31536000 ? "numeric" : undefined });
}
function avatar(person, size = 40) {
  const a = h("span", "so-av"); a.style.width = a.style.height = size + "px";
  const p = person.data.profile;
  a.style.backgroundImage = `url("${p.avatar ? rawUrl(person.login, person.branch, p.avatar) : placeholderArt(p.name || person.login)}")`;
  return a;
}

function render() {
  const body = $("so-body");
  if (!body) return;
  document.querySelectorAll("#so-seg button").forEach((b) => b.classList.toggle("on", b.dataset.k === (S.viewing ? "" : S.tab)));
  body.replaceChildren();
  if (S.viewing) { renderProfile(body, S.viewing); return; }
  if (S.tab === "me") { if (S.me) renderProfile(body, S.me.login); else renderJoin(body); return; }
  // the feed
  const top = h("div", "row between so-top");
  const nb = h("button", "btn primary small"); nb.append(icon("i-plus"), "New post");
  nb.onclick = () => (S.me ? composer({}) : (S.tab = "me", render()));
  const rf = h("button", "btn small", S.loading ? "Loading…" : "Refresh"); rf.onclick = () => refresh(true);
  top.append(nb, rf); body.append(top);
  if (S.error) body.append(h("p", "status", S.error));
  const posts = allPosts();
  if (!posts.length) {
    const e = h("div", "card so-empty");
    e.append(h("b", "", S.loading ? "Loading the feed…" : "Nothing here yet"), h("p", "status", S.loading ? "Finding everyone on FifTeam Social." : "Be the first: post a picture or a rebass."));
    body.append(e); return;
  }
  for (const { person, post } of posts.slice(0, S.shown)) body.append(postCard(person, post));
  if (posts.length > S.shown) { const m = h("button", "btn block", "Show more"); m.onclick = () => { S.shown += 30; render(); }; body.append(m); }
}

function postCard(person, post) {
  const key = `${person.login}/${post.id}`, mine = S.me && person.login.toLowerCase() === S.me.login.toLowerCase();
  const card = h("article", "card so-post");
  const head = h("div", "so-head");
  const who = h("button", "so-who");
  who.append(avatar(person), (() => { const m = h("span", "so-name"); m.append(h("b", "", person.data.profile.name), h("small", "", `@${person.login} · ${ago(post.at)}`)); return m; })());
  who.onclick = () => openProfile(person.login);
  const more = h("button", "icon-btn so-more"); more.append(icon("i-more")); more.setAttribute("aria-label", "More");
  more.onclick = () => postMenu(person, post, mine);
  head.append(who, more); card.append(head);
  if (post.text) card.append(h("p", "so-text", post.text));
  if (post.image) {
    const img = h("img", "so-img"); img.loading = "lazy"; img.alt = post.text ? post.text.slice(0, 80) : "A picture"; img.src = rawUrl(person.login, person.branch, post.image);
    img.onclick = () => viewImage(img.src);
    card.append(img);
  }
  if (post.song) card.append(songBlock(person, post));
  // likes and comments
  const bar = h("div", "so-bar");
  const liked = !!(S.mine && S.mine.likes[key]), nLikes = likesOf(key), cs = commentsOf(key);
  const lk = h("button", "so-act" + (liked ? " on" : "")); lk.append(h("span", "so-heart", liked ? "♥" : "♡"), h("span", "", String(nLikes || "")));
  lk.setAttribute("aria-label", liked ? "Unlike" : "Like"); lk.onclick = () => like(key, !liked);
  const cm = h("button", "so-act"); cm.append(h("span", "", "💬"), h("span", "", String(cs.length || "")));
  cm.setAttribute("aria-label", "Comments"); cm.onclick = () => { S.open.has(key) ? S.open.delete(key) : S.open.add(key); render(); };
  bar.append(lk, cm); card.append(bar);
  if (S.open.has(key)) {
    const box = h("div", "so-comments");
    for (const { person: p, c } of cs) {
      const row = h("div", "so-comment");
      const t = h("div", "so-ctext"); t.append(h("b", "", p.data.profile.name + " "), h("span", "", c.text), h("small", "", " · " + ago(c.at)));
      row.append(avatar(p, 28), t);
      if (S.me && p.login.toLowerCase() === S.me.login.toLowerCase()) { const x = h("button", "so-cdel", "Delete"); x.onclick = () => uncomment(c.id); row.append(x); }
      box.append(row);
    }
    if (S.me) {
      const f = h("form", "so-cform"); const inp = h("input", "input"); inp.maxLength = 300; inp.placeholder = "Add a comment"; inp.setAttribute("aria-label", "Comment");
      const go = h("button", "btn small primary", "Send"); f.append(inp, go);
      f.onsubmit = (e) => { e.preventDefault(); if (inp.value.trim()) comment(key, inp.value.trim()); };
      box.append(f);
    } else box.append(h("p", "status", "Make an account (the Me tab) to comment."));
    card.append(box);
  }
  return card;
}

function songBlock(person, post) {
  const s = post.song, url = rawUrl(person.login, person.branch, s.file);
  const b = h("div", "so-song");
  const cov = h("span", "so-cover"); cov.style.backgroundImage = `url("${s.cover ? rawUrl(person.login, person.branch, s.cover) : placeholderArt(s.title, "rebass")}")`;
  const play = h("button", "so-play"); play.setAttribute("aria-label", "Play"); play.append(icon(S.playing === url ? "i-pause" : "i-play"));
  play.onclick = () => playSong(url, play);
  const meta = h("div", "so-smeta"); meta.append(h("b", "", s.title), h("small", "", [s.artist, s.note, s.duration ? fmtTime(s.duration) : ""].filter(Boolean).join(" · ")));
  const add = h("button", "so-add"); add.append(icon("i-plus")); add.setAttribute("aria-label", "Add to my library"); add.title = "Add to my library";
  add.onclick = () => addToLibrary(person, post, add);
  b.append(cov, play, meta, add);
  return b;
}
async function fetchBlob(url, type) {
  if (S.blobs.has(url)) return S.blobs.get(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error("download");
  const b = new Blob([await r.arrayBuffer()], { type });
  S.blobs.set(url, b); if (S.blobs.size > 6) S.blobs.delete(S.blobs.keys().next().value);
  return b;
}
async function playSong(url, btn) {
  if (!S.audio) { S.audio = new Audio(); S.audio.onended = () => { S.playing = null; render(); }; }
  if (S.playing === url) { S.audio.pause(); S.playing = null; render(); return; }
  try {
    btn.disabled = true;
    const b = await fetchBlob(url, "audio/mpeg");
    player.pause();
    if (S.audio.src) URL.revokeObjectURL(S.audio.src);
    S.audio.src = URL.createObjectURL(b);
    S.playing = url;
    await S.audio.play();
  } catch { toast("Couldn't play that song. Are you online?"); S.playing = null; }
  render();
}
function stopSong() { if (S.audio && S.playing) { S.audio.pause(); S.playing = null; render(); } }
async function addToLibrary(person, post, btn) {
  const s = post.song;
  try {
    btn.disabled = true; btn.classList.add("busy");
    const audio = await fetchBlob(rawUrl(person.login, person.branch, s.file), "audio/mpeg");
    let cover = null;
    if (s.cover) try { cover = await fetchBlob(rawUrl(person.login, person.branch, s.cover), "image/jpeg"); } catch {}
    const file = new File([audio], `${s.title}.mp3`.replace(/[\\/:*?"<>|]+/g, " "), { type: "audio/mpeg" });
    await library.add({ id: store.newId(), kind: "rebass", title: s.title, artist: s.artist || person.data.profile.name, album: "FifTeam Social", note: s.note || `from @${person.login}`,
      duration: s.duration, size: file.size, type: file.type, fileName: file.name, added: Date.now(), hasArt: !!cover, from: "social" }, file, cover);
    btn.classList.remove("busy"); btn.classList.add("done"); btn.setAttribute("aria-label", "In your library"); toast("Added to your library, under Rebassed");
  } catch { btn.disabled = false; btn.classList.remove("busy"); toast("Couldn't download that song. Are you online?"); }
}
function viewImage(src) {
  openSheet((p) => { const i = h("img", "so-full"); i.src = src; i.alt = "Picture"; p.append(i); });
}
function postMenu(person, post, mine) {
  openSheet((p) => {
    p.append(h("h3", "", mine ? "Your post" : person.data.profile.name));
    const item = (label, fn) => { const b = h("button", "menu-item", label); b.onclick = () => { closeSheet(); fn(); }; p.append(b); };
    if (mine) item("Delete this post", () => removePost(post));
    else {
      item(`See @${person.login}'s profile`, () => openProfile(person.login));
      item(`Hide @${person.login} on this phone`, () => hidePerson(person.login));
      item("Report this post", () => window.open(`https://github.com/ThirdEyeDragon/fifteam-media/issues/new?title=${encodeURIComponent("Report: @" + person.login + " post " + post.id)}&body=${encodeURIComponent("Post: https://github.com/" + person.login + "/" + REPO + "\nWhat's wrong:\n")}`, "_blank", "noopener"));
    }
  });
}
function hidePerson(login) {
  S.hidden.add(login.toLowerCase());
  try { localStorage.setItem(HIDE, JSON.stringify([...S.hidden])); } catch {}
  if (S.viewing && S.viewing.toLowerCase() === login.toLowerCase()) S.viewing = null;
  toast(`@${login} is hidden on this phone`); render();
}
function openProfile(login) { S.viewing = login; render(); $("view-social").scrollTop = 0; }

function renderProfile(body, login) {
  const person = S.people.get(login.toLowerCase());
  const mine = S.me && login.toLowerCase() === S.me.login.toLowerCase();
  if (S.viewing) { const back = h("button", "btn small so-back", "‹ Back"); back.onclick = () => { S.viewing = null; render(); }; body.append(back); }
  if (!person) {
    const c = h("div", "card");
    c.append(h("b", "", mine ? "Your space is ready" : `@${login}`), h("p", "status", mine ? "Set your name and picture, then post." : "Nothing to show."));
    if (mine) { const e = h("button", "btn primary", "Edit profile"); e.onclick = editProfile; c.append(e); }
    body.append(c); return;
  }
  const p = person.data.profile;
  const card = h("div", "card so-profile");
  const top = h("div", "so-ptop"); top.append(avatar(person, 84));
  const nm = h("div", "so-pname"); nm.append(h("b", "", p.name), h("small", "", "@" + person.login));
  const stats = h("small", "", `${person.data.posts.length} post${person.data.posts.length === 1 ? "" : "s"}`); nm.append(stats);
  top.append(nm); card.append(top);
  if (p.bio) card.append(h("p", "so-text", p.bio));
  const row = h("div", "row wrap");
  if (mine) {
    const e = h("button", "btn small", "Edit profile"); e.onclick = editProfile;
    const n = h("button", "btn small primary"); n.append(icon("i-plus"), "New post"); n.onclick = () => composer({});
    const o = h("button", "btn small", "Sign out"); o.onclick = signOut;
    row.append(n, e, o);
  } else {
    const hd = h("button", "btn small", "Hide on this phone"); hd.onclick = () => hidePerson(person.login); row.append(hd);
  }
  const gl = h("a", "btn small", "On GitHub"); gl.href = `https://github.com/${person.login}/${REPO}`; gl.target = "_blank"; gl.rel = "noopener"; row.append(gl);
  card.append(row); body.append(card);
  if (!person.data.posts.length) body.append(h("p", "status", mine ? "You haven't posted yet." : "No posts yet."));
  for (const post of [...person.data.posts].sort((a, b) => b.at - a.at)) body.append(postCard(person, post));
}

// ---------------------------------------------------------------------------------------------------- joining
const NEW_REPO = `https://github.com/new?name=${REPO}&visibility=public&description=${encodeURIComponent("My FifTeam Social space (FifTeam Media)")}`;
const NEW_KEY = `https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent("FifTeam Social")}&description=${encodeURIComponent("Lets FifTeam Media post to my fifteam-social space")}&expires_in=none&contents=write`;
function renderJoin(body) {
  const c = h("div", "card so-join");
  c.append(h("h3", "", "Make your FifTeam account"));
  c.append(h("p", "status", "FifTeam Social has no server: your account is a free GitHub account with a space of your own on it, where your profile, pictures and rebasses are kept. Everything you post there is public. Already set up? Just do step 4."));
  const step = (n, title, text, label, url) => {
    const s = h("div", "so-step"); s.append(h("span", "so-n", String(n)));
    const t = h("div", "grow"); t.append(h("b", "", title), h("p", "status", text));
    if (url) { const a = h("a", "btn small", label); a.href = url; a.target = "_blank"; a.rel = "noopener"; t.append(a); }
    s.append(t); return s;
  };
  c.append(step(1, "A GitHub account", "Free. Skip this if you have one.", "Make a GitHub account", "https://github.com/signup"));
  c.append(step(2, "Your space", "Opens GitHub with it filled in: keep it Public and tap Create repository. (If it says the name already exists, it's done.)", "Make my space", NEW_REPO));
  c.append(step(3, "Your key", "Opens GitHub's key page. Repository access: Only select repositories, then fifteam-social. Permissions: Contents, Read and write. Tap Generate token and copy it.", "Make my key", NEW_KEY));
  const s4 = h("div", "so-step"); s4.append(h("span", "so-n", "4"));
  const f = h("form", "grow stack-sm");
  f.append(h("b", "", "Your profile"));
  const key = h("input", "input"); key.type = "password"; key.placeholder = "Paste your key (github_pat_…)"; key.autocomplete = "off"; key.setAttribute("aria-label", "Your key");
  const name = h("input", "input"); name.maxLength = 40; name.placeholder = "Your name"; name.setAttribute("aria-label", "Your name");
  const bio = h("input", "input"); bio.maxLength = 160; bio.placeholder = "A line about you (optional)"; bio.setAttribute("aria-label", "About you");
  let pic = null;
  const picRow = h("div", "row"); const pv = h("span", "so-av"); pv.style.width = pv.style.height = "48px"; pv.style.backgroundImage = `url("${placeholderArt("?")}")`;
  const pb = h("button", "btn small", "Choose a profile picture"); pb.type = "button";
  pb.onclick = async () => { const { pickImage } = await import("./image.js"); const b = await pickImage(); if (b) { pic = await squareJpeg(b, 400); pv.style.backgroundImage = `url("${URL.createObjectURL(pic)}")`; } };
  picRow.append(pv, pb);
  const err = h("p", "set-err");
  const go = h("button", "btn primary block", "Create my account"); go.type = "submit";
  f.append(key, name, bio, picRow, err, go, h("p", "status", "Your key stays on this phone. FifTeam Media only uses it to write to your fifteam-social space."));
  f.onsubmit = async (e) => {
    e.preventDefault(); err.textContent = "";
    const token = key.value.replace(/\s/g, "");
    if (!token) { err.textContent = "Paste the key from step 3."; return; }
    go.disabled = true; go.textContent = "Checking…";
    try { await join(token, name.value.trim(), bio.value.trim(), pic); }
    catch (x) { err.textContent = x.message; }
    go.disabled = false; go.textContent = "Create my account";
  };
  s4.append(f); c.append(s4);
  body.append(c);
}
async function join(token, name, bio, pic) {
  const u = await gh("/user", { token });
  if (!u.ok) throw new Error(u.status === 401 ? "GitHub didn't accept that key. Copy it again (it starts with github_pat_)." : why(u));
  const login = u.data.login;
  const r = await gh(`/repos/${login}/${REPO}`, { token });
  if (!r.ok) throw new Error(r.status === 404 ? "Your space wasn't found, or the key can't see it. Do step 2, and in step 3 pick fifteam-social." : why(r));
  if (r.data.private) throw new Error("Your space is private, so nobody could see your posts. Make it Public on GitHub (Settings, Danger Zone).");
  S.me = { login, token, branch: r.data.default_branch || "main" };
  try {
    const { data, missing } = await readMine();
    if (pic) { const path = await hashName(pic, "jpg"); await putFile(path, pic, "Profile picture"); pic = path; }
    if (missing || name || bio || pic) {
      await saveMine((d) => {
        if (name || !d.profile.name) d.profile.name = (name || d.profile.name || u.data.name || login).slice(0, 40);
        if (bio) d.profile.bio = bio.slice(0, 160);
        if (pic) d.profile.avatar = pic;
      }, missing ? "Join FifTeam Social" : "Update profile");
    } else { S.mine = data; S.people.set(login.toLowerCase(), { login, branch: S.me.branch, data }); }
  } catch (e) { S.me = null; throw e; }
  try { localStorage.setItem(KEY, JSON.stringify(S.me)); } catch {}
  toast(`Welcome, ${S.mine.profile.name}`);
  S.tab = "me"; render();
}
function signOut() {
  if (!confirm("Sign out of FifTeam Social on this phone? Your posts stay on GitHub.")) return;
  S.me = null; S.mine = null;
  try { localStorage.removeItem(KEY); } catch {}
  S.tab = "feed"; S.viewing = null; render();
}
function editProfile() {
  const d = S.mine || blank();
  openSheet((p) => {
    p.append(h("h3", "", "Edit profile"));
    const name = h("input", "input"); name.maxLength = 40; name.value = d.profile.name; name.setAttribute("aria-label", "Your name");
    const bio = h("input", "input"); bio.maxLength = 160; bio.value = d.profile.bio; bio.placeholder = "A line about you"; bio.setAttribute("aria-label", "About you");
    let pic = null;
    const pv = h("span", "so-av"); pv.style.width = pv.style.height = "64px";
    pv.style.backgroundImage = `url("${d.profile.avatar ? rawUrl(S.me.login, S.me.branch, d.profile.avatar) : placeholderArt(d.profile.name || "?")}")`;
    const pb = h("button", "btn small", "Change picture");
    pb.onclick = async () => { const { pickImage } = await import("./image.js"); const b = await pickImage(); if (b) { pic = await squareJpeg(b, 400); pv.style.backgroundImage = `url("${URL.createObjectURL(pic)}")`; } };
    const row = h("div", "row"); row.append(pv, pb);
    const err = h("p", "set-err"), save = h("button", "btn primary block", "Save");
    save.onclick = async () => {
      save.disabled = true; save.textContent = "Saving…"; err.textContent = "";
      try {
        let path = "";
        if (pic) { path = await hashName(pic, "jpg"); await putFile(path, pic, "Profile picture"); }
        await saveMine((x) => { x.profile.name = name.value.trim().slice(0, 40) || S.me.login; x.profile.bio = bio.value.trim().slice(0, 160); if (path) x.profile.avatar = path; }, "Update profile");
        closeSheet(); toast("Profile saved"); render();
      } catch (e) { err.textContent = e.message; save.disabled = false; save.textContent = "Save"; }
    };
    p.append(row, name, bio, err, save);
  });
}

// ---------------------------------------------------------------------------------------------------- posting
/** The new-post sheet. preset: { song: { title, artist, note, duration, cover (Blob), file: () => Promise<File> } } */
function composer(preset) {
  if (!S.me) { location.hash = "#social"; S.tab = "me"; render(); toast("Make your FifTeam account first"); return; }
  let img = preset.img || null, song = preset.song || null;
  openSheet((p) => {
    p.append(h("h3", "", "New post"));
    const text = h("textarea", "input so-compose"); text.rows = 3; text.maxLength = 500; text.placeholder = "Say something"; text.setAttribute("aria-label", "Your post");
    text.value = preset.text || "";
    const prev = h("div", "stack-sm");
    const paint = () => {
      prev.replaceChildren();
      if (img) { const i = h("img", "so-img"); i.src = URL.createObjectURL(img); const x = h("button", "btn small", "Remove picture"); x.onclick = () => { img = null; paint(); }; prev.append(i, x); }
      if (song) { const s = h("div", "so-song"); const c = h("span", "so-cover"); c.style.backgroundImage = `url("${song.cover ? URL.createObjectURL(song.cover) : placeholderArt(song.title, "rebass")}")`;
        const m = h("div", "so-smeta"); m.append(h("b", "", song.title), h("small", "", [song.artist, song.note, song.duration ? fmtTime(song.duration) : ""].filter(Boolean).join(" · ")));
        const x = h("button", "btn small", "Remove"); x.onclick = () => { song = null; paint(); }; s.append(c, m, x); prev.append(s); }
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
        closeSheet(); toast("Posted"); S.viewing = null; S.tab = "feed"; render();
      } catch (e) { err.textContent = e.message || "Couldn't post."; go.disabled = false; go.textContent = "Post"; }
    };
    p.append(text, addRow, prev, err, go, h("p", "status", "Everyone can see what you post."));
    paint();
  });
}
function pickAny() {
  return new Promise((res) => { const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.onchange = () => res(i.files && i.files[0]); i.addEventListener("cancel", () => res(null)); i.click(); });
}
/** Choose one of the rebasses in the library. */
function pickRebass(done) {
  const list = library.all().filter((t) => t.kind === "rebass").sort((a, b) => (b.added || 0) - (a.added || 0));
  // (this sheet takes the composer's place; the composer comes back with the choice, and what was typed)
  openSheet((p) => {
    p.append(h("h3", "", "Choose a rebass"));
    if (!list.length) { p.append(h("p", "status", "Your library has no rebasses yet. Make one on the Rebass tab and tap Add to library.")); return; }
    const ul = h("ul", "list"); p.append(ul);
    for (const t of list) {
      const li = h("li", "item"); const th = h("div", "thumb");
      (async () => { let u = null; if (t.hasArt) u = artUrl(t.id, await store.getArt(t.id)); th.style.backgroundImage = `url("${u || placeholderArt(t.title, "rebass")}")`; })();
      const m = h("div", "meta"); m.append(h("div", "t", t.title), h("div", "a", [t.note, fmtTime(t.duration)].filter(Boolean).join(" · ")));
      li.append(th, m);
      li.onclick = async () => {
        const cover = t.hasArt ? await store.getArt(t.id) : null;
        done({ title: t.title, artist: t.artist || "", note: t.note || "", duration: t.duration || 0, cover, file: () => libraryMp3(t) });
      };
      ul.append(li);
    }
  });
}
/** A library track as an MP3 (WAVs are turned into MP3 320 first: a fifth of the size). */
async function libraryMp3(t) {
  const blob = await store.getBlob(t.id);
  if (!blob) throw new Error("That song's audio is missing.");
  if (/mpeg|mp3/.test(blob.type) || /\.mp3$/i.test(t.fileName || "")) return new File([blob], (t.fileName || t.title + ".mp3"), { type: "audio/mpeg" });
  const ctx = getCtx(), buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const chs = [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)];
  const cover = t.hasArt ? await store.getArt(t.id) : null;
  return (await makeFile(chs, buf.sampleRate, t.title, "mp3", ctx, null, { title: t.title, artist: t.artist || "", album: "FifTeam Social", cover })).file;
}
async function post(text, img, song, say) {
  const p = { id: newPid(), at: Date.now(), text: text.slice(0, 500), image: "", song: null };
  if (img) { say("Uploading the picture…"); p.image = await hashName(img, "jpg"); await putFile(p.image, img, "Picture"); }
  if (song) {
    say("Getting the song ready…");
    const f = await song.file();
    if (f.size > MAX_SONG) throw new Error(`That song is ${sizeText(f.size)} as an MP3; the most is ${sizeText(MAX_SONG)}.`);
    say(`Uploading the song (${sizeText(f.size)})…`);
    const path = await hashName(f, "mp3"); await putFile(path, f, "Song: " + song.title.slice(0, 60));
    let cover = "";
    if (song.cover) { try { const c = await squareJpeg(song.cover, 512); cover = await hashName(c, "jpg"); await putFile(cover, c, "Cover"); } catch { cover = ""; } }
    p.song = { file: path, title: song.title.slice(0, 120), artist: (song.artist || "").slice(0, 80), note: (song.note || "").slice(0, 80), duration: Math.round(song.duration || 0), cover };
  }
  say("Posting…");
  await saveMine((d) => { d.posts.unshift(p); d.posts = d.posts.slice(0, MAX_POSTS); }, "New post");
}
async function removePost(p) {
  if (!confirm("Delete this post?")) return;
  try {
    await saveMine((d) => { d.posts = d.posts.filter((x) => x.id !== p.id); d.comments = d.comments.filter((c) => c.on !== `${S.me.login}/${p.id}`); }, "Delete post");
    render(); toast("Deleted");
    for (const f of [p.image, p.song && p.song.file, p.song && p.song.cover]) if (f) deleteFile(f).catch(() => {});
  } catch (e) { toast(e.message); }
}
async function like(key, on) {
  if (!S.me) { toast("Make an account (the Me tab) to like posts."); return; }
  if (!S.mine) { try { S.mine = (await readMine()).data || blank(); } catch {} }
  if (S.mine) { if (on) S.mine.likes[key] = Date.now(); else delete S.mine.likes[key]; render(); }
  try { await saveMine((d) => { if (on) d.likes[key] = Date.now(); else delete d.likes[key]; }, on ? "Like" : "Unlike"); render(); }
  catch (e) { toast(e.message); }
}
async function comment(key, text) {
  try { await saveMine((d) => { d.comments.push({ id: newPid(), on: key, at: Date.now(), text: text.slice(0, 300) }); d.comments = d.comments.slice(-MAX_COMMENTS); }, "Comment"); render(); }
  catch (e) { toast(e.message); }
}
async function uncomment(id) {
  try { await saveMine((d) => { d.comments = d.comments.filter((c) => c.id !== id); }, "Delete comment"); render(); }
  catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------------------------------------------- wiring
async function refresh(force) {
  const p = load(force); render();
  try { await p; } catch (e) { S.error = e.message || "Couldn't load the feed."; }
  if (S.me && !S.mine) { try { const { data } = await readMine(); if (data) { S.mine = data; S.people.set(S.me.login.toLowerCase(), { login: S.me.login, branch: S.me.branch, data }); } } catch {} }
  render();
}
export function initSocial() {
  document.querySelectorAll("#so-seg button").forEach((b) => (b.onclick = () => { S.tab = b.dataset.k; S.viewing = null; render(); if (S.tab === "feed") refresh(false); }));
  bus.on("view", (v) => { if (v === "social") refresh(false); else stopSong(); });
  bus.on("music-playing", stopSong);
  // a rebass made just now, posted from the Rebass screen
  bus.on("social-post", (song) => { location.hash = "#social"; setTimeout(() => composer({ song }), 50); });
}
export const social = { get account() { return S.me && { login: S.me.login }; }, state: S };
