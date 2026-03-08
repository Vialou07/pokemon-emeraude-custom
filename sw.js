// Service Worker for Pokemon Emeraude Custom PWA
// Caches the ROM and static assets for faster loads + offline support
const CACHE_NAME = 'pokemon-v55';
const ROM_CACHE = 'pokemon-rom-v54';

// Static assets to pre-cache on install
const PRECACHE = [
    './',
    './index.html',
    './sram_editor.js',
    './js/sram-parser.js',
    './manifest.json',
];

// ROM cached on first fetch (too large for precache)
const ROM_URL_PATTERN = /rom\/pokemon\.gba/;

// Never cache these (API calls, auth, live data)
const NOCACHE_PATTERNS = [
    /supabase\.co/,
    /\.supabase\./,
    /cdn\.emulatorjs\.org/,
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.map(key => {
                if (key !== CACHE_NAME && key !== ROM_CACHE) {
                    return caches.delete(key);
                }
            }))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const url = event.request.url;

    // Never cache API calls
    for (const pattern of NOCACHE_PATTERNS) {
        if (pattern.test(url)) return;
    }

    // ROM: cache-first strategy (ROM changes rarely, use ROM_CACHE)
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

    // Other static assets: network-first with cache fallback
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
