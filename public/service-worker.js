self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open('cgpro-v1').then(cache => cache.addAll(['/','/styles.css','/scripts/htmx.min.js']))
  );
});
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then(resp => resp || fetch(e.request))
  );
});
