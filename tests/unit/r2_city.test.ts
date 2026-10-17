// Round 2 city look: street-level ground floors, living night windows, the sky and a stable
// environment map. The render modules run headless: the stub header below is copied from
// fix_render.test.ts (a tiny canvas/document stub and a fake WebGLRenderer), with the few extra
// renderer methods that three's CubeCamera and PMREMGenerator call so the real environment bake runs.

import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CityView, occupancy, shopOccupancy } from '../../src/render/city';
import { cloudFbm, cloudNoiseData, storefrontUv } from '../../src/render/textures';
import { CLOUD_SD, Environment, cloudCover, cloudThreshold, starIntensity } from '../../src/render/environment';
import { GameRenderer } from '../../src/render/renderer';
import { CURB_H } from '../../src/world/constants';
import { frontages, generateCity, rectCX, rectCZ, type Building, type Side } from '../../src/world/layout';
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
    // Every other 2D call is a no-op; property writes are kept.
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

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    // What CubeCamera.update and PMREMGenerator.fromCubemap touch (rendering itself is a no-op).
    readonly xr = { enabled: false };
    readonly coordinateSystem = actual.WebGLCoordinateSystem;
    autoClear = true;
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    private target: unknown = null;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas;
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    getRenderTarget(): unknown {
      return this.target;
    }
    setRenderTarget(t: unknown): void {
      this.target = t;
    }
    getActiveCubeFace(): number {
      return 0;
    }
    getActiveMipmapLevel(): number {
      return 0;
    }
    setEffects(): void {}
    compile(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

/** The plan's street-facing distance: a first-tier wall this close to its lot edge faces the street. */
const STREET_FACING_DIST = 10;

/** SHA-256 of the generated layout without the fields this round added to Building. */
function layoutHash(): string {
  const L = generateCity();
  const buildings = L.buildings.map((b) => {
    const r: Record<string, unknown> = { ...b };
    delete r.special;
    delete r.ground;
    delete r.groundH;
    delete r.groundSides;
    return r;
  });
  return createHash('sha256').update(JSON.stringify({ ...L, buildings })).digest('hex');
}

interface Wall {
  b: Building;
  side: Side;
  /** 'x' for walls in a plane of constant x (E/W), 'z' for N/S. */
  axis: 'x' | 'z';
  coord: number;
  /** +1 when the outward normal points along +axis. */
  sign: 1 | -1;
  lo: number;
  hi: number;
}

function wallOf(b: Building, side: Side): Wall {
  const t = b.tiers[0]!;
  switch (side) {
    case 'N':
      return { b, side, axis: 'z', coord: t.minZ, sign: -1, lo: t.minX, hi: t.maxX };
    case 'S':
      return { b, side, axis: 'z', coord: t.maxZ, sign: 1, lo: t.minX, hi: t.maxX };
    case 'W':
      return { b, side, axis: 'x', coord: t.minX, sign: -1, lo: t.minZ, hi: t.maxZ };
    case 'E':
      return { b, side, axis: 'x', coord: t.maxX, sign: 1, lo: t.minZ, hi: t.maxZ };
  }
}

/** Every first-tier wall within STREET_FACING_DIST of its lot edge, computed here from scratch. */
function streetWalls(W: StaticWorld): Wall[] {
  const out: Wall[] = [];
  for (const b of W.layout.buildings) {
    const t = b.tiers[0]!;
    const lot = W.layout.blocks.find((bl) => bl.lot.minX <= t.minX && bl.lot.maxX >= t.maxX && bl.lot.minZ <= t.minZ && bl.lot.maxZ >= t.maxZ)!.lot;
    if (t.minZ - lot.minZ <= STREET_FACING_DIST) out.push(wallOf(b, 'N'));
    if (lot.maxZ - t.maxZ <= STREET_FACING_DIST) out.push(wallOf(b, 'S'));
    if (t.minX - lot.minX <= STREET_FACING_DIST) out.push(wallOf(b, 'W'));
    if (lot.maxX - t.maxX <= STREET_FACING_DIST) out.push(wallOf(b, 'E'));
  }
  return out;
}

interface Tri {
  axis: 'x' | 'z' | null;
  coord: number;
  sign: number;
  lo: number;
  hi: number;
  minY: number;
  maxY: number;
}

/** Triangles of a mesh that stand in a plane of constant x or z, with their extent. */
function verticalTris(mesh: THREE.Mesh): Tri[] {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const idx = g.getIndex()!;
  const out: Tri[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const v = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
    const xs = v.map((k) => pos.getX(k));
    const ys = v.map((k) => pos.getY(k));
    const zs = v.map((k) => pos.getZ(k));
    const nx = nrm.getX(v[0]!);
    const nz = nrm.getZ(v[0]!);
    let axis: 'x' | 'z' | null = null;
    if (Math.abs(nx) > 0.99) axis = 'x';
    else if (Math.abs(nz) > 0.99) axis = 'z';
    if (!axis) continue;
    const along = axis === 'x' ? zs : xs;
    out.push({
      axis,
      coord: axis === 'x' ? xs[0]! : zs[0]!,
      sign: Math.sign(axis === 'x' ? nx : nz),
      lo: Math.min(...along),
      hi: Math.max(...along),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    });
  }
  return out;
}

/** Triangles lying on a wall's plane, facing out with it, and overlapping its span. */
function onWall(tris: Tri[], w: Wall, eps = 1e-3): Tri[] {
  return tris.filter((t) => t.axis === w.axis && t.sign === w.sign && Math.abs(t.coord - w.coord) < eps && t.hi > w.lo + eps && t.lo < w.hi - eps);
}

describe('round 2 city: layout', () => {
  it('ground floors leave the generated layout bit-identical to the base commit', () => {
    // Captured on 8788242 (round 2 base) with the same canonical JSON.
    expect(layoutHash()).toBe('845117c784a8f32c1b1d3d2dea4648ac91e109e2c016e07e1473fc5199b3215c');
  });

  it('assigns a ground floor to every building with street frontage, by district and kind', () => {
    const L = generateCity();
    const front = frontages(L);
    const kinds = new Set<string>();
    for (const b of L.buildings) {
      const f = front.get(b)!;
      expect(f, `building ${b.id} has a block`).toBeTruthy();
      expect(b.groundSides).toEqual(f.sides);
      if (f.sides.length === 0) {
        expect(b.ground).toBe('none');
        expect(b.groundH).toBe(0);
        continue;
      }
      expect(b.ground).not.toBe('none');
      expect(b.groundH).toBeGreaterThan(2.5);
      expect(b.groundH).toBeLessThanOrEqual(7);
      // Always a real storey above the band.
      expect(b.tiers[0]!.y1 - CURB_H - b.groundH).toBeGreaterThan(2);
      kinds.add(b.ground);
      if (b.style === 'house') expect(b.ground).toBe('house');
      if (b.district === 'downtown') expect(b.ground).toBe('lobby');
      if (b.district === 'docks') expect(b.ground).toBe('loading');
      if (b.district === 'midtown' || b.district === 'southgate' || b.district === 'beachfront') expect(['shops', 'lobby']).toContain(b.ground);
    }
    expect([...kinds].sort()).toEqual(['house', 'loading', 'lobby', 'shops']);
    const sign = (t: string) => L.buildings.find((b) => b.sign?.text === t)!;
    expect(sign('FIRST AZURA BANK').ground).toBe('lobby');
    expect(sign('FIRST AZURA BANK').special).toBe('bank');
    expect(sign('POLICE').ground).toBe('lobby');
    expect(sign('HOSPITAL').ground).toBe('lobby');
    expect(sign('MOREAU').ground).toBe('lobby');
    expect(sign('AZURA BOWL').special).toBe('stadium');
    for (const g of L.buildings.filter((b) => b.sign?.text === 'BANG BANG GUNS')) {
      expect(g.ground).toBe('shops');
      expect(g.special).toBe('gunshop');
    }
    // The safehouse: the house right behind its marker on the sidewalk.
    const safe = L.pois.find((p) => p.id === 'safehouse')!;
    const home = L.buildings
      .filter((b) => b.style === 'house' && b.rect.maxZ < safe.z && safe.x > b.rect.minX && safe.x < b.rect.maxX)
      .sort((a, b) => b.rect.maxZ - a.rect.maxZ)[0]!;
    expect(safe.z - home.rect.maxZ).toBeLessThan(4);
    expect(home.special).toBe('safehouse');
    expect(home.ground).toBe('house');
    expect(home.groundSides).toContain('S');
  });

  it('every wall within 10 m of its lot edge counts as street frontage', () => {
    for (const w of streetWalls(world())) expect(w.b.groundSides, `building ${w.b.id} ${w.side}`).toContain(w.side);
  });
});

describe('round 2 city: ground-floor geometry', () => {
  let W: StaticWorld;
  let city: CityView;
  let front: THREE.Mesh;
  let decor: THREE.Mesh;
  let facades: THREE.Mesh[];

  beforeAll(() => {
    W = world();
    city = new CityView(W);
    front = city.group.getObjectByName('storefronts') as THREE.Mesh;
    decor = city.group.getObjectByName('ground-decor') as THREE.Mesh;
    facades = city.group.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name.startsWith('facade-'));
  });

  it('adds two shadow-casting meshes: storefronts and awnings/canopies/porches', () => {
    expect(front).toBeInstanceOf(THREE.Mesh);
    expect(decor).toBeInstanceOf(THREE.Mesh);
    expect(front.castShadow && decor.castShadow).toBe(true);
    expect(front.material).toBe(city.materials.storefront);
    expect(decor.material).toBe(city.materials.decor);
    expect(front.geometry.getAttribute('aSeed').count).toBe(front.geometry.getAttribute('position').count);
    expect(decor.geometry.getAttribute('position').count).toBeGreaterThan(10_000);
    expect(facades.length).toBe(8);
  });

  it('covers the band of every street-facing wall with frontage quads, and no facade window sits in it', () => {
    const fr = verticalTris(front);
    const fa = facades.flatMap(verticalTris);
    const walls = W.layout.buildings.flatMap((b) => b.groundSides.map((s) => wallOf(b, s)));
    // Every 10 m wall is among them (plus walls that look across open ground to the street).
    expect(walls.length).toBeGreaterThanOrEqual(streetWalls(W).length);
    let checked = 0;
    for (const w of walls) {
      const top = CURB_H + w.b.groundH;
      const label = `building ${w.b.id} (${w.b.ground}) ${w.side}`;
      const quads = onWall(fr, w);
      expect(quads.length, label).toBeGreaterThan(0);
      // The quads tile the wall from end to end and from the curb to the top of the band.
      const covered = new Set<string>();
      for (const q of quads) covered.add(`${q.lo.toFixed(3)}:${q.hi.toFixed(3)}`);
      const length = [...covered].reduce((sum, k) => {
        const [lo, hi] = k.split(':').map(Number) as [number, number];
        return sum + (hi - lo);
      }, 0);
      expect(length, label).toBeCloseTo(w.hi - w.lo, 2);
      expect(Math.min(...quads.map((q) => q.minY)), label).toBeCloseTo(CURB_H, 3);
      expect(Math.max(...quads.map((q) => q.maxY)), label).toBeCloseTo(top, 3);
      // The facade (its window grid) on this wall starts at the top of the band.
      const upper = onWall(fa, w);
      expect(upper.length, label).toBeGreaterThan(0);
      for (const t of upper) expect(t.minY, label).toBeGreaterThanOrEqual(top - 1e-3);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('hangs the big signs above the ground floor', () => {
    let checked = 0;
    for (const b of W.layout.buildings) {
      if (!b.sign || b.ground === 'none') continue;
      const r = b.rect;
      const at = b.sign.side === 'N' ? [rectCX(r), r.minZ] : b.sign.side === 'S' ? [rectCX(r), r.maxZ] : b.sign.side === 'E' ? [r.maxX, rectCZ(r)] : [r.minX, rectCZ(r)];
      const sign = city.group.children.find((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.geometry instanceof THREE.PlaneGeometry && Math.hypot(o.position.x - at[0]!, o.position.z - at[1]!) < 0.2)!;
      expect(sign, `sign of ${b.sign.text}`).toBeTruthy();
      const h = (sign.geometry as THREE.PlaneGeometry).parameters.height;
      expect(sign.position.y - h / 2, b.sign.text).toBeGreaterThanOrEqual(CURB_H + b.groundH);
      expect(sign.position.y + h / 2, b.sign.text).toBeLessThan(b.height);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it('keeps every atlas cell inside its own slot, clear of its neighbours', () => {
    const rects = Array.from({ length: 24 }, (_, c) => storefrontUv(c));
    for (const [i, a] of rects.entries()) {
      expect(a[0]).toBeLessThan(a[2]);
      expect(a[1]).toBeLessThan(a[3]);
      for (const [j, o] of rects.entries()) {
        if (i === j) continue;
        const apart = a[2] <= o[0] || o[2] <= a[0] || a[3] <= o[1] || o[3] <= a[1];
        expect(apart, `cells ${i} and ${j}`).toBe(true);
      }
    }
    // A shop cell without its fascia is the lower part of the same rectangle.
    const full = storefrontUv(1);
    const lower = storefrontUv(1, 0.25, 1);
    expect(lower[1]).toBeCloseTo(full[1], 9);
    expect(lower[3]).toBeLessThan(full[3]);
  });

  it('gives every building with a ground floor at least one frontage quad', () => {
    const fr = verticalTris(front);
    for (const b of W.layout.buildings) {
      if (b.ground === 'none') continue;
      const sides = (['N', 'E', 'S', 'W'] as const).map((s) => wallOf(b, s));
      expect(sides.some((w) => onWall(fr, w).length > 0), `building ${b.id}`).toBe(true);
    }
  });

  it('writes one night seed per building on its facade, different between neighbours', () => {
    const seeds = new Map<number, Set<number>>();
    for (const m of facades) {
      const pos = m.geometry.getAttribute('position');
      const seed = m.geometry.getAttribute('aSeed');
      expect(seed.count).toBe(pos.count);
      for (let i = 0; i < seed.count; i += 4) {
        const v = seed.getX(i);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
        // Whole thousandths, so the shader's hash input is exact.
        expect(Math.abs(v * 1000 - Math.round(v * 1000))).toBeLessThan(1e-3);
        const k = Math.round(v * 1000);
        if (!seeds.has(k)) seeds.set(k, new Set());
      }
    }
    // Plenty of distinct seeds across the 684 buildings.
    expect(seeds.size).toBeGreaterThan(400);
  });
});

describe('round 2 city: night and sky helpers', () => {
  it('window occupancy: dark by day, busy in the evening, a few night owls', () => {
    expect(occupancy(12)).toBe(0);
    expect(occupancy(8)).toBe(0);
    expect(occupancy(16.9)).toBe(0);
    expect(occupancy(19)).toBeCloseTo(0.6, 5);
    expect(occupancy(21)).toBeGreaterThanOrEqual(0.5);
    expect(occupancy(4)).toBeLessThanOrEqual(0.2);
    expect(occupancy(6.5)).toBeCloseTo(0.3, 5);
    // Non-increasing from 21:00 to 04:00.
    let prev = occupancy(21);
    for (let h = 21; h <= 28; h += 0.05) {
      const v = occupancy(h % 24);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
    for (let h = -24; h < 48; h += 0.37) {
      const v = occupancy(h);
      expect(Number.isFinite(v) && v >= 0 && v <= 0.6 + 1e-9).toBe(true);
    }
  });

  it('shops: about 70% lit from dusk, the last going dark a little after 02:00, none at dawn', () => {
    expect(shopOccupancy(12)).toBe(0);
    expect(shopOccupancy(19)).toBeCloseTo(0.7, 5);
    expect(shopOccupancy(23)).toBeGreaterThan(0.2);
    expect(shopOccupancy(1)).toBeGreaterThan(shopOccupancy(2));
    expect(shopOccupancy(2)).toBeLessThan(0.05);
    expect(shopOccupancy(2.5)).toBe(0);
    for (let h = 3; h < 17; h += 0.25) expect(shopOccupancy(h), `${h} h`).toBe(0);
  });

  it('clouds always cover part of the sky; stars only shine at night', () => {
    expect(cloudCover(12)).toBeGreaterThan(0);
    expect(cloudCover(12)).toBeCloseTo(0.35, 2);
    expect(cloudCover(2)).toBeGreaterThan(0.15);
    expect(cloudCover(2)).toBeLessThan(0.32);
    expect(starIntensity(12)).toBe(0);
    expect(starIntensity(2)).toBeGreaterThan(0.5);
    expect(starIntensity(23)).toBeGreaterThan(0.5);
    // More cover means a lower density threshold; half cover sits at the noise mean.
    expect(cloudThreshold(0.5)).toBeCloseTo(0.5, 3);
    expect(cloudThreshold(0.35)).toBeGreaterThan(0.5);
    expect(cloudThreshold(0.25)).toBeGreaterThan(cloudThreshold(0.35));
    expect(cloudThreshold(0.35, 0.1272)).toBeCloseTo(0.5 + 0.1272 * 0.3853, 3);
  });

  it('the cloud threshold really covers the asked share of the sky with the sky texture noise', () => {
    const data = cloudNoiseData();
    for (const octaves of [2, 3, 4, 5]) {
      const vals: number[] = [];
      for (let i = 0; i < 160; i++) for (let j = 0; j < 160; j++) vals.push(cloudFbm(data, i * 0.2373 + 3.1, j * 0.2371 + 7.7, octaves));
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      expect(mean, `${octaves} octaves`).toBeCloseTo(0.5, 2);
      expect(Math.abs(sd - CLOUD_SD[octaves]!), `${octaves} octaves`).toBeLessThan(0.006);
      for (const cover of [0.25, 0.35]) {
        const t = cloudThreshold(cover, CLOUD_SD[octaves]);
        const share = vals.filter((v) => v > t).length / vals.length;
        expect(Math.abs(share - cover), `${octaves} octaves, cover ${cover}`).toBeLessThan(0.03);
      }
    }
  });
});

describe('round 2 city: sky and environment map', () => {
  let R: GameRenderer;

  beforeAll(() => {
    R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, world(), { quality: 'high', fov: 68 });
  });

  it('draws the sky after the opaque scene, depth-tested at the far plane', () => {
    const sky = R.env.sky;
    const m = sky.material as THREE.ShaderMaterial;
    expect(sky.renderOrder).toBe(1000);
    expect(m.depthTest).toBe(true);
    expect(m.depthFunc).toBe(THREE.LessEqualDepth);
    expect(m.depthWrite).toBe(false);
    expect(m.transparent).toBe(false);
    expect(m.vertexShader).toContain('gl_Position.z = gl_Position.w');
  });

  it('keeps one environment-map target across re-bakes', () => {
    const env = R.env;
    const scene = R.scene;
    const pmrem = (env as unknown as { pmrem: THREE.PMREMGenerator }).pmrem;
    const allocations: THREE.WebGLRenderTarget[] = [];
    const orig = pmrem.fromCubemap.bind(pmrem);
    pmrem.fromCubemap = (tex, target) => {
      const out = orig(tex, target);
      if (!allocations.includes(out)) allocations.push(out);
      return out;
    };
    const cam = R.cameraCtl.camera;
    const focus = new THREE.Vector3();
    env.update(10, focus, cam, 0, R.renderer);
    const first = scene.environment;
    expect(first).toBeTruthy();
    const uuid = first!.uuid;
    // Ten forced re-bakes: clock jumps of more than a quarter hour each.
    for (let i = 1; i <= 10; i++) env.update((10 + i * 1.7) % 24, focus, cam, i, R.renderer);
    expect(scene.environment).toBe(first);
    expect(scene.environment!.uuid).toBe(uuid);
    expect(allocations.length).toBe(1);
    pmrem.fromCubemap = orig;
  });

  it('sets the sky detail per graphics quality', () => {
    const u = (R.env.sky.material as THREE.ShaderMaterial).uniforms;
    R.setQuality('low');
    expect(u.uOctaves!.value).toBe(2);
    expect(u.uLightTap!.value).toBe(0);
    R.setQuality('medium');
    expect(u.uOctaves!.value).toBe(4);
    expect(u.uLightTap!.value).toBe(1);
    R.setQuality('high');
    expect(u.uOctaves!.value).toBe(5);
  });

  it('lights windows and shops at night and fills unlit walls', () => {
    const city = R.city;
    const facade = city.materials.facades.get('office')!;
    city.update(1, 21.5, 3);
    expect(facade.emissiveIntensity).toBeGreaterThan(1);
    expect(city.materials.storefront!.emissiveIntensity).toBeGreaterThan(1);
    city.update(0, 12, 3);
    expect(facade.emissiveIntensity).toBe(0);
    const env = new Environment(new THREE.Scene(), R.renderer);
    env.update(2, new THREE.Vector3(), R.cameraCtl.camera, 0, R.renderer);
    expect(env.hemi.intensity).toBeGreaterThanOrEqual(0.4 - 1e-9);
    // Sodium-lit streets bounce warm light up.
    expect(env.hemi.groundColor.r).toBeGreaterThan(env.hemi.groundColor.b);
    // The sky adds a warm glow at the horizon, and the fog blends from the plain navy horizon towards it.
    const sky = (env.sky.material as THREE.ShaderMaterial).uniforms;
    const glow = sky.uGlow!.value as THREE.Color;
    const navy = sky.uHorizon!.value as THREE.Color;
    expect(glow.r).toBeGreaterThan(glow.b);
    expect(glow.r).toBeGreaterThan(0.03);
    expect(env.fog.color.r / env.fog.color.b).toBeGreaterThan((navy.r / navy.b) * 3);
    expect(env.fog.color.r).toBeGreaterThan(navy.r * 3);
  });
});
