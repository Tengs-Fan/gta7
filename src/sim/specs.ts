// Static gameplay data: vehicles and weapons.

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
  /** Multiplier on crash and landing damage (and dent depth): sturdy vehicles shrug off hits. */
  durability: number;
  /** Visual body roll and pitch (lean) multipliers: tall, soft vehicles lean more. */
  rollGain: number;
  pitchGain: number;
}

const CIVIL_COLORS = [0xb03a2e, 0x1f618d, 0x117a65, 0xd4ac0d, 0xeeeeee, 0x1c1c1c, 0x7f8c8d, 0x6c3483, 0xca6f1e, 0x2e4053, 0x922b21, 0xa9cce3, 0x5d6d7e, 0x186a3b];

export const VEHICLE_SPECS: Readonly<Record<VehicleKind, VehicleSpec>> = {
  compact: { kind: 'compact', name: 'Pipsqueak', length: 3.8, width: 1.75, height: 1.45, mass: 950, accel: 9.5, maxSpeed: 37, reverseSpeed: 9, brake: 17, grip: 21, steer: 0.62, health: 700, seats: 2, colors: CIVIL_COLORS, police: false, value: 9000, durability: 1.1, rollGain: 1, pitchGain: 1 },
  sedan: { kind: 'sedan', name: 'Velora', length: 4.7, width: 1.9, height: 1.45, mass: 1400, accel: 10.5, maxSpeed: 42, reverseSpeed: 10, brake: 17, grip: 21, steer: 0.6, health: 900, seats: 4, colors: CIVIL_COLORS, police: false, value: 18000, durability: 1, rollGain: 1, pitchGain: 1 },
  taxi: { kind: 'taxi', name: 'Azura Cab', length: 4.7, width: 1.9, height: 1.45, mass: 1450, accel: 10.5, maxSpeed: 42, reverseSpeed: 10, brake: 17, grip: 21, steer: 0.6, health: 950, seats: 4, colors: [0xf4c20d], police: false, value: 16000, durability: 1, rollGain: 1, pitchGain: 1 },
  sports: { kind: 'sports', name: 'Nightjar GT', length: 4.5, width: 2.0, height: 1.18, mass: 1300, accel: 15.5, maxSpeed: 60, reverseSpeed: 11, brake: 21, grip: 27, steer: 0.56, health: 800, seats: 2, colors: [0xc0392b, 0xf1c40f, 0x1c1c1c, 0xffffff, 0x2874a6, 0x27ae60, 0xe67e22], police: false, value: 140000, durability: 1.3, rollGain: 0.6, pitchGain: 0.6 },
  muscle: { kind: 'muscle', name: 'Thunderhoof', length: 4.9, width: 2.0, height: 1.35, mass: 1650, accel: 13.5, maxSpeed: 54, reverseSpeed: 11, brake: 18, grip: 20, steer: 0.58, health: 1000, seats: 2, colors: [0x922b21, 0x1a5276, 0x1c1c1c, 0xd35400, 0xf7f9f9, 0x145a32], police: false, value: 45000, durability: 0.95, rollGain: 0.9, pitchGain: 0.9 },
  pickup: { kind: 'pickup', name: 'Dustrunner', length: 5.3, width: 2.1, height: 1.85, mass: 2100, accel: 9.5, maxSpeed: 40, reverseSpeed: 9, brake: 16, grip: 20, steer: 0.58, health: 1300, seats: 2, colors: CIVIL_COLORS, police: false, value: 26000, durability: 0.75, rollGain: 1.6, pitchGain: 1.3 },
  van: { kind: 'van', name: 'Breadbox', length: 5.1, width: 2.1, height: 2.4, mass: 2500, accel: 8, maxSpeed: 35, reverseSpeed: 8, brake: 15, grip: 18, steer: 0.58, health: 1400, seats: 2, colors: [0xf2f3f4, 0xd5d8dc, 0x2e86c1, 0x1e8449, 0xb9770e], police: false, value: 22000, durability: 0.8, rollGain: 1.6, pitchGain: 1.4 },
  bus: { kind: 'bus', name: 'Citybus', length: 11.5, width: 2.6, height: 3.2, mass: 9000, accel: 5.5, maxSpeed: 28, reverseSpeed: 6, brake: 12, grip: 15, steer: 0.55, health: 3000, seats: 1, colors: [0x2e86c1, 0xc0392b], police: false, value: 90000, durability: 0.4, rollGain: 1.6, pitchGain: 1.4 },
  police: { kind: 'police', name: 'Patrol Cruiser', length: 4.9, width: 2.0, height: 1.5, mass: 1650, accel: 14, maxSpeed: 52, reverseSpeed: 11, brake: 20, grip: 24, steer: 0.6, health: 1300, seats: 2, colors: [0x101820], police: true, value: 40000, durability: 0.7, rollGain: 0.9, pitchGain: 0.9 },
  swat: { kind: 'swat', name: 'Riot Van', length: 5.8, width: 2.3, height: 2.6, mass: 3800, accel: 10, maxSpeed: 42, reverseSpeed: 8, brake: 15, grip: 19, steer: 0.55, health: 2600, seats: 4, colors: [0x1b2631], police: true, value: 80000, durability: 0.35, rollGain: 1.3, pitchGain: 1.2 },
};

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

export type WeaponId = 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'rocket';

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
}

export const WEAPONS: Readonly<Record<WeaponId, WeaponSpec>> = {
  fists: { id: 'fists', name: 'Fists', slot: 0, damage: 12, rate: 2.6, mag: 0, reload: 0, spread: 0, range: 1.7, pellets: 1, auto: false, projectile: false, price: 0, ammoPrice: 0, ammoPack: 0, twoHanded: false },
  pistol: { id: 'pistol', name: 'Pistol', slot: 1, damage: 34, rate: 4, mag: 12, reload: 1.2, spread: 0.012, range: 120, pellets: 1, auto: false, projectile: false, price: 250, ammoPrice: 60, ammoPack: 48, twoHanded: false },
  smg: { id: 'smg', name: 'SMG', slot: 2, damage: 15, rate: 11, mag: 30, reload: 1.7, spread: 0.035, range: 90, pellets: 1, auto: true, projectile: false, price: 900, ammoPrice: 120, ammoPack: 120, twoHanded: true },
  shotgun: { id: 'shotgun', name: 'Shotgun', slot: 3, damage: 13, rate: 1.15, mag: 6, reload: 2.3, spread: 0.075, range: 42, pellets: 9, auto: false, projectile: false, price: 1400, ammoPrice: 140, ammoPack: 24, twoHanded: true },
  rifle: { id: 'rifle', name: 'Assault Rifle', slot: 4, damage: 32, rate: 7, mag: 30, reload: 2.0, spread: 0.018, range: 180, pellets: 1, auto: true, projectile: false, price: 3500, ammoPrice: 200, ammoPack: 120, twoHanded: true },
  rocket: { id: 'rocket', name: 'Rocket Launcher', slot: 5, damage: 420, rate: 0.7, mag: 1, reload: 2.2, spread: 0.004, range: 260, pellets: 1, auto: false, projectile: true, price: 8000, ammoPrice: 900, ammoPack: 4, twoHanded: true },
};

export const WEAPON_ORDER: readonly WeaponId[] = ['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'rocket'];
