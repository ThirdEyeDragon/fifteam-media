// Categories for the rebassed songs in the library: made by the user, named whatever they like, each with its own cover
// picture. A song can be in as many as wanted. Kept on this phone: the list in localStorage, the covers (small square
// JPEGs) with the songs' cover art in the app's database.
import * as store from "./store.js";
import { toast, openSheet, closeSheet, artUrl, forgetArt, placeholderArt } from "./ui.js";
import { pickImage, squareJpeg } from "./image.js";

const KEY = "fifteam-cats";
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let cats = [];
try { cats = (JSON.parse(localStorage.getItem(KEY) || "[]") || []).filter((c) => c && c.id && typeof c.name === "string"); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cats)); } catch { toast("Couldn't save that on this phone."); } };
const artKey = (c) => "cat-" + c.id;

export const categories = {
  all: () => cats,
  get: (id) => cats.find((c) => c.id === id) || null,
  /** Songs taken out of the library: out of every category too. */
  prune(have) { let changed = false; for (const c of cats) { const n = c.ids.filter((x) => have.has(x)); if (n.length !== c.ids.length) { c.ids = n; changed = true; } } if (changed) save(); },
  of: (trackId) => cats.filter((c) => c.ids.includes(trackId)),
};

/** A category's cover: its own picture, or a made-up one from its name. */
export async function coverUrl(c) {
  if (c.cover) { const u = artUrl(artKey(c), await store.getArt(artKey(c)).catch(() => null)); if (u) return u; }
  return placeholderArt(c.name, "rebass");
}

/** Make a category (and, given a song, put it in): a name and, if wanted, a cover picture. */
export function newCategory(onDone, trackId) {
  let cover = null;
  openSheet((p) => {
    p.append(h("h3", "", "New category"));
    const f = h("form", "cat-form");
    const pic = h("button", "cat-pick"); pic.type = "button"; pic.setAttribute("aria-label", "Cover picture");
    pic.style.backgroundImage = `url("${placeholderArt("+", "rebass")}")`;
    const lbl = h("span", "cat-pick-l", "Add a cover"); pic.append(lbl);
    pic.onclick = async () => { const b = await pickImage(); if (!b) return; cover = await squareJpeg(b, 400).catch(() => b); pic.style.backgroundImage = `url("${URL.createObjectURL(cover)}")`; lbl.textContent = "Change cover"; };
    const inp = h("input", "input"); inp.maxLength = 40; inp.placeholder = "Name it (e.g. Car bangers)"; inp.setAttribute("aria-label", "Category name"); inp.autocomplete = "off";
    const err = h("p", "set-err");
    const go = h("button", "btn primary block", "Create"); go.type = "submit";
    f.append(pic, inp, err, go);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const name = inp.value.trim().replace(/\s+/g, " ");
      if (!name) { err.textContent = "Give it a name"; return; }
      if (cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) { err.textContent = "You already have a category with that name"; return; }
      const c = { id: store.newId(), name, ids: trackId ? [trackId] : [], cover: false, at: Date.now() };
      if (cover) { try { await store.putArt(artKey(c), cover); c.cover = true; } catch {} }
      cats.push(c); save();
      closeSheet(); toast(trackId ? `Made ${name} and added the song` : `Made ${name}`);
      onDone && onDone(c);
    };
    p.append(f);
    setTimeout(() => inp.focus(), 80);
  });
}

/** Which categories a song is in: tick or untick each, or make a new one. */
export function chooseCategories(t, onDone) {
  openSheet((p) => {
    p.append(h("h3", "", "Categories"));
    p.append(h("p", "status", t.title));
    const list = h("div", "cat-checks");
    const paint = () => {
      list.replaceChildren();
      if (!cats.length) list.append(h("p", "status", "No categories yet."));
      for (const c of cats) {
        const on = c.ids.includes(t.id);
        const row = h("button", "cat-check" + (on ? " on" : ""));
        const th = h("span", "cat-th"); coverUrl(c).then((u) => { th.style.backgroundImage = `url("${u}")`; });
        const nm = h("span", "cat-cn"); nm.append(h("b", "", c.name), h("small", "", `${c.ids.length} song${c.ids.length === 1 ? "" : "s"}`));
        row.append(th, nm, h("span", "cat-tick", on ? "✓" : ""));
        row.setAttribute("aria-pressed", String(on));
        row.onclick = () => { if (on) c.ids = c.ids.filter((x) => x !== t.id); else c.ids.push(t.id); save(); paint(); onDone && onDone(); };
        list.append(row);
      }
    };
    paint();
    const nb = h("button", "btn block"); nb.append("+ New category");
    nb.onclick = () => newCategory(() => onDone && onDone(), t.id);
    p.append(list, nb);
  });
}

/** A category made from a playlist someone shared (its songs just added to the library). */
export async function createCategory(name, ids, cover) {
  let n = String(name || "Playlist").slice(0, 40), k = 2;
  while (cats.some((c) => c.name.toLowerCase() === n.toLowerCase())) n = `${String(name).slice(0, 36)} (${k++})`;
  const c = { id: store.newId(), name: n, ids: [...ids], cover: false, at: Date.now() };
  if (cover) { try { await store.putArt(artKey(c), await squareJpeg(cover, 400).catch(() => cover)); c.cover = true; } catch {} }
  cats.push(c); save();
  return c;
}
/** A category, shared to Social as a playlist: everyone can play its songs or add them all. */
function shareCategory(c) {
  openSheet((p) => {
    p.append(h("h3", "", "Share to Social"));
    p.append(h("p", "status", `${c.name} · ${c.ids.length} song${c.ids.length === 1 ? "" : "s"}${c.ids.length > 25 ? " (the first 25 go up)" : ""}. Everyone can play the songs or add them all to their library.`));
    const t = h("textarea", "input so-compose"); t.rows = 2; t.maxLength = 500; t.placeholder = "Say something about it (optional)"; t.setAttribute("aria-label", "About the playlist");
    const err = h("p", "set-err"), go = h("button", "btn primary block", "Share playlist");
    go.onclick = async () => {
      go.disabled = true; err.textContent = "";
      try {
        const [{ sharePlaylist }, { library }] = await Promise.all([import("./social.js"), import("./library.js")]);
        const tracks = c.ids.map((id) => library.all().find((x) => x.id === id)).filter(Boolean);
        const cover = c.cover ? await store.getArt(artKey(c)).catch(() => null) : null;
        const n = await sharePlaylist(c, tracks, cover, t.value.trim(), (m) => { go.textContent = m; });
        closeSheet(); toast(`Shared ${c.name} (${n} songs)`, 3000);
        location.hash = "#social";
      } catch (e) { err.textContent = e.message || "Couldn't share it. Try again."; go.disabled = false; go.textContent = "Share playlist"; }
    };
    p.append(t, err, go);
  });
}
/** A category's own menu: rename, change the cover, delete (the songs stay in the library). */
export function editCategory(c, onDone) {
  openSheet((p) => {
    p.append(h("h3", "", c.name));
    const item = (label, fn, cls = "") => { const b = h("button", "menu-item " + cls); b.append(h("span", "", label)); b.onclick = fn; p.append(b); };
    if (c.ids.length) item("Share to Social", () => shareCategory(c));
    item("Rename", () => {
      const n = prompt("New name", c.name);
      if (n == null) return;
      const v = n.trim().replace(/\s+/g, " ").slice(0, 40);
      if (!v) return;
      c.name = v; save(); closeSheet(); onDone && onDone();
    });
    item(c.cover ? "Change cover" : "Add a cover", async () => {
      const b = await pickImage(); if (!b) return;
      try { await store.putArt(artKey(c), await squareJpeg(b, 400).catch(() => b)); c.cover = true; forgetArt(artKey(c)); save(); closeSheet(); toast("Cover updated"); onDone && onDone(); }
      catch { toast("Couldn't save that picture."); }
    });
    item("Delete category", async () => {
      if (!confirm(`Delete ${c.name}? Its songs stay in your library.`)) return;
      cats = cats.filter((x) => x !== c); save();
      try { await store.deleteArt(artKey(c)); } catch {}
      forgetArt(artKey(c));
      closeSheet(); toast("Category deleted"); onDone && onDone(null);
    }, "danger");
  });
}
