// Live streams in Social. The people the FifTeam team lets (/allow streaming) can go live with the phone's camera; anyone
// can watch, chat and send likes (hearts), and sees how many are watching.
//   Going live: the camera is recorded in pieces of about two seconds, each one a whole little video (a new recorder
// starts just before the last one stops, so nothing is lost between them), and each is sent to the FifTeam server.
//   Watching: the server says at once when a new piece is in (on the app's live connection); the piece is fetched and
// played straight after the last one. Where the phone can (Android, computers), the pieces are joined into one video
// as they come (Media Source), so it plays without a break; otherwise (iPhone) two players take turns, the next piece
// ready in one while the other plays. It stays close to live: if it falls behind, it catches up.
//   Chat and likes go round on the live connection; the streamer can take a chat message down (hold it).
import { toast, pushLayer, dropLayer } from "./ui.js";
import { hubStreamStart, hubStreamSeg, hubStreamGet, hubStreamEnd, hubStreams, liveSend, live, startLive } from "./hub.js";
import { offensive, OFFENSIVE } from "./filter.js";
import { isStreamer } from "./ban.js";

const SEG_MS = 2000;
const L = { list: [], h: null };
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ico = (id) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + id); s.append(u); return s; };
const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e4 ? Math.round(n / 1e3) + "K" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n));
const since = (t) => { const s = Math.max(0, Math.floor((Date.now() - t) / 1000)); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`; };

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
    if (v && m.s === v.id) v.on(m);
    else if (v && m.t === "end" && v.id === m.s) v.on(m);
  });
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
  // (watching a stream that's gone, but the same person is live again: that one)
  const v = L.view;
  if (v && !v.mine && !clean.some((s) => s.id === v.id)) { const again = clean.find((s) => s.by === v.by); if (again) v.switchTo(again); }
}
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
  row.append(nm, h("span", "", " " + c.text));
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
    if (!v.mine) v.player.start(m.segs || []);
  } else if (m.t === "chat") chatLine(ui, m.m, v.mine, v.remove);
  else if (m.t === "unsay") ui.chat.querySelector(`.lv-msg[data-id="${CSS.escape(m.id)}"]`)?.remove();
  else if (m.t === "like") {
    v.likes = m.n; ui.like.querySelector(".lv-likes").textContent = fmtN(m.n);
    if (m.by !== L.h.me()) { const now = Date.now(); if (now - (v.heartAt || 0) > 140) { v.heartAt = now; heart(ui, false); } }
  } else if (m.t === "viewers") ui.eye.lastChild.textContent = fmtN(m.n);
  else if (m.t === "seg" && !v.mine) v.player.add(m);
  else if (m.t === "end" && !v.mine) v.ended();
  else if (m.t === "end" && v.mine) { toast("Your stream has ended.", 3000); v.close(); }
}
/** Sound wasn't allowed to start by itself: playing muted, with a button to turn it on. */
function soundHint(ui, P) {
  if (ui.root.querySelector(".lv-sound")) return;
  const b = h("button", "lv-sound"); b.type = "button"; b.append(ico("i-mute"), h("span", "", "Tap for sound"));
  b.onclick = () => { P.muted = false; for (const el of [ui.vA, ui.vB]) { el.muted = false; if (el.classList.contains("on") && el.paused && el.src) el.play().catch(() => {}); } b.remove(); };
  ui.root.append(b);
}
let wake = null;
const keepAwake = async (on) => { try { if (on && "wakeLock" in navigator && !wake) wake = await navigator.wakeLock.request("screen"); else if (!on && wake) { await wake.release(); wake = null; } } catch {} };

// ---------------------------------------------------------------------------------------------------- watching
/** Watch someone's stream. */
export function watch(s) {
  if (L.view) L.view.close(true);
  const ui = screen(s, false);
  const v = { id: s.id, by: s.by, mine: false, likes: s.likes };
  L.view = v;
  v.player = player(ui, () => { ui.wait.hidden = true; }, () => { ui.wait.hidden = false; ui.wait.lastChild.textContent = "Catching up…"; });
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
    removeEventListener("hub:open", onOpen);
    clearInterval(tick); v.player.stop(); keepAwake(false);
    ui.root.classList.remove("in"); setTimeout(() => ui.root.remove(), 220);
    if (!quiet) dropLayer("live");
  };
  ui.x.onclick = () => v.close();
  pushLayer("live", () => v.close(true));
  // (a tap is the first gesture: both players unlocked for sound on iPhone)
  const unlock = () => { for (const el of [ui.vA, ui.vB]) { if (el.paused && !el.src) { el.muted = true; el.play().catch(() => {}); el.pause(); el.muted = false; } } };
  ui.root.addEventListener("pointerdown", unlock, { once: true });
}

/** The player: pieces in order, joined into one video where it can (Media Source), otherwise two players taking turns.
 * onPlay: playing; onStall: waiting for the next piece. */
function player(ui, onPlay, onStall) {
  const P = { next: -1, busy: false, queue: [], stopped: false, mode: null };
  const want = (n) => n > P.next;
  // fetch pieces in order (each one once), as they're announced
  async function pump() {
    if (P.busy || P.stopped) return;
    P.busy = true;
    try {
      while (P.queue.length && !P.stopped) {
        const g = P.queue.shift();
        if (!want(g.n)) continue;
        let blob = null;
        try { blob = await hubStreamGet(currentId(), g.n); } catch {}
        if (P.stopped) return;
        P.next = g.n;
        if (blob && blob.size) await feed(blob, g.type || blob.type, g.dur);
      }
    } finally { P.busy = false; }
  }
  const currentId = () => (L.view ? L.view.id : "");
  // --- one video, the pieces joined (Media Source, "sequence": each piece straight after the last)
  let ms = null, sb = null, appendQ = [], mime = "";
  const MSE = window.MediaSource;
  function useMse(type) { return !!(MSE && /webm/.test(type) && MSE.isTypeSupported(type)); }
  function openMse(type) {
    mime = type; ms = new MSE();
    ui.vA.src = URL.createObjectURL(ms);
    return new Promise((res) => ms.addEventListener("sourceopen", () => {
      try { sb = ms.addSourceBuffer(type); sb.mode = "sequence"; sb.addEventListener("updateend", drain); } catch { sb = null; }
      res();
    }, { once: true }));
  }
  function drain() {
    if (!sb || sb.updating || !appendQ.length) return;
    // (keep the last half minute; and stay close to live: more than 6 s behind, jump ahead)
    const v = ui.vA, b = sb.buffered;
    try {
      if (b.length && v.currentTime - b.start(0) > 30) { sb.remove(b.start(0), v.currentTime - 10); return; }
    } catch {}
    try { sb.appendBuffer(appendQ.shift()); } catch (e) { if (e.name === "QuotaExceededError") { appendQ.length = 0; } }
  }
  function chase() {
    const v = ui.vA; if (!sb) return;
    try {
      const b = sb.buffered; if (!b.length) return;
      const end = b.end(b.length - 1);
      if (end - v.currentTime > 6) v.currentTime = end - 1.6;
      if (v.paused && end - v.currentTime > 0.4) v.play().then(onPlay, () => { P.muted = true; v.muted = true; soundHint(ui, P); v.play().then(onPlay, () => {}); });
    } catch {}
  }
  // --- two players taking turns (each piece its own little video)
  const ready = [];        // blob URLs waiting
  let cur = ui.vA, other = ui.vB, waiting = true;
  function turnFeed(url) {
    ready.push(url);
    while (ready.length > 4) URL.revokeObjectURL(ready.shift());       // (too far behind: catch up)
    if (waiting) playNext();
    else if (!other.src || other.dataset.loaded !== "1") preload();
  }
  function preload() {
    if (!ready.length) return;
    const url = ready.shift();
    other.dataset.loaded = "1"; other.src = url; other.load();
  }
  function playNext() {
    if (other.dataset.loaded !== "1") { if (!ready.length) { waiting = true; onStall(); return; } preload(); }
    const was = cur; cur = other; other = was;
    cur.classList.add("on"); other.classList.remove("on");
    cur.dataset.loaded = ""; waiting = false;
    cur.muted = !!P.muted;
    cur.play().then(onPlay, () => { P.muted = true; cur.muted = true; soundHint(ui, P); cur.play().then(onPlay, () => {}); });
    try { other.pause(); if (other.src) URL.revokeObjectURL(other.src); } catch {}
    other.removeAttribute("src"); other.dataset.loaded = "";
    preload();
  }
  for (const el of [ui.vA, ui.vB]) {
    el.addEventListener("ended", () => { if (P.mode === "turns" && el === cur) playNext(); });
    // (a piece with a known length: the next one starts a hair before this one's last frame, so there's no gap)
    el.addEventListener("timeupdate", () => { if (P.mode === "turns" && el === cur && isFinite(el.duration) && el.duration - el.currentTime < 0.06 && other.dataset.loaded === "1") playNext(); });
  }
  async function feed(blob, type, dur) {
    if (!P.mode) P.mode = useMse(type) ? "mse" : "turns";
    if (P.mode === "mse") {
      if (!ms) await openMse(type);
      if (!sb) { P.mode = "turns"; ui.vA.removeAttribute("src"); return feed(blob, type, dur); }
      appendQ.push(await blob.arrayBuffer());
      drain();
      setTimeout(chase, 120);
    } else turnFeed(URL.createObjectURL(blob));
  }
  ui.vA.addEventListener("waiting", () => { if (P.mode === "mse") onStall(); });
  ui.vA.addEventListener("playing", () => onPlay());
  return {
    /** Joining: start from the second-latest piece (a piece in hand while the next comes). */
    start(segs) { const list = segs.slice(-2); if (list.length) { P.next = Math.min(P.next, list[0].n - 1); for (const g of list) P.queue.push(g); pump(); } },
    add(g) { if (want(g.n)) { P.queue.push(g); P.queue.sort((a, b) => a.n - b.n); pump(); } },
    reset() { P.next = -1; P.queue = []; },
    stop() {
      P.stopped = true;
      for (const el of [ui.vA, ui.vB]) { try { el.pause(); } catch {} }
      try { if (ms && ms.readyState === "open") ms.endOfStream(); } catch {}
      for (const u of ready) URL.revokeObjectURL(u);
    },
  };
}

// ---------------------------------------------------------------------------------------------------- going live
const TYPES = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"];
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
    // (the piece being recorded: finished and sent as it is; the next starts with the other camera)
    clearTimeout(tick);
    const was = rec; rec = null;
    if (was && was.state !== "inactive") { try { was.stop(); } catch {} }
    await new Promise((r) => setTimeout(r, 60));
    for (const t of media.getVideoTracks()) t.stop();
    try { const n = await camFacing(want); facing = want; useTrack(n.getVideoTracks()[0]); }
    catch {
      // (the other one wouldn't open: the one before, again)
      try { const n = await camFacing(facing).catch(() => navigator.mediaDevices.getUserMedia({ video: { ...VIDEO, facingMode: facing } })); useTrack(n.getVideoTracks()[0]); } catch {}
      toast(want === "environment" ? "Couldn't open the back camera." : "Couldn't open the front camera.", 2500);
    }
    if (wasLive && alive) piece();
    flipping = false; flip.disabled = false;
  };
  mute.onclick = () => { mic = !mic; for (const t of media.getAudioTracks()) t.enabled = mic; mute.classList.toggle("off", !mic); mute.setAttribute("aria-label", mic ? "Microphone off" : "Microphone on"); toast(mic ? "Microphone on" : "Microphone off", 1200); };
  let rec = null, key = "", n = 0, sending = Promise.resolve(), backlog = 0, alive = true, tick = 0, clockT = 0;
  const closeAll = async (end) => {
    alive = false; clearTimeout(tick); clearInterval(clockT);
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

  // one piece: a recorder for about two seconds; the next one starts a moment before this one stops
  const piece = () => {
    if (!alive) return;
    const r = new MediaRecorder(media, { mimeType: type, videoBitsPerSecond: 1_100_000, audioBitsPerSecond: 96_000 });
    const chunks = [], t0 = performance.now();
    r.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    r.onstop = () => { const blob = new Blob(chunks, { type: r.mimeType || type }); upload(blob, performance.now() - t0); };
    try { r.start(); } catch { toast("The camera stopped. Try going live again.", 3000); return; }
    const was = rec; rec = r;
    if (was && was.state !== "inactive") { try { was.stop(); } catch {} }
    tick = setTimeout(piece, SEG_MS);
  };
  const upload = (blob, dur) => {
    if (!blob.size || !alive) return;
    const my = n++;
    if (backlog > 3) return;                                 // (the connection can't keep up: skip a piece to stay live)
    backlog++;
    sending = sending.then(async () => {
      try {
        let ok = await hubStreamSeg(v.id, key, my, blob, dur);
        if (!ok && alive) {
          // (the server lost the stream, say after an update: carry on as the same person, a fresh stream)
          const r = await hubStreamStart(s.title); v.id = r.id; key = r.key; n = 1; liveSend({ t: "watch", s: v.id });
          ok = await hubStreamSeg(v.id, key, 0, blob, dur);
        }
        ui.badge.classList.toggle("weak", !ok);
      } catch { ui.badge.classList.add("weak"); }
      finally { backlog--; }
    });
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
    piece();
  };
}
