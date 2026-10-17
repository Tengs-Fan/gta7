// Round 2 fix pass 2, cluster "police" (which owns traffic.ts): parked cars stream into a bay only when no other
// vehicle stands over it. The bay used to be checked by centre distance alone (no vehicle centre within 3.5 m),
// so a bus or a car left in line with the bay 4 m off still had a parked car spawned inside it.

import { describe, expect, it } from 'vitest';
import { makeContact, obbVsObb, type OBB } from '../../src/core/collision';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import type { VehicleKind } from '../../src/sim/specs';
import { vehicleObb } from '../../src/sim/vehiclePhysics';
import { makeSim } from './helpers';

/** Runs one parked-car streaming pass (it runs every 1.1 s). */
const streamOnce = (sim: Sim) => sim.traffic.updateStreaming(1.2);

function overlaps(a: Vehicle, b: Vehicle): number {
  const oa: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
  const ob: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
  const c = makeContact();
  return obbVsObb(vehicleObb(a, oa), vehicleObb(b, ob), c) ? c.depth : 0;
}

describe('parked cars', () => {
  it('stream into a bay only when no other vehicle stands over it, and fill it again once it is clear', () => {
    const sim = makeSim({ police: false });
    sim.traffic.density = 0;
    streamOnce(sim);
    const bays = [...sim.traffic.parkedBySpot].slice(0, 6);
    expect(bays.length).toBeGreaterThanOrEqual(6);
    // [kind, metres from the bay's centre along its axis, metres across, heading relative to the bay's, and whether
    // it keeps the bay empty: true over the bay whatever car the bay takes, false clear of it, null depending on that car]
    const cases: Array<readonly [VehicleKind, number, number, number, boolean | null]> = [
      ['bus', 4, 0, 0, true],
      ['sedan', 4, 0, 0, true],
      ['pickup', -4.2, 0, 0, true],
      ['sedan', 3.2, 2.2, Math.PI / 2, null],
      ['van', 0.6, 3.7, 0.4, false],
      ['sports', -2.6, -2.8, -0.8, null],
    ];
    const log: string[] = [];
    bays.forEach(([index, parked], k) => {
      const [kind, along, across, turn, blocks] = cases[k]!;
      const s = sim.world.layout.parking[index]!;
      sim.removeVehicle(parked);
      const fx = Math.sin(s.heading);
      const fz = Math.cos(s.heading);
      // Across: the bay's local +X (see vehicleObb).
      const other = sim.spawnVehicle(kind, s.x + fx * along + Math.cos(s.heading) * across, s.z + fz * along - Math.sin(s.heading) * across, s.heading + turn);
      streamOnce(sim);
      const now = sim.traffic.parkedBySpot.get(index);
      const depth = now ? overlaps(now, other) : 0;
      log.push(`bay ${index}, ${kind} ${along} m along, ${across} m across: ${now ? `${now.kind} streamed in, overlap ${depth.toFixed(2)} m` : 'left empty'}`);
      expect(depth, log.join('; ')).toBe(0);
      if (blocks !== null) expect(!now, log.join('; ')).toBe(blocks);
      // Gone again: the bay fills as before (once a neighbour that filled meanwhile is gone too, see the spacing below).
      sim.removeVehicle(other);
      for (const v of sim.vehicles) if (Math.hypot(v.pos.x - s.x, v.pos.z - s.z) < 3.5) sim.removeVehicle(v);
      streamOnce(sim);
      expect(sim.traffic.parkedBySpot.get(index), `bay ${index} refills once clear`).toBeDefined();
    });
    // No parked car anywhere overlaps another vehicle.
    for (const v of sim.traffic.parkedBySpot.values()) {
      for (const o of sim.vehicles) if (o !== v && !o.removed) expect(overlaps(v, o), `${v.kind} ${v.id} and ${o.kind} ${o.id}`).toBe(0);
    }
  });

  it('are not kept out of a bay by a vehicle in the air above it, which they would not touch', () => {
    // Round 2 fix pass 2 (Codex review): vehicles at different heights do not collide (see collideVehicles), so the
    // footprint test leaves them out too, as it did not at first.
    const sim = makeSim({ police: false });
    sim.traffic.density = 0;
    streamOnce(sim);
    const [index, parked] = [...sim.traffic.parkedBySpot][0]!;
    const s = sim.world.layout.parking[index]!;
    sim.removeVehicle(parked);
    const bus = sim.spawnVehicle('bus', s.x + Math.sin(s.heading) * 4, s.z + Math.cos(s.heading) * 4, s.heading);
    bus.pos.y += 10;
    streamOnce(sim);
    const now = sim.traffic.parkedBySpot.get(index);
    expect(now, 'the bay fills under the bus').toBeDefined();
    // The same bus on the ground keeps it empty (see above).
    sim.removeVehicle(now!);
    bus.pos.y -= 10;
    streamOnce(sim);
    expect(sim.traffic.parkedBySpot.get(index)).toBeUndefined();
  });

  it('still keep the bays beside a parked car empty, so a lot fills every other bay at most', () => {
    // The footprint test alone would let neighbouring bays (3.2 m apart) both fill: kept as before on purpose,
    // since it decides how many cars a street scene draws.
    const sim = makeSim({ police: false });
    sim.traffic.density = 0;
    streamOnce(sim);
    const parked = [...sim.traffic.parkedBySpot.values()];
    expect(parked.length).toBeGreaterThan(5);
    for (const a of parked) for (const b of parked) if (a !== b) expect(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)).toBeGreaterThanOrEqual(3.5);
  });
});
