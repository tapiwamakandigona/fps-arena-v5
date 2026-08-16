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
 *
 * iter-118: deploy GC. Hashed assets are cache-first and this file is
 * byte-stable, so nothing ever evicted dead bundles — ~1.5 MB of /assets/
 * per deploy accumulated forever (97 deploys in, low-storage phones would
 * eventually hit origin-quota eviction, which also nukes the fps-sfx /
 * fps-thumbs IDB caches). index.html only names the ENTRY assets — lazy
 * chunks are referenced from inside bundles — so a keep-list can't work.
 * Instead: on every ONLINE navigation, read the entry-bundle hash from the
 * fresh HTML; when it changes (= a deploy happened), drop every cached
 * /assets/ entry. Still-live chunks re-cache on demand (~1.5 MB once per
 * deploy); dead ones are gone. Cache bumped v1->v2 so activate clears the
 * historical bloat once.
 */
const CACHE = 'fps5-rt-v2';

// iter-118: purge all cached hashed assets when the deploy id embedded in
// fresh HTML changes. Marker lives in the same cache under 'deploy-id'.
const gcOnDeploy = async (cache, html) => {
  try {
    const m = html.match(/assets\/index-[\w-]+\.js/);
    if (!m) return;
    const id = m[0];
    const marker = await cache.match('deploy-id');
    const old = marker ? await marker.text() : null;
    if (old === id) return;
    if (old) {
      const keys = await cache.keys();
      await Promise.all(keys
        .filter((r) => new URL(r.url).pathname.includes('/assets/'))
        .map((r) => cache.delete(r)));
    }
    await cache.put('deploy-id', new Response(id));
  } catch (err) { /* GC must never break navigation */ }
};

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
        // iter-118: sniff the deploy id off the fresh HTML and GC stale
        // hashed assets before the page starts requesting the new ones.
        const body = await resp.clone().text().catch(() => '');
        await gcOnDeploy(cache, body);
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
