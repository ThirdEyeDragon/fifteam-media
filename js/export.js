// Turning audio into a file, and getting that file onto the phone or into another app.
import { encodeWav, dbToLin } from "./dsp.js";

export const FORMATS = {
  wav16: { label: "WAV 16-bit", ext: "wav", type: "audio/wav", bytesPerSec: (sr) => sr * 4 },
  wav24: { label: "WAV 24-bit", ext: "wav", type: "audio/wav", bytesPerSec: (sr) => sr * 6 },
  mp3: { label: "MP3 320k", ext: "mp3", type: "audio/mpeg", bytesPerSec: () => 40000 },
};

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

/** The file itself. MP3s are decoded again and checked: if the encoder's ringing would reach full scale, it is redone lower. */
export async function makeFile(chs, sr, name, format, ctx, onProgress) {
  const f = FORMATS[format];
  if (format === "mp3" && [32000, 44100, 48000].includes(sr)) {
    let pre = dbToLin(-0.9);
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await encodeMp3(chs, sr, pre, onProgress);
      const file = new File([data], safeName(name, "mp3"), { type: f.type });
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
  const buf = encodeWav(chs, sr, bits);
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
