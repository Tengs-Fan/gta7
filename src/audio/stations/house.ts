// PULSE: four-to-the-floor house. Off-beat saw bass and open hats, chord stabs, and a breakdown: the drums drop out
// under a held pad and a rising sweep, then the B section lands with a crash and piano stabs.

import { chaseLayer, chord, hz, makeSong, MINOR, type Form, type Style } from './style';

const FORM: Form = [
  ['intro', 4],
  ['a', 8],
  ['break', 4],
  ['b', 8],
  ['a2', 8],
  ['outro', 4],
];

export const house: Style = {
  bpm: [120, 126],
  echo: 0.32,
  song: (r, bpm) =>
    makeSong(
      r,
      bpm,
      45 + r.int(-2, 4),
      MINOR,
      [[0, 0, 5, 5], [0, 3, 5, 4], [0, 5, 3, 4], [5, 5, 0, 0]],
      [[3, 4, 0, 0], [5, 6, 0, 4], [3, 3, 5, 4]],
      FORM,
    ),
  step(kit, s, b) {
    const { t, sd, step, section } = b;
    chaseLayer(kit, s, b);
    const brk = section === 'break' && b.k < 0.3;
    const drums = (section !== 'intro' && section !== 'outro' && !brk) || b.k > 0.3;
    if (b.top && step === 0 && (section === 'a' || section === 'b')) kit.crash(t, 0.1);
    if (!brk && step % 4 === 0 && (section !== 'intro' || b.sbar >= 1)) kit.kick(t, 0.9);
    if (drums && (step === 4 || step === 12)) kit.clap(t);
    if (!brk && step % 4 === 2) kit.hat(t, true, 0.085);
    else if (drums && step % 2 === 1) kit.hat(t, false, 0.04);
    if (section !== 'intro' && !brk && step % 4 === 2) kit.synth(t, hz(s, b.chord, 0), sd * 1.2, 'sawtooth', 0.19, 480, { filterEnv: true });
    if (brk) {
      if (step === 0) for (const f of chord(s, b.chord, 1, 4)) kit.synth(t, f, sd * 15, 'sawtooth', 0.03, 1100, { attack: 0.4, detune: 12, release: 0.8, send: 0.25 });
      // The riser over the last two bars.
      if (step === 0 && b.sbar === 2) kit.noiseHit(t, 'highpass', 400, sd * 4, 0.06, 0, { attack: sd * 28, sweepTo: 7000 });
    }
    if (section === 'b' && (step === 3 || step === 11)) {
      for (const f of chord(s, b.chord, 1, 3)) kit.epiano(t, f, sd * 2, 0.055, 0.1);
    } else if (drums && (step === 3 || step === 6 || step === 11)) {
      for (const f of chord(s, b.chord, 2)) kit.synth(t, f, sd * 1.1, 'square', 0.032, 2200, { send: 0.3 });
    }
    if (section === 'b' || section === 'a2' || (section === 'break' && b.sbar >= 2)) {
      const k = [0, 2, 4, 7][step % 4]!;
      kit.synth(t, hz(s, b.chord + k, 3), sd * 0.8, 'triangle', section === 'break' ? 0.025 : 0.038, 3500, { send: 0.35 });
    }
  },
};
