// The tone generator: a test tone at any frequency from 1 Hz to 20 kHz, square/triangle/saw, white and pink noise,
// level in dBFS, left/right/both and a polarity flip, log or linear sweeps, a live scope, and saving the tone as a file.
import { $, toast, fill, getCtx, bus, onSeg, segValue, setSeg } from "./ui.js";
import { noteName, dbToLin, pinkNoise } from "./dsp.js";
import { makeFile, saveFile, isIOS, fitFormat } from "./export.js";
import { openShareSheet } from "./share.js";
import { library } from "./library.js";
import { player } from "./player.js";
import * as store from "./store.js";
import { pickImage } from "./image.js";
import { placeholderArt } from "./ui.js";

const T = { f: 40, wave: "sine", noise: null, db: -12, ch: "both", flip: false, node: null, sweep: null, raf: 0, file: null, fileKey: "", cover: null, coverUrl: null };
function paintCover() {
  $("tg-cover").style.backgroundImage = `url("${T.coverUrl || placeholderArt("Tone", "tone")}")`;
  $("tg-cover-note").textContent = T.cover ? "Cover: your image" : "Cover: FifTeam's tone art";
  $("tg-cover-reset").hidden = !T.cover;
}
const FMIN = 1, FMAX = 20000;
const posToF = (p) => FMIN * Math.pow(FMAX / FMIN, p / 1000);
const fToPos = (f) => Math.round((Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * 1000);
const fmtF = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + "k" : f >= 100 ? f.toFixed(0) : f.toFixed(1));

function paint() {
  $("tg-num").textContent = fmtF(T.f);
  $("tg-note").textContent = T.noise ? (T.noise === "pink" ? "Pink noise" : "White noise") : noteName(T.f);
  const r = $("tg-freq"); r.value = fToPos(T.f); fill(r);
  document.querySelectorAll("#tg-presets .chip").forEach((c) => c.classList.toggle("on", Math.abs(+c.dataset.f - T.f) < 0.05));
  const d = $("tg-db"); fill(d);
  $("tg-db-val").innerHTML = `${T.db === 0 ? "0" : "−" + Math.abs(T.db)}<small>dBFS</small>`;
  $("tg-warn").hidden = T.db < -6;
  if (!$("tg-name").dataset.edited) $("tg-name").value = defaultName();
}
function defaultName() {
  const sec = +document.querySelector("#tg-len .chip.on").dataset.s;
  const what = T.noise ? `${T.noise === "pink" ? "Pink" : "White"} noise` : `${fmtF(T.f)} Hz ${T.wave === "sawtooth" ? "saw" : T.wave}`;
  return `${what} ${T.db === 0 ? "0" : "-" + Math.abs(T.db)}dB ${sec >= 60 ? sec / 60 + "min" : sec + "s"}`;
}

// ---------------------------------------------------------------------------------------------------- the sound
/** The graph: source -> left gain + right gain -> merger -> analyser -> out. Works on a live or an offline context. */
function build(ctx, dest) {
  let src;
  if (T.noise) {
    const n = ctx.sampleRate * 4;
    const b = ctx.createBuffer(1, n, ctx.sampleRate), x = b.getChannelData(0);
    if (T.noise === "pink") x.set(pinkNoise(n, 7));
    else { let s = 99; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; x[i] = (s / 2147483648 - 1) * 0.5; } }
    src = ctx.createBufferSource(); src.buffer = b; src.loop = true;
  } else {
    src = ctx.createOscillator(); src.type = T.wave; src.frequency.value = T.f;
  }
  const lvl = dbToLin(T.db) * (T.wave === "square" && !T.noise ? 0.9 : 1);
  const gl = ctx.createGain(), gr = ctx.createGain(), m = ctx.createChannelMerger(2);
  gl.gain.value = T.ch === "right" ? 0 : lvl;
  gr.gain.value = (T.ch === "left" ? 0 : lvl) * (T.flip ? -1 : 1);
  src.connect(gl).connect(m, 0, 0); src.connect(gr).connect(m, 0, 1);
  m.connect(dest);
  return { src, gl, gr, m };
}

let an = null;
function start(sweep) {
  stop();
  player.pause();
  const ctx = getCtx();
  if (!an || an.context !== ctx) { an = ctx.createAnalyser(); an.fftSize = 2048; an.connect(ctx.destination); }
  const g = build(ctx, an);
  const t = ctx.currentTime + 0.02;
  // fade in over 15 ms so the speaker isn't kicked
  const fadeIn = (p) => { const v = p.value; p.setValueAtTime(0, t); p.linearRampToValueAtTime(v, t + 0.015); };
  fadeIn(g.gl.gain); fadeIn(g.gr.gain);
  if (sweep && !T.noise) scheduleSweep(g.src, t, sweep);
  g.src.start(t);
  T.node = g; T.sweep = sweep || null;
  setIcon(true);
  scope();
}
function stop() {
  if (!T.node) return;
  const ctx = getCtx(), t = ctx.currentTime, g = T.node;
  for (const p of [g.gl.gain, g.gr.gain]) { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(0, t + 0.015); }
  try { g.src.stop(t + 0.03); } catch {}
  T.node = null; T.sweep = null;
  setIcon(false);
}
function scheduleSweep(osc, t, sw) {
  const p = osc.frequency;
  p.setValueAtTime(sw.a, t);
  const reps = sw.loop ? 200 : 1;
  for (let k = 0; k < reps; k++) {
    const t0 = t + k * sw.dur;
    if (k) p.setValueAtTime(sw.a, t0);
    if (sw.kind === "log") p.exponentialRampToValueAtTime(sw.b, t0 + sw.dur); else p.linearRampToValueAtTime(sw.b, t0 + sw.dur);
  }
  if (!sw.loop) setTimeout(() => { if (T.sweep === sw) stop(); }, (sw.dur + 0.1) * 1000);
}
function live() {
  // a change while playing: glide the frequency, rebuild for anything else
  if (!T.node) return;
  if (T.sweep) return;
  if (T.node.src.frequency && !T.noise) T.node.src.frequency.setTargetAtTime(T.f, getCtx().currentTime, 0.012);
}
function relive() { if (T.node && !T.sweep) start(); }
function setIcon(on) {
  const b = $("tg-play"); b.querySelector("use").setAttribute("href", on ? "#i-pause" : "#i-play"); b.setAttribute("aria-label", on ? "Stop tone" : "Play tone");
  $("tg-sweep").innerHTML = T.sweep ? '<svg><use href="#i-pause"/></svg>Stop sweep' : '<svg><use href="#i-tone"/></svg>Play sweep';
}

function scope() {
  cancelAnimationFrame(T.raf);
  const c = $("tg-scope"), data = new Float32Array(2048);
  const tick = () => {
    const dpr = Math.min(3, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    g.strokeStyle = "rgba(190,196,255,0.08)"; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    if (T.node && an) {
      an.getFloatTimeDomainData(data);
      // start at a rising zero crossing so the wave stands still
      let s = 0; for (let i = 1; i < 1024; i++) if (data[i - 1] < 0 && data[i] >= 0) { s = i; break; }
      const grd = g.createLinearGradient(0, 0, w, 0); grd.addColorStop(0, "#2f78ff"); grd.addColorStop(0.55, "#7a4bff"); grd.addColorStop(1, "#bb4dff");
      g.strokeStyle = grd; g.lineWidth = 2; g.beginPath();
      const span = 1024;
      for (let i = 0; i < span; i++) { const x = (i / span) * w, y = h / 2 - data[s + i] * (h / 2 - 6); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
      if (T.sweep) { $("tg-num").textContent = fmtF(T.node.src.frequency.value); }
    }
    if (location.hash === "#tones") T.raf = requestAnimationFrame(tick);
  };
  T.raf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------------------------------- the file
async function render() {
  const sec = +document.querySelector("#tg-len .chip.on").dataset.s;
  const sr = 48000;
  const off = new OfflineAudioContext(2, sr * sec, sr);
  const g = build(off, off.destination);
  // fade both ends over 20 ms
  for (const p of [g.gl.gain, g.gr.gain]) { const v = p.value; p.setValueAtTime(0, 0); p.linearRampToValueAtTime(v, 0.02); p.setValueAtTime(v, sec - 0.02); p.linearRampToValueAtTime(0, sec); }
  g.src.start(0);
  const buf = await off.startRendering();
  return [buf.getChannelData(0), buf.getChannelData(1), sr, sec];
}
async function buildFile({ maxBytes } = {}) {
  const chosen = segValue($("tg-format")), name = $("tg-name").value.trim() || defaultName();
  const fmt = fitFormat(chosen, +document.querySelector("#tg-len .chip.on").dataset.s, 48000, maxBytes);
  const key = JSON.stringify([T.f, T.wave, T.noise, T.db, T.ch, T.flip, fmt, document.querySelector("#tg-len .chip.on").dataset.s, T.cover ? T.cover.size : 0, name]);
  const fresh = !T.file || T.fileKey !== key;
  if (fresh) {
    toast("Making the file…", 60000);
    const [L, R, sr] = await render();
    T.file = (await makeFile([L, R], sr, name, fmt, getCtx(), null, { title: name, artist: "FifTeam Media tones", album: "FifTeam Media", cover: T.cover })).file; T.fileKey = key;
  }
  const want = `${name.replace(/[\\/:*?"<>|]+/g, " ").trim()}.${T.file.name.split(".").pop()}`;
  if (T.file.name !== want) T.file = new File([T.file], want, { type: T.file.type });
  return { file: T.file, fresh, swapped: fmt !== chosen };
}
function readSweep() {
  const a = parseFloat($("tg-sw-a").value), b = parseFloat($("tg-sw-b").value), dur = parseFloat($("tg-sw-t").value);
  if (!(a >= 1 && a <= 20000 && b >= 1 && b <= 20000 && dur >= 0.5 && dur <= 600)) return null;
  return { a, b, dur, kind: segValue($("tg-sw-k")), loop: $("tg-sw-loop").checked };
}

export function initTones() {
  $("tg-freq").addEventListener("input", (e) => { T.f = Math.round(posToF(+e.target.value) * 10) / 10; if (T.f >= 100) T.f = Math.round(T.f); paint(); live(); });
  $("tg-nudge").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    T.f = Math.max(FMIN, Math.min(FMAX, Math.round((T.f + +b.dataset.d) * 10) / 10)); paint(); live();
  });
  $("tg-presets").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; T.f = +c.dataset.f; T.noise = null; setSeg($("tg-noise"), ""); paint(); live(); relive(); });
  onSeg($("tg-wave"), (k) => { T.wave = k; T.noise = null; setSeg($("tg-noise"), ""); paint(); relive(); });
  onSeg($("tg-noise"), (k) => { T.noise = k; setSeg($("tg-wave"), ""); paint(); relive(); });
  $("tg-db").addEventListener("input", (e) => {
    T.db = +e.target.value; paint();
    if (T.node) { const t = getCtx().currentTime, l = dbToLin(T.db); T.node.gl.gain.setTargetAtTime(T.ch === "right" ? 0 : l, t, 0.02); T.node.gr.gain.setTargetAtTime((T.ch === "left" ? 0 : l) * (T.flip ? -1 : 1), t, 0.02); }
  });
  onSeg($("tg-ch"), (k) => { T.ch = k; relive(); });
  $("tg-flip").onchange = (e) => { T.flip = e.target.checked; relive(); };
  $("tg-play").onclick = () => (T.node ? stop() : start());
  $("tg-sweep").onclick = () => {
    if (T.sweep) { stop(); return; }
    const sw = readSweep();
    if (!sw) { toast("Sweeps run from 1 Hz to 20 kHz, over half a second to ten minutes."); return; }
    if (T.noise) { T.noise = null; setSeg($("tg-noise"), ""); setSeg($("tg-wave"), T.wave); }
    start(sw);
  };
  $("tg-len").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; document.querySelectorAll("#tg-len .chip").forEach((x) => x.classList.toggle("on", x === c)); paint(); });
  $("tg-name").addEventListener("input", (e) => { e.target.dataset.edited = "1"; });
  $("tg-save").onclick = async () => {
    try {
      const { file, fresh } = await buildFile();
      if (isIOS() && fresh) { toast("Ready. Tap Save again, then choose Save to Files."); return; }
      const r = await saveFile(file);
      if (r === "downloaded") toast(`Saved to your Downloads as ${file.name}`, 5000); else if (r === "saved") toast("Saved");
    } catch (e) { toast("Couldn't save the tone. " + (e.message || "")); }
  };
  $("tg-share").onclick = () => {
    const name = () => $("tg-name").value.trim() || defaultName();
    openShareSheet({
      what: "tone", name, build: buildFile, cover: async () => T.cover,
      meta: () => ({ kind: "tone", title: name(), artist: "Tone generator", album: "Tones", duration: +document.querySelector("#tg-len .chip.on").dataset.s }),
    });
  };
  $("tg-keep").onclick = async () => {
    const { file } = await buildFile();
    const sec = +document.querySelector("#tg-len .chip.on").dataset.s;
    const meta = { id: store.newId(), kind: "tone", title: $("tg-name").value.trim() || defaultName(), artist: "Tone generator", album: "Tones",
      note: T.noise ? `${T.noise} noise` : `${fmtF(T.f)} Hz`, duration: sec, size: file.size, type: file.type, fileName: file.name, added: Date.now(), hasArt: !!T.cover };
    await library.add(meta, file, T.cover);
    toast("Added to your library, under Tones");
  };
  $("tg-cover-pick").onclick = async () => {
    const b = await pickImage(); if (!b) return;
    T.cover = b; if (T.coverUrl) URL.revokeObjectURL(T.coverUrl); T.coverUrl = URL.createObjectURL(b); paintCover();
  };
  $("tg-cover-reset").onclick = () => { T.cover = null; if (T.coverUrl) URL.revokeObjectURL(T.coverUrl); T.coverUrl = null; paintCover(); };
  paintCover();
  bus.on("view", (v) => { if (v === "tones") scope(); else stop(); });
  bus.on("music-playing", stop);
  paint();
}
