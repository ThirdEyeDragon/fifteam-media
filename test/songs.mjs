// Test songs with a known bass line: every bass note's start, end and pitch, and the bass's own loudness, written down
// as the song is made. Two styles, built to trip a bass finder up:
//   trap: a saturated 808 with a punchy pitch drop on each hit, a slide, an octave jump; kicks on their own in the intro
//         and on top of the 808; claps, hats, a male voice (G2-E3, inside the low end), a low pad.
//   rock: a plucked bass guitar on eighths, a distorted guitar chugging power chords an octave above it (and on its own
//         for a bar where the bass rests), a short punchy kick, snare, voice.
export const SR = 44100;
const st2hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function master(L, R, peak = 0.97) {
  let pk = 0; for (let i = 0; i < L.length; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  const g = peak / pk;
  for (let i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; }
}
function kick(L, R, t0, amp, { f1 = 50, f2 = 130, tf = 0.02, td = 0.07, len = 0.35 } = {}, rnd) {
  let ph = 0;
  for (let s = Math.floor(t0 * SR); s < Math.min(L.length, Math.floor((t0 + len) * SR)); s++) {
    const t = s / SR - t0, f = f1 + f2 * Math.exp(-t / tf);
    ph += (2 * Math.PI * f) / SR;
    const v = amp * (Math.sin(ph) * Math.exp(-t / td) + (t < 0.003 ? (rnd() * 2 - 1) * 0.5 * (1 - t / 0.003) : 0));
    L[s] += v; R[s] += v;
  }
}
function noiseHit(L, R, t0, amp, td, hp, rnd) {
  let p1 = 0, p2 = 0;
  for (let s = Math.floor(t0 * SR); s < Math.min(L.length, Math.floor((t0 + td * 6) * SR)); s++) {
    const t = s / SR - t0, w = rnd() * 2 - 1;
    let v = w; if (hp) { v = w - p1; p1 = w; if (hp > 1) { const v2 = v - p2; p2 = v; v = v2; } }
    v *= amp * Math.exp(-t / td);
    L[s] += v; R[s] += v * 0.92;
  }
}
// a male voice: a harmonic stack with vibrato and formants
function voice(L, R, t0, dur, midi, amp) {
  const f = st2hz(midi), form = [[600, 120], [1100, 150], [2500, 220]];
  let ph = 0;
  const hs = []; for (let h = 1; h <= 14; h++) { const fh = f * h; let a = 0.25 / h; for (const [fc, bw] of form) a += 1 / (1 + ((fh - fc) / bw) ** 2); hs.push(a); }
  const norm = 1 / hs.reduce((a, b) => a + b, 0);
  for (let s = Math.floor(t0 * SR); s < Math.min(L.length, Math.floor((t0 + dur) * SR)); s++) {
    const t = s / SR - t0, env = Math.min(1, t / 0.04) * Math.min(1, (dur - t) / 0.06);
    const vib = Math.pow(2, (0.3 / 12) * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3));
    ph += (2 * Math.PI * f * vib) / SR;
    let v = 0; for (let h = 0; h < hs.length; h++) v += hs[h] * Math.sin((h + 1) * ph);
    v *= amp * env * norm * 3;
    L[s] += v; R[s] += v;
  }
}

/** trap: returns { L, R, notes: [{ on, off, q, legato }], env (the 808's loudness every 10 ms), kicksAlone: [times] } */
export function trap(secs = 32) {
  const n = SR * secs, L = new Float32Array(n), R = new Float32Array(n), rnd = rng(11);
  const beat = 60 / 140, bar = 4 * beat;
  const env = new Float32Array(Math.ceil(secs * 100));
  const notes = [], kicksAlone = [];
  // the 808 line, two bars long: [beat, length in beats, note, slide in?]
  const A = [[0, 1.5, 26], [1.5, 0.5, 26], [2, 1, 29], [3, 1, 22], [4, 0.75, 24], [4.75, 1.25, 31, true], [6, 0.5, 26], [6.5, 0.5, 26], [7, 1, 33]];
  const B = [[0, 1.5, 26], [1.5, 0.5, 26], [2, 1, 29], [3, 1, 22], [4, 1.5, 24], [5.5, 0.5, 36], [6, 1, 26], [7, 0.5, 38], [7.5, 0.5, 33]];
  let ph = 0, prevF = 0;
  const bars = Math.floor(secs / bar);
  for (let b = 2; b + 1 < bars; b += 2) {
    const pat = (b / 2) % 2 ? B : A;
    for (const [bt, len, q, slide] of pat) {
      const on = b * bar + bt * beat, off = on + len * beat - 0.012, fT = st2hz(q);
      const fromF = slide ? prevF : fT;
      for (let s = Math.floor(on * SR); s < Math.min(n, Math.floor((off + 0.03) * SR)); s++) {
        const t = s / SR - on;
        let f;
        if (slide) f = fromF * Math.pow(fT / fromF, Math.min(1, t / 0.07));
        else f = fT * Math.pow(2, (5 / 12) * Math.exp(-t / 0.012));
        ph += (2 * Math.PI * f) / SR;
        const atk = slide ? 1 : 1 - Math.exp(-t / 0.002), rel = s / SR > off ? Math.exp(-(s / SR - off) / 0.008) : 1;
        const a = atk * Math.exp(-t / 1.8) * rel;
        const v = (Math.tanh(1.6 * a * Math.sin(ph)) / Math.tanh(1.6)) * 0.62;
        L[s] += v; R[s] += v;
        const fr = Math.floor((s / SR) * 100); if (fr < env.length) env[fr] = Math.max(env[fr], a);
      }
      notes.push({ on, off: off + 0.01, q, legato: !!slide });
      prevF = fT;
    }
  }
  // drums: kicks on 1 and the "and" of 3; on their own through the intro and the last bar
  for (let b = 0; b < bars; b++) for (const bt of [0, 2.5]) {
    const t = b * bar + bt * beat;
    kick(L, R, t, 0.75, {}, rnd);
    if (!notes.some((x) => t >= x.on - 0.05 && t < x.off)) kicksAlone.push(t);
  }
  for (let b = 0; b < bars; b++) for (const bt of [1, 3]) noiseHit(L, R, b * bar + bt * beat, 0.32, 0.05, 1, rnd);
  for (let k = 0; k * beat / 2 < secs; k++) noiseHit(L, R, (k * beat) / 2, 0.07, 0.012, 2, rnd);
  // the voice (G2 to E3) and a low pad
  const phr = [[0.2, 43], [0.9, 45], [1.6, 47], [2.6, 48], [3.3, 47], [4.1, 45], [5.0, 52], [5.9, 50]];
  for (let b = 0; b < bars; b += 3) for (const [o, q] of phr) voice(L, R, b * bar + o, 0.55, q, 0.3);
  for (let s = 0; s < n; s++) { const t = s / SR, v = 0.035 * (Math.sin(2 * Math.PI * 130.81 * t) + Math.sin(2 * Math.PI * 164.81 * t) + Math.sin(2 * Math.PI * 196 * t)); L[s] += v; R[s] += v * 0.9; }
  master(L, R);
  // what the 808's fundamental does once saturated (its loudness as heard)
  return { L, R, notes, env, kicksAlone, sat: (a) => Math.tanh(1.6 * a) / Math.tanh(1.6) };
}

/** rock: returns { L, R, notes, env, guitarAlone: [from, to] } */
export function rock(secs = 30) {
  const n = SR * secs, L = new Float32Array(n), R = new Float32Array(n), rnd = rng(5);
  const beat = 0.5, eighth = beat / 2, bar = 4 * beat;
  const env = new Float32Array(Math.ceil(secs * 100));
  const notes = [];
  const line = [28, 28, 28, 28, 31, 31, 33, 33, 38, 38, 38, 38, 33, 33, 35, 35];
  const bars = Math.floor(secs / bar), rest = 6;
  for (let b = 0; b < bars; b++) {
    for (let k = 0; k < 8; k++) {
      const q = line[(b % 2) * 8 + k], on = b * bar + k * eighth, off = on + eighth * 0.9;
      // the guitar: a distorted power chord an octave above the bass, chugging (and alone in the bass's resting bar)
      const g0 = st2hz(q + 12);
      for (let s = Math.floor(on * SR); s < Math.min(n, Math.floor((on + eighth) * SR)); s++) {
        const t = s / SR - on, saw = (f) => 2 * ((f * (s / SR)) % 1) - 1;
        const v = Math.tanh(3 * (saw(g0) + 0.8 * saw(g0 * 1.4983) + 0.6 * saw(g0 * 2))) * 0.17 * Math.exp(-t / 0.09);
        L[s] += v * 0.8; R[s] += v;
      }
      if (b === rest) continue;
      const f = st2hz(q);
      for (let s = Math.floor(on * SR); s < Math.min(n, Math.floor((off + 0.03) * SR)); s++) {
        const t = s / SR - on, rel = s / SR > off ? Math.exp(-(s / SR - off) / 0.006) : 1;
        let v = 0; for (let h = 1; h <= 8; h++) v += (Math.sin(2 * Math.PI * f * h * t) / Math.pow(h, 1.2)) * Math.exp(-t * (1.5 + 0.8 * h));
        const a = (1 - Math.exp(-t / 0.003)) * rel;
        v *= 0.5 * a;
        L[s] += v; R[s] += v;
        const fr = Math.floor((s / SR) * 100); if (fr < env.length) env[fr] = Math.max(env[fr], a * Math.exp(-t * 2.3));
      }
      notes.push({ on, off: off + 0.006, q, legato: false });
    }
  }
  for (let b = 0; b < bars; b++) { for (const bt of [0, 2, 2.5]) kick(L, R, b * bar + bt * beat, 0.6, { f1: 60, f2: 80, tf: 0.015, td: 0.05, len: 0.25 }, rnd); for (const bt of [1, 3]) noiseHit(L, R, b * bar + bt * beat, 0.35, 0.06, 1, rnd); }
  const phr = [[0.1, 43], [0.6, 45], [1.1, 47], [1.6, 50]];
  for (let b = 0; b < bars; b += 2) for (const [o, q] of phr) voice(L, R, b * bar + o, 0.45, q, 0.28);
  master(L, R);
  return { L, R, notes, env, guitarAlone: [rest * bar, (rest + 1) * bar] };
}
