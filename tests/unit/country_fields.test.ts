// Las Lomas County's fields (world/country/farms.ts, render/country/fields.ts): where they lie (in the farm plots, 12 m
// and more off every road edge), which of them are cover and drag at a car, and how they are drawn at a cost set by
// what the camera sees: pools of plants sized by tier round the camera, each holding every plant of its ring wherever the
// camera is, every plant at its own spot of its field's lattice, refills that move none of them, nothing refilled,
// uploaded or drawn far from the fields, and the blocks seen from inside on the software tier; and the hedgerows, which
// open round the camera's sight line while one stands in it.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { CountryView } from '../../src/render/country';
import { cropPlants, FIELD_CELL } from '../../src/render/country/fields';
import { CROP_RING } from '../../src/render/quality';
import { plotAt } from '../../src/world/country';
import { TALL_CROPS, type Crop, type Field } from '../../src/world/country/farms';
import { rectCX, rectCZ } from '../../src/world/layout';
import { rectClearance } from './farm_helpers';
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
  const canvas = (): Record<string, unknown> => ({ width: 300, height: 150, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx2d() : null), addEventListener: () => {}, removeEventListener: () => {} });
  g.document ??= { createElement: canvas, createElementNS: canvas };
});

const W = world();
const farms = W.layout.country.farms;

describe('Las Lomas County: the fields', () => {
  it('lies every field in a farm plot, 12 m and more off every road edge, on flat ground', () => {
    const crops = new Set<Crop>();
    for (const f of farms.fields) {
      crops.add(f.crop);
      const r = f.rect;
      for (const [x, z] of [[r.minX, r.minZ], [r.maxX, r.maxZ]] as const) expect(plotAt(W.layout.country, x, z)?.kind, `${f.crop} at ${rectCX(r)},${rectCZ(r)}`).toBe('farm');
      expect(plotAt(W.layout.country, r.minX, r.minZ)).toBe(plotAt(W.layout.country, r.maxX, r.maxZ));
      expect(rectClearance(r), `${f.crop} at ${rectCX(r)},${rectCZ(r)}`).toBeGreaterThanOrEqual(12);
      for (let x = r.minX; x <= r.maxX; x += 8) for (let z = r.minZ; z <= r.maxZ; z += 8) expect(W.baseGround(x, z)).toBe(0);
    }
    expect([...crops].sort()).toEqual(['corn', 'furrow', 'lettuce', 'sunflower', 'wheat']);
    // No two fields overlap.
    for (const [i, a] of farms.fields.entries()) for (const b of farms.fields.slice(i + 1)) expect(a.rect.maxX <= b.rect.minX || b.rect.maxX <= a.rect.minX || a.rect.maxZ <= b.rect.minZ || b.rect.maxZ <= a.rect.minZ).toBe(true);
  });

  it('hides a target and drags at a car in the corn and the sunflowers, not in the wheat, the furrows or the lettuce', () => {
    for (const f of farms.fields) {
      const x = rectCX(f.rect);
      const z = rectCZ(f.rect);
      expect(W.coverAt(x, z), f.crop).toBe(TALL_CROPS.has(f.crop));
      expect(W.cropAt(x, z), f.crop).toBe(TALL_CROPS.has(f.crop));
      expect(W.cropAt(f.rect.minX - 1, z)).toBe(false);
    }
    // In the city, nothing.
    expect(W.cropAt(0, 0)).toBe(false);
  });
});

describe('Las Lomas County: drawing the fields', () => {
  const wind = { uWindTime: { value: 0 }, uWindAmp: { value: 0 }, uWindDir: { value: new THREE.Vector2(1, 0) } };
  const view = new CountryView(W, new CityView(W), wind);
  const pool = (crop: Crop) => view.moving.children.find((o) => o.name === `crops-${crop}`) as THREE.InstancedMesh;
  /** The plants a pool holds now, as their places. */
  const plants = (crop: Crop): Map<string, number> => {
    const m = pool(crop);
    const e = new THREE.Matrix4();
    const out = new Map<string, number>();
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, e);
      out.set(`${e.elements[12]!.toFixed(4)},${e.elements[14]!.toFixed(4)}`, i);
    }
    return out;
  };
  const biggest = (crop: Crop): Field => farms.fields.filter((f) => f.crop === crop).sort((a, b) => (b.rect.maxX - b.rect.minX) * (b.rect.maxZ - b.rect.minZ) - (a.rect.maxX - a.rect.minX) * (a.rect.maxZ - a.rect.minZ))[0]!;

  it('sizes its pools by tier, smaller on Medium and smaller again on Low, none on the software tier', () => {
    const { high, medium, low, software } = CROP_RING;
    for (const k of ['corn', 'wheat', 'sunflower'] as const) {
      // Empty and not drawn before the camera ever comes near a field.
      expect(pool(k).count).toBe(0);
      expect(pool(k).visible).toBe(false);
      expect(medium[k]).toBeLessThan(high[k]);
      expect(low[k]).toBeLessThan(medium[k]);
      expect(software[k]).toBe(0);
      expect(pool(k).instanceMatrix.count).toBe(high[k]);
    }
    expect(medium.ring).toBeLessThan(high.ring);
    expect(low.ring).toBeLessThan(medium.ring);
  });

  it('holds every plant of its crop in its ring from every cell by a field, on every tier', () => {
    for (const tier of ['high', 'medium', 'low'] as const) {
      for (const crop of ['corn', 'wheat', 'sunflower'] as const) {
        const radius = crop === 'wheat' ? CROP_RING[tier].wheatRing : CROP_RING[tier].ring;
        let most = 0;
        for (const { rect: r } of farms.fields.filter((f) => f.crop === crop)) {
          for (let cx = Math.floor((r.minX - radius) / FIELD_CELL); cx <= Math.floor((r.maxX + radius) / FIELD_CELL); cx++) {
            for (let cz = Math.floor((r.minZ - radius) / FIELD_CELL); cz <= Math.floor((r.maxZ + radius) / FIELD_CELL); cz++) {
              most = Math.max(most, cropPlants(farms.fields, crop, radius, (cx + 0.5) * FIELD_CELL, (cz + 0.5) * FIELD_CELL).length);
            }
          }
        }
        expect(most, `${tier} ${crop}`).toBeLessThanOrEqual(CROP_RING[tier][crop]);
      }
    }
  });

  it('fills the ring to its edge from the middle of each crop on every tier, within its pool', () => {
    for (const tier of ['high', 'medium', 'low'] as const) {
      view.setTier(tier);
      for (const crop of ['corn', 'wheat', 'sunflower'] as const) {
        const f = biggest(crop);
        const x = rectCX(f.rect);
        const z = rectCZ(f.rect);
        view.fields.update(x, 3, z, 1, 0);
        const m = pool(crop);
        const ring = crop === 'wheat' ? CROP_RING[tier].wheatRing : CROP_RING[tier].ring;
        const cx = (Math.floor(x / FIELD_CELL) + 0.5) * FIELD_CELL;
        const cz = (Math.floor(z / FIELD_CELL) + 0.5) * FIELD_CELL;
        let far = 0;
        const e = new THREE.Matrix4();
        for (let i = 0; i < m.count; i++) {
          m.getMatrixAt(i, e);
          const d = Math.hypot(e.elements[12]! - cx, e.elements[14]! - cz);
          expect(d).toBeLessThanOrEqual(ring);
          far = Math.max(far, d);
        }
        expect(m.count, `${tier} ${crop}`).toBeGreaterThan(0);
        expect(m.count, `${tier} ${crop}`).toBeLessThanOrEqual(CROP_RING[tier][crop]);
        // No plant left out for the pool's size: the ring is full out to its edge down the field's length.
        expect(far, `${tier} ${crop}`).toBeGreaterThan(ring - 2);
        console.log(`[country_fields] ${tier} ${crop}: ${m.count}/${CROP_RING[tier][crop]} plants within ${ring} m`);
      }
    }
    view.setTier('high');
  });

  it('keeps every plant where it was across refills, and draws none high over the fields or far from them', () => {
    view.setTier('high');
    const f = biggest('corn');
    const x = rectCX(f.rect);
    const z = rectCZ(f.rect);
    view.fields.update(x, 3, z, 1, 0);
    const a = plants('corn');
    view.fields.update(x + FIELD_CELL, 3, z, 1, 0);
    const b = plants('corn');
    view.fields.update(x, 3, z, 1, 0);
    expect([...plants('corn').keys()].sort()).toEqual([...a.keys()].sort());
    // Every plant both rings hold stands at the same spot in both.
    const shared = [...b.keys()].filter((k) => a.has(k));
    expect(shared.length).toBeGreaterThan(a.size * 0.5);
    // High over the corn (a helicopter's view), and far from the fields (the city), the pools are empty.
    view.fields.update(x, 45, z, 1, 0);
    expect(pool('corn').count).toBe(0);
    view.fields.update(x, 3, z, 1, 0);
    expect(pool('corn').count).toBe(a.size);
    view.fields.update(0, 3, 0, 1, 0);
    for (const crop of ['corn', 'wheat', 'sunflower'] as const) expect(pool(crop).count).toBe(0);
  });

  it('uploads only the plants a pool holds, and far from the fields refills, uploads and draws nothing', () => {
    view.setTier('high');
    const f = biggest('corn');
    view.fields.update(rectCX(f.rect), 3, rectCZ(f.rect), 1, 0);
    const corn = pool('corn');
    expect(corn.visible).toBe(true);
    expect(corn.instanceMatrix.updateRanges).toEqual([{ start: 0, count: corn.count * 16 }]);
    expect(corn.instanceColor!.updateRanges).toEqual([{ start: 0, count: corn.count * 3 }]);
    // Into the city: the pools are emptied once, then left alone cell after cell.
    view.fields.update(0.5, 3, 0.5, 1, 0);
    const pools = (['corn', 'wheat', 'sunflower'] as const).map(pool);
    const versions = pools.map((p) => p.instanceMatrix.version);
    for (let x = 16; x < 176; x += FIELD_CELL) view.fields.update(x + 0.5, 3, 0.5, 1, 0);
    expect(pools.map((p) => p.instanceMatrix.version)).toEqual(versions);
    for (const p of pools) {
      expect(p.count).toBe(0);
      expect(p.visible).toBe(false);
    }
  });

  it('opens the hedgerows round the sight line while one stands between the camera and the player, and only then', () => {
    const h = farms.hedges.find((q) => q.maxZ - q.minZ > 50)!;
    const z = rectCZ(h);
    const open = view.farms.sightUniforms.uSightOpen;
    // The player 2 m west of the hedge facing west, the camera 4.3 m behind him, past the hedge (as the review framed it).
    const behind = { x: h.maxX + 0.9, y: 2.1, z };
    const player = { x: h.minX - 2, y: 1.6, z };
    view.farms.sight(behind, player, 0.1);
    expect(open.value).toBeCloseTo(0.5);
    view.farms.sight(behind, player, 0.2);
    expect(open.value).toBe(1);
    expect(view.farms.sightUniforms.uSightSubject.value.toArray()).toEqual([player.x, player.y, player.z]);
    // Walking along the hedge 1.2 m off it, the camera behind him: nothing in between, so it closes.
    const along = { x: h.minX - 1.2, y: 1.6, z: z - 2 };
    view.farms.sight({ x: h.minX - 1.6, y: 2.1, z: z + 2.3 }, along, 0.1);
    expect(open.value).toBeCloseTo(0.5);
    view.farms.sight({ x: h.minX - 1.6, y: 2.1, z: z + 2.3 }, along, 0.2);
    expect(open.value).toBe(0);
    // Nothing framed (the title screen): nothing opens.
    view.farms.sight(behind, null, 1);
    expect(open.value).toBe(0);
  });

  it('draws the corn and the sunflowers\' blocks from inside too on the software tier, which has no plants', () => {
    const soft = new CountryView(W, new CityView(W), wind, true);
    const side = (v: CountryView, name: string) => (v.group.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material.side;
    for (const name of ['crop-top-corn', 'crop-side-corn', 'crop-top-sunflower', 'crop-side-sunflower']) {
      expect(side(soft, name), name).toBe(THREE.DoubleSide);
      expect(side(view, name), name).toBe(THREE.FrontSide);
    }
  });
});
