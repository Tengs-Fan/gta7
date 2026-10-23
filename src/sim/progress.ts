// Persistent player progress (money, story, collectibles, statistics) and its
// (de)serialisation. Validation is strict: corrupted saves never crash the game.

import { parseExt } from './saveExt';
import { WEAPONS, type WeaponId } from './specs';
import { STREET_RUN_IDS, type StreetRunId, type StreetRunMedal } from './streetRuns';

export interface StreetRunRecord {
  bestTime: number;
  medal: StreetRunMedal;
  finishes: number;
}

export type StreetRunRecords = Partial<Record<StreetRunId, StreetRunRecord>>;

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
  streetRuns: StreetRunRecords = {};
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

/** The most rounds Inventory.give keeps in a gun's reserve (entities.ts); its magazine holds more on top. */
const RESERVE_CAP = 9999;

export interface SaveData {
  version: number;
  savedAt: number;
  money: number;
  missionsDone: string[];
  packages: number[];
  stunts: number[];
  rampages: string[];
  /** Added without bumping the save version: old saves simply have no records. */
  streetRuns?: StreetRunRecords;
  stats: Stats;
  weapons: Array<{ id: WeaponId; ammo: number }>;
  armor: number;
  hours: number;
  day: number;
  /** Per-module state by codec key (sim/saveExt.ts). Added without bumping the save version: old saves have none. */
  ext?: Record<string, unknown>;
}

export function serialize(p: Progress, weapons: Array<{ id: WeaponId; ammo: number }>, armor: number, hours: number, day: number, ext?: Record<string, unknown>): SaveData {
  const data: SaveData = {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    money: p.money,
    missionsDone: [...p.missionsDone],
    packages: [...p.packages],
    stunts: [...p.stunts],
    rampages: [...p.rampages],
    streetRuns: copyRunRecords(p.streetRuns),
    stats: { ...p.stats },
    weapons: weapons.map((w) => ({ ...w })),
    armor,
    hours,
    day,
  };
  if (ext) data.ext = ext;
  return data;
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

/** Only authored ids and finite, complete records enter persistent progress. */
function copyRunRecords(raw: unknown): StreetRunRecords {
  const result: StreetRunRecords = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const id of STREET_RUN_IDS) {
    if (!Object.hasOwn(raw, id)) continue;
    const value = (raw as Record<string, unknown>)[id];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.bestTime !== 'number' || !Number.isFinite(entry.bestTime) || entry.bestTime <= 0 || entry.bestTime > 3600) continue;
    if (entry.medal !== 'gold' && entry.medal !== 'silver' && entry.medal !== 'bronze') continue;
    result[id] = { bestTime: entry.bestTime, medal: entry.medal, finishes: Math.floor(num(entry.finishes, 1, 1e9, 1)) };
  }
  return result;
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
      // Own keys only: 'toString' is `in` every object.
      if (typeof id !== 'string' || !Object.hasOwn(WEAPONS, id) || id === 'fists') continue;
      // A save holds a gun's total: its capped reserve plus the magazine loaded on top of it.
      const max = RESERVE_CAP + WEAPONS[id as WeaponId].mag;
      weapons.push({ id: id as WeaponId, ammo: Math.floor(num((w as Record<string, unknown>).ammo, 0, max, 0)) });
    }
  }
  const save: SaveData = {
    version: SAVE_VERSION,
    savedAt: num(o.savedAt, 0, 1e15, 0),
    money: Math.floor(num(o.money, 0, 999_999_999, 0)),
    missionsDone: strArray(o.missionsDone),
    packages: numArray(o.packages),
    stunts: numArray(o.stunts),
    rampages: strArray(o.rampages),
    streetRuns: copyRunRecords(o.streetRuns),
    stats,
    weapons,
    armor: num(o.armor, 0, 100, 0),
    hours: num(o.hours, 0, 23.99, 12),
    day: Math.floor(num(o.day, 1, 1e6, 1)),
  };
  const ext = parseExt(o.ext);
  if (ext) save.ext = ext;
  return save;
}

export function applySave(p: Progress, s: SaveData): void {
  p.money = s.money;
  p.missionsDone = [...s.missionsDone];
  p.packages = [...s.packages];
  p.stunts = [...s.stunts];
  p.rampages = [...s.rampages];
  p.streetRuns = copyRunRecords(s.streetRuns);
  p.stats = { ...s.stats };
}
