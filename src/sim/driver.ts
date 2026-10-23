// Shared driving brain for AI vehicles: lane following through the road
// network, traffic signals, car following, pursuit and fleeing.

import type { AABB } from '../core/collision';
import { clamp, pointSegDist, wrapAngle } from '../core/math';
import type { Rng } from '../core/rng';
import { isSolidForSight, makeRayHit, type StaticCollider } from '../world/colliders';
import { LANE_W, STREET_W } from '../world/constants';
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
export const STOP_MARGIN = 0.9;
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
/**
 * Squeezing past (see DriverAI.squeeze): how far beyond the front of what we pass a car standing in
 * the passing lane (or beside it) makes the pass a squeeze, the clearance kept from what we pass,
 * and the corridor margin to standing cars meanwhile (0.5 m otherwise).
 */
const SQUEEZE_RANGE = 20;
const SQUEEZE_CLEARANCE = 0.3;
const SQUEEZE_MARGIN = 0.2;
/** Squeezing past, a car pulls back in once its rear is this far past what it passes (1 m otherwise). */
const SQUEEZE_PULL_IN = 0.3;
/** Spacing (m) of the poses along the way on at which a car standing beside us is checked (see clearBeside). */
const BESIDE_STEP = 0.5;
/** A pull-in reverse ends once the body closes in nearer than this (m) on the car it makes way for. */
const PULL_IN_CLEAR = 0.4;
/**
 * Two cars overtaking towards each other this close (bumper gap) take turns, the first to start
 * going first: their passes would meet where each pulls back in, in the other's lane.
 */
const CLAIM_RANGE = 50;
/** A car on the route policy has arrived once it is this close (straight-line) to its destination. */
export const ARRIVE_RADIUS = 20;
/** Going straight at a pursuit target, a car stops short of water deeper than this (m), well short of the depth that sinks it. */
const DIRECT_WADE = 0.45;
/**
 * A pursuer going straight at its target that stands held up by a vehicle for this long (s) drops the
 * straight-at-him mode for DIRECT_SUPPRESS s: only lane following overtakes, reverses out of a stuck
 * spot or sorts out a face-off, none of which direct mode does (see DriverAI.trackDirectBlock).
 */
const DIRECT_BLOCK = 1.2;
const DIRECT_SUPPRESS = 4;
/**
 * A driver standing held up this long (s) by a vehicle nobody drives (or a wreck) re-plans, and for DETOUR_MEMORY s
 * takes no turn that passes within reach of it (see DriverAI.trackEmptyBlock), when another turn is there.
 */
const DETOUR_BLOCK = 2;
const DETOUR_MEMORY = 20;
/** How far into the lane after a turn (m) the detour check looks for the vehicle it avoids. */
const DETOUR_EXIT = 12;
/** How far along its way ahead (m) a driver looks for a vehicle nobody drives to plan round, and how long (s) it backs out of a junction to do so. */
const DETOUR_LOOK = 40;
const DETOUR_BACK = 2.5;
/** Room (m) a detour leaves between the side of the vehicle and the body of the one it goes round. */
const DETOUR_MARGIN = 0.4;
/** A vehicle in the way short of this far (m) before the end of the lane stands on it, not in the junction after it. */
const DETOUR_LANE_END = 2;
/** Seconds a civilian held up by a vehicle nobody drives, standing on its lane, waits before overtaking it (7 s otherwise). */
const UNATTENDED_PATIENCE = 2;
/**
 * A left turner yields to an oncoming car within 38 m, and to the player's car up to ONCOMING_REACH m away if it gets
 * there within ONCOMING_TIME s: at racing speed 38 m takes under 2 s, less than a turn takes to clear.
 */
const ONCOMING_REACH = 120;
const ONCOMING_TIME = 4;
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
 * (pinned against something), backing into our own lane to let oncoming traffic through, backing
 * out of a face-off the way we came, round the cars we pulled out to pass (see retreatPoint),
 * backing up a little to turn the nose in and pull into our lane beside us, or backing off until a
 * car stuck out in our lane has pulled back into its own.
 */
type ReverseKind = 'queue' | 'stuck' | 'lane' | 'retreat' | 'pullIn' | 'yield';

/** How a car gives way in a face-off (see DriverAI.facePlan); 'back' is the 'yield' reverse. */
type YieldMode = 'lane' | 'retreat' | 'pullIn' | 'back';

/** Which of the two cars in a face-off gives way, and how. */
interface FacePlan {
  by: DriverAI;
  mode: YieldMode;
}

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

/** Distance (m) from the stretch from (ax, az) to (bx, bz) to the footprint of `o`; 0 where it crosses it. */
function boxGap(o: Vehicle, ax: number, az: number, bx: number, bz: number): number {
  // In the frame of `o`: x across it, z along it.
  const fx = Math.sin(o.heading);
  const fz = Math.cos(o.heading);
  const loc = (x: number, z: number) => [(x - o.pos.x) * fz - (z - o.pos.z) * fx, (x - o.pos.x) * fx + (z - o.pos.z) * fz] as const;
  const [px, pz] = loc(ax, az);
  const [qx, qz] = loc(bx, bz);
  const w = o.halfW;
  const l = o.halfL;
  // Clip the stretch to the box (Liang-Barsky): any part left inside means it crosses.
  let t0 = 0;
  let t1 = 1;
  const dx = qx - px;
  const dz = qz - pz;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    return t0 <= t1;
  };
  if (clip(-dx, px + w) && clip(dx, w - px) && clip(-dz, pz + l) && clip(dz, l - pz)) return 0;
  const boxDist = (x: number, z: number) => Math.hypot(Math.max(0, Math.abs(x) - w), Math.max(0, Math.abs(z) - l));
  let best = Math.min(boxDist(px, pz), boxDist(qx, qz));
  for (const [cx, cz] of [[w, l], [w, -l], [-w, l], [-w, -l]] as const) best = Math.min(best, pointSegDist(cx, cz, px, pz, qx, qz));
  return best;
}

/** True if a body following the stretch from (ax, az) to (bx, bz) keeps `margin` clear of the body of `o`. */
function stretchClearOf(o: Vehicle, margin: number, ax: number, az: number, bx: number, bz: number): boolean {
  const len = Math.hypot(bx - ax, bz - az) || 1;
  const tx = (bx - ax) / len;
  const tz = (bz - az) / len;
  const ofx = Math.sin(o.heading);
  const ofz = Math.cos(o.heading);
  const across = Math.abs(ofx * tz - ofz * tx) * o.halfL + Math.abs(ofx * tx + ofz * tz) * o.halfW;
  return pointSegDist(o.pos.x, o.pos.z, ax, az, bx, bz) - across >= margin;
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
  /** Seconds direct mode has stood held up by a vehicle (decays otherwise), and until when direct mode is off after that. */
  private directBlocked = 0;
  private directOffUntil = -Infinity;
  /** Seconds held up by a standing vehicle nobody drives (decays otherwise), the last such vehicle, and when it was met. */
  private emptyBlocked = 0;
  private avoid: Vehicle | null = null;
  private avoidAt = -Infinity;
  private holdUntil = -Infinity;
  private reverseTimer = 0;
  private reverseSteer = 0;
  private reverseKind: ReverseKind = 'queue';
  /** Seconds the running reverse has lasted, and of those, how long the car has stood still. */
  private reverseTime = 0;
  private reverseStill = 0;
  /** Full power instead of the slow reverse (see the stuck rule). */
  private reverseHard = false;
  /** The last stuck-rule reverse ended against something behind (a lamp, a bin): the next one uses full power. */
  private pinned = false;
  private stuck = 0;
  private waitObstacle = 0;
  private honkCooldown = 0;
  private sightTimer = 0;
  private visibleTarget = false;
  /** Route policy: within arriveRadius of `dest`; the car then stops and holds there. */
  arrived = false;
  /** How close (straight-line, m) a route car comes to its destination before it counts as arrived. */
  arriveRadius = ARRIVE_RADIUS;
  /** Lane whose signal we committed to stop for (prevents yellow-light dithering). */
  private stopLane = -1;
  /** Seconds an overtaking manoeuvre may still last (path shifted into the oncoming lane). */
  private overtake = 0;
  /** What we are overtaking; the manoeuvre ends once it is behind us. */
  private passing: Vehicle | Character | null = null;
  /** When the running overtake began: of two cars overtaking towards each other, the first goes first (see claimed). */
  private overtakeSince = Infinity;
  private blockedTime = 0;
  /** Seconds spent stopped nose to nose with a car coming the other way (see faceOff). */
  private faceOffTime = 0;
  /** The car we last backed away from in a face-off, and when. */
  private yielded: Vehicle | null = null;
  private yieldedAt = -Infinity;
  /** How we last gave way (see facePlan). */
  private yieldedHow: YieldMode | null = null;
  /** Seconds the car we back up for has stood still during the 'yield' reverse. */
  private yieldStill = 0;
  /** Pulling in: the closest the body has come to the car it makes way for during this reverse (see update). */
  private pullInGap = Infinity;
  /** Past what we overtook but still out in the other lane, pulling back in. */
  private merging = false;
  /** A retreat backs out round the cars in our lane up to this point, keeping `off` to the left of the lane (see planRetreat). */
  private retreatTo: { x: number; z: number; off: number } | null = null;
  /**
   * Overtaking (or pulling back in after it) between what we pass and a car standing in the passing
   * lane not far beyond it: the car swings out only as far as it takes to clear what it passes and
   * keeps a narrower margin to standing cars, which leaves room to pull back in before the other one.
   */
  private squeeze = false;
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
  /** Who the last peopleGap found. */
  private nearestPerson: Character | null = null;
  /** The wall or prop the last gapBehind found nearest behind the car, if it was nearer than any vehicle or person. */
  private behindProp: StaticCollider | null = null;
  /** Distance from the front bumper to the stop line of a red light or a yield on the path, if any. */
  private waitLine = Infinity;
  /** Last place the vehicle made real progress from (see trackProgress). */
  private progressX: number;
  private progressZ: number;
  private idle = 0;
  /** Debug/telemetry: why the car is slowing down. */
  limiter: 'none' | 'light' | 'obstacle' | 'turn' | 'yield' = 'none';

  /** The vehicle this driver stands held up behind, if any. */
  get heldUpBy(): Vehicle | null {
    const b = this.blocker;
    return b && 'kind' in b && this.limiter === 'obstacle' && Math.abs(this.vehicle.forwardSpeed) < 0.5 ? b : null;
  }

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

  /**
   * The turns off `lane` worth taking: while the driver remembers a vehicle nobody drives that held it up (see
   * trackEmptyBlock), those that keep clear of it, its path through the junction and the first DETOUR_EXIT m of the
   * lane after it, when there are any; otherwise all of them.
   */
  private detourTurns(lane: Lane): readonly Turn[] {
    const turns = lane.turns;
    const o = this.avoid;
    if (!o || !this.avoiding()) return turns;
    const margin = this.vehicle.halfW + DETOUR_MARGIN;
    const ok = turns.filter((t) => {
      const p = t.pts;
      for (let i = 0; i + 3 < p.length; i += 2) if (boxGap(o, p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!) < margin) return false;
      const to = t.to;
      const e = Math.min(DETOUR_EXIT, to.length);
      return boxGap(o, to.sx, to.sz, to.sx + to.dx * e, to.sz + to.dz * e) >= margin;
    });
    return ok.length > 0 ? ok : turns;
  }

  /** Whether the driver still remembers a vehicle to detour round. */
  private avoiding(): boolean {
    return !!this.avoid && !this.avoid.removed && this.host.time - this.avoidAt < DETOUR_MEMORY;
  }

  private chooseTurn(lane: Lane): Turn | null {
    const turns = this.detourTurns(lane);
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
            if (t && turns.includes(t)) return t;
          }
        }
      }
    }
    if (this.policy === 'route') {
      const t = this.routeTurn(lane, turns);
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
  private routeTurn(lane: Lane, turns: readonly Turn[] = lane.turns): Turn | null {
    const field = this.routeTo();
    if (!field) return null;
    let best: Turn | null = null;
    let bestCost = Infinity;
    for (const t of turns) {
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
    if (this.policy === 'chase' && this.host.time < this.directOffUntil) {
      // Keep the sight check from switching direct mode back on until the time is up.
      this.sightTimer = 1;
      if (this.direct) {
        this.direct = false;
        this.resetPath();
      }
    }
    this.drive(dt);
    this.trackDirectBlock(dt);
    this.trackEmptyBlock(dt);
  }

  /**
   * Round a vehicle standing in the way that nobody drives (abandoned, or a wreck). A driver still on its lane that sees
   * one on its way ahead re-plans its way on round it there and then (see detourTurns). One held up by it, standing
   * still for over DETOUR_BLOCK s, re-plans too; brief stops do not count (the time decays otherwise). Already in the
   * junction on a way that passes it, it backs out first, behind the stop line, and plans again from there. One parked
   * on the lane the driver is on is left to overtaking: no turn goes round it.
   */
  private trackEmptyBlock(dt: number): void {
    // Pursuers get out of a hold-up their own way (trackDirectBlock, and the police deploy and recycle rules).
    if (this.policy === 'chase') return;
    const v = this.vehicle;
    const b = this.blocker as Vehicle | Character | null;
    const margin = v.halfW + DETOUR_MARGIN;
    let o = b && 'kind' in b && (!b.driver || b.destroyed) && b.speed < 0.5 ? b : null;
    const lane = this.segs[0]?.lane;
    if (o && this.onLaneAhead(o)) o = null;
    if (o && o !== this.avoid && lane && !this.pathClearOf(o, margin, DETOUR_LOOK, true)) {
      this.avoid = o;
      this.avoidAt = this.host.time;
      this.resetPath();
    }
    if (o && this.limiter === 'obstacle' && Math.abs(v.forwardSpeed) < 0.5) this.emptyBlocked += dt;
    else this.emptyBlocked = Math.max(0, this.emptyBlocked - dt);
    if (!o || this.emptyBlocked <= DETOUR_BLOCK) return;
    this.emptyBlocked = 0;
    this.avoid = o;
    this.avoidAt = this.host.time;
    this.resetPath();
    const now = this.segs[0]?.lane;
    // On its lane with every turn off it passing the vehicle, backing up makes no way round it.
    if (lane && now && this.detourTurns(now) === now.turns) return;
    if (!this.pathClearOf(o, margin, 12, true)) this.startReverse(0, 'queue', DETOUR_BACK);
  }

  /** Whether `o` stands on the rest of the lane we are on, short of its last DETOUR_LANE_END m (not in the junction after it). */
  private onLaneAhead(o: Vehicle): boolean {
    const seg = this.segs[0];
    const lane = seg?.lane;
    if (!seg || !lane) return false;
    const from = lane.length - seg.length + this.s;
    const to = Math.max(from, lane.length - DETOUR_LANE_END);
    return boxGap(o, lane.sx + lane.dx * from, lane.sz + lane.dz * from, lane.sx + lane.dx * to, lane.sz + lane.dz * to) < this.vehicle.halfW + DETOUR_MARGIN;
  }

  /**
   * Direct mode never overtakes, reverses out of a stuck spot or backs out of a face-off: a pursuer driving straight at
   * its target that a vehicle holds up (standing, for over DIRECT_BLOCK s) goes back to following the lanes for
   * DIRECT_SUPPRESS s, which do. Brief stops do not count: the time decays while the way is clear.
   */
  private trackDirectBlock(dt: number): void {
    const b = this.blocker as Vehicle | Character | null;
    if (this.policy === 'chase' && this.direct && this.limiter === 'obstacle' && Math.abs(this.vehicle.forwardSpeed) < 1 && b && 'kind' in b) this.directBlocked += dt;
    else this.directBlocked = Math.max(0, this.directBlocked - dt);
    if (this.directBlocked > DIRECT_BLOCK) {
      this.directBlocked = 0;
      this.directOffUntil = this.host.time + DIRECT_SUPPRESS;
      this.direct = false;
      this.resetPath();
    }
  }

  private drive(dt: number): void {
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
      this.reverseStill = Math.abs(v.forwardSpeed) < 0.2 ? this.reverseStill + dt : 0;
      c.throttle = 0;
      c.handbrake = false;
      const goal = this.reverseKind === 'retreat' ? this.retreatPoint() : null;
      c.steer = this.reverseKind === 'lane' ? this.laneReverseSteer() : goal ? this.reverseSteerTo(goal) : this.reverseSteer;
      // Back up slowly, and stop short of whatever is behind (pursuers use all the room there is).
      const back = -v.forwardSpeed;
      c.brake = this.reverseHard ? 1 : clamp((REVERSE_SPEED - back) * 0.8, 0, 1);
      const room = (this.obeyLights ? 1.2 : 0.5) + (back > 0 ? (back * back) / (2 * v.spec.brake) : 0);
      // Retreating, the tail swings round the cars beside us: check the way it heads. Once past
      // them, back into the lane.
      if (this.reverseKind === 'retreat' && !goal) {
        this.reverseKind = 'lane';
        this.reverseTimer = Math.max(this.reverseTimer, 5);
      }
      let waiting = false;
      if ((goal ? this.gapToward(goal) : this.gapBehind(v, this.reverseHard)) < room) {
        // Backing up to overtake waits for the car behind to make room (see makeRoom), and so does
        // backing out of a face-off for a car someone drives; other reverses end there, and so do
        // these at a wall or a prop, which will not move.
        const o = this.nearest;
        const backingOut = (this.reverseKind === 'yield' || this.reverseKind === 'lane' || this.reverseKind === 'retreat') && this.reverseTime < 3;
        if (!this.behindProp && ((this.passing && this.reverseKind === 'queue') || (backingOut && !!o && 'kind' in o && this.driven(o) !== null))) {
          c.brake = 0;
          c.throttle = back > 0.6 ? 1 : 0;
          if (this.reverseTime < 3) this.reverseTimer += dt;
          // (Standing still while it waits is not getting nowhere: it backs on once the room is there.)
          this.reverseStill = 0;
          waiting = true;
        } else {
          // The stuck rule's slow reverse stopped short of a lamp or a bin: the next one knocks it over.
          if (this.reverseKind === 'stuck' && this.behindProp?.breakable) this.pinned = true;
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
      if ((this.reverseKind === 'lane' || this.reverseKind === 'retreat') && this.backInLane()) this.reverseTimer = 0;
      // Pulling in: once the nose points in far enough to drive past what stands in the way (see
      // clearAhead), or as far in as it sensibly goes, drive in; also before the tail swings out past
      // the far curb of a street.
      if (this.reverseKind === 'pullIn' && ((this.noseIn() && (this.clearAhead(this.yielded) || this.noseInBy() > 1)) || this.tailOut() > STREET_W / 2 + LANE_W / 2)) this.reverseTimer = 0;
      // ...and before the body, swinging round on full lock, closes in on the car it makes way for: a long one's tail
      // swings out across that car's lane.
      if (this.reverseKind === 'pullIn' && this.yielded && !this.yielded.removed) {
        const g = bodyGapAt(v, v.pos.x, v.pos.z, v.heading, this.yielded);
        if (g < this.pullInGap && g < PULL_IN_CLEAR) this.reverseTimer = 0;
        this.pullInGap = Math.min(this.pullInGap, g);
      }
      // Giving way and getting nowhere (something behind that does not make room): stop pushing. A car
      // still braking from driving on (a pass called off at speed) is not getting nowhere.
      if (!waiting && this.reverseKind !== 'queue' && this.reverseKind !== 'stuck' && this.reverseStill > 0.6) this.reverseTimer = 0;
      if (this.reverseKind === 'yield') {
        // Until the car we give way to is back in its lane or well away, or has stopped using the room
        // (after the first 4 s).
        const o = this.yielded;
        const ai = o && !o.removed ? this.driven(o) : null;
        this.yieldStill = o && o.speed < 0.3 ? this.yieldStill + dt : 0;
        if (!ai || ai.laneIntrusion() < 0.1 || Math.hypot(o!.pos.x - v.pos.x, o!.pos.z - v.pos.z) > 20 || (this.reverseTime > 4 && this.yieldStill > 1.5)) this.reverseTimer = 0;
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
    // The speed a pursuer held back by the sea ahead would go at but for it (see the stuck rule).
    let intent = 0;
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
      // Never into the sea after him (the feelers see only walls): slow down to stop short of deep water ahead.
      const wet = this.waterAhead(v, (speed * speed) / (2 * this.decel) + 6);
      if (wet < Infinity) {
        // Stopped there, it still means to go after him when the way to him is dry: the stuck rule backs it up and
        // swings its nose round towards him. When he is out across the water, it waits at the water's edge.
        if (!this.waterOnWayTo(v, tp.x, tp.z)) intent = targetSpeed;
        targetSpeed = Math.min(targetSpeed, Math.sqrt(2 * this.decel * Math.max(0, wet - 3)));
      }
      steerX = aimX;
      steerZ = aimZ;
    } else {
      this.track();
      if (this.segs.length === 0) return;
      const look = 4.5 + Math.abs(speed) * 0.42;
      const p = this.pointAhead(look);
      aimX = p.x;
      aimZ = p.z;
      // Swing out to the left (into the oncoming lane) to pass whatever blocks us.
      const off = this.overtake > 0 ? this.swingOut() : 0;
      if (off > 0) {
        const q = this.pointAhead(look + 2);
        const tx = q.x - p.x;
        const tz = q.z - p.z;
        const tl = Math.hypot(tx, tz) || 1;
        aimX += (tz / tl) * off;
        aimZ += (-tx / tl) * off;
      }
      steerX = aimX;
      steerZ = aimZ;
      // Squeezing past, aim closer while swinging out: from close behind there is little room to get
      // out to the side.
      const sharp = this.squeeze && (this.overtake > 0 ? this.behindPassing() : this.merging);
      const near = sharp ? 2.5 + Math.abs(speed) * 0.2 : this.overtake > 0 ? look : this.steerLook(speed, look);
      if (near < look) {
        const q = this.pointAhead(near);
        steerX = q.x;
        steerZ = q.z;
        if (off > 0) {
          const r = this.pointAhead(near + 2);
          const tl = Math.hypot(r.x - q.x, r.z - q.z) || 1;
          steerX += ((r.z - q.z) / tl) * off;
          steerZ += (-(r.x - q.x) / tl) * off;
        }
      }
      targetSpeed = Math.min(this.segs[0]!.speed * this.speedMul, this.maxSpeed);
      targetSpeed = Math.min(targetSpeed, this.planSpeed());
      const dest = this.policy === 'route' ? this.dest : null;
      if (dest && !this.arrived && Math.hypot(v.pos.x - dest.x, v.pos.z - dest.z) <= this.arriveRadius) this.arrived = true;
      // There: brake to a stop on the lane (the hold above takes over once stopped).
      if (dest && this.arrived) targetSpeed = 0;
    }

    // Obstacles ahead (vehicles and pedestrians).
    // Having just given way in a face-off, a civilian goes round again as soon as the way is clear.
    const backedOut = this.host.time - this.yieldedAt < 30 && (this.yieldedHow === 'lane' || this.yieldedHow === 'retreat');
    const patience = this.policy === 'chase' || this.policy === 'flee' ? 0.9 : backedOut ? 2 : 7;
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
    if (this.overtake <= 0 && !this.merging) {
      this.squeeze = false;
      this.overtakeSince = Infinity;
    }
    let gap = this.scanAhead(v, aimX, aimZ);
    if (gap < Infinity) {
      const stopGap = Math.max(0, gap - 2.2);
      const vs = Math.sqrt(2 * this.decel * stopGap);
      if (vs < targetSpeed) {
        targetSpeed = vs;
        this.limiter = 'obstacle';
      }
      // (Pulled up behind a car, it is not stuck.)
      intent = Math.min(intent, vs);
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
    let retreat = false;
    let pullIn = false;
    const yieldMode = rival && this.faceOffTime > FACE_OFF_PATIENCE ? this.yieldsTo(rival) : null;
    if (rival && yieldMode) {
      this.faceOffTime = 0;
      this.yielded = rival;
      this.yieldedAt = this.host.time;
      this.yieldedHow = yieldMode;
      if (yieldMode === 'lane' || yieldMode === 'retreat') {
        this.overtake = 0;
        this.passing = null;
        this.retryOvertake(patience);
        backIntoLane = true;
        retreat = yieldMode === 'retreat';
      } else if (yieldMode === 'pullIn') {
        pullIn = true;
      } else {
        makeWay = true;
      }
    }
    let backUpToPass = false;
    // A vehicle nobody drives (abandoned, or a wreck) standing on our lane is not going to move off, and no detour goes
    // round it (see trackEmptyBlock): waiting out the full patience for it only lets the gaps in oncoming traffic go by,
    // and in busy traffic the next gap may be a long time coming. One in the junction is left to the detour.
    const unattended = !!ahead && 'kind' in ahead && (!ahead.driver || ahead.destroyed) && ahead.speed < 0.5 && this.onLaneAhead(ahead);
    const passPatience = unattended ? Math.min(patience, UNATTENDED_PATIENCE) : patience;
    // Civilians wait for a gap in oncoming traffic before pulling out, and for the passing lane to be
    // free. Nobody overtakes a car coming the other way (a face-off sorts that out).
    if (
      blocked &&
      !waiting &&
      this.blockedTime > passPatience &&
      // Having backed out of a face-off, take the overtake up again where the car stopped, or once it has slowed
      // behind what it passes: not while it rolls up to it, too close to swing out and too far to back up for room.
      (!backedOut || Math.abs(speed) < 3) &&
      this.overtake <= 0 &&
      !backIntoLane &&
      !makeWay &&
      !(ahead && 'kind' in ahead && this.driven(ahead) && Math.sin(ahead.heading) * fx + Math.cos(ahead.heading) * fz < -0.5) &&
      !(this.obeyLights && ahead && this.passingLaneTaken(ahead, this.passStretch(ahead, gap), (u) => 15 + u * 5))
    ) {
      this.overtake = this.obeyLights ? 8 : 6;
      this.passing = ahead;
      this.overtakeSince = this.host.time;
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

    // Stuck handling (also for a pursuer that the sea ahead holds back, see above).
    const wantsToMove = Math.max(targetSpeed, intent) > 2;
    if (wantsToMove && Math.abs(speed) < 0.7) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (blocked && !waiting && Math.abs(speed) < 0.5) {
      this.waitObstacle += dt;
      if (this.waitObstacle > 2.5 && this.honkCooldown <= 0 && this.policy === 'traffic') {
        this.honkCooldown = this.host.rng.range(2.5, 6);
        this.host.onHorn(v);
      }
      if (this.waitObstacle > 9) {
        // Make room, nose towards the passing side (not the curb), less so if it points out already.
        this.waitObstacle = 0;
        this.startReverse(this.outSteer(), 'queue');
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
    if (backIntoLane) this.startReverse(0, retreat ? 'retreat' : 'lane', retreat ? this.retreatTime() : 6);
    // Wheels away from the lane: the nose swings towards it, further in if it points in already (backing
    // straight up, it would drive the same line into the same car again).
    else if (pullIn) this.startReverse(-1, 'pullIn', 2.5);
    else if (makeWay) {
      this.yieldStill = 0;
      this.startReverse(0, 'yield', 10);
    }
    // Back up with the wheels turned away from where we want to go, less so the further an earlier
    // reverse has turned the nose out already: turning on would put the tail on the curb.
    else if (backUpToPass) this.startReverse(this.outSteer(), 'queue', 1.2);
    else if (makeRoom) this.startReverse(0, 'queue', 0.5);
    else if (this.stuck > (this.policy === 'chase' ? 1.1 : 1.8)) this.startReverse(lx >= 0 ? -1 : 1, 'stuck');
    this.trackProgress(dt, waiting || (!blocked && this.waitLine < Infinity));
  }

  /**
   * Steering for backing up to pull out to the left: full lock (the nose swings out), less the further
   * the nose points out already (turning on would put the tail on the curb).
   */
  private outSteer(): number {
    const f = this.laneFrame();
    const h = this.vehicle.heading;
    const out = Math.asin(clamp(Math.sin(h) * f.tz - Math.cos(h) * f.tx, -1, 1));
    return clamp((0.45 - out) / 0.3, 0, 1);
  }

  /**
   * Starts reversing. Queue manoeuvres and giving way stay below the speed at which street
   * furniture breaks; the stuck rule does too, unless its last try ended against something behind
   * (a lamp or a bin), which full power knocks over. People and cars behind are always spared.
   */
  private startReverse(steer: number, kind: ReverseKind, time = this.policy === 'chase' ? 1.0 : 1.4): void {
    if (kind === 'pullIn') this.pullInGap = this.yielded && !this.yielded.removed ? bodyGapAt(this.vehicle, this.vehicle.pos.x, this.vehicle.pos.z, this.vehicle.heading, this.yielded) : Infinity;
    this.reverseTimer = time;
    this.reverseTime = 0;
    this.reverseStill = 0;
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
    // Not yet 1 m behind our rear (less, squeezing past: the tail swings away from it as we pull in).
    const clear = this.squeeze ? SQUEEZE_PULL_IN : 1;
    const notPassed = (o: Vehicle | Character, half: number) => along(o) + half > -v.halfL - clear;
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
   * How far left of the planned path an overtake aims. Pursuers swing right out into the passing
   * lane; civilians only as far as it takes to clear what they pass.
   */
  private swingOut(): number {
    const p = this.passing;
    this.squeeze = false;
    if (!this.obeyLights || !p || p.removed) return 4.2;
    const v = this.vehicle;
    const f = this.laneFrame();
    const left = (p.pos.x - f.x) * f.tz - (p.pos.z - f.z) * f.tx;
    const across = 'kind' in p ? halfExtent(p, -f.tz, f.tx) : 0.4;
    const pa = (p.pos.x - v.pos.x) * f.tx + (p.pos.z - v.pos.z) * f.tz;
    const pe = 'kind' in p ? halfExtent(p, f.tx, f.tz) : 0.4;
    const end = this.queueFront(p);
    // A car standing in the passing lane beside it or not far beyond it (or beyond the cars queued
    // after it, which we pass in the same go): pass close, between the two, and pull back in before
    // the other one.
    for (const o of this.host.vehicles) {
      if (o === v || o === p || o.removed || o.speed > 0.5) continue;
      const ol = (o.pos.x - f.x) * f.tz - (o.pos.z - f.z) * f.tx;
      if (ol < LANE_W / 2 - 0.2 || ol > 1.5 * LANE_W + 0.3) continue;
      const oa = (o.pos.x - v.pos.x) * f.tx + (o.pos.z - v.pos.z) * f.tz;
      const oe = halfExtent(o, f.tx, f.tz);
      if (oa + oe < pa - pe - 1 || oa - oe > end + SQUEEZE_RANGE) continue;
      this.squeeze = true;
      const off = Math.min(4.2, left + across + v.halfW + SQUEEZE_CLEARANCE);
      // Out further than that already (an overtake taken up again while pulling in after the last
      // one): no turning back in towards what we pass before drawing level with it.
      if (!this.behindPassing()) return off;
      const out = (v.pos.x - f.x) * f.tz - (v.pos.z - f.z) * f.tx;
      return clamp(out, off, 4.2);
    }
    return 4.2;
  }

  /** Our front is still short of what we pass (along the lane). */
  private behindPassing(): boolean {
    const p = this.passing;
    if (!p) return false;
    const v = this.vehicle;
    const f = this.laneFrame();
    const rear = (p.pos.x - v.pos.x) * f.tx + (p.pos.z - v.pos.z) * f.tz - ('kind' in p ? halfExtent(p, f.tx, f.tz) : 0.4);
    return rear > v.halfL;
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

  /**
   * Whether `o`, standing in the passing lane, is in the way of an overtake of `p`: passing close by
   * `p` (see squeeze), the car would touch it, and it stands less than our length beyond `p` plus
   * the room it takes to pull back in far enough to clear it (1.5 m, plus 2 m a metre of sideways
   * shift, up to the 4 m it takes to pull right back in).
   */
  private inTheWay(p: Vehicle | Character, o: Vehicle): boolean {
    const v = this.vehicle;
    const f = this.laneFrame();
    const nx = -f.tz;
    const nz = f.tx;
    const pLeft = (p.pos.x - f.x) * f.tz - (p.pos.z - f.z) * f.tx + ('kind' in p ? halfExtent(p, nx, nz) : 0.4);
    const oRight = (o.pos.x - f.x) * f.tz - (o.pos.z - f.z) * f.tx - halfExtent(o, nx, nz);
    // How far the car must pull back in, once past `p`, to clear `o`.
    const shift = Math.min(4.2, pLeft + v.halfW + SQUEEZE_CLEARANCE) + v.halfW + SQUEEZE_MARGIN - oRight;
    if (shift <= 0) return false;
    const oNear = (o.pos.x - v.pos.x) * f.tx + (o.pos.z - v.pos.z) * f.tz - halfExtent(o, f.tx, f.tz);
    return oNear - this.queueFront(p) < 2 * v.halfL + SQUEEZE_PULL_IN + Math.min(4, 1.5 + 2 * shift);
  }

  /**
   * How far along our lane (from our centre) the front of what we pass reaches: `p`, and the cars
   * standing in its lane after it close enough for the same overtake to take them too (see
   * stillPassing, which counts those within 6 m of our front while we are still beside `p`).
   */
  private queueFront(p: Vehicle | Character): number {
    const v = this.vehicle;
    const f = this.laneFrame();
    const along = (o: Vehicle | Character) => (o.pos.x - v.pos.x) * f.tx + (o.pos.z - v.pos.z) * f.tz;
    const side = (o: Vehicle | Character) => (o.pos.x - f.x) * f.tz - (o.pos.z - f.z) * f.tx;
    const ps = side(p);
    let front = along(p) + ('kind' in p ? halfExtent(p, f.tx, f.tz) : 0.4);
    for (let k = 0; k < 6; k++) {
      let next = -Infinity;
      for (const o of this.host.vehicles) {
        if (o === v || o === p || o.removed || o.speed > 3 || Math.abs(side(o) - ps) > 2.5) continue;
        const ext = halfExtent(o, f.tx, f.tz);
        const rear = along(o) - ext;
        if (rear > front - 0.5 && rear < front + 2 * v.halfL + 7) next = Math.max(next, along(o) + ext);
      }
      if (next <= front) break;
      front = next;
    }
    return front;
  }

  /**
   * Whether `o` is a car overtaking (or pulling back in) the other way, facing our lane direction
   * (tx, tz): null if not; true if it started before us (we give way to it), false if we did (it
   * gives way to us). Ties go by id.
   */
  private claimed(o: Vehicle, tx: number, tz: number): boolean | null {
    const ai = this.driven(o);
    if (!ai || !ai.obeyLights || (ai.overtake <= 0 && !ai.merging)) return null;
    if (Math.sin(o.heading) * tx + Math.cos(o.heading) * tz > -0.7) return null;
    if (this.overtake <= 0 && !this.merging) return true;
    return ai.overtakeSince < this.overtakeSince || (ai.overtakeSince === this.overtakeSince && o.id < this.vehicle.id);
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
      // Backing up to let us through (see facePlan).
      if (o.ai && o.ai.reverseTimer > 0 && o.ai.reverseKind === 'yield' && o.ai.yielded === v) continue;
      const along = (o.pos.x - v.pos.x) * f.tx + (o.pos.z - v.pos.z) * f.tz;
      // Gone past us.
      if (along + o.halfL < -v.halfL - 1) continue;
      const gap = along - o.halfL - v.halfL;
      const coming = -(o.vel.x * f.tx + o.vel.z * f.tz);
      const left = (o.pos.x - f.x) * f.tz - (o.pos.z - f.z) * f.tx;
      // A car overtaking towards us, in either lane: the first one to start goes first.
      const claim = this.claimed(o, f.tx, f.tz);
      if (claim !== null && left > -LANE_W / 2 && left < 1.5 * LANE_W + 0.3) {
        if (claim && gap < CLAIM_RANGE) return true;
        continue;
      }
      if (left > LANE_W / 2 - 0.2 && left < 1.5 * LANE_W + 0.3) {
        if (coming > 1 ? gap < range(coming) : gap < stretch && this.inTheWay(except, o)) return true;
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
    return this.reverseSteerTo(q);
  }

  /** Steering to back up towards `q`: pure pursuit, in reverse (0 unless `q` is behind the car). */
  private reverseSteerTo(q: { x: number; z: number }): number {
    const v = this.vehicle;
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

  /**
   * Plans a retreat (see retreatPoint) from the cars in our lane beside us (from `reach` m behind our
   * rear to 0.5 m past our front), and those behind them with less than a car length plus 4 m between
   * any two, too little to back in between: false when no car in our lane is beside us.
   */
  private planRetreat(reach = 1.5): boolean {
    const v = this.vehicle;
    const f = this.laneFrame();
    const cars: { rear: number; front: number; left: number }[] = [];
    for (const o of this.host.vehicles) {
      if (o === v || o.removed) continue;
      const a = (o.pos.x - v.pos.x) * f.tx + (o.pos.z - v.pos.z) * f.tz;
      const l = (o.pos.x - f.x) * f.tz - (o.pos.z - f.z) * f.tx;
      const ea = halfExtent(o, f.tx, f.tz);
      if (Math.abs(l) > LANE_W / 2 + 0.5 || a - ea > v.halfL + 0.5 || a + ea < -60) continue;
      cars.push({ rear: a - ea, front: a + ea, left: l + halfExtent(o, -f.tz, f.tx) });
    }
    cars.sort((p, q) => q.front - p.front);
    let rear = Infinity;
    let clear = 0;
    for (const c of cars) {
      const beside = c.front > -v.halfL - reach;
      if (!beside && (rear === Infinity || c.front < rear - (2 * v.halfL + 4))) continue;
      rear = Math.min(rear, c.rear);
      clear = Math.max(clear, c.left + v.halfW + 0.6);
    }
    if (rear === Infinity) return false;
    // (The frame point stays at the start of the planned path when the car is behind it.)
    const at = (v.pos.x - f.x) * f.tx + (v.pos.z - f.z) * f.tz + rear;
    this.retreatTo = { x: f.x + f.tx * at, z: f.z + f.tz * at, off: Math.min(clear, LANE_W) };
    return true;
  }

  /**
   * Where a retreat heads: 6 m back along our lane, out to its side far enough to clear the cars it
   * backs out round (see planRetreat). Null once our front is 0.5 m behind the last of them: backing
   * into the lane is then the way on.
   */
  private retreatPoint(): { x: number; z: number } | null {
    const r = this.retreatTo;
    if (!r) return null;
    const v = this.vehicle;
    const f = this.laneFrame();
    const ahead = (v.pos.x - r.x) * f.tx + (v.pos.z - r.z) * f.tz;
    if (ahead + v.halfL < -0.5) return null;
    // 6 m back from the car's own place along the lane (the frame point stays at the start of the
    // planned path when the car is behind it), no nearer the lane than the car already is.
    const back = (v.pos.x - f.x) * f.tx + (v.pos.z - f.z) * f.tz - 6;
    const off = clamp((v.pos.x - f.x) * f.tz - (v.pos.z - f.z) * f.tx, r.off, LANE_W);
    return { x: f.x + f.tx * back + f.tz * off, z: f.z + f.tz * back - f.tx * off };
  }

  /**
   * Seconds a retreat takes to back past the cars it backs out round (see retreatPoint) at the
   * reversing speed; the lane phase after it gets time of its own (see update).
   */
  private retreatTime(): number {
    const r = this.retreatTo;
    if (!r) return 8;
    const v = this.vehicle;
    const f = this.laneFrame();
    const way = (v.pos.x - r.x) * f.tx + (v.pos.z - r.z) * f.tz + v.halfL + 0.5;
    return clamp(way / (REVERSE_SPEED * 0.85) + 2, 4, 16);
  }

  /**
   * Free distance from the rear bumper for a retreat towards `q`: towards it, to vehicles, people,
   * walls and props; and straight back, over the 2.5 m the tail covers before the steering has turned
   * it, to people, walls, props and the cars wholly behind us (the cars beside us it steers round
   * count towards `q` only). The nearest vehicle or person is kept in `nearest`.
   */
  private gapToward(q: { x: number; z: number }): number {
    const v = this.vehicle;
    const dx = q.x - v.pos.x;
    const dz = q.z - v.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    const gap = this.corridor(v, dx / l, dz / l, 6, 0.3, 0.6, null, false);
    let wall = this.staticBehind(v, dx / l, dz / l, 6, 0.3, false);
    let prop = this.behindProp;
    const bx = -Math.sin(v.heading);
    const bz = -Math.cos(v.heading);
    // (Ranges run from the centre of the car for people, from the rear bumper for walls and props.)
    const found = this.nearest;
    const people = this.peopleGap(v, bx, bz, v.halfL + 2.5, 0.6, null);
    const near = this.staticBehind(v, bx, bz, 2.5, 0.3, false);
    if (near < wall) {
      wall = near;
      prop = this.behindProp;
    }
    // Cars straight back count too, all but those beside us (they overlap our length).
    let cars = Infinity;
    let car: Vehicle | null = null;
    for (const o of this.host.vehicles) {
      if (o === v || o.removed) continue;
      const ox = o.pos.x - v.pos.x;
      const oz = o.pos.z - v.pos.z;
      const along = ox * bx + oz * bz;
      const g = along - v.halfL - halfExtent(o, bx, bz);
      if (g < -0.3 || g > 2.5 || Math.abs(ox * -bz + oz * bx) > v.halfW + halfExtent(o, -bz, bx) + 0.3) continue;
      if (g < cars) {
        cars = g;
        car = o;
      }
    }
    const nearest = Math.min(gap, people, cars);
    this.nearest = cars === nearest ? car : people === nearest ? this.nearestPerson : found;
    this.behindProp = wall < nearest ? prop : null;
    return Math.min(nearest, wall);
  }

  /** The nose points at least 0.4 rad to the right of our lane, into it from the passing side. */
  private noseIn(): boolean {
    return this.noseInBy() > 0.4;
  }

  /**
   * How far left of our lane's centre line the left rear corner of the body is (STREET_W / 2 +
   * LANE_W / 2 is the far curb of a one-lane street).
   */
  private tailOut(): number {
    const v = this.vehicle;
    const f = this.laneFrame();
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const cx = v.pos.x - fx * v.halfL + fz * v.halfW;
    const cz = v.pos.z - fz * v.halfL - fx * v.halfW;
    return (cx - f.x) * f.tz - (cz - f.z) * f.tx;
  }

  /** How far (rad) the nose points to the right of our lane, into it from the passing side. */
  private noseInBy(): number {
    const f = this.laneFrame();
    return -Math.asin(clamp(Math.sin(this.vehicle.heading) * f.tz - Math.cos(this.vehicle.heading) * f.tx, -1, 1));
  }

  /**
   * Driving on from here leaves `o` alone: it is out of the scan corridor (see corridor) both along our
   * heading and towards a lane point 4.5 m ahead, which the steering turns us to as we pull in.
   */
  private clearAhead(o: Vehicle | null): boolean {
    if (!o || o.removed) return true;
    const v = this.vehicle;
    const f = this.laneFrame();
    const hx = Math.sin(v.heading);
    const hz = Math.cos(v.heading);
    const ax = f.x + f.tx * 4.5 - v.pos.x;
    const az = f.z + f.tz * 4.5 - v.pos.z;
    const al = Math.hypot(ax, az) || 1;
    const clear = (fx: number, fz: number) => {
      const ox = o.pos.x - v.pos.x;
      const oz = o.pos.z - v.pos.z;
      if (ox * fx + oz * fz <= 0) return true;
      const ofx = Math.sin(o.heading);
      const ofz = Math.cos(o.heading);
      const side = Math.abs(ofx * -fz + ofz * fx) * o.halfL + Math.abs(ofx * fx + ofz * fz) * o.halfW;
      return Math.abs(ox * -fz + oz * fx) > v.halfW + side + 0.5;
    };
    return clear(hx, hz) && clear(ax / al, az / al);
  }

  /** No vehicle in our lane from 1 m behind our rear to 4 m past our front: room to pull in there. */
  private laneFreeBeside(): boolean {
    const v = this.vehicle;
    const f = this.laneFrame();
    for (const o of this.host.vehicles) {
      if (o === v || o.removed) continue;
      const a = (o.pos.x - v.pos.x) * f.tx + (o.pos.z - v.pos.z) * f.tz;
      const l = (o.pos.x - f.x) * f.tz - (o.pos.z - f.z) * f.tx;
      const ea = halfExtent(o, f.tx, f.tz);
      if (Math.abs(l) < LANE_W / 2 + 0.5 && a + ea > -v.halfL - 1 && a - ea < v.halfL + 4) return false;
    }
    return true;
  }

  /** A car stopped nose to nose with us, one of us blocking the other (null if none). */
  private faceOff(): Vehicle | null {
    const v = this.vehicle;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    for (const o of this.host.vehicles) {
      if (o === v || o.removed || o.speed > 0.5) continue;
      if (this.blocker !== o && o.ai?.blocker !== v) continue;
      // Within 60 degrees of head-on: a car turning its nose in to pull in is still in the face-off.
      if (Math.sin(o.heading) * fx + Math.cos(o.heading) * fz > -0.5) continue;
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
   * How we give way in a face-off with `o`, if we do. Both cars work out the same plan (see
   * facePlan) from the same state, so when one of them waits for the other, the other one moves.
   * Only one of the two reverses at a time.
   */
  private yieldsTo(o: Vehicle): YieldMode | null {
    const ai = this.driven(o);
    if (ai && ai.reverseTimer > 0) return null;
    const v = this.vehicle;
    const mine = this.laneIntrusion();
    const theirs = ai ? ai.laneIntrusion() : -Infinity;
    const outOfLane = (a: number, b: number, first: boolean) => a > 0.3 && (a > b + 0.2 || (a > b - 0.2 && first));
    let plan: FacePlan | null = null;
    if (outOfLane(mine, theirs, v.id < o.id)) plan = this.facePlan(this, ai, o);
    else if (ai && outOfLane(theirs, mine, o.id < v.id)) plan = this.facePlan(ai, this, v);
    return plan && plan.by === this ? plan.mode : null;
  }

  /**
   * Who gives way in a face-off between `x`, the car out of its lane, and the car `yv` that `y`
   * drives (null when nobody does), and how. The other one backs up to let `x` through ('back') when
   * it has room and `x` is pulling in past what it overtook, already backed away from it once, or is
   * overtaking cars of its own lane beside it. Otherwise `x` gives way itself. Past what it overtook,
   * with its lane free beside it and room to turn its nose in ahead of the other car (see canTurnIn),
   * it backs up turning the nose in and pulls in ('pullIn'; not twice running for the same car). With
   * cars of its lane beside it, or too close behind it to back in ahead of them, it backs out the way
   * it came, round them ('retreat'). Otherwise it backs into its lane ('lane'). When `x` cannot do
   * that, the other one backs up if it has room; failing that, whichever has a driven car close behind
   * it backs up all the same, the other car first, its reverse waiting for that car to make room (see
   * update). Null only when both are boxed in by what cannot move.
   */
  private facePlan(x: DriverAI, y: DriverAI | null, yv: Vehicle): FacePlan | null {
    const recently = (d: DriverAI, from: Vehicle) => d.yielded === from && this.host.time - d.yieldedAt < 20;
    const yCanBack = !!y && y.roomBehind();
    const beside = x.planRetreat();
    if (y && yCanBack && (x.merging || recently(x, yv) || (beside && x.overtake > 0))) return { by: y, mode: 'back' };
    if (x.merging && x.laneFreeBeside() && !(recently(x, yv) && x.yieldedHow === 'pullIn') && x.canTurnIn(yv)) {
      if (x.gapBehind(x.vehicle) > 1.5) return { by: x, mode: 'pullIn' };
    } else if (beside || x.planRetreat(2 * x.vehicle.halfL + 2)) {
      // Cars of its lane beside it or not far enough behind to back in in front of them: back out round them.
      const q = x.retreatPoint();
      if (q && x.gapToward(q) > 2) return { by: x, mode: 'retreat' };
    } else if (x.roomBehind()) {
      return { by: x, mode: 'lane' };
    }
    if (y && yCanBack) return { by: y, mode: 'back' };
    if (y && y.carBehind()) return { by: y, mode: 'back' };
    if (x.carBehind()) return { by: x, mode: beside ? 'retreat' : 'lane' };
    return null;
  }

  /**
   * Turning the nose in can take us past `o`, nose to nose with us: our left front corner has to move
   * across to clear the side of `o` nearest our lane (with 0.3 m to spare) by no more than 0.5 m plus
   * half the gap between the two, which the turn-in makes up. From further out in the passing lane,
   * the pull-in only swings the tail out and the nose stays in the other car's way.
   */
  private canTurnIn(o: Vehicle): boolean {
    const v = this.vehicle;
    const f = this.laneFrame();
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    // Left front corner of our body, and the side of `o` nearest our lane, as offsets left of our lane.
    const cx = v.pos.x + fx * v.halfL + fz * v.halfW;
    const cz = v.pos.z + fz * v.halfL - fx * v.halfW;
    const corner = (cx - f.x) * f.tz - (cz - f.z) * f.tx;
    const side = (o.pos.x - f.x) * f.tz - (o.pos.z - f.z) * f.tx - halfExtent(o, -f.tz, f.tx);
    const gap = (o.pos.x - v.pos.x) * fx + (o.pos.z - v.pos.z) * fz - v.halfL - halfExtent(o, fx, fz);
    return corner + 0.3 - side < 0.5 + 0.5 * Math.max(0, gap);
  }

  /** A car driven by someone right behind us, which makes room when we back towards it (see makeRoom). */
  private carBehind(): boolean {
    const gap = this.gapBehind(this.vehicle);
    const o = this.nearest;
    return gap < 6 && !this.behindProp && !!o && 'kind' in o && this.driven(o) !== null;
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
      if (d > ONCOMING_REACH) continue;
      // Heading towards the node, roughly opposite to us.
      const ofx = Math.sin(o.heading);
      const ofz = Math.cos(o.heading);
      if (ofx * lane.dx + ofz * lane.dz > -0.7) continue;
      const closing = (dx * o.vel.x + dz * o.vel.z) / (d || 1);
      if (closing < 1) continue;
      // Other drivers brake for a turner they meet; the player's car is judged by when it gets here.
      if (d > 38 && (!o.driver?.isPlayer || d / closing > ONCOMING_TIME)) continue;
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
    // Overtaking or pulling back in, a car standing beside us (along our length) is only in the way if driving on takes us
    // nearer to it (see clearBeside). The corridor's extents take in a car at an angle beside us that we pull away from:
    // a bus turning in past a car coming the other way stopped with its tail out, and one passing a bus stood wedged.
    const beside = this.overtake > 0 || this.merging ? (o: Vehicle, gap: number, margin: number) => gap < 0 && o.speed < 0.5 && this.clearBeside(o, aimX, aimZ, range, margin) : null;
    this.blockerGap = this.corridor(v, fx, fz, range, 0.5, 0.9, ignore, this.overtake <= 0 && !this.merging && this.pathOffset < 1.5, this.squeeze ? SQUEEZE_MARGIN : 0.5, beside);
    this.blocker = this.nearest;
    return this.blockerGap;
  }

  /**
   * Whether driving on leaves `o`, standing beside us, alone: straight on, and round the arc the steering takes towards
   * (aimX, aimZ) within full lock, the body comes no nearer to it over the next `range` m (10 at most) than it is now or
   * than `keep` m, whichever is less, and it does not touch it now. The body turns about its centre as it goes (see
   * vehiclePhysics), so the tail of a long one swinging out on the arc counts.
   */
  private clearBeside(o: Vehicle, aimX: number, aimZ: number, range: number, keep: number): boolean {
    const v = this.vehicle;
    const now = bodyGapAt(v, v.pos.x, v.pos.z, v.heading, o);
    if (now <= 0.05) return false;
    const floor = Math.min(now, keep) - 0.01;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const dx = aimX - v.pos.x;
    const dz = aimZ - v.pos.z;
    // Pure pursuit, as update() steers (> 0 turns right: the heading decreases), within full lock.
    const lx = dx * -fz + dz * fx;
    const lz = dx * fx + dz * fz;
    const maxCurve = Math.tan(v.spec.steer / (1 + Math.abs(v.forwardSpeed) / 15)) / (v.spec.length * 0.6);
    const curve = lz < 0 ? (lx >= 0 ? maxCurve : -maxCurve) : clamp((2 * lx) / Math.max(1, lx * lx + lz * lz), -maxCurve, maxCurve);
    const reach = Math.min(range, 10);
    for (let k = 0; k < 2; k++) {
      const c = k === 0 ? 0 : curve;
      if (k === 1 && Math.abs(c) < 1e-4) break;
      let x = v.pos.x;
      let z = v.pos.z;
      let h = v.heading;
      for (let s = BESIDE_STEP; s <= reach + 1e-9; s += BESIDE_STEP) {
        x += Math.sin(h) * BESIDE_STEP;
        z += Math.cos(h) * BESIDE_STEP;
        h -= c * BESIDE_STEP;
        if (bodyGapAt(v, x, z, h, o) < floor) return false;
      }
    }
    return true;
  }

  /**
   * True if the planned path over the next `ahead` metres keeps `margin` clear of the body of `o`; with `exact`, measured
   * to its footprint (beyond the ends of the path's stretches too) rather than across the stretches only.
   */
  private pathClearOf(o: Vehicle, margin: number, ahead: number, exact = false): boolean {
    let start = -this.s;
    for (const seg of this.segs) {
      if (start > ahead) break;
      const p = seg.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        if (start + seg.cum[i / 2 + 1]! < 0) continue;
        if (start + seg.cum[i / 2]! > ahead) break;
        if (exact ? boxGap(o, p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!) < margin : !stretchClearOf(o, margin, p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!)) return false;
      }
      start += seg.length;
    }
    return true;
  }

  /**
   * Free distance behind the rear bumper, checked while reversing: to vehicles and people, and to
   * walls, buildings and street furniture (the nearest of those is kept in `behindProp` when it is
   * nearer than any vehicle or person). With `pushThrough`, props that break are left out: the stuck
   * rule's full-power reverse knocks them over.
   */
  private gapBehind(v: Vehicle, pushThrough = false): number {
    const bx = -Math.sin(v.heading);
    const bz = -Math.cos(v.heading);
    const gap = this.corridor(v, bx, bz, 6, 0.3, 0.6, null, false);
    const wall = this.staticBehind(v, bx, bz, 6, 0.3, pushThrough);
    if (wall < gap) return wall;
    this.behindProp = null;
    return gap;
  }

  /**
   * Distance from the rear bumper to the nearest static collider the body would back into, within
   * `range` behind it and `margin` of its sides (stored in `behindProp`; Infinity if none).
   */
  private staticBehind(v: Vehicle, bx: number, bz: number, range: number, margin: number, pushThrough: boolean): number {
    // Right of the heading, in the frame whose `a` axis points backwards.
    const rx = bz;
    const rz = -bx;
    const w = v.halfW + margin;
    const a0 = v.halfL;
    // Bounds of the strip behind the car: its middle, give or take half its length and width.
    const mid = a0 + range / 2;
    const cx = v.pos.x + bx * mid;
    const cz = v.pos.z + bz * mid;
    const ex = Math.abs(bx) * (range / 2) + Math.abs(rx) * w;
    const ez = Math.abs(bz) * (range / 2) + Math.abs(rz) * w;
    const minX = cx - ex;
    const minZ = cz - ez;
    const maxX = cx + ex;
    const maxZ = cz + ez;
    const bottom = v.pos.y + 0.25;
    const top = v.pos.y + v.spec.height;
    let best = Infinity;
    let found: StaticCollider | null = null;
    this.host.world.grid.query(minX, minZ, maxX, maxZ, (c) => {
      if (c.y1 < bottom || c.y0 > top || (pushThrough && c.breakable)) return;
      let a: number;
      if (c.circle) {
        const ox = c.cx - v.pos.x;
        const oz = c.cz - v.pos.z;
        const ca = ox * bx + oz * bz;
        const out = Math.max(0, Math.abs(ox * rx + oz * rz) - w);
        if (out >= c.r) return;
        const reach = Math.sqrt(c.r * c.r - out * out);
        // Wholly beside or ahead of the rear bumper.
        if (ca + reach < a0) return;
        a = Math.max(a0, ca - reach);
      } else {
        a = boxBehind(c, v.pos.x, v.pos.z, bx, bz, a0, w);
      }
      if (a - a0 < best) {
        best = a - a0;
        found = c;
      }
    });
    this.behindProp = found;
    return best;
  }

  /**
   * Bumper gap to the nearest vehicle or person in a corridor from `v` along (fx, fz), which is
   * stored in `nearest`. People count when a vehicle can run them over, knocked down ones included.
   * With `onPath`, oncoming vehicles that the planned path keeps clear of are ignored: they are in
   * their own lane, even when the corridor of a car still turning sweeps across it. Vehicles standing
   * still (under 0.5 m/s) get `standingMargin` instead of `carMargin` (see squeeze). Vehicles for which
   * `beside` (given the bumper gap and the margin) holds are left out too (see scanAhead).
   */
  private corridor(
    v: Vehicle,
    fx: number,
    fz: number,
    range: number,
    carMargin: number,
    pedMargin: number,
    ignore: Character | Vehicle | null,
    onPath: boolean,
    standingMargin = carMargin,
    beside: ((o: Vehicle, gap: number, margin: number) => boolean) | null = null,
  ): number {
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
      const margin = o.speed < 0.5 ? standingMargin : carMargin;
      if (lat > v.halfW + extSide + margin) continue;
      if (onPath && ofx * hx + ofz * hz < -0.7 && this.pathClearOf(o, v.halfW + 0.8, range + 6)) continue;
      // The vehicle a detour goes round sits ahead of a straight look at the start of the turn that passes it.
      if (onPath && o === this.avoid && this.avoiding() && o.speed < 0.5 && this.pathClearOf(o, v.halfW + DETOUR_MARGIN, range + 6, true)) continue;
      const gap = along - v.halfL - extAlong;
      if (gap < best && !(beside && beside(o, gap, margin))) {
        best = gap;
        found = o;
      }
    }
    const people = this.peopleGap(v, fx, fz, range, pedMargin, ignore);
    if (people < best) {
      best = people;
      found = this.nearestPerson;
    }
    this.nearest = found;
    return best;
  }

  /**
   * The people part of `corridor`: bumper gap to the nearest person a vehicle can run over (knocked
   * down ones included) in the corridor, who is kept in `nearestPerson`.
   */
  private peopleGap(v: Vehicle, fx: number, fz: number, range: number, pedMargin: number, ignore: Character | Vehicle | null): number {
    const rx = -fz;
    const rz = fx;
    let best = Infinity;
    let found: Character | null = null;
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
    this.nearestPerson = found;
    return best;
  }

  /**
   * Metres from the front of `v`, straight ahead, to water deeper than DIRECT_WADE (sampled every 2 m, out to `reach`),
   * Infinity when there is none.
   */
  private waterAhead(v: Vehicle, reach: number): number {
    const world = this.host.world;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    for (let s = 0; s <= reach; s += 2) {
      if (world.waterDepth(v.pos.x + fx * (v.halfL + s), v.pos.z + fz * (v.halfL + s)) > DIRECT_WADE) return s;
    }
    return Infinity;
  }

  /**
   * True when the straight way from `v` to (x, z) runs through water deeper than DIRECT_WADE (sampled at most 2 m apart,
   * from where it stands to (x, z) itself). Standing in water that deep itself, backing up could take it deeper.
   */
  private waterOnWayTo(v: Vehicle, x: number, z: number): boolean {
    const world = this.host.world;
    const n = Math.ceil(Math.hypot(x - v.pos.x, z - v.pos.z) / 2);
    for (let i = 0; i <= n; i++) {
      const k = n > 0 ? i / n : 0;
      if (world.waterDepth(v.pos.x + (x - v.pos.x) * k, v.pos.z + (z - v.pos.z) * k) > DIRECT_WADE) return true;
    }
    return false;
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

/** Half the extent of vehicle `o` along the unit direction (nx, nz). */
function halfExtent(o: Vehicle, nx: number, nz: number): number {
  const fx = Math.sin(o.heading);
  const fz = Math.cos(o.heading);
  return Math.abs(fx * nx + fz * nz) * o.halfL + Math.abs(fx * nz - fz * nx) * o.halfW;
}

/** Distance from (px, pz) to the body centred on (cx, cz) with forward axis (fx, fz) and half sizes hl, hw (0 inside it). */
function pointToBody(px: number, pz: number, cx: number, cz: number, fx: number, fz: number, hl: number, hw: number): number {
  const dx = px - cx;
  const dz = pz - cz;
  const a = Math.abs(dx * fx + dz * fz) - hl;
  const b = Math.abs(dx * fz - dz * fx) - hw;
  return Math.hypot(Math.max(a, 0), Math.max(b, 0));
}

/** Distance between the body of `a`, placed at (x, z) with heading h, and the body of `b`: 0 when they overlap. */
export function bodyGapAt(a: Vehicle, x: number, z: number, h: number, b: Vehicle): number {
  const afx = Math.sin(h);
  const afz = Math.cos(h);
  const bfx = Math.sin(b.heading);
  const bfz = Math.cos(b.heading);
  const dx = x - b.pos.x;
  const dz = z - b.pos.z;
  // Separating axes: the four face normals.
  let apart = false;
  for (let i = 0; i < 4 && !apart; i++) {
    const ux = i === 0 ? afx : i === 1 ? afz : i === 2 ? bfx : bfz;
    const uz = i === 0 ? afz : i === 1 ? -afx : i === 2 ? bfz : -bfx;
    const ra = a.halfL * Math.abs(afx * ux + afz * uz) + a.halfW * Math.abs(afz * ux - afx * uz);
    const rb = b.halfL * Math.abs(bfx * ux + bfz * uz) + b.halfW * Math.abs(bfz * ux - bfx * uz);
    apart = Math.abs(dx * ux + dz * uz) > ra + rb;
  }
  if (!apart) return 0;
  // Apart, the nearest points include a corner of one of the two.
  let m = Infinity;
  for (let i = 1; i >= -1; i -= 2) {
    for (let j = 1; j >= -1; j -= 2) {
      m = Math.min(m, pointToBody(x + afx * a.halfL * i + afz * a.halfW * j, z + afz * a.halfL * i - afx * a.halfW * j, b.pos.x, b.pos.z, bfx, bfz, b.halfL, b.halfW));
      m = Math.min(m, pointToBody(b.pos.x + bfx * b.halfL * i + bfz * b.halfW * j, b.pos.z + bfz * b.halfL * i - bfx * b.halfW * j, x, z, afx, afz, a.halfL, a.halfW));
    }
  }
  return m;
}

/** Scratch polygons for boxBehind: (a, l) pairs. */
const clipA = new Float64Array(32);
const clipB = new Float64Array(32);

/**
 * Clips the polygon of `n` (a, l) points in `src` to the half-plane k * (coord - limit) >= 0, where
 * coord is a (axis 0) or l (axis 1), into `dst`; returns the new point count.
 */
function clipPoly(src: Float64Array, n: number, dst: Float64Array, axis: 0 | 1, limit: number, k: 1 | -1): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const pa = src[i * 2]!;
    const pl = src[i * 2 + 1]!;
    const qa = src[j * 2]!;
    const ql = src[j * 2 + 1]!;
    const dp = k * ((axis === 0 ? pa : pl) - limit);
    const dq = k * ((axis === 0 ? qa : ql) - limit);
    if (dp >= 0) {
      dst[m * 2] = pa;
      dst[m * 2 + 1] = pl;
      m++;
    }
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      dst[m * 2] = pa + (qa - pa) * t;
      dst[m * 2 + 1] = pl + (ql - pl) * t;
      m++;
    }
  }
  return m;
}

/**
 * The smallest `a` over the part of box `c` with a >= a0 and |l| <= w, in the frame centred on
 * (ox, oz) whose `a` axis is (bx, bz) and whose `l` axis is (bz, -bx); Infinity when that part is empty.
 */
function boxBehind(c: AABB, ox: number, oz: number, bx: number, bz: number, a0: number, w: number): number {
  const corners = [c.minX, c.minZ, c.maxX, c.minZ, c.maxX, c.maxZ, c.minX, c.maxZ];
  for (let i = 0; i < 4; i++) {
    const dx = corners[i * 2]! - ox;
    const dz = corners[i * 2 + 1]! - oz;
    clipA[i * 2] = dx * bx + dz * bz;
    clipA[i * 2 + 1] = dx * bz - dz * bx;
  }
  let n = clipPoly(clipA, 4, clipB, 1, w, -1);
  n = clipPoly(clipB, n, clipA, 1, -w, 1);
  n = clipPoly(clipA, n, clipB, 0, a0, 1);
  let best = Infinity;
  for (let i = 0; i < n; i++) best = Math.min(best, clipB[i * 2]!);
  return best;
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
