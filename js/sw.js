// File: sw.js
const CACHE_NAME = 'pwa-mobile-v3';

// [GUNAKAN RELATIVE PATH AGAR COMPATIBLE DENGAN GITHUB PAGES]
const ASSETS_TO_CACHE = [
  './',
  'index.html',
  'login.html',
  'pages/wrapping.html',
  'css/style.css',
  'js/auth.js',
  'js/wrapping.js'
];

// Event Install: Caching Aset Statis Dasar
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching app shell & static assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Event Activate: Cleans up Old Caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Deleting old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Event Fetch: Network First with Cache Fallback Strategy
self.addEventListener('fetch', (event) => {
  // Abaikan request ke Supabase API agar data real-time selalu up to date
  if (event.request.url.includes('supabase.co')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Simpan salinan respon terbaru ke cache jika sukses
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // Fallback ke cache jika offline
        return caches.match(event.request);
      })
  );
});