const CACHE_NAME = "snapnotes-v32";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./styles/main.css",
  "./styles/components.css",
  "./styles/layout.css",
  "./styles/styles.css",
  "./js/storage.js",
  "./js/notes.js",
  "./js/app.js",
  "./js/firebaseConfig.js",
  "./js/firestore.js",
  "./js/auth.js",
  "./assets/icons/snapnotes-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith("snapnotes-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then(clients => clients.forEach(client => client.postMessage({ type: "SNAPNOTES_UPDATED", version: CACHE_NAME })))
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (!response || response.status !== 200) return response;

        // Always refresh same-origin app files from the network first.
        // This prevents an installed PWA from serving an older HTML/CSS/JS
        // version after a deployment. The response is still cached for offline use.
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseClone);
        });

        return response;
      })
      .catch(() => {
        return caches.match(event.request).then(cached => {
          if (cached) return cached;

          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }

          return new Response("", { status: 503, statusText: "Offline" });
        });
      })
  );
});
