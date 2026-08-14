export const dynamic = "force-dynamic";

/**
 * Service worker, generated so its cache keys and precache list carry the
 * deploy's basePath.
 *
 * Two rules drive the whole thing:
 *   - Cache the shell, never the data. A stale light state rendered as current
 *     is worse than an error, because the user acts on it.
 *   - Never precache a URL the server redirects. The install fails whole and
 *     silently, and the app simply never becomes installable.
 */
export async function GET() {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  // Bump to invalidate every client's precache. A stale precache is the bug
  // where one user is on last month's UI and nobody can reproduce it.
  //
  // v2: v1 precached BASE + '/', which at the time redirected to /login — so
  // devices cached the login page as the app shell and kept rendering it after
  // the passphrase gate was removed. Navigations now cache themselves at
  // runtime instead, so the fallback can never be a redirect target.
  //
  // v3: the room plate joined the precache. It is a static picture of the
  // furniture with no lamp, no fixture and no glow in it — every state-bearing
  // pixel is drawn live on top — so caching it can never show a stale light.
  const version = "v3";

  const body = `
const CACHE = 'vue-lights-${version}';
const BASE = ${JSON.stringify(base)};
// Static assets only. Never precache a URL the server may redirect — the
// entry either fails to store or stores the wrong page, silently.
const SHELL = [
  BASE + '/icon-192.png',
  BASE + '/icon-512.png',
  BASE + '/apple-touch-icon.png',
  // The room map's background. Shell, not data: no light state is baked into
  // it, and the Room tab is the app's front door.
  BASE + '/room-plate-dark.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Individually, so one 404 can't fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live house state and auth are never served from cache.
  if (url.pathname.startsWith(BASE + '/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Navigations: always network first, and cache the RESULT as the offline
  // fallback. Storing what the server actually served (rather than precaching
  // a guessed URL) means the fallback tracks the live app instead of freezing
  // whatever the page happened to be on install day.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && !response.redirected) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put(BASE + '/offline', copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(BASE + '/offline').then((r) => r || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
`.trim();

  return new Response(body, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
