// Wave-1 economy: the garage, the Pier Arcade, Azura Customs (mods measured in the physics), the stats and completion
// registry, and the README fixes owned here (full-ammo weapon pickups, saving right after a taxi or vigilante car, the
// low-health hint during a mission).

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { places } from '../../src/sim/activities/places';
import { activityRecords } from '../../src/sim/activities/records';
import { completionEntries, completionPercent, completionRows, statRows } from '../../src/sim/completion';
import type { Vehicle } from '../../src/sim/entities';
import { buyMod, buyPaint, MAX_MOD_LEVEL, MOD_CATEGORIES, MOD_TABLE, PAINT_COLORS, PAINT_PRICE, setMods, type ModCategory } from '../../src/sim/mods';
import { PACKAGE_COUNT } from '../../src/sim/pickups';
import { applySave, parseSave, SAVE_VERSION, serialize } from '../../src/sim/progress';
import {
  BUSINESS_CAP_DAYS, BUSINESS_DAILY, BUSINESS_KEY, BUSINESS_PRICE, GARAGE_KEY, GARAGE_PRICE, GARAGE_SLOTS, propertyState, storedCars,
} from '../../src/sim/properties';
import { applyExt, serializeExt } from '../../src/sim/saveExt';
import type { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, WEAPONS, type VehicleKind } from '../../src/sim/specs';
import { HintSystem } from '../../src/ui/hints';
import type { HintOptions } from '../../src/ui/hud';
import { input, makeSim, placeInCar, roadPoint, step, teleport } from './helpers';

const legacy = () => JSON.parse(readFileSync(new URL('./fixtures/legacy_v1.save.json', import.meta.url), 'utf8'));

function marker(sim: Sim, kind: string) {
  return sim.interactions.markers.find((m) => m.kind === kind)!;
}

function pressE(sim: Sim, kind: string): void {
  const m = marker(sim, kind);
  teleport(sim, m.x, m.z);
  sim.update(1 / 60, input({ interact: true }));
}

function rich(sim: Sim, money = 200000): void {
  sim.progress.money = money;
}

/** Saves the sim (core and ext) as JSON and loads it into a fresh sim, as CONTINUE does. */
function reload(a: Sim): Sim {
  const raw = JSON.parse(JSON.stringify(serialize(a.progress, [], 0, a.clock.hours, a.clock.day, serializeExt(a))));
  expect(raw.version).toBe(SAVE_VERSION);
  const save = parseSave(raw)!;
  const b = makeSim({ startHour: save.hours });
  applySave(b.progress, save);
  b.clock.day = save.day;
  applyExt(b, save.ext);
  return b;
}

/** Drives a car (spawned at `kind`) into the next free garage bay and gets out. */
function parkInGarage(sim: Sim, kind: VehicleKind, bay: number, color?: number): Vehicle {
  const b = places(sim.world).garageBays[bay]!;
  const v = sim.spawnVehicle(kind, b.x, b.z, b.heading, color);
  placeInCar(sim, v);
  step(sim, 0.1);
  sim.playerCtl.exitVehicle(false);
  step(sim, 0.2);
  return v;
}

describe('garage', () => {
  it('is for sale next to the safehouse, bought once for exactly its price, refused without the money', () => {
    const sim = makeSim();
    const m = marker(sim, 'garage');
    const home = marker(sim, 'save');
    expect(Math.hypot(m.x - home.x, m.z - home.z)).toBeLessThan(30);
    teleport(sim, m.x, m.z);
    expect(sim.interactions.prompt()).toBe(`Press E to buy the garage for $15,000 (stores ${GARAGE_SLOTS} cars)`);
    expect(m.blip?.color).toBe('#9aa3ad');
    // Not enough money: refused, nothing changes.
    sim.progress.money = GARAGE_PRICE - 1;
    const msgs: string[] = [];
    sim.events.on('message', (e) => msgs.push(e.text));
    sim.update(1 / 60, input({ interact: true }));
    expect(propertyState(sim.progress).garage).toBe(false);
    expect(sim.progress.money).toBe(GARAGE_PRICE - 1);
    expect(msgs.at(-1)).toMatch(/can't afford/);
    // Enough: bought.
    sim.progress.money = 20000;
    const spent = sim.progress.stats.moneySpent;
    step(sim, 0.1);
    sim.update(1 / 60, input({ interact: true }));
    expect(propertyState(sim.progress).garage).toBe(true);
    expect(sim.progress.money).toBe(20000 - GARAGE_PRICE);
    expect(sim.progress.stats.moneySpent - spent).toBe(GARAGE_PRICE);
    expect(sim.interactions.prompt()).toMatch(/^Your garage: 0\/4 cars stored/);
    step(sim, 0.1);
    expect(m.blip?.color).toBe('#3fd96b');
    // Again: nothing more is taken.
    step(sim, 0.1);
    sim.update(1 / 60, input({ interact: true }));
    expect(sim.progress.money).toBe(20000 - GARAGE_PRICE);
    console.log(`garage: $20,000 -> $${sim.progress.money}, refused at $${GARAGE_PRICE - 1}`);
  });

  it('stores up to four cars, refuses a fifth, police cars, wrecks and mission cars, and keeps them while away', () => {
    const sim = makeSim();
    rich(sim);
    pressE(sim, 'garage');
    const msgs: string[] = [];
    sim.events.on('message', (e) => msgs.push(e.text));
    const log: string[] = [];
    const cars: Vehicle[] = [];
    for (let i = 0; i < 4; i++) {
      cars.push(parkInGarage(sim, (['sedan', 'sports', 'pickup', 'muscle'] as const)[i]!, i));
      expect(storedCars(sim)).toHaveLength(i + 1);
      log.push(msgs.at(-1)!);
    }
    expect(msgs.at(-1)).toBe('Car stored in your garage (4/4).');
    // The fifth, squeezed into the aisle of the garage, is refused.
    const fifth = parkInGarage(sim, 'compact', 1);
    expect(storedCars(sim)).toHaveLength(4);
    expect(storedCars(sim)).not.toContain(fifth);
    expect(msgs.at(-1)).toMatch(/^Garage full/);
    log.push(msgs.at(-1)!);
    sim.removeVehicle(fifth);
    // A refused kind: police, mission and wrecks. Free a slot first.
    cars[3]!.pos.x += 30;
    step(sim, 0.2);
    expect(storedCars(sim)).toHaveLength(3);
    for (const [label, make] of [
      ['police', () => parkInGarage(sim, 'police', 3)],
      ['mission', () => {
        const b = places(sim.world).garageBays[3]!;
        const v = sim.spawnVehicle('sedan', b.x, b.z, b.heading);
        v.missionTag = 'job';
        placeInCar(sim, v);
        step(sim, 0.1);
        sim.playerCtl.exitVehicle(false);
        step(sim, 0.2);
        return v;
      }],
    ] as const) {
      const v = make();
      expect(storedCars(sim), label).not.toContain(v);
      log.push(`${label}: ${msgs.at(-1)}`);
      sim.removeVehicle(v);
      step(sim, 0.1);
    }
    const wreck = sim.spawnVehicle('sedan', places(sim.world).garageBays[3]!.x, places(sim.world).garageBays[3]!.z, Math.PI / 2);
    placeInCar(sim, wreck);
    wreck.health = 0;
    sim.combat.igniteVehicle(wreck, 999);
    sim.playerCtl.exitVehicle(false);
    step(sim, 0.2);
    expect(storedCars(sim)).not.toContain(wreck);
    log.push(`wreck: ${msgs.at(-1)}`);
    // Away across the city for a while: the stored ones stay.
    const stored = [...storedCars(sim)];
    teleport(sim, 400, 300);
    sim.ambient = true;
    step(sim, 20);
    for (const v of stored) expect(v.removed).toBe(false);
    expect(storedCars(sim)).toEqual(stored);
    console.log(log.join('\n'));
  });

  it('respawns stored cars after a reload with their kinds, colours and mods; a car driven out frees its slot', () => {
    const a = makeSim();
    rich(a);
    pressE(a, 'garage');
    const red = parkInGarage(a, 'sedan', 0);
    red.color = PAINT_COLORS[0]!.color;
    const tuned = parkInGarage(a, 'muscle', 1);
    setMods(tuned, { engine: 3, brakes: 2, tyres: 1 });
    parkInGarage(a, 'compact', 2, 0x1f618d);
    const before = storedCars(a).map((v) => ({ kind: v.kind, color: v.color, mods: { ...v.mods } }));
    const raw = serializeExt(a)!;
    console.log('garage ext', JSON.stringify(raw[GARAGE_KEY]));
    const b = reload(a);
    expect(propertyState(b.progress).garage).toBe(true);
    const after = storedCars(b).map((v) => ({ kind: v.kind, color: v.color, mods: { ...v.mods } }));
    expect(after).toEqual(before);
    const tuned2 = storedCars(b).find((v) => v.kind === 'muscle')!;
    expect(tuned2.tune).toEqual({ accel: MOD_TABLE.engine.multipliers[3], brake: MOD_TABLE.brakes.multipliers[2], grip: MOD_TABLE.tyres.multipliers[1] });
    for (const v of storedCars(b)) expect(v.persistent).toBe(true);
    // Twice through: still three, nothing doubled.
    const c = reload(b);
    expect(storedCars(c).map((v) => ({ kind: v.kind, color: v.color, mods: { ...v.mods } }))).toEqual(before);
    expect(c.vehicles.filter((v) => !v.removed && v.persistent)).toHaveLength(3);
    // Driving one out frees its slot.
    const out = storedCars(c)[0]!;
    placeInCar(c, out);
    out.pos.z -= 25;
    step(c, 0.2);
    expect(storedCars(c)).toHaveLength(2);
    expect(out.persistent).toBe(false);
  });

  it('a save without ext loads with an empty, unowned garage; a corrupt garage entry keeps the core save', () => {
    const save = parseSave(legacy())!;
    const sim = makeSim();
    applySave(sim.progress, save);
    applyExt(sim, save.ext);
    expect(propertyState(sim.progress)).toEqual({ garage: false, business: false, uncollected: 0, accrueFrom: 0 });
    expect(storedCars(sim)).toHaveLength(0);
    for (const bad of ['x', 7, { owned: true, cars: 'no' }, { owned: true, cars: [{ kind: 'tank', color: 1 }, { kind: 'sedan', color: 'red', engine: 99, brakes: -4 }] }]) {
      const s = parseSave({ ...legacy(), ext: { [GARAGE_KEY]: bad, [BUSINESS_KEY]: bad } })!;
      expect(s.money).toBe(18450);
      const t = makeSim();
      applySave(t.progress, s);
      expect(() => applyExt(t, s.ext)).not.toThrow();
      for (const v of storedCars(t)) {
        expect(v.kind).toBe('sedan');
        expect(v.mods).toEqual({ engine: MAX_MOD_LEVEL, brakes: 0, tyres: 0 });
      }
    }
  });
});

describe('Pier Arcade', () => {
  function bought(): Sim {
    const sim = makeSim({ startHour: 10 });
    rich(sim, 30000);
    pressE(sim, 'business');
    expect(propertyState(sim.progress).business).toBe(true);
    return sim;
  }

  it('is bought once for exactly its price, refused without the money, shows its income and survives a reload', () => {
    const poor = makeSim();
    poor.progress.money = BUSINESS_PRICE - 1;
    pressE(poor, 'business');
    expect(propertyState(poor.progress).business).toBe(false);
    expect(poor.progress.money).toBe(BUSINESS_PRICE - 1);
    const sim = bought();
    expect(sim.progress.money).toBe(30000 - BUSINESS_PRICE);
    expect(sim.interactions.prompt()).toMatch(/Pier Arcade: yours\. \$500 a day/);
    step(sim, 0.1);
    sim.update(1 / 60, input({ interact: true }));
    expect(sim.progress.money).toBe(30000 - BUSINESS_PRICE);
    const ext = serializeExt(sim)!;
    expect(ext[BUSINESS_KEY]).toMatchObject({ owned: true });
    expect(propertyState(reload(sim).progress).business).toBe(true);
  });

  it('accrues $500 for each full game day, nothing for part of one, up to the cap, and pays it once at the safehouse', () => {
    const sim = bought();
    const s = propertyState(sim.progress);
    const out: string[] = [];
    sim.clock.advance(23.5);
    step(sim, 0.1);
    expect(s.uncollected).toBe(0);
    out.push(`23.5 h: ${s.uncollected}`);
    sim.clock.advance(0.6);
    step(sim, 0.1);
    expect(s.uncollected).toBe(BUSINESS_DAILY);
    out.push(`24.1 h: ${s.uncollected}`);
    sim.clock.advance(48);
    step(sim, 0.1);
    expect(s.uncollected).toBe(3 * BUSINESS_DAILY);
    out.push(`3 days: ${s.uncollected}`);
    // Saved and loaded: still waiting.
    const b = reload(sim);
    expect(propertyState(b.progress).uncollected).toBe(3 * BUSINESS_DAILY);
    // Collected on the safehouse marker, once.
    const home = marker(b, 'save');
    const money = b.progress.money;
    const msgs: string[] = [];
    b.events.on('message', (e) => msgs.push(e.text));
    teleport(b, home.x, home.z);
    step(b, 0.1);
    expect(b.progress.money - money).toBe(3 * BUSINESS_DAILY);
    expect(propertyState(b.progress).uncollected).toBe(0);
    expect(msgs).toContain('Pier Arcade takings collected: $1,500.');
    teleport(b, home.x + 6, home.z + 4);
    step(b, 0.1);
    teleport(b, home.x, home.z);
    step(b, 0.1);
    expect(b.progress.money - money).toBe(3 * BUSINESS_DAILY);
    out.push(`collected ${b.progress.money - money}, second visit +0`);
    // The cap.
    b.clock.advance(24 * 30);
    step(b, 0.1);
    expect(propertyState(b.progress).uncollected).toBe(BUSINESS_CAP_DAYS * BUSINESS_DAILY);
    out.push(`30 days: ${propertyState(b.progress).uncollected} (cap ${BUSINESS_CAP_DAYS} days)`);
    console.log(out.join('\n'));
  });

  it('accrues nothing before it is bought', () => {
    const sim = makeSim();
    sim.clock.advance(24 * 5);
    step(sim, 0.1);
    expect(propertyState(sim.progress).uncollected).toBe(0);
    const home = marker(sim, 'save');
    const money = sim.progress.money;
    teleport(sim, home.x, home.z);
    step(sim, 0.1);
    expect(sim.progress.money).toBe(money);
  });
});

describe('Azura Customs', () => {
  it('opens its screen when a car stops in its bay, refusing police, mission and wrecked cars at the door', () => {
    const sim = makeSim();
    const bay = places(sim.world).customsBay;
    const opened: string[] = [];
    const msgs: string[] = [];
    sim.events.on('screenOpen', (e) => opened.push(e.screen));
    sim.events.on('message', (e) => msgs.push(e.text));
    for (const kind of ['sedan', 'police'] as const) {
      const v = sim.spawnVehicle(kind, (bay.minX + bay.maxX) / 2, (bay.minZ + bay.maxZ) / 2, Math.PI);
      placeInCar(sim, v);
      step(sim, 0.2);
      sim.playerCtl.ejectPlayer(false);
      sim.removeVehicle(v);
      step(sim, 0.1);
    }
    expect(opened).toEqual(['customs']);
    expect(msgs.at(-1)).toMatch(/police/);
  });

  it('sells each category from one price table, deducting exactly the listed price, and refuses past the top level or without money', () => {
    const sim = makeSim();
    const v = sim.spawnVehicle('sedan', 0, 0, 0);
    rich(sim, 100000);
    const out: string[] = [];
    for (const cat of MOD_CATEGORIES) {
      for (let lvl = 1; lvl <= MAX_MOD_LEVEL; lvl++) {
        const money = sim.progress.money;
        const spent = sim.progress.stats.moneySpent;
        expect(buyMod(sim.progress, v, cat)).toBeNull();
        const price = MOD_TABLE[cat].prices[lvl - 1]!;
        expect(money - sim.progress.money).toBe(price);
        expect(sim.progress.stats.moneySpent - spent).toBe(price);
        expect(v.mods[cat]).toBe(lvl);
        out.push(`${cat} ${lvl}: $${price}`);
      }
      const money = sim.progress.money;
      expect(buyMod(sim.progress, v, cat)).toMatch(/fully upgraded/);
      expect(sim.progress.money).toBe(money);
    }
    const w = sim.spawnVehicle('sedan', 8, 0, 0, 0xeeeeee);
    sim.progress.money = 100;
    expect(buyMod(sim.progress, w, 'engine')).toMatch(/afford/);
    expect(w.mods.engine).toBe(0);
    expect(buyPaint(sim.progress, w, PAINT_COLORS[3]!.color)).toMatch(/afford/);
    sim.progress.money = 1000;
    expect(buyPaint(sim.progress, w, PAINT_COLORS[3]!.color)).toBeNull();
    expect(w.color).toBe(PAINT_COLORS[3]!.color);
    expect(sim.progress.money).toBe(1000 - PAINT_PRICE);
    const cop = sim.spawnVehicle('police', 16, 0, 0);
    expect(buyMod(sim.progress, cop, 'engine')).toMatch(/police/);
    console.log(out.join(', '), `paint $${PAINT_PRICE}`);
  });
});

describe('mods in the physics: the upgraded car only', () => {
  const KMH100 = 100 / 3.6;

  /** A sedan on the flat beach, heading +z, with these levels; `twin` (if given) is a second sedan 40 m off with those levels. */
  function rig(levels: Partial<Record<ModCategory, number>>, twinLevels?: Partial<Record<ModCategory, number>>): { sim: Sim; v: Vehicle; twin: Vehicle | null } {
    const sim = makeSim({ ambient: false, police: false });
    const b = sim.world.layout.bounds;
    const x = b.beachStartX + 40;
    const z = b.landMinZ + 60;
    const v = sim.spawnVehicle('sedan', x, z, 0, 0xeeeeee);
    setMods(v, levels);
    placeInCar(sim, v);
    let twin: Vehicle | null = null;
    if (twinLevels) {
      twin = sim.spawnVehicle('sedan', x + 40, z, 0, 0xeeeeee);
      setMods(twin, twinLevels);
    }
    return { sim, v, twin };
  }

  function zeroTo100(levels: Partial<Record<ModCategory, number>>): number {
    const { sim, v } = rig(levels);
    let t = 0;
    while (v.forwardSpeed < KMH100 && t < 20) {
      sim.update(1 / 120, input({ throttle: 1 }));
      t += 1 / 120;
    }
    return t;
  }

  function stopping(levels: Partial<Record<ModCategory, number>>): number {
    const { sim, v } = rig(levels);
    v.vel.x = 0;
    v.vel.z = KMH100;
    v.forwardSpeed = KMH100;
    v.speed = KMH100;
    const z0 = v.pos.z;
    for (let i = 0; i < 2400 && v.speed > 0.3; i++) sim.update(1 / 120, input({ brake: 1 }));
    return v.pos.z - z0;
  }

  function lateral(levels: Partial<Record<ModCategory, number>>, twinLevels?: Partial<Record<ModCategory, number>>): number {
    const { sim, v } = rig(levels, twinLevels);
    let best = 0;
    for (let i = 0; i < 360; i++) {
      // Held at 25 m/s on full lock: the most sideways acceleration the tyres give.
      const h = v.heading;
      v.vel.x = Math.sin(h) * 25;
      v.vel.z = Math.cos(h) * 25;
      sim.update(1 / 120, input({ throttle: 0.4, steer: 1 }));
      if (i > 120) best = Math.max(best, Math.abs(v.angVel * v.forwardSpeed));
    }
    return best;
  }

  it('engine, brakes and tyres each improve monotonically, the top level by at least 5% (the documented gains)', () => {
    const rows: string[] = ['level | 0-100 km/h s | stop from 100 m | lateral m/s2'];
    const acc: number[] = [];
    const stop: number[] = [];
    const lat: number[] = [];
    for (let lvl = 0; lvl <= MAX_MOD_LEVEL; lvl++) {
      acc.push(zeroTo100({ engine: lvl }));
      stop.push(stopping({ brakes: lvl }));
      lat.push(lateral({ tyres: lvl }));
      rows.push(`${lvl} | ${acc[lvl]!.toFixed(3)} | ${stop[lvl]!.toFixed(2)} | ${lat[lvl]!.toFixed(2)}`);
    }
    for (let lvl = 1; lvl <= MAX_MOD_LEVEL; lvl++) {
      expect(acc[lvl]!).toBeLessThan(acc[lvl - 1]!);
      expect(stop[lvl]!).toBeLessThan(stop[lvl - 1]!);
      expect(lat[lvl]!).toBeGreaterThan(lat[lvl - 1]!);
    }
    expect(1 - acc[3]! / acc[0]!).toBeGreaterThanOrEqual(0.15);
    expect(1 - stop[3]! / stop[0]!).toBeGreaterThanOrEqual(0.2);
    expect(lat[3]! / lat[0]! - 1).toBeGreaterThanOrEqual(0.15);
    rows.push(`top vs stock: 0-100 -${((1 - acc[3]! / acc[0]!) * 100).toFixed(1)}%, stop -${((1 - stop[3]! / stop[0]!) * 100).toFixed(1)}%, lateral +${((lat[3]! / lat[0]! - 1) * 100).toFixed(1)}%`);
    console.log(rows.join('\n'));
  });

  it('an unmodded car next to a fully modded twin measures exactly as stock, and VEHICLE_SPECS is untouched', () => {
    const spec = JSON.stringify(VEHICLE_SPECS.sedan);
    const stock = lateral({});
    const twin = lateral({}, { engine: 3, brakes: 3, tyres: 3 });
    expect(twin).toBe(stock);
    const { v: t, twin: modded } = rig({}, { engine: 3, brakes: 3, tyres: 3 });
    expect(t.tune).toEqual({ accel: 1, brake: 1, grip: 1 });
    expect(modded!.tune.grip).toBe(MOD_TABLE.tyres.multipliers[3]);
    expect(JSON.stringify(VEHICLE_SPECS.sedan)).toBe(spec);
    console.log(`stock car beside a modded twin: lateral ${twin.toFixed(4)} = stock ${stock.toFixed(4)}`);
  });
});

describe('stats and completion registry', () => {
  it('lists the new activity and property rows and checklist entries, and keeps the old completion values', () => {
    const sim = makeSim();
    const view = { sim, player: sim.players[0]! };
    const ids = statRows().map((r) => r.id);
    for (const id of ['ambulanceLevel', 'fireLevel', 'courierRuns', 'exportCars', 'properties']) expect(ids).toContain(id);
    const me = sim.players[0]!;
    // The checklist rows: the activities' come from ActivityDef.completion, the properties' from one registry entry.
    const rowIds = completionRows(sim, me).map((r) => r.id);
    for (const id of ['packages', 'stunts', 'rampages', 'activity:ambulance', 'activity:firefighter', 'activity:courier', 'activity:carExport', 'garage', 'business']) expect(rowIds).toContain(id);
    expect(rowIds.filter((id) => id.startsWith('story:'))).not.toHaveLength(0);
    const counted = completionEntries().filter((e) => (e.weight ?? 0) > 0);
    expect(counted.map((e) => e.id).sort()).toEqual(['packages', 'rampages', 'story', 'stunts']);
    expect(counted.reduce((s, e) => s + (e.weight ?? 0), 0)).toBeCloseTo(1, 12);
    // The baseline formula, for a legacy save: the same number.
    const save = parseSave(legacy())!;
    applySave(sim.progress, save);
    const p = sim.progress;
    const done = sim.missions.defs.filter((d) => p.hasDone(d.id)).length;
    const old = Math.round(((done / sim.missions.defs.length) * 0.5 + (p.packages.length / PACKAGE_COUNT) * 0.2 + (p.stunts.length / sim.world.layout.ramps.length) * 0.15 + (p.rampages.length / 3) * 0.15) * 100);
    expect(completionPercent(sim, me)).toBe(old);
    // Everything done: 100%.
    for (const d of sim.missions.defs) p.markDone(d.id);
    p.packages.splice(0, p.packages.length, ...Array.from({ length: PACKAGE_COUNT }, (_v, i) => i));
    p.stunts.splice(0, p.stunts.length, ...sim.world.layout.ramps.map((_r, i) => i));
    p.rampages.splice(0, p.rampages.length, 'rampage:0', 'rampage:1', 'rampage:2');
    Object.assign(activityRecords(p), { ambulanceLevel: 6, fireLevel: 5, courierRuns: 2, exportLists: 1 });
    propertyState(p).garage = true;
    propertyState(p).business = true;
    expect(completionPercent(sim, me)).toBe(100);
    for (const r of completionRows(sim, me)) {
      // The taxi, vigilante and Street Run rows are older activities this test does not play.
      if (['taxi', 'vigilante', 'streetRuns'].includes(r.id)) continue;
      expect(r.done, r.id).toBeGreaterThanOrEqual(r.total);
    }
    console.log(statRows().map((r) => `${r.label}: ${r.value(view)}`).join('\n'));
    console.log(completionRows(sim, me).map((r) => `${r.group}/${r.label}: ${r.done}/${r.total}`).join('\n'));
  });
});

describe('README fixes', () => {
  it('a weapon pickup stays when that gun is full, and is taken once there is room', () => {
    const sim = makeSim({ ambient: false, police: false });
    const pk = sim.pickups.find((p) => p.kind === 'weapon' && p.weapon && p.active)!;
    const w = pk.weapon!;
    sim.player.inventory.give(w, 99999);
    sim.player.inventory.current = w;
    const full = sim.player.inventory.total(w);
    const msgs: string[] = [];
    sim.events.on('message', (e) => msgs.push(e.text));
    teleport(sim, pk.pos.x, pk.pos.z);
    step(sim, 0.5);
    expect(pk.active).toBe(true);
    expect(pk.respawnTimer).toBe(0);
    expect(sim.player.inventory.total(w)).toBe(full);
    expect(msgs.some((m) => m.includes('ammo'))).toBe(false);
    // Fire some rounds (walk off, empty part of the reserve), and walk back on.
    teleport(sim, pk.pos.x + 6, pk.pos.z + 6);
    step(sim, 0.1);
    const slot = sim.player.inventory.slots.get(w)!;
    slot.ammo = Math.max(0, slot.ammo - WEAPONS[w].ammoPack * 2);
    const less = sim.player.inventory.total(w);
    teleport(sim, pk.pos.x, pk.pos.z);
    step(sim, 0.5);
    expect(pk.active).toBe(false);
    expect(sim.player.inventory.total(w)).toBeGreaterThan(less);
    expect(msgs).toContain(`${WEAPONS[w].name} ammo.`);
    console.log(`${w}: full ${full}, pickup active while full; after firing ${less} -> ${sim.player.inventory.total(w)}`);
  });

  for (const kind of ['taxi', 'police'] as const) {
    for (const delay of [0.1, 1]) {
      it(`saves at the safehouse ${delay} s after stepping out of a ${kind} job's car there`, () => {
        const sim = makeSim({ ambient: false, police: false });
        const home = marker(sim, 'save');
        const road = roadPoint(sim);
        const car = sim.spawnVehicle(kind, road.x, road.z, road.heading);
        placeInCar(sim, car);
        sim.activities.toggleJob();
        expect(sim.activities.job?.kind).toBe(kind === 'taxi' ? 'taxi' : 'vigilante');
        // Pulled up by the safehouse and out of the car.
        car.pos.x = home.x;
        car.pos.z = home.z + 6;
        sim.update(1 / 60, input({ enterExit: true }));
        teleport(sim, home.x, home.z);
        step(sim, delay);
        const saved = vi.fn();
        const msgs: string[] = [];
        sim.events.on('saveRequested', saved);
        sim.events.on('message', (e) => msgs.push(e.text));
        expect(sim.interactions.prompt()).toBe('Press E to save your game');
        sim.update(1 / 60, input({ interact: true }));
        expect(saved).toHaveBeenCalledOnce();
        expect(msgs.some((m) => /rampage/i.test(m))).toBe(false);
      });
    }
  }

  it('still refuses to save during a real rampage', () => {
    const sim = makeSim({ ambient: false, police: false });
    expect(sim.activities.startRampage('rampage:0')).toBe(true);
    const saved = vi.fn();
    sim.events.on('saveRequested', saved);
    pressE(sim, 'save');
    expect(saved).not.toHaveBeenCalled();
  });

  it('the low-health hint during a mission points to what works then, and keeps the safehouse advice for later', () => {
    const sim = makeSim({ ambient: false, police: false });
    step(sim, 0.1);
    const seen: string[] = ['drive', 'wanted', 'weapon', 'mouse'];
    const shown = new Map<string, { text: string; options: HintOptions }>();
    const hints = new HintSystem({
      enabled: () => true,
      seen: () => seen,
      markSeen: (id) => seen.push(id),
      pending: (id) => shown.has(id),
      show: (text, _d, options) => {
        shown.set(options.id, { text, options });
        return true;
      },
    });
    sim.player.health = 20;
    expect(sim.missions.start('wheels')).toBe(true);
    hints.update(1 / 60, sim, { device: 'kb', mouseFree: false });
    const during = shown.get('health:restricted')!;
    expect(during.text).not.toMatch(/safehouse/i);
    expect(during.text).toMatch(/First Aid/);
    during.options.onRead!();
    const seenDuring = [...seen];
    expect(seenDuring).not.toContain('health');
    sim.missions.abandon();
    step(sim, 0.1);
    hints.update(1 / 60, sim, { device: 'kb', mouseFree: false });
    expect(shown.get('health')?.text).toMatch(/safehouse/);
    console.log(`in mission: "${during.text}"\nafter: "${shown.get('health')!.text}"\nhintsSeen during: ${seenDuring.join(',')}`);
  });
});
