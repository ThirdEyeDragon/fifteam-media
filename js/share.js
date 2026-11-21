// Sending songs to friends with no server in between.
//   Locked file: the finished song (with its cover and every detail) sealed with AES-256-GCM under a key made from a
//   random 12-character code (PBKDF2, 200 000 rounds). It travels as an ordinary WAV, so any app will carry it: played
//   anywhere else it is a second of silence; FifTeam Media opens it with the code, sent separately.
//   Rebass code: a short sealed code carrying exactly which song (title, artist, length, a fingerprint of the file) and
//   exactly how it was rebassed. A friend with the same song gets the very same rebass from it, without the file.
import { $, toast, openSheet, closeSheet, fmtTime } from "./ui.js";
import { SHARE_MAX, sizeText, saveFile } from "./export.js";

const enc = new TextEncoder(), dec = new TextDecoder();
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const canSeal = () => !!(window.crypto && crypto.subtle);

async function aesKey(secret, salt, rounds) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, k, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/** A fresh unlock code: 12 characters (60 bits), easy to read out: ABCD-EFGH-JKMN. */
export function newCode() {
  const r = rand(12);
  let s = ""; for (let i = 0; i < 12; i++) s += B32[r[i] & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
/** A typed code, tidied: capitals, no spaces or dashes, the letters that look like digits read as digits. */
const tidy = (c) => String(c).toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");

// ---------------------------------------------------------------------------------------------------- locked files
const TAG = "fT1k";
function wavShell(extra) {
  // one second of silence, 8 kHz mono, then the sealed song in a chunk of its own
  const sr = 8000, data = sr * 2;
  const head = new ArrayBuffer(44), v = new DataView(head);
  const w4 = (o, t) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  const total = 4 + 24 + 8 + data + 8 + extra.size + (extra.size & 1);
  w4(0, "RIFF"); v.setUint32(4, total, true); w4(8, "WAVE");
  w4(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w4(36, "data"); v.setUint32(40, data, true);
  const ch = new ArrayBuffer(8), cv = new DataView(ch);
  for (let i = 0; i < 4; i++) cv.setUint8(i, TAG.charCodeAt(i));
  cv.setUint32(4, extra.size, true);
  return new Blob([head, new Uint8Array(data), ch, extra, extra.size & 1 ? new Uint8Array(1) : new Uint8Array(0)], { type: "audio/wav" });
}
/** Seals { audio, cover, meta } with the code. Returns a WAV blob. */
export async function lockFile({ audio, cover, meta }, code) {
  const header = enc.encode(JSON.stringify({ v: 1, ...meta, audioType: audio.type || "audio/wav", audioLen: audio.size, coverType: cover ? cover.type : "", coverLen: cover ? cover.size : 0 }));
  const hl = new Uint8Array(4); new DataView(hl.buffer).setUint32(0, header.length);
  const plain = await new Blob([hl, header, audio, cover || new Uint8Array(0)]).arrayBuffer();
  const salt = rand(16), iv = rand(12), key = await aesKey(tidy(code), salt, 200000);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return wavShell(new Blob([salt, iv, sealed]));
}
/** Where a locked file's sealed part sits, or null if it isn't one. */
export async function lockedPart(file) {
  if (!file || file.size < 64) return null;
  const head = new DataView(await file.slice(0, 12).arrayBuffer());
  const s4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (s4(head, 0) !== "RIFF" || s4(head, 8) !== "WAVE") return null;
  let o = 12;
  while (o + 8 <= file.size) {
    const dv = new DataView(await file.slice(o, o + 8).arrayBuffer());
    const id = s4(dv, 0), len = dv.getUint32(4, true);
    if (id === TAG) return { start: o + 8, len };
    o += 8 + len + (len & 1);
  }
  return null;
}
/** Opens a locked file with its code: { meta, audio, cover }. Throws "code" if the code is wrong. */
export async function unlockFile(file, code) {
  const part = await lockedPart(file);
  if (!part) throw new Error("not-locked");
  const buf = new Uint8Array(await file.slice(part.start, part.start + part.len).arrayBuffer());
  const salt = buf.slice(0, 16), iv = buf.slice(16, 28);
  const key = await aesKey(tidy(code), salt, 200000);
  let plain;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, buf.slice(28))); } catch { throw new Error("code"); }
  const hl = new DataView(plain.buffer).getUint32(0);
  const meta = JSON.parse(dec.decode(plain.slice(4, 4 + hl)));
  const a0 = 4 + hl, a1 = a0 + meta.audioLen;
  const audio = new Blob([plain.slice(a0, a1)], { type: meta.audioType });
  const cover = meta.coverLen ? new Blob([plain.slice(a1, a1 + meta.coverLen)], { type: meta.coverType || "image/jpeg" }) : null;
  return { meta, audio, cover };
}

// ---------------------------------------------------------------------------------------------------- rebass codes
const RECIPE = "FifTeam Media rebass code v1";
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function squeeze(bytes, how) {
  if (!window.CompressionStream) return null;
  try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(how === "in" ? new CompressionStream("deflate-raw") : new DecompressionStream("deflate-raw"))).arrayBuffer()); } catch { return null; }
}
/** The fingerprint of a song file: the start of its SHA-256. */
export async function fingerprint(blob) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return Array.from(h.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** { title, artist, duration, hash, settings } -> "FT1.xxxxx" */
export async function makeRecipe(r) {
  const json = enc.encode(JSON.stringify({ t: (r.title || "").slice(0, 60), a: (r.artist || "").slice(0, 60), d: Math.round((r.duration || 0) * 10), h: r.hash, s: r.settings }));
  const packed = await squeeze(json, "in");
  const body = packed && packed.length < json.length ? packed : json;
  const salt = rand(4), iv = rand(12), key = await aesKey(RECIPE, salt, 20000);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, body));
  return "FT1." + b64u(new Uint8Array([packed && body === packed ? 1 : 0, ...salt, ...iv, ...sealed]));
}
export const looksLikeRecipe = (s) => /FT1\.[A-Za-z0-9_-]{30,}/.test(s || "");
export async function readRecipe(text) {
  const m = /FT1\.([A-Za-z0-9_-]{30,})/.exec(text || "");
  if (!m) throw new Error("format");
  const raw = unb64u(m[1]);
  const key = await aesKey(RECIPE, raw.slice(1, 5), 20000);
  let body;
  try { body = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(5, 17) }, key, raw.slice(17))); } catch { throw new Error("damaged"); }
  if (raw[0] === 1) body = await squeeze(body, "out");
  const o = JSON.parse(dec.decode(body));
  return { title: o.t, artist: o.a, duration: o.d / 10, hash: o.h, settings: o.s };
}

// ---------------------------------------------------------------------------------------------------- the screens
function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function copy(text) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }

/**
 * The Share sheet. opts: { what ("song" | "tone"), name, build({ maxBytes }) -> { file, fresh, swapped }, meta() -> details
 * for a locked file, cover() -> Blob|null, recipe() -> { title, artist, duration, hash, settings } (rebasses only) }
 * build() makes the file in the chosen format, or as an MP3 (swapped) when that format would be too big to share.
 */
export function openShareSheet(opts) {
  openSheet((p) => {
    p.append(el(`<h3>Share ${opts.what === "tone" ? "this tone" : "your rebass"}</h3>`));
    const plain = el('<button class="menu-item"><svg><use href="#i-share"/></svg><span>Send the file<small>Any app</small></span></button>');
    const locked = el('<button class="menu-item"><svg><use href="#i-lock"/></svg><span>Send a locked file<small>Opens only with its code</small></span></button>');
    p.append(plain, locked);
    let recipeBtn = null;
    if (opts.recipe) { recipeBtn = el('<button class="menu-item"><svg><use href="#i-key"/></svg><span>Send a rebass code<small>No file. Your friend needs the same song</small></span></button>'); p.append(recipeBtn); }
    const out = el('<div class="share-out" hidden></div>');
    p.append(out);
    const busy = (b, on, label) => { b.disabled = on; if (label) b.querySelector("small").textContent = label; };
    const tooBig = (swapped) => { if (swapped) toast("As a WAV it's too big to share (50 MB most), so it's going as an MP3 320.", 4500); };
    plain.onclick = async () => {
      const t0 = Date.now();
      busy(plain, true, "Getting it ready…");
      try {
        const { file, swapped } = await opts.build({ maxBytes: SHARE_MAX });
        busy(plain, false, "Any app");
        tooBig(swapped);
        await sendFile(file, opts.name(), out, t0);
      } catch (e) { busy(plain, false, "Any app"); toast("Couldn't make the file. " + (e.message || "")); }
    };
    locked.onclick = async () => {
      if (!canSeal()) { toast("Locking needs the app opened from its https address."); return; }
      busy(locked, true, "Sealing it…");
      try {
        const cover = opts.cover ? await opts.cover() : null;
        const { file, swapped } = await opts.build({ maxBytes: SHARE_MAX - (cover ? cover.size : 0) - 64 * 1024 });
        tooBig(swapped);
        const code = newCode();
        const sealed = await lockFile({ audio: file, cover, meta: { ...opts.meta(), fileName: file.name } }, code);
        const lf = new File([sealed], `${opts.name()} (locked).wav`, { type: "audio/wav" });
        busy(locked, false, "Opens only with its code");
        out.hidden = false;
        out.innerHTML = `<p class="status">Send this code separately. Without it the file won't open.</p>
          <div class="code-box"><b>${code}</b><button class="btn small" data-copy>Copy code</button></div>
          <div class="row"><button class="btn primary grow" data-send>Send the locked file</button></div>`;
        out.querySelector("[data-copy]").onclick = async () => toast((await copy(code)) ? "Code copied" : code, 2500);
        out.querySelector("[data-send]").onclick = () => sendFile(lf, opts.name() + " (locked)", null);
      } catch (e) { busy(locked, false, "Opens only with its code"); toast("Couldn't lock the file. " + (e.message || "")); }
    };
    if (recipeBtn) recipeBtn.onclick = async () => {
      if (!canSeal()) { toast("Codes need the app opened from its https address."); return; }
      busy(recipeBtn, true, "Making the code…");
      try {
        const r = await opts.recipe();
        const code = await makeRecipe(r);
        const link = `${location.origin}${location.pathname}#code=${code}`;
        busy(recipeBtn, false, "No file. Your friend needs the same song");
        out.hidden = false;
        out.innerHTML = `<p class="status">${esc(r.title)}${r.artist ? " · " + esc(r.artist) : ""}</p>
          <div class="code-box long"><code>${code}</code></div>
          <div class="row"><button class="btn grow" data-copy>Copy code</button><button class="btn primary grow" data-send>Send</button></div>`;
        out.querySelector("[data-copy]").onclick = async () => toast((await copy(code)) ? "Code copied" : "Select the code and copy it", 2500);
        out.querySelector("[data-send]").onclick = async () => {
          const text = `A FifTeam Media rebass of ${r.title}${r.artist ? " by " + r.artist : ""}. Open it in the app (Library, Code): ${code}`;
          try { if (navigator.share) { await navigator.share({ title: "FifTeam rebass code", text, url: link }); return; } } catch (e) { if (e && e.name === "AbortError") return; }
          toast((await copy(text + " " + link)) ? "Copied. Paste it to your friend." : code, 4000);
        };
      } catch (e) { busy(recipeBtn, false, "No file. Your friend needs the same song"); toast("Couldn't make the code. " + (e.message || "")); }
    };
  });
}

/** Hands a file to the phone's share sheet.
 * - Over the share sheet's limit (50 MB on Android) or a phone that can't share files: saved to the phone instead.
 * - Making a file can outlast the tap that asked for it (a phone gives a tap about 5 s): then a button appears to send
 *   it with a fresh tap.
 * - The sheet closed by the person: nothing more. Any other failure: saved to the phone instead, and said so. */
export async function sendFile(file, title, out, t0 = Date.now()) {
  const instead = async (why) => {
    toast(`${why} Saving it to your phone instead, so you can send it from your files.`, 6000);
    try { await saveFile(file); } catch {}
    return "saved";
  };
  if (file.size > SHARE_MAX) return instead(`It's ${sizeText(file.size)}, more than a share sheet takes (50 MB).`);
  const can = (() => { try { return !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch { return false; } })();
  if (!can) return instead("This phone can't share files from here.");
  const go = () => navigator.share({ files: [file], title });
  const closed = (e) => e && e.name === "AbortError" && !/fail/i.test(e.message || "");
  try { await go(); return "shared"; }
  catch (e) {
    if (closed(e)) return "closed";
    const expired = e && e.name === "NotAllowedError" && (/gesture|activation/i.test(e.message || "") || Date.now() - t0 > 4000);
    const box = out || document.querySelector(".share-out");
    if (expired && box) {
      box.hidden = false;
      const b = el('<button class="btn primary block">Ready: tap to send</button>');
      b.onclick = async () => {
        b.remove();
        try { await go(); } catch (err) { if (!closed(err)) instead("Sharing didn't go through."); }
      };
      box.prepend(b);
      return "ready";
    }
    return instead("Sharing didn't go through.");
  }
}

/** Asks for the code of a locked file, opens it and hands { meta, audio, cover } to onOpen. */
export function askUnlock(file, onOpen) {
  openSheet((p) => {
    p.append(el(`<h3>A locked song</h3>`));
    p.append(el(`<p class="status">${esc(file.name)}</p>`));
    const inp = el('<input class="input code-in" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH-JKMN" aria-label="Unlock code">');
    const msg = el('<p class="set-err"></p>');
    const go = el('<button class="btn primary block">Open it</button>');
    p.append(inp, msg, go);
    setTimeout(() => inp.focus(), 250);
    const run = async () => {
      if (tidy(inp.value).length < 12) { msg.textContent = "The code has 12 letters and numbers."; return; }
      go.disabled = true; go.textContent = "Opening…";
      try { const r = await unlockFile(file, inp.value); closeSheet(); await onOpen(r); }
      catch (e) { msg.textContent = e.message === "code" ? "That code doesn't open this file." : "This file is damaged."; }
      go.disabled = false; go.textContent = "Open it";
    };
    go.onclick = run;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  });
}

/** The "Code" sheet: paste a rebass code (or pick a locked file). onRecipe(recipe), onLockedFile(file). */
export function openCodeSheet({ prefill = "", onRecipe, onLockedFile }) {
  openSheet((p) => {
    p.append(el("<h3>Open a code</h3>"));
    p.append(el('<p class="status">Paste a rebass code, or open a locked file.</p>'));
    const inp = el('<textarea class="input code-in" rows="3" autocomplete="off" spellcheck="false" placeholder="FT1.…" aria-label="Rebass code"></textarea>');
    inp.value = prefill;
    const msg = el('<p class="set-err"></p>');
    const go = el('<button class="btn primary block">Open the code</button>');
    const pick = el('<button class="btn block"><svg><use href="#i-lock"/></svg>Open a locked file</button>');
    p.append(inp, msg, go, pick);
    go.onclick = async () => {
      msg.textContent = "";
      if (!looksLikeRecipe(inp.value)) { msg.textContent = "That isn't a rebass code. They start with FT1."; return; }
      go.disabled = true;
      try { const r = await readRecipe(inp.value); closeSheet(); await onRecipe(r); }
      catch { msg.textContent = "That code is damaged or incomplete. Copy all of it and try again."; }
      go.disabled = false;
    };
    pick.onclick = () => {
      const fi = $("lock-in"); fi.value = "";
      fi.onchange = () => { const f = fi.files[0]; if (f) { closeSheet(); onLockedFile(f); } };
      fi.click();
    };
    if (prefill) setTimeout(() => go.click(), 50);
  });
}

/** What a received rebass code describes, for the sheet that says what's needed. */
export function describeRecipe(r) {
  const s = r.settings || {};
  const parts = [`${s.lo === s.hi ? s.lo : `${s.lo}–${s.hi}`} Hz`, `${s.db === 0 ? "0" : "−" + Math.abs(s.db)} dB`];
  if (s.speed && s.speed < 1) parts.push(`slowed ${Math.round(s.speed * 100)}%`);
  if (s.reverb) parts.push("reverb");
  return `${r.title}${r.artist ? " · " + r.artist : ""} (${fmtTime(r.duration)}) · ${parts.join(", ")}`;
}
