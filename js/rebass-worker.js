// The rebass, off the main thread. "load" takes the song and finds its bass line (kept here, so changing a setting only
// re-renders); "render" builds the new bass for the settings, lays it under the song with no clipping, and sends back the
// result, a 10 ms map of the old and new bass for the graphs, and the numbers.
import { analyzeBass, mapBassLine, synthBass, rebassMix } from "./dsp.js";

let chs = null, sr = 0, an = null;

onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      chs = m.chs; sr = m.sr;
      const n = chs[0].length, mono = new Float32Array(n);
      const k = 1 / chs.length;
      for (const c of chs) for (let i = 0; i < n; i++) mono[i] += c[i] * k;
      an = analyzeBass(mono, sr, (p) => postMessage({ type: "progress", stage: "find", p }));
      let voiced = 0; for (const f of an.f0) if (f > 0) voiced++;
      postMessage({ type: "analysis", lo: an.lo, hi: an.hi, voiced: voiced / Math.max(1, an.f0.length) });
    } else if (m.type === "render") {
      if (!an) throw new Error("No song loaded");
      const p = m.params;
      const mapped = mapBassLine(an, { lo: p.lo, hi: p.hi, mode: p.mode, snap: p.snap });
      postMessage({ type: "progress", stage: "build", p: 0 });
      const n = chs[0].length;
      const { bass, peak } = synthBass(an, mapped, sr, n, (q) => postMessage({ type: "progress", stage: "build", p: q }));
      const { out, stats } = rebassMix(chs, bass, peak, sr, {
        bassDb: p.db, replaceHz: p.replace ? Math.max(30, p.hi * 1.25) : 0,
        progress: (q) => postMessage({ type: "progress", stage: "master", p: q }),
      });
      // the numbers: notes played, how many stayed exactly in tune, the ranges
      let notes = 0, prev = 0, tuned = 0, voiced = 0, mn = 1e9, mx = 0;
      for (let i = 0; i < mapped.length; i++) {
        const f = mapped[i];
        if (!(f > 0) || an.env[i] < 0.05) { prev = 0; continue; }
        voiced++;
        if (!prev || Math.abs(f / prev - 1) > 0.03) notes++;
        prev = f; mn = Math.min(mn, f); mx = Math.max(mx, f);
        // in tune: the new note is the found note moved by whole octaves (within 20 cents)
        const c = (1200 * Math.log2(f / an.f0[i])) % 1200;
        const cc = Math.min(Math.abs(c), 1200 - Math.abs(c));
        if (cc < 20 || (p.snap && cc < 60)) tuned++;
      }
      // a map for the graphs: old bass, new bass, loudness, every 10 ms
      const frames = mapped.length;
      const map = new Float32Array(frames * 3);
      for (let i = 0; i < frames; i++) { map[i * 3] = an.f0[i]; map[i * 3 + 1] = mapped[i]; map[i * 3 + 2] = an.env[i]; }
      postMessage({
        type: "result", out, map, t0: an.t0, hop: an.hop,
        stats: { ...stats, notes, tunedPct: voiced ? (100 * tuned) / voiced : 100, newLo: mn < 1e9 ? mn : p.lo, newHi: mx || p.hi, songLo: an.lo, songHi: an.hi, bassDb: p.db },
      }, [out[0].buffer, out[1].buffer, map.buffer]);
    }
  } catch (err) {
    postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
