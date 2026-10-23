// Gunfire echo by district: the space a shot is fired in decides its tail. Downtown's glass canyons throw back
// a run of slapback echoes and a long reverberant tail; the open beach gives almost none.
// Each space is one ConvolverNode with a generated impulse response (diffuse exponential tail plus discrete slaps),
// built on first use and kept; a shot sends into it through a gain of its own.

import { Rng } from '../core/rng';
import type { District } from '../world/layout';
import type { NodeTally } from './tally';

export type ShotDistrict = District | 'beach' | 'sea';
export type EchoSpace = 'canyon' | 'city' | 'yard' | 'street' | 'suburb' | 'shore' | 'open';

export interface EchoParams {
  space: EchoSpace;
  /** Seconds before the first reflection. */
  preDelay: number;
  /** Seconds for the diffuse tail to fall 60 dB (RT60). */
  decay: number;
  /** Send level of the tail relative to the dry shot. */
  level: number;
  /** One-pole low-pass of the reflections, Hz. */
  lowpass: number;
  /** Discrete slapback echoes: [delay s, relative gain]. */
  slaps: ReadonlyArray<readonly [number, number]>;
}

const SPACES: Readonly<Record<EchoSpace, EchoParams>> = {
  canyon: {
    space: 'canyon',
    preDelay: 0.025,
    decay: 2.4,
    level: 0.5,
    lowpass: 4500,
    slaps: [
      [0.07, 0.55],
      [0.13, 0.42],
      [0.21, 0.3],
      [0.32, 0.18],
      [0.46, 0.1],
    ],
  },
  city: {
    space: 'city',
    preDelay: 0.03,
    decay: 1.7,
    level: 0.4,
    lowpass: 4000,
    slaps: [
      [0.09, 0.45],
      [0.19, 0.25],
      [0.33, 0.12],
    ],
  },
  // Warehouses and container stacks: fewer, later slaps.
  yard: {
    space: 'yard',
    preDelay: 0.04,
    decay: 1.9,
    level: 0.36,
    lowpass: 3500,
    slaps: [
      [0.16, 0.5],
      [0.35, 0.3],
      [0.6, 0.15],
    ],
  },
  street: {
    space: 'street',
    preDelay: 0.03,
    decay: 1.1,
    level: 0.28,
    lowpass: 4000,
    slaps: [
      [0.08, 0.35],
      [0.18, 0.18],
    ],
  },
  suburb: { space: 'suburb', preDelay: 0.04, decay: 0.8, level: 0.18, lowpass: 3000, slaps: [[0.12, 0.2]] },
  shore: { space: 'shore', preDelay: 0.05, decay: 0.6, level: 0.12, lowpass: 3000, slaps: [[0.15, 0.12]] },
  open: { space: 'open', preDelay: 0.06, decay: 0.35, level: 0.05, lowpass: 2500, slaps: [] },
};

const DISTRICT_SPACE: Readonly<Record<ShotDistrict, EchoSpace>> = {
  downtown: 'canyon',
  midtown: 'city',
  docks: 'yard',
  southgate: 'street',
  westside: 'street',
  hillcrest: 'suburb',
  park: 'suburb',
  beachfront: 'shore',
  beach: 'open',
  sea: 'open',
};

/** The echo of a shot fired in `district` (unknown districts sound like a plain street). */
export function gunEcho(district: string): EchoParams {
  return SPACES[DISTRICT_SPACE[district as ShotDistrict] ?? 'street'];
}

/** Share of the impulse response's energy in the slaps (the rest is the diffuse tail). */
const SLAP_SHARE = 0.4;

/**
 * Stereo impulse response for `p` at `rate` Hz with unit energy per channel: a 3 ms smeared impulse per slap and an
 * exponentially decaying noise tail from the pre-delay to the RT60, both through a one-pole low-pass.
 */
export function echoImpulse(p: EchoParams, rate: number, seed = 1): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const len = Math.max(1, Math.ceil((p.preDelay + p.decay) * rate));
  const r = new Rng(seed);
  const out: Float32Array<ArrayBuffer>[] = [];
  const a = Math.exp((-2 * Math.PI * p.lowpass) / rate);
  for (let ch = 0; ch < 2; ch++) {
    const tail = new Float32Array(len);
    const slaps = new Float32Array(len);
    const pre = Math.floor(p.preDelay * rate);
    const fade = Math.max(1, Math.floor(0.01 * rate));
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate;
      tail[i] = (r.next() * 2 - 1) * Math.exp((-6.9078 * t) / p.decay) * Math.min(1, (i - pre) / fade);
    }
    const smear = Math.max(1, Math.floor(0.003 * rate));
    for (const [d, g] of p.slaps) {
      // Left and right walls answer a little apart.
      const at = Math.floor((d + (ch ? 0.004 : 0)) * rate);
      for (let k = 0; k < smear && at + k < len; k++) slaps[at + k]! += g * (r.next() * 2 - 1) * Math.exp(-k / (smear / 3));
    }
    const energy = (x: Float32Array) => {
      let s = 0;
      for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
      return s;
    };
    const et = energy(tail);
    const es = energy(slaps);
    const kt = et > 0 ? Math.sqrt((es > 0 ? 1 - SLAP_SHARE : 1) / et) : 0;
    const ks = es > 0 ? Math.sqrt(SLAP_SHARE / es) : 0;
    const ir = new Float32Array(len);
    let y = 0;
    for (let i = 0; i < len; i++) {
      y = (1 - a) * (tail[i]! * kt + slaps[i]! * ks) + a * y;
      ir[i] = y;
    }
    const e = energy(ir);
    if (e > 0) {
      const k = 1 / Math.sqrt(e);
      for (let i = 0; i < len; i++) ir[i]! *= k;
    }
    out.push(ir);
  }
  return [out[0]!, out[1]!];
}

/**
 * Seconds until the energy envelope of `ir` (in `win`-second windows) has fallen `db` below its loudest window and stays
 * there.
 */
export function decayTime(ir: Float32Array, rate: number, db = 30, win = 0.01): number {
  const n = Math.max(1, Math.floor(win * rate));
  const env: number[] = [];
  for (let i = 0; i < ir.length; i += n) {
    let s = 0;
    for (let k = i; k < Math.min(ir.length, i + n); k++) s += ir[k]! * ir[k]!;
    env.push(s / n);
  }
  let peak = 0;
  for (const e of env) peak = Math.max(peak, e);
  const floor = peak * Math.pow(10, -db / 10);
  let last = 0;
  for (let i = 0; i < env.length; i++) if (env[i]! > floor) last = i;
  return ((last + 1) * n) / rate;
}

/** One convolver per space, created on first use. */
export class EchoBank {
  private readonly spaces = new Map<EchoSpace, GainNode>();
  readonly enabled: boolean;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: AudioNode,
    private readonly tally?: NodeTally,
  ) {
    this.enabled = typeof (ctx as { createConvolver?: unknown }).createConvolver === 'function';
  }

  private input(p: EchoParams): GainNode {
    let g = this.spaces.get(p.space);
    if (g) return g;
    const ctx = this.ctx;
    const [l, r] = echoImpulse(p, ctx.sampleRate, 7 + p.space.length);
    const buf = ctx.createBuffer(2, l.length, ctx.sampleRate);
    buf.getChannelData(0).set(l);
    buf.getChannelData(1).set(r);
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = buf;
    g = ctx.createGain();
    g.connect(conv);
    conv.connect(this.dest);
    this.spaces.set(p.space, g);
    return g;
  }

  /** Sends what `from` plays into the echo of `district` at `gain` (relative to the space's level). Returns the send. */
  send(from: AudioNode, district: string, gain = 1): GainNode | null {
    if (!this.enabled || !(gain > 0) || !Number.isFinite(gain)) return null;
    const p = gunEcho(district);
    const s = this.ctx.createGain();
    s.gain.value = p.level * gain;
    from.connect(s);
    s.connect(this.input(p));
    if (this.tally) {
      this.tally.started.echo = (this.tally.started.echo ?? 0) + 1;
    }
    return s;
  }

  /** Spaces built so far (one convolver each). */
  get built(): number {
    return this.spaces.size;
  }
}
