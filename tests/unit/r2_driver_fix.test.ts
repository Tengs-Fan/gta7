// Round 2 fix pass, cluster "driver": a reproducible simulation (no Math.random in the sim), and the
// driving AI's overtaking and reversing in tight spots. Second fix pass: face-offs that always resolve,
// pulling in past a car in the way, squeezing on from out in the passing lane, wide vehicles through
// tight chicanes, and the wall check for every kind of reverse.

import { describe, expect, it } from 'vitest';
import type { DriverPolicy } from '../../src/sim/driver';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import type { Lane } from '../../src/world/roads';
import { input, makeSim, step, teleport } from './helpers';

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
type Internals = {
  startReverse(steer: number, kind: 'queue' | 'stuck' | 'lane' | 'pullIn' | 'yield', time?: number): void;
  reverseTimer: number;
  yielded: Vehicle | null;
  merging: boolean;
  blocker: unknown;
};
const internals = (v: Vehicle) => v.ai as unknown as Internals;

/** Half the length of each kind of vehicle. */
const VEHICLE_HALF_L = Object.fromEntries(Object.entries(VEHICLE_SPECS).map(([k, sp]) => [k, sp.length / 2])) as Record<VehicleKind, number>;

/** Moves `v` `d` m to the left of its place across `lane` (into the passing lane). */
function shiftLeft(v: Vehicle, lane: Lane, d: number): Vehicle {
  v.pos.x += lane.dz * d;
  v.pos.z -= lane.dx * d;
  return v;
}

/**
 * A wall 0.4 m thick standing across `lane` from `s` back to `s - 0.4`, `half` m to each side of the
 * line `left` m to the left of the lane's centre line.
 */
function wallAcross(sim: Sim, lane: Lane, s: number, left = 0, half = 2.5): { x: number; z: number } {
  const ox = lane.dz * left;
  const oz = -lane.dx * left;
  const ax = lane.sx + lane.dx * s + ox;
  const az = lane.sz + lane.dz * s + oz;
  const bx = lane.sx + lane.dx * (s - 0.4) + ox;
  const bz = lane.sz + lane.dz * (s - 0.4) + oz;
  const wx = Math.abs(lane.dz) * half;
  const wz = Math.abs(lane.dx) * half;
  sim.world.grid.addBox(Math.min(ax, bx) - wx, Math.min(az, bz) - wz, Math.max(ax, bx) + wx, Math.max(az, bz) + wz, 0, 2.5, 'wall');
  return { x: ax, z: az };
}

/** The corners of the body of `v`. */
function corners(v: Vehicle): { x: number; z: number }[] {
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  const out: { x: number; z: number }[] = [];
  for (const a of [1, -1]) for (const b of [1, -1]) out.push({ x: v.pos.x + fx * v.halfL * a - fz * v.halfW * b, z: v.pos.z + fz * v.halfL * a + fx * v.halfW * b });
  return out;
}

/** Separation between two vehicle bodies (negative when a corner of one is inside the other). */
function bodyGap(a: Vehicle, b: Vehicle): number {
  let m = Infinity;
  for (const c of corners(a)) m = Math.min(m, bodyDistance(b, c.x, c.z));
  for (const c of corners(b)) m = Math.min(m, bodyDistance(a, c.x, c.z));
  return m;
}

/** The smallest separation between any two of `cars` (Infinity with fewer than two). */
function closest(cars: (Vehicle | null)[]): number {
  let m = Infinity;
  const live = cars.filter((c): c is Vehicle => !!c && !c.removed);
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) m = Math.min(m, bodyGap(live[i]!, live[j]!));
  return m;
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
    // Each kind as the driver starts it: making room ('queue'), the stuck rule ('stuck'), giving way to
    // a car standing out of its lane ('yield'), backing into the lane from the passing lane ('lane')
    // and turning the nose in from there to pull in ('pullIn').
    for (const kind of ['queue', 'stuck', 'yield', 'lane', 'pullIn'] as const) {
      for (const what of ['wall', 'lamp'] as const) {
        const sim = makeSim({ police: false });
        const lane = streetLane(sim);
        signalsOff(sim);
        // Out in the passing lane, 2.5 m to the left, for the reverses that start from there.
        const out = kind === 'lane' || kind === 'pullIn' ? 2.5 : 0;
        // An abandoned van right in front keeps it from driving off.
        shiftLeft(abandon(sim, 'van', lane, 30 + 2.35 + 0.8 + 2.55), lane, out);
        const car = shiftLeft(drive(sim, 'sedan', lane, 30), lane, out);
        if (kind === 'yield') {
          // Giving way to a car that stands out of its lane in ours, nose to nose with the van: the
          // reverse lasts until it is back in its lane.
          const opp = oppositeLane(sim, lane);
          const rival = shiftLeft(drive(sim, 'sedan', opp, opp.length - (30 + 2.35 + 0.8 + 5.1 + 1 + 2.35)), opp, 3);
          rival.ai!.hold = true;
          internals(car).yielded = rival;
        }
        // 2 m behind the rear bumper: the reverse gets going, and has to stop short of it.
        const back = 30 - car.halfL - 2;
        const lamp = { x: car.pos.x - lane.dx * (car.halfL + 2.17), z: car.pos.z - lane.dz * (car.halfL + 2.17) };
        if (what === 'wall') wallAcross(sim, lane, back, out, 3.5);
        else sim.world.grid.addCircle(lamp.x, lamp.z, 0.17, 0, 6.5, 'lamp', -1, true);
        let impacts = 0;
        let broken = 0;
        sim.events.on('impact', (e) => {
          if (e.vehicle === car) impacts++;
        });
        sim.events.on('propBroken', () => broken++);
        internals(car).startReverse(kind === 'pullIn' ? -1 : 0, kind, 3);
        let room = Infinity;
        let moved = 0;
        const x0 = car.pos.x;
        const z0 = car.pos.z;
        step(sim, 3, () => {
          // The body's distance to the face of the wall, or to the lamp post.
          if (what === 'wall') for (const c of corners(car)) room = Math.min(room, along(lane, c) - back);
          else room = Math.min(room, bodyDistance(car, lamp.x, lamp.z) - 0.17);
          moved = Math.max(moved, Math.hypot(car.pos.x - x0, car.pos.z - z0));
          return input();
        });
        const what2 = `${kind} reverse, ${what}`;
        // It does back up (the case tests the check, not a reverse that ends at once)...
        expect(moved, what2).toBeGreaterThan(0.3);
        // ...and keeps off what is behind it.
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

/**
 * A face-off past a car `blk` left in a one-lane street 45 m in (and a sedan left `second` m behind it,
 * bumper gap, unless negative): an overtaker `x` sets off from 8 m at 8 m/s and, `delay` s after it
 * first backs up to pull out, a car `y` comes the other way from the far end at 12 m/s (with a sedan
 * `follower` m behind it, unless negative). How long after that first reverse all of them are past
 * the cars left there (-1 if one of them is not within 90 s), how many impacts there were, and the
 * closest any two bodies came.
 */
function faceOff(blk: VehicleKind, second: number, x: VehicleKind, y: VehicleKind, delay: number, follower: number): { took: number; impacts: number; clear: number } {
  const sim = makeSim({ police: false });
  const lane = streetLane(sim);
  signalsOff(sim);
  const opp = oppositeLane(sim, lane);
  const parked = abandon(sim, blk, lane, 45);
  const parked2 = second >= 0 ? abandon(sim, 'sedan', lane, 45 - parked.halfL - second - 2.35) : null;
  const car = drive(sim, x, lane, 8, 8);
  let oncoming: Vehicle | null = null;
  let behind: Vehicle | null = null;
  const all = () => [car, oncoming, behind, parked, parked2];
  const hits = contacts(sim, () => all().filter((v): v is Vehicle => !!v));
  const end = along(lane, parked.pos) + parked.halfL;
  const begin = along(lane, (parked2 ?? parked).pos) - (parked2 ?? parked).halfL;
  let start = -1;
  let carPast = -1;
  let oncomingPast = -1;
  let behindPast = -1;
  let clear = Infinity;
  for (let f = 0; f < 60 * 90; f++) {
    const t = f / 60;
    if (start < 0 && t > 1 && car.forwardSpeed < -0.2) start = t;
    if (start >= 0 && !oncoming && t >= start + delay) {
      oncoming = drive(sim, y, opp, 2, 12);
      if (follower >= 0) behind = drive(sim, 'sedan', opp, 2 - oncoming.halfL - follower - 2.35, 12);
    }
    sim.update(1 / 60, input());
    clear = Math.min(clear, closest(all()));
    if (carPast < 0 && along(lane, car.pos) - car.halfL > end && Math.abs(across(lane, car.pos)) < 1.5) carPast = t;
    if (oncoming && oncomingPast < 0 && along(lane, oncoming.pos) + oncoming.halfL < begin - 1) oncomingPast = t;
    if (behind && behindPast < 0 && along(lane, behind.pos) + behind.halfL < begin - 1) behindPast = t;
    if (carPast >= 0 && oncomingPast >= 0 && (!behind || behindPast >= 0)) break;
  }
  const all3 = carPast >= 0 && oncomingPast >= 0 && (!behind || behindPast >= 0);
  return { took: all3 && start >= 0 ? Math.max(carPast, oncomingPast, behindPast) - start : -1, impacts: hits.n, clear };
}

describe('face-offs that always resolve (second fix pass)', () => {
  it('an overtaker level with a bus meets a lone car coming the other way: that one backs up, and both are through within 25 s', () => {
    // The overtaker cannot back into its lane with the bus beside it, so it waits for the other car
    // to back up; that one used to wait for it as well, until the queue reverses shuffled them apart.
    const r = faceOff('bus', -1, 'sedan', 'sedan', 2.5, -1);
    expect(r.took).toBeGreaterThan(0);
    expect(r.took).toBeLessThan(25);
    expect(r.impacts).toBe(0);
    expect(r.clear).toBeGreaterThan(0.05);
  });

  it('resolves every face-off of a sweep of layouts within 40 s, without contact', () => {
    // Blocker kinds, a second car left behind the first or not, overtaker kinds, arrival delays, and
    // the car coming the other way with or without another right behind it. Each pairing has one of
    // the two give way (see facePlan), and when neither has room by the rules, one backs up all the
    // same, waiting for the car behind it to make room.
    const slow: string[] = [];
    for (const blk of ['sedan', 'pickup', 'bus'] as const)
      for (const second of [-1, 2, 5])
        for (const x of ['sedan', 'van'] as const)
          for (const y of ['sedan', 'van'] as const)
            for (const delay of [2, 3, 4])
              for (const follower of [-1, 1.5]) {
                const r = faceOff(blk, second, x, y, delay, follower);
                if (r.took < 0 || r.took >= 40 || r.impacts > 0 || r.clear < 0.05) {
                  slow.push(`${blk}${second >= 0 ? ` (a sedan ${second} m behind)` : ''}, ${x} meets ${y}${follower >= 0 ? ' and its follower' : ''} ${delay} s on: ${r.took.toFixed(1)} s, ${r.impacts} impacts, ${r.clear.toFixed(2)} m apart`);
                }
              }
    expect(slow).toEqual([]);
  });
});

/**
 * Two sedans left in `lane`, at 30 m and `gap` m (bumper gap) further on, and a third left in the
 * oncoming lane with its near end `far` m past the second's front.
 */
function queueAndBeyond(sim: Sim, lane: Lane, gap: number, far: number): [Vehicle, Vehicle, Vehicle] {
  const first = abandon(sim, 'sedan', lane, 30);
  const second = abandon(sim, 'sedan', lane, 30 + 2 * first.halfL + gap);
  const opp = oppositeLane(sim, lane);
  const third = abandon(sim, 'sedan', opp, opp.length - (along(lane, second.pos) + second.halfL + far + first.halfL));
  return [first, second, third];
}

/** Drives `car` on until it is past `last` and back in `lane` (or `limit` s): when, and how often it stood still against `stop` for over 1 s. */
function passAll(sim: Sim, lane: Lane, car: Vehicle, last: Vehicle, stop: Vehicle, others: Vehicle[], limit: number): { past: number; stops: number; impacts: number; clear: number } {
  const hits = contacts(sim, () => [car, ...others]);
  let past = -1;
  let still = 0;
  let stops = 0;
  let clear = Infinity;
  for (let f = 0; f < 60 * limit && past < 0; f++) {
    sim.update(1 / 60, input());
    clear = Math.min(clear, closest([car, ...others]));
    if (car.speed < 0.3 && internals(car).blocker === stop) {
      still += 1 / 60;
      if (still >= 1 && still < 1 + 1 / 60) stops++;
    } else still = 0;
    if (pastIn(lane, car, last)) past = f / 60;
  }
  return { past, stops, impacts: hits.n, clear };
}

describe('pulling in past a car in the way (second fix pass)', () => {
  it('pulls in between the cars it passed and one standing in the passing lane 12 m beyond, never stopping twice against that one', () => {
    // Swinging out the full 4.2 m past two cars 4-10 m apart, it used to end up nose-in short of the third
    // car, back straight up and drive the same line into it again, 6 or 7 times over 50 s. Squeezing past
    // the queue as a whole, it pulls in before the third car.
    for (const kind of ['sedan', 'compact', 'van', 'pickup'] as const) {
      for (const gap of [4, 6, 8, 10]) {
        const sim = makeSim({ police: false });
        const lane = streetLane(sim);
        signalsOff(sim);
        const [first, second, third] = queueAndBeyond(sim, lane, gap, 12);
        const car = drive(sim, kind, lane, 6, 8);
        const r = passAll(sim, lane, car, second, third, [first, second, third], 45);
        const what = `${kind}, ${gap} m`;
        expect(r.past, what).toBeGreaterThan(0);
        expect(r.past, what).toBeLessThan(30);
        expect(r.stops, what).toBeLessThanOrEqual(1);
        expect(r.impacts, what).toBe(0);
        expect(r.clear, what).toBeGreaterThan(0.05);
      }
    }
  });

  it('with its nose turned in already, short of a car standing in the passing lane, backs up turning it in further and then pulls in', () => {
    // The pose the first fix pass got stuck in: past what it overtook, 2.7 m out with the nose 0.47 rad
    // in and the front level with the near end of the car in the passing lane. Backing straight up, it
    // drove the same line into the same car again every few seconds.
    for (const kind of ['sedan', 'compact', 'van'] as const) {
      const sim = makeSim({ police: false });
      const lane = streetLane(sim);
      signalsOff(sim);
      const [first, second, third] = queueAndBeyond(sim, lane, 8, 12);
      const s0 = along(lane, third.pos) - third.halfL - VEHICLE_HALF_L[kind];
      const car = shiftLeft(drive(sim, kind, lane, s0), lane, 2.7);
      car.heading = lane.heading - 0.47;
      internals(car).merging = true;
      const r = passAll(sim, lane, car, third, third, [first, second, third], 30);
      expect(r.past, kind).toBeGreaterThan(0);
      expect(r.past, kind).toBeLessThan(15);
      expect(r.stops, kind).toBeLessThanOrEqual(1);
      expect(r.impacts, kind).toBe(0);
    }
  });

  it('squeezes on past the second of two cars 13-15 m apart from out in the passing lane, with a car standing 16 m beyond it', () => {
    // Past the first car, it cannot pull in before the second and takes up the overtake again from out
    // in the passing lane; squeezing, it used to turn back in towards the second car and stall against
    // it, 9 s at a time, for 40-54 s.
    for (const kind of ['sedan', 'van', 'pickup'] as const) {
      for (const gap of [13, 14, 15]) {
        const sim = makeSim({ police: false });
        const lane = streetLane(sim);
        signalsOff(sim);
        const [first, second, third] = queueAndBeyond(sim, lane, gap, 16);
        const car = drive(sim, kind, lane, 6, 8);
        const r = passAll(sim, lane, car, second, second, [first, second, third], 45);
        const what = `${kind}, ${gap} m`;
        expect(r.past, what).toBeGreaterThan(0);
        expect(r.past, what).toBeLessThan(30);
        expect(r.stops, what).toBeLessThanOrEqual(1);
        expect(r.impacts, what).toBe(0);
        expect(r.clear, what).toBeGreaterThan(0.05);
      }
    }
  });
});

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
  it('squeezes between a car abandoned in its lane and one left in the oncoming lane 7-12 m further on, 8.5 m for a pickup', () => {
    // (Second fix pass: 0.3 m from what it passes instead of 0.5 m, which takes pickups through 8.5 m and
    // vans through 8 m; they used to wait behind the first car for good.)
    for (const [kind, gaps] of [
      ['sedan', [7.5, 8, 10, 12]],
      ['compact', [7, 8, 10, 12]],
      ['van', [8, 9, 10, 12]],
      ['pickup', [8.5, 9, 10, 12]],
    ] as const) {
      for (const gap of gaps) {
        const sim = makeSim({ police: false });
        const lane = streetLane(sim);
        signalsOff(sim);
        const [first, second] = chicane(sim, lane, gap);
        const car = drive(sim, kind, lane, 10, 8);
        const hits = contacts(sim, () => [car, first, second]);
        let past = -1;
        let clear = Infinity;
        step(sim, 30, (t) => {
          clear = Math.min(clear, closest([car, first, second]));
          if (past < 0 && pastIn(lane, car, second)) past = t;
          return input();
        });
        const what = `${kind}, ${gap} m`;
        // It swings out only as far as it takes to clear the first car, which leaves room to pull back in before the second.
        expect(past, what).toBeGreaterThan(0);
        expect(hits.n, what).toBe(0);
        expect(clear, what).toBeGreaterThan(0.2);
      }
    }
  });

  it('keeps pickups in traffic from waiting for good behind two cars left 8.5 m apart, one in each lane', () => {
    // The ambient soak of the review: one car left in the lane, one in the oncoming lane 8.5 m beyond it
    // (bumper gap), the player beside the first. Pickups used to wait behind the first car, 60-110 s in
    // these seeds, with the cars behind them.
    for (const seed of [4, 6]) {
      const sim = makeSim({ police: false, ambient: true, seed });
      const lane = streetLane(sim);
      const opp = oppositeLane(sim, lane);
      const a = abandon(sim, 'sedan', lane, lane.length * 0.45);
      const b = abandon(sim, 'sedan', opp, opp.length * 0.25 + 12);
      expect(along(lane, b.pos) - b.halfL - (along(lane, a.pos) + a.halfL), `seed ${seed}`).toBeCloseTo(8.5, 0);
      teleport(sim, a.pos.x - lane.dz * 5, a.pos.z + lane.dx * 5);
      let worst = 0;
      let who = '';
      step(sim, 120, () => {
        for (const v of sim.vehicles) {
          if (v.removed || !v.ai || !v.driver) continue;
          if (Math.min(Math.hypot(v.pos.x - a.pos.x, v.pos.z - a.pos.z), Math.hypot(v.pos.x - b.pos.x, v.pos.z - b.pos.z)) > 30) continue;
          if (v.stuckTime > worst) {
            worst = v.stuckTime;
            who = `${v.kind} #${v.id}`;
          }
        }
        return input();
      });
      expect(worst, `seed ${seed}: ${who}`).toBeLessThan(40);
    }
  }, 300_000);

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
