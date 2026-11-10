// SAADAXA service worker — keeps the app usable offline.
//  * App files: cache first, refreshed in the background
//  * Map tiles: cache as you browse (so areas you have viewed work offline)
//  * API calls: always go to the network (never served stale)
const VERSION = "saadaxa-v2";
const SHELL = [
  "./", "index.html", "sos.html", "css/app.css", "manifest.webmanifest",
  "js/app.js", "js/api.js", "js/db.js", "js/ui.js", "js/location.js", "js/map.js",
  "js/recorder.js", "js/chat.js", "js/offline-guide.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "vendor/leaflet/leaflet.css", "vendor/leaflet/leaflet.js",
  "vendor/leaflet/images/layers.png", "vendor/leaflet/images/layers-2x.png",
];
const TILE_CACHE = "saadaxa-tiles";
const MAX_TILES = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) =>
    Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))
  ).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws") || url.pathname.startsWith("/media/")) return;

  const isTile = /tile\.openstreetmap\.org|arcgisonline\.com/.test(url.host);
  if (isTile) {
    e.respondWith(caches.open(TILE_CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") { c.put(req, res.clone()); trimTiles(); }
        return res;
      } catch {
        return new Response("", { status: 504 });
      }
    }));
    return;
  }

  // app shell: cache first, update in background
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(fresh); return hit; }
    const res = await fresh;
    if (res) return res;
    if (req.mode === "navigate") return (await c.match("index.html")) || new Response("Offline", { status: 503 });
    return new Response("", { status: 504 });
  }));
});
