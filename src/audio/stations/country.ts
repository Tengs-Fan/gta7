// COYOTE: outlaw country. A brushed train beat (a two-step shuffle under the B section), a bass on root and the fifth
// below that walks up into each new chord, off-beat chord chops, pedal-steel swells over the A section and
// telecaster licks bent up from a whole step below. A chase is a bluegrass breakdown: banjo rolls in sixteenths, the
// bass in eighths and the train driving harder.

import { chord, hz, MAJOR, makeSong, MIXOLYDIAN, snareFill, type Style } from './style';

const LICK = [0, 2, 3, 6, 8, 10, 11, 14];
/** A forward roll over the chord: root, third, fifth, octave (scale degrees). */
const ROLL = [0, 2, 4, 7, 2, 4, 7, 4];
const STRUMS = [0, 4, 6, 8, 12, 14];
/** A whole step down: where a bent note starts. */
const BEND = Math.pow(2, -2 / 12);

export const country: Style = {
  bpm: [104, 124],
  echo: 0.18,
  song: (r, bpm) =>
    makeSong(
      r,
      bpm,
      43 + r.int(0, 5),
      r.chance(0.4) ? MIXOLYDIAN : MAJOR,
      [[0, 3, 0, 4], [0, 0, 3, 4], [0, 4, 3, 0], [0, 3, 4, 3]],
      [[3, 3, 0, 0], [4, 3, 0, 4], [3, 4, 0, 5]],
    ),
  step(kit, s, b) {
    const { t, sd, step, section, k } = b;
    const intro = section === 'intro';
    const shuffle = section === 'b';
    if (b.top && step === 0 && shuffle) kit.crash(t, 0.08);
    if (!intro || b.sbar >= 2 || k > 0.3) {
      if (step === 0 || step === 8 || (s.variant === 2 && step === 10)) kit.kick(t, 0.75, 120, 48, 0.2);
      if (!snareFill(kit, b, 0.8)) {
        if (step === 4 || step === 12) kit.snare(t, false, 0.75 + 0.25 * k);
        else if (!shuffle) kit.brush(t, sd * 0.8, (step % 2 === 0 ? 0.045 : 0.028) * (1 + k), 0.005, 3200);
        if (shuffle && step % 2 === 0) kit.hat(t + (step % 4 === 2 ? sd * 0.3 : 0), false, 0.07);
      }
    }
    let f = 0;
    if (step === 0) f = hz(s, b.chord, -1);
    else if (step === 8) f = hz(s, b.chord - 3, -1);
    else if (step === 12 && b.nextChord !== b.chord) f = hz(s, b.nextChord - 2, -1);
    else if (step === 14 && b.nextChord !== b.chord) f = hz(s, b.nextChord - 1, -1);
    else if (k > 0.5 && step % 4 === 2) f = hz(s, b.chord + (step % 8 === 2 ? 4 : 0), -1);
    if (f) kit.synth(t, f, sd * 1.8, 'triangle', 0.3, 900, { attack: 0.008, release: 0.1 });
    const ch = chord(s, b.chord, 1);
    if (!shuffle && (step === 4 || step === 12)) kit.strum(t, ch, sd * 0.6, 0.04, false, 0.006);
    if (shuffle && STRUMS.includes(step)) kit.strum(t, ch, sd * 1.2, 0.035, step % 4 === 2, 0.01, { verb: 0.1 });
    if ((section === 'a' || intro || section === 'outro') && step === 0) {
      for (const d of [2, 4]) kit.synth(t, hz(s, b.chord + d, 2), sd * 14, 'triangle', 0.045, 2400, { attack: 0.3, glide: BEND, glideTime: 0.35, vibrato: [5, 7], release: 0.5, verb: 0.3 });
    }
    if (shuffle || section === 'a2') {
      const i = LICK.indexOf(step);
      const d = i >= 0 ? (shuffle ? s.motifB : s.motif)[(i + (b.bar % 2) * 4) % 8]! : -1;
      if (d >= 0) {
        const len = (LICK[i + 1] ?? 16) - step;
        kit.pluck(t, hz(s, d + b.chord, 1), sd * len * 0.7, 0.07, 5200, { glide: len >= 2 ? BEND : undefined, glideTime: 0.1, send: 0.25 });
      }
    }
    if (k > 0.25) kit.pluck(t, hz(s, b.chord + ROLL[step % 8]!, 2), sd * 0.7, 0.04 * Math.min(1, k * 1.5), 6500);
  },
};
