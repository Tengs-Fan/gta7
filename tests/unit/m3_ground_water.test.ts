// Mission 3 ground and water: PBR ground with its detail layers (render/city/surfaces.ts), manholes and tyre marks
// (city/roads.ts), anisotropy per tier, the wet patch on the new materials, the sea's depth gradient, ripple layers
// and piling foam (render/sea.ts). Headless, with the stub header of rain.test.ts (plus mocked anisotropy).

import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assets } from '../../src/render/assets';
import { loadAssetsFromDisk, unloadAssets } from '../../src/render/assets/testing';
import { CityView } from '../../src/render/city';
import { MANHOLE_R, manholesOf, TYRE_MARK_W, tyreMarksOf } from '../../src/render/city/roads';
import { anisotropyFor, ASPHALT_AO, LAWN_OVERHANG, PBR_SURFACES, WET_SAND_BAND, WET_SAND_DARKEN, WET_SAND_ROUGHNESS } from '../../src/render/city/surfaces';
import { RIPPLE_B } from '../../src/render/environment';
import { GameRenderer } from '../../src/render/renderer';
import { FOAM_SKY_LIFT, MAX_PILING_DECKS, PILING_FOAM, PILING_FOAM_FAR, PILING_FOAM_PX, PILING_INSET, PILING_RADIUS, PILING_START, PILING_STEP, pilingCentres, RIPPLE_A_TILE, RIPPLE_AB_GAIN, RIPPLE_C, RIPPLE_D, SHELF_SLOPE, SHELF_START, SHORE_DAMP, SHORE_GLSL, SURF_BAND_FADE, seaDepthCpu, seaDrawnDepth, seaShelfDepth, seaUniforms, surfPhases } from '../../src/render/sea';
import { coverWetness, puddleMask, WET_DARKEN, WET_FLATTEN, WET_ROUGHNESS } from '../../src/render/wetGround';
import { BEACH_W, CROSSWALK_W, CURB_H, LANE_W, SAND_DROP, SEABED_Y, SIDEWALK_W, WATER_Y } from '../../src/world/constants';
import { sandHeight } from '../../src/world/layout';
import { input, makeSim, world } from './helpers';

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

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    readonly capabilities = { getMaxAnisotropy: () => 16 };
    readonly xr = { enabled: false };
    autoClear = true;
    readonly coordinateSystem = actual.WebGLCoordinateSystem;
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas ?? new EventTarget();
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(): void {}
    compile(): void {}
    getRenderTarget(): unknown {
      return null;
    }
    getActiveCubeFace(): number {
      return 0;
    }
    getActiveMipmapLevel(): number {
      return 0;
    }
    render(): void {}
    setRenderTarget(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const HDR = { renderer: '', halfFloat: true };
const SOFTWARE = { renderer: 'Google SwiftShader', halfFloat: true };
const canvas = (): HTMLCanvasElement => document.createElement('canvas') as unknown as HTMLCanvasElement;
const renderer = (quality: 'high' | 'medium' | 'low', gpu = HDR): GameRenderer => new GameRenderer(canvas(), world(), { quality, fov: 68, gpu });

function compiled(mat: THREE.Material, kind: 'physical' | 'lambert' = 'physical') {
  const shader = { vertexShader: THREE.ShaderLib[kind].vertexShader, fragmentShader: THREE.ShaderLib[kind].fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
  mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as unknown as THREE.WebGLRenderer);
  return shader;
}
const meshes = (root: THREE.Object3D, name: string): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && o.name === name) out.push(o);
  });
  return out;
};
const mesh = (c: CityView, name: string): THREE.Mesh => meshes(c.group, name)[0]!;
const matOf = (c: CityView, name: string) => mesh(c, name).material as THREE.MeshStandardMaterial;
const GROUND_SETS = ['worn_asphalt', 'leafy_grass', 'coast_sand_01'];

describe('PBR ground with the asset library (VAL-GND-001, 003, 004)', () => {
  let city: CityView;
  beforeAll(async () => {
    unloadAssets();
    const report = await loadAssetsFromDisk({ filter: (e) => e.kind === 'texture' && GROUND_SETS.includes(e.set ?? '') });
    expect(report.loaded).toBe(9);
    city = new CityView(world());
  });
  afterAll(() => unloadAssets());

  it('roads, lots, lawns and sand sample their set\'s albedo, normal and ORM (roughness) maps, each in the manifest and LICENSES-ASSETS.md', () => {
    const licenses = readFileSync('LICENSES-ASSETS.md', 'utf8');
    const manifest = JSON.parse(readFileSync('src/assets/manifest.json', 'utf8')) as { entries: Array<{ id: string; license: string; file: string }> };
    for (const [name, detail] of [['roads', 'road'], ['ground-asphalt', 'lot'], ['ground-grass', 'grass'], ['beach', 'sand']] as const) {
      const m = matOf(city, name);
      const set = PBR_SURFACES[detail]!.set;
      expect(m.map, name).toBe(assets.texture(`tex.${set}.albedo`));
      expect(m.normalMap, name).toBe(assets.texture(`tex.${set}.normal`));
      expect(m.roughnessMap, name).toBe(assets.texture(`tex.${set}.orm`));
      for (const map of ['albedo', 'normal', 'orm']) {
        const e = manifest.entries.find((x) => x.id === `tex.${set}.${map}`)!;
        expect(e.file).toMatch(/\.webp$/);
        expect(licenses).toContain(`| ${e.license} |`);
      }
    }
    // Fix pass 2 (VAL-LIT-003): the asphalt's AO channel barely darkens its sky light, so the shaded noon road keeps
    // d98da7b's luma; the lawns and sand keep 0.6.
    expect(matOf(city, 'roads').aoMapIntensity).toBe(ASPHALT_AO);
    expect(matOf(city, 'ground-asphalt').aoMapIntensity).toBe(ASPHALT_AO);
    expect(ASPHALT_AO).toBeLessThan(0.3);
    expect(matOf(city, 'ground-grass').aoMapIntensity).toBe(0.6);
    expect(matOf(city, 'beach').aoMapIntensity).toBe(0.6);
  });

  it('the road shader carries the world-space detail layer: repairs, cracks and lane wear', () => {
    const s = compiled(matOf(city, 'roads'));
    expect(s.vertexShader).toContain('attribute vec4 aGround;');
    expect(s.fragmentShader).toContain('if ( gHash( cell ) < 0.3 )');
    expect(s.fragmentShader).toContain('float crack = zone');
    expect(s.fragmentShader).toContain('float track = exp(');
    expect(s.fragmentShader).toContain('float oil = exp(');
    // Lots get repairs and cracks but no lane wear.
    const lot = compiled(matOf(city, 'ground-asphalt')).fragmentShader;
    expect(lot).toContain('float crack = zone');
    expect(lot).not.toContain('float track = exp(');
    // Road segments carry (across, from start, to end, half width); junction boxes zero (no lanes).
    const geo = mesh(city, 'roads').geometry;
    const a = geo.getAttribute('aGround');
    const roads = world().roads;
    let lanes = 0;
    for (let i = 0; i < a.count; i++) {
      if (a.getW(i) === 0) continue;
      lanes++;
      expect([5, 8]).toContain(a.getW(i));
      expect(Math.abs(a.getX(i))).toBeCloseTo(a.getW(i), 4);
      expect(Math.min(a.getY(i), a.getZ(i))).toBeCloseTo(0, 4);
    }
    expect(lanes).toBe(roads.segments.length * 4);
  });

  it('sidewalks carry their kerb rectangle, kerb faces and gutters get grime, and lawns fray onto the paving', () => {
    const W = world();
    const walk = mesh(city, 'sidewalks').geometry;
    const a = walk.getAttribute('aGround');
    const pos = walk.getAttribute('position');
    for (let i = 0; i < a.count; i += 37) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const rect = [a.getX(i), a.getY(i), a.getZ(i), a.getW(i)];
      const blk = W.layout.blocks.find((b) => b.rect.minX === rect[0] && b.rect.minZ === rect[1] && b.rect.maxX === rect[2] && b.rect.maxZ === rect[3]);
      const b = W.layout.bounds;
      const city4 = [b.cityMinX, b.cityMinZ, b.cityMaxX, b.cityMaxZ];
      expect(blk !== undefined || rect.every((v, k) => v === city4[k]), `${x},${z}`).toBe(true);
      // Each vertex lies on the kerb rectangle's edge or within a sidewalk width of it.
      const f = Math.min(x - rect[0]!, rect[2]! - x, z - rect[1]!, rect[3]! - z);
      expect(Math.abs(f)).toBeLessThanOrEqual(SIDEWALK_W + 1e-6);
    }
    expect(compiled(matOf(city, 'sidewalks')).fragmentShader).toContain('float grime = clamp( ( 1.0 - smoothstep( 0.1');
    for (const n of ['curbs', 'road-gutters']) expect(compiled(matOf(city, n)).fragmentShader, n).toContain('float low = 1.0 - smoothstep( 0.0, 0.15, vGroundPos.y );');
    const grass = compiled(matOf(city, 'ground-grass')).fragmentShader;
    expect(grass).toContain('discard;');
    expect(grass).toContain('vec3( 0.16, 0.115, 0.075 ), soil');
    // Lawn quads reach LAWN_OVERHANG over the sidewalk exactly where they meet it.
    const g = mesh(city, 'ground-grass').geometry;
    const ga = g.getAttribute('aGround');
    const gp = g.getAttribute('position');
    let over = 0;
    for (let i = 0; i < ga.count; i++) {
      const f = Math.min(gp.getX(i) - ga.getX(i), ga.getZ(i) - gp.getX(i), gp.getZ(i) - ga.getY(i), ga.getW(i) - gp.getZ(i));
      expect(f).toBeGreaterThanOrEqual(-LAWN_OVERHANG - 1e-6);
      if (f < -1e-6) over++;
    }
    expect(over).toBeGreaterThan(50);
  });

  it('sand: the wet band runs inland from the waterDepth = 0 contour, darker and glossier, with ripples and the surf lace', () => {
    const W = world();
    const b = W.layout.bounds;
    const s = compiled(matOf(city, 'beach')).fragmentShader;
    expect(s).toContain(`float inland = ( vGroundPos.y - ( -1.0 ) ) * ${BEACH_W / SAND_DROP};`);
    expect(s).toContain('gWetSand = 1.0 - smoothstep( edge, edge + 2.6, inland );');
    expect(s).toContain(`diffuseColor.rgb *= 1.0 - ${WET_SAND_DARKEN} * gWetSand;`);
    expect(s).toContain(`roughnessFactor = mix( roughnessFactor, ${WET_SAND_ROUGHNESS}, gWetSand );`);
    expect(WET_SAND_ROUGHNESS).toBeLessThan(0.8);
    expect(s).toContain('normal = normalize( normal + mat3( viewMatrix ) * vec3( - rdir.x * s, 0.0, - rdir.y * s ) );');
    expect(s).toContain('uGroundSurf');
    // The shader's inland distance is 0 exactly on the sim's shoreline at 20 points along Ocean Beach.
    const sand = mesh(city, 'beach').geometry;
    expect(sand.getAttribute('aGround')).toBeTruthy();
    const wlx = b.beachStartX + (BEACH_W * (CURB_H - WATER_Y)) / SAND_DROP;
    for (let k = 0; k < 20; k++) {
      const z = b.landMinZ + 20 + ((b.landMaxZ - b.landMinZ - 40) * k) / 19;
      if (W.layout.decks.some((d) => z >= d.rect.minZ - 1 && z <= d.rect.maxZ + 1)) continue;
      expect(Math.abs(W.waterDepth(wlx, z)), `z ${z}`).toBeLessThan(1e-6);
      const y = sandHeight(b, wlx);
      expect(((y - WATER_Y) * BEACH_W) / SAND_DROP).toBeCloseTo(0, 6);
      // 1 to 8 m inland is inside the band (fully wet before its frayed edge at >= WET_SAND_BAND).
      expect(WET_SAND_BAND).toBeGreaterThanOrEqual(8);
    }
  });

  it('the surf lace follows the sea\'s surf phase', () => {
    city.update(0, 12, 17.3);
    expect(city.ground.uniforms.uGroundSurf.value).toBeCloseTo(surfPhases(17.3).surf, 9);
  });

  it('estimated GPU memory of the ground and sea textures stays under 48 MB', () => {
    expect(city.ground.textureBytes() / 1e6).toBeLessThan(48);
    // The PBR sets as decoded in the browser (manifest sizes), plus the procedural tiles.
    const manifest = JSON.parse(readFileSync('src/assets/manifest.json', 'utf8')) as { entries: Array<{ set?: string; bounds: { width?: number; height?: number } }> };
    let bytes = 0;
    for (const e of manifest.entries) if (GROUND_SETS.includes(e.set ?? '')) bytes += (e.bounds.width ?? 0) * (e.bounds.height ?? 0) * 4 * 1.33;
    bytes += 256 * 256 * 4 * 1.33 * 30 + 128 * 128 * 1.33;
    expect(bytes / 1e6).toBeLessThan(48);
  });
});

describe('manholes and tyre marks (VAL-GND-002)', () => {
  const roads = () => world().roads;
  const allManholes = () => roads().segments.flatMap((_, i) => manholesOf(roads(), i));
  const allMarks = () => roads().nodes.flatMap((_, i) => tyreMarksOf(roads(), i));

  it('at least one cover per 80 m of road centreline, and tyre marks at half the signalised junctions or more', () => {
    const r = roads();
    const length = r.segments.reduce((s, x) => s + (x.vertical ? x.maxZ - x.minZ : x.maxX - x.minX), 0);
    const m = allManholes();
    expect(m.length / length).toBeGreaterThanOrEqual(1 / 80);
    const signals = r.nodes.filter((n) => n.signal).length;
    const marked = new Set(allMarks().map((t) => t.node));
    expect(marked.size / signals).toBeGreaterThanOrEqual(0.5);
  });

  it('every cover lies wholly on asphalt, clear of crosswalks, stop lines and lane paint', () => {
    const W = world();
    const r = roads();
    for (const m of allManholes()) {
      const s = r.segments[m.segment]!;
      const along = s.vertical ? m.z : m.x;
      const across = (s.vertical ? m.x : m.z) - s.line.pos;
      const lo = s.vertical ? s.minZ : s.minX;
      const hi = s.vertical ? s.maxZ : s.maxX;
      expect(along - MANHOLE_R).toBeGreaterThan(lo + CROSSWALK_W + 1);
      expect(along + MANHOLE_R).toBeLessThan(hi - CROSSWALK_W - 1);
      expect(Math.abs(across) + MANHOLE_R).toBeLessThan(s.line.width / 2 - 0.35 - 0.05);
      // Clear of the centre lines (0.16 +- 0.06 or the 0.13 dashes) and the lane dividers at LANE_W.
      expect(Math.abs(across) - MANHOLE_R).toBeGreaterThan(0.25);
      if (s.line.lanes === 2) expect(Math.abs(Math.abs(across) - LANE_W)).toBeGreaterThan(MANHOLE_R + 0.06);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const x = m.x + Math.cos(a) * MANHOLE_R;
        const z = m.z + Math.sin(a) * MANHOLE_R;
        expect(W.isOnRoad(x, z), `${x},${z}`).toBe(true);
        expect(W.layout.buildings.some((b) => x > b.rect.minX && x < b.rect.maxX && z > b.rect.minZ && z < b.rect.maxZ)).toBe(false);
      }
    }
  });

  it('every tyre mark lies wholly on asphalt, outside the crosswalk bands and off the lane paint', () => {
    const W = world();
    const r = roads();
    let points = 0;
    for (const t of allMarks()) {
      const n = r.nodes[t.node]!;
      for (const p of t.points) {
        points++;
        for (const [dx, dz] of [[TYRE_MARK_W / 2, 0], [-TYRE_MARK_W / 2, 0], [0, TYRE_MARK_W / 2], [0, -TYRE_MARK_W / 2]]) expect(W.isOnRoad(p.x + dx!, p.z + dz!)).toBe(true);
        const inBox = Math.abs(p.x - n.x) < n.halfX && Math.abs(p.z - n.z) < n.halfZ;
        if (inBox) continue;
        // On an approach: beyond the crosswalk band and stop line, between the centre line and the lane divider.
        const vertical = Math.abs(p.x - n.x) < n.halfX;
        const along = vertical ? Math.abs(p.z - n.z) - n.halfZ : Math.abs(p.x - n.x) - n.halfX;
        const across = Math.abs(vertical ? p.x - n.x : p.z - n.z);
        expect(along, `node ${t.node} ${p.x},${p.z} box ${n.x},${n.z} ${n.halfX}x${n.halfZ}`).toBeGreaterThan(CROSSWALK_W + 0.6);
        expect(across - TYRE_MARK_W / 2).toBeGreaterThan(0.25);
        const lane = across % LANE_W;
        expect(Math.min(lane, LANE_W - lane) - TYRE_MARK_W / 2, `${p.x},${p.z}`).toBeGreaterThan(0.08);
      }
    }
    expect(points).toBeGreaterThan(1000);
  });

  it('placement is deterministic, independent of the sim, and built into the road batches (one decal draw, covers in the ironwork)', () => {
    const a = new CityView(world());
    const b = new CityView(world());
    expect(a.ground.manholes).toEqual(b.ground.manholes);
    expect(a.ground.tyreMarks).toEqual(b.ground.tyreMarks);
    const sim = makeSim();
    const rngBefore = JSON.stringify(sim.rng);
    const c = new CityView(sim.world);
    expect(JSON.stringify(sim.rng)).toBe(rngBefore);
    expect(c.ground.manholes).toEqual(a.ground.manholes);
    expect(meshes(a.group, 'road-decals')).toHaveLength(1);
    expect(meshes(a.group, 'street-ironwork')).toHaveLength(1);
    const decal = matOf(a, 'road-decals');
    expect(decal.transparent).toBe(true);
    expect(decal.depthWrite).toBe(false);
    expect(decal.polygonOffset).toBe(true);
    expect(a.wet.materials).toContain(decal);
  });
});

describe('anisotropic filtering (VAL-GND-005)', () => {
  it('every road, sidewalk, plaza, grass and sand map follows the tier: min(cap, max) with High 16, Medium 8, Low 4, software 1', () => {
    expect(anisotropyFor('high', 16)).toBe(16);
    expect(anisotropyFor('medium', 16)).toBe(8);
    expect(anisotropyFor('low', 16)).toBe(4);
    expect(anisotropyFor('software', 16)).toBe(1);
    expect(anisotropyFor('high', 8)).toBe(8);
    expect(anisotropyFor('high', 0)).toBe(1);
    const r = renderer('high');
    const names = ['roads', 'ground-asphalt', 'sidewalks', 'curbs', 'road-gutters', 'ground-plaza', 'ground-grass', 'ground-dirt', 'beach'];
    const maps = names.flatMap((n) => {
      const m = matOf(r.city, n);
      return [m.map, m.normalMap, m.roughnessMap].filter((t): t is THREE.Texture => !!t);
    });
    expect(maps.length).toBeGreaterThanOrEqual(names.length * 3);
    for (const t of maps) expect(r.city.ground.textures.has(t)).toBe(true);
    const programs = names.map((n) => matOf(r.city, n).customProgramCacheKey());
    const versions = names.map((n) => matOf(r.city, n).version);
    const geometries = names.map((n) => mesh(r.city, n).geometry);
    for (const [q, want] of [['high', 16], ['medium', 8], ['low', 4], ['high', 16]] as const) {
      r.setQuality(q);
      for (const t of maps) expect(t.anisotropy, q).toBe(want);
    }
    expect(names.map((n) => matOf(r.city, n).customProgramCacheKey())).toEqual(programs);
    expect(names.map((n) => matOf(r.city, n).version)).toEqual(versions);
    expect(names.map((n) => mesh(r.city, n).geometry)).toEqual(geometries);
    r.dispose();
    const soft = renderer('high', SOFTWARE);
    for (const t of soft.city.ground.textures) expect(t.anisotropy).toBe(1);
    soft.dispose();
  });
});

describe('wet ground on the new materials (VAL-GND-006)', () => {
  it('the road, sidewalk and plaza shaders keep the wet chunk, after the detail layer so rain gloss wins', () => {
    const r = renderer('high');
    for (const n of ['roads', 'sidewalks', 'ground-plaza', 'ground-asphalt', 'road-decals']) {
      const m = matOf(r.city, n);
      expect(r.city.wet.materials, n).toContain(m);
      const s = compiled(m);
      expect(s.uniforms.uWet, n).toBe(r.city.wet.uniforms.uWet);
      const fs = s.fragmentShader;
      expect(fs, n).toContain('diffuseColor.rgb *= 1.0 - 0.35 * wetK - 0.2 * wetPuddle;');
      expect(fs, n).toContain('roughnessFactor = mix( roughnessFactor, 0.12, wetK );');
      // Wetness flattens the normal map's relief, so the glossy asphalt does not glitter.
      expect(fs, n).toContain(`normal = normalize( mix( normal, nonPerturbedNormal, ${WET_FLATTEN} * wetK ) );`);
      if (n !== 'road-decals') expect(fs.indexOf('roughnessFactor = clamp( roughnessFactor + gRough'), n).toBeLessThan(fs.indexOf('roughnessFactor = mix( roughnessFactor, 0.12, wetK )'));
    }
    r.dispose();
  });

  it('CPU mirror of the darkening and gloss matches the shader constants', () => {
    expect(WET_DARKEN).toBe(0.35);
    expect(WET_ROUGHNESS).toBe(0.12);
    expect(puddleMask(1, 1)).toBe(1);
    expect(coverWetness(1, 3, 0)).toBe(0);
  });

  it('a clear-rain-clear ramp changes no material version or program key on the ground', () => {
    const r = renderer('high');
    const sim = makeSim();
    r.attach(sim);
    const mats = [...r.city.ground.materials];
    const before = mats.map((m) => [m.version, m.customProgramCacheKey()]);
    for (const kind of ['rain', 'storm', 'clear'] as const) {
      sim.weather.override(kind, 0);
      for (let i = 0; i < 4; i++) {
        sim.update(1 / 60, input());
        r.render(1 / 60, false);
      }
    }
    expect(mats.map((m) => [m.version, m.customProgramCacheKey()])).toEqual(before);
    r.dispose();
  });

  it('the software tier keeps the plain procedural surfaces (no detail patch) under the Lambert stand-ins', () => {
    const soft = renderer('high', SOFTWARE);
    const m = matOf(soft.city, 'roads');
    expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    const fs = compiled(m, 'lambert').fragmentShader;
    expect(fs).toContain('diffuseColor.rgb *= 1.0 - 0.35 * wetK');
    expect(fs).not.toContain('gHash');
    soft.dispose();
  });
});

describe('sea depth gradient, ripples and foam (VAL-GND-007, 008, 009)', () => {
  const b = () => world().layout.bounds;

  it('the drawn shelf follows the sim near land and keeps falling offshore past 15 m and 40 m', () => {
    const W = world();
    const bb = b();
    const z = 0;
    for (const x of [bb.beachStartX + 45, bb.beachStartX + 70, bb.beachEndX - 5]) expect(seaDepthCpu(bb, x, z)).toBeCloseTo(W.waterDepth(x, z), 5);
    expect(seaDrawnDepth(bb, bb.beachEndX + SHELF_START, z)).toBeCloseTo(WATER_Y - SEABED_Y, 1);
    expect(seaDrawnDepth(bb, bb.beachEndX + 120, z)).toBeGreaterThan(15);
    expect(seaDrawnDepth(bb, bb.beachEndX + 400, z)).toBeGreaterThan(40);
    let prev = -Infinity;
    for (let x = bb.beachStartX + 40; x < bb.beachEndX + 600; x += 5) {
      const d = seaDrawnDepth(bb, x, z);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
    expect(seaShelfDepth(7, SHELF_START)).toBe(7);
    expect(seaShelfDepth(7, SHELF_START + 100)).toBeCloseTo(7 + SHELF_SLOPE * 100, 9);
  });

  it('the palette runs turquoise (hue 160-190) to deep blue (195-235), each step darker', () => {
    const u = seaUniforms();
    const hsl = { h: 0, s: 0, l: 0 };
    const hue = (c: THREE.Color) => c.clone().convertLinearToSRGB().getHSL(hsl).h * 360;
    expect(hue(u.uShallow.value)).toBeGreaterThan(160);
    expect(hue(u.uShallow.value)).toBeLessThan(190);
    for (const c of [u.uSeaDeep.value, u.uSeaAbyss.value]) {
      expect(hue(c)).toBeGreaterThan(195);
      expect(hue(c)).toBeLessThan(235);
    }
    const luma = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(luma(u.uSeaDeep.value)).toBeLessThan(luma(u.uShallow.value) * 0.5);
    expect(luma(u.uSeaAbyss.value)).toBeLessThan(luma(u.uSeaDeep.value));
    expect(SHORE_GLSL).toContain('c = mix(c, uSeaDeep, smoothstep(4.0, 18.0, shelf));');
    expect(SHORE_GLSL).toContain('c = mix(c, uSeaAbyss, smoothstep(10.0, 45.0, shelf));');
  });

  it('the sea and the software sea draw the gradient', () => {
    const r = renderer('medium');
    const mat = r.env.water.material as THREE.MeshStandardMaterial;
    const s = compiled(mat);
    expect(s.fragmentShader).toContain('seaShallows( diffuseColor.rgb, seaDepth, vSeaXZ )');
    expect(s.uniforms.uSeaDeep).toBe(r.env.sea.uSeaDeep);
    const sw = renderer('high', SOFTWARE);
    expect((sw.env.water.material as THREE.ShaderMaterial).fragmentShader).toContain('seaShallows(vec3(0.018, 0.17, 0.23), depth, vWorld.xz)');
  });

  it('ripples: four layers at scale ratios at least 0.2 from whole numbers, drifting apart, warped and modulated by low-frequency noise', () => {
    const frac = (v: number) => Math.abs(v - Math.round(v));
    // Every pair of layer tiles (m): A, B (Environment), C and D.
    const tiles = [RIPPLE_A_TILE, RIPPLE_A_TILE / RIPPLE_B.scale, RIPPLE_C.tile, RIPPLE_A_TILE / RIPPLE_D.scale];
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const k = Math.max(tiles[i]!, tiles[j]!) / Math.min(tiles[i]!, tiles[j]!);
        expect(frac(k), `layers ${i} and ${j}: ${k}`).toBeGreaterThanOrEqual(0.2);
      }
    }
    // Four different turns.
    const turns = [0, Math.atan2(RIPPLE_B.sin, RIPPLE_B.cos), Math.atan2(-RIPPLE_C.sin, RIPPLE_C.cos), Math.atan2(RIPPLE_D.sin, RIPPLE_D.cos)];
    expect(new Set(turns.map((a) => a.toFixed(2))).size).toBe(4);
    const r = renderer('high');
    const fs = compiled(r.env.water.material as THREE.MeshStandardMaterial).fragmentShader;
    expect(fs).toContain('vec2 seaRippleUv = vNormalMapUv + seaWarp;');
    expect(fs).toContain('#define vNormalMapUv seaRippleUv');
    expect(fs).toContain('vec2 seaNormalScale = normalScale * ( 0.85 + 0.3 * smoothstep(');
    expect(fs).toContain('vec2 seaCuv = mat2(');
    // The second layer turns 37 degrees; the third layer turns another way and drifts with uFoamDrift (whole tiles at wrap).
    expect(Math.atan2(RIPPLE_B.sin, RIPPLE_B.cos)).not.toBeCloseTo(Math.atan2(RIPPLE_C.sin, RIPPLE_C.cos), 2);
    expect(fs).toContain('uFoamDrift.yx * 3.0');
    expect(fs).toContain('vec2 seaDuv = mat2(');
    expect(fs).toContain(`* seaRippleUv * ${RIPPLE_D.scale} - uFoamDrift * 2.0`);
    expect(fs).toContain(`vec2 seaNormalScaleAB = seaNormalScale * ${RIPPLE_AB_GAIN};`);
    expect(fs).toContain('#define normalScale seaNormalScaleAB');
  });

  it('pilings: the shader\'s lattice is the drawn one, and every piling has foam on all four sides within 0.5 m', () => {
    const W = world();
    const r = renderer('high');
    const decks = W.layout.decks;
    expect(decks.length).toBeLessThanOrEqual(MAX_PILING_DECKS);
    decks.forEach((d, i) => expect(r.env.sea.uPilings.value[i]!.toArray()).toEqual([d.rect.minX, d.rect.minZ, d.rect.maxX, d.rect.maxZ]));
    // The pilings CityView draws.
    const inst = meshes(r.city.group, '').find((m) => m instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
    const drawn: Array<{ x: number; z: number }> = [];
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      drawn.push({ x: p.x, z: p.z });
    }
    const expected = decks.flatMap((d) => pilingCentres(d.rect, (x, z) => W.baseGround(x, z)));
    expect(drawn.length).toBe(expected.length);
    drawn.forEach((d, i) => {
      expect(d.x).toBeCloseTo(expected[i]!.x, 4);
      expect(d.z).toBeCloseTo(expected[i]!.z, 4);
    });
    expect(drawn.length).toBeGreaterThan(30);
    // CPU twin of seaPilingFoam's nearest lattice point: probing 0.4 m from each centre finds that piling.
    const nearest = (x: number, z: number) => {
      let best = Infinity;
      for (const d of decks) {
        const rr = d.rect;
        if (x < rr.minX - 2 || x > rr.maxX + 2 || z < rr.minZ - 2 || z > rr.maxZ + 2) continue;
        const last = Math.floor((rr.maxX - rr.minX - PILING_START - 1e-3) / PILING_STEP);
        const k = Math.min(last, Math.max(0, Math.floor((x - rr.minX - PILING_START) / PILING_STEP + 0.5)));
        const z0 = rr.minZ + PILING_INSET;
        const z1 = rr.maxZ - PILING_INSET;
        best = Math.min(best, Math.hypot(x - (rr.minX + PILING_START + PILING_STEP * k), z - (Math.abs(z - z0) < Math.abs(z - z1) ? z0 : z1)));
      }
      return best;
    };
    for (const c of drawn) {
      for (const [dx, dz] of [[0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) {
        const side = nearest(c.x + dx!, c.z + dz!) - PILING_RADIUS;
        expect(side).toBeCloseTo(0.4 - PILING_RADIUS, 4);
        // With the noise at its lowest the band still reaches 0.3 m * 0.55 past the side.
        expect(side).toBeLessThan(0.3 * 0.55);
      }
    }
    expect(SHORE_GLSL).toContain('max(max(beach, quay), seaPilingFoam(p, noise, px))');
    expect(PILING_FOAM).toBeLessThanOrEqual(0.7);
    // Far off the ring widens with the pixel footprint (fix pass 2: at audit-15 range it had thinned to a faint arc),
    // and foam's sky light is lifted so it stays white in a deck's shadow.
    expect(SHORE_GLSL).toContain(`min(${PILING_FOAM_PX} * px, ${PILING_FOAM_FAR})`);
    expect(PILING_FOAM_FAR).toBeGreaterThan(PILING_FOAM);
    const fs = compiled(r.env.water.material as THREE.MeshStandardMaterial).fragmentShader;
    expect(fs).toContain('seaFoam( vSeaXZ, seaDepth, seaNoise, uSeaAmp, length( fwidth( vSeaXZ ) ) )');
    expect(fs).toContain(`reflectedLight.indirectDiffuse *= 1.0 + ${FOAM_SKY_LIFT} * seaFoamAmt;`);
  });

  it('the beach foam hugs the waterline: the surf bands fade in seaward of the swash\'s furthest surge', () => {
    // Depth (m) on the sand slope at a distance (m) out from the waterline; the swash's surge at sea states up to 0.5.
    const slope = SAND_DROP / BEACH_W;
    const swashMax = (sea: number) => (0.04 + 0.06 * sea) * 1.25;
    for (const sea of [0, 0.3, 0.5]) expect(swashMax(sea)).toBeLessThan(SURF_BAND_FADE[0]);
    expect(swashMax(0.3) / slope).toBeLessThan(2.6);
    expect(SURF_BAND_FADE[0] / slope).toBeGreaterThan(4);
    expect(SHORE_GLSL).toContain(`smoothstep(${SURF_BAND_FADE[0]}, ${SURF_BAND_FADE[1]}, depth)`);
    expect(SHORE_GLSL).toContain('float surge = 0.5 + 0.5 * sin(uSurfPhase');
  });

  it('waves damp over the shallows so the drawn waterline stays on the sim\'s', () => {
    const r = renderer('high');
    const vs = compiled(r.env.water.material as THREE.MeshStandardMaterial).vertexShader;
    expect(vs).toContain(`seaDisplaceEdge( seaBase.xz, aEdge ) * mix( ${SHORE_DAMP}, 1.0, smoothstep( 0.0, 2.0, seaDepthAt( seaBase.xz ) ) )`);
  });
});

describe('budget and lifecycle (VAL-GND-010)', () => {
  it('ground layers stay merged: one mesh per surface plus one decal draw for the whole map', () => {
    const c = new CityView(world(), 256);
    for (const n of ['roads', 'road-gutters', 'sidewalks', 'curbs', 'markings-white', 'markings-yellow', 'street-ironwork', 'ground-plaza', 'ground-grass', 'ground-asphalt', 'beach', 'road-decals']) expect(meshes(c.group, n), n).toHaveLength(1);
  });

  it('tier switches rebuild no ground material, geometry or texture', () => {
    const r = renderer('high');
    const mats = [...r.city.ground.materials];
    const tex = [...r.city.ground.textures];
    const geos = ['roads', 'sidewalks', 'beach'].map((n) => mesh(r.city, n).geometry);
    for (const q of ['medium', 'low', 'high', 'low', 'high'] as const) r.setQuality(q);
    expect(r.city.ground.materials).toEqual(mats);
    expect([...r.city.ground.textures]).toEqual(tex);
    expect(['roads', 'sidewalks', 'beach'].map((n) => mesh(r.city, n).geometry)).toEqual(geos);
    r.dispose();
  });
});
