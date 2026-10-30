// Round 2 driving cluster: keyboard steering shaping (P23a), traffic ahead of a fast driver (P41),
// the speed camera (P34), the canopy-clear camera (P21) and the lighthouse beam (P89).
// The render modules run headless with the stub header copied from fix_render.test.ts: a tiny
// canvas/document stub feeds the procedural textures and a fake WebGLRenderer stands in for WebGL.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { clamp, smoothstep, wrapAngle } from '../../src/core/math';
import { CameraController } from '../../src/render/camera';
import { FOLIAGE_FADE_FAR, PropsView } from '../../src/render/props';
import { GameRenderer } from '../../src/render/renderer';
import type { Vehicle } from '../../src/sim/entities';
import { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { isSolidForSight, makeRayHit } from '../../src/world/colliders';
import { AVENUE_W } from '../../src/world/constants';
import type { Prop } from '../../src/world/layout';
import { axisOf, type Lane } from '../../src/world/roads';
import { StaticWorld } from '../../src/world/staticWorld';
import { input, placeInCar, world } from './helpers';

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
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// P23a keyboard steering

let flat: StaticWorld | null = null;
/** The city with nothing in it: flat ground, no water, no static colliders (pure handling). */
function flatWorld(): StaticWorld {
  if (flat) return flat;
  const w = new StaticWorld();
  const o = w as unknown as Record<string, unknown>;
  o.groundHeight = () => 0;
  o.baseGround = () => 0;
  o.waterDepth = () => -10;
  (w.grid as unknown as Record<string, unknown>).query = () => {};
  flat = w;
  return w;
}

/** 'today': controls written straight into the car (the old controller); 'keys' / 'pad': the player with keys or a stick. */
type SteerMode = 'today' | 'keys' | 'pad';
type Ctl = { steer: number; handbrake?: boolean; throttle?: number };

/**
 * Drives a car heading +Z from `speed` for `secs` at 60 fps. Unless the control gives a throttle,
 * the throttle holds the starting speed. Returns the car and the total (unwrapped) heading change.
 */
function steerRun(kind: VehicleKind, speed: number, mode: SteerMode, secs: number, ctl: (t: number) => Ctl, each?: (t: number, v: Vehicle) => void): { v: Vehicle; turned: number } {
  const sim = new Sim({ world: flatWorld(), ambient: false, police: false });
  const v = sim.spawnVehicle(kind, 0, 0, 0);
  v.vel.z = speed;
  v.speed = speed;
  v.forwardSpeed = speed;
  if (mode === 'today') sim.seat(sim.spawnCharacter('civilian', 0, 0), v, 0);
  else placeInCar(sim, v);
  let turned = 0;
  let prev = v.heading;
  const frames = Math.round(secs / DT);
  for (let i = 0; i < frames; i++) {
    const c = ctl(i * DT);
    const throttle = c.throttle ?? clamp(0.25 + (speed - v.forwardSpeed) * 0.5, 0, 1);
    if (mode === 'today') {
      v.controls.throttle = throttle;
      v.controls.brake = 0;
      v.controls.steer = c.steer;
      v.controls.handbrake = !!c.handbrake;
      sim.update(DT, input());
    } else {
      // As Input reports it: digital only while a steering key is held.
      sim.update(DT, input({ throttle, steer: c.steer, handbrake: !!c.handbrake, steerDigital: mode === 'keys' && c.steer !== 0 }));
    }
    turned += wrapAngle(v.heading - prev);
    prev = v.heading;
    each?.((i + 1) * DT, v);
  }
  return { v, turned };
}

// Road vehicles: boats steer on the water (w1_boats.test.ts).
const KINDS = (Object.keys(VEHICLE_SPECS) as VehicleKind[]).filter((k) => VEHICLE_SPECS[k].class !== 'boat');
/** Kinds whose top speed is above 30 m/s. */
const FAST = KINDS.filter((k) => VEHICLE_SPECS[k].maxSpeed > 31);

describe('keyboard steering (P23a)', () => {
  it('a tap at 30 m/s nudges the car instead of swerving it', () => {
    for (const kind of FAST) {
      // 5 frames at 60 fps (83 ms) and 9 frames (150 ms), then 2.5 s to settle.
      const tap = (frames: number) => (t: number) => ({ steer: t < frames * DT - 1e-9 ? 1 : 0 });
      const short = Math.abs(steerRun(kind, 30, 'keys', 2.5, tap(5)).turned) * DEG;
      const long = Math.abs(steerRun(kind, 30, 'keys', 2.5, tap(9)).turned) * DEG;
      expect(short, kind).toBeLessThanOrEqual(1.3);
      expect(long, kind).toBeLessThanOrEqual(3.5);
      // Still a real input (today: 2.1-3.4 and 6-8.3 degrees).
      expect(short, kind).toBeGreaterThan(0.2);
      expect(long, kind).toBeGreaterThan(short * 2);
    }
  });

  it('holding a key at 30 m/s still reaches at least 90% of the full-lock yaw rate', () => {
    for (const kind of FAST) {
      const today = steerRun(kind, 30, 'today', 1.5, () => ({ steer: 1 })).v.angVel;
      const keys = steerRun(kind, 30, 'keys', 1.5, () => ({ steer: 1 })).v.angVel;
      // Steering right turns the heading clockwise (negative yaw rate).
      expect(today, kind).toBeLessThan(-0.5);
      expect(keys / today, kind).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('reaches full lock within 0.3 s at 5 m/s', () => {
    for (const kind of KINDS) {
      let at = Infinity;
      steerRun(kind, 5, 'keys', 0.5, () => ({ steer: 1 }), (t, v) => {
        if (at === Infinity && v.steer >= 0.999) at = t;
      });
      expect(at, kind).toBeLessThanOrEqual(0.3);
    }
  });

  it('handbrake turns keep full lock: W + A + Space for 0.8 s at 25 m/s rotates at least 50 degrees', () => {
    const hb = () => ({ steer: -1, handbrake: true, throttle: 1 });
    for (const kind of ['compact', 'sedan', 'taxi', 'sports', 'police'] as const) {
      expect(steerRun(kind, 25, 'keys', 0.8, hb).turned * DEG, kind).toBeGreaterThanOrEqual(50);
    }
    // Every kind turns exactly as hard as before.
    for (const kind of KINDS) {
      const today = steerRun(kind, 25, 'today', 0.8, hb).turned;
      expect(steerRun(kind, 25, 'keys', 0.8, hb).turned, kind).toBeCloseTo(today, 6);
    }
  });

  it('a gamepad stick steers exactly as before', () => {
    const moves: Array<[string, number, number, (t: number) => Ctl]> = [
      ['quick flick', 30, 2, (t) => ({ steer: t < 0.08 ? 1 : 0 })],
      ['partial hold', 20, 2.5, (t) => ({ steer: t < 1 ? 0.6 : 0 })],
      ['slalom', 25, 3, (t) => ({ steer: 0.7 * Math.sin(t * Math.PI) })],
      ['handbrake flick', 22, 2, (t) => ({ steer: t < 0.5 ? -0.9 : 0.2, handbrake: t < 0.4 })],
    ];
    for (const [name, speed, secs, ctl] of moves) {
      const today = steerRun('sedan', speed, 'today', secs, ctl).turned;
      const pad = steerRun('sedan', speed, 'pad', secs, ctl).turned;
      expect(Math.abs(today), name).toBeGreaterThan(0.01);
      expect(Math.abs(pad - today), name).toBeLessThanOrEqual(0.05 * Math.abs(today));
    }
  });

  it('a released key lets the wheel go at once, as before', () => {
    const sim = new Sim({ world: flatWorld(), ambient: false, police: false });
    const v = sim.spawnVehicle('sedan', 0, 0, 0);
    placeInCar(sim, v);
    v.vel.z = 30;
    for (let i = 0; i < 60; i++) sim.update(DT, input({ steer: 1, steerDigital: true, throttle: 0.4 }));
    expect(v.controls.steer).toBeGreaterThan(0.5);
    // No key held: Input reports a plain 0, which goes straight to the car (its own limit eases the wheel back).
    sim.update(DT, input({ steer: 0, steerDigital: false, throttle: 0.4 }));
    expect(v.controls.steer).toBe(0);
  });

  it('a non-finite steer value is ignored', () => {
    const sim = new Sim({ world: flatWorld(), ambient: false, police: false });
    const v = sim.spawnVehicle('sedan', 0, 0, 0);
    placeInCar(sim, v);
    sim.update(DT, input({ steer: NaN }));
    expect(v.controls.steer).toBe(0);
    sim.update(DT, input({ steer: 1, steerDigital: true }));
    expect(v.controls.steer).toBeCloseTo(4.2 * DT, 6);
  });

  it('starts centred in a new car', () => {
    const sim = new Sim({ world: flatWorld(), ambient: false, police: false });
    const a = sim.spawnVehicle('sedan', 0, 0, 0);
    const b = sim.spawnVehicle('sedan', 20, 0, 0);
    placeInCar(sim, a);
    for (let i = 0; i < 60; i++) sim.update(DT, input({ steer: 1, steerDigital: true }));
    expect(a.controls.steer).toBeCloseTo(1, 6);
    sim.unseat(sim.player);
    placeInCar(sim, b);
    sim.update(DT, input({ steer: 1, steerDigital: true }));
    // One frame of the 4.2/s wind-in, not the full lock left over from the first car.
    expect(b.controls.steer).toBeCloseTo(4.2 * DT, 6);
  });
});

// ---------------------------------------------------------------------------
// P34 the speed camera

type CamPriv = { target: THREE.Vector3; offset: THREE.Vector3; kickPos: THREE.Vector3; rumbleAmt: number; shakeAmt: number };
const camPriv = (c: CameraController) => c as unknown as CamPriv;

/** The southbound inner lane of Azura Ave leaving its north end. */
function azuraSouth(sim: Sim): Lane {
  const from = sim.roads.node(5, 0).id;
  return sim.roads.lanes.find((l) => l.from === from && l.dir === 2 && l.index === 0)!;
}

/**
 * The player in a `kind` held at `speed` straight down Azura Ave for `secs` (kinematic: the speed
 * is set every frame), with a play camera following at 60 fps.
 */
function cruise(kind: VehicleKind, speed: number, secs: number, each?: (cam: CameraController) => void): { sim: Sim; v: Vehicle; cam: CameraController } {
  const cam = new CameraController(16 / 9);
  const sim = new Sim({ world: world(), ambient: false, police: false });
  const lane = azuraSouth(sim);
  const v = sim.spawnVehicle(kind, lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading);
  placeInCar(sim, v);
  cam.mode = 'play';
  cam.reset(sim);
  for (let i = 0; i < Math.round(secs / DT); i++) {
    v.vel.x = lane.dx * speed;
    v.vel.z = lane.dz * speed;
    v.heading = lane.heading;
    v.angVel = 0;
    sim.update(DT, input({ aimOrigin: { x: cam.camera.position.x, y: cam.camera.position.y, z: cam.camera.position.z }, aimDir: { x: 0, y: -0.1, z: 1 } }));
    cam.update(DT, sim, false);
    each?.(cam);
  }
  return { sim, v, cam };
}

/** Camera pose without this frame's shake / rumble / kick: height above the car and boom length. */
function pose(r: { v: Vehicle; cam: CameraController }): { height: number; boom: number } {
  const p = r.cam.camera.position.clone().sub(camPriv(r.cam).offset);
  const t = camPriv(r.cam).target;
  return { height: p.y - r.v.pos.y, boom: Math.hypot(p.x - t.x, p.z - t.z) };
}

describe('the speed camera (P34)', () => {
  it('widens the FOV with the absolute speed, the same in every car', () => {
    for (const kind of ['compact', 'sports'] as const) {
      const fast = cruise(kind, 50, 2.5).cam;
      expect(fast.camera.fov, kind).toBeGreaterThanOrEqual(fast.baseFov + 12);
      const slow = cruise(kind, 8, 2.5).cam;
      expect(slow.camera.fov, kind).toBeLessThanOrEqual(slow.baseFov + 1);
    }
  });

  it('drops and pulls back at speed', () => {
    for (const kind of ['compact', 'sedan', 'sports', 'van'] as const) {
      const rest = pose(cruise(kind, 0, 2.5));
      const fast = pose(cruise(kind, 50, 2.5));
      expect(rest.height - fast.height, kind).toBeGreaterThanOrEqual(0.3);
      expect(fast.boom - rest.boom, kind).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('adds no shake, rumble or kick while paused (dt = 0)', () => {
    const { sim, cam } = cruise('sports', 50, 1);
    cam.addShake(2);
    cam.addKick(1, 0, 40);
    cam.update(DT, sim, false);
    expect(camPriv(cam).offset.length()).toBeGreaterThan(0.01);
    cam.update(0, sim, false);
    expect(camPriv(cam).offset.length()).toBe(0);
    const a = cam.camera.position.clone();
    for (let i = 0; i < 5; i++) {
      cam.update(0, sim, false);
      expect(cam.camera.position.distanceTo(a)).toBe(0);
    }
    cam.reset(sim);
    expect(camPriv(cam).shakeAmt).toBe(0);
    expect(camPriv(cam).kickPos.length()).toBe(0);
  });

  it('rumbles only above 30 m/s, a few centimetres at most', () => {
    const slow = cruise('sports', 24, 1).cam;
    expect(camPriv(slow).rumbleAmt).toBe(0);
    expect(camPriv(slow).offset.length()).toBe(0);
    let peak = 0;
    const fast = cruise('sports', 58, 2, (cam) => {
      peak = Math.max(peak, camPriv(cam).offset.length());
    }).cam;
    expect(camPriv(fast).rumbleAmt).toBeGreaterThan(0.02);
    expect(peak).toBeGreaterThan(0.005);
    expect(peak).toBeLessThan(0.05);
  });

  it('an impact kick swings towards the hit and settles within half a second at any frame rate', () => {
    for (const fps of [10, 60, 144]) {
      const { sim, cam } = cruise('sedan', 0, 0.5);
      cam.addKick(0, 3, 30); // a hit at the front-right... any horizontal direction: here +Z
      let peak = 0;
      let peakZ = 0;
      for (let i = 0; i < Math.round(0.5 * fps); i++) {
        cam.update(1 / fps, sim, false);
        const k = camPriv(cam).kickPos;
        if (k.length() > peak) {
          peak = k.length();
          peakZ = k.z;
        }
      }
      // min(0.35, 30 / 60) = 0.35 m towards +Z (sampled at 10 fps the swing peaks between frames).
      expect(peakZ, `${fps} fps`).toBeGreaterThan(fps === 10 ? 0.15 : 0.3);
      expect(peak, `${fps} fps`).toBeLessThanOrEqual(0.36);
      expect(camPriv(cam).kickPos.length(), `${fps} fps`).toBeLessThan(0.01);
    }
    // A landing has no horizontal direction: the camera dips.
    const { sim, cam } = cruise('sedan', 0, 0.5);
    cam.addKick(0, 0, 12);
    let low = 0;
    for (let i = 0; i < 30; i++) {
      cam.update(DT, sim, false);
      low = Math.min(low, camPriv(cam).kickPos.y);
    }
    expect(low).toBeLessThan(-0.1);
  });

  it("a hit on the player's car kicks the camera instead of shaking it", () => {
    const R = new GameRenderer(document.createElement('canvas') as unknown as HTMLCanvasElement, world(), { quality: 'low', fov: 68 });
    const { sim, v } = cruise('sedan', 0, 0.2);
    R.attach(sim);
    R.cameraCtl.mode = 'play';
    R.cameraCtl.reset(sim);
    R.render(DT, false);
    // Contact on the car's left side (local +X).
    const lx = Math.cos(v.heading);
    const lz = -Math.sin(v.heading);
    sim.events.emit('impact', { x: v.pos.x + lx * 1.2, y: v.pos.y + 0.6, z: v.pos.z + lz * 1.2, strength: 20, vehicle: v });
    for (let i = 0; i < 4; i++) R.render(DT, false);
    const k = camPriv(R.cameraCtl).kickPos;
    expect(camPriv(R.cameraCtl).shakeAmt).toBe(0);
    expect(k.x * lx + k.z * lz).toBeGreaterThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// P41 traffic ahead of a fast player

describe('traffic ahead of a fast driver (P41)', () => {
  for (const stars of [0, 2]) {
  it(`a fast run down Azura Ave has traffic on the avenue ahead, none of it spawned in view (${stars} stars)`, () => {
    // Round 2 fix pass (police): also while the police are after him (the merger had switched traffic ahead off
    // then). Wanted, only the cars that would wait at a red light in his way or across it are left out.
    const sim = new Sim({ world: world(), ambient: true, police: false, startHour: 17.5 });
    const n = sim.roads.node(5, 0);
    const end = sim.roads.node(5, 10).z - 60;
    const x0 = n.x - 2;
    const v = sim.spawnVehicle('sports', x0, n.z + n.halfZ + 8, 0);
    placeInCar(sim, v);
    // The chase camera's pose, aimed along the travel direction (south).
    const cam = (over = {}) => input({ aimOrigin: { x: v.pos.x, y: v.pos.y + 3, z: v.pos.z - 9 }, aimDir: { x: 0, y: -0.1, z: 1 }, ...over });
    for (let i = 0; i < 60 * 20; i++) sim.update(DT, cam({ handbrake: true }));
    if (stars > 0) {
      // A mission floor keeps the stars with the police off.
      sim.wanted.setLevel(stars);
      sim.wanted.floor = stars;
    }
    const seen = new Set(sim.vehicles.map((o) => o.id));
    // Cross traffic spawned with its light green (moving), and cars spawned on his road ahead at a red light.
    let crossGreen = 0;
    let pathRed = 0;
    const ahead: number[] = [];
    let spawned = 0;
    let spawnedInView = 0;
    // Cross traffic spawned at a light that is not green, watched until the light changes.
    const held = new Map<Vehicle, Lane>();
    let heldTotal = 0;
    let ranRed = 0;
    const isRed = (l: Lane) => sim.roads.signalState(l.to, axisOf(l.dir), sim.time) !== 'green';
    // The whole avenue at 30 m/s (it is about 900 m long: 29 s), held on its inner southbound lane
    // whatever it runs into.
    const z0 = v.pos.z;
    for (let i = 0; i < 60 * 40 && v.pos.z < end; i++) {
      v.vel.x = 0;
      v.vel.z = 30;
      v.heading = 0;
      v.angVel = 0;
      v.pos.x = x0;
      v.pos.z = z0 + 30 * i * DT;
      sim.update(DT, cam());
      for (const o of sim.vehicles) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        if (o.owner !== 'traffic') continue;
        spawned++;
        if (sim.isVisible(o.pos.x, 1, o.pos.z)) spawnedInView++;
        const lane = o.ai?.currentLane();
        // Wave 1: at the avenue's junctions, his way; a car waiting at a red light a block or more off to the side is
        // not in his way (it only showed up once motorbikes in the mix reshuffled the traffic).
        const atLine = !!lane && lane.length - ((o.pos.x - lane.sx) * lane.dx + (o.pos.z - lane.sz) * lane.dz) < 12 && Math.abs(sim.roads.nodes[lane.to]!.x - n.x) < AVENUE_W;
        if (lane && lane.dir % 2 === 1 && atLine && isRed(lane)) {
          expect(o.speed).toBe(0);
          held.set(o, lane);
          heldTotal++;
        }
        if (lane && lane.dir % 2 === 1 && atLine && !isRed(lane)) crossGreen++;
        if (lane && lane.dir === 2 && Math.abs(o.pos.x - n.x) < AVENUE_W / 2 && o.pos.z > v.pos.z && isRed(lane)) pathRed++;
      }
      for (const [o, lane] of held) {
        if (o.removed || !isRed(lane)) held.delete(o);
        // The nose stays behind the end of the lane (the stop line) until the light changes.
        else if ((o.pos.x - lane.sx) * lane.dx + (o.pos.z - lane.sz) * lane.dz + o.halfL > lane.length + 0.5) ranRed++;
      }
      if (i % 30 === 0) ahead.push(sim.vehicles.filter((o) => o.owner === 'traffic' && !o.removed && o.pos.z > v.pos.z && o.pos.z < v.pos.z + 150 && Math.abs(o.pos.x - n.x) < AVENUE_W / 2).length);
    }
    const mean = ahead.reduce((a, b) => a + b, 0) / ahead.length;
    expect(v.pos.z).toBeGreaterThanOrEqual(end);
    expect(ahead.length).toBeGreaterThan(50);
    expect(mean).toBeGreaterThanOrEqual(1);
    expect(spawned).toBeGreaterThan(30);
    expect(spawnedInView).toBe(0);
    expect(ranRed).toBe(0);
    if (stars === 0) {
      expect(heldTotal).toBeGreaterThanOrEqual(2);
    } else {
      expect(heldTotal).toBe(0);
      expect(pathRed).toBe(0);
      expect(crossGreen).toBeGreaterThanOrEqual(1);
    }
  });
  }

  it('keeps the cars coming up ahead of a fast player, retires the ones far behind', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 17.5 });
    const lane = azuraSouth(sim);
    const v = sim.spawnVehicle('sports', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading);
    placeInCar(sim, v);
    // Looking straight up: nothing on the ground is in view.
    sim.cam.x = v.pos.x;
    sim.cam.y = 200;
    sim.cam.z = v.pos.z;
    sim.camDir.x = 0;
    sim.camDir.y = 1;
    sim.camDir.z = 0;
    const traffic = (z: number) => {
      const c = sim.spawnVehicle('sedan', v.pos.x - 4, z, 0);
      c.owner = 'traffic';
      sim.addDriver(c, 'civilian', 'traffic');
      return c;
    };
    const coming = traffic(v.pos.z + 185);
    const behind = traffic(v.pos.z - 185);
    const stream = () => (sim.traffic as unknown as { streamTraffic(): void }).streamTraffic();
    sim.traffic.density = 0;
    // Standing still, both are just far away.
    stream();
    expect(coming.removed && behind.removed).toBe(true);
    const coming2 = traffic(v.pos.z + 185);
    const behind2 = traffic(v.pos.z - 185);
    v.vel.z = 30;
    stream();
    expect(coming2.removed).toBe(false);
    expect(behind2.removed).toBe(true);
  });

  for (const stars of [0, 2]) {
  it(`recycles cars 120-175 m behind a fast player, the furthest first and one per refresh, but none in view or nearer (${stars} stars)`, () => {
    // Round 2 fix pass (police): the 175 m far despawn alone keeps all of these; only the recycling retires them,
    // with the police after him too.
    const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 17.5 });
    const lane = azuraSouth(sim);
    const v = sim.spawnVehicle('sports', lane.sx + lane.dx * 200, lane.sz + lane.dz * 200, lane.heading);
    placeInCar(sim, v);
    sim.wanted.setLevel(stars);
    const lookUp = () => {
      sim.cam.x = v.pos.x;
      sim.cam.y = 200;
      sim.cam.z = v.pos.z;
      sim.camDir.x = 0;
      sim.camDir.y = 1;
      sim.camDir.z = 0;
    };
    lookUp();
    const traffic = (z: number) => {
      const c = sim.spawnVehicle('sedan', v.pos.x - 4, z, 0);
      c.owner = 'traffic';
      sim.addDriver(c, 'civilian', 'traffic');
      return c;
    };
    const stream = () => (sim.traffic as unknown as { streamTraffic(): void }).streamTraffic();
    sim.traffic.density = 0;
    v.vel.z = 30;
    const far = traffic(v.pos.z - 160);
    const mid = traffic(v.pos.z - 135);
    const near = traffic(v.pos.z - 100);
    stream();
    expect([far.removed, mid.removed, near.removed]).toEqual([true, false, false]);
    stream();
    expect([mid.removed, near.removed]).toEqual([true, false]);
    stream();
    expect(near.removed).toBe(false);
    // One in plain view stays, however far behind.
    const seen = traffic(v.pos.z - 150);
    sim.cam.x = seen.pos.x + 12;
    sim.cam.y = 3;
    sim.cam.z = seen.pos.z;
    sim.camDir.x = -1;
    sim.camDir.y = 0;
    sim.camDir.z = 0;
    expect(sim.isVisible(seen.pos.x, seen.pos.y, seen.pos.z)).toBe(true);
    stream();
    expect(seen.removed).toBe(false);
    lookUp();
    stream();
    expect(seen.removed).toBe(true);
    expect(near.removed).toBe(false);
  });
  }

  it('only a moving player gets cross traffic ahead, and only at junctions he has yet to reach', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 17.5 });
    const n = sim.roads.node(5, 3);
    const v = sim.spawnVehicle('sports', n.x - 2, n.z + n.halfZ + 30, 0);
    placeInCar(sim, v);
    const spans = () => (sim.traffic as unknown as { aheadSpans: Array<{ lane: Lane; s0: number; s1: number }> }).aheadSpans;
    const refresh = () => (sim.traffic as unknown as { refreshAhead(): void }).refreshAhead();
    refresh();
    expect(spans()).toEqual([]);
    v.vel.z = 30;
    for (let t = 0; t < 32; t += 0.5) {
      sim.time = t;
      refresh();
      for (const sp of spans()) {
        const node = sim.roads.nodes[sp.lane.to]!;
        // Cross streets (east-west) of junctions ahead (further south), queued 6-10 m before the line.
        expect(sp.lane.dir % 2).toBe(1);
        expect(node.z).toBeGreaterThan(v.pos.z);
        expect(node.x).toBe(n.x);
        expect(sp.lane.length - sp.s1).toBeCloseTo(6, 6);
        expect(sp.lane.length - sp.s0).toBeLessThanOrEqual(10 + 1e-9);
        // Their light turns green with at least 3 s to spare before he arrives.
        const arrive = Math.hypot(node.x - v.pos.x, node.z - v.pos.z) / 30;
        let green = false;
        for (let dt = 0; dt <= arrive - 3; dt += 0.5) if (sim.roads.signalState(node.id, 'EW', t + dt) === 'green') green = true;
        expect(green).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P21 the camera and street trees

const isTree = (q: Prop) => q.kind === 'tree' || q.kind === 'palm';
const rayHit = makeRayHit();

/** Share of the screen showing foliage, by rays through a pixel grid: building occlusion and the near-camera dissolve included. */
function foliageCover(props: PropsView, sim: Sim, cam: THREE.PerspectiveCamera, cols: number, rows: number): number {
  const foliage: THREE.Object3D[] = [];
  props.group.traverse((o) => {
    if (o instanceof THREE.InstancedMesh && (o.material as THREE.Material).onBeforeCompile.toString().includes('vFadeWorld')) foliage.push(o);
  });
  const rc = new THREE.Raycaster();
  rc.near = cam.near;
  rc.far = cam.far;
  cam.updateMatrixWorld(true);
  let sum = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      rc.setFromCamera(new THREE.Vector2(((i + 0.5) / cols) * 2 - 1, ((j + 0.5) / rows) * 2 - 1), cam);
      const o = rc.ray.origin;
      const d = rc.ray.direction;
      let w = 0;
      for (const h of rc.intersectObjects(foliage, false)) {
        const kept = smoothstep(1.2, FOLIAGE_FADE_FAR, h.distance);
        if (kept <= w) continue;
        if (sim.world.grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z, h.distance, rayHit, isSolidForSight)) break;
        w = kept;
        if (w >= 1) break;
      }
      sum += w;
    }
  }
  return sum / (cols * rows);
}

describe('the camera and street trees (P21)', () => {
  it('a new game starts with the camera clear of the street tree behind the player', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 15.5 });
    const p = sim.player;
    const boom = (yaw: number) => ({ x: p.pos.x - Math.sin(yaw) * 4.3 - Math.cos(yaw) * 0.42, z: p.pos.z - Math.cos(yaw) * 4.3 + Math.sin(yaw) * 0.42 });
    const trees = sim.world.layout.props.filter((q) => isTree(q) && Math.hypot(q.x - p.pos.x, q.z - p.pos.z) < 20);
    const clearance = (b: { x: number; z: number }) => Math.min(...trees.map((q) => Math.hypot(q.x - b.x, q.z - b.z) / q.scale));
    // The boom straight behind the player ends 1.2 m from a street tree (this is what filled the first frame with leaves).
    expect(clearance(boom(p.heading))).toBeLessThan(2.6);
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.reset(sim);
    expect(clearance(boom(cam.yaw))).toBeGreaterThanOrEqual(2.6);
    // As close to the player's heading as that allows (a quarter of a turn at most).
    expect(Math.abs(wrapAngle(cam.yaw - p.heading))).toBeLessThanOrEqual(Math.PI / 4 + 1e-9);
    for (let i = 0; i < 3; i++) cam.update(DT, sim, false);
    const c = cam.camera.position;
    for (const q of trees) {
      expect(Math.hypot(c.x - q.x, c.z - q.z), 'trunk').toBeGreaterThan(2.4 * q.scale);
      expect(Math.hypot(c.x - q.x, c.y - (q.y + 4.3 * q.scale), c.z - q.z), 'canopy').toBeGreaterThan(1.8 * q.scale);
    }
  });

  it('the first frame of a new game shows at most 5% foliage, landscape and portrait', () => {
    const props = new PropsView(world());
    for (const [w, h] of [[1280, 720], [390, 844]] as const) {
      const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 15.5 });
      const cam = new CameraController(w / h);
      cam.mode = 'play';
      cam.reset(sim);
      cam.update(DT, sim, false);
      expect(foliageCover(props, sim, cam.camera, Math.round(w / 20), Math.round(h / 20)), `${w}x${h}`).toBeLessThanOrEqual(0.05);
    }
  });

  it('away from trees the camera still resets straight behind the player', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const b = sim.world.layout.bounds;
    const p = sim.player;
    p.pos.x = b.beachStartX + 40;
    p.pos.z = (b.landMinZ + b.landMaxZ) / 2;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    p.heading = 0.7;
    expect(sim.world.layout.props.some((q) => isTree(q) && Math.hypot(q.x - p.pos.x, q.z - p.pos.z) < 12)).toBe(false);
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.reset(sim);
    expect(cam.yaw).toBe(0.7);
  });

  it('pulls in front of a tree trunk between the player and the camera', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const p = sim.player;
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    // A street tree with nothing else on the line from the player 2 m in front of it back through it.
    let tried = 0;
    for (const q of sim.world.layout.props) {
      if (q.kind !== 'tree' || tried > 40) continue;
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        p.pos.x = q.x + fx * 2 + Math.cos(yaw) * 0.21;
        p.pos.z = q.z + fz * 2 - Math.sin(yaw) * 0.21;
        p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
        if (!sim.world.isFree(p.pos.x, p.pos.z, 0.4)) continue;
        const y = p.pos.y + 1.6;
        // Without the tree the boom would reach its full length.
        if (sim.world.grid.raycast(p.pos.x, y, p.pos.z, -fx, 0, -fz, 6, rayHit, isSolidForSight)) continue;
        tried++;
        cam.reset(sim);
        cam.yaw = yaw;
        for (let i = 0; i < 40; i++) cam.update(DT, sim, false);
        const c = cam.camera.position;
        const camBack = (p.pos.x - c.x) * fx + (p.pos.z - c.z) * fz;
        // The trunk is 2 m behind the player: the camera stays in front of it.
        expect(camBack).toBeLessThan(2 - 0.2 * q.scale);
        expect(camBack).toBeGreaterThan(0.3);
        return;
      }
    }
    throw new Error('no open street tree found');
  });

  it('glides in front of a trunk instead of popping, and ignores one hugging the player', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const p = sim.player;
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    // An open street tree: put the player `gap` m in front of it, the camera looking away from it.
    const setup = (gap: number): { tree: Prop; yaw: number } | null => {
      for (const q of sim.world.layout.props) {
        if (q.kind !== 'tree') continue;
        for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
          const fx = Math.sin(yaw);
          const fz = Math.cos(yaw);
          p.pos.x = q.x + fx * gap + Math.cos(yaw) * 0.21;
          p.pos.z = q.z + fz * gap - Math.sin(yaw) * 0.21;
          p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
          if (!sim.world.isFree(p.pos.x, p.pos.z, 0.4)) continue;
          if (sim.world.grid.raycast(p.pos.x, p.pos.y + 1.6, p.pos.z, -fx, 0, -fz, 6, rayHit, isSolidForSight)) continue;
          return { tree: q, yaw };
        }
      }
      return null;
    };
    const back = (yaw: number) => (p.pos.x - cam.camera.position.x) * Math.sin(yaw) + (p.pos.z - cam.camera.position.z) * Math.cos(yaw);
    // Right behind his back: the camera stays out at its full length.
    const hug = setup(0.9)!;
    cam.reset(sim);
    cam.yaw = hug.yaw;
    for (let i = 0; i < 40; i++) cam.update(DT, sim, false);
    expect(back(hug.yaw)).toBeGreaterThan(3.8);
    // 2.5 m back: swinging the camera onto it pulls the boom in over a few frames, never in one jump.
    const far = setup(2.5)!;
    cam.reset(sim);
    cam.yaw = far.yaw + 0.6;
    for (let i = 0; i < 40; i++) cam.update(DT, sim, false);
    let prev = cam.camera.position.distanceTo(p.pos);
    let maxStep = 0;
    for (let i = 0; i < 60; i++) {
      cam.yaw = far.yaw + 0.6 * Math.max(0, 1 - i / 20);
      cam.update(DT, sim, false);
      const d = cam.camera.position.distanceTo(p.pos);
      maxStep = Math.max(maxStep, prev - d);
      prev = d;
    }
    expect(back(far.yaw)).toBeLessThan(2.5 - 0.2 * far.tree.scale);
    expect(maxStep).toBeLessThan(0.6);
  });

  it('away from trunks the boom comes back from an aim as fast as before', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const b = sim.world.layout.bounds;
    const p = sim.player;
    p.pos.x = b.beachStartX + 40;
    p.pos.z = (b.landMinZ + b.landMaxZ) / 2;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.reset(sim);
    const boom = () => cam.camera.position.distanceTo(camPriv(cam).target);
    for (let i = 0; i < 60; i++) cam.update(DT, sim, true);
    expect(boom()).toBeLessThan(2.6);
    for (let i = 0; i < 18; i++) cam.update(DT, sim, false);
    // The boom eases from 2.4 to 4.3 m at 10/s: 95% of the way in 0.3 s.
    expect(boom()).toBeGreaterThan(4.1);
  });

  it('the chase camera is not pulled in by roadside trunks', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const tree = sim.world.layout.props.find((q) => {
      if (q.kind !== 'tree') return false;
      const x = q.x;
      const z = q.z + 3.6;
      return sim.world.isFree(x, z, 1.4) && !sim.world.grid.raycast(x, 1.5, z, 0, 0.1, -1, 12, rayHit, isSolidForSight);
    })!;
    // A car 3.6 m south of the tree, facing south: the boom runs back through the trunk.
    const v = sim.spawnVehicle('sedan', tree.x, tree.z + 3.6, 0);
    placeInCar(sim, v);
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.reset(sim);
    for (let i = 0; i < 60; i++) cam.update(DT, sim, false);
    expect(v.pos.z - cam.camera.position.z).toBeGreaterThan(7);
  });

  it('with the far camera the reset clears the trees for the longer boom', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false, startHour: 15.5 });
    const p = sim.player;
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.zoomLevel = 1;
    cam.reset(sim);
    const bx = p.pos.x - Math.sin(cam.yaw) * 6.6 - Math.cos(cam.yaw) * 0.42;
    const bz = p.pos.z - Math.cos(cam.yaw) * 6.6 + Math.sin(cam.yaw) * 0.42;
    for (const q of sim.world.layout.props) if (isTree(q) && Math.hypot(q.x - p.pos.x, q.z - p.pos.z) < 20) expect(Math.hypot(q.x - bx, q.z - bz)).toBeGreaterThanOrEqual(2.6 * q.scale);
  });

  it('foliage dissolves near the camera in the colour pass only, with no extra draws', () => {
    const props = new PropsView(world());
    const foliage: THREE.InstancedMesh[] = [];
    props.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && (o.material as THREE.Material).onBeforeCompile.toString().includes('vFadeWorld')) foliage.push(o);
    });
    // Spatial cells share the same three canopy/bush/frond geometries and materials. The
    // dissolve remains one colour pass for each batch, with every foliage prop drawn once.
    expect(new Set(foliage.map((mesh) => mesh.material)).size).toBe(3);
    expect(new Set(foliage.map((mesh) => mesh.geometry)).size).toBe(3);
    const drawnProps = foliage.flatMap((mesh) => mesh.userData.propIndices as number[]).sort((a, b) => a - b);
    const expectedProps = world().layout.props.flatMap((p, i) => ['tree', 'bush', 'palm'].includes(p.kind) ? [i] : []);
    expect(drawnProps).toEqual(expectedProps);
    for (const mesh of foliage) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      expect(mat.transparent).toBe(false);
      // Shadows come from the default depth material.
      expect(mesh.customDepthMaterial).toBeUndefined();
      // The injection anchors exist in this three.js version's standard shader.
      const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
      mat.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
      expect(shader.vertexShader).toContain('vFadeWorld = ( modelMatrix * fadeWorld ).xyz;');
      expect(shader.vertexShader).toContain('instanceMatrix * fadeWorld');
      expect(shader.fragmentShader).toMatch(/fadeBayer4\( gl_FragCoord\.xy \) >= smoothstep\( 1\.20, 2\.50, fadeD \) \) discard;/);
    }
  });
});

// ---------------------------------------------------------------------------
// P89 the lighthouse beam

describe('the lighthouse beam (P89)', () => {
  it('is a soft front-face additive beam pair with a lantern glow, shown at night', () => {
    const W = world();
    const props = new PropsView(W);
    const lh = W.layout.props.find((q) => q.kind === 'lighthouse')!;
    let beam: THREE.Mesh | null = null;
    let glow: THREE.Sprite | null = null;
    let drawn = 0;
    props.group.traverse((o) => {
      if (o.name === 'lighthouseBeam') beam = o as THREE.Mesh;
      if (o.name === 'lighthouseGlow') glow = o as THREE.Sprite;
      if ((o instanceof THREE.Mesh || o instanceof THREE.Sprite) && Math.hypot(o.position.x - lh.x, o.position.z - lh.z) < 1) drawn++;
    });
    // Tower, lantern, cap and beam before; now one more (the glow): the second beam shares the mesh.
    expect(drawn).toBeLessThanOrEqual(4 + 2);
    expect(beam).not.toBeNull();
    expect(glow).not.toBeNull();
    const b = beam! as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const mat = b.material;
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    expect(mat.side).toBe(THREE.FrontSide);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.depthWrite).toBe(false);
    expect(mat.fog).toBe(true);
    // Two beams, out along local +X and -X from the lantern.
    b.geometry.computeBoundingBox();
    expect(b.geometry.boundingBox!.min.x).toBeCloseTo(-90, 3);
    expect(b.geometry.boundingBox!.max.x).toBeCloseTo(90, 3);
    props.update(10, 0.8, 0);
    expect(mat.uniforms.uNight!.value).toBe(0.8);
    expect(b.visible).toBe(true);
    expect(glow!.visible).toBe(true);
    const r0 = b.rotation.y;
    props.update(11, 0.3, 0);
    expect(mat.uniforms.uNight!.value).toBe(0.3);
    expect(b.rotation.y).not.toBe(r0);
    props.update(12, 0.02, 0);
    expect(b.visible).toBe(false);
    expect(glow!.visible).toBe(false);
    // The fragment shader fades towards the tip and the silhouette.
    expect(mat.fragmentShader).toContain('pow( 1.0 - clamp( vT, 0.0, 1.0 ), 1.5 ) * facing * facing');
    // Looking down a beam, the lantern flares; from the side it does not.
    const g = glow! as THREE.Sprite;
    const brightness = (x: number, z: number) => {
      const cam = new THREE.PerspectiveCamera();
      cam.position.set(x, 30, z);
      cam.updateMatrixWorld();
      g.onBeforeRender(null as unknown as THREE.WebGLRenderer, null as unknown as THREE.Scene, cam, null as unknown as THREE.BufferGeometry, g.material, null as unknown as THREE.Group);
      return g.material.color.r + g.material.color.g + g.material.color.b;
    };
    b.rotation.y = 0; // beams along world +-X
    const side = brightness(g.position.x, g.position.z + 120);
    const onAxis = brightness(g.position.x - 120, g.position.z);
    expect(onAxis).toBeGreaterThan(side * 3);
  });
});
