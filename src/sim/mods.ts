// Azura Customs: engine, brakes and tyre upgrades and paint, one price table. Upgrades live on the vehicle instance
// (Vehicle.mods levels and the Vehicle.tune multipliers vehiclePhysics applies to its spec); VEHICLE_SPECS is never
// changed, so another car of the same kind drives as stock. Only a car stored in the garage keeps them through a save
// (properties.ts); any other car is gone after a reload, mods and all.

import type { Vehicle } from './entities';
import type { Progress } from './progress';

export type ModCategory = 'engine' | 'brakes' | 'tyres';
export const MOD_CATEGORIES: readonly ModCategory[] = ['engine', 'brakes', 'tyres'];
export const MAX_MOD_LEVEL = 3;

export interface ModRow {
  label: string;
  /** What each level does, for the shop. */
  effect: string;
  /** Price of level 1, 2 and 3. */
  prices: readonly [number, number, number];
  /** Multiplier on the spec at level 0..3: engine on accel, brakes on brake, tyres on grip. */
  multipliers: readonly [number, number, number, number];
}

export const MOD_TABLE: Readonly<Record<ModCategory, ModRow>> = {
  engine: { label: 'Engine', effect: 'acceleration', prices: [1500, 3500, 7000], multipliers: [1, 1.1, 1.2, 1.3] },
  brakes: { label: 'Brakes', effect: 'braking', prices: [800, 2000, 4000], multipliers: [1, 1.12, 1.24, 1.36] },
  tyres: { label: 'Tyres', effect: 'cornering grip', prices: [1000, 2500, 5000], multipliers: [1, 1.08, 1.16, 1.25] },
};

export const PAINT_PRICE = 300;
export const PAINT_COLORS: ReadonlyArray<{ name: string; color: number }> = [
  { name: 'Torch Red', color: 0xc0392b },
  { name: 'Sunburst Yellow', color: 0xf1c40f },
  { name: 'Lagoon Blue', color: 0x2874a6 },
  { name: 'Palm Green', color: 0x1e8449 },
  { name: 'Midnight Black', color: 0x1c1c1c },
  { name: 'Pearl White', color: 0xf2f3f4 },
  { name: 'Sunset Orange', color: 0xe67e22 },
  { name: 'Royal Purple', color: 0x6c3483 },
  { name: 'Gunmetal', color: 0x5d6d7e },
  { name: 'Hot Pink', color: 0xe84393 },
];

export interface ModLevels {
  engine: number;
  brakes: number;
  tyres: number;
}

/** Sets `v`'s tune multipliers from its mod levels. */
export function applyMods(v: Vehicle): void {
  v.tune.accel = MOD_TABLE.engine.multipliers[v.mods.engine]!;
  v.tune.brake = MOD_TABLE.brakes.multipliers[v.mods.brakes]!;
  v.tune.grip = MOD_TABLE.tyres.multipliers[v.mods.tyres]!;
}

/** Gives `v` these levels (each clamped to 0..MAX_MOD_LEVEL, a bad one as 0) and their multipliers. */
export function setMods(v: Vehicle, levels: Partial<ModLevels>): void {
  for (const c of MOD_CATEGORIES) v.mods[c] = cleanLevel(levels[c]);
  applyMods(v);
}

export function cleanLevel(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(MAX_MOD_LEVEL, Math.floor(n))) : 0;
}

/** Why Azura Customs turns `v` away, or null when it works on it. */
export function customsRefusal(v: Vehicle): string | null {
  if (v.spec.police) return "Azura Customs: we don't touch police vehicles.";
  if (v.missionTag) return "Azura Customs: that one's spoken for. Bring us your own ride.";
  if (v.destroyed || !v.drivable) return 'Azura Customs: that wreck is beyond us.';
  if (v.spec.class !== 'car') return 'Azura Customs: cars only.';
  return null;
}

/** The price of `v`'s next level in `cat`, or null when it is maxed. */
export function nextModPrice(v: Vehicle, cat: ModCategory): number | null {
  const lvl = v.mods[cat];
  return lvl >= MAX_MOD_LEVEL ? null : MOD_TABLE[cat].prices[lvl]!;
}

/** Buys the next level of `cat` for `v`: null on success, else why not (nothing changes then). */
export function buyMod(p: Progress, v: Vehicle, cat: ModCategory): string | null {
  const refusal = customsRefusal(v);
  if (refusal) return refusal;
  const price = nextModPrice(v, cat);
  if (price === null) return `${MOD_TABLE[cat].label} is fully upgraded.`;
  if (!p.spend(price)) return "You can't afford that.";
  v.mods[cat]++;
  applyMods(v);
  return null;
}

/** Paints `v` (PAINT_PRICE): null on success, else why not. */
export function buyPaint(p: Progress, v: Vehicle, color: number): string | null {
  const refusal = customsRefusal(v);
  if (refusal) return refusal;
  if (v.color === color) return 'It is already that colour.';
  if (!p.spend(PAINT_PRICE)) return "You can't afford that.";
  v.color = color;
  return null;
}
