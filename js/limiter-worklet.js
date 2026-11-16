// A clean look-ahead peak limiter for the player: it does nothing at all until a sample would pass the ceiling, and then
// lowers the level only as far, and only for as long, as that takes (no compression of anything quieter, no makeup
// gain). The same never-overshooting gain as the rebass engine: a minimum over the look-ahead, averaged, a slow recovery.
class FifteamLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.h = Math.max(1, Math.round(0.002 * sampleRate));          // 2 ms each side: 4 ms of look-ahead
    const D = 2 * this.h;
    this.ceil = Math.pow(10, -0.5 / 20);
    this.rel = 1 / (0.12 * sampleRate);
    this.delay = [new Float32Array(D + 1), new Float32Array(D + 1)];
    this.dp = 0;
    // the requirement r over the last 2h+1 samples (a monotonic queue for its minimum), and a running sum of those minima
    this.rq = new Float32Array(4096); this.iq = new Float64Array(4096); this.qh = 0; this.qt = 0;
    this.mins = new Float32Array(2 * this.h + 1).fill(1); this.mp = 0; this.sum = this.mins.length;
    this.n = 0; this.g = 1;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const L = inp[0], R = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0];
    const D = 2 * this.h, W = 2 * this.h + 1;
    for (let i = 0; i < L.length; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      const r = a > this.ceil ? this.ceil / a : 1;
      const t = this.n++;
      // push r, drop larger ones behind it, drop ones too old
      while (this.qt > this.qh && this.rq[(this.qt - 1) & 4095] >= r) this.qt--;
      this.rq[this.qt & 4095] = r; this.iq[this.qt & 4095] = t; this.qt++;
      while (this.iq[this.qh & 4095] <= t - W) this.qh++;
      const m = this.rq[this.qh & 4095];
      this.sum += m - this.mins[this.mp]; this.mins[this.mp] = m; this.mp = (this.mp + 1) % W;
      let g = this.sum / W;
      if (g > this.g + this.rel) g = this.g + this.rel;
      this.g = g;
      // the audio, delayed to meet its gain
      const dL = this.delay[0], dR = this.delay[1], p = this.dp, q = (p + 1) % (D + 1);
      dL[p] = L[i]; dR[p] = R[i];
      oL[i] = dL[q] * g;
      if (oR !== oL) oR[i] = dR[q] * g;
      this.dp = q;
    }
    return true;
  }
}
registerProcessor("fifteam-limiter", FifteamLimiter);
