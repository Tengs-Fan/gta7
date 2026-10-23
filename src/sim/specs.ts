// Static gameplay data: vehicles and weapons.

import type { V3 } from '../core/math';

/** Per-kind engine character for the player's engine voice (audio/engineVoice.ts) and horn. */
export interface EngineProfile {
  cylinders: number;
  idleRpm: number;
  redlineRpm: number;
  /** 0..1: how sharp the firing pulses are and how far the throttle opens the low-pass. */
  brightness: number;
  /** 0..1: cylinder-to-cylinder variation of the firing pulses (a lumpy, uneven idle). */
  roughness: number;
  /** Engine level in dB relative to a sedan. */
  loudness: number;
  /** The two horn notes in Hz. */
  horn: readonly [number, number];
  /** Cross-plane V8 burble: alternate firing pulses are weaker and late, which adds a strong component at half the firing frequency. */
  uneven?: boolean;
  /** Diesel knock: a sharp click on every firing pulse. */
  diesel?: boolean;
}

export const DEFAULT_HORN: readonly [number, number] = [392, 494];

/**
 * The riot van's gun ports: windows in the sides of its windowless back, for the crew in its rear seats, as fractions of
 * its length (ahead of the centre) and of its height. VehicleView cuts them; windowMuzzle fires from their middle.
 */
export const GUN_PORT = { z0: -0.24, z1: -0.07, y0: 0.6, y1: 0.8 } as const;

export type VehicleKind = 'compact' | 'sedan' | 'taxi' | 'sports' | 'muscle' | 'pickup' | 'van' | 'bus' | 'police' | 'swat';

export interface VehicleSpec {
  kind: VehicleKind;
  name: string;
  length: number;
  width: number;
  height: number;
  mass: number;
  /** Peak engine acceleration (m/s^2) at low speed. */
  accel: number;
  maxSpeed: number;
  reverseSpeed: number;
  /** Braking deceleration (m/s^2). */
  brake: number;
  /** Lateral tyre grip (m/s^2). */
  grip: number;
  /** Maximum steering angle at standstill (rad). */
  steer: number;
  health: number;
  seats: number;
  colors: readonly number[];
  police: boolean;
  /** Price-like value for stats and Spray Shack flavour text. */
  value: number;
  /** Multiplier on crash and landing damage and on dent depth: below 1 sturdier, above 1 more fragile. */
  durability: number;
  /** Visual body roll and pitch (lean) multipliers: tall, soft vehicles lean more. */
  rollGain: number;
  pitchGain: number;
  /** What the vehicle is; systems that treat cars, bikes and boats differently branch on this, not on the kind. */
  class: 'car' | 'bike' | 'boat';
  /** Engine voice and horn (audio); a kind without one sounds like DEFAULT_ENGINE_PROFILE. */
  engine?: EngineProfile;
  /**
   * Where along the vehicle its front and rear rows of seats fire from, as a fraction of its length ahead of its centre
   * (see firingRow in pose.ts); a kind without it fires from its centre ([0, 0]).
   */
  firingRows?: readonly [number, number];
}

const CIVIL_COLORS = [0xb03a2e, 0x1f618d, 0x117a65, 0xd4ac0d, 0xeeeeee, 0x1c1c1c, 0x7f8c8d, 0x6c3483, 0xca6f1e, 0x2e4053, 0x922b21, 0xa9cce3, 0x5d6d7e, 0x186a3b];

export const VEHICLE_SPECS: Readonly<Record<VehicleKind, VehicleSpec>> = {
  compact: { kind: 'compact', name: 'Pipsqueak', length: 3.8, width: 1.75, height: 1.45, mass: 950, accel: 9.5, maxSpeed: 37, reverseSpeed: 9, brake: 17, grip: 21, steer: 0.62, health: 700, seats: 2, colors: CIVIL_COLORS, police: false, value: 9000, durability: 1.1, rollGain: 1, pitchGain: 1, class: 'car', engine: { cylinders: 3, idleRpm: 900, redlineRpm: 6500, brightness: 0.65, roughness: 0.35, loudness: -3, horn: [466, 587] } },
  sedan: { kind: 'sedan', name: 'Velora', length: 4.7, width: 1.9, height: 1.45, mass: 1400, accel: 10.5, maxSpeed: 42, reverseSpeed: 10, brake: 17, grip: 21, steer: 0.6, health: 900, seats: 4, colors: CIVIL_COLORS, police: false, value: 18000, durability: 1, rollGain: 1, pitchGain: 1, class: 'car', engine: { cylinders: 4, idleRpm: 800, redlineRpm: 6500, brightness: 0.5, roughness: 0.12, loudness: -1.5, horn: DEFAULT_HORN }, firingRows: [0, -0.135] },
  taxi: { kind: 'taxi', name: 'Azura Cab', length: 4.7, width: 1.9, height: 1.45, mass: 1450, accel: 10.5, maxSpeed: 42, reverseSpeed: 10, brake: 17, grip: 21, steer: 0.6, health: 950, seats: 4, colors: [0xf4c20d], police: false, value: 16000, durability: 1, rollGain: 1, pitchGain: 1, class: 'car', engine: { cylinders: 4, idleRpm: 800, redlineRpm: 6500, brightness: 0.5, roughness: 0.15, loudness: -1.5, horn: DEFAULT_HORN }, firingRows: [0, -0.135] },
  sports: { kind: 'sports', name: 'Nightjar GT', length: 4.5, width: 2.0, height: 1.18, mass: 1300, accel: 15.5, maxSpeed: 60, reverseSpeed: 11, brake: 21, grip: 27, steer: 0.56, health: 800, seats: 2, colors: [0xc0392b, 0xf1c40f, 0x1c1c1c, 0xffffff, 0x2874a6, 0x27ae60, 0xe67e22], police: false, value: 140000, durability: 1.3, rollGain: 0.6, pitchGain: 0.6, class: 'car', engine: { cylinders: 6, idleRpm: 900, redlineRpm: 8500, brightness: 0.85, roughness: 0.08, loudness: 0, horn: [440, 554] } },
  muscle: { kind: 'muscle', name: 'Thunderhoof', length: 4.9, width: 2.0, height: 1.35, mass: 1650, accel: 13.5, maxSpeed: 54, reverseSpeed: 11, brake: 18, grip: 20, steer: 0.58, health: 1000, seats: 2, colors: [0x922b21, 0x1a5276, 0x1c1c1c, 0xd35400, 0xf7f9f9, 0x145a32], police: false, value: 45000, durability: 0.95, rollGain: 0.9, pitchGain: 0.9, class: 'car', engine: { cylinders: 8, idleRpm: 700, redlineRpm: 6000, brightness: 0.55, roughness: 0.3, loudness: 1, horn: [349, 440], uneven: true } },
  pickup: { kind: 'pickup', name: 'Dustrunner', length: 5.3, width: 2.1, height: 1.85, mass: 2100, accel: 9.5, maxSpeed: 40, reverseSpeed: 9, brake: 16, grip: 20, steer: 0.58, health: 1300, seats: 2, colors: CIVIL_COLORS, police: false, value: 26000, durability: 0.75, rollGain: 1.6, pitchGain: 1.3, class: 'car', engine: { cylinders: 8, idleRpm: 650, redlineRpm: 5200, brightness: 0.4, roughness: 0.22, loudness: 0.5, horn: [330, 415] } },
  van: { kind: 'van', name: 'Breadbox', length: 5.1, width: 2.1, height: 2.4, mass: 2500, accel: 8, maxSpeed: 35, reverseSpeed: 8, brake: 15, grip: 18, steer: 0.58, health: 1400, seats: 2, colors: [0xf2f3f4, 0xd5d8dc, 0x2e86c1, 0x1e8449, 0xb9770e], police: false, value: 22000, durability: 0.8, rollGain: 1.6, pitchGain: 1.4, class: 'car', engine: { cylinders: 4, idleRpm: 600, redlineRpm: 3500, brightness: 0.35, roughness: 0.3, loudness: -0.5, horn: [311, 392], diesel: true }, firingRows: [0.24, 0.24] },
  bus: { kind: 'bus', name: 'Citybus', length: 11.5, width: 2.6, height: 3.2, mass: 9000, accel: 5.5, maxSpeed: 28, reverseSpeed: 6, brake: 12, grip: 15, steer: 0.55, health: 3000, seats: 1, colors: [0x2e86c1, 0xc0392b], police: false, value: 90000, durability: 0.4, rollGain: 1.6, pitchGain: 1.4, class: 'car', engine: { cylinders: 6, idleRpm: 550, redlineRpm: 2600, brightness: 0.3, roughness: 0.2, loudness: 1.5, horn: [220, 277], diesel: true } },
  police: { kind: 'police', name: 'Patrol Cruiser', length: 4.9, width: 2.0, height: 1.5, mass: 1650, accel: 14, maxSpeed: 52, reverseSpeed: 11, brake: 20, grip: 24, steer: 0.6, health: 1300, seats: 2, colors: [0x101820], police: true, value: 40000, durability: 0.7, rollGain: 0.9, pitchGain: 0.9, class: 'car', engine: { cylinders: 8, idleRpm: 750, redlineRpm: 6500, brightness: 0.6, roughness: 0.12, loudness: 0.5, horn: DEFAULT_HORN }, firingRows: [0, -0.138] },
  swat: { kind: 'swat', name: 'Riot Van', length: 5.8, width: 2.3, height: 2.6, mass: 3800, accel: 10, maxSpeed: 42, reverseSpeed: 8, brake: 15, grip: 19, steer: 0.55, health: 2600, seats: 4, colors: [0x1b2631], police: true, value: 80000, durability: 0.35, rollGain: 1.3, pitchGain: 1.2, class: 'car', engine: { cylinders: 6, idleRpm: 600, redlineRpm: 3200, brightness: 0.35, roughness: 0.25, loudness: 1, horn: [262, 330], diesel: true }, firingRows: [0.283, (GUN_PORT.z0 + GUN_PORT.z1) / 2] },
};

/** The engine of a kind with no `engine` of its own: the sedan's. */
export const DEFAULT_ENGINE_PROFILE: EngineProfile = { cylinders: 4, idleRpm: 800, redlineRpm: 6500, brightness: 0.5, roughness: 0.12, loudness: -1.5, horn: DEFAULT_HORN };

/** A kind with no firing rows of its own fires from the centre of the vehicle. */
const NO_ROWS: readonly [number, number] = [0, 0];

/** The spec of `kind`; undefined for a kind that has none (a lookup must not throw on a kind another module has not heard of). */
function vehicleSpecOf(kind: VehicleKind): VehicleSpec | undefined {
  return (VEHICLE_SPECS as Readonly<Partial<Record<VehicleKind, VehicleSpec>>>)[kind];
}

/** The engine voice of a vehicle kind (DEFAULT_ENGINE_PROFILE if its spec has none). */
export function engineProfileOf(kind: VehicleKind): EngineProfile {
  return vehicleSpecOf(kind)?.engine ?? DEFAULT_ENGINE_PROFILE;
}

/** The firing rows of a vehicle kind (see VehicleSpec.firingRows). */
export function firingRowsOf(kind: VehicleKind): readonly [number, number] {
  return vehicleSpecOf(kind)?.firingRows ?? NO_ROWS;
}

/** Weights for random civilian traffic. */
export const TRAFFIC_MIX: ReadonlyArray<readonly [VehicleKind, number]> = [
  ['sedan', 30],
  ['compact', 22],
  ['taxi', 10],
  ['pickup', 10],
  ['van', 9],
  ['muscle', 7],
  ['sports', 4],
  ['bus', 3],
];

export const PARKED_MIX: ReadonlyArray<readonly [VehicleKind, number]> = [
  ['sedan', 30],
  ['compact', 26],
  ['pickup', 12],
  ['muscle', 10],
  ['van', 8],
  ['sports', 7],
  ['taxi', 4],
];

/** Points on each weapon model (its own frame: +z along the barrel, +y up, +x left), in metres. */
export interface WeaponPoints {
  /** Barrel end, where shots leave from. */
  tip: V3;
  /** Centre of the trigger hand. */
  grip: V3;
  /** Centre of the supporting hand when aiming. */
  fore: V3;
  /** Butt end that sits in the shoulder (long guns) or rests on it (rocket launcher, the tube centre). */
  stock: V3;
  /** Where the off hand goes while reloading: the magazine, the shotgun's pump or the tube's rear. */
  reload: V3;
}

const P = (x: number, y: number, z: number): V3 => ({ x, y, z });

export type WeaponId = 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'rocket' | 'bat' | 'knife' | 'grenade' | 'molotov' | 'sniper';

/** How a weapon is used: swung (fists, bat, knife), fired (guns and the launcher) or thrown (grenade, molotov). */
export type WeaponKind = 'melee' | 'gun' | 'thrown';

/** A melee weapon's blow, beyond its spec's damage, rate and range. */
export interface MeleeSpec {
  /** Every hit on a man on his feet floors him (fists need three in a row). */
  knockdown?: boolean;
  /** A cut keeps bleeding: `dps` hit points a second for `seconds` after the hit. */
  bleed?: { dps: number; seconds: number };
  /**
   * Combo: a swing made within `gap` seconds of the last one being ready again chains on it, and is ready again after
   * `mul` of the full cooldown.
   */
  combo: { gap: number; mul: number };
}

/** A thrown weapon: how hard it leaves the hand, and what it does when it lands. */
export interface ThrownSpec {
  /** Launch speed (m/s) along the aim, tilted up by `loft` (rad). */
  speed: number;
  loft: number;
  /** Grenade: seconds from the throw to the blast, and the blast's radius (m); its damage is the spec's. */
  fuse?: number;
  blast?: number;
  /** Molotov: breaks on its first impact and sets the ground there alight. */
  fire?: boolean;
}

/** A scoped rifle: field-of-view divisors of its zoom levels (the first is where the scope starts), and its sway (rad). */
export interface ScopeSpec {
  zooms: readonly number[];
  sway: number;
}

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  slot: number;
  damage: number;
  /** Shots per second. */
  rate: number;
  mag: number;
  reload: number;
  /** Cone half-angle in radians. */
  spread: number;
  range: number;
  pellets: number;
  auto: boolean;
  projectile: boolean;
  /** Shop price for the weapon (includes one ammo pack) and per extra pack. */
  price: number;
  ammoPrice: number;
  ammoPack: number;
  /** Two handed weapons are held with both arms. */
  twoHanded: boolean;
  /** Damage multiplier of the player's head hits (NPC head hits use 2). */
  headMul: number;
  /** Muzzle flash size (m, across the star); a weapon without it flashes DEFAULT_FLASH_SIZE. */
  flashSize?: number;
  /** HUD icon, SVG markup; a weapon without one shows DEFAULT_WEAPON_ICON. */
  icon?: string;
  /**
   * Where it is held and where shots leave (sim/pose.ts), kept in step with the weapon geometry in render/crowd.ts (barrel
   * ends 0.21, 0.37, 0.75, 0.705, 0.775 m); a weapon without it is held like the pistol. Fists have none.
   */
  points?: WeaponPoints;
  /** How it is used; a weapon without one is a gun (fists are melee). */
  kind?: WeaponKind;
  melee?: MeleeSpec;
  thrown?: ThrownSpec;
  scope?: ScopeSpec;
}

export const WEAPONS: Readonly<Record<WeaponId, WeaponSpec>> = {
  fists: { id: 'fists', name: 'Fists', slot: 0, damage: 13, rate: 2.6, mag: 0, reload: 0, spread: 0, range: 1.7, pellets: 1, auto: false, projectile: false, price: 0, ammoPrice: 0, ammoPack: 0, twoHanded: false, headMul: 1, flashSize: 0, icon: '<svg viewBox="0 0 64 40"><path d="M18 10c0-3 2-5 5-5h16c4 0 7 3 7 7v6l4 2v9c0 4-3 7-7 7H25c-4 0-7-3-7-7z M24 10v8 M30 9v9 M36 9v9 M42 10v8" stroke="#222" stroke-width="1.5"/></svg>' },
  pistol: { id: 'pistol', name: 'Pistol', slot: 1, damage: 34, rate: 4, mag: 12, reload: 1.2, spread: 0.012, range: 120, pellets: 1, auto: false, projectile: false, price: 250, ammoPrice: 60, ammoPack: 48, twoHanded: false, headMul: 4, flashSize: 0.3, icon: '<svg viewBox="0 0 64 40"><path d="M8 10h42l4 4v4H30l-3 3h-5l-4 13H9l5-15-6-2z"/></svg>', points: { tip: P(0, 0, 0.21), grip: P(0, -0.065, 0.02), fore: P(0.03, -0.085, 0.005), stock: P(0, 0, -0.01), reload: P(0, -0.15, 0.02) } },
  smg: { id: 'smg', name: 'SMG', slot: 2, damage: 15, rate: 11, mag: 30, reload: 1.7, spread: 0.035, range: 90, pellets: 1, auto: true, projectile: false, price: 900, ammoPrice: 120, ammoPack: 120, twoHanded: true, headMul: 2.5, flashSize: 0.32, icon: '<svg viewBox="0 0 64 40"><path d="M4 13h46l6 3v4H38l-2 3h-6l-2 12h-7l2-12h-6l-3 8H8l3-10-7-2zM50 11h8v2h-8z"/></svg>', points: { tip: P(0, 0, 0.37), grip: P(0, -0.1, 0.06), fore: P(0, -0.075, 0.25), stock: P(0, -0.01, -0.05), reload: P(0, -0.15, 0.2) } },
  shotgun: { id: 'shotgun', name: 'Shotgun', slot: 3, damage: 13, rate: 1.15, mag: 6, reload: 2.3, spread: 0.075, range: 42, pellets: 9, auto: false, projectile: false, price: 1400, ammoPrice: 140, ammoPack: 24, twoHanded: true, headMul: 1.5, flashSize: 0.55, icon: '<svg viewBox="0 0 64 40"><path d="M2 15h48l10 1v3H40l-4 2H26l-8 9H8l7-10H2z"/></svg>', points: { tip: P(0, 0, 0.75), grip: P(0, -0.07, 0.05), fore: P(0, -0.055, 0.31), stock: P(0, -0.04, -0.245), reload: P(0, -0.055, 0.3) } },
  rifle: { id: 'rifle', name: 'Assault Rifle', slot: 4, damage: 32, rate: 7, mag: 30, reload: 2.0, spread: 0.018, range: 180, pellets: 1, auto: true, projectile: false, price: 3500, ammoPrice: 200, ammoPack: 120, twoHanded: true, headMul: 4, flashSize: 0.4, icon: '<svg viewBox="0 0 64 40"><path d="M2 14h52l8 2v3H44l-3 3h-5l-2 10h-6l2-10h-5l-5 9h-8l5-10H2z M30 12h8v2h-8z"/></svg>', points: { tip: P(0, 0, 0.705), grip: P(0, -0.1, 0.06), fore: P(0, -0.065, 0.29), stock: P(0, -0.03, -0.25), reload: P(0, -0.2, 0.12) } },
  rocket: { id: 'rocket', name: 'Rocket Launcher', slot: 5, damage: 420, rate: 0.7, mag: 1, reload: 2.2, spread: 0.004, range: 260, pellets: 1, auto: false, projectile: true, price: 8000, ammoPrice: 900, ammoPack: 4, twoHanded: true, headMul: 1, flashSize: 0.6, icon: '<svg viewBox="0 0 64 40"><path d="M2 14h50l8 4-8 4H2z M18 22h6l2 10h-6z M34 22h5l1 6h-5z"/></svg>', points: { tip: P(0, 0.08, 0.775), grip: P(0, -0.075, 0.1), fore: P(0, -0.02, 0.32), stock: P(0, 0.08, 0.2), reload: P(0, 0.06, -0.36) } },
  // Melee weapons and throwables keep no magazine: a melee weapon's ammo means nothing, a throwable's is how many are left.
  bat: { id: 'bat', name: 'Baseball Bat', slot: 6, damage: 30, rate: 1.5, mag: 0, reload: 0, spread: 0, range: 2.0, pellets: 1, auto: false, projectile: false, price: 100, ammoPrice: 0, ammoPack: 1, twoHanded: false, headMul: 1, flashSize: 0, kind: 'melee', melee: { knockdown: true, combo: { gap: 0.6, mul: 0.6 } }, icon: '<svg viewBox="0 0 64 40"><path d="M6 25l40-12c4-1 9-1 12 1 2 2 1 5-2 6L16 30c-3 1-6 1-8 0z M4 26l4 4-3 2-3-3z"/></svg>' },
  knife: { id: 'knife', name: 'Combat Knife', slot: 6, damage: 20, rate: 2.4, mag: 0, reload: 0, spread: 0, range: 1.5, pellets: 1, auto: false, projectile: false, price: 180, ammoPrice: 0, ammoPack: 1, twoHanded: false, headMul: 1, flashSize: 0, kind: 'melee', melee: { bleed: { dps: 6, seconds: 4 }, combo: { gap: 0.5, mul: 0.55 } }, icon: '<svg viewBox="0 0 64 40"><path d="M4 22h18v-5h4v5h4c12 0 22-6 30-12-4 9-14 18-30 18h-4v4h-4v-4H4z"/></svg>' },
  grenade: { id: 'grenade', name: 'Grenade', slot: 7, damage: 330, rate: 1.1, mag: 0, reload: 0, spread: 0, range: 40, pellets: 1, auto: false, projectile: false, price: 600, ammoPrice: 450, ammoPack: 4, twoHanded: false, headMul: 1, flashSize: 0, kind: 'thrown', thrown: { speed: 15, loft: 0.3, fuse: 3, blast: 7 }, icon: '<svg viewBox="0 0 64 40"><path d="M32 12c8 0 13 6 13 13s-5 12-13 12-13-5-13-12 5-13 13-13z M27 6h10v5H27z M37 7l8-3 1 3-8 3z"/></svg>' },
  molotov: { id: 'molotov', name: 'Molotov Cocktail', slot: 7, damage: 0, rate: 1.1, mag: 0, reload: 0, spread: 0, range: 40, pellets: 1, auto: false, projectile: false, price: 400, ammoPrice: 300, ammoPack: 4, twoHanded: false, headMul: 1, flashSize: 0, kind: 'thrown', thrown: { speed: 14, loft: 0.3, fire: true }, icon: '<svg viewBox="0 0 64 40"><path d="M28 4h8v9c5 3 7 7 7 12v11H21V25c0-5 2-9 7-12z M30 0c3 1 4 3 2 5-2-1-3-3-2-5z"/></svg>' },
  sniper: { id: 'sniper', name: 'Sniper Rifle', slot: 8, damage: 120, rate: 0.8, mag: 5, reload: 2.6, spread: 0.0015, range: 320, pellets: 1, auto: false, projectile: false, price: 6500, ammoPrice: 400, ammoPack: 20, twoHanded: true, headMul: 5, flashSize: 0.45, scope: { zooms: [4, 8], sway: 0.0022 }, icon: '<svg viewBox="0 0 64 40"><path d="M0 16h56l8 1v2H38l-3 2h-5l-4 9h-8l4-9h-5l-6 8H3l5-9H0z M22 10h14v4H22z"/></svg>', points: { tip: P(0, 0, 1.02), grip: P(0, -0.1, 0.06), fore: P(0, -0.06, 0.36), stock: P(0, -0.03, -0.27), reload: P(0, -0.16, 0.14) } },
};

/** Muzzle flash of a weapon with no `flashSize` of its own (m across). */
export const DEFAULT_FLASH_SIZE = 0.3;
/** HUD icon of a weapon with no `icon` of its own: a plain pistol-like silhouette. */
export const DEFAULT_WEAPON_ICON = '<svg viewBox="0 0 64 40"><path d="M8 10h42l4 4v4H30l-3 3h-5l-4 13H9l5-15-6-2z"/></svg>';

function weaponSpecOf(id: WeaponId): WeaponSpec | undefined {
  return (WEAPONS as Readonly<Partial<Record<WeaponId, WeaponSpec>>>)[id];
}

export function flashSizeOf(id: WeaponId): number {
  return weaponSpecOf(id)?.flashSize ?? DEFAULT_FLASH_SIZE;
}

export function weaponPointsOf(id: WeaponId): WeaponPoints {
  return weaponSpecOf(id)?.points ?? WEAPONS.pistol.points!;
}

export function weaponIconOf(id: WeaponId): string {
  return weaponSpecOf(id)?.icon ?? DEFAULT_WEAPON_ICON;
}

/** How a weapon is used (see WeaponSpec.kind): fists and any weapon with no spec of its own count as melee. */
export function weaponKindOf(id: WeaponId): WeaponKind {
  const s = weaponSpecOf(id);
  if (!s || id === 'fists') return 'melee';
  return s.kind ?? 'gun';
}

/** A gun (or the launcher): something aimed and fired from a barrel, posed and drawn as one. */
export function isGun(id: WeaponId): boolean {
  return weaponKindOf(id) === 'gun';
}

/**
 * The weapons in number-key order: key N selects WEAPON_ORDER[N - 1] (input/input.ts), and a weapon added to WEAPONS
 * gets the next key by being added here. Weapons that share a spec `slot` share the key of the first of them (see
 * weaponForKey): key 7 is the bat or the knife, key 8 a grenade or a molotov, key 9 the sniper rifle. Mutable so that
 * tests can add a fixture weapon at runtime.
 */
export const WEAPON_ORDER: WeaponId[] = ['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'rocket', 'bat', 'grenade', 'sniper', 'knife', 'molotov'];

/**
 * The weapon number key `index` (0 for key 1) draws for someone who owns `has` and holds `current`: WEAPON_ORDER[index]
 * and the weapons of its spec slot, in WEAPON_ORDER order; pressed again while one of them is in hand, the next one owned.
 * Null when he owns none of them.
 */
export function weaponForKey(index: number, has: (id: WeaponId) => boolean, current: WeaponId): WeaponId | null {
  const base = WEAPON_ORDER[index];
  if (!base) return null;
  const slot = weaponSpecOf(base)?.slot;
  const group = WEAPON_ORDER.filter((id) => id === base || (slot !== undefined && weaponSpecOf(id)?.slot === slot));
  const owned = group.filter(has);
  if (owned.length === 0) return null;
  const i = owned.indexOf(current);
  return i < 0 ? owned[0]! : owned[(i + 1) % owned.length]!;
}

/** How many number keys select weapons (input/input.ts reads keys 1-9). */
export function weaponKeyCount(): number {
  return Math.min(9, WEAPON_ORDER.length);
}
