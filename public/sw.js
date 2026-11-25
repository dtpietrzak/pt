// Cloudflare 307-redirects /index.html to /, so only "./" is precached (offline navigations fall back to it).
// Bump CACHE whenever any file below changes so installed copies pick up the update.
const CACHE = "pt-v6";
// Firebase SDK modules from the gstatic CDN (versioned, immutable URLs): cached on first use so a
// signed-in device still starts offline. Kept across app-cache bumps.
const SDK_CACHE = "pt-firebase-sdk";
const ASSETS = [
  "./", "styles.css", "app.js", "manifest.webmanifest",
  "js/util.js", "js/schema.js", "js/engine.js", "js/patch.js", "js/db.js", "js/dose.js", "js/data.js", "js/defaults.js",
  "js/sync.js", "js/cloud.js", "js/firebase-config.js", "js/posture.js", "js/timer-ui.js",
  "data/levels.json", "data/exercises.json", "data/tests.json", "data/decision-config.json", "data/profile.json", "data/posture-cycle.json",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SDK_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Cache first (instant + fully offline), refreshing the cache in the background.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === "https://www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) {
    event.respondWith(caches.open(SDK_CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }))));
    return;
  }
  // Same-origin only. /__/ is Firebase Auth's self-hosted sign-in helper: always straight to the network.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/__/")) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req)
        .then((res) => { if (res.ok && res.type === "basic" && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
        .catch(() => hit || (req.mode === "navigate" ? caches.match("./") : undefined));
      return hit || net;
    })
  );
});

// Tapping a timer notification brings the open PT tab (or a new one) to the front on the Work screen.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) { open.navigate && open.navigate(new URL("./#/work", self.registration.scope).href).catch(() => {}); return open.focus(); }
    return self.clients.openWindow("./#/work");
  }));
});
