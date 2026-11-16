// The rebass, off the main thread. "load" takes the song and finds its bass line; "render" builds the new bass for the
// settings, takes the song's own content out of the chosen range only (nothing else is touched), lays the new bass in
// with no clipping, and sends back the result, a 10 ms map of the old and new bass for the graphs, and the numbers.
// The bass line is found once, on the song itself. A slowed (and reverbed) version gets that same bass line, the same
// notes, laid at the slowed times: nothing new is invented. The last slowed version is kept, so changing anything else
// only re-renders.
import { rebassMix, slowDown, freeverb, mixMono } from "./dsp.js";
import { analyzeBassLine, planMapping, renderBass, makeFreqAt, st2hz } from "./bassline.js";

let base = null, sr = 0, an0 = null, prep = null, refSent = "";
const post = (stage, p) => postMessage({ type: "progress", stage, p });

function prepare(speed, reverb) {
  const key = `${speed.toFixed(3)}|${reverb ? 1 : 0}`;
  if (prep && prep.key === key) return prep;
  prep = null;
  if (!an0) an0 = analyzeBassLine(mixMono(base), sr, (p) => post("find", p));
  let chs = base;
  if (speed < 0.999) { post("slow", 0); chs = slowDown(base, speed, (p) => post("slow", p)); }
  let music = chs;
  if (reverb) { post("verb", 0); music = freeverb(chs, sr, {}, (p) => post("verb", p)); }
  prep = { key, music, speed, changed: speed < 0.999 || reverb };
  return prep;
}

onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      base = m.chs; sr = m.sr; an0 = null; prep = null; refSent = "";
      prepare(1, false);
      postMessage({ type: "analysis", notes: an0.notes.length, lo: an0.lo, hi: an0.hi });
    } else if (m.type === "render") {
      if (!base) throw new Error("No song loaded");
      const p = m.params;
      const pr = prepare(p.speed || 1, !!p.reverb), sp = pr.speed;
      // where each of the song's own bass notes goes, then the new bass, note for note
      const plan = planMapping(an0, p.lo, p.hi, sp);
      post("build", 0);
      const n = pr.music[0].length;
      const { bass, peak } = renderBass(an0, plan, sr, n, sp, (q) => post("build", q));
      const { out, stats } = rebassMix(pr.music, bass, peak, sr, { bassDb: p.db, band: [p.lo, p.hi], progress: (q) => post("master", q) });
      // the map for the graphs, on the (slowed) song's own timeline: the old bass (as it sounds now) and the new
      const frames = an0.f0.length, map = new Float32Array(frames * 3), fAt = makeFreqAt(an0, plan);
      for (let i = 0; i < frames; i++) {
        const u = an0.t0 + i * an0.hop;
        map[i * 3] = an0.f0[i] * sp;
        map[i * 3 + 1] = an0.env[i] > 0.005 ? fAt(u) : 0;
        map[i * 3 + 2] = an0.env[i];
      }
      const targets = [...plan.target.values()].map(st2hz);
      // the slowed (or reverbed) song without the new bass, for listening side by side (sent once per version)
      let ref = null;
      if (pr.changed && refSent !== pr.key) { ref = pr.music.map((c) => c.slice()); refSent = pr.key; }
      const transfer = [out[0].buffer, out[1].buffer, map.buffer];
      if (ref) ref.forEach((c) => transfer.push(c.buffer));
      postMessage({
        type: "result", out, map, t0: an0.t0 / sp, hop: an0.hop / sp, ref, refKey: pr.changed ? pr.key : "",
        stats: {
          ...stats, notes: an0.notes.length, drums: an0.dropped.drums, other: an0.dropped.other, mapping: plan.describe, kind: plan.kind,
          songLo: an0.lo * sp, songHi: an0.hi * sp, newLo: targets.length ? Math.min(...targets) : p.lo, newHi: targets.length ? Math.max(...targets) : p.hi,
          lo: p.lo, hi: p.hi, bassDb: p.db, speed: sp, reverb: !!p.reverb,
        },
      }, transfer);
    }
  } catch (err) {
    postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
