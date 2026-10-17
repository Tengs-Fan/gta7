// Turns PlayerInput into player character / vehicle behaviour.

import { circleVsObb, makeContact } from '../core/collision';
import { clamp, moveAngleTowards } from '../core/math';
import type { Character, Vehicle } from './entities';
import type { PlayerInput } from './input';
import type { Sim } from './sim';
import { WEAPON_ORDER } from './specs';
import { vehicleObb } from './vehiclePhysics';

const contact = makeContact();
const obb = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };

export class PlayerController {
  private exitPending = false;
  private jacked = false;
  /** Door distance beyond which entering is given up (the vehicle drove off). */
  private enterReach = 7;
  private lastX = 0;
  private lastZ = 0;
  /** Last vehicle the player entered (for mission checks). */
  lastVehicle: Vehicle | null = null;
  /** Keyboard steering wheel position before the high-speed authority cut (see steerFor). */
  private steerKb = 0;
  private steerCar: Vehicle | null = null;
  private steerFrame = -1;

  constructor(private readonly sim: Sim) {
    this.lastX = sim.player.pos.x;
    this.lastZ = sim.player.pos.z;
  }

  update(dt: number, input: PlayerInput): void {
    const sim = this.sim;
    const p = sim.player;
    p.aiming = false;
    p.moveSpeed = 0;
    this.trackDistance();
    // Dying or being busted mid-entry must release the car's AI hold.
    if (p.enterTarget && (sim.playerDown || p.state !== 'entering')) this.abortEnter();
    if (sim.playerDown || !p.alive) {
      if (p.vehicle) this.neutralVehicle(p.vehicle);
      return;
    }
    if (sim.controlLock > 0) {
      if (p.vehicle) {
        const c = p.vehicle.controls;
        c.throttle = 0;
        c.steer = 0;
        c.brake = 0;
        c.handbrake = true;
      }
      return;
    }
    switch (p.state) {
      case 'normal':
      case 'swimming':
        this.onFoot(dt, input);
        break;
      case 'entering':
        this.entering(dt);
        break;
      case 'inVehicle':
        this.driving(dt, input);
        break;
      default:
        break;
    }
    if (input.interact && p.state !== 'entering') sim.interactions.interact();
    if (input.job) sim.activities.toggleJob();
  }

  private trackDistance(): void {
    const sim = this.sim;
    const p = sim.player;
    const pos = sim.playerPos();
    const d = Math.hypot(pos.x - this.lastX, pos.z - this.lastZ);
    if (d < 20) {
      if (p.vehicle) sim.progress.stats.distanceDriven += d;
      else sim.progress.stats.distanceOnFoot += d;
    }
    this.lastX = pos.x;
    this.lastZ = pos.z;
  }

  private neutralVehicle(v: Vehicle): void {
    v.controls.throttle = 0;
    v.controls.brake = 0;
    v.controls.steer = 0;
    v.controls.handbrake = false;
  }

  private onFoot(dt: number, input: PlayerInput): void {
    const sim = this.sim;
    const p = sim.player;
    const yaw = input.cameraYaw;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = -fz;
    const rz = fx;
    let dx = fx * input.moveZ + rx * input.moveX;
    let dz = fz * input.moveZ + rz * input.moveX;
    const mag = Math.hypot(dx, dz);
    if (mag > 1e-6) {
      dx /= mag;
      dz /= mag;
    }
    const m = Math.min(1, mag);
    const swimming = p.state === 'swimming';
    const weapon = p.inventory.spec();
    const firing = (input.fire || input.firePressed) && !swimming;
    // Keep the aiming pose briefly after shooting so the character doesn't snap around.
    p.aiming = !swimming && (input.aim || (firing && weapon.id !== 'fists') || (p.aimHold > 0 && weapon.id !== 'fists'));

    let speed = swimming ? 2.4 : input.sprint ? 7.4 : 4.3;
    if (p.aiming && !swimming) speed = input.sprint ? 4.3 : 2.8;
    p.moveX = dx;
    p.moveZ = dz;
    p.moveSpeed = m > 0.05 ? speed * m : 0;

    const aimYaw = Math.atan2(input.aimDir.x, input.aimDir.z);
    p.aimYaw = aimYaw;
    p.aimPitch = Math.asin(clamp(input.aimDir.y, -1, 1));
    if (p.aiming || p.punchTimer > 0) p.heading = moveAngleTowards(p.heading, aimYaw, 16 * dt);
    else if (m > 0.05) p.heading = moveAngleTowards(p.heading, Math.atan2(dx, dz), 11 * dt);

    if (input.jump && !swimming) p.wantJump = true;

    if (!swimming) {
      if (input.selectSlot >= 0) {
        const id = WEAPON_ORDER[input.selectSlot];
        if (id && p.inventory.has(id)) p.inventory.current = id;
      }
      if (input.nextWeapon) p.inventory.cycle(1);
      if (input.prevWeapon) p.inventory.cycle(-1);
      if (input.reload) sim.combat.startReload(p);
      if (firing) sim.combat.playerFire(p, input, false);
    }

    if (input.enterExit && !swimming) {
      const v = this.findEnterable(p);
      if (v) this.beginEnter(p, v);
    }
  }

  /** Nearest vehicle whose body is within reach. */
  findEnterable(p: Character): Vehicle | null {
    let best: Vehicle | null = null;
    let bd = Infinity;
    for (const v of this.sim.vehicles) {
      if (v.removed || !v.drivable || v.airborne || v.speed > 7) continue;
      const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
      if (d > 12 || Math.abs(v.pos.y - p.pos.y) > 2.5) continue;
      vehicleObb(v, obb);
      if (!circleVsObb(p.pos.x, p.pos.z, 2.0, obb, contact)) continue;
      if (v.driver && v.driver.isPlayer) continue;
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  private beginEnter(p: Character, v: Vehicle): void {
    p.state = 'entering';
    p.enterTarget = v;
    p.enterTimer = 0;
    p.vel.x = 0;
    p.vel.z = 0;
    this.jacked = false;
    if (v.ai) v.ai.hold = true;
    // Long vehicles (bus) are in reach from further than 7 m from the door.
    const door = this.doorPos(v);
    this.enterReach = Math.max(7, Math.hypot(door.x - p.pos.x, door.z - p.pos.z) + 2);
  }

  private doorPos(v: Vehicle): { x: number; z: number } {
    // Driver door is on the vehicle's left (local +X).
    const sx = Math.cos(v.heading);
    const sz = -Math.sin(v.heading);
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    return { x: v.pos.x + sx * (v.halfW + 0.55) + fx * 0.35, z: v.pos.z + sz * (v.halfW + 0.55) + fz * 0.35 };
  }

  private entering(dt: number): void {
    const sim = this.sim;
    const p = sim.player;
    const v = p.enterTarget;
    if (!v || v.removed || !v.drivable) {
      this.abortEnter();
      return;
    }
    p.enterTimer += dt;
    const door = this.doorPos(v);
    const dx = door.x - p.pos.x;
    const dz = door.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > this.enterReach) {
      this.abortEnter();
      return;
    }
    const step = Math.min(d, 7 * dt);
    if (d > 1e-3) {
      p.pos.x += (dx / d) * step;
      p.pos.z += (dz / d) * step;
    }
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    p.heading = moveAngleTowards(p.heading, Math.atan2(v.pos.x - p.pos.x, v.pos.z - p.pos.z), 10 * dt);
    p.animPhase += dt * 8;

    if (v.driver && v.driver !== p && p.enterTimer >= 0.35 && !this.jacked) {
      const victim = v.driver;
      sim.unseat(victim);
      const sx = Math.cos(v.heading);
      const sz = -Math.sin(v.heading);
      victim.state = 'knocked';
      victim.knockTimer = 1.3;
      victim.pos.x = door.x + sx * 0.9;
      victim.pos.z = door.z + sz * 0.9;
      victim.pos.y = sim.world.groundHeight(victim.pos.x, victim.pos.z) + 0.3;
      victim.vel.x = sx * 3;
      victim.vel.z = sz * 3;
      victim.vel.y = 2;
      victim.onGround = false;
      sim.peds.onJacked(victim);
      this.jacked = true;
      sim.wanted.crime('carjack', v.pos.x, v.pos.z);
    }
    const seatTime = this.jacked ? 0.95 : 0.45;
    if (p.enterTimer >= seatTime && (!v.driver || v.driver === p)) {
      for (const o of v.passengers) {
        if (o) {
          sim.unseat(o);
          const spot = sim.world.findFreeSpot(v.pos.x - Math.cos(v.heading) * (v.halfW + 0.8), v.pos.z + Math.sin(v.heading) * (v.halfW + 0.8), 0.4, 5);
          if (spot) {
            o.pos.x = spot.x;
            o.pos.z = spot.z;
            o.pos.y = sim.world.groundHeight(spot.x, spot.z);
          }
          o.state = 'normal';
          sim.peds.onJacked(o);
        }
      }
      sim.seat(p, v, 0);
      v.ai = null;
      // The car is the player's now: police, traffic and parking systems let go of it.
      // Only taking a cruiser from the police is a theft, not getting back into it later.
      const fromPolice = v.owner === 'police';
      if (v.owner !== 'mission') v.owner = 'none';
      v.controls.handbrake = false;
      if (!v.usedByPlayer) sim.progress.stats.carsStolen++;
      v.usedByPlayer = true;
      if (fromPolice) sim.wanted.crime('stealPoliceCar', v.pos.x, v.pos.z);
      this.lastVehicle = v;
      this.exitPending = false;
      p.enterTarget = null;
      sim.events.emit('vehicleEnter', { vehicle: v, character: p, jacked: this.jacked });
    }
  }

  private abortEnter(): void {
    const p = this.sim.player;
    if (p.enterTarget?.ai) p.enterTarget.ai.hold = false;
    // A player who died mid-entry stays dead.
    if (p.state === 'entering') p.state = 'normal';
    p.enterTarget = null;
  }

  private driving(dt: number, input: PlayerInput): void {
    const sim = this.sim;
    const p = sim.player;
    const v = p.vehicle;
    if (!v || v.removed) {
      this.ejectPlayer(false);
      return;
    }
    const c = v.controls;
    if (this.exitPending) {
      c.throttle = 0;
      c.steer = 0;
      c.brake = v.forwardSpeed > 0.5 ? 1 : 0;
      c.handbrake = v.forwardSpeed <= 0.5;
      if (v.speed < 3.2 || !v.drivable) this.exitVehicle(false);
      return;
    }
    c.throttle = clamp(input.throttle, 0, 1);
    c.brake = clamp(input.brake, 0, 1);
    c.steer = this.steerFor(v, input, dt);
    c.handbrake = input.handbrake;

    if (input.hornPressed) {
      if (v.spec.police) v.siren = !v.siren;
      else sim.onHorn(v);
    } else if (input.horn && !v.spec.police && v.hornTimer <= 0) {
      sim.onHorn(v);
    }
    v.horn = input.horn && !v.spec.police;

    p.aimYaw = Math.atan2(input.aimDir.x, input.aimDir.z);
    p.aimPitch = Math.asin(clamp(input.aimDir.y, -1, 1));
    if (input.selectSlot >= 0) {
      const id = WEAPON_ORDER[input.selectSlot];
      if (id && p.inventory.has(id)) p.inventory.current = id;
    }
    if (input.nextWeapon) p.inventory.cycle(1);
    if (input.prevWeapon) p.inventory.cycle(-1);
    if (input.reload) sim.combat.startReload(p);
    if (input.fire || input.firePressed) {
      const w = p.inventory.current;
      if (w === 'pistol' || w === 'smg') sim.combat.playerFire(p, input, true);
    }

    if (input.enterExit) {
      if (v.speed < 3.5 || !v.drivable) this.exitVehicle(false);
      else if (v.speed < 11) this.exitPending = true;
      else this.exitVehicle(true);
    }
  }

  /**
   * The steering sent to the car. Keys are on or off, so they are shaped: the wheel winds in more
   * slowly the faster the car goes (a tap at speed is a lane nudge, not a swerve), eases back at a
   * fixed rate, and above 20 m/s stops short of full lock. Holding the handbrake keeps today's
   * immediate full lock for handbrake turns and drifts. Analog sticks pass straight through. Either
   * way the car's own steering rate limit (stepVehicle) still applies on top.
   */
  private steerFor(v: Vehicle, input: PlayerInput, dt: number): number {
    const frame = this.sim.frame;
    // A new car, or the first frame back at the wheel (after a cutscene lock or an exit that found
    // no room), starts from the centre.
    if (v !== this.steerCar || frame !== this.steerFrame + 1) this.steerKb = 0;
    this.steerCar = v;
    this.steerFrame = frame;
    const target = clamp(input.steer, -1, 1);
    if (!input.steerDigital || input.handbrake) {
      this.steerKb = target;
      return target;
    }
    const speed = v.speed;
    // Today's 4.2/s up to walking pace (full lock in 0.24 s for parking), then slower with speed.
    const rate = KEY_STEER_RATE / (1 + Math.max(0, speed - 5) / 12);
    this.steerKb = keySteerStep(this.steerKb, target, rate, KEY_STEER_RETURN, dt);
    return this.steerKb / (1 + Math.max(0, speed - 20) / 25);
  }

  /** Gets the player out of the current vehicle. Returns false if there was no room. */
  exitVehicle(bail: boolean): boolean {
    const sim = this.sim;
    const p = sim.player;
    const v = p.vehicle;
    if (!v) return false;
    const spot = this.findExitSpot(v) ?? (bail ? this.doorPos(v) : null);
    if (!spot) {
      sim.events.emit('message', { text: 'No room to get out here.', duration: 2 });
      this.exitPending = false;
      return false;
    }
    sim.unseat(p);
    p.state = 'normal';
    p.pos.x = spot.x;
    p.pos.z = spot.z;
    p.pos.y = Math.max(sim.world.groundHeight(spot.x, spot.z), v.pos.y);
    p.heading = v.heading;
    p.vel.x = 0;
    p.vel.y = 0;
    p.vel.z = 0;
    p.onGround = false;
    this.exitPending = false;
    if (bail) {
      const sx = Math.cos(v.heading);
      const sz = -Math.sin(v.heading);
      p.state = 'knocked';
      p.knockTimer = 1.1;
      p.vel.x = v.vel.x * 0.6 + sx * 3;
      p.vel.z = v.vel.z * 0.6 + sz * 3;
      p.vel.y = 2.5;
      sim.combat.damageCharacter(p, 6, null, 'fall', 0, -1, 0);
    }
    v.controls.throttle = 0;
    v.controls.brake = 0;
    v.controls.steer = 0;
    v.controls.handbrake = !bail;
    sim.events.emit('vehicleExit', { vehicle: v, character: p });
    return true;
  }

  private findExitSpot(v: Vehicle): { x: number; z: number } | null {
    const sim = this.sim;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const sx = Math.cos(v.heading);
    const sz = -Math.sin(v.heading);
    const cands = [
      { x: v.pos.x + sx * (v.halfW + 0.7) + fx * 0.3, z: v.pos.z + sz * (v.halfW + 0.7) + fz * 0.3 },
      { x: v.pos.x - sx * (v.halfW + 0.7) + fx * 0.3, z: v.pos.z - sz * (v.halfW + 0.7) + fz * 0.3 },
      { x: v.pos.x - fx * (v.halfL + 0.9), z: v.pos.z - fz * (v.halfL + 0.9) },
      { x: v.pos.x + fx * (v.halfL + 0.9), z: v.pos.z + fz * (v.halfL + 0.9) },
    ];
    for (const s of cands) {
      if (!sim.world.isFree(s.x, s.z, 0.38, true)) continue;
      if (Math.abs(sim.world.groundHeight(s.x, s.z) - v.pos.y) > 1.2 && sim.world.waterDepth(s.x, s.z) < 0) continue;
      let blocked = false;
      for (const o of sim.vehicles) {
        if (o === v || o.removed) continue;
        if (Math.hypot(o.pos.x - s.x, o.pos.z - s.z) > 8) continue;
        vehicleObb(o, obb);
        if (circleVsObb(s.x, s.z, 0.45, obb, contact)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return s;
    }
    return null;
  }

  /** Forcibly removes the player from a vehicle (sinking, despawn, explosion). */
  ejectPlayer(_safe: boolean): void {
    const sim = this.sim;
    const p = sim.player;
    const v = p.vehicle;
    if (!v) return;
    const spot = this.findExitSpot(v) ?? { x: v.pos.x, z: v.pos.z };
    sim.unseat(p);
    p.state = p.alive ? 'normal' : 'dead';
    p.pos.x = spot.x;
    p.pos.z = spot.z;
    p.pos.y = Math.max(sim.world.groundHeight(spot.x, spot.z), v.pos.y + 0.5);
    p.vel.x = 0;
    p.vel.y = 0;
    p.vel.z = 0;
    p.onGround = false;
    this.exitPending = false;
    sim.events.emit('vehicleExit', { vehicle: v, character: p });
  }
}

/** Keyboard steering: wind-in rate (full lock per second) at walking pace, and the rate back to the centre. */
const KEY_STEER_RATE = 4.2;
const KEY_STEER_RETURN = 8;

/**
 * One step of the keyboard wheel towards `target`: away from the centre at `ramp` per second, back
 * towards it (easing off, or on the way through to the other side) at `back` per second.
 */
function keySteerStep(cur: number, target: number, ramp: number, back: number, dt: number): number {
  if (cur !== 0 && (Math.sign(target) !== Math.sign(cur) || Math.abs(target) < Math.abs(cur))) {
    const stop = Math.sign(target) === Math.sign(cur) ? target : 0;
    const need = Math.abs(cur - stop) / back;
    if (need >= dt) return cur + Math.sign(stop - cur) * back * dt;
    cur = stop;
    dt -= need;
  }
  const d = target - cur;
  const max = ramp * dt;
  return Math.abs(d) <= max ? target : cur + Math.sign(d) * max;
}
