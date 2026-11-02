// The countryside's voices (lifeSounds.ts says what there is to hear): the crop-duster's radial engine, heard rising and
// falling as it passes (doppler.ts), the combine's diesel and its threshing, the balloon's burner roaring in its flares,
// and the one-shots, a crow's caw and the dairy dog's bark, panned, quieter and duller with distance like any world sound.
//
//   saw -> lowpass -+
//   square -> lowpass +-> engine gain -+
//   noise -> bandpass -> slash gain ---+-> air low-pass -> panner -> effects bus   (slash gain beaten by the blades)

import { clamp } from '../core/math';
import { dopplerFactor } from './doppler';
import type { Placement, Outlet } from './barks';
import type { LifeSounds, LifeSource } from './lifeSounds';
import { distanceCutoff, type Glider } from './mixer';
import type { NodeTally } from './tally';
import type { Hearing } from './trainVoice';

/** Heard out to this many metres. */
const PLANE_RANGE = 900;
const COMBINE_RANGE = 420;
const BURNER_RANGE = 600;
/** Time constant (s) of the level and pitch glides. */
const GLIDE = 0.12;
/** The engine's pitch at rest (Hz): a radial's firing, and the beat of its two blades. */
const PLANE_HZ = 78;
const COMBINE_HZ = 34;

/** Loudness at `d` m of a source whose level is 1 at `ref` m. */
function falloff(d: number, ref: number): number {
  return 1 / (1 + Math.pow(d / ref, 1.6));
}

/** One engine: a source graph into a gain, an air low-pass and a pan, always running, its gain 0 out of earshot. */
class Voice {
  readonly gain: GainNode;
  readonly air: BiquadFilterNode;
  readonly pan: StereoPannerNode | null;

  constructor(ctx: BaseAudioContext, out: AudioNode) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.air = ctx.createBiquadFilter();
    this.air.type = 'lowpass';
    this.air.frequency.value = 20000;
    this.pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    this.gain.connect(this.air);
    this.air.connect(this.pan ?? out);
    this.pan?.connect(out);
  }
}

export class FieldVoices {
  private readonly plane: Voice;
  private readonly planeSaw: OscillatorNode;
  private readonly planeSub: OscillatorNode;
  private readonly planeBlades: OscillatorNode;
  private readonly planeSlash: GainNode;
  private readonly planeBeat: GainNode;
  private readonly planeNoiseF: BiquadFilterNode;
  private readonly combine: Voice;
  private readonly combineSaw: OscillatorNode;
  private readonly combineThresh: OscillatorNode;
  private readonly combineNoise: GainNode;
  private readonly combineBeat: GainNode;
  private readonly burner: Voice;
  private readonly burnerF: BiquadFilterNode;
  /** The Doppler factor last applied to the plane, and the levels last set, for tests. */
  doppler = 1;
  readonly levels = { plane: 0, combine: 0, burner: 0 };

  constructor(
    private readonly ctx: BaseAudioContext,
    out: AudioNode,
    private readonly noise: AudioBuffer,
    private readonly glide: Glider,
    private readonly spatial: Placement,
    private readonly outlet: Outlet,
    private readonly nodes: NodeTally,
  ) {
    const osc = (type: OscillatorType, hz: number) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      return o;
    };
    const filter = (type: BiquadFilterType, hz: number, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      return f;
    };
    const gain = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const hiss = () => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      s.start();
      return s;
    };

    // The crop-duster: the engine's firing (a saw and, an octave down, a square), the blades' slash of air beaten at their rate.
    this.plane = new Voice(ctx, out);
    this.planeSaw = osc('sawtooth', PLANE_HZ);
    this.planeSub = osc('square', PLANE_HZ / 2);
    this.planeBlades = osc('sine', PLANE_HZ);
    const sawLp = filter('lowpass', 1100);
    const subLp = filter('lowpass', 320);
    this.planeNoiseF = filter('bandpass', 1700, 0.8);
    this.planeSlash = gain(0);
    this.planeBeat = gain(0);
    this.planeSaw.connect(sawLp);
    sawLp.connect(this.plane.gain);
    this.planeSub.connect(subLp);
    subLp.connect(this.plane.gain);
    const slash = hiss();
    slash.connect(this.planeNoiseF);
    this.planeNoiseF.connect(this.planeSlash);
    this.planeSlash.connect(this.plane.gain);
    this.planeBlades.connect(this.planeBeat);
    this.planeBeat.connect(this.planeSlash.gain);
    this.planeSaw.start();
    this.planeSub.start();
    this.planeBlades.start();

    // The combine: a diesel's low saw and the threshing drum's beat on a bed of noise.
    this.combine = new Voice(ctx, out);
    this.combineSaw = osc('sawtooth', COMBINE_HZ);
    this.combineThresh = osc('sine', 6.5);
    const dieselLp = filter('lowpass', 190);
    const bedLp = filter('lowpass', 520);
    this.combineNoise = gain(0);
    this.combineBeat = gain(0);
    this.combineSaw.connect(dieselLp);
    dieselLp.connect(this.combine.gain);
    const bed = hiss();
    bed.connect(bedLp);
    bedLp.connect(this.combineNoise);
    this.combineNoise.connect(this.combine.gain);
    this.combineThresh.connect(this.combineBeat);
    this.combineBeat.connect(this.combineNoise.gain);
    this.combineSaw.start();
    this.combineThresh.start();

    // The burner: a roar of gas, a rumble under it.
    this.burner = new Voice(ctx, out);
    this.burnerF = filter('bandpass', 760, 0.55);
    const roar = hiss();
    const rumbleLp = filter('lowpass', 130);
    const rumble = gain(0.9);
    roar.connect(this.burnerF);
    this.burnerF.connect(this.burner.gain);
    roar.connect(rumbleLp);
    rumbleLp.connect(rumble);
    rumble.connect(this.burner.gain);
  }

  /** Where `s` is heard from: its distance and pan (the listener `ear` faces yaw), the gain it has at `ref` m out to `range`. */
  private hear(s: LifeSource, ear: Hearing, ref: number, range: number): { gain: number; pan: number; cutoff: number } | null {
    const dx = s.x - ear.x;
    const dz = s.z - ear.z;
    const d = Math.hypot(dx, s.y - ear.y, dz);
    if (!(s.level > 0) || !(d < range)) return null;
    const hd = Math.hypot(dx, dz) || 1;
    return { gain: falloff(d, ref) * s.level, pan: clamp(((dx * -Math.cos(ear.yaw) + dz * Math.sin(ear.yaw)) / hd) * 0.8, -1, 1), cutoff: distanceCutoff(d) };
  }

  private place(v: Voice, h: { pan: number; cutoff: number } | null, now: number): void {
    this.glide.set(v.air.frequency, h ? h.cutoff : 20000, now, GLIDE);
    if (v.pan && h) this.glide.set(v.pan.pan, h.pan, now, GLIDE);
  }

  /** The engines at this moment (`now` the context's time), then the shots queued since the last frame. */
  update(s: LifeSounds, ear: Hearing, now: number): void {
    const g = this.glide;
    // The plane: pitched by its motion, its engine straining in a climb.
    const p = s.plane;
    const hp = this.hear(p, ear, 90, PLANE_RANGE);
    const f = hp ? dopplerFactor(p.x, p.z, p.vx, p.vz, ear.x, ear.z, ear.vx, ear.vz) : 1;
    this.doppler = f;
    const strain = 1 + 0.1 * clamp(p.vy / 8, -1, 1);
    this.levels.plane = hp ? 0.5 * hp.gain : 0;
    g.set(this.plane.gain.gain, this.levels.plane, now, GLIDE);
    g.set(this.planeSaw.frequency, PLANE_HZ * strain * f, now, GLIDE, 0.0005);
    g.set(this.planeSub.frequency, (PLANE_HZ / 2) * strain * f, now, GLIDE, 0.0005);
    g.set(this.planeBlades.frequency, PLANE_HZ * strain * f, now, GLIDE, 0.0005);
    g.set(this.planeNoiseF.frequency, 1700 * f, now, GLIDE, 0.0005);
    g.set(this.planeSlash.gain, hp ? 0.5 : 0, now, GLIDE);
    g.set(this.planeBeat.gain, hp ? 0.4 : 0, now, GLIDE);
    this.place(this.plane, hp, now);
    // The combine.
    const hc = this.hear(s.combine, ear, 30, COMBINE_RANGE);
    this.levels.combine = hc ? 0.42 * hc.gain : 0;
    g.set(this.combine.gain.gain, this.levels.combine, now, GLIDE);
    g.set(this.combineNoise.gain, hc ? 0.5 : 0, now, GLIDE);
    g.set(this.combineBeat.gain, hc ? 0.3 : 0, now, GLIDE);
    this.place(this.combine, hc, now);
    // The burner, whose flare comes and goes as the level does.
    const hb = this.hear(s.burner, ear, 40, BURNER_RANGE);
    this.levels.burner = hb ? 0.55 * hb.gain : 0;
    g.set(this.burner.gain.gain, this.levels.burner, now, 0.05);
    this.place(this.burner, hb, now);
    for (const shot of s.shots) {
      if (shot.kind === 'caw') this.caw(shot.x, shot.y, shot.z, now);
      else this.bark(shot.x, shot.y, shot.z, now);
    }
    s.shots.length = 0;
  }

  /** A crow's caw: a rough saw pitched down through two formants, beaten by the throat's rattle, a breath of noise on its front. */
  private caw(x: number, y: number, z: number, now: number): void {
    const s = this.spatial(x, y, z, 18, 360);
    if (!s) return;
    const ctx = this.ctx;
    const t = now + 0.01;
    const out = this.outlet(s.pan, s.cutoff);
    const f0 = 470 + Math.random() * 110;
    const len = 0.28 + Math.random() * 0.1;
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(f0 * 1.12, t);
    saw.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + len);
    const rattle = ctx.createOscillator();
    rattle.frequency.value = 62 + Math.random() * 18;
    const rattleDepth = ctx.createGain();
    rattleDepth.gain.value = 0.45;
    const voice = ctx.createGain();
    voice.gain.value = 0.55;
    rattle.connect(rattleDepth);
    rattleDepth.connect(voice.gain);
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.setValueAtTime(1150, t);
    formant.frequency.linearRampToValueAtTime(820, t + len);
    formant.Q.value = 2.4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.5 * s.gain, t + 0.03);
    env.gain.setValueAtTime(0.5 * s.gain, t + len * 0.55);
    env.gain.exponentialRampToValueAtTime(0.0005, t + len);
    env.gain.linearRampToValueAtTime(0, t + len + 0.02);
    saw.connect(voice);
    voice.connect(formant);
    formant.connect(env);
    const breath = ctx.createBufferSource();
    breath.buffer = this.noise;
    const breathF = ctx.createBiquadFilter();
    breathF.type = 'bandpass';
    breathF.frequency.value = 2400;
    breathF.Q.value = 0.9;
    const breathEnv = ctx.createGain();
    breathEnv.gain.setValueAtTime(0.12 * s.gain, t);
    breathEnv.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
    breath.connect(breathF);
    breathF.connect(breathEnv);
    breathEnv.connect(env);
    env.connect(out);
    for (const o of [saw, rattle]) {
      o.start(t);
      o.stop(t + len + 0.05);
      this.nodes.track('caw', o);
    }
    breath.start(t, Math.random() * 1.5);
    breath.stop(t + 0.12);
    this.nodes.track('caw', breath);
  }

  /** A dog's bark: a short saw dropping through a throat formant, a puff of noise on its front. */
  private bark(x: number, y: number, z: number, now: number): void {
    const s = this.spatial(x, y, z, 12, 280);
    if (!s) return;
    const ctx = this.ctx;
    const t = now + 0.01;
    const out = this.outlet(s.pan, s.cutoff);
    const f0 = 300 + Math.random() * 70;
    const len = 0.17;
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(f0 * 1.3, t);
    saw.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + len);
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.setValueAtTime(900, t);
    formant.frequency.linearRampToValueAtTime(560, t + len);
    formant.Q.value = 1.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.62 * s.gain, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0005, t + len);
    env.gain.linearRampToValueAtTime(0, t + len + 0.02);
    saw.connect(formant);
    formant.connect(lp);
    lp.connect(env);
    const puff = ctx.createBufferSource();
    puff.buffer = this.noise;
    const puffF = ctx.createBiquadFilter();
    puffF.type = 'bandpass';
    puffF.frequency.value = 1500;
    puffF.Q.value = 0.8;
    const puffEnv = ctx.createGain();
    puffEnv.gain.setValueAtTime(0.22 * s.gain, t);
    puffEnv.gain.exponentialRampToValueAtTime(0.0005, t + 0.06);
    puff.connect(puffF);
    puffF.connect(puffEnv);
    puffEnv.connect(env);
    env.connect(out);
    saw.start(t);
    saw.stop(t + len + 0.05);
    this.nodes.track('bark', saw);
    puff.start(t, Math.random() * 1.5);
    puff.stop(t + 0.08);
    this.nodes.track('bark', puff);
  }
}
