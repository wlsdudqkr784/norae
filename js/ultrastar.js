// UltraStar .txt 읽기 — 표준 형식(1.0 계열 + 옛 #RELATIVE)만. 듀엣(P1/P2)은 P1 만 쓴다.
// 결과 시각은 모두 ms (곡 파일 처음 = 0).

const NOTE_TYPES = { ':': 'normal', '*': 'golden', 'F': 'free', 'R': 'rap', 'G': 'rapgolden' };

function num(s) {
  if (s == null) return NaN;
  return parseFloat(String(s).trim().replace(',', '.'));
}

export function parseUltraStar(text) {
  const meta = {};
  const rawNotes = []; // {type, beat, len, pitch, text, lineEndAfter}
  const breaks = [];   // beat 위치 (줄 바뀜)
  let player = 1;
  let relOffset = 0;
  // 줄바꿈: 윈도우(\r\n)·유닉스(\n)·옛 Mac(\r 만) 모두 (11-22 감사)
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let skippedLines = 0;  // 음 줄처럼 생겼는데 못 읽은 줄 수 — 넣기 결과에 보인다(조용히 음이 빠지지 않게)

  for (const line of lines) {
    // 줄 앞 공백은 떼고 본다(손으로 고친 txt). 글자 뒤 공백은 그대로(글자 사이 띄어쓰기)
    const raw = line.replace(/^[ \t]+/, '');
    if (!raw) continue;
    const c = raw[0];
    if (c === '#') {
      const i = raw.indexOf(':');
      if (i > 1) meta[raw.slice(1, i).trim().toUpperCase()] = raw.slice(i + 1).trim();
      continue;
    }
    if (c === 'E') break;
    if (c === 'P') { player = parseInt(raw.slice(1).trim(), 10) || 1; continue; }
    if (player !== 1) continue;
    if (c === '-') {
      const p = raw.slice(1).trim().split(/\s+/);
      const b = parseInt(p[0], 10);
      if (Number.isNaN(b)) continue;
      breaks.push(b + relOffset);
      if (meta.RELATIVE && /^yes$/i.test(meta.RELATIVE)) {
        relOffset += p.length > 1 ? parseInt(p[1], 10) : b;
      }
      continue;
    }
    const type = NOTE_TYPES[c];
    if (!type) continue;
    // ": 박 길이 음높이 글자" — 글자는 공백을 포함할 수 있으니 앞 세 숫자만 잘라낸다.
    // 종류 글자 뒤 공백이 없어도(':5 4 0 가'), 박·길이에 소수점이 있어도(0.5 / 0,5) 읽는다 (11-22 감사)
    const m = raw.match(/^.\s*(-?\d+(?:[.,]\d+)?)\s+(-?\d+(?:[.,]\d+)?)\s+(-?\d+)(?:\s(.*))?$/);
    if (!m) { skippedLines++; continue; }
    const len = num(m[2]);
    rawNotes.push({
      type,
      beat: num(m[1]) + relOffset,
      len: len > 0 ? len : 1,
      pitch: parseInt(m[3], 10),
      text: m[4] ?? '',
    });
  }

  const bpm = num(meta.BPM);
  if (!(bpm > 0)) throw new Error('BPM 이 없거나 잘못됨');
  if (!rawNotes.length) throw new Error('음표가 없음');
  const gap = num(meta.GAP) || 0;
  const beatMs = 60000 / (bpm * 4);
  const toMs = (b) => gap + b * beatMs;

  rawNotes.sort((a, b) => a.beat - b.beat);
  breaks.sort((a, b) => a - b);

  // 음표를 줄로 묶는다
  const out = [];
  let cur = [];
  let bi = 0;
  for (const n of rawNotes) {
    while (bi < breaks.length && breaks[bi] <= n.beat) {
      if (cur.length) { out.push(cur); cur = []; }
      bi++;
    }
    cur.push(n);
  }
  if (cur.length) out.push(cur);

  let id = 0;
  const songLines = out.map((ns, li) => {
    const notes = ns.map((n) => ({
      id: id++,
      line: li,
      type: n.type,
      pitch: n.pitch,
      midi: n.pitch + 60,
      text: n.text,
      start: toMs(n.beat),
      end: toMs(n.beat + n.len),
    }));
    return {
      index: li,
      notes,
      start: notes[0].start,
      end: notes[notes.length - 1].end,
      minMidi: Math.min(...notes.map((n) => n.midi)),
      maxMidi: Math.max(...notes.map((n) => n.midi)),
      syllables: makeSyllables(notes),
    };
  });

  const startMs = (num(meta.START) || 0) * 1000;
  const endMs = num(meta.END) || 0;
  return {
    title: meta.TITLE || '제목 없음',
    artist: meta.ARTIST || '',
    audio: meta.AUDIO || meta.MP3 || '',
    mp3: meta.MP3 || '',         // #AUDIO 와 다를 때 물러날 이름(옛 판 UltraStar)
    vocals: meta.VOCALS || '',   // 가이드 목소리(목소리만 든 소리, 11-13)
    cover: meta.COVER || '',
    bpm,
    gap,
    startMs,
    endMs: endMs > 0 ? endMs : 0,
    lines: songLines,
    notes: songLines.flatMap((l) => l.notes),
    skippedLines,                // 못 읽은 음 줄 수(0 이 정상)
  };
}

// 화면에 보일 글자 묶음: '~' (늘이기) 음은 앞 글자에 붙인다.
function makeSyllables(notes) {
  const syl = [];
  for (const n of notes) {
    const t = n.text;
    const isHold = /^\s*~\s*$/.test(t) || t === '';
    if (isHold && syl.length) {
      const s = syl[syl.length - 1];
      s.end = n.end;
      if (/\s$/.test(t)) s.space = true;
      continue;
    }
    syl.push({
      text: t.replace(/~/g, '').replace(/\s+$/, ''),
      space: /\s$/.test(t),
      start: n.start,
      end: n.end,
    });
  }
  return syl;
}
