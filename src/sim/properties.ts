// Properties: the garage across the street from the safehouse (stores up to GARAGE_SLOTS cars, with their colour and
// mods, through saves) and the Pier Arcade (BUSINESS_DAILY a full game day, collected at the safehouse marker, at most
// BUSINESS_CAP_DAYS days' worth waiting). Azura Customs, the mod shop, opens when a car stops in its bay. Ownership and
// takings are kept per Progress (per player slot) and saved in the save `ext` (GARAGE_KEY, BUSINESS_KEY); the stored
// cars are the vehicles standing in the garage, tracked per Sim. Only slot 0 owns properties for now.

import { formatMoney } from '../core/math';
import { rectContains } from '../world/layout';
import { places } from './activities/places';
import { registerCompletion } from './completion';
import { registerStatRow } from './statRows';
import type { Vehicle } from './entities';
import { applyMods, cleanLevel, customsRefusal, setMods, type ModLevels } from './mods';
import type { Progress } from './progress';
import { registerSaveCodec } from './saveExt';
import type { Sim } from './sim';
import { VEHICLE_SPECS, type VehicleKind } from './specs';
import { registerSystem } from './systems';

export const GARAGE_PRICE = 15000;
export const GARAGE_SLOTS = 4;
export const BUSINESS_NAME = 'Pier Arcade';
export const BUSINESS_PRICE = 25000;
export const BUSINESS_DAILY = 500;
export const BUSINESS_CAP_DAYS = 7;
export const GARAGE_KEY = 'garage';
export const BUSINESS_KEY = 'business';

export interface PropertyState {
  garage: boolean;
  business: boolean;
  /** Takings waiting at the safehouse. */
  uncollected: number;
  /** Game time (day * 24 + hours) the current day of takings started. */
  accrueFrom: number;
}

const owned = new WeakMap<Progress, PropertyState>();

export function propertyState(p: Progress): PropertyState {
  let s = owned.get(p);
  if (!s) {
    s = { garage: false, business: false, uncollected: 0, accrueFrom: 0 };
    owned.set(p, s);
  }
  return s;
}

/** Game hours since the start of day 1: what a full day of takings is counted on. */
export function gameHours(sim: Sim): number {
  return sim.clock.day * 24 + sim.clock.hours;
}

interface GarageRuntime {
  /** The cars standing in the garage, stored. */
  stored: Vehicle[];
  /** The car last judged at the garage (stored or refused): not judged again until the player is back in it or it leaves. */
  judged: Vehicle | null;
  /** The car last judged at Azura Customs' door: the screen opens once per stop in the bay. */
  customs: Vehicle | null;
  /** Whether the local player stood on the safehouse marker last frame (takings are paid on stepping onto it). */
  atHome: boolean;
  /** The vehicle slot 0 last got out of. */
  lastExit: Vehicle | null;
}

const runtime = new WeakMap<Sim, GarageRuntime>();

function rt(sim: Sim): GarageRuntime {
  let r = runtime.get(sim);
  if (!r) {
    const fresh: GarageRuntime = { stored: [], judged: null, customs: null, atHome: false, lastExit: null };
    sim.events.on('vehicleExit', (e) => {
      if (e.character === sim.player) fresh.lastExit = e.vehicle;
    });
    r = fresh;
    runtime.set(sim, r);
  }
  return r;
}

/** The cars stored in slot 0's garage. */
export function storedCars(sim: Sim): readonly Vehicle[] {
  return rt(sim).stored;
}

function inGarage(sim: Sim, v: Vehicle): boolean {
  return rectContains(places(sim.world).garageArea, v.pos.x, v.pos.z);
}

function say(sim: Sim, text: string, duration = 3): void {
  sim.events.emit('message', { text, duration });
}

/** Why the garage turns `v` away, or null. */
export function garageRefusal(v: Vehicle): string | null {
  if (v.spec.police) return "The garage won't take a police vehicle.";
  if (v.missionTag) return "That car isn't yours to keep.";
  if (v.destroyed || !v.drivable || v.burning) return "The garage won't take a wreck.";
  if (v.spec.class !== 'car' || v.kind === 'bus') return "That won't fit in the garage.";
  return null;
}

function store(sim: Sim, v: Vehicle): void {
  const r = rt(sim);
  r.stored.push(v);
  // Kept while it stands there: abandoned cars far from the player are streamed out.
  v.persistent = true;
  v.usedByPlayer = true;
}

function release(v: Vehicle): void {
  v.persistent = false;
}

/** Buys a property for slot 0: null on success, else why not. */
export function buyProperty(sim: Sim, which: 'garage' | 'business'): string | null {
  const p = sim.progress;
  const s = propertyState(p);
  if (s[which]) return which === 'garage' ? 'You already own the garage.' : `You already own the ${BUSINESS_NAME}.`;
  const price = which === 'garage' ? GARAGE_PRICE : BUSINESS_PRICE;
  if (!p.spend(price)) return `You can't afford that (${formatMoney(price)}).`;
  s[which] = true;
  if (which === 'business') {
    s.uncollected = 0;
    s.accrueFrom = gameHours(sim);
  }
  sim.events.emit('money', { amount: -price });
  sim.events.emit('big', { text: which === 'garage' ? 'GARAGE BOUGHT' : 'PIER ARCADE BOUGHT', sub: which === 'garage' ? `Room for ${GARAGE_SLOTS} cars` : `${formatMoney(BUSINESS_DAILY)} a day, collected at the safehouse`, style: 'passed', duration: 3 });
  sim.events.emit('activityMilestone', { kind: `property:${which}`, reward: 0 });
  return null;
}

/** Adds the takings of every full game day since accrueFrom (capped). */
function accrue(sim: Sim, s: PropertyState): void {
  const now = gameHours(sim);
  const days = Math.floor((now - s.accrueFrom) / 24);
  if (days <= 0) return;
  s.accrueFrom += days * 24;
  s.uncollected = Math.min(BUSINESS_DAILY * BUSINESS_CAP_DAYS, s.uncollected + days * BUSINESS_DAILY);
}

/** Pays the waiting takings (at the safehouse); returns what was paid. */
export function collectTakings(sim: Sim): number {
  const s = propertyState(sim.progress);
  if (!s.business) return 0;
  accrue(sim, s);
  const amount = s.uncollected;
  if (amount <= 0) return 0;
  s.uncollected = 0;
  sim.progress.addMoney(amount);
  sim.events.emit('money', { amount });
  sim.events.emit('activityMilestone', { kind: 'business', reward: amount });
  say(sim, `${BUSINESS_NAME} takings collected: ${formatMoney(amount)}.`, 4);
  return amount;
}

function updateGarage(sim: Sim): void {
  const r = rt(sim);
  const s = propertyState(sim.progress);
  // Stored cars driven (or pushed) out, or lost, free their slot.
  for (let i = r.stored.length - 1; i >= 0; i--) {
    const v = r.stored[i]!;
    if (!v.removed && !v.destroyed && inGarage(sim, v)) continue;
    r.stored.splice(i, 1);
    if (!v.removed) release(v);
    if (v.driver === sim.player) say(sim, `Car taken out of the garage (${r.stored.length}/${GARAGE_SLOTS}).`, 2.5);
  }
  const p = sim.player;
  const v = r.lastExit;
  if (p.vehicle || !v || v.removed) {
    if (p.vehicle) r.judged = null;
    return;
  }
  if (!s.garage || r.judged === v || v.driver || !inGarage(sim, v) || r.stored.includes(v)) {
    if (r.judged === v && !inGarage(sim, v)) r.judged = null;
    return;
  }
  r.judged = v;
  const refusal = garageRefusal(v);
  if (refusal) {
    say(sim, refusal);
    return;
  }
  if (r.stored.length >= GARAGE_SLOTS) {
    say(sim, `Garage full (${GARAGE_SLOTS}/${GARAGE_SLOTS}). Drive a car out first.`);
    return;
  }
  store(sim, v);
  say(sim, `Car stored in your garage (${r.stored.length}/${GARAGE_SLOTS}).`);
}

function updateCustoms(sim: Sim): void {
  const r = rt(sim);
  const slot = sim.players[0]!;
  const v = slot.character.vehicle;
  const bay = places(sim.world).customsBay;
  if (!v || v.driver !== slot.character || slot.down || !rectContains(bay, v.pos.x, v.pos.z)) {
    r.customs = null;
    return;
  }
  if (r.customs === v || v.speed > 1.5) return;
  r.customs = v;
  const refusal = customsRefusal(v);
  if (refusal) {
    say(sim, refusal);
    return;
  }
  sim.events.emit('screenOpen', { screen: 'customs', ...slot.tag });
}

function updateTakings(sim: Sim): void {
  const r = rt(sim);
  const s = propertyState(sim.progress);
  if (s.business) accrue(sim, s);
  const home = sim.interactions.current(sim.players[0]!)?.kind === 'save';
  if (home && !r.atHome) collectTakings(sim);
  r.atHome = home;
}

registerSystem({
  id: 'properties',
  slot: 'afterInteractions',
  update(sim) {
    updateTakings(sim);
    updateGarage(sim);
    updateCustoms(sim);
  },
  reset(sim) {
    runtime.delete(sim);
  },
});

// ---------------------------------------------------------------------------
// Save extensions

export interface StoredCarRecord extends ModLevels {
  kind: VehicleKind;
  color: number;
}

interface GarageSave {
  owned: boolean;
  cars: StoredCarRecord[];
}

/** A garage entry as saved; corrupt cars are dropped (a car of a kind that no longer exists, say). */
export function parseGarage(raw: unknown): GarageSave | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as { owned?: unknown; cars?: unknown };
  const cars: StoredCarRecord[] = [];
  if (Array.isArray(o.cars)) {
    for (const c of o.cars) {
      if (!c || typeof c !== 'object') continue;
      const e = c as Record<string, unknown>;
      const kind = e.kind;
      if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(VEHICLE_SPECS, kind)) continue;
      const color = typeof e.color === 'number' && Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff ? e.color : VEHICLE_SPECS[kind as VehicleKind].colors[0]!;
      cars.push({ kind: kind as VehicleKind, color, engine: cleanLevel(e.engine), brakes: cleanLevel(e.brakes), tyres: cleanLevel(e.tyres) });
      if (cars.length >= GARAGE_SLOTS) break;
    }
  }
  return { owned: o.owned === true, cars: o.owned === true ? cars : [] };
}

registerSaveCodec<GarageSave>({
  key: GARAGE_KEY,
  serialize: (sim) => {
    const s = propertyState(sim.progress);
    if (!s.garage) return undefined;
    return { owned: true, cars: storedCars(sim).map((v) => ({ kind: v.kind, color: v.color, engine: v.mods.engine, brakes: v.mods.brakes, tyres: v.mods.tyres })) };
  },
  parse: parseGarage,
  apply: (sim, value) => {
    propertyState(sim.progress).garage = value.owned;
    const bays = places(sim.world).garageBays;
    value.cars.forEach((c, i) => {
      const bay = bays[i]!;
      const v = sim.spawnVehicle(c.kind, bay.x, bay.z, bay.heading, c.color);
      setMods(v, c);
      applyMods(v);
      store(sim, v);
    });
  },
});

interface BusinessSave {
  owned: boolean;
  uncollected: number;
  accrueFrom: number;
}

export function parseBusiness(raw: unknown): BusinessSave | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.owned !== true) return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return { owned: true, uncollected: Math.min(BUSINESS_DAILY * BUSINESS_CAP_DAYS, Math.floor(num(o.uncollected))), accrueFrom: num(o.accrueFrom) };
}

registerSaveCodec<BusinessSave>({
  key: BUSINESS_KEY,
  serialize: (sim) => {
    const s = propertyState(sim.progress);
    return s.business ? { owned: true, uncollected: s.uncollected, accrueFrom: s.accrueFrom } : undefined;
  },
  parse: parseBusiness,
  apply: (sim, value) => {
    const s = propertyState(sim.progress);
    s.business = true;
    s.uncollected = value.uncollected;
    // A day of takings never starts in the future (a hand-edited or clock-skewed save).
    s.accrueFrom = Math.min(value.accrueFrom, gameHours(sim));
  },
});

registerStatRow({ id: 'properties', label: 'Properties owned', value: ({ player }) => {
  const s = propertyState(player.progress);
  return `${Number(s.garage) + Number(s.business)} / 2`;
} });
registerStatRow({ id: 'business', label: `${BUSINESS_NAME} income`, value: ({ player }) => (propertyState(player.progress).business ? `${formatMoney(BUSINESS_DAILY)} a day` : 'Not owned') });
registerCompletion({
  id: 'properties',
  group: 'properties',
  rows: (_view, me) => {
    const s = propertyState(me.progress);
    return [
      { id: 'garage', group: 'properties', label: 'Safehouse garage', done: Number(s.garage), total: 1 },
      { id: 'business', group: 'properties', label: BUSINESS_NAME, done: Number(s.business), total: 1 },
    ];
  },
});
