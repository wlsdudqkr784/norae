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

// files: File[] (zip 섞여도 됨). onProgress(text). 돌려줌: {added:[제목], failed:[{name, why}]}
export async function importFiles(files, onProgress = () => {}) {
  // 모든 항목을 {name, size, getBlob} 로 편다
  const items = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      onProgress(`zip 여는 중: ${f.name}`);
      const ents = await listZip(f);
      for (const e of ents) items.push(e);
    } else {
      const path = f.webkitRelativePath || f.name;
      items.push({ name: path, size: f.size, getBlob: async () => f });
    }
  }

  const txts = items.filter((i) => /\.txt$/i.test(i.name) && i.size < 2_000_000);
  const audios = items.filter((i) => AUDIO_EXT.test(i.name));
  const imgs = items.filter((i) => IMG_EXT.test(i.name));
  const scores = items.filter((i) => /\.json$/i.test(i.name) && i.size < 5_000_000);
  const added = [], failed = [];

  const existing = new Map((await allSongs()).map((s) => [s.id, s]));

  let k = 0;
  for (const t of txts) {
    k++;
    onProgress(`곡 넣는 중 ${k}/${txts.length}: ${stem(t.name)}`);
    try {
      const text = decodeText(new Uint8Array(await (await t.getBlob()).arrayBuffer()));
      if (!/#BPM/i.test(text)) continue; // UltraStar 가 아닌 txt (설명 파일 등)
      const song = parseUltraStar(text);
      const audio = findPartner(t, song.audio, audios);
      if (!audio) { failed.push({ name: base(t.name), why: `소리 파일(${song.audio || stem(t.name) + '.mp3'})을 못 찾음` }); continue; }
      const cover = song.cover ? findPartner(t, song.cover, imgs) : null;
      const id = songId(song.title, song.artist);
      const old = existing.get(id);
      const audioBlob = await audio.getBlob();
      // 노래방 악보(<곡>.악보.json) — 없거나 안 맞으면 음 줄 화면만 쓴다(실패로 치지 않는다)
      let score = null;
      const sItem = findScore(t, scores);
      if (sItem) {
        try {
          const sj = JSON.parse(decodeText(new Uint8Array(await (await sItem.getBlob()).arrayBuffer())));
          if (sj && sj.v === 1 && Array.isArray(sj.notes) && sj.notes.length === song.notes.length) score = sj;
          else console.warn('악보 자료가 곡과 안 맞음', base(sItem.name), sj && sj.notes && sj.notes.length, song.notes.length);
        } catch (e) { console.warn('악보 자료를 못 읽음', base(sItem.name), e); }
      }
      // 가이드 목소리(#VOCALS) — 이름이 꼭 같은 파일만(같은 이름 짐작으로 반주·원곡을 잘못 집지 않게). 반주와 같은 파일이면 안 씀
      const vItem = song.vocals ? audios.find((p) => norm(base(p.name)) === norm(base(song.vocals)) && norm(dir(p.name)) === norm(dir(t.name))) : null;
      const vocals = vItem && vItem !== audio ? vItem : null;
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
        best: old?.best || 0,
        plays: old?.plays || 0,
        lastPlayed: old?.lastPlayed || 0,
        fav: !!old?.fav,
        take: old?.take || null, // 내 노래 녹음 정보(소리는 blobs 의 id:take)
        score,                   // 노래방 악보 자료(없으면 null)
        hasVocals: !!vocals,     // 가이드 목소리가 있나(소리는 blobs 의 id:vocals)
        vocalsName: vocals ? base(vocals.name) : '',
      };
      await saveSong(meta, new Blob([audioBlob], { type: meta.audioType }), cover ? await cover.getBlob() : null,
        vocals ? new Blob([await vocals.getBlob()], { type: guessType(vocals.name) }) : null);
      added.push(song.title);
    } catch (e) {
      failed.push({ name: base(t.name), why: e.message || String(e) });
    }
  }
  if (!txts.length) failed.push({ name: '(고른 파일)', why: '.txt 악보 파일이 없음' });
  return { added, failed };
}

function findScore(txtItem, pool) {
  const d = norm(dir(txtItem.name));
  const want = norm(stem(txtItem.name)) + '.악보';
  const hits = pool.filter((p) => norm(stem(p.name)) === want);
  return hits.find((p) => norm(dir(p.name)) === d) || hits[0] || null;
}

function findPartner(txtItem, wanted, pool) {
  const d = norm(dir(txtItem.name));
  const sameDir = pool.filter((p) => norm(dir(p.name)) === d);
  const cands = [sameDir, pool];
  if (wanted) {
    const w = norm(base(wanted));
    for (const c of cands) { const hit = c.find((p) => norm(base(p.name)) === w); if (hit) return hit; }
    const ws = norm(stem(wanted));
    for (const c of cands) { const hit = c.find((p) => norm(stem(p.name)) === ws); if (hit) return hit; }
  }
  const ts = norm(stem(txtItem.name));
  for (const c of cands) { const hit = c.find((p) => norm(stem(p.name)) === ts); if (hit) return hit; }
  // 같은 폴더에 하나뿐이면 그것
  return sameDir.length === 1 && d ? sameDir[0] : null;
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
