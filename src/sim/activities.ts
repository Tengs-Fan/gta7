// Side activities: taxi fares, vigilante, rampages and stunt bonuses.

import { formatMoney } from '../core/math';
import { makeBrain } from './brains';
import type { Character, Vehicle } from './entities';
import type { Sim } from './sim';

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

type Job = TaxiJob | VigilanteJob | RampageJob;

export class Activities {
  job: Job | null = null;

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
    }
  }

  toggleJob(): void {
    const sim = this.sim;
    const v = sim.player.vehicle;
    if (this.job && this.job.kind !== 'rampage') {
      this.end(this.job.kind === 'taxi' ? 'Taxi job ended.' : 'Vigilante ended.');
      return;
    }
    if (this.job || sim.missions.active) return;
    if (!v) return;
    if (v.kind === 'taxi') this.startTaxi(v);
    else if (v.spec.police) this.startVigilante(v);
    else sim.events.emit('message', { text: 'Jobs: drive a taxi or a police car and press T.', duration: 3 });
  }

  cancelAll(reason: 'wasted' | 'busted' | 'mission'): void {
    if (this.job) this.end(reason === 'mission' ? '' : this.job.kind === 'rampage' ? 'Rampage failed.' : 'Job over.');
  }

  private say(text: string, duration = 3): void {
    if (text) this.sim.events.emit('message', { text, duration });
  }

  private end(text: string): void {
    const sim = this.sim;
    const j = this.job;
    this.job = null;
    if (!j) return;
    if (j.kind === 'taxi' && j.fare && !j.fare.removed) {
      if (j.fare.vehicle) sim.unseat(j.fare);
      this.releaseCharacter(j.fare);
    }
    if (j.kind === 'vigilante' && j.target) this.releaseVehicle(j.target);
    if (j.kind === 'rampage') {
      for (const c of sim.characters) if (c.missionTag === 'rampage') this.releaseCharacter(c);
      if (!sim.progress.rampages.includes(j.tag)) sim.pickupSys.rearmRampage(j.tag, 25);
    }
    this.say(text);
  }

  private releaseCharacter(c: Character): void {
    c.persistent = false;
    c.missionTag = '';
    c.owner = 'ped';
    if (c.state === 'inVehicle') return;
    if (c.brain) {
      c.brain.hostile = false;
      c.brain.mode = 'wander';
      c.brain.toNode = -1;
    }
  }

  private releaseVehicle(v: Vehicle): void {
    v.persistent = false;
    v.missionTag = '';
    v.owner = 'none';
    if (v.driver) {
      v.driver.persistent = false;
      v.driver.missionTag = '';
    }
  }

  // ---------------------------------------------------------------------------
  // Taxi

  private startTaxi(taxi: Vehicle): void {
    const sim = this.sim;
    this.job = { kind: 'taxi', taxi, stage: 'pickup', fare: null, destX: 0, destZ: 0, destName: '', timer: 0, fares: 0, tripDist: 0 };
    sim.events.emit('big', { text: 'TAXI DRIVER', sub: 'Pick up fares and drive them to their destination', style: 'title', duration: 3 });
    this.spawnFare();
  }

  private spawnFare(): boolean {
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
    this.say('Pick up the fare (blue marker).');
    return true;
  }

  private updateTaxi(j: TaxiJob, dt: number): void {
    const sim = this.sim;
    const v = sim.player.vehicle;
    if (v !== j.taxi || !j.taxi.drivable) {
      this.end(`Taxi job ended. Fares: ${j.fares}.`);
      return;
    }
    if (j.stage === 'pickup') {
      if (!j.fare || j.fare.removed || !j.fare.alive) {
        if (j.fare && !j.fare.removed) this.releaseCharacter(j.fare);
        j.fare = null;
        if (!this.spawnFare()) this.end('No fares around. Taxi job ended.');
        return;
      }
      const f = j.fare;
      // The fare waves you down; they walk towards the taxi when it is close.
      const d = Math.hypot(f.pos.x - v.pos.x, f.pos.z - v.pos.z);
      if (d < 9 && v.speed < 2.5) {
        const seat = v.passengers.indexOf(null);
        if (seat >= 0) sim.seat(f, v, seat + 1);
        else sim.removeCharacter(f);
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
    if (Math.hypot(j.destX - v.pos.x, j.destZ - v.pos.z) < 9 && v.speed < 2.5) {
      const pay = 15 + Math.round(j.tripDist * 0.09) + Math.round(j.timer * 2);
      sim.progress.addMoney(pay);
      sim.progress.stats.taxiFares++;
      j.fares++;
      sim.events.emit('money', { amount: pay });
      if (j.fare && !j.fare.removed) {
        if (j.fare.vehicle) sim.unseat(j.fare);
        this.placeOnSidewalk(j.fare, v);
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

  private placeOnSidewalk(c: Character, v: Vehicle): void {
    const sim = this.sim;
    const spot = sim.world.findFreeSpot(v.pos.x + Math.cos(v.heading) * (v.halfW + 0.8), v.pos.z - Math.sin(v.heading) * (v.halfW + 0.8), 0.4, 8) ?? { x: v.pos.x, z: v.pos.z };
    c.pos.x = spot.x;
    c.pos.z = spot.z;
    c.pos.y = sim.world.groundHeight(spot.x, spot.z);
    c.state = 'normal';
  }

  // ---------------------------------------------------------------------------
  // Vigilante

  private startVigilante(car: Vehicle): void {
    const sim = this.sim;
    this.job = { kind: 'vigilante', car, level: 1, target: null, timer: 120, pause: 0 };
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
    j.timer = Math.max(j.timer, 60 + j.level * 10);
    this.say(`Level ${j.level}: stop the suspect!`);
  }

  private updateVigilante(j: VigilanteJob, dt: number): void {
    const sim = this.sim;
    const v = sim.player.vehicle;
    if (v !== j.car || !j.car.drivable) {
      this.end(`Vigilante ended at level ${j.level}.`);
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
    if (!j || this.sim.playerDown) return;
    if (j.kind === 'taxi') this.updateTaxi(j, dt);
    else if (j.kind === 'vigilante') this.updateVigilante(j, dt);
    else this.updateRampage(j, dt);
  }
}
