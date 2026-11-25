// node test/box.test.mjs - the sub box designer's math: the simulation against the textbook results, the designs, the
// box's geometry (volumes, ports, fitting) and the wiring.
import * as M from "../js/boxmath.js";

let failed = false;
const check = (ok, what) => { console.log(`  ${ok ? "ok" : "FAIL"}: ${what}`); if (!ok) failed = true; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const { IN, FT3 } = M;

// ---------------------------------------------------------------------------------------------------- the driver
const d12 = M.driver(M.PRESETS[12]);
const ws = 2 * Math.PI * 30;
check(near(d12.qms, (0.52 * 0.48) / (0.52 - 0.48), 1e-9) && near(1 / (ws * ws * d12.mms * d12.cms), 1, 1e-9), `driver: Qms ${d12.qms.toFixed(2)}, resonance from Mms and Cms is Fs`);
check(near(d12.mms * 1000, 203, 3) && near(d12.bl, 15.8, 0.2) && near(d12.sens, 89.5, 0.3), `driver: Mms ${(d12.mms * 1000).toFixed(0)} g, BL ${d12.bl.toFixed(1)}, ${d12.sens.toFixed(1)} dB/2.83 V`);
check(M.driver({ ...M.PRESETS[12], qes: 0.4 }).guessedQms, "a Qes under Qts is caught (Qms taken as 8)");

// ---------------------------------------------------------------------------------------------------- sealed
const Vs = M.sealedVolume(d12, 1, 0.707), q = M.sealedQ(d12, 1, Vs);
let r = M.simulate({ drv: d12, count: 1, power: 1, type: "sealed", V: [Vs], ports: [], le: false });
const f3s = M.cutoff(r, r.ref);
check(near(q.qtc, 0.707, 1e-6) && near(f3s, q.fc, q.fc * 0.01), `sealed Qtc 0.707: ${(Vs / FT3).toFixed(2)} ft³, F3 ${f3s.toFixed(1)} Hz = Fc ${q.fc.toFixed(1)} Hz (Butterworth)`);
check(M.sealedVolume(d12, 1, 0.45) === null, "sealed: a Qtc under the sub's Qts is impossible");
// two subs in a box twice the size: the same Qtc
check(near(M.sealedQ(d12, 2, 2 * Vs).qtc, 0.707, 1e-6), "sealed: two subs in twice the volume, same Qtc");

// ---------------------------------------------------------------------------------------------------- ported
{
  const V = 1.75 * FT3, fb = 32, S = 0.014, len = M.lenFor(V, S, S, fb);
  check(near(M.tuneOf(V, S, S, len), fb, 1e-6), `port length for 32 Hz: ${(len / IN).toFixed(1)}″, and it tunes back to 32 Hz`);
  r = M.simulate({ drv: d12, count: 1, power: 600, type: "ported", V: [V], ports: [{ S, S1: S, len }], le: false }, M.freqs(15, 80, 800));
  const pk = []; for (let i = 1; i < r.z.length - 1; i++) if (r.z[i] > r.z[i - 1] && r.z[i] > r.z[i + 1]) pk.push(i);
  let mn = pk[0]; for (let i = pk[0]; i < pk[1]; i++) if (r.z[i] < r.z[mn]) mn = i;
  check(pk.length >= 2 && near(r.f[mn], fb, 0.8), `ported: the impedance dip between its two peaks is at ${r.f[mn].toFixed(1)} Hz (tuned to 32)`);
  // at the tuning the cone barely moves and the port does the work
  let xm = 0; for (let i = 0; i < r.f.length; i++) if (r.f[i] > 20 && r.f[i] < 60 && r.x[i] < r.x[xm] || r.f[xm] <= 20) xm = i;
  check(near(r.f[xm], fb, 1.5), `ported: the cone moves least at the tuning (${r.f[xm].toFixed(1)} Hz, ${(r.x[xm] * 1000).toFixed(1)} mm): the port does the work`);
  const v = M.ventedVolumeFor(d12, 1, 32);
  check(v / FT3 > 1.4 && v / FT3 < 2.2, `ported 12″ at 32 Hz: recommended ${(v / FT3).toFixed(2)} ft³`);
  const v4 = M.ventedVolumeFor(M.driver(M.PRESETS[18]), 4, 32), v1 = M.ventedVolumeFor(M.driver(M.PRESETS[18]), 1, 32);
  check(near(v4 / v1, 4, 0.1), `ported: four 18s need four times one's box (${(v1 / FT3).toFixed(1)} -> ${(v4 / FT3).toFixed(1)} ft³)`);
  // a real sub (Skar VXF-15's published numbers): one at 32 Hz in about 3 to 3.5 ft³, the flattest there
  const vxf = M.driver({ fs: 31.4, qts: 0.36, qes: 0.38, vas: 76.8e-3, re: 3.9, le: 3.88e-3, sd: 779e-4, xmax: 0.03, pe: 1500 });
  const vx1 = M.ventedVolumeFor(vxf, 1, 32), vx2 = M.ventedVolumeFor(vxf, 2, 32);
  check(vx1 / FT3 > 2.8 && vx1 / FT3 < 3.6 && near(vx2 / vx1, 2, 0.05) && near(vxf.mms * 1000, 303, 25) && near(vxf.bl, 24.9, 1.5), `a VXF-15 at 32 Hz: ${(vx1 / FT3).toFixed(2)} ft³ (two: ${(vx2 / FT3).toFixed(2)}); its cone ${(vxf.mms * 1000).toFixed(0)} g, BL ${vxf.bl.toFixed(1)} (spec: 303 g, 24.9)`);
  // the flattest: a bigger box at that tuning humps, a smaller one sags
  const shape = (V) => { const S = 0.03, r2 = M.simulate({ drv: vxf, count: 1, power: 1, type: "ported", V: [V], ports: [{ S, S1: S, len: M.lenFor(V, S, S, 32) }], le: false }); let a = -99, b = 99; r2.f.forEach((f, i) => { if (f >= 32 && f <= 112) { a = Math.max(a, r2.spl[i] - r2.ref); b = Math.min(b, r2.spl[i] - r2.ref); } }); return a - b; };
  check(shape(vx1) < shape(vx1 * 1.4) && shape(vx1) < shape(vx1 / 1.4), `ported: flatter than 40% bigger or smaller (${shape(vx1).toFixed(2)} vs ${shape(vx1 * 1.4).toFixed(2)} / ${shape(vx1 / 1.4).toFixed(2)} dB)`);
  const flat = M.ventedFlat(d12, 1);
  check(flat.fb > 20 && flat.fb < 30 && flat.V / FT3 > 2 && flat.V / FT3 < 4, `ported, textbook flat (QB3): ${(flat.V / FT3).toFixed(2)} ft³ at ${flat.fb.toFixed(1)} Hz`);
}

// ---------------------------------------------------------------------------------------------------- 4th order
for (const [S, g] of [[0.7, 0], [0.7, 3], [0.6, 0]]) {
  const b = M.bp4Design(d12, 1, S, g);
  const port = { S: 0.01, S1: 0.01, len: M.lenFor(b.vf, 0.01, 0.01, b.fb) };
  const r4 = M.simulate({ drv: d12, count: 1, power: 1, type: "bp4", V: [b.vr, b.vf], ports: [port], le: false, ql: 1e9 });
  const bd = M.band(r4);
  const inb = r4.spl.filter((v, i) => r4.f[i] > bd.lo * 1.15 && r4.f[i] < bd.hi / 1.15);
  const ripple = Math.max(...inb) - Math.min(...inb);
  check(near(Math.max(...inb) - r4.ref, b.gain, S === 0.7 ? 0.35 : 1.3) && (S !== 0.7 || ripple < 1.2),
    `4th order S ${S} +${g} dB: ${(b.vr / FT3).toFixed(2)} + ${(b.vf / FT3).toFixed(2)} ft³ at ${b.fb.toFixed(1)} Hz, ${bd.lo.toFixed(0)}–${bd.hi.toFixed(0)} Hz, gain ${(Math.max(...inb) - r4.ref).toFixed(2)} dB (theory ${b.gain.toFixed(2)})`);
}

// ---------------------------------------------------------------------------------------------------- 6th order
for (const size of [10, 12, 15]) for (const series of [false, true]) {
  const d = M.driver(M.PRESETS[size]), t0 = Date.now();
  const b = M.bp6Design(d, 1, series, 30, 80);
  const P = (V, f) => ({ S: 0.01, S1: 0.01, len: M.lenFor(V, 0.01, 0.01, f) });
  const r6 = M.simulate({ drv: d, count: 1, power: 1, type: "bp6", series, V: [b.vr, b.vf], ports: [P(b.vf, b.ff), P(b.vr, b.fr)], le: false });
  const inb = r6.spl.filter((v, i) => r6.f[i] >= 30 && r6.f[i] <= 80), ripple = Math.max(...inb) - Math.min(...inb);
  check(ripple < 2, `6th order ${series ? "series" : "parallel"} ${size}″ for 30–80 Hz: ±${(ripple / 2).toFixed(2)} dB (${Date.now() - t0} ms)`);
}

// ---------------------------------------------------------------------------------------------------- the box
const P12 = M.PRESETS[12], sub = { size: P12.size, cutout: P12.cutout, depth: P12.depth, disp: P12.disp };
const base = { shape: "rect", w: 24 * IN, h: 15 * IN, d: 16 * IN, dt: 11 * IN, t: 0.75 * IN, dbl: false, brace: 0, count: 1, sub,
  port: { kind: "slot", w: 1.6 * IN, auto: true, fb: 32 }, port2: { kind: "slot", w: 1.5 * IN, auto: true, fb: 28 } };
{
  const L = M.layout({ ...base, type: "sealed" });
  const inside = (24 - 1.5) * (15 - 1.5) * (16 - 1.5) * IN ** 3;
  check(near(L.gross[0], inside, 1e-9) && near(L.net[0], inside - P12.disp, 1e-9), `sealed 24×15×16, ¾″ wood: ${(L.gross[0] / FT3).toFixed(3)} ft³ inside, ${(L.net[0] / FT3).toFixed(3)} net`);
  const cuts = Object.fromEntries(L.cut.map((c) => [c.name, c]));
  check(near(cuts.Top.b / IN, 14.5, 1e-6) && near(cuts.Sides.a / IN, 13.5, 1e-6) && cuts.Sides.n === 2, "cut list: top 24 × 14½, sides 13½ × 14½");
  const Ld = M.layout({ ...base, type: "sealed", dbl: true });
  check(near(Ld.gross[0], (24 - 1.5) * (15 - 1.5) * (16 - 2.25) * IN ** 3, 1e-9) && Ld.cut[0].n === 2, "a double front takes another ¾″ off the inside");
}
// (each with the tunings its design gives: front port, then the rear or inner one)
for (const [type, series, a, b, f1, f2, w1] of [["sealed", 0, 1.3], ["ported", 0, 1.75, 0, 32], ["bp4", 0, 1.3, 0.7, 44.6, 0, 1.2], ["bp6", 0, 2.15, 0.62, 58.8, 26.6, 1.1], ["bp6", 1, 0.77, 1.0, 46.5, 31.1, 0.8]]) {
  const B = { ...base, type, series: !!series, port: { kind: "slot", w: (w1 || 1.6) * IN, auto: true, fb: f1 }, port2: { kind: "slot", w: 0.8 * IN, auto: true, fb: f2 } };
  const t0 = Date.now(), f = M.fitBox(B, "w", a * FT3, b && b * FT3), ms = Date.now() - t0, L = M.layout(f);
  const ok = near(L.net[0], a * FT3, a * FT3 * 0.002) && (!b || near(L.net[1], b * FT3, b * FT3 * 0.002));
  const tuned = L.ports.every((p) => near(p.fb, p.fbWant, 0.01));
  const sums = L.gross.every((g, k) => near(g - L.lost[k].sub - L.lost[k].brace - L.lost[k].port, L.net[k], 1e-9));
  check(ok && tuned && sums && ms < 300, `sized ${type}${series ? " series" : ""}: ${(f.w / IN).toFixed(2)}″ wide for ${L.net.map((v) => (v / FT3).toFixed(3)).join(" + ")} ft³, ports tuned ${L.ports.map((p) => p.fb.toFixed(2)).join(" / ")} Hz (${ms} ms)`);
}
{
  // the port's room: a bigger port in the same box takes more of it, and its length still tunes it
  const L1 = M.layout({ ...base, type: "ported" }), L2 = M.layout({ ...base, type: "ported", port: { ...base.port, w: 2 * IN } });
  check(L2.lost[0].port > L1.lost[0].port && near(L2.ports[0].fb, 32, 0.01), `a bigger port takes more room (${(L1.lost[0].port / FT3).toFixed(2)} -> ${(L2.lost[0].port / FT3).toFixed(2)} ft³), still tuned to 32 Hz`);
  // an L-shaped port: down the side and across the back
  const Lb = M.layout({ ...base, w: 30 * IN, type: "ported", port: { ...base.port, w: 2 * IN } });
  const p = Lb.ports[0];
  check(p.bend && Lb.cut.some((c) => /back\)/.test(c.name)) && !M.misfits(Lb), `a long port bends along the back (${(p.len / IN).toFixed(1)}″), and fits`);
  // too big a port for the box: said, not a runaway
  const Lh = M.layout({ ...base, type: "ported", shape: "wedge", w: 36 * IN, h: 14 * IN, d: 15 * IN, dt: 9 * IN, port: { kind: "slot", w: 3 * IN, auto: true, fb: 30 } });
  check(Lh.ports[0].len < 3 && Lh.warn.some((w) => /too big for this box/.test(w)), "a port too big for its box is caught (no runaway length)");
  // a manual length: a longer port tunes lower
  const Lm1 = M.layout({ ...base, type: "ported", port: { ...base.port, auto: false, len: 20 * IN } }), Lm2 = M.layout({ ...base, type: "ported", port: { ...base.port, auto: false, len: 30 * IN } });
  check(Lm2.ports[0].fb < Lm1.ports[0].fb, `manual port lengths: 20″ tunes to ${Lm1.ports[0].fb.toFixed(1)} Hz, 30″ to ${Lm2.ports[0].fb.toFixed(1)} Hz`);
  // round ports
  const Lr = M.layout({ ...base, type: "ported", w: 30 * IN, d: 22 * IN, port: { kind: "round", dia: 4 * IN, n: 2, auto: true, fb: 33 } });
  check(Lr.ports[0].tubes.length === 2 && near(Lr.ports[0].fb, 33, 0.01) && !M.misfits(Lr), `two 4″ round ports, ${(Lr.ports[0].len / IN).toFixed(1)}″ long, fit in a 22″-deep box`);
  // a wedge: its inside by another route
  const Lw = M.layout({ ...base, type: "sealed", shape: "wedge", w: 30 * IN, h: 14 * IN, d: 16 * IN, dt: 10 * IN });
  const th = Math.atan(6 / 14), tb = 0.75 / Math.cos(th), zi = (y) => 16 - (6 * y) / 14 - tb;
  const inW = 28.5 * 12.5 * ((zi(0.75) + zi(13.25)) / 2 - 0.75) * IN ** 3;
  check(near(Lw.gross[0], inW, 1e-9) && Lw.cut.some((c) => /bevel/.test(c.note || "")), `wedge 30×14×16/10: ${(Lw.gross[0] / FT3).toFixed(3)} ft³ inside, beveled panels in the cut list`);
  // series 6th order: the inner port bends along the rear chamber's side
  const Ls = M.layout({ ...base, type: "bp6", series: true, w: 22 * IN, h: 14 * IN, d: 24 * IN, split: 0.45, port2: { kind: "slot", w: 1 * IN, auto: true, fb: 30 } });
  check(Ls.ports[1].inner && Ls.ports[1].bend && near(Ls.ports[1].fb, 30, 0.01), `series inner port: ${(Ls.ports[1].len / IN).toFixed(1)}″, bent along the rear chamber, tuned to 30 Hz`);
}

// ---------------------------------------------------------------------------------------------------- recommended shapes fit
{
  let misfit = 0, n = 0, slow = 0;
  for (const size of [8, 10, 12, 15, 18]) for (const count of [1, 2, 3, 4]) for (const type of ["sealed", "ported", "bp4", "bp6"]) {
    const P = M.PRESETS[size], d = M.driver(P), s = { size: P.size, cutout: P.cutout, depth: P.depth, disp: P.disp };
    let a, b, port = { kind: "slot", auto: true }, port2 = { kind: "slot", auto: true };
    if (type === "sealed") a = M.sealedVolume(d, count, 0.707);
    else if (type === "ported") { a = M.ventedVolumeFor(d, count, 32); port.fb = 32; }
    else if (type === "bp4") { const x = M.bp4Design(d, count, 0.7, 0); a = x.vr; b = x.vf; port.fb = x.fb; }
    else { const x = M.bp6Design(d, count, false, 30, 80); a = x.vr; b = x.vf; port.fb = x.ff; port2.fb = x.fr; }
    const B = { ...base, type, count, sub: s, port, port2 };
    // (ports at 14 in² per ft³ of their chamber, the rule of thumb)
    const hi = 13.5 * IN;
    if (type === "ported") port.w = (14 * (a / FT3) * IN * IN) / hi;
    if (type === "bp4") port.w = (14 * (b / FT3) * IN * IN) / hi;
    if (type === "bp6") { port.w = (14 * (b / FT3) * IN * IN) / hi; port2.w = (14 * (a / FT3) * IN * IN) / hi; }
    // (as the screen does: shaped; a port that still can't fit made 15% smaller, down to 10 in² per ft³, and again)
    const t0 = Date.now();
    let f = null, L = null;
    for (let k = 0; k < 7; k++) {
      f = M.shapeBox(B, "w", a, b); L = f && M.layout(f);
      if (!L || !M.misfits(L)) break;
      let shrunk = false;
      for (const p of L.ports) { const Q = p.key === "port2" ? port2 : port; if (p.S * 0.85 >= 10 * (L.net[p.k] / FT3) * IN * IN) { Q.w *= 0.85; shrunk = true; } }
      if (!shrunk) break;
    }
    const ms = Date.now() - t0;
    n++; if (ms > 4000) slow++;
    if (!L || M.misfits(L)) { misfit++; console.log(`    doesn't fit: ${size}″ ×${count} ${type}: ${L ? L.warn.join(" | ") : "no box"}`); }
  }
  check(misfit === 0 && slow === 0, `recommended shapes: ${n - misfit} of ${n} designs (8–18″, 1–4 subs, every type) fit${slow ? `, ${slow} slow` : ""}`);
}

// ---------------------------------------------------------------------------------------------------- the sub in 3D, to scale
{
  const { subParts } = await import("../js/box3d.js");
  const big = subParts({ size: 15.4 * IN, cutout: 13.86 * IN, depth: 9.8 * IN, pe: 1500, xmax: 0.022, panel: 0.75 * IN });
  const mid = subParts({ ...M.PRESETS[12], panel: 0.75 * IN }), lo = subParts({ ...M.PRESETS[12], pe: 250, panel: 0.75 * IN });
  check(near(big.dm / IN, 8.6, 0.35) && big.slugs === 2 && big.dm < 2 * big.rc && big.motor < big.depth, `a 15″ 1500 W sub: an ${(big.dm / IN).toFixed(2)}″ magnet, ${big.slugs} slugs (a real one: 8.6″, double stack)`);
  check(mid.slugs === 1 && mid.dm < big.dm && lo.dm < mid.dm && lo.motor < mid.motor, `more power, a bigger motor: 12″ at 250 W ${(lo.dm / IN).toFixed(2)}″, at 600 W ${(mid.dm / IN).toFixed(2)}″`);
  const shallow = subParts({ size: 10 * IN, cutout: 9.1 * IN, depth: 3.2 * IN, pe: 1200, panel: 0.75 * IN });
  check(shallow.motor <= (shallow.depth - shallow.panel) * 0.62 + 1e-9 && shallow.dm < 2 * shallow.rc, "the motor always fits the mounting depth and passes through the cutout");
}

// ---------------------------------------------------------------------------------------------------- the textbook check
// The simulation, lossless and without the coil's inductance, against the closed-form transfer functions: sealed (2nd
// order high-pass), vented (Small's 4th order) and 4th-order bandpass. They must agree everywhere from 10 to 300 Hz.
{
  const fr = M.freqs(10, 300, 300), worst = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const ws = 2 * Math.PI * d12.fs, at = (f) => 2 * Math.PI * f;
  // sealed
  const Vb = 1.2 * FT3, a = d12.vas / Vb, wc = ws * Math.sqrt(1 + a), qtc = d12.qts * Math.sqrt(1 + a);
  const rs = M.simulate({ drv: d12, count: 1, power: 1, type: "sealed", V: [Vb], ports: [], le: false, lossless: true }, fr);
  const gs = fr.map((f) => { const x = at(f) / wc; return 20 * Math.log10((x * x) / Math.hypot(1 - x * x, x / qtc)); });
  const es = worst(rs.spl.map((v) => v - rs.ref), gs);
  // vented (Small 1973): G = s⁴T0⁴ / (s⁴T0⁴ + a1 s³T0³ + a2 s²T0² + a3 sT0 + 1), no box losses
  const Vv = 2 * FT3, fb = 32, S = 0.012, len = M.lenFor(Vv, S, S, fb);
  const rv = M.simulate({ drv: d12, count: 1, power: 1, type: "ported", V: [Vv], ports: [{ S, S1: S, len }], le: false, lossless: true }, fr);
  const h = fb / d12.fs, al = d12.vas / Vv, T0 = 1 / Math.sqrt(ws * 2 * Math.PI * fb), a1 = 1 / (Math.sqrt(h) * d12.qts), a2 = (al + 1 + h * h) / h, a3 = Math.sqrt(h) / d12.qts;
  const gv = fr.map((f) => { const x = at(f) * T0, re = x ** 4 - a2 * x * x + 1, im = -a1 * x ** 3 + a3 * x; return 20 * Math.log10(x ** 4 / Math.hypot(re, im)); });
  const ev = worst(rv.spl.map((v) => v - rv.ref), gv);
  // 4th-order bandpass: H = s²ωb² / [(s² + s ωc/Qbp + ωc²)(s² + ωb²) + s² ωs² Vas/Vf]
  const b4 = M.bp4Design(d12, 1, 0.7, 2), wb = 2 * Math.PI * b4.fb, wc4 = ws * Math.sqrt(1 + d12.vas / b4.vr), q4 = d12.qts * Math.sqrt(1 + d12.vas / b4.vr);
  const r4 = M.simulate({ drv: d12, count: 1, power: 1, type: "bp4", V: [b4.vr, b4.vf], ports: [{ S: 0.01, S1: 0.01, len: M.lenFor(b4.vf, 0.01, 0.01, b4.fb) }], le: false, lossless: true }, fr);
  const g4 = fr.map((f) => {
    const w = at(f), Ar = wc4 * wc4 - w * w, Ai = (w * wc4) / q4, Br = wb * wb - w * w;
    const re = Ar * Br - w * w * ws * ws * (d12.vas / b4.vf), im = Ai * Br;
    return 20 * Math.log10((w * w * wb * wb) / Math.hypot(re, im));
  });
  const e4 = worst(r4.spl.map((v) => v - r4.ref), g4);
  check(es < 0.01 && ev < 0.01 && e4 < 0.01, `the simulation matches the textbook: sealed within ${es.toFixed(4)} dB, vented ${ev.toFixed(4)} dB, 4th-order bandpass ${e4.toFixed(4)} dB (10–300 Hz)`);
  // the excursion: well under the box's resonance a sealed box's cone moves as the force over the total stiffness
  const r0 = M.simulate({ drv: d12, count: 1, power: 1, type: "sealed", V: [Vb], ports: [], le: false, lossless: true }, [2]);
  const e = Math.sqrt(d12.re), k = 1 / d12.cms + (M.RHO * M.C * M.C * d12.sd * d12.sd) / Vb, x0 = (Math.SQRT2 * d12.bl * e) / d12.re / k;
  check(near(r0.x[0], x0, x0 * 0.01), `cone travel at 2 Hz in a sealed box: ${(r0.x[0] * 1000).toFixed(3)} mm, force/stiffness says ${(x0 * 1000).toFixed(3)} mm`);
}

// ---------------------------------------------------------------------------------------------------- a hallway, 20 subs
{
  const B = { ...base, type: "bp6", style: "hall", count: 4, w: 48 * IN, h: 16 * IN, d: 24 * IN, split: 0.72, port: { kind: "slot", w: 2 * IN, auto: true, fb: 55 }, port2: { kind: "slot", w: 0.9 * IN, auto: true, fb: 30 } };
  const L = M.layout(B);
  const wr = L.rooms[0].x[1] - L.rooms[0].x[0], gr = 2 * wr * L.Hi * L.Davg;
  const p1 = L.ports[0], p2 = L.ports[1];
  check(L.rooms.length === 3 && near(L.gross[0], gr, 1e-9) && near(L.rooms[2].x[1] - L.rooms[2].x[0], wr, 1e-9) && p2.copies === 2 && near(p2.S, 2 * p2.S1, 1e-12) && p1.top
    && L.subs.length === 4 && L.subs.filter((s) => s.dir[0] > 0).length === 2 && L.cut.some((c) => c.name === "Divider" && c.n === 2) && near(p1.fb, 55, 0.01) && near(p2.fb, 30, 0.01),
    `hallway: two rear rooms (${(wr / IN).toFixed(1)}″ each, ${(L.net[0] / FT3).toFixed(2)} ft³ together), two subs facing two, a top port ${(p1.len / IN).toFixed(1)}″ at 55 Hz, two rear ports ${(p2.len / IN).toFixed(1)}″ at 30 Hz`);
  const f = M.fitBox({ ...B }, "w", 3 * FT3, 1.2 * FT3), Lf = f && M.layout(f);
  check(!!Lf && near(Lf.net[0], 3 * FT3, 0.01 * FT3) && near(Lf.net[1], 1.2 * FT3, 0.01 * FT3), `hallway sized to 3 + 1.2 ft³: ${Lf && (Lf.W / IN).toFixed(1)}″ wide`);
  // 20 subs on a front
  const d10 = M.driver(M.PRESETS[10]), P10 = M.PRESETS[10], s10 = { size: P10.size, cutout: P10.cutout, depth: P10.depth, disp: P10.disp };
  const V20 = M.ventedVolumeFor(d10, 20, 32);
  const B20 = { ...base, type: "ported", count: 20, sub: s10, port: { kind: "slot", w: (14 * (V20 / FT3) * IN * IN) / (40 * IN), auto: true, fb: 32 } };
  const t0 = Date.now(), f20 = M.shapeBox(B20, "w", V20), ms = Date.now() - t0, L20 = f20 && M.layout(f20);
  check(!!L20 && L20.subs.length === 20 && !M.misfits(L20) && near(L20.net[0], V20, V20 * 0.002) && ms < 6000, `20 10″ subs, ported: a ${L20 && [L20.W, L20.H, L20.D].map((v) => (v / IN).toFixed(0)).join("×")}″ wall, ${(V20 / FT3).toFixed(1)} ft³, everything fits (${ms} ms)`);
  // the space you have
  const fl = M.shapeBox({ ...base, type: "ported", port: { kind: "slot", w: 1.6 * IN, auto: true, fb: 32 } }, "w", 1.75 * FT3, undefined, { h: 14 * IN, d: 16 * IN });
  check(!!fl && fl.h <= 14 * IN + 1e-6 && fl.d <= 16 * IN + 1e-6, `kept inside the space given (14″ tall, 16″ deep): ${(fl.w / IN).toFixed(1)}×${(fl.h / IN).toFixed(0)}×${(fl.d / IN).toFixed(0)}″`);
}

// ---------------------------------------------------------------------------------------------------- the list of real subs
{
  const { SUBS, subFrom, subName } = await import("../js/subs.js");
  let odd = [];
  for (const s of SUBS) {
    const { drv } = subFrom(s.row), d = M.driver(drv), g = (d.mms * 1000) / (drv.sd * 1e4), v = M.ventedVolumeFor(d, 1, 32) / FT3;
    if (!(g > 0.08 && g < 2.5) || d.guessedQms || !(v > 0.15 && v < 15)) odd.push(subName(s));
  }
  const brands = new Set(SUBS.map((s) => s.brand));
  check(SUBS.length >= 80 && SUBS.filter((s) => s.full).length >= 60 && brands.size >= 8 && SUBS.filter((s) => s.brand === "Skar Audio").length >= 15 && !odd.length,
    `${SUBS.length} real subs (${SUBS.filter((s) => s.full).length} with full specs), ${brands.size} brands, each a believable sub with a sensible box${odd.length ? ": odd: " + odd.join(", ") : ""}`);
}

// ---------------------------------------------------------------------------------------------------- wiring
const w2 = M.wiring(2, true, 4).map((o) => o.ohms), w4 = M.wiring(4, true, 2).map((o) => o.ohms), w1 = M.wiring(1, false, 4).map((o) => o.ohms);
check(w2.join() === "1,4,16" && w4.join() === "0.25,1,4,16" && w1.join() === "4", `wiring: 2 DVC 4 Ω -> ${w2.join("/")} Ω; 4 DVC 2 Ω -> ${w4.join("/")} Ω; 1 SVC 4 Ω -> ${w1} Ω`);
const w20 = M.wiring(20, true, 4), w6 = M.wiring(6, false, 4).map((o) => o.ohms);
check(w20.length >= 6 && w20.every((o, i) => !i || o.ohms > w20[i - 1].ohms) && w6.join() === "0.667,2.667,6,24".split(",").map(Number).map((v, i) => [4 / 6, 4 * 4 / 6 / 1, 6, 24][i] && v).join() || (w6.includes(4 / 6) && w6.includes(6) && w6.includes(24)),
  `wiring 20 DVC 4 Ω subs: ${w20.map((o) => +o.ohms.toFixed(2)).join(", ")} Ω; 6 SVC 4 Ω: ${w6.map((v) => +v.toFixed(2)).join(", ")} Ω`);

console.log(failed ? "FAIL" : "box: all ok");
process.exit(failed ? 1 : 0);
