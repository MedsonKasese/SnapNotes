
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

const CACHE_NAME = "snapnotes-v82";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./styles/main.css",
  "./styles/components.css",
  "./styles/layout.css",
  "./styles/styles.css",
  "./js/storage.js",
  "./js/local-library.js",
  "./js/note-deletions.js",
  "./js/attachments.js",
  "./js/pdf-preview.js",
  "./js/attachment-cleanup.js",
  "./js/folders.js",
  "./js/reminder-utils.js",
  "./js/ai-format.js",
  "./js/drafts.js",
  "./js/note-format.js",
  "./js/notes.js",
  "./js/checklist-utils.js",
  "./js/app.js",
  "./js/ai.js",
  "./js/version-history.js",
  "./js/private-notes.js",
  "./js/private-attachment-crypto.js",
  "./js/private-passkey.js",
  "./js/private-note-utils.js",
  "./js/note-sync.js",
  "./js/cloud-session.js",
  "./js/settings-account.js",
  "./js/firebaseConfig.js",
  "./js/firestore.js",
  "./js/auth.js",
  "./assets/icons/snapnotes-icon.png",
  "./assets/icons/snapnotes-notification.png",
  "./assets/icons/snapnotes-notification-badge.png"
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

  // Never cache API responses, signed URLs, or private user-specific content.
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;

  if (url.origin !== self.location.origin) {
    const isPinnedPdfJsAsset =
      url.origin === "https://cdnjs.cloudflare.com" &&
      url.pathname.startsWith("/ajax/libs/pdf.js/4.10.38/");

    if (isPinnedPdfJsAsset) {
      event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok && response.status === 200) {
          await cache.put(event.request, response.clone());
        }
        return response;
      })().catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        return new Response("", { status: 503, statusText: "PDF viewer unavailable offline" });
      }));
      return;
    }

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
