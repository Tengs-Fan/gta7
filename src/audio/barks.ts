// Voices in the street: people, officers and gang members shouting recorded lines (speech.ts) where they stand, as
// world sounds (panned, quieter and duller with distance). A person keeps one voice and says one thing at a time; any
// two shouts are a beat apart, and every kind has its own cooldown, so a riot does not turn into a choir. A cruiser's
// loudspeaker (pullOver) comes through a horn's narrow band.
//
//   clip -> gain -> [megaphone: HP 500 -> LP 3000 -> drive] -> panner and distance low-pass -> effects bus

import type { Character } from '../sim/entities';
import { SPEECH, type BarkKind } from '../sim/speech';
import { withinParam } from './mixer';
import type { SpeechBank } from './speech';
import type { NodeTally } from './tally';

/** Gain, pan and distance low-pass of a sound at a point, null when out of earshot (AudioEngine.spatial). */
export type Placement = (x: number, y: number, z: number, ref: number, max: number) => { gain: number; pan: number; cutoff: number } | null;
/** The entry of a one-shot panned and filtered so (AudioEngine.out). */
export type Outlet = (pan: number, cutoff: number) => AudioNode;

/** Seconds before a kind of shout may come again. */
export const BARK_COOLDOWN: Readonly<Record<BarkKind, number>> = {
  greet: 12,
  hurt: 1.5,
  jacked: 2,
  panic: 2.5,
  rammed: 3,
  witness: 6,
  freeze: 5,
  shots: 4,
  officerDown: 6,
  pullOver: 7,
  arrest: 4,
  turf: 6,
  hail: 3,
  hailMissed: 5,
  cabbie: 2,
  farmer: 10,
  farmerAngry: 5,
  whisper: 60,
};
/** Seconds between any two shouts. */
export const BARK_GAP = 0.6;
const LEVEL = 0.9;
const MEGAPHONE_LEVEL = 1.3;
/** Heard out to this many metres; the loudspeaker carries further. */
const RANGE = 70;
const MEGAPHONE_RANGE = 110;

function megaphoneCurve(n = 256): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(3 * x) / Math.tanh(3);
  }
  return c;
}

/** The nearest living character within `r` metres of (x, z) that `pick` accepts. */
export function nearestCharacter(chars: readonly Character[], x: number, z: number, r: number, pick: (c: Character) => boolean): Character | null {
  let best: Character | null = null;
  let bd = r * r;
  for (const c of chars) {
    if (!c.alive || !pick(c)) continue;
    const d = (c.pos.x - x) ** 2 + (c.pos.z - z) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

export class Barks {
  private last = -Infinity;
  private readonly lastOf = new Map<BarkKind, number>();
  /** Until when each speaker is still talking (by id). */
  private readonly busy = new Map<number, number>();
  private curve: Float32Array<ArrayBuffer> | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly bank: SpeechBank,
    private readonly place: Placement,
    private readonly outlet: Outlet,
    private readonly tally?: NodeTally,
  ) {}

  /**
   * `who` (a character's or vehicle's id) shouts a line of `kind` at (x, y, z). Its voice is fixed by the id. False when
   * the shout is held back (too soon, still talking, out of earshot).
   */
  say(kind: BarkKind, who: number, x: number, y: number, z: number): boolean {
    const now = this.ctx.currentTime;
    if (now - this.last < BARK_GAP || now - (this.lastOf.get(kind) ?? -Infinity) < BARK_COOLDOWN[kind] || now < (this.busy.get(who) ?? 0)) return false;
    const megaphone = kind === 'pullOver';
    const s = this.place(x, y, z, megaphone ? 14 : 6, megaphone ? MEGAPHONE_RANGE : RANGE);
    if (!s) return false;
    const voices = SPEECH.barks[kind];
    const lines = voices[Math.abs(who) % voices.length]!;
    const id = lines[Math.floor(Math.random() * lines.length)]!;
    this.last = now;
    this.lastOf.set(kind, now);
    if (this.busy.size > 200) for (const [k, t] of this.busy) if (t < now) this.busy.delete(k);
    this.busy.set(who, now + SPEECH.clips[id]! + 1);
    const out = this.outlet(s.pan, s.cutoff);
    const gain = (megaphone ? MEGAPHONE_LEVEL : LEVEL) * s.gain;
    this.bank.load(id).then(
      (buffer) => this.play(buffer, out, gain, megaphone),
      () => undefined,
    );
    return true;
  }

  private play(buffer: AudioBuffer, out: AudioNode, level: number, megaphone: boolean): void {
    const ctx = this.ctx;
    let into = out;
    if (megaphone) {
      const drive = ctx.createWaveShaper();
      drive.curve = this.curve ??= megaphoneCurve();
      drive.connect(into);
      into = drive;
      for (const [type, hz] of [
        ['lowpass', 3000],
        ['highpass', 500],
      ] as const) {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = withinParam(f.frequency, hz);
        f.connect(into);
        into = f;
      }
    }
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(into);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(g);
    this.tally?.track('voice', src);
    src.start(ctx.currentTime);
  }
}
