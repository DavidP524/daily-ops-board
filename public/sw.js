// The Playbook — Service Worker
const CACHE_NAME = 'playbook-v4';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for API; cache-first (with revalidation for index) for everything else
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    return;
  }

  // For navigation, prefer network so we don't pin a stale shell
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/').then(r => r || caches.match(event.request)))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => cached);
    })
  );
});

// ── Push notification ───────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}

  const title = data.title || 'Playbook';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/icon-192.png',
    data: data.data || {},
    actions: data.actions || [],
    tag: data.tag || (data.data && data.data.taskId ? `task-${data.data.taskId}` : 'playbook'),
    renotify: data.renotify === true,
    requireInteraction: data.requireInteraction === true,
    vibrate: [120, 60, 120, 60, 240],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click → call /api/push/ack with action ─────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const action = event.action || 'open';
  const taskId = event.notification.data && event.notification.data.taskId;
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async () => {
    if (taskId) {
      try {
        await fetch('/api/push/ack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId, action }),
        });
      } catch (e) {
        // best-effort — fall through to opening the app
      }
    }
    // Open the app for everything except a pure background snooze action
    if (action === 'snooze5' || action === 'snooze15' || action === 'snooze60') {
      // Don't focus — user wants to keep doing what they were doing
      return;
    }
    return focusOrOpenApp(targetUrl, taskId);
  })());
});

function focusOrOpenApp(url, taskId) {
  const target = taskId ? `${url}?task=${encodeURIComponent(taskId)}` : url;
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
    for (const client of windowClients) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        client.postMessage({ type: 'open-task', taskId: taskId || null });
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  });
}
