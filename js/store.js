// The library on this phone: songs (and the rebasses and tones made here) are copied into the app's own database, so they
// are still here next time. IndexedDB: track details, the audio itself, cover art, and an inbox for files shared to the app.
export const DB_NAME = "fifteam-media", DB_VERSION = 1;

let dbp = null;
export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("tracks")) db.createObjectStore("tracks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
      if (!db.objectStoreNames.contains("art")) db.createObjectStore("art");
      if (!db.objectStoreNames.contains("inbox")) db.createObjectStore("inbox", { autoIncrement: true });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return openDB().then((db) => new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(...stores.map((s) => t.objectStore(s)))).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("Storage refused the change"));
  }));
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function putTrack(meta, blob, art) {
  await tx(["tracks", "blobs", "art"], "readwrite", (t, b, a) => {
    t.put(meta); b.put(blob, meta.id);
    if (art) a.put(art, meta.id);
  });
  return meta;
}
export const listTracks = () => tx(["tracks"], "readonly", (t) => req(t.getAll()));
export const getBlob = (id) => tx(["blobs"], "readonly", (b) => req(b.get(id)));
export const getArt = (id) => tx(["art"], "readonly", (a) => req(a.get(id)));
export const putArt = (id, blob) => tx(["art"], "readwrite", (a) => { a.put(blob, id); });
export const updateTrack = (meta) => tx(["tracks"], "readwrite", (t) => { t.put(meta); });
export const deleteTrack = (id) => tx(["tracks", "blobs", "art"], "readwrite", (t, b, a) => { t.delete(id); b.delete(id); a.delete(id); });

/** Files another app shared to FifTeam Media (Android's share sheet), waiting to be taken in. */
export async function takeInbox() {
  return tx(["inbox"], "readwrite", async (s) => {
    const all = await req(s.getAll());
    s.clear();
    return all;
  });
}

export async function storageUse() {
  try {
    const e = await navigator.storage.estimate();
    return e.usage || 0;
  } catch { return 0; }
}
export async function askPersist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
