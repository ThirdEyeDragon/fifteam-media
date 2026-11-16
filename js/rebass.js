// The Rebass screen: choose a song, set the range and level (and, if wanted, slow it down), let the worker find the bass
// line and build the new bass, listen with a live graph of the bass being added, then name it, give it a cover, and save
// it, share it, or keep it in the library.
import { $, toast, openSheet, closeSheet, fmtTime, fill, getCtx, artUrl, placeholderArt, bus, onSeg, segValue } from "./ui.js";
import * as store from "./store.js";
import { library } from "./library.js";
import { player } from "./player.js";
import { FORMATS, makeFile, saveFile, sizeText, isIOS } from "./export.js";
import { openShareSheet, fingerprint } from "./share.js";
import { noteName, linToDb } from "./dsp.js";
import { pickImage } from "./image.js";

const S = {
  src: null, worker: null, loaded: false, origBuf: null, refBuf: null, refKey: "", outBuf: null, res: null, version: 0,
  busy: false, again: false, params: { lo: 25, hi: 45, db: -3, speed: 1, reverb: false },
  pl: null, ab: "rebass", an: null, spec: null, raf: 0, nameEdited: false, file: null, fileKey: "",
  cover: null, coverUrl: null, segs: [], ovImg: null, disp: null, pk: null, glow: [], lastT: 0, lastRead: 0, drag: null,
};

// ---------------------------------------------------------------------------------------------------- choosing a song
async function setSource(src) {
  stopPreview();
  if (S.worker) { S.worker.terminate(); S.worker = null; }
  S.src = src; S.loaded = false; S.origBuf = null; S.refBuf = null; S.refKey = ""; S.outBuf = null; S.res = null; S.file = null; S.nameEdited = false;
  S.cover = null; if (S.coverUrl) URL.revokeObjectURL(S.coverUrl); S.coverUrl = null;
  $("rb-title").textContent = src.title; $("rb-artist").textContent = src.artist || "Unknown artist";
  $("rb-thumb").style.backgroundImage = `url("${src.cover || placeholderArt(src.title)}")`;
  $("rb-go").disabled = false;
  $("rb-go").innerHTML = '<svg><use href="#i-bass"/></svg>Rebass it';
  $("rb-result").hidden = true; $("rb-export").hidden = true; $("rb-busy").hidden = true;
  $("rb-name").value = defaultName();
  paintCover(); paintSlow();
}

async function fromTrack(t) {
  const blob = await store.getBlob(t.id);
  if (!blob) { toast("That song's audio is missing. Add it again from your files."); return; }
  let cover = null, art = null;
  if (t.hasArt) { art = await store.getArt(t.id); cover = artUrl(t.id, art); }
  setSource({ title: t.title, artist: t.artist, blob, cover, art, duration: t.duration });
}

function pickFromLibrary() {
  const songs = library.songs().concat(library.all().filter((t) => t.kind === "rebass"));
  openSheet((p) => {
    const h = document.createElement("h3"); h.textContent = "Choose a song to rebass"; p.appendChild(h);
    if (!songs.length) {
      const e = document.createElement("p"); e.className = "status"; e.textContent = "Your library is empty. Add songs on the Library tab, or pick a file instead."; p.appendChild(e);
      const b = document.createElement("button"); b.className = "btn primary"; b.textContent = "Pick a file"; b.onclick = () => { closeSheet(); pickFile(); }; p.appendChild(b);
      return;
    }
    const ul = document.createElement("ul"); ul.className = "list"; p.appendChild(ul);
    for (const t of songs) {
      const li = document.createElement("li"); li.className = "item";
      li.innerHTML = '<div class="thumb"></div><div class="meta"><div class="t"></div><div class="a"></div></div>';
      li.querySelector(".t").textContent = t.title;
      li.querySelector(".a").textContent = `${t.kind === "rebass" ? "Rebass · " : ""}${t.artist || "Unknown artist"} · ${fmtTime(t.duration)}`;
      const th = li.querySelector(".thumb");
      (async () => { let u = null; if (t.hasArt) u = artUrl(t.id, await store.getArt(t.id)); th.style.backgroundImage = `url("${u || placeholderArt(t.title)}")`; })();
      li.onclick = () => { closeSheet(); fromTrack(t); };
      ul.appendChild(li);
    }
  });
}

async function fromFile(f) {
  const { readTags } = await import("./tags.js");
  const tags = await readTags(f);
  setSource({ title: tags.title, artist: tags.artist, blob: f, cover: tags.art ? URL.createObjectURL(tags.art) : null, art: tags.art });
}
function pickFile() {
  const inp = $("one-in"); inp.value = "";
  inp.onchange = () => { const f = inp.files[0]; if (f) fromFile(f); };
  inp.click();
}

// ---------------------------------------------------------------------------------------------------- the settings
function readParams() {
  const slow = $("rb-slow").checked;
  S.params = {
    lo: +$("rb-lo").value, hi: +$("rb-hi").value, db: +$("rb-db").value,
    speed: slow ? +$("rb-speed").value / 100 : 1, reverb: $("rb-reverb").checked,
  };
}
function paintRange() {
  const lo = $("rb-lo"), hi = $("rb-hi");
  const min = +lo.min, max = +lo.max;
  const a = ((+lo.value - min) / (max - min)) * 100, b = ((+hi.value - min) / (max - min)) * 100;
  $("rb-fill").style.left = `calc(${a}% + ${11 - a * 0.22}px)`;
  $("rb-fill").style.width = `calc(${b - a}% - ${(b - a) * 0.22}px)`;
  $("rb-range-val").innerHTML = `${lo.value}–${hi.value}<small>Hz</small>`;
  document.querySelectorAll("#rb-presets .chip").forEach((c) => c.classList.toggle("on", c.dataset.r === `${lo.value},${hi.value}`));
  const oct = +hi.value / +lo.value;
}
function paintDb() {
  const r = $("rb-db"); fill(r);
  const v = +r.value;
  $("rb-db-val").innerHTML = `${v === 0 ? "0.0" : "−" + Math.abs(v).toFixed(1)}<small>dB</small>`;
}
function paintSlow() {
  const on = $("rb-slow").checked, r = $("rb-speed"), sp = +r.value;
  $("rb-slow-box").hidden = !on;
  fill(r);
  $("rb-speed-val").innerHTML = `${sp}<small>%</small>`;
  document.querySelectorAll("#rb-speed-presets .chip").forEach((c) => c.classList.toggle("on", +c.dataset.s === sp));
  const semis = 12 * Math.log2(sp / 100);
  const dur = S.src && S.src.duration ? ` · ${fmtTime(S.src.duration / (sp / 100))}` : "";
  $("rb-speed-hint").textContent = `−${Math.abs(semis).toFixed(1)} semitones${dur}`;
}
function defaultName() {
  if (!S.src) return "";
  const p = S.params, db = p.db === 0 ? "0" : `-${Math.abs(p.db)}`;
  const slow = p.speed < 1 ? `Slowed ${Math.round(p.speed * 100)}%${p.reverb ? " + Reverb" : ""}, ` : (p.reverb ? "Reverb, " : "");
  return `${S.src.title} (${slow}Rebass ${p.lo}-${p.hi}Hz ${db}dB)`;
}
let reT = 0;
function settingsChanged() {
  readParams();
  if (!S.nameEdited) $("rb-name").value = defaultName();
  if (S.loaded) { clearTimeout(reT); reT = setTimeout(render, 350); }
}

// ---------------------------------------------------------------------------------------------------- the work
const STAGES = {
  decode: ["Reading the song", 0, 0.1], slow: ["Slowing it down", 0.1, 0.3], find: ["Finding the bass line", 0.3, 0.55],
  verb: ["Adding reverb", 0.55, 0.65], build: ["Building the new bass", 0.65, 0.8], master: ["Mastering with zero clipping", 0.8, 1],
};
function progress(stage, p) {
  const [label, a, b] = STAGES[stage];
  const v = a + (b - a) * Math.max(0, Math.min(1, p));
  $("rb-stage").textContent = label; $("rb-pct").textContent = `${Math.round(v * 100)}%`;
  $("rb-bar").style.width = `${v * 100}%`;
}

async function go() {
  if (!S.src || S.busy) return;
  readParams();
  if (!S.loaded) {
    S.busy = true; $("rb-go").disabled = true; $("rb-busy").hidden = false;
    try {
      progress("decode", 0);
      const ctx = getCtx();
      const buf = await ctx.decodeAudioData(await S.src.blob.arrayBuffer());
      if (buf.duration > 20 * 60) throw new Error("That song is over 20 minutes long. Pick a shorter one.");
      S.origBuf = buf;
      if (!S.src.duration) { S.src.duration = buf.duration; paintSlow(); }
      progress("decode", 1);
      const chs = [buf.getChannelData(0).slice(), (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice()];
      S.worker = new Worker(new URL("./rebass-worker.js", import.meta.url), { type: "module" });
      S.worker.onmessage = onWorker;
      S.worker.onerror = (e) => fail(e.message || "The rebass stopped unexpectedly.");
      await new Promise((res, rej) => {
        S._loaded = res; S._failed = rej;
        S.worker.postMessage({ type: "load", chs, sr: buf.sampleRate }, chs.map((c) => c.buffer));
      });
      S.loaded = true;
    } catch (e) {
      S.busy = false; $("rb-go").disabled = false; $("rb-busy").hidden = true;
      toast(e && e.message && !/decode/i.test(e.message) ? e.message : "This phone can't read that file. Try an MP3, M4A or WAV.");
      return;
    }
    S.busy = false;
  }
  render();
}

function render() {
  if (!S.worker || !S.loaded) return;
  if (S.busy) { S.again = true; return; }
  S.busy = true; S.again = false;
  readParams();
  $("rb-go").disabled = true; $("rb-busy").hidden = false;
  S.worker.postMessage({ type: "render", params: S.params });
}

function fail(msg) {
  S.busy = false; $("rb-go").disabled = !S.src; $("rb-busy").hidden = true;
  if (S._failed) { S._failed(new Error(msg)); S._failed = null; }
  toast(msg);
}

function onWorker(e) {
  const m = e.data;
  if (m.type === "progress") progress(m.stage, m.p);
  else if (m.type === "analysis") { if (S._loaded) { S._loaded(); S._loaded = null; } }
  else if (m.type === "error") fail(m.message);
  else if (m.type === "result") {
    const ctx = getCtx(), sr = S.origBuf.sampleRate;
    const n = m.out[0].length;
    const wasPlaying = !!S.pl, frac = S.outBuf ? curTime() / S.outBuf.duration : 0;
    stopPreview();
    const ob = ctx.createBuffer(2, n, sr);
    ob.copyToChannel(m.out[0], 0); ob.copyToChannel(m.out[1], 1);
    S.outBuf = ob;
    // what "Original" plays: the slowed (or reverbed) song without the new bass, or the song itself
    if (m.ref) { const rb = ctx.createBuffer(2, m.ref[0].length, sr); rb.copyToChannel(m.ref[0], 0); rb.copyToChannel(m.ref[1], 1); S.refBuf = rb; }
    S.refKey = m.refKey;
    if (!m.refKey) S.refBuf = null;
    S.res = { stats: m.stats, map: m.map, t0: m.t0, hop: m.hop };
    S.version++; S.file = null;
    S.busy = false;
    $("rb-busy").hidden = true; $("rb-go").disabled = false;
    $("rb-go").innerHTML = '<svg><use href="#i-bass"/></svg>Rebass again';
    $("rb-result").hidden = false; $("rb-export").hidden = false;
    $("rb-dur").textContent = fmtTime(ob.duration);
    S.pausedAt = Math.min(frac * ob.duration, ob.duration);
    buildSegments(); drawOverview(); paintStats(); paintSize();
    S.pk = null; S.glow = []; S.disp = null;
    startGraph();
    if (wasPlaying) playPreview(S.pausedAt);
    if (S.again) render();
  }
}

function paintStats() {
  const s = S.res.stats, p = S.params;
  const f1 = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  const dB = (v, d = 1) => (v > -0.005 ? (0).toFixed(d) : v.toFixed(d).replace("-", "−"));
  const items = [
    ["wide", s.mapping, "How the bass line moved"],
    ["good", "0", "Clipped"],
    ["", `${dB(s.bassActualDb, 2)} dB`, "Bass peak"],
    [s.ridePct > 0.05 ? "" : "good", `${dB(s.songDb)} dB`, s.ridePct > 0.05 ? `Song level · ducks ${s.ridePct.toFixed(s.ridePct < 1 ? 1 : 0)}%` : "Song level · no compression"],
    ["", `${dB(s.truePeakDb, 2)} dBTP`, "True peak"],
    ["", `${s.notes.toLocaleString()}`, "Bass notes"],
    ["", `${(s.drums + s.other).toLocaleString()}`, "Not bass (ignored)"],
    ["", `${f1(s.songLo)}–${f1(s.songHi)} Hz`, "Old bass"],
    ["", `${f1(s.newLo)}–${f1(s.newHi)} Hz`, "New bass"],
    ["good", `${s.lo}–${s.hi} Hz`, "Only this range changed"],
  ];
  if (s.speed < 1 || s.reverb) items.push(["", s.speed < 1 ? `${Math.round(s.speed * 100)}%${s.reverb ? " + verb" : ""}` : "Reverb", s.speed < 1 ? "Speed" : "Effect"]);
  if (s.clipped) items[0] = ["", String(s.clipped), "Clipped"];
  $("rb-stats").innerHTML = items.map(([c, b, t]) => `<div class="stat ${c}"><b>${b}</b><span>${t}</span></div>`).join("");
}

// ---------------------------------------------------------------------------------------------------- listening
function curTime() {
  if (!S.pl) return S.pausedAt || 0;
  return Math.max(0, Math.min(S.outBuf.duration, getCtx().currentTime - S.pl.t0));
}
function ensureAnalyser() {
  const ctx = getCtx();
  if (!S.an || S.an.context !== ctx) {
    S.an = ctx.createAnalyser();
    S.an.fftSize = 32768; S.an.smoothingTimeConstant = 0.82; S.an.minDecibels = -110; S.an.maxDecibels = -5;
    S.an.connect(ctx.destination);
    S.spec = new Float32Array(S.an.frequencyBinCount);
  }
}
function playPreview(at = 0) {
  if (!S.outBuf) return;
  stopPreview(true);
  player.pause();
  const ctx = getCtx();
  ensureAnalyser();
  const so = ctx.createBufferSource(), sr = ctx.createBufferSource();
  so.buffer = S.refKey && S.refBuf ? S.refBuf : S.origBuf; sr.buffer = S.outBuf;
  const go = ctx.createGain(), gr = ctx.createGain();
  go.gain.value = S.ab === "orig" ? 1 : 0; gr.gain.value = S.ab === "rebass" ? 1 : 0;
  so.connect(go).connect(S.an); sr.connect(gr).connect(S.an);
  const t = ctx.currentTime + 0.04;
  at = Math.max(0, Math.min(at, S.outBuf.duration - 0.05));
  if (at < so.buffer.duration) so.start(t, at);
  sr.start(t, at);
  S.pl = { so, sr, go, gr, t0: t - at };
  sr.onended = () => { if (S.pl && S.pl.sr === sr) { S.pausedAt = 0; stopPreview(); } };
  setPlayIcon(true);
}
function stopPreview(keepPos) {
  if (!S.pl) return;
  if (keepPos) S.pausedAt = curTime();
  const { so, sr } = S.pl;
  S.pl = null;
  try { so.stop(); } catch {}
  try { sr.stop(); } catch {}
  setPlayIcon(false);
}
function seekTo(t) {
  t = Math.max(0, Math.min(S.outBuf.duration, t));
  if (S.pl) playPreview(t); else S.pausedAt = t;
}
function setPlayIcon(on) {
  const b = $("rb-play"); b.querySelector("use").setAttribute("href", on ? "#i-pause" : "#i-play"); b.setAttribute("aria-label", on ? "Pause preview" : "Play preview");
}
function setAB(k) {
  S.ab = k;
  if (S.pl) {
    const t = getCtx().currentTime;
    S.pl.go.gain.setTargetAtTime(k === "orig" ? 1 : 0, t, 0.015);
    S.pl.gr.gain.setTargetAtTime(k === "rebass" ? 1 : 0, t, 0.015);
  }
}

// ---------------------------------------------------------------------------------------------------- the graphs
function sizeCanvas(c) {
  const dpr = Math.min(3, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
const GRAD = (g, x0, x1) => { const gr = g.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, "#2f78ff"); gr.addColorStop(0.55, "#7a4bff"); gr.addColorStop(1, "#bb4dff"); return gr; };

/** The new bass at time t, read smoothly between the 10 ms frames. */
function bassAt(t) {
  const r = S.res; if (!r) return null;
  const p = (t - r.t0) / r.hop, i = Math.floor(p), u = p - i, n = r.map.length / 3;
  if (i < 0 || i >= n - 1) return null;
  const f0 = r.map[i * 3 + 1], f1 = r.map[i * 3 + 4], e0 = r.map[i * 3 + 2], e1 = r.map[i * 3 + 5];
  const e = (f0 > 0 ? e0 : 0) * (1 - u) + (f1 > 0 ? e1 : 0) * u;
  const f = f0 > 0 && f1 > 0 ? f0 * Math.pow(f1 / f0, u) : (f0 > 0 ? f0 : f1);
  return f > 0 ? { f, e } : null;
}

// the live spectrum: the whole song's low end (smoothed and drawn as a curve) and the bass being added (a glowing peak)
const F0 = 10, F1 = 250;
const xOf = (f, w) => ((Math.log(f) - Math.log(F0)) / (Math.log(F1) - Math.log(F0))) * w;
function drawSpec(dt) {
  const c = $("rb-spec"), { g, w, h } = sizeCanvas(c);
  g.clearRect(0, 0, w, h);
  const yOf = (db) => h - 20 - ((db + 100) / 100) * (h - 32);
  g.font = "600 10px Inter, system-ui, sans-serif"; g.textAlign = "center"; g.lineWidth = 1;
  for (const f of [10, 20, 30, 40, 60, 80, 100, 150, 200]) {
    const x = xOf(f, w); g.strokeStyle = "rgba(190,196,255,0.07)"; g.beginPath(); g.moveTo(x, 8); g.lineTo(x, h - 20); g.stroke();
    g.fillStyle = "rgba(190,196,255,0.45)"; g.fillText(`${f}`, Math.min(w - 10, Math.max(10, x)), h - 6);
  }
  g.textAlign = "left";
  for (const db of [-20, -40, -60, -80]) { const y = yOf(db); g.strokeStyle = "rgba(190,196,255,0.05)"; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.fillStyle = "rgba(190,196,255,0.32)"; g.fillText(`${db}`, 4, y - 3); }
  const p = S.params, xa = xOf(p.lo, w), xb = xOf(p.hi, w);
  const band = g.createLinearGradient(0, 8, 0, h - 20); band.addColorStop(0, "rgba(178,92,255,0.10)"); band.addColorStop(1, "rgba(61,123,255,0.04)");
  g.fillStyle = band; g.fillRect(xa, 8, xb - xa, h - 28);
  const playing = !!S.pl;
  // the song: the analyser (already averaged), eased again on screen, one point every 3 px, drawn through midpoints
  const cols = Math.ceil(w / 3) + 1;
  if (!S.disp || S.disp.length !== cols) S.disp = new Float32Array(cols).fill(-100);
  const k = 1 - Math.exp(-dt / 0.06);
  if (playing && S.an) {
    S.an.getFloatFrequencyData(S.spec);
    const binHz = getCtx().sampleRate / S.an.fftSize;
    for (let i = 0; i < cols; i++) {
      const f = F0 * Math.pow(F1 / F0, (i * 3) / w), kb = f / binHz, k0 = Math.floor(kb), u = kb - k0;
      const v = Math.max(-100, ((S.spec[k0] ?? -120) * (1 - u) + (S.spec[k0 + 1] ?? -120) * u) + 6);
      S.disp[i] += (v - S.disp[i]) * k;
    }
  } else for (let i = 0; i < cols; i++) S.disp[i] += (-100 - S.disp[i]) * k * 0.5;
  const pts = Array.from(S.disp, (v, i) => [i * 3, yOf(v)]);
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); }
  const songFill = g.createLinearGradient(0, 8, 0, h - 20); songFill.addColorStop(0, "rgba(159,179,255,0.16)"); songFill.addColorStop(1, "rgba(159,179,255,0)");
  g.strokeStyle = "rgba(159,179,255,0.85)"; g.lineWidth = 1.6; g.stroke();
  g.lineTo(w, h - 20); g.lineTo(0, h - 20); g.closePath(); g.fillStyle = songFill; g.fill();
  // the added bass: one clean sine, so one peak; its place and height eased so it glides from note to note
  const t = curTime(), now = bassAt(t), A = S.res ? S.res.stats.bassGain : 0;
  const tgt = now ? { lf: Math.log(now.f), db: linToDb(A * now.e) } : null;
  if (!S.pk) S.pk = tgt ? { ...tgt } : { lf: Math.log(p.lo), db: -100 };
  const kf = 1 - Math.exp(-dt / 0.035), kd = 1 - Math.exp(-dt / (tgt && tgt.db > S.pk.db ? 0.03 : 0.09));
  if (tgt) S.pk.lf += (tgt.lf - S.pk.lf) * kf;
  S.pk.db += ((tgt ? tgt.db : -100) - S.pk.db) * kd;
  const f = Math.exp(S.pk.lf), x = xOf(f, w), y = yOf(Math.max(-100, S.pk.db)), base = h - 20;
  if (S.pk.db > -95) {
    const alpha = S.ab === "rebass" ? 1 : 0.45;
    // its afterglow: where it has just been
    S.glow.push([x, y]); if (S.glow.length > 18) S.glow.shift();
    if (S.glow.length > 2) {
      g.beginPath(); g.moveTo(S.glow[0][0], S.glow[0][1]);
      for (const [gx, gy] of S.glow) g.lineTo(gx, gy);
      g.strokeStyle = `rgba(178,92,255,${0.25 * alpha})`; g.lineWidth = 2; g.stroke();
    }
    const width = 16 + 10 * Math.min(1, (S.pk.db + 60) / 50);
    const fillG = g.createLinearGradient(0, y, 0, base);
    fillG.addColorStop(0, `rgba(178,92,255,${0.85 * alpha})`); fillG.addColorStop(0.6, `rgba(123,92,255,${0.35 * alpha})`); fillG.addColorStop(1, `rgba(61,123,255,${0.04 * alpha})`);
    g.beginPath(); g.moveTo(x - width * 2.2, base);
    for (let dx = -width * 2.2; dx <= width * 2.2; dx += 1.5) g.lineTo(x + dx, base - (base - y) * Math.exp(-(dx * dx) / (2 * width * width / 4.5)));
    g.lineTo(x + width * 2.2, base); g.closePath(); g.fillStyle = fillG; g.fill();
    g.shadowColor = "rgba(178,92,255,0.9)"; g.shadowBlur = 14 * alpha;
    g.fillStyle = "#fff"; g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
  } else S.glow.length = 0;
  // the numbers, ten times a second
  if (performance.now() - S.lastRead > 100) {
    S.lastRead = performance.now();
    const live = now && S.pk.db > -95;
    $("rb-now-f").textContent = live ? `${now.f.toFixed(1)} Hz` : "–";
    $("rb-now-n").textContent = live ? noteName(now.f).split(" ")[0] : "–";
    $("rb-now-l").textContent = live ? `${S.pk.db.toFixed(1)} dB` : "–";
  }
}

// the bass roll: eight seconds round the play position, each new bass note a bar at its pitch (thicker when louder),
// the song's own bass behind it, the note playing now lit and named; drag it to scrub
const WIN = 8, AT = 0.35;
function buildSegments() {
  const r = S.res, n = r.map.length / 3, segs = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const fn = r.map[i * 3 + 1], e = r.map[i * 3 + 2], fo = r.map[i * 3], t = r.t0 + i * r.hop;
    const on = fn > 0 && e > 0.05;
    if (on && cur && Math.abs(fn / cur.f - 1) < 0.01 && t - cur.t1 < 0.025) { cur.t1 = t + r.hop; cur.e = Math.max(cur.e, e); if (fo > 0) cur.fo.push(fo); continue; }
    if (cur) segs.push(cur);
    cur = on ? { t0: t, t1: t + r.hop, f: fn, e, fo: fo > 0 ? [fo] : [] } : null;
  }
  if (cur) segs.push(cur);
  for (const s of segs) { s.fo.sort((a, b) => a - b); s.fom = s.fo.length ? s.fo[s.fo.length >> 1] : 0; }
  S.segs = segs;
  const lo = Math.min(S.params.lo, r.stats.newLo), hi = Math.max(S.params.hi, r.stats.newHi, r.stats.songHi * 1.05);
  S.yr = [lo / 1.12, hi * 1.08];
}
function drawRoll() {
  if (!S.res) return;
  const c = $("rb-map"), { g, w, h } = sizeCanvas(c);
  g.clearRect(0, 0, w, h);
  const t = curTime(), tA = t - WIN * AT, sx = w / WIN;
  const [y0, y1] = S.yr, top = 10, bot = h - 18;
  const yOf = (f) => bot - ((Math.log(f) - Math.log(y0)) / (Math.log(y1) - Math.log(y0))) * (bot - top);
  // the note lanes: every semitone faint, each E and A (the bass strings) a little brighter, and named
  g.font = "600 10px Inter, system-ui, sans-serif"; g.textBaseline = "middle";
  const m0 = Math.ceil(69 + 12 * Math.log2(y0 / 440)), m1 = Math.floor(69 + 12 * Math.log2(y1 / 440));
  const pxPerSemi = (bot - top) / (12 * Math.log2(y1 / y0));
  for (let m = m0; m <= m1; m++) {
    const f = 440 * Math.pow(2, (m - 69) / 12), y = yOf(f), pc = ((m % 12) + 12) % 12, named = pc === 4 || pc === 9 || pc === 0;
    g.strokeStyle = named ? "rgba(190,196,255,0.10)" : "rgba(190,196,255,0.035)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    if (named && pxPerSemi * 3 > 10 && y > top + 6 && y < bot - 4) { g.fillStyle = "rgba(190,196,255,0.42)"; g.fillText(noteName(f).split(" ")[0], 4, y - 6); }
  }
  // the chosen range
  const ra = yOf(S.params.hi), rb = yOf(S.params.lo);
  g.fillStyle = "rgba(255,255,255,0.035)"; g.fillRect(0, ra, w, rb - ra);
  // seconds along the bottom
  g.fillStyle = "rgba(190,196,255,0.35)"; g.textAlign = "center";
  for (let s = Math.ceil(tA); s < tA + WIN; s++) { if (s < 0) continue; const x = (s - tA) * sx; g.fillRect(x, bot + 2, 1, 4); if (s % 2 === 0) g.fillText(fmtTime(s), x, bot + 11); }
  g.textAlign = "left";
  const grad = GRAD(g, 0, w);
  let current = null;
  for (const s of S.segs) {
    if (s.t1 < tA || s.t0 > tA + WIN) continue;
    const x0 = (s.t0 - tA) * sx, x1 = Math.max(x0 + 2, (s.t1 - tA) * sx);
    // the song's own note, faint, behind
    if (s.fom >= y0 && s.fom <= y1) { g.fillStyle = "rgba(159,179,255,0.22)"; roundRect(g, x0, yOf(s.fom) - 1.5, x1 - x0, 3, 1.5); g.fill(); }
    const y = yOf(s.f), th = 4 + 6 * s.e, past = s.t1 < t, on = s.t0 <= t && s.t1 >= t;
    if (on) current = { s, x0, x1, y };
    g.globalAlpha = past ? 0.5 : 1;
    g.fillStyle = grad; roundRect(g, x0, y - th / 2, x1 - x0, th, th / 2); g.fill();
    g.globalAlpha = 1;
  }
  // the play position
  const px = WIN * AT * sx;
  const pg = g.createLinearGradient(px - 18, 0, px + 1, 0); pg.addColorStop(0, "rgba(178,92,255,0)"); pg.addColorStop(1, "rgba(178,92,255,0.18)");
  g.fillStyle = pg; g.fillRect(px - 18, top - 6, 18, bot - top + 6);
  g.fillStyle = "#fff"; g.fillRect(px - 0.75, top - 6, 1.5, bot - top + 8);
  if (current) {
    const { s, y } = current, th = 4 + 6 * s.e;
    g.shadowColor = "rgba(178,92,255,0.95)"; g.shadowBlur = 16;
    g.fillStyle = "#fff"; roundRect(g, px - 3, y - th / 2, 6, th, th / 2); g.fill();
    g.shadowBlur = 0;
    const label = `${noteName(s.f).split(" ")[0]} · ${s.f.toFixed(1)} Hz`;
    g.font = "700 11px Inter, system-ui, sans-serif";
    const tw = g.measureText(label).width, lx = Math.min(w - tw - 12, px + 8), ly = Math.max(top + 8, y - th / 2 - 12);
    g.fillStyle = "rgba(20,17,58,0.9)"; roundRect(g, lx - 6, ly - 9, tw + 12, 18, 9); g.fill();
    g.fillStyle = "#fff"; g.fillText(label, lx, ly);
  }
  $("rb-cur").textContent = fmtTime(t);
}
function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// the whole song at a glance: how much bass there is along it, the window the roll shows, and the play position
function drawOverview() {
  const c = $("rb-ov"), dpr = Math.min(3, devicePixelRatio || 1), w = c.clientWidth || 300, h = c.clientHeight || 34;
  const off = document.createElement("canvas"); off.width = Math.round(w * dpr); off.height = Math.round(h * dpr);
  const g = off.getContext("2d"); g.scale(dpr, dpr);
  const r = S.res, n = r.map.length / 3, dur = S.outBuf.duration, cols = Math.max(1, Math.floor(w / 2));
  const env = new Float32Array(cols);
  for (let i = 0; i < n; i++) {
    if (!(r.map[i * 3 + 1] > 0)) continue;
    const col = Math.min(cols - 1, Math.floor(((r.t0 + i * r.hop) / dur) * cols));
    env[col] = Math.max(env[col], r.map[i * 3 + 2]);
  }
  g.fillStyle = GRAD(g, 0, w);
  for (let i = 0; i < cols; i++) { const v = env[i] * (h - 8); g.globalAlpha = 0.35 + 0.65 * env[i]; g.fillRect(i * 2, (h - v) / 2, 1.4, Math.max(1, v)); }
  g.globalAlpha = 1;
  S.ovImg = off;
}
function paintOverview() {
  if (!S.ovImg || !S.outBuf) return;
  const c = $("rb-ov"), { g, w, h } = sizeCanvas(c);
  g.clearRect(0, 0, w, h);
  g.drawImage(S.ovImg, 0, 0, w, h);
  const dur = S.outBuf.duration, t = curTime();
  const a = ((t - WIN * AT) / dur) * w, b = ((t + WIN * (1 - AT)) / dur) * w;
  g.fillStyle = "rgba(255,255,255,0.08)"; g.fillRect(a, 1, b - a, h - 2);
  g.strokeStyle = "rgba(255,255,255,0.28)"; g.lineWidth = 1; g.strokeRect(a + 0.5, 1.5, b - a - 1, h - 3);
  g.fillStyle = "#fff"; g.fillRect((t / dur) * w - 0.75, 2, 1.5, h - 4);
}

function startGraph() {
  cancelAnimationFrame(S.raf);
  S.lastT = 0;
  const tick = (now) => {
    if ($("rb-result").hidden || location.hash !== "#rebass") { S.raf = 0; return; }
    const dt = S.lastT ? Math.min(0.1, (now - S.lastT) / 1000) : 0.016;
    S.lastT = now;
    drawSpec(dt); drawRoll(); paintOverview();
    S.raf = requestAnimationFrame(tick);
  };
  S.raf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------------------------------- the cover
function coverBlob() { return S.cover || (S.src && S.src.art) || null; }
function paintCover() {
  const el = $("rb-cover");
  const url = S.coverUrl || (S.src && S.src.cover) || placeholderArt(S.src ? S.src.title : "FifTeam");
  el.style.backgroundImage = `url("${url}")`;
  $("rb-cover-note").textContent = S.cover ? "Cover: your image" : S.src && S.src.art ? "Cover: the song's own" : "Cover: none yet (FifTeam art)";
  $("rb-cover-reset").hidden = !S.cover;
}

// ---------------------------------------------------------------------------------------------------- saving and sharing
function paintSize() {
  if (!S.outBuf) return;
  const f = FORMATS[segValue($("rb-format"))];
  $("rb-size").textContent = `About ${sizeText(S.outBuf.duration * f.bytesPerSec(S.outBuf.sampleRate))} · ${S.outBuf.sampleRate / 1000} kHz stereo · ${fmtTime(S.outBuf.duration)}`;
}
const fileKeyNow = () => `${S.version}|${segValue($("rb-format"))}|${S.cover ? S.cover.size : 0}|${$("rb-name").value.trim()}`;
async function buildFile() {
  const fmt = segValue($("rb-format")), name = $("rb-name").value.trim() || defaultName();
  const key = fileKeyNow();
  const fresh = !S.file || S.fileKey !== key;
  if (fresh) {
    toast(fmt === "mp3" ? "Making the MP3…" : "Making the file…", 60000);
    const chs = [S.outBuf.getChannelData(0), S.outBuf.getChannelData(1)];
    const { file } = await makeFile(chs, S.outBuf.sampleRate, name, fmt, getCtx(), null,
      { title: name, artist: (S.src && S.src.artist) || "", album: "FifTeam Media", cover: coverBlob() });
    S.file = file; S.fileKey = key;
  }
  return { file: S.file, fresh };
}
async function save() {
  if (!S.outBuf) return;
  try {
    const { file, fresh } = await buildFile();
    if (isIOS() && fresh) { toast("Ready. Tap Save again, then choose Save to Files."); return; }
    if (isIOS()) toast("Choose Save to Files to keep it on your iPhone", 5000);
    const r = await saveFile(file);
    if (r === "saved") toast("Saved");
    else if (r === "downloaded") toast(`Saved to your Downloads as ${file.name}`, 5000);
  } catch (e) { toast("Couldn't save the file. " + (e.message || "")); }
}
const noteOf = (p) => `${p.speed < 1 ? Math.round(p.speed * 100) + "% · " : ""}${p.lo}–${p.hi} Hz · ${p.db === 0 ? "0" : "−" + Math.abs(p.db)} dB`;
function share() {
  if (!S.outBuf) return;
  const name = () => $("rb-name").value.trim() || defaultName();
  openShareSheet({
    what: "song", name, build: buildFile, cover: async () => coverBlob(),
    meta: () => ({ kind: "rebass", title: name(), artist: S.src.artist || "", album: "Rebassed", duration: S.outBuf.duration, note: noteOf(S.params), made: { ...S.params, from: S.src.title } }),
    recipe: async () => {
      if (!S.src.hash) S.src.hash = await fingerprint(S.src.blob);
      const p = S.params;
      return { title: S.src.title, artist: S.src.artist || "", duration: S.src.duration || (S.origBuf ? S.origBuf.duration : 0), hash: S.src.hash, settings: { lo: p.lo, hi: p.hi, db: p.db, speed: p.speed, reverb: p.reverb, name: S.nameEdited ? name() : "" } };
    },
  });
}
async function keep() {
  if (!S.outBuf) return;
  const name = $("rb-name").value.trim() || defaultName();
  toast("Adding to your library…", 60000);
  const chs = [S.outBuf.getChannelData(0), S.outBuf.getChannelData(1)];
  const fmt = segValue($("rb-format")) === "mp3" ? "mp3" : "wav16";
  const cover = coverBlob();
  const { file } = await makeFile(chs, S.outBuf.sampleRate, name, fmt, getCtx(), null, { title: name, artist: S.src.artist || "", album: "FifTeam Media", cover });
  const p = S.params;
  const meta = {
    id: store.newId(), kind: "rebass", title: name, artist: S.src.artist || "", album: "Rebassed",
    note: noteOf(p),
    duration: S.outBuf.duration, size: file.size, type: file.type, fileName: file.name, added: Date.now(), hasArt: !!cover,
  };
  try { await library.add(meta, file, cover); toast("Added to your library, under Rebassed"); }
  catch { toast("Your phone is out of room for it."); }
}

// ---------------------------------------------------------------------------------------------------- wiring
export function initRebass() {
  $("rb-pick-lib").onclick = pickFromLibrary;
  $("rb-pick-file").onclick = pickFile;
  $("rb-go").onclick = () => (S.loaded ? render() : go());
  for (const id of ["rb-lo", "rb-hi"]) $(id).addEventListener("input", (e) => {
    const lo = $("rb-lo"), hi = $("rb-hi");
    if (+hi.value - +lo.value < 3) { if (e.target === lo) lo.value = +hi.value - 3; else hi.value = +lo.value + 3; }
    paintRange(); settingsChanged();
  });
  $("rb-presets").addEventListener("click", (e) => {
    const c = e.target.closest(".chip"); if (!c) return;
    const [a, b] = c.dataset.r.split(","); $("rb-lo").value = a; $("rb-hi").value = b; paintRange(); settingsChanged();
  });
  $("rb-db").addEventListener("input", () => { paintDb(); settingsChanged(); });
  $("rb-slow").onchange = () => { paintSlow(); settingsChanged(); };
  $("rb-speed").addEventListener("input", () => { paintSlow(); settingsChanged(); });
  $("rb-speed-presets").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; $("rb-speed").value = c.dataset.s; paintSlow(); settingsChanged(); });
  $("rb-reverb").onchange = settingsChanged;
  $("rb-name").addEventListener("input", () => { S.nameEdited = true; });
  onSeg($("rb-ab"), setAB);
  onSeg($("rb-format"), () => paintSize());
  $("rb-play").onclick = () => { getCtx(); if (S.pl) stopPreview(true); else playPreview(S.pausedAt || 0); };
  // the roll: drag to scrub (the music follows when you let go), tap to jump there
  const roll = $("rb-map");
  roll.addEventListener("pointerdown", (e) => {
    if (!S.outBuf) return;
    roll.setPointerCapture(e.pointerId);
    S.drag = { x: e.clientX, t: curTime(), moved: false, was: !!S.pl };
    if (S.pl) stopPreview(true);
  });
  roll.addEventListener("pointermove", (e) => {
    if (!S.drag) return;
    const dx = e.clientX - S.drag.x;
    if (Math.abs(dx) > 3) S.drag.moved = true;
    S.pausedAt = Math.max(0, Math.min(S.outBuf.duration, S.drag.t - (dx / roll.clientWidth) * WIN));
  });
  const endDrag = (e) => {
    if (!S.drag) return;
    const d = S.drag; S.drag = null;
    if (!d.moved) { const r = roll.getBoundingClientRect(); S.pausedAt = Math.max(0, Math.min(S.outBuf.duration, d.t + ((e.clientX - r.left) / r.width - AT) * WIN)); }
    if (d.was) playPreview(S.pausedAt);
  };
  roll.addEventListener("pointerup", endDrag); roll.addEventListener("pointercancel", endDrag);
  const ov = $("rb-ov");
  const ovSeek = (e) => { if (!S.outBuf) return; const r = ov.getBoundingClientRect(); seekTo(((e.clientX - r.left) / r.width) * S.outBuf.duration); };
  ov.addEventListener("pointerdown", (e) => { ov.setPointerCapture(e.pointerId); ovSeek(e); });
  // the cover
  $("rb-cover-pick").onclick = async () => {
    const b = await pickImage(); if (!b) return;
    S.cover = b; if (S.coverUrl) URL.revokeObjectURL(S.coverUrl); S.coverUrl = URL.createObjectURL(b); paintCover();
  };
  $("rb-cover-reset").onclick = () => { S.cover = null; if (S.coverUrl) URL.revokeObjectURL(S.coverUrl); S.coverUrl = null; paintCover(); };
  $("rb-save").onclick = save; $("rb-share").onclick = share; $("rb-keep").onclick = keep;
  bus.on("rebass", (t) => { location.hash = "#rebass"; fromTrack(t); });
  bus.on("view", (v) => { if (v !== "rebass") stopPreview(true); else if (S.res) startGraph(); });
  bus.on("music-playing", () => stopPreview(true));
  addEventListener("resize", () => { if (S.res) drawOverview(); });
  paintRange(); paintDb(); paintSlow(); readParams(); paintCover();
}

/** A rebass code a friend sent: this song, set up exactly their way, and rebassed. */
async function applyRecipe(track, s) {
  location.hash = "#rebass";
  await fromTrack(track);
  $("rb-lo").value = s.lo; $("rb-hi").value = s.hi; $("rb-db").value = s.db;
  $("rb-slow").checked = s.speed < 0.999; if (s.speed < 0.999) $("rb-speed").value = Math.round(s.speed * 100);
  $("rb-reverb").checked = !!s.reverb;
  paintRange(); paintDb(); paintSlow(); readParams();
  if (s.name) { $("rb-name").value = s.name; S.nameEdited = true; } else $("rb-name").value = defaultName();
  go();
}

export const rebass = { fromFile, applyRecipe };
