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
    return { ...p, S, Ma, Ra: (TAU * fb * Ma) / 60, fb };            // (port losses: a Q of 60)
  });
  // leakage on the vented chambers (a Q of ql at their tuning)
  const leakW = topo.vented.map((v, k) => { const p = ports.find((q) => q.a === k); return v && p ? TAU * p.fb : 0; });
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
/** Where the subs go in a w×h area (centred): one row, or two. Each: [u, v] from the area's corner; fit: room enough. */
function arrange(n, w, h, d) {
  const m = 0.012;                                  // a little wood between cutouts and to the edges
  const tryGrid = (cols, rows) => {
    const cw = w / cols, ch = h / rows, fit = cw >= d + m && ch >= d + m;
    const at = []; for (let i = 0; i < n; i++) { const c = i % cols, r = Math.floor(i / cols); at.push([cw * (c + 0.5), ch * (r + 0.5)]); }
    return { at, fit, room: Math.min(cw, ch) - d };
  };
  const opts = [tryGrid(n, 1), tryGrid(1, n)];
  if (n >= 3) opts.push(tryGrid(Math.ceil(n / 2), 2), tryGrid(2, Math.ceil(n / 2)));
  return opts.sort((a, b) => (b.fit - a.fit) || (b.room - a.room))[0];
}

/**
 * The box from its measurements: B = { type, series, shape ("rect"|"wedge"), w, h, d, dt (top depth, wedge), t, dbl
 * (double front), brace (m³), count, sub: { size, cutout, depth, disp }, port, port2: { kind ("slot"|"round"), w (slot
 * width), dia, n, auto, len (manual), fb (tuning wanted) }, split (the rear chamber's share of the inside width) }.
 * Gives the inside, each chamber's gross and net volume (and what it lost), each port's area, length and tuning, where
 * everything sits (for the 3D view), the cut list and what's wrong with it.
 */
export function layout(B, quick = false) {
  const t = Math.max(0.003, B.t), tf = B.dbl ? 2 * t : t;
  const W = Math.max(4 * t + 0.02, B.w), H = Math.max(2 * t + 0.02, B.h), D = Math.max(tf + t + 0.02, B.d);
  const Dt = B.shape === "wedge" ? Math.min(D, Math.max(tf + t + 0.02, B.dt || D)) : D;
  const theta = Math.atan((D - Dt) / H), tb = t / Math.cos(theta);            // the back's slope and its depth-wise thickness
  const zo = (y) => D - ((D - Dt) * y) / H, zi = (y) => zo(y) - tb;           // outer and inner back, at height y
  const Wi = W - 2 * t, Hi = H - 2 * t, y0 = t, y1 = H - t;
  const zb = zi(y1);                                                           // the inside's shallowest back (the top)
  const Davg = (zi(y0) + zi(y1)) / 2 - tf, Dmin = zb - tf;
  const warn = [], topo = topology(B.type, B.series), N = Math.max(1, B.count | 0);
  const sub = B.sub, bp = B.type === "bp4" || B.type === "bp6";
  if (Dmin < 0.02 || Wi < 0.02 || Hi < 0.02) warn.push("The box is too small for the wood's thickness.");
  // the chambers across the width: [x from, x to] inside
  let ch;
  if (!bp) ch = [[t, W - t]];
  else {
    // (the divider: B.wr, the rear chamber's inside width, if given; else B.split, its share of the room)
    const free = Math.max(0.02, Wi - t), xr = t + Math.min(free - 0.01, Math.max(0.01, B.wr != null ? B.wr : free * (B.split == null ? 0.55 : B.split)));
    ch = [[t, xr], [xr + t, W - t]];
  }
  const gross = ch.map(([a, b]) => (b - a) * Hi * Davg);
  const lost = ch.map(() => ({ sub: 0, port: 0, brace: 0 }));
  lost[0].sub = N * sub.disp;                                                  // the sub's body: behind the cone, chamber 0
  const braceShare = gross.map((g) => g / gross.reduce((a, b) => a + b, 0));
  braceShare.forEach((s, k) => (lost[k].brace = (B.brace || 0) * s));

  // the ports: which chamber, which wall it runs along, how big
  const ports = topo.ports.map((tp) => {
    const P = (tp.key === "port2" ? B.port2 : B.port) || {};
    const k = tp.a, [xa, xb] = ch[k];
    const inner = tp.b >= 0;                                                   // (series: rear chamber into the front one)
    const side = bp ? (k === 0 ? "left" : "right") : "left";
    let S, S1, kind = P.kind === "round" ? "round" : "slot", n = 1, sw = 0, dia = 0;
    if (kind === "slot") { sw = Math.max(0.005, P.w || 0.05); S = S1 = sw * Hi; }
    else { n = Math.max(1, Math.min(6, P.n | 0 || 1)); dia = Math.max(0.02, P.dia || 0.1); S1 = Math.PI * (dia / 2) ** 2; S = n * S1; }
    const through = inner ? t : tf;                                            // the wood it starts in (front, or the divider)
    return { key: tp.key, k, xa, xb, inner, side, kind, n, sw, dia, S, S1, through, auto: P.auto !== false, manual: Math.max(0, P.len || 0), fbWant: P.fb || 35 };
  });
  // a port's length and displacement for a chamber volume; iterate (the port takes room, which retunes it)
  const portLost = (p, len) => {
    const lin = Math.max(0, len - p.through);
    if (p.kind === "round") return p.n * Math.PI * (p.dia / 2 + TUBE_WALL) ** 2 * lin;
    const straight = lin <= (p.inner ? p.xb - p.xa : Dmin) - p.sw;
    const panel = straight ? t * Hi * lin : t * Hi * Math.max(0, lin - p.sw - t);       // (bent: two walls, one corner)
    return p.sw * Hi * lin + panel;
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
    if (p.short) warn.push(`The ${portName(B, p)} is too big to tune that high: it would be shorter than the wood. Make it smaller, or tune lower.`);
    if (p.huge) warn.push(`The ${portName(B, p)} is too big for this box: at that size it would take up most of the box before reaching ${p.fbWant} Hz. Make the port smaller, tune higher, or make the box bigger.`);
  }

  // where things sit. Coordinates: x across (0 = left outside), y up, z from the front (0) to the back.
  const parts = [];      // { kind: "hex"|"lathe"|..., group, ... } for the 3D view
  const openings = [];   // slot openings in the front: [x0, x1]
  const dividerGaps = [];
  const hex = (group, c, extra) => parts.push({ kind: "hex", group, c, ...extra });
  const boxC = (x0, y0_, z0, x1, y1_, z1) => [[x0, y0_, z0], [x1, y0_, z0], [x1, y1_, z0], [x0, y1_, z0], [x0, y0_, z1], [x1, y0_, z1], [x1, y1_, z1], [x0, y1_, z1]];
  // a panel following the sloped back: x0..x1, y0..y1, from z0 to the inner back (minus `back`)
  const toBack = (x0, ya, x1, yb, z0, back = 0) => [[x0, ya, z0], [x1, ya, z0], [x1, yb, z0], [x0, yb, z0], [x0, ya, zi(ya) - back], [x1, ya, zi(ya) - back], [x1, yb, zi(yb) - back], [x0, yb, zi(yb) - back]];

  for (const p of ports) {
    p.parts = [];
    if (p.kind === "round") {
      // tubes: in a column by their wall (front ports), or low and to the back on the divider (series)
      const r = p.dia / 2, m = 0.015, rows = Math.max(1, Math.floor((Hi - m) / (p.dia + m))), cols = Math.ceil(p.n / rows);
      p.tubes = [];
      for (let i = 0; i < p.n; i++) {
        const c = Math.floor(i / rows), rr = i % rows, inCol = Math.min(rows, p.n - c * rows);
        const y = y0 + Hi / 2 + (rr - (inCol - 1) / 2) * (p.dia + m);
        if (p.inner) {
          const z = zb - r - m - c * (p.dia + m);
          p.tubes.push({ at: [p.xb + t, y, z], dir: [-1, 0, 0], len: p.len, r, through: t });
        } else {
          const x = p.side === "left" ? p.xa + r + m + c * (p.dia + m) : p.xb - r - m - c * (p.dia + m);
          p.tubes.push({ at: [x, y, 0], dir: [0, 0, 1], len: p.len, r, through: tf });
        }
      }
      p.used = cols * (p.dia + m) + m;                                           // width it takes on the front
      const room = p.inner ? (p.xb - p.xa) - p.dia : Dmin - p.dia;
      if (p.lin > room) warn.push(`The ${portName(B, p)} is ${fmtLenSI(p.lin - room)} too long to fit straight: it needs a bend, a slot port, or a bigger box.`);
      if (p.inner ? p.dia > Math.min(Hi, Dmin) : p.dia > Hi || p.used > (p.xb - p.xa) * 0.6) warn.push(`The ${portName(B, p)} ${p.n > 1 ? "tubes don't" : "tube doesn't"} fit well on the panel: fewer or smaller tubes, or a bigger box.`);
    } else {
      const w = p.sw, lin = p.lin;
      if (p.inner) {
        // series 6th order: a slot from the divider along the back of the rear chamber, then (if it's longer than that)
        // forward along its side
        const xs = p.xb, xa = p.xa;
        dividerGaps.push([zb - w, zb]);
        p.bend = lin > (xs - xa) - w;
        if (!p.bend) {
          hex("inner", boxC(xs - lin, y0, zb - w - t, xs, y1, zb - w), { name: "port" });
          hex("air", boxC(xs - lin, y0, zb - w, xs + t, y1, zb), { name: "air" });
          p.panels = [{ name: `${cap(portName(B, p))} wall`, a: Hi, b: lin }];
        } else {
          const ze = zb + (xs - xa) - w - lin, lim = tf + w, over = lim - ze, zE = Math.max(ze, lim);
          if (over > 0) warn.push(`The ${portName(B, p)} is ${fmtLenSI(over)} too long for the rear chamber, even bent along its side: make that chamber deeper or wider, or the slot narrower.`);
          hex("inner", boxC(xa + w, y0, zb - w - t, xs, y1, zb - w), { name: "port" });
          hex("inner", boxC(xa + w, y0, zE, xa + w + t, y1, zb - w - t), { name: "port" });
          hex("air", boxC(xa, y0, zb - w, xs + t, y1, zb), { name: "air" });
          hex("air", boxC(xa, y0, zE, xa + w, y1, zb - w), { name: "air" });
          p.panels = [{ name: `${cap(portName(B, p))} wall (back)`, a: Hi, b: xs - xa - w }, { name: `${cap(portName(B, p))} wall (side)`, a: Hi, b: Math.max(0, zb - w - t - zE) }];
        }
      } else {
        const left = p.side === "left", xa = left ? p.xa : p.xb;           // the wall it runs along
        const s = left ? 1 : -1, xw = xa + s * w;                           // the slot's inner side
        openings.push(left ? [xa, xa + w] : [xa - w, xa]);
        const straight = lin <= Dmin - w;
        p.bend = !straight;
        if (straight) {
          hex("inner", boxC(Math.min(xw, xw + s * t), y0, tf, Math.max(xw, xw + s * t), y1, tf + lin), { name: "port" });
          hex("air", boxC(Math.min(xa, xw), y0, 0, Math.max(xa, xw), y1, tf + lin), { name: "air" });
          p.panels = [{ name: `${cap(portName(B, p))} wall`, a: Hi, b: lin }];
        } else {
          // an L: down the side, then across the back
          const xe = xa + s * (lin - (zb - tf) + w), lim = left ? p.xb - w : p.xa + w;
          const over = left ? xe - lim : lim - xe;
          if (over > 0) warn.push(`The ${portName(B, p)} is ${fmtLenSI(over)} too long to fit, even bent along the back: make the box wider or deeper, or the port narrower.`);
          const xE = over > 0 ? lim : xe;
          hex("inner", boxC(Math.min(xw, xw + s * t), y0, tf, Math.max(xw, xw + s * t), y1, zb - w), { name: "port" });
          hex("inner", boxC(Math.min(xw + s * t, xE), y0, zb - w - t, Math.max(xw + s * t, xE), y1, zb - w), { name: "port" });
          hex("air", boxC(Math.min(xa, xw), y0, 0, Math.max(xa, xw), y1, zb), { name: "air" });
          hex("air", boxC(Math.min(xw, xE), y0, zb - w, Math.max(xw, xE), y1, zb), { name: "air" });
          p.panels = [{ name: `${cap(portName(B, p))} wall (side)`, a: Hi, b: zb - w - tf }, { name: `${cap(portName(B, p))} wall (back)`, a: Hi, b: Math.abs(xE - (xw + s * t)) }];
          if (B.shape === "wedge") warn.push(`The ${portName(B, p)} bends along a sloped back: its length is close, not exact. A straight port (or a round one) is better in a wedge.`);
        }
      }
    }
  }

  // the subs: on the front (sealed, ported) beside the ports, or on the divider (bandpass), facing into chamber 1
  const subs = [];
  const sz = Math.max(0.05, sub.size || sub.cutout * 1.08);
  if (!bp) {
    let xs0 = t, xs1 = W - t;
    for (const p of ports) {
      if (p.kind === "slot") { if (p.side === "left") xs0 = Math.max(xs0, p.xa + p.sw + t); else xs1 = Math.min(xs1, p.xb - p.sw - t); }
      else if (p.side === "left") xs0 = Math.max(xs0, p.xa + p.used); else xs1 = Math.min(xs1, p.xb - p.used);
    }
    const g = arrange(N, xs1 - xs0, Hi, sub.cutout);
    if (!g.fit) warn.push(`${N > 1 ? "The subs don't" : "The sub doesn't"} fit on the front${ports.length ? " next to the port" : ""}: make the box ${Wi < Hi ? "wider" : "taller"}.`);
    for (const [u, v] of g.at) subs.push({ at: [xs0 + u, y0 + v, 0], dir: [0, 0, -1], size: sz, cutout: sub.cutout, depth: sub.depth, pe: sub.pe, xmax: sub.xmax, panel: tf });
    if (sub.depth > Dmin - 0.01) warn.push(`The sub is deeper (${fmtLenSI(sub.depth)}) than the inside of the box: it won't fit.`);
  } else {
    const xd = ch[0][1];                                                       // the divider: xd .. xd + t
    const g = arrange(N, Dmin, Hi, sub.cutout);
    if (!g.fit) warn.push(`${N > 1 ? "The subs don't" : "The sub doesn't"} fit on the divider: make the box deeper or taller.`);
    for (const [u, v] of g.at) subs.push({ at: [xd + t, y0 + v, tf + u], dir: [1, 0, 0], size: sz, cutout: sub.cutout, depth: sub.depth, pe: sub.pe, xmax: sub.xmax, panel: t });
    const inner = ports.find((p) => p.inner && p.kind === "slot" && p.bend), room = ch[0][1] - ch[0][0] - (inner ? inner.sw + t : 0);
    if (sub.depth > room - 0.01) warn.push(`The sub is deeper (${fmtLenSI(sub.depth)}) than the rear chamber has room for${inner ? " beside its port" : ""}: make that chamber wider.`);
  }

  // the shell: front (with slot openings), back, top, bottom, sides; the divider (bandpass)
  openings.sort((a, b) => a[0] - b[0]);
  const front = (z0, z1) => {
    let x = 0;
    for (const [a, b] of openings) {
      if (a > x) hex("wall", boxC(x, 0, z0, a, H, z1), { name: "front" });
      hex("wall", boxC(a, 0, z0, b, y0, z1), { name: "front" }); hex("wall", boxC(a, y1, z0, b, H, z1), { name: "front" });
      x = b;
    }
    if (x < W) hex("wall", boxC(x, 0, z0, W, H, z1), { name: "front" });
  };
  front(0, t); if (B.dbl) front(t, 2 * t);
  hex("wall", [[0, 0, zi(0)], [W, 0, zi(0)], [W, H, zi(H)], [0, H, zi(H)], [0, 0, zo(0)], [W, 0, zo(0)], [W, H, zo(H)], [0, H, zo(H)]], { name: "back" });
  hex("wall", toBack(0, 0, W, y0, tf), { name: "bottom" });
  hex("wall", toBack(0, y1, W, H, tf), { name: "top" });
  hex("wall", toBack(0, y0, t, y1, tf), { name: "left" });
  hex("wall", toBack(W - t, y0, W, y1, tf), { name: "right" });
  if (bp) {
    const xd = ch[0][1];
    if (!dividerGaps.length) hex("inner", toBack(xd, y0, xd + t, y1, tf), { name: "divider" });
    else {
      const [g0, g1] = dividerGaps[0];
      hex("inner", boxC(xd, y0, tf, xd + t, y1, g0), { name: "divider" });
      if (Dt < D) hex("inner", [[xd, y0, g1], [xd + t, y0, g1], [xd + t, y1, g1], [xd, y1, g1], [xd, y0, zi(y0)], [xd + t, y0, zi(y0)], [xd + t, y1, zi(y1)], [xd, y1, zi(y1)]], { name: "divider" });
    }
  }
  // the chambers' air (shown faintly in the see-through view)
  ch.forEach(([a, b], k) => parts.push({ kind: "hex", group: "chamber", k, vented: topo.vented[k], c: toBack(a, y0, b, y1, tf) }));

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
  if (bp) cut.push(Dt < D ? { name: "Divider", n: 1, a: Hi, b: zi(y0) - tf, b2: Dmin, note: "a wedge, like the sides" } : { name: "Divider", n: 1, a: Hi, b: Dmin });
  for (const p of ports) for (const q of p.panels || []) cut.push({ name: q.name, n: 1, a: q.a, b: q.b });
  // wood area (to buy enough)
  const area = cut.reduce((s, c) => s + c.n * c.a * (c.b2 ? (c.b + c.b2) / 2 : c.b), 0);

  return {
    W, H, D, Dt, t, tf, Wi, Hi, Davg, Dmin, theta, zb, zo, zi, chambers: ch, gross, lost, net: Vnet, ports, subs, parts, cut, area, warn,
    outside: W * H * (D + Dt) / 2,
  };
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
/** "port", "front port", "rear port". */
export function portName(B, p) {
  if (B.type === "bp6") return p.key === "port2" ? (B.series ? "inner port" : "rear port") : "front port";
  return "port";
}
// (warnings are worded in inches; the screen converts the numbers it shows itself)
function fmtLenSI(m) { return `${(m / IN).toFixed(1)}″`; }

/** Solves one measurement (w, h or d) so the box's net volume is `target` (bandpass: the divider moves too, so each
 * chamber gets its own target). Returns the new B, or null if it can't. */
export function fitBox(B, solveFor, target, target2) {
  const bp = B.type === "bp4" || B.type === "bp6";
  const bisect = (lo, hi, f) => { if (f(hi) < 0 || f(lo) > 0) return f(lo) > 0 ? lo : null; for (let i = 0; i < 34; i++) { const m = (lo + hi) / 2; if (f(m) < 0) lo = m; else hi = m; } return hi; };
  if (bp && solveFor === "w") {
    // the width: the two chambers sit side by side, so each one's width on its own (twice, for the bracing's share)
    let W = Math.max(B.w, 0.3), wr = 0.2;
    for (let pass = 0; pass < 3; pass++) {
      const r = bisect(0.01, 3, (x) => layout({ ...B, w: Math.max(W, 3 * B.t + x + 0.05), wr: x }, true).net[0] - target);
      if (r == null) return null; wr = r;
      const w2 = bisect(3 * B.t + wr + 0.03, 8, (x) => layout({ ...B, w: x, wr }, true).net[1] - target2);
      if (w2 == null) return null; W = w2;
    }
    return { ...B, w: W, split: wr / Math.max(0.02, W - 3 * B.t), wr: undefined };
  }
  const at = (x, split) => layout({ ...B, [solveFor]: x, ...(solveFor === "d" && B.shape === "wedge" ? { dt: x * (B.dt / B.d) } : {}), ...(split != null ? { split } : {}) }, true);
  const splitFor = (x) => {
    // the divider where the two chambers' nets are in the ratio wanted
    let lo = 0.03, hi = 0.97;
    for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2, g = at(x, m); if (g.net[0] / g.net[1] < target / target2) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const total = bp ? target + target2 : target;
  const netOf = (x) => { if (!bp) return at(x).net[0]; const s = splitFor(x); const g = at(x, s); return g.net[0] + g.net[1]; };
  let lo = 2 * B.t + 0.03, hi = 4;
  if (netOf(hi) < total) return null;
  for (let i = 0; i < 34; i++) { const m = (lo + hi) / 2; if (netOf(m) < total) lo = m; else hi = m; }
  const x = hi, out = { ...B, [solveFor]: x };
  if (solveFor === "d" && B.shape === "wedge") out.dt = x * (B.dt / B.d);
  if (bp) out.split = splitFor(x);
  return out;
}

/** The port area that keeps its air under `vmax` m/s (peak) at the power used, from a simulation with the port as it
 * is (a port's air flow hardly depends on its size, so its speed goes as 1/area), kept between 10 and 24 in² per ft³ of
 * the chamber it tunes (much smaller and it chuffs; much bigger and it can't fit). */
export function portAreaFor(sim, i, V, vmax = 26, fmin = 0) {
  let v = 0; for (let k = 0; k < sim.f.length; k++) if (sim.f[k] >= fmin) v = Math.max(v, sim.vel[i][k]);
  const per = V / FT3, S = sim.ports[i].S * (v / vmax);
  return Math.min(24 * per, Math.max(10 * per, S / (IN * IN))) * IN * IN;
}

/** Whether something in a layout doesn't fit (a port too long, a sub too deep or too big for its panel). */
export const misfits = (L) => L.warn.filter((w) => /fit|too long|deeper|too narrow|too small/.test(w)).length;
/** A good shape for the design: the measurement being solved comes from the volume; the other two are searched (from
 * the least the sub needs: tall enough for its cutout, deep enough for its magnet) for the most compact box where it
 * all fits, not taller than it is wide. Whole inches. Returns the new B (or null). */
export function shapeBox(B, solveFor, t1, t2) {
  const t = B.t, tf = B.dbl ? 2 * t : t, s = B.sub, bp = B.type === "bp4" || B.type === "bp6", m = 0.5 * IN;
  const up = (x) => Math.ceil(x / IN - 1e-6) * IN;
  const min = bp ? { w: up(s.depth + 4 * t + 5 * IN), h: up(s.cutout + 2 * t + m), d: up(s.cutout + tf + t + m) }
    : { w: up(s.cutout + 2 * t + m), h: up(s.cutout + 2 * t + m), d: up(s.depth + tf + t + IN) };
  const [fa, fb] = ["w", "h", "d"].filter((k) => k !== solveFor);
  const ratio = B.shape === "wedge" ? Math.min(1, B.dt / B.d) : 1;
  const seen = new Map();
  const at = (a, b) => {
    const key = Math.round(a / IN) + "," + Math.round(b / IN);
    if (seen.has(key)) return seen.get(key);
    const C = { ...B, [fa]: a, [fb]: b }; if (B.shape === "wedge") C.dt = C.d * ratio;
    const f = fitBox(C, solveFor, t1, t2);
    let r = null;
    if (f) {
      const L = layout(f), x = { w: L.W, h: L.H, d: L.D };
      const cost = misfits(L) * 1000 + (x.w + x.h + x.d) / IN + 1.5 * Math.max(0, x.h - x.w) / IN + (x[solveFor] < min[solveFor] - 1e-6 ? 400 : 0);
      r = { f, cost };
    }
    seen.set(key, r); return r;
  };
  let best = null;
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) { const r = at(min[fa] + 3 * i * IN, min[fb] + 3 * j * IN); if (r && (!best || r.cost < best.cost)) best = r; }
  if (!best) return null;
  const ca = best.f[fa], cb = best.f[fb];
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const a = ca + i * IN, b = cb + j * IN; if (a < min[fa] - 1e-6 || b < min[fb] - 1e-6) continue;
    const r = at(a, b); if (r && r.cost < best.cost) best = r;
  }
  return best.f;
}

// ---------------------------------------------------------------------------------------------------- wiring
/** The loads N subs can be wired to (single or dual voice coils of `ohms` each), with how. */
export function wiring(n, dual, ohms) {
  const per = dual ? [[ohms * 2, "each sub's two coils in series"], [ohms / 2, "each sub's two coils in parallel"]] : [[ohms, ""]];
  const out = [];
  for (const [z, how] of per) {
    const join = (s) => (how ? `${how}, ${s}` : s);
    if (n === 1) out.push({ ohms: z, how: how ? cap(how.replace("each sub's", "the")) : "Straight to the amp" });
    else {
      out.push({ ohms: z / n, how: cap(join("the subs in parallel")) });
      out.push({ ohms: z * n, how: cap(join("the subs in series")) });
      if (n === 4) out.push({ ohms: z, how: cap(join("two pairs in series, the pairs in parallel")) });
    }
  }
  const seen = new Map();
  for (const o of out) { const k = Math.round(o.ohms * 1000); if (!seen.has(k)) seen.set(k, o); }
  return [...seen.values()].sort((a, b) => a.ohms - b.ohms);
}
