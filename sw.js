// 오프라인 준비 — 앱 파일을 '한 벌'로 저장해 두고, 한 번 열 때는 그 한 벌에서만 꺼낸다.
// 곡은 여기서 다루지 않는다(곡은 IndexedDB 에 있다).
//
// 11-22 감사로 다시 짬. 전에는 파일마다 따로 '새 판 먼저, 3초 넘으면 저장본' 이라 한 번 열 때 새 파일·옛 파일이 섞일 수
// 있었다 — 11-21 판처럼 pitch.js 내보내기가 바뀐 판은 섞이면 모듈 연결에서 깨져 앱이 아예 안 열린다(인터넷 없는 곳에선 그날 연습 못 함).
// 이제는:
//   ① 앱 파일 한 벌(FILES)을 모두 받아야만 새 벌로 쓴다 — 하나라도 못 받으면 옛 벌을 그대로 쓴다.
//   ② 앱을 열 때는 지금 벌에서만 꺼낸다(인터넷을 기다리지 않음). 같은 화면이 뒤에 부르는 파일도 연 때의 벌에서.
//   ③ 새 판 확인은 앱을 연 뒤 뒤에서 한다: 바뀐 파일이 있으면 한 벌을 받고, 잠깐 뒤 한 번 더 받아 같을 때만(올리는 중 섞임 막기)
//      새 벌로 바꾼다 → 다음에 열 때 새 판. sw.js 를 고치지 않아도(캐시 이름을 안 바꿔도) 새 판이 들어온다.
//   ④ 서버가 404·503 을 줘도 그것으로 저장본을 덮거나 대신 내주지 않는다(11-22 감사 — 전에는 3초 안에 온 오류가 이겼다).
// FILES 에 없는 파일(새로 더한 js 를 여기 안 넣은 경우)은 전처럼 '새 판 먼저 → 저장본' 으로 다룬다.
// js 파일을 새로 더하면 FILES 에 넣는다(안 넣으면 그 파일만 섞일 수 있다).
const PREFIX = 'norae-app-';          // 옛 판 캐시 'norae-app-v2' 도 이 머리 — 새 벌이 생기면 지운다
const META = 'norae-meta';            // 지금 쓰는 벌 이름 하나만 적어 둔다
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
const SHELL = /\.(html|css|js|png|webmanifest|woff2)$/;
const FONT = /\.woff2$/;              // 글꼴(2MB)은 바뀌지 않는다 → 새 판 확인 때 다시 받지 않고 옛 벌 것을 옮긴다
const CHECK_AFTER = 2000;             // 앱을 연 뒤 이만큼 있다가 새 판 확인
const CHECK_GAP = 60000;              // 새 판 확인은 이 간격 안에 한 번만
const SETTLE = 15000;                 // 바뀐 것을 보면 이만큼 뒤 한 번 더 받아 같은지 본다
const NET_WAIT = 3000;                // 벌에 없는 파일: 새 판을 이만큼 기다린 뒤 저장본으로
// 이 PC 의 시험 서버(127.0.0.1:8765 등)에서는 고친 파일이 바로 보이게 벌을 쓰지 않고 늘 새 판 먼저(전처럼).
// 벌로 열면 고친 뒤 처음 다시 열 때 옛 판이 떠서 '고친 것이 안 됐다' 고 잘못 볼 수 있다.
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || location.hostname.endsWith('.localhost');

const scopeUrl = (f) => new URL(f, self.registration.scope).href;
const keyOf = (url) => url.origin + url.pathname;   // ?test=1 같은 꼬리는 뗀다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function currentSet() {
  try {
    const r = await (await caches.open(META)).match('current');
    if (!r) return null;
    const name = await r.text();
    return (await caches.has(name)) ? name : null;
  } catch (err) {
    console.warn('지금 벌 이름을 못 읽음', err);
    return null;
  }
}

// 한 벌 모두 받기. 하나라도 못 받으면(오프라인·404·503) 던진다. reuse: 옛 벌(글꼴 옮기기용)
async function fetchAll(mode, reuse) {
  return Promise.all(FILES.map(async (f) => {
    const url = scopeUrl(f);
    if (reuse && FONT.test(url)) {
      const hit = await reuse.match(url);
      if (hit) return { url, buf: await hit.arrayBuffer(), type: hit.headers.get('content-type') || '', kept: true };
    }
    const r = await fetch(new Request(url, { cache: mode }));
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return { url, buf: await r.arrayBuffer(), type: r.headers.get('content-type') || '' };
  }));
}

function sameBuf(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// 새 판 확인(또는 처음 받기). 새 벌을 만들었으면 그 이름, 바뀐 것이 없거나 못 만들었으면 null.
let busy = null;
function refresh(why) {
  if (!busy) busy = doRefresh(why).finally(() => { busy = null; });
  return busy;
}
async function doRefresh(why) {
  const cur = await currentSet();
  const old = cur ? await caches.open(cur) : null;
  const mode = why === 'install' ? 'reload' : 'no-cache';
  let got;
  try {
    got = await fetchAll(mode, old);
  } catch (err) {
    console.warn('앱 파일 한 벌을 못 받음 — 지금 벌을 그대로 씀', why, err);
    return null;
  }
  if (old) {
    let changed = false;
    for (const g of got) {
      if (g.kept) continue;
      const prev = await old.match(g.url);
      if (!prev || !sameBuf(await prev.arrayBuffer(), g.buf)) { changed = true; break; }
    }
    if (!changed) return null;
  }
  // 올리는 중이면 새 파일·옛 파일이 섞여 보일 수 있다 → 잠깐 뒤 한 번 더 받아 똑같을 때만 쓴다
  await sleep(SETTLE);
  let again;
  try {
    again = await fetchAll('no-cache', old);
  } catch (err) {
    console.warn('앱 파일 다시 받기 실패 — 다음에 다시', err);
    return null;
  }
  for (let i = 0; i < got.length; i++) {
    if (!sameBuf(got[i].buf, again[i].buf)) { console.warn('앱 파일이 받는 사이 바뀜(올리는 중) — 다음에 다시', got[i].url); return null; }
  }
  const name = PREFIX + 'set-' + Date.now();
  try {
    const c = await caches.open(name);
    // 머리말은 종류만 옮긴다(압축 표시 등을 옮기면 몸통과 안 맞는다). 모듈 js 는 종류가 맞아야 열린다
    for (const g of got) await c.put(g.url, new Response(g.buf, { status: 200, headers: g.type ? { 'Content-Type': g.type } : {} }));
    await (await caches.open(META)).put('current', new Response(name));
  } catch (err) {
    console.warn('새 벌 저장 실패 — 지금 벌을 그대로 씀', err);
    try { await caches.delete(name); } catch (e2) { console.warn('덜 만든 벌 지우기 실패', e2); }
    return null;
  }
  await cleanup(name, cur);
  if (cur) {
    // 열려 있는 앱에 알린다(index.html 이 '다음에 열면 새 판' 을 잠깐 보인다)
    try { for (const cl of await self.clients.matchAll({ type: 'window' })) cl.postMessage({ type: 'norae-new-version' }); } catch (err) { console.warn('새 판 알림 실패', err); }
  }
  return name;
}

// 지금 벌과 바로 앞 벌(아직 그 벌로 연 화면이 있을 수 있다)만 남기고 앱 캐시를 지운다. 곡(IndexedDB)은 건드리지 않는다.
async function cleanup(keep, prev) {
  for (const k of await caches.keys()) {
    if (k.startsWith(PREFIX) && k !== keep && k !== prev) {
      try { await caches.delete(k); } catch (err) { console.warn('옛 앱 캐시 지우기 실패', k, err); }
    }
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // 못 받아도 설치는 끝낸다 — 설치가 실패하면 이 sw.js 로 영영 못 바뀐다. 벌이 없으면 아래 fetch 가 전처럼 새 판 먼저로 다루고,
    // 다음에 열 때 다시 받는다.
    try { await refresh('install'); } catch (err) { console.warn('설치 때 앱 파일 받기 실패', err); }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const cur = await currentSet();
    if (cur) await cleanup(cur, null);   // 벌이 있을 때만 옛 캐시(norae-app-v2 등)를 지운다 — 없으면 그것이 마지막 저장본
    await self.clients.claim();
  })());
});

// 화면(창)마다 연 때의 벌을 기억한다 — 열려 있는 사이 새 벌로 바뀌어도 그 화면이 뒤에 부르는 파일은 같은 벌에서
const pinned = new Map();
function pin(id, name) {
  if (!id || !name) return;
  pinned.set(id, name);
  if (pinned.size > 30) pinned.delete(pinned.keys().next().value);
}
let lastCheck = 0;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  if (!(SHELL.test(url.pathname) || url.pathname.endsWith('/'))) return;
  const nav = req.mode === 'navigate';
  if (DEV) { e.respondWith(fromNetwork(e, keyOf(url), url)); return; }
  e.respondWith(serve(e, url, nav));
  if (nav && Date.now() - lastCheck > CHECK_GAP) {
    lastCheck = Date.now();
    e.waitUntil(sleep(CHECK_AFTER).then(() => refresh('check')).catch((err) => console.warn('새 판 확인 실패', err)));
  }
});

async function serve(e, url, nav) {
  const key = keyOf(url);
  let name = nav ? null : pinned.get(e.clientId);
  if (name && !(await caches.has(name))) name = null;
  if (!name) name = await currentSet();
  if (nav) pin(e.resultingClientId, name);
  if (name) {
    const c = await caches.open(name);
    const hit = (await c.match(key)) || (url.pathname.endsWith('/') ? await c.match(key + 'index.html') : null);
    if (hit) return hit;
  }
  return fromNetwork(e, key, url);
}

// 벌에 없는 파일(또는 벌이 아직 없을 때): 새 판을 먼저 — 3초 안에 '제대로 된' 답이 안 오면 저장해 둔 것으로.
// 저장해 둔 것도 없으면 늦더라도 새 판을 끝까지 기다린다(그 답이 오류여도 내줄 것이 그것뿐).
async function fromNetwork(e, key, url) {
  const req = e.request;
  const net = fetch(req, { cache: 'no-cache' });
  const good = net.then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const copy = r.clone();
    const save = caches.open(PREFIX + 'loose').then((c) => c.put(key, copy)).catch((err) => console.warn('저장 못 함', key, err));
    // 답을 이미 저장본으로 낸 뒤에 도착하면 waitUntil 이 안 받을 수 있다 — 그때도 저장은 그대로 이어진다
    try { e.waitUntil(save); } catch (err) { console.warn('저장을 끝까지 못 기다릴 수 있음', key, err.name || err); }
    return r;
  });
  try {
    return await Promise.race([good, sleep(NET_WAIT).then(() => { throw new Error('느림'); })]);
  } catch (err) {
    const hit = (await caches.match(key)) || (url.pathname.endsWith('/') ? await caches.match(key + 'index.html') : null) || (await caches.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    return net;
  }
}
