// Police radio barks: the dispatcher's recorded phrases for a dispatch line (speech.ts), joined and squeezed through a
// radio's band (two high-passes at 300 Hz, two low-passes at 3.4 kHz, a little drive) between a squelch click and a
// squelch tail.
//
//   dispatcher clips -+
//   hiss -------------+-> HP 300 -> HP 300 -> LP 3400 -> LP 3400 -> drive -> out -> effects bus
//   squelch ----------+

import { SPEECH } from '../sim/speech';
import { withinParam } from './mixer';
import { dispatchClips, type SpeechBank } from './speech';
import type { NodeTally } from './tally';

/** Seconds between the starts of two barks. */
export const BARK_MIN_GAP = 4;
/** A bark never starts while another is on the air: it waits for it, at most this many seconds, or is dropped. */
export const BARK_WAIT = 2;
/** The radio band, Hz. */
export const RADIO_BAND: readonly [number, number] = [300, 3400];
/** Output level of a bark. */
const BARK_LEVEL = 0.4;
/** The voice starts this long after the key opens. */
const VOICE_AT = 0.08;

/** Seconds of voice for a line: its phrases back to back. */
export function barkLength(text: string): number {
  return dispatchClips(text).reduce((s, id) => s + SPEECH.clips[id]!, 0);
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
    private readonly bank: SpeechBank,
    private readonly tally?: NodeTally,
  ) {}

  /** True while a bark is on the air. */
  get busy(): boolean {
    return this.ctx.currentTime < this.busyUntil;
  }

  /** Whether a bark asked for at context time `t` may go on the air (now or once the one on the air ends). */
  canBark(t: number): boolean {
    return t - this.lastStart >= BARK_MIN_GAP && this.busyUntil - t <= BARK_WAIT;
  }

  /**
   * Plays `text` as a bark asked for at context time `t` (default now), from then or from the end of the bark on the
   * air; false when rate-limited. Resolves once its voice is scheduled (its clips are normally loaded already).
   */
  bark(text: string, asked = this.ctx.currentTime + 0.02): Promise<void> | false {
    if (!this.canBark(asked)) return false;
    const ctx = this.ctx;
    const t = Math.max(asked, this.busyUntil);
    const clips = dispatchClips(text);
    const len = barkLength(text);
    this.lastStart = t;
    this.busyUntil = t + VOICE_AT + len + 0.35;

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
    hg.gain.setValueAtTime(0.03, t + VOICE_AT + len);
    hg.gain.linearRampToValueAtTime(0.3, t + VOICE_AT + 0.02 + len);
    hg.gain.exponentialRampToValueAtTime(0.01, t + VOICE_AT + 0.22 + len);
    hg.gain.linearRampToValueAtTime(0, t + VOICE_AT + 0.24 + len);
    hiss.connect(hg);
    hg.connect(band);
    this.tally?.track('bark', hiss);
    hiss.start(t, Math.random() * 1.5);
    hiss.stop(t + VOICE_AT + len + 0.27);

    return Promise.all(clips.map((id) => this.bank.load(id))).then(
      (buffers) => {
        let at = Math.max(ctx.currentTime, t + VOICE_AT);
        for (const b of buffers) {
          const s = ctx.createBufferSource();
          s.buffer = b;
          s.connect(band);
          this.tally?.track('bark', s);
          s.start(at);
          at += b.duration;
        }
      },
      () => undefined,
    );
  }
}
