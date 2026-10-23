// Turns PlayerInput into player character / vehicle behaviour.

import { circleVsObb, makeContact, segmentHitsAabb } from '../core/collision';
import { clamp, moveAngleTowards, moveTowards, smoothstep, wrapAngle } from '../core/math';
import { MAX_STEP, SWIM_SPEED } from './characterPhysics';
import type { Character, Vehicle } from './entities';
import type { PlayerInput } from './input';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import { isGun, WEAPONS, weaponForKey } from './specs';
import { vehicleObb } from './vehiclePhysics';

const contact = makeContact();
const obb = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
/**
 * Point-blank aim convergence (see PlayerController.convergeAim): with the crosshair on someone nearer than
 * CONVERGE_FROM (m, across the ground from the player) the aim starts to turn from the camera ray's yaw towards him,
 * and points straight at him from CONVERGE_FULL in. The turn eases at CONVERGE_RATE (rad/s) when the crosshair jumps on
 * or off someone at point blank, quicker than any steady approach needs.
 */
const CONVERGE_FROM = 3;
const CONVERGE_FULL = 1;
const CONVERGE_RATE = 9.5;

interface EntryPoint { x: number; z: number }
interface EntryRoute { side: 1 | -1; points: EntryPoint[]; length: number }

export class PlayerController {
  private exitPending = false;
  private jacked = false;
  /** Door distance beyond which entering is given up (the vehicle drove off). */
  private enterReach = 7;
  /** Local-space waypoints follow the car while its held AI brakes to a stop. */
  private entryPoints: EntryPoint[] = [];
  private entrySide: 1 | -1 = 1;
  private jackedAt = 0;
  private lastX = 0;
  private lastZ = 0;
  /** Current point-blank aim convergence: how far (rad) the aim is turned from the camera ray's yaw. */
  private converge = 0;
  /** Last vehicle the player entered (for mission checks). */
  lastVehicle: Vehicle | null = null;
  /** Keyboard steering wheel position before the high-speed authority cut (see steerFor). */
  private steerKb = 0;
  private steerCar: Vehicle | null = null;
  private steerFrame = -1;

  /** `p` is the slot this controller drives; every controller keeps its own state. */
  constructor(private readonly sim: Sim, readonly p: PlayerSlot) {
    this.lastX = p.character.pos.x;
    this.lastZ = p.character.pos.z;
  }

  update(dt: number, input: PlayerInput): void {
    const sim = this.sim;
    const slot = this.p;
    const p = slot.character;
    p.aiming = false;
    p.aimZoom = false;
    p.moveSpeed = 0;
    this.trackDistance();
    // Dying or being busted mid-entry must release the car's AI hold.
    if (p.enterTarget && (slot.down || p.state !== 'entering')) this.abortEnter();
    if (slot.down || !p.alive) {
      if (p.vehicle) this.neutralVehicle(p.vehicle);
      return;
    }
    if (slot.controlLock > 0) {
      if (p.vehicle) {
        const c = p.vehicle.controls;
        c.throttle = 0;
        c.steer = 0;
        c.brake = 0;
        c.handbrake = true;
      }
      return;
    }
    if (p.state !== 'normal' && p.state !== 'swimming') this.converge = 0;
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
    if (input.interact && p.state !== 'entering') sim.interactions.interact(slot);
    if (input.job) sim.activities.toggleJob(slot);
  }

  private trackDistance(): void {
    const p = this.p.character;
    const pos = this.p.pos();
    const d = Math.hypot(pos.x - this.lastX, pos.z - this.lastZ);
    if (d < 20) {
      if (p.vehicle) this.p.progress.stats.distanceDriven += d;
      else this.p.progress.stats.distanceOnFoot += d;
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
    const p = this.p.character;
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
    // A queued semi-automatic shot (see CombatSystem.playerFire) still fires once the trigger is released.
    const firing = (input.fire || input.firePressed || p.fireQueued > 0) && !swimming;
    const gun = isGun(weapon.id);
    // Keep the aiming pose briefly after shooting so the character doesn't snap around.
    p.aiming = !swimming && (input.aim || (firing && gun) || (p.aimHold > 0 && gun));
    // Only the aim button zooms in and slows the walk; hip fire keeps the view and the pace.
    p.aimZoom = !swimming && input.aim;

    let speed = swimming ? SWIM_SPEED : input.sprint ? 7.4 : 4.3;
    if (p.aimZoom) speed = input.sprint ? 4.3 : 2.8;
    p.moveX = dx;
    p.moveZ = dz;
    p.moveSpeed = m > 0.05 ? speed * m : 0;

    const rayYaw = Math.atan2(input.aimDir.x, input.aimDir.z);
    const aimYaw = wrapAngle(rayYaw + this.convergeAim(p, input, rayYaw, p.aiming && gun, dt));
    p.aimYaw = aimYaw;
    p.aimPitch = Math.asin(clamp(input.aimDir.y, -1, 1));
    if (p.aiming || p.punchTimer > 0) p.heading = moveAngleTowards(p.heading, aimYaw, 16 * dt);
    else if (m > 0.05) p.heading = moveAngleTowards(p.heading, Math.atan2(dx, dz), 11 * dt);

    if (input.jump && !swimming) p.wantJump = true;

    if (!swimming) {
      this.selectWeapon(input);
      // Held up to the eye, a scoped rifle's wheel (and weapon-step keys) zoom the scope instead of changing weapons.
      const scope = p.aimZoom ? weapon.scope : undefined;
      if (scope) {
        if (input.nextWeapon) p.scopeLevel = Math.min(scope.zooms.length - 1, p.scopeLevel + 1);
        if (input.prevWeapon) p.scopeLevel = Math.max(0, p.scopeLevel - 1);
      } else {
        p.scopeLevel = 0;
        if (input.nextWeapon) p.inventory.cycle(1);
        if (input.prevWeapon) p.inventory.cycle(-1);
      }
      if (input.reload) sim.combat.startReload(p);
      if (firing) sim.combat.playerFire(p, input, false);
    }

    if (input.enterExit && !swimming) {
      const v = this.findEnterable(p);
      if (v) this.beginEnter(p, v);
    }
  }

  /**
   * How far (rad) to turn a gun's aim from the crosshair ray's yaw `rayYaw` at point blank. The shoulder camera looks
   * past the player's right shoulder from above and behind, so near him its ray and the gun's (from beside and below
   * it) part: someone close by the shoulder under the crosshair is not in front of the barrel. Within CONVERGE_FROM the
   * aim turns towards the point of the ray on him, fully from CONVERGE_FULL in, blended between with distance so a
   * steady approach shows no pop; beyond, and with no gun up, it is the ray's yaw exactly. A wall or a car under the
   * crosshair needs none: the shot already goes to the crosshair's point on it.
   */
  private convergeAim(p: Character, input: PlayerInput, rayYaw: number, gun: boolean, dt: number): number {
    let want = 0;
    if (gun) {
      const q = this.sim.combat.crosshairPerson(input.aimOrigin, input.aimDir, CONVERGE_FROM + 2, p);
      if (q) {
        const dx = q.x - p.pos.x;
        const dz = q.z - p.pos.z;
        const d = Math.hypot(dx, dz);
        const w = 1 - smoothstep(CONVERGE_FULL, CONVERGE_FROM, d);
        if (w > 0 && d > 1e-3) want = w * wrapAngle(Math.atan2(dx, dz) - rayYaw);
      }
    }
    this.converge = moveTowards(this.converge, want, CONVERGE_RATE * dt);
    return this.converge;
  }

  /** A number key draws its weapon (see weaponForKey: a key shared by two weapons steps between them). */
  private selectWeapon(input: PlayerInput): void {
    if (input.selectSlot < 0) return;
    const inv = this.p.character.inventory;
    const id = weaponForKey(input.selectSlot, (w) => inv.has(w) && !!WEAPONS[w], inv.current);
    if (id) inv.current = id;
  }

  /** Nearest vehicle whose body is in reach and has a walkable approach to a door. */
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
      if (d < bd && this.entryRoute(p, v)) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  private beginEnter(p: Character, v: Vehicle): void {
    const route = this.entryRoute(p, v);
    if (!route) return;
    this.entryPoints = route.points;
    this.entrySide = route.side;
    p.state = 'entering';
    p.enterTarget = v;
    p.enterTimer = 0;
    p.vel.x = 0;
    p.vel.z = 0;
    this.jacked = false;
    this.jackedAt = 0;
    if (v.ai) v.ai.hold = true;
    // Long vehicles (bus) are in reach from further than 7 m from the door.
    this.enterReach = Math.max(7, route.length + 2);
  }

  private doorPos(v: Vehicle, side: 1 | -1 = 1): EntryPoint {
    // Driver door is on the vehicle's left (local +X).
    const sx = Math.cos(v.heading);
    const sz = -Math.sin(v.heading);
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    return { x: v.pos.x + sx * (v.halfW + 0.55) * side + fx * 0.35, z: v.pos.z + sz * (v.halfW + 0.55) * side + fz * 0.35 };
  }

  private entryWorld(v: Vehicle, point: EntryPoint): EntryPoint {
    const s = Math.sin(v.heading);
    const c = Math.cos(v.heading);
    return { x: v.pos.x + c * point.x + s * point.z, z: v.pos.z - s * point.x + c * point.z };
  }

  /** A short swept walk, including body width: a sight ray alone misses thin posts and wall corners. */
  private entrySegmentClear(p: Character, v: Vehicle, a: EntryPoint, b: EntryPoint): boolean {
    const s = Math.sin(v.heading);
    const c = Math.cos(v.heading);
    const ax = a.x - v.pos.x;
    const az = a.z - v.pos.z;
    const bx = b.x - v.pos.x;
    const bz = b.z - v.pos.z;
    // The tiny tolerance lets a character already touching the body's physics
    // margin move away; it never permits a path through the vehicle itself.
    const bodyMargin = p.radius - 0.05;
    if (segmentHitsAabb(ax * c - az * s, ax * s + az * c, bx * c - bz * s, bx * s + bz * c,
      { minX: -v.halfW - bodyMargin, maxX: v.halfW + bodyMargin, minZ: -v.halfL - bodyMargin, maxZ: v.halfL + bodyMargin })) return false;
    const world = this.sim.world;
    const distance = Math.hypot(b.x - a.x, b.z - a.z);
    const samples = Math.max(1, Math.ceil(distance / 0.2));
    let ground = world.groundHeight(a.x, a.z);
    for (let i = 1; i <= samples; i++) {
      const x = a.x + (b.x - a.x) * i / samples;
      const z = a.z + (b.z - a.z) * i / samples;
      const nextGround = world.groundHeight(x, z);
      if (!world.isFree(x, z, p.radius, true) || world.waterDepth(x, z) > 1 || Math.abs(nextGround - ground) > MAX_STEP) return false;
      ground = nextGround;
    }
    return true;
  }

  private entryRouteClear(p: Character, v: Vehicle, points: readonly EntryPoint[]): boolean {
    let previous: EntryPoint = p.pos;
    for (const point of points) {
      const next = this.entryWorld(v, point);
      if (!this.entrySegmentClear(p, v, previous, next)) return false;
      previous = next;
    }
    return true;
  }

  /** Both doors, directly or around either end. No general city pathfinding for a nearby car. */
  private entryRoute(p: Character, v: Vehicle): EntryRoute | null {
    let best: EntryRoute | null = null;
    for (const side of [1, -1] as const) {
      const door = { x: (v.halfW + 0.55) * side, z: 0.35 };
      const paths = [[door]];
      for (const end of [1, -1]) {
        const corner = { x: (v.halfW + 0.7) * side, z: (v.halfL + 0.7) * end };
        paths.push([corner, door], [{ x: -corner.x, z: corner.z }, corner, door]);
      }
      for (const points of paths) {
        let previous: EntryPoint = p.pos;
        let length = 0;
        for (const point of points) {
          const next = this.entryWorld(v, point);
          length += Math.hypot(next.x - previous.x, next.z - previous.z);
          previous = next;
        }
        if (length > 24 || (best && length >= best.length) || !this.entryRouteClear(p, v, points)) continue;
        best = { side, points, length };
      }
    }
    return best;
  }

  private entering(dt: number): void {
    const sim = this.sim;
    const p = this.p.character;
    const v = p.enterTarget;
    if (!v || v.removed || !v.drivable || v.airborne) {
      this.abortEnter();
      return;
    }
    p.enterTimer += dt;
    const currentDoor = this.doorPos(v, this.entrySide);
    if (p.enterTimer > 8 || Math.hypot(currentDoor.x - p.pos.x, currentDoor.z - p.pos.z) > this.enterReach) {
      this.abortEnter();
      return;
    }
    if (!this.entryPoints.length || !this.entryRouteClear(p, v, this.entryPoints)) {
      const route = this.entryRoute(p, v);
      if (!route) {
        this.abortEnter();
        return;
      }
      this.entryPoints = route.points;
      this.entrySide = route.side;
    }
    let distanceLeft = 7 * dt;
    while (this.entryPoints.length && distanceLeft > 0) {
      const next = this.entryWorld(v, this.entryPoints[0]!);
      const dx = next.x - p.pos.x;
      const dz = next.z - p.pos.z;
      const distance = Math.hypot(dx, dz);
      const walk = Math.min(distance, distanceLeft);
      if (distance > 1e-6) {
        p.pos.x += dx / distance * walk;
        p.pos.z += dz / distance * walk;
      }
      distanceLeft -= walk;
      if (distance <= walk + 1e-6) this.entryPoints.shift();
      else break;
    }
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    p.heading = moveAngleTowards(p.heading, Math.atan2(v.pos.x - p.pos.x, v.pos.z - p.pos.z), 10 * dt);
    p.animPhase += dt * 8;

    const door = this.doorPos(v, this.entrySide);
    const atDoor = !this.entryPoints.length && Math.hypot(door.x - p.pos.x, door.z - p.pos.z) <= 0.2;
    if (atDoor && v.driver && v.driver !== p && p.enterTimer >= 0.35 && !this.jacked) {
      const victim = v.driver;
      sim.unseat(victim);
      const sx = Math.cos(v.heading) * this.entrySide;
      const sz = -Math.sin(v.heading) * this.entrySide;
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
      this.jackedAt = p.enterTimer;
      this.p.wanted.crime('carjack', v.pos.x, v.pos.z, this.p);
    }
    const seatTime = this.jacked ? Math.max(0.95, this.jackedAt + 0.6) : 0.45;
    if (atDoor && p.enterTimer >= seatTime && (!v.driver || v.driver === p)) {
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
      if (!v.usedByPlayer) this.p.progress.stats.carsStolen++;
      v.usedByPlayer = true;
      if (fromPolice) this.p.wanted.crime('stealPoliceCar', v.pos.x, v.pos.z, this.p);
      this.lastVehicle = v;
      this.exitPending = false;
      p.enterTarget = null;
      this.entryPoints = [];
      sim.events.emit('vehicleEnter', { vehicle: v, character: p, jacked: this.jacked });
    }
  }

  private abortEnter(): void {
    const p = this.p.character;
    if (p.enterTarget?.ai) p.enterTarget.ai.hold = false;
    // A player who died mid-entry stays dead.
    if (p.state === 'entering') p.state = 'normal';
    p.enterTarget = null;
    this.entryPoints = [];
  }

  private driving(dt: number, input: PlayerInput): void {
    const sim = this.sim;
    const p = this.p.character;
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
    p.scopeLevel = 0;
    this.selectWeapon(input);
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
   * The steering sent to the car. Held keys are on or off, so they are shaped: the wheel winds in
   * more slowly the faster the car goes (a tap at speed is a lane nudge, not a swerve), eases back
   * through the centre when the other key takes over, and above 20 m/s stops short of full lock.
   * Holding the handbrake keeps today's immediate full lock for handbrake turns and drifts. Sticks,
   * and keys let go, pass straight through. Either way the car's own steering rate limit
   * (stepVehicle) still applies on top.
   */
  private steerFor(v: Vehicle, input: PlayerInput, dt: number): number {
    const frame = this.sim.frame;
    // A new car, or the first frame back at the wheel (after a cutscene lock or an exit that found
    // no room), starts from the centre.
    if (v !== this.steerCar || frame !== this.steerFrame + 1) this.steerKb = 0;
    this.steerCar = v;
    this.steerFrame = frame;
    // A broken pad axis must not stick in the keyboard wheel.
    const target = Number.isFinite(input.steer) ? clamp(input.steer, -1, 1) : 0;
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

  /** Calls off an exit still braking for its stop (asked for between 3.5 and 11 m/s): the player keeps driving. */
  cancelExit(): void {
    this.exitPending = false;
  }

  /** Gets the player out of the current vehicle. Returns false if there was no room. */
  exitVehicle(bail: boolean): boolean {
    const sim = this.sim;
    const p = this.p.character;
    const v = p.vehicle;
    if (!v) return false;
    const spot = this.findExitSpot(v) ?? (bail ? this.doorPos(v) : null);
    if (!spot) {
      sim.events.emit('message', { text: 'No room to get out here.', duration: 2, ...this.p.tag });
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

  /**
   * Where the player gets out of `v`: beside the driver's door, else the passenger's, behind or in front. First a spot
   * on dry ground (or water shallow enough to wade) level with the car, so a car parked along a quay, a pier or the
   * Marina deck lets him out on the dry side rather than into the sea or down onto the sand below; only failing that
   * (a car in the water, nothing but water and drops around) any open spot, the water included.
   */
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
    for (const dry of [true, false]) {
      for (const s of cands) {
        // Dry: isFree turns down water deeper than wading depth.
        if (!sim.world.isFree(s.x, s.z, 0.38, !dry)) continue;
        const level = Math.abs(sim.world.groundHeight(s.x, s.z) - v.pos.y) <= 1.2;
        if (!level && (dry || sim.world.waterDepth(s.x, s.z) < 0)) continue;
        if (!this.vehicleAt(s.x, s.z, v)) return s;
      }
    }
    return null;
  }

  /** Another vehicle than `v` covers (x, z), give or take a person's width. */
  private vehicleAt(x: number, z: number, v: Vehicle): boolean {
    for (const o of this.sim.vehicles) {
      if (o === v || o.removed) continue;
      if (Math.hypot(o.pos.x - x, o.pos.z - z) > 8) continue;
      vehicleObb(o, obb);
      if (circleVsObb(x, z, 0.45, obb, contact)) return true;
    }
    return false;
  }

  /** Forcibly removes the player from a vehicle (sinking, despawn, explosion). */
  ejectPlayer(_safe: boolean): void {
    const sim = this.sim;
    const p = this.p.character;
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
