// Round 2 fix pass 3, police cluster: sirens off with the stars, wrecks that stay on their roof, and the
// police, traffic and driver follow-ups (each test fails on the code before its fix).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import { Sim } from '../../src/sim/sim';
import { stepVehicle } from '../../src/sim/vehiclePhysics';
import { axisOf, SIGNAL_CYCLE, type Lane } from '../../src/world/roads';
import { at, dist, internals, longestLane, placeOnFoot } from './r2_police_helpers';
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
