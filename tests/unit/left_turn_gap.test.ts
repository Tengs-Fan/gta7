// A driver turning left across oncoming traffic judges the gap by when the oncoming car gets there, not only by how far
// away it is: a racer (or a getaway) at 24 m/s covers the old 38 m look in 1.6 s, quicker than a turn clears.

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { axisOf, reverseDir, SIGNAL_CYCLE, SIGNAL_HALF, type Lane } from '../../src/world/roads';
import { input, makeSim, placeInCar } from './helpers';

function setup(sim: Sim) {
  const roads = sim.roads;
  const oncomingLane = (l: Lane) => roads.laneFrom(roads.nodes[l.to]!.neighbors[l.dir]!, reverseDir(l.dir), 0);
  // The inner lane of an avenue into a signalled crossing with another avenue, turning left onto it.
  const lane = roads.lanes.find((l) => {
    const n = roads.nodes[l.to]!;
    if (!l.line.avenue || l.index !== 0 || l.length < 60 || !n.signal || n.degree !== 4) return false;
    const left = l.turns.find((t) => t.kind === 'left');
    const opp = oncomingLane(l);
    return !!left && left.legal && left.to.line.avenue && !!opp && opp.to === l.to && opp.length >= 80;
  })!;
  const node = roads.nodes[lane.to]!;
  const turn = lane.turns.find((t) => t.kind === 'left')!;
  return { lane, node, turn, opp: oncomingLane(lane)! };
}

/** Calls `hit` for every vehicle-vehicle contact between `a` and `b`. */
function countImpacts(sim: Sim, a: Vehicle, b: Vehicle, hit: () => void): void {
  const impact = sim.onVehicleImpact.bind(sim);
  sim.onVehicleImpact = (v: Vehicle, other: Vehicle | null, ...rest: unknown[]) => {
    if ((v === a && other === b) || (v === b && other === a)) hit();
    return (impact as (...args: unknown[]) => void)(v, other, ...rest);
  };
}

function gap(a: Vehicle, b: Vehicle): number {
  let g = -Infinity;
  for (const v of [a, b]) {
    for (const [ax, az] of [[Math.sin(v.heading), Math.cos(v.heading)], [Math.cos(v.heading), -Math.sin(v.heading)]] as const) {
      const span = (u: Vehicle) => {
        const c = u.pos.x * ax + u.pos.z * az;
        const e = Math.abs(Math.sin(u.heading) * ax + Math.cos(u.heading) * az) * u.halfL + Math.abs(Math.cos(u.heading) * ax - Math.sin(u.heading) * az) * u.halfW;
        return [c - e, c + e] as const;
      };
      const [a0, a1] = span(a);
      const [b0, b1] = span(b);
      g = Math.max(g, b0 - a1, a0 - b1);
    }
  }
  return g;
}

describe('left turn across a fast oncoming car', () => {
  for (const startGap of [50, 65, 80]) {
    it(`waits for a racer at 24 m/s ${startGap} m from the junction`, () => {
      const sim = makeSim({ police: false });
      const { lane, node, turn, opp } = setup(sim);
      // Green both ways along the turner's road for the whole test, as the green wave holds it.
      sim.roads.holdSignal(node.id, axisOf(lane.dir));
      const turner = sim.spawnVehicle('van', lane.sx + lane.dx * (lane.length - 14), lane.sz + lane.dz * (lane.length - 14), lane.heading);
      turner.owner = 'traffic';
      sim.addDriver(turner, 'civilian', 'route');
      turner.ai!.speedMul = 1;
      const exit = sim.roads.nodes[turn.to.to]!;
      turner.ai!.dest = { x: exit.x, z: exit.z };
      turner.ai!.setLane(lane, lane.length - 14);
      turner.vel.x = lane.dx * 6;
      turner.vel.z = lane.dz * 6;
      // The racer: the player's car straight down the oncoming lane at 24 m/s.
      const s0 = opp.length - startGap;
      const racer = sim.spawnVehicle('sports', opp.sx + opp.dx * s0, opp.sz + opp.dz * s0, opp.heading);
      placeInCar(sim, racer);
      racer.vel.x = opp.dx * 24;
      racer.vel.z = opp.dz * 24;
      let impacts = 0;
      countImpacts(sim, racer, turner, () => impacts++);
      let closest = Infinity;
      for (let f = 0; f < 60 * 8; f++) {
        const inp = input({ throttle: racer.forwardSpeed < 24 ? 1 : 0 });
        inp.aimOrigin = { x: racer.pos.x - opp.dx * 6, y: 3, z: racer.pos.z - opp.dz * 6 };
        sim.update(1 / 60, inp);
        closest = Math.min(closest, gap(racer, turner));
      }
      // The racer went through, and the van turned after it.
      expect((racer.pos.x - node.x) * opp.dx + (racer.pos.z - node.z) * opp.dz).toBeGreaterThan(40);
      expect(impacts).toBe(0);
      expect(closest).toBeGreaterThan(1.5);
      expect(turner.ai!.currentLane()).toBe(turn.to);
    });
  }
});

describe('cross traffic at a junction released under a racer', () => {
  for (const kind of ['sedan', 'bus'] as const) {
    it(`a ${kind} waiting at the cross line does not pull out in front of a racer at 24 m/s when its light turns green`, () => {
      const sim = makeSim({ police: false });
      const roads = sim.roads;
      const { lane: racerLane, node } = setup(sim);
      const racerAxis = axisOf(racerLane.dir);
      // A cross-street lane into the same junction, from the racer's right, long enough to queue on.
      const cross = roads.lanes.find((l) => l.to === node.id && axisOf(l.dir) !== racerAxis && l.length > 40)!;
      roads.holdSignal(node.id, racerAxis);
      const waiting = sim.spawnVehicle(kind, cross.sx + cross.dx * (cross.length - 8), cross.sz + cross.dz * (cross.length - 8), cross.heading);
      waiting.owner = 'traffic';
      sim.addDriver(waiting, 'civilian', 'traffic');
      waiting.ai!.speedMul = 1;
      waiting.ai!.setLane(cross, cross.length - 8);
      // Let it settle at the red line.
      for (let f = 0; f < 120; f++) sim.update(1 / 60, input());
      const x0 = waiting.pos.x;
      const z0 = waiting.pos.z;
      const s0 = racerLane.length - 70;
      const racer = sim.spawnVehicle('sports', racerLane.sx + racerLane.dx * s0, racerLane.sz + racerLane.dz * s0, racerLane.heading);
      placeInCar(sim, racer);
      racer.vel.x = racerLane.dx * 24;
      racer.vel.z = racerLane.dz * 24;
      let impacts = 0;
      countImpacts(sim, racer, waiting, () => impacts++);
      let closest = Infinity;
      let released = false;
      for (let f = 0; f < 60 * 6; f++) {
        // The racer is credited 12 m before the junction centre and the hold goes; the cross street's green starts now.
        if (!released && Math.hypot(racer.pos.x - node.x, racer.pos.z - node.z) < 12.5) {
          released = true;
          roads.releaseSignal(node.id);
          const start = racerAxis === 'NS' ? SIGNAL_HALF : 0;
          node.offset = (((start - sim.time) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
        }
        const inp = input({ throttle: racer.forwardSpeed < 24 ? 1 : 0 });
        inp.aimOrigin = { x: racer.pos.x - racerLane.dx * 6, y: 3, z: racer.pos.z - racerLane.dz * 6 };
        sim.update(1 / 60, inp);
        closest = Math.min(closest, gap(racer, waiting));
      }
      expect(released).toBe(true);
      // It went on its green once the racer was through.
      expect(Math.hypot(waiting.pos.x - x0, waiting.pos.z - z0)).toBeGreaterThan(8);
      expect(impacts).toBe(0);
      expect(closest).toBeGreaterThan(1.5);
    });
  }
});
