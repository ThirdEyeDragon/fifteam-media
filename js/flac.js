// FLAC: lossless, about half the size of a WAV. 16-bit, blocks of 4096 samples, each channel on its own; every subframe
// the best of the fixed predictors (orders 0 to 4) by its residual, Rice-coded in up to 16 partitions (5-bit
// parameters). With a Vorbis comment for the title, artist and album. Every phone's player opens it.
class Bits {
  constructor(n = 1 << 16) { this.b = new Uint8Array(n); this.i = 0; this.acc = 0; this.n = 0; }
  grow() { const b = new Uint8Array(this.b.length * 2); b.set(this.b); this.b = b; }
  byte(v) { if (this.i >= this.b.length) this.grow(); this.b[this.i++] = v; }
  /** n bits of v (n up to 32), high bit first. */
  put(v, n) {
    while (n > 0) {
      const take = Math.min(n, 8 - this.n), shift = n - take, part = Math.floor(v / 2 ** shift) & ((1 << take) - 1);
      this.acc = (this.acc << take) | part; this.n += take; n -= take;
      v = v - part * 2 ** shift;
      if (this.n === 8) { this.byte(this.acc); this.acc = 0; this.n = 0; }
    }
  }
  /** q zero bits then a one: the unary part of a Rice code. */
  unary(q) { while (q >= 8 && this.n === 0) { this.byte(0); q -= 8; } while (q-- > 0) this.put(0, 1); this.put(1, 1); }
  align() { if (this.n) this.put(0, 8 - this.n); }
  bytes() { return this.b.subarray(0, this.i); }
}
const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; CRC8[i] = c;
  let d = i << 8; for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff; CRC16[i] = d;
}
const crc8 = (a, s, e) => { let c = 0; for (let i = s; i < e; i++) c = CRC8[c ^ a[i]]; return c; };
const crc16 = (a, s, e) => { let c = 0; for (let i = s; i < e; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ a[i]]; return c; };
// the fixed predictors' residual at sample n
const RES = [
  (x, n) => x[n],
  (x, n) => x[n] - x[n - 1],
  (x, n) => x[n] - 2 * x[n - 1] + x[n - 2],
  (x, n) => x[n] - 3 * x[n - 1] + 3 * x[n - 2] - x[n - 3],
  (x, n) => x[n] - 4 * x[n - 1] + 6 * x[n - 2] - 4 * x[n - 3] + x[n - 4],
];
const zig = (r) => (r >= 0 ? 2 * r : -2 * r - 1);
/** The Rice parameter for a partition (count residuals summing to sum), and about how many bits it takes. */
function rice(sum, count) {
  let best = { k: 0, bits: Infinity };
  const k0 = Math.max(0, Math.floor(Math.log2(Math.max(1, sum / Math.max(1, count)))) - 1);
  for (let k = k0; k <= Math.min(30, k0 + 3); k++) { const bits = count * (k + 1) + sum / 2 ** k; if (bits < best.bits) best = { k, bits }; }
  return best;
}
function subframe(out, x, bps) {
  const n = x.length;
  // constant
  if (x.every((v) => v === x[0])) { out.put(0, 1); out.put(0, 6); out.put(0, 1); out.put(x[0] & ((1 << bps) - 1), bps); return; }
  let best = null;
  for (let o = 0; o <= 4 && o < n; o++) {
    const u = new Float64Array(n);
    for (let i = o; i < n; i++) u[i] = zig(RES[o](x, i));
    // partitions: as many as the block divides into (up to 16), each with its own parameter; costed from their sums
    let maxPo = 0; while (maxPo < 4 && n % (1 << (maxPo + 1)) === 0 && (n >> (maxPo + 1)) > o) maxPo++;
    const fine = 1 << maxPo, sums = new Float64Array(fine), len = n >> maxPo;
    for (let p = 0; p < fine; p++) { let s = 0; for (let i = Math.max(o, p * len), e = (p + 1) * len; i < e; i++) s += u[i]; sums[p] = s; }
    for (let po = 0; po <= maxPo; po++) {
      const parts = 1 << po, per = fine / parts;
      let bits = 0; const ks = [];
      for (let p = 0; p < parts; p++) {
        let s = 0; for (let q = p * per; q < (p + 1) * per; q++) s += sums[q];
        const count = (n >> po) - (p === 0 ? o : 0), r = rice(s, count); ks.push(r.k); bits += 5 + r.bits;
      }
      if (!best || bits < best.bits) best = { o, po, ks, u, bits };
    }
  }
  // (verbatim, if prediction doesn't help)
  if (best.bits + best.o * bps >= n * bps) { out.put(0, 1); out.put(1, 6); out.put(0, 1); for (let i = 0; i < n; i++) out.put(x[i] & ((1 << bps) - 1), bps); return; }
  out.put(0, 1); out.put(8 | best.o, 6); out.put(0, 1);
  for (let i = 0; i < best.o; i++) out.put(x[i] & ((1 << bps) - 1), bps);
  out.put(1, 2); out.put(best.po, 4);                        // residual: Rice, 5-bit parameters; partition order
  const parts = 1 << best.po;
  for (let p = 0; p < parts; p++) {
    const k = best.ks[p], s = p === 0 ? best.o : p * (n >> best.po), e = (p + 1) * (n >> best.po);
    out.put(k, 5);
    for (let i = s; i < e; i++) { const u = best.u[i], q = Math.floor(u / 2 ** k); out.unary(q); if (k) out.put(u - q * 2 ** k, k); }
  }
}
/** The frame number, UTF-8 coded as FLAC wants it. */
function utf8num(out, v) {
  if (v < 0x80) { out.put(v, 8); return; }
  const bytes = []; let n = v;
  let len = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
  for (let i = 0; i < len - 1; i++) { bytes.unshift(0x80 | (n & 0x3f)); n = Math.floor(n / 64); }
  out.put(((0xff00 >> len) & 0xff) | n, 8);
  for (const b of bytes) out.put(b, 8);
}
/** A FLAC file (as bytes) from channels of floats (-1 to 1), at sample rate sr. */
export function encodeFlac(chs, sr, tags = {}) {
  const nCh = Math.min(8, chs.length), n = chs[0].length, bps = 16, BS = 4096;
  const ints = chs.slice(0, nCh).map((c) => { const a = new Int32Array(n); for (let i = 0; i < n; i++) { const v = Math.round(Math.max(-1, Math.min(1, c[i])) * 32767); a[i] = v; } return a; });
  const out = new Bits(Math.max(1 << 16, n * nCh));
  // "fLaC", STREAMINFO, then a Vorbis comment (the last block)
  for (const ch of "fLaC") out.put(ch.charCodeAt(0), 8);
  out.put(0, 1); out.put(0, 7); out.put(34, 24);
  out.put(BS, 16); out.put(BS, 16); out.put(0, 24); out.put(0, 24);
  out.put(sr, 20); out.put(nCh - 1, 3); out.put(bps - 1, 5); out.put(Math.floor(n / 2 ** 32), 4); out.put(n >>> 0, 32);
  for (let i = 0; i < 16; i++) out.put(0, 8);                 // (no MD5: allowed, players skip the check)
  const enc = new TextEncoder(), le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const vendor = enc.encode("FifTeam Media"), comments = [["TITLE", tags.title], ["ARTIST", tags.artist], ["ALBUM", tags.album]].filter(([, v]) => v).map(([k, v]) => enc.encode(`${k}=${String(v).slice(0, 200)}`));
  const vc = [...le32(vendor.length), ...vendor, ...le32(comments.length), ...comments.flatMap((c) => [...le32(c.length), ...c])];
  out.put(1, 1); out.put(4, 7); out.put(vc.length, 24); for (const b of vc) out.put(b, 8);
  // the frames
  for (let f = 0, s0 = 0; s0 < n; f++, s0 += BS) {
    const len = Math.min(BS, n - s0), start = out.i;
    out.put(0x3ffe, 14); out.put(0, 1); out.put(0, 1);        // sync, reserved, fixed block size
    out.put(len === BS ? 12 : 7, 4);                          // 4096, or (the last) its size in 16 bits at the end
    out.put(0, 4);                                            // sample rate: from STREAMINFO
    out.put(nCh - 1, 4); out.put(0, 3); out.put(0, 1);        // independent channels; bits: from STREAMINFO
    utf8num(out, f);
    if (len !== BS) out.put(len - 1, 16);
    out.put(crc8(out.b, start, out.i), 8);
    for (const x of ints) subframe(out, x.subarray(s0, s0 + len), bps);
    out.align();
    const c = crc16(out.b, start, out.i);
    out.put(c >> 8, 8); out.put(c & 255, 8);
  }
  return out.bytes().slice();
}
