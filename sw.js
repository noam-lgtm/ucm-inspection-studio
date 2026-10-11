/* Offline support. Cache-first for the app shell, refreshed on every new deploy (bump VERSION). */
const VERSION = 'v2.1.0';
const CACHE = 'ucm-inspection-' + VERSION;
const ASSETS = [
  './', './index.html', './src/app.js', './src/app.css', './src/report.css', './src/core.js', './src/sampling.js',
  './src/storage.js', './src/i18n.js', './src/report-sheet.js', './src/pdf-import.js', './src/pdf-pages.js', './src/pdf-render.js',
  './src/ai-merge.js', './src/sync.js', './src/ui-import.js', './src/ui-products.js', './src/ui-settings.js',
  './vendor/pdfjs/pdf.min.js', './vendor/pdfjs/pdf.worker.min.js', './manifest.webmanifest', './icon.svg', './logo-ucm.svg',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(cached => {
      const network = fetch(request).then(response => {
        if (response && response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
