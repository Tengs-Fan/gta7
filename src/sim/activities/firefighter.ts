// Firefighter: in the fire truck, put out the fires the job starts (burning cars and bins) with the water cannon before the
// time runs out. Level L lights firesFor(L) fires, adds timeFor(L) seconds and pays rewardFor(L) once the last is out.

import { formatMoney } from '../../core/math';
import type { Vehicle } from '../entities';
import { VEHICLE_SPECS, type VehicleKind } from '../specs';
import { clearOfVehicles } from '../vehicleRoom';
import { jetReaches, waterJetOf } from '../waterCannon';
import { activityRecords } from './records';
import { awayStatus, outOfVehicle } from './service';
import type { ActivityDef, ActivityHost, Objective } from './types';

export interface ActivityFire {
  id: number;
  x: number;
  y: number;
  z: number;
  /** 1 when lit, 0 when out. */
  strength: number;
  /** The burning car, or null for a burning bin. */
  vehicle: Vehicle | null;
}

export interface FireJob {
  kind: 'firefighter';
  truck: Vehicle;
  level: number;
  timer: number;
  fires: ActivityFire[];
  away: number;
  pause: number;
  completed: number;
  /** Seconds of water on the fires so far, for the measurement in the tests. */
  sprayed: number;
}

/** Fires per level: one more per level, at most five. */
export function firesFor(level: number): number {
  return Math.min(5, Math.max(1, level));
}

/** Seconds a level adds to the clock: 50 + 30 a fire. */
export function timeFor(level: number): number {
  return 50 + 30 * firesFor(level);
}

/** Pay once a level's fires are all out: $200 a fire plus $100 a level. */
export function rewardFor(level: number): number {
  return 200 * firesFor(level) + 100 * level;
}

/** Strength a fire loses per second of water: a full one takes 1 / EXTINGUISH_RATE = 2.5 s. */
export const EXTINGUISH_RATE = 0.4;

const FIRE_CARS: readonly VehicleKind[] = ['sedan', 'compact', 'pickup', 'muscle'];

/** The fires of the running firefighter job, for the renderer (bins have no entity of their own). */
export function activityFires(job: { kind: string } | null): readonly ActivityFire[] {
  return job && job.kind === 'firefighter' ? (job as FireJob).fires : [];
}

function lightFires(host: ActivityHost, j: FireJob): boolean {
  const sim = host.sim;
  const n = firesFor(j.level);
  const t = j.truck;
  // Car fires on parking bays 60-220 m off, bins on the sidewalks; alternating, a car first.
  const bays = sim.world.layout.parking.filter((s) => {
    const d = Math.hypot(s.x - t.pos.x, s.z - t.pos.z);
    return d > 60 && d < 220;
  });
  for (let i = 0; i < n; i++) {
    let lit = false;
    if (i % 2 === 0 && bays.length > 0) {
      for (let k = 0; k < 6 && !lit; k++) {
        const s = bays[sim.rng.int(0, bays.length - 1)]!;
        const kind = FIRE_CARS[sim.rng.int(0, FIRE_CARS.length - 1)]!;
        if (!clearOfVehicles(sim, kind, s.x, s.z, s.heading)) continue;
        const v = sim.spawnVehicle(kind, s.x, s.z, s.heading, VEHICLE_SPECS[kind].colors[0]);
        v.owner = 'mission';
        v.persistent = true;
        v.missionTag = 'fire';
        v.burning = true;
        v.burnTimer = 1e9;
        v.health = 0;
        j.fires.push({ id: sim.newId(), x: v.pos.x, y: v.pos.y, z: v.pos.z, strength: 1, vehicle: v });
        lit = true;
      }
    }
    if (lit) continue;
    const pt = sim.world.walk.randomPointNear(sim.rng, t.pos.x, t.pos.z, 60, 200);
    if (!pt || sim.world.waterDepth(pt.x, pt.z) > -0.1) continue;
    j.fires.push({ id: sim.newId(), x: pt.x, y: sim.world.groundHeight(pt.x, pt.z), z: pt.z, strength: 1, vehicle: null });
  }
  if (j.fires.length === 0) return false;
  j.timer += timeFor(j.level);
  host.say(`Level ${j.level}: ${j.fires.length === 1 ? 'a fire' : `${j.fires.length} fires`} on the radar. Hold fire to use the water cannon.`, 4);
  return true;
}

/** Puts a fire out for good: its car stops burning, charred, and goes back to the city. */
function douse(f: ActivityFire): void {
  f.strength = 0;
  const v = f.vehicle;
  if (!v || v.removed) return;
  v.burning = false;
  v.burnTimer = 0;
  if (!v.destroyed) v.health = Math.max(v.health, v.spec.health * 0.2);
  v.owner = 'none';
  v.persistent = false;
  v.missionTag = '';
}

function updateFire(host: ActivityHost, j: FireJob, dt: number): void {
  const sim = host.sim;
  const truck = j.truck;
  // The cannon works from the cab, not from the street: out of the truck, the fires keep burning but the job waits.
  if (outOfVehicle(host, j, truck, `The fire truck is wrecked. Firefighter job over at level ${j.level}.`, `You left the fire truck. Firefighter job over at level ${j.level}.`, dt)) return;
  if (j.pause > 0) {
    j.pause -= dt;
    if (j.pause <= 0 && !lightFires(host, j)) host.end('No fires to fight. Firefighter job over.');
    return;
  }
  j.timer -= dt;
  if (j.timer <= 0) {
    host.end(`Out of time. Firefighter job over at level ${j.level}.`);
    return;
  }
  const jet = waterJetOf(truck, sim.frame);
  const rec = activityRecords(sim.progress);
  let wet = false;
  for (const f of j.fires) {
    const v = f.vehicle;
    if (v) {
      // Blown up or gone by some other way: the record is dropped with the level, so let go of the car now.
      if (v.removed || v.destroyed) {
        if (f.strength > 0 || v.persistent) douse(f);
      } else {
        f.x = v.pos.x;
        f.y = v.pos.y;
        f.z = v.pos.z;
        // The flames stay up until the water beats them; the car never burns out by itself.
        if (f.strength > 0) {
          v.burning = true;
          v.burnTimer = 1e9;
        }
      }
    }
    if (f.strength <= 0 || !jet || !jetReaches(jet, f.x, f.z, v ? v.halfL : 0.6)) continue;
    wet = true;
    f.strength = Math.max(0, f.strength - EXTINGUISH_RATE * dt);
    if (f.strength <= 0) {
      douse(f);
      rec.firesOut++;
      const left = j.fires.filter((g) => g.strength > 0).length;
      if (left > 0) host.say(`Fire out. ${left} to go.`, 2);
    }
  }
  if (wet) j.sprayed += dt;
  if (j.fires.some((f) => f.strength > 0)) return;
  const reward = rewardFor(j.level);
  sim.progress.addMoney(reward);
  sim.events.emit('money', { amount: reward });
  j.completed = j.level;
  rec.fireLevel = Math.max(rec.fireLevel, j.level);
  sim.events.emit('big', { text: `FIREFIGHTER LEVEL ${j.level}`, sub: formatMoney(reward), style: 'passed', duration: 2.5 });
  sim.events.emit('activityMilestone', { kind: 'firefighter', reward });
  j.fires = [];
  j.level++;
  j.pause = 2.5;
}

export const firefighterActivity: ActivityDef<FireJob> = {
  kind: 'firefighter',
  toggleEndText: 'Firefighter job ended.',
  completion: (_view, me) => ({ label: 'Firefighter level 5', done: Math.min(5, activityRecords(me.progress).fireLevel), total: 5 }),

  canStart: (_host, _slot, vehicle) => vehicle?.kind === 'firetruck',

  prompt: (_host, _slot, vehicle) => (vehicle && vehicle.speed < 1 && vehicle.drivable ? 'Press T to start a firefighter job' : null),

  start(host, _slot, truck) {
    if (!truck || !truck.drivable) return false;
    const j: FireJob = { kind: 'firefighter', truck, level: 1, timer: 0, fires: [], away: 0, pause: 0, completed: 0, sprayed: 0 };
    host.job = j;
    host.sim.events.emit('big', { text: 'FIREFIGHTER', sub: 'Put out the fires before the time runs out', style: 'title', duration: 3 });
    if (!lightFires(host, j)) {
      host.end('No fires to fight.');
      return false;
    }
    return true;
  },

  update: updateFire,

  end(host, j) {
    for (const f of j.fires) douse(f);
    j.fires = [];
    const rec = activityRecords(host.sim.progress);
    rec.fireLevel = Math.max(rec.fireLevel, j.completed);
  },

  objectives(j): Objective[] {
    return j.fires.filter((f) => f.strength > 0).map((f) => ({ x: f.x, z: f.z, label: 'Fire', color: 0xff6a1a, radius: 3, vehicle: f.vehicle }));
  },

  status: (j) => awayStatus(j, 'FIRE TRUCK') ?? `FIREFIGHTER LVL ${j.level}  ·  ${Math.max(0, Math.ceil(j.timer))}  ·  FIRES ${j.fires.filter((f) => f.strength > 0).length}`,
};
