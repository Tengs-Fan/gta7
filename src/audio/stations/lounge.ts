// VELVET: lounge and bossa nova, music to wait to. A cross-stick clave, a soft kick and brushed eighths, an upright
// bass on root and fifth with a chromatic approach into each new chord, an electric piano comping rootless voicings
// (third, seventh, ninth) over ii-V-I changes, and a vibraphone over the B section. A chase and the band panics into
// double-time swing: a ride pattern, snare chatter, pushed piano stabs, a walking bass and vibraphone runs in eighths.

import { hz, MAJOR, makeSong, note, type Style } from './style';
import { midi } from './kit';

const CLAVE = [0, 3, 6, 10, 13];
/** Where the piano comps in the bar, per song variant. */
const COMPS = [
  [0, 6, 10],
  [0, 3, 10],
  [2, 6, 12],
];
const VOICING = [2, 6, 8];
const VIBES = [0, 4, 6, 10];
const VIBES_LEN = [4, 2, 4, 6];

export const lounge: Style = {
  bpm: [124, 136],
  echo: 0.25,
  song: (r, bpm) =>
    makeSong(
      r,
      bpm,
      50 + r.int(-2, 3),
      MAJOR,
      [[1, 4, 0, 0], [1, 4, 0, 5], [0, 5, 1, 4], [2, 5, 1, 4]],
      [[3, 3, 2, 5], [3, 6, 2, 5], [1, 1, 4, 4]],
    ),
  step(kit, s, b) {
    const { t, sd, step, section, k, r } = b;
    const panic = k > 0.3;
    const intro = section === 'intro';
    const vibe = (f: number, dur: number): void => {
      kit.synth(t, f, dur, 'sine', 0.06, 0, { raw: true, release: 0.7, verb: 0.35 });
      kit.synth(t, f * 4, dur * 0.3, 'sine', 0.01, 0, { raw: true, release: 0.2 });
    };
    if (section === 'outro' && b.fill) {
      // The last bar rings out on the tonic's major seventh.
      if (step === 0) {
        for (const d of [0, 2, 4, 6]) kit.epiano(t, hz(s, d, 1), sd * 14, 0.045, 0.35);
        kit.synth(t, hz(s, 0, -1), sd * 12, 'triangle', 0.28, 700, { attack: 0.012, release: 0.6 });
        vibe(hz(s, 7, 1), sd * 12);
      }
      return;
    }
    if (panic) {
      if (step % 4 === 0 || step % 4 === 3) kit.ride(t + (step % 4 === 3 ? sd * 0.33 : 0), 0.06 + 0.03 * k);
      if (step === 4 || step === 12) kit.hat(t, false, 0.09);
      if (r.chance(0.25 * k)) kit.snare(t, false, 0.3);
      if (step === 0) kit.kick(t, 0.4, 90, 45, 0.2);
    } else {
      if (CLAVE.includes(step)) kit.rim(t, 0.12, 0, 0.15);
      if (!intro && (step === 0 || step === 6 || step === 8 || step === 14)) kit.kick(t, 0.35, 90, 45, 0.2);
      if (step % 2 === 0) kit.brush(t, sd * 1.4, step % 4 === 2 ? 0.05 : 0.032, sd * 0.6);
    }
    if (panic ? step % 4 === 3 || step === 4 || step === 12 : COMPS[s.variant]!.includes(step)) {
      for (const d of VOICING) kit.epiano(t, hz(s, b.chord + d, 1), sd * 2, 0.042, 0.22);
    }
    if (!intro || b.sbar >= 1) {
      let f = 0;
      let len = 0;
      if (panic) {
        if (step % 4 === 0) {
          // Walking quarters: root, third, fifth, then a semitone below the next chord's root.
          f = step === 12 ? midi(note(s, b.nextChord, -1) - 1) : hz(s, b.chord + [0, 2, 4][step / 4]!, -1);
          len = sd * 3.6;
        }
      } else if (step === 0 || step === 8) {
        f = hz(s, b.chord, -1);
        len = sd * 5;
      } else if (step === 6) {
        f = hz(s, b.chord + 4, -1);
        len = sd * 2;
      } else if (step === 14) {
        f = b.nextChord !== b.chord ? midi(note(s, b.nextChord, -1) + 1) : hz(s, b.chord + 4, -1);
        len = sd * 2;
      }
      if (f) kit.synth(t, f, len, 'triangle', 0.3, 700, { attack: 0.012, release: 0.2 });
    }
    if (section === 'b' || section === 'a2') {
      if (panic) {
        if (step % 2 === 0) vibe(hz(s, b.chord + [0, 1, 2, 3, 4, 3, 2, 1][step / 2]!, 2), sd * 1.5);
      } else {
        const i = VIBES.indexOf(step);
        const d = i >= 0 ? (section === 'b' ? s.motifB : s.motif)[(i + (b.bar % 2) * 4) % 8]! : -1;
        if (d >= 0) vibe(hz(s, b.chord + d, 1), sd * VIBES_LEN[i]!);
      }
    }
  },
};
