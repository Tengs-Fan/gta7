// Mission 3 buildings: PBR facades with recessed windows, sills, cornices and parapets, rooftop dressing, landmark
// towers, varied storefronts with interiors, night windows, and the batching and tier rules (VAL-BLD-001..011).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CityView, shopOccupancy } from '../../src/render/city';
import { DECOR_PROGRAM, FACADE_PROGRAM, createFacadeMaterial } from '../../src/render/city/facadeShader';
import { landmarkTowers } from '../../src/render/city/landmarks';
import { PARAPET_H, ROOF_ITEM_CLEARANCE, parapetThickness, rooftopItems, storeys } from '../../src/render/city/rooftops';
import { FRONT_REPEAT_DISTANCE, STOREFRONT_PROGRAM, storefrontPlan } from '../../src/render/city/storefronts';
import { awningDepth } from '../../src/render/city/buildings';
import { corniceProjection } from '../../src/render/cityArchitecture';
import { HARDWARE_CHUNK_SIZE } from '../../src/render/spatial';
import { assets } from '../../src/render/assets';
import { loadAssetsFromDisk, unloadAssets } from '../../src/render/assets/testing';
import { CELL_DESIGN, FACADE_LOOK, FACADE_WINDOW, LOBBY_GLASS, SHOP_DOOR_H, SHOPS, facadeMapIds } from '../../src/render/textures';
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
const ASSETS = resolve(process.cwd(), 'src/assets');

const meshes = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
};

/** A three standard-material shader as onBeforeCompile receives it. */
function standardShader(): THREE.WebGLProgramParametersWithUniforms {
  const lib = THREE.ShaderLib.standard;
  return { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
}

/** Mean of one channel of a WebP file under src/assets, 0..1. */
async function channelMean(file: string, channel: number): Promise<number> {
  const { data, info } = await sharp(resolve(ASSETS, file)).raw().toBuffer({ resolveWithObject: true });
  let s = 0;
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) s += data[i * info.channels + channel]!;
  return s / n / 255;
}

/** Buildings indexed by 32 m grid cell, for the per-vertex bounds checks. */
function buildingIndex(W: StaticWorld) {
  const cell = 32;
  const grid = new Map<string, number[]>();
  W.layout.buildings.forEach((b, i) => {
    for (let x = Math.floor((b.rect.minX - 3) / cell); x <= Math.floor((b.rect.maxX + 3) / cell); x++) {
      for (let z = Math.floor((b.rect.minZ - 3) / cell); z <= Math.floor((b.rect.maxZ + 3) / cell); z++) {
        const k = `${x},${z}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(i);
      }
    }
  });
  /** Whether (x, z) lies within `margin` of some building's footprint. */
  return (x: number, z: number, margin: number): boolean => {
    for (const i of grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []) {
      const r = W.layout.buildings[i]!.rect;
      if (x >= r.minX - margin && x <= r.maxX + margin && z >= r.minZ - margin && z <= r.maxZ + margin) return true;
    }
    return false;
  };
}

describe('m3 buildings: PBR facade materials (VAL-BLD-001)', () => {
  let W: StaticWorld;
  let city: CityView;

  beforeAll(async () => {
    unloadAssets();
    await loadAssetsFromDisk({ filter: (e) => e.kind === 'texture' });
    W = world();
    city = new CityView(W);
  });
  afterAll(() => unloadAssets());

  it('every style draws with a base colour, normal and ORM map from WebP sets in the manifest and the license table', () => {
    const licenses = readFileSync(resolve(process.cwd(), 'LICENSES-ASSETS.md'), 'utf8');
    const rows: string[] = [];
    for (const style of STYLES) {
      const m = city.materials.facades.get(style)!;
      const ids = facadeMapIds(style);
      for (const [tex, id] of [[m.map, ids.albedo], [m.normalMap, ids.normal], [m.roughnessMap, ids.orm]] as const) {
        expect(tex, `${style} ${id}`).toBeTruthy();
        expect(tex!.userData.assetId).toBe(id);
        const entry = assets.entry(id)!;
        expect(entry.file).toMatch(/^textures\/.+\.webp$/);
        expect(licenses).toContain(entry.license);
      }
      rows.push(`${style}: ${FACADE_LOOK[style].set}`);
    }
    console.log(`[VAL-BLD-001] facade maps per style: ${rows.join(', ')}`);
  });

  it('glass and wall roughness differ by at least 0.3 on every style', async () => {
    const rows: string[] = [];
    for (const style of STYLES) {
      const look = FACADE_LOOK[style];
      const wall = Math.min(1, look.roughness * (await channelMean(`textures/${look.set}/orm.webp`, 1)));
      const glass = look.glassRoughness;
      rows.push(`${style} wall ${wall.toFixed(2)} glass ${glass.toFixed(2)}`);
      expect(wall - glass, style).toBeGreaterThanOrEqual(0.3);
      // The glass reflects the scene's environment map: a standard material without its own envMap, smooth and partly metallic.
      expect(city.materials.facades.get(style)!.envMap).toBeNull();
    }
    console.log(`[VAL-BLD-001] roughness: ${rows.join('; ')}`);
  });

  it('the facade maps get anisotropy min(8, max) on High, 4 on Medium, 2 on Low and 1 in software, with no program change', () => {
    const m = city.materials.facades.get('office')!;
    const key = m.customProgramCacheKey();
    for (const [tier, max, want] of [['high', 16, 8], ['high', 4, 4], ['medium', 16, 4], ['low', 16, 2]] as const) {
      city.setQuality(tier, max);
      for (const t of [m.map!, m.normalMap!, m.roughnessMap!]) expect(t.anisotropy, `${tier} max ${max}`).toBe(want);
      expect(city.buildingU.parallax.value).toBe(tier === 'low' ? 0 : 1);
      expect(m.customProgramCacheKey()).toBe(key);
    }
    city.setQuality('high', 16, true);
    expect(m.map!.anisotropy).toBe(1);
    expect(city.buildingU.skyline.value).toBe(0);
    city.setQuality('high', 16, false);
    console.log('[VAL-BLD-001] anisotropy: high 8 (max 16), medium 4, low 2, software 1');
  });

  it('breaks up repetition with per-building tints: at least 4 tints of each common style downtown', () => {
    for (const style of ['office', 'glassBlue', 'glassTeal'] as const) {
      const mesh = city.group.getObjectByName(`facade-${style}`) as THREE.Mesh;
      const col = mesh.geometry.getAttribute('color');
      const tints = new Set<string>();
      for (let i = 0; i < col.count; i += 4) tints.add(`${col.getX(i).toFixed(3)},${col.getY(i).toFixed(3)},${col.getZ(i).toFixed(3)}`);
      expect(tints.size, style).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('m3 buildings: geometry (VAL-BLD-002..005, 010)', () => {
  let W: StaticWorld;
  let city: CityView;
  beforeAll(() => {
    W = world();
    city = new CityView(W);
  });

  it('recesses every window 0.08-0.5 m behind the wall in the compiled facade shader, with sills (VAL-BLD-002/003)', () => {
    const nu = { occupancy: { value: 0 }, time: { value: 0 } };
    const rows: string[] = [];
    for (const style of STYLES) {
      const w = FACADE_WINDOW[style];
      expect(w.depth, style).toBeGreaterThanOrEqual(0.08);
      expect(w.depth, style).toBeLessThanOrEqual(0.5);
      expect(w.sill, style).toBeGreaterThanOrEqual(0.04);
      const m = createFacadeMaterial(style, 1, nu, city.buildingU);
      const sh = standardShader();
      m.onBeforeCompile(sh, {} as THREE.WebGLRenderer);
      expect((sh.uniforms.uWinShape!.value as THREE.Vector4).x).toBe(w.depth);
      expect((sh.uniforms.uWinShape!.value as THREE.Vector4).y).toBe(w.sill);
      for (const piece of ['uWinShape', 'float tg = d / Vt.z', 'revN', 'directionalLights[0].direction', 'float sy = m0.y - sill', 'uParallax']) expect(sh.fragmentShader, `${style}: ${piece}`).toContain(piece);
      expect(sh.fragmentShader).not.toContain('#include <map_fragment>');
      expect(m.customProgramCacheKey()).toBe(FACADE_PROGRAM);
      rows.push(`${style} depth ${w.depth} sill ${w.sill}`);
    }
    console.log(`[VAL-BLD-002] reveal depth (parallax uniform): ${rows.join('; ')}`);
  });

  it('gives every building of 3+ storeys a parapet of at least 0.4 m on every side and a 0.15-0.6 m cornice (VAL-BLD-003)', () => {
    const roofs = city.group.getObjectByName('roofs') as THREE.Mesh;
    const trim = city.group.getObjectByName('architectural-trim') as THREE.Mesh;
    /** Every vertex of a mesh, to the millimetre. */
    const points = (m: THREE.Mesh): Set<string> => {
      const p = m.geometry.getAttribute('position');
      const out = new Set<string>();
      for (let i = 0; i < p.count; i++) out.add(`${Math.round(p.getX(i) * 1000)},${Math.round(p.getY(i) * 1000)},${Math.round(p.getZ(i) * 1000)}`);
      return out;
    };
    const R = points(roofs);
    const T = points(trim);
    /** Whether a vertex lies within a millimetre or two of (x, y, z) (positions are float32). */
    const has = (set: Set<string>, x: number, y: number, z: number): boolean => {
      const [X, Y, Z] = [x, y, z].map((v) => Math.round(v * 1000)) as [number, number, number];
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let c = -2; c <= 2; c++) if (set.has(`${X + a},${Y + b},${Z + c}`)) return true;
      return false;
    };
    let qualifying = 0;
    const failures: string[] = [];
    for (const b of W.layout.buildings) {
      if (storeys(b) < 3) continue;
      qualifying++;
      if (b.roof === 'gable') continue;
      const proj = corniceProjection(b);
      if (b.style !== 'house' && (proj < 0.15 || proj > 0.6)) failures.push(`${b.id} cornice ${proj}`);
      const t = b.tiers[b.tiers.length - 1]!;
      const top = t.y1 + PARAPET_H;
      const th = parapetThickness(t);
      // The far corners of the four parapet walls (N, S, W, E), at the parapet's top.
      const corners = [
        [t.minX, t.minZ], [t.maxX, t.minZ + th],
        [t.minX, t.maxZ - th], [t.maxX, t.maxZ],
        [t.minX, t.minZ + th], [t.minX + th, t.maxZ - th],
        [t.maxX - th, t.minZ + th], [t.maxX, t.maxZ - th],
      ] as const;
      corners.forEach(([x, z], k) => {
        if (!has(R, x, top, z)) failures.push(`${b.id} parapet ${'NSWE'[k >> 1]}`);
      });
      if (b.style === 'house') continue;
      // The crowning cornice: trim standing out by the projection just under the roof edge.
      if (!has(T, t.minX - proj, t.y1, t.minZ - proj) || !has(T, t.maxX + proj, t.y1, t.maxZ + proj)) failures.push(`${b.id} cornice geometry`);
    }
    console.log(`[VAL-BLD-003] qualifying buildings ${qualifying}, failures ${failures.length}`);
    expect(failures).toEqual([]);
    expect(PARAPET_H).toBeGreaterThanOrEqual(0.4);
  });

  it('keeps every projection off the road lanes and every wall plane on its footprint (VAL-BLD-003/010)', () => {
    const inside = buildingIndex(W);
    const lanes = [...W.layout.vLines, ...W.layout.hLines];
    // Strictly inside a line's width, on a road that exists (superblocks build over the streets they close).
    const onRoad = (x: number, z: number): boolean => W.isOnRoad(x, z) && lanes.some((l) => Math.abs((l.vertical ? x : z) - l.pos) < l.width / 2 - 1e-3);
    const check = (names: string[], margin: number) => {
      let n = 0;
      const bad: string[] = [];
      for (const m of meshes(city.group).filter((o) => names.some((s) => o.name.startsWith(s)))) {
        const p = m.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i);
          const z = p.getZ(i);
          n++;
          if (!inside(x, z, margin) && bad.length < 5) bad.push(`${m.name} ${x.toFixed(2)},${z.toFixed(2)}`);
          if (onRoad(x, z) && bad.length < 5) bad.push(`${m.name} on road ${x.toFixed(2)},${z.toFixed(2)}`);
        }
      }
      return { n, bad };
    };
    const walls = check(['facade-', 'storefronts'], 0.05);
    const trim = check(['architectural-trim', 'roofs'], 0.6);
    const decor = check(['ground-decor'], 2.5);
    console.log(`[VAL-BLD-010] wall vertices ${walls.n} (0.05 m), trim/roof ${trim.n} (0.6 m), decor ${decor.n} (2.5 m); failures ${walls.bad.length + trim.bad.length + decor.bad.length}`);
    expect([...walls.bad, ...trim.bad, ...decor.bad]).toEqual([]);
    expect(awningDepth(0)).toBeGreaterThanOrEqual(0.6);
    expect(awningDepth(100)).toBeLessThanOrEqual(2.5);
  });

  it('dresses at least 70% of the roofs of 4+ storey buildings, with 3+ kinds, inside the parapets and on the roof (VAL-BLD-004)', () => {
    const lm = new Set(landmarkTowers(W.layout).map((l) => l.id));
    let tall = 0;
    let dressed = 0;
    const kinds = new Set<string>();
    const bad: string[] = [];
    let items = 0;
    for (const b of W.layout.buildings) {
      const its = rooftopItems(b, lm.has(b.id));
      items += its.length;
      const t = b.tiers[b.tiers.length - 1]!;
      const inset = parapetThickness(t) + 0.2;
      for (const it of its) {
        kinds.add(it.kind);
        // Stair housings' roof slab overhangs their walls by 0.08 m (still clear of the parapet: see ROOF_ITEM_CLEARANCE).
        const o = it.kind === 'stair' ? 0.08 : 0;
        if (it.minX - o < t.minX + inset || it.maxX + o > t.maxX - inset || it.minZ - o < t.minZ + inset || it.maxZ + o > t.maxZ - inset) bad.push(`${b.id} ${it.kind}`);
        if (Math.abs(it.y0 - t.y1) > 1e-9) bad.push(`${b.id} ${it.kind} floats`);
      }
      if (storeys(b) < 4) continue;
      tall++;
      if (its.length > 0 || b.roofProps.length > 0 || lm.has(b.id)) dressed++;
    }
    const mine = W.layout.buildings.filter((b) => storeys(b) >= 4 && rooftopItems(b, lm.has(b.id)).length > 0).length;
    console.log(`[VAL-BLD-004] 4+ storey buildings ${tall}, dressed ${dressed} (${((dressed / tall) * 100).toFixed(1)}%; new items alone ${((mine / tall) * 100).toFixed(1)}%), items ${items}, kinds ${[...kinds].sort().join(',')}, containment failures ${bad.length}`);
    expect(dressed / tall).toBeGreaterThanOrEqual(0.7);
    expect(mine / tall).toBeGreaterThanOrEqual(0.7);
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    expect(bad).toEqual([]);
    expect(ROOF_ITEM_CLEARANCE - 0.08).toBeGreaterThanOrEqual(0.2);
    // Merged into the trim batch: no mesh of their own.
    const names = new Set(meshes(city.group).map((m) => m.name));
    for (const k of kinds) expect(names.has(k)).toBe(false);
    expect(meshes(city.group).filter((m) => m.name === 'architectural-trim').length).toBe(1);
  });

  it('crowns at least three landmark towers with distinct silhouettes, two among the tallest 10% (VAL-BLD-005)', () => {
    const lms = landmarkTowers(W.layout);
    const heights = W.layout.buildings.map((b) => b.height).sort((a, b) => b - a);
    const p90 = heights[Math.floor(heights.length * 0.1)]!;
    const rows = lms.map((l) => {
      const b = W.layout.buildings[l.id]!;
      const spire = l.spire >= 8;
      const stepped = l.setbacks.length >= 2 && l.setbacks.every((s) => s >= 0.15);
      const taper = l.taper90 <= 0.8;
      expect(spire || stepped || taper, `landmark ${l.id}`).toBe(true);
      expect(b.district === 'downtown' || b.district === 'midtown').toBe(true);
      return `${l.id} ${l.kind} ${b.height.toFixed(1)} m -> top ${l.top.toFixed(1)} m, spire ${l.spire} m, setbacks [${l.setbacks.map((s) => s.toFixed(2)).join(',')}], taper90 ${l.taper90.toFixed(2)}`;
    });
    console.log(`[VAL-BLD-005] landmarks:\n  ${rows.join('\n  ')}`);
    expect(lms.length).toBeGreaterThanOrEqual(3);
    expect(new Set(lms.map((l) => l.kind)).size).toBe(lms.length);
    expect(lms.filter((l) => W.layout.buildings[l.id]!.height >= p90).length).toBeGreaterThanOrEqual(2);
    // Seen from the sea (sight lines run west, along x) no crown stands in line with another or behind a nearer tower
    // that reaches within 4 m of its roof over half its breadth.
    const lmB = lms.map((l) => W.layout.buildings[l.id]!);
    const cz = (b: (typeof lmB)[number]) => (b.rect.minZ + b.rect.maxZ) / 2;
    for (let i = 0; i < lmB.length; i++) {
      for (let j = i + 1; j < lmB.length; j++) expect(Math.abs(cz(lmB[i]!) - cz(lmB[j]!)), `landmarks ${lmB[i]!.id}/${lmB[j]!.id}`).toBeGreaterThanOrEqual(45);
      const b = lmB[i]!;
      const blockers = W.layout.buildings.filter((o) => o !== b && o.rect.minX > b.rect.maxX && o.height >= b.height - 4 && Math.min(o.rect.maxZ, b.rect.maxZ) - Math.max(o.rect.minZ, b.rect.minZ) > 0.5 * (b.rect.maxZ - b.rect.minZ));
      expect(blockers.map((o) => o.id), `towers in front of landmark ${b.id} from the sea`).toEqual([]);
    }
  });

  it('leaves building footprints, heights, tiers and the colliders as at d98da7b (VAL-BLD-010)', () => {
    const b = createHash('sha256').update(JSON.stringify(W.layout.buildings.map((x) => ({ id: x.id, rect: x.rect, height: x.height, tiers: x.tiers })))).digest('hex');
    const c = createHash('sha256').update(JSON.stringify(W.grid.colliders.map((x) => ({ ...x })))).digest('hex');
    console.log(`[VAL-BLD-010] buildings ${b}, colliders ${c}`);
    // Captured at d98da7b with the same canonical JSON (tsx over a d98da7b export).
    expect(b).toBe('cd8204d3458b2ced8ceab653abe1407dd52c9bef7e3251b970aa981b864569bc');
    expect(c).toBe('2bb5c9f0c855d6f0768ccb539b216b364350a713f707b4e77d27d27cfc3a55fa');
  });
});

describe('m3 buildings: storefronts (VAL-BLD-006/007)', () => {
  let W: StaticWorld;
  let city: CityView;
  beforeAll(() => {
    W = world();
    city = new CityView(W);
  });

  it('draws a shop door leaf 2.0-2.5 m tall on every shop band (VAL-V3X-005)', () => {
    // The shop cell is drawn for a CELL_DESIGN.shop.h band and stretched over the building's own band height.
    const bands = W.layout.buildings.filter((b) => b.ground === 'shops').map((b) => b.groundH);
    expect(bands.length).toBeGreaterThan(100);
    const leaf = (h: number) => (SHOP_DOOR_H * h) / CELL_DESIGN.shop.h;
    console.log(`[buildings] shop door leaf ${leaf(Math.min(...bands)).toFixed(2)}-${leaf(Math.max(...bands)).toFixed(2)} m over ${bands.length} shop bands`);
    for (const h of bands) {
      expect(leaf(h)).toBeGreaterThanOrEqual(2.0);
      expect(leaf(h)).toBeLessThanOrEqual(2.5);
    }
  });

  it('uses 12+ designs with no identical front within 40 m and no shop twice in a row, deterministically', () => {
    const plan = storefrontPlan(W.layout);
    const designs = new Set(plan.map((f) => `${f.shop}|${f.awning}|${f.color}`));
    let identical = 0;
    let adjacent = 0;
    for (let i = 0; i < plan.length; i++) {
      const a = plan[i]!;
      for (let j = i + 1; j < plan.length; j++) {
        const b = plan[j]!;
        if (Math.hypot(a.x - b.x, a.z - b.z) > FRONT_REPEAT_DISTANCE) continue;
        if (a.shop === b.shop && a.awning === b.awning && a.color === b.color) identical++;
      }
      const next = plan[i + 1];
      if (next && next.building === a.building && next.side === a.side && next.index === a.index + 1 && next.shop === a.shop) adjacent++;
    }
    console.log(`[VAL-BLD-006] shop frontages ${plan.length}, designs ${designs.size}, shops used ${new Set(plan.map((f) => f.shop)).size}/${SHOPS.length}, identical pairs within 40 m ${identical}, adjacent repeats ${adjacent}`);
    expect(designs.size).toBeGreaterThanOrEqual(12);
    expect(identical).toBe(0);
    expect(adjacent).toBe(0);
    expect(storefrontPlan(W.layout)).toEqual(plan);
    // Every planned front is drawn.
    expect(city.storefronts.size).toBe(plan.length);
  });

  it('cycles the three lobby glass designs (no painted planters), with 3D planters in front', () => {
    expect(new Set(LOBBY_GLASS).size).toBe(3);
    const src = readFileSync(resolve(process.cwd(), 'src/render/textures/storefront.ts'), 'utf8');
    expect(src).not.toMatch(/function plant\(/);
    const decor = city.group.getObjectByName('ground-decor') as THREE.Mesh;
    const col = decor.geometry.getAttribute('color');
    let green = 0;
    for (let i = 0; i < col.count; i += 4) if (col.getY(i) > col.getX(i) * 1.6 && col.getY(i) > col.getZ(i) * 1.6) green++;
    expect(green).toBeGreaterThan(500);
  });

  it('lights 40-95% of the shops at 22:30, from the per-frontage seeds, and shows rooms behind the glass', () => {
    const front = city.group.getObjectByName('storefronts') as THREE.Mesh;
    const seed = front.geometry.getAttribute('aSeed');
    const occ = shopOccupancy(22.5);
    let shops = 0;
    let lit = 0;
    for (let i = 0; i < seed.count; i += 4) {
      const s = seed.getX(i);
      if (Math.floor(s) !== 0) continue;
      shops++;
      if (s - Math.floor(s) <= occ) lit++;
    }
    console.log(`[VAL-BLD-007] uShopOcc(22:30) ${occ.toFixed(3)}, shop quads ${shops}, lit ${lit} (${((lit / shops) * 100).toFixed(1)}%)`);
    expect(lit / shops).toBeGreaterThanOrEqual(0.4);
    expect(lit / shops).toBeLessThanOrEqual(0.95);
    const m = city.materials.storefront!;
    const sh = standardShader();
    m.onBeforeCompile(sh, {} as THREE.WebGLRenderer);
    for (const piece of ['uIntMap', 'float tb = D / Vt.z', 'uShopOcc', 'uParallax']) expect(sh.fragmentShader).toContain(piece);
    expect(m.customProgramCacheKey()).toBe(STOREFRONT_PROGRAM);
  });
});

describe('m3 buildings: batching (VAL-BLD-011)', () => {
  it('keeps the city in its 256 m cells within 1.5x the d98da7b mesh count (174), with no per-item meshes', () => {
    const coarse = new CityView(world(), HARDWARE_CHUNK_SIZE);
    const all = meshes(coarse.group);
    const names = new Map<string, number>();
    for (const m of all) names.set(m.name, (names.get(m.name) ?? 0) + 1);
    console.log(`[VAL-BLD-011] city meshes ${all.length} (limit ${Math.floor(174 * 1.5)}): ${[...names].map(([n, c]) => `${n} ${c}`).join(', ')}`);
    expect(all.length).toBeLessThanOrEqual(Math.floor(174 * 1.5));
    for (const n of names.keys()) expect(['hvac', 'stair', 'tank', 'vent', 'antenna', 'garden', 'awning', 'planter', 'landmark']).not.toContain(n);
  });

  it("draws the stunt ramp sides with the street decor program (three's own fog), so no program of theirs compiles when a ramp first comes into view at night", () => {
    // At d98da7b the ramp sides shared the plain decor program, compiled as soon as any street was in view. With a
    // program of their own they compiled in the frame a ramp first came into view under the night lights (+9 ms).
    const c = new CityView(world(), HARDWARE_CHUNK_SIZE);
    const mat = (name: string) => (c.group.getObjectByName(name) as THREE.Mesh).material as THREE.MeshStandardMaterial;
    const sides = mat('ramp-sides');
    const decor = mat('ground-decor');
    expect(sides.customProgramCacheKey()).toBe(DECOR_PROGRAM);
    expect(decor.customProgramCacheKey()).toBe(DECOR_PROGRAM);
    for (const k of ['vertexColors', 'side', 'map', 'transparent', 'alphaTest', 'flatShading'] as const) expect(sides[k], k).toEqual(decor[k]);
    const a = standardShader();
    const b = standardShader();
    sides.onBeforeCompile(a, {} as THREE.WebGLRenderer);
    decor.onBeforeCompile(b, {} as THREE.WebGLRenderer);
    expect(a.vertexShader).toBe(b.vertexShader);
    expect(a.fragmentShader).toBe(b.fragmentShader);
    expect((a.uniforms.uSkyline as { value: number }).value).toBe(0);
    expect((b.uniforms.uSkyline as { value: number }).value).toBe(1);
  });
});
