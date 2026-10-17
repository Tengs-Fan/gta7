// Shared driving brain for AI vehicles: lane following through the road
// network, traffic signals, car following, pursuit and fleeing.

import { clamp, pointSegDist, wrapAngle } from '../core/math';
import type { Rng } from '../core/rng';
import { isSolidForSight, makeRayHit } from '../world/colliders';
import { axisOf, type Lane, type RoadNetwork, type Turn } from '../world/roads';
import type { StaticWorld } from '../world/staticWorld';
import type { Character, Vehicle } from './entities';
import type { VehicleSpec } from './specs';
import { ENGINE_BRAKE } from './vehiclePhysics';

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

/** The front bumper stops this far before the lane end, just behind the painted stop line. */
const STOP_MARGIN = 0.9;
/** Slowest planned cornering speed (below the 3.5 m/s at which street furniture breaks). */
const CRAWL_SPEED = 2.5;
/** AI reversing speed, also below the furniture-breaking speed. */
const REVERSE_SPEED = 3;
/** A hold that is not asserted again expires after this many seconds. */
const HOLD_TIMEOUT = 4;
/** A queue that has not moved for this long is handled like any other blockage (jams, cycles). */
const QUEUE_PATIENCE = 40;

const hit = makeRayHit();

function laneSeg(lane: Lane, fromS = 0): PathSeg {
  const s0 = clamp(fromS, 0, lane.length);
  const pts = new Float64Array([lane.sx + lane.dx * s0, lane.sz + lane.dz * s0, lane.ex, lane.ez]);
  const len = lane.length - s0;
  return { pts, cum: new Float64Array([0, len]), length: len, lane, turn: null, speed: lane.speedLimit };
}

/** Mean radius of a turn curve (a quarter circle of the same length). */
function turnRadius(turn: Turn): number {
  return turn.length / (Math.PI / 2);
}

/** Highest speed at which full steering lock still follows a curve of `radius` (vehiclePhysics' bicycle model). */
function steerSpeed(spec: VehicleSpec, radius: number): number {
  return 15 * (spec.steer / Math.atan((spec.length * 0.6) / radius) - 1);
}

function turnSeg(turn: Turn, lateralAccel: number, spec: VehicleSpec | null): PathSeg {
  const n = turn.pts.length / 2;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1]! + Math.hypot(turn.pts[i * 2]! - turn.pts[i * 2 - 2]!, turn.pts[i * 2 + 1]! - turn.pts[i * 2 - 1]!);
  }
  let speed = Math.min(turn.from.speedLimit, turn.to.speedLimit);
  if (turn.kind !== 'straight') {
    const radius = turnRadius(turn);
    speed = Math.min(speed, Math.sqrt(lateralAccel * radius));
    // Long vehicles cannot steer a tight curve at speed: slow down to what the steering allows.
    if (spec) speed = Math.min(speed, Math.max(CRAWL_SPEED, steerSpeed(spec, radius)));
  }
  return { pts: turn.pts, cum, length: turn.length, lane: null, turn, speed };
}

export class DriverAI {
  policy: DriverPolicy;
  private segs: PathSeg[] = [];
  private s = 0;
  /** Distance of the vehicle from its planned path (Infinity when not following one). */
  private pathOffset = Infinity;
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
  private holdUntil = -Infinity;
  private reverseTimer = 0;
  private reverseSteer = 0;
  private stuck = 0;
  private waitObstacle = 0;
  private honkCooldown = 0;
  private sightTimer = 0;
  private visibleTarget = false;
  arrived = false;
  /** Lane whose signal we committed to stop for (prevents yellow-light dithering). */
  private stopLane = -1;
  /** Seconds an overtaking manoeuvre may still last (path shifted into the oncoming lane). */
  private overtake = 0;
  /** What we are overtaking; the manoeuvre ends once it is behind us. */
  private passing: Vehicle | Character | null = null;
  private blockedTime = 0;
  /** Seconds spent stopped in a queue (see queuedBehind). */
  private queueTime = 0;
  /** What scanAhead found closest ahead this frame, and its bumper gap. */
  private blocker: Vehicle | Character | null = null;
  private blockerGap = Infinity;
  /** Distance from the front bumper to the stop line of a red light or a yield on the path, if any. */
  private waitLine = Infinity;
  /** Last place the vehicle made real progress from (see trackProgress). */
  private progressX: number;
  private progressZ: number;
  private idle = 0;
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
    this.progressX = vehicle.pos.x;
    this.progressZ = vehicle.pos.z;
    this.setPolicy(policy);
    this.resetPath();
  }

  /**
   * Stop and hold position (e.g. while someone climbs in). Expires unless asserted again, so a
   * hold whose owner went away (the player died or was busted mid-entry) cannot freeze the car.
   */
  get hold(): boolean {
    return this.host.time < this.holdUntil;
  }

  set hold(on: boolean) {
    this.holdUntil = on ? this.host.time + HOLD_TIMEOUT : -Infinity;
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
        this.segs.push(turnSeg(turn, this.cornering, this.obeyLights ? this.vehicle.spec : null));
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
    let pool = legal.length > 0 ? legal : turns;
    // Skip turns tighter than the vehicle can steer (a bus into a side street) when it can go elsewhere.
    const steerable = pool.filter((t) => t.kind === 'straight' || steerSpeed(this.vehicle.spec, turnRadius(t)) >= CRAWL_SPEED);
    if (steerable.length > 0) pool = steerable;
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
      this.pathOffset = proj.dist;
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
    // Lanes can be longer than the planning horizon: keep it topped up so the signal and the
    // turn at the end of the lane are planned for before the car gets there.
    this.extend();
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

  /**
   * Steering look-ahead. The normal one cuts the inside of tight turns (corner signal poles,
   * curbs), so civilians aim closer once a curved turn is in reach. Pursuers keep their wide,
   * fast line. Obstacles are still scanned along the normal look-ahead.
   */
  private steerLook(speed: number, look: number): number {
    if (!this.obeyLights) return look;
    let d = -this.s;
    for (const seg of this.segs) {
      if (d > look) break;
      if (seg.turn && seg.turn.kind !== 'straight') return 2.5 + Math.abs(speed) * 0.2;
      d += seg.length;
    }
    return look;
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
    this.blocker = null;
    this.waitLine = Infinity;
    this.pathOffset = Infinity;

    if (this.hold) {
      c.throttle = 0;
      c.brake = 0;
      c.steer = 0;
      c.handbrake = true;
      this.trackProgress(dt, true);
      return;
    }

    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      c.throttle = 0;
      c.handbrake = false;
      c.steer = this.reverseSteer;
      // Back up slowly, and stop short of whatever is behind (pursuers use all the room there is).
      c.brake = clamp((REVERSE_SPEED + v.forwardSpeed) * 0.8, 0, 1);
      if (this.gapBehind(v) < (this.obeyLights ? 1.2 : 0.5)) this.reverseTimer = 0;
      // Backing up to overtake only needs room to swing out.
      const p = this.passing;
      if (p && (p.pos.x - v.pos.x) * Math.sin(v.heading) + (p.pos.z - v.pos.z) * Math.cos(v.heading) - v.halfL - ('kind' in p ? p.halfL : 0.4) > 4.5) {
        this.reverseTimer = 0;
      }
      if (this.reverseTimer <= 0) {
        this.stuck = 0;
        this.resetPath();
      }
      this.trackProgress(dt, false);
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
    let steerX: number;
    let steerZ: number;
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
      steerX = aimX;
      steerZ = aimZ;
    } else {
      this.track();
      if (this.segs.length === 0) return;
      const look = 4.5 + Math.abs(speed) * 0.42;
      const p = this.pointAhead(look);
      aimX = p.x;
      aimZ = p.z;
      if (this.overtake > 0) {
        // Swing out to the left (into the oncoming lane) to pass whatever blocks us.
        const q = this.pointAhead(look + 2);
        const tx = q.x - p.x;
        const tz = q.z - p.z;
        const tl = Math.hypot(tx, tz) || 1;
        const lx2 = tz / tl;
        const lz2 = -tx / tl;
        aimX += lx2 * 4.2;
        aimZ += lz2 * 4.2;
      }
      steerX = aimX;
      steerZ = aimZ;
      const near = this.overtake > 0 ? look : this.steerLook(speed, look);
      if (near < look) {
        const q = this.pointAhead(near);
        steerX = q.x;
        steerZ = q.z;
      }
      targetSpeed = Math.min(this.segs[0]!.speed * this.speedMul, this.maxSpeed);
      targetSpeed = Math.min(targetSpeed, this.planSpeed());
    }

    // Obstacles ahead (vehicles and pedestrians).
    if (this.overtake > 0) {
      this.overtake -= dt;
      // Pull back in as soon as we are past, instead of lingering in the oncoming lane.
      if (!this.direct && !this.stillPassing()) this.overtake = 0;
      if (this.overtake <= 0) this.passing = null;
    }
    const gap = this.scanAhead(v, aimX, aimZ);
    if (gap < Infinity) {
      const stopGap = Math.max(0, gap - 2.2);
      const vs = Math.sqrt(2 * this.decel * stopGap);
      if (vs < targetSpeed) {
        targetSpeed = vs;
        this.limiter = 'obstacle';
      }
    }
    const blocked = this.limiter === 'obstacle';
    // Waiting in line at a light is not a blockage: no horn, no overtaking, no reversing.
    // A queue that does not move for a long time is handled like any other blockage, though.
    const queued = blocked && this.queuedBehind();
    if (queued && Math.abs(speed) < 0.5) this.queueTime += dt;
    else if (!queued || Math.abs(speed) > 1.5) this.queueTime = 0;
    const waiting = queued && this.queueTime < QUEUE_PATIENCE;
    // Pursuers go around traffic quickly; civilians only around long-term blockages.
    if (blocked && !waiting && Math.abs(speed) < 3 && !this.direct) this.blockedTime += dt;
    else this.blockedTime = Math.max(0, this.blockedTime - dt * 2);
    const patience = this.policy === 'chase' || this.policy === 'flee' ? 0.9 : 7;
    let backUpToPass = false;
    // Civilians wait for a gap in oncoming traffic before pulling out.
    if (blocked && this.blockedTime > patience && this.overtake <= 0 && !(this.obeyLights && this.oncomingInPassingLane())) {
      this.overtake = this.obeyLights ? 8 : 6;
      this.passing = this.blocker;
      this.blockedTime = 0;
      this.waitObstacle = 0;
      // Stopped close behind the blocker, the car cannot swing out (the blocker stays in the
      // scan corridor): back up first, wheels right, which turns the nose towards the passing lane.
      backUpToPass = gap < 5;
    }

    // Pure pursuit steering.
    const rx = -fz;
    const rz = fx;
    const dx = steerX - v.pos.x;
    const dz = steerZ - v.pos.z;
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
      // Pressing the brake replaces engine braking in the physics, so start from the force that
      // matches coasting and ramp up from there: no jump, no flickering brake lights.
      c.brake = speed > 0.5 ? clamp(ENGINE_BRAKE / v.spec.brake + (-err - 0.8) * 0.5, 0, 1) : 0;
      if (speed <= 0.5) c.handbrake = true;
    } else {
      // Hold: throttle in proportion to the shortfall and none above the target; engine braking
      // trims small overspeed without touching the brakes.
      c.throttle = targetSpeed > 1 ? clamp(err, 0, 0.3) : 0;
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
    if (blocked && !waiting && Math.abs(speed) < 0.5) {
      this.waitObstacle += dt;
      if (this.waitObstacle > 2.5 && this.honkCooldown <= 0 && this.policy === 'traffic') {
        this.honkCooldown = this.host.rng.range(2.5, 6);
        this.host.onHorn(v);
      }
      if (this.waitObstacle > 9) {
        // Make room, nose towards the passing side (not the curb).
        this.waitObstacle = 0;
        this.startReverse(1);
      }
    } else {
      this.waitObstacle = Math.max(0, this.waitObstacle - dt);
    }
    // Back up with the wheels turned away from where we want to go.
    if (backUpToPass) this.startReverse(1, 1.2);
    else if (this.stuck > (this.policy === 'chase' ? 1.1 : 1.8)) this.startReverse(lx >= 0 ? -1 : 1);
    this.trackProgress(dt, waiting || (!blocked && this.waitLine < Infinity));
  }

  private startReverse(steer: number, time = this.policy === 'chase' ? 1.0 : 1.4): void {
    this.reverseTimer = time;
    this.reverseSteer = steer;
    this.stuck = 0;
  }

  /**
   * Time since the vehicle last got 5 m from where it was (v.stuckTime, used to clear away stuck
   * traffic). Back-and-forth manoeuvres do not reset it; waiting at a light does not count.
   */
  private trackProgress(dt: number, excused: boolean): void {
    const v = this.vehicle;
    if (Math.hypot(v.pos.x - this.progressX, v.pos.z - this.progressZ) > 5) {
      this.progressX = v.pos.x;
      this.progressZ = v.pos.z;
      this.idle = 0;
    } else if (!excused) {
      this.idle += dt;
    }
    v.stuckTime = this.idle;
  }

  /**
   * True if the car blocking us is waiting at a light or yielding, directly or through the cars in
   * front of it. Worked out afresh every frame, so no stale flag can keep a jam or a cycle "queued".
   */
  private queuedBehind(): boolean {
    if (!this.obeyLights) return false;
    const fx = Math.sin(this.vehicle.heading);
    const fz = Math.cos(this.vehicle.heading);
    let ai: DriverAI = this;
    for (let hops = 0; hops < 12; hops++) {
      const b = ai.blocker;
      if (!b || b.removed) return false;
      // The car ahead waits for someone to get out of the road; we are only held up by a person
      // ourselves when they are on the crossing in front of a red light.
      if (!('kind' in b)) return ai !== this || ai.waitLine < ai.blockerGap + 5;
      // Only cars lined up our way form a queue (not one across the road or nose to nose).
      if (Math.sin(b.heading) * fx + Math.cos(b.heading) * fz < 0.7) return false;
      if (b.forwardSpeed > 1) return true;
      const next = b.ai && b.driver && b.driver.alive && !b.driver.isPlayer && !b.ai.hold ? b.ai : null;
      // The player's car, or one nobody drives, counts when it stands at our stop line.
      if (!next) return ai.waitLine < ai.blockerGap + 2 * b.halfL + 3;
      if (next.limiter === 'light' || next.limiter === 'yield') return true;
      if (next.limiter !== 'obstacle') return false;
      ai = next;
    }
    return false;
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
          const committed = this.stopLane === seg.lane.id;
          // stopDist is measured from the vehicle centre; signals stop the front bumper at the line.
          const lineGap = stopDist - v.halfL - STOP_MARGIN;
          let mustStop = state === 'red' || (state === 'yellow' && (committed || lineGap > (speed * speed) / (2 * 7) + 1));
          const forSignal = mustStop;
          // Once we decide to stop for a light we stay stopped until it turns green.
          if (state === 'green') {
            if (committed) this.stopLane = -1;
          } else if (mustStop && i === 0) {
            this.stopLane = seg.lane.id;
          }
          if (!mustStop && next.turn && next.turn.kind === 'left' && stopDist < 30 && this.oncoming(seg.lane)) {
            mustStop = true;
            this.limiter = 'yield';
          }
          if (mustStop && stopDist > -0.5) {
            this.waitLine = Math.min(this.waitLine, stopDist - v.halfL);
            // Plan with the comfortable deceleration for margin; the speed controller brakes
            // harder on its own when we are above the profile. Left turners yield (during their
            // own green, with no one crossing in front) with the centre near the lane end.
            const vs = Math.sqrt(2 * this.decel * Math.max(0, forSignal ? lineGap : stopDist - 0.8));
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

  /**
   * True while what we are overtaking, or a car queued next to it in our lane, is not yet
   * behind us. A blocker that drives off ends the manoeuvre.
   */
  private stillPassing(): boolean {
    const p = this.passing;
    if (!p || p.removed) return false;
    const v = this.vehicle;
    // Our lane at the car.
    const a = this.pointAhead(0);
    const b = this.pointAhead(1);
    const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const fx = (b.x - a.x) / tl;
    const fz = (b.z - a.z) / tl;
    // Not yet 1 m behind our rear (and, for other cars, in our lane no more than 6 m ahead).
    const notPassed = (x: number, z: number, half: number, ahead: number) => {
      const ox = x - a.x;
      const oz = z - a.z;
      const along = ox * fx + oz * fz;
      return Math.abs(ox * fz - oz * fx) < 2.5 && along + half > -v.halfL - 1 && along - half < v.halfL + ahead;
    };
    if (!('kind' in p)) return notPassed(p.pos.x, p.pos.z, 0.4, Infinity);
    if (p.vel.x * fx + p.vel.z * fz > 3) return false;
    if (notPassed(p.pos.x, p.pos.z, p.halfL, Infinity)) return true;
    for (const o of this.host.vehicles) {
      if (o !== v && !o.removed && notPassed(o.pos.x, o.pos.z, o.halfL, 6)) return true;
    }
    return false;
  }

  /** True if a vehicle is coming the other way, too close, in the lane we would pass in. */
  private oncomingInPassingLane(): boolean {
    const v = this.vehicle;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    for (const o of this.host.vehicles) {
      if (o === v || o.removed || o.speed < 1) continue;
      const ox = o.pos.x - v.pos.x;
      const oz = o.pos.z - v.pos.z;
      const along = ox * fx + oz * fz;
      const left = ox * fz - oz * fx;
      if (along <= 0 || left < 1.5 || left > 8) continue;
      if (Math.sin(o.heading) * fx + Math.cos(o.heading) * fz > -0.7) continue;
      if (along < 15 + o.speed * 5) return true;
    }
    return false;
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

  /** Distance to the nearest obstacle in a corridor towards the aim point (kept in `blocker`). */
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
    const range = 7 + Math.abs(v.forwardSpeed) * 1.7;
    const ignore = this.policy === 'chase' ? this.target : null;
    this.blockerGap = this.corridor(v, fx, fz, range, 0.5, 0.9, ignore, this.overtake <= 0 && this.pathOffset < 1.5);
    return this.blockerGap;
  }

  /** True if the planned path over the next `ahead` metres keeps `margin` clear of the body of `o`. */
  private pathClearOf(o: Vehicle, margin: number, ahead: number): boolean {
    const ofx = Math.sin(o.heading);
    const ofz = Math.cos(o.heading);
    let start = -this.s;
    for (const seg of this.segs) {
      if (start > ahead) break;
      const p = seg.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        if (start + seg.cum[i / 2 + 1]! < 0) continue;
        if (start + seg.cum[i / 2]! > ahead) break;
        const ax = p[i]!;
        const az = p[i + 1]!;
        const bx = p[i + 2]!;
        const bz = p[i + 3]!;
        const len = Math.hypot(bx - ax, bz - az) || 1;
        const tx = (bx - ax) / len;
        const tz = (bz - az) / len;
        const across = Math.abs(ofx * tz - ofz * tx) * o.halfL + Math.abs(ofx * tx + ofz * tz) * o.halfW;
        if (pointSegDist(o.pos.x, o.pos.z, ax, az, bx, bz) - across < margin) return false;
      }
      start += seg.length;
    }
    return true;
  }

  /** Free distance behind the rear bumper (vehicles and people), checked while reversing. */
  private gapBehind(v: Vehicle): number {
    const gap = this.corridor(v, -Math.sin(v.heading), -Math.cos(v.heading), 6, 0.3, 0.6, null, false);
    this.blocker = null;
    return gap;
  }

  /**
   * Bumper gap to the nearest vehicle or person in a corridor from `v` along (fx, fz), which is
   * stored in `blocker`. People count when a vehicle can run them over, knocked down ones included.
   * With `onPath`, oncoming vehicles that the planned path keeps clear of are ignored: they are in
   * their own lane, even when the corridor of a car still turning sweeps across it.
   */
  private corridor(v: Vehicle, fx: number, fz: number, range: number, carMargin: number, pedMargin: number, ignore: Character | Vehicle | null, onPath: boolean): number {
    const rx = -fz;
    const rz = fx;
    const hx = Math.sin(v.heading);
    const hz = Math.cos(v.heading);
    let best = Infinity;
    let found: Vehicle | Character | null = null;
    for (const o of this.host.vehicles) {
      if (o === v || o.removed) continue;
      if (ignore && (o === ignore || ('kind' in ignore ? false : o === ignore.vehicle))) continue;
      const ox = o.pos.x - v.pos.x;
      const oz = o.pos.z - v.pos.z;
      const along = ox * fx + oz * fz;
      if (along <= 0 || along > range + 6) continue;
      const ofx = Math.sin(o.heading);
      const ofz = Math.cos(o.heading);
      const extAlong = Math.abs(ofx * fx + ofz * fz) * o.halfL + Math.abs(ofx * rx + ofz * rz) * o.halfW;
      const extSide = Math.abs(ofx * rx + ofz * rz) * o.halfL + Math.abs(ofx * fx + ofz * fz) * o.halfW;
      const lat = Math.abs(ox * rx + oz * rz);
      if (lat > v.halfW + extSide + carMargin) continue;
      if (onPath && ofx * hx + ofz * hz < -0.7 && this.pathClearOf(o, v.halfW + 0.8, range + 6)) continue;
      const gap = along - v.halfL - extAlong;
      if (gap < best) {
        best = gap;
        found = o;
      }
    }
    for (const ch of this.host.characters) {
      if (ch.removed || (ch.state !== 'normal' && ch.state !== 'knocked') || ch === ignore) continue;
      const ox = ch.pos.x - v.pos.x;
      const oz = ch.pos.z - v.pos.z;
      const along = ox * fx + oz * fz;
      if (along <= 0 || along > range) continue;
      if (Math.abs(ox * rx + oz * rz) > v.halfW + pedMargin) continue;
      const gap = along - v.halfL - 0.4;
      if (gap < best) {
        best = gap;
        found = ch;
      }
    }
    this.blocker = found;
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
