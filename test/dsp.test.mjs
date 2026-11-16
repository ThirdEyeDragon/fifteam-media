// node test/dsp.test.mjs - the engine's building blocks: the sliding minimum, WAV files, and a slowed + reverbed rebass
// (the same bass notes at the slowed times, the song touched only inside the range, no clipping).
import { slidingMin, encodeWav, slowDown, freeverb, rebassMix, mixMono, truePeak, linToDb } from "../js/dsp.js";
import { analyzeBassLine, planMapping, renderBass } from "../js/bassline.js";
import { trap, SR } from "./songs.mjs";

let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.log("  FAIL:", what); } };
let seed = 3; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
{
  const x = Float32Array.from({ length: 500 }, () => rnd()), m = slidingMin(x, 7);
  let ok = true;
  for (let i = 0; i < x.length; i++) { let b = 1e9; for (let j = Math.max(0, i - 7); j <= Math.min(x.length - 1, i + 7); j++) b = Math.min(b, x[j]); if (b !== m[i]) ok = false; }
  console.log("slidingMin matches brute force:", ok); check(ok, "slidingMin");
}
{
  const n = 4410, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = 0.9 * Math.sin(i / 7); R[i] = -L[i]; }
  const b = Buffer.from(encodeWav([L, R], SR, 16)), d = new Int16Array(b.buffer.slice(44));
  let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v));
  console.log(`WAV: ${b.length} bytes, peak ${(pk / 32768).toFixed(3)}`); check(Math.abs(pk / 32768 - 0.9) < 0.002, "WAV level");
}
{
  const T = trap(16), speed = 0.8;
  const an = analyzeBassLine(mixMono([T.L, T.R]), SR);
  const slowed = freeverb(slowDown([T.L, T.R], speed), SR);
  const plan = planMapping(an, 25, 45, speed);
  const { bass, peak } = renderBass(an, plan, SR, slowed[0].length, speed);
  const { out, stats } = rebassMix(slowed, bass, peak, SR, { bassDb: -4, band: [25, 45] });
  // the new bass notes start where the song's do, at the slowed times
  let first = an.notes[0].on / speed, s = Math.floor((first - 0.05) * SR), onset = -1;
  for (; s < bass.length; s++) if (Math.abs(bass[s]) > 0.05 * peak) { onset = s / SR; break; }
  console.log(`slowed 80% + reverb: ${an.notes.length} notes, first at ${first.toFixed(3)} s slowed, new bass starts ${onset.toFixed(3)} s | ${plan.describe} | bass ${stats.bassActualDb.toFixed(2)} dBFS, song ${stats.songDb.toFixed(1)} dB, true peak ${stats.truePeakDb.toFixed(2)}, clipped ${stats.clipped}`);
  check(Math.abs(onset - first) < 0.012 && stats.clipped === 0 && Math.abs(stats.bassActualDb + 4) < 0.02, "slowed rebass");
}
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
