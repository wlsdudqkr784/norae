// 작은 도구들: 설정 저장, 초성 검색, 시간 표시

const DEFAULTS = {
  level: 'normal',      // easy | normal | hard
  outLatency: -1,       // 이어폰/스피커 지연 ms (-1 = 기기가 알려 주는 값)
  micLatency: 40,       // 마이크 지연 ms
  micGate: 0.012,       // 이보다 작은 소리는 무시
  echoCancel: false,    // 스피커로 들을 때 켬
  musicVol: 0.9,
  guide: false,         // 가이드 음
  guideVol: 0.35,
  guideVoice: 0,        // 가이드 목소리 크기(0 = 끔, 1 = 원곡만큼)
  sort: 'title',        // title | recent | best
  favOnly: false,       // 목록에서 즐겨찾기만
  takeVoiceVol: 1.5,    // 내 노래 듣기: 내 목소리 크기
  takeMusicVol: 0.6,    // 내 노래 듣기: 노래 크기
};

let cache = null;
export function settings() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    const s = JSON.parse(localStorage.getItem('norae.settings') || '{}');
    for (const k of Object.keys(DEFAULTS)) if (k in s && typeof s[k] === typeof DEFAULTS[k]) cache[k] = s[k];
  } catch { /* 저장소를 못 쓰면 기본값으로 */ }
  return cache;
}
export function saveSettings(patch) {
  Object.assign(settings(), patch);
  try { localStorage.setItem('norae.settings', JSON.stringify(cache)); } catch { /* 무시해도 앱은 돈다 */ }
}

export const LEVELS = {
  easy: { name: '쉬움', tol: 1.6 },
  normal: { name: '보통', tol: 1.0 },
  hard: { name: '어려움', tol: 0.6 },
};

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
export function choseong(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) out += CHO[Math.floor((c - 0xac00) / 588)];
    else out += ch;
  }
  return out;
}
const ONLY_CHO = /^[ㄱ-ㅎ\s]+$/;
export function matches(query, text) {
  const q = query.normalize('NFC').toLowerCase().replace(/\s+/g, '');
  if (!q) return true;
  const t = text.normalize('NFC').toLowerCase().replace(/\s+/g, '');
  if (t.includes(q)) return true;
  if (ONLY_CHO.test(q)) return choseong(t).includes(q);
  return false;
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

// 앱 전체가 함께 쓰는 소리 장치
let sharedCtx = null;
export function audioCtx() {
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext({ latencyHint: 'interactive' });
  return sharedCtx;
}

export function toast(msg, ms = 2600) {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}
