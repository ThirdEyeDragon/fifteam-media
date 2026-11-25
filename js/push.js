// Notifications with the app closed (Web Push, through the FifTeam server): this phone signs up for them when they're
// switched on in Settings (and the phone allows them), with proof of its account, so only its own notifications reach it.
// New messages ("fifteam-dm-notify"), and likes, comments, replies, follows and requests ("fifteam-act-notify"), each on
// by default. On iPhone they work once FifTeam Media is on the Home Screen (iOS 16.4 or later).
import { account } from "./account.js";
import { hubOn, hubPush, hubPushOff } from "./hub.js";

const DM = "fifteam-dm-notify", ACT = "fifteam-act-notify", SENT = "fifteam-push";
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }, del(k) { try { localStorage.removeItem(k); } catch {} } };
export const msgWanted = () => ls.get(DM) !== "0";
export const actWanted = () => ls.get(ACT) !== "0";
export function setActWanted(on) { ls.set(ACT, on ? "1" : "0"); }
export const canPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
/** Whether this phone gets notifications from the server (so the app doesn't show its own for the same thing). */
export const pushing = () => !!ls.get(SENT) && canPush() && Notification.permission === "granted";

let cfgP = null;
const pushKey = async () => { cfgP = cfgP || fetch(new URL("../social/config.json", import.meta.url), { cache: "no-cache" }).then((r) => r.json()); try { return (await cfgP).push || ""; } catch { cfgP = null; return ""; } };
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

let busy = null;
/** Signed up (or not) to match what's wanted now: once a day it's sent again, and at once when anything changed. */
export function syncPush(force = false) {
  busy = busy || (async () => {
    try {
      if (!canPush() || !account() || !(await hubOn())) return;
      const key = await pushKey();
      if (!key) return;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      const want = Notification.permission === "granted" && (msgWanted() || actWanted());
      if (!want) { if (sub) { await hubPushOff(sub.endpoint); await sub.unsubscribe().catch(() => {}); } ls.del(SENT); return; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key) });
      const prefs = { msg: msgWanted(), act: actWanted() };
      const sig = JSON.stringify([sub.endpoint, prefs, account().uid]);
      let last = null; try { last = JSON.parse(ls.get(SENT) || "null"); } catch {}
      if (!force && last && last.sig === sig && Date.now() - last.at < 86400e3) return;
      await hubPush(sub.toJSON(), prefs);
      ls.set(SENT, JSON.stringify({ sig, at: Date.now() }));
    } catch {} finally { busy = null; }
  })();
  return busy;
}
/** Signing out: no more notifications for that account on this phone. */
export async function pushOff() {
  ls.del(SENT);
  if (!canPush()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) { await hubPushOff(sub.endpoint); await sub.unsubscribe().catch(() => {}); }
}
export function initPush() {
  setTimeout(() => syncPush(), 3000);
  addEventListener("fifteam-signed-in", () => syncPush(true));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncPush(); });
}
