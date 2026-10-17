// Round 2, combat cluster: one weaponFired per trigger pull and 'damage' events (P5), aim intent and
// the fresh firing ray (P30), shots that stop at walls plus flashes and tracers that always render
// (P31b), and fire cadence, head volumes, blast exposure and table-driven numbers (P32).
// The render checks run headless: the stub header below is copied from fix_render.test.ts.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { V3 } from '../../src/core/math';
import { wrapAngle } from '../../src/core/math';
import { CameraController } from '../../src/render/camera';
import { Effects, FLASH_SIZE } from '../../src/render/effects';
import { GameRenderer } from '../../src/render/renderer';
import type { Character } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import { WEAPONS, type WeaponId } from '../../src/sim/specs';
import type { StaticWorld } from '../../src/world/staticWorld';
import { aimAt, input, makeSim, step, teleport, world } from './helpers';

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
    fx.tracer(0, 1, 0, 0, 1, 20);
    fx.update(0.08, 0.08);
    expect(fx.glowCount).toBeGreaterThan(0);
    expect(fx.tracerCount).toBeGreaterThan(0);
    expect(fx.muzzle.intensity).toBeGreaterThan(0);
    // The next frame they are gone (the 20 m tracer's tail reached the hit after 0.067 s).
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

  it('a tracer streak starts at the muzzle, is 3 m long and flies at 300 m/s', () => {
    const fx = new Effects();
    fx.tracer(0, 1, 0, 0, 1, 15);
    const geo = (fx as unknown as { tracers: { mesh: THREE.Mesh } }).tracers.mesh.geometry as THREE.InstancedBufferGeometry;
    const seg = () => {
      const a = geo.getAttribute('iFrom') as THREE.InstancedBufferAttribute;
      const b = geo.getAttribute('iTo') as THREE.InstancedBufferAttribute;
      return { from: a.getZ(0), to: b.getZ(0) };
    };
    fx.update(DT, 0);
    expect(geo.instanceCount).toBe(1);
    expect(seg()).toEqual({ from: 0, to: 3 });
    fx.update(DT, 0);
    expect(seg().from).toBeCloseTo(5, 5);
    expect(seg().to).toBeCloseTo(8, 5);
    fx.update(DT, 0);
    expect(seg().to).toBeCloseTo(13, 5);
    fx.update(DT, 0);
    // The tail reached the hit point at 15 m: gone.
    expect(geo.instanceCount).toBe(0);
    // Paused frames (dt = 0) hold it where it is.
    fx.tracer(0, 1, 0, 0, 1, 15);
    for (let i = 0; i < 5; i++) fx.update(0, 0);
    expect(geo.instanceCount).toBe(1);
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
    });

    it("the player's automatic fire traces every second round, NPC rounds every round", () => {
      const sim = makeSim({ world: W });
      R.attach(sim);
      settle();
      const p = sim.player;
      const g = npcAt(sim, 'gang', p.pos.x + 30, p.pos.z);
      const shot = (shooter: Character, weapon: WeaponId) =>
        sim.events.emit('shot', { shooter, weapon, fx: 0, fy: 1, fz: 0, tx: 0, ty: 1, tz: 200, hit: 'none', nx: 0, ny: 1, nz: 0, pellet: 0 });
      for (let i = 0; i < 10; i++) shot(p, 'smg');
      R.render(DT, false);
      expect(R.effects.tracerCount).toBe(5);
      settle();
      for (let i = 0; i < 10; i++) shot(g, 'smg');
      for (let i = 0; i < 4; i++) shot(p, 'pistol');
      R.render(DT, false);
      expect(R.effects.tracerCount).toBe(14);
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
    const v = npcAt(sim, 'gang', p.pos.x + f.fx * 1.0 + f.rx * 0.3, p.pos.z + f.fz * 1.0 + f.rz * 0.3);
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
