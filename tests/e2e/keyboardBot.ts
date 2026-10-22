// A Street Run driver that only decides which keys (W, S, A, D, Space) are held. It follows the course along the
// racing lane (the lane nearest the centre line, and the lane each turn leads into), slows for the corners ahead and
// brakes for anything on its line. Pure: the e2e spec feeds it what it reads from the page and presses the keys it
// returns; a unit test feeds it a headless Sim the same way.

import type { StreetRunCourse } from '../../src/sim/streetRuns';
import type { RoadNetwork } from '../../src/world/roads';

export interface PathPoint {
  x: number;
  z: number;
  /** Target speed at this point (m/s). */
  speed: number;
}

export interface BotCar {
  x: number;
  z: number;
  heading: number;
  speed: number;
  /** The front wheels' position, -1..1 (Vehicle.steer). */
  wheel: number;
  halfL: number;
  halfW: number;
  /** VehicleSpec length and steer. */
  length: number;
  steer: number;
}

/** Something to keep clear of: a vehicle (its footprint) or a person (halfL = halfW = radius). */
export interface BotObstacle {
  x: number;
  z: number;
  heading: number;
  halfL: number;
  halfW: number;
  vx: number;
  vz: number;
}

export interface BotKeys {
  KeyW: boolean;
  KeyS: boolean;
  KeyA: boolean;
  KeyD: boolean;
  Space: boolean;
}

export const BOT_KEYS = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space'] as const;

const STRAIGHT_SPEED = 24;
const CORNER_SPEED = 11;
/** Sideways acceleration planned through a corner (m/s²): keyboard steering winds in slowly. */
const CORNER_ACCEL = 5;
/** Planned deceleration for corners and traffic (m/s²), well inside the sports car's brakes. */
const DECEL = 6;

/** The course as a polyline along its racing lane, from the start gate round to just past the finish. */
export function coursePath(roads: RoadNetwork, course: StreetRunCourse): PathPoint[] {
  const nodes = course.nodes;
  const path: PathPoint[] = [];
  const add = (x: number, z: number, speed: number) => {
    const previous = path.at(-1);
    if (!previous) {
      path.push({ x, z, speed });
      return;
    }
    const n = Math.max(1, Math.ceil(Math.hypot(x - previous.x, z - previous.z) / 2));
    for (let i = 1; i <= n; i++) path.push({ x: previous.x + (x - previous.x) * i / n, z: previous.z + (z - previous.z) * i / n, speed });
  };
  let lane = roads.lanesBetween(nodes[0]!, nodes[1]!)[0]!;
  let s = 12;
  add(course.start.x, course.start.z, STRAIGHT_SPEED);
  for (let k = 0; k + 1 < nodes.length; k++) {
    // The last junction is the start's: the finish lies on the first lane again.
    const next = nodes[k + 2] ?? nodes[1]!;
    const lanes = roads.lanesBetween(nodes[k]!, nodes[k + 1]!);
    const kind = roads.turnTowards(lanes[0]!, next)?.kind;
    // Into the lane the turn is legal from (right from the outer lane, left from the inner), easing across mid-block.
    const index = kind === 'right' ? lanes.length - 1 : kind === 'left' ? 0 : lane.index;
    const into = lanes[Math.min(index, lanes.length - 1)]!;
    if (into !== lane) {
      const from = Math.min(lane.length * 0.3, s + 10);
      const to = Math.max(from + 5, Math.min(lane.length - 10, from + 25));
      add(lane.sx + lane.dx * from, lane.sz + lane.dz * from, STRAIGHT_SPEED);
      add(into.sx + into.dx * to, into.sz + into.dz * to, STRAIGHT_SPEED);
      lane = into;
    }
    add(lane.ex, lane.ez, STRAIGHT_SPEED);
    const turn = roads.turnTowards(lane, next);
    if (!turn) throw new Error(`No turn from ${lane.from}->${lane.to} to ${next}`);
    s = 0;
    // A quarter circle: its radius from its length. A right turn hugs the corner, so it is taken slowly.
    const speed = turn.kind === 'straight' ? STRAIGHT_SPEED : Math.max(5, Math.min(CORNER_SPEED, Math.sqrt(CORNER_ACCEL * turn.length / (Math.PI / 2))));
    for (let i = 0; i < turn.pts.length; i += 2) add(turn.pts[i]!, turn.pts[i + 1]!, speed);
    lane = turn.to;
  }
  // Through the finish gate (12 m along the first lane) and on, so it is crossed at speed.
  add(lane.sx + lane.dx * 30, lane.sz + lane.dz * 30, STRAIGHT_SPEED);
  return path;
}

export class KeyboardBot {
  private nearest = 0;

  constructor(readonly path: readonly PathPoint[]) {}

  /** The keys to hold now. */
  decide(car: BotCar, obstacles: readonly BotObstacle[]): BotKeys {
    const path = this.path;
    let best = Infinity;
    for (let i = this.nearest; i < Math.min(path.length, this.nearest + 30); i++) {
      const d = Math.hypot(path[i]!.x - car.x, path[i]!.z - car.z);
      if (d < best) {
        best = d;
        this.nearest = i;
      }
    }
    // Pure pursuit to a point a little ahead on the path.
    let aim = this.nearest;
    let along = 0;
    while (aim + 1 < path.length && along < 7 + car.speed * 0.25) {
      along += Math.hypot(path[aim + 1]!.x - path[aim]!.x, path[aim + 1]!.z - path[aim]!.z);
      aim++;
    }
    const target = path[aim]!;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    const dx = target.x - car.x;
    const dz = target.z - car.z;
    const lateral = dx * -fz + dz * fx;
    const forward = dx * fx + dz * fz;
    const curvature = 2 * lateral / Math.max(1, dx * dx + dz * dz);
    const want = forward < 0 ? Math.sign(lateral) : Math.max(-1, Math.min(1, Math.atan(curvature * car.length * 0.6) / (car.steer / (1 + car.speed / 15))));
    // Keys are on or off: hold one while the wheel is short of where it should be, let go once it is past.
    const band = 0.04;
    const right = want > band && car.wheel < want;
    const left = want < -band && car.wheel > want;

    // Speed: the corners ahead, then whatever stands on the line ahead.
    let speed = Infinity;
    along = 0;
    for (let i = this.nearest; i < path.length && along < 90; i++) {
      if (i > this.nearest) along += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
      speed = Math.min(speed, Math.sqrt(path[i]!.speed ** 2 + 2 * DECEL * Math.max(0, along - 4)));
    }
    // Run wide of the line: slow down to get back onto it rather than drift into the oncoming lanes.
    if (best > 2) speed = Math.min(speed, Math.max(4, 12 - (best - 2) * 3));
    speed = Math.min(speed, this.clearSpeed(car, obstacles));
    const keys: BotKeys = { KeyW: false, KeyS: false, KeyA: left, KeyD: right, Space: false };
    if (car.speed < speed - 0.3) keys.KeyW = true;
    else if (car.speed > speed + 1) keys.KeyS = true;
    return keys;
  }

  /** The speed that stops short of the first obstacle on the path ahead (moving its way, it may be followed). */
  private clearSpeed(car: BotCar, obstacles: readonly BotObstacle[]): number {
    const path = this.path;
    const look = 10 + car.speed * 1.2 + car.speed * car.speed / (2 * DECEL);
    let along = 0;
    for (let i = this.nearest; i + 1 < path.length && along < look; i++) {
      const p = path[i]!;
      const q = path[i + 1]!;
      const step = Math.hypot(q.x - p.x, q.z - p.z);
      const tx = (q.x - p.x) / (step || 1);
      const tz = (q.z - p.z) / (step || 1);
      // Where things will be when the car gets here: a car turning or crossing in front is seen before it arrives.
      const eta = Math.min(2.5, along / Math.max(3, car.speed));
      for (const o of obstacles) {
        if (Math.abs(o.x - p.x) > 30 || Math.abs(o.z - p.z) > 30) continue;
        // The obstacle's footprint as circles along its length, against the car's width on the path.
        const ox = Math.sin(o.heading);
        const oz = Math.cos(o.heading);
        const reach = Math.max(0, o.halfL - o.halfW);
        let hit = false;
        for (const t of [0, eta * 0.5, eta]) {
          const cx = o.x + o.vx * t;
          const cz = o.z + o.vz * t;
          for (const s of [-reach, 0, reach]) {
            // Wider the further ahead it is guessed: a turning car does not keep to a straight line.
            if (Math.hypot(cx + ox * s - p.x, cz + oz * s - p.z) < car.halfW + o.halfW + 0.8 + 0.6 * t) hit = true;
          }
        }
        if (!hit) continue;
        const gap = along - car.halfL - o.halfL - 2.5;
        const follow = Math.max(0, o.vx * tx + o.vz * tz);
        return gap <= 0 ? 0 : Math.sqrt(2 * DECEL * gap) + follow * 0.8;
      }
      along += step;
    }
    return Infinity;
  }
}
