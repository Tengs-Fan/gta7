// The talk stations: each a seeded, endless programme of its show (AZURA TALK's Chet Bramble with his callers, the
// newsdesk and the traffic; THE BOWL's Big Ron Tackett with his), station idents over a jingle and ad breaks, with short
// gaps of dead air between segments. Every piece is a recorded clip (src/sim/speech.ts). A TalkFormat makes a station
// sound like itself: the order of its show, its beds, its jingle's motif and, on AM, a narrow band. Every programme runs
// on its own clock like a live broadcast: tuning in lands mid-segment. TalkProgramme is pure (the schedule); TalkShow
// plays the current segment's clip over a soft bed.

import { Rng } from '../core/rng';
import { SPEECH, type ShowId, type TalkKind as PieceKind } from '../sim/speech';
import { withinParam } from './mixer';
import { playClip, SpeechBank } from './speech';
import type { NodeTally } from './tally';

export type TalkKind = 'host' | 'jingle' | 'ad' | 'gap' | 'desk';

export interface TalkSegment {
  kind: TalkKind;
  /** Seconds from the start of the programme. */
  start: number;
  dur: number;
  /** Seeds the segment's bed. */
  seed: number;
  /** The recorded piece it plays ('' for a gap or a desk). */
  clip: string;
  /** A desk's bulletin: the clips it reads in order. */
  clips?: readonly string[];
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
/** A desk: its sting rings this long before the first sentence; its sentences are this far apart (build.ts PAUSE_SAME); its bed runs on this long after the last. */
export const DESK_LEAD = 1.0;
export const DESK_PAUSE = 0.35;
export const DESK_TAIL = 0.4;

/** Seconds of a clip. */
const clipLen = (id: string) => SPEECH.clips[id]!;

/** The clips a segment plays (none for a gap). */
const clipsOf = (seg: TalkSegment | null): readonly string[] => (!seg ? [] : (seg.clips ?? (seg.clip ? [seg.clip] : [])));

/** Draws the pieces of a pool in a seeded order, all of them before any comes round again, never the same twice running. */
export class Bag {
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

/** A bed under a segment's voice: a three-note pad, optionally over a band of noise that swells and falls (a crowd). */
export interface Bed {
  type: OscillatorType;
  /** The pad's low-pass (Hz). */
  cutoff: number;
  level: number;
  /** Hz of the pad's tremolo (0: none). */
  tremolo: number;
  /** The radio's noise through a band-pass at `hz` and `q`, its gain swelling between a fifth and all of `level` at `swell` Hz. */
  noise?: { hz: number; q: number; level: number; swell: number };
}

/**
 * How a talk station sounds. Its show plays `slots` in turn, one per block: block n's piece is drawn from the pieces of
 * the kinds of slots[n % slots.length]. Slots of the same kinds draw from one Bag, so a show piece still airs only once
 * every piece of its kinds has. A break of ads comes before a block's ident with `adChance` (always before the first).
 * `bells` is the jingle's motif (semitones), `am` puts the station on the AM band (radio.ts).
 */
export interface TalkFormat {
  show: ShowId;
  slots: readonly (readonly PieceKind[])[];
  adChance: number;
  bed: Bed;
  adBed: Bed;
  bells: readonly number[];
  am?: boolean;
}

/** Levels at the station output (before the radio's own output gain). */
const HOST_LEVEL = 0.5;
const AD_LEVEL = 0.46;
const IDENT_LEVEL = 0.46;
/** The soft pad under the host: keeps the air from going dead between phrases, about 18 dB under the voice. */
const HOST_BED = 0.05;
const AD_BED = 0.05;

/** AZURA TALK: Chet alone, a caller, the newsdesk or the traffic in any order, over a soft sine pad; ads bounce on a square one. */
export const AZURA_FORMAT: TalkFormat = {
  show: 'azura',
  slots: [['host', 'call', 'news']],
  adChance: 0.6,
  bed: { type: 'sine', cutoff: 1100, level: HOST_BED, tremolo: 0 },
  adBed: { type: 'square', cutoff: 1400, level: AD_BED, tremolo: 6 },
  bells: [0, 4, 7, 12],
};

/** Seconds of a desk reading `clips`: the sting, the sentences with their pauses, and the tail. */
export function deskLength(clips: readonly string[]): number {
  return DESK_LEAD + clips.reduce((s, id) => s + clipLen(id), 0) + DESK_PAUSE * (clips.length - 1) + DESK_TAIL;
}

/**
 * The schedule, generated in blocks as far as it is asked for. The first break is always an ad break, so every
 * stretch of a few minutes has the show, idents and ads.
 */
export class TalkProgramme {
  readonly segments: TalkSegment[] = [];
  private readonly rng: Rng;
  /** The Bag of each slot. */
  private readonly slots: Bag[];
  private readonly ads: Bag;
  private readonly idents: Bag;
  /** How many times each campaign has aired, by its first part. */
  private readonly aired = new Map<string, number>();
  private end = 0;
  private breaks = 0;
  private blocks = 0;

  constructor(
    seed: number,
    readonly format: TalkFormat = AZURA_FORMAT,
  ) {
    this.rng = new Rng(seed);
    const pools = SPEECH.talk[format.show];
    const bags = new Map<string, Bag>();
    this.slots = format.slots.map((kinds) => {
      const key = kinds.join();
      if (!bags.has(key)) bags.set(key, new Bag(kinds.flatMap((k) => pools[k]), this.rng));
      return bags.get(key)!;
    });
    this.ads = new Bag(pools.ad, this.rng);
    this.idents = new Bag(pools.ident, this.rng);
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
    const clip = this.slots[this.blocks++ % this.slots.length]!.next();
    this.push('host', HOST_LEAD + clipLen(clip) + HOST_TAIL, clip);
    this.gap();
  }

  /** An ad from the break's Bag; a campaign plays its next part each time it comes up. */
  private ad(): void {
    let clip = this.ads.next();
    const parts = SPEECH.adSeries[clip];
    if (parts) {
      const n = this.aired.get(clip) ?? 0;
      this.aired.set(clip, n + 1);
      clip = parts[n % parts.length]!;
    }
    this.push('ad', AD_LEAD + clipLen(clip) + AD_TAIL, clip);
    this.gap();
  }

  private block(): void {
    const r = this.rng;
    if (this.breaks++ === 0 || r.chance(this.format.adChance)) {
      const ads = r.chance(0.5) ? 2 : 1;
      for (let i = 0; i < ads; i++) this.ad();
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

  /**
   * Breaks into the programme after the gap segments[i] with a desk reading `clips`, then a gap, and moves everything
   * after it back by their length (the newsdesk's bulletins). Draws nothing from the programme's rng, so the rest of the
   * schedule is the same as without it. Returns the desk.
   */
  splice(i: number, clips: readonly string[]): TalkSegment {
    const after = this.segments[i]!;
    const start = after.start + after.dur;
    const desk: TalkSegment = { kind: 'desk', start, dur: deskLength(clips), seed: (after.seed ^ 0x2545f491) >>> 0, clip: '', clips };
    const gap: TalkSegment = { kind: 'gap', start: start + desk.dur, dur: GAP_LEN[0], seed: (after.seed ^ 0x68e31da4) >>> 0, clip: '' };
    const shift = desk.dur + gap.dur;
    for (let k = i + 1; k < this.segments.length; k++) this.segments[k]!.start += shift;
    this.segments.splice(i + 1, 0, desk, gap);
    this.end += shift;
    return desk;
  }
}

export function talkProgramme(seed: number, seconds: number, format = AZURA_FORMAT): TalkSegment[] {
  return new TalkProgramme(seed, format).until(seconds);
}

function midi(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

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

/**
 * The bells of a jingle `dur` seconds long: the motif's notes spread evenly up to the closing chord, which rings to its
 * end under the ident.
 */
export function jingleBells(dur: number, motif: readonly number[] = [0, 4, 7, 12]): Bell[] {
  const bells: Bell[] = [];
  const step = CHORD_AT / motif.length;
  motif.forEach((m, i) => bells.push({ t: JINGLE_LEAD + i * step, m: m + 12, dur: 0.6, level: 0.12, floor: BELL_FLOOR }));
  const t = JINGLE_LEAD + CHORD_AT;
  for (const m of [0, 4, 7]) bells.push({ t, m: m + 12, dur: dur - t - BELL_FADE - 0.005, level: 0.07, floor: BELL_FLOOR });
  return bells;
}

/** The desk's sting: the first three notes of the station's motif, quick, ringing out before the first sentence. */
export function stingBells(motif: readonly number[]): Bell[] {
  return motif.slice(0, 3).map((m, i) => ({ t: JINGLE_LEAD + i * 0.16, m: m + 12, dur: 0.6, level: 0.12, floor: BELL_FLOOR }));
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

/**
 * Plays the current segment of whichever talk station is tuned. Decoded speech is about 11.5 MB a minute at 48 kHz, so
 * it holds only the clips of the segment on air and of the one preloaded next.
 */
export class TalkShow {
  private seg: TalkSegment | null = null;
  private next: TalkSegment | null = null;
  private parts: Part[] = [];
  private readonly bank: SpeechBank;
  /** Every clip it has asked the bank for. */
  private readonly asked = new Set<string>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly noise: AudioBuffer,
    private readonly tally?: NodeTally,
  ) {
    this.bank = new SpeechBank(ctx);
  }

  /** The segment being played (null when stopped). */
  get segment(): TalkSegment | null {
    return this.seg;
  }

  /** Plays `seg` of a programme of `format`, which started at context time `t0`. */
  update(seg: TalkSegment, t0: number, format: TalkFormat): void {
    if (seg === this.seg) return;
    this.stop(this.ctx.currentTime);
    this.seg = seg;
    this.hold();
    this.render(seg, t0, format);
  }

  /** Starts loading the clips of a segment coming up, so it plays from its first word. */
  preload(seg: TalkSegment): void {
    if (seg === this.next) return;
    this.next = seg;
    this.hold();
    this.ask(clipsOf(seg));
    this.bank.preload(clipsOf(seg));
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

  private ask(ids: readonly string[]): void {
    for (const id of ids) this.asked.add(id);
  }

  /** Forgets every decoded clip but those of the segment on air and the next one (one that loaded late included). */
  private hold(): void {
    const keep = new Set([...clipsOf(this.seg), ...clipsOf(this.next)]);
    for (const id of this.asked) if (!keep.has(id)) this.bank.forget(id);
  }

  private render(seg: TalkSegment, t0: number, format: TalkFormat): void {
    const end = t0 + seg.dur;
    switch (seg.kind) {
      case 'host':
        this.voice(seg, seg.clip, t0 + HOST_LEAD, HOST_LEVEL);
        this.pad(seg.seed, t0, end, format.bed);
        break;
      case 'ad':
        this.voice(seg, seg.clip, t0 + AD_LEAD, AD_LEVEL);
        this.pad(seg.seed, t0, end, format.adBed);
        break;
      case 'jingle':
        this.bells(seg.seed, t0, jingleBells(seg.dur, format.bells));
        this.voice(seg, seg.clip, t0 + IDENT_AT, IDENT_LEVEL);
        break;
      case 'desk': {
        this.bells(seg.seed, t0, stingBells(format.bells));
        let at = t0 + DESK_LEAD;
        for (const id of seg.clips!) {
          this.voice(seg, id, at, HOST_LEVEL);
          at += clipLen(id) + DESK_PAUSE;
        }
        this.pad(seg.seed, t0, end, format.bed);
        break;
      }
      case 'gap':
        break;
    }
  }

  /** Clip `id` of the segment from context time `at` (tuning in joins it where the broadcast is), while it is on. */
  private voice(seg: TalkSegment, id: string, at: number, level: number): void {
    this.ask([id]);
    void playClip({ ctx: this.ctx, bank: this.bank, id, dest: this.out, at, level, still: () => this.seg === seg, tally: this.tally, kind: 'talk' }).then((p) => {
      if (p) this.parts.push({ gain: p.gain, sources: [p.src] });
    });
  }

  private source(src: AudioScheduledSourceNode, start: number, end: number): void {
    this.tally?.track('talk', src);
    src.start(Math.max(this.ctx.currentTime, start));
    src.stop(Math.max(this.ctx.currentTime, end) + 0.05);
  }

  /**
   * The bed: a three-note pad changing chord every 4 s and, on some stations, a band of noise swelling under it, faded
   * in and out at the segment's ends. The tremolo pulses the pad (the ad bed's bounce).
   */
  private pad(seed: number, t0: number, end: number, bed: Bed): void {
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
    lp.frequency.value = withinParam(lp.frequency, bed.cutoff);
    const level = ctx.createGain();
    level.gain.value = bed.level;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const a = Math.max(now, t0);
    gain.gain.value = 0;
    gain.gain.setValueAtTime(0, a);
    gain.gain.linearRampToValueAtTime(1, a + PAD_FADE);
    gain.gain.setValueAtTime(1, Math.max(a + PAD_FADE, end - PAD_FADE));
    gain.gain.linearRampToValueAtTime(0, Math.max(a + 2 * PAD_FADE, end));
    level.connect(gain);
    const sources: AudioScheduledSourceNode[] = [];
    if (bed.tremolo > 0) {
      const trem = ctx.createGain();
      trem.gain.value = TREMOLO_BASE;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = bed.tremolo;
      const depth = ctx.createGain();
      depth.gain.value = TREMOLO_DEPTH;
      lfo.connect(depth);
      depth.connect(trem.gain);
      lp.connect(trem);
      trem.connect(level);
      this.source(lfo, a, end);
      sources.push(lfo);
    } else lp.connect(level);
    gain.connect(this.out);
    const order = r.shuffle([0, 1, 2, 3]);
    for (let v = 0; v < 3; v++) {
      const o = ctx.createOscillator();
      o.type = bed.type;
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
    if (bed.noise) {
      const n = bed.noise;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = n.hz;
      bp.Q.value = n.q;
      const swell = ctx.createGain();
      swell.gain.value = n.level * 0.6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = n.swell;
      const depth = ctx.createGain();
      depth.gain.value = n.level * 0.4;
      lfo.connect(depth);
      depth.connect(swell.gain);
      src.connect(bp);
      bp.connect(swell);
      swell.connect(gain);
      this.source(src, a, end);
      this.source(lfo, a, end);
      sources.push(src, lfo);
    }
    this.parts.push({ gain, sources });
  }

  /** Bells rung from `t0`: a jingle's rising notes and the chord that rings under the ident, or a desk's sting. */
  private bells(seed: number, t0: number, bells: readonly Bell[]): void {
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
    for (const b of bells) bell(b);
    this.parts.push({ gain, sources });
  }
}
