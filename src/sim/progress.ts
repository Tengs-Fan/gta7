// Persistent player progress (money, story, collectibles, statistics) and its
// (de)serialisation. Validation is strict: corrupted saves never crash the game.

import { WEAPONS, type WeaponId } from './specs';

export interface Stats {
  kills: number;
  copsKilled: number;
  carsStolen: number;
  vehiclesDestroyed: number;
  shotsFired: number;
  headshots: number;
  distanceDriven: number;
  distanceOnFoot: number;
  maxWanted: number;
  timesWasted: number;
  timesBusted: number;
  moneyEarned: number;
  moneySpent: number;
  taxiFares: number;
  vigilanteLevel: number;
  stuntBonuses: number;
  bestStuntAir: number;
  playTime: number;
}

export function emptyStats(): Stats {
  return {
    kills: 0,
    copsKilled: 0,
    carsStolen: 0,
    vehiclesDestroyed: 0,
    shotsFired: 0,
    headshots: 0,
    distanceDriven: 0,
    distanceOnFoot: 0,
    maxWanted: 0,
    timesWasted: 0,
    timesBusted: 0,
    moneyEarned: 0,
    moneySpent: 0,
    taxiFares: 0,
    vigilanteLevel: 0,
    stuntBonuses: 0,
    bestStuntAir: 0,
    playTime: 0,
  };
}

export class Progress {
  money = 250;
  missionsDone: string[] = [];
  packages: number[] = [];
  stunts: number[] = [];
  rampages: string[] = [];
  stats: Stats = emptyStats();

  addMoney(amount: number): void {
    const a = Math.round(amount);
    if (!Number.isFinite(a)) return;
    this.money = Math.max(0, Math.min(999_999_999, this.money + a));
    if (a > 0) this.stats.moneyEarned += a;
  }

  /** Spends money if possible. */
  spend(amount: number): boolean {
    if (amount > this.money) return false;
    this.money -= amount;
    this.stats.moneySpent += amount;
    return true;
  }

  /** Takes up to `amount` (fees can leave you broke but never negative). */
  charge(amount: number): number {
    const taken = Math.min(this.money, Math.max(0, Math.round(amount)));
    this.money -= taken;
    this.stats.moneySpent += taken;
    return taken;
  }

  hasDone(id: string): boolean {
    return this.missionsDone.includes(id);
  }

  markDone(id: string): void {
    if (!this.missionsDone.includes(id)) this.missionsDone.push(id);
  }
}

export const SAVE_VERSION = 1;

export interface SaveData {
  version: number;
  savedAt: number;
  money: number;
  missionsDone: string[];
  packages: number[];
  stunts: number[];
  rampages: string[];
  stats: Stats;
  weapons: Array<{ id: WeaponId; ammo: number }>;
  armor: number;
  hours: number;
  day: number;
}

export function serialize(p: Progress, weapons: Array<{ id: WeaponId; ammo: number }>, armor: number, hours: number, day: number): SaveData {
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    money: p.money,
    missionsDone: [...p.missionsDone],
    packages: [...p.packages],
    stunts: [...p.stunts],
    rampages: [...p.rampages],
    stats: { ...p.stats },
    weapons: weapons.map((w) => ({ ...w })),
    armor,
    hours,
    day,
  };
}

function num(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

function strArray(v: unknown, max = 200): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length < 64).slice(0, max) : [];
}

function numArray(v: unknown, max = 200): number[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 1000))].slice(0, max) : [];
}

/** Parses untrusted save JSON. Returns null when it is unusable. */
export function parseSave(raw: unknown): SaveData | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== SAVE_VERSION) return null;
  const statsIn = (o.stats && typeof o.stats === 'object' ? o.stats : {}) as Record<string, unknown>;
  const stats = emptyStats();
  for (const k of Object.keys(stats) as Array<keyof Stats>) stats[k] = num(statsIn[k], 0, 1e12, 0);
  const weapons: Array<{ id: WeaponId; ammo: number }> = [];
  if (Array.isArray(o.weapons)) {
    for (const w of o.weapons) {
      if (!w || typeof w !== 'object') continue;
      const id = (w as Record<string, unknown>).id;
      if (typeof id !== 'string' || !(id in WEAPONS) || id === 'fists') continue;
      weapons.push({ id: id as WeaponId, ammo: Math.floor(num((w as Record<string, unknown>).ammo, 0, 9999, 0)) });
    }
  }
  return {
    version: SAVE_VERSION,
    savedAt: num(o.savedAt, 0, 1e15, 0),
    money: Math.floor(num(o.money, 0, 999_999_999, 0)),
    missionsDone: strArray(o.missionsDone),
    packages: numArray(o.packages),
    stunts: numArray(o.stunts),
    rampages: strArray(o.rampages),
    stats,
    weapons,
    armor: num(o.armor, 0, 100, 0),
    hours: num(o.hours, 0, 23.99, 12),
    day: Math.floor(num(o.day, 1, 1e6, 1)),
  };
}

export function applySave(p: Progress, s: SaveData): void {
  p.money = s.money;
  p.missionsDone = [...s.missionsDone];
  p.packages = [...s.packages];
  p.stunts = [...s.stunts];
  p.rampages = [...s.rampages];
  p.stats = { ...s.stats };
}
