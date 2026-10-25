// Regression tests for the render cluster fixes. The render modules run headless here:
// a tiny canvas/document stub feeds the procedural textures and a fake WebGLRenderer
// stands in for WebGL, so GameRenderer itself can mirror a real Sim in Node.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { wrapAngle } from '../../src/core/math';
import { CameraController } from '../../src/render/camera';
import { Effects } from '../../src/render/effects';
import { MarkerView } from '../../src/render/markers';
import { PropsView } from '../../src/render/props';
import { GameRenderer } from '../../src/render/renderer';
import { VehicleView } from '../../src/render/vehicleView';
import { Helicopter, Pickup, Projectile, type Vehicle } from '../../src/sim/entities';
import type { Marker } from '../../src/sim/interactions';
import type { Sim } from '../../src/sim/sim';
import { WATER_Y } from '../../src/world/constants';
import type { Prop } from '../../src/world/layout';
import { axisOf, type Dir } from '../../src/world/roads';
import type { StaticWorld } from '../../src/world/staticWorld';
import { aimAt, makeSim, placeInCar, step, teleport, world } from './helpers';

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
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

const DT = 1 / 60;

function boxOf(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o);
}

function shakeOf(cam: CameraController): number {
  return (cam as unknown as { shakeAmt: number }).shakeAmt;
}

/** Local point of a vehicle view in world space. */
function worldPoint(view: VehicleView, x: number, y: number, z: number): THREE.Vector3 {
  view.group.updateMatrixWorld(true);
  return new THREE.Vector3(x, y, z).applyMatrix4(view.group.matrixWorld);
}

/** Brightest glow (emissive colour x intensity) over the front lamp meshes of a vehicle view. */
function headGlow(view: VehicleView): number {
  let best = -1;
  view.group.traverse((o) => {
    // Revised (mission 3 cars): head lamps are moulded lens meshes now (not 0.34 m boxes): the front 'lamp' meshes.
    if (!(o instanceof THREE.Mesh) || o.name !== 'lamp' || o.position.z <= 0) return;
    const m = o.material as THREE.MeshStandardMaterial;
    best = Math.max(best, m.emissiveIntensity * Math.max(m.emissive.r, m.emissive.g, m.emissive.b));
  });
  return best;
}

function visibleRockets(scene: THREE.Scene): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  scene.traverseVisible((o) => {
    if (o.name === 'rocket') out.push(o);
  });
  return out;
}

/** A clear spot on the beach, away from buildings. */
function beachSpot(sim: Sim): { x: number; z: number } {
  const b = sim.world.layout.bounds;
  return { x: b.beachStartX + 30, z: (b.landMinZ + b.landMaxZ) / 2 };
}

describe('render fixes', () => {
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

  it('traffic signal bulbs show the phase the simulation obeys (sim.time)', () => {
    const sim = makeSim({ world: W });
    attachPlay(sim);
    step(sim, 3.3);
    R.render(DT, false);
    const props = R.props as unknown as { signalBulbs: THREE.InstancedMesh; signalProps: Prop[] };
    const c = new THREE.Color();
    let mismatches = 0;
    // Lit bulbs are at least 0.7 in their own channel on every tier (far more with bloom), unlit ones 0.12.
    props.signalProps.forEach((p, i) => {
      const want = W.roads.signalState(p.node, axisOf(p.dir as Dir), sim.time);
      props.signalBulbs.getColorAt(i * 3, c);
      const red = c.r > 0.5;
      props.signalBulbs.getColorAt(i * 3 + 1, c);
      const yellow = c.r > 0.5;
      props.signalBulbs.getColorAt(i * 3 + 2, c);
      const green = c.g > 0.5;
      const shown = red ? 'red' : yellow ? 'yellow' : green ? 'green' : 'off';
      if (shown !== want) mismatches++;
    });
    expect(props.signalProps.length).toBeGreaterThan(50);
    expect(mismatches).toBe(0);
  });

  it('rockets in flight get a body pointing along their velocity and a smoke trail', () => {
    const sim = makeSim({ world: W });
    const spot = beachSpot(sim);
    teleport(sim, spot.x, spot.z);
    attachPlay(sim);
    R.render(DT, false);
    const pp = sim.playerPos();
    const rocket = new Projectile(sim.newId(), { x: pp.x, y: pp.y + 1.5, z: pp.z }, { x: 0, y: 30, z: 49.6 }, sim.player);
    sim.projectiles.push(rocket);
    const before = R.effects.particleCount;
    let frames = 0;
    for (let i = 0; i < 20; i++) {
      step(sim, DT);
      R.render(DT, false);
      if (sim.projectiles.length === 0) break;
      const views = visibleRockets(R.scene);
      expect(views.length).toBe(1);
      const v = views[0]!;
      expect(v.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(rocket.pos.x, rocket.pos.y, rocket.pos.z))).toBeLessThan(0.5);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(v.getWorldQuaternion(new THREE.Quaternion()));
      expect(fwd.dot(new THREE.Vector3(rocket.vel.x, rocket.vel.y, rocket.vel.z).normalize())).toBeGreaterThan(0.99);
      frames++;
    }
    expect(frames).toBeGreaterThan(10);
    expect(R.effects.particleCount).toBeGreaterThan(before + 10);
    // Once the sim drops the projectile its view goes away.
    rocket.life = 0.001;
    step(sim, DT);
    R.render(DT, false);
    expect(sim.projectiles.length).toBe(0);
    expect(visibleRockets(R.scene).length).toBe(0);
  });

  it('a rocket fired by the player is drawn at once, its trail starting at the launcher even at 10 fps', () => {
    const sim = makeSim({ world: W });
    const spot = beachSpot(sim);
    teleport(sim, spot.x, spot.z);
    attachPlay(sim);
    step(sim, 0.2);
    // Let every particle from earlier tests expire.
    for (let i = 0; i < 60; i++) R.render(0.1, false);
    expect(R.effects.particleCount).toBe(0);
    const p = sim.player;
    p.inventory.give('rocket', 4);
    p.inventory.current = 'rocket';
    // Wait out the weapon swap time before pulling the trigger.
    step(sim, 0.3);
    const pp = sim.playerPos();
    sim.update(0.1, aimAt(sim, { x: pp.x + 60, y: pp.y + 3, z: pp.z }, { fire: true, firePressed: true }));
    expect(sim.projectiles.length).toBe(1);
    R.render(0.1, false);
    expect(visibleRockets(R.scene).length).toBe(1);
    // The rocket is already ~5.8 m out; the gap back to the launcher is filled with smoke.
    expect(R.effects.particleCount).toBeGreaterThanOrEqual(8);
  });

  it('a distant explosion does not shake the camera; a close one still does', () => {
    const sim = makeSim({ world: W });
    attachPlay(sim);
    R.render(DT, false);
    expect(shakeOf(R.cameraCtl)).toBeLessThan(0.01);
    const cp = R.cameraCtl.camera.position;
    sim.events.emit('explosion', { x: cp.x + 500, y: cp.y, z: cp.z, radius: 7.5 });
    R.render(DT, false);
    expect(shakeOf(R.cameraCtl)).toBeLessThan(0.01);
    sim.events.emit('explosion', { x: cp.x + 6, y: cp.y, z: cp.z, radius: 7.5 });
    R.render(DT, false);
    expect(shakeOf(R.cameraCtl)).toBeGreaterThan(1);
  });

  it('camera shake freezes while paused (dt = 0) and is cleared by reset', () => {
    const sim = makeSim({ world: W });
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.reset(sim);
    cam.update(DT, sim, false);
    cam.addShake(1.5);
    cam.update(0, sim, false);
    const a = cam.camera.position.clone();
    for (let i = 0; i < 5; i++) {
      cam.update(0, sim, false);
      expect(cam.camera.position.distanceTo(a)).toBe(0);
    }
    expect(shakeOf(cam)).toBeCloseTo(1.5, 5);
    cam.update(0.5, sim, false);
    expect(shakeOf(cam)).toBeLessThan(0.2);
    cam.addShake(1);
    cam.reset(sim);
    expect(shakeOf(cam)).toBe(0);
  });

  it('hydrant spray emits nothing while paused and the same amount at any frame rate', () => {
    const paused = new Effects();
    paused.hydrantSpray(0, 0, 0);
    for (let i = 0; i < 300; i++) paused.update(0, 0);
    expect(paused.particleCount).toBe(0);
    const steady = (hz: number): number => {
      const fx = new Effects();
      fx.hydrantSpray(0, 0, 0);
      for (let i = 0; i < hz * 4; i++) fx.update(1 / hz, i / hz);
      return fx.particleCount;
    };
    const slow = steady(30);
    const fast = steady(144);
    expect(slow).toBeGreaterThan(50);
    expect(fast / slow).toBeGreaterThan(0.75);
    expect(fast / slow).toBeLessThan(1.33);
  });

  it('a knocked-over traffic signal hides its bulbs and new game restores them', () => {
    const props = new PropsView(W);
    const priv = props as unknown as { signalBulbs: THREE.InstancedMesh; signalPropIndex: number[] };
    const k = 3;
    const idx = priv.signalPropIndex[k]!;
    const read = (b: number): THREE.Matrix4 => {
      const m = new THREE.Matrix4();
      priv.signalBulbs.getMatrixAt(k * 3 + b, m);
      return m;
    };
    const standing = [0, 1, 2].map(read);
    props.breakProp(idx, 1, 0);
    for (let b = 0; b < 3; b++) expect(new THREE.Vector3().setFromMatrixScale(read(b)).length()).toBeLessThan(1e-6);
    // Other signals are untouched.
    const other = new THREE.Matrix4();
    priv.signalBulbs.getMatrixAt(0, other);
    expect(new THREE.Vector3().setFromMatrixScale(other).length()).toBeGreaterThan(0.5);
    props.restoreAll();
    for (let b = 0; b < 3; b++) expect(read(b).equals(standing[b]!)).toBe(true);
  });

  it('a car lying on its roof is drawn above the road, rotated about its body centre', () => {
    const sim = makeSim({ world: W });
    const spot = beachSpot(sim);
    const v = sim.spawnVehicle('police', spot.x, spot.z, 0.4);
    const view = new VehicleView('police');
    view.bind(v);
    view.sync(v, DT, 0, 0);
    const upright = boxOf(view.group);
    expect(upright.min.y).toBeGreaterThan(v.pos.y - 0.05);
    v.flipped = true;
    v.roll = Math.PI;
    view.sync(v, DT, 0, 0);
    const flipped = boxOf(view.group);
    expect(flipped.min.y).toBeGreaterThan(v.pos.y - 0.05);
    expect(flipped.max.y).toBeGreaterThan(v.pos.y + v.spec.height * 0.8);
    // Mid-air tumble at 90 degrees: the body stays centred over the vehicle position.
    v.roll = Math.PI / 2;
    view.sync(v, DT, 0, 0);
    const side = boxOf(view.group);
    const c = side.getCenter(new THREE.Vector3());
    expect(Math.hypot(c.x - v.pos.x, c.z - v.pos.z)).toBeLessThan(0.25);
  });

  it('body lean: squat under throttle, dive under braking, roll away from the turn', () => {
    const sim = makeSim({ world: W });
    const spot = beachSpot(sim);
    const v = sim.spawnVehicle('sedan', spot.x, spot.z, 0);
    const view = new VehicleView('sedan');
    view.bind(v);
    const L = v.spec.length / 2;
    const H = v.spec.height / 2;
    const noseUp = (): number => worldPoint(view, 0, H, L).y - worldPoint(view, 0, H, -L).y;
    for (let i = 0; i < 60; i++) {
      v.forwardSpeed += 6 * DT;
      view.sync(v, DT, 0, 0);
    }
    expect(noseUp()).toBeGreaterThan(0.05);
    for (let i = 0; i < 60; i++) {
      v.forwardSpeed -= 8 * DT;
      view.sync(v, DT, 0, 0);
    }
    expect(noseUp()).toBeLessThan(-0.05);
    // Steady right turn (steer right = heading decreasing = negative angVel); the outer side is the left (+X).
    v.forwardSpeed = 25;
    v.angVel = -0.7;
    for (let i = 0; i < 60; i++) view.sync(v, DT, 0, 0);
    const halfW = v.spec.width / 2;
    expect(worldPoint(view, halfW, H, 0).y - worldPoint(view, -halfW, H, 0).y).toBeLessThan(-0.05);
  });

  it('head lamps glow only on occupied, intact vehicles', () => {
    const sim = makeSim({ world: W });
    const spot = beachSpot(sim);
    const parked = sim.spawnVehicle('sedan', spot.x, spot.z, 0);
    const driven = sim.spawnVehicle('sedan', spot.x + 8, spot.z, 0);
    const wreck = sim.spawnVehicle('sedan', spot.x + 16, spot.z, 0);
    placeInCar(sim, driven);
    wreck.destroyed = true;
    const views = new Map<Vehicle, VehicleView>();
    for (const v of [driven, parked, wreck]) {
      const view = new VehicleView('sedan');
      view.bind(v);
      views.set(v, view);
    }
    // Driven car synced first so a shared material would leak its state into the others.
    for (const v of [driven, parked, wreck]) views.get(v)!.sync(v, DT, 0, 1);
    expect(headGlow(views.get(driven)!)).toBeGreaterThan(3);
    expect(headGlow(views.get(parked)!)).toBeLessThan(0.5);
    expect(headGlow(views.get(wreck)!)).toBeLessThan(0.05);
    // A pooled view rebound from the wreck to a fresh driven car gets working lamps back.
    const reused = views.get(wreck)!;
    reused.bind(driven);
    reused.sync(driven, DT, 0, 1);
    expect(headGlow(reused)).toBeGreaterThan(3);
  });

  it('the camera never sinks below the water surface while swimming, and keeps the swimmer in frame', () => {
    const sim = makeSim({ world: W });
    const b = sim.world.layout.bounds;
    teleport(sim, b.beachEndX + 60, (b.landMinZ + b.landMaxZ) / 2);
    step(sim, 1);
    expect(sim.player.state).toBe('swimming');
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.reset(sim);
    // Looking fully up, first plain and then holding the aim button (which swimmers cannot use).
    for (const aiming of [false, true]) {
      for (let i = 0; i < 120; i++) {
        cam.look(0, -30);
        cam.update(DT, sim, aiming);
      }
      expect(cam.camera.position.y).toBeGreaterThan(WATER_Y + 0.2);
      const p = sim.player.pos;
      const toSwimmer = new THREE.Vector3(p.x, p.y + 1.2, p.z).sub(cam.camera.position).normalize();
      const fwd = cam.camera.getWorldDirection(new THREE.Vector3());
      const halfFov = THREE.MathUtils.degToRad(cam.camera.fov / 2);
      expect(Math.acos(Math.min(1, fwd.dot(toSwimmer)))).toBeLessThan(halfFov * 0.9);
    }
  });

  it('a car that drowned in the surf neither smokes nor looks burnt out', () => {
    const sim = makeSim({ world: W });
    const b = sim.world.layout.bounds;
    const z = b.landMinZ + 150;
    const v = sim.spawnVehicle('sedan', b.beachStartX + 70, z, Math.PI / 2);
    v.pos.y = WATER_Y;
    teleport(sim, b.beachStartX + 55, z);
    step(sim, 6);
    expect(v.inWater && v.destroyed).toBe(true);
    attachPlay(sim);
    // Let every particle from earlier tests expire.
    for (let i = 0; i < 60; i++) R.render(0.1, false);
    expect(R.effects.particleCount).toBe(0);
    for (let i = 0; i < 120; i++) {
      step(sim, DT);
      R.render(DT, false);
    }
    expect(R.effects.particleCount).toBe(0);
    // It keeps its paint and tyres, unlike a wreck on land.
    const visibleMeshes = (view: VehicleView): number => {
      let n = 0;
      view.group.traverseVisible((o) => {
        if (o instanceof THREE.Mesh) n++;
      });
      return n;
    };
    const drowned = new VehicleView('sedan');
    drowned.bind(v);
    drowned.sync(v, DT, 0, 0);
    const wreck = sim.spawnVehicle('sedan', b.beachStartX + 20, z, 0);
    wreck.destroyed = true;
    const burnt = new VehicleView('sedan');
    burnt.bind(wreck);
    burnt.sync(wreck, DT, 0, 0);
    expect(visibleMeshes(drowned)).toBeGreaterThan(visibleMeshes(burnt));
  });

  it('a slow stick pan at a high frame rate holds the chase camera where the player turned it', () => {
    const sim = makeSim({ world: W });
    const spot = beachSpot(sim);
    const v = sim.spawnVehicle('sedan', spot.x, spot.z, 0);
    placeInCar(sim, v);
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.reset(sim);
    // A light right-stick deflection at 144 Hz is well under half a pixel of look per frame.
    for (let i = 0; i < 144 * 3; i++) {
      cam.look(0.3, 0);
      cam.update(1 / 144, sim, false);
    }
    expect(Math.abs((cam as unknown as { orbitYaw: number }).orbitYaw)).toBeGreaterThan(0.25);
  });

  it('the on-foot camera can pitch up far enough to hit the orbiting police helicopter', () => {
    const sim = makeSim({ world: W });
    const spot = beachSpot(sim);
    teleport(sim, spot.x, spot.z);
    step(sim, 0.2);
    const pp = sim.player.pos;
    // Where PoliceSystem parks its helicopter: 24 m out, 36 m above the ground.
    const heli = new Helicopter(sim.newId(), pp.x + 24, Math.max(sim.world.groundHeight(pp.x, pp.z), 0) + 36, pp.z);
    sim.helis.push(heli);
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.reset(sim);
    const k = 0.0024;
    for (let i = 0; i < 90; i++) {
      const c = cam.camera.position;
      const dx = heli.pos.x - c.x;
      const dy = heli.pos.y + 1.2 - c.y;
      const dz = heli.pos.z - c.z;
      const yaw = Math.atan2(dx, dz);
      const pitch = Math.atan2(dy, Math.hypot(dx, dz));
      cam.look(-wrapAngle(yaw - cam.yaw) / k, -(pitch - cam.pitch) / k);
      cam.update(DT, sim, true);
    }
    const ray = cam.aimRay();
    const hit = sim.combat.castRay(ray.origin.x, ray.origin.y, ray.origin.z, ray.dir.x, ray.dir.y, ray.dir.z, 300, sim.player);
    expect(hit.heli).toBe(0);
  });

  it('fixed objectives mark the ground and four corners while leaving the driving view through their center clear', () => {
    const view = new MarkerView();
    const objective = { x: 20, z: 30, radius: 12, color: 0x50f1d1, label: 'Gate' };
    const ground = 2.5;
    view.syncObjectives([objective], () => ground, 0);
    view.group.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    view.group.traverseVisible((object) => {
      if (object instanceof THREE.Mesh) meshes.push(object);
    });
    expect(meshes.length).toBeGreaterThan(0);
    // Both road directions stay open at driver and chase-camera heights. The old
    // filled seven-metre cylinder intersected all four of these sight lines.
    for (const height of [1.5, 3.5]) {
      for (const direction of [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)]) {
        const origin = new THREE.Vector3(objective.x, ground + height, objective.z).addScaledVector(direction, -objective.radius * 2);
        const ray = new THREE.Raycaster(origin, direction, 0, objective.radius * 4);
        expect(ray.intersectObjects(meshes, false)).toEqual([]);
      }
    }
    let groundVertices = 0;
    const corners = new Set<string>();
    const vertex = new THREE.Vector3();
    for (const mesh of meshes) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      expect(material.opacity).toBeGreaterThan(0);
      expect(material.color.getHex()).toBe(objective.color);
      const positions = mesh.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        vertex.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
        const x = vertex.x - objective.x;
        const z = vertex.z - objective.z;
        const y = vertex.y - ground;
        const radius = Math.hypot(x, z);
        if (y > 0.05 && y < 0.25 && radius > objective.radius * 0.9) groundVertices++;
        if (y > 3.5) {
          expect(radius).toBeGreaterThan(objective.radius * 0.9);
          expect(radius).toBeLessThan(objective.radius * 1.1);
          corners.add(`${Math.sign(x)},${Math.sign(z)}`);
        }
      }
    }
    expect(groundVertices).toBeGreaterThan(32);
    expect(corners).toEqual(new Set(['1,1', '1,-1', '-1,1', '-1,-1']));
  });

  it('objective pools reuse meshes, geometry and materials while updating radius, ground height and independent colours', () => {
    const view = new MarkerView();
    const first = { x: 20, z: 30, radius: 12, color: 0x50f1d1, label: 'Gate' };
    const second = { x: 60, z: 80, radius: 8, color: 0xffd23d, label: 'Finish' };
    view.syncObjectives([first, second], () => 2, 0);
    const groups = [...view.group.children];
    const meshes = groups.map((group) => [...group.children] as THREE.Mesh[]);
    expect(groups).toHaveLength(2);
    expect(meshes[0]!.length).toBeGreaterThan(0);
    const geometries = meshes.map((list) => list.map((mesh) => mesh.geometry));
    const materials = meshes.map((list) => list.map((mesh) => mesh.material));
    expect(geometries[0]).toHaveLength(geometries[1]!.length);
    for (let i = 0; i < geometries[0]!.length; i++) expect(geometries[0]![i]).toBe(geometries[1]![i]);
    // Per-objective colours must not leak through the shared geometry.
    for (const mesh of meshes[0]!) expect((mesh.material as THREE.MeshBasicMaterial).color.getHex()).toBe(first.color);
    for (const mesh of meshes[1]!) expect((mesh.material as THREE.MeshBasicMaterial).color.getHex()).toBe(second.color);
    view.syncObjectives([], () => 0, 1);
    expect(view.group.children).toEqual(groups);
    expect(groups.every((group) => !group.visible)).toBe(true);

    const next = { ...first, x: -40, z: 90, radius: 6, color: 0xff3b3b };
    view.syncObjectives([next], () => 4, 2);
    expect(view.group.children).toEqual(groups);
    expect(groups[0]!.visible).toBe(true);
    expect(groups[1]!.visible).toBe(false);
    expect(groups[0]!.position.toArray()).toEqual([-40, 4, 90]);
    expect(groups[0]!.scale.toArray()).toEqual([6, 1, 6]);
    for (let group = 0; group < groups.length; group++) {
      expect(groups[group]!.children).toEqual(meshes[group]);
      for (let i = 0; i < meshes[group]!.length; i++) {
        const mesh = meshes[group]![i]!;
        expect(mesh.geometry).toBe(geometries[group]![i]);
        expect(mesh.material).toBe(materials[group]![i]);
        expect((mesh.material as THREE.MeshBasicMaterial).color.getHex()).toBe(group === 0 ? next.color : second.color);
      }
    }
  });

  it('entity objectives retain their moving overhead arrow and hide it when the target is removed', () => {
    const sim = makeSim({ world: W, police: false });
    const car = sim.spawnVehicle('sports', 20, 30, 0);
    const view = new MarkerView();
    const objective = { x: 0, z: 0, radius: 4, color: 0xff3b3b, label: 'Suspect', vehicle: car };
    view.syncObjectives([objective], () => 0, 0);
    expect(view.group.children).toHaveLength(1);
    const arrow = view.group.children[0] as THREE.Mesh;
    expect(arrow.geometry).toBeInstanceOf(THREE.ConeGeometry);
    expect(arrow.visible).toBe(true);
    expect(arrow.position.x).toBe(car.pos.x);
    expect(arrow.position.z).toBe(car.pos.z);
    expect(arrow.position.y).toBeGreaterThan(car.pos.y + car.spec.height);
    car.pos.x += 10;
    car.pos.z -= 5;
    view.syncObjectives([objective], () => 0, 1);
    expect(view.group.children[0]).toBe(arrow);
    expect(arrow.position.x).toBe(car.pos.x);
    expect(arrow.position.z).toBe(car.pos.z);
    car.removed = true;
    view.syncObjectives([objective], () => 0, 2);
    expect(arrow.visible).toBe(false);
  });

  it('pickup, marker and helicopter views reuse their geometry when they come back', () => {
    const mv = new MarkerView();
    const pickup = new Pickup(1, 'health', { x: 0, y: 0, z: 0 }, 25, null, 30, '');
    const marker: Marker = { id: 'save:1', kind: 'save', x: 4, z: 4, radius: 1.5, label: '', color: 0x55ccff, ref: '' };
    const geos = new Set<string>();
    const collect = (): number => {
      let n = 0;
      mv.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          geos.add(o.geometry.uuid);
          n++;
        }
      });
      return n;
    };
    let meshes = 0;
    for (let i = 0; i < 6; i++) {
      mv.syncPickups([pickup], i, 0, 0);
      mv.syncMarkers([marker], i);
      mv.syncHelis([new Helicopter(100 + i, 0, 30, 0)], 1, () => 0);
      meshes = collect();
      if (i === 0) expect(geos.size).toBeGreaterThan(3);
      mv.syncPickups([pickup], i, 5000, 5000);
      mv.syncMarkers([], i);
      mv.syncHelis([], 1, () => 0);
    }
    expect(meshes).toBeGreaterThan(3);
    const afterOne = geos.size;
    // A seventh round must not add a single new geometry.
    mv.syncPickups([pickup], 7, 0, 0);
    mv.syncMarkers([marker], 7);
    mv.syncHelis([new Helicopter(200, 0, 30, 0)], 1, () => 0);
    collect();
    expect(geos.size).toBe(afterOne);
    // ...and six rounds used no more geometries than a single view set needs.
    expect(afterOne).toBeLessThanOrEqual(meshes);
  });
});
