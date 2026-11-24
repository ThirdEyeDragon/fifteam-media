// FifTeam Media's service worker: the app works offline, and audio files shared to it from other apps (Android) land in
// its inbox. Bump VERSION whenever the app's files change.
const VERSION = "fifteam-v28";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/app.css",
  "js/app.js", "js/ui.js", "js/store.js", "js/tags.js", "js/tilt.js", "js/player.js", "js/library.js",
  "js/rebass.js", "js/rebass-worker.js", "js/tones.js", "js/export.js", "js/dsp.js", "js/mp3-worker.js",
  "js/knob.js", "js/eq.js", "js/image.js", "js/limiter-worklet.js", "js/settings.js", "js/demo.js", "js/bassline.js", "js/share.js",
  "js/demucs.js", "js/social.js", "js/dms.js", "js/activity.js", "js/meta.js", "js/device.js", "js/ban.js", "js/profile.js", "js/categories.js", "js/limiter.js", "js/separator.js", "js/sep-worker.js", "js/stems.js", "vendor/ort/ort.webgpu.min.mjs", "vendor/ort/ort-wasm-simd-threaded.asyncify.mjs",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  // straight from the server (not the browser's cache), so a new version is really new
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== "fifteam-runtime" && k !== MEDIA && k !== "fifteam-flags" && !k.startsWith("fifteam-sep")).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// the same database the app uses (keep in step with js/store.js)
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("fifteam-media", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of ["tracks", "blobs", "art"]) if (!db.objectStoreNames.contains(s)) s === "tracks" ? db.createObjectStore(s, { keyPath: "id" }) : db.createObjectStore(s);
      if (!db.objectStoreNames.contains("inbox")) db.createObjectStore("inbox", { autoIncrement: true });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

// the app's own pages and scripts are served "cross-origin isolated" (GitHub Pages can't send these headers itself):
// that lets the bass separator use several processor cores on a phone with no usable graphics chip. "credentialless"
// still lets the fonts and the MP3 encoder load from their sites (browsers that don't know it simply ignore it).
function isolated(r) {
  if (!r || r.type === "opaque" || r.type === "opaqueredirect" || !r.status) return r;
  const h = new Headers(r.headers);
  h.set("Cross-Origin-Embedder-Policy", "credentialless");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

// a tap on a message notification: the app, at that conversation
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const dm = e.notification.data && e.notification.data.dm;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find((c) => c.url.startsWith(self.registration.scope)) || wins[0];
    if (w) { try { await w.focus(); } catch {} w.postMessage({ type: "open-dm", dm }); return; }
    await self.clients.openWindow(self.registration.scope + (dm ? "?dm=" + encodeURIComponent(dm) : "") + "#social");
  })());
});

const MEDIA = "fifteam-media-pics";
let mediaPuts = 0;
/** At most 600 pictures kept (the oldest go first). */
async function trimMedia(c) { const keys = await c.keys(); for (const k of keys.slice(0, Math.max(0, keys.length - 600))) await c.delete(k); }
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const files = form.getAll("audio").filter((f) => f && f.size);
        if (files.length) {
          const db = await openDB();
          await new Promise((res, rej) => {
            const t = db.transaction("inbox", "readwrite");
            files.forEach((f) => t.objectStore("inbox").add(f));
            t.oncomplete = res; t.onerror = () => rej(t.error);
          });
        }
      } catch {}
      return Response.redirect(new URL("./?shared=1#rebass", self.registration.scope).href, 303);
    })());
    return;
  }
  if (req.method !== "GET") return;
  if (url.origin === location.origin) {
    // the bass separator's big files (about 51 MB): the rebass worker downloads them once and keeps them itself
    if (/\/models\/|\.wasm(\.gz)?$/.test(url.pathname)) return;
    // FifTeam Social's settings: always the latest
    if (/\/social\//.test(url.pathname)) return;
    // the app's own files: from the cache at once, refreshed in the background
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      return isolated(hit || (await net) || (await c.match("index.html")));
    }));
  } else if (url.host === "cdn.discordapp.com" && /\.(jpe?g|png|webp|gif)$/i.test(url.pathname)) {
    // Social's pictures (posts, profile pictures, covers, video stills): kept on the phone, so a picture seen once shows at
    // once after that. A file's address changes each time its link is renewed, but its path doesn't: that's the key.
    const key = url.origin + url.pathname;
    e.respondWith(caches.open(MEDIA).then(async (c) => {
      const hit = await c.match(key);
      if (hit) return hit;
      const r = await fetch(req.url, { mode: "cors", credentials: "omit" });
      if (r.ok) { await c.put(key, r.clone()); if (++mediaPuts % 40 === 0) trimMedia(c); }
      return r;
    }).catch(() => fetch(req)));
  } else if (/fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(url.host)) {
    // fonts and the MP3 encoder: kept after the first use, so they work offline too
    e.respondWith(caches.open("fifteam-runtime").then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === "opaque") c.put(req, r.clone());
      return r;
    }));
  }
});
