// Call a cab: an Azura Cab drives to the player, takes him as a passenger and drives him to his map waypoint.
// The phone asks for it (see callCab); the ride is an activity, so it holds the single job slot, ends on a mission
// start, wasted or busted, and its cab is the radar objective while it comes.

import { formatMoney } from '../../core/math';
import { makeBrain } from '../brains';
import { ARRIVE_RADIUS } from '../driver';
import type { Lane } from '../../world/roads';
import type { Character, Vehicle } from '../entities';
import type { PlayerSlot } from '../playerSlot';
import type { Sim } from '../sim';
import { registerSystem } from '../systems';
import type { ActivityDef, ActivityHost, Objective } from './types';

declare module './types' {
  interface JobKinds {
    cab: CabJob;
  }
}

export type CabStage = 'coming' | 'waiting' | 'seated' | 'riding' | 'stopping';

export interface CabJob {
  kind: 'cab';
  cab: Vehicle;
  driver: Character;
  stage: CabStage;
  /** Where the cab stops: the road point nearest the player (coming) or the waypoint (riding), on lane `stopLane`. */
  stopX: number;
  stopZ: number;
  stopLane: number;
  /**
   * The junction where `stopLane` starts, driven to first: the route planner would happily pull up in the far lane of
   * an avenue, across the road from the stop. Null once the cab is on its way along that lane.
   */
  via: { x: number; z: number } | null;
  /** The waypoint the ride goes to, as the player set it, or null until he sets one. */
  dest: { x: number; z: number } | null;
  /** Seconds in the current stage. */
  timer: number;
  /** Seconds since the cab was called. */
  elapsed: number;
  /** Closest the cab has come to the stop on this approach (m), and seconds it has been getting further since. */
  closest: number;
  receding: number;
  /** Metres driven with the player aboard: the fare is worked out from them. */
  odometer: number;
  lastX: number;
  lastZ: number;
  /** The player asked to get out before the drop-off: the cab pulls over and he leaves without paying. */
  leaving: boolean;
  /** The player pressed the enter key while the cab was still rolling: he gets in once it has stopped. */
  boarding: boolean;
  /** The cab was brought in again from closer by after the first one took too long (see CAB_RESCUE). */
  rescued: boolean;
}

/** The cab spawns this far (m, straight-line) from the player, out of his sight. */
const SPAWN_MIN = 120;
const SPAWN_MAX = 200;
/** A cab still not there after this long (s) is replaced by one from closer by (RESCUE_MIN-MAX m), out of sight. */
const CAB_RESCUE = 55;
const RESCUE_MIN = 60;
const RESCUE_MAX = 120;
/** No cab comes from further than this (m of driving). */
const MAX_DRIVE = 600;
/** Documented limit (s): a called cab reaches the player within this long. */
export const CAB_ARRIVAL_LIMIT = 90;
/** The cab stops this close (m, straight-line) to its stop point... */
const STOP_RADIUS = 5;
/** ...or, passing it at most this far away (m), once it starts to get further again (a road that runs past, not to it). */
const PASS_RADIUS = 14;
/** Approach speed cap: sqrt(2 * APPROACH_DECEL * (d - STOP_RADIUS)), at least APPROACH_MIN m/s. */
const APPROACH_DECEL = 1.8;
const APPROACH_MIN = 3;
/** Within this of the junction it goes to first (m), the cab heads for the stop itself. */
const VIA_REACH = 24;
/** The player gets in from this close to the cab's centre (m), on foot. */
const BOARD_REACH = 4.5;
/** Waiting at the player: it re-routes once he is further than this from it (m), and leaves after CAB_WAIT s. */
const WAIT_REACH = 30;
const CAB_WAIT = 60;
/** A cab left waiting this far away (m) gives up at once. */
const ABANDON_RANGE = 120;
/** A new waypoint at least this far (m) from the current one re-routes the ride. */
const REROUTE = 5;
/** Fare: a flag fall plus so much per metre driven with the player aboard. */
const FARE_BASE = 10;
const FARE_PER_M = 0.04;
const CAB_COLOR = 0xf2c230;
/** The cabbie drives a little above the limit (route drivers keep 0.85-1.05 of it). */
const CAB_SPEED = 1.15;

export function cabFare(metres: number): number {
  return FARE_BASE + Math.round(Math.max(0, metres) * FARE_PER_M);
}

/** The activity host of each Sim, so the phone can start a ride (Activities hands it to every def on attach). */
const hosts = new WeakMap<Sim, ActivityHost>();

function cabJob(sim: Sim): CabJob | null {
  const j = sim.activities.job;
  return j?.kind === 'cab' ? j : null;
}

/** The road point nearest (x, z): where a cab stops for someone standing there. */
function roadPoint(sim: Sim, x: number, z: number): { x: number; z: number } {
  const { lane, s } = sim.roads.nearestLane(x, z);
  const t = Math.max(2, Math.min(lane.length - 2, s));
  return { x: lane.sx + lane.dx * t, z: lane.sz + lane.dz * t };
}

/** The reason a cab cannot be called right now, or null when it can. */
export function cabRefusal(sim: Sim, slot: PlayerSlot = sim.players[0]!): string | null {
  if (slot.id !== 0) return 'Cabs are single player only.';
  if (slot.down) return 'Not now.';
  const j = sim.activities.job;
  if (j?.kind === 'cab') return 'Your cab is already on its way.';
  if (slot.wanted.level > 0) return 'Azura Cab: no rides for anyone with the cops on their tail.';
  if (sim.missions.active) return 'Azura Cab: not during a mission.';
  if (j) return 'Finish your job first.';
  if (slot.character.vehicle || slot.character.state !== 'normal') return 'Call a cab on foot.';
  return null;
}

/**
 * Sends an Azura Cab to the player (slot 0). Returns the line to show: why it was refused, or that it is on its way.
 */
export function callCab(sim: Sim): { ok: boolean; text: string } {
  const why = cabRefusal(sim);
  if (why) return { ok: false, text: why };
  const host = hosts.get(sim);
  if (!host || !cabActivity.start(host, sim.player, null)) return { ok: false, text: 'Azura Cab: no cars free right now. Try again in a moment.' };
  return { ok: true, text: 'Azura Cab is on its way. Wait at the road.' };
}

/**
 * Where the ride goes: the player's map waypoint (null: none set). Game passes it every frame; the ride keeps the last
 * one given once the HUD clears a waypoint it reached.
 */
export function setCabDestination(sim: Sim, wp: { x: number; z: number } | null): void {
  const j = cabJob(sim);
  if (!j || !wp) return;
  if (j.dest && Math.hypot(j.dest.x - wp.x, j.dest.z - wp.z) < REROUTE) return;
  j.dest = { x: wp.x, z: wp.z };
  if (j.stage === 'riding') startRide(hosts.get(sim)!, j);
}

/** The running cab job, for the HUD and tests. */
export function cabState(sim: Sim): Readonly<CabJob> | null {
  return cabJob(sim);
}

/** Metres a car at `s` along `lane` drives to `stopS` along `stop`, by the junction where `stop` starts (Infinity: no way). */
function driveLength(sim: Sim, lane: Lane, s: number, stop: Lane, stopS: number): number {
  if (lane.id === stop.id) return s <= stopS ? stopS - s : Infinity;
  const roads = sim.roads;
  const route = lane.to === stop.from ? [lane.to] : roads.findRoute(lane.to, stop.from, lane.from);
  // Coming in along the far side of that road would take a U-turn at its end: round the block it goes, past him.
  if (!route || (route.length >= 2 && route[route.length - 2] === stop.to)) return Infinity;
  let len = lane.length - s + stopS;
  for (let i = 1; i < route.length; i++) {
    const a = roads.nodes[route[i - 1]!]!;
    const b = roads.nodes[route[i]!]!;
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return len;
}

/**
 * Spawns the cab out of the player's sight, minDist-maxDist (m) from him, on the lane with the shortest drive to his
 * stop (on the lane nearest him, see driveTo): it comes up his side of the road.
 */
function spawnCab(host: ActivityHost, minDist: number, maxDist: number): { cab: Vehicle; driver: Character } | null {
  const sim = host.sim;
  const pp = sim.playerPos();
  const near = sim.roads.nearestLane(pp.x, pp.z);
  let best: { lane: Lane; s: number; len: number } | null = null;
  for (const lane of sim.roads.lanes) {
    if (lane.length < 24) continue;
    for (const f of [0.3, 0.6]) {
      const s = lane.length * f;
      const x = lane.sx + lane.dx * s;
      const z = lane.sz + lane.dz * s;
      const d = Math.hypot(x - pp.x, z - pp.z);
      if (d < minDist || d > maxDist) continue;
      const len = driveLength(sim, lane, s, near.lane, near.s);
      if (len > MAX_DRIVE || (best && len >= best.len)) continue;
      if (sim.isVisible(x, 1, z) || !sim.traffic.isClear(x, z, 11) || sim.world.waterDepth(x, z) > 0) continue;
      best = { lane, s, len };
    }
  }
  if (!best) return null;
  const { lane, s } = best;
  const v = sim.spawnVehicle('taxi', lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading, CAB_COLOR);
  const d = sim.addDriver(v, 'civilian', 'route');
  v.ai!.setLane(lane, s);
  v.vel.x = lane.dx * lane.speedLimit * 0.5;
  v.vel.z = lane.dz * lane.speedLimit * 0.5;
  v.owner = 'mission';
  v.persistent = true;
  v.missionTag = 'cab';
  d.owner = 'mission';
  d.persistent = true;
  d.missionTag = 'cab';
  // He only thinks for himself once out of the cab (jacked, the cab on fire).
  d.brain = makeBrain('wander');
  return { cab: v, driver: d };
}

/** Drives to the road point (x, z) on its nearest lane and stops there (see approach), by way of that lane's start. */
function driveTo(sim: Sim, j: CabJob, x: number, z: number): void {
  const { lane } = sim.roads.nearestLane(x, z);
  const from = sim.roads.nodes[lane.from]!;
  j.stopX = x;
  j.stopZ = z;
  j.stopLane = lane.id;
  j.via = { x: from.x, z: from.z };
  j.closest = Infinity;
  j.receding = 0;
  const ai = j.cab.ai;
  if (!ai) return;
  ai.hold = false;
  if (ai.currentLane()?.id === lane.id) {
    j.via = null;
    aim(j, x, z, STOP_RADIUS);
  } else aim(j, from.x, from.z, ARRIVE_RADIUS);
}

function aim(j: CabJob, x: number, z: number, radius: number): void {
  const ai = j.cab.ai!;
  ai.setDestination(x, z);
  ai.hold = false;
  ai.speedMul = CAB_SPEED;
  ai.arriveRadius = radius;
}

function startRide(host: ActivityHost, j: CabJob): void {
  if (!j.dest) return;
  const p = roadPoint(host.sim, j.dest.x, j.dest.z);
  j.stage = 'riding';
  j.timer = 0;
  driveTo(host.sim, j, p.x, p.z);
  host.say(`Azura Cab: heading to ${host.sim.world.zoneName(j.dest.x, j.dest.z)}. Press F to get out early.`, 4);
}

/** Lets the cab go back to ordinary traffic. */
function releaseCab(j: CabJob): void {
  const v = j.cab;
  const d = j.driver;
  if (!v.removed) {
    v.owner = 'traffic';
    v.persistent = false;
    v.missionTag = '';
    if (v.ai && v.driver === d) {
      v.ai.hold = false;
      v.ai.arriveRadius = ARRIVE_RADIUS;
      v.ai.setPolicy('traffic');
      v.ai.dest = null;
    }
  }
  if (!d.removed) {
    d.owner = 'traffic';
    d.persistent = false;
    d.missionTag = '';
  }
}

/** Seats the player in the cab's free passenger seat (back first); false with none free. */
function board(sim: Sim, j: CabJob): boolean {
  const v = j.cab;
  const p = sim.player;
  let seat = -1;
  for (const s of [3, 2, 1]) if (s <= v.passengers.length && v.passengers[s - 1] === null) {
    seat = s;
    break;
  }
  if (seat < 0) return false;
  p.state = 'normal';
  sim.seat(p, v, seat);
  sim.events.emit('vehicleEnter', { vehicle: v, character: p, jacked: false });
  return true;
}

/** The cab on its way to `x, z`: slows down near it and stops there, or once it has passed it close by. Returns true once stopped there. */
function approach(j: CabJob, dt: number): boolean {
  const v = j.cab;
  const ai = v.ai;
  if (!ai) return false;
  if (j.via) {
    ai.maxSpeed = v.spec.maxSpeed * 0.6;
    if (ai.currentLane()?.id !== j.stopLane && Math.hypot(v.pos.x - j.via.x, v.pos.z - j.via.z) > VIA_REACH) return false;
    j.via = null;
    aim(j, j.stopX, j.stopZ, STOP_RADIUS);
  }
  const d = Math.hypot(v.pos.x - j.stopX, v.pos.z - j.stopZ);
  ai.maxSpeed = Math.min(v.spec.maxSpeed * 0.6, Math.max(APPROACH_MIN, Math.sqrt(2 * APPROACH_DECEL * Math.max(0, d - STOP_RADIUS))));
  if (d < j.closest) {
    j.closest = d;
    j.receding = 0;
  } else if (d > j.closest + 0.3) j.receding += dt;
  if (!ai.arrived && j.closest <= PASS_RADIUS && j.receding > 0.1) ai.arrived = true;
  return ai.arrived && v.speed < 0.6;
}

/** The player out of the cab, at its door, or wherever there is room once the cab is released to traffic. */
function getOut(sim: Sim, j: CabJob): void {
  if (sim.player.vehicle !== j.cab) return;
  if (!sim.playerCtl.exitVehicle(false) && sim.player.vehicle === j.cab) sim.playerCtl.ejectPlayer(true);
}

function hold(j: CabJob): void {
  if (j.cab.ai) j.cab.ai.hold = true;
}

function updateCab(host: ActivityHost, j: CabJob, dt: number): void {
  const sim = host.sim;
  const v = j.cab;
  const p = sim.player;
  j.timer += dt;
  j.elapsed += dt;
  const aboard = p.vehicle === v;
  if (v.removed || !v.drivable || j.driver.removed || !j.driver.alive || v.driver !== j.driver) {
    if (aboard && !v.removed) sim.playerCtl.ejectPlayer(true);
    host.end(aboard || j.stage === 'riding' ? 'The ride is over.' : 'Your cab is not coming.');
    return;
  }
  if (aboard) {
    j.odometer += Math.hypot(v.pos.x - j.lastX, v.pos.z - j.lastZ);
  }
  j.lastX = v.pos.x;
  j.lastZ = v.pos.z;
  if ((j.stage === 'seated' || j.stage === 'riding' || j.stage === 'stopping') && !aboard) {
    host.end(j.leaving || j.stage !== 'riding' ? '' : 'You left the cab. No charge.');
    return;
  }
  switch (j.stage) {
    case 'coming': {
      const pp = sim.playerPos();
      // He walked off: the cab comes to where he is now.
      if (Math.hypot(pp.x - j.stopX, pp.z - j.stopZ) > WAIT_REACH) {
        const r = roadPoint(sim, pp.x, pp.z);
        driveTo(sim, j, r.x, r.z);
      }
      if (j.boarding && v.speed < 0.8 && Math.hypot(pp.x - v.pos.x, pp.z - v.pos.z) <= BOARD_REACH + 1) {
        if (board(sim, j)) seated(host, j);
        return;
      }
      if (j.boarding) hold(j);
      if (approach(j, dt)) {
        j.stage = 'waiting';
        j.timer = 0;
        host.say('Your Azura Cab is here. Press F to get in.', 5);
        return;
      }
      if (!j.rescued && j.elapsed > CAB_RESCUE && !sim.isVisible(v.pos.x, v.pos.y + 1, v.pos.z)) rescue(host, j);
      return;
    }
    case 'waiting': {
      hold(j);
      const d = Math.hypot(p.pos.x - v.pos.x, p.pos.z - v.pos.z);
      if (d > ABANDON_RANGE || j.timer > CAB_WAIT) {
        host.end('Your cab left without you.');
        return;
      }
      if (d > WAIT_REACH) {
        const r = roadPoint(sim, p.pos.x, p.pos.z);
        j.stage = 'coming';
        j.timer = 0;
        if (v.ai) v.ai.hold = false;
        driveTo(sim, j, r.x, r.z);
      }
      return;
    }
    case 'seated':
      hold(j);
      if (j.dest) startRide(host, j);
      return;
    case 'riding':
      if (j.leaving) {
        j.stage = 'stopping';
        j.timer = 0;
        return;
      }
      if (approach(j, dt)) arrive(host, j);
      return;
    case 'stopping':
      hold(j);
      if (v.speed < 1) {
        getOut(sim, j);
        host.end('You left the cab. No charge.');
      }
      return;
  }
}

function seated(host: ActivityHost, j: CabJob): void {
  j.boarding = false;
  j.odometer = 0;
  j.stage = 'seated';
  j.timer = 0;
  if (j.dest) startRide(host, j);
  else host.say('Azura Cab: where to? Set a waypoint on the map (M) and I will take you there.', 6);
}

/** The cab took too long (stuck behind something): another one comes from closer by, out of the player's sight. */
function rescue(host: ActivityHost, j: CabJob): void {
  const sim = host.sim;
  const next = spawnCab(host, RESCUE_MIN, RESCUE_MAX);
  if (!next) return;
  const old = j.cab;
  releaseCab(j);
  sim.removeVehicle(old);
  j.cab = next.cab;
  j.driver = next.driver;
  j.rescued = true;
  j.lastX = next.cab.pos.x;
  j.lastZ = next.cab.pos.z;
  const pp = sim.playerPos();
  const r = roadPoint(sim, pp.x, pp.z);
  driveTo(sim, j, r.x, r.z);
}

function arrive(host: ActivityHost, j: CabJob): void {
  const sim = host.sim;
  const fare = cabFare(j.odometer);
  const paid = sim.progress.charge(fare);
  if (paid > 0) sim.events.emit('money', { amount: -paid });
  getOut(sim, j);
  j.leaving = true;
  host.end(`Azura Cab: that's ${formatMoney(paid)}${paid < fare ? ' (all you had)' : ''}. Have a nice day.`);
}

export const cabActivity: ActivityDef<CabJob> = {
  kind: 'cab',
  // Started from the phone, never by the job key; the street run stays the job key's fallback.
  priority: -2,

  attach(host) {
    hosts.set(host.sim, host);
  },

  canStart: () => false,

  prompt: () => null,

  start(host) {
    const sim = host.sim;
    const spawned = spawnCab(host, SPAWN_MIN, SPAWN_MAX) ?? spawnCab(host, SPAWN_MIN * 0.6, SPAWN_MAX * 1.5);
    if (!spawned) return false;
    const pp = sim.playerPos();
    const r = roadPoint(sim, pp.x, pp.z);
    const j: CabJob = {
      kind: 'cab', cab: spawned.cab, driver: spawned.driver, stage: 'coming', stopX: r.x, stopZ: r.z, stopLane: -1, via: null, dest: null, timer: 0, elapsed: 0,
      closest: Infinity, receding: 0, odometer: 0, lastX: spawned.cab.pos.x, lastZ: spawned.cab.pos.z, leaving: false, boarding: false, rescued: false,
    };
    driveTo(sim, j, r.x, r.z);
    host.job = j;
    return true;
  },

  update: updateCab,

  end(host, j) {
    const sim = host.sim;
    // Ended by the game (a mission starting, wasted, busted) with the player aboard: out he gets.
    if (!j.cab.removed) getOut(sim, j);
    releaseCab(j);
  },

  objectives(j): Objective[] {
    if (j.stage === 'coming' || j.stage === 'waiting') return [{ x: j.cab.pos.x, z: j.cab.pos.z, label: 'Azura Cab', color: 0xffd23d, radius: 3, vehicle: j.cab }];
    if (j.stage === 'riding' && j.dest) return [{ x: j.dest.x, z: j.dest.z, label: 'Cab ride', color: 0xffd23d, radius: 6 }];
    return [];
  },

  status(j) {
    if (j.stage === 'coming') return `CAB ON ITS WAY  ·  ${Math.round(Math.hypot(j.cab.pos.x - j.stopX, j.cab.pos.z - j.stopZ))} m`;
    if (j.stage === 'waiting') return `CAB WAITING  ·  ${Math.max(0, Math.ceil(CAB_WAIT - j.timer))}`;
    if (j.stage === 'seated') return 'CAB  ·  SET A WAYPOINT';
    if (j.stage === 'riding') return `CAB RIDE  ·  ${formatMoney(cabFare(j.odometer))}`;
    return 'CAB  ·  PULLING OVER';
  },

  abortText: (reason) => (reason === 'mission' ? 'Cab cancelled.' : ''),
};

/**
 * The enter key next to the cab: the player gets in as a passenger instead of pulling the cabbie out, and pressed
 * aboard it has the cab pull over to let him out (no fare). Runs before the player's controller sees the key.
 */
registerSystem({
  id: 'cab',
  slot: 'preInput',
  update(sim: Sim) {
    const j = cabJob(sim);
    if (!j) return;
    const slot = sim.players[0]!;
    const inp = slot.input;
    if (!inp.enterExit || slot.down || slot.controlLock > 0) return;
    const p = slot.character;
    const v = j.cab;
    if (p.vehicle === v) {
      inp.enterExit = false;
      if (j.stage === 'riding' || j.stage === 'seated') {
        j.leaving = true;
        j.stage = 'stopping';
        j.timer = 0;
      }
      return;
    }
    if ((j.stage !== 'coming' && j.stage !== 'waiting') || p.state !== 'normal' || p.vehicle) return;
    if (Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z) > BOARD_REACH + v.halfL * 0.5) return;
    inp.enterExit = false;
    if (v.speed < 0.8 && board(sim, j)) {
      const host = hosts.get(sim);
      if (host) seated(host, j);
    } else j.boarding = true;
  },
});
