/* Lets the site install as an app and open even when the connection drops.
   Pages and scripts: network first, so you always get the newest version, with the last good copy as a fallback.
   Anything from the database or other sites is never stored. */
const CACHE = "inventory-space-v1";
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(fetch(r).then(res => { if (res.ok && !u.pathname.includes("/models/")) { const c = res.clone(); caches.open(CACHE).then(k => k.put(r, c)); } return res; })
    .catch(() => caches.match(r).then(m => m || (r.mode === "navigate" ? caches.match("./") || caches.match("index.html") : Response.error()))));
});
