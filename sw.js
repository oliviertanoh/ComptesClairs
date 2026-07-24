// sw.js — service worker. Rôle : rendre l'app utilisable hors ligne (mode
// avion), en mettant tous les fichiers statiques en cache dès la première
// visite. Stratégie « cache-first » : on sert d'abord le cache, on ne va au
// réseau que pour ce qui manque.
//
// L'app ne fait AUCUN appel réseau applicatif — seuls ses propres fichiers
// sont concernés.
//
// Pense à incrémenter CACHE_VERSION quand tu modifies un fichier, sinon
// l'ancienne version reste servie depuis le cache.

const CACHE_VERSION = 'comptes-clairs-v4';

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/tokens.css',
  './css/app.css',
  './js/main.js',
  './js/db.js',
  './js/seed.js',
  './js/budget.js',
  './js/money.js',
  './js/csv.js',
  './js/backup.js',
  './js/views/month.js',
  './js/views/add.js',
  './js/views/history.js',
  './js/views/settings.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

// Installation : on précharge tout.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)),
  );
  self.skipWaiting();
});

// Activation : on purge les anciens caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

// Requêtes : cache-first, avec repli réseau puis mise en cache à la volée.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // On ne met en cache que nos propres ressources (même origine).
          if (response.ok && new URL(request.url).origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Hors ligne et absent du cache : pour une navigation, on renvoie
          // la coquille de l'app.
          if (request.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 504, statusText: 'Hors ligne' });
        });
    }),
  );
});
