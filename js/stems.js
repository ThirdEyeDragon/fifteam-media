// FifTeam Media - separated basses kept on the phone (IndexedDB), so a song rebassed before doesn't have to be separated
// again. A bass is kept at a quarter of the song's rate (it has nothing above ~5 kHz worth keeping) in 16 bits: about
// 10 MB for a 3.5-minute song. The last six songs are kept. Every bass is put through the same form before it is used,
// kept or not, so a song always rebasses exactly the same way.
import { butter4, upAdd } from "./dsp.js";

const DB = "fifteam-stems", STORE = "stems", META = "meta", MAX = 6, VER = "htdemucs_ft-bass-q8-1", D = 4;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { for (const s of [STORE, META]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: "key" }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** The compact form: [Int16Array, Int16Array] at sr / 4, and the scale. */
export function pack(chs, sr) {
  let peak = 0;
  const low = chs.map((c) => { const y = Float32Array.from(c); butter4(y, "lp", Math.min(5000, 0.45 * (sr / D)), sr); return y; });
  const m = Math.floor((chs[0].length - 1) / D) + 1;
  for (const y of low) for (let k = 0; k < m; k++) peak = Math.max(peak, Math.abs(y[k * D]));
  const scale = peak > 0 ? peak / 32767 : 1;
  const data = low.map((y) => { const q = new Int16Array(m); for (let k = 0; k < m; k++) q[k] = Math.round(y[k * D] / scale); return q; });
  return { data, scale };
}
export function unpack({ data, scale }, n) {
  return data.map((q) => { const band = new Float32Array(q.length); for (let k = 0; k < q.length; k++) band[k] = q[k] * scale; const x = new Float32Array(n); upAdd(x, band, D, 1); return x; });
}

export async function getStem(key, sr, n) {
  try {
    const db = await open();
    const rec = await req(db.transaction(STORE).objectStore(STORE).get(key));
    if (!rec || rec.v !== VER || rec.sr !== sr || rec.n !== n) { db.close(); return null; }
    db.transaction(META, "readwrite").objectStore(META).put({ key, t: Date.now() });
    db.close();
    return rec;
  } catch { return null; }
}

export async function putStem(key, sr, n, packed) {
  try {
    const db = await open();
    const tx = db.transaction([STORE, META], "readwrite");
    tx.objectStore(STORE).put({ key, v: VER, sr, n, data: packed.data, scale: packed.scale });
    tx.objectStore(META).put({ key, t: Date.now() });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    // only the newest few
    const all = await req(db.transaction(META).objectStore(META).getAll());
    all.sort((a, b) => b.t - a.t);
    if (all.length > MAX) {
      const del = db.transaction([STORE, META], "readwrite");
      for (const r of all.slice(MAX)) { del.objectStore(STORE).delete(r.key); del.objectStore(META).delete(r.key); }
    }
    db.close();
  } catch {}
}
