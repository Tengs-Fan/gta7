// Rush-hour traffic behind a car the player left standing in the middle of a street lane (VAL-TRAFFIC-002): drivers
// held up by it go round it without standing there for 20 s. Seed 3 at 17:00 is a busy stretch: a driver that sat out
// the full overtaking patience behind it let the gaps in oncoming traffic go by, and stood there for over 20 s.

import { describe, expect, it } from 'vitest';
import { input, makeSim, teleport } from './helpers';

describe('a car abandoned mid-lane in rush-hour traffic', () => {
  it('keeps no driver within 130 m stuck for more than 20 s', () => {
    const sim = makeSim({ ambient: true, police: false, seed: 3, startHour: 17 });
    const n = sim.roads.node(4, 7);
    const lane = sim.roads.lanes.find((l) => l.from === n.id)!;
    const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * lane.length * 0.5, lane.sz + lane.dz * lane.length * 0.5, lane.heading);
    car.usedByPlayer = true;
    // The player stands idle off the junction corner, the camera slowly turning.
    const x = n.x + n.halfX + 3;
    const z = n.z + n.halfZ + 3;
    teleport(sim, x, z);
    let yaw = 0;
    const stuck = new Map<number, number>();
    for (let f = 0; f < 180 * 60; f++) {
      sim.player.pos.x = x;
      sim.player.pos.z = z;
      yaw += 0.15 / 60;
      const d = { x: Math.sin(yaw), y: -0.1, z: Math.cos(yaw) };
      sim.update(1 / 60, input({ cameraYaw: yaw, aimDir: d, aimOrigin: { x: x - d.x * 4.3, y: sim.player.pos.y + 2.6, z: z - d.z * 4.3 } }));
      for (const v of sim.vehicles) {
        if (v.removed || !v.ai || !v.driver || v.driver.isPlayer || v.destroyed || Math.hypot(v.pos.x - x, v.pos.z - z) > 130) continue;
        if (v.stuckTime > 20) stuck.set(v.id, Math.max(stuck.get(v.id) ?? 0, v.stuckTime));
      }
    }
    expect([...stuck]).toEqual([]);
    // Traffic went round it: the car is still where the player left it.
    expect(car.removed).toBe(false);
    expect(Math.hypot(car.pos.x - (lane.sx + lane.dx * lane.length * 0.5), car.pos.z - (lane.sz + lane.dz * lane.length * 0.5))).toBeLessThan(1);
  }, 60_000);
});
