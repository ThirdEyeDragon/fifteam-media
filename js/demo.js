// Demo mode: the player looks exactly as usual, except that on every bass hit the cover kicks, the glow behind it
// flares, and a ring of light rolls out from behind it. The hits are found ahead of time from the song file itself (its
// low end, below 150 Hz, read at a few thousand samples a second), so the sound is never touched or rerouted, it
// works the same with the tone knobs anywhere, and each effect lands right on its beat.
import * as store from "./store.js";
import { $, bus } from "./ui.js";
import { butter4 } from "./dsp.js";
import { player } from "./player.js";

const KEY = "fifteam-demo";
const D = { on: false, view: "", hits: null, hitsId: null, want: null, idx: 0, last: -1, raf: 0, cache: new Map() };
try { D.on = localStorage.getItem(KEY) === "1"; } catch {}

/** Bass hits in a song file: [time (s), strength (0..1), time, strength, ...]. */
export async function findHits(blob) {
  const bytes = await blob.arrayBuffer();
  let ab = null;
  for (const rate of [3000, 8000, 22050, 44100]) {
    let oc;
    try { oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, rate); } catch { continue; }
    ab = await oc.decodeAudioData(bytes.slice(0));
    break;
  }
  if (!ab) return new Float32Array(0);
  const sr = ab.sampleRate, n = ab.length, nc = ab.numberOfChannels;
  const x = new Float32Array(n);
  for (let c = 0; c < nc; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) x[i] += d[i] / nc; }
  butter4(x, "lp", 150, sr);
  // the low end's loudness every 10 ms (20 ms windows), in dB against how loud the song's bass usually gets
  const hop = Math.max(1, Math.round(sr * 0.01)), F = Math.max(0, Math.floor(n / hop) - 1);
  const e = new Float32Array(F);
  for (let f = 0; f < F; f++) { let s = 0; const a = f * hop, b = Math.min(n, a + 2 * hop); for (let i = a; i < b; i++) s += x[i] * x[i]; e[f] = Math.sqrt(s / Math.max(1, b - a)); }
  const sorted = Float32Array.from(e).sort();
  const ref = sorted[Math.floor(F * 0.95)] || 1e-6;
  const L = new Float32Array(F);
  for (let f = 0; f < F; f++) L[f] = 20 * Math.log10(e[f] / ref + 1e-5);
  // a hit: the low end jumps by `th` dB or more within 50 ms, gets loud enough, and comes at least 130 ms after the last
  const detect = (th) => {
    const out = [];
    let armed = true, lastT = -1;
    for (let f = 5; f < F; f++) {
      let mn = Infinity; for (let k = 1; k <= 5; k++) if (L[f - k] < mn) mn = L[f - k];
      const rise = L[f] - mn;
      if (!armed) { if (rise < th * 0.35) armed = true; else continue; }
      if (rise < th) continue;
      let pk = -99; for (let k = 0; k < 8 && f + k < F; k++) if (L[f + k] > pk) pk = L[f + k];
      if (pk < -12) continue;
      const t = (f * hop) / sr;
      if (t - lastT < 0.13) continue;
      const s = Math.min(1, Math.max(0.3, (pk + 12) / 12)) * Math.min(1, Math.max(0.55, rise / (th * 2.2)));
      out.push(t, s); lastT = t; armed = false;
    }
    return out;
  };
  const dur = n / sr;
  let hits = detect(6);
  // busy low ends (a rolling bass line) raise the bar until the hits are the ones you'd nod to; sparse ones lower it
  for (const th of [8, 10, 13]) { if (hits.length / 2 / dur <= 4.5) break; hits = detect(th); }
  if (hits.length / 2 / dur < 0.3) { const soft = detect(4); if (soft.length > hits.length) hits = soft; }
  return Float32Array.from(hits);
}

// ---------------------------------------------------------------------------------------------------- the effects
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function fire(s) {
  const stage = $("art-stage"), glow = $("art-glow"), amb = $("ambient");
  // the glow behind the cover and the room's colour flare, every time
  glow.animate([{ opacity: 1, scale: String(1 + 0.18 * s) }, { opacity: 0.8, scale: "1" }], { duration: 460, easing: "cubic-bezier(.15,.75,.3,1)" });
  amb.animate([{ opacity: Math.min(1, 0.55 + 0.4 * s) }, { opacity: 0.55 }], { duration: 560, easing: "ease-out" });
  if (reduced()) return;
  // the cover kicks
  stage.animate([{ scale: String(1 + 0.055 * s) }, { scale: "1" }], { duration: 320, easing: "cubic-bezier(.2,.85,.3,1)" });
  // a ring of light rolls out (two for the big ones)
  const rings = s > 0.8 ? 2 : 1;
  for (let k = 0; k < rings; k++) {
    const ring = document.createElement("div");
    ring.className = "bass-ring";
    stage.insertBefore(ring, $("art"));
    const a = ring.animate(
      [{ scale: "1", opacity: 0.3 + 0.65 * s }, { scale: String(1.22 + 0.2 * s + k * 0.14), opacity: 0 }],
      { duration: 760 + k * 220, delay: k * 70, easing: "cubic-bezier(.1,.6,.3,1)", fill: "backwards" },
    );
    a.onfinish = a.oncancel = () => ring.remove();
  }
  const all = stage.querySelectorAll(".bass-ring");
  for (let i = 0; i < all.length - 6; i++) all[i].remove();
}

// ---------------------------------------------------------------------------------------------------- following the song
const audio = () => player.audio;
const active = () => D.on && D.view === "player" && document.visibilityState === "visible" && D.hits && player.current &&
  D.hitsId === player.current.id && !audio().paused;
function lowerBound(h, t) { let a = 0, b = h.length / 2; while (a < b) { const m = (a + b) >> 1; if (h[2 * m] < t) a = m + 1; else b = m; } return a; }
function tick() {
  D.raf = 0;
  if (!active()) { D.last = -1; return; }
  const h = D.hits, now = audio().currentTime;
  // a jump (seeking, a new song, coming back to the screen): pick up from here without firing what was skipped
  if (D.last < 0 || now < D.last - 0.05 || now > D.last + 0.5) D.idx = lowerBound(h, now);
  let best = -1;
  while (D.idx < h.length / 2 && h[2 * D.idx] <= now) { if (now - h[2 * D.idx] < 0.12) best = Math.max(best, h[2 * D.idx + 1]); D.idx++; }
  if (best > 0) fire(best);
  D.last = now;
  D.raf = requestAnimationFrame(tick);
}
function kick() { if (!D.raf && active()) { D.last = -1; D.raf = requestAnimationFrame(tick); } }

async function prepare() {
  const t = player.current;
  if (!D.on || !t) return;
  if (D.hitsId === t.id && D.hits) { kick(); return; }
  if (D.want === t.id) return;
  D.want = t.id; D.hits = null; D.hitsId = null;
  try {
    let hits = D.cache.get(t.id);
    if (!hits) {
      const blob = await store.getBlob(t.id);
      if (!blob) return;
      hits = await findHits(blob);
      D.cache.set(t.id, hits);
      if (D.cache.size > 12) D.cache.delete(D.cache.keys().next().value);
    }
    if (D.want !== t.id) return;
    D.hits = hits; D.hitsId = t.id;
    kick();
  } catch { /* a file the phone can't read again here: no effect for this one */ }
  finally { if (D.want === t.id) D.want = null; }
}

export const demo = {
  get on() { return D.on; },
  set(on) {
    D.on = !!on;
    try { on ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch {}
    if (D.on) prepare();
    else { cancelAnimationFrame(D.raf); D.raf = 0; document.querySelectorAll(".bass-ring").forEach((r) => r.remove()); }
  },
  /** For the tests: the hits found in the song that's playing. */
  get hits() { return D.hits; },
};

export function initDemo() {
  bus.on("view", (v) => { D.view = v; kick(); });
  bus.on("now", () => { D.last = -1; prepare(); });
  const a = audio();
  a.addEventListener("play", () => { prepare(); kick(); });
  a.addEventListener("seeked", () => { D.last = -1; });
  document.addEventListener("visibilitychange", kick);
  if (D.on) prepare();
}
