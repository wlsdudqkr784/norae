// 곡 저장소 — IndexedDB. 목록(songs)과 큰 파일(blobs)을 나눠 목록이 빨리 뜨게 한다.
import { parseUltraStar } from './ultrastar.js';
import { listZip } from './zip.js';

const DB_NAME = 'norae';
const DB_VER = 1;
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    let out;
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('저장 취소됨'));
    out = fn(t);
  }));
}

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export async function allSongs() {
  const d = await db();
  return req(d.transaction('songs').objectStore('songs').getAll());
}

export async function getSong(id) {
  const d = await db();
  return req(d.transaction('songs').objectStore('songs').get(id));
}

export async function getBlob(key) {
  const d = await db();
  return req(d.transaction('blobs').objectStore('blobs').get(key));
}

export async function updateSong(song) {
  await tx('songs', 'readwrite', (t) => t.objectStore('songs').put(song));
}

export async function deleteSong(id) {
  await tx(['songs', 'blobs'], 'readwrite', (t) => {
    t.objectStore('songs').delete(id);
    t.objectStore('blobs').delete(id + ':audio');
    t.objectStore('blobs').delete(id + ':cover');
    t.objectStore('blobs').delete(id + ':take');
    t.objectStore('blobs').delete(id + ':vocals');
  });
}

export async function putBlob(key, blob) {
  await tx('blobs', 'readwrite', (t) => t.objectStore('blobs').put(blob, key));
}

export async function deleteAll() {
  await tx(['songs', 'blobs'], 'readwrite', (t) => {
    t.objectStore('songs').clear();
    t.objectStore('blobs').clear();
  });
}

async function saveSong(meta, audioBlob, coverBlob, vocalsBlob) {
  await tx(['songs', 'blobs'], 'readwrite', (t) => {
    t.objectStore('songs').put(meta);
    t.objectStore('blobs').put(audioBlob, meta.id + ':audio');
    if (vocalsBlob) t.objectStore('blobs').put(vocalsBlob, meta.id + ':vocals');
    else t.objectStore('blobs').delete(meta.id + ':vocals');
    if (coverBlob) t.objectStore('blobs').put(coverBlob, meta.id + ':cover');
    else t.objectStore('blobs').delete(meta.id + ':cover');
  });
}

// ---------- 넣기 ----------

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav|flac|webm)$/i;
const IMG_EXT = /\.(jpe?g|png|webp)$/i;

function base(name) {
  const s = name.replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}
function stem(name) { return base(name).replace(/\.[^.]+$/, ''); }
function dir(name) { const s = name.replace(/\\/g, '/'); return s.slice(0, s.lastIndexOf('/') + 1); }
function norm(s) { return s.normalize('NFC').toLowerCase().trim(); }

export function decodeText(buf) {
  // UTF-16(메모장 '유니코드' 저장) — 앞 표시(BOM)를 먼저 본다. TextDecoder 가 BOM 은 스스로 뗀다 (11-22 감사)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  // BOM 없는 UTF-16: 앞쪽 바이트에 0 이 많다('#'·영문·숫자가 0 과 짝지어 있음). UTF-8·EUC-KR 글에는 0 이 없다
  if (buf.length >= 8) {
    let ev = 0, od = 0;
    const n = Math.min(buf.length & ~1, 400);
    for (let i = 0; i < n; i += 2) { if (buf[i] === 0) ev++; if (buf[i + 1] === 0) od++; }
    if (ev + od > n * 0.1) return new TextDecoder(od >= ev ? 'utf-16le' : 'utf-16be').decode(buf);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* 아래로 */ }
  try { return new TextDecoder('euc-kr').decode(buf); } catch { return new TextDecoder('latin1').decode(buf); }
}

// 같은 곡을 다시 넣으면 덮어쓰게, 제목+가수로 id 를 만든다
function songId(title, artist) {
  const s = norm(title) + '\u0001' + norm(artist);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 's' + (h >>> 0).toString(36);
}

// 소리 파일이 이보다 작으면 비었거나 깨진 것으로 본다(실제 곡은 수백 KB 넘음). 머리 바이트는 형식마다 달라 보지 않는다
const MIN_AUDIO_BYTES = 1024;

// files: File[] (zip 섞여도 됨). onProgress(text).
// 돌려줌: {added:[제목], warned:[{name, why}], failed:[{name, why}]}
//   warned = 넣었지만 알려야 할 것(가이드 목소리 없음·악보 자료 안 맞음·못 읽은 음 줄 등) (11-22 감사)
export async function importFiles(files, onProgress = () => {}) {
  const added = [], warned = [], failed = [];
  // 모든 항목을 {name, size, getBlob} 로 편다. 망가진 zip 하나는 그것만 실패로 적고 나머지는 넣는다 (11-22 감사)
  const items = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      onProgress(`zip 여는 중: ${f.name}`);
      try {
        const ents = await listZip(f);
        for (const e of ents) items.push(e);
      } catch (e) {
        console.warn('zip 을 열 수 없음', f.name, e);
        failed.push({ name: f.name, why: 'zip 을 열 수 없음(덜 받아졌거나 망가짐): ' + (e.message || e) });
      }
    } else {
      const path = f.webkitRelativePath || f.name;
      items.push({ name: path, size: f.size, getBlob: async () => f });
    }
  }

  const allTxts = items.filter((i) => /\.txt$/i.test(i.name));
  const txts = allTxts.filter((i) => i.size < 2_000_000);
  const bigTxts = allTxts.filter((i) => i.size >= 2_000_000);
  const audios = items.filter((i) => AUDIO_EXT.test(i.name));
  const imgs = items.filter((i) => IMG_EXT.test(i.name));
  const scores = items.filter((i) => /\.json$/i.test(i.name) && i.size < 5_000_000);
  const notSong = []; // #BPM 이 없어 건너뛴 txt(설명 파일 등)

  const existing = new Map((await allSongs()).map((s) => [s.id, s]));

  let k = 0;
  for (const t of txts) {
    k++;
    onProgress(`곡 넣는 중 ${k}/${txts.length}: ${stem(t.name)}`);
    try {
      const text = decodeText(new Uint8Array(await (await t.getBlob()).arrayBuffer()));
      // UltraStar 가 아닌 txt (설명 파일 등)는 건너뛴다. 머리(#TITLE 등)는 있는데 #BPM 만 없으면 아래 읽기에서 실패로 적힌다
      if (!/#BPM/i.test(text) && !/^\s*#(TITLE|ARTIST|AUDIO|MP3)\s*:/im.test(text)) { notSong.push(base(t.name)); continue; }
      const song = parseUltraStar(text);
      const name = base(t.name);
      const warn = (why) => warned.push({ name: song.title || name, why });
      const ap = findPartner(t, [song.audio, song.mp3], audios);
      if (!ap) {
        // 반주 파일이 없을 때 txt 와 같은 이름의 소리(보통 원곡)를 대신 쓰지 않는다 — 원곡은 틀지 않는다(사용자 결정)
        const same = song.audio && audios.find((p) => norm(stem(p.name)) === norm(stem(t.name)) && norm(dir(p.name)) === norm(dir(t.name)));
        failed.push({ name, why: `소리 파일(${song.audio || stem(t.name) + '.mp3'})을 못 찾음` + (same ? ` — 같은 이름의 ${base(same.name)} 는 원곡일 수 있어 쓰지 않음` : '') });
        continue;
      }
      const audio = ap.item;
      if (ap.guess) warn(`소리 파일 이름이 적혀 있지 않아 ${base(audio.name)} 을(를) 씀`);
      else if (ap.ext) warn(`${song.audio} 대신 확장자만 다른 ${base(audio.name)} 을(를) 씀`);
      const cp = song.cover ? findPartner(t, song.cover, imgs) : null;
      const cover = cp ? cp.item : null;
      const id = songId(song.title, song.artist);
      const old = existing.get(id);
      const audioBlob = await audio.getBlob();
      if (!audioBlob || audioBlob.size < MIN_AUDIO_BYTES) {
        failed.push({ name, why: `소리 파일(${base(audio.name)})이 비었거나 깨짐 (${audioBlob ? audioBlob.size : 0}바이트)` });
        continue;
      }
      if (song.skippedLines) warn(`읽지 못한 음 줄 ${song.skippedLines}개 (그 음은 빠짐)`);
      // 노래방 악보(<곡>.악보.json) — 없거나 안 맞으면 음 줄 화면만 쓴다(실패로 치지는 않지만 알린다)
      let score = null, scoreWhy = '';
      const sItem = findScore(t, scores);
      if (sItem) {
        try {
          const sj = JSON.parse(decodeText(new Uint8Array(await (await sItem.getBlob()).arrayBuffer())));
          if (sj && sj.v === 1 && Array.isArray(sj.notes) && sj.notes.length === song.notes.length) score = sj;
          else if (!sj || sj.v !== 1 || !Array.isArray(sj.notes)) scoreWhy = '악보 자료의 판이 맞지 않음';
          else scoreWhy = `악보 자료가 곡과 안 맞음 (json ${sj.notes.length}음 / txt ${song.notes.length}음)`;
        } catch (e) { console.warn('악보 자료를 못 읽음', base(sItem.name), e); scoreWhy = '악보 자료를 못 읽음'; }
      } else scoreWhy = '악보 자료(.악보.json)가 없음';
      if (!score) {
        // 악보(txt)가 그대로면 전에 넣은 맞는 악보 자료를 지우지 않고 그대로 쓴다
        if (old?.score && old.txt === text && Array.isArray(old.score.notes) && old.score.notes.length === song.notes.length) {
          score = old.score;
          if (sItem) warn(scoreWhy + ' — 전에 넣은 악보 자료를 그대로 씀');
          scoreWhy = '';
        } else {
          if (sItem) console.warn(scoreWhy, base(sItem.name));
          warn(scoreWhy + ' — 노래방 악보 대신 음 줄 화면으로' + (sItem ? ' (변환기로 다시 만들어 주세요)' : ''));
        }
      }
      // 가이드 목소리(#VOCALS) — 이름이 꼭 같은 파일만(같은 이름 짐작으로 반주·원곡을 잘못 집지 않게). 반주와 같은 파일이면 안 씀
      const vItem = song.vocals ? audios.find((p) => norm(base(p.name)) === norm(base(song.vocals)) && norm(dir(p.name)) === norm(dir(t.name))) : null;
      let vocals = vItem && vItem !== audio ? vItem : null;
      let vocalsBlob = vocals ? await vocals.getBlob() : null;
      if (vocals && (!vocalsBlob || vocalsBlob.size < MIN_AUDIO_BYTES)) {
        warn(`가이드 목소리 파일(${base(vocals.name)})이 비었거나 깨져 가이드 목소리 없이 넣음`);
        vocals = null; vocalsBlob = null;
      } else if (song.vocals && !vItem) warn(`가이드 목소리 파일(${base(song.vocals)})을 못 찾아 가이드 목소리 없이 넣음`);
      const meta = {
        id,
        title: song.title,
        artist: song.artist,
        txt: text,
        audioName: base(audio.name),
        audioType: guessType(audio.name),
        hasCover: !!cover,
        durationMs: song.lines[song.lines.length - 1].end,
        noteCount: song.notes.length,
        added: old?.added || Date.now(),
        updated: Date.now(),     // 넣은(다시 넣은) 때 — 풀어 둔 소리 캐시를 가르는 데 쓴다(main.js loadSong)
        best: old?.best || 0,
        plays: old?.plays || 0,
        lastPlayed: old?.lastPlayed || 0,
        fav: !!old?.fav,
        take: old?.take || null, // 내 노래 녹음 정보(소리는 blobs 의 id:take)
        score,                   // 노래방 악보 자료(없으면 null)
        scoreWhy,                // 악보 자료가 없는 까닭(있으면 '')
        hasVocals: !!vocals,     // 가이드 목소리가 있나(소리는 blobs 의 id:vocals)
        vocalsName: vocals ? base(vocals.name) : '',
      };
      await saveSong(meta, new Blob([audioBlob], { type: meta.audioType }), cover ? await cover.getBlob() : null,
        vocals ? new Blob([vocalsBlob], { type: guessType(vocals.name) }) : null);
      added.push(song.title);
    } catch (e) {
      console.warn('곡 넣기 실패', t.name, e);
      failed.push({ name: base(t.name), why: e.message || String(e) });
    }
  }
  // 아무것도 못 넣었는데 까닭이 안 적혔으면 적는다(조용히 '넣은 곡이 없습니다' 만 뜨지 않게)
  if (!added.length && !failed.length) {
    if (bigTxts.length) failed.push({ name: bigTxts.map((i) => base(i.name)).slice(0, 3).join(', '), why: '.txt 가 2MB 넘어 악보로 보지 않고 건너뜀' });
    if (notSong.length) failed.push({ name: notSong.slice(0, 3).join(', ') + (notSong.length > 3 ? ` 외 ${notSong.length - 3}개` : ''), why: `읽은 txt ${notSong.length}개가 UltraStar 악보가 아님(#BPM 없음)` });
    if (!failed.length) failed.push({ name: '(고른 파일)', why: '.txt 악보 파일이 없음' });
  }
  return { added, warned, failed };
}

function findScore(txtItem, pool) {
  const d = norm(dir(txtItem.name));
  const want = norm(stem(txtItem.name)) + '.악보';
  const hits = pool.filter((p) => norm(stem(p.name)) === want);
  return hits.find((p) => norm(dir(p.name)) === d) || hits[0] || null;
}

// 돌려줌: {item, ext?, guess?} 또는 null.
//   wanted(#AUDIO·#MP3·#COVER)가 적혀 있으면 그 이름(확장자만 다른 것까지)만 받는다 — txt 와 같은 이름(보통 원곡)이나
//   '폴더에 하나뿐' 짐작으로 다른 소리를 집지 않게 (11-22 감사). 짐작은 이름이 안 적힌 옛 txt 에만 쓴다(guess 표시).
function findPartner(txtItem, wanted, pool) {
  const d = norm(dir(txtItem.name));
  const sameDir = pool.filter((p) => norm(dir(p.name)) === d);
  const cands = [sameDir, pool];
  const wants = (Array.isArray(wanted) ? wanted : [wanted]).filter(Boolean);
  if (wants.length) {
    for (const wn of wants) {
      const w = norm(base(wn));
      for (const c of cands) { const hit = c.find((p) => norm(base(p.name)) === w); if (hit) return { item: hit }; }
    }
    for (const wn of wants) {
      const ws = norm(stem(wn));
      for (const c of cands) { const hit = c.find((p) => norm(stem(p.name)) === ws); if (hit) return { item: hit, ext: true }; }
    }
    return null;
  }
  const ts = norm(stem(txtItem.name));
  for (const c of cands) { const hit = c.find((p) => norm(stem(p.name)) === ts); if (hit) return { item: hit, guess: true }; }
  // 같은 폴더에 하나뿐이면 그것
  return sameDir.length === 1 && d ? { item: sameDir[0], guess: true } : null;
}

function guessType(name) {
  const e = name.toLowerCase().split('.').pop();
  return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[e] || '';
}

export async function storageInfo() {
  try {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { used: est.usage || 0, quota: est.quota || 0, persisted };
  } catch { return null; }
}

export async function askPersist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* 지원 안 함 */ }
  return false;
}
