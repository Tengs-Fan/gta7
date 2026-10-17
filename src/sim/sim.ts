// The headless game simulation. Owns all entities and runs every system in a
// fixed order each frame. Never touches the DOM, WebGL or audio.

import { Emitter } from '../core/emitter';
import { clamp, type V3 } from '../core/math';
import { Rng } from '../core/rng';
import type { StaticCollider } from '../world/colliders';
import { WATER_Y } from '../world/constants';
import type { RoadNetwork } from '../world/roads';
import { StaticWorld } from '../world/staticWorld';
import { Activities } from './activities';
import { randomAppearance } from './appearance';
import {
  collideCharacters, collideCharactersVehicles, collideCharacterStatic, stepCharacter, type CharacterPhysicsHost,
} from './characterPhysics';
import { GameClock } from './clock';
import { CombatSystem } from './combat';
import { DriverAI, type DriverHost, type DriverPolicy } from './driver';
import { Character, Helicopter, MAX_DENTS, Pickup, Projectile, Vehicle, type Appearance, type CharacterRole, type Dent } from './entities';
import type { SimEvents } from './events';
import { neutralInput, type PlayerInput } from './input';
import { Interactions } from './interactions';
import { MissionSystem } from './missions/runner';
import { PedSystem } from './peds';
import { PickupSystem } from './pickups';
import { PlayerController } from './player';
import { PoliceSystem } from './police';
import { Progress } from './progress';
import { VEHICLE_SPECS, type VehicleKind } from './specs';
import { TrafficSystem } from './traffic';
import { collideVehicles, collideVehicleStatic, stepVehicle, type VehiclePhysicsHost } from './vehiclePhysics';
import { WantedSystem } from './wanted';

export interface SimOptions {
  seed?: number;
  world?: StaticWorld;
  /** Ambient traffic, pedestrians and parked cars. */
  ambient?: boolean;
  /** Police respond to crimes. */
  police?: boolean;
  startHour?: number;
}

const PHYSICS_STEP = 1 / 120;

export class Sim implements VehiclePhysicsHost, CharacterPhysicsHost, DriverHost {
  readonly world: StaticWorld;
  readonly roads: RoadNetwork;
  readonly events = new Emitter<SimEvents>();
  readonly rng: Rng;
  readonly clock: GameClock;
  readonly progress = new Progress();
  time = 0;
  frame = 0;
  private nextId = 1;

  readonly characters: Character[] = [];
  readonly vehicles: Vehicle[] = [];
  readonly pickups: Pickup[] = [];
  readonly projectiles: Projectile[] = [];
  readonly helis: Helicopter[] = [];
  readonly player: Character;

  readonly playerCtl: PlayerController;
  readonly combat: CombatSystem;
  readonly wanted: WantedSystem;
  readonly police: PoliceSystem;
  readonly traffic: TrafficSystem;
  readonly peds: PedSystem;
  readonly pickupSys: PickupSystem;
  readonly interactions: Interactions;
  readonly activities: Activities;
  readonly missions: MissionSystem;

  ambient: boolean;
  policeEnabled: boolean;
  readonly cheats = { godMode: false, neverWanted: false };
  /** Simulation-time callbacks (see pickups.setTimeoutLike). */
  readonly timers: Array<{ at: number; fn: () => void }> = [];
  /** Seconds of player control lock remaining (cutscenes, spray shop). */
  controlLock = 0;
  deathTimer = -1;
  deathKind: 'wasted' | 'busted' | null = null;
  /** Camera pose from the last input, used for "is this visible" heuristics. */
  readonly cam: V3 = { x: 0, y: 0, z: 0 };
  readonly camDir: V3 = { x: 0, y: 0, z: 1 };
  lastInput: PlayerInput = neutralInput();

  constructor(opts: SimOptions = {}) {
    this.world = opts.world ?? new StaticWorld(opts.seed);
    this.roads = this.world.roads;
    this.rng = new Rng(((opts.seed ?? 7) * 2654435761) >>> 0);
    this.clock = new GameClock(opts.startHour ?? 16);
    this.ambient = opts.ambient ?? true;
    this.policeEnabled = opts.police ?? true;

    // Start on the sidewalk a few steps from the safehouse door, facing the street.
    const home = this.world.layout.pois.find((p) => p.id === 'safehouse')!;
    const sx = home.x + Math.cos(home.heading) * 3.2;
    const sz = home.z - Math.sin(home.heading) * 3.2;
    const start = this.world.findFreeSpot(sx, sz, 0.5, 6) ?? { x: home.x, z: home.z };
    this.player = this.spawnCharacter('player', start.x, start.z, randomAppearance(this.rng, 'player'));
    this.player.heading = home.heading;
    this.player.persistent = true;

    this.combat = new CombatSystem(this);
    this.wanted = new WantedSystem(this);
    this.police = new PoliceSystem(this);
    this.traffic = new TrafficSystem(this);
    this.peds = new PedSystem(this);
    this.pickupSys = new PickupSystem(this);
    this.interactions = new Interactions(this);
    this.activities = new Activities(this);
    this.missions = new MissionSystem(this);
    this.playerCtl = new PlayerController(this);
  }

  // ---------------------------------------------------------------------------
  // Entity management

  newId(): number {
    return this.nextId++;
  }

  spawnCharacter(role: CharacterRole, x: number, z: number, appearance?: Appearance): Character {
    const y = this.world.groundHeight(x, z);
    const c = new Character(this.newId(), role, x, y, z, appearance ?? randomAppearance(this.rng, role));
    this.characters.push(c);
    return c;
  }

  spawnVehicle(kind: VehicleKind, x: number, z: number, heading: number, color?: number): Vehicle {
    const spec = VEHICLE_SPECS[kind];
    const y = this.world.groundHeight(x, z);
    const v = new Vehicle(this.newId(), kind, x, y, z, heading, color ?? this.rng.pick(spec.colors));
    v.spawnTime = this.time;
    this.vehicles.push(v);
    return v;
  }

  /** Spawns an NPC driver inside `v` and gives the car a DriverAI (the driver gets no ped brain here). */
  addDriver(v: Vehicle, role: CharacterRole, policy: DriverPolicy): Character {
    const d = this.spawnCharacter(role, v.pos.x, v.pos.z);
    this.seat(d, v, 0);
    v.ai = new DriverAI(this, v, policy);
    return d;
  }

  seat(c: Character, v: Vehicle, seat: number): void {
    c.state = 'inVehicle';
    c.vehicle = v;
    c.seat = seat;
    c.vel.x = 0;
    c.vel.y = 0;
    c.vel.z = 0;
    if (seat === 0) {
      v.driver = c;
      v.lastDriver = c;
    } else {
      v.passengers[seat - 1] = c;
    }
    this.syncOccupant(c);
  }

  /** Removes a character from its vehicle seat (without placing it). */
  unseat(c: Character): void {
    const v = c.vehicle;
    if (!v) return;
    if (v.driver === c) {
      v.driver = null;
      v.ai = null;
      v.controls.throttle = 0;
      v.controls.brake = 0;
      v.controls.steer = 0;
      v.controls.handbrake = true;
    }
    for (let i = 0; i < v.passengers.length; i++) if (v.passengers[i] === c) v.passengers[i] = null;
    c.vehicle = null;
    if (c.state === 'inVehicle') c.state = 'normal';
  }

  removeCharacter(c: Character): void {
    if (c.removed || c === this.player) return;
    this.unseat(c);
    c.removed = true;
  }

  removeVehicle(v: Vehicle): void {
    if (v.removed) return;
    for (const o of v.occupants()) {
      if (o === this.player) this.playerCtl.ejectPlayer(false);
      else this.removeCharacter(o);
    }
    v.removed = true;
  }

  private compact(): void {
    for (let i = this.vehicles.length - 1; i >= 0; i--) if (this.vehicles[i]!.removed) this.vehicles.splice(i, 1);
    for (let i = this.characters.length - 1; i >= 0; i--) {
      const c = this.characters[i]!;
      if (c.removed) {
        this.characters.splice(i, 1);
        continue;
      }
      if (c.vehicle && c.vehicle.removed) {
        c.vehicle = null;
        if (c.state === 'inVehicle') c.state = 'normal';
      }
      if (c.brain && c.brain.car && c.brain.car.removed) c.brain.car = null;
      if (c.brain && c.brain.target && c.brain.target.removed) c.brain.target = null;
      if (c.brain && c.brain.threat && c.brain.threat.removed) c.brain.threat = null;
      if (c.lastAttacker && c.lastAttacker.removed) c.lastAttacker = null;
      if (c.enterTarget && c.enterTarget.removed) c.enterTarget = null;
    }
    for (const v of this.vehicles) {
      if (v.driver && v.driver.removed) v.driver = null;
      if (v.lastDriver && v.lastDriver.removed) v.lastDriver = null;
      for (let i = 0; i < v.passengers.length; i++) if (v.passengers[i]?.removed) v.passengers[i] = null;
      if (v.ai && v.ai.target && v.ai.target.removed) v.ai.target = null;
    }
    for (let i = this.pickups.length - 1; i >= 0; i--) if (this.pickups[i]!.removed) this.pickups.splice(i, 1);
    for (let i = this.projectiles.length - 1; i >= 0; i--) if (this.projectiles[i]!.removed) this.projectiles.splice(i, 1);
    for (let i = this.helis.length - 1; i >= 0; i--) if (this.helis[i]!.removed) this.helis.splice(i, 1);
  }

  syncOccupant(c: Character): void {
    const v = c.vehicle;
    if (!v) return;
    const side = c.seat === 0 || c.seat === 2 ? 1 : -1;
    const back = c.seat >= 2 ? -0.9 : 0.15;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const sx = Math.cos(v.heading);
    const sz = -Math.sin(v.heading);
    c.pos.x = v.pos.x + sx * side * v.halfW * 0.45 + fx * back;
    c.pos.z = v.pos.z + sz * side * v.halfW * 0.45 + fz * back;
    c.pos.y = v.pos.y + 0.25;
    c.heading = v.heading;
  }

  // ---------------------------------------------------------------------------
  // Queries

  distToPlayer(x: number, z: number): number {
    const p = this.playerPos();
    return Math.hypot(x - p.x, z - p.z);
  }

  playerPos(): V3 {
    return this.player.vehicle ? this.player.vehicle.pos : this.player.pos;
  }

  /** Rough "could the player see this point" test using the camera pose. */
  isVisible(x: number, y: number, z: number, maxDist = 320): boolean {
    const dx = x - this.cam.x;
    const dy = y - this.cam.y;
    const dz = z - this.cam.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 6) return true;
    if (d > maxDist) return false;
    const cos = (dx * this.camDir.x + dy * this.camDir.y + dz * this.camDir.z) / d;
    if (cos < 0.42) return false;
    return this.world.lineOfSight(this.cam.x, this.cam.y, this.cam.z, x, y + 1, z);
  }

  nearestVehicle(x: number, z: number, maxDist: number, filter?: (v: Vehicle) => boolean): Vehicle | null {
    let best: Vehicle | null = null;
    let bd = maxDist;
    for (const v of this.vehicles) {
      if (v.removed || (filter && !filter(v))) continue;
      const d = Math.hypot(v.pos.x - x, v.pos.z - z);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Physics host callbacks

  onVehicleImpact(v: Vehicle, other: Vehicle | null, deltaV: number, x: number, z: number, otherRammed = false, nx?: number, nz?: number): void {
    // Only the player driving into a car is his doing: a police car ramming him is not.
    const playerRammed = !!other && other.driver === this.player && otherRammed;
    if (deltaV > 2.5) {
      const dmg = (deltaV - 2.5) * v.spec.health * 0.022 * v.spec.durability;
      const before = v.health;
      // Ramming someone else's car makes the player responsible for its destruction.
      this.combat.damageVehicle(v, dmg, playerRammed ? this.player : null, 'impact');
      // A hit that did damage leaves a dent (the player's car in god mode keeps its shape).
      if (deltaV > 3 && v.health < before) this.dentAt(v, x, z, nx, nz, Math.min(0.4, 0.011 * deltaV * v.spec.durability));
    }
    if (v.impactTimer <= 0 && deltaV > 2) {
      v.impactTimer = 0.25;
      this.events.emit('impact', { x, y: v.pos.y + 0.6, z, strength: deltaV, vehicle: v });
    }
    // Hitting police cars is a crime; the police notice rammers.
    if (playerRammed && v.spec.police && deltaV > 3) this.wanted.crime('hitPolice', v.pos.x, v.pos.z);
    // Wake up AI drivers that got hit by the player.
    if (other && other.driver === this.player && v.driver && !v.driver.isPlayer && v.driver.brain) {
      v.driver.brain.threat = this.player;
    }
  }

  onPropBroken(c: StaticCollider, v: Vehicle): void {
    const idx = this.world.breakCollider(c);
    if (idx < 0) return;
    const sp = Math.max(0.1, v.speed);
    this.events.emit('propBroken', { index: idx, dirX: v.vel.x / sp, dirZ: v.vel.z / sp });
    this.events.emit('impact', { x: c.cx, y: v.pos.y + 0.5, z: c.cz, strength: 3, vehicle: v });
  }

  onVehicleLanded(v: Vehicle, impact: number): void {
    const before = v.health;
    if (impact > 9) this.combat.damageVehicle(v, (impact - 9) * v.spec.health * 0.03 * v.spec.durability, null, 'impact');
    if (impact > 3) this.events.emit('impact', { x: v.pos.x, y: v.pos.y, z: v.pos.z, strength: impact * 0.6, vehicle: v });
    if (v.flipped && !v.burning && !v.destroyed) this.combat.igniteVehicle(v, 3.5);
    // A landing on the roof that did damage crushes it (the roof dent pushes straight down).
    if (v.flipped && v.health < before) {
      this.addDent(v, { lx: 0, ly: v.spec.height, lz: 0, nx: 0, nz: 0, depth: Math.min(0.4, 0.15 + 0.011 * impact * v.spec.durability) });
    }
    this.activities.onVehicleLanded(v);
  }

  /** Last 'scrape' event time per vehicle, to emit at most 15 per second each. */
  private readonly scrapeTimes = new WeakMap<Vehicle, number>();
  /** Each vehicle's health at the last tick: a rise back to full health is a repair, which takes the dents away. */
  private readonly healthSeen = new WeakMap<Vehicle, number>();

  onVehicleScrape(v: Vehicle, x: number, z: number, speed: number): void {
    const last = this.scrapeTimes.get(v);
    if (last !== undefined && this.time - last < 1 / 15) return;
    this.scrapeTimes.set(v, this.time);
    this.events.emit('scrape', { x, y: v.pos.y + 0.4, z, speed, vehicle: v });
  }

  /**
   * Dents `v` where a crash touched it at world (x, z). (nx, nz) is the world contact normal pushing `v` away, i.e. into
   * its body; without one (ledge hits) the face the point lies on decides. The dent sits on the body outline at half height.
   */
  private dentAt(v: Vehicle, x: number, z: number, nx: number | undefined, nz: number | undefined, depth: number): void {
    const c = Math.cos(v.heading);
    const s = Math.sin(v.heading);
    const dx = x - v.pos.x;
    const dz = z - v.pos.z;
    let lx = dx * c - dz * s;
    let lz = dx * s + dz * c;
    let inx = 0;
    let inz = 0;
    if (nx !== undefined && nz !== undefined) {
      inx = nx * c - nz * s;
      inz = nx * s + nz * c;
    }
    const nl = Math.hypot(inx, inz);
    if (nl > 1e-6) {
      inx /= nl;
      inz /= nl;
    } else if (Math.abs(lz) / v.halfL >= Math.abs(lx) / v.halfW) {
      inx = 0;
      inz = lz >= 0 ? -1 : 1;
    } else {
      inx = lx >= 0 ? -1 : 1;
      inz = 0;
    }
    // Onto the face the push comes through (a deep contact point lies inside the body).
    if (Math.abs(inz) >= Math.abs(inx)) {
      lz = inz < 0 ? v.halfL : -v.halfL;
      lx = clamp(lx, -v.halfW, v.halfW);
    } else {
      lx = inx < 0 ? v.halfW : -v.halfW;
      lz = clamp(lz, -v.halfL, v.halfL);
    }
    this.addDent(v, { lx, ly: v.spec.height * 0.5, lz, nx: inx, nz: inz, depth });
  }

  /** A new dent within 0.6 m of an existing one keeps the deeper of the two; with MAX_DENTS the shallowest gives way. */
  private addDent(v: Vehicle, d: Dent): void {
    let near: Dent | null = null;
    let nearDist = 0.6;
    for (const o of v.dents) {
      const dist = Math.hypot(o.lx - d.lx, o.ly - d.ly, o.lz - d.lz);
      if (dist < nearDist) {
        nearDist = dist;
        near = o;
      }
    }
    if (near) {
      if (d.depth > near.depth) {
        Object.assign(near, d);
        v.dentVersion++;
      }
      return;
    }
    if (v.dents.length < MAX_DENTS) {
      v.dents.push(d);
      v.dentVersion++;
      return;
    }
    let k = 0;
    for (let i = 1; i < v.dents.length; i++) if (v.dents[i]!.depth < v.dents[k]!.depth) k = i;
    if (d.depth > v.dents[k]!.depth) {
      v.dents[k] = d;
      v.dentVersion++;
    }
  }

  onVehicleEnteredWater(v: Vehicle): void {
    this.events.emit('splash', { x: v.pos.x, y: WATER_Y, z: v.pos.z, big: true });
    v.burning = false;
    for (const o of v.occupants()) {
      if (o === this.player) this.playerCtl.ejectPlayer(false);
      else this.removeCharacter(o);
    }
  }

  onCharacterHitByVehicle(c: Character, v: Vehicle, relSpeed: number, nx: number, nz: number): void {
    const dmg = Math.max(0, relSpeed - 4) ** 2 * 2.3 + 6;
    const vs = Math.max(0.1, v.speed);
    c.vel.x = v.vel.x * 0.85 + nx * 2.5;
    c.vel.z = v.vel.z * 0.85 + nz * 2.5;
    c.vel.y = 2.5 + Math.min(relSpeed, 30) * 0.18;
    c.onGround = false;
    if (c.state === 'normal') {
      c.state = 'knocked';
      c.knockTimer = 2.2;
    }
    const driver = v.driver ?? v.lastDriver;
    // The player's own (now empty) car hitting him is an accident, not an attack.
    const attacker = driver && driver.isPlayer && driver !== c ? driver : null;
    this.combat.damageCharacter(c, dmg, attacker, 'vehicle', v.vel.x / vs, 0, v.vel.z / vs);
    v.vel.x *= 0.96;
    v.vel.z *= 0.96;
    this.events.emit('impact', { x: c.pos.x, y: c.pos.y + 1, z: c.pos.z, strength: 2 + relSpeed * 0.2, vehicle: v });
    // damageCharacter already reported assaultCop (or a kill) for officers.
    if (attacker && c.alive && !c.isLaw) this.wanted.crime('hitPed', c.pos.x, c.pos.z);
    this.peds.onViolence(c.pos.x, c.pos.z, attacker, 18);
  }

  onCharacterLanded(c: Character, fallSpeed: number): void {
    if (fallSpeed > 13 && c.alive) this.combat.damageCharacter(c, (fallSpeed - 13) * 9, null, 'fall', 0, -1, 0);
  }

  onCharacterSplash(c: Character): void {
    this.events.emit('splash', { x: c.pos.x, y: WATER_Y, z: c.pos.z, big: false });
  }

  onHorn(v: Vehicle): void {
    v.hornTimer = 0.45;
    this.events.emit('horn', { vehicle: v });
  }

  // ---------------------------------------------------------------------------
  // Main loop

  update(dt: number, input: PlayerInput): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.frame++;
    this.clock.update(dt);
    this.progress.stats.playTime += dt;
    this.lastInput = input;
    this.cam.x = input.aimOrigin.x;
    this.cam.y = input.aimOrigin.y;
    this.cam.z = input.aimOrigin.z;
    this.camDir.x = input.aimDir.x;
    this.camDir.y = input.aimDir.y;
    this.camDir.z = input.aimDir.z;
    if (this.controlLock > 0) this.controlLock = Math.max(0, this.controlLock - dt);

    this.playerCtl.update(dt, input);
    for (const v of this.vehicles) {
      if (v.ai && v.driver && !v.driver.isPlayer && v.driver.alive) v.ai.update(dt);
    }
    this.peds.updateAI(dt);
    this.police.update(dt);

    const steps = Math.max(1, Math.ceil(dt / PHYSICS_STEP - 1e-6));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      for (const v of this.vehicles) stepVehicle(v, h, this);
      for (const v of this.vehicles) collideVehicleStatic(v, this);
      collideVehicles(this.vehicles, this);
      for (const v of this.vehicles) collideVehicleStatic(v, this);
      for (const c of this.characters) stepCharacter(c, h, this);
      collideCharactersVehicles(this.characters, this.vehicles, this);
      collideCharacters(this.characters);
      for (const c of this.characters) collideCharacterStatic(c, this.world);
    }
    for (const c of this.characters) if (c.vehicle && c.state === 'inVehicle') this.syncOccupant(c);

    this.combat.update(dt);
    this.updateTimers(dt);
    this.wanted.update(dt);
    if (this.ambient) {
      this.traffic.updateStreaming(dt);
      this.peds.updateStreaming(dt);
    }
    this.pickupSys.update(dt);
    this.interactions.update(dt);
    this.activities.update(dt);
    this.missions.update(dt);
    this.runTimers();
    this.updateDeath(dt);
    this.compact();
    this.sanitize();
  }

  private runTimers(): void {
    if (this.timers.length === 0) return;
    const due = this.timers.filter((t) => t.at <= this.time);
    if (due.length === 0) return;
    for (let i = this.timers.length - 1; i >= 0; i--) if (this.timers[i]!.at <= this.time) this.timers.splice(i, 1);
    for (const t of due) t.fn();
  }

  private updateTimers(dt: number): void {
    for (const c of this.characters) {
      if (c.removed) continue;
      if (c.shotTimer > 0) c.shotTimer -= dt;
      if (c.aimHold > 0) c.aimHold -= dt;
      if (c.punchTimer > 0) c.punchTimer -= dt;
      if (c.fireCooldown > 0) c.fireCooldown -= dt;
      if (c.hurtTimer > 0) c.hurtTimer -= dt;
      if (c.meleeComboTimer > 0) {
        c.meleeComboTimer -= dt;
        if (c.meleeComboTimer <= 0) c.staggerHits = 0;
      }
      if (c.reloadTimer > 0) {
        c.reloadTimer -= dt;
        if (c.reloadTimer <= 0) this.combat.finishReload(c);
      }
      if (c.state === 'knocked') {
        c.knockTimer -= dt;
        // A knock ends on the ground; the time cap makes sure no hovering body stays knocked forever.
        if (c.knockTimer <= 0 && (c.onGround || c.knockTimer < -3)) {
          c.state = 'normal';
          c.vel.x = 0;
          c.vel.z = 0;
        }
      } else if (c.state === 'dead') {
        c.deadTime += dt;
      }
    }
    for (const v of this.vehicles) {
      if (v.destroyed) v.wreckTime += dt;
      if (v.inWater && v.sinkTimer > 4 && !v.destroyed) {
        v.destroyed = true;
        v.health = 0;
      }
      // A repair (Spray Shack, FIXMYRIDE) raises health back to full: the dents go with the damage. Health alone is no
      // sign: some cars start above full health (vigilante suspects) and keep it through their first dents.
      const seen = this.healthSeen.get(v);
      if (v.dents.length > 0 && seen !== undefined && v.health > seen && v.health >= v.spec.health) {
        v.dents.length = 0;
        v.dentVersion++;
      }
      this.healthSeen.set(v, v.health);
    }
  }

  // ---------------------------------------------------------------------------
  // Wasted / busted

  playerDied(): void {
    if (this.deathKind) return;
    this.deathKind = 'wasted';
    this.deathTimer = 0;
    this.progress.stats.timesWasted++;
    this.events.emit('wasted', {});
    this.events.emit('big', { text: 'WASTED', sub: '', style: 'wasted', duration: 4.5 });
    this.missions.onPlayerDown('wasted');
    this.activities.cancelAll('wasted');
  }

  bustPlayer(): void {
    if (this.deathKind || !this.player.alive) return;
    this.deathKind = 'busted';
    this.deathTimer = 0;
    this.progress.stats.timesBusted++;
    if (this.player.vehicle) this.playerCtl.ejectPlayer(false);
    this.player.vel.x = 0;
    this.player.vel.z = 0;
    this.events.emit('busted', {});
    this.events.emit('big', { text: 'BUSTED', sub: '', style: 'busted', duration: 4.5 });
    this.missions.onPlayerDown('busted');
    this.activities.cancelAll('busted');
  }

  get playerDown(): boolean {
    return this.deathKind !== null;
  }

  private updateDeath(dt: number): void {
    if (!this.deathKind) return;
    this.deathTimer += dt;
    if (this.deathTimer < 4.8) return;
    const busted = this.deathKind === 'busted';
    const poi = this.world.layout.pois.find((p) => p.id === (busted ? 'police' : 'hospital'))!;
    const p = this.player;
    if (p.vehicle) this.unseat(p);
    p.state = 'normal';
    p.health = p.maxHealth;
    if (busted) {
      p.inventory.clear();
    } else {
      p.armor = 0;
    }
    p.knockTimer = 0;
    p.deadTime = 0;
    p.vel.x = 0;
    p.vel.y = 0;
    p.vel.z = 0;
    const spot = this.world.findFreeSpot(poi.x, poi.z, 0.5, 10) ?? { x: poi.x, z: poi.z };
    p.pos.x = spot.x;
    p.pos.z = spot.z;
    p.pos.y = this.world.groundHeight(spot.x, spot.z);
    p.heading = poi.heading;
    p.onGround = true;
    const fee = this.progress.charge(100);
    this.wanted.clear();
    this.police.dismissAll();
    this.deathKind = null;
    this.deathTimer = -1;
    this.clock.advance(busted ? 12 / 60 : 6);
    this.events.emit('respawn', { where: busted ? 'police' : 'hospital' });
    if (fee > 0) this.events.emit('money', { amount: -fee });
    this.events.emit('message', { text: busted ? `Bail paid: $${fee}. Your weapons were confiscated.` : `Hospital bill: $${fee}.`, duration: 5 });
  }

  /** Guards against numerical blow-ups: anything non-finite is repaired. */
  private sanitize(): void {
    for (const v of this.vehicles) {
      if (!Number.isFinite(v.pos.x + v.pos.y + v.pos.z + v.vel.x + v.vel.z + v.heading + v.angVel + v.vy)) {
        const lane = this.roads.nearestLane(Number.isFinite(v.pos.x) ? v.pos.x : 0, Number.isFinite(v.pos.z) ? v.pos.z : 0).lane;
        v.pos.x = lane.sx;
        v.pos.z = lane.sz;
        v.pos.y = this.world.groundHeight(lane.sx, lane.sz);
        v.vel.x = 0;
        v.vel.z = 0;
        v.vy = 0;
        v.angVel = 0;
        v.heading = lane.heading;
        v.airborne = false;
        v.pitch = 0;
        v.roll = 0;
        v.pitchVel = 0;
        v.rollVel = 0;
      }
      // Smoothed and derived values never recover from NaN on their own (damp/moveTowards keep it),
      // and the renderer and audio read them.
      if (!Number.isFinite(v.rpm)) v.rpm = 0;
      if (!Number.isFinite(v.steer)) v.steer = 0;
      if (!Number.isFinite(v.speed)) v.speed = 0;
      if (!Number.isFinite(v.forwardSpeed)) v.forwardSpeed = 0;
      if (!Number.isFinite(v.climbRate)) v.climbRate = 0;
      if (!Number.isFinite(v.skid)) v.skid = 0;
      if (!Number.isFinite(v.wheelSpin)) v.wheelSpin = 0;
      const ctl = v.controls;
      if (!Number.isFinite(ctl.throttle)) ctl.throttle = 0;
      if (!Number.isFinite(ctl.brake)) ctl.brake = 0;
      if (!Number.isFinite(ctl.steer)) ctl.steer = 0;
    }
    for (const c of this.characters) {
      if (!Number.isFinite(c.pos.x + c.pos.y + c.pos.z + c.vel.x + c.vel.y + c.vel.z + c.heading)) {
        const home = this.world.layout.pois.find((p) => p.id === 'hospital')!;
        c.pos.x = home.x;
        c.pos.z = home.z;
        c.pos.y = this.world.groundHeight(home.x, home.z);
        c.vel.x = 0;
        c.vel.y = 0;
        c.vel.z = 0;
        c.heading = 0;
      }
      c.health = clamp(c.health, -1000, c.maxHealth);
    }
  }
}
