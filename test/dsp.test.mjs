// node test/dsp.test.mjs - the rebass engine on a made-up song with a known bass line, mastered hot.
import { analyzeBass, mapBassLine, synthBass, rebassMix, encodeWav, truePeak, linToDb, noteName, slidingMin } from "../js/dsp.js";

const sr = 44100, secs = 24, n = sr * secs;
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// the bass line: one note per half beat at 120 bpm, a plucked bass guitar (a sawtooth's first six harmonics)
const notes = [41.2, 41.2, 49.0, 55.0, 41.2, 65.41, 55.0, 49.0, 36.71, 36.71, 49.0, 73.42, 61.74, 55.0, 49.0, 43.65];
const L = new Float32Array(n), R = new Float32Array(n);
const truth = new Float32Array(Math.ceil(secs * 100));
const step = 0.25;
for (let k = 0; k * step < secs; k++) {
  const f = notes[k % notes.length], t0 = k * step;
  for (let s = Math.floor(t0 * sr); s < Math.min(n, Math.floor((t0 + step) * sr)); s++) {
    const t = s / sr - t0;
    const env = Math.min(1, t / 0.004) * Math.exp(-t * 3.5);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * (s / sr)) / h;
    L[s] += 0.42 * env * v; R[s] += 0.42 * env * v;
  }
  for (let fr = Math.round(t0 * 100) + 2; fr < Math.round((t0 + step) * 100) - 2; fr++) truth[fr] = f;
}
// a kick on every beat, a snare on 2 and 4, a pad of chords, then everything pushed into the ceiling
for (let b = 0; b * 0.5 < secs; b++) {
  const t0 = b * 0.5;
  let ph = 0;
  for (let s = Math.floor(t0 * sr); s < Math.min(n, Math.floor((t0 + 0.35) * sr)); s++) {
    const t = s / sr - t0, f = 45 + 80 * Math.exp(-t * 30);
    ph += (2 * Math.PI * f) / sr;
    const v = Math.sin(ph) * Math.exp(-t * 9) * 0.7;
    L[s] += v; R[s] += v;
  }
  if (b % 2 === 1) for (let s = Math.floor(t0 * sr); s < Math.min(n, Math.floor((t0 + 0.2) * sr)); s++) {
    const t = s / sr - t0, v = (rnd() * 2 - 1) * Math.exp(-t * 25) * 0.35;
    L[s] += v; R[s] += v * 0.9;
  }
}
for (let s = 0; s < n; s++) {
  const t = s / sr;
  const c = [220, 277.18, 329.63].reduce((a, f) => a + Math.sin(2 * Math.PI * f * t), 0) * 0.06;
  L[s] += c; R[s] += c * 0.8;
}
let pk = 0; for (let s = 0; s < n; s++) pk = Math.max(pk, Math.abs(L[s]), Math.abs(R[s]));
for (let s = 0; s < n; s++) { L[s] *= 0.995 / pk; R[s] *= 0.995 / pk; }
console.log(`song: ${secs} s, peak ${linToDb(0.995).toFixed(2)} dBFS, true peak ${linToDb(truePeak([L, R], 0.5)).toFixed(2)} dBTP`);

// sliding minimum against brute force
{
  const x = Float32Array.from({ length: 500 }, () => rnd());
  const m = slidingMin(x, 7);
  let ok = true;
  for (let i = 0; i < x.length; i++) {
    let b = 1e9; for (let j = Math.max(0, i - 7); j <= Math.min(x.length - 1, i + 7); j++) b = Math.min(b, x[j]);
    if (b !== m[i]) ok = false;
  }
  console.log("slidingMin matches brute force:", ok);
  if (!ok) process.exit(1);
}

const mono = new Float32Array(n); for (let s = 0; s < n; s++) mono[s] = 0.5 * (L[s] + R[s]);
let t = performance.now();
const an = analyzeBass(mono, sr);
console.log(`analysis: ${(performance.now() - t).toFixed(0)} ms, ${an.f0.length} frames, song bass ${an.lo.toFixed(1)}-${an.hi.toFixed(1)} Hz`);
// how often the found note is the true note (any octave counts as a miss here)
let hit = 0, tot = 0, oct = 0;
for (let i = 0; i < an.f0.length; i++) {
  const time = an.t0 + i * an.hop, fr = Math.round(time * 100);
  if (!truth[fr] || !an.f0[i]) continue;
  tot++;
  const c = 1200 * Math.log2(an.f0[i] / truth[fr]);
  if (Math.abs(c) < 50) hit++;
  else if (Math.abs(Math.abs(c) - 1200) < 50) oct++;
}
const voicedTruth = Array.from(truth).filter((v) => v > 0).length;
console.log(`pitch: ${(100 * hit / tot).toFixed(1)}% exact, ${(100 * oct / tot).toFixed(1)}% octave off, coverage ${(100 * tot / voicedTruth).toFixed(0)}%`);

for (const [lo, hi, mode, db] of [[25, 45, "musical", 0], [20, 35, "stretch", -3], [30, 60, "musical", -7.5], [23, 30, "musical", -5]]) {
  t = performance.now();
  const mapped = mapBassLine(an, { lo, hi, mode, snap: true });
  let mn = 1e9, mx = 0;
  for (const f of mapped) if (f > 0) { mn = Math.min(mn, f); mx = Math.max(mx, f); }
  const { bass, peak } = synthBass(an, mapped, sr, n);
  const { out, stats } = rebassMix([L, R], bass, peak, sr, { bassDb: db, replaceHz: hi * 1.25 });
  const wav = new Int16Array(encodeWav(out, sr, 16).slice(44));
  let full = 0; for (const v of wav) if (v >= 32767 || v <= -32768) full++;
  console.log(`${lo}-${hi} Hz ${mode} ${db} dB: bass ${mn.toFixed(1)}-${mx.toFixed(1)} Hz, bass plays at ${stats.bassActualDb.toFixed(2)} dBFS, song at ${stats.songDb.toFixed(1)} dB fixed` +
    `${stats.ridePct > 0 ? `, riding ${stats.ridePct.toFixed(1)}% of the time (down to ${stats.rideDb.toFixed(1)} dB more)` : ", no compression"}, true peak ${stats.truePeakDb.toFixed(2)} dBTP, clipped ${stats.clipped}, full-scale ${full}, ${(performance.now() - t).toFixed(0)} ms`);
  if (stats.clipped || full || stats.truePeakDb > -0.1 + 1e-3 || mn < lo - 0.01 || mx > hi + 0.01 || Math.abs(stats.bassActualDb - Math.min(db, -0.1)) > 0.02) { console.log("FAIL"); process.exit(1); }
  if (lo === 23) {
    // the narrow range: how many distinct pitches, how long the notes are, and each note name always on one frequency
    const byNote = new Map(); let runs = 0, short = 0, len = 0, prev = -1;
    for (let i = 0; i <= mapped.length; i++) {
      const f = i < mapped.length ? mapped[i] : -2;
      if (f !== prev) { if (prev > 0) { runs++; if (len < 8) short++; } prev = f; len = 1; } else len++;
      if (i < mapped.length && f > 0 && an.f0[i] > 0) { const pc = ((Math.round(12 * Math.log2(an.f0[i] / 440)) % 12) + 12) % 12; (byNote.get(pc) || byNote.set(pc, new Set()).get(pc)).add(f.toFixed(2)); }
    }
    const multi = [...byNote.values()].filter((v) => v.size > 1).length;
    console.log(`  23-30 Hz: ${new Set(Array.from(mapped).filter((f) => f > 0).map((f) => f.toFixed(2))).size} pitches, ${runs} notes, ${short} under 80 ms, note names on more than one frequency: ${multi}`);
    if (short) { console.log("FAIL"); process.exit(1); }
  }
}
// note stability: count notes shorter than 40 ms in the mapped line (flicker)
{
  const mapped = mapBassLine(an, { lo: 25, hi: 50, mode: "musical", snap: true });
  let runs = 0, short = 0, len = 0, prev = -1;
  for (let i = 0; i <= mapped.length; i++) {
    const f = i < mapped.length ? mapped[i] : -2;
    if (f !== prev) { if (prev > 0) { runs++; if (len < 4) short++; } prev = f; len = 1; } else len++;
  }
  console.log(`note stability: ${runs} notes, ${short} shorter than 40 ms`);
  if (short) { console.log("FAIL"); process.exit(1); }
}

// slowed and screwed: 75% speed, then the bass found again on the slowed song, then rebassed (with reverb) at 0 dB
{
  const { slowDown, freeverb } = await import("../js/dsp.js");
  t = performance.now();
  const speed = 0.75;
  const [sL, sR] = slowDown([L, R], speed);
  const smono = new Float32Array(sL.length); for (let s = 0; s < sL.length; s++) smono[s] = 0.5 * (sL[s] + sR[s]);
  const san = analyzeBass(smono, sr);
  // the app's way: the original bass line, unchanged, laid at the slowed times
  const scaled = { ...an, t0: an.t0 / speed, hop: an.hop / speed };
  let hit = 0, tot = 0;
  for (let i = 0; i < san.f0.length; i++) {
    const time = (san.t0 + i * san.hop) * speed, fr = Math.round(time * 100);
    if (!truth[fr] || !san.f0[i]) continue;
    tot++;
    if (Math.abs(1200 * Math.log2(san.f0[i] / (truth[fr] * speed))) < 50) hit++;
  }
  const wetChs = freeverb([sL, sR], sr);
  const mapped = mapBassLine(an, { lo: 22, hi: 45, mode: "musical", snap: true });
  const { bass, peak } = synthBass(scaled, mapped, sr, wetChs[0].length);
  const { out, stats } = rebassMix(wetChs, bass, peak, sr, { bassDb: -5, replaceHz: 120 });
  console.log(`slowed 75% + reverb: ${(sL.length / sr).toFixed(1)} s (was ${secs}), song bass ${san.lo.toFixed(1)}-${san.hi.toFixed(1)} Hz, ` +
    `bass plays at ${stats.bassActualDb.toFixed(2)} dBFS, song ${stats.songDb.toFixed(1)} dB fixed${stats.ridePct > 0 ? ` + riding ${stats.ridePct.toFixed(1)}%` : ", no compression"}, true peak ${stats.truePeakDb.toFixed(2)} dBTP, clipped ${stats.clipped}, ${(performance.now() - t).toFixed(0)} ms`);
  if (stats.clipped || stats.truePeakDb > -0.1 + 1e-3 || Math.abs(stats.bassActualDb + 5) > 0.02) { console.log("FAIL"); process.exit(1); }
}
console.log("PASS");
