// The talk station: a seeded, endless programme of host chatter, station jingles and ad breaks with short gaps of
// dead air between segments. The programme runs on its own clock like a live broadcast: tuning in lands mid-segment.
// TalkProgramme is pure (the schedule); TalkShow renders the current segment with formant voices and soft beds.

import { Rng } from '../core/rng';
import { withinParam } from './mixer';
import type { NodeTally } from './tally';
import { AD_VOICE, FormantVoice, HOST_VOICE, speechPlan, type Syllable } from './voice';

export type TalkKind = 'host' | 'jingle' | 'ad' | 'gap';

export interface TalkSegment {
  kind: TalkKind;
  /** Seconds from the start of the programme. */
  start: number;
  dur: number;
  /** Seeds the segment's words and bed. */
  seed: number;
}

export const JINGLE_LEN = 3.6;
export const HOST_LEN: readonly [number, number] = [24, 42];
export const AD_LEN: readonly [number, number] = [11, 17];
export const GAP_LEN: readonly [number, number] = [0.5, 0.8];

/**
 * The schedule, generated in blocks as far as it is asked for. The first break is always an ad break, so every
 * stretch of a few minutes has host speech, jingles and ads.
 */
export class TalkProgramme {
  readonly segments: TalkSegment[] = [];
  private readonly rng: Rng;
  private end = 0;
  private breaks = 0;

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.push('jingle', JINGLE_LEN);
    this.gap();
    this.host();
  }

  private push(kind: TalkKind, dur: number): void {
    this.segments.push({ kind, start: this.end, dur, seed: (this.rng.next() * 0xffffffff) >>> 0 });
    this.end += dur;
  }

  private gap(): void {
    this.push('gap', this.rng.range(GAP_LEN[0], GAP_LEN[1]));
  }

  private host(): void {
    this.push('host', this.rng.range(HOST_LEN[0], HOST_LEN[1]));
    this.gap();
  }

  private block(): void {
    const r = this.rng;
    if (this.breaks++ === 0 || r.chance(0.6)) {
      const ads = r.chance(0.5) ? 2 : 1;
      for (let i = 0; i < ads; i++) {
        this.push('ad', r.range(AD_LEN[0], AD_LEN[1]));
        this.gap();
      }
    }
    this.push('jingle', JINGLE_LEN);
    this.gap();
    this.host();
  }

  /** The segment playing `t` seconds into the programme. */
  at(t: number): TalkSegment {
    const x = Number.isFinite(t) ? Math.max(0, t) : 0;
    while (this.end <= x) this.block();
    const s = this.segments;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid]!.start <= x) lo = mid;
      else hi = mid - 1;
    }
    return s[lo]!;
  }

  /** Every segment that starts before `seconds`. */
  until(seconds: number): TalkSegment[] {
    this.at(seconds);
    return this.segments.filter((s) => s.start < seconds);
  }
}

export function talkProgramme(seed: number, seconds: number): TalkSegment[] {
  return new TalkProgramme(seed).until(seconds);
}

function midi(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Levels at the station output (before the radio's own output gain). */
const HOST_LEVEL = 0.5;
const AD_LEVEL = 0.46;
const JINGLE_VOICE_LEVEL = 0.42;
/** The soft pad under the host: keeps the air from going dead between phrases, about 18 dB under the voice. */
const HOST_BED = 0.05;
const AD_BED = 0.05;

/** Seconds a pad takes to fade in and out: the segment is audible from its first sample to its last. */
export const PAD_FADE = 0.01;
/** The pad's tremolo is gain = TREMOLO_BASE + TREMOLO_DEPTH * lfo, which never drops under TREMOLO_BASE - TREMOLO_DEPTH. */
export const TREMOLO_BASE = 0.75;
export const TREMOLO_DEPTH = 0.25;
/** Seconds into the jingle its voice and first bell start. */
export const JINGLE_LEAD = 0.01;
/** The closing chord starts this long after JINGLE_LEAD, on the beat after the last melody note while that note is still ringing, and rings to the jingle's end. */
export const CHORD_AT = 1.68;
/** Fade to silence after a bell's decay (it lands inside the declared segment). */
export const BELL_FADE = 0.03;
/** Level a bell has decayed to when its decay ends: high enough that the next note, or the end of the segment, is reached while it is still audible. */
const BELL_FLOOR = 0.012;
const LATE_BELL = 0.1;

export interface Bell {
  /** Seconds from the jingle's start. */
  t: number;
  /** Semitones over the jingle's root. */
  m: number;
  /** Decay seconds. */
  dur: number;
  level: number;
  /** Level when the decay ends, before the fade to zero. */
  floor: number;
}

/** The jingle's bells: four melody notes and the closing chord, which rings to the end of the declared segment. */
export function jingleBells(): Bell[] {
  const bells: Bell[] = [];
  [0, 4, 7, 12].forEach((m, i) => bells.push({ t: JINGLE_LEAD + i * 0.42, m: m + 12, dur: 0.6, level: 0.12, floor: BELL_FLOOR }));
  const t = JINGLE_LEAD + CHORD_AT;
  for (const m of [0, 4, 7]) bells.push({ t, m: m + 12, dur: JINGLE_LEN - t - BELL_FADE - 0.005, level: 0.07, floor: BELL_FLOOR });
  return bells;
}

/** A bell partial's gain `x` seconds after its start: 5 ms attack, exponential decay, then a short fade to zero. */
export function bellGain(b: Bell, x: number, k = 1): number {
  if (x < 0 || x > b.dur + BELL_FADE) return 0;
  const peak = b.level * k;
  if (x < 0.005) return (peak * x) / 0.005;
  const floor = b.floor * k;
  if (x <= b.dur) return peak * Math.pow(floor / peak, (x - 0.005) / (b.dur - 0.005));
  return floor * (1 - (x - b.dur) / BELL_FADE);
}

/** The pad's gain envelope (0..1) `x` seconds into a segment of `dur` seconds. */
export function padEnvelope(x: number, dur: number): number {
  if (x < 0 || x > dur) return 0;
  return Math.min(1, x / PAD_FADE, (dur - x) / PAD_FADE);
}

interface Part {
  gain: GainNode;
  sources: AudioScheduledSourceNode[];
}

function stopSafely(s: AudioScheduledSourceNode, t: number): void {
  try {
    s.stop(t);
  } catch {
    // Not started or already stopped.
  }
}

/** Renders the programme's current segment. */
export class TalkShow {
  private seg: TalkSegment | null = null;
  private voices: FormantVoice[] = [];
  private parts: Part[] = [];

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly noise: AudioBuffer,
    private readonly tally?: NodeTally,
  ) {}

  /** The segment being rendered (null when stopped). */
  get segment(): TalkSegment | null {
    return this.seg;
  }

  /** Plays `seg`, which started at context time `t0`; schedules its voices up to `until`. */
  update(seg: TalkSegment, t0: number, until: number): void {
    if (seg !== this.seg) {
      this.stop(this.ctx.currentTime);
      this.seg = seg;
      this.render(seg, t0);
    }
    for (const v of this.voices) v.schedule(until);
  }

  /** Stops whatever plays, fading over 50 ms from `t` (or now). */
  stop(t: number): void {
    const at = Math.max(this.ctx.currentTime, t);
    for (const v of this.voices) v.stop(at);
    for (const p of this.parts) {
      const g = p.gain.gain;
      g.cancelScheduledValues(at);
      g.setValueAtTime(g.value, at);
      g.linearRampToValueAtTime(0, at + 0.05);
      for (const s of p.sources) stopSafely(s, at + 0.08);
    }
    this.voices = [];
    this.parts = [];
    this.seg = null;
  }

  private render(seg: TalkSegment, t0: number): void {
    const end = t0 + seg.dur;
    const voice = (plan: Syllable[], start: number, level: number) =>
      this.voices.push(new FormantVoice(this.ctx, this.out, this.noise, plan, start, { highpass: 200, lowpass: 4000, level }, this.tally, 'talk'));
    switch (seg.kind) {
      case 'host': {
        voice(speechPlan(seg.seed, seg.dur - 0.3, HOST_VOICE), t0 + 0.1, HOST_LEVEL);
        this.pad(seg.seed, t0, end, 'sine', 1100, HOST_BED, 0);
        break;
      }
      case 'ad': {
        voice(speechPlan(seg.seed, seg.dur - 0.6, AD_VOICE), t0 + 0.2, AD_LEVEL);
        this.pad(seg.seed, t0, end, 'square', 1400, AD_BED, 6);
        break;
      }
      case 'jingle':
        this.jingle(seg.seed, t0, voice);
        break;
      case 'gap':
        break;
    }
  }

  private source(osc: OscillatorNode, start: number, end: number): void {
    this.tally?.track('talk', osc);
    osc.start(Math.max(this.ctx.currentTime, start));
    osc.stop(Math.max(this.ctx.currentTime, end) + 0.05);
  }

  /**
   * A three-note pad changing chord every 4 s, faded in and out at the segment's ends. `tremolo` (Hz) pulses it
   * (the ad bed's bounce).
   */
  private pad(seed: number, t0: number, end: number, type: OscillatorType, cutoff: number, level: number, tremolo: number): void {
    const ctx = this.ctx;
    const r = new Rng(seed ^ 0x5bd1e995);
    const root = 50 + r.int(0, 7);
    const chords = [
      [0, 3, 7],
      [-4, 0, 3],
      [-2, 2, 5],
      [-5, -1, 2],
    ];
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = withinParam(lp.frequency, cutoff);
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const a = Math.max(now, t0);
    gain.gain.value = 0;
    gain.gain.setValueAtTime(0, a);
    gain.gain.linearRampToValueAtTime(level, a + PAD_FADE);
    gain.gain.setValueAtTime(level, Math.max(a + PAD_FADE, end - PAD_FADE));
    gain.gain.linearRampToValueAtTime(0, Math.max(a + 2 * PAD_FADE, end));
    const sources: AudioScheduledSourceNode[] = [];
    if (tremolo > 0) {
      const trem = ctx.createGain();
      trem.gain.value = TREMOLO_BASE;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = tremolo;
      const depth = ctx.createGain();
      depth.gain.value = TREMOLO_DEPTH;
      lfo.connect(depth);
      depth.connect(trem.gain);
      lp.connect(trem);
      trem.connect(gain);
      this.source(lfo, a, end);
      sources.push(lfo);
    } else lp.connect(gain);
    gain.connect(this.out);
    const order = r.shuffle([0, 1, 2, 3]);
    for (let v = 0; v < 3; v++) {
      const o = ctx.createOscillator();
      o.type = type;
      for (let i = 0, t = t0; t < end; i++, t += 4) {
        const f = midi(root + chords[order[i % 4]!]![v]! + 12);
        o.frequency.setValueAtTime(f, Math.max(now, t));
      }
      const g = ctx.createGain();
      g.gain.value = 1 / 3;
      o.connect(g);
      g.connect(lp);
      this.source(o, a, end);
      sources.push(o);
    }
    this.parts.push({ gain, sources });
  }

  /** "A-zu-ra Talk": four sung syllables over bell notes, then a bell chord. */
  private jingle(seed: number, t0: number, voice: (plan: Syllable[], start: number, level: number) => void): void {
    const ctx = this.ctx;
    const r = new Rng(seed);
    const root = 60 + r.int(0, 4);
    const melody = [0, 4, 7, 12];
    const vowels: ReadonlyArray<readonly [number, number, number]> = [
      [730, 1090, 2440],
      [300, 870, 2240],
      [730, 1090, 2440],
      [570, 840, 2410],
    ];
    const plan: Syllable[] = melody.map((m, i) => {
      const v = vowels[i]!;
      const k = 1.1;
      return { t: i * 0.42, dur: i === 3 ? 1.2 : 0.4, f1: v[0] * k, f2: v[1] * k, f3: v[2] * k, pitch: midi(root + m - 12), amp: 1, onset: i === 1 ? 'fric' : i === 3 ? 'stop' : 'none' };
    });
    voice(plan, t0 + JINGLE_LEAD, JINGLE_VOICE_LEVEL);
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(this.out);
    const sources: AudioScheduledSourceNode[] = [];
    const now = ctx.currentTime;
    const bell = (b: Bell) => {
      // A segment is rendered on the first frame it is current, a little after its start: a bell that late still rings from now
      // (otherwise the opening of the jingle would be silent); a bell long past is part of what tuning in mid-jingle missed.
      if (now - (t0 + b.t) > LATE_BELL) return;
      const t = Math.max(now, t0 + b.t);
      for (const [mul, k] of [
        [1, 1],
        [2.76, 0.35],
      ] as const) {
        const o = ctx.createOscillator();
        o.frequency.value = midi(root + b.m) * mul;
        const g = ctx.createGain();
        g.gain.value = 0;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(b.level * k, t + 0.005);
        g.gain.exponentialRampToValueAtTime(b.floor * k, t + b.dur);
        g.gain.linearRampToValueAtTime(0, t + b.dur + BELL_FADE);
        o.connect(g);
        g.connect(gain);
        this.source(o, t, t + b.dur + BELL_FADE + 0.01);
        sources.push(o);
      }
    };
    for (const b of jingleBells()) bell(b);
    this.parts.push({ gain, sources });
  }
}
