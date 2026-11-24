// Audio Market, inside Social: people selling audio gear. A listing is photos (up to 4), a title, a price, a category,
// its condition, a description and where it is: the seller's town, and a rough spot (rounded to about 3 miles) so
// buyers see how far away it is. Browse it like a marketplace: search, distance from you, price, category, newest or
// closest or cheapest first. "Message seller" opens a chat about that listing (kept apart from your other messages
// with them, under Audio Market in Messages).
//   The listings are kept in a store message of their own (social/config.json "market"); each listing's photos are on
//   its own message, like a post's.
import { $, toast, openSheet, closeSheet } from "./ui.js";
import { api } from "./social.js";
import { jsonStore } from "./meta.js";
import { openChat } from "./dms.js";
import { openProfile } from "./profile.js";
import { fitJpeg } from "./image.js";
import { offensive, OFFENSIVE } from "./filter.js";

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const PHONE = /^[a-z0-9]{6,16}$/, ID = /^\d{5,25}$/;
export const CATS = ["Subwoofers", "Amplifiers", "Speakers", "Head units", "Wiring & power", "Enclosures", "Other"];
const CONDS = ["New", "Used – like new", "Used – good", "Used – fair"];
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v, lo, hi) => { const x = +v; return isFinite(x) ? Math.max(lo, Math.min(hi, x)) : null; };

function cleanMarket(d) {
  const out = { v: 1, items: [] };
  for (const x of (d && Array.isArray(d.items) ? d.items : []).slice(0, 500)) {
    if (!x || !ID.test(x.id) || !PHONE.test(x.by)) continue;
    const lat = num(x.lat, -90, 90), lon = num(x.lon, -180, 180);
    out.items.push({
      id: x.id, by: x.by, user: str(x.user, 24) || "someone", title: str(x.title, 70) || "Item", price: Math.round(num(x.price, 0, 1e6) || 0),
      cat: CATS.includes(x.cat) ? x.cat : "Other", cond: CONDS.includes(x.cond) ? x.cond : "", desc: str(x.desc, 1500), place: str(x.place, 50),
      lat: lat == null ? null : lat, lon: lon == null ? null : lon, at: +x.at || 0, n: Math.max(1, Math.min(4, +x.n || 1)), sold: x.sold ? 1 : 0,
    });
  }
  return out;
}
const store = jsonStore("market", "market.json", "FifTeam Audio Market", cleanMarket);
const M = { items: [], at: 0, loading: null, q: "", sort: "new", cat: "", min: null, max: null, dist: 0, mine: false };
try { const f = JSON.parse(localStorage.getItem("fifteam-market-filters") || "{}"); Object.assign(M, { sort: f.sort || "new", cat: f.cat || "", min: f.min ?? null, max: f.max ?? null, dist: +f.dist || 0 }); } catch {}
const saveFilters = () => { try { localStorage.setItem("fifteam-market-filters", JSON.stringify({ sort: M.sort, cat: M.cat, min: M.min, max: M.max, dist: M.dist })); } catch {} };
try { const c = JSON.parse(localStorage.getItem("fifteam-market") || "null"); if (c && Array.isArray(c.items)) M.items = cleanMarket(c).items; } catch {}

// ---------------------------------------------------------------------------------------------------- where
/** This phone's rough spot (rounded to about 3 miles) and its town, from the phone's location (the phone asks the
 * person first), kept on the phone. Nobody types a place: the town comes from the rough spot (a free lookup that's only
 * ever sent the rounded spot). */
let here = null;
try { here = JSON.parse(localStorage.getItem("fifteam-market-here") || "null"); } catch {}
const round = (x) => Math.round(x * 20) / 20;
function locate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) { rej(new Error("This phone can't share its location.")); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      const lat = round(p.coords.latitude), lon = round(p.coords.longitude);
      const keep = (place) => { here = { lat, lon, place: place || (here && here.lat === lat && here.lon === lon ? here.place : "") || "", at: Date.now() }; try { localStorage.setItem("fifteam-market-here", JSON.stringify(here)); } catch {} res(here); };
      townOf(lat, lon).then(keep, () => keep(""));
    }, (e) => rej(new Error(e.code === 1 ? "Location is turned off for FifTeam Media. Allow it in your phone's settings." : "Couldn't find your location. Try again.")), { enableHighAccuracy: false, timeout: 15000, maximumAge: 3600e3 });
  });
}
/** The town at a rough spot: "Toledo, OH" (a US state's two letters), or "Lyon, France". */
async function townOf(lat, lon) {
  const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, { cache: "force-cache" });
  if (!r.ok) throw new Error("town");
  const d = await r.json(), town = (d.city || d.locality || "").trim().replace(/^(city|town|village|township|borough) of /i, "");
  const st = (d.principalSubdivisionCode || "").split("-")[1] || "";
  return (town ? `${town}, ${d.countryCode === "US" && st ? st : d.countryName || st}` : d.principalSubdivision || "").slice(0, 50);
}
/** Miles between two spots (as the crow flies). */
function miles(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
const milesText = (m) => (m == null ? "" : m < 4 ? "nearby" : `${Math.round(m)} mi`);
const priceText = (p) => (p ? "$" + p.toLocaleString("en-US") : "Free");

// ---------------------------------------------------------------------------------------------------- reading
export async function loadMarket(maxAge = 0) {
  if (M.loading) return M.loading;
  if (M.at && Date.now() - M.at < maxAge) return M.items;
  M.loading = (async () => {
    try { const d = await store.read(); M.items = d.items; M.at = Date.now(); try { localStorage.setItem("fifteam-market", JSON.stringify({ items: M.items })); } catch {} return M.items; }
    finally { M.loading = null; }
  })();
  return M.loading;
}
export const marketItem = (id) => M.items.find((x) => x.id === id) || null;
export const marketIds = () => M.items.map((x) => x.id);
const visible = (x) => !api.hidden({ by: x.by }) && !api.state.gone.has(x.id);

/** What the grid shows: search, category, price, distance, and the order. */
function shown() {
  const q = M.q.trim().toLowerCase();
  let list = M.items.filter((x) => visible(x) && (!M.mine || x.by === api.state.me) && (M.mine || !x.sold));
  if (q) list = list.filter((x) => `${x.title} ${x.desc} ${x.cat} ${x.place}`.toLowerCase().includes(q));
  if (M.cat) list = list.filter((x) => x.cat === M.cat);
  if (M.min != null) list = list.filter((x) => x.price >= M.min);
  if (M.max != null) list = list.filter((x) => x.price <= M.max);
  for (const x of list) x._mi = miles(here, x);
  if (M.dist && here) list = list.filter((x) => x._mi != null && x._mi <= M.dist);
  if (M.sort === "near" && here) list.sort((a, b) => (a._mi ?? 1e9) - (b._mi ?? 1e9));
  else if (M.sort === "low") list.sort((a, b) => a.price - b.price);
  else if (M.sort === "high") list.sort((a, b) => b.price - a.price);
  else list.sort((a, b) => b.at - a.at);
  return list;
}

// ---------------------------------------------------------------------------------------------------- the market screen
export function renderMarket() {
  const box = $("mk-body");
  if (!box) return;
  box.replaceChildren();
  // search and Sell
  const top = h("div", "mk-top");
  const sw = h("div", "search mk-search"); sw.append(api.icon("i-search"));
  const q = h("input", "input"); q.type = "search"; q.placeholder = "Search Audio Market"; q.value = M.q; q.setAttribute("aria-label", "Search Audio Market");
  q.oninput = () => { M.q = q.value; paintGrid(); };
  sw.append(q);
  const sell = h("button", "btn small primary mk-sell"); sell.append(api.icon("i-plus"), "Sell"); sell.onclick = () => sellSheet();
  top.append(sw, sell);
  box.append(top);
  // the filters, as chips
  const chips = h("div", "mk-chips");
  const chip = (label, on, fn) => { const c = h("button", "chip" + (on ? " on" : ""), label); c.onclick = fn; chips.append(c); };
  chip(here ? (M.dist ? `Within ${M.dist} mi` : "Any distance") + " ▾" : "📍 Set your location", !!M.dist, () => distSheet());
  chip(M.min != null || M.max != null ? `${M.min != null ? priceText(M.min) : "$0"} – ${M.max != null ? priceText(M.max) : "any"}` + " ▾" : "Price ▾", M.min != null || M.max != null, () => priceSheet());
  chip((M.cat || "Category") + " ▾", !!M.cat, () => catSheet());
  chip({ new: "Newest", near: "Closest", low: "Price: low", high: "Price: high" }[M.sort] + " ▾", M.sort !== "new", () => sortSheet());
  chip("Your listings", M.mine, () => { M.mine = !M.mine; renderMarket(); });
  box.append(chips);
  box.append(h("div", "mk-grid"));
  paintGrid();
}
function paintGrid() {
  const grid = document.querySelector("#mk-body .mk-grid");
  if (!grid) return;
  const list = shown();
  grid.replaceChildren();
  if (!list.length) {
    const e = h("div", "mk-empty");
    e.append(h("b", "", M.loading && !M.items.length ? "Loading…" : M.mine ? "You haven't listed anything yet" : "Nothing here yet"),
      h("p", "status", M.mine ? "Tap Sell to list something." : M.items.length ? "Try a wider distance or price, or another category." : "Be the first: tap Sell."));
    grid.append(e);
    return;
  }
  for (const x of list.slice(0, 200)) grid.append(tile(x));
}
function tile(x) {
  const t = h("button", "mk-tile" + (x.sold ? " sold" : "")); t.dataset.id = x.id;
  const ph = h("span", "mk-ph");
  loadPhoto(ph, x, 0);
  if (x.sold) ph.append(h("span", "mk-soldtag", "Sold"));
  const pr = h("b", "mk-price", priceText(x.price));
  const ti = h("span", "mk-title", x.title);
  const wh = h("span", "mk-where", [x.place, milesText(x._mi)].filter(Boolean).join(" · "));
  t.append(ph, pr, ti, wh);
  t.onclick = () => openListing(x.id);
  return t;
}
function loadPhoto(el, x, i) {
  api.message(x.id).then((m) => { const f = api.fileOf(m, `photo${i}.jpg`); if (f) el.style.backgroundImage = `url("${f.url}")`; }).catch((e) => { if (e && e.status === 404) { api.state.gone.add(x.id); el.closest(".mk-tile")?.remove(); } });
}

// the filter sheets
function pickSheet(title, opts, cur, done, extra) {
  openSheet((p) => {
    p.append(h("h3", "", title));
    if (extra) p.append(extra);
    for (const [v, label] of opts) {
      const b = h("button", "menu-item mk-opt" + (String(v) === String(cur) ? " on" : "")); b.append(h("span", "", label), h("span", "mk-tick", String(v) === String(cur) ? "✓" : ""));
      b.onclick = () => { closeSheet(); done(v); saveFilters(); renderMarket(); };
      p.append(b);
    }
  });
}
function distSheet() {
  const where = h("div", "mk-where-box");
  const loc = h("button", "btn small"); loc.append(here ? "📍 Update my location" : "📍 Use my location");
  loc.onclick = async () => { loc.disabled = true; try { await locate(); toast("Location set"); closeSheet(); renderMarket(); } catch (e) { toast(e.message, 3500); loc.disabled = false; } };
  where.append(h("p", "status", here ? "Distances are measured from your rough location." : "Set your location to see how far away things are."), loc);
  pickSheet("Distance", [[5, "Within 5 miles"], [10, "Within 10 miles"], [25, "Within 25 miles"], [50, "Within 50 miles"], [100, "Within 100 miles"], [250, "Within 250 miles"], [0, "Any distance"]], M.dist, (v) => { if (v && !here) { toast("Set your location first"); return; } M.dist = +v; }, where);
}
function catSheet() { pickSheet("Category", [["", "All categories"], ...CATS.map((c) => [c, c])], M.cat, (v) => { M.cat = v; }); }
function sortSheet() { pickSheet("Sort by", [["new", "Newest first"], ["near", "Closest first"], ["low", "Price: low to high"], ["high", "Price: high to low"]], M.sort, (v) => { if (v === "near" && !here) toast("Set your location to sort by distance"); M.sort = v; }); }
function priceSheet() {
  openSheet((p) => {
    p.append(h("h3", "", "Price"));
    const row = h("div", "mk-prices");
    const mk = (ph, v) => { const i = h("input", "input"); i.type = "number"; i.inputMode = "numeric"; i.min = "0"; i.placeholder = ph; i.value = v == null ? "" : String(v); i.setAttribute("aria-label", ph); return i; };
    const lo = mk("Min", M.min), hi = mk("Max", M.max);
    row.append(lo, h("span", "status", "to"), hi);
    const presets = h("div", "chips");
    for (const [a, b] of [[null, 50], [50, 150], [150, 300], [300, 600], [600, null]]) { const c = h("button", "chip", a == null ? `Under $${b}` : b == null ? `$${a}+` : `$${a}–${b}`); c.onclick = () => { lo.value = a ?? ""; hi.value = b ?? ""; }; presets.append(c); }
    const go = h("button", "btn primary block", "Show results");
    go.onclick = () => { M.min = lo.value === "" ? null : Math.max(0, +lo.value); M.max = hi.value === "" ? null : Math.max(0, +hi.value); if (M.min != null && M.max != null && M.min > M.max) [M.min, M.max] = [M.max, M.min]; saveFilters(); closeSheet(); renderMarket(); };
    const clear = h("button", "btn small", "Any price"); clear.onclick = () => { M.min = M.max = null; saveFilters(); closeSheet(); renderMarket(); };
    p.append(row, presets, go, clear);
  });
}

// ---------------------------------------------------------------------------------------------------- a listing
export function openListing(id) {
  const x = marketItem(id);
  if (!x) { toast("That listing is gone."); return; }
  const S = api.state, mine = x.by === S.me;
  openSheet((p) => {
    p.classList.add("pf-panel", "mk-panel");
    // the photos, side by side (swipe)
    const gal = h("div", "mk-gal");
    for (let i = 0; i < x.n; i++) { const ph = h("button", "mk-gph"); loadPhoto(ph, x, i); ph.onclick = () => { const u = (ph.style.backgroundImage.match(/url\("(.+)"\)/) || [])[1]; if (u) api.openViewer({ src: u }); }; gal.append(ph); }
    p.append(gal);
    if (x.n > 1) p.append(h("p", "status mk-swipe", `${x.n} photos · swipe`));
    const info = h("div", "mk-info");
    info.append(h("h3", "mk-dtitle", x.title), h("b", "mk-dprice", priceText(x.price) + (x.sold ? " · Sold" : "")));
    const mi = miles(here, x);
    info.append(h("p", "status", [`Listed ${api.ago(x.at)} ago`.replace(" now ago", " just now"), x.place ? `in ${x.place}` : "", mi != null ? `about ${milesText(mi)} from you` : ""].filter(Boolean).join(" · ")));
    const facts = h("div", "mk-facts"); facts.append(h("span", "chip", x.cat)); if (x.cond) facts.append(h("span", "chip", x.cond)); info.append(facts);
    if (x.desc) info.append(h("p", "mk-desc", x.desc));
    p.append(info);
    // the seller
    const seller = h("button", "dm-row mk-seller");
    const name = api.nameOf({ by: x.by, user: x.user });
    const av = api.avatarEl(44, "", name); api.showPicture(av, { by: x.by, user: name, id: "" });
    const mid = h("span", "dm-mid"); mid.append(api.nameLine(name, x.by), h("small", "", "Seller · tap to see their page"));
    seller.append(av, mid); seller.onclick = () => openProfile({ by: x.by, user: x.user });
    p.append(seller);
    // what you can do
    const acts = h("div", "mk-acts");
    if (mine) {
      const sold = h("button", "btn", x.sold ? "Mark as available" : "Mark as sold");
      sold.onclick = async () => { sold.disabled = true; if (!(await setSold(x.id, !x.sold))) toast("Couldn't save that. Try again."); else { toast(x.sold ? "Marked as sold" : "Available again"); openListing(x.id); } renderMarket(); };
      const del = h("button", "btn danger", "Delete listing");
      del.onclick = async () => { if (!confirm("Delete this listing?")) return; del.disabled = true; if (await removeListing(x.id)) { closeSheet(); toast("Listing deleted"); renderMarket(); } else { toast("Couldn't delete it. Try again."); del.disabled = false; } };
      acts.append(sold, del);
    } else {
      const msg = h("button", "btn primary block"); msg.append(api.icon("i-chat"), "Message seller");
      msg.onclick = () => { if (!S.name) { toast("Pick a username in Social first"); return; } openChat(x.by, x.id); };
      acts.append(msg);
    }
    p.append(acts);
  });
}
async function setSold(id, on) {
  try { await store.change((d) => { const it = d.items.find((y) => y.id === id); if (it) it.sold = on ? 1 : 0; }, (d) => { const it = d.items.find((y) => y.id === id); return !it || !!it.sold === on; }); }
  catch { return false; }
  const it = marketItem(id); if (it) it.sold = on ? 1 : 0;
  return true;
}
async function removeListing(id) {
  try {
    await api.dc(`/messages/${id}`, { method: "DELETE" }).catch((e) => { if (e.status !== 404) throw e; });
    await store.change((d) => { d.items = d.items.filter((y) => y.id !== id); }, (d) => !d.items.some((y) => y.id === id));
  } catch { return false; }
  M.items = M.items.filter((y) => y.id !== id);
  return true;
}

// ---------------------------------------------------------------------------------------------------- selling
function sellSheet() {
  const S = api.state;
  if (!S.name) { toast("Pick a username first"); return; }
  const photos = [];
  let cat = "", cond = "";
  openSheet((p) => {
    p.classList.add("mk-sellp");
    p.append(h("h3", "", "Sell an item"));
    const strip = h("div", "mk-photos");
    const paintPhotos = () => {
      strip.replaceChildren();
      photos.forEach((b, i) => { const t = h("span", "mk-pthumb"); t.style.backgroundImage = `url("${URL.createObjectURL(b)}")`; const x = h("button", "mk-px", "×"); x.setAttribute("aria-label", "Remove photo"); x.onclick = () => { photos.splice(i, 1); paintPhotos(); }; t.append(x); strip.append(t); });
      if (photos.length < 4) {
        const add = h("button", "mk-padd"); add.append(h("b", "", "+"), h("small", "", photos.length ? "Add photo" : "Add photos"));
        add.onclick = () => {
          const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.multiple = true;
          i.onchange = async () => { for (const f of [...(i.files || [])].slice(0, 4 - photos.length)) { try { photos.push(await fitJpeg(f, 1400)); } catch { toast("Couldn't read that picture"); } } paintPhotos(); };
          i.click();
        };
        strip.append(add);
      }
    };
    paintPhotos();
    const title = h("input", "input"); title.maxLength = 70; title.placeholder = "Title (e.g. Sundown SA-12 D2)"; title.setAttribute("aria-label", "Title");
    const price = h("input", "input"); price.type = "number"; price.inputMode = "numeric"; price.min = "0"; price.placeholder = "Price ($)"; price.setAttribute("aria-label", "Price in dollars");
    const catRow = h("div", "chips mk-catpick");
    for (const c of CATS) { const b = h("button", "chip", c); b.onclick = () => { cat = c; catRow.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b)); }; catRow.append(b); }
    const condRow = h("div", "chips mk-condpick");
    for (const c of CONDS) { const b = h("button", "chip", c); b.onclick = () => { cond = c; condRow.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b)); }; condRow.append(b); }
    const desc = h("textarea", "input so-compose"); desc.rows = 4; desc.maxLength = 1500; desc.placeholder = "Describe it: what it is, how it's been used, what's included, pick-up or shipping"; desc.setAttribute("aria-label", "Description");
    // where: from the phone's location (it asks), never typed; only the town and a rough spot are shared
    const where = h("div", "mk-loc");
    const paintLoc = (msg) => {
      where.replaceChildren();
      if (here) where.append(h("span", "mk-locname", `📍 ${here.place || "Your location"}`), h("span", "status mk-privacy", "Only your town and a spot rounded to about 3 miles are shared."));
      else { const again = h("button", "btn small", "📍 Allow location"); again.onclick = ask; where.append(again, h("span", "status mk-privacy", msg || "Buyers see how far away it is, so selling needs your location.")); }
    };
    const ask = async () => { where.replaceChildren(h("span", "status", "📍 Finding your location…")); try { await locate(); paintLoc(); } catch (e) { paintLoc(e.message); } };
    paintLoc();
    ask();
    const err = h("p", "set-err"), go = h("button", "btn primary block", "List it");
    go.onclick = async () => {
      const pr = price.value.trim();
      const miss = !photos.length ? "Add at least one photo." : !title.value.trim() ? "Give it a title." : pr === "" || !(+pr >= 0) ? "Set a price (0 for free)." : !cat ? "Pick a category." : !here ? "Allow your location, so buyers see how far it is." : "";
      if (miss) { err.textContent = miss; return; }
      if (offensive(title.value, desc.value)) { err.textContent = OFFENSIVE; return; }
      err.textContent = ""; go.disabled = true;
      try {
        await list({ title: title.value.trim(), price: Math.round(+pr), cat, cond, desc: desc.value.trim(), place: here.place || "", photos }, (m) => { go.textContent = m; });
        closeSheet(); toast("Listed on Audio Market"); M.mine = false; renderMarket();
      } catch (e) { err.textContent = e.message || "Couldn't list it. Try again."; go.disabled = false; go.textContent = "List it"; }
    };
    const lab = (t) => h("span", "label", t);
    p.append(strip, title, price, lab("Category"), catRow, lab("Condition"), condRow, desc, lab("Where"), where, err, go);
  });
}
async function list(it, say) {
  const S = api.state;
  say("Uploading the photos…");
  const f = new FormData();
  const lines = [`**${S.name}** is selling on Audio Market`, `${it.title} · ${priceText(it.price)}`, it.place].filter(Boolean);
  f.append("payload_json", JSON.stringify({ content: lines.join("\n").slice(0, 1900), username: `${S.name} · FifTeam`.replace(/discord|clyde/gi, "").slice(0, 80), allowed_mentions: { parse: [] }, attachments: it.photos.map((_, i) => ({ id: i, filename: `photo${i}.jpg` })) }));
  it.photos.forEach((b, i) => f.append(`files[${i}]`, b, `photo${i}.jpg`));
  const m = await api.dc("?wait=true", { method: "POST", form: f });
  say("Listing it…");
  const entry = { id: m.id, by: S.me, user: S.name, title: it.title, price: it.price, cat: it.cat, cond: it.cond, desc: it.desc, place: it.place, lat: here.lat, lon: here.lon, at: Date.now(), n: it.photos.length, sold: 0 };
  try { await store.change((d) => { if (!d.items.some((y) => y.id === m.id)) d.items.unshift(entry); d.items = d.items.slice(0, 500); }, (d) => d.items.some((y) => y.id === m.id)); }
  catch { api.dc(`/messages/${m.id}`, { method: "DELETE" }).catch(() => {}); throw new Error("Couldn't list it. Try again."); }
  M.items = [cleanMarket({ items: [entry] }).items[0], ...M.items.filter((y) => y.id !== m.id)];
}

/** Feed or Audio Market, at the top of Social. */
export function showMarket(on) {
  const f = $("so-body"), m = $("mk-body");
  if (!f || !m) return;
  f.hidden = on; m.hidden = !on;
  document.querySelectorAll("#so-tabs button").forEach((b) => b.classList.toggle("on", (b.dataset.k === "market") === on));
  try { localStorage.setItem("fifteam-social-tab", on ? "market" : "feed"); } catch {}
  if (on) {
    renderMarket(); loadMarket(20000).then(() => renderMarket(), () => renderMarket());
    if (!here || !here.place || Date.now() - (here.at || 0) > 86400e3) locate().then(() => renderMarket(), () => {});
  }
}
export const marketOpen = () => { const m = $("mk-body"); return !!m && !m.hidden; };
export const market = { state: M, locate, miles };
