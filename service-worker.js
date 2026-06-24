/* 앱 셸 캐시 — network-first(최신 우선, 오프라인 시 캐시 폴백).
   GAS API(POST, 교차출처)는 항상 네트워크. */
const CACHE = 'ledger-v4';
const SHELL = [
  './', './index.html', './history.html', './stats.html', './payments.html', './settings.html',
  './manifest.webmanifest', './assets/icon.svg',
  './assets/css/core.css',
  './assets/js/config.js', './assets/js/api.js', './assets/js/core.js',
  './assets/js/index.js', './assets/js/history.js', './assets/js/stats.js',
  './assets/js/payments.js', './assets/js/settings.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 동일 출처 GET 만 처리. API 호출(script.google.com 등)은 통과.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // stale-while-revalidate: 캐시 즉시 응답 + 백그라운드로 최신 받아 캐시 갱신
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((hit) => {
        const net = fetch(req).then((res) => { cache.put(req, res.clone()).catch(() => {}); return res; })
                              .catch(() => hit || cache.match('./index.html'));
        return hit || net;
      })
    )
  );
});
