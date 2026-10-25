// Mission 3 cars, the imported bodies (vehicleModels): the Quaternius models loaded from disk, fitted to VEHICLE_SPECS
// and drawn by VehicleView with its own materials. VAL-CAR-001, 002, 003, 004, 007 and 009 on the model bodies.

import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
    return new Proxy(store, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => ((o[k] = v), true) });
  };
  const canvas = (): Record<string, unknown> => ({ width: 300, height: 150, clientWidth: 1280, clientHeight: 720, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx2d() : null), addEventListener: () => {}, removeEventListener: () => {} });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

import { loadAssetsFromDisk, unloadAssets } from '../../src/render/assets/testing';
import { PART_LAYER, SHADOW_LAYER, VehiclePartBatches } from '../../src/render/vehicleBatches';
import { carModel, modelIdFor } from '../../src/render/vehicleModels';
import { AXLE, cabinCeiling, cabinLayout, riderSeat, VehicleView } from '../../src/render/vehicleView';
import { Vehicle } from '../../src/sim/entities';
import { SKELETON } from '../../src/sim/pose';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';

const KINDS = (Object.keys(VEHICLE_SPECS) as VehicleKind[]).filter((k) => VEHICLE_SPECS[k].class === 'car');
const MODEL_KINDS = KINDS.filter((k) => modelIdFor(k) !== null);

beforeAll(async () => {
  await loadAssetsFromDisk({ filter: (e) => e.kind === 'vehicle' });
});
afterAll(() => unloadAssets());

const mesh = (v: VehicleView, name: string): THREE.Mesh => v.group.getObjectByName(name) as THREE.Mesh;
const box = (g: THREE.BufferGeometry): THREE.Box3 => new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);

function view(kind: VehicleKind): VehicleView {
  const v = new VehicleView(kind);
  v.group.updateMatrixWorld(true);
  return v;
}

describe('imported car bodies', () => {
  it('every kind with a model draws it (compact, sedan, taxi, sports, muscle, pickup, police)', () => {
    expect(MODEL_KINDS.sort()).toEqual(['compact', 'muscle', 'pickup', 'police', 'sedan', 'sports', 'taxi']);
    const rows: string[] = [];
    for (const kind of MODEL_KINDS) {
      const m = carModel(kind);
      expect(m, kind).not.toBeNull();
      rows.push(`${kind} <- ${m!.id}: scale x ${m!.scale[0].toFixed(3)} y ${m!.scale[1].toFixed(3)} z ${m!.scale[2].toFixed(3)}; tyre r ${m!.wheelR.toFixed(3)}; body ${m!.paint.getAttribute('position').count / 3} tris (far ${m!.farPaint.getAttribute('position').count / 3})`);
      // Not a stretch past about 25 % against the other axes (the model's own proportions kept).
      const [sx, sy, sz] = m!.scale;
      expect(Math.max(sx, sy, sz) / Math.min(sx, sy, sz), kind).toBeLessThanOrEqual(1.25);
      expect(mesh(view(kind), 'body').geometry.getAttribute('position').count, kind).toBeGreaterThan(m!.paint.getAttribute('position').count - 1);
    }
    console.log(rows.join('\n'));
  });

  it('VAL-CAR-002: body and glass within 3 % and 0.08 m of the spec; wheels on the axles and track; the far version within 3 %', () => {
    const rows: string[] = [];
    for (const kind of MODEL_KINDS) {
      const s = VEHICLE_SPECS[kind];
      const v = view(kind);
      // The model's own bumpers and trim are part of its body (drawn as the fittings).
      const b = box(mesh(v, 'body').geometry).union(box(mesh(v, 'glass').geometry)).union(box(mesh(v, 'exterior').geometry));
      const err = { length: b.max.z - b.min.z - s.length, width: b.max.x - b.min.x - s.width, height: b.max.y - s.height };
      rows.push(`${kind}: length ${err.length.toFixed(3)} width ${err.width.toFixed(3)} height ${err.height.toFixed(3)}`);
      for (const [k, e] of Object.entries(err)) {
        const spec = k === 'length' ? s.length : k === 'width' ? s.width : s.height;
        expect(Math.abs(e), `${kind} ${k}`).toBeLessThanOrEqual(Math.min(0.08, 0.03 * spec) + 1e-6);
      }
      const pivots = v.group.children.filter((o) => o instanceof THREE.Group && o.children.some((c) => c.name === 'tire'));
      expect(pivots.length, kind).toBe(4);
      for (const p of pivots) {
        expect(Math.abs(Math.abs(p.position.z) - AXLE * s.length), `${kind} axle`).toBeLessThanOrEqual(0.03);
        expect(Math.abs(Math.abs(p.position.x) - 0.85 * (s.width / 2)), `${kind} track`).toBeLessThanOrEqual(0.05);
        const tire = p.children.find((c) => c.name === 'tire') as THREE.Mesh;
        const r = box(tire.geometry).max.y;
        expect(Math.abs(r - p.position.y), `${kind} rests on its tyre`).toBeLessThan(1e-6);
        const car = new Vehicle(1, kind, 0, 0, 0, 0, 0xffffff);
        car.forwardSpeed = 10;
        v.bind(car);
        v.sync(car, 0.1, 0, 0);
        // The tyre spins by its own radius: the tread moves at the ground speed.
        expect(Math.abs(tire.rotation.x) * r, kind).toBeCloseTo(1, 3);
      }
      const m = carModel(kind)!;
      const far = box(m.farPaint).union(box(m.farGlass)).union(box(m.farTrim)).getSize(new THREE.Vector3());
      const near = b.getSize(new THREE.Vector3());
      for (const axis of ['x', 'y', 'z'] as const) expect(Math.abs(far[axis] - near[axis]) / near[axis], `${kind} far ${axis}`).toBeLessThanOrEqual(0.03);
    }
    console.log(rows.join('\n'));
  });

  it('VAL-CAR-002: seats come from cabinLayout, and seated riders\' heads stay under the model roof and inside its glass', () => {
    const rows: string[] = [];
    for (const kind of MODEL_KINDS) {
      const c = cabinLayout(kind)!;
      expect(c, kind).not.toBeNull();
      const m = carModel(kind)!;
      const v = view(kind);
      const roof = new THREE.Raycaster();
      for (const [rear, z] of [[false, c.frontZ], [true, c.rearZ]] as const) {
        if (z === null) continue;
        for (const height of [0.94, 1.02]) {
          const seat = riderSeat(c, rear, height, false, { y: 0, z: 0, recline: 0 });
          const neckY = seat.y + SKELETON.neckY * height * Math.cos(seat.recline);
          const neckZ = seat.z - SKELETON.neckY * height * Math.sin(seat.recline);
          const headTop = neckY + 0.34 * height * Math.cos(0.2 * seat.recline);
          expect(headTop, `${kind} ${rear ? 'rear' : 'front'} ${height}`).toBeLessThan(cabinCeiling(c, neckZ));
          expect(headTop, kind).toBeLessThan(m.roofY);
          // Straight up from the top of his head: the roof (or glass) of the model, not open sky.
          const x = (VEHICLE_SPECS[kind].width / 2) * 0.45;
          roof.set(new THREE.Vector3(x, headTop, neckZ), new THREE.Vector3(0, 1, 0));
          // (Both faces: the roof is seen from under it.)
          const both = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
          const shell = ['body', 'glass', 'livery'].map((n) => mesh(v, n)).filter((o) => o).map((o) => new THREE.Mesh(o.geometry, both));
          const hits = roof.intersectObjects(shell, false);
          expect(hits.length, `${kind} roof over the head`).toBeGreaterThan(0);
          expect(hits[0]!.distance, kind).toBeLessThan(0.5);
          if (!rear && height === 1.02) rows.push(`${kind}: driver head top ${headTop.toFixed(3)} under the roof at ${(headTop + hits[0]!.distance).toFixed(3)}`);
        }
      }
      // The head is inside the glass across the car: the rider sits within the window line.
      expect(VEHICLE_SPECS[kind].width / 2 * 0.45 + 0.12, kind).toBeLessThan(m.cabinHalf + 0.05);
    }
    console.log(rows.join('\n'));
  });

  it('VAL-CAR-001: the windows are the model\'s own panes, drawn as the tinted glass, and no glass casts a shadow', () => {
    for (const kind of MODEL_KINDS) {
      const v = view(kind);
      const glass = mesh(v, 'glass');
      expect(glass.geometry, kind).toBe(carModel(kind)!.glass);
      expect((glass.material as THREE.Material).name, kind).toBe('vehicle-glass');
      expect(glass.castShadow, kind).toBe(false);
      const casters: string[] = [];
      v.group.traverse((o) => {
        if (o instanceof THREE.Mesh && o.castShadow && (o.layers.test(new THREE.Layers()) || o.layers.isEnabled(SHADOW_LAYER))) casters.push(o.name);
      });
      expect(casters, kind).toEqual(['shadow']);
    }
  });

  it('VAL-CAR-001: no look through a model\'s windows passes out of the cabin through one pane (no open aperture)', () => {
    // From 16 views round the car, rays into its glass: each leaves through a second pane or meets the body (its
    // front faces only, as drawn: the panels' insides are the dark lining, the boot and bonnet closed by bulkheads).
    for (const kind of MODEL_KINDS) {
      const v = view(kind);
      const glass = mesh(v, 'glass');
      const front = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
      const both = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      const G = new THREE.Mesh(glass.geometry, both);
      const solid = ['body', 'exterior', 'livery'].map((n) => mesh(v, n)).filter((o) => o).map((o) => new THREE.Mesh(o.geometry, front));
      glass.geometry.computeBoundingBox();
      const c = glass.geometry.boundingBox!.getCenter(new THREE.Vector3());
      let rays = 0;
      let leaks = 0;
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const cam = new THREE.Vector3(Math.sin(ang) * 5, 1.6, Math.cos(ang) * 5);
        for (let dx = -0.6; dx <= 0.6001; dx += 0.1) {
          for (let dy = -0.2; dy <= 0.2001; dy += 0.1) {
            const dir = c.clone().add(new THREE.Vector3(dx * Math.cos(ang), dy, -dx * Math.sin(ang))).sub(cam).normalize();
            const hits = new THREE.Raycaster(cam, dir, 0, 20).intersectObjects([G, ...solid], false);
            const firstSolid = hits.findIndex((h) => h.object !== G);
            const panes = (firstSolid < 0 ? hits : hits.slice(0, firstSolid)).length;
            if (panes === 0) continue;
            rays++;
            if (firstSolid < 0 && panes < 2) leaks++;
          }
        }
      }
      expect(rays, kind).toBeGreaterThan(400);
      expect(leaks, kind).toBe(0);
    }
  });

  it('no drawn model part has a zero-length normal (one NaN pixel blackens the frame through bloom)', () => {
    for (const kind of MODEL_KINDS) {
      const v = view(kind);
      const m = carModel(kind)!;
      const parts: Array<[string, THREE.BufferGeometry]> = [['body', mesh(v, 'body').geometry], ['glass', mesh(v, 'glass').geometry], ['exterior', mesh(v, 'exterior').geometry], ['far paint', m.farPaint], ['far glass', m.farGlass], ['far trim', m.farTrim]];
      if (m.livery) parts.push(['livery', m.livery]);
      for (const [name, g] of parts) {
        const n = g.getAttribute('normal');
        let bad = 0;
        for (let i = 0; i < n.count; i++) if (!(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) > 0.5)) bad++;
        expect(bad, `${kind} ${name}`).toBe(0);
      }
    }
  });

  it('a camera inside a model body draws it without its dark lining (pressed against a wall), outside with it', () => {
    for (const kind of MODEL_KINDS) {
      const v = view(kind);
      const body = mesh(v, 'body');
      const g = body.geometry;
      const start = g.userData.linerStart as number;
      expect(start, kind).toBeGreaterThan(0);
      expect(start, kind).toBeLessThan(g.getAttribute('position').count);
      const cam = new THREE.PerspectiveCamera();
      const r = undefined as unknown as THREE.WebGLRenderer;
      const scene = new THREE.Scene();
      for (const [at, inside] of [[new THREE.Vector3(0, 1, 0), true], [new THREE.Vector3(6, 2, 6), false]] as const) {
        cam.position.copy(at);
        cam.updateMatrixWorld(true);
        body.onBeforeRender(r, scene, cam, g, body.material as THREE.Material, null as unknown as THREE.Group);
        expect(g.drawRange.count, `${kind} ${inside ? 'inside' : 'outside'}`).toBe(inside ? start : Infinity);
        body.onAfterRender(r, scene, cam, g, body.material as THREE.Material, null as unknown as THREE.Group);
        expect(g.drawRange.count, kind).toBe(Infinity);
      }
    }
  });

  it('VAL-CAR-004: a front-corner impact dents the model body by 5 cm or more, nothing a metre away, and its shadow follows', () => {
    const rows: string[] = [];
    for (const kind of MODEL_KINDS) {
      const s = VEHICLE_SPECS[kind];
      const v = view(kind);
      const car = new Vehicle(1, kind, 0, 0, 0, 0, 0xb03a2e);
      v.bind(car);
      v.sync(car, 1 / 60, 0, 0);
      const src = mesh(v, 'body').geometry.getAttribute('position');
      const shadowSrc = mesh(v, 'shadow').geometry.getAttribute('position');
      // The front corner at bumper height (the model's own nose there).
      const hit = new THREE.Vector3(s.width / 2 - 0.1, s.height * 0.35, s.length / 2 - 0.05);
      car.dents.push({ lx: hit.x, ly: hit.y, lz: hit.z, nx: -0.6, nz: -0.8, depth: 0.2 });
      car.dentVersion++;
      v.sync(car, 1 / 60, 0, 0);
      const moved = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, b: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): { near: number; far: number } => {
        let near = 0;
        let far = 0;
        const p = new THREE.Vector3();
        const q = new THREE.Vector3();
        for (let i = 0; i < a.count; i++) {
          p.fromBufferAttribute(a, i);
          q.fromBufferAttribute(b, i);
          const d = p.distanceTo(q);
          const r = p.distanceTo(hit);
          if (r < 0.3) near = Math.max(near, d);
          if (r > 1) far = Math.max(far, d);
        }
        return { near, far };
      };
      const body = moved(src, mesh(v, 'body').geometry.getAttribute('position'));
      const shadow = moved(shadowSrc, mesh(v, 'shadow').geometry.getAttribute('position'));
      rows.push(`${kind}: body near ${body.near.toFixed(3)} far ${body.far.toFixed(4)}; shadow near ${shadow.near.toFixed(3)} far ${shadow.far.toFixed(4)}`);
      expect(body.near, `${kind} near`).toBeGreaterThanOrEqual(0.05);
      expect(body.far, `${kind} far`).toBeLessThanOrEqual(0.01);
      expect(Math.abs(shadow.near - body.near), `${kind} shadow`).toBeLessThanOrEqual(0.05);
      expect(shadow.far, `${kind} shadow far`).toBeLessThanOrEqual(0.01);
    }
    console.log(rows.join('\n'));
  });

  it('VAL-CAR-005/007: lenses on the model\'s lamps, batched; the car draws body, glass and fittings (police: and its livery)', () => {
    const batches = new VehiclePartBatches();
    for (const kind of MODEL_KINDS) {
      const s = VEHICLE_SPECS[kind];
      const v = view(kind);
      const lamps = v.group.children.filter((o) => o.name === 'lamp');
      expect(lamps.length, kind).toBe(5);
      for (const l of lamps) {
        expect(l.layers.isEnabled(PART_LAYER), kind).toBe(true);
        // At an end of the car, facing out of it.
        expect(Math.abs(l.position.z), `${kind} lamp at an end`).toBeGreaterThan(s.length * 0.3);
        const out = new THREE.Vector3(0, 0, 1).applyQuaternion(l.quaternion);
        expect(Math.sign(out.z), kind).toBe(Math.sign(l.position.z));
      }
      let own = 0;
      v.group.traverse((o) => {
        if (o instanceof THREE.Mesh && o.layers.test(new THREE.Layers())) own++;
      });
      expect(own, kind).toBe(kind === 'police' ? 4 : 3);
      // The far version: its parts in the shared buckets.
      const car = new Vehicle(1, kind, 0, 0, 0, 0, 0x2e86c1);
      v.bind(car);
      v.sync(car, 1 / 60, 0, 0);
      v.setDistant(true);
      batches.begin();
      v.drawParts(batches);
      batches.end();
      expect(batches.instancesOf(carModel(kind)!.farGlass), kind).toBe(1);
      expect(batches.instancesOf(carModel(kind)!.farPaint), kind).toBe(1);
    }
    batches.dispose();
  });
});
