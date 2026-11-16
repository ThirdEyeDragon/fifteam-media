// The music player: one <audio> element (so it keeps playing with the screen off and shows on the lock screen), a queue,
// shuffle and repeat, the now-playing screen with the tilting cover, and the mini player above the tabs.
import * as store from "./store.js";
import { $, fmtTime, fill, artUrl, placeholderArt, bus, toast, marquee } from "./ui.js";
import { makeTilt } from "./tilt.js";
import { makeKnob } from "./knob.js";
import { eq, describe } from "./eq.js";

const audio = new Audio();
audio.preload = "auto";
const P = { tracks: new Map(), queue: [], order: [], pos: -1, shuffle: false, repeat: "off", cur: null, url: null, seeking: false };

export const player = {
  get current() { return P.cur; },
  get audio() { return audio; },
  get playing() { return !audio.paused; },
  pause() { audio.pause(); },
  setTracks(list) { P.tracks = new Map(list.map((t) => [t.id, t])); },
  /** Play `id`, with `ids` as the queue around it. */
  async playFrom(ids, id) {
    P.queue = ids.slice();
    buildOrder(id);
    await load(id, true);
  },
  toggle() {
    if (!P.cur) return;
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  },
  next(auto = false) {
    if (!P.order.length) return;
    if (auto && P.repeat === "one") { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    let i = P.pos + 1;
    if (i >= P.order.length) { if (P.repeat === "all" || !auto) i = 0; else { audio.pause(); audio.currentTime = 0; return; } }
    P.pos = i; load(P.order[i], true);
  },
  prev() {
    if (!P.order.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    P.pos = (P.pos - 1 + P.order.length) % P.order.length;
    load(P.order[P.pos], true);
  },
  upNext() { return P.order.slice(P.pos + 1).concat(P.repeat === "all" ? P.order.slice(0, P.pos) : []).map((id) => P.tracks.get(id)).filter(Boolean); },
  playNext(id) {
    if (!P.cur) { this.playFrom([id], id); return; }
    const j = P.order.indexOf(id); if (j >= 0 && j !== P.pos) { P.order.splice(j, 1); if (j < P.pos) P.pos--; }
    P.order.splice(P.pos + 1, 0, id);
    if (!P.queue.includes(id)) P.queue.push(id);
  },
  forget(id) {
    const j = P.order.indexOf(id);
    if (j >= 0) { P.order.splice(j, 1); if (j < P.pos) P.pos--; }
    P.queue = P.queue.filter((x) => x !== id);
    if (P.cur && P.cur.id === id) { audio.pause(); audio.removeAttribute("src"); P.cur = null; render(); }
  },
};

function buildOrder(startId) {
  if (P.shuffle) {
    const rest = P.queue.filter((x) => x !== startId);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    P.order = [startId, ...rest]; P.pos = 0;
  } else { P.order = P.queue.slice(); P.pos = Math.max(0, P.order.indexOf(startId)); }
}

async function load(id, autoplay) {
  const t = P.tracks.get(id);
  if (!t) return;
  const blob = await store.getBlob(id);
  if (!blob) { toast("That song's audio is missing. Add it again from your files."); return; }
  if (P.url) URL.revokeObjectURL(P.url);
  P.url = URL.createObjectURL(blob);
  P.cur = t;
  audio.src = P.url;
  render();
  bus.emit("now", t);
  if (autoplay) audio.play().catch(() => toast("Tap play to start"));
}

async function coverFor(t) {
  if (!t) return placeholderArt("FifTeam", "song");
  if (t.hasArt) { const b = await store.getArt(t.id); const u = artUrl(t.id, b); if (u) return u; }
  return placeholderArt(t.title, t.kind || "song");
}

let tilt;
async function render() {
  const t = P.cur;
  marquee($("np-title"), t ? t.title : "Nothing playing");
  marquee($("np-artist"), t ? (t.artist || "Unknown artist") : "Add songs in your library to start");
  const cover = await coverFor(t);
  $("art-img").src = cover;
  $("art-glow").style.backgroundImage = `url("${cover}")`;
  const amb = $("ambient");
  amb.style.backgroundImage = `url("${cover}")`;
  amb.classList.toggle("on", !!t);
  $("mini").classList.toggle("hide", !t || location.hash === "#player" || location.hash === "");
  if (t) {
    $("mini-thumb").style.backgroundImage = `url("${cover}")`;
    marquee($("mini-t"), t.title); $("mini-a").textContent = t.artist || "Unknown artist";
  }
  $("np-rebass").hidden = !t || t.kind === "tone";
  if ("mediaSession" in navigator && t) {
    const album = t.album || (t.kind === "rebass" ? "Rebassed" : t.kind === "tone" ? "Tones" : "FifTeam Media");
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || "FifTeam Media", album, artwork: [{ src: cover, sizes: "512x512" }] });
    // then the cover as proper square images in the sizes lock screens, car screens and watches ask for
    const art = await sessionArtwork(t.id, cover);
    if (P.cur === t && art.length) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || "FifTeam Media", album, artwork: art });
  }
}

// the cover for the system's "now playing" (lock screen, Bluetooth car stereos, CarPlay): square JPEGs, six sizes
let artCache = { id: null, list: [] };
async function sessionArtwork(id, src) {
  if (artCache.id === id) return artCache.list;
  for (const a of artCache.list) URL.revokeObjectURL(a.src);
  artCache = { id, list: [] };
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
    const s = Math.min(img.naturalWidth, img.naturalHeight), sx = (img.naturalWidth - s) / 2, sy = (img.naturalHeight - s) / 2;
    const list = [];
    for (const size of [96, 128, 192, 256, 384, 512]) {
      const c = document.createElement("canvas"); c.width = c.height = size;
      const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, sx, sy, s, s, 0, 0, size, size);
      const b = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.9));
      if (b) list.push({ src: URL.createObjectURL(b), sizes: `${size}x${size}`, type: "image/jpeg" });
    }
    if (artCache.id === id) artCache.list = list; else list.forEach((a) => URL.revokeObjectURL(a.src));
    return list;
  } catch { return []; }
}

function setPlayIcons() {
  const icon = audio.paused ? "#i-play" : "#i-pause";
  for (const id of ["np-play", "mini-play"]) {
    const b = $(id); b.querySelector("use").setAttribute("href", icon);
    b.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  }
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
}

export function initPlayer() {
  tilt = makeTilt({ stage: $("art-stage"), art: $("art"), img: $("art-img"), glow: $("art-glow"), sheen: $("art-sheen") });
  const mb = $("np-motion");
  mb.onclick = async () => { const ok = await tilt.enable(); mb.hidden = ok; toast(ok ? "Tilt your phone" : "Motion access is off. Allow it in Settings, Apps, Safari, Motion & Orientation Access."); };
  let askT = 0;
  bus.on("view", (v) => {
    if (v === "player") {
      tilt.start();
      // offer the switch only to a phone that needs asking (an iPhone): others send motion on their own
      clearTimeout(askT); askT = setTimeout(() => { mb.hidden = !tilt.needsPermission || !matchMedia("(pointer: coarse)").matches; }, 1500);
    } else tilt.stop();
    $("mini").classList.toggle("hide", !P.cur || v === "player");
  });

  // the tone knobs: BASS, MIDS, HIGHS, 0 (that band off) to 10 (loudest), 5 the song as it is
  eq.attach(audio);
  const sub = describe;
  for (const [id, band, label] of [["kn-bass", "bass", "Bass"], ["kn-mids", "mids", "Mids"], ["kn-highs", "highs", "Highs"]])
    makeKnob($(id), { label, value: eq.values[band], sub, onInput: (v) => eq.set(band, v) });
  audio.addEventListener("play", () => eq.engageIfNeeded());
  bus.on("art", (id) => { if (P.cur && P.cur.id === id) { artCache.id = null; render(); } });

  $("np-play").onclick = () => { if (!P.cur) { location.hash = "#library"; return; } player.toggle(); };
  $("mini-play").onclick = (e) => { e.stopPropagation(); player.toggle(); };
  $("mini-next").onclick = (e) => { e.stopPropagation(); player.next(); };
  $("mini").onclick = () => { location.hash = "#player"; };
  $("np-next").onclick = () => player.next();
  $("np-prev").onclick = () => player.prev();
  $("np-shuffle").onclick = () => {
    P.shuffle = !P.shuffle; $("np-shuffle").classList.toggle("on", P.shuffle);
    if (P.cur) buildOrder(P.cur.id);
    toast(P.shuffle ? "Shuffle on" : "Shuffle off", 1500);
  };
  $("np-repeat").onclick = () => {
    P.repeat = P.repeat === "off" ? "all" : P.repeat === "all" ? "one" : "off";
    const b = $("np-repeat"); b.classList.toggle("on", P.repeat !== "off");
    b.querySelector("use").setAttribute("href", P.repeat === "one" ? "#i-repeat1" : "#i-repeat");
    toast(P.repeat === "off" ? "Repeat off" : P.repeat === "all" ? "Repeat all" : "Repeat this song", 1500);
  };
  $("np-rebass").onclick = () => { if (P.cur) bus.emit("rebass", P.cur); };
  $("np-queue").onclick = () => bus.emit("queue");

  const seek = $("np-seek");
  seek.addEventListener("input", () => { P.seeking = true; fill(seek); $("np-cur").textContent = fmtTime((seek.value / 1000) * (audio.duration || 0)); });
  seek.addEventListener("change", () => { if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration; P.seeking = false; });
  audio.addEventListener("timeupdate", () => {
    const d = audio.duration || 0;
    if (!P.seeking && d) { seek.value = Math.round((audio.currentTime / d) * 1000); fill(seek); $("np-cur").textContent = fmtTime(audio.currentTime); }
    $("mini-bar").style.width = d ? `${(audio.currentTime / d) * 100}%` : "0";
    if ("mediaSession" in navigator && d && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: 1 }); } catch {}
    }
  });
  audio.addEventListener("loadedmetadata", () => { $("np-dur").textContent = fmtTime(audio.duration); });
  audio.addEventListener("play", setPlayIcons);
  audio.addEventListener("pause", setPlayIcons);
  audio.addEventListener("ended", () => player.next(true));
  audio.addEventListener("play", () => bus.emit("music-playing"));
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    const h = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
    h("play", () => audio.play()); h("pause", () => audio.pause());
    h("stop", () => { audio.pause(); audio.currentTime = 0; });
    h("nexttrack", () => player.next()); h("previoustrack", () => player.prev());
    h("seekto", (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
    h("seekbackward", (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
    h("seekforward", (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
  }
  render();
  setPlayIcons();
}
