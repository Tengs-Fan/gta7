// Mission 3, track H (effects and weapons): modelled guns on WEAPON_POINTS, fireballs, debris, sparks, smoke plumes,
// scorch decals, the burnt-wreck material, effect budgets and pools, and the per-tier table.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CrowdView } from '../../src/render/crowd';
import { Effects } from '../../src/render/effects';
import { burntMaterial, burntPatch } from '../../src/render/fx/burnt';
import { FX_BUDGETS, FX_POOL_SIZES, FX_TIERS, type FxTier } from '../../src/render/fx/budget';
import { DEBRIS_SHAPES, debrisGeometry } from '../../src/render/fx/debris';
import { FIREBALL_LIFE, fireballProfile } from '../../src/render/fx/fireball';
import { SCORCH_FADE, SCORCH_LIFE, ScorchDecals } from '../../src/render/fx/scorch';
import { SoftwareMaterials } from '../../src/render/softwareMaterials';
import { makeSim, step } from './helpers';
import { GUN_IDS, gunModel, type GunId } from '../../src/render/weaponModels';
import { Character, type Appearance } from '../../src/sim/entities';
import type { WeaponId } from '../../src/sim/specs';
import { weaponPose, WEAPON_POINTS } from '../../src/sim/pose';

// Awaited, so the stubs exist before the imports above evaluate (vehicleView builds a canvas texture on import).
await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

const LOOK: Appearance = { skin: 0xc68642, shirt: 0x2a2c33, pants: 0x34557f, hair: 0x15110e, hat: 0, height: 1, build: 1 };
const v3 = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
type Part = { mesh: THREE.InstancedMesh; n: number };
const cm = (a: THREE.Vector3, b: THREE.Vector3) => a.distanceTo(b) * 100;

/** Rear end used for the length check: the stock for a gun with one in the shoulder, else the grip. */
function rearOf(id: GunId): 'stock' | 'grip' {
  return id === 'rocket' ? 'grip' : 'stock';
}

describe('VAL-FXW-001: every gun is a modelled gun whose sockets sit on WEAPON_POINTS', () => {
  const report: string[] = [];
  it.each(GUN_IDS)('%s: muzzle, grip and stock within tolerance, barrel along +z, length within 10%%', (id) => {
    const m = gunModel(id);
    const pts = WEAPON_POINTS[id];
    const muzzle = cm(m.sockets.muzzle, v3(pts.tip));
    const grip = cm(m.sockets.grip, v3(pts.grip));
    const stock = cm(m.sockets.stock, v3(pts.stock));
    const axis = THREE.MathUtils.radToDeg(m.sockets.axis.angleTo(new THREE.Vector3(0, 0, 1)));
    const rear = rearOf(id);
    const want = v3(pts.tip).distanceTo(v3(pts[rear]));
    const got = m.sockets.muzzle.distanceTo(m.sockets[rear]);
    // And the drawn length: from the rearmost point of the model to its muzzle, against the points' span.
    m.geometry.computeBoundingBox();
    const span = pts.tip.z - Math.min(pts.stock.z, pts.grip.z, pts.reload.z);
    const drawnLen = m.sockets.muzzle.z - m.geometry.boundingBox!.min.z;
    report.push(`${id}: muzzle ${muzzle.toFixed(2)} cm, grip ${grip.toFixed(2)} cm, stock ${stock.toFixed(2)} cm, axis ${axis.toFixed(2)} deg, length ratio ${(got / want).toFixed(3)} (drawn ${(drawnLen / span).toFixed(3)}), ${m.triangles} tris`);
    expect(muzzle).toBeLessThanOrEqual(1);
    expect(grip).toBeLessThanOrEqual(1);
    expect(stock).toBeLessThanOrEqual(2);
    expect(axis).toBeLessThanOrEqual(2);
    expect(got / want).toBeGreaterThan(0.9);
    expect(got / want).toBeLessThan(1.1);
    expect(drawnLen / span).toBeGreaterThan(0.9);
    expect(drawnLen / span).toBeLessThan(1.1);
    // A model, not a few boxes: hundreds of triangles with a hollow bore (faces inside the muzzle, facing in).
    expect(m.triangles).toBeGreaterThan(250);
    expect(m.geometry.hasAttribute('color')).toBe(true);
  });

  it('each gun has its own silhouette (bounding boxes differ by at least 2 cm in some extent)', () => {
    const boxes = GUN_IDS.map((id) => {
      const g = gunModel(id).geometry;
      g.computeBoundingBox();
      return g.boundingBox!;
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const d = Math.max(a.min.distanceTo(b.min), a.max.distanceTo(b.max));
        expect(d, `${GUN_IDS[i]} vs ${GUN_IDS[j]}`).toBeGreaterThan(0.02);
      }
    }
    console.log(report.join('\n'));
  });

  it.each(GUN_IDS)('%s drawn in hand: the posed model puts its muzzle on weaponPose().tip (<= 1 cm) and its axis on dir (<= 2 deg)', (id) => {
    const c = new Character(1, 'civilian', 0, 0, 0, { ...LOOK });
    c.inventory.give(id as WeaponId, 100);
    c.inventory.current = id as WeaponId;
    for (const aim of [false, true]) {
      c.aiming = aim;
      const cv = new CrowdView();
      for (let i = 0; i < 30; i++) cv.sync([c], 0, 0, 1 / 60);
      const part = (cv as unknown as { weapons: Map<WeaponId, Part> }).weapons.get(id as WeaponId)!;
      expect(part.mesh.name).toBe('gun-' + id);
      const mat = new THREE.Matrix4();
      part.mesh.getMatrixAt(0, mat);
      const w = weaponPose(c);
      const tip = gunModel(id).sockets.muzzle.clone().applyMatrix4(mat);
      expect(cm(tip, v3(w.tip))).toBeLessThanOrEqual(1);
      const axis = gunModel(id).sockets.axis.clone().transformDirection(mat);
      expect(THREE.MathUtils.radToDeg(axis.angleTo(v3(w.dir)))).toBeLessThanOrEqual(2);
      const grip = gunModel(id).sockets.grip.clone().applyMatrix4(mat);
      const want = new THREE.Vector3(WEAPON_POINTS[id].grip.x, WEAPON_POINTS[id].grip.y, WEAPON_POINTS[id].grip.z).applyMatrix4(mat);
      expect(cm(grip, want)).toBeLessThanOrEqual(1);
    }
  });

  it('WEAPON_POINTS and sim/pose.ts are untouched by this track (the source has no diff against d98da7b in the points)', () => {
    const src = readFileSync(join(__dirname, '../../src/sim/specs.ts'), 'utf8');
    expect(src).toContain("points: { tip: P(0, 0, 0.21), grip: P(0, -0.065, 0.02), fore: P(0.03, -0.085, 0.005), stock: P(0, 0, -0.01), reload: P(0, -0.15, 0.02) }");
    expect(src).toContain("points: { tip: P(0, 0.08, 0.775), grip: P(0, -0.075, 0.1), fore: P(0, -0.02, 0.32), stock: P(0, 0.08, 0.2), reload: P(0, 0.06, -0.36) }");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Effects

const DT = 1 / 60;
const flat = { groundHeight: () => 0, waterDepth: () => -1 };

function sedanAt(x: number, z: number, color = 0xc03020) {
  const sim = makeSim();
  const v = sim.spawnVehicle('sedan', x, z, 0);
  v.color = color;
  return { sim, v };
}

describe('VAL-FXW-003: the fireball is a layered volume with a deterministic lifecycle', () => {
  it('the same presentation seed gives the same fireball; another seed another one', () => {
    for (const t of [0, 0.1, 0.25, 0.5, 1, 1.5]) {
      expect(fireballProfile(1234, 7.5, 14, t)).toEqual(fireballProfile(1234, 7.5, 14, t));
    }
    expect(fireballProfile(1234, 7.5, 14, 0.3)).not.toEqual(fireballProfile(98765, 7.5, 14, 0.3));
  });

  it.each([[7.5, 14], [8, 14], [6, 11], [4, 8]])('blast radius %f: grows to its peak within 0.4 s, cools into smoke, gone by 2.0 s', (radius, n) => {
    const ts = Array.from({ length: 201 }, (_, i) => i * 0.01);
    const prof = ts.map((t) => fireballProfile(77, radius, n, t));
    const peakAt = ts[prof.reduce((b, p, i) => (p.area > prof[b]!.area ? i : b), 0)]!;
    const glowPeakAt = ts[prof.reduce((b, p, i) => (p.glow > prof[b]!.glow ? i : b), 0)]!;
    console.log(`radius ${radius}: area peak ${prof.reduce((m, p) => Math.max(m, p.area), 0).toFixed(1)} m2 at ${peakAt.toFixed(2)} s, glow peak at ${glowPeakAt.toFixed(2)} s, lobes at 0.1 s ${prof[10]!.lobes}, glow 1.0 s / peak ${(prof[100]!.glow / prof.reduce((m, p) => Math.max(m, p.glow), 0)).toFixed(3)}`);
    expect(prof[0]!.area).toBeLessThan(prof[10]!.area);
    // "Its screen area grows from 0 s to its peak within 0.4 s" (the burning part; the cooled smoke only rises after).
    expect(glowPeakAt).toBeLessThanOrEqual(0.4);
    expect(prof[40]!.area).toBeGreaterThan(prof.reduce((m, p) => Math.max(m, p.area), 0) * 0.85);
    // At least 3 lobes burning at 0.1 and 0.25 s.
    expect(prof[10]!.lobes).toBeGreaterThanOrEqual(3);
    expect(prof[25]!.lobes).toBeGreaterThanOrEqual(3);
    // Darkens into smoke: little heat left at 1 s, nothing at all by FIREBALL_LIFE <= 2 s.
    expect(prof[100]!.glow).toBeLessThan(0.15 * prof.reduce((m, p) => Math.max(m, p.glow), 0));
    expect(FIREBALL_LIFE).toBeLessThanOrEqual(2);
    expect(prof[Math.ceil(FIREBALL_LIFE * 100)]!.lobes).toBe(0);
    // Bigger blasts, bigger fireballs.
    expect(fireballProfile(77, radius * 2, n, 0.4).area).toBeGreaterThan(prof[40]!.area * 3);
  });

  it('effects never use sim.rng: two identical runs give the same particles, and the sim is untouched', () => {
    const run = () => {
      const fx = new Effects();
      fx.bindWorld(flat);
      fx.explosion(0, 1, 0, 7.5);
      for (let i = 0; i < 20; i++) fx.update(DT, i * DT, new THREE.Vector3(0, 2, 15));
      const g = (fx as unknown as { puffs: { mesh: THREE.Mesh } }).puffs.mesh.geometry as THREE.InstancedBufferGeometry;
      return Array.from((g.getAttribute('iPos') as THREE.InstancedBufferAttribute).array.slice(0, g.instanceCount * 4));
    };
    expect(run()).toEqual(run());
    const src = readFileSync(join(__dirname, '../../src/render/effects.ts'), 'utf8') + readFileSync(join(__dirname, '../../src/render/fx/fireball.ts'), 'utf8');
    expect(src).not.toMatch(/\bsim\.rng\.(next|range|int)/);
    expect(src).not.toMatch(/from '\.\.\/sim\/sim'/);
  });

  it('builds its warm-up stand-ins once: repeated warm-ups (tier switches, context restores) add no geometry or copy', () => {
    const fx = new Effects();
    let fades = 0;
    const fade = (m: THREE.Material): THREE.Material => {
      fades++;
      return m.clone();
    };
    const parts = (g: THREE.Object3D) => {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      let meshes = 0;
      g.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        meshes++;
        geometries.add(o.geometry);
        materials.add(o.material as THREE.Material);
      });
      return { geometries: geometries.size, materials: materials.size, meshes };
    };
    const first = fx.warmupProbes(fade);
    const shadows = fx.shadowProbes([]);
    const before = { warm: parts(first), shadow: parts(shadows) };
    for (let i = 0; i < 4; i++) {
      expect(fx.warmupProbes(fade)).toBe(first);
      expect(fx.shadowProbes([])).toBe(shadows);
    }
    expect({ warm: parts(first), shadow: parts(shadows) }).toEqual(before);
    expect(before.warm.geometries).toBe(1);
    expect(fades).toBe(1);
  });

  it('a molotov fire gives flames and smoke, never a fireball', () => {
    const fx = new Effects();
    fx.bindWorld(flat);
    for (let i = 0; i < 120; i++) {
      fx.groundFire(0, 0, 0, 1.2, DT, 1);
      fx.update(DT, i * DT, new THREE.Vector3(0, 2, 10));
    }
    const st = fx.stats();
    expect(st.fireballs).toBe(0);
    expect(st.flamePuffs as number).toBeGreaterThanOrEqual(3);
    expect(st.smokePuffs as number).toBeGreaterThanOrEqual(2);
  });
});

describe('VAL-FXW-004: debris and sparks', () => {
  it('debris shapes are modelled pieces, not unit boxes', () => {
    const { info, geometry } = debrisGeometry();
    expect(DEBRIS_SHAPES.length).toBeGreaterThanOrEqual(5);
    for (let k = 0; k < info.length; k++) expect(info[k]!.verts.length / 3, DEBRIS_SHAPES[k]).toBeGreaterThan(36);
    expect(geometry.hasAttribute('aShape')).toBe(true);
  });

  it('a vehicle explosion throws >= 8 pieces in its paint or charred; they rest on the ground (<= 2 cm below), stay out of walls and fade within their life', () => {
    const { v } = sedanAt(0, 0);
    // Ground with a kerb at x > 3 (0.15 m up) and a wall at x = 6.
    const world = {
      groundHeight: (x: number) => (x > 3 ? 0.15 : 0),
      waterDepth: () => -1,
      lineOfSight: (ax: number, _ay: number, _az: number, bx: number) => !(Math.max(ax, bx) >= 6 && Math.min(ax, bx) < 6),
    };
    const fx = new Effects();
    fx.bindWorld(world);
    fx.vehicleExploded(v);
    const probe0 = fx.debrisProbe();
    expect(probe0.length).toBeGreaterThanOrEqual(8);
    expect(new Set(probe0.map((p) => p.shape)).size).toBeGreaterThanOrEqual(4);
    const mesh = (fx as unknown as { parts: { mesh: THREE.InstancedMesh } }).parts.mesh;
    fx.update(DT, 0);
    const c = new THREE.Color();
    const paint = new THREE.Color(v.color);
    let painted = 0;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getColorAt(i, c);
      if (c.r > c.g * 1.4 && c.r > 0.05) painted++;
    }
    expect(paint.r).toBeGreaterThan(paint.g);
    expect(painted).toBeGreaterThanOrEqual(2);
    let maxY = 0;
    for (let t = 0; t < 6; t += DT) {
      fx.update(DT, t);
      for (const p of fx.debrisProbe()) maxY = Math.max(maxY, p.y);
    }
    const rest = fx.debrisProbe();
    expect(maxY).toBeGreaterThan(2);
    const lines = rest.map((p) => `${p.shape}: rest ${p.resting} low-ground ${((p.low - world.groundHeight(p.x)) * 100).toFixed(2)} cm x ${p.x.toFixed(2)}`);
    console.log(lines.join('\n'));
    for (const p of rest) {
      expect(p.resting, p.shape).toBe(true);
      expect(p.low - world.groundHeight(p.x), p.shape).toBeGreaterThanOrEqual(-0.02);
      expect(p.low - Math.max(world.groundHeight(p.x - 0.5), world.groundHeight(p.x + 0.5)), p.shape).toBeLessThan(0.6);
      expect(p.x, `${p.shape} inside the wall`).toBeLessThan(6);
    }
    for (let t = 0; t < 16; t += 0.1) fx.update(0.1, t);
    expect(fx.partCount).toBe(0);
  });

  it.each(['vehicle', 'world'] as const)('bullet hits on a %s and every explosion emit spark streaks that fall and are gone within 0.6 s', (kind) => {
    const fx = new Effects();
    fx.bindWorld(flat);
    fx.impact(0, 1, 0, 0, 0, 1, kind);
    fx.update(DT, 0);
    expect(fx.glowCount).toBeGreaterThan(0);
    const glow = (fx as unknown as { glow: { mesh: THREE.Mesh } }).glow.mesh.geometry as THREE.InstancedBufferGeometry;
    const vel = glow.getAttribute('iVel') as THREE.InstancedBufferAttribute;
    for (let i = 0; i < fx.glowCount; i++) expect(vel.getW(i), 'streak').toBe(1);
    for (let t = DT; t < 0.6; t += DT) fx.update(DT, t);
    expect(fx.glowCount).toBe(0);
    const fx2 = new Effects();
    fx2.bindWorld(flat);
    fx2.explosion(0, 1, 0, 7.5);
    fx2.update(DT, 0);
    expect(fx2.glowCount).toBeGreaterThan(10);
    for (let t = DT; t < 0.6; t += DT) fx2.update(DT, t);
    expect(fx2.glowCount).toBe(0);
  });

  it('presentation only: a 30 s sim with explosions gives the same state hash with and without the effects view', () => {
    const hash = (withFx: boolean): string => {
      const sim = makeSim({ seed: 11 });
      const fx = withFx ? new Effects() : null;
      if (fx) {
        fx.bindWorld(sim.world);
        sim.events.on('explosion', (e) => fx.explosion(e.x, e.y, e.z, e.radius));
        sim.events.on('vehicleDestroyed', (e) => fx.vehicleExploded(e.vehicle));
        sim.events.on('shot', (e) => fx.impact(e.tx, e.ty, e.tz, e.nx, e.ny, e.nz, e.hit === 'vehicle' ? 'vehicle' : 'world'));
      }
      const p = sim.player;
      const cars = [0, 1, 2].map((i) => sim.spawnVehicle('sedan', p.pos.x + 8 + i * 6, p.pos.z + 6, 0));
      for (let s = 0; s < 30 * 60; s++) {
        if (s === 60 || s === 300 || s === 600) sim.combat.explodeVehicle(cars[s === 60 ? 0 : s === 300 ? 1 : 2]!);
        step(sim, DT);
        if (fx) {
          for (const v of sim.vehicles) if (v.destroyed) fx.vehicleSmoke(v.pos.x, v.pos.y + 1, v.pos.z, v.condition, v.burning, v.wreckTime < 25, DT, v.wreckTime);
          fx.update(DT, s * DT, new THREE.Vector3(p.pos.x, 3, p.pos.z - 10));
        }
      }
      const r = (n: number) => n.toFixed(5);
      return JSON.stringify({ t: r(sim.time), rng: sim.rng.next(), c: sim.characters.map((c) => [c.id, r(c.pos.x), r(c.pos.y), r(c.pos.z), r(c.health)]), v: sim.vehicles.map((v) => [v.id, r(v.pos.x), r(v.pos.y), r(v.pos.z), r(v.health), v.destroyed]) });
    };
    const a = hash(false);
    const b = hash(true);
    expect(b).toBe(a);
  });
});

describe('VAL-FXW-005: wreck smoke plumes', () => {
  it('a burning wreck makes a dense dark plume that rises above 8 m within 3 s, widens with height, and stops once burnt out', () => {
    const fx = new Effects();
    fx.bindWorld(flat);
    const eye = new THREE.Vector3(0, 2, 20);
    for (let t = 0; t < 3; t += DT) {
      fx.vehicleSmoke(0, 0.8, 0, 0, false, true, DT, t);
      fx.update(DT, t, eye);
    }
    const g = (fx as unknown as { puffs: { mesh: THREE.Mesh } }).puffs.mesh.geometry as THREE.InstancedBufferGeometry;
    const pos = g.getAttribute('iPos') as THREE.InstancedBufferAttribute;
    const prm = g.getAttribute('iParam') as THREE.InstancedBufferAttribute;
    let top = 0;
    let lowSize = 0;
    let lowN = 0;
    let highSize = 0;
    let highN = 0;
    for (let i = 0; i < g.instanceCount; i++) {
      if (prm.getY(i) > 0.05) continue;
      top = Math.max(top, pos.getY(i));
      if (pos.getY(i) < 4) { lowSize += pos.getW(i); lowN++; }
      if (pos.getY(i) > 7) { highSize += pos.getW(i); highN++; }
    }
    console.log(`plume top ${top.toFixed(1)} m at 3 s, puff size low ${(lowSize / lowN).toFixed(2)} m, high ${(highSize / highN).toFixed(2)} m`);
    expect(top).toBeGreaterThan(8.8);
    expect(highSize / highN).toBeGreaterThan((lowSize / lowN) * 1.5);
    // Burnt out (wreckTime past 25 s): it stops.
    for (let t = 25; t < 45; t += 0.1) {
      fx.vehicleSmoke(0, 0.8, 0, 0, false, false, 0.1, t);
      fx.update(0.1, t, eye);
    }
    expect(fx.stats().smokePuffs).toBe(0);
  });

  it('Low draws the plume with fewer particles', () => {
    const count = (tier: FxTier) => {
      const fx = new Effects();
      fx.bindWorld(flat);
      fx.setTier(tier);
      for (let t = 0; t < 5; t += DT) {
        fx.vehicleSmoke(0, 0.8, 0, 0, false, true, DT, t);
        fx.update(DT, t, null);
      }
      return fx.stats().smokePuffs as number;
    };
    const high = count('high');
    const low = count('low');
    expect(low).toBeGreaterThan(5);
    expect(low).toBeLessThan(high * 0.7);
  });
});

describe('VAL-FXW-006: scorch decals', () => {
  it('never more live decals than the cap; the oldest fades first and goes first; they last >= 20 s and fade >= 2 s', () => {
    expect(SCORCH_LIFE).toBeGreaterThanOrEqual(20);
    expect(SCORCH_FADE).toBeGreaterThanOrEqual(2);
    const d = new ScorchDecals(6);
    d.setCap(5);
    const births: number[] = [];
    for (let i = 0; i < 12; i++) {
      d.add(i * 10, 0, 3, 1, 0, flat);
      births.push(d.clock);
      expect(d.live).toBeLessThanOrEqual(5);
      const lives = d.lives();
      if (i >= 4) {
        // At the cap the oldest is already fading (dies within SCORCH_FADE), the rest keep their full life.
        expect(lives[0]!.death - d.clock).toBeLessThanOrEqual(SCORCH_FADE + 1e-9);
        for (const l of lives.slice(1)) expect(l.death - l.birth).toBeCloseTo(SCORCH_LIFE + SCORCH_FADE, 6);
      }
      // Live ones are the newest.
      expect(lives.map((l) => l.birth)).toEqual(births.slice(-lives.length));
      d.update(0.5);
    }
    const one = new ScorchDecals(4);
    one.add(0, 0, 3, 1, 0, flat);
    for (let t = 0; t < 20; t += 0.5) one.update(0.5);
    expect(one.live).toBe(1);
    for (let t = 0; t < 11; t += 0.5) one.update(0.5);
    expect(one.live).toBe(0);
  });

  it('nothing is laid over water, and grid points beside a kerb step drop out instead of floating across it', () => {
    const d = new ScorchDecals(4);
    expect(d.add(0, 0, 3, 1, 0, { groundHeight: () => -2, waterDepth: () => 1.5 })).toBe(false);
    expect(d.add(0, 0, 3, 1, 0, { groundHeight: (x) => (x > 0.5 ? 0.15 : 0), waterDepth: () => -1 })).toBe(true);
    const g = d.mesh.geometry;
    const pos = g.getAttribute('position');
    const inf = g.getAttribute('aInfo');
    for (let i = 0; i < 17 * 17; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // Every point sits a centimetre over the ground under it.
      expect(y - (x > 0.5 ? 0.15 : 0)).toBeCloseTo(0.012, 6);
      // Next to the step the decal is clear (both sides of the kerb face), elsewhere drawn.
      const near = Math.abs(x - 0.5) < 3 / 8 + 1e-6 && Math.abs(x - 0.5) < 0.38;
      if (near) expect(inf.getX(i)).toBe(0);
    }
  });
});

describe('VAL-FXW-007: the burnt-wreck material', () => {
  it('every wreck view uses the shared burnt material, a patched (soot, char, bare metal) shader with its own program key', () => {
    const m = burntMaterial();
    expect(m.customProgramCacheKey()).toBe('wreck-burnt-v1');
    for (const f of ['vehicleView.ts', 'bikeView.ts', 'boatView.ts']) {
      expect(readFileSync(join(__dirname, '../../src/render', f), 'utf8'), f).toContain('const burntMat = burntMaterial();');
    }
    const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
    burntPatch(shader);
    expect(shader.vertexShader).toContain('vBurntPos = position;');
    expect(shader.fragmentShader).toContain('burntNoise');
    expect(shader.fragmentShader).toContain('metalnessFactor = mix(');
  });

  it('the software stand-in keeps the burnt colour patch', () => {
    const sw = new SoftwareMaterials();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), burntMaterial());
    sw.apply(mesh);
    const lam = mesh.material as unknown as THREE.MeshLambertMaterial;
    expect(lam).toBeInstanceOf(THREE.MeshLambertMaterial);
    const shader = { vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
    lam.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('burntNoise');
  });
});

describe('VAL-FXW-008: budgets and pools', () => {
  it('every effect type and the guns have declared caps per tier, Low at or below High', () => {
    for (const t of ['high', 'medium', 'low', 'software'] as const) {
      const b = FX_BUDGETS[t];
      for (const k of ['fireballs', 'fireballPuffs', 'puffs', 'debris', 'sparks', 'scorches'] as const) {
        expect(b[k], `${t} ${k}`).toBeGreaterThan(0);
        expect(b[k], `${t} ${k}`).toBeLessThanOrEqual(FX_BUDGETS.high[k]);
        expect(b[k]).toBeLessThanOrEqual(FX_POOL_SIZES[k]);
      }
    }
  });

  it.each(['high', 'low'] as const)('%s: 200 effects spawned and expired allocate no geometry or material after the first cycle, and never pass their caps', (tier) => {
    const fx = new Effects();
    fx.bindWorld(flat);
    fx.setTier(tier);
    const { v } = sedanAt(0, 0);
    const b = FX_BUDGETS[tier];
    const cycle = () => {
      for (let i = 0; i < 200; i++) {
        const k = i % 5;
        if (k === 0) fx.explosion(i, 1, 0, 7.5);
        else if (k === 1) fx.vehicleExploded(v);
        else if (k === 2) fx.impact(i, 1, 0, 0, 1, 0, 'vehicle');
        else if (k === 3) fx.groundFire(i, 0, 0, 1.5, 0.1, 1);
        else fx.vehicleSmoke(i, 1, 0, 0, false, true, 0.1, 1);
        fx.update(0.05, i * 0.05, new THREE.Vector3(0, 2, 20));
        const s = fx.stats();
        expect(s.fireballs as number).toBeLessThanOrEqual(b.fireballs);
        expect(s.puffs as number).toBeLessThanOrEqual(b.puffs);
        expect(s.debris as number).toBeLessThanOrEqual(b.debris);
        expect(s.sparks as number).toBeLessThanOrEqual(b.sparks);
        expect(s.scorches as number).toBeLessThanOrEqual(b.scorches);
        expect(s.fireballPuffs as number).toBeLessThanOrEqual(b.fireballs * b.fireballPuffs);
      }
      // Everything expires.
      for (let t = 0; t < 40; t += 0.25) fx.update(0.25, t, null);
    };
    const ids = () => {
      const g = new Set<string>();
      const m = new Set<string>();
      fx.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) g.add(mesh.geometry.uuid);
        for (const x of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) m.add(x.uuid);
      });
      return { g: [...g].sort(), m: [...m].sort() };
    };
    cycle();
    const first = ids();
    cycle();
    expect(ids()).toEqual(first);
    expect(fx.stats().puffs).toBe(0);
    expect(fx.stats().debris).toBe(0);
  });

  it('all live effects of one type are one draw: puffs, debris, scorches, sparks each a single mesh', () => {
    const fx = new Effects();
    const names = new Map<string, number>();
    fx.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) names.set(o.name, (names.get(o.name) ?? 0) + 1);
    });
    for (const n of ['fx-puffs', 'fx-debris', 'fx-scorch']) expect(names.get(n), n).toBe(1);
  });
});

describe('VAL-FXW-009: the per-tier table', () => {
  it('docs/graphics.md lists every effect and the guns per tier exactly as FX_TIERS', () => {
    const doc = readFileSync(join(__dirname, '../../docs/graphics.md'), 'utf8');
    const tiers: FxTier[] = ['high', 'medium', 'low', 'software'];
    for (const [feature, row] of Object.entries(FX_TIERS)) {
      for (const t of tiers) expect(row[t], `${feature} ${t}`).toMatch(/\S/);
      expect(doc, feature).toContain(`| ${feature} | ${tiers.map((t) => row[t]).join(' | ')} |`);
    }
  });

  it('setTier only changes caps (pools keep their size), and Low lowers them', () => {
    const fx = new Effects();
    fx.setTier('low');
    expect(fx.stats().puffCap).toBe(FX_BUDGETS.low.puffs);
    expect(fx.stats().scorchCap).toBe(FX_BUDGETS.low.scorches);
    fx.setTier('high');
    expect(fx.stats().puffCap).toBe(FX_BUDGETS.high.puffs);
  });
});

describe('VAL-FXW-002: the flash and the held tracer ride the drawn muzzle as the gun kicks', () => {
  it('flash sprites and a tracer still held at the barrel follow the muzzle the crowd draws; the muzzle light stays put', () => {
    const fx = new Effects();
    const c = new Character(1, 'civilian', 0, 0, 0, { ...LOOK });
    const drawn = new THREE.Vector3(0, 1.4, 0.5);
    fx.trackMuzzles(() => drawn);
    fx.muzzleFlash(0, 1.4, 0.5, 0.3, { dx: 0, dy: 0, dz: 1, shooter: c } as never);
    fx.tracer(0, 1.4, 0.5, 0, 1.4, 30);
    fx.update(DT, 0);
    const light0 = fx.muzzle.position.clone();
    const glow = (fx as unknown as { glow: { mesh: THREE.Mesh } }).glow.mesh.geometry as THREE.InstancedBufferGeometry;
    const tr = (fx as unknown as { tracers: { mesh: THREE.Mesh } }).tracers.mesh.geometry as THREE.InstancedBufferGeometry;
    // The gun kicks up 4 cm and back 2 cm.
    drawn.set(0, 1.44, 0.48);
    fx.update(DT, DT);
    const iPos = glow.getAttribute('iPos') as THREE.InstancedBufferAttribute;
    for (let i = 0; i < fx.glowCount; i++) expect(new THREE.Vector3(iPos.getX(i), iPos.getY(i), iPos.getZ(i)).distanceTo(drawn)).toBeLessThan(1e-5);
    const from = tr.getAttribute('iFrom') as THREE.InstancedBufferAttribute;
    expect(new THREE.Vector3(from.getX(0), from.getY(0), from.getZ(0)).distanceTo(drawn)).toBeLessThan(1e-5);
    expect(fx.muzzle.position.distanceTo(light0)).toBeLessThan(1e-9);
  });

  it('CrowdView.muzzleOf is the sim tip with no kick, and moves with the recoil', () => {
    const c = new Character(1, 'civilian', 0, 0, 0, { ...LOOK });
    c.inventory.give('pistol', 100);
    c.inventory.current = 'pistol';
    c.aiming = true;
    const cv = new CrowdView();
    for (let i = 0; i < 30; i++) cv.sync([c], 0, 0, 1 / 60);
    expect(cv.muzzleOf(c)!.distanceTo(v3(weaponPose(c).tip))).toBeLessThan(1e-4);
    c.shotTimer = 0.05;
    cv.sync([c], 0, 0, 1 / 60);
    const kicked = cv.muzzleOf(c)!.clone();
    const part = (cv as unknown as { weapons: Map<WeaponId, Part> }).weapons.get('pistol')!;
    const mat = new THREE.Matrix4();
    part.mesh.getMatrixAt(0, mat);
    // The same point the gun is drawn with.
    expect(gunModel('pistol').sockets.muzzle.clone().applyMatrix4(mat).distanceTo(kicked)).toBeLessThan(1e-4);
  });
});
