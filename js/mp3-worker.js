// MP3 encoding off the main thread (LAME, via lamejs from cdnjs; the app's offline cache keeps a copy after first use).
// Input: float channels and a gain; output: the MP3 bytes.
importScripts("https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js");
onmessage = (e) => {
  try {
    const { L, R, sr, gain, kbps } = e.data;
    const enc = new lamejs.Mp3Encoder(2, sr, kbps || 320);
    const n = L.length, block = 1152 * 20, parts = [];
    const l16 = new Int16Array(block), r16 = new Int16Array(block);
    for (let i = 0; i < n; i += block) {
      const m = Math.min(block, n - i);
      for (let j = 0; j < m; j++) {
        l16[j] = Math.max(-32768, Math.min(32767, Math.round(L[i + j] * gain * 32767)));
        r16[j] = Math.max(-32768, Math.min(32767, Math.round(R[i + j] * gain * 32767)));
      }
      const out = enc.encodeBuffer(l16.subarray(0, m), r16.subarray(0, m));
      if (out.length) parts.push(new Uint8Array(out));
      if ((i / block) % 20 === 0) postMessage({ progress: i / n });
    }
    const tail = enc.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    const len = parts.reduce((a, p) => a + p.length, 0), mp3 = new Uint8Array(len);
    let o = 0; for (const p of parts) { mp3.set(p, o); o += p.length; }
    postMessage({ mp3: mp3.buffer }, [mp3.buffer]);
  } catch (err) { postMessage({ error: String(err && err.message || err) }); }
};
