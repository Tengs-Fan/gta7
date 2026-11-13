// The buildings' detail where a player looks: plaster walls that keep their grain but little of their stains, doorways
// set back behind the ground-floor fronts, piers between the bays, the houses' gables, chimneys and shutters, the
// hotels' and apartment blocks' balconies, the brick blocks' fire escapes and the parapets' coping. All of it is
// render geometry in the existing batches (m3_buildings caps the city's meshes): no collider or footprint of its own.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CityView } from '../../src/render/city';
import { createFacadeMaterial } from '../../src/render/city/facadeShader';
import { BALCONY_DEPTH, ESCAPE_DEPTH, LADDER_DROP, balconies, fireEscape, houseShutters } from '../../src/render/cityArchitecture';
import { GeoBuilder } from '../../src/render/geo';
import { CELL_DESIGN, CELLS, DOOR_OPENING, DOOR_U, FACADE_LOOK, SHOP_AWNING_TOP } from '../../src/render/textures';
import { CURB_H } from '../../src/world/constants';
import type { FacadeStyle } from '../../src/world/layout';
import type { StaticWorld } from '../../src/world/staticWorld';
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

const STYLES: FacadeStyle[] = ['glassBlue', 'glassTeal', 'office', 'brick', 'stucco', 'house', 'warehouse', 'hotel'];

const meshes = (root: THREE.Object3D, name?: string): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && (!name || o.name === name)) out.push(o);
  });
  return out;
};

describe('building detail', () => {
  let W: StaticWorld;
  let city: CityView;
  beforeAll(() => {
    W = world();
    city = new CityView(W);
  });

  it("keeps at most 0.3 of the plaster's stains on the walls that use it, and the compiled facade divides them out", () => {
    for (const s of STYLES) {
      const look = FACADE_LOOK[s];
      expect(look.stain, s).toBeGreaterThanOrEqual(0);
      expect(look.stain, s).toBeLessThanOrEqual(1);
      if (look.set === 'white_plaster_02') expect(look.stain, s).toBeLessThanOrEqual(0.3);
    }
    const m = createFacadeMaterial('house', 1, { occupancy: { value: 0 }, time: { value: 0 } }, city.buildingU);
    const lib = THREE.ShaderLib.standard;
    const sh = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(sh, {} as THREE.WebGLRenderer);
    expect(sh.fragmentShader).toContain('textureLod(map, wuv');
    expect((sh.uniforms.uWallStain as { value: number }).value).toBe(FACADE_LOOK.house.stain);
  });

  it('sets every door back 0.1-0.7 m inside its cell, the revolving drum flush', () => {
    for (const [cell, u] of Object.entries(DOOR_U)) {
      const o = DOOR_OPENING[Number(cell)];
      if (Number(cell) === CELLS.lobbyRevolving) {
        expect(o).toBeUndefined();
        continue;
      }
      expect(o, `cell ${cell}`).toBeDefined();
      const design = Number(cell) < CELLS.lobbyRevolving ? CELL_DESIGN.shop : Number(cell) === CELLS.houseDoorA || Number(cell) === CELLS.houseDoorB ? CELL_DESIGN.house : CELL_DESIGN.lobby;
      expect(o!.x0).toBeGreaterThan(0.3);
      expect(o!.x1).toBeLessThan(design.w - 0.3);
      expect(o!.y1).toBeLessThan(design.h);
      expect(o!.depth).toBeGreaterThanOrEqual(0.1);
      expect(o!.depth).toBeLessThanOrEqual(0.7);
      // The door it opens round is the one DOOR_U names.
      expect(Math.abs((o!.x0 + o!.x1) / 2 / design.w - u)).toBeLessThan(0.01);
    }
  });

  it('draws the doorways behind the frontage plane: storefront vertices inside a footprint by no more than the deepest door', () => {
    const deepest = Math.max(...Object.values(DOOR_OPENING).map((o) => o.depth));
    const p = meshes(city.group, 'storefronts')[0]!.geometry.getAttribute('position');
    let set = 0;
    const bad: string[] = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      for (const b of W.layout.buildings) {
        const r = b.rect;
        if (x <= r.minX || x >= r.maxX || z <= r.minZ || z >= r.maxZ) continue;
        const inside = Math.min(x - r.minX, r.maxX - x, z - r.minZ, r.maxZ - z);
        if (inside > 0.05) set++;
        if (inside > deepest + 1e-3 && bad.length < 5) bad.push(`${b.id} ${x.toFixed(2)},${z.toFixed(2)} ${inside.toFixed(2)}`);
      }
    }
    console.log(`[buildings] storefront vertices set back ${set}`);
    expect(bad).toEqual([]);
    expect(set).toBeGreaterThan(4000);
  });

  it('gives every new face of the trim, decor, roofs and fronts a unit normal (a zero one lights as NaN and blanks the frame)', () => {
    for (const name of ['architectural-trim', 'ground-decor', 'roofs', 'storefronts']) {
      for (const m of meshes(city.group, name)) {
        const n = m.geometry.getAttribute('normal');
        let bad = 0;
        for (let i = 0; i < n.count; i++) if (Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) > 1e-3) bad++;
        expect(bad, name).toBe(0);
      }
    }
  });

  it("puts balconies on every hotel's street walls, within their depth of the wall and above the ground floor", () => {
    let hotels = 0;
    let apartments = 0;
    for (const b of W.layout.buildings) {
      if ((b.style !== 'hotel' && b.style !== 'stucco') || b.groundSides.length === 0) continue;
      const baseY = CURB_H + b.groundH;
      for (const t of b.tiers) {
        const g = new GeoBuilder(true);
        const n = balconies(g, b, t, baseY, b.groundSides, [1, 1, 1], b.style === 'hotel' ? 1 : 2);
        if (b.style === 'hotel') hotels += n;
        else apartments += n;
        const p = g.build().getAttribute('position');
        const depth = BALCONY_DEPTH[b.style]!;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i);
          const z = p.getZ(i);
          const out = Math.max(t.minX - x, x - t.maxX, t.minZ - z, z - t.maxZ);
          expect(out).toBeLessThanOrEqual(depth + 1e-4);
          expect(p.getY(i)).toBeGreaterThan(baseY + 2);
        }
      }
    }
    console.log(`[buildings] hotel balconies ${hotels}, apartment balconies (every other window) ${apartments}`);
    expect(hotels).toBeGreaterThan(100);
    expect(apartments).toBeGreaterThan(200);
  });

  it("hangs every fire escape's drop ladder at least 2.4 m over the pavement, clear of the shop awnings, and keeps it within its landing's depth", () => {
    // An awning's top is SHOP_AWNING_TOP under the top of a 4.5 m shop band; the lowest landing stands 0.12 m over it.
    expect(LADDER_DROP - 0.12).toBeLessThan(SHOP_AWNING_TOP);
    let escapes = 0;
    for (const b of W.layout.buildings) {
      if (b.style !== 'brick' || b.groundSides.length === 0) continue;
      const t = b.tiers[0]!;
      const g = new GeoBuilder(true);
      if (fireEscape(g, b, t, CURB_H + b.groundH, b.groundSides) === 0) continue;
      escapes++;
      const p = g.build().getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        expect(p.getY(i) - CURB_H, `building ${b.id}`).toBeGreaterThanOrEqual(2.4);
        const out = Math.max(t.minX - p.getX(i), p.getX(i) - t.maxX, t.minZ - p.getZ(i), p.getZ(i) - t.maxZ);
        expect(out).toBeLessThanOrEqual(ESCAPE_DEPTH + 1e-4);
      }
    }
    console.log(`[buildings] brick blocks that could take a fire escape ${escapes}`);
    expect(escapes).toBeGreaterThan(50);
  });

  it("shutters the houses' upper windows, never in a street wall's ground floor or under the eaves", () => {
    let n = 0;
    for (const b of W.layout.buildings) {
      if (b.style !== 'house' || b.district === 'country') continue;
      const baseY = CURB_H + (b.groundSides.length > 0 ? b.groundH : 0);
      for (const t of b.tiers) {
        const g = new GeoBuilder(true);
        n += houseShutters(g, t, baseY, b.groundSides, 0, 0);
        const p = g.build().getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          expect(p.getY(i)).toBeLessThanOrEqual(t.y1 - 0.2 + 1e-6);
          expect(p.getY(i)).toBeGreaterThanOrEqual(t.y0 + 0.35 - 1e-6);
        }
      }
    }
    console.log(`[buildings] shuttered house windows ${n}`);
    expect(n).toBeGreaterThan(150);
  });
});
