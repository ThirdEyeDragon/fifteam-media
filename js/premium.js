// Unlimited rebassing: free accounts rebass up to 10 different songs an hour (rebassing the same song again, with other
// settings, doesn't count again); $10, once, unlocks unlimited rebassing for the account on every phone it's signed in
// to. Paying is through PayPal; the FifTeam team unlocks the account (/premium) once the payment's in.
import { toast, openSheet } from "./ui.js";
import { isPremium } from "./ban.js";
import { hubPremiumAsk } from "./hub.js";

export const LIMIT = 10;
const HOUR = 3600e3, KEY = "fifteam-rebass-hour", ASKED = "fifteam-premium-asked";
const PAY = "https://www.paypal.com/paypalme/lnewman21s/10USD";
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const me = () => ls.get("fifteam-social-me") || "";
const myName = () => ls.get("fifteam-social-name") || "";
export const premiumNow = () => isPremium(me());

/** The songs rebassed in the last hour: [{ k, at }] (kept in the app's cache too, so clearing one place isn't enough). */
let done = [];
try { done = JSON.parse(ls.get(KEY) || "[]"); } catch {}
const recent = () => (done = (Array.isArray(done) ? done : []).filter((x) => x && typeof x.k === "string" && Date.now() - x.at < HOUR));
(async () => { try { const r = await (await caches.open("fifteam-flags")).match("rebass-hour"); const c = r ? await r.json() : []; if (Array.isArray(c)) { const ks = new Set(recent().map((x) => x.k)); for (const x of c) if (x && !ks.has(x.k)) done.push(x); } } catch {} })();
function save() {
  const l = recent();
  ls.set(KEY, JSON.stringify(l));
  caches.open("fifteam-flags").then((c) => c.put("rebass-hour", new Response(JSON.stringify(l)))).catch(() => {});
}
/** Rebasses left this hour (Infinity with the unlock). */
export const leftThisHour = () => (premiumNow() ? Infinity : Math.max(0, LIMIT - recent().length));
/** Whether this song can be rebassed now (a song already rebassed this hour always can). */
export const rebassAllowed = (k) => premiumNow() || recent().some((x) => x.k === k) || recent().length < LIMIT;
/** A song rebassed. */
export function noteRebass(k) { if (!recent().some((x) => x.k === k)) { done.push({ k, at: Date.now() }); save(); } }
const nextFree = () => { const l = recent(); return l.length ? Math.max(1, Math.ceil((l[0].at + HOUR - Date.now()) / 60e3)) : 0; };

/** The unlock: what it is, PayPal, and the username to put in the note. */
export function openUnlock(full = true) {
  openSheet((p) => {
    p.classList.add("pm-panel");
    const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    p.append(h("h3", "", "Unlimited rebassing"));
    if (premiumNow()) { p.append(h("p", "pm-done", "You have unlimited rebassing. Thank you for supporting FifTeam Media!")); return; }
    if (full) p.append(h("p", "status", `You've rebassed ${LIMIT} songs in the last hour. Free accounts can rebass ${LIMIT} songs an hour; the next one frees up in ${nextFree()} min.`));
    const card = h("div", "pm-card");
    card.append(h("b", "pm-price", "$10"), h("span", "pm-once", "once, for good"), h("span", "pm-what", "Rebass as many songs as you like, on every phone you sign in to."));
    p.append(card);
    const name = myName() || "your username";
    const steps = h("ol", "pm-steps");
    const s1 = h("li", "", "Tap Pay with PayPal and send $10.");
    const s2 = h("li", ""); s2.append("In the note, put your username: ");
    const nm = h("b", "pm-name", name); s2.append(nm);
    const cp = h("button", "btn small pm-copy", "Copy"); cp.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(name).then(() => toast("Copied", 1200), () => {}); };
    s2.append(" ", cp);
    const s3 = h("li", "", "It unlocks by itself once the payment's confirmed (usually within a day). You'll see a note here when it does.");
    steps.append(s1, s2, s3);
    const pay = h("a", "btn primary block pm-pay", "Pay $10 with PayPal");
    pay.href = PAY; pay.target = "_blank"; pay.rel = "noopener";
    pay.onclick = () => { ls.set(ASKED, String(Date.now())); hubPremiumAsk().catch(() => {}); setTimeout(() => { const w = document.querySelector("#sheet-panel .pm-wait"); if (w) w.hidden = false; }, 800); };
    const wait = h("p", "status pm-wait", "Thanks! We'll unlock it as soon as the payment's in.");
    wait.hidden = !ls.get(ASKED);
    p.append(steps, pay, wait);
  });
}
export function initPremium() {
  addEventListener("fifteam-premium", () => toast("Unlimited rebassing unlocked. Thank you for supporting FifTeam Media!", 5000));
}
