// node test/bass.test.mjs - the bass finder, the mapping, the new bass and the band, on songs with a known bass line.
import { trap, rock, SR } from "./songs.mjs";
import { analyzeBassLine, planMapping, renderBass, makeFreqAt, hz2st, st2hz } from "../js/bassline.js";
import { bandStop, rebassMix, mixMono, truePeak, linToDb } from "../js/dsp.js";

let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.log("  FAIL:", what); } };

function score(name, song, an) {
  const truth = song.notes, found = an.notes;
  let matched = 0, wrongPitch = 0, onErrs = [];
  for (const t of truth) {
    let best = null, bestOv = 0;
    for (const g of found) { const ov = Math.min(t.off, g.off) - Math.max(t.on, g.on); if (ov > bestOv) { bestOv = ov; best = g; } }
    if (!best || bestOv < 0.5 * (t.off - t.on)) continue;
    if (best.q !== t.q) { wrongPitch++; continue; }
    matched++;
    if (!t.legato) onErrs.push((best.on - t.on) * 1000);
  }
  // time the new bass would play where there was no bass note
  let falseT = 0, falseNotes = 0;
  for (const g of found) {
    let ov = 0; for (const t of truth) ov += Math.max(0, Math.min(t.off, g.off) - Math.max(t.on, g.on));
    falseT += Math.max(0, g.off - g.on - ov);
    if (ov < 0.3 * (g.off - g.on)) falseNotes++;
  }
  // the original bass's loudness against the one we follow, every 10 ms through the notes, in dB after one overall gain:
  // how far off it is 90% of the time
  const dd = [];
  for (const t of truth) for (let fr = Math.ceil(t.on * 100) + 1; fr < Math.floor(t.off * 100) - 1; fr++) {
    const a = song.sat ? song.sat(song.env[fr]) : song.env[fr], b = an.amp[Math.min(an.amp.length - 1, Math.round((fr / 100 + 0.005) * an.fs))];
    if (a > 0.02) dd.push(20 * Math.log10((b + 1e-6) / a));
  }
  dd.sort((a, b) => a - b);
  const mid = dd[dd.length >> 1], dev = dd.map((v) => Math.abs(v - mid)).sort((a, b) => a - b), corr = dev[Math.floor(dev.length * 0.9)];
  const absOn = onErrs.map(Math.abs).sort((a, b) => a - b);
  const r = {
    recall: matched / truth.length, wrongPitch, falseNotes, falseMs: falseT * 1000,
    onMed: absOn[absOn.length >> 1] || 0, on95: absOn[Math.floor(absOn.length * 0.95)] || 0, corr,
  };
  console.log(`${name}: ${truth.length} true notes, ${found.length} found | matched ${(100 * r.recall).toFixed(1)}%, wrong pitch ${wrongPitch}, ` +
    `false notes ${falseNotes} (${r.falseMs.toFixed(0)} ms of bass where there was none) | attack error median ${r.onMed.toFixed(1)} ms, 95% ${r.on95.toFixed(1)} ms | ` +
    `loudness within ${corr.toFixed(1)} dB of the original 90% of the time | dropped as drums ${an.dropped.drums}, as other ${an.dropped.other} | tuning ${an.tune.toFixed(3)}, song bass ${an.lo.toFixed(1)}-${an.hi.toFixed(1)} Hz`);
  return r;
}

let t = performance.now();
const T = trap(), anT = analyzeBassLine(mixMono([T.L, T.R]), SR);
console.log(`trap analysed in ${(performance.now() - t).toFixed(0)} ms`);
const rT = score("trap", T, anT);
check(rT.recall >= 0.97, "trap: every bass note found");
check(rT.wrongPitch === 0, "trap: no wrong pitches");
check(rT.falseNotes === 0, "trap: no notes on kicks, voice or pad");
check(rT.on95 <= 12, "trap: attacks within 12 ms");
check(rT.corr <= 3, "trap: loudness follows the 808 (within 3 dB)");
// the intro's kicks on their own: no bass
const onKick = T.kicksAlone.filter((k) => anT.notes.some((g) => k >= g.on - 0.01 && k < g.off)).length;
console.log(`  kicks with no 808 under them: ${T.kicksAlone.length}, given a bass note: ${onKick}`);
check(onKick === 0, "trap: no bass on kicks alone");

t = performance.now();
const K = rock(), anK = analyzeBassLine(mixMono([K.L, K.R]), SR);
console.log(`rock analysed in ${(performance.now() - t).toFixed(0)} ms`);
const rK = score("rock", K, anK);
check(rK.recall >= 0.95, "rock: every bass note found");
check(rK.wrongPitch === 0, "rock: no wrong pitches");
check(rK.falseNotes === 0, "rock: no notes on the guitar alone");
check(rK.on95 <= 12, "rock: attacks within 12 ms");
check(rK.corr <= 3, "rock: loudness follows the bass (within 3 dB)");
const inRest = anK.notes.filter((g) => g.on < K.guitarAlone[1] - 0.02 && g.off > K.guitarAlone[0] + 0.02).length;
console.log(`  notes in the bar the bass rests (guitar alone): ${inRest}`);
check(inRest === 0, "rock: nothing while the bass rests");

// ---------------------------------------------------------------------------------------------------- the mapping
const lineOf = (an, plan) => an.notes.map((g) => plan.target.get(g.q));
for (const [lo, hi] of [[30, 40], [23, 30], [25, 45], [20, 60], [20, 35], [30, 55]]) {
  for (const [name, an] of [["trap", anT], ["rock", anK]]) {
    const plan = planMapping(an, lo, hi);
    const tg = lineOf(an, plan), src = an.notes.map((g) => g.q);
    let shape = 0, tiny = 0, out = 0;
    for (let i = 1; i < tg.length; i++) {
      const a = Math.sign(src[i] - src[i - 1]), b = Math.sign(Math.round((tg[i] - tg[i - 1]) * 1000));
      if (a !== b && !(a !== 0 && b === 0 && plan.kind === "squeeze")) shape++;
      const d = Math.abs(tg[i] - tg[i - 1]); if (d > 1e-6 && d < 0.999) tiny++;
    }
    for (const v of tg) { const f = st2hz(v); if (f < lo - 0.01 || f > hi + 0.01) out++; }
    const fr = [...new Set(tg.map((v) => st2hz(v).toFixed(2)))].sort((a, b) => a - b);
    console.log(`${name} ${lo}-${hi} Hz: ${plan.describe} | pitches ${fr.join(" ")} | ups/downs changed ${shape}, steps under a semitone ${tiny}, outside the range ${out}`);
    check(shape === 0 && tiny === 0 && out === 0, `${name} ${lo}-${hi}: clean mapping`);
  }
}
{
  const p = planMapping(anK, 20, 60);
  check(p.kind === "move" && p.shift % 12 === 0, "rock 20-60: an octave move (the same notes)");
}

// ---------------------------------------------------------------------------------------------------- the new bass
{
  const plan = planMapping(anT, 30, 40), n = T.L.length;
  const { bass, peak } = renderBass(anT, plan, SR, n);
  // steady on each note, glides at least 40 ms long, no jumps while sounding
  const fAt = makeFreqAt(anT, plan);
  let jumps = 0, wobble = 0, last = fAt(0);
  for (let s = 1; s < n; s += 22) {
    const u = s / SR, f = fAt(u), a = anT.amp[Math.min(anT.amp.length - 1, Math.round(u * anT.fs))];
    if (a > 0.01 && Math.abs(hz2st(f) - hz2st(last)) > 0.25) jumps++;
    last = f;
  }
  anT.notes.forEach((g, i) => {
    const nx = anT.notes[i + 1], a = g.legato ? g.glideB : g.on, b = nx && nx.legato ? nx.glideA : g.off, fs = [];
    for (let u = a + 0.005; u < b - 0.005; u += 0.005) fs.push(fAt(u));
    if (fs.length && Math.max(...fs) - Math.min(...fs) > 1e-6) wobble++;
  });
  const glides = anT.notes.filter((g) => g.legato).map((g) => (g.glideB - g.glideA) * 1000);
  console.log(`new bass 30-40 Hz: peak ${peak.toFixed(3)}, pitch jumps while sounding ${jumps}, notes that wobble ${wobble}, glides ${glides.map((x) => x.toFixed(0)).join(" ")} ms`);
  check(jumps === 0 && wobble === 0 && glides.every((x) => x >= 39.9), "new bass: steady notes, smooth glides");
}

// ---------------------------------------------------------------------------------------------------- the band
{
  const n = SR * 6, tones = [20, 27, 31, 35, 39, 44, 60, 150, 1000, 6000];
  const x = new Float32Array(n);
  for (const f of tones) for (let s = 0; s < n; s++) x[s] += 0.08 * Math.sin(2 * Math.PI * f * s / SR + f);
  const y = Float32Array.from(x);
  bandStop([y], SR, 30, 40);
  const level = (sig, f) => { let re = 0, im = 0; const a = SR, b = 5 * SR; for (let s = a; s < b; s++) { re += sig[s] * Math.cos(2 * Math.PI * f * s / SR); im += sig[s] * Math.sin(2 * Math.PI * f * s / SR); } return Math.hypot(re, im) / ((b - a) / 2); };
  const res = tones.map((f) => [f, 20 * Math.log10(level(y, f) / level(x, f) + 1e-12)]);
  // the difference outside the band, sample by sample
  console.log("band 30-40 Hz, change per tone:", res.map(([f, d]) => `${f} Hz ${d > -0.005 ? "0.00" : d.toFixed(2)} dB`).join(", "));
  for (const [f, d] of res) {
    if (f < 30 || f > 40) check(Math.abs(d) < 0.01, `band: ${f} Hz untouched`);
    else if (f >= 31 && f <= 39) check(d < -50, `band: ${f} Hz removed`);
  }
}

// ---------------------------------------------------------------------------------------------------- the whole rebass
for (const [lo, hi, db] of [[30, 40, -3], [25, 45, 0], [20, 60, -7.5]]) {
  const plan = planMapping(anT, lo, hi), n = T.L.length;
  const { bass, peak } = renderBass(anT, plan, SR, n);
  const { out, stats } = rebassMix([T.L, T.R], bass, peak, SR, { bassDb: db, band: [lo, hi] });
  // the vocals' range untouched: compare 150 Hz - 8 kHz before and after (song level aside)
  console.log(`rebass trap ${lo}-${hi} Hz ${db} dB: bass peak ${stats.bassActualDb.toFixed(2)} dBFS, song ${stats.songDb.toFixed(2)} dB (untouched: 0), bass held back ${stats.heldPct.toFixed(1)}%` +
    `, true peak ${stats.truePeakDb.toFixed(2)} dBTP, clipped ${stats.clipped}`);
  if (process.env.V) console.log("   exact:", stats.truePeakDb, stats.bassActualDb, stats.peakDb);
  check(stats.clipped === 0 && stats.truePeakDb <= -0.099 && Math.abs(stats.bassActualDb - Math.min(db, -0.1)) < 0.02 && stats.songTouchedPct === 0, `rebass ${lo}-${hi} ${db}: clean, song untouched`);
}

console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
