// Live streams in Social. The person the FifTeam team lets (/allow streaming) can go live with the phone's camera;
// everyone can watch, chat and send likes (hearts), and sees how many are watching.
//   Going live: the camera is recorded as one continuous video (MP4, H.264 and AAC, where the phone can: it plays on
// every phone; otherwise WebM), handed over every quarter second and sent straight up the app's live connection, with
// where in it a viewer can start (each fragment, from a whole frame; a new one every second).
//   Watching: the server sends the recording's setup and the video from the latest place to start, then every slice as
// it comes. They go into one video as they arrive (Media Source; on iPhone, Managed Media Source), on the recording's
// own timeline, so sound and picture stay together and there's nothing to stitch. It stays about a second or two
// behind live: falling behind, it plays a touch faster until it has caught up; running low, a touch slower.
//   Chat and likes go round on the live connection; the streamer can take a chat message down (hold it).
import { toast, pushLayer, dropLayer } from "./ui.js";
import { hubStreamStart, hubStreamEnd, hubStreams, liveSend, liveSendBin, liveBacklog, live, startLive } from "./hub.js";
import { offensive, OFFENSIVE } from "./filter.js";
import { isStreamer } from "./ban.js";

const L = { list: [], h: null };
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ico = (id) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + id); s.append(u); return s; };
const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e4 ? Math.round(n / 1e3) + "K" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n));
const since = (t) => { const s = Math.max(0, Math.floor((Date.now() - t) / 1000)); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`; };

/** (for checks) the stream being watched: how far behind its newest video it's playing (s), and how fast. */
export const liveStats = () => { const v = L.view; return v && v.player ? { lag: v.player.lag(), rate: v.mine ? 1 : document.querySelector(".lv .lv-v.on").playbackRate } : null; };
/** Who's live now: [{ id, by, name, at, title, viewers, likes }]. */
export const streamsNow = () => L.list;
/** Whether this phone may go live. */
export const canGoLive = () => isStreamer(L.h && L.h.me());

/** Set up (from Social): hooks = { me() (this phone), name() (its username), avatar(phone, name, size) (an element),
 * changed() (the list of who's live changed) }. */
export function initLive(hooks) {
  L.h = hooks;
  addEventListener("hub:stream", (e) => {
    const m = e.detail || {};
    if (m.t === "streams") { setList(m.list); return; }
    const v = L.view;
    if (m.t === "lv") {
      if (v && !v.mine && m.s === v.id) v.player.feed(m);
      if (L.peek && m.s === L.peek.id) L.peek.feed(m);
      return;
    }
    if (m.t === "upgone") { if (v && v.mine && v.lost) v.lost(m.s); return; }
    if (v && m.s === v.id) v.on(m);
  });
  // someone went live (the app open): a banner at the top, tapped to watch
  addEventListener("hub:note", (e) => { const n = e.detail || {}; if (n.kind === "live" && n.data && n.data.live) liveBanner(n); });
  addEventListener("hub:open", () => { if (L.peek) liveSend({ t: "peek", s: L.peek.id }); });
  addEventListener("hashchange", () => { paintChip(); peekCheck(); });
  document.addEventListener("visibilitychange", () => peekCheck());
  paintChip();
  // (the list now, without waiting for the live connection)
  const fetchList = () => hubStreams().then(setList, () => {});
  addEventListener("hub:open", fetchList);
  fetchList();
  // a tap on "is live now"
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => { const d = e.data || {}; if (d.type === "open-live" && d.live) openLiveOf(d.live); });
  const q = new URLSearchParams(location.search), want = q.get("live");
  if (want && /^[a-z0-9]{6,16}$/.test(want)) { history.replaceState(null, "", location.pathname + "#social"); setTimeout(() => openLiveOf(want), 1500); }
}
function setList(list) {
  const clean = (Array.isArray(list) ? list : []).filter((s) => s && typeof s.id === "string").map((s) => ({ id: s.id, by: String(s.by || ""), name: String(s.name || "FifTeam").slice(0, 24), at: +s.at || Date.now(), title: String(s.title || "").slice(0, 80), viewers: +s.viewers || 0, likes: +s.likes || 0 }));
  const sig = (l) => l.map((s) => s.id + s.name + s.title).join("|");
  const changed = sig(clean) !== sig(L.list);
  L.list = clean;
  if (changed && L.h && L.h.changed) L.h.changed();
  paintChip();
  // (watching a stream that's gone, but the same person is live again: that one)
  const v = L.view;
  if (v && !v.mine && !clean.some((s) => s.id === v.id)) { const again = clean.find((s) => s.by === v.by); if (again) v.switchTo(again); }
}
/** In the app's top bar on every screen while someone's live: a red LIVE button with their name; tapped, the stream. */
function paintChip() {
  const top = document.querySelector("header.top"); if (!top) return;
  let chip = document.getElementById("lv-chip");
  const s = L.list.find((x) => x.by !== (L.h && L.h.me())) || L.list[0];
  if (!s) { if (chip) chip.remove(); top.classList.remove("has-live"); return; }
  if (!chip) {
    chip = h("button", "lv-chip"); chip.id = "lv-chip"; chip.type = "button";
    chip.append(h("span", "lv-chipdot"), h("b", "", "LIVE"), h("span", "lv-chipname", ""));
    const brand = top.querySelector(".brand"); brand.after(chip);
  }
  chip.querySelector(".lv-chipname").textContent = s.name;
  chip.setAttribute("aria-label", `${s.name} is live: watch`);
  chip.onclick = () => { const now = L.list.find((x) => x.id === s.id) || s; location.hash = "#social"; watch(now); };
  top.classList.add("has-live");
}
/** "X is live" while the app's open: a banner that slides down; tapped, the stream. */
function liveBanner(n) {
  if (L.view) return;
  document.getElementById("lv-banner")?.remove();
  const b = h("button", "lv-banner"); b.id = "lv-banner"; b.type = "button";
  const av = L.h ? L.h.avatar(n.data.live, String(n.title || "").replace(/ is live$/, ""), 40) : h("span");
  const t = h("div", "lv-bt"); t.append(h("b", "", n.title || "Someone is live"), h("small", "", n.body || "Tap to watch now"));
  b.append(h("span", "lv-badge", "LIVE"), av, t);
  b.onclick = () => { b.remove(); openLiveOf(n.data.live); };
  document.body.append(b);
  requestAnimationFrame(() => b.classList.add("in"));
  setTimeout(() => { b.classList.remove("in"); setTimeout(() => b.remove(), 400); }, 9000);
  hubStreams().then(setList, () => {});
}

// ---------------------------------------------------------------------------------------------------- the preview
/** The preview at the top of the feed: the stream itself, playing (muted) while it's on screen; tapped, the stream with
 * sound, the chat and the likes. Only while it's on screen does the app take the pieces (and it doesn't count as
 * watching). */
export function previewCard(s) {
  const card = h("button", "lv-prev"); card.type = "button"; card.setAttribute("aria-label", `${s.name} is live${s.title ? ": " + s.title : ""}. Watch`);
  const vA = h("video", "lv-pv on"), vB = h("video", "lv-pv");
  for (const v of [vA, vB]) { v.muted = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.setAttribute("muted", ""); v.preload = "auto"; }
  const top = h("div", "lv-ptop"); top.append(h("span", "lv-badge", "LIVE"));
  const eye = h("span", "lv-eye"); eye.append(ico("i-eye"), h("span", "", fmtN(s.viewers || 0))); top.append(eye);
  const foot = h("div", "lv-pfoot"), who = h("div", "lv-pwho");
  const nm = h("div", "lv-nm"); nm.append(h("b", "", s.name), h("small", "lv-title", s.title || ""));
  who.append(L.h.avatar(s.by, s.name, 34), nm);
  const go = h("span", "lv-pgo", "Watch"); go.prepend(ico("i-play"));
  foot.append(who, go);
  const wait = h("div", "lv-pwait"); wait.append(h("span", "lv-spin"));
  card.append(vA, vB, h("div", "lv-pshade"), wait, top, foot);
  card.onclick = () => { const now = L.list.find((x) => x.id === s.id) || s; watch(now); };
  const P = { id: s.id, on: false, pl: null, card, seen: false };
  P.feed = (m) => { if (P.pl) P.pl.feed(m); };
  P.start = () => {
    if (P.on) return;
    P.on = true;
    P.pl = livePlayer(vA, { muted: true, onPlay: () => card.classList.add("playing"), rejoin: () => liveSend({ t: "peek", s: P.id }) });
    L.peek = P;
    liveSend({ t: "peek", s: P.id });
  };
  P.stop = () => {
    if (!P.on) return;
    P.on = false;
    try { P.pl.stop(); } catch {}
    for (const v of [vA, vB]) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch {} }
    card.classList.remove("playing");
    if (L.peek === P) { L.peek = null; liveSend({ t: "peek", s: "" }); }
  };
  P.check = () => {
    const want = card.isConnected && P.seen && document.visibilityState === "visible" && location.hash === "#social" && !L.view && L.list.some((x) => x.id === P.id);
    if (want) P.start(); else P.stop();
    if (!card.isConnected && P.io) { P.io.disconnect(); clearInterval(P.tick); if (L.cards) L.cards.delete(P); }
  };
  if ("IntersectionObserver" in window) { P.io = new IntersectionObserver((es) => { P.seen = es.some((x) => x.isIntersecting); P.check(); }, { threshold: 0.25 }); P.io.observe(card); }
  else P.seen = true;
  P.tick = setInterval(P.check, 2000);
  (L.cards = L.cards || new Set()).add(P);
  setTimeout(P.check, 50);
  return card;
}
function peekCheck() { for (const P of L.cards || []) P.check(); }

/** Someone's stream, from a notification: theirs if they're still live. */
async function openLiveOf(phone) {
  location.hash = "#social";
  let s = L.list.find((x) => x.by === phone);
  if (!s) { try { setList(await hubStreams()); } catch {} s = L.list.find((x) => x.by === phone); }
  if (s) watch(s); else toast("That stream has ended.", 2500);
}

// ---------------------------------------------------------------------------------------------------- the screen
/** The full-screen stream: video, who and how long, how many watching, the chat at the bottom, hearts. */
function screen(s, mine) {
  const root = h("div", "lv"); root.setAttribute("role", "dialog"); root.setAttribute("aria-label", `${s.name}'s live stream`);
  const stage = h("div", "lv-stage");
  const vA = h("video", "lv-v on"), vB = h("video", "lv-v");
  for (const v of [vA, vB]) { v.playsInline = true; v.setAttribute("playsinline", ""); v.setAttribute("webkit-playsinline", ""); v.autoplay = false; v.preload = "auto"; }
  if (mine) { vA.muted = true; vA.classList.add("mirror"); }
  // (filled edge to edge when the picture is about the screen's shape; otherwise shown whole, not cropped and zoomed)
  const fitOf = (v) => { const r = v.videoWidth / v.videoHeight, sc = innerWidth / innerHeight; v.classList.toggle("fit", !!r && (r / sc > 1.3 || sc / r > 1.3)); };
  for (const v of [vA, vB]) { v.addEventListener("loadedmetadata", () => fitOf(v)); v.addEventListener("resize", () => fitOf(v)); }
  addEventListener("resize", () => { fitOf(vA); fitOf(vB); });
  stage.append(vA, vB);
  const shade = h("div", "lv-shade");
  const top = h("div", "lv-top");
  const who = h("div", "lv-who");
  const av = L.h.avatar(s.by, s.name, 36);
  const nm = h("div", "lv-nm"); nm.append(h("b", "", s.name), h("small", "lv-title", s.title || ""));
  who.append(av, nm);
  const badge = h("span", "lv-badge", "LIVE"), clock = h("span", "lv-clock", since(s.at));
  const eye = h("span", "lv-eye"); eye.append(ico("i-eye"), h("span", "", fmtN(s.viewers || 0)));
  const x = h("button", "lv-x"); x.setAttribute("aria-label", mine ? "End the stream" : "Close"); x.append(mine ? h("span", "", "End") : ico("i-close"));
  const pills = h("div", "lv-pills"); pills.append(badge, clock, eye);
  top.append(who, pills, x);
  const wait = h("div", "lv-wait"); wait.append(h("span", "lv-spin"), h("span", "", mine ? "Starting the camera…" : "Joining…"));
  const hearts = h("div", "lv-hearts");
  const chat = h("div", "lv-chat"); chat.setAttribute("aria-live", "polite");
  const bar = h("form", "lv-bar");
  const inp = h("input", "lv-in"); inp.maxLength = 200; inp.placeholder = mine ? "Say something to everyone…" : "Say something…"; inp.autocomplete = "off"; inp.enterKeyHint = "send"; inp.setAttribute("aria-label", "Chat");
  const send = h("button", "lv-send"); send.type = "submit"; send.setAttribute("aria-label", "Send"); send.append(ico("i-send"));
  const like = h("button", "lv-like"); like.type = "button"; like.setAttribute("aria-label", "Like"); like.append(h("span", "lv-heart", "♥"), h("small", "lv-likes", fmtN(s.likes || 0)));
  bar.append(inp, send, like);
  root.append(stage, shade, top, wait, hearts, chat, bar);
  document.body.append(root);
  requestAnimationFrame(() => root.classList.add("in"));
  return { root, stage, vA, vB, top, who, eye, clock, x, wait, hearts, chat, bar, inp, like, badge };
}
/** A heart floating up from the like button (yours a little bigger). */
function heart(ui, mine) {
  if (ui.hearts.childElementCount > 24) return;
  const e = h("span", "lv-fh" + (mine ? " me" : ""), "♥");
  const hue = [330, 350, 10, 280, 300][Math.floor(Math.random() * 5)];
  e.style.color = `hsl(${hue} 95% 62%)`;
  e.style.setProperty("--dx", `${Math.round((Math.random() - 0.5) * 90)}px`);
  e.style.setProperty("--rot", `${Math.round((Math.random() - 0.5) * 40)}deg`);
  e.style.animationDuration = `${1.6 + Math.random() * 0.9}s`;
  e.addEventListener("animationend", () => e.remove());
  ui.hearts.append(e);
}
/** A chat line: name (tap: their page, after closing) and words; the streamer can hold one to take it down. */
function chatLine(ui, c, mine, onRemove) {
  const row = h("div", "lv-msg"); row.dataset.id = c.id;
  const nm = h("b", "", c.name || "Someone");
  const words = h("span", ""); words.append(" ", L.h && L.h.rich ? L.h.rich(c.text, () => L.view && L.view.close()) : c.text);
  row.append(nm, words);
  if (c.by && L.h.me() === c.by) row.classList.add("me");
  if (mine && onRemove) {
    let t = 0;
    const down = () => { t = setTimeout(() => { if (confirm(`Take down ${c.name}'s message?`)) onRemove(c.id); }, 550); };
    const up = () => clearTimeout(t);
    row.addEventListener("pointerdown", down); row.addEventListener("pointerup", up); row.addEventListener("pointerleave", up); row.addEventListener("pointercancel", up);
  }
  ui.chat.append(row);
  while (ui.chat.childElementCount > 60) ui.chat.firstElementChild.remove();
  ui.chat.scrollTop = ui.chat.scrollHeight;
}
/** The chat box and the like button, wired (shared by watching and streaming). */
function wireTalk(ui, v) {
  if (L.h && L.h.mentions) L.h.mentions(ui.inp, { above: true, z: 320 });
  ui.bar.onsubmit = (e) => {
    e.preventDefault();
    const text = ui.inp.value.replace(/\s+/g, " ").trim();
    if (!text) return;
    if (!L.h.name()) { toast("Pick a username first"); return; }
    if (offensive(text)) { toast(OFFENSIVE, 3500); return; }
    if (Date.now() - (v.saidAt || 0) < 1000) { toast("A little slower", 1200); return; }
    if (!liveSend({ t: "say", s: v.id, text })) { toast("Not connected. Trying again…", 2000); startLive(); return; }
    v.saidAt = Date.now();
    ui.inp.value = "";
  };
  let lastLike = 0;
  const doLike = () => {
    heart(ui, true);
    ui.like.classList.remove("pop"); void ui.like.offsetWidth; ui.like.classList.add("pop");
    const now = Date.now();
    if (now - lastLike < 120) return;                     // (taps faster than the server takes them: shown, not sent)
    lastLike = now;
    if (liveSend({ t: "like", s: v.id })) v.mineLiked = (v.mineLiked || 0) + 1;
  };
  ui.like.onclick = doLike;
  // (a double tap on the video: a like too)
  let lastTap = 0;
  ui.stage.addEventListener("pointerup", () => { const n = Date.now(); if (n - lastTap < 320) { doLike(); lastTap = 0; } else lastTap = n; });
  v.doLike = doLike;
}
/** What the server says about this stream: its state when joining, chat, likes, how many watching, its end. */
function onStreamMessage(v, ui, m) {
  if (m.t === "st") {
    ui.chat.replaceChildren();
    for (const c of m.chat || []) chatLine(ui, c, v.mine, v.remove);
    ui.like.querySelector(".lv-likes").textContent = fmtN(m.likes || 0); v.likes = m.likes || 0;
    ui.eye.lastChild.textContent = fmtN(m.viewers || 0);
  } else if (m.t === "chat") chatLine(ui, m.m, v.mine, v.remove);
  else if (m.t === "unsay") ui.chat.querySelector(`.lv-msg[data-id="${CSS.escape(m.id)}"]`)?.remove();
  else if (m.t === "like") {
    v.likes = m.n; ui.like.querySelector(".lv-likes").textContent = fmtN(m.n);
    if (m.by !== L.h.me()) { const now = Date.now(); if (now - (v.heartAt || 0) > 140) { v.heartAt = now; heart(ui, false); } }
  } else if (m.t === "viewers") ui.eye.lastChild.textContent = fmtN(m.n);
  else if (m.t === "end" && !v.mine) v.ended();
  else if (m.t === "end" && v.mine) { toast("Your stream has ended.", 3000); v.close(); }
}
/** Sound wasn't allowed to start by itself: playing muted, with a button to turn it on. */
function soundHint(root, video) {
  if (!root || root.querySelector(".lv-sound")) return;
  const b = h("button", "lv-sound"); b.type = "button"; b.append(ico("i-mute"), h("span", "", "Tap for sound"));
  b.onclick = (e) => { e.stopPropagation(); video.muted = false; if (video.paused) video.play().catch(() => {}); b.remove(); };
  root.append(b);
}
let wake = null;
const keepAwake = async (on) => { try { if (on && "wakeLock" in navigator && !wake) wake = await navigator.wakeLock.request("screen"); else if (!on && wake) { await wake.release(); wake = null; } } catch {} };

// ---------------------------------------------------------------------------------------------------- watching
/** Watch someone's stream. */
export function watch(s) {
  if (L.view) L.view.close(true);
  setTimeout(peekCheck, 0);
  const ui = screen(s, false);
  const v = { id: s.id, by: s.by, mine: false, likes: s.likes };
  L.view = v;
  v.player = livePlayer(ui.vA, {
    root: ui.root,
    onPlay: () => { ui.wait.hidden = true; },
    onStall: (why) => {
      if (why === "unsupported") { ui.wait.hidden = false; ui.wait.replaceChildren(h("b", "", "This phone can't play live video yet"), h("small", "", "Update it to watch (iPhone: iOS 17.1 or newer).")); return; }
      ui.wait.hidden = false; ui.wait.lastChild.textContent = "Catching up…";
    },
    rejoin: () => liveSend({ t: "watch", s: v.id }),
  });
  wireTalk(ui, v);
  v.on = (m) => onStreamMessage(v, ui, m);
  const join = () => { if (!liveSend({ t: "watch", s: v.id })) { startLive(); setTimeout(() => L.view === v && join(), 1200); } };
  const onOpen = () => { if (L.view === v) join(); };
  addEventListener("hub:open", onOpen);
  join();
  const tick = setInterval(() => { ui.clock.textContent = since(s.at); }, 1000);
  keepAwake(true);
  v.switchTo = (n) => { v.id = n.id; s = n; v.player.reset(); join(); };
  v.ended = () => {
    v.player.stop();
    ui.wait.hidden = false; ui.wait.replaceChildren(h("b", "", "The stream has ended"), h("small", "", `${s.name} isn't live any more.`));
    const b = h("button", "btn small", "Close"); b.onclick = () => v.close(); ui.wait.append(b);
    ui.badge.classList.add("off"); ui.badge.textContent = "ENDED";
    ui.bar.hidden = true;
  };
  v.close = (quiet) => {
    if (L.view !== v) return;
    L.view = null;
    liveSend({ t: "unwatch" });
    setTimeout(peekCheck, 300);
    removeEventListener("hub:open", onOpen);
    clearInterval(tick); v.player.stop(); keepAwake(false);
    ui.root.classList.remove("in"); setTimeout(() => ui.root.remove(), 220);
    if (!quiet) dropLayer("live");
  };
  ui.x.onclick = () => v.close();
  pushLayer("live", () => v.close(true));
}

/** The player: a stream's start (its setup and the video from a whole frame on), then the rest a slice at a time, into
 * one video (Media Source; Managed Media Source on iPhone), on the recording's own timeline. Paced to stay close to
 * live without jumping: behind, a touch faster; low, a touch slower; well behind, straight to near the end. A gap (a
 * slice that didn't come), stepped over. Broken (a damaged slice): asks to start again (rejoin). */
function livePlayer(video, { muted = false, root = null, onPlay = () => {}, onStall = () => {}, rejoin = () => {} } = {}) {
  const MS = window.ManagedMediaSource || window.MediaSource;
  const P = { ms: null, sb: null, q: [], g: null, url: "", started: false, stopped: false, broke: 0 };
  if (muted) video.muted = true;
  video.playsInline = true;
  // ("video/mp4;codecs=avc1.42001f,mp4a.40.2" -> 'video/mp4; codecs="avc1.42001f,mp4a.40.2"')
  const mimeOf = (t) => { const m = /^\s*([^;\s]+)\s*(?:;\s*codecs\s*=\s*"?([^"]+)"?)?/i.exec(String(t || "")); return m ? (m[2] ? `${m[1]}; codecs="${m[2].trim()}"` : m[1]) : ""; };
  const teardown = () => {
    P.sb = null;
    if (P.ms) { try { if (P.ms.readyState === "open") P.ms.endOfStream(); } catch {} }
    P.ms = null;
    if (P.url) { try { URL.revokeObjectURL(P.url); } catch {} P.url = ""; }
  };
  async function open(type) {
    teardown();
    const mime = mimeOf(type);
    if (!MS || !MS.isTypeSupported(mime)) { onStall("unsupported"); return false; }
    const ms = new MS(); P.ms = ms;
    if (window.ManagedMediaSource && ms instanceof window.ManagedMediaSource) video.disableRemotePlayback = true;
    P.url = URL.createObjectURL(ms); video.src = P.url;
    await new Promise((res) => ms.addEventListener("sourceopen", res, { once: true }));
    if (P.ms !== ms || P.stopped) return false;
    try { P.sb = ms.addSourceBuffer(mime); P.sb.mode = "segments"; P.sb.addEventListener("updateend", drain); }
    catch { P.sb = null; onStall("unsupported"); return false; }
    return true;
  }
  function drain() {
    const sb = P.sb;
    if (!sb || sb.updating || !P.q.length || P.stopped) return;
    // (what's long played: let go, so memory doesn't fill)
    try { const b = sb.buffered; if (b.length && video.currentTime - b.start(0) > 20) { sb.remove(b.start(0), video.currentTime - 6); return; } } catch {}
    try { sb.appendBuffer(P.q.shift()); }
    catch (e) {
      if (e.name === "QuotaExceededError") { try { sb.remove(0, Math.max(0.1, video.currentTime - 1)); } catch {} return; }
      broken();
    }
  }
  function broken() { if (P.stopped) return; teardown(); P.g = null; P.q = []; if (++P.broke < 20) { onStall(); rejoin(); } }
  const play = () => video.play().then(() => onPlay(), () => {
    if (video.muted) return;
    video.muted = true; soundHint(root, video);                // (sound has to wait for a tap)
    video.play().then(() => onPlay(), () => {});
  });
  // the pace: about 1 to 1.8 s behind the newest video
  const pace = setInterval(() => {
    if (P.stopped || !P.sb) return;
    let b; try { b = P.sb.buffered; } catch { return; }
    if (!b.length) return;
    const end = b.end(b.length - 1);
    if (!P.started) { P.started = true; video.currentTime = Math.max(b.start(b.length - 1), end - 0.9); play(); return; }
    const t = video.currentTime;
    // (between two pieces of video, or before them: on to the next)
    let inside = false, next = null;
    for (let i = 0; i < b.length; i++) { if (t >= b.start(i) - 0.04 && t < b.end(i)) inside = true; else if (b.start(i) > t && next == null) next = b.start(i); }
    if (!inside && next != null) { video.currentTime = next + 0.02; return; }
    const lag = end - t;
    if (lag > 4.5) { video.currentTime = end - 1.2; video.playbackRate = 1; P.lags = []; return; }
    // (steered by the least video in hand over the last 2.5 s, just before each new second of it comes, not by the swing
    // as each comes in: so the speed only changes when it's really drifting, and then only by a little)
    const now = performance.now();
    P.lags = (P.lags || []).filter((x) => now - x.at < 2500); P.lags.push({ at: now, lag });
    if (P.lags.length >= 8) {
      const low = Math.min(...P.lags.map((x) => x.lag));
      const rate = low > 2 ? 1.1 : low > 1.1 ? 1.04 : low < 0.12 ? 0.95 : video.playbackRate > 1 && low < 0.5 ? 1 : video.playbackRate < 1 && low > 0.35 ? 1 : video.playbackRate;
      if (video.playbackRate !== rate) video.playbackRate = rate;
    }
    if (video.paused && lag > 0.4) play();
  }, 250);
  video.addEventListener("waiting", () => { if (!P.stopped && P.started) onStall(); });
  video.addEventListener("playing", () => onPlay());
  video.addEventListener("error", () => { if (P.ms && !P.stopped) broken(); });
  return {
    /** A message from the server: the start of the stream (a new player), or the next slice. */
    feed(m) {
      if (P.stopped || !m.data) return;
      if (m.k === "start") {
        P.g = m.g; P.q = [m.data]; P.started = false;
        open(m.type).then((ok) => { if (ok) drain(); });
      } else if (m.k === "more" && m.g === P.g) { P.q.push(m.data); drain(); }
    },
    reset() { teardown(); P.g = null; P.q = []; P.started = false; },
    stop() {
      P.stopped = true; clearInterval(pace);
      try { video.pause(); } catch {}
      teardown();
      try { video.removeAttribute("src"); video.load(); } catch {}
    },
    /** (for checks) how far behind the newest video it's playing, in seconds */
    lag() { try { const b = P.sb.buffered; return b.length ? b.end(b.length - 1) - video.currentTime : -1; } catch { return -1; } },
  };
}

/** Where a viewer can start in a recording as it comes, slice by slice: MP4, each fragment ("moof"); WebM, each cluster.
 * push(bytes, at) gives those places (in bytes from the recording's start); .init is its setup (everything before the
 * first), once it's in. Element and box headers split across slices are put back together. */
function splitter(mp4) {
  let pend = new Uint8Array(0), pendAt = 0, skip = 0, head = [], headLen = 0;
  const S = { init: null, joins: 0 };
  const box = (d, i) => {                                         // an MP4 box: its size and type
    if (d.length - i < 8) return null;
    let size = ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0, hdr = 8;
    const type = String.fromCharCode(d[i + 4], d[i + 5], d[i + 6], d[i + 7]);
    if (size === 1) { if (d.length - i < 16) return null; size = (((d[i + 8] << 24) | (d[i + 9] << 16) | (d[i + 10] << 8) | d[i + 11]) >>> 0) * 4294967296 + (((d[i + 12] << 24) | (d[i + 13] << 16) | (d[i + 14] << 8) | d[i + 15]) >>> 0); hdr = 16; }
    if (size === 0) size = Infinity;
    if (size < hdr) size = d.length - i;
    return { join: type === "moof", total: size };
  };
  const vint = (d, i, keep) => {                                  // an EBML number (ids keep their marker bit)
    if (i >= d.length) return null;
    const b = d[i]; let len = 1, m = 0x80;
    while (len <= 8 && !(b & m)) { len++; m >>= 1; }
    if (len > 8) return { len: 1, v: 0, unknown: false };
    if (i + len > d.length) return null;
    let v = keep ? b : b & (m - 1), all = (b & (m - 1)) === m - 1;
    for (let k = 1; k < len; k++) { v = v * 256 + d[i + k]; if (d[i + k] !== 0xff) all = false; }
    return { len, v, unknown: !keep && all };
  };
  const ebml = (d, i) => {                                        // a WebM element: go into the segment and clusters
    const id = vint(d, i, true); if (!id) return null;
    const sz = vint(d, i + id.len, false); if (!sz) return null;
    const hdr = id.len + sz.len;
    if (id.v === 0x18538067) return { enter: true, hdr };
    if (id.v === 0x1f43b675) return { join: true, enter: true, hdr };
    if (sz.unknown) return { enter: true, hdr };
    return { total: hdr + sz.v };
  };
  S.push = (chunk, at) => {
    const out = [];
    if (!S.init) { head.push(chunk); headLen += chunk.length; }
    let d = chunk, base = at;
    if (pend.length) { d = new Uint8Array(pend.length + chunk.length); d.set(pend); d.set(chunk, pend.length); base = pendAt; }
    let i = 0;
    if (skip) { const k = Math.min(skip, d.length); i = k; skip -= k; }
    while (i < d.length) {
      const r = mp4 ? box(d, i) : ebml(d, i);
      if (!r) break;                                              // (a header cut off: finished with the next slice)
      if (r.join) out.push(base + i);
      if (r.enter) { i += r.hdr; continue; }
      if (i + r.total <= d.length) i += r.total; else { skip = i + r.total - d.length; i = d.length; }
    }
    pend = d.slice(i); pendAt = base + i;
    if (!S.init && out.length) {
      const all = new Uint8Array(headLen); let o = 0; for (const c of head) { all.set(c, o); o += c.length; }
      S.init = all.slice(0, out[0]); head = null;
    }
    S.joins += out.length;
    return out;
  };
  return S;
}
/** The recording's kind with its codecs, for the players (MP4: read from its setup; some phones don't say). */
function kindOf(init, mime, mp4) {
  if (!mp4) return /codecs=/.test(mime) ? mime : "video/webm;codecs=vp8,opus";
  const find = (txt) => { const t = [...txt].map((c) => c.charCodeAt(0)); outer: for (let i = 0; i + 4 <= init.length; i++) { for (let k = 0; k < 4; k++) if (init[i + k] !== t[k]) continue outer; return i; } return -1; };
  const hex = (n) => n.toString(16).padStart(2, "0");
  let v = "", a = "";
  const avc = find("avcC");
  if (avc >= 0 && avc + 8 <= init.length) v = `avc1.${hex(init[avc + 5])}${hex(init[avc + 6])}${hex(init[avc + 7])}`;
  if (find("mp4a") >= 0) a = "mp4a.40.2"; else if (find("Opus") >= 0) a = "opus";
  if (!v) return /codecs=/.test(mime) ? mime : "video/mp4;codecs=avc1.42E01F,mp4a.40.2";
  return `video/mp4;codecs=${[v, a].filter(Boolean).join(",")}`;
}

// ---------------------------------------------------------------------------------------------------- going live
const TYPES = ["video/mp4;codecs=avc1.42E01F,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"];
/** Go live: the camera first (with a title to type), then live, until End. */
export async function goLive() {
  if (!canGoLive()) { toast("Going live is for people the FifTeam team has let. Ask in the FifTeam server.", 3500); return; }
  if (!L.h.name()) { toast("Pick a username first"); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast("This phone can't stream from the app. Update it, or try another browser.", 3500); return; }
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  if (!type) { toast("This phone can't record video for a stream.", 3000); return; }
  if (L.view) L.view.close(true);
  const s = { id: "", by: L.h.me(), name: L.h.name(), at: Date.now(), title: "", viewers: 0, likes: 0 };
  const ui = screen(s, true);
  const v = { id: "", by: s.by, mine: true, likes: 0 };
  L.view = v;
  let facing = "user", media = null, mic = true;
  // (a normal 16:9 picture in the camera's own terms: the phone turns it upright. Asking for a tall one made phones crop
  // into the sensor, which looked very zoomed in)
  const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  const widest = (t) => { try { const c = t.getCapabilities ? t.getCapabilities() : {}; if (c.zoom && c.zoom.min != null) t.applyConstraints({ advanced: [{ zoom: c.zoom.min }] }).catch(() => {}); } catch {} };
  const getCam = async () => navigator.mediaDevices.getUserMedia({
    video: { ...VIDEO, facingMode: facing },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  /** The camera facing `want` ("user": the front, "environment": the back): by its facing if the phone says, otherwise
   * the other camera on its list. */
  const camFacing = async (want) => {
    try { return await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO, facingMode: { exact: want } } }); }
    catch {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      const now = (media && media.getVideoTracks()[0] && media.getVideoTracks()[0].getSettings().deviceId) || "";
      const pick = cams.find((d) => (want === "environment" ? /back|rear|environment|world/i : /front|user|face/i).test(d.label) && d.deviceId !== now)
        || cams.find((d) => d.deviceId && d.deviceId !== now);
      if (!pick) throw new Error("one camera");
      return navigator.mediaDevices.getUserMedia({ video: { ...VIDEO, deviceId: { exact: pick.deviceId } } });
    }
  };
  try { media = await getCam(); widest(media.getVideoTracks()[0]); }
  catch { toast("Couldn't use the camera and microphone. Allow them in your phone's settings for this app.", 4500); L.view = null; ui.root.remove(); return; }
  ui.vA.srcObject = media; ui.vA.muted = true; ui.vA.play().catch(() => {});
  ui.wait.hidden = true;
  ui.bar.hidden = true;
  ui.badge.textContent = "READY"; ui.badge.classList.add("off");
  // before going live: a title, flip, mic, Go live
  const pre = h("form", "lv-pre");
  const title = h("input", "lv-in lv-tin"); title.maxLength = 80; title.placeholder = "What's this stream about? (optional)"; title.autocomplete = "off";
  const go = h("button", "btn primary block lv-go"); go.type = "submit"; go.append(h("span", "lv-dot"), "Go live");
  pre.append(title, go);
  const tools = h("div", "lv-tools");
  const flip = h("button", "lv-tool"); flip.type = "button"; flip.setAttribute("aria-label", "Flip the camera"); flip.append(ico("i-flip"));
  const mute = h("button", "lv-tool"); mute.type = "button"; mute.setAttribute("aria-label", "Microphone off"); mute.append(ico("i-mic"));
  tools.append(flip, mute);
  ui.root.append(pre, tools);
  let flipping = false;
  const useTrack = (t) => {
    widest(t);
    media = new MediaStream([t, ...media.getAudioTracks()]);
    ui.vA.srcObject = media; ui.vA.play().catch(() => {});
    ui.vA.classList.toggle("mirror", facing === "user");
  };
  flip.onclick = async () => {
    if (flipping) return;
    flipping = true; flip.disabled = true;
    const want = facing === "user" ? "environment" : "user", wasLive = !!(v.id && alive && rec);
    // (the recording: finished; a new one starts with the other camera, and everyone watching starts it with it)
    const was = rec; rec = null; gen++;
    if (was && was.state !== "inactive") await new Promise((r) => { was.addEventListener("stop", r, { once: true }); try { was.stop(); } catch { r(); } setTimeout(r, 1500); });
    for (const t of media.getVideoTracks()) t.stop();
    try { const n = await camFacing(want); facing = want; useTrack(n.getVideoTracks()[0]); }
    catch {
      // (the other one wouldn't open: the one before, again)
      try { const n = await camFacing(facing).catch(() => navigator.mediaDevices.getUserMedia({ video: { ...VIDEO, facingMode: facing } })); useTrack(n.getVideoTracks()[0]); } catch {}
      toast(want === "environment" ? "Couldn't open the back camera." : "Couldn't open the front camera.", 2500);
    }
    if (wasLive && alive) record();
    flipping = false; flip.disabled = false;
  };
  mute.onclick = () => { mic = !mic; for (const t of media.getAudioTracks()) t.enabled = mic; mute.classList.toggle("off", !mic); mute.setAttribute("aria-label", mic ? "Microphone off" : "Microphone on"); toast(mic ? "Microphone on" : "Microphone off", 1200); };
  let rec = null, key = "", gen = 0, alive = true, clockT = 0, watchT = 0, behind = false;
  const closeAll = async (end) => {
    alive = false; gen++; clearInterval(clockT); clearInterval(watchT);
    try { if (rec && rec.state !== "inactive") rec.stop(); } catch {}
    for (const t of media.getTracks()) t.stop();
    if (end && v.id) await hubStreamEnd(v.id, key);
    if (v.id) liveSend({ t: "unwatch" });
    keepAwake(false);
    if (L.view === v) L.view = null;
    ui.root.classList.remove("in"); setTimeout(() => ui.root.remove(), 220);
  };
  v.close = (quiet) => { if (L.view !== v) return; closeAll(true); if (!quiet) dropLayer("live"); };
  ui.x.onclick = () => { if (!v.id || confirm("End your live stream?")) v.close(); };
  pushLayer("live", () => v.close(true));
  v.on = (m) => onStreamMessage(v, ui, m);
  v.remove = (id) => liveSend({ t: "unsay", s: v.id, id });
  wireTalk(ui, v);

  // the recording: one, continuous; every quarter second its newest slice goes up the live connection
  const mp4 = /mp4/.test(type);
  const record = () => {
    if (!alive || !v.id) return;
    const g = ++gen, split = splitter(mp4);
    let at = 0, chain = Promise.resolve(), told = false;
    let r;
    try { r = new MediaRecorder(media, { mimeType: type, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 128_000, videoKeyFrameIntervalDuration: 1000 }); }
    catch { r = new MediaRecorder(media, { mimeType: type, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 128_000 }); }
    r.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      chain = chain.then(async () => {
        if (g !== gen || !alive) return;
        const bytes = new Uint8Array(await e.data.arrayBuffer());
        const joins = split.push(bytes, at);
        const head = { t: "up", s: v.id, k: key, g, a: at };
        if (joins.length) head.j = joins;
        if (!told && split.init) { head.type = kindOf(split.init, r.mimeType || type, mp4); told = true; }
        at += bytes.length;
        const hb = new TextEncoder().encode(JSON.stringify(head)), f = new Uint8Array(4 + hb.length + bytes.length);
        new DataView(f.buffer).setUint32(0, hb.length); f.set(hb, 4); f.set(bytes, 4 + hb.length);
        // (not sent: the connection's down, or can't keep up. The recording starts again once it's back, so viewers get
        // a clean start rather than a broken stream)
        if (!liveSendBin(f.buffer)) { behind = true; ui.badge.classList.add("weak"); }
      });
    };
    r.onerror = () => { if (g === gen && alive) { toast("The camera stopped. Starting again…", 2500); setTimeout(restart, 500); } };
    r.start(250); rec = r; window.__liveRecAt = Date.now();
    // (a phone whose recording has nowhere to start watching from can't stream: said, once)
    setTimeout(() => { if (g === gen && alive && !split.joins) toast("This phone's browser can't stream live. Try Chrome.", 5000); }, 7000);
  };
  const restart = () => {
    if (!alive || !v.id) return;
    const was = rec; rec = null; gen++;
    try { if (was && was.state !== "inactive") was.stop(); } catch {}
    behind = false; ui.badge.classList.remove("weak");
    record();
  };
  // the connection: back (or caught up) after slices were lost: a fresh start
  watchT = setInterval(() => { if (alive && v.id && behind && live.on && liveBacklog() < 200e3) restart(); }, 700);
  addEventListener("hub:open", () => { if (alive && v.id && L.view === v) { liveSend({ t: "watch", s: v.id }); restart(); } });
  // the server lost the stream (an update, say): the same person, a new stream
  v.lost = async (sid) => {
    if (!alive || sid !== v.id) return;
    try { const r2 = await hubStreamStart(s.title); v.id = r2.id; key = r2.key; liveSend({ t: "watch", s: v.id }); restart(); } catch {}
  };
  pre.onsubmit = async (e) => {
    e.preventDefault();
    const t = title.value.replace(/\s+/g, " ").trim();
    if (t && offensive(t)) { toast(OFFENSIVE, 3500); return; }
    go.disabled = true; go.lastChild.textContent = "Going live…";
    try {
      const r = await hubStreamStart(t);
      v.id = r.id; key = r.key; s.at = r.at || Date.now(); s.title = t;
    } catch (err) { go.disabled = false; go.lastChild.textContent = "Go live"; toast(err.message, 3500); return; }
    pre.remove();
    ui.badge.textContent = "LIVE"; ui.badge.classList.remove("off");
    ui.who.querySelector(".lv-title").textContent = t;
    ui.bar.hidden = false;
    ui.x.firstChild.textContent = "End";
    keepAwake(true);
    const join = () => { if (L.view === v && v.id) liveSend({ t: "watch", s: v.id }); };
    addEventListener("hub:open", join);
    join();
    clockT = setInterval(() => { ui.clock.textContent = since(s.at); }, 1000);
    record();
  };
}
