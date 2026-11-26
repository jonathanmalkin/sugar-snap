import type { PraiseWord, SpecialType } from '../engine/types';
import type { ISoundEngine, SoundSettings } from './soundTypes';

/**
 * Sugar Snap procedural Web Audio studio.
 *
 * Everything is synthesized on the fly: no audio files. All SFX and music run
 * through their own gain buses into a gentle master compressor so huge
 * cascades stay rich and punchy without clipping.
 */

type WaveType = OscillatorType;

interface ToneOpts {
  freq: number;
  /** Optional pitch glide target, reached at `t + (glide ?? dur)`. */
  freqEnd?: number;
  glide?: number;
  t: number;
  dur: number;
  gain: number;
  type?: WaveType;
  attack?: number;
  detune?: number;
  dest?: AudioNode;
  /** Optional per-voice lowpass. */
  lowpass?: number;
}

interface NoiseOpts {
  t: number;
  dur: number;
  gain: number;
  filter: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  attack?: number;
  dest?: AudioNode;
}

const DEFAULT_SETTINGS: SoundSettings = {
  sfxEnabled: true,
  musicEnabled: true,
  sfxVolume: 0.8,
  musicVolume: 0.5,
};

const RAMP = 0.15; // 150ms gain ramps: toggles never click
const SILENT = 0.0001;

/** MIDI note number -> Hz. */
const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** Signature ascending cascade: C5 D5 E5 G5 A5 C6 D6 E6 G6 A6 C7. */
const CASCADE_MIDI = [72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96] as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(Number.isFinite(v) ? v : 0, 0, 1);

/** Music: gentle confectionery waltz, 3/4. Each bar: bass root + chord tones. */
interface MusicBar {
  bass: number;
  chord: readonly [number, number, number];
}

const MUSIC_BARS: readonly MusicBar[] = [
  { bass: 48, chord: [64, 67, 71] }, // Cmaj7
  { bass: 45, chord: [64, 67, 72] }, // Am7
  { bass: 41, chord: [65, 69, 72] }, // Fmaj7
  { bass: 43, chord: [62, 67, 71] }, // G
  { bass: 48, chord: [64, 67, 72] }, // C
  { bass: 52, chord: [64, 67, 71] }, // Em7/C colour
  { bass: 41, chord: [65, 69, 74] }, // F6/9
  { bass: 43, chord: [62, 65, 71] }, // G7
];

/** Melody per bar: [beat, midi] pairs, beats 0..2 (null bars rest). */
const MELODY: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[0, 76], [2, 79]],
  [[0, 81], [1.5, 79]],
  [[0, 77], [2, 76]],
  [[0, 74], [2, 79]],
  [[0, 76], [1, 79], [2, 84]],
  [[0, 83], [2, 79]],
  [[0, 81], [1.5, 77], [2, 76]],
  [[0, 74]],
];

const MUSIC_BPM = 92;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

export class SoundEngine implements ISoundEngine {
  private ctx: AudioContext | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private settings: SoundSettings = { ...DEFAULT_SETTINGS };
  private unlocked = false;
  private disposed = false;

  private musicWanted = false;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicNextTime = 0;
  private musicBeat = 0;

  private lastPlayed = new Map<string, number>();

  private readonly onVisibility = (): void => {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    if (document.visibilityState === 'hidden') {
      if (ctx.state === 'running') void ctx.suspend().catch(() => undefined);
    } else {
      this.resumeContext();
    }
  };

  private readonly onGesture = (): void => {
    this.resumeContext();
  };

  constructor(settings?: Partial<SoundSettings>) {
    if (settings) this.settings = { ...this.settings, ...settings };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  unlock(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      if (!this.createContext()) return;
    }
    const ctx = this.ctx;
    if (!ctx) return;

    if (!this.unlocked) {
      this.unlocked = true;
      // iOS Safari: a silent 1-sample buffer started inside the gesture unlocks output.
      try {
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      } catch {
        /* ignore */
      }
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this.onVisibility);
        document.addEventListener('pointerdown', this.onGesture, { passive: true });
        document.addEventListener('touchend', this.onGesture, { passive: true });
        document.addEventListener('keydown', this.onGesture);
      }
    }
    this.resumeContext();
    this.syncMusic();
  }

  updateSettings(settings: SoundSettings): void {
    this.settings = {
      sfxEnabled: settings.sfxEnabled,
      musicEnabled: settings.musicEnabled,
      sfxVolume: clamp01(settings.sfxVolume),
      musicVolume: clamp01(settings.musicVolume),
    };
    this.applyGains();
    this.syncMusic();
  }

  startMusic(): void {
    this.musicWanted = true;
    this.syncMusic();
  }

  stopMusic(): void {
    this.musicWanted = false;
    this.syncMusic();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopScheduler();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
      document.removeEventListener('pointerdown', this.onGesture);
      document.removeEventListener('touchend', this.onGesture);
      document.removeEventListener('keydown', this.onGesture);
    }
    const ctx = this.ctx;
    this.ctx = null;
    this.compressor = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.musicFilter = null;
    this.noiseBuffer = null;
    this.lastPlayed.clear();
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => undefined);
    }
  }

  private createContext(): boolean {
    if (typeof window === 'undefined') return false;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      try {
        ctx = new Ctor();
      } catch {
        return false;
      }
    }

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 6;
    compressor.knee.value = 10;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.22;

    const master = ctx.createGain();
    master.gain.value = 0.9;

    const sfxBus = ctx.createGain();
    const musicBus = ctx.createGain();
    sfxBus.gain.value = 0;
    musicBus.gain.value = 0;

    // Soft warm filter on the music bus keeps the groove non-fatiguing.
    const musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.frequency.value = 3200;
    musicFilter.Q.value = 0.5;

    musicFilter.connect(musicBus);
    sfxBus.connect(compressor);
    musicBus.connect(compressor);
    compressor.connect(master);
    master.connect(ctx.destination);

    // 1s of white noise, reused for every noise burst.
    const len = Math.floor(ctx.sampleRate);
    const noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.compressor = compressor;
    this.master = master;
    this.sfxBus = sfxBus;
    this.musicBus = musicBus;
    this.musicFilter = musicFilter;
    this.noiseBuffer = noise;
    this.applyGains();
    return true;
  }

  private resumeContext(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      void ctx
        .resume()
        .then(() => {
          // Keep the music clock from trying to catch up after a pause.
          if (this.ctx && this.musicNextTime < this.ctx.currentTime) {
            this.musicNextTime = this.ctx.currentTime + 0.05;
          }
        })
        .catch(() => undefined);
    }
  }

  private rampGain(param: AudioParam, target: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + RAMP);
  }

  private applyGains(): void {
    if (this.sfxBus) {
      this.rampGain(this.sfxBus.gain, this.settings.sfxEnabled ? this.settings.sfxVolume : 0);
    }
    if (this.musicBus) {
      const on = this.musicWanted && this.settings.musicEnabled;
      this.rampGain(this.musicBus.gain, on ? this.settings.musicVolume * 0.55 : 0);
    }
  }

  // ---------------------------------------------------------------------------
  // Synthesis primitives
  // ---------------------------------------------------------------------------

  /** Returns the start time if SFX may play now, else null. */
  private sfxTime(): number | null {
    const ctx = this.ctx;
    if (!ctx || this.disposed || !this.settings.sfxEnabled || this.settings.sfxVolume <= 0) return null;
    if (ctx.state !== 'running') {
      this.resumeContext();
      return null;
    }
    return ctx.currentTime + 0.005;
  }

  private rateLimited(key: string, minGapSec: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return true;
    const now = ctx.currentTime;
    const last = this.lastPlayed.get(key);
    if (last !== undefined && now - last < minGapSec) return true;
    this.lastPlayed.set(key, now);
    return false;
  }

  private tone(o: ToneOpts): void {
    const ctx = this.ctx;
    const dest = o.dest ?? this.sfxBus;
    if (!ctx || !dest) return;
    const attack = Math.max(0.001, o.attack ?? 0.004);
    const end = o.t + Math.max(o.dur, attack + 0.01);

    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, o.t);
    if (o.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), o.t + (o.glide ?? o.dur));
    }
    if (o.detune) osc.detune.setValueAtTime(o.detune, o.t);

    const g = ctx.createGain();
    g.gain.setValueAtTime(SILENT, o.t);
    g.gain.linearRampToValueAtTime(Math.max(SILENT, o.gain), o.t + attack);
    g.gain.exponentialRampToValueAtTime(SILENT, end);

    let head: AudioNode = osc;
    let filter: BiquadFilterNode | null = null;
    if (o.lowpass !== undefined) {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(o.lowpass, o.t);
      filter.Q.value = 0.7;
      osc.connect(filter);
      head = filter;
    }
    head.connect(g);
    g.connect(dest);

    osc.start(o.t);
    osc.stop(end + 0.03);
    osc.onended = () => {
      osc.disconnect();
      filter?.disconnect();
      g.disconnect();
    };
  }

  private noise(o: NoiseOpts): void {
    const ctx = this.ctx;
    const dest = o.dest ?? this.sfxBus;
    if (!ctx || !dest || !this.noiseBuffer) return;
    const attack = Math.max(0.001, o.attack ?? 0.002);
    const end = o.t + Math.max(o.dur, attack + 0.01);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = o.filter;
    filter.frequency.setValueAtTime(o.freq, o.t);
    if (o.freqEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), end);
    }
    filter.Q.value = o.q ?? 1;

    const g = ctx.createGain();
    g.gain.setValueAtTime(SILENT, o.t);
    g.gain.linearRampToValueAtTime(Math.max(SILENT, o.gain), o.t + attack);
    g.gain.exponentialRampToValueAtTime(SILENT, end);

    src.connect(filter);
    filter.connect(g);
    g.connect(dest);
    const offset = Math.random() * 0.5;
    src.start(o.t, offset);
    src.stop(end + 0.03);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      g.disconnect();
    };
  }

  /** Warm resonant marimba: sine fundamental + soft 4x mallet partial. */
  private marimba(freq: number, t: number, gain: number, dur = 0.45, dest?: AudioNode): void {
    this.tone({ freq, t, dur, gain, type: 'sine', attack: 0.002, dest });
    this.tone({ freq: freq * 4, t, dur: Math.min(0.06, dur), gain: gain * 0.18, type: 'sine', attack: 0.001, dest });
    this.tone({ freq: freq * 2, t, dur: dur * 0.35, gain: gain * 0.12, type: 'triangle', attack: 0.002, dest });
  }

  /** Crystalline glass bell: fundamental + 2x/3x shimmer that decays fast. */
  private bell(freq: number, t: number, gain: number, dur = 0.6, dest?: AudioNode): void {
    this.tone({ freq, t, dur, gain, type: 'sine', attack: 0.002, dest });
    this.tone({ freq: freq * 2, t, dur: dur * 0.45, gain: gain * 0.38, type: 'sine', attack: 0.001, detune: 4, dest });
    this.tone({ freq: freq * 3, t, dur: dur * 0.25, gain: gain * 0.2, type: 'sine', attack: 0.001, detune: -6, dest });
  }

  /** Airy high sparkle shimmer: quick random high bell pings + a hiss. */
  private shimmer(t: number, count: number, gain: number, baseMidi = 96, spread = 0.035): void {
    const pent = [0, 2, 4, 7, 9, 12];
    for (let i = 0; i < count; i++) {
      const m = baseMidi + pent[Math.floor(Math.random() * pent.length)];
      this.tone({ freq: mtof(m), t: t + i * spread, dur: 0.18, gain: gain * (1 - i / (count * 1.4)), type: 'sine', attack: 0.001 });
    }
    this.noise({ t, dur: 0.12 + count * spread, gain: gain * 0.35, filter: 'highpass', freq: 7000, q: 0.7, attack: 0.01 });
  }

  // ---------------------------------------------------------------------------
  // Foley
  // ---------------------------------------------------------------------------

  playSelect(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('select', 0.03)) return;
    this.tone({ freq: mtof(84), t, dur: 0.09, gain: 0.16, type: 'sine', attack: 0.001 });
    this.tone({ freq: mtof(91) * 2, t, dur: 0.04, gain: 0.05, type: 'sine', attack: 0.001 });
    this.noise({ t, dur: 0.025, gain: 0.05, filter: 'bandpass', freq: 3200, q: 3 });
  }

  playSwap(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('swap', 0.03)) return;
    this.noise({ t, dur: 0.16, gain: 0.16, filter: 'bandpass', freq: 900, freqEnd: 3800, q: 2.2, attack: 0.03 });
    this.tone({ freq: mtof(67), freqEnd: mtof(79), t, dur: 0.12, gain: 0.05, type: 'sine', attack: 0.01 });
  }

  playInvalidSwap(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('invalid', 0.05)) return;
    for (let i = 0; i < 2; i++) {
      const s = t + i * 0.11;
      this.tone({ freq: mtof(57 - i * 3), freqEnd: mtof(50 - i * 3), glide: 0.09, t: s, dur: 0.13, gain: 0.2, type: 'triangle', attack: 0.003, lowpass: 1400 });
    }
  }

  playMatch(cascade: number, count: number): void {
    const t = this.sfxTime();
    if (t === null) return;
    const idx = clamp(Math.round((Number.isFinite(cascade) ? cascade : 1) - 1), 0, CASCADE_MIDI.length - 1);
    const freq = mtof(CASCADE_MIDI[idx]);

    // Marimba fundamental.
    this.marimba(freq, t, 0.28, 0.42);
    // Glass bell harmonic layer.
    this.tone({ freq: freq * 2, t, dur: 0.28, gain: 0.08, type: 'sine', attack: 0.001, detune: 3 });
    this.tone({ freq: freq * 3, t, dur: 0.14, gain: 0.04, type: 'sine', attack: 0.001, detune: -5 });
    // Bubbly jelly-pop sweep.
    this.tone({ freq: freq * 0.5, freqEnd: freq * 1.5, glide: 0.06, t, dur: 0.09, gain: 0.1, type: 'sine', attack: 0.002 });

    if (count >= 4) {
      const h = t + 0.035;
      this.bell(freq * Math.pow(2, 4 / 12), h, 0.09, 0.4); // major third
      if (count >= 5) this.bell(freq * Math.pow(2, 7 / 12), h + 0.03, 0.08, 0.45); // fifth
      this.shimmer(h + 0.04, 3, 0.03);
    }
  }

  playLand(intensity = 1): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('land', 0.032)) return;
    const k = clamp(Number.isFinite(intensity) ? intensity : 1, 0.2, 1.5);
    const jitter = Math.pow(2, (Math.random() * 2 - 1) * (2.5 / 12));
    const f = 260 * jitter;
    this.tone({ freq: f * 1.6, freqEnd: f, glide: 0.05, t, dur: 0.09, gain: 0.09 * k, type: 'sine', attack: 0.002 });
    this.tone({ freq: f * 0.5, t, dur: 0.06, gain: 0.05 * k, type: 'triangle', attack: 0.002, lowpass: 600 });
  }

  playSpecialSpawn(special: SpecialType): void {
    const t = this.sfxTime();
    if (t === null) return;
    let notes: number[];
    let step = 0.055;
    switch (special) {
      case 'striped-h':
      case 'striped-v':
        notes = [79, 84, 88, 91];
        break;
      case 'wrapped':
        notes = [72, 76, 79, 84, 88];
        step = 0.06;
        break;
      case 'color-bomb':
        notes = [72, 76, 79, 83, 86, 91, 96];
        step = 0.045;
        break;
      default:
        notes = [84, 88];
    }
    notes.forEach((m, i) => this.bell(mtof(m), t + i * step, 0.1, 0.4));
    if (special === 'wrapped') this.tone({ freq: mtof(48), t, dur: 0.25, gain: 0.12, type: 'sine', attack: 0.004 });
    if (special === 'color-bomb') {
      this.tone({ freq: mtof(60), freqEnd: mtof(84), glide: 0.3, t, dur: 0.35, gain: 0.06, type: 'triangle', attack: 0.02, lowpass: 3000 });
    }
    this.shimmer(t + notes.length * step, special === 'color-bomb' ? 6 : 3, 0.035);
  }

  playStripedBlast(mega = false): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('striped', 0.04)) return;
    const dur = mega ? 0.38 : 0.24;
    // Laser whip: falling harmonic sweep, two partials.
    this.tone({ freq: 2400, freqEnd: 320, glide: dur * 0.9, t, dur, gain: 0.11, type: 'sawtooth', attack: 0.002, lowpass: 4200 });
    this.tone({ freq: 1800, freqEnd: 600, glide: dur * 0.8, t, dur: dur * 0.9, gain: 0.08, type: 'sine', attack: 0.002 });
    this.noise({ t, dur: dur * 0.8, gain: 0.07, filter: 'bandpass', freq: 5000, freqEnd: 1200, q: 3 });
    if (mega) {
      this.tone({ freq: mtof(36), freqEnd: mtof(31), t, dur: 0.4, gain: 0.22, type: 'sine', attack: 0.003 });
      this.tone({ freq: 1200, freqEnd: 180, glide: 0.3, t: t + 0.03, dur: 0.34, gain: 0.07, type: 'square', attack: 0.002, lowpass: 2400 });
    }
    this.shimmer(t + dur * 0.5, mega ? 6 : 4, 0.035, mega ? 91 : 96);
  }

  playWrappedBlast(stage: 1 | 2, mega = false): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('wrapped', 0.04)) return;
    const big = (stage === 2 ? 1.2 : 1) * (mega ? 1.3 : 1);
    const root = stage === 2 ? 50 : 45;
    // Sub thump.
    this.tone({ freq: mtof(root + 12), freqEnd: mtof(root - 7), glide: 0.18, t, dur: 0.32 * big, gain: 0.32 * Math.min(big, 1.25), type: 'sine', attack: 0.002 });
    // Wrapper crinkle.
    for (let i = 0; i < 4; i++) {
      this.noise({ t: t + i * 0.018 + Math.random() * 0.008, dur: 0.03, gain: 0.07 * big, filter: 'highpass', freq: stage === 2 ? 5200 : 4200, q: 0.8 });
    }
    this.noise({ t, dur: 0.18 * big, gain: 0.06, filter: 'lowpass', freq: 1800, freqEnd: 300, q: 0.7 });
    // Sparkle burst.
    const chord = stage === 2 ? [86, 91, 95] : [84, 88, 91];
    chord.forEach((m, i) => this.bell(mtof(m), t + 0.04 + i * 0.025, 0.06 * big, 0.35));
    if (mega) this.shimmer(t + 0.1, 6, 0.035);
  }

  playColorBombZap(stepIndex = 0): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('zap', 0.022)) return;
    const step = Math.max(0, Math.floor(Number.isFinite(stepIndex) ? stepIndex : 0));
    const m = CASCADE_MIDI[Math.min(step, CASCADE_MIDI.length - 1)] + (step >= CASCADE_MIDI.length ? 12 : 0);
    const f = mtof(Math.min(m, 103));
    this.tone({ freq: f * 0.75, freqEnd: f, glide: 0.03, t, dur: 0.18, gain: 0.08, type: 'triangle', attack: 0.001 });
    this.bell(f, t + 0.01, 0.06, 0.28);
    this.noise({ t, dur: 0.05, gain: 0.04, filter: 'bandpass', freq: 6500, q: 4 });
  }

  playBoardWipe(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('wipe', 0.2)) return;
    // Lush rainbow chord swell (Cmaj9).
    const chord = [48, 60, 64, 67, 71, 74];
    chord.forEach((m, i) => {
      this.tone({ freq: mtof(m), t, dur: 1.4, gain: 0.07, type: 'triangle', attack: 0.25, detune: i % 2 ? 5 : -5, lowpass: 2600 });
      this.tone({ freq: mtof(m), t, dur: 1.3, gain: 0.04, type: 'sine', attack: 0.3 });
    });
    this.tone({ freq: mtof(36), t, dur: 0.9, gain: 0.22, type: 'sine', attack: 0.005 });
    // Sweeping shimmer cascade upward.
    const run = [72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96, 98, 100];
    run.forEach((m, i) => this.bell(mtof(m), t + 0.08 + i * 0.045, 0.05, 0.4));
    this.noise({ t, dur: 1.0, gain: 0.05, filter: 'bandpass', freq: 1200, freqEnd: 9000, q: 1.2, attack: 0.3 });
  }

  playFrostingCrunch(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('frosting', 0.035)) return;
    for (let i = 0; i < 5; i++) {
      this.noise({ t: t + i * 0.014 + Math.random() * 0.006, dur: 0.02 + Math.random() * 0.015, gain: 0.08, filter: 'highpass', freq: 3000 + Math.random() * 3000, q: 1 });
    }
    // Woody snap.
    this.tone({ freq: 1100, freqEnd: 650, glide: 0.03, t, dur: 0.05, gain: 0.08, type: 'triangle', attack: 0.001 });
  }

  playJellyClear(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('jelly', 0.03)) return;
    this.tone({ freq: 330, freqEnd: 900, glide: 0.08, t, dur: 0.13, gain: 0.14, type: 'sine', attack: 0.003 });
    this.bell(mtof(88), t + 0.06, 0.06, 0.32);
  }

  playLockBreak(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('lock', 0.035)) return;
    // Metallic snap: inharmonic pair + click.
    this.tone({ freq: 1560, t, dur: 0.08, gain: 0.06, type: 'square', attack: 0.001, lowpass: 5000 });
    this.tone({ freq: 2210, t, dur: 0.06, gain: 0.05, type: 'sine', attack: 0.001 });
    this.noise({ t, dur: 0.03, gain: 0.1, filter: 'bandpass', freq: 2800, q: 2 });
    // Release chime.
    this.bell(mtof(84), t + 0.05, 0.07, 0.35);
    this.bell(mtof(91), t + 0.1, 0.05, 0.35);
  }

  playChocolateSpread(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('choco', 0.06)) return;
    this.tone({ freq: 140, freqEnd: 95, glide: 0.28, t, dur: 0.32, gain: 0.16, type: 'sine', attack: 0.02 });
    this.tone({ freq: 210, freqEnd: 150, glide: 0.25, t: t + 0.04, dur: 0.26, gain: 0.07, type: 'triangle', attack: 0.02, lowpass: 700 });
    this.tone({ freq: 180, freqEnd: 260, glide: 0.06, t: t + 0.22, dur: 0.1, gain: 0.07, type: 'sine', attack: 0.004 });
  }

  playIngredientCollect(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('ingredient', 0.08)) return;
    // Joyful rising harp triad (plucked triangle + bell).
    [72, 76, 79, 84].forEach((m, i) => {
      const s = t + i * 0.07;
      this.tone({ freq: mtof(m), t: s, dur: 0.6, gain: 0.12, type: 'triangle', attack: 0.002, lowpass: 3500 });
      this.tone({ freq: mtof(m) * 2, t: s, dur: 0.25, gain: 0.04, type: 'sine', attack: 0.001 });
    });
    this.shimmer(t + 0.3, 4, 0.03);
  }

  playCallout(word: PraiseWord): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('callout', 0.15)) return;
    const level: Record<PraiseWord, number> = {
      'Snappy!': 0,
      'Juicy!': 1,
      'Yummy!': 2,
      'Spectacular!': 3,
      'Sugar Snap!': 4,
    };
    const lv = level[word] ?? 0;
    const arps: readonly (readonly number[])[] = [
      [79, 84],
      [76, 79, 84],
      [72, 76, 79, 84, 88],
      [72, 76, 79, 84, 88, 91],
      [72, 76, 79, 84, 88, 91, 96],
    ];
    const notes = arps[lv];
    const step = lv >= 3 ? 0.06 : 0.075;
    notes.forEach((m, i) => this.bell(mtof(m), t + i * step, 0.09, 0.5));
    const end = t + notes.length * step;
    // Resolving chord.
    const chord = lv >= 3 ? [60, 64, 67, 72] : [72, 76, 79];
    chord.forEach((m) => this.marimba(mtof(m), end, 0.07 + lv * 0.01, 0.6));
    if (lv >= 2) this.tone({ freq: mtof(48), t: end, dur: 0.6, gain: 0.14, type: 'sine', attack: 0.004 });
    if (lv >= 1) this.shimmer(end, 2 + lv * 2, 0.03);
    if (lv === 4) {
      chord.forEach((m) => this.tone({ freq: mtof(m), t: end, dur: 1.4, gain: 0.05, type: 'triangle', attack: 0.2, lowpass: 2400 }));
    }
  }

  playShuffle(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('shuffle', 0.3)) return;
    const run = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 81, 79, 76, 74, 72];
    run.forEach((m, i) => {
      this.tone({ freq: mtof(m), t: t + i * 0.035, dur: 0.35, gain: 0.07, type: 'triangle', attack: 0.002, lowpass: 3200 });
    });
    this.noise({ t, dur: 0.6, gain: 0.04, filter: 'bandpass', freq: 600, freqEnd: 3000, q: 1.5, attack: 0.15 });
  }

  playBooster(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('booster', 0.1)) return;
    [84, 91, 88, 96].forEach((m, i) => this.bell(mtof(m), t + i * 0.05, 0.08, 0.45));
    this.shimmer(t + 0.15, 5, 0.035);
  }

  playStar(starNumber: 1 | 2 | 3): void {
    const t = this.sfxTime();
    if (t === null) return;
    // C6 -> E6 -> G6 + C7
    const notes = starNumber === 1 ? [84] : starNumber === 2 ? [88] : [91, 96];
    notes.forEach((m, i) => this.bell(mtof(m), t + i * 0.03, 0.13, 0.9));
    this.bell(mtof(notes[0] - 12), t, 0.05, 0.6);
    this.shimmer(t + 0.05, 2 + starNumber, 0.03);
  }

  playVictory(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('victory', 1)) return;
    const beat = 0.2;
    const lines: ReadonlyArray<{ mel: number; bass: number }> = [
      { mel: 72, bass: 48 },
      { mel: 76, bass: 52 },
      { mel: 79, bass: 55 },
    ];
    lines.forEach((b, i) => {
      const s = t + i * beat;
      this.marimba(mtof(b.mel), s, 0.16, 0.35);
      this.bell(mtof(b.mel + 12), s, 0.05, 0.3);
      this.marimba(mtof(b.bass), s, 0.12, 0.3);
    });
    // Beat 4: held C major chord, bells, bass.
    const s = t + 3 * beat;
    [72, 76, 79, 84].forEach((m) => {
      this.marimba(mtof(m), s, 0.1, 0.9);
      this.tone({ freq: mtof(m), t: s, dur: 1.5, gain: 0.05, type: 'triangle', attack: 0.08, lowpass: 2800 });
    });
    this.bell(mtof(96), s + 0.02, 0.08, 1.1);
    this.tone({ freq: mtof(36), t: s, dur: 1.0, gain: 0.2, type: 'sine', attack: 0.005 });
    this.shimmer(s + 0.05, 8, 0.03);
  }

  playDefeat(): void {
    const t = this.sfxTime();
    if (t === null || this.rateLimited('defeat', 1)) return;
    const notes = [67, 64, 62, 60];
    notes.forEach((m, i) => {
      const s = t + i * 0.28;
      const last = i === notes.length - 1;
      this.tone({ freq: mtof(m), t: s, dur: last ? 1.1 : 0.5, gain: 0.14, type: 'sine', attack: 0.004 });
      this.tone({ freq: mtof(m) * 4, t: s, dur: 0.05, gain: 0.02, type: 'sine', attack: 0.001 });
    });
    const end = t + 3 * 0.28;
    [48, 55, 64].forEach((m) => this.tone({ freq: mtof(m), t: end, dur: 1.3, gain: 0.05, type: 'triangle', attack: 0.1, lowpass: 900 }));
  }

  // ---------------------------------------------------------------------------
  // Music: lookahead-scheduled marimba + pad waltz
  // ---------------------------------------------------------------------------

  private syncMusic(): void {
    this.applyGains();
    const shouldPlay = this.musicWanted && this.settings.musicEnabled && this.settings.musicVolume > 0;
    if (shouldPlay && this.ctx && this.unlocked && !this.disposed) {
      this.startScheduler();
    } else if (!shouldPlay) {
      // Let the 150ms gain ramp finish; scheduled notes then play into silence.
      this.stopScheduler();
    }
  }

  private startScheduler(): void {
    const ctx = this.ctx;
    if (!ctx || this.musicTimer !== null) return;
    this.musicNextTime = ctx.currentTime + 0.1;
    this.musicBeat = 0;
    this.musicTimer = setInterval(() => this.scheduleMusic(), LOOKAHEAD_MS);
    this.scheduleMusic();
  }

  private stopScheduler(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const beatDur = 60 / MUSIC_BPM;
    if (this.musicNextTime < ctx.currentTime - 0.2) this.musicNextTime = ctx.currentTime + 0.05;
    while (this.musicNextTime < ctx.currentTime + SCHEDULE_AHEAD) {
      this.scheduleBeat(this.musicBeat, this.musicNextTime, beatDur);
      this.musicNextTime += beatDur;
      this.musicBeat = (this.musicBeat + 1) % (MUSIC_BARS.length * 3 * 2);
    }
  }

  private scheduleBeat(beatIndex: number, t: number, beatDur: number): void {
    const dest = this.musicFilter;
    if (!dest) return;
    const barIdx = Math.floor(beatIndex / 3);
    const bar = MUSIC_BARS[barIdx % MUSIC_BARS.length];
    const beatInBar = beatIndex % 3;
    const secondPass = barIdx >= MUSIC_BARS.length;

    if (beatInBar === 0) {
      // Bass marimba on the downbeat.
      this.marimba(mtof(bar.bass), t, 0.2, beatDur * 1.6, dest);
      // Soft pad for the bar.
      bar.chord.forEach((m, i) => {
        this.tone({ freq: mtof(m - 12), t, dur: beatDur * 3.2, gain: 0.035, type: 'triangle', attack: beatDur * 0.9, detune: i % 2 ? 6 : -6, lowpass: 1100, dest });
      });
    } else {
      // Waltz "oom-pah-pah": light chord taps on beats 2 and 3.
      bar.chord.forEach((m, i) => this.marimba(mtof(m), t + i * 0.008, 0.045, beatDur * 0.7, dest));
    }

    // Melody, varied on the second pass.
    const melody = MELODY[barIdx % MELODY.length];
    for (const [beat, midi] of melody) {
      if (beat < beatInBar || beat >= beatInBar + 1) continue;
      const nt = t + (beat - beatInBar) * beatDur;
      // Second pass lifts every fourth bar's downbeat an octave for gentle variety.
      const m = secondPass && beat === 0 && barIdx % 4 === 1 ? midi + 12 : midi;
      this.marimba(mtof(m), nt, 0.08, beatDur * 1.2, dest);
      if (secondPass) this.tone({ freq: mtof(m) * 2, t: nt, dur: 0.3, gain: 0.015, type: 'sine', attack: 0.002, dest });
    }
  }
}

export function createSoundEngine(settings?: Partial<SoundSettings>): SoundEngine {
  return new SoundEngine(settings);
}
