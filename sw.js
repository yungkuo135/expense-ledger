const CACHE_NAME = "expense-ledger-shell-v2";
const APP_SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/styles.css",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "js/supabase-config.js",
  "js/cloud.js",
  "js/storage.js",
  "js/core.js",
  "js/render.js",
  "js/interactions.js",
  "js/import-reconciliation.js",
  "js/ui.js",
  "js/backup-init.js",
  "js/pwa.js",
].map((path) => new URL(path, self.registration.scope).href);
const OFFLINE_PAGE = new URL("index.html", self.registration.scope).href;
const API_PATH = new URL("api/", self.registration.scope).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) =>
            name.startsWith("expense-ledger-shell-") && name !== CACHE_NAME
          )
          .map((name) => caches.delete(name)),
      )
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith(API_PATH) ||
    url.searchParams.get("storage") === "file"
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_PAGE)),
    );
    return;
  }

  if (!APP_SHELL.includes(url.href)) return;
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});
