import { formatMoney } from '../../core/math';
import type { Vehicle } from '../entities';
import type { Sim } from '../sim';
import { buildStreetRunCourses, formatRunTime, greenWave, runMedal, type StreetRunCourse } from '../streetRuns';
import type { ActivityDef, ActivityHost, Objective } from './types';

export interface StreetRunJob {
  kind: 'streetRun';
  car: Vehicle;
  course: StreetRunCourse;
  stage: 'approach' | 'countdown' | 'racing';
  countdown: number;
  elapsed: number;
  /** Index of the next required gate, not the last gate visited. */
  checkpoint: number;
  previousX: number;
  previousZ: number;
}

const courseCache = new WeakMap<Sim, StreetRunCourse[]>();
/** Junctions the green wave holds for the racer (see syncGreenWave), per sim. */
const greenWaveHeld = new WeakMap<Sim, number[]>();

export function streetRunCourses(sim: Sim): readonly StreetRunCourse[] {
  let courses = courseCache.get(sim);
  if (!courses) courseCache.set(sim, (courses = buildStreetRunCourses(sim.roads)));
  return courses;
}

function atStart(j: StreetRunJob): boolean {
  return Math.hypot(j.car.pos.x - j.course.start.x, j.car.pos.z - j.course.start.z) <= 8
    && Math.hypot(j.car.vel.x, j.car.vel.z) <= 2.5;
}

function beginCountdown(host: ActivityHost, j: StreetRunJob): void {
  const sim = host.sim;
  if (sim.wanted.level > 0) {
    host.end('The start is compromised. Lose the cops and press T to try again.');
    return;
  }
  j.stage = 'countdown';
  j.countdown = 3;
  sim.controlLock = Math.max(sim.controlLock, 3.1);
  holdStart(host, j);
  sim.events.emit('objective', { text: `Get ready · ${j.course.name}` });
  host.say('Hold W to launch. Space handbrakes through corners.', 4);
  sim.events.emit('streetRunCountdown', { count: 3 });
}

function holdStart(host: ActivityHost, j: StreetRunJob): void {
  const { car, course } = j;
  car.pos.x = course.start.x;
  car.pos.z = course.start.z;
  car.pos.y = host.sim.world.groundHeight(car.pos.x, car.pos.z);
  car.heading = course.start.heading;
  car.vel.x = car.vel.z = car.vy = car.angVel = car.speed = car.forwardSpeed = car.steer = 0;
  car.controls.throttle = car.controls.brake = car.controls.steer = 0;
  car.controls.handbrake = true;
  host.sim.syncOccupant(host.sim.player);
  j.previousX = car.pos.x;
  j.previousZ = car.pos.z;
}

function update(host: ActivityHost, j: StreetRunJob, dt: number): void {
  const sim = host.sim;
  const car = j.car;
  if (sim.player.vehicle !== car || car.driver !== sim.player || !car.drivable || car.removed || !sim.player.alive) {
    sim.events.emit('big', { text: 'RUN ENDED', sub: 'Bring a road car back to the start to try again.', style: 'failed', duration: 3 });
    host.end('Street run ended. Get into a road car and press T to try again.');
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
    syncGreenWave(sim, j);
    announceGate(host, j);
    return;
  }
  j.elapsed += dt;
  if (j.elapsed > j.course.bronze) {
    sim.events.emit('big', { text: 'OUT OF TIME', sub: `${j.course.name} · ${j.checkpoint}/${j.course.checkpoints.length} gates`, style: 'failed', duration: 4 });
    host.end('Run over. Press T to return to a start gate and try again.');
    return;
  }
  const gate = j.course.checkpoints[j.checkpoint]!;
  const dx = car.pos.x - j.previousX;
  const dz = car.pos.z - j.previousZ;
  const lengthSq = dx * dx + dz * dz;
  const movement = Math.sqrt(lengthSq);
  // Swept gate detection handles a fast car across variable frame times.
  // Discontinuous debug/respawn teleports cannot skip gates or buy a record.
  if (movement > Math.max(12, car.spec.maxSpeed * dt * 2 + 4)) {
    host.end('Run interrupted by a vehicle reset. Press T to line up again.');
    return;
  }
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((gate.x - j.previousX) * dx + (gate.z - j.previousZ) * dz) / lengthSq)) : 1;
  const hit = Math.hypot(j.previousX + dx * t - gate.x, j.previousZ + dz * t - gate.z) <= gate.radius && !car.airborne;
  j.previousX = car.pos.x;
  j.previousZ = car.pos.z;
  if (hit) j.checkpoint++;
  // Re-asserted every tick: another Sim built on this world meanwhile (see RoadNetwork.holdSignal) clears holds.
  syncGreenWave(sim, j);
  if (!hit) return;
  sim.events.emit('streetRunCheckpoint', { index: j.checkpoint, total: j.course.checkpoints.length, elapsed: j.elapsed });
  if (j.checkpoint === j.course.checkpoints.length) {
    finish(host, j);
    return;
  }
  announceGate(host, j);
  host.say(`CHECKPOINT ${j.checkpoint}/${j.course.checkpoints.length} · ${formatRunTime(j.elapsed)} · ${j.course.checkpoints[j.checkpoint]!.label}`, 1.5);
}

function announceGate(host: ActivityHost, j: StreetRunJob): void {
  const gate = j.course.checkpoints[j.checkpoint]!;
  host.sim.events.emit('objective', { text: `${j.course.name} · ${gate.label === 'Finish' ? 'FINISH LINE' : `Gate ${j.checkpoint + 1}/${j.course.checkpoints.length} · ${gate.label}`}` });
}

/**
 * The green wave: while racing, the next course junctions are held green along the course for the racer (cross
 * streets red, pedestrians kept off his road), moving on gate by gate. Null releases every junction it held.
 */
function syncGreenWave(sim: Sim, j: StreetRunJob | null): void {
  const roads = sim.roads;
  const held = greenWaveHeld.get(sim) ?? [];
  const want = j && j.stage === 'racing' ? greenWave(j.course, roads, j.checkpoint) : [];
  for (const id of held) if (!want.some((h) => h.nodeId === id)) roads.releaseSignal(id);
  for (const h of want) roads.holdSignal(h.nodeId, h.axis);
  greenWaveHeld.set(sim, want.map((h) => h.nodeId));
}

function finish(host: ActivityHost, j: StreetRunJob): void {
  const sim = host.sim;
  const medal = runMedal(j.course, j.elapsed);
  if (!medal || host.job !== j) return;
  const previous = sim.progress.streetRuns[j.course.id];
  const personalBest = !previous || j.elapsed < previous.bestTime;
  const reward = Math.round(j.course.reward * (medal === 'gold' ? 1 : medal === 'silver' ? 0.7 : 0.45));
  sim.progress.streetRuns[j.course.id] = {
    bestTime: personalBest ? j.elapsed : previous.bestTime,
    medal: personalBest ? medal : previous.medal,
    finishes: Math.min(1e9, (previous?.finishes ?? 0) + 1),
  };
  sim.progress.addMoney(reward);
  // End before emitting the result: a listener cannot collect it twice.
  host.end('Press T to race again. Find other runs near Ocean Drive and the docks.');
  sim.events.emit('money', { amount: reward });
  sim.events.emit('big', { text: `${medal.toUpperCase()} FINISH`, sub: `${j.course.name} · ${formatRunTime(j.elapsed)} · ${formatMoney(reward)}${personalBest ? ' · NEW BEST' : ''}`, style: 'passed', duration: 6 });
  sim.events.emit('streetRunFinished', { id: j.course.id, time: j.elapsed, medal, personalBest, reward });
}

export const streetRunActivity: ActivityDef<StreetRunJob> = {
  kind: 'streetRun',
  priority: -1,
  toggleEndText: 'Run cancelled. Press T to line up again.',

  // The job key falls back to a run in any vehicle that is not a cab or a police car; `start` explains a refusal.
  canStart: (_host, _slot, vehicle) => !!vehicle,

  prompt: (host, _slot, v) => (v && v.drivable && !v.burning && v.speed < 1 && host.sim.wanted.level === 0 ? 'Press T to start a street run' : null),

  /** Starts the course with id `courseId`, or the nearest start gate in free roam. */
  start(host, _slot, _vehicle, courseId) {
    const sim = host.sim;
    const car = sim.player.vehicle;
    if (host.job || sim.missions.active || sim.playerDown || !sim.player.alive) return false;
    if (!car || car.driver !== sim.player || !car.drivable || car.removed || car.burning || car.kind === 'taxi' || car.spec.police) {
      host.say('Street runs: get into a road car and press T. Taxis and police cars have their own jobs.', 5);
      return false;
    }
    if (sim.wanted.level > 0) {
      host.say('Lose the cops before starting a street run.', 3);
      return false;
    }
    const courses = streetRunCourses(sim);
    const course = courseId === undefined
      ? courses.reduce((best, next) => Math.hypot(next.start.x - car.pos.x, next.start.z - car.pos.z) < Math.hypot(best.start.x - car.pos.x, best.start.z - car.pos.z) ? next : best)
      : courses.find((candidate) => candidate.id === courseId);
    if (!course) return false;
    const j: StreetRunJob = { kind: 'streetRun', car, course, stage: 'approach', countdown: 0, elapsed: 0, checkpoint: 0, previousX: car.pos.x, previousZ: car.pos.z };
    host.job = j;
    sim.events.emit('big', { text: course.name.toUpperCase(), sub: `${(course.distance / 1000).toFixed(1)} km · GOLD ${formatRunTime(course.gold)} · ${formatMoney(course.reward)}`, style: 'title', duration: 3 });
    if (atStart(j)) beginCountdown(host, j);
    else {
      sim.events.emit('objective', { text: `Stop in the start gate for ${course.name}. T cancels.` });
      host.say('Follow the route to the start. Cross every gate in order. T cancels.', 5);
    }
    return true;
  },

  update,

  end(host, j) {
    syncGreenWave(host.sim, null);
    if (j.stage === 'countdown') {
      // Only release the countdown's lock; a longer mission/respawn lock owns
      // the controls independently and must survive activity cancellation.
      if (host.sim.controlLock <= j.countdown + 0.101) host.sim.controlLock = 0;
      j.car.controls.handbrake = false;
    }
  },

  objectives(j): Objective[] {
    if (j.stage !== 'racing') return [{ ...j.course.start, label: `${j.course.name} · Start`, color: 0x50f1d1, radius: 8 }];
    const gate = j.course.checkpoints[j.checkpoint];
    if (!gate) return [];
    return [{ x: gate.x, z: gate.z, label: gate.label === 'Finish' ? 'Finish line' : `${j.checkpoint + 1}/${j.course.checkpoints.length} · ${gate.label}`, color: gate.label === 'Finish' ? 0xffd23d : 0x50f1d1, radius: gate.radius }];
  },

  status(j) {
    if (j.stage === 'approach') return `${j.course.name.toUpperCase()} · STOP IN THE START GATE`;
    if (j.stage === 'countdown') return `${j.course.name.toUpperCase()} · ${Math.ceil(j.countdown)}`;
    const target = j.elapsed <= j.course.gold ? 'GOLD' : j.elapsed <= j.course.silver ? 'SILVER' : 'BRONZE';
    const targetTime = target === 'GOLD' ? j.course.gold : target === 'SILVER' ? j.course.silver : j.course.bronze;
    return `GATE ${j.checkpoint + 1}/${j.course.checkpoints.length} · ${formatRunTime(j.elapsed)} · ${target} ${formatRunTime(targetTime)}`;
  },
};
