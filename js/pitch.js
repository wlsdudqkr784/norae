// 목소리 음높이 잡기 — YIN (de Cheveigné & Kawahara 2002) 을 짧게 구현.
// 볼 범위는 RANGE 하나(11-21 — 전에는 목소리 기준 남자·여자·둘 다).
// 11-14: 전에는 70Hz 아래를 아예 안 봐서 남자 낮은 도(도2 = 65Hz)를 절대 못 잡았다(레2 = 73Hz 부터 잡힘).
// 낮은 쪽 한계는 창 크기도 넘지 못한다: 지연 tau 는 반창(size/2) 안 — 2048 이면 48kHz 에서 약 47Hz 까지.
//   (96·192kHz 장치는 pitchWindow 로 창을 늘린다 — 11-22)

// 11-21 사용자: 남녀를 나누지 않는다 — 넓게 한 범위(솔1 48Hz ~ 1300Hz).
//   채점은 옥타브를 접어서 보므로(foldOctave) 한 옥타브 낮게 잘못 잡혀도 점수는 같다.
//   낮게 열면 생기는 '전기 웅 소리(60Hz)를 시1 로 잡음'(11-14) 은 HUM 띠를 버려서 막는다.
export const RANGE = { name: '넓게', min: 48, max: 1300 };
export const HUM = [57, 63.5];   // 이 사이 소리는 웅 소리로 보고 버린다 (시1 61.7Hz 를 부를 사람은 거의 없다)

// 창 크기(11-22 감사): 2048 고정이면 출력 장치가 96kHz 일 때 94Hz, 192kHz 일 때 188Hz 아래를 못 잡았다.
// 표본 빠르기에 맞춰 늘린다 — 44.1·48kHz 는 2048 그대로, 96kHz 4096, 192kHz 8192. (8·16kHz 도 2048 아래로는 안 줄인다)
// 부르기·마이크 시험 둘 다 analyser.fftSize 와 PitchDetector 크기에 이 값을 같이 넣어야 '마이크 시험에서 잡히면 부르기에서도' 가 지켜진다.
export function pitchWindow(sampleRate, range = RANGE) {
  const need = 2 * sampleRate / range.min + 4;
  let size = 2048;
  while (size < need && size < 8192) size *= 2;
  return size;
}

const SUBS = [3, 5, 7], SUB_MAX = 0.3, SUB_MARGIN = 0.15;   // 하위배음 검사 (detect 안 설명)

export class PitchDetector {
  constructor(sampleRate, size = 2048, range = RANGE) {
    // 88kHz 넘는 장치는 표본을 2·4개씩 평균해 44.1~48kHz 로 줄여서 본다 — 창을 늘려도 계산량은 48kHz 와 같게(11-22 감사)
    this.dec = sampleRate >= 88000 ? Math.floor(sampleRate / 44100) : 1;
    this.inSr = sampleRate;
    this.sr = sampleRate / this.dec;
    this.size = size;
    this.n = Math.floor(size / this.dec);
    this.half = this.n >> 1;
    this.w = this.dec > 1 ? new Float32Array(this.n) : null;   // 줄인 소리 — 받은 buf 는 건드리지 않는다
    this.d = new Float32Array(this.half);
    this.minTau = Math.max(2, Math.floor(this.sr / range.max));
    this.maxTau = Math.min(this.half - 1, Math.ceil(this.sr / range.min));
    this.minHz = this.sr / this.maxTau;
    this.maxHz = Math.min(range.max, this.sr / (this.minTau + 1));   // 마이크 시험 안내용
    this.threshold = 0.15;
  }

  // buf: Float32Array(size). 돌려줌: {freq, clarity, rms} — 소리가 없으면 freq=0
  detect(buf, minRms) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    if (rms < minRms) return { freq: 0, clarity: 0, rms };
    if (this.dec > 1) {
      const w = this.w, dec = this.dec, m = Math.min(this.n, Math.floor(buf.length / dec));
      for (let i = 0, j = 0; i < m; i++) { let s = 0; for (let k = 0; k < dec; k++) s += buf[j++]; w[i] = s / dec; }
      if (m < this.n) w.fill(0, m);
      buf = w;
    }
    const n = this.half;

    const d = this.d;
    const maxTau = this.maxTau;
    // 차이 함수
    for (let tau = this.minTau; tau <= maxTau; tau++) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const x = buf[i] - buf[i + tau];
        s += x * x;
      }
      d[tau] = s;
    }
    // 누적 평균으로 나눈 차이
    let running = 0;
    for (let tau = 1; tau < this.minTau; tau++) {
      let s = 0;
      for (let i = 0; i < n; i++) { const x = buf[i] - buf[i + tau]; s += x * x; }
      running += s;
    }
    let best = -1;
    for (let tau = this.minTau; tau <= maxTau; tau++) {
      running += d[tau];
      d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    for (let tau = this.minTau + 1; tau < maxTau; tau++) {
      if (d[tau] < this.threshold) {
        while (tau + 1 < maxTau && d[tau + 1] < d[tau]) tau++;
        // 골이 범위 끝까지 계속 내려가면 진짜 골은 범위 밖(웅 소리 같은 더 낮은 소리) — 끝 값을 음으로 치지 않는다(11-14)
        if (tau + 1 >= maxTau) break;
        best = tau;
        break;
      }
    }
    // 기준(0.15) 아래 골이 없으면 '음 없음'. (11-14 점검: 잡음 많은 방에서 가장 깊은 골을 대신 쓰면
    // 낮은 음이 75~80% '틀린 음' 으로 나왔다 — 틀린 음은 빨갛게 칠해져 없는 것보다 나쁘다. 그래서 쓰지 않는다)
    if (best < 0) return { freq: 0, clarity: 0, rms };
    // 하위배음 검사(11-22 감사): 선풍기·에어컨·차 안·바람 같은 낮은 잡음이 깔리면 누적 평균이 tau 가 클수록 빨리 커져,
    // 진짜 주기 T 의 골(0.18~0.22)은 기준을 못 넘는데 3T·5T 골(0.09)이 먼저 넘는다 → 옥타브로 접어도 안 지워지는
    // 4도·5도 '틀린 음'. 그래서 고른 골의 1/3·1/5·1/7 자리에 기준보다 조금 얕은 골(0.3 아래, 고른 골 +0.15 안)이 있으면
    // 그것을 주기로 본다. 1/2 은 보지 않는다(옥타브는 채점이 접어 주고, 보면 한 옥타브 위로 틀릴 길이 생긴다).
    // 고역 통과 필터는 시험에서 낮은 음(솔1~미2)을 '음 없음' 으로 만들고 창마다 거르면 오히려 나빠져 쓰지 않았다.
    for (let again = true; again;) {
      again = false;
      for (const k of SUBS) {
        const c = best / k;
        if (c < this.minTau + 2) continue;
        const lo = Math.max(this.minTau + 1, Math.floor(c * 0.97 - 1)), hi = Math.min(best - 1, Math.ceil(c * 1.03 + 1));
        let bi = -1, bv = 9;
        for (let t = lo; t <= hi; t++) if (d[t] < bv) { bv = d[t]; bi = t; }
        if (bi > 0 && bv < SUB_MAX && bv < d[best] + SUB_MARGIN && d[bi - 1] >= bv && d[bi + 1] >= bv) { best = bi; again = true; break; }
      }
    }
    // 포물선 보간
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
    const tau = best + Math.max(-1, Math.min(1, shift));
    const freq = this.sr / tau;
    if (freq >= HUM[0] && freq <= HUM[1]) return { freq: 0, clarity: 0, rms, hum: true };
    return { freq, clarity: 1 - b, rms };
  }
}

// 부른 음역 재기(11-21 사용자): 가장 낮게·높게 부른 음. 0.3초 넘게 한 음(1반음 안)으로 낸 것만 센다 —
// 잠깐 스친 소리·한 옥타브 잘못 잡힌 순간은 안 들어가게. 같은 음을 이어 낸 덩어리의 가운데 값으로 잰다.
export class RangeTracker {
  constructor(holdMs = 300, minClarity = 0.8) {
    this.holdMs = holdMs;
    this.minClarity = minClarity;
    this.low = null;
    this.high = null;
    this.seg = null;
  }
  feed(midi, clarity, tMs) {
    if (!(midi > 0) || clarity < this.minClarity) { this.close(); return; }
    const g = this.seg;
    // 시각이 뒤로 가면(줄 반복·진행 막대로 되감기) 새 덩어리 — 전에는 '이어짐' 으로 보고 last 가 start 보다 앞이 되어
    // 되감기 전에 길게 낸 음을 통째로 버렸다(11-22 감사)
    if (g && tMs >= g.last && Math.abs(midi - g.ref) <= 1 && tMs - g.last < 120) {
      g.vals.push(midi);
      g.last = tMs;
      if (g.vals.length % 8 === 0) g.ref = median(g.vals);
      return;
    }
    this.close();
    this.seg = { ref: midi, vals: [midi], start: tMs, last: tMs };
  }
  close() {
    const g = this.seg;
    this.seg = null;
    if (!g || g.last - g.start < this.holdMs) return;
    const m = median(g.vals);
    if (this.low == null || m < this.low) this.low = m;
    if (this.high == null || m > this.high) this.high = m;
  }
  result() { this.close(); return this.low == null ? null : { low: this.low, high: this.high }; }
}

function median(a) {
  const b = [...a].sort((x, y) => x - y);
  return b[b.length >> 1];
}

const NAMES = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
// 60 = 도4 (가운데 도). 마이크 시험과 같은 이름(11-21 여기로 옮김)
export const noteName = (m) => { const r = Math.round(m); return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };

export function freqToMidi(f) {
  return 69 + 12 * Math.log2(f / 440);
}

export function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// m 을 target 에 가장 가까운 옥타브로 옮긴다
export function foldOctave(m, target) {
  return m + 12 * Math.round((target - m) / 12);
}
