// WIPEOUT: surf rock from Ocean Beach. Half its songs are sunny major, half the exotic phrygian-dominant vamp. A picked
// bass walking root-fifth-octave, palm-muted chugs and a twangy low-string riff, a tom groove and off-beat stabs under
// the B section, and
// a tremolo-picked lead drenched in spring reverb that dives an octave at the end of each phrase. A chase brings the
// tom groove in everywhere, crashes on every other bar and the lead over the A section too.

import { chord, hz, MAJOR, makeSong, PHRYGIAN_DOMINANT, type Style } from './style';

/** The tom groove: a floor, mid or high tom (Hz) on each sixteenth, or none. */
const TOMS = [110, 0, 185, 110, 0, 0, 185, 0, 110, 0, 185, 110, 0, 0, 185, 145];
const RIFF = [0, 3, 6, 8, 11, 14];
/** Bass walk over the bar's eighths, in scale degrees above the chord root. */
const WALK = [0, 0, 4, 7, 0, 0, 4, 2];
/** Root and fifth in one voice: two oscillators a fifth apart, centred on the pitch between them. */
const FIFTH = 350;

export const surf: Style = {
  bpm: [150, 166],
  echo: 0.22,
  song(r, bpm) {
    const exotic = r.chance(0.5);
    return makeSong(
      r,
      bpm,
      40 + r.int(0, 5),
      exotic ? PHRYGIAN_DOMINANT : MAJOR,
      exotic ? [[0, 0, 1, 1], [0, 1, 0, 1], [0, 1, 6, 0]] : [[0, 0, 3, 4], [0, 5, 3, 4], [0, 3, 4, 3]],
      exotic ? [[3, 3, 1, 0], [6, 6, 1, 0], [3, 1, 6, 0]] : [[3, 3, 0, 0], [4, 3, 0, 4], [5, 3, 4, 4]],
    );
  },
  step(kit, s, b) {
    const { t, sd, step, section, k } = b;
    const intro = section === 'intro';
    const outro = section === 'outro';
    if (b.top && step === 0 && !intro) kit.crash(t, 0.1);
    else if (k > 0.5 && step === 0 && b.bar % 2 === 0) kit.crash(t, 0.07 * k);
    if (intro && b.sbar === 0) {
      // The pick slid down the low string, then a tom roll into the band.
      if (step === 0) kit.noiseHit(t, 'bandpass', 5000, sd * 7, 0.13, 0.15, { q: 6, sweepTo: 220, verb: 0.5 });
      if (step >= 8 && step % 2 === 0) kit.tom(t, [185, 160, 130, 110][(step - 8) / 2]!, 0.4);
      return;
    }
    const drums = !intro || b.sbar >= 2 || k > 0.3;
    if (drums && !(outro && b.fill)) {
      if (b.fill && step >= 12) kit.tom(t, [220, 185, 145, 110][step - 12]!, 0.5);
      else {
        if (step === 0 || step === 8 || (s.variant === 1 && step === 6) || (s.variant === 2 && step === 10)) kit.kick(t, 0.85, 130, 50, 0.22);
        if (step === 4 || step === 12) kit.snare(t, false, 1, 0.35);
        if (section === 'b' || k > 0.3) {
          const f = TOMS[step]!;
          if (f) kit.tom(t, f, 0.3 + 0.12 * k, 0);
        }
      }
      if (step % 2 === 0) kit.ride(t, step % 4 === 0 ? 0.07 : 0.05);
    }
    if (k > 0.03 && step % 2 === 1) kit.hat(t, false, 0.06 * k);
    if (outro && b.fill) {
      // The last chord rings out under the slide.
      if (step === 0) {
        kit.strum(t, chord(s, 0, 1), sd * 14, 0.07, false, 0.02, { verb: 0.6 });
        kit.synth(t, hz(s, 0, 0), sd * 14, 'sawtooth', 0.16, 650, { filterEnv: true });
        kit.noiseHit(t + sd * 2, 'bandpass', 5000, sd * 8, 0.1, 0.15, { q: 6, sweepTo: 220, verb: 0.5 });
      }
      return;
    }
    if (step % 2 === 0) kit.synth(t, hz(s, b.chord + WALK[step / 2]!, 0), sd * 1.6, 'sawtooth', 0.17, 650, { filterEnv: true, release: 0.06 });
    const power = hz(s, b.chord, 1) * Math.pow(2, FIFTH / 1200);
    if (section === 'b') {
      if (step % 4 === 2) kit.synth(t, power, sd * 1.2, 'sawtooth', 0.06, 2200, { detune: FIFTH, filterEnv: true, release: 0.15, verb: 0.3 });
    } else if (step % 2 === 0) {
      kit.synth(t, power, sd * 0.7, 'sawtooth', section === 'a2' ? 0.035 : 0.05, 1100, { detune: FIFTH, filterEnv: true, release: 0.04 });
    }
    if (section === 'a' || intro) {
      const i = RIFF.indexOf(step);
      const d = i >= 0 ? s.motif[i]! : -1;
      if (d >= 0) kit.pluck(t, hz(s, b.chord + (d % 5), 1), sd * 1.5, 0.09, 2600, { verb: 0.35 });
    }
    if ((section === 'b' || section === 'a2' || k > 0.6) && step % 4 === 0) {
      const m = section === 'b' ? s.motifB : s.motif;
      const d = m[(step / 4 + (b.bar % 2) * 4) % 8]!;
      const dive = b.sbar % 4 === 3 && step === 12;
      if (d >= 0) {
        kit.synth(t, hz(s, d + b.chord, 2), sd * 3.8, 'sawtooth', 0.075, 2400, { q: 2, tremolo: 2 / sd, verb: 0.45, release: 0.15, bend: dive ? 0.5 : undefined });
      }
    }
  },
};
