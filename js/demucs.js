// The bass separator's maths, without the network itself: HTDemucs (htdemucs_ft, bass) runs as an ONNX graph that
// takes the 7.8 s stereo segment and its spectrogram and returns the bass, as a spectrogram plus a waveform. Here:
// the spectrogram and its inverse exactly as Demucs makes them, the overlapping segments with their triangle
// cross-fades (as Demucs' apply_model), and a clean resampler for songs that are not at 44.1 kHz.
// `run(seg, spec)` is the network: it gets Float32Array [2 x SEG] and [4 x 2048 x LE] and resolves {z, xt}.

export const SR = 44100, SEG = 343980, NFFT = 4096, HOP = 1024, NB = 2048, LE = Math.ceil(SEG / HOP);
const PAD = (HOP >> 1) * 3; // 1536

// ------------------------------------------------------------------------------------------------ one FFT size
const N = NFFT, LOG = 12;
const WIN = new Float64Array(N), COS = new Float64Array(N >> 1), SIN = new Float64Array(N >> 1), REV = new Uint16Array(N);
for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
for (let i = 0; i < N >> 1; i++) { COS[i] = Math.cos((2 * Math.PI * i) / N); SIN[i] = -Math.sin((2 * Math.PI * i) / N); }
for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < LOG; b++) r |= ((i >> b) & 1) << (LOG - 1 - b); REV[i] = r; }

/** In place, size 4096. inverse: conjugate twiddles, no 1/N. */
function fft(re, im, inverse) {
  for (let i = 0; i < N; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  const sg = inverse ? -1 : 1;
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let s = 0; s < N; s += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = COS[t], wi = sg * SIN[t];
        const a = s + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** The network's spectrogram input for one segment: [L.re, L.im, R.re, R.im] x 2048 bins x LE frames.
 *  Same as Demucs: reflect padding so frame j is centred at j*HOP + HOP/2, hann window, 1/sqrt(N). */
export function spec(L, R) {
  const out = new Float32Array(4 * NB * LE);
  const re = new Float64Array(N), im = new Float64Array(N);
  const n = L.length, sc = 1 / Math.sqrt(N);
  const at = (x, p) => (p < 0 ? x[-p] : p >= n ? x[2 * (n - 1) - p] : x[p]);
  for (let j = 0; j < LE; j++) {
    const p0 = j * HOP - PAD;
    if (p0 >= 0 && p0 + N <= n) for (let i = 0; i < N; i++) { re[i] = L[p0 + i] * WIN[i]; im[i] = R[p0 + i] * WIN[i]; }
    else for (let i = 0; i < N; i++) { re[i] = at(L, p0 + i) * WIN[i]; im[i] = at(R, p0 + i) * WIN[i]; }
    fft(re, im, false);
    // two real signals in one transform: L = (Z[k] + conj Z[N-k]) / 2, R = (Z[k] - conj Z[N-k]) / 2i
    for (let k = 0; k < NB; k++) {
      const m = (N - k) & (N - 1);
      const zr = re[k], zi = im[k], cr = re[m], ci = -im[m];
      out[(0 * NB + k) * LE + j] = 0.5 * (zr + cr) * sc;
      out[(1 * NB + k) * LE + j] = 0.5 * (zi + ci) * sc;
      out[(2 * NB + k) * LE + j] = 0.5 * (zi - ci) * sc;
      out[(3 * NB + k) * LE + j] = -0.5 * (zr - cr) * sc;
    }
  }
  return out;
}

/** The inverse, added onto (oL, oR) (length n): Nyquist bin zero, hann window, overlap-add, / 1.5 (hann^2 at 75%). */
export function ispecAdd(z, oL, oR) {
  const re = new Float64Array(N), im = new Float64Array(N);
  const n = oL.length, sc = Math.sqrt(N) / N / 1.5;
  for (let j = 0; j < LE; j++) {
    re.fill(0); im.fill(0);
    // Z = X_L + i X_R, with the Hermitian half filled in, so one inverse gives L in re and R in im
    for (let k = 0; k < NB; k++) {
      const lr = z[(0 * NB + k) * LE + j], li = z[(1 * NB + k) * LE + j];
      const rr = z[(2 * NB + k) * LE + j], ri = z[(3 * NB + k) * LE + j];
      // (the DC bin of a real signal has no imaginary part: an inverse real FFT ignores it, so must this)
      if (k === 0) { re[0] = lr; im[0] = rr; continue; }
      re[k] = lr - ri; im[k] = li + rr;
      const m = N - k; re[m] = lr + ri; im[m] = -li + rr;
    }
    fft(re, im, true);
    const p0 = j * HOP - PAD;
    const i0 = Math.max(0, -p0), i1 = Math.min(N, n - p0);
    for (let i = i0; i < i1; i++) { oL[p0 + i] += re[i] * WIN[i] * sc; oR[p0 + i] += im[i] * WIN[i] * sc; }
  }
}

// ------------------------------------------------------------------------------------------------ resampling
/** Windowed-sinc (Kaiser) resampler, flat to 0.95 x the lower Nyquist. */
export function resample(x, from, to) {
  if (from === to) return Float32Array.from(x);
  const ratio = to / from, n = Math.floor(x.length * ratio);
  const fc = Math.min(1, ratio) * 0.955, Z = 32, P = 512; // zero crossings each side, table phases per sample
  const half = Math.ceil(Z / fc);
  const beta = 9;
  const i0 = (v) => { let s = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (v / (2 * k)) ** 2; s += t; if (t < 1e-12 * s) break; } return s; };
  const ib = i0(beta);
  const tab = new Float64Array(half * P + 2);
  for (let i = 0; i < tab.length; i++) {
    const d = i / P; // distance in input samples
    if (d > half) { tab[i] = 0; continue; }
    const xx = d * fc * Math.PI, w = i0(beta * Math.sqrt(Math.max(0, 1 - (d / half) ** 2))) / ib;
    tab[i] = (d === 0 ? 1 : Math.sin(xx) / xx) * fc * w;
  }
  const out = new Float32Array(n), m = x.length;
  for (let k = 0; k < n; k++) {
    const t = k / ratio, c = Math.floor(t), f = t - c;
    let s = 0;
    const a = Math.max(0, c - half + 1), b = Math.min(m - 1, c + half);
    for (let i = a; i <= b; i++) {
      const d = Math.abs(i - c - f) * P, di = d | 0, fr = d - di;
      s += x[i] * (tab[di] + (tab[di + 1] - tab[di]) * fr);
    }
    out[k] = s;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ whole songs
/** The bass of a stereo song (Float32Array channels at `sr`), as two channels at `sr`.
 *  progress(p) runs 0..1; `run` is the network. Same steps as Demucs' separate: normalise, 7.8 s segments
 *  with 25% overlap and triangle cross-fades, each padded from its neighbours, then back to the song's scale. */
export async function separateBass(chs, sr, run, progress = () => {}, overlap = 0.25) {
  const L0 = chs[0], R0 = chs[1] || chs[0];
  const L = sr === SR ? L0 : resample(L0, sr, SR), R = sr === SR ? R0 : resample(R0, sr, SR);
  const n = L.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += (L[i] + R[i]) * 0.5;
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = (L[i] + R[i]) * 0.5 - mean; v += d * d; }
  const std = Math.sqrt(v / Math.max(1, n - 1)) || 1;
  const stride = Math.floor((1 - overlap) * SEG);
  const offsets = [];
  for (let o = 0; o < n; o += stride) offsets.push(o);
  const halfSeg = SEG >> 1, wMax = halfSeg;
  const weight = (i) => (i < halfSeg ? i + 1 : SEG - i) / wMax;
  const oL = new Float32Array(n), oR = new Float32Array(n), sumW = new Float32Array(n);
  const sL = new Float32Array(SEG), sR = new Float32Array(SEG), seg = new Float32Array(2 * SEG);
  for (let s = 0; s < offsets.length; s++) {
    const off = offsets[s], len = Math.min(SEG, n - off), delta = SEG - len, start = off - (delta >> 1);
    for (let i = 0; i < SEG; i++) {
      const p = start + i;
      const ok = p >= 0 && p < n;
      sL[i] = ok ? (L[p] - mean) / std : 0;
      sR[i] = ok ? (R[p] - mean) / std : 0;
    }
    seg.set(sL, 0); seg.set(sR, SEG);
    const { z, xt } = await run(seg, spec(sL, sR));
    const yL = xt.slice(0, SEG), yR = xt.slice(SEG, 2 * SEG);
    ispecAdd(z, yL, yR);
    const c0 = delta >> 1;
    for (let i = 0; i < len; i++) {
      const w = weight(i);
      oL[off + i] += w * yL[c0 + i]; oR[off + i] += w * yR[c0 + i]; sumW[off + i] += w;
    }
    progress((s + 1) / offsets.length);
  }
  for (let i = 0; i < n; i++) { const w = sumW[i]; oL[i] = (oL[i] / w) * std + mean; oR[i] = (oR[i] / w) * std + mean; }
  if (sr === SR) return [oL, oR];
  const bL = resample(oL, SR, sr), bR = resample(oR, SR, sr);
  // the same length as the song
  const m = L0.length, fix = (b) => (b.length === m ? b : (() => { const o = new Float32Array(m); o.set(b.subarray(0, m)); return o; })());
  return [fix(bL), fix(bR)];
}
