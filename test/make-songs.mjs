// Two test songs as WAV files (a bass line, kick, snare, chords, mastered to the ceiling), one with title/artist tags.
//   node test/make-songs.mjs <out dir>
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { encodeWav } from "../js/dsp.js";

const out = process.argv[2]; mkdirSync(out, { recursive: true });
const sr = 44100;
function song(secs, notes, bpm, seed0) {
  const n = sr * secs, L = new Float32Array(n), R = new Float32Array(n);
  let seed = seed0; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const beat = 60 / bpm, step = beat / 2;
  for (let k = 0; k * step < secs; k++) {
    const f = notes[k % notes.length], t0 = k * step;
    for (let s = Math.floor(t0 * sr); s < Math.min(n, Math.floor((t0 + step) * sr)); s++) {
      const t = s / sr - t0, env = Math.min(1, t / 0.004) * Math.exp(-t * 3);
      let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * (s / sr)) / h;
      L[s] += 0.4 * env * v; R[s] += 0.4 * env * v;
    }
  }
  for (let b = 0; b * beat < secs; b++) {
    const t0 = b * beat; let ph = 0;
    for (let s = Math.floor(t0 * sr); s < Math.min(n, Math.floor((t0 + 0.35) * sr)); s++) {
      const t = s / sr - t0, f = 45 + 80 * Math.exp(-t * 30); ph += (2 * Math.PI * f) / sr;
      const v = Math.sin(ph) * Math.exp(-t * 9) * 0.7; L[s] += v; R[s] += v;
    }
    if (b % 2) for (let s = Math.floor(t0 * sr); s < Math.min(n, Math.floor((t0 + 0.2) * sr)); s++) {
      const t = s / sr - t0, v = (rnd() * 2 - 1) * Math.exp(-t * 25) * 0.35; L[s] += v; R[s] += v * 0.9;
    }
  }
  for (let s = 0; s < n; s++) {
    const t = s / sr, c = [220, 277.18, 329.63].reduce((a, f) => a + Math.sin(2 * Math.PI * f * t + 0.3), 0) * 0.06;
    L[s] += c; R[s] += c * 0.8;
  }
  let pk = 0; for (let s = 0; s < n; s++) pk = Math.max(pk, Math.abs(L[s]), Math.abs(R[s]));
  for (let s = 0; s < n; s++) { L[s] *= 0.999 / pk; R[s] *= 0.999 / pk; }
  return [L, R];
}
function withInfo(wav, title, artist) {
  // a LIST/INFO chunk with the title and artist, after the audio
  const enc = (id, s) => { const b = Buffer.from(s + "\0", "utf8"); const pad = b.length & 1; const h = Buffer.alloc(8); h.write(id, 0, "ascii"); h.writeUInt32LE(b.length, 4); return Buffer.concat([h, b, Buffer.alloc(pad)]); };
  const body = Buffer.concat([Buffer.from("INFO", "ascii"), enc("INAM", title), enc("IART", artist)]);
  const head = Buffer.alloc(8); head.write("LIST", 0, "ascii"); head.writeUInt32LE(body.length, 4);
  const all = Buffer.concat([Buffer.from(wav), head, body]);
  all.writeUInt32LE(all.length - 8, 4);
  return all;
}
const a = song(40, [41.2, 41.2, 49.0, 55.0, 41.2, 65.41, 55.0, 49.0, 36.71, 36.71, 49.0, 73.42, 61.74, 55.0, 49.0, 43.65], 120, 7);
writeFileSync(join(out, "night-drive.wav"), withInfo(encodeWav(a, sr, 16), "Night Drive", "Test Signal"));
const b = song(30, [55, 55, 65.41, 73.42, 82.41, 73.42, 65.41, 49.0], 96, 11);
writeFileSync(join(out, "Low Tide - Demo Band.wav"), Buffer.from(encodeWav(b, sr, 16)));
console.log("wrote 2 songs to", out);
