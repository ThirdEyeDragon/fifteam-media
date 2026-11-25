// The rebass, off the main thread.
// "load": the song's bass is separated from everything else (Demucs, on the graphics chip when there is one; kept on the
// phone for next time), its notes are found on that clean bass alone, and the song without its bass is made: the
// separated bass subtracted, then its last traces cleared from the low end (see cleanLowEnd). Vocals, drums and the
// rest stay as they were.
// "render": the new bass for the settings (the same notes at the same moments, moved into the range, clean and full),
// laid into the bass-free song with no clipping, sent back with a 10 ms map for the graphs and the numbers.
// If the separator can't run on this phone, the old way is used: the notes found in the whole song, the old bass taken
// out at its own notes' pitches.
import { rebassMix, slowDown, freeverb, mixMono, cleanLowEnd } from "./dsp.js";
import { analyzeBassLine, planMapping, renderBass, makeFreqAt, st2hz, renderNotes } from "./bassline.js";
import { getStem, putStem, pack, unpack } from "./stems.js";

let base = null, sr = 0, key = "", job = 0, sepWorker = null, sepStop = null, gpuOnly = false;
let an0 = null, song0 = null, mode = "", backend = "", prep = null, refPrep = null, refSent = "";
const post = (stage, p, extra) => postMessage({ type: "progress", stage, p, ...extra });

// the old notes sounding between two moments (Hz), for clearing their traces
const f0In = (an) => (a, b) => {
  const out = new Set(), i0 = Math.max(0, Math.floor((a - an.t0) / an.hop)), i1 = Math.min(an.f0.length - 1, Math.ceil((b - an.t0) / an.hop));
  for (let i = i0; i <= i1; i++) if (an.f0[i] > 0) out.add(an.f0[i]);
  return [...out];
};

async function separated(myJob) {
  const n = base[0].length;
  if (key) {
    const kept = await getStem(key, sr, n);
    if (kept) { post("separate", 1); return unpack(kept, n); }
  }
  const t0 = Date.now();
  // in a worker of its own, closed as soon as the bass is out (it hands back all the separator's memory)
  const b = await new Promise((res, rej) => {
    const w = new Worker(new URL("./sep-worker.js", import.meta.url), { type: "module" });
    sepWorker = w;
    sepStop = () => { w.terminate(); rej(new Error("cancelled")); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") post(m.stage, m.p, m.stage === "separate" && m.p > 0.05 ? { left: Math.max(0, (m.el / m.p) * (1 - m.p)) } : {});
      else if (m.type === "done") { backend = m.backend; w.terminate(); res(m.out); }
      else if (m.type === "error") { w.terminate(); rej(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || "separator")); };
    const copy = base.map((c) => c.slice());            // (handed over, not cloned: one copy of the song, not two)
    w.postMessage({ chs: copy, sr, gpuOnly }, copy.map((c) => c.buffer));
  }).finally(() => { sepWorker = null; sepStop = null; });
  if (myJob !== job) throw new Error("cancelled");
  const packed = pack(b, sr);
  if (key) await putStem(key, sr, n, packed);
  postMessage({ type: "separated", seconds: (Date.now() - t0) / 1000, backend });
  return unpack(packed, n);
}

async function load(m) {
  gpuOnly = !!m.gpuOnly;
  const myJob = ++job;
  base = m.chs; sr = m.sr; key = m.key || ""; an0 = song0 = prep = refPrep = null; refSent = ""; backend = "";
  let stem = null, why = "";
  if (!m.quick) {
    try { stem = await separated(myJob); }
    catch (e) { if (myJob !== job) return; why = String((e && e.message) || e); stem = null; }
  }
  if (myJob !== job) return;
  if (stem) {
    mode = "separated";
    an0 = analyzeBassLine(mixMono(stem), sr, (p) => post("find", p), null, { stem: true });
    post("clean", 0);
    song0 = base.map((c, i) => { const s = stem[Math.min(i, stem.length - 1)], o = new Float32Array(c.length); for (let k = 0; k < c.length; k++) o[k] = c[k] - s[k]; return o; });
    cleanLowEnd(song0, stem, sr, f0In(an0), { progress: (p) => post("clean", p) });
  } else {
    mode = "quick";
    an0 = analyzeBassLine(mixMono(base), sr, (p) => post("find", p));
    post("clean", 0);
    song0 = base.map((c) => Float32Array.from(c));
    cleanLowEnd(song0, null, sr, f0In(an0), { progress: (p) => post("clean", p) });
  }
  // (and the song's own bass line, for the Custom notes editor: its pitch and loudness every 10 ms, and its tuning)
  const guide = { t0: an0.t0, hop: an0.hop, f0: Float32Array.from(an0.f0), env: Float32Array.from(an0.env), tune: an0.tune };
  postMessage({ type: "analysis", notes: an0.notes.length, lo: an0.lo, hi: an0.hi, mode, backend, why, guide }, [guide.f0.buffer, guide.env.buffer]);
}

// the bass-free song slowed / reverbed for these settings (kept, so changing anything else only re-renders)
function prepare(speed, reverb) {
  const k = `${speed.toFixed(3)}|${reverb ? 1 : 0}`;
  if (prep && prep.key === k) return prep;
  prep = null;
  let chs = song0;
  if (speed < 0.999) { post("slow", 0); chs = slowDown(song0, speed, (p) => post("slow", p)); }
  let music = chs;
  if (reverb) { post("verb", 0); music = freeverb(chs, sr, {}, (p) => post("verb", p)); }
  prep = { key: k, music, speed, changed: speed < 0.999 || reverb };
  return prep;
}
// the ORIGINAL song slowed / reverbed the same way, for listening side by side
function reference(speed, reverb) {
  const k = `${speed.toFixed(3)}|${reverb ? 1 : 0}`;
  if (refPrep && refPrep.key === k) return refPrep.music;
  let chs = base;
  if (speed < 0.999) { post("slow", 0); chs = slowDown(base, speed, (p) => post("slow", p)); }
  const music = reverb ? freeverb(chs, sr, {}, (p) => post("verb", p)) : chs;
  refPrep = { key: k, music };
  return music;
}

/** Custom notes: the bass-free song with the notes placed by hand instead of the song's own. */
function renderCustom(p) {
  const pr = prepare(p.speed || 1, !!p.reverb), sp = pr.speed;
  const notes = (Array.isArray(p.custom) ? p.custom : []).filter((x) => x && x.d > 0 && x.f >= 8 && x.f <= 400 && x.t >= 0).sort((a, b) => a.t - b.t);
  post("build", 0);
  const n = pr.music[0].length;
  const { bass, peak } = renderNotes(notes, sr, n, sp, (q) => post("build", q));
  const fs = notes.map((x) => x.f), lo = fs.length ? Math.min(...fs) : p.lo, hi = fs.length ? Math.max(...fs) : p.hi;
  const { out, stats } = rebassMix(pr.music, bass, peak, sr, { bassDb: p.db, band: [lo, hi], progress: (q) => post("master", q) });
  // the map for the graphs: the old bass, and the note sounding at each moment
  const frames = an0.f0.length, map = new Float32Array(frames * 3);
  let j = 0;
  for (let i = 0; i < frames; i++) {
    const u = an0.t0 + i * an0.hop;
    while (j < notes.length && notes[j].t + notes[j].d < u) j++;
    let f = 0, v = 0;
    for (let k = j; k < notes.length && notes[k].t <= u; k++) if (u <= notes[k].t + notes[k].d && (notes[k].v == null ? 1 : notes[k].v) >= v) { f = notes[k].f; v = notes[k].v == null ? 1 : notes[k].v; }
    map[i * 3] = an0.f0[i] * sp; map[i * 3 + 1] = f; map[i * 3 + 2] = f ? Math.max(0.05, v) * 0.6 : an0.env[i] * 0.3;
  }
  let ref = null;
  if (pr.changed && refSent !== pr.key) { ref = reference(sp, !!p.reverb).map((c) => c.slice()); refSent = pr.key; }
  const transfer = [out[0].buffer, out[1].buffer, map.buffer];
  if (ref) ref.forEach((c) => transfer.push(c.buffer));
  postMessage({
    type: "result", out, map, t0: an0.t0 / sp, hop: an0.hop / sp, ref, refKey: pr.changed ? pr.key : "",
    stats: { ...stats, notes: notes.length, drums: 0, other: 0, mapping: `Your ${notes.length} note${notes.length === 1 ? "" : "s"}`, kind: "custom",
      songLo: an0.lo * sp, songHi: an0.hi * sp, newLo: lo, newHi: hi, lo, hi, bassDb: p.db, speed: sp, reverb: !!p.reverb, mode, backend, custom: true },
  }, transfer);
}
/** The song's own notes, moved into a range (Hz) the same way as a rebass: a start for Custom notes. */
function songNotes(p) {
  if (!an0) throw new Error("No song loaded");
  const sp = p.speed || 1, plan = planMapping(an0, p.lo, p.hi, sp);
  const top = Math.max(1e-6, ...an0.notes.map((g) => g.peak));
  const list = an0.notes.map((g) => ({ t: g.on, d: Math.max(0.05, g.off - g.on), f: st2hz(plan.target.get(g.q)), v: Math.max(0.35, Math.min(1, g.peak / top)) }));
  postMessage({ type: "notes", list });
}

function render(p) {
  if (!song0) throw new Error("No song loaded");
  if (p.custom) return renderCustom(p);
  const pr = prepare(p.speed || 1, !!p.reverb), sp = pr.speed;
  // where each of the song's own bass notes goes, then the new bass, note for note
  const plan = planMapping(an0, p.lo, p.hi, sp);
  post("build", 0);
  const n = pr.music[0].length;
  const { bass, peak } = renderBass(an0, plan, sr, n, sp, (q) => post("build", q));
  const { out, stats } = rebassMix(pr.music, bass, peak, sr, { bassDb: p.db, band: [p.lo, p.hi], progress: (q) => post("master", q) });
  // the map for the graphs, on the (slowed) song's own timeline: the old bass and the new
  const frames = an0.f0.length, map = new Float32Array(frames * 3), fAt = makeFreqAt(an0, plan);
  for (let i = 0; i < frames; i++) {
    const u = an0.t0 + i * an0.hop;
    map[i * 3] = an0.f0[i] * sp;
    map[i * 3 + 1] = an0.env[i] > 0.005 ? fAt(u) : 0;
    map[i * 3 + 2] = an0.env[i];
  }
  const targets = [...plan.target.values()].map(st2hz);
  let ref = null;
  if (pr.changed && refSent !== pr.key) { ref = reference(sp, !!p.reverb).map((c) => c.slice()); refSent = pr.key; }
  const transfer = [out[0].buffer, out[1].buffer, map.buffer];
  if (ref) ref.forEach((c) => transfer.push(c.buffer));
  postMessage({
    type: "result", out, map, t0: an0.t0 / sp, hop: an0.hop / sp, ref, refKey: pr.changed ? pr.key : "",
    stats: {
      ...stats, notes: an0.notes.length, drums: an0.dropped.drums, other: an0.dropped.other, mapping: plan.describe, kind: plan.kind,
      songLo: an0.lo * sp, songHi: an0.hi * sp, newLo: targets.length ? Math.min(...targets) : p.lo, newHi: targets.length ? Math.max(...targets) : p.hi,
      lo: p.lo, hi: p.hi, bassDb: p.db, speed: sp, reverb: !!p.reverb, mode, backend,
    },
  }, transfer);
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "load") await load(m);
    else if (m.type === "quick" && base) { if (sepStop) sepStop(); await load({ chs: base, sr, key, quick: true }); }   // stops a separation under way
    else if (m.type === "render") render(m.params);
    else if (m.type === "notes") songNotes(m);
  } catch (err) {
    postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
