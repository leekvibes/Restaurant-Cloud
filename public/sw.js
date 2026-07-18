// Minimal service worker. Its job is to make the app installable ("Add to Home
// Screen" / install prompt) — it deliberately does NOT cache pages, so staff
// always see live data and you never debug a stale screen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* pass through to the network */ });
