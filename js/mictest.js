// 마이크 시험 (11-13) — 노래 없이 소리를 내면 앱이 듣는 음 이름·소리 크기·지난 6초 음높이를 바로 보여 준다.
// 부르기 화면과 같은 길(getMic · PitchDetector · 설정의 감도)로 들어서, 여기서 맞게 잡히면 부르기에서도 잡힌다.
// 함께 보이는 것: 쓰는 마이크 이름과 표본 빠르기(Hz) — 블루투스 통화 방식이면 8000·16000 처럼 낮게 나온다.
import { PitchDetector, freqToMidi, VOICES } from './pitch.js';
import { settings, el, audioCtx } from './util.js';
import { getMic, releaseMic } from './game.js';

const NAMES = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
export const noteName = (m) => { const r = Math.round(m); return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };

export class MicTest {
  constructor() {
    this.btn = el('button', { class: 'secondary', onclick: () => (this.on ? this.stop() : this.start()) }, '마이크 시험');
    this.box = el('div', { class: 'mictest', hidden: true });
    this.root = el('div', { class: 'field col' }, this.btn, this.box);
    this.on = false;
    this.hist = [];
  }

  async start() {
    if (this.on) return;
    this.on = true;
    this.btn.textContent = '그만';
    this.box.hidden = false;
    this.box.replaceChildren(el('p', { class: 'hint' }, '마이크 여는 중…'));
    try {
      const ctx = audioCtx();
      try { await ctx.resume(); } catch (e) { console.warn('소리 장치 깨우기 실패', e); }
      const s = settings();
      this.stream = await getMic(s.echoCancel, s.micId);
      if (!this.on) return;
      this.node = ctx.createMediaStreamSource(this.stream);
      this.an = ctx.createAnalyser();
      this.an.fftSize = 2048;
      this.node.connect(this.an);
      this.buf = new Float32Array(this.an.fftSize);
      const vc = VOICES[s.voice] || VOICES.both;
      this.det = new PitchDetector(ctx.sampleRate, this.an.fftSize, vc);
      const lowName = noteName(freqToMidi(this.det.minHz)), highName = noteName(freqToMidi(vc.max));
      const tr = this.stream.getAudioTracks()[0];
      const st = (tr && tr.getSettings) ? tr.getSettings() : {};
      const rate = st.sampleRate ? `${st.sampleRate}Hz` : '표본 빠르기 모름';
      this.nameEl = el('div', { class: 'mt-name' }, '—');
      this.hzEl = el('span', { class: 'mt-hz' }, '');
      this.lvBar = el('i');
      this.gateMark = el('b');
      this.cv = el('canvas', { class: 'mt-graph', width: '600', height: '140' });
      this.box.replaceChildren(
        el('div', { class: 'mt-top' }, this.nameEl, this.hzEl),
        el('div', { class: 'mt-level', 'aria-hidden': 'true' }, this.lvBar, this.gateMark),
        this.cv,
        el('p', { class: 'hint' }, `쓰는 마이크: ${(tr && tr.label) || '이름 모름'} · ${rate}`),
        el('p', { class: 'hint' }, `목소리 기준 '${vc.name}': ${lowName}(${Math.round(this.det.minHz)}Hz) ~ ${highName} 사이만 잡습니다.`),
        el('p', { class: 'hint' }, '"아~" 하고 음을 올렸다 내려 보세요. 음 이름이 따라 바뀌면 마이크는 괜찮습니다. 막대가 세로 금(감도)을 못 넘으면 소리가 작다고 보고 무시합니다.'),
      );
      this.hist = [];
      this.tick = this.tick.bind(this);
      this.raf = requestAnimationFrame(this.tick);
    } catch (e) {
      console.warn('마이크 시험 실패', e);
      this.box.replaceChildren(el('p', { class: 'hint' }, '마이크를 못 열었습니다: ' + (e && e.message || e)));
      this.on = false;
      this.btn.textContent = '마이크 시험';
    }
  }

  tick(now) {
    if (!this.on) return;
    this.raf = requestAnimationFrame(this.tick);
    this.an.getFloatTimeDomainData(this.buf);
    const gate = settings().micGate;
    const r = this.det.detect(this.buf, gate);
    // 크기 막대: 0.1 을 끝으로(제곱근 눈금 — 작은 소리도 보이게)
    const pos = (v) => Math.min(100, Math.sqrt(v / 0.1) * 100);
    this.lvBar.style.width = pos(r.rms) + '%';
    this.gateMark.style.left = pos(gate) + '%';
    const m = r.freq > 0 ? freqToMidi(r.freq) : 0;
    if (m) {
      this.nameEl.textContent = noteName(m);
      this.hzEl.textContent = Math.round(r.freq) + 'Hz';
    } else {
      this.nameEl.textContent = '—';
      this.hzEl.textContent = r.rms < gate ? '소리 작음' : '음을 못 잡음';
    }
    this.hist.push({ t: now, m });
    while (this.hist.length && this.hist[0].t < now - 6000) this.hist.shift();
    this.draw(now);
  }

  draw(now) {
    const cv = this.cv, g = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = cv.clientWidth || 300, H = cv.clientHeight || 120;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const voiced = this.hist.filter((p) => p.m).map((p) => p.m).sort((a, b) => a - b);
    const mid = voiced.length ? Math.round(voiced[voiced.length >> 1]) : 60;
    const lo = mid - 8, hi = mid + 8;
    const y = (m) => H - ((m - lo) / (hi - lo)) * H;
    // 반음 줄 · 도 줄은 진하게 + 이름
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let k = lo; k <= hi; k++) {
      const isC = ((k % 12) + 12) % 12 === 0;
      g.fillStyle = isC ? (css.getPropertyValue('--grid-strong') || '#444') : (css.getPropertyValue('--grid') || '#222');
      g.fillRect(0, Math.round(y(k)), W, 1);
      if (isC || k === mid) { g.fillStyle = css.getPropertyValue('--muted') || '#999'; g.fillText(noteName(k), 4, y(k) - 7); }
    }
    g.fillStyle = css.getPropertyValue('--accent') || '#38bdf8';
    for (const p of this.hist) {
      if (!p.m || p.m < lo - 1 || p.m > hi + 1) continue;
      const x = W - ((now - p.t) / 6000) * W;
      g.fillRect(x - 1.5, y(p.m) - 1.5, 3, 3);
    }
  }

  stop() {
    this.on = false;
    cancelAnimationFrame(this.raf);
    try { if (this.node) this.node.disconnect(); } catch (e) { console.warn('마이크 끊기 실패', e); }
    this.node = null;
    releaseMic();
    this.btn.textContent = '마이크 시험';
    this.box.hidden = true;
  }
}
