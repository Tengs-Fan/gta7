// BREAKNECK: drum & bass and jungle at 170-odd. Pads, a sub and a riser in the intro, then the drop: a two-step or rolling
// break with ghost snares, a reese bass (two detuned saws over a sine sub), chopped-up breaks through the B section and
// a bell lead over the last A. A chase chops the break more often, rolls the hats in sixteenths and pumps the sub.

import { chord, DORIAN, hz, makeSong, MINOR, type Form, type Style } from './style';

const FORM: Form = [
  ['intro', 4],
  ['a', 12],
  ['b', 8],
  ['a2', 12],
  ['outro', 4],
];

interface Break {
  kick: readonly number[];
  snare: readonly number[];
  ghost: readonly number[];
}

const BREAKS: readonly Break[] = [
  { kick: [0, 10], snare: [4, 12], ghost: [7, 14] },
  { kick: [0, 2, 10, 11], snare: [4, 12], ghost: [7, 9, 15] },
  { kick: [0, 6, 10], snare: [4, 12], ghost: [3, 14] },
];
const BELL = [0, 6, 10];

export const dnb: Style = {
  bpm: [168, 176],
  echo: 0.3,
  song: (r, bpm) =>
    makeSong(
      r,
      bpm,
      41 + r.int(0, 5),
      r.chance(0.5) ? MINOR : DORIAN,
      [[0, 0, 5, 5], [0, 0, 3, 4], [0, 5, 3, 6], [0, 6, 5, 6]],
      [[5, 5, 3, 3], [3, 3, 0, 0], [5, 6, 0, 0]],
      FORM,
    ),
  step(kit, s, b) {
    const { t, sd, step, section, k, r } = b;
    const intro = section === 'intro';
    const chopped = section === 'b' || b.sbar % 4 === 3 || (k > 0.5 && b.bar % 2 === 1);
    const brk = BREAKS[chopped ? (s.variant + b.bar) % 3 : s.variant]!;
    if (b.top && step === 0 && (section === 'a' || section === 'a2')) kit.crash(t, 0.12);
    if (!intro || k > 0.3) {
      if (b.fill && step >= 8) kit.snare(t, false, 0.35 + 0.08 * (step - 8));
      else {
        if (brk.kick.includes(step)) kit.kick(t, 0.75, 160, 48, 0.25);
        if (brk.snare.includes(step)) kit.snare(t, true, 0.8, 0.15);
        else if (brk.ghost.includes(step) || r.chance(0.15 * k)) kit.noiseHit(t, 'bandpass', 2000, 0.07, 0.12, 0, { q: 1.2 });
      }
      if (step % 4 === 2) kit.hat(t, false, 0.08);
      else if (step % 2 === 1 || k > 0.3) kit.hat(t, false, 0.03 + 0.03 * k);
    } else if (b.sbar >= 1 && step % 2 === 0) kit.hat(t, false, 0.04);
    if (!intro && (step === 0 || step === 10)) {
      const len = sd * (step === 0 ? 10 : 6) * 0.95;
      const f = hz(s, b.chord, -1);
      kit.synth(t, f, len, 'sawtooth', 0.07, section === 'b' ? 520 : 360, { detune: 16, q: 2.5, filterEnv: section === 'b', release: 0.05 });
      kit.synth(t, f, len, 'sine', 0.2, 0, { raw: true, release: 0.05 });
    } else if (intro && b.sbar >= 1 && step === 0) kit.synth(t, hz(s, b.chord, -1), sd * 14, 'sine', 0.2, 0, { raw: true, attack: 0.05, release: 0.2 });
    else if (k > 0.5 && step % 2 === 0) kit.synth(t, hz(s, b.chord, 0), sd * 0.8, 'sine', 0.1 * k, 0, { raw: true });
    if ((intro || section === 'b' || section === 'outro') && step === 0 && b.bar % 2 === 0) {
      for (const f of chord(s, b.chord, 1)) kit.synth(t, f, sd * 30, 'sawtooth', 0.03, 1300, { attack: 0.8, release: 1.2, verb: 0.3 });
    }
    if (intro && b.sbar === 2 && step === 0) kit.noiseHit(t, 'highpass', 500, sd * 4, 0.07, 0, { attack: sd * 28, sweepTo: 9000 });
    if (section === 'a2' && b.bar % 2 === 0) {
      const i = BELL.indexOf(step);
      const d = i >= 0 ? s.motif[(i + b.sbar) % 8]! : -1;
      if (d >= 0) kit.epiano(t, hz(s, d + b.chord, 2), sd * 3, 0.06, 0.3);
    }
  },
};
