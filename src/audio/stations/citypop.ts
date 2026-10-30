// 月光電台 (MOONLIGHT): eighties city pop for the drive home at two in the morning. Four on the floor (a light sixteenth
// shuffle in a third of the songs), a slap bass popping octaves, an FM electric piano comping ninth chords that pushes
// each new chord an eighth early, clean chorused guitar cuts on the off-beats, a scooped sax-like lead over the verses
// and a square synth lead over the chorus. Every iii chord leads to vi, so it is played dominant (III7), the genre's
// favourite secondary dominant. A chase is the car chase of a late-night cop show: octave disco bass, a synth brass
// section stabbing the off-beats with a run up every other bar, sixteenth hats and timbale breaks.

import { MAJOR, makeSong, note, snareFill, type Beat, type Song, type Style } from './style';
import { midi, type Kit } from './kit';

/** Slap bass per song variant, one letter per sixteenth: T the thumb on the root, P a popped octave, G a muted ghost, A the approach into the next chord. */
const SLAP = ['T..PT.GPT..PT.PA', 'T.GP.GTPT.GP.TPA', 'T..PT..PT.GPT.PA'];
/** Guitar per variant: x a cut on the top strings, . a muted scratch. */
const CUTS = ['  x.  x.  x.  x.', ' .x  .x . x  .x ', '    x.  .   x. .'];
/** Where the keys comp, per variant; 14 pushes the next bar's chord an eighth early, so a bar never restrikes on 0. */
const COMPS = [
  [6, 10, 14],
  [3, 8, 14],
  [4, 11, 14],
];
/** Where the lead's notes start, per variant; each holds until the next. */
const PHRASES = [
  [0, 3, 6, 10, 12],
  [2, 4, 7, 10, 14],
  [0, 2, 6, 8, 11],
];
/** The keys' rootless voicing: third, seventh and ninth over the root; iii keeps its fifth instead, as its ninth is flat. */
const NINTH = [2, 6, 8];
const SEVENTH = [2, 4, 6];
/** A short comp's two notes: the third and the seventh. */
const GUIDE = [2, 6];
/** The guitar's two top strings: the seventh and the third an octave up. */
const CUT = [6, 9];
/** The brass section's three notes over the root. */
const BRASS = [4, 6, 9];
/** A semitone below: where the sax scoops up from. */
const SCOOP = Math.pow(2, -1 / 12);

/**
 * MIDI note of degree `deg` above the chord `root`. Every iii here leads to vi, so the iii chord is played dominant:
 * its minor third (the scale's fifth degree) is raised a semitone.
 */
function tone(s: Song, root: number, deg: number, octave: number): number {
  const n = note(s, root + deg, octave);
  return root === 2 && (root + deg) % 7 === 4 ? n + 1 : n;
}

/** Frequency of `tone`. */
function pitch(s: Song, root: number, deg: number, octave: number): number {
  return midi(tone(s, root, deg, octave));
}

/** The keys' chord on `root`, a rootless ninth (a seventh on iii), or only its third and seventh. */
function keys(s: Song, root: number, full = true): number[] {
  return (full ? (root === 2 ? SEVENTH : NINTH) : GUIDE).map((d) => pitch(s, root, d, 1));
}

/** The slap bass's sixteenth `step`, or the chase's octave disco bass. */
function bass(kit: Kit, s: Song, b: Beat, t: number, disco: boolean): void {
  const { sd, step, chord } = b;
  const c = disco ? (step % 2 === 1 ? (b.k > 0.6 ? 'G' : ' ') : step % 4 === 0 ? 'T' : 'P') : SLAP[s.variant]![step]!;
  if (c === 'T') kit.synth(t, pitch(s, chord, 0, -1), sd * 1.6, 'sawtooth', 0.18, 560, { filterEnv: true, q: 2.5, release: 0.05 });
  else if (c === 'P') kit.synth(t, pitch(s, chord, 0, 0), sd * 0.7, 'square', 0.085, 1500, { filterEnv: true, release: 0.04 });
  else if (c === 'G') kit.synth(t, pitch(s, chord, 0, -1), 0.03, 'triangle', 0.12, 320, { release: 0.02 });
  else if (c === 'A') {
    // A semitone under the next root, or the fifth when the chord stays.
    const f = b.nextChord !== chord ? midi(note(s, b.nextChord, -1) - 1) : pitch(s, chord, 4, -1);
    kit.synth(t, f, sd * 0.9, 'sawtooth', 0.17, 560, { filterEnv: true, q: 2.5, release: 0.04 });
  }
}

export const citypop: Style = {
  bpm: [100, 118],
  echo: 0.28,
  song: (r, bpm) =>
    makeSong(
      r,
      bpm,
      48 + r.int(0, 5),
      MAJOR,
      [[3, 4, 2, 5], [3, 2, 5, 0], [0, 5, 1, 4], [1, 4, 0, 5], [5, 1, 4, 0]],
      [[3, 4, 2, 5], [1, 2, 5, 4], [3, 4, 5, 5]],
    ),
  step(kit, s, b) {
    const { sd, step, section, k } = b;
    const intro = section === 'intro';
    const outro = section === 'outro';
    const chorus = section === 'b';
    const chase = k > 0.3;
    // The chorus and the last verse drive harder: a clap on the snare and sixteenth hats.
    const lift = chorus || section === 'a2' || chase;
    // The light shuffle drags every second sixteenth.
    const t = b.t + (s.variant === 2 && step % 2 === 1 ? sd * 0.22 : 0);
    if (outro && b.fill) {
      // The last bar rings out on the tonic's major ninth over the root, and the sax falls away.
      if (step === 0) {
        for (const f of keys(s, 0)) kit.epiano(t, f, sd * 14, 0.045, 0.35);
        kit.synth(t, pitch(s, 0, 0, -1), sd * 12, 'triangle', 0.28, 650, { attack: 0.01, release: 0.6 });
        kit.synth(t, pitch(s, 0, 4, 1), sd * 10, 'sawtooth', 0.05, 1600, { attack: 0.05, vibrato: [5, 10], bend: 0.75, release: 0.3, send: 0.35, verb: 0.3 });
      }
      if (step % 4 === 0) kit.brush(t, sd * 2, 0.03, sd);
      return;
    }

    // Drums: they come in on the intro's third bar and drop out over the outro's second half.
    const drums = chase || (!(intro && b.sbar < 2) && !(outro && b.sbar >= 2));
    if (b.top && step === 0 && !intro) kit.crash(t, 0.09);
    else if (chase && step === 0 && b.bar % 4 === 0) kit.crash(t, 0.08 * k);
    if (drums) {
      if (step % 4 === 0) kit.kick(t, 0.85, 140, 46, 0.24);
      const fill = b.fill && step >= 12 && !outro;
      if (fill && section === 'a') kit.tom(t, [330, 262, 196, 147][step - 12]!, 0.38);
      else if (k > 0.5 && b.bar % 2 === 1 && step >= 12) kit.tom(t, [520, 440, 390, 330][step - 12]!, 0.22 * k, 0.1);
      else if (!(fill && snareFill(kit, b, 0.8)) && (step === 4 || step === 12)) {
        kit.snare(t, true, 0.75, 0.25);
        if (lift) kit.clap(t, 0.6);
      }
      if (step % 2 === 0) kit.hat(t, step % 4 === 2 && (s.variant === 0 || chase), step % 4 === 0 ? 0.085 : 0.07);
      else if (lift) kit.hat(t, false, 0.035 + 0.02 * k);
    } else if (step % 2 === 0) kit.brush(t, sd * 1.5, step % 4 === 2 ? 0.045 : 0.03, sd * 0.5);

    // Bass: fingered root, octave and fifth under the intro, then the slap; a chase pumps octave eighths.
    if (chase && !intro) bass(kit, s, b, t, true);
    else if (intro) {
      if (b.sbar >= 1 && (step === 0 || step === 6 || step === 8 || step === 12)) {
        const d = step === 6 ? 7 : step === 12 ? 4 : 0;
        kit.synth(t, pitch(s, b.chord, d, -1), sd * (step === 0 ? 5 : 2.5), 'triangle', 0.22, 650, { attack: 0.01, release: 0.15 });
      }
    } else if (!(outro && b.sbar >= 2) || step === 0) bass(kit, s, b, t, false);

    // Keys: the song's first chord on its downbeat, then short comps, and the push held over the next bar's downbeat.
    if ((b.bar === 0 && step === 0) || COMPS[s.variant]!.includes(step)) {
      const push = step === 14;
      for (const f of keys(s, push ? b.nextChord : b.chord, push || step === 0)) kit.epiano(t, f, sd * (push ? 5 : 2), 0.042, 0.25);
    }

    // A pad under the chorus.
    if (chorus && step === 0) {
      for (const d of [2, 4, 6]) kit.synth(t, pitch(s, b.chord, d, 1), sd * 15, 'sawtooth', 0.018, 1300, { attack: 0.35, detune: 9, release: 0.6, verb: 0.2 });
    }

    // Guitar cuts from the intro's last bar on.
    if (!intro || b.sbar === 3) {
      const c = CUTS[s.variant]![step]!;
      if (c === 'x') {
        kit.strum(t, CUT.map((d) => pitch(s, b.chord, d, 1)), sd * 0.55, 0.04, step % 4 === 2, 0.005, { detune: 7, release: 0.06, send: 0.15 });
      } else if (c === '.') kit.noiseHit(t, 'bandpass', 2200, 0.025, 0.05, 0, { q: 2 });
    }

    // The brass section of a chase: off-beat stabs, and a run up the scale over the last beat of every other bar.
    if (k > 0.5) {
      const run = b.bar % 2 === 0 && step >= 12;
      if (run || step === 3 || step === 10) {
        const up = run ? step - 12 : 0;
        for (const d of BRASS) kit.synth(t, pitch(s, b.chord, d + up, 1), sd * (run ? 0.9 : 1.5), 'sawtooth', 0.034 * k, 1500, { filterEnv: true, release: 0.1 });
      }
    }

    // The lead: the sax over the verses (and a pickup at the end of the intro), the synth over the chorus. A phrase is
    // three bars of melody and a held note.
    const sax = section === 'a' || section === 'a2' || (intro && b.sbar === 3 && step >= 8);
    if (!sax && !chorus) return;
    const rh = PHRASES[s.variant]!;
    const end = b.sbar % 4 === 3 && !intro;
    const i = rh.indexOf(step);
    if (i < 0 || (end && i > 0)) return;
    const d = (chorus ? s.motifB : s.motif)[(i + (b.bar % 2) * 4) % 8]!;
    if (d < 0) return;
    const len = end ? 12 : (rh[i + 1] ?? 16) - step;
    const f = pitch(s, b.chord, d, 1);
    if (chorus) kit.synth(t, f, sd * len * 0.85, 'square', 0.036, 2800, { detune: 7, release: 0.12, send: 0.4, verb: 0.15 });
    else kit.synth(t, f, sd * len * 0.9, 'sawtooth', 0.06, 1700, { attack: 0.035, glide: SCOOP, glideTime: 0.06, vibrato: [5.2, 9], q: 1.8, release: 0.15, send: 0.25, verb: 0.2 });
  },
};
