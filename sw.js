// Service Worker for Pokemon Emeraude Custom PWA
// Bump APP_VERSION on every deploy to trigger auto-update
const APP_VERSION = 56;
const CACHE_NAME = 'pokemon-v' + APP_VERSION;
const ROM_CACHE = 'pokemon-rom-v' + APP_VERSION;

// Never cache these (API calls, auth, live data, emulator CDN)
const NOCACHE_PATTERNS = [
    /supabase\.co/,
    /\.supabase\./,
    /cdn\.emulatorjs\.org/,
];

const ROM_URL_PATTERN = /rom\/pokemon\.gba/;

// Install: activate immediately (skipWaiting)
self.addEventListener('install', event => {
    self.skipWaiting();
});

// Activate: delete ALL old caches, claim clients, notify page to reload
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.map(key => {
                if (key !== CACHE_NAME && key !== ROM_CACHE) {
                    console.log('[SW] Deleting old cache:', key);
                    return caches.delete(key);
                }
            }))
        ).then(() => {
            // Notify all open pages to reload with new version
            self.clients.matchAll().then(clients => {
                clients.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: APP_VERSION }));
            });
            return self.clients.claim();
        })
    );
});

self.addEventListener('fetch', event => {
    const url = event.request.url;

    // Never cache API calls
    for (const pattern of NOCACHE_PATTERNS) {
        if (pattern.test(url)) return;
    }

    // ROM: cache-first (large file, rarely changes, version in URL busts cache)
    if (ROM_URL_PATTERN.test(url)) {
        event.respondWith(
            caches.open(ROM_CACHE).then(cache =>
                cache.match(event.request).then(cached => {
                    if (cached) return cached;
                    return fetch(event.request).then(response => {
                        if (response.ok) cache.put(event.request, response.clone());
                        return response;
                    });
                })
            )
        );
        return;
    }

    // Everything else: network-first, cache fallback (always fresh when online)
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response.ok && event.request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
