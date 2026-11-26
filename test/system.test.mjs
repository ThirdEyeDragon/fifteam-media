// node test/system.test.mjs - My system's numbers (js/system.js): every amp fused for what it can draw at its rating
// (not for how its speakers happen to be wired), every fuse at least its draw and never more than its wire takes, the
// run, the Big 3 and the bank sized the same way.
globalThis.document = { getElementById: () => null, addEventListener() {}, querySelector: () => null, documentElement: { style: { setProperty() {} } } };
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.localStorage = { getItem: () => null, setItem() {} };
const m = await import("../js/system.js");
let fails = 0;
const check = (ok, what) => { console.log(`  ${ok ? "ok" : "FAIL"}: ${what}`); if (!ok) fails++; };
const base = m.defaults();
const AMPS = { "8": 60, "4": 135, "2": 181, "1/0": 245, "2/0": 283, "3/0": 328, "4/0": 380 };
const okWire = (x) => x && x.fuse >= x.each - 1e-6 && x.fuse <= AMPS[x.g] && (!x.alt || x.alt.fuse <= AMPS[x.alt.g]);
// a 5000 W amp, stable at ½ ohm, with one 4-ohm sub on it: fused for 5000 W, not for the 625 W it makes into that sub
{
  const R = m.compute({ ...base, subs: { n: 1, size: 12, coil: "S4", rms: 1000 }, mono: { n: 1, watts: 5000, ohm: 0.5 }, four: { n: 0, watts: 100, ohm: 2 } });
  const a = R.ampI[0];
  console.log(`5000 W amp, one 4-ohm sub: makes ${Math.round(a.P)} W there, draws up to ${Math.round(a.I)} A -> ${a.w.runs} × ${a.w.g} AWG on ${a.w.runs} × ${a.w.fuse} A${a.w.alt ? ` (or ${a.w.alt.runs} × ${a.w.alt.g} on ${a.w.alt.runs} × ${a.w.alt.fuse} A)` : ""}; run ${R.run.runs} × ${R.run.g} on ${R.run.fuse} A`);
  check(a.I > 430 && a.w.fuse * a.w.runs >= a.I && okWire(a.w) && R.run.fuse * R.run.runs >= R.I, "a 5000 W amp is fused for its 450-odd amps, whatever its subs are wired to");
}
// every build: fuses never under their draw, never over their wire
{
  let n = 0, bad = [];
  for (const W of [250, 600, 1000, 2000, 3500, 5000, 8000, 12000, 20000]) for (const nm of [0, 1, 2, 4]) for (const n4 of [0, 1, 2]) for (const nb of [0, 1, 3]) for (const alt of [130, 220, 370]) for (const ohm of [0.5, 1, 2]) {
    const c = { ...base, mono: { n: nm, watts: W, ohm }, four: { n: n4, watts: 100, ohm: 2 }, bank: { n: nb, ah: 100, type: "lithium" }, alt };
    const R = m.compute(c);
    const wires = [R.run, R.big3, R.bankWire, ...R.ampI.map((a) => a.w)].filter(Boolean);
    n += wires.length;
    for (const w of wires) if (!okWire(w)) bad.push(`${W} W ×${nm}: ${w.runs}×${w.g} ${w.fuse} A for ${Math.round(w.each)} A`);
    for (const a of R.ampI) if (a.w.fuse * a.w.runs < a.I - 1e-6) bad.push(`${W} W amp fused ${a.w.runs}×${a.w.fuse} A for ${Math.round(a.I)} A`);
    if (R.run.fuse * R.run.runs < R.runI - 1e-6) bad.push(`run fused under ${Math.round(R.runI)} A`);
    if (R.ampI.filter((a) => a.kind === "mono").length !== nm) bad.push(`${nm} mono amps, ${R.ampI.filter((a) => a.kind === "mono").length} wired`);
  }
  console.log(`${n} wires in 2,916 builds; wrong:`, bad.slice(0, 5).join(" | ") || "none");
  check(!bad.length, "every fuse at least what its wire carries at full power, never more than the wire takes; every amp wired, subs or not");
}
// the run: everything the amps draw; with a bank, never less than the alternator's output
{
  const R = m.compute({ ...base, mono: { n: 2, watts: 8000, ohm: 1 }, bank: { n: 4, ah: 100, type: "lithium" }, alt: 370 });
  const R2 = m.compute({ ...base, mono: { n: 1, watts: 1500, ohm: 1 }, bank: { n: 0, ah: 100 }, alt: 160 });
  console.log(`with a bank: run for ${Math.round(R.runI)} A (alternator 370 A) -> ${R.run.runs} × ${R.run.g}; without: run for ${Math.round(R2.runI)} A (all the amps draw) -> ${R2.run.runs} × ${R2.run.g}, Big 3 ${R2.big3.g} on ${R2.big3.fuse} A`);
  check(R.runI >= 370 && R.run.fuse * R.run.runs >= 370 && Math.abs(R2.runI - R2.I) < 1e-6 && R2.big3.fuse >= 160, "the run: all the amps' draw, or with a bank the alternator's full output; the Big 3 the alternator's");
}
console.log(fails ? `FAIL (${fails})` : "system: all ok");
process.exit(fails ? 1 : 0);
