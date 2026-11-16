// The rebass, off the main thread. "load" takes the song and finds its bass line; "render" builds the new bass for the
// settings, lays it under the song with no clipping, and sends back the result, a 10 ms map of the old and new bass for
// the graphs, and the numbers. A slowed (and reverbed) version is made first when asked for, and its bass line found
// again from the slowed song itself, so the new bass follows the slowed song exactly. The last version is kept, so
// changing anything else only re-renders.
import { analyzeBass, mapBassLine, synthBass, rebassMix, slowDown, freeverb, mixMono } from "./dsp.js";

let base = null, sr = 0, prep = null, refSent = "";
const post = (stage, p) => postMessage({ type: "progress", stage, p });

function prepare(speed, reverb) {
  const key = `${speed.toFixed(3)}|${reverb ? 1 : 0}`;
  if (prep && prep.key === key) return prep;
  prep = null;
  let chs = base;
  if (speed < 0.999) { post("slow", 0); chs = slowDown(base, speed, (p) => post("slow", p)); }
  const an = analyzeBass(mixMono(chs), sr, (p) => post("find", p));
  let music = chs;
  if (reverb) { post("verb", 0); music = freeverb(chs, sr, {}, (p) => post("verb", p)); }
  prep = { key, music, an, changed: speed < 0.999 || reverb };
  return prep;
}

onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      base = m.chs; sr = m.sr; prep = null; refSent = "";
      const p = prepare(1, false);
      let voiced = 0; for (const f of p.an.f0) if (f > 0) voiced++;
      postMessage({ type: "analysis", lo: p.an.lo, hi: p.an.hi, voiced: voiced / Math.max(1, p.an.f0.length) });
    } else if (m.type === "render") {
      if (!base) throw new Error("No song loaded");
      const p = m.params;
      const pr = prepare(p.speed || 1, !!p.reverb), an = pr.an;
      const mapped = mapBassLine(an, { lo: p.lo, hi: p.hi, mode: p.mode, snap: p.snap });
      post("build", 0);
      const n = pr.music[0].length;
      const { bass, peak } = synthBass(an, mapped, sr, n, (q) => post("build", q));
      const { out, stats } = rebassMix(pr.music, bass, peak, sr, {
        bassDb: p.db, replaceHz: p.replace ? Math.max(30, p.hi * 1.25) : 0,
        progress: (q) => post("master", q),
      });
      // the numbers: notes played, how many stayed exactly in tune, the ranges
      let notes = 0, prev = 0, tuned = 0, voiced = 0, mn = 1e9, mx = 0;
      for (let i = 0; i < mapped.length; i++) {
        const f = mapped[i];
        if (!(f > 0) || an.env[i] < 0.05) { prev = 0; continue; }
        voiced++;
        if (!prev || Math.abs(f / prev - 1) > 0.03) notes++;
        prev = f; mn = Math.min(mn, f); mx = Math.max(mx, f);
        if (an.f0[i] > 0) {
          const c = (1200 * Math.log2(f / an.f0[i])) % 1200, cc = Math.min(Math.abs(c), 1200 - Math.abs(c));
          if (cc < 20 || (p.snap && cc < 60)) tuned++;
        }
      }
      const frames = mapped.length, map = new Float32Array(frames * 3);
      for (let i = 0; i < frames; i++) { map[i * 3] = an.f0[i]; map[i * 3 + 1] = mapped[i]; map[i * 3 + 2] = an.env[i]; }
      // the slowed song without the new bass, for listening side by side (sent once per version)
      let ref = null;
      if (pr.changed && refSent !== pr.key) { ref = pr.music.map((c) => c.slice()); refSent = pr.key; }
      const transfer = [out[0].buffer, out[1].buffer, map.buffer];
      if (ref) ref.forEach((c) => transfer.push(c.buffer));
      postMessage({
        type: "result", out, map, t0: an.t0, hop: an.hop, ref, refKey: pr.changed ? pr.key : "",
        stats: { ...stats, notes, tunedPct: voiced ? (100 * tuned) / voiced : 100, newLo: mn < 1e9 ? mn : p.lo, newHi: mx || p.hi, songLo: an.lo, songHi: an.hi, bassDb: p.db, speed: p.speed || 1, reverb: !!p.reverb },
      }, transfer);
    }
  } catch (err) {
    postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
