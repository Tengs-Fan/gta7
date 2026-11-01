// The headlight switch: the one rule for whether a vehicle's lamps are lit (sim/lamps.ts), the press that flips it
// (PlayerController), and what the views draw of it. The render modules run headless on the canvas/document stub of
// m3_cars.test.ts (copied: vi.hoisted cannot be shared).

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

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
    return new Proxy(store, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => ((o[k] = v), true) });
  };
  const canvas = (): Record<string, unknown> => ({ width: 300, height: 150, clientWidth: 1280, clientHeight: 720, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx2d() : null), addEventListener: () => {}, removeEventListener: () => {} });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

import { BikeView } from '../../src/render/bikeView';
import { BoatView } from '../../src/render/boatView';
import { VehicleView } from '../../src/render/vehicleView';
import { darkness } from '../../src/sim/clock';
import type { LampSwitch, Vehicle } from '../../src/sim/entities';
import { lampDarkness, lampsLit, lampsPowered, LAMPS_DARK } from '../../src/sim/lamps';
import type { VehicleKind } from '../../src/sim/specs';
import type { Sim } from '../../src/sim/sim';
import { input, makeSim, step, world } from './helpers';

const sim = makeSim({ world: world() });
const at = sim.world.layout.bounds.beachStartX + 30;
const z = (sim.world.layout.bounds.landMinZ + sim.world.layout.bounds.landMaxZ) / 2;

/** A vehicle of `kind` on the sand, with a civilian at the wheel unless `driven` is false. */
const make = (kind: VehicleKind, over: Partial<Pick<Vehicle, 'lights' | 'destroyed' | 'siren'>> & { driven?: boolean } = {}): Vehicle => {
  const v = sim.spawnVehicle(kind, at, z, 0.4);
  if (over.driven ?? true) sim.seat(sim.spawnCharacter('civilian', at, z), v, 0);
  v.lights = over.lights ?? 'auto';
  v.destroyed = over.destroyed ?? false;
  v.siren = over.siren ?? false;
  return v;
};
const car = (over: Parameters<typeof make>[1] = {}): Vehicle => make('sedan', over);

const DAY = 0;
const NIGHT = 1;

describe('lampsLit', () => {
  it('the switch decides: on is lit, off is dark, auto is lit past the dark threshold', () => {
    for (const dark of [DAY, LAMPS_DARK, 0.5, NIGHT]) {
      expect(lampsLit(car({ lights: 'on' }), dark)).toBe(true);
      expect(lampsLit(car({ lights: 'off' }), dark)).toBe(false);
    }
    expect(lampsLit(car({ lights: 'auto' }), DAY)).toBe(false);
    expect(lampsLit(car({ lights: 'auto' }), LAMPS_DARK)).toBe(false);
    expect(lampsLit(car({ lights: 'auto' }), LAMPS_DARK + 0.01)).toBe(true);
    expect(lampsLit(car({ lights: 'auto' }), NIGHT)).toBe(true);
  });

  it('an unpowered or destroyed vehicle is dark whatever the switch says', () => {
    for (const lights of ['auto', 'on', 'off'] as const) {
      expect(lampsLit(car({ lights, driven: false }), NIGHT)).toBe(false);
      expect(lampsLit(car({ lights, destroyed: true }), NIGHT)).toBe(false);
    }
  });

  it('a deployed police car with its siren on is powered with nobody in it', () => {
    expect(lampsPowered(car({ driven: false, siren: true }))).toBe(true);
    expect(lampsLit(car({ driven: false, siren: true }), NIGHT)).toBe(true);
    expect(lampsPowered(car({ driven: false, siren: true, destroyed: true }))).toBe(false);
  });
});

describe('lampDarkness', () => {
  it('is the night, or the weather’s dim when that is darker', () => {
    expect(lampDarkness(12, 0)).toBe(darkness(12));
    expect(lampDarkness(12, 0.65)).toBe(0.65);
    expect(lampDarkness(23, 0.2)).toBe(darkness(23));
    expect(darkness(23)).toBeGreaterThan(LAMPS_DARK);
    expect(darkness(12)).toBeLessThan(LAMPS_DARK);
  });
});

/** The emissive intensities of a view's lamp lenses, head pair then tail pair (a car has a fifth, reverse lamp). */
function lenses(view: VehicleView): { head: number; tail: number } {
  const lamps: THREE.Mesh[] = [];
  view.group.traverse((o) => o.name === 'lamp' && lamps.push(o as THREE.Mesh));
  const e = (m: THREE.Mesh) => (m.material as THREE.MeshStandardMaterial).emissiveIntensity;
  return { head: e(lamps[0]!), tail: e(lamps[1]!) };
}

describe('what a car draws of the switch', () => {
  const drawn = (lights: LampSwitch, dark: number, driven = true) => {
    const v = car({ lights, driven });
    const view = new VehicleView('sedan');
    view.bind(v);
    view.sync(v, 1 / 60, 0, dark);
    return { lit: view.lightsOn, ...lenses(view) };
  };

  it('by day the switch on lights the head lens and the running tail lamp, as a daytime running look', () => {
    const auto = drawn('auto', DAY);
    const on = drawn('on', DAY);
    expect(auto.lit).toBe(false);
    expect(on.lit).toBe(true);
    expect(on.head).toBeGreaterThan(auto.head * 4);
    expect(on.tail).toBeGreaterThan(auto.tail);
    expect(drawn('off', DAY)).toMatchObject({ lit: false, head: 0, tail: 0 });
  });

  it('at night the switch off leaves only the unlit glimmer a parked car has, and on or auto light the lenses', () => {
    const parked = drawn('auto', NIGHT, false);
    const off = drawn('off', NIGHT);
    expect(off).toEqual(parked);
    expect(off.lit).toBe(false);
    for (const lights of ['auto', 'on'] as const) {
      const lit = drawn(lights, NIGHT);
      expect(lit.lit, lights).toBe(true);
      expect(lit.head, lights).toBeGreaterThan(off.head * 10);
      expect(lit.tail, lights).toBeGreaterThan(off.tail);
    }
  });

  it('a parked car stays dark by day and glimmers at night whatever its switch says', () => {
    for (const lights of ['auto', 'on', 'off'] as const) expect(drawn(lights, DAY, false), lights).toMatchObject({ lit: false, head: 0, tail: 0 });
    expect(drawn('on', NIGHT, false).lit).toBe(false);
  });

  it('bikes and boats follow the switch too', () => {
    for (const [View, kind] of [[BikeView, 'scooter'], [BoatView, 'dinghy']] as const) {
      const lit = (lights: LampSwitch, dark: number) => {
        const view = new View(kind);
        const v = make(kind, { lights });
        view.bind(v);
        view.sync(v, 1 / 60, 0, dark);
        return view.lightsOn;
      };
      expect(lit('auto', DAY), kind).toBe(false);
      expect(lit('on', DAY), kind).toBe(true);
      expect(lit('off', NIGHT), kind).toBe(false);
      expect(lit('auto', NIGHT), kind).toBe(true);
    }
  });
});

/** The player at the wheel of a `kind` on the sand at `hours`, standing still in a quiet sim (no traffic, no police). */
function driving(hours: number, kind: VehicleKind = 'sedan'): { sim: Sim; v: Vehicle } {
  const sim = makeSim({ world: world(), police: false });
  sim.clock.set(hours);
  sim.cheats.neverWanted = true;
  const b = sim.world.layout.bounds;
  const v = sim.spawnVehicle(kind, b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0.4);
  sim.seat(sim.player, v, 0);
  return { sim, v };
}

/** One press of the switch, then a moment for it to settle. */
const press = (sim: Sim): void => step(sim, 0.1, (t) => input({ lightsPressed: t < 0.01 }));

describe('the press', () => {
  it('flips what the player sees: lit lamps go off, dark lamps come on', () => {
    // By night, `auto` is lit: off.
    let g = driving(23);
    press(g.sim);
    expect(g.v.lights).toBe('off');
    press(g.sim);
    expect(g.v.lights).toBe('on');
    press(g.sim);
    expect(g.v.lights).toBe('off');
    // By day, `auto` is dark: on, and then off.
    g = driving(12);
    press(g.sim);
    expect(g.v.lights).toBe('on');
    press(g.sim);
    expect(g.v.lights).toBe('off');
    press(g.sim);
    expect(g.v.lights).toBe('on');
  });

  it('a vehicle never switched stays on auto', () => {
    const { sim, v } = driving(23);
    step(sim, 1);
    expect(v.lights).toBe('auto');
  });

  it('judges by the same dark the renderer draws: a dim overcast noon lights `auto` lamps already', () => {
    const { sim, v } = driving(12);
    sim.weather.setFields({ dim: 0.65 });
    step(sim, 0.05);
    expect(sim.weather.state.dim).toBe(0.65);
    expect(lampsLit(v, lampDarkness(sim.clock.hours, sim.weather.state.dim))).toBe(true);
    press(sim);
    expect(v.lights).toBe('off');
  });

  it('works on a bike, a boat and a police car, and the police car’s siren is its own switch', () => {
    for (const kind of ['scooter', 'dinghy'] as const) {
      const { sim, v } = driving(12, kind);
      press(sim);
      expect(v.lights, kind).toBe('on');
    }
    const { sim, v } = driving(23, 'police');
    press(sim);
    expect(v.lights).toBe('off');
    expect(v.siren).toBe(false);
    step(sim, 0.1, (t) => input({ hornPressed: t < 0.01 }));
    expect(v.siren).toBe(true);
    expect(v.lights).toBe('off');
    press(sim);
    expect(v.lights).toBe('on');
    expect(v.siren).toBe(true);
  });

  it('tells the player with a short message', () => {
    const { sim } = driving(23);
    const got: Array<{ text: string; duration: number }> = [];
    sim.events.on('message', (e) => got.push(e));
    press(sim);
    press(sim);
    expect(got.map((m) => m.text)).toEqual(['Headlights off', 'Headlights on']);
    expect(got.every((m) => m.duration <= 2)).toBe(true);
  });

  it('does nothing on foot', () => {
    const { sim, v } = driving(23);
    sim.playerCtl.ejectPlayer(false);
    expect(sim.player.vehicle).toBeNull();
    const got: string[] = [];
    sim.events.on('message', (e) => got.push(e.text));
    press(sim);
    expect(v.lights).toBe('auto');
    expect(got).toEqual([]);
  });

  it('is kept by the vehicle through getting out and back in', () => {
    const { sim, v } = driving(12);
    press(sim);
    expect(v.lights).toBe('on');
    step(sim, 3, (t) => input({ enterExit: t < 0.01 }));
    expect(sim.player.vehicle).toBeNull();
    expect(lampsLit(v, 1)).toBe(false);
    sim.seat(sim.player, v, 0);
    expect(v.lights).toBe('on');
    // A vehicle he never switched stays on auto through the same trip.
    const other = sim.spawnVehicle('compact', v.pos.x + 8, v.pos.z, 0.4);
    sim.seat(sim.player, other, 0);
    step(sim, 3, (t) => input({ enterExit: t < 0.01 }));
    sim.seat(sim.player, other, 0);
    expect(other.lights).toBe('auto');
    expect(v.lights).toBe('on');
  });

  it('leaves the traffic’s own lamps on auto', () => {
    const sim = makeSim({ world: world(), police: true, ambient: true });
    sim.clock.set(23);
    sim.cheats.neverWanted = true;
    const lane = sim.roads.nearestLane(sim.player.pos.x, sim.player.pos.z).lane;
    const v = sim.spawnVehicle('sedan', lane.sx + lane.dx * 20, lane.sz + lane.dz * 20, lane.heading);
    sim.seat(sim.player, v, 0);
    step(sim, 20, (t) => input({ lightsPressed: Math.floor(t * 2) % 2 === 0 && t % 0.5 < 1 / 30 }));
    const others = sim.vehicles.filter((u) => u !== v);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((u) => u.lights === 'auto')).toBe(true);
  });
});
