// Minimal service worker. Its job is to make the app installable ("Add to Home
// Screen" / install prompt) — it deliberately does NOT cache pages, so staff
// always see live data and you never debug a stale screen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* pass through to the network */ });

// --- Web Push --------------------------------------------------------------
// A pushed message from the server (a special, an 86, a note, or your pay).
// The payload is JSON: { title, body, url }. Falls back gracefully if a push
// ever arrives without one.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: 'Staff portal', body: event.data && event.data.text ? event.data.text() : '' }; }
  const title = d.title || 'Staff portal';
  const options = {
    body: d.body || '',
    icon: '/static/palm-icon-192.png',
    badge: '/static/palm-icon-192.png',
    data: { url: d.url || '/portal' },
    tag: d.tag || undefined,          // same tag replaces rather than stacks
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses the app (or opens it) on the right page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/portal';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      // Focus an already-open portal tab and send it to the target page.
      if ('focus' in c) { try { await c.focus(); if ('navigate' in c) await c.navigate(url); return; } catch (e) { /* fall through to open */ } }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
