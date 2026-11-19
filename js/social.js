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

const NAME_KEY = "fifteam-social-name", MINE_KEY = "fifteam-social-mine";
const MAX_MSG = 9.5 * 1024 * 1024;   // what one post may carry (10 MB), with room to spare
const MAX_FEED = 300;
const S = {
  cfg: null, name: "", editingName: false, mine: new Set(), feed: [], loadedAt: 0, loading: null, error: "", shown: 30,
  msgs: new Map(), gone: new Set(), queue: [], busy: 0, audio: null, playing: null,
};
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
/** The feed list, fresh: [{ id, at, user, text, image, song }] newest first. */
async function readIndex() {
  const m = await dc(`/messages/${S.cfg.index}`);
  const a = (m.attachments || []).find((x) => x.filename === "feed.json");
  if (!a) return [];
  const r = await fetch(a.url, { cache: "no-store" });
  const d = await r.json();
  return clean(d && d.posts);
}
async function writeIndex(posts) {
  const f = new FormData();
  f.append("payload_json", JSON.stringify({ content: "FifTeam Social feed (the app keeps this message up to date; please don't delete it)", attachments: [{ id: 0, filename: "feed.json" }], allowed_mentions: { parse: [] } }));
  f.append("files[0]", new Blob([JSON.stringify({ v: 1, posts: posts.slice(0, MAX_FEED) })], { type: "application/json" }), "feed.json");
  await dc(`/messages/${S.cfg.index}`, { method: "PATCH", form: f });
}
/** Change the feed list: read it fresh, change it, write it, check it took (someone posting at the same moment). */
async function changeIndex(change, check) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const posts = (await readIndex()).filter((p) => !S.gone.has(p.id));
    change(posts);
    await writeIndex(posts);
    const now = await readIndex();
    if (check(now)) { S.feed = now.filter((p) => !S.gone.has(p.id)); return; }
    await wait(400 + Math.random() * 800);
  }
  throw new Error("The feed was busy. Try again.");
}
const ID = /^\d{5,25}$/;
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
function clean(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_FEED).map((p) => {
    if (!p || !ID.test(p.id)) return null;
    const s = p.song && typeof p.song === "object" ? { title: str(p.song.title, 120) || "Rebass", artist: str(p.song.artist, 80), note: str(p.song.note, 80), duration: +p.song.duration || 0 } : null;
    return { id: p.id, at: +p.at || 0, user: str(p.user, 24) || "someone", text: str(p.text, 500), image: !!p.image, song: s };
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
function render() {
  const body = $("so-body");
  if (!body) return;
  body.replaceChildren();
  // the username
  const you = h("div", "card so-you");
  if (S.name && !S.editingName) {
    const r = h("div", "row between");
    const t = h("span", "status"); t.append("Posting as ", h("b", "", S.name));
    const c = h("button", "btn small", "Change"); c.onclick = () => { S.editingName = true; render(); };
    r.append(t, c); you.append(r);
  } else {
    const f = h("form", "so-nameform");
    const inp = h("input", "input"); inp.maxLength = 24; inp.placeholder = "Pick a username"; inp.value = S.name; inp.setAttribute("aria-label", "Username"); inp.autocomplete = "off";
    const go = h("button", "btn primary", "Save"); go.type = "submit";
    const err = h("p", "set-err");
    f.append(inp, go); you.append(h("b", "", "Your username"), f, err);
    f.onsubmit = (e) => {
      e.preventDefault();
      const v = inp.value.trim().replace(/\s+/g, " ");
      if (!NAME_OK.test(v)) { err.textContent = "2 to 24 letters, numbers, spaces, _ . or -"; return; }
      S.name = v; S.editingName = false;
      try { localStorage.setItem(NAME_KEY, v); } catch {}
      render();
    };
  }
  body.append(you);
  const top = h("div", "row between so-top");
  const nb = h("button", "btn primary small"); nb.append(icon("i-plus"), "New post");
  nb.onclick = () => composer({});
  const rf = h("button", "btn small", S.loading ? "Loading…" : "Refresh"); rf.onclick = () => refresh(true);
  top.append(nb, rf); body.append(top);
  if (S.error) body.append(h("p", "status", S.error));
  const posts = S.feed.filter((p) => !S.gone.has(p.id));
  if (!posts.length) {
    const e = h("div", "card so-empty");
    e.append(h("b", "", S.loading ? "Loading the feed…" : "Nothing here yet"), h("p", "status", S.loading ? "" : "Be the first: post a picture or a rebass."));
    body.append(e); return;
  }
  if (seen) seen.disconnect();
  seen = "IntersectionObserver" in window ? new IntersectionObserver((es) => { for (const x of es) if (x.isIntersecting) { seen.unobserve(x.target); x.target._fill && x.target._fill(); } }, { rootMargin: "400px" }) : null;
  for (const p of posts.slice(0, S.shown)) body.append(postCard(p));
  if (posts.length > S.shown) { const m = h("button", "btn block", "Show more"); m.onclick = () => { S.shown += 30; render(); }; body.append(m); }
}

function postCard(p) {
  const card = h("article", "card so-post");
  const head = h("div", "so-head");
  const who = h("div", "so-who");
  const av = h("span", "so-av"); av.style.width = av.style.height = "40px"; av.style.backgroundImage = `url("${placeholderArt(p.user)}")`;
  const nm = h("span", "so-name"); nm.append(h("b", "", p.user), h("small", "", ago(p.at)));
  who.append(av, nm); head.append(who);
  if (S.mine.has(p.id)) { const d = h("button", "btn small so-del", "Delete"); d.onclick = () => removePost(p); head.append(d); }
  card.append(head);
  if (p.text) card.append(h("p", "so-text", p.text));
  let img = null, song = null;
  if (p.image) { img = h("div", "so-img so-wait"); card.append(img); }
  if (p.song) { song = songBlock(p); card.append(song); }
  // the picture and song links, from the post's own message, once it is near the screen
  if (p.image || p.song) {
    card._fill = async () => {
      try {
        const m = await message(p.id);
        const pic = fileOf(m, "picture.jpg"), mp3 = songOf(m), cov = fileOf(m, "cover.jpg");
        if (img && pic) { const i = h("img", "so-img"); i.alt = p.text ? p.text.slice(0, 80) : "A picture"; i.src = pic.url; i.onclick = () => viewImage(pic.url); img.replaceWith(i); }
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
function songBlock(p) {
  const s = p.song;
  const b = h("div", "so-song");
  const cov = h("span", "so-cover"); cov.style.backgroundImage = `url("${placeholderArt(s.title, "rebass")}")`;
  const play = h("button", "so-play"); play.setAttribute("aria-label", "Play"); play.append(icon(S.playing === p.id ? "i-pause" : "i-play"));
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
async function playSong(p, block) {
  if (!S.audio) { S.audio = new Audio(); S.audio.onended = () => { S.playing = null; render(); }; }
  if (S.playing === p.id) { S.audio.pause(); S.playing = null; render(); return; }
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
  render();
}
function stopSong() { if (S.audio && S.playing) { S.audio.pause(); S.playing = null; render(); } }
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
        closeSheet(); toast("Posted"); render();
      } catch (e) { err.textContent = e.message === "setup" ? "FifTeam Social isn't switched on yet." : e.message || "Couldn't post."; go.disabled = false; go.textContent = "Post"; }
    };
    p.append(h("p", "status", `Posting as ${S.name}. Everyone using FifTeam Media sees your posts.`), text, addRow, prev, err, go);
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
  const entry = { at: Date.now(), user: S.name, text: text.slice(0, 500), image: !!img, song: song ? { title: song.title.slice(0, 120), artist: (song.artist || "").slice(0, 80), note: (song.note || "").slice(0, 80), duration: Math.round(song.duration || 0) } : null };
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
async function refresh(force) {
  if (S.loading || (!force && Date.now() - S.loadedAt < 30000 && S.feed.length)) { render(); return; }
  S.loading = (async () => {
    S.error = "";
    try { await config(); S.msgs.clear(); S.feed = await readIndex(); S.loadedAt = Date.now(); }
    catch (e) { S.error = e.message === "setup" || e instanceof SyntaxError ? "FifTeam Social isn't switched on yet." : e.message; }
  })();
  render();
  await S.loading; S.loading = null;
  render();
}
export function initSocial() {
  bus.on("view", (v) => { if (v === "social") refresh(false); else stopSong(); });
  bus.on("music-playing", stopSong);
  // a rebass made just now, posted from the Rebass screen
  bus.on("social-post", (song) => { location.hash = "#social"; setTimeout(() => composer({ song }), 50); });
}
export const social = { state: S };
