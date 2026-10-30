// Round 2, harness cluster: the collider grid refuses non-finite input, and chained explosions no longer fling
// wrecks across the city.

import { describe, expect, it } from 'vitest';
import type { SimEvents } from '../../src/sim/events';
import { launchVehicle } from '../../src/sim/vehiclePhysics';
import { makeRayHit } from '../../src/world/colliders';
import { input, makeSim, placeInCar, roadPoint, step, world } from './helpers';

describe('non-finite input to the world', () => {
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
