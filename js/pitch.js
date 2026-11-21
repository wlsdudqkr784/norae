// 목소리 음높이 잡기 — YIN (de Cheveigné & Kawahara 2002) 을 짧게 구현.
// 볼 범위는 RANGE 하나(11-21 — 전에는 목소리 기준 남자·여자·둘 다).
// 11-14: 전에는 70Hz 아래를 아예 안 봐서 남자 낮은 도(도2 = 65Hz)를 절대 못 잡았다(레2 = 73Hz 부터 잡힘).
// 낮은 쪽 한계는 창 크기도 넘지 못한다: 지연 tau 는 반창(size/2) 안 — 2048 이면 48kHz 에서 약 47Hz 까지.

// 11-21 사용자: 남녀를 나누지 않는다 — 넓게 한 범위(솔1 48Hz ~ 1300Hz).
//   채점은 옥타브를 접어서 보므로(foldOctave) 한 옥타브 낮게 잘못 잡혀도 점수는 같다.
//   낮게 열면 생기는 '전기 웅 소리(60Hz)를 시1 로 잡음'(11-14) 은 HUM 띠를 버려서 막는다.
export const RANGE = { name: '넓게', min: 48, max: 1300 };
export const HUM = [57, 63.5];   // 이 사이 소리는 웅 소리로 보고 버린다 (시1 61.7Hz 를 부를 사람은 거의 없다)

export class PitchDetector {
  constructor(sampleRate, size = 2048, range = RANGE) {
    this.sr = sampleRate;
    this.size = size;
    this.half = size >> 1;
    this.d = new Float32Array(this.half);
    this.minTau = Math.max(2, Math.floor(sampleRate / range.max));
    this.maxTau = Math.min(this.half - 1, Math.ceil(sampleRate / range.min));
    this.minHz = sampleRate / this.maxTau;
    this.threshold = 0.15;
  }

  // buf: Float32Array(size). 돌려줌: {freq, clarity, rms} — 소리가 없으면 freq=0
  detect(buf, minRms) {
    const n = this.half;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    if (rms < minRms) return { freq: 0, clarity: 0, rms };

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
    if (g && Math.abs(midi - g.ref) <= 1 && tMs - g.last < 120) {
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
