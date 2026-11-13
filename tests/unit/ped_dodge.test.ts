// People get out of the way of a car a player drives at them (PedSystem.dodge, round 8): at town speeds they step
// clear, flat out they do not, and a car at a crawl, a mission's standing figure and the sea's edge are no cause to run.

import { describe, expect, it } from 'vitest';
import { makeBrain } from '../../src/sim/brains';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { input, makeSim, placeInCar, world } from './helpers';

const DT = 1 / 60;

/** A street with nobody on it, the player in a sedan at its start and one civilian standing about `ahead` m down the lane, `off` m to its side. */
function scene(ahead: number, off = 0, mode: 'idle' | 'stand' | 'wander' = 'idle'): { sim: Sim; car: Vehicle; ped: Character; ux: number; uz: number } {
  const sim = makeSim({ world: world(), ambient: false, police: false });
  const lane = sim.roads.lanes.find((l) => l.lanesInDir === 2 && l.length > 90)!;
  const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 8, lane.sz + lane.dz * 8, lane.heading);
  placeInCar(sim, car);
  const ped = sim.spawnCharacter('civilian', car.pos.x + lane.dx * ahead + lane.dz * off, car.pos.z + lane.dz * ahead - lane.dx * off);
  ped.brain = makeBrain(mode);
  ped.brain.modeTimer = 60;
  return { sim, car, ped, ux: lane.dx, uz: lane.dz };
}

/** Drives the car down the lane at `speed` m/s (held there, whatever it meets) for `secs` s; true if it ran the civilian down. */
function drive(s: ReturnType<typeof scene>, speed: number, secs: number): boolean {
  const { sim, car, ped } = s;
  let hit = false;
  const was = sim.onCharacterHitByVehicle.bind(sim);
  sim.onCharacterHitByVehicle = (c, v, rel, nx, nz) => {
    if (c === ped) hit = true;
    return was(c, v, rel, nx, nz);
  };
  const heading = car.heading;
  for (let i = 0; i < Math.round(secs / DT); i++) {
    car.vel.x = s.ux * speed;
    car.vel.z = s.uz * speed;
    car.heading = heading;
    car.angVel = 0;
    sim.update(DT, input());
  }
  return hit;
}

/** How far to the side of the car's line the civilian stands. */
const aside = (s: ReturnType<typeof scene>) => Math.abs((s.ped.pos.x - s.car.pos.x) * s.uz - (s.ped.pos.z - s.car.pos.z) * s.ux);

describe('people dodge a car a player drives at them', () => {
  it.each([7, 9, 12])('at %d m/s the one in its way dashes clear and is not hit, then walks on', (speed) => {
    for (const off of [0, 0.5, -0.6]) {
      const s = scene(30, off);
      // One 'pedDodge' a dash, at his head, with his id: what the audio hangs his shout on.
      const shouts: Array<{ who: number; y: number }> = [];
      s.sim.events.on('pedDodge', (e) => shouts.push({ who: e.who, y: e.y }));
      const hit = drive(s, speed, 30 / speed + 1.5);
      expect(shouts).toEqual([{ who: s.ped.id, y: s.ped.pos.y + 1.6 }]);
      expect(hit, `${off} m off its line`).toBe(false);
      expect(s.ped.alive).toBe(true);
      expect(s.ped.state).toBe('normal');
      // Clear of its flank, to the side he stood on (dead ahead of it: either).
      expect(aside(s), `${off} m off its line`).toBeGreaterThan(s.car.halfW + 0.3);
      if (off !== 0) expect(Math.sign((s.ped.pos.x - s.car.pos.x) * s.uz - (s.ped.pos.z - s.car.pos.z) * s.ux)).toBe(Math.sign(off));
      // The dash is over; he stands clear while the car goes by, and is his own man again once it has gone.
      expect(s.ped.brain!.dodge).toBeLessThanOrEqual(0);
      drive(s, speed, 3);
      expect(s.ped.brain!.dodge).toBe(0);
      expect(s.ped.brain!.mode).toBe('idle');
    }
  });

  it('he stands clear for as long as the car crawls past him, eight seconds at most, and no longer once it stops', () => {
    const s = scene(30);
    drive(s, 9, 30 / 9);
    // Past him now and crawling on within six metres: he waits.
    const { car, ped } = s;
    for (let i = 0; i < 180; i++) {
      car.pos.x = ped.pos.x + s.ux * 3;
      car.pos.z = ped.pos.z + s.uz * 3;
      car.vel.x = s.ux * 1.5;
      car.vel.z = s.uz * 1.5;
      s.sim.update(DT, input());
    }
    expect(ped.brain!.dodge).toBeLessThan(-2.5);
    expect(ped.speed).toBeLessThan(0.3);
    // Stopped beside him (he has stood his two and a half seconds): he is free to go at once.
    car.vel.x = 0;
    car.vel.z = 0;
    for (let i = 0; i < 6; i++) {
      car.vel.x = 0;
      car.vel.z = 0;
      s.sim.update(DT, input({ handbrake: true }));
    }
    expect(ped.brain!.dodge).toBe(0);
    // And a car that will not stop circling him does not keep him there for ever.
    const r = scene(30);
    drive(r, 9, 30 / 9);
    for (let i = 0; i < 60 * 9; i++) {
      r.car.pos.x = r.ped.pos.x + r.ux * 3;
      r.car.pos.z = r.ped.pos.z + r.uz * 3;
      r.car.vel.x = r.ux * 1.5;
      r.car.vel.z = r.uz * 1.5;
      r.sim.update(DT, input());
    }
    expect(r.ped.brain!.dodge).toBeGreaterThanOrEqual(0);
  });

  it('flat out nobody makes it: the warning is a distance, a quarter of a second at 40 m/s', () => {
    const s = scene(60);
    expect(drive(s, 40, 2.2)).toBe(true);
    expect(s.ped.state === 'knocked' || !s.ped.alive).toBe(true);
  });

  it('a car creeping along (under 23 km/h) is not run from: its driver can stop', () => {
    const s = scene(12);
    const at = { x: s.ped.pos.x, z: s.ped.pos.z };
    drive(s, 6, 1.2);
    expect(s.ped.brain!.dodge).toBeLessThanOrEqual(0);
    // He has not dashed anywhere before it reaches him.
    expect(Math.hypot(s.ped.pos.x - at.x, s.ped.pos.z - at.z)).toBeLessThan(0.2);
  });

  it('someone beside its path stays where he is: the pavement beside a lane is no cause to run', () => {
    const s = scene(30, 3.2);
    const at = { x: s.ped.pos.x, z: s.ped.pos.z };
    expect(drive(s, 12, 4)).toBe(false);
    expect(Math.hypot(s.ped.pos.x - at.x, s.ped.pos.z - at.z)).toBeLessThan(0.05);
  });

  it("a mission's standing figure holds his ground, and so does anyone the player is not driving at", () => {
    const s = scene(30, 0, 'stand');
    expect(drive(s, 9, 4.5)).toBe(true);
    // An empty car rolling (nobody at the wheel) scares nobody either.
    const r = scene(30);
    r.sim.unseat(r.sim.player);
    const at = { x: r.ped.pos.x, z: r.ped.pos.z };
    drive(r, 9, 2);
    expect(Math.hypot(r.ped.pos.x - at.x, r.ped.pos.z - at.z)).toBeLessThan(0.2);
  });

  it('nobody jumps clear while a clock runs: a street run is tuned on people who stood their ground', () => {
    const sim = makeSim({ world: world(), ambient: false, police: false });
    const course = sim.activities.streetRunCourses().find((c) => c.id === 'magnolia')!;
    const car = sim.spawnVehicle('sedan', course.start.x, course.start.z, course.start.heading);
    placeInCar(sim, car);
    expect(sim.activities.startStreetRun('magnolia')).toBe(true);
    // Through the countdown (the car is held in the gate) to the race.
    for (let i = 0; i < 600 && (sim.activities.job as { stage?: string } | null)?.stage !== 'racing'; i++) sim.update(DT, input());
    expect((sim.activities.job as { stage?: string } | null)?.stage).toBe('racing');
    const ux = Math.sin(car.heading);
    const uz = Math.cos(car.heading);
    const ped = sim.spawnCharacter('civilian', car.pos.x + ux * 30, car.pos.z + uz * 30);
    ped.brain = makeBrain('idle');
    ped.brain.modeTimer = 60;
    expect(drive({ sim, car, ped, ux, uz }, 9, 4)).toBe(true);
    expect(ped.brain.dodge).toBe(0);
  });

  it('never into the sea: on a quay he goes the way that is dry', () => {
    const sim = makeSim({ world: world(), ambient: false, police: false });
    const w = sim.world;
    const b = w.layout.bounds;
    // A spot on the beach with the sea within the dash's three metres to the east of it and dry sand to the west.
    let spot: { x: number; z: number; nx: number; nz: number } | null = null;
    const z0 = (b.landMinZ + b.landMaxZ) / 2;
    for (let x = b.beachStartX; x < b.beachStartX + 120 && !spot; x += 0.25) {
      if (w.waterDepth(x, z0) <= -0.2 && w.waterDepth(x - 2.97, z0) <= -0.2 && w.waterDepth(x + 2.97, z0) > -0.2) spot = { x, z: z0, nx: 1, nz: 0 };
    }
    expect(spot).not.toBeNull();
    const { x, z, nx, nz } = spot!;
    // The car comes along the water's edge (perpendicular to the way to the sea), the civilian a hair to the sea's side of its line.
    const ux = nz;
    const uz = -nx;
    const car = sim.spawnVehicle('sedan', x - ux * 14, z - uz * 14, Math.atan2(ux, uz));
    placeInCar(sim, car);
    const ped = sim.spawnCharacter('civilian', x + nx * 0.3, z + nz * 0.3);
    ped.brain = makeBrain('idle');
    ped.brain.modeTimer = 60;
    for (let i = 0; i < 60 && ped.brain.dodge <= 0; i++) {
      car.vel.x = ux * 9;
      car.vel.z = uz * 9;
      sim.update(DT, input());
    }
    expect(ped.brain.dodge).toBeGreaterThan(0);
    // Away from the sea, though he stood on its side of the car's line.
    expect(ped.brain.dodgeX * nx + ped.brain.dodgeZ * nz).toBeLessThan(-0.99);
  });
});
