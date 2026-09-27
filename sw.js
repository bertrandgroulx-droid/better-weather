/* Minimal self-updating service worker.
 *
 * Network-first for the app's OWN files (HTML, radar.js, manifest, icons): when
 * online it always loads the freshest version, so a pinned home-screen app keeps
 * itself up to date instead of showing a stale cached build. The last good copy is
 * kept as an offline fallback. External requests (weather/air/tiles/search) are
 * left completely untouched — they pass straight through to the network. */
var CACHE = "bw-shell-v1";

self.addEventListener("install", function () {
  self.skipWaiting(); // take over as soon as the new worker is ready
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return; // don't touch API / tile / search requests

  // Network-first: always try the network, update the offline cache, and only fall
  // back to the cache when the network is unavailable.
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        return cached || Promise.reject(new Error("offline and not cached"));
      });
    })
  );
});
