// The Gull Regatta: a timed boat course from the Marina up the coast outside the surf, a slalom through Turbine Row,
// round Smuggler's Key and the lighthouse on Azura Point and home again. In a boat near the Marina, T starts it: stop
// in the start gate, a three-second countdown, then fourteen gates in order against the clock, with bronze, silver and
// gold, cash and a saved best as on the street runs. Single player only.

import { formatMoney } from '../../core/math';
import type { Vehicle } from '../entities';
import { registerStatRow } from '../statRows';
import { formatRunTime } from '../streetRuns';
import { activityRecords } from './records';
import type { ActivityDef, ActivityHost, Objective } from './types';

declare module './types' {
  interface JobKinds {
    regatta: RegattaJob;
  }
}

export interface RegattaGate {
  x: number;
  z: number;
  label: string;
}

export interface RegattaJob {
  kind: 'regatta';
  boat: Vehicle;
  stage: 'approach' | 'countdown' | 'racing';
  countdown: number;
  elapsed: number;
  /** Index of the next gate to pass. */
  gate: number;
  previousX: number;
  previousZ: number;
}

export type RegattaMedal = 'gold' | 'silver' | 'bronze';

/** Where the course starts, east of the Marina's main deck, facing north up the coast. */
export const REGATTA_START = { x: 690, z: 400, heading: Math.PI, radius: 10 } as const;
/** A boat within this distance (m) of the Marina can start the regatta. */
export const REGATTA_REACH = 60;
/** Every gate's radius (m). */
export const REGATTA_GATE_R = 14;

/**
 * The course, every gate at least 30 m from a turbine and from the Key's rocks: outside the pier's end and up the coast,
 * a slalom through Turbine Row's near row (north of one tower, south of the next), then once round the Key (down its
 * east side, west along its south side, up the channel between it and Azura Point), round the lighthouse at the
 * Point's tip, back east along the Key's north side and down the coast to the Marina.
 */
export const REGATTA_GATES: readonly RegattaGate[] = [
  { x: 725, z: 40, label: 'Pier end' },
  { x: 722, z: -330, label: 'North beach' },
  { x: 700, z: -745, label: 'Turbine Row' },
  { x: 588, z: -835, label: 'Slalom' },
  { x: 476, z: -745, label: 'Slalom' },
  { x: 350, z: -600, label: "Smuggler's Key" },
  { x: 255, z: -553, label: 'Northshore Bay' },
  { x: 166, z: -615, label: 'Key channel' },
  { x: 85, z: -705, label: 'Lighthouse' },
  { x: 252, z: -745, label: 'Fort Contraband' },
  { x: 720, z: -560, label: 'North beach' },
  { x: 728, z: -200, label: 'Ocean Beach' },
  { x: 725, z: 40, label: 'Pier end' },
  { x: REGATTA_START.x, z: REGATTA_START.z, label: 'Finish' },
];

/** Medal times (s) in a Marlin, from a scripted lap's time (regatta.test.ts): gold about 5% over it, silver 25%, bronze 60%. */
export const REGATTA_TIMES = { gold: 131, silver: 155, bronze: 199 } as const;
/** Gold's payout; silver pays 70% of it and bronze 45%, as on the street runs. */
export const REGATTA_REWARD = 1500;

export const MP_NO_REGATTA = 'The Gull Regatta is single-player only.';

export function regattaMedal(seconds: number): RegattaMedal | null {
  if (seconds <= 0 || seconds > REGATTA_TIMES.bronze) return null;
  return seconds <= REGATTA_TIMES.gold ? 'gold' : seconds <= REGATTA_TIMES.silver ? 'silver' : 'bronze';
}

function nearMarina(host: ActivityHost, v: Vehicle): boolean {
  const marina = host.sim.world.layout.pois.find((p) => p.kind === 'marina')!;
  return Math.hypot(v.pos.x - marina.x, v.pos.z - marina.z) <= REGATTA_REACH;
}

function atStart(j: RegattaJob): boolean {
  return Math.hypot(j.boat.pos.x - REGATTA_START.x, j.boat.pos.z - REGATTA_START.z) <= REGATTA_START.radius && j.boat.speed <= 2.5;
}

/** Holds the boat on the start line, facing up the course. */
function holdStart(host: ActivityHost, j: RegattaJob): void {
  const b = j.boat;
  b.pos.x = REGATTA_START.x;
  b.pos.z = REGATTA_START.z;
  b.heading = REGATTA_START.heading;
  b.vel.x = b.vel.z = b.angVel = b.speed = b.forwardSpeed = b.steer = 0;
  b.controls.throttle = b.controls.brake = b.controls.steer = 0;
  host.sim.syncOccupant(host.sim.player);
  j.previousX = b.pos.x;
  j.previousZ = b.pos.z;
}

function beginCountdown(host: ActivityHost, j: RegattaJob): void {
  const sim = host.sim;
  if (sim.wanted.level > 0) {
    host.end('The start is compromised. Lose the cops and press T at the Marina to try again.');
    return;
  }
  j.stage = 'countdown';
  j.countdown = 3;
  sim.controlLock = Math.max(sim.controlLock, 3.1);
  holdStart(host, j);
  sim.events.emit('objective', { text: 'Get ready · Gull Regatta' });
  host.say('Hold W to go at GO. Every buoy gate in order.', 4);
  sim.events.emit('streetRunCountdown', { count: 3 });
}

function announceGate(host: ActivityHost, j: RegattaJob): void {
  const g = REGATTA_GATES[j.gate]!;
  host.sim.events.emit('objective', { text: `Gull Regatta · ${g.label === 'Finish' ? 'FINISH' : `Gate ${j.gate + 1}/${REGATTA_GATES.length} · ${g.label}`}` });
}

function update(host: ActivityHost, j: RegattaJob, dt: number): void {
  const sim = host.sim;
  const boat = j.boat;
  if (sim.player.vehicle !== boat || boat.driver !== sim.player || !boat.drivable || boat.removed || !sim.player.alive) {
    sim.events.emit('big', { text: 'REGATTA ENDED', sub: 'Take a boat back to the Marina to try again.', style: 'failed', duration: 3 });
    host.end('Regatta over. Bring a boat to the Marina and press T to try again.');
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
    announceGate(host, j);
    return;
  }
  j.elapsed += dt;
  if (j.elapsed > REGATTA_TIMES.bronze) {
    sim.events.emit('big', { text: 'OUT OF TIME', sub: `Gull Regatta · ${j.gate}/${REGATTA_GATES.length} gates`, style: 'failed', duration: 4 });
    host.end('Regatta over. Press T at the Marina to try again.');
    return;
  }
  const gate = REGATTA_GATES[j.gate]!;
  const dx = boat.pos.x - j.previousX;
  const dz = boat.pos.z - j.previousZ;
  const lengthSq = dx * dx + dz * dz;
  // Swept, as the street runs' gates are; a teleport skips no gate and buys no record.
  if (Math.sqrt(lengthSq) > Math.max(12, boat.spec.maxSpeed * dt * 2 + 4)) {
    host.end('Regatta interrupted. Press T at the Marina to line up again.');
    return;
  }
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((gate.x - j.previousX) * dx + (gate.z - j.previousZ) * dz) / lengthSq)) : 1;
  const hit = Math.hypot(j.previousX + dx * t - gate.x, j.previousZ + dz * t - gate.z) <= REGATTA_GATE_R;
  j.previousX = boat.pos.x;
  j.previousZ = boat.pos.z;
  if (!hit) return;
  j.gate++;
  sim.events.emit('streetRunCheckpoint', { index: j.gate, total: REGATTA_GATES.length, elapsed: j.elapsed });
  if (j.gate === REGATTA_GATES.length) {
    finish(host, j);
    return;
  }
  announceGate(host, j);
}

function finish(host: ActivityHost, j: RegattaJob): void {
  const sim = host.sim;
  const medal = regattaMedal(j.elapsed)!;
  const rec = activityRecords(sim.progress);
  const ms = Math.round(j.elapsed * 1000);
  const best = rec.regattaBest === 0 || ms < rec.regattaBest;
  if (best) rec.regattaBest = ms;
  const reward = Math.round(REGATTA_REWARD * (medal === 'gold' ? 1 : medal === 'silver' ? 0.7 : 0.45));
  sim.progress.addMoney(reward);
  // End before announcing the result: a listener cannot collect it twice.
  host.end('Press T to sail it again.');
  sim.events.emit('money', { amount: reward });
  sim.events.emit('big', { text: `${medal.toUpperCase()} FINISH`, sub: `Gull Regatta · ${formatRunTime(j.elapsed)} · ${formatMoney(reward)}${best ? ' · NEW BEST' : ''}`, style: 'passed', duration: 6 });
  sim.events.emit('activityMilestone', { kind: 'regatta', reward });
}

export const regattaActivity: ActivityDef<RegattaJob> = {
  kind: 'regatta',
  toggleEndText: 'Regatta abandoned. Press T at the Marina to try again.',
  site: { label: 'R', name: 'Regatta', at: () => REGATTA_START },
  completion: (_view, me) => ({ label: 'Gull Regatta medal', done: activityRecords(me.progress).regattaBest > 0 ? 1 : 0, total: 1 }),

  canStart: (host, slot, vehicle) => !!vehicle && vehicle.spec.class === 'boat' && vehicle.driver === slot && nearMarina(host, vehicle),

  prompt: (host, _slot, vehicle) => (vehicle && vehicle.speed < 1 && !host.sim.multiplayer && host.sim.wanted.level === 0 ? 'Press T to start the Gull Regatta' : null),

  start(host, _slot, boat) {
    const sim = host.sim;
    if (!boat) return false;
    if (sim.multiplayer) {
      host.say(MP_NO_REGATTA, 3);
      return false;
    }
    if (sim.wanted.level > 0) {
      host.say('Lose the cops before starting the regatta.', 3);
      return false;
    }
    const j: RegattaJob = { kind: 'regatta', boat, stage: 'approach', countdown: 0, elapsed: 0, gate: 0, previousX: boat.pos.x, previousZ: boat.pos.z };
    host.job = j;
    sim.events.emit('big', { text: 'GULL REGATTA', sub: `${REGATTA_GATES.length} gates · GOLD ${formatRunTime(REGATTA_TIMES.gold)} · ${formatMoney(REGATTA_REWARD)}`, style: 'title', duration: 3 });
    if (atStart(j)) beginCountdown(host, j);
    else {
      sim.events.emit('objective', { text: 'Stop in the start gate off the Marina. T cancels.' });
      host.say('Pass every buoy gate in order. T cancels.', 5);
    }
    return true;
  },

  update,

  end(host, j) {
    if (j.stage === 'countdown' && host.sim.controlLock <= j.countdown + 0.101) host.sim.controlLock = 0;
  },

  objectives(j): Objective[] {
    if (j.stage !== 'racing') return [{ x: REGATTA_START.x, z: REGATTA_START.z, label: 'Gull Regatta · Start', color: 0x50f1d1, radius: REGATTA_START.radius }];
    const g = REGATTA_GATES[j.gate]!;
    const last = j.gate === REGATTA_GATES.length - 1;
    return [{ x: g.x, z: g.z, label: last ? 'Finish' : `${j.gate + 1}/${REGATTA_GATES.length} · ${g.label}`, color: last ? 0xffd23d : 0x50f1d1, radius: REGATTA_GATE_R }];
  },

  status(j) {
    if (j.stage === 'approach') return 'GULL REGATTA · STOP IN THE START GATE';
    if (j.stage === 'countdown') return `GULL REGATTA · ${Math.ceil(j.countdown)}`;
    return `GULL REGATTA · GATE ${j.gate + 1}/${REGATTA_GATES.length} · ${formatRunTime(j.elapsed)}`;
  },
};

registerStatRow({
  id: 'regattaBest',
  label: 'Gull Regatta best',
  value: (v) => {
    const best = activityRecords(v.player.progress).regattaBest;
    return best > 0 ? `${formatRunTime(best / 1000)} (${regattaMedal(best / 1000)})` : '-';
  },
});
