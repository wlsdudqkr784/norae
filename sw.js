// 오프라인 준비 — 앱 파일을 저장해 두고, 인터넷이 되면 새 판을 먼저 받는다.
// 곡은 여기서 다루지 않는다(곡은 IndexedDB 에 있다).
const CACHE = 'norae-app-v2';
const FILES = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/main.js',
  'js/game.js',
  'js/take.js',
  'js/score.js',
  'js/mictest.js',
  'js/calib.js',
  'js/vendor/vexflow-bravura.js',
  'js/library.js',
  'js/ultrastar.js',
  'js/pitch.js',
  'js/zip.js',
  'js/util.js',
  'fonts/PretendardVariable.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 하나가 안 받아져도 나머지는 저장한다
    await Promise.all(FILES.map((f) => c.add(new Request(f, { cache: 'reload' })).catch((err) => console.warn('저장 못 함', f, err))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k.startsWith('norae-app-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

const SHELL = /\.(html|css|js|png|webmanifest|woff2)$/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  if (!(SHELL.test(url.pathname) || url.pathname.endsWith('/'))) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const key = url.origin + url.pathname; // ?test=1 같은 꼬리는 뗀다
    // 글꼴(2MB)은 바뀌지 않는다 → 저장해 둔 것 먼저 (매번 새로 받지 않게)
    if (url.pathname.endsWith('.woff2')) {
      const hit = await c.match(key);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(key, r.clone()).catch((err) => console.warn('저장 못 함', key, err));
      return r;
    }
    // 새 판을 먼저 — 3초 안에 안 오면 저장해 둔 것으로. 저장해 둔 것도 없으면 늦더라도 새 판을 끝까지 기다린다
    // (11-14 점검: 전에는 3초가 지나면 저장본이 없어도 실패로 끝나 앱이 안 열렸다)
    const net = fetch(req, { cache: 'no-cache' }).then((r) => {
      if (r.ok) c.put(key, r.clone()).catch((err) => console.warn('저장 못 함', key, err));
      return r;
    });
    try {
      return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('느림')), 3000))]);
    } catch (err) {
      const hit = (await c.match(key)) || (url.pathname.endsWith('/') ? await c.match(key + 'index.html') : null) || (await c.match(req, { ignoreSearch: true }));
      if (hit) return hit;
      return net;
    }
  })());
});
