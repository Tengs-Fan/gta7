// Shared scenario helpers for the round 2 police tests (r2_police*.test.ts).

import { vi } from 'vitest';
import { DriverAI } from '../../src/sim/driver';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import type { Lane, Turn } from '../../src/world/roads';
import { input, makeSim, placeInCar, step } from './helpers';

/** PoliceSystem internals the scenarios set up or inspect. */
export interface PoliceInternals {
  equip(c: Character, car: Vehicle | null): void;
  deploy(v: Vehicle): void;
  arrester: Character | null;
}
export const internals = (sim: Sim) => sim.police as unknown as PoliceInternals;

/** A seeded stand-in for Math.random (helicopter orbits, brain timers, crash spins), so runs repeat exactly. */
export function seedMathRandom(seed: number): void {
  let a = seed >>> 0;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

export function longestLane(sim: Sim, avenue = false): Lane {
  return [...sim.roads.lanes].filter((l) => !avenue || l.line.avenue).sort((a, b) => b.length - a.length)[0]!;
}

export function at(lane: Lane, s: number): { x: number; z: number } {
  return { x: lane.sx + lane.dx * s, z: lane.sz + lane.dz * s };
}

export const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

export function placeOnFoot(sim: Sim, c: Character, x: number, z: number): void {
  if (c.vehicle) sim.unseat(c);
  const spot = sim.world.findFreeSpot(x, z, 0.4, 10) ?? { x, z };
  c.state = 'normal';
  c.pos.x = spot.x;
  c.pos.z = spot.z;
  c.pos.y = sim.world.groundHeight(spot.x, spot.z);
}

/** A free spot about `r` m from (x, z) with a clear line of sight to it. */
export function visibleSpot(sim: Sim, x: number, z: number, r: number, a0 = 0): { x: number; z: number } {
  const y = sim.world.groundHeight(x, z);
  for (let k = 0; k < 64; k++) {
    const a = a0 + (k / 64) * Math.PI * 2;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    const py = sim.world.groundHeight(px, pz);
    if (Math.abs(py - y) > 0.5 || !sim.world.isFree(px, pz, 0.6)) continue;
    if (sim.world.lineOfSight(px, py + 1.6, pz, x, y + 1.2, z)) return { x: px, z: pz };
  }
  throw new Error('no visible spot');
}

/** An officer on foot with the police kit and brain (and no car), standing at (x, z). */
export function officer(sim: Sim, x: number, z: number, role: 'cop' | 'swat' = 'cop'): Character {
  const c = sim.spawnCharacter(role, x, z);
  internals(sim).equip(c, null);
  placeOnFoot(sim, c, x, z);
  return c;
}

/** Counts police gunfire: 'shot' events by officers, plus helicopter rounds with `heli`. */
export function countPoliceShots(sim: Sim, heli = false): { n: number } {
  const count = { n: 0 };
  sim.events.on('shot', (e) => {
    if (e.shooter ? e.shooter.isLaw : heli) count.n++;
  });
  return count;
}

/** Steps `seconds`, noting the first time `done` holds (-1 if never). */
export function stepUntil(sim: Sim, seconds: number, done: () => boolean, inp: (t: number) => PlayerInput = () => input()): number {
  let when = -1;
  step(sim, seconds, (t) => {
    if (when < 0 && done()) when = t;
    return inp(t);
  });
  return when;
}

/**
 * The flee bot: drives the player's car down the lanes flat out, going straight on at every junction
 * where it can and taking the first legal turn where it cannot. A DriverAI does the steering and
 * braking for corners and traffic (without traffic lights); its speed factor of 3 with a cornering
 * figure of 11/9 lifts the lane limits threefold while keeping corners to 11 m/s² (as pursuers take them).
 */
export function fleeBot(sim: Sim, car: Vehicle, maxSpeed = Infinity): (dt?: number) => PlayerInput {
  const ai = new DriverAI(sim, car, 'flee');
  (ai as unknown as { chooseTurn(l: Lane): Turn | null }).chooseTurn = (lane: Lane) => lane.turns.find((t) => t.kind === 'straight') ?? lane.turns.find((t) => t.legal) ?? lane.turns[0] ?? null;
  ai.speedMul = 3;
  ai.cornering = 11 / 9;
  ai.maxSpeed = Math.min(car.spec.maxSpeed, maxSpeed);
  ai.resetPath();
  return (dt = 1 / 60) => {
    ai.update(dt);
    const c = car.controls;
    return input({ throttle: c.throttle, brake: c.brake, steer: c.steer, handbrake: c.handbrake });
  };
}

/** A long lane in the inner city to start a getaway from (a different one for each seed). */
export function startLane(sim: Sim, seed: number): Lane {
  const ok = sim.roads.lanes.filter((l) => l.length > 70 && Math.abs(l.sx) < 350 && Math.abs(l.sz) < 350);
  return ok[(seed * 7919) % ok.length]!;
}

/** Puts the player in a sports car on the seed's start lane, rolling, and returns the bot that drives it. */
export function getaway(sim: Sim, seed: number, kind: 'sports' | 'sedan' = 'sports'): { car: Vehicle; bot: (dt?: number) => PlayerInput } {
  const lane = startLane(sim, seed);
  const p = at(lane, 10);
  const car = sim.spawnVehicle(kind, p.x, p.z, lane.heading);
  placeInCar(sim, car);
  car.vel.x = lane.dx * 15;
  car.vel.z = lane.dz * 15;
  return { car, bot: fleeBot(sim, car) };
}

/** Police units on duty (as PoliceSystem counts them): drivable police cars with a live crew, aboard or out on foot. */
export function liveUnits(sim: Sim): Vehicle[] {
  return sim.vehicles.filter(
    (v) =>
      v.owner === 'police' &&
      !v.removed &&
      v.drivable &&
      (!v.driver || v.driver.isLaw) &&
      (v.occupants().some((c) => c.isLaw && c.alive) || sim.characters.some((c) => !c.removed && c.isLaw && c.alive && c.brain?.car === v)),
  );
}

// ---------------------------------------------------------------------------
// Flee-bot runs (P10)

/** Seeds of the flee-bot runs. */
export const FLEE_SEEDS = [3, 11, 19] as const;

export interface FleeRun {
  /** Seconds until the stars were lost (-1: never). */
  lostAt: number;
  /** Seconds until a police unit first came within 40 m (-1: never). */
  within40At: number;
  /** Share of the 0.5 s samples with a unit within 60 m. */
  near60: number;
  /** Average number of live units over 150 m away. */
  far: number;
}

/** One flee-bot run at `level` stars (no arrests), for up to `seconds`, or until the stars are lost. */
export function flee(level: number, seed: number, seconds: number, untilLost: boolean): FleeRun {
  seedMathRandom(seed);
  const sim = makeSim({ ambient: true, seed });
  sim.cheats.godMode = true;
  sim.missions.noBust = true;
  const { bot } = getaway(sim, seed);
  sim.wanted.setLevel(level);
  const dt = 1 / 60;
  let lostAt = -1;
  let within40At = -1;
  let samples = 0;
  let near60 = 0;
  let far = 0;
  for (let i = 0, t = 0; t < seconds; i++, t = i * dt) {
    if (lostAt < 0 && sim.wanted.level === 0) {
      lostAt = t;
      if (untilLost) break;
    }
    const pp = sim.playerPos();
    const d = liveUnits(sim).map((v) => dist(v.pos, pp));
    if (within40At < 0 && d.some((x) => x < 40)) within40At = t;
    if (i % 30 === 0) {
      samples++;
      if (d.some((x) => x < 60)) near60++;
      far += d.filter((x) => x > 150).length;
    }
    step(sim, dt, bot());
  }
  vi.restoreAllMocks();
  return { lostAt, within40At, near60: near60 / Math.max(1, samples), far: far / Math.max(1, samples) };
}

export const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
export const showRuns = (runs: FleeRun[]) => runs.map((r, i) => `seed ${FLEE_SEEDS[i]}: lost ${r.lostAt.toFixed(1)} s, within 40 m at ${r.within40At.toFixed(1)} s, near ${(r.near60 * 100).toFixed(0)}%, far ${r.far.toFixed(2)}`).join('; ');
