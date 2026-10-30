import { formatMoney, moveAngleTowards } from '../../core/math';
import { makeBrain } from '../brains';
import type { Character, Vehicle } from '../entities';
import { setTimeoutLike } from '../pickups';
import { lineSeconds } from '../speech';
import { fareOf, type Fare } from './fares';
import { releaseCharacter } from './shared';
import type { ActivityDef, ActivityHost, Objective } from './types';

export interface TaxiJob {
  kind: 'taxi';
  taxi: Vehicle;
  stage: 'pickup' | 'dropoff';
  fare: Character | null;
  /** Seconds the fare has been walking to the cab, -1 while he waits (see board). */
  boarding: number;
  /** This fare already shouted for the cab coming his way (or hailed it himself, taxiHail.ts). */
  waved: boolean;
  /** Where he set off to the cab from: he goes back there if it pulls away while he walks to it. */
  waitX: number;
  waitZ: number;
  destX: number;
  destZ: number;
  destName: string;
  timer: number;
  fares: number;
  tripDist: number;
}

/** How far from a cab a fare let out looks for the sidewalk (m): across a wide avenue, at a slant. */
const CURB_SEARCH = 16;
/**
 * A cab below this (m/s) is stopped: a fare walks to it or gets out of it at his destination, and it rolling his way
 * this slowly is no danger to him (a car runs a pedestrian over from 4.5 m/s, see characterPhysics).
 */
export const CAB_STOPPED = 2.5;
/** A fare walks to a cab stopped within this of him (m)... */
export const BOARD_RANGE = 9;
/** ...and gives up on it once it is this far (m) or faster. */
const BOARD_GIVE_UP = 12;
/** He gets in once this close to its door (m), or after walking this long (s): a blocked path never stalls a pickup. */
const BOARD_REACH = 1;
const BOARD_MAX = 4;
/** Outside the cab's body (m), where he stands at its door. */
const DOOR_OUT = 0.6;
/** A waiting fare waves at his cab once it is this close (m), turned towards it, until it stops for him. */
const WAVE_RANGE = 40;

/** Spawns the next fare; `lead` is news to tell the player first, in the same message. */
function spawnFare(host: ActivityHost, j: TaxiJob, lead = ''): boolean {
  const sim = host.sim;
  const pp = sim.playerPos();
  const pt = sim.world.walk.randomPointNear(sim.rng, pp.x, pp.z, 70, 220);
  if (!pt) return false;
  const c = sim.spawnCharacter('civilian', pt.x, pt.z);
  c.owner = 'mission';
  c.persistent = true;
  c.missionTag = 'fare';
  c.brain = makeBrain('stand');
  j.fare = c;
  j.stage = 'pickup';
  j.boarding = -1;
  j.waved = false;
  host.say(lead ? `${lead} Pick up the next fare (blue marker).` : 'Pick up the fare (blue marker).');
  return true;
}

/** The job begins in `taxi`, by the job key or a hail (takeHailer): it has no fare yet. */
function begin(host: ActivityHost, taxi: Vehicle): TaxiJob {
  const j: TaxiJob = { kind: 'taxi', taxi, stage: 'pickup', fare: null, boarding: -1, waved: false, waitX: 0, waitZ: 0, destX: 0, destZ: 0, destName: '', timer: 0, fares: 0, tripDist: 0 };
  host.job = j;
  host.sim.events.emit('big', { text: 'TAXI DRIVER', sub: 'Pick up fares and drive them to their destination', style: 'title', duration: 3 });
  return j;
}

/**
 * A pedestrian who waved the cab down (taxiHail.ts) and saw it stop beside him: the fare to pick up now, the job
 * starting if none runs, or taking the waiting fare's place.
 */
export function takeHailer(host: ActivityHost, taxi: Vehicle, c: Character): void {
  let j = host.job as TaxiJob | null;
  if (!j) {
    j = begin(host, taxi);
    host.say('Hold still while the fare gets in.');
  } else if (j.fare && !j.fare.removed) {
    j.fare.hailTimer = 0;
    releaseCharacter(j.fare);
  }
  c.owner = 'mission';
  c.persistent = true;
  c.missionTag = 'fare';
  c.brain!.mode = 'stand';
  j.fare = c;
  j.stage = 'pickup';
  j.boarding = -1;
  j.waved = true;
}

/** The fare says his line of the moment (fares.ts), in his own voice. */
function speak(host: ActivityHost, c: Character, pick: (f: Fare) => string): void {
  const f = fareOf(c);
  const text = pick(f);
  host.sim.events.emit('subtitle', { speaker: f.speaker, text, duration: lineSeconds(f.speaker, text) });
}

function updateTaxi(host: ActivityHost, j: TaxiJob, dt: number): void {
  const sim = host.sim;
  const v = sim.player.vehicle;
  if (v !== j.taxi || !j.taxi.drivable) {
    if (!host.waitsForPlayer(j.taxi)) host.end(`Taxi job ended. Fares: ${j.fares}.`);
    return;
  }
  if (j.stage === 'pickup') {
    if (!j.fare || j.fare.removed || !j.fare.alive) {
      if (j.fare && !j.fare.removed) {
        j.fare.hailTimer = 0;
        releaseCharacter(j.fare);
      }
      j.fare = null;
      if (!spawnFare(host, j)) host.end('No fares around. Taxi job ended.');
      return;
    }
    const f = j.fare;
    if (j.boarding < 0 && f.state === 'normal' && f.brain!.mode === 'stand' && Math.hypot(v.pos.x - f.pos.x, v.pos.z - f.pos.z) < WAVE_RANGE) {
      // Waiting on his feet, he sees his cab coming: he turns to it with his arm up, and calls out once. Not knocked
      // down, running scared, on his way to the cab or back, or walking about once over his fright (board takes him then).
      f.hailTimer = 1;
      f.heading = moveAngleTowards(f.heading, Math.atan2(v.pos.x - f.pos.x, v.pos.z - f.pos.z), 6 * dt);
      if (!j.waved) {
        j.waved = true;
        sim.events.emit('taxiHail', { caller: f, x: f.pos.x, y: f.pos.y + 1.6, z: f.pos.z, started: true, missed: false });
      }
    } else f.hailTimer = 0;
    if (board(host, j, f, v, dt)) {
      f.hailTimer = 0;
      const dest = sim.world.walk.randomPointNear(sim.rng, v.pos.x, v.pos.z, 320, 900) ?? sim.world.walk.randomPointNear(sim.rng, v.pos.x, v.pos.z, 150, 1400);
      if (!dest) {
        host.end('Taxi job ended.');
        return;
      }
      j.destX = dest.x;
      j.destZ = dest.z;
      j.destName = sim.world.zoneName(dest.x, dest.z);
      j.tripDist = Math.hypot(dest.x - v.pos.x, dest.z - v.pos.z);
      j.timer = Math.round(j.tripDist / 11 + 25);
      j.stage = 'dropoff';
      host.say(`Take the fare to ${j.destName}.`);
      speak(host, f, (fare) => fare.ask(j.destName));
    }
    return;
  }
  const fare = j.fare;
  if (!fare || fare.removed || !fare.alive || fare.vehicle !== j.taxi) {
    // Out of the cab (it caught fire, someone dragged them out) or dead: nobody pays this trip.
    const bailed = 'The fare bailed. No fare, no tip.';
    if (fare && !fare.removed) {
      if (fare.vehicle) sim.unseat(fare);
      releaseCharacter(fare);
    }
    j.fare = null;
    if (!spawnFare(host, j, bailed)) host.end(`${bailed} Taxi job ended. Fares: ${j.fares}.`);
    return;
  }
  j.timer -= dt;
  if (j.timer <= 0) {
    if (j.fare && !j.fare.removed) {
      speak(host, j.fare, (f) => f.late);
      if (j.fare.vehicle) sim.unseat(j.fare);
      placeOnSidewalk(host, j.fare, v);
      releaseCharacter(j.fare);
    }
    j.fare = null;
    host.end(`Too slow! The fare got out. Fares: ${j.fares}.`);
    return;
  }
  if (Math.hypot(j.destX - v.pos.x, j.destZ - v.pos.z) < 9 && v.speed < CAB_STOPPED) {
    const pay = 15 + Math.round(j.tripDist * 0.09) + Math.round(j.timer * 2);
    sim.progress.addMoney(pay);
    sim.progress.stats.taxiFares++;
    j.fares++;
    sim.events.emit('money', { amount: pay });
    if (j.fare && !j.fare.removed) {
      speak(host, j.fare, (f) => f.paid);
      if (j.fare.vehicle) sim.unseat(j.fare);
      placeOnSidewalk(host, j.fare, v, j.destX, j.destZ);
      releaseCharacter(j.fare);
    }
    j.fare = null;
    if (j.fares % 5 === 0) {
      sim.progress.addMoney(500);
      sim.events.emit('money', { amount: 500 });
      sim.events.emit('big', { text: `${j.fares} FARES IN A ROW`, sub: '$500 bonus', style: 'passed', duration: 3 });
    } else {
      sim.events.emit('big', { text: 'FARE COMPLETE', sub: formatMoney(pay), style: 'info', duration: 2.5 });
    }
    sim.events.emit('activityMilestone', { kind: 'taxi', reward: pay + (j.fares % 5 === 0 ? 500 : 0) });
    if (!spawnFare(host, j)) host.end('Taxi job ended.');
  }
}

/**
 * The fare walks to the cab once it waits close by (BOARD_*), to the nearest door of a free seat, and gets in there;
 * if it pulls away first, he walks back to where he set off from. True once he is aboard (or, with no seat free,
 * gone). Someone scared (gunfire, a hit) runs or fights like anyone else, and boards once he is over it.
 */
function board(host: ActivityHost, j: TaxiJob, f: Character, v: Vehicle, dt: number): boolean {
  const sim = host.sim;
  const b = f.brain;
  const scared = !!b && (b.mode === 'flee' || b.mode === 'cower' || b.mode === 'fight');
  const d = Math.hypot(f.pos.x - v.pos.x, f.pos.z - v.pos.z);
  const waits = v.speed < CAB_STOPPED && d < (j.boarding >= 0 ? BOARD_GIVE_UP : BOARD_RANGE);
  if (!waits || scared || f.state !== 'normal') {
    j.boarding = -1;
    // Walking to a cab that left (the guard brain walks him, see below): back to his spot on the sidewalk, not
    // left standing in the road, and he waits there again.
    if (b?.mode === 'guard') {
      const wx = j.waitX - f.pos.x;
      const wz = j.waitZ - f.pos.z;
      const w = Math.hypot(wx, wz);
      if (w < 0.6) {
        b.mode = 'stand';
      } else {
        b.homeX = j.waitX + (wx / w) * 2.4;
        b.homeZ = j.waitZ + (wz / w) * 2.4;
      }
    }
    return false;
  }
  if (j.boarding < 0) {
    j.boarding = 0;
    // Setting off from here (he may have run off and wandered since he was put down), unless he is still on his
    // way back to where he set off from last time, maybe in the road.
    if (b?.mode !== 'guard') {
      j.waitX = f.pos.x;
      j.waitZ = f.pos.z;
    }
  }
  j.boarding += dt;
  // The free seat with the door nearest him (see Sim.syncOccupant: seats 1 and 3 on the right, 2 and 3 at the back).
  const rx = -Math.cos(v.heading);
  const rz = Math.sin(v.heading);
  const out = v.halfW + DOOR_OUT;
  let seat = -1;
  let door = { x: 0, z: 0, d: Infinity };
  for (let s = 1; s <= v.passengers.length; s++) {
    if (v.passengers[s - 1] !== null) continue;
    const side = s === 2 ? -out : out;
    const back = s >= 2 ? -0.9 : 0.15;
    const x = v.pos.x + rx * side + Math.sin(v.heading) * back;
    const z = v.pos.z + rz * side + Math.cos(v.heading) * back;
    const to = Math.hypot(x - f.pos.x, z - f.pos.z);
    if (to < door.d) {
      seat = s;
      door = { x, z, d: to };
    }
  }
  if (b && seat > 0 && door.d > BOARD_REACH && j.boarding < BOARD_MAX) {
    // The guard brain walks a ped to his post and stops 2.5 m short of it: set past the door, he walks up to it.
    b.mode = 'guard';
    b.homeX = door.x + ((door.x - f.pos.x) / door.d) * 2.4;
    b.homeZ = door.z + ((door.z - f.pos.z) / door.d) * 2.4;
    return false;
  }
  j.boarding = -1;
  if (b) b.mode = 'stand';
  if (seat > 0) sim.seat(f, v, seat);
  else sim.removeCharacter(f);
  return true;
}

/** Lets a fare out on the curb side: the passenger door, or the side their destination is on. */
export function placeOnSidewalk(host: ActivityHost, c: Character, v: Vehicle, towardX?: number, towardZ?: number): void {
  const sim = host.sim;
  // Passenger side = local -X (right), the curb in right-hand traffic.
  let sx = -Math.cos(v.heading);
  let sz = Math.sin(v.heading);
  // Stopped facing against traffic: the destination's curb is on the driver's side.
  if (towardX !== undefined && towardZ !== undefined && (towardX - v.pos.x) * sx + (towardZ - v.pos.z) * sz < 0) {
    sx = -sx;
    sz = -sz;
  }
  // Step over the rest of the road onto the sidewalk: the lanes and the shoulder, the long way across from a cab
  // left askew (a job ended in a slide), or square to the road from one left across it, bounded (the middle of
  // an intersection). That side, unless another reaches the sidewalk much sooner. Each way starts clear of the
  // cab's body (its half-length along it, its half-width across it), and a way the cab is rolling into faster
  // than CAB_STOPPED (a job ended at speed) is taken only when no other reaches the sidewalk: he would land in its path.
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  const clear = (dx: number, dz: number) => Math.abs(dx * fx + dz * fz) * v.halfL + Math.abs(dx * sx + dz * sz) * v.halfW + 0.8;
  // The first spot that way off the road and free to stand on (past a lamp post at the curb, say): a spot moved
  // to the nearest free one instead could land back in the road, under the cab.
  const curb = (dx: number, dz: number): number | null => {
    for (let d = clear(dx, dz); d <= CURB_SEARCH; d += 0.5) {
      const x = v.pos.x + dx * d;
      const z = v.pos.z + dz * d;
      if (!sim.world.isOnRoad(x, z) && sim.world.isFree(x, z, 0.4)) return d;
    }
    return null;
  };
  const road = sim.roads.nearestLane(v.pos.x, v.pos.z).lane.heading;
  const sides: Array<[number, number]> = [[sx, sz], [-sx, -sz], [-Math.cos(road), Math.sin(road)], [Math.cos(road), -Math.sin(road)]];
  const found = sides.map(([dx, dz]) => ({ dx, dz, d: curb(dx, dz) })).filter((f): f is { dx: number; dz: number; d: number } => f.d !== null);
  // (Never at a drop-off, where the cab is stopped: he gets out on his destination's side.)
  const clearOfIt = found.filter((f) => v.vel.x * f.dx + v.vel.z * f.dz < CAB_STOPPED);
  const pool = clearOfIt.length > 0 ? clearOfIt : found;
  const nearest = Math.min(...pool.map((f) => f.d));
  // All road around: out of the door on the side the cab is moving away from, clear of it.
  const away = v.vel.x * sx + v.vel.z * sz > 0 ? -1 : 1;
  const out = pool.find((f) => f.d <= nearest + 3) ?? { dx: sx * away, dz: sz * away, d: clear(sx, sz) };
  const spot = sim.world.findFreeSpot(v.pos.x + out.dx * out.d, v.pos.z + out.dz * out.d, 0.4, 8) ?? { x: v.pos.x, z: v.pos.z };
  c.pos.x = spot.x;
  c.pos.z = spot.z;
  c.pos.y = sim.world.groundHeight(spot.x, spot.z);
  c.state = 'normal';
}

/**
 * A fare let go on his way to the cab (maybe in the road): he walks back to the sidewalk spot he set off from (the
 * guard brain walks him, see board), and wanders off from there once he has had the time to get there.
 */
function walkBack(host: ActivityHost, c: Character, x: number, z: number): void {
  const b = c.brain;
  const dx = x - c.pos.x;
  const dz = z - c.pos.z;
  const d = Math.hypot(dx, dz);
  if (!b || d < 0.6) return;
  b.mode = 'guard';
  b.homeX = x + (dx / d) * 2.4;
  b.homeZ = z + (dz / d) * 2.4;
  setTimeoutLike(host.sim, d / 1.6 + 0.3, () => {
    if (c.removed || !c.alive || b.mode !== 'guard') return;
    b.mode = 'wander';
    b.toNode = -1;
  });
}

export const taxiActivity: ActivityDef<TaxiJob> = {
  kind: 'taxi',
  toggleEndText: 'Taxi job ended.',

  canStart: (_host, _slot, vehicle) => vehicle?.kind === 'taxi',

  prompt: (_host, _slot, vehicle) => (vehicle && vehicle.speed < 1 ? 'Press T to start a taxi job' : null),

  start(host, _slot, taxi) {
    if (!taxi) return false;
    spawnFare(host, begin(host, taxi));
    return true;
  },

  update: updateTaxi,

  end(host, j) {
    const fare = j.fare;
    if (!fare || fare.removed) return;
    const cab = fare.vehicle;
    if (cab) {
      // Let out on the curb, as at a drop-off: unseated where he sits he would stand inside the cab's body,
      // and the physics would shove him out into the traffic, or under the cab itself in a slide.
      host.sim.unseat(fare);
      if (fare.alive) placeOnSidewalk(host, fare, cab);
    }
    const walking = fare.brain?.mode === 'guard';
    fare.hailTimer = 0;
    releaseCharacter(fare);
    if (walking) walkBack(host, fare, j.waitX, j.waitZ);
  },

  objectives(j): Objective[] {
    if (j.stage === 'pickup' && j.fare) return [{ x: j.fare.pos.x, z: j.fare.pos.z, label: 'Fare', color: 0x3dd9ff, radius: 4, character: j.fare }];
    if (j.stage === 'dropoff') return [{ x: j.destX, z: j.destZ, label: j.destName, color: 0xffd23d, radius: 6 }];
    return [];
  },

  status: (j) => (j.stage === 'dropoff' ? `FARE TIME ${Math.ceil(j.timer)}  ·  FARES ${j.fares}` : `FARES ${j.fares}`),
};
