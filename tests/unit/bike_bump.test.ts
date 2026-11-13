// A car that runs into a bike at town speeds knocks it about and may throw its rider; it does not set it alight.
// (A scooter weighs 110 kg: between the car that hit it and the one stopped ahead of it at a light it is thrown from
// one to the other, every blow a full crash to something its weight, and a 29 km/h bump at the tail of a queue used to
// leave it burning, to blow up five seconds later under the player's bonnet. Sim.onVehicleImpact.)

import { describe, expect, it } from 'vitest';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { input, makeSim, placeInCar, world } from './helpers';

const DT = 1 / 60;
const BIKES = Object.values(VEHICLE_SPECS).filter((s) => s.class === 'bike').map((s) => s.kind);

/**
 * The player in a Thunderhoof coming down a lane at `speed` m/s on a ridden `kind` standing 32 m ahead, with a sedan
 * stopped just beyond it when `queue` is set (the tail of a queue at a light). He keeps his foot down for a second
 * after the bump, as someone who has not seen it does, then brakes; the scene runs 14 s on from the bump.
 */
function bump(kind: VehicleKind, speed: number, queue: boolean): { sim: Sim; car: Vehicle; bike: Vehicle; rider: Character; lowest: number; lit: boolean } {
  const sim = makeSim({ world: world(), ambient: false, police: false });
  const lane = sim.roads.lanes.find((l) => l.lanesInDir === 2 && l.length > 90)!;
  const at = (s: number) => ({ x: lane.sx + lane.dx * s, z: lane.sz + lane.dz * s });
  const car = sim.spawnVehicle('muscle', at(8).x, at(8).z, lane.heading);
  placeInCar(sim, car);
  const bike = sim.spawnVehicle(kind, at(40).x, at(40).z, lane.heading);
  const rider = sim.addDriver(bike, 'civilian', 'traffic');
  // He waits where he is (at a red light), whatever comes up behind him.
  bike.ai = null;
  if (queue) {
    const s = 40 + bike.halfL + VEHICLE_SPECS.sedan.length / 2 + 0.6;
    sim.spawnVehicle('sedan', at(s).x, at(s).z, lane.heading);
  }
  let hitAt = -1;
  let lowest = bike.health;
  let lit = false;
  for (let i = 0; i < 60 * 20 && (hitAt < 0 || i - hitAt < 60 * 14); i++) {
    if (hitAt < 0) {
      car.vel.x = lane.dx * speed;
      car.vel.z = lane.dz * speed;
    }
    sim.update(DT, input(hitAt >= 0 && i - hitAt > 60 ? { brake: 1 } : { throttle: 1 }));
    if (hitAt < 0 && (bike.health < bike.spec.health || Math.hypot(bike.vel.x, bike.vel.z) > 1)) hitAt = i;
    lowest = Math.min(lowest, bike.health);
    lit ||= bike.burning || bike.destroyed;
  }
  expect(hitAt, 'the car reached the bike').toBeGreaterThanOrEqual(0);
  return { sim, car, bike, rider, lowest, lit };
}

describe('a car bumps a bike', () => {
  for (const kind of BIKES) {
    it.each([8, 10, 13, 16])(`${kind} at the tail of a queue, hit at %d m/s: knocked about, not alight`, (speed) => {
      const r = bump(kind, speed, true);
      console.log(`[bump] ${kind} in a queue at ${speed} m/s: health ${r.lowest.toFixed(0)}/${r.bike.spec.health}, rider ${r.rider.alive ? (r.rider.vehicle ? 'on' : 'off') : 'dead'}, the car ${r.car.health.toFixed(0)}`);
      expect(r.lit).toBe(false);
      expect(r.lowest).toBeGreaterThanOrEqual(1);
      // Nothing of the bike's doing harms the car that hit it: no blast under its bonnet.
      expect(r.car.burning || r.car.destroyed).toBe(false);
      expect(r.car.health).toBeGreaterThan(r.car.spec.health * 0.7);
    });

    it(`${kind} on open road, hit at 16 m/s: damaged, not alight`, () => {
      const r = bump(kind, 16, false);
      console.log(`[bump] ${kind} on open road at 16 m/s: health ${r.lowest.toFixed(0)}/${r.bike.spec.health}`);
      expect(r.lit).toBe(false);
      expect(r.lowest).toBeLessThan(r.bike.spec.health);
      expect(r.lowest).toBeGreaterThanOrEqual(1);
    });

    it(`${kind} in a queue, hit flat out at 40 m/s: that still wrecks it and it burns`, () => {
      const r = bump(kind, 40, true);
      console.log(`[bump] ${kind} in a queue at 40 m/s: health ${r.lowest.toFixed(0)}/${r.bike.spec.health}, lit ${r.lit}`);
      expect(r.lit).toBe(true);
    });
  }

  it('a car in the same queue is unchanged by this: hit at 16 m/s it keeps over half its health', () => {
    const r = bump('sedan', 16, true);
    expect(r.lit).toBe(false);
    expect(r.lowest).toBeGreaterThan(r.bike.spec.health * 0.5);
    expect(r.lowest).toBeLessThan(r.bike.spec.health);
  });
});
