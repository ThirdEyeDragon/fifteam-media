// The library screen: songs copied in from the phone, the rebasses and tones made here, search, and each track's menu.
import * as store from "./store.js";
import { readTags } from "./tags.js";
import { $, toast, openSheet, closeSheet, fmtTime, artUrl, forgetArt, placeholderArt, bus, onSeg, segValue } from "./ui.js";
import { player } from "./player.js";
import { sizeText, isIOS } from "./export.js";
import { pickImage } from "./image.js";
import { lockedPart, askUnlock, openCodeSheet, describeRecipe, fingerprint } from "./share.js";
import { categories, coverUrl, newCategory, chooseCategories, editCategory } from "./categories.js";

let tracks = [];
let kind = "song";
let cat = null;   // the category open in Rebassed (null: all of them)

export const library = {
  all: () => tracks,
  songs: () => tracks.filter((t) => (t.kind || "song") === "song").sort(byTitle),
  async refresh() {
    tracks = await store.listTracks();
    categories.prune(new Set(tracks.map((t) => t.id)));
    player.setTracks(tracks);
    render();
  },
  async add(meta, blob, art) {
    await store.putTrack(meta, blob, art);
    await this.refresh();
  },
};
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });

function durationOf(blob) {
  return new Promise((res) => {
    const a = new Audio(), u = URL.createObjectURL(blob);
    const done = (d) => { URL.revokeObjectURL(u); res(isFinite(d) ? d : 0); };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(a.duration || 0), 8000);
    a.src = u;
  });
}

const AUDIO_EXT = /\.(mp3|m4a|m4b|mp4|aac|wav|wave|flac|ogg|oga|opus|weba|webm|aif|aiff|aifc|caf|3gp|amr)$/i;
export async function importFiles(files) {
  // audio by its type or its name; some phones hand files over with no type at all, so anything not clearly something
  // else is given a try (if the phone can't play it, it is skipped)
  const all = Array.from(files);
  const list = all.filter((f) => /^(audio|video)\//.test(f.type) || AUDIO_EXT.test(f.name) || !f.type || f.type === "application/octet-stream");
  if (!list.length) { toast("Those files aren't audio files"); return []; }
  // locked songs a friend sent: each asks for its code
  const locked = [];
  for (const f of list.slice()) if ((/wav|wave/i.test(f.type) || /\.wav$/i.test(f.name)) && (await lockedPart(f))) { locked.push(f); list.splice(list.indexOf(f), 1); }
  if (locked.length) {
    const next = (i) => { if (i < locked.length) askUnlock(locked[i], async (r) => { await addUnlocked(r); next(i + 1); }); };
    next(0);
    if (!list.length) return [];
  }
  const have = new Set(tracks.map((t) => `${t.fileName}|${t.size}`));
  let added = 0, skipped = 0;
  const ids = [];
  store.askPersist();
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (have.has(`${f.name}|${f.size}`)) { skipped++; continue; }
    toast(`Adding ${i + 1} of ${list.length}: ${f.name}`, 60000);
    const tags = await readTags(f);
    const duration = await durationOf(f);
    if (!duration) { skipped++; toast(`This phone can't play ${f.name}`, 3000); continue; }
    const meta = {
      id: store.newId(), kind: "song", title: tags.title, artist: tags.artist, album: tags.album,
      duration, size: f.size, type: f.type || "audio/mpeg", fileName: f.name, added: Date.now(), hasArt: !!tags.art,
    };
    try { await store.putTrack(meta, f, tags.art); added++; ids.push(meta.id); }
    catch (e) { toast("Your phone ran out of room for more songs."); break; }
  }
  await library.refresh();
  toast(added ? `Added ${added} song${added > 1 ? "s" : ""}${skipped ? ` (${skipped} already here)` : ""}` : "Those songs are already in your library");
  return ids;
}

/** A locked song, opened: into the library with all its details. */
async function addUnlocked({ meta, audio, cover }) {
  const kindOf = meta.kind === "rebass" || meta.kind === "tone" ? meta.kind : "song";
  const t = {
    id: store.newId(), kind: kindOf, title: meta.title || "Shared song", artist: meta.artist || "", album: meta.album || "",
    note: meta.note || "", duration: meta.duration || (await durationOf(audio)), size: audio.size, type: audio.type,
    fileName: meta.fileName || `${meta.title || "song"}.wav`, added: Date.now(), hasArt: !!cover, from: "locked",
  };
  try { await library.add(t, audio, cover); toast(`${t.title} unlocked and added${kindOf === "rebass" ? ", under Rebassed" : ""}`, 3500); }
  catch { toast("Your phone is out of room for it."); }
}

/** A rebass code: find the song it was made from, and make the very same rebass. */
async function openRecipe(r) {
  const songs = tracks.filter((t) => (t.kind || "song") === "song");
  // the very same file first (its fingerprint), then the same song by name and length
  const near = songs.filter((t) => Math.abs((t.duration || 0) - r.duration) < 2.5);
  let match = null;
  for (const t of near) {
    if (!t.hash) { const b = await store.getBlob(t.id); if (b) { t.hash = await fingerprint(b); store.updateTrack({ ...t }).catch(() => {}); } }
    if (t.hash === r.hash) { match = t; break; }
  }
  let exact = !!match;
  if (!match) {
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    match = near.find((t) => norm(t.title) === norm(r.title) && (!r.artist || norm(t.artist) === norm(r.artist))) || null;
  }
  if (!match) {
    openSheet((p) => {
      p.innerHTML += `<h3>You need this song first</h3>`;
      const d = document.createElement("p"); d.className = "status"; d.textContent = describeRecipe(r); p.appendChild(d);
      const e = document.createElement("p"); e.className = "status"; e.textContent = "Add it to your library, then open the code again."; p.appendChild(e);
      const b = document.createElement("button"); b.className = "btn primary block"; b.textContent = "Add music";
      b.onclick = () => { closeSheet(); $("file-in").value = ""; $("file-in").click(); }; p.appendChild(b);
    });
    return;
  }
  toast(exact ? `Rebassing ${match.title} exactly as sent` : `Rebassing your copy of ${match.title} (a different file, so it may differ a little)`, 4000);
  const { rebass } = await import("./rebass.js");
  rebass.applyRecipe(match, r.settings);
}
export function openCode(prefill = "") {
  openCodeSheet({ prefill, onRecipe: openRecipe, onLockedFile: async (f) => {
    if (!(await lockedPart(f))) { toast("That isn't a locked FifTeam file"); return; }
    askUnlock(f, addUnlocked);
  } });
}

function itemHtml(t) {
  const sub = t.kind === "rebass" ? `<span class="badge">Rebass</span>${t.note || ""}` : t.kind === "tone" ? `<span class="badge">Tone</span>${t.note || ""}` : (t.artist || "Unknown artist");
  return `<div class="thumb" data-art="${t.id}"></div>
    <div class="meta"><div class="t"></div><div class="a">${sub} · ${fmtTime(t.duration)}</div></div>
    <button class="icon-btn more" aria-label="More for this song"><svg><use href="#i-more"/></svg></button>`;
}

async function paintThumb(el, t) {
  let u = null;
  if (t.hasArt) u = artUrl(t.id, await store.getArt(t.id));
  el.style.backgroundImage = `url("${u || placeholderArt(t.title, t.kind || "song")}")`;
}

/** The rebasses' categories: a row of covers to open one (and a tile to make one); an open one, its name and menu. */
function paintCats() {
  const box = $("lib-cats");
  box.hidden = kind !== "rebass";
  if (box.hidden) return;
  if (cat && !categories.get(cat)) cat = null;
  box.replaceChildren();
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  if (cat) {
    const c = categories.get(cat);
    const head = el("div", "cat-open");
    const back = el("button", "btn small", "‹ All"); back.onclick = () => { cat = null; render(); };
    const th = el("span", "cat-th big"); coverUrl(c).then((u) => { th.style.backgroundImage = `url("${u}")`; });
    const nm = el("span", "cat-cn"); nm.append(el("b", "", c.name), el("small", "", `${c.ids.length} song${c.ids.length === 1 ? "" : "s"}`));
    const more = el("button", "icon-btn more"); more.setAttribute("aria-label", `${c.name}: rename, cover, delete`); more.innerHTML = `<svg><use href="#i-more"/></svg>`;
    more.onclick = () => editCategory(c, (x) => { if (x === null) cat = null; render(); });
    head.append(back, th, nm, more);
    box.append(head);
    return;
  }
  const strip = el("div", "cat-strip");
  const add = el("button", "cat-tile cat-new"); add.append(el("span", "cat-cov", "+"), el("b", "", "New"), el("small", "", "category"));
  add.onclick = () => newCategory(() => render());
  strip.append(add);
  for (const c of categories.all()) {
    const tile = el("button", "cat-tile"); tile.dataset.cat = c.id;
    const cov = el("span", "cat-cov"); coverUrl(c).then((u) => { cov.style.backgroundImage = `url("${u}")`; });
    tile.append(cov, el("b", "", c.name), el("small", "", `${c.ids.length} song${c.ids.length === 1 ? "" : "s"}`));
    tile.onclick = () => { cat = c.id; render(); };
    strip.append(tile);
  }
  box.append(strip);
}
/** What the list shows: this kind, the open category (in Rebassed), and the search. */
function shownList() {
  const q = $("lib-search").value.trim().toLowerCase();
  const inCat = kind === "rebass" && cat ? new Set((categories.get(cat) || { ids: [] }).ids) : null;
  return tracks.filter((t) => (t.kind || "song") === kind)
    .filter((t) => !inCat || inCat.has(t.id))
    .filter((t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q))
    .sort(kind === "song" ? byTitle : (a, b) => b.added - a.added);
}
function render() {
  paintCats();
  const q = $("lib-search").value.trim().toLowerCase();
  const list = tracks.filter((t) => (t.kind || "song") === kind)
    .filter((t) => !(kind === "rebass" && cat) || (categories.get(cat) || { ids: [] }).ids.includes(t.id))
    .filter((t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q))
    .sort(kind === "song" ? byTitle : (a, b) => b.added - a.added);
  const ul = $("lib-list");
  ul.innerHTML = "";
  const io = new IntersectionObserver((ents) => ents.forEach((e) => {
    if (!e.isIntersecting) return;
    io.unobserve(e.target);
    paintThumb(e.target, tracks.find((x) => x.id === e.target.dataset.art));
  }), { rootMargin: "300px" });
  const cur = player.current;
  for (const t of list) {
    const li = document.createElement("li");
    li.className = "item"; li.dataset.id = t.id; li.innerHTML = itemHtml(t);
    li.querySelector(".t").textContent = t.title;
    const th = li.querySelector(".thumb");
    if (cur && cur.id === t.id) th.classList.add("playing");
    io.observe(th);
    ul.appendChild(li);
  }
  const empty = $("lib-empty");
  empty.hidden = list.length > 0;
  if (!list.length) {
    const msgs = {
      song: ["Bring your music in", "Pick songs from your phone. They are copied into FifTeam Media, so they are here every time you open it, even offline."],
      rebass: ["No rebasses yet", "Make one on the Rebass tab, then tap Add to my library to keep it here."],
      tone: ["No saved tones yet", "Build a tone on the Tones tab and add it to your library to keep it here."],
    };
    const [h, p] = kind === "rebass" && cat && !q ? [`Nothing in ${(categories.get(cat) || {}).name || "this category"} yet`, "Tap the dots next to a rebass and choose Categories to put it here."] : q ? ["Nothing matches", `No ${kind === "song" ? "songs" : kind === "rebass" ? "rebasses" : "tones"} match "${q}".`] : msgs[kind];
    $("lib-empty-h").textContent = h; $("lib-empty-p").textContent = p;
    $("lib-add-2").hidden = $("lib-add-dir").hidden = kind !== "song" || !!q;
  }
  const n = tracks.filter((t) => (t.kind || "song") === "song").length;
  store.storageUse().then((u) => { $("lib-foot").textContent = (n || u ? `${n} song${n === 1 ? "" : "s"} · ${sizeText(u)} kept on this device · ` : "") + "FifTeam Media 2.17"; });
}

function menu(t) {
  openSheet((p) => {
    const h = document.createElement("h3"); h.textContent = t.title; p.appendChild(h);
    const add = (icon, label, fn, cls = "") => {
      const b = document.createElement("button"); b.className = "menu-item " + cls;
      b.innerHTML = `<svg><use href="#${icon}"/></svg><span></span>`; b.querySelector("span").textContent = label;
      b.onclick = () => { closeSheet(); fn(); }; p.appendChild(b);
    };
    add("i-play", "Play", () => playIn(t));
    add("i-queue", "Play next", () => { player.playNext(t.id); toast("Plays next"); });
    if ((t.kind || "song") !== "tone") add("i-bass", "Rebass this song", () => bus.emit("rebass", t));
    if (t.kind === "rebass") add("i-send", "Send in a message", () => bus.emit("dm-send-track", t));
    if (t.kind === "rebass") add("i-folder", categories.of(t.id).length ? `Categories: ${categories.of(t.id).map((c) => c.name).join(", ")}`.slice(0, 60) : "Add to a category", () => chooseCategories(t, render));
    add("i-image", t.hasArt ? "Change cover image" : "Add a cover image", async () => {
      const b = await pickImage(); if (!b) return;
      await store.putArt(t.id, b);
      t.hasArt = true; await store.updateTrack(t);
      forgetArt(t.id); await library.refresh(); bus.emit("art", t.id);
      toast("Cover updated");
    });
    add("i-trash", "Remove from library", async () => {
      player.forget(t.id); forgetArt(t.id);
      await store.deleteTrack(t.id); await library.refresh(); toast("Removed");
    }, "danger");
  });
}

function playIn(t) {
  // (from what's on screen: the open category, or every one of this kind)
  const shown = shownList().filter((x) => (x.kind || "song") === (t.kind || "song"));
  const ids = (shown.some((x) => x.id === t.id) ? shown : tracks.filter((x) => (x.kind || "song") === (t.kind || "song")).sort(kind === "song" ? byTitle : (a, b) => b.added - a.added)).map((x) => x.id);
  player.playFrom(ids, t.id);
}

export function initLibrary() {
  const fileIn = $("file-in"), dirIn = $("dir-in");
  const pick = () => { fileIn.value = ""; fileIn.click(); };
  $("lib-add").onclick = pick; $("lib-add-2").onclick = pick;
  $("lib-code").onclick = () => openCode();
  $("lib-add-dir").onclick = () => { dirIn.value = ""; dirIn.click(); };
  fileIn.onchange = () => importFiles(fileIn.files);
  dirIn.onchange = () => importFiles(dirIn.files);
  if (!("webkitdirectory" in document.createElement("input")) || isIOS()) $("lib-add-dir").hidden = true;
  $("lib-search").addEventListener("input", render);
  onSeg($("lib-seg"), (k) => { kind = k; if (k !== "rebass") cat = null; render(); });
  $("lib-list").addEventListener("click", (e) => {
    const li = e.target.closest(".item"); if (!li) return;
    const t = tracks.find((x) => x.id === li.dataset.id); if (!t) return;
    if (e.target.closest(".more")) menu(t); else playIn(t);
  });
  bus.on("now", () => render());
  bus.on("queue", () => openSheet((p) => {
    const h = document.createElement("h3"); h.textContent = "Up next"; p.appendChild(h);
    const next = player.upNext();
    if (!next.length) { const e = document.createElement("p"); e.className = "status"; e.textContent = "Nothing queued after this song."; p.appendChild(e); return; }
    const ul = document.createElement("ul"); ul.className = "list"; p.appendChild(ul);
    next.slice(0, 50).forEach((t) => {
      const li = document.createElement("li"); li.className = "item"; li.innerHTML = itemHtml(t);
      li.querySelector(".t").textContent = t.title; li.querySelector(".more").remove();
      paintThumb(li.querySelector(".thumb"), t);
      li.onclick = () => { closeSheet(); player.playFrom(player.upNext().map((x) => x.id), t.id); };
      ul.appendChild(li);
    });
  }));
  // installing: Android offers a prompt; on iPhone it is Share > Add to Home Screen
  let deferred = null;
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; $("btn-install").hidden = false; });
  $("btn-install").onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $("btn-install").hidden = true; };
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  $("ios-hint").hidden = !(isIOS() && !standalone);
}
