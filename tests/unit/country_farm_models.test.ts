// How Las Lomas County's farmsteads are drawn (render/country/farms.ts, valley.ts): the farmhouses' porches, steps and
// all, in their yards and clear of everything that stands or parks there and of the dairy dog's run; nothing drawn on the
// barns' ridges where the crows perch; the hedgerows' leaves inside their colliders' reach; and every new piece in the
// draws the farms already had.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { CountryView } from '../../src/render/country';
import { farmhouseFront, porchRect } from '../../src/render/country/farms';
import { dogRun } from '../../src/render/country/life/dog';
import { crowSites } from '../../src/render/country/life/flocks';
import { HEDGE_H } from '../../src/world/country/farms';
import { mkRect, rectContains, rectsOverlap, type Rect } from '../../src/world/layout';
import { world } from './helpers';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

const W = world();
const L = W.layout;
const farms = L.country.farms;
const wind = { uWindTime: { value: 0 }, uWindAmp: { value: 0.05 }, uWindDir: { value: new THREE.Vector2(1, 0) } };
const view = new CountryView(W, new CityView(W), wind);

const meshes = (name: string): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  view.group.traverse((o) => {
    if (o.name === name && o instanceof THREE.Mesh) out.push(o);
  });
  return out;
};

const grow = (r: Rect, d: number): Rect => mkRect(r.minX - d, r.minZ - d, r.maxX + d, r.maxZ + d);

describe('the farmhouses, drawn', () => {
  it('stand each porch, steps and all, in its yard, clear of the barns, the props, the parked cars and the dog\'s run', () => {
    const run = dogRun(W);
    for (const f of farms.farmsteads) {
      const house = L.buildings.find((b) => b.id === f.house)!;
      const porch = porchRect(house.rect, farmhouseFront(f.id));
      expect(rectContains(f.yard, porch.minX, porch.minZ) && rectContains(f.yard, porch.maxX, porch.maxZ), f.id).toBe(true);
      for (const g of L.garages) expect(rectsOverlap(grow(g.rect, 1), porch), `${f.id} barn ${g.poi}`).toBe(false);
      for (const b of L.buildings) if (b.id !== f.house) expect(rectsOverlap(b.rect, porch), `${f.id} building ${b.id}`).toBe(false);
      for (let i = L.country.firstProp; i < L.props.length; i++) {
        const c = W.grid.colliders[W.propColliders[i]!];
        if (!c) continue;
        const r = c.circle ? mkRect(c.cx - c.r, c.cz - c.r, c.cx + c.r, c.cz + c.r) : c;
        expect(rectsOverlap(r, porch), `${f.id} prop ${L.props[i]!.kind}`).toBe(false);
      }
      // A parked car is 2 by 5 m about its spot, whichever way it faces.
      for (const p of L.parking) expect(rectsOverlap(mkRect(p.x - 2.5, p.z - 2.5, p.x + 2.5, p.z + 2.5), porch), `${f.id} parking`).toBe(false);
      if (f.id === 'dairy') expect(run.x - porch.maxX).toBeGreaterThan(2);
    }
  });

  it('draw nothing above a crow perched on a barn\'s ridge', () => {
    const ridges = crowSites(W)
      .flatMap((s) => s.perches)
      .filter((p) => farms.farmsteads.some((f) => rectContains(f.barn, p.x, p.z)));
    expect(ridges.length).toBe(8);
    const [mesh] = meshes('farmsteads');
    const pos = mesh!.geometry.getAttribute('position');
    for (const p of ridges) {
      for (let i = 0; i < pos.count; i++) {
        if (Math.hypot(pos.getX(i) - p.x, pos.getZ(i) - p.z) > 0.6) continue;
        expect(pos.getY(i), `ridge perch at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`).toBeLessThan(p.y + 0.05);
      }
    }
  });
});

describe('the hedgerows, drawn', () => {
  it('keep their leaves within a few centimetres of their colliders\' sides and ends and a quarter metre of their top', () => {
    const rects = [...farms.hedges, ...L.country.valley.hedges];
    const [mesh] = meshes('hedgerows');
    const pos = mesh!.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      expect(pos.getY(i)).toBeLessThanOrEqual(HEDGE_H + 0.25);
      // Up to a tenth thicker than the collider, a fifth of a metre past its ends.
      const near = rects.some((h) => {
        const alongX = h.maxX - h.minX > h.maxZ - h.minZ;
        const t = (alongX ? h.maxZ - h.minZ : h.maxX - h.minX) * 0.06 + 0.13;
        return rectContains(alongX ? mkRect(h.minX - 0.21, h.minZ - t, h.maxX + 0.21, h.maxZ + t) : mkRect(h.minX - t, h.minZ - 0.21, h.maxX + t, h.maxZ + 0.21), x, z);
      });
      expect(near, `${x.toFixed(2)}, ${z.toFixed(2)}`).toBe(true);
    }
  });

  it('cover every metre of every run, from end to end', () => {
    const [mesh] = meshes('hedgerows');
    const pos = mesh!.geometry.getAttribute('position');
    for (const h of [...farms.hedges, ...L.country.valley.hedges]) {
      const alongX = h.maxX - h.minX > h.maxZ - h.minZ;
      const [a0, a1] = alongX ? [h.minX, h.maxX] : [h.minZ, h.maxZ];
      const seen = new Set<number>();
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        if (!rectContains(grow(h, 0.4), x, z) || pos.getY(i) < HEDGE_H * 0.7) continue;
        const a = alongX ? x : z;
        // A pillow's top spans its length: mark every metre its vertices reach on either side.
        seen.add(Math.floor(a - a0));
      }
      for (let m = 0; m < Math.floor(a1 - a0) - 1; m++) {
        const near = seen.has(m) || seen.has(m - 1) || seen.has(m + 1);
        expect(near, `hedge at ${h.minX}, ${h.minZ}: ${m} m`).toBe(true);
      }
    }
  });
});

describe('the farms\' meshes', () => {
  it('keep the porches, doors, chimneys, hoods, cupolas and tin in the farms\' draws: one mesh of farmsteads, one of hedgerows', () => {
    expect(meshes('farmsteads').length).toBe(1);
    expect(meshes('hedgerows').length).toBe(1);
    expect(meshes('lazy-q-ranch').length).toBe(1);
  });
});

describe('the roads\' shoulders, drawn', () => {
  it('lay their gravel only on the county\'s land, off the bridges, the causeway\'s water and the city\'s promenade', () => {
    const [mesh] = meshes('country-shoulders');
    const pos = mesh!.geometry.getAttribute('position');
    const off: string[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      if (!L.country.land.some((r) => rectContains(r, x, z))) off.push(`${x.toFixed(1)}, ${z.toFixed(1)}`);
    }
    expect(off.slice(0, 12)).toEqual([]);
  });
});
