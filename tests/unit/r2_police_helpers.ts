// Shared scenario helpers for the round 2 police tests (r2_police*.test.ts).

import { vi } from 'vitest';
import { DriverAI } from '../../src/sim/driver';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import type { Lane, Turn } from '../../src/world/roads';
import { LANE_W } from '../../src/world/constants';
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

/** DriverAI internals the flee bot steers with: the planned path and the aim point along it. */
interface PathPriv {
  segs: Array<{ lane: Lane | null; turn: Turn | null; length: number }>;
  s: number;
  blockedTime: number;
  reverseTimer: number;
  limiter: string;
  blockerGap: number;
  pointAhead(dist: number): { x: number; z: number };
  chooseTurn(l: Lane): Turn | null;
  gapBehind(v: Vehicle): number;
}

/**
 * The camera of a player driving `car`: the chase camera behind it, looking where it goes (along its
 * velocity going forward above 6 m/s, else along its heading, as CameraController does). Nothing spawns
 * where the player can see (see Sim.isVisible), so the camera decides where traffic and police units
 * may appear around the bot, as it does in the game.
 */
export function chaseCamera(car: Vehicle): Pick<PlayerInput, 'aimOrigin' | 'aimDir'> {
  const moving = car.speed > 6 && car.forwardSpeed > 0;
  const fx = moving ? car.vel.x / car.speed : Math.sin(car.heading);
  const fz = moving ? car.vel.z / car.speed : Math.cos(car.heading);
  const l = Math.hypot(fx, fz) || 1;
  const k = Math.hypot(1, 0.1);
  return { aimOrigin: { x: car.pos.x - (fx / l) * 8, y: car.pos.y + 3, z: car.pos.z - (fz / l) * 8 }, aimDir: { x: fx / l / k, y: -0.1 / k, z: fz / l / k } };
}

/** Seconds of road ahead over which the flee bot picks its line: what it reaches by then holds it up. */
const FLEE_LOOK = 5;
/** Seconds of closing time the bot keeps from traffic coming the other way along its line. */
const FLEE_ONCOMING = 4.5;
/** A line must let the bot go this much faster (m/s) than the one it is on before it moves over. */
const FLEE_GAIN = 3;
/** How fast (m/s) the bot moves sideways across the road. */
const FLEE_SHIFT = 6;

/**
 * The flee bot: drives the player's car down the lanes flat out, going straight on at every junction
 * where it can and taking the first legal turn where it cannot. A DriverAI does the steering and
 * braking for corners and traffic (without traffic lights); its speed factor of 3 with a cornering
 * figure of 11/9 lifts the lane limits threefold while keeping corners to 11 m/s² (as pursuers take them).
 * Like a human getaway driver it does not queue behind traffic. It picks its line across the whole
 * road, oncoming lanes included, by the speed it can hold over the next FLEE_LOOK seconds: a slower car
 * ahead holds it to that car's speed, a stopped one (a queue at a red light, a police car across the
 * road, someone in the street) to a standstill, and traffic coming the other way rules a line out
 * within FLEE_ONCOMING seconds. It keeps to its own lane when nothing is gained elsewhere and on the
 * way into a turn, and when it stops nose to tail with something it backs up a little to pull round it.
 */
export function fleeBot(sim: Sim, car: Vehicle, maxSpeed = Infinity): ((dt?: number) => PlayerInput) & { ai: DriverAI; offset(): number } {
  const ai = new DriverAI(sim, car, 'flee');
  const priv = ai as unknown as PathPriv;
  priv.chooseTurn = (lane: Lane) => lane.turns.find((t) => t.kind === 'straight') ?? lane.turns.find((t) => t.legal) ?? lane.turns[0] ?? null;
  ai.speedMul = 3;
  ai.cornering = 11 / 9;
  ai.maxSpeed = Math.min(car.spec.maxSpeed, maxSpeed);
  // Its aim point runs `offset` metres to the left of the planned path (right when negative).
  let offset = 0;
  let target = 0;
  /** Seconds left of backing up to pull round what stopped it, the steering for that, and how long it has stood blocked. */
  let backing = 0;
  let backSteer = 0;
  let blocked = 0;
  const along = priv.pointAhead.bind(ai);
  priv.pointAhead = (d: number) => {
    const p = along(d);
    if (offset === 0) return p;
    const q = along(d + 0.5);
    const tx = q.x - p.x;
    const tz = q.z - p.z;
    const l = Math.hypot(tx, tz);
    if (l < 1e-6) return p;
    return { x: p.x + (tz / l) * offset, z: p.z - (tx / l) * offset };
  };
  ai.resetPath();
  const pickLine = () => {
    const seg = priv.segs[0];
    if (!seg) return;
    // The stretch of road the bot is on: its lane, or the lane a straight crossing leads into.
    const lane = seg.lane ?? (seg.turn && seg.turn.kind === 'straight' ? seg.turn.to : null);
    const next = seg.lane ? priv.segs[1] : seg;
    // Into a turn from its own lane: the turn's curve starts there.
    if (!lane || (!!next?.turn && next.turn.kind !== 'straight' && seg.length - priv.s < 15 + car.speed * (0.4 + Math.abs(offset) / FLEE_SHIFT))) {
      target = 0;
      return;
    }
    const fx = lane.dx;
    const fz = lane.dz;
    const lx = fz;
    const lz = -fx;
    // Room across the road, from the lane centre: to the near curb, and over the oncoming lanes to the far one.
    const centre = (lane.index + 0.5) * LANE_W;
    const half = lane.line.width / 2;
    const maxLeft = centre + half - car.halfW - 0.4;
    const maxRight = half - centre - car.halfW - 0.4;
    const own = (car.pos.x - lane.sx) * lx + (car.pos.z - lane.sz) * lz;
    const speed = Math.max(car.speed, 8);
    const cruise = ai.maxSpeed;
    const reach = 20 + speed * 6;
    // What is in or near the road ahead: across the road, how far, its speed our way, and whether it comes at us.
    const obs: Array<{ lat: number; side: number; gap: number; v: number }> = [];
    for (const o of sim.vehicles) {
      if (o === car || o.removed) continue;
      const dx = o.pos.x - car.pos.x;
      const dz = o.pos.z - car.pos.z;
      const a = dx * fx + dz * fz;
      if (a > reach || a < -12) continue;
      const ofx = Math.sin(o.heading);
      const ofz = Math.cos(o.heading);
      const dot = ofx * fx + ofz * fz;
      const v = o.vel.x * fx + o.vel.z * fz;
      // Crossing the road: gone again by the time the bot gets there (the DriverAI brakes for it if not).
      if (Math.abs(dot) < 0.5 && o.speed > 2) continue;
      const extAlong = Math.abs(dot) * o.halfL + Math.abs(ofx * lx + ofz * lz) * o.halfW;
      const extSide = Math.abs(ofx * lx + ofz * lz) * o.halfL + Math.abs(dot) * o.halfW;
      const gap = a - car.halfL - extAlong;
      if (gap < -2 * car.halfL - 1) continue;
      obs.push({ lat: own + dx * lx + dz * lz, side: extSide + 1, gap, v });
    }
    for (const c of sim.characters) {
      if (c.removed || c.state === 'inVehicle' || c.state === 'dead') continue;
      const dx = c.pos.x - car.pos.x;
      const dz = c.pos.z - car.pos.z;
      const a = dx * fx + dz * fz;
      if (a > reach || a < 0) continue;
      obs.push({ lat: own + dx * lx + dz * lz, side: 1.5, gap: a - car.halfL - 0.4, v: 0 });
    }
    // The speed the bot can hold along a line `o` metres left of the lane centre (negative: ruled out).
    const value = (o: number): number => {
      let v = cruise;
      for (const b of obs) {
        if (Math.abs(b.lat - o) > car.halfW + b.side) continue;
        if (b.gap <= 0) return -2;
        if (b.v < -1) {
          if (b.gap / (speed - b.v) < FLEE_ONCOMING) return -1;
          continue;
        }
        if (speed > b.v && b.gap / (speed - b.v) < FLEE_LOOK) v = Math.min(v, Math.max(0, b.v));
      }
      return v;
    };
    // Lines on the road, every metre from curb to curb; leaving its lane costs a little, crossing to the oncoming side more.
    const options: number[] = [0];
    for (let o = 1; o <= maxLeft; o += 1) options.push(o);
    for (let o = -1; o >= -maxRight; o -= 1) options.push(o);
    const cost = (o: number) => Math.abs(o) * (o > centre - car.halfW ? 0.6 : 0.3) + Math.abs(o - offset) * 0.2;
    const now = value(target);
    let best = target;
    let bestV = now;
    for (const o of options) {
      const v = value(o);
      if (v > bestV + 0.5 || (v >= bestV - 0.5 && cost(o) < cost(best))) {
        best = o;
        bestV = v;
      }
    }
    if (best !== target && (bestV > now + FLEE_GAIN || now < 0 || (bestV >= now - 0.5 && cost(best) < cost(target) - 1))) target = best;
  };
  const bot = (dt = 1 / 60) => {
    if (backing > 0) {
      // Backing up a car length to pull round what stopped it.
      backing -= dt;
      if (priv.gapBehind(car) < 1) backing = 0;
      return input({ throttle: 0, brake: 1, steer: backSteer, handbrake: false, ...chaseCamera(car) });
    }
    pickLine();
    const step = FLEE_SHIFT * dt;
    offset = Math.abs(target - offset) <= step ? target : offset + Math.sign(target - offset) * step;
    // Its own line choice replaces the DriverAI's wait-then-overtake.
    priv.blockedTime = 0;
    ai.update(dt);
    // Stopped nose to tail with something while a better line is free: back up with the wheels turned
    // away from that line (in reverse that swings the nose towards it).
    const stuckBehind = car.speed < 1 && priv.reverseTimer <= 0 && priv.limiter === 'obstacle' && priv.blockerGap < 3;
    blocked = stuckBehind ? blocked + dt : 0;
    if (blocked > 0.6 && Math.abs(target - offset) < 0.5 && Math.abs(target) > 0.5 && priv.gapBehind(car) > 2.5) {
      blocked = 0;
      backing = 1.1;
      backSteer = target > 0 ? 1 : -1;
    }
    const c = car.controls;
    return input({ throttle: c.throttle, brake: c.brake, steer: c.steer, handbrake: c.handbrake, ...chaseCamera(car) });
  };
  return Object.assign(bot, { ai, offset: () => offset });
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

/**
 * Seeds of the flee-bot runs: 21 of them. Each run is chaotic (any change to the traffic or the police
 * randomness reshuffles its trajectory), so the tests check medians and shares over all of them, with bounds
 * the measured values clear by a margin.
 */
export const FLEE_SEEDS = Array.from({ length: 21 }, (_, i) => i + 1);

export interface FleeRun {
  seed: number;
  /** Seconds until the stars were lost (-1: never). */
  lostAt: number;
  /** Seconds until a police unit first came within 40 m (-1: never). */
  within40At: number;
  /** Share of the 0.5 s samples with a unit within 60 m. */
  near60: number;
  /** Average number of live units over 150 m away. */
  far: number;
  /** The 0.5 s samples taken while the police were in pursuit (wanted, stars not flashing), how many of them had a unit within 60 m, and the units over 150 m away summed over them. */
  pursuit: { samples: number; near60: number; far: number };
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
  const pursuit = { samples: 0, near60: 0, far: 0 };
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
      const near = d.some((x) => x < 60);
      const away = d.filter((x) => x > 150).length;
      if (near) near60++;
      far += away;
      if (sim.wanted.level > 0 && !sim.wanted.searching) {
        pursuit.samples++;
        if (near) pursuit.near60++;
        pursuit.far += away;
      }
    }
    step(sim, dt, bot());
  }
  vi.restoreAllMocks();
  return { seed, lostAt, within40At, near60: near60 / Math.max(1, samples), far: far / Math.max(1, samples), pursuit };
}

/** Flee-bot runs for every seed in FLEE_SEEDS (see flee). */
export function fleeRuns(level: number, seconds: number, untilLost: boolean): FleeRun[] {
  return FLEE_SEEDS.map((seed) => flee(level, seed, seconds, untilLost));
}

export const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
/** When the stars were lost, Infinity for a run that kept them (runs stop at their bound, which counts as never). */
export const lostTime = (r: FleeRun) => (r.lostAt < 0 ? Infinity : r.lostAt);
export const showRuns = (runs: FleeRun[]) =>
  runs.map((r) => `seed ${r.seed}: lost ${r.lostAt.toFixed(1)} s, within 40 m at ${r.within40At.toFixed(1)} s, near ${(r.near60 * 100).toFixed(0)}%, far ${r.far.toFixed(2)}`).join('; ');
