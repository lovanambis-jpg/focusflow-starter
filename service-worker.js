const CACHE = "focusflow-shell-v9";
const FILES = ["./", "./index.html", "./assets/style.css", "./assets/app.js", "./assets/db.js", "./assets/sync.js", "./assets/auth.js", "./assets/config.js", "./manifest.webmanifest", "./assets/icons/icon-192.png", "./assets/icons/icon-512.png"];
self.addEventListener("install", event => { self.skipWaiting(); event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(url => new Request(url, { cache: "reload" }))))); });
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));

// Network first, cache as the offline fallback. { cache: "no-cache" } makes the browser revalidate with the server,
// so edits such as assets/config.js show up on the next normal reload (the browser HTTP cache can otherwise serve old copies).
// URLs with a query string (for example the OAuth redirect ?code=...) are never stored in the cache.
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req, { cache: "no-cache" }), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))]);
    if (res.ok && !new URL(req.url).search) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === "navigate") { const shell = await cache.match("./index.html"); if (shell) return shell; }
    return Response.error();
  }
}
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  event.respondWith(networkFirst(req));
});
