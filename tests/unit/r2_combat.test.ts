// Round 2, combat cluster: one weaponFired per trigger pull and 'damage' events (P5), aim intent and
// the fresh firing ray (P30), shots that stop at walls plus flashes and tracers that always render
// (P31b), and fire cadence, head volumes, blast exposure and table-driven numbers (P32).
// The render checks run headless: the stub header below is copied from fix_render.test.ts.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { V3 } from '../../src/core/math';
import { wrapAngle } from '../../src/core/math';
import { CameraController } from '../../src/render/camera';
import { CrowdView } from '../../src/render/crowd';
import { Effects, FLASH_SIZE } from '../../src/render/effects';
import { GameRenderer } from '../../src/render/renderer';
import { SWIM_FLOAT } from '../../src/sim/characterPhysics';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import type { PlayerInput } from '../../src/sim/input';
import { WEAPON_POINTS, weaponPose } from '../../src/sim/pose';
import type { Sim } from '../../src/sim/sim';
import { WEAPONS, type WeaponId } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import type { StaticWorld } from '../../src/world/staticWorld';
import { aimAt, input, makeSim, placeInCar, step, teleport, world } from './helpers';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    // Every other 2D call is a no-op; property writes are kept.
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => ({
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas;
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(): void {}
    compile(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// Helpers

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

/** The player on foot on an open road facing along it, with forward and right unit vectors. */
function standOnOpenRoad(sim: Sim): { h: number; fx: number; fz: number; rx: number; rz: number } {
  const r = openRoad(sim);
  teleport(sim, r.x, r.z);
  sim.player.heading = r.h;
  return { h: r.h, fx: Math.sin(r.h), fz: Math.cos(r.h), rx: -Math.cos(r.h), rz: Math.sin(r.h) };
}

function arm(sim: Sim, weapon: WeaponId, ammo = 200): void {
  const p = sim.player;
  p.inventory.give(weapon, ammo);
  p.inventory.current = weapon;
}

/** The on-foot shoulder camera (2.4 m back when aiming, 4.3 m from the hip), its crosshair ray on `target` or along `pitch`. */
function shoulderAim(sim: Sim, yaw: number, pitch: number, target: V3 | null, over: Partial<PlayerInput> = {}): PlayerInput {
  const p = sim.player;
  const aiming = over.aim ?? true;
  const dist = aiming ? 2.4 : 4.3;
  const sh = aiming ? 0.62 : 0.42;
  const vx = Math.sin(yaw) * Math.cos(pitch);
  const vy = Math.sin(pitch);
  const vz = Math.cos(yaw) * Math.cos(pitch);
  const headY = p.pos.y + 1.58 * p.appearance.height;
  const ox = p.pos.x - vx * dist - Math.cos(yaw) * sh;
  const oz = p.pos.z - vz * dist + Math.sin(yaw) * sh;
  const o = { x: ox, y: Math.max(headY - vy * dist + 0.18, sim.world.groundHeight(ox, oz) + 0.35), z: oz };
  let d = { x: vx, y: vy, z: vz };
  if (target) {
    const l = Math.hypot(target.x - o.x, target.y - o.y, target.z - o.z);
    d = { x: (target.x - o.x) / l, y: (target.y - o.y) / l, z: (target.z - o.z) / l };
  }
  return input({ aimOrigin: o, aimDir: d, cameraYaw: yaw, aim: aiming, ...over });
}

/** The shoulder camera turned until its crosshair ray passes through `target`. */
function crosshairOn(sim: Sim, target: V3, over: Partial<PlayerInput> = {}): PlayerInput {
  let yaw = Math.atan2(target.x - sim.player.pos.x, target.z - sim.player.pos.z);
  let pitch = 0;
  for (let i = 0; i < 80; i++) {
    const o = shoulderAim(sim, yaw, pitch, null, over).aimOrigin;
    yaw = Math.atan2(target.x - o.x, target.z - o.z);
    pitch = Math.atan2(target.y - o.y, Math.hypot(target.x - o.x, target.z - o.z));
  }
  return shoulderAim(sim, yaw, pitch, null, over);
}

/** Collects every event of `type` emitted from now on. */
function record<K extends keyof SimEvents>(sim: Sim, type: K): Array<SimEvents[K]> {
  const out: Array<SimEvents[K]> = [];
  sim.events.on(type, (e) => out.push(e));
  return out;
}

/** A 0.2 m wall (8 m wide, 3 m tall) across the player's way, its near face `ahead` m in front of him. */
function wallAhead(sim: Sim, f: { fx: number; fz: number; rx: number; rz: number }, ahead: number, thick = 0.2): { faceX: number; faceZ: number } {
  const p = sim.player.pos;
  const cx = p.x + f.fx * (ahead + thick / 2);
  const cz = p.z + f.fz * (ahead + thick / 2);
  // Lanes run along the axes, so the wall is axis-aligned: half extents along and across the facing.
  const hx = Math.abs(f.fx) * (thick / 2) + Math.abs(f.rx) * 4;
  const hz = Math.abs(f.fz) * (thick / 2) + Math.abs(f.rz) * 4;
  sim.world.grid.addBox(cx - hx, cz - hz, cx + hx, cz + hz, p.y - 0.5, p.y + 3, 'wall');
  return { faceX: p.x + f.fx * ahead, faceZ: p.z + f.fz * ahead };
}

/** Spawns a stationary NPC at (x, z) (no brain unless one is given later). */
function npcAt(sim: Sim, role: 'civilian' | 'gang' | 'cop' | 'swat', x: number, z: number): Character {
  const c = sim.spawnCharacter(role, x, z);
  c.owner = 'mission';
  c.persistent = true;
  return c;
}

// ---------------------------------------------------------------------------
// P5: weaponFired once per pull, damage events

describe('P5: one weaponFired per trigger pull and a damage event per applied hit', () => {
  it('one shotgun pull at a wall: 1 weaponFired, 9 shots with pellets 0..8, one shell gone, one onViolence', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'shotgun');
    step(sim, 0.4);
    wallAhead(sim, f, 6);
    const p = sim.player;
    const slot = p.inventory.slot();
    const clip = slot.clip;
    const fired = record(sim, 'weaponFired');
    const shots = record(sim, 'shot');
    const violence = vi.spyOn(sim.peds, 'onViolence');
    const target = { x: p.pos.x + f.fx * 6, y: p.pos.y + 1.2, z: p.pos.z + f.fz * 6 };
    sim.update(DT, aimAt(sim, target, { fire: true, firePressed: true, aim: true }));
    expect(fired.length).toBe(1);
    const w = fired[0]!;
    expect(w.shooter).toBe(p);
    expect(w.weapon).toBe('shotgun');
    expect(w.pellets).toBe(9);
    // From the muzzle, along the aim before spread (towards the wall ahead).
    const m = sim.combat.muzzle(p, false);
    expect(Math.hypot(w.x - m.x, w.y - m.y, w.z - m.z)).toBeLessThan(1e-6);
    expect(Math.hypot(w.dx, w.dy, w.dz)).toBeCloseTo(1, 9);
    expect(w.dx * f.fx + w.dz * f.fz).toBeGreaterThan(0.95);
    expect(shots.map((s) => s.pellet)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shots.every((s) => s.hit === 'world' && s.shooter === p && s.weapon === 'shotgun')).toBe(true);
    expect(slot.clip).toBe(clip - 1);
    expect(violence).toHaveBeenCalledTimes(1);
    expect(violence.mock.calls[0]![2]).toBe(p);
    expect(violence.mock.calls[0]![3]).toBe(45);
  });

  it('a pistol body hit on a civilian is a body damage event by the player; the killing shot says killed', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'pistol');
    step(sim, 0.4);
    const p = sim.player;
    const civ = npcAt(sim, 'civilian', p.pos.x + f.fx * 8, p.pos.z + f.fz * 8);
    const damage = record(sim, 'damage');
    const chest = () => ({ x: civ.pos.x, y: civ.pos.y + 1.1, z: civ.pos.z });
    for (let i = 0; i < 3; i++) {
      sim.update(DT, crosshairOn(sim, chest(), { fire: true, firePressed: true }));
      step(sim, 0.3, () => crosshairOn(sim, chest()));
    }
    const hits = damage.filter((d) => d.victim === civ);
    expect(hits.length).toBe(3);
    for (const d of hits) {
      expect(d.attacker).toBe(p);
      expect(d.kind).toBe('bullet');
      expect(d.zone).toBe('body');
      expect(d.armourLoss).toBe(0);
      // The hit travels away from the player, towards the civilian.
      expect(d.dirX * f.fx + d.dirZ * f.fz).toBeGreaterThan(0.95);
    }
    expect(hits.map((d) => d.killed)).toEqual([false, false, true]);
    // The killing shot takes the health he had left, not the full 34.
    expect(hits.map((d) => d.healthLoss)).toEqual([34, 34, 32]);
    expect(civ.alive).toBe(false);
  });

  it('a cop with 50 armour hit for 34: armourLoss 34, healthLoss 0', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'pistol');
    step(sim, 0.4);
    const p = sim.player;
    const cop = npcAt(sim, 'cop', p.pos.x + f.fx * 7, p.pos.z + f.fz * 7);
    cop.armor = 50;
    const damage = record(sim, 'damage');
    sim.update(DT, crosshairOn(sim, { x: cop.pos.x, y: cop.pos.y + 1.1, z: cop.pos.z }, { fire: true, firePressed: true }));
    expect(damage.length).toBe(1);
    expect(damage[0]).toMatchObject({ victim: cop, attacker: p, armourLoss: 34, healthLoss: 0, zone: 'body', killed: false, kind: 'bullet' });
    expect(cop.armor).toBe(16);
    expect(cop.health).toBe(cop.maxHealth);
  });

  it('ignored hits emit nothing; falls and fire have no attacker or direction; punches are melee hits', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const damage = record(sim, 'damage');
    sim.cheats.godMode = true;
    sim.combat.damageCharacter(p, 20, null, 'bullet', 1, 0, 0);
    sim.cheats.godMode = false;
    const corpse = npcAt(sim, 'civilian', p.pos.x + 30, p.pos.z);
    sim.combat.damageCharacter(corpse, 500, p, 'bullet', 1, 0, 0);
    expect(damage.length).toBe(1);
    sim.combat.damageCharacter(corpse, 50, p, 'bullet', 1, 0, 0);
    expect(damage.length).toBe(1);
    sim.combat.damageCharacter(p, 10, null, 'fall', 0, -1, 0);
    expect(damage[1]).toMatchObject({ victim: p, attacker: null, kind: 'fall', healthLoss: 10, dirX: 0, dirZ: 0, zone: 'body' });
    // A punch from the player.
    const civ = npcAt(sim, 'civilian', p.pos.x + f.fx * 1.1, p.pos.z + f.fz * 1.1);
    p.heading = f.h;
    sim.combat.melee(p);
    const punch = damage.find((d) => d.victim === civ)!;
    expect(punch).toMatchObject({ attacker: p, kind: 'melee', healthLoss: WEAPONS.fists.damage, zone: 'body' });
  });

  it("NPC pulls and the player's rockets are one weaponFired each as well", () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const g = npcAt(sim, 'gang', p.pos.x + f.fx * 9, p.pos.z + f.fz * 9);
    g.inventory.infinite = true;
    g.inventory.give('shotgun', 99);
    g.inventory.current = 'shotgun';
    g.heading = f.h + Math.PI;
    const fired = record(sim, 'weaponFired');
    const shots = record(sim, 'shot');
    sim.combat.npcFire(g, p, 0.5);
    expect(fired.length).toBe(1);
    expect(fired[0]!.shooter).toBe(g);
    expect(shots.filter((s) => s.shooter === g).map((s) => s.pellet)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    arm(sim, 'rocket', 4);
    step(sim, 0.4);
    fired.length = 0;
    shots.length = 0;
    sim.update(DT, aimAt(sim, { x: p.pos.x + f.fx * 60, y: p.pos.y + 6, z: p.pos.z + f.fz * 60 }, { fire: true, firePressed: true, aim: true }));
    expect(fired.length).toBe(1);
    expect(fired[0]).toMatchObject({ weapon: 'rocket', pellets: 1 });
    expect(shots.length).toBe(1);
    expect(shots[0]!.pellet).toBe(0);
    expect(sim.projectiles.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P30: aim intent

describe('P30: hip fire keeps the pace and the view; the firing ray is this frame’s', () => {
  it('a pistol hip tap while walking keeps 4.3 m/s for 60 frames; holding aim walks at 2.8', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'pistol');
    step(sim, 0.4);
    const p = sim.player;
    const ahead = () => ({ x: p.pos.x + f.fx * 30, y: p.pos.y + 1.2, z: p.pos.z + f.fz * 30 });
    const walk = (over: Partial<PlayerInput> = {}) => aimAt(sim, ahead(), { moveZ: 1, cameraYaw: f.h, ...over });
    const shots = record(sim, 'weaponFired');
    sim.update(DT, walk({ fire: true, firePressed: true }));
    expect(shots.length).toBe(1);
    for (let i = 0; i < 60; i++) {
      sim.update(DT, walk());
      expect(p.moveSpeed).toBe(4.3);
      expect(p.aimZoom).toBe(false);
      // The gun stays raised for a second after the shot (pose, civilians cowering) without zooming in.
      if (i < 50) expect(p.aiming).toBe(true);
    }
    for (let i = 0; i < 10; i++) {
      sim.update(DT, walk({ aim: true }));
      expect(p.moveSpeed).toBe(2.8);
      expect(p.aimZoom).toBe(true);
    }
    sim.update(DT, walk({ aim: true, sprint: true }));
    expect(p.moveSpeed).toBe(4.3);
  });

  it('hip fire spreads 1.5 times wider; with moving that is capped at twice the spread', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'pistol');
    step(sim, 0.4);
    const p = sim.player;
    const angles: number[] = [];
    const spread = vi.spyOn(sim.combat as unknown as { spread: (dx: number, dy: number, dz: number, a: number) => V3 }, 'spread');
    spread.mockImplementation((dx, dy, dz, a) => {
      angles.push(a);
      return { x: dx, y: dy, z: dz };
    });
    const target = { x: p.pos.x + f.fx * 30, y: p.pos.y + 1.2, z: p.pos.z + f.fz * 30 };
    const pull = (over: Partial<PlayerInput>) => {
      sim.update(DT, aimAt(sim, target, { fire: true, firePressed: true, ...over }));
      step(sim, 0.3, () => aimAt(sim, target, over));
    };
    pull({ aim: true });
    pull({ aim: false });
    // Running (over 3 m/s) from the hip: 1.5 x 1.5 would be 2.25, capped at 2.
    p.vel.x = f.fx * 6;
    p.vel.z = f.fz * 6;
    p.speed = 6;
    sim.update(DT, aimAt(sim, target, { fire: true, firePressed: true, moveZ: 1, sprint: true, cameraYaw: f.h }));
    const s = WEAPONS.pistol.spread;
    expect(angles.length).toBe(3);
    expect(angles[0]).toBeCloseTo(s, 9);
    expect(angles[1]).toBeCloseTo(s * 1.5, 9);
    expect(angles[2]).toBeCloseTo(s * 2, 9);
  });

  it('CameraController.rayFor() after look(100, 0) points along the new yaw at once; aimRay() still has the old one', () => {
    const sim = makeSim();
    standOnOpenRoad(sim);
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.reset(sim);
    for (let i = 0; i < 30; i++) cam.update(DT, sim, false);
    const before = cam.yaw;
    cam.look(100, 0);
    expect(Math.abs(wrapAngle(cam.yaw - before))).toBeGreaterThan(0.2);
    const r = cam.rayFor();
    expect(Math.abs(wrapAngle(Math.atan2(r.dir.x, r.dir.z) - cam.yaw))).toBeLessThan(0.01);
    expect(Math.hypot(r.dir.x, r.dir.y, r.dir.z)).toBeCloseTo(1, 9);
    const stale = cam.aimRay();
    expect(Math.abs(wrapAngle(Math.atan2(stale.dir.x, stale.dir.z) - cam.yaw))).toBeGreaterThan(0.2);
    // rayFor() changes nothing, and the next update() frames exactly that ray (no wall here, no smoothing left).
    expect(cam.rayFor()).toEqual(r);
    cam.update(DT, sim, false);
    const after = cam.aimRay();
    expect(Math.hypot(after.dir.x - r.dir.x, after.dir.y - r.dir.y, after.dir.z - r.dir.z)).toBeLessThan(1e-6);
    expect(Math.hypot(after.origin.x - r.origin.x, after.origin.y - r.origin.y, after.origin.z - r.origin.z)).toBeLessThan(0.05);
  });

  it('rayFor() keeps the camera pulled in front of a wall behind the player, like the frame it will draw', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    // A wall 1.2 m behind him: the boom (4.3 m) is pulled in.
    wallAhead(sim, { fx: -f.fx, fz: -f.fz, rx: -f.rx, rz: -f.rz }, 1.2, 1);
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.reset(sim);
    cam.yaw = f.h;
    for (let i = 0; i < 60; i++) cam.update(DT, sim, false);
    const behind = (q: V3) => (q.x - p.pos.x) * -f.fx + (q.z - p.pos.z) * -f.fz;
    expect(behind(cam.camera.position)).toBeLessThan(1.2);
    cam.look(20, 0);
    const r = cam.rayFor();
    expect(behind(r.origin)).toBeLessThan(1.2);
    cam.update(DT, sim, false);
    const drawn = cam.aimRay();
    // The ray the frame shows (same direction) passes within a few cm of rayFor()'s origin.
    const ox = r.origin.x - drawn.origin.x;
    const oy = r.origin.y - drawn.origin.y;
    const oz = r.origin.z - drawn.origin.z;
    const along = ox * drawn.dir.x + oy * drawn.dir.y + oz * drawn.dir.z;
    expect(Math.hypot(ox - drawn.dir.x * along, oy - drawn.dir.y * along, oz - drawn.dir.z * along)).toBeLessThan(0.05);
  });

  it('a look and a shot in the same frame hit the ped under the post-look crosshair (the stale ray misses him)', () => {
    const run = (fresh: boolean): boolean => {
      const sim = makeSim();
      const f = standOnOpenRoad(sim);
      arm(sim, 'pistol');
      const p = sim.player;
      const cam = new CameraController(16 / 9);
      cam.mode = 'play';
      cam.reset(sim);
      cam.yaw = f.h;
      // Settle the camera behind the player and wait out the weapon swap, the way Game.step drives them.
      for (let i = 0; i < 40; i++) {
        const aim = cam.rayFor();
        sim.update(DT, input({ aimOrigin: aim.origin, aimDir: aim.dir, cameraYaw: cam.yaw }));
        cam.update(DT, sim, false);
      }
      // A civilian 12 m out, 0.35 rad to the left of the view.
      const yaw0 = cam.yaw;
      const pitch0 = cam.pitch;
      const civ = npcAt(sim, 'civilian', p.pos.x + Math.sin(yaw0 + 0.35) * 12, p.pos.z + Math.cos(yaw0 + 0.35) * 12);
      // The yaw and pitch that put the crosshair on his chest (rayFor() is pure: trying angles changes nothing else).
      for (let k = 0; k < 30; k++) {
        const r = cam.rayFor();
        cam.yaw = Math.atan2(civ.pos.x - r.origin.x, civ.pos.z - r.origin.z);
        cam.pitch = Math.atan2(civ.pos.y + 1.1 - r.origin.y, Math.hypot(civ.pos.x - r.origin.x, civ.pos.z - r.origin.z));
      }
      const k = 0.0024 * cam.sensitivity;
      const dx = -wrapAngle(cam.yaw - yaw0) / k;
      const dy = -(cam.pitch - pitch0) / k;
      cam.yaw = yaw0;
      cam.pitch = pitch0;
      // One frame: the mouse moves, the ray is taken, the trigger is pulled.
      cam.look(dx, dy);
      const aim = fresh ? cam.rayFor() : cam.aimRay();
      sim.update(DT, input({ aimOrigin: aim.origin, aimDir: aim.dir, cameraYaw: cam.yaw, fire: true, firePressed: true }));
      return civ.health < civ.maxHealth;
    };
    expect(run(true)).toBe(true);
    expect(run(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P31b: walls stop the muzzle; effects always render

describe('P31b: a gun poking through a wall only hits the wall', () => {
  /** The player walked up against a 0.2 m wall 0.36 m ahead, a civilian 3 m behind the wall. */
  function againstWall(weapon: WeaponId) {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, weapon);
    const p = sim.player;
    const face = wallAhead(sim, f, 0.4);
    const civ = npcAt(sim, 'civilian', p.pos.x + f.fx * 3.6, p.pos.z + f.fz * 3.6);
    const chest = () => ({ x: civ.pos.x, y: civ.pos.y + 1.1, z: civ.pos.z });
    // Walk into the wall until it holds him.
    step(sim, 0.6, () => crosshairOn(sim, chest(), { moveZ: 1, cameraYaw: f.h }));
    step(sim, 0.2, () => crosshairOn(sim, chest()));
    return { sim, f, p, face, civ, chest };
  }

  it('pressed against a 0.2 m wall: the ped behind it keeps full health, the shot stops at the wall face', () => {
    const { sim, f, p, face, civ, chest } = againstWall('pistol');
    const toFace = (x: number, z: number) => (x - face.faceX) * f.fx + (z - face.faceZ) * f.fz;
    // He is against the wall and his muzzle pokes into it (the bug: shots used to start inside or behind it).
    expect(toFace(p.pos.x, p.pos.z)).toBeGreaterThan(-0.4);
    const m = sim.combat.muzzle(p, false);
    expect(toFace(m.x, m.z)).toBeGreaterThan(0);
    expect(sim.combat.muzzleBlocked(p)).toBe(true);
    const shots = record(sim, 'shot');
    const fired = record(sim, 'weaponFired');
    const ammo = p.inventory.slot().clip;
    for (let i = 0; i < 3; i++) {
      sim.update(DT, crosshairOn(sim, chest(), { fire: true, firePressed: true }));
      step(sim, 0.3, () => crosshairOn(sim, chest()));
    }
    expect(civ.health).toBe(civ.maxHealth);
    expect(shots.length).toBe(3);
    for (const s of shots) {
      expect(s.hit).toBe('world');
      expect(Math.abs(toFace(s.tx, s.tz))).toBeLessThan(0.1);
    }
    // The pull is spent: ammo, and a flash at the chest on this side of the wall.
    expect(p.inventory.slot().clip).toBe(ammo - 3);
    expect(fired.length).toBe(3);
    for (const w of fired) expect(toFace(w.x, w.z)).toBeLessThan(0);
  });

  it('muzzleBlocked is about the next shot: the gun raised towards the aim, not where the body faces', () => {
    const { sim, f, p, chest } = againstWall('pistol');
    expect(sim.combat.muzzleBlocked(p)).toBe(true);
    // Look along the wall and lower the gun (a second after the last shot): the body still faces the wall.
    const along = { x: p.pos.x + f.rx * 20, y: p.pos.y + 1.2, z: p.pos.z + f.rz * 20 };
    step(sim, 1.5, () => crosshairOn(sim, along, { aim: false }));
    expect(p.aiming).toBe(false);
    expect((p.heading - f.h + 4 * Math.PI) % (2 * Math.PI)).toBeLessThan(0.3);
    expect(sim.combat.muzzleBlocked(p)).toBe(false);
    // A shot there flies along the wall, as the reticle said.
    const shots = record(sim, 'shot');
    sim.update(DT, crosshairOn(sim, along, { aim: false, fire: true, firePressed: true }));
    expect(shots.length).toBe(1);
    expect(Math.hypot(shots[0]!.tx - p.pos.x, shots[0]!.tz - p.pos.z)).toBeGreaterThan(3);
    // Back towards the wall: blocked again.
    step(sim, 0.3, () => crosshairOn(sim, chest()));
    expect(sim.combat.muzzleBlocked(p)).toBe(true);
  });

  it('a shotgun blast there: nine shots, all at the wall face; muzzleBlocked is false in the open', () => {
    const { sim, f, face, civ, chest } = againstWall('shotgun');
    const shots = record(sim, 'shot');
    sim.update(DT, crosshairOn(sim, chest(), { fire: true, firePressed: true }));
    expect(shots.map((s) => s.pellet)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const s of shots) expect(Math.abs((s.tx - face.faceX) * f.fx + (s.tz - face.faceZ) * f.fz)).toBeLessThan(0.1);
    expect(civ.health).toBe(civ.maxHealth);
    teleport(sim, sim.player.pos.x - f.fx * 5, sim.player.pos.z - f.fz * 5);
    expect(sim.combat.muzzleBlocked(sim.player)).toBe(false);
  });

  it('a rocket fired into the wall goes off there, on the shooter', () => {
    const { sim, p, civ, chest } = againstWall('rocket');
    sim.cheats.godMode = false;
    const explosions = record(sim, 'explosion');
    const damage = record(sim, 'damage');
    const shots = record(sim, 'shot');
    sim.update(DT, crosshairOn(sim, chest(), { fire: true, firePressed: true }));
    expect(sim.projectiles.length).toBe(0);
    expect(explosions.length).toBe(1);
    const e = explosions[0]!;
    expect(Math.hypot(e.x - p.pos.x, e.z - p.pos.z)).toBeLessThan(0.6);
    expect(shots.length).toBe(1);
    expect(shots[0]).toMatchObject({ weapon: 'rocket', hit: 'world', pellet: 0 });
    const self = damage.find((d) => d.victim === p)!;
    expect(self.attacker).toBe(p);
    expect(self.kind).toBe('explosion');
    // The wall shelters the civilian behind it.
    expect(civ.alive).toBe(true);
  });

  it('NPCs against a wall hit the wall too; from a car they have no wall check', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const g = npcAt(sim, 'gang', p.pos.x + f.fx * 8, p.pos.z + f.fz * 8);
    g.inventory.infinite = true;
    g.inventory.give('pistol', 99);
    g.inventory.current = 'pistol';
    g.heading = f.h + Math.PI;
    // Aiming at the player, as the AI sets him up before npcFire.
    g.aiming = true;
    g.aimYaw = g.heading;
    // A 0.2 m wall 0.38 m in front of the gang member, between him and the player.
    const back = { fx: -f.fx, fz: -f.fz, rx: -f.rx, rz: -f.rz };
    const gp = { x: g.pos.x, y: g.pos.y, z: g.pos.z };
    const cx = gp.x + back.fx * 0.48;
    const cz = gp.z + back.fz * 0.48;
    const hx = Math.abs(f.fx) * 0.1 + Math.abs(f.rx) * 3;
    const hz = Math.abs(f.fz) * 0.1 + Math.abs(f.rz) * 3;
    sim.world.grid.addBox(cx - hx, cz - hz, cx + hx, cz + hz, gp.y - 0.5, gp.y + 3, 'wall');
    expect(sim.combat.muzzleBlocked(g)).toBe(true);
    const shots = record(sim, 'shot');
    sim.combat.npcFire(g, p, 1);
    expect(shots.length).toBe(1);
    expect(shots[0]!.hit).toBe('world');
    expect(Math.hypot(shots[0]!.tx - gp.x, shots[0]!.tz - gp.z)).toBeLessThan(0.45);
    expect(p.health).toBe(p.maxHealth);
    // Asked to fire 'from a vehicle' while on foot (just got out), he still has the wall in front of him.
    g.fireCooldown = 0;
    shots.length = 0;
    sim.combat.npcFire(g, p, 1, true);
    expect(shots.length).toBe(1);
    expect(shots[0]!.hit).toBe('world');
    expect(Math.hypot(shots[0]!.tx - gp.x, shots[0]!.tz - gp.z)).toBeLessThan(0.45);
    expect(p.health).toBe(p.maxHealth);
    // Seated in a car (fromVehicle) the muzzle is the car window and there is no chest-to-muzzle check.
    const car = sim.spawnVehicle('sedan', gp.x + f.rx * 3, gp.z + f.rz * 3, f.h);
    sim.seat(g, car, 0);
    g.fireCooldown = 0;
    shots.length = 0;
    const wallCheck = vi.spyOn(sim.combat as unknown as { muzzleWall: () => unknown }, 'muzzleWall');
    sim.combat.npcFire(g, p, 1, true);
    expect(shots.length).toBe(1);
    expect(wallCheck).not.toHaveBeenCalled();
    const m = sim.combat.muzzle(g, true);
    expect(Math.hypot(shots[0]!.fx - m.x, shots[0]!.fz - m.z)).toBeLessThan(1e-9);
  });
});

describe('P31b: flashes and tracers', () => {
  it('a muzzle flash and a tracer are still drawn after one 0.08 s frame', () => {
    const fx = new Effects();
    fx.muzzleFlash(0, 1, 0, FLASH_SIZE.pistol);
    fx.tracer(0, 1, 0, 0, 1, 12);
    fx.update(0.08, 0.08);
    expect(fx.glowCount).toBeGreaterThan(0);
    expect(fx.tracerCount).toBeGreaterThan(0);
    expect(fx.muzzle.intensity).toBeGreaterThan(0);
    // The next frame they are gone (the 12 m tracer's tail left after 0.03 s and reached the hit 0.04 s later).
    fx.update(0.08, 0.16);
    expect(fx.glowCount).toBe(0);
    expect(fx.tracerCount).toBe(0);
    expect(fx.muzzle.intensity).toBe(0);
  });

  it('flashes are two crossed sprites sized per weapon, with the light capped at 30', () => {
    const fx = new Effects();
    for (const w of ['pistol', 'smg', 'rifle', 'shotgun', 'rocket'] as const) {
      fx.muzzleFlash(0, 1, 0, FLASH_SIZE[w]);
      fx.update(DT, 0);
      expect(fx.glowCount).toBe(2);
      expect(fx.muzzle.intensity).toBeGreaterThan(10);
      expect(fx.muzzle.intensity).toBeLessThanOrEqual(30);
      for (let i = 0; i < 10; i++) fx.update(DT, 0);
      expect(fx.glowCount).toBe(0);
    }
    expect(FLASH_SIZE).toMatchObject({ pistol: 0.3, smg: 0.32, rifle: 0.4, shotgun: 0.55, rocket: 0.6 });
    const glow = (fx as unknown as { glow: { mesh: THREE.Mesh } }).glow.mesh.geometry as THREE.InstancedBufferGeometry;
    fx.muzzleFlash(0, 1, 0, FLASH_SIZE.shotgun);
    fx.update(DT, 0);
    const sr = glow.getAttribute('iSizeRot') as THREE.InstancedBufferAttribute;
    // Long side about the weapon's flash size, three times longer than wide, at right angles to each other.
    expect(sr.getX(0)).toBeGreaterThanOrEqual(0.55);
    expect(sr.getX(0)).toBeLessThan(0.55 * 1.3);
    expect(sr.getZ(0)).toBe(3);
    expect(Math.abs(wrapAngle(sr.getY(1) - sr.getY(0)))).toBeCloseTo(Math.PI / 2, 6);
  });

  it('a tracer streak starts at the muzzle reaching most of the way on its first frame, held for 0.03 s, then a 3 m streak flies on at 300 m/s', () => {
    const fx = new Effects();
    const geo = (fx as unknown as { tracers: { mesh: THREE.Mesh } }).tracers.mesh.geometry as THREE.InstancedBufferGeometry;
    const seg = () => {
      const a = geo.getAttribute('iFrom') as THREE.InstancedBufferAttribute;
      const b = geo.getAttribute('iTo') as THREE.InstancedBufferAttribute;
      return { from: a.getZ(0), to: b.getZ(0) };
    };
    // 15 m: 80% of the way at once, for two frames; then the tail flies and the head waits until it is 3 m behind it.
    fx.tracer(0, 1, 0, 0, 1, 15);
    fx.update(DT, 0);
    expect(geo.instanceCount).toBe(1);
    expect(seg()).toEqual({ from: 0, to: 12 });
    fx.update(DT, 0);
    expect(seg()).toEqual({ from: 0, to: 12 });
    fx.update(DT, 0);
    expect(seg().from).toBeCloseTo(1, 5);
    expect(seg().to).toBeCloseTo(12, 5);
    fx.update(DT, 0);
    expect(seg().from).toBeCloseTo(6, 5);
    expect(seg().to).toBeCloseTo(12, 5);
    fx.update(DT, 0);
    expect(seg().from).toBeCloseTo(11, 5);
    expect(seg().to).toBeCloseTo(14, 5);
    fx.update(DT, 0);
    // The tail reached the hit point at 15 m: gone.
    expect(geo.instanceCount).toBe(0);
    // A long shot: 20 m at most at once, then the usual 3 m streak at 300 m/s.
    fx.tracer(0, 1, 0, 0, 1, 100);
    fx.update(DT, 0);
    expect(seg()).toEqual({ from: 0, to: 20 });
    for (let i = 0; i < 6; i++) fx.update(DT, 0);
    expect(seg().from).toBeCloseTo(21, 4);
    expect(seg().to).toBeCloseTo(24, 4);
    fx.update(DT, 0);
    expect(seg().to - seg().from).toBeCloseTo(3, 4);
    // A short one is drawn over its whole length less the last fifth, never less than 3 m.
    fx.tracer(0, 1, 0, 0, 1, 2);
    for (let i = 0; i < 40; i++) fx.update(DT, 0);
    fx.tracer(0, 1, 0, 0, 1, 3.5);
    fx.update(DT, 0);
    expect(seg()).toEqual({ from: 0, to: 3 });
    // Paused frames (dt = 0) hold it where it is.
    fx.tracer(0, 1, 0, 0, 1, 15);
    for (let i = 0; i < 5; i++) fx.update(0, 0);
    expect(geo.instanceCount).toBe(2);
  });

  it('short sparks and the explosion flash are drawn on their first frame even at 10 fps', () => {
    const fx = new Effects();
    fx.impact(0, 1, 0, 0, 1, 0, 'world');
    fx.explosion(10, 1, 0, 7.5);
    const flash = fx.flash.intensity;
    fx.update(0.1, 0.1);
    expect(fx.glowCount).toBeGreaterThan(0);
    expect(fx.flash.intensity).toBe(flash);
    fx.update(0.1, 0.2);
    expect(fx.flash.intensity).toBeLessThan(flash);
  });

  describe('renderer wiring', () => {
    let W: StaticWorld;
    let R: GameRenderer;
    beforeAll(() => {
      W = world();
      R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'low', fov: 68 });
    });

    /** Lets every effect from earlier events run out. */
    function settle(): void {
      for (let i = 0; i < 80; i++) R.render(0.1, false);
    }

    it('one flash per pull, one tracer per pellet; flesh impacts only from blood', () => {
      const sim = makeSim({ world: W });
      const f = standOnOpenRoad(sim);
      R.attach(sim);
      R.cameraCtl.mode = 'play';
      R.cameraCtl.reset(sim);
      settle();
      arm(sim, 'shotgun');
      step(sim, 0.4);
      sim.world.grid.addBox(
        sim.player.pos.x + f.fx * 8 - 4,
        sim.player.pos.z + f.fz * 8 - 4,
        sim.player.pos.x + f.fx * 8 + 4,
        sim.player.pos.z + f.fz * 8 + 4,
        -5,
        20,
        'wall',
      );
      const p = sim.player;
      sim.update(DT, aimAt(sim, { x: p.pos.x + f.fx * 8, y: p.pos.y + 1.2, z: p.pos.z + f.fz * 8 }, { fire: true, firePressed: true, aim: true }));
      R.render(DT, true);
      expect(R.effects.tracerCount).toBe(9);
      // Two flash sprites, and 4 sparks per pellet hitting the wall.
      expect(R.effects.glowCount).toBe(2 + 9 * 4);
      settle();
      // A flesh 'shot' draws its tracer but no impact; the 'blood' event that comes with it does.
      sim.events.emit('shot', { shooter: p, weapon: 'pistol', fx: 0, fy: 1, fz: 0, tx: 0, ty: 1, tz: 10, hit: 'flesh', nx: 0, ny: 0, nz: -1, pellet: 0 });
      R.render(DT, false);
      expect(R.effects.tracerCount).toBe(1);
      expect(R.effects.particleCount).toBe(0);
      sim.events.emit('blood', { x: 0, y: 1, z: 10, dx: 0, dy: 0, dz: 1 });
      R.render(DT, false);
      expect(R.effects.particleCount).toBe(6);
      settle();
      // Helicopter rounds have no weaponFired, so their 'shot' flashes.
      sim.events.emit('shot', { shooter: null, weapon: 'rifle', fx: 0, fy: 30, fz: 0, tx: 0, ty: 0, tz: 10, hit: 'none', nx: 0, ny: 1, nz: 0, pellet: 0 });
      R.render(DT, false);
      expect(R.effects.glowCount).toBe(2);
      expect(R.effects.tracerCount).toBe(1);
      settle();
      // ...and come without a 'blood' event, so their flesh hits bleed from the 'shot' itself.
      sim.events.emit('shot', { shooter: null, weapon: 'rifle', fx: 0, fy: 30, fz: 0, tx: 0, ty: 1, tz: 10, hit: 'flesh', nx: 0, ny: 0, nz: -1, pellet: 0 });
      R.render(DT, false);
      expect(R.effects.particleCount - R.effects.glowCount).toBe(6);
    });

    it("the player's automatic fire traces every second round of a burst, NPC rounds every round", () => {
      const sim = makeSim({ world: W });
      R.attach(sim);
      settle();
      const p = sim.player;
      const g = npcAt(sim, 'gang', p.pos.x + 30, p.pos.z);
      const shot = (shooter: Character, weapon: WeaponId) =>
        sim.events.emit('shot', { shooter, weapon, fx: 0, fy: 1, fz: 0, tx: 0, ty: 1, tz: 400, hit: 'none', nx: 0, ny: 1, nz: 0, pellet: 0 });
      // A 10-round burst (one round a frame).
      for (let i = 0; i < 10; i++) {
        shot(p, 'smg');
        step(sim, DT);
      }
      R.render(DT, false);
      expect(R.effects.tracerCount).toBe(5);
      settle();
      step(sim, 0.5);
      // Single taps a moment apart each trace.
      for (let i = 0; i < 3; i++) {
        shot(p, 'rifle');
        step(sim, 0.3);
      }
      R.render(DT, false);
      expect(R.effects.tracerCount).toBe(3);
      settle();
      for (let i = 0; i < 10; i++) shot(g, 'smg');
      for (let i = 0; i < 4; i++) shot(p, 'pistol');
      R.render(DT, false);
      expect(R.effects.tracerCount).toBe(14);
      settle();
      // A burst cut short at an odd round, then a new game (its clock starts again from 0): the first round still traces.
      step(sim, 5);
      shot(p, 'smg');
      const next = makeSim({ world: W });
      R.attach(next);
      next.events.emit('shot', { shooter: next.player, weapon: 'smg', fx: 0, fy: 1, fz: 0, tx: 0, ty: 1, tz: 400, hit: 'none', nx: 0, ny: 1, nz: 0, pellet: 0 });
      R.render(DT, false);
      expect(R.effects.tracerCount).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// P32: cadence, head volume, headshot multipliers, blast exposure, table-driven numbers

describe('P32: fire cadence', () => {
  it.each([1 / 30, 1 / 60, 1 / 120, 1 / 144])('a 2 s SMG hold fires 22 +- 1 rounds at dt %f', (dt) => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'smg', 300);
    step(sim, 0.5);
    const p = sim.player;
    const fired = record(sim, 'weaponFired');
    const target = { x: p.pos.x + f.fx * 40, y: p.pos.y + 1.2, z: p.pos.z + f.fz * 40 };
    const frames = Math.round(2 / dt);
    for (let i = 0; i < frames; i++) sim.update(dt, aimAt(sim, target, { aim: true, fire: true, firePressed: i === 0 }));
    expect(fired.length).toBeGreaterThanOrEqual(21);
    expect(fired.length).toBeLessThanOrEqual(23);
  });

  it('a pistol press just before it is ready fires the moment it is; an earlier press does nothing', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'pistol');
    step(sim, 0.5);
    const p = sim.player;
    const fired: number[] = [];
    sim.events.on('weaponFired', () => fired.push(sim.time));
    const target = { x: p.pos.x + f.fx * 30, y: p.pos.y + 1.2, z: p.pos.z + f.fz * 30 };
    const aim = (over: Partial<PlayerInput> = {}) => aimAt(sim, target, { aim: true, ...over });
    sim.update(DT, aim({ fire: true, firePressed: true }));
    expect(fired.length).toBe(1);
    // A one-frame tap 0.2 s later (0.05 s of cooldown left) is queued...
    step(sim, 0.2 - DT, () => aim());
    expect(p.fireCooldown).toBeGreaterThan(0);
    expect(p.fireCooldown).toBeLessThanOrEqual(0.1);
    sim.update(DT, aim({ fire: true, firePressed: true }));
    expect(fired.length).toBe(1);
    expect(p.fireQueued).toBeGreaterThan(0);
    // ...and fires when the cooldown runs out, with the button already released.
    step(sim, 0.1, () => aim());
    expect(fired.length).toBe(2);
    expect(fired[1]! - fired[0]!).toBeGreaterThan(1 / WEAPONS.pistol.rate - DT);
    expect(fired[1]! - fired[0]!).toBeLessThan(1 / WEAPONS.pistol.rate + DT * 1.5);
    // A tap 0.1 s after a shot (0.15 s left) is not queued.
    step(sim, 0.1 - DT, () => aim());
    sim.update(DT, aim({ fire: true, firePressed: true }));
    expect(p.fireQueued).toBe(0);
    step(sim, 0.4, () => aim());
    expect(fired.length).toBe(2);
  });
});

describe('P32: a queued press survives at any frame rate', () => {
  it.each([1 / 50, 1 / 60, 1 / 75, 1 / 144, 1 / 165])('a press in the first frame of the queue window fires once ready (dt %f)', (dt) => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'pistol');
    step(sim, 0.5, input(), dt);
    const p = sim.player;
    let fired = 0;
    sim.events.on('weaponFired', () => fired++);
    const target = { x: p.pos.x + f.fx * 30, y: p.pos.y + 1.2, z: p.pos.z + f.fz * 30 };
    const aim = (over: Partial<PlayerInput> = {}) => aimAt(sim, target, { aim: true, ...over });
    sim.update(dt, aim({ fire: true, firePressed: true }));
    expect(fired).toBe(1);
    // Wait for the first frame whose cooldown is inside the window, then tap once.
    while (p.fireCooldown > 0.1) sim.update(dt, aim());
    sim.update(dt, aim({ fire: true, firePressed: true }));
    expect(fired).toBe(1);
    for (let i = 0; i < Math.ceil(0.2 / dt); i++) sim.update(dt, aim());
    expect(fired).toBe(2);
  });

  it('presses from a car are not queued (the drive-by trigger only fires while held)', () => {
    const sim = makeSim();
    const r = openRoad(sim);
    const v = sim.spawnVehicle('sedan', r.x, r.z, r.h);
    sim.seat(sim.player, v, 0);
    arm(sim, 'pistol');
    step(sim, 0.5);
    const p = sim.player;
    const target = { x: v.pos.x + Math.sin(r.h) * 30, y: v.pos.y + 1.2, z: v.pos.z + Math.cos(r.h) * 30 };
    sim.update(DT, aimAt(sim, target, { fire: true, firePressed: true }));
    while (p.fireCooldown > 0.08) sim.update(DT, aimAt(sim, target));
    sim.update(DT, aimAt(sim, target, { fire: true, firePressed: true }));
    expect(p.fireQueued).toBe(0);
  });
});

describe('P32: head volume and headshots', () => {
  it.each(['civilian', 'gang', 'cop'] as const)('one aimed player pistol headshot kills a %s', (role) => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'pistol');
    step(sim, 0.4);
    const p = sim.player;
    const v = npcAt(sim, role, p.pos.x + f.fx * 7, p.pos.z + f.fz * 7);
    const head = () => ({ x: v.pos.x, y: v.pos.y + v.height * 0.93, z: v.pos.z });
    step(sim, 0.2, () => crosshairOn(sim, head()));
    const damage = record(sim, 'damage');
    const headshots = sim.progress.stats.headshots;
    sim.update(DT, crosshairOn(sim, head(), { fire: true, firePressed: true }));
    expect(damage.length).toBe(1);
    expect(damage[0]).toMatchObject({ victim: v, zone: 'head', killed: true });
    expect(v.alive).toBe(false);
    expect(sim.progress.stats.headshots).toBe(headshots + 1);
  });

  it('a shotgun blast at a head counts one headshot, however many pellets land there', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'shotgun');
    step(sim, 0.4);
    const p = sim.player;
    const v = npcAt(sim, 'gang', p.pos.x + f.fx * 4, p.pos.z + f.fz * 4);
    v.armor = 5000;
    const head = () => ({ x: v.pos.x, y: v.pos.y + v.height * 0.93, z: v.pos.z });
    step(sim, 0.3, () => crosshairOn(sim, head()));
    const damage = record(sim, 'damage');
    const headshots = sim.progress.stats.headshots;
    sim.update(DT, crosshairOn(sim, head(), { fire: true, firePressed: true }));
    expect(damage.filter((d) => d.zone === 'head').length).toBeGreaterThan(1);
    expect(sim.progress.stats.headshots).toBe(headshots + 1);
  });

  it('SWAT helmets take 0.6 of the multiplier: one pistol headshot does not drop a SWAT officer', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'pistol');
    step(sim, 0.4);
    const p = sim.player;
    const v = npcAt(sim, 'swat', p.pos.x + f.fx * 7, p.pos.z + f.fz * 7);
    const head = () => ({ x: v.pos.x, y: v.pos.y + v.height * 0.93, z: v.pos.z });
    step(sim, 0.2, () => crosshairOn(sim, head()));
    const damage = record(sim, 'damage');
    sim.update(DT, crosshairOn(sim, head(), { fire: true, firePressed: true }));
    expect(damage[0]).toMatchObject({ zone: 'head', killed: false });
    expect(damage[0]!.healthLoss).toBeCloseTo(WEAPONS.pistol.damage * WEAPONS.pistol.headMul * 0.6, 6);
  });

  it('a ray 0.25 m beside the head above the shoulders misses; 0.1 m beside it is a head hit', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const v = npcAt(sim, 'civilian', p.pos.x + f.fx * 10, p.pos.z + f.fz * 10);
    const cast = (side: number, k: number) => {
      // A level ray across his line, `side` m to his right, at k of his height.
      const ox = v.pos.x - f.fx * 5 + f.rx * side;
      const oz = v.pos.z - f.fz * 5 + f.rz * side;
      return sim.combat.castRay(ox, v.pos.y + v.height * k, oz, f.fx, 0, f.fz, 20, p);
    };
    expect(cast(0.25, 0.93).character).toBeNull();
    expect(cast(0.25, 0.9).character).toBeNull();
    const head = cast(0.1, 0.93);
    expect(head.character).toBe(v);
    expect(head.zone).toBe('head');
    const body = cast(0.25, 0.6);
    expect(body.character).toBe(v);
    expect(body.zone).toBe('body');
    // Lying and swimming people are one volume: no head zone.
    v.state = 'knocked';
    const lying = sim.combat.castRay(v.pos.x - f.fx * 5, v.pos.y + 0.3, v.pos.z - f.fz * 5, f.fx, 0, f.fz, 20, p);
    expect(lying.character).toBe(v);
    expect(lying.zone).toBe('body');
  });

  it('an NPC pistol headshot on a full-health player leaves him alive (2x, then the 0.55 NPC factor)', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const g = npcAt(sim, 'gang', p.pos.x + f.fx * 6, p.pos.z + f.fz * 6);
    g.inventory.give('pistol', 99);
    g.inventory.current = 'pistol';
    g.heading = f.h + Math.PI;
    const from = sim.combat.muzzle(g, false);
    const to = { x: p.pos.x, y: p.pos.y + p.height * 0.93, z: p.pos.z };
    const l = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const damage = record(sim, 'damage');
    (sim.combat as unknown as { fireRay: (...a: unknown[]) => void }).fireRay(g, from, (to.x - from.x) / l, (to.y - from.y) / l, (to.z - from.z) / l, WEAPONS.pistol, 0);
    expect(damage.length).toBe(1);
    expect(damage[0]).toMatchObject({ victim: p, attacker: g, zone: 'head', killed: false });
    expect(damage[0]!.healthLoss).toBeCloseTo(WEAPONS.pistol.damage * 2 * 0.55, 6);
    expect(p.alive).toBe(true);
  });

  it('point blank at the head is still a headshot though the gun sits below his shoulder line', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    arm(sim, 'pistol');
    step(sim, 0.4);
    const p = sim.player;
    // 0.9 m away, 0.62 m to the right: the muzzle is a hand's width from his shoulder.
    const v = npcAt(sim, 'gang', p.pos.x + f.fx * 0.652 + f.rx * 0.62, p.pos.z + f.fz * 0.652 + f.rz * 0.62);
    v.armor = 5000;
    const head = () => ({ x: v.pos.x, y: v.pos.y + v.height * 0.92, z: v.pos.z });
    step(sim, 0.3, () => crosshairOn(sim, head()));
    const damage = record(sim, 'damage');
    sim.update(DT, crosshairOn(sim, head(), { fire: true, firePressed: true }));
    expect(damage.length).toBe(1);
    expect(damage[0]!.zone).toBe('head');
    // Aimed at his chest from there it stays a body shot.
    step(sim, 0.3, () => crosshairOn(sim, { x: v.pos.x, y: v.pos.y + 1.0, z: v.pos.z }));
    sim.update(DT, crosshairOn(sim, { x: v.pos.x, y: v.pos.y + 1.0, z: v.pos.z }, { fire: true, firePressed: true }));
    expect(damage.length).toBe(2);
    expect(damage[1]!.zone).toBe('body');
  });
});

describe('P32: a round on course for the aimed head counts as a headshot', () => {
  /** A rising ray from 1 m in front of `v` that enters his body just under the shoulder line and goes on into his head. */
  function setup() {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const v = npcAt(sim, 'civilian', p.pos.x + f.fx * 10, p.pos.z + f.fz * 10);
    v.maxHealth = 1e6;
    v.health = 1e6;
    const neck = v.pos.y + 0.86 * v.height;
    const from = { x: v.pos.x - f.fx * 1, y: neck - 0.25, z: v.pos.z - f.fz * 1 };
    // Aimed at a point in his head 0.08 m above the shoulder line: the ray enters the body cylinder's side first.
    const to = { x: v.pos.x, y: neck + 0.08, z: v.pos.z };
    const l = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const d = { x: (to.x - from.x) / l, y: (to.y - from.y) / l, z: (to.z - from.z) / l };
    const combat = sim.combat as unknown as { aimed: { character: Character; zone: 'head' | 'body' } | null; fireRay: (...a: unknown[]) => void };
    // The geometry: the body cylinder is hit first, and the head lies further along the same ray.
    const r = sim.combat.castRay(from.x, from.y, from.z, d.x, d.y, d.z, 5, p);
    expect(r.character).toBe(v);
    expect(r.zone).toBe('body');
    expect(from.y + d.y * r.t).toBeLessThan(neck);
    const damage = record(sim, 'damage');
    return { sim, p, v, from, d, combat, damage };
  }

  it('the crosshair on his head: a round clipping his shoulder on its way there is a head hit', () => {
    const { p, v, from, d, combat, damage } = setup();
    expect(combat.aimed).toBeNull();
    // Without an aim (an NPC's shot, or the crosshair elsewhere) the shoulder takes it.
    combat.fireRay(p, from, d.x, d.y, d.z, WEAPONS.pistol, 0);
    expect(damage[0]).toMatchObject({ victim: v, zone: 'body' });
    combat.aimed = { character: v, zone: 'body' };
    combat.fireRay(p, from, d.x, d.y, d.z, WEAPONS.pistol, 0);
    expect(damage[1]).toMatchObject({ victim: v, zone: 'body' });
    combat.aimed = { character: v, zone: 'head' };
    combat.fireRay(p, from, d.x, d.y, d.z, WEAPONS.pistol, 0);
    expect(damage[2]).toMatchObject({ victim: v, zone: 'head' });
    expect(damage[2]!.healthLoss).toBe(WEAPONS.pistol.damage * WEAPONS.pistol.headMul);
    combat.aimed = null;
  });

  it('a round that spread off the head into his chest stays a body hit', () => {
    const { p, v, combat, damage } = setup();
    combat.aimed = { character: v, zone: 'head' };
    const from = { x: v.pos.x - 3, y: v.pos.y + 1.0, z: v.pos.z };
    combat.fireRay(p, from, 1, 0, 0, WEAPONS.pistol, 0);
    combat.aimed = null;
    expect(damage[0]).toMatchObject({ victim: v, zone: 'body' });
  });
});

describe('P32: blast exposure', () => {
  /** Damage a ped 4 m from a 300-point blast takes, with or without a full wall between them. */
  function blast(shielded: boolean) {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const v = npcAt(sim, 'civilian', p.pos.x + f.fx * 10, p.pos.z + f.fz * 10);
    v.maxHealth = 1e6;
    v.health = 1e6;
    const bx = v.pos.x - f.fx * 4;
    const bz = v.pos.z - f.fz * 4;
    if (shielded) {
      // A building wall 10 m tall, 0.5 m thick, 2 m in front of the ped.
      const cx = v.pos.x - f.fx * 2;
      const cz = v.pos.z - f.fz * 2;
      const hx = Math.abs(f.fx) * 0.25 + Math.abs(f.rx) * 6;
      const hz = Math.abs(f.fz) * 0.25 + Math.abs(f.rz) * 6;
      sim.world.grid.addBox(cx - hx, cz - hz, cx + hx, cz + hz, v.pos.y - 1, v.pos.y + 10, 'building');
    }
    const car = sim.spawnVehicle('sedan', v.pos.x + f.rx * 3, v.pos.z + f.rz * 3, f.h);
    const damage = record(sim, 'damage');
    sim.combat.explosion(bx, v.pos.y + 0.8, bz, 8, 300, null, null);
    const hit = damage.find((d) => d.victim === v)!;
    return { amount: hit.healthLoss + hit.armourLoss, knocked: v.state === 'knocked', speed: Math.hypot(v.vel.x, v.vel.z), car: car.spec.health - car.health };
  }

  it('behind a full building wall a ped takes at most a quarter of the open-ground damage and is not knocked down', () => {
    const open = blast(false);
    const shielded = blast(true);
    expect(open.amount).toBeGreaterThan(50);
    expect(shielded.amount).toBeLessThanOrEqual(open.amount * 0.25);
    expect(shielded.amount).toBeGreaterThan(0);
    expect(open.knocked).toBe(true);
    expect(shielded.knocked).toBe(false);
    expect(shielded.speed).toBeLessThanOrEqual(open.speed * 0.25 + 1e-9);
    // Vehicles are unchanged (chain reactions keep working).
    expect(shielded.car).toBeCloseTo(open.car, 6);
  });
});

describe('P32: table-driven numbers', () => {
  it('fists do 13 (NPCs 70%), rockets explode for WEAPONS.rocket.damage and self-destruct after range / speed', () => {
    expect(WEAPONS.fists.damage).toBe(13);
    expect(Object.values(WEAPONS).map((w) => [w.id, w.headMul])).toEqual([
      ['fists', 1],
      ['pistol', 4],
      ['smg', 2.5],
      ['shotgun', 1.5],
      ['rifle', 4],
      ['rocket', 1],
      // Wave 1 (w1-weapons): melee weapons and throwables have no head multiplier; the sniper rifle's is 5.
      ['bat', 1],
      ['knife', 1],
      ['grenade', 1],
      ['molotov', 1],
      ['sniper', 5],
    ]);
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const damage = record(sim, 'damage');
    const g = npcAt(sim, 'gang', p.pos.x + f.fx * 1.1, p.pos.z + f.fz * 1.1);
    g.heading = f.h + Math.PI;
    sim.combat.melee(g);
    expect(damage.find((d) => d.victim === p)!.healthLoss).toBeCloseTo(13 * 0.7, 9);
    // A rocket straight up into the empty sky.
    arm(sim, 'rocket', 4);
    step(sim, 0.4);
    const explosions = record(sim, 'explosion');
    const launched = sim.time;
    sim.update(DT, aimAt(sim, { x: p.pos.x + f.fx * 0.5, y: p.pos.y + 200, z: p.pos.z + f.fz * 0.5 }, { fire: true, firePressed: true, aim: true }));
    let boom = -1;
    for (let i = 0; i < 600 && boom < 0; i++) {
      sim.update(DT, input());
      if (explosions.length > 0) boom = sim.time - launched;
    }
    expect(boom).toBeGreaterThan(WEAPONS.rocket.range / 58 - 0.05);
    expect(boom).toBeLessThan(WEAPONS.rocket.range / 58 + 0.05);
  });

  it('no punch lands through a garage wall, the player’s or a thug’s; with the wall gone the same punches land', () => {
    const sim = makeSim({ police: false });
    const p = sim.player;
    let checked = 0;
    for (const gar of sim.world.layout.garages) {
      for (const w of gar.walls) {
        const alongX = w.maxX - w.minX > w.maxZ - w.minZ;
        const thick = alongX ? w.maxZ - w.minZ : w.maxX - w.minX;
        if (thick > 0.6 || Math.max(w.maxX - w.minX, w.maxZ - w.minZ) < 3) continue;
        // Both standing against it, one on either side of its middle: 1.3 m apart for a 0.5 m wall.
        const cx = (w.minX + w.maxX) / 2;
        const cz = (w.minZ + w.maxZ) / 2;
        const nx = alongX ? 0 : 1;
        const nz = alongX ? 1 : 0;
        const off = thick / 2 + 0.4;
        const a = { x: cx - nx * off, z: cz - nz * off };
        const b = { x: cx + nx * off, z: cz + nz * off };
        if (!sim.world.isFree(a.x, a.z, 0.35) || !sim.world.isFree(b.x, b.z, 0.35)) continue;
        const wall = sim.world.grid.colliders.find((c) => c.tag === 'wall' && !c.broken && c.minX === w.minX && c.maxX === w.maxX && c.minZ === w.minZ && c.maxZ === w.maxZ)!;
        expect(wall).toBeDefined();
        teleport(sim, a.x, a.z);
        p.heading = Math.atan2(b.x - a.x, b.z - a.z);
        const thug = npcAt(sim, 'gang', b.x, b.z);
        thug.brain = null;
        thug.heading = p.heading + Math.PI;
        const punches = record(sim, 'melee');
        const punch = (c: Character) => {
          c.fireCooldown = 0;
          sim.combat.melee(c);
        };
        const where = `garage ${gar.poi} wall at (${cx.toFixed(1)}, ${cz.toFixed(1)})`;
        const thugHp = thug.health;
        const hp = p.health + p.armor;
        punch(p);
        punch(thug);
        expect(thug.health, where).toBe(thugHp);
        expect(p.health + p.armor, where).toBe(hp);
        expect(punches.map((e) => e.hit), where).toEqual([false, false]);
        // The same two punches with the wall knocked out of the way.
        wall.broken = true;
        punch(p);
        punch(thug);
        wall.broken = false;
        expect(thug.health, where).toBeLessThan(thugHp);
        expect(p.health + p.armor, where).toBeLessThan(hp);
        thug.removed = true;
        p.health = p.maxHealth;
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('the punch skips a nearer man behind a garage wall for one in reach on this side; one knocked down behind it is safe too', () => {
    const sim = makeSim({ police: false });
    const p = sim.player;
    let checked = 0;
    for (const gar of sim.world.layout.garages) {
      for (const w of gar.walls) {
        const alongX = w.maxX - w.minX > w.maxZ - w.minZ;
        const thick = alongX ? w.maxZ - w.minZ : w.maxX - w.minX;
        if (thick > 0.6 || Math.max(w.maxX - w.minX, w.maxZ - w.minZ) < 4) continue;
        const cx = (w.minX + w.maxX) / 2;
        const cz = (w.minZ + w.maxZ) / 2;
        // n: across the wall, from the player's side; t: along it.
        const n = { x: alongX ? 0 : 1, z: alongX ? 1 : 0 };
        const t = { x: alongX ? 1 : 0, z: alongX ? 0 : 1 };
        const off = thick / 2 + 0.4;
        const at = { x: cx - n.x * off, z: cz - n.z * off };
        // Behind the wall straight across (1.3 m), and on this side 1.5 m along it.
        const hidden = { x: cx + n.x * off, z: cz + n.z * off };
        const open = { x: at.x + t.x * 1.5, z: at.z + t.z * 1.5 };
        if (![at, hidden, open].every((q) => sim.world.isFree(q.x, q.z, 0.35))) continue;
        teleport(sim, at.x, at.z);
        // Facing 40 degrees from the wall towards the open side: both men are in front of him.
        const toWall = Math.atan2(n.x, n.z);
        const toOpen = Math.atan2(t.x, t.z);
        p.heading = toWall + wrapAngle(toOpen - toWall) * (40 / 90);
        const a = npcAt(sim, 'gang', hidden.x, hidden.z);
        const b = npcAt(sim, 'gang', open.x, open.z);
        a.brain = null;
        b.brain = null;
        const where = `garage ${gar.poi} wall at (${cx.toFixed(1)}, ${cz.toFixed(1)})`;
        p.fireCooldown = 0;
        sim.combat.melee(p);
        expect(a.health, where).toBe(a.maxHealth);
        expect(b.health, where).toBeLessThan(b.maxHealth);
        // Knocked down behind the wall, and nobody else around: no punch reaches him.
        b.removed = true;
        a.state = 'knocked';
        a.knockTimer = 5;
        p.fireCooldown = 0;
        p.heading = toWall;
        sim.combat.melee(p);
        expect(a.health, where).toBe(a.maxHealth);
        a.removed = true;
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('a rocket explosion hits for WEAPONS.rocket.damage at its centre', () => {
    const sim = makeSim();
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const v = npcAt(sim, 'civilian', p.pos.x + f.fx * 20, p.pos.z + f.fz * 20);
    v.maxHealth = 1e6;
    v.health = 1e6;
    const damage = record(sim, 'damage');
    arm(sim, 'rocket', 4);
    step(sim, 0.4);
    sim.update(DT, aimAt(sim, { x: v.pos.x, y: v.pos.y + 1, z: v.pos.z }, { fire: true, firePressed: true, aim: true }));
    step(sim, 1);
    const hit = damage.find((d) => d.victim === v)!;
    expect(hit.kind).toBe('explosion');
    // Within a metre of the blast: 80% of 420 times the falloff.
    expect(hit.healthLoss).toBeGreaterThan(WEAPONS.rocket.damage * 0.8 * (1 - 1.5 / 8));
  });
});

// ---------------------------------------------------------------------------
// Round-2 fixes: car crews fire out of their own window, with the drawn gun along the shot

describe('car crews fire out of their own window, and their drawn gun points along the shot', () => {
  type Part = { mesh: THREE.InstancedMesh };

  /** Where CrowdView draws `c`'s gun this frame: the barrel tip and the way the barrel points. */
  function drawnGun(c: Character): { tip: THREE.Vector3; dir: THREE.Vector3 } {
    const cv = new CrowdView();
    cv.sync([c], c.pos.x, c.pos.z, DT);
    const gun = c.inventory.current as Exclude<WeaponId, 'fists'>;
    const part = (cv as unknown as { weapons: Map<WeaponId, Part> }).weapons.get(gun)!;
    expect(part.mesh.count).toBe(1);
    const m = new THREE.Matrix4();
    part.mesh.getMatrixAt(0, m);
    const t = WEAPON_POINTS[gun].tip;
    return { tip: new THREE.Vector3(t.x, t.y, t.z).applyMatrix4(m), dir: new THREE.Vector3().setFromMatrixColumn(m, 2).normalize() };
  }

  /** A point's offset to the left of a vehicle's centre line (a vehicle's local +X is its left side). */
  const leftOf = (v: Vehicle, q: { x: number; z: number }) => (q.x - v.pos.x) * Math.cos(v.heading) - (q.z - v.pos.z) * Math.sin(v.heading);

  /** The player in a sedan on an open road, and a police cruiser beside him (`side` m to his right, so he is on its left) with a cop in its front passenger seat. */
  function crewBeside(side: number) {
    const sim = makeSim({ police: false });
    const r = openRoad(sim);
    const car = sim.spawnVehicle('sedan', r.x, r.z, r.h);
    placeInCar(sim, car);
    const rx = -Math.cos(r.h);
    const rz = Math.sin(r.h);
    const unit = sim.spawnVehicle('police', r.x + rx * side, r.z + rz * side, r.h);
    const cop = sim.spawnCharacter('cop', unit.pos.x, unit.pos.z);
    cop.inventory.infinite = true;
    cop.inventory.give('pistol', 99);
    cop.inventory.current = 'pistol';
    sim.seat(cop, unit, 1);
    return { sim, car, unit, cop };
  }

  it.each([
    ['left', 5],
    ['right', -5],
  ])('a front passenger fires from his own (right) window where his gun is drawn, with the player on the cruiser’s %s', (_name, side) => {
    const { sim, unit, cop } = crewBeside(side);
    const fired = record(sim, 'weaponFired');
    sim.combat.npcFire(cop, sim.player, 1, true);
    expect(fired.length).toBe(1);
    const e = fired[0]!;
    // Seat 1 is on the right: the shot leaves 0.2 m outside the right flank, at three quarters of the cruiser's height.
    expect(leftOf(unit, e)).toBeCloseTo(-(unit.halfW + 0.2), 6);
    expect(e.y).toBeCloseTo(unit.pos.y + unit.spec.height * 0.75, 6);
    // The drawn gun: its tip at the muzzle, its barrel along the shot (within the recoil kick).
    expect(cop.aimYaw).toBeCloseTo(Math.atan2(e.dx, e.dz), 9);
    expect(cop.aimPitch).toBeCloseTo(Math.asin(e.dy), 9);
    const g = drawnGun(cop);
    expect(g.tip.distanceTo(new THREE.Vector3(e.x, e.y, e.z))).toBeLessThan(0.1);
    expect((g.dir.angleTo(new THREE.Vector3(e.dx, e.dy, e.dz)) * 180) / Math.PI).toBeLessThan(15);
  });

  it('a rear-left passenger fires from the left window; a foot shooter’s gun is raised along his shot too', () => {
    const { sim, unit } = crewBeside(-5);
    const swat = sim.spawnCharacter('swat', unit.pos.x, unit.pos.z);
    swat.inventory.infinite = true;
    swat.inventory.give('smg', 99);
    swat.inventory.current = 'smg';
    unit.passengers.length = 3;
    sim.seat(swat, unit, 2);
    const fired = record(sim, 'weaponFired');
    sim.combat.npcFire(swat, sim.player, 1, true);
    expect(leftOf(unit, fired[0]!)).toBeCloseTo(unit.halfW + 0.2, 6);
    // On foot, aimed by the AI along the ground only: the shot's pitch is published as well.
    const p = sim.player;
    const g = npcAt(sim, 'gang', p.pos.x + 9, p.pos.z + 3);
    g.inventory.infinite = true;
    g.inventory.give('pistol', 99);
    g.inventory.current = 'pistol';
    g.aiming = true;
    g.aimYaw = Math.atan2(p.pos.x - g.pos.x, p.pos.z - g.pos.z);
    g.aimPitch = 0.5;
    fired.length = 0;
    sim.combat.npcFire(g, p, 1);
    const e = fired[0]!;
    expect(e.shooter).toBe(g);
    expect(g.aimYaw).toBeCloseTo(Math.atan2(e.dx, e.dz), 9);
    expect(g.aimPitch).toBeCloseTo(Math.asin(e.dy), 9);
    expect(g.aimPitch).toBeLessThan(0);
  });

  it.each([
    ['above him', 5],
    ['level with him', 0],
    ['below him', -3],
  ])('a foot shooter firing at a target %s raises the gun first: the shot leaves from the barrel tip as drawn', (_name, up) => {
    const sim = makeSim({ police: false });
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const cop = npcAt(sim, 'cop', p.pos.x + f.fx * 8, p.pos.z + f.fz * 8);
    cop.inventory.infinite = true;
    cop.inventory.give('rifle', 99);
    cop.inventory.current = 'rifle';
    // Set up by the AI as it does: aiming along the ground at the player, the gun level.
    cop.heading = f.h + Math.PI;
    cop.aiming = true;
    cop.aimYaw = cop.heading;
    cop.aimPitch = 0;
    p.pos.y += up;
    const fired = record(sim, 'weaponFired');
    sim.combat.npcFire(cop, p, 1);
    expect(fired.length).toBe(1);
    const e = fired[0]!;
    // The gun as drawn after the shot (its published aim) has its tip where the shot left, pointing along it.
    const tip = weaponPose(cop).tip;
    expect(Math.hypot(tip.x - e.x, tip.y - e.y, tip.z - e.z)).toBeLessThan(0.03);
    expect(cop.aimPitch).toBeCloseTo(Math.asin(e.dy), 9);
    if (up > 0) expect(cop.aimPitch).toBeGreaterThan(0.3);
  });

  it('the player’s drive-by from the driver’s seat still leaves from the left window', () => {
    const sim = makeSim({ police: false });
    const r = openRoad(sim);
    const v = sim.spawnVehicle('sedan', r.x, r.z, r.h);
    placeInCar(sim, v);
    arm(sim, 'pistol');
    step(sim, 0.5);
    const fired = record(sim, 'weaponFired');
    const target = { x: v.pos.x + Math.sin(r.h) * 30, y: v.pos.y + 1.2, z: v.pos.z + Math.cos(r.h) * 30 };
    sim.update(DT, aimAt(sim, target, { fire: true, firePressed: true }));
    expect(fired.length).toBe(1);
    expect(fired[0]!.shooter).toBe(sim.player);
    expect(leftOf(v, fired[0]!)).toBeCloseTo(v.halfW + 0.2, 6);
  });

  it('with the cruiser’s driver side against a wall, the passenger’s rounds still reach the player on the open side', () => {
    const { sim, car, unit, cop } = crewBeside(-6);
    // A wall along the cruiser's left flank, 5 cm clear of it.
    const lx = Math.cos(unit.heading);
    const lz = -Math.sin(unit.heading);
    const fx = Math.sin(unit.heading);
    const fz = Math.cos(unit.heading);
    const cx = unit.pos.x + lx * (unit.halfW + 0.05 + 0.15);
    const cz = unit.pos.z + lz * (unit.halfW + 0.05 + 0.15);
    const hx = Math.abs(lx) * 0.15 + Math.abs(fx) * 4;
    const hz = Math.abs(lz) * 0.15 + Math.abs(fz) * 4;
    sim.world.grid.addBox(cx - hx, cz - hz, cx + hx, cz + hz, unit.pos.y - 0.5, unit.pos.y + 4, 'wall');
    const shots = record(sim, 'shot');
    for (let i = 0; i < 12; i++) {
      cop.fireCooldown = 0;
      sim.combat.npcFire(cop, sim.player, 1, true);
    }
    expect(shots.length).toBe(12);
    expect(shots.filter((s) => s.hit === 'vehicle').length).toBeGreaterThanOrEqual(10);
    expect(car.health).toBeLessThan(car.spec.health);
  });
});

// ---------------------------------------------------------------------------
// Fix pass 2: the raise-the-gun solve converges at every range

describe('a foot shooter raises the gun through the target: the shot leaves from the drawn tip along the drawn barrel', () => {
  type Part = { mesh: THREE.InstancedMesh };
  const GUNS = ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'] as const;

  /** The chest point muzzle() falls back on when someone stands along the barrel (point blank). */
  const chestPoint = (c: Character): V3 => {
    const fx = Math.sin(c.aimYaw);
    const fz = Math.cos(c.aimYaw);
    return { x: c.pos.x + fx * 0.55 - fz * 0.18, y: c.pos.y + c.height * 0.76, z: c.pos.z + fz * 0.55 + fx * 0.18 };
  };
  /** How far the line through `o` along the unit `d` passes from `q`. */
  const miss = (o: V3, d: V3, q: V3): number => {
    const x = q.x - o.x;
    const y = q.y - o.y;
    const z = q.z - o.z;
    const a = x * d.x + y * d.y + z * d.z;
    return Math.hypot(x - d.x * a, y - d.y * a, z - d.z * a);
  };

  it('0.5 to 30 m away, 60 degrees above to 60 below, from any earlier aim: the tip as drawn, the barrel through him', () => {
    const sim = makeSim({ world: world(), police: false });
    sim.cheats.godMode = true;
    const f = standOnOpenRoad(sim);
    const p = sim.player;
    const ground = p.pos.y;
    const cop = npcAt(sim, 'cop', p.pos.x - f.fx * 30, p.pos.z - f.fz * 30);
    cop.inventory.infinite = true;
    const cv = new CrowdView();
    const fired = record(sim, 'weaponFired');
    const shots = record(sim, 'shot');
    let tipped = 0;
    let pointBlank = 0;
    for (const gun of GUNS) {
      cop.inventory.give(gun, 99);
      cop.inventory.current = gun;
      // In hand already: no swap time.
      cop.drawnWeapon = gun;
      for (const dist of [0.5, 0.75, 1, 1.2, 1.5, 2, 3, 5, 8, 15, 30]) {
        for (const elev of [-60, -30, 0, 30, 60]) {
          for (const [yawOff, pitch0] of [[0, 0], [0.6, -0.5]] as const) {
            // The cop `dist` m (on the ground) from the player, who is lifted or dropped so that the point the cop fires at
            // (0.62 of his height) is `elev` degrees from the cop's shoulders; set up as the AI does, aiming along the ground.
            cop.pos.x = p.pos.x - f.fx * dist;
            cop.pos.z = p.pos.z - f.fz * dist;
            cop.pos.y = ground;
            cop.heading = f.h;
            cop.aiming = true;
            cop.aimYaw = f.h + yawOff;
            cop.aimPitch = pitch0;
            cop.fireCooldown = 0;
            cop.reloadTimer = 0;
            // Not the last round of the clip: the gun is still drawn as it was fired (a reload would bring it in).
            cop.inventory.slot().clip = 5;
            p.pos.y = ground + 1.5 * cop.appearance.height + Math.tan((elev * Math.PI) / 180) * dist - p.height * 0.62;
            const target = { x: p.pos.x, y: p.pos.y + p.height * 0.62, z: p.pos.z };
            fired.length = 0;
            shots.length = 0;
            sim.combat.npcFire(cop, p, 1);
            const label = `${gun} ${dist} m ${elev} deg from (${yawOff}, ${pitch0})`;
            expect(fired.length, label).toBe(1);
            const e = fired[0]!;
            const pose = weaponPose(cop);
            // Drawn as published, the barrel runs through the target, at point blank too.
            expect(miss(pose.tip, pose.dir, target), label).toBeLessThan(0.01);
            const chest = chestPoint(cop);
            if (Math.hypot(e.x - chest.x, e.y - chest.y, e.z - chest.z) < 1e-9) {
              // The barrel reaches into him: the shot leaves from the chest instead, and still finds him.
              pointBlank++;
              expect(dist, label).toBeLessThanOrEqual(1.2);
              if (gun !== 'rocket') expect(shots.some((s) => s.hit === 'flesh'), label).toBe(true);
              continue;
            }
            tipped++;
            expect(Math.hypot(e.x - pose.tip.x, e.y - pose.tip.y, e.z - pose.tip.z), label).toBeLessThan(0.02);
            expect(Math.hypot(e.dx - pose.dir.x, e.dy - pose.dir.y, e.dz - pose.dir.z), label).toBeLessThan(1e-6);
            // The gun CrowdView draws (past its recoil kick) ends there.
            cop.shotTimer = 0;
            cv.sync([cop], cop.pos.x, cop.pos.z, DT);
            const part = (cv as unknown as { weapons: Map<WeaponId, Part> }).weapons.get(gun)!;
            const m = new THREE.Matrix4();
            part.mesh.getMatrixAt(0, m);
            const t = WEAPON_POINTS[gun].tip;
            expect(new THREE.Vector3(t.x, t.y, t.z).applyMatrix4(m).distanceTo(new THREE.Vector3(e.x, e.y, e.z)), label).toBeLessThan(0.02);
          }
        }
      }
    }
    // Point blank (the target's body within the barrel's reach) is the exception, not the rule.
    expect(tipped).toBeGreaterThan(pointBlank * 3);
  });

  it('steeper than the gun can be raised (a swimmer under a pier, a cop under a balcony) the shot still leaves the drawn tip straight at him', () => {
    const cases = [
      // Treading water, 10 m under the player and 2 m off: 78 degrees up, past the swimmer's 69 (1.2 rad).
      { swim: true, up: 10, off: 2, limit: 1.2 },
      // Standing, the player 6 m up and 0.4 m off: 86 degrees up, past the standing 80 (1.4 rad).
      { swim: false, up: 6, off: 0.4, limit: 1.4 },
    ];
    for (const k of cases) {
      const sim = makeSim({ world: world(), police: false });
      sim.cheats.godMode = true;
      const b = sim.world.layout.bounds;
      const p = sim.player;
      let cop: Character;
      if (k.swim) {
        cop = npcAt(sim, 'cop', b.beachEndX + 40, (b.landMinZ + b.landMaxZ) / 2);
        cop.state = 'swimming';
        cop.pos.y = WATER_Y - SWIM_FLOAT;
      } else {
        const f = standOnOpenRoad(sim);
        cop = npcAt(sim, 'cop', p.pos.x - f.fx * 3, p.pos.z - f.fz * 3);
      }
      cop.brain = null;
      cop.inventory.infinite = true;
      cop.inventory.give('rifle', 99);
      cop.inventory.current = 'rifle';
      cop.drawnWeapon = 'rifle';
      cop.inventory.slot().clip = 5;
      cop.aiming = true;
      cop.aimYaw = cop.heading;
      cop.aimPitch = 0;
      p.pos.x = cop.pos.x + Math.sin(cop.heading) * k.off;
      p.pos.z = cop.pos.z + Math.cos(cop.heading) * k.off;
      p.pos.y = cop.pos.y + k.up;
      const target = { x: p.pos.x, y: p.pos.y + p.height * 0.62, z: p.pos.z };
      const fired = record(sim, 'weaponFired');
      const shots = record(sim, 'shot');
      sim.combat.npcFire(cop, p, 1);
      const label = k.swim ? 'swimming' : 'standing';
      expect(fired.length, label).toBe(1);
      const e = fired[0]!;
      const pose = weaponPose(cop);
      // Drawn at the pose's limit, the flash at its tip, the shot aimed at him from there, and it lands.
      expect(Math.asin(pose.dir.y), label).toBeCloseTo(k.limit, 6);
      expect(Math.hypot(e.x - pose.tip.x, e.y - pose.tip.y, e.z - pose.tip.z), label).toBeLessThan(0.02);
      expect(miss(e, { x: e.dx, y: e.dy, z: e.dz }, target), label).toBeLessThan(0.01);
      expect(shots[0]!.hit, label).toBe('flesh');
    }
  });

  it('at point blank the gun is drawn pointing at the target, not swung aside, and the shot hits him', () => {
    for (const gun of ['pistol', 'rifle', 'shotgun'] as const) {
      for (const dist of [0.72, 0.8, 1, 1.2]) {
        const sim = makeSim({ world: world(), police: false });
        const f = standOnOpenRoad(sim);
        const p = sim.player;
        const cop = npcAt(sim, 'cop', p.pos.x - f.fx * dist, p.pos.z - f.fz * dist);
        cop.inventory.infinite = true;
        cop.inventory.give(gun, 99);
        cop.inventory.current = gun;
        cop.heading = f.h;
        cop.aiming = true;
        cop.aimYaw = f.h;
        cop.aimPitch = 0;
        const hp = p.health + p.armor;
        sim.combat.npcFire(cop, p, 1);
        const pose = weaponPose(cop);
        const target = { x: p.pos.x, y: p.pos.y + p.height * 0.62, z: p.pos.z };
        expect(miss(pose.tip, pose.dir, target), `${gun} ${dist} m`).toBeLessThan(0.01);
        // Turned towards him by no more than the barrel's offset from the body's axis requires (it sits by the right
        // shoulder): the old two-step raise swung it 22-69 degrees aside here.
        const off = Math.abs(wrapAngle(cop.aimYaw - f.h));
        expect(off, `${gun} ${dist} m`).toBeLessThan(Math.asin(Math.min(1, 0.3 / dist)));
        expect(p.health + p.armor, `${gun} ${dist} m`).toBeLessThan(hp);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Round-2 fixes: point blank, the crosshair on someone in front of the gun

describe('point blank: the crosshair on someone in front of the gun hits him; beside or behind the shoulder it never does', () => {
  /**
   * The player aiming along an open road (aimed or from the hip), with an enemy `ahead` m in front of him (behind him
   * when negative) standing so that the crosshair ray passes `u` m to the left of his axis, crossing it at `k` of his
   * height. The shoulder camera's ray always runs through a point over the player's right shoulder (the shoulder offset
   * to his right, 0.18 m over his head height), so the pitch follows from where it has to cross the enemy.
   * The player's body is free to turn: aiming, it turns to the point-blank aim convergence (PlayerController.convergeAim),
   * the gun towards the crosshair's point on him.
   */
  function pointBlank(weapon: WeaponId, aiming: boolean, ahead: number, u: number, k = 0.68) {
    const sim = makeSim({ police: false });
    const f = standOnOpenRoad(sim);
    arm(sim, weapon);
    const p = sim.player;
    const home = { x: p.pos.x, z: p.pos.z };
    const right = (aiming ? 0.62 : 0.42) + u;
    const e = npcAt(sim, 'gang', home.x + f.fx * ahead + f.rx * right, home.z + f.fz * ahead + f.rz * right);
    e.armor = 5000;
    const spot = { x: e.pos.x, z: e.pos.z };
    // Both stand still where they were put (at point blank they would push each other apart).
    const pin = () => {
      teleport(sim, home.x, home.z);
      e.pos.x = spot.x;
      e.pos.z = spot.z;
      e.vel.x = 0;
      e.vel.z = 0;
    };
    const over = p.pos.y + 1.58 * p.appearance.height + 0.18;
    const y = e.pos.y + k * e.height;
    const pitch = ahead > 0 ? Math.atan2(y - over, ahead) : Math.atan2(over - y, -ahead);
    // Within the camera's pitch range.
    expect(pitch).toBeGreaterThan(-1.25);
    expect(pitch).toBeLessThan(1.35);
    const aim = (o: Partial<PlayerInput> = {}) => shoulderAim(sim, f.h, pitch, null, { aim: aiming, ...o });
    step(sim, 0.3, () => {
      pin();
      return aim();
    });
    pin();
    // The crosshair ray really is on him: through his body, or his head.
    const o = aim().aimOrigin;
    const d = aim().aimDir;
    const tc = ((e.pos.x - o.x) * d.x + (e.pos.z - o.z) * d.z) / (d.x * d.x + d.z * d.z);
    expect(tc).toBeGreaterThan(0.5);
    expect(Math.hypot(o.x + d.x * tc - e.pos.x, o.z + d.z * tc - e.pos.z)).toBeCloseTo(Math.abs(u), 6);
    expect(o.y + d.y * tc).toBeCloseTo(y, 6);
    // The bearing from the player to the crosshair's point on him (the ray's nearest approach to his axis).
    const toPoint = Math.atan2(o.x + d.x * tc - home.x, o.z + d.z * tc - home.z);
    const shots = record(sim, 'shot');
    sim.update(DT, aim({ fire: true, firePressed: true }));
    return { sim, e, f, shots: shots.filter((s) => s.shooter === p), home, aimYaw: p.aimYaw, toPoint };
  }

  it.each([
    ['pistol', true, 0.6, 0.15, 0.68],
    ['pistol', true, 0.7, 0.15, 0.68],
    ['pistol', true, 0.55, 0.3, 0.68],
    ['smg', true, 0.55, 0.15, 0.9],
    ['rifle', true, 0.6, 0.15, 0.9],
    ['pistol', false, 0.7, 0.3, 0.68],
    ['smg', false, 0.55, 0.15, 0.9],
    ['rifle', false, 0.6, 0.15, 0.9],
  ] as const)('a %s shot (aimed: %s) hits an enemy %f m ahead with the crosshair %f m in from his axis at %f of his height', (weapon, aiming, ahead, u, k) => {
    const { e, shots, aimYaw, toPoint } = pointBlank(weapon, aiming, ahead, u, k);
    expect(shots.map((s) => s.hit)).toEqual(['flesh']);
    expect(e.armor).toBeLessThan(5000);
    // Aimed (held 0.3 s), within about 1 m the gun has turned onto the crosshair's point on him.
    if (aiming) expect(Math.abs(wrapAngle(aimYaw - toPoint))).toBeLessThan(0.05);
  });

  it.each([
    ['pistol', 0.3, 0.1, 0.9],
    ['rifle', 0.25, 0.1, 0.9],
    ['pistol', 0.22, 0.1, 0.93],
  ] as const)('aimed, the converged %s hits someone just %f m ahead by the shoulder with the crosshair on him (%f m in, at %f of his height)', (weapon, ahead, u, k) => {
    // These stood beside the gun before aim convergence (and were never hit): the body now turns the gun onto him.
    const { e, shots, aimYaw, toPoint } = pointBlank(weapon, true, ahead, u, k);
    expect(shots.map((s) => s.hit)).toEqual(['flesh']);
    expect(e.armor).toBeLessThan(5000);
    expect(Math.abs(wrapAngle(aimYaw - toPoint))).toBeLessThan(0.05);
  });

  it('a head-aimed pistol shot at an enemy 0.6 m ahead, the crosshair through his axis, is a headshot', () => {
    const { sim, e, shots } = pointBlank('pistol', true, 0.6, 0, 0.93);
    expect(shots.map((s) => s.hit)).toEqual(['flesh']);
    expect(5000 - e.armor).toBe(WEAPONS.pistol.damage * WEAPONS.pistol.headMul);
    expect(sim.progress.stats.headshots).toBe(1);
  });

  it.each([
    // Right beside the player (0.2 m ahead or less; 0.25 and 0.3 m were here before aim convergence, see above): the
    // crosshair is on him short of the player's own depth along its ray, and the aim does not reach round to him.
    ['pistol', true, 0.15, 0.1, 0.9],
    ['pistol', true, 0.2, 0.1, 0.93],
    ['rifle', true, 0.12, 0.1, 0.9],
    ['smg', false, 0.2, 0.1, 0.93],
    ['shotgun', false, 0.25, 0.1, 0.9],
    ['pistol', true, -0.6, 0.1, 0.9],
    ['pistol', true, -1.2, 0, 0.68],
  ] as const)('a %s shot (aimed: %s) never hits someone %f m ahead, beside or behind the shoulder, with the crosshair on him (%f m in, at %f of his height)', (weapon, aiming, ahead, u, k) => {
    const { e, shots } = pointBlank(weapon, aiming, ahead, u, k);
    expect(shots.length).toBe(WEAPONS[weapon].pellets);
    for (const s of shots) expect(s.hit).not.toBe('flesh');
    expect(e.armor).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Round-2 fixes: tracers readable from the hip camera

describe('tracers read from the hip camera', () => {
  let W: StaticWorld;
  let R: GameRenderer;
  beforeAll(() => {
    W = world();
    R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'low', fov: 68 });
  });

  /** Screen length (px at 1600x900) of tracer `i` as drawn this frame, and its ends' distances from `p` along `f`. */
  function onScreen(i: number): { px: number; from: THREE.Vector3; to: THREE.Vector3 } {
    const geo = (R.effects as unknown as { tracers: { mesh: THREE.Mesh } }).tracers.mesh.geometry as THREE.InstancedBufferGeometry;
    const a = geo.getAttribute('iFrom') as THREE.InstancedBufferAttribute;
    const b = geo.getAttribute('iTo') as THREE.InstancedBufferAttribute;
    const from = new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i));
    const to = new THREE.Vector3(b.getX(i), b.getY(i), b.getZ(i));
    const cam = R.cameraCtl.camera;
    cam.updateMatrixWorld();
    const pa = from.clone().project(cam);
    const pb = to.clone().project(cam);
    return { px: Math.hypot((pa.x - pb.x) * 800, (pa.y - pb.y) * 450), from, to };
  }

  /** The player on an open road with a wall 15 m ahead, looking along the road from the camera's hip or aimed view; one rifle round fired at the wall. */
  function rifleAtWall(aiming: boolean) {
    const sim = makeSim({ world: W, police: false });
    const f = standOnOpenRoad(sim);
    arm(sim, 'rifle');
    const p = sim.player;
    wallAhead(sim, f, 15);
    R.attach(sim);
    const cam = R.cameraCtl;
    cam.mode = 'play';
    cam.reset(sim);
    cam.yaw = f.h;
    cam.pitch = -0.08;
    const frame = (over: Partial<PlayerInput> = {}) => {
      const ray = cam.rayFor();
      sim.update(DT, input({ aimOrigin: ray.origin, aimDir: ray.dir, cameraYaw: cam.yaw, aim: aiming, ...over }));
      R.render(DT, aiming && p.aimZoom);
    };
    for (let i = 0; i < 60; i++) frame();
    const shots = record(sim, 'shot');
    frame({ fire: true, firePressed: true });
    expect(shots.length).toBe(1);
    expect(shots[0]!.hit).toBe('world');
    return { sim, f, p, frame, shot: shots[0]! };
  }

  /** Screen length (px at 1600x900) of the shot's path from `a` to `b` m out of the muzzle. */
  function pathOnScreen(shot: SimEvents['shot'], a: number, b: number): number {
    const cam = R.cameraCtl.camera;
    cam.updateMatrixWorld();
    const from = new THREE.Vector3(shot.fx, shot.fy, shot.fz);
    const dir = new THREE.Vector3(shot.tx - shot.fx, shot.ty - shot.fy, shot.tz - shot.fz).normalize();
    const pa = from.clone().addScaledVector(dir, a).project(cam);
    const pb = from.clone().addScaledVector(dir, b).project(cam);
    return Math.hypot((pa.x - pb.x) * 800, (pa.y - pb.y) * 450);
  }

  it('from the hip, a rifle round at a wall 15 m ahead shows most of its path on its first frame, not a 3 m dash', () => {
    const { shot, frame } = rifleAtWall(false);
    expect(R.effects.tracerCount).toBe(1);
    const first = onScreen(0).px;
    // Seen from 4.3 m behind the shooter the whole 14 m from the muzzle to the wall is only a few dozen pixels (it runs
    // into the crosshair), and a 3 m streak about half of that, partly behind his arm.
    const whole = pathOnScreen(shot, 0, Math.hypot(shot.tx - shot.fx, shot.ty - shot.fy, shot.tz - shot.fz));
    const dash = pathOnScreen(shot, 0, 3);
    expect(first).toBeGreaterThanOrEqual(0.85 * whole);
    expect(first).toBeGreaterThan(1.6 * dash);
    // It stays that long for the next frame too (about 33 ms in all), then flies on and is gone once it reaches the wall.
    frame();
    expect(R.effects.tracerCount).toBe(1);
    expect(onScreen(0).px).toBeGreaterThanOrEqual(0.85 * whole);
    let frames = 2;
    while (R.effects.tracerCount > 0 && frames < 30) {
      frame();
      frames++;
    }
    expect(frames).toBeLessThanOrEqual(6);
  });

  it('aimed, the same round shows at least 40 px on its first frame', () => {
    rifleAtWall(true);
    expect(R.effects.tracerCount).toBe(1);
    expect(onScreen(0).px).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Round-2 fixes: the muzzle light does not burn out the shooter's head

describe('the muzzle light shines ahead of the barrel, not into the shooter’s face', () => {
  it('the light sits 0.6 m along the shot from the tip, where the sprites stay, and fades out with them', () => {
    const fx = new Effects();
    const glow = (fx as unknown as { glow: { max: number; life: Float32Array; px: Float32Array; py: Float32Array; pz: Float32Array } }).glow;
    fx.muzzleFlash(1, 1.4, 2, FLASH_SIZE.rifle, { dx: 0, dy: 0, dz: 2, shooter: null });
    expect([fx.muzzle.position.x, fx.muzzle.position.y, fx.muzzle.position.z]).toEqual([1, 1.4, 2.6]);
    expect(fx.muzzle.intensity).toBeCloseTo(55 * FLASH_SIZE.rifle, 6);
    let sprites = 0;
    for (let i = 0; i < glow.max; i++) {
      if (glow.life[i]! <= 0) continue;
      sprites++;
      expect(Math.hypot(glow.px[i]! - 1, glow.py[i]! - 1.4, glow.pz[i]! - 2)).toBeLessThan(1e-6);
    }
    expect(sprites).toBe(2);
    const seen: Array<[number, number]> = [];
    for (let i = 0; i < 6; i++) {
      fx.update(DT, 0);
      seen.push([fx.glowCount, fx.muzzle.intensity]);
    }
    // Lit at full strength on its first frame, fading over the next two, dark when the sprites are gone.
    expect(seen[0]![1]).toBeCloseTo(55 * FLASH_SIZE.rifle, 6);
    expect(seen[1]![1]).toBeLessThan(seen[0]![1] * 0.5);
    expect(seen[2]![1]).toBeLessThan(seen[1]![1]);
    for (const [sprites, light] of seen) if (sprites === 0) expect(light).toBe(0);
    expect(seen[5]).toEqual([0, 0]);
    // Without the shot (a helicopter's round) it is lit at the muzzle.
    fx.muzzleFlash(1, 1.4, 2, FLASH_SIZE.rifle);
    expect([fx.muzzle.position.x, fx.muzzle.position.y, fx.muzzle.position.z]).toEqual([1, 1.4, 2]);
  });

  it.each(['smg', 'pistol', 'rifle', 'shotgun'] as const)('an aimed %s shot throws at most 6 on the player’s own head (the noon sun gives 3.3), from a light ahead of him', (weapon) => {
    const W = world();
    const R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'low', fov: 68 });
    const sim = makeSim({ world: W, police: false });
    const f = standOnOpenRoad(sim);
    arm(sim, weapon);
    R.attach(sim);
    R.cameraCtl.mode = 'play';
    R.cameraCtl.reset(sim);
    step(sim, 0.4);
    const p = sim.player;
    sim.update(DT, aimAt(sim, { x: p.pos.x + f.fx * 20, y: p.pos.y + 1.2, z: p.pos.z + f.fz * 20 }, { fire: true, firePressed: true, aim: true }));
    R.render(DT, true);
    const light = R.effects.muzzle;
    expect(light.intensity).toBeGreaterThan(0);
    // His head, and the light's irradiance there (intensity over distance squared, decay 2).
    const head = new THREE.Vector3(p.pos.x, p.pos.y + p.height * 0.9, p.pos.z);
    const lux = light.intensity / light.position.distanceToSquared(head);
    expect(lux).toBeLessThanOrEqual(6 + 1e-9);
    // Ahead of him along the shot, not at his shoulder.
    expect((light.position.x - p.pos.x) * f.fx + (light.position.z - p.pos.z) * f.fz).toBeGreaterThan(0.9);
  });

  it.each(['pistol', 'smg', 'rifle', 'shotgun'] as const)('a %s fired into a wall right in front of him lights its face: the light stays short of it', (weapon) => {
    const W = world();
    const R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'low', fov: 68 });
    // Wall faces from inside the barrel's reach (the gun pokes through and the pull is blocked) to just past the tip.
    for (const face of [0.38, 0.45, 0.55, 0.7, 0.85]) {
      for (const aim of [true, false]) {
        const sim = makeSim({ world: W, police: false });
        const f = standOnOpenRoad(sim);
        const p = sim.player;
        arm(sim, weapon);
        R.attach(sim);
        step(sim, 0.4);
        wallAhead(sim, f, face);
        const home = { x: p.pos.x, z: p.pos.z };
        const target = { x: p.pos.x + f.fx * 6, y: p.pos.y + 1.3, z: p.pos.z + f.fz * 6 };
        step(sim, 0.2, () => {
          teleport(sim, home.x, home.z);
          p.heading = f.h;
          return aimAt(sim, target, { aim });
        });
        teleport(sim, home.x, home.z);
        const fired = record(sim, 'weaponFired');
        const shots = record(sim, 'shot');
        sim.update(DT, aimAt(sim, target, { fire: true, firePressed: true, aim }));
        R.render(DT, aim);
        const label = `${weapon} wall ${face} m ${aim ? 'aimed' : 'hip'}`;
        expect(fired.length, label).toBe(1);
        expect(shots.length, label).toBeGreaterThan(0);
        expect(shots.every((s) => s.hit === 'world'), label).toBe(true);
        const ahead = (q: { x: number; z: number }) => (q.x - p.pos.x) * f.fx + (q.z - p.pos.z) * f.fz;
        const light = R.effects.muzzle;
        const flash = ahead(fired[0]!);
        // On this side of the face it is shot at: 0.15 m short of it, or at the flash when that is nearer still
        // (a tip a few centimetres from the wall), never behind the flash; near enough to light it, and lit.
        expect(face - ahead(light.position), label).toBeGreaterThanOrEqual(Math.min(0.15, face - flash) - 0.005);
        expect(ahead(light.position), label).toBeGreaterThanOrEqual(flash - 1e-6);
        expect(ahead(light.position), label).toBeGreaterThan(face - 0.45);
        expect(light.intensity, label).toBeGreaterThan(0.5);
        sim.world.grid.colliders[sim.world.grid.colliders.length - 1]!.broken = true;
      }
    }
  });

  it('a shot into the open keeps the light the full 0.6 m out; a surface nearer than that keeps it 0.15 m in front', () => {
    const fx = new Effects();
    const at = () => [fx.muzzle.position.x, fx.muzzle.position.y, fx.muzzle.position.z];
    fx.muzzleFlash(1, 1.4, 2, FLASH_SIZE.rifle, { dx: 0, dy: 0, dz: 1, shooter: null });
    // Hits further than 0.75 m, from another muzzle, or on a surface facing away, leave it.
    fx.shotLanded(1, 1.4, 2, 1, 1.4, 12, 0, 0, -1);
    fx.shotLanded(1, 1.4, 1.5, 1, 1.4, 1.7, 0, 0, -1);
    fx.shotLanded(1, 1.4, 2, 1, 1.4, 2.3, 0, 0, 1);
    expect(at()).toEqual([1, 1.4, 2.6]);
    // The nearest of a blast's pellets counts.
    fx.shotLanded(1, 1.4, 2, 1.05, 1.4, 2.5, 0, 0, -1);
    fx.shotLanded(1, 1.4, 2, 1, 1.4, 2.4, 0, 0, -1);
    fx.shotLanded(1, 1.4, 2, 1, 1.4, 2.45, 0, 0, -1);
    expect(fx.muzzle.position.z).toBeCloseTo(2.25, 9);
    expect(fx.muzzle.intensity).toBeCloseTo(55 * FLASH_SIZE.rifle, 6);
    // A wall the shot meets at 60 degrees: 0.15 m in front of its plane, along the shot.
    fx.muzzleFlash(1, 1.4, 2, FLASH_SIZE.rifle, { dx: 0, dy: 0, dz: 1, shooter: null });
    const n = { x: -Math.sin(Math.PI / 3), z: -Math.cos(Math.PI / 3) };
    fx.shotLanded(1, 1.4, 2, 1.1, 1.4, 2.5, n.x, 0, n.z);
    const lp = at();
    expect(lp[0]).toBe(1);
    expect((lp[0]! - 1.1) * n.x + (lp[2]! - 2.5) * n.z).toBeCloseTo(0.15, 9);
    // A hit at the muzzle leaves the light there; a frame later the pull is over and nothing moves it.
    fx.shotLanded(1, 1.4, 2, 1, 1.4, 2.05, 0, 0, -1);
    expect(fx.muzzle.position.z).toBeCloseTo(2, 9);
    fx.muzzleFlash(1, 1.4, 2, FLASH_SIZE.rifle, { dx: 0, dy: 0, dz: 1, shooter: null });
    fx.update(DT, 0);
    fx.update(DT, 0);
    fx.shotLanded(1, 1.4, 2, 1, 1.4, 2.3, 0, 0, -1);
    expect(fx.muzzle.position.z).toBeCloseTo(2.6, 9);
    // Nor after a new simulation is attached (the pull, and its shooter, belonged to the old one).
    fx.muzzleFlash(1, 1.4, 2, FLASH_SIZE.rifle, { dx: 0, dy: 0, dz: 1, shooter: null });
    fx.reset();
    fx.shotLanded(1, 1.4, 2, 1, 1.4, 2.3, 0, 0, -1);
    expect(fx.muzzle.position.z).toBeCloseTo(2.6, 9);
    expect((fx as unknown as { pull: { shooter: unknown } }).pull.shooter).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-2 fixes: scrape sparks read from the chase camera

describe('scrape sparks are bright streaks along their flight', () => {
  type Layer = { mesh: THREE.Mesh; active: number };
  const attr = (fx: Effects, name: string) => ((fx as unknown as { glow: Layer }).glow.mesh.geometry as THREE.InstancedBufferGeometry).getAttribute(name) as THREE.InstancedBufferAttribute;

  it('each spark is a streak (at least 4:1, 0.35-0.5 m long) aligned with its motion, and blooms (luminance over 2.6) on its first frame', () => {
    const fx = new Effects();
    fx.sparks(0, 1, 0, 12, 8, 0);
    fx.update(DT, 0);
    expect(fx.glowCount).toBe(12);
    const col = attr(fx, 'iColor');
    const size = attr(fx, 'iSizeRot');
    const vel = attr(fx, 'iVel');
    for (let i = 0; i < 12; i++) {
      expect(size.getZ(i)).toBeGreaterThanOrEqual(4);
      expect(size.getX(i)).toBeGreaterThan(0.33);
      expect(size.getX(i)).toBeLessThan(0.51);
      // Streaks along the way they fly: the shader turns them by their velocity.
      expect(vel.getW(i)).toBe(1);
      expect(vel.getX(i)).toBeGreaterThan(6);
      const lum = 0.299 * col.getX(i) + 0.587 * col.getY(i) + 0.114 * col.getZ(i);
      expect(lum * col.getW(i)).toBeGreaterThan(2.6);
    }
    // Late in life they have cooled under the threshold.
    for (let k = 0; k < 15; k++) fx.update(DT, 0);
    for (let i = 0; i < fx.glowCount; i++) expect(0.299 * col.getX(i) + 0.587 * col.getY(i) + 0.114 * col.getZ(i)).toBeLessThan(2.6);
    // A muzzle flash keeps its own rotation (no velocity alignment).
    const fx2 = new Effects();
    fx2.muzzleFlash(0, 1, 0, FLASH_SIZE.pistol);
    fx2.update(DT, 0);
    expect(attr(fx2, 'iVel').getW(0)).toBe(0);
  });

  it('a faster grind throws more of them', () => {
    const W = world();
    const sim = makeSim({ world: W, police: false });
    const v = sim.spawnVehicle('sedan', 0, 0, 0);
    v.pos.x = 0;
    v.pos.z = 0;
    const count = (speed: number) => {
      const fx = new Effects();
      v.vel.x = 0.5;
      v.vel.z = speed;
      fx.scrapeSparks(v, v.halfW, 0.5, 0, speed);
      fx.update(1e-4, 0);
      return fx.glowCount;
    };
    const slow = count(6);
    const mid = count(14);
    const fast = count(28);
    expect(slow).toBeGreaterThanOrEqual(4);
    expect(mid).toBeGreaterThan(slow);
    expect(fast).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThanOrEqual(10);
    expect(fast).toBeGreaterThanOrEqual(20);
  });
});
