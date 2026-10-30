// The player's vehicle: a firing-pulse engine voice per vehicle kind, an exhaust noise band,
// road roar, tyre squeal and scrub, and wind, plus the upshift dip.
// Every node is created once, and each frame only moves AudioParams.
// The engine's PeriodicWave is built once per vehicle kind.
//
//   slow noise -> jitter -> pulse oscillator frequency
//   pulse oscillator -> throttle low-pass -> body --+
//   noise -> exhaust band-pass -> exhaust gain -----+-> dip -> out
//   noise -> road band-pass (150-500 Hz) -> roar -----------> out
//   noise -> high-pass -> wind ------------------------------> out
//   noise -> two resonant band-passes -> flutter -> squeal --> out
//   noise -> wide band-pass -> scrub ------------------------> out
//   slow noise -> wobble -> band centres; slow noise -> flutter depth -> flutter gain
//
// The squeal is noise, not a tone: two steady tones a few hertz apart beat like a bell.
// Its bands wander and its level flutters with the noise buffer played back a few thousand times slower,
// a smooth random wave.

import type { Vehicle } from '../sim/entities';
import type { VehicleKind } from '../sim/specs';
import { Glider } from './mixer';
import { engineProfile, engineParams, engineWave, launchSlip, squealParams, SQUEAL_OVERTONE, type EngineParams, type SquealParams } from './vehicleProfiles';

/** The upshift dip: -6 dB for about 80 ms. */
export const SHIFT_DIP = { gain: 0.5, fall: 0.015, hold: 0.05, rise: 0.02 } as const;

/** Brings the narrow squeal bands (they pass a sliver of the noise) up to squealParams' levels. */
const SQUEAL_MAKEUP = 12;
/** How far the squeal bands wander around their centre, as a fraction of it. */
const SQUEAL_WOBBLE = 0.08;
/** Playback rates of the slow noise: the wobble wanders every ~140 ms, the stick-slip flutter every ~14 ms. */
const WOBBLE_RATE = 0.00015;
const FLUTTER_RATE = 0.0015;
/** The combustion jitter changes every ~2 ms, several times per cycle at any rpm. */
const JITTER_RATE = 0.01;

export class EngineVoice {
  private readonly osc: OscillatorNode;
  private readonly jitter: GainNode;
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
  private readonly squealLow: BiquadFilterNode;
  private readonly squealHigh: BiquadFilterNode;
  private readonly wobbleLow: GainNode;
  private readonly wobbleHigh: GainNode;
  private readonly flutterDepth: GainNode;
  private readonly squealGain: GainNode;
  private readonly scrubGain: GainNode;
  private readonly sq = {} as SquealParams;
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
    this.squealLow = filter('bandpass', 900, 12);
    this.squealHigh = filter('bandpass', 900 * SQUEAL_OVERTONE, 9);
    const squealHighGain = ctx.createGain();
    squealHighGain.gain.value = 0.45;
    const makeup = ctx.createGain();
    makeup.gain.value = SQUEAL_MAKEUP;
    const flutter = ctx.createGain();
    flutter.gain.value = 1;
    this.squealGain = gain();
    const scrub = filter('bandpass', 700, 0.7);
    this.scrubGain = gain();
    this.wobbleLow = gain();
    this.wobbleHigh = gain();
    this.flutterDepth = gain();
    const loop = (rate: number, offset: number) => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(0, offset);
      return s;
    };
    const src = loop(1, 0);
    const wobble = loop(WOBBLE_RATE, 0.5);
    const chatter = loop(FLUTTER_RATE, 1.3);
    this.jitter = gain();
    loop(JITTER_RATE, 0.9).connect(this.jitter);
    this.jitter.connect(this.osc.frequency);

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
    src.connect(this.squealLow);
    src.connect(this.squealHigh);
    this.squealLow.connect(makeup);
    this.squealHigh.connect(squealHighGain);
    squealHighGain.connect(makeup);
    makeup.connect(flutter);
    flutter.connect(this.squealGain);
    this.squealGain.connect(out);
    src.connect(scrub);
    scrub.connect(this.scrubGain);
    this.scrubGain.connect(out);
    wobble.connect(this.wobbleLow);
    wobble.connect(this.wobbleHigh);
    this.wobbleLow.connect(this.squealLow.frequency);
    this.wobbleHigh.connect(this.squealHigh.frequency);
    chatter.connect(this.flutterDepth);
    this.flutterDepth.connect(flutter.gain);
    this.osc.start();
    this.levelNodes = [this.body, this.exhaustGain, this.roarGain, this.windGain, this.squealGain, this.scrubGain];
  }

  /** The vehicle kind whose wave is loaded (null before the first car). */
  get currentKind(): VehicleKind | null {
    return this.kind;
  }

  private setKind(kind: VehicleKind): void {
    this.kind = kind;
    let wave = this.waves.get(kind);
    if (!wave) {
      const { real, imag } = engineWave(engineProfile(kind));
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
    g.set(this.jitter.gain, p.jitterHz, now, 0.05);
    g.set(this.lowpass.frequency, p.lowpassHz, now, 0.06);
    g.set(this.body.gain, p.level, now, 0.06);
    g.set(this.exhaust.frequency, p.exhaustHz, now, 0.04);
    g.set(this.exhaustGain.gain, p.exhaustLevel, now, 0.06);
    g.set(this.roarGain.gain, v.airborne ? 0 : p.roar, now, 0.1);
    g.set(this.windGain.gain, p.wind, now, 0.15);
    const slip = Math.max(v.skid, launchSlip(v.controls.throttle, v.forwardSpeed, v.spec.accel, v.reversing));
    const sq = squealParams(slip, v.speed, v.airborne, v.braking && !v.reversing, soft, this.sq);
    g.set(this.squealLow.frequency, sq.hz, now, 0.08);
    g.set(this.squealHigh.frequency, sq.hz * SQUEAL_OVERTONE, now, 0.08);
    g.set(this.wobbleLow.gain, sq.hz * SQUEAL_WOBBLE, now, 0.1);
    g.set(this.wobbleHigh.gain, sq.hz * SQUEAL_OVERTONE * SQUEAL_WOBBLE, now, 0.1);
    g.set(this.flutterDepth.gain, sq.flutter, now, 0.1);
    // Fast attack, quick release: a squeal starts with the slide and stops with it.
    g.set(this.squealGain.gain, sq.level, now, 0.025);
    g.set(this.scrubGain.gain, sq.scrub, now, 0.04);
    const gear = v.gear;
    // Upshifts under power only; the sim's gear follows speed, so ignore flicker at a boundary.
    if (gear > this.gear && v.controls.throttle > 0.1 && !v.airborne && now - this.lastDip > 0.4) this.shiftDip(now);
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
