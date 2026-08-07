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
  const version = "v1";

  const body = `
const CACHE = 'vue-lights-${version}';
const BASE = ${JSON.stringify(base)};
const SHELL = [
  BASE + '/',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png',
  BASE + '/apple-touch-icon.png',
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

  // Navigations: network first, cached shell only as an offline fallback, so
  // the app opens to a real screen on a dead connection instead of a browser
  // error page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(BASE + '/').then((r) => r || Response.error()))
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
