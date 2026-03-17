// Commute Board — Service Worker
// Handles push notifications and basic PWA lifecycle.

const CACHE = 'commute-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Push ──────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'Commute Alert', body: "Time to check your commute!" };
  try { data = event.data.json(); } catch {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:      data.body,
      icon:      '/icons/icon.svg',
      badge:     '/icons/icon.svg',
      tag:       'commute-alert',
      renotify:  true,
      vibrate:   [200, 100, 200],
      data:      { url: '/' },
    })
  );
});

// ── Notification click → open / focus app ─────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        const existing = list.find(c => c.url.startsWith(self.location.origin));
        if (existing) return existing.focus();
        return self.clients.openWindow('/');
      })
  );
});
