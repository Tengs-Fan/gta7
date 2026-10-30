// DOCKSIDE DUB: dub and roots from the Docks. A one-drop beat (kick and rim together on the third beat), a deep
// melodic bass riddim, an off-beat skank, a bubbling organ, a melodica over the B section, long echo throws and
// dub drop-outs: a bar of bass alone, a bar of drums alone. A chase turns it to steppers: the kick on every beat, hats
// in sixteenths and the bass pumping eighths under the riddim.

import { chord, DORIAN, hz, makeSong, MINOR, type Style } from './style';

/** Where the bass riddim plays in the bar, per song variant. */
const RIDDIMS = [
  [0, 3, 6, 7, 10],
  [0, 2, 6, 8, 11, 14],
  [0, 5, 6, 10, 12],
];
const MELODICA = [0, 6, 8, 12];
const MELODICA_LEN = [5, 2, 4, 3];

export const dub: Style = {
  bpm: [70, 80],
  echo: 0.55,
  song: (r, bpm) =>
    makeSong(
      r,
      bpm,
      40 + r.int(0, 5),
      r.chance(0.6) ? MINOR : DORIAN,
      [[0, 0, 3, 3], [0, 6, 5, 6], [0, 3, 0, 4], [0, 0, 5, 6]],
      [[3, 3, 0, 0], [5, 6, 0, 0], [3, 4, 3, 4]],
    ),
  step(kit, s, b) {
    const { t, sd, step, section, k, r } = b;
    const tt = t + (step % 4 === 2 ? sd * 0.3 : 0);
    const intro = section === 'intro';
    const steppers = k > 0.25;
    const noDrums = (intro && b.sbar < 1) || (section === 'a2' && b.sbar % 4 === 2 && !steppers);
    const noBass = (intro && b.sbar < 1) || (section === 'b' && b.sbar % 4 === 3) || (section === 'outro' && b.sbar >= 2);
    if (!noDrums) {
      if (step === 8 || (s.variant === 1 && step === 0) || (steppers && step % 4 === 0)) kit.kick(t, step === 8 ? 0.8 : 0.6, 110, 42, 0.35);
      if (b.fill && (step === 12 || step === 14)) kit.snare(t, true, 0.7, 0.5);
      else if (step === 8) kit.rim(t, 0.24, r.chance(0.3) ? 0.9 : 0.15, 0.25);
      if (step % 2 === 0) kit.hat(tt, step === 6 && s.variant === 2, 0.065);
      else if (steppers) kit.hat(t, false, 0.045 * k);
    } else if (step === 8) kit.rim(t, 0.2, 0.9, 0.3);
    if (step === 4 || step === 12) {
      const throwIt = r.chance(0.12);
      for (const f of chord(s, b.chord, 1)) kit.synth(t, f, sd * 0.5, 'square', 0.035, 2000, { release: 0.05, verb: 0.15, send: throwIt ? 0.6 : 0 });
    }
    if ((section === 'b' || section === 'a2') && step % 4 >= 2) {
      kit.synth(tt, hz(s, b.chord + (step % 4 === 2 ? 0 : 4), 1), sd * 0.6, 'triangle', 0.035, 1500, { release: 0.04 });
    }
    if (!noBass) {
      const riddim = RIDDIMS[s.variant]!;
      const i = riddim.indexOf(step);
      if (i >= 0) {
        const len = (riddim[i + 1] ?? 16) - step;
        const d = Math.max(0, s.motif[i]!) % 5;
        kit.synth(tt, hz(s, b.chord + d, -1), len * sd * 0.9, 'triangle', 0.3, 480, { attack: 0.01, release: 0.08, q: 1 });
      } else if (steppers && step % 2 === 0) kit.synth(t, hz(s, b.chord, -1), sd * 0.8, 'triangle', 0.17 * k, 480, { release: 0.05 });
    }
    if (section === 'b') {
      const i = MELODICA.indexOf(step);
      const d = i >= 0 ? s.motifB[(i + (b.bar % 2) * 4) % 8]! : -1;
      if (d >= 0) kit.synth(t, hz(s, d + b.chord, 2), sd * MELODICA_LEN[i]!, 'square', 0.045, 1600, { attack: 0.05, vibrato: [5.5, 14], verb: 0.25, send: 0.3, release: 0.12 });
    }
  },
};
