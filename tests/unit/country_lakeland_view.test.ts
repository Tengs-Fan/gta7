// Drawing Lake Lomas and Pinewood (render/country/lake.ts, woods.ts, campfire.ts, pineModels.ts): the pines instanced one model
// to a cell, the shore's pieces in a kit of their own, the reeds, wildflowers and boulders culled with the county's cells, the
// lamps' glow and the campfire coming up after dark, the waterfowl on the water.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { CountryView } from '../../src/render/country';
import { lakeLamps } from '../../src/render/country/lake';
import { PINE_H, pineGeometry } from '../../src/render/country/pineModels';
import { PropsView } from '../../src/render/props';
import { FLOWER_RING } from '../../src/render/quality';
import { HARDWARE_CHUNK_SIZE } from '../../src/render/spatial';
import { campfireLit } from '../../src/world/country/lakeland';
import { PINE_TOWER } from '../../src/world/country/woods';
import { world } from './helpers';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

const W = world();
const land = W.layout.country.lakeland;
const wind = { uWindTime: { value: 0 }, uWindAmp: { value: 0 }, uWindDir: { value: new THREE.Vector2(1, 0) } };
const view = new CountryView(W, new CityView(W), wind);
const meshes = (name: string) => {
  const out: THREE.Mesh[] = [];
  view.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.name === name) out.push(o);
  });
  return out;
};
const tris = (g: THREE.BufferGeometry) => (g.index?.count ?? g.getAttribute('position').count) / 3;

describe('the pine', () => {
  it('is a slender spire of seven needle skirts on a bare trunk, about a hundred triangles, 11.7 m tall, nothing like a broadleaf crown', () => {
    const g = pineGeometry();
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeCloseTo(PINE_H, 1);
    expect(g.boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(Math.max(g.boundingBox!.max.x, g.boundingBox!.max.z)).toBeLessThan(2.2);
    expect(g.userData.parts.filter((p: string) => p === 'needles').length).toBe(7);
    expect(tris(g)).toBeLessThan(120);
    expect(tris(g)).toBeGreaterThan(60);
  });

  it('is instanced one batch to a half cell, so a batch the frustum or the sun\'s shadow takes is a few hundred pines, each pine its tint', () => {
    const props = new PropsView(W, HARDWARE_CHUNK_SIZE);
    const batches: THREE.InstancedMesh[] = [];
    props.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.geometry.name === 'pine') batches.push(o);
    });
    const pines = W.layout.props.filter((p) => p.kind === 'pine');
    expect(batches.reduce((n, m) => n + m.count, 0)).toBe(pines.length);
    const half = HARDWARE_CHUNK_SIZE / 2;
    const cells = new Set(pines.map((p) => `${Math.floor(p.x / half)},${Math.floor(p.z / half)}`)).size;
    expect(batches.length).toBe(cells);
    expect(batches.length).toBeLessThan(40);
    expect(Math.max(...batches.map((m) => m.count))).toBeLessThan(700);
    expect(new Set(batches.map((m) => m.geometry)).size).toBe(1);
    for (const m of batches) expect(m.instanceColor).not.toBeNull();
    console.log(`[lakeland] ${pines.length} pines in ${batches.length} batches, ${batches.reduce((n, m) => n + tris(m.geometry) * m.count, 0)} triangles`);
  });
});

describe('the shore and the wood', () => {
  it('draws the reeds, the wildflowers, the valley\'s boulders and the lookout tower, each a mesh culled with the county\'s cells', () => {
    for (const name of ['reeds', 'wildflowers', 'tussocks', 'valley-rocks', 'lake-lamp-pools']) expect(meshes(name).length, name).toBeGreaterThan(0);
    expect(meshes('pine-lookout').length).toBe(1);
    const tower = meshes('pine-lookout')[0]!;
    tower.geometry.computeBoundingBox();
    // From the rise's top up past the cab to the roof, about 18 m.
    expect(tower.geometry.boundingBox!.max.y - tower.geometry.boundingBox!.min.y).toBeGreaterThan(PINE_TOWER.top - 1);
    expect(tower.geometry.boundingBox!.min.y).toBeCloseTo(W.groundHeight(PINE_TOWER.x, PINE_TOWER.z), 3);
  });

  it('draws the wildflowers and the tussocks only within the tier\'s ring of the camera, the tussocks nearer, and none on the software tier', () => {
    const visible = (name: string) => meshes(name).filter((m) => m.visible);
    const reach = (m: THREE.Mesh, x: number, z: number) => {
      const b = new THREE.Box3().setFromObject(m);
      return Math.hypot(Math.max(b.min.x - x, 0, x - b.max.x), Math.max(b.min.z - z, 0, z - b.max.z));
    };
    const at = PINE_TOWER;
    for (const tier of ['high', 'medium', 'low'] as const) {
      view.setTier(tier);
      view.cull(at.x, at.z, 760);
      for (const [name, ring] of [['wildflowers', FLOWER_RING[tier].patch], ['tussocks', FLOWER_RING[tier].tussock]] as const) {
        const shown = visible(name);
        expect(shown.length, `${tier} ${name}`).toBeGreaterThan(0);
        for (const m of meshes(name)) expect(m.visible, `${tier} ${name}`).toBe(reach(m, at.x, at.z) <= ring);
      }
    }
    expect(FLOWER_RING.high.tussock).toBeLessThan(FLOWER_RING.high.patch);
    // Far away from every cell (the county's east end, 1,900 m off the wood), none.
    view.setTier('high');
    view.cull(900, 0, 760);
    expect(visible('wildflowers').length + visible('tussocks').length).toBe(0);
    view.setTier('software');
    view.cull(at.x, at.z, 760);
    expect(visible('wildflowers').length + visible('tussocks').length).toBe(0);
    view.setTier('high');
  });

  it('drapes the lanes and the pads as dirt facing up, 3.5 cm over the ground, along every lane from the road to its end', () => {
    const dirt = meshes('places-dirt');
    expect(dirt.length).toBe(2);
    const mine = dirt.find((m) => {
      m.geometry.computeBoundingBox();
      return m.geometry.boundingBox!.min.x < -1900;
    })!;
    const pos = mine.geometry.getAttribute('position');
    const nrm = mine.geometry.getAttribute('normal');
    const near = (x: number, z: number, r: number) => Array.from({ length: pos.count }, (_, i) => i).filter((i) => Math.hypot(pos.getX(i) - x, pos.getZ(i) - z) < r).length;
    for (let i = 0; i < pos.count; i++) {
      expect(nrm.getY(i), `dirt vertex ${i} at ${pos.getX(i).toFixed(1)}, ${pos.getZ(i).toFixed(1)}`).toBeGreaterThan(0.5);
      expect(pos.getY(i) - W.groundHeight(pos.getX(i), pos.getZ(i))).toBeGreaterThan(0);
      expect(pos.getY(i) - W.groundHeight(pos.getX(i), pos.getZ(i))).toBeLessThan(0.5);
    }
    // A vertex pair every 3 m along each lane's edges, from its mouth to its end, and the tower's pad on its hill.
    for (const l of land.lanes) for (const k of [0, 5, l.pts.length / 2 - 1].map((i) => Math.min(i, l.pts.length / 2 - 1))) expect(near(l.pts[2 * k]!, l.pts[2 * k + 1]!, l.width), `lane point ${k}`).toBeGreaterThan(0);
    expect(near(PINE_TOWER.x, PINE_TOWER.z - 10, 8)).toBeGreaterThan(0);
  });

  it('puts every lamp by a cabin door and at the dock\'s head, and its halo and pool come up with the night', () => {
    const lamps = lakeLamps(land);
    expect(lamps.length).toBe(land.cabins.length + 1);
    view.update(-1900, 2, -280, 0, 5, 12, { x: 0, z: 0 }, null);
    const pool = meshes('lake-lamp-pools')[0]!.material as THREE.MeshBasicMaterial;
    expect(pool.opacity).toBe(0);
    view.update(-1900, 2, -280, 1, 6, 23, { x: 0, z: 0 }, null);
    expect(pool.opacity).toBeGreaterThan(0.3);
  });

  it('lends the fire its light while nothing else has it, lets go without writing when a molotov\'s fire takes it, and darkens it when it burns out or the camera leaves', () => {
    const fx = { groundFire: vi.fn(), fireLight: vi.fn(() => true) };
    const at = land.camp.fire;
    const near = { x: at.x + 10, y: at.y, z: at.z };
    const camp = view.camp;
    camp.update(23, 0, near);
    camp.sync(fx as never, 0.016, near, 0, false);
    expect(fx.fireLight).toHaveBeenCalledTimes(1);
    expect(fx.fireLight.mock.calls[0]![3]).toBeGreaterThan(0);
    expect(fx.groundFire).toHaveBeenCalledTimes(1);
    // A molotov's fire has it: no light written, the fire still burns; and then it is let go.
    fx.fireLight.mockClear();
    camp.sync(fx as never, 0.016, near, 0.1, true);
    expect(fx.fireLight).not.toHaveBeenCalled();
    camp.sync(fx as never, 0.016, near, 0.2, true);
    expect(fx.fireLight).not.toHaveBeenCalled();
    // Free again, it takes the light back; out of range, it darkens what it holds.
    camp.sync(fx as never, 0.016, near, 0.3, false);
    expect(fx.fireLight).toHaveBeenCalledTimes(1);
    fx.fireLight.mockClear();
    camp.sync(fx as never, 0.016, { x: at.x + 400, y: at.y, z: at.z }, 0.4, false);
    expect(fx.fireLight).toHaveBeenCalledWith(0, 0, 0, 0);
    // By day it is out: nothing to hold.
    fx.fireLight.mockClear();
    camp.update(12, 0, near);
    camp.sync(fx as never, 0.016, near, 0.5, false);
    expect(fx.fireLight).not.toHaveBeenCalled();
  });

  it('burns the campfire from dusk to the first light, embers and a pool of firelight, out through the day', () => {
    expect(campfireLit(12)).toBe(0);
    expect(campfireLit(23)).toBe(1);
    expect(campfireLit(3)).toBe(1);
    expect(campfireLit(20.5)).toBe(1);
    expect(campfireLit(6)).toBeGreaterThan(0);
    expect(campfireLit(6)).toBeLessThan(1);
    expect(campfireLit(8)).toBe(0);
    view.update(-1900, 2, -280, 0, 1, 12, { x: 0, z: 0 }, null);
    const mat = (name: string) => {
      let m: THREE.Material | null = null;
      view.group.traverse((o) => {
        if (o.name === name && (o instanceof THREE.Mesh || o instanceof THREE.Points)) m = o.material as THREE.Material;
      });
      return m as unknown as THREE.Material & { opacity: number };
    };
    expect(mat('campfire-pool').opacity).toBe(0);
    view.update(-1900, 2, -280, 1, 2, 23, { x: 0, z: 0 }, null);
    expect(mat('campfire-pool').opacity).toBeGreaterThan(0.2);
    expect(mat('campfire-halo').opacity).toBeGreaterThan(0.2);
    expect(mat('campfire-embers').opacity).toBeGreaterThan(0.2);
  });
});
