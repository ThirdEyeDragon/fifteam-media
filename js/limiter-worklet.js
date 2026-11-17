// The player's three bands put back together, each at its own knob's level, with nothing changed but that.
// A band turned up past 5 that would push the song past full scale is held back (that band only, only for that moment,
// eased in over a 10 ms look-ahead and back out over 150 ms); the bands at or below 5 are never touched. Only if the
// song itself would pass full scale with no boost at all is the whole lowered, just enough, which keeps it from clipping.
// Inputs: 0 bass, 1 mids, 2 highs, 3 what the bass's punch adds (stereo each). Parameters: low, mid, high (the band
// gains, 1 = as it is; the punch goes with the bass and is always part of its boost).
const MASK = 4095;

/** The smallest of the last W requirements, averaged over W (so it never asks for more than any sample allows), rising
 * back no faster than `rel` per sample. */
class Guard {
  constructor(W, rel) {
    this.W = W; this.rel = rel;
    this.rq = new Float32Array(MASK + 1); this.iq = new Float64Array(MASK + 1); this.qh = 0; this.qt = 0;
    this.mins = new Float32Array(W).fill(1); this.mp = 0; this.sum = W; this.v = 1;
  }
  push(r, t) {
    while (this.qt > this.qh && this.rq[(this.qt - 1) & MASK] >= r) this.qt--;
    this.rq[this.qt & MASK] = r; this.iq[this.qt & MASK] = t; this.qt++;
    while (this.iq[this.qh & MASK] <= t - this.W) this.qh++;
    const m = this.rq[this.qh & MASK];
    this.sum += m - this.mins[this.mp]; this.mins[this.mp] = m;
    if (++this.mp === this.W) { this.mp = 0; let s = 0; for (let i = 0; i < this.W; i++) s += this.mins[i]; this.sum = s; }
    let v = this.sum / this.W;
    if (v > this.v + this.rel) v = this.v + this.rel;
    this.v = v;
    return v;
  }
}

class FifteamBands extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ["low", "mid", "high"].map((name) => ({ name, defaultValue: 1, minValue: 0, maxValue: 16, automationRate: "a-rate" }));
  }
  constructor() {
    super();
    const h = Math.max(1, Math.round(0.005 * sampleRate));
    this.D = 2 * h;
    this.C = Math.pow(10, -0.2 / 20);      // how far a boost may take the song
    this.C2 = 1;                           // full scale
    const W = 2 * h + 1, rel = 1 / (0.15 * sampleRate);
    this.k = new Guard(W, rel); this.g = new Guard(W, rel);
    const n = this.D + 1;
    this.bL = new Float32Array(n); this.bR = new Float32Array(n); this.eL = new Float32Array(n); this.eR = new Float32Array(n);
    this.dp = 0; this.t = 0;
    this.held = 0;                         // for the tests: samples where a boost was held back
    this.port.onmessage = () => this.port.postMessage({ held: this.held, samples: this.t });
  }
  process(inputs, outputs, P) {
    const out = outputs[0], oL = out[0], oR = out[1] || null, N = oL.length;
    const chan = (inp, c) => (inp && inp.length ? inp[Math.min(c, inp.length - 1)] : null);
    const XL = [chan(inputs[0], 0), chan(inputs[1], 0), chan(inputs[2], 0)], PL = chan(inputs[3], 0);
    const XR = [chan(inputs[0], 1), chan(inputs[1], 1), chan(inputs[2], 1)], PR = chan(inputs[3], 1);
    const G = [P.low, P.mid, P.high];
    const C = this.C, C2 = this.C2, D = this.D;
    const need = (b, e) => {               // the most of the boost this sample can take: |b + k e| <= C
      if (b > C || b < -C) return 0;
      const k = e > 0 ? (C - b) / e : e < 0 ? (C + b) / -e : 1;
      return k < 1 ? k : 1;
    };
    for (let i = 0; i < N; i++) {
      let bL = 0, bR = 0, eL = 0, eR = 0;
      for (let b = 0; b < 3; b++) {
        const ga = G[b], g = ga.length > 1 ? ga[i] : ga[0];
        const l = XL[b] ? XL[b][i] : 0, r = XR[b] ? XR[b][i] : 0;
        if (g > 1) { bL += l; bR += r; eL += (g - 1) * l; eR += (g - 1) * r; }   // the band as it is, plus its boost
        else { bL += g * l; bR += g * r; }
        if (b === 0 && PL) { eL += g * PL[i]; eR += g * PR[i]; }
      }
      const kr = Math.min(need(bL, eL), need(bR, eR));
      const yl = Math.abs(bL + kr * eL), yr = Math.abs(bR + kr * eR), y = yl > yr ? yl : yr;
      const gr = y > C2 ? C2 / y : 1;
      const t = this.t++;
      const k = this.k.push(kr, t), g = this.g.push(gr, t);
      // the bands delayed to meet their guard
      const p = this.dp, q = p === D ? 0 : p + 1;
      this.bL[p] = bL; this.bR[p] = bR; this.eL[p] = eL; this.eR[p] = eR;
      if (k < 0.999 && (this.eL[q] !== 0 || this.eR[q] !== 0)) this.held++;
      oL[i] = g * (this.bL[q] + k * this.eL[q]);
      if (oR) oR[i] = g * (this.bR[q] + k * this.eR[q]);
      this.dp = q;
    }
    return true;
  }
}
registerProcessor("fifteam-bands", FifteamBands);
