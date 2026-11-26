// The way in: FifTeam Media only runs as the installed app (from the phone's home screen), signed in to an account, with
// a username. In a browser tab it shows nothing but how to install it; once installed and opened, the account screen
// (sign in, or create an account); then, if the account has no username yet, picking one. Nothing can be used until
// all three are done.
import { offensive, OFFENSIVE } from "./filter.js";

const NAME_KEY = "fifteam-social-name";
const NAME_OK = /^[\p{L}\p{N} _.\-]{2,24}$/u;
const SITE = "https://thirdeyedragon.github.io/fifteam-media/";
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

// (Android's own install prompt, kept for the Install button: it can come at any moment after the page loads)
let prompt = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); prompt = e; paintInstall(); });
addEventListener("appinstalled", () => { ls.set("fifteam-installed", "1"); paintInstall(true); });

/** Whether this is the installed app (opened from the home screen), not a browser tab. (The app's own tests, on this
 * computer, run in a tab: there the gate is off unless a test turns it on.) */
export function installed() {
  try {
    if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && ls.get("fifteam-test-gate") !== "1") return true;
    // (a phone only: on a computer it stays locked, installed or not)
    if (!ios && !android) return false;
    return ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"].some((m) => matchMedia(`(display-mode: ${m})`).matches) || navigator.standalone === true || document.referrer.startsWith("android-app://");
  } catch { return false; }
}
const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const android = /Android/.test(ua);
const iosOther = ios && /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);    // (on iPhone, only Safari adds apps to the Home Screen)

function shut(on) { for (const id of ["app", "sheet", "toast"]) { const e = document.getElementById(id); if (e) e.inert = on; } }
function screen(id) {
  let box = document.getElementById(id);
  if (!box) { box = h("div", "acct gate"); box.id = id; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); document.body.append(box); }
  shut(true);
  return box;
}
const mark = () => { const m = h("span", "acct-mark"); m.innerHTML = '<svg><use href="#i-logo"/></svg>'; return m; };

// ---------------------------------------------------------------------------------------------------- not installed
let justInstalled = false;
function paintInstall(done) {
  if (done) justInstalled = true;
  const box = document.getElementById("gate-install"); if (!box) return;
  const card = h("div", "acct-card gate-card");
  card.append(mark(), h("h2", "acct-title", "Get the FifTeam Media app"));
  if (justInstalled) {
    card.append(h("p", "acct-sub", "Installed. Open FifTeam Media from your home screen, then sign in or create your account."));
    box.replaceChildren(card); return;
  }
  card.append(h("p", "acct-sub", "FifTeam Media only works as the app on your phone. Install it, open it from your home screen, then sign in or create your account there."));
  if (ls.get("fifteam-installed")) card.append(h("p", "gate-note", "Already have it? Open FifTeam Media from your home screen."));
  const steps = h("ol", "gate-steps");
  const step = (...parts) => { const li = h("li", ""); li.append(...parts); steps.append(li); };
  if (ios && iosOther) {
    step("On iPhone, apps install from Safari: open this page in Safari.");
    const cp = h("button", "btn block", "Copy the link"); cp.type = "button";
    cp.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(SITE).then(() => { cp.textContent = "Copied: paste it in Safari"; }, () => {}); };
    card.append(steps, cp);
  } else if (ios) {
    const share = h("b", "", "Share"); step("Tap ", share, " at the bottom of Safari (the square with the arrow).");
    step("Scroll down and tap ", h("b", "", "Add to Home Screen"), ", then ", h("b", "", "Add"), ".");
    step("Open ", h("b", "", "FifTeam"), " from your home screen and sign in.");
    card.append(steps);
  } else if (android) {
    if (prompt) {
      const go = h("button", "btn primary block", "Install the app"); go.type = "button";
      go.onclick = async () => { try { prompt.prompt(); const r = await prompt.userChoice; prompt = null; if (r && r.outcome === "accepted") paintInstall(true); else paintInstall(); } catch { paintInstall(); } };
      card.append(go);
      step("Tap Install the app, then Install.");
    } else step("Tap the browser's menu (the three dots), then ", h("b", "", "Install app"), " (or ", h("b", "", "Add to Home screen"), ").");
    step("Open ", h("b", "", "FifTeam"), " from your home screen and sign in.");
    card.append(steps);
  } else {
    step("On your phone, open ", h("b", "selectable", SITE.replace("https://", "")), ".");
    step("Install it from there (iPhone: Safari's Share, then Add to Home Screen; Android: Install app).");
    step("Open it from your home screen and sign in or create your account.");
    card.append(steps);
  }
  card.append(h("p", "gate-foot", "Your account works on every phone you sign in on."));
  box.replaceChildren(card);
}
/** In a browser tab: only how to install it. True if the app can go on (it's the installed app). */
export function installGate() {
  if (installed()) return true;
  screen("gate-install");
  paintInstall();
  return false;
}

// ---------------------------------------------------------------------------------------------------- a username
/** Signed in: the account's username (from its profile, if it has one already, on another phone), or picking one now
 * (it can't be skipped). Names are taken once: nobody else can have the same one. */
export async function nameGate() {
  const { api, setName } = await import("./social.js");
  const me = () => api.state.me;
  if (api.state.name) return true;
  try { await api.ensureProfiles(true); } catch {}
  const mine = api.state.profiles && api.state.profiles[me()];
  if (mine && mine.name && NAME_OK.test(mine.name)) { setName(mine.name); return true; }
  return new Promise((done) => {
    const box = screen("gate-name");
    const card = h("form", "acct-card gate-card");
    card.append(mark(), h("h2", "acct-title", "Pick your username"), h("p", "acct-sub", "It's how people see you in FifTeam Media: on your posts, comments and messages. You can change it later."));
    const inp = h("input", "input"); inp.maxLength = 24; inp.placeholder = "Username"; inp.setAttribute("aria-label", "Username"); inp.autocomplete = "off"; inp.autocapitalize = "off"; inp.required = true;
    const err = h("p", "acct-err", ""), go = h("button", "btn primary block", "Continue"); go.type = "submit";
    card.append(inp, err, go);
    card.onsubmit = async (e) => {
      e.preventDefault();
      const v = inp.value.trim().replace(/\s+/g, " ");
      err.textContent = "";
      if (!NAME_OK.test(v)) { err.textContent = "2 to 24 letters, numbers, spaces, _ . or -"; return; }
      if (offensive(v)) { err.textContent = OFFENSIVE; return; }
      go.disabled = true; go.textContent = "One moment…";
      try { await api.ensureProfiles(true); } catch {}
      const low = v.toLowerCase(), taken = Object.entries(api.state.profiles || {}).some(([ph, p]) => ph !== me() && p && String(p.name || "").toLowerCase() === low);
      if (taken) { err.textContent = `"${v}" is taken. Try another.`; go.disabled = false; go.textContent = "Continue"; return; }
      await setName(v);
      box.remove(); shut(false);
      done(true);
    };
    box.replaceChildren(card);
    setTimeout(() => inp.focus(), 60);
  });
}
/** The username kept on this phone ("" if none yet). */
export const savedName = () => ls.get(NAME_KEY) || "";
