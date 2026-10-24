// Loaded asset materials are warmed up with the rest of the renderer's shaders, on every tier and again after a
// restored WebGL context, and are never left in the scene during play.
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assets } from '../../src/render/assets';
import { loadAssetsFromDisk, unloadAssets } from '../../src/render/assets/testing';
import { GameRenderer } from '../../src/render/renderer';
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

interface Snapshot { materials: Set<unknown>; probe: boolean }
const compiled: Snapshot[] = [];

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    effects: unknown[] = [];
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas;
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(e: unknown[]): void {
      this.effects = e;
    }
    compile(scene: InstanceType<typeof actual.Object3D>): void {
      const materials = new Set<unknown>();
      scene.traverse((o) => {
        const m = (o as InstanceType<typeof actual.Mesh>).material as unknown;
        if (Array.isArray(m)) m.forEach((x) => materials.add(x));
        else if (m) materials.add(m);
      });
      compiled.push({ materials, probe: !!scene.getObjectByName('asset-warmup') });
    }
    render(): void {}
    setRenderTarget(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});


const canvas = (): HTMLCanvasElement => document.createElement('canvas') as unknown as HTMLCanvasElement;
let W: StaticWorld;
beforeAll(() => {
  W = world();
});
afterEach(() => {
  unloadAssets();
  compiled.length = 0;
});

/** Materials that were in the scene at any compile call. */
function compiledMaterials(): Set<unknown> {
  const out = new Set<unknown>();
  for (const c of compiled) for (const m of c.materials) out.add(m);
  return out;
}

const probed = (): boolean => compiled.some((c) => c.probe);
const hasProbe = (scene: THREE.Object3D): boolean => !!scene.getObjectByName('asset-warmup');

describe('asset warm-up', () => {
  it('compiles every asset material on every tier, then leaves the warm-up objects out of the scene', async () => {
    await loadAssetsFromDisk({ filter: (e) => e.id === 'char.swat' || e.id === 'veh.q.police' || e.id === 'veh.k.van' || e.id === 'prop.q.hydrant' });
    const materials = assets.materials();
    expect(materials.length).toBeGreaterThan(5);
    for (const gpu of [{ renderer: '', halfFloat: true }, { renderer: 'SwiftShader', halfFloat: false }]) {
      compiled.length = 0;
      const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu });
      const warmed = compiledMaterials();
      const software = gpu.renderer === 'SwiftShader';
      if (!software) for (const m of materials) expect(warmed.has(m), `${m.name} compiled`).toBe(true);
      else expect(warmed.size).toBeGreaterThan(materials.length);
      expect(probed()).toBe(true);
      expect(hasProbe(r.scene)).toBe(false);
      for (const q of ['medium', 'low', 'high'] as const) {
        compiled.length = 0;
        r.setQuality(q);
        expect(probed(), `${q} warm-up`).toBe(true);
        expect(hasProbe(r.scene)).toBe(false);
      }
    }
  });

  it('compiles the asset materials again when a lost WebGL context is restored', async () => {
    await loadAssetsFromDisk({ filter: (e) => e.id === 'veh.q.police' });
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: true } });
    compiled.length = 0;
    (r as unknown as { onContextRestored(): void }).onContextRestored();
    const warmed = compiledMaterials();
    for (const m of assets.materials()) expect(warmed.has(m)).toBe(true);
  });

  it('does nothing with an empty library', () => {
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: true } });
    expect(probed()).toBe(true);
    expect(assets.warmGroup().children).toHaveLength(0);
    expect(assets.materials()).toEqual([]);
    expect(r.scene).toBeDefined();
    vi.restoreAllMocks();
  });
});
