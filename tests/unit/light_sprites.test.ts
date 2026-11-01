// Night lights: vehicle lamp glows, the headlights' light on the ground, wet-road streaks (render/lightSprites.ts), and street
// lamps with a luminaire head whose every part goes when the lamp is knocked down. Headless, with the stub header of
// r2_vehicles.test.ts: a tiny canvas/document stub and a fake WebGLRenderer.

import * as THREE from 'three';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GLOW, glowLuminance, HEADLIGHTS, LightSprites, poolFragment, poolShape, POOL_LENGTH, POOL_LIGHT, POOL_PAINT, POOL_RANGE, POOL_START, POOL_WIDTH, waterFresnel, type GlowKind, type LampGlow } from '../../src/render/lightSprites';
import { LAMP_HEAD, PropsView } from '../../src/render/props';
import { COUNTRY_FOG_MARGIN } from '../../src/render/quality';
import { GameRenderer } from '../../src/render/renderer';
import { StreetLighting } from '../../src/render/streetLighting';
import { VehicleView } from '../../src/render/vehicleView';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import type { StaticWorld } from '../../src/world/staticWorld';
import { input, makeSim, placeInCar, world } from './helpers';

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
    readonly coordinateSystem = actual.WebGLCoordinateSystem;
    autoClear = true;
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
    setRenderTarget(): void {}
    getActiveCubeFace(): number {
      return 0;
    }
    getActiveMipmapLevel(): number {
      return 0;
    }
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const DT = 1 / 60;
const HDR = { renderer: '', halfFloat: true };
const SOFT = { renderer: 'Google SwiftShader', halfFloat: true };
const canvas = (): HTMLCanvasElement => document.createElement('canvas') as unknown as HTMLCanvasElement;

let W: StaticWorld;
beforeAll(() => {
  W = world();
});

/** A clear spot on the beach, away from buildings. */
function spot(sim: Sim): { x: number; z: number } {
  const b = sim.world.layout.bounds;
  return { x: b.beachStartX + 30, z: (b.landMinZ + b.landMaxZ) / 2 };
}

function glowsOf(view: VehicleView): LampGlow[] {
  const out: LampGlow[] = [];
  const n = view.lampWorldPositions(out);
  return out.slice(0, n);
}

function kinds(view: VehicleView): Partial<Record<GlowKind, number>> {
  const c: Partial<Record<GlowKind, number>> = {};
  for (const g of glowsOf(view)) c[g.kind] = (c[g.kind] ?? 0) + 1;
  return c;
}

function driven(sim: Sim, kind: Vehicle['kind'] = 'sedan'): { v: Vehicle; view: VehicleView } {
  const p = spot(sim);
  const v = sim.spawnVehicle(kind, p.x, p.z, 0);
  placeInCar(sim, v);
  const view = new VehicleView(kind);
  view.bind(v);
  return { v, view };
}

describe('lamp glows', () => {
  it('every glow stays under the bloom threshold, and the brake glow is at least 1.5 times the running one', () => {
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    const threshold = (r as unknown as { bloom: UnrealBloomPass }).bloom.threshold;
    expect(threshold).toBe(2.6);
    for (const k of Object.keys(GLOW) as GlowKind[]) {
      expect(glowLuminance(k), k).toBeLessThan(threshold);
      expect(glowLuminance(k), k).toBeGreaterThan(0.1);
    }
    expect(glowLuminance('brake')).toBeGreaterThanOrEqual(1.5 * glowLuminance('tail'));
    // Reverse lamps are white, tail and brake lamps red.
    const [rr, rg, rb] = GLOW.reverse.color;
    expect(Math.min(rr, rg, rb) / Math.max(rr, rg, rb)).toBeGreaterThan(0.9);
    for (const k of ['tail', 'brake'] as const) expect(GLOW[k].color[0]).toBeGreaterThan(10 * GLOW[k].color[1]);
    r.dispose();
  });

  it('at night: head and tail glows, brake glows while braking, reverse glows while reversing; by day only brake and reverse', () => {
    const sim = makeSim({ world: W });
    const { v, view } = driven(sim);
    view.sync(v, DT, 0, 1);
    expect(kinds(view)).toEqual({ head: 2, tail: 2 });
    v.braking = true;
    view.sync(v, DT, 0, 1);
    expect(kinds(view)).toEqual({ head: 2, brake: 2 });
    v.braking = false;
    v.reversing = true;
    view.sync(v, DT, 0, 1);
    expect(kinds(view)).toEqual({ head: 2, tail: 2, reverse: 1 });
    v.reversing = false;
    view.sync(v, DT, 0, 0);
    expect(kinds(view)).toEqual({});
    v.braking = true;
    view.sync(v, DT, 0, 0);
    expect(kinds(view)).toEqual({ brake: 2 });
  });

  it('glows sit on their lamps in world space and face the way the lamp shines', () => {
    const sim = makeSim({ world: W });
    const { v, view } = driven(sim);
    v.heading = 0.7;
    view.sync(v, DT, 0, 1);
    view.group.updateMatrixWorld(true);
    const lamps = view.group.children.filter((o) => o.name === 'lamp');
    for (const g of glowsOf(view)) {
      const near = lamps.some((l) => l.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(g.x, g.y, g.z)) < 1e-4);
      expect(near, g.kind).toBe(true);
      const sign = g.kind === 'head' ? 1 : -1;
      expect(g.fx).toBeCloseTo(sign * Math.sin(0.7), 3);
      expect(g.fz).toBeCloseTo(sign * Math.cos(0.7), 3);
    }
  });

  it('a smashed lamp loses its glow (through the dent path) and a wreck has none', () => {
    const sim = makeSim({ world: W });
    const { v, view } = driven(sim);
    v.braking = true;
    view.sync(v, DT, 0, 1);
    expect(kinds(view).brake).toBe(2);
    // Rear left corner (local +X is the left side): smashes that tail lamp only.
    v.dents.push({ lx: v.halfW, ly: 0.5 * v.spec.height, lz: -v.halfL, nx: -0.6, nz: 0.8, depth: 0.2 });
    v.dentVersion++;
    view.sync(v, DT, 0, 1);
    expect(kinds(view).brake).toBe(1);
    expect(kinds(view).head).toBe(2);
    v.dents.push({ lx: -v.halfW, ly: 0.5 * v.spec.height, lz: -v.halfL, nx: 0.6, nz: 0.8, depth: 0.2 });
    v.dentVersion++;
    view.sync(v, DT, 0, 1);
    expect(kinds(view).brake ?? 0).toBe(0);
    v.destroyed = true;
    view.sync(v, DT, 0, 1);
    expect(glowsOf(view).length).toBe(0);
  });

  it('a police car with its siren on shows one light-bar glow, alternating red and blue', () => {
    const sim = makeSim({ world: W });
    const { v, view } = driven(sim, 'police');
    v.siren = true;
    view.sync(v, DT, 0.05, 1);
    expect(kinds(view).sirenRed).toBe(1);
    view.sync(v, DT, 0.22, 1);
    expect(kinds(view).sirenBlue).toBe(1);
    v.siren = false;
    view.sync(v, DT, 0.05, 1);
    expect(kinds(view).sirenRed ?? 0).toBe(0);
  });

  it('LightSprites dims a glow turned away from the camera and drops one beyond its range', () => {
    const ls = new LightSprites();
    ls.begin(new THREE.Vector3(0, 1, 10), 800);
    expect(ls.addGlow({ kind: 'head', x: 0, y: 1, z: 0, fx: 0, fz: 1 })).toBe(true);
    expect(ls.addGlow({ kind: 'head', x: 0, y: 1, z: 0, fx: 0, fz: -1 })).toBe(false);
    expect(ls.addGlow({ kind: 'sirenRed', x: 0, y: 1, z: 0, fx: 0, fz: 0 })).toBe(true);
    expect(ls.addGlow({ kind: 'tail', x: 500, y: 1, z: 0, fx: 0, fz: 0 })).toBe(false);
    ls.finish(() => 0);
    expect(ls.counts.glows).toBe(2);
    expect(ls.glows.geometry.drawRange.count).toBe(2);
    ls.dispose();
  });
});

describe('headlight pools', () => {
  /** The headlights the ground's shading gets: per car its bumper, strength, heading and rise (LightSprites.headlights). */
  const lit = (ls: LightSprites) => {
    const { uHeadA: a, uHeadB: b, uHeadCount: n } = ls.headlights;
    return Array.from({ length: n.value }, (_, i) => ({ x: a.value[i * 4]!, y: a.value[i * 4 + 1]!, z: a.value[i * 4 + 2]!, k: a.value[i * 4 + 3]!, fx: b.value[i * 4]!, fz: b.value[i * 4 + 1]!, rise: b.value[i * 4 + 2]! }));
  };

  it('lights the ground by the HEADLIGHTS nearest cars, the farthest of them fading out towards the next one', () => {
    const ls = new LightSprites();
    expect(ls.pools).toBeNull();
    ls.begin(new THREE.Vector3(0, 2, 0), 800);
    // 60 cars at shuffled distances 3, 6, .. 180 m (those past POOL_RANGE are never kept).
    const ds = Array.from({ length: 60 }, (_, i) => (((i * 37) % 60) + 1) * 3);
    for (const d of ds) ls.offerPool(d, 0, 0, 1);
    ls.finish(() => 0);
    expect(ls.counts.pools).toBe(HEADLIGHTS);
    const cars = lit(ls);
    expect(cars.map((c) => c.x)).toEqual(Array.from({ length: HEADLIGHTS }, (_, i) => (i + 1) * 3));
    // Full strength well inside the cut (the next car, 27 m out); fading over the last POOL_FADE m before it.
    expect(cars[0]!.k).toBeCloseTo(1, 6);
    expect(cars[HEADLIGHTS - 1]!.k).toBeLessThan(0.3);
    for (let i = 1; i < HEADLIGHTS; i++) expect(cars[i]!.k).toBeLessThanOrEqual(cars[i - 1]!.k);
    // Heading north (0): forward is +z, on flat ground.
    expect(cars[0]).toMatchObject({ y: 0, fx: 0, fz: 1, rise: 0 });
    ls.dispose();
  });

  it('a car swapping places with the next one past the nearest few does not pop: its light is nearly gone either side', () => {
    const ls = new LightSprites();
    const strengthOf = (x: number): number => {
      ls.begin(new THREE.Vector3(0, 2, 0), 800);
      for (let i = 1; i < HEADLIGHTS; i++) ls.offerPool(i, 0, 0, 1);
      ls.offerPool(40, 0, 0, 1);
      ls.offerPool(x, 0, 0, 1);
      ls.finish(() => 0);
      return lit(ls).find((c) => c.x === x)?.k ?? 0;
    };
    expect(strengthOf(39.9)).toBeLessThan(0.01);
    expect(strengthOf(40.1)).toBe(0);
    // With few cars about, the light fades out at POOL_RANGE instead.
    ls.begin(new THREE.Vector3(0, 2, 0), 800);
    ls.offerPool(POOL_RANGE - 0.5, 0, 0, 1);
    ls.offerPool(20, 0, 0, 1);
    ls.finish(() => 0);
    expect(lit(ls).map((c) => c.k)).toEqual([1, expect.closeTo(0.00725, 4)]);
    ls.dispose();
  });

  it('follows the ground: its height under the bumper and its rise ahead, and past a drop it tips down 1.5 m at most', () => {
    const ls = new LightSprites();
    const end = POOL_START + POOL_LENGTH;
    for (const [ground, y, rise] of [
      [(_x: number, z: number) => 2 + z * 0.1, 2, 0.1],
      [(_x: number, z: number) => (z > 10 ? -4 : 1), 1, -1.5 / end],
    ] as const) {
      ls.begin(new THREE.Vector3(0, 2, -10), 800);
      ls.offerPool(0, 0, 0, 1);
      ls.finish(ground);
      expect(lit(ls)[0]!.y).toBeCloseTo(y, 6);
      expect(lit(ls)[0]!.rise).toBeCloseTo(rise, 6);
    }
    ls.dispose();
  });

  it('on every hardware tier the same HEADLIGHTS cars light the ground, on the software tier as many are painted, and none at noon', () => {
    const sim = makeSim({ world: W });
    const p = spot(sim);
    for (let i = 0; i < 50; i++) {
      const v = sim.spawnVehicle('sedan', p.x + (i % 5) * 4, p.z + Math.floor(i / 5) * 7, 0);
      if (i === 0) placeInCar(sim, v);
      else sim.seat(sim.spawnCharacter('civilian', v.pos.x, v.pos.z), v, 0);
    }
    sim.clock.set(23);
    for (const [gpu, name] of [[HDR, 'hardware'], [SOFT, 'software']] as const) {
      const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu });
      r.attach(sim);
      r.cameraCtl.mode = 'play';
      r.cameraCtl.reset(sim);
      const frame = (): ReturnType<GameRenderer['stats']> => {
        r.render(0, false);
        return r.stats();
      };
      for (const q of name === 'hardware' ? (['high', 'medium', 'low'] as const) : (['low'] as const)) {
        r.setQuality(q);
        const s = frame();
        expect(s.pools, `${name} ${q}`).toBe(HEADLIGHTS);
        expect(s.glows, `${name} ${q}`).toBeGreaterThanOrEqual(90);
        expect(r.lightSprites.pools?.count ?? 0, `${name} ${q}`).toBe(name === 'software' ? HEADLIGHTS : 0);
      }
      sim.clock.set(12);
      expect(frame().pools, name).toBe(0);
      sim.clock.set(23);
      r.dispose();
    }
  });

  it("the player's own car lights the ground like any other car's on every tier (its spot, where there is one, lights what stands ahead)", () => {
    const sim = makeSim({ world: W });
    sim.clock.set(23);
    const { v } = driven(sim);
    for (const u of sim.vehicles) if (u !== v && Math.hypot(u.pos.x - v.pos.x, u.pos.z - v.pos.z) < 200) sim.removeVehicle(u);
    expect(sim.player.vehicle).toBe(v);
    const r = new GameRenderer(canvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    r.cameraCtl.reset(sim);
    for (const q of ['low', 'medium', 'high'] as const) {
      r.setQuality(q);
      r.render(0, false);
      expect(r.stats().pools, q).toBe(1);
      const own = lit(r.lightSprites)[0]!;
      // At the front bumper, on the road, facing the car's way, at full strength.
      expect((own.x - v.pos.x) * Math.sin(v.heading) + (own.z - v.pos.z) * Math.cos(v.heading), q).toBeCloseTo(v.halfL, 3);
      expect(own.y, q).toBeCloseTo(sim.world.groundHeight(own.x, own.z), 6);
      expect(own.fx, q).toBeCloseTo(Math.sin(v.heading), 6);
      expect(own.k, q).toBeCloseTo(1, 3);
    }
    r.dispose();
  });

  it('dark weather turns lights on by day, and clear weather turns them off again', () => {
    const sim = makeSim({ world: W });
    sim.clock.set(13);
    driven(sim);
    const r = new GameRenderer(canvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    r.cameraCtl.reset(sim);
    const frame = () => {
      sim.update(DT, input());
      r.render(DT, false);
      return r.stats();
    };
    const clear = frame();
    expect(clear.pools).toBe(0);
    for (const kind of ['rain', 'storm'] as const) {
      sim.weather.override(kind, 0);
      const dark = frame();
      expect(sim.weather.state.dim).toBeGreaterThanOrEqual(0.5);
      expect(r.weatherDim).toBe(sim.weather.state.dim);
      expect(dark.pools, kind).toBeGreaterThan(0);
      expect(dark.glows, kind).toBeGreaterThan(clear.glows);
    }
    sim.weather.override('cloudy', 0);
    expect(frame().pools).toBe(0);
    sim.weather.override(null, 0);
    expect(frame().pools).toBe(0);
    r.dispose();
  });
});

/** The physical material's shaders after `mat`'s onBeforeCompile, and the uniforms it added. */
function compiled(mat: THREE.Material): { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> } {
  const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, defines: {} };
  mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as unknown as THREE.WebGLRenderer);
  return shader;
}

/** A mesh within this many metres of the world's ground (up or down) lies on it. */
const GROUND_NEAR = 0.6;
/** A mesh with this many square metres of ground surface is ground, not the sill of a door. */
const MIN_GROUND_AREA = 100;

/** The area (m2) of `mesh`'s level triangles that lie on the world's ground: what a car drives or a person walks on. */
function levelGroundArea(mesh: THREE.Mesh, w: StaticWorld): number {
  const pos = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.getIndex();
  const [a, b, c, n, mid] = [0, 1, 2, 3, 4].map(() => new THREE.Vector3());
  const tri = new THREE.Triangle(a, b, c);
  let area = 0;
  for (let t = 0; t < (index ? index.count : pos.count) / 3; t++) {
    const at = (k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);
    a!.fromBufferAttribute(pos, at(0)).applyMatrix4(mesh.matrixWorld);
    b!.fromBufferAttribute(pos, at(1)).applyMatrix4(mesh.matrixWorld);
    c!.fromBufferAttribute(pos, at(2)).applyMatrix4(mesh.matrixWorld);
    tri.getNormal(n!);
    if (Math.abs(n!.y) < 0.9) continue;
    tri.getMidpoint(mid!);
    if (Math.abs(mid!.y - w.groundHeight(mid!.x, mid!.z)) <= GROUND_NEAR) area += tri.getArea();
  }
  return area;
}

describe("a headlight pool's light", () => {
  it("is a light in the ground's own shading: it adds the albedo times its irradiance, whatever light the ground already has", () => {
    const ls = new LightSprites();
    const mat = new THREE.MeshStandardMaterial();
    ls.lightGround([mat]);
    const { fragmentShader: fs, uniforms } = compiled(mat);
    // Added after every other light is in, to the direct diffuse light: the albedo (BRDF_Lambert) times the irradiance.
    const at = fs.indexOf('#include <lights_fragment_end>');
    const block = fs.slice(at, fs.indexOf('#include <aomap_fragment>'));
    expect(block).toContain(`reflectedLight.directDiffuse += BRDF_Lambert( material.diffuseColor ) * vec3( ${POOL_LIGHT.map((c) => c.toFixed(3)).join(', ')} ) * headE;`);
    // The irradiance comes from the uniforms, the position and the normal alone: never from the light already on the
    // ground, so the same headlights add the same light to a dark county road and to lamp-lit asphalt.
    const headE = block.slice(block.indexOf('float headE'), block.indexOf('reflectedLight.directDiffuse +='));
    expect(headE).not.toMatch(/reflectedLight|outgoingLight|irradiance|totalDiffuse/);
    // One shared uniform set: the cars move, no program changes.
    expect(uniforms.uHeadA).toBe(ls.headlights.uHeadA);
    expect(uniforms.uHeadCount).toBe(ls.headlights.uHeadCount);
    expect(fs).toContain(`uniform vec4 uHeadA[ ${HEADLIGHTS} ];`);
    expect(mat.customProgramCacheKey()).toContain('gta7-headlights');
    ls.dispose();
  });

  it('lights every surface a car drives or a person walks on, once, and keeps the patches that surface already had', () => {
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    r.scene.updateMatrixWorld(true);
    // The static ground, found by its geometry and not by a list of names: a mesh with MIN_GROUND_AREA m2 of level surface
    // within GROUND_NEAR m of the world's ground, which a new road, track, field or ramp would be too. It must take the
    // headlights unless it is on the short list of what stays dark by design.
    const dark: Record<string, string> = {
      'ground-decor': 'the street decor (planters, steps, porches), in the buildings\' fog program, a few square metres at each shop',
    };
    const ground = new Map<string, THREE.Material>();
    const unlit: string[] = [];
    for (const root of [r.city.group, r.country.group]) {
      root.traverse((o) => {
        // An unlit material (the drive-in's glow) has no light to add to; instanced plants are not the ground.
        if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh || !(o.material instanceof THREE.MeshStandardMaterial)) return;
        if (levelGroundArea(o, W) < MIN_GROUND_AREA) return;
        ground.set(o.name, o.material);
        const lit = o.material.customProgramCacheKey().includes('gta7-headlights');
        if (!lit && !(o.name in dark)) unlit.push(o.name);
      });
    }
    expect(unlit).toEqual([]);
    // The walk finds what it should: the roads and their ironwork, tracks, fields, ramps and the lawns and sand.
    for (const name of ['roads', 'street-ironwork', 'sidewalks', 'country-roads', 'country-grass', 'beach', 'farm-dirt', 'field-wheat', 'field-soil', 'ramps']) expect([...ground.keys()], name).toContain(name);
    for (const [name, mat] of ground) {
      if (name in dark) continue;
      const { fragmentShader: fs } = compiled(mat);
      expect(fs.split('float headE').length - 1, name).toBe(1);
      expect(mat.customProgramCacheKey().split('gta7-headlights').length - 1, name).toBe(1);
    }
    // The patches already there stay: the road's wetness and surface detail, the ironwork's wetness, the wheat's ripples.
    const road = compiled(ground.get('roads')!).fragmentShader;
    expect(road).toContain('wetK');
    expect(road).toContain('gRough');
    expect(compiled(ground.get('street-ironwork')!).fragmentShader).toContain('wetK');
    const wheat = ground.get('field-wheat')!;
    expect(compiled(wheat).fragmentShader).toContain('uWindAmp');
    expect(wheat.customProgramCacheKey()).toContain('gta7-wheat-field');
    r.dispose();
  });

  it("is painted on the software tier's 8-bit canvas, which has no ground shading to light, toned down to the hardware tiers' light", () => {
    const paint = new LightSprites(true);
    expect(paint.pools!.material.blending).toBe(THREE.AdditiveBlending);
    const fs = poolFragment();
    expect(fs).toContain('tonemapping_fragment');
    expect(fs).toContain('colorspace_fragment');
    expect(fs).toContain('USE_FOG');
    // Warm like the light, and at its brightest a fraction of white (the road there reads lit, not shining).
    const top = Math.max(...Array.from({ length: 241 }, (_, i) => poolShape(POOL_START + i / 10, 0.72)));
    expect(POOL_PAINT[0]).toBeGreaterThan(POOL_PAINT[2]);
    expect(POOL_PAINT[0] * top).toBeLessThan(0.3);
    paint.dispose();
    for (const [gpu, name] of [[HDR, 'hardware'], [SOFT, 'software']] as const) {
      const r = new GameRenderer(canvas(), W, { quality: 'low', fov: 68, gpu });
      expect(r.lightSprites.pools === null, name).toBe(name === 'hardware');
      // The software tier's ground keeps its plain materials: nothing patched in.
      expect(r.city.ground.materials.some((m) => m.customProgramCacheKey().includes('gta7-headlights')), name).toBe(name === 'hardware');
      r.dispose();
    }
  });

  it('is brightest a few metres past the bumper and then falls away smoothly to nothing, with no plateau', () => {
    const end = POOL_START + POOL_LENGTH;
    const axis = (d: number): number => poolShape(d, 0);
    const ds = Array.from({ length: Math.round(POOL_LENGTH * 10) + 1 }, (_, i) => POOL_START + i / 10);
    // The brightest ground anywhere (under a lamp's lobe, near) and the brightest down the middle (where the lobes have merged).
    const top = Math.max(...ds.map((d) => Math.max(axis(d), poolShape(d, 0.72))));
    const middle = ds.reduce((best, d) => (axis(d) > axis(best) ? d : best));
    // Nothing at the near end (the road under the nose) nor at the far end.
    expect(poolShape(POOL_START, 0.72)).toBe(0);
    expect(poolShape(end, 0)).toBe(0);
    expect(middle - POOL_START).toBeGreaterThan(2);
    expect(middle - POOL_START).toBeLessThan(8);
    // Two metres past the middle's peak it falls at every metre, by at least 3 % of the top each (a plateau is flat; this
    // slopes the whole way), until the last eight metres, where the tail runs out to nothing.
    for (let d = middle + 2; d + 1 <= end - 8; d += 1) {
      expect(axis(d + 1), `d ${d}`).toBeLessThan(axis(d));
      expect(axis(d) - axis(d + 1), `d ${d}`).toBeGreaterThan(0.03 * top);
    }
    // Half the top is gone 11 m on, nearly all by 3 m before the far end.
    expect(axis(middle + 11)).toBeLessThan(0.5 * top);
    expect(axis(end - 3)).toBeLessThan(0.1 * top);
  });

  it('is two lobes, one per lamp, just ahead of the bumper, which run into one a few metres on, and the sides are soft', () => {
    // Near: the light is brighter under each lamp than between them, and the two lobes are mirror images.
    const near = POOL_START + 2;
    expect(poolShape(near, 0.72)).toBeGreaterThan(1.2 * poolShape(near, 0));
    expect(poolShape(near, -0.72)).toBeCloseTo(poolShape(near, 0.72), 9);
    expect(poolShape(near, 0.72)).toBeGreaterThan(poolShape(near, 1.6));
    // Far: one lobe, brightest in the middle.
    const far = POOL_START + 12;
    expect(poolShape(far, 0)).toBeGreaterThanOrEqual(poolShape(far, 0.72));
    expect(poolShape(far, 0.72)).toBeGreaterThan(poolShape(far, 1.6));
    // The sides fall off over metres, not at an edge: each step of a quarter metre changes the light by a fraction of the peak.
    const top = poolShape(POOL_START + 5, 0.72);
    let prev = poolShape(far, 0);
    for (let x = 0.25; x <= POOL_WIDTH / 2; x += 0.25) {
      const here = poolShape(far, x);
      expect(prev - here, `x ${x}`).toBeLessThan(0.2 * top);
      expect(here, `x ${x}`).toBeLessThanOrEqual(prev + 1e-9);
      prev = here;
    }
    // Nothing at the decal's edge.
    for (const d of [POOL_START + 3, POOL_START + 8, POOL_START + 14]) expect(poolShape(d, POOL_WIDTH / 2)).toBe(0);
  });

  it('is warm', () => {
    expect(POOL_LIGHT[0]).toBeGreaterThan(POOL_LIGHT[1]);
    expect(POOL_LIGHT[1]).toBeGreaterThan(POOL_LIGHT[2]);
  });
});

describe('wet-road streaks', () => {
  it('are drawn only on a wet road', () => {
    const ls = new LightSprites();
    const cam = new THREE.Vector3(0, 2, 15);
    const run = (): number => {
      ls.begin(cam, 800);
      ls.addGlow({ kind: 'tail', x: 0, y: 0.8, z: 0, fx: 0, fz: 1 });
      ls.addGlow({ kind: 'tail', x: 1.2, y: 0.8, z: 0, fx: 0, fz: 1 });
      ls.finish(() => 0);
      return ls.counts.streaks;
    };
    expect(run()).toBe(0);
    ls.wet = 1;
    expect(run()).toBe(2);
    ls.dispose();
  });

  it('mirror a light as water does: faint where the camera looks down on the mirror point, full at grazing angles', () => {
    expect(waterFresnel(1)).toBeCloseTo(0.02, 9);
    expect(waterFresnel(0)).toBeCloseTo(1, 9);
    /** The red of the streak under a lamp head 6.2 m up, `d` m from a camera 2.5 m up. */
    const streak = (d: number): number => {
      const ls = new LightSprites();
      ls.wet = 1;
      ls.begin(new THREE.Vector3(0, 2.5, 0), 800);
      ls.offerStreakLight(0, 6.2, d, 0.6, 0.5, 0.3);
      ls.finish(() => 0);
      const c = new THREE.Color();
      ls.streaks.getColorAt(0, c);
      ls.dispose();
      return c.r;
    };
    // A lamp 30 m down the street and farther: the reflectance has passed STREAK_FRESNEL, the streak is the full 0.5 x wetness.
    expect(streak(30)).toBeCloseTo(0.3, 2);
    expect(streak(55)).toBeCloseTo(0.3, 6);
    // A lamp 14 m off, the camera looking down at 58 degrees off the vertical: a fifth of that, and ever less nearer.
    expect(streak(14)).toBeLessThan(0.25 * streak(30));
    expect(streak(14)).toBeGreaterThan(0.15 * streak(30));
    expect(streak(13)).toBeLessThan(streak(14));
  });
});

describe('street lamp luminaires', () => {
  function lampParts(props: PropsView): Map<string, THREE.InstancedMesh[]> {
    const parts = new Map<string, THREE.InstancedMesh[]>();
    props.group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh) || !o.geometry.name.startsWith('lamp-')) return;
      const l = parts.get(o.geometry.name) ?? [];
      l.push(o);
      parts.set(o.geometry.name, l);
    });
    return parts;
  }

  it('pole (with plinth and arm), head and lens: one instance each per lamp, the head a housing longer than wide', () => {
    const lamps = W.layout.props.filter((p) => p.kind === 'lamp').length;
    const props = new PropsView(W);
    const parts = lampParts(props);
    expect([...parts.keys()].sort()).toEqual(['lamp-head', 'lamp-lens', 'lamp-pole']);
    for (const [name, meshes] of parts) expect(meshes.reduce((n, m) => n + m.count, 0), name).toBe(lamps);
    const head = parts.get('lamp-head')![0]!.geometry;
    head.computeBoundingBox();
    const size = head.boundingBox!.getSize(new THREE.Vector3());
    expect(size.z).toBeGreaterThan(0.5);
    expect(size.z).toBeLessThan(1);
    expect(size.z).toBeGreaterThan(1.8 * size.x);
    // The lens's underside is the shared head point, under the middle of the housing.
    const lens = parts.get('lamp-lens')![0]!.geometry;
    lens.computeBoundingBox();
    expect(lens.boundingBox!.min.y).toBeCloseTo(LAMP_HEAD.y, 6);
    expect((lens.boundingBox!.min.z + lens.boundingBox!.max.z) / 2).toBeCloseTo(LAMP_HEAD.reach, 6);
    expect((head.boundingBox!.min.z + head.boundingBox!.max.z) / 2).toBeCloseTo(LAMP_HEAD.reach, 6);
    // Light metal that reads by day.
    const mat = parts.get('lamp-pole')![0]!.material as THREE.MeshStandardMaterial;
    expect(mat.color.getHSL({ h: 0, s: 0, l: 0 }).l).toBeGreaterThan(0.25);
  });

  it('halo, light pool and street-light spot all sit straight under the head', () => {
    const props = new PropsView(W);
    const idx = W.layout.props.findIndex((p) => p.kind === 'lamp');
    const p = W.layout.props[idx]!;
    const hx = p.x + Math.sin(p.rot) * LAMP_HEAD.reach * p.scale;
    const hz = p.z + Math.cos(p.rot) * LAMP_HEAD.reach * p.scale;
    const halos = props.group.getObjectByName('lampHalos') as THREE.Points;
    const pos = halos.geometry.getAttribute('position');
    let k = 0;
    while (Math.hypot(pos.getX(k) - hx, pos.getZ(k) - hz) > 1e-3 && k < pos.count) k++;
    expect(k).toBeLessThan(pos.count);
    expect(LAMP_HEAD.y * p.scale + p.y - pos.getY(k)).toBeGreaterThan(0);
    expect(LAMP_HEAD.y * p.scale + p.y - pos.getY(k)).toBeLessThan(0.15);
    // The pool under it.
    let found = false;
    const m = new THREE.Matrix4();
    const at = new THREE.Vector3();
    props.group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh) || !(o.material instanceof THREE.MeshBasicMaterial) || !o.material.map) return;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        at.setFromMatrixPosition(m);
        if (Math.hypot(at.x - hx, at.z - hz) < 1e-4) found = true;
      }
    });
    expect(found, 'a light pool centred under the head').toBe(true);
    const lighting = new StreetLighting(W);
    const cam = new THREE.Vector3(p.x, p.y + 2, p.z);
    for (let i = 0; i < 8; i++) lighting.update(cam, 1, 0.1);
    const spots = lighting.group.children.filter((c): c is THREE.SpotLight => c instanceof THREE.SpotLight);
    const s = spots.find((l) => Math.hypot(l.position.x - hx, l.position.z - hz) < 1e-6);
    expect(s).toBeDefined();
    expect(s!.position.y).toBeLessThan(p.y + LAMP_HEAD.y * p.scale);
    expect(s!.position.y).toBeGreaterThan(p.y + (LAMP_HEAD.y - 0.15) * p.scale);
  });

  it('breakProp zeroes every part of a lamp, its halo too, and leaves its neighbours alone', () => {
    const props = new PropsView(W);
    const lamps = W.layout.props.flatMap((p, i) => (p.kind === 'lamp' ? [i] : []));
    const target = lamps[3]!;
    const neighbour = lamps[4]!;
    const refs = (props as unknown as { refs: Map<number, Array<{ mesh: THREE.InstancedMesh; index: number }>> }).refs;
    // Pole, head, lens and light pool.
    expect(refs.get(target)!.length).toBe(4);
    props.breakProp(target, 1, 0);
    const m = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const zero = (pi: number) => refs.get(pi)!.every((r) => {
      r.mesh.getMatrixAt(r.index, m);
      return scale.setFromMatrixScale(m).length() === 0;
    });
    expect(zero(target)).toBe(true);
    expect(refs.get(neighbour)!.some((r) => {
      r.mesh.getMatrixAt(r.index, m);
      return scale.setFromMatrixScale(m).length() > 0;
    })).toBe(true);
    const halos = props.group.getObjectByName('lampHalos') as THREE.Points;
    const c = halos.geometry.getAttribute('color');
    const hi = (props as unknown as { lampHaloIndex: Map<number, number> }).lampHaloIndex.get(target)!;
    expect(c.getX(hi) + c.getY(hi) + c.getZ(hi)).toBe(0);
    props.restoreAll();
    expect(zero(target)).toBe(false);
  });
});

describe('Las Lomas County at night', () => {
  it("its reflector posts shine back at the player's lit car, only ahead of it and only at night", () => {
    const sim = makeSim({ world: W });
    for (const u of [...sim.vehicles]) sim.removeVehicle(u);
    // North up the Lomas Highway's west leg.
    const v = sim.spawnVehicle('sedan', -1330, 100, Math.PI);
    placeInCar(sim, v);
    const r = new GameRenderer(canvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    r.cameraCtl.reset(sim);
    const glows = (hours: number) => {
      sim.clock.set(hours);
      for (let i = 0; i < 3; i++) r.render(1 / 60, false);
      const ls = r.lightSprites;
      const pos = ls.glows.geometry.getAttribute('position');
      const out: number[] = [];
      for (let i = 0; i < ls.counts.glows; i++) if (Math.abs(pos.getX(i) + 1330) > 6) out.push(pos.getZ(i));
      return out;
    };
    const night = glows(23);
    expect(night.length).toBeGreaterThan(3);
    for (const z of night) expect(z).toBeLessThan(v.pos.z);
    expect(glows(12)).toEqual([]);
    r.dispose();
  });

  it("draws none of the props past the fog while the camera is off the city's land, and on it all of the city's but none of the county's past the fog", () => {
    const sim = makeSim({ world: W });
    sim.clock.set(12);
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    const meshes: THREE.Mesh[] = [];
    r.props.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name !== 'lighthouseBeam') meshes.push(o);
    });
    // A batch of the county's own props alone (from country.firstProp on); a batch that mixes them with the city's is the city's.
    const first = W.layout.country.firstProp;
    const county = (m: THREE.Mesh) => (m.userData.propIndices as number[] | undefined)?.every((i) => i >= first) ?? false;
    const at = (x: number, z: number) => {
      sim.player.pos.x = x;
      sim.player.pos.z = z;
      sim.player.pos.y = W.groundHeight(x, z);
      r.cameraCtl.reset(sim);
      r.render(1 / 60, false);
      return r.cameraCtl.camera.position;
    };
    const off = (m: THREE.Object3D, cam: THREE.Vector3) => {
      const b = new THREE.Box3().setFromObject(m);
      return Math.hypot(Math.max(b.min.x - cam.x, 0, cam.x - b.max.x), Math.max(b.min.z - cam.z, 0, cam.z - b.max.z));
    };
    // At Lookout Point on Coyote Ridge, the whole city 1-2.4 km off.
    let cam = at(-1467.5, -100);
    const reach = r.env.fog.far + COUNTRY_FOG_MARGIN;
    let hidden = 0;
    for (const m of meshes) {
      if (off(m, cam) > reach + 9) {
        expect(m.visible).toBe(false);
        hidden++;
      }
    }
    expect(hidden).toBeGreaterThan(300);
    // In the city every one of the city's props is drawn, as before the county; the county's past the fog are not.
    cam = at(0, 0);
    let far = 0;
    let near = 0;
    for (const m of meshes) {
      if (!county(m)) expect(m.visible).toBe(true);
      else if (off(m, cam) > reach + 9) {
        expect(m.visible).toBe(false);
        far++;
      } else if (off(m, cam) < reach - 9) {
        expect(m.visible).toBe(true);
        near++;
      }
    }
    expect(far).toBeGreaterThan(20);
    expect(near).toBeGreaterThan(5);
    r.dispose();
  });

  it("leaves the activity sites' signs and the interaction markers undrawn past the fog while the camera is off the city's land, and draws them all on it", () => {
    const sim = makeSim({ world: W });
    sim.clock.set(12);
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    const at = (x: number, z: number) => {
      sim.player.pos.x = x;
      sim.player.pos.z = z;
      sim.player.pos.y = W.groundHeight(x, z);
      r.cameraCtl.reset(sim);
      r.render(1 / 60, false);
      return r.cameraCtl.camera.position;
    };
    const signs: THREE.Mesh[] = [];
    r.sites.group.traverse((o) => {
      if (o instanceof THREE.Mesh) signs.push(o);
    });
    const markers = () => r.markers.group.children.filter((g) => g.getObjectByName('beam') && g.getObjectByName('icon'));
    // At Lookout Point every site and marker but Dry Creek's gun shop is in the city, past the fog; the gun shop's marker,
    // 633 m off in the county, is drawn.
    const cam = at(-1467.5, -100);
    const reach = r.env.fog.far + COUNTRY_FOG_MARGIN;
    expect(signs.length).toBeGreaterThan(20);
    for (const m of signs) {
      const b = new THREE.Box3().setFromObject(m);
      expect(Math.hypot(Math.max(b.min.x - cam.x, 0, cam.x - b.max.x), Math.max(b.min.z - cam.z, 0, cam.z - b.max.z))).toBeGreaterThan(reach);
      expect(m.visible).toBe(false);
    }
    expect(markers().length).toBeGreaterThan(10);
    const near = markers().filter((g) => Math.hypot(g.position.x - cam.x, g.position.z - cam.z) <= reach);
    expect(near.length).toBe(1);
    expect(near[0]!.position.x).toBeLessThan(W.bounds.landMinX);
    expect(near[0]!.visible).toBe(true);
    for (const g of markers().filter((q) => !near.includes(q))) expect(g.visible).toBe(false);
    // In the city they are all drawn, as before the county.
    at(0, 0);
    expect(signs.every((m) => m.visible)).toBe(true);
    for (const g of markers()) expect(g.visible || Math.hypot(g.position.x - r.cameraCtl.camera.position.x, g.position.z - r.cameraCtl.camera.position.z) < 5).toBe(true);
    r.dispose();
  });
});
