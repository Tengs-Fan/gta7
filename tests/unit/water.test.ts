// Sea waves, shoreline and splashes: render/waves.ts, render/sea.ts, render/foamRings.ts, the renderer's sea wiring
// and the rockets that go off on the water (sim/combat.ts). Headless, with the stub header of rain.test.ts.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { QUALITY } from '../../src/render/quality';
import { GameRenderer, seaCrossing } from '../../src/render/renderer';
import { SHORE_GLSL, seaGrid, seaHeightAt, seaUniforms, seaWaveUniforms, setSeaFade, snapSea, surfPhases, updateSea } from '../../src/render/sea';
import { CALM_SEA, SEA_GRIDS, SEA_RINGS, SEA_SNAP, SEA_WAVES_GLSL, SKIRT_EXTENT, SWELL, WAVES, waveAmps, waveDisplacement, wavePhases, type SeaGridName, type SeaSurface } from '../../src/render/waves';
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

/** The open sea (no shelter map: unsheltered and deep) at time `t` and sea state `sea`, drawn with `grid`'s fades, the grid centred on the origin. */
function openSea(t: number, sea: number, grid: SeaGridName = 'fine'): SeaSurface {
  return { phases: wavePhases(t), surf: [0, 0, 0], sea, ox: 0, oz: 0, fadeStart: [...SEA_GRIDS[grid].fadeStart], fadeEnd: [...SEA_GRIDS[grid].fadeEnd], shelter: null };
}

describe('waves', () => {
  it('a swell of four waves 40 to 120 m long and four of chop on it, within 40 degrees of each other, none a multiple of another', () => {
    expect(WAVES).toHaveLength(8);
    for (const w of WAVES.slice(0, SWELL)) {
      expect(w.length).toBeGreaterThanOrEqual(40);
      expect(w.length).toBeLessThanOrEqual(120);
      expect(Math.abs(w.angle)).toBeLessThanOrEqual(21);
    }
    for (const w of WAVES.slice(SWELL)) expect(w.length).toBeLessThan(40);
    // No two running within 20 degrees of each other in a whole-number ratio (the longer would repeat the shorter's pattern).
    for (const a of WAVES) {
      for (const b of WAVES) {
        if (a === b || Math.abs(a.angle - b.angle) > 20) continue;
        const r = Math.max(a.length, b.length) / Math.min(a.length, b.length);
        expect(Math.abs(r - Math.round(r)), `${a.length} ${b.length}`).toBeGreaterThan(0.05);
      }
    }
  });

  it('the open sea\'s significant height (four standard deviations) is about 1.1 m on a calm day and 2.7 m in a storm', () => {
    const stats = (sea: number) => {
      let sum = 0;
      let sq = 0;
      let top = 0;
      let n = 0;
      for (let i = 0; i < 6000; i++) {
        const s = openSea(i * 0.371, sea);
        const y = waveDisplacement(s, (i % 71) * 7.3 - 250, Math.floor(i / 71) * 5.9 - 250)[1];
        sum += y;
        sq += y * y;
        top = Math.max(top, y);
        n++;
      }
      return { hs: 4 * Math.sqrt(sq / n - (sum / n) ** 2), top };
    };
    const calm = stats(CALM_SEA);
    const storm = stats(1);
    console.log(`[waves] significant height ${calm.hs.toFixed(2)} m on a calm day (highest crest seen ${calm.top.toFixed(2)} m), ${storm.hs.toFixed(2)} m in a storm (${storm.top.toFixed(2)} m)`);
    expect(calm.hs).toBeGreaterThan(0.9);
    expect(calm.hs).toBeLessThan(1.3);
    expect(storm.hs).toBeGreaterThan(2.3);
    expect(storm.hs).toBeLessThan(3);
    // No crest higher than every wave's height together.
    expect(storm.top).toBeLessThanOrEqual(waveAmps(1).reduce((a, b) => a + b, 0));
    // The swell is there on a still day; the chop is next to none.
    const still = waveAmps(0);
    expect(still[0]).toBeGreaterThan(0.1);
    expect(still[SWELL]).toBe(0);
  });

  it('the phases are wrapped in double precision and move smoothly frame to frame, even after hours', () => {
    for (const t0 of [0, 3600 * 5 + 0.37]) {
      const a = wavePhases(t0);
      const b = wavePhases(t0 + DT);
      for (let i = 0; i < WAVES.length; i++) {
        expect(a[i]!).toBeGreaterThanOrEqual(0);
        expect(a[i]!).toBeLessThan(Math.PI * 2);
        let d = Math.abs(b[i]! - a[i]!);
        d = Math.min(d, Math.PI * 2 - d);
        expect(d).toBeLessThan(0.1);
        expect(d).toBeGreaterThan(0);
      }
    }
  });

  it('displacement fades out before the grid coarsens past each wave and is gone at the skirt, on the fine grid and the coarse one', () => {
    expect(SEA_GRIDS.fine.fadeEnd).toEqual(WAVES.map((w) => w.fadeEnd));
    for (const name of ['fine', 'coarse'] as const) {
      const grid = SEA_GRIDS[name];
      const outer = grid.rings[grid.rings.length - 1]!;
      const cellAt = (c: number) => (grid.rings.find((r) => c <= r.extent) ?? outer).cell;
      for (let i = 0; i < WAVES.length; i++) {
        const w = WAVES[i]!;
        if (grid.fadeEnd[i]! > 0) {
          // Each wave is sampled by at least four vertices per wavelength where it displaces.
          expect(w.length / cellAt(grid.fadeEnd[i]!), `${name} ${w.length} m`).toBeGreaterThanOrEqual(4);
          expect(grid.fadeStart[i]!).toBeLessThan(grid.fadeEnd[i]!);
          expect(grid.fadeEnd[i]!).toBeLessThan(outer.extent);
        } else {
          // ...and a wave its finest cells could not sample does not displace at all.
          expect(w.length / grid.rings[0]!.cell, `${name} ${w.length} m`).toBeLessThan(4);
        }
      }
      const s = openSea(12.3, 1, name);
      for (let x = -outer.extent; x <= outer.extent; x += 37) {
        const d = waveDisplacement(s, x, outer.extent);
        expect(Math.hypot(...d), name).toBeLessThan(1e-9);
      }
    }
  });

  it('the coarse grid draws the swell and the two longest chop waves close in and none of the rest: the CPU twin follows the fades it is given', () => {
    const fine = openSea(7.7, 1, 'fine');
    const coarse = openSea(7.7, 1, 'coarse');
    // Near the centre every wave of the fine grid displaces, so the two surfaces differ by the dropped 9 and 4 m chop.
    const dropped = SEA_GRIDS.coarse.fadeEnd.filter((e) => e <= 0).length;
    expect(dropped).toBe(2);
    let differ = 0;
    for (let i = 0; i < 200; i++) {
      const x = (i % 20) * 1.9 - 18;
      const z = Math.floor(i / 20) * 2.3 - 11;
      if (Math.abs(waveDisplacement(fine, x, z)[1] - waveDisplacement(coarse, x, z)[1]) > 1e-3) differ++;
    }
    expect(differ).toBeGreaterThan(150);
    // Past the coarse grid's fades only the fine grid's long swell still displaces.
    let far = 0;
    for (let i = 0; i < 40; i++) far = Math.max(far, Math.abs(waveDisplacement(fine, 200 + i * 3.1, 30)[1]));
    expect(far).toBeGreaterThan(0.3);
    for (let i = 0; i < 40; i++) expect(waveDisplacement(coarse, 130 + i * 3.1, 30)[1]).toBeCloseTo(0, 9);
  });
});

describe.each(['fine', 'coarse'] as const)('the %s wave grid', (name) => {
  const spec = SEA_GRIDS[name];
  const rings = spec.rings;
  const outer = rings[rings.length - 1]!;
  const g = seaGrid(spec);
  const pos = g.getAttribute('position');
  const edge = g.getAttribute('aEdge');

  it('reaches the skirt, keeps every vertex on a whole-metre lattice, and faces up', () => {
    let far = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      far = Math.max(far, Math.abs(x), Math.abs(z));
      if (Math.max(Math.abs(x), Math.abs(z)) <= outer.extent) {
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

  it('marks exactly the rim vertices between the next ring\'s, which then sit on its edges (no cracks)', () => {
    const marked = new Map<number, number>();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const ex = edge.getX(i);
      const ez = edge.getY(i);
      if (ex || ez) {
        const next = ex || ez;
        const r = rings.findIndex((ring, k) => rings[k + 1]?.cell === next && Math.abs(ex ? z : x) === ring.extent);
        expect(r, `${x} ${z}`).toBeGreaterThanOrEqual(0);
        expect((ex ? x : z) % next).not.toBe(0);
        marked.set(r, (marked.get(r) ?? 0) + 1);
      }
    }
    // Per ring with one outside it: four sides of 2 extent / cell steps, all but those on the next ring's lattice.
    for (let r = 0; r < rings.length - 1; r++) {
      const { cell, extent } = rings[r]!;
      const next = rings[r + 1]!.cell;
      expect(marked.get(r), `ring ${r}`).toBe(4 * ((2 * extent) / cell - (2 * extent) / next));
    }
    // The grid moves in steps of its largest cell, and every ring's extent is a whole number of the next one's cells.
    expect(spec.snap).toBe(outer.cell);
    for (let r = 1; r < rings.length; r++) expect(rings[r - 1]!.extent % rings[r]!.cell).toBe(0);
    expect(g.getAttribute('uv')).toBeUndefined();
    expect(g.getAttribute('normal').normalized).toBe(true);
    // The shader's rim rule, on the CPU: the displaced rim point lies on the segment between the next ring's neighbours.
    const s = openSea(4.2, 1, name);
    const at = (x: number, z: number) => waveDisplacement(s, x, z);
    for (let r = 0; r < rings.length - 1; r++) {
      const { extent } = rings[r]!;
      const next = rings[r + 1]!.cell;
      for (const x of [-extent + 1, Math.round(-0.43 * extent), Math.round(0.13 * extent), extent - 2]) {
        const s0 = Math.floor(x / next) * next;
        const f = (x - s0) / next;
        const a = at(s0, extent);
        const b = at(s0 + next, extent);
        const morph = a.map((v, k) => v + (b[k]! - v) * f);
        // Only waves four of the next ring's cells long or more still displace at a rim, so even in a storm the morph moves
        // the point by little.
        expect(Math.abs(morph[1]! - at(x, extent)[1]), `ring ${r} x ${x}`).toBeLessThan(0.15);
      }
    }
    expect(SEA_WAVES_GLSL).toContain('seaDisplaceEdge');
  });

  it('holds the vertices its tier can shade', () => {
    // The fine grid doubles its cells ring by ring past the finest, in under 60,000 vertices; the coarse grid, which an
    // integrated GPU shades, in under 3,000.
    if (name === 'fine') {
      for (let r = 2; r < rings.length; r++) expect(rings[r]!.cell).toBe(rings[r - 1]!.cell * 2);
      expect(pos.count).toBeLessThan(60000);
    } else {
      expect(rings[0]!.cell).toBeGreaterThanOrEqual(SEA_RINGS[1]!.cell);
      expect(pos.count).toBeLessThan(3000);
    }
  });

});

describe('shoreline foam', () => {
  it('the quay pulse has no step when the surf phase wraps', () => {
    // The pulse is sin(quay phase); a frame apart it may move by at most the rate's own slope.
    const x0 = world().layout.bounds.beachStartX;
    const pulse = (t: number) => Math.sin(surfPhases(t, x0).quay);
    const rate = 1.2 * 1.4 / 60;
    let worst = 0;
    let wraps = 0;
    for (let t = 0; t < 120; t += 1 / 60) {
      if (surfPhases(t + 1 / 60, x0).surf[0]! < surfPhases(t, x0).surf[0]!) wraps++;
      worst = Math.max(worst, Math.abs(pulse(t + 1 / 60) - pulse(t)));
    }
    // The surf rolls in with the swell's period (7 s for its 72 m onshore wave).
    expect(wraps).toBeGreaterThan(15);
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
  it('High and Medium draw the displaced grid, Low the flat plane with wave normals, and software its own sea', () => {
    expect(QUALITY.high.waterGrid).toBe(true);
    expect(QUALITY.medium.waterGrid).toBe(true);
    expect(QUALITY.low.waterGrid).toBe(false);
    for (const q of ['high', 'medium'] as const) {
      const r = renderer(q);
      expect(r.stats().waterGrid, q).toBe(true);
      expect(r.env.sea.uDisplace.value).toBe(1);
      expect(r.env.water.geometry.getAttribute('aEdge')).toBeTruthy();
      // High's fine rings hold 58,500 vertices, Medium's coarse ones a twentieth of that, and the fades follow the grid.
      const grid = SEA_GRIDS[QUALITY[q].waterRings];
      expect(r.env.water.geometry.getAttribute('position').count, q).toBe(seaGrid(grid).getAttribute('position').count);
      expect(r.env.sea.uSeaFade.value.map((v) => v.toArray()).flat(), q).toEqual([...grid.fadeStart.slice(0, SWELL), ...grid.fadeEnd.slice(0, SWELL), ...grid.fadeStart.slice(SWELL), ...grid.fadeEnd.slice(SWELL)]);
    }
    expect(QUALITY.high.waterRings).toBe('fine');
    expect(QUALITY.medium.waterRings).toBe('coarse');
    expect(renderer('high').env.water.geometry.getAttribute('position').count).toBeGreaterThan(50000);
    expect(renderer('medium').env.water.geometry.getAttribute('position').count).toBeLessThan(3000);
    const low = renderer('low');
    expect(low.stats().waterGrid).toBe(false);
    expect(low.env.sea.uDisplace.value).toBe(0);
    expect(low.env.water.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    const sw = renderer('high', SOFTWARE);
    expect(sw.stats().waterGrid).toBe(false);
    const mat = sw.env.water.material as THREE.ShaderMaterial;
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    const main = mat.fragmentShader.slice(mat.fragmentShader.indexOf('void main()'));
    expect(main).toContain('seaSlope2(');
    expect(main).not.toMatch(/seaSlope\(/);
    expect(mat.fragmentShader).toContain('seaShallows');
  });

  it('a tier switch swaps the geometry and a uniform only: the same material and program key, the grid freed on going to Low', () => {
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
    // Medium swaps in its own coarse grid and fades, frees High's buffers, and High's come back with its fades.
    const fine = vi.spyOn(grid, 'dispose');
    r.setQuality('medium');
    const coarse = r.env.water.geometry;
    expect(coarse).not.toBe(grid);
    expect(fine).toHaveBeenCalled();
    expect(r.stats().waterGrid).toBe(true);
    expect(r.env.sea.uSeaFade.value[1]!.toArray()).toEqual(SEA_GRIDS.coarse.fadeEnd.slice(0, SWELL));
    expect(r.env.water.material).toBe(mat);
    expect(mat.customProgramCacheKey()).toBe(key);
    r.setQuality('low');
    expect(r.env.sea.uSeaFade.value[1]!.toArray()).toEqual(SEA_GRIDS.fine.fadeEnd.slice(0, SWELL));
    r.setQuality('high');
    expect(r.env.water.geometry).toBe(grid);
    expect(r.env.sea.uSeaFade.value[1]!.toArray()).toEqual(SEA_GRIDS.fine.fadeEnd.slice(0, SWELL));
  });

  it('what rides the sea follows the grid drawn: on Medium nothing the coarse rings cannot sample displaces, so a boat, a swimmer or a splash sits where the water is drawn', () => {
    const fine = seaWaveUniforms();
    const coarse = seaWaveUniforms();
    for (const u of [fine, coarse]) {
      u.uDisplace.value = 1;
      u.uSeaAmp.value = 1;
      u.uWavePhase.value.set(1.1, 2.2, 3.3, 4.4);
      u.uChopPhase.value.set(0.5, 1.5, 2.5, 3.5);
    }
    setSeaFade(coarse, SEA_GRIDS.coarse);
    // The same sea 20 m from the grid's centre: the coarse grid lacks only its dropped chop...
    const near = Math.abs(seaHeightAt(fine, 20, 7) - seaHeightAt(coarse, 20, 7));
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(0.3);
    // ...and 200 m out nothing at all is drawn on it, where the fine grid still shows the long swell.
    let top = 0;
    for (let x = 200; x < 300; x += 7) {
      expect(seaHeightAt(coarse, x, 7)).toBeCloseTo(0, 9);
      top = Math.max(top, Math.abs(seaHeightAt(fine, x, 7)));
    }
    expect(top).toBeGreaterThan(0.3);
    // A flat sea (Low) draws no waves whatever the fades.
    coarse.uDisplace.value = 0;
    expect(seaHeightAt(coarse, 20, 7)).toBe(0);
  });

  it('the sea material declares the waves, shoreline and foam in its patch', () => {
    const r = renderer('medium');
    const mat = r.env.water.material as THREE.MeshStandardMaterial;
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, r.renderer);
    expect(shader.vertexShader).toContain('seaDisplaceEdge( seaBase.xz, aEdge )');
    expect(shader.fragmentShader).toContain('seaWave( vSeaXZ');
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
    expect(r.env.water.position.x % SEA_SNAP).toBe(0);
    expect(r.env.water.position.z % SEA_SNAP).toBe(0);
    expect(Math.abs(r.env.water.position.x - cam.x)).toBeLessThanOrEqual(SEA_SNAP / 2);
    expect(r.env.water.position.y).toBe(WATER_Y);
    // Medium's coarse grid moves in whole steps of its own largest cell.
    const m = renderer('medium');
    m.attach(makeSim());
    m.render(DT, false);
    const step = SEA_GRIDS.coarse.snap;
    expect(step).toBeLessThan(SEA_SNAP);
    expect(m.env.water.position.x % step).toBe(0);
    expect(m.env.water.position.x).toBe(snapSea(m.cameraCtl.camera.position.x, step));
    expect(Math.abs(m.env.water.position.z - m.cameraCtl.camera.position.z)).toBeLessThanOrEqual(step / 2);
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
  it('a round fired into the sea splashes once where it crosses the surface, on the drawn swell, and its tracer ends there', () => {
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
    // The sim's sea is flat; the splash goes up on the drawn one.
    const sea = WATER_Y + seaHeightAt(r.env.sea, x, s.z);
    expect(Math.abs(sea - WATER_Y)).toBeGreaterThan(0.01);
    expect(y).toBeCloseTo(sea, 6);
    expect(z).toBeCloseTo(s.z, 6);
    expect(size).toBe('small');
    expect(tracer).toHaveBeenCalledTimes(1);
    expect(tracer.mock.calls[0]![4]).toBeCloseTo(sea, 6);
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
