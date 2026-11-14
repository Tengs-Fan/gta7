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

  it('the refined paint shades as the model\'s own faces do: its normals are the coarse ones carried onto the pieces', () => {
    // A refined corner's normal is the coarse face's corner normals interpolated at it (within 2 degrees): normals
    // recomputed on the refined mesh were flat over each original face and bent only along its edges (wavy blotches).
    const rows: string[] = [];
    const tri = new THREE.Triangle();
    const bary = new THREE.Vector3();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const closest = new THREE.Vector3();
    for (const kind of MODEL_KINDS) {
      const m = carModel(kind)!;
      // The far paint is the coarse paint (white vertex colour) followed by the cabin's lining.
      const cp = m.farPaint.getAttribute('position');
      const cn = m.farPaint.getAttribute('normal');
      const cc = m.farPaint.getAttribute('color');
      const coarse: number[] = [];
      for (let t = 0; t < cp.count / 3; t++) if (cc.getX(t * 3) === 1) coarse.push(t);
      const fp = m.paint.getAttribute('position');
      const fn = m.paint.getAttribute('normal');
      let worst = 0;
      let checked = 0;
      for (let i = 0; i < fp.count; i += 7) {
        p.fromBufferAttribute(fp, i);
        n.fromBufferAttribute(fn, i);
        // The coarse face the corner lies on whose interpolated normal is nearest its own (a corner on an edge lies on both).
        let best = Infinity;
        for (const t of coarse) {
          tri.set(new THREE.Vector3().fromBufferAttribute(cp, t * 3), new THREE.Vector3().fromBufferAttribute(cp, t * 3 + 1), new THREE.Vector3().fromBufferAttribute(cp, t * 3 + 2));
          tri.closestPointToPoint(p, closest);
          if (closest.distanceToSquared(p) > 1e-8) continue;
          tri.getBarycoord(p, bary);
          const want = new THREE.Vector3();
          for (let k = 0; k < 3; k++) want.addScaledVector(new THREE.Vector3().fromBufferAttribute(cn, t * 3 + k), [bary.x, bary.y, bary.z][k]!);
          best = Math.min(best, want.normalize().angleTo(n));
        }
        expect(best, `${kind} corner ${i} lies on a coarse face`).toBeLessThan(Infinity);
        worst = Math.max(worst, best);
        checked++;
      }
      rows.push(`${kind}: ${checked} refined corners, worst ${THREE.MathUtils.radToDeg(worst).toFixed(2)} deg off the coarse shading`);
      expect(THREE.MathUtils.radToDeg(worst), kind).toBeLessThan(2);
    }
    console.log(rows.join('\n'));
  });

  /** The kit's own vertices in a model's near fittings: those that follow the body's dents (the trim's do not). */
  const kitVertices = (g: THREE.BufferGeometry): number[] => {
    const w = (g.userData.follow as { weights: Float32Array }).weights;
    const out: number[] = [];
    for (let i = 0; i < g.getAttribute('position').count; i++) if (w[i * 3]! + w[i * 3 + 1]! + w[i * 3 + 2]! > 0) out.push(i);
    return out;
  };
  const steps = (a: number, b: number, n: number): number[] => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  /**
   * Where each kit piece is looked for, as rays straight at it: the sill from the side between the wheels, the tail
   * panel from behind either side of the middle, the grille from ahead between the head lamps.
   */
  const pieceRays = (kind: VehicleKind): Record<'sill' | 'panel' | 'grille', Array<[THREE.Vector3, THREE.Vector3]>> => {
    const s = VEHICLE_SPECS[kind];
    const m = carModel(kind)!;
    const half = s.length / 2;
    const tailY = m.tail.reduce((y, l) => y + l.at.y, 0) / m.tail.length;
    const headY = m.head.reduce((y, l) => y + l.at.y, 0) / m.head.length;
    const grid = (f: (a: number, b: number) => THREE.Vector3, as: number[], bs: number[], d: THREE.Vector3): Array<[THREE.Vector3, THREE.Vector3]> => as.flatMap((a) => bs.map((b) => [f(a, b), d] as [THREE.Vector3, THREE.Vector3]));
    return {
      sill: grid((z, y) => new THREE.Vector3(s.width, m.bottom + y, z), steps(-0.4, 0.4, 8), [0.045, 0.065, 0.085], new THREE.Vector3(-1, 0, 0)),
      panel: grid((x, y) => new THREE.Vector3(x, tailY + y, -half - 2), [-0.3, -0.25, -0.2, 0.2, 0.25, 0.3], [-0.01, 0.01], new THREE.Vector3(0, 0, 1)),
      grille: grid((x, y) => new THREE.Vector3(x, headY + y, half + 2), steps(-0.2, 0.2, 8), [-0.06, -0.03, 0], new THREE.Vector3(0, 0, -1)),
    };
  };
  /** The share of `rays` that meet the fittings first among `parts`. */
  const coverage = (parts: THREE.Object3D[], rays: Array<[THREE.Vector3, THREE.Vector3]>, fittings: THREE.Object3D): number =>
    rays.filter(([o, d]) => new THREE.Raycaster(o, d).intersectObjects(parts, false)[0]?.object === fittings).length / rays.length;

  it('every model body wears the fittings kit, near and far: a handle per door, and its sill, tail panel and grille where its paint runs', () => {
    // Doors per kind (the sports car is a coupé), and the pieces each model's paint leaves room for (the compact's foot
    // and the pickup's tail are its own trim).
    const doors: Readonly<Record<string, number>> = { compact: 4, sedan: 4, taxi: 4, police: 4, muscle: 4, sports: 2, pickup: 2 };
    const pieces: Readonly<Record<string, ReadonlyArray<'sill' | 'panel' | 'grille'>>> = { compact: ['panel', 'grille'], sedan: ['sill', 'panel', 'grille'], taxi: ['sill', 'panel', 'grille'], police: ['sill', 'panel', 'grille'], muscle: ['sill', 'panel', 'grille'], sports: ['sill', 'panel', 'grille'], pickup: ['sill', 'grille'] };
    const rows: string[] = [];
    for (const kind of MODEL_KINDS) {
      const s = VEHICLE_SPECS[kind];
      const m = carModel(kind)!;
      const v = view(kind);
      const ext = mesh(v, 'exterior');
      const pos = ext.geometry.getAttribute('position');
      const uv = ext.geometry.getAttribute('uv');
      // The handles: the kit's satin (the atlas's metal cell) just under the side windows, in clusters along each flank,
      // one a door, each over the side windows' length.
      for (const side of [1, -1]) {
        const zs = kitVertices(ext.geometry).filter((i) => uv.getX(i) > 0.5 && uv.getY(i) < 0.5 && pos.getX(i) * side > s.width / 2 - 0.25 && Math.abs(pos.getY(i) - (m.beltY - 0.09)) < 0.03).map((i) => pos.getZ(i)).sort((a, b) => a - b);
        const handles: number[][] = [];
        for (const z of zs) {
          const last = handles[handles.length - 1];
          if (last && z - last[last.length - 1]! < 0.3) last.push(z);
          else handles.push([z]);
        }
        expect(handles.length, `${kind} handles on the ${side > 0 ? 'left' : 'right'}`).toBe(doors[kind]! / 2);
        for (const h of handles) {
          expect(h[h.length - 1]! - h[0]!, `${kind} handle length`).toBeLessThan(0.3);
          expect(h[0], `${kind} handle under the side windows`).toBeGreaterThan(m.cabin[3]![0] - 0.05);
          expect(h[h.length - 1], `${kind} handle under the side windows`).toBeLessThan(m.cabin[0]![0]);
        }
      }
      // Sills, tail panel and grille, near and far (the far ones against the far paint).
      const far = [new THREE.Mesh(m.farPaint), new THREE.Mesh(m.farTrim)];
      const rays = pieceRays(kind);
      const row: string[] = [];
      for (const piece of pieces[kind]!) {
        const near = coverage([mesh(v, 'body'), ext], rays[piece], ext);
        const away = coverage(far, rays[piece], far[1]!);
        row.push(`${piece} ${near.toFixed(2)} near, ${away.toFixed(2)} far`);
        expect(near, `${kind} ${piece} near`).toBeGreaterThanOrEqual(0.6);
        expect(away, `${kind} ${piece} far`).toBeGreaterThanOrEqual(0.6);
      }
      rows.push(`${kind}: ${row.join('; ')}`);
    }
    console.log(rows.join('\n'));
  });

  it('the kit follows the body\'s own dented surface: its sill, tail panel and grille stay in front of the paint in dents of 8, 15 and 40 cm', () => {
    const rows: string[] = [];
    const fails: Array<[string, number, number]> = [];
    for (const kind of ['sedan', 'sports', 'police'] as const) {
      const s = VEHICLE_SPECS[kind];
      const m = carModel(kind)!;
      const half = s.length / 2;
      const intact = view(kind);
      const rays = pieceRays(kind);
      const ext0 = mesh(intact, 'exterior');
      const tailY = m.tail.reduce((y, l) => y + l.at.y, 0) / m.tail.length;
      const headY = m.head.reduce((y, l) => y + l.at.y, 0) / m.head.length;
      const at: Record<'sill' | 'panel' | 'grille', { lx: number; ly: number; lz: number; nx: number; nz: number }> = {
        sill: { lx: s.width / 2 - 0.05, ly: m.bottom + 0.25, lz: 0, nx: -1, nz: 0 },
        panel: { lx: 0, ly: tailY, lz: -half + 0.05, nx: 0, nz: 1 },
        grille: { lx: 0, ly: headY, lz: half - 0.05, nx: 0, nz: -1 },
      };
      for (const piece of ['sill', 'panel', 'grille'] as const) {
        const whole = coverage([mesh(intact, 'body'), ext0], rays[piece], ext0);
        for (const depth of [0.08, 0.15, 0.4]) {
          const v = view(kind);
          const car = new Vehicle(1, kind, 0, 0, 0, 0, 0xb03a2e);
          v.bind(car);
          v.sync(car, 1 / 60, 0, 0);
          car.dents.push({ ...at[piece], depth });
          car.dentVersion++;
          v.sync(car, 1 / 60, 0, 0);
          v.group.updateMatrixWorld(true);
          const ext = mesh(v, 'exterior');
          const dented = coverage([mesh(v, 'body'), ext], rays[piece], ext);
          rows.push(`${kind} ${piece} ${depth}: ${dented.toFixed(2)} of the rays (${whole.toFixed(2)} undented)`);
          fails.push([`${kind} ${piece} dented ${depth}`, dented, whole]);
        }
      }
    }
    console.log(rows.join('\n'));
    // (The sports car's nose comes to a crease down its middle, which a deep dent sharpens through a few of the
    // grille's 5 cm cells: 0.93 of them at 15 cm, 0.85 at 40.)
    for (const [label, dented, whole] of fails) expect(dented, label).toBeGreaterThanOrEqual(whole - (label.startsWith('sports grille') ? 0.16 : 0.05));
  });

  it('a dent shades as smoothly as the paint round it: its normals turn a few degrees and meet the untouched ones at its edge', () => {
    const angle = (g: THREE.BufferGeometry, h: THREE.BufferGeometry, i: number): number => new THREE.Vector3().fromBufferAttribute(g.getAttribute('normal'), i).angleTo(new THREE.Vector3().fromBufferAttribute(h.getAttribute('normal'), i));
    for (const kind of ['sedan', 'van'] as const) {
      const s = VEHICLE_SPECS[kind];
      for (const depth of [0.03, 0.15]) {
        const v = view(kind);
        const car = new Vehicle(1, kind, 0, 0, 0, 0, 0xb03a2e);
        v.bind(car);
        v.sync(car, 1 / 60, 0, 0);
        const before = mesh(v, 'body').geometry;
        const dent = { lx: s.width / 2, ly: s.height * 0.4, lz: 0.2, nx: -1, nz: 0, depth };
        car.dents.push(dent);
        car.dentVersion++;
        v.sync(car, 1 / 60, 0, 0);
        const after = mesh(v, 'body').geometry;
        const p = before.getAttribute('position');
        const r = 0.6 + depth;
        let worst = 0;
        let edge = 0;
        for (let i = 0; i < p.count; i++) {
          const d = Math.hypot(p.getX(i) - dent.lx, p.getY(i) - dent.ly, p.getZ(i) - dent.lz);
          if (d >= r) continue;
          const a = THREE.MathUtils.radToDeg(angle(before, after, i));
          worst = Math.max(worst, a);
          if (d > 0.95 * r) edge = Math.max(edge, a);
        }
        // A 3 cm dent turns the paint by a few degrees; any dent's last 5 % blends into the untouched paint.
        if (depth === 0.03) expect(worst, `${kind} 3 cm dent`).toBeLessThan(6);
        expect(edge, `${kind} ${depth} m dent's edge`).toBeLessThan(2);
        // Corners that shared a smooth normal still share it (no hard facet edges inside the dent): the angle between
        // them grows by under half a degree.
        const shared = new Map<string, number[]>();
        for (let i = 0; i < p.count; i++) {
          const k = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
          const list = shared.get(k);
          if (list) list.push(i);
          else shared.set(k, [i]);
        }
        let split = 0;
        const n = (g: THREE.BufferGeometry, i: number): THREE.Vector3 => new THREE.Vector3().fromBufferAttribute(g.getAttribute('normal'), i);
        for (const list of shared.values()) {
          for (let k = 1; k < list.length; k++) {
            if (n(before, list[0]!).angleTo(n(before, list[k]!)) > 0.02) continue;
            const a = THREE.MathUtils.radToDeg(n(after, list[0]!).angleTo(n(after, list[k]!)) - n(before, list[0]!).angleTo(n(before, list[k]!)));
            split = Math.max(split, a);
          }
        }
        expect(split, `${kind} ${depth} m dent splits no smooth corner`).toBeLessThan(0.5);
      }
    }
  });

  it('the tail panel keeps clear of a model\'s own-made reverse lamp', () => {
    for (const kind of MODEL_KINDS) {
      const m = carModel(kind)!;
      const rv = m.reverse;
      const ext = mesh(view(kind), 'exterior').geometry;
      const pos = ext.getAttribute('position');
      // No kit vertex over the lens and further out than its face (4 mm off the model).
      for (const i of kitVertices(ext)) {
        if (Math.abs(pos.getX(i) - rv.at.x) < rv.size[0] / 2 && Math.abs(pos.getY(i) - rv.at.y) < rv.size[1] / 2 && pos.getZ(i) < 0) {
          expect(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(rv.at).dot(rv.normal), `${kind} kit over the reverse lamp`).toBeLessThan(0.004);
        }
      }
    }
  });

  it('a made-up reverse lamp (the sedan and taxi have no white rear lamp) stands off the tail, not inside it', () => {
    for (const kind of ['sedan', 'taxi'] as const) {
      const s = VEHICLE_SPECS[kind];
      const rv = carModel(kind)!.reverse;
      const v = view(kind);
      const hit = new THREE.Raycaster(new THREE.Vector3(rv.at.x, rv.at.y, -s.length), new THREE.Vector3(0, 0, 1)).intersectObjects([mesh(v, 'body'), mesh(v, 'exterior')], false)[0]!;
      expect(rv.at.z, kind).toBeLessThan(hit.point.z);
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

  it('number plates on both ends of every model body (near and far), in its fittings draw, seen from outside', () => {
    const rows: string[] = [];
    const ray = new THREE.Raycaster();
    for (const kind of MODEL_KINDS) {
      const s = VEHICLE_SPECS[kind];
      const m = carModel(kind)!;
      const v = view(kind);
      const parts = [mesh(v, 'body'), mesh(v, 'exterior')];
      for (const [name, g] of [['near', m.trim], ['far', m.farTrim]] as const) {
        const pos = g.getAttribute('position');
        const uv = g.getAttribute('uv');
        const nor = g.getAttribute('normal');
        const ends = [new THREE.Box3(), new THREE.Box3()];
        for (let i = 0; i < pos.count; i++) {
          // The fittings atlas's plate cell.
          if (uv.getY(i) < 0.5) continue;
          const p = new THREE.Vector3().fromBufferAttribute(pos, i);
          ends[p.z > 0 ? 0 : 1]!.expandByPoint(p);
          expect(nor.getZ(i) * Math.sign(p.z), `${kind} ${name}: the plate faces out of its end`).toBeGreaterThan(0.75);
        }
        ends.forEach((b, e) => {
          const label = `${kind} ${name} ${e ? 'rear' : 'front'} plate`;
          expect(b.isEmpty(), label).toBe(false);
          const w = b.max.x - b.min.x;
          // About the procedural plate's 0.40 m, centred across, within the end's last 30 cm and at most 4 cm proud of it.
          expect(w, label).toBeGreaterThanOrEqual(0.3);
          expect(w, label).toBeLessThanOrEqual(0.45);
          expect(Math.abs(b.min.x + b.max.x) / 2, label).toBeLessThan(0.02);
          const proud = e ? -s.length / 2 - b.min.z : b.max.z - s.length / 2;
          const depth = e ? b.max.z + s.length / 2 : s.length / 2 - b.min.z;
          expect(proud, label).toBeLessThanOrEqual(0.04);
          expect(depth, label).toBeLessThanOrEqual(0.3);
          if (name === 'near') {
            rows.push(`${label}: ${w.toFixed(2)} x ${(b.max.y - b.min.y).toFixed(2)} m at y ${((b.min.y + b.max.y) / 2).toFixed(2)}, ${(-proud).toFixed(3)} m inside the end`);
            // Seen straight on from outside, its middle and corners are the plate, not the body in front of it.
            for (const [fx, fy] of [[0, 0], [-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]] as const) {
              const x = (fx * w) / 2;
              const y = (b.min.y + b.max.y) / 2 + (fy * (b.max.y - b.min.y)) / 2;
              const sign = e ? -1 : 1;
              ray.set(new THREE.Vector3(x, y, sign * (s.length / 2 + 2)), new THREE.Vector3(0, 0, -sign));
              const hit = ray.intersectObjects(parts, false)[0];
              expect(hit?.object.name, `${label} seen at ${fx}, ${fy}`).toBe('exterior');
              expect(hit!.uv!.y, `${label} seen at ${fx}, ${fy}`).toBeGreaterThan(0.5);
            }
          }
        });
      }
    }
    console.log(`model number plates:\n${rows.join('\n')}`);
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
