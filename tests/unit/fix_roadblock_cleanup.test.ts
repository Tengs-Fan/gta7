// A roadblock stands out of the player's sight far ahead of him (roadblocks.ts places it up to 340 m on): the police's
// generic distance cleanup must leave its parked cruisers and posted officers alone until the roadblock itself is
// taken down, and a roadblock whose cruisers and officers are all gone some other way is dropped so another can come.

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { Roadblock } from '../../src/sim/roadblocks';
import type { Sim } from '../../src/sim/sim';
import { input, makeSim } from './helpers';

/** The scrutiny scenario: seed 7, 3 stars, a sedan coasting north up the e2e avenue fixture until the first roadblock. */
function avenue(): { sim: Sim; car: Vehicle; rb: Roadblock; frame: (braking: boolean, throttle?: number) => void } {
  const sim = makeSim({ seed: 7, ambient: true, police: true, streetCrime: true });
  sim.cheats.godMode = true;
  sim.missions.noBust = true;
  const lane = sim.roads.lanes
    .filter((l) => l.line.avenue && Math.abs(l.dx) < 0.1 && l.dz > 0 && l.sz < -150 && l.sz > -260 && l.length > 60)
    .sort((a, b) => Math.abs(a.line.pos) - Math.abs(b.line.pos))[0]!;
  const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 4, lane.sz + lane.dz * 4, lane.heading);
  sim.seat(sim.player, car, 0);
  car.usedByPlayer = true;
  car.vel.x = lane.dx * 8;
  car.vel.z = lane.dz * 8;
  sim.wanted.setLevel(3);
  const frame = (braking: boolean, throttle = 0) => {
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const dir = braking ? -1 : 1;
    const n = Math.hypot(1, 0.1);
    // He keeps to his lane, aiming 15 m ahead along it, so a cruiser's shove does not put him off the road
    // (positive steer turns right, towards a lower heading).
    const s = (car.pos.x - lane.sx) * lane.dx + (car.pos.z - lane.sz) * lane.dz + 15;
    const want = Math.atan2(lane.sx + lane.dx * s - car.pos.x, lane.sz + lane.dz * s - car.pos.z);
    const err = Math.atan2(Math.sin(want - car.heading), Math.cos(want - car.heading));
    const steer = Math.max(-1, Math.min(1, -err * 3));
    // A third-person camera; braking, the driver looks back over his shoulder.
    const inp = input({ brake: braking ? 1 : 0, handbrake: braking, throttle, steer });
    inp.aimOrigin = { x: car.pos.x - dir * fx * 8, y: car.pos.y + 3, z: car.pos.z - dir * fz * 8 };
    inp.aimDir = { x: (dir * fx) / n, y: -0.1 / n, z: (dir * fz) / n };
    inp.cameraYaw = Math.atan2(dir * fx, dir * fz);
    sim.update(1 / 60, inp);
  };
  for (let i = 0; i < 10 * 60 && sim.roadblocks.roadblocks.length === 0; i++) frame(false);
  const rb = sim.roadblocks.roadblocks[0]!;
  expect(rb).toBeDefined();
  return { sim, car, rb, frame };
}

const live = (sim: Sim, rb: Roadblock) => ({
  cars: rb.cars.filter((v) => !v.removed && sim.vehicles.includes(v)).length,
  parked: rb.cars.filter((v) => sim.roadblocks.isParked(v)).length,
  officers: rb.officers.filter((c) => !c.removed && c.alive && sim.characters.includes(c)).length,
});

describe('roadblock entities and the police cleanup', () => {
  it('a roadblock far ahead and unseen keeps its cruisers and officers through the generic cleanup', () => {
    const { sim, car, rb, frame } = avenue();
    const d0 = Math.hypot(rb.x - car.pos.x, rb.z - car.pos.z);
    expect(live(sim, rb)).toEqual({ cars: 2, parked: 2, officers: 2 });
    // Several 1 s police cleanup ticks with him stopped ~350 m short of it, looking back.
    for (let i = 0; i < 6 * 60; i++) frame(true);
    const d = Math.hypot(rb.x - car.pos.x, rb.z - car.pos.z);
    console.log(`[roadblock] #${rb.id} ${d0.toFixed(0)} m ahead at spawn, ${d.toFixed(0)} m after 6 s stopped: ${JSON.stringify(live(sim, rb))}, strip live ${!!rb.strip && !rb.strip.removed}`);
    expect(d).toBeGreaterThan(290);
    expect(live(sim, rb)).toEqual({ cars: 2, parked: 2, officers: 2 });
    expect(rb.removedAt).toBe(-1);
    expect(sim.roadblocks.roadblocks).toContain(rb);
  });

  it('driving on, he finds the cruisers still across the road', () => {
    const { sim, car, rb, frame } = avenue();
    for (let i = 0; i < 3 * 60; i++) frame(true);
    let closest = Infinity;
    let at: ReturnType<typeof live> | null = null;
    for (let i = 0; i < 60 * 60 && closest > 120; i++) {
      frame(false, 1);
      closest = Math.min(closest, Math.hypot(rb.x - car.pos.x, rb.z - car.pos.z));
      if (closest <= 120) at = live(sim, rb);
    }
    console.log(`[roadblock] #${rb.id} reached within ${closest.toFixed(0)} m at t ${sim.time.toFixed(1)}: ${JSON.stringify(at)}`);
    expect(closest).toBeLessThanOrEqual(120);
    expect(at!.cars).toBe(2);
    expect(at!.parked).toBe(2);
  });

  it('a roadblock with every cruiser and officer gone is dropped with its strip, so another can be placed', () => {
    const { sim, rb } = avenue();
    for (const v of rb.cars) sim.removeVehicle(v);
    for (const c of rb.officers) sim.removeCharacter(c);
    sim.update(1 / 60, input());
    expect(rb.removedAt).toBeGreaterThanOrEqual(0);
    expect(sim.roadblocks.roadblocks).not.toContain(rb);
    expect(rb.strip!.removed).toBe(true);
    expect(sim.roadblocks.strips).not.toContain(rb.strip);
  });
});
