// Small things every screen uses: finding elements, a message at the bottom, a sheet sliding up, times, the shared
// audio engine, cover art, and a little event bus between the screens.
export const $ = (id) => document.getElementById(id);
export const dbToLinSafe = (db) => Math.pow(10, db / 20);

let toastT = 0;
export function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms);
}

export function openSheet(build) {
  const s = $("sheet"), p = $("sheet-panel");
  p.innerHTML = '<div class="grabber"></div>';
  build(p);
  s.classList.add("open");
  const close = () => s.classList.remove("open");
  s.onclick = (e) => { if (e.target === s) close(); };
  return close;
}
export const closeSheet = () => $("sheet").classList.remove("open");

/** Puts `text` in `el`. If it doesn't fit, it glides slowly to the left, round and round, so all of it can be read. */
export function marquee(el, text) {
  if (el._mq === text && el.firstElementChild) { fitMarquee(el); return; }
  el._mq = text;
  el.classList.add("mq-host");
  el.title = text;
  const track = document.createElement("span"), a = document.createElement("span");
  track.className = "mq"; a.textContent = text;
  track.append(a); el.replaceChildren(track);
  fitMarquee(el);
  if (!el._mqRO && "ResizeObserver" in window) { el._mqRO = new ResizeObserver(() => fitMarquee(el)); el._mqRO.observe(el); }
}
function fitMarquee(el) {
  const track = el.firstElementChild;
  if (!track || !el.clientWidth) return;               // not on screen yet: measured when it shows
  el.classList.remove("mq-on");
  while (track.children.length > 1) track.lastElementChild.remove();
  const first = track.firstElementChild;
  if (first.getBoundingClientRect().width <= el.clientWidth + 1) return;
  const copy = first.cloneNode(true); copy.setAttribute("aria-hidden", "true"); track.append(copy);
  el.classList.add("mq-on");
  // one lap: the title and the gap after it, at about 38 px a second, after a short rest at the start
  const dist = first.getBoundingClientRect().width;
  el.style.setProperty("--mq-dist", `${-dist}px`);
  el.style.setProperty("--mq-dur", `${(dist / 38 / 0.84).toFixed(2)}s`);
}

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

export function fill(range) {
  const min = +range.min, max = +range.max, v = +range.value;
  range.style.setProperty("--p", `${((v - min) / (max - min)) * 100}%`);
}

let ctx = null;
/** One audio engine for the app, made on the first tap (phones only allow sound after one). */
export function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

const artUrls = new Map();
export function artUrl(id, blob) {
  if (artUrls.has(id)) return artUrls.get(id);
  const u = blob ? URL.createObjectURL(blob) : null;
  artUrls.set(id, u);
  return u;
}
export function forgetArt(id) { const u = artUrls.get(id); if (u) URL.revokeObjectURL(u); artUrls.delete(id); }

/** Cover for songs without one: the brand gradient with the first letter of the title. */
const placeholders = new Map();
export function placeholderArt(title = "", kind = "song") {
  const key = (title[0] || "#").toUpperCase() + kind;
  if (placeholders.has(key)) return placeholders.get(key);
  const c = document.createElement("canvas"); c.width = c.height = 512;
  const g = c.getContext("2d");
  const h = [...title].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 60;
  const gr = g.createLinearGradient(0, 0, 512, 512);
  gr.addColorStop(0, `hsl(${222 + h * 0.3}, 92%, 58%)`); gr.addColorStop(0.55, `hsl(${255 + h * 0.4}, 88%, 63%)`); gr.addColorStop(1, `hsl(${280 + h * 0.3}, 90%, 62%)`);
  g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
  g.globalAlpha = 0.16; g.strokeStyle = "#fff"; g.lineWidth = 3;
  for (let r = 60; r < 760; r += 44) { g.beginPath(); g.arc(512, 512, r, 0, Math.PI * 2); g.stroke(); }
  g.globalAlpha = 0.95; g.fillStyle = "#fff";
  if (kind === "song") { g.font = "700 220px Sora, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(key[0], 256, 270); }
  else {
    g.lineWidth = 16; g.lineCap = "round"; g.beginPath();
    for (let x = 96; x <= 416; x += 4) { const y = 256 + Math.sin((x - 96) / 320 * Math.PI * (kind === "tone" ? 4 : 2)) * (kind === "tone" ? 70 : 110) * (kind === "tone" ? 1 : Math.exp(-((x - 256) ** 2) / 26000)); x === 96 ? g.moveTo(x, y) : g.lineTo(x, y); }
    g.strokeStyle = "#fff"; g.stroke();
  }
  const u = c.toDataURL("image/png");
  placeholders.set(key, u);
  return u;
}

const subs = {};
export const bus = {
  on(ev, fn) { (subs[ev] = subs[ev] || []).push(fn); },
  emit(ev, data) { (subs[ev] || []).forEach((f) => f(data)); },
};

export function segValue(seg) { const b = seg.querySelector("button.on"); return b ? b.dataset.k : null; }
export function onSeg(seg, fn) {
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !seg.contains(b)) return;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    fn(b.dataset.k, b);
  });
}
export function setSeg(seg, k) { seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.k === k)); }
