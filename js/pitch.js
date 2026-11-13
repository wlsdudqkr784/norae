// 목소리 음높이 잡기 — YIN (de Cheveigné & Kawahara 2002) 을 짧게 구현.
// 사람 목소리 범위(약 70~1100 Hz)만 본다.

export class PitchDetector {
  constructor(sampleRate, size = 2048) {
    this.sr = sampleRate;
    this.size = size;
    this.half = size >> 1;
    this.d = new Float32Array(this.half);
    this.minTau = Math.max(2, Math.floor(sampleRate / 1100));
    this.maxTau = Math.min(this.half - 1, Math.ceil(sampleRate / 70));
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
        best = tau;
        break;
      }
    }
    if (best < 0) return { freq: 0, clarity: 0, rms };
    // 포물선 보간
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
    const tau = best + Math.max(-1, Math.min(1, shift));
    return { freq: this.sr / tau, clarity: 1 - b, rms };
  }
}

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
