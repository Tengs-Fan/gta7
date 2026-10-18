// Round 2 fix pass 3, police cluster: sirens off with the stars, wrecks that stay on their roof, and the
// police, traffic and driver follow-ups (each test fails on the code before its fix).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { stepVehicle } from '../../src/sim/vehiclePhysics';
import { at, dist, internals, longestLane, placeOnFoot } from './r2_police_helpers';
import { input, makeSim, placeInCar, step, teleport } from './helpers';

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
