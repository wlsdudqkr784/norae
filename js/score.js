// 노래방 악보 — 노래방처럼 오선 악보 8마디를 보여 주고, 부르는 곳을 실시간으로 칠한다 (11-13).
// 자료: 변환기가 만든 <곡>.악보.json (마디·박·음 — .txt 의 음과 같은 순서·같은 수).
// 그리기: VexFlow 4.2.5 (js/vendor/vexflow-bravura.js, 전역 Vex — MIT). 줄(오선 한 줄)은 한 번 그려 두고 매 화면 그 위에 칠한다.
//
// 넘김은 노래방 방식: 줄이 R개 보이면 줄 r 은 r%R 자리에 놓인다. 지금 줄이 r 이면 r..r+R-1 이 보이고,
// 줄 r 을 다 부르면 그 자리가 줄 r+R 로 바뀐다(위에서 부르는 동안 아래 줄은 미리 보인다).

const EPS = 1e-4;
// [박 길이, VexFlow 길이, 점]
const DURS = [[4, 'w', 0], [3, 'h', 1], [2, 'h', 0], [1.5, 'q', 1], [1, 'q', 0], [0.75, '8', 1], [0.5, '8', 0], [0.375, '16', 1], [0.25, '16', 0], [0.125, '32', 0]];
const SHARP = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const FLAT = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
const KEYNAME = { '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb', '-1': 'F', 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#' };
const ROW_H = 132;   // 오선 한 줄의 높이 (악보 단위 — 오선 칸 10)
const MEAS_W = 170;  // 마디 하나에 넉넉한 너비 (악보 단위)
const PAD = 10;

const COL = {
  // 따뜻한 종이(11-13 디자인): 흰 종이보다 덜 눈부시게. 지금 음·세로줄은 앱 대표 색(하늘색)을 종이에서 읽히게 진하게
  paper: '#f2ede2', nowRow: 'rgba(56, 189, 248, 0.10)', ink: '#1c1a17', lyric: '#3a352e',
  cur: '#0284c7', cursor: 'rgba(2, 132, 199, 0.9)',
  // 부른 음 칠하기(11-13 사용자): 맞으면 파랑, 아니면 빨강 — 원래 음과 멀수록 짙게. 목소리가 없었으면 회색
  hit: '#1d4ed8', unsung: '#a8a29e', voiceHit: '#1d4ed8', voiceMiss: '#dc2626',
};
// 빨강 짙기: 반음 0.5 차이 = 옅은 빨강 → 5반음 이상 = 짙은 빨강
const RED_LIGHT = [248, 113, 113], RED_DARK = [127, 29, 29];
export function redFor(dev) {
  const p = Math.max(0, Math.min(1, (Math.abs(dev) - 0.5) / 4.5));
  const c = RED_LIGHT.map((a, i) => Math.round(a + (RED_DARK[i] - a) * p));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// 셋잇단 길이(박): 셋잇단 2분·4분·8분·16분. 적을 때는 보통 음표로 적고 '3' 묶음(Tuplet)이 길이를 2/3 로 줄인다
const TRIP = [[4 / 3, 'h'], [2 / 3, 'q'], [1 / 3, '8'], [1 / 6, '16']];
const isTriplet = (len) => Math.abs(len * 3 - Math.round(len * 3)) < 0.02 && Math.abs(len * 8 - Math.round(len * 8)) > 0.05;

// 길이(박) → [[박, VexFlow 길이, 점, 셋잇단?]]
function split(len) {
  const out = [];
  let rem = len;
  if (isTriplet(len)) {
    while (rem > 0.1) {
      const d = TRIP.find(([v]) => v <= rem + 0.02) || TRIP[TRIP.length - 1];
      out.push([d[0], d[1], 0, true]);
      rem -= d[0];
    }
    return out;
  }
  while (rem > 0.06) {
    const d = DURS.find(([v]) => v <= rem + 0.02) || DURS[DURS.length - 1];
    out.push([d[0], d[1], d[2], false]);
    rem -= d[0];
  }
  return out;
}

export class ScoreView {
  constructor(sj, song) {
    const VF = window.Vex && window.Vex.Flow;
    if (!VF) throw new Error('악보 그리기(VexFlow)를 못 불러옴');
    if (!sj || sj.v !== 1 || !Array.isArray(sj.notes) || !Array.isArray(sj.measures) || !Array.isArray(sj.lines)) throw new Error('악보 자료 형식이 다름');
    if (sj.notes.length !== song.notes.length) throw new Error(`악보 자료와 곡의 음 수가 다름 (${sj.notes.length} / ${song.notes.length})`);
    this.VF = VF;
    this.sj = sj;
    this.song = song;
    this.M = sj.measures;
    const f = Math.max(-7, Math.min(7, Math.round(sj.keyFifths || 0)));
    this.keyName = KEYNAME[f];
    this.names = f >= 0 ? SHARP : FLAT;
    // 남자 목소리는 악보보다 한 옥타브 낮게 부른다 → 높은음자리표 밑 8 (8vb) 로 적는다
    // ★ 11-21 '일생 일작': 가운데 음이 60 을 살짝 넘어 옮기지 않았는데, 많은 음이 오선 밑으로 내려가 가사를 덮었다.
    //   → 오선 밖(덧줄 두 개 넘게: D4 밑 · A5 위)으로 나가는 음이 가장 적은 옥타브를 고른다. 같으면 안 옮긴다.
    const mids = sj.notes.map((n) => n.midi);
    const off = (d) => mids.filter((m) => m + d < 62 || m + d > 81).length;
    this.disp = [0, 12, -12].reduce((best, d) => (off(d) < off(best) ? d : best), 0);
    this.clefAnn = this.disp === 12 ? '8vb' : this.disp === -12 ? '8va' : undefined;
    this.buildOccurrences();
    this.layoutKey = '';
    this.cache = new Map();
  }

  tOf(line, beat) {
    const L = this.sj.lines[line] || this.sj.lines[0];
    return (L.off + L.spb * beat) * 1000;
  }

  mIdx(beat) {
    const M = this.M;
    let lo = 0, hi = M.length - 1, r = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (M[mid].beat <= beat + EPS) { r = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return r;
  }

  // 부른 순서대로 마디를 늘어놓는다(도돌이로 다시 부르면 그 마디가 다시 나온다).
  // ★ 11-13 둘째(사용자): 전주·간주·쉬는 마디도 빼지 않는다 — 비는 시간만큼 쉼 마디를 넣어 세로줄이 계속 흐르게.
  // 시각은 '음이 시작하는 시각(.txt)' 만 믿고, 그 사이는 박 수에 비례해 나눈다 → 4박 쉼은 4박만큼 천천히 지나간다.
  buildOccurrences() {
    const occ = [];
    const push = (m, line) => {
      const M = this.M[m];
      const o = { m, line, lastLine: line, segs: [], beat: M.beat, len: M.len, ts: M.ts, no: M.no };
      occ.push(o);
      return o;
    };
    const noteAt = []; // 음 k 의 첫 조각: [마디, 박]
    let prevBeat = -Infinity;
    this.sj.notes.forEach((n, k) => {
      const a = n.beat, b = n.beat + Math.max(n.dur, 0.05);
      const m0 = this.mIdx(a), m1 = this.mIdx(b - EPS);
      for (let m = m0; m <= m1; m++) {
        if (this.M[m].len < 0.05) continue;   // 길이 0 마디(악보 읽기가 만든 빈 마디 — 476 106마디)
        let o = occ[occ.length - 1];
        const back = m === m0 && a < prevBeat - EPS;
        if (!o || o.m !== m || back) o = push(m, n.line);
        o.lastLine = n.line;
        const ms = o.beat, me = ms + o.len;
        const from = Math.max(a, ms);
        o.segs.push({ k, from, to: Math.min(b, me), tieIn: m > m0 && noteAt[k] != null, tieOut: m < m1 });
        if (noteAt[k] == null) noteAt[k] = [o, from];
      }
      prevBeat = a;
    });
    // 마디마다 대강의 시각(줄의 박 → 초) — 빈 시간을 재는 데만 쓴다
    for (const o of occ) {
      o.estStart = this.tOf(o.line, o.beat);
      o.estEnd = this.tOf(o.lastLine, o.beat + o.len);
    }
    // 빈 시간(전주·간주·쉬는 마디)을 쉼 마디로 채운다
    const rest = (like, line) => {
      const ts = like.ts;
      return { m: -1, rest: true, line, lastLine: line, segs: [], beat: 0, len: (ts[0] * 4) / ts[1], ts, no: '' };
    };
    const barMs = (o) => Math.max(400, (this.sj.lines[o.line] || this.sj.lines[0]).spb * 1000 * (o.ts[0] * 4) / o.ts[1]);
    const bars = [];
    if (occ.length) {
      const first = occ[0];
      const nIntro = Math.min(40, Math.round(first.estStart / barMs(first)));
      for (let i = 0; i < nIntro; i++) bars.push(rest(first, first.line));
    }
    occ.forEach((o, i) => {
      if (i > 0) {
        const p = occ[i - 1];
        const gap = o.estStart - p.estEnd;
        const n = gap > 0.6 * barMs(p) ? Math.min(40, Math.round(gap / barMs(p))) : 0;
        for (let j = 0; j < n; j++) bars.push(rest(p, p.lastLine));
      }
      bars.push(o);
    });
    // 박 자리(곡 처음부터 이어 센 박)
    let d = 0;
    for (const o of bars) { o.d0 = d; d += o.len; }
    this.totalBeats = d;
    // 아는 시각: 음이 시작하는 곳(.txt 시각)
    const known = [];
    noteAt.forEach(([o, from], k) => { known.push([o.d0 + (from - o.beat), this.song.notes[k].start]); });
    known.sort((x, y) => x[0] - y[0]);
    const kn = [];
    for (const p of known) { if (!kn.length || (p[0] > kn[kn.length - 1][0] + EPS && p[1] > kn[kn.length - 1][1])) kn.push(p); }
    if (kn.length) {
      // 처음(전주 시작)과 끝: 첫·끝 줄 빠르기로 늘인다
      const spb0 = (this.sj.lines[0] || { spb: 0.5 }).spb * 1000, spb1 = (this.sj.lines[this.sj.lines.length - 1] || { spb: 0.5 }).spb * 1000;
      if (kn[0][0] > EPS) kn.unshift([0, kn[0][1] - kn[0][0] * spb0]);
      const lastD = kn[kn.length - 1][0];
      if (this.totalBeats > lastD + EPS) kn.push([this.totalBeats, kn[kn.length - 1][1] + (this.totalBeats - lastD) * spb1]);
    }
    this.known = kn;
    for (const o of bars) { o.startMs = this.msAt(o.d0); o.endMs = this.msAt(o.d0 + o.len); }
    this.occ = bars;
  }

  // 이어 센 박 → 시각(ms): 아는 시각 사이를 박 수에 비례해 나눈다
  msAt(d) {
    const k = this.known;
    if (!k.length) return 0;
    if (d <= k[0][0]) return k[0][1];
    let lo = 0, hi = k.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (k[mid][0] <= d) lo = mid; else hi = mid; }
    if (d >= k[hi][0]) return k[hi][1];
    const [d0, t0] = k[lo], [d1, t1] = k[hi];
    return t0 + ((t1 - t0) * (d - d0)) / (d1 - d0);
  }

  layout(W, H, dpr) {
    const key = `${W}x${H}x${dpr}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.W = W; this.H = H; this.dpr = dpr;
    // 8마디: 가로 4마디 × 2줄 또는 2마디 × 4줄 중 크게 보이는 쪽
    let best = null;
    const fit = (bpr, R) => Math.min((H - PAD * 2) / (R * ROW_H), (W - PAD * 2) / (bpr * MEAS_W + 30));
    for (const [bpr, R] of [[4, 2], [2, 4]]) {
      const s = fit(bpr, R);
      if (!best || s > best.s) best = { bpr, R, s };
    }
    // 폰을 눕혀 높이가 낮으면 8마디는 글자를 못 읽을 만큼 작아진다 → 4마디 한 줄로 크게 (11-13 화면 검토)
    if (best.s < 0.7) {
      const s = fit(4, 1);
      if (s > best.s) best = { bpr: 4, R: 1, s };
    }
    this.bpr = best.bpr;
    this.R = best.R;
    this.s = Math.max(0.45, Math.min(1.7, best.s));
    this.rowPx = ROW_H * this.s;
    // 남는 높이는 위쪽에 더 둔다 → 악보가 바로 밑 가사와 붙어 한 덩어리로 읽힌다 (전에는 가운데라 가사와 사이가 떴다)
    this.top = Math.max(PAD, (H - this.R * this.rowPx) * 0.65);
    this.rows = [];
    for (let i = 0; i < this.occ.length; i += this.bpr) {
      const os = this.occ.slice(i, i + this.bpr);
      this.rows.push({ occ: os, startMs: os[0].startMs, endMs: os[os.length - 1].endMs });
    }
    this.cache.clear();
  }

  rowAt(t) {
    const rows = this.rows;
    let r = 0;
    for (let i = 0; i < rows.length; i++) { if (rows[i].startMs <= t) r = i; else break; }
    // 줄 끝을 지났고 다음 줄이 곧(1초 안) 시작하면 미리 넘기지 않는다 — 노래방도 다음 줄 첫 음에서 넘긴다
    return r;
  }

  getRow(r) {
    let row = this.cache.get(r);
    if (!row) {
      row = this.renderRow(r);
      this.cache.set(r, row);
      if (this.cache.size > this.R + 3) {
        for (const k of this.cache.keys()) { if (k < r - 1 || k > r + this.R + 1) { this.cache.delete(k); break; } }
      }
    }
    return row;
  }

  renderRow(r) {
    const VF = this.VF, s = this.s, dpr = this.dpr;
    const unitW = this.W / s;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(this.W * dpr));
    cv.height = Math.max(1, Math.round(this.rowPx * dpr));
    const g = cv.getContext('2d');
    g.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
    const ctx = new VF.CanvasContext(g);
    ctx.setFillStyle(COL.ink);
    ctx.setStrokeStyle(COL.ink);
    const row = this.rows[r];
    const firstOcc = this.occ.indexOf(row.occ[0]);

    // 마디마다 음표·쉼표
    const built = row.occ.map((o, j) => {
      const M = o; // 마디 자리·길이·박자표 (빈 시간을 채운 쉼 마디도 같은 모양)
      const ms = M.beat, me = ms + M.len;
      const ticks = [];
      const ties = [];
      // 쉼표는 악보처럼 박 경계에서 나눈다: 박 중간이면 그 박 끝까지, 4/4 의 1·3박에서 두 박이 비면 2분 쉼표, 마디 전체면 온쉼표
      const beatLen = 4 / M.ts[1];
      const addRest = (from, to) => {
        const put = (b, len) => {
          for (const [v, d, dot, trip] of split(len)) {
            const n = new VF.StaveNote({ keys: ['b/4'], duration: d + 'r', dots: dot, clef: 'treble' });
            if (dot) VF.Dot.buildAndAttach([n], { all: true });
            ticks.push({ note: n, beat: b, rest: true, trip, len: v });
            b += v;
          }
        };
        if (from - ms < 0.03 && me - to < 0.03 && M.len >= 2) {
          const n = new VF.StaveNote({ keys: ['b/4'], duration: 'wr', clef: 'treble', align_center: true });
          ticks.push({ note: n, beat: from, rest: true, whole: true });
          return;
        }
        let b = from;
        while (to - b > 0.06) {
          const q = (b - ms) / beatLen;
          const onBeat = Math.abs(q - Math.round(q)) < 1e-3;
          let end;
          if (!onBeat) end = Math.min(to, ms + Math.ceil(q - 1e-3) * beatLen);
          else if (M.ts[0] === 4 && M.ts[1] === 4 && (Math.round(q) === 0 || Math.round(q) === 2) && to - b >= 2 - 0.03) end = b + 2;
          else end = Math.min(to, b + beatLen);
          if (end - b < 0.03) end = to;
          put(b, end - b);
          b = end;
        }
      };
      let cur = ms;
      const segs = o.segs.slice().sort((x, y) => x.from - y.from);
      for (const sg of segs) {
        let from = Math.max(sg.from, cur);
        if (sg.to - from < 0.03) continue;
        if (from - cur > 0.06) addRest(cur, from); else from = cur;
        const midi = this.sj.notes[sg.k].midi + this.disp;
        const key = this.names[((midi % 12) + 12) % 12] + '/' + (Math.floor(midi / 12) - 1);
        let parts = split(sg.to - from);
        if (!parts.length) parts = [DURS[DURS.length - 1]];
        let b = from;
        const made = [];
        parts.forEach(([v, d, dot, trip], pi) => {
          const n = new VF.StaveNote({ keys: [key], duration: d, dots: dot, clef: 'treble', auto_stem: true });
          if (dot) VF.Dot.buildAndAttach([n], { all: true });
          ticks.push({ note: n, beat: b, k: sg.k, first: pi === 0 && !sg.tieIn, trip, len: v });
          made.push(n);
          b += v;
        });
        for (let i = 0; i + 1 < made.length; i++) ties.push({ a: made[i], b: made[i + 1] });
        if (sg.tieIn) ties.push({ a: null, b: made[0], k: sg.k });
        if (sg.tieOut) ties.push({ a: made[made.length - 1], b: null, k: sg.k });
        cur = Math.max(cur, sg.to);
      }
      if (me - cur > 0.06) addRest(cur, me);
      if (!ticks.length) addRest(ms, me);
      // 셋잇단 묶기: 이어진 셋잇단 음·쉼표를 모아 한 박(또는 두 박)이 차면 '3' 으로 묶는다. 보통 음이 끼면 거기서 끊는다
      const tuplets = [];
      let grp = [], sum = 0;
      const close = () => {
        if (grp.length) {
          try { tuplets.push(new VF.Tuplet(grp, { num_notes: 3, notes_occupied: 2, ratioed: false })); } catch (e) { console.warn('셋잇단 묶기 실패', e); }
        }
        grp = []; sum = 0;
      };
      for (const tk of ticks) {
        if (!tk.trip) { close(); continue; }
        grp.push(tk.note);
        sum += tk.len;
        if (Math.abs(sum - Math.round(sum)) < 0.02 && sum > 0.5) close();
      }
      close();
      const tsStr = M.ts[0] + '/' + M.ts[1];
      const voice = new VF.Voice({ num_beats: M.ts[0], beat_value: M.ts[1] });
      voice.setMode(VF.Voice.Mode.SOFT);
      voice.addTickables(ticks.map((x) => x.note));
      try { VF.Accidental.applyAccidentals([voice], this.keyName); } catch (e) { console.warn('임시표 붙이기 실패', e); }
      let beams = [];
      try {
        beams = VF.Beam.generateBeams(ticks.filter((x) => !x.rest).map((x) => x.note), { groups: VF.Beam.getDefaultBeamGroups(tsStr) });
      } catch (e) { console.warn('꼬리 묶기 실패', e); }
      const oi = firstOcc + j;
      const prevOcc = this.occ[oi - 1];
      const showTs = oi === 0 || !prevOcc || prevOcc.ts.join('/') !== M.ts.join('/');
      return { o, ticks, ties, voice, beams, tuplets, tsStr, showTs, first: j === 0 };
    });

    // 너비 나누기: 음표가 많은 마디를 넓게. 마지막 줄이 짧아도 마디 너비는 같은 비율로
    const mods = (b, x, w) => {
      const st = new VF.Stave(x, 0, w);
      if (b.first) { st.addClef('treble', 'default', this.clefAnn); st.addKeySignature(this.keyName); }
      if (b.showTs) st.addTimeSignature(b.tsStr);
      return st;
    };
    const extra = built.map((b) => { const st = mods(b, 0, 300); return st.getNoteStartX() - st.getX(); });
    const weight = built.map((b) => 4 + b.ticks.filter((x) => !x.rest).length + 0.6 * b.ticks.filter((x) => x.rest).length);
    const avgW = weight.reduce((a, c) => a + c, 0) / weight.length;
    const totalW = weight.reduce((a, c) => a + c, 0) + avgW * (this.bpr - built.length);
    const left = 6, right = unitW - 6;
    const avail = right - left - extra.reduce((a, c) => a + c, 0);
    let x = left;
    const anchors = [];
    const heads = new Map();
    let stave0 = null;
    built.forEach((b, j) => {
      const w = extra[j] + Math.max(40, (avail * weight[j]) / totalW);
      const st = mods(b, x, w);
      if (!stave0) stave0 = st;
      st.setContext(ctx).draw();
      const noteW = Math.max(20, st.getNoteEndX() - st.getNoteStartX() - 8);
      try {
        new VF.Formatter().joinVoices([b.voice]).format([b.voice], noteW);
        b.voice.draw(ctx, st);
        b.beams.forEach((bm) => bm.setContext(ctx).draw());
        b.tuplets.forEach((tp) => tp.setContext(ctx).draw());
      } catch (e) {
        console.warn('마디 그리기 실패', b.o.no || '(쉼 마디)', e);
      }
      // 시각 → 가로 위치 짚기
      anchors.push({ ms: b.o.startMs, x: st.getNoteStartX() - 4 });
      for (const tk of b.ticks) {
        // 온쉼표는 마디 가운데에 그려지지만 마디 전체의 쉼이다 → 짚지 않는다(마디 처음→끝을 고르게 지나가게).
        // 전에는 마디 '처음' 시각에 '가운데' 자리를 짚어 쉼 마디에 들어서자마자 세로줄이 가운데로 순간이동했다(11-13)
        if (tk.whole) continue;
        let ax;
        try { ax = tk.note.getAbsoluteX(); } catch { continue; }
        // 음 시작은 .txt 시각 그대로, 쉼표·이어 끄는 조각은 박 수에 비례한 시각
        const ms = tk.k != null && tk.first ? this.song.notes[tk.k].start : this.msAt(b.o.d0 + (tk.beat - b.o.beat));
        anchors.push({ ms, x: ax });
        if (tk.k != null) {
          try {
            const hx0 = tk.note.getNoteHeadBeginX(), hx1 = tk.note.getNoteHeadEndX(), hy = tk.note.getYs()[0];
            if (!heads.has(tk.k)) heads.set(tk.k, []);
            heads.get(tk.k).push({ x0: hx0, x1: hx1, y: hy, first: tk.first });
          } catch (e) { console.warn('음표 자리 못 읽음', e); }
        }
      }
      anchors.push({ ms: b.o.endMs, x: st.getNoteEndX() });
      x += w;
    });
    // 이음줄
    for (const b of built) {
      for (const tie of b.ties) {
        try {
          new VF.StaveTie({ first_note: tie.a, last_note: tie.b, first_indices: [0], last_indices: [0] }).setContext(ctx).draw();
        } catch (e) { console.warn('이음줄 그리기 실패', e); }
      }
    }
    // 가사(음표 밑)
    // 가사 줄은 이 줄에서 가장 낮은 음표보다 밑에 (덮이지 않게, 11-21) — 줄 높이(ROW_H) 안에서만
    let lowY = -Infinity;
    for (const [, hs] of heads) for (const h of hs) lowY = Math.max(lowY, h.y);
    const lyY = Math.min(ROW_H - 3, Math.max(stave0 ? stave0.getYForLine(4) + 34 : 110, lowY + 20));
    g.fillStyle = COL.lyric;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.font = '600 15px system-ui, "Malgun Gothic", "Noto Sans KR", sans-serif';
    for (const [k, hs] of heads) {
      const h = hs.find((q) => q.first);
      if (!h) continue;
      const txt = (this.song.notes[k].text || '').replace(/~/g, '').trim();
      if (!txt) continue;
      g.fillText(txt, (h.x0 + h.x1) / 2, lyY);
    }
    anchors.sort((a, b) => a.ms - b.ms || a.x - b.x);
    // 같은 시각(3ms 안)에 자리가 여럿이면(앞 마디 끝·이 마디 처음·첫 음) 가장 오른쪽 하나만 —
    // 여럿이면 그 순간 세로줄이 그 사이를 건너뛴다. 남긴 자리로 앞에서부터 이어 움직이므로 첫 음에 딱 맞춰 닿는다(11-13)
    const merged = [];
    for (const a of anchors) {
      const p = merged[merged.length - 1];
      if (p && a.ms - p.ms < 3) { p.x = Math.max(p.x, a.x); continue; }
      merged.push({ ms: a.ms, x: a.x });
    }
    anchors.length = 0;
    anchors.push(...merged);
    for (let i = 1; i < anchors.length; i++) if (anchors[i].x < anchors[i - 1].x) anchors[i].x = anchors[i - 1].x;

    const st0 = stave0;
    const yForMidi = (m) => {
      if (!st0) return 60;
      const lo = Math.floor(m), fr = m - lo;
      const y1 = this.yOf(st0, lo + this.disp);
      if (fr < 0.01) return y1;
      return y1 + (this.yOf(st0, lo + 1 + this.disp) - y1) * fr;
    };
    return { cv, anchors, heads, yForMidi, top: st0 ? st0.getYForLine(0) : 40, bottom: st0 ? st0.getYForLine(4) : 80 };
  }

  yOf(stave, midi) {
    const key = this.names[((midi % 12) + 12) % 12].charAt(0) + '/' + (Math.floor(midi / 12) - 1);
    try { return stave.getYForNote(this.VF.Tables.keyProperties(key, 'treble').line); } catch { return stave.getYForLine(2); }
  }

  xAt(row, t) {
    const a = row.anchors;
    if (!a.length) return 0;
    if (t <= a[0].ms) return a[0].x;
    for (let i = 1; i < a.length; i++) {
      if (t < a[i].ms) {
        const p = (t - a[i - 1].ms) / Math.max(1, a[i].ms - a[i - 1].ms);
        return a[i - 1].x + (a[i].x - a[i - 1].x) * p;
      }
    }
    return a[a.length - 1].x;
  }

  // 매 화면: g 는 CSS 픽셀 좌표(이미 dpr 배율). sess = Session (음 맞음·목소리 자취·마이크 여부)
  draw(g, W, H, t, sess) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.layout(W, H, dpr);
    g.clearRect(0, 0, W, H);
    if (!this.rows.length) return;
    const s = this.s, R = this.R, rp = this.rowPx;
    const r = this.rowAt(t);
    // 종이
    g.save();
    g.shadowColor = 'rgba(0, 0, 0, 0.45)'; g.shadowBlur = 18; g.shadowOffsetY = 4;  // 종이 한 장처럼
    g.fillStyle = COL.paper;
    rrect(g, 6, this.top - 6, W - 12, R * rp + 12, 14);
    g.fill();
    g.restore();
    const scoring = sess.micOk || sess.opts.fakeMic;
    for (let q = r; q < r + R && q < this.rows.length; q++) {
      const y0 = this.top + (q % R) * rp;
      const row = this.getRow(q);
      if (q === r) { g.fillStyle = COL.nowRow; g.fillRect(8, y0 + 4, W - 16, rp - 8); }
      g.drawImage(row.cv, 0, y0, W, rp);
      // 음표 칠하기(11-13 사용자): 맞게 부름 = 파랑 / 안 맞음 = 빨강(원래 음과 멀수록 짙게) + 부른 높이에 '인식된 음' /
      // 목소리 없음 = 회색. 지금 부르는 음은 부르는 대로 바로 칠하고, 아직 소리가 없으면 대표 색
      const last = sess.trail[sess.trail.length - 1];
      for (const [k, hs] of row.heads) {
        const n = this.song.notes[k];
        let c = null, ghost = null;
        const graded = scoring && n.type !== 'free';
        if (t >= n.start && t < n.end) {
          c = COL.cur;
          if (graded && last && last.m && t - last.S < 200 && last.target === n.midi) {
            c = last.hit ? COL.hit : redFor(last.m - n.midi);
            if (!last.hit) ghost = last.m;
          }
        } else if (t >= n.end && graded) {
          const med = sess.noteSung ? sess.noteSung(n) : null;
          if (sess.noteFrac(n) >= 0.5) c = COL.hit;
          else if (med == null) c = COL.unsung;
          else { c = redFor(med - n.midi); ghost = med; }
        }
        if (!c) continue;
        for (const h of hs) {
          const cx = ((h.x0 + h.x1) / 2) * s, cy = y0 + h.y * s;
          const rx = Math.max(4, ((h.x1 - h.x0) / 2) * s * 1.05), ry = 4.6 * s;
          g.fillStyle = c;
          g.beginPath();
          g.ellipse(cx, cy, rx, ry, -0.35, 0, Math.PI * 2);
          g.fill();
          // 인식된 음: 같은 자리 위·아래에 속이 빈 음표 머리 + 원래 음까지 가는 점선 (반음 반 넘게 벗어날 때만)
          if (ghost != null && Math.abs(ghost - n.midi) >= 0.5) {
            const gy = y0 + row.yForMidi(ghost) * s;
            if (Math.abs(gy - cy) < ry * 0.8) continue;
            // 바로 옆 칸이면 악보의 2도 화음처럼 옆으로 비켜 그려 겹치지 않게
            const gx = Math.abs(gy - cy) < ry * 2.2 ? cx + rx * 1.7 : cx;
            g.save();
            g.strokeStyle = c;
            g.lineWidth = Math.max(1, 1.2 * s);
            g.setLineDash([3 * s, 3 * s]);
            if (gx === cx) { g.beginPath(); g.moveTo(cx, cy + Math.sign(gy - cy) * ry); g.lineTo(cx, gy - Math.sign(gy - cy) * ry); g.stroke(); }
            g.setLineDash([]);
            g.lineWidth = Math.max(1.5, 2 * s);
            g.globalAlpha = 0.9;
            g.beginPath();
            g.ellipse(gx, gy, rx, ry, -0.35, 0, Math.PI * 2);
            g.stroke();
            g.globalAlpha = 0.25;
            g.fillStyle = c;
            g.fill();
            g.restore();
          }
        }
      }
      if (q !== r) continue;
      // 목소리 자취 (이 줄 안, 최근 4초)
      if (scoring && sess.trail.length) {
        // 형광펜처럼 굵고 옅게 — 이음줄과 헷갈리지 않게
        g.lineCap = 'round';
        g.lineWidth = Math.max(5, 7 * s);
        let prev = null;
        for (const p of sess.trail) {
          if (p.S < this.rows[q].startMs || p.S < t - 4000 || !p.m) { prev = null; continue; }
          const px = this.xAt(row, p.S) * s, py = y0 + row.yForMidi(p.m) * s;
          if (prev && p.S - prev.S < 90 && Math.abs(p.m - prev.m) < 3) {
            g.strokeStyle = p.hit ? COL.voiceHit : COL.voiceMiss;
            g.globalAlpha = 0.22;
            g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(px, py); g.stroke();
          }
          prev = { S: p.S, m: p.m, x: px, y: py };
        }
        g.globalAlpha = 1;
      }
      // 지금 자리 세로줄
      const cx = this.xAt(row, t) * s;
      g.fillStyle = COL.cursor;
      g.fillRect(cx - 1.25, y0 + (row.top - 22) * s, 2.5, (row.bottom - row.top + 44) * s);
      if (scoring && sess.state === 'playing' && last && last.m && t - last.S < 400) {
        g.beginPath();
        g.arc(cx, y0 + row.yForMidi(last.m) * s, Math.max(4, 5 * s), 0, Math.PI * 2);
        g.fillStyle = last.hit ? COL.voiceHit : COL.voiceMiss;
        g.fill();
      }
    }
  }
}

function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
