// The talk station: a seeded, endless programme of Chet Bramble's show (his monologues, callers, the newsdesk and the
// traffic), station idents over a jingle and ad breaks, with short gaps of dead air between segments. Every piece is a
// recorded clip (src/sim/speech.ts). The programme runs on its own clock like a live broadcast: tuning in lands
// mid-segment. TalkProgramme is pure (the schedule); TalkShow plays the current segment's clip over a soft bed.

import { Rng } from '../core/rng';
import { SPEECH, type TalkKind as PieceKind } from '../sim/speech';
import { withinParam } from './mixer';
import { playClip, SpeechBank } from './speech';
import type { NodeTally } from './tally';

export type TalkKind = 'host' | 'jingle' | 'ad' | 'gap';

export interface TalkSegment {
  kind: TalkKind;
  /** Seconds from the start of the programme. */
  start: number;
  dur: number;
  /** Seeds the segment's bed. */
  seed: number;
  /** The recorded piece it plays ('' for a gap). */
  clip: string;
}

/** Seconds of bed before the voice of a host or ad segment starts, and after it ends. */
export const HOST_LEAD = 0.15;
export const HOST_TAIL = 0.35;
export const AD_LEAD = 0.25;
export const AD_TAIL = 0.45;
export const GAP_LEN: readonly [number, number] = [0.5, 0.8];
/** Seconds into the jingle its first bell starts. */
export const JINGLE_LEAD = 0.01;
/** The closing chord starts this long after JINGLE_LEAD, on the beat after the last melody note while that note is still ringing, and rings to the jingle's end. */
export const CHORD_AT = 1.68;
/** The ident's voice starts on the closing chord; the chord rings on under it to JINGLE_TAIL after it. */
export const IDENT_AT = JINGLE_LEAD + CHORD_AT;
export const JINGLE_TAIL = 0.3;

/** Seconds of a clip. */
const clipLen = (id: string) => SPEECH.clips[id]!;

/** What the show plays between breaks: Chet alone, a caller, the newsdesk or the traffic. */
const SHOW: readonly PieceKind[] = ['host', 'call', 'news'];

/** Draws the pieces of a pool in a seeded order, all of them before any comes round again, never the same twice running. */
class Bag {
  private left: string[] = [];
  private last = '';

  constructor(
    private readonly pool: readonly string[],
    private readonly rng: Rng,
  ) {}

  next(): string {
    if (this.left.length === 0) {
      this.left = this.rng.shuffle([...this.pool]);
      if (this.left.length > 1 && this.left[this.left.length - 1] === this.last) this.left.unshift(this.left.pop()!);
    }
    this.last = this.left.pop()!;
    return this.last;
  }
}

/**
 * The schedule, generated in blocks as far as it is asked for. The first break is always an ad break, so every
 * stretch of a few minutes has the show, idents and ads.
 */
export class TalkProgramme {
  readonly segments: TalkSegment[] = [];
  private readonly rng: Rng;
  private readonly show: Bag;
  private readonly ads: Bag;
  private readonly idents: Bag;
  private end = 0;
  private breaks = 0;

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.show = new Bag(SHOW.flatMap((k) => SPEECH.talk[k]), this.rng);
    this.ads = new Bag(SPEECH.talk.ad, this.rng);
    this.idents = new Bag(SPEECH.talk.ident, this.rng);
    this.jingle();
    this.gap();
    this.host();
  }

  private push(kind: TalkKind, dur: number, clip: string): void {
    this.segments.push({ kind, start: this.end, dur, seed: (this.rng.next() * 0xffffffff) >>> 0, clip });
    this.end += dur;
  }

  private gap(): void {
    this.push('gap', this.rng.range(GAP_LEN[0], GAP_LEN[1]), '');
  }

  private jingle(): void {
    const clip = this.idents.next();
    this.push('jingle', IDENT_AT + clipLen(clip) + JINGLE_TAIL, clip);
  }

  private host(): void {
    const clip = this.show.next();
    this.push('host', HOST_LEAD + clipLen(clip) + HOST_TAIL, clip);
    this.gap();
  }

  private block(): void {
    const r = this.rng;
    if (this.breaks++ === 0 || r.chance(0.6)) {
      const ads = r.chance(0.5) ? 2 : 1;
      for (let i = 0; i < ads; i++) {
        const clip = this.ads.next();
        this.push('ad', AD_LEAD + clipLen(clip) + AD_TAIL, clip);
        this.gap();
      }
    }
    this.jingle();
    this.gap();
    this.host();
  }

  /** The segment playing `t` seconds into the programme. */
  at(t: number): TalkSegment {
    const x = Math.max(0, t);
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
const IDENT_LEVEL = 0.46;
/** The soft pad under the host: keeps the air from going dead between phrases, about 18 dB under the voice. */
const HOST_BED = 0.05;
const AD_BED = 0.05;

/** Seconds a pad takes to fade in and out: the segment is audible from its first sample to its last. */
export const PAD_FADE = 0.01;
/** The pad's tremolo is gain = TREMOLO_BASE + TREMOLO_DEPTH * lfo, which never drops under TREMOLO_BASE - TREMOLO_DEPTH. */
export const TREMOLO_BASE = 0.75;
export const TREMOLO_DEPTH = 0.25;
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

/** The bells of a jingle `dur` seconds long: four melody notes and the closing chord, which rings to its end under the ident. */
export function jingleBells(dur: number): Bell[] {
  const bells: Bell[] = [];
  [0, 4, 7, 12].forEach((m, i) => bells.push({ t: JINGLE_LEAD + i * 0.42, m: m + 12, dur: 0.6, level: 0.12, floor: BELL_FLOOR }));
  const t = JINGLE_LEAD + CHORD_AT;
  for (const m of [0, 4, 7]) bells.push({ t, m: m + 12, dur: dur - t - BELL_FADE - 0.005, level: 0.07, floor: BELL_FLOOR });
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

/** Plays the programme's current segment. */
export class TalkShow {
  private seg: TalkSegment | null = null;
  private parts: Part[] = [];
  private readonly bank: SpeechBank;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly tally?: NodeTally,
  ) {
    this.bank = new SpeechBank(ctx);
  }

  /** The segment being played (null when stopped). */
  get segment(): TalkSegment | null {
    return this.seg;
  }

  /** Plays `seg`, which started at context time `t0`. */
  update(seg: TalkSegment, t0: number): void {
    if (seg === this.seg) return;
    this.stop(this.ctx.currentTime);
    this.seg = seg;
    this.render(seg, t0);
  }

  /** Starts loading the clip of a segment coming up, so it plays from its first word. */
  preload(seg: TalkSegment): void {
    if (seg.clip) this.bank.preload([seg.clip]);
  }

  /** Stops whatever plays, fading over 50 ms from `t` (or now). */
  stop(t: number): void {
    const at = Math.max(this.ctx.currentTime, t);
    for (const p of this.parts) {
      const g = p.gain.gain;
      g.cancelScheduledValues(at);
      g.setValueAtTime(g.value, at);
      g.linearRampToValueAtTime(0, at + 0.05);
      for (const s of p.sources) s.stop(at + 0.08);
    }
    this.parts = [];
    this.seg = null;
  }

  private render(seg: TalkSegment, t0: number): void {
    const end = t0 + seg.dur;
    switch (seg.kind) {
      case 'host':
        this.voice(seg, t0 + HOST_LEAD, HOST_LEVEL);
        this.pad(seg.seed, t0, end, 'sine', 1100, HOST_BED, 0);
        break;
      case 'ad':
        this.voice(seg, t0 + AD_LEAD, AD_LEVEL);
        this.pad(seg.seed, t0, end, 'square', 1400, AD_BED, 6);
        break;
      case 'jingle':
        this.jingle(seg.seed, t0, seg.dur);
        this.voice(seg, t0 + IDENT_AT, IDENT_LEVEL);
        break;
      case 'gap':
        break;
    }
  }

  /** The segment's clip from context time `at` (tuning in joins it where the broadcast is), while it is on. */
  private voice(seg: TalkSegment, at: number, level: number): void {
    void playClip({ ctx: this.ctx, bank: this.bank, id: seg.clip, dest: this.out, at, level, still: () => this.seg === seg, tally: this.tally, kind: 'talk' }).then((p) => {
      if (p) this.parts.push({ gain: p.gain, sources: [p.src] });
    });
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

  /** The jingle's bells: four rising notes, then a chord that rings under the ident to the segment's end. */
  private jingle(seed: number, t0: number, dur: number): void {
    const ctx = this.ctx;
    const root = 60 + new Rng(seed).int(0, 4);
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
    for (const b of jingleBells(dur)) bell(b);
    this.parts.push({ gain, sources });
  }
}
