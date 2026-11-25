// The sub box designer's math: a driver from its Thiele/Small numbers, the box's geometry (net volumes after the sub, the
// port and the bracing, the port's length for a tuning, whether it fits, the cut list), and the whole system simulated
// as a lumped electro-mechano-acoustic circuit, the way box simulators do: sealed, ported, 4th-order and 6th-order
// bandpass (both chambers ported out, or the rear one ported into the front one). Everything inside is in SI units
// (metres, m³, m², kg, seconds); the screen converts to inches/ft³ or cm/litres. No DOM here, so it runs in Node too.

export const RHO = 1.204, C = 343;            // air at 20 °C: density (kg/m³) and the speed of sound (m/s)
const TAU = 2 * Math.PI;
export const IN = 0.0254, FT3 = 0.0283168466, L = 0.001, CM = 0.01;
export const PORT_K = 0.825;                  // a port's end correction: 0.825·√(area) (= 0.732 × a round port's diameter)
const TUBE_WALL = 0.003;                      // a round port tube's wall (3 mm)

// ---------------------------------------------------------------------------------------------------- complex numbers
const cx = (re, im = 0) => ({ re, im });
const add = (a, b) => cx(a.re + b.re, a.im + b.im);
const sub = (a, b) => cx(a.re - b.re, a.im - b.im);
const mul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a, b) => { const d = b.re * b.re + b.im * b.im || 1e-300; return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const inv = (a) => div(cx(1), a);
const mag = (a) => Math.hypot(a.re, a.im);
/** Solves A·x = b (complex, small n) by Gaussian elimination with pivoting. */
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let k = 0; k < n; k++) {
    let p = k; for (let i = k + 1; i < n; i++) if (mag(M[i][k]) > mag(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]];
    for (let i = k + 1; i < n; i++) { const f = div(M[i][k], M[k][k]); for (let j = k; j <= n; j++) M[i][j] = sub(M[i][j], mul(f, M[k][j])); }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s = sub(s, mul(M[i][j], x[j])); x[i] = div(s, M[i][i]); }
  return x;
}

// ---------------------------------------------------------------------------------------------------- the driver
/** Typical car-audio subs by size (generic numbers, a starting point: enter your own sub's spec sheet for real results). */
export const PRESETS = {
  8: { fs: 38, qts: 0.55, qes: 0.6, vas: 0.5 * FT3, re: 3.6, le: 2.2e-3, sd: 214e-4, xmax: 10e-3, pe: 300, size: 8 * IN, cutout: 7.1 * IN, depth: 4.6 * IN, disp: 0.03 * FT3 },
  10: { fs: 32, qts: 0.5, qes: 0.55, vas: 1.0 * FT3, re: 3.5, le: 2.8e-3, sd: 330e-4, xmax: 13e-3, pe: 500, size: 10 * IN, cutout: 9.1 * IN, depth: 5.9 * IN, disp: 0.06 * FT3 },
  12: { fs: 30, qts: 0.48, qes: 0.52, vas: 1.6 * FT3, re: 3.4, le: 3.2e-3, sd: 480e-4, xmax: 15e-3, pe: 600, size: 12 * IN, cutout: 11.1 * IN, depth: 6.6 * IN, disp: 0.1 * FT3 },
  15: { fs: 28, qts: 0.45, qes: 0.5, vas: 3.5 * FT3, re: 3.4, le: 3.8e-3, sd: 800e-4, xmax: 17e-3, pe: 1000, size: 15 * IN, cutout: 13.9 * IN, depth: 7.6 * IN, disp: 0.17 * FT3 },
  18: { fs: 26, qts: 0.42, qes: 0.46, vas: 6.3 * FT3, re: 3.3, le: 4.2e-3, sd: 1170e-4, xmax: 20e-3, pe: 1500, size: 18 * IN, cutout: 16.6 * IN, depth: 9 * IN, disp: 0.28 * FT3 },
};

/** The driver's mechanical side, from its Thiele/Small numbers (Qms from Qts and Qes; an impossible Qes, at or under
 * Qts, is read as Qms = 8, a typical sub's). */
export function driver(d) {
  const fs = Math.max(5, +d.fs || 30), qts = Math.max(0.05, +d.qts || 0.45), re = Math.max(0.1, +d.re || 3.4);
  const sd = Math.max(1e-4, +d.sd || 0.05), vas = Math.max(1e-4, +d.vas || 0.05);
  let qes = +d.qes, qms, guessedQms = false;
  if (qes > qts * 1.001) qms = (qes * qts) / (qes - qts);
  else { qms = 8; qes = (qts * qms) / (qms - qts); guessedQms = true; }
  const ws = TAU * fs;
  const cms = vas / (RHO * C * C * sd * sd);
  const mms = 1 / (ws * ws * cms);
  const rms = (ws * mms) / qms;
  const bl = Math.sqrt((ws * mms * re) / qes);
  // the level in the mass-controlled band (half space, 1 m): ρ·Sd·Bl·e / (2π·Re·Mms)
  const lvl = (e) => 20 * Math.log10((RHO * sd * bl * e) / (TAU * re * mms) / 2e-5);
  return {
    fs, qts, qes, qms, re, sd, vas, le: Math.max(0, +d.le || 0), xmax: Math.max(1e-4, +d.xmax || 0.012), pe: Math.max(1, +d.pe || 500),
    cms, mms, rms, bl, guessedQms,
    sens: lvl(2.83), sens1w: lvl(Math.sqrt(re)), ebp: fs / qes,
    eta: (4 * Math.PI * Math.PI * fs ** 3 * vas) / (C ** 3 * qes) * 100,   // reference efficiency, %
  };
}

// ---------------------------------------------------------------------------------------------------- the box types
/** Each type's chambers and ports. Chamber 0 is behind the sub, 1 (bandpass) the one it fires into. front/rear: the
 * chamber on each side of the cone (-1: outside). Ports join a chamber to the outside (b -1) or to another chamber. */
export function topology(type, series) {
  if (type === "sealed") return { n: 1, front: -1, rear: 0, ports: [], vented: [false] };
  if (type === "ported") return { n: 1, front: -1, rear: 0, ports: [{ a: 0, b: -1, key: "port" }], vented: [true] };
  if (type === "bp4") return { n: 2, front: 1, rear: 0, ports: [{ a: 1, b: -1, key: "port" }], vented: [false, true] };
  // 6th order: the front chamber always ported out; the rear one out too (parallel) or into the front one (series)
  return { n: 2, front: 1, rear: 0, ports: [{ a: 1, b: -1, key: "port" }, { a: 0, b: series ? 1 : -1, key: "port2" }], vented: [true, true] };
}

/** A port's acoustic mass's effective length: its own length plus the air moving at both ends. */
export const effLen = (len, area1) => len + PORT_K * Math.sqrt(area1);
/** The tuning of a chamber of volume V with ports of total area S, each of area S1 and length len. */
export const tuneOf = (V, S, S1, len) => (C / TAU) * Math.sqrt(S / (V * effLen(len, S1)));
/** The port length for a tuning fb (can come out under zero: a port that big can't tune that high). */
export const lenFor = (V, S, S1, fb) => (C * C * S) / (TAU * TAU * fb * fb * V) - PORT_K * Math.sqrt(S1);

// ---------------------------------------------------------------------------------------------------- simulating it
/** A log-spaced list of frequencies. */
export function freqs(f0 = 10, f1 = 300, n = 240) { const a = []; for (let i = 0; i < n; i++) a.push(f0 * Math.pow(f1 / f0, i / (n - 1))); return a; }

/**
 * Simulates a system. sys: { drv (from driver()), count, power (W, total from the amp), type, series,
 * V: [net m³ per chamber], ports: [{ S (total area), S1 (one port's area), len, a, b }] in topology order, ql (box
 * leakage Q, vented chambers), le (false: leave the voice coil's inductance out) }.
 * Gives per frequency: spl (dB, 1 m, half space), x (peak cone excursion, m), vel[] (each port's peak air speed, m/s),
 * z (|impedance| of one sub, Ω), gd (group delay, s), and ref (the mass-controlled level at that power).
 */
export function simulate(sys, fr = freqs()) {
  const { drv, type } = sys, N = Math.max(1, sys.count | 0), topo = topology(type, sys.series);
  const e = Math.sqrt((Math.max(0.01, sys.power) / N) * drv.re);       // volts across each sub (its share of the power, into Re)
  const Cab = sys.V.map((v) => Math.max(1e-6, v) / (RHO * C * C));
  const ports = topo.ports.map((p, i) => {
    const q = sys.ports[i] || {};
    const S = Math.max(1e-6, q.S || 1e-3), S1 = Math.max(1e-6, q.S1 || S), len = Math.max(0, q.len || 0);
    const Ma = (RHO * effLen(len, S1)) / S;
    const fb = (1 / TAU) / Math.sqrt(Ma * Cab[p.a]);
    return { ...p, S, Ma, Ra: sys.lossless ? 0 : (TAU * fb * Ma) / 60, fb };   // (port losses: a Q of 60)
  });
  // leakage on the vented chambers (a Q of ql at their tuning)
  const leakW = topo.vented.map((v, k) => { const p = ports.find((q) => q.a === k); return v && p && !sys.lossless ? TAU * p.fb : 0; });
  const ql = Math.max(1, sys.ql || 10);
  const out = { f: fr, spl: [], x: [], vel: ports.map(() => []), z: [], zph: [], gd: [], ph: [], ref: drv.sens + 20 * Math.log10(e / 2.83) + 20 * Math.log10(N) };
  for (const f of fr) {
    const w = TAU * f, jw = cx(0, w);
    // the chambers' pressures for a unit volume flow from the cone (into the front chamber, out of the rear one)
    const A = [], b = [];
    for (let k = 0; k < topo.n; k++) {
      A.push(new Array(topo.n).fill(null).map(() => cx(0)));
      A[k][k] = cx(leakW[k] ? (leakW[k] * Cab[k]) / ql : 0, w * Cab[k]);
      b.push(cx(k === topo.front ? 1 : k === topo.rear ? -1 : 0));
    }
    const Y = ports.map((p) => inv(cx(p.Ra, w * p.Ma)));
    ports.forEach((p, i) => {
      A[p.a][p.a] = add(A[p.a][p.a], Y[i]);
      if (p.b >= 0) { A[p.b][p.b] = add(A[p.b][p.b], Y[i]); A[p.a][p.b] = sub(A[p.a][p.b], Y[i]); A[p.b][p.a] = sub(A[p.b][p.a], Y[i]); }
    });
    const P = solve(A, b);                                            // pressure per unit total cone flow
    const pf = topo.front >= 0 ? P[topo.front] : cx(0), pr = topo.rear >= 0 ? P[topo.rear] : cx(0);
    // the cone: electrical (Re + jωLe), mechanical (Mms, Rms, Cms) and the air load of N subs into the same chambers
    const Ze = cx(drv.re, sys.le === false ? 0 : w * drv.le);
    const Zm = cx(drv.rms, w * drv.mms - 1 / (w * drv.cms));
    const Zl = mul(cx(N * drv.sd * drv.sd), sub(pf, pr));
    const Zt = add(Zm, Zl);
    const u = div(cx(drv.bl * e), add(mul(Ze, Zt), cx(drv.bl * drv.bl)));   // cone velocity (RMS)
    const Q = mul(cx(N * drv.sd), u);                                  // all the cones' volume flow
    // what comes out: the cones' front (sealed, ported), every port to the outside, the leaks
    let U = topo.front < 0 ? Q : cx(0);
    ports.forEach((p, i) => {
      const dp = p.b >= 0 ? sub(P[p.a], P[p.b]) : P[p.a];
      const Up = mul(mul(Y[i], dp), Q);
      out.vel[i].push((Math.SQRT2 * mag(Up)) / p.S);
      if (p.b < 0) U = add(U, Up);
    });
    for (let k = 0; k < topo.n; k++) if (leakW[k]) U = add(U, mul(mul(cx((leakW[k] * Cab[k]) / ql), P[k]), Q));
    const p = mul(cx(0, (w * RHO) / TAU), U);                          // pressure at 1 m, half space
    out.spl.push(20 * Math.log10(Math.max(1e-12, mag(p)) / 2e-5));
    out.ph.push(Math.atan2(p.im, p.re));
    out.x.push((Math.SQRT2 * mag(u)) / w);
    const Zin = add(Ze, div(cx(drv.bl * drv.bl), Zt));
    out.z.push(mag(Zin)); out.zph.push((Math.atan2(Zin.im, Zin.re) * 180) / Math.PI);
  }
  // group delay from the unwrapped phase
  const ph = out.ph.slice();
  for (let i = 1; i < ph.length; i++) { while (ph[i] - ph[i - 1] > Math.PI) ph[i] -= TAU; while (ph[i] - ph[i - 1] < -Math.PI) ph[i] += TAU; }
  for (let i = 0; i < fr.length; i++) {
    const a = Math.max(0, i - 1), z = Math.min(fr.length - 1, i + 1);
    out.gd.push(-(ph[z] - ph[a]) / (TAU * (fr[z] - fr[a])));
  }
  out.ports = ports.map((p) => ({ fb: p.fb, S: p.S }));
  return out;
}

/** The lowest frequency (scanning down from `from`) where the level falls `drop` dB under `ref`. */
export function cutoff(r, ref, drop = 3, from = 200) {
  let i = r.f.findIndex((f) => f >= from); if (i < 0) i = r.f.length - 1;
  for (; i > 0; i--) if (r.spl[i - 1] < ref - drop && r.spl[i] >= ref - drop) {
    const t = (ref - drop - r.spl[i - 1]) / (r.spl[i] - r.spl[i - 1]);
    return r.f[i - 1] * Math.pow(r.f[i] / r.f[i - 1], t);
  }
  return r.spl[0] >= ref - drop ? r.f[0] : null;
}
/** A bandpass's passband: the peak, and where it falls 3 dB under the peak on each side. */
export function band(r) {
  let k = 0; for (let i = 1; i < r.f.length; i++) if (r.spl[i] > r.spl[k] && r.f[i] < 250) k = i;
  const top = r.spl[k], lim = top - 3;
  let lo = null, hi = null;
  for (let i = k; i > 0; i--) if (r.spl[i - 1] < lim) { const t = (lim - r.spl[i - 1]) / (r.spl[i] - r.spl[i - 1]); lo = r.f[i - 1] * Math.pow(r.f[i] / r.f[i - 1], t); break; }
  for (let i = k; i < r.f.length - 1; i++) if (r.spl[i + 1] < lim) { const t = (r.spl[i] - lim) / (r.spl[i] - r.spl[i + 1]); hi = r.f[i] * Math.pow(r.f[i + 1] / r.f[i], t); break; }
  return { peak: top, fpeak: r.f[k], lo, hi };
}

// ---------------------------------------------------------------------------------------------------- designs
/** Sealed: the net volume for a chosen Qtc (null if the sub's own Qts is already that high). */
export function sealedVolume(drv, count, qtc) { const r = qtc / drv.qts; return r > 1.0001 ? (count * drv.vas) / (r * r - 1) : null; }
/** Sealed: the Qtc and resonance a net volume gives. */
export function sealedQ(drv, count, V) { const a = Math.sqrt(1 + (count * drv.vas) / Math.max(1e-6, V)); return { qtc: drv.qts * a, fc: drv.fs * a }; }

/** A quick port for simulating designs (round, sized so it never limits the result). */
const idealPort = (V, fb) => { let S = 0.01; while (S < 3 && lenFor(V, S, S, fb) < 0.08) S *= 1.5; return { S, S1: S, len: Math.max(0, lenFor(V, S, S, fb)) }; };

/** Ported, the textbook flat alignment (QB3, after Keele): volume and tuning. */
export function ventedFlat(drv, count) {
  return { V: 15 * Math.pow(drv.qts, 2.87) * drv.vas * count, fb: 0.42 * drv.fs * Math.pow(drv.qts, -0.9) };
}
/** Ported, for a chosen tuning: the box size with the flattest response above the tuning (the least difference
 * between its highest and lowest point from the tuning up to 3.5 times it, or 100 Hz), lower bass breaking ties. A
 * bigger box at the same tuning humps over it; a smaller one sags into it. */
export function ventedVolumeFor(drv, count, fb) {
  const fr = freqs(Math.max(8, fb * 0.4), Math.max(110, fb * 3.6), 160), top = Math.max(100, fb * 3.5);
  const cost = (V) => {
    const port = idealPort(V, fb);
    if (port.len < 0.02) return Infinity;                       // (no port could tune a box that big that high)
    const r = simulate({ drv, count, power: 1, type: "ported", V: [V], ports: [port], le: false }, fr);
    let hi = -1e9, lo = 1e9;
    for (let i = 0; i < r.f.length; i++) if (r.f[i] >= fb && r.f[i] <= top) { const v = r.spl[i] - r.ref; hi = Math.max(hi, v); lo = Math.min(lo, v); }
    return hi - lo + 0.04 * (cutoff(r, r.ref) || fb * 2);
  };
  const v0 = 0.1 * count * drv.vas, v1 = 5 * count * drv.vas;
  let best = v0, bc = Infinity;
  for (let i = 0; i <= 48; i++) { const V = v0 * Math.pow(v1 / v0, i / 48), c = cost(V); if (c < bc) { bc = c; best = V; } }
  let lo = best / 1.1, hi = best * 1.1;                         // refine (golden section)
  for (let i = 0; i < 24; i++) { const a = lo * Math.pow(hi / lo, 0.382), b = lo * Math.pow(hi / lo, 0.618); if (cost(a) < cost(b)) hi = b; else lo = a; }
  return Math.sqrt(lo * hi);
}

/** 4th-order bandpass, closed form: S sets the passband's shape (0.7: flat; lower: more ripple, more output), gain
 * (dB over the sub alone) its width. The sealed chamber and the sub resonate at fb, where the ported chamber is
 * tuned, which keeps the passband symmetrical. */
export function bp4Design(drv, count, S = 0.7, gainDb = 0) {
  const vas = count * drv.vas, qp = 1 / (2 * S);
  const qbp = Math.max(drv.qts * 1.08, qp * Math.pow(10, gainDb / 40));
  const r = qbp / drv.qts;
  return { vr: vas / (r * r - 1), vf: (2 * S * drv.qts) ** 2 * vas, fb: (qbp * drv.fs) / drv.qts, qbp, gain: 40 * Math.log10(qbp / qp) };
}

/** 4th-order bandpass for a chosen tuning (the band's centre): the sealed chamber sets the sub's resonance there, the
 * ported chamber's size comes from S (the passband's shape); the gain over the sub alone follows from them. */
export function bp4At(drv, count, S = 0.7, fb = 50) {
  const vas = count * drv.vas, qp = 1 / (2 * S);
  const qbp = Math.max(drv.qts * 1.06, (fb * drv.qts) / drv.fs), r = qbp / drv.qts;
  return { vr: vas / (r * r - 1), vf: (2 * S * drv.qts) ** 2 * vas, fb: (qbp * drv.fs) / drv.qts, qbp, gain: 40 * Math.log10(qbp / qp) };
}

/** Nelder–Mead: minimises f over x (an array). */
function nelderMead(f, x0, step, iters = 260) {
  const n = x0.length;
  let pts = [x0.slice()]; for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += step[i]; pts.push(p); }
  let val = pts.map(f);
  for (let it = 0; it < iters; it++) {
    const order = val.map((v, i) => i).sort((a, b) => val[a] - val[b]);
    pts = order.map((i) => pts[i]); val = order.map((i) => val[i]);
    const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const at = (k) => c.map((v, j) => v + k * (pts[n][j] - v));
    const xr = at(-1), fr = f(xr);
    if (fr < val[0]) { const xe = at(-2), fe = f(xe); if (fe < fr) { pts[n] = xe; val[n] = fe; } else { pts[n] = xr; val[n] = fr; } }
    else if (fr < val[n - 1]) { pts[n] = xr; val[n] = fr; }
    else {
      const xc = at(fr < val[n] ? -0.5 : 0.5), fc = f(xc);
      if (fc < Math.min(fr, val[n])) { pts[n] = xc; val[n] = fc; }
      else { for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])); val[i] = f(pts[i]); } }
    }
  }
  let b = 0; for (let i = 1; i <= n; i++) if (val[i] < val[b]) b = i;
  return { x: pts[b], v: val[b] };
}

/** 6th-order bandpass: chamber volumes and tunings found by search, for the flattest output between lo and hi Hz
 * without the box growing past what it needs (both chambers ported out, or series: the rear into the front). */
export function bp6Design(drv, count, series, lo = 30, hi = 80, wt = {}) {
  const wv = wt.vol ?? 0.15, wg = wt.gain ?? 0.12;
  lo = Math.max(12, lo); hi = Math.max(lo * 1.4, hi);
  const vas = count * drv.vas, fr = freqs(lo, hi, 28), out = freqs(hi * 1.5, hi * 3, 6);
  const all = fr.concat(out);
  const cost = (x) => {
    const [vr, vf, f0, f1] = x.map(Math.exp);
    if (vr < 0.03 * vas || vf < 0.03 * vas || vr > 8 * vas || vf > 8 * vas || f0 < 0.6 * lo || f1 < lo || f0 > hi || f1 > 2 * hi) return 1e6;
    const r = simulate({ drv, count, power: 1, type: "bp6", series, V: [vr, vf], ports: [idealPort(vf, f1), idealPort(vr, f0)], le: false }, all);
    const s = r.spl.slice(0, fr.length), m = s.reduce((a, b) => a + b, 0) / s.length;
    const dev = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length);
    const over = Math.max(0, Math.max(...r.spl.slice(fr.length)) - m + 2);       // keep it falling off above the band
    return dev + 0.6 * over + wv * Math.log((vr + vf) / vas) - wg * (m - r.ref);
  };
  const g = Math.sqrt(lo * hi);
  // a coarse look over the whole range first, then a search from the three best places
  const grid = [];
  for (const a of [0.15, 0.3, 0.6, 1.2, 2.4]) for (const b2 of [0.12, 0.25, 0.5, 1]) for (const f0 of [0.75 * lo, lo, g]) for (const f1 of [g, 0.75 * hi, hi]) {
    const x = [Math.log(a * vas), Math.log(b2 * vas), Math.log(f0), Math.log(f1)];
    grid.push({ x, v: cost(x) });
  }
  grid.sort((p, q) => p.v - q.v);
  let best = null;
  for (const s0 of grid.slice(0, 3)) {
    const r = nelderMead(cost, s0.x, [0.3, 0.3, 0.15, 0.15]);
    if (!best || r.v < best.v) best = r;
  }
  const [vr, vf, f0, f1] = best.x.map(Math.exp);
  return { vr, vf, fr: f0, ff: f1 };
}

// ---------------------------------------------------------------------------------------------------- the box itself
/** Where n subs go in a w×h area: the grid (any number of columns and rows, the last row centred) with the most room
 * round each cutout. Each: [u, v] from the area's corner; fit: room enough. */
function arrange(n, w, h, d) {
  const m = 0.012;                                  // a little wood between cutouts and to the edges
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols), cw = w / cols, ch = h / rows, fit = cw >= d + m && ch >= d + m;
    const at = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols), c = i % cols, inRow = r === rows - 1 ? n - r * cols : cols;
      at.push([cw * (c + 0.5 + (cols - inRow) / 2), ch * (r + 0.5)]);
    }
    const g = { at, fit, room: Math.min(cw, ch) - d, rows };
    if (!best || (g.fit && !best.fit) || (g.fit === best.fit && g.room > best.room + 1e-9)) best = g;
  }
  return best;
}

/**
 * The box from its measurements: B = { type, series, style ("std" | "hall": bandpass with the subs on two dividers
 * facing each other across a middle chamber), shape ("rect"|"wedge"), w, h, d, dt (top depth, wedge), t, dbl (double
 * front), brace (m³), count, sub: { size, cutout, depth, disp, pe, xmax }, port, port2: { kind ("slot"|"round"), w
 * (slot width), dia, n, auto, len (manual), fb (tuning wanted) }, split (the rear chamber(s)' share of the room
 * across; or wr, a rear room's own width) }.
 * Gives the inside, each chamber's gross and net volume (and what it lost), each port's area, length and tuning, where
 * everything sits (for the 3D view), the cut list and what's wrong with it.
 */
export function layout(B, quick = false) {
  const t = Math.max(0.003, B.t), tf = B.dbl ? 2 * t : t;
  const bp = B.type === "bp4" || B.type === "bp6", hall = bp && B.style === "hall";
  const W = Math.max((hall ? 6 : 4) * t + 0.03, B.w), H = Math.max(2 * t + 0.02, B.h), D = Math.max(tf + t + 0.02, B.d);
  const Dt = B.shape === "wedge" ? Math.min(D, Math.max(tf + t + 0.02, B.dt || D)) : D;
  const theta = Math.atan((D - Dt) / H), tb = t / Math.cos(theta);            // the back's slope and its depth-wise thickness
  const zo = (y) => D - ((D - Dt) * y) / H, zi = (y) => zo(y) - tb;           // outer and inner back, at height y
  const Wi = W - 2 * t, Hi = H - 2 * t, y0 = t, y1 = H - t;
  const zb = zi(y1);                                                           // the inside's shallowest back (the top)
  const Davg = (zi(y0) + zi(y1)) / 2 - tf, Dmin = zb - tf;
  const warn = [], topo = topology(B.type, B.series && !hall), N = Math.max(1, B.count | 0);
  const sub = B.sub;
  if (Dmin < 0.02 || Wi < 0.02 || Hi < 0.02) warn.push("The box is too small for the wood's thickness.");
  // the rooms across the width ([x from, x to] inside), each one part of an acoustic chamber (k): the chamber behind the
  // subs is 0, the one they fire into 1. A hallway: two rear rooms (one chamber), the middle one between them.
  let rooms, dividers = [];
  if (!bp) rooms = [{ x: [t, W - t], k: 0 }];
  else if (!hall) {
    const free = Math.max(0.02, Wi - t), xr = t + Math.min(free - 0.01, Math.max(0.01, B.wr != null ? B.wr : free * (B.split == null ? 0.55 : B.split)));
    rooms = [{ x: [t, xr], k: 0, wall: "left" }, { x: [xr + t, W - t], k: 1, wall: "right" }];
    dividers = [{ x: xr, face: 1, n: N }];                                      // (subs on its +x face, firing +x)
  } else {
    const free = Math.max(0.03, Wi - 2 * t), wr = Math.min(free / 2 - 0.01, Math.max(0.01, B.wr != null ? B.wr : (free * (B.split == null ? 0.6 : B.split)) / 2));
    rooms = [{ x: [t, t + wr], k: 0, wall: "left" }, { x: [2 * t + wr, W - 2 * t - wr], k: 1, wall: "top" }, { x: [W - t - wr, W - t], k: 0, wall: "right" }];
    const nl = Math.ceil(N / 2);
    dividers = [{ x: t + wr, face: 1, n: nl }, { x: W - 2 * t - wr, face: -1, n: N - nl }];
  }
  const nch = topo.n, gross = new Array(nch).fill(0);
  for (const r of rooms) gross[r.k] += (r.x[1] - r.x[0]) * Hi * Davg;
  const lost = gross.map(() => ({ sub: 0, port: 0, brace: 0 }));
  lost[0].sub = N * sub.disp;                                                  // the subs' bodies: behind the cones, chamber 0
  const gsum = gross.reduce((a, b) => a + b, 0);
  gross.forEach((g, k) => (lost[k].brace = (B.brace || 0) * (g / gsum)));

  // the ports (as the sound sees them: one per chamber, its area the sum of its copies) and their copies in the rooms
  const ports = topo.ports.map((tp) => {
    const P = (tp.key === "port2" ? B.port2 : B.port) || {};
    const inner = tp.b >= 0;                                                   // (series: rear chamber into the front one)
    const inst = rooms.filter((r) => r.k === tp.a).map((r) => ({ room: r, wall: bp ? r.wall : "left" }));
    let kind = P.kind === "round" ? "round" : "slot", n = 1, sw = 0, dia = 0, S1;
    const top = kind === "slot" && !inner && inst[0].wall === "top";
    const span = kind === "slot" ? (top ? inst[0].room.x[1] - inst[0].room.x[0] : Hi) : 0;
    if (kind === "slot") { sw = Math.max(0.005, P.w || 0.05); S1 = sw * span; }
    else { n = Math.max(1, Math.min(8, P.n | 0 || 1)); dia = Math.max(0.02, P.dia || 0.1); S1 = Math.PI * (dia / 2) ** 2; }
    const copies = inst.length, S = S1 * (kind === "round" ? n : 1) * copies;
    const through = inner ? t : tf;                                            // the wood it starts in (front, or the divider)
    const [xa, xb] = inst[0].room.x;
    return { key: tp.key, k: tp.a, inst, copies, xa, xb, inner, top, kind, n, sw, dia, span, S, S1, through, auto: P.auto !== false, manual: Math.max(0, P.len || 0), fbWant: P.fb || 35 };
  });
  // a port's displacement at a length: its air, and the wood walling it in (bent: two walls, one corner)
  const portLost = (p, len) => {
    const lin = Math.max(0, len - p.through);
    if (p.kind === "round") return p.copies * p.n * Math.PI * (p.dia / 2 + TUBE_WALL) ** 2 * lin;
    const run = p.inner ? p.xb - p.xa : Dmin;
    const bends = lin <= run - p.sw ? 0 : !p.inner && !p.top && lin > Dmin + (p.xb - p.xa) - 2 * p.sw ? 2 : 1;
    const panel = t * p.span * Math.max(0, lin - bends * (p.sw + t));
    return p.copies * (p.sw * p.span * lin + panel);
  };
  // (each chamber has one port at most.) The length for the tuning wanted: the port's length sets the room it takes,
  // which sets the volume, which sets the length; the first length that agrees with itself. None: the port would eat
  // the box.
  const net = gross.map((g, k) => g - lost[k].sub - lost[k].brace);
  for (const p of ports) {
    const G = Math.max(1e-5, net[p.k]);
    if (!p.auto) p.len = Math.max(p.through, p.manual);
    else {
      const g = (len) => { const V = G - portLost(p, len); return V <= 0.05 * G ? Infinity : lenFor(V, p.S, p.S1, p.fbWant) - len; };
      if (g(p.through) <= 0) { p.len = p.through; p.short = lenFor(G - portLost(p, p.through), p.S, p.S1, p.fbWant) < p.through - 1e-4; }
      else {
        let lmax = p.through; while (G - portLost(p, lmax * 1.25 + 0.01) > 0.05 * G && lmax < 40) lmax = lmax * 1.25 + 0.01;
        let a = p.through, b = null;
        for (let i = 1; i <= 80; i++) { const x = p.through + ((lmax - p.through) * i) / 80; if (g(x) <= 0) { b = x; break; } a = x; }
        if (b == null) { p.len = lmax; p.huge = true; }
        else { for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (g(m) > 0) a = m; else b = m; } p.len = b; }
      }
    }
    lost[p.k].port = portLost(p, p.len);
  }
  const Vnet = gross.map((g, k) => Math.max(1e-5, g - lost[k].sub - lost[k].brace - lost[k].port));
  if (quick) return { net: Vnet, gross };
  for (const p of ports) {
    p.fb = tuneOf(Vnet[p.k], p.S, p.S1, p.len);
    p.lin = p.len - p.through;
    p.pipe = C / (2 * effLen(p.len, p.S1));                                     // the port's own first resonance
    // (with its length held at the wood's thickness, a port tunes higher the bigger it is: one that would need to be
    // shorter than the wood is too small for this tuning in this much air)
    if (p.short) warn.push(`The ${portName(B, p)} is too small to tune that high in this much air: even as short as the wood, it tunes to ${tuneOf(Vnet[p.k], p.S, p.S1, p.len).toFixed(0)} Hz. Make it bigger, or tune lower.`);
    if (p.huge) warn.push(`The ${portName(B, p)} is too big for this box: at that size it would take up most of the box before reaching ${p.fbWant} Hz. Make the port smaller, tune higher, or make the box bigger.`);
  }

  // where things sit. Coordinates: x across (0 = left outside), y up, z from the front (0) to the back.
  const parts = [];      // { kind: "hex", group, c: 8 corners } for the 3D view
  const openings = [];   // openings in the front: { x: [x0, x1], y: [y0, y1] }
  const dividerGaps = [];
  const hex = (group, c, extra) => parts.push({ kind: "hex", group, c, ...extra });
  const boxC = (x0, y0_, z0, x1, y1_, z1) => [[x0, y0_, z0], [x1, y0_, z0], [x1, y1_, z0], [x0, y1_, z0], [x0, y0_, z1], [x1, y0_, z1], [x1, y1_, z1], [x0, y1_, z1]];
  const span3 = (a, b) => [Math.min(a, b), Math.max(a, b)];
  // a panel following the sloped back: x0..x1, y0..y1, from z0 to the inner back
  const toBack = (x0, ya, x1, yb, z0) => [[x0, ya, z0], [x1, ya, z0], [x1, yb, z0], [x0, yb, z0], [x0, ya, zi(ya)], [x1, ya, zi(ya)], [x1, yb, zi(yb)], [x0, yb, zi(yb)]];
  const name = (p, extra = "") => `${cap(portName(B, p))} wall${extra}`;
  const used = new Map();                                                      // room -> room the port takes at its wall

  for (const p of ports) {
    p.panels = []; p.tubes = [];
    for (const { room, wall } of p.inst) {
      const [xa, xb] = room.x;
      if (p.kind === "round") {
        // tubes: in a column by the room's wall (in the middle of a hallway), or low at the back of the divider (series)
        const r = p.dia / 2, m = 0.015, rows = Math.max(1, Math.floor((Hi - m) / (p.dia + m))), cols = Math.ceil(p.n / rows);
        for (let i = 0; i < p.n; i++) {
          const c = Math.floor(i / rows), rr = i % rows, inCol = Math.min(rows, p.n - c * rows);
          const y = y0 + Hi / 2 + (rr - (inCol - 1) / 2) * (p.dia + m);
          if (p.inner) p.tubes.push({ at: [xb + t, y, zb - r - m - c * (p.dia + m)], dir: [-1, 0, 0], len: p.len, r, through: t });
          else {
            const x = wall === "right" ? xb - r - m - c * (p.dia + m) : wall === "top" ? (xa + xb) / 2 + (c - (cols - 1) / 2) * (p.dia + m) : xa + r + m + c * (p.dia + m);
            p.tubes.push({ at: [x, y, 0], dir: [0, 0, 1], len: p.len, r, through: tf });
          }
        }
        used.set(room, { side: wall, w: cols * (p.dia + m) + m });
        continue;
      }
      const w = p.sw, lin = p.lin;
      if (p.inner) {
        // series 6th order: a slot from the divider along the back of the rear chamber, then (if it's longer than
        // that) forward along its side
        const xs = xb;
        dividerGaps.push([zb - w, zb]);
        p.bend = lin > (xs - xa) - w;
        if (!p.bend) {
          hex("inner", boxC(xs - lin, y0, zb - w - t, xs, y1, zb - w), { name: "port" });
          hex("air", boxC(xs - lin, y0, zb - w, xs + t, y1, zb), { name: "air" });
          p.panels.push({ name: name(p), a: Hi, b: lin });
        } else {
          const ze = zb + (xs - xa) - w - lin, lim = tf + w, over = lim - ze, zE = Math.max(ze, lim);
          if (over > 0) warn.push(`The ${portName(B, p)} is ${fmtLenSI(over)} too long for the rear chamber, even bent along its side: make that chamber deeper or wider, or the slot narrower.`);
          hex("inner", boxC(xa + w, y0, zb - w - t, xs, y1, zb - w), { name: "port" });
          hex("inner", boxC(xa + w, y0, zE, xa + w + t, y1, zb - w - t), { name: "port" });
          hex("air", boxC(xa, y0, zb - w, xs + t, y1, zb), { name: "air" });
          hex("air", boxC(xa, y0, zE, xa + w, y1, zb - w), { name: "air" });
          p.panels.push({ name: name(p, " (back)"), a: Hi, b: xs - xa - w }, { name: name(p, " (side)"), a: Hi, b: Math.max(0, zb - w - t - zE) });
          used.set(room, { side: "left", w: w + t });
        }
        continue;
      }
      if (wall === "top") {
        // a slot along the top of the room (a hallway's): back from the front, then down the back if it's longer
        const yw = y1 - w;
        openings.push({ x: [xa, xb], y: [yw, y1] });
        p.bend = lin > Dmin - w;
        if (!p.bend) {
          hex("inner", boxC(xa, yw - t, tf, xb, yw, tf + lin), { name: "port" });
          hex("air", boxC(xa, yw, 0, xb, y1, tf + lin), { name: "air" });
          p.panels.push({ name: name(p), a: xb - xa, b: lin });
        } else {
          const ye = y1 + (zb - tf) - w - lin, lim = y0 + w, over = lim - ye, yE = Math.max(ye, lim);
          if (over > 0) warn.push(`The ${portName(B, p)} is ${fmtLenSI(over)} too long to fit, even bent down the back: make the box taller or deeper, or the slot shorter.`);
          hex("inner", boxC(xa, yw - t, tf, xb, yw, zb - w), { name: "port" });
          hex("inner", boxC(xa, yE, zb - w - t, xb, yw - t, zb - w), { name: "port" });
          hex("air", boxC(xa, yw, 0, xb, y1, zb), { name: "air" });
          hex("air", boxC(xa, yE, zb - w, xb, yw, zb), { name: "air" });
          p.panels.push({ name: name(p, " (top)"), a: xb - xa, b: zb - w - tf }, { name: name(p, " (back)"), a: xb - xa, b: Math.max(0, yw - t - yE) });
          if (B.shape === "wedge") warn.push(`The ${portName(B, p)} bends down a sloped back: its length is close, not exact.`);
        }
        used.set(room, { side: "top", w: w + t });
        continue;
      }
      // a slot along the room's side wall: back from the front, then across the back if it's longer
      const left = wall !== "right", xw0 = left ? xa : xb, s = left ? 1 : -1, xw = xw0 + s * w;
      openings.push({ x: span3(xw0, xw), y: [y0, y1] });
      p.bend = lin > Dmin - w;
      if (!p.bend) {
        hex("inner", boxC(Math.min(xw, xw + s * t), y0, tf, Math.max(xw, xw + s * t), y1, tf + lin), { name: "port" });
        hex("air", boxC(Math.min(xw0, xw), y0, 0, Math.max(xw0, xw), y1, tf + lin), { name: "air" });
        p.panels.push({ name: name(p), a: Hi, b: lin });
      } else if (lin <= Dmin + (xb - xa) - 2 * w) {
        // an L: down the side, then across the back
        const xe = xw0 + s * (lin - (zb - tf) + w), xE = xe;
        hex("inner", boxC(Math.min(xw, xw + s * t), y0, tf, Math.max(xw, xw + s * t), y1, zb - w), { name: "port" });
        hex("inner", boxC(Math.min(xw + s * t, xE), y0, zb - w - t, Math.max(xw + s * t, xE), y1, zb - w), { name: "port" });
        hex("air", boxC(Math.min(xw0, xw), y0, 0, Math.max(xw0, xw), y1, zb), { name: "air" });
        hex("air", boxC(Math.min(xw, xE), y0, zb - w, Math.max(xw, xE), y1, zb), { name: "air" });
        p.panels.push({ name: name(p, " (side)"), a: Hi, b: zb - w - tf }, { name: name(p, " (back)"), a: Hi, b: Math.abs(xE - (xw + s * t)) });
        if (B.shape === "wedge") warn.push(`The ${portName(B, p)} bends along a sloped back: its length is close, not exact. A straight port (or a round one) is better in a wedge.`);
      } else {
        // a J: down one side, across the back, and forward along the other side
        const xf = left ? xb : xa, xfw = xf - s * w;                         // (the far wall, and the slot's inner side there)
        const ze = 2 * zb - tf - 2 * w + (xb - xa) - lin, lim = tf + w, over = lim - ze, zE = Math.max(ze, lim);
        if (over > 0) warn.push(`The ${portName(B, p)} is ${fmtLenSI(over)} too long to fit, even bent round the back and up the other side: make the box bigger, or the port narrower.`);
        hex("inner", boxC(Math.min(xw, xw + s * t), y0, tf, Math.max(xw, xw + s * t), y1, zb - w), { name: "port" });
        hex("inner", boxC(Math.min(xw + s * t, xfw), y0, zb - w - t, Math.max(xw + s * t, xfw), y1, zb - w), { name: "port" });
        hex("inner", boxC(Math.min(xfw, xfw - s * t), y0, zE, Math.max(xfw, xfw - s * t), y1, zb - w - t), { name: "port" });
        hex("air", boxC(Math.min(xw0, xw), y0, 0, Math.max(xw0, xw), y1, zb), { name: "air" });
        hex("air", boxC(Math.min(xw, xfw), y0, zb - w, Math.max(xw, xfw), y1, zb), { name: "air" });
        hex("air", boxC(Math.min(xfw, xf), y0, zE, Math.max(xfw, xf), y1, zb - w), { name: "air" });
        p.panels.push({ name: name(p, " (side)"), a: Hi, b: zb - w - tf }, { name: name(p, " (back)"), a: Hi, b: Math.abs(xfw - (xw + s * t)) }, { name: name(p, " (other side)"), a: Hi, b: Math.max(0, zb - w - t - zE) });
        if (B.shape === "wedge") warn.push(`The ${portName(B, p)} bends along a sloped back: its length is close, not exact.`);
        p.bend = 2;
        used.set(room, { side: "both", w: w + t });
        continue;
      }
      used.set(room, { side: wall === "right" ? "right" : "left", w: w + t });
    }
    if (p.kind === "round") {
      const room = Math.max(0, (p.inner ? p.xb - p.xa : Dmin) - p.dia);
      if (p.lin > room) warn.push(`The ${portName(B, p)} is ${fmtLenSI(p.lin - room)} too long to fit straight: it needs a bend, a slot port, or a bigger box.`);
      const u = used.get(p.inst[0].room);
      if (p.dia > Hi || (u && u.w > p.xb - p.xa)) warn.push(`The ${portName(B, p)} ${p.n > 1 ? "tubes don't" : "tube doesn't"} fit well on the panel: fewer or smaller tubes, or a bigger box.`);
    }
  }

  // the subs: on the front (sealed, ported) beside the ports, or on the divider(s) (bandpass), firing into chamber 1
  const subs = [];
  const sz = Math.max(0.05, sub.size || sub.cutout * 1.08);
  const S = (at, dir, panel) => ({ at, dir, size: sz, cutout: sub.cutout, depth: sub.depth, pe: sub.pe, xmax: sub.xmax, panel });
  if (!bp) {
    let xs0 = t, xs1 = W - t;
    const u = used.get(rooms[0]);
    if (u) { if (u.side === "right") xs1 -= u.w; else if (u.side === "both") { xs0 += u.w; xs1 -= u.w; } else xs0 += u.w; }
    const g = arrange(N, xs1 - xs0, Hi, sub.cutout);
    if (!g.fit) warn.push(`${N > 1 ? "The subs don't" : "The sub doesn't"} fit on the front${ports.length ? " next to the port" : ""}: make the box ${N > 1 ? "wider or taller" : Wi < Hi ? "wider" : "taller"}.`);
    for (const [uu, v] of g.at) subs.push(S([xs0 + uu, y0 + v, 0], [0, 0, -1], tf));
    if (sub.depth > Dmin - 0.01) warn.push(`The sub is deeper (${fmtLenSI(sub.depth)}) than the inside of the box: it won't fit.`);
  } else {
    const topSlot = ports.find((p) => p.top);
    const hTop = topSlot ? topSlot.sw + t : 0;                                 // (a hallway's top port runs over the subs)
    var topRoom = Infinity;                                                    // (the height free over the subs' rows)
    for (const dv of dividers) {
      if (dv.n) { const cols = Math.max(1, Math.floor(Dmin / (sub.cutout + 0.012))); topRoom = Math.min(topRoom, Hi - t - Math.ceil(dv.n / cols) * (sub.cutout + 0.012)); }
      if (!dv.n) continue;
      const g = arrange(dv.n, Dmin, Hi - hTop, sub.cutout);
      if (!g.fit) warn.push(`${N > 1 ? "The subs don't" : "The sub doesn't"} fit on the divider${dividers.length > 1 ? "s" : ""}: make the box deeper or taller.`);
      const xFace = dv.face > 0 ? dv.x + t : dv.x;
      for (const [uu, v] of g.at) subs.push(S([xFace, y0 + v, tf + uu], [dv.face, 0, 0], t));
    }
    // room behind each divider for the subs' magnets (less any port along that room's wall)
    for (const r of rooms.filter((q) => q.k === 0)) {
      const u = used.get(r), room = r.x[1] - r.x[0] - (u && u.side !== "top" ? u.w : 0);
      if (sub.depth > room - 0.01) { warn.push(`The sub is deeper (${fmtLenSI(sub.depth)}) than the rear chamber has room for${u ? " beside its port" : ""}: make that chamber wider.`); break; }
    }
    if (hall) {
      const mid = rooms[1].x[1] - rooms[1].x[0];
      if (mid < 0.075) warn.push(`The middle chamber (${fmtLenSI(mid)}) is too narrow for the subs facing each other: make it at least 3″ wide.`);
    }
  }

  // the shell: front (with the port openings), back, top, bottom, sides; the divider(s) (bandpass)
  const front = (z0, z1) => {
    const xs = [...new Set([0, W, ...openings.flatMap((o) => o.x)])].sort((a, b) => a - b);
    const ys = [...new Set([0, H, ...openings.flatMap((o) => o.y)])].sort((a, b) => a - b);
    const open = (x, y) => openings.some((o) => x > o.x[0] && x < o.x[1] && y > o.y[0] && y < o.y[1]);
    for (let j = 0; j < ys.length - 1; j++) {
      let run = null;                                                          // (cells in a row joined into one piece)
      for (let i = 0; i < xs.length - 1; i++) {
        const solid = !open((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2);
        if (solid && run == null) run = xs[i];
        if ((!solid || i === xs.length - 2) && run != null) { const xe = solid ? xs[i + 1] : xs[i]; hex("wall", boxC(run, ys[j], z0, xe, ys[j + 1], z1), { name: "front" }); run = null; }
      }
    }
  };
  front(0, t); if (B.dbl) front(t, 2 * t);
  hex("wall", [[0, 0, zi(0)], [W, 0, zi(0)], [W, H, zi(H)], [0, H, zi(H)], [0, 0, zo(0)], [W, 0, zo(0)], [W, H, zo(H)], [0, H, zo(H)]], { name: "back" });
  hex("wall", toBack(0, 0, W, y0, tf), { name: "bottom" });
  hex("wall", toBack(0, y1, W, H, tf), { name: "top" });
  hex("wall", toBack(0, y0, t, y1, tf), { name: "left" });
  hex("wall", toBack(W - t, y0, W, y1, tf), { name: "right" });
  for (const dv of dividers) {
    const xd = dv.x;
    if (!dividerGaps.length || hall) hex("inner", toBack(xd, y0, xd + t, y1, tf), { name: "divider" });
    else {
      const [g0, g1] = dividerGaps[0];
      hex("inner", boxC(xd, y0, tf, xd + t, y1, g0), { name: "divider" });
      if (Dt < D) hex("inner", [[xd, y0, g1], [xd + t, y0, g1], [xd + t, y1, g1], [xd, y1, g1], [xd, y0, zi(y0)], [xd + t, y0, zi(y0)], [xd + t, y1, zi(y1)], [xd, y1, zi(y1)]], { name: "divider" });
    }
  }
  // the chambers' air (shown faintly in the see-through view)
  for (const r of rooms) parts.push({ kind: "hex", group: "chamber", k: r.k, vented: topo.vented[r.k], c: toBack(r.x[0], y0, r.x[1], y1, tf) });

  // the cut list (each panel's two sides, in metres). Front and back cover everything; top and bottom run between
  // them; the sides fit inside all four.
  const bev = (theta * 180) / Math.PI;
  const cut = [
    { name: "Front (baffle)", n: B.dbl ? 2 : 1, a: W, b: H, note: B.dbl ? "glued together: a double baffle" : "" },
    { name: "Back", n: 1, a: W, b: Dt < D ? H / Math.cos(theta) : H, note: Dt < D ? `long side; bevel top and bottom edges ${bev.toFixed(1)}°` : "" },
    { name: "Top", n: 1, a: W, b: zi(y1) - tf, note: Dt < D ? `long side; bevel the back edge ${bev.toFixed(1)}°` : "" },
    { name: "Bottom", n: 1, a: W, b: zi(0) - tf, note: Dt < D ? `long side; bevel the back edge ${bev.toFixed(1)}°` : "" },
    Dt < D ? { name: "Sides", n: 2, a: Hi, b: zi(y0) - tf, b2: zi(y1) - tf, note: `a wedge: ${fmtLenSI(zi(y0) - tf)} at the bottom, ${fmtLenSI(zi(y1) - tf)} at the top` }
      : { name: "Sides", n: 2, a: Hi, b: Dmin },
  ];
  if (dividers.length) cut.push(Dt < D ? { name: "Divider", n: dividers.length, a: Hi, b: zi(y0) - tf, b2: Dmin, note: "a wedge, like the sides" } : { name: "Divider", n: dividers.length, a: Hi, b: Dmin });
  for (const p of ports) {
    // (a hallway's two rear ports: the same walls twice)
    const groups = new Map();
    for (const q of p.panels) { const k = `${q.name}|${q.a.toFixed(4)}|${q.b.toFixed(4)}`; groups.set(k, { ...q, n: (groups.get(k)?.n || 0) + 1 }); }
    for (const q of groups.values()) cut.push({ name: q.name, n: q.n, a: q.a, b: q.b });
  }
  // wood area (to buy enough)
  const area = cut.reduce((s, c) => s + c.n * c.a * (c.b2 ? (c.b + c.b2) / 2 : c.b), 0);

  return {
    W, H, D, Dt, t, tf, Wi, Hi, Davg, Dmin, theta, zb, zo, zi, rooms, chambers: rooms.map((r) => r.x), gross, lost, net: Vnet, ports, subs, parts, cut, area, warn,
    outside: W * H * (D + Dt) / 2, hall, topRoom: typeof topRoom === "number" ? topRoom : Infinity,
  };
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
/** "port", "front port", "rear port(s)", "inner port", "middle port". */
export function portName(B, p) {
  const hall = (B.type === "bp4" || B.type === "bp6") && B.style === "hall";
  if (B.type === "bp4") return hall ? "middle port" : "port";
  if (B.type === "bp6") return p.key === "port2" ? (hall ? "rear ports" : B.series ? "inner port" : "rear port") : hall ? "middle port" : "front port";
  return "port";
}
// (warnings are worded in inches; the screen converts the numbers it shows itself)
function fmtLenSI(m) { return `${(m / IN).toFixed(1)}″`; }

/** Solves one measurement (w, h or d) so the box's net volume is `target` (bandpass: the divider(s) move too, so each
 * chamber gets its own target). Returns the new B, or null if it can't. */
export function fitBox(B, solveFor, target, target2) {
  const bp = B.type === "bp4" || B.type === "bp6", hall = bp && B.style === "hall", walls = hall ? 4 : 3;
  const bisect = (lo, hi, f) => { if (f(hi) < 0 || f(lo) > 0) return f(lo) > 0 ? lo : null; for (let i = 0; i < 34; i++) { const m = (lo + hi) / 2; if (f(m) < 0) lo = m; else hi = m; } return hi; };
  if (bp && solveFor === "w") {
    // the width: the chambers sit side by side, so the rear room(s)' width on its own, then the rest (twice, for the
    // bracing's share)
    // each rear room at least as wide as a sub's magnet (and the port along its wall); the middle (or front) room
    // wide enough for the cones (and its port): a smaller volume asked for grows to that
    const t = B.t, P1 = B.port || {}, P2 = B.port2 || {}, slot = (P) => (P.kind !== "round" ? (P.w || 0) + t : 0);
    const wrMin = (B.sub ? B.sub.depth : 0) + 0.75 * IN + (B.type === "bp6" ? slot(P2) : 0);
    const tubes = (P) => Math.ceil((P.n || 1) / Math.max(1, Math.floor((B.h - 2 * t) / ((P.dia || 0.1) + 0.015)))) * ((P.dia || 0.1) + 0.015) + 0.015;
    // (a hallway: wide enough for the cones, and for a top port big enough for its air, about 12 in² per ft³, no
    // deeper than 30% of the height)
    const hallMin = Math.max(3 * IN, P1.kind === "round" ? tubes(P1) : (12 * (target2 / FT3) * IN * IN) / (0.3 * (B.h - 2 * t)));
    const wfMin = hall ? hallMin : (P1.kind === "round" ? tubes(P1) : slot(P1)) + 2 * IN;
    let W = Math.max(B.w, 0.4), wr = 0.2, grew = false;
    const rearRooms = hall ? 2 : 1;
    for (let pass = 0; pass < 2; pass++) {
      let r = bisect(0.01, 3, (x) => layout({ ...B, w: Math.max(W, walls * t + rearRooms * x + 0.08), wr: x }, true).net[0] - target);
      if (r == null) return null;
      if (r < wrMin) { r = wrMin; grew = true; }
      wr = r;
      const wmin = walls * t + rearRooms * wr + wfMin;
      let w2 = bisect(walls * t + rearRooms * wr + 0.03, 10, (x) => layout({ ...B, w: x, wr }, true).net[1] - target2);
      if (w2 == null) return null;
      if (w2 < wmin) { w2 = wmin; grew = true; }
      W = w2;
    }
    const out = { ...B, w: W, split: (rearRooms * wr) / Math.max(0.02, W - walls * t), wr: undefined };
    if (grew) out.grow = layout(out, true).net;
    return out;
  }
  const at = (x, split) => layout({ ...B, [solveFor]: x, ...(solveFor === "d" && B.shape === "wedge" ? { dt: x * (B.dt / B.d) } : {}), ...(split != null ? { split } : {}) }, true);
  const splitFor = (x) => {
    // the divider(s) where the two chambers' nets are in the ratio wanted
    let lo = 0.03, hi = 0.97;
    for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2, g = at(x, m); if (g.net[0] / g.net[1] < target / target2) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const total = bp ? target + target2 : target;
  const netOf = (x) => { if (!bp) return at(x).net[0]; const s = splitFor(x); const g = at(x, s); return g.net[0] + g.net[1]; };
  let lo = 2 * B.t + 0.03, hi = 6;
  if (netOf(hi) < total) return null;
  for (let i = 0; i < 34; i++) { const m = (lo + hi) / 2; if (netOf(m) < total) lo = m; else hi = m; }
  const x = hi, out = { ...B, [solveFor]: x };
  if (solveFor === "d" && B.shape === "wedge") out.dt = x * (B.dt / B.d);
  if (bp) out.split = splitFor(x);
  return out;
}

/** The port area that keeps its air under `vmax` m/s (peak) at the power used, from a simulation with the port as it
 * is (a port's air flow hardly depends on its size, so its speed goes as 1/area), kept between `lo` and `hi` in² per
 * ft³ of the chamber it tunes (much smaller and it chuffs; much bigger and it can't fit). */
export function portAreaFor(sim, i, V, vmax = 26, fmin = 0, lo = 10, hi = 24) {
  let v = 0; for (let k = 0; k < sim.f.length; k++) if (sim.f[k] >= fmin) v = Math.max(v, sim.vel[i][k]);
  const per = V / FT3, S = sim.ports[i].S * (v / vmax);
  return Math.min(hi * per, Math.max(lo * per, S / (IN * IN))) * IN * IN;
}

/** Whether something in a layout doesn't fit (a port too long, a sub too deep or too big for its panel). */
export const misfits = (L) => L.warn.filter((w) => /fit|too long|deeper|too narrow|too small/.test(w)).length;
/** A good shape for the design: the measurement being solved comes from the volume; the other two are searched for the
 * most compact box where it all fits, not taller than it is wide, inside the space given (lim: { w, h, d }, 0 for no
 * limit). The search covers sizes stepping up from the least the subs need (tall enough for their cutouts, deep enough
 * for their magnets) and the sizes that fit one, two, three… rows of subs exactly. Whole inches. Returns the new B
 * (or null). */
export function shapeBox(B, solveFor, t1, t2, lim = {}) {
  const t = B.t, tf = B.dbl ? 2 * t : t, s = B.sub, bp = B.type === "bp4" || B.type === "bp6", hall = bp && B.style === "hall";
  const N = Math.max(1, B.count | 0), per = hall ? Math.ceil(N / 2) : N, cell = s.cutout + 0.6 * IN;
  const up = (x) => Math.ceil(x / IN - 1e-6) * IN;
  const topSlot = hall && (B.port || {}).kind !== "round" ? ((B.port || {}).w || 0.04) + t : 0;
  const min = bp ? { w: up((hall ? 2 : 1) * (s.depth + 1.5 * IN) + (hall ? 4 * t + 3 * IN : 3 * t + 4 * IN)), h: up(cell + 2 * t + topSlot), d: up(cell + tf + t) }
    : { w: up(cell + 2 * t + (B.type === "ported" ? ((B.port || {}).kind === "round" ? ((B.port || {}).dia || 0.1) + 1.2 * IN : ((B.port || {}).w || 0.04) + t) : 0)), h: up(cell + 2 * t), d: up(s.depth + tf + t + IN) };
  const [fa, fb] = ["w", "h", "d"].filter((k) => k !== solveFor);
  const ratio = B.shape === "wedge" ? Math.min(1, B.dt / B.d) : 1;
  const ok = (k, v) => !(lim[k] > 0) || v <= lim[k] + 1e-6;
  // the sizes to try for each free measurement
  const values = (k) => {
    const set = new Set();
    for (let i = 0; i <= 9; i++) set.add(Math.round((min[k] + i * 3 * IN) / IN));
    for (let r = 1; r <= Math.min(per, 8); r++) {
      const c = Math.ceil(per / r);
      // (a hallway with many subs: room above them for a top port up to 30% of the height)
      if (k === "h") set.add(Math.round(up(r * cell + 2 * t + (hall && per >= 4 && topSlot ? Math.max(topSlot, 0.43 * r * cell) : topSlot)) / IN));
      if (k === "w" && !bp) set.add(Math.round(up(c * cell + 2 * t + 3 * IN) / IN));
      if (k === "d" && bp) set.add(Math.round(up(c * cell + tf + t) / IN));
    }
    if (lim[k] > 0) set.add(Math.floor(lim[k] / IN));
    return [...set].map((v) => v * IN).filter((v) => v >= min[k] - 1e-6 && ok(k, v));
  };
  const seen = new Map();
  const at = (a, b) => {
    const key = Math.round(a / IN) + "," + Math.round(b / IN);
    if (seen.has(key)) return seen.get(key);
    const C = { ...B, [fa]: a, [fb]: b }; if (B.shape === "wedge") C.dt = C.d * ratio;
    let f = fitBox(C, solveFor, t1, t2);
    let r = null;
    if (f) {
      // (the volume wanted is less than the smallest box the subs fit in: that box, and its bigger volume. On a front:
      // as many columns of subs as the rows the height holds need, and the port beside them)
      const need = { ...min };
      if (!bp) {
        const room = min.w - up(cell + 2 * t);                                  // (the port's share of the width)
        if (solveFor === "w") { const rows = Math.max(1, Math.floor((C.h - 2 * t) / cell)); need.w = Math.max(min.w, up(Math.ceil(N / rows) * cell + 2 * t + room)); }
        if (solveFor === "h") { const cols = Math.max(1, Math.floor((C.w - 2 * t - room) / cell)); need.h = Math.max(min.h, up(Math.ceil(N / cols) * cell + 2 * t)); }
      }
      const floor = need[solveFor];
      if (f[solveFor] < floor - 1e-6) { f = { ...f, [solveFor]: floor, ...(solveFor === "d" && B.shape === "wedge" ? { dt: floor * ratio } : {}) }; f.grow = layout(f, true).net; }
      const L = layout(f), x = { w: L.W, h: L.H, d: L.D };
      const over = Math.max(0, lim[solveFor] > 0 ? x[solveFor] - lim[solveFor] : 0);
      const cost = misfits(L) * 1000 + over / IN * 300 + (x.w + x.h + x.d) / IN + 1.5 * Math.max(0, x.h - x.w) / IN + (f.grow ? 40 : 0);
      r = { f, cost };
    }
    seen.set(key, r); return r;
  };
  let best = null;
  const va = values(fa), vb = values(fb);
  for (const a of va) for (const b of vb) { const r = at(a, b); if (r && (!best || r.cost < best.cost)) best = r; }
  if (!best) return null;
  const ca = best.f[fa], cb = best.f[fb];
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const a = ca + i * IN, b = cb + j * IN; if (a < min[fa] - 1e-6 || b < min[fb] - 1e-6 || !ok(fa, a) || !ok(fb, b)) continue;
    const r = at(a, b); if (r && r.cost < best.cost) best = r;
  }
  return best.f;
}

// ---------------------------------------------------------------------------------------------------- wiring
/** The loads n subs (1 to 20, single or dual voice coils of `ohms` each) can be wired to, with how: every way of
 * splitting them into equal series groups wired in parallel. */
export function wiring(n, dual, ohms) {
  const per = dual ? [[ohms * 2, "each sub's two coils in series"], [ohms / 2, "each sub's two coils in parallel"]] : [[ohms, ""]];
  const out = [];
  for (const [z, how] of per) for (let s = 1; s <= n; s++) {
    if (n % s) continue;
    const p = n / s, Z = (z * s) / p;
    let what;
    if (n === 1) what = how ? cap(how.replace("each sub's", "the")) : "Straight to the amp";
    else {
      const g = s === 1 ? `all ${n} subs in parallel` : p === 1 ? `all ${n} subs in series` : `${p} groups of ${s} in series, the groups in parallel`;
      what = cap(how ? `${how}, ${g}` : g);
    }
    out.push({ ohms: Z, how: what });
  }
  const seen = new Map();
  for (const o of out) { const k = Math.round(o.ohms * 1000); if (!seen.has(k)) seen.set(k, o); }
  return [...seen.values()].filter((o) => o.ohms >= 0.1 && o.ohms <= 40).sort((a, b) => a.ohms - b.ohms);
}
