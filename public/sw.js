// Service Worker для Kryazh Messenger
const CACHE_NAME = 'kryazh-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/login.html',
  '/register.html',
  '/admin.html',
  '/manifest.json',
  '/offline.html'
];

// Установка Service Worker
self.addEventListener('install', event => {
  console.log('[SW] Установка...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Кэшируем файлы');
        return cache.addAll(urlsToCache);
      })
  );
});

// Активация
self.addEventListener('activate', event => {
  console.log('[SW] Активация...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Удаляем старый кэш:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Перехват запросов
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Если есть в кэше — возвращаем
        if (response) {
          return response;
        }
        
        // Если нет — идём в сеть
        return fetch(event.request)
          .then(response => {
            // Не кэшируем API запросы
            if (event.request.url.includes('/api/')) {
              return response;
            }
            
            // Кэшируем статику
            if (event.request.url.match(/\.(js|css|png|jpg|jpeg|svg|ico)$/)) {
              const responseToCache = response.clone();
              caches.open(CACHE_NAME)
                .then(cache => {
                  cache.put(event.request, responseToCache);
                });
            }
            return response;
          });
      })
  );
});

// Push уведомления (для будущего)
self.addEventListener('push', event => {
  const data = event.data.json();
  const options = {
    body: data.body,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url
    }
  };
  
  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Клик по уведомлению
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || '/')
  );
});
