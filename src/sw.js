import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'

// Precache app shell (js, css, html, assets)
precacheAndRoute(self.__WB_MANIFEST)

// Remove stale entries from previous precache manifests
cleanupOutdatedCaches()

// On activate, clean up any old gurbani-data-* caches left over from the
// previous Cache Storage approach. OPFS now owns that data.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('gurbani-data-'))
          .map(key => caches.delete(key))
      )
    )
  )
})

// The client sends SKIP_WAITING when the user clicks "Reload Now".
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
