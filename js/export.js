// Turning audio into a file, and getting that file onto the phone or into another app.
import { encodeWav, dbToLin } from "./dsp.js";

export const FORMATS = {
  wav16: { label: "WAV 16-bit", ext: "wav", type: "audio/wav", bytesPerSec: (sr) => sr * 4 },
  wav24: { label: "WAV 24-bit", ext: "wav", type: "audio/wav", bytesPerSec: (sr) => sr * 6 },
  mp3: { label: "MP3 320k", ext: "mp3", type: "audio/mpeg", bytesPerSec: () => 40000 },
};

/** The most a phone's share sheet takes at once (Chrome: 50 MB for all the files together), with room to spare. */
export const SHARE_MAX = 50 * 1024 * 1024 - 512 * 1024;
/** The format to make for a file that must stay under maxBytes: the one chosen if it fits, else MP3 320. */
export function fitFormat(fmt, seconds, sr, maxBytes) {
  if (!maxBytes || fmt === "mp3" || ![32000, 44100, 48000].includes(sr)) return fmt;
  return seconds * FORMATS[fmt].bytesPerSec(sr) + 2e6 > maxBytes ? "mp3" : fmt;
}

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function safeName(name, ext) {
  const base = (name || "FifTeam Media").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "FifTeam Media";
  return `${base}.${ext}`;
}

export function sizeText(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes > 1e6) return Math.round(bytes / 1e6) + " MB";
  return Math.max(1, Math.round(bytes / 1e3)) + " KB";
}

// ---------------------------------------------------------------------------------------------------- tags
// ID3v2.3: title, artist, album and the cover, so other players show them. Text in UTF-16 (any language).
function frame(id, body) {
  const h = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) h[i] = id.charCodeAt(i);
  const n = body.length; h[4] = (n >>> 24) & 255; h[5] = (n >>> 16) & 255; h[6] = (n >>> 8) & 255; h[7] = n & 255;
  h.set(body, 10);
  return h;
}
function textFrame(id, s) {
  const b = new Uint8Array(3 + s.length * 2);
  b[0] = 1; b[1] = 0xff; b[2] = 0xfe;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[3 + i * 2] = c & 255; b[4 + i * 2] = c >> 8; }
  return frame(id, b);
}
const cat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
export async function id3Tag({ title, artist, album, cover }) {
  const frames = [];
  if (title) frames.push(textFrame("TIT2", title));
  if (artist) frames.push(textFrame("TPE1", artist));
  if (album) frames.push(textFrame("TALB", album));
  frames.push(textFrame("TSSE", "FifTeam Media"));
  if (cover) {
    const mime = cover.type || "image/jpeg", img = new Uint8Array(await cover.arrayBuffer());
    frames.push(frame("APIC", cat([Uint8Array.of(0), new TextEncoder().encode(mime), Uint8Array.of(0, 3, 0), img])));
  }
  const body = cat(frames), n = body.length;
  const head = Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127);
  return cat([head, body]);
}
/** A WAV with the tag in an "id3 " chunk and the title and artist in its INFO list too. */
async function tagWav(buf, meta) {
  const id3 = await id3Tag(meta);
  const chunk = (id, data) => { const pad = data.length & 1, c = new Uint8Array(8 + data.length + pad); for (let i = 0; i < 4; i++) c[i] = id.charCodeAt(i); new DataView(c.buffer).setUint32(4, data.length, true); c.set(data, 8); return c; };
  const z = (s) => cat([new TextEncoder().encode(s), Uint8Array.of(0)]);
  const info = [new TextEncoder().encode("INFO")];
  if (meta.title) info.push(chunk("INAM", z(meta.title)));
  if (meta.artist) info.push(chunk("IART", z(meta.artist)));
  info.push(chunk("ISFT", z("FifTeam Media")));
  const all = cat([new Uint8Array(buf), chunk("LIST", cat(info)), chunk("id3 ", id3)]);
  new DataView(all.buffer).setUint32(4, all.length - 8, true);
  return all;
}

/**
 * The file itself, with its title, artist and cover inside (meta). MP3s are decoded again and checked: if the encoder's
 * ringing would reach full scale, it is redone lower.
 */
export async function makeFile(chs, sr, name, format, ctx, onProgress, meta = {}) {
  const f = FORMATS[format];
  const tags = { title: meta.title || name, artist: meta.artist || "", album: meta.album || "FifTeam Media", cover: meta.cover || null };
  if (format === "mp3" && [32000, 44100, 48000].includes(sr)) {
    let pre = dbToLin(-0.9);
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await encodeMp3(chs, sr, pre, onProgress);
      const file = new File([await id3Tag(tags), data], safeName(name, "mp3"), { type: f.type });
      if (!ctx) return { file, peakDb: null };
      try {
        const dec = await ctx.decodeAudioData(await file.arrayBuffer());
        let pk = 0;
        for (let c = 0; c < dec.numberOfChannels; c++) { const x = dec.getChannelData(c); for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > pk) pk = a; } }
        if (pk < 0.995) return { file, peakDb: 20 * Math.log10(pk) };
        pre *= (0.97 / pk);
      } catch { return { file, peakDb: null }; }
    }
  }
  const bits = format === "wav24" ? 24 : 16;
  const buf = await tagWav(encodeWav(chs, sr, bits), tags);
  return { file: new File([buf], safeName(name, "wav"), { type: "audio/wav" }), peakDb: null };
}

function encodeMp3(chs, sr, gain, onProgress) {
  return new Promise((res, rej) => {
    const w = new Worker(new URL("./mp3-worker.js", import.meta.url));
    const L = Float32Array.from(chs[0]), R = Float32Array.from(chs[1] || chs[0]);
    w.onmessage = (e) => {
      if (e.data.progress != null) { onProgress && onProgress(e.data.progress); return; }
      w.terminate();
      if (e.data.error) rej(new Error(e.data.error)); else res(e.data.mp3);
    };
    w.onerror = (e) => { w.terminate(); rej(new Error(e.message || "The MP3 encoder failed")); };
    w.postMessage({ L, R, sr, gain }, [L.buffer, R.buffer]);
  });
}

/** Save onto the phone. Returns what happened, so the page can say so. */
export async function saveFile(file) {
  if (window.showSaveFilePicker) {
    try {
      const ext = file.name.split(".").pop();
      const h = await window.showSaveFilePicker({ suggestedName: file.name, types: [{ description: "Audio", accept: { [file.type]: ["." + ext] } }] });
      const w = await h.createWritable(); await w.write(file); await w.close();
      return "saved";
    } catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
  }
  if (isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return "ios-sheet"; }
    catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return "downloaded";
}

export function canShareFiles(file) {
  try { return !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch { return false; }
}
export async function shareFile(file, title) {
  if (!canShareFiles(file)) return "unsupported";
  try { await navigator.share({ files: [file], title, text: `${title} (made with FifTeam Media)` }); return "shared"; }
  catch (e) { return e && e.name === "AbortError" ? "cancelled" : "failed"; }
}
