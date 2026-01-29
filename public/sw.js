// sw.js - The Service Worker
self.addEventListener('install', (e) => {
    console.log('[Service Worker] Install');
});

self.addEventListener('fetch', (e) => {
    // This is empty, but it's required to satisfy the PWA criteria
});
