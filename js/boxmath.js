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

// ---------------------------------------------------------------------------------------------------- the quick builds
// Each quick build searched for this sub, at this power: the box sizes and tunings around its kind of bass, each scored
// on what it can really play: its output at the amp's power, capped wherever the cone would go past its Xmax (the most
// it can do there without bottoming), and kept inside Xmax above the subsonic filter it's meant to run with (80% of the
// tuning; 25 Hz sealed). So a build uses all of the sub's excursion, and no more.
//   Ported goals: Windy, the most air out of the port around the tuning (a big port, a bigger box); SPL, the highest
// peak; Loud, the most output from 35 to 70 Hz; Daily, the most output down low while staying flat; Deep, the lowest
// extension that's still flat. Sealed: the Qtc (from Compact's or SQ's own) that keeps the cone inside Xmax. Bandpass:
// the shape and centre (4th order) or the band (6th order hallway) that plays loudest inside Xmax.
const QFR = freqs(10, 300, 110);
const dbMean = (a) => 10 * Math.log10(a.reduce((s, v) => s + Math.pow(10, v / 10), 0) / Math.max(1, a.length));
function playable(drv, N, power, sys, fmin) {
  const sim = simulate({ drv, count: N, power, ...sys }, QFR);
  const m = sim.spl.map((v, i) => v + Math.min(0, 20 * Math.log10(drv.xmax / Math.max(1e-9, sim.x[i]))));
  let xr = 0, vel = 0;
  for (let i = 0; i < QFR.length; i++) if (QFR[i] >= fmin && QFR[i] <= 150) { xr = Math.max(xr, sim.x[i] / drv.xmax); for (const v of sim.vel) vel = Math.max(vel, v[i]); }
  const pick = (a, b) => m.filter((_, i) => QFR[i] >= a && QFR[i] <= b);
  return { sim, m, xr, vel, mean: (a, b) => dbMean(pick(a, b)), max: (a, b) => Math.max(...pick(a, b)), ripple: (a, b) => { const p = pick(a, b); return Math.max(...p) - Math.min(...p); },
    // (the lowest frequency within 3 dB of its output from 40 to 80 Hz)
    f3: () => { const ref = dbMean(pick(40, 80)); let f = 300; for (let i = QFR.length - 1; i >= 0; i--) { if (m[i] >= ref - 3) f = QFR[i]; else if (QFR[i] < 40) break; } return f; } };
}
// (past Xmax at full power: out, unless nothing stays inside (then the least past it); a port past its air speed costs
// a little for every m/s over)
const overX = (r) => (r.xr > 1 ? 100 + 50 * (r.xr - 1) : 0);
const overV = (r, v) => Math.max(0, r.vel - v) * 0.4;
const PORTED = {
  daily: { fb: [29, 36], per: [12, 18], v: 24, size: 2, score: (r) => r.mean(30, 60) + 0.3 * r.mean(25, 30) - 2 * Math.max(0, r.ripple(30, 90) - 3) },
  deep: { fb: [21, 30], per: [12, 18], v: 24, size: 1.2, score: (r) => r.mean(22, 40) - 1.5 * Math.max(0, r.ripple(25, 80) - 4) },
  loud: { fb: [33, 42], per: [14, 22], v: 26, size: 2, score: (r) => r.mean(35, 70) },
  windy: { fb: [29, 37], per: [20, 30], v: 30, size: 0.7, score: (r) => r.mean(r.fb * 0.9, r.fb * 1.25) + 0.3 * r.mean(30, 60) },
  spl: { fb: [40, 55], per: [16, 26], v: 30, size: 2, score: (r) => r.max(40, 65) + 0.2 * r.mean(40, 65) },
};
/** A ported quick build: { V, fb, rule: { v, lo, hi } } (the box's net volume, its tuning, and its port's sizing). */
export function presetPorted(drv, N, power, goal) {
  const g = PORTED[goal] || PORTED.daily;
  const ref = ventedVolumeFor(drv, N, (g.fb[0] + g.fb[1]) / 2);
  let best = search(g, ref, g.fb[0], g.fb[1]);
  // (nothing in its range keeps this sub inside Xmax at this power: a little higher, where a ported box holds it better)
  if (best && best.r.xr > 1) { const up = search(g, ventedVolumeFor(drv, N, g.fb[1] + 3.75), g.fb[1] + 1.5, g.fb[1] + 6); if (up && up.score > best.score) best = up; }
  if (!best) return { V: ref, fb: (g.fb[0] + g.fb[1]) / 2, rule: { v: g.v, lo: g.per[0], hi: g.per[1] } };
  return { V: best.V, fb: best.fb, rule: { v: g.v, lo: Math.max(g.per[0], best.per * 0.9), hi: g.per[1] }, xr: best.r.xr };
  function search(g, ref, f0, f1) {
  let best = null;
  for (let fb = f0; fb <= f1 + 1e-9; fb += 1.5) for (let i = 0; i <= 11; i++) {
    const V = ref * Math.pow(2.2, (i - 5) / 6);                         // (under half of it to 2.2 times it)
    // the port: the goal's area per ft³, bigger (to its most) if its air would be too fast
    let per = g.per[0], r = null, S = 0;
    for (let k = 0; k < 3; k++) {
      S = per * (V / FT3) * IN * IN;
      const len = lenFor(V, S, S, fb);
      if (len < 0.03) { r = null; break; }
      r = playable(drv, N, power, { type: "ported", V: [V], ports: [{ S, S1: S, len }] }, 0.8 * fb);
      if (r.vel <= g.v || per >= g.per[1]) break;
      per = Math.min(g.per[1], per * Math.pow(r.vel / g.v, 1.1));
    }
    if (!r) continue;
    r.fb = fb;
    const score = g.score(r) - overX(r) - overV(r, g.v) - g.size * Math.max(0, Math.log2(V / ref));
    if (!best || score > best.score) best = { score, V, fb, per, r };
  }
  return best;
  }
}
/** A sealed quick build: the Qtc (from its own, up to qmax) where the cone stays inside Xmax at this power above 25 Hz. */
export function presetSealed(drv, N, power, qtc, qmax = 1.05) {
  let pick = null;
  for (let q = Math.max(qtc, drv.qts * 1.15); q <= qmax + 1e-9; q += 0.025) {
    const V = sealedVolume(drv, N, q); if (!V) continue;
    const r = playable(drv, N, power, { type: "sealed", V: [V], ports: [] }, 25);
    if (!pick || r.xr < pick.xr) pick = { q, xr: r.xr };
    if (r.xr <= 1) return { qtc: +q.toFixed(3), xr: r.xr };
  }
  return pick ? { qtc: +pick.q.toFixed(3), xr: pick.xr } : { qtc };
}
/** A 4th-order quick build: the shape (S) and the centre where it plays loudest inside Xmax. */
export function presetBp4(drv, N, power) {
  let best = null;
  for (const s4 of [0.5, 0.6, 0.7, 0.8]) for (let c4 = 40; c4 <= 60; c4 += 4) {
    const b = bp4At(drv, N, s4, c4); if (!(b.vr > 0 && b.vf > 0)) continue;
    const S = 16 * (b.vf / FT3) * IN * IN, len = lenFor(b.vf, S, S, b.fb); if (len < 0.03) continue;
    const r = playable(drv, N, power, { type: "bp4", V: [b.vr, b.vf], ports: [{ S, S1: S, len }] }, 20);
    const score = r.mean(38, 75) + 0.2 * r.max(38, 75) - 0.12 * Math.abs(c4 - 50) - overX(r) - overV(r, 26) - 1.2 * Math.max(0, Math.log2((b.vr + b.vf) / (N * drv.vas)));
    if (!best || score > best.score) best = { score, s4, c4 };
  }
  return best ? { s4: best.s4, c4: best.c4 } : { s4: 0.6, c4: 50 };
}
/** A 6th-order (parallel, or hallway) quick build: the band it plays loudest and flattest inside Xmax. */
export function presetBp6(drv, N, power) {
  let best = null;
  for (const lo of [28, 33]) for (const hi of [70, 85]) {
    const b = bp6Design(drv, N, false, lo, hi);
    const Sf = 16 * (b.vf / FT3) * IN * IN, Sr = 14 * (b.vr / FT3) * IN * IN;
    const lf = lenFor(b.vf, Sf, Sf, b.ff), lr = lenFor(b.vr, Sr, Sr, b.fr); if (lf < 0.03 || lr < 0.03) continue;
    const r = playable(drv, N, power, { type: "bp6", series: false, V: [b.vr, b.vf], ports: [{ S: Sf, S1: Sf, len: lf }, { S: Sr, S1: Sr, len: lr }] }, 0.8 * b.fr);
    const score = r.mean(lo, hi) - 1.2 * Math.max(0, r.ripple(lo, hi) - 4) - overX(r) - overV(r, 26) - 0.6 * Math.max(0, Math.log2((b.vr + b.vf) / (N * drv.vas)));
    if (!best || score > best.score) best = { score, lo, hi };
  }
  return best ? { lo: best.lo, hi: best.hi } : { lo: 30, hi: 75 };
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
 * round each sub's frame (d: its outside diameter; gap: the space wanted between frames, half that to the edges).
 * Each: [u, v] from the area's corner; fit: room enough. */
function arrange(n, w, h, d, gap = 0.0254) {
  const m = Math.max(0.003, gap);
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols), cw = w / cols, ch = h / rows, fit = cw >= d + m - 1e-9 && ch >= d + m - 1e-9;
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
 * facing each other across a middle chamber), shape ("rect"|"wedge"), w, h, d, dt (top depth, wedge), t, layers (the
 * baffle's layers of wood: the front, or a bandpass box's divider(s); older designs: dbl, a double front), brace (m³),
 * count, sub: { size, cutout, depth, disp, pe, xmax, shape ("sq": a square frame and cone, its cutout a square) }, port, port2: { kind ("slot"|"round"), w
 * (slot width), dia, n, auto, len (manual), fb (tuning wanted), at (ported: where it opens, "front" | "back" | "top" |
 * "side"), pos ("left" | "middle" | "right": where on that panel; on the side, which side) }, split (the rear chamber(s)' share of the room
 * across; or wr, a rear room's own width) }.
 * Gives the inside, each chamber's gross and net volume (and what it lost), each port's area, length and tuning, where
 * everything sits (for the 3D view), the cut list and what's wrong with it.
 */
export function layout(B, quick = false, lite = false) {
  const t = Math.max(0.003, B.t), bp = B.type === "bp4" || B.type === "bp6", hall = bp && B.style === "hall";
  // the baffle (the panel the subs mount on) in layers of wood: the front of a sealed or ported box, the divider(s)
  // of a bandpass one (its front is then a single layer)
  const layers = baffleLayers(B), tf = bp ? t : layers * t, td = bp ? layers * t : t;
  const W = Math.max(3 * t + (hall ? 2 : 1) * td + (hall ? t : 0) + 0.03, B.w), H = Math.max(2 * t + 0.02, B.h), D = Math.max(tf + t + 0.02, B.d);
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
    const free = Math.max(0.02, Wi - td), xr = t + Math.min(free - 0.01, Math.max(0.01, B.wr != null ? B.wr : free * (B.split == null ? 0.55 : B.split)));
    rooms = [{ x: [t, xr], k: 0, wall: "left" }, { x: [xr + td, W - t], k: 1, wall: "right" }];
    dividers = [{ x: xr, face: 1, n: N }];                                      // (subs on its +x face, firing +x)
  } else {
    const free = Math.max(0.03, Wi - 2 * td), wr = Math.min(free / 2 - 0.01, Math.max(0.01, B.wr != null ? B.wr : (free * (B.split == null ? 0.6 : B.split)) / 2));
    rooms = [{ x: [t, t + wr], k: 0, wall: "left" }, { x: [t + td + wr, W - t - td - wr], k: 1, wall: "center" }, { x: [W - t - wr, W - t], k: 0, wall: "right" }];
    const nl = Math.ceil(N / 2);
    dividers = [{ x: t + wr, face: 1, n: nl }, { x: W - t - td - wr, face: -1, n: N - nl }];
  }
  const nch = topo.n, gross = new Array(nch).fill(0);
  for (const r of rooms) gross[r.k] += (r.x[1] - r.x[0]) * Hi * Davg;
  const lost = gross.map(() => ({ sub: 0, port: 0, brace: 0 }));
  lost[0].sub = N * sub.disp;                                                  // the subs' bodies: behind the cones, chamber 0
  const gsum = gross.reduce((a, b) => a + b, 0);
  gross.forEach((g, k) => (lost[k].brace = (B.brace || 0) * (g / gsum)));
  // the bracing: a panel can go about 16 times the wood's thickness unsupported (less with more power); wherever both its
  // spans between supports (walls, dividers) are longer than that, dowels brace it, on a grid of equal parts: top to
  // bottom, front to back, side to side (to a divider, in a bandpass box)
  const brMode = B.braceMode || "off", PW = Math.max(0, B.power || 0) / Math.max(1, B.count | 0);   // (the power each sub puts on the box)
  const Lmax = 16 * t * (PW <= 1000 ? 1 : PW <= 3000 ? 0.9 : PW <= 6000 ? 0.8 : 0.7) * (brMode === "heavy" ? 0.75 : 1);
  const brR = (brMode === "heavy" ? 0.875 : 0.625) * IN;
  const gridOf = (a0, a1, b0, b1) => { const A = a1 - a0, Bb = b1 - b0, o = []; if (Math.min(A, Bb) <= Lmax) return o; const na = Math.ceil(A / Lmax), nb = Math.ceil(Bb / Lmax); for (let i = 1; i < na; i++) for (let j = 1; j < nb; j++) o.push([a0 + (A * i) / na, b0 + (Bb * j) / nb]); return o; };
  const braces = [];
  let span = 0;                                                               // (the longest unsupported span: the panel's shorter side)
  rooms.forEach((rm, ri) => { const wdt = rm.x[1] - rm.x[0]; span = Math.max(span, Math.min(wdt, Dmin), Math.min(wdt, Hi), Math.min(Dmin, Hi)); });
  if (brMode !== "off") {
    rooms.forEach((rm, ri) => {
      for (const [x, z] of gridOf(rm.x[0], rm.x[1], tf, zb)) braces.push({ ax: 1, room: ri, c: [x, 0, z], a: y0, b: y1 });
      for (const [x, y] of gridOf(rm.x[0], rm.x[1], y0, y1)) braces.push({ ax: 2, room: ri, c: [x, y, 0], a: tf, b: zb });
    });
    for (const ri of [...new Set([0, rooms.length - 1])]) for (const [z, y] of gridOf(tf, zb, y0, y1)) braces.push({ ax: 0, room: ri, c: [0, y, z], a: rooms[ri].x[0], b: rooms[ri].x[1] });
    for (const b of braces) lost[rooms[b.room].k].brace += Math.PI * brR * brR * (b.b - b.a);
  }

  // the ports (as the sound sees them: one per chamber, its area the sum of its copies) and their copies in the rooms.
  // A ported box's port can open out of the front (along the left or right side, or up the middle), or (a rectangular
  // box) out of the back, the top, or a side: each of those is laid out as if it were a front port, in a frame of its
  // own (u across the panel it opens in, v along it, d into the box), then turned to where it is.
  const portAt = (P) => {
    let at = !bp && ["back", "top", "side"].includes(P.at) ? P.at : "front";
    const pos = ["left", "middle", "right"].includes(P.pos) ? P.pos : "left";
    if (at !== "front" && B.shape === "wedge") { warn.push("On a wedge the port opens out of the front (its back slopes): pick a rectangular box for a back, top or side port."); at = "front"; }
    if (at === "front" && (bp || pos !== "middle")) return { at, pos, wall: bp ? null : pos };
    if (at === "front") {
      const F = { face: "front", u: [t, W - t], v: [y0, y1], d: [tf, zb], M: (u, v, d) => [u, v, d], wall: "center", dir: [0, 0, 1] };
      return { at, pos, wall: "center", F };
    }
    const yi = [y0, y1], zIn = [tf, D - t];
    const F = at === "back" ? { face: "back", u: [t, W - t], v: yi, d: [t, D - tf], M: (u, v, d) => [u, v, D - d] }
      : at === "top" ? { face: "top", u: [t, W - t], v: zIn, d: [t, H - t], M: (u, v, d) => [u, H - d, v] }
      : pos === "right" ? { face: "right", u: zIn, v: yi, d: [t, W - t], M: (u, v, d) => [W - d, v, u] }
      : { face: "left", u: zIn, v: yi, d: [t, W - t], M: (u, v, d) => [d, v, u] };
    // (out of a side: along the back, so the subs on the front keep the whole width)
    F.wall = at === "side" ? "right" : pos === "middle" ? "center" : pos;
    F.dir = [0, 1, 2].map((k) => F.M(0, 0, 1)[k] - F.M(0, 0, 0)[k]);
    return { at, pos, wall: F.wall, F };
  };
  const ports = topo.ports.map((tp) => {
    const P = (tp.key === "port2" ? B.port2 : B.port) || {};
    const inner = tp.b >= 0;                                                   // (series: rear chamber into the front one)
    const where = portAt(P), F = where.F || null;
    const inst = rooms.filter((r) => r.k === tp.a).map((r) => ({ room: r, wall: bp ? r.wall : where.wall }));
    const jOk = !bp && !F;                                                     // (a J's third leg would run along a divider: no)
    let kind = P.kind === "round" ? "round" : "slot", n = 1, sw = 0, dia = 0, S1;
    const top = kind === "slot" && !inner && !F && inst[0].wall === "top", center = kind === "slot" && !inner && inst[0].wall === "center";
    const span = kind === "slot" ? (F ? F.v[1] - F.v[0] : top ? inst[0].room.x[1] - inst[0].room.x[0] : Hi) : 0;
    if (kind === "slot") { sw = Math.max(0.005, P.w || 0.05); S1 = sw * span; }
    else { n = Math.max(1, Math.min(8, P.n | 0 || 1)); dia = Math.max(0.02, P.dia || 0.1); S1 = Math.PI * (dia / 2) ** 2; }
    const copies = inst.length, S = S1 * (kind === "round" ? n : 1) * copies;
    const through = F ? F.d[0] : inner ? td : tf;                              // the wood it starts in (front, or the divider)
    const [xa, xb] = inst[0].room.x;
    // (the room it has: straight in, and across)
    const dl = F ? F.d[1] - F.d[0] : Dmin, ul = F ? F.u[1] - F.u[0] : xb - xa, vs = F ? F.v[1] - F.v[0] : Hi;
    return { key: tp.key, k: tp.a, inst, copies, xa, xb, inner, top, center, kind, n, sw, dia, span, S, S1, through, jOk, auto: P.auto !== false, manual: Math.max(0, P.len || 0), fbWant: P.fb || 35, face: F ? F.face : inner ? "divider" : "front", at: where.at, pos: where.pos, F, dl, ul, vs };
  });
  // how many times a slot port bends at a length inside: straight, an L, or (along a side) a J
  const bendsOf = (p, lin) => {
    if (p.kind !== "slot" || (p.center && !p.F)) return 0;
    if (p.inner) return lin > p.xb - p.xa - p.sw ? 1 : 0;
    // (out of the back, the top, or up the middle: straight, or folded back on itself, a U; out of a side: an L)
    if (p.F) return lin <= p.dl - p.sw ? 0 : p.F.face === "left" || p.F.face === "right" ? 1 : 2;
    if (p.top) return lin > Dmin - p.sw ? 1 : 0;
    return lin <= p.dl - p.sw ? 0 : p.jOk && lin > p.dl + p.ul - 2 * p.sw ? 2 : 1;
  };
  // (rounded bends: a 45° strip in each bend's outer corner, so the air never turns a square 90°; it takes the
  // diagonal, about 0.29 of the slot's width shorter a bend than the centre line)
  const round = B.round !== false;
  const acou = (p, len) => len - (round ? 0.29 * p.sw * bendsOf(p, Math.max(0, len - p.through)) : 0);
  // a port's displacement at a length: its air, and the wood walling it in (bent: two walls, one corner)
  const portLost = (p, len) => {
    const lin = Math.max(0, len - p.through);
    if (p.kind === "round") return p.copies * p.n * Math.PI * (p.dia / 2 + TUBE_WALL) ** 2 * lin;
    const bends = bendsOf(p, lin);
    const panel = (p.center ? 2 : 1) * t * p.span * Math.max(0, lin - bends * (p.sw + t));      // (up the middle: a wall each side)
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
      const g = (len) => { const V = G - portLost(p, len); return V <= 0.05 * G ? Infinity : lenFor(V, p.S, p.S1, p.fbWant) - acou(p, len); };
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
    p.fb = tuneOf(Vnet[p.k], p.S, p.S1, acou(p, p.len));
    p.lin = p.len - p.through;
    p.bends = bendsOf(p, p.lin);
    p.pipe = C / (2 * effLen(acou(p, p.len), p.S1));                           // the port's own first resonance
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
  // a bend's 45° strip: a triangle (three corners at one end) and how far it runs
  const fillet = (a, b, c, ext, p) => { if (round) { parts.push({ kind: "prism", group: "inner", name: "fillet", p: [a, b, c], ext }); p.fillets = (p.fillets || 0) + 1; } };

  // openings cut in the back, top or sides (by a port opening there): { face, lo, hi } (corners, in place)
  const faceHoles = [];
  /** A port opening out of the back, the top or a side: laid out in its frame, then put where it goes. */
  const framed = (p, room) => {
    const F = p.F, w = p.sw, lin = p.lin, [u0, u1] = F.u, [v0, v1] = F.v, [d0, d1] = F.d, Dl = d1 - d0, Vs = v1 - v0;
    const at = (u, v, d) => F.M(u, v, d);
    // (up the middle: between the subs, half of them each side; with an odd number, the extra one on the left)
    const UC = (strip) => u0 + ((u1 - u0 - strip) * Math.ceil(N / 2)) / N + strip / 2;
    const corners = (ua, va, da, ub, vb, db) => { const a = at(ua, va, da), b = at(ub, vb, db); return boxC(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])); };
    const lbox = (group, nm, ...c) => hex(group, corners(...c), { name: nm });
    const hole = (ua, ub) => {
      const a = at(ua, v0, 0), b = at(ub, v1, d0), lo = [0, 1, 2].map((k) => Math.min(a[k], b[k])), hi = [0, 1, 2].map((k) => Math.max(a[k], b[k]));
      if (F.face === "front") openings.push({ x: [lo[0], hi[0]], y: [lo[1], hi[1]] }); else faceHoles.push({ face: F.face, lo, hi });
    };
    // (the subs on the front keep clear of it: a port along the left or right comes back that far; up the middle, they
    // go either side)
    const keepOff = (side, wd, x) => { if (F.face === "back" || F.face === "top" || F.face === "front") used.set(room, { side, w: wd, at: x }); };
    if (p.kind === "round") {
      const r = p.dia / 2, m = 0.015, rows = Math.max(1, Math.floor((Vs - m) / (p.dia + m))), cols = Math.ceil(p.n / rows);
      for (let i = 0; i < p.n; i++) {
        const c = Math.floor(i / rows), rr = i % rows, inCol = Math.min(rows, p.n - c * rows);
        const v = (v0 + v1) / 2 + (rr - (inCol - 1) / 2) * (p.dia + m);
        const u = F.wall === "right" ? u1 - r - m - c * (p.dia + m) : F.wall === "center" ? UC(cols * (p.dia + m) + m) + (c - (cols - 1) / 2) * (p.dia + m) : u0 + r + m + c * (p.dia + m);
        p.tubes.push({ at: at(u, v, 0), dir: F.dir, len: p.len, r, through: d0 });
      }
      const wd = cols * (p.dia + m) + m;
      if (F.wall === "center") keepOff("center", wd, UC(wd)); else keepOff(F.wall, wd);
      p.bend = 0;
      return;
    }
    const mid = F.wall === "center", fold = F.face !== "left" && F.face !== "right";
    if (mid && lin <= Dl - w) {
      // up the middle of the panel: straight in, a wall each side
      const uc = UC(2 * w + 3 * t), ua = uc - w / 2, ub = uc + w / 2, len = lin;
      hole(ua, ub);
      lbox("inner", "port", ua - t, v0, d0, ua, v1, d0 + len);
      lbox("inner", "port", ub, v0, d0, ub + t, v1, d0 + len);
      lbox("air", "air", ua, v0, 0, ub, v1, d0 + len);
      p.panels.push({ name: `${cap(portName(B, p))} wall`, a: Vs, b: len }, { name: `${cap(portName(B, p))} wall`, a: Vs, b: len });
      p.bend = 0;
      keepOff("center", w + 2 * t, uc);
      return;
    }
    // along a wall of the box (or, folded, beside the middle): straight in; longer, folded back on itself; out of a side,
    // across the far side
    const low = mid || F.wall !== "right", s = low ? 1 : -1;
    const uw0 = mid ? UC(2 * w + 3 * t) - w - t / 2 : low ? u0 : u1, uw = uw0 + s * w;
    hole(Math.min(uw0, uw), Math.max(uw0, uw));
    p.bend = lin > Dl - w ? (fold ? 2 : 1) : 0;
    if (p.bend === 2) {
      // a U: in along the wall, across at the far end, and back out beside itself (all in a strip the subs keep off)
      const uA2 = uw + s * t, uC2 = uA2 + s * w, uB2 = uC2 + s * t;
      const e0 = d1 + Dl + t - lin, lim = d0 + w, over = lim - e0, dE = Math.max(e0, lim);
      if (over > 0) warn.push(`The ${portName(B, p)} is ${fmtLenSI(over)} too long to fit, even folded back on itself: make the box ${F.face === "top" ? "taller" : "deeper"}, or the port narrower.`);
      if (mid) lbox("inner", "port", uw0 - s * t, v0, d0, uw0, v1, d1);
      lbox("inner", "port", uw, v0, d0, uA2, v1, d1 - w);
      lbox("inner", "port", uC2, v0, dE, uB2, v1, d1);
      lbox("air", "air", uw0, v0, 0, uw, v1, d1);
      lbox("air", "air", uw, v0, d1 - w, uC2, v1, d1);
      lbox("air", "air", uA2, v0, dE, uC2, v1, d1 - w);
      const e0v = at(0, v0, 0), e1v = at(0, v1, 0), ext = [0, 1, 2].map((k) => e1v[k] - e0v[k]);
      fillet(at(uw0, v0, d1 - w), at(uw0, v0, d1), at(uw, v0, d1), ext, p);
      fillet(at(uC2, v0, d1 - w), at(uC2, v0, d1), at(uA2, v0, d1), ext, p);
      const nm = cap(portName(B, p));
      p.panels.push({ name: `${nm} wall (between)`, a: Vs, b: d1 - w - d0 }, { name: `${nm} wall (outer)`, a: Vs, b: d1 - dE });
      if (mid) p.panels.push({ name: `${nm} wall (side)`, a: Vs, b: Dl });
      if (mid) keepOff("center", 2 * w + 3 * t, UC(2 * w + 3 * t)); else keepOff(F.wall, 2 * w + 2 * t);
      return;
    }
    if (!p.bend) {
      lbox("inner", "port", uw, v0, d0, uw + s * t, v1, d0 + lin);
      lbox("air", "air", uw0, v0, 0, uw, v1, d0 + lin);
      p.panels.push({ name: `${cap(portName(B, p))} wall`, a: Vs, b: lin });
    } else {
      const ue = uw0 + s * (lin - Dl + w), lim = low ? u1 - w : u0 + w, over = low ? ue - lim : lim - ue, uE = over > 0 ? lim : ue;
      if (over > 0) warn.push(`The ${portName(B, p)} is ${fmtLenSI(over)} too long to fit, even bent across the far side: make the box bigger, or the port narrower.`);
      lbox("inner", "port", uw, v0, d0, uw + s * t, v1, d1 - w);
      lbox("inner", "port", uw + s * t, v0, d1 - w - t, uE, v1, d1 - w);
      lbox("air", "air", uw0, v0, 0, uw, v1, d1);
      lbox("air", "air", uw, v0, d1 - w, uE, v1, d1);
      const e0 = at(0, v0, 0), e1 = at(0, v1, 0);
      fillet(at(uw0, v0, d1 - w), at(uw0, v0, d1), at(uw0 + s * w, v0, d1), [0, 1, 2].map((k) => e1[k] - e0[k]), p);
      p.panels.push({ name: `${cap(portName(B, p))} wall (in)`, a: Vs, b: d1 - w - d0 }, { name: `${cap(portName(B, p))} wall (across)`, a: Vs, b: Math.abs(uE - (uw + s * t)) });
    }
    keepOff(F.wall, w + t);
    // (out of a side and bent: its second leg runs along the far side, toward the front)
    if (F.face === "left" || F.face === "right") { if (p.bend) used.set(room, { side: F.face === "left" ? "right" : "left", w: w + t }); }
  };
  for (const p of ports) {
    p.panels = []; p.tubes = [];
    for (const { room, wall } of p.inst) {
      if (p.F) { framed(p, room); continue; }
      const [xa, xb] = room.x;
      if (p.kind === "round") {
        // tubes: in a column by the room's wall (in the middle of a hallway), or low at the back of the divider (series)
        const r = p.dia / 2, m = 0.015, rows = Math.max(1, Math.floor((Hi - m) / (p.dia + m))), cols = Math.ceil(p.n / rows);
        for (let i = 0; i < p.n; i++) {
          const c = Math.floor(i / rows), rr = i % rows, inCol = Math.min(rows, p.n - c * rows);
          const y = y0 + Hi / 2 + (rr - (inCol - 1) / 2) * (p.dia + m);
          if (p.inner) p.tubes.push({ at: [xb + td, y, zb - r - m - c * (p.dia + m)], dir: [-1, 0, 0], len: p.len, r, through: td });
          else {
            const x = wall === "right" ? xb - r - m - c * (p.dia + m) : wall === "top" || wall === "center" ? (xa + xb) / 2 + (c - (cols - 1) / 2) * (p.dia + m) : xa + r + m + c * (p.dia + m);
            p.tubes.push({ at: [x, y, 0], dir: [0, 0, 1], len: p.len, r, through: tf });
          }
        }
        used.set(room, { side: wall, w: cols * (p.dia + m) + m, at: (xa + xb) / 2 });
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
          hex("air", boxC(xs - lin, y0, zb - w, xs + td, y1, zb), { name: "air" });
          p.panels.push({ name: name(p), a: Hi, b: lin });
        } else {
          const ze = zb + (xs - xa) - w - lin, lim = tf + w, over = lim - ze, zE = Math.max(ze, lim);
          if (over > 0) warn.push(`The ${portName(B, p)} is ${fmtLenSI(over)} too long for the rear chamber, even bent along its side: make that chamber deeper or wider, or the slot narrower.`);
          hex("inner", boxC(xa + w, y0, zb - w - t, xs, y1, zb - w), { name: "port" });
          hex("inner", boxC(xa + w, y0, zE, xa + w + t, y1, zb - w - t), { name: "port" });
          hex("air", boxC(xa, y0, zb - w, xs + td, y1, zb), { name: "air" });
          hex("air", boxC(xa, y0, zE, xa + w, y1, zb - w), { name: "air" });
          fillet([xa, y0, zb - w], [xa, y0, zb], [xa + w, y0, zb], [0, Hi, 0], p);
          p.panels.push({ name: name(p, " (back)"), a: Hi, b: xs - xa - w }, { name: name(p, " (side)"), a: Hi, b: Math.max(0, zb - w - t - zE) });
          used.set(room, { side: "left", w: w + t });
        }
        continue;
      }
      if (wall === "center") {
        // a hallway's port: a full-height slot up the middle, straight back between the subs facing each other
        const xc = (xa + xb) / 2, x0 = xc - w / 2, x1 = xc + w / 2;
        openings.push({ x: [x0, x1], y: [y0, y1] });
        const len = Math.min(lin, Dmin - 0.02);
        if (lin > Dmin - 0.02) warn.push(`The ${portName(B, p)} is ${fmtLenSI(lin - Dmin + 0.02)} too long to fit in the middle chamber: make the box deeper, or the slot narrower.`);
        hex("inner", boxC(x0 - t, y0, tf, x0, y1, tf + len), { name: "port" });
        hex("inner", boxC(x1, y0, tf, x1 + t, y1, tf + len), { name: "port" });
        hex("air", boxC(x0, y0, 0, x1, y1, tf + len), { name: "air" });
        p.panels.push({ name: name(p), a: Hi, b: len }, { name: name(p), a: Hi, b: len });
        p.bend = 0;
        used.set(room, { side: "center", w: w + 2 * t, at: xc });
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
          fillet([xa, y1 - w, zb], [xa, y1, zb], [xa, y1, zb - w], [xb - xa, 0, 0], p);
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
      } else if (lin <= Dmin + (xb - xa) - 2 * w || !p.jOk) {
        // an L: down the side, then across the back
        const xe = xw0 + s * (lin - (zb - tf) + w), lim = left ? xb - w : xa + w, over = left ? xe - lim : lim - xe, xE = over > 0 ? lim : xe;
        if (over > 0) warn.push(`The ${portName(B, p)} is ${fmtLenSI(over)} too long to fit, even bent along the back: make the box wider or deeper, or the port narrower.`);
        hex("inner", boxC(Math.min(xw, xw + s * t), y0, tf, Math.max(xw, xw + s * t), y1, zb - w), { name: "port" });
        hex("inner", boxC(Math.min(xw + s * t, xE), y0, zb - w - t, Math.max(xw + s * t, xE), y1, zb - w), { name: "port" });
        hex("air", boxC(Math.min(xw0, xw), y0, 0, Math.max(xw0, xw), y1, zb), { name: "air" });
        hex("air", boxC(Math.min(xw, xE), y0, zb - w, Math.max(xw, xE), y1, zb), { name: "air" });
        fillet([xw0, y0, zb - w], [xw0, y0, zb], [xw0 + s * w, y0, zb], [0, Hi, 0], p);
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
        fillet([xw0, y0, zb - w], [xw0, y0, zb], [xw0 + s * w, y0, zb], [0, Hi, 0], p);
        fillet([xf, y0, zb - w], [xf, y0, zb], [xf - s * w, y0, zb], [0, Hi, 0], p);
        p.panels.push({ name: name(p, " (side)"), a: Hi, b: zb - w - tf }, { name: name(p, " (back)"), a: Hi, b: Math.abs(xfw - (xw + s * t)) }, { name: name(p, " (other side)"), a: Hi, b: Math.max(0, zb - w - t - zE) });
        if (B.shape === "wedge") warn.push(`The ${portName(B, p)} bends along a sloped back: its length is close, not exact.`);
        p.bend = 2;
        used.set(room, { side: "both", w: w + t });
        continue;
      }
      used.set(room, { side: wall === "right" ? "right" : "left", w: w + t });
    }
    if (p.kind === "round") {
      const room = Math.max(0, (p.inner ? p.xb - p.xa : p.dl) - p.dia);
      if (p.lin > room) warn.push(`The ${portName(B, p)} is ${fmtLenSI(p.lin - room)} too long to fit straight: it needs a bend, a slot port, or a bigger box.`);
      const u = used.get(p.inst[0].room);
      if (p.dia > p.vs || (u && u.w > p.ul)) warn.push(`The ${portName(B, p)} ${p.n > 1 ? "tubes don't" : "tube doesn't"} fit well on the panel: fewer or smaller tubes, or a bigger box.`);
    }
  }

  // the subs: on the front (sealed, ported) beside the ports, or on the divider(s) (bandpass), firing into chamber 1
  const subs = [];
  const sz = Math.max(0.05, sub.size || sub.cutout * 1.08), gap = Math.max(0, B.gap == null ? IN : B.gap);
  const S = (at, dir, panel) => ({ at, dir, size: sz, cutout: sub.cutout, depth: sub.depth, pe: sub.pe, xmax: sub.xmax, panel, sq: sub.shape === "sq" });
  if (!bp) {
    // (on the front a frame may reach over the box's own walls, as long as its cutout stays inside: its lip)
    const lip = Math.max(0, Math.min(t, (sz - sub.cutout) / 2 - 0.002));
    let xs0 = t - lip, xs1 = W - t + lip;
    const u = used.get(rooms[0]);
    if (u && u.side === "center") {
      // (a port up the middle: half the subs each side of it)
      const x0 = u.at - u.w / 2, x1 = u.at + u.w / 2, nl = Math.ceil(N / 2);
      const gl = arrange(nl, x0 - xs0, Hi + 2 * lip, sz, gap), gr = N - nl ? arrange(N - nl, xs1 - x1, Hi + 2 * lip, sz, gap) : { fit: true, at: [] };
      if (!gl.fit || !gr.fit) warn.push(`${N > 1 ? "The subs don't" : "The sub doesn't"} fit on the front either side of the port: make the box ${N > 1 ? "wider or taller" : "wider"}.`);
      for (const [uu, v] of gl.at) subs.push(S([xs0 + uu, y0 - lip + v, 0], [0, 0, -1], tf));
      for (const [uu, v] of gr.at) subs.push(S([x1 + uu, y0 - lip + v, 0], [0, 0, -1], tf));
    } else {
    if (u) { if (u.side === "right") xs1 = W - t - u.w; else if (u.side === "both") { xs0 = t + u.w; xs1 = W - t - u.w; } else xs0 = t + u.w; }
    const g = arrange(N, xs1 - xs0, Hi + 2 * lip, sz, gap);
    if (!g.fit) warn.push(`${N > 1 ? "The subs don't" : "The sub doesn't"} fit on the front${ports.length ? " next to the port" : ""}: make the box ${N > 1 ? "wider or taller" : Wi < Hi ? "wider" : "taller"}.`);
    for (const [uu, v] of g.at) subs.push(S([xs0 + uu, y0 - lip + v, 0], [0, 0, -1], tf));
    }
    if (sub.depth > Dmin - 0.01) warn.push(`The sub is deeper (${fmtLenSI(sub.depth)}) than the inside of the box: it won't fit.`);
  } else {
    const topSlot = ports.find((p) => p.top);
    const hTop = topSlot ? topSlot.sw + t : 0;                                 // (a hallway's top port runs over the subs)
    var topRoom = Infinity;                                                    // (the height free over the subs' rows)
    for (const dv of dividers) {
      if (!dv.n) continue;
      // (the divider's room for subs: short of any port running along the back of a room on either side of it)
      let zUse = zb;
      for (const p of ports) for (const { room } of p.inst) {
        const touches = Math.abs(room.x[1] - dv.x) < 1e-6 || Math.abs(room.x[0] - (dv.x + td)) < 1e-6;
        if (!touches) continue;
        if (p.kind === "slot" && !p.top && (p.inner || p.bend)) zUse = Math.min(zUse, zb - p.sw - t - gap / 2);
        if (p.kind === "round" && p.inner) zUse = Math.min(zUse, ...p.tubes.map((tb) => tb.at[2] - tb.r - TUBE_WALL - gap / 2));
      }
      const cols = Math.max(1, Math.floor((zUse - tf) / (sz + gap)));
      topRoom = Math.min(topRoom, Hi - t - Math.ceil(dv.n / cols) * (sz + gap));
      const g = arrange(dv.n, zUse - tf, Hi - hTop, sz, gap);
      if (!g.fit) warn.push(`${N > 1 ? "The subs don't" : "The sub doesn't"} fit on the divider${dividers.length > 1 ? "s" : ""}${zUse < zb - 1e-6 ? " clear of the port" : ""}: make the box deeper or taller.`);
      const xFace = dv.face > 0 ? dv.x + td : dv.x;
      for (const [uu, v] of g.at) subs.push(S([xFace, y0 + v, tf + uu], [dv.face, 0, 0], td));
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

  // what each sub takes up (its frame and cone out front, its basket and magnet behind), and every port's air, walls,
  // bend strips and tubes: a sub may never touch a port
  const aabb = (pts) => [[0, 1, 2].map((k) => Math.min(...pts.map((q) => q[k]))), [0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k])))];
  const hit = (a, b, e = 1e-4) => [0, 1, 2].every((k) => a[1][k] > b[0][k] + e && b[1][k] > a[0][k] + e);
  const cyl = (at, a, from, to, r) => { const lo = [...at], hi = [...at]; for (let k = 0; k < 3; k++) if (k !== a) { lo[k] -= r; hi[k] += r; } lo[a] = Math.min(from, to); hi[a] = Math.max(from, to); return [lo, hi]; };
  const subBodies = (s) => {
    const a = s.dir[0] ? 0 : s.dir[2] ? 2 : 1, sg = s.dir[a], f = s.at[a], sIn = s.size / IN;
    const dm = Math.max(0.36 * s.size, Math.min((0.9 + 0.22 * sIn + 0.115 * Math.sqrt(Math.max(50, sub.pe || 500))) * IN, s.cutout * 0.92));
    const mid = f - sg * (s.panel + 0.45 * Math.max(0, s.depth - s.panel));
    return [cyl(s.at, a, f + sg * 0.03, f - sg * 0.004, s.size / 2), cyl(s.at, a, f, mid, s.cutout * (s.sq ? 0.5 : 0.485)), cyl(s.at, a, mid, f - sg * s.depth, dm / 2)];
  };
  const portBoxes = parts.filter((q) => q.group === "air" || q.name === "port" || q.name === "fillet").map((q) => aabb(q.c || q.p.flatMap((v) => [v, v.map((x, k) => x + q.ext[k])])));
  for (const p of ports) for (const tb of p.tubes || []) {
    const a = tb.dir[0] ? 0 : tb.dir[2] ? 2 : 1, f = tb.at[a];
    portBoxes.push(cyl(tb.at, a, f, f + tb.dir[a] * tb.len, tb.r + TUBE_WALL), cyl(tb.at, a, f - tb.dir[a] * 0.004, f, tb.r + 0.022));
  }
  const subBoxes = subs.flatMap(subBodies);
  if (subBoxes.some((sb) => portBoxes.some((pb) => hit(sb, pb)))) warn.push(`${N > 1 ? "A sub runs" : "The sub runs"} into the port: ${bp ? "make the box deeper or taller, or the port narrower" : "make the box deeper or wider, or the port narrower"}.`);
  // the dowels: each moved off anything in its way (a sub, a port, another dowel), up to 8″; left out if it can't be
  const dowels = [];
  let dropped = 0;
  const offs = [0, 1, -1, 2, -2, 3, -3, 4, -4, 6, -6, 8, -8].map((v) => v * IN);
  for (const b of (lite ? [] : braces)) {
    const rm = rooms[b.room], free = [0, 1, 2].filter((k) => k !== b.ax);
    const lim = { 0: [rm.x[0] + brR, rm.x[1] - brR], 1: [y0 + brR, y1 - brR], 2: [tf + brR, zb - brR] };
    let placed = null;
    search: for (const da of offs) for (const db of offs) {
      const c = [...b.c]; c[free[0]] += da; c[free[1]] += db;
      if (free.some((k) => c[k] < lim[k][0] || c[k] > lim[k][1])) continue;
      const box = cyl(c, b.ax, b.a, b.b, brR + 0.004);
      if (subBoxes.some((q) => hit(box, q)) || portBoxes.some((q) => hit(box, q)) || dowels.some((d) => hit(box, d.box))) continue;
      placed = { c, box }; break search;
    }
    if (!placed) { dropped++; continue; }
    const at = [...placed.c]; at[b.ax] = b.a;
    const dir = [0, 0, 0]; dir[b.ax] = 1;
    dowels.push({ box: placed.box, len: b.b - b.a });
    parts.push({ kind: "dowel", group: "brace", at, dir, len: b.b - b.a, r: brR });
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
  for (let i = 0; i < tf / t - 0.5; i++) front(i * t, (i + 1) * t);         // (the baffle's layers)
  // (a panel with a port's opening in it: in pieces round the opening; only on a rectangular box)
  const holed = (nm, lo, hi, axis) => {
    const hs = faceHoles.filter((o) => o.face === nm);
    if (!hs.length) return false;
    const [ai, bi] = [0, 1, 2].filter((k) => k !== axis);
    const cuts = (k) => [...new Set([lo[k], hi[k], ...hs.flatMap((o) => [o.lo[k], o.hi[k]]).filter((v) => v > lo[k] && v < hi[k])])].sort((a, b) => a - b);
    const as = cuts(ai), bs = cuts(bi), inHole = (a, b) => hs.some((o) => a > o.lo[ai] && a < o.hi[ai] && b > o.lo[bi] && b < o.hi[bi]);
    for (let j = 0; j < bs.length - 1; j++) {
      let run = null;
      for (let i = 0; i < as.length - 1; i++) {
        const solid = !inHole((as[i] + as[i + 1]) / 2, (bs[j] + bs[j + 1]) / 2);
        if (solid && run == null) run = as[i];
        if ((!solid || i === as.length - 2) && run != null) {
          const ae = solid ? as[i + 1] : as[i], l = [...lo], h2 = [...hi];
          l[ai] = run; h2[ai] = ae; l[bi] = bs[j]; h2[bi] = bs[j + 1];
          hex("wall", boxC(l[0], l[1], l[2], h2[0], h2[1], h2[2]), { name: nm }); run = null;
        }
      }
    }
    return true;
  };
  if (!holed("back", [0, 0, D - t], [W, H, D], 2)) hex("wall", [[0, 0, zi(0)], [W, 0, zi(0)], [W, H, zi(H)], [0, H, zi(H)], [0, 0, zo(0)], [W, 0, zo(0)], [W, H, zo(H)], [0, H, zo(H)]], { name: "back" });
  hex("wall", toBack(0, 0, W, y0, tf), { name: "bottom" });
  if (!holed("top", [0, y1, tf], [W, H, D - t], 1)) hex("wall", toBack(0, y1, W, H, tf), { name: "top" });
  if (!holed("left", [0, y0, tf], [t, y1, D - t], 0)) hex("wall", toBack(0, y0, t, y1, tf), { name: "left" });
  if (!holed("right", [W - t, y0, tf], [W, y1, D - t], 0)) hex("wall", toBack(W - t, y0, W, y1, tf), { name: "right" });
  for (const dv of dividers) {
    const xd = dv.x;
    // (in layers: each its own piece, so the 3D view shows them)
    for (let i = 0; i < layers; i++) {
      const xa = xd + i * t, xe = xd + (i + 1) * t;
      if (!dividerGaps.length || hall) hex("inner", toBack(xa, y0, xe, y1, tf), { name: "divider" });
      else {
        const [g0, g1] = dividerGaps[0];
        hex("inner", boxC(xa, y0, tf, xe, y1, g0), { name: "divider" });
        if (Dt < D) hex("inner", [[xa, y0, g1], [xe, y0, g1], [xe, y1, g1], [xa, y1, g1], [xa, y0, zi(y0)], [xe, y0, zi(y0)], [xe, y1, zi(y1)], [xa, y1, zi(y1)]], { name: "divider" });
      }
    }
  }
  // the chambers' air (shown faintly in the see-through view)
  for (const r of rooms) parts.push({ kind: "hex", group: "chamber", k: r.k, vented: topo.vented[r.k], c: toBack(r.x[0], y0, r.x[1], y1, tf) });

  // the cut list (each panel's two sides, in metres). Front and back cover everything; top and bottom run between
  // them; the sides fit inside all four.
  const bev = (theta * 180) / Math.PI;
  const cut = [
    bp ? { name: "Front", n: 1, a: W, b: H } : { name: "Front (baffle)", n: layers, a: W, b: H, note: layers > 1 ? `${layers} layers glued together: the baffle the sub${N > 1 ? "s" : ""} mount${N > 1 ? "" : "s"} on, ${fmtLenSI(tf)} thick` : "" },
    { name: "Back", n: 1, a: W, b: Dt < D ? H / Math.cos(theta) : H, note: Dt < D ? `long side; bevel top and bottom edges ${bev.toFixed(1)}°` : "" },
    { name: "Top", n: 1, a: W, b: zi(y1) - tf, note: Dt < D ? `long side; bevel the back edge ${bev.toFixed(1)}°` : "" },
    { name: "Bottom", n: 1, a: W, b: zi(0) - tf, note: Dt < D ? `long side; bevel the back edge ${bev.toFixed(1)}°` : "" },
    Dt < D ? { name: "Sides", n: 2, a: Hi, b: zi(y0) - tf, b2: zi(y1) - tf, note: `a wedge: ${fmtLenSI(zi(y0) - tf)} at the bottom, ${fmtLenSI(zi(y1) - tf)} at the top` }
      : { name: "Sides", n: 2, a: Hi, b: Dmin },
  ];
  // (a port opening out of the back, top or a side: its opening on that panel's line)
  for (const p of ports) if (p.F && p.F.face !== "front") {
    const o = faceHoles.find((q) => q.face === p.F.face), row = cut.find((c) => c.name === (p.F.face === "back" ? "Back" : p.F.face === "top" ? "Top" : "Sides"));
    if (!o || !row) continue;
    const dims = [0, 1, 2].map((k) => o.hi[k] - o.lo[k]).sort((a, b) => b - a);
    const what = p.kind === "round" ? `${p.n > 1 ? p.n + " holes" : "a hole"} ${fmtLenSI(p.dia + 0.006)} across for the port tube${p.n > 1 ? "s" : ""}` : `the port's opening, ${fmtLenSI(dims[0])} × ${fmtLenSI(dims[1])}`;
    row.note = [row.note, `${p.F.face === "left" || p.F.face === "right" ? `the ${p.F.face} one: ` : ""}cut ${what} in it`].filter(Boolean).join("; ");
  }
  if (dividers.length) {
    const bn = layers > 1 ? `${layers} layers glued together for each, ${fmtLenSI(td)} thick: the baffle the subs mount on` : "the baffle the subs mount on";
    cut.push(Dt < D ? { name: "Divider (baffle)", n: dividers.length * layers, a: Hi, b: zi(y0) - tf, b2: Dmin, note: `a wedge, like the sides; ${bn}` } : { name: "Divider (baffle)", n: dividers.length * layers, a: Hi, b: Dmin, note: bn });
  }
  for (const p of ports) {
    // (a hallway's two rear ports: the same walls twice)
    const groups = new Map();
    for (const q of p.panels) { const k = `${q.name}|${q.a.toFixed(4)}|${q.b.toFixed(4)}`; groups.set(k, { ...q, n: (groups.get(k)?.n || 0) + 1 }); }
    for (const q of groups.values()) cut.push({ name: q.name, n: q.n, a: q.a, b: q.b });
  }
  for (const p of ports) if (p.fillets) cut.push({ name: `${cap(portName(B, p))} bend strips`, n: p.fillets, a: p.top ? p.xb - p.xa : Hi, b: p.sw, note: `45° strips (a square ${fmtLenSI(p.sw)} on a side, cut corner to corner), one in each bend's outer corner; round over the port's mouth too` });
  // (dowels by length)
  const dl = new Map(); for (const d of dowels) { const k = d.len.toFixed(3); dl.set(k, (dl.get(k) || 0) + 1); }
  // wood area (to buy enough)
  const area = cut.reduce((s, c) => s + c.n * c.a * (c.b2 ? (c.b + c.b2) / 2 : c.b), 0);
  for (const [k, n] of [...dl].sort((a, b) => b[0] - a[0])) cut.push({ name: "Dowel brace (round)", n, a: 2 * brR, b: +k, note: "glued into shallow holes in both panels" });

  return {
    W, H, D, Dt, t, tf, td, layers, Wi, Hi, Davg, Dmin, theta, zb, zo, zi, rooms, chambers: rooms.map((r) => r.x), gross, lost, net: Vnet, ports, subs, parts, cut, area, warn,
    outside: W * H * (D + Dt) / 2, hall, topRoom: typeof topRoom === "number" ? topRoom : Infinity,
    bracing: { mode: brMode, Lmax, span, count: lite ? braces.length : dowels.length, dropped, r: brR },
  };
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
/** How many layers of wood the baffle (the panel the subs mount on) is: 1 to 12 (older designs: a double front, 2). */
export const baffleLayers = (B) => Math.max(1, Math.min(12, Math.round(B.layers != null ? +B.layers || 1 : B.dbl ? 2 : 1)));
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
  const bp = B.type === "bp4" || B.type === "bp6", hall = bp && B.style === "hall";
  // (the wood across the width: both sides and the divider(s), each divider as thick as the baffle's layers)
  const wallsW = 2 * B.t + (hall ? 2 : 1) * (bp ? baffleLayers(B) : 1) * B.t;
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
    // (the least area that reaches the tuning 2″ longer than the wood, and about 12 in² per ft³: whichever is more)
    let Sneed = 12 * (target2 / FT3) * IN * IN;
    if (P1.fb) while (Sneed < 0.5 && lenFor(target2, Sneed, Sneed, P1.fb) < t + 2 * IN) Sneed *= 1.1;
    const hallMin = Math.max(3 * IN, P1.kind === "round" ? tubes(P1) + 3 * IN : Math.max(Sneed / (B.h - 2 * t), P1.w || 0) + 2 * t + 3 * IN);
    const wfMin = hall ? hallMin : (P1.kind === "round" ? tubes(P1) : slot(P1)) + 2 * IN;
    let W = Math.max(B.w, 0.4), wr = 0.2, grew = false;
    const rearRooms = hall ? 2 : 1;
    for (let pass = 0; pass < 2; pass++) {
      let r = bisect(0.01, 3, (x) => layout({ ...B, w: Math.max(W, wallsW + rearRooms * x + 0.08), wr: x }, true).net[0] - target);
      if (r == null) return null;
      if (r < wrMin) { r = wrMin; grew = true; }
      wr = r;
      const wmin = wallsW + rearRooms * wr + wfMin;
      let w2 = bisect(wallsW + rearRooms * wr + 0.03, 10, (x) => layout({ ...B, w: x, wr }, true).net[1] - target2);
      if (w2 == null) return null;
      if (w2 < wmin) { w2 = wmin; grew = true; }
      W = w2;
    }
    const out = { ...B, w: W, split: (rearRooms * wr) / Math.max(0.02, W - wallsW), wr: undefined };
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
export const misfits = (L) => L.warn.filter((w) => /fit|too long|deeper|too narrow|too small|runs into/.test(w)).length;
/** A good shape for the design: the measurement being solved comes from the volume; the other two are searched for the
 * most compact box where it all fits, not taller than it is wide, inside the space given (lim: { w, h, d }, 0 for no
 * limit). The search covers sizes stepping up from the least the subs need (tall enough for their cutouts, deep enough
 * for their magnets) and the sizes that fit one, two, three… rows of subs exactly. Whole inches. Returns the new B
 * (or null). */
/** The width a ported box's port takes beside the subs on the front: along a side, a slot and its wall (folded, out
 * of the back or top: twice that); up the middle, a folded slot and three walls; out of a side, none (it runs along
 * the back). Round: its column of tubes. */
function portRoom(B) {
  const P = B.port || {}, t = B.t, w = P.w || 0.04, at = ["back", "top", "side"].includes(P.at) && B.shape !== "wedge" ? P.at : "front", mid = P.pos === "middle";
  if (at === "side") return 0;
  if (P.kind === "round") return (P.dia || 0.1) + 1.2 * IN;
  if (mid) return 2 * w + 3 * t;
  return at === "front" ? w + t : 2 * w + 2 * t;
}
export function shapeBox(B, solveFor, t1, t2, lim = {}) {
  const t = B.t, s = B.sub, bp = B.type === "bp4" || B.type === "bp6", hall = bp && B.style === "hall";
  const tf = bp ? t : baffleLayers(B) * t, td = bp ? baffleLayers(B) * t : t;
  const N = Math.max(1, B.count | 0), per = hall ? Math.ceil(N / 2) : N, cell = Math.max(0.05, s.size || s.cutout * 1.08) + Math.max(0.003, B.gap == null ? IN : B.gap);
  const up = (x) => Math.ceil(x / IN - 1e-6) * IN;
  const topSlot = 0;
  const lipF = bp ? 0 : Math.max(0, Math.min(t, (Math.max(0.05, s.size || s.cutout * 1.08) - s.cutout) / 2 - 0.002));   // (a front frame's lip over the walls)
  const min = bp ? { w: up((hall ? 2 : 1) * (s.depth + 1.5 * IN) + (hall ? 2 * t + 2 * td + 3 * IN : 2 * t + td + 4 * IN)), h: up(cell + 2 * t + topSlot), d: up(cell + tf + t) }
    : { w: up(cell + 2 * t - 2 * lipF + (B.type === "ported" ? portRoom(B) : 0)), h: up(cell + 2 * t - 2 * lipF), d: up(s.depth + tf + t + IN) };
  const [fa, fb] = ["w", "h", "d"].filter((k) => k !== solveFor);
  const ratio = B.shape === "wedge" ? Math.min(1, B.dt / B.d) : 1;
  const ok = (k, v) => !(lim[k] > 0) || v <= lim[k] + 1e-6;
  // the sizes to try for each free measurement
  const values = (k) => {
    const set = new Set();
    for (let i = 0; i <= 9; i++) set.add(Math.round((min[k] + i * 3 * IN) / IN));
    for (let i = 5; i <= 8; i++) set.add(Math.round((min[k] + i * 6 * IN) / IN));   // (and bigger, for big ports)
    for (let r = 1; r <= Math.min(per, 8); r++) {
      const c = Math.ceil(per / r);
      // (a hallway with many subs: room above them for a top port up to 30% of the height)
      // (a hallway: room above the subs for its top port, a quarter of the height)
      if (k === "h") { set.add(Math.round(up(r * cell + 2 * t - 2 * lipF + topSlot) / IN)); if (hall && topSlot) set.add(Math.round(up(r * cell + 2 * t + Math.max(topSlot, r * cell / 3)) / IN)); }
      if (k === "w" && !bp) set.add(Math.round(up(c * cell + 2 * t - 2 * lipF + 3 * IN) / IN));
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
        const room = min.w - up(cell + 2 * t - 2 * lipF);                       // (the port's share of the width)
        if (solveFor === "w") { const rows = Math.max(1, Math.floor((C.h - 2 * t + 2 * lipF) / cell)); need.w = Math.max(min.w, up(Math.ceil(N / rows) * cell + 2 * t - 2 * lipF + room)); }
        if (solveFor === "h") { const cols = Math.max(1, Math.floor((C.w - 2 * t + 2 * lipF - room) / cell)); need.h = Math.max(min.h, up(Math.ceil(N / cols) * cell + 2 * t - 2 * lipF)); }
      }
      const floor = need[solveFor];
      if (f[solveFor] < floor - 1e-6) { f = { ...f, [solveFor]: floor, ...(solveFor === "d" && B.shape === "wedge" ? { dt: floor * ratio } : {}) }; f.grow = layout(f, true).net; }
      const L = layout(f, false, true), x = { w: L.W, h: L.H, d: L.D };
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
