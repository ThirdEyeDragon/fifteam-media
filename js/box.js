// The Box screen: a sub box designer. Pick the box (sealed, ported, 4th- or 6th-order bandpass), the sub (typical
// numbers by size, or its own spec sheet), and the design (recommended, or your own volumes and tunings); then the
// measurements: the box sizes itself to the volume (or keeps your exact measurements), works out the port, and shows
// it all live in 3D, with the simulated response, cone travel, port air speed, impedance and group delay, what to
// watch out for, the cut list and how to wire the subs. Designs can be saved.
import { $, toast, bus, openSheet, closeSheet } from "./ui.js";
import * as M from "./boxmath.js";
import { boxView, partKey } from "./box3d.js";
import { SUBS, subFrom, subName, subKey, findSub } from "./subs.js";
import { premiumNow, requirePremium, openPremium } from "./premium.js";

const KEY = "fifteam-box", SAVED = "fifteam-boxes";
const { IN, FT3, L: LTR, CM } = M;
const FR = M.freqs(10, 300, 240);

// ---------------------------------------------------------------------------------------------------- the design
function defaults() {
  const p = M.PRESETS[12];
  return {
    v: 1, units: "in", type: "ported", series: false, preset: "12",
    drv: { fs: p.fs, qts: p.qts, qes: p.qes, vas: p.vas, re: p.re, le: p.le, sd: p.sd, xmax: p.xmax, pe: p.pe, size: p.size, cutout: p.cutout, depth: p.depth, disp: p.disp, shape: "round" },
    count: 1, power: 600,
    qtc: 0.707, vbS: 1.3 * FT3,                     // sealed
    vbP: 1.75 * FT3, fbP: 32,                       // ported
    s4: 0.7, g4: 0, c4: 50, vr4: 1.3 * FT3, vf4: 0.7 * FT3, fb4: 45,
    vr6: 2.1 * FT3, fr6: 27, vf6: 0.6 * FT3, ff6: 59, lo6: 30, hi6: 80,
    shape: "rect", w: 24 * IN, h: 15 * IN, d: 16 * IN, dt: 11 * IN, t: 0.75 * IN, layers: 1, brace: 0,           // layers: the baffle (where the subs mount)
    fixed: false, solve: "w", split: 0.55,
    port: { kind: "slot", w: 1.6 * IN, dia: 4 * IN, n: 1, auto: true, len: 0 },
    port2: { kind: "slot", w: 1.5 * IN, dia: 3 * IN, n: 1, auto: true, len: 0 },
    cab: false, cabF: 50, ql: 10,
    finish: "mdf", paint: "#7a4bff", view: "solid", chart: "spl", pin: true,
    style4: "std", style6: "std",                    // bandpass styles: standard (side by side), series (6th), hallway
    lim: { w: 0, h: 0, d: 0 },                       // the space you have (0: no limit)
    gap: 1 * IN, braceMode: "std", round: true,      // space between the subs' frames; dowel bracing; rounded port bends
    sub: null, est: [], quick: null,                 // a sub from the list (its brand and model), and what its maker doesn't publish
    wire: { dual: true, ohms: 4, amp: 1 },
    fu: { "drv.vas": "cm", "drv.sd": "cm" },          // fields with their own units (as spec sheets give them: litres, cm²)
    designed: { ported: true },
  };
}
let st = null;
/** A saved (or shared) design over the defaults (older ones: their 6th-order "series" switch becomes its style). */
function merge(d, s) {
  const o = { ...d, ...s, drv: { ...d.drv, ...s.drv }, port: { ...d.port, ...s.port }, port2: { ...d.port2, ...s.port2 }, wire: { ...d.wire, ...s.wire }, designed: { ...s.designed }, fu: { ...d.fu, ...s.fu }, lim: { ...d.lim, ...s.lim } };
  if (s.series && !s.style6) o.style6 = "series";
  if (s.layers == null && s.dbl) o.layers = 2;
  o.layers = Math.max(1, Math.min(12, Math.round(+o.layers || 1)));
  delete o.dbl;
  o.count = Math.max(1, Math.min(20, o.count | 0 || 1));
  return o;
}
function load() {
  const d = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && s.v === 1) return merge(d, s);
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
const unit = (kind, path) => { const u = UNITS[kind]; return Array.isArray(u) ? u : u[(path && st.fu && st.fu[path]) || st.units]; };
const num = (kind, si, dec, path) => { const [k, , d] = unit(kind, path); const v = si / k; return +v.toFixed(dec ?? d); };
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
  const l = h("label", "bx-f"); const top = h("span", "bx-fl"); const name = h("span", "", label);
  // (a field with its own units: tap them to switch, ft³/litres or in²/cm²)
  const un = h(o.swap ? "button" : "small", o.swap ? "bx-unit" : "");
  if (o.swap) {
    un.type = "button"; un.setAttribute("aria-label", "Change the unit");
    un.onclick = (e) => { e.preventDefault(); const cur = (st.fu && st.fu[path]) || st.units; st.fu = { ...st.fu, [path]: cur === "cm" ? "in" : "cm" }; paintField(f); persist(); };
  }
  top.append(name, un);
  const inp = h("input", "input"); inp.inputMode = "decimal"; inp.autocomplete = "off"; inp.dataset.path = path;
  l.append(top, inp);
  const f = { path, kind, inp, un, o, l };
  inp.addEventListener("input", () => {
    const v = parseFloat(inp.value.replace(",", "."));
    const ok = isFinite(v) && v >= (o.min ?? 0) && (o.max == null || v <= o.max) && (o.zero || v > 0);
    inp.classList.toggle("bad", !ok);
    if (!ok) return;
    set(path, kind === "n" ? Math.round(v) : v * unit(kind, path)[0]);
    if (o.on) o.on();
    if (path.startsWith("drv.")) { st.preset = "custom"; st.sub = null; st.est = []; paintPresets(); paintSubName(); }
    schedule();
  });
  inp.addEventListener("blur", () => { inp.classList.remove("bad"); paintField(f); });
  FIELDS.push(f);
  return l;
}
function paintField(f) {
  f.un.textContent = unit(f.kind, f.path)[1] + (f.o.swap ? " ⇄" : "");
  const ro = f.o.ro ? f.o.ro() : false;
  f.inp.readOnly = ro; f.l.classList.toggle("ro", ro);
  if (f.o.hide) f.l.hidden = f.o.hide();
  if (document.activeElement === f.inp) return;
  const v = get(f.path);
  f.inp.value = v == null || !isFinite(v) ? "" : String(num(f.kind, v, f.o.dec, f.path));
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

// ---------------------------------------------------------------------------------------------------- the sub's numbers, checked
/** Numbers that can't be right for a real sub, usually a spec typed in the wrong unit (litres into ft³, cm² into
 * in²): each with what it means and a fix. A cone's moving mass per area comes out at 0.08 to 1.6 g/cm² on real subs,
 * and its cone area is close to what its frame size allows. */
function sanity() {
  const d = st.drv, out = [], sizeArea = Math.PI * (0.42 * (d.size || 0.3)) ** 2;
  const mmsPerArea = (vas, sd) => { const ws = 2 * Math.PI * d.fs, cms = vas / (M.RHO * M.C * M.C * sd * sd); return (1000 / (ws * ws * cms)) / (sd / (CM * CM)); };
  const okMass = (vas, sd) => { const g = mmsPerArea(vas, sd); return g > 0.08 && g < 1.6; };
  const say = (path, kind, si) => `${num(kind, si, undefined, path)} ${unit(kind, path)[1]}`;
  // the same number read in the other unit (either way: ft³ <-> litres, in² <-> cm²), if that makes it right
  const NAME = { vol: { in: "ft³", cm: "litres" }, area: { in: "in²", cm: "cm²" } };
  const swapFix = (path, kind, si, ok) => {
    const k = UNITS[kind].in[0] / UNITS[kind].cm[0];
    for (const [cand, sys] of [[si / k, "cm"], [si * k, "in"]]) if (ok(cand)) {
      const shown = +(cand / UNITS[kind][sys][0]).toFixed(2);
      return { label: `Use ${shown} ${UNITS[kind][sys][1]}`, name: NAME[kind][sys], fix: () => { set(path, cand); st.fu = { ...st.fu, [path]: sys }; st.preset = "custom"; paintPresets(); schedule(); } };
    }
    return null;
  };
  // the cone area against the frame
  const fitsFrame = (sd) => sd / sizeArea > 0.35 && sd / sizeArea < 2.2;
  if (!fitsFrame(d.sd)) {
    const fix = swapFix("drv.sd", "area", d.sd, fitsFrame);
    out.push({ msg: `Sd ${say("drv.sd", "area", d.sd)} doesn't fit a ${((d.size || 0.3) / IN).toFixed(1)}″ sub (it'd be about ${num("area", sizeArea, undefined, "drv.sd")} ${unit("area", "drv.sd")[1]}).${fix ? ` It looks like a number in ${fix.name}.` : " Check the size and Sd."}`, ...fix });
    return out;
  }
  // Vas: the cone mass it implies
  if (!okMass(d.vas, d.sd)) {
    const g = mmsPerArea(d.vas, d.sd), fix = swapFix("drv.vas", "vol", d.vas, (v) => okMass(v, d.sd));
    out.push({ msg: `Vas ${say("drv.vas", "vol", d.vas)} can't be right with these numbers: the cone would weigh ${Math.round(g * d.sd / (CM * CM))} g.${fix ? ` It looks like a number in ${fix.name}.` : " Check Vas, Fs and Sd."}`, ...fix });
  }
  if (d.xmax < 0.003) out.push({ msg: `Xmax ${(d.xmax * 1000).toFixed(1)} mm is very small for a sub. If the spec sheet gives it in inches, that's ${(d.xmax * 1000 * 25.4).toFixed(1)} mm.`, label: `Use ${(d.xmax * 1000 * 25.4).toFixed(1)} mm`, fix: () => { st.drv.xmax = d.xmax * 25.4; st.preset = "custom"; paintPresets(); schedule(); } });
  if (d.fs < 12 || d.fs > 120) out.push({ msg: `Fs ${d.fs} Hz is outside what subs have (about 15 to 60 Hz).` });
  if (d.qts < 0.15 || d.qts > 1.5) out.push({ msg: `Qts ${d.qts} is outside what subs have (about 0.2 to 1).` });
  return out;
}
function paintCheck() {
  const box = $("bx-drv-check"); if (!box) return;
  box.replaceChildren();
  for (const c of sanity()) {
    const r = h("div", "bx-w bad"); r.append(icon("i-warn"));
    const t = h("span", "", c.msg); r.append(t);
    if (c.fix) { const b = h("button", "btn small bx-fix", c.label); b.type = "button"; b.onclick = () => { c.fix(); toast("Fixed: " + c.label.replace(/^Use /, "")); }; r.append(b); }
    box.append(r);
  }
}

// ---------------------------------------------------------------------------------------------------- designs for each type
const vented = () => st.type !== "sealed";
/** The bandpass style: "std" (the chambers side by side), "series" (6th: the rear one ported into the front one) or
 * "hall" (hallway: subs on two dividers facing each other across the middle chamber, a rear chamber behind each). */
const styleOf = () => (st.type === "bp6" ? st.style6 : st.type === "bp4" ? st.style4 : "std");
const isSeries = () => st.type === "bp6" && st.style6 === "series";
const designKey = (type = st.type) => type + (type === "bp6" ? ":" + st.style6 : type === "bp4" ? ":" + st.style4 : "");
const drvNow = () => M.driver(st.drv);
/** Recommended volumes and tunings for the box type (and the sub, and how many). */
function design(type = st.type, quiet = false) {
  const d = drvNow(), N = st.count;
  if (type === "sealed") {
    if (st.qtc <= d.qts * 1.02) st.qtc = Math.max(0.707, +(d.qts * 1.2).toFixed(2));
    st.vbS = M.sealedVolume(d, N, st.qtc);
  } else if (type === "ported") st.vbP = M.ventedVolumeFor(d, N, st.fbP);
  else if (type === "bp4") { const b = M.bp4At(d, N, st.s4, st.c4); st.vr4 = b.vr; st.vf4 = b.vf; st.fb4 = +b.fb.toFixed(1); }
  else { const b = M.bp6Design(d, N, isSeries(), st.lo6, st.hi6); st.vr6 = b.vr; st.fr6 = +b.fr.toFixed(1); st.vf6 = b.vf; st.ff6 = +b.ff.toFixed(1); }
  st.designed[designKey(type)] = true;
  // the ports: sized for the air flow at this power (after a first look)
  // (from the same neutral ports every time, so the same sub always gets the same design)
  if (type !== "sealed") {
    for (const P of [st.port, st.port2]) { P.auto = true; if (P.autoRound) { P.kind = "slot"; P.autoRound = false; } P.w = 1.5 * IN; P.dia = 4 * IN; P.n = 1; }
    compute(true); sizePorts(true, portRule);
  }
  grown = false;
  let moved = reshape();
  // (a port along a hallway's top grows with the middle chamber's width: sized again for the new box, and shaped again)
  if (type !== "sealed") moved = finishPorts() || moved;
  if (grown) toast(`${st.count > 1 ? "These subs need" : "This sub needs"} a bigger box than that to fit: ${fmt("vol", st.vbS)}, Qtc ${st.qtc.toFixed(2)}`, 4500);
  else if (sanity().length) toast("Check your sub's numbers first: one looks like the wrong unit (see Your sub)", 4500);
  else if (!quiet) toast(M.misfits(res.L) ? "Designed, but something doesn't fit: see the notes under How it plays" : moved ? "Designed for this sub, and re-sized so it all fits" : "Designed for this sub", 3500);
}
/** A good shape for the design (unless the measurements are your own): the most compact box where the sub and the
 * ports fit. If a port still can't fit, it's made a little smaller (down to 10 in² per ft³) and the box shaped again.
 * Returns whether the measurements changed. */
function reshape() {
  if (st.fixed) return false;
  const before = [st.w, st.h, st.d].join();
  for (let k = 0; k < 7; k++) {
    const f = M.shapeBox(spec(), st.solve, ...targets(), st.lim);
    if (f) { st.w = f.w; st.h = f.h; st.d = f.d; if (st.shape === "wedge") st.dt = f.dt; if (f.split != null) st.split = f.split; if (f.grow) setTargets(f.grow); }
    const R = compute(true);
    if (!M.misfits(R.L) || !R.L.ports.length) break;
    let shrunk = false;
    R.L.ports.forEach((p) => {
      const P = p.key === "port2" ? st.port2 : st.port, floor = 10 * (R.L.net[p.k] / FT3) * IN * IN;
      if (p.S * 0.85 < floor) return;
      if (P.kind === "slot") P.w *= 0.85; else P.dia *= Math.sqrt(0.85);
      shrunk = true;
    });
    if (!shrunk) break;
    if (k === 6) { const g = M.shapeBox(spec(), st.solve, ...targets(), st.lim); if (g) { st.w = g.w; st.h = g.h; st.d = g.d; if (st.shape === "wedge") st.dt = g.dt; if (g.split != null) st.split = g.split; } compute(true); }
  }
  return before !== [st.w, st.h, st.d].join();
}
/** The ports' last sizing for the box as it's now shaped (a hallway's top port grows with the middle chamber, say),
 * then their last look; if that moved something so it no longer fits, the box is shaped once more round it. */
function finishPorts() {
  compute(true); sizePorts(true, portRule); let moved = reshape(); compute(true); sizePorts(true, portRule, true);
  if (M.misfits(compute(true).L)) { moved = reshape() || moved; compute(true); sizePorts(true, portRule, true); }
  compute(true);
  return moved;
}
/** Port sizes for the air flow at the power used: by default under 26 m/s, between 10 and 24 in² per ft³ (a quick
 * build can ask for more air, or less). The area is shared between a port's copies (a hallway's two rear ports). */
let portRule = { v: 26, lo: 10, hi: 24 };
function sizePorts(quiet, rule = portRule, capOnly = false) {
  // (capOnly: the finished box's last look; only then may a too-small slot become round tubes)
  const R = res || compute(true);
  R.L.ports.forEach((p, i) => {
    const P = p.key === "port2" ? st.port2 : st.port;
    // (capOnly: kept as it is, only made bigger if it's too small to reach the tuning)
    let S = capOnly ? p.S : M.portAreaFor(R.sim, i, R.L.net[p.k], rule.v, R.fmin, rule.lo, rule.hi);
    // (a port must come out at least 2″ longer than the wood it starts in: one that would be shorter is too small to
    // reach the tuning in that much air, so it's made bigger, up to 40 in² per ft³)
    const V = R.L.net[p.k], one = (A) => (P.kind === "slot" ? A / p.copies : A / p.copies / P.n);
    const top = 40 * (V / FT3) * IN * IN;
    while (S < top && M.lenFor(V, S, one(S), p.fbWant) < p.through + 2 * IN) S *= 1.1;
    S /= p.copies;
    // (a slot under ⅜″ is no good to build: a port that small is a round tube, or a few)
    if (capOnly && P.kind === "slot" && S / p.span < 0.3 * IN) { P.autoRound = true; P.kind = "round"; P.n = Math.max(1, Math.min(4, Math.round(S / (Math.PI * (2 * IN) ** 2)))); }
    // (a hallway's top port: no deeper than 30% of the inside's height, or it crowds the subs off the dividers)
    if (P.kind === "slot") P.w = p.top ? Math.max(0.3 * IN, Math.min(S / p.span, 0.3 * R.L.Hi)) : S / p.span;
    if (p.center) P.w = Math.min(P.w, Math.max(0.5 * IN, p.xb - p.xa - 2 * R.L.t - 3 * IN));   // (a hallway's: room for the cones each side)
    else P.dia = Math.max(1.25 * IN, 2 * Math.sqrt(S / P.n / Math.PI));
  });
  if (!quiet) { toast("Port sized for clean air flow"); schedule(); }
}

// ---------------------------------------------------------------------------------------------------- quick builds
/** Whole designs in one tap, each for a kind of bass, worked out for the sub picked (its Fs moves the tunings). */
const QUICK = [
  ["daily", "Daily", "Ported, flat and deep: about 32 Hz, the flattest box there, quiet port", { type: "ported", fb: (fs) => clamp(fs, 30, 34), vol: 1, rule: { v: 24, lo: 12, hi: 18 } }],
  ["deep", "Deep", "Ported low: about 28 Hz in a bigger box, for the lowest notes", { type: "ported", fb: (fs) => clamp(fs * 0.85, 25, 29), vol: 1, rule: { v: 24, lo: 12, hi: 18 } }],
  ["loud", "Loud", "Ported higher: about 38 Hz, louder where most music hits, a big port", { type: "ported", fb: (fs) => clamp(fs * 1.2, 36, 42), vol: 1.1, rule: { v: 22, lo: 14, hi: 20 } }],
  ["windy", "Windy", "The most air out of the port: a big box at about 33 Hz with a huge port (18 to 30 in² per ft³), so you feel it move", { type: "ported", fb: (fs) => clamp(fs, 31, 35), vol: 1.25, rule: { v: 15, lo: 18, hi: 30 } }],
  ["spl", "SPL", "Built for numbers: tuned high (about 46 Hz) in a tight box, a big port", { type: "ported", fb: (fs) => clamp(fs * 1.45, 44, 52), vol: 0.9, rule: { v: 20, lo: 16, hi: 26 } }],
  ["compact", "Compact", "Sealed and small: tight, punchy (Qtc 0.85), fits anywhere", { type: "sealed", qtc: 0.85 }],
  ["sq", "SQ", "Sealed and accurate: flat (Qtc 0.71), for sound quality", { type: "sealed", qtc: 0.707 }],
  ["band", "Bandpass", "4th order around 50 Hz: loud in its band, the subs protected inside", { type: "bp4", style: "std", s4: 0.6, c4: 50, rule: { v: 24, lo: 12, hi: 22 } }],
  ["hall", "Hallway", "6th order hallway: subs facing each other into a ported middle chamber, both rear chambers ported, 30–75 Hz", { type: "bp6", style: "hall", lo: 30, hi: 75, rule: { v: 24, lo: 12, hi: 22 } }],
];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function quickBuild(key) {
  const q = QUICK.find((x) => x[0] === key); if (!q) return;
  const o = q[3], d = drvNow();
  st.quick = key; st.type = o.type; st.fixed = false;
  if (o.type === "sealed") st.qtc = Math.max(o.qtc, +(d.qts * 1.15).toFixed(2));
  if (o.type === "bp4") { st.style4 = o.style; st.s4 = o.s4; st.c4 = Math.round(clamp(o.c4, d.fs * 1.15, 65)); }
  if (o.type === "bp6") { st.style6 = o.style; st.lo6 = o.lo; st.hi6 = o.hi; }
  if (o.type === "ported") st.fbP = Math.round(o.fb(d.fs));
  portRule = o.rule || { v: 26, lo: 10, hi: 24 };
  st.port.kind = st.port2.kind = "slot";
  design(o.type, true);
  if (o.type === "ported" && o.vol !== 1) { st.vbP = M.ventedVolumeFor(d, st.count, st.fbP) * o.vol; finishPorts(); }
  portRule = { v: 26, lo: 10, hi: 24 };
  paintAll();
  toast(`${q[1]}: ${res.L.net.map((v) => fmt("vol", v)).join(" + ")}${res.L.ports.length ? " at " + res.L.ports.map((p) => p.fb.toFixed(0)).join("/") + " Hz" : ""}`, 3500);
}
/** The design's volumes, set (a box grown to hold the subs): a sealed box's Qtc follows. */
function setTargets(v) {
  if (st.type === "sealed") { st.vbS = v[0]; st.qtc = +M.sealedQ(drvNow(), st.count, v[0]).qtc.toFixed(3); grown = true; }
  else if (st.type === "ported") st.vbP = v[0];
  else if (st.type === "bp4") { st.vr4 = v[0]; st.vf4 = v[1]; }
  else { st.vr6 = v[0]; st.vf6 = v[1]; }
}
let grown = false;
const targets = () => (st.type === "sealed" ? [st.vbS] : st.type === "ported" ? [st.vbP] : st.type === "bp4" ? [st.vr4, st.vf4] : [st.vr6, st.vf6]);
function spec() {
  const P1 = { ...st.port, fb: st.type === "ported" ? st.fbP : st.type === "bp4" ? st.fb4 : st.ff6 };
  const P2 = { ...st.port2, fb: st.fr6 };
  return {
    type: st.type, series: isSeries(), style: styleOf(), shape: st.shape, gap: st.gap, braceMode: st.braceMode, round: st.round, power: st.power, w: st.w, h: st.h, d: st.d, dt: Math.min(st.dt, st.d), t: st.t, layers: st.layers, brace: st.brace, count: st.count,
    sub: { size: st.drv.size, cutout: st.drv.cutout, depth: st.drv.depth, disp: st.drv.disp, pe: st.drv.pe, xmax: st.drv.xmax, shape: st.drv.shape }, port: P1, port2: P2, split: st.split,
  };
}

// ---------------------------------------------------------------------------------------------------- working it out
let res = null;
function compute(lite = false) {
  const drv = drvNow();
  let B = spec(), fitFail = false;
  if (!st.fixed) {
    const [a, b] = targets();
    const f = M.fitBox(B, st.solve, a, b);
    if (f) { B = f; st[st.solve] = f[st.solve]; if (st.solve === "d" && st.shape === "wedge") st.dt = f.dt; if (f.split != null) st.split = f.split; }
    else fitFail = true;
  }
  const L = M.layout(B, false, lite);                                // (lite: working it out, no dowels placed yet)
  L.ports.forEach((p) => { const P = p.key === "port2" ? st.port2 : st.port; if (P.auto) P.len = p.len; });
  const sim = M.simulate({ drv, count: st.count, power: st.power, type: st.type, series: isSeries(), V: L.net, ports: L.ports.map((p) => ({ S: p.S, S1: p.S1, len: p.len })), ql: st.ql }, FR);
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
  paintFields(); paintDesign(); paintCheck(); paint3D(); paintResults(); paintCut(); paintWiring(); paintPorts(); paintBracing();
  return R;
}

/** What the bracing does (or would): the dowels, and the longest span any panel is left with. */
function paintBracing() {
  const el = $("bx-brace-info"); if (!el || !res) return;
  const b = res.L.bracing;
  el.textContent = b.mode === "off"
    ? `The longest unsupported panel span is ${cutLen(b.span)}; at ${st.power} W this wood is good for about ${cutLen(b.Lmax)}.${b.span > b.Lmax ? " Brace it, or the panels flex and you lose output." : " No bracing needed."}`
    : b.count ? `${b.count} dowel${b.count > 1 ? "s" : ""} (${cutLen(2 * b.r)} round), so no panel spans more than about ${cutLen(b.Lmax)} unsupported${b.dropped ? `; ${b.dropped} had nowhere clear to go` : ""}. Their room is taken out of the volume.`
    : `No panel spans more than ${cutLen(b.Lmax)}: no bracing needed.`;
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
  "bp4:hall": "Hallway: the subs face each other on two dividers, firing into a ported middle chamber, a sealed chamber behind each. Loud and tight in a band.",
  "bp6:hall": "Hallway: the subs face each other on two dividers into a ported middle chamber, and the chambers behind them are ported too. The SPL wall layout.",
  "bp6:series": "Series: the rear chamber ports into the front one, and only the front one ports out. A smooth, wide band.",
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
  else if (L.hall) tiles.append(tile(st.type === "bp4" ? "Sealed chambers" : "Rear chambers", fmt("vol", L.net[0]), "net, both, behind the subs"), tile("Middle chamber", fmt("vol", L.net[1]), "net, the subs fire into it"));
  else tiles.append(tile(st.type === "bp4" ? "Sealed chamber" : "Rear chamber", fmt("vol", L.net[0]), "net, behind the sub"), tile(st.type === "bp4" ? "Ported chamber" : "Front chamber", fmt("vol", L.net[1]), "net, the sub fires into it"));
  if (st.type === "sealed") {
    const q = M.sealedQ(drv, st.count, L.net[0]);
    tiles.append(tile("Qtc", q.qtc.toFixed(2), q.qtc < 0.6 ? "deep, smooth" : q.qtc < 0.75 ? "flat" : q.qtc < 0.95 ? "punchy" : "boomy"), tile("Resonance", `${q.fc.toFixed(1)} Hz`, "Fc"));
  } else L.ports.forEach((p) => tiles.append(tile(L.ports.length > 1 ? cap(M.portName(spec(), p)) + " tuning" : "Tuning", `${p.fb.toFixed(1)} Hz`, `${M.portName(spec(), p) === "port" ? "port" : M.portName(spec(), p)} ${cutLen(p.len)} long`)));
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
    tiles.append(tile(L.ports.length > 1 ? cap(M.portName(spec(), p)) + " air" : "Port air speed", `${v.toFixed(1)} m/s`, `${fmt("area", p.S)} port · ${(p.S / IN / IN / (L.net[p.k] / FT3)).toFixed(1)} in²/ft³`, v > 30 ? "bad" : v > 17 ? "mid" : "good"));
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
    if (v > 30) W.push(`Air in the ${M.portName(spec(), p)} reaches ${v.toFixed(0)} m/s at full power: it will chuff (huff and whistle). Make it bigger: tap "Size the ports for clean air".`);
    else if (v > 17) ok.push(`The ${M.portName(spec(), p)}'s air reaches ${v.toFixed(0)} m/s at full power: fine for most, may be heard on test tones.`);
    if (p.pipe < 160) ok.push(`The ${M.portName(spec(), p)}'s own resonance is about ${Math.round(p.pipe)} Hz: keep the sub's low-pass under ${Math.round(p.pipe * 0.75)} Hz.`);
  });
  if (st.type === "sealed") {
    const q = M.sealedQ(drv, st.count, L.net[0]).qtc;
    if (q > 1.1) W.push(`Qtc ${q.toFixed(2)}: boomy, one-note bass. A bigger box is tighter.`);
    if (drv.ebp > 100) ok.push(`This sub's EBP is ${drv.ebp.toFixed(0)}: it's built more for a ported box.`);
  } else if (st.type === "ported" && drv.ebp < 50) ok.push(`This sub's EBP is ${drv.ebp.toFixed(0)}: it's built more for a sealed box.`);
  for (const c of sanity()) W.unshift(c.msg);
  // the space you have
  const big = [["w", "wide", L.W], ["h", "tall", L.H], ["d", "deep", L.D]].filter(([k, , v]) => st.lim[k] > 0 && v > st.lim[k] + 1e-4);
  if (big.length) W.unshift(`It doesn't fit your space: ${big.map(([k, word, v]) => `${cutLen(v - st.lim[k])} too ${word}`).join(", ")}. A smaller box, fewer subs, or a sealed box would fit.`);
  if (drv.guessedQms) W.push("Qes has to be bigger than Qts: Qms was taken as 8 until the sub's real Qes is entered.");
  if (st.power / st.count > drv.pe * 1.25) W.push(`${Math.round(st.power / st.count)} W per sub is well over its ${drv.pe} W rating.`);
  if (M.PRESETS[st.preset]) ok.push(`These are typical ${st.preset}-inch numbers. Pick your sub from the list, or enter its spec sheet, for real results.`);
  const dbs = st.sub && findSub(st.sub);
  if (dbs && st.est.includes("Fs")) W.push(`${subName(dbs)}: its maker doesn't publish its Fs, Qts or Vas, so this box is worked out for a typical ${dbs.size}″ sub. Check the maker's own box recommendation too, or type in its numbers if you have them.`);
  else if (dbs && st.est.length) ok.push(`${subName(dbs)}: its maker doesn't publish ${st.est.join(", ")}, so typical values for its size are used there.`);
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
  else if (k === "vel") { L.ports.forEach((p, i) => series.push({ y: sim.vel[i], col: i ? "#4fd1ff" : "grad", name: M.portName(spec(), p) })); guides.push({ y: 17, label: "17", col: "#ffb35c" }, { y: 30, label: "30", col: "#ff6fa0" }); unitTxt = "m/s"; dec = 1; }
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
  if (asm.on) { const was = asm.steps.map((x) => x.title).join(); asm.steps = assemblySteps(res.L); if (asm.steps.map((x) => x.title).join() !== was) asm.step = Math.min(asm.step, asm.steps.length - 1); showStep(asm.step, false); paintAssembly(); }
  const L = res.L;
  box.replaceChildren();
  const tb = h("div", "bx-cuts");
  for (const c of L.cut) {
    const r = h("div", "bx-cutrow");
    const n = h("div", "bx-cutn"); n.append(h("b", "", warnUnits(c.name)), c.note ? h("small", "", warnUnits(c.note)) : "");
    r.append(h("span", "bx-cutq", `${c.n}×`), n, h("span", "bx-cutd", `${cutLen(c.a)} × ${cutLen(c.b)}${c.b2 ? ` / ${cutLen(c.b2)}` : ""}`));
    tb.append(r);
  }
  box.append(tb);
  const sheets = Math.ceil((L.area * 1.2) / (2.4384 * 1.2192));
  const t = st.units === "in" ? `${cutLen(st.t)} wood` : `${(st.t / CM * 10).toFixed(0)} mm wood`;
  box.append(h("p", "status", `${t} · about ${(L.area / (0.3048 * 0.3048)).toFixed(1)} sq ft of it: ${sheets} sheet${sheets > 1 ? "s" : ""} of 4×8 with room for the saw. Sub cutout: ${cutLen(st.drv.cutout)}${st.drv.shape === "sq" ? " square" : " round"}${L.ports.some((p) => p.kind === "round") ? ` · port holes: ${L.ports.filter((p) => p.kind === "round").map((p) => cutLen(p.dia + 0.006)).join(", ")}` : ""}.`));
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
    n.onclick = () => { st = merge(defaults(), s.st); paintAll(); toast(`Opened ${s.name}`); $("view-box").scrollTo({ top: 0, behavior: "smooth" }); };
    const del = h("button", "btn small bx-sdel"); del.type = "button"; del.setAttribute("aria-label", `Delete ${s.name}`); del.append(icon("i-trash"));
    del.onclick = () => { if (!confirm(`Delete "${s.name}"?`)) return; const l = savedList(); l.splice(i, 1); try { localStorage.setItem(SAVED, JSON.stringify(l)); } catch {} paintSaved(); };
    r.append(n, del); box.append(r);
  });
}
function describe() {
  const L = res.L, T = typeName();
  return `${st.count}× ${subLabel()} · ${T} · ${L.net.map((v) => fmt("vol", v)).join(" + ")}${L.ports.length ? " · " + L.ports.map((p) => p.fb.toFixed(0) + " Hz").join(" / ") : ""}`;
}
const subLabel = () => { const s = st.sub && findSub(st.sub); return s ? `${s.brand} ${s.model}` : M.PRESETS[st.preset] ? st.preset + "″ sub" : "sub"; };
function typeName() {
  const sty = styleOf();
  return { sealed: "Sealed", ported: "Ported", bp4: sty === "hall" ? "4th order hallway" : "4th order bandpass", bp6: sty === "hall" ? "6th order hallway" : sty === "series" ? "6th order bandpass (series)" : "6th order bandpass" }[st.type];
}
/** The whole build as text: to copy, or to send. */
function sheet() {
  const { L, sim } = res, lines = [`FifTeam Media sub box: ${describe()}`, ""];
  lines.push(`Outside: ${cutLen(L.W)} wide × ${cutLen(L.H)} tall × ${cutLen(L.D)} deep${L.Dt < L.D ? ` (${cutLen(L.Dt)} at the top)` : ""}, ${cutLen(st.t)} wood${st.layers > 1 ? `, the baffle ${st.layers} layers (${cutLen(st.layers * st.t)})${st.type.startsWith("bp") ? ": the divider the subs mount on" : ""}` : ""}`);
  L.net.forEach((v, k) => lines.push(`${L.net.length > 1 ? (k ? (L.hall ? "Middle chamber" : "Front chamber") : (L.hall ? "Rear chambers (both)" : "Rear chamber")) : "Box"}: ${fmt("vol", v)} net (${fmt("vol", L.gross[k])} inside)`));
  for (const p of L.ports) lines.push(`${cap(M.portName(spec(), p))}: ${p.copies > 1 ? p.copies + "× " : ""}${p.kind === "slot" ? `slot ${cutLen(p.sw)} × ${cutLen(p.span)}` : `${p.n}× ${cutLen(p.dia)} round`}, ${cutLen(p.len)} long${p.bend ? " (bent)" : ""}, tuned to ${p.fb.toFixed(1)} Hz`);
  lines.push("", "Cut list:");
  for (const c of L.cut) lines.push(`  ${c.n}× ${c.name}: ${cutLen(c.a)} × ${cutLen(c.b)}${c.b2 ? ` / ${cutLen(c.b2)}` : ""}${c.note ? ` (${c.note})` : ""}`);
  lines.push("", `Sub cutout ${cutLen(st.drv.cutout)}${st.drv.shape === "sq" ? " square" : " round"}. Power ${st.power} W. Peak cone travel ${(Math.max(...sim.x.filter((x, i) => sim.f[i] >= res.fmin && sim.f[i] <= 200)) * 1000).toFixed(1)} mm (Xmax ${(st.drv.xmax * 1000).toFixed(1)} mm).`);
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
  document.querySelectorAll("#bx-c4 .chip").forEach((c) => c.classList.toggle("on", Math.abs(+c.dataset.k - st.c4) < 0.05));
  const drv = res && res.drv;
  if (drv) $("bx-drv-note").textContent = `Vas ${(drv.vas / FT3).toFixed(2)} ft³ = ${(drv.vas / LTR).toFixed(1)} L · Sd ${(drv.sd / IN / IN).toFixed(1)} in² = ${(drv.sd / CM / CM).toFixed(0)} cm² · Qms ${drv.qms.toFixed(2)} · BL ${drv.bl.toFixed(1)} T·m · Mms ${(drv.mms * 1000).toFixed(0)} g · ${drv.sens.toFixed(1)} dB at 2.83 V · EBP ${drv.ebp.toFixed(0)} (${drv.ebp < 50 ? "sealed" : drv.ebp > 100 ? "ported" : "either box"})`;
  $("bx-solve-row").hidden = st.fixed;
  $("bx-split-row").hidden = !st.fixed || (st.type !== "bp4" && st.type !== "bp6");
  $("bx-split").value = Math.round(st.split * 100); $("bx-split-v").textContent = `${Math.round(st.split * 100)}% / ${100 - Math.round(st.split * 100)}%`;
  document.querySelectorAll(".bx-target").forEach((e) => (e.hidden = st.fixed));
}
/** The bandpass style buttons for the type. */
function paintStyle() {
  const el = $("bx-style"); if (!el) return;
  const items = st.type === "bp6" ? [["std", "Standard"], ["series", "Series"], ["hall", "Hallway"]] : st.type === "bp4" ? [["std", "Standard"], ["hall", "Hallway"]] : [];
  el.hidden = !items.length;
  if (el.dataset.t !== st.type) {
    el.dataset.t = st.type; el.replaceChildren();
    for (const [k, label] of items) { const b = h("button", "", label); b.type = "button"; b.dataset.k = k; el.append(b); }
  }
  el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === styleOf()));
}
function paintSubName() {
  const el = $("bx-subname"); if (!el) return;
  const s = st.sub && findSub(st.sub);
  el.replaceChildren();
  if (s) { el.append(h("b", "", subName(s)), h("small", "", `${s.size}″${s.rms ? ` · ${s.rms} W RMS` : ""} · specs from ${s.src}${st.est.length ? ` · not published: ${st.est.join(", ")} (typical values used)` : ""}`)); }
  else el.append(h("small", "", M.PRESETS[st.preset] ? `Typical ${st.preset}″ numbers` : "Your own numbers"));
}
function paintPorts() {
  const box = $("bx-ports"); if (!box || !res) return;
  const L = res.L;
  $("bx-port-sec").hidden = !L.ports.length;
  for (const key of ["port", "port2"]) {
    const el = $("bx-" + key), p = L.ports.find((q) => q.key === key), P = st[key];
    el.hidden = !p;
    if (!p) continue;
    el.querySelector(".bx-pname").textContent = L.ports.length > 1 ? cap(M.portName(spec(), p)) : "The port";
    el.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.k === P.kind));
    el.querySelector(".bx-pslot").hidden = P.kind !== "slot"; el.querySelector(".bx-pround").hidden = P.kind !== "round";
    el.querySelector(".bx-pauto").checked = P.auto;
    el.querySelector(".bx-pinfo").textContent = `${fmt("area", p.S)}${p.copies > 1 ? ` (${p.copies} ports)` : ""} · ${cutLen(p.len)} long (${cutLen(p.lin)} inside${p.bend ? ", bent" : ""}) · tuned to ${p.fb.toFixed(1)} Hz${P.kind === "slot" ? ` · ${cutLen(p.sw)} × ${cutLen(p.span)} slot${p.top ? " along the top" : ""}` : ""}`;
  }
}
/** The baffle's layers: the chip (or the number typed), and which panel that is and how thick. */
function paintLayers() {
  document.querySelectorAll("#bx-layers .chip").forEach((c) => c.classList.toggle("on", +c.dataset.k === st.layers));
  const i = $("bx-layers-n"); if (i && document.activeElement !== i) i.value = st.layers;
  const el = $("bx-layers-info"); if (!el) return;
  const bp = st.type.startsWith("bp"), n = st.count, thick = cutLen(st.layers * st.t);
  el.textContent = `${bp ? `The divider${styleOf() === "hall" ? "s" : ""} the subs mount on` : `The front the sub${n > 1 ? "s" : ""} mount${n > 1 ? "" : "s"} on`}: ${st.layers > 1 ? `${st.layers} layers glued together, ${thick}` : `one layer, ${thick}`}. More layers: stiffer, less flex at high power (and a little less air inside).`;
}
/** Premium's locks: on the 4th and 6th-order buttons and the bandpass quick builds (gone once it's unlocked). */
function paintLocks() {
  const pro = premiumNow();
  const mark = (b, on) => { let l = b.querySelector(".pm-lock"); if (on && !l) { l = h("span", "pm-lock"); l.append(icon("i-lock")); b.append(l); b.setAttribute("aria-label", `${b.firstChild.textContent} (Premium)`); } if (!on && l) { l.remove(); b.removeAttribute("aria-label"); } };
  document.querySelectorAll("#bx-type button").forEach((b) => mark(b, !pro && (b.dataset.k === "bp4" || b.dataset.k === "bp6")));
  document.querySelectorAll("#bx-quick .chip").forEach((b) => { const q = QUICK.find((x) => x[0] === b.dataset.k); mark(b, !pro && q && (q[3].type === "bp4" || q[3].type === "bp6")); });
  const bar = $("bx-probar"); if (bar) bar.hidden = pro;
}
function paintAll() {
  document.querySelectorAll("#bx-type button").forEach((b) => b.classList.toggle("on", b.dataset.k === st.type));
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
  $("bx-cabf").hidden = !st.cab; $("bx-cab").checked = st.cab; $("bx-fixed").checked = st.fixed; paintLayers(); paintLocks(); if ($("bx-square")) $("bx-square").checked = st.drv.shape === "sq";
  $("bx-type-info").textContent = TYPE_INFO[st.type + ":" + styleOf()] || TYPE_INFO[st.type];
  if (document.activeElement !== $("bx-count")) $("bx-count").value = st.count;
  $("bx-3dcard").classList.toggle("pinned", st.pin); $("bx-pin").classList.toggle("on", st.pin);
  document.querySelectorAll("#bx-thick .chip").forEach((c) => c.classList.toggle("on", Math.abs(+c.dataset.k * IN - st.t) < 1e-4));
  paintPresets();
  if (view) { view.setMode(st.view); view.setFinish(st.finish, st.paint); }
  $("bx-paint-row").hidden = st.finish !== "paint"; $("bx-paint").value = st.paint;
  document.querySelectorAll("#bx-swatches .bx-sw").forEach((b) => b.classList.toggle("on", b.dataset.c.toLowerCase() === st.paint.toLowerCase()));
  paintStyle(); paintSubName();
  document.querySelectorAll("#bx-brace button").forEach((b) => b.classList.toggle("on", b.dataset.k === st.braceMode));
  $("bx-round").checked = st.round;
  document.querySelectorAll("#bx-quick .chip").forEach((c) => c.classList.toggle("on", c.dataset.k === st.quick));
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
    if ((b.dataset.k === "bp4" || b.dataset.k === "bp6") && !requirePremium(b.dataset.k)) return;
    st.type = b.dataset.k;
    st.quick = null;
    if (!st.designed[designKey()]) design(st.type, true);
    paintAll();
  };
  const sty = h("div", "seg"); sty.id = "bx-style";
  sty.onclick = (e) => {
    const b = e.target.closest("button"); if (!b || b.dataset.k === styleOf()) return;
    if (st.type === "bp6") st.style6 = b.dataset.k; else st.style4 = b.dataset.k;
    design(st.type, true); paintAll();
  };
  // (free accounts: what Premium adds here, one tap away)
  const pro = h("button", "bx-probar"); pro.type = "button"; pro.id = "bx-probar";
  const pb = h("span", "pm-badge"); pb.append(icon("i-spark"), "Premium");
  pro.append(pb, h("span", "", "4th and 6th-order boxes, unlimited rebassing and downloads, for a one-time $10"));
  pro.onclick = () => openPremium("bandpass");
  sT.append(types, sty, h("p", "status bx-info", ""), pro); sT.querySelector(".bx-info").id = "bx-type-info";
  root.append(sT);

  // the sub
  const sD = section("bx-sec-sub", "i-bass", "Your sub", "Its Thiele/Small numbers, from the spec sheet");
  const pick = h("button", "btn primary block bx-pick"); pick.type = "button"; pick.append(icon("i-search"), "Choose your sub");
  pick.onclick = () => openSubList();
  const nameLine = h("div", "bx-subname"); nameLine.id = "bx-subname";
  const pre = chips("bx-presets", [["8", "Typical 8″"], ["10", "10″"], ["12", "12″"], ["15", "15″"], ["18", "18″"], ["custom", "My own"]], (k) => {
    if (k === "custom") { st.preset = "custom"; st.sub = null; st.est = []; paintPresets(); paintSubName(); toast("Type in your sub's numbers below"); return; }
    st.preset = k; st.sub = null; st.est = []; const p = M.PRESETS[k]; Object.assign(st.drv, p, { shape: "round" }); st.power = Math.round(p.pe * st.count);
    design(st.type, true); paintAll(); toast(`Typical ${k}-inch sub, box re-designed for it`);
  });
  const cnt = h("div", "row between bx-count");
  const minus = h("button", "btn small", "−"), plus = h("button", "btn small", "+"); minus.type = plus.type = "button";
  const cv2 = h("input", "input bx-countv"); cv2.id = "bx-count"; cv2.inputMode = "numeric"; cv2.setAttribute("aria-label", "How many subs (1 to 20)");
  cv2.onchange = () => { const n = parseInt(cv2.value, 10); if (n >= 1 && n <= 20) setCount(n); else cv2.value = st.count; };
  const cl = h("div", "row"); cl.append(minus, cv2, plus);
  const setCount = (n) => { if (n < 1 || n > 20 || n === st.count) return; st.power = Math.round((st.power / st.count) * n); st.count = n; design(st.type, true); paintAll(); toast(`${n} sub${n > 1 ? "s" : ""}: box re-designed`); };
  minus.onclick = () => setCount(st.count - 1); plus.onclick = () => setCount(st.count + 1);
  cnt.append(h("span", "label", "How many subs (1–20)"), cl);
  sD.append(pick, nameLine, pre, cnt,
    grid(3, field("drv.fs", "Fs", "hz"), field("drv.qts", "Qts", "q"), field("drv.qes", "Qes", "q"),
      field("drv.vas", "Vas", "vol", { swap: true, dec: 2 }), field("drv.re", "Re", "ohm"), field("drv.le", "Le", "mh", { zero: true }),
      field("drv.sd", "Sd (cone area)", "area", { swap: true }), field("drv.xmax", "Xmax (one way)", "mm"), field("drv.pe", "Power rating", "w")),
    h("small", "status bx-drvnote", ""),
    (() => { const c = h("div", "stack-sm bx-check"); c.id = "bx-drv-check"; return c; })(),
    h("span", "label", "For fitting it in"),
    grid(3, field("drv.cutout", "Cutout", "len"), field("drv.depth", "Mounting depth", "len"), field("drv.disp", "Displacement", "vol", { zero: true })),
    grid(2, field("power", "Amp power (total RMS)", "w", { on: () => {} }), field("drv.size", "Size (frame)", "len")),
    (() => { const q = sw("Square sub", "A square frame and cone (like Kicker's L7s): the cutout is a square, its side the cutout above", st.drv.shape === "sq", (on) => { st.drv.shape = on ? "sq" : "round"; paintAll(); }); q.querySelector("input").id = "bx-square"; return q; })());
  sD.querySelector(".bx-drvnote").id = "bx-drv-note";
  root.append(sD);

  // the design
  const sG = section("bx-sec-design", "i-spark", "Design", "Build it for me, or set the volume and tuning yourself");
  const quick = chips("bx-quick", QUICK.map((q) => [q[0], q[1]]), (k) => { const t = QUICK.find((q) => q[0] === k)[3].type; if ((t === "bp4" || t === "bp6") && !requirePremium(t)) return; quickBuild(k); });
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
      h("span", "label", "Tuning: the middle of its band (lower is deeper, higher is louder)"),
      chips("bx-c4", [["40", "40 Hz"], ["45", "45 Hz"], ["50", "50 Hz"], ["55", "55 Hz"], ["60", "60 Hz"]], (k) => { st.c4 = +k; design("bp4", true); paintAll(); }),
      grid(3, tgt(field("vr4", "Sealed chamber", "vol")), tgt(field("vf4", "Ported chamber", "vol")), field("fb4", "Tuning", "hz"))),
    blk("bp6",
      h("span", "label", "The band it should play"),
      grid(2, field("lo6", "From", "hz"), field("hi6", "To", "hz")),
      (() => { const b = h("button", "btn block", "Design it for this band"); b.type = "button"; b.prepend(icon("i-spark")); b.onclick = () => { design("bp6"); paintAll(); }; return b; })(),
      grid(2, tgt(field("vr6", "Rear chamber", "vol")), field("fr6", "Rear tuning", "hz"), tgt(field("vf6", "Front chamber", "vol")), field("ff6", "Front tuning", "hz"))),
  );
  const rec = h("button", "btn primary block", "Recommended for this sub"); rec.type = "button"; rec.prepend(icon("i-spark"));
  rec.onclick = () => { st.quick = null; design(); paintAll(); };
  sG.append(h("span", "label", "Build it for me"), quick, h("span", "label", "Or set it yourself"), dz, rec);
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
  // the baffle: the panel the subs sit on (the front; a bandpass box's divider), in layers of wood, 1 to 12
  const setLayers = (n) => { n = Math.max(1, Math.min(12, Math.round(n))); if (n === st.layers) return; st.layers = n; if (!st.fixed) reshape(); paintAll(); };
  const layersRow = h("div", "stack-sm bx-layers");
  const lChips = chips("bx-layers", [["1", "Single"], ["2", "Double"], ["3", "Triple"], ["4", "4 layers"]], (k) => setLayers(+k));
  const lIn = h("input", "input bx-countv"); lIn.id = "bx-layers-n"; lIn.inputMode = "numeric"; lIn.setAttribute("aria-label", "Layers in the baffle (1 to 12)");
  lIn.onchange = () => { const n = parseInt(lIn.value, 10); if (n >= 1 && n <= 12) setLayers(n); else lIn.value = st.layers; };
  const lRow = h("div", "row bx-layers-row"); lRow.append(lChips, h("span", "", "or"), lIn);
  const lInfo = h("small", "status"); lInfo.id = "bx-layers-info";
  layersRow.append(h("span", "label", "Baffle (where the subs sit)"), lRow, lInfo);
  const splitRow = h("div", "stack-sm"); splitRow.id = "bx-split-row";
  const split = h("input"); split.type = "range"; split.min = 10; split.max = 90; split.step = 1; split.id = "bx-split";
  split.oninput = () => { st.split = +split.value / 100; schedule(); };
  const sv = h("span", "val"); sv.id = "bx-split-v";
  const sl = h("div", "row between"); sl.append(h("span", "label", "Divider: rear / front chamber"), sv);
  splitRow.append(sl, split);
  const fin = seg("bx-finish", [["mdf", "MDF"], ["paint", "Paint"], ["black", "Black carpet"], ["gray", "Gray carpet"]], st.finish);
  fin.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.finish = b.dataset.k; paintAll(); };
  const paintRow = h("div", "row wrap bx-paint-row"); paintRow.id = "bx-paint-row";
  const col = h("input", "bx-color"); col.type = "color"; col.id = "bx-paint"; col.setAttribute("aria-label", "Pick any colour");
  col.oninput = () => { st.paint = col.value; view && view.setFinish("paint", st.paint); persist(); document.querySelectorAll("#bx-swatches .bx-sw").forEach((b) => b.classList.remove("on")); };
  const swatches = h("div", "row wrap bx-swatches"); swatches.id = "bx-swatches";
  for (const [c, nm] of [["#111114", "Black"], ["#f2f2f2", "White"], ["#c8102e", "Red"], ["#1f5fe0", "Blue"], ["#7a4bff", "Purple"], ["#ff4fa3", "Pink"], ["#1fae5b", "Green"], ["#ffc21a", "Yellow"], ["#ff7a1a", "Orange"], ["#6b7280", "Gray"]]) {
    const b = h("button", "bx-sw"); b.type = "button"; b.dataset.c = c; b.style.background = c; b.setAttribute("aria-label", nm); b.title = nm;
    b.onclick = () => { st.paint = c; paintAll(); };
    swatches.append(b);
  }
  paintRow.append(swatches, col);
  // the space you have: the box is kept inside it (0: no limit)
  const reshapeSoon = (() => { let tm = 0; return () => { clearTimeout(tm); tm = setTimeout(() => { if (!st.fixed) { reshape(); paintAll(); } }, 600); }; })();
  const space = grid(3, field("lim.w", "Max width", "len", { zero: true, on: reshapeSoon }), field("lim.h", "Max height", "len", { zero: true, on: reshapeSoon }), field("lim.d", "Max depth", "len", { zero: true, on: reshapeSoon }));
  const gapF = grid(2, field("gap", "Space between subs", "len", { zero: true, on: reshapeSoon }));
  const brace = seg("bx-brace", [["off", "No bracing"], ["std", "Braced"], ["heavy", "Heavy (SPL)"]], st.braceMode);
  brace.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.braceMode = b.dataset.k; paintAll(); };
  const braceInfo = h("small", "status bx-braceinfo"); braceInfo.id = "bx-brace-info";
  const roundSw = sw("Round the port's bends", "A 45° strip in each bend, so the air never turns a square 90°: smoother, quieter", st.round, (on) => { st.round = on; paintAll(); });
  roundSw.querySelector("input").id = "bx-round";
  sM.append(un, shp, fixedSw, solveRow, dims, h("span", "label", "The space you have (optional: 0 is no limit)"), space, gapF, h("span", "label", "Wood thickness"), thick, grid(2, field("t", "Wood", "len"), field("brace", "Other bracing (volume)", "vol", { zero: true })), layersRow,
    h("span", "label", "Bracing"), brace, braceInfo, roundSw, splitRow, h("span", "label", "Finish (for the 3D view)"), fin, paintRow);
  root.append(sM);

  // the ports
  const sP = section("bx-port-sec", "i-port", "Port", "Its size; the length for the tuning is worked out");
  const ports = h("div", "stack"); ports.id = "bx-ports";
  for (const key of ["port", "port2"]) {
    const el = h("div", "stack-sm bx-pblock"); el.id = "bx-" + key;
    const kind = seg(null, [["slot", "Slot"], ["round", "Round"]], st[key].kind);
    kind.onclick = (e) => { const b = e.target.closest("button"); if (!b || b.dataset.k === st[key].kind) return; st[key].kind = b.dataset.k; st[key].autoRound = false; compute(); sizePorts(true); const moved = reshape(); if (M.misfits(res.L)) toast(b.dataset.k === "round" ? "A round port that long can't fit straight here: a slot port can bend" : "The port still doesn't fit: see the notes under How it plays", 4000); else if (moved) toast("Box re-shaped so the port fits"); paintAll(); };
    const slot = grid(2, field(key + ".w", "Slot width", "len")); slot.classList.add("bx-pslot");
    const round = grid(2, field(key + ".dia", "Diameter (inside)", "len"), field(key + ".n", "How many", "n", { min: 1, max: 8 })); round.classList.add("bx-pround");
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
  // the build preview: the box going together piece by piece, in the 3D view at the top
  const prev = h("button", "btn primary block bx-prevbtn"); prev.type = "button"; prev.id = "bx-preview"; prev.append(icon("i-box"), "Show preview");
  prev.onclick = () => (asm.on ? stopAssembly() : startAssembly());
  const asmBox = h("div", "bx-asm"); asmBox.id = "bx-asm"; asmBox.hidden = true;
  sC.append(cut, prev, asmBox, copy);
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
  const sS = section("bx-sec-saved", "i-save", "Save and share", "Keep your designs, or post one for everyone");
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
  const share = h("button", "btn block bx-share"); share.type = "button"; share.append(icon("i-share"), "Share this box on Social");
  share.onclick = () => shareBox();
  sS.append(share, sr, list, reset);
  root.append(sS);

  cv.addEventListener("pointerdown", () => hint.classList.add("gone"), { once: true });
  view = boxView(cv, ov);
  if (!view.webgl) hint.textContent = "Drag to turn · pinch to zoom (simple view: this phone has no 3D graphics)";
}

// ---------------------------------------------------------------------------------------------------- the list of real subs
function applySub(s) {
  const { drv, estNames } = subFrom(s.row);
  st.drv = drv; st.sub = subKey(s); st.est = estNames; st.preset = "db";
  st.fu = { ...st.fu, "drv.vas": "cm", "drv.sd": "cm" };
  st.power = Math.round(drv.pe * st.count);
  st.quick ? quickBuild(st.quick) : design(st.type, true);
  paintAll();
  toast(`${subName(s)}: box designed for it`);
}
function openSubList() {
  let q = "", brand = "";
  openSheet((p) => {
    p.classList.add("bx-subsheet");
    p.append(h("h3", "", "Choose your sub"));
    const search = h("input", "input"); search.type = "search"; search.placeholder = `Search ${SUBS.length} subs: brand, model or size`; search.setAttribute("aria-label", "Search subs");
    const brands = chips("bx-brands", [["", "All"], ...[...new Set(SUBS.map((s) => s.brand))].map((b) => [b, b])], (k) => { brand = k; paint(); });
    const list = h("div", "bx-sublist");
    const paint = () => {
      brands.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.k === brand));
      list.replaceChildren();
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const found = SUBS.filter((s) => (!brand || s.brand === brand) && words.every((w) => `${s.brand} ${s.model} ${s.coils} ${s.size}in ${s.size}″${s.sq ? " square" : ""}`.toLowerCase().includes(w)));
      for (const s of found) {
        const r = h("button", "bx-subrow" + (st.sub === subKey(s) ? " on" : "")); r.type = "button";
        const left = h("div", "bx-subl"); left.append(h("b", "", `${s.brand} ${s.model}`), h("small", "", `${s.size}″ ${s.coils || ""}${s.rms ? ` · ${s.rms} W RMS` : ""} · ${s.fs ? `Fs ${s.fs} · Qts ${s.qts} · Vas ${s.vas} L` : "Fs, Qts, Vas not published"}${s.sq ? " · square" : ""}${s.full ? "" : " · partial specs"}`));
        r.append(left, h("span", "bx-subsize", `${s.size}″`));
        r.onclick = () => { closeSheet(); applySub(s); };
        list.append(r);
      }
      if (!found.length) list.append(h("p", "status", "No subs match. Try another word, or type your sub's numbers in yourself."));
    };
    search.oninput = () => { q = search.value; paint(); };
    p.append(search, brands, list, h("p", "status bx-subsrc", "Numbers as their makers publish them (or the speaker databases that collect them). Missing ones are filled with typical values for the size, and the app says which."));
    paint();
  });
}

// ---------------------------------------------------------------------------------------------------- sharing
const SHARE_KEYS = ["gap", "braceMode", "round", "units", "type", "style4", "style6", "count", "power", "qtc", "vbS", "vbP", "fbP", "s4", "g4", "c4", "vr4", "vf4", "fb4", "vr6", "fr6", "vf6", "ff6", "lo6", "hi6", "shape", "w", "h", "d", "dt", "t", "layers", "brace", "split", "solve", "finish", "paint", "preset", "sub", "est", "drv", "port", "port2", "wire", "fu"];
/** The design as a short code (base64url JSON), for a post. */
function encodeBox() {
  const o = { v: 1, fixed: true }; for (const k of SHARE_KEYS) o[k] = st[k];
  const bytes = new TextEncoder().encode(JSON.stringify(o));
  let s = ""; bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBox(code) {
  const b = atob(code.replace(/-/g, "+").replace(/_/g, "/")), bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
  const o = JSON.parse(new TextDecoder().decode(bytes));
  if (!o || o.v !== 1 || typeof o.drv !== "object") throw new Error("bad");
  const out = {}; for (const k of SHARE_KEYS) if (k in o) out[k] = o[k];
  if (o.layers == null && o.dbl) out.layers = 2;                             // (shared before the baffle had layers)
  out.fixed = true; out.v = 1; out.designed = { [o.type + (o.type === "bp6" ? ":" + o.style6 : o.type === "bp4" ? ":" + o.style4 : "")]: true };
  return out;
}
let pendingShare = null;
/** Someone's shared box, opened in the designer (their exact measurements). */
function openShared(code) {
  if (!built) { pendingShare = code; location.hash = "#box"; return; }
  let s; try { s = merge(defaults(), decodeBox(code)); } catch { toast("Couldn't open that box"); return; }
  if ((s.type === "bp4" || s.type === "bp6") && !requirePremium(s.type)) return;
  st = s;
  location.hash = "#box"; paintAll(); $("view-box").scrollTo({ top: 0 });
  toast(`Opened: ${describe()}`, 3500);
}
async function shareBox() {
  if (!view || !res) return;
  const L = res.L, title = `${st.count}× ${subLabel()}`;
  const lines = [`${typeName()} · ${L.net.map((v) => fmt("vol", v)).join(" + ")}${L.ports.length ? " · " + L.ports.map((p) => p.fb.toFixed(0) + " Hz").join("/") : ""}`, `${cutLen(L.W)} × ${cutLen(L.H)} × ${cutLen(L.D)} · ${st.power} W`];
  let img = null; try { img = await view.snapshot(title, lines); } catch {}
  if (!img) { toast("Couldn't take a picture of the box"); return; }
  const { shareBoxPost } = await import("./social.js");
  location.hash = "#social";
  setTimeout(() => shareBoxPost({ img, box: encodeBox(), text: `${title} · ${lines[0]}` }), 250);
}

// ---------------------------------------------------------------------------------------------------- the build preview
// The box put together piece by piece in the 3D view (pinned at the top while the steps are read): every step's pieces
// slide into place in turn, the new ones tinted; tap a step to see it, or play them all.
const asm = { on: false, step: 0, steps: [], raf: 0, playing: false };
/** The steps, from the layout: what goes in, in order, and what to do (with the cut list's sizes). */
function assemblySteps(L) {
  const has = (k) => L.parts.some((p) => partKey(p) === k) || (k === "port" && L.ports.some((p) => (p.tubes || []).length));
  const cutOf = (re) => L.cut.find((c) => re.test(c.name));
  const size = (c) => (c ? `${cutLen(c.a)} × ${cutLen(c.b)}${c.b2 ? ` / ${cutLen(c.b2)}` : ""}` : "");
  const bp = st.type === "bp4" || st.type === "bp6", out = [];
  const add = (keys, title, text) => { if (keys.some(has)) out.push({ keys, title, text }); };
  add(["bottom"], "The bottom", `Lay the bottom (${size(cutOf(/^Bottom/))}) on a flat bench. Everything else sits on it, so check it's square.`);
  add(["back"], "The back", `Glue and screw the back (${size(cutOf(/^Back/))}) along the bottom's back edge, standing straight up${L.Dt < L.D ? " (its edges are beveled for the wedge)" : ""}.`);
  add(["left", "right"], "The sides", `The two sides (${size(cutOf(/^Sides/))}) between the front and back edges, on the bottom. Glue every joint; screws every 4 to 6″.`);
  add(["divider"], bp ? "The divider (the baffle)" : "The divider", `The divider${(L.cut.find((c) => /^Divider/.test(c.name)) || {}).n > 1 ? "s" : ""} (${size(cutOf(/^Divider/))}): ${st.layers > 1 ? `${st.layers} layers glued together first, then ` : ""}stood in where the diagram shows, glued to the bottom, back and sides. The subs mount on it${L.hall ? ", facing each other" : ""}.`);
  if (has("port")) {
    const p = L.ports[0], slot = p && p.kind === "slot";
    add(["port"], "The port", slot ? `The port wall${L.ports.length > 1 || (p.panels || []).length > 1 ? "s" : ""} (${L.cut.filter((c) => /port wall/i.test(c.name)).map(size).join(", ")}), ${cutLen(p.sw)} from the side, glued to the bottom${p.bend ? `, bent where it turns${L.parts.some((x) => x.kind === "prism") ? ", with a 45° strip in each bend's corner" : ""}` : ""}. It tunes to ${p.fb.toFixed(0)} Hz.`
      : `The port tube${(p.n || 1) > 1 ? "s" : ""} (${cutLen(p.dia)} across, ${cutLen(p.len)} long) through ${p.inner ? "the divider" : "the front"}'s hole${(p.n || 1) > 1 ? "s" : ""}, glued and flush.`);
  }
  add(["brace"], "The bracing", `The dowels (${L.bracing.count}, ${cutLen(2 * L.bracing.r)} round) glued into shallow holes in both panels they join, where the diagram shows.`);
  add(["front"], bp ? "The front" : st.layers > 1 ? `The front (the baffle, ${st.layers} layers)` : "The front (the baffle)", `${!bp && st.layers > 1 ? `Glue the ${st.layers} layers together and clamp them first. ` : ""}The front (${size(cutOf(/^Front/))}) with the ${bp ? "port opening" : `sub cutout${st.count > 1 ? "s" : ""}${L.ports.some((p) => !p.inner) ? " and the port opening" : ""}`} already cut, glued and screwed on.`);
  add(["top"], "The top", `Seal every seam inside with glue or caulk, run the speaker wire to the terminal, then the top (${size(cutOf(/^Top/))}) on, glued and screwed.`);
  add(["subs"], "The subs", `Wire the terminal to the subs (see Wiring), then each sub into its cutout${bp ? " on the divider" : ""} with its gasket, screws snugged evenly in a star pattern.`);
  return out;
}
function startAssembly(step = 0) {
  if (!view || !res) return;
  asm.on = true; asm.steps = assemblySteps(res.L);
  // (the 3D view stays at the top while the steps are read)
  if (!st.pin) { st.pin = true; paintAll(); }
  showStep(step, true);
  paintAssembly();
}
function stopAssembly() {
  asm.on = false; asm.playing = false; cancelAnimationFrame(asm.raf);
  if (view) view.setAssembly(null);
  paintAssembly();
}
/** One step: everything before it in place, its pieces sliding in (or straight in place, without the animation). */
function showStep(i, animate = true) {
  if (!asm.on || !view) return;
  asm.step = Math.max(0, Math.min(asm.steps.length - 1, i));
  const show = new Set(asm.steps.slice(0, asm.step + 1).flatMap((x) => x.keys)), keys = asm.steps[asm.step].keys, done = asm.step === asm.steps.length - 1;
  cancelAnimationFrame(asm.raf);
  const t0 = performance.now(), dur = 900;
  const frame = (now) => {
    const t = animate ? (now - t0) / dur : 1;
    view.setAssembly({ show, anim: { keys, t: Math.min(1, t) }, hi: keys, done });
    if (t < 1) asm.raf = requestAnimationFrame(frame);
    else if (asm.playing) asm.raf = setTimeout(() => { if (!asm.playing) return; if (asm.step < asm.steps.length - 1) { showStep(asm.step + 1); paintAssembly(); } else { asm.playing = false; paintAssembly(); } }, 700);
  };
  asm.raf = requestAnimationFrame(frame);
}
function paintAssembly() {
  const box = $("bx-asm"), btn = $("bx-preview"); if (!box || !btn) return;
  btn.lastChild.textContent = asm.on ? "Hide preview" : "Show preview";
  box.hidden = !asm.on;
  if (!asm.on) { box.replaceChildren(); return; }
  box.replaceChildren();
  const cur = asm.steps[asm.step];
  box.append(h("p", "label", `Putting it together: step ${asm.step + 1} of ${asm.steps.length}`));
  const card = h("div", "bx-asmcard"); card.append(h("b", "", `${asm.step + 1}. ${cur.title}`), h("p", "", warnUnits(cur.text)));
  const nav = h("div", "row bx-asmnav");
  const back = h("button", "btn small", "‹ Back"), play = h("button", "btn small", asm.playing ? "Pause" : "Play all"), next = h("button", "btn small primary", asm.step === asm.steps.length - 1 ? "Done" : "Next ›");
  for (const b of [back, play, next]) b.type = "button";
  back.disabled = asm.step === 0;
  back.onclick = () => { asm.playing = false; showStep(asm.step - 1); paintAssembly(); };
  next.onclick = () => { asm.playing = false; if (asm.step === asm.steps.length - 1) { stopAssembly(); toast("That's the whole box"); return; } showStep(asm.step + 1); paintAssembly(); };
  play.onclick = () => { asm.playing = !asm.playing; if (asm.playing) showStep(asm.playing && asm.step === asm.steps.length - 1 ? 0 : asm.step); paintAssembly(); };
  nav.append(back, play, next);
  card.append(nav);
  // every step, to pick the one you're on
  const list = h("ol", "bx-asmlist");
  asm.steps.forEach((x, i) => {
    const li = h("li", ""); const b = h("button", "bx-asmstep" + (i === asm.step ? " on" : i < asm.step ? " done" : ""), x.title); b.type = "button";
    b.onclick = () => { asm.playing = false; showStep(i); paintAssembly(); };
    li.append(b); list.append(li);
  });
  box.append(card, h("p", "label", "Pick the step you're on"), list);
}

// ---------------------------------------------------------------------------------------------------- the two categories
// Box designer (all of the above) and My system (what you're running, wired: system.js, loaded the first time it's opened)
const CAT = "fifteam-box-cat";
function categories(root) {
  // (the designer's parts stay where they are, straight in the screen, for its layout; the class hides them)
  const [head, ...rest] = [...root.children];
  rest.forEach((n) => n.classList.add("bx-dpart"));
  const sys = h("div", "bx-cat sy-root"); sys.id = "bx-system";
  const seg = h("div", "seg bx-cats"); seg.id = "bx-cats";
  for (const [k, t] of [["design", "Box designer"], ["system", "My system"]]) { const b = h("button", "", t); b.type = "button"; b.dataset.k = k; seg.append(b); }
  let cat = "design"; try { cat = localStorage.getItem(CAT) === "system" ? "system" : "design"; } catch {}
  const show = async (k) => {
    cat = k; try { localStorage.setItem(CAT, k); } catch {}
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
    root.classList.toggle("sys-on", k === "system");
    head.querySelector(".sub").textContent = k === "system" ? "What you're running, and exactly how to wire it all." : "Design a sub box: the math, the port, the cut list, in 3D.";
    if (k === "system" && !sys.dataset.on) {
      sys.dataset.on = "1";
      const { mountSystem } = await import("./system.js");
      mountSystem(sys, () => { const s = st.sub && findSub(st.sub); return { count: st.count, size: Math.round((st.drv.size || 0.3) / IN), coil: s && /^[SD]\d$/.test(s.coils) ? s.coils : (st.wire.dual ? "D" : "S") + st.wire.ohms, rms: st.drv.pe, name: subLabel() }; });
    }
    if (k === "design") { view && view.redraw(); paintChart(); }
  };
  seg.onclick = (e) => { const b = e.target.closest("button"); if (b && b.dataset.k !== cat) show(b.dataset.k); };
  root.insertBefore(seg, rest[0] || null); root.append(sys);
  show(cat);
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

export const box = { assembly: asm, startAssembly, stopAssembly, showStep, get state() { return st; }, get result() { return res; }, get view() { return view; }, design, run, sheet, quickBuild, applySub, encode: encodeBox, openShared };
let built = false;
function open() {
  if (built) { view && view.redraw(); paintChart(); if (pendingShare) { const c = pendingShare; pendingShare = null; openShared(c); } return; }
  built = true;
  st = load();
  if (pendingShare) { try { const s = merge(defaults(), decodeBox(pendingShare)); if ((s.type !== "bp4" && s.type !== "bp6") || requirePremium(s.type)) st = s; } catch {} pendingShare = null; }
  if ((st.type === "bp4" || st.type === "bp6") && !premiumNow()) { st.type = "ported"; st.quick = null; }
  buildScreen($("bx-root"));
  categories($("bx-root"));
  keepUnderBar();
  paintSaved();
  if (!st.designed.ported && st.type === "ported") design("ported", true);
  paintAll();
}
export function initBox() {
  bus.on("view", (v) => { if (v === "box") requestAnimationFrame(open); });
  addEventListener("fifteam-premium", () => { if (built) paintAll(); });
  addEventListener("resize", () => { if (built && location.hash === "#box") paintChart(); });
}
