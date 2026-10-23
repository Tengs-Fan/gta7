// The keyboard bot of tests/e2e/street_runs_keyboard.spec.ts, driven headlessly: it only holds W/S/A/D/Space (as
// digital input, decided every few frames like a page round trip) and has to finish Magnolia Rush through default
// ambient traffic without touching another vehicle.

import { describe, expect, it } from 'vitest';
import type { StreetRunJob } from '../../src/sim/activities';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { coursePath, KeyboardBot, type BotCar, type BotKeys, type BotObstacle } from '../e2e/keyboardBot';
import { input, makeSim, placeInCar } from './helpers';

/** Frames between decisions: a page.evaluate and its key presses take about this long. */
const POLL = 3;

function view(sim: Sim, car: Vehicle): { car: BotCar; obstacles: BotObstacle[] } {
  const obstacles: BotObstacle[] = [];
  for (const v of sim.vehicles) {
    if (v === car || v.removed) continue;
    obstacles.push({ x: v.pos.x, z: v.pos.z, heading: v.heading, halfL: v.halfL, halfW: v.halfW, vx: v.vel.x, vz: v.vel.z });
  }
  for (const c of sim.characters) {
    if (c.isPlayer || c.removed || c.vehicle) continue;
    obstacles.push({ x: c.pos.x, z: c.pos.z, heading: 0, halfL: 0.4, halfW: 0.4, vx: c.vel.x, vz: c.vel.z });
  }
  return {
    car: { x: car.pos.x, z: car.pos.z, heading: car.heading, speed: car.forwardSpeed, wheel: car.steer, halfL: car.halfL, halfW: car.halfW, length: car.spec.length, steer: car.spec.steer },
    obstacles,
  };
}

function run(seed: number, standing: Array<[number, number]> = []) {
  // As Game.startStreetRun: a new game with traffic and police, the car in the start gate at 18:06, the run at once.
  const sim = makeSim({ ambient: true, police: true, seed, startHour: 18.1 });
  const course = sim.activities.streetRunCourses().find((c) => c.id === 'magnolia')!;
  const car = sim.spawnVehicle('sports', course.start.x, course.start.z, course.start.heading);
  placeInCar(sim, car);
  expect(sim.activities.startStreetRun('magnolia')).toBe(true);
  const bot = new KeyboardBot(coursePath(sim.roads, course));
  const pinned = standing.map(([x, z]) => sim.spawnCharacter('civilian', x, z));
  let closest = Infinity;
  const contacts: string[] = [];
  const impact = sim.onVehicleImpact.bind(sim);
  sim.onVehicleImpact = (v: Vehicle, other: Vehicle | null, ...rest: unknown[]) => {
    const racing = (sim.activities.job as StreetRunJob | null)?.stage === 'racing';
    if (racing && other && (v === car || other === car)) contacts.push(`${(sim.activities.job as StreetRunJob).elapsed.toFixed(1)}s ${other === car ? v.kind : other.kind}`);
    return (impact as (...a: unknown[]) => void)(v, other, ...rest);
  };
  let finish: { time: number; medal: string; reward: number } | null = null;
  sim.events.on('streetRunFinished', (e) => (finish = { time: e.time, medal: e.medal, reward: e.reward }));
  const gates: number[] = [];
  sim.events.on('streetRunCheckpoint', (e) => gates.push(e.index));
  let keys: BotKeys = { KeyW: false, KeyS: false, KeyA: false, KeyD: false, Space: false };
  for (let f = 0; f < 60 * (course.bronze + 10) && sim.activities.busy; f++) {
    if ((sim.activities.job as StreetRunJob).stage === 'racing' && f % POLL === 0) {
      const v = view(sim, car);
      keys = bot.decide(v.car, v.obstacles);
    }
    const steer = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const inp = input({ throttle: keys.KeyW ? 1 : 0, brake: keys.KeyS ? 1 : 0, steer, steerDigital: steer !== 0, handbrake: keys.Space, moveZ: (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), moveX: steer });
    const p = sim.playerPos();
    inp.aimOrigin = { x: p.x, y: p.y + 3, z: p.z - 6 };
    sim.update(1 / 60, inp);
    for (const [k, c] of pinned.entries()) {
      c.pos.x = standing[k]![0];
      c.pos.z = standing[k]![1];
      // Gap between the pedestrian's circle and the car's footprint.
      const dx = c.pos.x - car.pos.x;
      const dz = c.pos.z - car.pos.z;
      const along = Math.abs(dx * Math.sin(car.heading) + dz * Math.cos(car.heading)) - car.halfL;
      const across = Math.abs(dx * Math.cos(car.heading) - dz * Math.sin(car.heading)) - car.halfW;
      closest = Math.min(closest, Math.hypot(Math.max(0, along), Math.max(0, across)) - 0.4);
    }
  }
  return { closest, finish: finish as { time: number; medal: string; reward: number } | null, contacts, gates, total: course.checkpoints.length, bronze: course.bronze, end: `${car.pos.x.toFixed(0)},${car.pos.z.toFixed(0)}` };
}

describe('street run keyboard bot', () => {
  it.each([1, 2, 3])('finishes Magnolia Rush through traffic without contact (seed %i)', (seed) => {
    const r = run(seed);
    console.log(`[kbbot] seed ${seed}: ${r.finish ? `${r.finish.time.toFixed(1)}s ${r.finish.medal} $${r.finish.reward}` : `DNF at ${r.end}`}; gates ${r.gates.length}/${r.total}; contacts ${r.contacts.length ? r.contacts.join(', ') : 0}`);
    expect(r.finish, `gates ${r.gates.join(',')} at ${r.end}`).not.toBeNull();
    expect(r.gates).toEqual(Array.from({ length: r.total }, (_, k) => k + 1));
    expect(r.finish!.time).toBeLessThanOrEqual(r.bronze);
    expect(r.finish!.reward).toBeGreaterThan(0);
    expect(r.contacts).toEqual([]);
  });
});

describe('street run keyboard bot around people standing at the kerb (whole run)', () => {
  // Two pedestrians pinned on the corner Magnolia Rush turns right round at gate 11, as a held light leaves them.
  it('finishes without touching them', () => {
    const r = run(4, [[5.1, -259.2], [6.4, -257.2]]);
    console.log(`[kbbot] pedestrians at the corner: ${r.finish ? r.finish.time.toFixed(1) + 's' : `DNF at ${r.end}`}; closest ${r.closest.toFixed(2)} m; contacts ${r.contacts.length}`);
    expect(r.finish, `gates ${r.gates.join(',')} at ${r.end}`).not.toBeNull();
    expect(r.contacts).toEqual([]);
    expect(r.closest).toBeGreaterThan(0.1);
  });
});

describe('street run keyboard bot around people standing at the kerb', () => {
  // Magnolia Rush turns right at the signalled junction (-4,-268). While the light is held for the racer, pedestrians
  // wait for the crossing on the corner it turns round, and never leave (Pedestrians' crossWait). The bot must drive
  // on past them, not wait for them to move.
  const sim = makeSim({ ambient: false, police: false, seed: 1, startHour: 18.1 });
  const course = sim.activities.streetRunCourses().find((c) => c.id === 'magnolia')!;
  const sports = sim.spawnVehicle('sports', 2, -230, Math.PI);
  const car: BotCar = { x: 2, z: -254, heading: Math.PI, speed: 0, wheel: 0, halfL: sports.halfL, halfW: sports.halfW, length: sports.spec.length, steer: sports.spec.steer };

  /** A bot that has driven up to the car's place at the head of the junction. */
  function arrived(): KeyboardBot {
    const path = coursePath(sim.roads, course);
    const bot = new KeyboardBot(path);
    for (const p of path) {
      if (p.z < -254 && p.x === 2) break;
      bot.decide({ ...car, x: p.x, z: p.z }, []);
    }
    return bot;
  }

  it.each([[5.4, -256.7], [5.4, -258.9], [6.2, -257.8], [7, -256.7], [7, -258.9]])('sets off with a pedestrian standing at (%f, %f)', (x, z) => {
    const bot = arrived();
    let keys: BotKeys = { KeyW: false, KeyS: false, KeyA: false, KeyD: false, Space: false };
    for (let i = 0; i < 4; i++) keys = bot.decide(car, [{ x, z, heading: 0, halfL: 0.4, halfW: 0.4, vx: 0, vz: 0 }]);
    expect(keys.KeyW).toBe(true);
  });

  it('still stops for a pedestrian standing in its lane', () => {
    const keys = arrived().decide(car, [{ x: 2.1, z: -257.1, heading: 0, halfL: 0.4, halfW: 0.4, vx: 0, vz: 0 }]);
    expect(keys.KeyW).toBe(false);
  });
});
