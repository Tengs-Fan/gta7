// AzuraLink's sound: the train's rumble on its beam, its motors' whine, the hiss of its wheels and the whoosh of air as it
// passes, heard from the nearest point of its length and pitched by its motion (doppler.ts). It also says when a station's
// loudspeaker announces a departure, for the street voices (barks.ts) to play.
//
//   noise -> lowpass (rumble), highpass (hiss), bandpass (whoosh) -+-> panner -> effects bus
//   sawtooth -> lowpass (whine) -----------------------------------+

import { clamp } from '../core/math';
import { TRAIN_LENGTH, TRAIN_SPEED, trainAt, type Monorail } from '../world/monorail';
import { dopplerFactor } from './doppler';
import type { Glider } from './mixer';

/** Seconds before the doors close that a station's loudspeaker names the train's destination. */
export const PA_LEAD = 7;
/** It is played for a player within this many metres of the station's foot. */
export const PA_RANGE = 30;
/** Out of earshot beyond this (m). */
const RANGE = 260;
const RUMBLE_HZ = 150;
const HISS_HZ = 3200;
const WHOOSH_HZ = 650;
/** The motors' whine: its pitch at a standstill and how it rises with speed (Hz per m/s). */
const WHINE_HZ = 110;
const WHINE_RISE = 16;
/** Time constant (s) of the level and pitch glides. */
const GLIDE = 0.12;

export interface Hearing {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** The listener's velocity (he moves with the player). */
  vx: number;
  vz: number;
}

/** Loudness at `d` m of a source whose level is 1 at `ref` m. */
function falloff(d: number, ref: number): number {
  return 1 / (1 + Math.pow(d / ref, 1.6));
}

export class TrainVoice {
  private readonly src: AudioBufferSourceNode;
  private readonly whineOsc: OscillatorNode;
  private readonly rumbleF: BiquadFilterNode;
  private readonly hissF: BiquadFilterNode;
  private readonly whooshF: BiquadFilterNode;
  private readonly whineF: BiquadFilterNode;
  private readonly rumble: GainNode;
  private readonly hiss: GainNode;
  private readonly whoosh: GainNode;
  private readonly whine: GainNode;
  private readonly pan: StereoPannerNode | null;
  /** The dwell the train had at the last update (for the announcement), and the Doppler factor applied. */
  private lastDwell = 0;
  doppler = 1;
  /** The levels last set, for tests. */
  readonly levels = { rumble: 0, hiss: 0, whoosh: 0, whine: 0 };

  constructor(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, private readonly glide: Glider) {
    const filter = (type: BiquadFilterType, hz: number, q: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      return f;
    };
    const gain = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      return g;
    };
    this.pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    const dest = this.pan ?? out;
    this.pan?.connect(out);
    this.src = ctx.createBufferSource();
    this.src.buffer = noise;
    this.src.loop = true;
    this.rumbleF = filter('lowpass', RUMBLE_HZ, 0.9);
    this.hissF = filter('highpass', HISS_HZ, 0.7);
    this.whooshF = filter('bandpass', WHOOSH_HZ, 0.8);
    this.whineF = filter('lowpass', 900, 1.5);
    this.rumble = gain();
    this.hiss = gain();
    this.whoosh = gain();
    this.whine = gain();
    for (const [f, g] of [[this.rumbleF, this.rumble], [this.hissF, this.hiss], [this.whooshF, this.whoosh]] as const) {
      this.src.connect(f);
      f.connect(g);
      g.connect(dest);
    }
    this.whineOsc = ctx.createOscillator();
    this.whineOsc.type = 'sawtooth';
    this.whineOsc.frequency.value = WHINE_HZ;
    this.whineOsc.connect(this.whineF);
    this.whineF.connect(this.whine);
    this.whine.connect(dest);
    this.src.start();
    this.whineOsc.start();
  }

  /**
   * The train at sim time `t` as heard by `ear`, `now` being the context's time. Returns the station (0 north, 1 south)
   * whose loudspeaker announces the train's departure this moment, or -1.
   */
  update(m: Monorail, t: number, ear: Hearing, now: number): number {
    const s = trainAt(m, t);
    // The nearest point of the train, its middle 1 m over the beam.
    const half = TRAIN_LENGTH / 2;
    const nz = clamp(ear.z, s.z - half, s.z + half);
    const sy = m.beamY + 1;
    const d = Math.hypot(m.x - ear.x, sy - ear.y, nz - ear.z);
    const k = s.speed / TRAIN_SPEED;
    const near = d < RANGE;
    const f = near ? dopplerFactor(m.x, nz, 0, s.dir * s.speed, ear.x, ear.z, ear.vx, ear.vz) : 1;
    this.doppler = f;
    const lv = this.levels;
    lv.rumble = near ? (0.06 + 0.45 * k) * falloff(d, 22) : 0;
    lv.hiss = near ? 0.14 * k * falloff(d, 10) : 0;
    lv.whoosh = near ? (0.32 * k) / (1 + (d / 7) ** 2) : 0;
    lv.whine = near ? 0.035 * (0.25 + k) * falloff(d, 14) : 0;
    const g = this.glide;
    g.set(this.rumble.gain, lv.rumble, now, GLIDE);
    g.set(this.hiss.gain, lv.hiss, now, GLIDE);
    g.set(this.whoosh.gain, lv.whoosh, now, GLIDE);
    g.set(this.whine.gain, lv.whine, now, GLIDE);
    g.set(this.src.playbackRate, f, now, GLIDE, 0.0005);
    g.set(this.rumbleF.frequency, RUMBLE_HZ * f, now, GLIDE, 0.0005);
    g.set(this.hissF.frequency, HISS_HZ * f, now, GLIDE, 0.0005);
    g.set(this.whooshF.frequency, WHOOSH_HZ * f, now, GLIDE, 0.0005);
    g.set(this.whineOsc.frequency, (WHINE_HZ + WHINE_RISE * s.speed) * f, now, GLIDE, 0.0005);
    if (this.pan) {
      const dx = m.x - ear.x;
      const dz = nz - ear.z;
      const hd = Math.hypot(dx, dz) || 1;
      g.set(this.pan.pan, clamp(((dx * -Math.cos(ear.yaw) + dz * Math.sin(ear.yaw)) / hd) * 0.8, -1, 1), now, GLIDE);
    }
    const announce = s.station >= 0 && s.dwell <= PA_LEAD && this.lastDwell > PA_LEAD ? s.station : -1;
    this.lastDwell = s.dwell;
    return announce;
  }
}
