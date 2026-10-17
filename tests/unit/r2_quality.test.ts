// Graphics quality tiers (P40s) and WebGL context loss (P90): the Auto pick from the GPU string,
// the settings field, and GameRenderer switching tiers and surviving a context restore headless.
// The stub header is copied from fix_render.test.ts (vi.mock cannot be shared between files); the
// fake WebGLRenderer here also records what it is told (pixel ratio, effects, compiles, options).

import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FLASH_SIZE } from '../../src/render/effects';
import { Environment } from '../../src/render/environment';
import { AUTO_MAX_PIXELS, drawingBufferPixels, gpuClass, pickTier, pixelRatioFor, probeGpu, QUALITY, QUALITY_TIERS, type QualityTier } from '../../src/render/quality';
import { GameRenderer, guardStaleDeletes } from '../../src/render/renderer';
import type { VehicleView } from '../../src/render/vehicleView';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../../src/settings';
import type { Sim } from '../../src/sim/sim';
import type { Prop } from '../../src/world/layout';
import { axisOf, type Dir } from '../../src/world/roads';
import type { StaticWorld } from '../../src/world/staticWorld';
import { makeSim, step, teleport, world } from './helpers';

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
    readonly params: Record<string, unknown>;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    pixelRatio = 1;
    effects: unknown[] = [];
    compiles = 0;
    constructor(params: { canvas?: unknown } = {}) {
      this.params = params;
      this.domElement = params.canvas;
    }
    setPixelRatio(r: number): void {
      this.pixelRatio = r;
    }
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(e: unknown[]): void {
      this.effects = e;
    }
    /** Render target bound at each compile() (the HDR warm-up binds a half-float one). */
    compileTargets: unknown[] = [];
    private target: unknown = null;
    setRenderTarget(t: unknown): void {
      this.target = t;
    }
    getRenderTarget(): unknown {
      return this.target;
    }
    compile(): void {
      this.compiles++;
      this.compileTargets.push(this.target);
    }
    draws = 0;
    render(): void {
      this.draws++;
    }
    dispose(): void {}
    /** A stand-in WebGL context that records deletes (for the stale-delete guard). */
    readonly gl = {
      deleted: [] as unknown[],
      createTexture: (): object => ({}),
      deleteTexture: (o: unknown): void => {
        this.gl.deleted.push(o);
      },
    };
    getContext(): unknown {
      return this.gl;
    }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

/** What the fake WebGLRenderer above records. */
interface Fake {
  gl: { deleted: unknown[]; createTexture(): object; deleteTexture(o: unknown): void };
  params: { antialias?: boolean; outputBufferType?: number };
  shadowMap: { enabled: boolean };
  pixelRatio: number;
  effects: unknown[];
  compiles: number;
  compileTargets: unknown[];
  getRenderTarget(): unknown;
  draws: number;
  toneMapping: number;
  outputColorSpace: string;
}

const DT = 1 / 60;
const HDR = { renderer: '', halfFloat: true };

/** A canvas that really dispatches events, for the context-loss handlers. */
function eventCanvas(): HTMLCanvasElement {
  return Object.assign(new EventTarget(), { width: 300, height: 150, clientWidth: 1280, clientHeight: 720, style: {}, getContext: () => null }) as unknown as HTMLCanvasElement;
}

function fakeOf(r: GameRenderer): Fake {
  return r.renderer as unknown as Fake;
}

function visibleLights(scene: THREE.Scene): { point: THREE.PointLight[]; spot: THREE.SpotLight[] } {
  const point: THREE.PointLight[] = [];
  const spot: THREE.SpotLight[] = [];
  scene.traverseVisible((o) => {
    if (o instanceof THREE.PointLight) point.push(o);
    if (o instanceof THREE.SpotLight) spot.push(o);
  });
  return { point, spot };
}

function views(r: GameRenderer): Map<number, VehicleView> {
  return (r as unknown as { vehicleViews: Map<number, VehicleView> }).vehicleViews;
}

function attachPlay(r: GameRenderer, sim: Sim): void {
  r.attach(sim);
  r.cameraCtl.mode = 'play';
  r.cameraCtl.reset(sim);
}

/** A clear spot on the beach, away from buildings. */
function beachSpot(sim: Sim): { x: number; z: number } {
  const b = sim.world.layout.bounds;
  return { x: b.beachStartX + 30, z: (b.landMinZ + b.landMaxZ) / 2 };
}

// ---------------------------------------------------------------------------

describe('Auto tier pick (pickTier)', () => {
  it('maps GPU renderer strings to tiers', () => {
    const cases: Array<[string, QualityTier]> = [
      ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Laptop GPU (0x000024DD) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
      ['ANGLE (NVIDIA, Vulkan 1.4.351 (NVIDIA NVIDIA GeForce RTX 3070 Laptop GPU (0x000024DD)), NVIDIA)', 'high'],
      ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
      ['Apple M1', 'medium'],
      ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', 'medium'],
      ['Apple M2 Max', 'high'],
      ['ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)', 'high'],
      ['SwiftShader', 'low'],
      ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'low'],
      ['llvmpipe (LLVM 15.0.7, 256 bits)', 'low'],
      ['ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
      ['', 'medium'],
      ['Some Future GPU 9000', 'medium'],
      ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
      ['AMD Radeon(TM) RX Vega 10 Graphics', 'medium'],
      ['ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics (0x000015DD) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
      ['ANGLE (AMD, Radeon RX Vega Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
      ['AMD Radeon RX Vega 64 (vega10, LLVM 15.0.7, DRM 3.49)', 'high'],
      ['Radeon RX Vega M GH Graphics', 'high'],
      ['AMD Radeon Pro Vega 20', 'high'],
      ['ANGLE (AMD, AMD Radeon RX 6800 XT (0x000073BF) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
      ['ANGLE (AMD, AMD Radeon Pro 5500M OpenGL Engine, OpenGL 4.1)', 'high'],
      ['Mali-G78', 'medium'],
      ['Adreno (TM) 740', 'medium'],
      ['PowerVR Rogue GE8320', 'medium'],
      ['NVIDIA GeForce MX450/PCIe/SSE2', 'medium'],
      ['NVIDIA Quadro P1000/PCIe/SSE2', 'high'],
      ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
      ['ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
      ['Mesa Intel(R) UHD Graphics 620 (KBL GT2)', 'medium'],
    ];
    const wrong = cases.filter(([s, want]) => pickTier({ renderer: s }) !== want).map(([s, want]) => `${s} -> ${pickTier({ renderer: s })} (want ${want})`);
    expect(wrong).toEqual([]);
  });

  it('demotes an integrated GPU to Low when its Medium drawing buffer would be too big', () => {
    const iris = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)';
    // A 4K monitor at 100% scaling: 3840 x 2160 x 0.85^2 = 6.0 MP at Medium.
    expect(drawingBufferPixels('medium', 3840, 2160, 1)).toBeGreaterThan(AUTO_MAX_PIXELS);
    expect(pickTier({ renderer: iris, devicePixelRatio: 1, screenWidth: 3840, screenHeight: 2160 })).toBe('low');
    expect(pickTier({ renderer: iris, devicePixelRatio: 3, screenWidth: 3840, screenHeight: 2160 })).toBe('low');
    expect(pickTier({ renderer: 'Mali-G78', devicePixelRatio: 3, screenWidth: 3440, screenHeight: 1440 })).toBe('low');
    // Medium caps the pixel ratio at 1, so a HiDPI panel costs no more than a 1x one of the same
    // CSS size: 3x DPR on a 2560 x 1600 screen renders 2176 x 1360 = 2.96 MP and stays Medium
    // (the plan's example expected Low; see the report's deviations).
    expect(drawingBufferPixels('medium', 2560, 1600, 3)).toBeLessThanOrEqual(AUTO_MAX_PIXELS);
    expect(pickTier({ renderer: iris, devicePixelRatio: 3, screenWidth: 2560, screenHeight: 1600 })).toBe('medium');
    // A Retina MacBook Air (1440 x 900 CSS at 2x) is a Medium machine.
    expect(pickTier({ renderer: 'Apple M1', devicePixelRatio: 2, screenWidth: 1440, screenHeight: 900 })).toBe('medium');
    // Discrete GPUs are never demoted.
    expect(pickTier({ renderer: 'NVIDIA GeForce RTX 3070', devicePixelRatio: 3, screenWidth: 3840, screenHeight: 2160 })).toBe('high');
  });

  it('classifies GPUs', () => {
    expect(gpuClass('SwiftShader')).toBe('software');
    expect(gpuClass('Intel(R) UHD Graphics 630')).toBe('integrated');
    expect(gpuClass('NVIDIA GeForce GTX 1060')).toBe('discrete');
    expect(gpuClass('WebKit WebGL')).toBe('unknown');
  });
});

describe('tier table', () => {
  it('High is the original look, Low drops MSAA, shadows, bloom and dynamic lights', () => {
    expect(QUALITY.high).toMatchObject({ dprCap: 1.5, renderScale: 1, msaa: true, shadows: true, shadowSize: 2048, bloom: true, pointLights: 'all', headlight: true, trafficDensity: 1, pedDensity: 1 });
    expect(QUALITY.high.vehicleDistance).toBe(Infinity);
    expect(QUALITY.medium).toMatchObject({ dprCap: 1, renderScale: 0.85, shadows: true, shadowSize: 1024, bloom: true, pointLights: 'few', headlight: true, trafficDensity: 0.9, pedDensity: 0.9 });
    expect(QUALITY.low).toMatchObject({ dprCap: 1, renderScale: 0.67, msaa: false, shadows: false, bloom: false, pointLights: 'none', headlight: false, trafficDensity: 0.75, pedDensity: 0.75 });
    // The pixel ratio is dprCap x renderScale on any display at or above the cap.
    for (const q of QUALITY_TIERS) {
      expect(pixelRatioFor(q, 3)).toBeCloseTo(QUALITY[q].dprCap * QUALITY[q].renderScale, 6);
      expect(pixelRatioFor(q, 1)).toBeCloseTo(Math.min(1, QUALITY[q].dprCap) * QUALITY[q].renderScale, 6);
    }
    expect(pixelRatioFor('high', Number.NaN)).toBe(1);
  });
});

describe('settings quality field', () => {
  class Storage {
    private readonly m = new Map<string, string>();
    getItem(k: string): string | null {
      return this.m.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.m.set(k, String(v));
    }
    removeItem(k: string): void {
      this.m.delete(k);
    }
  }
  const win = window as unknown as { localStorage?: Storage };

  afterEach(() => {
    delete win.localStorage;
  });

  it("defaults to 'auto', keeps a saved fixed tier and rejects junk", () => {
    expect(DEFAULT_SETTINGS.quality).toBe('auto');
    expect(loadSettings().quality).toBe('auto'); // no storage at all
    win.localStorage = new Storage();
    expect(loadSettings().quality).toBe('auto'); // nothing saved yet
    // An old settings file without the field, as saved before this round.
    win.localStorage.setItem('gta7.settings.v1', JSON.stringify({ master: 0.5, music: 0.6, sfx: 0.85, sensitivity: 1, invertY: false, fov: 68 }));
    expect(loadSettings()).toMatchObject({ quality: 'auto', master: 0.5 });
    for (const q of ['low', 'medium', 'high', 'auto'] as const) {
      saveSettings({ ...DEFAULT_SETTINGS, quality: q });
      expect(loadSettings().quality).toBe(q);
    }
    win.localStorage.setItem('gta7.settings.v1', JSON.stringify({ quality: 'ultra' }));
    expect(loadSettings().quality).toBe('auto');
  });
});

describe('GameRenderer quality tiers', () => {
  let W: StaticWorld;

  beforeAll(() => {
    W = world();
  });

  afterEach(() => {
    (window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1;
    vi.restoreAllMocks();
  });

  it('MSAA follows the starting tier; the HDR output (and so the colour pipeline) is the same on every tier', () => {
    const made = QUALITY_TIERS.map((q) => new GameRenderer(eventCanvas(), W, { quality: q, fov: 68, gpu: HDR }));
    const [low, medium, high] = made.map(fakeOf);
    expect(low!.params.antialias).toBe(false);
    expect(medium!.params.antialias).toBe(true);
    expect(high!.params.antialias).toBe(true);
    expect(made.map((r) => r.msaa)).toEqual([false, true, true]);
    for (const f of [low!, medium!, high!]) {
      expect(f.params.outputBufferType).toBe(THREE.HalfFloatType);
      expect(f.toneMapping).toBe(THREE.ACESFilmicToneMapping);
      expect(f.outputColorSpace).toBe(THREE.SRGBColorSpace);
    }
    // Switching tiers later never touches MSAA (the context attribute), only the rest.
    made[0]!.setQuality('high');
    expect(made[0]!.msaa).toBe(false);
  });

  it("setQuality('low') disables the shadow map, bloom and every dynamic light; High brings them back", () => {
    const r = new GameRenderer(eventCanvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    const f = fakeOf(r);
    expect(f.shadowMap.enabled).toBe(true);
    expect(r.env.sun.castShadow).toBe(true);
    expect(r.env.sun.shadow.mapSize.x).toBe(2048);
    expect(f.effects.length).toBe(1);
    expect(f.effects[0]).toBeInstanceOf(UnrealBloomPass);
    const bloom = f.effects[0];
    let lights = visibleLights(r.scene);
    expect(lights.point.length).toBe(3); // siren, muzzle flash, explosion flash
    expect(lights.spot.length).toBe(1); // the player's headlight

    const bloomDispose = vi.spyOn(bloom as UnrealBloomPass, 'dispose');
    r.setQuality('low');
    expect(f.shadowMap.enabled).toBe(false);
    expect(r.env.sun.castShadow).toBe(false);
    expect(f.effects).toEqual([]);
    expect(bloomDispose).toHaveBeenCalledTimes(1); // its render targets are freed on Low
    lights = visibleLights(r.scene);
    expect(lights.point.length).toBe(0);
    expect(lights.spot.length).toBe(0);
    // Still none while the siren, a muzzle flash and an explosion are all live.
    const sim = makeSim({ world: W, startHour: 23 });
    attachPlay(r, sim);
    const p = sim.playerPos();
    const cop = sim.spawnVehicle('police', p.x + 6, p.z, 0);
    cop.siren = true;
    r.effects.muzzleFlash(p.x, p.y + 1.5, p.z, FLASH_SIZE.pistol);
    r.effects.explosion(p.x + 10, p.y, p.z, 7.5);
    r.render(DT, false);
    expect(visibleLights(r.scene).point.length).toBe(0);

    r.setQuality('high');
    expect(f.shadowMap.enabled).toBe(true);
    expect(r.env.sun.castShadow).toBe(true);
    expect(f.effects.length).toBe(1);
    expect(f.effects[0]).toBeInstanceOf(UnrealBloomPass);
    expect(f.effects[0]).not.toBe(bloom);
    expect(visibleLights(r.scene).point.length).toBe(3);
    expect(visibleLights(r.scene).spot.length).toBe(1);
  });

  it("setQuality('medium') caps the dynamic point lights at 2, given to the brightest nearby sources", () => {
    const r = new GameRenderer(eventCanvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    r.setQuality('medium');
    expect(r.env.sun.shadow.mapSize.x).toBe(1024);
    expect(fakeOf(r).shadowMap.enabled).toBe(true);
    expect(visibleLights(r.scene).point.length).toBe(2);
    expect(visibleLights(r.scene).spot.length).toBe(1);
    const sim = makeSim({ world: W, startHour: 23 });
    attachPlay(r, sim);
    const p = sim.playerPos();
    const cop = sim.spawnVehicle('police', p.x + 6, p.z, 0);
    cop.siren = true;
    r.render(DT, false);
    let lit = visibleLights(r.scene).point.filter((l) => l.intensity > 0);
    // Only the siren is on: it gets a pool light, at the police car.
    expect(lit.length).toBe(1);
    expect(lit[0]!.position.distanceTo(new THREE.Vector3(cop.pos.x, cop.pos.y + cop.spec.height + 0.6, cop.pos.z))).toBeLessThan(1e-6);
    // Siren, muzzle flash and explosion at once: still 2, and the explosion flash is one of them.
    r.effects.muzzleFlash(p.x, p.y + 1.5, p.z, FLASH_SIZE.pistol);
    r.effects.explosion(p.x + 10, p.y, p.z, 7.5);
    r.render(DT, false);
    const all = visibleLights(r.scene).point;
    lit = all.filter((l) => l.intensity > 0);
    expect(all.length).toBe(2);
    expect(lit.length).toBe(2);
    const flash = r.effects.flash;
    expect(lit.some((l) => l.color.equals(flash.color) && l.intensity === flash.intensity && l.position.distanceTo(flash.position) < 1e-6)).toBe(true);
    // Once everything has faded the pool goes dark.
    cop.siren = false;
    for (let i = 0; i < 40; i++) r.render(DT, false);
    expect(visibleLights(r.scene).point.filter((l) => l.intensity > 0).length).toBe(0);
  });

  it('the warm-up compiles for the HDR scene target, and runs again after a tier switch', () => {
    const r = new GameRenderer(eventCanvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    const f = fakeOf(r);
    expect(f.compiles).toBe(1);
    const bound = f.compileTargets[0] as THREE.WebGLRenderTarget;
    expect(bound).toBeInstanceOf(THREE.WebGLRenderTarget);
    expect(bound.texture.type).toBe(THREE.HalfFloatType);
    expect(f.getRenderTarget()).toBe(null); // unbound again afterwards
    r.setQuality('low');
    expect(f.compiles).toBe(2);
    // Without the HDR output there is no scene target: compile for the canvas.
    const plain = new GameRenderer(eventCanvas(), W, { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: false } });
    expect(fakeOf(plain).compileTargets).toEqual([null]);
  });

  it('the pixel ratio follows dprCap x renderScale, and is re-read on resize', () => {
    const win = window as unknown as { devicePixelRatio: number };
    win.devicePixelRatio = 2;
    const r = new GameRenderer(eventCanvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    const f = fakeOf(r);
    expect(f.pixelRatio).toBeCloseTo(1.5, 6);
    r.setQuality('medium');
    expect(f.pixelRatio).toBeCloseTo(0.85, 6);
    r.setQuality('low');
    expect(f.pixelRatio).toBeCloseTo(0.67, 6);
    expect(r.pixelRatio).toBeCloseTo(0.67, 6);
    // Dragged to a 1x monitor.
    win.devicePixelRatio = 1;
    r.setQuality('high');
    expect(f.pixelRatio).toBeCloseTo(1, 6);
    win.devicePixelRatio = 1.25;
    r.resize();
    expect(f.pixelRatio).toBeCloseTo(1.25, 6);
  });

  it('Low skips ambient cars beyond its draw distance, never police or mission vehicles', () => {
    const r = new GameRenderer(eventCanvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    const sim = makeSim({ world: W });
    const spot = beachSpot(sim);
    teleport(sim, spot.x, spot.z);
    step(sim, 0.2);
    attachPlay(r, sim);
    r.render(DT, false);
    const cam = r.cameraCtl.camera.position;
    const far = QUALITY.low.vehicleDistance;
    const at = (d: number, owner: 'parked' | 'traffic' | 'police' | 'mission') => {
      const v = sim.spawnVehicle('sedan', cam.x, cam.z + d, 0);
      v.owner = owner;
      return v;
    };
    const parkedFar = at(far + 30, 'parked');
    const trafficFar = at(-(far + 30), 'traffic');
    const copFar = at(far + 40, 'police');
    const missionFar = at(-(far + 40), 'mission');
    const parkedNear = at(far - 40, 'parked');
    r.render(DT, false);
    const shown = (v: { id: number }) => views(r).get(v.id)!.group.visible;
    expect([parkedFar, trafficFar, copFar, missionFar, parkedNear].map(shown)).toEqual([false, false, true, true, true]);
    // Driving closer brings it back.
    parkedFar.pos.z = cam.z + far - 20;
    r.render(DT, false);
    expect(shown(parkedFar)).toBe(true);
    // High draws everything again.
    r.setQuality('high');
    r.render(DT, false);
    expect([parkedFar, trafficFar, copFar, missionFar, parkedNear].every(shown)).toBe(true);
    // A pooled view hidden on Low is visible again when it is reused for another car.
    r.setQuality('low');
    r.render(DT, false);
    expect(shown(trafficFar)).toBe(false);
    const hiddenView = views(r).get(trafficFar.id)!;
    sim.removeVehicle(trafficFar);
    r.render(DT, false);
    const again = at(10, 'traffic');
    r.render(DT, false);
    expect(views(r).get(again.id)).toBe(hiddenView);
    expect(shown(again)).toBe(true);
  });

  it('Low keeps culling after a new sim is attached (pooled views do not remember being hidden)', () => {
    const r = new GameRenderer(eventCanvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    const far = QUALITY.low.vehicleDistance;
    for (let round = 0; round < 2; round++) {
      const sim = makeSim({ world: W });
      const spot = beachSpot(sim);
      teleport(sim, spot.x, spot.z);
      step(sim, 0.2);
      attachPlay(r, sim);
      r.render(DT, false);
      const cam = r.cameraCtl.camera.position;
      const v = sim.spawnVehicle('sedan', cam.x, cam.z + far + 50, 0);
      v.owner = 'traffic';
      r.render(DT, false);
      expect(views(r).get(v.id)!.group.visible).toBe(false);
    }
  });

  it('Low draws every car of the title flyover: the 150 m cull is for the play camera', () => {
    const r = new GameRenderer(eventCanvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    const sim = makeSim({ world: W, police: false });
    r.attach(sim);
    r.cameraCtl.mode = 'title';
    r.render(DT, false);
    // The title camera circles 260 m out and 95 m up.
    const cam = r.cameraCtl.camera.position;
    expect(Math.hypot(cam.x, cam.z)).toBeGreaterThan(250);
    expect(cam.y).toBeGreaterThan(70);
    const far = QUALITY.low.vehicleDistance;
    const cars = ([[0, 0], [100, -100], [-150, 120], [-200, -150]] as const).map(([x, z], i) => {
      const v = sim.spawnVehicle('sedan', x, z, 0);
      v.owner = i % 2 === 0 ? 'parked' : 'traffic';
      return v;
    });
    for (const v of cars) expect(Math.hypot(v.pos.x - cam.x, v.pos.z - cam.z)).toBeGreaterThan(far);
    const shown = () => cars.map((v) => views(r).get(v.id)!.group.visible);
    r.render(DT, false);
    expect(shown()).toEqual([true, true, true, true]);
    // New Game: the play camera at the safehouse culls the ones beyond 150 m again.
    r.cameraCtl.mode = 'play';
    r.cameraCtl.reset(sim);
    r.render(DT, false);
    const play = r.cameraCtl.camera.position;
    expect(shown()).toEqual(cars.map((v) => Math.hypot(v.pos.x - play.x, v.pos.z - play.z) <= far));
    expect(shown().filter(Boolean).length).toBeLessThan(cars.length);
  });

  it('on Low a far car is drawn while it smokes or burns, and a hidden one leaves no skid marks or smoke', () => {
    const r = new GameRenderer(eventCanvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    const sim = makeSim({ world: W });
    const spot = beachSpot(sim);
    teleport(sim, spot.x, spot.z);
    step(sim, 0.2);
    attachPlay(r, sim);
    r.render(DT, false);
    const cam = r.cameraCtl.camera.position;
    const d = QUALITY.low.vehicleDistance + 30;
    const burning = sim.spawnVehicle('sedan', cam.x, cam.z + d, 0);
    burning.owner = 'parked';
    burning.burning = true;
    const wreck = sim.spawnVehicle('sedan', cam.x + 8, cam.z + d, 0);
    wreck.owner = 'traffic';
    wreck.destroyed = true;
    const smoking = sim.spawnVehicle('sedan', cam.x - 8, cam.z + d, 0);
    smoking.owner = 'traffic';
    smoking.health = smoking.spec.health * 0.3; // condition 0.3: it smokes
    // Two cars in a hard slide: one beyond the draw distance, one near (the control).
    const skidding = sim.spawnVehicle('sedan', cam.x, cam.z - d, 0);
    const nearSkid = sim.spawnVehicle('sedan', cam.x + 20, cam.z - 40, 0);
    for (const v of [skidding, nearSkid]) {
      v.owner = 'traffic';
      v.skid = 0.9;
      v.speed = 10;
    }
    const smoke = vi.spyOn(r.effects, 'vehicleSmoke');
    const skids = vi.spyOn(r.effects.skids, 'add');
    for (let i = 0; i < 10; i++) r.render(DT, false);
    const shown = (v: { id: number }) => views(r).get(v.id)!.group.visible;
    expect([burning, wreck, smoking].map(shown)).toEqual([true, true, true]);
    expect(smoke).toHaveBeenCalled(); // their fire and smoke sit on a visible car
    expect(shown(skidding)).toBe(false);
    const marked = new Set(skids.mock.calls.map((c) => String(c[0]).split(':')[0]));
    expect(marked.has(String(nearSkid.id))).toBe(true);
    expect(marked.has(String(skidding.id))).toBe(false);
  });
});

describe('coloured lamps with and without bloom', () => {
  let W: StaticWorld;

  beforeAll(() => {
    W = world();
  });

  /** 8-bit display colour of a linear colour after three's ACESFilmicToneMapping (r186, exposure 1) and the sRGB transfer. */
  function display(c: { r: number; g: number; b: number }): [number, number, number] {
    // GLSL mat3 constructors take columns: m * v = sum of column j times v[j].
    const IN = [[0.59719, 0.076, 0.0284], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]];
    const OUT = [[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]];
    const mul = (m: number[][], v: number[]) => [0, 1, 2].map((i) => m[0]![i]! * v[0]! + m[1]![i]! * v[1]! + m[2]![i]! * v[2]!);
    const rrt = (x: number) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081);
    const lin = mul(OUT, mul(IN, [c.r / 0.6, c.g / 0.6, c.b / 0.6]).map(rrt)).map((x) => Math.min(1, Math.max(0, x)));
    return lin.map((x) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))) as [number, number, number];
  }

  /** Luminance with the weights three's bloom high pass uses. */
  function lum(c: THREE.Color): number {
    const w = THREE.ColorManagement.getLuminanceCoefficients(new THREE.Vector3());
    return w.x * c.r + w.y * c.g + w.z * c.b;
  }

  type PropsPriv = { signalBulbs: THREE.InstancedMesh; signalProps: Prop[]; antennaMat: THREE.MeshBasicMaterial; antennaLights: THREE.InstancedMesh | null; ferris: { lights: THREE.InstancedMesh } | null };

  /** Signal 0's lit bulb at a night-time frame whose sim clock shows it `state`. */
  function litBulb(r: GameRenderer, state: 'red' | 'yellow' | 'green'): THREE.Color {
    const props = r.props as unknown as PropsPriv;
    const p = props.signalProps[0]!;
    let t = 0;
    while (W.roads.signalState(p.node, axisOf(p.dir as Dir), t) !== state) t += 0.25;
    r.props.update(0, 1, t);
    const c = new THREE.Color();
    props.signalBulbs.getColorAt(['red', 'yellow', 'green'].indexOf(state), c);
    return c;
  }

  /** The aircraft warning light, lit (it blinks on in the first 0.83 s of every 1.67 s at night), and every lit ferris wheel light. */
  function nightLamps(r: GameRenderer): { warning: THREE.Color; ferris: THREE.Color[] } {
    const props = r.props as unknown as PropsPriv;
    r.props.update(0, 1, 0);
    expect(props.antennaLights).toBeTruthy();
    const ferris = props.ferris ? Array.from({ length: 64 }, (_, i) => props.ferris!.lights.getColorAt(i, new THREE.Color())) : [];
    expect(ferris.length).toBe(64);
    return { warning: props.antennaMat.color.clone(), ferris };
  }

  it('on Low, with no bloom to carry it, a lit traffic light keeps its colour through the tone mapping', () => {
    const r = new GameRenderer(eventCanvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    expect(fakeOf(r).effects).toEqual([]);
    const [rr, rg, rb] = display(litBulb(r, 'red'));
    expect(rr - rg, `red ${rr},${rg},${rb}`).toBeGreaterThan(150);
    expect(rr - rb, `red ${rr},${rg},${rb}`).toBeGreaterThan(150);
    const [yr, yg, yb] = display(litBulb(r, 'yellow'));
    expect(yr - yb, `yellow ${yr},${yg},${yb}`).toBeGreaterThan(120);
    expect(yg - yb, `yellow ${yr},${yg},${yb}`).toBeGreaterThan(100);
    expect(yr, `yellow ${yr},${yg},${yb}`).toBeGreaterThan(yg);
    const [gr, gg, gb] = display(litBulb(r, 'green'));
    expect(gg - gr, `green ${gr},${gg},${gb}`).toBeGreaterThan(80);
    expect(gg, `green ${gr},${gg},${gb}`).toBeGreaterThan(gb);
    // The red aircraft warning lights and the ferris wheel's rainbow keep theirs too.
    const lamps = nightLamps(r);
    const [wr, wg, wb] = display(lamps.warning);
    expect(wr - Math.max(wg, wb), `warning ${wr},${wg},${wb}`).toBeGreaterThan(150);
    for (const c of lamps.ferris) expect(Math.max(c.r, c.g, c.b)).toBeLessThanOrEqual(1);
  });

  it('with bloom every lit lamp is bright enough to bloom, so its halo carries the colour', () => {
    const r = new GameRenderer(eventCanvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    const bloom = fakeOf(r).effects[0] as UnrealBloomPass;
    expect(bloom).toBeInstanceOf(UnrealBloomPass);
    for (const st of ['red', 'yellow', 'green'] as const) expect(lum(litBulb(r, st)), st).toBeGreaterThan(bloom.threshold);
    const lamps = nightLamps(r);
    expect(lum(lamps.warning), 'warning light').toBeGreaterThan(bloom.threshold);
    for (const c of lamps.ferris) expect(lum(c), 'ferris light').toBeGreaterThan(bloom.threshold);
    // The lamps follow the tier.
    r.setQuality('low');
    expect(Math.max(...litBulb(r, 'green').toArray())).toBeLessThanOrEqual(1);
    r.setQuality('high');
    expect(lum(litBulb(r, 'green'))).toBeGreaterThan(bloom.threshold);
    // Without a half-float target there is no bloom on any tier: High draws the lamps as Low does.
    const plain = new GameRenderer(eventCanvas(), W, { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: false } });
    expect(fakeOf(plain).effects).toEqual([]);
    const [gr, gg] = display(litBulb(plain, 'green'));
    expect(gg - gr).toBeGreaterThan(80);
  });
});

describe('WebGL context loss (renderer side)', () => {
  it('a restore re-bakes the environment map and recompiles, without doubling listeners', () => {
    const canvas = eventCanvas();
    const r = new GameRenderer(canvas, world(), { quality: 'high', fov: 68, gpu: HDR });
    const f = fakeOf(r);
    const sim = makeSim({ world: world() });
    attachPlay(r, sim);
    r.render(DT, false);
    const refresh = vi.spyOn(Environment.prototype as unknown as { refreshEnv: () => void }, 'refreshEnv');
    r.render(DT, false);
    expect(refresh).not.toHaveBeenCalled(); // steady state: no re-bake
    const compiles = f.compiles;

    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(r.isContextLost).toBe(true);
    // Nothing is drawn (or baked) into a lost context.
    const draws = f.draws;
    r.render(DT, false);
    expect(f.draws).toBe(draws);
    expect(refresh).not.toHaveBeenCalled();
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(r.isContextLost).toBe(false);
    expect(f.compiles).toBe(compiles + 1);
    r.render(DT, false);
    expect(refresh).toHaveBeenCalledTimes(1);
    r.render(DT, false);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Sim subscriptions are untouched: one explosion still makes one blast.
    const blast = vi.spyOn(r.effects, 'explosion');
    sim.events.emit('explosion', { x: 0, y: 0, z: 0, radius: 7.5 });
    expect(blast).toHaveBeenCalledTimes(1);
    // A second loss and restore compiles once more, not twice (no stacked handlers).
    canvas.dispatchEvent(new Event('webglcontextlost'));
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(f.compiles).toBe(compiles + 2);
    // dispose() removes the handlers.
    r.dispose();
    const before = f.compiles;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(f.compiles).toBe(before);
    refresh.mockRestore();
  });

  it('after a loss, deleting GL objects of the lost context is skipped and new ones are deleted', () => {
    const canvas = eventCanvas();
    const r = new GameRenderer(canvas, world(), { quality: 'low', fov: 68, gpu: HDR });
    const gl = fakeOf(r).gl;
    const before = gl.createTexture();
    gl.deleteTexture(before);
    expect(gl.deleted).toEqual([before]); // untouched until a context is lost
    const old = gl.createTexture();
    canvas.dispatchEvent(new Event('webglcontextlost'));
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    gl.deleteTexture(old);
    expect(gl.deleted).toEqual([before]);
    const fresh = gl.createTexture();
    gl.deleteTexture(fresh);
    expect(gl.deleted).toEqual([before, fresh]);
    gl.deleteTexture(null);
    expect(gl.deleted).toEqual([before, fresh, null]);
    // A second loss makes the objects of the restored context stale in turn.
    const second = gl.createTexture();
    canvas.dispatchEvent(new Event('webglcontextlost'));
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    gl.deleteTexture(second);
    const third = gl.createTexture();
    gl.deleteTexture(third);
    expect(gl.deleted).toEqual([before, fresh, null, third]);
  });
});

describe('probeGpu', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubProbe(gl: Record<string, unknown>): void {
    vi.stubGlobal('document', { createElement: () => ({ getContext: (kind: string) => (kind === 'webgl2' ? gl : null) }) });
  }

  it('reads the unmasked renderer when RENDERER is masked, and always releases its context', () => {
    const lose = vi.fn();
    stubProbe({
      RENDERER: 1,
      getParameter: (p: number) => (p === 1 ? 'WebKit WebGL' : p === 2 ? 'ANGLE (Intel, Intel(R) UHD Graphics 620)' : null),
      getExtension: (name: string) => (name === 'EXT_color_buffer_float' ? {} : name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 2 } : name === 'WEBGL_lose_context' ? { loseContext: lose } : null),
    });
    expect(probeGpu()).toEqual({ renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620)', halfFloat: true });
    expect(lose).toHaveBeenCalledTimes(1);
  });

  it('uses an unmasked RENDERER directly (Firefox) without the deprecated debug extension', () => {
    const asked: string[] = [];
    stubProbe({
      RENDERER: 1,
      getParameter: () => 'NVIDIA GeForce GTX 980, or similar',
      getExtension: (name: string) => {
        asked.push(name);
        return null;
      },
    });
    expect(probeGpu().renderer).toBe('NVIDIA GeForce GTX 980, or similar');
    expect(asked).not.toContain('WEBGL_debug_renderer_info');
  });

  it('a query that throws still releases the throwaway context', () => {
    const lose = vi.fn();
    stubProbe({
      RENDERER: 1,
      getParameter: () => {
        throw new Error('blocked by a privacy extension');
      },
      getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: lose } : null),
    });
    expect(probeGpu()).toEqual({ renderer: '', halfFloat: false });
    expect(lose).toHaveBeenCalledTimes(1);
  });
});

describe('guardStaleDeletes', () => {
  it('wraps every create / delete pair it finds and leaves other calls alone', () => {
    const deleted: string[] = [];
    const gl: Record<string, unknown> = {
      createBuffer: () => ({ k: 'buffer' }),
      deleteBuffer: (o: { k: string }) => deleted.push(o.k),
      createFramebuffer: () => ({ k: 'fbo' }),
      deleteFramebuffer: (o: { k: string }) => deleted.push(o.k),
      fenceSync: () => ({ k: 'sync' }),
      deleteSync: (o: { k: string }) => deleted.push(o.k),
      bindBuffer: () => 'bound',
    };
    const call = (name: string, ...a: unknown[]) => (gl[name] as (...x: unknown[]) => unknown)(...a);
    const oldBuf = call('createBuffer');
    const oldSync = call('fenceSync');
    const bind = gl.bindBuffer;
    guardStaleDeletes(gl);
    expect(gl.bindBuffer).toBe(bind);
    call('deleteBuffer', oldBuf);
    call('deleteSync', oldSync);
    call('deleteFramebuffer', call('createFramebuffer'));
    call('deleteSync', call('fenceSync'));
    expect(deleted).toEqual(['fbo', 'sync']);
  });
});
