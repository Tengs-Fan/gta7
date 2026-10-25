// Wave-1 render fixes: the merged-car shadow hook survives a WebGL context restore (three replaces its shadowMap),
// part batches drop the buckets of disposed transient materials, fading cars keep their parts in the shared batches
// (within the fade draw budget), and a falling helicopter stops on garage roofs at the longest frame the game allows.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GameRenderer } from '../../src/render/renderer';
import { SHADOW_LAYER, VehiclePartBatches } from '../../src/render/vehicleBatches';
import { VehicleView } from '../../src/render/vehicleView';
import { Helicopter, type Vehicle } from '../../src/sim/entities';
import { HELI_BOTTOM, heliCrashHit } from '../../src/sim/heliCrash';
import type { Sim } from '../../src/sim/sim';
import { GARAGE_ROOF, type StaticWorld } from '../../src/world/staticWorld';
import { makeSim, step, world } from './helpers';

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

/** three's WebGLShadowMap as far as GameRenderer touches it: flags and render(). */
interface FakeShadowMap {
  enabled: boolean;
  type: number;
  autoUpdate: boolean;
  needsUpdate: boolean;
  render: (lights: unknown, scene: unknown, camera: THREE.Camera) => void;
}

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    readonly domElement: unknown;
    readonly info = { autoReset: true, reset: () => {}, render: { calls: 0, triangles: 0 }, programs: [] as unknown[], memory: { geometries: 0, textures: 0 } };
    shadowMap: FakeShadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false, render: () => {} };
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
    compile(): void {}
    render(): void {}
    setRenderTarget(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const DT = 1 / 60;
const canvas = (): HTMLCanvasElement => document.createElement('canvas') as unknown as HTMLCanvasElement;
const fakeOf = (r: GameRenderer): { shadowMap: FakeShadowMap } => r.renderer as unknown as { shadowMap: FakeShadowMap };
const handlers = (r: GameRenderer) => r as unknown as { onContextLost: () => void; onContextRestored: () => void };

let W: StaticWorld;
beforeAll(() => {
  W = world();
});

describe('merged car shadows after a WebGL context restore', () => {
  /** Records whether the shadow-only layer was on for the main camera while three drew the shadow map. */
  function replacementShadowMap(old: FakeShadowMap): { map: FakeShadowMap; seen: boolean[] } {
    const seen: boolean[] = [];
    const map: FakeShadowMap = { enabled: old.enabled, type: old.type, autoUpdate: old.autoUpdate, needsUpdate: old.needsUpdate, render: (_l, _s, camera) => { seen.push(camera.layers.isEnabled(SHADOW_LAYER)); } };
    return { map, seen };
  }

  it('the shadow pass sees the shadow-only casters again once three has replaced its shadow map', () => {
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: true } });
    const fake = fakeOf(r);
    const cam = r.cameraCtl.camera;
    // Before any loss: the hook is in place.
    const first = replacementShadowMap(fake.shadowMap);
    fake.shadowMap = first.map;
    r.renderer.shadowMap.render([], r.scene, cam);
    expect(first.seen).toEqual([false]);
    // three's restore handler (it runs before ours) builds a new WebGLShadowMap and copies only its flags.
    for (let round = 0; round < 3; round++) {
      handlers(r).onContextLost();
      const { map, seen } = replacementShadowMap(fake.shadowMap);
      fake.shadowMap = map;
      handlers(r).onContextRestored();
      r.renderer.shadowMap.render([], r.scene, cam);
      expect(seen, `round ${round}`).toEqual([true]);
      expect(cam.layers.isEnabled(SHADOW_LAYER), `round ${round}`).toBe(false);
      // Restoring again without a new map does not wrap the hook twice: three's render still runs once per pass.
      handlers(r).onContextLost();
      handlers(r).onContextRestored();
      r.renderer.shadowMap.render([], r.scene, cam);
      expect(seen, `round ${round}`).toEqual([true, true]);
    }
    r.dispose();
  });

  it('is also reinstalled by the next frame when the map is replaced without a restore event', () => {
    const r = new GameRenderer(canvas(), W, { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: true } });
    const fake = fakeOf(r);
    const { map, seen } = replacementShadowMap(fake.shadowMap);
    fake.shadowMap = map;
    r.render(DT, false);
    r.renderer.shadowMap.render([], r.scene, r.cameraCtl.camera);
    expect(seen).toEqual([true]);
    r.dispose();
  });
});

describe('part batches with transient materials', () => {
  it('retire the buckets of disposed materials and free their instanced meshes, without dropping the frame they were drawn in', () => {
    const batches = new VehiclePartBatches();
    const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12);
    const shared = new THREE.MeshStandardMaterial({ color: 0xc4c6c8, metalness: 0.9 });
    const m = new THREE.Matrix4();
    batches.begin();
    batches.add(geo, shared, m);
    batches.end();
    batches.begin();
    batches.end();
    const base = { buckets: batches.counts.buckets, children: batches.group.children.length };
    const disposedMeshes = new Set<THREE.Object3D>();
    let bytes0 = 0;
    for (let cycle = 0; cycle < 8; cycle++) {
      // The player's rims with local reflections: four clones of the shared finish, replaced on every change.
      const clones = [0, 1, 2, 3].map(() => {
        const c = shared.clone();
        c.envMap = new THREE.Texture();
        return c;
      });
      batches.begin();
      batches.add(geo, shared, m);
      for (const c of clones) batches.add(geo, c, m);
      batches.end();
      const drawn = [...batches.group.children] as THREE.InstancedMesh[];
      const live = drawn.filter((x) => x.visible && x.count > 0);
      const drawnMaterialDisposed: THREE.Material[] = [];
      for (const mesh of drawn) mesh.addEventListener('dispose', () => disposedMeshes.add(mesh));
      for (const x of live) (x.material as THREE.Material).addEventListener('dispose', (e) => drawnMaterialDisposed.push(e.target as THREE.Material));
      // Disposed after the parts were added but before the frame is drawn: those instances still draw, with live materials.
      for (const c of clones) c.dispose();
      expect(batches.counts.instances, `cycle ${cycle}`).toBe(5);
      expect(live.reduce((n, x) => n + x.count, 0), `cycle ${cycle}`).toBe(5);
      expect(live.every((x) => batches.group.children.includes(x)), `cycle ${cycle}`).toBe(true);
      expect(drawnMaterialDisposed, `cycle ${cycle}`).toEqual([]);
      // The next frame no longer holds them, and every mesh that left was disposed.
      batches.begin();
      batches.add(geo, shared, m);
      batches.end();
      expect(batches.counts.buckets, `cycle ${cycle}`).toBe(base.buckets);
      expect(batches.group.children.length, `cycle ${cycle}`).toBe(base.children);
      const gone = drawn.filter((x) => !batches.group.children.includes(x));
      expect(gone.length, `cycle ${cycle}`).toBe(4);
      for (const x of gone) expect(disposedMeshes.has(x), `cycle ${cycle}`).toBe(true);
      let bytes = 0;
      for (const x of batches.group.children as THREE.InstancedMesh[]) bytes += x.instanceMatrix.array.byteLength;
      if (cycle === 0) bytes0 = bytes;
      expect(bytes, `cycle ${cycle}`).toBe(bytes0);
    }
    // A disposed shared material that is used again simply gets a new bucket.
    shared.dispose();
    batches.begin();
    batches.add(geo, shared, m);
    batches.end();
    expect(batches.counts).toMatchObject({ buckets: base.buckets, instances: 1 });
    batches.dispose();
    expect(batches.group.children.length).toBe(0);
  });

  it('keep the buckets of shared materials across empty frames, so no draw is rebuilt while cars come and go', () => {
    const batches = new VehiclePartBatches();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    batches.begin();
    batches.add(geo, mat, new THREE.Matrix4());
    batches.end();
    const mesh = batches.group.children.find((x) => (x as THREE.InstancedMesh).count > 0);
    expect(mesh).toBeDefined();
    batches.takeChanged();
    for (let i = 0; i < 600; i++) {
      batches.begin();
      batches.end();
    }
    batches.begin();
    batches.add(geo, mat, new THREE.Matrix4());
    batches.end();
    expect(batches.takeChanged()).toBe(false);
    expect(batches.group.children).toContain(mesh);
    batches.dispose();
  });
});

describe('fading cars stay in the part batches', () => {
  const CAMERA = new THREE.Layers();

  /** Draws of one frame, structurally: meshes the main camera draws plus shadow casters, each instanced draw once. */
  function draws(root: THREE.Object3D): number {
    let n = 0;
    root.traverseVisible((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (o instanceof THREE.InstancedMesh && o.count === 0) return;
      const main = o.layers.test(CAMERA);
      if (main) n++;
      if (o.castShadow && (main || o.layers.isEnabled(SHADOW_LAYER))) n++;
    });
    return n;
  }

  let R: GameRenderer;
  beforeAll(() => {
    R = new GameRenderer(canvas(), W, { quality: 'high', fov: 68 });
  });
  const views = (): Map<number, VehicleView> => (R as unknown as { vehicleViews: Map<number, VehicleView> }).vehicleViews;
  const fading = (): Array<{ view: VehicleView }> => (R as unknown as { fadingViews: Array<{ view: VehicleView }> }).fadingViews;

  function ahead(sim: Sim, d: number, side = 0): Vehicle {
    const cam = R.cameraCtl.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const l = Math.hypot(dir.x, dir.z) || 1;
    const fx = dir.x / l;
    const fz = dir.z / l;
    return sim.spawnVehicle('sedan', cam.position.x + fx * d - fz * side, cam.position.z + fz * d + fx * side, 0);
  }

  for (const [label, d, burnt] of [['a nearby intact car', 18, false], ['a nearby wreck', 18, true], ['a far intact car', 80, false], ['a far wreck', 80, true]] as const) {
    it(`${label} adds at most two draws while it fades, and its parts fade inside the shared batches`, () => {
      const sim = makeSim({ world: W });
      R.attach(sim);
      R.cameraCtl.mode = 'play';
      R.cameraCtl.reset(sim);
      R.render(DT, false);
      // Live cars of the same kind keep the shared buckets in use.
      for (const s of [-6, 6]) ahead(sim, d + 4, s);
      const target = ahead(sim, d);
      if (burnt) {
        target.destroyed = true;
        target.wreckTime = 60;
      }
      step(sim, DT);
      R.render(DT, false);
      R.render(DT, false);
      const view = views().get(target.id)!;
      expect(view).toBeDefined();
      const far = view.isDistant;
      expect(far).toBe(d > 40);
      const live = draws(R.scene);
      const instances = R.vehicleParts.counts.instances;
      sim.removeVehicle(target);
      R.render(DT, false);
      expect(fading().some((e) => e.view === view)).toBe(true);
      // The far version stays far: switching back to the detailed one would add its own draws.
      expect(view.isDistant).toBe(far);
      for (let i = 0; i < 6; i++) {
        R.render(DT, false);
        expect(draws(R.scene) - live, `frame ${i}`).toBeLessThanOrEqual(2);
        expect(R.vehicleParts.counts.instances, `frame ${i}`).toBe(instances);
      }
      // The fading car's instances carry its fade; the live cars' are whole.
      const fades: number[] = [];
      for (const m of R.vehicleParts.group.children as THREE.InstancedMesh[]) {
        const a = m.geometry.getAttribute('instanceFade');
        expect(a, m.name).toBeDefined();
        for (let i = 0; i < m.count; i++) fades.push(a.getX(i));
      }
      expect(fades.some((f) => f > 0 && f < 1)).toBe(true);
      expect(fades.filter((f) => f === 1).length).toBeGreaterThan(0);
      while (fading().some((e) => e.view === view)) R.render(DT, false);
      R.render(DT, false);
      expect(R.vehicleParts.counts.instances).toBeLessThan(instances);
      for (const v of [...sim.vehicles]) sim.removeVehicle(v);
    });
  }

  it('every bucket fades its instances with the per-instance dither, its shadow too, on the program it already has', () => {
    const batches = new VehiclePartBatches();
    const sim = makeSim();
    const v = sim.spawnVehicle('police', 0, 0, 0);
    const view = new VehicleView('police');
    view.bind(v);
    view.sync(v, DT, 0, 0.8);
    view.setDistant(true);
    batches.begin();
    view.drawParts(batches);
    view.setDistant(false);
    view.drawParts(batches);
    batches.end();
    const meshes = (batches.group.children as THREE.InstancedMesh[]).filter((m) => m.count > 0);
    expect(meshes.length).toBeGreaterThan(4);
    const keys = new Set<string>();
    for (const m of meshes) {
      const mat = m.material as THREE.Material;
      const s = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
      mat.onBeforeCompile(s, undefined as unknown as THREE.WebGLRenderer);
      expect(s.vertexShader, m.name).toContain('vInstanceFade = instanceFade;');
      expect(s.fragmentShader, m.name).toContain('>= vInstanceFade ) discard;');
      keys.add(mat.customProgramCacheKey());
      if (m.castShadow) {
        const depth = m.customDepthMaterial as THREE.MeshDepthMaterial;
        expect(depth, m.name).toBeInstanceOf(THREE.MeshDepthMaterial);
        const ds = { vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
        depth.onBeforeCompile(ds, undefined as unknown as THREE.WebGLRenderer);
        expect(ds.fragmentShader, m.name).toContain('>= vInstanceFade ) discard;');
      }
    }
    // One fixed cache key for every shared bucket (plus the lamps' own), so a new bucket reuses a compiled program.
    // Revised (mission 3 cars): plus the far glass's, whose Fresnel patch is a program family of its own, and the
    // under-car shade's (an unlit pad sized per instance); each is one fixed key, compiled by the warm-up.
    expect(keys.size).toBeLessThanOrEqual(4);
    batches.dispose();
  });
});

describe('a falling helicopter at the longest frame the game allows (0.1 s)', () => {
  const LONG = 0.1;

  function drop(sim: Sim, x: number, y: number, z: number, vy: number): Helicopter {
    const h = new Helicopter(sim.newId(), x, y, z);
    h.health = 0;
    h.vel.y = vy;
    sim.helis.push(h);
    for (let i = 0; i < 400 && !h.removed; i++) step(sim, LONG, undefined, LONG);
    expect(h.removed).toBe(true);
    return h;
  }

  it('Lou\'s garage: from 7.4 m at 40 m/s down it rests on the roof and spares the sedan inside', () => {
    const g = W.layout.garages.find((q) => q.poi === 'lou')!;
    const x = (g.rect.minX + g.rect.maxX) / 2;
    const z = (g.rect.minZ + g.rect.maxZ) / 2;
    const top = g.height + GARAGE_ROOF;
    const sim = makeSim({ world: W });
    const parked = sim.spawnVehicle('sedan', x, z, 0);
    const health = parked.health;
    const h = drop(sim, x, top + 1.5, z, -40);
    expect(h.pos.y - HELI_BOTTOM).toBeCloseTo(top, 6);
    expect(parked.health).toBe(health);
    expect(parked.destroyed).toBe(false);
    // The helper on its own: a 4.11 m fall through the 0.4 m slab in one step is a roof landing.
    expect(heliCrashHit(W, x, top + 1.5 - 4.11, z, 4.11)).toEqual({ y: top + HELI_BOTTOM, garageRoof: true });
  });

  it('every garage and the police station stop it on the roof from any phase of the fall, sparing the cars inside', () => {
    const roofs: Array<{ name: string; x: number; z: number; top: number }> = W.layout.garages.map((g) => ({ name: `garage ${g.poi}`, x: (g.rect.minX + g.rect.maxX) / 2, z: (g.rect.minZ + g.rect.maxZ) / 2, top: g.height + GARAGE_ROOF }));
    const station = W.layout.buildings.find((b) => b.special === 'police')!;
    const t = station.tiers[station.tiers.length - 1]!;
    roofs.push({ name: 'police station', x: (t.minX + t.maxX) / 2, z: (t.minZ + t.maxZ) / 2, top: Math.max(...station.tiers.map((q) => q.y1)) });
    for (const r of roofs) {
      for (const lift of [1.5, 2.2, 2.9, 3.6, 7.3, 12.9]) {
        const sim = makeSim({ world: W });
        const parked = r.name.startsWith('garage') ? sim.spawnVehicle('sedan', r.x, r.z, 0) : null;
        const health = parked?.health;
        const h = drop(sim, r.x, r.top + lift, r.z, -40);
        const low = h.pos.y - HELI_BOTTOM;
        expect(low, `${r.name} from +${lift}`).toBeGreaterThanOrEqual(r.top - 1e-6);
        expect(low, `${r.name} from +${lift}`).toBeLessThanOrEqual(r.top + 0.3);
        if (parked) expect(parked.health, `${r.name} from +${lift}`).toBe(health);
      }
    }
  });
});
