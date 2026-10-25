// Lighting track: the sky HDRI as the image-based light's source, blended with the time-of-day sky (VAL-LIT-001, -002),
// and the city glow on the night sky (VAL-LIT-006). The stub header is copied from env_smooth.test.ts.

import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cityGlow, Environment, HDRI_H, HDRI_MAX, HDRI_W, hdriWeight, prepareHdri, type PreparedHdri } from '../../src/render/environment';
import { assets } from '../../src/render/assets';
import { loadAssetsFromDisk, unloadAssets } from '../../src/render/assets/testing';

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
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.domElement = params.canvas;
    }
    setPixelRatio(): void {}
    setSize(): void {}
    setRenderTarget(): void {}
    getRenderTarget(): unknown {
      return null;
    }
    compile(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});


const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

let hdri: PreparedHdri | null = null;
beforeAll(async () => {
  await loadAssetsFromDisk({ filter: (e) => e.id === 'env.sky' });
  hdri = prepareHdri(assets.texture('env.sky'));
});
afterAll(() => unloadAssets());

function rig(opts: { hdri?: PreparedHdri | null; hdr?: boolean } = {}) {
  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer();
  const env = new Environment(scene, renderer, { hdr: opts.hdr ?? true, hdri: opts.hdri });
  const target = new THREE.WebGLRenderTarget(4, 4);
  const priv = env as unknown as Record<string, unknown>;
  const bakes: Array<Record<string, unknown>> = [];
  const u = (priv.envMat as THREE.ShaderMaterial).uniforms;
  priv.pmrem = {
    fromCubemap: () => {
      bakes.push({ top: (u.uTop!.value as THREE.Color).clone(), horizon: (u.uHorizon!.value as THREE.Color).clone(), sun: (u.uSun!.value as THREE.Color).clone(), mix: u.uHdriMix!.value, gain: (u.uHdriGain!.value as THREE.Color).clone(), gainH: (u.uHdriGainH!.value as THREE.Color).clone() });
      return target;
    },
    dispose: () => {},
  };
  priv.cubeTarget = { texture: new THREE.Texture(), dispose: () => {} };
  priv.cubeCamera = { update: () => {} };
  const cam = new THREE.PerspectiveCamera();
  const focus = new THREE.Vector3();
  return { env, scene, renderer, bakes, u, update: (h: number, t: number, w?: { cloud: number; rain: number; storm: number; fog: number }) => env.update(h, focus, cam, t, renderer, w) };
}

/** Effective IBL an up-facing surface gets once the map is fresh (forced bake): the baked map's up radiance x intensity. */
function effectiveUp(r: ReturnType<typeof rig>, h: number, w?: { cloud: number; rain: number; storm: number; fog: number }): number {
  (r.env as unknown as { envHours: number }).envHours = Number.NaN;
  r.update(h, 100 + h, w);
  return lum(r.env.bakedUp) * r.scene.environmentIntensity;
}

/** The up radiance of the map the bake shader draws (gradient blended with the gained HDRI, plus the sun lobe), from the bake's uniforms. */
function shaderUp(r: ReturnType<typeof rig>): THREE.Color {
  const b = r.bakes[r.bakes.length - 1]!;
  const top = b.top as THREE.Color;
  const hor = b.horizon as THREE.Color;
  const gain = b.gain as THREE.Color;
  const gainH = b.gainH as THREE.Color;
  const mix = b.mix as number;
  const sunY = r.env.sunDir.y;
  const sun = (b.sun as THREE.Color).clone().multiplyScalar(0.2 * Math.max(0, sunY));
  const grad = new THREE.Color(0.892 * top.r + 0.108 * hor.r, 0.892 * top.g + 0.108 * hor.g, 0.892 * top.b + 0.108 * hor.b);
  const t = hdri!.upTop;
  const h = hdri!.upHorizon;
  const fromHdri = new THREE.Color(t.r * gain.r + h.r * gainH.r, t.g * gain.g + h.g * gainH.g, t.b * gain.b + h.b * gainH.b);
  return grad.multiplyScalar(1 - mix).add(fromHdri.multiplyScalar(mix)).add(sun);
}

function totalUp(r: ReturnType<typeof rig>, ibl: number): number {
  const { env } = r;
  const key = env.sun.position.clone().sub(env.sun.target.position).normalize();
  return (env.sun.intensity * lum(env.sun.color) * Math.max(0, key.y) + env.hemi.intensity * lum(env.hemi.color)) / Math.PI + ibl;
}

describe('sky HDRI as the image-based light', () => {
  it('reduces the committed HDRI to a sun-clamped equirect with a blue zenith', () => {
    expect(hdri, 'env.sky loads from disk and is usable').not.toBeNull();
    const t = hdri!.texture;
    expect([t.image.width, t.image.height]).toEqual([HDRI_W, HDRI_H]);
    expect(t.type).toBe(THREE.HalfFloatType);
    const px = (i: number, j: number) => {
      const d = t.image.data as Uint16Array;
      const o = (j * HDRI_W + i) * 4;
      return [0, 1, 2].map((c) => THREE.DataUtils.fromHalfFloat(d[o + c]!));
    };
    // Row HDRI_H - 1 is the zenith: a blue sky there.
    let r = 0;
    let b = 0;
    for (let i = 0; i < HDRI_W; i++) {
      const [pr, , pb] = px(i, HDRI_H - 2);
      r += pr!;
      b += pb!;
    }
    expect(b).toBeGreaterThan(r);
    expect(lum(hdri!.up)).toBeGreaterThan(0);
  });

  it('is the bake source on hardware tiers, and the effective sky light is the analytic one at every hour', () => {
    const withHdri = rig({ hdri });
    const plain = rig({ hdri: null });
    expect(withHdri.env.envSource).toBe('hdri');
    expect(plain.env.envSource).toBe('analytic');
    expect(rig({ hdri, hdr: false }).env.envSource).toBe('fill');
    let worstStep = 0;
    let worstAt = 0;
    let worstDiff = 0;
    let prev = Number.NaN;
    const mixes: number[] = [];
    for (let k = 0; k <= 2400; k++) {
      const h = k * 0.01;
      const e = effectiveUp(withHdri, h);
      const p = effectiveUp(plain, h);
      // What the shader bakes agrees with bakedUp (the light the scene is given).
      const su = shaderUp(withHdri);
      expect(Math.abs(lum(su) - lum(withHdri.env.bakedUp)), `map vs bakedUp at ${h.toFixed(2)} h`).toBeLessThan(0.002 + 0.01 * lum(withHdri.env.bakedUp));
      const total = totalUp(withHdri, e);
      mixes.push(withHdri.bakes[withHdri.bakes.length - 1]!.mix as number);
      worstDiff = Math.max(worstDiff, Math.abs(e - p) / total);
      if (k > 0 && Math.abs(e - prev) / total > worstStep) {
        worstStep = Math.abs(e - prev) / total;
        worstAt = h;
      }
      prev = e;
    }
    // By day the HDRI changes the map's structure, not its light; around sunset and dawn its part is smoothed.
    // (Smoothing the sunset's fall moves the light by up to a fifth of the total for a while around 19:00.)
    expect(worstDiff).toBeLessThan(0.25);
    expect(Math.abs(effectiveUp(withHdri, 12) - effectiveUp(plain, 12)) / effectiveUp(plain, 12)).toBeLessThan(0.03);
    expect(worstStep, `largest change per 0.01 h, share of the total diffuse light, at ${worstAt.toFixed(2)} h`).toBeLessThan(0.005);
    // The blend weight itself is continuous in the hour, full by day and gone at night.
    let worstMix = 0;
    for (let i = 1; i < mixes.length; i++) worstMix = Math.max(worstMix, Math.abs(mixes[i]! - mixes[i - 1]!));
    expect(worstMix).toBeLessThan(0.02);
    expect(mixes[1200]).toBeCloseTo(HDRI_MAX, 2);
    expect(mixes[2300]).toBeCloseTo(HDRI_MAX, 6);
    expect(effectiveUp(withHdri, 23)).toBeLessThan(0.15 * effectiveUp(withHdri, 12));
  });

  it('overcast and rain dim it as they dim the analytic sky, and thin the HDRI out', () => {
    const r = rig({ hdri });
    const clear = effectiveUp(r, 12);
    const grey = effectiveUp(r, 12, { cloud: 1, rain: 1, storm: 0, fog: 0 });
    const plain = rig({ hdri: null });
    expect(grey).toBeLessThan(clear);
    const plainGrey = effectiveUp(plain, 12, { cloud: 1, rain: 1, storm: 0, fog: 0 });
    expect(Math.abs(grey - plainGrey) / plainGrey).toBeLessThan(0.01);
    expect(hdriWeight(12, 1)).toBeLessThan(hdriWeight(12, 0) * 0.5);
  });

  it('without the HDRI the bake is the analytic one, unchanged', () => {
    const a = rig({ hdri: null });
    const b = rig({ hdri });
    for (const h of [0, 5.5, 6.5, 9, 12, 17, 18.4, 19, 19.6, 21, 23]) {
      effectiveUp(a, h);
      effectiveUp(b, h);
      const x = a.bakes[a.bakes.length - 1]!;
      const y = b.bakes[b.bakes.length - 1]!;
      expect(x.mix).toBe(0);
      for (const k of ['top', 'horizon', 'sun'] as const) {
        const cx = x[k] as THREE.Color;
        const cy = y[k] as THREE.Color;
        for (const c of ['r', 'g', 'b'] as const) expect(Math.abs(cx[c] - cy[c]), `${k}.${c} at ${h} h`).toBeLessThanOrEqual(0.01 * Math.max(cx[c], 1e-3));
      }
    }
  });

  it('a bake after a context restore uses the HDRI again', () => {
    const r = rig({ hdri });
    r.update(12, 1);
    const n = r.bakes.length;
    r.env.contextRestored();
    r.update(12, 1.02);
    expect(r.bakes.length).toBe(n + 1);
    expect(r.bakes[n]!.mix).toBeGreaterThan(0.5);
  });
});

describe('city glow on the night sky', () => {
  it('is 0 at noon, full at night and ramps without steps over dusk and dawn', () => {
    expect(cityGlow(12)).toBe(0);
    expect(cityGlow(9)).toBe(0);
    expect(cityGlow(16)).toBe(0);
    for (const h of [22.5, 23, 0, 2, 3]) expect(cityGlow(h)).toBeCloseTo(1, 2);
    let worst = 0;
    for (let k = 1; k <= 2400; k++) worst = Math.max(worst, Math.abs(cityGlow(k * 0.01) - cityGlow((k - 1) * 0.01)));
    expect(worst).toBeLessThanOrEqual(0.005);
  });

  it('drives a warm sky uniform that is off by day', () => {
    const r = rig({ hdri: null });
    const sky = (r.env.sky.material as THREE.ShaderMaterial).uniforms.uCityGlow!.value as THREE.Color;
    r.update(12, 1);
    expect(lum(sky)).toBe(0);
    r.update(23, 2);
    expect(sky.r).toBeGreaterThan(sky.b);
    expect(lum(sky)).toBeGreaterThan(0.02);
  });
});
