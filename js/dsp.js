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

// ---------------------------------------------------------------------------------------------------- finding the bass
/**
 * Finds the song's bass line: a pitch (YIN, on the low end alone) and a loudness every 10 ms.
 * Returns { hop (s), t0 (s, time of the first frame), f0 (Hz, 0 where no clear note), conf, env (0..1), lo, hi (the song's
 * own bass range, Hz) }.
 */
export function analyzeBass(mono, sr, progress) {
  const lp = Float32Array.from(mono);
  butter4(lp, "lp", 280, sr);
  progress && progress(0.25);
  // the low end needs only a couple of thousand samples a second
  const D = Math.max(1, Math.floor(sr / 2400)), fsd = sr / D;
  const n = Math.floor(lp.length / D);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = lp[i * D];
  const hop = Math.max(1, Math.round(0.01 * fsd));
  const W = Math.round(0.075 * fsd);
  const tauMin = Math.max(2, Math.floor(fsd / 330)), tauMax = Math.ceil(fsd / 24);
  const frames = Math.max(0, Math.floor((n - W - tauMax - 1) / hop));
  const f0 = new Float32Array(frames), conf = new Float32Array(frames), rms = new Float32Array(frames);
  const d = new Float32Array(tauMax + 2), dn = new Float32Array(tauMax + 2);
  for (let fi = 0; fi < frames; fi++) {
    const s = fi * hop;
    let e = 0;
    for (let j = 0; j < W; j++) e += x[s + j] * x[s + j];
    rms[fi] = Math.sqrt(e / W);
    if (rms[fi] < 1e-4) continue;
    // YIN: difference function, cumulative-mean normalised, first dip under the threshold
    let run = 0;
    dn[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let acc = 0;
      for (let j = 0; j < W; j++) { const v = x[s + j] - x[s + j + tau]; acc += v * v; }
      d[tau] = acc; run += acc;
      dn[tau] = run > 0 ? (acc * tau) / run : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (dn[tau] < 0.2) { while (tau + 1 < tauMax && dn[tau + 1] < dn[tau]) tau++; best = tau; break; }
    }
    if (best < 0) {
      // no dip under the threshold: take the global minimum if it is still fairly clear
      let m = 1e9; for (let tau = tauMin; tau < tauMax; tau++) if (dn[tau] < m) { m = dn[tau]; best = tau; }
      if (m > 0.35) best = -1;
    }
    if (best > 0) {
      const a = dn[best - 1], b = dn[best], c = dn[best + 1];
      const den = a - 2 * b + c;
      const off = Math.abs(den) > 1e-9 ? 0.5 * (a - c) / den : 0;
      f0[fi] = fsd / (best + Math.max(-0.5, Math.min(0.5, off)));
      conf[fi] = 1 - b;
    }
    if (progress && (fi & 1023) === 0) progress(0.25 + 0.7 * (fi / frames));
  }
  // loudness: normalised to the song's own loud bass, a little compressed for punch
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.985)] || 1;
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const v = Math.min(1.25, rms[i] / ref);
    env[i] = Math.tanh(1.5 * v) / Math.tanh(1.5);
  }
  // steady the pitch: a median over 5 frames, short dropouts bridged while the bass still sounds
  const med = new Float32Array(frames);
  const win = [];
  for (let i = 0; i < frames; i++) {
    win.length = 0;
    for (let k = -2; k <= 2; k++) { const v = f0[i + k]; if (v > 0) win.push(v); }
    if (f0[i] > 0 && win.length >= 3) { win.sort((a, b) => a - b); med[i] = win[win.length >> 1]; }
  }
  // octave slips: a frame an octave off the notes either side of it belongs with them
  const oct = Float32Array.from(med);
  for (let i = 0; i < frames; i++) {
    if (!(med[i] > 0)) continue;
    win.length = 0;
    for (let k = -6; k <= 6; k++) { const v = med[i + k]; if (k && v > 0) win.push(v); }
    if (win.length < 6) continue;
    win.sort((a, b) => a - b);
    const ref = win[win.length >> 1], r = Math.log2(med[i] / ref);
    if (Math.abs(Math.abs(r) - 1) < 0.08) oct[i] = med[i] * Math.pow(2, -Math.round(r));
  }
  med.set(oct);
  let last = 0, gap = 0;
  for (let i = 0; i < frames; i++) {
    if (med[i] > 0) { last = med[i]; gap = 0; }
    else if (last > 0 && env[i] > 0.12 && ++gap <= 8) med[i] = last;
    else if (env[i] <= 0.12) gap = 99;
  }
  const voiced = Array.from(med).filter((v) => v > 0).sort((a, b) => a - b);
  const lo = voiced.length ? voiced[Math.floor(voiced.length * 0.05)] : 40;
  const hi = voiced.length ? voiced[Math.floor(voiced.length * 0.95)] : 100;
  progress && progress(1);
  return { hop: hop / fsd, t0: (W / 2) / fsd, f0: med, conf, env, lo, hi };
}

// ---------------------------------------------------------------------------------------------------- the new bass
const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function noteName(f) {
  if (!(f > 0)) return "";
  const m = 69 + 12 * Math.log2(f / 440), r = Math.round(m), cents = Math.round((m - r) * 100);
  return `${NOTE[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}` + (cents ? ` ${cents > 0 ? "+" : "−"}${Math.abs(cents)}¢` : "");
}

/**
 * Where each bass note goes. "musical": the same note, dropped (or raised) by whole octaves into lo..hi, so it stays in
 * key. "stretch": the song's own bass range laid across lo..hi, keeping the shape of the bass line.
 * snap: tune to the nearest semitone (after finding the song's own tuning).
 */
export function mapBassLine(an, { lo, hi, mode = "musical", snap = true }) {
  const n = an.f0.length, out = new Float32Array(n);
  let tune = 0;
  if (snap) {
    // the song's tuning: the average offset of its bass notes from the 440 Hz semitone grid
    let sx = 0, sy = 0, cnt = 0;
    for (let i = 0; i < n; i += 3) if (an.f0[i] > 0 && an.env[i] > 0.2) {
      const m = 12 * Math.log2(an.f0[i] / 440), d = (m - Math.round(m)) * 2 * Math.PI;
      sx += Math.cos(d); sy += Math.sin(d); cnt++;
    }
    if (cnt) tune = Math.atan2(sy, sx) / (2 * Math.PI);
  }
  const sLo = Math.log2(Math.max(an.lo, 1)), sHi = Math.log2(Math.max(an.hi, an.lo * 1.01, 1));
  const tLo = Math.log2(lo), tHi = Math.log2(hi);
  for (let i = 0; i < n; i++) {
    let f = an.f0[i];
    if (!(f > 0)) continue;
    if (snap) { const m = 12 * Math.log2(f / 440) - tune; f = 440 * Math.pow(2, (Math.round(m) + tune) / 12); }
    if (mode === "stretch") {
      const u = Math.min(1, Math.max(0, (Math.log2(f) - sLo) / (sHi - sLo)));
      f = Math.pow(2, tLo + u * (tHi - tLo));
    } else if (hi / lo >= 2) {
      while (f > hi) f /= 2;
      while (f < lo) f *= 2;
    } else if (hi / lo >= 1.5) {
      // most of an octave (25-45 Hz, say): the same note, folded in, still in key; the few notes that fall in the gap
      // above hi go to whichever edge is closer, always the same one for the same note
      while (f >= 2 * lo) f /= 2;
      while (f < lo) f *= 2;
      if (f > hi) f = Math.log2(f / hi) <= Math.log2((2 * lo) / f) ? hi : lo;
    } else {
      // a very narrow range (23-30 Hz, say): each note is folded into the octave above lo, and that octave laid across
      // the range, so a given note always plays the same frequency (never bounced between the two edges)
      while (f >= 2 * lo) f /= 2;
      while (f < lo) f *= 2;
      f = lo * Math.pow(hi / lo, Math.log2(f / lo));
    }
    out[i] = Math.min(hi, Math.max(lo, f));
  }
  // hold notes steady; in a narrow range, hold them longer still (a deep sub with fewer, cleaner moves)
  return stabilize(out, hi / lo < 2 ? 8 : 5);
}

/**
 * Holds each note steady: frames within 35 cents of a note's start are one note (played at its median pitch), and any
 * note shorter than minLen frames (a flicker between two notes) joins the longer neighbour it touches. Done on the
 * whole song at once, so a new note starts exactly when it starts, never late.
 */
export function stabilize(f, minLen) {
  const n = f.length, segs = [];
  for (let i = 0; i < n;) {
    if (!(f[i] > 0)) { const s = i; while (i < n && !(f[i] > 0)) i++; segs.push({ s, e: i, f: 0 }); continue; }
    const s = i, base = f[i];
    while (i < n && f[i] > 0 && Math.abs(1200 * Math.log2(f[i] / base)) < 35) i++;
    const v = Array.from(f.subarray(s, i)).sort((a, b) => a - b);
    segs.push({ s, e: i, f: v[v.length >> 1] });
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 0; k < segs.length; k++) {
      const g = segs[k];
      if (!g.f || g.e - g.s >= minLen) continue;
      const a = segs[k - 1], b = segs[k + 1];
      const la = a && a.f ? a.e - a.s : -1, lb = b && b.f ? b.e - b.s : -1;
      if (la < 0 && lb < 0) continue;
      g.f = la >= lb ? a.f : b.f;
    }
  }
  const out = new Float32Array(n);
  for (const g of segs) out.fill(g.f, g.s, g.e);
  return out;
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

/**
 * Builds the new bass: one clean sine following the mapped notes, its phase continuous across note changes (no clicks),
 * gliding 6 ms between notes, its loudness following the song's own bass. Returns mono, peak 1.
 */
export function synthBass(an, mapped, sr, length, progress) {
  const out = new Float32Array(length);
  const n = mapped.length;
  const kG = 1 - Math.exp(-1 / (0.012 * sr));
  const kA = 1 - Math.exp(-1 / (0.008 * sr)), kR = 1 - Math.exp(-1 / (0.09 * sr));
  // the target loudness per frame: only where there is a note to play, gated in the quiet, smoothed over 50 ms (within
  // each note) so the sine swells and settles cleanly instead of fluttering with every drum hit
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = mapped[i] > 0 ? an.env[i] : 0;
  const tgt = new Float32Array(n);
  const W = [1, 2, 3, 2, 1];
  for (let i = 0; i < n; i++) {
    if (!(raw[i] > 0)) continue;
    let s = 0, w = 0;
    for (let k = -2; k <= 2; k++) { const v = raw[i + k]; if (v > 0) { s += v * W[k + 2]; w += W[k + 2]; } }
    tgt[i] = s / w;
    if (tgt[i] < 0.05) tgt[i] = 0;
  }
  let ph = 0, f = 0, e = 0, peak = 0;
  // start on the first note so the sine never sweeps up from zero
  for (let i = 0; i < n; i++) if (mapped[i] > 0) { f = mapped[i]; break; }
  if (!f) return { bass: out, peak: 0 };
  for (let s = 0; s < length; s++) {
    const p = (s / sr - an.t0) / an.hop;
    let i0 = Math.floor(p); const u = p - i0;
    let fT, eT;
    if (i0 < 0) { fT = mapped[0] || f; eT = 0; }
    else if (i0 >= n - 1) { fT = f; eT = 0; }
    else {
      const a = mapped[i0], b = mapped[i0 + 1];
      fT = a > 0 && b > 0 ? a + (b - a) * u : (a > 0 ? a : (b > 0 ? b : f));
      eT = tgt[i0] + (tgt[i0 + 1] - tgt[i0]) * u;
    }
    f += (fT - f) * kG;
    e += (eT - e) * (eT > e ? kA : kR);
    ph += (2 * Math.PI * f) / sr;
    if (ph > 6.283185307179586) ph -= 6.283185307179586;
    const v = Math.sin(ph) * e;
    out[s] = v;
    const av = v < 0 ? -v : v;
    if (av > peak) peak = av;
    if (progress && (s & 262143) === 0) progress(s / length);
  }
  // fade the ends so nothing starts or stops with a click
  const fade = Math.min(length >> 1, Math.round(0.02 * sr));
  for (let s = 0; s < fade; s++) { const g = s / fade; out[s] *= g; out[length - 1 - s] *= g; }
  return { bass: out, peak };
}

// ---------------------------------------------------------------------------------------------------- mixing without clipping
/** Sliding minimum over the centred window [i-h, i+h] (a monotonic queue, O(n)). */
export function slidingMin(x, h) {
  const n = x.length, out = new Float32Array(n), dq = new Int32Array(n);
  let head = 0, tail = 0, r = 0;
  for (let i = 0; i < n; i++) {
    const last = Math.min(n - 1, i + h);
    while (r <= last) {
      while (tail > head && x[dq[tail - 1]] >= x[r]) tail--;
      dq[tail++] = r++;
    }
    while (dq[head] < i - h) head++;
    out[i] = x[dq[head]];
  }
  return out;
}

/** Centred moving average over 2h+1 (prefix sums in doubles). */
function boxAverage(x, h) {
  const n = x.length, out = new Float32Array(n), cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
    out[i] = (cs[b] - cs[a]) / (b - a);
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
 * Lays the new bass under the song with no clipping, and with as little compression as possible.
 *   The bass plays at exactly bassDb (dBFS, its loudest point; never above the ceiling).
 *   The song is given ONE fixed level for its whole length, the highest at which song and bass together never pass the
 *   ceiling: no compression at all, the song's own dynamics untouched. Only if that fixed level would have to drop below
 *   floorDb (an extreme bass setting on a loud master) does the song sit at floorDb and ride down gently (a 15 ms
 *   look-ahead, 250 ms recovery) where, and only as far as, the two would still clip.
 *   Then the waveform between the samples is checked (4x oversampled); if it would pass the ceiling, the song (not the
 *   bass) is fitted under a ceiling lowered by the overshoot, and checked again.
 * Returns { out: [L, R], stats }.
 */
export function rebassMix(chs, bass, bassPeak, sr, opts) {
  const { bassDb = -3, ceilingDb = -0.1, replaceHz = 0, floorDb = -9, progress } = opts;
  const C0 = dbToLin(ceilingDb);
  const nCh = chs.length, n = chs[0].length;
  const music = chs.map((c) => Float32Array.from(c));
  if (replaceHz > 0) music.forEach((m) => butter4(m, "hp", replaceHz, sr));
  progress && progress(0.2);
  const A = bassPeak > 0 ? Math.min(dbToLin(bassDb), C0) / bassPeak : 0;
  const floor = dbToLin(floorDb);
  const lim = new Float32Array(n);
  const out = music.map(() => new Float32Array(n));
  let C = C0, tp = 0, gStatic = 1, rideMin = 1, rideFrac = 0;
  for (let pass = 0; pass < 4; pass++) {
    // the most the song may be kept at, sample by sample, with the bass under it
    gStatic = 1;
    for (let i = 0; i < n; i++) {
      const b = bass[i] * A;
      let g = 1;
      for (let c = 0; c < nCh; c++) {
        const m = music[c][i];
        const am = m < 0 ? -m : m;
        if (am < 1e-9) continue;
        const room = (m >= 0) === (b >= 0) ? C - Math.abs(b) : C + Math.abs(b);
        const gc = room / am;
        if (gc < g) g = gc;
      }
      lim[i] = g < 0 ? 0 : g;
      if (lim[i] < gStatic) gStatic = lim[i];
    }
    progress && progress(0.3 + pass * 0.15);
    rideMin = 1; rideFrac = 0;
    if (gStatic >= floor) {
      // one fixed level: no compression
      for (let i = 0; i < n; i++) { const b = bass[i] * A; for (let c = 0; c < nCh; c++) out[c][i] = music[c][i] * gStatic + b; }
    } else {
      // the floor, and a gentle ride below it only where needed (never exceeding the limit: a minimum over +-h, then an
      // average over +-h, then a slow recovery)
      gStatic = floor;
      for (let i = 0; i < n; i++) lim[i] = Math.min(1, lim[i] / floor);
      const h = Math.max(1, Math.round(0.015 * sr));
      const r = boxAverage(slidingMin(lim, h), h);
      const rel = 1 / (0.25 * sr);
      for (let i = 1; i < n; i++) if (r[i] > r[i - 1] + rel) r[i] = r[i - 1] + rel;
      let ridden = 0;
      for (let i = 0; i < n; i++) {
        const g = Math.min(r[i], lim[i]);
        if (g < rideMin) rideMin = g;
        if (g < 0.99) ridden++;
        const b = bass[i] * A, gg = floor * g;
        for (let c = 0; c < nCh; c++) out[c][i] = music[c][i] * gg + b;
      }
      rideFrac = ridden / n;
    }
    // the waveform between the samples: if it would pass, fit the song under a lower ceiling and go again
    tp = truePeak(out, C0 * 0.7);
    if (tp <= C0 * 1.0001) break;
    C *= (C0 / tp) * 0.999;
  }
  progress && progress(0.95);
  let peak = 0, over = 0;
  for (const o of out) for (let i = 0; i < n; i++) { const a = Math.abs(o[i]); if (a > peak) peak = a; if (a >= 1) over++; }
  if (nCh === 1) out.push(Float32Array.from(out[0]));
  return {
    out,
    stats: {
      peakDb: linToDb(peak), truePeakDb: linToDb(tp), clipped: over, bassGain: A, bassActualDb: linToDb(A * bassPeak),
      songDb: linToDb(gStatic), rideDb: linToDb(rideMin), ridePct: 100 * rideFrac,
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
