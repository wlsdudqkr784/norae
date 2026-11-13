// 곡 목록 · 곡 넣기 · 설정 화면, 주소(#)로 화면 바꾸기.
//   #/ 목록 · #/play/<id> 부르기 · #/take/<id> 내 노래 듣기 · #/settings 설정
import { settings, saveSettings, LEVELS, matches, fmtTime, el, toast, audioCtx } from './util.js';
import { allSongs, getSong, getBlob, updateSong, deleteSong, deleteAll, importFiles, storageInfo, askPersist } from './library.js';
import { parseUltraStar } from './ultrastar.js';
import { Session, releaseMic, listMics } from './game.js';
import { TakePlayer } from './take.js';
import { MicTest } from './mictest.js';
import { VOICES } from './pitch.js';
import { CALIB_TITLE, CALIB_LINES, isCalibSong } from './calib.js';

// 여기까지 왔으면 모든 파일을 제대로 읽은 것 — index.html 의 '안 열림' 단추가 뜨지 않게(11-14)
window.__noraeStarted = true;
const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';

const ICON = {
  add: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.8z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" class="fill"/><circle cx="12" cy="12" r="1.6" class="fill"/><circle cx="19" cy="12" r="1.6" class="fill"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M16 16l4.5 4.5"/></svg>',
  // 빈 목록 그림: 오선 다섯 줄 위에 이은 8분음표 둘
  emptyArt: '<svg class="empty-art" viewBox="0 0 88 88"><g class="soft"><path d="M6 30h76M6 40h76M6 50h76M6 60h76M6 70h76"/></g><path d="M36 62V24l30-6v38"/><path d="M36 30l30-6" stroke-width="5"/><ellipse cx="29.5" cy="62" rx="7" ry="5.2" transform="rotate(-20 29.5 62)" class="fill"/><ellipse cx="59.5" cy="56" rx="7" ry="5.2" transform="rotate(-20 59.5 56)" class="fill"/></svg>',
};

let cleanup = null;   // 지금 화면을 떠날 때 할 일
let songs = [];       // 목록 캐시
let query = '';       // 검색어(화면을 오가도 남게)

// ---------- 화면 바꾸기 ----------
function go(hash) { location.hash = hash; }

async function route() {
  if (cleanup) { try { cleanup(); } catch (e) { console.warn('화면 정리 실패', e); } cleanup = null; }
  closeSheet();
  app.className = '';
  const h = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  try {
    if (name === 'play' && arg) await showPlay(arg);
    else if (name === 'calib' && arg) await showPlay(arg, { calib: true });
    else if (name === 'take' && arg) await showTake(arg);
    else if (name === 'settings') showSettings();
    else await showList();
  } catch (e) {
    console.error('화면 열기 실패', e);
    toast('화면을 열지 못했습니다: ' + (e.message || e));
    if (name) go('#/'); else app.replaceChildren(el('p', { class: 'empty' }, '목록을 열지 못했습니다. 새로고침해 주세요.'));
  }
}

function loading(text) {
  app.replaceChildren(el('div', { class: 'loading' }, el('div', { class: 'spinner' }), el('p', {}, text)));
}

// 곡 소리를 풀어 둔 것 — 같은 곡을 다시 열 때 빨리 뜨게 하나만 기억한다
let decoded = { id: null, stamp: 0, buffer: null };
async function loadSong(id) {
  const meta = await getSong(id);
  if (!meta) throw new Error('곡이 없습니다');
  const song = parseUltraStar(meta.txt);
  const stamp = meta.added + ':' + meta.audioName + ':' + (meta.vocalsName || '');
  if (decoded.id !== id || decoded.stamp !== stamp) {
    decoded = { id: null, stamp: 0, buffer: null, vocals: null };
    const blob = await getBlob(id + ':audio');
    if (!blob) throw new Error('곡의 소리 파일이 없습니다. 곡을 다시 넣어 주세요');
    const buffer = await audioCtx().decodeAudioData(await blob.arrayBuffer());
    // 가이드 목소리 — 못 읽어도 노래는 된다(가이드 목소리만 없다)
    let vocals = null;
    if (meta.hasVocals) {
      try {
        const vb = await getBlob(id + ':vocals');
        if (vb) vocals = await audioCtx().decodeAudioData(await vb.arrayBuffer());
      } catch (e) { console.warn('가이드 목소리를 못 읽음', e); }
    }
    decoded = { id, stamp, buffer, vocals };
  }
  return { meta, song, buffer: decoded.buffer, vocals: decoded.vocals };
}

// ---------- 부르기 ----------
async function showPlay(id, extra = {}) {
  loading('곡 불러오는 중…');
  let gone = false;
  cleanup = () => { gone = true; };
  const { meta, song, buffer, vocals } = await loadSong(id);
  const opts = { vocals, ...extra };
  if (params.get('fakedelay')) opts.fakeDelay = Number(params.get('fakedelay')) || 0;   // 시험용
  if (params.get('fakemic')) {
    // 시험용: 마이크 대신 목소리 파일을 흘린다
    const r = await fetch(params.get('fakemic'));
    if (!r.ok) throw new Error('시험 목소리 파일을 못 읽음 ' + r.status);
    opts.fakeMic = await audioCtx().decodeAudioData(await r.arrayBuffer());
  }
  if (gone) return;
  app.replaceChildren();
  const root = el('div', {});
  app.append(root);
  const session = new Session(root, meta, song, buffer, opts);
  if (TEST) window.__session = session;
  cleanup = () => { session.destroy(); releaseMic(); };
}

// ---------- 내 노래 듣기 (목록에서) ----------
async function showTake(id) {
  loading('곡 불러오는 중…');
  let gone = false;
  cleanup = () => { gone = true; };
  const { meta, buffer } = await loadSong(id);
  if (gone) return;
  if (!meta.take) { toast('이 곡은 녹음이 없습니다'); history.back(); return; }
  const player = new TakePlayer(meta, buffer, () => history.back());
  if (TEST) window.__take = player;
  app.replaceChildren(el('div', { class: 'page center' }, player.node));
  cleanup = () => player.destroy();
}

// ---------- 목록 ----------
async function showList() {
  songs = await allSongs();
  const s = settings();
  const listEl = el('div', { class: 'songs', role: 'list' });
  const countEl = el('span', { class: 'count' });
  const search = el('input', { type: 'search', placeholder: '제목·가수 검색 (초성도 됨: ㅅㄹㅇㄱ)', value: query, 'aria-label': '곡 검색', enterkeyhint: 'search', autocomplete: 'off' });
  search.addEventListener('input', () => { query = search.value; draw(); });

  const sortSeg = el('div', { class: 'seg small', role: 'radiogroup', 'aria-label': '정렬' });
  for (const [k, name] of [['title', '이름순'], ['recent', '최근순'], ['best', '점수순']]) {
    const b = el('button', { class: s.sort === k ? 'on' : '', role: 'radio', 'aria-checked': String(s.sort === k), onclick: () => {
      saveSettings({ sort: k });
      sortSeg.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      draw();
    } }, name);
    sortSeg.append(b);
  }
  const favChip = el('button', { class: 'chip fav' + (s.favOnly ? ' on' : ''), 'aria-pressed': String(s.favOnly), html: ICON.star + '<span>즐겨찾기</span>', onclick: () => {
    saveSettings({ favOnly: !settings().favOnly });
    favChip.classList.toggle('on', settings().favOnly);
    favChip.setAttribute('aria-pressed', String(settings().favOnly));
    draw();
  } });

  const fileInput = el('input', { type: 'file', multiple: true, hidden: true });
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length) await doImport(files);
  });
  const pick = () => fileInput.click();

  function draw() {
    const st = settings();
    let list = songs.filter((x) => (!st.favOnly || x.fav) && (matches(query, x.title) || matches(query, x.artist || '')));
    const byTitle = (a, b) => a.title.localeCompare(b.title, 'ko');
    if (st.sort === 'recent') list.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || byTitle(a, b));
    else if (st.sort === 'best') list.sort((a, b) => (b.best || 0) - (a.best || 0) || byTitle(a, b));
    else list.sort(byTitle);
    countEl.textContent = list.length === songs.length ? `${songs.length}곡` : `${list.length} / ${songs.length}곡`;
    listEl.replaceChildren();
    if (!songs.length) {
      // 빈 목록: 그림 하나 + 넣는 순서 세 단계 + 곡 넣기 (11-13 디자인)
      listEl.append(el('div', { class: 'empty' },
        el('span', { 'aria-hidden': 'true', html: ICON.emptyArt }),
        el('h2', {}, '아직 곡이 없습니다'),
        el('ol', { class: 'steps' },
          el('li', {}, el('span', {}, 'PC 에서 ', el('b', {}, '연습 앱에 넣을 zip 만들기.py'), ' 를 더블클릭')),
          el('li', {}, el('span', {}, '생긴 ', el('b', {}, '연습 앱용 곡 묶음.zip'), ' 을 폰으로 옮기기')),
          el('li', {}, el('span', {}, '아래 ', el('b', {}, '곡 넣기'), ' 에서 그 zip 을 고르기')),
        ),
        el('button', { class: 'primary', onclick: pick }, '곡 넣기'),
        el('p', { class: 'hint' }, '악보(.txt)와 노래(.mp3)를 함께 골라도 됩니다.'),
      ));
      return;
    }
    if (!list.length) { listEl.append(el('p', { class: 'empty' }, st.favOnly && !query ? '즐겨찾기한 곡이 없습니다. 곡의 ★ 를 눌러 보세요.' : '찾는 곡이 없습니다.')); return; }
    for (const m of list) listEl.append(card(m));
  }

  function card(m) {
    const star = el('button', { class: 'icon-btn star' + (m.fav ? ' on' : ''), 'aria-label': '즐겨찾기', 'aria-pressed': String(!!m.fav), html: ICON.star, onclick: async (e) => {
      e.stopPropagation();
      m.fav = !m.fav;
      star.classList.toggle('on', m.fav);
      star.setAttribute('aria-pressed', String(m.fav));
      try { await updateSong(m); } catch (err) { console.warn('즐겨찾기 저장 실패', err); toast('저장하지 못했습니다'); }
      if (settings().favOnly) draw();
    } });
    const more = el('button', { class: 'icon-btn more', 'aria-label': '더 보기', html: ICON.more, onclick: (e) => { e.stopPropagation(); songMenu(m); } });
    const sub = [m.artist, fmtTime(m.durationMs), m.take ? '녹음 있음' : ''].filter(Boolean).join(' · ');
    const main = el('button', { class: 'song-main', onclick: () => go('#/play/' + encodeURIComponent(m.id)) },
      el('b', {}, m.title),
      el('small', {}, sub),
    );
    // 최고 점수 표: 기록이 있을 때만 (없을 때 '— 기록 없음' 을 곡마다 붙이면 시끄럽다). 색은 결과 화면 한마디와 같은 기준
    const best = m.best ? el('span', { class: 'best' + (m.best >= 7500 ? ' g1' : m.best >= 5500 ? ' g2' : ''), title: '최고 점수', 'aria-label': `최고 ${m.best.toLocaleString()}점` }, m.best.toLocaleString()) : null;
    const row = el('div', { class: 'song', role: 'listitem' }, star, main, best, more);
    // 길게 누르면 메뉴
    let hold = null;
    main.addEventListener('pointerdown', () => { hold = setTimeout(() => { hold = 'done'; songMenu(m); }, 550); });
    const cancel = () => { if (hold !== 'done') clearTimeout(hold); };
    main.addEventListener('pointerup', cancel);
    main.addEventListener('pointerleave', cancel);
    main.addEventListener('pointercancel', cancel);
    main.addEventListener('click', (e) => { if (hold === 'done') { e.stopImmediatePropagation(); e.preventDefault(); hold = null; } }, true);
    main.addEventListener('contextmenu', (e) => e.preventDefault());
    return row;
  }

  function songMenu(m) {
    openSheet(m.title, [
      { text: '부르기', act: () => go('#/play/' + encodeURIComponent(m.id)) },
      m.take ? { text: '내 노래 듣기', act: () => go('#/take/' + encodeURIComponent(m.id)) } : null,
      { text: m.fav ? '즐겨찾기 빼기' : '즐겨찾기에 넣기', act: async () => { m.fav = !m.fav; await updateSong(m); draw(); } },
      { text: '이 곡 지우기', danger: true, act: () => confirmSheet(`‘${m.title}’ 을(를) 지울까요?`, '최고 점수와 녹음도 함께 지워집니다.', '지우기', async () => {
        await deleteSong(m.id);
        songs = songs.filter((x) => x.id !== m.id);
        draw();
        toast('지웠습니다');
      }) },
    ]);
  }

  async function doImport(files) {
    const box = el('div', { class: 'card' }, el('h2', {}, '곡 넣는 중'), el('div', { class: 'spinner' }));
    const line = el('p', { class: 'muted' }, '준비 중…');
    box.append(line);
    const ov = el('div', { class: 'overlay show' }, box);
    document.body.append(ov);
    let res;
    try {
      if (!songs.length) await askPersist();
      res = await importFiles(files, (t) => { line.textContent = t; });
    } catch (e) {
      console.error('곡 넣기 실패', e);
      res = { added: [], failed: [{ name: '(전체)', why: e.message || String(e) }] };
    }
    songs = await allSongs();
    draw();
    // replaceChildren 은 null 을 글자 "null" 로 넣는다 → 빈 칸은 걸러 낸다 (11-13 화면 검토)
    box.replaceChildren(...[
      el('h2', {}, res.added.length ? `${res.added.length}곡 넣었습니다` : '넣은 곡이 없습니다'),
      res.added.length ? el('p', { class: 'muted' }, res.added.slice(0, 6).join(', ') + (res.added.length > 6 ? ` 외 ${res.added.length - 6}곡` : '')) : null,
      res.failed.length ? el('div', { class: 'fails' }, el('b', {}, `못 넣은 것 ${res.failed.length}개`), el('ul', {}, res.failed.slice(0, 30).map((f) => el('li', {}, `${f.name} — ${f.why}`)))) : null,
      el('button', { class: 'primary', onclick: () => ov.remove() }, '확인'),
    ].filter(Boolean));
    return res;
  }

  if (TEST) {
    // 시험용: 주소로 파일을 가져와 넣는다 (내장 브라우저는 파일 고르기 창을 못 다룬다)
    window.__importUrls = async (urls) => {
      const files = [];
      for (const u of urls) {
        const r = await fetch(u);
        if (!r.ok) throw new Error(u + ' ' + r.status);
        files.push(new File([await r.blob()], decodeURIComponent(u.split('/').pop())));
      }
      const res = await doImport(files);
      return res;
    };
  }

  app.replaceChildren(el('div', { class: 'page' },
    el('header', { class: 'topbar' },
      el('h1', {}, '노래 연습'),
      countEl,
      el('button', { class: 'icon-btn', 'aria-label': '곡 넣기', html: ICON.add, onclick: pick }),
      el('button', { class: 'icon-btn', 'aria-label': '설정', html: ICON.gear, onclick: () => go('#/settings') }),
    ),
    el('div', { class: 'tools' },
      el('label', { class: 'search', html: ICON.search }, search),
      el('div', { class: 'filters' }, sortSeg, favChip),
    ),
    listEl,
    fileInput,
  ));
  draw();
}

// ---------- 아래에서 올라오는 메뉴 ----------
let sheet = null;
function closeSheet() { if (sheet) { sheet.remove(); sheet = null; } }
function openSheet(title, items, note) {
  closeSheet();
  const box = el('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
    el('b', { class: 'sheet-title' }, title),
    note ? el('p', { class: 'muted' }, note) : null,
    items.filter(Boolean).map((it) => el('button', { class: it.danger ? 'danger' : (it.primary ? 'primary' : ''), onclick: async () => {
      closeSheet();
      try { await it.act(); } catch (e) { console.error('메뉴 실행 실패', e); toast('하지 못했습니다: ' + (e.message || e)); }
    } }, it.text)),
    el('button', { class: 'cancel', onclick: closeSheet }, '취소'),
  );
  sheet = el('div', { class: 'sheet-bg', onclick: (e) => { if (e.target === sheet) closeSheet(); } }, box);
  document.body.append(sheet);
}
function confirmSheet(title, note, yes, act) {
  openSheet(title, [{ text: yes, danger: true, act }], note);
}

// ---------- 설정 ----------
function showSettings() {
  const s = settings();
  let calib = null;

  const seg = (label, key, options) => {
    const wrap = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
    for (const [v, name] of options) {
      const b = el('button', { class: s[key] === v ? 'on' : '', role: 'radio', 'aria-checked': String(s[key] === v), onclick: () => {
        saveSettings({ [key]: v });
        wrap.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      } }, name);
      wrap.append(b);
    }
    return el('div', { class: 'field col' }, el('span', {}, label), wrap);
  };
  const range = (label, key, min, max, step, show, hint) => {
    const out = el('span', { class: 'val' }, show(s[key]));
    const inp = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(s[key]), 'aria-label': label });
    inp.addEventListener('input', () => { const v = Number(inp.value); saveSettings({ [key]: v }); out.textContent = show(v); });
    return el('label', { class: 'field col' }, el('span', {}, label, out), inp, hint ? el('small', { class: 'hint' }, hint) : null);
  };
  const pct = (v) => Math.round(v * 100) + '%';

  // 이어폰 지연
  const latVal = el('b', { class: 'val' });
  const showLat = () => {
    const v = settings().outLatency;
    const c = audioCtx();
    const dev = Math.round(((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000);
    latVal.textContent = v < 0 ? `기기 값 (${dev}ms)` : `${v}ms`;
  };
  const bump = (d) => {
    const c = audioCtx();
    const cur = settings().outLatency < 0 ? Math.round(((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000) : settings().outLatency;
    saveSettings({ outLatency: Math.max(0, Math.min(600, cur + d)) });
    showLat();
  };
  const calBox = el('div', { class: 'calib' });
  let calBtn = null;
  const startCalib = async () => {
    if (calib) return;
    const c = audioCtx();
    try { await c.resume(); } catch (e) { console.warn('소리 켜기 실패', e); }
    const N = 16, GAP = 0.5, first = c.currentTime + 1.0;
    const clicks = [];
    const nodes = [];
    for (let i = 0; i < N; i++) {
      const t = first + i * GAP;
      clicks.push(t);
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = i % 4 === 0 ? 1500 : 1000;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.5, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + 0.08);
      nodes.push(o);
    }
    const taps = [];
    const msg = el('p', {}, `딸깍 소리에 맞춰 아래를 두드리세요 (0 / ${N})`);
    const pad = el('button', { class: 'tap-pad' }, '여기를 두드리기');
    const tap = (e) => { e.preventDefault(); taps.push(c.currentTime); pad.classList.add('hit'); setTimeout(() => pad.classList.remove('hit'), 90); msg.textContent = `두드린 횟수 ${Math.min(taps.length, N)} / ${N}`; };
    pad.addEventListener('pointerdown', tap);
    calBtn.disabled = true;  // 맞추는 동안 다시 누르지 못하게
    const stop = (text) => {
      clearTimeout(calib.timer);
      for (const o of nodes) { try { o.stop(); } catch { /* 이미 끝남 */ } }
      calib = null;
      calBtn.disabled = false;
      calBox.replaceChildren(text ? el('p', { class: 'hint' }, text) : '');
    };
    const finish = () => {
      // 두드림마다 가장 가까운 딸깍과의 차이 — 앞 4번은 버린다
      const diffs = [];
      for (const t of taps) {
        const i = Math.round((t - first) / GAP);
        if (i < 4 || i >= N) continue;
        diffs.push((t - clicks[i]) * 1000);
      }
      if (diffs.length < 6) { stop('두드린 횟수가 모자랍니다. 다시 해 보세요.'); return; }
      diffs.sort((a, b) => a - b);
      const med = diffs[Math.floor(diffs.length / 2)];
      const v = Math.max(0, Math.min(600, Math.round(med)));
      saveSettings({ outLatency: v });
      showLat();
      stop(`맞췄습니다: ${v}ms (${diffs.length}번 두드림의 가운데 값)`);
    };
    calib = { timer: setTimeout(finish, (first - c.currentTime + N * GAP + 0.4) * 1000), stop };
    calBox.replaceChildren(msg, pad, el('button', { class: 'secondary', onclick: () => stop('그만두었습니다.') }, '그만'));
  };
  calBtn = el('button', { class: 'secondary', onclick: startCalib }, '두드려서 맞추기');

  // 노래로 맞추기(11-14 사용자): 시험 곡은 '가자 때가 됐다' 하나로 고정, 첫 4줄만
  const startSongCalib = async () => {
    const s = (await allSongs()).find((x) => isCalibSong(x.title));
    if (!s) { toast(`'${CALIB_TITLE}'를 먼저 곡 목록에 넣어 주세요`); return; }
    go('#/calib/' + encodeURIComponent(s.id));
  };

  // 저장 공간
  const storeEl = el('p', { class: 'muted' }, '저장 공간 확인 중…');
  const mb = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + 'GB' : Math.round(n / 1e6) + 'MB');
  const showStore = async () => {
    const [info, list] = [await storageInfo(), await allSongs()];
    storeEl.textContent = info
      ? `곡 ${list.length}개 · ${mb(info.used)} 씀 / ${mb(info.quota)} 중 · ${info.persisted ? '지워지지 않게 보호됨' : '보호 안 됨(공간이 모자라면 브라우저가 지울 수 있음)'}`
      : `곡 ${list.length}개 · 저장 공간 정보를 알 수 없습니다`;
    protectBtn.hidden = !info || info.persisted;
  };
  const protectBtn = el('button', { class: 'secondary', hidden: true, onclick: async () => { const ok = await askPersist(); toast(ok ? '보호됩니다' : '브라우저가 허락하지 않았습니다 (홈 화면에 추가하면 됩니다)'); showStore(); } }, '지워지지 않게 보호 부탁하기');
  const wipe = () => confirmSheet('모든 곡을 지울까요?', '곡·최고 점수·녹음이 모두 지워집니다.', '모두 지우기',
    () => confirmSheet('정말 모두 지울까요?', '되돌릴 수 없습니다.', '네, 모두 지우기', async () => { await deleteAll(); toast('모두 지웠습니다'); showStore(); }));

  const echo = el('input', { type: 'checkbox', checked: s.echoCancel, onchange: (e) => saveSettings({ echoCancel: e.target.checked }) });

  // 마이크 고르기 (11-13: 마이크를 켜면 블루투스 이어폰 음질이 떨어짐 → 폰 마이크를 고르면 나아질 수 있다)
  const micTest = new MicTest();
  // 마이크를 바꾸면 시험 중이면 새 마이크로 다시 연다
  const micSel = el('select', { class: 'select', 'aria-label': '마이크', onchange: (e) => {
    saveSettings({ micId: e.target.value });
    const was = micTest.on;
    micTest.stop();
    releaseMic();
    if (was) micTest.start();
  } });
  const fillMics = async () => {
    const mics = await listMics();
    const cur = settings().micId;
    micSel.replaceChildren(el('option', { value: '' }, '기기 기본'), ...mics.map((m) => el('option', { value: m.id }, m.label)));
    if (cur && !mics.some((m) => m.id === cur)) micSel.append(el('option', { value: cur }, '전에 고른 마이크 (지금 없음)'));
    micSel.value = cur;
  };
  fillMics();

  // 목소리 기준 (11-14 사용자: 남자 낮은 도를 못 잡음 → 남자·여자 나눔). 바꾸면 시험 중인 마이크 시험도 새 기준으로
  const voiceSeg = seg('목소리 기준 (잡을 음 범위)', 'voice', Object.entries(VOICES).map(([k, v]) => [k, v.name]));
  voiceSeg.addEventListener('click', (e) => {
    if (e.target.closest('button') && micTest.on) { micTest.stop(); micTest.start(); }
  });

  app.replaceChildren(el('div', { class: 'page' },
    el('header', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '뒤로', html: ICON.back, onclick: () => history.back() }),
      el('h1', {}, '설정'),
    ),
    el('div', { class: 'settings' },
      el('section', {},
        el('h2', {}, '채점'),
        seg('난이도 (음이 얼마나 벗어나도 맞게 칠지)', 'level', Object.entries(LEVELS).map(([k, v]) => [k, v.name])),
        voiceSeg,
        el('small', { class: 'hint' }, '남자: 솔1(49Hz)까지 낮게 잡습니다. 여자: 100Hz(솔#2) 아래는 보지 않아 한 옥타브 낮게 잘못 잡는 일이 줄어듭니다.'),
        range('마이크 감도', 'micGate', 0.003, 0.05, 0.001, (v) => (v <= 0.008 ? '예민' : v <= 0.02 ? '보통' : '둔함'), '작은 소리도 잡으려면 왼쪽, 주변 소리가 잡히면 오른쪽.'),
        el('label', { class: 'toggle' }, echo, el('span', {}, '에코 줄이기 — 이어폰 없이 스피커로 들을 때만 켜세요')),
        el('label', { class: 'field col' }, el('span', {}, '마이크'), micSel,
          el('small', { class: 'hint' }, '블루투스 이어폰으로 들을 때 마이크를 켜면 소리가 나빠지면 폰 마이크(이어폰이 아닌 것)를 골라 보세요. 이름이 안 보이면 한 번 불러 본 뒤 다시 여세요.')),
        micTest.root,
      ),
      el('section', {},
        el('h2', {}, '소리 지연'),
        el('div', { class: 'field' }, el('span', {}, '이어폰 지연 ', latVal),
          el('div', { class: 'seg small' },
            el('button', { 'aria-label': '10밀리초 줄이기', onclick: () => bump(-10) }, '−10'),
            el('button', { 'aria-label': '10밀리초 늘리기', onclick: () => bump(10) }, '+10'),
            el('button', { onclick: () => { saveSettings({ outLatency: -1 }); showLat(); } }, '기기 값으로'),
          )),
        calBtn,
        calBox,
        el('p', { class: 'hint' }, '블루투스 이어폰은 소리가 0.15~0.3초 늦습니다. 악보의 세로줄이 노래보다 앞서가면 맞춰 주세요.'),
        el('button', { class: 'secondary', onclick: startSongCalib }, `노래로 맞추기 ('${CALIB_TITLE}' 첫 ${CALIB_LINES}줄)`),
        el('p', { class: 'hint' }, '부른 목소리가 악보보다 늦게 칠해지면(음이 한 줄로 끌림) 이것으로 맞추세요. 아래 마이크 지연이 맞춰집니다.'),
        range('마이크 지연 (고급)', 'micLatency', 0, 800, 5, (v) => v + 'ms'),
      ),
      el('section', {},
        el('h2', {}, '소리 크기'),
        range('노래', 'musicVol', 0, 1, 0.05, pct),
        range('가이드 음', 'guideVol', 0, 1, 0.05, pct),
      ),
      el('section', {},
        el('h2', {}, '저장 공간'),
        storeEl,
        protectBtn,
        el('button', { class: 'danger', onclick: wipe }, '모든 곡 지우기'),
      ),
      el('p', { class: 'hint ver' }, '노래 연습 · 개인용'),
    ),
  ));
  showLat();
  showStore();
  cleanup = () => { if (calib) calib.stop(''); micTest.stop(); };
}

// ---------- 시작 ----------
window.addEventListener('hashchange', route);
window.addEventListener('error', (e) => console.error('오류', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('처리 안 된 오류', e.reason));

// 부르기 화면으로 바로 들어와도 뒤로 가기가 목록으로 가게, 목록을 밑에 깔아 둔다
if (location.hash && location.hash !== '#/' && location.hash !== '#') {
  const want = location.hash;
  history.replaceState(null, '', '#/');
  location.hash = want; // hashchange 가 route 를 부른다
} else {
  route();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('오프라인 준비 실패', e));
}
