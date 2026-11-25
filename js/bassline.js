// FifTeam Media - the bass line. Finds a song's true bass notes (and only those), decides where each one goes in the
// chosen range, and plays the new bass: the same notes, at the same moments, with the same rise and fall, only at the new
// frequencies. Plain functions over Float32Arrays; runs in the rebass worker and in Node for the tests.
//
//   analyzeBassLine(mono, sr)          -> the notes, and the original bass's own loudness, moment by moment
//   planMapping(an, lo, hi, speed)     -> where each note goes (an octave down if the line fits, else squeezed in)
//   renderBass(an, plan, sr, n, speed) -> the new bass, one clean sine
import { butter4, fft } from "./dsp.js";

export const hz2st = (f) => 69 + 12 * Math.log2(f / 440);
export const st2hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
function wmedian(vals, ws) {
  if (!vals.length) return 0;
  const idx = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
  let tot = 0; for (const w of ws) tot += w;
  let acc = 0;
  for (const i of idx) { acc += ws[i]; if (acc >= tot / 2) return vals[i]; }
  return vals[idx[idx.length - 1]];
}
const median = (a) => { if (!a.length) return 0; const b = Float64Array.from(a).sort(); return b[b.length >> 1]; };
/** The largest value within h samples either side, for every sample (a running deque, linear time). */
function slidingMax(x, h) {
  const n = x.length, out = new Float32Array(n), q = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n + h; i++) {
    if (i < n) { while (qt > qh && x[q[qt - 1]] <= x[i]) qt--; q[qt++] = i; }
    const c = i - h;
    if (c >= 0) { while (q[qh] < c - h) qh++; out[c] = x[q[qh]]; }
  }
  return out;
}

/**
 * The song's bass line.
 *   1. The low end alone (below 170 Hz) at about 2000 samples a second.
 *   2. Every 10 ms: its pitch (YIN, 24-175 Hz), how clearly pitched it is, and how loud.
 *   3. Runs of frames on one pitch become candidate notes. Each is judged: a drum (dies away faster than any bass note:
 *      a kick's tail), noise, too high, or too weak next to the song's real bass notes are all thrown out. What is left
 *      are the bass notes: sustained, pitched, low, and as strong as the song's bass.
 *   4. Each note's start is found to the millisecond from the attack; its end from where it dies away. Notes that run
 *      into each other (a slide, or a change with no break) are linked, so the new bass glides between them the same way.
 *   5. The original bass's own loudness through every note: the low end demodulated at the note's own pitch, so a kick
 *      or anything else at another pitch doesn't get in. The new bass rises and falls exactly with it.
 * Returns { fs, hop, t0, f0 (Hz per frame, 0 off notes), env (0..1 per frame), amp (0..1 at fs), notes, tune, lo, hi,
 *   dropped: { drums, other } }.
 */
export function analyzeBassLine(mono, sr, progress, dbg, opts = {}) {
  const say = (p) => progress && progress(p);
  // stem: the input is the bass alone (separated from the song). Then everything in it is bass: nothing is thrown out
  // for being short, quiet, punchy or high, only what is too weak to be anything but the separation's leftovers
  const stem = !!opts.stem, fTop = stem ? 260 : 175;
  // 1 ---------------------------------------------------------------------------------------------------------------
  const lp = Float32Array.from(mono);
  butter4(lp, "lp", stem ? 300 : 170, sr);
  const D = Math.max(1, Math.round(sr / 2000)), fs = sr / D;
  const n = Math.floor((lp.length - 1) / D) + 1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = lp[i * D];
  say(0.08);
  // 2 ---------------------------------------------------------------------------------------------------------------
  const hop = Math.max(1, Math.round(0.01 * fs)), hopS = hop / fs;
  const W = Math.round(0.07 * fs);
  const tauMin = Math.floor(fs / fTop), tauMax = Math.ceil(fs / 24);
  const F = Math.max(0, Math.floor((n - W - tauMax - 1) / hop));
  const t0 = W / 2 / fs;
  const raw = new Float32Array(F), ap = new Float32Array(F).fill(1), rms = new Float32Array(F);
  const dn = new Float64Array(tauMax + 2);
  for (let fi = 0; fi < F; fi++) {
    const s = fi * hop;
    let e = 0;
    for (let j = 0; j < W; j++) e += x[s + j] * x[s + j];
    rms[fi] = Math.sqrt(e / W);
    if (rms[fi] < 1e-5) continue;
    let run = 0; dn[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let acc = 0;
      for (let j = 0; j < W; j++) { const v = x[s + j] - x[s + j + tau]; acc += v * v; }
      run += acc; dn[tau] = run > 0 ? (acc * tau) / run : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau < tauMax; tau++) if (dn[tau] < 0.15) { while (tau + 1 < tauMax && dn[tau + 1] < dn[tau]) tau++; best = tau; break; }
    if (best < 0) { let m = 1e9; for (let tau = tauMin; tau < tauMax; tau++) if (dn[tau] < m) { m = dn[tau]; best = tau; } if (m > 0.4) best = -1; }
    if (best > 0) {
      const a = dn[best - 1], b = dn[best], c = dn[best + 1], den = a - 2 * b + c;
      const off = Math.abs(den) > 1e-12 ? (0.5 * (a - c)) / den : 0;
      raw[fi] = fs / (best + Math.max(-0.5, Math.min(0.5, off)));
      ap[fi] = b;
    }
    if ((fi & 511) === 0) say(0.08 + (0.55 * fi) / Math.max(1, F));
  }
  // the song's bass level, and the quietest that still counts
  const loud = Array.from(rms).filter((r) => r > 1e-5).sort((a, b) => a - b);
  const R = loud.length ? loud[Math.floor(loud.length * 0.95)] : 1e-9;
  const gate = R * 0.02;                                   // -34 dB
  const m = new Float32Array(F);                           // pitch in semitones (MIDI numbers); 0 = no clear low note
  for (let i = 0; i < F; i++) if (raw[i] > 0 && ap[i] < 0.3 && rms[i] > gate) m[i] = hz2st(raw[i]);
  const med = new Float32Array(F);
  { const win = [];
    for (let i = 0; i < F; i++) {
      if (!m[i]) continue;
      win.length = 0;
      for (let k = -2; k <= 2; k++) { const v = m[i + k]; if (v) win.push(v); }
      if (win.length >= 3) { win.sort((a, b) => a - b); med[i] = win[win.length >> 1]; }
    } }
  // a brief slip to the octave above or below, against the frames round it, is put back
  { const runLen = new Int32Array(F);
    for (let i = 0; i < F;) { if (!med[i]) { i++; continue; } let j = i + 1; while (j < F && med[j] && Math.abs(med[j] - med[j - 1]) < 0.5) j++; for (let k = i; k < j; k++) runLen[k] = j - i; i = j; }
    const fixd = Float32Array.from(med), win = [];
    for (let i = 0; i < F; i++) {
      if (!med[i] || runLen[i] >= 4) continue;
      win.length = 0;
      for (let k = -10; k <= 10; k++) { const v = med[i + k]; if (v && Math.abs(v - med[i]) > 6) win.push(v); }
      if (win.length < 6) continue;
      win.sort((a, b) => a - b);
      const r = (med[i] - win[win.length >> 1]) / 12;
      if (Math.abs(Math.abs(r) - 1) < 0.07) fixd[i] = med[i] - 12 * Math.round(r);
    }
    med.set(fixd); }
  say(0.66);
  // 3 ---------------------------------------------------------------------------------------------------------------
  // loudness of the low end every millisecond, for attacks, re-hits and ends: the true envelope (the analytic signal's
  // magnitude, through one long FFT), smooth even across a 25 Hz note's slow cycles
  const h1 = Math.max(1, Math.round(0.001 * fs)), w1 = Math.max(2, Math.round(0.003 * fs));
  const E = Math.max(1, Math.floor((n - w1) / h1));
  const e1 = new Float32Array(E), e1r = new Float32Array(E);
  { let P = 1; while (P < n) P <<= 1;
    const re = new Float64Array(P), im = new Float64Array(P);
    for (let k = 0; k < n; k++) re[k] = x[k];
    fft(re, im);
    for (let k = 1; k < P >> 1; k++) { re[k] *= 2; im[k] *= 2; }
    for (let k = (P >> 1) + 1; k < P; k++) { re[k] = 0; im[k] = 0; }
    fft(re, im, true);
    // averaged over exactly one cycle of whatever is playing (a note's overtones make its envelope ripple once a cycle;
    // a one-cycle average cancels that completely and still keeps an attack as a clean step at its true time)
    const cs = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) cs[k + 1] = cs[k] + Math.hypot(re[k], im[k]) / P;
    let lastF = 50;
    const perFrame = new Float32Array(Math.max(1, F));
    for (let i = 0; i < F; i++) { if (med[i]) lastF = st2hz(med[i]); else if (raw[i] > 0 && ap[i] < 0.4) lastF = raw[i]; perFrame[i] = lastF; }
    for (let k = 0; k < E; k++) { const a = k * h1, b = Math.min(n, a + w1); e1r[k] = (cs[b] - cs[a]) / Math.max(1, b - a); }
    for (let k = 0; k < E; k++) {
      const c = k * h1 + w1 / 2, fi = Math.max(0, Math.min(F - 1, Math.round((c / fs - t0) / hopS)));
      const half = Math.max(1, Math.round(fs / (F ? perFrame[fi] : 50) / 2));
      const a = Math.max(0, Math.round(c) - half), b = Math.min(n, Math.round(c) + half);
      e1[k] = (cs[b] - cs[a]) / Math.max(1, b - a);
    } }
  const kOf = (t) => Math.max(0, Math.min(E - 1, Math.round((t * fs - w1 / 2) / h1)));
  const tOf = (k) => (k * h1 + w1 / 2) / fs;
  const ms = (v) => Math.max(1, Math.round((v * 0.001 * fs) / h1));
  const maxE = (a, b) => { let m = 0; for (let k = Math.max(0, a); k <= Math.min(E - 1, b); k++) if (e1[k] > m) m = e1[k]; return m; };
  const frameT = (i) => t0 + i * hopS;
  // the bass's own loudness at its own pitch: the low end turned round at the notes' pitch (their slides as they really
  // go, held between notes) and smoothed (12 Hz), so what is at other pitches (a kick's sweep, a guitar, a voice) is out
  const fundamental = (list) => {
    const track = new Float32Array(F);
    let j = 0, cur = list.length ? st2hz(list[0].pitch) : 50;
    for (let i = 0; i < F; i++) {
      while (j < list.length && list[j].b <= i) j++;
      const g = list[j];
      if (g && i >= g.a) cur = med[i] ? st2hz(med[i]) : st2hz(g.pitch);
      track[i] = cur;
    }
    const zc = new Float32Array(n), zs = new Float32Array(n);
    let ph = 0;
    for (let k = 0; k < n; k++) {
      const fi = (k / fs - t0) / hopS, i0 = Math.max(0, Math.min(F - 1, Math.floor(fi))), i1 = Math.min(F - 1, i0 + 1), u = Math.max(0, Math.min(1, fi - i0));
      const f = F ? track[i0] + (track[i1] - track[i0]) * u : 50;
      ph += (2 * Math.PI * f) / fs; if (ph > 6.283185307179586) ph -= 6.283185307179586;
      zc[k] = x[k] * Math.cos(ph); zs[k] = -x[k] * Math.sin(ph);
    }
    butter4(zc, "lp", 12, fs); butter4(zs, "lp", 12, fs);
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = 2 * Math.hypot(zc[k], zs[k]);
    return out;
  };
  // the length of one cycle of what is playing at k, in ms
  const perMs = (k) => {
    const fi = Math.max(0, Math.min(F - 1, Math.round((tOf(k) - t0) / hopS)));
    let f = 0;
    for (let d = 0; d <= 15 && !f; d++) { if (med[fi - d]) f = st2hz(med[fi - d]); else if (med[fi + d]) f = st2hz(med[fi + d]); }
    return 1000 / Math.max(20, f || 50);
  };
  // the wobble a drum makes against a held note is a run of dips one after another; a gap between two notes is one dip,
  // the deepest round it. So a dip with another as deep (or nearly) within 80 ms either side is a wobble
  const wobble = (env, k) => {
    const lim = env[k] * 1.3;
    for (let j = k - ms(80); j <= k + ms(80); j++) {
      if (j < 1 || j >= E - 1 || Math.abs(j - k) < ms(12)) continue;
      if (env[j] <= env[j - 1] && env[j] <= env[j + 1] && env[j] <= lim) {
        // a real dip, not just the floor of a slope
        let l = 0, r = 0; for (let i = j - ms(15); i < j; i++) l = Math.max(l, env[Math.max(0, i)]); for (let i = j + 1; i <= j + ms(15); i++) r = Math.max(r, env[Math.min(E - 1, i)]);
        if (env[j] < 0.75 * Math.min(l, r)) return true;
      }
    }
    return false;
  };
  // a drum landing on a note that was already sounding, in the last 100 ms (the smooth envelope rising by a fifth or more
  // within about a cycle, from a level that was already well up): what follows is its wobble, not the bass stopping
  const hitOnTop = (k) => {
    const span = ms(perMs(k) + 8);
    for (let j = Math.max(span + ms(3), k - ms(100)); j <= k - ms(6); j++) {
      let mn = Infinity; for (let i = j - span; i <= j - ms(3); i++) mn = Math.min(mn, e1[i]);
      if (e1[j] >= 1.22 * mn && mn >= 0.25 * e1[j] && e1[j] > 0.05 * e1Ref) return true;
    }
    return false;
  };
  // a re-hit: the sound dips well down, then comes back with a fresh, sharp attack, at least as loud as it was. Judged on
  // the envelope that suits the sound: the raw one for a near-pure tone (an 808: sharp, and its short gaps show), the
  // one-cycle one for a bass full of overtones (whose raw envelope ripples every cycle)
  const rehitAt = (kr, why, lenient = false) => {
    if (kr < ms(60) || kr > E - ms(60)) return null;
    let lo = Infinity, hi = 0, sum = 0, cnt = 0;
    for (let j = kr - ms(60); j <= kr - ms(12); j++) { lo = Math.min(lo, e1r[j]); hi = Math.max(hi, e1r[j]); sum += e1[j]; cnt++; }
    const ripple = (hi - lo) / Math.max(1e-12, sum / cnt), pure = ripple < 0.35;
    const env = pure ? e1r : e1;
    let k = kr; if (!pure) for (let j = Math.max(0, kr - ms(15)); j <= Math.min(E - 1, kr + ms(15)); j++) if (e1[j] < e1[k]) k = j;
    const mx = (a, b) => { let m = 0; for (let j = Math.max(0, a); j <= Math.min(E - 1, b); j++) if (env[j] > m) m = env[j]; return m; };
    const L = mx(k - ms(40), k - ms(8)), Rr = mx(k + ms(3), k + ms(50)), lv = env[k];
    const rawDepth = e1r[kr] / Math.max(1e-12, Math.min(mx === null ? 0 : L, Rr));
    const r20 = lv + 0.2 * (Rr - lv), r30 = lv + 0.3 * (Rr - lv), r80 = lv + 0.8 * (Rr - lv);
    let a = -1, b = -1, c30 = -1;
    for (let j = k + 1; j <= Math.min(E - 1, k + ms(60)); j++) { if (a < 0 && env[j] > r20) a = j; if (c30 < 0 && env[j] > r30) c30 = j; if (env[j] >= r80) { b = j; break; } }
    const per = perMs(k);
    const depth = lv / Math.max(1e-12, Math.min(L, Rr));
    const hb = lenient ? false : wobble(env, k) || hitOnTop(k);
    const ok = lenient
      // where the pitch changes: any clear dip followed by an attack is the bass hit again (a slide never dips)
      ? Rr >= 0.8 * L && a >= 0 && b >= 0 && rawDepth < 0.6 && b - a <= ms(Math.max(25, per))
      : !hb && Rr >= 0.9 * L && a >= 0 && b >= 0 &&
        (pure ? depth < 0.55 && b - a <= ms(20) : rawDepth < 0.62 && depth < (rawDepth < 0.5 ? 0.9 : 0.85) && b - a <= ms(Math.max(20, 0.9 * per)));
    if (dbg && why) dbg.push({ t: tOf(k), why, raw: rawDepth, depth, pure, rr: Rr / L, rise: b >= 0 && a >= 0 ? (b - a) : -1, hitBefore: hb, ok, lim: ms(Math.max(20, 0.8 * per)), per });
    if (!ok) return null;
    if (lenient) {
      // the attack on the raw envelope, which shows it sharply: 30% of the way up from the dip
      let RR2 = 0; for (let j = kr + 1; j <= Math.min(E - 1, kr + ms(45)); j++) RR2 = Math.max(RR2, e1r[j]);
      const th = e1r[kr] + 0.3 * (RR2 - e1r[kr]);
      let c = kr; while (c < E - 1 && c < kr + ms(45) && e1r[c] < th) c++;
      return { dip: kr, on: c };
    }
    return { dip: k, on: Math.max(k, c30) };
  };
  const e1Ref = (() => { const v = Array.from(e1).sort((p, q) => p - q); return v[Math.floor(v.length * 0.95)] || 1e-9; })();
  const isLocalMinR = (k, r) => { if (k <= 0 || k >= E - 1) return false; for (let j = k - r; j <= k + r; j++) if (j >= 0 && j < E && e1r[j] < e1r[k]) return false; return true; };
  const isLocalMin = (k, r) => { for (let j = k - r; j <= k + r; j++) if (j >= 0 && j < E && e1[j] < e1[k]) return false; return true; };
  // 4 ---------------------------------------------------------------------------------------------------------------
  // candidate notes: runs of frames on one pitch...
  const runs = [];
  for (let i = 0; i < F;) {
    if (!med[i]) { i++; continue; }
    const a = i;
    let sum = med[i], cnt = 1, last = i, gap = 0;
    i++;
    while (i < F) {
      if (med[i]) {
        if (Math.abs(med[i] - sum / cnt) > 0.55) break;
        sum += med[i]; cnt++; last = i; gap = 0;
      } else if (++gap > 3 || rms[i] < gate) break;
      i++;
    }
    runs.push({ a, b: last + 1 });
    i = last + 1;
  }
  // ...split wherever the bass is hit again (the same note played again and again)
  let segs = [];
  for (const g of runs) {
    let start = g.a, rehit = null, lastK = kOf(frameT(g.a) - 0.035);
    const kLo = kOf(frameT(g.a) + 0.03), kHi = kOf(frameT(g.b - 1) - 0.03);
    for (let k = kLo + 1; k < kHi; k++) {
      if (k - lastK < ms(100) || !isLocalMinR(k, ms(8))) continue;
      const r = rehitAt(k, "split");
      if (!r) continue;
      const fr = Math.round((tOf(r.on) - t0) / hopS);
      if (fr <= start + 2 || fr >= g.b - 2) continue;
      segs.push({ a: start, b: fr, rehit, endDip: r.dip });
      start = fr; rehit = r; lastK = r.on;
    }
    segs.push({ a: start, b: g.b, rehit, endDip: null });
  }
  // 5 ---------------------------------------------------------------------------------------------------------------
  // what each piece is like, measured on its own fundamental (so a kick or a chug on top of it doesn't count)
  for (const g of segs) {
    const vals = [], ws = [];
    let apS = 0;
    for (let i = g.a; i < g.b; i++) { if (med[i]) { vals.push(med[i]); ws.push(rms[i]); } apS += ap[i]; }
    g.pitch = wmedian(vals, ws) || 40;
    g.dur = (g.b - g.a) * hopS; g.ap = apS / (g.b - g.a);
  }
  // which octave each piece really is: whichever of an octave below, itself, or an octave above actually has the
  // energy of a fundamental (a strong overtone can fool the pitch finder one way, a missing fundamental the other)
  { const at = (a, b, f) => {
      let re = 0, im = 0, w = 0;
      const len = b - a, step = (2 * Math.PI * f) / fs;
      for (let k = 0; k < len; k++) { const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / len), v = x[a + k] * h; re += v * Math.cos(step * k); im += v * Math.sin(step * k); w += h; }
      return Math.hypot(re, im) / Math.max(1e-9, w);
    };
    for (const g of segs) {
      const a = Math.max(0, Math.round(frameT(g.a) * fs)), b = Math.min(n, Math.round(frameT(g.b - 1) * fs));
      if (b - a < 0.06 * fs) continue;
      for (let pass = 0; pass < 2; pass++) {
        const f = st2hz(g.pitch), here = at(a, b, f);
        if (f / 2 >= 24 && (b - a) / fs >= 1.6 / (f / 2) && at(a, b, f / 2) >= 0.6 * here) { g.pitch -= 12; continue; }
        if (f * 2 <= (stem ? 300 : 170)) {
          // an octave up only if nothing really sounds at f's own (odd) harmonics: a bass note's fundamental can be
          // much weaker than its second harmonic, but a note truly at 2f has nothing at all at f or 3f
          const two = at(a, b, f * 2);
          if (stem ? here < 0.08 * two && at(a, b, f * 3) < 0.08 * two : here < 0.25 * two) { g.pitch += 12; continue; }
        }
        break;
      }
    } }
  // the frames follow their piece's octave
  for (const g of segs) for (let i = g.a; i < g.b; i++) if (med[i]) med[i] += 12 * Math.round((g.pitch - med[i]) / 12);
  const amp0 = fundamental(segs);
  for (const g of segs) {
    const ka = Math.max(0, Math.round((frameT(g.a) - hopS / 2) * fs)), kb = Math.min(n - 1, Math.round((g.endDip != null ? tOf(g.endDip) - 0.01 : frameT(g.b - 1)) * fs));
    let pk = 0, kp = ka; for (let k = ka; k <= kb; k++) if (amp0[k] > pk) { pk = amp0[k]; kp = k; }
    g.peak = pk; g.strength = pk;
    // how fast it dies away, in dB a second, after anything on top of its start has gone (from 50 ms past its peak):
    // a kick's tail or a muted chug: fast; any bass note: slow
    let k0 = kp + Math.round(0.05 * fs); if (kb - k0 < Math.round(0.06 * fs)) k0 = kp;
    const step = Math.max(1, Math.round(0.005 * fs));
    let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
    for (let k = k0; k <= kb; k += step) { const t = (k - k0) / fs, y = 20 * Math.log10(amp0[k] + 1e-9); sx += t; sy += y; sxx += t * t; sxy += t * y; cnt++; }
    g.decay = cnt >= 6 ? -(cnt * sxy - sx * sy) / (cnt * sxx - sx * sx) : 0;
    g.endLevel = pk > 0 ? amp0[Math.max(ka, kb - Math.round(0.01 * fs))] / pk : 1;
  }
  let drums = 0, other = 0;
  let notes = segs.filter((g) => {
    if (g.dur < 0.05) return false;                               // a flicker or a slide's middle: not a note of its own
    if (g.pitch > hz2st(stem ? 255 : 165)) { other++; if (dbg) dbg.push({ t: frameT(g.a), why: "high", pitch: g.pitch, dur: g.dur }); return false; }
    if (g.ap > 0.28) { other++; if (dbg) dbg.push({ t: frameT(g.a), why: "noisy", pitch: g.pitch, dur: g.dur, ap: g.ap }); return false; }
    if (!stem && g.decay > 55 && g.dur < 0.6 && g.endLevel < 0.1) { drums++; if (dbg) dbg.push({ t: frameT(g.a), why: "drum", decay: g.decay, dur: g.dur, pitch: g.pitch }); return false; }  // a kick's tail, a muted chug: gone too fast for a bass note
    return true;
  });
  // the song's bass register and strength: what most of the bass sits on. Anything well above it, or much weaker than
  // it, is another instrument or a voice reaching down, not the bass
  for (let pass = 0; pass < (stem ? 0 : 2); pass++) {
    const M = wmedian(notes.map((g) => g.pitch), notes.map((g) => g.dur * g.peak));
    const P = wmedian(notes.map((g) => g.peak), notes.map((g) => g.dur));
    notes = notes.filter((g) => {
      const ok = g.peak >= 0.1 * P && !(g.pitch > M + 5 && g.peak < 0.45 * P) && !(g.pitch > M + 14 && g.peak < 0.8 * P);
      if (!ok) { other++; if (dbg) dbg.push({ t: frameT(g.a), why: "register", pitch: g.pitch, dur: g.dur, peak: g.peak / P, M }); }
      return ok;
    });
  }
  // the song's tuning, then each note on its exact semitone
  let tune = 0;
  { let sx = 0, sy = 0;
    for (const g of notes) { const dd = (g.pitch - Math.round(g.pitch)) * 2 * Math.PI, w = g.dur * g.peak; sx += Math.cos(dd) * w; sy += Math.sin(dd) * w; }
    if (notes.length) tune = Math.atan2(sy, sx) / (2 * Math.PI); }
  for (const g of notes) g.q = Math.round(g.pitch - tune);
  // one note split only by a moment its pitch wasn't clear (not by a re-hit): put back together
  notes.sort((p, q) => p.a - q.a);
  { const merged = [];
    for (const g of notes) {
      const p = merged[merged.length - 1];
      let joinable = p && p.q === g.q && !g.rehit && (g.a - p.b) * hopS <= 0.04;
      if (joinable) {
        let r = null;
        for (let k = kOf(frameT(p.b - 1) - 0.04); k <= kOf(frameT(g.a) + 0.02) && !r; k++) if (isLocalMinR(k, ms(6))) r = rehitAt(k, "join");
        if (r) { joinable = false; g.rehit = r; p.endDip = r.dip; }
      }
      if (joinable) { p.b = g.b; p.endDip = g.endDip; p.peak = Math.max(p.peak, g.peak); p.dur = (p.b - p.a) * hopS; }
      else merged.push(g);
    }
    notes = merged; }
  say(0.72);
  // a note has to be there at its own pitch: two notes a fifth apart (a power chord) make a pitch an octave below them
  // with nothing actually sounding there. Each note's strength at its own fundamental, against the song's bass notes
  { const strength = notes.map((g) => g.strength);
    const S = wmedian(strength, notes.map((g) => g.dur));
    notes = notes.filter((g, i) => { const ok = strength[i] >= (stem ? 0.06 : 0.25) * S; if (!ok) other++; return ok; }); }
  // 6 ---------------------------------------------------------------------------------------------------------------
  // each note's start and how it meets the note before
  for (let j = 0; j < notes.length; j++) {
    const g = notes[j], p = notes[j - 1];
    g.ts = frameT(g.a) - hopS / 2; g.te = frameT(g.b - 1) + hopS / 2;
    g.legato = false; g.on = null; g.off = null;
    if (g.rehit && p && p.endDip === g.rehit.dip) { p.off = tOf(g.rehit.dip); g.on = tOf(g.rehit.on); continue; }
    if (p && g.ts - p.te <= 0.15) {
      // close behind the note before: a re-hit (a dip, then an attack), or a change with no break (a slide: linked)
      const kA = kOf(Math.max(p.ts + 0.02, p.te - 0.07)), kB = kOf(g.ts + 0.03);
      let r = null;
      if (p.q !== g.q) {
        // where the pitch changes: the dip in the stretch where it switches
        const kA2 = kOf(Math.max(p.ts + 0.02, p.te - 0.035)), kB2 = kOf(g.ts + 0.02);
        // (the earliest dip nearly as deep as the deepest: the gap comes before the attack, and a drum landing with the
        // new note can swing the sound as low again just after it)
        const mins = []; for (let k = kA2 + 1; k < kB2; k++) if (isLocalMinR(k, ms(4))) mins.push(k);
        let deepest = Infinity; for (const k of mins) deepest = Math.min(deepest, e1r[k]);
        const kd = mins.find((k) => e1r[k] <= 1.5 * deepest);
        if (kd != null) r = rehitAt(kd, "boundary", true);
      } else for (let k = kA + 1; k < kB && !r; k++) if (isLocalMinR(k, ms(6))) r = rehitAt(k, "boundary");
      if (r) { p.off = tOf(r.dip); g.on = tOf(r.on); continue; }
      let lowest = Infinity;
      for (let i = p.b; i < g.a; i++) lowest = Math.min(lowest, rms[i]);
      if (g.a <= p.b || lowest >= 0.35 * Math.min(rms[p.b - 1], rms[g.a])) {
        // a slide: the glide goes over the middle of the change the song makes (never shorter than 40 ms)
        let A = p.te, B = g.ts;
        const span = B - A; A += 0.2 * span; B -= 0.2 * span;
        if (B - A < 0.04) { const mid = (A + B) / 2; A = mid - 0.02; B = mid + 0.02; }
        g.legato = true; g.glideA = A; g.glideB = B; g.on = (A + B) / 2; p.off = g.on;
        continue;
      }
    }
    // after a break: the attack is the rise that leads into the note's first loud moment
    const lo = Math.max(p && p.off != null ? p.off : p ? p.te : 0, g.ts - 0.09);
    const kA = kOf(lo), kPkLo = kOf(Math.max(lo, g.ts - 0.03)), kPkHi = kOf(g.ts + 0.08);
    let kPk = kPkLo; for (let k = kPkLo; k <= kPkHi; k++) if (e1[k] > e1[kPk]) kPk = k;
    let base = Infinity; for (let k = kA; k <= kPk; k++) base = Math.min(base, e1[k]);
    const thr = base + 0.3 * (e1[kPk] - base);
    let k = kPk; while (k > kA && e1[k - 1] > thr) k--;
    g.on = tOf(k);
  }
  say(0.76);
  // 7 ---------------------------------------------------------------------------------------------------------------
  const a12 = fundamental(notes);
  // the ends of notes with nothing straight after them: where the note's own sound has died away
  for (let j = 0; j < notes.length; j++) {
    const g = notes[j], nx = notes[j + 1];
    if (g.off != null) continue;
    const ka = Math.round(g.on * fs), kte = Math.round(g.te * fs);
    let pk = 0; for (let k = ka; k <= kte && k < n; k++) pk = Math.max(pk, a12[k]);
    const limit = Math.min(n - 1, Math.round(Math.min(g.te + 0.15, nx ? nx.on : Infinity) * fs));
    let k = Math.round((g.te - 0.04) * fs);
    const late = a12[Math.max(0, k)];
    while (k < limit && a12[k] > 0.08 * pk && a12[k] > 0.3 * late) k++;
    g.off = Math.max(g.on + 0.02, Math.min(k / fs, nx ? nx.on : Infinity));
  }
  // the envelope of every note: its attack as sharp as the song's (the first moments follow the original rise); its body
  // the original bass's own loudness, never jumping up faster than 40 dB a second (so a kick landing on a held note
  // doesn't bump it), read without the smoothing's lag at either end; gone cleanly at its end. Linked notes carry on.
  const amp = new Float32Array(n);
  // full: each note at full level while the original is within 6 dB of the bass line.s loudest round it (a rebass: clean,
  // loud notes that fill the waveform), following the original only below that (its gaps, re-hits and decays)
  const full = opts.full !== false, T = opts.knee || 0.5;
  const level = full ? new Float32Array(n) : null, chains = [];
  const riseK = stem ? Infinity : Math.pow(10, 40 / 20 / fs), look = Math.round(0.08 * fs), back = Math.round(0.06 * fs);
  for (let j = 0; j < notes.length; j++) {
    const g = notes[j];
    if (g.legato) continue;
    let last = g; for (let i = j + 1; i < notes.length && notes[i].legato; i++) last = notes[i];
    const ka = Math.max(0, Math.round(g.on * fs)), kb = Math.min(n - 1, Math.round(last.off * fs));
    if (kb <= ka + 2) continue;
    const kp1 = kOf(g.on), kp2 = kOf(Math.min(last.off, g.on + 0.06));
    let kPk = kp1; for (let k = kp1; k <= kp2; k++) if (e1[k] > e1[kPk]) kPk = k;
    const kPkS = Math.min(kb, Math.max(ka, Math.round(tOf(kPk) * fs)));
    // the body as read: from the attack's peak, the most it reaches over the next 80 ms (the smoothing's slow start),
    // and over the last 60 ms before the end, the most it had (its slow finish)
    const body = new Float32Array(kb - ka + 1);
    if (stem) {
      // the bass alone: its own loudness, sharp to about one cycle (nothing else is there to keep out)
      for (let k = ka; k <= kb; k++) body[k - ka] = e1[kOf(k / fs)];
    } else {
      for (let k = ka; k <= kb; k++) body[k - ka] = a12[k];
      { let run = 0; for (let k = Math.min(kb, kPkS + look); k >= kPkS; k--) { run = Math.max(run, a12[k]); body[k - ka] = run; } }
      { const k0 = Math.max(kPkS + look + 1, kb - back); let run = 0; for (let k = k0; k <= kb; k++) { run = Math.max(run, a12[k]); body[k - ka] = run; } }
    }
    const ref = body[kPkS - ka];
    const ePk = e1[kPk] || 1e-9;
    for (let k = ka; k < kPkS; k++) amp[k] = Math.min(ref, (ref * e1[kOf(k / fs)]) / ePk);
    let prev = ref;
    const starts = []; for (let i = j + 1; i < notes.length && notes[i].legato; i++) starts.push(Math.round(notes[i].glideA * fs), Math.round(notes[i].glideB * fs) + Math.round(0.04 * fs));
    for (let k = kPkS; k <= kb; k++) {
      let free = false; for (let i = 0; i < starts.length; i += 2) if (k >= starts[i] && k <= starts[i + 1]) { free = true; break; }
      const v = free ? body[k - ka] : Math.min(body[k - ka], prev * riseK); amp[k] = v; prev = v;
    }
    chains.push([ka, kb]);
    const fi = Math.max(1, Math.round(0.002 * fs)), fo = Math.max(1, Math.round(0.012 * fs));
    for (let k = 0; k < fi && ka + k <= kb; k++) amp[ka + k] *= k / fi;
    for (let k = 0; k < fo && kb - k >= ka; k++) amp[kb - k] *= k / fo;
  }
  if (full) {
    // every note at the same level (the level chosen): each against its own loudest moment, not its neighbours' (a
    // quiet note next to a loud one comes out just as loud), full while the original note is within 12 dB of that,
    // following it below only for real gaps and re-hits
    const ref = new Float32Array(n);
    for (const g of notes) {
      const k0 = Math.max(0, Math.floor(g.on * fs)), k1 = Math.min(n - 1, Math.ceil(g.off * fs));
      let pk = 0; for (let k = k0; k <= k1; k++) if (amp[k] > pk) pk = amp[k];
      for (let k = k0; k <= k1; k++) if (pk > ref[k]) ref[k] = pk;
    }
    const h = Math.round(0.2 * fs), R = slidingMax(amp, h), K = Math.min(T, 0.25);
    for (const [ka, kb] of chains) {
      for (let k = ka; k <= kb; k++) level[k] = Math.min(1, amp[k] / Math.max(1e-12, K * (ref[k] || R[k])));
      // clean edges: a quick rise (3 ms) and a smooth release (10 ms), raised cosine
      const fi = Math.max(1, Math.round(0.003 * fs)), fo = Math.max(1, Math.round(0.010 * fs));
      for (let k = 0; k < fi && ka + k <= kb; k++) level[ka + k] *= 0.5 - 0.5 * Math.cos((Math.PI * k) / fi);
      for (let k = 0; k < fo && kb - k >= ka; k++) level[kb - k] *= 0.5 - 0.5 * Math.cos((Math.PI * k) / fo);
    }
  }
  let top = 0; for (let k = 0; k < n; k++) if (amp[k] > top) top = amp[k];
  if (top > 0) for (let k = 0; k < n; k++) amp[k] /= top;
  // what the new bass plays: the full-level shape, or (full: false) the original's own loudness
  const play = full ? level : amp;
  // per frame, for the graphs: the original bass's pitch and loudness where it plays
  const f0 = new Float32Array(F), env = new Float32Array(F);
  { let j = 0;
    for (let i = 0; i < F; i++) {
      const t = frameT(i);
      while (j < notes.length && notes[j].off < t) j++;
      const g = notes[j];
      const k = Math.min(n - 1, Math.round(t * fs));
      env[i] = amp[k];
      if (g && t >= g.on && amp[k] > 0) f0[i] = med[i] ? st2hz(med[i]) : st2hz(g.pitch);
    } }
  // the song's own bass range (the notes, in tune)
  const fq = notes.map((g) => st2hz(g.q + tune)), wq = notes.map((g) => g.off - g.on);
  const order = fq.map((_, i) => i).sort((a, b) => fq[a] - fq[b]);
  let tot = 0; for (const w of wq) tot += w;
  const pct = (p) => { let acc = 0; for (const i of order) { acc += wq[i]; if (acc >= p * tot) return fq[i]; } return fq[order[order.length - 1]] || 0; };
  say(1);
  if (dbg) dbg.e = { e1, e1r, tOf, jb: (t) => jumpBefore(kOf(t)) };
  return {
    fs, hop: hopS, t0, f0, env, amp: play, orig: amp, tune,
    notes: notes.map((g) => ({ on: g.on, off: g.off, q: g.q, pitch: g.pitch, peak: g.peak / R, legato: g.legato, glideA: g.glideA, glideB: g.glideB })),
    lo: notes.length ? pct(0.03) : 0, hi: notes.length ? pct(0.97) : 0,
    dropped: { drums, other },
  };
}

/**
 * Where each note goes, in whole semitones on the song's own tuning (slowed: on the slowed song's).
 *   If the whole bass line fits in lo..hi moved by a fixed amount, it is moved by that amount: whole octaves if any fit
 *   (the very same notes, lower), else a fourth or a fifth, else the closest fit. The line is exactly the same, just lower.
 *   If it doesn't fit, it is squeezed in: every note keeps its place in the line (higher than the one before stays higher,
 *   lower stays lower, the same stays the same), on whole-semitone steps, spread as evenly as the range allows. A stray
 *   note far outside the rest (the top or bottom 1% of the line) goes to the nearest edge instead of squeezing the rest.
 * Returns { kind: "move" | "squeeze" | "none", shift, target: Map(q -> semitone), describe }.
 */
export function planMapping(an, lo, hi, speed = 1) {
  const notes = an.notes, target = new Map();
  if (!notes.length) return { kind: "none", shift: 0, target, describe: "No bass notes found" };
  const base = an.tune + 12 * Math.log2(speed);      // note q sounds at q + base
  const Lo = hz2st(lo), Hi = hz2st(hi);
  const weight = new Map();
  for (const g of notes) weight.set(g.q, (weight.get(g.q) || 0) + (g.off - g.on) * Math.max(0.05, g.peak));
  const qs = [...weight.keys()].sort((a, b) => a - b);
  let tot = 0; for (const q of qs) tot += weight.get(q);
  let acc = 0, qLo = qs[0], qHi = qs[qs.length - 1];
  for (const q of qs) { acc += weight.get(q); if (acc >= 0.01 * tot) { qLo = q; break; } }
  acc = 0;
  for (let i = qs.length - 1; i >= 0; i--) { acc += weight.get(qs[i]); if (acc >= 0.01 * tot) { qHi = qs[i]; break; } }
  const Tmin = Math.ceil(Lo - (qLo + base) - 1e-6), Tmax = Math.floor(Hi - (qHi + base) + 1e-6);
  const phi = base - Math.floor(base);
  const g0 = Math.ceil(Lo - phi - 1e-6), g1 = Math.floor(Hi - phi + 1e-6);
  const grid = []; for (let g = g0; g <= g1; g++) grid.push(g + phi);
  const fitEdge = (v) => {
    if (v >= Lo - 1e-6 && v <= Hi + 1e-6) return v;
    // in key if an octave fold lands it inside, else the nearest edge of the range
    let w = v; while (w > Hi + 1e-6) w -= 12; while (w < Lo - 1e-6) w += 12;
    if (w <= Hi + 1e-6) return w;
    return grid.length ? (v < Lo ? grid[0] : grid[grid.length - 1]) : (Lo + Hi) / 2;
  };
  if (Tmin <= Tmax) {
    let best = Tmin, bestScore = Infinity;
    for (let T = Tmin; T <= Tmax; T++) {
      const r = ((T % 12) + 12) % 12, pref = r === 0 ? 0 : r === 5 || r === 7 ? 1 : 2;
      const centre = Math.abs((qLo + qHi) / 2 + base + T - (Lo + Hi) / 2);
      const score = pref * 1000 + centre;
      if (score < bestScore) { bestScore = score; best = T; }
    }
    for (const q of qs) target.set(q, fitEdge(q + base + best));
    const oct = Math.round(Math.abs(best) / 12);
    const describe = best === 0 ? "Same notes" : best % 12 === 0
      ? `Same bass line, ${oct} octave${oct > 1 ? "s" : ""} ${best < 0 ? "down" : "up"}`
      : `Same bass line, ${Math.abs(best)} semitones ${best < 0 ? "down" : "up"}`;
    return { kind: "move", shift: best, target, describe };
  }
  // squeeze
  const inner = qs.filter((q) => q >= qLo && q <= qHi), N = inner.length;
  const K = grid.length;
  if (!K) { for (const q of qs) target.set(q, (Lo + Hi) / 2); return { kind: "squeeze", shift: 0, target, describe: `Same rhythm, one pitch (${Math.round(lo)}–${Math.round(hi)} Hz is narrower than a semitone)` }; }
  const ideal = inner.map((q) => grid[0] + (N > 1 ? ((q - qLo) / Math.max(1, qHi - qLo)) * (grid[K - 1] - grid[0]) : (grid[K - 1] - grid[0]) / 2));
  const pick = new Array(N);
  if (N <= K) {
    // each note its own step, in order, as close to its even spot as can be (least squares, by how much it's played)
    const cost = (i, j) => weight.get(inner[i]) * (grid[j] - ideal[i]) ** 2;
    const dp = Array.from({ length: N }, () => new Float64Array(K).fill(Infinity));
    const from = Array.from({ length: N }, () => new Int32Array(K).fill(-1));
    for (let j = 0; j < K; j++) dp[0][j] = cost(0, j);
    for (let i = 1; i < N; i++) {
      let bestPrev = Infinity, bestJ = -1;
      for (let j = 0; j < K; j++) {
        if (j - 1 >= 0 && dp[i - 1][j - 1] < bestPrev) { bestPrev = dp[i - 1][j - 1]; bestJ = j - 1; }
        if (bestJ >= 0) { dp[i][j] = bestPrev + cost(i, j); from[i][j] = bestJ; }
      }
    }
    let j = 0; for (let k = 1; k < K; k++) if (dp[N - 1][k] < dp[N - 1][j]) j = k;
    for (let i = N - 1; i >= 0; i--) { pick[i] = j; j = from[i][j]; }
  } else for (let i = 0; i < N; i++) pick[i] = Math.max(0, Math.min(K - 1, Math.round(ideal[i] - grid[0])));
  inner.forEach((q, i) => target.set(q, grid[pick[i]]));
  for (const q of qs) if (!target.has(q)) target.set(q, q < qLo ? grid[pick[0]] : grid[pick[N - 1]]);
  const used = new Set([...target.values()].map((v) => v.toFixed(3))).size;
  return { kind: "squeeze", shift: 0, target, describe: `Same bass line, fitted into ${Math.round(lo)}–${Math.round(hi)} Hz (${qs.length} notes on ${used} pitches)` };
}

/** The new bass's frequency at a moment of the original song (u, seconds): steady on each note, gliding between linked ones. */
export function makeFreqAt(an, plan) {
  const notes = an.notes, F = notes.map((g) => st2hz(plan.target.get(g.q)));
  let j = 0;
  return (u) => {
    if (!notes.length) return 0;
    if (j > 0 && u < (notes[j].legato ? notes[j].glideA : notes[j].on)) j = 0;
    while (j + 1 < notes.length && u >= (notes[j + 1].legato ? notes[j + 1].glideA : notes[j + 1].on)) j++;
    const g = notes[j];
    if (g.legato && j > 0 && u < g.glideB) {
      // an S-shaped glide (in pitch) from the last note to this one, over the song's own change
      const x = Math.max(0, Math.min(1, (u - g.glideA) / (g.glideB - g.glideA))), s = x * x * (3 - 2 * x);
      return F[j - 1] * Math.pow(F[j] / F[j - 1], s);
    }
    return F[j];
  };
}

/**
 * The new bass: one clean sine, its phase never broken (no clicks, ever), each note dead steady on its frequency, gliding
 * between linked notes, its loudness the original bass's own. speed < 1: the slowed song (the same notes at the slowed
 * times). Returns { bass (mono, peak 1 at its loudest), peak }.
 */
export function renderBass(an, plan, sr, length, speed = 1, progress) {
  const out = new Float32Array(length);
  if (!an.notes.length) return { bass: out, peak: 0 };
  const freqAt = makeFreqAt(an, plan), amp = an.amp, fsA = an.fs, nA = amp.length;
  let ph = 0, peak = 0;
  for (let s = 0; s < length; s++) {
    const u = (s / sr) * speed;
    const p = u * fsA, k = Math.floor(p);
    if (k >= nA - 1) break;
    const e = k < 0 ? 0 : amp[k] + (amp[k + 1] - amp[k]) * (p - k);
    const f = freqAt(u);
    ph += (2 * Math.PI * f) / sr;
    if (ph > 6.283185307179586) ph -= 6.283185307179586;
    if (e > 0) { const v = Math.sin(ph) * e; out[s] = v; const av = v < 0 ? -v : v; if (av > peak) peak = av; }
    if (progress && (s & 262143) === 0) progress(s / length);
  }
  return { bass: out, peak };
}

/**
 * Hand-placed notes (Custom notes on the Rebass screen): [{ t, d, f, v }], each on the original song's timeline (t, d in
 * seconds), at its own frequency (f, Hz, as it should sound) and level (v, 0..1). One clean sine per note, faded in and
 * out over a few milliseconds (no clicks); notes that overlap sound together. speed < 1: the slowed song (the same
 * notes at the slowed times, at the frequencies chosen). Returns { bass, peak }.
 */
export function renderNotes(notes, sr, length, speed = 1, progress) {
  const out = new Float32Array(length);
  const A = Math.max(1, Math.round(0.006 * sr)), Rel = Math.max(1, Math.round(0.03 * sr)), TAU = 2 * Math.PI;
  notes.forEach((n, i) => {
    const s0 = Math.max(0, Math.round((n.t / speed) * sr)), s1 = Math.min(length, Math.round(((n.t + n.d) / speed) * sr));
    if (s1 <= s0) return;
    const end = Math.min(length, s1 + Rel), w = (TAU * n.f) / sr, v = 1;     // (every note at the level chosen)
    let ph = 0;
    for (let s = s0; s < end; s++) {
      const k = s - s0;
      let e = k < A ? k / A : 1;
      if (s >= s1) e *= 1 - (s - s1) / Rel;
      out[s] += Math.sin(ph) * e * v;
      ph += w; if (ph > TAU) ph -= TAU;
    }
    if (progress && (i & 31) === 0) progress(i / notes.length);
  });
  let peak = 0;
  for (let s = 0; s < length; s++) { const a = out[s] < 0 ? -out[s] : out[s]; if (a > peak) peak = a; }
  return { bass: out, peak };
}
