// Round 2 audio cluster: pure tests of the mix targets, the distance low-pass,
// the ambience targets, the engine voice parameters and StaticWorld.districtAt.
// The Web Audio graph itself is tested against the fake context in fix_frontend.test.ts;
// the round-2 fixes at the end (kill confirmation, radio duck, the player's own crashes, scrapes) use the small fake below.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ambienceTargets, IN_CAR, shoreInfo, type AmbienceDistrict, type AmbienceInput } from '../../src/audio/ambience';
import { AudioEngine } from '../../src/audio/audio';
import { dbToGain, distanceCutoff, EXPLOSION_DUCK_RANGE, gainToDb, Glider, MIX_DB, mixTargets, OPEN_HZ, softClipCurve, withinParam, type MixInput } from '../../src/audio/mixer';
import { ENGINE_PROFILES, engineParams, engineWave, launchSlip, squealParams, waveStats } from '../../src/audio/vehicleProfiles';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import type { VehicleKind } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import { beachOffsetAt, districtOf } from '../../src/world/layout';
import { input, makeSim, placeInCar, roadPoint, teleport, world } from './helpers';

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('mixTargets', () => {
  const base: MixInput = { inVehicle: false, radio: 0, subtitleActive: false, explosionDist: Infinity, paused: false, bigScreen: false };
  const mix = (over: Partial<MixInput>) => mixTargets({ ...base, ...over });

  it('on foot: every stage open, music at 0.8', () => {
    const m = mix({});
    expect(m).toMatchObject({ world: 1, vehicle: 1, vehiclePeakDb: 0, sfx: 1, sfxLowpass: OPEN_HZ, amb: 1, ambLowpass: OPEN_HZ, music: 0.8, ui: 1 });
    expect(m.vehicleHighpass).toBeLessThanOrEqual(20);
  });

  it('in a car without the radio: the world is muffled, the engine is not ducked', () => {
    const m = mix({ inVehicle: true });
    expect(m.vehicle).toBe(1);
    expect(m.vehiclePeakDb).toBe(0);
    expect(m.vehicleHighpass).toBeLessThanOrEqual(20);
    expect(close(gainToDb(m.sfx), -4)).toBe(true);
    expect(m.sfxLowpass).toBe(1800);
    expect(close(gainToDb(m.amb), -4)).toBe(true);
    expect(m.ambLowpass).toBe(1800);
    expect(m.music).toBe(0.8);
  });

  it('in a car with the radio on: the engine steps back under the music', () => {
    const m = mix({ inVehicle: true, radio: 1 });
    expect(close(gainToDb(m.vehicle), -7)).toBe(true);
    expect(m.vehicleHighpass).toBe(60);
    expect(m.vehiclePeakDb).toBe(-4);
    expect(m.music).toBe(1);
    expect(close(gainToDb(m.sfx), -4)).toBe(true);
    expect(m.sfxLowpass).toBe(1800);
  });

  it('a radio that can barely be heard ducks the engine only that much; one muted or off not at all', () => {
    const half = mix({ inVehicle: true, radio: 0.5 });
    expect(close(gainToDb(half.vehicle), -3.5)).toBe(true);
    expect(half.vehicleHighpass).toBeCloseTo(35, 9);
    expect(half.vehiclePeakDb).toBeCloseTo(-2, 9);
    for (const radio of [0, -1, NaN]) {
      const m = mix({ inVehicle: true, radio });
      expect(m.vehicle).toBe(1);
      expect(m.vehiclePeakDb).toBe(0);
      expect(m.vehicleHighpass).toBeLessThanOrEqual(20);
    }
    // A louder radio never ducks more than the full -7 dB, and on foot it changes nothing.
    expect(close(gainToDb(mix({ inVehicle: true, radio: 3 }).vehicle), -7)).toBe(true);
    expect(mix({ radio: 1 })).toMatchObject({ vehicle: 1, vehiclePeakDb: 0, music: 0.8 });
  });

  it('a subtitle ducks the music 9 dB and the ambience 6 dB', () => {
    const m = mix({ subtitleActive: true });
    expect(close(gainToDb(m.music / 0.8), -9)).toBe(true);
    expect(close(gainToDb(m.amb), -6)).toBe(true);
    expect(m.sfx).toBe(1);
    expect(m.vehicle).toBe(1);
    // On foot the ducked music stage is under the 0.35 the plan asks for.
    expect(m.music).toBeLessThanOrEqual(0.35);
  });

  it('an explosion within 60 m ducks the music 6 dB; one at 100 m does not', () => {
    const near = mix({ explosionDist: 20 });
    expect(close(gainToDb(near.music / 0.8), -6)).toBe(true);
    expect(near.music).toBeLessThanOrEqual(0.5);
    expect(mix({ explosionDist: EXPLOSION_DUCK_RANGE }).music).toBeLessThan(0.8);
    expect(mix({ explosionDist: 100 }).music).toBe(0.8);
    expect(near.amb).toBe(1);
  });

  it('a result card ducks everything but the UI 10 dB', () => {
    const m = mix({ bigScreen: true, inVehicle: true, radio: 1 });
    expect(close(gainToDb(m.vehicle), -7 - 10)).toBe(true);
    expect(close(gainToDb(m.sfx), -4 - 10)).toBe(true);
    expect(close(gainToDb(m.amb), -4 - 10)).toBe(true);
    expect(close(gainToDb(m.music), -10)).toBe(true);
    expect(m.ui).toBe(1);
  });

  it('ducks do not stack: the deepest one applies', () => {
    const m = mix({ subtitleActive: true, explosionDist: 10, bigScreen: true });
    expect(close(gainToDb(m.music / 0.8), MIX_DB.bigCard)).toBe(true);
    expect(close(gainToDb(m.amb), MIX_DB.bigCard)).toBe(true);
  });

  it('pausing closes the world stage', () => {
    expect(mix({ paused: true }).world).toBe(0);
  });
});

describe('distance low-pass', () => {
  it('falls monotonically with distance and never below 900 Hz', () => {
    let prev = Infinity;
    for (let d = 0; d <= 3000; d += 5) {
      const c = distanceCutoff(d);
      expect(c).toBeLessThanOrEqual(prev);
      expect(c).toBeGreaterThanOrEqual(900);
      prev = c;
    }
    expect(distanceCutoff(0)).toBe(OPEN_HZ);
    expect(close(distanceCutoff(120), 20000 * Math.exp(-1), 1e-6)).toBe(true);
    expect(distanceCutoff(5000)).toBe(900);
  });

  it('spatial() hands each one-shot the cutoff for its distance', () => {
    const audio = new AudioEngine();
    audio.setListener(0, 0, 0, 0);
    const spatial = (audio as unknown as { spatial: (x: number, y: number, z: number, ref: number, max: number) => { cutoff: number; dist: number } | null }).spatial.bind(audio);
    for (const d of [0, 30, 120, 250]) {
      const s = spatial(d, 0, 0, 14, 300)!;
      expect(s.dist).toBeCloseTo(d, 6);
      expect(s.cutoff).toBeCloseTo(distanceCutoff(d), 6);
    }
    expect(spatial(400, 0, 0, 14, 300)).toBe(null);
  });
});

describe('soft clip curve', () => {
  it('is linear below the knee, odd, monotonic and stays under full scale', () => {
    const c = softClipCurve(1024);
    expect(c.length).toBe(1024);
    for (let i = 0; i < c.length; i++) {
      const x = (i / 1023) * 2 - 1;
      if (Math.abs(x) <= 0.7) expect(c[i]).toBeCloseTo(x, 5);
      expect(Math.abs(c[i]!)).toBeLessThan(0.95);
      expect(c[i]).toBeCloseTo(-c[1023 - i]!, 5);
      if (i > 0) expect(c[i]!).toBeGreaterThan(c[i - 1]!);
    }
  });
});

describe('ambienceTargets', () => {
  const at = (over: Partial<AmbienceInput>) =>
    ambienceTargets({ district: 'midtown', hours: 12, shoreDist: 1000, height: 0, traffic: 0, inVehicle: false, ...over });

  it('the beach at sunset is surf, not crickets', () => {
    const b = world().bounds;
    const x = b.beachStartX + 20;
    const shore = shoreInfo(b, x, 0);
    expect(world().districtAt(x, 0)).toBe('beach');
    const l = at({ district: 'beach', hours: 18.6, shoreDist: shore.dist });
    expect(l.surf).toBeGreaterThan(0.6);
    expect(l.crickets).toBe(0);
    expect(l.gulls).toBeGreaterThan(0);
  });

  it('a park at 23 h is crickets, not birds', () => {
    const l = at({ district: 'park', hours: 23 });
    expect(l.crickets).toBeGreaterThan(0.5);
    expect(l.birds).toBe(0);
  });

  it('downtown at noon is city hum and murmur with few birds', () => {
    const l = at({ district: 'downtown', hours: 12 });
    expect(l.cityHum).toBeGreaterThan(0.6);
    expect(l.birds).toBeLessThan(0.2);
    expect(l.murmur).toBeGreaterThan(0.5);
    expect(at({ district: 'downtown', hours: 2 }).murmur).toBe(0);
  });

  it('birds sing 06-19 h and crickets 21-05 h only', () => {
    for (let h = 0; h < 24; h += 0.25) {
      const l = at({ district: 'park', hours: h });
      if (h < 6 || h >= 19) expect(l.birds).toBe(0);
      if (h >= 5 && h < 21) expect(l.crickets).toBe(0);
    }
    expect(at({ district: 'park', hours: 10 }).birds).toBe(1);
    expect(at({ district: 'hillcrest', hours: 1 }).crickets).toBeGreaterThan(0.5);
  });

  it('wind rises on roofs, surf with the shore, traffic wash with traffic', () => {
    expect(at({ height: 45 }).wind).toBeGreaterThan(at({ height: 0 }).wind + 0.5);
    // Street murmur fades high above the city.
    expect(at({ district: 'downtown', height: 100 }).murmur).toBeLessThan(0.3 * at({ district: 'downtown', height: 0 }).murmur);
    expect(at({ shoreDist: 20 }).surf).toBeGreaterThan(at({ shoreDist: 120 }).surf);
    expect(at({ shoreDist: 400 }).surf).toBe(0);
    expect(at({ traffic: 0.8 }).trafficWash).toBeCloseTo(0.8, 6);
    expect(at({ wanted: 2 }).siren).toBe(0);
  });

  it('every layer is at most 0.4 in a car', () => {
    const districts: AmbienceDistrict[] = ['downtown', 'midtown', 'hillcrest', 'westside', 'docks', 'southgate', 'beachfront', 'park', 'beach', 'sea'];
    for (const district of districts) {
      for (let h = 0; h < 24; h += 0.5) {
        const l = at({ district, hours: h, shoreDist: 0, height: 80, traffic: 1, inVehicle: true });
        for (const [k, v] of Object.entries(l)) {
          expect(v, `${district} ${h} ${k}`).toBeLessThanOrEqual(0.4);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
    }
    expect(IN_CAR).toBeCloseTo(dbToGain(-8), 9);
  });

  it('non-finite inputs give finite levels', () => {
    const l = at({ hours: NaN, shoreDist: NaN, height: NaN, traffic: NaN });
    for (const v of Object.values(l)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('shoreInfo', () => {
  it('finds the beach waterline east and the sea walls (60 m farther) elsewhere', () => {
    const b = world().bounds;
    const waterX = b.beachStartX + beachOffsetAt(WATER_Y);
    const beach = shoreInfo(b, b.beachStartX + 10, 0);
    expect(beach.dist).toBeCloseTo(waterX - (b.beachStartX + 10), 6);
    expect([beach.dirX, beach.dirZ]).toEqual([1, 0]);
    const west = shoreInfo(b, b.landMinX + 20, 0);
    expect(west.dist).toBeCloseTo(80, 6);
    expect([west.dirX, west.dirZ]).toEqual([-1, 0]);
    const north = shoreInfo(b, 0, b.landMinZ + 5);
    expect([north.dirX, north.dirZ]).toEqual([0, -1]);
    const sea = shoreInfo(b, b.beachEndX + 40, 0);
    expect(sea).toEqual({ dist: 0, dirX: 0, dirZ: 0 });
  });
});

describe('StaticWorld.districtAt', () => {
  it('matches districtOf at every block centre', () => {
    const w = world();
    for (const blk of w.layout.blocks) {
      const cx = (blk.rect.minX + blk.rect.maxX) / 2;
      const cz = (blk.rect.minZ + blk.rect.maxZ) / 2;
      expect(w.districtAt(cx, cz)).toBe(districtOf(blk.bi, blk.bj));
      expect(w.districtAt(cx, cz)).toBe(blk.district);
    }
  });

  it('gives roads and promenades the district of a neighbouring block', () => {
    const w = world();
    const l = w.layout;
    // On the avenue between two blocks: one of the two blocks' districts.
    const v = l.vLines[5]!;
    const blk = l.blocks.find((q) => q.bi === 4 && q.bj === 4)!;
    const cz = (blk.rect.minZ + blk.rect.maxZ) / 2;
    expect([districtOf(4, 4), districtOf(5, 4)]).toContain(w.districtAt(v.pos, cz));
    // The west promenade belongs to the westmost blocks.
    expect(w.districtAt(l.bounds.landMinX + 5, cz)).toBe(districtOf(0, 4));
  });

  it('is beach east of the city and sea past the waterline or off the coast', () => {
    const w = world();
    const b = w.bounds;
    for (const z of [-300, 0, 300]) {
      expect(w.districtAt(b.cityMaxX + 5, z)).toBe('beach');
      expect(w.districtAt(b.beachStartX + 20, z)).toBe('beach');
      expect(w.districtAt(b.beachEndX - 10, z)).toBe('sea');
      expect(w.districtAt(b.beachEndX + 60, z)).toBe('sea');
    }
    expect(w.districtAt(b.landMinX - 20, 0)).toBe('sea');
    expect(w.districtAt(0, b.landMinZ - 20)).toBe('sea');
    expect(w.districtAt(0, b.landMaxZ + 20)).toBe('sea');
    expect(w.districtAt(NaN, 0)).toBe('sea');
  });
});

describe('engine profiles', () => {
  const KINDS = Object.keys(ENGINE_PROFILES) as VehicleKind[];

  it('fires rpm * cylinders / 120 times a second', () => {
    for (const k of KINDS) {
      const p = ENGINE_PROFILES[k];
      const idle = engineParams(k, 0, 0, 0);
      const red = engineParams(k, 1, 1, 0);
      expect(idle.rpm).toBe(p.idleRpm);
      expect(red.rpm).toBe(p.redlineRpm);
      expect(idle.firingHz).toBeCloseTo((p.idleRpm * p.cylinders) / 120, 9);
      expect(red.firingHz).toBeCloseTo((p.redlineRpm * p.cylinders) / 120, 9);
      expect(idle.cycleHz).toBeCloseTo(p.idleRpm / 120, 9);
    }
  });

  it('small engines idle higher than big ones: compact > sedan > muscle > bus', () => {
    // The plan's "idle firing frequency" order holds for the idle speed and the engine-cycle pitch the oscillator runs at.
    // The firing rate itself rises with the cylinder count (a V8 fires faster than a three-cylinder).
    const idle = (k: VehicleKind) => engineParams(k, 0, 0, 0);
    expect(idle('compact').rpm).toBeGreaterThan(idle('sedan').rpm);
    expect(idle('sedan').rpm).toBeGreaterThan(idle('muscle').rpm);
    expect(idle('muscle').rpm).toBeGreaterThan(idle('bus').rpm);
    expect(idle('compact').cycleHz).toBeGreaterThan(idle('sedan').cycleHz);
    expect(idle('sedan').cycleHz).toBeGreaterThan(idle('muscle').cycleHz);
    expect(idle('muscle').cycleHz).toBeGreaterThan(idle('bus').cycleHz);
  });

  it('a bus is at least 3 dB louder than a compact', () => {
    for (const [r, th] of [[0, 0], [0.5, 0.5], [1, 1]] as const) {
      expect(gainToDb(engineParams('bus', r, th, 10).level) - gainToDb(engineParams('compact', r, th, 10).level)).toBeGreaterThanOrEqual(3);
    }
  });

  it('road roar grows with speed^1.2 (50 m/s is 4+ dB over 15 m/s) and 3 dB on soft ground', () => {
    const r15 = engineParams('sedan', 0.5, 0.5, 15).roar;
    const r50 = engineParams('sedan', 0.5, 0.5, 50).roar;
    expect(gainToDb(r50) - gainToDb(r15)).toBeGreaterThanOrEqual(4);
    expect(r50 / r15).toBeCloseTo(Math.pow(50 / 15, 1.2), 6);
    expect(gainToDb(engineParams('sedan', 0.5, 0.5, 15, true).roar) - gainToDb(r15)).toBeCloseTo(3, 6);
    expect(engineParams('sedan', 0.5, 0.5, 0).roar).toBe(0);
  });

  it('wind follows (speed / 50)^2; the throttle opens the low-pass and the exhaust band', () => {
    expect(engineParams('sports', 0.5, 0.5, 50).wind / engineParams('sports', 0.5, 0.5, 25).wind).toBeCloseTo(4, 6);
    for (const k of KINDS) {
      const off = engineParams(k, 0.5, 0, 20);
      const on = engineParams(k, 0.5, 1, 20);
      expect(off.lowpassHz).toBeGreaterThanOrEqual(600);
      expect(on.lowpassHz).toBeLessThanOrEqual(4000);
      expect(on.lowpassHz).toBeGreaterThan(off.lowpassHz);
      expect(off.exhaustHz).toBeCloseTo(2 * off.firingHz, 6);
      expect(on.exhaustHz).toBeCloseTo(Math.min(6000, 4 * on.firingHz), 6);
      expect(on.exhaustLevel).toBeGreaterThan(off.exhaustLevel);
      expect(on.level).toBeGreaterThan(off.level);
    }
  });

  it('tyres squeal in wandering noise bands that rise with the slip and the speed, never in the air or on sand', () => {
    expect(squealParams(0.1, 20, false, false, false).level).toBe(0);
    const mid = squealParams(0.5, 20, false, false, false);
    const full = squealParams(1, 20, false, false, false);
    expect(mid.level).toBeGreaterThan(0);
    expect(full.level).toBeGreaterThan(mid.level);
    expect(full.hz).toBeGreaterThan(mid.hz);
    for (const p of [mid, full]) {
      expect(p.hz).toBeGreaterThanOrEqual(700);
      expect(p.hz).toBeLessThanOrEqual(1600);
    }
    expect(squealParams(1, 40, false, false, false).hz).toBeGreaterThan(full.hz);
    // Braking straight groans lower and chatters more than a slide.
    const brake = squealParams(0.5, 20, false, true, false);
    expect(brake.hz).toBeLessThan(mid.hz);
    expect(brake.flutter).toBeGreaterThan(mid.flutter);
    expect(squealParams(1, 20, true, false, false)).toMatchObject({ level: 0, scrub: 0 });
    const sand = squealParams(1, 20, false, false, true);
    expect(sand.level).toBe(0);
    expect(sand.scrub).toBeGreaterThan(full.scrub);
  });

  it('a strong car floored from a standstill spins its tyres until about 8 m/s', () => {
    expect(launchSlip(1, 0, 15.5, false)).toBeGreaterThan(0.9);
    expect(launchSlip(1, 4, 15.5, false)).toBeCloseTo(launchSlip(1, 0, 15.5, false) / 2, 6);
    expect(launchSlip(1, 8, 15.5, false)).toBe(0);
    expect(launchSlip(0.5, 0, 15.5, false)).toBe(0);
    expect(launchSlip(1, 0, 10.5, false)).toBe(0);
    expect(launchSlip(1, 0, 15.5, true)).toBe(0);
  });

  it('every engine wobbles a little from cycle to cycle, rough ones more', () => {
    const smooth = engineParams('sports', 0.5, 1, 20);
    const rough = engineParams('scooter', 0.5, 1, 20);
    expect(smooth.jitterHz / smooth.cycleHz).toBeGreaterThan(0.005);
    expect(rough.jitterHz / rough.cycleHz).toBeGreaterThan(smooth.jitterHz / smooth.cycleHz);
    expect(rough.jitterHz / rough.cycleHz).toBeLessThan(0.03);
  });

  it('builds a unit-RMS pulse wave whose V8 burble sits at half the firing frequency', () => {
    for (const k of KINDS) {
      const p = ENGINE_PROFILES[k];
      const w = engineWave(p);
      let power = 0;
      for (let h = 1; h <= 10 * p.cylinders; h++) power += (w.real[h]! ** 2 + w.imag[h]! ** 2) / 2;
      expect(power).toBeCloseTo(1, 4);
      expect(w.real[0]).toBe(0);
    }
    // Harmonic `cylinders / 2` of the cycle frequency is half the firing frequency.
    const half = (k: VehicleKind) => {
      const w = engineWave(ENGINE_PROFILES[k]);
      const h = ENGINE_PROFILES[k].cylinders / 2;
      return Math.hypot(w.real[h]!, w.imag[h]!);
    };
    expect(half('muscle')).toBeGreaterThan(3 * half('police'));
    // The pulses are sharp (crest factor well above a sine's 1.41) without being single clicks.
    const st = waveStats(engineWave(ENGINE_PROFILES.sedan).real, engineWave(ENGINE_PROFILES.sedan).imag, 1024);
    expect(st.peak / st.rms).toBeGreaterThan(2);
    expect(st.peak / st.rms).toBeLessThan(8);
  });
});

// ---------------------------------------------------------------------------
// Round-2 fixes, against a minimal fake Web Audio context (AudioParams record their last target).

class FParam {
  value: number;
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number): this {
    if (v === 0) throw new RangeError('exponential ramp to 0');
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class FNode {
  readonly outputs: unknown[] = [];
  constructor(readonly kind: string, props: Record<string, unknown> = {}) {
    Object.assign(this, props);
  }
  connect<T>(d: T): T {
    this.outputs.push(d);
    return d;
  }
  start(): void {}
  stop(): void {}
}

class FContext {
  static last: FContext | null = null;
  currentTime = 1;
  state = 'running';
  readonly sampleRate = 8000;
  readonly destination = new FNode('destination');
  constructor() {
    FContext.last = this;
  }
  createGain() {
    return new FNode('gain', { gain: new FParam(1) });
  }
  createDynamicsCompressor() {
    return new FNode('compressor', { threshold: new FParam(), knee: new FParam(), ratio: new FParam(), attack: new FParam(), release: new FParam() });
  }
  createBiquadFilter() {
    return new FNode('biquad', { type: 'lowpass', frequency: new FParam(350), Q: new FParam(1), gain: new FParam(0) });
  }
  createOscillator() {
    return new FNode('oscillator', { type: 'sine', frequency: new FParam(440), detune: new FParam(0), setPeriodicWave() {} });
  }
  createBufferSource() {
    return new FNode('source', { buffer: null, loop: false, playbackRate: new FParam(1) });
  }
  createStereoPanner() {
    return new FNode('panner', { pan: new FParam(0) });
  }
  createDelay() {
    return new FNode('delay', { delayTime: new FParam(0) });
  }
  createWaveShaper() {
    return new FNode('waveshaper', { curve: null, oversample: 'none' });
  }
  createAnalyser() {
    return new FNode('analyser', { fftSize: 2048, getFloatTimeDomainData: (b: Float32Array) => b.fill(0) });
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array): unknown {
    return { real, imag };
  }
  createBuffer(_channels: number, length: number): unknown {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

describe('round-2 audio fixes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  type Internals = {
    out: (pan: number, cutoff?: number, bus?: unknown) => unknown;
    noiseBurst: (...a: unknown[]) => void;
    tone: (...a: unknown[]) => void;
    uiBus: unknown;
    sfx: unknown;
    vehicleBus: unknown;
  };

  /** An unlocked engine on a sim, the listener a few metres behind the player; `frames` runs sim and audio together. */
  function rig(sim: Sim = makeSim({ police: false })) {
    vi.stubGlobal('window', { AudioContext: FContext });
    const audio = new AudioEngine();
    audio.unlock();
    const ctx = FContext.last!;
    audio.attach(sim);
    const inner = audio as unknown as Internals;
    const listen = () => {
      const p = sim.playerPos();
      audio.setListener(p.x, p.y + 2, p.z - 5, 0);
    };
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) {
        ctx.currentTime += 1 / 60;
        sim.update(1 / 60, sim.lastInput);
        listen();
        audio.update(1 / 60, sim, true);
      }
    };
    listen();
    return { sim, audio, ctx, inner, frames };
  }

  it('a blast that kills six people plays one kill confirmation (one thump, one tick), not six in phase', () => {
    const { sim, audio, inner } = rig();
    const p = sim.player;
    const victims: Character[] = [];
    for (let i = 0; i < 6; i++) {
      const c = sim.spawnCharacter('civilian', p.pos.x + 6 + Math.cos(i) * 0.8, p.pos.z + Math.sin(i) * 0.8);
      victims.push(c);
    }
    const confirm = vi.spyOn(audio, 'hitConfirm');
    const tone = vi.spyOn(inner, 'tone');
    sim.combat.explosion(p.pos.x + 6, p.pos.y + 0.5, p.pos.z, 7.5, 420, p, null);
    expect(victims.every((c) => !c.alive)).toBe(true);
    tone.mockClear();
    audio.update(1 / 60, sim, true);
    expect(confirm.mock.calls.map((c) => c[0])).toEqual(['kill']);
    const ui = tone.mock.calls.filter((c) => c[0] === inner.uiBus);
    expect(ui.length).toBe(2);
    expect(ui.filter((c) => c[3] === 90).length).toBe(1);
    // A frame with only a headshot still cracks; the next empty frame plays nothing.
    const civ = sim.spawnCharacter('civilian', p.pos.x - 4, p.pos.z);
    sim.events.emit('damage', { victim: civ, attacker: p, healthLoss: 20, armourLoss: 0, kind: 'bullet', zone: 'head', killed: false, dirX: 1, dirZ: 0 });
    sim.events.emit('damage', { victim: civ, attacker: p, healthLoss: 20, armourLoss: 0, kind: 'bullet', zone: 'body', killed: false, dirX: 1, dirZ: 0 });
    audio.update(1 / 60, sim, true);
    expect(confirm.mock.calls.map((c) => c[0])).toEqual(['kill', 'head']);
    audio.update(1 / 60, sim, true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('music at 0 or the radio off does not duck the engine; at the default music volume it is the full 7 dB', () => {
    const sim = makeSim({ police: false });
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    placeInCar(sim, v);
    const { audio, frames } = rig(sim);
    const mixer = audio.mixer!;
    const db = (g: number) => 20 * Math.log10(g);
    // Default volumes (music 0.6): the radio plays and the engine steps back under it.
    frames(30);
    expect(audio.radio.playing).toBe(true);
    expect(db(mixer.vehMix.gain.value)).toBeCloseTo(-7, 6);
    expect(mixer.vehHighpass.frequency.value).toBe(60);
    expect(mixer.vehPeak.gain.value).toBe(-4);
    // Music volume 0: the station still plays, but nobody hears it, so nothing is ducked.
    audio.setVolumes(0.8, 0, 0.85);
    frames(30);
    expect(audio.radio.playing).toBe(true);
    expect(mixer.vehMix.gain.value).toBe(1);
    expect(mixer.vehHighpass.frequency.value).toBe(10);
    expect(mixer.vehPeak.gain.value).toBe(0);
    // A quiet radio ducks it in proportion (music 0.15 is half of the full 0.3).
    audio.setVolumes(0.8, 0.15, 0.85);
    frames(30);
    expect(db(mixer.vehMix.gain.value)).toBeCloseTo(-3.5, 6);
    // Back to the default, then RADIO OFF.
    audio.setVolumes(0.8, 0.6, 0.85);
    frames(30);
    expect(db(mixer.vehMix.gain.value)).toBeCloseTo(-7, 6);
    while (audio.radio.stationName !== 'RADIO OFF') audio.radio.next();
    frames(30);
    expect(audio.radio.playing).toBe(false);
    expect(mixer.vehMix.gain.value).toBe(1);
  });

  it("the player's own crashes and scrapes play on the vehicle bus; other cars' through the muffled world bus", () => {
    const sim = makeSim({ police: false });
    const rp = roadPoint(sim);
    const mine = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    placeInCar(sim, mine);
    const other = sim.spawnVehicle('sedan', rp.x + 8, rp.z + 8, rp.heading);
    const { audio, inner, frames } = rig(sim);
    frames(5);
    const out = vi.spyOn(inner, 'out');
    const bus = () => out.mock.calls.at(-1)?.[2];
    const at = { x: mine.pos.x + 1, y: mine.pos.y + 0.6, z: mine.pos.z };
    sim.events.emit('impact', { ...at, strength: 12, vehicle: mine });
    expect(bus()).toBe(inner.vehicleBus);
    sim.events.emit('impact', { x: other.pos.x, y: other.pos.y + 0.6, z: other.pos.z, strength: 12, vehicle: other });
    expect(bus()).toBe(inner.sfx);
    // A person or a prop the player's car hits counts as his crash too; a blast thrown car does not.
    sim.events.emit('impact', { ...at, strength: 4, vehicle: mine });
    expect(bus()).toBe(inner.vehicleBus);
    sim.events.emit('impact', { ...at, strength: 12, vehicle: null });
    expect(bus()).toBe(inner.sfx);
    // Scrapes: counted, on the right bus.
    const n0 = audio.counters.scrapes;
    sim.events.emit('scrape', { ...at, speed: 14, vehicle: mine });
    expect(bus()).toBe(inner.vehicleBus);
    sim.events.emit('scrape', { x: other.pos.x, y: other.pos.y + 0.4, z: other.pos.z, speed: 14, vehicle: other });
    expect(bus()).toBe(inner.sfx);
    expect(audio.counters.scrapes).toBe(n0 + 2);
  });

  it('a retry taken 0.5 s into MISSION FAILED lifts its duck with the banner; a WASTED card keeps its own', () => {
    const sim = makeSim({ police: false });
    sim.cheats.godMode = true;
    sim.progress.markDone('wheels');
    const { audio, ctx } = rig(sim);
    const mixer = audio.mixer!;
    const run = (seconds: number, inp = input()) => {
      for (let i = 0; i < Math.round(seconds * 60); i++) {
        ctx.currentTime += 1 / 60;
        sim.update(1 / 60, inp);
        audio.update(1 / 60, sim, true);
      }
    };
    run(0.1);
    // Hot Delivery from Lou's marker, failed at once.
    const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === 'delivery')!;
    teleport(sim, marker.x, marker.z);
    run(0.1);
    run(1 / 60, input({ interact: true }));
    expect(sim.missions.active?.def.id).toBe('delivery');
    // Past the title card (its duck is not a result card's).
    run(4);
    expect(mixer.sfxMix.gain.value).toBe(1);
    sim.missions.active!.fail('test');
    run(0.5);
    // MISSION FAILED is up: everything but the UI is 10 dB down.
    expect(mixer.sfxMix.gain.value).toBeCloseTo(dbToGain(MIX_DB.bigCard), 6);
    teleport(sim, sim.player.pos.x + 20, sim.player.pos.z);
    expect(sim.missions.retryNow()).toBe(true);
    let started = false;
    sim.events.on('missionStarted', () => (started = true));
    // Through the retry fade (1.2 s): the mission is back on, its MISSION FAILED gone, and so is the duck.
    run(1.25);
    expect(started).toBe(true);
    expect(sim.missions.active?.def.id).toBe('delivery');
    expect(mixer.sfxMix.gain.value).toBe(1);
    expect(mixer.musicMix.gain.value).toBeCloseTo(0.8, 6);
    // A mission starting leaves the other result cards' duck alone (the HUD keeps them up too).
    sim.events.emit('big', { text: 'WASTED', sub: '', style: 'wasted', duration: 4.5 });
    run(0.5);
    sim.events.emit('missionStarted', { id: 'delivery', title: 'Hot Delivery' });
    run(0.5);
    expect(mixer.sfxMix.gain.value).toBeCloseTo(dbToGain(MIX_DB.bigCard), 6);
  });

  it("a faster car grinding along the player's car sounds as his own scrape; two others grinding nearby do not", () => {
    const sim = makeSim({ police: false });
    const rp = roadPoint(sim);
    const fx = Math.sin(rp.heading);
    const fz = Math.cos(rp.heading);
    const lx = Math.cos(rp.heading);
    const lz = -Math.sin(rp.heading);
    const mine = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    placeInCar(sim, mine);
    // A cruiser just behind him on his left, its right flank a few centimetres into his left one.
    const unit = sim.spawnVehicle('police', rp.x - fx * 3, rp.z - fz * 3, rp.heading);
    const side = mine.halfW + unit.halfW - 0.03;
    unit.pos.x += lx * side;
    unit.pos.z += lz * side;
    const { audio, ctx } = rig(sim);
    const scrape = vi.spyOn(audio, 'scrape');
    const reported: Vehicle[] = [];
    sim.events.on('scrape', (e) => reported.push(e.vehicle));
    const run = (frames: number, push: () => void) => {
      for (let i = 0; i < frames; i++) {
        push();
        ctx.currentTime += 1 / 60;
        sim.update(1 / 60, sim.lastInput);
        audio.update(1 / 60, sim, true);
      }
    };
    // He rolls at 2 m/s; the cruiser slides past at 12 m/s, pressed into his flank.
    run(40, () => {
      mine.vel.x = fx * 2;
      mine.vel.z = fz * 2;
      unit.vel.x = fx * 12 - lx * 1.5;
      unit.vel.z = fz * 12 - lz * 1.5;
    });
    // The physics reports each grind as the faster car's scrape: every one of them is the player's own.
    expect(reported.length).toBeGreaterThan(3);
    expect(reported.every((v) => v === unit)).toBe(true);
    expect(scrape.mock.calls.length).toBe(reported.length);
    expect(scrape.mock.calls.every((c) => c[4] === true)).toBe(true);
    // Two other cars grinding along each other 8 m to his right: the world bus.
    scrape.mockClear();
    reported.length = 0;
    const rx = -lx;
    const rz = -lz;
    const a = sim.spawnVehicle('sedan', mine.pos.x + rx * 8, mine.pos.z + rz * 8, rp.heading);
    const b = sim.spawnVehicle('sedan', a.pos.x + rx * (2 * a.halfW - 0.03) - fx * 3, a.pos.z + rz * (2 * a.halfW - 0.03) - fz * 3, rp.heading);
    run(40, () => {
      mine.vel.x = 0;
      mine.vel.z = 0;
      unit.vel.x = 0;
      unit.vel.z = 0;
      a.vel.x = fx * 2;
      a.vel.z = fz * 2;
      b.vel.x = fx * 12 + lx * 1.5;
      b.vel.z = fz * 12 + lz * 1.5;
    });
    expect(reported.filter((v) => v === b).length).toBeGreaterThan(3);
    expect(scrape.mock.calls.length).toBeGreaterThan(3);
    expect(scrape.mock.calls.every((c) => c[4] === false)).toBe(true);
  });

  it('a car 4 cm from his grinding along a wall on its far side is not his scrape', () => {
    const sim = makeSim({ police: false });
    const rp = roadPoint(sim);
    const fx = Math.sin(rp.heading);
    const fz = Math.cos(rp.heading);
    const lx = Math.cos(rp.heading);
    const lz = -Math.sin(rp.heading);
    const mine = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    placeInCar(sim, mine);
    // Another sedan on his left, 4 cm clear of him, and a wall along its far (left) flank.
    const other = sim.spawnVehicle('sedan', rp.x + lx * (2 * mine.halfW + 0.04), rp.z + lz * (2 * mine.halfW + 0.04), rp.heading);
    const wx = other.pos.x + lx * (other.halfW + 0.15);
    const wz = other.pos.z + lz * (other.halfW + 0.15);
    const hx = Math.abs(lx) * 0.15 + Math.abs(fx) * 12;
    const hz = Math.abs(lz) * 0.15 + Math.abs(fz) * 12;
    sim.world.grid.addBox(wx - hx, wz - hz, wx + hx, wz + hz, other.pos.y - 0.5, other.pos.y + 3, 'wall');
    const { audio, ctx } = rig(sim);
    const scrape = vi.spyOn(audio, 'scrape');
    const reported: Array<Vehicle | null | undefined> = [];
    sim.events.on('scrape', (e) => {
      if (e.vehicle === other) reported.push(e.other);
    });
    for (let i = 0; i < 40; i++) {
      // He sits still; it slides along the wall at 12 m/s, pressed into it, away from him.
      mine.vel.x = 0;
      mine.vel.z = 0;
      other.vel.x = fx * 12 + lx * 0.5;
      other.vel.z = fz * 12 + lz * 0.5;
      ctx.currentTime += 1 / 60;
      sim.update(1 / 60, sim.lastInput);
      audio.update(1 / 60, sim, true);
    }
    expect(reported.length).toBeGreaterThan(3);
    expect(reported.every((o) => o == null)).toBe(true);
    expect(scrape.mock.calls.length).toBeGreaterThan(3);
    expect(scrape.mock.calls.every((c) => c[4] === false)).toBe(true);
  });

  it('a scrape grinds louder and higher the faster the car slides', () => {
    const { sim, inner } = rig();
    const p = sim.player;
    const noise = vi.spyOn(inner, 'noiseBurst');
    const grind = (speed: number) => {
      noise.mockClear();
      sim.events.emit('scrape', { x: p.pos.x + 3, y: p.pos.y + 0.4, z: p.pos.z, speed, vehicle: sim.spawnVehicle('sedan', p.pos.x + 3, p.pos.z, 0) });
      // The grind and its ring: two short band-passed bursts, the grind first.
      expect(noise).toHaveBeenCalledTimes(2);
      const c = noise.mock.calls[0]!;
      // noiseBurst(dest, t, dur, type, freq, q, gain, freqEnd).
      expect(c[3]).toBe('bandpass');
      expect(c[2] as number).toBeLessThan(0.2);
      return { hz: c[4] as number, gain: c[6] as number };
    };
    const slow = grind(5);
    const fast = grind(20);
    const faster = grind(30);
    expect(fast.gain).toBeGreaterThan(slow.gain * 2);
    expect(faster.gain).toBeCloseTo(fast.gain, 6);
    // The band centre is jittered by +-10% around a pitch that rises with speed.
    expect(fast.hz).toBeGreaterThan(slow.hz * 1.3);
    expect(faster.hz).toBeGreaterThan(fast.hz);
  });
});

describe('filter frequencies on a low-rate output', () => {
  // A 24 kHz context (Bluetooth headset in call mode) caps a filter's frequency at 12 kHz.
  const param = (maxValue?: number) => {
    const sent: number[] = [];
    return { sent, p: { maxValue, setTargetAtTime: (v: number) => sent.push(v) } as unknown as AudioParam };
  };

  it('caps a value at the param maximum and leaves values below it alone', () => {
    expect(withinParam(param(12000).p, OPEN_HZ)).toBe(12000);
    expect(withinParam(param(12000).p, 900)).toBe(900);
    expect(withinParam(param().p, OPEN_HZ)).toBe(OPEN_HZ);
  });

  it('never schedules a glide above the maximum', () => {
    const g = new Glider();
    const { p, sent } = param(12000);
    g.set(p, OPEN_HZ, 0, 0.1);
    g.set(p, 1800, 0.5, 0.1);
    expect(sent).toEqual([12000, 1800]);
    expect(g.target(p)).toBe(1800);
  });
});
