// Rain visuals: streaks round the camera (render/rain.ts) with their cover map (render/rainCover.ts), wet ground
// (render/wetGround.ts), wet-road light streaks and tyre spray, and rain leaving the driving alone. Headless, with
// the stub header of light_sprites.test.ts.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LightSprites, STREAK_CAPACITY } from '../../src/render/lightSprites';
import { QUALITY } from '../../src/render/quality';
import { Rain, RAIN_BOX, RAIN_CAPACITY, SOFTWARE_RAIN_DROPS } from '../../src/render/rain';
import { buildCoverMap, COVER_NONE, coverAt } from '../../src/render/rainCover';
import { GameRenderer } from '../../src/render/renderer';
import type { Sim } from '../../src/sim/sim';
import { WATER_Y } from '../../src/world/constants';
import { cloudNoiseData } from '../../src/render/textures';
import { coverWetness, puddleMask, puddleNoise, rippleGain } from '../../src/render/wetGround';
import { rectD, rectW, type Rect } from '../../src/world/layout';
import type { StaticWorld } from '../../src/world/staticWorld';
import { freshWorld, input, makeSim, placeInCar, teleport, world } from './helpers';

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
    render(): void {}
    setRenderTarget(): void {}
    dispose(): void {}
    getRenderTarget(): unknown {
      return null;
    }
    getActiveCubeFace(): number {
      return 0;
    }
    getActiveMipmapLevel(): number {
      return 0;
    }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});


const DT = 1 / 60;
const HDR = { renderer: '', halfFloat: true };
const SOFTWARE = { renderer: 'Google SwiftShader', halfFloat: true };
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

function setup(quality: 'high' | 'medium' | 'low', gpu = HDR) {
  const sim = makeSim({ world: W });
  sim.clock.set(12);
  const r = new GameRenderer(canvas(), W, { quality, fov: 68, gpu });
  r.attach(sim);
  r.cameraCtl.mode = 'play';
  r.cameraCtl.reset(sim);
  const frame = (dt = DT) => {
    sim.update(dt, input());
    r.render(dt, false);
    return r.stats();
  };
  return { sim, r, frame };
}

/** A fake program build: the patched shader source for a material, as three would hand it to onBeforeCompile. */
function compiled(mat: THREE.Material, lib: 'standard' | 'lambert' = 'standard'): { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string } {
  const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib[lib].vertexShader, fragmentShader: THREE.ShaderLib[lib].fragmentShader };
  mat.onBeforeCompile(shader as never, {} as never);
  return shader;
}

describe('rain streaks', () => {
  it('per tier: High 6000, Medium 3500, Low 1500, software 500, following tier switches', () => {
    expect([QUALITY.high.rainDrops, QUALITY.medium.rainDrops, QUALITY.low.rainDrops]).toEqual([6000, 3500, 1500]);
    expect(RAIN_CAPACITY).toBe(6000);
    const { r, sim, frame } = setup('high');
    sim.weather.override('rain', 0);
    for (const q of ['high', 'medium', 'low', 'high'] as const) {
      r.setQuality(q);
      expect(frame().rainDrops, q).toBe(QUALITY[q].rainDrops);
      expect(r.rain.mesh.geometry.instanceCount, q).toBe(QUALITY[q].rainDrops);
    }
    r.dispose();
    const soft = setup('high', SOFTWARE);
    expect(soft.r.software).toBe(true);
    soft.sim.weather.override('rain', 0);
    expect(soft.frame().rainDrops).toBe(SOFTWARE_RAIN_DROPS);
    expect(SOFTWARE_RAIN_DROPS).toBe(500);
    soft.r.dispose();
  });

  it('none in clear weather; uRain follows weather.rain; lit by the scene light, so dimmer at night', () => {
    const { r, sim, frame } = setup('high');
    expect(frame().rainDrops).toBe(0);
    expect(r.rain.mesh.visible).toBe(false);
    sim.weather.override('rain', 0);
    frame();
    const u = r.rain.uniforms;
    expect(r.rain.mesh.visible).toBe(true);
    expect(u.uRain!.value).toBeCloseTo(sim.weather.state.rain, 6);
    sim.weather.setFields({ rain: 0.4 });
    frame();
    expect(u.uRain!.value).toBeCloseTo(0.4, 6);
    sim.weather.setFields(null);
    frame();
    const noon = (u.uColor!.value as THREE.Color).clone();
    sim.clock.set(23);
    frame();
    const night = u.uColor!.value as THREE.Color;
    expect(night.r + night.g + night.b).toBeLessThan(0.6 * (noon.r + noon.g + noon.b));
    expect(night.getHex()).toBe(new THREE.Color(0.72, 0.76, 0.82).multiply(r.env.smokeLight).getHex());
    r.dispose();
  });

  it('only uniforms change per frame: no attribute uploads, wind slants the fall, camera motion is tracked', () => {
    const rain = new Rain(buildCoverMap(W));
    rain.setCount(6000);
    const seed = rain.mesh.geometry.getAttribute('aSeed') as THREE.InstancedBufferAttribute;
    const v0 = seed.version;
    const light = new THREE.Color(1, 1, 1);
    const cam = new THREE.Vector3(0, 2, 0);
    for (let i = 0; i < 60; i++) {
      cam.x += 25 * DT;
      rain.update(DT, cam, 1, { x: 6, z: 0 }, light, 0.001);
    }
    expect(seed.version).toBe(v0);
    const u = rain.uniforms;
    expect((u.uVel!.value as THREE.Vector3).x).toBeGreaterThan(0);
    expect((u.uVel!.value as THREE.Vector3).y).toBeLessThan(-5);
    expect((u.uCamVel!.value as THREE.Vector3).x).toBeGreaterThan(20);
    // A teleport is not motion.
    cam.x += 500;
    rain.update(DT, cam, 1, { x: 6, z: 0 }, light, 0.001);
    expect((u.uCamVel!.value as THREE.Vector3).length()).toBeLessThan(1);
    const o = u.uOffset!.value as THREE.Vector3;
    expect(o.x).toBeGreaterThanOrEqual(0);
    expect(o.y).toBeGreaterThanOrEqual(0);
    expect(o.y).toBeLessThan(RAIN_BOX.y);
    rain.dispose();
  });

  it('the rain shader is compiled at warm-up, before the first shower', () => {
    const { r } = setup('high');
    const seen: string[] = [];
    const compile = vi.spyOn(r.renderer, 'compile').mockImplementation((scene: THREE.Object3D) => {
      scene.traverseVisible((o) => {
        if (o.name) seen.push(o.name);
      });
      return new Set() as never;
    });
    r.setQuality('medium');
    expect(compile).toHaveBeenCalled();
    expect(seen).toContain('rain');
    expect(r.rain.mesh.visible).toBe(false);
    r.dispose();
  });
});

describe('rain cover map', () => {
  const map = () => buildCoverMap(W);

  it("holds a building's roof height on its cells and nothing on an open road", () => {
    const m = map();
    const b = W.layout.buildings.find((x) => x.tiers.length > 0 && rectW(x.tiers[0]!) > 8 && rectD(x.tiers[0]!) > 8)!;
    const t = b.tiers[0]!;
    const cx = (t.minX + t.maxX) / 2;
    const cz = (t.minZ + t.maxZ) / 2;
    const top = Math.max(...b.tiers.filter((u) => u.minX < cx && u.maxX > cx && u.minZ < cz && u.maxZ > cz).map((u) => u.y1));
    expect(coverAt(m, cx, cz)).toBeCloseTo(top, 4);
    expect(coverAt(m, cx, cz)).toBeGreaterThan(3);
    const n = W.roads.nodes[Math.floor(W.roads.nodes.length / 2)]!;
    expect(coverAt(m, n.x, n.z)).toBe(COVER_NONE);
    expect(m.cell).toBe(2);
  });

  it('covers the inside of every garage at its roof and the pier under its deck', () => {
    const m = map();
    for (const g of W.layout.garages) {
      const cx = (g.rect.minX + g.rect.maxX) / 2;
      const cz = (g.rect.minZ + g.rect.maxZ) / 2;
      expect(coverAt(m, cx, cz), g.poi).toBeCloseTo(g.height + 0.4, 5);
      // Rain inside the garage, a metre above its floor, falls below the roof: not drawn.
      expect(coverAt(m, cx, cz)).toBeGreaterThan(1);
    }
    expect(W.layout.garages.length).toBeGreaterThan(0);
    const pier = W.layout.decks.find((d) => d.name === 'Azura Pier')!;
    const px = (pier.rect.minX + pier.rect.maxX) / 2;
    const pz = (pier.rect.minZ + pier.rect.maxZ) / 2;
    expect(coverAt(m, px, pz)).toBeCloseTo(pier.y, 5);
    // Under the deck (water level) is covered; above it is not.
    expect(coverAt(m, px, pz)).toBeGreaterThan(WATER_Y);
  });
});

describe('wet ground', () => {
  it('patches the paved materials with uniforms only: weather changes neither material versions nor program keys', () => {
    const { r, sim, frame } = setup('high');
    const wet = r.city.wet;
    const names = new Set<string>();
    r.city.group.traverse((o) => {
      if (o instanceof THREE.Mesh && wet.materials.includes(o.material as THREE.MeshStandardMaterial)) names.add(o.name);
    });
    for (const n of ['roads', 'sidewalks', 'ground-plaza', 'markings-white']) expect(names, n).toContain(n);
    expect(names).not.toContain('ground-grass');
    frame();
    const before = wet.materials.map((m) => [m.version, m.customProgramCacheKey(), m.onBeforeCompile.toString()]);
    for (const kind of ['rain', 'storm', 'overcast', 'clear'] as const) {
      sim.weather.override(kind, 0);
      for (let i = 0; i < 5; i++) frame();
      sim.clock.set(23);
      frame();
      sim.clock.set(12);
    }
    expect(wet.materials.map((m) => [m.version, m.customProgramCacheKey(), m.onBeforeCompile.toString()])).toEqual(before);
    const s = compiled(wet.materials[0]!);
    expect(s.uniforms.uWet).toBe(wet.uniforms.uWet);
    expect(s.fragmentShader).toContain('roughnessFactor = mix( roughnessFactor, 0.12, wetK )');
    expect(s.fragmentShader).toContain('wetPuddle');
    expect(s.fragmentShader).toContain('normal = normalize( mix( normal, wetN, wetPuddle ) )');
    expect(s.vertexShader).toContain('vWetPos = ( modelMatrix');
    // Nothing in the patch is a define: no #if on any weather or tier switch.
    expect(s.fragmentShader).not.toMatch(/#if\w*\s+\w*WET/);
    r.dispose();
  });

  it('uWet tracks weather.wet (also as state().render.wet) and rain ripples only while it rains', () => {
    const { r, sim, frame } = setup('high');
    const u = r.city.wet.uniforms;
    expect(frame().wet).toBe(0);
    sim.weather.setFields({ wet: 0.9, rain: 1 });
    const s = frame();
    expect(s.wet).toBeCloseTo(sim.weather.state.wet, 6);
    expect(u.uWet.value).toBeCloseTo(0.9, 6);
    expect(u.uRainNow.value).toBeCloseTo(1, 6);
    expect(r.lightSprites.wet).toBeCloseTo(0.9, 6);
    sim.weather.setFields({ wet: 0.9, rain: 0 });
    frame();
    expect(u.uRainNow.value).toBe(0);
    r.dispose();
  });

  it('full (puddles, ripples, dry cover) on High and Medium; simple on Low and software', () => {
    const { r } = setup('high');
    expect(r.city.wet.mode).toBe('full');
    r.setQuality('medium');
    expect(r.city.wet.mode).toBe('full');
    r.setQuality('low');
    expect(r.city.wet.mode).toBe('simple');
    expect(r.city.wet.uniforms.uCover.value).toBe(r.rain.cover);
    r.dispose();
    const soft = setup('high', SOFTWARE);
    expect(soft.r.city.wet.mode).toBe('simple');
    soft.r.dispose();
  });

  it('no puddle or ripple where cover keeps the ground dry, as in the docks spray garage; open ground still gets them', () => {
    const m = buildCoverMap(W);
    const noise = cloudNoiseData();
    const at = (x: number, z: number, wet = 1, rain = 1) => {
      const wetK = coverWetness(wet, coverAt(m, x, z), W.groundHeight(x, z));
      const n = puddleNoise(noise, x, z);
      const puddle = puddleMask(wetK, n);
      return { wetK, n, puddle, ripple: rippleGain(puddle, rain) };
    };
    // Inside the docks spray garage, where the noise alone would make a full puddle.
    const docks = W.layout.garages.find((g) => g.poi === 'spray_docks')!;
    const inDocks = at(-325.7, 291.6);
    expect(-325.7).toBeGreaterThan(docks.rect.minX);
    expect(291.6).toBeLessThan(docks.rect.maxZ);
    expect(inDocks.n).toBeGreaterThan(0.85);
    expect(puddleMask(1, inDocks.n)).toBe(1);
    expect(inDocks).toMatchObject({ wetK: 0, puddle: 0, ripple: 0 });
    // Every covered cell of every garage, deck and pier, in heavy rain on soaked ground.
    let covered = 0;
    const cells: Rect[] = [...W.layout.garages.map((g) => g.rect), ...W.layout.decks.map((d) => d.rect)];
    for (const r of cells) {
      for (let x = r.minX + 0.25; x < r.maxX; x += 0.5) {
        for (let z = r.minZ + 0.25; z < r.maxZ; z += 0.5) {
          if (coverAt(m, x, z) <= W.groundHeight(x, z) + 0.3) continue;
          covered++;
          const c = at(x, z);
          expect(c.puddle, `${x},${z}`).toBe(0);
          expect(c.ripple, `${x},${z}`).toBe(0);
        }
      }
    }
    expect(covered).toBeGreaterThan(500);
    // Open ground near the docks still floods where the noise is high, and ripples while it rains.
    let open: ReturnType<typeof at> | null = null;
    for (let x = docks.rect.minX - 60; x < docks.rect.maxX + 60 && !open; x += 0.5) {
      for (let z = docks.rect.minZ - 60; z < docks.rect.maxZ + 60 && !open; z += 0.5) {
        if (coverAt(m, x, z) !== COVER_NONE) continue;
        const c = at(x, z);
        if (c.n > 0.85) open = c;
      }
    }
    expect(open).not.toBeNull();
    expect(open!.wetK).toBe(1);
    expect(open!.puddle).toBe(1);
    expect(open!.ripple).toBeCloseTo(0.6, 6);
    expect(rippleGain(open!.puddle, 0)).toBe(0);
    // Puddles fade in as the ground first gets wet rather than appearing whole.
    expect(puddleMask(0.05, open!.n)).toBeCloseTo(0.4, 6);
  });

  it('the shader gates the puddle mask by the cover-adjusted wetness', () => {
    const { r } = setup('high');
    const s = compiled(r.city.wet.materials[0]!);
    expect(s.fragmentShader).toContain('if ( roof > vWetPos.y + 0.3 ) wetK = 0.0;');
    expect(s.fragmentShader).toContain('wetPuddle = smoothstep( th, th + 0.05, n ) * min( 1.0, wetK * 8.0 );');
    expect(s.fragmentShader).toContain('texture2D( uPuddleTex, vWetPos.xz * 0.045 ).r * 0.65 + texture2D( uPuddleTex, vWetPos.xz * 0.13 + 0.37 ).r * 0.35');
    expect(s.fragmentShader).toContain('wetRipple *= 0.6 * wetPuddle * uRainNow;');
    r.dispose();
  });

  it("the software path's Lambert stand-ins darken with the same uniform and skip gloss and puddles", () => {
    const soft = setup('high', SOFTWARE);
    let lambert: THREE.MeshLambertMaterial | null = null;
    soft.r.city.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name === 'roads') lambert = o.material as THREE.MeshLambertMaterial;
    });
    expect(lambert).toBeInstanceOf(THREE.MeshLambertMaterial);
    const s = compiled(lambert!, 'lambert');
    expect(s.uniforms.uWet).toBe(soft.r.city.wet.uniforms.uWet);
    expect(s.fragmentShader).toContain('diffuseColor.rgb *= 1.0 - 0.35 * wetK');
    expect(s.fragmentShader).not.toContain('roughnessFactor = mix');
    expect(s.fragmentShader).not.toContain('mix( normal, wetN');
    soft.r.dispose();
  });
});

describe('wet-road streaks from street lamps and car lights', () => {
  it('at night on a wet road: at most 64, nearest the camera; none on a dry road', () => {
    const { r, sim, frame } = setup('high');
    sim.clock.set(23);
    const lamp = W.layout.props.find((p) => p.kind === 'lamp' && W.layout.props.filter((q) => q.kind === 'lamp' && Math.hypot(q.x - p.x, q.z - p.z) < 60).length > 8)!;
    teleport(sim, lamp.x + 2, lamp.z + 2);
    r.cameraCtl.reset(sim);
    expect(frame().streaks).toBe(0);
    sim.weather.setFields({ wet: 0.9 });
    const s = frame();
    expect(s.streaks).toBeGreaterThan(0);
    expect(s.streaks).toBeLessThanOrEqual(STREAK_CAPACITY);
    // Brighter with more water.
    const c = new THREE.Color();
    r.lightSprites.streaks.getColorAt(0, c);
    sim.weather.setFields({ wet: 0.45 });
    frame();
    const d = new THREE.Color();
    r.lightSprites.streaks.getColorAt(0, d);
    expect(d.r).toBeLessThan(c.r);
    // By day the lamps are off.
    sim.clock.set(12);
    sim.weather.setFields({ wet: 0.9 });
    expect(frame().streaks).toBe(0);
    r.dispose();
  });

  it('LightSprites keeps the 64 lights nearest the camera, lamps and glows together', () => {
    const ls = new LightSprites();
    ls.wet = 1;
    ls.begin(new THREE.Vector3(0, 2, 0), 800);
    // 100 lamps at shuffled distances 1..50 m, and a glow at 12.5 m.
    for (let i = 0; i < 100; i++) ls.offerStreakLight(((i * 37) % 100) * 0.5 + 1, 6, 0, 0.6, 0.5, 0.3);
    ls.addGlow({ kind: 'sirenRed', x: 0, y: 1, z: 12.5, fx: 0, fz: 0 });
    ls.finish(() => 0);
    expect(ls.counts.streaks).toBe(64);
    // The farthest kept lamp is the 63rd nearest (the glow takes one place).
    let far = 0;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    let red = 0;
    for (let i = 0; i < 64; i++) {
      ls.streaks.getMatrixAt(i, m);
      far = Math.max(far, Math.abs(p.setFromMatrixPosition(m).x));
      ls.streaks.getColorAt(i, c);
      if (c.r > 5 * c.g) red++;
    }
    expect(red).toBe(1);
    expect(far).toBeLessThan(32.5);
    ls.dispose();
  });

  it('streaks scale with how dark it is, so daytime rain reflects car lights more faintly than night', () => {
    const streakRed = (dark: number): number => {
      const ls = new LightSprites();
      ls.wet = 1;
      ls.dark = dark;
      ls.begin(new THREE.Vector3(0, 2, 0), 800);
      ls.addGlow({ kind: 'tail', x: 0, y: 0.8, z: 10, fx: 0, fz: 0 });
      ls.finish(() => 0);
      const c = new THREE.Color();
      ls.streaks.getColorAt(0, c);
      ls.dispose();
      return c.r;
    };
    const night = streakRed(1);
    expect(night).toBeGreaterThan(0);
    expect(streakRed(0.65)).toBeCloseTo(night * 0.65, 6);
  });

  it('the renderer hands max(night, weather dim) to the streaks', () => {
    const { r, sim, frame } = setup('high');
    sim.weather.override('rain', 0);
    sim.clock.set(12);
    frame();
    expect(r.lightSprites.dark).toBeCloseTo(sim.weather.state.dim, 6);
    expect(r.lightSprites.dark).toBeLessThan(1);
    sim.clock.set(23);
    frame();
    expect(r.lightSprites.dark).toBeCloseTo(1, 2);
    r.dispose();
  });
});

describe('tyre spray', () => {
  function drive(quality: 'high' | 'low', wet: number, speed: number) {
    const { r, sim } = setup(quality);
    const p = spot(sim);
    const v = sim.spawnVehicle('sports', p.x, p.z, 0);
    placeInCar(sim, v);
    r.cameraCtl.reset(sim);
    sim.weather.setFields({ wet, rain: wet > 0 ? 1 : 0 });
    sim.update(DT, input());
    const spray = vi.spyOn(r.effects, 'tyreSpray');
    v.vel.x = 0;
    v.vel.z = speed;
    v.speed = speed;
    for (let i = 0; i < 30; i++) r.render(DT, false);
    const calls = spray.mock.calls.length;
    const particles = r.stats().particles;
    r.dispose();
    return { calls, particles };
  }

  it('fast cars on a wet road throw spray on High; none on a dry road, when slow, or on Low', () => {
    const wetFast = drive('high', 0.8, 20);
    expect(wetFast.calls).toBeGreaterThan(0);
    expect(wetFast.particles).toBeGreaterThan(20);
    const dry = drive('high', 0, 20);
    expect(dry.calls).toBe(0);
    expect(dry.particles).toBeLessThan(wetFast.particles / 4);
    expect(drive('high', 0.8, 5).calls).toBe(0);
    expect(drive('high', 0.2, 20).calls).toBe(0);
    expect(drive('low', 0.8, 20).calls).toBe(0);
  });
});

describe('rain is visual only', () => {
  function run(kind: 'clear' | 'rain' | 'storm') {
    const sim = makeSim({ world: freshWorld(), weather: 'clear', ambient: true });
    sim.weather.override(kind, 0);
    if (kind !== 'clear') sim.weather.setFields({ wet: 1 });
    sim.clock.set(12);
    const p = spot(sim);
    const v = sim.spawnVehicle('sedan', p.x, p.z, 0);
    placeInCar(sim, v);
    const trace: number[] = [];
    for (let i = 0; i < 600; i++) {
      const steer = Math.sin(i / 40);
      sim.update(DT, input({ throttle: i < 400 ? 1 : 0, brake: i >= 450 ? 1 : 0, steer }));
      trace.push(v.pos.x, v.pos.z, v.speed, v.heading, v.skid);
      if (i % 30 === 0) for (const c of sim.characters) trace.push(c.pos.x, c.pos.z);
      if (i % 30 === 0) for (const u of sim.vehicles) trace.push(u.pos.x, u.pos.z);
    }
    return { trace, wet: sim.weather.state.wet, moved: Math.hypot(v.pos.x - p.x, v.pos.z - p.z) };
  }

  it('the same inputs drive the same in rain and storm (wet 1) as in clear weather, traffic and peds too', () => {
    const clear = run('clear');
    const rain = run('rain');
    const storm = run('storm');
    expect(rain.wet).toBe(1);
    expect(storm.wet).toBe(1);
    expect(clear.wet).toBe(0);
    expect(clear.moved).toBeGreaterThan(30);
    expect(rain.trace).toEqual(clear.trace);
    expect(storm.trace).toEqual(clear.trace);
  });
});
