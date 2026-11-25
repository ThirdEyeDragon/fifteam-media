// FifTeam Media: wiring the screens together.
import { $, bus, toast, openLayers } from "./ui.js";
import { player } from "./player.js";

export const APP_VERSION = "2.17";
import * as store from "./store.js";
import { initPlayer } from "./player.js";
import { initLibrary, library, importFiles, openCode } from "./library.js";
import { initRebass, rebass, checkLight } from "./rebass.js";
import { initTones } from "./tones.js";
import { initSettings } from "./settings.js";
import { initPush } from "./push.js";
import { initPremium } from "./premium.js";
import { initDemo } from "./demo.js";
import { initSocial } from "./social.js";
import { initBan } from "./ban.js";
import { initAccount } from "./account.js";
import { initPresence } from "./meta.js";

const VIEWS = ["player", "library", "rebass", "social", "tones"];
function route() {
  // a link with a rebass code in it: open the code
  const code = /^#code=(FT1\.[A-Za-z0-9_-]+)/.exec(location.hash);
  if (code) { history.replaceState(null, "", location.pathname + "#library"); setTimeout(() => openCode(code[1]), 300); }
  let v = location.hash.slice(1);
  if (!VIEWS.includes(v)) v = "player";
  for (const k of VIEWS) $("view-" + k).classList.toggle("active", k === v);
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.v === v));
  bus.emit("view", v);
}

/** The top bar (the name, your picture, the bell, messages, settings) slides away while scrolling down, to show more of
 * the screen, and comes straight back at the smallest scroll up (or at the top). It sits over the screens, which keep
 * its height clear at their top. */
function topBar() {
  const top = document.querySelector(".top");
  if (!top) return;
  const fit = () => document.documentElement.style.setProperty("--top-h", top.offsetHeight + "px");
  fit();
  if ("ResizeObserver" in window) new ResizeObserver(fit).observe(top); else addEventListener("resize", fit);
  const last = new WeakMap();
  const show = (on) => top.classList.toggle("hide", !on);
  document.addEventListener("scroll", (e) => {
    const v = e.target;
    if (!(v instanceof Element) || !v.classList.contains("view") || !v.classList.contains("active")) return;
    const y = v.scrollTop, prev = last.has(v) ? last.get(v) : y;
    last.set(v, y);
    top.classList.toggle("solid", y > 4);
    if (y < 40) show(true);
    else if (y - prev > 4) show(false);
    else if (prev - y > 0.5) show(true);
  }, { capture: true, passive: true });
  bus.on("view", (name) => { show(true); const v = $("view-" + name); top.classList.toggle("solid", !!v && v.scrollTop > 4); });
}

/** Back with a swipe in from the left edge (the way an iPhone app goes back; Android's own back gesture and button work
 * too): the top layer closes (the full-screen viewer, then an open sheet), or with none open, the screen before. An
 * arrow follows the finger and goes once it's far enough. */
// (the screens moved through inside the app, so a swipe back never leaves it: going back to the one before pops one off)
const visited = [location.hash || "#player"];
let trail = 0;
function swipeBack() {
  addEventListener("hashchange", () => {
    const h = location.hash || "#player";
    if (visited.length > 1 && visited[visited.length - 2] === h) visited.pop(); else if (visited[visited.length - 1] !== h) visited.push(h);
    trail = visited.length - 1;
  });
  const arrow = document.createElement("div"); arrow.className = "swipe-back"; arrow.setAttribute("aria-hidden", "true"); arrow.textContent = "‹";
  document.body.appendChild(arrow);
  let x0 = null, y0 = 0, dx = 0, off = false;
  addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    x0 = e.touches.length === 1 && t.clientX < 24 && (openLayers() || trail > 0) ? t.clientX : null; y0 = t.clientY; dx = 0; off = false;
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (x0 == null) return;
    const t = e.touches[0]; dx = t.clientX - x0;
    if (Math.abs(t.clientY - y0) > 60 && dx < 40) { off = true; x0 = null; arrow.style.opacity = "0"; return; }
    const k = Math.max(0, Math.min(1, dx / 90));
    arrow.style.opacity = String(k); arrow.style.transform = `translate3d(${(k * 34 - 34).toFixed(1)}px, -50%, 0) scale(${(0.7 + k * 0.3).toFixed(2)})`;
    arrow.classList.toggle("go", dx > 70);
  }, { passive: true });
  const end = () => {
    if (x0 == null) return;
    const go = !off && dx > 70;
    x0 = null; arrow.style.opacity = "0"; arrow.classList.remove("go");
    if (go) history.back();
  };
  addEventListener("touchend", end); addEventListener("touchcancel", end);
}

async function boot() {
  // holding down anywhere (a picture, a link, a name): no copy, save or open menu; only where there's typing
  addEventListener("contextmenu", (e) => { if (!e.target.closest("input, textarea, [contenteditable], .selectable")) e.preventDefault(); });
  topBar();
  swipeBack();
  initBan();
  initAccount();          // (signed in, or the sign-in screen over everything until then)
  // (the download page offers "Open" rather than "Download" on a phone that has the app)
  try { if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) localStorage.setItem("fifteam-installed", "1"); } catch {}
  addEventListener("appinstalled", () => { try { localStorage.setItem("fifteam-installed", "1"); } catch {} });
  initPlayer();
  initLibrary();
  initRebass();
  checkLight(APP_VERSION);
  initTones();
  initSettings();
  initDemo();
  initSocial();
  initPresence();
  initPush();
  initPremium();
  await library.refresh().catch(() => toast("This browser is blocking storage, so songs won't be kept after you close the app."));
  addEventListener("hashchange", route);
  if (!location.hash) location.replace(library.songs().length ? "#player" : "#library");
  route();
  // files another app shared to FifTeam Media (Android's share sheet): into the library, and the first one onto the Rebass screen
  if (new URLSearchParams(location.search).has("shared")) {
    history.replaceState(null, "", location.pathname + location.hash);
    try {
      const files = (await store.takeInbox()).filter(Boolean);
      if (files.length) {
        await importFiles(files);
        location.hash = "#rebass";
        rebass.fromFile(files[0]);
      }
    } catch { toast("Couldn't open the shared file"); }
  }
  // updates: a new version installs itself in the background (checked on every open and every half hour); when it takes
  // over, the app refreshes into it at once, unless music is playing or a rebass is running (then: next time it opens)
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then((reg) => {
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    }).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      const busy = player.playing || !$("rb-busy").hidden;
      if (busy) { toast("FifTeam Media has an update. It switches over next time you open it.", 5000); return; }
      reloading = true; location.reload();
    });
  }
}
boot();
