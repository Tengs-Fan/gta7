// NEON DRIVE: synthwave. Octave-bouncing saw bass, a slow detuned pad, a gated snare, an arpeggio over the A sections
// and a square lead over the B section and the last A.

import { chaseLayer, chord, hz, makeSong, MINOR, snareFill, type Style } from './style';

export const synthwave: Style = {
  bpm: [98, 112],
  echo: 0.32,
  song: (r, bpm) =>
    makeSong(
      r,
      bpm,
      45 + r.int(-2, 4),
      MINOR,
      [[0, 5, 2, 6], [0, 3, 5, 4], [5, 3, 0, 4], [0, 6, 5, 6]],
      [[5, 6, 0, 0], [3, 4, 5, 5], [5, 3, 6, 4], [3, 5, 6, 6]],
    ),
  step(kit, s, b) {
    const { t, sd, step, section } = b;
    chaseLayer(kit, s, b);
    const drums = (section !== 'intro' && section !== 'outro') || b.k > 0.3;
    if (b.top && step === 0 && (section === 'a' || section === 'b')) kit.crash(t, 0.08);
    if (drums) {
      if (step === 0 || step === 8 || (s.variant > 0 && (step === 6 || step === 10) && b.bar % 2 === 1)) kit.kick(t, 0.9);
      if (!snareFill(kit, b) && (step === 4 || step === 12)) kit.snare(t, true, 0.9, 0.3);
    }
    if (step % 2 === 0) kit.hat(t, step === 14 && section !== 'intro', 0.07);
    // The bass comes in halfway through the intro.
    if (section !== 'intro' || b.sbar >= 2) kit.synth(t, hz(s, b.chord, step % 2 === 0 ? 0 : 1), sd * 0.9, 'sawtooth', 0.14, 520, { filterEnv: true });
    if (step === 0) {
      for (const f of chord(s, b.chord, 2)) kit.synth(t, f, sd * 15, 'sawtooth', 0.032, 1500, { attack: 0.25, detune: 9, release: 0.6, send: 0.2 });
    }
    if ((section === 'a' || section === 'a2' || (section === 'intro' && b.sbar >= 1)) && step % 2 === 1) {
      const i = [0, 1, 2, 3, 2, 1, 2, 3][(step - 1) / 2]!;
      kit.synth(t, hz(s, b.chord + 2 * i, 2), sd * 0.8, 'square', 0.022, 1700, { send: 0.35 });
    }
    if ((section === 'b' || section === 'a2') && step % 2 === 0) {
      const m = section === 'b' ? s.motifB : s.motif;
      const d = m[(step / 2 + (b.bar % 2) * 4) % 8]!;
      if (d >= 0) kit.synth(t, hz(s, d + b.chord, 3), sd * 1.6, 'square', 0.045, 2600, { send: 0.55, release: 0.12 });
    }
  },
};
