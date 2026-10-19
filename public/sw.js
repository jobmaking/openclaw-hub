// Service worker de la PWA: recibe los push aunque la app esté CERRADA (el SO
// despierta el worker), muestra la notificación y, al pulsarla, abre la pestaña.
// No toca el caching: los assets ya van con ?v=N y no-cache.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Hub', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Hub';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icons/hub-v2/icon-192.png',
    badge: data.badge || '/icons/hub-v2/badge-96.png',
    tag: data.tag || 'hub',
    renotify: true,
    data: data.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(location.host)) { c.focus(); c.postMessage({ type: 'push-open', url }); return c; }
      }
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
