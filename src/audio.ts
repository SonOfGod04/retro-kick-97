// audio.ts — procedural Web Audio for Retro Kick '97. No asset files needed.

export type SfxName =
  | 'kick' | 'pass' | 'shoot' | 'tackle' | 'post' | 'bounce' | 'net' | 'glove'
  | 'horn' | 'whistleShort' | 'whistleLong' | 'whistleTriple';
export type CrowdName = 'cheer' | 'gasp' | 'ooh' | 'groan' | 'applause' | 'boo' | 'chant';

const KEYS = { vol: 'rk97.volume', mute: 'rk97.muted', voice: 'rk97.voice' };
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export class GameAudio {
  volume = 0.7;
  muted = false;
  voiceOn = true;
  private persist: boolean;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private crowdBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ambGain: GainNode | null = null;
  private ambFilter: BiquadFilterNode | null = null;

  /** persist = false is used by the self-tests so they never touch the player's saved settings. */
  constructor(persist = true) {
    this.persist = persist;
    if (!persist) return;
    try {
      const v = localStorage.getItem(KEYS.vol);
      if (v !== null) this.volume = clamp(parseFloat(v), 0, 1);
      this.muted = localStorage.getItem(KEYS.mute) === '1';
      const vo = localStorage.getItem(KEYS.voice);
      if (vo !== null) this.voiceOn = vo === '1';
    } catch (_e) { /* storage unavailable */ }
  }

  // ── Control ────────────────────────────────────────────────────────────
  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.applyMaster();
    this.save();
  }

  changeVolume(d: number): void {
    this.setVolume(Math.round((this.volume + d) * 10) / 10);
    if (this.muted && d > 0) this.muted = false;
    this.applyMaster();
    this.save();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.applyMaster();
    if (this.muted) this.cancelSpeech();
    this.save();
  }

  toggleVoice(): void {
    this.voiceOn = !this.voiceOn;
    if (!this.voiceOn) this.cancelSpeech();
    this.save();
  }

  status(): string {
    return (this.muted ? 'MUTED' : `VOL ${Math.round(this.volume * 100)}%`) + ` · VOICE ${this.voiceOn ? 'ON' : 'OFF'}   [M] [ [ ] ] [N]`;
  }

  private applyMaster(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.03);
  }

  private save(): void {
    if (!this.persist) return;
    try {
      localStorage.setItem(KEYS.vol, String(this.volume));
      localStorage.setItem(KEYS.mute, this.muted ? '1' : '0');
      localStorage.setItem(KEYS.voice, this.voiceOn ? '1' : '0');
    } catch (_e) { /* storage unavailable */ }
  }

  private ready(): boolean {
    return !!this.ctx && !this.muted;
  }

  /** Must be called from a user gesture (click / key) because of browser autoplay rules. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      const c = new Ctor() as AudioContext;
      this.ctx = c;
      const comp = c.createDynamicsCompressor();
      comp.connect(c.destination);
      this.master = c.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(comp);
      this.sfxBus = c.createGain();
      this.sfxBus.gain.value = 0.9;
      this.sfxBus.connect(this.master);
      this.crowdBus = c.createGain();
      this.crowdBus.gain.value = 0.85;
      this.crowdBus.connect(this.master);

      // 3 s of coloured noise, the raw material of the crowd and of most sound effects
      const len = c.sampleRate * 3;
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      let low = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        low = 0.985 * low + 0.015 * w;
        d[i] = clamp(0.55 * w + 4.0 * low, -1, 1);
      }
      this.noise = buf;

      // Continuous crowd ambience: band-passed noise whose level and brightness follow the excitement
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      this.ambFilter = c.createBiquadFilter();
      this.ambFilter.type = 'bandpass';
      this.ambFilter.frequency.value = 600;
      this.ambFilter.Q.value = 0.6;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      this.ambGain = c.createGain();
      this.ambGain.gain.value = 0.05;
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.35;
      const lfoG = c.createGain();
      lfoG.gain.value = 0.012;
      lfo.connect(lfoG);
      lfoG.connect(this.ambGain.gain);
      src.connect(this.ambFilter);
      this.ambFilter.connect(lp);
      lp.connect(this.ambGain);
      this.ambGain.connect(this.crowdBus);
      src.start();
      lfo.start();
    } catch (_e) {
      this.ctx = null;
    }
  }

  /** 0..1. Drives the level and brightness of the crowd ambience. */
  setExcitement(e: number): void {
    if (!this.ctx || !this.ambGain || !this.ambFilter) return;
    const t = this.ctx.currentTime;
    const x = clamp(e, 0, 1.4);
    this.ambGain.gain.setTargetAtTime(0.04 + 0.2 * x, t, 0.4);
    this.ambFilter.frequency.setTargetAtTime(450 + 850 * x, t, 0.4);
  }

  // ── Building blocks ────────────────────────────────────────────────────
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, delay = 0, bus?: GainNode | null): void {
    const c = this.ctx!;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + Math.min(0.01, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(bus ?? this.sfxBus!);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  private bandNoise(
    f0: number, f1: number, q: number, dur: number, peak: number, attack: number,
    bus: GainNode, type: BiquadFilterType = 'bandpass', delay = 0
  ): void {
    const c = this.ctx!;
    const t0 = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = this.noise!;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.linearRampToValueAtTime(f1, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f);
    f.connect(g);
    g.connect(bus);
    s.start(t0, Math.random() * 2);
    s.stop(t0 + dur + 0.05);
  }

  private whistle(dur: number, delay = 0): void {
    const c = this.ctx!;
    const t0 = c.currentTime + delay;
    const g = c.createGain();
    g.connect(this.sfxBus!);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.2, t0 + 0.02);
    g.gain.setValueAtTime(0.2, t0 + Math.max(0.03, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const lfo = c.createOscillator();         // the "pea" rattling inside the whistle
    lfo.frequency.value = 27;
    const lg = c.createGain();
    lg.gain.value = 110;
    lfo.connect(lg);
    for (const f of [2750, 3180]) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      lg.connect(o.frequency);
      o.connect(g);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    }
    lfo.start(t0);
    lfo.stop(t0 + dur + 0.02);
    this.bandNoise(3200, 3200, 2, dur, 0.05, 0.02, this.sfxBus!, 'bandpass', delay);   // breath
  }

  private horn(): void {
    const c = this.ctx!;
    const t0 = c.currentTime;
    const g = c.createGain();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.16, t0 + 0.04);
    g.gain.setValueAtTime(0.16, t0 + 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.1);
    lp.connect(g);
    g.connect(this.sfxBus!);
    const lfo = c.createOscillator();
    lfo.frequency.value = 6;
    const lg = c.createGain();
    lg.gain.value = 3;
    lfo.connect(lg);
    for (const f of [233, 349, 466]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      lg.connect(o.frequency);
      o.connect(lp);
      o.start(t0);
      o.stop(t0 + 1.15);
    }
    lfo.start(t0);
    lfo.stop(t0 + 1.15);
  }

  private claps(k: number, count: number, spread: number, regular: boolean): void {
    const c = this.ctx!;
    const t0 = c.currentTime;
    for (let i = 0; i < count; i++) {
      const t = t0 + (regular ? i * spread : Math.pow(Math.random(), 0.85) * spread);
      const s = c.createBufferSource();
      s.buffer = this.noise!;
      const f = c.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 1100 + Math.random() * 1600;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16 * k, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.024);
      s.connect(f);
      f.connect(g);
      g.connect(this.crowdBus!);
      s.start(t, Math.random() * 2);
      s.stop(t + 0.03);
    }
  }

  // ── Sound effects ──────────────────────────────────────────────────────
  sfx(name: SfxName, intensity = 1): void {
    if (!this.ready()) return;
    const k = clamp(intensity, 0.2, 1.5);
    const bus = this.sfxBus!;
    switch (name) {
      case 'kick':
        this.tone('sine', 190, 60, 0.1, 0.55 * k);
        this.bandNoise(1800, 1200, 1, 0.03, 0.25 * k, 0.002, bus);
        break;
      case 'pass':
        this.tone('sine', 150, 70, 0.08, 0.3 * k);
        this.bandNoise(1500, 1000, 1, 0.025, 0.12 * k, 0.002, bus);
        break;
      case 'shoot':
        this.tone('sine', 230, 50, 0.14, 0.7 * k);
        this.bandNoise(2200, 900, 1, 0.05, 0.35 * k, 0.002, bus);
        this.bandNoise(1200, 300, 0.8, 0.18, 0.2 * k, 0.01, bus);
        break;
      case 'tackle':
        this.tone('sine', 120, 60, 0.09, 0.4 * k);
        this.bandNoise(900, 500, 0.8, 0.08, 0.3 * k, 0.003, bus);
        break;
      case 'post':
        for (const f of [820, 1330, 1870]) this.tone('sine', f, f * 0.97, 0.55, 0.2 * k);
        this.bandNoise(3000, 2000, 1, 0.04, 0.3 * k, 0.002, bus);
        break;
      case 'bounce':
        this.tone('sine', 130, 70, 0.07, 0.25 * k);
        break;
      case 'net':
        this.bandNoise(3200, 900, 0.7, 0.55, 0.28, 0.04, bus);
        break;
      case 'glove':
        this.bandNoise(1800, 1500, 1, 0.05, 0.35 * k, 0.002, bus);
        this.tone('sine', 300, 200, 0.05, 0.2 * k);
        break;
      case 'horn': this.horn(); break;
      case 'whistleShort': this.whistle(0.35); break;
      case 'whistleLong': this.whistle(1.0); break;
      case 'whistleTriple': this.whistle(0.28); this.whistle(0.28, 0.4); this.whistle(0.9, 0.8); break;
    }
  }

  // ── Crowd reactions ────────────────────────────────────────────────────
  crowd(name: CrowdName, intensity = 1): void {
    if (!this.ready()) return;
    const k = clamp(intensity, 0.2, 1.5);
    const bus = this.crowdBus!;
    switch (name) {
      case 'cheer':
        this.bandNoise(900, 1300, 0.9, 3.2, 0.5 * k, 0.25, bus);
        this.bandNoise(320, 240, 0.8, 3.2, 0.35 * k, 0.2, bus);
        this.claps(0.5 * k, 14, 0.16, true);
        break;
      case 'gasp': this.bandNoise(700, 1900, 1.2, 0.55, 0.4 * k, 0.08, bus); break;
      case 'ooh': this.bandNoise(1400, 520, 1.0, 1.1, 0.45 * k, 0.1, bus); break;
      case 'groan': this.bandNoise(420, 240, 0.8, 1.3, 0.4 * k, 0.15, bus); break;
      case 'boo':
        this.bandNoise(330, 290, 2.2, 1.6, 0.4 * k, 0.2, bus);
        this.bandNoise(660, 580, 2.2, 1.6, 0.18 * k, 0.2, bus);
        break;
      case 'applause': this.claps(k, Math.round(70 * k), 2.6, false); break;
      case 'chant': this.claps(0.6 * k, 9, 0.24, true); break;
    }
  }

  // ── Announcer (browser speech, optional) ───────────────────────────────
  speak(text: string): void {
    if (!this.voiceOn || this.muted) return;
    try {
      const s = window.speechSynthesis;
      if (!s) return;
      s.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.pitch = 0.85;
      u.volume = this.volume;
      s.speak(u);
    } catch (_e) { /* speech not available */ }
  }

  private cancelSpeech(): void {
    try { window.speechSynthesis?.cancel(); } catch (_e) { /* ignore */ }
  }
}
