// Offline support. Bump VERSION whenever any app file changes.
const VERSION = 'session-notes-v36';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'calendar.js', 'ink.js', 'sync.js', 'weather.js', 'health.js', 'downtime.js', 'outbreaks.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'fonts/alegreya-latin-400-normal.woff2', 'fonts/alegreya-latin-400-italic.woff2', 'fonts/alegreya-latin-700-normal.woff2',
  'fonts/alegreya-sans-latin-400-normal.woff2', 'fonts/alegreya-sans-latin-400-italic.woff2',
  'fonts/alegreya-sans-latin-500-normal.woff2', 'fonts/alegreya-sans-latin-700-normal.woff2',
];
self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's own copy, so an update never installs yesterday's files.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => caches.open(VERSION)).then(c => c.add(new Request('/core/suite.js', { cache: 'reload' })).catch(() => {})) // the suite core, if reachable
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('session-notes-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // The shared suite core (/core/) lives outside this app: always try the newest copy, fall back to the saved one offline
  if (e.request.method === 'GET' && url.origin === location.origin && url.pathname.startsWith('/core/')) {
    // no-cache: check with the server every time (GitHub Pages otherwise lets browsers reuse a copy for 10 minutes)
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
