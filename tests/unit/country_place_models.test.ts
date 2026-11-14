// How the county's places and Hollister Farm are drawn (render/country/town.ts, render/city/attractions.ts): Dry Creek's
// fronts in bays of their band, never stretched far from its own proportions, the door's bay in the middle, and nothing
// of theirs on the boardwalks where people walk; the places' atlas no taller than it was; every vertex of the redrawn
// meshes and models with a normal; Hollister's farmhouse porch clear of where its owner stands.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { HOLLISTER_PORCH } from '../../src/render/city/attractions';
import { CountryView } from '../../src/render/country';
import { farmFenceGeometry } from '../../src/render/country/farmModels';
import { pineGeometry } from '../../src/render/country/pineModels';
import { bays } from '../../src/render/country/town';
import { attractionOf } from '../../src/world/attractions';
import { rectContains } from '../../src/world/layout';
import { world } from './helpers';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

const W = world();
const L = W.layout;
const town = L.country.places.town;
const wind = { uWindTime: { value: 0 }, uWindAmp: { value: 0.05 }, uWindDir: { value: new THREE.Vector2(1, 0) } };
const city = new CityView(W);
const view = new CountryView(W, city, wind);

const mesh = (root: THREE.Object3D, name: string): THREE.Mesh => {
  let out: THREE.Mesh | null = null;
  root.traverse((o) => {
    if (o.name === name && o instanceof THREE.Mesh) out = o;
  });
  return out!;
};

describe('Dry Creek\'s fronts, drawn', () => {
  it('repeat their bays within a sixth of the band\'s proportions, an odd number of them so the door\'s is in the middle', () => {
    const bay = (3.2 * 256) / 192;
    for (const s of town.stores) {
      const w = s.body.maxX - s.body.minX - 0.5;
      const n = bays(w);
      expect(n % 2, s.name).toBe(1);
      expect(Math.abs(w / n / bay - 1), s.name).toBeLessThan(1 / 6);
    }
  });

  it('keep the boardwalks clear between the fronts and the porch posts, where people walk, up to head height', () => {
    const pos = mesh(view.group, 'dry-creek').geometry.getAttribute('position');
    const fronts = town.stores.map((s) => ({ s, z: s.front === 'S' ? s.body.maxZ + 0.4 : s.body.minZ - 0.4 }));
    const hits: string[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (y < 0.12 || y > 2.5 || !town.boardwalks.some((r) => rectContains(r, x, z))) continue;
      for (const { s, z: fz } of fronts) {
        const out = (s.front === 'S' ? 1 : -1) * (z - fz);
        if (x > s.body.minX - 0.5 && x < s.body.maxX + 0.5 && out > 0.4 && out < 2.6) hits.push(`${s.name} ${x.toFixed(1)} ${y.toFixed(1)} ${out.toFixed(2)}`);
      }
    }
    expect(hits.slice(0, 8)).toEqual([]);
  });

  it('paint them on the places\' atlas without growing it past the 6,656 px it was', () => {
    const map = (mesh(view.group, 'dry-creek').material as THREE.MeshStandardMaterial).map!;
    expect((map.image as { height: number }).height).toBeLessThanOrEqual(6656);
  });
});

describe('the redrawn meshes', () => {
  it('stay one mesh each, so the fronts, the scaffold, the barn and the porch add no draw', () => {
    for (const [root, name] of [[view.group, 'dry-creek'], [view.group, 'moonbeam-drive-in'], [view.group, 'farmsteads'], [view.group, 'lazy-q-ranch'], [city.group, 'attractions']] as const) {
      let n = 0;
      root.traverse((o) => {
        if (o.name === name && o instanceof THREE.Mesh) n++;
      });
      expect(n, name).toBe(1);
    }
  });

  it('give every vertex a normal to light it by (a zero one lights a pixel NaN, which the bloom spreads over the frame)', () => {
    const geos: Array<[string, THREE.BufferGeometry]> = [
      ...(['dry-creek', 'moonbeam-drive-in', 'farmsteads', 'lazy-q-ranch', 'lake-lomas', 'hedgerows'] as const).map((n): [string, THREE.BufferGeometry] => [n, mesh(view.group, n).geometry]),
      ['attractions', mesh(city.group, 'attractions').geometry],
      ['pine', pineGeometry()],
      ['farm-fence', farmFenceGeometry()],
    ];
    for (const [name, g] of geos) {
      const n = g.getAttribute('normal');
      let zero = 0;
      for (let i = 0; i < n.count; i++) if (!(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) > 0.5)) zero++;
      expect(zero, name).toBe(0);
    }
  });
});

describe('Hollister Farm, drawn', () => {
  it('stands its farmhouse porch, step and roof and all, clear of where its owner stands', () => {
    const farm = attractionOf(L, 'farm').anchors;
    const pos = mesh(city.group, 'attractions').geometry.getAttribute('position');
    const near: string[] = [];
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 2.2) continue;
      const d = Math.hypot(pos.getX(i) - farm.porch.x, pos.getZ(i) - farm.porch.z);
      if (d < 0.45) near.push(`${pos.getX(i).toFixed(2)}, ${pos.getY(i).toFixed(2)}, ${pos.getZ(i).toFixed(2)}`);
    }
    expect(near).toEqual([]);
    const house = L.buildings.find((b) => b.id === farm.house)!.rect;
    expect(farm.porch.z - house.maxZ - (HOLLISTER_PORCH.depth + 0.3 * HOLLISTER_PORCH.steps)).toBeGreaterThan(0.4);
  });
});
