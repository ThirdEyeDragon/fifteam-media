// The Rebass screen: choose a song, set the range and level, let the worker find the bass line and build the new bass,
// listen (with a live graph of the bass being added), then name it and save it, share it, or keep it in the library.
import { $, toast, openSheet, closeSheet, fmtTime, fill, getCtx, artUrl, placeholderArt, bus, onSeg, segValue } from "./ui.js";
import * as store from "./store.js";
import { library } from "./library.js";
import { player } from "./player.js";
import { FORMATS, makeFile, saveFile, shareFile, canShareFiles, sizeText, isIOS } from "./export.js";
import { noteName, linToDb } from "./dsp.js";

const S = {
  src: null, worker: null, loaded: false, origBuf: null, outBuf: null, res: null, version: 0,
  busy: false, again: false, params: { lo: 25, hi: 45, mode: "musical", db: -3, replace: true, snap: true },
  pl: null, ab: "rebass", an: null, spec: null, raf: 0, mapImg: null, nameEdited: false, file: null, fileKey: "",
  trail: [],
};

// ---------------------------------------------------------------------------------------------------- choosing a song
async function setSource(src) {
  stopPreview();
  if (S.worker) { S.worker.terminate(); S.worker = null; }
  S.src = src; S.loaded = false; S.origBuf = null; S.outBuf = null; S.res = null; S.file = null; S.nameEdited = false;
  $("rb-title").textContent = src.title; $("rb-artist").textContent = src.artist || "Unknown artist";
  $("rb-thumb").style.backgroundImage = `url("${src.cover || placeholderArt(src.title)}")`;
  $("rb-go").disabled = false;
  $("rb-result").hidden = true; $("rb-export").hidden = true; $("rb-busy").hidden = true;
  $("rb-name").value = defaultName();
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

function pickFile() {
  const inp = $("one-in"); inp.value = "";
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    const { readTags } = await import("./tags.js");
    const tags = await readTags(f);
    setSource({ title: tags.title, artist: tags.artist, blob: f, cover: tags.art ? URL.createObjectURL(tags.art) : null, art: tags.art });
  };
  inp.click();
}

// ---------------------------------------------------------------------------------------------------- the settings
function readParams() {
  const lo = +$("rb-lo").value, hi = +$("rb-hi").value;
  S.params = { lo, hi, mode: segValue($("rb-mode")), db: +$("rb-db").value, replace: $("rb-replace").checked, snap: $("rb-snap").checked };
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
  $("rb-mode-hint").textContent = segValue($("rb-mode")) === "stretch"
    ? "The song's lowest bass note lands on the low end, its highest on the high end. The bass line keeps its shape, not its key."
    : oct >= 2 ? "Each note moves down whole octaves into the range, so the bass stays in tune with the song."
    : "Each note moves down whole octaves into the range. This range is under an octave wide, so some notes are pulled to its edge; widen it to keep every note in tune.";
}
function paintDb() {
  const r = $("rb-db"); fill(r);
  const v = +r.value;
  $("rb-db-val").innerHTML = `${v === 0 ? "0.0" : "−" + Math.abs(v).toFixed(1)}<small>dB</small>`;
}
function defaultName() {
  if (!S.src) return "";
  const p = S.params, db = p.db === 0 ? "0" : `-${Math.abs(p.db)}`;
  return `${S.src.title} (Rebass ${p.lo}-${p.hi}Hz ${db}dB)`;
}
let reT = 0;
function settingsChanged() {
  readParams();
  if (!S.nameEdited) $("rb-name").value = defaultName();
  if (S.loaded) { clearTimeout(reT); reT = setTimeout(render, 350); }
}

// ---------------------------------------------------------------------------------------------------- the work
const STAGES = { decode: ["Reading the song", 0, 0.12], find: ["Finding the bass line", 0.12, 0.5], build: ["Building the new bass", 0.5, 0.72], master: ["Mastering with zero clipping", 0.72, 1] };
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
    const ctx = getCtx();
    const n = m.out[0].length;
    const wasPlaying = !!S.pl, at = S.pl ? curTime() : 0;
    stopPreview();
    const ob = ctx.createBuffer(2, n, S.origBuf.sampleRate);
    ob.copyToChannel(m.out[0], 0); ob.copyToChannel(m.out[1], 1);
    S.outBuf = ob;
    S.res = { stats: m.stats, map: m.map, t0: m.t0, hop: m.hop };
    S.version++; S.file = null;
    S.busy = false;
    $("rb-busy").hidden = true; $("rb-go").disabled = false;
    $("rb-go").innerHTML = '<svg><use href="#i-bass"/></svg>Rebass again';
    $("rb-result").hidden = false; $("rb-export").hidden = false;
    $("rb-dur").textContent = fmtTime(ob.duration);
    paintStats(); drawMap(); paintSize();
    startGraph();
    if (wasPlaying) playPreview(at);
    if (S.again) render();
  }
}

function paintStats() {
  const s = S.res.stats, p = S.params;
  const f1 = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  const items = [
    ["good", "0", "Clipped samples"],
    ["", `${s.truePeakDb.toFixed(2)} dBTP`, "True peak (between samples)"],
    ["", `${s.notes.toLocaleString()}`, "Bass notes found"],
    ["", p.mode === "musical" ? `${Math.round(s.tunedPct)}%` : "Stretched", p.mode === "musical" ? "Notes kept in tune" : "Notes mapped to the range"],
    ["", `${f1(s.songLo)}–${f1(s.songHi)} Hz`, "The song's bass"],
    ["", `${f1(s.newLo)}–${f1(s.newHi)} Hz`, "The new bass"],
    ["", `${s.peakDb.toFixed(2)} dBFS`, "Loudest sample"],
    ["", s.duckDb > -0.05 ? "Not needed" : `${s.duckAvgDb.toFixed(1)} dB`, s.duckDb < -40 ? "Song under the loud bass (gone at the very peaks)" : "Song under the loud bass, on average"],
  ];
  if (s.clipped) items[0] = ["", String(s.clipped), "Clipped samples"];
  $("rb-stats").innerHTML = items.map(([c, b, t]) => `<div class="stat ${c}"><b>${b}</b><span>${t}</span></div>`).join("");
}

// ---------------------------------------------------------------------------------------------------- listening
function curTime() {
  if (!S.pl) return S.pausedAt || 0;
  return Math.min(S.outBuf.duration, getCtx().currentTime - S.pl.t0);
}
function ensureAnalyser() {
  const ctx = getCtx();
  if (!S.an || S.an.context !== ctx) {
    S.an = ctx.createAnalyser();
    S.an.fftSize = 32768; S.an.smoothingTimeConstant = 0.55; S.an.minDecibels = -110; S.an.maxDecibels = -5;
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
  so.buffer = S.origBuf; sr.buffer = S.outBuf;
  const go = ctx.createGain(), gr = ctx.createGain();
  go.gain.value = S.ab === "orig" ? 1 : 0; gr.gain.value = S.ab === "rebass" ? 1 : 0;
  so.connect(go).connect(S.an); sr.connect(gr).connect(S.an);
  const t = ctx.currentTime + 0.04;
  at = Math.max(0, Math.min(at, S.outBuf.duration - 0.05));
  so.start(t, at); sr.start(t, at);
  S.pl = { so, sr, go, gr, t0: t - at };
  sr.onended = () => { if (S.pl && S.pl.sr === sr) { S.pausedAt = 0; stopPreview(); } };
  setPlayIcon(true);
}
function stopPreview(keepPos) {
  if (!S.pl) return;
  if (keepPos) S.pausedAt = curTime();
  const { so, sr } = S.pl;
  S.pl = null;
  try { so.stop(); sr.stop(); } catch {}
  setPlayIcon(false);
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
const F0 = 10, F1 = 250;
const xOf = (f, w) => ((Math.log(f) - Math.log(F0)) / (Math.log(F1) - Math.log(F0))) * w;

function frameAt(t) {
  const r = S.res; if (!r) return null;
  const i = Math.round((t - r.t0) / r.hop);
  if (i < 0 || i * 3 + 2 >= r.map.length) return null;
  return { fo: r.map[i * 3], fn: r.map[i * 3 + 1], e: r.map[i * 3 + 2] };
}

function drawSpec() {
  const c = $("rb-spec"), { g, w, h } = sizeCanvas(c);
  g.clearRect(0, 0, w, h);
  const yOf = (db) => h - 18 - ((db + 100) / 100) * (h - 30);
  // grid
  g.font = "600 10px Inter, system-ui, sans-serif"; g.textAlign = "center";
  for (const f of [10, 20, 30, 40, 60, 80, 100, 150, 200]) {
    const x = xOf(f, w); g.strokeStyle = "rgba(190,196,255,0.08)"; g.beginPath(); g.moveTo(x, 8); g.lineTo(x, h - 18); g.stroke();
    g.fillStyle = "rgba(190,196,255,0.45)"; g.fillText(f >= 100 ? `${f}` : `${f}`, Math.min(w - 10, Math.max(10, x)), h - 5);
  }
  g.textAlign = "left";
  for (const db of [-20, -40, -60, -80]) { const y = yOf(db); g.strokeStyle = "rgba(190,196,255,0.06)"; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.fillStyle = "rgba(190,196,255,0.35)"; g.fillText(`${db}`, 4, y - 3); }
  // the chosen range
  const p = S.params, xa = xOf(p.lo, w), xb = xOf(p.hi, w);
  g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(xa, 8, xb - xa, h - 26);
  // the whole song's low end, live
  const ctx = getCtx(), playing = !!S.pl;
  if (playing && S.an) {
    S.an.getFloatFrequencyData(S.spec);
    const binHz = ctx.sampleRate / S.an.fftSize;
    g.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const f = F0 * Math.pow(F1 / F0, x / w), k = f / binHz, k0 = Math.floor(k), u = k - k0;
      const v = (S.spec[k0] ?? -120) * (1 - u) + (S.spec[k0 + 1] ?? -120) * u;
      const y = yOf(Math.max(-100, v + 6));
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.strokeStyle = "rgba(159,179,255,0.85)"; g.lineWidth = 1.6; g.stroke();
  }
  // the bass being added right now: one clean sine, drawn as its peak, with a short trail of the last moments
  const t = curTime(), fr = frameAt(t), A = S.res ? S.res.stats.bassGain : 0;
  let now = null;
  if (fr && fr.fn > 0 && fr.e > 0.05) now = { f: fr.fn, db: linToDb(A * fr.e) };
  if (playing) { S.trail.push(now); if (S.trail.length > 40) S.trail.shift(); }
  const peak = (pt, alpha) => {
    const x = xOf(pt.f, w), y = yOf(pt.db), base = h - 18;
    const grd = g.createLinearGradient(0, y, 0, base);
    grd.addColorStop(0, `rgba(178,92,255,${0.75 * alpha})`); grd.addColorStop(1, `rgba(61,123,255,${0.05 * alpha})`);
    g.beginPath(); g.moveTo(x - 26, base);
    for (let dx = -26; dx <= 26; dx += 2) g.lineTo(x + dx, base - (base - y) * Math.exp(-(dx * dx) / 60));
    g.closePath(); g.fillStyle = grd; g.fill();
  };
  S.trail.forEach((pt, i) => { if (pt) peak(pt, ((i + 1) / S.trail.length) * 0.25); });
  if (now) {
    peak(now, S.ab === "rebass" ? 1 : 0.4);
    const x = xOf(now.f, w), y = yOf(now.db);
    g.fillStyle = "#fff"; g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
  }
  $("rb-now-f").textContent = now ? `${now.f.toFixed(1)} Hz` : "–";
  $("rb-now-n").textContent = now ? noteName(now.f).split(" ")[0] : "–";
  $("rb-now-l").textContent = now ? `${now.db.toFixed(1)} dB` : "–";
}

function mapRange() { const s = S.res.stats; return [12, Math.max(130, s.songHi * 1.2, S.params.hi * 1.4)]; }
function drawMap() {
  if (!S.res) return;
  const c = $("rb-map"), dpr = Math.min(3, devicePixelRatio || 1), w = c.clientWidth || 300, h = c.clientHeight || 130;
  const off = document.createElement("canvas"); off.width = Math.round(w * dpr); off.height = Math.round(h * dpr);
  const g = off.getContext("2d"); g.scale(dpr, dpr);
  const [y0, y1] = mapRange(), dur = S.outBuf.duration, r = S.res;
  const yOf = (f) => h - 8 - ((Math.log(f) - Math.log(y0)) / (Math.log(y1) - Math.log(y0))) * (h - 16);
  g.font = "600 10px Inter, system-ui, sans-serif";
  for (const f of [20, 40, 80]) { if (f < y0 || f > y1) continue; const y = yOf(f); g.strokeStyle = "rgba(190,196,255,0.07)"; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.fillStyle = "rgba(190,196,255,0.45)"; g.fillText(`${f} Hz`, 4, y - 3); }
  const ya = yOf(S.params.hi), yb = yOf(S.params.lo);
  g.fillStyle = "rgba(255,255,255,0.05)"; g.fillRect(0, ya, w, yb - ya);
  const frames = r.map.length / 3;
  const grd = g.createLinearGradient(0, 0, w, 0); grd.addColorStop(0, "#3d7bff"); grd.addColorStop(0.55, "#7b5cff"); grd.addColorStop(1, "#b25cff");
  for (let i = 0; i < frames; i += 2) {
    const t = r.t0 + i * r.hop, x = (t / dur) * w, e = r.map[i * 3 + 2];
    if (e < 0.05) continue;
    const fo = r.map[i * 3], fn = r.map[i * 3 + 1];
    if (fo > 0 && fo >= y0 && fo <= y1) { g.fillStyle = `rgba(159,179,255,${0.12 + 0.3 * e})`; g.fillRect(x, yOf(fo) - 1, 1.2, 2); }
    if (fn > 0) { g.globalAlpha = 0.25 + 0.75 * e; g.fillStyle = grd; g.fillRect(x, yOf(fn) - 1.5, 1.4, 3); g.globalAlpha = 1; }
  }
  S.mapImg = off;
}
function paintMap() {
  const c = $("rb-map"), { g, w, h } = sizeCanvas(c);
  g.clearRect(0, 0, w, h);
  if (S.mapImg) g.drawImage(S.mapImg, 0, 0, w, h);
  if (S.outBuf) {
    const x = (curTime() / S.outBuf.duration) * w;
    g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - 4); g.stroke();
  }
  $("rb-cur").textContent = fmtTime(curTime());
}
function startGraph() {
  cancelAnimationFrame(S.raf);
  const tick = () => {
    if ($("rb-result").hidden || location.hash !== "#rebass") { S.raf = 0; return; }
    drawSpec(); paintMap();
    S.raf = requestAnimationFrame(tick);
  };
  S.raf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------------------------------- saving and sharing
function paintSize() {
  if (!S.outBuf) return;
  const f = FORMATS[segValue($("rb-format"))];
  $("rb-size").textContent = `About ${sizeText(S.outBuf.duration * f.bytesPerSec(S.outBuf.sampleRate))} · ${S.outBuf.sampleRate / 1000} kHz stereo`;
}
async function buildFile() {
  const fmt = segValue($("rb-format")), name = $("rb-name").value.trim() || defaultName();
  const key = `${S.version}|${fmt}`;
  if (!S.file || S.fileKey !== key) {
    toast(fmt === "mp3" ? "Making the MP3…" : "Making the file…", 60000);
    const chs = [S.outBuf.getChannelData(0), S.outBuf.getChannelData(1)];
    const { file } = await makeFile(chs, S.outBuf.sampleRate, name, fmt, getCtx());
    S.file = file; S.fileKey = key;
  }
  const want = `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "FifTeam Media"}.${S.file.name.split(".").pop()}`;
  if (S.file.name !== want) S.file = new File([S.file], want, { type: S.file.type });
  return S.file;
}
async function save() {
  if (!S.outBuf) return;
  try {
    const fresh = !S.file || S.fileKey !== `${S.version}|${segValue($("rb-format"))}`;
    const file = await buildFile();
    if (isIOS() && fresh) { toast("Ready. Tap Save again, then choose Save to Files."); return; }
    if (isIOS()) toast("Choose Save to Files to keep it on your iPhone", 5000);
    const r = await saveFile(file);
    if (r === "saved") toast("Saved");
    else if (r === "downloaded") toast(`Saved to your Downloads as ${file.name}`, 5000);
  } catch (e) { toast("Couldn't save the file. " + (e.message || "")); }
}
async function share() {
  if (!S.outBuf) return;
  try {
    const fresh = !S.file || S.fileKey !== `${S.version}|${segValue($("rb-format"))}`;
    const file = await buildFile();
    if (!canShareFiles(file)) { toast("This browser can't share files. Saving it instead."); await saveFile(file); return; }
    if (fresh) { toast("Your file is ready. Tap Share again to send it."); return; }
    const r = await shareFile(file, $("rb-name").value.trim() || defaultName());
    if (r === "failed") toast("Sharing didn't go through. Try Save to phone.");
  } catch (e) { toast("Couldn't share the file. " + (e.message || "")); }
}
async function keep() {
  if (!S.outBuf) return;
  const name = $("rb-name").value.trim() || defaultName();
  toast("Adding to your library…", 60000);
  const chs = [S.outBuf.getChannelData(0), S.outBuf.getChannelData(1)];
  const fmt = segValue($("rb-format")) === "mp3" ? "mp3" : "wav16";
  const { file } = await makeFile(chs, S.outBuf.sampleRate, name, fmt, getCtx());
  const p = S.params;
  const meta = {
    id: store.newId(), kind: "rebass", title: name, artist: S.src.artist || "", album: "Rebassed",
    note: `${p.lo}–${p.hi} Hz · ${p.db === 0 ? "0" : "−" + Math.abs(p.db)} dB`, duration: S.outBuf.duration, size: file.size, type: file.type,
    fileName: file.name, added: Date.now(), hasArt: !!S.src.art,
  };
  try { await library.add(meta, file, S.src.art || null); toast("Added to your library, under Rebassed"); }
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
  onSeg($("rb-mode"), () => { paintRange(); settingsChanged(); });
  $("rb-db").addEventListener("input", () => { paintDb(); settingsChanged(); });
  $("rb-replace").onchange = settingsChanged; $("rb-snap").onchange = settingsChanged;
  $("rb-name").addEventListener("input", () => { S.nameEdited = true; });
  onSeg($("rb-ab"), setAB);
  onSeg($("rb-format"), () => paintSize());
  $("rb-play").onclick = () => { getCtx(); if (S.pl) stopPreview(true); else playPreview(S.pausedAt || 0); };
  const seekMap = (e) => {
    if (!S.outBuf) return;
    const r = $("rb-map").getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.outBuf.duration;
    if (S.pl) playPreview(t); else { S.pausedAt = t; }
  };
  $("rb-map").addEventListener("pointerdown", seekMap);
  $("rb-save").onclick = save; $("rb-share").onclick = share; $("rb-keep").onclick = keep;
  bus.on("rebass", (t) => { location.hash = "#rebass"; fromTrack(t); });
  bus.on("view", (v) => { if (v !== "rebass") stopPreview(true); else if (S.res) startGraph(); });
  bus.on("music-playing", () => stopPreview(true));
  addEventListener("resize", () => { if (S.res) drawMap(); });
  paintRange(); paintDb(); readParams();
}

export const rebass = { fromFile: async (f) => {
  const { readTags } = await import("./tags.js");
  const tags = await readTags(f);
  setSource({ title: tags.title, artist: tags.artist, blob: f, cover: tags.art ? URL.createObjectURL(tags.art) : null, art: tags.art });
} };
