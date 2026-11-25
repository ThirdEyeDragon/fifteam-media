// FifTeam accounts. The app can't be used until it's signed in, with an email and a password (once: it stays signed
// in). A new account confirms its email with a link sent to it. The accounts themselves are Google's free sign-in
// service (Firebase Authentication: it keeps the passwords and sends the emails), so nothing of ours has to be running.
//   A phone signed in to an account takes the account's id (kept on the account), so its profile, posts and likes
// are the same on every phone it's signed in on. An account banned by the FifTeam team (by its email: ban.js) is shut
// on all of them and can't sign in.
import { emailBanned } from "./ban.js";

const KEY = "fifteam-account", ME = "fifteam-social-me";
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;
const PHONE = /^[a-z0-9]{6,16}$/;
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let session = null;
try { session = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
const valid = (s) => !!(s && typeof s.email === "string" && PHONE.test(s.uid || "") && typeof s.token === "string" && s.token.length >= 8);
export const account = () => (valid(session) ? session : null);

// (kept in the app's cache as well, so it survives the browser clearing just one of them)
async function keep(s) {
  session = s;
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch {}
  try { const c = await caches.open("fifteam-flags"); if (s) await c.put("account", new Response(JSON.stringify(s))); else await c.delete("account"); } catch {}
}
async function restore() {
  if (valid(session)) return;
  try { const r = await (await caches.open("fifteam-flags")).match("account"); const s = r && (await r.json()); if (valid(s)) { session = s; try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} } } catch {}
}

// ---------------------------------------------------------------------------------------------------- the sign-in service
let keyP = null;
function apiKey() {
  keyP = keyP || fetch(new URL("../social/config.json", import.meta.url), { cache: "no-cache" }).then((r) => r.json()).then((c) => (c.firebase && c.firebase.apiKey) || "");
  keyP.catch(() => { keyP = null; });
  return keyP;
}
const SAY = {
  EMAIL_EXISTS: "There's already an account with this email. Sign in instead.", EMAIL_NOT_FOUND: "That email and password don't match.",
  INVALID_PASSWORD: "That email and password don't match.", INVALID_LOGIN_CREDENTIALS: "That email and password don't match.",
  USER_DISABLED: "This account has been banned from FifTeam Media.", TOO_MANY_ATTEMPTS_TRY_LATER: "Too many tries. Wait a few minutes, then try again.",
  INVALID_EMAIL: "That doesn't look like an email address.", WEAK_PASSWORD: "Use at least 8 characters for the password.",
  TOKEN_EXPIRED: "Please sign in again.", INVALID_REFRESH_TOKEN: "Please sign in again.", USER_NOT_FOUND: "Please sign in again.",
};
async function fb(path, body, host = "identitytoolkit.googleapis.com/v1/accounts:") {
  const key = await apiKey();
  if (!key) throw new Error("Signing in isn't available yet. Try again later.");
  let r;
  const form = host.startsWith("securetoken");                       // (the token service takes a form, the rest JSON)
  try { r = await fetch(`https://${host}${path}?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) }); }
  catch { throw new Error("You're offline. Connect to the internet to sign in."); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const code = String((d.error && d.error.message) || "").split(" ")[0].replace(/:$/, ""); const e = new Error(SAY[code] || "That didn't work. Try again."); e.code = code; throw e; }
  return d;
}
const lookup = async (idToken) => ((await fb("lookup", { idToken })).users || [])[0] || {};
/** Fresh proof of the account (also how a ban or a deleted account is noticed). */
async function refresh(token) {
  const d = await fb("token", { grant_type: "refresh_token", refresh_token: token }, "securetoken.googleapis.com/v1/");
  return { idToken: d.id_token, token: d.refresh_token };
}
const myPhone = () => { try { return localStorage.getItem(ME) || ""; } catch { return ""; } };

/** Signed in and confirmed: the account's own id (its first phone's, kept on the account as "ft:<id>"). */
async function finish(email, idToken, token) {
  const u = await lookup(idToken);
  if (!u.emailVerified) return { verify: true, idToken, token };
  if (await emailBanned(email)) throw new Error("This account has been banned from FifTeam Media.");
  let uid = /^ft:([a-z0-9]{6,16})$/.exec(u.displayName || "");
  uid = uid ? uid[1] : "";
  if (!uid) { uid = PHONE.test(myPhone()) ? myPhone() : Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""); await fb("update", { idToken, displayName: "ft:" + uid, returnSecureToken: false }); }
  listAccount(u.localId, email, { ok: 1, u: uid, c: +u.createdAt || 0 });
  await signedIn({ email, uid, token, fid: u.localId, at: Date.now() });
  return { done: true };
}

// ---------------------------------------------------------------------------------------------------- the account list
// Every account, for the owner's /accounts in the FifTeam server (which runs online, with nothing on a PC): one store
// message (social/config.json "accounts") with each account's email sealed for the FifTeam bot alone (nobody else who
// reads it can see an address), whether it's confirmed, its phone id, and when it joined and was last signed in.
const FID = /^[A-Za-z0-9]{10,64}$/;
function cleanAccounts(d) {
  const out = { v: 1, a: {} };
  for (const [k, v] of Object.entries((d && d.a) || {}).slice(0, 20000)) if (FID.test(k) && v && typeof v.e === "string" && v.e.length < 400)
    out.a[k] = { e: v.e, c: +v.c || 0, ok: v.ok ? 1 : 0, u: PHONE.test(v.u || "") ? v.u : "", at: +v.at || 0 };
  return out;
}
let acctStore = null;
async function listAccount(fid, email, fields) {
  if (!FID.test(fid || "") || !email) return;
  try {
    const e = await sealedEmail(email);
    if (!e) return;
    if (!acctStore) { const { jsonStore } = await import("./meta.js"); acctStore = jsonStore("accounts", "accounts.json", "FifTeam accounts", cleanAccounts, true); }
    await acctStore.change((d) => { const was = d.a[fid] || {}; d.a[fid] = { e, c: fields.c || was.c || Date.now(), ok: fields.ok ? 1 : was.ok || 0, u: fields.u || was.u || "", at: Date.now() }; }, (d) => !!d.a[fid]);
  } catch {}
}

// ---------------------------------------------------------------------------------------------------- the sign-in screen
function shut(on) { for (const id of ["app", "sheet", "toast"]) { const e = document.getElementById(id); if (e) e.inert = on; } }
const pending = {};   // (between creating an account and confirming it: the email, and proof of the new account)
function show(mode = "signin", email = "", note = "") {
  let box = document.getElementById("acct");
  if (!box) { box = h("div", "acct"); box.id = "acct"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); document.body.append(box); }
  shut(true);
  const card = h("form", "acct-card");
  const logo = h("span", "acct-mark"); logo.innerHTML = '<svg><use href="#i-logo"/></svg>';
  const title = { signin: "Sign in", signup: "Create your account", verify: "Check your email", forgot: "New password", sent: "Check your email" }[mode];
  card.append(logo, h("h2", "acct-title", title));
  card.append(h("p", "acct-sub", {
    signin: "Sign in to use FifTeam Media.", signup: "Use your email and a password. We'll email you a link to check it's yours.",
    verify: `We sent a link to ${email}. Open the email, tap the link, then come back here and tap Continue. (It may be in your spam folder.)`,
    forgot: "Enter your account's email and we'll send a link to set a new password.", sent: `If ${email} has an account, a link to set a new password is on its way. Then sign in with it.`,
  }[mode]));
  const field = (type, label, auto, value = "") => { const i = h("input", "input"); i.type = type; i.placeholder = label; i.setAttribute("aria-label", label); i.autocomplete = auto; i.value = value; i.required = true; card.append(i); return i; };
  const em = mode === "signin" || mode === "signup" || mode === "forgot" ? field("email", "Email", "email", email) : null;
  const pw = mode === "signin" ? field("password", "Password", "current-password") : mode === "signup" ? field("password", "Password (8 or more characters)", "new-password") : null;
  const pw2 = mode === "signup" ? field("password", "Password again", "new-password") : null;
  const err = h("p", "acct-err", note), go = h("button", "btn primary block", { signin: "Sign in", signup: "Create account", verify: "Continue", forgot: "Send link", sent: "Back to sign in" }[mode]);
  go.type = "submit";
  card.append(err, go);
  const link = (text, fn) => { const b = h("button", "acct-link", text); b.type = "button"; b.onclick = fn; card.append(b); };
  if (mode === "signin") { link("Forgot your password?", () => show("forgot", em.value.trim())); link("New here? Create an account", () => show("signup", em.value.trim())); }
  if (mode === "signup") link("Already have an account? Sign in", () => show("signin", em.value.trim()));
  if (mode === "verify") {
    link("Send the link again", async () => { err.textContent = ""; try { await fb("sendOobCode", { requestType: "VERIFY_EMAIL", idToken: pending.idToken }); err.textContent = "Sent again."; } catch (e) { err.textContent = e.message; } });
    link("Use a different email", () => show("signup", ""));
  }
  if (mode === "forgot") link("Back to sign in", () => show("signin", em.value.trim()));
  card.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    if (mode === "sent") { show("signin", email); return; }
    const mail = em ? em.value.trim().toLowerCase() : email;
    if (em && !EMAIL.test(mail)) { err.textContent = "That doesn't look like an email address."; return; }
    if (mode === "signup" && pw.value.length < 8) { err.textContent = "Use at least 8 characters for the password."; return; }
    if (mode === "signup" && pw.value !== pw2.value) { err.textContent = "The two passwords aren't the same."; return; }
    go.disabled = true; const was = go.textContent; go.textContent = "One moment…";
    try {
      if (mode === "forgot") { await fb("sendOobCode", { requestType: "PASSWORD_RESET", email: mail }).catch((x) => { if (x.code !== "EMAIL_NOT_FOUND") throw x; }); show("sent", mail); return; }
      let d;
      if (mode === "signup") {
        if (await emailBanned(mail)) throw new Error("This email has been banned from FifTeam Media.");
        d = await fb("signUp", { email: mail, password: pw.value, returnSecureToken: true });
        await fb("sendOobCode", { requestType: "VERIFY_EMAIL", idToken: d.idToken });
        listAccount(d.localId, mail, { ok: 0, c: Date.now() });
        Object.assign(pending, { email: mail, idToken: d.idToken, token: d.refreshToken });
        show("verify", mail); return;
      }
      if (mode === "signin") {
        d = await fb("signInWithPassword", { email: mail, password: pw.value, returnSecureToken: true });
        const r = await finish(mail, d.idToken, d.refreshToken);
        if (r.verify) { Object.assign(pending, { email: mail, idToken: d.idToken, token: d.refreshToken }); await fb("sendOobCode", { requestType: "VERIFY_EMAIL", idToken: d.idToken }).catch(() => {}); show("verify", mail); }
        return;
      }
      if (mode === "verify") {
        const t = await refresh(pending.token);                          // (fresh proof: it says whether the link was tapped)
        Object.assign(pending, { idToken: t.idToken, token: t.token });
        const r = await finish(pending.email, t.idToken, t.token);
        if (r.verify) { err.textContent = "Not confirmed yet. Tap the link in the email first (check spam too)."; go.disabled = false; go.textContent = was; }
        return;
      }
    } catch (x) { err.textContent = x.message || "That didn't work. Try again."; }
    go.disabled = false; go.textContent = was;
  };
  box.replaceChildren(card);
  setTimeout(() => { const f = card.querySelector("input"); if (f && !f.value) f.focus(); }, 60);
}
/** Signed in: this phone takes the account's id (the same profile, posts and likes as on its other phones). */
async function signedIn(s) {
  await keep(s);
  const was = myPhone();
  try { localStorage.setItem(ME, s.uid); } catch {}
  if (was !== s.uid) { location.reload(); return; }                 // (another phone's account: the app starts again as it)
  const box = document.getElementById("acct"); if (box) box.remove();
  shut(false);
  dispatchEvent(new Event("fifteam-signed-in"));
}

/** Before anything else: signed in, or the sign-in screen (it can't be closed until then). Once a day, the account is
 * checked (a banned or deleted account signs this phone out). */
export async function initAccount() {
  await restore();
  if (!valid(session)) { show("signin"); return false; }
  if (myPhone() !== session.uid) { try { localStorage.setItem(ME, session.uid); } catch {} }
  if (Date.now() - (session.checked || 0) > 86400e3 && navigator.onLine !== false) {
    refresh(session.token).then((t) => { keep({ ...session, token: t.token, checked: Date.now() }); listAccount(session.fid, session.email, { ok: 1, u: session.uid }); }, (e) => { if (["USER_DISABLED", "USER_NOT_FOUND", "INVALID_REFRESH_TOKEN"].includes(e.code)) signOut(); });
  }
  return true;
}
/** This account's email, sealed for the FifTeam bot alone (social/config.json "auth"): its /accounts and bans by email
 * can tell whose phone is whose, and nobody else who reads the check-ins can see an address. */
export async function sealedEmail(email) {
  const s = email ? { email } : account(); if (!s) return "";
  try {
    const c = await (await fetch(new URL("../social/config.json", import.meta.url), { cache: "force-cache" })).json();
    if (!c.auth) return "";
    const [x, y] = c.auth.split(".");
    const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "ECDH", public: pub }, eph.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const jwk = await crypto.subtle.exportKey("jwk", eph.publicKey), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(s.email)));
    const b = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return JSON.stringify({ k: `${jwk.x}.${jwk.y}`, iv: b(iv), c: b(ct) });
  } catch { return ""; }
}
/** Fresh proof of this phone's account, for the FifTeam server (a Firebase ID token, good for an hour): "" if not
 * signed in. */
let idt = null;
export async function idToken() {
  const s = account();
  if (!s) return "";
  if (idt && idt.for === s.token && idt.until > Date.now()) return idt.t;
  const t = await refresh(s.token);
  if (t.token && t.token !== s.token) await keep({ ...session, token: t.token });
  idt = { t: t.idToken, for: t.token || s.token, until: Date.now() + 50 * 60e3 };
  return t.idToken;
}
/** Sign out (Settings): this phone forgets the account (and stops its notifications), and the sign-in screen comes back. */
export async function signOut() {
  try { const { pushOff } = await import("./push.js"); await pushOff(); } catch {}
  await keep(null);
  location.reload();
}
