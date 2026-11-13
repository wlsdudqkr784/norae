// 부르기 화면 — 소리 재생, 마이크 음높이, 채점, 그리기.
import { PitchDetector, freqToMidi, midiToFreq, foldOctave, VOICES } from './pitch.js';
import { settings, saveSettings, LEVELS, fmtTime, el, toast, audioCtx } from './util.js';
import { updateSong, putBlob } from './library.js';
import { TakePlayer } from './take.js';
import { ScoreView } from './score.js';
import { estimateLag, CALIB_LINES } from './calib.js';

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

let micCache = null; // {stream, echo, id}
// 마이크를 켜면 음질이 떨어지는 까닭(11-13): 블루투스 이어폰은 마이크를 쓰는 순간 '통화 방식'(HFP, 모노·낮은 음질)으로 바뀐다.
// 폰 본체 마이크를 고르면(설정 '마이크') 이어폰은 음악 방식 그대로일 수 있다 — 기기마다 달라 사용자가 듣고 고른다.
// 에코 줄이기(통화용 소리 처리)도 음질을 떨어뜨려 기본은 끔.
export async function getMic(echo, id = '') {
  if (micCache && micCache.echo === echo && micCache.id === id && micCache.stream.getAudioTracks().some((t) => t.readyState === 'live')) return micCache.stream;
  if (micCache) micCache.stream.getTracks().forEach((t) => t.stop());
  const audio = { echoCancellation: echo, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  let stream;
  if (id) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: id } } });
    } catch (e) {
      // 고른 마이크가 없어졌으면(이어폰을 뺌 등) 기본 마이크로 물러난다
      console.warn('고른 마이크를 못 씀 — 기본 마이크로', e);
      toast('고른 마이크가 없어 기본 마이크를 씁니다');
    }
  }
  if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio });
  micCache = { stream, echo, id };
  return stream;
}

// 설정 화면용: 마이크 목록 [{id, label}] (이름은 마이크를 한 번 허락해야 보인다)
export async function listMics() {
  try {
    const ds = await navigator.mediaDevices.enumerateDevices();
    return ds.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `마이크 ${i + 1}` }));
  } catch (e) {
    console.warn('마이크 목록을 못 읽음', e);
    return [];
  }
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
    this.skipped = new Set();  // 옮기기로 건너뛴 줄 (결과에서 회색으로)
    this.ratedUntil = -1;
    this.lastDetect = 0;
    this.shownScore = 0;
    this.destroyed = false;
    this.endMs = Math.min(buffer.duration * 1000, (song.endMs || Infinity), song.lines[song.lines.length - 1].end + 2500);
    // 노래로 지연 맞추기(11-14): 첫 4줄만 — 첫 줄 4초 앞에서 시작, 넷째 줄 끝 0.8초 뒤에 재고 끝. 점수·녹음은 남기지 않는다
    if (opts.calib) {
      const last = song.lines[Math.min(CALIB_LINES, song.lines.length) - 1];
      this.calibStart = Math.max(0, song.lines[0].start - 4000);
      this.offsetMs = this.calibStart;
      this.endMs = Math.min(this.endMs, last.end + 800);
      this.practiced = true;
      this.calibRec = [];
    }

    for (const n of song.notes) { n.hit = 0; n.segs = []; n.sung = []; }
    this.weightTotal = song.notes.reduce((a, n) => a + this.weight(n), 0) || 1;
    // 노래방 악보(오선 8마디) — 악보 자료가 없거나 못 그리면 음 줄 화면으로 물러난다
    this.scoreView = null;
    if (meta.score) {
      try { this.scoreView = new ScoreView(meta.score, song); } catch (e) { console.warn('노래방 악보를 못 씀 — 음 줄 화면으로', e); }
    }

    this.music = this.ctx.createGain();
    this.music.gain.value = settings().musicVol;
    this.music.connect(this.ctx.destination);
    this.guideGain = this.ctx.createGain();
    this.guideGain.gain.value = settings().guideVol;
    this.guideGain.connect(this.ctx.destination);
    // 가이드 목소리(분리한 원곡 목소리, 11-13) — 반주 위에 설정 guideVoice 크기로 섞는다. 없는 곡은 없음
    this.vocals = opts.vocals || null;
    this.voiceGain = this.ctx.createGain();
    this.voiceGain.gain.value = this.vocals ? settings().guideVoice : 0;
    this.voiceGain.connect(this.ctx.destination);
    this.voiceSrc = null;
    this.usedVoice = false;   // 가이드 목소리를 켜고 부른 판 — 최고 기록에 넣지 않는다
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.detector = new PitchDetector(this.ctx.sampleRate, this.analyser.fftSize, VOICES[settings().voice] || VOICES.both);

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
    // 노래방 가사: 두 줄 — 위 줄은 왼쪽, 아래 줄은 오른쪽. 부르는 줄이 바뀌면 다 부른 자리에 다음다음 줄이 온다
    this.curEl = el('div', { class: 'lyr a' });
    this.nextEl = el('div', { class: 'lyr b' });
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
    this.guideBtn = el('button', { class: 'ctl', 'aria-label': '가이드', 'aria-expanded': 'false', html: ICON.guide + '<span>가이드</span>', onclick: () => this.toggleGuidePanel() });
    this.guidePop = el('div', { class: 'guide-pop', role: 'dialog', 'aria-label': '가이드' });
    const controls = el('footer', { class: 'controls' },
      el('div', { class: 'prog-row' }, this.timeEl, this.prog, el('span', { class: 'time' }, fmtTime(this.endMs))),
      el('div', { class: 'btn-row' },
        this.loopBtn,
        el('button', { class: 'ctl', 'aria-label': '이전 줄', html: ICON.prev + '<span>이전 줄</span>', onclick: () => this.jumpLine(-1) }),
        this.playBtn,
        el('button', { class: 'ctl', 'aria-label': '다음 줄', html: ICON.next + '<span>다음 줄</span>', onclick: () => this.jumpLine(1) }),
        this.guideBtn,
      ),
      this.guidePop,
    );
    this.overlay = el('div', { class: 'overlay' });
    this.root.append(top, this.laneWrap, lyrics, controls, this.overlay);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.laneWrap);
    this.resize();
    this.showGuideOn();
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
    if (this.opts.calib) {
      this.showOverlay(el('div', { class: 'card' },
        el('h2', {}, '노래로 지연 맞추기'),
        el('p', {}, `'${this.meta.title}' 첫 ${CALIB_LINES}줄을 평소처럼 불러 주세요. 다 부르면 내 목소리가 악보보다 얼마나 늦게 잡히는지 재서 맞춰 드립니다.`),
        el('p', { class: 'hint' }, '노래할 때 쓰는 이어폰을 낀 채로 하세요. 이어폰을 바꾸면 다시 하면 됩니다.'),
        el('button', { class: 'primary', onclick: () => this.begin() }, '시작'),
      ));
      return;
    }
    const s = settings();
    const card = el('div', { class: 'card' },
      el('h2', {}, this.meta.title),
      el('p', { class: 'muted' }, [this.meta.artist, fmtTime(this.endMs), this.meta.best ? `최고 ${this.meta.best.toLocaleString()}점` : ''].filter(Boolean).join(' · ')),
      el('div', { class: 'field' }, el('span', {}, '난이도'), this.levelPicker()),
      ...this.guideItems(),
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
        const stream = await getMic(settings().echoCancel, settings().micId);
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
      this.fakeSrc.start(when + (this.opts.fakeDelay || 0) / 1000, fromMs / 1000);   // fakeDelay: 시험용 '늦게 잡히는 마이크'
    }
    if (this.vocals && fromMs / 1000 < this.vocals.duration) {
      this.voiceSrc = this.ctx.createBufferSource();
      this.voiceSrc.buffer = this.vocals;
      this.voiceSrc.connect(this.voiceGain);
      this.voiceSrc.start(when, fromMs / 1000);
      if (settings().guideVoice > 0) this.usedVoice = true;
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
    for (const s of [this.src, this.fakeSrc, this.voiceSrc]) { if (s) { try { s.stop(); } catch { /* 이미 멈춤 */ } s.disconnect(); } }
    this.src = this.fakeSrc = this.voiceSrc = null;
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
    if (this.opts.calib) { this.calibAgain(); return; }
    this.closeTake();
    this.dropTake();
    this.usedVoice = false;
    for (const n of this.song.notes) { n.hit = 0; n.segs = []; n.sung = []; }
    this.lineScores.fill(null);
    this.skipped.clear();
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
    // 앞으로 옮겨 아직 안 매긴 줄을 지나치면: 한 음도 안 불렀으면 '건너뜀', 조금이라도 불렀으면 거기까지로 매긴다
    for (const l of this.song.lines) {
      if (l.index <= this.ratedUntil || l.end > ms) continue;
      if (l.notes.some((n) => n.hit > 0)) this.lineScores[l.index] = this.lineAcc(l);
      else this.skipped.add(l.index);
    }
    for (const l of this.song.lines) if (l.end > ms) this.skipped.delete(l.index);
    // 다시 부르는 곳의 점수는 지우고 새로 매긴다
    for (const n of this.song.notes) if (n.end > ms) { n.hit = 0; n.segs = []; n.sung = []; }
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
    const off = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', off); };
    const up = (ev) => { off(); go(ev.clientX); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', off);   // 손가락이 화면 밖으로 나가 끌기가 취소돼도 듣는 것을 떼어 낸다(11-14 점검)
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

  // ---------- 가이드 (목소리 크기 · 악보 음) ----------
  guideItems() {
    const s = settings();
    const items = [];
    if (this.vocals) {
      const out = el('span', { class: 'val' }, s.guideVoice > 0 ? Math.round(s.guideVoice * 100) + '%' : '끔');
      const inp = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(s.guideVoice * 100)), 'aria-label': '가이드 목소리 크기' });
      inp.addEventListener('input', () => {
        const v = Number(inp.value) / 100;
        out.textContent = v > 0 ? inp.value + '%' : '끔';
        this.setGuideVoice(v);
      });
      items.push(el('label', { class: 'field col' }, el('span', {}, '가이드 목소리', out), inp));
    }
    const tone = el('input', { type: 'checkbox', checked: s.guide, onchange: (e) => this.toggleGuide(e.target.checked) });
    items.push(el('label', { class: 'toggle' }, tone, el('span', {}, '가이드 음 (악보 음을 삐 소리로)')));
    if (this.vocals) items.push(el('p', { class: 'hint' }, '가이드 목소리를 켜고 부른 판은 최고 기록에 넣지 않아요'));
    return items;
  }

  setGuideVoice(v) {
    saveSettings({ guideVoice: v });
    if (this.vocals) this.voiceGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    if (v > 0 && this.state === 'playing') this.usedVoice = true;
    this.showGuideOn();
  }

  showGuideOn() {
    const s = settings();
    this.guideBtn.classList.toggle('on', s.guide || (!!this.vocals && s.guideVoice > 0));
  }

  toggleGuidePanel(open) {
    const show = open ?? !this.guidePop.classList.contains('show');
    this.guideBtn.setAttribute('aria-expanded', String(show));
    if (!show) {
      this.guidePop.classList.remove('show');
      document.removeEventListener('pointerdown', this.onPopOut, true);
      return;
    }
    this.guidePop.replaceChildren(...this.guideItems());
    this.guidePop.classList.add('show');
    // 창 밖을 누르면 닫는다(단추를 다시 눌러도 닫힌다)
    this.onPopOut = this.onPopOut || ((e) => {
      if (!this.guidePop.contains(e.target) && !this.guideBtn.contains(e.target)) this.toggleGuidePanel(false);
    });
    document.addEventListener('pointerdown', this.onPopOut, true);
  }

  toggleGuide(on = !settings().guide) {
    saveSettings({ guide: on });
    this.showGuideOn();
    if (!on) { for (const o of this.guideNodes) { try { o.stop(); } catch { /* 이미 멈춤 */ } } this.guideNodes = []; }
    else this.guideUntil = this.pos();
  }

  skipGap() {
    const t = this.heard();
    const n = this.song.notes.find((x) => x.start > t);
    if (!(n && n.start - t > 4000)) return;
    // 전주·간주만 건너뛴다 — 부를 음을 하나도 안 지나치니 최고 기록에 넣는다(11-14 점검: 전에는 '옮기기' 로 쳐서 기록·녹음이 빠졌다).
    // 내 노래 녹음은 이어 붙일 수 없어, 전주(부른 음이 없을 때)면 여기서 새로 시작하고 간주면 이번 판은 녹음 없이
    const keep = !this.practiced;
    const intro = !this.song.notes.some((x) => x.start < t);
    this.seek(n.start - 3000);
    if (keep) {
      this.practiced = false;
      if (intro && this.state === 'playing') this.startTake();
    }
  }

  async lockScreen(on) {
    try {
      if (on && !this.wake && navigator.wakeLock) {
        // 다른 앱에 다녀오면 브라우저가 스스로 풀어 버린다 → 풀리면 비워 두어 다음 재생에서 다시 잡게(11-14 점검)
        const w = await navigator.wakeLock.request('screen');
        w.addEventListener('release', () => { if (this.wake === w) this.wake = null; });
        this.wake = w;
      }
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
    if (this.calibRec) this.calibRec.push({ S, m: midi });
    const note = this.noteAt(S);
    let hit = false, shown = midi;
    if (midi > 0) {
      if (note) {
        shown = foldOctave(midi, note.midi);
        if (note.type !== 'free') {
          // 부른 음높이를 음마다 모아 둔다 → 악보에 '인식된 음' 과 빨간 짙기로 보인다(11-13)
          if (note.sung && note.sung.length < 600) note.sung.push(shown);
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

  // 이 음에서 부른 음높이(가운데 값, 옥타브는 악보 음 쪽으로 접음). 목소리가 거의 없었으면 null
  noteSung(n) {
    const v = n.sung;
    if (!v || v.length < 3) return null;
    const a = v.slice().sort((x, y) => x - y);
    return a[a.length >> 1];
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
      this.skipped.delete(l.index);
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

  // 언제나 악보 화면(11-13 사용자). 악보 자료(.악보.json)가 없거나 못 그리는 곡만 음 줄 화면
  usingScore() { return !!this.scoreView; }

  // 음 줄 그리기 (악보 화면이면 ScoreView 가 그린다)
  draw(dt) {
    const g = this.g, W = this.W, H = this.H;
    if (!g) return;
    if (this.usingScore()) {
      try { this.scoreView.draw(g, W, H, this.heard(), this); return; } catch (e) {
        console.error('악보 그리기 실패 — 음 줄 화면으로', e);
        this.scoreView = null;
      }
    }
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
      const slot = [this.curEl, this.nextEl];
      this.lyrNow = slot[i % 2];
      this.fill(slot[i % 2], L[i]);
      this.fill(slot[(i + 1) % 2], L[i + 1]);
      slot[i % 2].classList.add('now');
      slot[(i + 1) % 2].classList.remove('now');
      for (const b of slot) { delete b.dataset.cnt; b.classList.remove('c1', 'c2'); }
      this._cnt = 0;
    }
    const line = L[i];
    if (line) {
      const spans = this.lyrNow.children;
      line.syllables.forEach((s, j) => {
        const p = Math.max(0, Math.min(1, (t - s.start) / Math.max(1, s.end - s.start)));
        const q = Math.round(p * 100);
        const sp = spans[j];
        if (sp && sp._q !== q) { sp._q = q; sp.style.setProperty('--p', q + '%'); }
      });
    }
    // 들어가기 숫자(11-13 사용자): 앞 줄과 2.5박 넘게 쉬는 줄(첫 줄 포함)만, 남은 박이 3 이하일 때
    let cnt = 0;
    if (line && t < line.start && this.state === 'playing') {
      const bm = this.beatMs(i);
      const prevEnd = i > 0 ? L[i - 1].end : -Infinity;
      const left = (line.start - t) / bm;
      if (line.start - prevEnd >= bm * 2.5 && left <= 3) cnt = Math.max(1, Math.ceil(left - 0.02));
    }
    if (cnt !== this._cnt) {
      this._cnt = cnt;
      const box = this.lyrNow;
      if (box) {
        if (cnt) {
          box.dataset.cnt = String(cnt);
          // 숫자가 바뀔 때마다 톡 튀게: 같은 모양의 애니메이션 둘을 번갈아 건다
          box.classList.toggle('c1', cnt % 2 === 1);
          box.classList.toggle('c2', cnt % 2 === 0);
        } else { delete box.dataset.cnt; box.classList.remove('c1', 'c2'); }
      }
    }
    // 기다림 표시·건너뛰기
    const nextNote = line && t < line.start ? line.start : null;
    const wait = nextNote != null ? nextNote - t : 0;
    if (wait > 1200 && !cnt) {
      const sec = Math.ceil(wait / 1000);
      if (this._wait !== sec) { this._wait = sec; this.waitEl.textContent = i === 0 ? `시작까지 ${sec}초` : `다음 줄까지 ${sec}초`; }
      this.waitEl.classList.add('show');
    } else if (this._wait !== 0) { this._wait = 0; this.waitEl.classList.remove('show'); }
    this.skipBtn.classList.toggle('show', this.state === 'playing' && wait > 5000);
  }

  // 한 박(4분음표) ms — 노래방 악보 자료가 있으면 그 줄의 빠르기, 없으면 UltraStar 보통 셈(4칸 = 한 박)
  beatMs(i) {
    const L = this.meta.score && this.meta.score.lines && this.meta.score.lines[i];
    if (L && L.spb > 0) return L.spb * 1000;
    return 60000 / Math.max(1, this.song.bpm);
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
  // ---------- 노래로 지연 맞추기 (11-14) ----------
  finishCalib() {
    if (this.state === 'done') return;
    try { this.music.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3); } catch (e) { console.warn('소리 줄이기 실패', e); }
    this.fadeT = setTimeout(() => this.stopSources(), 1200);
    this.state = 'done';
    this.lockScreen(false);
    this.playBtn.innerHTML = ICON.play;
    const cur = settings().micLatency;
    const r = estimateLag(this.calibRec, this.song.notes.filter((n) => n.start < this.endMs));
    console.info('노래로 지연 맞추기', { cur, outLat: Math.round(this.outLat()), ...r });
    const again = el('button', { class: 'secondary', onclick: () => this.calibAgain() }, '다시 하기');
    const close = el('button', { class: 'secondary', onclick: () => this.quit() }, '닫기');
    if (!this.micOk) {
      this.showOverlay(el('div', { class: 'card' }, el('h2', {}, '잴 수 없음'), el('p', {}, '마이크를 못 써서 잴 수 없습니다.'), close));
      return;
    }
    if (!r.ok) {
      this.showOverlay(el('div', { class: 'card' }, el('h2', {}, '잴 수 없음'),
        el('p', {}, r.why + (r.voicedSec != null ? ` (목소리 들은 시간 ${r.voicedSec.toFixed(1)}초)` : '')),
        el('p', { class: 'hint' }, '가사를 따라 조금 크게 불러 주세요. 계속 안 되면 설정의 마이크 시험으로 음이 잡히는지 먼저 봐 주세요.'),
        again, close));
      return;
    }
    const next = Math.max(0, Math.min(800, cur + r.lag));
    const sec = (ms) => (Math.abs(ms) / 1000).toFixed(2) + '초';
    const what = Math.abs(r.lag) < 30 ? '이미 잘 맞습니다' : r.lag > 0 ? `목소리가 ${sec(r.lag)} 늦게 잡혔습니다` : `목소리가 ${sec(r.lag)} 빨리 잡혔습니다`;
    const apply = el('button', { class: 'primary', onclick: () => {
      saveSettings({ micLatency: next });
      toast(`마이크 지연을 ${next}ms 로 맞췄습니다`);
      this.quit();
    } }, `맞추기 (마이크 지연 ${cur} → ${next}ms)`);
    this.showOverlay(el('div', { class: 'card' },
      el('h2', {}, what),
      el('p', { class: 'muted' }, `맞는 정도 ${Math.round(100 * r.base)}% → 맞춘 뒤 ${Math.round(100 * r.score)}%`),
      Math.abs(r.lag) < 30 ? null : apply,
      again, close));
  }

  calibAgain() {
    clearTimeout(this.fadeT);
    for (const n of this.song.notes) { n.hit = 0; n.segs = []; n.sung = []; }
    this.trail = [];
    this.calibRec = [];
    this.showOverlay(null);
    this.state = 'paused';
    this.play(this.calibStart);
  }

  async finish() {
    if (this.opts.calib) { this.finishCalib(); return; }
    if (this.state === 'done') return;
    const end = this.ctx.currentTime;
    try { this.music.gain.setTargetAtTime(0, end, 0.4); } catch { /* 무시 */ }
    this.fadeT = setTimeout(() => this.stopSources(), 1600);
    this.state = 'done';
    this.lockScreen(false);
    this.playBtn.innerHTML = ICON.play;
    const sc = this.score();
    const saved = this.micOk && !this.practiced && !this.usedVoice;
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
    // 건너뛴 줄이 있으면 한마디는 '부른 줄'만 보고 정한다 (건너뛴 줄 때문에 '연습해 봐요'가 나오지 않게)
    const lines = this.song.lines;
    const nSkip = lines.filter((l, i) => this.skipped.has(i)).length;
    let judge = sc, sungPct = null;
    if (nSkip) {
      let w = 0, s = 0;
      lines.forEach((l, i) => {
        if (this.skipped.has(i)) return;
        for (const n of l.notes) { const k = this.weight(n); w += k; s += k * this.noteFrac(n); }
      });
      sungPct = w > 0 ? s / w : 0;
      judge = Math.round(sungPct * 10000);
    }
    const word = !this.micOk ? '점수 없음 (마이크 꺼짐)' : judge >= 9000 ? '최고예요!' : judge >= 7500 ? '아주 좋아요' : judge >= 5500 ? '좋아요' : judge >= 3500 ? '조금 더!' : '연습해 봐요';

    // 줄 막대: 막대가 가늘어도 고르기 쉽게 — 누르거나 끌면 그 줄이 골라지고, 아래 큰 단추로 연습한다
    const lineText = (l) => l.notes.map((n) => n.text).join('').replace(/~/g, '').replace(/\s+/g, ' ').trim();
    const accOf = (i) => this.lineScores[i] ?? this.lineAcc(lines[i]) ?? 0;
    const pickInfo = el('p', { class: 'pick-info' }, '막대를 누르거나 밀어서 연습할 줄을 고르세요');
    const pickBtn = el('button', { class: 'secondary', disabled: true }, '연습');
    let picked = -1;
    const barEls = [];
    const pick = (i) => {
      if (i < 0 || i >= lines.length || i === picked) return;
      if (picked >= 0) barEls[picked].classList.remove('picked');
      picked = i;
      barEls[i].classList.add('picked');
      const t = lineText(lines[i]);
      pickInfo.replaceChildren(el('b', {}, `${i + 1}째 줄 · ${this.skipped.has(i) ? '건너뜀' : Math.round(accOf(i) * 100) + '%'}`), t ? ' ' + t : '');
      pickBtn.disabled = false;
      pickBtn.setAttribute('aria-label', `${i + 1}째 줄 연습`);
    };
    pickBtn.addEventListener('click', () => { if (picked >= 0) this.practiceLine(picked); });
    const bars = el('div', { class: 'bars', role: 'group', 'aria-label': '줄마다 맞음' });
    lines.forEach((l, i) => {
      const skip = this.skipped.has(i);
      const a = accOf(i);
      const b = el('button', {
        class: 'bar ' + (skip ? 'skip' : a >= 0.7 ? 'good' : a >= 0.45 ? 'mid' : 'low'),
        style: `--h:${skip ? 6 : Math.max(6, a * 100)}%`,
        title: `${i + 1}째 줄 ${skip ? '건너뜀' : Math.round(a * 100) + '%'}`,
        'aria-label': `${i + 1}째 줄 ${skip ? '건너뜀' : Math.round(a * 100) + '%'}`,
        onclick: () => pick(i),
      });
      barEls.push(b);
      bars.append(b);
    });
    const barAt = (x) => {
      const r = bars.getBoundingClientRect();
      return Math.max(0, Math.min(lines.length - 1, Math.floor(((x - r.left + bars.scrollLeft) / bars.scrollWidth) * lines.length)));
    };
    bars.addEventListener('pointerdown', (e) => { bars.setPointerCapture?.(e.pointerId); pick(barAt(e.clientX)); });
    bars.addEventListener('pointermove', (e) => { if (e.buttons) pick(barAt(e.clientX)); });

    this.showOverlay(el('div', { class: 'card result' },
      el('p', { class: 'muted' }, this.meta.title),
      el('div', { class: 'big-score' }, this.micOk ? sc.toLocaleString() : '—', el('small', {}, this.micOk ? '점' : '')),
      el('p', { class: 'word' }, word, isBest ? el('span', { class: 'badge' }, '최고 기록') : null),
      !saved && this.micOk ? el('p', { class: 'hint' }, this.usedVoice && !this.practiced ? '가이드 목소리를 켜고 불러서 최고 기록에는 넣지 않았어요' : '줄 반복·옮기기를 써서 최고 기록에는 넣지 않았어요') : null,
      nSkip && this.micOk ? el('p', { class: 'hint' }, `건너뛴 ${nSkip}줄은 회색 · 부른 줄만 보면 ${Math.round(sungPct * 100)}%`) : null,
      bars,
      el('div', { class: 'pick-row' }, pickInfo, pickBtn),
      // 단추 위계: 다시 부르기만 강조 · 내 노래 듣기는 보조 · 목록으로는 글자 단추
      el('button', { class: 'primary', onclick: () => this.restart() }, '다시 부르기'),
      this.meta.take ? el('button', { class: 'secondary', onclick: () => this.showTake() }, '내 노래 듣기') : null,
      el('button', { class: 'text-btn', onclick: () => this.quit() }, '목록으로'),
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
    try { this.music.disconnect(); this.guideGain.disconnect(); this.voiceGain.disconnect(); this.analyser.disconnect(); } catch { /* 무시 */ }
    if (this.onPopOut) document.removeEventListener('pointerdown', this.onPopOut, true);
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
