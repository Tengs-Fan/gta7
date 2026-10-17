// Round 2 fix pass, cluster "driver": a reproducible simulation (no Math.random in the sim), and the
// driving AI's overtaking and reversing in tight spots.

import { describe, expect, it } from 'vitest';
import type { DriverPolicy } from '../../src/sim/driver';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import type { VehicleKind } from '../../src/sim/specs';
import type { Lane } from '../../src/world/roads';
import { input, makeSim, step } from './helpers';

/** A one-lane street lane of 80 m or more ending at a signalled four-way junction (as in fix_driving). */
function streetLane(sim: Sim): Lane {
  return sim.roads.lanes.find((l) => !l.line.avenue && l.length >= 80 && sim.roads.nodes[l.to]!.signal && sim.roads.nodes[l.to]!.degree === 4)!;
}

/** The lane running the other way on the same stretch of road. */
function oppositeLane(sim: Sim, lane: Lane): Lane {
  return sim.roads.lanes.find((l) => l.from === lane.to && l.to === lane.from)!;
}

function signalsOff(sim: Sim): void {
  for (const n of sim.roads.nodes) n.signal = false;
}

/** An AI-driven vehicle placed on `lane` at distance `s`, rolling at `speed`. */
function drive(sim: Sim, kind: VehicleKind, lane: Lane, s: number, speed = 0, policy: DriverPolicy = 'traffic'): Vehicle {
  const v = sim.spawnVehicle(kind, lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
  v.owner = 'traffic';
  sim.addDriver(v, 'civilian', policy);
  if (policy === 'traffic' || policy === 'route') v.ai!.speedMul = 1;
  v.ai!.setLane(lane, s);
  v.vel.x = lane.dx * speed;
  v.vel.z = lane.dz * speed;
  return v;
}

/** A car nobody drives, standing on `lane` at distance `s`. */
function abandon(sim: Sim, kind: VehicleKind, lane: Lane, s: number): Vehicle {
  return sim.spawnVehicle(kind, lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
}

/** Distance along the lane direction from its start. */
function along(lane: Lane, p: { x: number; z: number }): number {
  return (p.x - lane.sx) * lane.dx + (p.z - lane.sz) * lane.dz;
}

/** Sideways offset from the lane centre line (positive to its right). */
function across(lane: Lane, p: { x: number; z: number }): number {
  return (p.x - lane.sx) * -lane.dz + (p.z - lane.sz) * lane.dx;
}

/** Distance from a point to the vehicle body (negative inside). */
function bodyDistance(v: Vehicle, x: number, z: number): number {
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  const dx = x - v.pos.x;
  const dz = z - v.pos.z;
  const a = Math.abs(dx * fx + dz * fz) - v.halfL;
  const b = Math.abs(dx * -fz + dz * fx) - v.halfW;
  return Math.hypot(Math.max(a, 0), Math.max(b, 0)) + Math.min(Math.max(a, b), 0);
}

/** Driver internals the tests drive directly. */
type Internals = { startReverse(steer: number, kind: 'queue' | 'stuck' | 'lane' | 'yield', time?: number): void; reverseTimer: number };
const internals = (v: Vehicle) => v.ai as unknown as Internals;

/** A wall 0.4 m thick standing across `lane` (and 2.5 m to each side of it) from `s` back to `s - 0.4`. */
function wallAcross(sim: Sim, lane: Lane, s: number): { x: number; z: number } {
  const ax = lane.sx + lane.dx * s;
  const az = lane.sz + lane.dz * s;
  const bx = lane.sx + lane.dx * (s - 0.4);
  const bz = lane.sz + lane.dz * (s - 0.4);
  const wx = Math.abs(lane.dz) * 2.5;
  const wz = Math.abs(lane.dx) * 2.5;
  sim.world.grid.addBox(Math.min(ax, bx) - wx, Math.min(az, bz) - wz, Math.max(ax, bx) + wx, Math.max(az, bz) + wz, 0, 2.5, 'wall');
  return { x: ax, z: az };
}

/** Where everything is, to compare two runs. */
function snapshot(sim: Sim): unknown {
  return {
    time: sim.time,
    vehicles: sim.vehicles.map((v) => [v.id, v.kind, v.pos.x, v.pos.y, v.pos.z, v.heading, v.vel.x, v.vel.z, v.pitch, v.roll, v.health]),
    characters: sim.characters.map((c) => [c.id, c.role, c.state, c.pos.x, c.pos.y, c.pos.z, c.health]),
    helis: sim.helis.map((h) => [h.id, h.pos.x, h.pos.y, h.pos.z, h.orbit]),
    pickups: sim.pickups.map((p) => [p.id, p.bob]),
  };
}

describe('a reproducible simulation', () => {
  it('two runs from the same seed with the same inputs end identical: 3 stars, a helicopter, an exploding car', () => {
    const run = () => {
      const sim = makeSim({ ambient: true, seed: 5 });
      sim.cheats.godMode = true;
      sim.missions.noBust = true;
      sim.wanted.setLevel(3);
      let blew = false;
      let heli = false;
      step(sim, 60, (t) => {
        heli ||= sim.helis.length > 0;
        if (!blew && t >= 20) {
          // Blow up the car nearest the player: the blast tumbles it and kicks the cars around it.
          const p = sim.playerPos();
          const cars = sim.vehicles.filter((v) => !v.removed && !v.destroyed && v.driver !== sim.player);
          cars.sort((a, b) => Math.hypot(a.pos.x - p.x, a.pos.z - p.z) - Math.hypot(b.pos.x - p.x, b.pos.z - p.z));
          if (cars[0]) {
            sim.combat.explodeVehicle(cars[0]);
            blew = true;
          }
        }
        return input();
      });
      return { sim, blew, heli };
    };
    const a = run();
    const b = run();
    // The run covers what used to draw on Math.random: the helicopter's orbit and the blast's tumble.
    expect(a.heli).toBe(true);
    expect(a.blew).toBe(true);
    expect(snapshot(b.sim)).toEqual(snapshot(a.sim));
  });
});

describe('reversing in tight spots', () => {
  it('makes room for a car backing towards it, but stops short of a wall 1 m behind', () => {
    const sim = makeSim({ police: false });
    const lane = streetLane(sim);
    signalsOff(sim);
    const car = drive(sim, 'sedan', lane, 30);
    // The wall's face is 1 m behind the rear bumper; a sedan backs up towards the car from 2.5 m ahead.
    wallAcross(sim, lane, 30 - car.halfL - 1);
    const ahead = drive(sim, 'sedan', lane, 30 + 2 * car.halfL + 2.5);
    internals(ahead).startReverse(0, 'queue', 2);
    let impacts = 0;
    sim.events.on('impact', (e) => {
      if (e.vehicle === car || e.vehicle === ahead) impacts++;
    });
    let room = Infinity;
    let reversed = false;
    step(sim, 4, () => {
      room = Math.min(room, along(lane, car.pos) - car.halfL - (30 - car.halfL - 1));
      reversed ||= internals(car).reverseTimer > 0;
      return input();
    });
    // It was asked to make room, and kept off the wall.
    expect(reversed).toBe(true);
    expect(impacts).toBe(0);
    expect(room).toBeGreaterThan(0.2);
  });

  it('stops a reverse of any kind short of a wall or a lamp post behind it', () => {
    for (const kind of ['queue', 'yield', 'stuck'] as const) {
      for (const what of ['wall', 'lamp'] as const) {
        const sim = makeSim({ police: false });
        const lane = streetLane(sim);
        signalsOff(sim);
        // An abandoned van right in front keeps it from driving off.
        abandon(sim, 'van', lane, 30 + 2.35 + 0.8 + 2.55);
        const car = drive(sim, 'sedan', lane, 30);
        const back = 30 - car.halfL - 1;
        if (what === 'wall') wallAcross(sim, lane, back);
        else sim.world.grid.addCircle(lane.sx + lane.dx * (back - 0.17), lane.sz + lane.dz * (back - 0.17), 0.17, 0, 6.5, 'lamp', -1, true);
        let impacts = 0;
        let broken = 0;
        sim.events.on('impact', (e) => {
          if (e.vehicle === car) impacts++;
        });
        sim.events.on('propBroken', () => broken++);
        internals(car).startReverse(0, kind, 3);
        let room = Infinity;
        step(sim, 3, () => {
          room = Math.min(room, along(lane, car.pos) - car.halfL - back);
          return input();
        });
        const what2 = `${kind} reverse, ${what}`;
        expect(impacts, what2).toBe(0);
        expect(broken, what2).toBe(0);
        expect(room, what2).toBeGreaterThan(0.2);
      }
    }
  });
});

/** Counts impacts involving any of `cars` (contact strong enough to report: over 2 m/s). */
function contacts(sim: Sim, cars: () => Vehicle[]): { n: number } {
  const count = { n: 0 };
  sim.events.on('impact', (e) => {
    if (e.vehicle && cars().includes(e.vehicle)) count.n++;
  });
  return count;
}

/**
 * A sedan abandoned in `lane` 40 m in, and another left in the oncoming lane facing its own way, its
 * front bumper `gap` m past the first one's: what is left of the street between them is a chicane.
 */
function chicane(sim: Sim, lane: Lane, gap: number): [Vehicle, Vehicle] {
  const opp = oppositeLane(sim, lane);
  const first = abandon(sim, 'sedan', lane, 40);
  const second = abandon(sim, 'sedan', opp, opp.length - (40 + first.halfL + gap + first.halfL));
  return [first, second];
}

/** True once `v` is past `o` along `lane` (its rear beyond o's far end) and back in that lane. */
function pastIn(lane: Lane, v: Vehicle, o: Vehicle): boolean {
  return along(lane, v.pos) - v.halfL > along(lane, o.pos) + o.halfL && Math.abs(across(lane, v.pos)) < 1.5;
}

describe('backing out of a face-off', () => {
  it('a retreat spares a person or a lamp post right behind the tail of a car turned out of its lane', () => {
    for (const what of ['person', 'lamp'] as const) {
      const sim = makeSim({ police: false });
      const lane = streetLane(sim);
      signalsOff(sim);
      // Out in the oncoming lane beside a car abandoned in its own, turned 0.5 rad further out.
      const car = drive(sim, 'sedan', lane, 40);
      car.pos.x += lane.dz * 2.5;
      car.pos.z -= lane.dx * 2.5;
      car.heading += 0.5;
      const parked = abandon(sim, 'sedan', lane, 40);
      // 2.8 m back along the lane and 1.8 m to the right: just behind the tail.
      const x = car.pos.x - lane.dx * 2.8 - lane.dz * 1.8;
      const z = car.pos.z - lane.dz * 2.8 + lane.dx * 1.8;
      const ped = what === 'person' ? sim.spawnCharacter('civilian', x, z) : null;
      if (!ped) sim.world.grid.addCircle(x, z, 0.17, 0, 6.5, 'lamp', -1, true);
      const ai = car.ai as unknown as { planRetreat(): boolean; startReverse(steer: number, kind: string, time?: number): void };
      expect(ai.planRetreat()).toBe(true);
      ai.startReverse(0, 'retreat', 8);
      const hits = contacts(sim, () => [car, parked]);
      let room = Infinity;
      step(sim, 3, () => {
        room = Math.min(room, bodyDistance(car, x, z) - (ped ? ped.radius : 0.17));
        // Keep the person standing where they are.
        if (ped) {
          ped.pos.x = x;
          ped.pos.z = z;
        }
        return input();
      });
      expect(room, what).toBeGreaterThan(0.2);
      expect(hits.n, what).toBe(0);
    }
  });
});

describe('overtaking past cars left in the street', () => {
  it('squeezes between a car abandoned in its lane and one left in the oncoming lane 8-12 m further on', () => {
    for (const [kind, gaps] of [
      ['sedan', [8, 10, 12]],
      ['van', [9, 10, 12]],
      ['compact', [8, 10, 12]],
    ] as const) {
      for (const gap of gaps) {
        const sim = makeSim({ police: false });
        const lane = streetLane(sim);
        signalsOff(sim);
        const [first, second] = chicane(sim, lane, gap);
        const car = drive(sim, kind, lane, 10, 8);
        const hits = contacts(sim, () => [car, first, second]);
        let past = -1;
        step(sim, 30, (t) => {
          if (past < 0 && pastIn(lane, car, second)) past = t;
          return input();
        });
        const what = `${kind}, ${gap} m`;
        // It swings out only as far as it takes to clear the first car, which leaves room to pull back in before the second.
        expect(past, what).toBeGreaterThan(0);
        expect(hits.n, what).toBe(0);
      }
    }
  });

  it('passes two cars abandoned 8, 10 and 12 m apart in its own lane in one go', () => {
    for (const kind of ['sedan', 'van'] as const) {
      for (const gap of [8, 10, 12]) {
        const sim = makeSim({ police: false });
        const lane = streetLane(sim);
        signalsOff(sim);
        const first = abandon(sim, 'sedan', lane, 35);
        const second = abandon(sim, 'sedan', lane, 35 + 2 * first.halfL + gap);
        const car = drive(sim, kind, lane, 8, 8);
        const hits = contacts(sim, () => [car, first, second]);
        let past = -1;
        step(sim, 30, (t) => {
          if (past < 0 && pastIn(lane, car, second)) past = t;
          return input();
        });
        expect(past, `${kind}, ${gap} m`).toBeGreaterThan(0);
        expect(hits.n, `${kind}, ${gap} m`).toBe(0);
      }
    }
  });
});

describe('face-offs with oncoming traffic', () => {
  it('two cars overtaking towards each other through that chicane take turns: both are through within 40 s', () => {
    for (const [kind, gap, delay] of [
      ['sedan', 8, 0],
      ['sedan', 10, 1],
      ['sedan', 12, 0],
      ['sedan', 12, 2],
      ['van', 9, 0],
      ['van', 12, 1],
    ] as const) {
      const sim = makeSim({ police: false });
      const lane = streetLane(sim);
      signalsOff(sim);
      const opp = oppositeLane(sim, lane);
      const [first, second] = chicane(sim, lane, gap);
      const car = drive(sim, kind, lane, 10, 8);
      let other: Vehicle | null = null;
      const hits = contacts(sim, () => [car, first, second, ...(other ? [other] : [])]);
      let carPast = -1;
      let otherPast = -1;
      step(sim, 40, (t) => {
        // The other one sets off towards the second car `delay` s later, as far from it as the first is from the first.
        if (!other && t >= delay) other = drive(sim, kind, opp, along(opp, second.pos) - 30, 8);
        if (carPast < 0 && pastIn(lane, car, second)) carPast = t;
        if (other && otherPast < 0 && pastIn(opp, other, first)) otherPast = t;
        return input();
      });
      const what = `${kind}, ${gap} m, ${delay} s`;
      expect(carPast, what).toBeGreaterThan(0);
      expect(otherPast, what).toBeGreaterThan(0);
      expect(hits.n, what).toBe(0);
    }
  });

  it('an overtaker that meets a car with another right behind it backs out round the cars it passed, or pulls in past them', () => {
    // A car left in its lane (and in the first case a second one 7 m behind that): it overtakes, and
    // a car comes the other way with a second one on its bumper, so that one cannot back up.
    for (const [kind, two, delay] of [
      ['sedan', true, 1.5],
      ['sedan', true, 2.5],
      ['van', true, 2],
      ['sedan', false, 2.5],
    ] as const) {
      const sim = makeSim({ police: false });
      const lane = streetLane(sim);
      signalsOff(sim);
      const opp = oppositeLane(sim, lane);
      const parked = abandon(sim, 'sedan', lane, 45);
      const car = drive(sim, 'sedan', lane, 8, 8);
      if (two) abandon(sim, 'sedan', lane, 33);
      let oncoming: Vehicle | null = null;
      let follower: Vehicle | null = null;
      const hits = contacts(sim, () => [car, parked, ...(oncoming ? [oncoming] : []), ...(follower ? [follower] : [])]);
      let start = -1;
      let carPast = -1;
      let oncomingPast = -1;
      let followerPast = -1;
      const begin = along(lane, parked.pos) - parked.halfL;
      step(sim, 70, (t) => {
        if (start < 0 && t > 1 && car.forwardSpeed < -0.2) start = t;
        if (start >= 0 && !oncoming && t >= start + delay) {
          oncoming = drive(sim, kind, opp, 2, 12);
          follower = drive(sim, 'sedan', opp, 2 - oncoming.halfL - 1.5 - 2.35, 12);
        }
        if (carPast < 0 && pastIn(lane, car, parked)) carPast = t;
        if (oncoming && oncomingPast < 0 && along(lane, oncoming.pos) + oncoming.halfL < begin - 1) oncomingPast = t;
        if (follower && followerPast < 0 && along(lane, follower.pos) + follower.halfL < begin - 1) followerPast = t;
        return input();
      });
      const what = `${kind}, ${two ? 'two cars' : 'one car'} left, ${delay} s`;
      expect(start, what).toBeGreaterThan(0);
      for (const at of [carPast, oncomingPast, followerPast]) {
        expect(at, what).toBeGreaterThan(0);
        expect(at - start, what).toBeLessThan(45);
      }
      expect(hits.n, what).toBe(0);
    }
  });
});
