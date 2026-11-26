// FifTeam Premium: one payment ($10, once) unlocks, for the account on every phone it's signed in to:
//   - unlimited rebassing (free: 10 different songs an hour; the same song again, with other settings, doesn't count again)
//   - unlimited song downloads (free: 5 an hour: a song added to the library from Social or a message, or saved as a file)
//   - 4th and 6th-order bandpass boxes in Box (standard, series and hallway)
// Paying is through PayPal; the FifTeam team unlocks the account (/premium) once the payment's in.
import { toast, openSheet } from "./ui.js";
import { isPremium } from "./ban.js";
import { hubPremiumAsk } from "./hub.js";

export const LIMIT = 10, DL_LIMIT = 5, PRICE = 10;
const HOUR = 3600e3, KEY = "fifteam-rebass-hour", DL_KEY = "fifteam-dl-hour", ASKED = "fifteam-premium-asked";
const PAY = "https://www.paypal.com/paypalme/lnewman21s/10USD";
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const me = () => ls.get("fifteam-social-me") || "";
const myName = () => ls.get("fifteam-social-name") || "";
// (the app's own tests, run on this computer: Premium switched on by hand)
const testing = () => { try { return /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && ls.get("fifteam-test-premium") === "1"; } catch { return false; } };
export const premiumNow = () => testing() || isPremium(me());

/** What Premium gives, for the sheet and Settings: [icon, title, what]. */
export const FEATURES = [
  ["i-bass", "Unlimited rebassing", `Rebass as many songs as you want (free: ${LIMIT} an hour)`],
  ["i-lib", "Unlimited downloads", `Add and save as many songs as you want (free: ${DL_LIMIT} an hour)`],
  ["i-box", "4th-order boxes", "Bandpass boxes: standard and hallway, designed for your sub"],
  ["i-port", "6th-order boxes", "Standard, series and hallway 6th orders, the loudest builds"],
];

// ---------------------------------------------------------------------------------------------------- hourly counts
/** A count of things done in the last hour, by key (kept in the app's cache too, so clearing one place isn't enough). */
function hourly(key, cacheName) {
  let done = [];
  try { done = JSON.parse(ls.get(key) || "[]"); } catch {}
  const recent = () => (done = (Array.isArray(done) ? done : []).filter((x) => x && typeof x.k === "string" && Date.now() - x.at < HOUR));
  (async () => { try { const r = await (await caches.open("fifteam-flags")).match(cacheName); const c = r ? await r.json() : []; if (Array.isArray(c)) { const ks = new Set(recent().map((x) => x.k)); for (const x of c) if (x && !ks.has(x.k)) done.push(x); } } catch {} })();
  const save = () => {
    const l = recent();
    ls.set(key, JSON.stringify(l));
    caches.open("fifteam-flags").then((c) => c.put(cacheName, new Response(JSON.stringify(l)))).catch(() => {});
  };
  return {
    recent,
    has: (k) => recent().some((x) => x.k === k),
    note(k) { if (!recent().some((x) => x.k === k)) { done.push({ k, at: Date.now() }); save(); } },
    /** Minutes until the oldest frees up. */
    next() { const l = recent(); return l.length ? Math.max(1, Math.ceil((l[0].at + HOUR - Date.now()) / 60e3)) : 0; },
  };
}
const rebasses = hourly(KEY, "rebass-hour"), downloads = hourly(DL_KEY, "dl-hour");

/** Rebasses left this hour (Infinity with Premium). */
export const leftThisHour = () => (premiumNow() ? Infinity : Math.max(0, LIMIT - rebasses.recent().length));
/** Whether this song can be rebassed now (a song already rebassed this hour always can). */
export const rebassAllowed = (k) => premiumNow() || rebasses.has(k) || rebasses.recent().length < LIMIT;
/** A song rebassed. */
export const noteRebass = (k) => rebasses.note(k);

/** Downloads left this hour (Infinity with Premium). */
export const downloadsLeft = () => (premiumNow() ? Infinity : Math.max(0, DL_LIMIT - downloads.recent().length));
/** Whether this song (or these songs: a playlist) can be downloaded now (one already downloaded this hour always can be
 * again). If not, the Premium sheet says why. */
export function downloadAllowed(k) {
  if (premiumNow()) return true;
  const fresh = (Array.isArray(k) ? k : [k]).filter((x) => !downloads.has(x)).length;
  if (fresh <= DL_LIMIT - downloads.recent().length) return true;
  openPremium("downloads");
  return false;
}
/** A song downloaded (added to the library, or saved as a file). */
export const noteDownload = (k) => { if (!premiumNow()) downloads.note(k); };

// ---------------------------------------------------------------------------------------------------- the sheet
const WHY = {
  rebass: () => `You've rebassed ${LIMIT} songs in the last hour. The next one frees up in ${rebasses.next()} min.`,
  downloads: () => `You've downloaded ${DL_LIMIT} songs in the last hour. The next one frees up in ${downloads.next()} min.`,
  bp4: () => "4th-order boxes are a Premium feature.",
  bp6: () => "6th-order boxes are a Premium feature.",
  bandpass: () => "Bandpass builds are a Premium feature.",
};
/** FifTeam Premium: why it opened (a locked feature, or a limit reached), what it gives, and how to get it. */
export function openPremium(why = "") {
  openSheet((p) => {
    p.classList.add("pm-panel", "pm-premium");
    const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const ico = (id) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + id); s.append(u); return s; };
    const hero = h("div", "pm-hero");
    const badge = h("span", "pm-badge"); badge.append(ico("i-spark"), "Premium");
    hero.append(badge, h("h3", "", premiumNow() ? "You have Premium" : "Try FifTeam Premium"));
    if (premiumNow()) { hero.append(h("p", "pm-done", "Everything's unlocked on this account. Thank you for supporting FifTeam Media!")); p.append(hero, featureList(h, ico)); return; }
    hero.append(h("p", "pm-pitch", "Try our premium plan with a one-time payment for access to these dope features!"));
    if (WHY[why]) hero.append(h("p", "pm-why", WHY[why]()));
    p.append(hero, featureList(h, ico));
    const card = h("div", "pm-card");
    card.append(h("b", "pm-price", `$${PRICE}`), h("span", "pm-once", "one time, for good"), h("span", "pm-what", "No subscription. Every feature above, on every phone you sign in to."));
    p.append(card);
    const name = myName() || "your username";
    const steps = h("ol", "pm-steps");
    const s1 = h("li", "", `Tap Pay with PayPal and send $${PRICE}.`);
    const s2 = h("li", ""); s2.append("In the note, put your username: ");
    const nm = h("b", "pm-name", name); s2.append(nm);
    const cp = h("button", "btn small pm-copy", "Copy"); cp.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(name).then(() => toast("Copied", 1200), () => {}); };
    s2.append(" ", cp);
    const s3 = h("li", "", "It unlocks by itself once the payment's confirmed (usually within a day). You'll see a note here when it does.");
    steps.append(s1, s2, s3);
    const pay = h("a", "btn primary block pm-pay", `Get Premium: $${PRICE} with PayPal`);
    pay.href = PAY; pay.target = "_blank"; pay.rel = "noopener";
    pay.onclick = () => { ls.set(ASKED, String(Date.now())); hubPremiumAsk().catch(() => {}); setTimeout(() => { const w = document.querySelector("#sheet-panel .pm-wait"); if (w) w.hidden = false; }, 800); };
    const wait = h("p", "status pm-wait", "Thanks! We'll unlock it as soon as the payment's in.");
    wait.hidden = !ls.get(ASKED);
    p.append(pay, steps, wait);
  });
}
function featureList(h, ico) {
  const ul = h("ul", "pm-feats");
  for (const [i, t, w] of FEATURES) { const li = h("li", ""); const ic = h("span", "pm-fi"); ic.append(ico(i)); const tx = h("span", ""); tx.append(h("b", "", t), h("small", "", w)); li.append(ic, tx); ul.append(li); }
  return ul;
}
/** (older name) The sheet, as it opens when the rebassing limit is reached (full) or from Settings. */
export const openUnlock = (full = true) => openPremium(full ? "rebass" : "");
/** A Premium feature: true if it's unlocked, otherwise the sheet opens (saying why) and false. */
export function requirePremium(why) { if (premiumNow()) return true; openPremium(why); return false; }

export function initPremium() {
  addEventListener("fifteam-premium", () => toast("Premium unlocked. Thank you for supporting FifTeam Media!", 5000));
}
