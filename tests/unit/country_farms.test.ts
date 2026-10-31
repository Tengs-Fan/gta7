// Las Lomas County's four farms (world/country/farms.ts, sim/farms.ts): where everything stands (in the farm plots, 12 m
// and more off every road edge, nothing older moved), the barns that blind the helicopter, the corn that hides a target
// and drags at a car, the propane tank that goes up, the hedgerows that stop sight but not the camera, the cows tipped
// at night that stand up again at dawn (on a Sim and on a multiplayer client's mirror alike), and the twenty scarecrows.

import { describe, expect, it } from 'vitest';
import { Mirror } from '../../src/net/mirror';
import type { SnapshotMsg } from '../../src/net/protocol';
import { completionRows } from '../../src/sim/completion';
import { Helicopter } from '../../src/sim/entities';
import { farmsState, passedDawn, SCARECROW_REWARD } from '../../src/sim/farms';
import { applyExt, parseExt, serializeExt } from '../../src/sim/saveExt';
import type { Sim } from '../../src/sim/sim';
import { registeredSystems } from '../../src/sim/systems';
import { blocksCamera, isSolidForSight, makeRayHit } from '../../src/world/colliders';
import { plotAt } from '../../src/world/country';
import { COW_COUNT, HEDGE_H, SCARECROW_COUNT } from '../../src/world/country/farms';
import { mkRect, rectContains, rectCX, rectCZ, type Rect } from '../../src/world/layout';
import { GARAGE_EAVE, StaticWorld } from '../../src/world/staticWorld';
import { rectClearance } from './farm_helpers';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

const W = world();
const L = W.layout;
const farms = L.country.farms;
const FARM_KINDS = new Set(['silo', 'grainbin', 'windpump', 'fence', 'bale', 'orchardTree', 'propane', 'cow', 'scarecrow']);

const colliderOf = (w: StaticWorld, i: number) => w.grid.colliders[w.propColliders[i]!]!;

function drive(sim: Sim, x: number, z: number, heading: number, speed: number) {
  const v = sim.spawnVehicle('sedan', x, z, heading);
  placeInCar(sim, v);
  v.vel.x = Math.sin(heading) * speed;
  v.vel.z = Math.cos(heading) * speed;
  return v;
}

describe('Las Lomas County: the farmsteads', () => {
  it('stands every farm collider in a farm plot, 12 m and more off every road edge', () => {
    const boxes: Array<{ what: string; r: Rect }> = [];
    L.props.forEach((p, i) => {
      if (!FARM_KINDS.has(p.kind)) return;
      const c = colliderOf(W, i);
      boxes.push({ what: `${p.kind} ${i}`, r: c.circle ? mkRect(c.cx - c.r, c.cz - c.r, c.cx + c.r, c.cz + c.r) : c });
    });
    for (const f of farms.farmsteads) {
      const house = L.buildings.find((b) => b.id === f.house)!;
      boxes.push({ what: `${f.id} house`, r: house.rect });
      const e = GARAGE_EAVE;
      boxes.push({ what: `${f.id} barn`, r: mkRect(f.barn.minX - e, f.barn.minZ - e, f.barn.maxX + e, f.barn.maxZ + e) });
      // The house and the barn stand in the farmyard.
      expect(rectContains(f.yard, house.rect.minX, house.rect.minZ) && rectContains(f.yard, house.rect.maxX, house.rect.maxZ), f.id).toBe(true);
      expect(rectContains(f.yard, f.barn.minX, f.barn.minZ) && rectContains(f.yard, f.barn.maxX, f.barn.maxZ), f.id).toBe(true);
    }
    for (const h of farms.hedges) boxes.push({ what: 'hedge', r: h });
    expect(boxes.length).toBeGreaterThan(600);
    for (const { what, r } of boxes) {
      const a = plotAt(L.country, r.minX, r.minZ);
      expect(a?.kind, what).toBe('farm');
      expect(plotAt(L.country, r.maxX, r.maxZ), what).toBe(a);
      expect(rectClearance(r), what).toBeGreaterThanOrEqual(12);
    }
  });

  it('has a farmhouse and a barn on each farm, the barns opening onto their yards, the houses built as the city builds a house', () => {
    expect(farms.farmsteads.map((f) => f.id)).toEqual(['bottoms', 'dairy', 'orchard', 'acres']);
    for (const f of farms.farmsteads) {
      const b = L.buildings.find((x) => x.id === f.house)!;
      expect([b.style, b.roof, b.district, b.ground, b.tiers[0]!.y0]).toEqual(['house', 'gable', 'country', 'none', 0]);
      expect(L.buildings.filter((x) => x.id === f.house).length).toBe(1);
      const g = L.garages.find((q) => q.poi === `${f.id}_barn`)!;
      expect(g.side).toBe(f.door);
      // From the barn's middle out through its doors, a car's width is free all the way into the yard.
      const [ox, oz] = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[f.door];
      const half = f.door === 'E' || f.door === 'W' ? (f.barn.maxX - f.barn.minX) / 2 : (f.barn.maxZ - f.barn.minZ) / 2;
      for (let d = 0; d <= half + 6; d += 1) expect(W.isFree(rectCX(f.barn) + ox * d, rectCZ(f.barn) + oz * d, 1.4), `${f.id} at ${d}`).toBe(true);
    }
    // Fifteen cows, twenty scarecrows, a propane tank and a windpump, kept by index.
    expect(farms.cows.map((i) => L.props[i]!.kind)).toEqual(new Array(COW_COUNT).fill('cow'));
    expect(farms.scarecrows.map((i) => L.props[i]!.kind)).toEqual(new Array(SCARECROW_COUNT).fill('scarecrow'));
    expect([L.props[farms.propane]!.kind, L.props[farms.windpump]!.kind]).toEqual(['propane', 'windpump']);
  });

  it('adds no open spot, appends its farmyard bays after every older one, and leaves the city its nearest bays', () => {
    expect(L.openSpots.filter((s) => s.x < L.bounds.landMinX)).toEqual([]);
    const county = L.parking.map((s, i) => [s, i] as const).filter(([s]) => s.x < L.bounds.landMinX);
    expect(county.length).toBe(8);
    expect(county.map(([, i]) => i)).toEqual(county.map((_, k) => L.parking.length - county.length + k));
    for (const [s] of county) {
      expect(W.isFree(s.x, s.z, 1.6)).toBe(true);
      expect(farms.farmsteads.some((f) => rectContains(f.yard, s.x, s.z))).toBe(true);
    }
    // From anywhere in the city, the nearest bay is a city bay.
    for (let x = L.bounds.cityMinX; x <= L.bounds.cityMaxX; x += 60) {
      for (let z = L.bounds.cityMinZ; z <= L.bounds.cityMaxZ; z += 60) {
        const near = L.parking.reduce((b, s) => (Math.hypot(s.x - x, s.z - z) < Math.hypot(b.x - x, b.z - z) ? s : b));
        expect(near.x).toBeGreaterThanOrEqual(L.bounds.landMinX);
      }
    }
  });

  it('hides a car in a barn from a helicopter overhead, which sees it out in the yard', () => {
    const sim = makeSim({ police: false });
    sim.clock.set(12);
    for (const f of farms.farmsteads) {
      const x = rectCX(f.barn);
      const z = rectCZ(f.barn);
      expect(sim.world.coverAt(x, z)).toBe(true);
      const h = new Helicopter(sim.newId(), x, 45, z + 3);
      sim.helis.push(h);
      expect(sim.wanted.heliSees(h, x, z), f.id).toBe(false);
      const [ox, oz] = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[f.door];
      const half = f.door === 'E' || f.door === 'W' ? (f.barn.maxX - f.barn.minX) / 2 : (f.barn.maxZ - f.barn.minZ) / 2;
      expect(sim.wanted.heliSees(h, x + ox * (half + 5), z + oz * (half + 5)), f.id).toBe(true);
      sim.helis.length = 0;
    }
  });

  it('hides a man 20 m into the corn from an officer at its edge, who sees him close by', () => {
    const sim = makeSim({ police: false });
    sim.clock.set(12);
    const f = farms.fields.find((q) => q.crop === 'corn')!;
    const x = rectCX(f.rect);
    const z = f.rect.maxZ - 20;
    teleport(sim, x, z);
    expect(sim.world.coverAt(x, z)).toBe(true);
    const cop = sim.spawnCharacter('cop', x, f.rect.maxZ + 0.5);
    // The corn hides nothing from a line of sight: the cover rule does.
    expect(sim.world.lineOfSight(cop.pos.x, cop.pos.y + 1.6, cop.pos.z, x, 1.2, z)).toBe(true);
    expect(sim.wanted.copWitness(x, z, 80, 0)).toBe(false);
    cop.pos.z = z + 8;
    expect(sim.wanted.copWitness(x, z, 80, 0)).toBe(true);
  });

  it('drags at a car driven through 60 m of corn, which keeps more than 12 m/s from 20', () => {
    const run = (corn: boolean) => {
      const sim = makeSim({ police: false });
      const f = farms.fields.find((q) => q.crop === 'corn')!;
      // Down the field's length, through its middle; the same run on the grass beside the plot for comparison.
      const x = corn ? rectCX(f.rect) : f.rect.minX - 20;
      const v = drive(sim, x, f.rect.minZ + 2, 0, 20);
      let speed = 0;
      step(sim, 6, () => {
        if (speed === 0 && v.pos.z > f.rect.minZ + 62) speed = v.speed;
        return input({ throttle: 1 });
      });
      return speed;
    };
    const corn = run(true);
    const grass = run(false);
    expect(corn).toBeGreaterThan(12);
    expect(grass - corn).toBeGreaterThan(3);
    console.log(`[country_farms] 60 m from 20 m/s at full throttle: ${corn.toFixed(1)} m/s through the corn, ${grass.toFixed(1)} on the grass`);
  });

  it('blows the propane tank up when a car breaks it, on the tick after', () => {
    const sim = makeSim({ police: false });
    step(sim, 0.05);
    const p = L.props[farms.propane]!;
    const v = sim.spawnVehicle('sedan', p.x + 10, p.z, 0);
    v.vel.x = -12;
    v.speed = 12;
    const blasts: Array<{ x: number; z: number; radius: number }> = [];
    sim.events.on('explosion', (e) => blasts.push(e));
    sim.onPropBroken(colliderOf(sim.world, farms.propane), v);
    expect(blasts).toEqual([]);
    step(sim, 0.05);
    expect(blasts.length).toBe(1);
    expect(Math.hypot(blasts[0]!.x - p.x, blasts[0]!.z - p.z)).toBeLessThan(0.01);
    step(sim, 1);
    expect(blasts.length).toBe(1);
  });

  it('stops sight and shots at a hedgerow, but not the camera', () => {
    const h = farms.hedges.find((q) => q.maxX - q.minX > 50)!;
    const x = rectCX(h);
    const hit = makeRayHit();
    expect(W.lineOfSight(x, 1.2, h.minZ - 5, x, 1.2, h.maxZ + 5)).toBe(false);
    expect(W.lineOfSight(x, HEDGE_H + 1, h.minZ - 5, x, HEDGE_H + 1, h.maxZ + 5)).toBe(true);
    expect(W.grid.raycast(x, 1.2, h.minZ - 5, 0, 0, 1, 10, hit, isSolidForSight)).toBe(true);
    expect(hit.collider!.tag).toBe('hedge');
    expect(W.grid.raycast(x, 1.2, h.minZ - 5, 0, 0, 1, 10, hit, blocksCamera)).toBe(false);
  });
});

describe('Las Lomas County: the cows', () => {
  /** Slot 0's player on foot beside cow `k`, 1.8 m off her flank. */
  function beside(sim: Sim, k: number): void {
    const p = sim.world.layout.props[farms.cows[k]!]!;
    teleport(sim, p.x + Math.cos(p.rot) * 1.8, p.z - Math.sin(p.rot) * 1.8);
  }

  it('are tipped with E beside one at 23:00, and not at noon', () => {
    const sim = makeSim({ police: false });
    const bigs: string[] = [];
    sim.events.on('big', (e) => bigs.push(e.text));
    beside(sim, 0);
    const c = colliderOf(sim.world, farms.cows[0]!);
    sim.clock.set(12);
    expect(sim.interactions.current()?.kind).toBe('cow');
    expect(sim.interactions.prompt()).toBe('She is wide awake. Come back after dark.');
    sim.interactions.interact();
    expect(c.broken).toBe(false);
    sim.clock.set(23);
    expect(sim.interactions.prompt()).toBe('Press E to tip the cow');
    sim.interactions.interact();
    expect(c.broken).toBe(true);
    expect(bigs).toEqual([`COW TIPPED 1/${COW_COUNT}`]);
    // Down, she says nothing more.
    expect(sim.interactions.prompt()).toBeNull();
    beside(sim, 1);
    sim.interactions.interact();
    expect(bigs[1]).toBe(`COW TIPPED 2/${COW_COUNT}`);
  });

  it('go over when a car hits one, slowing it hard, with no crash', () => {
    const sim = makeSim({ police: false });
    const p = sim.world.layout.props[farms.cows[3]!]!;
    const v = drive(sim, p.x - 6, p.z, Math.PI / 2, 10);
    const broken: number[] = [];
    let impacts = 0;
    sim.events.on('propBroken', (e) => broken.push(e.index));
    sim.events.on('impact', (e) => e.vehicle === v && impacts++);
    let after = 0;
    step(sim, 1, () => {
      if (after === 0 && broken.length > 0) after = v.speed;
      return input();
    });
    expect(broken).toContain(farms.cows[3]);
    expect(after).toBeLessThan(10 * 0.7);
    expect(impacts).toBe(0);
  });

  it('stand up again at 06:00, all of them, and not before', () => {
    expect(passedDawn(5.9, 6.01)).toBe(true);
    expect(passedDawn(23, 6.17)).toBe(true);
    expect(passedDawn(5.5, 5.99)).toBe(false);
    // A clock set back a little (a snapshot's) passes no dawn.
    expect(passedDawn(6.01, 5.99)).toBe(false);
    const sim = makeSim({ police: false });
    sim.clock.set(23);
    for (const k of [0, 5, 9]) {
      beside(sim, k);
      sim.interactions.interact();
    }
    const restored: number[][] = [];
    sim.events.on('propsRestored', (e) => restored.push(e.indices));
    sim.clock.set(5.9);
    step(sim, 1);
    expect(restored).toEqual([]);
    expect([0, 5, 9].every((k) => colliderOf(sim.world, farms.cows[k]!).broken)).toBe(true);
    // A game minute a real second: six minutes to dawn.
    step(sim, 6.5);
    expect(restored).toEqual([[0, 5, 9].map((k) => farms.cows[k]!).sort((a, b) => a - b)]);
    expect(farms.cows.some((i) => colliderOf(sim.world, i).broken)).toBe(false);
    // One dawn a day: nothing more the next minute, and no event at all on a dawn with every cow up.
    step(sim, 2);
    expect(restored.length).toBe(1);
  });

  it('stand up at 06:00 on a multiplayer client\'s mirror too, by the clock alone', () => {
    const mirror = new Mirror({ world: new StaticWorld() });
    const cow = farms.cows[2]!;
    mirror.applyWelcome({ type: 'welcome', playerId: 2, slot: 1, roomId: 'x', roomSeed: 1, tick: 0, tickRate: 60, snapshotRate: 20, brokenProps: [cow], signalHolds: [], pickups: [] });
    const restored: number[][] = [];
    mirror.events.on('propsRestored', (e) => restored.push(e.indices));
    const snapshot = (tick: number, hours: number): SnapshotMsg => ({
      type: 'snapshot', tick, ackSeq: 0, time: tick / 60, full: tick === 3, clock: { day: 1, hours, rate: 1 / 60 }, hud: { wanted: 0, searching: false, money: 0, clip: 0, ammo: 0, down: null, locked: false }, job: null,
      roster: null, weather: null, signalHolds: null, brokenProps: [], vehicles: [], characters: [], projectiles: [], helis: [], pickups: [], removed: [],
    });
    const c = colliderOf(mirror.world, cow);
    expect(c.broken).toBe(true);
    mirror.applySnapshot(snapshot(3, 5.98), 50);
    mirror.update(1 / 60, 66);
    expect(c.broken).toBe(true);
    mirror.applySnapshot(snapshot(6, 6.01), 100);
    expect(c.broken).toBe(false);
    expect(restored).toEqual([[cow]]);
    // Broken again by the server (a car after dawn): the mirror takes it.
    mirror.applySnapshot({ ...snapshot(9, 6.02), brokenProps: [cow] }, 150);
    expect(c.broken).toBe(true);
  });
});

describe('Las Lomas County: the scarecrows', () => {
  /** Knocks every scarecrow down under a car's bumper. */
  function knockAll(sim: Sim): void {
    const v = sim.spawnVehicle('sedan', 0, 0, 0);
    v.vel.x = 10;
    v.speed = 10;
    for (const i of farms.scarecrows) sim.onPropBroken(colliderOf(sim.world, i), v);
  }

  it('are twenty, and knocking them all down pays once and survives a save and a load', () => {
    const sim = makeSim({ police: false });
    teleport(sim, 0, 0);
    step(sim, 0.1);
    const bigs: string[] = [];
    sim.events.on('big', (e) => bigs.push(e.text));
    const money = sim.progress.money;
    knockAll(sim);
    expect(farmsState(sim.progress).knocked.size).toBe(SCARECROW_COUNT);
    expect(sim.progress.money).toBe(money + SCARECROW_REWARD);
    expect(bigs[0]).toBe('SCARECROWS 1/20');
    expect(bigs[bigs.length - 1]).toBe('SCARECROWS 20/20');
    sim.world.resetBroken();
    knockAll(sim);
    expect(sim.progress.money).toBe(money + SCARECROW_REWARD);
    const row = completionRows(sim, sim.players[0]!).find((r) => r.id === 'scarecrows')!;
    expect([row.done, row.total]).toEqual([20, 20]);

    const saved = JSON.parse(JSON.stringify(serializeExt(sim)));
    const next = makeSim({ police: false });
    applyExt(next, parseExt(saved));
    expect(farmsState(next.progress).knocked.size).toBe(SCARECROW_COUNT);
    expect(farmsState(next.progress).paid).toBe(true);
    teleport(next, 0, 0);
    step(next, 0.1);
    const before = next.progress.money;
    knockAll(next);
    expect(next.progress.money).toBe(before);
  });

  it('count for nobody in multiplayer', () => {
    const sim = makeSim({ police: false, multiplayer: true });
    step(sim, 0.1);
    knockAll(sim);
    expect(farmsState(sim.progress).knocked.size).toBe(0);
  });

  it('draw nothing from the sim\'s generator, nor do the cows', () => {
    const sim = makeSim({ police: false });
    step(sim, 0.1);
    const system = registeredSystems().find((s) => s.id === 'farms')!;
    const state = JSON.stringify(sim.rng);
    sim.clock.set(23);
    const p = sim.world.layout.props[farms.cows[0]!]!;
    teleport(sim, p.x + Math.cos(p.rot) * 1.8, p.z - Math.sin(p.rot) * 1.8);
    sim.interactions.interact();
    for (const i of farms.scarecrows) {
      sim.world.breakCollider(colliderOf(sim.world, i));
      sim.events.emit('propBroken', { index: i, dirX: 1, dirZ: 0 });
    }
    expect(farmsState(sim.progress).knocked.size).toBe(SCARECROW_COUNT);
    sim.clock.set(5.99);
    system.update(sim, 1 / 60);
    sim.clock.set(6.01);
    system.update(sim, 1 / 60);
    expect(colliderOf(sim.world, farms.cows[0]!).broken).toBe(false);
    expect(JSON.stringify(sim.rng)).toBe(state);
  });
});
