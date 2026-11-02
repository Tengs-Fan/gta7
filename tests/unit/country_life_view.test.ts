// How Las Lomas County's life is drawn and heard (render/country/life, audio/fieldVoices.ts): a handful of draws, none
// at all and no sound while the camera is far from the farmland, fewer crows on the lower tiers, the cars and the player
// putting the birds and the dog up, the spray and the dust let off only where and when they should be, and all of it
// reading the sim without writing a thing to it.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { FieldVoices } from '../../src/audio/fieldVoices';
import { MAX_SHOTS, newLifeSounds, shoot } from '../../src/audio/lifeSounds';
import { Glider } from '../../src/audio/mixer';
import { NodeTally } from '../../src/audio/tally';
import type { Hearing } from '../../src/audio/trainVoice';
import { CityView } from '../../src/render/city';
import { CountryView } from '../../src/render/country';
import { BALLOON_MEADOWS } from '../../src/render/country/life/flight';
import { SCARE_R, type Flock } from '../../src/render/country/life/flocks';
import { basketGeometry, biplaneGeometry, combineGeometry, crowGeometry, dogGeometry, envelopeGeometry, flameGeometry, poleGeometry } from '../../src/render/country/life/models';
import type { Effects } from '../../src/render/effects';
import type { Character } from '../../src/sim/entities';
import type { ViewState } from '../../src/sim/viewState';
import { makeSim, world } from './helpers';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => ({ width: 300, height: 150, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx2d() : null), addEventListener: () => {}, removeEventListener: () => {} });
  g.document ??= { createElement: canvas, createElementNS: canvas };
});

const W = world();
const wind = { uWindTime: { value: 0 }, uWindAmp: { value: 0 }, uWindDir: { value: new THREE.Vector2(1, 0) } };
const view = new CountryView(W, new CityView(W), wind);
const life = view.life;
const NO_WIND = { x: 0, z: 0 };
const REACH = 840;

/** An Effects that counts what is let off. */
function puffs(): { fx: Effects; count: () => number } {
  let n = 0;
  return { fx: { puff: () => { n++; } } as unknown as Effects, count: () => n };
}

/** A sim reduced to what the life reads: its clock, the weather and the cars. */
function fakeSim(time: number, cars: Array<{ x: number; z: number; speed: number }> = [], rain = 0): ViewState {
  return {
    time,
    weather: { state: { rain } },
    vehicles: cars.map((c) => ({ removed: false, destroyed: false, speed: c.speed, pos: { x: c.x, y: 0, z: c.z }, vel: { x: 0, z: c.speed } })),
  } as unknown as ViewState;
}

/** What the life has up for the camera: the drawn meshes of its group. */
function drawn(): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  view.moving.getObjectByName('country-life')!.traverseVisible((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) out.push(o);
  });
  return out;
}

/** Runs `seconds` of frames at 30 fps with the camera at (x, z), the player on foot as `player`. */
function frames(seconds: number, cam: { x: number; z: number }, sim: ViewState | null, hours: number, fx: Effects, player: Character | null = null, t0 = 0): number {
  let t = t0;
  for (let k = 0; k < seconds * 30; k++) {
    t += 1 / 30;
    life.update(1 / 30, { x: cam.x, y: 2, z: cam.z }, REACH, sim, player, hours, t, NO_WIND, fx);
  }
  return t;
}

const foot = (x: number, z: number, speed: number): Character => ({ pos: { x, y: 0, z }, vel: { x: 0, y: 0, z: speed }, speed, vehicle: null }) as unknown as Character;

describe('the countryside life: its models', () => {
  it('have only finite positions, normals and colours (a NaN in one vertex blacks the whole frame out through the bloom)', () => {
    const models = { crow: crowGeometry, dog: dogGeometry, biplane: biplaneGeometry, combine: combineGeometry, envelope: envelopeGeometry, basket: basketGeometry, flame: flameGeometry, poles: poleGeometry };
    for (const [name, make] of Object.entries(models)) {
      const geo = make();
      expect(geo.getAttribute('position').count, name).toBeGreaterThan(12);
      for (const [attr, a] of Object.entries(geo.attributes)) expect(Array.from(a.array).every(Number.isFinite), `${name} ${attr}`).toBe(true);
    }
  });
});

describe('the countryside life: what it draws', () => {
  it('draws nothing and sounds nothing while the camera is far from the farmland (in the city)', () => {
    const { fx, count } = puffs();
    const day = fakeSim(10);
    // 840 m and more from the farmland's edge, the fog's reach.
    frames(2, { x: 250, z: 0 }, day, 10, fx);
    expect(drawn()).toEqual([]);
    expect(life.sounds.plane.level + life.sounds.combine.level + life.sounds.burner.level).toBe(0);
    expect(count()).toBe(0);
  });

  it('draws a few meshes by day on the farm: the crows, the dog, the duster, the combine, the fence, the poles and wires', () => {
    // Halfmoon Acres at 10:00, in the first sortie's low pass over the wheat.
    const { fx } = puffs();
    frames(1, { x: -1075, z: 140 }, fakeSim(12), 10, fx);
    const names = drawn().map((o) => o.name).sort();
    expect(names).toEqual(['combine', 'combine-fence', 'crop-duster', 'crows', 'placeholder-poles', 'placeholder-wires']);
    expect(life.drawn.balloon).toBe(false);
  });

  it('adds the farm dog near the dairy, and the balloon with its flame at dawn over its meadow', () => {
    const { fx } = puffs();
    frames(1, { x: -870, z: 30 }, fakeSim(200), 10, fx);
    expect(drawn().map((o) => o.name)).toContain('farm-dog');
    const m = BALLOON_MEADOWS.from;
    // Swelling at 05:40, the burner roaring on some turn of the clock.
    let flames = 0;
    for (let t = 0; t < 60; t += 0.5) {
      frames(1 / 30, { x: m.x + 40, z: m.z }, fakeSim(t), 5.7, fx);
      expect(life.drawn.balloon).toBe(true);
      if (life.drawn.flame) flames++;
    }
    expect(flames).toBeGreaterThan(10);
    frames(1, { x: m.x + 40, z: m.z }, fakeSim(0), 9, fx);
    expect(life.drawn.balloon).toBe(false);
  });

  it('draws the duster only in fair weather by day, and keeps it off the farm at night', () => {
    const { fx } = puffs();
    const cam = { x: -1075, z: 140 };
    frames(1, cam, fakeSim(12), 10, fx);
    expect(life.drawn.plane).toBe(true);
    frames(1, cam, fakeSim(12, [], 0.6), 10, fx);
    expect(life.drawn.plane).toBe(false);
    frames(1, cam, fakeSim(12), 22, fx);
    expect(life.drawn.plane).toBe(false);
  });

  it('puts fewer crows up on the lower tiers, and the same ones back on High', () => {
    const { fx } = puffs();
    const cam = { x: -1075, z: 250 };
    const out: number[] = [];
    for (const tier of ['high', 'medium', 'low', 'software', 'high'] as const) {
      view.setTier(tier);
      frames(1, cam, fakeSim(500), 10, fx);
      out.push(life.drawn.crows);
    }
    expect(out[0]).toBeGreaterThan(out[1]!);
    expect(out[1]).toBeGreaterThan(out[2]!);
    expect(out[3]).toBe(out[2]);
    expect(out[4]).toBe(out[0]);
    expect(out[2]).toBeGreaterThanOrEqual(8);
  });
});

describe('the countryside life: what puts it up', () => {
  it('lifts the Acres flock off the verge when a car passes within the scare radius, and caws', () => {
    const { fx } = puffs();
    const cam = { x: -1078, z: 244 };
    const s = life.sounds;
    s.shots.length = 0;
    // Settled: a minute with nothing near.
    let t = frames(60, cam, fakeSim(1000), 10, fx);
    const flock = (life as unknown as { flocks: Flock[] }).flocks.find((f) => Math.hypot(f.cx + 1073, f.cz - 254) < 10)!;
    expect(flock.state).toBe('perched');
    // A car on the near lane, within the scare radius of the nearest bird, at 15 m/s.
    t = frames(0.5, cam, fakeSim(1060, [{ x: -1073, z: 255 + SCARE_R - 2, speed: 15 }]), 10, fx, null, t);
    expect(flock.state).toBe('rising');
    frames(3, cam, fakeSim(1061, []), 10, fx, null, t);
    expect(flock.state).toBe('circling');
    expect(s.shots.filter((q) => q.kind === 'caw').length).toBeGreaterThanOrEqual(3);
  });

  it('sends the dog barking after a passing car on Creek Road, and not for a parked one', () => {
    const { fx } = puffs();
    const cam = { x: -870, z: 30 };
    const s = life.sounds;
    s.shots.length = 0;
    let t = frames(3, cam, fakeSim(1), 10, fx, null, 0);
    t = frames(3, cam, fakeSim(2, [{ x: -842.5, z: 30, speed: 0 }]), 10, fx, null, t);
    expect(s.shots.filter((q) => q.kind === 'bark')).toEqual([]);
    for (let k = 0; k < 90; k++) {
      t = frames(1 / 30, cam, fakeSim(3, [{ x: -842.5, z: -20 + k * 0.6, speed: 18 }]), 10, fx, null, t);
    }
    const barks = s.shots.filter((q) => q.kind === 'bark');
    expect(barks.length).toBeGreaterThan(0);
    for (const b of barks) {
      expect(b.x).toBeLessThan(-860);
      expect(b.x).toBeGreaterThan(-870);
    }
  });

  it('is startled by the player walking up to a flock, not by his standing beside it', () => {
    const { fx } = puffs();
    const cam = { x: -1078, z: 244 };
    const s = life.sounds;
    let t = frames(70, cam, fakeSim(2000), 10, fx, foot(-1073, 252, 0));
    s.shots.length = 0;
    t = frames(3, cam, fakeSim(2070), 10, fx, foot(-1073, 252, 0), t);
    expect(s.shots.length).toBe(0);
    frames(2, cam, fakeSim(2080), 10, fx, foot(-1073, 252, 3), t);
    expect(s.shots.length).toBeGreaterThanOrEqual(3);
  });

  it('lets off spray while the duster is low over the wheat and dust while the combine works, and neither far off', () => {
    const a = puffs();
    frames(2, { x: -1075, z: 140 }, fakeSim(12), 10, a.fx);
    expect(a.count()).toBeGreaterThan(50);
    const b = puffs();
    frames(2, { x: -1075, z: 140 }, fakeSim(12), 4, b.fx);
    expect(b.count()).toBe(0);
    // The farmland's far corner: the duster is out of the spray's reach.
    const far = puffs();
    frames(2, { x: -700, z: -400 }, fakeSim(12), 10, far.fx);
    expect(far.count()).toBe(0);
  });

  it('reads the sim and writes nothing to it', () => {
    const sim = makeSim();
    const guard = (o: object): object => new Proxy(o, {
      get: (t, k) => {
        const v = Reflect.get(t, k) as unknown;
        return v && typeof v === 'object' ? guard(v) : v;
      },
      set: () => {
        throw new Error('the life wrote to the sim');
      },
      deleteProperty: () => {
        throw new Error('the life wrote to the sim');
      },
    });
    const { fx } = puffs();
    const view3 = guard(sim) as unknown as ViewState;
    expect(() => frames(3, { x: -1075, z: 140 }, view3, 10, fx, sim.player)).not.toThrow();
  });
});

describe('the countryside life: what it sounds like', () => {
  const noise = {} as AudioBuffer;
  /** Just enough of a Web Audio context for the voices: params keep their last target, nodes record nothing. */
  function context(): BaseAudioContext {
    const param = (value: number) => ({ value, setTargetAtTime(v: number) { this.value = v; return this; }, setValueAtTime() { return this; }, linearRampToValueAtTime() { return this; }, exponentialRampToValueAtTime() { return this; } });
    const node = (props: Record<string, unknown>) => ({ connect: (d: unknown) => d, disconnect: () => {}, start: () => {}, stop: () => {}, onended: null, ...props });
    return {
      createBiquadFilter: () => node({ type: 'lowpass', frequency: param(350), Q: param(1) }),
      createGain: () => node({ gain: param(1) }),
      createBufferSource: () => node({ buffer: null, loop: false, playbackRate: param(1) }),
      createOscillator: () => node({ type: 'sine', frequency: param(440) }),
      createStereoPanner: () => node({ pan: param(0) }),
    } as unknown as BaseAudioContext;
  }
  const placement = (x: number, y: number, z: number, ref: number, max: number) => {
    const d = Math.hypot(x, y, z);
    return d <= max ? { gain: 1 / (1 + (d / ref) ** 1.6), pan: 0, cutoff: 20000 } : null;
  };
  const make = () => {
    const nodes = new NodeTally();
    return { nodes, voices: new FieldVoices(context(), {} as AudioNode, noise, new Glider(), placement, () => ({}) as AudioNode, nodes) };
  };
  const ear: Hearing = { x: 0, y: 2, z: 0, yaw: 0, vx: 0, vz: 0 };

  it('hears the duster rise in pitch coming and fall going, loudest over its pass, and nothing from a kilometre off', () => {
    const { voices } = make();
    const s = newLifeSounds();
    const at = (x: number, z: number) => {
      Object.assign(s.plane, { x, y: 10, z, vx: 0, vy: 0, vz: -34, level: 1 });
      voices.update(s, ear, 0);
      return { f: voices.doppler, gain: voices.levels.plane };
    };
    const coming = at(0, 250);
    const over = at(0, 0);
    const going = at(0, -250);
    expect(coming.f).toBeGreaterThan(1.05);
    expect(going.f).toBeLessThan(0.95);
    expect(over.gain).toBeGreaterThan(coming.gain * 2);
    expect(at(0, 1000).gain).toBe(0);
    s.plane.level = 0;
    voices.update(s, ear, 1);
    expect(voices.levels.plane).toBe(0);
  });

  it('hears the combine and the burner near, not far, and not when they are off', () => {
    const { voices } = make();
    const s = newLifeSounds();
    Object.assign(s.combine, { x: 20, y: 2, z: 0, level: 1 });
    Object.assign(s.burner, { x: 0, y: 30, z: 30, level: 1 });
    voices.update(s, ear, 0);
    expect(voices.levels.combine).toBeGreaterThan(0.05);
    expect(voices.levels.burner).toBeGreaterThan(0.05);
    Object.assign(s.combine, { x: 900 });
    Object.assign(s.burner, { level: 0 });
    voices.update(s, ear, 1);
    expect(voices.levels.combine).toBe(0);
    expect(voices.levels.burner).toBe(0);
  });

  it('plays each caw and bark queued as a voice of its own, drains the queue, and drops what is out of earshot', () => {
    const { voices, nodes } = make();
    const s = newLifeSounds();
    shoot(s, 'caw', 10, 5, 10);
    shoot(s, 'caw', 12, 5, 8);
    shoot(s, 'bark', 15, 1, 5);
    shoot(s, 'bark', 5000, 1, 5);
    voices.update(s, ear, 0);
    expect(s.shots).toEqual([]);
    expect(nodes.started.caw).toBeGreaterThanOrEqual(2 * 3);
    expect(nodes.started.bark).toBeGreaterThanOrEqual(2);
    // The far bark made no nodes: one bark's saw and puff only.
    expect(nodes.started.bark).toBeLessThan(4);
  });

  it('keeps no more than a few shots waiting when nobody listens', () => {
    const s = newLifeSounds();
    for (let k = 0; k < 50; k++) shoot(s, 'caw', 0, 0, 0);
    expect(s.shots.length).toBe(MAX_SHOTS);
  });
});
