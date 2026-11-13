// 노래로 지연 맞추기 (11-14 사용자) — '가자 때가 됐다' 첫 4줄을 부르면 목소리가 악보보다 얼마나 늦게 잡히는지 잰다.
// 방법: 부르는 동안 잡은 음높이 [{S, m}] (S = 지금 설정의 지연을 뺀 곡 시각) 를 L ms 앞으로 당겨 보며,
//       '목소리 있는 순간 중 그때 악보 음과 맞는 비율' 이 가장 큰 L 을 찾는다. 맞는 비율이 거의 같은 L 이 여럿이면(긴 음) 그 가운데.
// 결과 L 만큼 설정 micLatency 에 더하면 된다(+ = 목소리가 늦게 잡힘).

export const CALIB_TITLE = '가자 때가 됐다';
export const CALIB_LINES = 4;
export const isCalibSong = (title) => (title || '').replace(/\s/g, '').includes(CALIB_TITLE.replace(/\s/g, ''));

const fold = (m, t) => m + 12 * Math.round((t - m) / 12);

function noteAt(notes, t) {
  let lo = 0, hi = notes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].end <= t) lo = mid + 1;
    else if (notes[mid].start > t) hi = mid - 1;
    else return notes[mid];
  }
  return null;
}

// rec: [{S, m}] (m = 0 이면 목소리 없음), notes: 시간순 [{start, end, midi, type}]
// → {ok, lag, score, base, voicedSec, why}
export function estimateLag(rec, notes, { min = -300, max = 800, step = 10, tol = 1 } = {}) {
  const voiced = rec.filter((r) => r.m > 0);
  const dur = rec.length > 1 ? (rec[rec.length - 1].S - rec[0].S) : 0;
  const voicedSec = rec.length ? (voiced.length / rec.length) * dur / 1000 : 0;
  // 충분한지는 '목소리 들은 초' 로 — 화면이 느린 폰은 1초에 잡는 수가 적다
  if (voicedSec < 4 || voiced.length < 30) return { ok: false, voicedSec, why: '목소리를 거의 못 들었습니다' };
  // 두 가지를 반씩: ① 음높이 맞음(목소리 있는 순간 중 그때 악보 음과 맞는 비율)
  // ② 소리 남/안 남 맞음(모든 순간 중 '목소리 있음' 과 '악보에 음 있음' 이 같은 비율).
  // ①만 쓰면 음 첫머리를 앞 음에서 미끄러져 들어가는 노래에서 지연이 80ms 쯤 크게 나왔다(시험). ②는 미끄러짐과 상관없다
  const parts = (L) => {
    let hit = 0, agree = 0;
    for (const r of rec) {
      const n = noteAt(notes, r.S - L);
      const inNote = !!(n && n.type !== 'free');
      if ((r.m > 0) === inNote) agree++;
      if (r.m > 0 && inNote && Math.abs(fold(r.m, n.midi) - n.midi) <= tol) hit++;
    }
    return [hit / voiced.length, agree / rec.length];
  };
  const scoreAt = (L) => { const [p, v] = parts(L); return 0.5 * p + 0.5 * v; };
  const curve = [];
  for (let L = min; L <= max; L += step) curve.push([L, scoreAt(L)]);
  const best = Math.max(...curve.map((c) => c[1]));
  // 꼭대기 근처(1%p 안)의 이어진 구간 가운데
  const iBest = curve.findIndex((c) => c[1] === best);
  let a = iBest, b = iBest;
  while (a > 0 && curve[a - 1][1] >= best - 0.01) a--;
  while (b < curve.length - 1 && curve[b + 1][1] >= best - 0.01) b++;
  const lag = Math.round((curve[a][0] + curve[b][0]) / 2 / step) * step;
  const base = scoreAt(0);
  // 이 곡을 부른 게 맞는지: 고른 지연에서 음높이가 1/4 은 맞아야(박자만 맞는 잡음·다른 노래로 재지 않게)
  const pitchAt = parts(lag)[0];
  if (pitchAt < 0.25) return { ok: false, lag, score: best, base, pitch: pitchAt, voicedSec, why: '부른 음이 악보와 잘 안 맞아 잴 수 없습니다' };
  if (a === 0 || b === curve.length - 1) return { ok: false, lag, score: best, base, voicedSec, why: `잴 수 있는 범위(${min}~${max}ms) 끝에 걸렸습니다` };
  return { ok: true, lag, score: best, base, voicedSec };
}
