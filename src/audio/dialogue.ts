// Spoken dialogue: the clip of each subtitle line (mission scripts and phone calls), on the UI bus so neither the
// in-car muffling nor the pause stage touches it. A call ("Mama Lou (phone)") comes down a phone line. A new line, an
// empty subtitle (a skip) or the end of the game cuts the line playing; the pause menu holds it and resumes it where it
// stopped, as the subtitle's own clock does.
//
//   clip -> [phone: HP 300 -> LP 3400 -> drive] -> gain -> UI bus

import { dialogueKey, SPEECH } from '../sim/speech';
import { withinParam } from './mixer';
import type { SpeechBank } from './speech';
import type { NodeTally } from './tally';

const LEVEL = 0.9;
const PHONE_LEVEL = 1.1;
/** Seconds of the fade when a line is cut. */
const CUT = 0.05;

interface Line {
  buffer: AudioBuffer;
  phone: boolean;
  /** Seconds of the clip already heard before the current source started. */
  offset: number;
  /** Context time the current source started (null while held). */
  startedAt: number | null;
  src: AudioBufferSourceNode | null;
  gain: GainNode | null;
}

export class Dialogue {
  private line: Line | null = null;
  /** Bumped by every new line: a clip that finishes loading after its line was replaced is not played. */
  private serial = 0;
  private paused = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: AudioNode,
    private readonly bank: SpeechBank,
    private readonly tally?: NodeTally,
  ) {}

  /** The clip id that says `text` for `speaker`, or undefined for a line nobody recorded. */
  static clipOf(speaker: string, text: string): string | undefined {
    return SPEECH.dialogue[dialogueKey(speaker, text)];
  }

  /** Speaks the subtitle `text` of `speaker`, cutting the line before; an empty or unrecorded line only cuts. */
  say(speaker: string, text: string): Promise<void> {
    this.cut();
    const serial = ++this.serial;
    const id = text ? Dialogue.clipOf(speaker, text) : undefined;
    if (!id) return Promise.resolve();
    return this.bank.load(id).then(
      (buffer) => {
        if (serial !== this.serial) return;
        this.line = { buffer, phone: speaker.endsWith(' (phone)'), offset: 0, startedAt: null, src: null, gain: null };
        if (!this.paused) this.start(this.line);
      },
      () => undefined,
    );
  }

  /** Holds the line under the pause menu, or resumes it from where it stopped. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    const l = this.line;
    if (!l) return;
    if (!paused) {
      this.start(l);
      return;
    }
    if (l.startedAt !== null) l.offset += this.ctx.currentTime - l.startedAt;
    this.release(l);
  }

  /** Stops the line playing. */
  cut(): void {
    if (this.line) this.release(this.line);
    this.line = null;
  }

  private start(l: Line): void {
    const ctx = this.ctx;
    if (l.offset >= l.buffer.duration) {
      this.line = null;
      return;
    }
    const gain = ctx.createGain();
    gain.gain.value = l.phone ? PHONE_LEVEL : LEVEL;
    gain.connect(this.dest);
    let into: AudioNode = gain;
    if (l.phone) {
      for (const [type, hz] of [
        ['lowpass', 3400],
        ['highpass', 300],
      ] as const) {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = withinParam(f.frequency, hz);
        f.connect(into);
        into = f;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = l.buffer;
    src.connect(into);
    this.tally?.track('dialogue', src);
    src.start(ctx.currentTime, l.offset);
    l.src = src;
    l.gain = gain;
    l.startedAt = ctx.currentTime;
  }

  /** Fades the line's source out and stops it. */
  private release(l: Line): void {
    if (!l.src || !l.gain) return;
    const t = this.ctx.currentTime;
    const g = l.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + CUT);
    l.src.stop(t + CUT + 0.01);
    l.src = null;
    l.gain = null;
    l.startedAt = null;
  }
}
