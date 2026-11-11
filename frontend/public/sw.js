// PrintYard service worker: Web Push only (no offline caching).
// Registered by the app in production builds, or in dev with ?sw=1.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/** Only paths on this origin may be opened from a notification. */
function safeUrl(raw) {
  try {
    const url = new URL(typeof raw === 'string' && raw ? raw : '/', self.location.origin)
    return url.origin === self.location.origin ? url.href : new URL('/', self.location.origin).href
  } catch {
    return new URL('/', self.location.origin).href
  }
}

self.addEventListener('push', (event) => {
  let data = {}
  if (event.data) {
    try {
      data = event.data.json()
    } catch {
      data = { body: event.data.text() }
    }
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'PrintYard'
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-96.png',
    data: { url: safeUrl(data.url) },
    timestamp: typeof data.ts === 'number' ? data.ts : Date.now(),
  }
  if (typeof data.tag === 'string' && data.tag) {
    options.tag = data.tag
    options.renotify = true
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = safeUrl(event.notification.data && event.notification.data.url)
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        return client.focus().then((focused) => (focused && 'navigate' in focused ? focused.navigate(target) : focused))
      }
      return self.clients.openWindow(target)
    }),
  )
})
