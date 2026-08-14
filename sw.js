/* FPS Arena V5 service worker (iter-72).
 *
 * Goals, in order:
 *   1. Never serve a stale game shell: navigations are NETWORK-FIRST; the
 *      cache copy of index.html is only a fallback for offline/flaky loads.
 *   2. Instant repeat loads on slow connections: hashed bundle assets
 *      (assets/…-<hash>.js/css/mp3/woff2/png) are immutable -> CACHE-FIRST.
 *   3. Playable fully offline after one successful visit.
 *   4. Non-hashed payloads (models/, decoders/, icons/, manifest) are
 *      STALE-WHILE-REVALIDATE: served from cache instantly, refreshed in the
 *      background so the *next* load after a deploy picks up changes. The
 *      one-session staleness window is acceptable — index.html is always
 *      fresh, and model formats change rarely.
 *
 * No precache list: everything is captured at runtime, so this file never
 * needs regenerating per build and stays byte-stable across deploys.
 */
const CACHE = 'fps5-rt-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

const putSafe = async (cache, req, resp) => {
  // Only cache complete, successful same-origin responses.
  try { if (resp && resp.ok && resp.status === 200) await cache.put(req, resp.clone()); } catch (err) {}
  return resp;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 1) Navigations: network-first, cached shell as offline fallback.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const resp = await fetch(req);
        return await putSafe(cache, 'index.html', resp);
      } catch (err) {
        const hit = await cache.match('index.html');
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  const p = url.pathname;
  const hashedAsset = p.includes('/assets/');
  const softAsset = p.includes('/models/') || p.includes('/decoders/') ||
                    p.includes('/icons/') || p.endsWith('.webmanifest');
  if (!hashedAsset && !softAsset) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hashedAsset) {
      // Immutable (content-hashed filenames): cache-first.
      if (hit) return hit;
      return putSafe(cache, req, await fetch(req));
    }
    // Stale-while-revalidate for non-hashed payloads.
    const refresh = fetch(req).then((resp) => putSafe(cache, req, resp)).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    const resp = await refresh;
    if (resp) return resp;
    throw new Error('offline and uncached: ' + p);
  })());
});
