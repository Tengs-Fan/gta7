// Las Lomas County's stop signs (docs/map.md): the Hollister T and the Creek T have no lights, and Hollister Lane and
// Creek Road stop for the Lomas Highway. A car on the country road stops at the line, waits for the highway's traffic
// and goes once it is clear, at once when it is empty; never while someone is in the junction; and a pursuer runs it.

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import type { VehicleKind } from '../../src/sim/specs';
import { STOP_SIGNS } from '../../src/world/country';
import type { Lane, RoadNode } from '../../src/world/roads';
import { makeSim, step, teleport } from './helpers';

/** An AI car on `lane` at `s`, rolling at `speed`, cruising at the limit. */
function aiCar(sim: Sim, lane: Lane, s: number, speed: number, kind: VehicleKind = 'pickup'): Vehicle {
  const v = sim.spawnVehicle(kind, lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
  v.owner = 'traffic';
  sim.addDriver(v, 'civilian', 'traffic').owner = 'traffic';
  v.ai!.speedMul = 1;
  v.ai!.setLane(lane, s);
  v.vel.x = lane.dx * speed;
  v.vel.z = lane.dz * speed;
  return v;
}

/** The Creek T, Creek Road's last lane into it from the north, and the highway's westbound outer lane into it from the east. */
function creekT(sim: Sim): { node: RoadNode; minor: Lane; highway: Lane } {
  const roads = sim.roads;
  const node = roads.junction('creek');
  return { node, minor: roads.lanesBetween(node.neighbors[0]!, node.id)[0]!, highway: roads.lanesBetween(node.neighbors[1]!, node.id)[1]! };
}

/** How far the front bumper of `v`, on `lane`, is short of the lane's end (the stop line's side of it). */
function toLine(v: Vehicle, lane: Lane): number {
  return lane.length - ((v.pos.x - lane.sx) * lane.dx + (v.pos.z - lane.sz) * lane.dz) - v.halfL;
}

const inBox = (v: Vehicle, n: RoadNode) => Math.abs(v.pos.x - n.x) < n.halfX + 2 && Math.abs(v.pos.z - n.z) < n.halfZ + 2;

describe('Las Lomas County: stop signs', () => {
  it('stand at the county\'s four Ts, for the country road alone, where the lights were', () => {
    const sim = makeSim({ police: false, ambient: false });
    const roads = sim.roads;
    for (const n of roads.nodes.slice(0, roads.gridNodeCount)) expect(n.stops).toBe(0);
    expect(roads.junction('drycreek').signal).toBe(true);
    expect(roads.junction('drycreek').stops).toBe(0);
    const props = sim.world.layout.props;
    expect([...STOP_SIGNS]).toEqual(['hollister', 'creek', 'coyote', 'valley']);
    // Which arm stops, the way its traffic travels in (0 N, 1 E, 2 S, 3 W), and which corner its sign stands on.
    const ARM = {
      hollister: { slot: 0, dir: 2, west: true, north: true },
      creek: { slot: 0, dir: 2, west: true, north: true },
      coyote: { slot: 3, dir: 1, west: true, north: false },
      valley: { slot: 1, dir: 3, west: false, north: true },
    } as const;
    for (const name of STOP_SIGNS) {
      const n = roads.junction(name);
      const arm = ARM[name as keyof typeof ARM];
      expect(n.signal, name).toBe(false);
      // The country road comes in from one side, the through road runs across it.
      expect(n.stops, name).toBe(1 << arm.slot);
      expect(roads.stopsAt(roads.lanesBetween(n.neighbors[arm.slot]!, n.id)[0]!), name).toBe(true);
      for (const d of [0, 1, 2, 3].filter((d) => d !== arm.slot && n.neighbors[d]! >= 0)) for (const l of roads.lanesBetween(n.neighbors[d]!, n.id)) expect(roads.stopsAt(l), name).toBe(false);
      const at = props.filter((p) => p.node === n.id);
      expect(at.map((p) => p.kind).sort(), name).toEqual(['lamp', 'lamp', 'stopSign']);
      // The sign stands on the stopping traffic's right, before the junction, facing it.
      const sign = at.find((p) => p.kind === 'stopSign')!;
      expect(sign.dir, name).toBe(arm.dir);
      expect(sign.x < n.x, name).toBe(arm.west);
      expect(sign.z < n.z, name).toBe(arm.north);
      const travel = [[0, -1], [1, 0], [0, 1], [-1, 0]][arm.dir]!;
      expect(Math.abs(Math.sin(sign.rot) + travel[0]!) + Math.abs(Math.cos(sign.rot) + travel[1]!), name).toBeLessThan(1e-9);
    }
  });

  it('a pickup on Creek Road stops at the line, waits for a car 60 m out at 22 m/s on the highway, then goes', () => {
    const sim = makeSim({ seed: 1, police: false, ambient: false });
    teleport(sim, -700, 150);
    const { node, minor, highway } = creekT(sim);
    const pickup = aiCar(sim, minor, minor.length - 45, 10);
    let t = 0;
    for (; t < 15 && !(pickup.speed < 0.3 && toLine(pickup, minor) < 3); t += 1 / 60) step(sim, 1 / 60);
    console.log(`[stop_sign] stood at the line ${toLine(pickup, minor).toFixed(2)} m short of the lane's end after ${t.toFixed(1)} s`);
    expect(toLine(pickup, minor)).toBeLessThan(3);
    expect(toLine(pickup, minor)).toBeGreaterThan(0);
    // The highway car 60 m east of the junction's centre at 22 m/s, heading west into it.
    const s = (node.x + 60 - highway.sx) * highway.dx;
    const car = aiCar(sim, highway, s, 22, 'sedan');
    let passedAt = -1;
    let wentAt = -1;
    for (t = 0; t < 12 && wentAt < 0; t += 1 / 60) {
      step(sim, 1 / 60);
      if (passedAt < 0 && car.pos.x < node.x - node.halfX - 2) passedAt = t;
      if (toLine(pickup, minor) < -0.5) wentAt = t;
      // Never while the sedan is coming or in the junction.
      if (passedAt < 0) expect(pickup.speed, `t ${t.toFixed(2)}`).toBeLessThan(0.6);
      if (inBox(pickup, node)) expect(inBox(car, node)).toBe(false);
    }
    console.log(`[stop_sign] the sedan cleared the junction after ${passedAt.toFixed(2)} s, the pickup crossed its line after ${wentAt.toFixed(2)} s`);
    expect(passedAt).toBeGreaterThan(1.5);
    expect(wentAt).toBeGreaterThan(passedAt);
    expect(wentAt - passedAt).toBeLessThan(4);
  });

  it('goes at once on an empty highway, after its stop', () => {
    const sim = makeSim({ seed: 2, police: false, ambient: false });
    teleport(sim, -700, 150);
    const { minor } = creekT(sim);
    const pickup = aiCar(sim, minor, minor.length - 45, 10);
    let stoodAt = -1;
    let wentAt = -1;
    let slowest = Infinity;
    for (let t = 0; t < 20 && wentAt < 0; t += 1 / 60) {
      step(sim, 1 / 60);
      const gap = toLine(pickup, minor);
      if (gap < 3) slowest = Math.min(slowest, pickup.speed);
      if (stoodAt < 0 && pickup.speed < 0.3 && gap < 3) stoodAt = t;
      if (gap < -0.5) wentAt = t;
    }
    console.log(`[stop_sign] on an empty highway: stood at ${stoodAt.toFixed(2)} s, over the line at ${wentAt.toFixed(2)} s`);
    expect(slowest).toBeLessThan(0.6);
    expect(stoodAt).toBeGreaterThan(0);
    expect(wentAt - stoodAt).toBeLessThan(3);
  });

  // A car left in the Creek T's box (its half and 2 m, 10 m), out of the pickup's way, that nobody drives: parked on the
  // box's corner, on a verge or on the highway's far lane, or burnt out there. It is in the way like any obstacle, not
  // traffic to wait for; counted as traffic in the box it held the pickup at the line for good.
  it.each([
    ['parked on the corner', 7, 7, false],
    ["parked on the highway's far lane", 3, 6, false],
    ["burnt out on the highway's far lane", 3, 6, true],
    ['parked on the south verge', 0, 9.5, false],
    ['parked on the north-west verge', -9.5, -9.5, false],
  ] as const)('goes on past a car %s in the junction', (where, bx, bz, wreck) => {
    const sim = makeSim({ seed: 1, police: false, ambient: false });
    const { node, minor } = creekT(sim);
    teleport(sim, node.x - 30, node.z - 30);
    const b = sim.spawnVehicle('sedan', node.x + bx, node.z + bz, Math.PI / 2);
    b.owner = 'parked';
    b.destroyed = wreck;
    const pickup = aiCar(sim, minor, minor.length - 40, 8);
    let crossed = -1;
    for (let t = 0; t < 30 && crossed < 0; t += 1 / 60) {
      step(sim, 1 / 60);
      if (toLine(pickup, minor) < -pickup.halfL - 1) crossed = t;
    }
    console.log(`[stop_sign] past a car ${where}: crossed the line after ${crossed.toFixed(1)} s`);
    expect(crossed).toBeGreaterThan(0);
    expect(crossed).toBeLessThan(12);
  });

  it('a pursuer runs it', () => {
    const sim = makeSim({ seed: 3, police: false, ambient: false });
    const { node, minor } = creekT(sim);
    // The player on foot on the highway west of the junction: the car on Creek Road chases him round the corner.
    teleport(sim, node.x - 120, node.z + 4);
    const v = sim.spawnVehicle('police', minor.sx + minor.dx * (minor.length - 60), minor.sz + minor.dz * (minor.length - 60), minor.heading);
    v.owner = 'police';
    sim.addDriver(v, 'cop', 'chase');
    v.ai!.setLane(minor, minor.length - 60);
    v.ai!.target = sim.player;
    v.vel.x = minor.dx * 12;
    v.vel.z = minor.dz * 12;
    let slowest = Infinity;
    let crossed = false;
    for (let t = 0; t < 10 && !crossed; t += 1 / 60) {
      step(sim, 1 / 60);
      const gap = toLine(v, minor);
      if (gap < 8 && gap > -2) slowest = Math.min(slowest, v.speed);
      crossed = gap < -2;
    }
    console.log(`[stop_sign] the pursuer crossed the line at ${slowest.toFixed(1)} m/s at the slowest`);
    expect(crossed).toBe(true);
    expect(slowest).toBeGreaterThan(3);
  });
});
