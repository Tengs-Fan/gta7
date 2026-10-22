// The mix: category buses, the pause stage, ducking and in-car muffling,
// then the master chain (bus compressor -> limiter -> tanh soft clip) that keeps the output inside full scale.
//
//   vehicleBus -> high-pass -> 120 Hz peaking cut -> vehMix -+
//   sfx        -> low-pass  -> sfxMix ----------------------+
//   ambBus     -> low-pass  -> ambMix ----------------------+-> pauseGain -+
//   musicBus   -> musicMix ---------------------------------+             |
//   uiBus -----------------------------------------------------------------+-> preMaster (master volume)
//     -> compressor -> limiter -> soft clip -> destination (+ analyser tap for tests)
//
// Bus gains carry the volume settings and are set immediately.
// The *Mix stages carry the mix targets below and move smoothly.
// Nothing here allocates nodes after construction.

import { dbToGain } from './vehicleProfiles';

export { dbToGain };

export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(1e-9, g));

/** A low-pass at this cutoff is transparent. */
export const OPEN_HZ = 20000;

/**
 * `v` capped at the param's own maximum. A filter's frequency maximum is the context's Nyquist rate, which is 12 kHz on
 * a 24 kHz output (Bluetooth headsets in call mode); Chrome warns on every value above it.
 */
export function withinParam(param: AudioParam, v: number): number {
  const max = param.maxValue;
  return typeof max === 'number' && v > max ? max : v;
}

/** Low-pass cutoff for a sound `d` metres away: the air absorbs the highs of distant sounds. */
export function distanceCutoff(d: number): number {
  return Math.max(900, OPEN_HZ * Math.exp(-Math.max(0, d) / 120));
}

/** Explosions closer than this duck the music. */
export const EXPLOSION_DUCK_RANGE = 60;

export const MIX_DB = {
  /** In a car with the radio playing (at a full music volume): the engine steps back under the music. */
  carRadioVehicle: -7,
  carRadioPeak: -4,
  /** World and ambience heard through the closed car. */
  carWorld: -4,
  subtitleMusic: -9,
  subtitleAmb: -6,
  explosionMusic: -6,
  /** Passed / failed / wasted / busted cards duck everything but the UI. */
  bigCard: -10,
} as const;

export interface MixInput {
  inVehicle: boolean;
  /** How present the car radio is: 0 off (or the music volume at 0) to 1 playing at a full music volume. */
  radio: number;
  subtitleActive: boolean;
  /** Distance of an explosion that is ducking the music; Infinity when none. */
  explosionDist: number;
  paused: boolean;
  /** A passed / failed / wasted / busted card is on screen. */
  bigScreen: boolean;
}

export interface MixTargets {
  /** Pause stage of the world, vehicle, ambience and music buses. */
  world: number;
  vehicle: number;
  vehicleHighpass: number;
  vehiclePeakDb: number;
  sfx: number;
  sfxLowpass: number;
  amb: number;
  ambLowpass: number;
  music: number;
  /** The UI bus is never ducked. */
  ui: number;
}

/** Gains (linear) and filter settings of the mix stages for a situation. Pure. */
export function mixTargets(i: MixInput, out?: MixTargets): MixTargets {
  const o = out ?? ({} as MixTargets);
  // The radio's share of the in-car treatment (the engine duck, its high-pass and the 120 Hz cut scale with it).
  const radio = i.inVehicle && i.radio > 0 ? Math.min(1, i.radio) : 0;
  const big = i.bigScreen ? MIX_DB.bigCard : 0;
  const car = i.inVehicle ? MIX_DB.carWorld : 0;
  // Ducks don't stack: the deepest one applies.
  const musicDuck = Math.min(i.subtitleActive ? MIX_DB.subtitleMusic : 0, i.explosionDist <= EXPLOSION_DUCK_RANGE ? MIX_DB.explosionMusic : 0, big);
  const ambDuck = Math.min(i.subtitleActive ? MIX_DB.subtitleAmb : 0, big);
  o.world = i.paused ? 0 : 1;
  o.vehicle = dbToGain(MIX_DB.carRadioVehicle * radio + big);
  o.vehicleHighpass = 10 + 50 * radio;
  o.vehiclePeakDb = radio > 0 ? MIX_DB.carRadioPeak * radio : 0;
  o.sfx = dbToGain(car + big);
  o.sfxLowpass = i.inVehicle ? 1800 : OPEN_HZ;
  o.amb = dbToGain(car + ambDuck);
  o.ambLowpass = i.inVehicle ? 1800 : OPEN_HZ;
  o.music = (radio > 0 ? 1 : 0.8) * dbToGain(musicDuck);
  o.ui = 1;
  return o;
}

/**
 * Moves AudioParams with setTargetAtTime, skipping changes too small to hear, so a steady state schedules nothing.
 * Non-finite targets are dropped (AudioParams throw on them).
 */
export class Glider {
  private readonly sent = new Map<AudioParam, number>();

  /** Changes within `relEps` of the last target (or `absEps` absolute) are skipped. */
  set(param: AudioParam, target: number, now: number, tau: number, relEps = 0.004, absEps = 1e-5): void {
    if (!Number.isFinite(target) || !Number.isFinite(now) || !(tau > 0)) return;
    target = withinParam(param, target);
    const last = this.sent.get(param);
    if (last !== undefined && Math.abs(target - last) <= Math.max(absEps, Math.abs(last) * relEps)) return;
    this.sent.set(param, target);
    param.setTargetAtTime(target, now, tau);
  }

  /** The last target scheduled for `param` (undefined before the first). */
  target(param: AudioParam): number | undefined {
    return this.sent.get(param);
  }

  /** Forget a param whose automation was replaced by explicit scheduling. */
  forget(param: AudioParam): void {
    this.sent.delete(param);
  }
}

/** A tanh soft clip that is linear up to 0.7 and never exceeds 0.93 (WaveShaper input beyond +-1 is clamped). */
export function softClipCurve(n = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(n);
  const knee = 0.7;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

export interface MixLevels {
  vehicle: number;
  sfx: number;
  amb: number;
  music: number;
}

export class Mixer {
  readonly vehicleBus: GainNode;
  readonly sfx: GainNode;
  readonly ambBus: GainNode;
  readonly musicBus: GainNode;
  readonly uiBus: GainNode;
  readonly pauseGain: GainNode;
  /** Sum of every bus; its gain is the master volume. */
  readonly preMaster: GainNode;
  readonly compressor: DynamicsCompressorNode;
  readonly limiter: DynamicsCompressorNode;
  readonly softClip: WaveShaperNode;
  /** Tap on the final output, for tests and meters. */
  readonly analyser: AnalyserNode;
  readonly vehHighpass: BiquadFilterNode;
  readonly vehPeak: BiquadFilterNode;
  readonly vehMix: GainNode;
  readonly sfxLowpass: BiquadFilterNode;
  readonly sfxMix: GainNode;
  readonly ambLowpass: BiquadFilterNode;
  readonly ambMix: GainNode;
  readonly musicMix: GainNode;
  private readonly glide = new Glider();

  constructor(private readonly ctx: BaseAudioContext, paused: boolean) {
    const gain = (v = 1) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const filter = (type: BiquadFilterType, hz: number, q = Math.SQRT1_2) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = withinParam(f.frequency, hz);
      f.Q.value = q;
      return f;
    };
    this.vehicleBus = gain();
    this.sfx = gain();
    this.ambBus = gain();
    this.musicBus = gain();
    this.uiBus = gain();
    this.vehHighpass = filter('highpass', 10);
    this.vehPeak = filter('peaking', 120, 1);
    this.vehPeak.gain.value = 0;
    this.vehMix = gain();
    this.sfxLowpass = filter('lowpass', OPEN_HZ);
    this.sfxMix = gain();
    this.ambLowpass = filter('lowpass', OPEN_HZ);
    this.ambMix = gain();
    this.musicMix = gain(0.8);
    this.pauseGain = gain(paused ? 0 : 1);
    this.preMaster = gain();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 6;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -2;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.08;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve(1024);
    clip.oversample = '2x';
    const an = ctx.createAnalyser();
    an.fftSize = 8192;
    this.compressor = comp;
    this.limiter = lim;
    this.softClip = clip;
    this.analyser = an;

    // The first connection of every node is its path to the speakers (tests walk it).
    this.vehicleBus.connect(this.vehHighpass);
    this.vehHighpass.connect(this.vehPeak);
    this.vehPeak.connect(this.vehMix);
    this.vehMix.connect(this.pauseGain);
    this.sfx.connect(this.sfxLowpass);
    this.sfxLowpass.connect(this.sfxMix);
    this.sfxMix.connect(this.pauseGain);
    this.ambBus.connect(this.ambLowpass);
    this.ambLowpass.connect(this.ambMix);
    this.ambMix.connect(this.pauseGain);
    this.musicBus.connect(this.musicMix);
    this.musicMix.connect(this.pauseGain);
    this.pauseGain.connect(this.preMaster);
    this.uiBus.connect(this.preMaster);
    this.preMaster.connect(comp);
    comp.connect(lim);
    lim.connect(clip);
    clip.connect(ctx.destination);
    clip.connect(an);
  }

  /** Volume settings (0..1); applied at once, like a fader. */
  setVolumes(master: number, music: number, sfx: number): void {
    this.preMaster.gain.value = master;
    this.vehicleBus.gain.value = sfx;
    this.sfx.gain.value = sfx;
    this.ambBus.gain.value = sfx;
    this.uiBus.gain.value = sfx;
    this.musicBus.gain.value = music;
  }

  /** The pause stage switches at once: update() does not run while the game is paused. */
  setPaused(paused: boolean): void {
    const t = this.ctx.currentTime;
    const g = this.pauseGain.gain;
    g.cancelScheduledValues(t);
    this.glide.forget(g);
    this.glide.set(g, paused ? 0 : 1, t, 0.05);
  }

  /**
   * Moves the mix stages toward `m`.
   * Ducks come in fast (an explosion's in 20 ms) and recover over about 1.2 s.
   * The in-car filters follow the door in about half a second.
   */
  update(m: MixTargets, now: number, explosionAttack: boolean): void {
    const g = this.glide;
    const level = (node: GainNode, target: number, attack: number, release = 0.4) => {
      const cur = g.target(node.gain) ?? node.gain.value;
      g.set(node.gain, target, now, target < cur ? attack : release);
    };
    // Same target and time constant as setPaused(), so the two never fight.
    g.set(this.pauseGain.gain, m.world, now, 0.05);
    level(this.vehMix, m.vehicle, 0.12);
    g.set(this.vehHighpass.frequency, m.vehicleHighpass, now, 0.15);
    g.set(this.vehPeak.gain, m.vehiclePeakDb, now, 0.15);
    level(this.sfxMix, m.sfx, 0.08, 0.2);
    g.set(this.sfxLowpass.frequency, m.sfxLowpass, now, 0.12);
    level(this.ambMix, m.amb, 0.1);
    g.set(this.ambLowpass.frequency, m.ambLowpass, now, 0.12);
    level(this.musicMix, m.music, explosionAttack ? 0.006 : 0.06);
  }

  /** Current gains of the mix stages (what the ducks and the in-car treatment are doing now). */
  levels(): MixLevels {
    return { vehicle: this.vehMix.gain.value, sfx: this.sfxMix.gain.value, amb: this.ambMix.gain.value, music: this.musicMix.gain.value };
  }
}
