import { formatMoney } from '../../core/math';
import { makeBrain } from '../brains';
import type { Character, Vehicle } from '../entities';
import type { ActivityDef, ActivityHost, Objective } from './types';

export interface VigilanteJob {
  kind: 'vigilante';
  car: Vehicle;
  level: number;
  target: Vehicle | null;
  /** The target's driver; tracked on its own because he leaves the car (dead or alive) before he counts as stopped. */
  suspect: Character | null;
  timer: number;
  pause: number;
}

function spawnSuspect(host: ActivityHost, j: VigilanteJob): void {
  const sim = host.sim;
  const v = sim.traffic.trySpawnTraffic(110, 260, sim.rng.pick(['sedan', 'muscle', 'sports', 'pickup'] as const));
  if (!v) {
    j.pause = 2;
    return;
  }
  v.owner = 'mission';
  v.persistent = true;
  v.missionTag = 'vigilante';
  v.health = v.spec.health * (0.8 + j.level * 0.1);
  const d = v.driver!;
  d.role = 'gang';
  d.persistent = true;
  d.owner = 'mission';
  d.missionTag = 'vigilante';
  v.ai!.setPolicy('flee');
  v.ai!.target = sim.player;
  j.target = v;
  j.suspect = d;
  j.timer = Math.max(j.timer, 60 + j.level * 10);
  host.say(`Level ${j.level}: stop the suspect!`);
}

function updateVigilante(host: ActivityHost, j: VigilanteJob, dt: number): void {
  const sim = host.sim;
  const v = sim.player.vehicle;
  if (v !== j.car || !j.car.drivable) {
    if (!host.waitsForPlayer(j.car)) host.end(`Vigilante ended at level ${j.level}.`);
    return;
  }
  if (j.pause > 0) {
    j.pause -= dt;
    if (j.pause <= 0) spawnSuspect(host, j);
    return;
  }
  j.timer -= dt;
  const t = j.target;
  if (!t) {
    spawnSuspect(host, j);
    return;
  }
  const neutralised = t.destroyed || t.removed || !t.driver || !t.driver.alive;
  if (neutralised) {
    const reward = 250 * j.level;
    sim.progress.addMoney(reward);
    sim.progress.stats.vigilanteLevel = Math.max(sim.progress.stats.vigilanteLevel, j.level);
    sim.events.emit('money', { amount: reward });
    sim.events.emit('big', { text: 'CRIMINAL STOPPED', sub: formatMoney(reward), style: 'passed', duration: 2.5 });
    releaseVehicle(t);
    releaseSuspect(host, j);
    j.target = null;
    j.level++;
    j.timer += 30;
    j.pause = 2.5;
    sim.events.emit('activityMilestone', { kind: 'vigilante', reward });
    return;
  }
  if (j.timer <= 0) {
    host.end(`Out of time. Vigilante ended at level ${j.level}.`);
    return;
  }
  if (sim.distToPlayer(t.pos.x, t.pos.z) > 480) host.end('The suspect got away.');
}

function releaseVehicle(v: Vehicle): void {
  v.persistent = false;
  v.missionTag = '';
  v.owner = 'none';
  if (v.ai) {
    v.ai.setPolicy('traffic');
    v.ai.target = null;
  }
}

/** Hands the vigilante suspect, dead or alive, back to the ambient systems so he can stream out. */
function releaseSuspect(host: ActivityHost, j: VigilanteJob): void {
  const c = j.suspect;
  j.suspect = null;
  if (!c || c.removed || c.isPlayer) return;
  c.persistent = false;
  c.missionTag = '';
  // Seated drivers belong to traffic, which hands them to the ped system when they get out.
  c.owner = c.state === 'inVehicle' ? 'traffic' : 'ped';
  if (c.alive && c.state !== 'inVehicle' && !c.brain) {
    // Traffic drivers spawn without a brain: without one he would stand frozen where he got out.
    c.brain = makeBrain('wander');
    host.sim.peds.flee(c, host.sim.player.pos.x, host.sim.player.pos.z, host.sim.player);
  }
}

export const vigilanteActivity: ActivityDef<VigilanteJob> = {
  kind: 'vigilante',
  toggleEndText: 'Vigilante ended.',

  canStart: (_host, _slot, vehicle) => !!vehicle?.spec.police,

  prompt: (_host, _slot, vehicle) => (vehicle && vehicle.speed < 1 ? 'Press T to start a vigilante job' : null),

  start(host, _slot, car) {
    if (!car) return false;
    const j: VigilanteJob = { kind: 'vigilante', car, level: 1, target: null, suspect: null, timer: 120, pause: 0 };
    host.job = j;
    host.sim.events.emit('big', { text: 'VIGILANTE', sub: 'Take out the criminal before the time runs out', style: 'title', duration: 3 });
    spawnSuspect(host, j);
    return true;
  },

  update: updateVigilante,

  end(host, j) {
    if (j.target) releaseVehicle(j.target);
    releaseSuspect(host, j);
  },

  objectives(j): Objective[] {
    return j.target ? [{ x: j.target.pos.x, z: j.target.pos.z, label: 'Suspect', color: 0xff3b3b, radius: 3, vehicle: j.target }] : [];
  },

  status: (j) => `VIGILANTE LVL ${j.level}  ·  ${Math.ceil(j.timer)}`,
};
