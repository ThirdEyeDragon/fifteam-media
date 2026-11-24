// Bans, set by the owner with /ban in the FifTeam server (and lifted with /unban): a banned phone can't use FifTeam
// Media at all, and nobody sees its posts or comments. The list lives in its own store message (social/config.json
// "mod"), which only the FifTeam bot writes; the app reads it when it opens and every few minutes. A phone that has been
// banned remembers it, so it stays shut even offline, until the ban is lifted.
import { player } from "./player.js";

const FLAG = "fifteam-ban", LIST = "fifteam-bans", ME = "fifteam-social-me";
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }, del(k) { try { localStorage.removeItem(k); } catch {} } };

let list = new Set(), nopic = new Set();
try { list = new Set(JSON.parse(ls.get(LIST) || "[]")); } catch {}
try { nopic = new Set(JSON.parse(ls.get(LIST + "-nopic") || "[]")); } catch {}
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
  for (const id of ["app", "sheet", "toast", "lock"]) { const e = document.getElementById(id); if (e) e.inert = true; }
  try { player.pause(); } catch {}
  document.querySelectorAll("audio, video").forEach((m) => { try { m.pause(); } catch {} });
}
function hide() {
  const d = document.getElementById("ban"); if (!d) return;
  d.remove();
  for (const id of ["app", "sheet", "toast", "lock"]) { const e = document.getElementById(id); if (e && !(id === "app" && !document.getElementById("lock").hidden)) e.inert = false; }
}

let checkedAt = 0;
/** The ban list, fresh: this phone shut (or opened again, if its ban was lifted). */
export async function checkBans() {
  checkedAt = Date.now();
  try {
    const c = await (await fetch(new URL("../social/config.json", import.meta.url), { cache: "no-cache" })).json();
    if (!c.mod) return;
    const base = `https://discord.com/api/v10/webhooks/${c.hook}/${atob(c.key).split("").reverse().join("")}`;
    const r = await fetch(`${base}/messages/${c.mod}`, { cache: "no-store" });
    if (!r.ok) return;
    const a = ((await r.json()).attachments || []).find((x) => x.filename === "mod.json");
    if (!a) return;
    const d = await (await fetch(a.url, { cache: "no-store" })).json();
    const bans = d && d.bans && typeof d.bans === "object" ? Object.keys(d.bans).filter((k) => /^[a-z0-9]{6,16}$/.test(k)) : [];
    list = new Set(bans); ls.set(LIST, JSON.stringify(bans));
    const np = d && d.nopic && typeof d.nopic === "object" ? Object.keys(d.nopic).filter((k) => /^[a-z0-9]{6,16}$/.test(k)) : [];
    nopic = new Set(np); ls.set(LIST + "-nopic", JSON.stringify(np));
    const me = ls.get(ME) || "";
    if (me && list.has(me)) { await setFlag(true); show(); }
    else if (await flagged()) { await setFlag(false); hide(); }
  } catch {}
}
export async function initBan() {
  if (await flagged()) show();
  setTimeout(checkBans, 1500);
  setInterval(() => { if (document.visibilityState === "visible") checkBans(); }, 10 * 60e3);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - checkedAt > 3 * 60e3) checkBans(); });
}
