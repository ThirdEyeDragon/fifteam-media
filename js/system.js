// My system: what you're running (head unit, subs, amps, speakers, a lithium bank, a bass knob, voltmeters), worked
// out and drawn as a wiring diagram of the car from above: every wire from the terminal it starts at to the one it
// ends at (which post on which bus bar), its gauge and fuse, and how to wire each part. Tap a part: its wires light up
// and the rest fade; tap a wire: both its ends light up, and what it is.
//   The numbers: an amp's draw is worked out from its RATED power (what it can pull, however its speakers are wired
// today), over the voltage under load (13.8 V) and its efficiency (class D: about 80% for a mono amp, 75% for a
// 4-channel). Every fuse is at least that draw (the next standard size up, so it doesn't blow at full power) and never
// more than its wire takes (so it protects the wire): the wire is the thinnest gauge, in the fewest runs, that takes
// its fuse with at most 0.5 V lost over its length (copper, OFC). Subs wired for the lowest load the amp is stable at.
import { $, toast } from "./ui.js";
import { wiring } from "./boxmath.js";

const KEY = "fifteam-system";
const NS = "http://www.w3.org/2000/svg";
const V = 13.8, CAR_LOAD = 60;
// copper (OFC) power wire: what it takes (A, in a car, bundled), and its resistance (ohm per foot)
const GAUGES = [["8", 60, 0.000628], ["4", 135, 0.000249], ["2", 181, 0.000156], ["1/0", 245, 0.0000983], ["2/0", 283, 0.0000779], ["3/0", 328, 0.0000618], ["4/0", 380, 0.000049]];
const SPK_GAUGES = [["16", 22], ["14", 32], ["12", 41], ["10", 55], ["8", 73], ["4", 135], ["1/0", 245]];
// (standard fuse sizes: blade, MIDI and ANL)
const FUSES = [2, 5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100, 125, 150, 175, 200, 225, 250, 300, 325, 350, 400, 450, 500];
const COLORS = { power: "#ff4d5e", ground: "#15151c", remote: "#3aa0ff", rca: "#e9e9f2", knob: "#f15bb5", sense: "#ffd84d", sub: "#b388ff", fl: "#ffd166", fr: "#f78c6b", rl: "#06d6a0", rr: "#4cc9f0", link: "#9aa0b8" };
const DOOR_NAMES = { fl: "Front left door", fr: "Front right door", rl: "Rear left door", rr: "Rear right door" };

export function defaults() {
  return {
    head: "aftermarket",
    subs: { n: 2, size: 12, coil: "D2", rms: 1000 },
    mono: { n: 1, watts: 2000, ohm: 1 },
    four: { n: 1, watts: 100, ohm: 2 },
    spk: { front: 2, rear: 2, tw: 0, ohm: 4 },
    bank: { n: 0, ah: 100, type: "lithium" },
    alt: 160, run: 17, big3: true, knob: true, vm: 1, bus: false,
  };
}
const EXAMPLE = {
  head: "aftermarket", subs: { n: 4, size: 15, coil: "D1", rms: 4000 }, mono: { n: 2, watts: 8000, ohm: 1 }, four: { n: 2, watts: 150, ohm: 2 },
  spk: { front: 3, rear: 3, tw: 0, ohm: 4 }, bank: { n: 4, ah: 100, type: "lithium" }, alt: 370, run: 17, big3: true, knob: true, vm: 2, bus: true,
};
function load() {
  const d = defaults();
  try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s && typeof s === "object") return { ...d, ...s, subs: { ...d.subs, ...s.subs }, mono: { ...d.mono, ...s.mono }, four: { ...d.four, ...s.four }, spk: { ...d.spk, ...s.spk }, bank: { ...d.bank, ...s.bank } }; } catch {}
  return d;
}
let S = null, sel = null, zoom = 1, getBox = null;
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };

// ---------------------------------------------------------------------------------------------------- the numbers
const ceilFuse = (a) => FUSES.find((f) => f >= a) || FUSES[FUSES.length - 1];
const floorFuse = (a) => [...FUSES].reverse().find((f) => f <= a) || FUSES[0];
/** Power (or ground) wire for a current over a length (ft): the fewest runs, then the thinnest gauge, where each run's
 * fuse (the next standard size at or above its share of the current) is no more than the wire takes, and the voltage
 * lost over the length is 0.5 V at most. */
function fit(I, ft, gi, runs) {
  const [g, amp, r] = GAUGES[gi], each = I / runs, fuse = ceilFuse(each);
  return fuse <= amp && fuse >= each && each * r * ft <= 0.5 ? { g, runs, each, amp, fuse } : null;
}
function powerWire(I, ft, minGauge = 0) {
  I = Math.max(1, I);
  for (let runs = 1; runs <= 12; runs++) for (let gi = minGauge; gi < GAUGES.length; gi++) { const w = fit(I, ft, gi, runs); if (w) return withAlt(w, I, ft); }
  const [g, amp] = GAUGES[GAUGES.length - 1], runs = Math.ceil(I / floorFuse(amp));
  return withAlt({ g, runs, each: I / runs, amp, fuse: floorFuse(amp), big: true }, I, ft);
}
/** The same current on thinner wire in more runs: 2/0 and up as runs of 1/0, 1/0 as runs of 4 AWG; each run fused for
 * its share (a 400 A fuse becomes 2 × 200 A). */
function withAlt(w, I, ft) {
  const gi = GAUGES.findIndex((x) => x[0] === w.g), ai = gi >= 4 ? 3 : gi === 3 ? 1 : -1;
  if (ai < 0) return w;
  for (let n = w.runs + 1; n <= 12; n++) { const x = fit(I, ft, ai, n); if (x) { w.alt = { g: x.g, runs: n, fuse: x.fuse }; break; } }
  return w;
}
const wireText = (w) => `${w.runs > 1 ? w.runs + " × " : ""}${w.g} AWG`;
/** The thinner way: "or 2 runs of 1/0 AWG (2 × 200 A fuses)". */
const altText = (w, fuses = true) => (w && w.alt ? `or ${w.alt.runs} runs of ${w.alt.g} AWG${fuses && w.fuse ? ` (${w.alt.runs} × ${w.alt.fuse} A fuses, one on each run)` : ""}` : "");
const fuseText = (w) => `${w.runs > 1 ? w.runs + " × " : ""}${w.fuse} A${w.alt ? `, or ${w.alt.runs} × ${w.alt.fuse} A on ${w.alt.runs} runs of ${w.alt.g}` : ""}`;
const spkGauge = (I) => (SPK_GAUGES.find(([, a]) => a >= I * 1.15) || SPK_GAUGES[SPK_GAUGES.length - 1])[0];
const coilOhms = (c) => +String(c).slice(1) || 2;
const coilDual = (c) => String(c)[0] === "D";
/** The subs on each mono amp, and how to wire them: the lowest load the amp is stable at. */
function subPlan(c) {
  const n = Math.max(0, c.subs.n | 0), amps = Math.max(0, c.mono.n | 0), out = [];
  if (!n || !amps) return out;
  const used = Math.min(amps, n);
  for (let i = 0; i < used; i++) {
    const k = Math.floor(n / used) + (i < n % used ? 1 : 0);
    const opts = wiring(k, coilDual(c.subs.coil), coilOhms(c.subs.coil));
    const ok = opts.filter((o) => o.ohms >= c.mono.ohm - 1e-6);
    const pick = ok.length ? ok[0] : opts[opts.length - 1];
    const P = Math.min(c.mono.watts, c.mono.watts * (c.mono.ohm / Math.max(pick.ohms, 0.01)));
    out.push({ amp: i, k, load: pick.ohms, how: pick.how, P, under: !ok.length, I: Math.sqrt(P / Math.max(pick.ohms, 0.1)) });
  }
  return out;
}
/** The door speakers on the 4-channel amps' channels: which speakers share a channel, and how they're wired. */
const ROLES = { 1: ["full-range speaker"], 2: ["mid", "tweeter"], 3: ["mid-bass", "mid", "tweeter"], 4: ["mid-bass", "mid-bass", "mid", "tweeter"] };
function speakerPlan(c) {
  const doors = [["fl", c.spk.front], ["fr", c.spk.front], ["rl", c.spk.rear], ["rr", c.spk.rear]].filter(([, n]) => n > 0).map(([d, n]) => ({ d, n }));
  // (dash tweeters: with the front doors)
  const tw = Math.max(0, c.spk.tw | 0);
  for (const d of doors) {
    d.list = [...(ROLES[Math.min(4, d.n)] || ROLES[4]), ...Array(Math.max(0, d.n - 4)).fill("speaker")].slice(0, d.n).map((role, i) => ({ id: `${d.d}${i}`, role, where: "door" }));
    if (tw && (d.d === "fl" || d.d === "fr")) for (let i = 0; i < tw; i++) d.list.push({ id: `${d.d}t${i}`, role: "dash tweeter", where: "dash" });
  }
  const C = Math.max(0, c.four.n | 0) * 4, chans = [];
  if (!C) return { chans, doors, head: true };
  // a channel each to start (front first), then the extra ones to the doors with the most speakers per channel
  const per = new Map(doors.map((d) => [d.d, 0]));
  let left = C;
  for (const d of doors) if (left) { per.set(d.d, 1); left--; }
  while (left > 0 && doors.length) {
    const d = doors.reduce((a, b) => (b.list.length / per.get(b.d) > a.list.length / per.get(a.d) ? b : a));
    if (d.list.length <= per.get(d.d)) break;
    per.set(d.d, per.get(d.d) + 1); left--;
  }
  const shared = doors.filter((d) => !per.get(d.d));
  // channels in order: front then rear, packed amp by amp
  let slot = 0;
  for (const d of doors) {
    const ch = per.get(d.d); if (!ch) continue;
    for (let j = 0; j < ch; j++) {
      const spk = d.list.filter((_, i) => i % ch === j);
      const opts = wiring(spk.length, false, c.spk.ohm), ok = opts.filter((o) => o.ohms >= c.four.ohm - 1e-6);
      const pick = ok.length ? ok[0] : opts[opts.length - 1];
      chans.push({ amp: Math.floor(slot / 4), ch: (slot % 4) + 1, door: d.d, spk, load: pick.ohms, how: pick.how, under: !ok.length });
      slot++;
    }
  }
  // (more doors than channels: those share another door's channel, front with rear)
  for (const d of shared) {
    const host = chans.find((x) => x.door === (d.d === "rl" ? "fl" : d.d === "rr" ? "fr" : x.door));
    if (host) { host.spk.push(...d.list); host.shared = true; const o = wiring(host.spk.length, false, c.spk.ohm), ok = o.filter((x) => x.ohms >= c.four.ohm - 1e-6); const p = ok.length ? ok[0] : o[o.length - 1]; host.load = p.ohms; host.how = p.how; host.under = !ok.length; }
  }
  return { chans, doors };
}
/** Everything worked out: the draw, the wire and fuses, the subs and speakers, and what to watch out for. */
export function compute(c) {
  const subs = subPlan(c), spk = speakerPlan(c), warn = [], tips = [];
  // (each amp: what it gives the speakers as they're wired (P), and what it can draw at its rating (I), which sizes its
  // wire and fuse: an amp is fused for what it can pull, not for today's load)
  const ampI = [];
  for (let i = 0; i < Math.max(0, c.mono.n | 0); i++) {
    const s = subs.find((x) => x.amp === i);
    ampI.push({ kind: "mono", i, P: s ? s.P : 0, rated: c.mono.watts, I: c.mono.watts / (V * 0.8) });
  }
  // (a 4-channel's rating is per channel at 4 ohms; stable at 2 ohms, it makes about 1.6 times that there)
  const fourRated = 4 * c.four.watts * (c.four.ohm <= 2 ? 1.6 : 1);
  const chP = (load) => c.four.watts * (load >= 4 ? 4 / load : load >= 2 ? 1 + 0.6 * (4 - load) / 2 : 1.6);
  for (let i = 0; i < c.four.n; i++) {
    const ch = spk.chans.filter((x) => x.amp === i), P = ch.reduce((a, x) => a + chP(x.load), 0);
    ampI.push({ kind: "four", i, P, rated: fourRated, I: fourRated / (V * 0.75) });
  }
  const I = ampI.reduce((a, x) => a + x.I, 0), P = ampI.reduce((a, x) => a + x.P, 0), rated = ampI.reduce((a, x) => a + x.rated, 0);
  const altFree = Math.max(0, c.alt - CAR_LOAD), bankAh = c.bank.n * c.bank.ah;
  // the run from the front: everything the amps draw; with a bank at the back, the bank covers the peaks and the run
  // carries the alternator's full output (charging the bank, feeding the amps): never fused below either
  const runI = c.bank.n ? Math.min(I, Math.max(c.alt, 100)) : I;
  const run = powerWire(runI, c.run, 3);
  // (the Big 3: the alternator's whole output)
  const big3 = powerWire(Math.max(c.alt, 100), 4, 3);
  const deficit = Math.max(0, I - altFree);
  const usable = c.bank.type === "agm" ? 0.5 : 0.9, bankName = c.bank.type === "agm" ? "AGM" : "Lithium";
  const minutes = deficit > 0 && bankAh ? (bankAh * usable) / deficit * 60 : Infinity;
  const ampWire = ampI.map((a) => ({ ...a, w: powerWire(a.I, 4) }));
  // (each battery in the bank: its share of everything the amps can draw)
  const bankWire = c.bank.n ? powerWire(I / c.bank.n, 2, 3) : null;
  // warnings
  for (const s of subs) {
    if (s.under) warn.push(`Mono amp ${s.amp + 1}: its ${s.k} sub${s.k > 1 ? "s" : ""} can't be wired at or above ${c.mono.ohm} Ω with ${c.subs.coil} coils (the closest is ${s.load} Ω). Use another coil option or more amps.`);
    const each = s.P / s.k;
    if (each > c.subs.rms * 1.3) warn.push(`Mono amp ${s.amp + 1} puts about ${Math.round(each).toLocaleString()} W on each sub, over their ${c.subs.rms.toLocaleString()} W rating. Turn its gain down, or use bigger subs.`);
    else if (each < c.subs.rms * 0.5) tips.push(`Mono amp ${s.amp + 1} gives each sub about ${Math.round(each).toLocaleString()} W, about half their ${c.subs.rms.toLocaleString()} W rating: plenty for daily, room to grow.`);
  }
  if (c.subs.n && !c.mono.n) warn.push("Subs need a mono (sub) amp: add one.");
  if (c.mono.n > c.subs.n && c.subs.n) tips.push(`${c.mono.n - c.subs.n} mono amp${c.mono.n - c.subs.n > 1 ? "s have" : " has"} no subs to power.`);
  for (const ch of spk.chans) if (ch.under) warn.push(`4-channel amp ${ch.amp + 1}, channel ${ch.ch}: ${ch.spk.length} speakers can't be wired at or above ${c.four.ohm} Ω (the closest is ${ch.load} Ω). Use another channel or an amp stable lower.`);
  if (spk.chans.some((x) => x.shared)) warn.push("More doors than amp channels: the rear doors share the front channels (the fader won't work). Another 4-channel amp gives every door its own.");
  if (deficit > 0 && !bankAh) warn.push(`At full power the amps draw about ${Math.round(I).toLocaleString()} A, more than the alternator can spare (about ${altFree} A). Add batteries (a lithium bank), a bigger alternator, or both.`);
  else if (deficit > 0 && minutes < 10) warn.push(`At full power the bank covers what the alternator can't for about ${minutes < 1 ? "under a minute" : Math.round(minutes) + " minutes"}. Fine for bursts; for long sessions add batteries or a bigger alternator.`);
  if (run.big) warn.push(`That's more current than ${run.runs} runs of 4/0 take: split the load over more runs, or move power to the back (a bank) so the run only charges it.`);
  if (c.mono.n + c.four.n > 3) tips.push(`With ${c.mono.n + c.four.n} amps, the head unit's remote wire switches a relay, and the relay turns them all on (a remote output can't drive that many).`);
  if (c.bank.n && !c.big3) tips.push("With this much power, do the Big 3 too (alternator to battery, battery to chassis, engine to chassis, all at least as thick as the run).");
  return { subs, spk, ampI: ampWire, I, P, rated, altFree, bankAh, bankName, runI, run, big3, deficit, minutes, bankWire, warn, tips };
}

// ---------------------------------------------------------------------------------------------------- the drawing
const W = 360;
/** The parts, where they sit, their terminals, and every wire between them. */
function layout(c, R) {
  const comps = new Map(), wires = [];
  const comp = (o) => { comps.set(o.id, { terms: {}, info: [], steps: [], ...o }); return comps.get(o.id); };
  const term = (cp, name, x, y, dir, label) => { cp.terms[name] = { x, y, dir, label: label || name }; return cp.terms[name]; };
  let wn = 0;
  const wire = (o) => { wires.push({ id: "w" + wn++, ...o }); return wires[wires.length - 1]; };
  const stock = c.head === "stock";
  const nm = R.subs.length, n4 = Math.max(0, c.four.n | 0), nAmps = Math.max(0, c.mono.n | 0) + n4;

  // ---- up front: the battery, its main fuse, the alternator, the grounds
  const batt = comp({ id: "batt", kind: "battery", label: "Battery", sub: "Starting battery, under the hood", x: 58, y: 34, w: 60, h: 30 });
  term(batt, "pos", 70, 64, "down", "Battery +"); term(batt, "neg", 106, 64, "down", "Battery −"); term(batt, "pos2", 70, 34, "up", "Battery + (Big 3)");
  const fuse = comp({ id: "mainfuse", kind: "fuse", label: `Main fuse ${R.run.runs > 1 ? R.run.runs + " × " : ""}${R.run.fuse} A`, sub: "Within 18″ of the battery", x: 54, y: 84, w: 32, h: 14 });
  term(fuse, "in", 70, 84, "up", "Main fuse in"); term(fuse, "out", 70, 98, "down", "Main fuse out");
  const alt = comp({ id: "alt", kind: "alt", label: "Alternator", sub: `${c.alt} A`, x: 232, y: 40, w: 36, h: 36, round: true });
  term(alt, "out", 232, 58, "left", "Alternator B+"); term(alt, "case", 250, 76, "down", "Engine block");
  const gF = comp({ id: "gndf", kind: "ground", label: "Chassis ground", sub: "Front, bare metal", x: 140, y: 104, w: 24, h: 16 });
  term(gF, "g", 152, 104, "up", "Front chassis ground");
  wire({ kind: "power", from: ["batt", "pos"], to: ["mainfuse", "in"], ...R.run, label: `${wireText(R.run)} power`, note: "As short as it can be: the fuse goes within 18″ of the battery." });
  // (the battery's ground carries everything the run does back: at least as thick; with the Big 3, the alternator's
  // output too)
  const fg = c.big3 && R.big3.runs * R.big3.amp > R.run.runs * R.run.amp ? R.big3 : R.run;
  wire({ kind: "ground", from: ["batt", "neg"], to: ["gndf", "g"], g: fg.g, runs: fg.runs, alt: fg.alt, label: `${wireText(fg)} ground${c.big3 ? " (Big 3)" : ""}`, note: "Battery − to bare chassis metal: sand off the paint, ring lug, star washer. At least as thick as the power run." });
  if (c.big3) {
    wire({ kind: "power", from: ["alt", "out"], to: ["batt", "pos2"], ...R.big3, label: `${wireText(R.big3)} Big 3 (alternator)`, note: `Big 3: alternator B+ to battery +, sized for its whole ${c.alt} A, fused ${fuseText(R.big3)} near the battery.` });
    wire({ kind: "ground", from: ["alt", "case"], to: ["gndf", "g"], g: R.big3.g, runs: R.big3.runs, alt: R.big3.alt, label: `${wireText(R.big3)} Big 3 (engine block)`, note: "Big 3: the engine block to the chassis, as thick as the alternator wire." });
  }

  // ---- the dash: the head unit (or a factory radio and a line output converter), bass knob, voltmeters
  const hu = comp({ id: "hu", kind: "head", label: stock ? "Factory radio" : "Head unit", sub: stock ? "Kept: a line output converter makes RCAs" : "RCA pre-outs and a remote wire at the back", x: 150, y: 172, w: 60, h: 26 });
  term(hu, "rcaF", 158, 198, "down", "Front pre-out (RCA)"); term(hu, "rcaR", 168, 198, "down", "Rear pre-out (RCA)"); term(hu, "rcaS", 178, 198, "down", "Sub pre-out (RCA)");
  term(hu, "rem", 192, 198, "down", "Remote out (blue/white)"); term(hu, "spk", 150, 185, "left", "Speaker outputs (harness)");
  let src = hu;
  if (stock) {
    const loc = comp({ id: "loc", kind: "loc", label: "Line output converter", sub: "Speaker wires in, RCAs and remote out", x: 150, y: 214, w: 60, h: 16 });
    term(loc, "in", 180, 214, "up", "LOC speaker inputs"); term(loc, "rcaF", 158, 230, "down", "LOC front RCA out"); term(loc, "rcaR", 168, 230, "down", "LOC rear RCA out");
    term(loc, "rcaS", 178, 230, "down", "LOC sub RCA out"); term(loc, "rem", 192, 230, "down", "LOC remote out");
    wire({ kind: "rca", from: ["hu", "spk"], to: ["loc", "in"], label: "Factory speaker wires to the LOC", g: "18", note: "Tap the factory radio's speaker wires (front and rear) behind the dash, with the harness adapter or T-taps." });
    src = loc;
  }
  let knob = null;
  if (c.knob && nm) { knob = comp({ id: "knob", kind: "knob", label: "Bass knob", sub: "Sub level, on the dash", x: 66, y: 184, w: 22, h: 22, round: true }); term(knob, "rj", 77, 206, "down", "Bass knob port (RJ)"); }
  const vms = [];
  const vmAt = [[96, 156], [236, 156], [268, 156]];
  for (let i = 0; i < Math.min(3, c.vm | 0); i++) {
    const [x, y] = vmAt[i];
    const v = comp({ id: "vm" + i, kind: "vm", label: `Voltmeter ${i + 1}`, sub: i === 0 && c.bank.n ? "Reads the lithium bank" : i <= 1 ? "Reads the front battery" : "Reads the alternator", x, y, w: 28, h: 14 });
    term(v, "plus", x + 6, y + 14, "down", `Voltmeter ${i + 1} sense +`); term(v, "minus", x + 14, y + 14, "down", `Voltmeter ${i + 1} −`); term(v, "trig", x + 22, y + 14, "down", `Voltmeter ${i + 1} on/off`);
    vms.push(v);
  }

  // ---- the doors: speakers
  const doorY = { fl: [234, 330], fr: [234, 330], rl: [352, 448], rr: [352, 448] }, spkComps = new Map();
  for (const d of R.spk.doors) {
    const left = d.d === "fl" || d.d === "rl", [y0, y1] = doorY[d.d], doorList = d.list.filter((s) => s.where === "door");
    doorList.forEach((s, i) => {
      const y = y0 + ((i + 0.5) * (y1 - y0)) / doorList.length, x = left ? 20 : 340;
      const cp = comp({ id: "spk-" + s.id, kind: "speaker", label: `${DOOR_NAMES[d.d].replace(" door", "")} ${s.role}`, sub: `${c.spk.ohm} Ω`, x: x - 9, y: y - 9, w: 18, h: 18, round: true });
      term(cp, "t", left ? x + 9 : x - 9, y, left ? "right" : "left", `${DOOR_NAMES[d.d]}: ${s.role}`);
      spkComps.set(s.id, cp);
    });
    d.list.filter((s) => s.where === "dash").forEach((s, i) => {
      const x = left ? 52 + i * 14 : 308 - i * 14, y = 168;
      const cp = comp({ id: "spk-" + s.id, kind: "speaker", label: `${left ? "Left" : "Right"} dash tweeter`, sub: `${c.spk.ohm} Ω`, x: x - 6, y: y - 6, w: 12, h: 12, round: true });
      term(cp, "t", x, y + 6, "down", `${left ? "Left" : "Right"} dash tweeter`);
      spkComps.set(s.id, cp);
    });
  }

  // ---- the back: the bank, the bus bars, fuses, amps, the sub box
  const nb = Math.max(0, c.bank.n | 0), bankRows = Math.max(1, Math.ceil(nb / 5));
  const yBank = 486, yNeg = yBank + bankRows * 32 + 10, yPos = yNeg + 18, yFuse = yPos + 22, yAmp = yFuse + 26, ampW = 62, ampH = 48, perRow = 4;
  const bank = [];
  for (let i = 0; i < nb; i++) {
    const row = Math.floor(i / 5), inRow = Math.min(5, nb - row * 5), bw = 34, gap = 6, total = inRow * bw + (inRow - 1) * gap, x = W / 2 - total / 2 + (i % 5) * (bw + gap), y = yBank + row * 32;
    const b = comp({ id: "bank" + i, kind: "lithium", label: `${R.bankName} ${i + 1}`, sub: `${c.bank.ah} Ah ${R.bankName === "AGM" ? "AGM" : "lithium"}`, x, y, w: bw, h: 24 });
    term(b, "pos", x + 8, y + 24, "down", `${R.bankName} ${i + 1} +`); term(b, "neg", x + 26, y + 24, "down", `${R.bankName} ${i + 1} −`);
    bank.push(b);
  }
  const busX0 = 30, busX1 = 330, busOn = !!c.bus, dist = !busOn && (nAmps > 1 || nb > 0);
  const neg = busOn ? comp({ id: "negbus", kind: "bus", label: "Negative bus bar", sub: "Every ground meets here", x: busX0, y: yNeg, w: busX1 - busX0, h: 8, posts: [] }) : null;
  const pos = busOn ? comp({ id: "posbus", kind: "bus", label: "Positive bus bar", sub: "Every amp's power starts here", x: busX0, y: yPos, w: busX1 - busX0, h: 8, posts: [] })
    : dist ? comp({ id: "dist", kind: "bus", dist: true, label: "Fused distribution block", sub: "One power cable in, a fused output for each amp", x: busX0, y: yPos, w: busX1 - busX0, h: 8, posts: [] }) : null;
  const posName = busOn ? "Positive bus bar" : "Distribution block";
  const post = (bus, x, fromAbove, label) => { const name = "p" + bus.posts.length; bus.posts.push({ name, x }); const t = term(bus, name, x, fromAbove ? bus.y : bus.y + bus.h, fromAbove ? "up" : "down", label); t.what = label.replace(/^.*?: /, ""); return name; };
  const rFuse = comp({ id: "rearfuse", kind: "fuse", label: `Rear fuse ${R.run.runs > 1 ? R.run.runs + " × " : ""}${R.run.fuse} A`, sub: "The run, fused at the back too", x: 32, y: yNeg - 30, w: 34, h: 14 });
  term(rFuse, "in", 49, yNeg - 30, "up", "Rear fuse in"); term(rFuse, "out", 49, yNeg - 16, "down", "Rear fuse out");
  if (c.bus || nb) { const gR = comp({ id: "gndr", kind: "ground", label: "Chassis ground", sub: "Back, bare metal", x: 318, y: yNeg - 32, w: 24, h: 16 }); term(gR, "g", 330, yNeg - 16, "down", "Rear chassis ground"); }
  // the run: main fuse, down the left side, rear fuse, then the bus bar (or the bank, or the distribution block, or the amp)
  wire({ kind: "power", from: ["mainfuse", "out"], to: ["rearfuse", "in"], lane: 40, ...R.run, label: `${wireText(R.run)} power run`, note: `About ${c.run} ft from the battery to the back, down the left side under the trim (power one side, RCAs the other). Grommet it through the firewall.${R.run.alt ? ` Thinner wire works too: ${altText(R.run)}.` : ""}` });
  if (busOn) {
    wire({ kind: "power", from: ["rearfuse", "out"], to: ["posbus", post(pos, 49, true, "Positive bus bar: the run from the front")], ...R.run, label: `${wireText(R.run)} power run (into the bus bar)` });
    wire({ kind: "ground", from: ["negbus", post(neg, 330, true, "Negative bus bar: to the chassis")], to: ["gndr", "g"], g: R.run.g, runs: R.run.runs, label: `${wireText(R.run)} ground to the chassis`, note: "As short as it can be, to bare metal near the bus bar." });
    for (const b of bank) {
      wire({ kind: "power", from: [b.id, "pos"], to: ["posbus", post(pos, b.terms.pos.x, true, `Positive bus bar: ${b.label} +`)], ...R.bankWire, runs: 1, label: `${R.bankWire.g} AWG ${b.label} +`, note: `Every battery's cable the same length, so they share the load. A ${R.bankWire.fuse} A fuse or breaker at each battery's + post.`, fuse: R.bankWire.fuse });
      wire({ kind: "ground", from: [b.id, "neg"], to: ["negbus", post(neg, b.terms.neg.x, true, `Negative bus bar: ${b.label} −`)], g: R.bankWire.g, runs: 1, label: `${R.bankWire.g} AWG ${b.label} −` });
    }
  } else if (nb) {
    // (no bus bars: the batteries linked + to + and − to −; the run in at one end, the power out of the other, the ground
    // off the first, so every battery carries its share)
    wire({ kind: "power", from: ["rearfuse", "out"], to: [bank[0].id, "pos"], ...R.run, label: `${wireText(R.run)} power run (into ${bank[0].label.toLowerCase()} +)` });
    for (let i = 0; i + 1 < nb; i++) {
      wire({ kind: "power", from: [bank[i].id, "pos"], to: [bank[i + 1].id, "pos"], ...R.bankWire, runs: 1, label: `${R.bankWire.g} AWG link, ${bank[i].label} + to ${bank[i + 1].label} +`, note: "Short, all the same length and gauge." });
      wire({ kind: "ground", from: [bank[i].id, "neg"], to: [bank[i + 1].id, "neg"], g: R.bankWire.g, runs: 1, label: `${R.bankWire.g} AWG link, ${bank[i].label} − to ${bank[i + 1].label} −` });
    }
    wire({ kind: "ground", from: [bank[0].id, "neg"], to: ["gndr", "g"], g: R.run.g, runs: R.run.runs, label: `${wireText(R.run)} ground: the bank to the chassis`, note: "From the first battery's −, the opposite end from where the power leaves, to bare metal close by." });
    wire({ kind: "power", from: [bank[nb - 1].id, "pos"], to: ["dist", post(pos, bank[nb - 1].terms.pos.x, true, `Distribution block: ${bank[nb - 1].label} +`)], ...R.bankWire, runs: 1, fuse: R.bankWire.fuse, label: `${R.bankWire.g} AWG ${bank[nb - 1].label} + to the distribution block`, note: `From the last battery's + (the other end from the run), fused ${R.bankWire.fuse} A at the battery.` });
  } else if (dist) wire({ kind: "power", from: ["rearfuse", "out"], to: ["dist", post(pos, 49, true, "Distribution block: the run from the front")], ...R.run, label: `${wireText(R.run)} power run (into the distribution block)` });
  // (an amp's ground: the negative bus bar, or bare chassis metal right by the amp)
  const ampGround = (id, x, row, label) => {
    if (busOn) return ["negbus", post(neg, x, false, `Negative bus bar: ${label}`)];
    const g = comp({ id: "gnd-" + id, kind: "ground", flip: true, label: "Chassis ground", sub: "Bare metal, under 18″ from the amp", x: x - 12, y: yFuse - 2 + row * (ampH + 46), w: 24, h: 14 });
    term(g, "g", x, g.y + 14, "down", "Chassis ground by the amp");
    return [g.id, "g"];
  };
  // the amps: 4-channel ones at the ends, the mono ones between
  const order = [];
  const monos = Array.from({ length: Math.max(0, c.mono.n | 0) }, (_, i) => ({ kind: "mono", i })), fours = Array.from({ length: n4 }, (_, i) => ({ kind: "four", i }));
  fours.forEach((f, j) => (j % 2 ? order.push(f) : order.unshift(f)));
  order.splice(Math.ceil(order.length / 2), 0, ...monos);
  const rows = Math.max(1, Math.ceil(order.length / perRow));
  const amps = [];
  order.forEach((a, k) => {
    const row = Math.floor(k / perRow), inRow = Math.min(perRow, order.length - row * perRow), col = k % perRow;
    const spacing = inRow > 1 ? Math.min(22, (W - 40 - inRow * ampW) / (inRow - 1)) : 0, total = inRow * ampW + (inRow - 1) * spacing, x = (W - total) / 2 + col * (ampW + spacing);
    const y = yAmp + row * (ampH + 46);
    const ai = R.ampI.find((x) => x.kind === a.kind && x.i === a.i) || { P: 0, I: 0, w: powerWire(1, 4) };
    const id = a.kind === "mono" ? "mono" + a.i : "four" + a.i;
    const label = a.kind === "mono" ? `Mono amp ${a.i + 1}` : `4-channel amp ${a.i + 1}`;
    const cp = comp({ id, kind: "amp", amp: a, label, sub: a.kind === "mono" ? `${c.mono.watts.toLocaleString()} W at ${c.mono.ohm} Ω` : `${c.four.watts} W × 4`, x, y, w: ampW, h: ampH, draw: ai });
    term(cp, "pos", x + 10, y, "up", `${label} +12V`); term(cp, "gnd", x + 22, y, "up", `${label} GND`); term(cp, "rem", x + 34, y, "up", `${label} REM`);
    term(cp, "rca", x + 46, y, "up", `${label} RCA in`);
    if (a.kind === "mono") { term(cp, "knob", x + 56, y, "up", `${label} bass knob port`); term(cp, "spk", x + 31, y + ampH, "down", `${label} speaker out`); }
    else for (let ch = 1; ch <= 4; ch++) term(cp, "ch" + ch, x + 10 + (ch - 1) * 14, y + ampH, "down", `${label} channel ${ch}`);
    amps.push(cp);
    // power: from the bus bar through its own fuse (or a fused output of the distribution block, or straight from the run);
    // ground: to the negative bus bar, or the chassis right by it
    const pnote = `About ${Math.round(ai.I)} A at full power${ai.w.runs > 1 ? `: ${ai.w.runs} runs, one into each of its power inputs (fuse each one)` : ""}.${ai.w.alt ? ` Or ${ai.w.alt.runs} runs of ${ai.w.alt.g} AWG, each fused ${ai.w.alt.fuse} A.` : ""}`;
    if (busOn) {
      const f = comp({ id: "fuse-" + id, kind: "fuse", label: `${label} fuse: ${ai.w.runs > 1 ? ai.w.runs + " × " : ""}${ai.w.fuse} A`, sub: `On the bus bar, for ${label.toLowerCase()}`, x: x + 10 - 18, y: yFuse + row * (ampH + 46), w: 36, h: 12, fuseOf: ai.w });
      term(f, "in", x + 10, f.y, "up", `${label} fuse in`); term(f, "out", x + 10, f.y + 12, "down", `${label} fuse out`);
      wire({ kind: "power", from: ["posbus", post(pos, x + 10, false, `Positive bus bar: ${label}`)], to: [f.id, "in"], ...ai.w, label: `${wireText(ai.w)} to ${label.toLowerCase()}'s fuse` });
      wire({ kind: "power", from: [f.id, "out"], to: [id, "pos"], ...ai.w, label: `${wireText(ai.w)} power to ${label.toLowerCase()}`, note: pnote });
    } else if (dist) wire({ kind: "power", from: ["dist", post(pos, x + 10, false, `Distribution block: ${label} (fused ${ai.w.runs > 1 ? ai.w.runs + " × " : ""}${ai.w.fuse} A)`)], to: [id, "pos"], ...ai.w, label: `${wireText(ai.w)} power to ${label.toLowerCase()} (fused ${fuseText(ai.w)})`, note: pnote });
    else wire({ kind: "power", from: ["rearfuse", "out"], to: [id, "pos"], ...R.run, label: `${wireText(R.run)} power run into ${label.toLowerCase()}`, note: `One amp: the run goes straight into it; the main fuse at the battery protects it (and a fuse near the amp if the run is long). ${pnote}` });
    wire({ kind: "ground", from: [id, "gnd"], to: ampGround(id, x + 22, row, label), ...ai.w, label: `${wireText(ai.w)} ground from ${label.toLowerCase()}`, note: busOn ? "The same size as its power wire." : "The same size as its power wire, to bare chassis metal under 18″ from the amp (sand off the paint)." });
  });
  const lastAmpY = yAmp + (rows - 1) * (ampH + 46) + ampH;

  // ---- remote: the head unit (or LOC) to every amp (through a relay with more than 3)
  if (nAmps) {
    if (nAmps > 3) {
      const ry = yNeg - 30;
      const rl = comp({ id: "relay", kind: "relay", label: "Remote relay", sub: "Turns every amp on", x: 278, y: ry, w: 30, h: 14 });
      term(rl, "trig", 288, ry, "up", "Relay coil (86)"); term(rl, "pwr", 278, ry + 7, "left", "Relay 12V in (30)"); term(rl, "out", 300, ry + 14, "down", "Relay out (87)");
      wire({ kind: "remote", from: [src.id, "rem"], to: ["relay", "trig"], lane: 204, g: "18", label: "Remote to the relay", note: "18 AWG, with the RCAs (the signal side)." });
      wire({ kind: "power", from: [pos.id, post(pos, 270, true, `${posName}: the relay`)], to: ["relay", "pwr"], g: "14", runs: 1, fuse: 10, label: "14 AWG relay power (10 A fuse)" });
      for (const a of amps) wire({ kind: "remote", from: ["relay", "out"], to: [a.id, "rem"], lane: 318, g: "18", label: `Remote to ${a.label.toLowerCase()}` });
    } else amps.forEach((a, i) => wire({ kind: "remote", from: i ? [amps[i - 1].id, "rem"] : [src.id, "rem"], to: [a.id, "rem"], lane: i ? null : 204, g: "18", label: i ? `Remote, ${amps[i - 1].label.toLowerCase()} to ${a.label.toLowerCase()}` : `Remote to ${a.label.toLowerCase()}`, note: i ? "Daisy-chained: a short jumper from the last amp's REM." : "18 AWG blue, from the head unit's remote out (blue/white), down the RCA side." }));
  }
  // ---- RCAs: sub pre-out to the mono amps (one into the next), front and rear to the 4-channel amps
  const monoAmps = amps.filter((a) => a.amp.kind === "mono").sort((a, b) => a.amp.i - b.amp.i);
  monoAmps.forEach((a, i) => wire({ kind: "rca", from: i ? [monoAmps[i - 1].id, "rca"] : [src.id, "rcaS"], to: [a.id, "rca"], lane: i ? null : 200, label: i ? `RCA, ${monoAmps[i - 1].label.toLowerCase()}'s RCA out to ${a.label.toLowerCase()}` : `Sub RCA to ${a.label.toLowerCase()}`, note: i ? "From the first amp's RCA out (pass-through), or a Y-splitter." : "Twisted-pair RCA down the center, away from the power wire." }));
  const fourAmps = amps.filter((a) => a.amp.kind === "four");
  for (const a of fourAmps) {
    const doors = new Set(R.spk.chans.filter((x) => x.amp === a.amp.i).map((x) => x.door));
    const front = doors.has("fl") || doors.has("fr"), rear = doors.has("rl") || doors.has("rr");
    if (front || !rear) wire({ kind: "rca", from: [src.id, "rcaF"], to: [a.id, "rca"], lane: 196, label: `Front RCA to ${a.label.toLowerCase()}`, note: rear ? "Front into channels 1 and 2 (rear into 3 and 4)." : "" });
    if (rear) wire({ kind: "rca", from: [src.id, "rcaR"], to: [a.id, "rca"], lane: 192, label: `Rear RCA to ${a.label.toLowerCase()}` });
  }
  // ---- the bass knob, to the first mono amp
  if (knob && monoAmps[0]) wire({ kind: "knob", from: ["knob", "rj"], to: [monoAmps[0].id, "knob"], lane: 208, label: `Bass knob to ${monoAmps[0].label.toLowerCase()}`, note: "The knob's cable (RJ plug) along the RCA side." });
  // ---- voltmeters
  vms.forEach((v, i) => {
    const rear = i === 0 && nb;
    if (rear && busOn) {
      wire({ kind: "sense", from: [v.id, "plus"], to: ["posbus", post(pos, 300 - i * 6, true, `Positive bus bar: voltmeter ${i + 1}`)], lane: 34, g: "18", fuse: 2, label: `Voltmeter ${i + 1} sense + (2 A fuse)`, note: `18 AWG with a 2 A inline fuse at the bus bar: it reads the ${R.bankName.toLowerCase()} bank.` });
      wire({ kind: "ground", from: [v.id, "minus"], to: ["negbus", post(neg, 306 - i * 6, true, `Negative bus bar: voltmeter ${i + 1}`)], lane: 30, g: "18", runs: 1, label: `Voltmeter ${i + 1} −`, note: "Grounded at the same bus bar as it reads, for a true reading." });
    } else if (rear) {
      wire({ kind: "sense", from: [v.id, "plus"], to: [bank[nb - 1].id, "pos"], lane: 34, g: "18", fuse: 2, label: `Voltmeter ${i + 1} sense + (2 A fuse)`, note: `18 AWG with a 2 A inline fuse at the battery: it reads the ${R.bankName.toLowerCase()} bank.` });
      wire({ kind: "ground", from: [v.id, "minus"], to: [bank[0].id, "neg"], lane: 30, g: "18", runs: 1, label: `Voltmeter ${i + 1} −`, note: "Grounded at the bank it reads, for a true reading." });
    } else if (i <= 1 || !c.big3) {
      wire({ kind: "sense", from: [v.id, "plus"], to: ["batt", "pos2"], g: "18", fuse: 2, label: `Voltmeter ${i + 1} sense + (2 A fuse)`, note: "18 AWG with a 2 A inline fuse at the battery: it reads the front battery." });
      wire({ kind: "ground", from: [v.id, "minus"], to: ["gndf", "g"], g: "18", runs: 1, label: `Voltmeter ${i + 1} −` });
    } else {
      wire({ kind: "sense", from: [v.id, "plus"], to: ["alt", "out"], g: "18", fuse: 2, label: `Voltmeter ${i + 1} sense + (2 A fuse)`, note: "Reads the alternator's output." });
      wire({ kind: "ground", from: [v.id, "minus"], to: ["gndf", "g"], g: "18", runs: 1, label: `Voltmeter ${i + 1} −` });
    }
    if (nAmps) wire({ kind: "remote", from: [v.id, "trig"], to: [src.id, "rem"], g: "18", label: `Voltmeter ${i + 1} on with the system`, note: "Its power/trigger wire on the remote, so it's on only when the system is." });
  });

  // ---- the sub box: a terminal cup for each mono amp's subs
  let box = null;
  if (c.subs.n) {
    const perLine = 8, lines = Math.ceil(c.subs.n / perLine), yBox = lastAmpY + 26, bh = 26 + lines * 30;
    box = comp({ id: "box", kind: "box", label: "Sub box", sub: `${c.subs.n} × ${c.subs.size}″ ${c.subs.coil}`, x: 26, y: yBox, w: W - 52, h: bh, subs: c.subs.n, perLine });
    for (const s of R.subs) {
      const a = monoAmps.find((m) => m.amp.i === s.amp);
      if (!a) continue;
      const tx = a.terms.spk.x;
      term(box, "cup" + s.amp, tx, yBox, "up", `Sub box terminal ${s.amp + 1}`);
      const g = spkGauge(s.I);
      wire({ kind: "sub", from: [a.id, "spk"], to: ["box", "cup" + s.amp], g, label: `${g} AWG speaker wire: ${a.label.toLowerCase()} to its ${s.k} sub${s.k > 1 ? "s" : ""} (${s.load} Ω)`, note: `${s.how}. About ${Math.round(s.P).toLocaleString()} W into ${s.load} Ω (${Math.round(s.I)} A).`, plan: s });
    }
  }
  // ---- speakers: each channel to its speakers
  const lanes = { fl: 50, rl: 56, fr: 310, rr: 304 };
  const laneUse = new Map();
  for (const ch of R.spk.chans) {
    const a = fourAmps.find((x) => x.amp.i === ch.amp); if (!a) continue;
    const I = Math.sqrt(c.four.watts * Math.min(2, 4 / Math.max(ch.load, 1)) / Math.max(ch.load, 0.5)), g = spkGauge(I);
    for (const s of ch.spk) {
      const cp = spkComps.get(s.id); if (!cp) continue;
      // (each door's wires up its own side, a little apart)
      const sd = s.id.slice(0, 2), left = sd === "fl" || sd === "rl", k = laneUse.get(sd) || 0; laneUse.set(sd, k + 1);
      const lane = lanes[sd] + (left ? 1 : -1) * (k % 6) * 2.4;
      wire({ kind: s.id.slice(0, 2), from: [a.id, "ch" + ch.ch], to: [cp.id, "t"], lane, g, label: `${g} AWG speaker wire: ${a.label.toLowerCase()} channel ${ch.ch} to the ${cp.label.toLowerCase()}`, note: `${ch.spk.length > 1 ? `${ch.spk.length} speakers on this channel: ${ch.how.toLowerCase()} (${ch.load} Ω).` : `On its own channel (${ch.load} Ω).`}${s.role.includes("tweeter") ? " A tweeter needs its crossover (or the amp's high-pass around 3.5 kHz) so bass can't reach it." : ""} Through the door's rubber boot.` });
    }
  }
  if (R.spk.head) {
    for (const d of R.spk.doors) for (const s of d.list) {
      const cp = spkComps.get(s.id); if (!cp) continue;
      wire({ kind: d.d, from: ["hu", "spk"], to: [cp.id, "t"], lane: lanes[d.d], g: "16", label: `16 AWG: the head unit to the ${cp.label.toLowerCase()}`, note: "No 4-channel amp: the head unit powers the door speakers itself." });
    }
  }
  for (const bus of [neg, pos].filter(Boolean)) [...bus.posts].sort((a, b) => a.x - b.x).forEach((p, i) => { const t = bus.terms[p.name]; t.post = i + 1; t.label = `${bus.label}, post ${i + 1} (${t.what})`; });
  const H = Math.max(box ? box.y + box.h + 22 : lastAmpY + 30, 760);
  return { comps, wires, H, yTrunk: 470 };
}
/** A wire's path: out of its first terminal, along its lane (if it has one), into the other. */
function path(wr, comps, idx) {
  const A = comps.get(wr.from[0]).terms[wr.from[1]], B = comps.get(wr.to[0]).terms[wr.to[1]];
  if (!A || !B) return null;
  const stub = 6 + (idx % 6) * 2;
  const out = (p) => (p.dir === "up" ? [p.x, p.y - stub] : p.dir === "down" ? [p.x, p.y + stub] : p.dir === "left" ? [p.x - stub, p.y] : [p.x + stub, p.y]);
  const a1 = out(A), b1 = out(B);
  let pts;
  if (A.x === B.x && (A.dir === "down" || A.dir === "up") && (B.dir === "up" || B.dir === "down")) pts = [[A.x, A.y], [B.x, B.y]];
  else if (wr.lane != null) pts = [[A.x, A.y], a1, [wr.lane, a1[1]], [wr.lane, b1[1]], b1, [B.x, B.y]];
  else pts = [[A.x, A.y], a1, [b1[0], a1[1]], b1, [B.x, B.y]];
  return { pts, A, B };
}

// ---------------------------------------------------------------------------------------------------- the screen
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sv = (tag, attrs = {}, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
let root = null, R = null, Lay = null;

/** The My system screen, in el. box(): what the box designer has (its subs), to start from. */
export function mountSystem(el, box) {
  root = el; getBox = box; S = S || load();
  paint();
}
function stepper(label, get, set, min, max, step = 1, unit = "") {
  const wrap = h("div", "sy-step");
  const l = h("span", "sy-sl", label);
  const minus = h("button", "btn small", "−"), plus = h("button", "btn small", "+"), val = h("input", "input sy-val");
  minus.type = plus.type = "button"; val.inputMode = "numeric"; val.value = get(); val.setAttribute("aria-label", label);
  const put = (v) => { v = Math.max(min, Math.min(max, Math.round(v / step) * step)); if (!isFinite(v)) return; set(v); save(); paint(); };
  minus.onclick = () => put(get() - step); plus.onclick = () => put(get() + step);
  val.onchange = () => put(parseFloat(val.value));
  const row = h("div", "sy-sr"); row.append(minus, val, plus);
  if (unit) row.append(h("small", "", unit));
  wrap.append(l, row);
  return wrap;
}
function chooser(label, items, get, set) {
  const wrap = h("div", "sy-step"); wrap.append(h("span", "sy-sl", label));
  const s = h("div", "seg sy-seg");
  for (const [k, t] of items) { const b = h("button", String(get()) === String(k) ? "on" : "", t); b.type = "button"; b.onclick = () => { set(k); save(); paint(); }; s.append(b); }
  wrap.append(s);
  return wrap;
}
function card(title, sub, ...kids) {
  const c = h("div", "card sec sy-card"); const hd = h("div", "sy-ch"); hd.append(h("b", "", title)); if (sub) hd.append(h("small", "", sub));
  c.append(hd, ...kids); return c;
}
function paint() {
  if (!root) return;
  R = compute(S); Lay = layout(S, R);
  const keepY = root.closest(".view") ? root.closest(".view").scrollTop : 0;
  root.replaceChildren();
  // what you're running
  const quick = h("div", "chips sy-quick");
  const ex = h("button", "chip", "Load the example (a big build)"); ex.type = "button"; ex.onclick = () => { S = structuredClone(EXAMPLE); sel = null; save(); paint(); toast("4 15s, 2 8,000 W amps, 2 4-channel amps, a lithium bank, 3 speakers in every door"); };
  const fromBox = h("button", "chip", "Use my box's subs"); fromBox.type = "button";
  fromBox.onclick = () => { const b = getBox && getBox(); if (!b) return; S.subs = { n: b.count, size: b.size, coil: b.coil, rms: b.rms }; save(); paint(); toast(`${b.count} × ${b.name}`); };
  const reset = h("button", "chip", "Start over"); reset.type = "button"; reset.onclick = () => { S = defaults(); sel = null; save(); paint(); };
  quick.append(ex, fromBox, reset);
  root.append(card("What you're running", "Set it up like your car: the diagram and the wiring follow", quick,
    chooser("Head unit", [["aftermarket", "Aftermarket"], ["stock", "Factory radio"]], () => S.head, (v) => (S.head = v))),
  card("Subs", "", h("div", "sy-grid", ""),
  ), card("Amps", ""), card("Speakers", ""), card("Power", ""), card("Extras", ""));
  const [, subsC, ampsC, spkC, powC, exC] = root.children;
  const g = (c, ...kids) => { const d = h("div", "sy-grid"); d.append(...kids); c.querySelector(".sy-grid") ? c.querySelector(".sy-grid").replaceWith(d) : c.append(d); };
  g(subsC, stepper("How many", () => S.subs.n, (v) => (S.subs.n = v), 0, 20), stepper("Size", () => S.subs.size, (v) => (S.subs.size = v), 6, 21, 1, "in"),
    chooser("Voice coils", [["D1", "D1"], ["D2", "D2"], ["D4", "D4"], ["S2", "S2"], ["S4", "S4"]], () => S.subs.coil, (v) => (S.subs.coil = v)),
    stepper("RMS each", () => S.subs.rms, (v) => (S.subs.rms = v), 50, 20000, 50, "W"));
  g(ampsC, stepper("Mono (sub) amps", () => S.mono.n, (v) => (S.mono.n = v), 0, 6), stepper("Each one's RMS", () => S.mono.watts, (v) => (S.mono.watts = v), 100, 50000, 100, "W"),
    chooser("Stable down to", [["0.5", "½ Ω"], ["1", "1 Ω"], ["2", "2 Ω"], ["4", "4 Ω"]], () => S.mono.ohm, (v) => (S.mono.ohm = +v)),
    stepper("4-channel amps", () => S.four.n, (v) => (S.four.n = v), 0, 4), stepper("Watts per channel", () => S.four.watts, (v) => (S.four.watts = v), 25, 1000, 5, "W"),
    chooser("4-channel stable to", [["2", "2 Ω"], ["4", "4 Ω"]], () => S.four.ohm, (v) => (S.four.ohm = +v)));
  g(spkC, stepper("Speakers in each front door", () => S.spk.front, (v) => (S.spk.front = v), 0, 4), stepper("In each rear door", () => S.spk.rear, (v) => (S.spk.rear = v), 0, 4),
    stepper("Dash tweeters (each side)", () => S.spk.tw, (v) => (S.spk.tw = v), 0, 2), chooser("Speaker impedance", [["2", "2 Ω"], ["4", "4 Ω"], ["8", "8 Ω"]], () => S.spk.ohm, (v) => (S.spk.ohm = +v)));
  g(powC, chooser("Rear batteries", [["lithium", "Lithium"], ["agm", "AGM"]], () => S.bank.type || "lithium", (v) => (S.bank.type = v)),
    stepper("How many in the back", () => S.bank.n, (v) => (S.bank.n = v), 0, 20), stepper("Each battery", () => S.bank.ah, (v) => (S.bank.ah = v), 10, 600, 5, "Ah"),
    chooser("Bus bars", [["true", "Yes"], ["false", "No"]], () => String(!!S.bus), (v) => (S.bus = v === "true")),
    stepper("Alternator", () => S.alt, (v) => (S.alt = v), 60, 1000, 10, "A"), stepper("Battery to the back", () => S.run, (v) => (S.run = v), 4, 40, 1, "ft"),
    chooser("Big 3 upgrade", [["true", "Yes"], ["false", "No"]], () => String(S.big3), (v) => (S.big3 = v === "true")));
  g(exC, chooser("Bass knob", [["true", "Yes"], ["false", "No"]], () => String(S.knob), (v) => (S.knob = v === "true")), stepper("Voltmeters", () => S.vm, (v) => (S.vm = v), 0, 3));

  // the numbers
  const sum = h("div", "card sec sy-card sy-sum");
  const tiles = h("div", "sy-tiles");
  const tl = (k, v, n, cls = "") => { const t = h("div", "bx-tile " + cls); t.append(h("small", "", k), h("b", "", v)); if (n) t.append(h("span", "", n)); tiles.append(t); };
  tl("Total power", `${Math.round(R.P).toLocaleString()} W`, `into the speakers as wired · amps rated ${Math.round(R.rated).toLocaleString()} W`);
  tl("Draw at full power", `${Math.round(R.I).toLocaleString()} A`, `alternator spares about ${R.altFree} A`, R.deficit > 0 && !R.bankAh ? "bad" : "");
  tl("Power run", wireText(R.run), `${S.run} ft, fused ${R.run.runs > 1 ? R.run.runs + " × " : ""}${R.run.fuse} A at both ends${R.run.alt ? ` · or ${R.run.alt.runs} runs of ${R.run.alt.g} AWG with ${R.run.alt.runs} × ${R.run.alt.fuse} A fuses` : ""}`);
  if (R.bankAh) tl(`${R.bankName} bank`, `${R.bankAh} Ah`, R.deficit > 0 ? `full power for about ${R.minutes < 1 ? "<1" : Math.round(R.minutes)} min (music: much longer)` : "the alternator keeps up");
  for (const s of R.subs) tl(`Mono amp ${s.amp + 1}`, `${s.load} Ω`, `${s.k} sub${s.k > 1 ? "s" : ""}, about ${Math.round(s.P).toLocaleString()} W`, s.under ? "bad" : "");
  sum.append(h("div", "sy-ch", ""), tiles);
  sum.firstChild.append(h("b", "", "Your system, worked out"), h("small", "", "Tap anything in the diagram for exactly how it's wired"));
  for (const w of R.warn) sum.append(h("p", "bx-warn sy-warn", w));
  for (const t of R.tips) sum.append(h("p", "status sy-tip", t));
  root.append(sum);

  // the diagram
  const dg = h("div", "card sec sy-card sy-diag");
  const head = h("div", "sy-dh"); head.append(h("b", "", "Wiring diagram"));
  const zm = h("div", "seg sy-zoom"); for (const [k, t] of [["1", "Fit"], ["1.6", "Bigger"], ["2.4", "Biggest"]]) { const b = h("button", String(zoom) === k ? "on" : "", t); b.type = "button"; b.onclick = () => { zoom = +k; paintDiagram(); zm.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); }; zm.append(b); }
  head.append(zm);
  const key = h("div", "sy-key");
  for (const [k, t] of [["power", "Power"], ["ground", "Ground"], ["remote", "Remote"], ["rca", "RCA"], ["sub", "Subs"], ["fl", "Front speakers"], ["rl", "Rear speakers"], ["knob", "Bass knob"], ["sense", "Voltmeter"]]) {
    const i = h("span", "sy-ki"); const sw = h("i", ""); sw.style.background = COLORS[k]; if (k === "ground") sw.style.outline = "1px solid #8a8fa8"; i.append(sw, t); key.append(i);
  }
  const scroller = h("div", "sy-scroll"); scroller.id = "sy-scroll";
  const info = h("div", "sy-info"); info.id = "sy-info";
  dg.append(head, key, scroller, info);
  root.append(dg);
  paintDiagram();
  paintInfo();
  if (root.closest(".view")) root.closest(".view").scrollTop = keepY;
}
function paintDiagram() {
  const box = $("sy-scroll"); if (!box) return;
  const { comps, wires, H, yTrunk } = Lay;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "sy-svg", role: "img", "aria-label": "Wiring diagram of the car from above: tap a part or a wire" });
  svg.style.width = `${zoom * 100}%`;
  // the car
  const body = sv("g", { class: "sy-car" });
  body.append(sv("rect", { x: 6, y: 6, width: W - 12, height: H - 12, rx: 46, class: "sy-body" }));
  body.append(sv("path", { d: `M 40 150 Q ${W / 2} 128 ${W - 40} 150`, class: "sy-line" }), sv("path", { d: `M 40 ${yTrunk} Q ${W / 2} ${yTrunk - 14} ${W - 40} ${yTrunk}`, class: "sy-line" }));
  for (const [y0, y1] of [[232, 332], [350, 450]]) { body.append(sv("rect", { x: 8, y: y0, width: 26, height: y1 - y0, rx: 6, class: "sy-door" }), sv("rect", { x: W - 34, y: y0, width: 26, height: y1 - y0, rx: 6, class: "sy-door" })); }
  for (const [t, y] of [["ENGINE BAY", 22], ["DASH", 146], ["FRONT DOORS", 228], ["REAR DOORS", 346], ["TRUNK", yTrunk + 6]]) body.append(sv("text", { x: W / 2, y, class: "sy-zone" }, t));
  svg.append(body);
  // the wires (a wide invisible line over each, to tap)
  const wg = sv("g", { class: "sy-wires" }), hit = sv("g", { class: "sy-hits" });
  wires.forEach((wr, i) => {
    const p = path(wr, comps, i); if (!p) return;
    wr.p = p;
    const d = "M " + p.pts.map((q) => q.join(" ")).join(" L ");
    const g = sv("g", { class: `sy-w sy-${wr.kind}`, "data-w": wr.id });
    const th = wr.kind === "power" || wr.kind === "ground" ? (wr.g === "18" || wr.g === "14" ? 1.2 : 2.6) : wr.kind === "sub" ? 2 : 1.2;
    if (wr.kind === "ground") g.append(sv("path", { d, class: "sy-case", "stroke-width": th + 1.6 }));
    g.append(sv("path", { d, class: "sy-wire", stroke: COLORS[wr.kind] || COLORS[wr.kind.slice(0, 2)] || "#ccc", "stroke-width": th }));
    wg.append(g);
    const hp = sv("path", { d, class: "sy-hit", "data-w": wr.id }); hp.onclick = (e) => { e.stopPropagation(); pick({ wire: wr.id }); }; hit.append(hp);
  });
  svg.append(wg);
  // the parts
  const pg = sv("g", { class: "sy-parts" });
  for (const cp of comps.values()) {
    const g = sv("g", { class: `sy-c sy-${cp.kind}`, "data-c": cp.id, tabindex: "0", role: "button", "aria-label": cp.label });
    if (cp.kind === "ground") {
      const x = cp.x + cp.w / 2, y = cp.y;
      const d = cp.flip ? `M ${x} ${y + 14} V ${y + 8} M ${x - 10} ${y + 8} H ${x + 10} M ${x - 6} ${y + 4} H ${x + 6} M ${x - 2} ${y} H ${x + 2}` : `M ${x} ${y} V ${y + 6} M ${x - 10} ${y + 6} H ${x + 10} M ${x - 6} ${y + 10} H ${x + 6} M ${x - 2} ${y + 14} H ${x + 2}`;
      g.append(sv("rect", { x: cp.x - 4, y: cp.y - 4, width: cp.w + 8, height: cp.h + 8, class: "sy-pad" }), sv("path", { d, class: "sy-gnd" }));
    } else if (cp.round) g.append(sv("circle", { cx: cp.x + cp.w / 2, cy: cp.y + cp.h / 2, r: cp.w / 2, class: "sy-shape" }));
    else g.append(sv("rect", { x: cp.x, y: cp.y, width: cp.w, height: cp.h, rx: cp.kind === "bus" ? 2 : 5, class: "sy-shape" }));
    if (cp.kind === "box") {
      const n = cp.subs, per = cp.perLine, r = Math.min(12, (cp.w - 20) / per / 2 - 2);
      for (let i = 0; i < n; i++) { const row = Math.floor(i / per), inRow = Math.min(per, n - row * per), col = i % per; const sx = cp.x + cp.w / 2 + (col - (inRow - 1) / 2) * (2 * r + 6), sy = cp.y + 22 + row * 30; g.append(sv("circle", { cx: sx, cy: sy, r, class: "sy-sub" }), sv("circle", { cx: sx, cy: sy, r: r * 0.35, class: "sy-subcap" })); }
    }
    if (cp.kind === "bus") for (const pst of cp.posts) g.append(sv("circle", { cx: pst.x, cy: cp.y + cp.h / 2, r: 2.6, class: "sy-post" }));
    if (cp.kind === "lithium") g.append(sv("text", { x: cp.x + 8, y: cp.y + 10, class: "sy-tt" }, "+"), sv("text", { x: cp.x + 26, y: cp.y + 10, class: "sy-tt" }, "−"));
    // its name
    const lx = cp.kind === "speaker" ? (cp.x < W / 2 ? cp.x + cp.w + 18 : cp.x - 10) : cp.x + cp.w / 2;
    let ly = cp.kind === "bus" ? cp.y - 2 : cp.kind === "speaker" ? cp.y + cp.h / 2 + 3 : cp.kind === "box" ? cp.y + cp.h - 6 : cp.y + cp.h / 2 + 3;
    let anchor = cp.kind === "speaker" ? (cp.x < W / 2 ? "start" : "end") : "middle";
    // (the front ground's name beside it; the back one's above it, clear of the relay)
    const rearG = cp.id === "gndr";
    if (cp.kind === "ground") { anchor = rearG ? "middle" : "start"; ly = rearG ? cp.y - 5 : cp.y + 12; }
    const gx = cp.kind === "ground" ? (rearG ? cp.x + cp.w / 2 : cp.x + cp.w + 2) : null;
    const short = cp.kind === "amp" ? cp.label.replace("4-channel amp", "4-ch").replace("Mono amp", "Mono") : cp.kind === "speaker" ? cp.label.split(" ").slice(-1)[0] : cp.kind === "fuse" ? cp.label.replace(/^.*?fuse:? ?/i, "") : cp.kind === "lithium" ? "" : cp.kind === "vm" ? "V" + (+cp.id.slice(2) + 1) : cp.kind === "relay" ? "Relay" : cp.id === "gndr" ? "Ground" : cp.flip ? "" : cp.label;
    if (short && cp.kind !== "bus") g.append(sv("text", { x: gx != null ? gx : lx, y: ly, class: "sy-lab" + (cp.kind === "fuse" || cp.kind === "vm" ? " sm" : ""), "text-anchor": anchor }, short));
    if (cp.kind === "bus") g.append(sv("text", { x: cp.x + 40, y: cp.y - 2, class: "sy-lab sm", "text-anchor": "start" }, cp.label));
    if (cp.kind === "amp") g.append(sv("text", { x: cp.x + cp.w / 2, y: cp.y + cp.h / 2 + 12, class: "sy-lab sm", "text-anchor": "middle" }, cp.amp.kind === "mono" ? `${(S.mono.watts / 1000).toFixed(S.mono.watts % 1000 ? 1 : 0)}k W` : `${S.four.watts} W × 4`));
    g.onclick = (e) => { e.stopPropagation(); pick({ comp: cp.id }); };
    g.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick({ comp: cp.id }); } };
    pg.append(g);
  }
  svg.append(pg, hit);
  // the ends of what's picked: lit up, with their names
  svg.append(sv("g", { class: "sy-ends", id: "sy-ends" }));
  svg.onclick = () => pick(null);
  box.replaceChildren(svg);
  light();
}
function pick(s) { sel = s; light(); paintInfo(); }
/** What's picked, lit: its wires bright, the rest faded, the ends of the wires marked. */
function light() {
  const svg = document.querySelector(".sy-svg"); if (!svg) return;
  const on = new Set(), parts = new Set();
  if (sel && sel.wire) { on.add(sel.wire); const w = Lay.wires.find((x) => x.id === sel.wire); if (w) { parts.add(w.from[0]); parts.add(w.to[0]); } }
  if (sel && sel.comp) { parts.add(sel.comp); for (const w of Lay.wires) if (w.from[0] === sel.comp || w.to[0] === sel.comp) on.add(w.id); }
  svg.classList.toggle("picking", !!sel);
  svg.querySelectorAll(".sy-w").forEach((g) => g.classList.toggle("on", on.has(g.dataset.w)));
  svg.querySelectorAll(".sy-c").forEach((g) => g.classList.toggle("on", parts.has(g.dataset.c) || (sel && sel.comp === g.dataset.c)));
  const ends = svg.querySelector("#sy-ends"); ends.replaceChildren();
  const one = sel && sel.wire;
  for (const id of on) {
    const w = Lay.wires.find((x) => x.id === id); if (!w || !w.p) continue;
    const mark = (t, label, kind) => {
      ends.append(sv("circle", { cx: t.x, cy: t.y, r: 7, class: "sy-end " + kind }), sv("circle", { cx: t.x, cy: t.y, r: 3, class: "sy-endc " + kind }));
      if (one) {
        const right = t.x < W / 2, tx = t.x + (right ? 10 : -10), ty = t.y + (kind === "from" ? -10 : 14);
        const txt = sv("text", { x: tx, y: ty, class: "sy-endl", "text-anchor": right ? "start" : "end" }, `${kind === "from" ? "From" : "To"}: ${label}`);
        ends.append(txt);
        try { const b = txt.getBBox(); ends.insertBefore(sv("rect", { x: b.x - 3, y: b.y - 1.5, width: b.width + 6, height: b.height + 3, rx: 4, class: "sy-endbg " + kind }), txt); } catch {}
      }
    };
    mark(w.p.A, w.p.A.label, "from"); mark(w.p.B, w.p.B.label, "to");
  }
}
/** What's picked, in words: a part's details, its connections (tap one to light it) and how to wire it; a wire's two
 * ends, gauge, fuse and notes. */
function paintInfo() {
  const box = $("sy-info"); if (!box) return;
  box.replaceChildren();
  if (!sel) { box.append(h("p", "status", "Tap a part (the battery, a bus bar, an amp, the head unit…) or any wire.")); return; }
  if (sel.wire) {
    const w = Lay.wires.find((x) => x.id === sel.wire); if (!w || !w.p) return;
    box.append(h("b", "sy-it", w.label));
    const ends = h("div", "sy-ends2");
    const end = (cls, t, cid) => { const b = h("button", "sy-endb " + cls); b.type = "button"; b.append(h("small", "", cls === "from" ? "From" : "To"), h("span", "", t)); b.onclick = () => pick({ comp: cid }); return b; };
    ends.append(end("from", w.p.A.label, w.from[0]), end("to", w.p.B.label, w.to[0]));
    box.append(ends);
    const facts = [];
    if (w.g) facts.push(`${w.runs > 1 ? w.runs + " runs of " : ""}${w.g} AWG${w.kind === "power" || w.kind === "ground" ? " OFC copper" : ""}`);
    if (w.alt && (w.kind === "power" || w.kind === "ground")) facts.push(altText(w, false));
    if (w.fuse) facts.push(`fused ${w.runs > 1 ? w.runs + " × " : ""}${w.fuse} A${w.alt && w.kind === "power" ? ` (or ${w.alt.runs} × ${w.alt.fuse} A on the ${w.alt.g} runs)` : ""}`);
    if (w.kind === "rca") facts.push("twisted-pair RCA");
    if (facts.length) box.append(h("p", "sy-facts", facts.join(" · ")));
    if (w.note) box.append(h("p", "status", w.note));
    if (w.plan) box.append(subWiringDiagram(w.plan));
    return;
  }
  const cp = Lay.comps.get(sel.comp); if (!cp) return;
  box.append(h("b", "sy-it", cp.label), h("p", "sy-facts", describe(cp)));
  const mine = Lay.wires.filter((w) => w.from[0] === cp.id || w.to[0] === cp.id);
  if (mine.length) {
    box.append(h("span", "label", "Connections (tap one)"));
    const list = h("div", "sy-conns");
    for (const w of mine) {
      const other = w.from[0] === cp.id ? w.p && w.p.B : w.p && w.p.A, here = w.from[0] === cp.id ? w.p && w.p.A : w.p && w.p.B;
      const b = h("button", "sy-conn"); b.type = "button";
      const sw = h("i", ""); sw.style.background = COLORS[w.kind] || COLORS[w.kind.slice(0, 2)] || "#ccc";
      const mineEnd = here ? (cp.kind === "bus" ? `Post ${here.post}` : here.label.replace(cp.label + " ", "").replace(cp.label + ": ", "")) : "";
      b.append(sw, h("span", "", `${mineEnd} → ${other ? other.label : ""}`), h("small", "", w.label));
      b.onclick = () => pick({ wire: w.id });
      list.append(b);
    }
    box.append(list);
  }
  if (cp.kind === "bus") {
    box.append(h("span", "label", "Its posts, left to right"));
    const ol = h("ol", "sy-steps sy-posts");
    for (const pst of [...cp.posts].sort((a, b) => a.x - b.x)) {
      const w = Lay.wires.find((x) => (x.from[0] === cp.id && x.from[1] === pst.name) || (x.to[0] === cp.id && x.to[1] === pst.name));
      const li = h("li", ""); const b = h("button", "sy-postb", cp.terms[pst.name].what); b.type = "button";
      if (w) { b.onclick = () => pick({ wire: w.id }); li.append(b, h("small", "", " " + w.label)); } else li.append(b);
      ol.append(li);
    }
    box.append(ol);
  }
  const steps = howTo(cp);
  if (steps.length) { box.append(h("span", "label", "How to wire it")); const ol = h("ol", "sy-steps"); for (const s of steps) ol.append(h("li", "", s)); box.append(ol); }
  if (cp.kind === "box") for (const s of R.subs) box.append(subWiringDiagram(s));
}
function describe(cp) {
  if (cp.kind === "amp") { const d = cp.draw; return `${cp.sub} · about ${Math.round(d.P).toLocaleString()} W into its speakers as wired · draws about ${Math.round(d.I).toLocaleString()} A at full power · power and ground: ${wireText(d.w)}${d.w.alt ? ` (${altText(d.w, false)})` : ""}, fused ${fuseText(d.w)}`; }
  if (cp.kind === "fuse") { const w = cp.fuseOf || R.run; return `${cp.sub} · ${fuseText(w)}`; }
  if (cp.kind === "bus") return `${cp.sub} · ${cp.posts.length} posts used`;
  if (cp.kind === "lithium") return `${cp.sub} · the bank: ${R.bankAh} Ah ${R.bankName === "AGM" ? "AGM" : "lithium"} in all, in parallel`;
  return cp.sub || "";
}
function howTo(cp) {
  const run = R.run;
  switch (cp.kind) {
    case "battery": return ["Disconnect the battery's − cable before you start, and put it back last.", `Main fuse within 18″ of the + post: ${fuseText(run)}, then the ${wireText(run)} run to the back${run.alt ? ` (${altText(run, false)})` : ""}.`, ...(S.big3 ? ["Big 3: alternator B+ to battery + (fused), battery − to the chassis, engine block to the chassis, each at least as thick as the run."] : []), "Crimp ring lugs (don't just solder), heat-shrink every end."];
    case "fuse": { const w = cp.fuseOf || R.run; return ["Mount it solidly, close to where its wire starts (the battery, or the bus bar).", ...(w.alt ? [`Split it if you like: ${w.alt.runs} runs of ${w.alt.g} AWG, each with its own ${w.alt.fuse} A fuse, instead of ${wireText(w)} on ${w.runs > 1 ? w.runs + " × " : "one "}${w.fuse} A.`] : []), "The fuse protects the wire: never put in a bigger one than this.", "Leave the fuse out until everything's connected, then put it in last."]; }
    case "alt": return [`Its output: ${S.alt} A, about ${R.altFree} A to spare for the system (the car takes about ${CAR_LOAD} A).`, R.deficit > 0 ? `At full power the system needs about ${Math.round(R.I)} A: ${R.bankAh ? "the bank covers the rest, in bursts" : "add a bigger alternator or a battery bank"}.` : "It keeps up with the system at full power."];
    case "ground": return ["Sand to bare metal (no paint, no seat bolts).", "Ring lug, star washer, bolted tight; a little dielectric grease over it after.", "As short as it can be: under 18″."];
    case "head": return S.head === "stock" ? ["Keep the factory radio: a line output converter takes its speaker wires (front, rear) and makes RCAs and a remote signal.", "Set the LOC's input level to the radio's volume at about 3/4."]
      : ["At its back: SUB pre-out to the mono amp(s), FRONT and REAR pre-outs to the 4-channel amp(s).", "Remote out (blue/white) to every amp's REM, down the same side as the RCAs.", "Set its sub pre-out to 4–5 V if it has the option, and its crossover off (the amps do it)."];
    case "loc": return ["Its inputs on the factory radio's front and rear speaker wires.", "Its RCAs to the amps; its remote out (signal-sensing) to every amp's REM."];
    case "knob": return ["Mount it in reach of the driver.", "Its cable (an RJ plug) into the first mono amp's remote/bass level port, along the RCA side.", "It turns the sub amp down from where its gain is set: set the gain with the knob all the way up."];
    case "vm": return ["Sense +: 18 AWG with a 2 A inline fuse, to what it reads (the bank's + bus bar, or the battery).", "−: to the ground nearest what it reads.", "Its power/trigger wire to the remote, so it's on only when the system is."];
    case "lithium": return [
      R.bankName === "AGM" ? "AGM batteries: the same size, make and age, all fully charged before they're connected." : "Charge every battery to the same voltage before connecting them.",
      S.bus ? "+ to the positive bus bar, − to the negative bus bar: every cable the same length and gauge." : "Linked + to + and − to −, short cables all the same; the run comes in at the first battery's +, the power leaves from the last one's +, and the ground goes from the first one's −.",
      "A fuse or breaker at each battery's + post.",
      R.bankName === "AGM" ? "AGM: about half its amp-hours are usable before the voltage sags; vent it if it's in the cabin." : "Strap them down: lithium batteries are heavy and must not move.",
    ];
    case "bus": if (cp.dist) return ["One power cable in (from the run, or the bank's last battery), one fused output for each amp.", "Use fuses no bigger than each amp's wire takes (the diagram shows each one).", "Mount it where you can reach the fuses, away from anything that moves."]; return cp.id === "posbus" ? ["Mount it on a board that doesn't conduct, with a cover over it.", "Each cable on its own post, ring lug, tightened to spec.", "From it: the run from the front, the bank's + cables, and every amp's fused power wire."] : ["Every ground meets here: the bank's − cables, every amp's ground, and one short, thick cable to the chassis.", "Mount it near the positive bus bar, but never touching it."];
    case "amp": { const d = cp.draw; return [`Power: ${wireText(d.w)} from the positive bus bar through its ${d.w.runs > 1 ? d.w.runs + " × " : ""}${d.w.fuse} A fuse, into its +12V terminal${d.w.runs > 1 ? "s" : ""}.`, `Ground: ${wireText(d.w)} to the negative bus bar, the same size as the power.`, "Remote: 18 AWG to REM.", cp.amp.kind === "mono" ? "RCA: the sub signal in; its RCA out (pass-through) to the next mono amp." : "RCA: front into channels 1 and 2, rear into 3 and 4 (or what the diagram shows).", "Set its gain with a test tone and a multimeter (or an oscilloscope), not by ear."]; }
    case "speaker": return ["Speaker wire through the door's rubber boot, not over the hinge.", "+ to +, − to − (a backwards speaker cancels its partner's bass).", "Seal the door's holes and add deadening behind it: it sounds a lot better."];
    case "relay": return ["The head unit's remote wire switches its coil (86, with 85 to ground).", "Its 30 terminal on a 10 A fused feed from the positive bus bar; its 87 terminal to every amp's REM."];
    case "box": return ["One terminal cup for each amp's group of subs, so they stay separate.", ...R.subs.map((s) => `Mono amp ${s.amp + 1}: ${s.k} sub${s.k > 1 ? "s" : ""}, ${s.how.toLowerCase()} = ${s.load} Ω.`)];
    default: return [];
  }
}
/** How one amp's subs are wired inside the box: each sub's coils, then the subs, to the terminal cup. */
function subWiringDiagram(s) {
  const dual = coilDual(S.subs.coil), k = s.k;
  const txt = s.how.toLowerCase(), coilsSeries = dual && txt.includes("coils in series");
  const groups = k === 1 ? 1 : txt.includes("in parallel") && txt.includes("groups") ? +(/(\d+) groups/.exec(txt) || [0, 1])[1] : txt.includes(`all ${k} subs in series`) ? 1 : txt.includes(`all ${k} subs in parallel`) ? k : 1;
  const per = Math.max(1, Math.round(k / groups));
  const wrap = h("div", "sy-subw");
  wrap.append(h("b", "", `Mono amp ${s.amp + 1}: ${k} sub${k > 1 ? "s" : ""} at ${s.load} Ω`), h("small", "", s.how));
  const cw = 52, gx = 16, top = 30, rowH = 58, sw = Math.max(300, per * (cw + gx) + 60), shh = top + groups * rowH + 10;
  const svg = sv("svg", { viewBox: `0 0 ${sw} ${shh}`, class: "sy-subsvg" });
  // the terminal cup's + and − rails
  svg.append(sv("line", { x1: 14, y1: 12, x2: sw - 14, y2: 12, class: "sy-rp" }), sv("line", { x1: 14, y1: shh - 6, x2: sw - 14, y2: shh - 6, class: "sy-rn" }));
  svg.append(sv("text", { x: 14, y: 9, class: "sy-lab sm" }, "+ from the amp"), sv("text", { x: 14, y: shh - 9, class: "sy-lab sm" }, "− from the amp"));
  for (let gi = 0; gi < groups; gi++) {
    const y = top + gi * rowH;
    let prevMinus = null;
    for (let i = 0; i < per; i++) {
      const x = 40 + i * (cw + gx);
      svg.append(sv("rect", { x, y, width: cw, height: 34, rx: 6, class: "sy-subbox" }), sv("text", { x: x + cw / 2, y: y + 46, class: "sy-lab sm", "text-anchor": "middle" }, `Sub ${gi * per + i + 1}`));
      // the coils: + and − of each
      const coils = dual ? [[x + 6, x + 18], [x + 30, x + 42]] : [[x + 16, x + 34]];
      coils.forEach(([p, m], ci) => { svg.append(sv("circle", { cx: p, cy: y + 8, r: 3.2, class: "sy-tp" }), sv("circle", { cx: m, cy: y + 8, r: 3.2, class: "sy-tn" })); if (dual) svg.append(sv("text", { x: (p + m) / 2, y: y + 26, class: "sy-lab sm", "text-anchor": "middle" }, "C" + (ci + 1))); });
      let plus, minus;
      if (dual && coilsSeries) { svg.append(sv("path", { d: `M ${coils[0][1]} ${y + 8} Q ${(coils[0][1] + coils[1][0]) / 2} ${y - 4} ${coils[1][0]} ${y + 8}`, class: "sy-jump" })); plus = [coils[0][0], y + 8]; minus = [coils[1][1], y + 8]; }
      else if (dual) { svg.append(sv("path", { d: `M ${coils[0][0]} ${y + 8} Q ${(coils[0][0] + coils[1][0]) / 2} ${y - 6} ${coils[1][0]} ${y + 8}`, class: "sy-jump p" }), sv("path", { d: `M ${coils[0][1]} ${y + 8} Q ${(coils[0][1] + coils[1][1]) / 2} ${y + 22} ${coils[1][1]} ${y + 8}`, class: "sy-jump n" })); plus = [coils[0][0], y + 8]; minus = [coils[1][1], y + 8]; }
      else { plus = [coils[0][0], y + 8]; minus = [coils[0][1], y + 8]; }
      // in a string: the first sub's + to the + rail, each − to the next +, the last − to the − rail
      if (i === 0) svg.append(sv("path", { d: `M ${plus[0]} ${plus[1]} V 12`, class: "sy-lp" }));
      else svg.append(sv("path", { d: `M ${prevMinus[0]} ${prevMinus[1]} C ${prevMinus[0] + 10} ${y + 30} ${plus[0] - 10} ${y + 30} ${plus[0]} ${plus[1]}`, class: "sy-lser" }));
      if (i === per - 1) svg.append(sv("path", { d: `M ${minus[0]} ${minus[1]} V ${y + 18} H ${x + cw + 8} V ${shh - 6}`, class: "sy-ln" }));
      prevMinus = minus;
    }
  }
  wrap.append(svg);
  const legend = [dual ? (coilsSeries ? "Each sub's coils in series: C1 − to C2 +." : "Each sub's coils in parallel: + to +, − to −.") : "", per > 1 ? `${per} subs in series in each row: one sub's − to the next one's +.` : "", groups > 1 ? `The ${groups} rows in parallel on the terminal.` : ""].filter(Boolean).join(" ");
  if (legend) wrap.append(h("p", "status", legend));
  return wrap;
}
