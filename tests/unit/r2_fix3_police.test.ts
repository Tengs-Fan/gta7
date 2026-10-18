// Round 2 fix pass 3, police cluster: sirens off with the stars, wrecks that stay on their roof, and the
// police, traffic and driver follow-ups (each test fails on the code before its fix).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Helicopter, type Character, type Vehicle } from '../../src/sim/entities';
import { bodyGapAt } from '../../src/sim/driver';
import { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import { stepVehicle } from '../../src/sim/vehiclePhysics';
import { axisOf, SIGNAL_CYCLE, type Lane } from '../../src/world/roads';
import { at, dist, internals, longestLane, officer, placeOnFoot } from './r2_police_helpers';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

/** A unit chasing the player at one star, its crew of two put out on foot near it. */
function deployedUnit(sim: Sim): { unit: Vehicle; lane: ReturnType<typeof longestLane> } {
  const lane = longestLane(sim);
  sim.wanted.setLevel(1);
  let unit: Vehicle | null = null;
  for (let i = 0; i < 10 && !unit; i++) unit = sim.police.spawnUnit('police', true);
  expect(unit).not.toBeNull();
  const v = unit!;
  const p = at(lane, 40);
  v.pos.x = p.x;
  v.pos.z = p.z;
  v.pos.y = sim.world.groundHeight(p.x, p.z);
  v.heading = lane.heading;
  v.vel.x = 0;
  v.vel.z = 0;
  v.ai?.setLane(lane, 40);
  expect(v.occupants().length).toBe(2);
  internals(sim).deploy(v);
  return { unit: v, lane };
}

describe('sirens go off with the stars', () => {
  it('a unit whose crew walks back after the stars cleared drives off as a patrol without its siren and light bar', () => {
    const sim = makeSim();
    const { unit, lane } = deployedUnit(sim);
    const crew = sim.characters.filter((c) => c.brain?.car === unit);
    expect(crew.length).toBe(2);
    placeOnFoot(sim, crew[0]!, at(lane, 33).x, at(lane, 33).z);
    placeOnFoot(sim, crew[1]!, at(lane, 50).x, at(lane, 50).z);
    // The player watches from the sidewalk, out of the car's way.
    const side = sim.world.findFreeSpot(at(lane, 60).x - lane.dz * 8, at(lane, 60).z + lane.dx * 8, 0.5, 6)!;
    teleport(sim, side.x, side.z);
    step(sim, 0.5);
    // While the stars are up, a deployed unit keeps its siren running.
    expect(unit.driver).toBeNull();
    expect(unit.siren).toBe(true);
    sim.wanted.clear();
    let sirenFrames = 0;
    let boarded = false;
    step(sim, 30, (t) => {
      // (Called before each frame's update: from the second frame on, it sees the frames since the stars went.)
      if (t > 0 && unit.siren) sirenFrames++;
      if (crew.every((c) => c.vehicle === unit)) boarded = true;
      return input();
    });
    expect(boarded).toBe(true);
    expect(unit.ai?.policy).toBe('traffic');
    expect(sirenFrames).toBe(0);
    // It drove off (a patrol, not a parked car flashing in the street).
    expect(dist(unit.pos, at(lane, 40))).toBeGreaterThan(10);
    expect(unit.siren).toBe(false);
  });

  it('a cruiser left behind by a crew too far away to walk back has its siren and light bar off', () => {
    const sim = makeSim();
    const { unit, lane } = deployedUnit(sim);
    const crew = sim.characters.filter((c) => c.brain?.car === unit);
    // The crew chased the player 60 m down the street, beyond the 45 m from which they walk back.
    const far = at(lane, 100);
    teleport(sim, far.x - lane.dz * 7, far.z + lane.dx * 7);
    for (const [i, c] of crew.entries()) placeOnFoot(sim, c, far.x + lane.dx * i, far.z + lane.dz * i);
    expect(Math.min(...crew.map((c) => dist(c.pos, unit.pos)))).toBeGreaterThan(50);
    step(sim, 0.5);
    expect(unit.siren).toBe(true);
    sim.wanted.clear();
    step(sim, 3);
    expect(crew.every((c) => c.brain?.car === null)).toBe(true);
    expect(unit.removed).toBe(false);
    expect(unit.driver).toBeNull();
    expect(unit.siren).toBe(false);
  });

  it('the player still works the siren of a cruiser he took, with or without stars', () => {
    const sim = makeSim();
    sim.cheats.neverWanted = true;
    const lane = longestLane(sim);
    const v = sim.spawnVehicle('police', at(lane, 30).x, at(lane, 30).z, lane.heading);
    v.owner = 'police';
    teleport(sim, v.pos.x - Math.cos(v.heading) * 2.2, v.pos.z + Math.sin(v.heading) * 2.2);
    // Get in the usual way: the car is his now (owner 'none').
    step(sim, 3, (t) => input({ enterExit: t < 0.01 }));
    expect(sim.player.vehicle).toBe(v);
    expect(v.owner).toBe('none');
    step(sim, 0.2, (t) => input({ hornPressed: t < 0.01 }));
    expect(v.siren).toBe(true);
    step(sim, 2);
    expect(v.siren).toBe(true);
  });
});

/** A flat beach spot for dropping cars on. */
function beach(sim: Sim, k = 0): { x: number; z: number } {
  const b = sim.world.layout.bounds;
  return { x: b.beachStartX + 30, z: b.landMinZ + 100 + k * 14 };
}

/** Drops a car 0.6 m onto flat sand at the given attitude (a wreck if `wreck`), and lets it settle for `secs`. */
function drop(sim: Sim, k: number, roll: number, pitch: number, wreck: boolean, secs = 1.5): Vehicle {
  const p = beach(sim, k);
  const v = sim.spawnVehicle('sedan', p.x, p.z, 0.3);
  if (wreck) {
    v.destroyed = true;
    v.health = -v.spec.health;
  }
  v.airborne = true;
  v.pos.y = sim.world.groundHeight(p.x, p.z) + 0.6;
  v.vy = -2;
  v.roll = roll;
  v.pitch = pitch;
  // Tumbling (a blast's kick), so the flight does not level the nose out.
  v.pitchVel = 1e-6;
  step(sim, secs);
  return v;
}

/** The body's orientation as the view draws it (rotation order YXZ, x = -pitch). */
function attitude(v: Vehicle): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(-v.pitch, v.heading, v.roll, 'YXZ'));
}

describe('wrecks keep the pose they land in', () => {
  it('a wreck thrown onto its roof stays on its roof', () => {
    const sim = makeSim({ police: false });
    const v = drop(sim, 0, Math.PI, 0, true);
    expect(v.airborne).toBe(false);
    expect(Math.abs(v.roll)).toBeGreaterThan(3);
    expect(v.flipped).toBe(true);
    // Still a wreck, not set alight again or dented further.
    expect(v.burning).toBe(false);
    expect(v.dents.length).toBe(0);
    // ...and it stays there.
    step(sim, 3);
    expect(Math.abs(v.roll)).toBeGreaterThan(3);
  });

  it('a wreck past its side or past standing on its tail settles on its roof; short of its side, on its wheels', () => {
    const sim = makeSim({ police: false });
    const side = drop(sim, 0, 1.75, 0, true);
    expect(Math.abs(side.roll)).toBeGreaterThan(3);
    const tail = drop(sim, 1, 0, 1.75, true);
    const h0 = 0.3;
    expect(Math.abs(Math.cos(tail.roll))).toBeGreaterThan(0.99);
    expect(Math.cos(tail.roll) * Math.cos(tail.pitch)).toBeLessThan(-0.99);
    // Nose over tail onto its roof: it now faces the other way.
    expect(Math.cos(tail.heading - h0)).toBeLessThan(-0.99);
    const upright = drop(sim, 2, 1.35, 0, true);
    expect(Math.abs(upright.roll)).toBeLessThan(0.05);
    expect(upright.flipped).toBe(false);
  });

  it('a live car that lands mostly upright, facing the other way, is not set on its roof or alight', () => {
    const sim = makeSim({ police: false });
    // Pitched and rolled 143 degrees each: the same as upright with a 37 degree tilt, turned round.
    const v = drop(sim, 0, 2.5, 2.5, false);
    expect(v.flipped).toBe(false);
    expect(v.burning).toBe(false);
    expect(v.drivable).toBe(true);
    expect(Math.abs(v.roll)).toBeLessThan(0.05);
    expect(Math.abs(v.pitch)).toBeLessThan(0.05);
    // A live car on its side (roll 1.8) is still put back on its wheels; one well past it stays on its roof.
    const side = drop(sim, 1, 1.8, 0, false);
    expect(side.flipped).toBe(false);
    expect(Math.abs(side.roll)).toBeLessThan(0.05);
    const roof = drop(sim, 2, 2.2, 0, false);
    expect(roof.flipped).toBe(true);
    expect(roof.burning).toBe(true);
  });

  it('touching down does not change the drawn attitude (only the angles that write it)', () => {
    const sim = makeSim({ police: false });
    for (const [roll, pitch] of [
      [2.5, 2.5],
      [0.4, -2.2],
      [-2.9, 1.9],
      [Math.PI, 0.2],
    ] as const) {
      const p = beach(sim, 0);
      const v = sim.spawnVehicle('sedan', p.x, p.z, 1.1);
      v.destroyed = true;
      v.health = -v.spec.health;
      v.airborne = true;
      v.pos.y = sim.world.groundHeight(p.x, p.z) + 0.001;
      v.vy = -1;
      v.roll = roll;
      v.pitch = pitch;
      v.pitchVel = 1e-6;
      const before = attitude(v);
      stepVehicle(v, 1 / 120, sim);
      expect(v.airborne).toBe(false);
      expect(Math.abs(v.pitch)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
      expect(Math.abs(attitude(v).dot(before))).toBeGreaterThan(1 - 1e-9);
      sim.removeVehicle(v);
    }
  });
});

describe('search reinforcements', () => {
  it('never start where the player can see them, even 160-215 m down the street he stands looking along', () => {
    // Round 2 fix pass 2 kept every search spawn out of his sight only within 160 m: on 5 of 30 streets a unit
    // still appeared far down the one he looked along (in day fog, which starts at 180 m, and with no draw limit).
    let spawned = 0;
    let far = 0;
    const seen: string[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      const sim = makeSim({ seed });
      const lanes = sim.roads.lanes.filter((l) => l.length > 60);
      const lane = lanes[(seed * 53) % lanes.length]!;
      const p = at(lane, lane.length / 2);
      teleport(sim, p.x, p.z);
      sim.wanted.setLevel(2);
      // The police lost him here a while ago, after the response phase, and look around for him.
      sim.wanted.responseUntil = 0;
      sim.wanted.lastSeen = sim.time - 5;
      sim.wanted.searching = true;
      // The on-foot camera behind him, looking along the street.
      sim.cam.x = p.x - lane.dx * 4;
      sim.cam.y = sim.world.groundHeight(p.x, p.z) + 2;
      sim.cam.z = p.z - lane.dz * 4;
      const k = Math.hypot(1, 0.05);
      sim.camDir.x = lane.dx / k;
      sim.camDir.y = -0.05 / k;
      sim.camDir.z = lane.dz / k;
      for (let n = 0; n < 8; n++) {
        const v = sim.police.spawnUnit('police', true);
        if (!v) continue;
        spawned++;
        const d = dist(v.pos, p);
        if (d >= 160) far++;
        if (sim.isVisible(v.pos.x, 1, v.pos.z)) seen.push(`seed ${seed} unit ${n} at ${d.toFixed(0)} m`);
      }
    }
    expect(spawned).toBeGreaterThan(150);
    expect(far).toBeGreaterThan(20);
    expect(seen).toEqual([]);
  });
});

describe('cross traffic queued at a light', () => {
  it('a bus queued round the corner at a light that is not green waits behind its stop line for the green', () => {
    // Cross traffic for a fast player queues 6-10 m short of the line: a bus (half its length is 5.75 m) placed
    // within 6.65 m was already in the junction for its driver, and pulled out against the red.
    const W = world();
    const roads = new Sim({ world: W, ambient: false, police: false }).roads;
    const along = (l: Lane, p: { x: number; z: number }) => (p.x - l.sx) * l.dx + (p.z - l.sz) * l.dz;
    // Streets running into a signalled junction with an avenue across them: buses queue on the avenue.
    const streets = roads.lanes.filter((l) => {
      const node = roads.nodes[l.to]!;
      if (l.line.avenue || l.length < 60 || !node.signal) return false;
      return [1, 3].some((k) => {
        const side = node.neighbors[(l.dir + k) % 4]!;
        return side >= 0 && roads.lanesBetween(side, l.to).some((c) => c.line.avenue);
      });
    });
    expect(streets.length).toBeGreaterThanOrEqual(4);
    let queued = 0;
    let moved = 0;
    const tooNear: string[] = [];
    const ranRed: string[] = [];
    let seed = 0;
    for (const street of streets.slice(0, 6)) {
      for (let t0 = 0; t0 < SIGNAL_CYCLE; t0 += 1.5) {
        const sim = new Sim({ world: W, ambient: false, police: false, seed: ++seed });
        sim.time = t0;
        // The player drives down the street at 20 m/s, 140 m short of the junction, looking back the way he came.
        const p = at(street, street.length - 140);
        const car = sim.spawnVehicle('sports', p.x, p.z, street.heading);
        placeInCar(sim, car);
        car.vel.x = street.dx * 20;
        car.vel.z = street.dz * 20;
        sim.cam.x = p.x;
        sim.cam.y = car.pos.y + 3;
        sim.cam.z = p.z;
        sim.camDir.x = -street.dx;
        sim.camDir.y = 0;
        sim.camDir.z = -street.dz;
        const bus = sim.traffic.trySpawnTraffic(undefined, undefined, 'bus');
        if (!bus || bus.kind !== 'bus' || Math.hypot(bus.vel.x, bus.vel.z) > 0) continue;
        const lane = bus.ai!.currentLane()!;
        const axis = axisOf(lane.dir);
        if (sim.roads.signalState(lane.to, axis, sim.time) === 'green') continue;
        queued++;
        const label = `street ${street.id} t0 ${t0}`;
        const toLine = lane.length - along(lane, bus.pos);
        if (toLine < bus.halfL + 0.9) tooNear.push(`${label}: ${toLine.toFixed(2)} m`);
        // The player gone, the bus waits until its light turns green, its nose behind the line (the lane end).
        sim.removeVehicle(car);
        const start = along(lane, bus.pos);
        for (let f = 0; f < 60 * 20 && sim.roads.signalState(lane.to, axis, sim.time) !== 'green'; f++) {
          sim.update(1 / 60, input());
          if (along(lane, bus.pos) + bus.halfL > lane.length + 0.2) {
            ranRed.push(`${label}: nose ${(along(lane, bus.pos) + bus.halfL - lane.length).toFixed(2)} m past at ${sim.time.toFixed(1)}`);
            break;
          }
        }
        // ...and drives off on the green.
        step(sim, 4);
        if (along(lane, bus.pos) - start > 3 || bus.ai!.currentLane() !== lane) moved++;
      }
    }
    expect(queued).toBeGreaterThanOrEqual(12);
    expect(ranRed).toEqual([]);
    expect(tooNear).toEqual([]);
    expect(moved).toBeGreaterThanOrEqual(queued - 1);
  });
});

describe('a helicopter shot down over the sea', () => {
  it('blows up where it hits the water, with a big splash, not on the seabed; over land it still blows up on the ground', () => {
    const sim = makeSim();
    const b = sim.world.layout.bounds;
    const blasts: { x: number; y: number; z: number; radius: number }[] = [];
    const splashes: { y: number; big: boolean }[] = [];
    sim.events.on('explosion', (e) => blasts.push(e));
    sim.events.on('splash', (e) => splashes.push(e));
    const sea = new Helicopter(sim.newId(), b.beachEndX + 60, 25, -100);
    expect(sim.world.groundHeight(sea.pos.x, sea.pos.z)).toBeLessThan(WATER_Y - 3);
    sea.health = 0;
    sim.helis.push(sea);
    step(sim, 4);
    expect(sea.removed).toBe(true);
    // The kill (a small flash in the air), then the crash.
    const crash = blasts[blasts.length - 1]!;
    expect(crash.radius).toBe(9);
    expect(crash.y).toBeGreaterThanOrEqual(WATER_Y - 0.5);
    expect(crash.y).toBeLessThan(WATER_Y + 1);
    expect(splashes.some((e) => e.big && e.y === WATER_Y)).toBe(true);

    blasts.length = 0;
    splashes.length = 0;
    const lane = longestLane(sim);
    const p = at(lane, lane.length / 2);
    const land = new Helicopter(sim.newId(), p.x, 25, p.z);
    land.health = 0;
    sim.helis.push(land);
    step(sim, 4);
    expect(land.removed).toBe(true);
    const hit = blasts[blasts.length - 1]!;
    const gy = sim.world.groundHeight(hit.x, hit.z);
    expect(hit.radius).toBe(9);
    expect(hit.y).toBeGreaterThanOrEqual(gy);
    expect(hit.y).toBeLessThan(gy + 2);
    expect(splashes).toEqual([]);
  });
});

/** Watches officers on foot: how near any came to the player, and the longest any stood pinned trying to walk. */
function watchOfficers(sim: Sim, cops: () => Character[]): { nearest: number; pinned: number; update(dt: number): void } {
  const last = new Map<Character, { x: number; z: number; pinned: number }>();
  const w = {
    nearest: Infinity,
    pinned: 0,
    update(dt: number) {
      const pp = sim.playerPos();
      for (const c of cops()) {
        if (c.removed || c.state !== 'normal') continue;
        w.nearest = Math.min(w.nearest, Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z));
        const l = last.get(c);
        const moved = l ? Math.hypot(c.pos.x - l.x, c.pos.z - l.z) / dt : Infinity;
        const pinned = c.moveSpeed > 0 && moved < 0.4 ? (l?.pinned ?? 0) + dt : 0;
        w.pinned = Math.max(w.pinned, pinned);
        last.set(c, { x: c.pos.x, z: c.pos.z, pinned });
      }
    },
  };
  return w;
}

describe('officers without a car once the stars are gone', () => {
  it('walk off along the sidewalks away from the player instead of straight into him', () => {
    const sim = makeSim();
    const lane = longestLane(sim);
    const p = at(lane, lane.length / 2);
    // The player on the sidewalk beside the street.
    const spot = sim.world.findFreeSpot(p.x - lane.dz * 8, p.z + lane.dx * 8, 0.5, 6)!;
    teleport(sim, spot.x, spot.z);
    const pp = sim.playerPos();
    const cops: Character[] = [];
    for (const a of [0.3, 2.2, 4.1]) {
      const c = officer(sim, pp.x + Math.cos(a) * 6, pp.z + Math.sin(a) * 6);
      c.heading = Math.atan2(pp.x - c.pos.x, pp.z - c.pos.z);
      cops.push(c);
    }
    expect(sim.wanted.level).toBe(0);
    const w = watchOfficers(sim, () => cops);
    step(sim, 20, () => {
      w.update(1 / 60);
      return input();
    });
    expect(w.nearest).toBeGreaterThan(1.5);
    expect(w.pinned).toBeLessThan(2.5);
    // Off and away (or already gone: cleanup removes them once out of view).
    for (const c of cops) if (!c.removed) expect(dist(c.pos, pp)).toBeGreaterThan(15);
  });

  it('after their car blew up, walk off without shoving the player; at a bust far from the cruiser they stand by him', () => {
    const sim = makeSim();
    const { unit, lane } = deployedUnit(sim);
    const crew = sim.characters.filter((c) => c.brain?.car === unit);
    // The crew came up to the player 50 m down the street.
    const far = at(lane, 90);
    teleport(sim, far.x, far.z);
    for (const [i, c] of crew.entries()) placeOnFoot(sim, c, far.x + lane.dx * (2 + i), far.z + lane.dz * (2 + i));
    for (const c of crew) c.heading = Math.atan2(far.x - c.pos.x, far.z - c.pos.z);
    sim.combat.explodeVehicle(unit);
    sim.wanted.clear();
    const w = watchOfficers(sim, () => crew);
    step(sim, 20, () => {
      w.update(1 / 60);
      return input();
    });
    expect(w.nearest).toBeGreaterThan(1);
    expect(w.pinned).toBeLessThan(2.5);

    // A foot bust 60 m from the cruiser: during BUSTED the arresters do not walk on into him.
    const sim2 = makeSim();
    const d2 = deployedUnit(sim2);
    const crew2 = sim2.characters.filter((c) => c.brain?.car === d2.unit);
    const at2 = at(d2.lane, 100);
    teleport(sim2, at2.x, at2.z);
    for (const [i, c] of crew2.entries()) {
      placeOnFoot(sim2, c, at2.x - d2.lane.dx * (1.2 + i * 0.4), at2.z - d2.lane.dz * (1.2 + i * 0.4));
      c.heading = Math.atan2(at2.x - c.pos.x, at2.z - c.pos.z);
    }
    sim2.bustPlayer();
    expect(sim2.playerDown).toBe(true);
    const start = new Map(crew2.map((c) => [c, dist(c.pos, sim2.playerPos())] as const));
    let closer = 0;
    step(sim2, 4.5, () => {
      for (const c of crew2) if (dist(c.pos, sim2.playerPos()) < start.get(c)! - 0.15) closer++;
      return input();
    });
    expect(closer).toBe(0);
    for (const c of crew2) expect(c.moveSpeed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The driver follow-ups: face-offs with long vehicles and an overtake taken up again after backing out.

/** A one-lane street lane of 80 m or more ending at a signalled four-way junction (as in r2_driver_fix). */
function streetLane(sim: Sim): Lane {
  return sim.roads.lanes.find((l) => !l.line.avenue && l.length >= 80 && sim.roads.nodes[l.to]!.signal && sim.roads.nodes[l.to]!.degree === 4)!;
}

function oppositeLane(sim: Sim, lane: Lane): Lane {
  return sim.roads.lanes.find((l) => l.from === lane.to && l.to === lane.from)!;
}

const alongLane = (lane: Lane, p: { x: number; z: number }) => (p.x - lane.sx) * lane.dx + (p.z - lane.sz) * lane.dz;
const acrossLane = (lane: Lane, p: { x: number; z: number }) => (p.x - lane.sx) * -lane.dz + (p.z - lane.sz) * lane.dx;

/** A civilian-driven vehicle on `lane` at `s`, rolling at `speed`. */
function driveOn(sim: Sim, kind: VehicleKind, lane: Lane, s: number, speed = 0): Vehicle {
  const v = sim.spawnVehicle(kind, lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
  v.owner = 'traffic';
  sim.addDriver(v, 'civilian', 'traffic');
  v.ai!.speedMul = 1;
  v.ai!.setLane(lane, s);
  v.vel.x = lane.dx * speed;
  v.vel.z = lane.dz * speed;
  return v;
}

/** Driver internals the scenarios read. */
type DriverPeek = { reverseTimer: number; reverseKind: string; yielded: Vehicle | null; merging: boolean; startReverse(steer: number, kind: 'pullIn', time?: number): void };
const peek = (v: Vehicle) => v.ai as unknown as DriverPeek;

/**
 * The face-off layout of the driver sweeps: a `blk` left in a one-lane street 45 m in (and a sedan `second` m behind it,
 * bumper gap, unless negative); an overtaker `x` from 8 m at 8 m/s; `delay` s after it first backs up, a `y` from the far
 * end at 12 m/s (with a sedan `follower` m behind it, unless negative). How long after that first reverse all of them are
 * past (-1 if not within 90 s), the impacts, the closest two bodies came, the longest any driven car stood (its stuckTime),
 * and how often the one coming the other way backed up to make way.
 */
function faceOffRun(blk: VehicleKind, second: number, x: VehicleKind, y: VehicleKind, delay: number, follower: number): { took: number; impacts: number; clear: number; stuck: number; backs: number } {
  const sim = makeSim({ police: false });
  const lane = streetLane(sim);
  for (const n of sim.roads.nodes) n.signal = false;
  const opp = oppositeLane(sim, lane);
  const parked = sim.spawnVehicle(blk, at(lane, 45).x, at(lane, 45).z, lane.heading);
  const half2 = VEHICLE_SPECS.sedan.length / 2;
  const parked2 = second >= 0 ? sim.spawnVehicle('sedan', at(lane, 45 - parked.halfL - second - half2).x, at(lane, 45 - parked.halfL - second - half2).z, lane.heading) : null;
  const car = driveOn(sim, x, lane, 8, 8);
  let oncoming: Vehicle | null = null;
  let behind: Vehicle | null = null;
  let impacts = 0;
  sim.events.on('impact', (e) => {
    if (e.vehicle && [car, oncoming, behind, parked, parked2].includes(e.vehicle)) impacts++;
  });
  const end = alongLane(lane, parked.pos) + parked.halfL;
  const begin = alongLane(lane, (parked2 ?? parked).pos) - (parked2 ?? parked).halfL;
  let start = -1;
  let carPast = -1;
  let oncomingPast = -1;
  let behindPast = -1;
  let clear = Infinity;
  let stuck = 0;
  let backs = 0;
  let backing = false;
  for (let f = 0; f < 60 * 90; f++) {
    const t = f / 60;
    if (start < 0 && t > 1 && car.forwardSpeed < -0.2) start = t;
    if (start >= 0 && !oncoming && t >= start + delay) {
      oncoming = driveOn(sim, y, opp, 2, 12);
      if (follower >= 0) behind = driveOn(sim, 'sedan', opp, 2 - oncoming.halfL - follower - half2, 12);
    }
    sim.update(1 / 60, input());
    const cars = [car, oncoming, behind, parked, parked2].filter((v): v is Vehicle => !!v && !v.removed);
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        if ((cars[i]!.ai || cars[j]!.ai) && dist(cars[i]!.pos, cars[j]!.pos) < 16) clear = Math.min(clear, bodyGapAt(cars[i]!, cars[i]!.pos.x, cars[i]!.pos.z, cars[i]!.heading, cars[j]!));
      }
    }
    for (const v of [car, oncoming, behind]) if (v && !v.removed) stuck = Math.max(stuck, v.stuckTime);
    const yBacking = !!oncoming && peek(oncoming).reverseTimer > 0 && peek(oncoming).reverseKind === 'yield';
    if (yBacking && !backing) backs++;
    backing = yBacking;
    if (carPast < 0 && alongLane(lane, car.pos) - car.halfL > end + 3 && Math.abs(acrossLane(lane, car.pos)) < 1) carPast = t;
    if (oncoming && oncomingPast < 0 && alongLane(lane, oncoming.pos) + oncoming.halfL < begin - 1) oncomingPast = t;
    if (behind && behindPast < 0 && alongLane(lane, behind.pos) + behind.halfL < begin - 1) behindPast = t;
    if (carPast >= 0 && oncomingPast >= 0 && (!behind || behindPast >= 0)) break;
  }
  const done = carPast >= 0 && oncomingPast >= 0 && (!behind || behindPast >= 0);
  return { took: done && start >= 0 ? Math.max(carPast, oncomingPast, behindPast) - start : -1, impacts, clear, stuck, backs };
}

describe('face-offs with long vehicles and overtakes after backing out (driver follow-ups)', () => {
  it('a bus pulling back in past a bus coming the other way turns in and goes on, without touching it', () => {
    // Its tail still out in the other lane, the pull-in used to stop for that bus (the corridor's extents take in a car
    // beside us at an angle); a full-lock pull-in reverse then swung the tail into it, and the other bus backed up twice.
    const bad: string[] = [];
    for (const delay of [5, 5.5, 6])
      for (const follower of [-1, 1.5]) {
        const r = faceOffRun('sedan', 2, 'bus', 'bus', delay, follower);
        if (r.took < 0 || r.took > 25 || r.impacts > 0 || r.clear < 0.1 || r.backs > 1) bad.push(`delay ${delay}, follower ${follower}: ${r.took.toFixed(1)} s, ${r.impacts} impacts, ${r.clear.toFixed(2)} m, ${r.backs} backs`);
      }
    expect(bad).toEqual([]);
  });

  it('a pull-in reverse stops before the body swings into the car it makes way for', () => {
    const sim = makeSim({ police: false });
    const lane = streetLane(sim);
    for (const n of sim.roads.nodes) n.signal = false;
    const opp = oppositeLane(sim, lane);
    // As in the review's trace: a bus pulling back in, its nose turned in 0.17 rad and its tail 0.9 m out in the other
    // lane, stands beside a bus that came the other way and stopped 0.3 m from it.
    const x = driveOn(sim, 'bus', lane, 72.8);
    x.pos.x += lane.dz * 0.66;
    x.pos.z -= lane.dx * 0.66;
    x.heading = lane.heading - 0.17;
    const y = driveOn(sim, 'bus', opp, alongLane(opp, at(lane, 75.7)));
    const g0 = bodyGapAt(x, x.pos.x, x.pos.z, x.heading, y);
    expect(g0).toBeGreaterThan(0.1);
    expect(g0).toBeLessThan(0.6);
    peek(x).yielded = y;
    peek(x).startReverse(-1, 'pullIn', 2.5);
    let closest = g0;
    for (let f = 0; f < 60 * 3; f++) {
      sim.update(1 / 60, input());
      y.vel.x = 0;
      y.vel.z = 0;
      closest = Math.min(closest, bodyGapAt(x, x.pos.x, x.pos.z, x.heading, y));
    }
    expect(closest).toBeGreaterThan(g0 - 0.1);
  });

  it('a car that backed out of a face-off takes the overtake up again where it stopped or once slow, not rolling up to what it passes', () => {
    // The review's nine layouts: a bus left in the street with a sedan 2 m behind it, a compact or sports car overtaking,
    // and a compact or sports car with another behind it coming the other way 2-4 s later. The stale blocked time used to
    // take the overtake up again at 6-7 m/s, 5-6 m short of the sedan, and the car stood wedged against its corner.
    const bad: string[] = [];
    for (const [x, y, delay] of [
      ['compact', 'compact', 2],
      ['compact', 'compact', 3],
      ['compact', 'compact', 4],
      ['compact', 'sports', 2],
      ['compact', 'sports', 3],
      ['compact', 'sports', 4],
      ['sports', 'sports', 4],
    ] as const) {
      const r = faceOffRun('bus', 2, x, y, delay, 1.5);
      if (r.took < 0 || r.took > 36 || r.stuck > 14 || r.impacts > 0 || r.clear < 0.05) bad.push(`${x} meets ${y} ${delay} s on: ${r.took.toFixed(1)} s, stood ${r.stuck.toFixed(1)} s, ${r.impacts} impacts, ${r.clear.toFixed(2)} m`);
    }
    expect(bad).toEqual([]);
  });

  it('a bus overtaking a bus gets past it, and the bus coming the other way does not back up again and again for nothing', () => {
    // The overtaker stood wedged against the corner of the bus it passed (gap -5 m by the corridor's extents) for up to a
    // minute while the oncoming bus backed up six times; now it drives on past it when that takes it no nearer.
    const bad: string[] = [];
    for (const delay of [3, 4, 5, 6]) {
      const r = faceOffRun('bus', -1, 'bus', 'bus', delay, -1);
      if (r.took < 0 || r.took > 32 || r.stuck > 20 || r.backs > 1 || r.impacts > 0 || r.clear < 0.05) bad.push(`delay ${delay}: ${r.took.toFixed(1)} s, stood ${r.stuck.toFixed(1)} s, ${r.backs} backs, ${r.impacts} impacts, ${r.clear.toFixed(2)} m`);
    }
    expect(bad).toEqual([]);
  });
});

describe('driving into the surf', () => {
  /** The beach at z = -100 (clear of the pier and the marina): the x where the water is `depth` m deep. */
  function surfX(sim: Sim, depth: number): number {
    const b = sim.world.layout.bounds;
    let x = b.beachStartX;
    while (WATER_Y - sim.world.groundHeight(x, -100) < depth && x < b.beachEndX) x += 0.05;
    return x;
  }

  it('water up to the sills holds a car back before it floods, instead of none at all', () => {
    const sim = makeSim({ police: false });
    const b = sim.world.layout.bounds;
    const v = sim.spawnVehicle('sports', b.beachStartX + 10, -100, Math.PI / 2);
    placeInCar(sim, v);
    let atEdge = -1;
    let deep = -1;
    step(sim, 10, () => {
      const depth = WATER_Y - v.pos.y;
      if (atEdge < 0 && depth >= 0) atEdge = v.speed;
      if (deep < 0 && depth >= 0.7) deep = v.speed;
      return input({ throttle: v.inWater ? 0 : 1 });
    });
    expect(atEdge).toBeGreaterThan(20);
    // Full throttle all the way: it used to keep gaining speed through the surf.
    expect(deep).toBeLessThan(atEdge - 3);
    expect(v.inWater).toBe(true);
  });

  it('a car standing in water half a metre deep drives or backs out onto dry sand', () => {
    for (const [heading, inp] of [
      [-Math.PI / 2, { throttle: 1 }],
      [Math.PI / 2, { brake: 1 }],
    ] as const) {
      const sim = makeSim({ police: false });
      const v = sim.spawnVehicle('sedan', surfX(sim, 0.5), -100, heading);
      placeInCar(sim, v);
      let out = -1;
      step(sim, 8, (t) => {
        if (out < 0 && WATER_Y - v.pos.y < 0) out = t;
        return input(inp);
      });
      expect(v.inWater).toBe(false);
      expect(out).toBeGreaterThan(0);
      expect(out).toBeLessThan(6);
    }
  });
});
