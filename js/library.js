// The library screen: songs copied in from the phone, the rebasses and tones made here, search, and each track's menu.
import * as store from "./store.js";
import { readTags } from "./tags.js";
import { $, toast, openSheet, closeSheet, fmtTime, artUrl, forgetArt, placeholderArt, bus, onSeg, segValue } from "./ui.js";
import { player } from "./player.js";
import { sizeText, isIOS } from "./export.js";

let tracks = [];
let kind = "song";

export const library = {
  all: () => tracks,
  songs: () => tracks.filter((t) => (t.kind || "song") === "song").sort(byTitle),
  async refresh() {
    tracks = await store.listTracks();
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

export async function importFiles(files) {
  const list = Array.from(files).filter((f) => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|wav|flac|ogg|opus|aif|aiff)$/i.test(f.name));
  if (!list.length) { toast("Those files aren't audio files"); return []; }
  const have = new Set(tracks.map((t) => `${t.fileName}|${t.size}`));
  let added = 0, skipped = 0;
  const ids = [];
  store.askPersist();
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (have.has(`${f.name}|${f.size}`)) { skipped++; continue; }
    toast(`Adding ${i + 1} of ${list.length}: ${f.name}`, 60000);
    const tags = await readTags(f);
    const meta = {
      id: store.newId(), kind: "song", title: tags.title, artist: tags.artist, album: tags.album,
      duration: await durationOf(f), size: f.size, type: f.type || "audio/mpeg", fileName: f.name, added: Date.now(), hasArt: !!tags.art,
    };
    try { await store.putTrack(meta, f, tags.art); added++; ids.push(meta.id); }
    catch (e) { toast("Your phone ran out of room for more songs."); break; }
  }
  await library.refresh();
  toast(added ? `Added ${added} song${added > 1 ? "s" : ""}${skipped ? ` (${skipped} already here)` : ""}` : "Those songs are already in your library");
  return ids;
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

function render() {
  const q = $("lib-search").value.trim().toLowerCase();
  const list = tracks.filter((t) => (t.kind || "song") === kind)
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
    const [h, p] = q ? ["Nothing matches", `No ${kind === "song" ? "songs" : kind === "rebass" ? "rebasses" : "tones"} match "${q}".`] : msgs[kind];
    $("lib-empty-h").textContent = h; $("lib-empty-p").textContent = p;
    $("lib-add-2").hidden = $("lib-add-dir").hidden = kind !== "song" || !!q;
  }
  const n = tracks.filter((t) => (t.kind || "song") === "song").length;
  store.storageUse().then((u) => { $("lib-foot").textContent = n || u ? `${n} song${n === 1 ? "" : "s"} · ${sizeText(u)} kept on this device` : ""; });
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
    add("i-trash", "Remove from library", async () => {
      player.forget(t.id); forgetArt(t.id);
      await store.deleteTrack(t.id); await library.refresh(); toast("Removed");
    }, "danger");
  });
}

function playIn(t) {
  const ids = tracks.filter((x) => (x.kind || "song") === (t.kind || "song")).sort(kind === "song" ? byTitle : (a, b) => b.added - a.added).map((x) => x.id);
  player.playFrom(ids, t.id);
}

export function initLibrary() {
  const fileIn = $("file-in"), dirIn = $("dir-in");
  const pick = () => { fileIn.value = ""; fileIn.click(); };
  $("lib-add").onclick = pick; $("lib-add-2").onclick = pick;
  $("lib-add-dir").onclick = () => { dirIn.value = ""; dirIn.click(); };
  fileIn.onchange = () => importFiles(fileIn.files);
  dirIn.onchange = () => importFiles(dirIn.files);
  if (!("webkitdirectory" in document.createElement("input")) || isIOS()) $("lib-add-dir").hidden = true;
  $("lib-search").addEventListener("input", render);
  onSeg($("lib-seg"), (k) => { kind = k; render(); });
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
