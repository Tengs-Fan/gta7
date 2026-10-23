// Paramedic: in an ambulance, pick up the injured the job marks and bring them to San Azura General before the time runs
// out. Level L has patientsFor(L) patients and adds timeFor(L) seconds to the clock; delivering them all pays rewardFor(L).

import { formatMoney } from '../../core/math';
import { makeBrain } from '../brains';
import type { Character, Vehicle } from '../entities';
import { places } from './places';
import { activityRecords } from './records';
import { awayStatus, letOut, outOfVehicle, releasePerson } from './service';
import type { ActivityDef, ActivityHost, Objective } from './types';

export interface AmbulanceJob {
  kind: 'ambulance';
  car: Vehicle;
  level: number;
  timer: number;
  /** This level's patients still waiting on the ground. */
  waiting: Character[];
  /** Patients aboard, on their way to the hospital. */
  aboard: Character[];
  /** Seconds the ambulance has stood still beside the nearest waiting patient. */
  loading: number;
  away: number;
  /** Seconds before the next level's patients are called in. */
  pause: number;
  /** Levels completed in this job. */
  completed: number;
  /** The hospital's ambulance bay. */
  dropX: number;
  dropZ: number;
}

/** Patients per level: one more per level, as many as the ambulance's three free seats hold. */
export function patientsFor(level: number): number {
  return Math.min(3, Math.max(1, level));
}

/** Seconds a level adds to the clock: 40 + 30 a patient, 5 fewer for every level after the first (at least 45). */
export function timeFor(level: number): number {
  return Math.max(45, 40 + 30 * patientsFor(level) - 5 * (level - 1));
}

/** Pay for delivering a level's patients: $100 a level plus $100 a patient. */
export function rewardFor(level: number): number {
  return 100 * level + 100 * patientsFor(level);
}

/** A patient boards once the ambulance has stood this long (s) within LOAD_RANGE (m) of him, slower than LOAD_SPEED (m/s). */
export const LOAD_TIME = 1;
export const LOAD_RANGE = 6;
export const LOAD_SPEED = 2.5;

function spawnPatients(host: ActivityHost, j: AmbulanceJob): boolean {
  const sim = host.sim;
  const n = patientsFor(j.level);
  for (let i = 0; i < n; i++) {
    const pt = sim.world.walk.randomPointNear(sim.rng, j.car.pos.x, j.car.pos.z, 50, 170);
    if (!pt || sim.world.waterDepth(pt.x, pt.z) > -0.1) continue;
    const c = sim.spawnCharacter('civilian', pt.x, pt.z);
    c.owner = 'mission';
    c.persistent = true;
    c.missionTag = 'patient';
    c.health = 45;
    c.brain = makeBrain('stand');
    c.state = 'knocked';
    c.knockTimer = 1e9;
    j.waiting.push(c);
  }
  if (j.waiting.length === 0) return false;
  j.timer += timeFor(j.level);
  host.say(`Level ${j.level}: ${j.waiting.length === 1 ? 'pick up the patient' : `pick up ${j.waiting.length} patients`} (green markers), then drive to San Azura General.`, 4);
  return true;
}

function freeSeat(v: Vehicle): number {
  for (let s = 1; s <= v.passengers.length; s++) if (v.passengers[s - 1] === null) return s;
  return -1;
}

function updateAmbulance(host: ActivityHost, j: AmbulanceJob, dt: number): void {
  const sim = host.sim;
  const car = j.car;
  if (outOfVehicle(host, j, car, `The ambulance is wrecked. Paramedic job over at level ${j.level}.`, `You left the ambulance. Paramedic job over at level ${j.level}.`, dt)) return;
  if (j.pause > 0) {
    j.pause -= dt;
    if (j.pause <= 0 && !spawnPatients(host, j)) host.end('No patients around. Paramedic job over.');
    return;
  }
  // A patient lost on the way (run over, shot, streamed out by something else) ends the job.
  for (const c of [...j.waiting, ...j.aboard]) {
    if (c.removed || !c.alive) {
      host.end('A patient died. Paramedic job over.');
      return;
    }
  }
  j.timer -= dt;
  if (j.timer <= 0) {
    host.end(`Out of time. Paramedic job over at level ${j.level}.`);
    return;
  }
  // Keep the waiting injured down where they lie.
  for (const c of j.waiting) if (c.state === 'normal' || c.state === 'knocked') {
    c.state = 'knocked';
    c.knockTimer = 1e9;
  }
  const slow = car.speed < LOAD_SPEED;
  let near: Character | null = null;
  let nd = LOAD_RANGE;
  for (const c of j.waiting) {
    const d = Math.hypot(c.pos.x - car.pos.x, c.pos.z - car.pos.z) - car.halfW;
    if (d < nd) {
      nd = d;
      near = c;
    }
  }
  if (near && slow && freeSeat(car) > 0) {
    j.loading += dt;
    if (j.loading >= LOAD_TIME) {
      j.loading = 0;
      near.knockTimer = 0;
      near.state = 'normal';
      sim.seat(near, car, freeSeat(car));
      j.waiting.splice(j.waiting.indexOf(near), 1);
      j.aboard.push(near);
      host.say(j.waiting.length > 0 ? `Patient aboard. ${j.waiting.length} more to pick up.` : 'All aboard. Get them to San Azura General!', 2.5);
    }
  } else {
    j.loading = 0;
  }
  const drop = places(sim.world).hospitalDrop;
  if (j.aboard.length > 0 && slow && Math.hypot(car.pos.x - drop.x, car.pos.z - drop.z) < drop.radius) {
    const rec = activityRecords(sim.progress);
    for (const c of j.aboard) {
      sim.removeCharacter(c);
      rec.patientsSaved++;
    }
    j.aboard = [];
    if (j.waiting.length > 0) {
      host.say(`Patients delivered. ${j.waiting.length} still waiting.`, 2.5);
      return;
    }
    const reward = rewardFor(j.level);
    sim.progress.addMoney(reward);
    sim.events.emit('money', { amount: reward });
    j.completed = j.level;
    rec.ambulanceLevel = Math.max(rec.ambulanceLevel, j.level);
    sim.events.emit('big', { text: `PARAMEDIC LEVEL ${j.level}`, sub: formatMoney(reward), style: 'passed', duration: 2.5 });
    sim.events.emit('activityMilestone', { kind: 'ambulance', reward });
    j.level++;
    j.pause = 2;
  }
}

export const ambulanceActivity: ActivityDef<AmbulanceJob> = {
  kind: 'ambulance',
  toggleEndText: 'Paramedic job ended.',
  completion: (_view, me) => ({ label: 'Paramedic level 5', done: Math.min(5, activityRecords(me.progress).ambulanceLevel), total: 5 }),

  canStart: (_host, _slot, vehicle) => vehicle?.kind === 'ambulance',

  prompt: (_host, _slot, vehicle) => (vehicle && vehicle.speed < 1 && vehicle.drivable ? 'Press T to start a paramedic job' : null),

  start(host, _slot, car) {
    if (!car || !car.drivable) return false;
    const drop = places(host.sim.world).hospitalDrop;
    const j: AmbulanceJob = { kind: 'ambulance', car, level: 1, timer: 0, waiting: [], aboard: [], loading: 0, away: 0, pause: 0, completed: 0, dropX: drop.x, dropZ: drop.z };
    host.job = j;
    host.sim.events.emit('big', { text: 'PARAMEDIC', sub: 'Get the injured to hospital before the time runs out', style: 'title', duration: 3 });
    if (!spawnPatients(host, j)) {
      host.end('No patients around.');
      return false;
    }
    return true;
  },

  update: updateAmbulance,

  end(host, j) {
    for (const c of j.aboard) {
      letOut(host, c, j.car);
      releasePerson(c);
    }
    for (const c of j.waiting) releasePerson(c);
    j.aboard = [];
    j.waiting = [];
    const rec = activityRecords(host.sim.progress);
    rec.ambulanceLevel = Math.max(rec.ambulanceLevel, j.completed);
  },

  objectives(j): Objective[] {
    const out: Objective[] = j.waiting.map((c) => ({ x: c.pos.x, z: c.pos.z, label: 'Patient', color: 0x3dff7a, radius: 3, character: c }));
    if (j.aboard.length > 0) out.push({ x: j.dropX, z: j.dropZ, label: 'San Azura General', color: 0xffffff, radius: 8 });
    return out;
  },

  status: (j) => awayStatus(j, 'AMBULANCE') ?? `PARAMEDIC LVL ${j.level}  ·  ${Math.max(0, Math.ceil(j.timer))}  ·  ABOARD ${j.aboard.length}`,
};
