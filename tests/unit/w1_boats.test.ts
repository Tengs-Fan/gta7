// Wave 1 track C, boats (VAL-BOAT-001..003, 005..007): two boat kinds moored at the Marina, boarding from the quay or
// the water, floating at WATER_Y and steering on it, running aground, getting off onto the pier or into the sea, and
// staying out of the car-sinking path. The drawn bob on the waves (VAL-BOAT-004) and the tiers (VAL-BOAT-008) are in
// w1_vehicle_views.test.ts and tests/e2e/w1_vehicles.spec.ts.

import { describe, expect, it } from 'vitest';
import { marinaMoorings, mooredBoats, MOOR_RANGE } from '../../src/sim/boats';
import { hullDepth } from '../../src/sim/boatPhysics';
import { SWIM_FLOAT } from '../../src/sim/characterPhysics';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import { input, makeSim, placeInCar, roadPoint, step, teleport } from './helpers';
import { stepUntil } from './r2_police_helpers';

const BOATS = Object.values(VEHICLE_SPECS).filter((s) => s.class === 'boat').map((s) => s.kind);

/** An ambient sim with the player standing on the Marina's main deck, its moorings filled. */
function atMarina(seed = 5): { sim: Sim; poi: { x: number; z: number } } {
  const sim = makeSim({ ambient: true, police: false, seed });
  const poi = sim.world.layout.pois.find((p) => p.kind === 'marina')!;
  teleport(sim, poi.x - 6, poi.z);
  step(sim, 1.2);
  return { sim, poi };
}

/** A boat of `kind` in open water east of the beach (the player at its helm unless `ride` is false). */
function boatAtSea(kind: VehicleKind, ride = true, x = 700, z = -300, heading = 0): { sim: Sim; boat: Vehicle } {
  const sim = makeSim({ seed: 9 });
  const boat = sim.spawnVehicle(kind, x, z, heading);
  boat.pos.y = WATER_Y;
  if (ride) placeInCar(sim, boat);
  return { sim, boat };
}

describe('VAL-BOAT-001: two boat kinds moored at the Marina', () => {
  it('a speedboat and a dinghy, class boat, the speedboat faster', () => {
    expect(BOATS.sort()).toEqual(['dinghy', 'speedboat']);
    for (const k of BOATS) {
      const s = VEHICLE_SPECS[k];
      expect(s.class).toBe('boat');
      expect(s.boat!.draft).toBeGreaterThan(0);
      for (const f of [s.mass, s.accel, s.maxSpeed, s.seats]) expect(f).toBeGreaterThan(0);
    }
    expect(VEHICLE_SPECS.speedboat.maxSpeed).toBeGreaterThan(VEHICLE_SPECS.dinghy.maxSpeed);
  });

  it('near the Marina one empty boat of each kind floats at its mooring within 40 m of it, clear of the moored props', () => {
    const { sim, poi } = atMarina();
    const boats = mooredBoats(sim).filter((b): b is Vehicle => !!b);
    expect(boats.map((b) => b.kind).sort()).toEqual(['dinghy', 'speedboat']);
    for (const b of boats) {
      expect(Math.hypot(b.pos.x - poi.x, b.pos.z - poi.z)).toBeLessThan(40);
      expect(b.pos.y).toBeCloseTo(WATER_Y, 6);
      expect(b.driver).toBeNull();
      expect(b.inWater).toBe(false);
      expect(hullDepth(b, sim.world, b.pos.x, b.pos.z, b.heading)).toBeGreaterThanOrEqual(b.spec.boat!.draft);
      for (const p of sim.world.layout.props) {
        if (p.kind !== 'boat') continue;
        // The prop's hull is 2.6 m wide and 12 m long along z (staticWorld BOAT_HULL).
        const gapX = Math.abs(p.x - b.pos.x) - 1.3 - b.halfW;
        const gapZ = Math.abs(p.z + 1 - b.pos.z) - 6 - b.halfL;
        expect(Math.max(gapX, gapZ), `${b.kind} vs prop at ${p.x},${p.z}`).toBeGreaterThan(0.5);
      }
    }
    console.log(`[boat] moored: ${boats.map((b) => `${b.kind} at (${b.pos.x.toFixed(1)}, ${b.pos.z.toFixed(1)}) ${Math.hypot(b.pos.x - poi.x, b.pos.z - poi.z).toFixed(1)} m from the Marina`).join('; ')}`);
    // Same seed, same boats.
    const again = atMarina();
    expect(mooredBoats(again.sim).map((b) => b && [b.id, b.kind, b.pos.x, b.pos.z])).toEqual(mooredBoats(sim).map((b) => b && [b.id, b.kind, b.pos.x, b.pos.z]));
  });

  it('far from the Marina there are none, a boat taken away is replaced out of sight, and boats never join traffic', () => {
    const sim = makeSim({ ambient: true, police: false, seed: 5 });
    step(sim, 3);
    expect(sim.vehicles.filter((v) => v.spec.class === 'boat')).toEqual([]);
    const moor = marinaMoorings(sim.world);
    expect(moor.length).toBe(2);
    for (let t = 0; t < 60; t++) {
      step(sim, 1);
      for (const v of sim.vehicles) if (v.spec.class === 'boat') expect(v.owner).not.toBe('traffic');
    }
    expect(MOOR_RANGE).toBeLessThan(200);
  });
});

describe('VAL-BOAT-002: boats are entered from the quay or the water', () => {
  it.each(BOATS)('F on the pier next to the moored %s seats the player within 2 s, never through the deck', (kind) => {
    const { sim } = atMarina();
    const boat = mooredBoats(sim).find((b) => b?.kind === kind)!;
    const p = sim.player;
    // On the pier beside it (the pier lies east of the moorings).
    p.pos.x = boat.pos.x + boat.halfW + 1.5;
    p.pos.z = boat.pos.z;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    expect(p.pos.y).toBeCloseTo(0.45, 2);
    step(sim, 0.2);
    step(sim, 1 / 60, input({ enterExit: true }));
    let lowest = Infinity;
    const t = stepUntil(sim, 2, () => {
      lowest = Math.min(lowest, p.pos.y);
      return p.vehicle === boat;
    });
    expect(t).toBeGreaterThanOrEqual(0);
    expect(lowest).toBeGreaterThan(WATER_Y - 0.5);
    expect(boat.driver).toBe(p);
    expect(boat.owner).toBe('none');
  });

  it('swimming within 3 m of a boat, F climbs in', () => {
    const { sim, boat } = boatAtSea('dinghy', false);
    const p = sim.player;
    p.pos.x = boat.pos.x + boat.halfW + 2;
    p.pos.z = boat.pos.z;
    p.pos.y = WATER_Y;
    step(sim, 1);
    expect(p.state).toBe('swimming');
    step(sim, 1 / 60, input({ enterExit: true }));
    expect(stepUntil(sim, 2, () => p.vehicle === boat)).toBeGreaterThanOrEqual(0);
  });

  it('a boat out of reach (5 m off) cannot be boarded', () => {
    const { sim, boat } = boatAtSea('speedboat', false);
    const p = sim.player;
    p.pos.x = boat.pos.x + boat.halfW + 5;
    p.pos.z = boat.pos.z;
    p.pos.y = WATER_Y;
    step(sim, 1);
    step(sim, 1 / 60, input({ enterExit: true }));
    step(sim, 2);
    expect(p.vehicle).toBeNull();
  });
});

describe('VAL-BOAT-003: boats drive on water at a flat simulated height', () => {
  it.each(BOATS)('the %s reaches its top speed within 10%%, holds WATER_Y, never sinks, and turns about in under 10 s at half speed', (kind) => {
    const { sim, boat } = boatAtSea(kind, true, 700, -600);
    let top = 0;
    let yDev = 0;
    for (let f = 0; f < 60 * 30; f++) {
      step(sim, 1 / 60, input({ throttle: 1 }));
      top = Math.max(top, boat.forwardSpeed);
      yDev = Math.max(yDev, Math.abs(boat.pos.y - WATER_Y));
      expect(boat.inWater).toBe(false);
    }
    // Half speed, then full rudder.
    const half = boat.spec.maxSpeed / 2;
    const t0 = stepUntil(sim, 20, () => boat.forwardSpeed <= half, () => input({ brake: 1 }));
    expect(t0).toBeGreaterThanOrEqual(0);
    let turned = 0;
    let last = boat.heading;
    const tTurn = stepUntil(sim, 12, () => {
      let d = boat.heading - last;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      turned += d;
      last = boat.heading;
      return Math.abs(turned) >= Math.PI;
    }, () => input({ steer: 1, throttle: boat.forwardSpeed < half ? 1 : 0, brake: boat.forwardSpeed > half + 1 ? 0.5 : 0 }));
    console.log(`[boat] ${kind}: top ${top.toFixed(1)} of ${boat.spec.maxSpeed} m/s, max |y - WATER_Y| ${yDev.toFixed(3)} m, 180 deg at ${half} m/s in ${tTurn.toFixed(2)} s`);
    expect(top).toBeGreaterThanOrEqual(boat.spec.maxSpeed * 0.9);
    expect(top).toBeLessThanOrEqual(boat.spec.maxSpeed * 1.1);
    expect(yDev).toBeLessThanOrEqual(0.3);
    expect(tTurn).toBeGreaterThan(0);
    expect(tTurn).toBeLessThan(10);
    expect(boat.driver).toBe(sim.player);
  });

  it('two runs with one seed match at every step, and the sea state does not change the simulated boat', () => {
    const run = (sea: number) => {
      const { sim, boat } = boatAtSea('speedboat');
      sim.weather.setFields({ seaState: sea });
      const out: number[] = [];
      for (let f = 0; f < 600; f++) {
        step(sim, 1 / 60, input({ throttle: 1, steer: Math.sin(f / 40) }));
        out.push(boat.pos.x, boat.pos.y, boat.pos.z, boat.heading);
      }
      return out;
    };
    const calm = run(0.3);
    expect(run(0.3)).toEqual(calm);
    expect(run(1)).toEqual(calm);
  });
});

describe('VAL-BOAT-005: boats run aground instead of driving on land', () => {
  it.each(BOATS)('the %s driven at the beach slows and stops short of dry land, and backs off again', (kind) => {
    // West from deep water towards Ocean Beach, which shelves to the sand.
    const { sim, boat } = boatAtSea(kind, true, 690, -200, -Math.PI / 2);
    let minDepth = Infinity;
    for (let f = 0; f < 60 * 25; f++) {
      step(sim, 1 / 60, input({ throttle: 1 }));
      minDepth = Math.min(minDepth, sim.world.waterDepth(boat.pos.x, boat.pos.z));
    }
    const stopX = boat.pos.x;
    console.log(`[boat] ${kind} aground at x ${stopX.toFixed(1)} (depth under its centre ${sim.world.waterDepth(boat.pos.x, boat.pos.z).toFixed(2)} m, speed ${boat.speed.toFixed(2)})`);
    expect(boat.speed).toBeLessThan(0.5);
    expect(minDepth).toBeGreaterThan(0);
    expect(hullDepth(boat, sim.world, boat.pos.x, boat.pos.z, boat.heading)).toBeGreaterThan(0);
    step(sim, 4, input({ brake: 1 }));
    expect(boat.pos.x - stopX).toBeGreaterThan(5);
  });

  it('a boat driven at the Azura Pier stops against its deck, not under or through it', () => {
    const pier = makeSim().world.layout.decks.find((d) => d.name === 'Azura Pier')!.rect;
    const { sim, boat } = boatAtSea('speedboat', true, 660, pier.minZ - 60, 0);
    for (let f = 0; f < 60 * 12; f++) {
      step(sim, 1 / 60, input({ throttle: 1 }));
      expect(boat.pos.z + boat.halfL).toBeLessThan(pier.minZ + 0.2);
    }
    expect(boat.speed).toBeLessThan(1);
  });

  it('a boat placed on land does not move under throttle', () => {
    const sim = makeSim();
    const rp = roadPoint(sim);
    const boat = sim.spawnVehicle('dinghy', rp.x, rp.z, rp.heading);
    placeInCar(sim, boat);
    step(sim, 3, input({ throttle: 1, steer: 1 }));
    expect(Math.hypot(boat.pos.x - rp.x, boat.pos.z - rp.z)).toBeLessThan(0.05);
  });
});

describe('VAL-BOAT-006: leaving a boat puts the player on the quay or in the water', () => {
  it.each(BOATS)('stopped at its mooring, F puts him standing on the pier; driven out to sea, F puts him in the water', (kind) => {
    const { sim } = atMarina();
    const boat = mooredBoats(sim).find((b) => b?.kind === kind)!;
    placeInCar(sim, boat);
    step(sim, 0.5);
    step(sim, 1 / 60, input({ enterExit: true }));
    const p = sim.player;
    expect(stepUntil(sim, 2, () => !p.vehicle)).toBeGreaterThanOrEqual(0);
    step(sim, 0.5);
    expect(p.state).toBe('normal');
    expect(p.pos.y).toBeCloseTo(0.45, 1);
    expect(sim.world.waterDepth(p.pos.x, p.pos.z)).toBeLessThan(0);
    // Back aboard from the pier, out into open water, stopped, and off.
    step(sim, 1 / 60, input({ enterExit: true }));
    expect(stepUntil(sim, 2, () => p.vehicle === boat)).toBeGreaterThanOrEqual(0);
    step(sim, 3, input({ brake: 1 }));
    boat.pos.x = 720;
    boat.pos.z = 0;
    boat.vel.x = 0;
    boat.vel.z = 2;
    step(sim, 1 / 60, input({ enterExit: true }));
    expect(stepUntil(sim, 2, () => !p.vehicle)).toBeGreaterThanOrEqual(0);
    step(sim, 1);
    expect(p.state).toBe('swimming');
    expect(Math.abs(p.pos.y - (WATER_Y - SWIM_FLOAT))).toBeLessThan(0.1);
    // The empty boat stays afloat and drifts only a little.
    const x0 = boat.pos.x;
    const z0 = boat.pos.z;
    step(sim, 10);
    expect(Math.hypot(boat.pos.x - x0, boat.pos.z - z0)).toBeLessThan(5);
    expect(boat.inWater).toBe(false);
    expect(boat.pos.y).toBeCloseTo(WATER_Y, 6);
    // Swimming back, F within 3 m climbs in again.
    p.pos.x = boat.pos.x + boat.halfW + 1.5;
    p.pos.z = boat.pos.z;
    step(sim, 0.3);
    step(sim, 1 / 60, input({ enterExit: true }));
    expect(stepUntil(sim, 2, () => p.vehicle === boat)).toBeGreaterThanOrEqual(0);
  });
});

describe('VAL-BOAT-007: boats are not caught by the car sinking logic, and cars still sink', () => {
  it('a boat in deep water never takes the car-in-water path; a sedan and a scooter in the sea still do', () => {
    const { sim, boat } = boatAtSea('speedboat');
    const sunk: Vehicle[] = [];
    const orig = sim.onVehicleEnteredWater.bind(sim);
    sim.onVehicleEnteredWater = (v: Vehicle) => {
      sunk.push(v);
      orig(v);
    };
    for (let f = 0; f < 60 * 15; f++) step(sim, 1 / 60, input({ throttle: f < 600 ? 1 : 0, steer: Math.sin(f / 50) }));
    expect(sunk).toEqual([]);
    expect(boat.driver).toBe(sim.player);
    expect(boat.rpm).toBeGreaterThan(0);
    expect(boat.drivable).toBe(true);
    for (const kind of ['sedan', 'scooter'] as const) {
      const v = sim.spawnVehicle(kind, 700, 200, 0);
      v.pos.y = 0.5;
      step(sim, 3);
      expect(v.inWater, kind).toBe(true);
      expect(sunk).toContain(v);
    }
  });
});
