// Las Lomas County on the map and in the 3D view: MapImage fills its land and beaches and strokes its roads by kind, and
// keeps the gang turf to the city's rectangle; CountryView draws its ground, roads and the Southgate Bridge's arch in
// cells it hides past the fog.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { CountryView } from '../../src/render/country';
import { COUNTRY_CELL, COUNTRY_FOG_MARGIN } from '../../src/render/quality';
import { MapImage, MAP_SCALE } from '../../src/ui/mapRender';
import { BRIDGE_ARCH } from '../../src/world/country';
import { world } from './helpers';

/** What the recording 2D context drew, in order: rectangles, filled paths' boxes, and stroked polylines. */
type Op = { kind: 'rect'; x: number; y: number; w: number; h: number; style: string } | { kind: 'line'; pts: number[]; width: number; style: string };

const drawn = vi.hoisted(() => new Map<object, Op[]>());

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const recorder = (ops: Op[]): unknown => {
    let path: number[] = [];
    let box: [number, number, number, number] | null = null;
    const state: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1 };
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: (x: number, y: number, w: number, h: number) => ops.push({ kind: 'rect', x, y, w, h, style: String(state.fillStyle) }),
      beginPath: () => {
        path = [];
        box = null;
      },
      moveTo: (x: number, y: number) => path.push(NaN, NaN, x, y),
      lineTo: (x: number, y: number) => path.push(x, y),
      roundRect: (x: number, y: number, w: number, h: number) => (box = [x, y, w, h]),
      fill: () => {
        if (box) ops.push({ kind: 'rect', x: box[0], y: box[1], w: box[2], h: box[3], style: String(state.fillStyle) });
      },
      stroke: () => ops.push({ kind: 'line', pts: path, width: Number(state.lineWidth), style: String(state.strokeStyle) }),
    };
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : k in state ? state[k as string] : () => {}),
      set: (_o, k, v) => {
        state[k as string] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => {
    const ops: Op[] = [];
    const c: Record<string, unknown> = { width: 300, height: 150, clientWidth: 1280, clientHeight: 720, style: {}, addEventListener: () => {}, removeEventListener: () => {} };
    c.getContext = (kind: string) => {
      if (kind !== '2d') return null;
      drawn.set(c, ops);
      return recorder(ops);
    };
    return c;
  };
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

const W = world();
const b = W.layout.bounds;

/** The colour last painted over pixel (px, py) of a canvas: by its rectangles and its strokes. */
function colorAt(canvas: object, px: number, py: number): string {
  let out = '';
  for (const op of drawn.get(canvas)!) {
    if (op.kind === 'rect') {
      if (px >= op.x && px <= op.x + op.w && py >= op.y && py <= op.y + op.h) out = op.style;
      continue;
    }
    for (let k = 2; k + 1 < op.pts.length; k += 2) {
      const ax = op.pts[k - 2]!;
      const ay = op.pts[k - 1]!;
      const bx = op.pts[k]!;
      const by = op.pts[k + 1]!;
      if (Number.isNaN(ax) || Number.isNaN(bx)) continue;
      const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
      if (Math.hypot(px - ax - (bx - ax) * t, py - ay - (by - ay) * t) <= op.width / 2) out = op.style;
    }
  }
  return out;
}

describe('the map of Las Lomas County', () => {
  const map = new MapImage(W);
  const at = (x: number, z: number) => colorAt(map.canvas, (x - map.minX) * MAP_SCALE, (z - map.minZ) * MAP_SCALE);

  it('spans the world out past the county, and keeps the turf canvas to the city', () => {
    expect([map.canvas.width, map.canvas.height]).toEqual([b.worldMaxX - b.worldMinX, b.worldMaxZ - b.worldMinZ]);
    expect([map.turf.width, map.turf.height]).toEqual([b.cityMaxX - b.cityMinX, b.cityMaxZ - b.cityMinZ]);
    expect([map.turfX, map.turfZ]).toEqual([b.cityMinX - b.worldMinX, b.cityMinZ - b.worldMinZ]);
  });

  it('fills its land, plots and beach, and leaves the sound the sea', () => {
    expect(at(-1250, -300)).toBe('#33503a');
    expect(at(-970, -60)).toBe('#3b5c39');
    expect(at(-840, -250)).not.toBe('#33503a');
    expect(at(-696, -100)).toBe('#cdb77d');
    expect(at(-600, 0)).toBe('#16384f');
    expect(at(-1700, 0)).toBe('#16384f');
  });

  it('strokes its highway and its country roads at their widths, over the causeway and the bridge', () => {
    expect(at(-1330, 0)).toBe('#b0a46a');
    expect(at(-1330 + 7.5, 0)).toBe('#b0a46a');
    expect(at(-1330 + 9, 0)).not.toBe('#b0a46a');
    expect(at(-840, -330)).toBe('#9aa1aa');
    expect(at(-600, -268)).toBe('#b0a46a');
    expect(at(-600, 268)).toBe('#b0a46a');
  });
});

describe('drawing Las Lomas County', () => {
  const city = new CityView(W);
  const view = new CountryView(W, city);
  const meshes = view.group.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  const tris = (m: THREE.Mesh) => (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;

  it('draws its ground, roads, paint and the bridge\'s arch, the beaches cell by cell and the thin layers one mesh each', () => {
    const names = new Set(meshes.map((m) => m.name));
    for (const n of ['country-grass', 'country-sand', 'country-roads', 'country-markings-white', 'country-markings-yellow', 'bridge-arch']) expect(names.has(n), n).toBe(true);
    for (const n of ['country-grass', 'country-roads', 'country-markings-white', 'country-markings-yellow', 'bridge-arch']) expect(meshes.filter((m) => m.name === n).length, n).toBe(1);
    expect(meshes.filter((m) => m.name === 'country-sand').length).toBeGreaterThan(10);
    for (const m of meshes) {
      if (m.name !== 'country-sand') continue;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      // Each cell's mesh stays in its cell, but for a stretch of road (its half width and its mitre round a bend) over its edge.
      for (const [lo, hi] of [[bb.min.x, bb.max.x], [bb.min.z, bb.max.z]] as const) {
        const cell = Math.floor((lo + hi) / 2 / COUNTRY_CELL) * COUNTRY_CELL;
        expect(lo, m.name).toBeGreaterThan(cell - 20);
        expect(hi, m.name).toBeLessThan(cell + COUNTRY_CELL + 20);
      }
    }
    console.log(`[map_render] county: ${meshes.length} meshes, ${meshes.reduce((s, m) => s + tris(m), 0)} triangles`);
  });

  it('hides each cell past the fog\'s far end and the margin, on every tier alike', () => {
    view.cull(0, 0, 780);
    const shown = meshes.filter((m) => m.visible);
    for (const m of meshes) {
      const bb = new THREE.Box3().setFromObject(m);
      const d = Math.hypot(Math.max(bb.min.x, 0, -bb.max.x), Math.max(bb.min.z, 0, -bb.max.z));
      expect(m.visible, m.name).toBe(d <= 780 + COUNTRY_FOG_MARGIN);
    }
    expect(shown.length).toBeLessThan(meshes.length);
    view.cull(-1000, 0, 780);
    expect(meshes.every((m) => m.visible)).toBe(true);
  });

  it('stands the arch on the posts the sim makes solid', () => {
    const posts = W.grid.colliders.filter((c) => c.tag === 'pillar' && c.circle && c.cx >= BRIDGE_ARCH.x0 - 1 && c.cx <= BRIDGE_ARCH.x1 + 1 && c.cz > 250 && c.cz < 290);
    expect(posts.map((c) => [c.cx, c.cz]).sort()).toEqual([[BRIDGE_ARCH.x0, BRIDGE_ARCH.ribs[0]], [BRIDGE_ARCH.x0, BRIDGE_ARCH.ribs[1]], [BRIDGE_ARCH.x1, BRIDGE_ARCH.ribs[0]], [BRIDGE_ARCH.x1, BRIDGE_ARCH.ribs[1]]].sort());
    const arch = meshes.find((m) => m.name === 'bridge-arch')!;
    arch.geometry.computeBoundingBox();
    expect(arch.geometry.boundingBox!.max.y).toBeCloseTo(BRIDGE_ARCH.rise + 0.6, 0);
    expect(arch.castShadow).toBe(true);
  });
});
