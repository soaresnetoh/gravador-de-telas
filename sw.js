// Cache do app para funcionar offline. O nome segue a versão publicada (version.js,
// atualizado pelo publicar.sh): versão nova → cache novo → todos recebem a atualização.
importScripts('version.js');
const CACHE = `gravador-de-telas-${self.APP_VERSION}`;
// libs/mediapipe (~11 MB) não entra aqui: é guardado no cache só quando o usuário usa um fundo.
const ASSETS = ['./', 'index.html', 'styles.css', 'version.js', 'app.js', 'camera-fx.js', 'storage.js', 'manifest.webmanifest', 'assets/logo.svg', 'assets/logo.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Rede primeiro (pega atualizações), cache como reserva offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
