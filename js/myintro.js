// A custom intro (Premium): the user's own voice before their rebassed songs. Recorded with the phone's microphone (up
// to 15 seconds), kept on the phone (in the app's cache), and made into the intro with two settings:
//   - slow: its speed, 50 to 100%, without changing its pitch (a time-stretch: overlapping pieces of the sound laid
//     further apart, each one placed where it lines up best with the last, so the voice stays smooth);
//   - pitch: -12 to +12 semitones, without changing its speed (resampled for the pitch, then stretched back).
// Brought to the song's level (its loudest moment at -1 dBFS), faded in and out, with a short pause before the song.
const KEY = "fifteam-myintro", CACHE = "fifteam-flags", MAX_S = 15;
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

export const settings = () => { try { const s = JSON.parse(ls.get(KEY) || "{}"); return { speed: Math.max(0.5, Math.min(1, +s.speed || 1)), pitch: Math.max(-12, Math.min(12, Math.round(+s.pitch || 0))), src: s.src === "mine" ? "mine" : "tag" }; } catch { return { speed: 1, pitch: 0, src: "tag" }; } };
export const saveSettings = (s) => ls.set(KEY, JSON.stringify({ ...settings(), ...s }));

// ---------------------------------------------------------------------------------------------------- the recording
let raw = null, rawLoaded = false;
/** The recording kept on the phone (a Blob), or null. */
export async function recording() {
  if (rawLoaded) return raw;
  try { const r = await (await caches.open(CACHE)).match("myintro"); raw = r ? await r.blob() : null; } catch { raw = null; }
  rawLoaded = true;
  return raw;
}
async function keep(blob) {
  raw = blob; rawLoaded = true;
  try { const c = await caches.open(CACHE); if (blob) await c.put("myintro", new Response(blob, { headers: { "Content-Type": blob.type || "audio/webm" } })); else await c.delete("myintro"); } catch {}
}
export const forget = () => keep(null);

/** Recording: start() asks for the microphone and records (it stops by itself at 15 s); stop() keeps it. */
export function recorder(onTick) {
  let rec = null, stream = null, chunks = [], t0 = 0, tick = 0, done = null;
  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
      rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      done = new Promise((res) => { rec.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); clearInterval(tick); const b = new Blob(chunks, { type: rec.mimeType || type || "audio/webm" }); await keep(b); res(b); }; });
      rec.start(250); t0 = Date.now();
      tick = setInterval(() => { const s = (Date.now() - t0) / 1000; onTick && onTick(s); if (s >= MAX_S) this.stop(); }, 100);
    },
    stop() { if (rec && rec.state !== "inactive") rec.stop(); return done; },
    get on() { return !!rec && rec.state === "recording"; },
  };
}

// ---------------------------------------------------------------------------------------------------- slow and pitch
/** Linear resampling by a ratio (read r samples of the input for each one out: r > 1 raises the pitch and shortens it). */
function resample(x, r) {
  const n = Math.max(1, Math.floor(x.length / r)), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * r, a = Math.floor(p), f = p - a; y[i] = (x[a] || 0) * (1 - f) + (x[a + 1] || 0) * f; }
  return y;
}
/** Time-stretched by f (f > 1 longer), pitch kept: overlapping Hann-windowed pieces, each moved (within a few ms) to
 * where it lines up best with what's already out, then added up. */
function stretch(x, f, sr) {
  if (Math.abs(f - 1) < 0.01) return x;
  const N = Math.round(sr * 0.04) & ~1, Hs = N / 2, Ha = Hs / f, tol = Math.round(sr * 0.008);
  const out = new Float32Array(Math.ceil(x.length * f) + N), norm = new Float32Array(out.length);
  const w = new Float32Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  let prev = 0;                                                   // (where the last piece was read from)
  for (let k = 0, o = 0; o + N < out.length; k++, o += Hs) {
    const want = Math.round(k * Ha);
    if (want + N + tol >= x.length) break;
    // the best start near want: the one most like what followed the last piece
    let best = want, bc = -Infinity;
    if (k) for (let d = -tol; d <= tol; d += 2) {
      const s = want + d; if (s < 0) continue;
      let c = 0; for (let i = 0; i < Hs; i += 4) c += x[s + i] * x[prev + Hs + i];
      if (c > bc) { bc = c; best = s; }
    }
    for (let i = 0; i < N; i++) { out[o + i] += x[best + i] * w[i]; norm[o + i] += w[i]; }
    prev = best;
  }
  for (let i = 0; i < out.length; i++) if (norm[i] > 1e-3) out[i] /= norm[i];
  let end = out.length; while (end > 0 && norm[end - 1] < 1e-3) end--;
  return out.subarray(0, end);
}
/** The intro as heard before the song: from the recording, slowed and pitched, at rate, in stereo. */
export async function makeIntro(ctx, rate, { speed = 1, pitch = 0 } = {}) {
  const blob = await recording();
  if (!blob) return null;
  const dec = await ctx.decodeAudioData(await blob.arrayBuffer());
  // mono, at the song's rate
  const n0 = dec.length, mono = new Float32Array(n0);
  for (let c = 0; c < dec.numberOfChannels; c++) { const x = dec.getChannelData(c); for (let i = 0; i < n0; i++) mono[i] += x[i] / dec.numberOfChannels; }
  let x = dec.sampleRate === rate ? mono : resample(mono, dec.sampleRate / rate);
  // the silence before and after the voice, trimmed
  let pk0 = 0; for (let i = 0; i < x.length; i++) pk0 = Math.max(pk0, Math.abs(x[i]));
  const th = pk0 * 0.04; let a = 0, b = x.length;
  while (a < b && Math.abs(x[a]) < th) a++; while (b > a && Math.abs(x[b - 1]) < th) b--;
  x = x.subarray(Math.max(0, a - Math.round(rate * 0.05)), Math.min(x.length, b + Math.round(rate * 0.15)));
  // pitch: resampled (that changes its speed too), then stretched back; slow: stretched
  const r = Math.pow(2, pitch / 12);
  if (pitch) x = resample(x, r);
  x = stretch(x, r / speed, rate);
  // its level, fades, and a pause before the song
  let pk = 0; for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
  const g = pk > 0 ? Math.pow(10, -1 / 20) / pk : 1, fade = Math.round(rate * 0.012), gap = Math.round(rate * 0.35);
  const ob = ctx.createBuffer(2, x.length + gap, rate), L = ob.getChannelData(0), R = ob.getChannelData(1);
  for (let i = 0; i < x.length; i++) { const e = Math.min(1, i / fade, (x.length - 1 - i) / fade); L[i] = R[i] = x[i] * g * Math.max(0, e); }
  return ob;
}
