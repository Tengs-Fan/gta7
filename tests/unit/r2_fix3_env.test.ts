// Regression tests for the round-2 fix pass 3, cluster "env": the twilight key light, the shadow
// snapping, lit smoke, Effects.reset(), the marina boats, roofs, fountains, lamp pools, the Ferris
// wheel, the sea, the no-float-buffer fallback and the per-material reflections.
// The stub header is copied from fix_render.test.ts (vi.mock cannot be shared between files).

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Environment } from '../../src/render/environment';
import { GameRenderer } from '../../src/render/renderer';
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
    outputColorSpace = '';
    toneMapping = 0;
    toneMappingExposure = 1;
    constructor(params: { canvas?: unknown } = {}) {
      this.params = params;
      this.domElement = params.canvas;
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
  function sweep(h0: number, h1: number): { dL: number; dC: number; phantom: Array<{ h: number; y: number; i: number }>; at: number } {
    const r = fakeRenderer();
    const env = new Environment(new THREE.Scene(), r);
    const cam = new THREE.PerspectiveCamera();
    const focus = new THREE.Vector3();
    let prevL: THREE.Vector3 | null = null;
    let prevC: THREE.Vector3 | null = null;
    let dL = 0;
    let dC = 0;
    let at = h0;
    const phantom: Array<{ h: number; y: number; i: number }> = [];
    const frames = Math.round((h1 - h0) / FRAME_H);
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
    }
    return { dL, dC, phantom, at };
  }

  it('dusk: the sun light fades out with the sky sun and the moon fades in, without a one-frame swap', () => {
    const s = sweep(18.5, 20.5);
    expect(s.phantom.slice(0, 3), 'a sun below the horizon still lights the scene').toEqual([]);
    expect(s.dL, `largest per-frame change of the key light at ${s.at.toFixed(4)} h`).toBeLessThan(0.01);
    expect(s.dC).toBeLessThan(0.01);
  });

  it('dawn: the moon fades out before the sun light comes up with the sky sun', () => {
    const s = sweep(4.5, 6.5);
    expect(s.phantom.slice(0, 3), 'a sun below the horizon already lights the scene').toEqual([]);
    expect(s.dL, `largest per-frame change of the key light at ${s.at.toFixed(4)} h`).toBeLessThan(0.01);
    expect(s.dC).toBeLessThan(0.01);
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

/** The colour the first particle of a layer is drawn in: its instance colour times the layer's light (if lit). */
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
