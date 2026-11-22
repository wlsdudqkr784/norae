// 마이크 시험 (11-13) — 노래 없이 소리를 내면 앱이 듣는 음 이름·소리 크기·지난 6초 음높이를 바로 보여 준다.
// 부르기 화면과 같은 길(getMic · PitchDetector · 설정의 감도)로 들어서, 여기서 맞게 잡히면 부르기에서도 잡힌다.
// 함께 보이는 것: 쓰는 마이크 이름과 표본 빠르기(Hz) — 블루투스 통화 방식이면 8000·16000 처럼 낮게 나온다.
import { PitchDetector, freqToMidi, midiToFreq, RANGE, RangeTracker, noteName, pitchWindow } from './pitch.js';
import { settings, el, audioCtx } from './util.js';
import { getMic, releaseMic } from './game.js';

export { noteName };   // 예전처럼 여기서도 가져갈 수 있게 (이름 함수는 pitch.js 로 옮김 11-21)

export class MicTest {
  constructor() {
    this.btn = el('button', { class: 'secondary', onclick: () => (this.on ? this.stop() : this.start()) }, '마이크 시험');
    this.box = el('div', { class: 'mictest', hidden: true });
    this.root = el('div', { class: 'field col' }, this.btn, this.box);
    this.on = false;
    this.hist = [];
    // 시작마다 번호(11-22 감사): 마이크를 여는 중에 '그만'·화면 떠나기·마이크 바꾸기가 오면 늦게 끝난 시작은 번호가 달라
    // 화면을 그리지 않고, 꺼진 상태면 마이크를 놓는다(전에는 그냥 나가서 마이크가 켜진 채 남았다).
    this.gen = 0;
    this.opening = null;   // 앞 시작의 마이크 열기 — 겹쳐 열지 않게(겹치면 먼저 연 줄기가 캐시 밖에서 켜진 채 남는다)
  }

  async start() {
    if (this.on) return;
    const gen = ++this.gen;
    this.on = true;
    this.btn.textContent = '그만';
    this.box.hidden = false;
    this.box.replaceChildren(el('p', { class: 'hint' }, '마이크 여는 중…'));
    try {
      const ctx = audioCtx();
      try { await ctx.resume(); } catch (e) { console.warn('소리 장치 깨우기 실패', e); }
      if (gen !== this.gen) return;   // 그 사이 그만·다시 시작 — 아직 마이크를 안 열었다
      const s = settings();
      const prev = this.opening;
      const open = (async () => {
        if (prev) { try { await prev; } catch (e) { console.warn('앞 마이크 열기 실패(무시하고 다시 엶)', e); } }
        return getMic(s.echoCancel, s.micId);
      })();
      this.opening = open;
      const stream = await open;
      if (this.opening === open) this.opening = null;
      if (gen !== this.gen) {
        // 늦게 열림: 꺼진 상태면 방금 연 마이크를 놓는다. 새 시작이 기다리는 중이면 그 시작이 캐시를 이어 쓴다
        if (!this.on) releaseMic();
        console.warn('마이크 시험: 늦게 열린 마이크', this.on ? '(새 시작이 이어 씀)' : '(놓음)');
        return;
      }
      this.stream = stream;
      this.node = ctx.createMediaStreamSource(this.stream);
      this.an = ctx.createAnalyser();
      // 창 크기는 표본 빠르기에 맞춰(11-22 감사 — 96·192kHz 장치에서 낮은 음을 못 잡던 것). 부르기 화면도 같은 값을 써야 한다
      this.an.fftSize = pitchWindow(ctx.sampleRate);
      this.node.connect(this.an);
      this.buf = new Float32Array(this.an.fftSize);
      this.det = new PitchDetector(ctx.sampleRate, this.an.fftSize);
      const lowName = noteName(freqToMidi(this.det.minHz)), highName = noteName(freqToMidi(this.det.maxHz));
      this.range = new RangeTracker();   // 11-21: 지금까지 잡힌 가장 낮은·높은 음
      this.rangeEl = el('p', { class: 'mt-range' }, '가장 낮은 음 — · 가장 높은 음 —');
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
        this.rangeEl,
        el('p', { class: 'hint' }, `${lowName}(${Math.round(this.det.minHz)}Hz) ~ ${highName}(${Math.round(this.det.maxHz)}Hz) 사이를 잡습니다 (전기 웅 소리 60Hz 근처는 버림). 0.3초 넘게 낸 음만 가장 낮은·높은 음에 셉니다.`),
        ...(this.det.minHz > RANGE.min + 2 ? [el('p', { class: 'hint' }, `소리 장치 표본 빠르기(${ctx.sampleRate}Hz) 때문에 ${lowName}보다 낮은 음은 못 잡습니다.`)] : []),
        el('p', { class: 'hint' }, '"아~" 하고 음을 올렸다 내려 보세요. 음 이름이 따라 바뀌면 마이크는 괜찮습니다. 막대가 세로 금(감도)을 못 넘으면 소리가 작다고 보고 무시합니다.'),
      );
      this.hist = [];
      this.tick = this.tick.bind(this);
      this.raf = requestAnimationFrame(this.tick);
    } catch (e) {
      console.warn('마이크 시험 실패', e);
      if (gen !== this.gen) return;   // 이미 그만·다시 시작 — 지금 화면을 덮지 않는다
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
    this.range.feed(m, r.clarity, now);
    const rg = this.range.low == null ? null : this.range;
    if (rg && (rg.low !== this.shownLow || rg.high !== this.shownHigh)) {
      this.shownLow = rg.low; this.shownHigh = rg.high;
      const f = (x) => `${noteName(x)} (${Math.round(midiToFreq(x))}Hz)`;
      this.rangeEl.textContent = `가장 낮은 음 ${f(rg.low)} · 가장 높은 음 ${f(rg.high)}`;
    }
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
    this.gen++;   // 여는 중인 시작이 있으면 늦게 끝나도 화면을 그리지 않고 마이크를 놓게
    this.on = false;
    cancelAnimationFrame(this.raf);
    try { if (this.node) this.node.disconnect(); } catch (e) { console.warn('마이크 끊기 실패', e); }
    this.node = null;
    releaseMic();
    this.btn.textContent = '마이크 시험';
    this.box.hidden = true;
  }
}
