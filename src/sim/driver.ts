// Shared driving brain for AI vehicles: lane following through the road
// network, traffic signals, car following, pursuit and fleeing.

import { clamp, wrapAngle } from '../core/math';
import type { Rng } from '../core/rng';
import { isSolidForSight, makeRayHit } from '../world/colliders';
import { axisOf, type Lane, type RoadNetwork, type Turn } from '../world/roads';
import type { StaticWorld } from '../world/staticWorld';
import type { Character, Vehicle } from './entities';

export type DriverPolicy = 'traffic' | 'chase' | 'flee' | 'route';

export interface DriverHost {
  world: StaticWorld;
  roads: RoadNetwork;
  vehicles: Vehicle[];
  characters: Character[];
  time: number;
  rng: Rng;
  onHorn(v: Vehicle): void;
}

interface PathSeg {
  pts: Float64Array;
  cum: Float64Array;
  length: number;
  lane: Lane | null;
  turn: Turn | null;
  speed: number;
}

const hit = makeRayHit();

function laneSeg(lane: Lane, fromS = 0): PathSeg {
  const s0 = clamp(fromS, 0, lane.length);
  const pts = new Float64Array([lane.sx + lane.dx * s0, lane.sz + lane.dz * s0, lane.ex, lane.ez]);
  const len = lane.length - s0;
  return { pts, cum: new Float64Array([0, len]), length: len, lane, turn: null, speed: lane.speedLimit };
}

function turnSeg(turn: Turn, lateralAccel: number): PathSeg {
  const n = turn.pts.length / 2;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1]! + Math.hypot(turn.pts[i * 2]! - turn.pts[i * 2 - 2]!, turn.pts[i * 2 + 1]! - turn.pts[i * 2 - 1]!);
  }
  let speed = Math.min(turn.from.speedLimit, turn.to.speedLimit);
  if (turn.kind !== 'straight') {
    const radius = turn.length / (Math.PI / 2);
    speed = Math.min(speed, Math.sqrt(lateralAccel * radius));
  }
  return { pts: turn.pts, cum, length: turn.length, lane: null, turn, speed };
}

export class DriverAI {
  policy: DriverPolicy;
  private segs: PathSeg[] = [];
  private s = 0;
  /** Cruise speed multiplier relative to the road limit. */
  speedMul: number;
  /** Absolute speed cap. */
  maxSpeed: number;
  obeyLights: boolean;
  /** Lateral acceleration used to pick cornering speeds. */
  cornering: number;
  /** Comfortable deceleration for planning. */
  decel: number;
  /** Chase / flee subject. */
  target: Character | Vehicle | null = null;
  /** Fixed destination for the route policy. */
  dest: { x: number; z: number } | null = null;
  /** Pursuit: drive straight at the target when close and visible. */
  direct = false;
  /** Stop and hold position (e.g. police deploying). */
  hold = false;
  private reverseTimer = 0;
  private reverseSteer = 0;
  private stuck = 0;
  private waitObstacle = 0;
  private honkCooldown = 0;
  private sightTimer = 0;
  private visibleTarget = false;
  arrived = false;
  /** Debug/telemetry: why the car is slowing down. */
  limiter: 'none' | 'light' | 'obstacle' | 'turn' | 'yield' = 'none';

  constructor(
    private readonly host: DriverHost,
    readonly vehicle: Vehicle,
    policy: DriverPolicy,
  ) {
    this.policy = policy;
    this.speedMul = 1;
    this.maxSpeed = 1;
    this.obeyLights = true;
    this.cornering = 4.5;
    this.decel = 4.5;
    this.setPolicy(policy);
    this.resetPath();
  }

  /** Switches behaviour (e.g. a patrol car joining a pursuit) and its driving style. */
  setPolicy(policy: DriverPolicy): void {
    this.policy = policy;
    const aggressive = policy === 'chase' || policy === 'flee';
    const spec = this.vehicle.spec;
    this.speedMul = policy === 'chase' ? 1.6 : policy === 'flee' ? 1.45 : this.host.rng.range(0.85, 1.05);
    this.maxSpeed = aggressive ? spec.maxSpeed * 0.92 : spec.maxSpeed * 0.6;
    this.obeyLights = !aggressive;
    this.cornering = aggressive ? 11 : 4.5;
    this.decel = aggressive ? 9 : 4.5;
    this.direct = false;
  }

  /** Snap onto the nearest lane in the vehicle's travel direction. */
  resetPath(): void {
    const v = this.vehicle;
    const { lane, s } = this.host.roads.nearestLane(v.pos.x, v.pos.z, v.heading);
    this.segs = [laneSeg(lane, s)];
    this.s = 0;
    this.extend();
  }

  /** Place on a specific lane (used when spawning traffic). */
  setLane(lane: Lane, s: number): void {
    this.segs = [laneSeg(lane, s)];
    this.s = 0;
    this.extend();
  }

  currentLane(): Lane | null {
    return this.segs[0]?.lane ?? null;
  }

  private remaining(): number {
    let r = -this.s;
    for (const seg of this.segs) r += seg.length;
    return r;
  }

  private extend(): void {
    let guard = 0;
    while (this.remaining() < 70 && guard++ < 8) {
      const last = this.segs[this.segs.length - 1]!;
      if (last.turn) {
        this.segs.push(laneSeg(last.turn.to));
      } else if (last.lane) {
        const turn = this.chooseTurn(last.lane);
        if (!turn) break;
        this.segs.push(turnSeg(turn, this.cornering));
      } else break;
    }
  }

  private targetPos(): { x: number; z: number } | null {
    if (this.dest) return this.dest;
    const t = this.target;
    if (!t) return null;
    if ('kind' in t) return t.pos;
    return t.vehicle ? t.vehicle.pos : t.pos;
  }

  private chooseTurn(lane: Lane): Turn | null {
    const turns = lane.turns;
    if (turns.length === 0) return null;
    const rng = this.host.rng;
    const roads = this.host.roads;
    if (this.policy === 'chase' || this.policy === 'route') {
      const tp = this.targetPos();
      if (tp) {
        const goal = roads.nearestNode(tp.x, tp.z);
        if (goal.id === lane.to) {
          if (this.policy === 'route') this.arrived = true;
        } else {
          const route = roads.findRoute(lane.to, goal.id);
          if (route && route.length > 1) {
            const t = roads.turnTowards(lane, route[1]!);
            if (t && (this.policy === 'chase' || t.legal)) return t;
          }
        }
      }
    }
    if (this.policy === 'flee') {
      const tp = this.targetPos();
      if (tp) {
        let best: Turn | null = null;
        let bestScore = -Infinity;
        for (const t of turns) {
          const node = roads.nodes[t.to.to]!;
          const score = Math.hypot(node.x - tp.x, node.z - tp.z) + rng.range(0, 60);
          if (score > bestScore) {
            bestScore = score;
            best = t;
          }
        }
        if (best) return best;
      }
    }
    const legal = turns.filter((t) => t.legal);
    const pool = legal.length > 0 ? legal : turns;
    const weights = pool.map((t) => [t, t.kind === 'straight' ? 3 : 1.4] as const);
    return rng.weighted(weights);
  }

  /** Projects the vehicle onto the current path and advances the cursor. */
  private track(): void {
    const v = this.vehicle;
    let guard = 0;
    while (this.segs.length > 0 && guard++ < 6) {
      const seg = this.segs[0]!;
      const proj = projectOnSeg(seg, v.pos.x, v.pos.z);
      this.s = Math.max(this.s, proj.s);
      if (proj.dist > 18) {
        this.resetPath();
        return;
      }
      if (this.s >= seg.length - 0.05) {
        this.s -= seg.length;
        this.segs.shift();
        if (this.segs.length === 0) {
          this.resetPath();
          return;
        }
        this.extend();
      } else break;
    }
  }

  private pointAhead(dist: number): { x: number; z: number } {
    let d = this.s + dist;
    for (const seg of this.segs) {
      if (d <= seg.length) return pointOnSeg(seg, d);
      d -= seg.length;
    }
    const last = this.segs[this.segs.length - 1]!;
    return pointOnSeg(last, last.length);
  }

  update(dt: number): void {
    const v = this.vehicle;
    const c = v.controls;
    if (!v.drivable || !v.driver) {
      c.throttle = 0;
      c.brake = 0;
      c.steer = 0;
      c.handbrake = true;
      return;
    }
    this.honkCooldown -= dt;
    this.limiter = 'none';

    if (this.hold) {
      c.throttle = 0;
      c.brake = 0;
      c.steer = 0;
      c.handbrake = true;
      return;
    }

    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      c.throttle = 0;
      c.brake = 1;
      c.handbrake = false;
      c.steer = this.reverseSteer;
      if (this.reverseTimer <= 0) {
        this.stuck = 0;
        this.resetPath();
      }
      return;
    }

    // Decide whether to drive straight at a pursuit target.
    const tp = this.targetPos();
    if (this.policy === 'chase' && tp) {
      this.sightTimer -= dt;
      if (this.sightTimer <= 0) {
        this.sightTimer = 0.35;
        const d = Math.hypot(tp.x - v.pos.x, tp.z - v.pos.z);
        this.visibleTarget = d < 70 && this.host.world.lineOfSight(v.pos.x, v.pos.y + 1.2, v.pos.z, tp.x, v.pos.y + 1.2, tp.z);
        const wasDirect = this.direct;
        this.direct = this.visibleTarget && d < 55;
        if (wasDirect && !this.direct) this.resetPath();
      }
    } else {
      this.direct = false;
    }

    let aimX: number;
    let aimZ: number;
    let targetSpeed: number;
    const speed = v.forwardSpeed;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);

    if (this.direct && tp) {
      const t = this.target;
      let lead = 0;
      let tvx = 0;
      let tvz = 0;
      if (t) {
        if ('kind' in t) {
          tvx = t.vel.x;
          tvz = t.vel.z;
        } else if (t.vehicle) {
          tvx = t.vehicle.vel.x;
          tvz = t.vehicle.vel.z;
        } else {
          tvx = t.vel.x;
          tvz = t.vel.z;
        }
        lead = clamp(Math.hypot(tp.x - v.pos.x, tp.z - v.pos.z) / 25, 0, 1.2);
      }
      aimX = tp.x + tvx * lead;
      aimZ = tp.z + tvz * lead;
      targetSpeed = this.maxSpeed;
      // Feeler rays to steer around buildings.
      const avoid = this.feelers(v, aimX, aimZ);
      aimX = avoid.x;
      aimZ = avoid.z;
      const dToT = Math.hypot(tp.x - v.pos.x, tp.z - v.pos.z);
      const targetOnFoot = !!t && !('kind' in t) && !t.vehicle;
      if (targetOnFoot) targetSpeed = Math.min(targetSpeed, Math.max(0, (dToT - 10) * 0.9));
    } else {
      this.track();
      if (this.segs.length === 0) return;
      const look = 4.5 + Math.abs(speed) * 0.42;
      const p = this.pointAhead(look);
      aimX = p.x;
      aimZ = p.z;
      targetSpeed = Math.min(this.segs[0]!.speed * this.speedMul, this.maxSpeed);
      targetSpeed = Math.min(targetSpeed, this.planSpeed());
    }

    // Obstacles ahead (vehicles and pedestrians).
    const gap = this.scanAhead(v, aimX, aimZ);
    if (gap < Infinity) {
      const stopGap = Math.max(0, gap - 2.2);
      const vs = Math.sqrt(2 * this.decel * stopGap);
      if (vs < targetSpeed) {
        targetSpeed = vs;
        this.limiter = 'obstacle';
      }
    }

    // Pure pursuit steering.
    const rx = -fz;
    const rz = fx;
    const dx = aimX - v.pos.x;
    const dz = aimZ - v.pos.z;
    const lx = dx * rx + dz * rz;
    const lz = dx * fx + dz * fz;
    const L2 = Math.max(1, lx * lx + lz * lz);
    const curvature = (2 * lx) / L2;
    const wheelbase = v.spec.length * 0.6;
    const maxSteer = v.spec.steer / (1 + Math.abs(speed) / 15);
    let steer = Math.atan(curvature * wheelbase) / maxSteer;
    if (lz < 0) steer = lx >= 0 ? 1 : -1;
    c.steer = clamp(steer, -1, 1);

    // Longitudinal control.
    const err = targetSpeed - speed;
    c.handbrake = false;
    if (targetSpeed < 0.3 && Math.abs(speed) < 0.6) {
      c.throttle = 0;
      c.brake = 0;
      c.handbrake = true;
    } else if (err > 0.3) {
      c.throttle = clamp(err * 0.4 + 0.2, 0, 1);
      c.brake = 0;
    } else if (err < -0.8) {
      c.throttle = 0;
      c.brake = speed > 0.5 ? clamp(-err * 0.3, 0.15, 1) : 0;
      if (speed <= 0.5) c.handbrake = true;
    } else {
      c.throttle = targetSpeed > 1 ? 0.15 : 0;
      c.brake = 0;
    }
    if (lz < 0 && speed > 6) {
      // Target behind at speed: brake and turn.
      c.throttle = 0;
      c.brake = 0.6;
    }

    // Stuck handling.
    const wantsToMove = targetSpeed > 2;
    if (wantsToMove && Math.abs(speed) < 0.7) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.limiter === 'obstacle' && Math.abs(speed) < 0.5) {
      this.waitObstacle += dt;
      if (this.waitObstacle > 2.5 && this.honkCooldown <= 0 && this.policy === 'traffic') {
        this.honkCooldown = this.host.rng.range(2.5, 6);
        this.host.onHorn(v);
      }
      if (this.waitObstacle > 9) {
        this.waitObstacle = 0;
        this.startReverse(lx);
      }
    } else {
      this.waitObstacle = Math.max(0, this.waitObstacle - dt);
    }
    if (this.stuck > (this.policy === 'chase' ? 1.1 : 1.8)) this.startReverse(lx);
    v.stuckTime = this.stuck + this.waitObstacle;
  }

  private startReverse(lx: number): void {
    this.reverseTimer = this.policy === 'chase' ? 1.0 : 1.4;
    // Back up with the wheels turned away from where we want to go.
    this.reverseSteer = lx >= 0 ? -1 : 1;
    this.stuck = 0;
  }

  /** Speed limit from upcoming turns and signals along the planned path. */
  private planSpeed(): number {
    let limit = Infinity;
    let dist = -this.s;
    const v = this.vehicle;
    const speed = Math.abs(v.forwardSpeed);
    for (let i = 0; i < this.segs.length; i++) {
      const seg = this.segs[i]!;
      if (i > 0 || seg.turn) {
        const d = Math.max(0, dist);
        const vs = Math.sqrt(seg.speed * this.speedMul * seg.speed * this.speedMul + 2 * this.decel * d);
        if (vs < limit) {
          limit = vs;
          if (vs < this.maxSpeed) this.limiter = 'turn';
        }
      }
      // Signal at the end of a lane, guarding the next turn.
      if (seg.lane && i + 1 < this.segs.length && this.obeyLights) {
        const next = this.segs[i + 1]!;
        const stopDist = dist + seg.length;
        if (stopDist > -0.5 && stopDist < 80) {
          const state = this.host.roads.signalState(seg.lane.to, axisOf(seg.lane.dir), this.host.time);
          let mustStop = state === 'red' || (state === 'yellow' && stopDist > (speed * speed) / (2 * 7) + 1);
          if (!mustStop && next.turn && next.turn.kind === 'left' && stopDist < 30 && this.oncoming(seg.lane)) {
            mustStop = true;
            this.limiter = 'yield';
          }
          if (mustStop && stopDist > -0.5) {
            const vs = Math.sqrt(2 * this.decel * Math.max(0, stopDist - 0.8));
            if (vs < limit) {
              limit = vs;
              if (this.limiter !== 'yield') this.limiter = 'light';
            }
          }
        }
      }
      dist += seg.length;
      if (dist > 90) break;
    }
    return limit;
  }

  /** True if oncoming traffic is about to cross a left turn at the end of `lane`. */
  private oncoming(lane: Lane): boolean {
    const node = this.host.roads.nodes[lane.to]!;
    const self = this.vehicle;
    for (const o of this.host.vehicles) {
      if (o === self || o.removed || o.speed < 1.5) continue;
      const dx = node.x - o.pos.x;
      const dz = node.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 38) continue;
      // Heading towards the node, roughly opposite to us.
      const ofx = Math.sin(o.heading);
      const ofz = Math.cos(o.heading);
      if (ofx * lane.dx + ofz * lane.dz > -0.7) continue;
      if ((dx * o.vel.x + dz * o.vel.z) / (d || 1) < 1) continue;
      return true;
    }
    return false;
  }

  /** Distance to the nearest obstacle in a corridor towards the aim point. */
  private scanAhead(v: Vehicle, aimX: number, aimZ: number): number {
    const dx = aimX - v.pos.x;
    const dz = aimZ - v.pos.z;
    const dl = Math.hypot(dx, dz) || 1;
    // Blend car heading (near field) with path direction (far field).
    const hx = Math.sin(v.heading);
    const hz = Math.cos(v.heading);
    let fx = hx * 0.5 + (dx / dl) * 0.5;
    let fz = hz * 0.5 + (dz / dl) * 0.5;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const rx = -fz;
    const rz = fx;
    const range = 7 + Math.abs(v.forwardSpeed) * 1.7;
    let best = Infinity;
    for (const o of this.host.vehicles) {
      if (o === v || o.removed) continue;
      if (this.policy === 'chase' && this.target && (o === this.target || ('kind' in this.target ? false : o === this.target.vehicle))) continue;
      const ox = o.pos.x - v.pos.x;
      const oz = o.pos.z - v.pos.z;
      const along = ox * fx + oz * fz;
      if (along <= 0 || along > range + 6) continue;
      const ofx = Math.sin(o.heading);
      const ofz = Math.cos(o.heading);
      const extAlong = Math.abs(ofx * fx + ofz * fz) * o.halfL + Math.abs(ofx * rx + ofz * rz) * o.halfW;
      const extSide = Math.abs(ofx * rx + ofz * rz) * o.halfL + Math.abs(ofx * fx + ofz * fz) * o.halfW;
      const lat = Math.abs(ox * rx + oz * rz);
      if (lat > v.halfW + extSide + 0.5) continue;
      const gap = along - v.halfL - extAlong;
      if (gap < best) best = gap;
    }
    for (const ch of this.host.characters) {
      if (ch.removed || !ch.onFoot || ch.state === 'swimming') continue;
      const ox = ch.pos.x - v.pos.x;
      const oz = ch.pos.z - v.pos.z;
      const along = ox * fx + oz * fz;
      if (along <= 0 || along > range) continue;
      if (Math.abs(ox * rx + oz * rz) > v.halfW + 0.9) continue;
      if (this.policy === 'chase' && this.target === ch) continue;
      const gap = along - v.halfL - 0.4;
      if (gap < best) best = gap;
    }
    return best;
  }

  /** Steers the aim point away from buildings using three feeler rays. */
  private feelers(v: Vehicle, aimX: number, aimZ: number): { x: number; z: number } {
    const world = this.host.world;
    const base = Math.atan2(aimX - v.pos.x, aimZ - v.pos.z);
    const len = 8 + Math.abs(v.forwardSpeed) * 0.7;
    const y = v.pos.y + 0.8;
    const ray = (ang: number) => {
      const dx = Math.sin(ang);
      const dz = Math.cos(ang);
      return world.grid.raycast(v.pos.x, y, v.pos.z, dx, 0, dz, len, hit, isSolidForSight) ? hit.t : len;
    };
    const center = ray(base);
    if (center >= len) return { x: aimX, z: aimZ };
    const left = ray(base + 0.55);
    const right = ray(base - 0.55);
    const ang = wrapAngle(left > right ? base + 0.75 : base - 0.75);
    return { x: v.pos.x + Math.sin(ang) * 20, z: v.pos.z + Math.cos(ang) * 20 };
  }
}

function projectOnSeg(seg: PathSeg, x: number, z: number): { s: number; dist: number } {
  const p = seg.pts;
  let bestS = 0;
  let bestD = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i]!;
    const az = p[i + 1]!;
    const bx = p[i + 2]!;
    const bz = p[i + 3]!;
    const abx = bx - ax;
    const abz = bz - az;
    const l2 = abx * abx + abz * abz;
    let t = l2 > 1e-9 ? ((x - ax) * abx + (z - az) * abz) / l2 : 0;
    t = clamp(t, 0, 1);
    const qx = ax + abx * t;
    const qz = az + abz * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < bestD) {
      bestD = d;
      bestS = seg.cum[i / 2]! + Math.sqrt(l2) * t;
    }
  }
  return { s: bestS, dist: bestD };
}

function pointOnSeg(seg: PathSeg, s: number): { x: number; z: number } {
  const p = seg.pts;
  const cum = seg.cum;
  const n = cum.length;
  if (s <= 0) return { x: p[0]!, z: p[1]! };
  for (let i = 1; i < n; i++) {
    if (s <= cum[i]!) {
      const t = (s - cum[i - 1]!) / Math.max(1e-9, cum[i]! - cum[i - 1]!);
      return { x: p[(i - 1) * 2]! + (p[i * 2]! - p[(i - 1) * 2]!) * t, z: p[(i - 1) * 2 + 1]! + (p[i * 2 + 1]! - p[(i - 1) * 2 + 1]!) * t };
    }
  }
  return { x: p[(n - 1) * 2]!, z: p[(n - 1) * 2 + 1]! };
}
