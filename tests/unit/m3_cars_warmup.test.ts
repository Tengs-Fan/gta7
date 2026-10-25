// Mission 3 cars, VAL-CAR-008: the warm-up compiles every car's own materials (its paint and fittings, drawn whole) as
// well as their fade copies, on every tier and after a restored WebGL context, so spawning a kind for the first time
// adds no shader program mid-game. (Before, every warm-up view was faded when the scene was compiled, so the first car
// to spawn whole built two programs: its paint and its fittings without hashed alpha.)
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GameRenderer } from '../../src/render/renderer';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
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
    return new Proxy(store, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => ((o[k] = v), true) });
  };
  const canvas = (): Record<string, unknown> => ({ width: 300, height: 150, clientWidth: 1280, clientHeight: 720, style: {}, getContext: (kind: string) => (kind === '2d' ? ctx2d() : null), addEventListener: () => {}, removeEventListener: () => {} });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

/** For each compile: the (mesh name, material) pairs of the scene's meshes. */
const compiled: Array<Array<{ name: string; material: THREE.Material }>> = [];

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    readonly shadowMap = { enabled: false, type: 0 };
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas;
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(): void {}
    compile(scene: InstanceType<typeof actual.Object3D>, _camera?: unknown, targetScene?: unknown): void {
      // The shadow stand-ins (Effects.shadowProbes) compile in a scene of their own with the main scene's lights: not a
      // compile of the scene's cars.
      if (targetScene) return;
      const out: Array<{ name: string; material: THREE.Material }> = [];
      scene.traverse((o) => {
        const m = (o as InstanceType<typeof actual.Mesh>).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        for (const x of Array.isArray(m) ? m : [m]) out.push({ name: o.name, material: x });
      });
      compiled.push(out);
    }
    render(): void {}
    setRenderTarget(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const canvas = (): HTMLCanvasElement => document.createElement('canvas') as unknown as HTMLCanvasElement;
const CARS = (Object.keys(VEHICLE_SPECS) as VehicleKind[]).filter((k) => VEHICLE_SPECS[k].class === 'car');
let W: StaticWorld;
beforeAll(() => {
  W = world();
});
afterEach(() => {
  compiled.length = 0;
});

/** How many car bodies and fittings each compile saw drawn whole (no hashed alpha) and fading (hashed alpha). */
function census(): { body: [number, number]; exterior: [number, number] } {
  const body: [number, number] = [0, 0];
  const exterior: [number, number] = [0, 0];
  for (const c of compiled) {
    for (const { name, material } of c) {
      const k = material.alphaHash ? 1 : 0;
      if (name === 'body') body[k]++;
      if (name === 'exterior') exterior[k]++;
    }
  }
  return { body, exterior };
}

describe('VAL-CAR-008 the warm-up covers a car drawn whole and fading', () => {
  it('compiles each car kind whole and as a fade copy, on every tier and after a context restore', () => {
    for (const gpu of [{ renderer: '', halfFloat: true }, { renderer: 'SwiftShader', halfFloat: false }]) {
      compiled.length = 0;
      const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu });
      const check = (label: string): void => {
        const c = census();
        // One compile per warm-up (the renderer's count is unchanged), with a whole and a fading view of each kind.
        expect(compiled.length, label).toBe(1);
        for (const [what, [whole, fading]] of Object.entries(c)) {
          expect(whole, `${label} ${what} whole`).toBeGreaterThanOrEqual(CARS.length);
          expect(fading, `${label} ${what} fading`).toBeGreaterThanOrEqual(CARS.length);
        }
      };
      check(`${gpu.renderer || 'hardware'} boot`);
      for (const q of ['medium', 'low', 'high'] as const) {
        compiled.length = 0;
        r.setQuality(q);
        check(`${gpu.renderer || 'hardware'} ${q}`);
      }
      compiled.length = 0;
      (r as unknown as { onContextRestored(): void }).onContextRestored();
      check(`${gpu.renderer || 'hardware'} restore`);
    }
  });
});
