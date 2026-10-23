// Wave 1 track C: the views of the new vehicle classes (render/bikeView.ts) and their riders (render/riders.ts, posed
// by CrowdView.riding), and the renderer's pool that hands out a view by class (render/classViews.ts). The render
// modules run headless on the canvas/document stub of fix_render.test.ts (copied: vi.hoisted cannot be shared).

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

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
    style: {},
    getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});
import { BikeView, bikeKinds } from '../../src/render/bikeView';
import { ClassViewPool } from '../../src/render/classViews';
import { CrowdView } from '../../src/render/crowd';
import { riderMount } from '../../src/render/riders';
import { VehicleView } from '../../src/render/vehicleView';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { makeSim, world } from './helpers';

type Part = { mesh: THREE.InstancedMesh };
const parts = (cv: CrowdView) => (cv as unknown as { parts: Record<string, Part> }).parts;
function matrices(p: Part): THREE.Matrix4[] {
  return Array.from({ length: p.mesh.count }, (_, i) => {
    const m = new THREE.Matrix4();
    p.mesh.getMatrixAt(i, m);
    return m;
  });
}

function riddenBike(kind: VehicleKind, riders = 1): { sim: Sim; v: Vehicle; people: Character[] } {
  const sim = makeSim({ world: world() });
  const b = sim.world.layout.bounds;
  const v = sim.spawnVehicle(kind, b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0.4);
  const people: Character[] = [];
  for (let i = 0; i < riders; i++) {
    const c = sim.spawnCharacter('civilian', v.pos.x, v.pos.z);
    sim.seat(c, v, i);
    people.push(c);
  }
  return { sim, v, people };
}

describe('BikeView', () => {
  it.each(bikeKinds())('the %s model fits its spec, and the pool hands bikes a BikeView and cars a VehicleView', (kind) => {
    const view = new BikeView(kind);
    view.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(view.group, true);
    const s = VEHICLE_SPECS[kind];
    expect(box.max.z - box.min.z).toBeGreaterThan(s.length * 0.85);
    expect(box.max.z - box.min.z).toBeLessThan(s.length + 0.2);
    expect(box.max.x - box.min.x).toBeLessThan(s.width + 0.1);
    expect(box.max.y).toBeGreaterThan(s.height * 0.85);
    expect(box.max.y).toBeLessThan(s.height + 0.15);
    expect(box.min.y).toBeGreaterThan(-0.02);
    const pool = new ClassViewPool();
    const a = pool.acquire(kind);
    expect(a).toBeInstanceOf(BikeView);
    pool.release(a);
    expect(pool.acquire(kind)).toBe(a);
    expect(pool.acquire('sedan')).toBeInstanceOf(VehicleView);
  });

  it('leans the drawn bike with Vehicle.lean (right is positive) and lifts the front in a wheelie, about the rear tyre', () => {
    const { v } = riddenBike('sportbike');
    const view = new BikeView('sportbike');
    view.bind(v);
    const top = () => {
      view.sync(v, 1 / 60, 0, 0);
      const inv = new THREE.Matrix4().makeRotationY(v.heading).invert();
      const body = riderMount(v)!.frame;
      const p = new THREE.Vector3(0, 1, 0).applyMatrix4(body.matrixWorld).sub(new THREE.Vector3(v.pos.x, v.pos.y, v.pos.z)).applyMatrix4(inv);
      const nose = new THREE.Vector3(0, 0, 1).applyMatrix4(body.matrixWorld).sub(new THREE.Vector3(v.pos.x, v.pos.y, v.pos.z)).applyMatrix4(inv);
      return { p, nose };
    };
    const upright = top();
    expect(upright.p.x).toBeCloseTo(0, 6);
    v.lean = 0.5;
    // Local +x is the bike's left: leaning right takes the top towards -x.
    expect(top().p.x).toBeLessThan(-0.4);
    v.lean = -0.5;
    expect(top().p.x).toBeGreaterThan(0.4);
    v.lean = 0;
    v.wheelie = 0.3;
    const w = top();
    expect(w.nose.y).toBeGreaterThan(upright.nose.y + 0.4);
  });

  it.each(bikeKinds())('a rider and a pillion on the %s are drawn on it, hands on the bars, feet on the pegs, and lean with it', (kind) => {
    const { v, people } = riddenBike(kind, 2);
    const view = new BikeView(kind);
    view.bind(v);
    view.sync(v, 1 / 60, 0, 0);
    const cv = new CrowdView();
    cv.sync(people, v.pos.x + 6, v.pos.z, 1 / 60);
    const p = parts(cv);
    expect(p.torso!.mesh.count).toBe(2);
    expect(p.head!.mesh.count).toBe(2);
    expect(p.shin!.mesh.count).toBe(4);
    expect(p.shoe!.mesh.count).toBe(4);
    // Heads over the bike and above its seat, in its frame.
    const frame = riderMount(v)!.frame;
    const inv = frame.matrixWorld.clone().invert();
    const heads = matrices(p.head!).map((m) => new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(inv));
    for (const h of heads) {
      expect(Math.abs(h.x)).toBeLessThan(0.15);
      expect(h.y).toBeGreaterThan(1.3);
      expect(h.y).toBeLessThan(2.1);
      expect(Math.abs(h.z)).toBeLessThan(VEHICLE_SPECS[kind].length / 2);
    }
    // The soles near the pegs (within 6 cm), in the bike's frame.
    const shoes = matrices(p.shoe!).map((m) => new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(inv));
    const pegs = riderMount(v)!.seats.slice(0, 2).flatMap((s) => s.feet);
    for (const q of pegs) expect(Math.min(...shoes.map((s) => Math.hypot(s.x - q.x, s.z - q.z)))).toBeLessThan(0.06);
    // Leaning, the riders go with the bike: the same place in its frame.
    v.lean = 0.6;
    view.sync(v, 1 / 60, 0, 0);
    cv.sync(people, v.pos.x + 6, v.pos.z, 1 / 60);
    const inv2 = frame.matrixWorld.clone().invert();
    const heads2 = matrices(p.head!).map((m) => new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(inv2));
    for (let i = 0; i < heads.length; i++) expect(heads2[i]!.distanceTo(heads[i]!)).toBeLessThan(1e-3);
  });

  it('a released view no longer carries riders, and a lit bike shows head and tail glows at night', () => {
    const { v } = riddenBike('scooter');
    const view = new BikeView('scooter');
    view.bind(v);
    view.sync(v, 1 / 60, 0, 1);
    expect(view.lightsOn).toBe(true);
    const glows = view.lampWorldPositions([]);
    expect(glows).toBe(2);
    view.release();
    expect(riderMount(v)).toBeNull();
  });
});
