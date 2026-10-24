// Angry drivers: a civilian driver whose car the player rams hard may get out once it has stopped, and either come at
// him with his fists or run for it. A fighter who sees the player drive off more than GIVE_UP m goes back to his car and
// drives on (or walks off); his car meanwhile stands abandoned for the traffic detour and tow logic like any other.
// Runs only while sim.streetCrime.angryDrivers is on, from its own random generator.

import { Rng } from '../core/rng';
import { makeBrain } from './brains';
import { DriverAI } from './driver';
import type { Character, Vehicle } from './entities';
import type { Sim } from './sim';
import type { SimSystem } from './systems';
import { mpBudget, playerClusters } from './traffic';

/** A hit that jolts the car by this much (m/s) is a hard one; below GENTLE nobody gets out. */
export const HARD_HIT = 3.2;
/** Chance a hard hit brings the driver out, and that one who gets out fights rather than runs. */
export const GET_OUT_CHANCE = 0.6;
export const FIGHT_CHANCE = 0.45;
/** He gets out once his car is (nearly) stopped, or after this long (s) at most. */
const GET_OUT_WAIT = 3;
/** A fighter gives up once the player is this far (m) away. */
export const GIVE_UP = 40;
/** He walks back to his car from at most this far (m); further, he walks off. */
const BACK_TO_CAR = 30;
/** Held up on the way (the car in the way of its own door), he gets in after this long (s) all the same. */
const BACK_TIMEOUT = 12;

interface Grievance {
  driver: Character;
  car: Vehicle;
  /** The player who rammed him. */
  by: Character;
  /** Decided at the hit: what he does once out. */
  fights: boolean;
  hitAt: number;
  state: 'waiting' | 'fighting' | 'fleeing' | 'returning' | 'done';
  /** Telemetry: when he got out and how it ended. */
  outAt: number;
  /** When he set off back to his car. */
  backSince: number;
  end: 'drove' | 'walked' | 'none';
}

export class AngryDriverSystem implements SimSystem {
  readonly id = 'angryDrivers';
  // After the pedestrian AI and before physics, so the walk back to his car is what moves him this frame.
  readonly slot = 'afterTraffic' as const;
  readonly active: Grievance[] = [];
  /** Every hard hit on a civilian driver's car while on, and what came of it (tests and telemetry). */
  readonly log: Array<{ at: number; deltaV: number; car: number; out: boolean; fights: boolean; grievance: Grievance | null }> = [];
  private readonly rng: Rng;
  /** When each car was last hit hard enough to count: one collision is one hit, however many contacts it takes. */
  private readonly lastHit = new WeakMap<Vehicle, number>();

  constructor(private readonly sim: Sim) {
    this.rng = new Rng(((sim.seed * 2654435789) ^ 0x616e6772) >>> 0);
    sim.events.on('vehicleRammed', (e) => {
      if (!sim.streetCrime.angryDrivers) return;
      this.onRammed(e.vehicle, e.deltaV, e.by);
    });
  }

  reset(): void {
    this.active.length = 0;
  }

  private eligible(v: Vehicle): Character | null {
    const d = v.driver;
    if (!d || d.isPlayer || d.isLaw || d.role !== 'civilian' || !d.alive) return null;
    // Only everyday traffic: never the police, a mission's cars or a bus.
    if (v.owner !== 'traffic' || v.persistent || v.missionTag !== '' || v.kind === 'bus' || v.spec.police) return null;
    return d;
  }

  private racing(by: Character): boolean {
    const slot = this.sim.slotOf(by);
    if (!slot) return false;
    if (slot.racing) return true;
    const job = this.sim.activities.jobOf(slot);
    return job?.kind === 'streetRun' && job.stage !== 'approach';
  }

  private onRammed(v: Vehicle, deltaV: number, by: Character): void {
    const sim = this.sim;
    if (deltaV < HARD_HIT) return;
    const d = this.eligible(v);
    if (!d || this.active.some((g) => g.driver === d)) return;
    // A racer's bump is part of the race: nobody gets out to fight him mid-course, where he would hold up the run.
    if (this.racing(by)) return;
    const last = this.lastHit.get(v);
    if (last !== undefined && sim.time - last < 2) return;
    this.lastHit.set(v, sim.time);
    // Draws in a fixed order whatever comes of them, so one outcome does not shift the next.
    const out = this.rng.chance(GET_OUT_CHANCE);
    const fights = this.rng.chance(FIGHT_CHANCE);
    let grievance: Grievance | null = null;
    if (out) {
      grievance = { driver: d, car: v, by, fights, hitAt: sim.time, state: 'waiting', outAt: -1, backSince: -1, end: 'none' };
      this.active.push(grievance);
    }
    this.log.push({ at: sim.time, deltaV, car: v.id, out, fights, grievance });
  }

  /**
   * The player `by` left the world (multiplayer): whoever he rammed lets it go. One still in his car drives on, one
   * fighting him heads back to his car; nobody else takes his place as the target (slot 0 goes to the next player).
   */
  forget(by: Character): void {
    for (const g of this.active) if (g.by === by) this.letGo(g);
    for (let i = this.active.length - 1; i >= 0; i--) if (this.active[i]!.state === 'done') this.active.splice(i, 1);
  }

  private letGo(g: Grievance): void {
    const c = g.driver;
    if (g.state === 'waiting') {
      g.state = 'done';
    } else if (g.state === 'fighting') {
      g.backSince = this.sim.time;
      if (c.brain && c.brain.mode === 'fight') {
        c.brain.mode = 'idle';
        c.brain.target = null;
        c.brain.modeTimer = 0.5;
      }
      g.state = 'returning';
    }
  }

  update(sim: Sim, _dt: number): void {
    const multi = sim.players.length > 1;
    for (const g of this.active) {
      // The player who rammed him (slot 0 in single player); gone from the world, the grievance goes with him.
      const found = multi ? sim.slotOf(g.by) : sim.players[0]!;
      if (!found || found.parked) this.letGo(g);
      const slot = found ?? sim.players[0]!;
      const p = slot.character;
      const pp = slot.pos();
      const c = g.driver;
      if (c.removed || !c.alive) {
        g.state = 'done';
        continue;
      }
      switch (g.state) {
        case 'waiting': {
          if (c.vehicle !== g.car || g.car.removed || g.car.destroyed) {
            g.state = 'done';
            break;
          }
          if (g.car.speed > 1.5 && sim.time - g.hitAt < GET_OUT_WAIT) break;
          this.getOut(c, g.car);
          g.outAt = sim.time;
          if (g.fights) {
            const b = c.brain!;
            b.brave = true;
            b.angryCar = g.car;
            sim.peds.fight(c, p);
            g.state = 'fighting';
          } else {
            sim.peds.flee(c, pp.x, pp.z, p);
            g.state = 'fleeing';
          }
          break;
        }
        case 'fighting': {
          const far = Math.hypot(pp.x - c.pos.x, pp.z - c.pos.z) > GIVE_UP;
          const over = c.brain?.mode !== 'fight';
          if (far || over || slot.down) {
            g.backSince = sim.time;
            if (c.brain && c.brain.mode === 'fight') {
              c.brain.mode = 'idle';
              c.brain.target = null;
              c.brain.modeTimer = 0.5;
            }
            g.state = 'returning';
          }
          break;
        }
        case 'returning':
          this.walkBack(g);
          break;
        case 'fleeing':
          if (c.brain?.mode !== 'flee') {
            g.end = 'walked';
            g.state = 'done';
          }
          break;
      }
    }
    for (let i = this.active.length - 1; i >= 0; i--) if (this.active[i]!.state === 'done') this.active.splice(i, 1);
  }

  /** Out of the driver's door onto the road beside it, on his feet, a pedestrian now. */
  private getOut(c: Character, v: Vehicle): void {
    const sim = this.sim;
    sim.unseat(c);
    const sx = Math.cos(v.heading);
    const sz = -Math.sin(v.heading);
    const spot = sim.world.findFreeSpot(v.pos.x + sx * (v.halfW + 0.7), v.pos.z + sz * (v.halfW + 0.7), 0.4, 5) ?? { x: v.pos.x + sx * 2, z: v.pos.z + sz * 2 };
    c.pos.x = spot.x;
    c.pos.z = spot.z;
    c.pos.y = sim.world.groundHeight(spot.x, spot.z);
    c.state = 'normal';
    c.heading = v.heading;
    c.owner = 'ped';
    if (!c.brain) {
      c.brain = makeBrain('wander');
      c.brain.speedMul = 1;
    }
    c.brain.toNode = sim.world.walk.nearestNode(c.pos.x, c.pos.z);
    c.brain.fromNode = c.brain.toNode;
  }

  /** Back to his car and on his way in it, if it is still there for him; else he walks off. */
  private walkBack(g: Grievance): void {
    const sim = this.sim;
    const c = g.driver;
    const v = g.car;
    const ok = !v.removed && !v.destroyed && v.drivable && !v.driver && !v.inWater && v.occupants().length === 0;
    // To the driver's door (the car's left), where he got out.
    const doorX = v.pos.x + Math.cos(v.heading) * (v.halfW + 0.6);
    const doorZ = v.pos.z - Math.sin(v.heading) * (v.halfW + 0.6);
    const dx = doorX - c.pos.x;
    const dz = doorZ - c.pos.z;
    const d = Math.hypot(dx, dz);
    if (!ok || Math.hypot(v.pos.x - c.pos.x, v.pos.z - c.pos.z) > BACK_TO_CAR || c.state !== 'normal' || (c.brain && c.brain.mode !== 'idle' && c.brain.mode !== 'wander')) {
      if (c.brain?.angryCar) c.brain.angryCar = null;
      g.end = 'walked';
      g.state = 'done';
      return;
    }
    if (d > 0.9 && sim.time - g.backSince < BACK_TIMEOUT) {
      c.brain!.mode = 'idle';
      c.brain!.modeTimer = 1;
      c.moveX = dx / d;
      c.moveZ = dz / d;
      c.moveSpeed = 1.8;
      c.heading = Math.atan2(dx, dz);
      return;
    }
    // The city's traffic made up for his car while it stood: at its number he leaves it there (for the tow) and walks off.
    let traffic = 0;
    for (const o of sim.vehicles) if (!o.removed && o.owner === 'traffic' && o.driver && !o.driver.isPlayer && !o.destroyed) traffic++;
    if (traffic >= (sim.players.length > 1 ? Math.round(sim.traffic.targetCount * mpBudget(playerClusters(sim.activePlayers()).length)) : sim.traffic.targetCount)) {
      if (c.brain) {
        c.brain.angryCar = null;
        c.brain.mode = 'wander';
      }
      g.end = 'walked';
      g.state = 'done';
      return;
    }
    sim.seat(c, v, 0);
    c.owner = 'traffic';
    if (c.brain) c.brain.angryCar = null;
    v.owner = 'traffic';
    v.controls.handbrake = false;
    v.ai = new DriverAI(sim, v, 'traffic');
    g.end = 'drove';
    g.state = 'done';
  }
}
