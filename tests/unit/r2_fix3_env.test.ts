// Regression tests for the round-2 fix pass 3, cluster "env": the twilight key light, the shadow
// snapping, lit smoke, Effects.reset(), the marina boats, roofs, fountains, lamp pools, the Ferris
// wheel, the sea, the no-float-buffer fallback and the per-material reflections.
// The stub header is copied from fix_render.test.ts (vi.mock cannot be shared between files).

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as environment from '../../src/render/environment';
import { Environment } from '../../src/render/environment';
import * as textures from '../../src/render/textures';
import { CityView } from '../../src/render/city';
import { PropsView } from '../../src/render/props';
import { GameRenderer } from '../../src/render/renderer';
import type { VehicleViewPool } from '../../src/render/vehicleView';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import type { Sim } from '../../src/sim/sim';
import { makeContact, obbVsAabb, type OBB } from '../../src/core/collision';
import { vehicleObb } from '../../src/sim/vehiclePhysics';
import { WATER_Y } from '../../src/world/constants';
import type { StaticCollider } from '../../src/world/colliders';
import { FLOAT_FEET, type StaticWorld } from '../../src/world/staticWorld';
import { SWIM_FLOAT } from '../../src/sim/characterPhysics';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

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
    // Every other 2D call is a no-op; property writes are kept.
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
    readonly params: Record<string, unknown>;
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
      this.params = params;
      this.domElement = params.canvas ?? new EventTarget();
    }
    setPixelRatio(): void {}
    setSize(): void {}
    getDrawingBufferSize(v: InstanceType<typeof actual.Vector2>): InstanceType<typeof actual.Vector2> {
      return v.set(1280, 720);
    }
    setEffects(): void {}
    private target: unknown = null;
    setRenderTarget(t: unknown): void {
      this.target = t;
    }
    getRenderTarget(): unknown {
      return this.target;
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
const MOON_COLOR = new THREE.Color(0x9fb4ff);

function fakeRenderer(): THREE.WebGLRenderer {
  return new THREE.WebGLRenderer();
}

/** Unit vector from the key light's target to the light (the direction light comes from). */
function keyDir(env: Environment): THREE.Vector3 {
  return env.sun.position.clone().sub(env.sun.target.position).normalize();
}

describe('twilight key light (no phantom sun)', () => {
  /**
   * Steps the environment one frame at a time through [h0, h1] and reports the largest per-frame
   * change of the key light (direction x intensity, colour x intensity), and every frame where a
   * sun below the sky's horizon test (sunDir.y < -0.05) still lights the scene.
   */
  function sweep(h0: number, h1: number): { dL: number; dC: number; phantom: Array<{ h: number; y: number; i: number }>; reflected: Array<{ h: number; y: number; sun: number }>; off: number; at: number } {
    const r = fakeRenderer();
    const env = new Environment(new THREE.Scene(), r);
    const envSun = ((env as unknown as { envMat: THREE.ShaderMaterial }).envMat.uniforms.uSun!.value as THREE.Color);
    const cam = new THREE.PerspectiveCamera();
    const focus = new THREE.Vector3();
    let prevL: THREE.Vector3 | null = null;
    let prevC: THREE.Vector3 | null = null;
    let dL = 0;
    let dC = 0;
    let at = h0;
    let off = 0;
    const phantom: Array<{ h: number; y: number; i: number }> = [];
    const reflected: Array<{ h: number; y: number; sun: number }> = [];
    const frames = Math.round((h1 - h0) / FRAME_H);
    let below: number | null = null;
    for (let k = 0; k <= frames; k++) {
      const h = (h0 + k * FRAME_H) % 24;
      env.update(h, focus, cam, k * DT, r);
      const i = env.sun.intensity;
      const L = keyDir(env).multiplyScalar(i);
      const C = new THREE.Vector3(env.sun.color.r, env.sun.color.g, env.sun.color.b).multiplyScalar(i);
      if (prevL && prevC) {
        const d = L.distanceTo(prevL);
        if (d > dL) {
          dL = d;
          at = h;
        }
        dC = Math.max(dC, C.distanceTo(prevC));
      }
      prevL = L;
      prevC = C;
      const moon = env.sun.color.equals(MOON_COLOR);
      if (env.sunDir.y < -0.05 && !moon && i > 1e-3) phantom.push({ h, y: env.sunDir.y, i });
      // The sun reflected by the baked sky (the sea's glare) sets with the sky's too: at most an invisible trace
      // of it until the next bake is due, half a real second (30 frames) on, and none after.
      if (env.sunDir.y < -0.05) {
        below ??= k;
        const sun = lum(envSun);
        if (sun > 1e-4 || (k - below >= 30 && sun > 0)) reflected.push({ h, y: env.sunDir.y, sun });
      }
      // While the sun lights the scene, its light comes from where the sky shows it (within the low-sun guard).
      if (!moon && i > 1e-3) off = Math.max(off, keyDir(env).angleTo(env.sunDir));
    }
    return { dL, dC, phantom, reflected, off, at };
  }

  it('dusk: the sun light fades out with the sky sun and the moon fades in, without a one-frame swap', () => {
    const s = sweep(18.5, 20.5);
    expect(s.phantom.slice(0, 3), 'a sun below the horizon still lights the scene').toEqual([]);
    expect(s.reflected.slice(0, 3), 'the baked sky still reflects a sun below the horizon').toEqual([]);
    expect(s.dL, `largest per-frame change of the key light at ${s.at.toFixed(4)} h`).toBeLessThan(0.01);
    expect(s.dC).toBeLessThan(0.01);
    // The light comes from the sky's sun, or level with the horizon while that sinks under it, fading.
    expect(THREE.MathUtils.radToDeg(s.off)).toBeLessThan(3);
  });

  it('dawn: the moon fades out before the sun light comes up with the sky sun', () => {
    const s = sweep(4.5, 6.5);
    expect(s.phantom.slice(0, 3), 'a sun below the horizon already lights the scene').toEqual([]);
    expect(s.reflected.slice(0, 3), 'the baked sky already reflects a sun below the horizon').toEqual([]);
    expect(s.dL, `largest per-frame change of the key light at ${s.at.toFixed(4)} h`).toBeLessThan(0.01);
    expect(s.dC).toBeLessThan(0.01);
    expect(THREE.MathUtils.radToDeg(s.off)).toBeLessThan(3);
  });

  it('the moonlight does not jump at midnight', () => {
    const s = sweep(23.5, 24.5);
    expect(s.dL, `largest per-frame change of the key light at ${s.at.toFixed(4)} h`).toBeLessThan(0.01);
  });
});

describe('shadow texel snapping', () => {
  /** Shadow-map texel coordinates of world point p for the current light and focus. */
  function texelOf(env: Environment, p: THREE.Vector3): THREE.Vector2 {
    const light = env.sun;
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
    const cam = light.shadow.camera as THREE.OrthographicCamera;
    cam.updateProjectionMatrix();
    light.shadow.updateMatrices(light);
    const ndc = p.clone().applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    const size = light.shadow.mapSize;
    return new THREE.Vector2((ndc.x * 0.5 + 0.5) * size.x, (ndc.y * 0.5 + 0.5) * size.y);
  }

  const fracErr = (v: number) => Math.abs(v - Math.round(v));

  for (const size of [2048, 1024]) {
    it(`a static point moves by whole texels when the focus moves (map ${size})`, () => {
      const r = fakeRenderer();
      const env = new Environment(new THREE.Scene(), r);
      env.sun.shadow.mapSize.set(size, size);
      const cam = new THREE.PerspectiveCamera();
      let worst = 0;
      for (const hours of [9.3, 15.5, 18.2]) {
        // Moves of a walking or driving player inside one 64 m anchor cell (centred on (128, -192)).
        const base = new THREE.Vector3(128, 0, -192);
        env.update(hours, base, cam, 0, r);
        const p = new THREE.Vector3(140, 4, -180);
        const t0 = texelOf(env, p);
        for (let k = 1; k <= 40; k++) {
          const f = base.clone().add(new THREE.Vector3(Math.sin(k * 1.7) * 20, 0, Math.cos(k * 2.3) * 20));
          env.update(hours, f, cam, 0, r);
          const t = texelOf(env, p);
          worst = Math.max(worst, fracErr(t.x - t0.x), fracErr(t.y - t0.y));
        }
      }
      expect(worst, 'sub-texel shift of a static point').toBeLessThan(1e-3);
    });
  }
});

// ---------------------------------------------------------------------------
// Effects: lit smoke, and a clean slate for every new session

/** The private particle layers and skid marks of an Effects, for inspection. */
interface Layer {
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  active: number;
}
interface FxPriv {
  glow: Layer;
  smoke: Layer;
  skids: { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>; birth: Float32Array };
}

/**
 * The colour the first particle of a layer is drawn in: its instance colour times the layer's light (if lit). This
 * checks the light the layer is given; r2_fix4_env.test.ts runs the particle and skid shaders to check they apply it.
 */
function drawnColor(layer: Layer): THREE.Color {
  const c = layer.mesh.geometry.getAttribute('iColor') as THREE.InstancedBufferAttribute;
  const light = (layer.mesh.material.uniforms.uLight?.value as THREE.Color | undefined) ?? new THREE.Color(1, 1, 1);
  return new THREE.Color(c.getX(0) * light.r, c.getY(0) * light.g, c.getZ(0) * light.b);
}

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('effects', () => {
  let W: StaticWorld;
  let R: GameRenderer;

  beforeAll(() => {
    W = world();
    R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, W, { quality: 'low', fov: 68 });
  });

  function attachPlay(sim: Sim): void {
    R.attach(sim);
    R.cameraCtl.mode = 'play';
    R.cameraCtl.reset(sim);
  }

  /** Drawn colour of a fresh puff of tyre smoke and of a fresh spark at a time of day. */
  function puffAndSpark(sim: Sim, hours: number): { smoke: THREE.Color; spark: THREE.Color; skid: THREE.Color } {
    attachPlay(sim); // a clean slate: the puff and the spark are the first particles of their layers
    sim.clock.set(hours);
    sim.clock.rate = 0;
    const p = sim.playerPos();
    R.effects.tireSmoke(p.x + 3, p.y, p.z + 3);
    R.effects.sparks(p.x + 3, p.y + 0.5, p.z + 3, 1);
    R.render(DT, false);
    const fx = R.effects as unknown as FxPriv;
    const skidLight = (fx.skids.mesh.material.uniforms.uLight?.value as THREE.Color | undefined) ?? new THREE.Color(1, 1, 1);
    return { smoke: drawnColor(fx.smoke), spark: drawnColor(fx.glow), skid: skidLight.clone().multiplyScalar(0.04) };
  }

  it('tyre smoke, spray and dust are lit by the scene: dim and bluish at night, as they were at noon by day', () => {
    const sim = makeSim({ world: W });
    const noon = puffAndSpark(sim, 12);
    const night = puffAndSpark(sim, 22);
    const dusk = puffAndSpark(sim, 18.6);
    // Noon keeps the tuned colours (the light is 1 there).
    expect(noon.smoke.r).toBeGreaterThan(0.8);
    expect(lum(night.smoke), `night ${night.smoke.toArray()} vs noon ${noon.smoke.toArray()}`).toBeLessThan(0.3 * lum(noon.smoke));
    expect(lum(night.smoke)).toBeGreaterThan(0.1 * lum(noon.smoke)); // still readable under the street lamps
    expect(night.smoke.b, 'moonlit blue').toBeGreaterThan(night.smoke.r);
    expect(dusk.smoke.r, 'sunset orange').toBeGreaterThan(dusk.smoke.b * 1.5);
    // Skid marks darken the road as the road does, rather than showing light grey on black asphalt.
    expect(lum(night.skid)).toBeLessThan(0.3 * lum(noon.skid));
    // Fire, sparks and flashes glow by themselves (the spark's random life shifts its colour a little).
    expect(Math.abs(night.spark.r / noon.spark.r - 1)).toBeLessThan(0.05);
    expect(Math.abs(night.spark.g / noon.spark.g - 1)).toBeLessThan(0.05);
  });

  it('a new session starts without the last one\'s smoke, fire, skid marks or flash lights', () => {
    const a = makeSim({ world: W });
    attachPlay(a);
    const p = a.playerPos();
    a.events.emit('explosion', { x: p.x + 8, y: p.y, z: p.z, radius: 7.5 });
    R.effects.muzzleFlash(p.x, p.y + 1.4, p.z, 0.4);
    R.effects.tireSmoke(p.x + 2, p.y, p.z);
    for (let k = 0; k < 6; k++) R.effects.skids.add('1:l', p.x + k * 0.5, p.y, p.z + 4, R.time + k * 0.02);
    R.render(DT, false);
    const fx = R.effects as unknown as FxPriv;
    expect(R.effects.particleCount).toBeGreaterThan(0);
    expect(R.effects.flash.intensity).toBeGreaterThan(0);
    expect(Array.from(fx.skids.birth).some((b) => b > R.time - 40)).toBe(true);

    const b = makeSim({ world: W });
    attachPlay(b);
    R.render(DT, false);
    expect(R.effects.particleCount).toBe(0);
    expect(R.effects.flash.intensity).toBe(0);
    expect(R.effects.muzzle.intensity).toBe(0);
    expect(Array.from(fx.skids.birth).filter((t) => t > R.time - 40).length, 'skid marks still fading in').toBe(0);
    // A wheel's next point starts a new mark instead of joining the old session's.
    R.effects.skids.add('1:l', p.x + 3.2, p.y, p.z + 4, R.time);
    expect(Array.from(fx.skids.birth).filter((t) => t > R.time - 40).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The moored marina boats are solid

describe('marina boats', () => {
  const boats = () => world().layout.props.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'boat');
  const boatBoxes = (): StaticCollider[] => world().grid.colliders.filter((c) => c.tag === 'boat');

  it('every boat has a hull and a cabin box where the boat is drawn, and they block sight', () => {
    const W = world();
    expect(boats().length).toBe(3);
    for (const { p, i } of boats()) {
      expect(W.propColliders[i]).toBeGreaterThanOrEqual(0);
      const mine = boatBoxes().filter((c) => c.cx > p.x - 8 && c.cx < p.x + 8 && c.cz > p.z - 8 && c.cz < p.z + 8);
      expect(mine.length).toBe(2);
      const [hull, cabin] = mine[0]!.y1 < mine[1]!.y1 ? [mine[0]!, mine[1]!] : [mine[1]!, mine[0]!];
      // The hull drawn by PropsView.buildBoat: 2.6 m wide, 12 m long, its bow to the north; deck at p.y + 1.2.
      expect(hull.minX).toBeCloseTo(p.x - 1.3, 6);
      expect(hull.maxX).toBeCloseTo(p.x + 1.3, 6);
      expect(hull.minZ).toBeCloseTo(p.z - 7, 6);
      expect(hull.maxZ).toBeCloseTo(p.z + 5, 6);
      expect(hull.y0).toBeLessThan(WATER_Y - 1.3); // a swimmer's whole band
      expect(hull.y1).toBeCloseTo(p.y + 1.2, 6);
      expect(cabin.maxX - cabin.minX).toBeCloseTo(2, 6);
      expect(cabin.maxZ - cabin.minZ).toBeCloseTo(3.4, 6);
      expect(cabin.y1).toBeCloseTo(p.y + 2.5, 6);
      // Shots, the camera and line of sight stop at the hull and at the cabin.
      expect(W.lineOfSight(p.x - 4, p.y + 0.6, p.z + 3, p.x + 4, p.y + 0.6, p.z + 3)).toBe(false);
      expect(W.lineOfSight(p.x - 4, p.y + 2, p.z, p.x + 4, p.y + 2, p.z)).toBe(false);
      // Nobody is put inside one (getting out of a car into the water, respawns, spawns), over shallow
      // or deep water: a body there floats at the swimming height.
      expect(W.isFree(p.x, p.z, 0.4, true)).toBe(false);
      expect(W.isFree(p.x + 1.8, p.z, 0.4, true)).toBe(true);
    }
    expect(FLOAT_FEET).toBe(SWIM_FLOAT);
  });

  it('a swimmer pushing against a hull stops at its side', () => {
    const sim = makeSim({ world: world() });
    const boat = boats()[0]!.p;
    teleport(sim, boat.x - 2.7, boat.z);
    step(sim, 0.5);
    expect(sim.player.state).toBe('swimming');
    step(sim, 4, input({ moveZ: 1, cameraYaw: Math.PI / 2 }));
    expect(sim.player.pos.x + sim.player.radius).toBeLessThan(boat.x - 1.3 + 0.05);
    expect(Math.abs(sim.player.pos.z - boat.z)).toBeLessThan(1);
  });

  it('a car driven off the finger pier into the hull does not sink through it', () => {
    const sim = makeSim({ world: world() });
    const boat = boats()[0]!.p;
    const v = sim.spawnVehicle('sedan', boat.x - 6.5, boat.z, Math.PI / 2);
    placeInCar(sim, v);
    // The hull as drawn (see the first test), from the waterline up to the deck.
    const hull = { minX: boat.x - 1.3, maxX: boat.x + 1.3, minZ: boat.z - 7, maxZ: boat.z + 5, y0: WATER_Y, y1: boat.y + 1.2 };
    const obb: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
    const ct = makeContact();
    let worst = 0;
    for (let f = 0; f < 240; f++) {
      step(sim, 1 / 60, input({ throttle: f < 27 ? 1 : 0 }));
      if (v.pos.y + 0.25 > hull.y1 || v.pos.y + v.spec.height < hull.y0) continue;
      if (obbVsAabb(vehicleObb(v, obb), hull, ct)) worst = Math.max(worst, ct.depth);
    }
    expect(worst, 'deepest overlap of the car and the hull (m)').toBeLessThan(0.15);
  });
});

// ---------------------------------------------------------------------------
// Roofs, fountains and lamp pools

describe('city and prop geometry', () => {
  let city: CityView;
  let props: PropsView;

  beforeAll(() => {
    city = new CityView(world());
    props = new PropsView(world());
    city.group.updateMatrixWorld(true);
    props.group.updateMatrixWorld(true);
  });

  /** The first thing a ray hits among `objects` (three's raycaster skips faces the materials cull). */
  function firstHit(objects: THREE.Object3D[], from: THREE.Vector3, to: THREE.Vector3): THREE.Intersection | null {
    const dir = to.clone().sub(from);
    const rc = new THREE.Raycaster(from, dir.clone().normalize(), 0, dir.length() + 2);
    return rc.intersectObjects(objects, false)[0] ?? null;
  }

  it('from the street, a gable roof shows its eaves and the attic gap from below instead of sky', () => {
    const roofs = city.group.getObjectByName('roofs')!;
    let n = 0;
    for (const b of world().layout.buildings) {
      if (b.roof !== 'gable') continue;
      const t = b.tiers[b.tiers.length - 1]!;
      const along = t.maxX - t.minX >= t.maxZ - t.minZ;
      const cx = (t.minX + t.maxX) / 2;
      const cz = (t.minZ + t.maxZ) / 2;
      // Straight up from under the 0.4 m eave, just outside a long wall.
      const under = along ? new THREE.Vector3(cx, t.y1 - 1, t.maxZ + 0.2) : new THREE.Vector3(t.maxX + 0.2, t.y1 - 1, cz);
      const eave = firstHit([roofs], under, under.clone().add(new THREE.Vector3(0, 3, 0)));
      expect(eave, `eave of building ${b.id}`).not.toBeNull();
      // From a camera on the sidewalk 3.5 m out, 1.8 m up, just over the wall top into the attic.
      const eye = along ? new THREE.Vector3(cx, t.y0 + 1.8, t.maxZ + 3.5) : new THREE.Vector3(t.maxX + 3.5, t.y0 + 1.8, cz);
      const top = along ? new THREE.Vector3(cx, t.y1 + 0.05, t.maxZ - 0.1) : new THREE.Vector3(t.maxX - 0.1, t.y1 + 0.05, cz);
      const attic = firstHit([roofs], eye, top);
      expect(attic, `attic of building ${b.id}`).not.toBeNull();
      if (++n >= 40) break;
    }
    expect(n).toBe(40);
    // Shadows are cast as before: the one-sided roof's back faces.
    const mat = (roofs as THREE.Mesh).material as THREE.Material;
    expect(mat.shadowSide).toBe(THREE.BackSide);
  });

  it('a fountain basin shows its far wall and rim above the water from outside', () => {
    const fountains = world().layout.props.filter((p) => p.kind === 'fountain');
    expect(fountains.length).toBe(3);
    for (const f of fountains) {
      const g = props.group.children.find((o) => o instanceof THREE.Group && Math.abs(o.position.x - f.x) < 1e-6 && Math.abs(o.position.z - f.z) < 1e-6)!;
      expect(g).toBeTruthy();
      const parts = g.children.filter((o) => o instanceof THREE.Mesh);
      for (const [eyeY, back] of [[2.2, 5.5], [1.2, 4.5]] as const) {
        // An eye outside the basin to the south, looking over the near rim and the water (clear of the
        // column) at the inside of the far wall, 0.12 m above the water.
        const eye = new THREE.Vector3(f.x + 2.6, f.y + eyeY, f.z + back);
        const far = new THREE.Vector3(f.x + 2.2, f.y + 0.62, f.z - 2.04);
        const hit = firstHit(parts, eye, far);
        expect(hit, 'far wall').not.toBeNull();
        expect(hit!.point.z, 'the hit is on the far side').toBeLessThan(f.z - 1.5);
        expect(hit!.point.y - f.y, 'above the water').toBeGreaterThan(0.5);
      }
      // No gap between the water and the wall: the water reaches under the inner face.
      const water = parts.find((o) => (o as THREE.Mesh).geometry instanceof THREE.CircleGeometry) as THREE.Mesh;
      const r = (water.geometry as THREE.CircleGeometry).parameters.radius;
      const wall = g.getObjectByName('fountainBasin') as THREE.Mesh | undefined;
      const inner = wall ? Math.min(...((wall.geometry as THREE.LatheGeometry).parameters.points.map((v) => v.x))) : 3.3;
      expect(r).toBeGreaterThanOrEqual(inner);
    }
  });

  it('street-lamp pools stay on the deck or the land under their lamp', () => {
    const W = world();
    const priv = props as unknown as { poolMat: THREE.Material };
    const batches = props.group.children.filter((o) => o instanceof THREE.InstancedMesh && o.material === priv.poolMat) as THREE.InstancedMesh[];
    expect(batches.length).toBeGreaterThan(0);
    /** Glow weight of the pool texture (textures.ts glowTexture) at a radius over the half size. */
    const glow = (r: number) => (r <= 0.35 ? 1 - (0.55 * r) / 0.35 : r <= 1 ? 0.45 * (1 - (r - 0.35) / 0.65) : 0);
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    let worst = 0;
    let worstAt = '';
    let pier = 0;
    for (const pools of batches) {
      const clip = pools.geometry.getAttribute('aClip') as THREE.InstancedBufferAttribute | undefined;
      for (let i = 0; i < pools.count; i++) {
      pools.getMatrixAt(i, m);
      m.decompose(pos, q, sc);
      const [x0, z0, x1, z1] = clip ? [clip.getX(i), clip.getY(i), clip.getZ(i), clip.getW(i)] : [-Infinity, -Infinity, Infinity, Infinity];
      let total = 0;
      let floating = 0;
      const N = 24;
      for (let a = 0; a < N; a++) {
        for (let b = 0; b < N; b++) {
          const u = (a + 0.5) / N - 0.5;
          const v = (b + 0.5) / N - 0.5;
          const w = glow(Math.hypot(u, v) * 2);
          if (w <= 0) continue;
          const x = pos.x + u * sc.x;
          const z = pos.z + v * sc.z;
          total += w;
          if (x < x0 || x > x1 || z < z0 || z > z1) continue;
          if (pos.y > Math.max(W.groundHeight(x, z), WATER_Y) + 0.3) floating += w;
        }
      }
      const share = floating / total;
      if (pos.y > 0.4) pier++;
      if (share > worst) {
        worst = share;
        worstAt = `pool ${i} at (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})`;
      }
    }
      }
    expect(pier).toBe(16);
    expect(worst, `largest share of a pool's light hanging in the air: ${worstAt}`).toBeLessThan(0.03);
  });

  it('the pier lamps face the deck, lighting its middle', () => {
    const pier = world().layout.decks.find((d) => d.name === 'Azura Pier')!;
    const zc = (pier.rect.minZ + pier.rect.maxZ) / 2;
    const lamps = world().layout.props.filter((p) => p.kind === 'lamp' && rectContainsXZ(pier.rect, p.x, p.z));
    expect(lamps.length).toBe(16);
    for (const p of lamps) {
      // The head, 1.55 m along the arm, stands over the deck, towards its centre line.
      const hz = p.z + Math.cos(p.rot) * 1.55;
      expect(Math.abs(hz - zc)).toBeLessThan(Math.abs(p.z - zc));
    }
  });
});

function rectContainsXZ(r: { minX: number; minZ: number; maxX: number; maxZ: number }, x: number, z: number): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

// ---------------------------------------------------------------------------
// The Ferris wheel's lights

describe('Ferris wheel lights', () => {
  it('each bulb stands clear of the rim tube, so a viewer sees all of it', () => {
    const props = new PropsView(world());
    const ferris = (props as unknown as { ferris: { wheel: THREE.Group; lights: THREE.InstancedMesh } }).ferris;
    const wheel = ferris.wheel;
    wheel.updateMatrixWorld(true);
    const lights = ferris.lights;
    const rim = wheel.children.find((o) => o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh))!;
    const radius = (lights.geometry as THREE.SphereGeometry).parameters.radius;
    const m = new THREE.Matrix4();
    const c = new THREE.Vector3();
    const rc = new THREE.Raycaster();
    let rays = 0;
    let seen = 0;
    for (let i = 0; i < lights.count; i++) {
      lights.getMatrixAt(i, m);
      c.setFromMatrixPosition(m);
      const toward = Math.sign(c.z); // the face of the wheel this bulb is on
      // A grid of rays square on to that face, over the bulb's outline (in the wheel's frame).
      for (let a = -2; a <= 2; a++) {
        for (let b = -2; b <= 2; b++) {
          const u = (a / 2.5) * radius;
          const v = (b / 2.5) * radius;
          if (u * u + v * v > radius * radius * 0.9) continue;
          const from = new THREE.Vector3(c.x + u, c.y + v, c.z + toward * 6).applyMatrix4(wheel.matrixWorld);
          const dir = new THREE.Vector3(0, 0, -toward).transformDirection(wheel.matrixWorld);
          rc.set(from, dir);
          const hit = rc.intersectObjects([rim, lights], false)[0];
          rays++;
          if (hit && hit.object === lights && hit.instanceId === i) seen++;
        }
      }
    }
    expect(seen / rays, 'share of each bulb\'s outline that is the bulb, not the tube').toBeGreaterThan(0.9);
  });

  it('lit at night they keep their hue on every tier and glow by themselves', () => {
    const r = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, world(), { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: true } });
    const f = (r.props as unknown as { ferris: { wheel: THREE.Group; lights: THREE.InstancedMesh } }).ferris;
    for (const tier of ['high', 'medium', 'low'] as const) {
      r.setQuality(tier);
      r.props.update(3, 1, 0);
      const halos = f.wheel.getObjectByName('ferrisHalos') as THREE.Points | undefined;
      expect(halos, 'one halo per bulb').toBeTruthy();
      expect(halos!.visible).toBe(true);
      const hc = halos!.geometry.getAttribute('color') as THREE.BufferAttribute;
      expect(hc.count).toBe(f.lights.count);
      for (let i = 0; i < f.lights.count; i++) {
        const core = f.lights.getColorAt(i, new THREE.Color());
        const hsl = core.getHSL({ h: 0, s: 0, l: 0 });
        // A saturated core no brighter than 1, which ACES keeps coloured (not a white speck).
        expect(Math.max(core.r, core.g, core.b), `${tier} bulb ${i}`).toBeLessThanOrEqual(1 + 1e-6);
        expect(hsl.s, `${tier} bulb ${i}`).toBeGreaterThan(0.9);
        // Its halo in the same hue, under the bloom threshold (no halo flickering in and out).
        const halo = new THREE.Color(hc.getX(i), hc.getY(i), hc.getZ(i));
        expect(halo.getHSL({ h: 0, s: 0, l: 0 }).h).toBeCloseTo(hsl.h, 3);
        expect(lum(halo)).toBeGreaterThan(0.05);
        expect(lum(halo)).toBeLessThan(2.6);
      }
    }
    // By day they are off and the halos are not drawn.
    r.props.update(3, 0, 0);
    const halos = f.wheel.getObjectByName('ferrisHalos') as THREE.Points;
    expect(halos.visible).toBe(false);
    // They bring no texture of their own (one would first be uploaded at nightfall): the lamp pools' glow.
    expect((halos.material as THREE.PointsMaterial).map).toBe((r.props as unknown as { poolMat: THREE.MeshBasicMaterial }).poolMat.map);
  });
});

// ---------------------------------------------------------------------------
// The sea's ripples do not tile into a lattice

describe('sea ripples', () => {
  const tileData = (): Uint8ClampedArray => {
    const fn = (textures as Record<string, unknown>).waterNormalData as (() => Uint8ClampedArray) | undefined;
    expect(fn, 'the ripple tile as data').toBeTypeOf('function');
    return fn!();
  };
  const S = 256;

  it('the ripple tile has no dominant crest train and keeps the old ripple contrast', () => {
    const d = tileData();
    const nx = (i: number) => (d[i * 4]! / 255) * 2 - 1;
    const ny = (i: number) => (d[i * 4 + 1]! / 255) * 2 - 1;
    let s2 = 0;
    for (let i = 0; i < S * S; i++) s2 += nx(i) ** 2 + ny(i) ** 2;
    // The round-2 tile's RMS tilt was 0.214.
    expect(Math.abs(Math.sqrt(s2 / (S * S)) - 0.214)).toBeLessThan(0.01);
    // Share of the x slope's power in its strongest Fourier component (the round-2 tile: 0.61).
    let best = 0;
    let total = 0;
    for (let kx = -16; kx <= 16; kx++) {
      for (let ky = 0; ky <= 16; ky++) {
        if (ky === 0 && kx <= 0) continue;
        let re = 0;
        let im = 0;
        for (let y = 0; y < S; y += 2) {
          for (let x = 0; x < S; x += 2) {
            const ph = ((kx * x + ky * y) / S) * Math.PI * 2;
            const v = nx(y * S + x);
            re += v * Math.cos(ph);
            im += v * Math.sin(ph);
          }
        }
        const pw = re * re + im * im;
        total += pw;
        best = Math.max(best, pw);
      }
    }
    expect(best / total).toBeLessThan(0.2);
  });

  it('the sea draws the tile twice, turned and scaled by an irrational ratio, so the sum does not repeat with the tile', () => {
    const env = new Environment(new THREE.Scene(), fakeRenderer());
    const mat = env.water.material as THREE.MeshStandardMaterial;
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, fakeRenderer());
    expect(shader.fragmentShader.match(/texture2D\( normalMap/g)?.length ?? 0, 'normal-map samples').toBeGreaterThanOrEqual(2);
    expect(shader.uniforms.uRippleB).toBeTruthy();
    expect(mat.customProgramCacheKey()).not.toBe(new THREE.MeshStandardMaterial().customProgramCacheKey());
    // The summed slope field as the shader forms it, sampled over the sea: its correlation with itself
    // one tile (6000 m / 900) along x or z. A single tile repeats exactly (1).
    const d = tileData();
    const rb = (environment as Record<string, unknown>).RIPPLE_B as { scale: number; cos: number; sin: number };
    const at = (u: number, v: number, c: number) => {
      const x = ((Math.floor(u * S) % S) + S) % S;
      const y = ((Math.floor(v * S) % S) + S) % S;
      return (d[(y * S + x) * 4 + c]! / 255) * 2 - 1;
    };
    const field = (wx: number, wz: number): [number, number] => {
      const u = (wx / 6000) * 900;
      const v = (wz / 6000) * 900;
      const ub = (rb.cos * u - rb.sin * v) * rb.scale;
      const vb = (rb.sin * u + rb.cos * v) * rb.scale;
      const bx = at(ub, vb, 0);
      const by = at(ub, vb, 1);
      return [(at(u, v, 0) + rb.cos * bx + rb.sin * by) * 0.7071, (at(u, v, 1) - rb.sin * bx + rb.cos * by) * 0.7071];
    };
    const T = 6000 / 900;
    const corr = (lx: number, lz: number) => {
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let i = 0; i < 4000; i++) {
        const x = 37.3 + (i % 63) * 5.31;
        const z = -91.7 + Math.floor(i / 63) * 4.73;
        const a = field(x, z);
        const b = field(x + lx, z + lz);
        sab += a[0] * b[0] + a[1] * b[1];
        saa += a[0] ** 2 + a[1] ** 2;
        sbb += b[0] ** 2 + b[1] ** 2;
      }
      return sab / Math.sqrt(saa * sbb);
    };
    for (const [lx, lz] of [[T, 0], [0, T], [2 * T, 0], [T, T]]) expect(corr(lx, lz), `lag (${lx.toFixed(2)}, ${lz.toFixed(2)})`).toBeLessThan(0.65);
  });
});

// ---------------------------------------------------------------------------
// Without float colour buffers, and the per-material reflection strengths

describe('without float colour buffers', () => {
  /** A renderer on a GPU with or without half-float render targets, showing a sim at a time of day. */
  function rendererAt(halfFloat: boolean): { r: GameRenderer; show: (hours: number) => void } {
    const r = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, world(), { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat } });
    const sim = makeSim({ world: world() });
    r.attach(sim);
    sim.clock.rate = 0;
    return {
      r,
      show: (hours: number) => {
        sim.clock.set(hours);
        r.render(DT, false);
      },
    };
  }
  type EnvPriv = { pmrem: unknown; cubeTarget: unknown; envTarget: unknown };

  it('bakes no environment map (whose half-float targets would come out black) and lights the scene with the sky through a fill light', () => {
    const { r, show } = rendererAt(false);
    const env = r.env as unknown as EnvPriv;
    const fill: Record<number, number> = {};
    for (const h of [12, 18.5, 22, 6]) {
      show(h);
      expect(r.scene.environment, `${h} h`).toBeNull();
      expect(r.env.envFill, 'the sky light instead').toBeTruthy();
      fill[h] = lum(r.env.envFill!.color);
    }
    expect(env.pmrem, 'no PMREM generator (its targets are half-float)').toBeNull();
    expect(env.cubeTarget, 'no half-float cube target').toBeNull();
    expect(env.envTarget).toBeNull();
    // The fill follows the sky: bright at noon, dim at night, never black by day.
    expect(fill[12]!).toBeGreaterThan(lum(r.env.hemi.color) * 0.5);
    expect(fill[22]!).toBeLessThan(0.2 * fill[12]!);
    expect(fill[6]!).toBeGreaterThan(0);
    // The sea reflects the sky's gradient instead of the missing map (orange at sunset, not black).
    const seaShader = (env: Environment) => {
      const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
      (env.water.material as THREE.MeshStandardMaterial).onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, fakeRenderer());
      return shader;
    };
    const sea = seaShader(r.env);
    expect(sea.fragmentShader).toContain('radiance += skyC * uSkyI');
    show(18.6);
    expect((sea.uniforms.uSkyHorizon!.value as THREE.Color).r, 'the sunset horizon').toBeGreaterThan((sea.uniforms.uSkyHorizon!.value as THREE.Color).b);
    expect(sea.uniforms.uSkyI!.value).toBeCloseTo(r.scene.environmentIntensity, 6);
    // With half-float targets nothing changes: the baked sky lights and reflects, with no fill.
    const hdr = rendererAt(true);
    hdr.show(12);
    expect((hdr.r.env as unknown as EnvPriv).pmrem).toBeTruthy();
    expect(hdr.r.env.envFill).toBeNull();
    expect(seaShader(hdr.r.env).fragmentShader).not.toContain('uSkyI');
  });

  it('every custom shader drawn to the screen tone-maps and sRGB-encodes its own output when there is no output pass', () => {
    const { r, show } = rendererAt(false);
    show(12);
    const shaders: string[] = [];
    r.scene.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        if (!(m instanceof THREE.ShaderMaterial) || m instanceof THREE.RawShaderMaterial) continue;
        shaders.push(`${o.name || o.type}`);
        expect(m.fragmentShader, `${o.name || o.type}`).toContain('#include <tonemapping_fragment>');
        expect(m.fragmentShader, `${o.name || o.type}`).toContain('#include <colorspace_fragment>');
      }
    });
    // The sky, both particle layers, the skid marks, the tracers and the lighthouse beam at least.
    expect(shaders.length).toBeGreaterThanOrEqual(6);
  });
});

describe('reflection strength', () => {
  it('no material carries an envMapIntensity of its own, which three would ignore for scene.environmentIntensity', () => {
    const r = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, world(), { quality: 'high', fov: 68, gpu: { renderer: '', halfFloat: true } });
    const dead: string[] = [];
    const check = (o: THREE.Object3D): void => {
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        const s = m as THREE.MeshStandardMaterial;
        if (s.isMeshStandardMaterial && !s.envMap && s.envMapIntensity !== 1) dead.push(`${o.name || o.type} ${s.envMapIntensity}`);
      }
    };
    r.scene.traverse(check);
    // Every vehicle kind's view as well (pooled, in the scene only while a car of its kind is shown).
    const pool = (r as unknown as { pool: VehicleViewPool }).pool;
    for (const kind of Object.keys(VEHICLE_SPECS) as VehicleKind[]) {
      const v = pool.acquire(kind);
      v.group.traverse(check);
      pool.release(v);
    }
    expect(dead).toEqual([]);
  });
});
