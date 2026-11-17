// node test/eq.test.mjs - the player's knobs, measured in a real browser: each knob changes its own band and nothing
// else (the response of the other bands stays exactly where it was), and a band turned up that would clip is held back
// on its own (the other bands keep their exact level), with nothing ever over full scale.
import { spawn } from "node:child_process";
import { browser } from "./cdp.mjs";

const port = 8400 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [new URL("./serve.mjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), String(port)], { stdio: "ignore" });
const b = await browser();
let failed = false;
const check = (ok, what) => { if (!ok) { failed = true; console.log("  FAIL:", what); } };
try {
  await b.open(`http://127.0.0.1:${port}/test/blank.html`, 800);
  const r = JSON.parse(await b.ev(`(async () => {
    const { makeBands, makeGuard, gainOf } = await import('/js/eq.js');
    const sr = 48000;
    const fft = (re, im) => {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
      for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
        for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const p = i + k, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr; re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } }
    };
    // the response for a knob setting: an impulse through the crossover and the guard
    const N = 65536, A = 0.01;
    const response = async (vals, mute = {}) => {
      const ctx = new OfflineAudioContext(2, N, sr);
      const buf = ctx.createBuffer(1, N, sr); buf.getChannelData(0)[64] = A;
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bands = makeBands(ctx), guard = await makeGuard(ctx);
      src.connect(bands.input); bands.connect(ctx.destination, guard); bands.set(vals, true, mute); src.start();
      const x = (await ctx.startRendering()).getChannelData(0);
      const re = Float64Array.from(x), im = new Float64Array(N); fft(re, im);
      return (f) => 20 * Math.log10(Math.hypot(re[Math.round(f * N / sr)], im[Math.round(f * N / sr)]) / A);
    };
    const logf = (a, b, n) => Array.from({ length: n }, (_, i) => a * Math.pow(b / a, i / (n - 1)));
    const BASS = logf(20, 120, 40), MIDS = logf(500, 2000, 40), HIGHS = logf(8000, 16000, 40), ALL = logf(20, 20000, 200);
    const flat = { bass: 5, mids: 5, highs: 5 };
    const H0 = await response(flat);
    const out = { flat: Math.max(...ALL.map((f) => Math.abs(H0(f)))) };
    const dev = (H, fs) => Math.max(...fs.map((f) => Math.abs(H(f) - H0(f))));
    const mean = (H, fs) => fs.reduce((a, f) => a + H(f) - H0(f), 0) / fs.length;
    out.moves = [];
    for (const [band, v] of [["mids", 4], ["mids", 3], ["mids", 7], ["mids", 10], ["mids", 0], ["bass", 3], ["bass", 8], ["bass", 0], ["highs", 2], ["highs", 9], ["highs", 0]]) {
      const H = await response({ ...flat, [band]: v });
      const others = { bass: BASS, mids: MIDS, highs: HIGHS };
      const own = others[band]; delete others[band];
      out.moves.push({ band, v, want: v ? 20 * Math.log10(gainOf(v)) : -Infinity, own: mean(H, own), ...Object.fromEntries(Object.entries(others).map(([k, fs]) => [k, dev(H, fs)])) });
    }
    // loud music, one band turned all the way up: that band held back where it would clip, the others exact
    const DFT = (x, f, a, b) => { let re = 0, im = 0; for (let i = a; i < b; i++) { re += x[i] * Math.cos(2 * Math.PI * f * i / sr); im += x[i] * Math.sin(2 * Math.PI * f * i / sr); } return 2 * Math.hypot(re, im) / (b - a); };
    const tones = [[50, 0.55], [1000, 0.3], [10000, 0.1]];
    const loud = async (vals, scale = 1) => {
      const ctx = new OfflineAudioContext(2, 2 * sr, sr);
      const bands = makeBands(ctx), guard = await makeGuard(ctx);
      for (const [f, a] of tones) { const o = ctx.createOscillator(); o.frequency.value = f; const g = ctx.createGain(); g.gain.value = a * scale; o.connect(g).connect(bands.input); o.start(); }
      bands.connect(ctx.destination, guard); bands.set(vals, true);
      const rb = await ctx.startRendering(), x = rb.getChannelData(0);
      let pk = 0; for (let c = 0; c < 2; c++) { const y = rb.getChannelData(c); for (let i = 0; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i])); }
      return { pk: 20 * Math.log10(pk), lv: tones.map(([f, a]) => 20 * Math.log10(DFT(x, f, sr, 2 * sr) / (a * scale))) };
    };
    out.loud = [];
    for (const vals of [flat, { ...flat, mids: 10 }, { ...flat, bass: 10 }, { ...flat, highs: 10 }, { ...flat, mids: 3 }]) out.loud.push({ vals, ...(await loud(vals)) });
    out.hot = await loud({ ...flat, mids: 4 }, 1.25);   // the song itself over full scale
    return JSON.stringify(out);
  })()`));
  console.log(`all at 5: every frequency 20 Hz - 20 kHz within ${r.flat.toFixed(3)} dB of the song`);
  const f2 = (v) => (v === null ? "-inf" : v.toFixed(2));
  for (const m of r.moves) {
    const others = Object.keys(m).filter((k) => ["bass", "mids", "highs"].includes(k) && k !== m.band);
    console.log(`${m.band.toUpperCase().padEnd(5)} at ${String(m.v).padStart(2)}: its band ${m.v ? f2(m.own) + " dB (knob says " + f2(m.want) + ")" : "off"} | ${others.map((k) => `${k} moved at most ${m[k].toFixed(3)} dB`).join(", ")}`);
    for (const k of others) check(m[k] < 0.1, `${m.band} at ${m.v} moved ${k} by ${m[k].toFixed(3)} dB`);
    // (the bass turned up also gets its punch round 55 Hz, so on average it rises a little more than the knob says)
    if (m.v) check(m.band === "bass" && m.v > 5 ? m.own > m.want - 0.25 : Math.abs(m.own - m.want) < 0.25, `${m.band} at ${m.v}: its own band ${m.own.toFixed(2)} dB, knob ${m.want.toFixed(2)} dB`);
  }
  const names = ["50 Hz (bass)", "1 kHz (mids)", "10 kHz (highs)"];
  for (const l of r.loud) {
    const moved = Object.entries(l.vals).find(([, v]) => v !== 5);
    console.log(`loud song, ${moved ? moved[0] + " at " + moved[1] : "all at 5"}: peak ${l.pk.toFixed(2)} dBFS | ${l.lv.map((v, i) => `${names[i]} ${v >= 0 ? "+" : ""}${v.toFixed(2)} dB`).join(", ")}`);
    check(l.pk <= 0.001, "over full scale");
    const idx = { bass: 0, mids: 1, highs: 2 };
    l.lv.forEach((v, i) => { if (!moved || idx[moved[0]] !== i) check(Math.abs(v) < 0.05, `${moved ? moved[0] : "flat"}: ${names[i]} changed by ${v.toFixed(2)} dB`); });
    if (moved && moved[1] > 5) check(l.lv[idx[moved[0]]] > 0.5, `${moved[0]} turned up but not louder`);
  }
  console.log(`a song over full scale (+1.9 dB), mids at 4: peak ${r.hot.pk.toFixed(2)} dBFS`);
  check(r.hot.pk <= 0.001, "hot song over full scale");
  console.log(b.errors.length ? "ERRORS:\n" + b.errors.join("\n") : "errors: none");
  check(!b.errors.length, "browser errors");
} finally { b.close(); server.kill(); }
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
