// Bans, set by the owner with /ban in the FifTeam server (and lifted with /unban): a banned phone can't use FifTeam
// Media at all, and nobody sees its posts or comments. The list lives in its own store message (social/config.json
// "mod"), which only the FifTeam bot writes; the app reads it when it opens and every few minutes. A phone that has been
// banned remembers it, so it stays shut even offline, until the ban is lifted.
import { player } from "./player.js";
import { hookFetch } from "./limiter.js";
import { hubOn, hubRead } from "./hub.js";

const FLAG = "fifteam-ban", LIST = "fifteam-bans", ME = "fifteam-social-me";
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }, del(k) { try { localStorage.removeItem(k); } catch {} } };

let list = new Set(), nopic = new Set();
try { list = new Set(JSON.parse(ls.get(LIST) || "[]")); } catch {}
try { nopic = new Set(JSON.parse(ls.get(LIST + "-nopic") || "[]")); } catch {}
// bans by email: kept as fingerprints (SHA-256 of the address), so the list doesn't show anyone's email
let emails = new Set();
try { emails = new Set(JSON.parse(ls.get(LIST + "-emails") || "[]")); } catch {}
export async function emailHash(email) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(email || "").trim().toLowerCase()));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Whether an email has been banned (the list as last read; read again first if it's never been). */
export async function emailBanned(email) {
  if (!email) return false;
  if (!checkedAt) await checkBans();
  return emails.has(await emailHash(email));
}
const myEmail = () => { try { return (JSON.parse(ls.get("fifteam-account") || "null") || {}).email || ""; } catch { return ""; } };
let premium = new Set();
try { premium = new Set(JSON.parse(ls.get(LIST + "-premium") || "[]")); } catch {}
/** Whether this phone has unlimited rebassing (paid for, and unlocked with /premium). */
export const isPremium = (phone) => !!phone && premium.has(phone);
let streamers = new Set();
try { streamers = new Set(JSON.parse(ls.get(LIST + "-stream") || "[]")); } catch {}
/** Whether this phone may go live in Social (the owner lets them, with /allow streaming). */
export const isStreamer = (phone) => !!phone && streamers.has(phone);
let badges = {};
try { badges = JSON.parse(ls.get(LIST + "-badges") || "{}") || {}; } catch {}
const BADGES = ["founder", "dev", "advertiser", "member"];
/** The tags the FifTeam team gave a phone (set with the bot): "founder", "dev", "advertiser", "member", in that order. */
export const badgesOf = (phone) => (phone && badges[phone]) || [];
/** The phones whose profile pictures the moderators took down (not shown, and not sent again). */
export const noPicPhones = () => nopic;
/** The phones that are banned (their posts and comments aren't shown). */
export const bannedPhones = () => list;

async function flagged() {
  if (ls.get(FLAG) === "1") return true;
  // (kept in the app's cache too, so clearing just one place isn't enough)
  try { return !!(await (await caches.open("fifteam-flags")).match("ban")); } catch { return false; }
}
async function setFlag(on) {
  if (on) ls.set(FLAG, "1"); else ls.del(FLAG);
  try { const c = await caches.open("fifteam-flags"); if (on) await c.put("ban", new Response("1")); else await c.delete("ban"); } catch {}
}

function show() {
  if (document.getElementById("ban")) return;
  const d = document.createElement("div");
  d.className = "lock"; d.id = "ban"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
  d.innerHTML = `<div class="lock-box"><span class="lock-mark"><svg><use href="#i-lock"/></svg></span><h2>This phone is banned</h2><p class="status">FifTeam Media can't be used on this phone.</p></div>`;
  document.body.appendChild(d);
  for (const id of ["app", "sheet", "toast"]) { const e = document.getElementById(id); if (e) e.inert = true; }
  try { player.pause(); } catch {}
  document.querySelectorAll("audio, video").forEach((m) => { try { m.pause(); } catch {} });
}
function hide() {
  const d = document.getElementById("ban"); if (!d) return;
  d.remove();
  for (const id of ["app", "sheet", "toast"]) { const e = document.getElementById(id); if (e) e.inert = false; }
}

let checkedAt = 0;
/** The ban list, fresh: this phone shut (or opened again, if its ban was lifted). */
export async function checkBans() {
  checkedAt = Date.now();
  try {
    const c = await (await fetch(new URL("../social/config.json", import.meta.url), { cache: "no-cache" })).json();
    if (!c.mod) return;
    let d = null;
    if (await hubOn()) { try { d = (await hubRead("mod")).d; } catch {} }
    if (!d) {
      const base = `https://discord.com/api/v10/webhooks/${c.hook}/${atob(c.key).split("").reverse().join("")}`;
      const r = await hookFetch(`${base}/messages/${c.mod}`, { cache: "no-store" }, true);
      if (!r.ok) return;
      const a = ((await r.json()).attachments || []).find((x) => x.filename === "mod.json");
      if (!a) return;
      d = await (await fetch(a.url, { cache: "no-store" })).json();
    }
    const bans = d && d.bans && typeof d.bans === "object" ? Object.keys(d.bans).filter((k) => /^[a-z0-9]{6,16}$/.test(k)) : [];
    list = new Set(bans); ls.set(LIST, JSON.stringify(bans));
    const np = d && d.nopic && typeof d.nopic === "object" ? Object.keys(d.nopic).filter((k) => /^[a-z0-9]{6,16}$/.test(k)) : [];
    nopic = new Set(np); ls.set(LIST + "-nopic", JSON.stringify(np));
    const bg = {};
    for (const [k, v] of Object.entries((d && d.badges) || {})) if (/^[a-z0-9]{6,16}$/.test(k) && Array.isArray(v)) { const l = BADGES.filter((b) => v.includes(b)); if (l.length) bg[k] = l; }
    const changed = JSON.stringify(bg) !== JSON.stringify(badges);
    badges = bg; ls.set(LIST + "-badges", JSON.stringify(bg));
    if (changed) window.dispatchEvent(new Event("fifteam-badges"));
    // unlimited rebassing (the $10 unlock), given with /premium
    const pm = d && d.premium && typeof d.premium === "object" ? Object.keys(d.premium).filter((k) => /^[a-z0-9]{6,16}$/.test(k)) : [];
    const wasMine = premium.has(ls.get(ME) || "");
    premium = new Set(pm); ls.set(LIST + "-premium", JSON.stringify(pm));
    if (!wasMine && premium.has(ls.get(ME) || "")) window.dispatchEvent(new Event("fifteam-premium"));
    // who may go live (/allow streaming)
    const sm = d && d.stream && typeof d.stream === "object" ? Object.keys(d.stream).filter((k) => /^[a-z0-9]{6,16}$/.test(k)) : [];
    const streamChanged = sm.join() !== [...streamers].join();
    streamers = new Set(sm); ls.set(LIST + "-stream", JSON.stringify(sm));
    if (streamChanged) window.dispatchEvent(new Event("fifteam-streamers"));
    const em = d && d.emails && typeof d.emails === "object" ? Object.keys(d.emails).filter((k) => /^[0-9a-f]{64}$/.test(k)) : [];
    emails = new Set(em); ls.set(LIST + "-emails", JSON.stringify(em));
    const me = ls.get(ME) || "", mail = myEmail();
    if ((me && list.has(me)) || (mail && emails.has(await emailHash(mail)))) { await setFlag(true); show(); }
    else if (await flagged()) { await setFlag(false); hide(); }
  } catch {}
}
export async function initBan() {
  if (await flagged()) show();
  setTimeout(checkBans, 1500);
  setInterval(() => { if (document.visibilityState === "visible") checkBans(); }, 10 * 60e3);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - checkedAt > 3 * 60e3) checkBans(); });
}
