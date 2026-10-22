// Streams ambient traffic and parked cars in and out around the player.

import { axisOf, type Lane } from '../world/roads';
import { pointSegDist } from '../core/math';
import type { Rng } from '../core/rng';
import { WATER_Y } from '../world/constants';
import { STOP_MARGIN } from './driver';
import type { Vehicle } from './entities';
import type { Sim } from './sim';
import { PARKED_MIX, TRAFFIC_MIX, VEHICLE_SPECS, type VehicleKind } from './specs';
import { clearOfVehicles } from './vehicleRoom';

/** Above this speed (m/s) the player outruns the traffic streamed around him: spawn ahead too. */
const AHEAD_SPEED = 8;
/** Spawn tries (of 12) taken first from the lanes ahead, and their distance band from the player (m). */
const AHEAD_TRIES = 7;
const AHEAD_MIN = 45;
const AHEAD_MAX = 200;
/** Cars this far behind a fast player (m), out of view, make room for cars ahead. */
const RECYCLE_BEHIND = 120;
/** Junctions ahead whose cross streets get traffic. */
const AHEAD_JUNCTIONS = 3;
/** Cross traffic waits this far (m) before the stop line, just round the corner. */
const QUEUE_NEAR = 6;
const QUEUE_FAR = 10;
/** Seconds the cross street needs a green before the player arrives for its cars to be out in front of him. */
const CROSS_LEAD = 3;
/**
 * A parked car streams into a bay only with no other vehicle's centre within BAY_SPACING m of the bay's centre
 * (neighbouring bays are 3.2 m apart, so a lot fills every other bay at most) and no vehicle's footprint within
 * vehicleRoom's ROOM_GAP (0.3 m) of its own: a long or crooked car standing over the bay from further off (a bus,
 * a car left across the bays) keeps it empty. One above or below it (in the air) does not, as vehicles at
 * different heights do not collide (see collideVehicles).
 */
const BAY_SPACING = 3.5;
/**
 * A vehicle nobody is in, standing in a junction, that has held up traffic for TOW_BLOCK s is towed away out of the
 * player's view, as drivers that cannot detour round it would otherwise wait for good. Drivers held up by it back off,
 * re-plan and wait out red lights in between (a red phase is about 16 s): the hold-up only ends once nobody has stood
 * held up by it for TOW_GAP s.
 * The car the player left is kept while he is within TOW_KEEP_NEAR m of it, in view or not, and a car someone is
 * getting into, a police unit or a mission car is never towed.
 */
const TOW_BLOCK = 30;
const TOW_GAP = 20;
const TOW_KEEP_NEAR = 20;

/** A stretch of lane to spawn on: distances s0-s1 along it. */
interface SpawnSpan {
  lane: Lane;
  s0: number;
  s1: number;
}

export class TrafficSystem {
  private timer = 0;
  private parkedTimer = 0;
  private laneTimer = 0;
  private nearLanes: Lane[] = [];
  /** Running totals of the near lanes' pick weights. */
  private nearCum: number[] = [];
  /** Where cross traffic queues at the junctions ahead of a fast player (see refreshAhead). */
  private aheadSpans: SpawnSpan[] = [];
  private aheadCum: number[] = [];
  private aheadTime = -Infinity;
  /** The lanes of the road a fast player is about to drive down, his way (see refreshAhead). */
  private aheadPath = new Set<Lane>();
  readonly parkedBySpot = new Map<number, Vehicle>();
  /** Since when each vehicle nobody is in has held up traffic in a junction, and when it last did (see TOW_BLOCK). */
  private readonly blockTime = new Map<Vehicle, { since: number; last: number }>();
  /** Multiplier for traffic density (settings / tests). */
  density = 1;

  constructor(private readonly sim: Sim) {}

  get targetCount(): number {
    const h = this.sim.clock.hours;
    const base = h < 5 ? 14 : h < 7 ? 20 : h < 10 ? 30 : h < 16 ? 26 : h < 20 ? 30 : 20;
    return Math.round(base * this.density);
  }

  updateStreaming(dt: number): void {
    this.laneTimer -= dt;
    if (this.laneTimer <= 0) {
      this.laneTimer = 1.5;
      this.refreshNearLanes();
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.4;
      this.streamTraffic();
      this.towBlockers();
    }
    this.parkedTimer -= dt;
    if (this.parkedTimer <= 0) {
      this.parkedTimer = 1.1;
      this.streamParked();
    }
  }

  private streamTraffic(): void {
    const sim = this.sim;
    const pp = sim.playerPos();
    const pv = this.playerVel();
    const fast = this.outrunsTraffic(pv);
    let count = 0;
    for (const v of sim.vehicles) {
      if (v.removed || v.persistent || v.owner === 'police' || v.owner === 'mission') continue;
      if (v.driver === sim.player) continue;
      const d = Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
      // Sunk cars go before the wreck rule: sinking marks them destroyed after 4 s. One resting in
      // the surf, partly above the water, only goes out of view (or later as an ordinary wreck).
      if (v.inWater && v.sinkTimer > 6 && (v.pos.y + v.spec.height < WATER_Y || !sim.isVisible(v.pos.x, v.pos.y, v.pos.z))) {
        sim.removeVehicle(v);
        continue;
      }
      if (v.destroyed) {
        if ((v.wreckTime > 40 && (d > 60 || !sim.isVisible(v.pos.x, v.pos.y, v.pos.z))) || d > 280) sim.removeVehicle(v);
        continue;
      }
      if (v.owner === 'parked') continue; // handled by streamParked
      // Far cars only vanish out of view (the fog does not hide them at this range). A fast player is
      // about to reach the ones in front of him, as far out as the cross traffic spawned for him.
      const comingUp = fast && d <= AHEAD_MAX && (v.pos.x - pp.x) * pv.x + (v.pos.z - pp.z) * pv.z > 0;
      if (d > 175 && !comingUp && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
        sim.removeVehicle(v);
        continue;
      }
      if (v.owner === 'traffic' && v.driver) {
        if (d > 130 && v.stuckTime > 14 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
          sim.removeVehicle(v);
          continue;
        }
        count++;
      } else if (!v.driver && d > 200 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
        // Abandoned cars (bailed-out drivers, old player cars).
        sim.removeVehicle(v);
      }
    }
    // A fast player leaves the cars streamed around him behind, and at the target count none spawn
    // where he is going: retire the furthest one well behind him, out of view, to make room.
    if (count >= this.targetCount && fast) {
      const behind: Array<{ v: Vehicle; d: number }> = [];
      for (const v of sim.vehicles) {
        if (v.removed || v.persistent || v.owner !== 'traffic' || !v.driver || v.driver === sim.player) continue;
        const dx = v.pos.x - pp.x;
        const dz = v.pos.z - pp.z;
        const d = Math.hypot(dx, dz);
        if (d > RECYCLE_BEHIND && dx * pv.x + dz * pv.z < 0) behind.push({ v, d });
      }
      behind.sort((a, b) => b.d - a.d);
      const gone = behind.find((b) => !sim.isVisible(b.v.pos.x, b.v.pos.y, b.v.pos.z));
      if (gone) {
        sim.removeVehicle(gone.v);
        count--;
      }
    }
    let spawned = 0;
    while (count < this.targetCount && spawned < 2) {
      if (!this.trySpawnTraffic()) break;
      spawned++;
      count++;
    }
  }

  /** Tow away vehicles nobody is in that have stood in a junction holding up traffic for TOW_BLOCK s. */
  private towBlockers(): void {
    const sim = this.sim;
    const held = new Set<Vehicle>();
    for (const v of sim.vehicles) {
      const b = !v.removed && v.driver ? v.ai?.heldUpBy : null;
      if (b && !b.removed && !b.driver) held.add(b);
    }
    const now = sim.time;
    for (const [v, b] of this.blockTime) if (v.removed || now - b.last > TOW_GAP) this.blockTime.delete(v);
    const pp = sim.playerPos();
    for (const v of held) {
      if (v.persistent || v.owner === 'police' || v.owner === 'mission' || v.occupants().length > 0) continue;
      const n = sim.roads.nearestNode(v.pos.x, v.pos.z);
      if (Math.abs(v.pos.x - n.x) > n.halfX + 2 || Math.abs(v.pos.z - n.z) > n.halfZ + 2) continue;
      const b = this.blockTime.get(v) ?? { since: now, last: now };
      b.last = now;
      this.blockTime.set(v, b);
      if (now - b.since < TOW_BLOCK) continue;
      if (v.usedByPlayer && Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z) <= TOW_KEEP_NEAR) continue;
      if (sim.characters.some((c) => !c.removed && c.enterTarget === v)) continue;
      if (sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) continue;
      this.blockTime.delete(v);
      sim.removeVehicle(v);
    }
  }

  private refreshNearLanes(): void {
    const pp = this.sim.playerPos();
    this.nearLanes = this.sim.roads.lanes.filter((l) => pointSegDist(pp.x, pp.z, l.sx, l.sz, l.ex, l.ez) < 235);
    this.nearCum = runningWeights(this.nearLanes.map((l) => l.lanesInDir));
  }

  private playerVel(): { x: number; z: number } {
    const p = this.sim.player;
    return p.vehicle ? p.vehicle.vel : p.vel;
  }

  /** The player (moving at `pv`) outruns the traffic streamed around him, so it streams ahead of him instead. */
  private outrunsTraffic(pv: { x: number; z: number }): boolean {
    return Math.hypot(pv.x, pv.z) > AHEAD_SPEED;
  }

  /**
   * Where a fast player is about to be. The straight road ahead is in plain view, where nothing may
   * spawn, so its traffic has to come in from the side streets, and in time: a car queued round the
   * corner only pulls out in front of him if its light turns green early enough. Takes the next
   * junctions along his lane (it and its straight continuation) and, at each, the cross-street lanes
   * arriving from either side whose green comes at least CROSS_LEAD s before he gets there. Notes the
   * lanes his way along that road too (see trySpawnTraffic).
   */
  private refreshAhead(): void {
    this.aheadSpans = [];
    this.aheadCum = [];
    this.aheadPath.clear();
    this.aheadTime = this.sim.time;
    const pv = this.playerVel();
    const speed = Math.hypot(pv.x, pv.z);
    if (!this.outrunsTraffic(pv)) return;
    const roads = this.sim.roads;
    const pp = this.sim.playerPos();
    let lane: Lane | null = roads.nearestLane(pp.x, pp.z, Math.atan2(pv.x, pv.z)).lane;
    // Only along a lane, not across a plaza or the beach.
    if (lane.dx * pv.x + lane.dz * pv.z < 0.7 * speed) return;
    for (let n = 0; n < AHEAD_JUNCTIONS && lane; n++) {
      for (const l of roads.lanesBetween(lane.from, lane.to)) this.aheadPath.add(l);
      const node = roads.nodes[lane.to]!;
      const lead = Math.hypot(node.x - pp.x, node.z - pp.z) / speed - CROSS_LEAD;
      for (const turn of [1, 3]) {
        const side = node.neighbors[(lane.dir + turn) % 4]!;
        if (side < 0 || lead < 0) continue;
        for (const l of roads.lanesBetween(side, node.id)) {
          if (!this.greenWithin(node.id, l, lead)) continue;
          const a = Math.max(6, l.length - QUEUE_FAR);
          const b = l.length - QUEUE_NEAR;
          if (b > a) this.aheadSpans.push({ lane: l, s0: a, s1: b });
        }
      }
      lane = lane.turns.find((t) => t.kind === 'straight')?.to ?? null;
    }
    this.aheadCum = runningWeights(this.aheadSpans.map((sp) => sp.lane.lanesInDir));
  }

  /** Whether the light for `lane` at its junction shows green at some point in the next `secs` seconds. */
  private greenWithin(nodeId: number, lane: Lane, secs: number): boolean {
    const t = this.sim.time;
    const axis = axisOf(lane.dir);
    for (let dt = 0; dt <= secs; dt += 0.5) if (this.sim.roads.signalState(nodeId, axis, t + dt) === 'green') return true;
    return false;
  }

  /**
   * Spawns one moving car on a lane out of the player's view, minDist-maxDist from him (default
   * 45-165 m). When he drives fast, the first 7 of the 12 tries go to the cross streets ahead
   * (45-200 m, narrowed to the band a caller passes) and no car spawns behind him. Lanes are weighted
   * by their count per direction, so an avenue lane is twice as likely as a street lane.
   * While the police are after him, no car spawns to wait at a red light in his way: neither on the
   * cross streets ahead, where it would pull out across his road just as he gets there, nor on the road
   * ahead his way, where it would queue at the stop line. Cross traffic with a green light, oncoming
   * traffic and cars moving his way still come.
   */
  trySpawnTraffic(minDist?: number, maxDist?: number, kind?: VehicleKind): Vehicle | null {
    const sim = this.sim;
    const nearMin = minDist ?? 45;
    const nearMax = maxDist ?? 165;
    const aheadMin = Math.max(AHEAD_MIN, nearMin);
    const aheadMax = Math.min(AHEAD_MAX, maxDist ?? AHEAD_MAX);
    if (this.nearLanes.length === 0 || nearMax > 230) this.refreshNearLanes();
    if (this.nearLanes.length === 0) return null;
    // Missions spawn through here too, with or without the streaming that refreshes these.
    if (sim.time - this.aheadTime >= 0.4) this.refreshAhead();
    const pp = sim.playerPos();
    const pv = this.playerVel();
    const fast = this.outrunsTraffic(pv);
    for (let tries = 0; tries < 12; tries++) {
      const ahead = this.aheadSpans.length > 0 && aheadMax > aheadMin && tries < AHEAD_TRIES;
      let lane: Lane;
      let s: number;
      if (ahead) {
        const span = pickWeighted(sim.rng, this.aheadSpans, this.aheadCum);
        lane = span.lane;
        s = sim.rng.range(span.s0, span.s1);
      } else {
        lane = pickWeighted(sim.rng, this.nearLanes, this.nearCum);
        if (lane.length < 16) continue;
        s = sim.rng.range(6, lane.length - 6);
      }
      let x = lane.sx + lane.dx * s;
      let z = lane.sz + lane.dz * s;
      const d = Math.hypot(x - pp.x, z - pp.z);
      if (ahead ? d < aheadMin || d > aheadMax : d < nearMin || d > nearMax) continue;
      // A car spawned behind a fast player is left behind at once (and recycled): pure churn.
      if (!ahead && fast && (x - pp.x) * pv.x + (z - pp.z) * pv.z < 0) continue;
      const red = sim.roads.signalState(lane.to, axisOf(lane.dir), sim.time) !== 'green';
      if (red && sim.wanted.level > 0 && (ahead || this.aheadPath.has(lane))) continue;
      // Spawn ranges lie inside the fog-free distance: never pop a car into view.
      if (sim.isVisible(x, 1, z)) continue;
      if (!this.isClear(x, z, 11)) continue;
      let k = kind ?? sim.rng.weighted(TRAFFIC_MIX);
      if (k === 'bus' && !lane.line.avenue) k = 'sedan';
      // Queued at a light that is not green, the front bumper waits STOP_MARGIN short of the line (see DriverAI). A bus
      // queued nearer than that would already be in the junction for its driver and pull out against the light: it
      // waits further back (with half a metre to spare), where it has to be out of sight and clear too.
      const queueAt = lane.length - (VEHICLE_SPECS[k].length / 2 + STOP_MARGIN + 0.5);
      if (ahead && red && s > queueAt) {
        if (queueAt < 6) continue;
        s = queueAt;
        x = lane.sx + lane.dx * s;
        z = lane.sz + lane.dz * s;
        const dq = Math.hypot(x - pp.x, z - pp.z);
        if (dq < aheadMin || dq > aheadMax || sim.isVisible(x, 1, z) || !this.isClear(x, z, 11)) continue;
      }
      const v = sim.spawnVehicle(k, x, z, lane.heading);
      v.owner = 'traffic';
      const driver = sim.addDriver(v, 'civilian', 'traffic');
      driver.owner = 'traffic';
      v.ai!.setLane(lane, s);
      // Cross traffic queued at a light that is not green waits there: a few metres from the line it
      // could not stop from cruising speed.
      const sp = ahead && red ? 0 : lane.speedLimit * 0.55;
      v.vel.x = lane.dx * sp;
      v.vel.z = lane.dz * sp;
      return v;
    }
    return null;
  }

  /** Like trySpawnTraffic but ignores visibility; scans every lane deterministically. */
  spawnTrafficAnywhere(minDist: number, maxDist: number, kind: VehicleKind): Vehicle | null {
    const sim = this.sim;
    const pp = sim.playerPos();
    for (const lane of sim.roads.lanes) {
      for (let s = 8; s < lane.length - 8; s += 12) {
        const x = lane.sx + lane.dx * s;
        const z = lane.sz + lane.dz * s;
        const d = Math.hypot(x - pp.x, z - pp.z);
        if (d < minDist || d > maxDist || !this.isClear(x, z, 8)) continue;
        const v = sim.spawnVehicle(kind, x, z, lane.heading);
        v.owner = 'traffic';
        const driver = sim.addDriver(v, 'civilian', 'traffic');
        driver.owner = 'traffic';
        v.ai!.setLane(lane, s);
        return v;
      }
    }
    return null;
  }

  isClear(x: number, z: number, r: number): boolean {
    for (const v of this.sim.vehicles) {
      if (!v.removed && Math.hypot(v.pos.x - x, v.pos.z - z) < r) return false;
    }
    for (const c of this.sim.characters) {
      if (!c.removed && c.state !== 'inVehicle' && Math.hypot(c.pos.x - x, c.pos.z - z) < 3) return false;
    }
    return true;
  }

  private streamParked(): void {
    const sim = this.sim;
    const pp = sim.playerPos();
    const spots = sim.world.layout.parking;
    for (const [i, v] of this.parkedBySpot) {
      if (v.removed || v.usedByPlayer || v.driver || v.owner !== 'parked') {
        this.parkedBySpot.delete(i);
        if (!v.removed && v.owner === 'parked') v.owner = 'none';
        continue;
      }
      const d = Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
      if (d > 235 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
        sim.removeVehicle(v);
        this.parkedBySpot.delete(i);
      }
    }
    for (let i = 0; i < spots.length; i++) {
      if (this.parkedBySpot.has(i)) continue;
      const s = spots[i]!;
      const d = Math.hypot(s.x - pp.x, s.z - pp.z);
      if (d > 175 || d < 35) continue;
      if (hash(i) % 100 >= 55) continue;
      if (sim.isVisible(s.x, 0.5, s.z)) continue;
      if (!this.isClear(s.x, s.z, BAY_SPACING)) continue;
      const kind = PARKED_MIX[hash(i * 7 + 3) % PARKED_MIX.length]![0];
      if (!clearOfVehicles(sim, kind, s.x, s.z, s.heading)) continue;
      const v = sim.spawnVehicle(kind, s.x, s.z, s.heading);
      v.owner = 'parked';
      this.parkedBySpot.set(i, v);
    }
  }
}

/** Running totals of `weights`, for pickWeighted. */
function runningWeights(weights: number[]): number[] {
  let t = 0;
  return weights.map((w) => (t += w));
}

/** An item of `items` drawn with probability proportional to its weight (`cum`: running totals). */
function pickWeighted<T>(rng: Rng, items: readonly T[], cum: readonly number[]): T {
  const r = rng.next() * cum[cum.length - 1]!;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! > r) hi = mid;
    else lo = mid + 1;
  }
  return items[lo]!;
}

function hash(i: number): number {
  let x = (i + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}
