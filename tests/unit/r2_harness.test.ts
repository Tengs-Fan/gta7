// Round 2, harness cluster: a non-finite value or a throwing listener / mission check can no longer end
// the session, and chained explosions no longer fling wrecks across the city.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { V3 } from '../../src/core/math';
import { makeBrain } from '../../src/sim/brains';
import { Helicopter, Projectile } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import type { Sim } from '../../src/sim/sim';
import { launchVehicle } from '../../src/sim/vehiclePhysics';
import { makeRayHit } from '../../src/world/colliders';
import { input, makeSim, placeInCar, roadPoint, step, world } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

const finite = (v: V3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** Every position the presentation layer reads, and the sim indexes grids with. */
function allPositionsFinite(sim: Sim): boolean {
  return (
    sim.vehicles.every((v) => finite(v.pos) && Number.isFinite(v.vel.x + v.vel.z + v.vy + v.heading + v.pitch + v.roll)) &&
    sim.characters.every((c) => finite(c.pos) && finite(c.vel)) &&
    sim.helis.every((h) => finite(h.pos) && finite(h.vel)) &&
    sim.projectiles.every((p) => finite(p.pos) && finite(p.vel))
  );
}

type Body = { pos: V3; vel: { x: number } };

/** A busy scene: the player next to his car, traffic, a pursuing cruiser, a cop and a ped on foot, the helicopter and a rocket in flight. */
function scene(): { sim: Sim; bodies: Record<string, () => Body> } {
  const sim = makeSim({ ambient: true, police: true, seed: 3 });
  const rp = roadPoint(sim);
  const p = sim.player;
  p.pos.x = rp.x + 6;
  p.pos.z = rp.z;
  const car = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
  const traffic = sim.spawnVehicle('compact', rp.x + rp.lane.dx * 20, rp.z + rp.lane.dz * 20, rp.heading);
  sim.addDriver(traffic, 'civilian', 'traffic');
  const cruiser = sim.spawnVehicle('police', rp.x - rp.lane.dx * 25, rp.z - rp.lane.dz * 25, rp.heading);
  cruiser.owner = 'police';
  const crew = sim.addDriver(cruiser, 'cop', 'chase');
  crew.owner = 'police';
  crew.brain = makeBrain('chase');
  crew.brain.car = cruiser;
  cruiser.ai!.target = p;
  const cop = sim.spawnCharacter('cop', p.pos.x + 8, p.pos.z + 3);
  cop.owner = 'police';
  cop.inventory.infinite = true;
  cop.inventory.give('pistol', 999);
  cop.inventory.current = 'pistol';
  cop.brain = makeBrain('chase');
  cop.brain.brave = true;
  const ped = sim.spawnCharacter('civilian', p.pos.x - 5, p.pos.z + 2);
  ped.brain = makeBrain('wander');
  const heli = new Helicopter(sim.newId(), p.pos.x + 30, 40, p.pos.z);
  sim.helis.push(heli);
  sim.wanted.setLevel(3);
  step(sim, 0.5);
  const rocket = new Projectile(sim.newId(), { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z }, { x: 0, y: 2, z: 50 }, p);
  sim.projectiles.push(rocket);
  return {
    sim,
    bodies: {
      'the player on foot': () => p,
      "the player's car": () => {
        placeInCar(sim, car);
        return car;
      },
      'a cop on foot': () => cop,
      'a police car': () => cruiser,
      'a traffic car': () => traffic,
      'a pedestrian': () => ped,
      'the helicopter': () => heli,
      'a rocket': () => rocket,
    },
  };
}

describe('a non-finite value can no longer crash the game', () => {
  const names = Object.keys(scene().bodies);
  for (const field of ['pos', 'vel'] as const) {
    for (const name of names) {
      it(`${name} with ${field}.x = NaN`, () => {
        const { sim, bodies } = scene();
        bodies[name]!()[field].x = NaN;
        expect(() => {
          for (let i = 0; i < 10; i++) sim.update(1 / 60, input({ aimOrigin: { x: 1, y: 3, z: 1 } }));
        }).not.toThrow();
        expect(allPositionsFinite(sim)).toBe(true);
      });
    }
  }

  it('the collider grid and the world refuse non-finite input', () => {
    const w = world();
    const hit = makeRayHit();
    const p = w.layout.pois.find((q) => q.id === 'safehouse')!;
    expect(w.grid.raycast(NaN, 1, p.z, 1, 0, 0, 50, hit)).toBe(false);
    expect(w.grid.raycast(p.x, 1, p.z, NaN, 0, 0, 50, hit)).toBe(false);
    expect(w.grid.raycast(p.x, 1, p.z, 1, 0, 0, Infinity, hit)).toBe(false);
    expect(w.lineOfSight(NaN, 1, p.z, p.x, 1, p.z)).toBe(false);
    expect(w.lineOfSight(p.x, 1, p.z, p.x + 5, Infinity, p.z)).toBe(false);
    expect(w.isFree(NaN, p.z, 0.5)).toBe(false);
    expect(w.isFree(p.x, p.z, NaN)).toBe(false);
    expect(w.findFreeSpot(NaN, p.z, 0.5)).toBe(null);
    expect(w.findFreeSpot(p.x, Infinity, 0.5)).toBe(null);
    let seen = 0;
    w.grid.query(NaN, 0, 10, 10, () => seen++);
    w.grid.query(-Infinity, -Infinity, Infinity, Infinity, () => seen++);
    expect(seen).toBe(0);
    // Finite input still works.
    expect(w.findFreeSpot(p.x, p.z, 0.5)).not.toBe(null);
    w.grid.query(p.x - 40, p.z - 40, p.x + 40, p.z + 40, () => seen++);
    expect(seen).toBeGreaterThan(0);
  });

  it('a helicopter that blows up hovers where it last was; one never seen intact is dropped', () => {
    const { sim, bodies } = scene();
    const heli = bodies['the helicopter']!() as Helicopter;
    const last = { ...heli.pos };
    heli.pos.y = NaN;
    heli.heading = NaN;
    heli.spotlight.x = NaN;
    sim.update(1 / 60, input());
    expect(sim.helis.includes(heli)).toBe(true);
    expect(heli.pos).toEqual(last);
    expect(heli.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(Number.isFinite(heli.heading + heli.spotlight.x + heli.spotlight.z)).toBe(true);
    const stray = new Helicopter(sim.newId(), NaN, 50, 0);
    sim.helis.push(stray);
    sim.update(1 / 60, input());
    expect(sim.helis.includes(stray)).toBe(false);
  });

  it('a NaN in a tumble is repaired where the car is, and runaway speeds are capped', () => {
    const sim = makeSim();
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    step(sim, 0.2);
    const at = { ...v.pos };
    v.pitch = NaN;
    v.rollVel = NaN;
    sim.update(1 / 60, input());
    expect(v.pitch).toBe(0);
    expect(v.rollVel).toBe(0);
    expect(Math.hypot(v.pos.x - at.x, v.pos.z - at.z)).toBeLessThan(0.1);
    v.vel.x = rp.lane.dx * 300;
    v.vel.z = rp.lane.dz * 300;
    v.vy = 200;
    v.airborne = true;
    sim.update(1 / 60, input());
    expect(Math.hypot(v.vel.x, v.vel.z)).toBeLessThanOrEqual(90 + 1e-9);
    expect(v.vy).toBeLessThanOrEqual(60);
  });
});

describe('a throwing listener is isolated', () => {
  it('a throwing explosion listener stops neither Sim.update, nor the explosion, nor the next listener', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sim = makeSim();
    const rp = roadPoint(sim);
    const burning = sim.spawnVehicle('sedan', rp.x, rp.z, rp.heading);
    const near = sim.spawnVehicle('compact', rp.x + rp.lane.dx * 5, rp.z + rp.lane.dz * 5, rp.heading);
    sim.combat.igniteVehicle(burning, 0.01);
    const thrower = () => {
      throw new Error('broken renderer listener');
    };
    sim.events.on('explosion', thrower);
    let after = 0;
    sim.events.on('explosion', () => after++);
    expect(() => step(sim, 0.1)).not.toThrow();
    expect(burning.destroyed).toBe(true);
    expect(after).toBe(1);
    // The explosion went on after the listeners: it damaged the car next to it.
    expect(near.health).toBeLessThan(near.spec.health);
    expect(sim.events.errors).toBe(1);
    // The same listener throwing again is counted, but logged only once.
    sim.events.emit('explosion', { x: rp.x, y: 0, z: rp.z, radius: 1 });
    expect(sim.events.errors).toBe(2);
    expect(after).toBe(2);
    const logged = err.mock.calls.filter((c) => c[0] === 'GTA7 listener error');
    expect(logged).toHaveLength(1);
    expect(logged[0]![1]).toBe('explosion');
    // Another event type from the same listener is reported once too.
    sim.events.on('splash', thrower as (e: SimEvents['splash']) => void);
    sim.events.emit('splash', { x: 0, y: 0, z: 0, big: false });
    sim.events.emit('splash', { x: 0, y: 0, z: 0, big: false });
    expect(sim.events.errors).toBe(4);
    expect(err.mock.calls.filter((c) => c[0] === 'GTA7 listener error')).toHaveLength(2);
  });

  it('a mission fail check that throws fails the mission instead of the game', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sim = makeSim();
    expect(sim.missions.start('wheels')).toBe(true);
    const failed: string[] = [];
    sim.events.on('big', (e) => {
      if (e.style === 'failed') failed.push(e.sub);
    });
    let ended: SimEvents['missionEnded'] | null = null;
    sim.events.on('missionEnded', (e) => (ended = e));
    sim.missions.active!.failIf(() => {
      throw new Error('broken check');
    }, 'never shown');
    expect(() => step(sim, 0.2)).not.toThrow();
    expect(sim.missions.active).toBe(null);
    expect(ended).toEqual({ id: 'wheels', passed: false });
    expect(failed).toEqual(['Something went wrong.']);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('check error'))).toHaveLength(1);
    // The game goes on, and the mission can be played again.
    expect(sim.missions.start('wheels')).toBe(true);
  });
});

describe('explosion launches are capped', () => {
  it('a compact caught in 12 chained blasts stays under 35 m/s and within 120 m', () => {
    const sim = makeSim();
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle('compact', rp.x, rp.z, rp.heading);
    const start = { ...v.pos };
    let top = 0;
    const track = () => {
      top = Math.max(top, Math.hypot(v.vel.x, v.vel.z));
      return input({ aimOrigin: { x: start.x, y: 5, z: start.z - 8 } });
    };
    // Each blast 2 m west of the car, as when the cars around it go up one after another, 0.15 s apart.
    // (Blasts at one fixed spot fling it out of their own reach after two kicks, under 20 m/s even before the cap.)
    for (let i = 0; i < 12; i++) {
      sim.combat.explosion(v.pos.x - 2, v.pos.y + 0.8, v.pos.z, 7.5, 360, null, null);
      track();
      step(sim, 0.15, track);
    }
    step(sim, 6, track);
    expect(v.destroyed).toBe(true);
    expect(top).toBeLessThan(35);
    expect(Math.hypot(v.pos.x - start.x, v.pos.z - start.z)).toBeLessThan(120);
  });

  it('a kick never raises a car past 24 m/s or the speed it had; wrecks take half; the blast pop is unchanged', () => {
    const sim = makeSim();
    const rp = roadPoint(sim);
    const v = sim.spawnVehicle('compact', rp.x, rp.z, rp.heading);
    launchVehicle(v, 1, 0, 20, 0);
    expect(v.vel.x).toBeCloseTo(20, 9);
    launchVehicle(v, 1, 0, 20, 0);
    expect(Math.hypot(v.vel.x, v.vel.z)).toBeCloseTo(24, 9);
    expect(v.vy).toBeLessThanOrEqual(12);
    // A car already faster than 24 m/s keeps its speed but is not pushed faster.
    v.vel.x = 0;
    v.vel.z = 30;
    launchVehicle(v, 0, 1, 9, 0);
    expect(Math.hypot(v.vel.x, v.vel.z)).toBeCloseTo(30, 9);
    // A wreck takes half the push.
    const w = sim.spawnVehicle('compact', rp.x + 30, rp.z, rp.heading);
    w.destroyed = true;
    launchVehicle(w, 1, 0, 8, 0);
    expect(w.vel.x).toBeCloseTo(4, 9);
    // A car blowing up still pops up as before (its own blast pushes it straight up).
    const b = sim.spawnVehicle('sedan', rp.x - 30, rp.z, rp.heading);
    sim.combat.explodeVehicle(b);
    expect(b.vy).toBeCloseTo(6.5 * 0.9, 9);
    expect(Math.hypot(b.vel.x, b.vel.z)).toBe(0);
  });

  it('a sports car off ramp 0 at 40 m/s still pays a unique stunt bonus for a long jump', () => {
    const sim = makeSim();
    const r = sim.world.layout.ramps[0]!;
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    const v = sim.spawnVehicle('sports', r.x - fx * 30, r.z - fz * 30, r.heading);
    placeInCar(sim, v);
    v.vel.x = fx * 40;
    v.vel.z = fz * 40;
    const stunts: Array<SimEvents['stunt']> = [];
    sim.events.on('stunt', (e) => stunts.push(e));
    let launch = 0;
    step(sim, 5, () => {
      if (v.airborne && launch === 0) launch = v.speed;
      // Hold about 40 m/s up the ramp.
      return input({ throttle: v.speed < 40 ? 1 : 0 });
    });
    expect(launch).toBeGreaterThan(38);
    expect(launch).toBeLessThan(42);
    expect(stunts).toHaveLength(1);
    expect(stunts[0]!.unique).toBe(true);
    expect(stunts[0]!.bonus).toBeGreaterThan(0);
    expect(stunts[0]!.distance).toBeGreaterThan(25);
  });
});
