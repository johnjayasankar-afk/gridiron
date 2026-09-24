/*
 * Gridiron's service worker keeps the app shell and its hashed build files at
 * hand for quick starts and short network drops, and shows push alerts for
 * favorite teams. Live data under /api is never cached here, so scores are
 * always current or honestly unavailable.
 */
const VERSION = 'gridiron-0.6.0';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/theme-init.js'];
const MAX_ASSETS = 80;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function remember(request, response) {
  const cache = await caches.open(VERSION);
  await cache.put(request, response);
  const keys = await cache.keys();
  const assets = keys.filter((key) => new URL(key.url).pathname.startsWith('/assets/'));
  // Old deploys' chunks go first; the shell entries are never trimmed.
  for (const key of assets.slice(0, Math.max(0, assets.length - MAX_ASSETS))) await cache.delete(key);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // The page: network first, so a new version shows at once; the saved shell only when the network fails.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) event.waitUntil(remember('/', response.clone()));
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached || Response.error())),
    );
    return;
  }

  // Hashed build files, fonts and icons never change under the same name: cache first.
  if (/^\/(assets|fonts|icons)\//.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) event.waitUntil(remember(request, response.clone()));
            return response;
          }),
      ),
    );
  }
});

// ---------------------------------------------------------------- push alerts

/** A path on this site, or the home page. */
function localPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  // A push must always show something; an unreadable one says only that there is news.
  const valid = data !== null && typeof data === 'object' && typeof data.title === 'string';
  const title = valid ? data.title : 'Gridiron update';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: valid && typeof data.body === 'string' ? data.body : 'Open Gridiron for the latest.',
      tag: valid && typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      timestamp: valid && typeof data.at === 'number' ? data.at : Date.now(),
      data: { url: localPath(valid ? data.url : null) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(localPath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (!open) {
        await self.clients.openWindow(target);
        return;
      }
      await open.focus();
      if (open.url !== target && 'navigate' in open) await open.navigate(target).catch(() => undefined);
    })(),
  );
});

// When the browser replaces a subscription, the server moves the teams and kinds it held to the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const previous = event.oldSubscription;
      if (!previous) return;
      let next = event.newSubscription;
      const key = previous.options && previous.options.applicationServerKey;
      if (!next && key) next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      if (!next) return;
      await fetch('/api/push/resubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldEndpoint: previous.endpoint, subscription: next.toJSON() }),
      });
    })().catch(() => undefined),
  );
});
