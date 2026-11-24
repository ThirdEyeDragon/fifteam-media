// FifTeam Social's private messages. Every phone has its own key pair (ECDH P-256, made once and kept on the phone);
// its public half goes on its profile. Two phones work out the same secret key from each other's public half (ECDH),
// and every message between them is sealed with it (AES-GCM 256) before it leaves the phone. The feed service only
// ever holds sealed messages (which phone wrote to which, and when, but not a word of what): nobody else can read them,
// the app's owner included.
//   The messages live in one store message of their own (social/config.json "dm": a dm.json attached to it).
import { $, toast, openSheet, closeSheet } from "./ui.js";
import { api } from "./social.js";
import { dmState, dmRequests, answerDm } from "./meta.js";

const KEY = "fifteam-dm-key", READ = "fifteam-dm-read", MAX = 2000;
const D = { msgs: [], loadedAt: 0, loading: null, keys: new Map(), plain: new Map(), chat: null, poll: 0, queue: Promise.resolve() };
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const PHONE = /^[a-z0-9]{6,16}$/;

// ---------------------------------------------------------------------------------------------------- keys
let mine = null;
/** This phone's key pair (made the first time). */
async function myKeys() {
  if (mine) return mine;
  let jwk = null;
  try { jwk = JSON.parse(localStorage.getItem(KEY) || "null"); } catch {}
  if (jwk && jwk.d) {
    const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
    mine = { priv, pk: `${jwk.x}.${jwk.y}` };
  } else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
    const j = await crypto.subtle.exportKey("jwk", kp.privateKey);
    try { localStorage.setItem(KEY, JSON.stringify(j)); } catch {}
    mine = { priv: kp.privateKey, pk: `${j.x}.${j.y}` };
  }
  return mine;
}
/** The public half that goes on this phone's profile. */
export async function myPublicKey() { try { return (await myKeys()).pk; } catch { return ""; } }
/** The key this phone shares with another (from their profile's public half). */
async function sharedKey(phone) {
  const pr = api.state.profiles[phone];
  if (!pr || !pr.pk) return null;
  const k = phone + "|" + pr.pk;
  if (D.keys.has(k)) return D.keys.get(k);
  const [x, y] = pr.pk.split(".");
  const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: pub }, (await myKeys()).priv, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  D.keys.set(k, key);
  return key;
}
async function seal(phone, text) {
  const key = await sharedKey(phone);
  if (!key) throw new Error("nokey");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify({ t: text }))));
  return { iv: b64u(iv), c: b64u(c) };
}
/** A message's words ("" if this phone can't open it: not for it, or its key was lost). */
async function open(m) {
  if (D.plain.has(m.id)) return D.plain.get(m.id);
  let t = "";
  try {
    const other = m.f === api.state.me ? m.t : m.f, key = await sharedKey(other);
    if (key) t = String(JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(m.iv) }, key, unb64u(m.c)))).t || "").slice(0, 1000);
  } catch {}
  D.plain.set(m.id, t);
  return t;
}

// ---------------------------------------------------------------------------------------------------- the store
async function readStore() {
  const cfg = await api.config();
  if (!cfg.dm) throw new Error("setup");
  const m = await api.dc(`/messages/${cfg.dm}`);
  const a = (m.attachments || []).find((x) => x.filename === "dm.json");
  if (!a) return [];
  const d = await (await fetch(a.url, { cache: "no-store" })).json();
  return (Array.isArray(d.msgs) ? d.msgs : []).slice(-MAX).filter((x) => x && /^[a-z0-9]{8,24}$/.test(x.id) && PHONE.test(x.f) && PHONE.test(x.t) && typeof x.c === "string" && typeof x.iv === "string" && x.c.length < 4000)
    .map((x) => ({ id: x.id, f: x.f, t: x.t, at: +x.at || 0, iv: x.iv, c: x.c }));
}
async function writeStore(msgs) {
  const cfg = await api.config(), f = new FormData();
  f.append("payload_json", JSON.stringify({ content: "FifTeam messages (the app keeps this message up to date; please don't delete it)", attachments: [{ id: 0, filename: "dm.json" }], allowed_mentions: { parse: [] } }));
  f.append("files[0]", new Blob([JSON.stringify({ v: 1, msgs: msgs.slice(-MAX) })], { type: "application/json" }), "dm.json");
  await api.dc(`/messages/${cfg.dm}`, { method: "PATCH", form: f });
}
async function load() {
  if (D.loading) return D.loading;
  D.loading = (async () => {
    try {
      D.msgs = await readStore(); D.loadedAt = Date.now();
      // someone new wrote since the profiles were read: read them again, for their name and key
      const pr = api.state.profiles || {}, me = api.state.me;
      if (mineOnly().some((m) => { const o = m.f === me ? m.t : m.f; return !pr[o] || !pr[o].pk; })) await api.ensureProfiles(true).catch(() => {});
    } finally { D.loading = null; }
  })();
  return D.loading;
}
/** This phone's conversations: what it sent, and what came from phones it takes messages from (Settings: everyone, by
 * request, or nobody; someone it has written to, follows or let in always counts, unless messages are off). */
const mineOnly = () => { const me = api.state.me; return D.msgs.filter((m) => m.f === me || (m.t === me && dmState(m.f, me, wrote(m.f)) === "ok")); };
const wrote = (to) => D.msgs.some((m) => m.f === api.state.me && m.t === to);
/** Whether someone has written to this phone (which lets this phone write back, whatever their settings say). */
export const talkedWith = (phone) => D.msgs.some((m) => m.f === phone && m.t === api.state.me);
function lastRead() { try { return JSON.parse(localStorage.getItem(READ) || "{}"); } catch { return {}; } }
function markRead(phone) { const r = lastRead(); r[phone] = Date.now(); try { localStorage.setItem(READ, JSON.stringify(r)); } catch {} paintBadge(); }
function unread() {
  const r = lastRead(), from = new Set();
  for (const m of mineOnly()) if (m.t === api.state.me && m.at > (r[m.f] || 0)) from.add(m.f);
  return from.size;
}
function paintBadge() {
  const b = $("dm-badge"); if (!b) return;
  const n = unread() + dmRequests(api.state.me).length;
  b.textContent = n > 9 ? "9+" : String(n);
  b.hidden = !n;
}

// ---------------------------------------------------------------------------------------------------- the screens
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const nameOf = (phone) => (api.state.profiles[phone] && api.state.profiles[phone].name) || "Someone";

/** All the conversations. */
export async function openInbox() {
  D.chat = null;
  openSheet((p) => {
    p.classList.add("dm-panel");
    p.append(h("h3", "", "Messages"));
    const list = h("div", "dm-list"); p.append(list);
    list.append(h("p", "status", "Loading…"));
    paintInbox(list);
  });
  try { await Promise.all([api.ensureProfiles(), load()]); } catch (e) { const l = document.querySelector("#sheet-panel .dm-list"); if (l) { l.replaceChildren(h("p", "status", e.message === "setup" ? "Messages aren't available yet." : "Couldn't load your messages. Are you online?")); } return; }
  const l = document.querySelector("#sheet-panel .dm-list");
  if (l) paintInbox(l);
  paintBadge();
}
async function paintInbox(list) {
  if (!D.loadedAt) return;
  const by = new Map();
  for (const m of mineOnly()) { const other = m.f === api.state.me ? m.t : m.f; if (!by.has(other) || by.get(other).at < m.at) by.set(other, m); }
  const convs = [...by.entries()].sort((a, b) => b[1].at - a[1].at), r = lastRead();
  list.replaceChildren();
  // people asking to message this phone: yes or no
  const reqs = dmRequests(api.state.me);
  if (reqs.length) {
    list.append(h("p", "label dm-reqh", "Message requests"));
    for (const who of reqs) {
      const row = h("div", "dm-row dm-req");
      const av = api.avatarEl(46, "", nameOf(who)); api.showPicture(av, { by: who, user: nameOf(who), id: "" });
      const mid = h("span", "dm-mid"); mid.append(h("b", "", nameOf(who)), h("small", "", "wants to message you"));
      const yes = h("button", "btn small primary", "Accept"), no = h("button", "btn small", "Decline");
      const go = (ok) => async () => { yes.disabled = no.disabled = true; if (!(await answerDm(who, ok))) toast("Couldn't save that. Try again."); else toast(ok ? `${nameOf(who)} can message you now` : "Declined"); paintInbox(list); paintBadge(); };
      yes.onclick = go(true); no.onclick = go(false);
      row.append(av, mid, yes, no);
      list.append(row);
    }
    if (convs.length) list.append(h("p", "label dm-reqh", "Messages"));
  }
  if (!convs.length && !reqs.length) { list.append(h("p", "status", "No messages yet. Tap someone's picture in Social and choose Message.")); return; }
  for (const [other, last] of convs) {
    const row = h("button", "dm-row" + (last.t === api.state.me && last.at > (r[other] || 0) ? " unread" : ""));
    const av = api.avatarEl(46, "", nameOf(other)); api.showPicture(av, { by: other, user: nameOf(other), id: "" });
    const mid = h("span", "dm-mid"); const prev = h("small", "", "…");
    mid.append(h("b", "", nameOf(other)), prev);
    row.append(av, mid, h("span", "dm-time", api.ago(last.at)));
    row.onclick = () => openChat(other);
    list.append(row);
    open(last).then((t) => { prev.textContent = (last.f === api.state.me ? "You: " : "") + (t || "🔒 a message"); });
  }
}

/** A conversation with another phone. */
export async function openChat(other) {
  if (!other || !PHONE.test(other)) { toast("Can't message them yet: they need to open FifTeam Media once more."); return; }
  if (other === api.state.me) { toast("That's you"); return; }
  if (!api.state.name) { toast("Pick a username in Social first"); return; }
  // their choice: messages from everyone, by request, or nobody
  try { await api.ensureProfiles(); } catch {}
  const st = dmState(api.state.me, other, talkedWith(other));
  if (st !== "ok" && !wrote(other)) {
    toast(st === "off" ? `${nameOf(other)} isn't taking messages.` : st === "requested" ? `You've asked to message ${nameOf(other)}. They haven't said yes yet.` : `${nameOf(other)} takes messages by request: tap Ask to message on their page.`, 3500);
    return;
  }
  D.chat = other;
  openSheet((p) => {
    p.classList.add("dm-panel");
    const head = h("div", "dm-head");
    const back = h("button", "btn small", "‹"); back.setAttribute("aria-label", "All messages"); back.onclick = () => openInbox();
    const av = api.avatarEl(36, "", nameOf(other)); api.showPicture(av, { by: other, user: nameOf(other), id: "" });
    head.append(back, av, h("b", "", nameOf(other)));
    const lock = h("p", "status dm-lock", "🔒 Only the two of you can read these messages.");
    const msgs = h("div", "dm-msgs"); msgs.append(h("p", "status", "Loading…"));
    const f = h("form", "dm-form");
    const inp = h("input", "input"); inp.maxLength = 500; inp.placeholder = "Message"; inp.autocomplete = "off"; inp.setAttribute("aria-label", "Message");
    const go = h("button", "btn primary small", "Send"); go.type = "submit";
    f.append(inp, go);
    f.onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (v) { inp.value = ""; send(other, v); } };
    p.append(head, lock, msgs, f);
  });
  try { await Promise.all([api.ensureProfiles(), load()]); } catch {}
  paintChat();
  clearInterval(D.poll);
  D.poll = setInterval(async () => {
    if (D.chat !== other || !document.querySelector("#sheet.open .dm-msgs")) { clearInterval(D.poll); D.chat = null; return; }
    if (document.visibilityState !== "visible") return;
    const before = D.msgs.length; try { await load(); } catch {}
    if (D.msgs.length !== before) paintChat();
  }, 6000);
}
async function paintChat() {
  const other = D.chat, box = document.querySelector("#sheet-panel .dm-msgs");
  if (!other || !box) return;
  const list = mineOnly().filter((m) => m.f === other || m.t === other).sort((a, b) => a.at - b.at);
  const texts = await Promise.all(list.map(open));
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren();
  if (!api.state.profiles[other] || !api.state.profiles[other].pk) box.append(h("p", "status", `${nameOf(other)} needs to open FifTeam Media once more before you can message them.`));
  else if (!list.length) box.append(h("p", "status", "Say hi."));
  list.forEach((m, i) => {
    const b = h("div", "dm-bubble " + (m.f === api.state.me ? "me" : "them") + (m.sending ? " sending" : ""));
    b.append(h("span", "", texts[i] || "🔒 This message can't be opened on this phone."), h("small", "", api.ago(m.at)));
    box.append(b);
  });
  if (atBottom || list.length) box.scrollTop = box.scrollHeight;
  markRead(other);
}
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
async function send(other, text) {
  let sealed;
  try { await api.ensureProfiles(); sealed = await seal(other, text.slice(0, 500)); }
  catch { toast(`${nameOf(other)} needs to open FifTeam Media once more before you can message them.`); return; }
  if (dmState(api.state.me, other, talkedWith(other)) === "off") { toast(`${nameOf(other)} isn't taking messages any more.`); return; }
  const m = { id: newId(), f: api.state.me, t: other, at: Date.now(), ...sealed };
  D.plain.set(m.id, text.slice(0, 500));
  D.msgs = [...D.msgs, { ...m, sending: true }];
  paintChat();
  const put = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = await readStore();
      if (!now.some((x) => x.id === m.id)) { now.push(m); await writeStore(now); }
      const after = await readStore();
      if (after.some((x) => x.id === m.id)) { D.msgs = after; return; }
      if (attempt === 2) throw new Error("busy");
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 800));
    }
  };
  // one at a time from this phone; and looked at again a moment later, in case another phone's copy landed on top of it
  const run = D.queue.then(put);
  D.queue = run.catch(() => {});
  try { await run; } catch { D.msgs = D.msgs.filter((x) => x.id !== m.id); toast("Couldn't send that message. Try again."); paintChat(); return; }
  paintChat();
  for (const ms of [3000, 10000]) setTimeout(() => { D.queue = D.queue.then(async () => { if (!(await readStore()).some((x) => x.id === m.id)) { await put(); paintChat(); } }).catch(() => {}); }, ms);
}

// ---------------------------------------------------------------------------------------------------- notifications
// New messages to this phone, when switched on in Settings: a notification while the app is in the background, a
// banner while it's open (unless that conversation is the one open). With no server, the app has to be running to
// look for them: open, or in the background before the phone puts it to sleep.
const NOTIFY = "fifteam-dm-notify", TOLD = "fifteam-dm-told";
export const canNotify = () => "Notification" in window;
export const notifyOn = () => { try { return localStorage.getItem(NOTIFY) === "1" && canNotify() && Notification.permission === "granted"; } catch { return false; } };
export function setNotify(on) { try { localStorage.setItem(NOTIFY, on ? "1" : "0"); } catch {} }
export const notifyWanted = () => { try { return localStorage.getItem(NOTIFY) === "1"; } catch { return false; } };
async function tellNew() {
  const me = api.state.me, incoming = mineOnly().filter((m) => m.t === me && m.f !== me);
  let told = null; try { told = JSON.parse(localStorage.getItem(TOLD) || "null"); } catch {}
  const first = !Array.isArray(told);
  const known = new Set(first ? [] : told), fresh = first ? [] : incoming.filter((m) => !known.has(m.id));
  try { localStorage.setItem(TOLD, JSON.stringify(incoming.map((m) => m.id).slice(-300))); } catch {}
  if (!fresh.length || !notifyOn()) return;
  const r = lastRead();
  for (const m of fresh.slice(-4)) {
    if (m.at <= (r[m.f] || 0)) continue;
    const text = (await open(m)) || "New message", who = nameOf(m.f);
    if (document.visibilityState === "visible") { if (D.chat !== m.f) toast(`${who}: ${text}`.slice(0, 90), 3000); continue; }
    const opts = { body: text.slice(0, 160), tag: "fifteam-dm-" + m.f, renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { dm: m.f } };
    try { const reg = await navigator.serviceWorker.ready; await reg.showNotification(who, opts); }
    catch { try { const n = new Notification(who, opts); n.onclick = () => { window.focus(); openChat(m.f); n.close(); }; } catch {} }
  }
}

/** The unread count on the messages button, kept up to date while the app is open (and with notifications on, while
 * it's in the background too, as long as the phone lets it run). */
export function initDms() {
  const btn = $("btn-dms");
  if (btn) btn.onclick = () => openInbox();
  const tick = D.check = async () => {
    if ((document.visibilityState !== "visible" && !notifyOn()) || !api.state.me) return;
    try { await api.ensureProfiles(); await load(); paintBadge(); await tellNew(); } catch {}
  };
  setTimeout(tick, 2500);
  setInterval(tick, 45000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
  // a tap on a message notification: that conversation
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "open-dm" && PHONE.test(e.data.dm)) { location.hash = "#social"; openChat(e.data.dm); } });
  const want = new URLSearchParams(location.search).get("dm");
  if (want && PHONE.test(want)) {
    history.replaceState(null, "", location.pathname + "#social");
    setTimeout(async () => { try { await api.ensureProfiles(); } catch {} openChat(want); }, 1200);
  }
}
export const dms = { state: D, open, myPublicKey };
