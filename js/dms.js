// FifTeam Social's private messages. Every phone has its own key pair (ECDH P-256, made once and kept on the phone);
// its public half goes on its profile. Two phones work out the same secret key from each other's public half (ECDH),
// and every message between them is sealed with it (AES-GCM 256) before it leaves the phone. The feed service only
// ever holds sealed messages (which phone wrote to which, and when, but not a word of what): nobody else can read them,
// the app's owner included.
//   The messages live in one store message of their own (social/config.json "dm": a dm.json attached to it).
//   A message can carry a post (its id: the other phone shows it, if they can see it) or a rebassed song: the song (and
// its cover) goes up sealed with the same key, in a message of its own, so the file service can't hear it either.
//   Held down, a message (or a whole conversation) can be deleted for both phones: it's taken out of the store, and its
// id stays on a short list there (so a phone writing back an older copy can't bring it back).
import { $, toast, openSheet, closeSheet, fmtTime, placeholderArt, bus } from "./ui.js";
import { api } from "./social.js";
import { dmState, dmRequests, answerDm, blocked, followingOf } from "./meta.js";
import { bannedPhones } from "./ban.js";
import { library } from "./library.js";
import * as store from "./store.js";
import { player } from "./player.js";
import { squareJpeg } from "./image.js";
import { offensive, OFFENSIVE } from "./filter.js";
import { marketItem, openListing, loadMarket } from "./market.js";

const KEY = "fifteam-dm-key", READ = "fifteam-dm-read", MAX = 2000;
const D = { msgs: [], del: [], gone: new Set(), loadedAt: 0, loading: null, keys: new Map(), plain: new Map(), files: new Map(), chat: null, poll: 0, queue: Promise.resolve(), audio: null, playing: "" };
const POST = /^\d{5,25}$/, MSG = /^[a-z0-9]{8,24}$/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function seal(phone, body) {
  const key = await sharedKey(phone);
  if (!key) throw new Error("nokey");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(body))));
  return { iv: b64u(iv), c: b64u(c) };
}
const cleanSong = (s) => (s && typeof s === "object" && POST.test(s.m || "") && typeof s.iv === "string" && s.iv.length < 40
  ? { m: s.m, iv: s.iv, ...(typeof s.civ === "string" && s.civ.length < 40 ? { civ: s.civ } : {}), title: String(s.title || "Rebass").slice(0, 120), artist: String(s.artist || "").slice(0, 80), note: String(s.note || "").slice(0, 80), duration: +s.duration || 0 } : null);
/** What a message holds: { t: its words, p: a post's id, s: a sealed song } (t "" and nothing else if this phone
 * can't open it: not for it, or its key was lost). */
async function body(m) {
  if (D.plain.has(m.id)) return D.plain.get(m.id);
  let b = { t: "" };
  try {
    const other = m.f === api.state.me ? m.t : m.f, key = await sharedKey(other);
    if (key) {
      const j = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(m.iv) }, key, unb64u(m.c))));
      const s = cleanSong(j.s);
      b = { t: String(j.t || "").slice(0, 1000), ...(POST.test(j.p || "") ? { p: j.p } : {}), ...(s ? { s } : {}) };
    }
  } catch {}
  D.plain.set(m.id, b);
  return b;
}
const preview = (b) => b.t || (b.p ? "Sent a post" : b.s ? `♪ ${b.s.title}` : "");
/** A message in a line of words (for the list of conversations, and notifications). */
async function open(m) { return preview(await body(m)); }

// ---------------------------------------------------------------------------------------------------- the store
async function readStore() {
  const cfg = await api.config();
  if (!cfg.dm) throw new Error("setup");
  const m = await api.dc(`/messages/${cfg.dm}`);
  const a = (m.attachments || []).find((x) => x.filename === "dm.json");
  if (!a) return [];
  const d = await (await fetch(a.url, { cache: "no-store" })).json();
  const del = Array.isArray(d.del) ? d.del.filter((x) => typeof x === "string" && MSG.test(x)).slice(-4000) : [], gone = new Set(del);
  const out = (Array.isArray(d.msgs) ? d.msgs : []).slice(-MAX).filter((x) => x && MSG.test(x.id) && !gone.has(x.id) && PHONE.test(x.f) && PHONE.test(x.t) && typeof x.c === "string" && typeof x.iv === "string" && x.c.length < 4000)
    .map((x) => ({ id: x.id, f: x.f, t: x.t, at: +x.at || 0, iv: x.iv, c: x.c, ...(/^\d{5,25}$/.test(x.l || "") ? { l: x.l } : {}) }));
  out.del = del;
  return out;
}
async function writeStore(msgs) {
  const cfg = await api.config(), f = new FormData();
  f.append("payload_json", JSON.stringify({ content: "FifTeam messages (the app keeps this message up to date; please don't delete it)", attachments: [{ id: 0, filename: "dm.json" }], allowed_mentions: { parse: [] } }));
  f.append("files[0]", new Blob([JSON.stringify({ v: 1, msgs: msgs.slice(-MAX), del: (msgs.del || D.del || []).slice(-4000) })], { type: "application/json" }), "dm.json");
  await api.dc(`/messages/${cfg.dm}`, { method: "PATCH", form: f });
}
async function load() {
  if (D.loading) return D.loading;
  D.loading = (async () => {
    try {
      D.msgs = await readStore(); D.del = D.msgs.del; D.loadedAt = Date.now();
      // someone new wrote since the profiles were read: read them again, for their name and key
      const pr = api.state.profiles || {}, me = api.state.me;
      if (mineOnly().some((m) => { const o = m.f === me ? m.t : m.f; return !pr[o] || !pr[o].pk; })) await api.ensureProfiles(true).catch(() => {});
    } finally { D.loading = null; }
  })();
  return D.loading;
}
/** This phone's conversations: what it sent, and what came from phones it takes messages from (Settings: everyone, by
 * request, or nobody; someone it has written to, follows or let in always counts, unless messages are off). */
// (an Audio Market chat: anyone may ask a seller about what they're selling, unless one has blocked the other)
const mineOnly = () => { const me = api.state.me; return D.msgs.filter((m) => !D.gone.has(m.id) && (m.f === me || (m.t === me && (m.l ? !blocked(m.f, me) : dmState(m.f, me, wrote(m.f)) === "ok")))); };
/** A conversation: the other phone, and (an Audio Market chat) the listing it's about. */
const thread = (m) => (m.f === api.state.me ? m.t : m.f) + "|" + (m.l || "");
const wrote = (to) => D.msgs.some((m) => m.f === api.state.me && m.t === to);
/** Whether someone has written to this phone (which lets this phone write back, whatever their settings say). */
export const talkedWith = (phone) => D.msgs.some((m) => m.f === phone && m.t === api.state.me);
function lastRead() { try { return JSON.parse(localStorage.getItem(READ) || "{}"); } catch { return {}; } }
// (read up to when, per conversation: a phone's own chat under its id, an Audio Market chat under "phone|listing")
const readKey = (phone, l) => (l ? `${phone}|${l}` : phone);
function markRead(phone, l) { const r = lastRead(); r[readKey(phone, l)] = Date.now(); try { localStorage.setItem(READ, JSON.stringify(r)); } catch {} paintBadge(); }
function unread() {
  const r = lastRead(), from = new Set();
  for (const m of mineOnly()) if (m.t === api.state.me && m.at > (r[readKey(m.f, m.l)] || 0)) from.add(thread(m));
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
    const seg = h("div", "seg dm-seg");
    for (const [k, label] of [["all", "All"], ["chats", "Chats"], ["market", "Audio Market"]]) { const b = h("button", (D.box || "all") === k ? "on" : "", label); b.dataset.k = k; seg.append(b); }
    seg.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; D.box = b.dataset.k; seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); paintInbox(list); };
    p.append(seg);
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
  const by = new Map(), box = D.box || "all";
  for (const m of mineOnly()) { if ((box === "chats" && m.l) || (box === "market" && !m.l)) continue; const k = thread(m); if (!by.has(k) || by.get(k).at < m.at) by.set(k, m); }
  const convs = [...by.entries()].sort((a, b) => b[1].at - a[1].at), r = lastRead();
  if ([...by.values()].some((m) => m.l)) loadMarket(60000).catch(() => {});
  list.replaceChildren();
  // people asking to message this phone: yes or no
  const reqs = box === "market" ? [] : dmRequests(api.state.me);
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
  if (!convs.length && !reqs.length) { list.append(h("p", "status", box === "market" ? "No Audio Market chats yet. Tap Message seller on a listing." : "No messages yet. Tap someone's picture in Social and choose Message.")); return; }
  for (const [, last] of convs) {
    const other = last.f === api.state.me ? last.t : last.f, l = last.l || "";
    const row = h("button", "dm-row" + (l ? " dm-mk" : "") + (last.t === api.state.me && last.at > (r[readKey(other, l)] || 0) ? " unread" : ""));
    const av = api.avatarEl(46, "", nameOf(other)); api.showPicture(av, { by: other, user: nameOf(other), id: "" });
    const mid = h("span", "dm-mid"); const prev = h("small", "", "…");
    mid.append(h("b", "", nameOf(other)));
    if (l) { const it = marketItem(l); mid.append(h("span", "dm-mktag", `Audio Market · ${it ? it.title : "a listing"}`)); }
    mid.append(prev);
    row.append(av, mid, h("span", "dm-time", api.ago(last.at)));
    row.onclick = () => { if (!wasHeld(row)) openChat(other, l); };
    onHold(row, () => actions(`${nameOf(other)}${l ? " · Audio Market" : ""}`, [["Delete chat for both of you", async () => {
      if (!confirm(`Delete this whole chat with ${nameOf(other)}? It's deleted on their phone too.`)) return;
      const all = mineOnly().filter((m) => thread(m) === thread(last));
      if (await removeMsgs(all)) toast("Chat deleted");
      paintInbox(list); paintBadge();
    }, "danger"]]));
    list.append(row);
    open(last).then((t) => { prev.textContent = (last.f === api.state.me ? "You: " : "") + (t || "🔒 a message"); });
  }
}

/** A conversation with another phone. */
export async function openChat(other, l = "") {
  if (!other || !PHONE.test(other)) { toast("Can't message them yet: they need to open FifTeam Media once more."); return; }
  if (other === api.state.me) { toast("That's you"); return; }
  if (!api.state.name) { toast("Pick a username in Social first"); return; }
  // their choice: messages from everyone, by request, or nobody
  try { await api.ensureProfiles(); } catch {}
  const st = l ? (blocked(api.state.me, other) ? "off" : "ok") : dmState(api.state.me, other, talkedWith(other));
  if (st !== "ok" && (l || !wrote(other))) {
    toast(st === "off" ? `${nameOf(other)} isn't taking messages.` : st === "requested" ? `You've asked to message ${nameOf(other)}. They haven't said yes yet.` : `${nameOf(other)} takes messages by request: tap Ask to message on their page.`, 3500);
    return;
  }
  D.chat = other; D.l = l;
  openSheet((p) => {
    p.classList.add("dm-panel");
    const head = h("div", "dm-head");
    const back = h("button", "btn small", "‹"); back.setAttribute("aria-label", "All messages"); back.onclick = () => openInbox();
    const av = api.avatarEl(36, "", nameOf(other)); api.showPicture(av, { by: other, user: nameOf(other), id: "" });
    head.append(back, av, h("b", "", nameOf(other)));
    // an Audio Market chat: the listing it's about, on top (tap it to see it)
    if (l) {
      const it = marketItem(l), card = h("button", "dm-listing");
      const ph = h("span", "dm-lph");
      if (it) api.message(l).then((m) => { const f = api.fileOf(m, "photo0.jpg"); if (f) ph.style.backgroundImage = `url("${f.url}")`; }).catch(() => {});
      const t = h("span", "dm-mid"); t.append(h("small", "dm-mktag", "Audio Market"), h("b", "", it ? it.title : "A listing"), h("small", "", it ? (it.price ? "$" + it.price.toLocaleString("en-US") : "Free") + (it.sold ? " · Sold" : "") : ""));
      card.append(ph, t); card.onclick = () => openListing(l);
      p.append(head, card);
    }
    const msgs = h("div", "dm-msgs"); msgs.append(h("p", "status", "Loading…"));
    const f = h("form", "dm-form");
    const inp = h("input", "input"); inp.maxLength = 500; inp.placeholder = "Message"; inp.autocomplete = "off"; inp.setAttribute("aria-label", "Message");
    const go = h("button", "btn primary small", "Send"); go.type = "submit";
    f.append(inp, go);
    f.onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; if (offensive(v)) { toast(OFFENSIVE, 3500); return; } inp.value = ""; send(other, v, l); };
    if (l) p.append(msgs, f); else p.append(head, msgs, f);
  });
  try { await Promise.all([api.ensureProfiles(), load()]); } catch {}
  paintChat();
  clearInterval(D.poll);
  D.poll = setInterval(async () => {
    if (D.chat !== other || D.l !== l || !document.querySelector("#sheet.open .dm-msgs")) { clearInterval(D.poll); D.chat = null; stopSongs(); return; }
    if (document.visibilityState !== "visible") return;
    const before = D.msgs.map((m) => m.id).join(); try { await load(); } catch {}
    if (D.msgs.map((m) => m.id).join() !== before) paintChat();
  }, 6000);
}
async function paintChat() {
  const other = D.chat, box = document.querySelector("#sheet-panel .dm-msgs");
  if (!other || !box) return;
  const l = D.l || "";
  const list = mineOnly().filter((m) => (m.f === other || m.t === other) && (m.l || "") === l).sort((a, b) => a.at - b.at);
  const texts = await Promise.all(list.map(body));
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren();
  if (!api.state.profiles[other] || !api.state.profiles[other].pk) box.append(h("p", "status", `${nameOf(other)} needs to open FifTeam Media once more before you can message them.`));
  else if (!list.length) box.append(h("p", "status", l ? "Ask about it: is it still available, the price, picking it up…" : "Say hi."));
  list.forEach((m, i) => {
    const x = texts[i], b = h("div", "dm-bubble " + (m.f === api.state.me ? "me" : "them") + (m.sending ? " sending" : "") + (x.p || x.s ? " dm-rich" : ""));
    if (x.p) b.append(postBubble(x.p));
    if (x.s) b.append(songBubble(m, x.s));
    if (x.t || (!x.p && !x.s)) b.append(h("span", "", x.t || "🔒 This message can't be opened on this phone."));
    b.append(h("small", "", api.ago(m.at)));
    if (!m.sending) onHold(b, () => actions("", [
      ...(x.t ? [["Copy", () => { navigator.clipboard && navigator.clipboard.writeText(x.t).then(() => toast("Copied", 1200), () => {}); }]] : []),
      ["Delete for both of you", async () => { if (await removeMsgs([m])) toast("Deleted for both of you", 1600); paintChat(); }, "danger"],
    ]));
    box.append(b);
  });
  if (atBottom || list.length) box.scrollTop = box.scrollHeight;
  markRead(other, l);
}
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
async function send(other, text, l = "", extra = null) {
  let sealed;
  const b = { t: String(text || "").slice(0, 500), ...(extra || {}) };
  try { await api.ensureProfiles(); sealed = await seal(other, b); }
  catch { toast(`${nameOf(other)} needs to open FifTeam Media once more before you can message them.`); return false; }
  if (l ? blocked(api.state.me, other) : dmState(api.state.me, other, talkedWith(other)) === "off") { toast(`${nameOf(other)} isn't taking messages any more.`); return false; }
  const m = { id: newId(), f: api.state.me, t: other, at: Date.now(), ...sealed, ...(l ? { l } : {}) };
  D.plain.set(m.id, b);
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
  try { await run; } catch { D.msgs = D.msgs.filter((x) => x.id !== m.id); toast("Couldn't send that message. Try again."); paintChat(); return false; }
  paintChat();
  for (const ms of [3000, 10000]) setTimeout(() => { D.queue = D.queue.then(async () => { const now = await readStore(); if (!now.some((x) => x.id === m.id) && !now.del.includes(m.id) && !D.gone.has(m.id)) { await put(); paintChat(); } }).catch(() => {}); }, ms);
  return true;
}

// ---------------------------------------------------------------------------------------------------- deleting
/** Messages deleted for both phones: out of the store (their sealed songs too), and their ids on its list of deleted
 * ones. Gone from this screen at once; back (with a note) if it couldn't be saved. */
async function removeMsgs(list) {
  list = list.filter((m) => m && MSG.test(m.id));
  if (!list.length) return false;
  const ids = new Set(list.map((m) => m.id)), files = [];
  for (const m of list) { const b = D.plain.get(m.id); if (b && b.s) files.push(b.s.m); D.gone.add(m.id); }
  const put = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = await readStore();
      const keep = now.filter((x) => !ids.has(x.id));
      keep.del = [...new Set([...now.del, ...ids])].slice(-4000);
      if (keep.length !== now.length || keep.del.length !== now.del.length) await writeStore(keep);
      const after = await readStore();
      if (!after.some((x) => ids.has(x.id))) { D.msgs = after; D.del = after.del; return; }
      if (attempt === 2) throw new Error("busy");
      await wait(400 + Math.random() * 800);
    }
  };
  const run = D.queue.then(put);
  D.queue = run.catch(() => {});
  try { await run; } catch { for (const id of ids) D.gone.delete(id); toast("Couldn't delete that. Try again."); return false; }
  for (const id of files) api.dc(`/messages/${id}`, { method: "DELETE", low: true }).catch(() => {});
  // (looked at again, in case another phone's older copy landed on top)
  for (const ms of [3000, 10000]) setTimeout(() => { D.queue = D.queue.then(async () => { if ((await readStore()).some((x) => ids.has(x.id))) await put(); }).catch(() => {}); }, ms);
  return true;
}
/** Held down (half a second, without moving): fn. A right-click does it too. */
function onHold(el, fn) {
  let t = 0, x0 = 0, y0 = 0;
  const stop = () => { clearTimeout(t); t = 0; el.classList.remove("holding"); };
  el.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    x0 = e.clientX; y0 = e.clientY; el.classList.add("holding");
    t = setTimeout(() => { t = 0; el.classList.remove("holding"); el._held = Date.now(); try { navigator.vibrate && navigator.vibrate(12); } catch {} fn(); }, 480);
  });
  el.addEventListener("pointermove", (e) => { if (t && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) stop(); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, stop);
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!wasHeld(el)) { stop(); el._held = Date.now(); fn(); } });
}
/** Whether that touch was a hold (so letting go isn't also a tap). */
const wasHeld = (el) => !!el._held && Date.now() - el._held < 900;
/** A few choices over the open panel (Cancel, or a tap outside, closes it). */
function actions(title, items) {
  document.querySelectorAll(".dm-act").forEach((n) => n.remove());
  const wrap = h("div", "dm-act"), box = h("div", "dm-actbox");
  if (title) box.append(h("p", "dm-acth", title));
  for (const [label, fn, cls] of items) { const b = h("button", "menu-item " + (cls || ""), label); b.onclick = () => { wrap.remove(); fn(); }; box.append(b); }
  const c = h("button", "menu-item", "Cancel"); c.onclick = () => wrap.remove(); box.append(c);
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  wrap.append(box); document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add("in"));
}

// ---------------------------------------------------------------------------------------------------- posts and songs in a chat
const fileOf = (m, n) => api.fileOf(m, n);
/** A post sent in a message: its picture, who posted it and its words; a tap shows it in Social. A rebassed song's
 * post plays right here too. */
function postBubble(id) {
  const wrap = h("div", "dm-postw");
  const p = (api.state.feed || []).find((x) => x.id === id);
  const card = h("button", "dm-post");
  if (!p || !api.visible(p)) { card.disabled = true; card.append(h("span", "dm-mid", "This post isn't available.")); wrap.append(card); return wrap; }
  const th = h("span", "dm-pth"), mid = h("span", "dm-mid");
  const what = p.text || (p.song ? `♪ ${p.song.title}` : p.playlist ? `Playlist: ${p.playlist.name}` : p.video || (p.media && p.media.some((k) => k !== "i")) ? "A video" : p.image || (p.media && p.media.length) ? "Pictures" : "A post");
  mid.append(h("small", "dm-mktag", "Post"), h("b", "", api.nameOf(p)), h("small", "", what));
  card.append(th, mid);
  card.onclick = () => { if (wasHeld(card.closest(".dm-bubble") || card)) return; closeSheet(); api.showPost(p.id); };
  if (p.image || p.video || p.song || (p.media && p.media.length) || p.playlist) {
    api.message(p.id).then((m) => {
      const f = fileOf(m, "picture.jpg") || fileOf(m, "m0.jpg") || fileOf(m, "poster.jpg") || fileOf(m, "m0.poster.jpg") || fileOf(m, "cover.jpg");
      if (f) th.style.backgroundImage = `url("${f.url}")`; else th.classList.add("none");
    }).catch(() => th.classList.add("none"));
  } else th.classList.add("none");
  wrap.append(card);
  if (p.song) wrap.append(api.songBlock(p));
  return wrap;
}
/** A sealed file from a message's own store message, opened (and kept for the rest of the visit). */
async function sealedFile(other, msgId, name, iv) {
  const k = msgId + "/" + name;
  if (D.files.has(k)) return D.files.get(k);
  const job = (async () => {
    const key = await sharedKey(other);
    if (!key) throw new Error("nokey");
    const f = fileOf(await api.message(msgId), name);
    if (!f) throw new Error("gone");
    const r = await fetch(f.url, { cache: "no-store" });
    if (!r.ok) throw new Error("download");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, key, await r.arrayBuffer());
    return new Blob([plain], { type: name === "song.bin" ? "audio/mpeg" : "image/jpeg" });
  })();
  D.files.set(k, job); job.catch(() => D.files.delete(k));
  return job;
}
/** A rebassed song sent in a message: play it, or add it to the library (under Rebassed). */
function songBubble(m, s) {
  const other = m.f === api.state.me ? m.t : m.f;
  const b = h("div", "so-song dm-song");
  const cov = h("span", "so-cover"); cov.style.backgroundImage = `url("${placeholderArt(s.title, "rebass")}")`;
  if (s.civ) sealedFile(other, s.m, "cover.bin", s.civ).then((c) => { cov.style.backgroundImage = `url("${URL.createObjectURL(c)}")`; }, () => {});
  const play = h("button", "so-play dm-play"); play.dataset.id = m.id; play.setAttribute("aria-label", D.playing === m.id ? "Pause" : "Play"); play.append(api.icon(D.playing === m.id ? "i-pause" : "i-play"));
  play.onclick = async () => {
    if (!D.audio) { D.audio = new Audio(); D.audio.onended = () => { D.playing = ""; paintPlays(); }; }
    if (D.playing === m.id) { D.audio.pause(); D.playing = ""; paintPlays(); return; }
    play.classList.add("busy");
    try {
      const blob = await sealedFile(other, s.m, "song.bin", s.iv);
      player.pause();
      if (D.audioUrl) URL.revokeObjectURL(D.audioUrl);
      D.audioUrl = URL.createObjectURL(blob); D.audio.src = D.audioUrl; D.playing = m.id;
      await D.audio.play();
    } catch (e) { D.playing = ""; toast(e.message === "gone" ? "That song was deleted." : "Couldn't play that song. Are you online?"); }
    paintPlays();
  };
  const meta = h("div", "so-smeta"); meta.append(h("b", "", s.title), h("small", "", [s.artist, s.note, s.duration ? fmtTime(s.duration) : ""].filter(Boolean).join(" · ")));
  const add = h("button", "so-add"); add.append(api.icon("i-plus")); add.setAttribute("aria-label", "Add to my library"); add.title = "Add to my library";
  add.onclick = async () => {
    add.disabled = true; add.classList.add("busy");
    try {
      const audio = await sealedFile(other, s.m, "song.bin", s.iv);
      const cover = s.civ ? await sealedFile(other, s.m, "cover.bin", s.civ).catch(() => null) : null;
      const file = new File([audio], `${s.title}.mp3`.replace(/[\\/:*?"<>|]+/g, " "), { type: "audio/mpeg" });
      await library.add({ id: store.newId(), kind: "rebass", title: s.title, artist: s.artist || nameOf(m.f), album: "FifTeam Social", note: s.note || `from ${nameOf(m.f)}`,
        duration: s.duration, size: file.size, type: file.type, fileName: file.name, added: Date.now(), hasArt: !!cover, from: "dm" }, file, cover);
      add.classList.remove("busy"); add.classList.add("done"); toast("Added to your library, under Rebassed");
    } catch { add.disabled = false; add.classList.remove("busy"); toast("Couldn't download that song. Are you online?"); }
  };
  b.append(cov, play, meta, add);
  return b;
}
function paintPlays() {
  document.querySelectorAll(".dm-play").forEach((b) => { const on = b.dataset.id === D.playing; b.querySelector("use").setAttribute("href", on ? "#i-pause" : "#i-play"); b.setAttribute("aria-label", on ? "Pause" : "Play"); b.classList.remove("busy"); });
}
function stopSongs() { if (D.audio && D.playing) { D.audio.pause(); D.playing = ""; paintPlays(); } }
/** A rebassed song, sealed for one phone and put up in a message of its own. song: { title, artist, note, duration,
 * cover (Blob), encode(kbps) -> File } (as for a post). */
async function upSong(other, song, say) {
  const key = await sharedKey(other);
  if (!key) throw new Error("nokey");
  const room = 9.4 * 1024 * 1024;
  const kbps = [192, 160, 128, 112, 96].find((k) => (k * 1000 / 8) * (song.duration || 0) * 1.03 < room);
  if (!kbps) throw new Error(`That song is too long to send (${fmtTime(song.duration)}). Songs up to about 12 minutes fit.`);
  say("Preparing…");
  const f = await song.encode(kbps);
  if (f.size > room) throw new Error("That song is too big to send.");
  const seal1 = async (blob) => { const iv = crypto.getRandomValues(new Uint8Array(12)); return { iv: b64u(iv), blob: new Blob([await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await blob.arrayBuffer())], { type: "application/octet-stream" }) }; };
  const a = await seal1(f);
  let c = null;
  if (song.cover) { try { c = await seal1(await squareJpeg(song.cover, 300)); } catch {} }
  const files = [["song.bin", a.blob], ...(c ? [["cover.bin", c.blob]] : [])];
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify({ content: "FifTeam sealed message file (only the two phones can open it)", username: "FifTeam", allowed_mentions: { parse: [] }, attachments: files.map(([n], i) => ({ id: i, filename: n })) }));
  files.forEach(([n, bl], i) => fd.append(`files[${i}]`, bl, n));
  say("Uploading…");
  const msg = await api.dc("?wait=true", { method: "POST", form: fd });
  return { m: msg.id, iv: a.iv, ...(c ? { civ: c.iv } : {}), title: String(song.title || "Rebass").slice(0, 120), artist: String(song.artist || "").slice(0, 80), note: String(song.note || "").slice(0, 80), duration: Math.round(song.duration || 0) };
}

// ---------------------------------------------------------------------------------------------------- sending to someone
/** Whether this phone can message them: not blocked or banned, they have a key, and they take messages from it. */
function canMessage(other) {
  const me = api.state.me, pr = api.state.profiles[other];
  if (!PHONE.test(other) || other === me || !pr || !pr.pk || bannedPhones().has(other) || blocked(me, other)) return false;
  const st = dmState(me, other, talkedWith(other));
  return st === "ok" || (wrote(other) && st !== "off");
}
/** "Send to…": a post ({ post }) or a rebassed song ({ song }), to one or more people, with a few words if wanted.
 * (A song goes up once for each person: each copy is sealed for that phone alone.) */
export async function sendTo(item) {
  if (!api.state.name) { toast("Pick a username in Social first"); return; }
  if (item.post && !api.visible(item.post)) return;
  openSheet((p) => {
    p.classList.add("dm-panel", "dm-send");
    p.append(h("h3", "", "Send to"));
    const what = h("div", "dm-what"), mid = h("span", "dm-mid");
    if (item.post) mid.append(h("small", "dm-mktag", "Post"), h("b", "", api.nameOf(item.post)), h("small", "", item.post.text || (item.post.song ? `♪ ${item.post.song.title}` : "")));
    else mid.append(h("small", "dm-mktag", "Rebassed song"), h("b", "", item.song.title), h("small", "", [item.song.artist, item.song.note, item.song.duration ? fmtTime(item.song.duration) : ""].filter(Boolean).join(" · ")));
    what.append(mid);
    const note = h("input", "input dm-note"); note.maxLength = 300; note.placeholder = "Add a message (optional)"; note.setAttribute("aria-label", "Add a message"); note.autocomplete = "off";
    const q = h("input", "input"); q.type = "search"; q.placeholder = "Search people"; q.setAttribute("aria-label", "Search people"); q.autocomplete = "off";
    const list = h("div", "dm-list"); list.append(h("p", "status", "Loading…"));
    p.append(what, note, q, list);
    const sent = new Set(), busy = new Set();   // (kept through a redraw of the list)
    const paint = () => {
      const me = api.state.me, low = q.value.trim().toLowerCase();
      // people talked with lately first, then people followed, then everyone else
      const order = [], seen = new Set();
      for (const m of mineOnly().filter((x) => !x.l).sort((a, b) => b.at - a.at)) { const o = m.f === me ? m.t : m.f; if (!seen.has(o)) { seen.add(o); order.push(o); } }
      for (const o of followingOf(me)) if (!seen.has(o)) { seen.add(o); order.push(o); }
      const rest = Object.keys(api.state.profiles || {}).filter((o) => !seen.has(o)).sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }));
      const people = [...order, ...rest].filter((o) => o !== me && api.state.profiles[o] && api.state.profiles[o].name && !bannedPhones().has(o) && !blocked(me, o) && (!low || nameOf(o).toLowerCase().includes(low)));
      list.replaceChildren();
      if (!people.length) { list.append(h("p", "status", low ? `Nobody called "${q.value.trim()}".` : "Nobody to send to yet.")); return; }
      for (const o of people.slice(0, 80)) {
        const row = h("div", "dm-row");
        const av = api.avatarEl(42, "", nameOf(o)); api.showPicture(av, { by: o, user: nameOf(o), id: "" });
        const nm = h("span", "dm-mid"); nm.append(h("b", "", nameOf(o)));
        const ok = canMessage(o), go = h("button", "btn small", "");
        go.dataset.who = o;
        const look = (t) => { const b = list.querySelector(`button[data-who="${o}"]`) || go; b.textContent = t; b.disabled = t !== "Send"; b.classList.toggle("primary", t === "Send"); };
        look(sent.has(o) ? "Sent ✓" : busy.has(o) ? "Sending…" : ok ? "Send" : "Can't message");
        go.onclick = async () => {
          const words = note.value.trim();
          if (words && offensive(words)) { toast(OFFENSIVE, 3500); return; }
          busy.add(o); look("Sending…");
          try {
            const extra = item.post ? { p: item.post.id } : { s: await upSong(o, item.song, look) };
            look("Sending…");
            if (await send(o, words, "", extra)) sent.add(o);
          } catch (e) { toast(e.message === "nokey" ? `${nameOf(o)} needs to open FifTeam Media once more first.` : e.message || "Couldn't send that. Try again.", 3500); }
          busy.delete(o); look(sent.has(o) ? "Sent ✓" : "Send");
        };
        row.append(av, nm, go);
        list.append(row);
      }
    };
    q.oninput = paint;
    if (D.loadedAt) paint();
    Promise.all([api.ensureProfiles(), load()]).then(() => { if (list.isConnected) paint(); }, () => { if (list.isConnected && !D.loadedAt) list.replaceChildren(h("p", "status", "Couldn't load. Are you online?")); });
  });
}

// ---------------------------------------------------------------------------------------------------- notifications
// New messages to this phone, when switched on in Settings: a notification while the app is in the background, a
// banner while it's open (unless that conversation is the one open). With no server, the app has to be running to
// look for them: open, or in the background before the phone puts it to sleep.
const NOTIFY = "fifteam-dm-notify", TOLD = "fifteam-dm-told";
export const canNotify = () => "Notification" in window;
export const notifyOn = () => { try { return notifyWanted() && canNotify() && Notification.permission === "granted"; } catch { return false; } };
export function setNotify(on) { try { localStorage.setItem(NOTIFY, on ? "1" : "0"); } catch {} }
export const notifyWanted = () => { try { return localStorage.getItem(NOTIFY) !== "0"; } catch { return true; } };
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
    const l = m.l || "", title = l ? `${who} · Audio Market` : who;
    if (document.visibilityState === "visible") { if (D.chat !== m.f || (D.l || "") !== l) toast(`${title}: ${text}`.slice(0, 90), 3000); continue; }
    const opts = { body: text.slice(0, 160), tag: "fifteam-dm-" + m.f + (l ? "-" + l : ""), renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { dm: m.f, l } };
    try { const reg = await navigator.serviceWorker.ready; await reg.showNotification(title, opts); }
    catch { try { const n = new Notification(title, opts); n.onclick = () => { window.focus(); openChat(m.f, l); n.close(); }; } catch {} }
  }
}

/** The unread count on the messages button, kept up to date while the app is open (and with notifications on, while
 * it's in the background too, as long as the phone lets it run). */
export function initDms() {
  const btn = $("btn-dms");
  if (btn) btn.onclick = () => openInbox();
  // a rebassed song to send (from the Rebass screen, or the library)
  bus.on("dm-send-song", (song) => sendTo({ song }));
  bus.on("dm-send-track", async (t) => { try { sendTo({ song: await api.trackSong(t) }); } catch { toast("Couldn't read that song."); } });
  bus.on("music-playing", stopSongs);
  const tick = D.check = async () => {
    if ((document.visibilityState !== "visible" && !notifyOn()) || !api.state.me) return;
    try { await api.ensureProfiles(); await load(); paintBadge(); await tellNew(); } catch {}
  };
  setTimeout(tick, 2500);
  setInterval(tick, 45000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
  // on by default: the phone's own question, once, at the first tap in the app (it only allows asking after a tap)
  try {
    if (canNotify() && Notification.permission === "default" && notifyWanted() && !localStorage.getItem(NOTIFY + "-asked")) {
      const ask = () => { removeEventListener("click", ask, true); try { localStorage.setItem(NOTIFY + "-asked", "1"); } catch {} Notification.requestPermission().catch(() => {}); };
      addEventListener("click", ask, true);
    }
  } catch {}
  // a tap on a message notification: that conversation
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "open-dm" && PHONE.test(e.data.dm)) { location.hash = "#social"; openChat(e.data.dm, /^\d{5,25}$/.test(e.data.l || "") ? e.data.l : ""); } });
  const want = new URLSearchParams(location.search).get("dm");
  if (want && PHONE.test(want)) {
    history.replaceState(null, "", location.pathname + "#social");
    setTimeout(async () => { try { await api.ensureProfiles(); } catch {} openChat(want); }, 1200);
  }
}
export const dms = { state: D, open, myPublicKey };
