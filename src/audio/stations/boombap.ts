// BOOM BAP: swung hip-hop beats in dorian. A triangle bass and soft chords, an electric piano over the B section, a
// sine lead, the odd vinyl crackle and a scratch where the drummer would fill.

import { chaseLayer, chord, DORIAN, hz, makeSong, type Style } from './style';

export const boombap: Style = {
  bpm: [84, 94],
  echo: 0.32,
  song: (r, bpm) =>
    makeSong(
      r,
      bpm,
      43 + r.int(-2, 4),
      DORIAN,
      [[1, 4, 0, 0], [0, 3, 0, 3], [5, 1, 4, 0], [0, 5, 3, 4]],
      [[3, 3, 1, 4], [5, 4, 3, 1], [3, 4, 5, 4]],
    ),
  step(kit, s, b) {
    const { t, sd, step, section, r } = b;
    chaseLayer(kit, s, b);
    const swing = step % 4 === 2 ? sd * 0.32 : 0;
    const tt = t + swing;
    const drums = section !== 'intro' || b.k > 0.3;
    if (b.fill && (step === 12 || step === 14)) {
      // A scratch: the record pulled back and pushed forward.
      kit.noiseHit(tt, 'bandpass', 700, sd * 0.9, 0.16, 0, { q: 3, sweepTo: 2800 });
      kit.noiseHit(tt + sd, 'bandpass', 2800, sd * 0.8, 0.13, 0, { q: 3, sweepTo: 600 });
    } else if (drums) {
      if (step === 0 || step === 10 || (s.variant === 1 && step === 7) || (s.variant === 2 && step === 3)) kit.kick(tt, 0.95);
      if (step === 4 || step === 12) kit.snare(tt, false);
    }
    if (step % 2 === 0) kit.hat(tt, false, step % 4 === 0 ? 0.11 : 0.065);
    if (r.chance(0.08)) kit.noiseHit(t + r.range(0, sd), 'highpass', 5000, 0.01, 0.03);
    if (step === 0) kit.synth(tt, hz(s, b.chord, -1), sd * 7, 'triangle', 0.32, 420, { release: 0.15 });
    if (step === 10) kit.synth(tt, hz(s, b.chord, -1), sd * 3, 'triangle', 0.26, 420);
    if (section === 'b') {
      if (step === 0 || step === 7) for (const f of chord(s, b.chord, 1, 4)) kit.epiano(tt, f, sd * 4, 0.05, 0.12);
    } else if (step === 0 || step === 6 || (step === 14 && b.bar % 2 === 1)) {
      for (const f of chord(s, b.chord, 1, 4)) kit.synth(tt, f, sd * 2.5, 'triangle', 0.042, 1800, { release: 0.35, send: 0.15 });
    }
    if ((section === 'b' || section === 'a2') && (step === 2 || step === 8 || step === 11)) {
      const m = section === 'b' ? s.motifB : s.motif;
      const d = m[(step + b.bar) % 8]!;
      if (d >= 0) kit.synth(tt, hz(s, d + b.chord, 2), sd * 2, 'sine', 0.08, 3000, { send: 0.45, release: 0.3 });
    }
  },
};
