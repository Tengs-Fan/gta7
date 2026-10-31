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
  it('stand at the Hollister T and the Creek T, for the country road alone, where the lights were', () => {
    const sim = makeSim({ police: false, ambient: false });
    const roads = sim.roads;
    for (const n of roads.nodes.slice(0, roads.gridNodeCount)) expect(n.stops).toBe(0);
    expect(roads.junction('drycreek').signal).toBe(true);
    expect(roads.junction('drycreek').stops).toBe(0);
    const props = sim.world.layout.props;
    for (const name of STOP_SIGNS) {
      const n = roads.junction(name);
      expect(n.signal, name).toBe(false);
      // The country road comes in from the north; the highway runs through east to west.
      expect(n.stops, name).toBe(1 << 0);
      for (const l of [roads.lanesBetween(n.neighbors[0]!, n.id)[0]!]) expect(roads.stopsAt(l)).toBe(true);
      for (const d of [1, 3]) for (const l of roads.lanesBetween(n.neighbors[d]!, n.id)) expect(roads.stopsAt(l)).toBe(false);
      const at = props.filter((p) => p.node === n.id);
      expect(at.map((p) => p.kind).sort(), name).toEqual(['lamp', 'lamp', 'stopSign']);
      // Southbound traffic stops: the sign stands on its right (west), north of the junction, facing it.
      const sign = at.find((p) => p.kind === 'stopSign')!;
      expect(sign.dir).toBe(2);
      expect(sign.x).toBeLessThan(n.x);
      expect(sign.z).toBeLessThan(n.z);
      expect(Math.abs(Math.cos(sign.rot) + 1)).toBeLessThan(1e-9);
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
