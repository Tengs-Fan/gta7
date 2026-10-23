// Police radio barks: a short procedural voice clip per dispatch line, squeezed through a radio's band
// (two high-passes at 300 Hz, two low-passes at 3.4 kHz, a little drive) between a squelch click and a squelch tail.
//
//   cop voice -+
//   hiss ------+-> HP 300 -> HP 300 -> LP 3400 -> LP 3400 -> drive -> out -> effects bus
//   squelch ---+

import { clamp } from '../core/math';
import { withinParam } from './mixer';
import type { NodeTally } from './tally';
import { COP_VOICE, FormantVoice, hashString, speechPlan } from './voice';

/** Seconds between the starts of two barks, and a bark never starts while another is on the air. */
export const BARK_MIN_GAP = 4;
/** Longest bark, seconds (the voice; the squelch tail comes after). */
export const BARK_MAX = 2.8;
/** The radio band, Hz. */
export const RADIO_BAND: readonly [number, number] = [300, 3400];
/** Output level of a bark. */
const BARK_LEVEL = 0.4;

/** Seconds of voice for a line: about a sixth of a second per word, 0.9 to 2.8 s. */
export function barkLength(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return clamp(0.45 + words * 0.17, 0.9, BARK_MAX);
}

/** A gentle tanh drive: the radio's speaker breaking up a little. */
function driveCurve(n = 256): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(1.6 * x) / Math.tanh(1.6);
  }
  return c;
}

export class PoliceScanner {
  /** Context time the current bark (with its squelch tail) ends. */
  private busyUntil = -Infinity;
  private lastStart = -Infinity;
  private curve: Float32Array<ArrayBuffer> | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: AudioNode,
    private readonly noise: AudioBuffer,
    private readonly tally?: NodeTally,
  ) {}

  /** True while a bark is on the air. */
  get busy(): boolean {
    return this.ctx.currentTime < this.busyUntil;
  }

  /** Whether a bark may start at context time `t`. */
  canBark(t: number): boolean {
    return t >= this.busyUntil && t - this.lastStart >= BARK_MIN_GAP;
  }

  /** Plays `text` as a bark at context time `t` (default now); false when rate-limited. */
  bark(text: string, t = this.ctx.currentTime + 0.02): boolean {
    if (!this.canBark(t)) return false;
    const ctx = this.ctx;
    const len = barkLength(text);
    this.lastStart = t;
    this.busyUntil = t + len + 0.35;

    // The radio band.
    const filters: BiquadFilterNode[] = [];
    for (const [type, hz] of [
      ['highpass', RADIO_BAND[0]],
      ['highpass', RADIO_BAND[0]],
      ['lowpass', RADIO_BAND[1]],
      ['lowpass', RADIO_BAND[1]],
    ] as const) {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = withinParam(f.frequency, hz);
      f.Q.value = 0.8;
      if (filters.length) filters[filters.length - 1]!.connect(f);
      filters.push(f);
    }
    const band = filters[0]!;
    const drive = ctx.createWaveShaper();
    drive.curve = this.curve ??= driveCurve();
    const out = ctx.createGain();
    out.gain.value = BARK_LEVEL;
    filters[filters.length - 1]!.connect(drive);
    drive.connect(out);
    out.connect(this.dest);

    // Squelch: a click and a burst of hiss as the key opens, a longer one as it closes, and a low hiss under the voice.
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noise;
    hiss.loop = true;
    const hg = ctx.createGain();
    hg.gain.value = 0;
    hg.gain.setValueAtTime(0, ctx.currentTime);
    hg.gain.setValueAtTime(0, t);
    hg.gain.linearRampToValueAtTime(0.5, t + 0.003);
    hg.gain.linearRampToValueAtTime(0.18, t + 0.02);
    hg.gain.exponentialRampToValueAtTime(0.03, t + 0.07);
    hg.gain.setValueAtTime(0.03, t + 0.08 + len);
    hg.gain.linearRampToValueAtTime(0.3, t + 0.1 + len);
    hg.gain.exponentialRampToValueAtTime(0.01, t + 0.3 + len);
    hg.gain.linearRampToValueAtTime(0, t + 0.32 + len);
    hiss.connect(hg);
    hg.connect(band);
    this.tally?.track('bark', hiss);
    hiss.start(t, Math.random() * 1.5);
    hiss.stop(t + len + 0.35);

    const seed = hashString(text) ^ ((Math.random() * 0xffff) | 0);
    const voice = new FormantVoice(ctx, band, this.noise, speechPlan(seed, len, COP_VOICE), t + 0.08, { highpass: 200, lowpass: 4000, level: 1 }, this.tally, 'bark');
    voice.schedule(t + 0.08 + len + 1);
    voice.stop(t + 0.08 + len);
    return true;
  }
}
