// Side activities: taxi fares, vigilante, rampages and stunt bonuses.

import { formatMoney } from '../core/math';
import { makeBrain } from './brains';
import type { Character, Vehicle } from './entities';
import { setTimeoutLike } from './pickups';
import type { Sim } from './sim';
import { buildStreetRunCourses, formatRunTime, runMedal, type StreetRunCourse } from './streetRuns';

export interface Objective {
  x: number;
  z: number;
  label: string;
  /** Blip / marker colour. */
  color: number;
  radius: number;
  /** Follow an entity instead of a fixed point. */
  vehicle?: Vehicle | null;
  character?: Character | null;
}

interface TaxiJob {
  kind: 'taxi';
  taxi: Vehicle;
  stage: 'pickup' | 'dropoff';
  fare: Character | null;
  /** Seconds the fare has been walking to the cab, -1 while he waits (see board). */
  boarding: number;
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

interface VigilanteJob {
  kind: 'vigilante';
  car: Vehicle;
  level: number;
  target: Vehicle | null;
  /** The target's driver; tracked on its own because he leaves the car (dead or alive) before he counts as stopped. */
  suspect: Character | null;
  timer: number;
  pause: number;
}

interface RampageJob {
  kind: 'rampage';
  tag: string;
  kills: number;
  need: number;
  timer: number;
  spawnTimer: number;
  centerX: number;
  centerZ: number;
}

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

type Job = TaxiJob | VigilanteJob | RampageJob | StreetRunJob;

/** How far from a cab a fare let out looks for the sidewalk (m): across a wide avenue, at a slant. */
const CURB_SEARCH = 16;
/**
 * A cab below this (m/s) is stopped: a fare walks to it or gets out of it at his destination, and it rolling his way
 * this slowly is no danger to him (a car runs a pedestrian over from 4.5 m/s, see characterPhysics).
 */
const CAB_STOPPED = 2.5;
/** A fare walks to a cab stopped within this of him (m)... */
const BOARD_RANGE = 9;
/** ...and gives up on it once it is this far (m) or faster. */
const BOARD_GIVE_UP = 12;
/** He gets in once this close to its door (m), or after walking this long (s): a blocked path never stalls a pickup. */
const BOARD_REACH = 1;
const BOARD_MAX = 4;
/** Outside the cab's body (m), where he stands at its door. */
const DOOR_OUT = 0.6;

export class Activities {
  job: Job | null = null;
  private courses: StreetRunCourse[] | null = null;
  /**
   * Set by the game each frame: the player's last way out of a vehicle may yet be undone. FIXMYRIDE puts him back in
   * the seat its own F got him out of, and that F acts at once (see exitAtStake in game.ts), so a taxi or vigilante job
   * waits for him while the code is typed, instead of ending as he gets out.
   */
  exitUndoable = false;

  constructor(private readonly sim: Sim) {
    sim.events.on('characterKilled', (e) => {
      const j = this.job;
      if (j && j.kind === 'rampage' && e.victim.missionTag === 'rampage' && e.killer?.isPlayer) {
        j.kills++;
        if (j.kills < j.need) sim.events.emit('objective', { text: `Rampage: ${j.kills}/${j.need} gang members` });
      }
    });
  }

  get busy(): boolean {
    return this.job !== null;
  }

  /** Current objective markers for the HUD / renderer. */
  objectives(): Objective[] {
    const j = this.job;
    if (!j) return [];
    if (j.kind === 'taxi') {
      if (j.stage === 'pickup' && j.fare) return [{ x: j.fare.pos.x, z: j.fare.pos.z, label: 'Fare', color: 0x3dd9ff, radius: 4, character: j.fare }];
      if (j.stage === 'dropoff') return [{ x: j.destX, z: j.destZ, label: j.destName, color: 0xffd23d, radius: 6 }];
    }
    if (j.kind === 'vigilante' && j.target) return [{ x: j.target.pos.x, z: j.target.pos.z, label: 'Suspect', color: 0xff3b3b, radius: 3, vehicle: j.target }];
    if (j.kind === 'streetRun') {
      if (j.stage !== 'racing') return [{ ...j.course.start, label: `${j.course.name} · Start`, color: 0x50f1d1, radius: 8 }];
      const gate = j.course.checkpoints[j.checkpoint];
      if (gate) return [{ x: gate.x, z: gate.z, label: gate.label === 'Finish' ? 'Finish line' : `${j.checkpoint + 1}/${j.course.checkpoints.length} · ${gate.label}`, color: gate.label === 'Finish' ? 0xffd23d : 0x50f1d1, radius: gate.radius }];
    }
    return [];
  }

  /** HUD timer / counter text. */
  status(): string | null {
    const j = this.job;
    if (!j) return null;
    switch (j.kind) {
      case 'taxi':
        return j.stage === 'dropoff' ? `FARE TIME ${Math.ceil(j.timer)}  ·  FARES ${j.fares}` : `FARES ${j.fares}`;
      case 'vigilante':
        return `VIGILANTE LVL ${j.level}  ·  ${Math.ceil(j.timer)}`;
      case 'rampage':
        return `RAMPAGE ${j.kills}/${j.need}  ·  ${Math.ceil(j.timer)}`;
      case 'streetRun': {
        if (j.stage === 'approach') return `${j.course.name.toUpperCase()} · STOP IN THE START GATE`;
        if (j.stage === 'countdown') return `${j.course.name.toUpperCase()} · ${Math.ceil(j.countdown)}`;
        const target = j.elapsed <= j.course.gold ? 'GOLD' : j.elapsed <= j.course.silver ? 'SILVER' : 'BRONZE';
        const targetTime = target === 'GOLD' ? j.course.gold : target === 'SILVER' ? j.course.silver : j.course.bronze;
        return `GATE ${j.checkpoint + 1}/${j.course.checkpoints.length} · ${formatRunTime(j.elapsed)} · ${target} ${formatRunTime(targetTime)}`;
      }
    }
  }

  toggleJob(): void {
    const sim = this.sim;
    const v = sim.player.vehicle;
    if (this.job && this.job.kind !== 'rampage') {
      this.end(this.job.kind === 'streetRun' ? 'Run cancelled. Press T to line up again.' : this.job.kind === 'taxi' ? 'Taxi job ended.' : 'Vigilante ended.');
      return;
    }
    if (this.job || sim.missions.active) return;
    if (!v) return;
    if (v.kind === 'taxi') this.startTaxi(v);
    else if (v.spec.police) this.startVigilante(v);
    else this.startStreetRun();
  }

  cancelAll(reason: 'wasted' | 'busted' | 'mission'): void {
    const j = this.job;
    if (!j) return;
    // A mission takes over from a taxi or vigilante job quietly (its markers are used on foot, which ends those
    // anyway), but a rampage it calls off is said out loud: the markers refuse to start one during it.
    if (reason === 'mission') this.end(j.kind === 'rampage' ? 'Rampage abandoned.' : '');
    else this.end(j.kind === 'rampage' ? 'Rampage failed.' : 'Job over.');
  }

  private say(text: string, duration = 3): void {
    if (text) this.sim.events.emit('message', { text, duration });
  }

  /**
   * The job holds still for the player, out of its car by a way out that may yet be undone (exitUndoable), as long as
   * that car can take him back: it still drives, nobody else sits at its wheel, and he is in no other vehicle.
   */
  private waitsForPlayer(car: Vehicle): boolean {
    return this.exitUndoable && this.sim.player.vehicle === null && !car.removed && car.drivable && car.driver === null;
  }

  private end(text: string): void {
    const sim = this.sim;
    const j = this.job;
    this.job = null;
    if (!j) return;
    if (j.kind === 'taxi' && j.fare && !j.fare.removed) {
      const cab = j.fare.vehicle;
      if (cab) {
        // Let out on the curb, as at a drop-off: unseated where he sits he would stand inside the cab's body,
        // and the physics would shove him out into the traffic, or under the cab itself in a slide.
        sim.unseat(j.fare);
        if (j.fare.alive) this.placeOnSidewalk(j.fare, cab);
      }
      const walking = j.fare.brain?.mode === 'guard';
      this.releaseCharacter(j.fare);
      if (walking) this.walkBack(j.fare, j.waitX, j.waitZ);
    }
    if (j.kind === 'vigilante') {
      if (j.target) this.releaseVehicle(j.target);
      this.releaseSuspect(j);
    }
    if (j.kind === 'rampage') {
      for (const c of sim.characters) if (c.missionTag === 'rampage') this.releaseCharacter(c);
      if (!sim.progress.rampages.includes(j.tag)) sim.pickupSys.rearmRampage(j.tag, 25);
    }
    if (j.kind === 'streetRun' && j.stage === 'countdown') {
      // Only release the countdown's lock; a longer mission/respawn lock owns
      // the controls independently and must survive activity cancellation.
      if (sim.controlLock <= j.countdown + 0.101) sim.controlLock = 0;
      j.car.controls.handbrake = false;
    }
    sim.events.emit('activityEnded', { kind: j.kind });
    this.say(text);
  }

  private releaseCharacter(c: Character): void {
    c.persistent = false;
    c.missionTag = '';
    c.owner = 'ped';
    if (c.state === 'inVehicle') return;
    if (c.brain) {
      c.brain.hostile = false;
      // Someone running from danger (a fare out of a burning cab) keeps running.
      if (c.brain.mode !== 'flee') {
        c.brain.mode = 'wander';
        c.brain.toNode = -1;
      }
    }
  }

  /**
   * A fare let go on his way to the cab (maybe in the road): he walks back to the sidewalk spot he set off from (the
   * guard brain walks him, see board), and wanders off from there once he has had the time to get there.
   */
  private walkBack(c: Character, x: number, z: number): void {
    const b = c.brain;
    const dx = x - c.pos.x;
    const dz = z - c.pos.z;
    const d = Math.hypot(dx, dz);
    if (!b || d < 0.6) return;
    b.mode = 'guard';
    b.homeX = x + (dx / d) * 2.4;
    b.homeZ = z + (dz / d) * 2.4;
    setTimeoutLike(this.sim, d / 1.6 + 0.3, () => {
      if (c.removed || !c.alive || b.mode !== 'guard') return;
      b.mode = 'wander';
      b.toNode = -1;
    });
  }

  private releaseVehicle(v: Vehicle): void {
    v.persistent = false;
    v.missionTag = '';
    v.owner = 'none';
    if (v.ai) {
      v.ai.setPolicy('traffic');
      v.ai.target = null;
    }
  }

  /** Hands the vigilante suspect, dead or alive, back to the ambient systems so he can stream out. */
  private releaseSuspect(j: VigilanteJob): void {
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
      this.sim.peds.flee(c, this.sim.player.pos.x, this.sim.player.pos.z, this.sim.player);
    }
  }

  // ---------------------------------------------------------------------------
  // Street runs

  streetRunCourses(): readonly StreetRunCourse[] {
    return this.courses ??= buildStreetRunCourses(this.sim.roads);
  }

  /** Start the requested course, or the nearest start gate in free roam. */
  startStreetRun(courseId?: string): boolean {
    const sim = this.sim;
    const car = sim.player.vehicle;
    if (this.job || sim.missions.active || sim.playerDown || !sim.player.alive) return false;
    if (!car || car.driver !== sim.player || !car.drivable || car.removed || car.burning || car.kind === 'taxi' || car.spec.police) {
      this.say('Street runs: get into a road car and press T. Taxis and police cars have their own jobs.', 5);
      return false;
    }
    if (sim.wanted.level > 0) {
      this.say('Lose the cops before starting a street run.', 3);
      return false;
    }
    const courses = this.streetRunCourses();
    const course = courseId === undefined
      ? courses.reduce((best, next) => Math.hypot(next.start.x - car.pos.x, next.start.z - car.pos.z) < Math.hypot(best.start.x - car.pos.x, best.start.z - car.pos.z) ? next : best)
      : courses.find((candidate) => candidate.id === courseId);
    if (!course) return false;
    const j: StreetRunJob = { kind: 'streetRun', car, course, stage: 'approach', countdown: 0, elapsed: 0, checkpoint: 0, previousX: car.pos.x, previousZ: car.pos.z };
    this.job = j;
    sim.events.emit('big', { text: course.name.toUpperCase(), sub: `${(course.distance / 1000).toFixed(1)} km · GOLD ${formatRunTime(course.gold)} · ${formatMoney(course.reward)}`, style: 'title', duration: 3 });
    if (this.atStreetRunStart(j)) this.beginStreetRunCountdown(j);
    else {
      sim.events.emit('objective', { text: `Stop in the start gate for ${course.name}. T cancels.` });
      this.say('Follow the route to the start. Cross every gate in order. T cancels.', 5);
    }
    return true;
  }

  private atStreetRunStart(j: StreetRunJob): boolean {
    return Math.hypot(j.car.pos.x - j.course.start.x, j.car.pos.z - j.course.start.z) <= 8
      && Math.hypot(j.car.vel.x, j.car.vel.z) <= 2.5;
  }

  private beginStreetRunCountdown(j: StreetRunJob): void {
    if (this.sim.wanted.level > 0) {
      this.end('The start is compromised. Lose the cops and press T to try again.');
      return;
    }
    j.stage = 'countdown';
    j.countdown = 3;
    this.sim.controlLock = Math.max(this.sim.controlLock, 3.1);
    this.holdStreetRunStart(j);
    this.sim.events.emit('objective', { text: `Get ready · ${j.course.name}` });
    this.say('Hold W to launch. Space handbrakes through corners.', 4);
    this.announceStreetRunCount(3);
  }

  private holdStreetRunStart(j: StreetRunJob): void {
    const { car, course } = j;
    car.pos.x = course.start.x;
    car.pos.z = course.start.z;
    car.pos.y = this.sim.world.groundHeight(car.pos.x, car.pos.z);
    car.heading = course.start.heading;
    car.vel.x = car.vel.z = car.vy = car.angVel = car.speed = car.forwardSpeed = car.steer = 0;
    car.controls.throttle = car.controls.brake = car.controls.steer = 0;
    car.controls.handbrake = true;
    this.sim.syncOccupant(this.sim.player);
    j.previousX = car.pos.x;
    j.previousZ = car.pos.z;
  }

  private announceStreetRunCount(count: 0 | 1 | 2 | 3): void {
    this.sim.events.emit('streetRunCountdown', { count });
  }

  private updateStreetRun(j: StreetRunJob, dt: number): void {
    const sim = this.sim;
    const car = j.car;
    if (sim.player.vehicle !== car || car.driver !== sim.player || !car.drivable || car.removed || !sim.player.alive) {
      sim.events.emit('big', { text: 'RUN ENDED', sub: 'Bring a road car back to the start to try again.', style: 'failed', duration: 3 });
      this.end('Street run ended. Get into a road car and press T to try again.');
      return;
    }
    if (j.stage === 'approach') {
      if (this.atStreetRunStart(j)) this.beginStreetRunCountdown(j);
      return;
    }
    if (j.stage === 'countdown') {
      const before = Math.ceil(j.countdown);
      j.countdown = Math.max(0, j.countdown - dt);
      this.holdStreetRunStart(j);
      const count = Math.ceil(j.countdown) as 0 | 1 | 2 | 3;
      if (count !== before) this.announceStreetRunCount(count);
      if (j.countdown > 0) return;
      j.stage = 'racing';
      if (sim.controlLock <= 0.101) sim.controlLock = 0;
      car.controls.handbrake = false;
      this.streetRunObjective(j);
      return;
    }
    j.elapsed += dt;
    if (j.elapsed > j.course.bronze) {
      sim.events.emit('big', { text: 'OUT OF TIME', sub: `${j.course.name} · ${j.checkpoint}/${j.course.checkpoints.length} gates`, style: 'failed', duration: 4 });
      this.end('Run over. Press T to return to a start gate and try again.');
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
      this.end('Run interrupted by a vehicle reset. Press T to line up again.');
      return;
    }
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((gate.x - j.previousX) * dx + (gate.z - j.previousZ) * dz) / lengthSq)) : 1;
    const hit = Math.hypot(j.previousX + dx * t - gate.x, j.previousZ + dz * t - gate.z) <= gate.radius && !car.airborne;
    j.previousX = car.pos.x;
    j.previousZ = car.pos.z;
    if (!hit) return;
    j.checkpoint++;
    sim.events.emit('streetRunCheckpoint', { index: j.checkpoint, total: j.course.checkpoints.length, elapsed: j.elapsed });
    if (j.checkpoint === j.course.checkpoints.length) {
      this.finishStreetRun(j);
      return;
    }
    this.streetRunObjective(j);
    this.say(`CHECKPOINT ${j.checkpoint}/${j.course.checkpoints.length} · ${formatRunTime(j.elapsed)} · ${j.course.checkpoints[j.checkpoint]!.label}`, 1.5);
  }

  private streetRunObjective(j: StreetRunJob): void {
    const gate = j.course.checkpoints[j.checkpoint]!;
    this.sim.events.emit('objective', { text: `${j.course.name} · ${gate.label === 'Finish' ? 'FINISH LINE' : `Gate ${j.checkpoint + 1}/${j.course.checkpoints.length} · ${gate.label}`}` });
  }

  private finishStreetRun(j: StreetRunJob): void {
    const sim = this.sim;
    const medal = runMedal(j.course, j.elapsed);
    if (!medal || this.job !== j) return;
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
    this.end('Press T to race again. Find other runs near Ocean Drive and the docks.');
    sim.events.emit('money', { amount: reward });
    sim.events.emit('big', { text: `${medal.toUpperCase()} FINISH`, sub: `${j.course.name} · ${formatRunTime(j.elapsed)} · ${formatMoney(reward)}${personalBest ? ' · NEW BEST' : ''}`, style: 'passed', duration: 6 });
    sim.events.emit('streetRunFinished', { id: j.course.id, time: j.elapsed, medal, personalBest, reward });
  }

  // ---------------------------------------------------------------------------
  // Taxi

  private startTaxi(taxi: Vehicle): void {
    const sim = this.sim;
    this.job = { kind: 'taxi', taxi, stage: 'pickup', fare: null, boarding: -1, waitX: 0, waitZ: 0, destX: 0, destZ: 0, destName: '', timer: 0, fares: 0, tripDist: 0 };
    sim.events.emit('big', { text: 'TAXI DRIVER', sub: 'Pick up fares and drive them to their destination', style: 'title', duration: 3 });
    this.spawnFare();
  }

  /** Spawns the next fare; `lead` is news to tell the player first, in the same message. */
  private spawnFare(lead = ''): boolean {
    const sim = this.sim;
    const j = this.job;
    if (!j || j.kind !== 'taxi') return false;
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
    this.say(lead ? `${lead} Pick up the next fare (blue marker).` : 'Pick up the fare (blue marker).');
    return true;
  }

  private updateTaxi(j: TaxiJob, dt: number): void {
    const sim = this.sim;
    const v = sim.player.vehicle;
    if (v !== j.taxi || !j.taxi.drivable) {
      if (!this.waitsForPlayer(j.taxi)) this.end(`Taxi job ended. Fares: ${j.fares}.`);
      return;
    }
    if (j.stage === 'pickup') {
      if (!j.fare || j.fare.removed || !j.fare.alive) {
        if (j.fare && !j.fare.removed) this.releaseCharacter(j.fare);
        j.fare = null;
        if (!this.spawnFare()) this.end('No fares around. Taxi job ended.');
        return;
      }
      if (this.board(j, j.fare, v, dt)) {
        const dest = sim.world.walk.randomPointNear(sim.rng, v.pos.x, v.pos.z, 320, 900) ?? sim.world.walk.randomPointNear(sim.rng, v.pos.x, v.pos.z, 150, 1400);
        if (!dest) {
          this.end('Taxi job ended.');
          return;
        }
        j.destX = dest.x;
        j.destZ = dest.z;
        j.destName = sim.world.zoneName(dest.x, dest.z);
        j.tripDist = Math.hypot(dest.x - v.pos.x, dest.z - v.pos.z);
        j.timer = Math.round(j.tripDist / 11 + 25);
        j.stage = 'dropoff';
        this.say(`Take the fare to ${j.destName}.`);
      }
      return;
    }
    const fare = j.fare;
    if (!fare || fare.removed || !fare.alive || fare.vehicle !== j.taxi) {
      // Out of the cab (it caught fire, someone dragged them out) or dead: nobody pays this trip.
      const bailed = 'The fare bailed. No fare, no tip.';
      if (fare && !fare.removed) {
        if (fare.vehicle) sim.unseat(fare);
        this.releaseCharacter(fare);
      }
      j.fare = null;
      if (!this.spawnFare(bailed)) this.end(`${bailed} Taxi job ended. Fares: ${j.fares}.`);
      return;
    }
    j.timer -= dt;
    if (j.timer <= 0) {
      if (j.fare && !j.fare.removed) {
        if (j.fare.vehicle) sim.unseat(j.fare);
        this.placeOnSidewalk(j.fare, v);
        this.releaseCharacter(j.fare);
      }
      j.fare = null;
      this.end(`Too slow! The fare got out. Fares: ${j.fares}.`);
      return;
    }
    if (Math.hypot(j.destX - v.pos.x, j.destZ - v.pos.z) < 9 && v.speed < CAB_STOPPED) {
      const pay = 15 + Math.round(j.tripDist * 0.09) + Math.round(j.timer * 2);
      sim.progress.addMoney(pay);
      sim.progress.stats.taxiFares++;
      j.fares++;
      sim.events.emit('money', { amount: pay });
      if (j.fare && !j.fare.removed) {
        if (j.fare.vehicle) sim.unseat(j.fare);
        this.placeOnSidewalk(j.fare, v, j.destX, j.destZ);
        this.releaseCharacter(j.fare);
      }
      j.fare = null;
      if (j.fares % 5 === 0) {
        sim.progress.addMoney(500);
        sim.events.emit('money', { amount: 500 });
        sim.events.emit('big', { text: `${j.fares} FARES IN A ROW`, sub: '$500 bonus', style: 'passed', duration: 3 });
      } else {
        sim.events.emit('big', { text: 'FARE COMPLETE', sub: formatMoney(pay), style: 'info', duration: 2.5 });
      }
      if (!this.spawnFare()) this.end('Taxi job ended.');
    }
  }

  /**
   * The fare walks to the cab once it waits close by (BOARD_*), to the nearest door of a free seat, and gets in there;
   * if it pulls away first, he walks back to where he set off from. True once he is aboard (or, with no seat free,
   * gone). Someone scared (gunfire, a hit) runs or fights like anyone else, and boards once he is over it.
   */
  private board(j: TaxiJob, f: Character, v: Vehicle, dt: number): boolean {
    const sim = this.sim;
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
  private placeOnSidewalk(c: Character, v: Vehicle, towardX?: number, towardZ?: number): void {
    const sim = this.sim;
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

  // ---------------------------------------------------------------------------
  // Vigilante

  private startVigilante(car: Vehicle): void {
    const sim = this.sim;
    this.job = { kind: 'vigilante', car, level: 1, target: null, suspect: null, timer: 120, pause: 0 };
    sim.events.emit('big', { text: 'VIGILANTE', sub: 'Take out the criminal before the time runs out', style: 'title', duration: 3 });
    this.spawnSuspect();
  }

  private spawnSuspect(): void {
    const sim = this.sim;
    const j = this.job;
    if (!j || j.kind !== 'vigilante') return;
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
    this.say(`Level ${j.level}: stop the suspect!`);
  }

  private updateVigilante(j: VigilanteJob, dt: number): void {
    const sim = this.sim;
    const v = sim.player.vehicle;
    if (v !== j.car || !j.car.drivable) {
      if (!this.waitsForPlayer(j.car)) this.end(`Vigilante ended at level ${j.level}.`);
      return;
    }
    if (j.pause > 0) {
      j.pause -= dt;
      if (j.pause <= 0) this.spawnSuspect();
      return;
    }
    j.timer -= dt;
    const t = j.target;
    if (!t) {
      this.spawnSuspect();
      return;
    }
    const neutralised = t.destroyed || t.removed || !t.driver || !t.driver.alive;
    if (neutralised) {
      const reward = 250 * j.level;
      sim.progress.addMoney(reward);
      sim.progress.stats.vigilanteLevel = Math.max(sim.progress.stats.vigilanteLevel, j.level);
      sim.events.emit('money', { amount: reward });
      sim.events.emit('big', { text: 'CRIMINAL STOPPED', sub: formatMoney(reward), style: 'passed', duration: 2.5 });
      this.releaseVehicle(t);
      this.releaseSuspect(j);
      j.target = null;
      j.level++;
      j.timer += 30;
      j.pause = 2.5;
      return;
    }
    if (j.timer <= 0) {
      this.end(`Out of time. Vigilante ended at level ${j.level}.`);
      return;
    }
    if (sim.distToPlayer(t.pos.x, t.pos.z) > 480) this.end('The suspect got away.');
  }

  // ---------------------------------------------------------------------------
  // Rampage

  startRampage(tag: string): boolean {
    const sim = this.sim;
    if (this.job) return false;
    const pp = sim.playerPos();
    this.job = { kind: 'rampage', tag, kills: 0, need: 12, timer: 75, spawnTimer: 0, centerX: pp.x, centerZ: pp.z };
    sim.player.inventory.give('smg', 300);
    sim.player.inventory.current = 'smg';
    sim.events.emit('big', { text: 'RAMPAGE!', sub: 'Kill 12 gang members in 75 seconds', style: 'title', duration: 3.5 });
    return true;
  }

  private updateRampage(j: RampageJob, dt: number): void {
    const sim = this.sim;
    j.timer -= dt;
    if (j.kills >= j.need) {
      sim.progress.rampages.push(j.tag);
      sim.progress.addMoney(2000);
      sim.events.emit('money', { amount: 2000 });
      sim.events.emit('big', { text: 'RAMPAGE PASSED', sub: '$2,000', style: 'passed', duration: 4 });
      this.end('');
      return;
    }
    if (j.timer <= 0) {
      sim.events.emit('big', { text: 'RAMPAGE FAILED', sub: '', style: 'failed', duration: 3 });
      this.end('');
      return;
    }
    j.spawnTimer -= dt;
    if (j.spawnTimer > 0) return;
    j.spawnTimer = 1.2;
    const alive = sim.characters.filter((c) => c.missionTag === 'rampage' && c.alive && !c.removed).length;
    if (alive >= 7) return;
    const pp = sim.playerPos();
    const pt = sim.world.walk.randomPointNear(sim.rng, pp.x, pp.z, 22, 48);
    if (!pt || sim.world.waterDepth(pt.x, pt.z) > -0.1) return;
    const g = sim.spawnCharacter('gang', pt.x, pt.z);
    g.owner = 'mission';
    g.persistent = true;
    g.missionTag = 'rampage';
    g.cash = 25;
    const b = makeBrain('fight');
    b.hostile = true;
    b.brave = true;
    b.target = sim.player;
    b.modeTimer = 999;
    b.accuracy = 0.25;
    g.brain = b;
    if (sim.rng.chance(0.45)) {
      g.inventory.infinite = true;
      g.inventory.give('pistol', 999);
      g.inventory.current = 'pistol';
    }
  }

  // ---------------------------------------------------------------------------
  // Stunts

  onVehicleLanded(v: Vehicle): void {
    const sim = this.sim;
    if (!v.driver || !v.driver.isPlayer || v.launchRamp < 0) {
      v.launchRamp = -1;
      return;
    }
    const ramp = v.launchRamp;
    v.launchRamp = -1;
    const air = v.airTime;
    const dist = Math.hypot(v.pos.x - v.launchX, v.pos.z - v.launchZ);
    if (air < 0.8 || dist < 12 || v.destroyed) return;
    const unique = !sim.progress.stunts.includes(ramp);
    let bonus = Math.round((air * 120 + dist * 8) / 10) * 10;
    if (unique) {
      bonus *= 2;
      sim.progress.stunts.push(ramp);
    }
    sim.progress.addMoney(bonus);
    sim.progress.stats.stuntBonuses++;
    sim.progress.stats.bestStuntAir = Math.max(sim.progress.stats.bestStuntAir, air);
    sim.events.emit('money', { amount: bonus });
    sim.events.emit('stunt', { airTime: air, distance: dist, bonus, unique });
    sim.events.emit('big', { text: unique ? 'UNIQUE STUNT BONUS!' : 'STUNT BONUS', sub: `${dist.toFixed(0)} m  ·  ${air.toFixed(1)} s  ·  ${formatMoney(bonus)}`, style: 'stunt', duration: 3.5 });
  }

  update(dt: number): void {
    const j = this.job;
    if (!j || this.sim.playerDown || !(dt > 0) || !Number.isFinite(dt)) return;
    if (j.kind === 'taxi') this.updateTaxi(j, dt);
    else if (j.kind === 'vigilante') this.updateVigilante(j, dt);
    else if (j.kind === 'streetRun') this.updateStreetRun(j, dt);
    else this.updateRampage(j, dt);
  }
}
