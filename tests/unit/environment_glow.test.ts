// The city's glow over its own horizon (render/environment.ts): on the city's land (its beach and its headlands
// included) the night sky, its stars and the fog are exactly what they were; off it the glow gathers over the city, the
// stars brighten and the fog loses most of its warm glow, all the way by 600 m out. Environment.setShore also feeds the
// sea Las Lomas County's depth map, freed with the environment.
// The stub header is copied from env_smooth.test.ts (vi.mock cannot be shared between files).

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { cityAway, CITY_AWAY_RANGE, cityLand, Environment } from '../../src/render/environment';
import { CAUSEWAY_NAME } from '../../src/world/country';
import { mkRect } from '../../src/world/layout';
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

/** main's night horizon glow and the fog's share of it (environment.ts NIGHT_HORIZON_GLOW, FOG_GLOW_STRENGTH), frozen. */
const NIGHT_HORIZON_GLOW = new THREE.Color(0.16, 0.11, 0.08);
const FOG_GLOW_STRENGTH = 0.25;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function rig(shore: boolean) {
  const renderer = new THREE.WebGLRenderer();
  const env = new Environment(new THREE.Scene(), renderer, { hdr: false });
  if (shore) env.setShore(world().layout);
  const cam = new THREE.PerspectiveCamera();
  const u = (env.sky.material as THREE.ShaderMaterial).uniforms;
  const at = (hours: number, x: number, z: number) => {
    cam.position.set(x, 2, z);
    env.update(hours, new THREE.Vector3(x, 0, z), cam, 10, renderer);
  };
  return { env, u, at };
}

/** main's fog colour, from the sky's own top and horizon colours this frame: the night's glow at its full share times `k`. */
function fogAsMain(r: ReturnType<typeof rig>, k = 1): THREE.Color {
  const night = r.env.night;
  const dark = smoothstep(0.55, 1, night);
  const top = r.u.uTop!.value as THREE.Color;
  return (r.u.uHorizon!.value as THREE.Color).clone().lerp(NIGHT_HORIZON_GLOW, dark * FOG_GLOW_STRENGTH * k).lerp(top, 0.15 * (1 - night));
}

const land = () => {
  const b = world().layout.bounds;
  return mkRect(b.landMinX, b.landMinZ, b.beachEndX, b.landMaxZ);
};

describe('uCityAway', () => {
  it('is 0 on the city\'s land, its beach and its headlands included, and rises smoothly to 1 by 600 m off it', () => {
    const r = land();
    const city = cityLand(world().layout);
    expect(city[0]).toEqual(r);
    for (let x = r.minX; x <= r.maxX; x += 13.7) for (let z = r.minZ; z <= r.maxZ; z += 13.7) expect(cityAway(city, x, z)).toBe(0);
    for (const [x, z] of [[r.minX, r.minZ], [r.maxX, r.maxZ], [r.minX, 0], [0, r.maxZ]] as const) expect(cityAway(city, x, z)).toBe(0);
    // Azura Point and Smuggler's Key are the city's; the causeway leads off it to Las Lomas County.
    const heads = world().layout.headlands;
    expect(heads.map((h) => h.name).sort()).toEqual(['Azura Point', CAUSEWAY_NAME, "Smuggler's Key"].sort());
    for (const h of heads.filter((q) => q.name !== CAUSEWAY_NAME)) for (const q of h.rects) for (const [x, z] of [[q.minX, q.minZ], [q.maxX, q.maxZ], [(q.minX + q.maxX) / 2, (q.minZ + q.maxZ) / 2]] as const) expect(cityAway(city, x, z), h.name).toBe(0);
    const causeway = heads.find((h) => h.name === CAUSEWAY_NAME)!.rects[0]!;
    expect(cityAway(city, causeway.minX, (causeway.minZ + causeway.maxZ) / 2)).toBe(cityAway([r], causeway.minX, (causeway.minZ + causeway.maxZ) / 2));
    expect(CITY_AWAY_RANGE).toBe(600);
    // Out west across Lomas Sound into Las Lomas County, and out to sea north-east.
    let prev = 0;
    for (let d = 0; d <= 700; d += 10) {
      const a = cityAway(city, r.minX - d, 0);
      expect(a).toBeGreaterThanOrEqual(prev);
      expect(cityAway(city, r.maxX + d * 0.6, r.minZ - d * 0.8)).toBeCloseTo(a, 12);
      prev = a;
    }
    expect(cityAway(city, r.minX - 1, 0)).toBeLessThan(1e-5);
    expect(cityAway(city, r.minX - 300, 0)).toBeCloseTo(0.5, 12);
    expect(cityAway(city, r.minX - 600, 0)).toBe(1);
    expect(cityAway(city, -1200, 0)).toBe(1);
  });

  it('on the city\'s land every frame of the sky and the fog is what it was: the glow all round, the stars and the fog as main had them', () => {
    const shored = rig(true);
    const bare = rig(false);
    const r = land();
    for (const hours of [0.5, 3, 12, 19.6, 21, 23.5]) {
      // The land, and the city's headlands: Azura Point's lookout at its tip and Smuggler's Key.
      for (const [x, z] of [[0, 0], [r.minX, -300], [r.minX + 2, 250], [r.maxX, 30], [-200, r.minZ], [400, r.maxZ], [530, 0], [87.5, -632], [250, -678], [284, -612]] as const) {
        shored.at(hours, x, z);
        bare.at(hours, x, z);
        expect(shored.u.uCityAway!.value).toBe(0);
        for (const k of ['uStars', 'uNight', 'uMoon']) expect(shored.u[k]!.value, k).toBe(bare.u[k]!.value);
        for (const k of ['uTop', 'uHorizon', 'uGlow', 'uCityGlow']) expect((shored.u[k]!.value as THREE.Color).toArray(), k).toEqual((bare.u[k]!.value as THREE.Color).toArray());
        expect(shored.env.fog.color.toArray()).toEqual(bare.env.fog.color.toArray());
        expect(shored.env.fog.color.toArray()).toEqual(fogAsMain(shored).toArray());
      }
    }
    // Before setShore (as in every older test) the whole world is the city's.
    bare.at(1, -1200, 0);
    expect(bare.u.uCityAway!.value).toBe(0);
  });

  it('the sky shader leaves the glow and the stars alone at 0, and gathers the glow over the city as it rises', () => {
    const fs = (rig(false).env.sky.material as THREE.ShaderMaterial).fragmentShader;
    expect(fs).toContain('uniform vec2 uCityGlowDir;');
    expect(fs).toContain('uniform float uCityAway;');
    expect(fs).toContain('float toCity = max(dot(hz, uCityGlowDir), 0.0);');
    expect(fs).toContain('float cityK = mix(1.0, toCity * toCity * toCity, uCityAway);');
    expect(fs).toContain('uCityGlow * cityK * exp(-max(h, 0.0) * 6.50)');
    expect(fs).toContain('stars(d, pix) * uStars * (1.0 + 1.5 * uCityAway) * smoothstep(0.02, 0.25, h)');
    // One horizontal bearing for the glow and the hills.
    expect(fs.match(/vec2 hz = /g)?.length).toBe(1);
  });

  it('off the land it points the glow at the city\'s centre, and by 600 m out the fog keeps 30% of its night glow', () => {
    const r = rig(true);
    const b = world().layout.bounds;
    const cx = (b.cityMinX + b.cityMaxX) / 2;
    const cz = (b.cityMinZ + b.cityMaxZ) / 2;
    // On Coyote Ridge, west of the city across Lomas Sound, at 01:00.
    r.at(1, -1480, -200);
    expect(r.u.uCityAway!.value).toBe(1);
    const dir = r.u.uCityGlowDir!.value as THREE.Vector2;
    expect(dir.length()).toBeCloseTo(1, 9);
    expect(dir.x).toBeCloseTo((cx + 1480) / Math.hypot(cx + 1480, cz + 200), 9);
    expect(dir.y).toBeCloseTo((cz + 200) / Math.hypot(cx + 1480, cz + 200), 9);
    const fog = r.env.fog.color;
    expect(fog.r).toBeCloseTo(fogAsMain(r, 0.3).r, 12);
    expect(fog.g).toBeCloseTo(fogAsMain(r, 0.3).g, 12);
    expect(fog.b).toBeCloseTo(fogAsMain(r, 0.3).b, 12);
    // Less warm than in the city.
    expect(fog.r - fog.b).toBeLessThan(fogAsMain(r).r - fogAsMain(r).b);
    // Halfway there at 300 m out.
    r.at(1, b.landMinX - 300, 0);
    expect(r.u.uCityAway!.value).toBeCloseTo(0.5, 9);
  });
});

describe('Environment.setShore', () => {
  it('feeds the sea Las Lomas County\'s depth map, and dispose frees it', () => {
    const { env } = rig(true);
    const tex = env.sea.uCountyDepth.value!;
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(env.sea.uCountyBox.value.x).toBe(world().layout.country.bounds.minX);
    const dispose = vi.spyOn(tex, 'dispose');
    env.dispose();
    expect(dispose).toHaveBeenCalled();
  });
});
