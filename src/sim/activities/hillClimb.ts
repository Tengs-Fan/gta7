// The Coyote Ridge Hill Climb: a timed run up the fire road on Coyote Ridge in Las Lomas County, from the gate at its
// turn-off on the Lomas Highway round the switchbacks to Lookout Point (world/country/hills.ts). In any road vehicle at
// the foot gate, T starts it: stop in the gate, a three-second countdown, then six gates in order against the clock, with
// bronze, silver and gold, cash and a saved best as on the Gull Regatta. Single player only.

import { formatMoney } from '../../core/math';
import { fireRoadLine, FIRE_ROAD } from '../../world/country/hills';
import type { Vehicle } from '../entities';
import { registerStatRow } from '../statRows';
import { formatRunTime } from '../streetRuns';
import { activityRecords } from './records';
import type { ActivityDef, ActivityHost, Objective } from './types';

declare module './types' {
  interface JobKinds {
    hillClimb: HillClimbJob;
  }
}

export interface HillClimbGate {
  x: number;
  z: number;
  label: string;
}

export interface HillClimbJob {
  kind: 'hillClimb';
  car: Vehicle;
  stage: 'approach' | 'countdown' | 'racing';
  countdown: number;
  elapsed: number;
  /** Index of the next gate to pass. */
  gate: number;
  previousX: number;
  previousZ: number;
}

export type HillClimbMedal = 'gold' | 'silver' | 'bronze';

export const HILL_CLIMB_NAME = 'Coyote Ridge Hill Climb';

/** The foot gate on the gravel just off the highway, facing up the fire road. */
export const HILL_CLIMB_START = { x: FIRE_ROAD[0]![0] - 9, z: FIRE_ROAD[0]![1], heading: -Math.PI / 2, radius: 8 } as const;
/** A vehicle within this distance (m) of the foot gate can start the climb. */
export const HILL_CLIMB_REACH = 12;
/** Every gate's radius (m): the road's width and a little over, so a car cutting a bend still makes its gate. */
export const HILL_CLIMB_GATE_R = 7;

/** The road's point nearest (x, z). */
function onRoad(x: number, z: number): { x: number; z: number } {
  return fireRoadLine(1).reduce((a, p) => (Math.hypot(p.x - x, p.z - z) < Math.hypot(a.x - x, a.z - z) ? p : a));
}

/** The gates: each bend of the switchbacks where the road rounds it, and Lookout Point's car park at the top. */
export const HILL_CLIMB_GATES: readonly HillClimbGate[] = [
  ...FIRE_ROAD.slice(1, -1).map(([x, z], i) => ({ ...onRoad(x, z), label: i === FIRE_ROAD.length - 3 ? 'The crest' : `Switchback ${i + 1}` })),
  { x: FIRE_ROAD[FIRE_ROAD.length - 1]![0], z: FIRE_ROAD[FIRE_ROAD.length - 1]![1], label: 'Lookout Point' },
];

/** Medal times (s) in a Nightjar, from a scripted run's time (hill_climb.test.ts): gold about 5% over it, silver 25%, bronze 60%. */
export const HILL_CLIMB_TIMES = { gold: 15.7, silver: 18.7, bronze: 23.9 } as const;
/** Gold's payout; silver pays 70% of it and bronze 45%, as on the street runs. */
export const HILL_CLIMB_REWARD = 1000;

export const MP_NO_HILL_CLIMB = 'The Coyote Ridge Hill Climb is single-player only.';

export function hillClimbMedal(seconds: number): HillClimbMedal | null {
  if (seconds <= 0 || seconds > HILL_CLIMB_TIMES.bronze) return null;
  return seconds <= HILL_CLIMB_TIMES.gold ? 'gold' : seconds <= HILL_CLIMB_TIMES.silver ? 'silver' : 'bronze';
}

function atFoot(v: Vehicle): boolean {
  return Math.hypot(v.pos.x - HILL_CLIMB_START.x, v.pos.z - HILL_CLIMB_START.z) <= HILL_CLIMB_REACH;
}

function atStart(j: HillClimbJob): boolean {
  return Math.hypot(j.car.pos.x - HILL_CLIMB_START.x, j.car.pos.z - HILL_CLIMB_START.z) <= HILL_CLIMB_START.radius && j.car.speed <= 2.5;
}

/** Holds the car in the foot gate, facing up the road. */
function holdStart(host: ActivityHost, j: HillClimbJob): void {
  const c = j.car;
  c.pos.x = HILL_CLIMB_START.x;
  c.pos.z = HILL_CLIMB_START.z;
  c.pos.y = host.sim.world.groundHeight(c.pos.x, c.pos.z);
  c.heading = HILL_CLIMB_START.heading;
  c.vel.x = c.vel.z = c.vy = c.angVel = c.speed = c.forwardSpeed = c.steer = 0;
  c.controls.throttle = c.controls.brake = c.controls.steer = 0;
  c.controls.handbrake = true;
  host.sim.syncOccupant(host.sim.player);
  j.previousX = c.pos.x;
  j.previousZ = c.pos.z;
}

function beginCountdown(host: ActivityHost, j: HillClimbJob): void {
  const sim = host.sim;
  if (sim.wanted.level > 0) {
    host.end('The start is compromised. Lose the cops and press T at the foot of the fire road to try again.');
    return;
  }
  j.stage = 'countdown';
  j.countdown = 3;
  sim.controlLock = Math.max(sim.controlLock, 3.1);
  holdStart(host, j);
  sim.events.emit('objective', { text: `Get ready · ${HILL_CLIMB_NAME}` });
  host.say('Hold W to go at GO. Brake for the switchbacks.', 4);
  sim.events.emit('streetRunCountdown', { count: 3 });
}

function announceGate(host: ActivityHost, j: HillClimbJob): void {
  const g = HILL_CLIMB_GATES[j.gate]!;
  const last = j.gate === HILL_CLIMB_GATES.length - 1;
  host.sim.events.emit('objective', { text: `${HILL_CLIMB_NAME} · ${last ? 'FINISH AT LOOKOUT POINT' : `Gate ${j.gate + 1}/${HILL_CLIMB_GATES.length} · ${g.label}`}` });
}

function update(host: ActivityHost, j: HillClimbJob, dt: number): void {
  const sim = host.sim;
  const car = j.car;
  if (sim.player.vehicle !== car || car.driver !== sim.player || !car.drivable || car.removed || !sim.player.alive) {
    sim.events.emit('big', { text: 'CLIMB ENDED', sub: 'Bring a vehicle back to the foot of the fire road to try again.', style: 'failed', duration: 3 });
    host.end('Hill climb over. Drive to the foot of the fire road and press T to try again.');
    return;
  }
  if (j.stage === 'approach') {
    if (atStart(j)) beginCountdown(host, j);
    return;
  }
  if (j.stage === 'countdown') {
    const before = Math.ceil(j.countdown);
    j.countdown = Math.max(0, j.countdown - dt);
    holdStart(host, j);
    const count = Math.ceil(j.countdown) as 0 | 1 | 2 | 3;
    if (count !== before) sim.events.emit('streetRunCountdown', { count });
    if (j.countdown > 0) return;
    j.stage = 'racing';
    if (sim.controlLock <= 0.101) sim.controlLock = 0;
    car.controls.handbrake = false;
    announceGate(host, j);
    return;
  }
  j.elapsed += dt;
  if (j.elapsed > HILL_CLIMB_TIMES.bronze) {
    sim.events.emit('big', { text: 'OUT OF TIME', sub: `${HILL_CLIMB_NAME} · ${j.gate}/${HILL_CLIMB_GATES.length} gates`, style: 'failed', duration: 4 });
    host.end('Hill climb over. Press T at the foot of the fire road to try again.');
    return;
  }
  const gate = HILL_CLIMB_GATES[j.gate]!;
  const dx = car.pos.x - j.previousX;
  const dz = car.pos.z - j.previousZ;
  const lengthSq = dx * dx + dz * dz;
  // Swept, as the street runs' gates are; a teleport skips no gate and buys no record.
  if (Math.sqrt(lengthSq) > Math.max(12, car.spec.maxSpeed * dt * 2 + 4)) {
    host.end('Hill climb interrupted. Press T at the foot of the fire road to line up again.');
    return;
  }
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((gate.x - j.previousX) * dx + (gate.z - j.previousZ) * dz) / lengthSq)) : 1;
  const hit = Math.hypot(j.previousX + dx * t - gate.x, j.previousZ + dz * t - gate.z) <= HILL_CLIMB_GATE_R;
  j.previousX = car.pos.x;
  j.previousZ = car.pos.z;
  if (!hit) return;
  j.gate++;
  sim.events.emit('streetRunCheckpoint', { index: j.gate, total: HILL_CLIMB_GATES.length, elapsed: j.elapsed });
  if (j.gate === HILL_CLIMB_GATES.length) {
    finish(host, j);
    return;
  }
  announceGate(host, j);
}

function finish(host: ActivityHost, j: HillClimbJob): void {
  const sim = host.sim;
  const medal = hillClimbMedal(j.elapsed)!;
  const rec = activityRecords(sim.progress);
  const ms = Math.round(j.elapsed * 1000);
  const best = rec.hillClimbBest === 0 || ms < rec.hillClimbBest;
  if (best) rec.hillClimbBest = ms;
  const reward = Math.round(HILL_CLIMB_REWARD * (medal === 'gold' ? 1 : medal === 'silver' ? 0.7 : 0.45));
  sim.progress.addMoney(reward);
  // End before announcing the result: a listener cannot collect it twice.
  host.end('Take in the view. Press T at the foot of the fire road to climb it again.');
  sim.events.emit('money', { amount: reward });
  sim.events.emit('big', { text: `${medal.toUpperCase()} FINISH`, sub: `${HILL_CLIMB_NAME} · ${formatRunTime(j.elapsed)} · ${formatMoney(reward)}${best ? ' · NEW BEST' : ''}`, style: 'passed', duration: 6 });
  sim.events.emit('activityMilestone', { kind: 'hillClimb', reward });
}

export const hillClimbActivity: ActivityDef<HillClimbJob> = {
  kind: 'hillClimb',
  toggleEndText: 'Hill climb abandoned. Press T at the foot of the fire road to try again.',
  site: { label: 'peak', name: HILL_CLIMB_NAME, best: 'hillClimbBest', at: () => HILL_CLIMB_START },
  completion: (_view, me) => ({ label: 'Hill Climb medal', done: activityRecords(me.progress).hillClimbBest > 0 ? 1 : 0, total: 1 }),

  canStart: (host, slot, vehicle) => !!vehicle && vehicle.spec.class !== 'boat' && vehicle.driver === slot && !host.job && atFoot(vehicle),

  prompt: (host, _slot, vehicle) => (vehicle && vehicle.speed < 1 && !host.sim.multiplayer && host.sim.wanted.level === 0 ? `Press T to start the ${HILL_CLIMB_NAME}` : null),

  start(host, _slot, car) {
    const sim = host.sim;
    if (!car) return false;
    if (sim.multiplayer) {
      host.say(MP_NO_HILL_CLIMB, 3);
      return false;
    }
    if (sim.wanted.level > 0) {
      host.say('Lose the cops before starting the hill climb.', 3);
      return false;
    }
    const j: HillClimbJob = { kind: 'hillClimb', car, stage: 'approach', countdown: 0, elapsed: 0, gate: 0, previousX: car.pos.x, previousZ: car.pos.z };
    host.job = j;
    sim.events.emit('big', { text: HILL_CLIMB_NAME.toUpperCase(), sub: `${HILL_CLIMB_GATES.length} gates · GOLD ${formatRunTime(HILL_CLIMB_TIMES.gold)} · ${formatMoney(HILL_CLIMB_REWARD)}`, style: 'title', duration: 3 });
    if (atStart(j)) beginCountdown(host, j);
    else {
      sim.events.emit('objective', { text: 'Stop in the foot gate of the fire road. T cancels.' });
      host.say('Every gate in order, up to Lookout Point. T cancels.', 5);
    }
    return true;
  },

  update,

  end(host, j) {
    if (j.stage === 'countdown') {
      if (host.sim.controlLock <= j.countdown + 0.101) host.sim.controlLock = 0;
      j.car.controls.handbrake = false;
    }
  },

  objectives(j): Objective[] {
    if (j.stage !== 'racing') return [{ x: HILL_CLIMB_START.x, z: HILL_CLIMB_START.z, label: `${HILL_CLIMB_NAME} · Start`, color: 0x50f1d1, radius: HILL_CLIMB_START.radius }];
    const g = HILL_CLIMB_GATES[j.gate]!;
    const last = j.gate === HILL_CLIMB_GATES.length - 1;
    return [{ x: g.x, z: g.z, label: last ? 'Finish' : `${j.gate + 1}/${HILL_CLIMB_GATES.length} · ${g.label}`, color: last ? 0xffd23d : 0x50f1d1, radius: HILL_CLIMB_GATE_R }];
  },

  status(j) {
    if (j.stage === 'approach') return 'COYOTE RIDGE HILL CLIMB · STOP IN THE FOOT GATE';
    if (j.stage === 'countdown') return `COYOTE RIDGE HILL CLIMB · ${Math.ceil(j.countdown)}`;
    return `COYOTE RIDGE HILL CLIMB · GATE ${j.gate + 1}/${HILL_CLIMB_GATES.length} · ${formatRunTime(j.elapsed)}`;
  },
};

registerStatRow({
  id: 'hillClimbBest',
  label: 'Coyote Ridge Hill Climb best',
  value: (v) => {
    const best = activityRecords(v.player.progress).hillClimbBest;
    return best > 0 ? `${formatRunTime(best / 1000)} (${hillClimbMedal(best / 1000)})` : '-';
  },
});
