// #571: the server fills in a hash of the deployed files (server/utils/serviceWorker.js), so each
// deploy is a new worker and `activate` below drops the previous version's cache.
const CACHE_NAME = 'webcalendar-__ASSET_VERSION__';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/js/app.js',
  '/js/calendar.js',
  '/js/store.js',
  '/js/calendarLabels.js',
  '/js/api.js',
  '/js/tasks.js',
  '/js/notifications.js',
  '/js/workingHours.js',
  '/js/delegates.js',
  '/js/eventModal.js',
  '/js/accountModal.js',
  '/js/shortcuts.js',
  '/js/offlineCache.js',
  '/js/safeUrl.js'
];

// Install Event — Pre-cache core shell resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate Event — Clean up stale caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event — Network-First for everything: API calls and the app shell (#571). The cache only
// answers when the network is unreachable, so after a deploy the next page load runs the new code.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests and browser extensions
  if (event.request.method !== 'GET' || !url.protocol.startsWith('http')) {
    return;
  }

  // Handle API requests (Network-First with fallback)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            return new Response(
              JSON.stringify({ error: 'Offline mode active', offline: true }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
          });
        })
    );
    return;
  }

  // App shell (HTML/JS/CSS) — Network-First; the cached copy only when offline
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      })
      .catch((err) => {
        // Offline: fetch rejects with a TypeError; anything else is a bug and stays an error.
        if (!(err instanceof TypeError)) throw err;
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          throw err;
        });
      })
  );
});

// Push Event — Display background desktop notifications for VALARM triggers
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const title = data.title || 'Erinnerung';
    const options = {
      body: data.body || '',
      icon: data.icon || '/favicon.ico',
      tag: data.data ? data.data.eventId : undefined,
      data: data.data || {}
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.warn('[sw] Push notification payload error:', err);
  }
});

// Notification Click Event — Open or focus application window
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
