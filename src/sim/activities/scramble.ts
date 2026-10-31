// The Gravel Gulch scramble (world/country/places.ts): two laps of Las Lomas County's dirt track against the clock, its
// ten gates in order each lap, over the whoops and the tabletops. In anything with wheels at the gate, T starts it: stop
// in the start box, a three-second countdown, then bronze, silver and gold, cash and a saved best as on the street
// runs. Single player only.

import { formatMoney } from '../../core/math';
import type { StaticWorld } from '../../world/staticWorld';
import type { Vehicle } from '../entities';
import { registerStatRow } from '../statRows';
import { formatRunTime } from '../streetRuns';
import { activityRecords } from './records';
import type { ActivityDef, ActivityHost, Objective } from './types';

declare module './types' {
  interface JobKinds {
    scramble: ScrambleJob;
  }
}

export interface ScrambleJob {
  kind: 'scramble';
  vehicle: Vehicle;
  stage: 'approach' | 'countdown' | 'racing';
  countdown: number;
  elapsed: number;
  /** The ride's gates, both laps' (scrambleGates), and the start box. */
  gates: ReadonlyArray<{ x: number; z: number }>;
  start: { x: number; z: number; heading: number };
  /** Index of the next gate to pass. */
  gate: number;
  previousX: number;
  previousZ: number;
}

export type ScrambleMedal = 'gold' | 'silver' | 'bronze';

export const SCRAMBLE_LAPS = 2;
/** A vehicle within this distance (m) of the start can start the scramble; the start box's radius; every gate's. */
export const SCRAMBLE_REACH = 45;
export const SCRAMBLE_START_R = 6;
export const SCRAMBLE_GATE_R = 8;
/**
 * Medal times (s) for the two laps, from a scripted ride on a Viper 600 (scramble.test.ts, about 130 s): gold about 5%
 * over it, silver 25%, bronze 60%.
 */
export const SCRAMBLE_TIMES = { gold: 136, silver: 162, bronze: 208 } as const;
/** Gold's payout; silver pays 70% of it and bronze 45%, as on the street runs. */
export const SCRAMBLE_REWARD = 1500;

export const MP_NO_SCRAMBLE = 'The Gravel Gulch scramble is single-player only.';

export function scrambleMedal(seconds: number): ScrambleMedal | null {
  if (seconds <= 0 || seconds > SCRAMBLE_TIMES.bronze) return null;
  return seconds <= SCRAMBLE_TIMES.gold ? 'gold' : seconds <= SCRAMBLE_TIMES.silver ? 'silver' : 'bronze';
}

/** The gates of the whole ride, both laps', each lap's last on the start line. */
export function scrambleGates(world: StaticWorld): ReadonlyArray<{ x: number; z: number }> {
  const lap = world.layout.country.places.track.gates;
  return Array.from({ length: SCRAMBLE_LAPS * lap.length }, (_, k) => lap[k % lap.length]!);
}

function atStart(j: ScrambleJob): boolean {
  return Math.hypot(j.vehicle.pos.x - j.start.x, j.vehicle.pos.z - j.start.z) <= SCRAMBLE_START_R && j.vehicle.speed <= 2.5;
}

/** Holds the vehicle in the start box, facing on round the track. */
function holdStart(host: ActivityHost, j: ScrambleJob): void {
  const v = j.vehicle;
  const s = j.start;
  v.pos.x = s.x;
  v.pos.z = s.z;
  v.pos.y = host.sim.world.groundHeight(s.x, s.z);
  v.heading = s.heading;
  v.vel.x = v.vel.z = v.vy = v.angVel = v.speed = v.forwardSpeed = v.steer = 0;
  v.controls.throttle = v.controls.brake = v.controls.steer = 0;
  v.controls.handbrake = true;
  host.sim.syncOccupant(host.sim.player);
  j.previousX = v.pos.x;
  j.previousZ = v.pos.z;
}

function beginCountdown(host: ActivityHost, j: ScrambleJob): void {
  const sim = host.sim;
  if (sim.wanted.level > 0) {
    host.end('The start is compromised. Lose the cops and press T at Gravel Gulch to try again.');
    return;
  }
  j.stage = 'countdown';
  j.countdown = 3;
  sim.controlLock = Math.max(sim.controlLock, 3.1);
  holdStart(host, j);
  sim.events.emit('objective', { text: 'Get ready · Gravel Gulch' });
  host.say('Hold W to go at GO. Two laps, every gate in order.', 4);
  sim.events.emit('streetRunCountdown', { count: 3 });
}

/** The lap the next gate is on, and its place in that lap. */
function lapGate(j: ScrambleJob): { lap: number; of: number; per: number } {
  const per = j.gates.length / SCRAMBLE_LAPS;
  return { lap: Math.floor(j.gate / per) + 1, of: (j.gate % per) + 1, per };
}

function gateLabel(j: ScrambleJob): string {
  const at = lapGate(j);
  return j.gate === j.gates.length - 1 ? 'Finish' : `Lap ${at.lap}/${SCRAMBLE_LAPS} · Gate ${at.of}/${at.per}`;
}

function announceGate(host: ActivityHost, j: ScrambleJob): void {
  host.sim.events.emit('objective', { text: `Gravel Gulch · ${gateLabel(j)}` });
}

function update(host: ActivityHost, j: ScrambleJob, dt: number): void {
  const sim = host.sim;
  const v = j.vehicle;
  if (sim.player.vehicle !== v || v.driver !== sim.player || !v.drivable || v.removed || !sim.player.alive) {
    sim.events.emit('big', { text: 'SCRAMBLE ENDED', sub: 'Ride back to the Gravel Gulch gate to try again.', style: 'failed', duration: 3 });
    host.end('Scramble over. Ride back to Gravel Gulch and press T to try again.');
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
    v.controls.handbrake = false;
    announceGate(host, j);
    return;
  }
  j.elapsed += dt;
  const gates = j.gates;
  if (j.elapsed > SCRAMBLE_TIMES.bronze) {
    sim.events.emit('big', { text: 'OUT OF TIME', sub: `Gravel Gulch · ${j.gate}/${gates.length} gates`, style: 'failed', duration: 4 });
    host.end('Scramble over. Press T at Gravel Gulch to try again.');
    return;
  }
  const gate = gates[j.gate]!;
  const dx = v.pos.x - j.previousX;
  const dz = v.pos.z - j.previousZ;
  const lengthSq = dx * dx + dz * dz;
  // Swept, as the street runs' gates are; a teleport skips no gate and buys no record.
  if (Math.sqrt(lengthSq) > Math.max(12, v.spec.maxSpeed * dt * 2 + 4)) {
    host.end('Scramble interrupted. Press T at Gravel Gulch to line up again.');
    return;
  }
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((gate.x - j.previousX) * dx + (gate.z - j.previousZ) * dz) / lengthSq)) : 1;
  const hit = Math.hypot(j.previousX + dx * t - gate.x, j.previousZ + dz * t - gate.z) <= SCRAMBLE_GATE_R;
  j.previousX = v.pos.x;
  j.previousZ = v.pos.z;
  if (!hit) return;
  j.gate++;
  sim.events.emit('streetRunCheckpoint', { index: j.gate, total: gates.length, elapsed: j.elapsed });
  if (j.gate === gates.length) {
    finish(host, j);
    return;
  }
  announceGate(host, j);
}

function finish(host: ActivityHost, j: ScrambleJob): void {
  const sim = host.sim;
  const medal = scrambleMedal(j.elapsed)!;
  const rec = activityRecords(sim.progress);
  const ms = Math.round(j.elapsed * 1000);
  const best = rec.scrambleBest === 0 || ms < rec.scrambleBest;
  if (best) rec.scrambleBest = ms;
  const reward = Math.round(SCRAMBLE_REWARD * (medal === 'gold' ? 1 : medal === 'silver' ? 0.7 : 0.45));
  sim.progress.addMoney(reward);
  // End before announcing the result: a listener cannot collect it twice.
  host.end('Press T to ride it again.');
  sim.events.emit('money', { amount: reward });
  sim.events.emit('big', { text: `${medal.toUpperCase()} FINISH`, sub: `Gravel Gulch · ${formatRunTime(j.elapsed)} · ${formatMoney(reward)}${best ? ' · NEW BEST' : ''}`, style: 'passed', duration: 6 });
  sim.events.emit('activityMilestone', { kind: 'scramble', reward });
}

function nearStart(host: ActivityHost, v: Vehicle): boolean {
  const s = host.sim.world.layout.country.places.track.start;
  return Math.hypot(v.pos.x - s.x, v.pos.z - s.z) <= SCRAMBLE_REACH;
}

export const scrambleActivity: ActivityDef<ScrambleJob> = {
  kind: 'scramble',
  toggleEndText: 'Scramble abandoned. Press T at Gravel Gulch to try again.',
  site: { label: 'D', name: 'Scramble', at: (world) => world.layout.country.places.track.start },
  completion: (_view, me) => ({ label: 'Gravel Gulch medal', done: activityRecords(me.progress).scrambleBest > 0 ? 1 : 0, total: 1 }),

  canStart: (host, slot, vehicle) => !!vehicle && vehicle.spec.class !== 'boat' && vehicle.driver === slot && nearStart(host, vehicle),

  prompt: (host, _slot, vehicle) => (vehicle && vehicle.speed < 1 && !host.sim.multiplayer && host.sim.wanted.level === 0 ? 'Press T to ride the Gravel Gulch scramble' : null),

  start(host, _slot, vehicle) {
    const sim = host.sim;
    if (!vehicle) return false;
    if (sim.multiplayer) {
      host.say(MP_NO_SCRAMBLE, 3);
      return false;
    }
    if (sim.wanted.level > 0) {
      host.say('Lose the cops before starting the scramble.', 3);
      return false;
    }
    const world = sim.world;
    const j: ScrambleJob = {
      kind: 'scramble', vehicle, stage: 'approach', countdown: 0, elapsed: 0, gates: scrambleGates(world), start: world.layout.country.places.track.start,
      gate: 0, previousX: vehicle.pos.x, previousZ: vehicle.pos.z,
    };
    host.job = j;
    sim.events.emit('big', { text: 'GRAVEL GULCH SCRAMBLE', sub: `${SCRAMBLE_LAPS} laps · GOLD ${formatRunTime(SCRAMBLE_TIMES.gold)} · ${formatMoney(SCRAMBLE_REWARD)}`, style: 'title', duration: 3 });
    if (atStart(j)) beginCountdown(host, j);
    else {
      sim.events.emit('objective', { text: 'Stop in the start box at the Gravel Gulch gate. T cancels.' });
      host.say('Two laps, every flag gate in order. T cancels.', 5);
    }
    return true;
  },

  update,

  end(host, j) {
    if (j.stage === 'countdown') {
      if (host.sim.controlLock <= j.countdown + 0.101) host.sim.controlLock = 0;
      j.vehicle.controls.handbrake = false;
    }
  },

  objectives(j): Objective[] {
    if (j.stage !== 'racing') return [{ x: j.start.x, z: j.start.z, label: 'Gravel Gulch · Start', color: 0x50f1d1, radius: SCRAMBLE_START_R }];
    const g = j.gates[j.gate]!;
    const last = j.gate === j.gates.length - 1;
    return [{ x: g.x, z: g.z, label: gateLabel(j), color: last ? 0xffd23d : 0x50f1d1, radius: SCRAMBLE_GATE_R }];
  },

  status(j) {
    if (j.stage === 'approach') return 'GRAVEL GULCH · STOP IN THE START BOX';
    if (j.stage === 'countdown') return `GRAVEL GULCH · ${Math.ceil(j.countdown)}`;
    const at = lapGate(j);
    return `GRAVEL GULCH · LAP ${at.lap}/${SCRAMBLE_LAPS} · GATE ${at.of}/${at.per} · ${formatRunTime(j.elapsed)}`;
  },
};

registerStatRow({
  id: 'scrambleBest',
  label: 'Gravel Gulch best',
  value: (v) => {
    const best = activityRecords(v.player.progress).scrambleBest;
    return best > 0 ? `${formatRunTime(best / 1000)} (${scrambleMedal(best / 1000)})` : '-';
  },
});
