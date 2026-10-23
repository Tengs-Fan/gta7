// A procedural formant voice: a sawtooth glottal source and a noise source through three parallel band-pass
// formant filters whose centres glide between vowel targets, one syllable at a time. The words are gibberish with
// speech rhythm (syllables, words, phrases, falling intonation): talk-radio hosts, ad reads and police barks.
//
//   saw osc -> voicing gain -+-> F1 band-pass -> g1 -+
//                            +-> F2 band-pass -> g2 -+
//                            +-> F3 band-pass -> g3 -+-> high-pass -> low-pass -> out
//   noise   -> band-pass -> fricative gain ----------+
//
// The plan (speechPlan) is pure and seeded; FormantVoice schedules it a little ahead of the clock.

import { Rng } from '../core/rng';
import { withinParam } from './mixer';
import type { NodeTally } from './tally';

/** Male vowel formants (Hz): a, e, i, o, u, schwa, ae. */
const VOWELS: ReadonlyArray<readonly [number, number, number]> = [
  [730, 1090, 2440],
  [530, 1840, 2480],
  [270, 2290, 3010],
  [570, 840, 2410],
  [300, 870, 2240],
  [500, 1500, 2500],
  [660, 1720, 2410],
];

export type Onset = 'none' | 'stop' | 'fric' | 'nasal';

export interface Syllable {
  /** Seconds from the start of the plan. */
  t: number;
  dur: number;
  f1: number;
  f2: number;
  f3: number;
  /** Fundamental (Hz) at the syllable's centre. */
  pitch: number;
  /** Peak voicing level, 0..1. */
  amp: number;
  onset: Onset;
}

export interface VoiceStyle {
  /** Mean fundamental, Hz. */
  pitch: number;
  /** Formant scale over the male table (a higher, smaller voice > 1). */
  formants: number;
  /** Syllables per second. */
  rate: number;
  /** Intonation swing as a fraction of the pitch. */
  swing: number;
  /** Words per phrase. */
  words: readonly [number, number];
  /** Pause between phrases, seconds. */
  pause: readonly [number, number];
}

export const HOST_VOICE: VoiceStyle = { pitch: 108, formants: 1, rate: 5, swing: 0.22, words: [4, 9], pause: [0.22, 0.42] };
export const AD_VOICE: VoiceStyle = { pitch: 178, formants: 1.14, rate: 6.4, swing: 0.34, words: [3, 7], pause: [0.16, 0.3] };
export const COP_VOICE: VoiceStyle = { pitch: 122, formants: 1, rate: 6.8, swing: 0.1, words: [3, 6], pause: [0.12, 0.2] };

/** A 32-bit hash of a string (FNV-1a): seeds a bark from its text. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Syllables filling `seconds` of speech in `style`, seeded. Phrases of a few words with a short pause between, a
 * falling pitch over each phrase (some rise at the end, like a question) and a stressed syllable per word.
 * The last syllable ends by `seconds`.
 */
export function speechPlan(seed: number, seconds: number, style: VoiceStyle): Syllable[] {
  const r = new Rng(seed);
  const out: Syllable[] = [];
  const syl = 1 / style.rate;
  let t = 0;
  while (t < seconds - syl) {
    const words = r.int(style.words[0], style.words[1]);
    const question = r.chance(0.2);
    const phrase: Syllable[] = [];
    for (let w = 0; w < words && t < seconds - syl; w++) {
      const n = r.weighted<number>([
        [1, 4],
        [2, 4],
        [3, 2],
      ]);
      const stress = r.int(0, n - 1);
      for (let s = 0; s < n && t < seconds - syl; s++) {
        const dur = Math.min(seconds - t, syl * r.range(0.75, 1.3) * (s === stress ? 1.2 : 1));
        const v = VOWELS[r.int(0, VOWELS.length - 1)]!;
        const k = style.formants * r.range(0.96, 1.04);
        phrase.push({
          t,
          dur,
          f1: v[0] * k,
          f2: v[1] * k,
          f3: v[2] * k,
          pitch: style.pitch,
          amp: s === stress ? 1 : r.range(0.62, 0.8),
          onset: r.weighted<Onset>([
            ['none', 3],
            ['stop', 3],
            ['fric', 2],
            ['nasal', 2],
          ]),
        });
        t += dur;
      }
      t += r.range(0.03, 0.08);
    }
    // Intonation: declination over the phrase, stressed syllables a little higher.
    const n = phrase.length;
    for (let i = 0; i < n; i++) {
      const s = phrase[i]!;
      const x = n > 1 ? i / (n - 1) : 0;
      let k = 1 + style.swing * (0.5 - x) + (s.amp >= 1 ? style.swing * 0.35 : 0);
      if (question && i >= n - 2) k += style.swing * (i === n - 1 ? 1.2 : 0.5);
      s.pitch = style.pitch * k;
    }
    out.push(...phrase);
    t += r.range(style.pause[0], style.pause[1]);
  }
  return out;
}

/** Total seconds the plan voices (syllable durations). */
export function voicedSeconds(plan: readonly Syllable[]): number {
  let s = 0;
  for (const x of plan) s += x.dur;
  return s;
}

export interface VoiceOptions {
  /** Output band: high-pass and low-pass corners (Hz). */
  highpass: number;
  lowpass: number;
  /** Output level. */
  level: number;
}

/**
 * Speaks a plan through one set of nodes (two sources), scheduling each syllable shortly before it is due.
 * Every syllable ends at zero voicing, so if scheduling stops (a stalled tab) the voice falls silent instead of holding a vowel.
 */
export class FormantVoice {
  private readonly osc: OscillatorNode;
  private readonly src: AudioBufferSourceNode;
  private readonly voicing: GainNode;
  private readonly fric: GainNode;
  private readonly fricBand: BiquadFilterNode;
  private readonly formants: BiquadFilterNode[] = [];
  readonly out: GainNode;
  private next = 0;
  private stopped = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    dest: AudioNode,
    noise: AudioBuffer,
    private readonly plan: readonly Syllable[],
    /** Context time of the plan's t = 0. */
    private readonly t0: number,
    opts: VoiceOptions,
    tally?: NodeTally,
    tag = 'voice',
  ) {
    const start = Math.max(ctx.currentTime, t0);
    this.out = ctx.createGain();
    this.out.gain.value = opts.level;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = withinParam(hp.frequency, opts.highpass);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = withinParam(lp.frequency, opts.lowpass);
    hp.connect(lp);
    lp.connect(this.out);
    this.out.connect(dest);

    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = plan[0]?.pitch ?? 120;
    this.voicing = ctx.createGain();
    this.voicing.gain.value = 0;
    this.osc.connect(this.voicing);
    // Q from typical formant bandwidths (about 80, 100 and 140 Hz); higher formants are weaker.
    const shape: ReadonlyArray<readonly [number, number, number]> = [
      [600, 7, 1.0],
      [1500, 11, 0.55],
      [2500, 14, 0.32],
    ];
    for (const [f, q, g] of shape) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = withinParam(bp.frequency, f);
      bp.Q.value = q;
      const gain = ctx.createGain();
      // Band-pass peaks are unity: make up for the sawtooth's falling harmonics.
      gain.gain.value = g * 3.2;
      this.voicing.connect(bp);
      bp.connect(gain);
      gain.connect(hp);
      this.formants.push(bp);
    }
    this.src = ctx.createBufferSource();
    this.src.buffer = noise;
    this.src.loop = true;
    this.fricBand = ctx.createBiquadFilter();
    this.fricBand.type = 'bandpass';
    this.fricBand.frequency.value = withinParam(this.fricBand.frequency, 2600);
    this.fricBand.Q.value = 1.4;
    this.fric = ctx.createGain();
    this.fric.gain.value = 0;
    this.src.connect(this.fricBand);
    this.fricBand.connect(this.fric);
    this.fric.connect(hp);

    this.voicing.gain.setValueAtTime(0, ctx.currentTime);
    this.fric.gain.setValueAtTime(0, ctx.currentTime);
    tally?.track(tag, this.osc);
    tally?.track(tag, this.src);
    this.osc.start(start);
    this.src.start(start, Math.random() * 1.5);
    // Skip what is already past (tuning in mid-segment).
    while (this.next < plan.length && t0 + plan[this.next]!.t < ctx.currentTime + 0.01) this.next++;
  }

  /** Context time the plan ends. */
  get end(): number {
    const last = this.plan[this.plan.length - 1];
    return this.t0 + (last ? last.t + last.dur : 0);
  }

  /** Schedules every syllable that starts before `until` (context time). */
  schedule(until: number): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    while (this.next < this.plan.length) {
      const s = this.plan[this.next]!;
      const ts = this.t0 + s.t;
      if (ts >= until) break;
      this.next++;
      if (ts < now) continue;
      this.syllable(s, ts);
    }
  }

  private syllable(s: Syllable, ts: number): void {
    const d = s.dur;
    const att = Math.min(0.03, d * 0.25);
    const rel = Math.min(0.04, d * 0.3);
    const onsetLen = s.onset === 'none' ? 0 : Math.min(0.045, d * 0.3);
    const v = this.voicing.gain;
    const vs = ts + (s.onset === 'stop' || s.onset === 'fric' ? onsetLen : 0);
    v.setValueAtTime(0, ts);
    if (s.onset === 'nasal') {
      v.linearRampToValueAtTime(s.amp * 0.3, ts + onsetLen * 0.5);
      v.setValueAtTime(s.amp * 0.3, ts + onsetLen);
    } else v.setValueAtTime(0, vs);
    v.linearRampToValueAtTime(s.amp, vs + att);
    v.linearRampToValueAtTime(s.amp * 0.75, ts + d - rel);
    v.linearRampToValueAtTime(0, ts + d);
    const f = this.fric.gain;
    if (s.onset === 'fric' || s.onset === 'stop') {
      const peak = s.onset === 'fric' ? 0.22 : 0.4;
      const len = s.onset === 'fric' ? onsetLen : Math.min(0.015, onsetLen);
      f.setValueAtTime(0, ts);
      f.linearRampToValueAtTime(peak * s.amp, ts + Math.min(0.006, len * 0.4));
      f.linearRampToValueAtTime(0, ts + len);
      this.fricBand.frequency.setValueAtTime(withinParam(this.fricBand.frequency, s.onset === 'fric' ? 3000 : 1700), ts);
    }
    // Formants glide to the vowel over the onset; the pitch to its value at the syllable's centre.
    const glide = Math.min(0.06, d * 0.4);
    const targets = [s.f1, s.f2, s.f3];
    for (let i = 0; i < 3; i++) {
      const p = this.formants[i]!.frequency;
      const hz = withinParam(p, targets[i]!);
      p.linearRampToValueAtTime(hz, ts + glide);
      p.setValueAtTime(hz, ts + d);
    }
    this.osc.frequency.linearRampToValueAtTime(s.pitch, ts + d * 0.5);
  }

  /** Fades out and stops at context time `t` (at once if it is past). */
  stop(t: number): void {
    if (this.stopped) return;
    this.stopped = true;
    const at = Math.max(this.ctx.currentTime, t);
    const g = this.out.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    g.linearRampToValueAtTime(0, at + 0.05);
    this.osc.stop(at + 0.08);
    this.src.stop(at + 0.08);
  }
}
