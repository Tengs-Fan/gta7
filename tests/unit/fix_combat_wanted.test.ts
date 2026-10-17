// Regression tests for the combat / wanted review findings.

import { describe, expect, it } from 'vitest';
import type { V3 } from '../../src/core/math';
import { Inventory } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import { STAR_HEAT } from '../../src/sim/wanted';
import { aimAt, input, makeSim, placeInCar, step, teleport } from './helpers';

/** The middle of a long straight lane with nothing static within a few metres (props knocked over). */
function openRoad(sim: Sim): { x: number; z: number; h: number } {
  for (const pr of sim.world.grid.colliders) if (pr.breakable || pr.tag === 'tree') pr.broken = true;
  for (const lane of sim.roads.lanes) {
    if (lane.length < 60) continue;
    const s = lane.length / 2;
    const x = lane.sx + lane.dx * s;
    const z = lane.sz + lane.dz * s;
    const rx = -Math.cos(lane.heading);
    const rz = Math.sin(lane.heading);
    let open = true;
    for (let a = -10; a <= 24 && open; a++) {
      for (let l = -4; l <= 4 && open; l++) open = sim.world.isFree(x + lane.dx * a + rx * l, z + lane.dz * a + rz * l, 0.5);
    }
    if (open) return { x, z, h: lane.heading };
  }
  throw new Error('no open road');
}

/** Player on foot on an open road, facing along it. Returns forward and right unit vectors. */
function standOnOpenRoad(sim: Sim): { h: number; fx: number; fz: number; rx: number; rz: number } {
  const r = openRoad(sim);
  teleport(sim, r.x, r.z);
  sim.player.heading = r.h;
  return { h: r.h, fx: Math.sin(r.h), fz: Math.cos(r.h), rx: -Math.cos(r.h), rz: Math.sin(r.h) };
}

/**
 * The on-foot aiming camera (CameraController): 2.4 m behind the head along the view, 0.62 m to the
 * right, 0.18 m up and never below ground + 0.35. The crosshair ray points at `target`, or along
 * `pitch` when no target is given.
 */
function shoulderAim(sim: Sim, yaw: number, pitch: number, target: V3 | null, over: Partial<PlayerInput> = {}): PlayerInput {
  const p = sim.player;
  const vx = Math.sin(yaw) * Math.cos(pitch);
  const vy = Math.sin(pitch);
  const vz = Math.cos(yaw) * Math.cos(pitch);
  const headY = p.pos.y + 1.58 * p.appearance.height;
  const ox = p.pos.x - vx * 2.4 - Math.cos(yaw) * 0.62;
  const oz = p.pos.z - vz * 2.4 + Math.sin(yaw) * 0.62;
  const o = { x: ox, y: Math.max(headY - vy * 2.4 + 0.18, sim.world.groundHeight(ox, oz) + 0.35), z: oz };
  let d = { x: vx, y: vy, z: vz };
  if (target) {
    const l = Math.hypot(target.x - o.x, target.y - o.y, target.z - o.z);
    d = { x: (target.x - o.x) / l, y: (target.y - o.y) / l, z: (target.z - o.z) / l };
  }
  return input({ aimOrigin: o, aimDir: d, cameraYaw: yaw, aim: true, ...over });
}

/** Records where each bullet of the player went. */
function recordShots(sim: Sim): Array<{ tx: number; tz: number; hit: string }> {
  const shots: Array<{ tx: number; tz: number; hit: string }> = [];
  sim.events.on('shot', (e) => {
    if (e.shooter === sim.player) shots.push({ tx: e.tx, tz: e.tz, hit: e.hit });
  });
  return shots;
}

describe('aiming from the shoulder camera', () => {
  it('ignores a van the camera is inside of, right behind the player', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    const civ = sim.spawnCharacter('civilian', p.pos.x + f.fx * 10, p.pos.z + f.fz * 10);
    const chest = () => ({ x: civ.pos.x, y: civ.pos.y + 1.2, z: civ.pos.z });
    const cam = shoulderAim(sim, f.h, -0.12, chest()).aimOrigin;
    // Parked across the road behind the player; at 2.4 m tall it swallows the camera.
    const van = sim.spawnVehicle('van', cam.x, cam.z, f.h + Math.PI / 2);
    expect(cam.y).toBeLessThan(van.pos.y + van.spec.height);
    const shots = recordShots(sim);
    for (let i = 0; i < 3; i++) {
      sim.update(1 / 60, shoulderAim(sim, f.h, -0.12, chest(), { fire: true, firePressed: true }));
      step(sim, 0.4, () => shoulderAim(sim, f.h, -0.12, chest()));
    }
    expect(shots.length).toBe(3);
    expect(van.health).toBe(van.spec.health);
    expect(civ.health).toBeLessThan(civ.maxHealth);
    for (const s of shots) expect((s.tx - p.pos.x) * f.fx + (s.tz - p.pos.z) * f.fz).toBeGreaterThan(1);
  });

  it('never launches a rocket backwards into a vehicle behind the player', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    p.inventory.give('rocket', 2);
    p.inventory.current = 'rocket';
    const ground = { x: p.pos.x + f.fx * 20, y: p.pos.y, z: p.pos.z + f.fz * 20 };
    const cam = shoulderAim(sim, f.h, -0.12, ground).aimOrigin;
    const van = sim.spawnVehicle('van', cam.x, cam.z, f.h + Math.PI / 2);
    let dir: { x: number; z: number } | null = null;
    sim.events.on('shot', (e) => {
      if (e.weapon === 'rocket') dir = { x: e.tx - e.fx, z: e.tz - e.fz };
    });
    sim.update(1 / 60, shoulderAim(sim, f.h, -0.12, ground, { fire: true, firePressed: true }));
    expect(dir).not.toBeNull();
    expect(dir!.x * f.fx + dir!.z * f.fz).toBeGreaterThan(0.5);
    step(sim, 2, () => shoulderAim(sim, f.h, -0.12, ground));
    expect(sim.deathKind).toBeNull();
    expect(p.alive).toBe(true);
    expect(van.destroyed).toBe(false);
  });

  it('aiming up with the camera pushed into a car behind does not shoot that car', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    const cam = shoulderAim(sim, f.h, 0.6, null).aimOrigin;
    const car = sim.spawnVehicle('sedan', cam.x, cam.z, f.h + Math.PI / 2);
    expect(cam.y).toBeLessThan(car.pos.y + car.spec.height);
    const shots = recordShots(sim);
    for (let i = 0; i < 3; i++) {
      sim.update(1 / 60, shoulderAim(sim, f.h, 0.6, null, { fire: true, firePressed: true }));
      step(sim, 0.4, () => shoulderAim(sim, f.h, 0.6, null));
    }
    expect(shots.length).toBe(3);
    expect(car.health).toBe(car.spec.health);
    for (const s of shots) expect((s.tx - p.pos.x) * f.fx + (s.tz - p.pos.z) * f.fz).toBeGreaterThan(1);
  });

  it('shoots past a van pressed against the shoulder-camera side', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    // Right next to the player on the camera side, so the crosshair ray runs inside it past the muzzle.
    const off = 0.5 + 2.1 / 2;
    const van = sim.spawnVehicle('van', p.pos.x + f.rx * off, p.pos.z + f.rz * off, f.h);
    const civ = sim.spawnCharacter('civilian', p.pos.x + f.fx * 10 + f.rx * 0.62, p.pos.z + f.fz * 10 + f.rz * 0.62);
    const chest = () => ({ x: civ.pos.x, y: civ.pos.y + 1.2, z: civ.pos.z });
    const shots = recordShots(sim);
    for (let i = 0; i < 3; i++) {
      sim.update(1 / 60, shoulderAim(sim, f.h, -0.12, chest(), { fire: true, firePressed: true }));
      step(sim, 0.4, () => shoulderAim(sim, f.h, -0.12, chest()));
    }
    expect(shots.length).toBe(3);
    expect(van.health).toBe(van.spec.health);
    expect(civ.health).toBeLessThan(civ.maxHealth);
  });
});

describe('reloading', () => {
  it('belongs to the weapon: switching guns mid-reload cancels it instead of blocking the new gun', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.give('smg', 120);
    p.inventory.current = 'pistol';
    const pistol = p.inventory.slots.get('pistol')!;
    const smg = p.inventory.slots.get('smg')!;
    const spot = { x: p.pos.x + f.fx * 25, y: p.pos.y, z: p.pos.z + f.fz * 25 };
    const aim = (over: Partial<PlayerInput> = {}) => aimAt(sim, spot, { aim: true, ...over });
    // Empty the pistol: the last shot starts its automatic reload.
    for (let i = 0; i < 12; i++) {
      if (i > 0) step(sim, 0.3, () => aim());
      sim.update(1 / 60, aim({ fire: true, firePressed: true }));
    }
    expect(pistol.clip).toBe(0);
    expect(p.reloadTimer).toBeGreaterThan(1);
    // Switch to the loaded SMG: the pending pistol reload is dropped at once (no RELOAD on the HUD).
    sim.update(1 / 60, aim({ selectSlot: 2 }));
    expect(p.inventory.current).toBe('smg');
    expect(p.reloadTimer).toBe(0);
    // Only the pistol's fire cooldown (0.25 s) delays the SMG, not the 1.2 s pistol reload.
    step(sim, 0.4, () => aim({ fire: true }));
    expect(smg.clip).toBeLessThan(30);
    // The dropped reload never lands on the SMG, and the pistol stays empty.
    const clip = smg.clip;
    const reserve = smg.ammo;
    step(sim, 2, () => aim());
    expect(smg.clip).toBe(clip);
    expect(smg.ammo).toBe(reserve);
    expect(pistol.clip).toBe(0);
    // R reloads the weapon in hand.
    sim.update(1 / 60, aim({ reload: true }));
    expect(p.reloadTimer).toBeGreaterThan(1.5);
    step(sim, 1.8, () => aim());
    expect(smg.clip).toBe(30);
    // Back on the pistol, pulling the trigger reloads it.
    sim.update(1 / 60, aim({ selectSlot: 1, fire: true, firePressed: true }));
    step(sim, 1.3, () => aim());
    expect(pistol.clip).toBe(12);
  });
});

describe('burning vehicles', () => {
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('traffic drivers bail out and run clear of the fire (heading %f)', (heading) => {
    const sim = makeSim();
    const r = openRoad(sim);
    const v = sim.spawnVehicle('sedan', r.x, r.z, heading);
    v.owner = 'traffic';
    const d = sim.addDriver(v, 'civilian', 'traffic');
    d.owner = 'traffic';
    sim.combat.damageVehicle(v, v.spec.health + 1, null, 'bullet');
    expect(v.burning).toBe(true);
    v.burnTimer = 4.5;
    step(sim, 1.5);
    expect(d.vehicle).toBeNull();
    expect(d.state).toBe('normal');
    expect(d.brain?.mode).toBe('flee');
    expect(Math.hypot(d.pos.x - v.pos.x, d.pos.z - v.pos.z)).toBeGreaterThan(v.halfL + 0.4);
    expect(d.health).toBeGreaterThan(70);
    step(sim, 4);
    expect(v.destroyed).toBe(true);
    expect(d.alive).toBe(true);
  });
});

describe('crime heat per trigger pull', () => {
  function pullTrigger(sim: Sim, target: V3): void {
    sim.update(1 / 60, aimAt(sim, target, { fire: true, firePressed: true, aim: true }));
    step(sim, 0.3, () => aimAt(sim, target, { aim: true }));
  }

  it('one shotgun blast at an officer is one assault, not one per pellet', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    p.inventory.give('shotgun', 24);
    p.inventory.current = 'shotgun';
    const cop = sim.spawnCharacter('swat', p.pos.x + f.fx * 6, p.pos.z + f.fz * 6);
    cop.armor = 5000;
    const shots = recordShots(sim);
    pullTrigger(sim, { x: cop.pos.x, y: cop.pos.y + 1.2, z: cop.pos.z });
    expect(cop.alive).toBe(true);
    expect(shots.filter((s) => s.hit === 'flesh').length).toBeGreaterThanOrEqual(3);
    expect(sim.wanted.level).toBe(1);
    expect(sim.wanted.heat).toBeLessThan(STAR_HEAT[2]);
  });

  it('one shotgun blast at a police car is one assault, not one per pellet', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    p.inventory.give('shotgun', 24);
    p.inventory.current = 'shotgun';
    const car = sim.spawnVehicle('police', p.pos.x + f.fx * 7, p.pos.z + f.fz * 7, f.h + Math.PI / 2);
    pullTrigger(sim, { x: car.pos.x, y: car.pos.y + 0.8, z: car.pos.z });
    expect(car.health).toBeLessThan(car.spec.health - 50);
    expect(sim.wanted.level).toBe(1);
    expect(sim.wanted.heat).toBeLessThan(STAR_HEAT[2]);
  });

  it('separate shots at an officer still add up', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    const cop = sim.spawnCharacter('cop', p.pos.x + f.fx * 6, p.pos.z + f.fz * 6);
    cop.armor = 5000;
    const chest = { x: cop.pos.x, y: cop.pos.y + 1.2, z: cop.pos.z };
    pullTrigger(sim, chest);
    pullTrigger(sim, chest);
    expect(sim.wanted.heat).toBeGreaterThanOrEqual(2 * 150);
    expect(sim.wanted.level).toBe(2);
  });
});

describe('mission wanted floor', () => {
  it('clear() drops the level to the floor and keeps the floor', () => {
    const sim = makeSim();
    sim.wanted.floor = 3;
    sim.wanted.setLevel(5);
    const levels: number[] = [];
    sim.events.on('wanted', (e) => levels.push(e.level));
    sim.wanted.clear();
    step(sim, 0.5);
    expect(sim.wanted.level).toBe(3);
    expect(sim.wanted.floor).toBe(3);
    expect(levels).not.toContain(0);
    sim.wanted.floor = 0;
    sim.wanted.clear();
    expect(sim.wanted.level).toBe(0);
  });

  it('a respray during a mission keeps its minimum wanted level', () => {
    const sim = makeSim();
    const spray = sim.world.layout.pois.find((q) => q.id === 'spray_docks')!;
    const bay = spray.bay!;
    const v = sim.spawnVehicle('sedan', (bay.minX + bay.maxX) / 2, (bay.minZ + bay.maxZ) / 2, spray.heading + Math.PI);
    placeInCar(sim, v);
    v.health = v.spec.health * 0.4;
    sim.policeEnabled = false;
    // What The Big Score does after the vault. (The shop may also refuse service while pinned.)
    sim.wanted.floor = 4;
    sim.wanted.setLevel(4);
    step(sim, 0.5);
    expect(sim.wanted.floor).toBe(4);
    expect(sim.wanted.level).toBe(4);
    step(sim, 5);
    expect(sim.wanted.level).toBe(4);
  });
});

describe('weapon cycling', () => {
  function inventory(): Inventory {
    const inv = new Inventory();
    inv.give('pistol', 48);
    inv.give('smg', 120);
    inv.give('rocket', 4);
    return inv;
  }

  function empty(inv: Inventory, id: 'pistol' | 'smg' | 'rocket'): void {
    const s = inv.slots.get(id)!;
    s.clip = 0;
    s.ammo = 0;
  }

  it('steps to the slot-order neighbours of an empty current weapon', () => {
    const inv = inventory();
    empty(inv, 'pistol');
    inv.current = 'pistol';
    inv.cycle(1);
    expect(inv.current).toBe('smg');
    inv.current = 'pistol';
    inv.cycle(-1);
    expect(inv.current).toBe('fists');

    const top = inventory();
    empty(top, 'rocket');
    top.current = 'rocket';
    top.cycle(1);
    expect(top.current).toBe('fists');
    top.current = 'rocket';
    top.cycle(-1);
    expect(top.current).toBe('smg');
  });

  it('still skips empty weapons that are not in hand', () => {
    const inv = inventory();
    empty(inv, 'smg');
    inv.current = 'pistol';
    inv.cycle(1);
    expect(inv.current).toBe('rocket');
    inv.cycle(-1);
    expect(inv.current).toBe('pistol');
    inv.cycle(-1);
    expect(inv.current).toBe('fists');
    inv.cycle(-1);
    expect(inv.current).toBe('rocket');
  });
});
