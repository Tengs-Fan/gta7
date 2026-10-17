// Procedural radio: three stations generating endless music with a WebAudio
// lookahead scheduler. Songs are seeded (key, progression, drums, motif).

import { Rng } from '../core/rng';

type Genre = 'synthwave' | 'boombap' | 'house';

interface StationDef {
  name: string;
  genre: Genre;
  bpm: [number, number];
}

export const STATIONS: readonly StationDef[] = [
  { name: 'NEON DRIVE 88.7', genre: 'synthwave', bpm: [98, 112] },
  { name: 'BOOM BAP 101.3', genre: 'boombap', bpm: [84, 94] },
  { name: 'PULSE 96.1', genre: 'house', bpm: [120, 126] },
];

/** Output level of a playing station: 3 dB over unity, so the music sits over the engine. */
const RADIO_LEVEL = 1.41;

const MINOR = [0, 2, 3, 5, 7, 8, 10];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];

interface Song {
  genre: Genre;
  bpm: number;
  root: number;
  scale: number[];
  prog: number[];
  motif: number[];
  kickVariant: number;
  bars: number;
}

function midi(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export class Radio {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private noise!: AudioBuffer;
  private delay!: DelayNode;
  private delaySend!: GainNode;
  private index = 0;
  private active = false;
  private paused = false;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private song: Song | null = null;
  private rng = new Rng(Date.now() & 0xffff);

  get stationName(): string {
    return this.index < STATIONS.length ? STATIONS[this.index]!.name : 'RADIO OFF';
  }

  /** A station is playing (in a car, not paused, not switched off). */
  get playing(): boolean {
    return this.active;
  }

  /** One sample: notes start this long after their envelope's first event. */
  private get sample(): number {
    return 1 / this.ctx!.sampleRate;
  }

  init(ctx: AudioContext, dest: AudioNode, noise: AudioBuffer): void {
    this.ctx = ctx;
    this.noise = noise;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    this.delay = ctx.createDelay(1.5);
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const dl = ctx.createBiquadFilter();
    dl.type = 'lowpass';
    dl.frequency.value = 2500;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.35;
    this.delaySend.connect(this.delay);
    this.delay.connect(dl);
    dl.connect(fb);
    fb.connect(this.delay);
    dl.connect(this.out);
  }

  next(): string {
    this.index = (this.index + 1) % (STATIONS.length + 1);
    this.switched();
    return this.stationName;
  }

  prev(): string {
    this.index = (this.index + STATIONS.length) % (STATIONS.length + 1);
    this.switched();
    return this.stationName;
  }

  private switched(): void {
    this.song = null;
    this.static();
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  private static(): void {
    const ctx = this.ctx;
    if (!ctx || !this.active) return;
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2400;
    f.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    g.gain.linearRampToValueAtTime(0, t + 0.32);
    src.connect(f);
    f.connect(g);
    g.connect(this.out);
    src.start(t + this.sample, Math.random());
    src.stop(t + 0.35);
  }

  /** Starts a new song and moves the echo to a dotted eighth of its tempo. */
  private startSong(): Song {
    const song = this.newSong();
    this.song = song;
    if (this.ctx) this.delay.delayTime.setTargetAtTime((0.75 * 60) / song.bpm, this.ctx.currentTime, 0.05);
    return song;
  }

  private newSong(): Song {
    const st = STATIONS[this.index]!;
    const r = this.rng;
    const progs: Record<Genre, number[][]> = {
      synthwave: [[0, 5, 2, 6], [0, 3, 5, 4], [5, 3, 0, 4], [0, 6, 5, 6]],
      boombap: [[1, 4, 0, 0], [0, 3, 0, 3], [5, 1, 4, 0], [0, 5, 3, 4]],
      house: [[0, 0, 5, 5], [0, 3, 5, 4], [0, 5, 3, 4], [5, 5, 0, 0]],
    };
    const scale = st.genre === 'boombap' ? DORIAN : MINOR;
    const motif: number[] = [];
    let deg = r.int(0, 4);
    for (let i = 0; i < 8; i++) {
      deg = Math.max(0, Math.min(9, deg + r.pick([-2, -1, -1, 0, 1, 1, 2])));
      motif.push(r.chance(0.2) ? -1 : deg);
    }
    return {
      genre: st.genre,
      bpm: r.range(st.bpm[0], st.bpm[1]),
      root: (st.genre === 'boombap' ? 43 : 45) + r.int(-2, 4),
      scale,
      prog: r.pick(progs[st.genre]),
      motif,
      kickVariant: r.int(0, 2),
      bars: 32,
    };
  }

  private note(deg: number, octave: number, song: Song): number {
    const s = song.scale;
    const o = Math.floor(deg / s.length);
    const i = ((deg % s.length) + s.length) % s.length;
    return song.root + 12 * (octave + o) + s[i]!;
  }

  update(_dt: number, inCar: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const want = inCar && !this.paused && this.index < STATIONS.length;
    const t = ctx.currentTime;
    if (want !== this.active) {
      this.active = want;
      this.out.gain.setTargetAtTime(want ? RADIO_LEVEL : 0, t, want ? 0.3 : 0.15);
      if (want) {
        this.nextTime = t + 0.08;
        if (!this.song) this.startSong();
        this.static();
      }
    }
    if (!this.active) return;
    let song = this.song ?? this.startSong();
    if (this.nextTime < t - 0.2) this.nextTime = t + 0.05;
    let guard = 0;
    while (this.nextTime < t + 0.14 && guard++ < 32) {
      const stepDur = 60 / song.bpm / 4;
      this.playStep(song, this.step, this.bar, this.nextTime, stepDur);
      this.nextTime += stepDur;
      this.step++;
      if (this.step >= 16) {
        this.step = 0;
        this.bar++;
        if (this.bar >= song.bars) {
          this.bar = 0;
          song = this.startSong();
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Instruments

  /** Envelope on a fresh gain: silent from creation (notes are scheduled ahead) until `t`. */
  private env(g: GainNode, t: number, peak: number, attack: number, hold: number, release: number): void {
    g.gain.value = 0;
    // After a stalled frame a note can be due a little in the past: the zero must not land after it starts.
    g.gain.setValueAtTime(0, Math.min(this.ctx!.currentTime, t));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    g.gain.linearRampToValueAtTime(0, t + attack + hold + release + 0.01);
  }

  private kick(t: number, k = 1): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
    const g = ctx.createGain();
    this.env(g, t, 0.85 * k, 0.003, 0.02, 0.3);
    o.connect(g);
    g.connect(this.out);
    o.start(t + this.sample);
    o.stop(t + 0.4);
  }

  private noiseHit(t: number, type: BiquadFilterType, freq: number, dur: number, gain: number, send = 0): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    this.env(g, t, gain, 0.002, 0.005, dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.out);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      g.connect(s);
      s.connect(this.delaySend);
    }
    src.start(t + this.sample, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private snare(t: number, big: boolean): void {
    this.noiseHit(t, 'bandpass', 1900, big ? 0.22 : 0.15, 0.42, big ? 0.6 : 0);
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.08);
    const g = ctx.createGain();
    this.env(g, t, 0.25, 0.002, 0.01, 0.1);
    o.connect(g);
    g.connect(this.out);
    o.start(t + this.sample);
    o.stop(t + 0.2);
  }

  private clap(t: number): void {
    for (let i = 0; i < 3; i++) this.noiseHit(t + i * 0.011, 'bandpass', 1300, 0.12, 0.28, i === 2 ? 0.4 : 0);
  }

  private hat(t: number, open: boolean, gain = 0.13): void {
    this.noiseHit(t, 'highpass', 7500, open ? 0.22 : 0.035, gain);
  }

  private synth(t: number, freq: number, dur: number, type: OscillatorType, gain: number, cutoff: number, opts: { attack?: number; detune?: number; send?: number; release?: number; filterEnv?: boolean } = {}): void {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 1.5;
    if (opts.filterEnv) {
      f.frequency.setValueAtTime(cutoff * 3, t);
      f.frequency.exponentialRampToValueAtTime(cutoff, t + Math.min(dur, 0.25));
    } else f.frequency.value = cutoff;
    const g = ctx.createGain();
    const attack = opts.attack ?? 0.005;
    const release = opts.release ?? 0.08;
    this.env(g, t, gain, attack, Math.max(0, dur - attack), release);
    f.connect(g);
    g.connect(this.out);
    if (opts.send) {
      const s = ctx.createGain();
      s.gain.value = opts.send;
      g.connect(s);
      s.connect(this.delaySend);
    }
    const voices = opts.detune ? [-opts.detune, opts.detune] : [0];
    for (const d of voices) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = d;
      o.connect(f);
      o.start(t + this.sample);
      o.stop(t + dur + release + 0.05);
    }
  }

  private playStep(song: Song, step: number, bar: number, t: number, sd: number): void {
    const chordDeg = song.prog[bar % song.prog.length]!;
    const section = bar < 4 ? 'intro' : bar < 12 ? 'a' : bar < 20 ? 'b' : bar < 28 ? 'a2' : 'outro';
    const drums = section !== 'intro' && section !== 'outro';
    const lead = section === 'b' || section === 'a2';
    switch (song.genre) {
      case 'synthwave': {
        if (drums) {
          if (step === 0 || step === 8 || (song.kickVariant > 0 && (step === 6 || step === 10) && bar % 2 === 1)) this.kick(t);
          if (step === 4 || step === 12) this.snare(t, true);
        }
        if (step % 2 === 0) this.hat(t, step === 14 && section !== 'intro', 0.08);
        if (section !== 'intro') {
          const n = this.note(chordDeg, step % 2 === 0 ? 0 : 1, song);
          this.synth(t, midi(n), sd * 0.9, 'sawtooth', 0.16, 520, { filterEnv: true });
        }
        if (step === 0) {
          for (const k of [0, 2, 4]) this.synth(t, midi(this.note(chordDeg + k, 2, song)), sd * 15, 'sawtooth', 0.035, 1500, { attack: 0.25, detune: 9, release: 0.6, send: 0.2 });
        }
        if (lead && step % 2 === 0) {
          const d = song.motif[(step / 2 + (bar % 2) * 4) % 8]!;
          if (d >= 0) this.synth(t, midi(this.note(d + chordDeg, 3, song)), sd * 1.6, 'square', 0.05, 2600, { send: 0.55, release: 0.12 });
        }
        break;
      }
      case 'boombap': {
        const swing = step % 4 === 2 ? sd * 0.32 : 0;
        const tt = t + swing;
        if (drums || section === 'outro') {
          if (step === 0 || step === 10 || (song.kickVariant === 1 && step === 7) || (song.kickVariant === 2 && step === 3)) this.kick(tt, 0.95);
          if (step === 4 || step === 12) this.snare(tt, false);
        }
        if (step % 2 === 0) this.hat(tt, false, step % 4 === 0 ? 0.12 : 0.07);
        if (step === 0) this.synth(tt, midi(this.note(chordDeg, -1, song)), sd * 7, 'triangle', 0.32, 420, { release: 0.15 });
        if (step === 10) this.synth(tt, midi(this.note(chordDeg, -1, song)), sd * 3, 'triangle', 0.26, 420);
        if (step === 0 || step === 6 || (step === 14 && bar % 2 === 1)) {
          for (const k of [0, 2, 4, 6]) this.synth(tt, midi(this.note(chordDeg + k, 1, song)), sd * 2.5, 'triangle', 0.045, 1800, { release: 0.35, send: 0.15 });
        }
        if (lead && (step === 2 || step === 8 || step === 11)) {
          const d = song.motif[(step + bar) % 8]!;
          if (d >= 0) this.synth(tt, midi(this.note(d + chordDeg, 2, song)), sd * 2, 'sine', 0.08, 3000, { send: 0.45, release: 0.3 });
        }
        break;
      }
      case 'house': {
        if (section !== 'intro' || bar >= 2) {
          if (step % 4 === 0) this.kick(t, 0.9);
        }
        if (drums && (step === 4 || step === 12)) this.clap(t);
        if (step % 4 === 2) this.hat(t, true, 0.09);
        else if (drums && step % 2 === 1) this.hat(t, false, 0.04);
        if (section !== 'intro' && step % 4 === 2) this.synth(t, midi(this.note(chordDeg, 0, song)), sd * 1.2, 'sawtooth', 0.2, 480, { filterEnv: true });
        if (drums && (step === 3 || step === 6 || step === 11)) {
          for (const k of [0, 2, 4]) this.synth(t, midi(this.note(chordDeg + k, 2, song)), sd * 1.1, 'square', 0.035, 2200, { send: 0.3 });
        }
        if (lead) {
          const k = [0, 2, 4, 7][step % 4]!;
          this.synth(t, midi(this.note(chordDeg + k, 3, song)), sd * 0.8, 'triangle', 0.04, 3500, { send: 0.35 });
        }
        break;
      }
    }
  }
}
