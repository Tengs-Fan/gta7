// Night lights: vehicle lamp glows, headlight pools on the road, wet-road streaks (render/lightSprites.ts), and street
// lamps with a luminaire head whose every part goes when the lamp is knocked down. Headless, with the stub header of
// r2_vehicles.test.ts: a tiny canvas/document stub and a fake WebGLRenderer.

import * as THREE from 'three';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GLOW, glowLuminance, LightSprites, poolFragment, poolShape, POOL_LENGTH, POOL_LIGHT, POOL_START, POOL_WIDTH, type GlowKind, type LampGlow } from '../../src/render/lightSprites';
import { LAMP_HEAD, PropsView } from '../../src/render/props';
import { COUNTRY_FOG_MARGIN, QUALITY } from '../../src/render/quality';
import { GameRenderer, PLAYER_POOL } from '../../src/render/renderer';
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
  it('keeps the nearest pools first, up to the cap', () => {
    const ls = new LightSprites();
    ls.setPoolCap(QUALITY.high.headlightPools);
    ls.begin(new THREE.Vector3(0, 2, 0), 800);
    // 60 cars at shuffled distances 1..60 m.
    const ds = Array.from({ length: 60 }, (_, i) => ((i * 37) % 60) + 1);
    for (const d of ds) ls.offerPool(d, 0, 0, 1);
    ls.finish(() => 0);
    expect(ls.counts.pools).toBe(40);
    expect(ls.pools.count).toBe(40);
    const xs: number[] = [];
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < 40; i++) {
      ls.pools.getMatrixAt(i, m);
      xs.push(Math.round(p.setFromMatrixPosition(m).x));
    }
    expect(xs.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    ls.dispose();
  });

  it('per tier at night: within High 40 / Medium 24 / Low 12, and none at noon', () => {
    expect([QUALITY.high.headlightPools, QUALITY.medium.headlightPools, QUALITY.low.headlightPools]).toEqual([40, 24, 12]);
    const sim = makeSim({ world: W });
    const p = spot(sim);
    for (let i = 0; i < 50; i++) {
      const v = sim.spawnVehicle('sedan', p.x + (i % 5) * 4, p.z + Math.floor(i / 5) * 7, 0);
      if (i === 0) placeInCar(sim, v);
      else sim.seat(sim.spawnCharacter('civilian', v.pos.x, v.pos.z), v, 0);
    }
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    r.cameraCtl.reset(sim);
    const frame = (): ReturnType<GameRenderer['stats']> => {
      r.render(0, false);
      return r.stats();
    };
    sim.clock.set(23);
    for (const q of ['high', 'medium', 'low'] as const) {
      r.setQuality(q);
      const s = frame();
      expect(s.pools, q).toBe(QUALITY[q].headlightPools);
      expect(s.glows, q).toBeGreaterThanOrEqual(90);
    }
    const night = frame().glows;
    sim.clock.set(12);
    const noon = frame();
    expect(noon.pools).toBe(0);
    expect(noon.glows).toBeLessThan(night);
    r.dispose();
  });

  it("the player's own car lights the road on every tier: a full pool on Low, PLAYER_POOL of one where its headlight spot lights the road too", () => {
    const sim = makeSim({ world: W });
    sim.clock.set(23);
    const { v } = driven(sim);
    for (const u of sim.vehicles) if (u !== v && Math.hypot(u.pos.x - v.pos.x, u.pos.z - v.pos.z) < 200) sim.removeVehicle(u);
    expect(sim.player.vehicle).toBe(v);
    const r = new GameRenderer(canvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    r.cameraCtl.reset(sim);
    // The nearest pool to the camera is the player's own: where it lies and how strong it is (1 = a full pool's light).
    const poolOf = (q: 'low' | 'medium' | 'high') => {
      r.setQuality(q);
      r.render(0, false);
      expect(r.stats().pools, q).toBeGreaterThanOrEqual(1);
      const m = new THREE.Matrix4();
      r.lightSprites.pools.getMatrixAt(0, m);
      const at = new THREE.Vector3().setFromMatrixPosition(m);
      const colour = new THREE.Color();
      r.lightSprites.pools.getColorAt(0, colour);
      return { ahead: (at.x - v.pos.x) * Math.sin(v.heading) + (at.z - v.pos.z) * Math.cos(v.heading), height: at.y - sim.world.groundHeight(at.x, at.z), strength: colour.r / POOL_LIGHT[0] };
    };
    const low = poolOf('low');
    // Laid ahead of the bumper, on the road.
    expect(low.ahead).toBeGreaterThan(v.halfL);
    expect(low.height).toBeLessThan(0.15);
    expect(low.strength).toBeCloseTo(1, 3);
    expect(PLAYER_POOL).toBeGreaterThan(0);
    expect(PLAYER_POOL).toBeLessThan(0.5);
    for (const q of ['medium', 'high'] as const) {
      const own = poolOf(q);
      expect(own.ahead, q).toBeCloseTo(low.ahead, 3);
      expect(own.strength, q).toBeCloseTo(PLAYER_POOL, 3);
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

/** What the GL blend writes for a source (what the shader outputs) over a destination, for the factors the light sprites use. */
function blended(m: THREE.Material, src: number, dst: number): number {
  const factor = (f: THREE.BlendingDstFactor | THREE.BlendingSrcFactor): number => {
    if (f === THREE.DstColorFactor) return dst;
    if (f === THREE.OneFactor) return 1;
    if (f === THREE.SrcAlphaFactor) return 1;
    throw new Error(`blend factor ${f} is not modelled`);
  };
  if (m.blending === THREE.AdditiveBlending) return src + dst;
  expect(m.blending).toBe(THREE.CustomBlending);
  expect(m.blendEquation).toBe(THREE.AddEquation);
  return src * factor(m.blendSrc) + dst * factor(m.blendDst);
}

describe("a headlight pool's light", () => {
  it('lights the surface: the road is multiplied by 1 + the light, a dark patch and a bright one by the same factor', () => {
    const ls = new LightSprites();
    const light = POOL_LIGHT[0] * 0.6;
    const asphalt = 0.004;
    const laneLine = 0.35;
    // The shader writes the light; the blend leaves dst * (1 + light).
    expect(blended(ls.pools.material, light, asphalt) / asphalt).toBeCloseTo(1 + light, 6);
    expect(blended(ls.pools.material, light, laneLine) / laneLine).toBeCloseTo(1 + light, 6);
    // So the bright lane line gains the most, and no light means no change on either.
    expect(blended(ls.pools.material, light, laneLine) - laneLine).toBeGreaterThan((blended(ls.pools.material, light, asphalt) - asphalt) * 50);
    expect(blended(ls.pools.material, 0, asphalt)).toBe(asphalt);
    expect(blended(ls.pools.material, 0, laneLine)).toBe(laneLine);
    // The glows and the streaks still add their colour.
    expect(blended(ls.glows.material, 0.5, 0.2)).toBeCloseTo(0.7, 6);
    expect(blended(ls.streaks.material, 0.5, 0.2)).toBeCloseTo(0.7, 6);
    ls.dispose();
  });

  it('is written as a multiplier, not a colour: no tone mapping, and it fades out in fog', () => {
    const fs = poolFragment(true);
    expect(fs).not.toContain('tonemapping_fragment');
    expect(fs).toContain('colorspace_fragment');
    // 1 + the light goes out and the blend takes the 1 off again: a pool with no light leaves the surface alone.
    expect(fs).toContain('1.0 + vColor * a');
    expect(fs).toContain('USE_FOG');
    expect(fs).toContain('a *= exp(');
  });

  it('draws before the glows and streaks it would otherwise dim or brighten', () => {
    const ls = new LightSprites();
    expect(ls.pools.renderOrder).toBeLessThan(ls.glows.renderOrder);
    expect(ls.pools.renderOrder).toBeLessThan(ls.streaks.renderOrder);
    ls.dispose();
  });

  it("is painted on the software tier's 8-bit canvas, where a multiplier cannot show on a nearly black road", () => {
    const paint = new LightSprites(false);
    expect(paint.pools.material.blending).toBe(THREE.AdditiveBlending);
    const fs = poolFragment(false);
    expect(fs).toContain('tonemapping_fragment');
    expect(fs).toContain('colorspace_fragment');
    expect(fs).toContain('USE_FOG');
    // The same light, added: a dark and a bright surface gain the same amount.
    expect(blended(paint.pools.material, 0.3, 0.01) - 0.01).toBeCloseTo(blended(paint.pools.material, 0.3, 0.5) - 0.5, 6);
    paint.dispose();
    for (const [gpu, name] of [[HDR, 'hardware'], [SOFT, 'software']] as const) {
      const r = new GameRenderer(canvas(), W, { quality: 'low', fov: 68, gpu });
      expect(r.lightSprites.pools.material.blending, name).toBe(name === 'hardware' ? THREE.CustomBlending : THREE.AdditiveBlending);
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

  it('is warm, and at its brightest multiplies the road by a bounded amount', () => {
    const peak = POOL_LIGHT.map((c) => c * Math.max(...Array.from({ length: 241 }, (_, i) => poolShape(POOL_START + i / 10, 0.72))));
    // Warm: more red than green than blue.
    expect(POOL_LIGHT[0]).toBeGreaterThan(POOL_LIGHT[1]);
    expect(POOL_LIGHT[1]).toBeGreaterThan(POOL_LIGHT[2]);
    expect(peak[0]! + 1).toBeLessThan(40);
    expect(peak[0]! + 1).toBeGreaterThan(8);
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
