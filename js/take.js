// 내 노래 듣기 — 녹음한 내 목소리와 노래를 같은 시각에 함께 튼다.
import { settings, saveSettings, fmtTime, el, audioCtx } from './util.js';
import { getBlob, updateSong } from './library.js';

const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" class="fill"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>';

export class TakePlayer {
  // meta.take = {offsetMs, mime, at, score, adjust} · buffer = 노래 소리 · onClose = 닫기 눌렀을 때
  constructor(meta, buffer, onClose) {
    this.meta = meta;
    this.buffer = buffer;
    this.playing = false;
    this.posMs = 0;
    this.srcs = [];
    this.destroyed = false;
    const s = settings();

    this.playBtn = el('button', { class: 'ctl big', 'aria-label': '재생/멈춤', html: PLAY, disabled: true, onclick: () => this.toggle() });
    this.seekEl = el('input', { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': '재생 위치', disabled: true });
    this.seekEl.addEventListener('input', () => this.seek(this.fromBar()));
    this.timeEl = el('span', { class: 'time' }, '0:00');
    this.endEl = el('span', { class: 'time' }, '0:00');
    this.stateEl = el('p', { class: 'muted' }, '녹음 불러오는 중…');
    this.adjEl = el('b', {}, '');

    const slider = (label, key, max) => {
      const out = el('span', { class: 'val' }, Math.round(s[key] * 100) + '%');
      const inp = el('input', { type: 'range', min: '0', max: String(max * 100), step: '5', value: String(Math.round(s[key] * 100)), 'aria-label': label });
      inp.addEventListener('input', () => {
        const v = inp.value / 100;
        saveSettings({ [key]: v });
        out.textContent = inp.value + '%';
        this.applyVol();
      });
      return el('label', { class: 'field col' }, el('span', {}, label, out), inp);
    };

    const when = meta.take?.at ? new Date(meta.take.at) : null;
    this.node = el('div', { class: 'card take' },
      el('h2', {}, '내 노래 듣기'),
      el('p', { class: 'muted' }, [meta.title, when ? `${when.getMonth() + 1}/${when.getDate()} 녹음` : '', meta.take?.score != null ? `${meta.take.score.toLocaleString()}점` : ''].filter(Boolean).join(' · ')),
      this.stateEl,
      el('div', { class: 'prog-row' }, this.timeEl, this.seekEl, this.endEl),
      el('div', { class: 'btn-row' }, this.playBtn),
      slider('내 목소리 크기', 'takeVoiceVol', 3),
      slider('노래 크기', 'takeMusicVol', 1),
      el('div', { class: 'field' },
        el('span', {}, '목소리 시각 맞추기 ', this.adjEl),
        el('div', { class: 'seg' },
          el('button', { 'aria-label': '목소리를 20밀리초 앞으로', onclick: () => this.nudge(-20) }, '◀ 앞으로'),
          el('button', { 'aria-label': '목소리를 20밀리초 뒤로', onclick: () => this.nudge(20) }, '뒤로 ▶'),
        ),
      ),
      el('p', { class: 'hint' }, '목소리가 노래보다 늦게 들리면 ‘앞으로’, 빠르면 ‘뒤로’.'),
      el('button', { class: 'secondary', onclick: () => onClose() }, '닫기'),
    );
    this.showAdj();
    this.load();
  }

  async load() {
    try {
      this.ctx = audioCtx();
      const blob = await getBlob(this.meta.id + ':take');
      if (!blob) throw new Error('녹음이 없습니다');
      this.voice = await this.ctx.decodeAudioData(await blob.arrayBuffer());
      if (this.destroyed) return;
      this.musicGain = this.ctx.createGain();
      this.voiceGain = this.ctx.createGain();
      this.musicGain.connect(this.ctx.destination);
      this.voiceGain.connect(this.ctx.destination);
      this.applyVol();
      this.range();
      this.posMs = this.startMs;
      this.stateEl.textContent = '';
      this.stateEl.hidden = true;
      this.playBtn.disabled = false;
      this.seekEl.disabled = false;
      this.tick = setInterval(() => this.update(), 200);
      this.update();
    } catch (e) {
      console.warn('내 노래 불러오기 실패', e);
      this.stateEl.textContent = '녹음을 불러오지 못했습니다: ' + (e.message || e);
    }
  }

  off() { return (this.meta.take.offsetMs || 0) + (this.meta.take.adjust || 0); }

  range() {
    this.startMs = Math.max(0, this.off());
    this.endMs = Math.max(this.startMs + 1000, Math.min(this.buffer.duration * 1000, this.off() + this.voice.duration * 1000));
    this.endEl.textContent = fmtTime(this.endMs);
  }

  applyVol() {
    const s = settings();
    if (this.musicGain) this.musicGain.gain.value = s.takeMusicVol;
    if (this.voiceGain) this.voiceGain.gain.value = s.takeVoiceVol;
  }

  showAdj() {
    const a = this.meta.take?.adjust || 0;
    this.adjEl.textContent = a === 0 ? '(그대로)' : `(${a > 0 ? '+' : ''}${a}ms)`;
  }

  async nudge(d) {
    const was = this.playing;
    const p = this.pos();
    this.stop();
    this.meta.take.adjust = Math.max(-500, Math.min(500, (this.meta.take.adjust || 0) + d));
    this.showAdj();
    if (this.voice) { this.range(); this.posMs = Math.max(this.startMs, Math.min(p, this.endMs - 200)); if (was) this.play(); }
    try { await updateSong(this.meta); } catch (e) { console.warn('맞춤 값 저장 실패', e); }
  }

  fromBar() { return this.startMs + (this.seekEl.value / 1000) * (this.endMs - this.startMs); }

  pos() {
    if (!this.playing) return this.posMs;
    return this.posMs + (this.ctx.currentTime - this.t0) * 1000;
  }

  async play() {
    if (!this.voice || this.destroyed) return;
    try { await this.ctx.resume(); } catch (e) { console.warn('소리 켜기 실패', e); }
    this.stop();
    if (this.posMs >= this.endMs - 200) this.posMs = this.startMs;
    const when = this.ctx.currentTime + 0.06;
    const m = this.ctx.createBufferSource();
    m.buffer = this.buffer;
    m.connect(this.musicGain);
    m.start(when, this.posMs / 1000);
    const v = this.ctx.createBufferSource();
    v.buffer = this.voice;
    v.connect(this.voiceGain);
    const r = (this.posMs - this.off()) / 1000; // 녹음의 몇 초부터
    if (r >= 0) { if (r < this.voice.duration) v.start(when, r); } else v.start(when - r, 0);
    this.srcs = [m, v];
    this.t0 = when;
    this.playing = true;
    this.playBtn.innerHTML = PAUSE;
  }

  stop() {
    if (this.playing) this.posMs = this.pos();
    for (const s of this.srcs) { try { s.stop(); } catch { /* 시작 전이거나 이미 멈춤 */ } s.disconnect(); }
    this.srcs = [];
    this.playing = false;
    this.playBtn.innerHTML = PLAY;
  }

  toggle() { if (this.playing) this.stop(); else this.play(); }

  seek(ms) {
    const was = this.playing;
    this.stop();
    this.posMs = Math.max(this.startMs, Math.min(ms, this.endMs - 100));
    if (was) this.play(); else this.update(true);
  }

  update(force) {
    if (this.destroyed || !this.voice) return;
    let p = this.pos();
    if (this.playing && p >= this.endMs) { this.stop(); this.posMs = p = this.startMs; }
    this.timeEl.textContent = fmtTime(p);
    if (force || document.activeElement !== this.seekEl) this.seekEl.value = String(Math.round(((p - this.startMs) / (this.endMs - this.startMs)) * 1000));
  }

  destroy() {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    clearInterval(this.tick);
    try { this.musicGain?.disconnect(); this.voiceGain?.disconnect(); } catch (e) { console.warn('소리 줄 끊기 실패', e); }
  }
}
