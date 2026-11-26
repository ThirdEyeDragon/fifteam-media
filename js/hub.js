// The FifTeam server (social/config.json "api"): the app's data in one place online, so a phone gets what it needs in
// one quick request instead of asking the feed service for each piece (which only lets each phone make 5 requests every
// 2 seconds, and made things like Messages slow to open). Changes are sent with the version they were made on, so two
// people at once can't write over each other. A live connection hears at once when anything changes.
//   If the server can't be reached, the app goes straight to the feed service as before (hubOn() says which).
import { idToken } from "./account.js";

let cfgP = null;
function config() {
  cfgP = cfgP || fetch(new URL("../social/config.json", import.meta.url), { cache: "no-cache" }).then((r) => r.json());
  cfgP.catch(() => { cfgP = null; });
  return cfgP;
}
let downUntil = 0;
const down = () => { downUntil = Date.now() + 60e3; };
/** The server's address, if the app is to use it now ("" otherwise: not set up, or not answering a moment ago). */
export async function hubBase() { try { const c = await config(); return Date.now() > downUntil && c.api ? String(c.api).replace(/\/+$/, "") : ""; } catch { return ""; } }
export async function hubOn() { return !!(await hubBase()); }
const unavailable = () => { const e = new Error("You're offline, or the feed can't be reached."); e.down = true; return e; };
async function call(path, opt = {}) {
  const b = await hubBase();
  if (!b) throw unavailable();
  let r;
  try { r = await fetch(b + path, { cache: "no-store", ...opt }); } catch { if (navigator.onLine !== false) down(); throw unavailable(); }
  if (r.status >= 500) { down(); throw unavailable(); }
  return r;
}

// ---------------------------------------------------------------------------------------------------- stores
// (the last copy of each store, with its version: the server only sends a store again when it has changed)
const have = new Map();
let pending = new Map(), timer = 0;
/** A store, fresh: { v (its version), d (its data, the phone's own copy to change) }. Reads asked for at the same
 * moment go in one request. */
export function hubRead(k) {
  return new Promise((res, rej) => {
    if (!pending.has(k)) pending.set(k, []);
    pending.get(k).push({ res, rej });
    if (!timer) timer = setTimeout(readNow, 0);
  });
}
async function readNow() {
  const asked = pending; pending = new Map(); timer = 0;
  const keys = [...asked.keys()];
  const known = keys.filter((k) => have.has(k)).map((k) => `${k}:${have.get(k).v}`).join(",");
  try {
    const r = await call(`/v1/stores?k=${keys.join(",")}${known ? `&have=${known}` : ""}`);
    if (!r.ok) throw new Error(`Couldn't reach the feed (${r.status}). Try again.`);
    const got = (await r.json()).s || {};
    for (const k of keys) {
      const x = got[k];
      if (x && "d" in x) have.set(k, { v: x.v, d: x.d });
      const h = have.get(k);
      for (const w of asked.get(k)) h ? w.res({ v: h.v, d: structuredClone(h.d) }) : w.rej(new Error("no such store"));
    }
  } catch (e) { for (const k of keys) for (const w of asked.get(k)) w.rej(e); }
}
/** A change to a store, made on version v. Its new version; a "busy" error with .conflict if someone changed it first
 * (then read it again and make the change again). */
export async function hubWrite(k, v, d) {
  const body = JSON.stringify(d), headers = { "Content-Type": "application/json" };
  // (messages: with this phone's account, so the server knows who's changing a group chat)
  if (k === "dm") { try { const tk = await idToken(); if (tk) headers["X-FT-Auth"] = tk; } catch {} }
  const r = await call(`/v1/store/${k}?v=${v}`, { method: "PUT", headers, body });
  if (r.status === 409) { const e = new Error("The feed was busy. Try again."); e.conflict = true; have.delete(k); throw e; }
  if (r.status === 413) throw new Error("That's too big to save.");
  if (!r.ok) throw new Error(`Couldn't save that (${r.status}). Try again.`);
  const { v: nv, fixed } = await r.json();
  // (the server kept something as it was, or put something back: its copy is read next time, not this one)
  if (fixed) have.delete(k); else have.set(k, { v: nv, d: JSON.parse(body) });
  return nv;
}
/** The version of a store this phone last saw. */
export const hubVersion = (k) => (have.get(k) || {}).v || 0;

// ---------------------------------------------------------------------------------------------------- files
let fileAsk = new Map(), fileTimer = 0;
/** A post's (or picture's) files: [{ filename, url }], null if it's gone. Asked for together, many in one request. */
export function hubFiles(id) {
  return new Promise((res, rej) => {
    if (!fileAsk.has(id)) fileAsk.set(id, []);
    fileAsk.get(id).push({ res, rej });
    if (!fileTimer) fileTimer = setTimeout(filesNow, 25);
  });
}
async function filesNow() {
  const asked = fileAsk; fileAsk = new Map(); fileTimer = 0;
  const ids = [...asked.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    try {
      const r = await call("/v1/files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: part }) });
      if (!r.ok) throw new Error(`Couldn't load (${r.status})`);
      const got = (await r.json()).files || {};
      for (const id of part) for (const w of asked.get(id)) id in got ? w.res(got[id]) : w.rej(new Error("not loaded yet"));
    } catch (e) { for (const id of part) for (const w of asked.get(id)) w.rej(e); }
  }
}

// ---------------------------------------------------------------------------------------------------- live
// While the app is open: a connection to the server, which says at once when a store changes ("hub:<store>" events on
// window, with { v, to }) and passes on notifications for this phone while it's on screen ("hub:note").
export const live = { on: false, ws: null };
let tries = 0, retry = 0, pinger = 0;
export async function startLive() {
  const b = await hubBase();
  if (!b || live.ws || document.visibilityState !== "visible" || typeof WebSocket === "undefined") return;
  let ws;
  try { ws = new WebSocket(b.replace(/^http/, "ws") + "/v1/live"); } catch { return; }
  live.ws = ws;
  ws.onopen = async () => {
    live.on = true; tries = 0;
    dispatchEvent(new Event("hub:open"));
    let tk = ""; try { tk = await idToken(); } catch {}
    try { ws.send(JSON.stringify({ t: "hi", tk, vis: document.visibilityState === "visible" })); } catch {}
    clearInterval(pinger); pinger = setInterval(() => { try { ws.send("ping"); } catch {} }, 25000);
  };
  ws.onmessage = (e) => {
    if (e.data === "pong") return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "v" && m.k) { if (hubVersion(m.k) !== m.v) dispatchEvent(new CustomEvent("hub:" + m.k, { detail: { v: m.v, to: m.to || null } })); }
    else if (m.t === "note") dispatchEvent(new CustomEvent("hub:note", { detail: m }));
  };
  ws.onclose = () => {
    clearInterval(pinger);
    const was = live.on; live.on = false; live.ws = null;
    if (was) dispatchEvent(new Event("hub:closed"));
    clearTimeout(retry);
    if (document.visibilityState === "visible") retry = setTimeout(startLive, Math.min(30000, 1000 * 2 ** tries++));
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
document.addEventListener("visibilitychange", () => {
  const vis = document.visibilityState === "visible";
  if (live.ws && live.on) { try { live.ws.send(JSON.stringify({ t: "vis", vis })); } catch {} }
  if (vis && !live.ws) { tries = 0; startLive(); }
});

// ---------------------------------------------------------------------------------------------------- the rest
/** Notifications with the app closed: this browser's push sign-up, for this account (proof: its ID token). */
export async function hubPush(sub, prefs) {
  const r = await call("/v1/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tk: await idToken(), sub, prefs }) });
  if (!r.ok) throw new Error("push " + r.status);
}
export async function hubPushOff(endpoint) { await call("/v1/push/off", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) }).catch(() => {}); }
/** A report about a user (who), and maybe one of their posts or comments: { who, reason, text, post, comment }. */
export async function hubReport(r) {
  const res = await call("/v1/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tk: await idToken(), ...r }) });
  if (res.status === 429) throw new Error("You've sent a lot of reports this hour. Try again later.");
  if (!res.ok) throw new Error("Couldn't send the report. Try again.");
}
/** "Unlock unlimited rebassing" tapped: the owner hears about it. */
export async function hubPremiumAsk() { const r = await call("/v1/premium", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tk: await idToken() }) }); return r.ok; }
