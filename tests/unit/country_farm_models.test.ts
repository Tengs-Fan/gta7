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

  it('draw each porch, roof and steps and all, inside the rect the clearances above are measured on', () => {
    const pos = meshes('farmsteads')[0]!.geometry.getAttribute('position');
    for (const f of farms.farmsteads) {
      const house = L.buildings.find((b) => b.id === f.house)!.rect;
      const front = farmhouseFront(f.id);
      const porch = grow(porchRect(house, front), 0.01);
      const out: string[] = [];
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        // In front of the wall past its plinth and corner boards, along the house, up to the porch roof's height.
        const ahead = front === 'S' ? z - house.maxZ : house.minZ - z;
        if (ahead < 0.15 || ahead > 5 || x < house.minX - 0.5 || x > house.maxX + 0.5 || pos.getY(i) > 4) continue;
        if (!rectContains(porch, x, z)) out.push(`${x.toFixed(2)}, ${pos.getY(i).toFixed(2)}, ${z.toFixed(2)}`);
      }
      expect(out.slice(0, 6), f.id).toEqual([]);
    }
  });

  it('stand a crow perched on a barn\'s ridge on its cap, with nothing over him', () => {
    const ridges = crowSites(W)
      .flatMap((s) => s.perches)
      .filter((p) => farms.farmsteads.some((f) => rectContains(f.barn, p.x, p.z)));
    expect(ridges.length).toBe(8);
    const [mesh] = meshes('farmsteads');
    const geo = mesh!.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.index!;
    // The highest of the triangles over (x, z): where a vertical line through it meets them.
    const surface = (x: number, z: number): number => {
      let top = -Infinity;
      for (let t = 0; t < idx.count; t += 3) {
        const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
        const [ax, az, bx, bz, cx, cz] = [pos.getX(a), pos.getZ(a), pos.getX(b), pos.getZ(b), pos.getX(c), pos.getZ(c)];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-9) continue;
        const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
        top = Math.max(top, u * pos.getY(a) + v * pos.getY(b) + (1 - u - v) * pos.getY(c));
      }
      return top;
    };
    for (const p of ridges) {
      // He stands on the ridge cap: nothing over his feet, and his feet on it.
      const top = surface(p.x, p.z);
      expect(top, `ridge perch at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`).toBeLessThan(p.y + 0.005);
      expect(top, `ridge perch at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`).toBeGreaterThan(p.y - 0.02);
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

  it('close every pillow, so no open end shows the sky through a hedge', () => {
    const geo = meshes('hedgerows')[0]!.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.index!;
    const key = (i: number) => `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    const edges = new Map<string, number>();
    for (let t = 0; t < idx.count; t += 3) {
      const v = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
      for (let e = 0; e < 3; e++) {
        const [a, b] = [v[e]!, v[(e + 1) % 3]!];
        // The foot of a run is under the ground: its edges there need no neighbour.
        if (pos.getY(a) < 0 && pos.getY(b) < 0) continue;
        const [ka, kb] = [key(a), key(b)].sort();
        edges.set(`${ka}|${kb}`, (edges.get(`${ka}|${kb}`) ?? 0) + 1);
      }
    }
    const open = [...edges].filter(([, n]) => n % 2 === 1).map(([k]) => k);
    expect(open.slice(0, 6)).toEqual([]);
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
  const geo = (): THREE.BufferGeometry => meshes('country-shoulders')[0]!.geometry;
  const onLand = (x: number, z: number) => L.country.land.some((r) => rectContains(r, x, z));
  /** Whether a shoulder triangle lies over (x, z). */
  const covered = (x: number, z: number): boolean => {
    const pos = geo().getAttribute('position');
    const idx = geo().index!;
    for (let t = 0; t < idx.count; t += 3) {
      const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
      const [ax, az, bx, bz, cx, cz] = [pos.getX(a), pos.getZ(a), pos.getX(b), pos.getZ(b), pos.getX(c), pos.getZ(c)];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) return true;
    }
    return false;
  };

  it('lie flat just over the grass, on the county\'s land and off the bridges, the causeway\'s water and the promenade', () => {
    const pos = geo().getAttribute('position');
    const off: string[] = [];
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBeGreaterThan(0);
      expect(pos.getY(i)).toBeLessThan(0.02);
      if (!onLand(pos.getX(i), pos.getZ(i))) off.push(`${pos.getX(i).toFixed(1)}, ${pos.getZ(i).toFixed(1)}`);
    }
    expect(off.slice(0, 12)).toEqual([]);
  });

  it('run on to within a metre or so of the land\'s edge where a road leaves it for a link', () => {
    const W2 = W.roads;
    const pos = geo().getAttribute('position');
    let crossings = 0;
    for (const { road, nodes } of W2.outerRoads) {
      for (let k = 1; k < nodes.length; k++) {
        const a = W2.nodes[nodes[k - 1]!]!;
        const b = W2.nodes[nodes[k]!]!;
        if (onLand(a.x, a.z) === onLand(b.x, b.z)) continue;
        // The edge along the chord, by halving.
        let [lo, hi] = onLand(a.x, a.z) ? [0, 1] : [1, 0];
        for (let i = 0; i < 40; i++) {
          const m = (lo + hi) / 2;
          if (onLand(a.x + (b.x - a.x) * m, a.z + (b.z - a.z) * m)) lo = m;
          else hi = m;
        }
        const px = a.x + (b.x - a.x) * lo;
        const pz = a.z + (b.z - a.z) * lo;
        // The nearest shoulder vertex beside the road, measured along it from the edge, on either side of the road.
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const [ux, uz] = [(b.x - a.x) / len, (b.z - a.z) / len];
        for (const side of [-1, 1]) {
          let gap = Infinity;
          for (let i = 0; i < pos.count; i++) {
            const dx = pos.getX(i) - px;
            const dz = pos.getZ(i) - pz;
            const across = dx * -uz + dz * ux;
            if (across * side < road.width / 2 - 0.1 || across * side > road.width / 2 + 1) continue;
            gap = Math.min(gap, Math.abs(dx * ux + dz * uz));
          }
          expect(gap, `${road.name} at ${px.toFixed(1)}, ${pz.toFixed(1)}, side ${side}`).toBeLessThan(1.1);
        }
        crossings++;
      }
    }
    expect(crossings).toBeGreaterThan(0);
  });

  it('edge a junction\'s pad on the side no road leaves it by', () => {
    let sides = 0;
    for (const n of W.roads.nodes.slice(W.roads.gridNodeCount)) {
      if (W.roads.isBend(n)) continue;
      const mid = [[n.x, n.z - n.halfZ - 0.45], [n.x + n.halfX + 0.45, n.z], [n.x, n.z + n.halfZ + 0.45], [n.x - n.halfX - 0.45, n.z]] as const;
      n.neighbors.forEach((nb, slot) => {
        const [x, z] = mid[slot]!;
        if (nb >= 0 || !onLand(x, z)) return;
        expect(covered(x, z), `pad at ${n.x.toFixed(0)}, ${n.z.toFixed(0)} slot ${slot}`).toBe(true);
        sides++;
      });
    }
    expect(sides).toBeGreaterThan(0);
  });
});
