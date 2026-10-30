// Graphics milestone integration: tier switches and WebGL context restore with rain at night, glows, pools, wet
// streaks, the wave grid and the finish pass all active, checked for leaks. Headless, with the stub header of
// rain.test.ts.

import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ContactShadows } from '../../src/render/contactShadows';
import { FinishPass } from '../../src/render/finishPass';
import { QUALITY } from '../../src/render/quality';
import { GameRenderer } from '../../src/render/renderer';
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
    effects: unknown[] = [];
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas ?? new EventTarget();
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(e: unknown[]): void {
      this.effects = e;
    }
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

const DT = 1 / 60;
const HDR = { renderer: '', halfFloat: true };
const canvas = (): HTMLCanvasElement => document.createElement('canvas') as unknown as HTMLCanvasElement;

let W: StaticWorld;
beforeAll(() => {
  W = world();
});

/** High, 23:00, instant rain, the player driving a car on the beach beside the sea among occupied cars. */
function rainNight() {
  const sim = makeSim({ world: W });
  sim.clock.set(23);
  sim.clock.rate = 0;
  sim.weather.override('rain', 0);
  const b = sim.world.layout.bounds;
  const x = b.beachStartX + 30;
  const z = (b.landMinZ + b.landMaxZ) / 2;
  placeInCar(sim, sim.spawnVehicle('sports', x, z, 0));
  // Occupied cars around the player, so traffic headlight pools are drawn on every tier.
  for (let i = 1; i < 16; i++) {
    const v = sim.spawnVehicle('sedan', x + (i % 4) * 4, z + Math.floor(i / 4) * 7 + 7, 0);
    sim.seat(sim.spawnCharacter('civilian', v.pos.x, v.pos.z), v, 0);
  }
  const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
  r.attach(sim);
  r.cameraCtl.mode = 'play';
  r.cameraCtl.reset(sim);
  const frames = (n = 4) => {
    for (let i = 0; i < n; i++) {
      sim.update(DT, input({ throttle: 0.6 }));
      r.render(DT, false);
    }
    return r.stats();
  };
  return { sim, r, frames };
}

const effectsOf = (r: GameRenderer) => (r.renderer as unknown as { effects: unknown[] }).effects;

/** Every object, geometry and material reachable from the scene, and the live (undisposed) geometry count. */
function census(scene: THREE.Scene) {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  let objects = 0;
  scene.traverse((o) => {
    objects++;
    const m = o as THREE.Mesh;
    if (m.geometry) geos.add(m.geometry);
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
  });
  return { objects, geometries: geos.size, materials: mats.size };
}

describe('tier switches at night in the rain', () => {
  it('High -> Medium -> Low -> High: counters follow each tier and the scene returns to the same shape', () => {
    const { r, frames } = rainNight();
    const high0 = frames(6);
    expect(high0).toMatchObject({ rainDrops: QUALITY.high.rainDrops, waterGrid: true });
    expect(high0.wet).toBeGreaterThan(0.9);
    expect(high0.glows).toBeGreaterThan(0);
    expect(high0.pools).toBeGreaterThan(0);
    expect(high0.streaks).toBeGreaterThan(0);
    const gridGeo = r.env.water.geometry;
    const gridDispose = vi.spyOn(gridGeo, 'dispose');

    // The first switch may grow pools (the warm-up borrows pooled vehicle views); later rounds must not grow anything.
    const shapes: ReturnType<typeof census>[] = [];
    for (const q of ['medium', 'low', 'high', 'medium', 'low', 'high', 'medium', 'low', 'high'] as const) {
      r.setQuality(q);
      const s = frames();
      const t = QUALITY[q];
      expect(s.rainDrops, q).toBe(t.rainDrops);
      expect(r.rain.mesh.geometry.instanceCount, q).toBe(t.rainDrops);
      expect(s.waterGrid, q).toBe(t.waterGrid);
      expect(s.pools, q).toBeGreaterThan(0);
      expect(s.pools, q).toBeLessThanOrEqual(t.headlightPools);
      expect(s.glows, q).toBeGreaterThan(0);
      expect(s.streaks, q).toBeGreaterThan(0);
      expect(r.post, q).toMatchObject({ aa: t.aa, grade: true });
      if (q === 'high') shapes.push(census(r.scene));
    }
    // The grid's buffers were freed on leaving High; the same geometry object comes back.
    expect(gridDispose).toHaveBeenCalled();
    expect(r.env.water.geometry).toBe(gridGeo);
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
    r.dispose();
  });

  it('switching away disposes the old FinishPass-chain passes it drops, and keeps one FinishPass', () => {
    const { r, frames } = rainNight();
    frames();
    const [contact, bloom, finish] = effectsOf(r) as [ContactShadows, UnrealBloomPass, FinishPass];
    expect(contact).toBeInstanceOf(ContactShadows);
    expect(bloom).toBeInstanceOf(UnrealBloomPass);
    expect(finish).toBeInstanceOf(FinishPass);
    const spies = [vi.spyOn(contact, 'dispose'), vi.spyOn(bloom, 'dispose'), vi.spyOn(finish, 'dispose')];
    r.setQuality('low');
    frames();
    expect(spies[0]).toHaveBeenCalledTimes(1);
    expect(spies[1]).toHaveBeenCalledTimes(1);
    expect(spies[2]).not.toHaveBeenCalled();
    expect(effectsOf(r)).toEqual([finish]);
    r.setQuality('high');
    frames();
    expect(effectsOf(r)).toHaveLength(3);
    expect(effectsOf(r)[2]).toBe(finish);
    r.dispose();
    expect(spies[2]).toHaveBeenCalledTimes(1);
  });
});

describe('WebGL context restore with every new feature active', () => {
  it('re-bakes the environment, keeps the weather, tier counters and scene shape, and later tier switches still work', () => {
    const { r, sim, frames } = rainNight();
    const s0 = frames(6);
    const weather0 = { ...sim.weather.state };
    const bakes0 = r.env.envBakes;
    const handlers = r as unknown as { onContextLost: () => void; onContextRestored: () => void };
    const shapes: ReturnType<typeof census>[] = [];
    let s1 = s0;
    for (let i = 0; i < 3; i++) {
      handlers.onContextLost();
      expect(r.isContextLost).toBe(true);
      handlers.onContextRestored();
      expect(r.isContextLost).toBe(false);
      s1 = frames(2);
      shapes.push(census(r.scene));
    }
    expect(r.env.envBakes).toBeGreaterThan(bakes0);
    expect(sim.weather.state.kind).toBe(weather0.kind);
    expect(sim.weather.state.rain).toBeCloseTo(weather0.rain, 6);
    for (const k of ['rainDrops', 'waterGrid'] as const) expect(s1[k], k).toBe(s0[k]);
    for (const k of ['glows', 'pools', 'streaks'] as const) expect(s1[k], k).toBeGreaterThan(0);
    expect(r.post).toMatchObject({ aa: 'msaa', grade: true });
    expect(shapes[2]).toEqual(shapes[1]);
    r.setQuality('low');
    expect(frames()).toMatchObject({ rainDrops: QUALITY.low.rainDrops, waterGrid: false });
    r.setQuality('high');
    expect(frames()).toMatchObject({ rainDrops: QUALITY.high.rainDrops, waterGrid: true });
    r.dispose();
  });
});
