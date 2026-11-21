// FifTeam Media - the audio engine. Plain functions over Float32Arrays, no DOM: it runs in the rebass worker, on the main
// thread for the tone generator's exports, and in Node for the tests.

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

// ---------------------------------------------------------------------------------------------------- filters
// RBJ biquads; a 4th-order Butterworth is two of them (Q 0.5412 and 1.3066). Run forward then backward for zero phase,
// so the bass we find lines up exactly with the song.
const BW4 = [0.5411961, 1.3065630];

export function biquad(type, fc, sr, q) {
  const w = (2 * Math.PI * fc) / sr, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
  let b0, b1, b2;
  if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  const a0 = 1 + a;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * c) / a0, a2: (1 - a) / a0 };
}

function runBiquad(x, f, reverse) {
  let z1 = 0, z2 = 0;
  const n = x.length;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    const v = x[i];
    const y = f.b0 * v + z1;
    z1 = f.b1 * v - f.a1 * y + z2;
    z2 = f.b2 * v - f.a2 * y;
    x[i] = y;
  }
}

/** Zero-phase 4th-order Butterworth (8th order in effect), in place. */
export function butter4(x, type, fc, sr) {
  for (const q of BW4) { const f = biquad(type, fc, sr, q); runBiquad(x, f, false); runBiquad(x, f, true); }
  return x;
}

/** In-place radix-2 complex FFT (inverse: unscaled; divide by n yourself). n a power of two. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/**
 * Takes out of the song exactly the band lo..hi Hz and nothing else. Everything below lo and above hi is left as it was
 * (to within about -80 dB); inside, the song is cleared, with soft edges (a raised cosine up to 1 Hz wide, just inside the
 * band). Done precisely and cheaply: the low end is brought down to about 1000 samples a second, the band
 * cut there with one long FFT (zero phase, so nothing moves in time), brought back up (6-tap Lanczos) and subtracted.
 * In place. Returns the band that was taken out of the first channel, for the numbers.
 */
export function bandStop(chs, sr, lo, hi, progress) {
  const D = Math.max(1, Math.round(sr / 1000)), fs = sr / D;
  const w = Math.max(0.4, Math.min(1, (hi - lo) / 8));
  let first = null;
  chs.forEach((x, ci) => {
    const n = x.length, m = Math.floor((n - 1) / D) + 1;
    const lp = Float32Array.from(x);
    butter4(lp, "lp", Math.min(250, fs * 0.3), sr);
    // zero padding of 2 s each side keeps the filter's ringing from wrapping round
    const pad = Math.round(2 * fs);
    let P = 1; while (P < m + 2 * pad) P <<= 1;
    const re = new Float64Array(P), im = new Float64Array(P);
    for (let k = 0; k < m; k++) re[pad + k] = lp[k * D];
    fft(re, im);
    for (let k = 0; k <= P >> 1; k++) {
      const f = (k * fs) / P;
      let g = 0;
      if (f > lo && f < hi) {
        g = 1;
        if (f < lo + w) g = 0.5 - 0.5 * Math.cos((Math.PI * (f - lo)) / w);
        if (f > hi - w) g = Math.min(g, 0.5 - 0.5 * Math.cos((Math.PI * (hi - f)) / w));
      }
      re[k] *= g; im[k] *= g;
      if (k && k < P >> 1) { re[P - k] *= g; im[P - k] *= g; }
    }
    fft(re, im, true);
    const band = new Float32Array(m);
    for (let k = 0; k < m; k++) band[k] = re[pad + k] / P;
    subtractUp(x, band, D);
    if (!ci) first = band;
    progress && progress((ci + 1) / chs.length);
  });
  return { band: first, fs };
}

/** A low band worked out at 1/D of the rate, brought back up (Lanczos, a = 3) and subtracted from x, in place. */
function subtractUp(x, band, D) { upAdd(x, band, D, -1); }
/** x += sign * (band, at 1/D of the rate, brought up with Lanczos a = 3). */
export function upAdd(x, band, D, sign = 1) {
  const n = x.length, m = band.length;
  // the Lanczos weights repeat every D samples: worked out once per phase
  const W = [];
  for (let ph = 0; ph < D; ph++) {
    const u = ph / D, w = new Float64Array(6);
    let sum = 0;
    for (let j = -2; j <= 3; j++) { const t = u - j, wt = t === 0 ? 1 : (3 * Math.sin(Math.PI * t) * Math.sin((Math.PI * t) / 3)) / (Math.PI * Math.PI * t * t); w[j + 2] = wt; sum += wt; }
    for (let j = 0; j < 6; j++) w[j] /= sum;
    W.push(w);
  }
  for (let i = 0; i < n; i++) {
    const k0 = Math.floor(i / D), w = W[i - k0 * D];
    let acc = 0;
    if (k0 >= 2 && k0 + 3 < m) for (let j = 0; j < 6; j++) acc += band[k0 - 2 + j] * w[j];
    else { let ws = 0; for (let j = 0; j < 6; j++) { const k = k0 - 2 + j; if (k >= 0 && k < m) { acc += band[k] * w[j]; ws += w[j]; } } acc = ws ? acc / ws : 0; }
    x[i] += sign * acc;
  }
}

/**
 * The old bass's last traces, after the separated bass has been subtracted (R = the song - the separated bass). The
 * separation leaves a little of the old bass behind; this finds it in the low end only (below fTop, fading out by
 * fTop + fFade; nothing above is touched) and takes it out:
 *   - wherever what is left is ruled by the separated bass's own spectrum (the bit of it the separation missed):
 *     gains g = |R|^2 / (|R|^2 + beta |B|^2) on a 256 ms grid, so a cell that is mostly other sounds keeps them;
 *   - right on the old notes' own harmonics below fH (120 Hz: where bass lives and voices hardly go) while they play
 *     (f0In(t0, t1) -> the Hz sounding then): at most `depth` there, whatever the separation thought.
 * R and B are arrays of channels; R is changed in place. Measured on real songs with their true stems: the old bass goes
 * from -12 dB (the separation alone) to about -21 dB where it ruled (20-150 Hz); vocals there lose ~1 dB, drums ~2 dB;
 * above 150 Hz under 0.5 dB.
 */
export function cleanLowEnd(R, B, sr, f0In, opts = {}) {
  const { beta = 2, fTop = 300, fFade = 80, fH = 120, depth = 0.1, hw = 1.5, pad = 0.04, progress } = opts;
  const D = Math.max(1, Math.round(sr / 1000)), fs = sr / D;
  const N = 256, hop = 64, H = N / 2 + 1;
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const lpf = Math.min(fTop + fFade + 30, 0.45 * fs);
  const low = (x) => { const y = Float32Array.from(x); butter4(y, "lp", lpf, sr); const m = Math.floor((y.length - 1) / D) + 1, o = new Float64Array(m); for (let k = 0; k < m; k++) o[k] = y[k * D]; return o; };
  // the harmonics to clear in each frame (the same for every channel)
  const bw = (hw * fs) / N;
  R.forEach((Rc, ci) => {
    const r = low(Rc), b = B ? low(B[Math.min(ci, B.length - 1)]) : null, m = r.length;
    const frames = Math.ceil((m + N) / hop);
    const RE = new Float32Array(frames * H), IM = new Float32Array(frames * H), PR = new Float32Array(frames * H), PB = new Float32Array(frames * H);
    const re = new Float64Array(N), im = new Float64Array(N);
    const take = (x, s) => { for (let i = 0; i < N; i++) { const p = s + i; re[i] = p >= 0 && p < m ? x[p] * w[i] : 0; im[i] = 0; } fft(re, im); };
    for (let f = 0; f < frames; f++) {
      const s = f * hop - N;
      if (b) { take(b, s); for (let k = 0; k < H; k++) PB[f * H + k] = re[k] * re[k] + im[k] * im[k]; }
      take(r, s);
      for (let k = 0; k < H; k++) { RE[f * H + k] = re[k]; IM[f * H + k] = im[k]; PR[f * H + k] = re[k] * re[k] + im[k] * im[k]; }
    }
    const sm = (P, f, k) => { let s = 0, c = 0; for (let df = -1; df <= 1; df++) { const ff = f + df; if (ff < 0 || ff >= frames) continue; for (let dk = -1; dk <= 1; dk++) { const kk = k + dk; if (kk >= 0 && kk < H) { s += P[ff * H + kk]; c++; } } } return s / c; };
    const out = new Float64Array(m);
    for (let f = 0; f < frames; f++) {
      const s = f * hop - N, tc = (s + N / 2) / fs;
      const f0s = f0In ? f0In(tc - N / 2 / fs - pad, tc + N / 2 / fs + pad) : [];
      let any = false;
      for (let k = 0; k < H; k++) {
        const fr = (k * fs) / N;
        let g = 1;
        if (fr < fTop + fFade) {
          const pr = sm(PR, f, k), pb = sm(PB, f, k);
          g = pr / (pr + beta * pb + 1e-30);
          if (fr < fH) for (const f0 of f0s) { const h = Math.round(fr / f0); if (h >= 1 && h * f0 < fH && Math.abs(fr - h * f0) <= bw) { g = Math.min(g, depth); break; } }
          if (fr > fTop) g += (1 - g) * (0.5 - 0.5 * Math.cos((Math.PI * (fr - fTop)) / fFade));
        }
        // what comes out: (1 - g) of what is left
        const cut = 1 - g;
        re[k] = RE[f * H + k] * cut; im[k] = IM[f * H + k] * cut;
        if (k && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
        if (cut > 1e-6) any = true;
      }
      if (!any) continue;
      fft(re, im, true);
      for (let i = 0; i < N; i++) { const p = s + i; if (p >= 0 && p < m) out[p] += ((re[i] / N) * w[i]) / 2; }
    }
    subtractUp(Rc, out, D);
    progress && progress((ci + 1) / R.length);
  });
}

// ---------------------------------------------------------------------------------------------------- the new bass
const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function noteName(f) {
  if (!(f > 0)) return "";
  const m = 69 + 12 * Math.log2(f / 440), r = Math.round(m), cents = Math.round((m - r) * 100);
  return `${NOTE[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}` + (cents ? ` ${cents > 0 ? "+" : "−"}${Math.abs(cents)}¢` : "");
}

/** A mono mix of the channels. */
export function mixMono(chs) {
  const n = chs[0].length, mono = new Float32Array(n), k = 1 / chs.length;
  for (const c of chs) for (let i = 0; i < n; i++) mono[i] += c[i] * k;
  return mono;
}

// ---------------------------------------------------------------------------------------------------- slowed and screwed
/**
 * Tape-style slowdown: the song played slower, and so lower, the way slowed and screwed songs are made. speed 0.75 is
 * 75% speed, a little under five semitones down. 8-tap windowed-sinc (Lanczos) interpolation, so it stays clean.
 */
export function slowDown(chs, speed, progress) {
  const n = chs[0].length, m = Math.max(1, Math.floor((n - 1) / speed));
  const PH = 512, T = 4;
  const tab = new Float32Array(PH * 2 * T);
  for (let p = 0; p < PH; p++) {
    const u = p / PH;
    let sum = 0;
    for (let j = -T + 1; j <= T; j++) {
      const x = u - j;
      const v = x === 0 ? 1 : (T * Math.sin(Math.PI * x) * Math.sin((Math.PI * x) / T)) / (Math.PI * Math.PI * x * x);
      tab[p * 2 * T + j + T - 1] = v; sum += v;
    }
    for (let j = 0; j < 2 * T; j++) tab[p * 2 * T + j] /= sum;
  }
  return chs.map((x, ci) => {
    const y = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const pos = i * speed, k = Math.floor(pos), ph = Math.min(PH - 1, Math.round((pos - k) * PH));
      const o = ph * 2 * T;
      let acc = 0;
      for (let j = -T + 1; j <= T; j++) { const idx = k + j; if (idx >= 0 && idx < n) acc += x[idx] * tab[o + j + T - 1]; }
      y[i] = acc;
      if (progress && (i & 262143) === 0) progress((ci + i / m) / chs.length);
    }
    return y;
  });
}

/**
 * Reverb for "slowed + reverb" (Freeverb: eight damped combs and four allpasses per side). The low end stays dry, so
 * the bass under it stays tight. Adds a tail of tailSec.
 */
export function freeverb(chs, sr, { room = 0.86, damp = 0.32, wet = 0.32, width = 1, tailSec = 2.5 } = {}, progress) {
  const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], ALLS = [556, 441, 341, 225], SPREAD = 23;
  const k = sr / 44100, n = chs[0].length, m = n + Math.round(tailSec * sr);
  const L = chs[0], R = chs[1] || chs[0];
  const wet1 = wet * (width / 2 + 0.5) * 3, wet2 = wet * ((1 - width) / 2) * 3;
  const side = (off) => ({
    combs: COMBS.map((d) => ({ b: new Float32Array(Math.round((d + off) * k)), i: 0, f: 0 })),
    alls: ALLS.map((d) => ({ b: new Float32Array(Math.round((d + off) * k)), i: 0 })),
  });
  const sL = side(0), sR = side(SPREAD);
  const run = (s, inp) => {
    let out = 0;
    for (const c of s.combs) {
      const y = c.b[c.i];
      c.f = y * (1 - damp) + c.f * damp;
      c.b[c.i] = inp + c.f * room;
      if (++c.i >= c.b.length) c.i = 0;
      out += y;
    }
    for (const a of s.alls) {
      const bo = a.b[a.i];
      a.b[a.i] = out + bo * 0.5;
      if (++a.i >= a.b.length) a.i = 0;
      out = bo - out;
    }
    return out;
  };
  // the wet signal only above ~180 Hz
  const hp = [biquad("hp", 180, sr, 0.7071), biquad("hp", 180, sr, 0.7071)];
  const z = [[0, 0], [0, 0]];
  const filt = (c, v) => { const f = hp[c], s = z[c]; const y = f.b0 * v + s[0]; s[0] = f.b1 * v - f.a1 * y + s[1]; s[1] = f.b2 * v - f.a2 * y; return y; };
  const oL = new Float32Array(m), oR = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const dl = i < n ? L[i] : 0, dr = i < n ? R[i] : 0;
    const inp = (dl + dr) * 0.015;
    const wl = filt(0, run(sL, inp)), wr = filt(1, run(sR, inp));
    oL[i] = dl + wl * wet1 + wr * wet2;
    oR[i] = dr + wr * wet1 + wl * wet2;
    if (progress && (i & 262143) === 0) progress(i / m);
  }
  return [oL, oR];
}

// ---------------------------------------------------------------------------------------------------- mixing without clipping
/** Sliding minimum over the centred window [i-h, i+h] (a monotonic queue, O(n)). */
export function slidingMin(x, h) {
  // (a queue of positions in a ring the size of the window, not the length of the song)
  const n = x.length, out = new Float32Array(n);
  let cap = 1; while (cap < 2 * h + 2) cap <<= 1;
  const dq = new Int32Array(cap), M = cap - 1;
  let head = 0, tail = 0, r = 0;
  for (let i = 0; i < n; i++) {
    const last = Math.min(n - 1, i + h);
    while (r <= last) {
      while (tail > head && x[dq[(tail - 1) & M]] >= x[r]) tail--;
      dq[tail++ & M] = r++;
    }
    while (dq[head & M] < i - h) head++;
    out[i] = x[dq[head & M]];
  }
  return out;
}

/** Centred moving average over 2h+1 (a running sum in doubles; inPlace: written back into x). */
function boxAverage(x, h, inPlace = false) {
  const n = x.length, out = inPlace ? x : new Float32Array(n), W = 2 * h + 1, ring = new Float32Array(W);
  let sum = 0, cnt = 0;
  for (let j = 0; j <= Math.min(h, n - 1); j++) { sum += x[j]; cnt++; ring[j % W] = x[j]; }
  for (let i = 0; i < n; i++) {
    out[i] = sum / cnt;
    const drop = i - h, add = i + h + 1;
    if (drop >= 0) { sum -= ring[drop % W]; cnt--; }
    if (add < n) { sum += x[add]; cnt++; ring[add % W] = x[add]; }
  }
  return out;
}

/**
 * The 4x-oversampled (true) peak of a signal, looked for only round the samples that could hide one. A windowed-sinc
 * interpolator, 32 taps per phase.
 */
export function truePeak(chs, near = 0.5) {
  const TAPS = 16, phases = [0.25, 0.5, 0.75];
  const kern = phases.map((p) => {
    const k = new Float32Array(2 * TAPS);
    for (let j = 0; j < 2 * TAPS; j++) {
      const t = j - TAPS + 1 - p;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (TAPS + 0.5));
      k[j] = sinc * w;
    }
    return k;
  });
  let peak = 0;
  for (const x of chs) {
    const n = x.length;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i]);
      if (a > peak) peak = a;
      if (a < near) continue;
      for (const k of kern) {
        let acc = 0;
        for (let j = 0; j < 2 * TAPS; j++) { const idx = i + j - TAPS + 1; if (idx >= 0 && idx < n) acc += x[idx] * k[j]; }
        const av = Math.abs(acc);
        if (av > peak) peak = av;
      }
    }
  }
  return peak;
}

/**
 * Lays the new bass under the song with no clipping, and leaves the song itself alone.
 *   The song (vocals and everything else) keeps exactly its own level: it is never turned down, ridden or compressed.
 *   The bass plays at bassDb (dBFS, its loudest point; never above the ceiling). Where song and bass together would pass
 *   the ceiling, only the bass is held back, only there and only as far as needed (a 15 ms look-ahead that eases in and
 *   a 250 ms recovery, so it never distorts).
 *   Then the waveform between the samples is checked (4x oversampled); if it would pass the ceiling, the bass is fitted
 *   under a ceiling lowered by the overshoot, and checked again.
 *   A song whose own waveform already goes over the ceiling between samples (many masters do) keeps doing exactly that:
 *   the result is never over by more than the song alone was, and the bass gives way there. Only where the song's own
 *   samples would pass full scale with no bass at all (taking the old bass out of a master that was clipped to begin with
 *   can do that) is the song itself eased under full scale, there and nowhere else (the same 15 ms / 250 ms easing).
 * Returns { out: [L, R], stats }.
 */
export function rebassMix(chs, bass, bassPeak, sr, opts) {
  const { bassDb = -3, ceilingDb = -0.1, band = null, progress } = opts;
  const C0 = dbToLin(ceilingDb);
  const nCh = chs.length, n = chs[0].length;
  const music = chs.map((c) => Float32Array.from(c));
  // the chosen range belongs to the new bass alone: the song's content below the top of the range comes out (a little
  // above it too, up to 90 Hz at most, below any voice), so the new notes are what that part of the song is made of.
  // Nothing higher is touched.
  if (band) bandStop(music, sr, 1, Math.max(band[1], Math.min(band[1] * 1.25, 90)));
  progress && progress(0.2);
  const A = bassPeak > 0 ? Math.min(dbToLin(bassDb), C0) / bassPeak : 0;
  // the song's own samples past full scale (normally none): eased under it just there
  const h0 = Math.max(1, Math.round(0.015 * sr)), rel0 = 1 / (0.25 * sr);
  const sNeed = new Float32Array(n).fill(1);
  let over0 = false;
  for (const m of music) for (let i = 0; i < n; i++) { const a = m[i] < 0 ? -m[i] : m[i]; if (a > 0.9999) { const g = 0.9999 / a; if (g < sNeed[i]) sNeed[i] = g; over0 = true; } }
  let gSong = 1, touched = 0;
  if (over0) {
    const ks = boxAverage(slidingMin(sNeed, h0), h0, true);
    for (let i = 1; i < n; i++) if (ks[i] > ks[i - 1] + rel0) ks[i] = ks[i - 1] + rel0;
    for (let i = 0; i < n; i++) { const g = Math.min(ks[i], sNeed[i]); if (g < 0.999) touched++; if (g < gSong) gSong = g; for (const m of music) m[i] *= g; }
  }
  // between the samples: never over by more than the song alone
  const songTp = truePeak(music, C0 * 0.7), TP = Math.max(C0, songTp);
  const need = new Float32Array(n), out = music.map(() => new Float32Array(n));
  const h = Math.max(1, Math.round(0.015 * sr)), rel = 1 / (0.25 * sr);
  let C = C0, tp = 0, k = null;
  for (let pass = 0; pass < 6; pass++) {
    // the most of the bass each sample can take with the song as it is
    for (let i = 0; i < n; i++) {
      const b = bass[i] * A;
      let g = 1;
      if (b !== 0) for (let c = 0; c < nCh; c++) {
        const m = music[c][i];
        // |m + g b| <= C, with g in [0, 1]
        const room = b > 0 ? C - m : C + m;
        const gc = room <= 0 ? 0 : room / Math.abs(b);
        if (gc < g) g = gc;
      }
      need[i] = g;
    }
    // eased: never more than allowed (a minimum over +-h, then an average over +-h, then a slow recovery)
    k = boxAverage(slidingMin(need, h), h, true);
    for (let i = 1; i < n; i++) if (k[i] > k[i - 1] + rel) k[i] = k[i - 1] + rel;
    for (let i = 0; i < n; i++) { const g = Math.min(k[i], need[i]); k[i] = g; const b = bass[i] * A * g; for (let c = 0; c < nCh; c++) out[c][i] = music[c][i] + b; }
    progress && progress(0.3 + pass * 0.1);
    // the waveform between the samples: if it would pass, fit the bass under a lower ceiling and go again
    tp = truePeak(out, C0 * 0.7);
    if (tp <= TP * 1.0001) break;
    C *= (TP / tp) * 0.999;
  }
  // a last sliver over: the bass out entirely where it still would be (the song alone fits, see above)
  if (tp > TP * 1.0001) {
    for (let i = 0; i < n; i++) { let a = 0; for (let c = 0; c < nCh; c++) a = Math.max(a, Math.abs(out[c][i])); if (a > C0 * 0.97) { k[i] = 0; for (let c = 0; c < nCh; c++) out[c][i] = music[c][i]; } }
    tp = truePeak(out, C0 * 0.7);
  }
  progress && progress(0.95);
  let peak = 0, over = 0, bassOn = 0, held = 0, bassPk = 0, eSet = 0, eGot = 0;
  for (let i = 0; i < n; i++) {
    const b = Math.abs(bass[i] * A);
    if (b > 0.01 * A * bassPeak) { bassOn++; if (k[i] < 0.97) held++; }
    if (b * k[i] > bassPk) bassPk = b * k[i];
    eSet += b * b; eGot += b * b * k[i] * k[i];
  }
  for (const o of out) for (let i = 0; i < n; i++) { const a = Math.abs(o[i]); if (a > peak) peak = a; if (a >= 1) over++; }
  if (nCh === 1) out.push(Float32Array.from(out[0]));
  return {
    out,
    stats: {
      peakDb: linToDb(peak), truePeakDb: linToDb(tp), clipped: over, bassGain: A, bassActualDb: linToDb(A * bassPeak), bassPlayedDb: linToDb(bassPk),
      songDb: linToDb(gSong), songTouchedPct: (100 * touched) / n, bassKeptDb: eSet > 0 ? 10 * Math.log10(eGot / eSet) : 0, songTruePeakDb: linToDb(songTp), heldPct: bassOn ? (100 * held) / bassOn : 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------------- files
/** WAV, 16- or 24-bit PCM with TPDF dither, or 32-bit float. */
export function encodeWav(chs, sr, bits = 16) {
  const nCh = chs.length, n = chs[0].length, bps = bits / 8;
  const fmt = bits === 32 ? 3 : 1;
  const dataLen = n * nCh * bps;
  const buf = new ArrayBuffer(44 + dataLen), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, fmt, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nCh * bps, true); v.setUint16(32, nCh * bps, true); v.setUint16(34, bits, true);
  str(36, "data"); v.setUint32(40, dataLen, true);
  let o = 44;
  if (bits === 32) {
    for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) { v.setFloat32(o, chs[c][i], true); o += 4; }
    return buf;
  }
  const full = bits === 16 ? 32767 : 8388607;
  let seed = 22222;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      let q = Math.round(chs[c][i] * full + (rnd() - rnd()));
      if (q > full) q = full; else if (q < -full - 1) q = -full - 1;
      if (bits === 16) { v.setInt16(o, q, true); o += 2; }
      else { v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255); o += 3; }
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------------------------------- tones
/** Pink noise (Paul Kellet's refined filter), unit-ish level. */
export function pinkNoise(n, seed = 1) {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const w = s / 2147483648 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}
