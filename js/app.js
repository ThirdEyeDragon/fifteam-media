// FifTeam Media: wiring the screens together.
import { $, bus, toast } from "./ui.js";
import { player } from "./player.js";

export const APP_VERSION = "1.1";
import * as store from "./store.js";
import { initPlayer } from "./player.js";
import { initLibrary, library, importFiles } from "./library.js";
import { initRebass, rebass } from "./rebass.js";
import { initTones } from "./tones.js";

const VIEWS = ["player", "library", "rebass", "tones"];
function route() {
  let v = location.hash.slice(1);
  if (!VIEWS.includes(v)) v = "player";
  for (const k of VIEWS) $("view-" + k).classList.toggle("active", k === v);
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.v === v));
  bus.emit("view", v);
}

async function boot() {
  initPlayer();
  initLibrary();
  initRebass();
  initTones();
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
  // send the app to a friend: the share sheet where there is one, else the link copied
  $("btn-share-app").onclick = async () => {
    const url = location.origin + location.pathname;
    const data = { title: "FifTeam Media", text: "FifTeam Media: a music player, rebass studio and tone generator. Open it and add it to your home screen.", url };
    try { if (navigator.share) { await navigator.share(data); return; } } catch (e) { if (e && e.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(url); toast("Link copied. Send it to your friends."); }
    catch { toast(url, 8000); }
  };
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
