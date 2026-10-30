// Night lights: vehicle lamp glows, headlight pools on the road, wet-road streaks (render/lightSprites.ts), and street
// lamps with a luminaire head whose every part goes when the lamp is knocked down. Headless, with the stub header of
// r2_vehicles.test.ts: a tiny canvas/document stub and a fake WebGLRenderer.

import * as THREE from 'three';
import type { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GLOW, glowLuminance, LightSprites, type GlowKind, type LampGlow } from '../../src/render/lightSprites';
import { LAMP_HEAD, PropsView } from '../../src/render/props';
import { QUALITY } from '../../src/render/quality';
import { GameRenderer } from '../../src/render/renderer';
import { StreetLighting } from '../../src/render/streetLighting';
import { VehicleView } from '../../src/render/vehicleView';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
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
    getRenderTarget(): unknown {
      return null;
    }
    setRenderTarget(): void {}
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
const HDR = { renderer: '', halfFloat: true };
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

function glowsOf(view: VehicleView): LampGlow[] {
  const out: LampGlow[] = [];
  const n = view.lampWorldPositions(out);
  return out.slice(0, n);
}

function kinds(view: VehicleView): Partial<Record<GlowKind, number>> {
  const c: Partial<Record<GlowKind, number>> = {};
  for (const g of glowsOf(view)) c[g.kind] = (c[g.kind] ?? 0) + 1;
  return c;
}

function driven(sim: Sim, kind: Vehicle['kind'] = 'sedan'): { v: Vehicle; view: VehicleView } {
  const p = spot(sim);
  const v = sim.spawnVehicle(kind, p.x, p.z, 0);
  placeInCar(sim, v);
  const view = new VehicleView(kind);
  view.bind(v);
  return { v, view };
}

describe('lamp glows', () => {
  it('every glow stays under the bloom threshold, and the brake glow is at least 1.5 times the running one', () => {
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    const threshold = (r as unknown as { bloom: UnrealBloomPass }).bloom.threshold;
    expect(threshold).toBe(2.6);
    for (const k of Object.keys(GLOW) as GlowKind[]) {
      expect(glowLuminance(k), k).toBeLessThan(threshold);
      expect(glowLuminance(k), k).toBeGreaterThan(0.1);
    }
    expect(glowLuminance('brake')).toBeGreaterThanOrEqual(1.5 * glowLuminance('tail'));
    // Reverse lamps are white, tail and brake lamps red.
    const [rr, rg, rb] = GLOW.reverse.color;
    expect(Math.min(rr, rg, rb) / Math.max(rr, rg, rb)).toBeGreaterThan(0.9);
    for (const k of ['tail', 'brake'] as const) expect(GLOW[k].color[0]).toBeGreaterThan(10 * GLOW[k].color[1]);
    r.dispose();
  });

  it('at night: head and tail glows, brake glows while braking, reverse glows while reversing; by day only brake and reverse', () => {
    const sim = makeSim({ world: W });
    const { v, view } = driven(sim);
    view.sync(v, DT, 0, 1);
    expect(kinds(view)).toEqual({ head: 2, tail: 2 });
    v.braking = true;
    view.sync(v, DT, 0, 1);
    expect(kinds(view)).toEqual({ head: 2, brake: 2 });
    v.braking = false;
    v.reversing = true;
    view.sync(v, DT, 0, 1);
    expect(kinds(view)).toEqual({ head: 2, tail: 2, reverse: 1 });
    v.reversing = false;
    view.sync(v, DT, 0, 0);
    expect(kinds(view)).toEqual({});
    v.braking = true;
    view.sync(v, DT, 0, 0);
    expect(kinds(view)).toEqual({ brake: 2 });
  });

  it('glows sit on their lamps in world space and face the way the lamp shines', () => {
    const sim = makeSim({ world: W });
    const { v, view } = driven(sim);
    v.heading = 0.7;
    view.sync(v, DT, 0, 1);
    view.group.updateMatrixWorld(true);
    const lamps = view.group.children.filter((o) => o.name === 'lamp');
    for (const g of glowsOf(view)) {
      const near = lamps.some((l) => l.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(g.x, g.y, g.z)) < 1e-4);
      expect(near, g.kind).toBe(true);
      const sign = g.kind === 'head' ? 1 : -1;
      expect(g.fx).toBeCloseTo(sign * Math.sin(0.7), 3);
      expect(g.fz).toBeCloseTo(sign * Math.cos(0.7), 3);
    }
  });

  it('a smashed lamp loses its glow (through the dent path) and a wreck has none', () => {
    const sim = makeSim({ world: W });
    const { v, view } = driven(sim);
    v.braking = true;
    view.sync(v, DT, 0, 1);
    expect(kinds(view).brake).toBe(2);
    // Rear left corner (local +X is the left side): smashes that tail lamp only.
    v.dents.push({ lx: v.halfW, ly: 0.5 * v.spec.height, lz: -v.halfL, nx: -0.6, nz: 0.8, depth: 0.2 });
    v.dentVersion++;
    view.sync(v, DT, 0, 1);
    expect(kinds(view).brake).toBe(1);
    expect(kinds(view).head).toBe(2);
    v.dents.push({ lx: -v.halfW, ly: 0.5 * v.spec.height, lz: -v.halfL, nx: 0.6, nz: 0.8, depth: 0.2 });
    v.dentVersion++;
    view.sync(v, DT, 0, 1);
    expect(kinds(view).brake ?? 0).toBe(0);
    v.destroyed = true;
    view.sync(v, DT, 0, 1);
    expect(glowsOf(view).length).toBe(0);
  });

  it('a police car with its siren on shows one light-bar glow, alternating red and blue', () => {
    const sim = makeSim({ world: W });
    const { v, view } = driven(sim, 'police');
    v.siren = true;
    view.sync(v, DT, 0.05, 1);
    expect(kinds(view).sirenRed).toBe(1);
    view.sync(v, DT, 0.22, 1);
    expect(kinds(view).sirenBlue).toBe(1);
    v.siren = false;
    view.sync(v, DT, 0.05, 1);
    expect(kinds(view).sirenRed ?? 0).toBe(0);
  });

  it('LightSprites dims a glow turned away from the camera and drops one beyond its range', () => {
    const ls = new LightSprites();
    ls.begin(new THREE.Vector3(0, 1, 10), 800);
    expect(ls.addGlow({ kind: 'head', x: 0, y: 1, z: 0, fx: 0, fz: 1 })).toBe(true);
    expect(ls.addGlow({ kind: 'head', x: 0, y: 1, z: 0, fx: 0, fz: -1 })).toBe(false);
    expect(ls.addGlow({ kind: 'sirenRed', x: 0, y: 1, z: 0, fx: 0, fz: 0 })).toBe(true);
    expect(ls.addGlow({ kind: 'tail', x: 500, y: 1, z: 0, fx: 0, fz: 0 })).toBe(false);
    ls.finish(() => 0);
    expect(ls.counts.glows).toBe(2);
    expect(ls.glows.geometry.drawRange.count).toBe(2);
    ls.dispose();
  });
});

describe('headlight pools', () => {
  it('keeps the nearest pools first, up to the cap', () => {
    const ls = new LightSprites();
    ls.setPoolCap(QUALITY.high.headlightPools);
    ls.begin(new THREE.Vector3(0, 2, 0), 800);
    // 60 cars at shuffled distances 1..60 m.
    const ds = Array.from({ length: 60 }, (_, i) => ((i * 37) % 60) + 1);
    for (const d of ds) ls.offerPool(d, 0, 0, 1);
    ls.finish(() => 0);
    expect(ls.counts.pools).toBe(40);
    expect(ls.pools.count).toBe(40);
    const xs: number[] = [];
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < 40; i++) {
      ls.pools.getMatrixAt(i, m);
      xs.push(Math.round(p.setFromMatrixPosition(m).x));
    }
    expect(xs.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    ls.dispose();
  });

  it('per tier at night: within High 40 / Medium 24 / Low 12, and none at noon', () => {
    expect([QUALITY.high.headlightPools, QUALITY.medium.headlightPools, QUALITY.low.headlightPools]).toEqual([40, 24, 12]);
    const sim = makeSim({ world: W });
    const p = spot(sim);
    for (let i = 0; i < 50; i++) {
      const v = sim.spawnVehicle('sedan', p.x + (i % 5) * 4, p.z + Math.floor(i / 5) * 7, 0);
      if (i === 0) placeInCar(sim, v);
      else sim.seat(sim.spawnCharacter('civilian', v.pos.x, v.pos.z), v, 0);
    }
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    r.cameraCtl.reset(sim);
    const frame = (): ReturnType<GameRenderer['stats']> => {
      r.render(0, false);
      return r.stats();
    };
    sim.clock.set(23);
    for (const q of ['high', 'medium', 'low'] as const) {
      r.setQuality(q);
      const s = frame();
      expect(s.pools, q).toBe(QUALITY[q].headlightPools);
      expect(s.glows, q).toBeGreaterThanOrEqual(90);
    }
    const night = frame().glows;
    sim.clock.set(12);
    const noon = frame();
    expect(noon.pools).toBe(0);
    expect(noon.glows).toBeLessThan(night);
    r.dispose();
  });

  it("on Low the player's own car lights the road; on High its headlight spot does instead", () => {
    const sim = makeSim({ world: W });
    sim.clock.set(23);
    const { v } = driven(sim);
    const p = sim.player;
    for (const u of sim.vehicles) if (u !== v && Math.hypot(u.pos.x - v.pos.x, u.pos.z - v.pos.z) < 200) sim.removeVehicle(u);
    expect(p.vehicle).toBe(v);
    const r = new GameRenderer(canvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    r.cameraCtl.reset(sim);
    r.render(0, false);
    expect(r.stats().pools).toBeGreaterThanOrEqual(1);
    const ls = r.lightSprites;
    const m = new THREE.Matrix4();
    ls.pools.getMatrixAt(0, m);
    const at = new THREE.Vector3().setFromMatrixPosition(m);
    // Laid ahead of the bumper, on the road.
    const ahead = (at.x - v.pos.x) * Math.sin(v.heading) + (at.z - v.pos.z) * Math.cos(v.heading);
    expect(ahead).toBeGreaterThan(v.halfL);
    expect(at.y - sim.world.groundHeight(at.x, at.z)).toBeLessThan(0.15);
    r.setQuality('high');
    r.render(0, false);
    expect(r.stats().pools).toBe(0);
    r.dispose();
  });

  it('dark weather turns lights on by day, and clear weather turns them off again', () => {
    const sim = makeSim({ world: W });
    sim.clock.set(13);
    driven(sim);
    const r = new GameRenderer(canvas(), W, { quality: 'low', fov: 68, gpu: HDR });
    r.attach(sim);
    r.cameraCtl.mode = 'play';
    r.cameraCtl.reset(sim);
    const frame = () => {
      sim.update(DT, input());
      r.render(DT, false);
      return r.stats();
    };
    const clear = frame();
    expect(clear.pools).toBe(0);
    for (const kind of ['rain', 'storm'] as const) {
      sim.weather.override(kind, 0);
      const dark = frame();
      expect(sim.weather.state.dim).toBeGreaterThanOrEqual(0.5);
      expect(r.weatherDim).toBe(sim.weather.state.dim);
      expect(dark.pools, kind).toBeGreaterThan(0);
      expect(dark.glows, kind).toBeGreaterThan(clear.glows);
    }
    sim.weather.override('cloudy', 0);
    expect(frame().pools).toBe(0);
    sim.weather.override(null, 0);
    expect(frame().pools).toBe(0);
    r.dispose();
  });
});

describe('wet-road streaks', () => {
  it('are drawn only on a wet road', () => {
    const ls = new LightSprites();
    const cam = new THREE.Vector3(0, 2, 15);
    const run = (): number => {
      ls.begin(cam, 800);
      ls.addGlow({ kind: 'tail', x: 0, y: 0.8, z: 0, fx: 0, fz: 1 });
      ls.addGlow({ kind: 'tail', x: 1.2, y: 0.8, z: 0, fx: 0, fz: 1 });
      ls.finish(() => 0);
      return ls.counts.streaks;
    };
    expect(run()).toBe(0);
    ls.wet = 1;
    expect(run()).toBe(2);
    ls.dispose();
  });
});

describe('street lamp luminaires', () => {
  function lampParts(props: PropsView): Map<string, THREE.InstancedMesh[]> {
    const parts = new Map<string, THREE.InstancedMesh[]>();
    props.group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh) || !o.geometry.name.startsWith('lamp-')) return;
      const l = parts.get(o.geometry.name) ?? [];
      l.push(o);
      parts.set(o.geometry.name, l);
    });
    return parts;
  }

  it('pole (with plinth and arm), head and lens: one instance each per lamp, the head a housing longer than wide', () => {
    const lamps = W.layout.props.filter((p) => p.kind === 'lamp').length;
    const props = new PropsView(W);
    const parts = lampParts(props);
    expect([...parts.keys()].sort()).toEqual(['lamp-head', 'lamp-lens', 'lamp-pole']);
    for (const [name, meshes] of parts) expect(meshes.reduce((n, m) => n + m.count, 0), name).toBe(lamps);
    const head = parts.get('lamp-head')![0]!.geometry;
    head.computeBoundingBox();
    const size = head.boundingBox!.getSize(new THREE.Vector3());
    expect(size.z).toBeGreaterThan(0.5);
    expect(size.z).toBeLessThan(1);
    expect(size.z).toBeGreaterThan(1.8 * size.x);
    // The lens's underside is the shared head point, under the middle of the housing.
    const lens = parts.get('lamp-lens')![0]!.geometry;
    lens.computeBoundingBox();
    expect(lens.boundingBox!.min.y).toBeCloseTo(LAMP_HEAD.y, 6);
    expect((lens.boundingBox!.min.z + lens.boundingBox!.max.z) / 2).toBeCloseTo(LAMP_HEAD.reach, 6);
    expect((head.boundingBox!.min.z + head.boundingBox!.max.z) / 2).toBeCloseTo(LAMP_HEAD.reach, 6);
    // Light metal that reads by day.
    const mat = parts.get('lamp-pole')![0]!.material as THREE.MeshStandardMaterial;
    expect(mat.color.getHSL({ h: 0, s: 0, l: 0 }).l).toBeGreaterThan(0.25);
  });

  it('halo, light pool and street-light spot all sit straight under the head', () => {
    const props = new PropsView(W);
    const idx = W.layout.props.findIndex((p) => p.kind === 'lamp');
    const p = W.layout.props[idx]!;
    const hx = p.x + Math.sin(p.rot) * LAMP_HEAD.reach * p.scale;
    const hz = p.z + Math.cos(p.rot) * LAMP_HEAD.reach * p.scale;
    const halos = props.group.getObjectByName('lampHalos') as THREE.Points;
    const pos = halos.geometry.getAttribute('position');
    let k = 0;
    while (Math.hypot(pos.getX(k) - hx, pos.getZ(k) - hz) > 1e-3 && k < pos.count) k++;
    expect(k).toBeLessThan(pos.count);
    expect(LAMP_HEAD.y * p.scale + p.y - pos.getY(k)).toBeGreaterThan(0);
    expect(LAMP_HEAD.y * p.scale + p.y - pos.getY(k)).toBeLessThan(0.15);
    // The pool under it.
    let found = false;
    const m = new THREE.Matrix4();
    const at = new THREE.Vector3();
    props.group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh) || !(o.material instanceof THREE.MeshBasicMaterial) || !o.material.map) return;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        at.setFromMatrixPosition(m);
        if (Math.hypot(at.x - hx, at.z - hz) < 1e-4) found = true;
      }
    });
    expect(found, 'a light pool centred under the head').toBe(true);
    const lighting = new StreetLighting(W);
    const cam = new THREE.Vector3(p.x, p.y + 2, p.z);
    for (let i = 0; i < 8; i++) lighting.update(cam, 1, 0.1);
    const spots = lighting.group.children.filter((c): c is THREE.SpotLight => c instanceof THREE.SpotLight);
    const s = spots.find((l) => Math.hypot(l.position.x - hx, l.position.z - hz) < 1e-6);
    expect(s).toBeDefined();
    expect(s!.position.y).toBeLessThan(p.y + LAMP_HEAD.y * p.scale);
    expect(s!.position.y).toBeGreaterThan(p.y + (LAMP_HEAD.y - 0.15) * p.scale);
  });

  it('breakProp zeroes every part of a lamp, its halo too, and leaves its neighbours alone', () => {
    const props = new PropsView(W);
    const lamps = W.layout.props.flatMap((p, i) => (p.kind === 'lamp' ? [i] : []));
    const target = lamps[3]!;
    const neighbour = lamps[4]!;
    const refs = (props as unknown as { refs: Map<number, Array<{ mesh: THREE.InstancedMesh; index: number }>> }).refs;
    // Pole, head, lens and light pool.
    expect(refs.get(target)!.length).toBe(4);
    props.breakProp(target, 1, 0);
    const m = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const zero = (pi: number) => refs.get(pi)!.every((r) => {
      r.mesh.getMatrixAt(r.index, m);
      return scale.setFromMatrixScale(m).length() === 0;
    });
    expect(zero(target)).toBe(true);
    expect(refs.get(neighbour)!.some((r) => {
      r.mesh.getMatrixAt(r.index, m);
      return scale.setFromMatrixScale(m).length() > 0;
    })).toBe(true);
    const halos = props.group.getObjectByName('lampHalos') as THREE.Points;
    const c = halos.geometry.getAttribute('color');
    const hi = (props as unknown as { lampHaloIndex: Map<number, number> }).lampHaloIndex.get(target)!;
    expect(c.getX(hi) + c.getY(hi) + c.getZ(hi)).toBe(0);
    props.restoreAll();
    expect(zero(target)).toBe(false);
  });
});
