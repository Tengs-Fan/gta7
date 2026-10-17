// The player's vehicle: a firing-pulse engine voice per vehicle kind, an exhaust noise band,
// road roar, a tonal tyre squeal and wind, plus the upshift dip. Every node is created once;
// each frame only moves AudioParams, and the engine's PeriodicWave is built once per kind.
//
//   pulse oscillator -> throttle low-pass -> body --+
//   noise -> exhaust band-pass -> exhaust gain -----+-> dip -> out
//   noise -> road band-pass (150-500 Hz) -> roar -----------> out
//   noise -> high-pass -> wind ------------------------------> out
//   two triangles (900-1400 Hz) -> squeal -------------------> out

import type { Vehicle } from '../sim/entities';
import type { VehicleKind } from '../sim/specs';
import { Glider } from './mixer';
import { ENGINE_PROFILES, engineParams, engineWave, squealParams, type EngineParams } from './vehicleProfiles';

/** The upshift dip: -6 dB for about 80 ms. */
export const SHIFT_DIP = { gain: 0.5, fall: 0.015, hold: 0.05, rise: 0.02 } as const;

export class EngineVoice {
  private readonly osc: OscillatorNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly body: GainNode;
  private readonly exhaust: BiquadFilterNode;
  private readonly exhaustGain: GainNode;
  /** Gear-change dip on the engine (pulse and exhaust), scheduled explicitly. */
  readonly dip: GainNode;
  private readonly roarFilter: BiquadFilterNode;
  private readonly roarGain: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly windGain: GainNode;
  private readonly squeal1: OscillatorNode;
  private readonly squeal2: OscillatorNode;
  private readonly squealGain: GainNode;
  private readonly glide = new Glider();
  private readonly waves = new Map<VehicleKind, PeriodicWave>();
  private readonly p = {} as EngineParams;
  /** Every level stage, faded out together when the player leaves the car. */
  private readonly levelNodes: readonly GainNode[];
  private kind: VehicleKind | null = null;
  private vehicle: Vehicle | null = null;
  private gear = 1;
  private lastDip = -Infinity;
  /** Upshift dips scheduled so far (for tests). */
  dips = 0;
  /** PeriodicWaves built so far (for tests: one per kind driven). */
  wavesBuilt = 0;

  constructor(private readonly ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer) {
    const gain = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      return g;
    };
    const filter = (type: BiquadFilterType, hz: number, q: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      return f;
    };
    this.osc = ctx.createOscillator();
    this.osc.frequency.value = 7;
    this.lowpass = filter('lowpass', 900, 0.9);
    this.body = gain();
    this.exhaust = filter('bandpass', 200, 2.2);
    this.exhaustGain = gain();
    this.dip = ctx.createGain();
    this.dip.gain.value = 1;
    this.roarFilter = filter('bandpass', 275, 0.8);
    this.roarGain = gain();
    this.windFilter = filter('highpass', 650, 0.5);
    this.windGain = gain();
    this.squeal1 = ctx.createOscillator();
    this.squeal2 = ctx.createOscillator();
    this.squeal1.type = 'triangle';
    this.squeal2.type = 'triangle';
    this.squeal1.frequency.value = 900;
    this.squeal2.frequency.value = 940;
    this.squealGain = gain();
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;

    this.osc.connect(this.lowpass);
    this.lowpass.connect(this.body);
    this.body.connect(this.dip);
    src.connect(this.exhaust);
    this.exhaust.connect(this.exhaustGain);
    this.exhaustGain.connect(this.dip);
    this.dip.connect(out);
    src.connect(this.roarFilter);
    this.roarFilter.connect(this.roarGain);
    this.roarGain.connect(out);
    src.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(out);
    this.squeal1.connect(this.squealGain);
    this.squeal2.connect(this.squealGain);
    this.squealGain.connect(out);
    this.osc.start();
    this.squeal1.start();
    this.squeal2.start();
    src.start();
    this.levelNodes = [this.body, this.exhaustGain, this.roarGain, this.windGain, this.squealGain];
  }

  /** The vehicle kind whose wave is loaded (null before the first car). */
  get currentKind(): VehicleKind | null {
    return this.kind;
  }

  private setKind(kind: VehicleKind): void {
    this.kind = kind;
    let wave = this.waves.get(kind);
    if (!wave) {
      const { real, imag } = engineWave(ENGINE_PROFILES[kind]);
      wave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: true });
      this.waves.set(kind, wave);
      this.wavesBuilt++;
    }
    this.osc.setPeriodicWave(wave);
  }

  /**
   * Follows the player's vehicle (null when on foot, wrecked or sinking: everything fades out).
   * `soft` ground (sand, grass) roars louder.
   */
  update(v: Vehicle | null, now: number, soft: boolean): void {
    const g = this.glide;
    if (!v) {
      this.vehicle = null;
      for (const node of this.levelNodes) g.set(node.gain, 0, now, 0.08);
      return;
    }
    if (v.kind !== this.kind) this.setKind(v.kind);
    if (v !== this.vehicle) {
      // A new car starts in whatever gear it is in, without a shift.
      this.vehicle = v;
      this.gear = v.gear;
    }
    const p = engineParams(v.kind, v.rpm, v.controls.throttle, v.speed, soft, this.p);
    g.set(this.osc.frequency, p.cycleHz, now, 0.03, 0.002);
    g.set(this.lowpass.frequency, p.lowpassHz, now, 0.06);
    g.set(this.body.gain, p.level, now, 0.06);
    g.set(this.exhaust.frequency, p.exhaustHz, now, 0.04);
    g.set(this.exhaustGain.gain, p.exhaustLevel, now, 0.06);
    g.set(this.roarGain.gain, v.airborne ? 0 : p.roar, now, 0.1);
    g.set(this.windGain.gain, p.wind, now, 0.15);
    const sq = squealParams(v.skid, v.airborne);
    g.set(this.squeal1.frequency, sq.hz, now, 0.05);
    g.set(this.squeal2.frequency, sq.hz * 1.045, now, 0.05);
    g.set(this.squealGain.gain, sq.level, now, 0.04);
    const gear = Number.isFinite(v.gear) ? v.gear : this.gear;
    // Upshifts under power only; the sim's gear follows speed, so ignore flicker at a boundary.
    if (gear > this.gear && !v.airborne && now - this.lastDip > 0.4) this.shiftDip(now);
    this.gear = gear;
  }

  /** The ignition cut of an upshift: about -6 dB for 80 ms on the engine. */
  private shiftDip(now: number): void {
    const g = this.dip.gain;
    const d = SHIFT_DIP;
    g.cancelScheduledValues(now);
    g.setValueAtTime(1, now);
    g.linearRampToValueAtTime(d.gain, now + d.fall);
    g.setValueAtTime(d.gain, now + d.fall + d.hold);
    g.linearRampToValueAtTime(1, now + d.fall + d.hold + d.rise);
    this.lastDip = now;
    this.dips++;
  }
}
