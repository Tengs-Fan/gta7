// Shared driving brain for AI vehicles: lane following through the road
// network, traffic signals, car following, pursuit and fleeing.

import { clamp, pointSegDist, wrapAngle } from '../core/math';
import type { Rng } from '../core/rng';
import { isSolidForSight, makeRayHit } from '../world/colliders';
import { LANE_W } from '../world/constants';
import { axisOf, reverseDir, type Lane, type RoadNetwork, type Turn } from '../world/roads';
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
/** Seconds two cars may stand nose to nose before the one out of its lane backs into it. */
const FACE_OFF_PATIENCE = 3;
/** A car on the route policy has arrived once it is this close (straight-line) to its destination. */
export const ARRIVE_RADIUS = 20;
/**
 * What a turn from the wrong lane (a late lane change into it) costs the route planner, in metres:
 * route drivers keep to lane discipline unless the legal way round is that much longer. Strict
 * discipline would send a car in the inner lane of a border avenue all the way to the corner.
 */
const WRONG_LANE_COST = 60;

/**
 * A route destination planned over the lane graph, so lane discipline (see WRONG_LANE_COST) and the
 * no-U-turn rule are part of the plan. `start[i]` and `end[i]` are the planning costs from the start
 * and from the end of lane i (the best turn on), `startLen[i]` and `endLen[i]` the metres of those
 * same drives, and `goalS[i]` the offset along lane i of its closest approach to the destination,
 * for the lanes that pass within ARRIVE_RADIUS of it (NaN for the others).
 */
interface RouteField {
  start: Float64Array;
  end: Float64Array;
  startLen: Float64Array;
  endLen: Float64Array;
  goalS: Float64Array;
}

/** A turn's length for the route planner, a turn from the wrong lane costing extra. */
function turnCost(t: Turn): number {
  return t.legal ? t.length : t.length + WRONG_LANE_COST;
}

const routeFields = new WeakMap<RoadNetwork, Map<string, RouteField>>();

function routeField(roads: RoadNetwork, x: number, z: number): RouteField {
  let cache = routeFields.get(roads);
  if (!cache) {
    cache = new Map();
    routeFields.set(roads, cache);
  }
  const key = `${x.toFixed(1)},${z.toFixed(1)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const lanes = roads.lanes;
  const n = lanes.length;
  const near = new Float64Array(n);
  const along = new Float64Array(n);
  let nearest = Infinity;
  for (const l of lanes) {
    const s = clamp((x - l.sx) * l.dx + (z - l.sz) * l.dz, 0, l.length);
    along[l.id] = s;
    near[l.id] = Math.hypot(x - (l.sx + l.dx * s), z - (l.sz + l.dz * s));
    nearest = Math.min(nearest, near[l.id]!);
  }
  // A destination farther than ARRIVE_RADIUS from every road is driven to as close as the roads
  // get; the car never arrives there and keeps circling.
  const reach = Math.max(ARRIVE_RADIUS, nearest + 0.5);
  const goalS = new Float64Array(n).fill(NaN);
  const start = new Float64Array(n).fill(Infinity);
  const startLen = new Float64Array(n).fill(Infinity);
  for (const l of lanes) {
    if (near[l.id]! <= reach) {
      goalS[l.id] = along[l.id]!;
      start[l.id] = along[l.id]!;
      startLen[l.id] = along[l.id]!;
    }
  }
  // Reverse Dijkstra over the turns. Edge from lane l into lane m: drive all of l, then the turn.
  const preds: Array<Array<{ lane: Lane; turn: Turn }>> = Array.from({ length: n }, () => []);
  for (const l of lanes) for (const t of l.turns) preds[t.to.id]!.push({ lane: l, turn: t });
  const done = new Uint8Array(n);
  for (;;) {
    let m = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && start[i]! < best) {
        best = start[i]!;
        m = i;
      }
    }
    if (m < 0) break;
    done[m] = 1;
    for (const p of preds[m]!) {
      const c = p.lane.length + turnCost(p.turn) + best;
      if (c < start[p.lane.id]!) {
        start[p.lane.id] = c;
        startLen[p.lane.id] = p.lane.length + p.turn.length + startLen[m]!;
      }
    }
  }
  const end = new Float64Array(n).fill(Infinity);
  const endLen = new Float64Array(n).fill(Infinity);
  for (const l of lanes) {
    for (const t of l.turns) {
      const c = turnCost(t) + start[t.to.id]!;
      if (c < end[l.id]!) {
        end[l.id] = c;
        endLen[l.id] = t.length + startLen[t.to.id]!;
      }
    }
  }
  const field: RouteField = { start, end, startLen, endLen, goalS };
  // Only a few destinations are ever live at once: keep the cache small.
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, field);
  return field;
}

/**
 * Kinds of reversing: a slow queue manoeuvre (making room, backing up to overtake), the stuck rule
 * (pinned against something), backing into our own lane to let oncoming traffic through, or
 * backing off until a car stuck out in our lane has pulled back into its own.
 */
type ReverseKind = 'queue' | 'stuck' | 'lane' | 'yield';

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
  private destPt: { x: number; z: number } | null = null;
  /** A route car got a new destination: plan the path afresh on the next update. */
  private repath = false;
  /** The route field for the destination at `routeX`, `routeZ` (see routeField). */
  private route: RouteField | null = null;
  private routeX = NaN;
  private routeZ = NaN;
  /** Pursuit: drive straight at the target when close and visible. */
  direct = false;
  private holdUntil = -Infinity;
  private reverseTimer = 0;
  private reverseSteer = 0;
  private reverseKind: ReverseKind = 'queue';
  /** Seconds the running reverse has lasted. */
  private reverseTime = 0;
  /** Full power instead of the slow reverse (see the stuck rule). */
  private reverseHard = false;
  /** The last stuck-rule reverse ended against something behind (a lamp, a bin): the next one uses full power. */
  private pinned = false;
  private stuck = 0;
  private waitObstacle = 0;
  private honkCooldown = 0;
  private sightTimer = 0;
  private visibleTarget = false;
  /** Route policy: within ARRIVE_RADIUS of `dest`; the car then stops and holds there. */
  arrived = false;
  /** Lane whose signal we committed to stop for (prevents yellow-light dithering). */
  private stopLane = -1;
  /** Seconds an overtaking manoeuvre may still last (path shifted into the oncoming lane). */
  private overtake = 0;
  /** What we are overtaking; the manoeuvre ends once it is behind us. */
  private passing: Vehicle | Character | null = null;
  private blockedTime = 0;
  /** Seconds spent stopped nose to nose with a car coming the other way (see faceOff). */
  private faceOffTime = 0;
  /** The car we last backed away from in a face-off, and when. */
  private yielded: Vehicle | null = null;
  private yieldedAt = -Infinity;
  /** Past what we overtook but still out in the other lane, pulling back in. */
  private merging = false;
  /** Seconds the speed cap for oncoming traffic in the passing lane has held the car under 2 m/s (see update). */
  private capTime = 0;
  /** What the last oncomingGap found. */
  private oncomer: Vehicle | null = null;
  /** Seconds spent stopped in a queue (see queuedBehind). */
  private queueTime = 0;
  /** What scanAhead found closest ahead this frame, and its bumper gap. */
  private blocker: Vehicle | Character | null = null;
  private blockerGap = Infinity;
  /** What the last corridor scan found. */
  private nearest: Vehicle | Character | null = null;
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

  /**
   * Fixed destination for the route policy (also a waypoint for 'chase', see police search). A new
   * one clears `arrived`; a route car then stops waiting at the old one and plans its path afresh.
   */
  get dest(): { x: number; z: number } | null {
    return this.destPt;
  }

  set dest(d: { x: number; z: number } | null) {
    if (d === this.destPt) return;
    const wasThere = this.arrived;
    this.destPt = d;
    this.arrived = false;
    if (this.policy === 'route') {
      if (wasThere) this.hold = false;
      this.repath = true;
    }
  }

  /** Drive to (x, z) on the route policy, stop within ARRIVE_RADIUS of it and wait there. */
  setDestination(x: number, z: number): void {
    if (this.policy !== 'route') this.setPolicy('route');
    this.dest = { x, z };
    this.resetPath();
  }

  /** The route field towards `dest`, or null without one. */
  private routeTo(): RouteField | null {
    const d = this.destPt;
    if (!d) return null;
    if (d.x !== this.routeX || d.z !== this.routeZ) {
      this.routeX = d.x;
      this.routeZ = d.z;
      this.route = routeField(this.host.roads, d.x, d.z);
    }
    return this.route;
  }

  /**
   * Route policy: driving distance left to the destination along the planned route (0 once
   * arrived, Infinity without a destination or when none of the roads leads there).
   */
  routeRemaining(): number {
    if (this.policy !== 'route' || !this.dest) return Infinity;
    if (this.arrived) return 0;
    const field = this.routeTo();
    const seg = this.segs[0];
    if (!field || !seg) return Infinity;
    const left = Math.max(0, seg.length - this.s);
    if (seg.turn) return left + field.startLen[seg.turn.to.id]!;
    const lane = seg.lane!;
    const at = lane.length - left;
    const g = field.goalS[lane.id]!;
    if (at <= g) return g - at;
    return left + field.endLen[lane.id]!;
  }

  /** Snap onto the nearest lane in the vehicle's travel direction. */
  resetPath(): void {
    this.repath = false;
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
    if (this.policy === 'chase') {
      const tp = this.targetPos();
      if (tp) {
        const goal = roads.nearestNode(tp.x, tp.z);
        if (goal.id !== lane.to) {
          let route = roads.findRoute(lane.to, goal.id);
          // Lanes have no U-turn: go round the block rather than take a random turn away from the goal.
          if (route && route.length > 1 && route[1] === lane.from) route = roads.findRoute(lane.to, goal.id, lane.from);
          if (route && route.length > 1) {
            const t = roads.turnTowards(lane, route[1]!);
            if (t) return t;
          }
        }
      }
    }
    if (this.policy === 'route') {
      const t = this.routeTurn(lane);
      if (t) return t;
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

  /**
   * Route policy: the turn on the shortest drive to the destination (null when no road leads
   * there), from the wrong lane only when the legal way round is much longer (WRONG_LANE_COST).
   * A turn tighter than the vehicle steers is still taken, at a crawl (see turnSeg).
   */
  private routeTurn(lane: Lane): Turn | null {
    const field = this.routeTo();
    if (!field) return null;
    let best: Turn | null = null;
    let bestCost = Infinity;
    for (const t of lane.turns) {
      const c = turnCost(t) + field.start[t.to.id]!;
      if (c < bestCost) {
        bestCost = c;
        best = t;
      }
    }
    return best;
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

    if (this.repath) this.resetPath();
    // Arrived and stopped: wait there (holds expire unless asserted again).
    if (this.arrived && this.policy === 'route' && this.destPt && Math.abs(v.forwardSpeed) < 0.5) this.hold = true;
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
      this.reverseTime += dt;
      c.throttle = 0;
      c.handbrake = false;
      c.steer = this.reverseKind === 'lane' ? this.laneReverseSteer() : this.reverseSteer;
      // Back up slowly, and stop short of whatever is behind (pursuers use all the room there is).
      const back = -v.forwardSpeed;
      c.brake = this.reverseHard ? 1 : clamp((REVERSE_SPEED - back) * 0.8, 0, 1);
      const room = (this.obeyLights ? 1.2 : 0.5) + (back > 0 ? (back * back) / (2 * v.spec.brake) : 0);
      if (this.gapBehind(v) < room) {
        // Backing up to overtake waits for the car behind to make room (see makeRoom); other reverses end there.
        if (this.passing && this.reverseKind === 'queue') {
          c.brake = 0;
          c.throttle = back > 0.6 ? 1 : 0;
          if (this.reverseTime < 3) this.reverseTimer += dt;
        } else {
          this.reverseTimer = 0;
        }
      }
      // Backing up to overtake only needs room to swing out.
      const p = this.passing;
      if (p && (p.pos.x - v.pos.x) * Math.sin(v.heading) + (p.pos.z - v.pos.z) * Math.cos(v.heading) - v.halfL - ('kind' in p ? p.halfL : 0.4) > 4.5) {
        this.reverseTimer = 0;
      }
      if (this.reverseKind === 'stuck' && this.reverseTime > 0.35 && back < 0.3) {
        // Pinned against something behind: pushing on is no use, and the next try needs full power.
        this.pinned = true;
        this.reverseTimer = 0;
      }
      if (this.reverseKind === 'lane' && this.backInLane()) this.reverseTimer = 0;
      // Giving way and getting nowhere (something behind): stop pushing.
      if ((this.reverseKind === 'lane' || this.reverseKind === 'yield') && this.reverseTime > 0.6 && back < 0.2) this.reverseTimer = 0;
      if (this.reverseKind === 'yield') {
        const o = this.yielded;
        const ai = o && !o.removed ? this.driven(o) : null;
        if (!ai || ai.laneIntrusion() < 0.1 || Math.hypot(o!.pos.x - v.pos.x, o!.pos.z - v.pos.z) > 20) this.reverseTimer = 0;
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
      const dest = this.policy === 'route' ? this.dest : null;
      if (dest && !this.arrived && Math.hypot(v.pos.x - dest.x, v.pos.z - dest.z) <= ARRIVE_RADIUS) this.arrived = true;
      // There: brake to a stop on the lane (the hold above takes over once stopped).
      if (dest && this.arrived) targetSpeed = 0;
    }

    // Obstacles ahead (vehicles and pedestrians).
    const patience = this.policy === 'chase' || this.policy === 'flee' ? 0.9 : 7;
    let backIntoLane = false;
    if (this.overtake > 0) {
      this.overtake -= dt;
      // Pull back in as soon as we are past, instead of lingering in the oncoming lane.
      if (!this.direct && !this.stillPassing()) {
        this.overtake = 0;
        this.merging = true;
      } else if (this.obeyLights && !this.direct) {
        backIntoLane = this.giveWay();
        // Called off, or timed out short of drawing level: try again once the way is clear.
        if (this.overtake <= 0) this.retryOvertake(patience);
      }
      if (this.overtake <= 0) this.passing = null;
    }
    if (this.merging && this.overtake <= 0 && this.laneIntrusion() < 0) this.merging = false;
    let gap = this.scanAhead(v, aimX, aimZ);
    if (gap < Infinity) {
      const stopGap = Math.max(0, gap - 2.2);
      const vs = Math.sqrt(2 * this.decel * stopGap);
      if (vs < targetSpeed) {
        targetSpeed = vs;
        this.limiter = 'obstacle';
      }
    }
    // Still out in the passing lane, slow for anyone coming the other way in it: pulling back in
    // turns the corridor away from them while the car is still in their way.
    let held = false;
    if (this.obeyLights && (this.overtake > 0 || this.merging) && this.laneIntrusion() > 0) {
      const capGap = this.oncomingGap();
      const vs = Math.sqrt(2 * this.decel * Math.max(0, capGap - 2.2));
      if (vs < targetSpeed) {
        targetSpeed = vs;
        held = vs < 2 && Math.abs(speed) < 2;
        // Held up by that car for over 2 s: report it as the blocker (for the blocked and wait
        // timers). What frees the car is dropping `merging` after 4 s, below.
        if (held && this.capTime > 2) {
          this.limiter = 'obstacle';
          this.blocker = this.oncomer;
          this.blockerGap = capGap;
          gap = capGap;
        }
      }
    }
    this.capTime = held ? this.capTime + dt : 0;
    // Kept standing by it for over 4 s, stop waiting for it: as an ordinary car out of its lane, the
    // car drives on and stops only for what the obstacle scan finds in its way.
    if (this.capTime > 4 && Math.abs(speed) < 0.5) this.merging = false;
    // (Read back through a cast: the reset at the top of update() leaves the field narrowed to null.)
    const ahead = this.blocker as Vehicle | Character | null;
    const blocked = this.limiter === 'obstacle';
    // Waiting in line at a light is not a blockage: no horn, no overtaking, no reversing.
    // A queue that does not move for a long time is handled like any other blockage, though.
    const queue = blocked ? this.queuedBehind() : null;
    const queued = queue !== null;
    if (queued && Math.abs(speed) < 0.5) this.queueTime += dt;
    else if (!queued || Math.abs(speed) > 1.5) this.queueTime = 0;
    const waiting = queued && this.queueTime < QUEUE_PATIENCE;
    // Pursuers go around traffic quickly; civilians only around long-term blockages. Waiting in
    // line behind a car that is stuck at one counts, so the next in line goes round without delay.
    if (blocked && (!waiting || queue === 'car') && Math.abs(speed) < 3 && !this.direct) this.blockedTime += dt;
    else this.blockedTime = Math.max(0, this.blockedTime - dt * 2);
    // Two cars stopped nose to nose (an overtaker met oncoming traffic): one of them backs up, so
    // neither waits for the other forever (see yieldsTo).
    const rival = !this.direct && Math.abs(speed) < 0.5 ? this.faceOff() : null;
    this.faceOffTime = rival ? this.faceOffTime + dt : 0;
    let makeWay = false;
    const yieldMode = rival && this.faceOffTime > FACE_OFF_PATIENCE ? this.yieldsTo(rival) : null;
    if (rival && yieldMode) {
      this.faceOffTime = 0;
      this.yielded = rival;
      this.yieldedAt = this.host.time;
      if (yieldMode === 'lane') {
        this.overtake = 0;
        this.passing = null;
        this.retryOvertake(patience);
        backIntoLane = true;
      } else {
        makeWay = true;
      }
    }
    let backUpToPass = false;
    // Civilians wait for a gap in oncoming traffic before pulling out, and for the passing lane to be
    // free. Nobody overtakes a car coming the other way (a face-off sorts that out).
    if (
      blocked &&
      !waiting &&
      this.blockedTime > patience &&
      this.overtake <= 0 &&
      !backIntoLane &&
      !makeWay &&
      !(ahead && 'kind' in ahead && this.driven(ahead) && Math.sin(ahead.heading) * fx + Math.cos(ahead.heading) * fz < -0.7) &&
      !(this.obeyLights && ahead && this.passingLaneTaken(ahead, this.passStretch(ahead, gap), (u) => 15 + u * 5))
    ) {
      this.overtake = this.obeyLights ? 8 : 6;
      this.passing = ahead;
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
        this.startReverse(1, 'queue');
      }
    } else {
      this.waitObstacle = Math.max(0, this.waitObstacle - dt);
    }
    // Make room for a car ahead backing up towards us (to pull out, or to get back into its lane).
    const makeRoom =
      this.obeyLights &&
      !!ahead &&
      'kind' in ahead &&
      gap < 3 &&
      ((ahead.ai !== null && ahead.ai.reverseTimer > 0) || ahead.forwardSpeed < -0.5) &&
      Math.sin(ahead.heading) * fx + Math.cos(ahead.heading) * fz > 0.7;
    if (backIntoLane) this.startReverse(0, 'lane', 6);
    else if (makeWay) this.startReverse(0, 'yield', 4);
    // Back up with the wheels turned away from where we want to go.
    else if (backUpToPass) this.startReverse(1, 'queue', 1.2);
    else if (makeRoom) this.startReverse(0, 'queue', 0.5);
    else if (this.stuck > (this.policy === 'chase' ? 1.1 : 1.8)) this.startReverse(lx >= 0 ? -1 : 1, 'stuck');
    this.trackProgress(dt, waiting || (!blocked && this.waitLine < Infinity));
  }

  /**
   * Starts reversing. Queue manoeuvres and giving way stay below the speed at which street
   * furniture breaks; the stuck rule does too, unless its last try ended against something behind
   * (a lamp or a bin), which full power knocks over. People and cars behind are always spared.
   */
  private startReverse(steer: number, kind: ReverseKind, time = this.policy === 'chase' ? 1.0 : 1.4): void {
    this.reverseTimer = time;
    this.reverseTime = 0;
    this.reverseSteer = steer;
    this.reverseKind = kind;
    this.reverseHard = kind === 'stuck' && this.pinned;
    this.stuck = 0;
  }

  /** Overtake again as soon as the passing lane is free (the random part keeps two cars from mirroring each other). */
  private retryOvertake(patience: number): void {
    this.blockedTime = patience - this.host.rng.range(0.5, 3);
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
      this.pinned = false;
    } else if (!excused) {
      this.idle += dt;
    }
    v.stuckTime = this.idle;
  }

  /**
   * Whether the car blocking us has us waiting in line: 'light' if it waits at a light or yields
   * (or moves), directly or through the cars in front of it; 'car' if the cars ahead wait to get
   * past one standing in the road, which only the first in line goes round. Null if we are blocked
   * ourselves. Worked out afresh every frame, so no stale flag can keep a jam or a cycle "queued".
   */
  private queuedBehind(): 'light' | 'car' | null {
    if (!this.obeyLights) return null;
    const fx = Math.sin(this.vehicle.heading);
    const fz = Math.cos(this.vehicle.heading);
    let ai: DriverAI = this;
    for (let hops = 0; hops < 12; hops++) {
      const b = ai.blocker;
      if (!b || b.removed) return null;
      // The car ahead waits for someone to get out of the road; we are only held up by a person
      // ourselves when they are on the crossing in front of a red light.
      if (!('kind' in b)) return ai !== this || ai.waitLine < ai.blockerGap + 5 ? 'light' : null;
      // Only cars lined up our way form a queue (not one across the road or nose to nose).
      if (Math.sin(b.heading) * fx + Math.cos(b.heading) * fz < 0.7) return null;
      if (b.forwardSpeed > 1) return 'light';
      const next = b.ai && b.driver && b.driver.alive && !b.driver.isPlayer && !b.ai.hold ? b.ai : null;
      // The player's car, or one nobody drives, counts when it stands at our stop line.
      if (!next) return ai.waitLine < ai.blockerGap + 2 * b.halfL + 3 ? 'light' : ai !== this ? 'car' : null;
      if (next.limiter === 'light' || next.limiter === 'yield') return 'light';
      // A car ahead backing up or pulling out is busy getting past whatever holds it up.
      if (next.reverseTimer > 0 || next.overtake > 0) return 'car';
      if (next.limiter !== 'obstacle') return null;
      ai = next;
    }
    return null;
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
          // A nose already past the line when the light changes (a left turner yielding on its green)
          // is in the junction: only oncoming traffic holds it, and it clears the junction after that.
          const inJunction = lineGap < 0 && !committed;
          let mustStop = !inJunction && (state === 'red' || (state === 'yellow' && (committed || lineGap > (speed * speed) / (2 * 7) + 1)));
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
            // harder on its own when we are above the profile. Left turners yield (on their own
            // green, or in the junction after it, with no one crossing in front) with the centre
            // near the lane end.
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
   * True while what we are overtaking, or a car queued in front of it, is not yet behind us.
   * Measured from the car itself like the scan corridor, so a car pushed off its lane still
   * finishes its pass; along the lane rather than the car's heading, which swings wide while it
   * backs up and pulls out. A blocker that drives off ends the manoeuvre.
   */
  private stillPassing(): boolean {
    const p = this.passing;
    if (!p || p.removed) return false;
    const v = this.vehicle;
    const f = this.laneFrame();
    const fx = f.tx;
    const fz = f.tz;
    const along = (o: Vehicle | Character) => (o.pos.x - v.pos.x) * fx + (o.pos.z - v.pos.z) * fz;
    const side = (o: Vehicle | Character) => (o.pos.x - v.pos.x) * -fz + (o.pos.z - v.pos.z) * fx;
    // Not yet 1 m behind our rear.
    const notPassed = (o: Vehicle | Character, half: number) => along(o) + half > -v.halfL - 1;
    const ps = side(p);
    if (Math.abs(ps) > 2 * LANE_W) return false;
    if (!('kind' in p)) return notPassed(p, 0.4);
    if (p.vel.x * fx + p.vel.z * fz > 3) return false;
    if (notPassed(p, p.halfL)) return true;
    // Cars queued in its lane up to 6 m past our front are overtaken in the same go.
    for (const o of this.host.vehicles) {
      if (o === v || o === p || o.removed || Math.abs(side(o) - ps) > 2.5) continue;
      if (notPassed(o, o.halfL) && along(o) - o.halfL < v.halfL + 6) return true;
    }
    return false;
  }

  /**
   * Civilians give way to traffic in the passing lane while overtaking. Short of drawing level
   * with what they pass, they pull back in behind it (returns true when that takes reversing, the
   * nose being out in the other lane); once alongside they see it through, and the obstacle scan
   * stops them short of anyone in the way.
   */
  private giveWay(): boolean {
    const p = this.passing!;
    const v = this.vehicle;
    const f = this.laneFrame();
    const half = 'kind' in p ? p.halfL : 0.4;
    const gap = (p.pos.x - v.pos.x) * f.tx + (p.pos.z - v.pos.z) * f.tz - half - v.halfL;
    if (gap < 0) {
      // Level with it: there is no way back, so the pass never times out half done.
      this.overtake = Math.max(this.overtake, 0.5);
      return false;
    }
    if (!this.passingLaneTaken(p, this.passStretch(p, gap), (u) => Math.max(40, u * 3))) return false;
    this.overtake = 0;
    return this.laneIntrusion() > 0;
  }

  /** Length of passing lane an overtake of `p` (bumper gap `gap` ahead) takes: past it, plus room to pull back in. */
  private passStretch(p: Vehicle | Character, gap: number): number {
    return gap + ('kind' in p ? 2 * p.halfL : 0.8) + 2 * this.vehicle.halfL + 4;
  }

  /**
   * True if the lane we pass in is taken: a vehicle stands in it (or drives our way) within
   * `stretch` metres of our front bumper, or one comes the other way within `range(its speed)`,
   * counting cars about to turn into it at the far junction. `except` is what we overtake.
   */
  private passingLaneTaken(except: Vehicle | Character, stretch: number, range: (speed: number) => number): boolean {
    const v = this.vehicle;
    const f = this.laneFrame();
    const pass = this.passingLane();
    for (const o of this.host.vehicles) {
      if (o === v || o === except || o.removed) continue;
      const along = (o.pos.x - v.pos.x) * f.tx + (o.pos.z - v.pos.z) * f.tz;
      // Gone past us.
      if (along + o.halfL < -v.halfL - 1) continue;
      const gap = along - o.halfL - v.halfL;
      const coming = -(o.vel.x * f.tx + o.vel.z * f.tz);
      const left = (o.pos.x - f.x) * f.tz - (o.pos.z - f.z) * f.tx;
      if (left > LANE_W / 2 - 0.2 && left < 1.5 * LANE_W + 0.3) {
        if (coming > 1 ? gap < range(coming) : gap < stretch) return true;
      } else if (pass && o.ai && o.driver?.alive && !o.driver.isPlayer && o.ai.entering(pass) && gap < range(Math.max(coming, o.speed, 6))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Bumper gap, along our lane, to the nearest car in the passing lane ahead that closes in on us
   * (kept in `oncomer`), less the way it covers in a second. One standing there (parked, abandoned,
   * waiting) is left to the obstacle scan, which stops us only when it is in our way, and makes it
   * the blocker that the face-off and stuck rules work with.
   */
  private oncomingGap(): number {
    const v = this.vehicle;
    const f = this.laneFrame();
    let best = Infinity;
    this.oncomer = null;
    for (const o of this.host.vehicles) {
      if (o === v || o.removed || Math.sin(o.heading) * f.tx + Math.cos(o.heading) * f.tz > -0.7) continue;
      const along = (o.pos.x - v.pos.x) * f.tx + (o.pos.z - v.pos.z) * f.tz;
      const left = (o.pos.x - f.x) * f.tz - (o.pos.z - f.z) * f.tx;
      if (along <= 0 || left < LANE_W / 2 - 0.2 || left > 1.5 * LANE_W + 0.3) continue;
      const coming = -(o.vel.x * f.tx + o.vel.z * f.tz);
      if (coming < 1) continue;
      const gap = along - o.halfL - v.halfL - coming;
      if (gap < best) {
        best = gap;
        this.oncomer = o;
      }
    }
    return best;
  }

  /** The lane an overtake swings out into: the next one to the left, on a one-lane road the oncoming one. */
  private passingLane(): Lane | null {
    const lane = this.segs[0]?.lane;
    if (!lane) return null;
    const roads = this.host.roads;
    return lane.index > 0 ? roads.laneFrom(lane.from, lane.dir, lane.index - 1) : roads.laneFrom(lane.to, reverseDir(lane.dir), 0);
  }

  /** True if this car is turning into `lane`, or on its way to the junction to do so. */
  private entering(lane: Lane): boolean {
    const s0 = this.segs[0];
    if (!s0) return false;
    if (s0.turn) return s0.turn.to === lane;
    const s1 = this.segs[1];
    return !!s1?.turn && s1.turn.to === lane && s0.length - this.s < 20 && this.vehicle.speed > 1;
  }

  /** The point of the planned path nearest to the car, and the path direction there. */
  private laneFrame(): { x: number; z: number; tx: number; tz: number } {
    const v = this.vehicle;
    const seg = this.segs[0];
    if (!seg) return { x: v.pos.x, z: v.pos.z, tx: Math.sin(v.heading), tz: Math.cos(v.heading) };
    const s = Math.min(projectOnSeg(seg, v.pos.x, v.pos.z).s, seg.length - 0.5);
    const a = pointOnSeg(seg, s);
    const b = pointOnSeg(seg, s + 0.5);
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: a.x, z: a.z, tx: (b.x - a.x) / l, tz: (b.z - a.z) / l };
  }

  /** How far the body reaches past the left edge of our lane, into the passing lane (negative inside the lane). */
  private laneIntrusion(): number {
    const v = this.vehicle;
    const f = this.laneFrame();
    const left = (v.pos.x - f.x) * f.tz - (v.pos.z - f.z) * f.tx;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const across = Math.abs(fx * f.tz - fz * f.tx) * v.halfL + Math.abs(fx * f.tx + fz * f.tz) * v.halfW;
    return left + across - LANE_W / 2;
  }

  /** Back in our lane and lined up with it (ends a reverse into the lane). */
  private backInLane(): boolean {
    const f = this.laneFrame();
    const h = this.vehicle.heading;
    return this.laneIntrusion() < -0.1 && Math.sin(h) * f.tx + Math.cos(h) * f.tz > Math.cos(0.2);
  }

  /** Steering while backing into our lane: pure pursuit, in reverse, of a lane point behind the car. */
  private laneReverseSteer(): number {
    const v = this.vehicle;
    const seg = this.segs[0];
    if (!seg) return 0;
    // The whole lane, not just the planned part of it, which starts where the car joined it.
    const lane = seg.lane;
    let q: { x: number; z: number };
    if (lane) {
      const s = clamp((v.pos.x - lane.sx) * lane.dx + (v.pos.z - lane.sz) * lane.dz - 6, 0, lane.length);
      q = { x: lane.sx + lane.dx * s, z: lane.sz + lane.dz * s };
    } else {
      q = pointOnSeg(seg, projectOnSeg(seg, v.pos.x, v.pos.z).s - 6);
    }
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const dx = q.x - v.pos.x;
    const dz = q.z - v.pos.z;
    const lx = dx * -fz + dz * fx;
    const lz = dx * fx + dz * fz;
    if (lz > -1) return 0;
    // Moving backwards, the same wheel angle turns the car's tail towards a point on that side.
    const maxSteer = v.spec.steer / (1 + Math.abs(v.forwardSpeed) / 15);
    return clamp(Math.atan(((2 * lx) / Math.max(1, lx * lx + lz * lz)) * v.spec.length * 0.6) / maxSteer, -1, 1);
  }

  /** A car stopped nose to nose with us, one of us blocking the other (null if none). */
  private faceOff(): Vehicle | null {
    const v = this.vehicle;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    for (const o of this.host.vehicles) {
      if (o === v || o.removed || o.speed > 0.5) continue;
      if (this.blocker !== o && o.ai?.blocker !== v) continue;
      if (Math.sin(o.heading) * fx + Math.cos(o.heading) * fz > -0.7) continue;
      const along = (o.pos.x - v.pos.x) * fx + (o.pos.z - v.pos.z) * fz;
      if (along > 0 && along - v.halfL - o.halfL < 5) return o;
    }
    return null;
  }

  /** The AI driving `o`, if a live NPC drives it on a lane (not straight at a pursuit target). */
  private driven(o: Vehicle): DriverAI | null {
    return o.ai && o.driver && o.driver.alive && !o.driver.isPlayer && !o.ai.direct ? o.ai : null;
  }

  /** Room to back up into (vehicles and people behind). */
  private roomBehind(): boolean {
    return this.gapBehind(this.vehicle) > 2;
  }

  /**
   * How we give way in a face-off with `o`, if we do. The car out of its lane backs into it
   * ('lane'); the other one backs up to let it pull in instead ('back') when it cannot: it has no
   * room behind, is pulling in past what it overtook, or already backed away from us once. Ties go
   * by id. Only one of the two reverses at a time.
   */
  private yieldsTo(o: Vehicle): 'lane' | 'back' | null {
    const ai = this.driven(o);
    if (ai && ai.reverseTimer > 0) return null;
    const mine = this.laneIntrusion();
    const theirs = ai ? ai.laneIntrusion() : -Infinity;
    const outOfLane = (a: number, b: number, first: boolean) => a > 0.3 && (a > b + 0.2 || (a > b - 0.2 && first));
    const v = this.vehicle;
    const recently = (d: DriverAI, from: Vehicle) => d.yielded === from && this.host.time - d.yieldedAt < 20;
    if (outOfLane(mine, theirs, v.id < o.id)) {
      const theyCanBack = !!ai && ai.roomBehind();
      if (!this.roomBehind() || ((this.merging || recently(this, o)) && theyCanBack)) return null;
      return 'lane';
    }
    if (!ai || !outOfLane(theirs, mine, o.id < v.id) || !this.roomBehind()) return null;
    return ai.merging || recently(ai, v) || !ai.roomBehind() ? 'back' : null;
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
    this.blocker = this.nearest;
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
    return this.corridor(v, -Math.sin(v.heading), -Math.cos(v.heading), 6, 0.3, 0.6, null, false);
  }

  /**
   * Bumper gap to the nearest vehicle or person in a corridor from `v` along (fx, fz), which is
   * stored in `nearest`. People count when a vehicle can run them over, knocked down ones included.
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
    this.nearest = found;
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
