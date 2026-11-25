/* Service worker: aplikace funguje i bez internetu. Při připojení si stáhne novou verzi. */
const CACHE = "cashtracker-fafd8782ee";
const FILES = ["./", "app.js", "backend.js", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "index.html", "manifest.webmanifest", "mobile.js", "style.css", "vendor/sql-wasm.js", "vendor/sql-wasm.wasm"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;               // vše je v cache – rychlé a offline
    try { return await fetch(req); }
    catch { return (await caches.match("./index.html")) || Response.error(); }
  })());
});
