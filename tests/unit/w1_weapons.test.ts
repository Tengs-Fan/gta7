// Wave 1 weapons (VAL-WPN-001..009): bat and knife, grenade, molotov fire, sniper scope, the shop and world pickups, the
// rocket into the sea, and no blood from hits god mode stops.

import { describe, expect, it } from 'vitest';
import type { Character } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import { FIRE_LIFE, FIRE_MAX_R, FIRE_PATCH_R } from '../../src/sim/fire';
import { shopItems } from '../../src/sim/interactions';
import { parseSave, serialize } from '../../src/sim/progress';
import type { Sim } from '../../src/sim/sim';
import { isGun, WEAPON_ORDER, weaponForKey, weaponKindOf, WEAPONS, type WeaponId } from '../../src/sim/specs';
import { THROW_GRAVITY, Thrown } from '../../src/sim/throwables';
import { WATER_Y } from '../../src/world/constants';
import { aimAt, input, makeSim, step, teleport } from './helpers';

const NEW: WeaponId[] = ['bat', 'knife', 'grenade', 'molotov', 'sniper'];

function record<K extends keyof SimEvents>(sim: Sim, type: K): Array<SimEvents[K] & { t: number }> {
  const out: Array<SimEvents[K] & { t: number }> = [];
  sim.events.on(type, (e) => out.push({ ...e, t: sim.time }));
  return out;
}

/** The player on foot on a stretch of road clear for 30 m ahead and 5 m to either side, facing along it. */
function openRoad(sim: Sim): { x: number; z: number; h: number; fx: number; fz: number; rx: number; rz: number } {
  for (const lane of sim.roads.lanes) {
    if (lane.length < 60) continue;
    const x = lane.sx + lane.dx * 15;
    const z = lane.sz + lane.dz * 15;
    const rx = -Math.cos(lane.heading);
    const rz = Math.sin(lane.heading);
    let open = true;
    for (let a = -6; a <= 32 && open; a += 2) for (let l = -5; l <= 5 && open; l++) open = sim.world.isFree(x + lane.dx * a + rx * l, z + lane.dz * a + rz * l, 0.5) && sim.world.waterDepth(x + lane.dx * a, z + lane.dz * a) < -0.5;
    if (!open) continue;
    teleport(sim, x, z);
    sim.player.heading = lane.heading;
    return { x, z, h: lane.heading, fx: Math.sin(lane.heading), fz: Math.cos(lane.heading), rx, rz };
  }
  throw new Error('no open road');
}

function npc(sim: Sim, role: 'civilian' | 'cop' | 'gang', x: number, z: number): Character {
  const c = sim.spawnCharacter(role, x, z);
  c.owner = 'mission';
  c.persistent = true;
  return c;
}

function arm(sim: Sim, id: WeaponId, ammo = 20): void {
  sim.player.inventory.give(id, ammo);
  sim.player.inventory.current = id;
}

/** A dry spot on the west quay facing the open sea (heading -x), with deep water 20-60 m out. */
function quay(sim: Sim): { x: number; z: number } {
  const b = sim.world.layout.bounds;
  for (let z = b.landMinZ + 40; z < b.landMaxZ - 40; z += 7) {
    for (let x = b.landMinX + 6; x > b.landMinX - 1; x -= 0.5) {
      if (!sim.world.isFree(x, z, 0.6) || sim.world.waterDepth(x, z) > -0.3) continue;
      let deep = true;
      for (let d = 15; d <= 60 && deep; d += 5) deep = sim.world.waterDepth(x - d, z) > 1.5;
      if (deep) return { x, z };
    }
  }
  throw new Error('no quay');
}

describe('VAL-WPN-001: five new weapons as data, selectable by key and wheel', () => {
  it('the specs and the key slots', () => {
    for (const id of NEW) expect(WEAPONS[id], id).toBeDefined();
    expect(NEW.map(weaponKindOf)).toEqual(['melee', 'melee', 'thrown', 'thrown', 'gun']);
    expect(isGun('sniper')).toBe(true);
    expect(isGun('bat')).toBe(false);
    for (const id of NEW) expect(WEAPON_ORDER).toContain(id);
    const all = () => true;
    // Key 7 is the bat or the knife, key 8 a grenade or a molotov, key 9 the sniper rifle.
    expect(weaponForKey(6, all, 'fists')).toBe('bat');
    expect(weaponForKey(6, all, 'bat')).toBe('knife');
    expect(weaponForKey(6, all, 'knife')).toBe('bat');
    expect(weaponForKey(7, all, 'fists')).toBe('grenade');
    expect(weaponForKey(7, all, 'grenade')).toBe('molotov');
    expect(weaponForKey(8, all, 'fists')).toBe('sniper');
    expect(weaponForKey(6, (id) => id === 'knife', 'fists')).toBe('knife');
    expect(weaponForKey(8, (id) => id === 'fists', 'fists')).toBeNull();
    // Keys 1-6 are unchanged.
    for (let i = 0; i < 6; i++) expect(weaponForKey(i, all, 'fists')).toBe(['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'rocket'][i]);
  });

  it('the player draws each by its key and by the weapon wheel, and the HUD-facing state reports it', () => {
    const sim = makeSim();
    const inv = sim.player.inventory;
    for (const id of NEW) inv.give(id, 5);
    const press = (slot: number) => step(sim, 1 / 60, input({ selectSlot: slot }));
    press(6);
    expect(inv.current).toBe('bat');
    press(6);
    expect(inv.current).toBe('knife');
    press(7);
    expect(inv.current).toBe('grenade');
    press(7);
    expect(inv.current).toBe('molotov');
    press(8);
    expect(inv.current).toBe('sniper');
    // The wheel steps through every owned weapon, the new ones included.
    inv.current = 'fists';
    const seen = new Set<WeaponId>();
    for (let i = 0; i < 12; i++) {
      step(sim, 1 / 60, input({ nextWeapon: true }));
      seen.add(inv.current);
    }
    for (const id of NEW) expect(seen.has(id), id).toBe(true);
  });

  it('a save holding them round-trips; a save without them loads unchanged', () => {
    const sim = makeSim();
    for (const id of NEW) sim.player.inventory.give(id, 4);
    const weapons = sim.player.inventory.owned().filter((w) => w !== 'fists').map((id) => ({ id, ammo: sim.player.inventory.total(id) }));
    const save = parseSave(JSON.parse(JSON.stringify(serialize(sim.progress, weapons, 0, 12, 1))))!;
    expect(save.weapons).toEqual(weapons);
    const old = parseSave(JSON.parse(JSON.stringify(serialize(sim.progress, [{ id: 'pistol', ammo: 40 }], 0, 12, 1))))!;
    expect(old.weapons).toEqual([{ id: 'pistol', ammo: 40 }]);
  });
});

describe('VAL-WPN-002: bat and knife', () => {
  function setup(weapon: WeaponId, dist = 1.2) {
    const sim = makeSim();
    const f = openRoad(sim);
    arm(sim, weapon, 1);
    const civ = npc(sim, 'civilian', f.x + f.fx * dist, f.z + f.fz * dist);
    return { sim, f, civ, p: sim.player };
  }

  it('a bat hit deals more than a fist and floors him; the same assault crime as a punch', () => {
    const fist = setup('fists');
    fist.sim.combat.melee(fist.p);
    const fistLoss = fist.civ.maxHealth - fist.civ.health;
    const bat = setup('bat');
    npc(bat.sim, 'cop', bat.f.x - bat.f.fx * 6, bat.f.z - bat.f.fz * 6);
    bat.sim.combat.melee(bat.p);
    const batLoss = bat.civ.maxHealth - bat.civ.health;
    expect(batLoss).toBeGreaterThan(fistLoss);
    expect(bat.civ.state).toBe('knocked');
    expect(bat.sim.wanted.lastCrime).toBe('assault');
    expect(bat.sim.wanted.level).toBe(1);
    // A punch seen by the same officer is the same crime.
    const fist2 = setup('fists');
    npc(fist2.sim, 'cop', fist2.f.x - fist2.f.fx * 6, fist2.f.z - fist2.f.fz * 6);
    fist2.sim.combat.melee(fist2.p);
    expect(fist2.sim.wanted.lastCrime).toBe('assault');
  });

  it('a knife cut bleeds for a few seconds after the hit, then stops', () => {
    const { sim, civ, p } = setup('knife');
    sim.combat.melee(p);
    const afterHit = civ.health;
    expect(civ.maxHealth - afterHit).toBeCloseTo(WEAPONS.knife.damage, 5);
    step(sim, 2);
    const mid = civ.health;
    expect(mid).toBeLessThan(afterHit - 5);
    step(sim, 4);
    const end = civ.health;
    step(sim, 3);
    expect(civ.health).toBe(end);
    expect(afterHit - end).toBeCloseTo(WEAPONS.knife.melee!.bleed!.dps * WEAPONS.knife.melee!.bleed!.seconds, 0);
  });

  it('repeated presses chain swings with a shorter cooldown than the first', () => {
    for (const w of ['bat', 'knife'] as const) {
      const { sim } = setup(w, 30);
      const swings = record(sim, 'melee');
      step(sim, 3, input({ fire: true, firePressed: true }));
      const t = swings.map((s) => s.t);
      expect(t.length, w).toBeGreaterThanOrEqual(3);
      const first = t[1]! - t[0]!;
      const chained = t[2]! - t[1]!;
      expect(first).toBeGreaterThanOrEqual(1 / WEAPONS[w].rate - 0.02);
      expect(chained, w).toBeLessThan(first * 0.8);
    }
  });

  it('neither reaches beyond its range or through a wall', () => {
    for (const [w, d] of [['bat', 2.4], ['knife', 1.8]] as const) {
      const { sim, civ, p } = setup(w, d);
      sim.combat.melee(p);
      expect(civ.health, w).toBe(civ.maxHealth);
    }
    for (const w of ['bat', 'knife'] as const) {
      const { sim, f, civ, p } = setup(w, 1.3);
      const cx = f.x + f.fx * 0.65;
      const cz = f.z + f.fz * 0.65;
      const hx = Math.abs(f.fx) * 0.05 + Math.abs(f.rx) * 3;
      const hz = Math.abs(f.fz) * 0.05 + Math.abs(f.rz) * 3;
      sim.world.grid.addBox(cx - hx, cz - hz, cx + hx, cz + hz, p.pos.y - 0.5, p.pos.y + 3, 'wall');
      sim.combat.melee(p);
      expect(civ.health, w).toBe(civ.maxHealth);
    }
  });
});

describe('VAL-WPN-003: grenades', () => {
  it('a ballistic arc, bounces, a 3 s fuse, and blast damage falling off with distance', () => {
    const sim = makeSim();
    const f = openRoad(sim);
    arm(sim, 'grenade', 3);
    const blasts = record(sim, 'explosion');
    const thrown = record(sim, 'thrown');
    const dir = { x: f.fx * 0.95, y: 0.3, z: f.fz * 0.95 };
    const l = Math.hypot(dir.x, dir.y, dir.z);
    step(sim, 1 / 60, input({ fire: true, firePressed: true, aimDir: { x: dir.x / l, y: dir.y / l, z: dir.z / l } }));
    expect(thrown.length).toBe(1);
    expect(sim.player.inventory.total('grenade')).toBe(2);
    const g = sim.combat.throws.list[0]!;
    const p0 = { x: thrown[0]!.x, y: thrown[0]!.y, z: thrown[0]!.z };
    const v0 = { x: g.vel.x, y: g.vel.y + THROW_GRAVITY * g.age, z: g.vel.z };
    let maxErr = 0;
    let lastBounces = 0;
    while (g.bounces === 0 && !g.removed) {
      step(sim, 1 / 60);
      if (g.bounces > 0) break;
      const t = g.age;
      const ex = p0.y + v0.y * t - 0.5 * THROW_GRAVITY * t * t;
      maxErr = Math.max(maxErr, Math.abs(g.pos.y - ex), Math.abs(g.pos.x - (p0.x + v0.x * t)));
    }
    expect(maxErr).toBeLessThan(0.03);
    while (!g.removed) {
      lastBounces = g.bounces;
      step(sim, 1 / 60);
    }
    expect(lastBounces).toBeGreaterThanOrEqual(2);
    expect(blasts.length).toBe(1);
    expect(blasts[0]!.t - thrown[0]!.t).toBeGreaterThan(2.9);
    expect(blasts[0]!.t - thrown[0]!.t).toBeLessThan(3.1);
  });

  it('bounces off a wall with less speed', () => {
    const sim = makeSim();
    const f = openRoad(sim);
    const p = sim.player;
    const cx = f.x + f.fx * 6;
    const cz = f.z + f.fz * 6;
    const hx = Math.abs(f.fx) * 0.2 + Math.abs(f.rx) * 4;
    const hz = Math.abs(f.fz) * 0.2 + Math.abs(f.rz) * 4;
    sim.world.grid.addBox(cx - hx, cz - hz, cx + hx, cz + hz, p.pos.y - 0.5, p.pos.y + 6, 'wall');
    const g = new Thrown(sim.newId(), 'grenade', { x: f.x + f.fx * 2, y: p.pos.y + 1.5, z: f.z + f.fz * 2 }, { x: f.fx * 12, y: 1, z: f.fz * 12 }, p);
    sim.combat.throws.list.push(g);
    step(sim, 0.5);
    const along = g.vel.x * f.fx + g.vel.z * f.fz;
    expect(g.bounces).toBeGreaterThanOrEqual(1);
    expect(along).toBeLessThan(0);
    expect(Math.abs(along)).toBeLessThan(12 * 0.5);
    expect((g.pos.x - f.x) * f.fx + (g.pos.z - f.z) * f.fz).toBeLessThan(6);
  });

  it('blast damage falls off with distance, and a car in reach is damaged', () => {
    const sim = makeSim();
    const f = openRoad(sim);
    const at = { x: f.x + f.fx * 12, z: f.z + f.fz * 12 };
    const y = sim.world.groundHeight(at.x, at.z);
    const near = npc(sim, 'civilian', at.x + f.rx * 2, at.z + f.rz * 2);
    const mid = npc(sim, 'civilian', at.x - f.rx * 4, at.z - f.rz * 4);
    const far = npc(sim, 'civilian', at.x + f.fx * 6, at.z + f.fz * 6);
    for (const c of [near, mid, far]) c.maxHealth = c.health = 1000;
    const car = sim.spawnVehicle('sedan', at.x - f.fx * 4, at.z - f.fz * 4, f.h);
    const g = new Thrown(sim.newId(), 'grenade', { x: at.x, y, z: at.z }, { x: 0, y: 0, z: 0 }, sim.player);
    g.resting = true;
    g.age = 2.9;
    sim.combat.throws.list.push(g);
    step(sim, 0.2);
    const loss = (c: Character) => c.maxHealth - c.health;
    expect(loss(near)).toBeGreaterThan(loss(mid));
    expect(loss(mid)).toBeGreaterThan(loss(far));
    expect(loss(far)).toBeGreaterThan(0);
    expect(car.health).toBeLessThan(car.spec.health * 0.6);
  });

  it('into deep water it goes off as a water plume, not a land blast; same-seed throws are identical', () => {
    const run = () => {
      const sim = makeSim({ seed: 3 });
      const q = quay(sim);
      teleport(sim, q.x, q.z);
      arm(sim, 'grenade', 2);
      const blasts = record(sim, 'explosion');
      const splashes = record(sim, 'splash');
      step(sim, 1 / 60, input({ fire: true, firePressed: true, aimDir: { x: -0.9, y: 0.43, z: 0 } }));
      const path: number[] = [];
      for (let i = 0; i < 240; i++) {
        step(sim, 1 / 60);
        const g = sim.combat.throws.list[0];
        if (g) path.push(g.pos.x, g.pos.y, g.pos.z);
      }
      return { blasts, splashes, path, wanted: sim.wanted.level };
    };
    const a = run();
    expect(a.blasts.length).toBe(1);
    expect(Math.abs(a.blasts[0]!.y - WATER_Y)).toBeLessThan(0.05);
    expect(a.splashes.some((s) => s.big)).toBe(true);
    expect(a.wanted).toBe(0);
    const b = run();
    expect(b.path).toEqual(a.path);
  });
});

describe('VAL-WPN-004: molotov fire', () => {
  it('a thrown molotov breaks and the fire spreads from its first radius, stays within its maximum and is out within 15 s', () => {
    const sim = makeSim();
    const f = openRoad(sim);
    arm(sim, 'molotov', 2);
    const started = record(sim, 'fireStarted');
    step(sim, 1 / 60, input({ fire: true, firePressed: true, aimDir: { x: f.fx * 0.95, y: 0.3, z: f.fz * 0.95 } }));
    for (let i = 0; i < 180 && started.length === 0; i++) step(sim, 1 / 60);
    expect(started.length).toBe(1);
    const fire = sim.combat.fire.areas[0]!;
    const radii: number[] = [];
    const t0 = sim.time;
    while (sim.combat.fire.areas.length > 0 && sim.time - t0 < 20) {
      radii.push(fire.radius);
      step(sim, 0.5);
    }
    expect(radii[0]).toBeLessThanOrEqual(FIRE_PATCH_R + 1e-6);
    expect(Math.max(...radii)).toBeGreaterThan(FIRE_PATCH_R + 1.5);
    expect(Math.max(...radii)).toBeLessThanOrEqual(FIRE_MAX_R + 1e-6);
    expect(sim.time - t0).toBeLessThanOrEqual(15);
    expect(FIRE_LIFE).toBeLessThan(15);
  });

  it('a pedestrian in it catches fire and is hurt; a car in it burns; the thrower answers for it', () => {
    const sim = makeSim();
    const f = openRoad(sim);
    const at = { x: f.x + f.fx * 12, z: f.z + f.fz * 12 };
    const civ = npc(sim, 'civilian', at.x + f.rx * 0.6, at.z + f.rz * 0.6);
    civ.maxHealth = civ.health = 400;
    const car = sim.spawnVehicle('sedan', at.x - f.rx * 2.4, at.z - f.rz * 2.4, f.h);
    const fire = sim.combat.fire.ignite(at.x, sim.world.groundHeight(at.x, at.z), at.z, sim.player)!;
    expect(fire).not.toBeNull();
    step(sim, 0.5);
    expect(civ.burnTimer).toBeGreaterThan(0);
    const damage = record(sim, 'damage');
    step(sim, 4.5);
    expect(civ.health).toBeLessThan(400 - 40);
    expect(damage.some((d) => d.victim === civ && d.kind === 'fire')).toBe(true);
    expect(car.burning || car.destroyed).toBe(true);
  });

  it('on water there is no fire, and the spread is the same for the same seed', () => {
    const sim = makeSim();
    const q = quay(sim);
    expect(sim.combat.fire.ignite(q.x - 30, WATER_Y, q.z, sim.player)).toBeNull();
    teleport(sim, q.x, q.z);
    arm(sim, 'molotov', 1);
    step(sim, 1 / 60, input({ fire: true, firePressed: true, aimDir: { x: -0.9, y: 0.43, z: 0 } }));
    step(sim, 4);
    expect(sim.combat.fire.areas.length).toBe(0);
    const spread = () => {
      const s = makeSim({ seed: 9 });
      const f = openRoad(s);
      s.combat.fire.ignite(f.x + f.fx * 10, s.world.groundHeight(f.x + f.fx * 10, f.z + f.fz * 10), f.z + f.fz * 10, null);
      step(s, 5);
      return JSON.stringify(s.combat.fire.areas.map((a) => a.patches));
    };
    expect(spread()).toBe(spread());
  });
});

describe('VAL-WPN-005: sniper rifle', () => {
  it('kills an unarmoured pedestrian 80 m away with one head shot; the head damage covers a civilian’s health', () => {
    expect(WEAPONS.sniper.damage * WEAPONS.sniper.headMul).toBeGreaterThanOrEqual(100);
    const sim = makeSim();
    const f = openRoad(sim);
    arm(sim, 'sniper', 20);
    let civ: Character | null = null;
    for (let d = 80; d > 60 && !civ; d -= 2) {
      const x = f.x + f.fx * d;
      const z = f.z + f.fz * d;
      if (sim.world.isFree(x, z, 0.5) && sim.world.lineOfSight(f.x, sim.player.pos.y + 1.6, f.z, x, sim.world.groundHeight(x, z) + 1.7, z)) civ = npc(sim, 'civilian', x, z);
    }
    expect(civ).not.toBeNull();
    const head = { x: civ!.pos.x, y: civ!.pos.y + civ!.height * 0.93, z: civ!.pos.z };
    step(sim, 0.5, aimAt(sim, head, { aim: true }));
    step(sim, 1 / 60, aimAt(sim, head, { aim: true, fire: true, firePressed: true }));
    expect(civ!.alive).toBe(false);
  });

  it('the wheel changes the scope zoom while the scope is up, and lowering it resets the zoom', () => {
    const sim = makeSim();
    arm(sim, 'sniper', 20);
    const p = sim.player;
    step(sim, 0.1, input({ aim: true }));
    expect(p.aimZoom).toBe(true);
    expect(p.scopeLevel).toBe(0);
    step(sim, 1 / 60, input({ aim: true, nextWeapon: true }));
    expect(p.scopeLevel).toBe(1);
    expect(p.inventory.current).toBe('sniper');
    step(sim, 1 / 60, input({ aim: true, prevWeapon: true }));
    expect(p.scopeLevel).toBe(0);
    step(sim, 1 / 60, input({ aim: true, nextWeapon: true }));
    step(sim, 1 / 60, input({}));
    expect(p.scopeLevel).toBe(0);
    expect(WEAPONS.sniper.scope!.zooms[0]).toBeGreaterThanOrEqual(3);
    expect(WEAPONS.sniper.scope!.zooms.length).toBeGreaterThanOrEqual(2);
  });
});

describe('VAL-WPN-006: gun stores and world pickups', () => {
  it('the shop lists the new weapons at prices rising with their power, and refuses when money is short', () => {
    const items = shopItems();
    const price = (id: WeaponId) => items.find((i) => i.weapon === id)!.price;
    for (const id of NEW) expect(items.some((i) => i.weapon === id), id).toBe(true);
    const order: WeaponId[] = ['bat', 'knife', 'molotov', 'grenade', 'sniper'];
    for (let i = 1; i < order.length; i++) expect(price(order[i]!)).toBeGreaterThan(price(order[i - 1]!));
    const sim = makeSim();
    sim.progress.money = 700;
    expect(sim.interactions.buy('buy:sniper')).toMatch(/afford/);
    expect(sim.progress.money).toBe(700);
    expect(sim.interactions.buy('buy:bat')).toBeNull();
    expect(sim.progress.money).toBe(700 - price('bat'));
    expect(sim.player.inventory.current).toBe('bat');
    expect(sim.interactions.buy('buy:bat')).toMatch(/already/);
    expect(sim.interactions.buy('buy:grenade')).toBeNull();
    expect(sim.player.inventory.total('grenade')).toBe(WEAPONS.grenade.ammoPack);
  });

  it('each new weapon lies somewhere in the world, is collected and comes back', () => {
    const sim = makeSim({ streetCrime: true });
    for (const id of NEW) {
      const pk = sim.pickups.find((p) => p.kind === 'weapon' && p.weapon === id);
      expect(pk, id).toBeDefined();
      teleport(sim, pk!.pos.x, pk!.pos.z);
      step(sim, 0.1);
      expect(sim.player.inventory.has(id), id).toBe(true);
      expect(pk!.active).toBe(false);
      teleport(sim, pk!.pos.x + 30, pk!.pos.z);
      step(sim, pk!.respawn + 1);
      expect(pk!.active, id).toBe(true);
    }
    // Off (the default), the older pickups are as they were.
    expect(makeSim().pickups.some((p) => p.weapon === 'bat')).toBe(false);
  });
});

describe('VAL-WPN-008: a rocket into the sea earns no wanted star', () => {
  it('from the quay with nobody near: wanted stays 0; at the street near people it rises, and so does a grenade', () => {
    const sim = makeSim();
    const q = quay(sim);
    teleport(sim, q.x, q.z);
    arm(sim, 'rocket', 4);
    const blasts = record(sim, 'explosion');
    const target = { x: q.x - 35, y: WATER_Y, z: q.z };
    step(sim, 0.3, aimAt(sim, target, { aim: true }));
    step(sim, 1 / 60, aimAt(sim, target, { aim: true, fire: true, firePressed: true }));
    step(sim, 10);
    expect(blasts.length).toBe(1);
    expect(Math.abs(blasts[0]!.y - WATER_Y)).toBeLessThan(0.05);
    expect(sim.wanted.level).toBe(0);

    const s2 = makeSim();
    const f = openRoad(s2);
    for (let k = 0; k < 3; k++) npc(s2, 'civilian', f.x + f.fx * 20 + f.rx * (k - 1) * 3, f.z + f.fz * 20 + f.rz * (k - 1) * 3);
    arm(s2, 'rocket', 4);
    const at = { x: f.x + f.fx * 18, y: s2.world.groundHeight(f.x + f.fx * 18, f.z + f.fz * 18), z: f.z + f.fz * 18 };
    step(s2, 0.3, aimAt(s2, at, { aim: true }));
    step(s2, 1 / 60, aimAt(s2, at, { aim: true, fire: true, firePressed: true }));
    step(s2, 2);
    expect(s2.wanted.level).toBeGreaterThanOrEqual(1);

    const s3 = makeSim();
    const f3 = openRoad(s3);
    npc(s3, 'civilian', f3.x + f3.fx * 10, f3.z + f3.fz * 10);
    const g = new Thrown(s3.newId(), 'grenade', { x: f3.x + f3.fx * 8, y: s3.world.groundHeight(f3.x + f3.fx * 8, f3.z + f3.fz * 8), z: f3.z + f3.fz * 8 }, { x: 0, y: 0, z: 0 }, s3.player);
    g.resting = true;
    g.age = 2.95;
    s3.combat.throws.list.push(g);
    step(s3, 0.5);
    expect(s3.wanted.level).toBeGreaterThanOrEqual(1);
  });
});

describe('VAL-WPN-009: no blood from hits god mode stops', () => {
  function shootPlayer(god: boolean) {
    const sim = makeSim({ police: false });
    const f = openRoad(sim);
    sim.cheats.godMode = god;
    sim.player.maxHealth = sim.player.health = 5000;
    let onPlayer = 0;
    sim.events.on('shot', (s) => {
      if (s.hit === 'flesh' && Math.hypot(s.tx - sim.player.pos.x, s.tz - sim.player.pos.z) < 0.8) onPlayer++;
    });
    const g = npc(sim, 'gang', f.x + f.fx * 4, f.z + f.fz * 4);
    g.inventory.infinite = true;
    g.inventory.give('pistol', 999);
    g.inventory.current = 'pistol';
    g.heading = f.h + Math.PI;
    const civ = npc(sim, 'civilian', f.x + f.fx * 4 + f.rx * 3, f.z + f.fz * 4 + f.rz * 3);
    const blood = record(sim, 'blood');
    const damage = record(sim, 'damage');
    for (let i = 0; i < 30; i++) {
      sim.combat.npcFire(g, sim.player, 1);
      step(sim, 0.6);
    }
    // A bat swing at the player too.
    const b = npc(sim, 'gang', sim.player.pos.x + f.fx * 1.2, sim.player.pos.z + f.fz * 1.2);
    b.inventory.give('bat', 1);
    b.inventory.current = 'bat';
    b.heading = f.h + Math.PI;
    const before = sim.player.health;
    const bloodBefore = blood.length;
    sim.combat.melee(b);
    const batBlood = blood.length - bloodBefore;
    // Other characters still bleed.
    const civBefore = blood.length;
    sim.combat.npcFire(g, civ, 1);
    for (let i = 0; i < 20 && blood.length === civBefore; i++) {
      step(sim, 0.6);
      sim.combat.npcFire(g, civ, 1);
    }
    return { blood: bloodBefore, onPlayer, damage: damage.filter((d) => d.victim === sim.player).length, batBlood, batLoss: before - sim.player.health, civBled: blood.length > civBefore };
  }

  it('god mode: hits on the player do no damage and spray no blood; off: they do both', () => {
    const on = shootPlayer(true);
    expect(on.onPlayer).toBeGreaterThan(0);
    expect(on.blood).toBe(0);
    expect(on.damage).toBe(0);
    expect(on.batBlood).toBe(0);
    expect(on.batLoss).toBe(0);
    expect(on.civBled).toBe(true);
    const off = shootPlayer(false);
    expect(off.onPlayer).toBeGreaterThan(0);
    expect(off.blood).toBe(off.onPlayer);
    expect(off.damage).toBeGreaterThan(0);
    expect(off.batBlood).toBe(1);
    expect(off.batLoss).toBeGreaterThan(0);
  });
});
