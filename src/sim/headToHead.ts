// A head-to-head Street Run for several players of one Sim (multiplayer): the entrants line up on a grid behind the
// course's start, one shared countdown locks everyone until the same tick, and each racer's gates are credited in order
// (swept, as the single-player run does). Finish order is by the tick each racer crossed the line; nobody finishing
// within the course's bronze time ends the race "out of time" for everyone still on the course. Pure sim code: the
// server's room drives it once per tick and turns its state into messages.

import type { Vehicle } from './entities';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import { formatRunTime, greenWave, runMedal, type StreetRunCourse, type StreetRunMedal } from './streetRuns';

/** Seconds from the start of the countdown to GO. */
export const RACE_COUNTDOWN = 3;
/** Seconds the results stay up before the race is over for good. */
export const RACE_RESULTS_TIME = 12;
/** Metres between two grid rows. */
const ROW_GAP = 7;
/** Where the front row stands along the start lane (the start gate itself is 12 m along it). */
const FRONT_ROW = 12;

export type RaceStage = 'lobby' | 'countdown' | 'racing' | 'results';
/** 'timeout': still on the course when the course's time ran out. */
export type RacerStatus = 'waiting' | 'racing' | 'finished' | 'dnf' | 'timeout';

export interface Racer {
  readonly slot: PlayerSlot;
  /** The car the race gave him (null before the countdown). */
  car: Vehicle | null;
  /** Index of the next gate to cross. */
  gate: number;
  prevX: number;
  prevZ: number;
  status: RacerStatus;
  /** Server tick he crossed the finish line. */
  finishTick: number | null;
  /** Seconds from GO to the line. */
  time: number | null;
  medal: StreetRunMedal | null;
  /** Why he did not finish ('left', 'wasted', 'busted', 'wrecked', 'quit'). */
  reason: string;
  /** Grid position, from 0 (join order). */
  grid: number;
}

export interface RaceResult {
  slotId: number;
  /** 1-based for finishers, 0 for everyone else. */
  position: number;
  status: RacerStatus;
  time: number | null;
  finishTick: number | null;
  medal: StreetRunMedal | null;
  gates: number;
  reason: string;
}

export class HeadToHead {
  stage: RaceStage = 'lobby';
  readonly racers: Racer[] = [];
  /** Tick the countdown began, GO, and the end of the race (results), once known. */
  countdownTick = -1;
  goTick = -1;
  endTick = -1;
  /** The results stage is over: the race can be dropped. */
  done = false;
  private held: number[] = [];

  constructor(readonly sim: Sim, readonly course: StreetRunCourse, readonly tickRate = 60) {}

  racer(slot: PlayerSlot | number): Racer | undefined {
    const id = typeof slot === 'number' ? slot : slot.id;
    return this.racers.find((r) => r.slot.id === id);
  }

  /** Enters a player while the race is still open. Returns why not, or null. */
  join(slot: PlayerSlot): string | null {
    if (this.stage !== 'lobby') return 'That race has already started.';
    if (this.racer(slot)) return null;
    if (slot.down) return 'You are in no state to race.';
    if (slot.wanted.level > 0) return 'Lose the cops before joining a race.';
    this.racers.push({ slot, car: null, gate: 0, prevX: 0, prevZ: 0, status: 'waiting', finishTick: null, time: null, medal: null, reason: '', grid: this.racers.length });
    return null;
  }

  /** A player leaves: out of the entrants before the start, DNF once it has begun. */
  leave(slot: PlayerSlot | number, reason = 'left'): void {
    const r = this.racer(slot);
    if (!r) return;
    if (this.stage === 'lobby') {
      this.racers.splice(this.racers.indexOf(r), 1);
      this.racers.forEach((x, i) => (x.grid = i));
      return;
    }
    if (r.status === 'racing' || r.status === 'waiting') this.out(r, reason);
  }

  /** Where grid position `i` stands: lane by lane across the start road, rows back along it. */
  gridSpot(i: number): { x: number; z: number; heading: number } {
    const roads = this.sim.roads;
    const lanes = roads.lanesBetween(this.course.nodes[0]!, this.course.nodes[1]!);
    const n = Math.max(1, lanes.length);
    const lane = lanes[i % n] ?? lanes[0]!;
    const along = FRONT_ROW - ROW_GAP * Math.floor(i / n);
    // The rows behind the front one run back towards the junction box; past it they line up ahead instead.
    const at = along >= 4 ? along : FRONT_ROW + ROW_GAP * (Math.floor(i / n) - 1);
    return { x: lane.sx + lane.dx * at, z: lane.sz + lane.dz * at, heading: lane.heading };
  }

  /** Closes the entries and starts the countdown at `tick`: every entrant gets a car on the grid, held still. */
  begin(tick: number, colorOf: (slot: PlayerSlot) => number | undefined = () => undefined): void {
    if (this.stage !== 'lobby') return;
    const sim = this.sim;
    this.stage = 'countdown';
    this.countdownTick = tick;
    this.goTick = tick + Math.round(RACE_COUNTDOWN * this.tickRate);
    for (const r of [...this.racers]) {
      if (!this.present(r) || r.slot.down) {
        this.out(r, 'not ready');
        continue;
      }
      sim.activities.cancelAll('mission', r.slot);
      const c = r.slot.character;
      if (c.vehicle) sim.unseat(c);
      c.state = 'normal';
      const at = this.gridSpot(r.grid);
      const car = sim.spawnVehicle('sports', at.x, at.z, at.heading, colorOf(r.slot));
      car.usedByPlayer = true;
      sim.seat(c, car, 0);
      c.heading = at.heading;
      r.car = car;
      r.status = 'racing';
      r.prevX = car.pos.x;
      r.prevZ = car.pos.z;
      this.pin(r);
      this.emit('streetRunCountdown', { count: RACE_COUNTDOWN }, r.slot);
      this.emit('objective', { text: `Get ready · ${this.course.name}` }, r.slot);
    }
    this.flagRacers();
  }

  /** One tick, after the sim's update; `tick` is the room tick that update made. */
  update(tick: number): void {
    if (this.stage === 'lobby' || this.done) return;
    if (this.stage === 'results') {
      if (tick - this.endTick >= RACE_RESULTS_TIME * this.tickRate) this.done = true;
      return;
    }
    this.flagRacers();
    for (const r of this.racers) {
      if (r.status === 'racing') this.check(r);
      // A leaver's race car would stand on the grid, which is also the finish: once nobody sits in it, it goes.
      else if (r.status === 'dnf' && r.car && !r.car.removed && r.car.occupants().length === 0) this.sim.removeVehicle(r.car);
    }
    if (this.stage === 'countdown') {
      const left = this.goTick - tick;
      for (const r of this.racers) {
        if (r.status !== 'racing') continue;
        this.pin(r);
        r.slot.controlLock = Math.max(r.slot.controlLock, left / this.tickRate + 0.1);
      }
      if (left > 0) {
        if (left % this.tickRate === 0) for (const r of this.live()) this.emit('streetRunCountdown', { count: left / this.tickRate }, r.slot);
        return;
      }
      this.stage = 'racing';
      for (const r of this.live()) {
        if (r.slot.controlLock <= 0.101 + 1 / this.tickRate) r.slot.controlLock = 0;
        if (r.car) r.car.controls.handbrake = false;
        this.emit('streetRunCountdown', { count: 0 }, r.slot);
        this.announce(r);
      }
      this.syncGreenWave();
      return;
    }
    const elapsed = (tick - this.goTick) / this.tickRate;
    for (const r of this.live()) this.advance(r, tick);
    if (elapsed > this.course.bronze) {
      for (const r of this.live()) {
        r.status = 'timeout';
        this.emit('big', { text: 'OUT OF TIME', sub: `${this.course.name} · ${r.gate}/${this.course.checkpoints.length} gates`, style: 'failed', duration: 4 }, r.slot);
      }
    }
    if (this.live().length === 0) this.finishRace(tick);
    else this.syncGreenWave();
  }

  /** Ends everything now (the room closing or the race abandoned): signals released. */
  release(): void {
    for (const r of this.racers) r.slot.racing = false;
    this.held.forEach((id) => this.sim.roads.releaseSignal(id));
    this.held = [];
  }

  /** Ordered results: finishers by their finish tick, then those out of time by gates, then the rest. */
  results(): RaceResult[] {
    const rank = (r: Racer) => (r.status === 'finished' ? 0 : r.status === 'timeout' || r.status === 'racing' ? 1 : 2);
    const sorted = [...this.racers].sort((a, b) => rank(a) - rank(b)
      || (a.status === 'finished' && b.status === 'finished' ? a.finishTick! - b.finishTick! : 0)
      || b.gate - a.gate
      || a.grid - b.grid);
    let pos = 0;
    return sorted.map((r) => ({
      slotId: r.slot.id,
      position: r.status === 'finished' ? ++pos : 0,
      status: r.status,
      time: r.time,
      finishTick: r.finishTick,
      medal: r.medal,
      gates: r.gate,
      reason: r.reason,
    }));
  }

  /** Where a racer stands in the running order now (1-based), by gates and the distance to the next one. */
  place(slot: PlayerSlot | number): number {
    const me = this.racer(slot);
    if (!me) return 0;
    const score = (r: Racer) => {
      if (r.status === 'finished') return 1e9 - (r.finishTick ?? 0);
      const g = this.course.checkpoints[r.gate];
      const d = g && r.car ? Math.hypot(r.car.pos.x - g.x, r.car.pos.z - g.z) : 0;
      return r.gate * 10000 - d;
    };
    const s = score(me);
    return 1 + this.racers.filter((r) => r !== me && (r.status === 'racing' || r.status === 'finished') && score(r) > s).length;
  }

  /** The status line and markers a racer's HUD shows (null for a player not in the race). */
  hud(slot: PlayerSlot, tick: number): { status: string; objectives: Array<{ x: number; z: number; label: string; color: number; radius: number }> } | null {
    const r = this.racer(slot);
    if (!r) return null;
    const c = this.course;
    const name = c.name.toUpperCase();
    const start = { x: c.start.x, z: c.start.z, label: `${c.name} · Start`, color: 0x50f1d1, radius: 8 };
    if (this.stage === 'lobby') return { status: `${name} · HEAD-TO-HEAD · ${this.racers.length} IN`, objectives: [start] };
    if (this.stage === 'countdown') return { status: `${name} · ${Math.max(1, Math.ceil((this.goTick - tick) / this.tickRate))}`, objectives: [] };
    if (this.stage === 'results' || r.status !== 'racing') {
      const res = this.results().find((x) => x.slotId === slot.id)!;
      const what = res.status === 'finished' ? `FINISHED P${res.position} · ${formatRunTime(res.time ?? 0)}` : res.status === 'timeout' ? 'OUT OF TIME' : 'DNF';
      return { status: `${name} · ${what}`, objectives: [] };
    }
    const gate = c.checkpoints[r.gate]!;
    const elapsed = Math.max(0, (tick - this.goTick) / this.tickRate);
    const racing = this.racers.filter((x) => x.status === 'racing' || x.status === 'finished').length;
    return {
      status: `GATE ${r.gate + 1}/${c.checkpoints.length} · ${formatRunTime(elapsed)} · P${this.place(slot)}/${racing}`,
      objectives: [{ x: gate.x, z: gate.z, label: gate.label === 'Finish' ? 'Finish line' : `${r.gate + 1}/${c.checkpoints.length} · ${gate.label}`, color: gate.label === 'Finish' ? 0xffd23d : 0x50f1d1, radius: gate.radius }],
    };
  }

  // ---------------------------------------------------------------------------

  private flagRacers(): void {
    for (const r of this.racers) r.slot.racing = r.status === 'racing';
  }

  private live(): Racer[] {
    return this.racers.filter((r) => r.status === 'racing');
  }

  private present(r: Racer): boolean {
    return this.sim.players.includes(r.slot) && !r.slot.parked;
  }

  /** DNF checks: gone from the room, down, or the race car wrecked. */
  private check(r: Racer): void {
    if (!this.present(r)) this.out(r, 'left');
    else if (r.slot.deathKind) this.out(r, r.slot.deathKind);
    else if (!r.car || r.car.removed || r.car.destroyed || !r.car.drivable) this.out(r, 'wrecked');
  }

  private out(r: Racer, reason: string): void {
    r.status = 'dnf';
    r.reason = reason;
    r.slot.racing = false;

    if (this.stage === 'countdown' && this.present(r) && r.slot.controlLock <= RACE_COUNTDOWN + 0.2) r.slot.controlLock = 0;
    if (this.present(r)) this.emit('objective', { text: '' }, r.slot);
  }

  /** Holds a car on its grid spot through the countdown (as the single-player run holds its start). */
  private pin(r: Racer): void {
    const car = r.car;
    if (!car) return;
    const at = this.gridSpot(r.grid);
    car.pos.x = at.x;
    car.pos.z = at.z;
    car.pos.y = this.sim.world.groundHeight(at.x, at.z);
    car.heading = at.heading;
    car.vel.x = car.vel.z = car.vy = car.angVel = car.speed = car.forwardSpeed = car.steer = 0;
    car.controls.throttle = car.controls.brake = car.controls.steer = 0;
    car.controls.handbrake = true;
    if (car.driver) this.sim.syncOccupant(car.driver);
    r.prevX = car.pos.x;
    r.prevZ = car.pos.z;
  }

  /** Credits the next gate if the racer's car swept through it since the last tick (only while he drives it). */
  private advance(r: Racer, tick: number): void {
    const car = r.car!;
    const gate = this.course.checkpoints[r.gate]!;
    const dx = car.pos.x - r.prevX;
    const dz = car.pos.z - r.prevZ;
    r.prevX = car.pos.x;
    r.prevZ = car.pos.z;
    if (car.driver !== r.slot.character) return;
    const len2 = dx * dx + dz * dz;
    // A jump far beyond what the car can drive in a tick (a reset, a teleport) credits nothing.
    if (Math.sqrt(len2) > Math.max(12, car.spec.maxSpeed / this.tickRate * 2 + 4)) return;
    const px = car.pos.x - dx;
    const pz = car.pos.z - dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((gate.x - px) * dx + (gate.z - pz) * dz) / len2)) : 1;
    const hit = Math.hypot(px + dx * t - gate.x, pz + dz * t - gate.z) <= gate.radius && !car.airborne;
    if (!hit) return;
    r.gate++;
    const total = this.course.checkpoints.length;
    const elapsed = (tick - this.goTick) / this.tickRate;
    this.emit('streetRunCheckpoint', { index: r.gate, total, elapsed }, r.slot);
    if (r.gate < total) {
      this.announce(r);
      return;
    }
    r.status = 'finished';
    r.finishTick = tick;
    r.time = elapsed;
    r.medal = runMedal(this.course, elapsed);
    const place = this.racers.filter((x) => x.status === 'finished').length;
    this.emit('objective', { text: '' }, r.slot);
    this.emit('big', { text: `P${place} FINISH`, sub: `${this.course.name} · ${formatRunTime(elapsed)}${r.medal ? ` · ${r.medal.toUpperCase()}` : ''}`, style: 'passed', duration: 5 }, r.slot);
  }

  private announce(r: Racer): void {
    const gate = this.course.checkpoints[r.gate];
    if (!gate) return;
    const total = this.course.checkpoints.length;
    this.emit('objective', { text: `${this.course.name} · ${gate.label === 'Finish' ? 'FINISH LINE' : `Gate ${r.gate + 1}/${total} · ${gate.label}`}` }, r.slot);
  }

  private finishRace(tick: number): void {
    this.stage = 'results';
    this.endTick = tick;
    this.release();
  }

  /** The green wave for every racer still on the course: the next junctions ahead of each held green. */
  private syncGreenWave(): void {
    const roads = this.sim.roads;
    const want = new Map<number, 'NS' | 'EW'>();
    if (this.stage === 'racing') for (const r of this.live()) for (const h of greenWave(this.course, roads, r.gate)) if (!want.has(h.nodeId)) want.set(h.nodeId, h.axis);
    for (const id of this.held) if (!want.has(id)) roads.releaseSignal(id);
    for (const [id, axis] of want) roads.holdSignal(id, axis);
    this.held = [...want.keys()];
  }

  private emit(type: string, payload: Record<string, unknown>, slot: PlayerSlot): void {
    (this.sim.events.emit as (t: string, p: unknown) => void)(type, { ...payload, ...slot.tag });
  }
}
