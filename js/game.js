// 부르기 화면 — 소리 재생, 마이크 음높이, 채점, 그리기.
import { PitchDetector, freqToMidi, midiToFreq, foldOctave } from './pitch.js';
import { settings, saveSettings, LEVELS, fmtTime, el, toast, audioCtx } from './util.js';
import { updateSong, putBlob } from './library.js';
import { TakePlayer } from './take.js';

const ICON = {
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" class="fill"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M18 6l-8 6 8 6zM6 6v12" class="fill"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 6l8 6-8 6zM18 6v12" class="fill"/></svg>',
  loop: '<svg viewBox="0 0 24 24"><path d="M4 12a7 7 0 0 1 12-5l2 2M20 12a7 7 0 0 1-12 5l-2-2M18 4v5h-5M6 20v-5h5"/></svg>',
  guide: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M5 6l7 6-7 6zM12 6l7 6-7 6z" class="fill"/></svg>',
};

export { audioCtx };

let micCache = null; // {stream, echo}
async function getMic(echo) {
  if (micCache && micCache.echo === echo && micCache.stream.getAudioTracks().some((t) => t.readyState === 'live')) return micCache.stream;
  if (micCache) micCache.stream.getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: echo, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  micCache = { stream, echo };
  return stream;
}
export function releaseMic() {
  if (micCache) { micCache.stream.getTracks().forEach((t) => t.stop()); micCache = null; }
}

export class Session {
  // opts: {fakeMic: AudioBuffer} — 시험용(목소리 파일을 마이크 대신)
  constructor(root, meta, song, buffer, opts = {}) {
    this.root = root;
    this.meta = meta;
    this.song = song;
    this.buffer = buffer;
    this.opts = opts;
    this.ctx = audioCtx();
    this.state = 'ready'; // ready | playing | paused | done
    this.offsetMs = song.startMs || 0;
    this.t0 = 0;
    this.src = null;
    this.fakeSrc = null;
    this.guideNodes = [];
    this.guideUntil = 0;
    this.loopLine = -1;
    this.practiced = false;
    this.lastS = null;
    this.trail = [];
    this.curLine = -2;
    this.view = { center: 0, span: 14, init: false };
    this.lineScores = new Array(song.lines.length).fill(null);
    this.ratedUntil = -1;
    this.lastDetect = 0;
    this.shownScore = 0;
    this.destroyed = false;
    this.endMs = Math.min(buffer.duration * 1000, (song.endMs || Infinity), song.lines[song.lines.length - 1].end + 2500);

    for (const n of song.notes) { n.hit = 0; n.segs = []; }
    this.weightTotal = song.notes.reduce((a, n) => a + this.weight(n), 0) || 1;

    this.music = this.ctx.createGain();
    this.music.gain.value = settings().musicVol;
    this.music.connect(this.ctx.destination);
    this.guideGain = this.ctx.createGain();
    this.guideGain.gain.value = settings().guideVol;
    this.guideGain.connect(this.ctx.destination);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.detector = new PitchDetector(this.ctx.sampleRate, this.analyser.fftSize);

    this.build();
    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
    this.onVis = () => { if (document.hidden && this.state === 'playing') this.pause(); };
    document.addEventListener('visibilitychange', this.onVis);
  }

  weight(n) {
    if (n.type === 'free') return 0;
    const d = n.end - n.start;
    return n.type === 'golden' || n.type === 'rapgolden' ? d * 2 : d;
  }

  // ---------- 화면 ----------
  build() {
    const s = settings();
    this.root.innerHTML = '';
    this.root.classList.add('play');
    this.scoreEl = el('div', { class: 'score', 'aria-label': '점수' }, '0');
    const top = el('header', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '그만하기', html: ICON.close, onclick: () => this.askQuit() }),
      el('div', { class: 'title' }, el('b', {}, this.meta.title), el('small', {}, this.meta.artist)),
      this.scoreEl,
    );
    this.canvas = el('canvas', { class: 'lane' });
    this.laneWrap = el('div', { class: 'lane-wrap' }, this.canvas);
    this.rateEl = el('div', { class: 'rate' });
    this.curEl = el('div', { class: 'lyr cur' });
    this.nextEl = el('div', { class: 'lyr next' });
    this.waitEl = el('div', { class: 'wait' });
    this.skipBtn = el('button', { class: 'chip skip', html: ICON.skip + '<span>건너뛰기</span>', onclick: () => this.skipGap() });
    const lyrics = el('section', { class: 'lyrics' }, this.rateEl, this.waitEl, this.curEl, this.nextEl, this.skipBtn);

    this.progFill = el('div', { class: 'fill' });
    this.progMarks = el('div', { class: 'marks' });
    this.timeEl = el('span', { class: 'time' }, '0:00');
    this.prog = el('div', { class: 'progress', role: 'slider', 'aria-label': '재생 위치' }, this.progMarks, this.progFill);
    this.prog.addEventListener('pointerdown', (e) => this.seekFromBar(e));
    for (const l of this.song.lines) {
      this.progMarks.append(el('i', { style: `left:${(l.start / this.endMs) * 100}%;width:${((l.end - l.start) / this.endMs) * 100}%` }));
    }

    this.playBtn = el('button', { class: 'ctl big', 'aria-label': '재생/멈춤', html: ICON.play, onclick: () => this.toggle() });
    this.loopBtn = el('button', { class: 'ctl', 'aria-label': '이 줄 반복', html: ICON.loop + '<span>줄 반복</span>', onclick: () => this.toggleLoop() });
    this.guideBtn = el('button', { class: 'ctl' + (s.guide ? ' on' : ''), 'aria-label': '가이드 음', html: ICON.guide + '<span>가이드 음</span>', onclick: () => this.toggleGuide() });
    const controls = el('footer', { class: 'controls' },
      el('div', { class: 'prog-row' }, this.timeEl, this.prog, el('span', { class: 'time' }, fmtTime(this.endMs))),
      el('div', { class: 'btn-row' },
        this.loopBtn,
        el('button', { class: 'ctl', 'aria-label': '이전 줄', html: ICON.prev + '<span>이전 줄</span>', onclick: () => this.jumpLine(-1) }),
        this.playBtn,
        el('button', { class: 'ctl', 'aria-label': '다음 줄', html: ICON.next + '<span>다음 줄</span>', onclick: () => this.jumpLine(1) }),
        this.guideBtn,
      ),
    );
    this.overlay = el('div', { class: 'overlay' });
    this.root.append(top, this.laneWrap, lyrics, controls, this.overlay);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.laneWrap);
    this.resize();
    this.showReady();
  }

  resize() {
    const r = this.laneWrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.g = this.canvas.getContext('2d');
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  showOverlay(node) {
    this.overlay.innerHTML = '';
    if (!node) { this.overlay.classList.remove('show'); return; }
    this.overlay.append(node);
    this.overlay.classList.add('show');
  }

  levelPicker() {
    const s = settings();
    const wrap = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': '난이도' });
    for (const [k, v] of Object.entries(LEVELS)) {
      const b = el('button', { class: k === s.level ? 'on' : '', role: 'radio', 'aria-checked': String(k === s.level), onclick: () => {
        saveSettings({ level: k });
        wrap.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      } }, v.name);
      wrap.append(b);
    }
    return wrap;
  }

  showReady() {
    const s = settings();
    const guide = el('input', { type: 'checkbox', checked: s.guide, onchange: (e) => { saveSettings({ guide: e.target.checked }); this.guideBtn.classList.toggle('on', e.target.checked); } });
    const card = el('div', { class: 'card' },
      el('h2', {}, this.meta.title),
      el('p', { class: 'muted' }, [this.meta.artist, fmtTime(this.endMs), this.meta.best ? `최고 ${this.meta.best.toLocaleString()}점` : ''].filter(Boolean).join(' · ')),
      el('div', { class: 'field' }, el('span', {}, '난이도'), this.levelPicker()),
      el('label', { class: 'toggle' }, guide, el('span', {}, '가이드 음 (악보 음을 작게 들려줌)')),
      el('button', { class: 'primary', onclick: () => this.begin() }, '시작'),
      el('p', { class: 'hint' }, '이어폰을 끼면 마이크가 노래 소리를 덜 듣습니다.'),
    );
    this.showOverlay(card);
  }

  async begin() {
    this.showOverlay(el('div', { class: 'card' }, el('p', {}, '마이크 준비 중…')));
    try { await this.ctx.resume(); } catch { /* 아래 재생에서 다시 */ }
    this.micOk = false;
    this.recStream = null; // 내 노래 녹음에 쓸 소리 줄기
    if (this.opts.fakeMic) {
      this.micOk = true;
      try { this.recDest = this.ctx.createMediaStreamDestination(); this.recStream = this.recDest.stream; } catch (e) { console.warn('시험 녹음 줄기 실패', e); }
    } else {
      try {
        const stream = await getMic(settings().echoCancel);
        this.micNode = this.ctx.createMediaStreamSource(stream);
        this.micNode.connect(this.analyser);
        this.micOk = true;
        this.recStream = stream;
      } catch (e) {
        toast('마이크를 못 써서 점수 없이 재생합니다');
        console.warn('마이크 실패', e);
      }
    }
    this.showOverlay(null);
    this.play(this.offsetMs);
    this.startTake();
  }

  // ---------- 내 노래 녹음 ----------
  // 처음부터 끝까지 부른 판만 남긴다. 옮기기·줄 반복을 쓰면 버린다.
  startTake() {
    this.dropTake();
    if (!this.recStream || typeof MediaRecorder === 'undefined' || this.practiced) return;
    try {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const rec = new MediaRecorder(this.recStream, mime ? { mimeType: mime, audioBitsPerSecond: 96000 } : {});
      const lat = this.opts.fakeMic ? 0 : this.outLat() + settings().micLatency;
      // 녹음 0초가 곡의 몇 ms 에 부른 소리인가
      const take = { rec, chunks: [], mime: rec.mimeType || mime, offsetMs: this.offsetMs - (this.t0 - this.ctx.currentTime) * 1000 - lat };
      rec.ondataavailable = (e) => { if (e.data && e.data.size) take.chunks.push(e.data); };
      rec.onerror = (e) => { console.warn('녹음 오류', e.error || e); if (this.take === take) this.take = null; };
      rec.start(1000);
      this.take = take;
    } catch (e) {
      console.warn('녹음 시작 실패', e);
      this.take = null;
    }
  }

  dropTake() {
    clearTimeout(this.takeT);
    const t = this.take;
    this.take = null;
    if (!t) return;
    t.rec.ondataavailable = null;
    try { if (t.rec.state !== 'inactive') t.rec.stop(); } catch (e) { console.warn('녹음 멈추기 실패', e); }
  }

  stopTake(t) {
    return new Promise((res) => {
      const done = () => { clearTimeout(timer); res(new Blob(t.chunks, { type: t.mime })); };
      const timer = setTimeout(done, 3000);
      t.rec.onstop = done;
      try { if (t.rec.state === 'inactive') done(); else t.rec.stop(); } catch (e) { console.warn('녹음 끝내기 실패', e); done(); }
    });
  }

  // ---------- 재생 ----------
  outLat() {
    const s = settings();
    if (this.opts.fakeMic) return 0;
    if (s.outLatency >= 0) return s.outLatency;
    return ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000;
  }

  pos() {
    if (this.state !== 'playing') return this.offsetMs;
    return (this.ctx.currentTime - this.t0) * 1000 + this.offsetMs;
  }

  // 들리는 시각(화면 기준)
  heard() { return this.pos() - this.outLat(); }

  play(fromMs) {
    this.stopSources();
    clearTimeout(this.fadeT);
    this.music.gain.cancelScheduledValues(0);
    this.music.gain.value = settings().musicVol;
    fromMs = Math.max(0, Math.min(fromMs, this.buffer.duration * 1000 - 50));
    const when = this.ctx.currentTime + 0.06;
    this.src = this.ctx.createBufferSource();
    this.src.buffer = this.buffer;
    this.src.connect(this.music);
    this.src.start(when, fromMs / 1000);
    if (this.opts.fakeMic) {
      this.fakeSrc = this.ctx.createBufferSource();
      this.fakeSrc.buffer = this.opts.fakeMic;
      this.fakeSrc.connect(this.analyser);
      if (this.recDest) this.fakeSrc.connect(this.recDest);
      this.fakeSrc.start(when, fromMs / 1000);
    }
    if (this.take && this.take.rec.state === 'paused') {
      const t = this.take;
      this.takeT = setTimeout(() => { try { if (t.rec.state === 'paused') t.rec.resume(); } catch (e) { console.warn('녹음 잇기 실패', e); } }, 60);
    }
    this.t0 = when;
    this.offsetMs = fromMs;
    this.guideUntil = fromMs;
    this.lastS = null;
    this.state = 'playing';
    this.playBtn.innerHTML = ICON.pause;
    this.lockScreen(true);
  }

  stopSources() {
    for (const s of [this.src, this.fakeSrc]) { if (s) { try { s.stop(); } catch { /* 이미 멈춤 */ } s.disconnect(); } }
    this.src = this.fakeSrc = null;
    for (const o of this.guideNodes) { try { o.stop(); } catch { /* 이미 멈춤 */ } }
    this.guideNodes = [];
  }

  pause(showMenu = true) {
    if (this.state !== 'playing') return;
    this.offsetMs = this.pos();
    this.stopSources();
    clearTimeout(this.takeT);
    try { if (this.take && this.take.rec.state === 'recording') this.take.rec.pause(); } catch (e) { console.warn('녹음 쉬기 실패', e); }
    this.state = 'paused';
    this.playBtn.innerHTML = ICON.play;
    this.lockScreen(false);
    if (showMenu) this.showPause();
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') { this.showOverlay(null); this.play(this.offsetMs); }
    else if (this.state === 'ready') this.begin();
  }

  showPause() {
    this.showOverlay(el('div', { class: 'card' },
      el('h2', {}, '멈춤'),
      el('button', { class: 'primary', onclick: () => { this.showOverlay(null); this.play(this.offsetMs); } }, '계속'),
      el('button', { class: 'secondary', onclick: () => this.restart() }, '처음부터'),
      el('button', { class: 'secondary', onclick: () => this.quit() }, '목록으로'),
    ));
  }

  askQuit() {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.showPause();
    else this.quit();
  }

  restart() {
    this.closeTake();
    this.dropTake();
    for (const n of this.song.notes) { n.hit = 0; n.segs = []; }
    this.lineScores.fill(null);
    this.ratedUntil = -1;
    this.trail = [];
    this.practiced = false;
    this.loopLine = -1;
    this.loopBtn.classList.remove('on');
    this.showOverlay(null);
    this.state = 'paused';
    this.play(this.song.startMs || 0);
    this.startTake();
  }

  seek(ms) {
    ms = Math.max(0, Math.min(ms, this.endMs - 100));
    this.practiced = true;
    this.dropTake();
    // 다시 부르는 곳의 점수는 지우고 새로 매긴다
    for (const n of this.song.notes) if (n.end > ms) { n.hit = 0; n.segs = []; }
    for (const l of this.song.lines) if (l.end > ms) this.lineScores[l.index] = null;
    this.ratedUntil = this.song.lines.findIndex((l) => l.end > ms) - 1;
    if (this.ratedUntil < -1) this.ratedUntil = this.song.lines.length - 1;
    this.trail = this.trail.filter((p) => p.S < ms);
    if (this.state === 'playing') this.play(ms + this.outLat());
    else this.offsetMs = ms;
  }

  seekFromBar(e) {
    const r = this.prog.getBoundingClientRect();
    const go = (x) => this.seek(((x - r.left) / r.width) * this.endMs);
    go(e.clientX);
    const move = (ev) => { this.offsetPreview = ((ev.clientX - r.left) / r.width) * this.endMs; };
    const up = (ev) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); go(ev.clientX); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  lineAt(t) {
    const L = this.song.lines;
    for (let i = 0; i < L.length; i++) if (t < L[i].end + 250) return i;
    return L.length;
  }

  jumpLine(d) {
    const t = this.heard();
    const L = this.song.lines;
    let i = this.lineAt(t);
    if (d < 0) {
      // 줄 시작에서 2초 안이면 앞 줄로
      if (i < L.length && t - L[i].start < 2000) i--;
      if (i >= L.length) i = L.length - 1;
    } else {
      i = Math.min(L.length - 1, (i < L.length && t >= L[i].start - 1500 ? i + 1 : i));
    }
    i = Math.max(0, i);
    if (this.loopLine >= 0) this.loopLine = i;
    this.seek(L[i].start - 1500);
  }

  toggleLoop() {
    if (this.loopLine >= 0) { this.loopLine = -1; this.loopBtn.classList.remove('on'); toast('줄 반복 끔'); return; }
    const i = Math.min(this.lineAt(this.heard()), this.song.lines.length - 1);
    this.loopLine = i;
    this.practiced = true;
    this.dropTake();
    this.loopBtn.classList.add('on');
    toast(`이 줄 반복: "${this.song.lines[i].syllables.map((s) => s.text + (s.space ? ' ' : '')).join('').trim().slice(0, 18)}"`);
  }

  toggleGuide() {
    const on = !settings().guide;
    saveSettings({ guide: on });
    this.guideBtn.classList.toggle('on', on);
    if (!on) { for (const o of this.guideNodes) { try { o.stop(); } catch { /* 이미 멈춤 */ } } this.guideNodes = []; }
    else this.guideUntil = this.pos();
    toast(on ? '가이드 음 켬' : '가이드 음 끔');
  }

  skipGap() {
    const t = this.heard();
    const n = this.song.notes.find((x) => x.start > t);
    if (n && n.start - t > 4000) this.seek(n.start - 3000);
  }

  async lockScreen(on) {
    try {
      if (on && !this.wake && navigator.wakeLock) { this.wake = await navigator.wakeLock.request('screen'); }
      if (!on && this.wake) { await this.wake.release(); this.wake = null; }
    } catch { /* 화면 켜짐 유지를 못 해도 노래는 된다 */ }
  }

  // ---------- 매 화면 ----------
  frame(now) {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    if (this.state === 'playing') {
      if (now - this.lastDetect >= 16) { this.lastDetect = now; this.detect(); }
      if (settings().guide) this.scheduleGuide();
      const t = this.heard();
      if (this.loopLine >= 0) {
        const l = this.song.lines[this.loopLine];
        if (t > l.end + 600) this.seek(l.start - 1500);
      }
      this.rateLines(t);
      if (t >= this.endMs) this.finish();
    }
    this.draw(dt);
    this.drawLyrics();
    this.drawChrome();
  }

  detect() {
    if (!this.micOk) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    const r = this.detector.detect(this.buf, settings().micGate);
    const half = (this.analyser.fftSize / 2 / this.ctx.sampleRate) * 1000;
    const lat = this.opts.fakeMic ? 0 : this.outLat() + settings().micLatency;
    const S = this.pos() - half - lat; // 이 소리가 맞춰 부른 곡 시각
    const prev = this.lastS;
    this.lastS = S;
    if (prev == null || S <= prev) return;
    const dt = Math.min(60, S - prev);
    const midi = r.freq > 0 ? freqToMidi(r.freq) : 0;
    const note = this.noteAt(S);
    let hit = false, shown = midi;
    if (midi > 0) {
      if (note) {
        shown = foldOctave(midi, note.midi);
        if (note.type !== 'free') {
          const tol = LEVELS[settings().level].tol;
          hit = note.type === 'rap' || note.type === 'rapgolden' || Math.abs(shown - note.midi) <= tol;
          if (hit) {
            note.hit = Math.min(note.end - note.start, note.hit + dt);
            const last = note.segs[note.segs.length - 1];
            const a = Math.max(note.start, S - dt);
            if (last && a - last[1] < 40) last[1] = Math.min(note.end, S);
            else note.segs.push([a, Math.min(note.end, S)]);
          }
        }
      } else {
        shown = foldOctave(midi, this.view.center);
      }
    }
    this.trail.push({ S, m: midi > 0 ? shown : 0, hit, target: note ? note.midi : null });
    const cut = S - 6000;
    while (this.trail.length && this.trail[0].S < cut) this.trail.shift();
  }

  noteAt(S) {
    const N = this.song.notes;
    // 음표는 시간순 — 이분 탐색
    let lo = 0, hi = N.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (N[mid].end <= S) lo = mid + 1;
      else if (N[mid].start > S) hi = mid - 1;
      else return N[mid];
    }
    return null;
  }

  scheduleGuide() {
    const p = this.pos();
    const until = p + 600;
    if (until <= this.guideUntil) return;
    for (const n of this.song.notes) {
      if (n.start < this.guideUntil || n.type === 'free') continue;
      if (n.start >= until) break;
      const when = this.t0 + (n.start - this.offsetMs) / 1000;
      if (when < this.ctx.currentTime) continue;
      const dur = Math.max(0.06, (n.end - n.start) / 1000 - 0.02);
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = midiToFreq(n.midi);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(1, when + 0.015);
      g.gain.setValueAtTime(1, when + dur - 0.04);
      g.gain.linearRampToValueAtTime(0, when + dur);
      o.connect(g).connect(this.guideGain);
      o.start(when);
      o.stop(when + dur + 0.02);
      o.onended = () => { g.disconnect(); const i = this.guideNodes.indexOf(o); if (i >= 0) this.guideNodes.splice(i, 1); };
      this.guideNodes.push(o);
    }
    this.guideUntil = until;
  }

  noteFrac(n) {
    const d = n.end - n.start;
    return d > 0 ? Math.min(1, n.hit / d / 0.85) : 0;
  }

  score() {
    let s = 0;
    for (const n of this.song.notes) s += this.weight(n) * this.noteFrac(n);
    return Math.round((s / this.weightTotal) * 10000);
  }

  lineAcc(l) {
    let w = 0, s = 0;
    for (const n of l.notes) { const k = this.weight(n); w += k; s += k * this.noteFrac(n); }
    return w > 0 ? s / w : null;
  }

  rateLines(t) {
    const L = this.song.lines;
    while (this.ratedUntil + 1 < L.length && t > L[this.ratedUntil + 1].end + 150) {
      this.ratedUntil++;
      const l = L[this.ratedUntil];
      const a = this.lineAcc(l);
      this.lineScores[l.index] = a;
      if (a == null || !this.micOk) continue;
      const word = a >= 0.9 ? '완벽!' : a >= 0.7 ? '좋아요' : a >= 0.45 ? '괜찮아요' : '';
      if (word) {
        this.rateEl.textContent = word;
        this.rateEl.className = 'rate show ' + (a >= 0.9 ? 'r3' : a >= 0.7 ? 'r2' : 'r1');
        clearTimeout(this.rateT);
        this.rateT = setTimeout(() => { this.rateEl.className = 'rate'; }, 1300);
      }
    }
  }

  // 음 줄 그리기
  draw(dt) {
    const g = this.g, W = this.W, H = this.H;
    if (!g) return;
    const t = this.heard();
    const cx = Math.round(W * 0.24);
    const msWindow = Math.max(3200, Math.min(6500, W * 9));
    const pxPerMs = W / msWindow;
    const x = (ms) => cx + (ms - t) * pxPerMs;
    const tL = t - cx / pxPerMs, tR = t + (W - cx) / pxPerMs;

    // 보이는 음으로 위아래 범위
    let lo = Infinity, hi = -Infinity;
    for (const n of this.song.notes) {
      if (n.end < tL - 500) continue;
      if (n.start > tR + 1500) break;
      lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi);
    }
    if (lo === Infinity) {
      const nx = this.song.notes.find((n) => n.start > t) || this.song.notes[this.song.notes.length - 1];
      lo = hi = nx.midi;
    }
    const tc = (lo + hi) / 2, ts = Math.max(13, hi - lo + 6);
    const v = this.view;
    if (!v.init) { v.center = tc; v.span = ts; v.init = true; }
    const k = Math.min(1, dt * 3.5);
    v.center += (tc - v.center) * k;
    v.span += (ts - v.span) * k;
    const padY = 10;
    const rowH = (H - padY * 2) / v.span;
    const y = (m) => H / 2 - (m - v.center) * rowH;

    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(this.root);
    const col = (n) => css.getPropertyValue(n).trim();
    const cGrid = col('--grid'), cGridC = col('--grid-strong'), cNote = col('--note'), cNoteLine = col('--note-line'),
      cHit = col('--hit'), cGold = col('--gold'), cMiss = col('--miss'), cCursor = col('--cursor');

    // 반음 가로줄
    const m0 = Math.floor(v.center - v.span / 2) - 1, m1 = Math.ceil(v.center + v.span / 2) + 1;
    for (let m = m0; m <= m1; m++) {
      const yy = Math.round(y(m)) + 0.5;
      g.fillStyle = (m % 12 + 12) % 12 === 0 ? cGridC : cGrid;
      g.fillRect(0, yy, W, 1);
    }

    // 음표
    const h = Math.max(8, Math.min(26, rowH * 0.82));
    for (const n of this.song.notes) {
      if (n.end < tL) continue;
      if (n.start > tR) break;
      const x0 = x(n.start), x1 = Math.max(x0 + 4, x(n.end) - 1.5);
      const yy = y(n.midi) - h / 2;
      const gold = n.type === 'golden' || n.type === 'rapgolden';
      const active = t >= n.start && t < n.end;
      rr(g, x0, yy, x1 - x0, h, h / 2);
      g.fillStyle = cNote;
      g.fill();
      g.lineWidth = active ? 2.5 : 1.5;
      g.strokeStyle = gold ? cGold : cNoteLine;
      if (n.type === 'free') g.setLineDash([4, 4]);
      g.stroke();
      g.setLineDash([]);
      if (n.segs.length) {
        g.save();
        rr(g, x0, yy, x1 - x0, h, h / 2);
        g.clip();
        g.fillStyle = gold ? cGold : cHit;
        for (const [a, b] of n.segs) g.fillRect(x(a), yy, Math.max(1, x(b) - x(a)), h);
        g.restore();
      }
    }

    // 내 목소리 자취
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(3, h * 0.28);
    let prev = null;
    for (const p of this.trail) {
      if (p.S < tL - 100) { prev = null; continue; }
      if (!p.m) { prev = null; continue; }
      const px = x(p.S), py = y(p.m);
      if (prev && p.S - prev.S < 90 && Math.abs(p.m - prev.m) < 3) {
        g.strokeStyle = p.hit ? cHit : cMiss;
        g.globalAlpha = p.hit ? 1 : 0.75;
        g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(px, py); g.stroke();
      }
      prev = { S: p.S, m: p.m, x: px, y: py };
    }
    g.globalAlpha = 1;

    // 기준선
    g.fillStyle = cCursor;
    g.fillRect(cx - 1, 0, 2, H);

    // 지금 목소리 + 위/아래 안내
    const last = this.trail[this.trail.length - 1];
    if (this.state === 'playing' && last && last.m && t - last.S < 400) {
      const py = y(last.m);
      g.beginPath();
      g.arc(cx, Math.max(6, Math.min(H - 6, py)), Math.max(5, h * 0.36), 0, Math.PI * 2);
      g.fillStyle = last.hit ? cHit : cMiss;
      g.fill();
      if (!last.hit && last.target != null) {
        const up = last.target > last.m;
        const ax = cx + 18, ay = Math.max(14, Math.min(H - 14, py));
        g.beginPath();
        if (up) { g.moveTo(ax - 6, ay + 3); g.lineTo(ax, ay - 5); g.lineTo(ax + 6, ay + 3); }
        else { g.moveTo(ax - 6, ay - 3); g.lineTo(ax, ay + 5); g.lineTo(ax + 6, ay - 3); }
        g.strokeStyle = cMiss; g.lineWidth = 2.5; g.stroke();
      }
    }
  }

  drawLyrics() {
    const t = this.heard();
    const L = this.song.lines;
    const i = this.lineAt(t);
    if (i !== this.curLine) {
      this.curLine = i;
      this.fill(this.curEl, L[i]);
      this.fill(this.nextEl, L[i + 1]);
    }
    const line = L[i];
    if (line) {
      const spans = this.curEl.children;
      line.syllables.forEach((s, j) => {
        const p = Math.max(0, Math.min(1, (t - s.start) / Math.max(1, s.end - s.start)));
        const q = Math.round(p * 100);
        const sp = spans[j];
        if (sp && sp._q !== q) { sp._q = q; sp.style.setProperty('--p', q + '%'); }
      });
    }
    // 기다림 표시·건너뛰기
    const nextNote = line && t < line.start ? line.start : null;
    const wait = nextNote != null ? nextNote - t : 0;
    if (wait > 1200) {
      const sec = Math.ceil(wait / 1000);
      if (this._wait !== sec) { this._wait = sec; this.waitEl.textContent = i === 0 ? `시작까지 ${sec}초` : `다음 줄까지 ${sec}초`; }
      this.waitEl.classList.add('show');
    } else if (this._wait !== 0) { this._wait = 0; this.waitEl.classList.remove('show'); }
    this.skipBtn.classList.toggle('show', this.state === 'playing' && wait > 5000);
  }

  fill(box, line) {
    box.innerHTML = '';
    if (!line) return;
    for (const s of line.syllables) {
      box.append(el('span', { class: 'syl' }, s.text));
      if (s.space) box.append(document.createTextNode(' '));
    }
  }

  drawChrome() {
    const target = this.score();
    if (this.shownScore !== target) {
      this.shownScore += Math.ceil((target - this.shownScore) * 0.2) || (target > this.shownScore ? 1 : -1);
      if (Math.abs(target - this.shownScore) < 2) this.shownScore = target;
      this.scoreEl.textContent = this.micOk || this.opts.fakeMic ? this.shownScore.toLocaleString() : '—';
    }
    const p = this.offsetPreview ?? this.pos();
    this.offsetPreview = undefined;
    this.progFill.style.width = Math.min(100, (p / this.endMs) * 100) + '%';
    const sec = Math.floor(p / 1000);
    if (this._sec !== sec) { this._sec = sec; this.timeEl.textContent = fmtTime(p); }
  }

  // ---------- 끝 ----------
  async finish() {
    if (this.state === 'done') return;
    const end = this.ctx.currentTime;
    try { this.music.gain.setTargetAtTime(0, end, 0.4); } catch { /* 무시 */ }
    this.fadeT = setTimeout(() => this.stopSources(), 1600);
    this.state = 'done';
    this.lockScreen(false);
    this.playBtn.innerHTML = ICON.play;
    const sc = this.score();
    const saved = this.micOk && !this.practiced;
    const isBest = saved && sc > (this.meta.best || 0);
    const take = this.take;
    this.take = null;
    clearTimeout(this.takeT);
    if (take) {
      try {
        const blob = await this.stopTake(take);
        if (!this.practiced && blob.size > 0 && !this.destroyed) {
          await putBlob(this.meta.id + ':take', blob);
          this.meta.take = { offsetMs: Math.round(take.offsetMs), mime: take.mime, at: Date.now(), score: sc, adjust: 0 };
        }
      } catch (e) { console.warn('녹음 저장 실패', e); toast('내 노래 녹음을 저장하지 못했어요'); }
    }
    if (this.destroyed) return;
    try {
      this.meta.plays = (this.meta.plays || 0) + 1;
      this.meta.lastPlayed = Date.now();
      if (isBest) this.meta.best = sc;
      await updateSong(this.meta);
    } catch (e) { console.warn('기록 저장 실패', e); }
    this.lastResult = [sc, saved, isBest];
    this.showResult(sc, saved, isBest);
  }

  showTake() {
    clearTimeout(this.fadeT);
    this.stopSources();
    this.closeTake();
    this.takePlayer = new TakePlayer(this.meta, this.buffer, () => { this.closeTake(); this.showResult(...this.lastResult); });
    this.showOverlay(this.takePlayer.node);
  }

  closeTake() {
    if (this.takePlayer) { this.takePlayer.destroy(); this.takePlayer = null; }
  }

  showResult(sc, saved, isBest) {
    const word = !this.micOk ? '점수 없음 (마이크 꺼짐)' : sc >= 9000 ? '최고예요!' : sc >= 7500 ? '아주 좋아요' : sc >= 5500 ? '좋아요' : sc >= 3500 ? '조금 더!' : '연습해 봐요';
    const bars = el('div', { class: 'bars', 'aria-label': '줄마다 맞음' });
    this.song.lines.forEach((l, i) => {
      const a = this.lineScores[i] ?? this.lineAcc(l) ?? 0;
      const b = el('button', {
        class: 'bar ' + (a >= 0.7 ? 'good' : a >= 0.45 ? 'mid' : 'low'),
        style: `--h:${Math.max(6, a * 100)}%`,
        title: `${i + 1}째 줄 ${Math.round(a * 100)}%`,
        'aria-label': `${i + 1}째 줄 ${Math.round(a * 100)}%, 이 줄 연습`,
        onclick: () => this.practiceLine(i),
      });
      bars.append(b);
    });
    this.showOverlay(el('div', { class: 'card result' },
      el('p', { class: 'muted' }, this.meta.title),
      el('div', { class: 'big-score' }, this.micOk ? sc.toLocaleString() : '—', el('small', {}, this.micOk ? '점' : '')),
      el('p', { class: 'word' }, word, isBest ? el('span', { class: 'badge' }, '최고 기록') : null),
      !saved && this.micOk ? el('p', { class: 'hint' }, '줄 반복·건너뛰기를 써서 최고 기록에는 넣지 않았어요') : null,
      el('p', { class: 'hint' }, '막대를 누르면 그 줄만 반복 연습합니다'),
      bars,
      this.meta.take ? el('button', { class: 'secondary', onclick: () => this.showTake() }, '내 노래 듣기') : null,
      el('button', { class: 'primary', onclick: () => this.restart() }, '다시 부르기'),
      el('button', { class: 'secondary', onclick: () => this.quit() }, '목록으로'),
    ));
  }

  practiceLine(i) {
    this.closeTake();
    this.showOverlay(null);
    this.loopLine = i;
    this.practiced = true;
    this.loopBtn.classList.add('on');
    this.state = 'paused';
    this.seek(this.song.lines[i].start - 1500);
    this.play(this.offsetMs);
  }

  quit() {
    this.destroy();
    history.back();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.fadeT);
    this.closeTake();
    this.dropTake();
    this.stopSources();
    this.lockScreen(false);
    try { this.recDest?.disconnect(); } catch { /* 무시 */ }
    try { this.micNode?.disconnect(); } catch { /* 무시 */ }
    try { this.music.disconnect(); this.guideGain.disconnect(); this.analyser.disconnect(); } catch { /* 무시 */ }
    this.ro?.disconnect();
    document.removeEventListener('visibilitychange', this.onVis);
    clearTimeout(this.rateT);
  }
}

function rr(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
