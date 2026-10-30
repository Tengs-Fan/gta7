// Sea waves, shoreline and splashes: render/waves.ts, render/sea.ts, render/foamRings.ts, the renderer's sea wiring
// and the rockets that go off on the water (sim/combat.ts). Headless, with the stub header of rain.test.ts.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { QUALITY } from '../../src/render/quality';
import { GameRenderer, seaCrossing } from '../../src/render/renderer';
import { SHORE_GLSL, seaGrid, seaUniforms, surfPhases, updateSea } from '../../src/render/sea';
import { CALM_SEA, COARSE_CELL, COARSE_EXTENT, FINE_EXTENT, SEA_WAVES_GLSL, SKIRT_EXTENT, WAVES, waveDisplacement, wavePhases } from '../../src/render/waves';
import { Projectile } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import { BEACH_W, CURB_H, SAND_DROP, WATER_Y } from '../../src/world/constants';
import { input, makeSim, world } from './helpers';

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
const renderer = (quality: 'high' | 'medium' | 'low', gpu = HDR): GameRenderer => new GameRenderer(canvas(), world(), { quality, fov: 68, gpu });

/** A point well out in the sea, east of the beach, and one in the middle of the city. */
function seaPoint(): { x: number; z: number } {
  const b = world().layout.bounds;
  return { x: b.beachEndX + 80, z: (b.landMinZ + b.landMaxZ) / 2 };
}
function landPoint(): { x: number; z: number } {
  const b = world().layout.bounds;
  return { x: (b.cityMinX + b.cityMaxX) / 2, z: (b.cityMinZ + b.cityMaxZ) / 2 };
}

describe('waves', () => {
  it('four waves of 4 to 30 odd metres whose heights stay within 0.15 m in calm and 0.35 m in a storm', () => {
    expect(WAVES).toHaveLength(4);
    for (const w of WAVES) {
      expect(w.length).toBeGreaterThanOrEqual(4);
      expect(w.length).toBeLessThanOrEqual(31);
    }
    let calm = 0;
    let storm = 0;
    for (let i = 0; i < 4000; i++) {
      const x = (i % 63) * 1.37 - 40;
      const z = Math.floor(i / 63) * 1.11 - 30;
      const ph = wavePhases(i * 0.137);
      calm = Math.max(calm, Math.abs(waveDisplacement(x, z, 0, 0, ph, CALM_SEA)[1]));
      storm = Math.max(storm, Math.abs(waveDisplacement(x, z, 0, 0, ph, 1)[1]));
    }
    expect(calm).toBeLessThanOrEqual(0.15);
    expect(storm).toBeLessThanOrEqual(0.35);
    // Visibly larger in a storm.
    expect(storm).toBeGreaterThan(2.5 * calm);
  });

  it('the phases are wrapped in double precision and move smoothly frame to frame, even after hours', () => {
    for (const t0 of [0, 3600 * 5 + 0.37]) {
      const a = wavePhases(t0);
      const b = wavePhases(t0 + DT);
      for (let i = 0; i < 4; i++) {
        expect(a[i]!).toBeGreaterThanOrEqual(0);
        expect(a[i]!).toBeLessThan(Math.PI * 2);
        let d = Math.abs(b[i]! - a[i]!);
        d = Math.min(d, Math.PI * 2 - d);
        expect(d).toBeLessThan(0.1);
        expect(d).toBeGreaterThan(0);
      }
    }
  });

  it('displacement fades out before the grid coarsens past each wave and is gone at the skirt', () => {
    const ph = wavePhases(12.3);
    for (let i = 0; i < 4; i++) {
      // Each wave is sampled by at least four vertices per wavelength where it displaces.
      const w = WAVES[i]!;
      const cell = w.fadeEnd <= FINE_EXTENT ? 1 : COARSE_CELL;
      expect(w.length / cell).toBeGreaterThanOrEqual(4);
      expect(w.fadeEnd).toBeLessThan(COARSE_EXTENT);
    }
    for (let x = -COARSE_EXTENT; x <= COARSE_EXTENT; x += 37) {
      const d = waveDisplacement(x, COARSE_EXTENT, 0, 0, ph, 1);
      expect(Math.hypot(...d)).toBeLessThan(1e-9);
    }
  });
});

describe('the wave grid', () => {
  const g = seaGrid();
  const pos = g.getAttribute('position');
  const edge = g.getAttribute('aEdge');

  it('reaches the skirt, keeps every vertex on a whole-metre lattice, and faces up', () => {
    let far = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      far = Math.max(far, Math.abs(x), Math.abs(z));
      if (Math.max(Math.abs(x), Math.abs(z)) <= COARSE_EXTENT) {
        expect(Number.isInteger(x) && Number.isInteger(z)).toBe(true);
      }
      expect(pos.getY(i)).toBe(0);
    }
    expect(far).toBe(SKIRT_EXTENT);
    const idx = g.getIndex()!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let t = 0; t < idx.count; t += 3 * 97) {
      a.fromBufferAttribute(pos, idx.getX(t));
      b.fromBufferAttribute(pos, idx.getX(t + 1));
      c.fromBufferAttribute(pos, idx.getX(t + 2));
      const n = new THREE.Vector3().crossVectors(b.sub(a), c.sub(a));
      expect(n.y).toBeGreaterThan(0);
    }
  });

  it('marks exactly the fine rim vertices between coarse ones, which then sit on the coarse edges (no cracks)', () => {
    let marked = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const ex = edge.getX(i);
      const ez = edge.getY(i);
      if (ex || ez) {
        marked++;
        if (ex) expect(Math.abs(z)).toBe(FINE_EXTENT);
        if (ez) expect(Math.abs(x)).toBe(FINE_EXTENT);
        expect((ex ? x : z) % COARSE_CELL).not.toBe(0);
      }
    }
    // Four sides of 160 one-metre steps, three of every four between coarse vertices.
    expect(marked).toBe(4 * 2 * (FINE_EXTENT * 2 / COARSE_CELL) * (COARSE_CELL - 1) / 2);
    // The shader's rim rule, on the CPU: the displaced rim point lies on the segment between its coarse neighbours.
    const ph = wavePhases(4.2);
    const at = (x: number, z: number) => waveDisplacement(x, z, 0, 0, ph, 1);
    for (const x of [-79, -45, 13, 78]) {
      const s0 = Math.floor(x / COARSE_CELL) * COARSE_CELL;
      const f = (x - s0) / COARSE_CELL;
      const a = at(s0, FINE_EXTENT);
      const b = at(s0 + COARSE_CELL, FINE_EXTENT);
      const morph = a.map((v, k) => v + (b[k]! - v) * f);
      // Only the long waves still displace at the rim, so the morph moves the point by little.
      expect(Math.abs(morph[1]! - at(x, FINE_EXTENT)[1])).toBeLessThan(0.05);
    }
    expect(SEA_WAVES_GLSL).toContain('seaDisplaceEdge');
  });
});

describe('shoreline foam', () => {
  it('the quay pulse has no step when the surf phase wraps', () => {
    // The pulse is sin(quay phase); a frame apart it may move by at most the rate's own slope.
    const pulse = (t: number) => Math.sin(surfPhases(t).quay);
    const rate = 1.2 * 1.4 / 60;
    let worst = 0;
    let wraps = 0;
    for (let t = 0; t < 120; t += 1 / 60) {
      if (surfPhases(t + 1 / 60).surf < surfPhases(t).surf) wraps++;
      worst = Math.max(worst, Math.abs(pulse(t + 1 / 60) - pulse(t)));
    }
    expect(wraps).toBeGreaterThan(20);
    expect(worst).toBeLessThanOrEqual(rate + 1e-9);
    // Far into a session, too (float precision of the wrapped phase).
    for (const t0 of [5000, 86_000]) {
      for (let t = t0; t < t0 + 20; t += 1 / 60) expect(Math.abs(pulse(t + 1 / 60) - pulse(t))).toBeLessThanOrEqual(rate + 1e-6);
    }
    const u = seaUniforms();
    updateSea(u, 17.3, CALM_SEA, 0, 0);
    expect(u.uQuayPhase.value).toBeCloseTo((17.3 * 1.2 * 1.4) % (Math.PI * 2), 9);
    expect(u.uQuayPhase.value).toBeLessThan(Math.PI * 2);
    expect(SHORE_GLSL).toContain('sin(uQuayPhase + (p.x + p.y) * 0.21)');
    expect(SHORE_GLSL).not.toContain('uSurfPhase * 1.4');
  });
});

describe('the sea in the renderer', () => {
  it('High draws the displaced grid, Medium and Low the flat plane with wave normals, and software its own sea', () => {
    expect(QUALITY.high.waterGrid).toBe(true);
    expect(QUALITY.medium.waterGrid).toBe(false);
    expect(QUALITY.low.waterGrid).toBe(false);
    const high = renderer('high');
    expect(high.stats().waterGrid).toBe(true);
    expect(high.env.sea.uDisplace.value).toBe(1);
    expect(high.env.water.geometry.getAttribute('aEdge')).toBeTruthy();
    expect(high.env.water.geometry.getAttribute('position').count).toBeGreaterThan(50000);
    for (const q of ['medium', 'low'] as const) {
      const r = renderer(q);
      expect(r.stats().waterGrid, q).toBe(false);
      expect(r.env.sea.uDisplace.value).toBe(0);
      expect(r.env.water.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    }
    const sw = renderer('high', SOFTWARE);
    expect(sw.stats().waterGrid).toBe(false);
    const mat = sw.env.water.material as THREE.ShaderMaterial;
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    const main = mat.fragmentShader.slice(mat.fragmentShader.indexOf('void main()'));
    expect(main).toContain('seaSlope2(');
    expect(main).not.toMatch(/seaSlope\(/);
    expect(mat.fragmentShader).toContain('seaShallows');
  });

  it('a tier switch swaps the geometry and a uniform only: the same material and program key, the grid freed on leaving High', () => {
    const r = renderer('high');
    const mat = r.env.water.material as THREE.MeshStandardMaterial;
    const key = mat.customProgramCacheKey();
    const grid = r.env.water.geometry;
    const dispose = vi.spyOn(grid, 'dispose');
    r.setQuality('low');
    expect(r.env.water.geometry).not.toBe(grid);
    expect(dispose).toHaveBeenCalled();
    expect(r.env.water.material).toBe(mat);
    expect(mat.customProgramCacheKey()).toBe(key);
    expect(r.stats().waterGrid).toBe(false);
    r.setQuality('high');
    expect(r.env.water.geometry).toBe(grid);
    expect(r.stats().waterGrid).toBe(true);
  });

  it('the sea material declares the waves, shoreline and foam in its patch', () => {
    const r = renderer('medium');
    const mat = r.env.water.material as THREE.MeshStandardMaterial;
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, r.renderer);
    expect(shader.vertexShader).toContain('seaDisplaceEdge( seaBase.xz, aEdge )');
    expect(shader.fragmentShader).toContain('seaSlope( vSeaXZ');
    expect(shader.fragmentShader).toContain('seaFoam(');
    expect(shader.fragmentShader).toContain('seaShallows(');
    expect(shader.uniforms.uWavePhase).toBe(r.env.sea.uWavePhase);
    expect(shader.uniforms.uShoreLand).toBe(r.env.sea.uShoreLand);
  });

  it('the shoreline uniforms are the layout bounds and the beach constants', () => {
    const r = renderer('high');
    const b = world().layout.bounds;
    const land = r.env.sea.uShoreLand.value;
    const beach = r.env.sea.uShoreBeach.value;
    expect([land.x, land.y, land.z, land.w]).toEqual([b.landMinX, b.landMinZ, b.landMaxZ, b.beachEndX]);
    expect([beach.x, beach.y, beach.z, beach.w]).toEqual([b.beachStartX, BEACH_W, SAND_DROP, CURB_H]);
  });

  it('the sea state follows the weather, the grid follows the camera in whole cells, and the waves move with time', () => {
    const r = renderer('high');
    const sim = makeSim();
    r.attach(sim);
    r.render(DT, false);
    expect(r.env.sea.uSeaAmp.value).toBeCloseTo(0.3, 6);
    const p0 = r.env.sea.uWavePhase.value.clone();
    r.render(0.5, false);
    expect(r.env.sea.uWavePhase.value.clone().sub(p0).length()).toBeGreaterThan(0.1);
    sim.weather.override('storm', 0);
    sim.update(DT, input());
    r.render(DT, false);
    expect(r.env.sea.uSeaAmp.value).toBeGreaterThan(0.95);
    const cam = r.cameraCtl.camera.position;
    expect(r.env.water.position.x % COARSE_CELL).toBe(0);
    expect(r.env.water.position.z % COARSE_CELL).toBe(0);
    expect(Math.abs(r.env.water.position.x - cam.x)).toBeLessThanOrEqual(COARSE_CELL / 2);
    expect(r.env.water.position.y).toBe(WATER_Y);
  });

  it('the foam rings ride on the sea uniforms', () => {
    const r = renderer('high');
    const mat = r.effects.foam.mesh.material as THREE.ShaderMaterial;
    expect(mat.uniforms.uWavePhase).toBe(r.env.sea.uWavePhase);
    expect(mat.uniforms.uDisplace).toBe(r.env.sea.uDisplace);
    expect(mat.fragmentShader).toContain('#include <tonemapping_fragment>');
  });
});

describe('splashes', () => {
  it('a round fired into the sea splashes once where it crosses the surface, and its tracer ends there', () => {
    const r = renderer('high');
    const sim = makeSim();
    r.attach(sim);
    const splash = vi.spyOn(r.effects, 'splash');
    const tracer = vi.spyOn(r.effects, 'tracer');
    const impact = vi.spyOn(r.effects, 'impact');
    const s = seaPoint();
    // From 4 m above the sea, down to the seabed 20 m on.
    sim.events.emit('shot', { shooter: null, weapon: 'smg', fx: s.x, fy: WATER_Y + 4, fz: s.z, tx: s.x + 20, ty: -8, tz: s.z, hit: 'world', nx: 0, ny: 1, nz: 0, pellet: 0 });
    expect(splash).toHaveBeenCalledTimes(1);
    const [x, y, z, size] = splash.mock.calls[0]!;
    expect(x).toBeCloseTo(s.x + 20 * (4 / 11), 6);
    expect(y).toBeCloseTo(WATER_Y, 6);
    expect(z).toBeCloseTo(s.z, 6);
    expect(size).toBe('small');
    expect(tracer).toHaveBeenCalledTimes(1);
    expect(tracer.mock.calls[0]![4]).toBeCloseTo(WATER_Y, 6);
    expect(impact).not.toHaveBeenCalled();
    // Over land: no splash, the tracer and impact as before.
    const l = landPoint();
    sim.events.emit('shot', { shooter: null, weapon: 'smg', fx: l.x, fy: 3, fz: l.z, tx: l.x + 10, ty: 0, tz: l.z, hit: 'world', nx: 0, ny: 1, nz: 0, pellet: 0 });
    expect(splash).toHaveBeenCalledTimes(1);
    expect(tracer).toHaveBeenCalledTimes(2);
    expect(tracer.mock.calls[1]![4]).toBe(0);
    expect(impact).toHaveBeenCalledTimes(1);
  });

  it('seaCrossing: only from above to below the surface, and only over water', () => {
    const s = seaPoint();
    expect(seaCrossing(world(), s.x, 2, s.z, s.x, -5, s.z)).toEqual({ x: s.x, z: s.z });
    expect(seaCrossing(world(), s.x, 2, s.z, s.x + 5, 0, s.z)).toBeNull();
    expect(seaCrossing(world(), s.x, -2, s.z, s.x, -5, s.z)).toBeNull();
    const l = landPoint();
    // Down through y = WATER_Y under the street (a shot into the ground ends before it, but not this one).
    expect(seaCrossing(world(), l.x, 2, l.z, l.x, -5, l.z)).toBeNull();
  });

  it('a splash throws a droplet crown and mist and spreads a foam ring', () => {
    const r = renderer('high');
    const before = r.effects.particleCount;
    r.effects.splash(seaPoint().x, WATER_Y, seaPoint().z, 'small');
    r.effects.update(DT, 0);
    expect(r.effects.particleCount - before).toBeGreaterThanOrEqual(10);
    expect(r.effects.foam.active).toBe(1);
    // Gone after its 1.5 s.
    for (let i = 0; i < 100; i++) r.effects.update(DT, 0);
    expect(r.effects.foam.active).toBe(0);
  });

  it('a blast at the sea surface draws a water plume: no fire glow and no flash light', () => {
    const r = renderer('high');
    const sim = makeSim();
    r.attach(sim);
    const plume = vi.spyOn(r.effects, 'explosion');
    const s = seaPoint();
    sim.events.emit('explosion', { x: s.x, y: WATER_Y, z: s.z, radius: 6 });
    expect(plume.mock.calls[0]![4]).toBe(true);
    r.effects.update(DT, 0);
    expect(r.effects.glowCount).toBe(0);
    expect(r.effects.flash.intensity).toBe(0);
    expect(r.effects.foam.active).toBe(1);
    // On land, fire as ever.
    const l = landPoint();
    sim.events.emit('explosion', { x: l.x, y: 0.5, z: l.z, radius: 6 });
    expect(plume.mock.calls[1]![4]).toBe(false);
    r.effects.update(DT, 0);
    expect(r.effects.glowCount).toBeGreaterThan(0);
  });
});

describe('rockets and the sea', () => {
  function fire(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const sim = makeSim({ police: false });
    const explosions: SimEvents['explosion'][] = [];
    const splashes: SimEvents['splash'][] = [];
    sim.events.on('explosion', (e) => explosions.push(e));
    sim.events.on('splash', (e) => splashes.push(e));
    sim.projectiles.push(new Projectile(sim.newId(), { x, y, z }, { x: vx, y: vy, z: vz }, null));
    for (let i = 0; i < 240 && explosions.length === 0; i++) sim.update(DT, input());
    return { explosions, splashes };
  }

  it('a rocket fired down into the sea goes off at the surface where it crosses it, with a big splash', () => {
    const s = seaPoint();
    // 6 m up, falling 1 m for every 4 along: it meets the surface 24 m on.
    const { explosions, splashes } = fire(s.x, WATER_Y + 6, s.z, 58 * 0.97, -58 * 0.2425, 0);
    expect(explosions).toHaveLength(1);
    const e = explosions[0]!;
    expect(Math.abs(e.y - WATER_Y)).toBeLessThan(0.3);
    expect(e.x).toBeCloseTo(s.x + 24, 0);
    expect(e.z).toBeCloseTo(s.z, 6);
    expect(splashes.some((p) => p.big && p.y === WATER_Y && Math.abs(p.x - e.x) < 1e-6)).toBe(true);
  });

  it('over land a rocket still goes off on the ground, with no splash', () => {
    const l = landPoint();
    const { explosions, splashes } = fire(l.x, 6, l.z, 58 * 0.7071, -58 * 0.7071, 0);
    expect(explosions).toHaveLength(1);
    expect(explosions[0]!.y).toBeGreaterThan(-0.5);
    expect(splashes).toEqual([]);
  });
});

describe('the sim stays flat', () => {
  it('no sim or world module knows about the visual waves', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(__dirname, '../../src/sim'));
    walk(join(__dirname, '../../src/world'));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/render\/(waves|sea)/);
      if (!f.endsWith('weather.ts')) expect(src, f).not.toMatch(/seaState/);
    }
  });

  it('a swimmer floats at the same height in a storm sea as in a calm one', () => {
    const heights: number[][] = [];
    for (const storm of [false, true]) {
      const sim = makeSim({ police: false });
      if (storm) sim.weather.override('storm', 0);
      const s = seaPoint();
      const p = sim.player;
      p.pos.x = s.x;
      p.pos.z = s.z;
      p.pos.y = WATER_Y;
      const ys: number[] = [];
      for (let i = 0; i < 300; i++) {
        sim.update(DT, input());
        if (i > 120) ys.push(p.pos.y);
      }
      expect(sim.weather.state.seaState).toBeCloseTo(storm ? 1 : CALM_SEA, 1);
      heights.push(ys);
    }
    const [calm, storm] = heights;
    for (let i = 0; i < calm!.length; i++) expect(Math.abs(calm![i]! - storm![i]!)).toBeLessThan(0.01);
    expect(Math.max(...storm!) - Math.min(...storm!)).toBeLessThan(0.01);
  });
});
