// Simulation entities. Plain mutable state; behaviour lives in the systems.

import type { V3 } from '../core/math';
import { Rng } from '../core/rng';
import type { DriverAI } from './driver';
import type { PedBrain } from './brains';
import type { PickupKind } from './pickups';
import { VEHICLE_SPECS, WEAPONS, type VehicleKind, type VehicleSpec, type WeaponId, type WeaponSpec } from './specs';

/**
 * A generator for an entity's own random choices (a helicopter's orbit, the tumble of an explosion
 * kick), seeded from its id (scrambled; the salt is arbitrary). The sim hands out ids in a fixed
 * order, so a run from the same seed with the same inputs repeats exactly, which Math.random would
 * not allow.
 */
export function entityRng(id: number): Rng {
  return new Rng(Math.imul(id, 0x9e3779b1) ^ 7);
}

export type CharacterRole = 'player' | 'civilian' | 'cop' | 'swat' | 'gang' | 'mission';

export type CharState = 'normal' | 'knocked' | 'dead' | 'inVehicle' | 'entering' | 'swimming';

/** Which system manages an entity's lifecycle (spawning / streaming out). */
export type Owner = 'none' | 'traffic' | 'parked' | 'ped' | 'police' | 'mission' | 'moored';

export interface Appearance {
  skin: number;
  shirt: number;
  pants: number;
  hair: number;
  /** 0 = none, otherwise a packed colour for a cap. */
  hat: number;
  height: number;
  build: number;
}

export interface WeaponSlot {
  /** Rounds in reserve (not counting the loaded magazine). */
  ammo: number;
  clip: number;
  /** Sim time from which this weapon can fire again; putting it away does not reset it. */
  readyAt: number;
}

export class Inventory {
  readonly slots = new Map<WeaponId, WeaponSlot>();
  current: WeaponId = 'fists';
  infinite = false;

  constructor() {
    this.slots.set('fists', { ammo: 0, clip: 0, readyAt: 0 });
  }

  has(id: WeaponId): boolean {
    return this.slots.has(id);
  }

  spec(): WeaponSpec {
    return WEAPONS[this.current];
  }

  slot(): WeaponSlot {
    return this.slots.get(this.current) ?? this.slots.get('fists')!;
  }

  give(id: WeaponId, ammo: number): void {
    const spec = WEAPONS[id];
    const s = this.slots.get(id);
    if (s) {
      s.ammo = Math.min(9999, s.ammo + ammo);
    } else {
      const clip = Math.min(spec.mag, ammo);
      this.slots.set(id, { ammo: Math.min(9999, ammo - clip), clip, readyAt: 0 });
    }
  }

  total(id: WeaponId): number {
    const s = this.slots.get(id);
    return s ? s.ammo + s.clip : 0;
  }

  /** Removes everything except fists. */
  clear(): void {
    this.slots.clear();
    this.slots.set('fists', { ammo: 0, clip: 0, readyAt: 0 });
    this.current = 'fists';
  }

  /** Weapon ids owned, in slot order. */
  owned(): WeaponId[] {
    return [...this.slots.keys()].sort((a, b) => WEAPONS[a].slot - WEAPONS[b].slot);
  }

  /** Selects the next/previous owned weapon that has ammunition (fists always qualify). */
  cycle(dir: 1 | -1): void {
    // Keep the current weapon even when it is empty, so stepping starts from its slot.
    const list = this.owned().filter((id) => id === this.current || id === 'fists' || this.total(id) > 0 || this.infinite);
    if (list.length === 0) return;
    const i = list.indexOf(this.current);
    const next = list[(i + dir + list.length) % list.length]!;
    this.current = next;
  }
}

export class Character {
  readonly pos: V3;
  readonly vel: V3 = { x: 0, y: 0, z: 0 };
  heading = 0;
  readonly radius = 0.35;
  height: number;
  health: number;
  maxHealth: number;
  armor = 0;
  state: CharState = 'normal';
  onGround = true;
  vehicle: Vehicle | null = null;
  seat = 0;
  readonly inventory = new Inventory();
  brain: PedBrain | null = null;
  owner: Owner = 'none';
  /** Mission and story characters are never streamed out. */
  persistent = false;
  missionTag = '';
  removed = false;

  // Locomotion / animation inputs (written by controllers, read by physics and renderer).
  moveX = 0;
  moveZ = 0;
  moveSpeed = 0;
  wantJump = false;
  speed = 0;
  animPhase = 0;
  /** Weapon raised: the aim button held, firing a gun, or aimHold > 0 (pose, turning to the aim, civilians cowering). */
  aiming = false;
  /** The aim button is held on foot (zoomed over-the-shoulder view, aimed walk speed, tighter spread). */
  aimZoom = false;
  /** Seconds a semi-automatic trigger press made just before the weapon was ready stays queued. */
  fireQueued = 0;
  aimPitch = 0;
  aimYaw = 0;
  punchTimer = 0;
  shotTimer = 0;
  /** Seconds to keep the aiming pose after the last shot. */
  aimHold = 0;
  reloadTimer = 0;
  /** Weapon the running reload is for; switching away from it cancels the reload. */
  reloadWeapon: WeaponId | null = null;
  /** Seconds until the weapon in hand can fire (or punch) again. */
  fireCooldown = 0;
  /** Weapon in hand when combat last checked; switching starts the swap time. Null until first checked. */
  drawnWeapon: WeaponId | null = null;
  knockTimer = 0;
  deadTime = 0;
  /** Seconds this character has been continuously in water deep enough to swim. */
  swimTime = 0;
  hurtTimer = 0;
  enterTimer = 0;
  enterTarget: Vehicle | null = null;
  lastAttacker: Character | null = null;
  lastAttackTime = -999;
  /** Who dealt the latest hit: null for one with no attacker (flames, a fall), unlike lastAttacker. */
  lastHitBy: Character | null = null;
  /** Money this character drops on death (civilians). */
  cash = 0;
  meleeCombo = 0;
  meleeComboTimer = 0;
  /** Counts consecutive hits for knock-downs from melee (blows to a man on his feet only). */
  staggerHits = 0;
  /** Seconds left of the moment after getting up from a knockdown in which blows do not count towards the next one. */
  getUpTimer = 0;

  constructor(
    readonly id: number,
    public role: CharacterRole,
    x: number,
    y: number,
    z: number,
    public appearance: Appearance,
  ) {
    this.pos = { x, y, z };
    this.height = 1.8 * appearance.height;
    this.maxHealth = role === 'player' ? 100 : role === 'swat' ? 150 : role === 'cop' ? 110 : 100;
    this.health = this.maxHealth;
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  get isPlayer(): boolean {
    return this.role === 'player';
  }

  get isLaw(): boolean {
    return this.role === 'cop' || this.role === 'swat';
  }

  /** Walking or swimming under its own control (not knocked down, dead, climbing in or seated). */
  get onFoot(): boolean {
    return this.state === 'normal' || this.state === 'swimming';
  }
}

export interface VehicleControls {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

/**
 * A dent in vehicle-local space: lz along the heading (front +), lx towards the driver side (local +X), ly up
 * from the ground. (nx, nz) is the horizontal inward direction the body is pushed in; a roof dent has a zero
 * normal and pushes straight down.
 */
export interface Dent {
  lx: number;
  ly: number;
  lz: number;
  nx: number;
  nz: number;
  depth: number;
}

export const MAX_DENTS = 8;

export class Vehicle {
  readonly spec: VehicleSpec;
  readonly pos: V3;
  readonly vel = { x: 0, z: 0 };
  vy = 0;
  heading: number;
  angVel = 0;
  pitch = 0;
  roll = 0;
  pitchVel = 0;
  rollVel = 0;
  readonly controls: VehicleControls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  /** Smoothed steering position, -1 (left) .. 1 (right). */
  steer = 0;
  health: number;
  burning = false;
  burnTimer = 0;
  destroyed = false;
  wreckTime = 0;
  flipped = false;
  airborne = false;
  airTime = 0;
  launchX = 0;
  launchZ = 0;
  launchRamp = -1;
  inWater = false;
  sinkTimer = 0;
  /**
   * Motorbikes (sim/bikePhysics.ts): lean into the turn (rad, positive to the right, the steer's sign), the front lifted
   * in a wheelie (rad, nose up), and lying on its side after a crash threw its rider off (until someone gets on again).
   */
  lean = 0;
  wheelie = 0;
  toppled = false;
  driver: Character | null = null;
  readonly passengers: (Character | null)[];
  ai: DriverAI | null = null;
  owner: Owner = 'none';
  siren = false;
  horn = false;
  hornTimer = 0;
  persistent = false;
  missionTag = '';
  removed = false;
  lastDriver: Character | null = null;
  /** Visual / audio helpers. */
  speed = 0;
  forwardSpeed = 0;
  wheelSpin = 0;
  skid = 0;
  rpm = 0;
  gear = 1;
  braking = false;
  reversing = false;
  climbRate = 0;
  impactTimer = 0;
  /** Crash damage the renderer shows as dents (at most MAX_DENTS); dentVersion changes with every change to it. */
  readonly dents: Dent[] = [];
  dentVersion = 0;
  /** Ever driven by the player (no longer counts as a parked car). */
  usedByPlayer = false;
  /** Azura Customs upgrade levels (0 = stock) and the multipliers on this car's spec they give (sim/mods.ts). */
  readonly mods = { engine: 0, brakes: 0, tyres: 0 };
  readonly tune = { accel: 1, brake: 1, grip: 1 };
  /** Seconds since the AI driver last got 5 m from where it was; waits at a red light, a yield or in a queue don't count. */
  stuckTime = 0;
  spawnTime = 0;
  /** This vehicle's own randomness (the tumble of explosion kicks), see entityRng. */
  readonly rng: Rng;

  constructor(
    readonly id: number,
    readonly kind: VehicleKind,
    x: number,
    y: number,
    z: number,
    heading: number,
    public color: number,
  ) {
    this.spec = VEHICLE_SPECS[kind];
    this.pos = { x, y, z };
    this.heading = heading;
    this.health = this.spec.health;
    this.passengers = new Array(Math.max(0, this.spec.seats - 1)).fill(null);
    this.rng = entityRng(id);
  }

  get halfW(): number {
    return this.spec.width / 2;
  }

  get halfL(): number {
    return this.spec.length / 2;
  }

  get inertia(): number {
    const s = this.spec;
    return (s.mass * (s.length * s.length + s.width * s.width)) / 12;
  }

  get drivable(): boolean {
    return !this.destroyed && !this.inWater && !this.flipped;
  }

  /** Health fraction 0..1. */
  get condition(): number {
    return Math.max(0, this.health) / this.spec.health;
  }

  occupants(): Character[] {
    const out: Character[] = [];
    if (this.driver) out.push(this.driver);
    for (const p of this.passengers) if (p) out.push(p);
    return out;
  }
}

export type { PickupKind };

export class Pickup {
  active = true;
  respawnTimer = 0;
  removed = false;
  /** Phase of the hover bob (cosmetic), so pickups next to each other do not bob in step. */
  readonly bob: number;
  /** Sim time at which a temporary pickup (dropped cash) disappears. */
  expires = Infinity;

  constructor(
    readonly id: number,
    readonly kind: PickupKind,
    readonly pos: V3,
    public amount: number,
    public weapon: WeaponId | null,
    /** Seconds until it reappears after collection; 0 = one-shot. */
    readonly respawn: number,
    /** Collectible / rampage identifier. */
    readonly tag: string,
  ) {
    this.bob = entityRng(id).range(0, 6);
  }
}

export class Projectile {
  removed = false;
  life = 6;
  constructor(
    readonly id: number,
    readonly pos: V3,
    readonly vel: V3,
    readonly owner: Character | null,
  ) {}
}

export class Helicopter {
  readonly pos: V3;
  readonly vel: V3 = { x: 0, y: 0, z: 0 };
  heading = 0;
  health = 1600;
  destroyed = false;
  crashing = false;
  removed = false;
  rotor = 0;
  fireCooldown = 2;
  /** Angle round the circle it flies above the target (police.ts advances it). */
  orbit: number;
  spotlight = { x: 0, z: 0 };
  /** The player whose fire or blast last hit it: the one who answers for bringing it down. */
  shotBy: Character | null = null;
  constructor(readonly id: number, x: number, y: number, z: number) {
    this.pos = { x, y, z };
    this.orbit = entityRng(id).range(0, Math.PI * 2);
  }
}
