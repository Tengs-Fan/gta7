// The set pieces' models (render only): the Ferris wheel's cabins, rim and A-frames, the docks' containers and
// cranes, the Azura Bowl, the bridges' balustrades and AzuraLink's train and pylon heads. Every normal is unit length
// and finite (a normal of no length shades as NaN, which the bloom spreads over the frame), and each model keeps to
// where the world's colliders are: the containers inside their boxes, the cranes' lower parts on their legs, the
// stadium's podium on its box with the bowl on its top, the balustrades on the parapets.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { BALUSTRADE, bridgeParapet } from '../../src/render/city/coast';
import { GeoBuilder } from '../../src/render/geo';
import { MonorailView } from '../../src/render/monorail';
import { CONTAINER, containerGeometry, ferrisLegsGeometry, ferrisWheelGeometry, gondolaGeometry } from '../../src/render/setPieceModels';
import { CURB_H } from '../../src/world/constants';
import { PARAPET_H } from '../../src/world/layout';
import { CAR_HEIGHT, CAR_WIDTH } from '../../src/world/monorail';
import { world } from './helpers';

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

/** The normals of `geo` that are not unit length or not finite, as "index: x,y,z". */
function badNormals(geo: THREE.BufferGeometry): string[] {
  const n = geo.getAttribute('normal');
  const bad: string[] = [];
  for (let i = 0; i < n.count; i++) {
    const v = new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i));
    if (!Number.isFinite(v.x + v.y + v.z) || Math.abs(v.length() - 1) > 1e-3) bad.push(`${i}: ${v.toArray().map((a) => a.toFixed(3))}`);
  }
  return bad.slice(0, 5);
}

function points(geo: THREE.BufferGeometry, m?: THREE.Matrix4): THREE.Vector3[] {
  const p = geo.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
    return m ? v.applyMatrix4(m) : v;
  });
}

function meshes(root: THREE.Object3D, name: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && o.name === name) out.push(o);
  });
  return out;
}

describe('the Ferris wheel and the containers', () => {
  it('have unit normals', () => {
    for (const [name, g] of [['gondola', gondolaGeometry()], ['wheel', ferrisWheelGeometry(22, 3.5)], ['legs', ferrisLegsGeometry(20, 8.5, 28.5, 3.2)], ['container', containerGeometry()]] as const) expect(badNormals(g), name).toEqual([]);
  });

  it('a cabin keeps to the old box: 2.2 m across, its floor 2.6 m under the pivot', () => {
    const b = new THREE.Box3().setFromPoints(points(gondolaGeometry()));
    expect(b.min.y).toBeGreaterThanOrEqual(-2.6 - 1e-6);
    expect(b.max.y).toBeLessThan(0.2);
    expect(Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z)).toBeLessThanOrEqual(1.2);
  });

  it('the wheel, as it turns, never passes through a cabin hanging from it', () => {
    // The wheel's frame as PropsView turns it (about z); a cabin hangs straight down from its pivot, its box 2.2 m
    // across and deep, from 0.58 to 2.6 m under the pivot (shrunk 2 cm: the yoke meets the pivot's cross tube).
    const R = 22;
    const wheel = ferrisWheelGeometry(R, 3.5).toNonIndexed();
    const tri = new THREE.Triangle();
    const hits: string[] = [];
    for (let step = 0; step < 6; step++) {
      const ang = (step / 6) * ((Math.PI * 2) / 16);
      const g = wheel.clone().rotateZ(ang);
      const p = g.getAttribute('position');
      for (let i = 0; i < 16; i++) {
        const a = ang + (i / 16) * Math.PI * 2;
        const cx = Math.cos(a) * R;
        const cy = Math.sin(a) * R;
        const box = new THREE.Box3(new THREE.Vector3(cx - 1.08, cy - 2.58, -1.08), new THREE.Vector3(cx + 1.08, cy - 0.6, 1.08));
        for (let k = 0; k < p.count; k += 3) {
          tri.set(new THREE.Vector3().fromBufferAttribute(p, k), new THREE.Vector3().fromBufferAttribute(p, k + 1), new THREE.Vector3().fromBufferAttribute(p, k + 2));
          if (box.intersectsTriangle(tri)) {
            hits.push(`turn ${step}, cabin ${i}`);
            break;
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("a container fills its collider's box and no more", () => {
    const b = new THREE.Box3().setFromPoints(points(containerGeometry()));
    expect(b.min.toArray().map((v) => +v.toFixed(3))).toEqual([-CONTAINER.wid / 2, 0, -CONTAINER.len / 2]);
    expect(b.max.toArray().map((v) => +v.toFixed(3))).toEqual([CONTAINER.wid / 2, CONTAINER.h, CONTAINER.len / 2]);
  });
});

describe("the bridges' balustrades", () => {
  it("stand on their parapets' colliders, no higher, with unit normals", () => {
    const r = { minX: -191, minZ: 10, maxX: -159, maxZ: 10 + 0.35 };
    const g = new GeoBuilder(true);
    bridgeParapet(g, r, CURB_H);
    const geo = g.build();
    expect(badNormals(geo)).toEqual([]);
    const out = points(geo).filter((p) => p.x < r.minX - 0.06 || p.x > r.maxX + 0.06 || p.z < r.minZ - 0.06 || p.z > r.maxZ + 0.06 || p.y < CURB_H - 1e-6 || p.y > CURB_H + PARAPET_H + 1e-6);
    expect(out).toEqual([]);
    // Piers at both ends and at most BALUSTRADE.pierGap apart: their caps are the only faces at the collider's top.
    const caps = new Set(points(geo).filter((p) => Math.abs(p.y - (CURB_H + PARAPET_H)) < 1e-6).map((p) => Math.round(p.x * 10)));
    expect(caps.size).toBeGreaterThanOrEqual(2 * (Math.ceil(32 / BALUSTRADE.pierGap) + 1));
  });
});

describe("the city's set pieces", () => {
  let city: CityView;
  beforeAll(() => {
    city = new CityView(world());
    city.group.updateMatrixWorld(true);
  });

  it('the cranes, the stadium and the bridges draw with unit normals', () => {
    for (const name of ['setpieces', 'bridges']) {
      const list = meshes(city.group, name);
      expect(list.length, name).toBeGreaterThan(0);
      for (const m of list) expect(badNormals(m.geometry), name).toEqual([]);
    }
  });

  it('near the ground a crane is only its legs, where their colliders stand; it reaches out over the basin and up past 45 m', () => {
    const W = world();
    const all = meshes(city.group, 'setpieces').flatMap((m) => points(m.geometry, m.matrixWorld));
    for (const c of W.layout.props.filter((p) => p.kind === 'crane')) {
      const mine = all.filter((p) => Math.abs(p.x - c.x) < 20 && p.z > c.z - 25 && p.z < c.z + 45);
      const low = mine.filter((p) => p.y < c.y + 11);
      const off = low.filter((p) => ![[-6, -5], [6, -5], [-6, 5], [6, 5]].some(([lx, lz]) => Math.abs(p.x - c.x - lx!) <= 0.6 + 1e-3 && Math.abs(p.z - c.z - lz!) <= 0.6 + 1e-3));
      expect(off.slice(0, 4).map((p) => p.toArray().map((v) => +v.toFixed(2))), `crane at ${c.x}`).toEqual([]);
      expect(Math.max(...mine.map((p) => p.y))).toBeGreaterThan(c.y + 45);
      expect(Math.max(...mine.map((p) => p.z))).toBeGreaterThan(c.z + 35);
    }
  });

  it('the Azura Bowl is drawn on its box: the podium on the collider, the bowl on its 22 m top, no office front or sign', () => {
    const W = world();
    const r = W.layout.stadium!;
    const st = W.layout.buildings.find((b) => b.special === 'stadium')!;
    const pts = meshes(city.group, 'setpieces').flatMap((m) => points(m.geometry, m.matrixWorld)).filter((p) => p.x > r.minX - 2 && p.x < r.maxX + 2 && p.z > r.minZ - 2 && p.z < r.maxZ + 2);
    expect(pts.length).toBeGreaterThan(1000);
    // Below the top nothing stands more than a fin's depth off the walls, and nothing inside the box lower than its top.
    const out = pts.filter((p) => p.y < st.height && (p.x < r.minX - 0.31 || p.x > r.maxX + 0.31 || p.z < r.minZ - 0.31 || p.z > r.maxZ + 0.31));
    expect(out).toEqual([]);
    const inside = pts.filter((p) => p.x > r.minX + 1 && p.x < r.maxX - 1 && p.z > r.minZ + 1 && p.z < r.maxZ - 1);
    expect(Math.min(...inside.map((p) => p.y))).toBeGreaterThanOrEqual(st.height - 1e-6);
    let sign = 0;
    city.group.traverse((o) => {
      if (o.name === 'sign' && o.userData.building === st.id) sign++;
    });
    expect(sign).toBe(0);
  });
});

describe('AzuraLink', () => {
  it("its train's shell and the beam with its pylon heads have unit normals, the cars within their width and height", () => {
    const view = new MonorailView(world());
    const body = meshes(view.group, 'train-body')[0]!;
    expect(badNormals(body.geometry)).toEqual([]);
    expect(badNormals(meshes(view.group, 'monorail-beam')[0]!.geometry)).toEqual([]);
    const y = world().layout.monorail.beamY;
    const b = new THREE.Box3().setFromPoints(points(body.geometry));
    expect(Math.max(-b.min.x, b.max.x)).toBeLessThanOrEqual(CAR_WIDTH / 2 + 0.05);
    expect(b.max.y).toBeLessThanOrEqual(y + CAR_HEIGHT + 0.33);
  });
});
