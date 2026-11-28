// The Rebass screen: choose a song, set the range and level (and, if wanted, slow it down), let the worker find the bass
// line and build the new bass, listen with a live graph of the bass being added, then name it, give it a cover, and save
// it, share it, or keep it in the library.
import { $, toast, openSheet, closeSheet, fmtTime, fill, getCtx, artUrl, placeholderArt, bus, onSeg, segValue } from "./ui.js";
import * as store from "./store.js";
import { library } from "./library.js";
import { player } from "./player.js";
import { FORMATS, makeFile, saveFile, sizeText, isIOS, fitFormat } from "./export.js";
import { openShareSheet, fingerprint } from "./share.js";
import { noteName, linToDb } from "./dsp.js";
import { pickImage } from "./image.js";
import { rebassAllowed, noteRebass, openUnlock, downloadAllowed, noteDownload, premiumNow, requirePremium } from "./premium.js";
import * as myIntro from "./myintro.js";
import { noteEditor } from "./notes.js";

const S = {
  src: null, worker: null, loaded: false, origBuf: null, refBuf: null, refKey: "", outBuf: null, res: null, version: 0,
  busy: false, again: false, params: { lo: 25, hi: 45, db: -5, speed: 1, reverb: false },
  pl: null, ab: "rebass", an: null, spec: null, raf: 0, nameEdited: false, file: null, fileKey: "",
  cover: null, coverUrl: null, segs: [], ovImg: null, disp: null, pk: null, glow: [], lastT: 0, lastRead: 0, drag: null,
  introN: 0, scrubT: null, bg: {},
  // Auto bass, or Custom notes (the bass placed by hand: its editor, the song's own bass line to go by, the notes)
  how: "auto", guide: null, ed: null, custom: [],
};
try { if (localStorage.getItem("fifteam-rebass-how") === "custom") S.how = "custom"; } catch {}

// ---------------------------------------------------------------------------------------------------- the intro
// The FifTeam Production tag (media/intro.wav), or (Premium) the user's own recorded intro, slowed and pitched as they
// like (myintro.js), put before the song when the Intro switch is on. Brought up to the song's level (its loudest
// moment at −1 dBFS), so it doesn't sound small next to a mastered rebass.
const INTRO_KEY = "fifteam-intro";
let introBuf = null, introLoading = null, myBuf = null;
/** Whether the user's own intro is the one (chosen, and Premium). */
const useMine = () => myIntro.settings().src === "mine" && premiumNow();
/** The intro going before the song now (null if it isn't ready). */
const activeIntro = () => (useMine() ? myBuf : introBuf);
const myKey = () => { const t = myIntro.settings(); return `${t.speed}|${t.pitch}`; };
async function loadIntro(rate = SONG_RATE) {
  if (!useMine()) return loadTag(rate);
  if (myBuf && myBuf.sampleRate === rate && myBuf.key === myKey()) return myBuf;
  const b = await myIntro.makeIntro(getCtx(), rate, myIntro.settings());
  if (!b) { const e = new Error("norec"); throw e; }
  b.key = myKey(); myBuf = b;
  return b;
}
function loadTag(rate = SONG_RATE) {
  if (introBuf && introBuf.sampleRate === rate) return Promise.resolve(introBuf);
  if (!introLoading) introLoading = (async () => {
    const ctx = getCtx();
    const res = await fetch(new URL("../media/intro.wav", import.meta.url));
    if (!res.ok) throw new Error("intro");
    const b = await decodeAt(await res.arrayBuffer(), rate);
    let pk = 0;
    for (let c = 0; c < b.numberOfChannels; c++) { const x = b.getChannelData(c); for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > pk) pk = a; } }
    const g = pk > 0 ? Math.pow(10, -1 / 20) / pk : 1, out = ctx.createBuffer(2, b.length, b.sampleRate);
    for (let c = 0; c < 2; c++) { const x = b.getChannelData(Math.min(c, b.numberOfChannels - 1)), y = out.getChannelData(c); for (let i = 0; i < x.length; i++) y[i] = x[i] * g; }
    introBuf = out;
    return out;
  })().finally(() => { introLoading = null; });
  return introLoading;
}
const introWanted = () => $("rb-intro").checked;
const SONG_RATE = 44100;
/** Audio decoded at `rate` (an offline context decodes at its own rate), or at the phone's if that can't be done. */
async function decodeAt(bytes, rate) {
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (Off) { try { return await new Off(2, 1, rate).decodeAudioData(bytes.slice(0)); } catch {} }
  return await getCtx().decodeAudioData(bytes);
}

// ---------------------------------------------------------------------------------------------------- not running out of memory
// A rebass that took the whole page down (a phone that ran out of memory: on an iPhone, Safari's "a problem repeatedly
// occurred") leaves its mark behind; the next time, that phone uses the lighter rebass, so it can't happen again.
const BUSY_KEY = "fifteam-rebass-busy", LIGHT_KEY = "fifteam-rebass-light";
let light = false;
try {
  if (localStorage.getItem(BUSY_KEY)) { localStorage.setItem(LIGHT_KEY, "1"); localStorage.removeItem(BUSY_KEY); }
  light = localStorage.getItem(LIGHT_KEY) === "1";
} catch {}
/** The lighter rebass, if this phone ran out of memory with the full one: a new version of the app (told here when it
 * starts) tries the full one again, as it may well fit now. */
export function checkLight(version) {
  try {
    const was = localStorage.getItem(LIGHT_KEY + "-v");
    if (!light) { localStorage.removeItem(LIGHT_KEY + "-v"); return; }
    if (!was) localStorage.setItem(LIGHT_KEY + "-v", version);
    else if (was !== version) { localStorage.removeItem(LIGHT_KEY); localStorage.removeItem(LIGHT_KEY + "-v"); light = false; }
  } catch {}
}
const busyMark = (on) => { try { on ? localStorage.setItem(BUSY_KEY, String(Date.now())) : localStorage.removeItem(BUSY_KEY); } catch {} };
/** The rebass as heard and saved: the intro (if it's on and ready) and then the song. Returns { ob, k } (k: intro samples). */
function compose(L, R, sr) {
  const ib = activeIntro(), ctx = getCtx(), k = introWanted() && ib && ib.sampleRate === sr ? ib.length : 0;
  const ob = ctx.createBuffer(2, k + L.length, sr);
  if (k) { ob.copyToChannel(ib.getChannelData(0), 0); ob.copyToChannel(ib.getChannelData(1), 1); }
  ob.copyToChannel(L, 0, k); ob.copyToChannel(R, 1, k);
  return { ob, k };
}
/** The switch moved: the rebass rebuilt with or without the intro, right away (no need to rebass again). */
async function introChanged(force = false) {
  try { localStorage.setItem(INTRO_KEY, introWanted() ? "1" : "0"); } catch {}
  paintIntroBox();
  if (introWanted()) {
    try { await loadIntro(S.origBuf ? S.origBuf.sampleRate : SONG_RATE); }
    catch (e) {
      if (e.message === "norec") { if (!S.outBuf) return; toast("Record your intro first", 2500); }
      else { $("rb-intro").checked = false; paintIntroBox(); toast("Couldn't load the intro. Are you online?"); return; }
    }
  }
  if (!S.outBuf || S.busy) return;                       // (a rebass under way puts it in when it's done)
  const sr = S.outBuf.sampleRate, old = S.introN, ib = activeIntro();
  if (!force && (introWanted() && ib ? ib.length : 0) === old) return;
  const wasPlaying = !!S.pl, at = curTime() - old / sr;
  stopPreview();
  const { ob, k } = compose(S.outBuf.getChannelData(0).subarray(old), S.outBuf.getChannelData(1).subarray(old), sr);
  S.outBuf = ob; S.introN = k; S.res.t0 += (k - old) / sr;
  S.version++; S.file = null;
  $("rb-dur").textContent = fmtTime(ob.duration);
  buildSegments(); drawOverview(); paintSize();
  S.pausedAt = Math.max(0, at < 0 ? 0 : at + k / sr);
  if (wasPlaying) playPreview(S.pausedAt); else kickGraph();
}

/** Under the Intro switch: FifTeam's tag or My own (Premium); my own: record it (up to 15 s), slow it, pitch it, hear it. */
function buildIntroBox() {
  const sw = $("rb-intro").closest("label"), box = document.createElement("div");
  box.className = "stack rb-introbox"; box.id = "rb-intro-box";
  const h = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const seg = h("div", "seg"); seg.id = "rb-intro-src";
  for (const [k, t] of [["tag", "FifTeam"], ["mine", "My own"]]) { const b = h("button", "", t); b.type = "button"; b.dataset.k = k; seg.append(b); }
  const mine = h("div", "stack-sm rb-myintro"); mine.id = "rb-myintro";
  const rec = h("button", "btn block rb-rec", "Record my intro"); rec.type = "button"; rec.id = "rb-rec";
  const st = h("span", "status", ""); st.id = "rb-rec-st";
  const slider = (id, label, min, max, step, val, fmt) => {
    const w = h("div", "stack-sm"), top = h("div", "row between"), v = h("span", "val", fmt(val)), r = h("input"); r.type = "range"; r.id = id; r.min = min; r.max = max; r.step = step; r.value = val; r.setAttribute("aria-label", label);
    top.append(h("span", "label", label), v); w.append(top, r); r.oninput = () => { v.textContent = fmt(+r.value); }; return { w, r };
  };
  const t = myIntro.settings();
  const slow = slider("rb-my-speed", "Slow it", 50, 100, 1, Math.round(t.speed * 100), (x) => (x >= 100 ? "Normal" : `${x}%`));
  const pitch = slider("rb-my-pitch", "Pitch", -12, 12, 1, t.pitch, (x) => (x === 0 ? "Normal" : `${x > 0 ? "+" : ""}${x} semitone${Math.abs(x) === 1 ? "" : "s"}`));
  const row = h("div", "row wrap"), hear = h("button", "btn small", "Hear it"), del = h("button", "btn small", "Delete"); hear.type = del.type = "button";
  row.append(hear, del);
  mine.append(rec, st, slow.w, pitch.w, row, h("small", "status", "Your voice before every song you rebass with the intro on: saved, posted and sent with it. Only on this phone."));
  box.append(seg, mine);
  sw.after(box);
  // which intro
  seg.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.k === "mine" && !requirePremium("intro")) return;
    myIntro.saveSettings({ src: b.dataset.k }); introChanged(true);
  };
  // recording
  let r = null;
  rec.onclick = async () => {
    if (!requirePremium("intro")) return;
    if (r && r.on) { rec.disabled = true; await r.stop(); rec.disabled = false; rec.classList.remove("rec-on"); r = null; myBuf = null; paintIntroBox(); st.textContent = "Recorded. Slow it or pitch it, then Hear it."; if (introWanted() && useMine()) introChanged(true); return; }
    try {
      r = myIntro.recorder((s) => { st.textContent = `Recording… ${s.toFixed(1)} s (up to 15)`; });
      await r.start();
      rec.textContent = "Stop"; rec.classList.add("rec-on");
    } catch { r = null; toast("Couldn't use the microphone. Allow it in your phone's settings for this app.", 4000); }
  };
  const changed = () => { myIntro.saveSettings({ speed: +slow.r.value / 100, pitch: +pitch.r.value }); myBuf = null; if (introWanted() && useMine()) introChanged(true); };
  slow.r.onchange = changed; pitch.r.onchange = changed;
  let au = null;
  hear.onclick = async () => {
    try {
      const b = await myIntro.makeIntro(getCtx(), getCtx().sampleRate, myIntro.settings());
      if (!b) { toast("Record your intro first"); return; }
      if (au) try { au.stop(); } catch {}
      au = getCtx().createBufferSource(); au.buffer = b; au.connect(getCtx().destination); au.start();
    } catch { toast("Couldn't play the intro."); }
  };
  del.onclick = async () => { if (!confirm("Delete your intro recording?")) return; await myIntro.forget(); myBuf = null; st.textContent = ""; paintIntroBox(); if (introWanted() && useMine()) introChanged(true); };
  addEventListener("fifteam-premium", () => paintIntroBox());
  paintIntroBox();
}
async function paintIntroBox() {
  const box = $("rb-intro-box"); if (!box) return;
  box.hidden = !introWanted();
  const src = myIntro.settings().src === "mine" && premiumNow() ? "mine" : "tag";
  box.querySelectorAll("#rb-intro-src button").forEach((b) => {
    b.classList.toggle("on", b.dataset.k === src);
    if (b.dataset.k === "mine" && !premiumNow() && !b.querySelector(".pm-lock")) { const l = document.createElement("span"); l.className = "pm-lock"; l.innerHTML = '<svg><use href="#i-lock"/></svg>'; b.append(l); }
    if (b.dataset.k === "mine" && premiumNow()) b.querySelector(".pm-lock")?.remove();
  });
  $("rb-myintro").hidden = src !== "mine";
  const has = !!(await myIntro.recording()), rec = $("rb-rec");
  if (rec && !rec.classList.contains("rec-on")) rec.textContent = has ? "Record it again" : "Record my intro";
}

// ---------------------------------------------------------------------------------------------------- choosing a song
async function setSource(src) {
  stopPreview();
  if (S.worker) { S.worker.terminate(); S.worker = null; }
  S.src = src; S.loaded = false; S.origBuf = null; S.refBuf = null; S.refKey = ""; S.outBuf = null; S.res = null; S.file = null; S.nameEdited = false;
  S.guide = null; S.ed = null; S.custom = loadNotes(src); paintHow();
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
    // either handle can be the higher one, and both can sit on the same frequency (the whole bass on one note)
    ...range(), db: +$("rb-db").value,
    speed: slow ? +$("rb-speed").value / 100 : 1, reverb: $("rb-reverb").checked,
    ...(S.how === "custom" ? { custom: S.custom } : {}),
  };
}
/** The range the two handles mark: the lower of the two to the higher. */
function range() { const a = +$("rb-lo").value, b = +$("rb-hi").value; return { lo: Math.min(a, b), hi: Math.max(a, b) }; }
export const hzText = (lo, hi) => (lo === hi ? `${lo}` : `${lo}–${hi}`);
function paintRange() {
  const r = range(), min = +$("rb-lo").min, max = +$("rb-lo").max;
  const a = ((r.lo - min) / (max - min)) * 100, b = ((r.hi - min) / (max - min)) * 100;
  $("rb-fill").style.left = `calc(${a}% + ${11 - a * 0.22}px)`;
  $("rb-fill").style.width = `calc(${b - a}% - ${(b - a) * 0.22}px)`;
  $("rb-range-val").innerHTML = `${hzText(r.lo, r.hi)}<small>Hz</small>`;
  document.querySelectorAll("#rb-presets .chip").forEach((c) => c.classList.toggle("on", c.dataset.r === `${r.lo},${r.hi}`));
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
  if (p.custom) return `${S.src.title} (${slow}Custom bass ${db}dB)`;
  return `${S.src.title} (${slow}Rebass ${p.lo === p.hi ? p.lo : `${p.lo}-${p.hi}`}Hz ${db}dB)`;
}
let reT = 0;
function settingsChanged() {
  readParams();
  if (!S.nameEdited) $("rb-name").value = defaultName();
  if (S.res) kickGraph();
  if (S.loaded) { clearTimeout(reT); reT = setTimeout(render, 350); }
}

// ---------------------------------------------------------------------------------------------------- the work
const STAGES = {
  decode: ["Reading the song", 0, 0.03], model: ["Getting ready (first time only)", 0.03, 0.25],
  start: ["Getting ready", 0.25, 0.3], separate: ["Rebassing", 0.3, 0.8],
  find: ["Rebassing", 0.8, 0.85], clean: ["Rebassing", 0.85, 0.88],
  slow: ["Slowing it down", 0.88, 0.92], verb: ["Adding reverb", 0.92, 0.94],
  build: ["Rebassing", 0.94, 0.97], master: ["Finishing", 0.97, 1],
};
// (painted at most once a frame, and only what changed: the bar moves on the compositor, no layout)
let progQ = null, progRaf = 0;
const shown = { stage: "", pct: "", quick: null };
function progress(stage, p, left) {
  progQ = [stage, p, left];
  if (!progRaf) progRaf = requestAnimationFrame(paintProgress);
}
function paintProgress() {
  progRaf = 0;
  const [stage, p, left] = progQ;
  const [label, a, b] = STAGES[stage];
  const v = a + (b - a) * Math.max(0, Math.min(1, p));
  const eta = left > 3 ? ` · ${left > 90 ? `about ${Math.round(left / 60)} min` : `${Math.round(left / 5) * 5} s`} left` : "";
  const st = label + eta, pct = `${Math.round(v * 100)}%`;
  if (st !== shown.stage) $("rb-stage").textContent = shown.stage = st;
  if (pct !== shown.pct) $("rb-pct").textContent = shown.pct = pct;
  $("rb-bar").style.transform = `scaleX(${v.toFixed(4)})`;
  // a phone that can only use its processor may take a while: the old quick way is there instead
  const q = !(stage === "separate" && left > 150);
  if (q !== shown.quick) $("rb-quick").hidden = shown.quick = q;
}

/** Which song this is (for the hourly count, and for keeping its custom notes). */
const keyOf = (src) => src.id || `${src.title || src.name || ""}|${(src.blob && src.blob.size) || 0}`;
async function go() {
  if (!S.src || S.busy) return;
  // (free accounts: 10 different songs an hour; the same song again doesn't count again)
  const songKey = keyOf(S.src);
  if (!rebassAllowed(songKey)) { openUnlock(); return; }
  S.countKey = songKey;
  readParams();
  if (introWanted()) loadIntro().catch(() => {});
  if (!S.loaded) {
    S.busy = true; $("rb-go").disabled = true; $("rb-busy").hidden = false;
    busyMark(true);
    try {
      progress("decode", 0);
      getCtx();
      // the file read once: its fingerprint (its separated bass is kept on the phone under it), then the audio
      const bytes = await S.src.blob.arrayBuffer();
      let key = "";
      try { if (!S.src.hash) { const hsh = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); S.src.hash = Array.from(hsh.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join(""); } key = S.src.hash; } catch {}
      const buf = await decodeAt(bytes, SONG_RATE);
      if (buf.duration > 20 * 60) throw new Error("That song is over 20 minutes long. Pick a shorter one.");
      S.origBuf = buf;
      if (!S.src.duration) { S.src.duration = buf.duration; paintSlow(); }
      if (introWanted()) loadIntro(buf.sampleRate).catch(() => {});
      progress("decode", 1);
      const chs = [buf.getChannelData(0).slice(), (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice()];
      S.worker = new Worker(new URL("./rebass-worker.js", import.meta.url), { type: "module" });
      S.worker.onmessage = onWorker;
      S.worker.onerror = (e) => fail(e.message || "The rebass stopped unexpectedly.");
      await new Promise((res, rej) => {
        S._loaded = res; S._failed = rej;
        // (an iPhone: the separator only on its graphics chip; otherwise the lighter rebass, as the processor's way needs
        // more memory than Safari gives a page)
        S.worker.postMessage({ type: "load", chs, sr: buf.sampleRate, key, quick: light, gpuOnly: isIOS() }, chs.map((c) => c.buffer));
      });
      S.loaded = true;
    } catch (e) {
      S.busy = false; $("rb-go").disabled = false; $("rb-busy").hidden = true;
      busyMark(false);
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
  busyMark(true);
  S.worker.postMessage({ type: "render", params: S.params });
}

function fail(msg) {
  busyMark(false);
  S.busy = false; $("rb-go").disabled = !S.src; $("rb-busy").hidden = true;
  if (S._failed) { S._failed(new Error(msg)); S._failed = null; }
  toast(msg);
}

function onWorker(e) {
  const m = e.data;
  if (m.type === "progress") progress(m.stage, m.p, m.left);
  else if (m.type === "analysis") {
    $("rb-quick").hidden = true;
    S.mode = m.mode; S.guide = m.guide || null;
    if (m.mode === "quick" && m.why && !/cancelled|no-gpu/.test(m.why)) toast("Rebassed the quick way this time.");
    if (S._loaded) { S._loaded(); S._loaded = null; }
  }
  else if (m.type === "error") fail(m.message);
  else if (m.type === "notes") {
    if (!S.ed) return;
    if (!m.list.length) { toast("No bass notes were found in this song."); return; }
    S.ed.set(m.list); toast(`${m.list.length} notes from the song. Move, add or delete any of them.`, 2800);
  }
  else if (m.type === "result") {
    busyMark(false);
    const ctx = getCtx(), sr = S.origBuf.sampleRate;
    const wasPlaying = !!S.pl, frac = S.outBuf ? curTime() / S.outBuf.duration : 0;
    stopPreview();
    const { ob, k } = compose(m.out[0], m.out[1], sr);
    S.outBuf = ob; S.introN = k;
    // what "Original" plays: the slowed (or reverbed) song without the new bass, or the song itself
    if (m.ref) { const rb = ctx.createBuffer(2, m.ref[0].length, sr); rb.copyToChannel(m.ref[0], 0); rb.copyToChannel(m.ref[1], 1); S.refBuf = rb; }
    S.refKey = m.refKey;
    if (!m.refKey) S.refBuf = null;
    S.res = { stats: m.stats, map: m.map, t0: m.t0 + k / sr, hop: m.hop };
    S.version++; S.file = null;
    S.busy = false;
    if (S.countKey) noteRebass(S.countKey);
    $("rb-busy").hidden = true; $("rb-go").disabled = false;
    $("rb-go").innerHTML = '<svg><use href="#i-bass"/></svg>Rebass again';
    $("rb-result").hidden = false; $("rb-export").hidden = false;
    $("rb-dur").textContent = fmtTime(ob.duration);
    S.pausedAt = Math.min(frac * ob.duration, ob.duration);
    buildSegments(); drawOverview(); paintStats(); paintSize();
    if (S.how === "custom") makeEditor();
    S.pk = null; S.glow = []; S.disp = null;
    kickGraph();
    if (wasPlaying) playPreview(S.pausedAt);
    if (S.again) render();
  }
}

function paintStats() {
  const s = S.res.stats;
  const f1 = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  if (s.custom) { $("rb-stats").innerHTML = [["", s.notes.toLocaleString(), "Your notes"], ["", s.notes ? `${f1(s.newLo)}–${f1(s.newHi)} Hz` : "–", "New bass"]].map(([c, b, t]) => `<div class="stat ${c}"><b>${b}</b><span>${t}</span></div>`).join(""); return; }
  const items = [["", s.notes.toLocaleString(), "Bass notes"], ["", `${f1(s.songLo)}–${f1(s.songHi)} Hz`, "Old bass"]];
  $("rb-stats").innerHTML = items.map(([c, b, t]) => `<div class="stat ${c}"><b>${b}</b><span>${t}</span></div>`).join("");
}

// ---------------------------------------------------------------------------------------------------- custom notes
// Each song's notes are kept on the phone (under the song), so they're there the next time it's opened.
const NOTES = "fifteam-notes:";
function loadNotes(src) { try { const l = JSON.parse(localStorage.getItem(NOTES + keyOf(src)) || "[]"); return Array.isArray(l) ? l.filter((n) => n && n.d > 0 && n.f > 0 && n.t >= 0) : []; } catch { return []; } }
function saveNotes() { if (!S.src) return; try { if (S.custom.length) localStorage.setItem(NOTES + keyOf(S.src), JSON.stringify(S.custom.map((n) => ({ t: n.t, d: n.d, f: +n.f.toFixed(3), v: n.v })))); else localStorage.removeItem(NOTES + keyOf(S.src)); } catch {} }
/** The play position on the song's own timeline (seconds; the intro and slowing taken off). */
function songTime() {
  if (!S.outBuf) return null;
  const off = S.introN / S.outBuf.sampleRate;
  return Math.max(0, (curTime() - off) * (S.params.speed || 1));
}
/** Auto bass or Custom notes: what shows, and the button's words. */
function paintHow() {
  const custom = S.how === "custom";
  document.querySelectorAll("#rb-how button").forEach((b) => { b.classList.toggle("on", b.dataset.k === S.how); b.setAttribute("aria-selected", String(b.dataset.k === S.how)); });
  $("rb-range-card").hidden = custom;
  $("rb-notes").hidden = !custom;
  const ready = custom && S.loaded && S.guide && S.origBuf;
  $("rb-ne").hidden = $("rb-ne-tools").hidden = !ready;
  if (!ready) $("rb-ne-sel").hidden = true;
  $("rb-ne-hint").textContent = ready ? "Tap the grid to place a note. Drag a note to move it, drag its right edge to make it longer, drag the grid to move along the song, pinch to zoom. Tap the time strip to play from there."
    : "Pick a song and tap Take the bass out. Then place your own notes, one by one, over the song.";
  if (!S.loaded && !S.busy) $("rb-go").innerHTML = custom ? '<svg><use href="#i-bass"/></svg>Take the bass out' : '<svg><use href="#i-bass"/></svg>Rebass it';
  paintNe();
}
function paintNe() {
  if (!$("rb-ne-count")) return;
  const n = S.custom.length;
  $("rb-ne-count").textContent = n ? `${n} note${n === 1 ? "" : "s"}` : "No notes yet";
  $("rb-ne-undo").disabled = !(S.ed && S.ed.canUndo());
  $("rb-ne-clear").disabled = !n;
}
function paintSel(n) {
  const box = $("rb-ne-sel");
  box.hidden = !n;
  if (n) $("rb-ne-what").textContent = `${n.f.toFixed(1)} Hz · ${n.d.toFixed(2)} s long`;
}
/** The editor, once the song's bass is out (made again for a new song). */
function makeEditor() {
  if (S.ed || S.how !== "custom" || !S.loaded || !S.guide || !S.origBuf) { paintHow(); return; }
  $("rb-ne").hidden = false;
  S.ed = noteEditor($("rb-ne"), {
    duration: S.origBuf.duration, guide: S.guide, notes: S.custom, lowHz: 18, highHz: 125,
    playhead: () => (S.outBuf ? songTime() : null),
    seek: (u) => { if (!S.outBuf) return; getCtx(); const t = S.introN / S.outBuf.sampleRate + u / (S.params.speed || 1); if (S.pl) seekTo(t); else playPreview(t); },
    onChange: (list) => { S.custom = list; saveNotes(); paintNe(); settingsChanged(); },
    onSelect: paintSel,
  });
  paintHow();
}
function setHow(k) {
  if (k === S.how) return;
  S.how = k;
  try { localStorage.setItem("fifteam-rebass-how", k); } catch {}
  paintHow();
  if (k === "custom") makeEditor();
  if (S.loaded) settingsChanged();
}

// ---------------------------------------------------------------------------------------------------- listening
function curTime() {
  if (S.scrubT != null) return S.scrubT;                 // a finger moving through the song
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
  // with the intro on, the original starts after it (and "Original" plays the intro too, so A/B stays in step)
  const off = S.introN / S.outBuf.sampleRate;
  let si = null;
  if (off > 0 && at < off && introBuf) { si = ctx.createBufferSource(); si.buffer = introBuf; si.connect(go); si.start(t, at); }
  if (at >= off) { if (at - off < so.buffer.duration) so.start(t, at - off); }
  else so.start(t + (off - at), 0);
  sr.start(t, at);
  S.pl = { so, sr, si, go, gr, t0: t - at };
  sr.onended = () => { if (S.pl && S.pl.sr === sr) { S.pausedAt = 0; stopPreview(); } };
  setPlayIcon(true);
  kickGraph();
}
function stopPreview(keepPos) {
  if (!S.pl) return;
  if (keepPos) S.pausedAt = curTime();
  const { so, sr, si } = S.pl;
  S.pl = null;
  for (const n of [so, sr, si]) if (n) try { n.stop(); } catch {}
  setPlayIcon(false);
  kickGraph();                                           // (the graphs settle, then stop drawing)
}
function seekTo(t) {
  t = Math.max(0, Math.min(S.outBuf.duration, t));
  if (S.pl) playPreview(t); else { S.pausedAt = t; kickGraph(); }
}
function setPlayIcon(on) {
  const ne = $("rb-ne-play"); if (ne) { ne.querySelector("use").setAttribute("href", on ? "#i-pause" : "#i-play"); ne.lastChild.textContent = on ? "Pause" : "Play"; }
  const b = $("rb-play"); b.querySelector("use").setAttribute("href", on ? "#i-pause" : "#i-play"); b.setAttribute("aria-label", on ? "Pause preview" : "Play preview");
}
function setAB(k) {
  S.ab = k;
  if (S.pl) {
    const t = getCtx().currentTime;
    S.pl.go.gain.setTargetAtTime(k === "orig" ? 1 : 0, t, 0.015);
    S.pl.gr.gain.setTargetAtTime(k === "rebass" ? 1 : 0, t, 0.015);
  }
  kickGraph();
}

// ---------------------------------------------------------------------------------------------------- the graphs
// (the graphs are drawn at most 60 times a second and only while something moves: playing, a finger scrubbing, or
// easing to a stop. Their grids are drawn once into layers of their own; no canvas shadows, which are slow on phones.)
function sizeCanvas(c) {
  const dpr = Math.min(2, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h, dpr };
}
/** A layer that changes only with its key (a grid, the note lanes): drawn once into a canvas of its own, then copied. */
function layer(name, key, w, h, dpr, draw) {
  let L = S.bg[name];
  if (!L || L.key !== key) {
    const c = L ? L.c : document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr));
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    draw(g);
    L = S.bg[name] = { c, key };
  }
  return L.c;
}
/** A soft glowing dot behind a bright point. */
function glowDot(g, x, y, r, a) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, `rgba(178,92,255,${(0.8 * a).toFixed(3)})`); gr.addColorStop(1, "rgba(178,92,255,0)");
  g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
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

// the live spectrum: the whole song's low end (smoothed and drawn as a curve) and the bass being added (a glowing peak).
// Returns whether it is still moving.
const F0 = 10, F1 = 250;
const xOf = (f, w) => ((Math.log(f) - Math.log(F0)) / (Math.log(F1) - Math.log(F0))) * w;
function drawSpec(dt) {
  const c = $("rb-spec"), { g, w, h, dpr } = sizeCanvas(c);
  g.clearRect(0, 0, w, h);
  const yOf = (db) => h - 20 - ((db + 100) / 100) * (h - 32);
  const p = S.params;
  g.drawImage(layer("spec", `${w}x${h}@${dpr}|${p.lo},${p.hi}`, w, h, dpr, (b) => {
    b.font = "600 10px Inter, system-ui, sans-serif"; b.textAlign = "center"; b.lineWidth = 1;
    for (const f of [10, 20, 30, 40, 60, 80, 100, 150, 200]) {
      const x = xOf(f, w); b.strokeStyle = "rgba(190,196,255,0.07)"; b.beginPath(); b.moveTo(x, 8); b.lineTo(x, h - 20); b.stroke();
      b.fillStyle = "rgba(190,196,255,0.45)"; b.fillText(`${f}`, Math.min(w - 10, Math.max(10, x)), h - 6);
    }
    b.textAlign = "left";
    for (const db of [-20, -40, -60, -80]) { const y = yOf(db); b.strokeStyle = "rgba(190,196,255,0.05)"; b.beginPath(); b.moveTo(0, y); b.lineTo(w, y); b.stroke(); b.fillStyle = "rgba(190,196,255,0.32)"; b.fillText(`${db}`, 4, y - 3); }
    const xa = xOf(p.lo, w), xb = xOf(p.hi, w);
    const band = b.createLinearGradient(0, 8, 0, h - 20); band.addColorStop(0, "rgba(178,92,255,0.10)"); band.addColorStop(1, "rgba(61,123,255,0.04)");
    b.fillStyle = band; b.fillRect(Math.min(xa, (xa + xb) / 2 - 1.5), 8, Math.max(3, xb - xa), h - 28);   // (one frequency: a thin line)
  }), 0, 0, w, h);
  const playing = !!S.pl;
  let moving = playing;
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
  } else for (let i = 0; i < cols; i++) { S.disp[i] += (-100 - S.disp[i]) * k * 0.5; if (S.disp[i] > -99.5) moving = true; }
  g.beginPath(); g.moveTo(0, yOf(S.disp[0]));
  for (let i = 1; i < cols - 1; i++) { const x = i * 3, y = yOf(S.disp[i]), mx = x + 1.5, my = (y + yOf(S.disp[i + 1])) / 2; g.quadraticCurveTo(x, y, mx, my); }
  const songFill = g.createLinearGradient(0, 8, 0, h - 20); songFill.addColorStop(0, "rgba(159,179,255,0.16)"); songFill.addColorStop(1, "rgba(159,179,255,0)");
  g.strokeStyle = "rgba(159,179,255,0.85)"; g.lineWidth = 1.6; g.stroke();
  g.lineTo(w, h - 20); g.lineTo(0, h - 20); g.closePath(); g.fillStyle = songFill; g.fill();
  // the added bass: one clean sine, so one peak; its place and height eased so it glides from note to note
  const t = curTime(), now = bassAt(t), A = S.res ? S.res.stats.bassGain : 0;
  const tgt = now ? { lf: Math.log(now.f), db: linToDb(A * now.e) } : null;
  if (!S.pk) S.pk = tgt ? { ...tgt } : { lf: Math.log(p.lo), db: -100 };
  const kf = 1 - Math.exp(-dt / 0.035), kd = 1 - Math.exp(-dt / (tgt && tgt.db > S.pk.db ? 0.03 : 0.09));
  if (tgt) S.pk.lf += (tgt.lf - S.pk.lf) * kf;
  const want = tgt ? tgt.db : -100;
  S.pk.db += (want - S.pk.db) * kd;
  if (Math.abs(want - S.pk.db) > 0.05 || (tgt && Math.abs(tgt.lf - S.pk.lf) > 0.001)) moving = true;
  const f = Math.exp(S.pk.lf), x = xOf(f, w), y = yOf(Math.max(-100, S.pk.db)), base = h - 20;
  if (S.pk.db > -95) {
    const alpha = S.ab === "rebass" ? 1 : 0.45;
    // its afterglow: where it has just been
    if (playing || S.scrubT != null) { S.glow.push([x, y]); if (S.glow.length > 18) S.glow.shift(); }
    if (S.glow.length > 2) {
      g.beginPath(); g.moveTo(S.glow[0][0], S.glow[0][1]);
      for (const [gx, gy] of S.glow) g.lineTo(gx, gy);
      g.strokeStyle = `rgba(178,92,255,${0.25 * alpha})`; g.lineWidth = 2; g.stroke();
    }
    const width = 16 + 10 * Math.min(1, (S.pk.db + 60) / 50);
    const fillG = g.createLinearGradient(0, y, 0, base);
    fillG.addColorStop(0, `rgba(178,92,255,${0.85 * alpha})`); fillG.addColorStop(0.6, `rgba(123,92,255,${0.35 * alpha})`); fillG.addColorStop(1, `rgba(61,123,255,${0.04 * alpha})`);
    g.beginPath(); g.moveTo(x - width * 2.2, base);
    for (let dx = -width * 2.2; dx <= width * 2.2; dx += 2) g.lineTo(x + dx, base - (base - y) * Math.exp(-(dx * dx) / (2 * width * width / 4.5)));
    g.lineTo(x + width * 2.2, base); g.closePath(); g.fillStyle = fillG; g.fill();
    glowDot(g, x, y, 15, alpha);
    g.fillStyle = "#fff"; g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
  } else S.glow.length = 0;
  // the numbers, ten times a second (and once more when it all comes to rest)
  if (performance.now() - S.lastRead > 100 || !moving) {
    S.lastRead = performance.now();
    const live = now && S.pk.db > -95;
    const set = (id, v) => { const e = $(id); if (e.textContent !== v) e.textContent = v; };
    set("rb-now-f", live ? `${now.f.toFixed(1)} Hz` : "–");
    set("rb-now-n", live ? noteName(now.f).split(" ")[0] : "–");
    set("rb-now-l", live ? `${S.pk.db.toFixed(1)} dB` : "–");
  }
  return moving;
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
  const c = $("rb-map"), { g, w, h, dpr } = sizeCanvas(c);
  g.clearRect(0, 0, w, h);
  const t = curTime(), tA = t - WIN * AT, sx = w / WIN;
  const [y0, y1] = S.yr, top = 10, bot = h - 18;
  const yOf = (f) => bot - ((Math.log(f) - Math.log(y0)) / (Math.log(y1) - Math.log(y0))) * (bot - top);
  // the note lanes (every semitone faint, each E, A and C brighter and named) and the chosen range: drawn once
  g.drawImage(layer("roll", `${w}x${h}@${dpr}|${y0},${y1}|${S.params.lo},${S.params.hi}`, w, h, dpr, (b) => {
    b.font = "600 10px Inter, system-ui, sans-serif"; b.textBaseline = "middle";
    const m0 = Math.ceil(69 + 12 * Math.log2(y0 / 440)), m1 = Math.floor(69 + 12 * Math.log2(y1 / 440));
    const pxPerSemi = (bot - top) / (12 * Math.log2(y1 / y0));
    for (let m = m0; m <= m1; m++) {
      const f = 440 * Math.pow(2, (m - 69) / 12), y = yOf(f), pc = ((m % 12) + 12) % 12, named = pc === 4 || pc === 9 || pc === 0;
      b.strokeStyle = named ? "rgba(190,196,255,0.10)" : "rgba(190,196,255,0.035)"; b.lineWidth = 1;
      b.beginPath(); b.moveTo(0, y); b.lineTo(w, y); b.stroke();
      if (named && pxPerSemi * 3 > 10 && y > top + 6 && y < bot - 4) { b.fillStyle = "rgba(190,196,255,0.42)"; b.fillText(noteName(f).split(" ")[0], 4, y - 6); }
    }
    const ra = yOf(S.params.hi), rb = yOf(S.params.lo);
    b.fillStyle = "rgba(255,255,255,0.035)"; b.fillRect(0, Math.min(ra, (ra + rb) / 2 - 1.5), w, Math.max(3, rb - ra));
  }), 0, 0, w, h);
  // seconds along the bottom
  g.font = "600 10px Inter, system-ui, sans-serif"; g.textBaseline = "middle";
  g.fillStyle = "rgba(190,196,255,0.35)"; g.textAlign = "center";
  for (let s = Math.ceil(tA); s < tA + WIN; s++) { if (s < 0) continue; const x = (s - tA) * sx; g.fillRect(x, bot + 2, 1, 4); if (s % 2 === 0) g.fillText(fmtTime(s), x, bot + 11); }
  g.textAlign = "left";
  const grad = GRAD(g, 0, w);
  let current = null;
  // only the notes in view (they are in time order)
  const segs = S.segs;
  let i = 0, j = segs.length;
  while (i < j) { const m = (i + j) >> 1; if (segs[m].t1 < tA) i = m + 1; else j = m; }
  for (; i < segs.length; i++) {
    const s = segs[i];
    if (s.t0 > tA + WIN) break;
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
    glowDot(g, px, y, 16, 1);
    g.fillStyle = "#fff"; roundRect(g, px - 3, y - th / 2, 6, th, th / 2); g.fill();
    const label = `${noteName(s.f).split(" ")[0]} · ${s.f.toFixed(1)} Hz`;
    g.font = "700 11px Inter, system-ui, sans-serif";
    const tw = g.measureText(label).width, lx = Math.min(w - tw - 12, px + 8), ly = Math.max(top + 8, y - th / 2 - 12);
    g.fillStyle = "rgba(20,17,58,0.9)"; roundRect(g, lx - 6, ly - 9, tw + 12, 18, 9); g.fill();
    g.fillStyle = "#fff"; g.fillText(label, lx, ly);
  }
  const ct = fmtTime(t), el = $("rb-cur");
  if (el.textContent !== ct) el.textContent = ct;
}
function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// the whole song at a glance (drag or tap it to move through the song): how much bass there is along it, the window
// the roll shows, and the play position with its handle
function drawOverview() {
  const c = $("rb-ov"), dpr = Math.min(2, devicePixelRatio || 1), w = c.clientWidth || 300, h = c.clientHeight || 44;
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
  for (let i = 0; i < cols; i++) { const v = env[i] * (h - 12); g.globalAlpha = 0.35 + 0.65 * env[i]; g.fillRect(i * 2, (h - v) / 2, 1.4, Math.max(1, v)); }
  g.globalAlpha = 1;
  // the intro, if it's on: a soft block at the start
  if (S.introN) { g.fillStyle = "rgba(255,255,255,0.10)"; g.fillRect(0, 3, (S.introN / S.outBuf.sampleRate / dur) * w, h - 6); }
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
  const x = (t / dur) * w, big = S.scrubT != null;
  g.fillStyle = "#fff"; g.fillRect(x - 0.75, 2, 1.5, h - 4);
  const hx = Math.max(9, Math.min(w - 9, x));
  g.beginPath(); g.arc(hx, h / 2, big ? 9 : 7, 0, Math.PI * 2);
  g.fillStyle = "#fff"; g.fill(); g.lineWidth = big ? 5 : 3; g.strokeStyle = "rgba(122,75,255,0.55)"; g.stroke();
}

function tick(now) {
  S.raf = 0;
  if ($("rb-result").hidden || location.hash !== "#rebass" || document.hidden) return;
  // at most 60 frames a second (a 120 Hz phone draws every other one)
  if (S.lastT && now - S.lastT < 15) { S.raf = requestAnimationFrame(tick); return; }
  const dt = S.lastT ? Math.min(0.1, (now - S.lastT) / 1000) : 0.016;
  S.lastT = now;
  const moving = drawSpec(dt);
  drawRoll(); paintOverview();
  if (S.ed && S.how === "custom") S.ed.follow(S.pl ? songTime() : null);
  if (S.pl || S.drag || S.scrubT != null || moving) S.raf = requestAnimationFrame(tick);
}
/** Something changed or started moving: draw until it rests. */
function kickGraph() {
  if (S.raf || !S.res) return;
  S.lastT = 0;
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
/** The file in the chosen format (or as an MP3 if that would be over maxBytes, for sharing): { file, fresh, swapped }. */
async function buildFile({ maxBytes } = {}) {
  const chosen = segValue($("rb-format")), name = $("rb-name").value.trim() || defaultName();
  const fmt = fitFormat(chosen, S.outBuf.duration, S.outBuf.sampleRate, maxBytes);
  const key = `${S.version}|${fmt}|${S.cover ? S.cover.size : 0}|${name}`;
  const fresh = !S.file || S.fileKey !== key;
  if (fresh) {
    toast(fmt === "mp3" ? "Making the MP3…" : "Making the file…", 60000);
    const chs = [S.outBuf.getChannelData(0), S.outBuf.getChannelData(1)];
    const { file } = await makeFile(chs, S.outBuf.sampleRate, name, fmt, getCtx(), null,
      { title: name, artist: (S.src && S.src.artist) || "", album: "FifTeam Media", cover: coverBlob() });
    S.file = file; S.fileKey = key;
  }
  return { file: S.file, fresh, swapped: fmt !== chosen };
}
async function save() {
  if (!S.outBuf) return;
  try {
    const { file, fresh } = await buildFile();
    if (isIOS() && fresh) { toast("Ready. Tap Save again, then choose Save to Files."); return; }
    const dk = "file:" + (S.fileKey || file.name);
    if (!downloadAllowed(dk)) return;
    if (isIOS()) toast("Choose Save to Files to keep it on your iPhone", 5000);
    const r = await saveFile(file);
    noteDownload(dk);
    if (r === "saved") toast("Saved");
    else if (r === "downloaded") toast(`Saved to your Downloads as ${file.name}`, 5000);
  } catch (e) { toast("Couldn't save the file. " + (e.message || "")); }
}
const noteOf = (p) => `${p.speed < 1 ? Math.round(p.speed * 100) + "% · " : ""}${p.custom ? `Custom notes (${p.custom.length})` : `${hzText(p.lo, p.hi)} Hz`} · ${p.db === 0 ? "0" : "−" + Math.abs(p.db)} dB`;
function share() {
  if (!S.outBuf) return;
  const name = () => $("rb-name").value.trim() || defaultName();
  openShareSheet({
    what: "song", name, build: buildFile, cover: async () => coverBlob(),
    meta: () => ({ kind: "rebass", title: name(), artist: S.src.artist || "", album: "Rebassed", duration: S.outBuf.duration, note: noteOf(S.params), made: { ...S.params, from: S.src.title } }),
    recipe: S.params.custom ? undefined : async () => {
      if (!S.src.hash) S.src.hash = await fingerprint(S.src.blob);
      const p = S.params;
      return { title: S.src.title, artist: S.src.artist || "", duration: S.src.duration || (S.origBuf ? S.origBuf.duration : 0), hash: S.src.hash, settings: { lo: p.lo, hi: p.hi, db: p.db, speed: p.speed, reverb: p.reverb, intro: introWanted(), name: S.nameEdited ? name() : "" } };
    },
  });
}
async function keep() {
  if (!S.outBuf) return;
  const name = $("rb-name").value.trim() || defaultName();
  toast("Adding to your library…", 60000);
  const chs = [S.outBuf.getChannelData(0), S.outBuf.getChannelData(1)];
  const want = segValue($("rb-format")), fmt = want === "mp3" ? "mp3" : want === "flac" ? "flac" : "wav16";
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
  // Auto bass or Custom notes
  onSeg($("rb-how"), setHow);
  $("rb-ne-play").onclick = () => { getCtx(); if (!S.outBuf) return; if (S.pl) stopPreview(true); else playPreview(S.pausedAt || 0); };
  $("rb-ne-song").onclick = () => { if (S.worker && S.loaded) { readParams(); S.worker.postMessage({ type: "notes", lo: S.params.lo, hi: S.params.hi, speed: S.params.speed }); } };
  $("rb-ne-undo").onclick = () => S.ed && S.ed.undo();
  $("rb-ne-clear").onclick = () => { if (S.ed && S.custom.length && confirm("Clear all your notes for this song?")) S.ed.clear(); };
  $("rb-ne-sel").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || !S.ed) return;
    const a = b.dataset.a;
    if (a === "delete") S.ed.remove(); else if (a === "up") S.ed.nudge(0, 1); else if (a === "down") S.ed.nudge(0, -1); else if (a === "longer") S.ed.nudge(0.05); else if (a === "shorter") S.ed.nudge(-0.05);
  });
  paintHow();
  for (const id of ["rb-lo", "rb-hi"]) $(id).addEventListener("input", () => { paintRange(); settingsChanged(); });
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
  $("rb-quick").onclick = () => { $("rb-quick").hidden = true; if (S.worker) S.worker.postMessage({ type: "quick" }); };
  onSeg($("rb-ab"), setAB);
  onSeg($("rb-format"), () => paintSize());
  $("rb-play").onclick = () => { getCtx(); if (S.pl) stopPreview(true); else playPreview(S.pausedAt || 0); };
  // moving through the song with a finger: the graphs follow the finger straight away, the music jumps there on letting go
  const clampT = (t) => Math.max(0, Math.min(S.outBuf.duration, t));
  // the roll: drag to scrub, tap to jump there
  const roll = $("rb-map");
  roll.addEventListener("pointerdown", (e) => {
    if (!S.outBuf) return;
    roll.setPointerCapture(e.pointerId);
    S.drag = { x: e.clientX, t: curTime(), moved: false };
    S.scrubT = S.drag.t; kickGraph();
  });
  roll.addEventListener("pointermove", (e) => {
    if (!S.drag) return;
    const dx = e.clientX - S.drag.x;
    if (Math.abs(dx) > 3) S.drag.moved = true;
    S.scrubT = clampT(S.drag.t - (dx / roll.clientWidth) * WIN);
  });
  const endDrag = (e) => {
    if (!S.drag) return;
    const d = S.drag; S.drag = null;
    let t = S.scrubT; S.scrubT = null;
    if (e.type === "pointercancel") { kickGraph(); return; }
    if (!d.moved) { const r = roll.getBoundingClientRect(); t = d.t + ((e.clientX - r.left) / r.width - AT) * WIN; }
    seekTo(clampT(t));
  };
  roll.addEventListener("pointerup", endDrag); roll.addEventListener("pointercancel", endDrag);
  // the whole-song strip under it: press anywhere and slide
  const ov = $("rb-ov");
  const ovT = (e) => { const r = ov.getBoundingClientRect(); return clampT(((e.clientX - r.left) / r.width) * S.outBuf.duration); };
  ov.addEventListener("pointerdown", (e) => { if (!S.outBuf || S.drag) return; ov.setPointerCapture(e.pointerId); S.scrubT = ovT(e); kickGraph(); });
  ov.addEventListener("pointermove", (e) => { if (S.scrubT == null || S.drag || !ov.hasPointerCapture(e.pointerId)) return; S.scrubT = ovT(e); });
  const ovEnd = (e) => {
    if (S.scrubT == null || S.drag) return;
    const t = S.scrubT; S.scrubT = null;
    if (e.type === "pointercancel") { kickGraph(); return; }
    seekTo(t);
  };
  ov.addEventListener("pointerup", ovEnd); ov.addEventListener("pointercancel", ovEnd);
  // the intro switch (remembered), and which intro: FifTeam's, or the user's own (Premium)
  try { $("rb-intro").checked = localStorage.getItem(INTRO_KEY) === "1"; } catch {}
  $("rb-intro").onchange = () => introChanged();
  buildIntroBox();
  // the cover
  $("rb-cover-pick").onclick = async () => {
    const b = await pickImage(); if (!b) return;
    S.cover = b; if (S.coverUrl) URL.revokeObjectURL(S.coverUrl); S.coverUrl = URL.createObjectURL(b); paintCover();
  };
  $("rb-cover-reset").onclick = () => { S.cover = null; if (S.coverUrl) URL.revokeObjectURL(S.coverUrl); S.coverUrl = null; paintCover(); };
  $("rb-save").onclick = save; $("rb-share").onclick = share; $("rb-keep").onclick = keep;
  // onto FifTeam Social: the rebass as it is now (with its intro, if on), as an MP3 with its cover
  const songNow = () => {
    const name = $("rb-name").value.trim() || defaultName(), buf = S.outBuf, cover = coverBlob(), artist = (S.src && S.src.artist) || "";
    return {
      title: name, artist, note: noteOf(S.params), duration: buf.duration, cover,
      encode: async (kbps) => (await makeFile([buf.getChannelData(0), buf.getChannelData(1)], buf.sampleRate, name, "mp3", getCtx(), null, { title: name, artist, album: "FifTeam Social", cover, kbps })).file,
    };
  };
  $("rb-post").onclick = () => { if (S.outBuf) bus.emit("social-post", songNow()); };
  // (or to someone in a message)
  $("rb-dm").onclick = () => { if (S.outBuf) bus.emit("dm-send-song", songNow()); };
  bus.on("rebass", (t) => { location.hash = "#rebass"; fromTrack(t); });
  bus.on("view", (v) => { if (v !== "rebass") stopPreview(true); else if (S.res) kickGraph(); });
  bus.on("music-playing", () => stopPreview(true));
  addEventListener("resize", () => { if (S.res) { drawOverview(); kickGraph(); } });
  paintRange(); paintDb(); paintSlow(); readParams(); paintCover();
}

/** A rebass code a friend sent: this song, set up exactly their way, and rebassed. */
async function applyRecipe(track, s) {
  location.hash = "#rebass";
  await fromTrack(track);
  $("rb-lo").value = s.lo; $("rb-hi").value = s.hi; $("rb-db").value = s.db;
  $("rb-slow").checked = s.speed < 0.999; if (s.speed < 0.999) $("rb-speed").value = Math.round(s.speed * 100);
  $("rb-reverb").checked = !!s.reverb;
  $("rb-intro").checked = !!s.intro;
  paintRange(); paintDb(); paintSlow(); readParams();
  if (s.name) { $("rb-name").value = s.name; S.nameEdited = true; } else $("rb-name").value = defaultName();
  go();
}

export const rebass = { fromFile, applyRecipe, state: S };
