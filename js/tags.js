// Song details and cover art straight from the file: ID3 (MP3), MP4/M4A atoms, FLAC and Ogg comments, WAV INFO.
// Only the start of the file is read (MP4 may keep its details at the end: those atoms are found by walking the file).

const td = (enc) => new TextDecoder(enc);
async function bytes(blob, start, end) { return new Uint8Array(await blob.slice(start, end).arrayBuffer()); }

function cleanName(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

/** { title, artist, album, art: Blob|null } */
export async function readTags(file) {
  const out = { title: "", artist: "", album: "", art: null };
  try {
    const head = await bytes(file, 0, 12);
    const s4 = String.fromCharCode(...head.slice(0, 4));
    if (s4.startsWith("ID3")) await id3(file, out);
    else if (s4 === "fLaC") await flac(file, out);
    else if (String.fromCharCode(...head.slice(4, 8)) === "ftyp") await mp4(file, out);
    else if (s4 === "OggS") await ogg(file, out);
    else if (s4 === "RIFF") await riff(file, out);
  } catch (e) { /* a damaged tag is no reason to refuse the song */ }
  if (!out.title) {
    const base = cleanName(file.name || "Untitled");
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (m && !out.artist) { out.artist = m[1]; out.title = m[2]; } else out.title = base;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- ID3v2
function syncsafe(b, o) { return ((b[o] & 127) << 21) | ((b[o + 1] & 127) << 14) | ((b[o + 2] & 127) << 7) | (b[o + 3] & 127); }
function deunsync(b) {
  const o = []; for (let i = 0; i < b.length; i++) { o.push(b[i]); if (b[i] === 255 && b[i + 1] === 0) i++; }
  return Uint8Array.from(o);
}
function decText(b, enc) {
  const strip = (s) => s.replace(/\u0000+$/g, "").split("\u0000")[0].trim();
  if (enc === 0) return strip(td("latin1").decode(b));
  if (enc === 1) return strip(td(b[0] === 0xfe ? "utf-16be" : "utf-16le").decode(b.subarray(2)));
  if (enc === 2) return strip(td("utf-16be").decode(b));
  return strip(td("utf-8").decode(b));
}
function nullEnd(b, o, enc) {
  if (enc === 1 || enc === 2) { for (let i = o; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i; return b.length; }
  for (let i = o; i < b.length; i++) if (b[i] === 0) return i;
  return b.length;
}
async function id3(file, out) {
  const h = await bytes(file, 0, 10);
  const ver = h[3], flags = h[5], size = syncsafe(h, 6);
  let b = await bytes(file, 10, 10 + size);
  if (flags & 0x80 && ver < 4) b = deunsync(b);
  let p = 0;
  if (flags & 0x40) p += ver === 4 ? syncsafe(b, 0) : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) + 4;
  const v2 = ver === 2;
  while (p + (v2 ? 6 : 10) < b.length) {
    const id = String.fromCharCode(...b.slice(p, p + (v2 ? 3 : 4)));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const len = v2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]
      : ver === 4 ? syncsafe(b, p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
    const fflags = v2 ? 0 : b[p + 9];
    const d0 = p + (v2 ? 6 : 10);
    let d = b.subarray(d0, d0 + len);
    if (ver === 4 && fflags & 2) d = deunsync(d);
    if (ver === 4 && fflags & 1) d = d.subarray(4);
    p = d0 + len;
    if (!len) continue;
    if (id === "TIT2" || id === "TT2") out.title = out.title || decText(d.subarray(1), d[0]);
    else if (id === "TPE1" || id === "TP1") out.artist = out.artist || decText(d.subarray(1), d[0]);
    else if (id === "TALB" || id === "TAL") out.album = out.album || decText(d.subarray(1), d[0]);
    else if ((id === "APIC" || id === "PIC") && !out.art) {
      const enc = d[0];
      let q = 1, mime;
      if (v2) { mime = "image/" + String.fromCharCode(...d.slice(1, 4)).toLowerCase().replace("jpg", "jpeg"); q = 4; }
      else { const e = nullEnd(d, 1, 0); mime = td("latin1").decode(d.subarray(1, e)) || "image/jpeg"; q = e + 1; }
      q += 1;                                        // picture type
      q = nullEnd(d, q, enc) + (enc === 1 || enc === 2 ? 2 : 1);
      if (!mime.includes("/")) mime = "image/" + mime.toLowerCase();
      out.art = new Blob([d.slice(q)], { type: mime });
    }
  }
}

// ---------------------------------------------------------------------------------------------------- FLAC
function vorbisComments(b, out, le = true) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0;
  const vl = dv.getUint32(p, le); p += 4 + vl;
  const n = dv.getUint32(p, le); p += 4;
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const l = dv.getUint32(p, le); p += 4;
    const s = td("utf-8").decode(b.subarray(p, p + l)); p += l;
    const k = s.indexOf("="); if (k < 0) continue;
    const key = s.slice(0, k).toUpperCase(), val = s.slice(k + 1).trim();
    if (key === "TITLE" && !out.title) out.title = val;
    else if (key === "ARTIST" && !out.artist) out.artist = val;
    else if (key === "ALBUM" && !out.album) out.album = val;
    else if (key === "METADATA_BLOCK_PICTURE" && !out.art) {
      try { const raw = Uint8Array.from(atob(val), (c) => c.charCodeAt(0)); flacPicture(raw, out); } catch {}
    }
  }
}
function flacPicture(d, out) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let p = 4;
  const ml = dv.getUint32(p); p += 4;
  const mime = td("latin1").decode(d.subarray(p, p + ml)); p += ml;
  const dl = dv.getUint32(p); p += 4 + dl + 16;
  const len = dv.getUint32(p); p += 4;
  out.art = new Blob([d.slice(p, p + len)], { type: mime || "image/jpeg" });
}
async function flac(file, out) {
  let p = 4;
  for (let guard = 0; guard < 64; guard++) {
    const h = await bytes(file, p, p + 4);
    if (h.length < 4) break;
    const last = h[0] & 128, type = h[0] & 127, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) vorbisComments(await bytes(file, p + 4, p + 4 + len), out);
    else if (type === 6 && !out.art) flacPicture(await bytes(file, p + 4, p + 4 + len), out);
    p += 4 + len;
    if (last) break;
  }
}

// ---------------------------------------------------------------------------------------------------- Ogg (Vorbis, Opus)
async function ogg(file, out) {
  const b = await bytes(file, 0, Math.min(file.size, 512 * 1024));
  // find the comment header packet and read on across pages (good enough for the details; big embedded art is skipped)
  const s = td("latin1").decode(b);
  let i = s.indexOf("\u0003vorbis"), off = 7;
  if (i < 0) { i = s.indexOf("OpusTags"); off = 8; }
  if (i < 0) return;
  // strip page headers that may split the packet
  const parts = [];
  let p = i + off;
  while (p < b.length) {
    const nxt = s.indexOf("OggS", p);
    if (nxt < 0) { parts.push(b.subarray(p)); break; }
    parts.push(b.subarray(p, nxt));
    const segs = b[nxt + 26];
    p = nxt + 27 + segs;
    if (parts.reduce((a, x) => a + x.length, 0) > 200000) break;
  }
  const joined = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let o = 0; for (const x of parts) { joined.set(x, o); o += x.length; }
  try { vorbisComments(joined, out); } catch {}
}

// ---------------------------------------------------------------------------------------------------- MP4 / M4A
async function mp4(file, out) {
  // walk the top level for moov
  let p = 0, moov = null;
  for (let guard = 0; guard < 200 && p + 8 <= file.size; guard++) {
    const h = await bytes(file, p, p + 16);
    let size = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    const type = String.fromCharCode(...h.slice(4, 8));
    let hdr = 8;
    if (size === 1) { size = Number(new DataView(h.buffer).getBigUint64(8)); hdr = 16; }
    else if (size === 0) size = file.size - p;
    if (type === "moov") { moov = await bytes(file, p + hdr, p + size); break; }
    if (size < 8) break;
    p += size;
  }
  if (!moov) return;
  const find = (b, path) => {
    let cur = b;
    for (const name of path) {
      let q = 0, found = null;
      while (q + 8 <= cur.length) {
        const sz = ((cur[q] << 24) | (cur[q + 1] << 16) | (cur[q + 2] << 8) | cur[q + 3]) >>> 0;
        const t = String.fromCharCode(...cur.slice(q + 4, q + 8));
        if (sz < 8) break;
        if (t === name) { found = cur.subarray(q + 8, q + sz); break; }
        q += sz;
      }
      if (!found) return null;
      cur = name === "meta" ? found.subarray(4) : found;
    }
    return cur;
  };
  const ilst = find(moov, ["udta", "meta", "ilst"]);
  if (!ilst) return;
  let q = 0;
  while (q + 8 <= ilst.length) {
    const sz = ((ilst[q] << 24) | (ilst[q + 1] << 16) | (ilst[q + 2] << 8) | ilst[q + 3]) >>> 0;
    if (sz < 8) break;
    const t = td("latin1").decode(ilst.subarray(q + 4, q + 8));
    const item = ilst.subarray(q + 8, q + sz);
    const data = find(item, ["data"]);
    if (data) {
      const kind = data[3], payload = data.subarray(8);
      if (t === "©nam") out.title = td("utf-8").decode(payload);
      else if (t === "©ART" || (t === "aART" && !out.artist)) out.artist = td("utf-8").decode(payload);
      else if (t === "©alb") out.album = td("utf-8").decode(payload);
      else if (t === "covr" && !out.art) out.art = new Blob([payload.slice()], { type: kind === 14 ? "image/png" : "image/jpeg" });
    }
    q += sz;
  }
}

// ---------------------------------------------------------------------------------------------------- WAV
async function riff(file, out) {
  let p = 12;
  for (let guard = 0; guard < 64 && p + 8 <= file.size; guard++) {
    const h = await bytes(file, p, p + 12);
    const id = String.fromCharCode(...h.slice(0, 4));
    const len = (h[4] | (h[5] << 8) | (h[6] << 16) | (h[7] << 24)) >>> 0;
    if (id === "LIST" && String.fromCharCode(...h.slice(8, 12)) === "INFO") {
      const b = await bytes(file, p + 12, p + 8 + len);
      let q = 0;
      while (q + 8 <= b.length) {
        const k = String.fromCharCode(...b.slice(q, q + 4));
        const l = (b[q + 4] | (b[q + 5] << 8) | (b[q + 6] << 16) | (b[q + 7] << 24)) >>> 0;
        const v = td("utf-8").decode(b.subarray(q + 8, q + 8 + l)).replace(/\u0000/g, "").trim();
        if (k === "INAM") out.title = v; else if (k === "IART") out.artist = v; else if (k === "IPRD") out.album = v;
        q += 8 + l + (l & 1);
      }
    }
    p += 8 + len + (len & 1);
  }
}
