// PIXEL: 8-bit chiptune, voiced like an old console: a pulse-wave lead, a second pulse channel arpeggiating the chord,
// a triangle bass and noise drums, all raw (no filters). A chase is the boss battle: a thinner, higher lead, sixteenth
// bass and hats, a snare pickup and from four stars a kick on every beat.

import { hz, MAJOR, makeSong, MINOR, type Style } from './style';

/** Where the lead's notes fall in the bar, per song variant; each holds until the next. */
const RHYTHMS = [
  [0, 2, 4, 6, 8, 10, 12, 14],
  [0, 3, 6, 8, 10, 12, 14],
  [0, 2, 3, 4, 6, 8, 11, 12, 14],
];
/** The arpeggio: root, third, fifth, octave (scale degrees). */
const ARP = [0, 2, 4, 7];

export const chiptune: Style = {
  bpm: [138, 156],
  echo: 0.2,
  song(r, bpm) {
    const minor = r.chance(0.4);
    return makeSong(
      r,
      bpm,
      48 + r.int(0, 5),
      minor ? MINOR : MAJOR,
      minor ? [[0, 5, 2, 6], [0, 6, 5, 4], [0, 3, 6, 4]] : [[0, 4, 5, 3], [5, 3, 0, 4], [0, 3, 4, 4], [0, 5, 3, 4]],
      minor ? [[5, 6, 0, 0], [3, 4, 0, 4]] : [[3, 4, 0, 0], [3, 4, 2, 5], [5, 4, 3, 4]],
    );
  },
  step(kit, s, b) {
    const { t, sd, step, section, k } = b;
    const boss = k > 0.5;
    const intro = section === 'intro';
    if (!intro || b.sbar >= 2) {
      if (step === 0 || step === 8 || (s.variant > 0 && step === 10) || (k > 0.7 && step % 4 === 0)) kit.kick(t, 0.7, 200, 55, 0.1);
      if (b.fill && step >= 12) kit.noiseHit(t, 'bandpass', 1800 + 500 * (step - 12), 0.07, 0.2, 0, { q: 0.8 });
      else if (step === 4 || step === 12 || (boss && step === 14)) kit.noiseHit(t, 'bandpass', 2500, 0.09, 0.24, 0, { q: 0.7 });
      if (step % 2 === 0 || k > 0.3) kit.noiseHit(t, 'highpass', 8000, 0.025, 0.05);
    }
    if (step % 2 === 0 || k > 0.3) kit.synth(t, hz(s, b.chord, step % 4 === 2 ? 0 : -1), sd * 0.9, 'triangle', 0.3, 0, { raw: true, release: 0.02 });
    if (!intro || b.sbar >= 1) kit.synth(t, hz(s, b.chord + ARP[step % 4]!, 1), sd * 0.85, 'square', 0.026, 0, { raw: true, wave: kit.pulse(0.5), release: 0.01 });
    const lead = section === 'a' || section === 'b' || section === 'a2' || (intro && b.sbar === 3 && step >= 8);
    if (!lead) return;
    const rh = RHYTHMS[s.variant]!;
    const i = rh.indexOf(step);
    if (i < 0) return;
    const d = (section === 'b' ? s.motifB : s.motif)[(i + (b.bar % 2) * 3) % 8]!;
    if (d < 0) return;
    const len = (rh[i + 1] ?? 16) - step;
    const wave = kit.pulse(section === 'b' || boss ? 0.125 : 0.25);
    kit.synth(t, hz(s, d + b.chord, boss ? 2 : 1), sd * len * 0.9, 'square', 0.065, 0, { raw: true, wave, release: 0.03, vibrato: len >= 3 ? [6, 18] : undefined });
  },
};
