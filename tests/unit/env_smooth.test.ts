// Dawn and dusk without brightness steps: the environment map (the sky's image-based light) is re-baked
// whenever the analytic sky has visibly changed, at most twice a real second, and between bakes its
// light is scaled by how much the sky has brightened or darkened since, so the effective sky light
// changes every frame instead of snapping at each bake.
// The stub header is copied from r2_fix3_env.test.ts (vi.mock cannot be shared between files).

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Environment } from '../../src/render/environment';

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
    setRenderTarget(): void {}
    getRenderTarget(): unknown {
      return null;
    }
    compile(): void {}
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
/** One frame of game time at the default clock rate (one game minute per real second), in hours. */
const FRAME_H = 1 / 3600;

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

interface Rig {
  env: Environment;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  bakeTimes: number[];
  update(h: number, t: number): void;
}

/** A real Environment whose PMREM, cube target and cube camera are stubs, recording each bake's time. */
function rig(): Rig {
  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer();
  const env = new Environment(scene, renderer, { hdr: true });
  const target = new THREE.WebGLRenderTarget(4, 4);
  const bakeTimes: number[] = [];
  let now = 0;
  const priv = env as unknown as Record<string, unknown>;
  priv.pmrem = { fromCubemap: () => (bakeTimes.push(now), target), dispose: () => {} };
  priv.cubeTarget = { texture: new THREE.Texture(), dispose: () => {} };
  priv.cubeCamera = { update: () => {} };
  const cam = new THREE.PerspectiveCamera();
  const focus = new THREE.Vector3();
  return {
    env,
    scene,
    renderer,
    bakeTimes,
    update(h, t) {
      now = t;
      env.update(h, focus, cam, t, renderer);
    },
  };
}

/** Diffuse light reaching an up-facing white surface: key light, hemisphere sky colour and the image-based light. */
function totalUp(r: Rig): number {
  const { env, scene } = r;
  const key = env.sun.position.clone().sub(env.sun.target.position).normalize();
  const direct = env.sun.intensity * lum(env.sun.color) * Math.max(0, key.y) + env.hemi.intensity * lum(env.hemi.color);
  return direct / Math.PI + effectiveIbl(r, scene);
}

/** The image-based light an up-facing surface gets: the baked sky's irradiance times environmentIntensity. */
function effectiveIbl(r: Rig, scene = r.scene): number {
  return lum(r.env.bakedUp) * scene.environmentIntensity;
}

interface Sweep {
  frames: number;
  /** Bakes after the first frame. */
  bakes: number;
  worstStep: number;
  worstStepAt: number;
  worstIdealErr: number;
  shortGaps: number;
}

/** Steps the environment at 60 fps and the default clock rate from h0 to h1, beside one that bakes every frame. */
function sweep(h0: number, h1: number): Sweep {
  const r = rig();
  const ideal = rig();
  const idealPriv = ideal.env as unknown as { envHours: number };
  const frames = Math.round((h1 - h0) / FRAME_H);
  let prev = Number.NaN;
  let worstStep = 0;
  let worstStepAt = h0;
  let worstIdealErr = 0;
  for (let k = 0; k <= frames; k++) {
    const h = (h0 + k * FRAME_H) % 24;
    const t = 10 + k * DT;
    r.update(h, t);
    idealPriv.envHours = Number.NaN;
    ideal.update(h, t);
    const total = totalUp(r);
    const ibl = effectiveIbl(r);
    if (k > 0) {
      const step = Math.abs(ibl - prev) / total;
      if (step > worstStep) {
        worstStep = step;
        worstStepAt = h;
      }
    }
    worstIdealErr = Math.max(worstIdealErr, Math.abs(ibl - effectiveIbl(ideal)) / total);
    prev = ibl;
  }
  let shortGaps = 0;
  for (let i = 1; i < r.bakeTimes.length; i++) if (r.bakeTimes[i]! - r.bakeTimes[i - 1]! < 0.5 - 1e-9) shortGaps++;
  // The first frame's bake (no map yet) is setup, not part of the window.
  return { frames, bakes: r.env.envBakes - 1, worstStep, worstStepAt, worstIdealErr, shortGaps };
}

describe('smooth dawn and dusk sky light', () => {
  for (const [name, h0, h1] of [['dusk', 17, 21], ['dawn', 4.5, 8.5]] as const) {
    it(`${name} ${h0}:00-${h1}:00: the effective sky light changes continuously and follows the sky`, () => {
      const s = sweep(h0, h1);
      expect(s.worstStep, `largest per-frame step of the sky light (share of the total) at ${s.worstStepAt.toFixed(4)} h`).toBeLessThan(0.005);
      expect(s.worstIdealErr, 'largest difference from baking every frame (share of the total)').toBeLessThan(0.02);
      expect(s.bakes).toBeGreaterThan(20);
      expect(s.bakes).toBeLessThan(300);
      // Ordinary bakes, the sun fully setting or rising included, are at least half a real second apart.
      expect(s.shortGaps).toBe(0);
    });
  }

  it('re-bakes rarely around noon', () => {
    const s = sweep(11, 13);
    expect(s.bakes).toBeLessThan(10);
    expect(s.worstStep).toBeLessThan(0.005);
    expect(s.shortGaps).toBe(0);
  });

  it('the sun fully setting waits for the half-second interval, then bakes', () => {
    const r = rig();
    // Find the frame where the baked sky's sun first reaches zero visibility at dusk.
    const priv = r.env as unknown as { envSunVis: number };
    let h = 18;
    let t = 10;
    r.update(h, t);
    while (priv.envSunVis !== 0 && h < 21) {
      h += FRAME_H;
      t += DT;
      r.update(h, t);
    }
    expect(priv.envSunVis).toBe(0);
    const settledAt = r.bakeTimes[r.bakeTimes.length - 1]!;
    const prior = r.bakeTimes[r.bakeTimes.length - 2]!;
    expect(settledAt - prior).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });

  it('bakes on the same frame after a jump in time and after a context restore', () => {
    const r = rig();
    r.update(18.4, 1);
    const before = r.env.envBakes;
    expect(before).toBe(1);
    r.update(21.4, 1 + DT);
    expect(r.env.envBakes).toBe(before + 1);
    expect(r.env.lastBakeHour).toBeCloseTo(21.4, 6);
    r.update(21.4 + FRAME_H, 1 + 2 * DT);
    expect(r.env.envBakes).toBe(before + 1);
    r.env.contextRestored();
    r.update(21.4 + 2 * FRAME_H, 1 + 3 * DT);
    expect(r.env.envBakes).toBe(before + 2);
  });

  it('compensates the stale map within 0.5-2x and leaves the no-float path uncompensated', () => {
    const r = rig();
    r.update(18.8, 0);
    const k = (h: number) => {
      r.update(h, 0);
      return lum(r.env.bakedUp) > 0 ? r.scene.environmentIntensity : 0;
    };
    // Same real time: the rate limit holds the bake, the compensation follows the sky.
    const i0 = k(18.8);
    const i1 = k(18.9);
    expect(i1).toBeLessThan(i0);
    const ratio = (lum(r.env.upNow) / lum(r.env.bakedUp));
    expect(ratio).toBeLessThan(1);

    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer();
    const env = new Environment(scene, renderer, { hdr: false });
    env.update(18.8, new THREE.Vector3(), new THREE.PerspectiveCamera(), 0, renderer);
    expect(env.envFill).not.toBeNull();
    expect(env.envBakes).toBe(0);
  });
});
