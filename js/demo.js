// Demo mode: a lava lamp across the whole player screen, behind everything. Slow wax blobs rise, fall and melt into each
// other in the app's colours and the cover's; the bass drives them: they swell and glow with the low end, and every bass
// hit sends a pulse through them and speeds them up for a moment. The hits and the bass level are read ahead of time
// from the song file itself (its low end, below 150 Hz), so the sound is never touched and it all lands on the beat.
import * as store from "./store.js";
import { $, bus } from "./ui.js";
import { butter4 } from "./dsp.js";
import { player } from "./player.js";

const KEY = "fifteam-demo";
const D = { on: false, view: "", res: null, resId: null, want: null, idx: 0, last: -1, cache: new Map(), fired: 0 };
try { D.on = localStorage.getItem(KEY) === "1"; } catch {}

/** The song's low end: { hits: [time, strength, ...], env: its loudness every 10 ms, 0..255 }. */
export async function findHits(blob) {
  const bytes = await blob.arrayBuffer();
  let ab = null;
  for (const rate of [3000, 8000, 22050, 44100]) {
    let oc;
    try { oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, rate); } catch { continue; }
    ab = await oc.decodeAudioData(bytes.slice(0));
    break;
  }
  if (!ab) return { hits: new Float32Array(0), env: new Uint8Array(0) };
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
  const L = new Float32Array(F), env = new Uint8Array(F);
  for (let f = 0; f < F; f++) { L[f] = 20 * Math.log10(e[f] / ref + 1e-5); env[f] = Math.round(255 * Math.min(1, Math.max(0, (L[f] + 24) / 26))); }
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
  for (const th of [8, 10, 13]) { if (hits.length / 2 / dur <= 4.5) break; hits = detect(th); }
  if (hits.length / 2 / dur < 0.3) { const soft = detect(4); if (soft.length > hits.length) hits = soft; }
  return { hits: Float32Array.from(hits), env };
}

// ---------------------------------------------------------------------------------------------------- the lava lamp
// blobs: [x (0..1 across), size (of the screen height), seconds per rise and fall, phase, seconds per sway, colour]
const BLOBS = [
  [0.22, 0.13, 34, 0.0, 23, 0], [0.76, 0.16, 41, 1.7, 29, 1], [0.46, 0.1, 27, 3.1, 19, 2], [0.86, 0.09, 31, 4.4, 17, 3],
  [0.12, 0.085, 25, 2.2, 21, 4], [0.56, 0.14, 47, 5.3, 31, 5], [0.32, 0.07, 22, 0.9, 15, 6], [0.66, 0.08, 29, 3.8, 27, 7],
];
const N = BLOBS.length + 2;                      // + the pools of wax at the bottom and the top
const VS = "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }";
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 res; uniform float pulse; uniform float energy;
uniform vec3 balls[${N}]; uniform vec3 cols[${N}];
void main() {
  vec2 p = gl_FragCoord.xy / res.y;
  float f = 0.0; vec3 c = vec3(0.0);
  for (int i = 0; i < ${N}; i++) {
    vec2 d = p - balls[i].xy;
    float q = balls[i].z * balls[i].z / (dot(d, d) + 0.0002);
    float v = q * q;                                     // a short reach: separate blobs, dark between them
    f += v; c += cols[i] * v;
  }
  c /= f;
  float wax = smoothstep(0.85, 1.25, f);                 // the blob itself, a soft clean edge
  float halo = smoothstep(0.12, 0.85, f) * 0.16;         // a faint glow round it
  float core = smoothstep(1.6, 6.0, f);                  // brighter, glossier inside
  vec3 col = c * (0.7 + 0.28 * core + 0.32 * pulse + 0.1 * energy);
  col += vec3(0.08, 0.04, 0.12) * core * (0.4 + pulse);  // a warm sheen in the thick of it
  float a = max(wax * (0.58 + 0.14 * energy + 0.2 * pulse), halo * (1.0 + 0.8 * pulse));
  gl_FragColor = vec4(col * a, a);
}`;
const PALETTE = ["#2f78ff", "#bb4dff", "#7a4bff", "#ff4fc8", "#3fc8ff", "#9b5bff", "#ff6a9a", "#4f6bff"];
const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const LV = { canvas: null, gl: null, u: null, raf: 0, t: 0, last: 0, pulse: 0, energy: 0, cols: new Float32Array(N * 3), balls: new Float32Array(N * 3), ctx2d: null };

function setColours(extra = []) {
  const list = PALETTE.map(hex);
  // the cover's own colours take two of the blobs and one pool
  if (extra[0]) { list[0] = extra[0]; list[5] = extra[0]; }
  if (extra[1]) list[3] = extra[1];
  for (let i = 0; i < BLOBS.length; i++) LV.cols.set(list[BLOBS[i][5] % list.length], i * 3);
  LV.cols.set(extra[0] || hex("#7a4bff"), BLOBS.length * 3);          // bottom pool
  LV.cols.set(hex("#2f78ff"), (BLOBS.length + 1) * 3);                // top pool
}
setColours();

// the cover's two strongest colours, made vivid
function coverColours() {
  try {
    const img = $("art-img");
    if (!img.complete || !img.naturalWidth) return [];
    const c = document.createElement("canvas"); c.width = c.height = 12;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, 12, 12);
    const px = g.getImageData(0, 0, 12, 12).data, cand = [];
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      cand.push({ c: [r, gg, b], score: sat * (0.3 + mx) });
    }
    cand.sort((a, b) => b.score - a.score);
    const vivid = ({ c: [r, g2, b] }) => {
      // push towards full saturation and a lively brightness
      const mx = Math.max(r, g2, b, 1e-3), mn = Math.min(r, g2, b), k = 0.95 / mx;
      const s = (v) => Math.min(1, ((v - mn) / Math.max(mx - mn, 1e-3)) * 0.85 + 0.15) * mx * k;
      return [s(r), s(g2), s(b)];
    };
    const out = [];
    for (const k of cand) {
      if (k.score < 0.12) break;
      if (!out.length || Math.hypot(k.c[0] - out[0][0], k.c[1] - out[0][1], k.c[2] - out[0][2]) > 0.25) out.push(vivid(k));
      if (out.length === 2) break;
    }
    return out;
  } catch { return []; }
}

function makeCanvas() {
  if (LV.canvas) return;
  const cv = document.createElement("canvas");
  cv.className = "lava"; cv.id = "lava"; cv.setAttribute("aria-hidden", "true");
  $("ambient").after(cv);
  LV.canvas = cv;
  const gl = cv.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: "low-power" });
  if (gl) {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (vs && fs) {
      const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
      if (gl.getProgramParameter(pr, gl.LINK_STATUS)) {
        gl.useProgram(pr);
        const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(pr, "a"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        LV.gl = gl;
        LV.u = { res: gl.getUniformLocation(pr, "res"), pulse: gl.getUniformLocation(pr, "pulse"), energy: gl.getUniformLocation(pr, "energy"), balls: gl.getUniformLocation(pr, "balls"), cols: gl.getUniformLocation(pr, "cols") };
      }
    }
  }
  if (!LV.gl) { cv.classList.add("soft"); LV.ctx2d = cv.getContext("2d"); }
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function place(w, h) {
  const asp = w / h, t = LV.t, grow = 1 + (reduced() ? 0 : 0.16 * LV.energy + 0.22 * LV.pulse);
  BLOBS.forEach(([x, size, per, ph, sway], i) => {
    const y = 0.5 + 0.62 * Math.sin((2 * Math.PI * t) / per + ph);
    const xx = (x + 0.09 * Math.sin((2 * Math.PI * t) / sway + ph * 1.3)) * asp;
    const wob = 1 + 0.1 * Math.sin(t * 0.9 + i * 1.7);
    LV.balls.set([xx, y, size * wob * grow], i * 3);
  });
  LV.balls.set([0.5 * asp, -0.2, 0.3 * (1 + 0.1 * LV.energy)], BLOBS.length * 3);
  LV.balls.set([0.5 * asp, 1.17, 0.2], (BLOBS.length + 1) * 3);
}
function draw() {
  const cv = LV.canvas, k = 0.5;
  const w = Math.max(16, Math.round(cv.clientWidth * k)), h = Math.max(16, Math.round(cv.clientHeight * k));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  place(w, h);
  if (LV.gl) {
    const gl = LV.gl, u = LV.u;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(u.res, w, h); gl.uniform1f(u.pulse, LV.pulse); gl.uniform1f(u.energy, LV.energy);
    gl.uniform3fv(u.balls, LV.balls); gl.uniform3fv(u.cols, LV.cols);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } else {
    const g = LV.ctx2d; g.clearRect(0, 0, w, h);
    for (let i = 0; i < N; i++) {
      const x = LV.balls[i * 3] * h, y = h - LV.balls[i * 3 + 1] * h, r = LV.balls[i * 3 + 2] * h * 1.9;
      const [cr, cg, cb] = [LV.cols[i * 3], LV.cols[i * 3 + 1], LV.cols[i * 3 + 2]].map((v) => Math.round(v * 255));
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${cr},${cg},${cb},${0.75 + 0.2 * LV.pulse})`); gr.addColorStop(0.55, `rgba(${cr},${cg},${cb},0.35)`); gr.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  }
}

// ---------------------------------------------------------------------------------------------------- following the song
const audio = () => player.audio;
const shown = () => D.on && D.view === "player" && document.visibilityState === "visible";
const ready = () => D.res && player.current && D.resId === player.current.id;
function lowerBound(h, t) { let a = 0, b = h.length / 2; while (a < b) { const m = (a + b) >> 1; if (h[2 * m] < t) a = m + 1; else b = m; } return a; }

function frame(now) {
  LV.raf = 0;
  if (!shown()) { lampOff(); return; }
  const dt = LV.last ? Math.min(0.05, (now - LV.last) / 1000) : 0.016; LV.last = now;
  let target = 0;
  const a = audio();
  if (ready() && !a.paused) {
    const h = D.res.hits, env = D.res.env, ct = a.currentTime;
    if (D.last < 0 || ct < D.last - 0.05 || ct > D.last + 0.5) D.idx = lowerBound(h, ct);
    let best = 0;
    while (D.idx < h.length / 2 && h[2 * D.idx] <= ct) { if (ct - h[2 * D.idx] < 0.12) best = Math.max(best, h[2 * D.idx + 1]); D.idx++; }
    if (best > 0) { LV.pulse = Math.max(LV.pulse, best); D.fired++; }
    D.last = ct;
    const fi = Math.min(env.length - 1, Math.max(0, Math.floor(ct * 100)));
    target = env.length ? env[fi] / 255 : 0;
  } else D.last = -1;
  LV.energy += (target - LV.energy) * (1 - Math.exp(-dt / 0.09));
  LV.pulse *= Math.exp(-dt / 0.3);
  LV.t += dt * (reduced() ? 0.3 : 1 + 1.3 * LV.energy + 3 * LV.pulse);
  draw();
  LV.raf = requestAnimationFrame(frame);
}
function lampOff() { if (LV.canvas) LV.canvas.classList.remove("on"); $("app").classList.remove("lava-on"); }
function kick() {
  if (!shown()) { lampOff(); return; }
  makeCanvas();
  LV.canvas.classList.add("on"); $("app").classList.add("lava-on");
  if (!LV.raf) { LV.last = 0; D.last = -1; LV.raf = requestAnimationFrame(frame); }
}

async function prepare() {
  const t = player.current;
  if (!D.on || !t) return;
  if (D.resId === t.id && D.res) { kick(); return; }
  if (D.want === t.id) return;
  D.want = t.id; D.res = null; D.resId = null;
  try {
    let res = D.cache.get(t.id);
    if (!res) {
      const blob = await store.getBlob(t.id);
      if (!blob) return;
      res = await findHits(blob);
      D.cache.set(t.id, res);
      if (D.cache.size > 12) D.cache.delete(D.cache.keys().next().value);
    }
    if (D.want !== t.id) return;
    D.res = res; D.resId = t.id;
    kick();
  } catch { /* a file the phone can't read again here: the lamp just drifts */ }
  finally { if (D.want === t.id) D.want = null; }
}

export const demo = {
  get on() { return D.on; },
  set(on) {
    D.on = !!on;
    try { on ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch {}
    if (D.on) { prepare(); kick(); }
    else { cancelAnimationFrame(LV.raf); LV.raf = 0; lampOff(); }
  },
  /** For the tests. */
  get hits() { return D.res && D.res.hits; },
  get state() { return { running: !!LV.raf, webgl: !!LV.gl, fired: D.fired, energy: +LV.energy.toFixed(3), pulse: +LV.pulse.toFixed(3) }; },
};

export function initDemo() {
  bus.on("view", (v) => { D.view = v; kick(); });
  bus.on("now", () => { D.last = -1; prepare(); });
  const a = audio();
  a.addEventListener("play", () => { prepare(); kick(); });
  a.addEventListener("seeked", () => { D.last = -1; });
  $("art-img").addEventListener("load", () => setColours(coverColours()));
  document.addEventListener("visibilitychange", kick);
  if (D.on) prepare();
}
