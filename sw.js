
self.addEventListener("notificationclick", event => {
  const noteId = event.notification?.data?.noteId;
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clientList => {
      const target = clientList.find(client => "focus" in client);

      if (target) {
        await target.focus();
        target.postMessage({
          type: "SNAPNOTES_OPEN_NOTE",
          noteId: noteId || null
        });
        return;
      }

      if (self.clients.openWindow) {
        const url = noteId
          ? `./?openNote=${encodeURIComponent(noteId)}`
          : "./";
        return self.clients.openWindow(url);
      }

      return undefined;
    })
  );
});

const CACHE_NAME = "snapnotes-v52";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./styles/main.css",
  "./styles/components.css",
  "./styles/layout.css",
  "./styles/styles.css",
  "./js/storage.js",
  "./js/attachments.js",
  "./js/folders.js",
  "./js/reminder-utils.js",
  "./js/notes.js",
  "./js/app.js",
  "./js/version-history.js",
  "./js/private-notes.js",
  "./js/firebaseConfig.js",
  "./js/firestore.js",
  "./js/auth.js",
  "./assets/icons/snapnotes-icon.png",
  "./assets/icons/snapnotes-notification.png",
  "./assets/icons/snapnotes-notification-badge.svg"
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
