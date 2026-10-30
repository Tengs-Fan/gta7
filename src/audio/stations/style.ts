// What a music station's style is: how it seeds a song and what it plays on each sixteenth. The radio's scheduler
// (radio.ts) walks the song's form bar by bar and calls the style once per step.

import type { Rng } from '../../core/rng';
import { midi, type Kit } from './kit';

export const MINOR = [0, 2, 3, 5, 7, 8, 10];
export const DORIAN = [0, 2, 3, 5, 7, 9, 10];
export const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const MIXOLYDIAN = [0, 2, 4, 5, 7, 9, 10];
/** Phrygian dominant: the exotic surf scale, whose I and bII are both major chords. */
export const PHRYGIAN_DOMINANT = [0, 1, 4, 5, 7, 8, 10];

export type Section = 'intro' | 'a' | 'b' | 'break' | 'a2' | 'outro';

/** Bars per section, in playing order. */
export type Form = readonly (readonly [Section, number])[];

export interface Song {
  bpm: number;
  /** MIDI note of the key's root. */
  root: number;
  scale: readonly number[];
  /** Chord roots (scale degrees), one per bar and repeating: the A sections and the B section. */
  progA: readonly number[];
  progB: readonly number[];
  /** Eight scale degrees (-1 rests) the lead plays round, and a second one for the B section. */
  motif: readonly number[];
  motifB: readonly number[];
  /** A pattern choice the style reads its own way (0-2). */
  variant: number;
  form: Form;
  bars: number;
}

/** One sixteenth of a song, as the style sees it. */
export interface Beat {
  t: number;
  /** Seconds per sixteenth. */
  sd: number;
  step: number;
  bar: number;
  section: Section;
  /** Bar within its section. */
  sbar: number;
  /** First bar of its section. */
  top: boolean;
  /** Last bar of its section: the drummer fills. */
  fill: boolean;
  /** The bar's chord root (scale degree). */
  chord: number;
  /** The next bar's chord root. */
  nextChord: number;
  /** Chase intensity: 0 calm .. 1 five stars. */
  k: number;
  r: Rng;
}

export interface Style {
  bpm: readonly [number, number];
  /** Feedback of the tempo echo while this style plays. */
  echo: number;
  song(r: Rng, bpm: number): Song;
  step(kit: Kit, s: Song, b: Beat): void;
}

/** Fills in where `bar` falls in the song's form (section, bar within it, first and last bar) and its chords. */
export function locate(b: Beat, s: Song, bar: number): void {
  let start = 0;
  let i = 0;
  while (bar >= start + s.form[i]![1]) start += s.form[i++]![1];
  const n = s.form[i]![1];
  b.bar = bar;
  b.section = s.form[i]![0];
  b.sbar = bar - start;
  b.top = bar === start;
  b.fill = bar === start + n - 1;
  const prog = b.section === 'b' ? s.progB : s.progA;
  b.chord = prog[b.sbar % prog.length]!;
  // The last bar leads into the next section's first chord.
  const after = s.form[i + 1]?.[0] ?? 'intro';
  b.nextChord = b.fill ? (after === 'b' ? s.progB : s.progA)[0]! : prog[(b.sbar + 1) % prog.length]!;
}

/** MIDI note of scale degree `deg` (any integer, wrapping into octaves) `octave` octaves above the root. */
export function note(s: Song, deg: number, octave: number): number {
  const sc = s.scale;
  const o = Math.floor(deg / sc.length);
  const i = ((deg % sc.length) + sc.length) % sc.length;
  return s.root + 12 * (octave + o) + sc[i]!;
}

/** Frequency of scale degree `deg`. */
export function hz(s: Song, deg: number, octave: number): number {
  return midi(note(s, deg, octave));
}

/** The chord on `root` stacked in thirds: `size` notes (3 a triad, 4 a seventh, 5 a ninth), as frequencies. */
export function chord(s: Song, root: number, octave: number, size = 3): number[] {
  const out: number[] = [];
  for (let i = 0; i < size; i++) out.push(hz(s, root + 2 * i, octave));
  return out;
}

/** A wandering line of eight degrees in 0..9, with rests. */
export function motif(r: Rng, rest = 0.2): number[] {
  const m: number[] = [];
  let deg = r.int(0, 4);
  for (let i = 0; i < 8; i++) {
    deg = Math.max(0, Math.min(9, deg + r.pick([-2, -1, -1, 0, 1, 1, 2])));
    m.push(r.chance(rest) ? -1 : deg);
  }
  return m;
}

/** The usual form: 4 bars in, A, B, A again, 4 bars out (32 bars). */
export const FORM_32: Form = [
  ['intro', 4],
  ['a', 8],
  ['b', 8],
  ['a2', 8],
  ['outro', 4],
];

/** A shared song skeleton; styles pick the parts that make them. */
export function makeSong(r: Rng, bpm: number, root: number, scale: readonly number[], progsA: readonly (readonly number[])[], progsB: readonly (readonly number[])[], form: Form = FORM_32): Song {
  return {
    bpm,
    root,
    scale,
    progA: r.pick(progsA),
    progB: r.pick(progsB),
    motif: motif(r),
    motifB: motif(r),
    variant: r.int(0, 2),
    form,
    bars: form.reduce((n, [, b]) => n + b, 0),
  };
}

/**
 * The chase layer the first three stations share, as loud as the intensity: driving sixteenth hats, a pulsing eighth
 * bass on the chord root, and from about three stars off-beat kicks and a stab on every other bar.
 */
export function chaseLayer(kit: Kit, s: Song, b: Beat): void {
  const k = b.k;
  if (k < 0.03) return;
  const { t, sd, step } = b;
  kit.hat(t, false, 0.07 * k * (step % 4 === 2 ? 1.5 : 1));
  if (step % 2 === 0) kit.synth(t, hz(s, b.chord, 0), sd * 0.85, 'sawtooth', 0.13 * k, 280 + 900 * k, { filterEnv: true });
  if (k > 0.45 && (step === 6 || step === 14)) kit.kick(t, 0.5 * k);
  if (k > 0.55 && step === 0 && b.bar % 2 === 0) {
    for (const d of [0, 1]) kit.synth(t, hz(s, b.chord + d, 2), sd * 3, 'square', 0.035 * k, 1800, { release: 0.2, send: 0.3 });
  }
}

/** A snare fill over the bar's last beat (steps 12-15), rising in level; a crash marks the next bar's downbeat. */
export function snareFill(kit: Kit, b: Beat, k = 1): boolean {
  if (!b.fill || b.step < 12) return false;
  kit.snare(b.t, false, k * (0.55 + 0.15 * (b.step - 12)));
  return true;
}
