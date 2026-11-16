// node test/sep.test.mjs - the bass separator's own maths (without the network), the clean-up of the old bass's traces,
// and the note finder on a bass alone (as the separator gives it).
import { spec, ispecAdd, separateBass, resample, SEG, NB, LE } from "../js/demucs.js";
import { cleanLowEnd, butter4 } from "../js/dsp.js";
import { pack, unpack } from "../js/stems.js";
import { analyzeBassLine, hz2st } from "../js/bassline.js";
import { trap, rock, SR } from "./songs.mjs";

let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.log("  FAIL:", what); } };
const snr = (ref, x, a = 0, b = ref.length) => { let e = 0, r = 0; for (let i = a; i < b; i++) { e += (x[i] - ref[i]) ** 2; r += ref[i] ** 2; } return 10 * Math.log10(r / Math.max(e, 1e-30)); };
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
const music = (n, sr, noise = 0.02) => {
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; L[i] = 0.3 * Math.sin(2 * Math.PI * 55 * t) + 0.2 * Math.sin(2 * Math.PI * 1000 * t) + 0.05 * Math.sin(2 * Math.PI * 7000 * t) + noise * rnd(); R[i] = 0.25 * Math.sin(2 * Math.PI * 82 * t + 1) + 0.15 * Math.sin(2 * Math.PI * 440 * t) + noise * rnd(); }
  return [L, R];
};

// ------------------------------------------------------------------------------- the spectrogram and its inverse
{
  // (tones only: Demucs drops the very top bin, Nyquist, which noise would have)
  const [L, R] = music(SEG, SR, 0);
  const oL = new Float32Array(SEG), oR = new Float32Array(SEG);
  ispecAdd(spec(L, R), oL, oR);
  const a = snr(L, oL, 4096, SEG - 4096), b = snr(R, oR, 4096, SEG - 4096);
  console.log(`spectrogram there and back (inside the segment): left ${a.toFixed(1)} dB, right ${b.toFixed(1)} dB`);
  check(a > 100 && b > 100, "spectrogram round trip");
}

// ------------------------------------------------------------------------------- segments, scale, resampling
{
  // a network that hands back its own input (time branch), nothing from the spectrum: the song must come back exactly
  const same = async (seg) => ({ z: new Float32Array(4 * NB * LE), xt: Float32Array.from(seg) });
  const n = Math.round(20.3 * SR), [L, R] = music(n, SR);
  const [bL, bR] = await separateBass([L, R], SR, same);
  const a = snr(L, bL), b = snr(R, bR);
  console.log(`segments and cross-fades over 20.3 s (3 segments): back to ${a.toFixed(1)} / ${b.toFixed(1)} dB`);
  check(a > 100 && b > 100, "segments put back exactly");
  // a 48 kHz song: down to 44.1 kHz for the network, back up after
  const n48 = Math.round(9 * 48000), [L48, R48] = music(n48, 48000);
  const [cL, cR] = await separateBass([L48, R48], 48000, same);
  const c = snr(L48, cL, 4800, n48 - 4800), d = snr(R48, cR, 4800, n48 - 4800);
  console.log(`48 kHz song through 44.1 kHz and back: ${c.toFixed(1)} / ${d.toFixed(1)} dB (noise to 24 kHz included)`);
  check(cL.length === n48 && c > 40 && d > 40, "48 kHz there and back");
  const tone = new Float32Array(48000 * 2); for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2 * Math.PI * 3000 * i / 48000);
  const back = resample(resample(tone, 48000, 44100), 44100, 48000);
  const e = snr(tone, back, 4800, tone.length - 4800);
  console.log(`a 3 kHz tone 48 -> 44.1 -> 48 kHz: ${e.toFixed(1)} dB`);
  check(e > 80, "resampler clean");
}

// ------------------------------------------------------------------------------- kept basses
{
  const n = 10 * 48000, x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / 48000; x[i] = 0.6 * Math.sin(2 * Math.PI * 41 * t) + 0.2 * Math.sin(2 * Math.PI * 123 * t) + 0.05 * Math.sin(2 * Math.PI * 820 * t); }
  const [y] = unpack(pack([x], 48000), n);
  const a = snr(x, y, 4800, n - 4800);
  console.log(`a bass kept (quarter rate, 16 bits) and brought back: ${a.toFixed(1)} dB`);
  check(a > 50, "kept bass");
}

// ------------------------------------------------------------------------------- clearing the old bass's traces
{
  // what's left after the separated bass came out: a trace of the old bass (a 50 Hz note, 10% of it), a voice at
  // 147 Hz, a kick, and a 1 kHz part. The separated bass: that 50 Hz note.
  const n = 6 * SR, on = 1, off = 4;
  const R = [new Float32Array(n), new Float32Array(n)], B = [new Float32Array(n), new Float32Array(n)];
  const voice = new Float32Array(n), kickS = new Float32Array(n), hi = new Float32Array(n), trace = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, inNote = t >= on && t < off ? 1 : 0;
    trace[i] = 0.05 * inNote * Math.sin(2 * Math.PI * 50 * t);
    voice[i] = 0.15 * (Math.sin(2 * Math.PI * 147 * t) + 0.5 * Math.sin(2 * Math.PI * 294 * t));
    hi[i] = 0.1 * Math.sin(2 * Math.PI * 1000 * t);
    const kt = (t % 0.5); kickS[i] = 0.4 * Math.exp(-kt / 0.06) * Math.sin(2 * Math.PI * (60 + 60 * Math.exp(-kt / 0.02)) * kt);
    for (const c of [0, 1]) { R[c][i] = trace[i] + voice[i] + kickS[i] + hi[i]; B[c][i] = 0.5 * inNote * Math.sin(2 * Math.PI * 50 * t); }
  }
  const before = R.map((c) => Float32Array.from(c));
  cleanLowEnd(R, B, SR, (a, b) => (b > on && a < off ? [50] : []));
  const lvl = (x, f, a, b) => { let re = 0, im = 0; for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) { re += x[i] * Math.cos(2 * Math.PI * f * i / SR); im += x[i] * Math.sin(2 * Math.PI * f * i / SR); } return Math.hypot(re, im); };
  const d = (f, a, b) => 20 * Math.log10(lvl(R[0], f, a, b) / lvl(before[0], f, a, b));
  const oldBass = d(50, 1.5, 3.5), v = d(147, 1.5, 3.5), h = d(1000, 1.5, 3.5), vOut = d(147, 4.5, 5.8);
  console.log(`clearing the old bass's traces: the 50 Hz trace ${oldBass.toFixed(1)} dB, the voice ${v.toFixed(2)} dB (after the note ${vOut.toFixed(2)} dB), 1 kHz ${h.toFixed(3)} dB`);
  check(oldBass < -15 && Math.abs(v) < 1 && Math.abs(vOut) < 0.2 && Math.abs(h) < 0.01, "old bass traces cleared, the rest kept");
}

// ------------------------------------------------------------------------------- notes found on a bass alone
for (const [name, song] of [["trap 808", trap(32)], ["rock bass", rock(30)]]) {
  const an = analyzeBassLine(song.bass, SR, null, null, { stem: true });
  let matched = 0, wrong = 0, errs = [];
  for (const t of song.notes) {
    if (t.legato) continue;
    const g = an.notes.filter((h) => Math.abs(h.on - t.on) < 0.05).sort((x, y) => Math.abs(x.on - t.on) - Math.abs(y.on - t.on))[0];
    if (!g) continue;
    matched++;
    if (Math.abs(g.q + an.tune - t.q) >= 0.5) wrong++;
    errs.push(Math.abs(g.on - t.on) * 1000);
  }
  const real = song.notes.filter((t) => !t.legato).length;
  const extra = an.notes.filter((g) => !g.legato && !song.notes.some((t) => Math.abs(g.on - t.on) < 0.05)).length;
  errs.sort((x, y) => x - y);
  // the new bass: full while each note sounds
  let full = 0, tot = 0;
  for (const t of song.notes) for (let u = t.on + 0.02; u < t.off - 0.03; u += 0.005) { const k = Math.round(u * an.fs); tot++; if (an.amp[k] > 0.9) full++; }
  console.log(`${name} alone: ${matched}/${real} notes found, wrong pitch ${wrong}, extra ${extra} | attack error 95% ${errs[Math.floor(errs.length * 0.95)].toFixed(1)} ms | new bass full for ${(100 * full / tot).toFixed(1)}% of the notes' time`);
  check(matched >= real * 0.98 && wrong === 0 && extra === 0, `${name}: the notes`);
  check(full / tot > 0.85, `${name}: full notes`);
}

console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
