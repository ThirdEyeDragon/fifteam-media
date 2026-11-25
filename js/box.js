// The Box screen: a sub box designer. Pick the box (sealed, ported, 4th- or 6th-order bandpass), the sub (typical
// numbers by size, or its own spec sheet), and the design (recommended, or your own volumes and tunings); then the
// measurements: the box sizes itself to the volume (or keeps your exact measurements), works out the port, and shows
// it all live in 3D, with the simulated response, cone travel, port air speed, impedance and group delay, what to
// watch out for, the cut list and how to wire the subs. Designs can be saved.
import { $, toast, bus } from "./ui.js";
import * as M from "./boxmath.js";
import { boxView } from "./box3d.js";

const KEY = "fifteam-box", SAVED = "fifteam-boxes";
const { IN, FT3, L: LTR, CM } = M;
const FR = M.freqs(10, 300, 240);

// ---------------------------------------------------------------------------------------------------- the design
function defaults() {
  const p = M.PRESETS[12];
  return {
    v: 1, units: "in", type: "ported", series: false, preset: "12",
    drv: { fs: p.fs, qts: p.qts, qes: p.qes, vas: p.vas, re: p.re, le: p.le, sd: p.sd, xmax: p.xmax, pe: p.pe, size: p.size, cutout: p.cutout, depth: p.depth, disp: p.disp },
    count: 1, power: 600,
    qtc: 0.707, vbS: 1.3 * FT3,                     // sealed
    vbP: 1.75 * FT3, fbP: 32,                       // ported
    s4: 0.7, g4: 0, vr4: 1.3 * FT3, vf4: 0.7 * FT3, fb4: 45,
    vr6: 2.1 * FT3, fr6: 27, vf6: 0.6 * FT3, ff6: 59, lo6: 30, hi6: 80,
    shape: "rect", w: 24 * IN, h: 15 * IN, d: 16 * IN, dt: 11 * IN, t: 0.75 * IN, dbl: false, brace: 0,
    fixed: false, solve: "w", split: 0.55,
    port: { kind: "slot", w: 1.6 * IN, dia: 4 * IN, n: 1, auto: true, len: 0 },
    port2: { kind: "slot", w: 1.5 * IN, dia: 3 * IN, n: 1, auto: true, len: 0 },
    cab: false, cabF: 50, ql: 10,
    finish: "mdf", view: "solid", chart: "spl", pin: true,
    wire: { dual: true, ohms: 4, amp: 1 },
    designed: { ported: true },
  };
}
let st = null;
function load() {
  const d = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && s.v === 1) return { ...d, ...s, drv: { ...d.drv, ...s.drv }, port: { ...d.port, ...s.port }, port2: { ...d.port2, ...s.port2 }, wire: { ...d.wire, ...s.wire }, designed: { ...s.designed } };
  } catch {}
  return d;
}
let saveT = 0;
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} }, 400); };

const get = (path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), st);
const set = (path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((o, k) => o[k], st)[last] = v; };

// ---------------------------------------------------------------------------------------------------- units
const UNITS = {
  len: { in: [IN, "in", 2], cm: [CM, "cm", 1] },
  vol: { in: [FT3, "ft³", 2], cm: [LTR, "L", 1] },
  area: { in: [IN * IN, "in²", 1], cm: [CM * CM, "cm²", 0] },
  mm: [1e-3, "mm", 1], hz: [1, "Hz", 1], ohm: [1, "Ω", 2], w: [1, "W", 0], mh: [1e-3, "mH", 2], q: [1, "", 3], n: [1, "", 0], db: [1, "dB", 1],
};
const unit = (kind) => { const u = UNITS[kind]; return Array.isArray(u) ? u : u[st.units]; };
const num = (kind, si, dec) => { const [k, , d] = unit(kind); const v = si / k; return +v.toFixed(dec ?? d); };
const fmt = (kind, si, dec) => { const [, name] = unit(kind); return `${num(kind, si, dec).toLocaleString()}${name ? (kind === "hz" || kind === "w" || kind === "db" ? " " : " ") + name : ""}`; };
/** A length for building: inches to the nearest 1/16 (as a fraction), or centimetres to a millimetre. */
function cutLen(m) {
  if (st.units === "cm") return `${(m / CM).toFixed(1)} cm`;
  let x = Math.round((m / IN) * 16), w = Math.floor(x / 16), f = x % 16, d = 16;
  while (f && f % 2 === 0) { f /= 2; d /= 2; }
  return `${w || !f ? w : ""}${f ? `${w ? " " : ""}${f}/${d}` : ""}″`;
}
const warnUnits = (s) => (st.units === "cm" ? s.replace(/([\d.]+)″/g, (m, v) => `${(+v * 2.54).toFixed(1)} cm`) : s.replace(/([\d.]+)″/g, "$1 in"));

// ---------------------------------------------------------------------------------------------------- building the screen
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const icon = (id) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + id); s.append(u); return s; };
function section(id, ico, title, sub) {
  const c = h("div", "card sec"); c.id = id;
  const head = h("div", "sec-head"), b = h("span", "sec-ico"); b.append(icon(ico));
  const t = h("div", "sec-t"); t.append(h("b", "", title), h("small", "", sub));
  head.append(b, t); c.append(head);
  return c;
}
function seg(id, items, on) {
  const s = h("div", "seg"); if (id) s.id = id;
  for (const [k, label] of items) { const b = h("button", k === on ? "on" : "", label); b.type = "button"; b.dataset.k = k; s.append(b); }
  return s;
}
const FIELDS = [];
/** A number box bound to a path in the design, in the right units. */
function field(path, label, kind, o = {}) {
  const l = h("label", "bx-f"); const top = h("span", "bx-fl"); const name = h("span", "", label), un = h("small", "");
  top.append(name, un);
  const inp = h("input", "input"); inp.inputMode = "decimal"; inp.autocomplete = "off"; inp.dataset.path = path;
  l.append(top, inp);
  const f = { path, kind, inp, un, o, l };
  inp.addEventListener("input", () => {
    const v = parseFloat(inp.value.replace(",", "."));
    const ok = isFinite(v) && v >= (o.min ?? 0) && (o.max == null || v <= o.max) && (o.zero || v > 0);
    inp.classList.toggle("bad", !ok);
    if (!ok) return;
    set(path, kind === "n" ? Math.round(v) : v * unit(kind)[0]);
    if (o.on) o.on();
    if (path.startsWith("drv.")) { st.preset = "custom"; paintPresets(); }
    schedule();
  });
  inp.addEventListener("blur", () => { inp.classList.remove("bad"); paintField(f); });
  FIELDS.push(f);
  return l;
}
function paintField(f) {
  f.un.textContent = unit(f.kind)[1];
  const ro = f.o.ro ? f.o.ro() : false;
  f.inp.readOnly = ro; f.l.classList.toggle("ro", ro);
  if (f.o.hide) f.l.hidden = f.o.hide();
  if (document.activeElement === f.inp) return;
  const v = get(f.path);
  f.inp.value = v == null || !isFinite(v) ? "" : String(num(f.kind, v, f.o.dec));
}
const paintFields = () => FIELDS.forEach(paintField);
const grid = (cols, ...kids) => { const g = h("div", "bx-grid" + (cols === 2 ? " two" : "")); g.append(...kids); return g; };
function sw(label, sub, on, fn) {
  const l = h("label", "switch"); const t = h("span", "txt", label); if (sub) t.append(h("small", "", sub));
  const i = h("input"); i.type = "checkbox"; i.checked = on; i.onchange = () => fn(i.checked);
  l.append(t, i); return l;
}
const chips = (id, items, onPick) => {
  const c = h("div", "chips"); if (id) c.id = id;
  for (const [k, label] of items) { const b = h("button", "chip", label); b.type = "button"; b.dataset.k = k; b.onclick = () => onPick(k, b); c.append(b); }
  return c;
};

// ---------------------------------------------------------------------------------------------------- designs for each type
const vented = () => st.type !== "sealed";
const drvNow = () => M.driver(st.drv);
/** Recommended volumes and tunings for the box type (and the sub, and how many). */
function design(type = st.type, quiet = false) {
  const d = drvNow(), N = st.count;
  if (type === "sealed") {
    if (st.qtc <= d.qts * 1.02) st.qtc = Math.max(0.707, +(d.qts * 1.2).toFixed(2));
    st.vbS = M.sealedVolume(d, N, st.qtc);
  } else if (type === "ported") st.vbP = M.ventedVolumeFor(d, N, st.fbP);
  else if (type === "bp4") { const b = M.bp4Design(d, N, st.s4, st.g4); st.vr4 = b.vr; st.vf4 = b.vf; st.fb4 = +b.fb.toFixed(1); }
  else { const b = M.bp6Design(d, N, st.series, st.lo6, st.hi6); st.vr6 = b.vr; st.fr6 = +b.fr.toFixed(1); st.vf6 = b.vf; st.ff6 = +b.ff.toFixed(1); }
  st.designed[type + (type === "bp6" ? (st.series ? "s" : "p") : "")] = true;
  // the ports: sized for the air flow at this power (after a first look)
  if (type !== "sealed") { st.port.auto = true; st.port2.auto = true; compute(); sizePorts(true); }
  const moved = reshape();
  if (!quiet) toast(M.misfits(res.L) ? "Designed, but something doesn't fit: see the notes under How it plays" : moved ? "Designed for this sub, and re-sized so it all fits" : "Designed for this sub", 3500);
}
/** A good shape for the design (unless the measurements are your own): the most compact box where the sub and the
 * ports fit. If a port still can't fit, it's made a little smaller (down to 10 in² per ft³) and the box shaped again.
 * Returns whether the measurements changed. */
function reshape() {
  if (st.fixed) return false;
  const before = [st.w, st.h, st.d].join();
  for (let k = 0; k < 7; k++) {
    const f = M.shapeBox(spec(), st.solve, ...targets());
    if (f) { st.w = f.w; st.h = f.h; st.d = f.d; if (st.shape === "wedge") st.dt = f.dt; if (f.split != null) st.split = f.split; }
    const R = compute();
    if (!M.misfits(R.L) || !R.L.ports.length) break;
    let shrunk = false;
    R.L.ports.forEach((p) => {
      const P = p.key === "port2" ? st.port2 : st.port, floor = 10 * (R.L.net[p.k] / FT3) * IN * IN;
      if (p.S * 0.85 < floor) return;
      if (P.kind === "slot") P.w *= 0.85; else P.dia *= Math.sqrt(0.85);
      shrunk = true;
    });
    if (!shrunk) break;
    if (k === 6) { const g = M.shapeBox(spec(), st.solve, ...targets()); if (g) { st.w = g.w; st.h = g.h; st.d = g.d; if (st.shape === "wedge") st.dt = g.dt; if (g.split != null) st.split = g.split; } compute(); }
  }
  return before !== [st.w, st.h, st.d].join();
}
/** Port sizes for clean air flow at the power used. */
function sizePorts(quiet) {
  const R = res || compute();
  R.L.ports.forEach((p, i) => {
    const P = p.key === "port2" ? st.port2 : st.port;
    const S = M.portAreaFor(R.sim, i, R.L.net[p.k], 26, R.fmin);
    if (P.kind === "slot") P.w = Math.max(0.5 * IN, S / R.L.Hi);
    else P.dia = Math.max(1.5 * IN, 2 * Math.sqrt(S / P.n / Math.PI));
  });
  if (!quiet) { toast("Port sized for clean air flow"); schedule(); }
}
const targets = () => (st.type === "sealed" ? [st.vbS] : st.type === "ported" ? [st.vbP] : st.type === "bp4" ? [st.vr4, st.vf4] : [st.vr6, st.vf6]);
function spec() {
  const P1 = { ...st.port, fb: st.type === "ported" ? st.fbP : st.type === "bp4" ? st.fb4 : st.ff6 };
  const P2 = { ...st.port2, fb: st.fr6 };
  return {
    type: st.type, series: st.series, shape: st.shape, w: st.w, h: st.h, d: st.d, dt: Math.min(st.dt, st.d), t: st.t, dbl: st.dbl, brace: st.brace, count: st.count,
    sub: { size: st.drv.size, cutout: st.drv.cutout, depth: st.drv.depth, disp: st.drv.disp }, port: P1, port2: P2, split: st.split,
  };
}

// ---------------------------------------------------------------------------------------------------- working it out
let res = null;
function compute() {
  const drv = drvNow();
  let B = spec(), fitFail = false;
  if (!st.fixed) {
    const [a, b] = targets();
    const f = M.fitBox(B, st.solve, a, b);
    if (f) { B = f; st[st.solve] = f[st.solve]; if (st.solve === "d" && st.shape === "wedge") st.dt = f.dt; if (f.split != null) st.split = f.split; }
    else fitFail = true;
  }
  const L = M.layout(B);
  L.ports.forEach((p) => { const P = p.key === "port2" ? st.port2 : st.port; if (P.auto) P.len = p.len; });
  const sim = M.simulate({ drv, count: st.count, power: st.power, type: st.type, series: st.series, V: L.net, ports: L.ports.map((p) => ({ S: p.S, S1: p.S1, len: p.len })), ql: st.ql }, FR);
  const tunes = L.ports.map((p) => p.fb);
  // (where the cone's travel and the port's air are judged: above the subsonic filter recommended for a ported box, at
  // 0.8 x its lowest tuning; from 20 Hz for a sealed one)
  const fmin = tunes.length ? Math.max(12, 0.8 * Math.min(...tunes)) : 20;
  res = { drv, B, L, sim, fitFail, fmin };
  return res;
}
/** Cabin gain: the car's own boost, 12 dB an octave under its corner frequency. */
const cabin = (f) => (st.cab ? 10 * Math.log10(1 + (st.cabF / f) ** 4) : 0);

let raf = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; run(); }); };
function run() {
  const R = compute();
  persist();
  paintFields(); paintDesign(); paint3D(); paintResults(); paintCut(); paintWiring(); paintPorts();
  return R;
}

// ---------------------------------------------------------------------------------------------------- the 3D view
let view = null;
function paint3D() {
  if (!view || !res) return;
  const L = res.L;
  view.show(L, [
    { p: [L.W / 2, -0.035 * L.H - 0.02, 0], text: `W ${cutLen(L.W)}` },
    { p: [-0.03, L.H / 2, 0], text: `H ${cutLen(L.H)}` },
    { p: [L.W + 0.03, 0, L.D / 2], text: L.Dt < L.D ? `D ${cutLen(L.D)} / ${cutLen(L.Dt)}` : `D ${cutLen(L.D)}` },
  ]);
  const n = $("bx-3d-note");
  if (n) n.textContent = `${fmt("vol", L.outside)} outside · ${L.net.length > 1 ? L.net.map((v) => fmt("vol", v)).join(" + ") : fmt("vol", L.net[0])} net`;
}

// ---------------------------------------------------------------------------------------------------- results
const TYPE_INFO = {
  sealed: "Tight, accurate bass in a small box. Rolls off gently, so it blends well with a car's cabin gain.",
  ported: "Louder and deeper than sealed around the tuning, from a bigger box with a port. The most popular for car audio.",
  bp4: "The sub fires into a ported chamber, with a sealed chamber behind it: all the sound comes out of the port. Loud in a band, very protected.",
  bp6: "Both chambers ported: wide, loud bandpass bass. The hardest to build right; the numbers matter.",
};
function tile(label, value, note, cls = "") { const t = h("div", "bx-tile " + cls); t.append(h("small", "", label), h("b", "", value)); if (note) t.append(h("span", "", note)); return t; }
function paintResults() {
  const R = res, { drv, L, sim } = R, tiles = $("bx-tiles");
  if (!tiles) return;
  tiles.replaceChildren();
  const xs = sim.f.map((f, i) => (f >= R.fmin && f <= 200 ? sim.x[i] : 0)), xi = xs.indexOf(Math.max(...xs)), xpk = xs[xi];
  const gain = (i) => sim.spl[i] + cabin(sim.f[i]);
  // volumes and tunings
  if (L.net.length === 1) tiles.append(tile("Net volume", fmt("vol", L.net[0]), `${fmt("vol", L.gross[0])} inside`));
  else tiles.append(tile(st.type === "bp4" ? "Sealed chamber" : "Rear chamber", fmt("vol", L.net[0]), "net, behind the sub"), tile(st.type === "bp4" ? "Ported chamber" : "Front chamber", fmt("vol", L.net[1]), "net, the sub fires into it"));
  if (st.type === "sealed") {
    const q = M.sealedQ(drv, st.count, L.net[0]);
    tiles.append(tile("Qtc", q.qtc.toFixed(2), q.qtc < 0.6 ? "deep, smooth" : q.qtc < 0.75 ? "flat" : q.qtc < 0.95 ? "punchy" : "boomy"), tile("Resonance", `${q.fc.toFixed(1)} Hz`, "Fc"));
  } else L.ports.forEach((p) => tiles.append(tile(L.ports.length > 1 ? cap(M.portName(st, p)) + " tuning" : "Tuning", `${p.fb.toFixed(1)} Hz`, `${M.portName(st, p) === "port" ? "port" : M.portName(st, p)} ${cutLen(p.len)} long`)));
  if (st.type === "sealed" || st.type === "ported") {
    const ref = sim.ref, base = sim.spl.map((v, i) => v + cabin(sim.f[i]));
    const f3 = M.cutoff({ f: sim.f, spl: base }, ref), f10 = M.cutoff({ f: sim.f, spl: base }, ref, 10);
    tiles.append(tile("Low end (−3 dB)", f3 ? `${f3.toFixed(1)} Hz` : "under 10 Hz", f10 ? `−10 dB at ${f10.toFixed(0)} Hz` : st.cab ? "with cabin gain" : ""));
  } else {
    const b = M.band({ f: sim.f, spl: sim.spl.map((v, i) => v + cabin(sim.f[i])) });
    tiles.append(tile("Passband (−3 dB)", `${b.lo ? b.lo.toFixed(0) : "<10"}–${b.hi ? b.hi.toFixed(0) : ">300"} Hz`, `peak at ${b.fpeak.toFixed(0)} Hz`), tile("Gain", `${b.peak - sim.ref >= 0 ? "+" : ""}${(b.peak - sim.ref).toFixed(1)} dB`, "over the sub alone"));
  }
  // loudness, cone travel, port air
  let loud = 0, lf = 0;
  for (let i = 0; i < sim.f.length; i++) if (sim.f[i] >= 25 && sim.f[i] <= 80) { const v = gain(i) + Math.min(0, 20 * Math.log10(drv.xmax / sim.x[i])); if (v > loud) { loud = v; lf = sim.f[i]; } }
  tiles.append(tile("Loudest (1 m)", `${loud.toFixed(1)} dB`, `at ${lf.toFixed(0)} Hz, ${st.power} W${st.cab ? ", in the car" : ""}`));
  const over = xpk > drv.xmax;
  tiles.append(tile("Cone travel", `${(xpk * 1000).toFixed(1)} mm`, `Xmax ${(drv.xmax * 1000).toFixed(1)} mm · at ${sim.f[xi].toFixed(0)} Hz`, over ? "bad" : xpk > drv.xmax * 0.85 ? "mid" : "good"));
  L.ports.forEach((p, i) => {
    let v = 0; for (let k = 0; k < sim.f.length; k++) if (sim.f[k] >= R.fmin) v = Math.max(v, sim.vel[i][k]);
    tiles.append(tile(L.ports.length > 1 ? cap(M.portName(st, p)) + " air" : "Port air speed", `${v.toFixed(1)} m/s`, `${fmt("area", p.S)} port · ${(p.S / IN / IN / (L.net[p.k] / FT3)).toFixed(1)} in²/ft³`, v > 30 ? "bad" : v > 17 ? "mid" : "good"));
  });
  tiles.append(tile("Power", `${st.power} W`, `${Math.round(st.power / st.count)} W per sub · rated ${drv.pe} W`, st.power / st.count > drv.pe * 1.25 ? "bad" : ""));

  // what to watch out for
  const W = R.L.warn.map(warnUnits), ok = [];
  if (R.fitFail) W.unshift(`Couldn't size the box: no ${({ w: "width", h: "height", d: "depth" })[st.solve]} gives ${targets().map((v) => fmt("vol", v)).join(" + ")} with these other measurements.`);
  if (over) {
    const pX = Math.floor(st.power * (drv.xmax / xpk) ** 2);
    W.push(`At ${st.power} W the cone travels ${(xpk * 1000).toFixed(1)} mm around ${sim.f[xi].toFixed(0)} Hz, past its ${(drv.xmax * 1000).toFixed(1)} mm Xmax: it will distort, and can be damaged. Keep it under about ${pX} W${vented() ? ", or pick a bigger box or a lower tuning" : ", or use a bigger box"}.`);
  }
  if (vented()) {
    const tn = Math.min(...L.ports.map((p) => p.fb));
    ok.push(`Use a subsonic (infrasonic) filter at about ${Math.round(tn * 0.8)} Hz: under the tuning the cone moves freely and can bottom out.`);
  }
  L.ports.forEach((p, i) => {
    let v = 0; for (let k = 0; k < sim.f.length; k++) if (sim.f[k] >= R.fmin) v = Math.max(v, sim.vel[i][k]);
    if (v > 30) W.push(`Air in the ${M.portName(st, p)} reaches ${v.toFixed(0)} m/s at full power: it will chuff (huff and whistle). Make it bigger: tap "Size the ports for clean air".`);
    else if (v > 17) ok.push(`The ${M.portName(st, p)}'s air reaches ${v.toFixed(0)} m/s at full power: fine for most, may be heard on test tones.`);
    if (p.pipe < 160) ok.push(`The ${M.portName(st, p)}'s own resonance is about ${Math.round(p.pipe)} Hz: keep the sub's low-pass under ${Math.round(p.pipe * 0.75)} Hz.`);
  });
  if (st.type === "sealed") {
    const q = M.sealedQ(drv, st.count, L.net[0]).qtc;
    if (q > 1.1) W.push(`Qtc ${q.toFixed(2)}: boomy, one-note bass. A bigger box is tighter.`);
    if (drv.ebp > 100) ok.push(`This sub's EBP is ${drv.ebp.toFixed(0)}: it's built more for a ported box.`);
  } else if (st.type === "ported" && drv.ebp < 50) ok.push(`This sub's EBP is ${drv.ebp.toFixed(0)}: it's built more for a sealed box.`);
  if (drv.guessedQms) W.push("Qes has to be bigger than Qts: Qms was taken as 8 until the sub's real Qes is entered.");
  if (st.power / st.count > drv.pe * 1.25) W.push(`${Math.round(st.power / st.count)} W per sub is well over its ${drv.pe} W rating.`);
  if (st.preset !== "custom") ok.push(`These are typical ${st.preset}-inch numbers. Enter your sub's own (on its spec sheet) for real results.`);
  const wl = $("bx-warn"); wl.replaceChildren();
  for (const w of W) { const r = h("div", "bx-w bad"); r.append(icon("i-warn"), h("span", "", w)); wl.append(r); }
  for (const w of ok) { const r = h("div", "bx-w"); r.append(icon("i-info"), h("span", "", w)); wl.append(r); }
  if (!W.length) { const r = h("div", "bx-w good"); r.append(icon("i-check"), h("span", "", "It all fits and it's within the sub's limits.")); wl.prepend(r); }
  paintChart();
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// the chart: response, cone travel, port air, impedance, group delay
const CHARTS = { spl: "Response", x: "Cone travel", vel: "Port air", z: "Impedance", gd: "Group delay" };
let hover = null;
function paintChart() {
  const cv = $("bx-chart"); if (!cv || !res) return;
  const { sim, drv, L } = res, k = st.chart === "vel" && !L.ports.length ? "spl" : st.chart;
  const r = cv.getBoundingClientRect(); if (r.width < 10) return;
  const dpr = Math.min(2, devicePixelRatio || 1); cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, pl = 38, pr = 10, pt = 10, pb = 22;
  g.clearRect(0, 0, W, H);
  const f0 = 10, f1 = 300, X = (f) => pl + ((Math.log(f) - Math.log(f0)) / (Math.log(f1) - Math.log(f0))) * (W - pl - pr);
  const series = [], guides = [];
  let unitTxt = "", dec = 0;
  if (k === "spl") {
    const main = sim.spl.map((v, i) => v + cabin(sim.f[i]));
    const max = sim.spl.map((v, i) => main[i] + Math.min(0, 20 * Math.log10(drv.xmax / sim.x[i])));
    series.push({ y: main, col: "grad", name: `${st.power} W` }, { y: max, col: "#ff6fa0", dash: true, name: "Xmax limit" });
    unitTxt = "dB"; dec = 1;
  } else if (k === "x") { series.push({ y: sim.x.map((v) => v * 1000), col: "grad", name: "travel" }); guides.push({ y: drv.xmax * 1000, label: "Xmax", col: "#ff6fa0" }); unitTxt = "mm"; dec = 1; }
  else if (k === "vel") { L.ports.forEach((p, i) => series.push({ y: sim.vel[i], col: i ? "#4fd1ff" : "grad", name: M.portName(st, p) })); guides.push({ y: 17, label: "17", col: "#ffb35c" }, { y: 30, label: "30", col: "#ff6fa0" }); unitTxt = "m/s"; dec = 1; }
  else if (k === "z") { series.push({ y: sim.z, col: "grad", name: "Ω" }); unitTxt = "Ω"; dec = 1; }
  else { series.push({ y: sim.gd.map((v) => v * 1000), col: "grad", name: "ms" }); unitTxt = "ms"; dec = 1; }
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (let i = 0; i < sim.f.length; i++) { const v = s.y[i]; if (isFinite(v) && sim.f[i] >= f0) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  for (const gd of guides) hi = Math.max(hi, gd.y * 1.1);
  if (k === "spl") { hi = Math.ceil((hi + 2) / 5) * 5; lo = hi - 40; }
  else if (k === "gd") { lo = 0; hi = Math.min(Math.max(10, Math.ceil(hi / 10) * 10), 120); }
  else { lo = 0; hi = Math.max(1, hi * 1.05); }
  const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  // grid
  g.font = "600 10px Inter, system-ui, sans-serif"; g.textBaseline = "middle";
  for (const f of [10, 20, 30, 50, 100, 200, 300]) { g.fillStyle = "rgba(255,255,255,0.07)"; g.fillRect(X(f), pt, 1, H - pt - pb); g.fillStyle = "rgba(255,255,255,0.5)"; g.textAlign = "center"; g.fillText(String(f), X(f), H - pb / 2); }
  const step = niceStep((hi - lo) / 5);
  g.textAlign = "right";
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) { g.fillStyle = "rgba(255,255,255,0.07)"; g.fillRect(pl, Y(v), W - pl - pr, 1); g.fillStyle = "rgba(255,255,255,0.5)"; g.fillText(+v.toFixed(1) + "", pl - 5, Y(v)); }
  g.save(); g.translate(10, pt + (H - pt - pb) / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.fillStyle = "rgba(255,255,255,0.4)"; g.fillText(unitTxt, 0, 0); g.restore();
  // the tunings
  for (const p of L.ports) { g.fillStyle = "rgba(79,209,255,0.35)"; g.fillRect(X(p.fb), pt, 1, H - pt - pb); }
  for (const gd of guides) { g.strokeStyle = gd.col; g.setLineDash([4, 4]); g.lineWidth = 1; g.beginPath(); g.moveTo(pl, Y(gd.y)); g.lineTo(W - pr, Y(gd.y)); g.stroke(); g.setLineDash([]); g.fillStyle = gd.col; g.textAlign = "left"; g.fillText(gd.label, pl + 4, Y(gd.y) - 7); }
  // the lines
  g.save(); g.beginPath(); g.rect(pl, pt, W - pl - pr, H - pt - pb); g.clip();
  for (const s of series) {
    if (s.col === "grad") { const gr = g.createLinearGradient(pl, 0, W - pr, 0); gr.addColorStop(0, "#2f78ff"); gr.addColorStop(0.55, "#7a4bff"); gr.addColorStop(1, "#bb4dff"); g.strokeStyle = gr; g.lineWidth = 2.4; }
    else { g.strokeStyle = s.col; g.lineWidth = 1.6; }
    g.setLineDash(s.dash ? [5, 4] : []);
    g.beginPath(); sim.f.forEach((f, i) => { const y = Math.max(-1e4, Math.min(1e4, Y(s.y[i]))); i ? g.lineTo(X(f), y) : g.moveTo(X(f), y); }); g.stroke();
  }
  g.setLineDash([]); g.restore();
  // a finger on it: the values there
  const ro = $("bx-read");
  if (hover != null) {
    const f = Math.exp(Math.log(f0) + ((hover - pl) / (W - pl - pr)) * (Math.log(f1) - Math.log(f0)));
    let i = 0; while (i < sim.f.length - 1 && sim.f[i] < f) i++;
    g.fillStyle = "rgba(255,255,255,0.6)"; g.fillRect(X(sim.f[i]), pt, 1, H - pt - pb);
    for (const s of series) { g.fillStyle = s.col === "grad" ? "#bb4dff" : s.col; g.beginPath(); g.arc(X(sim.f[i]), Y(s.y[i]), 3.5, 0, 7); g.fill(); }
    ro.textContent = `${sim.f[i].toFixed(1)} Hz · ` + series.map((s) => `${s.name}: ${s.y[i].toFixed(dec)} ${unitTxt}`).join(" · ");
  } else ro.textContent = k === "spl" ? `At 1 m, ${st.power} W${st.cab ? ", with cabin gain" : ""}. Dashed: the most it can play before the cone hits Xmax.` : k === "x" ? `Each cone's travel (peak) at ${st.power} W.` : k === "vel" ? "Peak air speed in the port. Under 17 m/s: quiet; over 30: it chuffs." : k === "z" ? "What the amp sees from each sub (voice coil as specified)." : "How late each frequency arrives. Under about 20 ms sounds tight.";
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }

// ---------------------------------------------------------------------------------------------------- cut list, wiring, saved
function paintCut() {
  const box = $("bx-cut"); if (!box || !res) return;
  const L = res.L;
  box.replaceChildren();
  const tb = h("div", "bx-cuts");
  for (const c of L.cut) {
    const r = h("div", "bx-cutrow");
    const n = h("div", "bx-cutn"); n.append(h("b", "", c.name), c.note ? h("small", "", c.note) : "");
    r.append(h("span", "bx-cutq", `${c.n}×`), n, h("span", "bx-cutd", `${cutLen(c.a)} × ${cutLen(c.b)}${c.b2 ? ` / ${cutLen(c.b2)}` : ""}`));
    tb.append(r);
  }
  box.append(tb);
  const sheets = Math.ceil((L.area * 1.2) / (2.4384 * 1.2192));
  const t = st.units === "in" ? `${cutLen(st.t)} wood` : `${(st.t / CM * 10).toFixed(0)} mm wood`;
  box.append(h("p", "status", `${t} · about ${(L.area / (0.3048 * 0.3048)).toFixed(1)} sq ft of it: ${sheets} sheet${sheets > 1 ? "s" : ""} of 4×8 with room for the saw. Sub cutout: ${cutLen(st.drv.cutout)}${L.ports.some((p) => p.kind === "round") ? ` · port holes: ${L.ports.filter((p) => p.kind === "round").map((p) => cutLen(p.dia + 0.006)).join(", ")}` : ""}.`));
}
function paintWiring() {
  const box = $("bx-wire-list"); if (!box) return;
  const list = M.wiring(st.count, st.wire.dual, st.wire.ohms);
  const best = list.filter((o) => o.ohms >= st.wire.amp - 1e-6)[0];
  box.replaceChildren();
  for (const o of list) {
    const r = h("div", "bx-wrow" + (o === best ? " best" : "") + (o.ohms < st.wire.amp - 1e-6 ? " low" : ""));
    r.append(h("b", "", `${+o.ohms.toFixed(2)} Ω`), h("span", "", o.how + (o === best ? " · the most power your amp can safely give" : o.ohms < st.wire.amp - 1e-6 ? " · too low for your amp" : "")));
    box.append(r);
  }
}
function savedList() { try { return JSON.parse(localStorage.getItem(SAVED) || "[]"); } catch { return []; } }
function paintSaved() {
  const box = $("bx-saved"); if (!box) return;
  const list = savedList();
  box.replaceChildren();
  if (!list.length) { box.append(h("p", "status", "Nothing saved yet.")); return; }
  list.forEach((s, i) => {
    const r = h("div", "bx-srow");
    const n = h("button", "bx-sname"); n.type = "button"; n.append(h("b", "", s.name), h("small", "", s.what));
    n.onclick = () => { const d = defaults(); st = { ...d, ...s.st, drv: { ...d.drv, ...s.st.drv }, port: { ...d.port, ...s.st.port }, port2: { ...d.port2, ...s.st.port2 }, wire: { ...d.wire, ...s.st.wire } }; paintAll(); toast(`Opened ${s.name}`); $("view-box").scrollTo({ top: 0, behavior: "smooth" }); };
    const del = h("button", "btn small bx-sdel"); del.type = "button"; del.setAttribute("aria-label", `Delete ${s.name}`); del.append(icon("i-trash"));
    del.onclick = () => { if (!confirm(`Delete "${s.name}"?`)) return; const l = savedList(); l.splice(i, 1); try { localStorage.setItem(SAVED, JSON.stringify(l)); } catch {} paintSaved(); };
    r.append(n, del); box.append(r);
  });
}
function describe() {
  const L = res.L, T = { sealed: "Sealed", ported: "Ported", bp4: "4th order bandpass", bp6: `6th order bandpass (${st.series ? "series" : "parallel"})` }[st.type];
  return `${st.count}× ${st.preset === "custom" ? "sub" : st.preset + "″"} · ${T} · ${L.net.map((v) => fmt("vol", v)).join(" + ")}${L.ports.length ? " · " + L.ports.map((p) => p.fb.toFixed(0) + " Hz").join(" / ") : ""}`;
}
/** The whole build as text: to copy, or to send. */
function sheet() {
  const { L, sim } = res, lines = [`FifTeam Media sub box: ${describe()}`, ""];
  lines.push(`Outside: ${cutLen(L.W)} wide × ${cutLen(L.H)} tall × ${cutLen(L.D)} deep${L.Dt < L.D ? ` (${cutLen(L.Dt)} at the top)` : ""}, ${cutLen(st.t)} wood${st.dbl ? ", double front" : ""}`);
  L.net.forEach((v, k) => lines.push(`${L.net.length > 1 ? (k ? "Front chamber" : "Rear chamber") : "Box"}: ${fmt("vol", v)} net (${fmt("vol", L.gross[k])} inside)`));
  for (const p of L.ports) lines.push(`${cap(M.portName(st, p))}: ${p.kind === "slot" ? `slot ${cutLen(p.sw)} × ${cutLen(L.Hi)}` : `${p.n}× ${cutLen(p.dia)} round`}, ${cutLen(p.len)} long${p.bend ? " (bent along the back)" : ""}, tuned to ${p.fb.toFixed(1)} Hz`);
  lines.push("", "Cut list:");
  for (const c of L.cut) lines.push(`  ${c.n}× ${c.name}: ${cutLen(c.a)} × ${cutLen(c.b)}${c.b2 ? ` / ${cutLen(c.b2)}` : ""}${c.note ? ` (${c.note})` : ""}`);
  lines.push("", `Sub cutout ${cutLen(st.drv.cutout)}. Power ${st.power} W. Peak cone travel ${(Math.max(...sim.x.filter((x, i) => sim.f[i] >= res.fmin && sim.f[i] <= 200)) * 1000).toFixed(1)} mm (Xmax ${(st.drv.xmax * 1000).toFixed(1)} mm).`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------- painting the parts that change
function paintPresets() { document.querySelectorAll("#bx-presets .chip").forEach((c) => c.classList.toggle("on", c.dataset.k === st.preset)); }
function paintDesign() {
  const d = $("bx-design"); if (!d) return;
  for (const k of ["sealed", "ported", "bp4", "bp6"]) d.querySelector(`[data-t="${k}"]`).hidden = st.type !== k;
  document.querySelectorAll("#bx-qtc .chip").forEach((c) => c.classList.toggle("on", Math.abs(+c.dataset.k - st.qtc) < 0.005));
  document.querySelectorAll("#bx-fbp .chip").forEach((c) => c.classList.toggle("on", c.dataset.k !== "flat" && Math.abs(+c.dataset.k - st.fbP) < 0.05));
  document.querySelectorAll("#bx-s4 .chip").forEach((c) => c.classList.toggle("on", Math.abs(+c.dataset.k - st.s4) < 0.005));
  document.querySelectorAll("#bx-g4 .chip").forEach((c) => c.classList.toggle("on", Math.abs(+c.dataset.k - st.g4) < 0.05));
  const drv = res && res.drv;
  if (drv) $("bx-drv-note").textContent = `Qms ${drv.qms.toFixed(2)} · BL ${drv.bl.toFixed(1)} T·m · Mms ${(drv.mms * 1000).toFixed(0)} g · ${drv.sens.toFixed(1)} dB at 2.83 V · EBP ${drv.ebp.toFixed(0)} (${drv.ebp < 50 ? "sealed" : drv.ebp > 100 ? "ported" : "either box"})`;
  $("bx-solve-row").hidden = st.fixed;
  $("bx-split-row").hidden = !st.fixed || (st.type !== "bp4" && st.type !== "bp6");
  $("bx-split").value = Math.round(st.split * 100); $("bx-split-v").textContent = `${Math.round(st.split * 100)}% / ${100 - Math.round(st.split * 100)}%`;
  document.querySelectorAll(".bx-target").forEach((e) => (e.hidden = st.fixed));
  $("bx-series").hidden = st.type !== "bp6";
}
function paintPorts() {
  const box = $("bx-ports"); if (!box || !res) return;
  const L = res.L;
  $("bx-port-sec").hidden = !L.ports.length;
  for (const key of ["port", "port2"]) {
    const el = $("bx-" + key), p = L.ports.find((q) => q.key === key), P = st[key];
    el.hidden = !p;
    if (!p) continue;
    el.querySelector(".bx-pname").textContent = L.ports.length > 1 ? cap(M.portName(st, p)) : "The port";
    el.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.k === P.kind));
    el.querySelector(".bx-pslot").hidden = P.kind !== "slot"; el.querySelector(".bx-pround").hidden = P.kind !== "round";
    el.querySelector(".bx-pauto").checked = P.auto;
    el.querySelector(".bx-pinfo").textContent = `${fmt("area", p.S)} · ${cutLen(p.len)} long (${cutLen(p.lin)} inside${p.bend ? ", bent along the back" : ""}) · tuned to ${p.fb.toFixed(1)} Hz${P.kind === "slot" ? ` · ${cutLen(p.sw)} × ${cutLen(L.Hi)} slot` : ""}`;
  }
}
function paintAll() {
  document.querySelectorAll("#bx-type button").forEach((b) => b.classList.toggle("on", b.dataset.k === st.type));
  document.querySelectorAll("#bx-series button").forEach((b) => b.classList.toggle("on", b.dataset.k === (st.series ? "s" : "p")));
  document.querySelectorAll("#bx-units button").forEach((b) => b.classList.toggle("on", b.dataset.k === st.units));
  document.querySelectorAll("#bx-shape button").forEach((b) => b.classList.toggle("on", b.dataset.k === st.shape));
  document.querySelectorAll("#bx-solve button").forEach((b) => b.classList.toggle("on", b.dataset.k === st.solve));
  document.querySelectorAll("#bx-mode button").forEach((b) => b.classList.toggle("on", b.dataset.k === st.view));
  document.querySelectorAll("#bx-finish button").forEach((b) => b.classList.toggle("on", b.dataset.k === st.finish));
  if (st.type === "sealed" && st.chart === "vel") st.chart = "spl";
  document.querySelectorAll("#bx-charts .chip").forEach((c) => { c.classList.toggle("on", c.dataset.k === st.chart); c.hidden = c.dataset.k === "vel" && st.type === "sealed"; });
  document.querySelectorAll("#bx-coil button").forEach((b) => b.classList.toggle("on", b.dataset.k === (st.wire.dual ? "d" : "s")));
  document.querySelectorAll("#bx-ohms .chip").forEach((c) => c.classList.toggle("on", +c.dataset.k === st.wire.ohms));
  document.querySelectorAll("#bx-amp .chip").forEach((c) => c.classList.toggle("on", +c.dataset.k === st.wire.amp));
  document.querySelectorAll("#bx-cabf .chip").forEach((c) => c.classList.toggle("on", +c.dataset.k === st.cabF));
  $("bx-cabf").hidden = !st.cab; $("bx-cab").checked = st.cab; $("bx-fixed").checked = st.fixed; $("bx-dbl").checked = st.dbl;
  $("bx-type-info").textContent = TYPE_INFO[st.type];
  $("bx-count").textContent = st.count;
  $("bx-3dcard").classList.toggle("pinned", st.pin); $("bx-pin").classList.toggle("on", st.pin);
  document.querySelectorAll("#bx-thick .chip").forEach((c) => c.classList.toggle("on", Math.abs(+c.dataset.k * IN - st.t) < 1e-4));
  paintPresets();
  if (view) { view.setMode(st.view); view.setFinish(st.finish); }
  run();
}

// ---------------------------------------------------------------------------------------------------- the screen, once
function buildScreen(root) {
  root.replaceChildren();
  const head = h("div"); head.append(h("h2", "", "Box"), h("p", "sub", "Design a sub box: the math, the port, the cut list, in 3D."));
  root.append(head);

  // the 3D view (stays at the top while you change things below, unless unpinned)
  const v3 = h("div", "card sec bx-3dcard"); v3.id = "bx-3dcard";
  const vh = h("div", "bx-3dhead");
  const mode = seg("bx-mode", [["solid", "Solid"], ["see", "See-through"], ["open", "Open top"]], st.view);
  mode.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.view = b.dataset.k; paintAll(); };
  const pin = h("button", "btn small bx-pin"); pin.id = "bx-pin"; pin.type = "button"; pin.setAttribute("aria-label", "Keep the 3D view at the top"); pin.append(icon("i-pin"));
  pin.onclick = () => { st.pin = !st.pin; paintAll(); toast(st.pin ? "3D view stays at the top" : "3D view scrolls with the page"); };
  vh.append(mode, pin);
  const stage = h("div", "bx-stage");
  const cv = h("canvas", "bx-gl"); cv.id = "bx-gl"; cv.setAttribute("aria-label", "The box in 3D: drag to turn it, pinch to zoom, double-tap to reset");
  const ov = h("canvas", "bx-ov");
  const hint = h("div", "bx-hint", "Drag to turn · pinch to zoom · double-tap to reset");
  const note = h("div", "bx-3dnote"); note.id = "bx-3d-note";
  stage.append(cv, ov, note, hint);
  v3.append(vh, stage);
  root.append(v3);

  // the box type
  const sT = section("bx-sec-type", "i-box", "Box type", "How the sub's sound gets out");
  const types = seg("bx-type", [["sealed", "Sealed"], ["ported", "Ported"], ["bp4", "4th order"], ["bp6", "6th order"]], st.type);
  types.onclick = (e) => {
    const b = e.target.closest("button"); if (!b || b.dataset.k === st.type) return;
    st.type = b.dataset.k;
    const key = st.type + (st.type === "bp6" ? (st.series ? "s" : "p") : "");
    if (!st.designed[key]) design(st.type, true);
    paintAll();
  };
  const ser = seg("bx-series", [["p", "Both ported out"], ["s", "Series (rear into front)"]], st.series ? "s" : "p");
  ser.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.series = b.dataset.k === "s"; if (!st.designed["bp6" + b.dataset.k]) design("bp6", true); paintAll(); };
  sT.append(types, ser, h("p", "status bx-info", "")); sT.lastChild.id = "bx-type-info";
  root.append(sT);

  // the sub
  const sD = section("bx-sec-sub", "i-bass", "Your sub", "Its Thiele/Small numbers, from the spec sheet");
  const pre = chips("bx-presets", [["8", "8″"], ["10", "10″"], ["12", "12″"], ["15", "15″"], ["18", "18″"], ["custom", "My sub"]], (k) => {
    if (k === "custom") { st.preset = "custom"; paintPresets(); toast("Type in your sub's numbers below"); return; }
    st.preset = k; const p = M.PRESETS[k]; Object.assign(st.drv, p); st.power = Math.round(p.pe * st.count);
    design(st.type, true); paintAll(); toast(`Typical ${k}-inch sub, box re-designed for it`);
  });
  const cnt = h("div", "row between bx-count");
  const minus = h("button", "btn small", "−"), plus = h("button", "btn small", "+"); minus.type = plus.type = "button";
  const cl = h("div", "row"); cl.append(minus, h("b", "bx-countv"), plus); cl.querySelector("b").id = "bx-count";
  const setCount = (n) => { if (n < 1 || n > 4 || n === st.count) return; st.power = Math.round((st.power / st.count) * n); st.count = n; design(st.type, true); paintAll(); toast(`${n} sub${n > 1 ? "s" : ""}: box re-designed`); };
  minus.onclick = () => setCount(st.count - 1); plus.onclick = () => setCount(st.count + 1);
  cnt.append(h("span", "label", "How many subs"), cl);
  sD.append(pre, cnt,
    grid(3, field("drv.fs", "Fs", "hz"), field("drv.qts", "Qts", "q"), field("drv.qes", "Qes", "q"),
      field("drv.vas", "Vas", "vol"), field("drv.re", "Re", "ohm"), field("drv.le", "Le", "mh", { zero: true }),
      field("drv.sd", "Sd (cone area)", "area"), field("drv.xmax", "Xmax (one way)", "mm"), field("drv.pe", "Power rating", "w")),
    h("small", "status bx-drvnote", ""),
    h("span", "label", "For fitting it in"),
    grid(3, field("drv.cutout", "Cutout", "len"), field("drv.depth", "Mounting depth", "len"), field("drv.disp", "Displacement", "vol", { zero: true })),
    grid(2, field("power", "Amp power (total RMS)", "w", { on: () => {} }), field("drv.size", "Size (frame)", "len")));
  sD.querySelector(".bx-drvnote").id = "bx-drv-note";
  root.append(sD);

  // the design
  const sG = section("bx-sec-design", "i-spark", "Design", "The volume and tuning: recommended, or your own");
  const dz = h("div", "stack bx-design"); dz.id = "bx-design";
  const blk = (t, ...kids) => { const b = h("div", "bx-dblock"); b.dataset.t = t; b.append(...kids); return b; };
  const tgt = (el) => { el.classList.add("bx-target"); return el; };
  dz.append(
    blk("sealed",
      h("span", "label", "Qtc: how it sounds"),
      chips("bx-qtc", [["0.577", "0.58 deep"], ["0.707", "0.71 flat"], ["0.8", "0.8 punchy"], ["0.9", "0.9 tight box"], ["1", "1.0 small"]], (k) => { st.qtc = +k; design("sealed", true); paintAll(); }),
      tgt(grid(2, field("vbS", "Net volume", "vol"), field("qtc", "Qtc", "q", { on: () => (st.vbS = M.sealedVolume(drvNow(), st.count, st.qtc) || st.vbS) })))),
    blk("ported",
      h("span", "label", "Tuning: lower is deeper, higher is louder"),
      chips("bx-fbp", [["28", "28 Hz low"], ["32", "32 Hz music"], ["36", "36 Hz loud"], ["40", "40 Hz SPL"], ["flat", "Textbook flat"]], (k) => {
        if (k === "flat") { const f = M.ventedFlat(drvNow(), st.count); st.fbP = +f.fb.toFixed(1); st.vbP = f.V; st.designed.ported = true; compute(); sizePorts(true); }
        else { st.fbP = +k; design("ported", true); }
        paintAll();
      }),
      grid(2, tgt(field("vbP", "Net volume", "vol")), field("fbP", "Tuning", "hz"))),
    blk("bp4",
      h("span", "label", "Shape: flat and wide, or more output"),
      chips("bx-s4", [["0.7", "Flat (S 0.7)"], ["0.6", "S 0.6"], ["0.5", "Punchy (S 0.5)"]], (k) => { st.s4 = +k; design("bp4", true); paintAll(); }),
      h("span", "label", "Gain over the sub alone (more gain, narrower band)"),
      chips("bx-g4", [["0", "+0 dB"], ["2", "+2 dB"], ["4", "+4 dB"], ["6", "+6 dB"]], (k) => { st.g4 = +k; design("bp4", true); paintAll(); }),
      grid(3, tgt(field("vr4", "Sealed chamber", "vol")), tgt(field("vf4", "Ported chamber", "vol")), field("fb4", "Tuning", "hz"))),
    blk("bp6",
      h("span", "label", "The band it should play"),
      grid(2, field("lo6", "From", "hz"), field("hi6", "To", "hz")),
      (() => { const b = h("button", "btn block", "Design it for this band"); b.type = "button"; b.prepend(icon("i-spark")); b.onclick = () => { design("bp6"); paintAll(); }; return b; })(),
      grid(2, tgt(field("vr6", "Rear chamber", "vol")), field("fr6", "Rear tuning", "hz"), tgt(field("vf6", "Front chamber", "vol")), field("ff6", "Front tuning", "hz"))),
  );
  const rec = h("button", "btn primary block", "Recommended for this sub"); rec.type = "button"; rec.prepend(icon("i-spark"));
  rec.onclick = () => { design(); paintAll(); };
  sG.append(dz, rec);
  root.append(sG);

  // the measurements
  const sM = section("bx-sec-build", "i-ruler", "Measurements", "The box's outside, the wood, what it should fit");
  const un = seg("bx-units", [["in", "Inches · ft³"], ["cm", "cm · litres"]], st.units);
  un.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.units = b.dataset.k; paintAll(); };
  const shp = seg("bx-shape", [["rect", "Box"], ["wedge", "Wedge (sloped back)"]], st.shape);
  shp.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.shape = b.dataset.k; if (st.shape === "wedge" && st.dt >= st.d) st.dt = st.d * 0.65; paintAll(); };
  const fixedSw = sw("I have exact measurements", "Keep my sizes: the volume comes from them", st.fixed, (on) => { st.fixed = on; paintAll(); });
  fixedSw.querySelector("input").id = "bx-fixed";
  const solveRow = h("div", "stack-sm"); solveRow.id = "bx-solve-row";
  const solve = seg("bx-solve", [["w", "Width"], ["h", "Height"], ["d", "Depth"]], st.solve);
  solve.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.solve = b.dataset.k; paintAll(); };
  solveRow.append(h("span", "label", "Size it to the volume by changing the"), solve);
  const ro = (k) => () => !st.fixed && st.solve === k;
  const dims = grid(3, field("w", "Width", "len", { ro: ro("w") }), field("h", "Height", "len", { ro: ro("h") }), field("d", "Depth", "len", { ro: ro("d") }),
    field("dt", "Depth at top", "len", { hide: () => st.shape !== "wedge" }));
  const thick = chips("bx-thick", [["0.5", "½″"], ["0.625", "⅝″"], ["0.75", "¾″ (18 mm)"], ["1", "1″"]], (k) => { st.t = +k * IN; paintAll(); });
  const dbl = sw("Double front (baffle)", "Two layers of wood where the sub mounts: stiffer", st.dbl, (on) => { st.dbl = on; paintAll(); });
  dbl.querySelector("input").id = "bx-dbl";
  const splitRow = h("div", "stack-sm"); splitRow.id = "bx-split-row";
  const split = h("input"); split.type = "range"; split.min = 10; split.max = 90; split.step = 1; split.id = "bx-split";
  split.oninput = () => { st.split = +split.value / 100; schedule(); };
  const sv = h("span", "val"); sv.id = "bx-split-v";
  const sl = h("div", "row between"); sl.append(h("span", "label", "Divider: rear / front chamber"), sv);
  splitRow.append(sl, split);
  const fin = seg("bx-finish", [["mdf", "MDF"], ["black", "Black carpet"], ["gray", "Gray carpet"]], st.finish);
  fin.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.finish = b.dataset.k; paintAll(); };
  sM.append(un, shp, fixedSw, solveRow, dims, h("span", "label", "Wood thickness"), thick, grid(2, field("t", "Wood", "len"), field("brace", "Bracing (volume)", "vol", { zero: true })), dbl, splitRow, h("span", "label", "Finish (for the 3D view)"), fin);
  root.append(sM);

  // the ports
  const sP = section("bx-port-sec", "i-port", "Port", "Its size; the length for the tuning is worked out");
  const ports = h("div", "stack"); ports.id = "bx-ports";
  for (const key of ["port", "port2"]) {
    const el = h("div", "stack-sm bx-pblock"); el.id = "bx-" + key;
    const kind = seg(null, [["slot", "Slot"], ["round", "Round"]], st[key].kind);
    kind.onclick = (e) => { const b = e.target.closest("button"); if (!b || b.dataset.k === st[key].kind) return; st[key].kind = b.dataset.k; compute(); sizePorts(true); const moved = reshape(); if (M.misfits(res.L)) toast(b.dataset.k === "round" ? "A round port that long can't fit straight here: a slot port can bend" : "The port still doesn't fit: see the notes under How it plays", 4000); else if (moved) toast("Box re-shaped so the port fits"); paintAll(); };
    const slot = grid(2, field(key + ".w", "Slot width", "len")); slot.classList.add("bx-pslot");
    const round = grid(2, field(key + ".dia", "Diameter (inside)", "len"), field(key + ".n", "How many", "n", { min: 1, max: 6 })); round.classList.add("bx-pround");
    const auto = sw("Length from the tuning", "Off: type the length and see the tuning", st[key].auto, (on) => { st[key].auto = on; schedule(); });
    auto.querySelector("input").classList.add("bx-pauto");
    const len = grid(2, field(key + ".len", "Length (with the wood)", "len", { ro: () => st[key].auto }));
    el.append(h("b", "bx-pname", ""), kind, slot, round, auto, len, h("small", "status bx-pinfo", ""));
    ports.append(el);
  }
  const sizeBtn = h("button", "btn block", "Size the ports for clean air"); sizeBtn.type = "button"; sizeBtn.prepend(icon("i-spark"));
  sizeBtn.onclick = () => sizePorts(false);
  sP.append(ports, sizeBtn);
  root.append(sP);

  // the results
  const sR = section("bx-sec-res", "i-chart", "How it plays", "Simulated at your amp's power, 1 metre away");
  const tiles = h("div", "bx-tiles"); tiles.id = "bx-tiles";
  const ch = chips("bx-charts", Object.entries(CHARTS), (k) => { st.chart = k; hover = null; paintAll(); });
  const cvs = h("canvas", "bx-chart"); cvs.id = "bx-chart"; cvs.setAttribute("aria-label", "Chart: touch it to read the values");
  const read = h("small", "status bx-read"); read.id = "bx-read";
  const pt = (e) => { const r = cvs.getBoundingClientRect(); hover = e.clientX - r.left; paintChart(); };
  cvs.addEventListener("pointerdown", (e) => { cvs.setPointerCapture && cvs.setPointerCapture(e.pointerId); pt(e); });
  cvs.addEventListener("pointermove", (e) => { if (e.buttons || e.pointerType !== "mouse") pt(e); });
  cvs.addEventListener("pointerleave", () => { hover = null; paintChart(); });
  const cab = sw("Cabin gain", "A car's cabin boosts the low end: 12 dB an octave under its corner", st.cab, (on) => { st.cab = on; paintAll(); });
  cab.querySelector("input").id = "bx-cab";
  const cabf = chips("bx-cabf", [["70", "Truck 70 Hz"], ["60", "Hatch 60 Hz"], ["50", "Sedan 50 Hz"], ["40", "SUV/van 40 Hz"]], (k) => { st.cabF = +k; paintAll(); });
  const warn = h("div", "stack-sm bx-warn"); warn.id = "bx-warn";
  sR.append(tiles, ch, cvs, read, cab, cabf, warn);
  root.append(sR);

  // the cut list
  const sC = section("bx-sec-cut", "i-list", "Cut list", "Every panel, ready for the saw");
  const cut = h("div", "stack-sm"); cut.id = "bx-cut";
  const copy = h("button", "btn block", "Copy the build sheet"); copy.type = "button"; copy.prepend(icon("i-share"));
  copy.onclick = async () => {
    const text = sheet();
    try { await navigator.clipboard.writeText(text); toast("Build sheet copied"); }
    catch { try { await navigator.share({ text }); } catch { toast("Couldn't copy it on this phone"); } }
  };
  sC.append(cut, copy);
  root.append(sC);

  // wiring
  const sW = section("bx-sec-wire", "i-bolt", "Wiring", "The loads your subs can make for the amp");
  const coil = seg("bx-coil", [["s", "Single voice coil"], ["d", "Dual voice coil"]], st.wire.dual ? "d" : "s");
  coil.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.wire.dual = b.dataset.k === "d"; paintAll(); };
  sW.append(coil, h("span", "label", "Each coil"), chips("bx-ohms", [["1", "1 Ω"], ["2", "2 Ω"], ["4", "4 Ω"], ["8", "8 Ω"]], (k) => { st.wire.ohms = +k; paintAll(); }),
    h("span", "label", "Lowest load your amp is stable at"), chips("bx-amp", [["0.5", "0.5 Ω"], ["1", "1 Ω"], ["2", "2 Ω"], ["4", "4 Ω"]], (k) => { st.wire.amp = +k; paintAll(); }));
  const wl = h("div", "stack-sm"); wl.id = "bx-wire-list"; sW.append(wl);
  root.append(sW);

  // saved designs
  const sS = section("bx-sec-saved", "i-save", "Saved designs", "On this phone");
  const nm = h("input", "input"); nm.placeholder = "Name this design"; nm.maxLength = 60; nm.id = "bx-name";
  const sv2 = h("button", "btn primary", "Save"); sv2.type = "button"; sv2.prepend(icon("i-save"));
  sv2.onclick = () => {
    const name = nm.value.trim() || describe();
    const l = savedList(); const i = l.findIndex((x) => x.name === name);
    const entry = { name, what: describe(), at: Date.now(), st: JSON.parse(JSON.stringify(st)) };
    if (i >= 0) l[i] = entry; else l.unshift(entry);
    try { localStorage.setItem(SAVED, JSON.stringify(l.slice(0, 40))); toast(`Saved ${name}`); nm.value = ""; } catch { toast("Couldn't save on this phone"); }
    paintSaved();
  };
  const sr = h("div", "row"); sr.append(nm, sv2);
  const list = h("div", "stack-sm"); list.id = "bx-saved";
  const reset = h("button", "btn small bx-reset", "Start over"); reset.type = "button";
  reset.onclick = () => { if (!confirm("Start a new design? (Saved designs stay.)")) return; st = defaults(); design("ported", true); paintAll(); $("view-box").scrollTo({ top: 0 }); };
  sS.append(sr, list, reset);
  root.append(sS);

  cv.addEventListener("pointerdown", () => hint.classList.add("gone"), { once: true });
  view = boxView(cv, ov);
  if (!view.webgl) hint.textContent = "Drag to turn · pinch to zoom (simple view: this phone has no 3D graphics)";
}

// ---------------------------------------------------------------------------------------------------- the pinned view and the top bar
function keepUnderBar() {
  const top = document.querySelector(".top"), card = $("bx-3dcard");
  if (!top || !card) return;
  // (sticky counts from the screen's content, under its padding for the bar: so the bar's height, less that padding)
  const fit = () => { const pad = parseFloat(getComputedStyle($("view-box")).paddingTop) || 0; card.style.setProperty("--bx-top", `${(top.classList.contains("hide") ? 0 : top.offsetHeight) - pad}px`); };
  new MutationObserver(fit).observe(top, { attributes: true, attributeFilter: ["class"] });
  fit();
}

export const box = { get state() { return st; }, get result() { return res; }, get view() { return view; }, design, run, sheet };
let built = false;
function open() {
  if (built) { view && view.redraw(); paintChart(); return; }
  built = true;
  st = load();
  buildScreen($("bx-root"));
  keepUnderBar();
  paintSaved();
  if (!st.designed.ported && st.type === "ported") design("ported", true);
  paintAll();
}
export function initBox() {
  bus.on("view", (v) => { if (v === "box") requestAnimationFrame(open); });
  addEventListener("resize", () => { if (built && location.hash === "#box") paintChart(); });
}
