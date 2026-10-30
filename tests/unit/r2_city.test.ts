// Round 2 city look: street-level ground floors, living night windows, the sky and a stable
// environment map. The render modules run headless: the stub header below is copied from
// fix_render.test.ts (a tiny canvas/document stub and a fake WebGLRenderer), with the few extra
// renderer methods that three's CubeCamera and PMREMGenerator call so the real environment bake runs.

import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CameraController } from '../../src/render/camera';
import { CityView, frontageSplit, occupancy, shopOccupancy } from '../../src/render/city';
import { FOLIAGE_FADE_FAR, PropsView, foliagePoints, foliageSpheres } from '../../src/render/props';
import { DOOR_U, cloudFbm, cloudNoiseData, storefrontUv } from '../../src/render/textures';
import { CLOUD_SD, Environment, cloudCover, cloudThreshold, starIntensity } from '../../src/render/environment';
import { MARKER_FADE_FAR, MARKER_FADE_NEAR, MarkerView, markerFade } from '../../src/render/markers';
import { GameRenderer } from '../../src/render/renderer';
import { Sim } from '../../src/sim/sim';
import { isSolidForSight, makeRayHit } from '../../src/world/colliders';
import { Helicopter } from '../../src/sim/entities';
import { CURB_H } from '../../src/world/constants';
import { SPECIALS, blockOf, frontages, generateCity, rectContains, type Building, type Poi, type Prop, type Side } from '../../src/world/layout';
import { GARAGE_EAVE, GARAGE_ROOF, type StaticWorld } from '../../src/world/staticWorld';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

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
    readonly capabilities = { getMaxAnisotropy: () => 16 };
    // What CubeCamera.update and PMREMGenerator.fromCubemap touch (rendering itself is a no-op).
    readonly xr = { enabled: false };
    readonly coordinateSystem = actual.WebGLCoordinateSystem;
    autoClear = true;
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    private target: unknown = null;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas ?? new EventTarget();
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
  // Fix pass 3 turned the pier's railing lamps (the lamps on a deck) to face the deck: undo that half turn.
  const props = L.props.map((p) => (p.kind === 'lamp' && p.y === 0.45 ? { ...p, rot: p.rot === 0 ? Math.PI : 0 } : p));
  return createHash('sha256').update(JSON.stringify({ ...L, buildings, props })).digest('hex');
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

/**
 * The doors drawn on a wall, read back from the storefront mesh: for every triangle in the wall's
 * plane mapped inside an atlas cell with a door, the coordinate along the wall (x for N/S walls,
 * z for E/W ones) where that cell's door centre (DOOR_U) lands, whichever way the quad is mapped.
 */
function drawnDoors(mesh: THREE.Mesh, w: Wall): number[] {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  const idx = g.getIndex()!;
  const cells = Object.entries(DOOR_U).map(([c, u]) => ({ rect: storefrontUv(Number(c)), u }));
  const out: number[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const v = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
    const n = w.axis === 'x' ? nrm.getX(v[0]!) : nrm.getZ(v[0]!);
    const coord = w.axis === 'x' ? pos.getX(v[0]!) : pos.getZ(v[0]!);
    if (Math.abs(n - w.sign) > 1e-3 || Math.abs(coord - w.coord) > 1e-3) continue;
    const along = v.map((k) => (w.axis === 'x' ? pos.getZ(k) : pos.getX(k)));
    if (Math.max(...along) <= w.lo + 1e-3 || Math.min(...along) >= w.hi - 1e-3) continue;
    const us = v.map((k) => uv.getX(k));
    const vs = v.map((k) => uv.getY(k));
    for (const c of cells) {
      const [u0, v0, u1, v1] = c.rect;
      if (Math.min(...us) < u0 - 1e-6 || Math.max(...us) > u1 + 1e-6 || Math.min(...vs) < v0 - 1e-6 || Math.max(...vs) > v1 + 1e-6) continue;
      // Two corners with different u: the door's u lies between them, linearly along the wall.
      const [a, b] = Math.abs(us[0]! - us[1]!) > 1e-9 ? [0, 1] : Math.abs(us[0]! - us[2]!) > 1e-9 ? [0, 2] : [1, 2];
      const ud = u0 + (u1 - u0) * c.u;
      const s = along[a]! + ((ud - us[a]!) * (along[b]! - along[a]!)) / (us[b]! - us[a]!);
      // Each quad is two triangles: keep one copy of its door.
      if (!out.some((o) => Math.abs(o - s) < 1e-3)) out.push(s);
    }
  }
  return out;
}

/** The sign CityView hung on a building (signs are named 'sign' and tagged with the building id). */
function signOf(city: CityView, b: Building): THREE.Mesh | undefined {
  return city.group.children.find((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name === 'sign' && o.userData.building === b.id);
}

/** A special building's POI and the side its marker faces. */
function specialPoi(W: StaticWorld, b: Building): { side: Side; x: number; z: number } | null {
  const block = blockOf(W.layout, b);
  const def = block ? SPECIALS.find((s) => s.kind === b.special && s.bi === block.bi && s.bj === block.bj) : undefined;
  const poi = def ? W.layout.pois.find((p) => p.id === def.id) : undefined;
  return def && poi ? { side: def.side, x: poi.x, z: poi.z } : null;
}

describe('round 2 city: layout', () => {
  it('ground floors leave the generated layout bit-identical to the base commit', () => {
    // Captured on 8788242 (round 2 base) with the same canonical JSON, re-captured when Hotel Salgado (Vera's
    // SPECIALS row) was added; without that row the layout still hashes to 845117c784a8f32c1b1d3d2dea4648ac91e109e2c016e07e1473fc5199b3215c.
    expect(layoutHash()).toBe('435d93c418a5948f8bfcfeec00dcc6d7f12dc736e7fe7db5b281b4b702610955');
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
      const sign = signOf(city, b)!;
      expect(sign, `sign of ${b.sign.text}`).toBeTruthy();
      const h = (sign.geometry as THREE.PlaneGeometry).parameters.height;
      expect(sign.position.y - h / 2, b.sign.text).toBeGreaterThanOrEqual(CURB_H + b.groundH);
      expect(sign.position.y + h / 2, b.sign.text).toBeLessThan(b.height);
      checked++;
    }
    expect(checked).toBe(8);
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

describe('round 2 fix: entrances where the sim puts them', () => {
  let W: StaticWorld;
  let city: CityView;
  let front: THREE.Mesh;

  beforeAll(() => {
    W = world();
    city = new CityView(W);
    front = city.group.getObjectByName('storefronts') as THREE.Mesh;
  });

  /** Coordinate of a point along a wall: x for N/S walls, z for E/W ones. */
  const alongOf = (w: Wall, x: number, z: number): number => (w.axis === 'x' ? z : x);

  it("draws every special's door within 2 m along its entrance wall of its POI marker", () => {
    const specials = W.layout.buildings.filter((b) => specialPoi(W, b));
    expect(specials.map((b) => b.special).sort()).toEqual(['bank', 'contactDex', 'contactVera', 'gunshop', 'gunshop', 'hospital', 'police', 'safehouse']);
    for (const b of specials) {
      const poi = specialPoi(W, b)!;
      const w = wallOf(b, poi.side);
      const at = alongOf(w, poi.x, poi.z);
      const label = `${b.special} at (${poi.x}, ${poi.z})`;
      // Gun shops draw a door in every bay; one of them must be at the marker.
      const doors = drawnDoors(front, w);
      expect(doors.length, label).toBeGreaterThan(0);
      expect(Math.min(...doors.map((d) => Math.abs(d - at))), label).toBeLessThanOrEqual(2);
      // CityView.entrances, which the sign follows, is that drawn door.
      const e = city.entrances.get(b.id)!;
      expect(e.side, label).toBe(poi.side);
      expect(Math.min(...doors.map((d) => Math.abs(d - alongOf(w, e.x, e.z)))), label).toBeLessThan(1e-3);
      expect(Math.abs(alongOf(w, e.x, e.z) - at), label).toBeLessThanOrEqual(2);
    }
  });

  it('holding the drawn bank doors in The Big Score fills the vault', () => {
    const sim: Sim = makeSim({ ambient: false, police: false });
    for (const id of ['wheels', 'delivery', 'repo', 'loose_lips', 'heatwave']) sim.progress.markDone(id);
    sim.cheats.godMode = true;
    step(sim, 0.1);
    const until = (pred: () => boolean, max: number): void => {
      for (let t = 0; t < max && !pred(); t += 1 / 60) sim.update(1 / 60, input());
      expect(pred()).toBe(true);
    };
    const giver = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === 'big_score')!;
    teleport(sim, giver.x, giver.z);
    step(sim, 0.1);
    sim.update(1 / 60, input({ interact: true }));
    const m = sim.missions.active!;
    expect(m.def.id).toBe('big_score');
    until(() => m.objectiveText === 'Go to the First Azura Bank', 30);
    const poi = W.layout.pois.find((p) => p.id === 'bank')!;
    teleport(sim, poi.x, poi.z);
    until(() => m.objectiveText.startsWith('Hold the bank entrance'), 3);
    // Stand on the steps of the doors drawn in the bank's west wall, 1.2 m out from it.
    const bank = W.layout.buildings.find((b) => b.special === 'bank')!;
    const w = wallOf(bank, 'W');
    const doors = drawnDoors(front, w);
    expect(doors.length).toBe(1);
    teleport(sim, w.coord - 1.2, doors[0]!);
    step(sim, 6);
    // The vault opens in 20 s of holding: 6 s is 30%.
    expect(Number(/VAULT (\d+)%/.exec(m.counter ?? '')?.[1] ?? 0)).toBeGreaterThanOrEqual(25);
  });

  it("hangs each sign over its building's door, centred on it unless that runs it off the wall", () => {
    let checked = 0;
    for (const b of W.layout.buildings) {
      if (!b.sign || b.ground === 'none') continue;
      const sign = signOf(city, b)!;
      const w = wallOf(b, b.sign.side);
      // The main door drawn in the sign's wall: the one in front of the marker (gun shops draw one per bay).
      const poi = specialPoi(W, b);
      const doors = drawnDoors(front, w);
      expect(doors.length, b.sign.text).toBeGreaterThan(0);
      const d = poi ? doors.reduce((p, q) => (Math.abs(q - alongOf(w, poi.x, poi.z)) < Math.abs(p - alongOf(w, poi.x, poi.z)) ? q : p)) : doors[0]!;
      const half = (sign.geometry as THREE.PlaneGeometry).parameters.width / 2;
      const c = alongOf(w, sign.position.x, sign.position.z);
      // The door is under the sign...
      expect(Math.abs(c - d), b.sign.text).toBeLessThan(half);
      // ...centred on it, or as near as it gets with one end of the sign at the end of the wall.
      const atEnd = Math.min(c - half - w.lo, w.hi - c - half) < 0.5;
      expect(Math.abs(c - d) < 0.05 || atEnd, `${b.sign.text}: sign ${c.toFixed(2)}, door ${d.toFixed(2)}`).toBe(true);
      checked++;
    }
    // The bank, SAPD, the hospital, Moreau Tower, Hotel Salgado, both gun shops and the stadium.
    expect(checked).toBe(8);
  });

  it('centres the door of every ordinary lobby on its wall', () => {
    let checked = 0;
    for (const b of W.layout.buildings) {
      if (b.special || b.ground !== 'lobby') continue;
      const doors = b.groundSides.flatMap((side) => drawnDoors(front, wallOf(b, side)).map((d) => ({ d, w: wallOf(b, side) })));
      expect(doors.length, `building ${b.id}`).toBe(1);
      const { d, w } = doors[0]!;
      expect(Math.abs(d - (w.lo + w.hi) / 2), `building ${b.id}`).toBeLessThan(0.05);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('frontageSplit tiles the wall with regular quads and brings the door to its spot', () => {
    for (let len = 3; len <= 60; len += 0.37) {
      for (const u of [0.3, 0.5, 0.85]) {
        for (const f of [0, 0.07, 0.25, 0.5, 0.71, 0.93, 1]) {
          for (const pull of [2, 0.3]) {
            const at = len * f;
            const s = frontageSplit(len, { at, u, pull });
            const label = `len ${len.toFixed(2)}, u ${u}, spot ${at.toFixed(2)}, pull ${pull}`;
            const e = s.edges;
            expect(e[0], label).toBe(0);
            expect(e[e.length - 1], label).toBe(len);
            const widths = e.slice(1).map((x, i) => x - e[i]!);
            expect(s.door, label).toBeGreaterThanOrEqual(0);
            expect(s.door, label).toBeLessThan(widths.length);
            if (widths.length === 1) continue;
            // No sliver beside the door, and a door quad drawn at most a quarter narrower or wider than its cell.
            for (const x of widths) expect(x, label).toBeGreaterThanOrEqual(4 - 1e-9);
            expect(widths[s.door], label).toBeGreaterThanOrEqual(5 - 1e-9);
            expect(widths[s.door], label).toBeLessThanOrEqual(8 + 1e-9);
            const door = e[s.door]! + widths[s.door]! * (s.mirror ? 1 - u : u);
            if (pull === 2) {
              // Wherever the wall leaves room the door is at the spot; at a wall's end, about half a door quad away.
              expect(Math.abs(door - at), label).toBeLessThanOrEqual(2.6);
              // A 5 m door quad fits round the spot with 4 m to spare on either side.
              const reach = 4 + 5 * Math.max(u, 1 - u);
              if (at >= reach && at <= len - reach) expect(Math.abs(door - at), label).toBeLessThan(0.03);
            } else if (u === 0.5 && f === 0.5 && len >= 13) {
              expect(Math.abs(door - at), label).toBeLessThan(0.03);
            }
          }
        }
      }
    }
    expect(frontageSplit(20, null)).toEqual({ edges: [0, 20 / 3, 40 / 3, 20], door: -1, mirror: false });
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
    // An environment map is baked only on a GPU with half-float targets (R probes none here).
    const scene = new THREE.Scene();
    const env = new Environment(scene, R.renderer, { hdr: true });
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

// ---------------------------------------------------------------------------
// Round 2 fix: the camera and street trees (P21 follow-up)

const DT = 1 / 60;
const sightHit = makeRayHit();

/** Share of a frame's pixels (rays through a grid) whose nearest visible leaf is inside the dissolve band. */
function dissolving(props: PropsView, sim: Sim, cam: THREE.PerspectiveCamera, cols: number, rows: number): number {
  const foliage: THREE.Object3D[] = [];
  props.group.traverse((o) => {
    if (o instanceof THREE.InstancedMesh && (o.material as THREE.Material).onBeforeCompile.toString().includes('vFadeWorld')) foliage.push(o);
  });
  const rc = new THREE.Raycaster();
  cam.updateMatrixWorld(true);
  let n = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      rc.setFromCamera(new THREE.Vector2(((i + 0.5) / cols) * 2 - 1, ((j + 0.5) / rows) * 2 - 1), cam);
      const h = rc.intersectObjects(foliage, false)[0];
      if (!h || h.distance >= FOLIAGE_FADE_FAR) continue;
      const o = rc.ray.origin;
      const d = rc.ray.direction;
      if (!sim.world.grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z, h.distance, sightHit, isSolidForSight)) n++;
    }
  }
  return n / (cols * rows);
}

/** The widest share of one pixel row (rays through a grid) that any one tree or palm trunk covers, buildings in front counted. */
function trunkWidth(sim: Sim, cam: THREE.PerspectiveCamera, trunks: readonly Prop[]): number {
  const cols = 48;
  const rows = 27;
  cam.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  let widest = 0;
  for (let j = 0; j < rows; j++) {
    const covered = new Map<Prop, number>();
    for (let i = 0; i < cols; i++) {
      rc.setFromCamera(new THREE.Vector2(((i + 0.5) / cols) * 2 - 1, ((j + 0.5) / rows) * 2 - 1), cam);
      const o = rc.ray.origin;
      const d = rc.ray.direction;
      let best = Infinity;
      let nearest: Prop | null = null;
      for (const q of trunks) {
        // The drawn trunk: a cylinder of its mean radius up to where the canopy starts.
        const r = (q.kind === 'palm' ? 0.19 : 0.21) * q.scale;
        const top = q.y + (q.kind === 'palm' ? 8.5 : 3.0) * q.scale;
        const ox = o.x - q.x;
        const oz = o.z - q.z;
        const a = d.x * d.x + d.z * d.z;
        const b = ox * d.x + oz * d.z;
        const disc = b * b - a * (ox * ox + oz * oz - r * r);
        if (disc < 0 || a < 1e-9) continue;
        const t = (-b - Math.sqrt(disc)) / a;
        const y = o.y + d.y * t;
        if (t > cam.near && t < best && y > q.y && y < top) {
          best = t;
          nearest = q;
        }
      }
      if (nearest && !sim.world.grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z, best, sightHit, isSolidForSight)) covered.set(nearest, (covered.get(nearest) ?? 0) + 1);
    }
    for (const n of covered.values()) widest = Math.max(widest, n / cols);
  }
  return widest;
}

describe('round 2 fix: the camera and street trees', () => {
  it('the first frame of a new game shows no leaves dissolving, landscape and portrait', () => {
    const props = new PropsView(world());
    for (const [w, h] of [[1280, 720], [390, 844]] as const) {
      const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 15.5 });
      const cam = new CameraController(w / h);
      cam.mode = 'play';
      cam.reset(sim);
      cam.update(DT, sim, false);
      expect(dissolving(props, sim, cam.camera, Math.round(w / 20), Math.round(h / 20)), `${w}x${h}`).toBe(0);
    }
  });

  it("describes the foliage with the drawn geometry's own corners", () => {
    const props = new PropsView(world());
    const meshes: THREE.InstancedMesh[] = [];
    props.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && (o.material as THREE.Material).onBeforeCompile.toString().includes('vFadeWorld')) meshes.push(o);
    });
    let checked = 0;
    for (const kind of ['tree', 'bush'] as const) {
      const instances = meshes.flatMap((mesh) => (mesh.userData.propIndices as number[]).map((pi, k) => ({ mesh, k, q: world().layout.props[pi]! }))).filter(({ q }) => q.kind === kind);
      const m = new THREE.Matrix4();
      const v = new THREE.Vector3();
      for (const sample of [0, 7, Math.floor(instances.length / 2), instances.length - 1]) {
        const { mesh, k, q } = instances[sample]!;
        const pos = mesh.geometry.getAttribute('position');
        mesh.getMatrixAt(k, m);
        const spheres = foliageSpheres(q);
        const points = foliagePoints(q);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m);
          // Inside a bounding sphere, and one of the sampled surface points.
          expect(spheres.some((sp) => Math.hypot(v.x - sp.x, v.y - sp.y, v.z - sp.z) <= sp.r + 1e-4), `${kind} ${k}`).toBe(true);
          let found = false;
          for (let j = 0; j < points.length && !found; j += 3) found = Math.hypot(v.x - points[j]!, v.y - points[j + 1]!, v.z - points[j + 2]!) < 1e-4;
          expect(found, `${kind} ${k}`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it('the boom stops in front of a trunk it would only have grazed', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 12 });
    const p = sim.player;
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    // A street tree 3 m behind the player, the camera's boom running 0.45 m beside its trunk.
    for (const q of sim.world.layout.props) {
      if (q.kind !== 'tree') continue;
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        const rx = -Math.cos(yaw);
        const rz = Math.sin(yaw);
        // The boom leaves 0.21 m right of the head and ends 0.42 m right: the trunk 0.45 m right of where it passes.
        const side = 0.32 + 0.45;
        p.pos.x = q.x + fx * 3 - rx * side;
        p.pos.z = q.z + fz * 3 - rz * side;
        p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
        if (!sim.world.isFree(p.pos.x, p.pos.z, 0.5) || sim.world.grid.raycast(p.pos.x, p.pos.y + 1.6, p.pos.z, -fx, 0, -fz, 6, sightHit, isSolidForSight)) continue;
        if (sim.world.layout.props.some((o) => o !== q && (o.kind === 'tree' || o.kind === 'palm') && Math.hypot(o.x - p.pos.x, o.z - p.pos.z) < 8)) continue;
        cam.reset(sim);
        cam.yaw = yaw;
        for (let i = 0; i < 60; i++) cam.update(DT, sim, false);
        const c = cam.camera.position;
        const back = (p.pos.x - c.x) * fx + (p.pos.z - c.z) * fz;
        // In front of the trunk (3 m back), with the bark well clear of the lens.
        expect(back).toBeLessThan(3 - 0.3);
        expect(Math.hypot(c.x - q.x, c.z - q.z) - 0.26 * q.scale).toBeGreaterThan(0.35);
        return;
      }
    }
    throw new Error('no open street tree found');
  });

  it('after a reset with a trunk between the camera and the player, the first frame is already in front of it', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 12 });
    const p = sim.player;
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    for (const q of sim.world.layout.props) {
      if (q.kind !== 'tree') continue;
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        // 2.5 m in front of the trunk, the boom running back through it.
        p.pos.x = q.x + fx * 2.5 + Math.cos(yaw) * 0.3;
        p.pos.z = q.z + fz * 2.5 - Math.sin(yaw) * 0.3;
        p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
        if (!sim.world.isFree(p.pos.x, p.pos.z, 0.5) || sim.world.grid.raycast(p.pos.x, p.pos.y + 1.6, p.pos.z, -fx, 0, -fz, 6, sightHit, isSolidForSight)) continue;
        cam.reset(sim);
        // A teleport that keeps facing this way (reset() picks its own yaw; the debug API sets it back).
        cam.yaw = yaw;
        cam.update(DT, sim, false);
        const c = cam.camera.position;
        expect((p.pos.x - c.x) * fx + (p.pos.z - c.z) * fz).toBeLessThan(2.5 - 0.26 * q.scale);
        return;
      }
    }
    throw new Error('no open street tree found');
  });

  it('getting out of a car with a trunk behind him, the first frame on foot is already in front of it', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 12 });
    const p = sim.player;
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    for (const q of sim.world.layout.props) {
      if (q.kind !== 'tree') continue;
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        const x = q.x + fx * 2.5 + Math.cos(yaw) * 0.3;
        const z = q.z + fz * 2.5 - Math.sin(yaw) * 0.3;
        if (!sim.world.isFree(x, z, 1.2) || sim.world.grid.raycast(x, sim.world.groundHeight(x, z) + 1.6, z, -fx, 0, -fz, 6, sightHit, isSolidForSight)) continue;
        // On foot somewhere open, into a car facing away from the trunk, then out of it where he sat.
        cam.reset(sim);
        cam.update(DT, sim, false);
        const v = sim.spawnVehicle('sedan', x, z, yaw);
        sim.seat(p, v, 0);
        for (let i = 0; i < 30; i++) cam.update(DT, sim, false);
        sim.unseat(p);
        p.pos.x = x;
        p.pos.z = z;
        p.pos.y = sim.world.groundHeight(x, z);
        sim.removeVehicle(v);
        cam.update(DT, sim, false);
        const c = cam.camera.position;
        expect((p.pos.x - c.x) * fx + (p.pos.z - c.z) * fz).toBeLessThan(2.5 - 0.26 * q.scale);
        return;
      }
    }
    throw new Error('no open street tree found');
  });

  it('backing up to a trunk behind him, the camera cuts behind it instead of easing back through it', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 12 });
    const p = sim.player;
    for (const q of sim.world.layout.props) {
      if (q.kind !== 'tree') continue;
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        // 4 m in front of the trunk, the boom running back over it, nothing else near.
        p.pos.x = q.x + fx * 4 + Math.cos(yaw) * 0.3;
        p.pos.z = q.z + fz * 4 - Math.sin(yaw) * 0.3;
        p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
        p.heading = yaw;
        if (!sim.world.isFree(p.pos.x, p.pos.z, 0.5) || sim.world.grid.raycast(p.pos.x, p.pos.y + 1.6, p.pos.z, -fx, 0, -fz, 7, sightHit, isSolidForSight)) continue;
        if (sim.world.layout.props.some((o) => o !== q && (o.kind === 'tree' || o.kind === 'palm') && Math.hypot(o.x - p.pos.x, o.z - p.pos.z) < 9)) continue;
        const cam = new CameraController(16 / 9);
        cam.mode = 'play';
        cam.reset(sim);
        cam.yaw = yaw;
        cam.pitch = -0.12;
        for (let f = 0; f < 30; f++) {
          sim.update(DT, input({ cameraYaw: cam.yaw }));
          cam.update(DT, sim, false);
        }
        let closest = Infinity;
        let widest = 0;
        // Two seconds walking backwards, into the trunk and round it.
        for (let f = 0; f < 120; f++) {
          sim.update(DT, input({ moveZ: -1, cameraYaw: cam.yaw }));
          cam.update(DT, sim, false);
          const c = cam.camera.position;
          closest = Math.min(closest, Math.hypot(c.x - q.x, c.z - q.z) - 0.26 * q.scale);
          widest = Math.max(widest, trunkWidth(sim, cam.camera, [q]));
        }
        // Never inside the trunk (easing out drags the camera back through it), never a third of the frame.
        expect(closest).toBeGreaterThan(0.1);
        expect(widest).toBeLessThan(1 / 3);
        return;
      }
    }
    throw new Error('no open street tree found');
  });

  it('walking past rows of street trees, no trunk spans a third of the frame or comes within 0.3 m of the lens', () => {
    const W = world();
    const trees = W.layout.props.filter((q) => q.kind === 'tree');
    const rows: Array<{ a: Prop; heading: number }> = [];
    for (const a of trees) {
      if (rows.length >= 8) break;
      // A tree with the next one of its row 6-16 m further along x or z.
      if (trees.some((q) => q !== a && Math.abs(q.x - a.x) < 0.05 && q.z > a.z + 6 && q.z < a.z + 16)) rows.push({ a, heading: 0 });
      else if (trees.some((q) => q !== a && Math.abs(q.z - a.z) < 0.05 && q.x > a.x + 6 && q.x < a.x + 16)) rows.push({ a, heading: Math.PI / 2 });
    }
    expect(rows.length).toBe(8);
    let walks = 0;
    let widest = 0;
    let closest = Infinity;
    // Sideways offsets from the row: negative is with the trees on his right, the camera's side.
    for (const lat of [-1.2, -0.8, -0.4, 0.4]) {
      for (const { a, heading } of rows) {
        const sim = new Sim({ world: W, ambient: false, police: false, startHour: 12 });
        const p = sim.player;
        const fx = Math.sin(heading);
        const fz = Math.cos(heading);
        const rx = -Math.cos(heading);
        const rz = Math.sin(heading);
        // 3 m short of the tree, the camera settled, then 3 s of walking past it.
        p.pos.x = a.x - fx * 3 + rx * lat;
        p.pos.z = a.z - fz * 3 + rz * lat;
        if (!W.isFree(p.pos.x, p.pos.z, 0.4)) continue;
        p.pos.y = W.groundHeight(p.pos.x, p.pos.z);
        p.heading = heading;
        const cam = new CameraController(16 / 9);
        cam.mode = 'play';
        cam.reset(sim);
        cam.yaw = heading;
        cam.pitch = -0.12;
        const near = W.layout.props.filter((q) => (q.kind === 'tree' || q.kind === 'palm') && Math.hypot(q.x - p.pos.x, q.z - p.pos.z) < 25);
        for (let f = 0; f < 60; f++) {
          sim.update(DT, input({ cameraYaw: cam.yaw }));
          cam.update(DT, sim, false);
        }
        walks++;
        for (let f = 0; f < 180; f++) {
          sim.update(DT, input({ moveZ: 1, cameraYaw: cam.yaw }));
          cam.update(DT, sim, false);
          widest = Math.max(widest, trunkWidth(sim, cam.camera, near));
          const c = cam.camera.position;
          for (const q of near) closest = Math.min(closest, Math.hypot(c.x - q.x, c.z - q.z) - 0.26 * q.scale);
        }
      }
    }
    expect(walks).toBeGreaterThanOrEqual(24);
    expect(widest).toBeLessThan(1 / 3);
    expect(closest).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// Round 2 fix 2: garage roofs in the sight grid

/** Removes every police car and officer, leaving the helicopters: what they see is all the police see. */
function helisOnly(sim: Sim): void {
  for (const v of sim.vehicles) if (v.owner === 'police' && v.driver !== sim.player) sim.removeVehicle(v);
  for (const c of sim.characters) if (c.isLaw) sim.removeCharacter(c);
}

/** A garage's bay, its centre, and the way out of it (the side its opening faces). */
function bayOf(poi: Poi): { cx: number; cz: number; fx: number; fz: number; depth: number } {
  const b = poi.bay!;
  const fx = Math.sin(poi.heading);
  const fz = Math.cos(poi.heading);
  // Half the bay's extent along the way out.
  const depth = (Math.abs(fx) * (b.maxX - b.minX) + Math.abs(fz) * (b.maxZ - b.minZ)) / 2;
  return { cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, fx, fz, depth };
}

describe('round 2 fix 2: garages hide the bay from above', () => {
  it('draws each garage roof where its collider is', () => {
    const W = world();
    const mesh = new CityView(W).group.getObjectByName('garages') as THREE.Mesh;
    const pos = mesh.geometry.getAttribute('position');
    const nrm = mesh.geometry.getAttribute('normal');
    expect(W.layout.garages.length).toBe(4);
    for (const g of W.layout.garages) {
      // The roof slab's top face: the upward faces at the top of the slab over this garage.
      const top = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        if (nrm.getY(i) < 0.99 || Math.abs(pos.getY(i) - (g.height + GARAGE_ROOF)) > 1e-3) continue;
        if (x < g.rect.minX - 2 || x > g.rect.maxX + 2 || z < g.rect.minZ - 2 || z > g.rect.maxZ + 2) continue;
        top.minX = Math.min(top.minX, x);
        top.minZ = Math.min(top.minZ, z);
        top.maxX = Math.max(top.maxX, x);
        top.maxZ = Math.max(top.maxZ, z);
      }
      const roofs = W.grid.colliders.filter((c) => !c.circle && Math.abs(c.y0 - g.height) < 1e-9 && Math.abs(c.y1 - g.height - GARAGE_ROOF) < 1e-9 && rectContains(g.rect, c.cx, c.cz));
      expect(roofs.length, g.poi).toBe(1);
      const c = roofs[0]!;
      expect(c.tag, g.poi).toBe('wall');
      for (const k of ['minX', 'minZ', 'maxX', 'maxZ'] as const) expect(Math.abs(c[k] - top[k]), `${g.poi} ${k}`).toBeLessThan(1e-3);
      expect(c.maxX - c.minX - (g.rect.maxX - g.rect.minX)).toBeCloseTo(2 * GARAGE_EAVE, 9);
    }
  });

  it('no helicopter round the orbit or overhead sees into a garage bay, though it sees the street in front', () => {
    const sim = makeSim({ startHour: 12 });
    for (const g of sim.world.layout.garages) {
      const poi = sim.world.layout.pois.find((p) => p.id === g.poi)!;
      const { cx, cz, fx, fz, depth } = bayOf(poi);
      // The road 6 m beyond the sidewalk in front of the opening.
      const sx = cx + fx * (depth + 1.5 + 10);
      const sz = cz + fz * (depth + 1.5 + 10);
      const gy = sim.world.groundHeight(cx, cz);
      let n = 0;
      let bay = 0;
      let street = 0;
      // The orbit's radii (24, 16 and 8 m) and beyond, all the way round, low and high.
      for (const r of [0, 8, 16, 24, 32, 40]) {
        for (let a = 0; a < 360; a += 10) {
          for (const up of [30, 36, 42]) {
            const h = new Helicopter(sim.newId(), cx + Math.cos((a * Math.PI) / 180) * r, gy + up, cz + Math.sin((a * Math.PI) / 180) * r);
            n++;
            if (sim.wanted.heliSees(h, cx, cz)) bay++;
            if (sim.wanted.heliSees(h, sx, sz)) street++;
          }
        }
      }
      expect(bay, g.poi).toBe(0);
      expect(street / n, g.poi).toBeGreaterThan(0.9);
    }
  });

  it('a car hidden in a garage bay loses the helicopter: the stars flash, then clear', () => {
    for (const g of world().layout.garages) {
      const sim = makeSim({ startHour: 12 });
      sim.clock.rate = 0;
      const poi = sim.world.layout.pois.find((p) => p.id === g.poi)!;
      const { cx, cz } = bayOf(poi);
      placeInCar(sim, sim.spawnVehicle('sedan', cx, cz, poi.heading + Math.PI));
      sim.wanted.setLevel(3);
      sim.helis.push(new Helicopter(sim.newId(), cx + 20, sim.world.groundHeight(cx, cz) + 36, cz));
      let flashed = -1;
      let cleared = -1;
      for (let i = 0; i < 1000 && cleared < 0; i++) {
        helisOnly(sim);
        sim.update(0.1, input());
        if (flashed < 0 && sim.wanted.searching) flashed = sim.time;
        if (sim.wanted.level === 0) cleared = sim.time;
      }
      expect(sim.helis.some((h) => !h.removed && Math.hypot(h.pos.x - cx, h.pos.z - cz) < 60), g.poi).toBe(true);
      // Once the police are no longer told where he is (13 s at 3 stars), the stars flash 2.5 s later...
      expect(flashed, g.poi).toBeGreaterThan(0);
      expect(flashed, g.poi).toBeLessThan(16.5);
      // ...and hiding clears them (2.6 x 28 s unseen).
      expect(cleared, g.poi).toBeGreaterThan(0);
      expect(cleared, g.poi).toBeLessThan(95);
    }
  });

  it('a helicopter that watched the car drive in still turns the respray down, and the roof lets even a bus in', () => {
    for (const [id, kind] of [['spray_hill', 'sedan'], ['spray_docks', 'bus'], ['spray_south', 'van']] as const) {
      const sim = makeSim({ startHour: 12 });
      sim.clock.rate = 0;
      sim.cheats.godMode = true;
      sim.missions.noBust = true;
      sim.progress.addMoney(5000);
      const poi = sim.world.layout.pois.find((p) => p.id === id)!;
      const { cx, cz, fx, fz, depth } = bayOf(poi);
      // On the road 14 m out from the bay, facing in, with a helicopter over him.
      const sx = cx + fx * (depth + 14);
      const sz = cz + fz * (depth + 14);
      const car = sim.spawnVehicle(kind, sx, sz, poi.heading + Math.PI);
      placeInCar(sim, car);
      const texts: string[] = [];
      sim.events.on('message', (e) => texts.push(e.text));
      sim.wanted.setLevel(3);
      sim.helis.push(new Helicopter(sim.newId(), sx, sim.world.groundHeight(sx, sz) + 36, sz));
      const money = sim.progress.money;
      // Past the 13 s response phase, the helicopter watching him...
      step(sim, 14, () => {
        helisOnly(sim);
        return input();
      });
      expect(sim.wanted.searching, id).toBe(false);
      // ...he drives in slowly and stops in the middle of the bay.
      step(sim, 8, () => {
        helisOnly(sim);
        const ahead = (car.pos.x - cx) * fx + (car.pos.z - cz) * fz;
        return ahead > 0.5 ? input({ throttle: car.speed > 6 ? 0 : 0.6 }) : input({ brake: 1 });
      });
      expect(rectContains(poi.bay!, car.pos.x, car.pos.z), `${id} ${kind}`).toBe(true);
      expect(texts, id).toContain('Spray Shack: They saw you drive in!');
      expect(sim.wanted.level, id).toBe(3);
      expect(sim.progress.money, id).toBe(money);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 2 fix 2: the on-foot camera next to a trunk

describe('round 2 fix 2: trunk cuts with hysteresis', () => {
  /**
   * An idle player in front of open street trees, 1.4-2.4 m from the trunk and up to 1.2 m to either
   * side, the camera settled looking away from it, then two seconds of a slow look round: the yaw
   * swept `amp` degrees either way at 1 Hz. Counts frames where the camera jumps over 0.8 m.
   */
  function panSweep(aiming: boolean, amp: number): { cases: number; cuts: number; maxJump: number } {
    const W = world();
    const sim = new Sim({ world: W, ambient: false, police: false, startHour: 12 });
    const p = sim.player;
    const trees = W.layout.props.filter((q) => q.kind === 'tree');
    let cases = 0;
    let cuts = 0;
    let maxJump = 0;
    let tested = 0;
    for (const q of trees) {
      if (tested >= 6) break;
      if (W.layout.props.some((o) => o !== q && (o.kind === 'tree' || o.kind === 'palm') && Math.hypot(o.x - q.x, o.z - q.z) < 9)) continue;
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        const rx = -Math.cos(yaw);
        const rz = Math.sin(yaw);
        // Open ground in front of the trunk and nothing solid behind it for 7 m.
        const ox = q.x + fx * 2;
        const oz = q.z + fz * 2;
        if (!W.isFree(ox, oz, 0.6) || W.grid.raycast(ox, W.groundHeight(ox, oz) + 1.6, oz, -fx, 0, -fz, 7, sightHit, isSolidForSight)) continue;
        tested++;
        for (let D = 1.4; D <= 2.401; D += 0.05) {
          for (let lat = -0.75; lat <= 1.201; lat += 0.15) {
            p.pos.x = q.x + fx * D - rx * lat;
            p.pos.z = q.z + fz * D - rz * lat;
            if (!W.isFree(p.pos.x, p.pos.z, 0.35)) continue;
            p.pos.y = W.groundHeight(p.pos.x, p.pos.z);
            p.heading = yaw;
            const cam = new CameraController(16 / 9);
            cam.mode = 'play';
            cam.reset(sim);
            cam.yaw = yaw;
            cam.pitch = -0.12;
            for (let i = 0; i < 90; i++) cam.update(DT, sim, aiming);
            const prev = cam.camera.position.clone();
            for (let i = 0; i < 120; i++) {
              cam.yaw = yaw + ((amp * Math.PI) / 180) * Math.sin(2 * Math.PI * i * DT);
              cam.update(DT, sim, aiming);
              const jump = cam.camera.position.distanceTo(prev);
              maxJump = Math.max(maxJump, jump);
              if (jump > 0.8) cuts++;
              prev.copy(cam.camera.position);
            }
            cases++;
          }
        }
        break;
      }
    }
    expect(tested).toBe(6);
    return { cases, cuts, maxJump };
  }

  it('a few degrees of look round beside a street tree never cuts the camera back and forth, on foot or aiming', () => {
    for (const [aiming, amp] of [[false, 3], [true, 3], [false, 8]] as const) {
      const r = panSweep(aiming, amp);
      const label = `${aiming ? 'aiming' : 'on foot'}, +-${amp} degrees: ${JSON.stringify(r)}`;
      expect(r.cases, label).toBeGreaterThan(1000);
      expect(r.cuts, label).toBe(0);
      expect(r.maxJump, label).toBeLessThan(0.8);
    }
  });
});

// ---------------------------------------------------------------------------
// Round 2 fix 2: markers next to the camera

describe('round 2 fix 2: markers fade out next to the camera', () => {
  /**
   * The ids of the drawn markers that the frame's edge cuts within 6 m of the camera: of the vertices of
   * their visible beam and icon within 6 m, some are in the frame and some out of it (or behind the camera).
   */
  function cutMarkers(view: MarkerView, cam: THREE.PerspectiveCamera): string[] {
    cam.updateMatrixWorld(true);
    view.group.updateMatrixWorld(true);
    const out: string[] = [];
    const v = new THREE.Vector3();
    for (const g of view.group.children) {
      if (!g.visible) continue;
      let inside = 0;
      let outside = 0;
      for (const o of g.children) {
        if (!(o instanceof THREE.Mesh) || !o.visible || o.scale.x < 1e-3 || (o.material as THREE.Material).opacity < 0.01) continue;
        const pos = o.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          if (v.distanceTo(cam.position) > 6) continue;
          const s = v.clone().project(cam);
          if (s.z > -1 && s.z < 1 && Math.abs(s.x) <= 1 && Math.abs(s.y) <= 1) inside++;
          else outside++;
        }
      }
      if (inside > 0 && outside > 0) out.push(g.uuid);
    }
    return out;
  }

  it('the first frame of a new game draws no marker cut by the frame close to the camera, landscape and portrait', () => {
    for (const [w, h] of [[1280, 720], [1600, 900], [800, 600], [390, 844]] as const) {
      const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 15.5 });
      const cam = new CameraController(w / h);
      cam.mode = 'play';
      cam.reset(sim);
      cam.update(DT, sim, false);
      const view = new MarkerView();
      view.syncMarkers(sim.interactions.markers, 0, cam.camera.position, sim.playerPos());
      // The safehouse save marker is 3.2 m from the spawn: drawn, it filled the right edge of a landscape frame.
      expect(sim.interactions.markers.some((m) => m.kind === 'save' && Math.hypot(m.x - sim.player.pos.x, m.z - sim.player.pos.z) < 4)).toBe(true);
      expect(cutMarkers(view, cam.camera), `${w}x${h}`).toEqual([]);
    }
  });

  it('a marker fades out only once the camera is about to pass through it', () => {
    const view = new MarkerView();
    const m = { id: 'save:t', kind: 'save' as const, x: 10, z: 20, radius: 1.5, label: '', color: 0x55ccff, ref: '' };
    const drawn = (back: number): { visible: boolean; alpha: number; icon: number } => {
      view.syncMarkers([m], 0, { x: m.x - back, y: 2.3, z: m.z });
      const g = view.group.children[0]!;
      const beam = g.getObjectByName('beam') as THREE.Mesh;
      return { visible: g.visible, alpha: (beam.material as THREE.MeshBasicMaterial).opacity, icon: g.getObjectByName('icon')!.scale.x };
    };
    // Standing in it, the camera 4.3 m behind him: drawn in full.
    expect(drawn(4.3)).toEqual({ visible: true, alpha: 0.28, icon: 1 });
    expect(drawn(MARKER_FADE_FAR)).toEqual({ visible: true, alpha: 0.28, icon: 1 });
    // Fading on the way in...
    const half = drawn((MARKER_FADE_NEAR + MARKER_FADE_FAR) / 2);
    expect(half.visible).toBe(true);
    expect(half.alpha).toBeCloseTo(0.14, 6);
    expect(half.icon).toBeCloseTo(0.5, 6);
    // ...and gone nearer than MARKER_FADE_NEAR, as in the New Game frame (2.9 m from the safehouse marker).
    expect(drawn(2.9).visible).toBe(false);
    expect(drawn(0.5).visible).toBe(false);
    // Without a camera (title screen, tests) every marker is drawn in full...
    view.syncMarkers([m], 0);
    expect(view.group.children[0]!.visible).toBe(true);
    // ...and so is the one he stands in, the camera pulled in close by a wall or an aim.
    view.syncMarkers([m], 0, { x: m.x - 2.4, y: 2.3, z: m.z }, { x: m.x - 0.6, z: m.z });
    expect(view.group.children[0]!.visible).toBe(true);
    expect((((view.group.children[0]!.getObjectByName('beam') as THREE.Mesh).material) as THREE.MeshBasicMaterial).opacity).toBe(0.28);
    // Stepping off it, it fades out over the next metre of his walk (r2_fix3_actors), not in one frame.
    view.syncMarkers([m], 0, { x: m.x - 2.4, y: 2.3, z: m.z }, { x: m.x - 2.6, z: m.z });
    expect(view.group.children[0]!.visible).toBe(false);
    // High above it, as close over the ground: far from the marker itself.
    expect(markerFade({ x: m.x, y: 30, z: m.z }, m.x, m.z)).toBe(1);
    // Every material a marker view had goes with it.
    const beam = view.group.children[0]!.getObjectByName('beam') as THREE.Mesh;
    let disposed = false;
    (beam.material as THREE.Material).addEventListener('dispose', () => (disposed = true));
    view.syncMarkers([], 1);
    expect(view.group.children.length).toBe(0);
    expect(disposed).toBe(true);
  });
});
