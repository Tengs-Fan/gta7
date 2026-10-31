// Streams ambient traffic and parked cars in and out around the player.

import { axisOf, SIGNAL_CYCLE, SIGNAL_GREEN, type Lane } from '../world/roads';
import { pointSegDist } from '../core/math';
import type { Rng } from '../core/rng';
import { WATER_Y } from '../world/constants';
import { STOP_MARGIN, throughAvenues } from './driver';
import type { Vehicle } from './entities';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import { PARKED_MIX, parkedBike, TRAFFIC_MIX, trafficBike, VEHICLE_SPECS, type VehicleKind } from './specs';
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
 * re-plan and wait out red lights in between (an approach waits up to SIGNAL_CYCLE - SIGNAL_GREEN = 21 s for green):
 * the hold-up only ends once nobody has stood held up by it for TOW_GAP s, a little longer than that wait.
 * The car the player left is kept while he is within TOW_KEEP_NEAR m of it, in view or not, and a car someone is
 * getting into, a police unit or a mission car is never towed.
 */
const TOW_BLOCK = 30;
const TOW_GAP = SIGNAL_CYCLE - SIGNAL_GREEN + 4;
const TOW_KEEP_NEAR = 20;
/** Multiplayer: nothing is towed this near (m) any player. */
const TOW_FAR_MP = 40;

/** A stretch of lane to spawn on: distances s0-s1 along it. */
interface SpawnSpan {
  lane: Lane;
  s0: number;
  s1: number;
}

/**
 * Multiplayer: players within CLUSTER_RADIUS m of a group's first player share its traffic and pedestrians. Each group
 * streams its own ring round its players, its share of the budget: n groups together get the single-player target
 * count times mpBudget(n) (1.6 for two, 2.2 for three, 2.8 for four, at most 3), split evenly between them.
 */
export const CLUSTER_RADIUS = 150;
export function mpBudget(groups: number): number {
  return Math.min(1 + 0.6 * (groups - 1), 3);
}

/** Groups the players (slot order; a player joins the first group whose first player is within CLUSTER_RADIUS m). */
export function playerClusters(players: readonly PlayerSlot[]): PlayerSlot[][] {
  const out: PlayerSlot[][] = [];
  for (const s of players) {
    const p = s.pos();
    const g = out.find((c) => {
      const q = c[0]!.pos();
      return Math.hypot(p.x - q.x, p.z - q.z) <= CLUSTER_RADIUS;
    });
    if (g) g.push(s);
    else out.push([s]);
  }
  return out;
}

/** Each group's share of a single-player target count. */
export function clusterTarget(target: number, groups: number): number {
  return groups <= 1 ? target : Math.round((target * mpBudget(groups)) / groups);
}

/** What the spawner knows about the roads round one player (see refreshNearLanes and refreshAhead). */
class Ring {
  nearLanes: Lane[] = [];
  /** Running totals of the near lanes' pick weights. */
  nearCum: number[] = [];
  /** Where cross traffic queues at the junctions ahead of a fast player (see refreshAhead). */
  aheadSpans: SpawnSpan[] = [];
  aheadCum: number[] = [];
  aheadTime = -Infinity;
  /** The lanes of the road a fast player is about to drive down, his way (see refreshAhead). */
  aheadPath = new Set<Lane>();
  /**
   * Every cross-street lane into those junctions (and the one he is driving through), whether or not its green comes in
   * time for aheadSpans: while he is wanted no car spawns on one at a red light, where it would wait right in his way.
   */
  aheadCross = new Set<Lane>();
}

export class TrafficSystem {
  private timer = 0;
  private parkedTimer = 0;
  private laneTimer = 0;
  /** Each player's Ring, by slot id; `ring` and `anchor` are the ones the spawner works round right now (slot 0's between calls). */
  private readonly rings = new Map<number, Ring>();
  private ring = new Ring();
  private anchor: PlayerSlot;
  /** Turns through a group's players for its spawns (multiplayer). */
  private turn = 0;
  readonly parkedBySpot = new Map<number, Vehicle>();
  /** Since when each vehicle nobody is in has held up traffic in a junction, and when it last did (see TOW_BLOCK). */
  private readonly blockTime = new Map<Vehicle, { since: number; last: number }>();
  /** Multiplier for traffic density (settings / tests). */
  density = 1;

  constructor(private readonly sim: Sim) {
    this.anchor = sim.players[0]!;
    this.rings.set(0, this.ring);
  }

  private get nearLanes(): Lane[] { return this.ring.nearLanes; }
  private set nearLanes(v: Lane[]) { this.ring.nearLanes = v; }
  private get nearCum(): number[] { return this.ring.nearCum; }
  private set nearCum(v: number[]) { this.ring.nearCum = v; }
  private get aheadSpans(): SpawnSpan[] { return this.ring.aheadSpans; }
  private set aheadSpans(v: SpawnSpan[]) { this.ring.aheadSpans = v; }
  private get aheadCum(): number[] { return this.ring.aheadCum; }
  private set aheadCum(v: number[]) { this.ring.aheadCum = v; }
  private get aheadTime(): number { return this.ring.aheadTime; }
  private set aheadTime(v: number) { this.ring.aheadTime = v; }
  private get aheadPath(): Set<Lane> { return this.ring.aheadPath; }
  private get aheadCross(): Set<Lane> { return this.ring.aheadCross; }

  /** Works round player `slot` until the next call (see ring). */
  private use(slot: PlayerSlot): void {
    this.anchor = slot;
    let r = this.rings.get(slot.id);
    if (!r) {
      r = new Ring();
      this.rings.set(slot.id, r);
    }
    this.ring = r;
  }

  private anchorPos(): { x: number; y: number; z: number } {
    return this.anchor.pos();
  }

  get targetCount(): number {
    const h = this.sim.clock.hours;
    const base = h < 5 ? 14 : h < 7 ? 20 : h < 10 ? 30 : h < 16 ? 26 : h < 20 ? 30 : 20;
    return Math.round(base * this.density);
  }

  updateStreaming(dt: number): void {
    const active = this.sim.activePlayers();
    this.laneTimer -= dt;
    if (this.laneTimer <= 0) {
      this.laneTimer = 1.5;
      if (active.length <= 1) this.refreshNearLanes();
      else {
        for (const s of active) {
          this.use(s);
          this.refreshNearLanes();
        }
        this.use(this.sim.players[0]!);
      }
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.4;
      if (active.length <= 1) this.streamTraffic();
      else this.streamTrafficMulti(active);
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
    // The one player in the world (slot 0 in single player).
    this.use(sim.activePlayers()[0] ?? sim.players[0]!);
    const me = this.anchor.character;
    const pp = this.anchorPos();
    const pv = this.playerVel();
    const fast = this.outrunsTraffic(pv);
    let count = 0;
    for (const v of sim.vehicles) {
      if (v.removed || v.persistent || v.owner === 'police' || v.owner === 'mission') continue;
      if (v.driver === me) continue;
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
        if (v.removed || v.persistent || v.owner !== 'traffic' || !v.driver || v.driver === me) continue;
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

  /**
   * Multiplayer streaming: what goes, goes only far from every player and out of everyone's view; each group of
   * players (playerClusters) keeps its share of the cars (clusterTarget) streaming round its players in turn.
   */
  private streamTrafficMulti(active: readonly PlayerSlot[]): void {
    const sim = this.sim;
    const groups = playerClusters(active);
    const groupOf = new Map<PlayerSlot, number>();
    groups.forEach((g, i) => g.forEach((s) => groupOf.set(s, i)));
    const target = clusterTarget(this.targetCount, groups.length);
    // Groups near each other share cars (the nearest player's group counts each): the total holds the budget too.
    const cap = Math.round(this.targetCount * mpBudget(groups.length));
    const counts = groups.map(() => 0);
    const vels = active.map((s) => this.playerVel(s));
    for (const v of sim.vehicles) {
      if (v.removed || v.persistent || v.owner === 'police' || v.owner === 'mission') continue;
      if (sim.slotOf(v.driver)) continue;
      const near = sim.nearestPlayer(v.pos.x, v.pos.z);
      const np = near.pos();
      const d = Math.hypot(v.pos.x - np.x, v.pos.z - np.z);
      // With several players nothing goes while any of them may see it, sunk or burnt out.
      if (v.inWater && v.sinkTimer > 6 && d > 60 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
        sim.removeVehicle(v);
        continue;
      }
      if (v.destroyed) {
        if (((v.wreckTime > 40 && d > 60) || d > 280) && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) sim.removeVehicle(v);
        continue;
      }
      if (v.owner === 'parked') continue;
      // A fast player is about to reach the cars in front of him.
      const comingUp = active.some((s, i) => {
        const pv = vels[i]!;
        if (!this.outrunsTraffic(pv)) return false;
        const p = s.pos();
        return Math.hypot(v.pos.x - p.x, v.pos.z - p.z) <= AHEAD_MAX && (v.pos.x - p.x) * pv.x + (v.pos.z - p.z) * pv.z > 0;
      });
      if (d > 175 && !comingUp && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
        sim.removeVehicle(v);
        continue;
      }
      if (v.owner === 'traffic' && v.driver) {
        if (d > 130 && v.stuckTime > 14 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
          sim.removeVehicle(v);
          continue;
        }
        counts[groupOf.get(near) ?? 0]!++;
      } else if (!v.driver && d > 200 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
        sim.removeVehicle(v);
      }
    }
    let total = counts.reduce((x, y) => x + y, 0);
    groups.forEach((g, gi) => {
      let count = counts[gi]!;
      // A group whose fast player leaves its cars behind retires the furthest one behind him, far from everyone.
      const fast = g.find((s) => this.outrunsTraffic(this.playerVel(s)));
      if (count >= target && fast) {
        const fp = fast.pos();
        const fv = this.playerVel(fast);
        let gone: Vehicle | null = null;
        let gd = 0;
        for (const v of sim.vehicles) {
          if (v.removed || v.persistent || v.owner !== 'traffic' || !v.driver || sim.slotOf(v.driver)) continue;
          const dx = v.pos.x - fp.x;
          const dz = v.pos.z - fp.z;
          const d = sim.distToPlayer(v.pos.x, v.pos.z);
          if (d > RECYCLE_BEHIND && dx * fv.x + dz * fv.z < 0 && d > gd && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
            gone = v;
            gd = d;
          }
        }
        if (gone) {
          sim.removeVehicle(gone);
          count--;
          total--;
        }
      }
      let spawned = 0;
      while (count < target && total < cap && spawned < 2) {
        const at = g[this.turn++ % g.length]!;
        if (!this.trySpawnTraffic(undefined, undefined, undefined, at)) break;
        spawned++;
        count++;
        total++;
      }
    });
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
      if (v.usedByPlayer && (this.sim.players.length > 1 ? sim.distToPlayer(v.pos.x, v.pos.z) : Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z)) <= TOW_KEEP_NEAR) continue;
      // Several players: never towed from under anyone's nose, in view or not.
      if (this.sim.players.length > 1 && sim.distToPlayer(v.pos.x, v.pos.z) <= TOW_FAR_MP) continue;
      if (sim.characters.some((c) => !c.removed && c.enterTarget === v)) continue;
      if (sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) continue;
      this.blockTime.delete(v);
      sim.removeVehicle(v);
    }
  }

  private refreshNearLanes(): void {
    const pp = this.anchorPos();
    // Off the city's land, Las Lomas County's lanes too: on it the grid's alone, as they ever were.
    const roads = this.sim.roads;
    const pool = pp.x < this.sim.world.bounds.landMinX ? roads.lanes : roads.gridLanes;
    this.nearLanes = pool.filter((l) => pointSegDist(pp.x, pp.z, l.sx, l.sz, l.ex, l.ez) < 235);
    this.nearCum = runningWeights(this.nearLanes.map((l) => l.lanesInDir));
  }

  private playerVel(slot: PlayerSlot = this.anchor): { x: number; z: number } {
    const p = slot.character;
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
    this.aheadCross.clear();
    this.aheadTime = this.sim.time;
    const pv = this.playerVel();
    const speed = Math.hypot(pv.x, pv.z);
    if (!this.outrunsTraffic(pv)) return;
    const roads = this.sim.roads;
    const pp = this.anchorPos();
    let lane: Lane | null = roads.nearestLane(pp.x, pp.z, Math.atan2(pv.x, pv.z)).lane;
    // Only along a lane, not across a plaza or the beach.
    if (lane.dx * pv.x + lane.dz * pv.z < 0.7 * speed) return;
    const from = roads.nodes[lane.from]!;
    // A county road's bend is no junction: no side street there, and it does not count as one of the junctions ahead.
    for (const turn of [1, 3]) {
      const side = from.neighbors[(lane.dir + turn) % 4]!;
      if (side >= 0 && !roads.isBend(from)) for (const l of roads.lanesBetween(side, from.id)) this.aheadCross.add(l);
    }
    for (let n = 0; n < AHEAD_JUNCTIONS && lane; ) {
      for (const l of roads.lanesBetween(lane.from, lane.to)) this.aheadPath.add(l);
      const node = roads.nodes[lane.to]!;
      if (roads.isBend(node)) {
        lane = lane.turns[0]!.to;
        continue;
      }
      n++;
      const lead = Math.hypot(node.x - pp.x, node.z - pp.z) / speed - CROSS_LEAD;
      for (const turn of [1, 3]) {
        const side = node.neighbors[(lane.dir + turn) % 4]!;
        if (side < 0) continue;
        for (const l of roads.lanesBetween(side, node.id)) {
          this.aheadCross.add(l);
          if (lead < 0 || !this.greenWithin(node.id, l, lead)) continue;
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
  trySpawnTraffic(minDist?: number, maxDist?: number, kind?: VehicleKind, around?: PlayerSlot): Vehicle | null {
    if (around && around !== this.anchor) {
      const was = this.anchor;
      this.use(around);
      try {
        return this.trySpawnTraffic(minDist, maxDist, kind);
      } finally {
        this.use(was);
      }
    }
    const sim = this.sim;
    const others = sim.players.length > 1;
    const nearMin = minDist ?? 45;
    const nearMax = maxDist ?? 165;
    const aheadMin = Math.max(AHEAD_MIN, nearMin);
    const aheadMax = Math.min(AHEAD_MAX, maxDist ?? AHEAD_MAX);
    if (this.nearLanes.length === 0 || nearMax > 230) this.refreshNearLanes();
    if (this.nearLanes.length === 0) return null;
    // Missions spawn through here too, with or without the streaming that refreshes these.
    if (sim.time - this.aheadTime >= 0.4) this.refreshAhead();
    const pp = this.anchorPos();
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
      // Not into another player's lap either.
      if (others && sim.distToPlayer(x, z) < Math.min(d, ahead ? aheadMin : nearMin)) continue;
      // A car spawned behind a fast player is left behind at once (and recycled): pure churn.
      if (!ahead && fast && (x - pp.x) * pv.x + (z - pp.z) * pv.z < 0) continue;
      const red = sim.roads.signalState(lane.to, axisOf(lane.dir), sim.time) !== 'green';
      if (red && this.anchor.wanted.level > 0 && (ahead || this.aheadPath.has(lane) || this.aheadCross.has(lane))) continue;
      // Spawn ranges lie inside the fog-free distance: never pop a car into view.
      if (sim.isVisible(x, 1, z)) continue;
      if (!this.isClear(x, z, 11)) continue;
      let k = kind ?? trafficBike(sim.rng.weighted(TRAFFIC_MIX), x, z);
      if (k === 'bus' && !throughAvenues(sim.roads).has(lane)) k = 'sedan';
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
        if (others && sim.distToPlayer(x, z) < aheadMin) continue;
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
    // With several players a bay streams by its distance to the nearest of them.
    const multi = sim.players.length > 1;
    const spots = sim.world.layout.parking;
    for (const [i, v] of this.parkedBySpot) {
      if (v.removed || v.usedByPlayer || v.driver || v.owner !== 'parked') {
        this.parkedBySpot.delete(i);
        if (!v.removed && v.owner === 'parked') v.owner = 'none';
        continue;
      }
      const d = multi ? sim.distToPlayer(v.pos.x, v.pos.z) : Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
      if (d > 235 && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
        sim.removeVehicle(v);
        this.parkedBySpot.delete(i);
      }
    }
    for (let i = 0; i < spots.length; i++) {
      if (this.parkedBySpot.has(i)) continue;
      const s = spots[i]!;
      const d = multi ? sim.distToPlayer(s.x, s.z) : Math.hypot(s.x - pp.x, s.z - pp.z);
      if (d > 175 || d < 35) continue;
      if (hash(i) % 100 >= 55) continue;
      // Several players: no higher than a moving car's check either (a roof can show over a wall).
      if (sim.isVisible(s.x, 0.5, s.z) || (multi && sim.isVisible(s.x, 1, s.z))) continue;
      if (!this.isClear(s.x, s.z, BAY_SPACING)) continue;
      const kind = parkedBike(PARKED_MIX[hash(i * 7 + 3) % PARKED_MIX.length]![0], i);
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
