// Round 2, fix pass 3, cluster "actors": the camera with the player's back to a wall, to his car's or bus's side or
// to raised ground over the water; characters dissolving at the lens; markers on a walk-through; trunk cuts for a
// player standing still; the drawn gun on a shot's own frame and on a clip's last round; sports-car drivers' arms.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CameraController } from '../../src/render/camera';
import { CrowdView, LENS_FADE_FULL, LENS_FADE_GONE } from '../../src/render/crowd';
import { MarkerView } from '../../src/render/markers';
import { cabinLayout, VehicleView } from '../../src/render/vehicleView';
import type { Character, Vehicle } from '../../src/sim/entities';
import { SKELETON, WEAPON_POINTS } from '../../src/sim/pose';
import { Sim } from '../../src/sim/sim';
import { VEHICLE_SPECS, type VehicleKind, type WeaponId } from '../../src/sim/specs';
import { isSolidForSight, makeRayHit } from '../../src/world/colliders';
import { WATER_Y } from '../../src/world/constants';
import type { Prop } from '../../src/world/layout';
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

const DT = 1 / 60;
const sightHit = makeRayHit();

type Part = { mesh: THREE.InstancedMesh; n: number };
const parts = (cv: CrowdView) => (cv as unknown as { parts: Record<string, Part> }).parts;
const gunPart = (cv: CrowdView, gun: WeaponId) => (cv as unknown as { weapons: Map<WeaponId, Part> }).weapons.get(gun)!;
const matrixOf = (p: Part, i: number): THREE.Matrix4 => {
  const m = new THREE.Matrix4();
  p.mesh.getMatrixAt(i, m);
  return m;
};

/** Frames of play as the game runs them: the crosshair ray from rayFor, the sim, the camera, then the crowd. */
function play(sim: Sim, cam: CameraController, crowd: CrowdView | null, seconds: number, inp = input(), aiming = false, each?: (frame: number) => void): void {
  const frames = Math.round(seconds / DT);
  for (let k = 0; k < frames; k++) {
    const i = { ...inp, cameraYaw: cam.yaw };
    const r = cam.rayFor();
    i.aimOrigin = r.origin;
    i.aimDir = r.dir;
    sim.update(DT, i);
    cam.update(DT, sim, aiming);
    crowd?.sync([sim.player], cam.camera.position.x, cam.camera.position.z, DT);
    each?.(k);
  }
}

/** A camera in play (not the title flyover). */
function playCamera(): CameraController {
  const cam = new CameraController(16 / 9);
  cam.mode = 'play';
  return cam;
}

/** The centre of the player's drawn head (the only character drawn). */
function headCentre(crowd: CrowdView): THREE.Vector3 {
  return new THREE.Vector3(0, 0.15, 0).applyMatrix4(matrixOf(parts(crowd).head!, 0));
}

/** Where on the frame (NDC) a point lies, and whether it is in it. */
function onScreen(cam: THREE.PerspectiveCamera, p: THREE.Vector3): { x: number; y: number; ok: boolean } {
  cam.updateMatrixWorld(true);
  const s = p.clone().project(cam);
  return { x: s.x, y: s.y, ok: s.z > -1 && s.z < 1 && Math.abs(s.x) <= 1 && Math.abs(s.y) <= 1 };
}

/** The lowest the segment from a to b comes over the terrain (decks and ramps included), sampled every 2 cm. */
function clearance(w: StaticWorld, a: THREE.Vector3, b: THREE.Vector3): number {
  const n = Math.max(2, Math.ceil(a.distanceTo(b) / 0.02));
  let low = Infinity;
  const q = new THREE.Vector3();
  for (let i = 1; i < n; i++) {
    q.copy(a).lerp(b, i / n);
    low = Math.min(low, q.y - w.groundHeight(q.x, q.z));
  }
  return low;
}

/** The middle of a building's south face (tier 0) with open ground 6 m out in front of it and no prop within 7 m. */
function openSouthFace(w: StaticWorld): { x: number; z: number } {
  for (const b of w.layout.buildings) {
    const t = b.tiers[0];
    if (!t || t.maxX - t.minX < 8) continue;
    const x = (t.minX + t.maxX) / 2;
    const z = t.maxZ;
    let open = true;
    for (let dz = 0.36; dz <= 6 && open; dz += 0.4) for (const dx of [-3, -1.5, 0, 1.5, 3]) if (!w.isFree(x + dx, z + dz, 0.35)) open = false;
    if (!open || w.layout.props.some((q) => Math.hypot(q.x - x, q.z - z) < 7)) continue;
    // The wall is really there, right behind him.
    if (!w.grid.raycast(x, w.groundHeight(x, z + 1) + 1.6, z + 1, 0, 0, -1, 1.2, sightHit, isSolidForSight)) continue;
    return { x, z };
  }
  throw new Error('no open south face');
}

// ---------------------------------------------------------------------------
// Issue 1: a wall right behind the player, his car or bus alongside a wall

describe('the camera with his back to a wall, and his car parked against one', () => {
  it('every character material dissolves whatever is nearer the lens than its near plane could cut cleanly', () => {
    const near = new CameraController(16 / 9).camera.near;
    // Gone well before the near plane would slice a box open, whole again a little further out.
    expect(LENS_FADE_GONE).toBeGreaterThanOrEqual(near + 0.1);
    expect(LENS_FADE_FULL).toBeGreaterThan(LENS_FADE_GONE);
    const crowd = new CrowdView();
    let meshes = 0;
    crowd.group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh)) return;
      meshes++;
      const mat = o.material as THREE.MeshStandardMaterial;
      // The physical shader every MeshStandardMaterial compiles to, through the material's hook.
      const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
      mat.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
      const fs = shader.fragmentShader;
      // By depth along the view (the near plane's own measure), dithered between the two depths, before any lighting.
      expect(fs).toMatch(new RegExp(`vViewPosition\\.z < ${LENS_FADE_FULL.toFixed(2)}.*smoothstep\\( ${LENS_FADE_GONE.toFixed(2)}, ${LENS_FADE_FULL.toFixed(2)}, vViewPosition\\.z \\)\\s*\\)\\s*discard`));
      expect(fs.indexOf('discard;')).toBeLessThan(fs.indexOf('#include <lights_fragment_begin>'));
      expect(fs.indexOf('float lensBayer4')).toBeGreaterThan(0);
      // A faded player keeps his shadow: the depth material has no lens fade (revised for track D, which gives the
      // crowd a depth material carrying the per-character fade-in and fade-out only).
      const depth = o.customDepthMaterial;
      if (depth) {
        const ds = { vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
        depth.onBeforeCompile(ds, undefined as unknown as THREE.WebGLRenderer);
        expect(ds.fragmentShader).not.toContain('vViewPosition.z <');
        expect(ds.fragmentShader).toContain('vInstanceFade');
      }
      expect(o.castShadow).toBe(true);
    });
    expect(meshes).toBeGreaterThanOrEqual(16);
  });

  it('with his back to a wall the camera rises over his shoulder, clear of his head and in front of the wall', () => {
    const W = world();
    const face = openSouthFace(W);
    for (const [gap, aim] of [[0.45, false], [0.36, false], [0.36, true], [0.8, false], [1.2, false]] as const) {
      const sim = new Sim({ world: W, ambient: false, police: false, startHour: 12 });
      const p = sim.player;
      p.pos.x = face.x;
      p.pos.z = face.z + gap;
      p.pos.y = W.groundHeight(p.pos.x, p.pos.z);
      p.heading = 0;
      const cam = playCamera();
      cam.reset(sim);
      cam.yaw = 0;
      cam.pitch = -0.12;
      const crowd = new CrowdView();
      play(sim, cam, crowd, 1, input({ aim }), aim);
      const label = `${gap} m from the wall${aim ? ', aiming' : ''}`;
      expect(Math.abs(p.pos.z - (face.z + gap)), label).toBeLessThan(0.02);
      const c = cam.camera.position;
      const head = headCentre(crowd);
      // Out of his head (it was 0.42 m from its centre, the near plane slicing it open), and on his side of the wall,
      // which is behind the lens, out of its view.
      expect(c.distanceTo(head), label).toBeGreaterThan(0.6);
      expect(c.z - face.z, label).toBeGreaterThan(0);
      // Over his shoulder and above his head, still looking where he looks.
      expect(c.y - head.y, label).toBeGreaterThan(gap < 1 ? 0.2 : 0.1);
      const dir = cam.camera.getWorldDirection(new THREE.Vector3());
      expect(Math.abs(Math.atan2(dir.x, dir.z)), label).toBeLessThan(1e-6);
      // The crosshair ray rebuilt for the next frame is the view this frame drew.
      const ray = cam.rayFor();
      expect(Math.hypot(ray.origin.x - c.x, ray.origin.y - c.y, ray.origin.z - c.z), label).toBeLessThan(1e-6);
      expect(Math.hypot(ray.dir.x - dir.x, ray.dir.y - dir.y, ray.dir.z - dir.z), label).toBeLessThan(1e-6);
    }
  });

  /** A west face of a building tier with `length` m of open ground along it and 4 m out, at its middle. */
  function openWestFace(w: StaticWorld, length: number): { x: number; z: number } {
    for (const b of w.layout.buildings) {
      const t = b.tiers[0];
      if (!t || t.maxZ - t.minZ < length + 2) continue;
      const x = t.minX;
      const z = (t.minZ + t.maxZ) / 2;
      let open = true;
      for (let dx = 0.3; dx <= 4 && open; dx += 0.5) for (let dz = -length / 2; dz <= length / 2 && open; dz += 1) if (!w.isFree(x - dx, z + dz, 0.3)) open = false;
      if (!open || w.layout.props.some((q) => Math.abs(q.z - z) < length / 2 + 3 && q.x < x && q.x > x - 6)) continue;
      return { x, z };
    }
    throw new Error('no open west face');
  }

  /** The camera's offset from the middle of `v`'s box, in its body frame (heading 0: +x is its left, +z ahead). */
  function inBody(v: Vehicle, c: THREE.Vector3): { x: number; y: number; z: number } {
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const dx = c.x - v.pos.x;
    const dz = c.z - v.pos.z;
    return { x: dx * fz - dz * fx, y: c.y - v.pos.y, z: dx * fx + dz * fz };
  }

  it.each(['sedan', 'sports', 'pickup', 'van', 'bus'] as const)('a %s parked against a wall: orbited toward it, or tilted up with its tail to one, the camera stays out of the body', (kind: VehicleKind) => {
    const W = world();
    for (const setup of ['side 0.1', 'side 0.4', 'rear 0.1 tilt', 'rear 0.1'] as const) {
      const sim = new Sim({ world: W, ambient: false, police: false, startHour: 12 });
      const spec = VEHICLE_SPECS[kind];
      const gap = setup.includes('0.4') ? 0.4 : 0.1;
      let x: number;
      let z: number;
      if (setup.startsWith('side')) {
        // Facing south (+z), its left side (+x) gap m off a west face.
        const f = openWestFace(W, spec.length + 2);
        x = f.x - gap - spec.width / 2;
        z = f.z;
      } else {
        // Facing south (+z), its tail gap m off a south face.
        const f = openSouthFace(W);
        x = f.x;
        z = f.z + gap + spec.length / 2;
      }
      const v = sim.spawnVehicle(kind, x, z, 0);
      placeInCar(sim, v);
      const cam = playCamera();
      cam.reset(sim);
      cam.update(DT, sim, false);
      // Mouse look: a quarter turn toward the wall on its left, or the view tilted all the way up.
      if (setup.startsWith('side')) cam.look(Math.PI / 2 / 0.0024, 0);
      else if (setup.endsWith('tilt')) cam.look(0, -300);
      for (let k = 0; k < 40; k++) {
        v.vel.x = 0;
        v.vel.z = 0;
        sim.update(DT, input({ handbrake: true, cameraYaw: cam.yaw }));
        cam.update(DT, sim, false);
      }
      const label = `${kind} ${setup}`;
      expect(Math.hypot(v.pos.x - x, v.pos.z - z), label).toBeLessThan(0.05);
      const c = cam.camera.position;
      const l = inBody(v, c);
      // Outside the body grown by more than the near plane (0.3 m): beside it, behind it or over its roof.
      const out = Math.max(Math.abs(l.x) - v.halfW, Math.abs(l.z) - v.halfL, l.y - v.spec.height);
      expect(out, `${label}: camera at ${JSON.stringify(l)}`).toBeGreaterThan(0.3);
      // And never through the wall it backed up to.
      if (setup.startsWith('side')) expect(x + v.halfW + gap - c.x, label).toBeGreaterThan(0.25);
      else expect(c.z - (z - v.halfL - gap), label).toBeGreaterThan(0.25);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue 2: raised ground (a quay over the sea, a deck) between the camera and a swimmer

describe('in the water with his back to a quay, the pier or a marina deck, the player stays in view', () => {
  /**
   * Plays `seconds` from now and counts the frames from `after` s on in which his drawn head is out of the frame, the
   * line from the camera to it dips into the terrain, or it is near enough the lens to be dissolving.
   */
  function watch(sim: Sim, cam: CameraController, crowd: CrowdView, seconds: number, inp = input(), after = 0, turn?: (frame: number) => void): { frames: number; hidden: number; worst: string } {
    let frames = 0;
    let hidden = 0;
    let worst = '';
    let low = Infinity;
    play(sim, cam, crowd, seconds, inp, false, (k) => {
      turn?.(k);
      if ((k + 1) * DT <= after) return;
      frames++;
      const head = headCentre(crowd);
      const c = cam.camera.position;
      const clear = clearance(sim.world, c, head);
      const s = onScreen(cam.camera, head);
      if (clear <= 0 || !s.ok || c.distanceTo(head) < LENS_FADE_FULL + 0.15) {
        hidden++;
        if (clear < low) {
          low = clear;
          worst = `frame ${k}: line ${clear.toFixed(3)} m over the ground, head at (${s.x.toFixed(2)}, ${s.y.toFixed(2)}), ${c.distanceTo(head).toFixed(2)} m off`;
        }
      }
    });
    return { frames, hidden, worst };
  }

  /** A swimmer `d` m off a quay or deck edge with his back to it (heading `back`), the camera looking the same way. */
  function swimmerAt(x: number, z: number, heading: number): { sim: Sim; cam: CameraController; crowd: CrowdView } {
    const sim = makeSim({ world: world(), police: false });
    sim.cheats.godMode = true;
    const p = sim.player;
    p.pos.x = x;
    p.pos.z = z;
    p.pos.y = WATER_Y - 1.3;
    p.state = 'swimming';
    p.heading = heading;
    const cam = playCamera();
    cam.reset(sim);
    cam.yaw = heading;
    cam.pitch = -0.12;
    const crowd = new CrowdView();
    return { sim, cam, crowd };
  }

  /** The west quay (land from landMinX east) and a marina deck whose east edge is at x = 594 (deck to its west). */
  const SITES = () => {
    const W = world();
    const b = W.layout.bounds;
    const deck = W.layout.decks.find((q) => q.name === 'Marina' && Math.abs(q.rect.maxX - 594) < 1e-6 && q.rect.minZ < 465.5 && q.rect.maxZ > 465.5)!;
    expect(deck).toBeDefined();
    // Water too deep to stand in right off both edges.
    expect(W.groundHeight(b.landMinX - 0.05, 140)).toBeLessThan(WATER_Y - 1.5);
    expect(W.groundHeight(594.05, 465.5)).toBeLessThan(WATER_Y - 1.5);
    return [
      { name: 'quay', at: (d: number) => ({ x: b.landMinX - d, z: 140 }), back: -Math.PI / 2 },
      { name: 'deck', at: (d: number) => ({ x: 594 + d, z: 465.5 }), back: Math.PI / 2 },
    ];
  };

  it('treading water 0.05 to 3 m off the edge, his back to it, and while the view turns round him', () => {
    for (const site of SITES()) {
      for (const d of [0.05, 0.2, 0.5, 1, 2, 3]) {
        const at = site.at(d);
        const { sim, cam, crowd } = swimmerAt(at.x, at.z, site.back);
        const r = watch(sim, cam, crowd, 1.5, input(), 0.5);
        expect(sim.player.state).toBe('swimming');
        expect(r.hidden, `${site.name} ${d} m: ${r.worst}`).toBe(0);
      }
      // A slow look all the way round from 1 m out: the view sweeps over the edge and back, the camera gliding as it rises
      // and sinks (r2_fix4_actors): no frame turns the view by more than twice the pan's own step.
      const at = site.at(1);
      const { sim, cam, crowd } = swimmerAt(at.x, at.z, site.back);
      play(sim, cam, crowd, 0.5);
      const step = (2 * Math.PI) / 240;
      const last = cam.camera.getWorldDirection(new THREE.Vector3());
      const dir = new THREE.Vector3();
      let worst = 0;
      const r = watch(sim, cam, crowd, 4, input(), 0, () => {
        worst = Math.max(worst, cam.camera.getWorldDirection(dir).angleTo(last));
        last.copy(dir);
        cam.look(-step / 0.0024, 0);
      });
      expect(r.hidden, `${site.name} pan: ${r.worst}`).toBe(0);
      expect(THREE.MathUtils.radToDeg(worst), `${site.name} pan`).toBeLessThan(THREE.MathUtils.radToDeg(2 * step));
    }
  });

  it('rising over the edge, the camera stays under anything solid overhead', () => {
    // A fresh city: a slab 1.6-2.2 m up reaching out over the quay edge behind a swimmer 1 m out (an eave, a storey).
    const sim = makeSim({ police: false });
    sim.cheats.godMode = true;
    const b = sim.world.layout.bounds;
    sim.world.grid.addBox(b.landMinX - 0.5, 130, b.landMinX + 8, 150, 1.6, 2.2, 'wall');
    const p = sim.player;
    p.pos.x = b.landMinX - 1;
    p.pos.z = 140;
    p.pos.y = WATER_Y - 1.3;
    p.state = 'swimming';
    p.heading = -Math.PI / 2;
    const cam = playCamera();
    cam.reset(sim);
    cam.yaw = -Math.PI / 2;
    cam.pitch = -0.12;
    play(sim, cam, new CrowdView(), 1);
    const c = cam.camera.position;
    expect(c.x).toBeGreaterThan(b.landMinX - 0.5);
    expect(c.y).toBeLessThanOrEqual(1.6 - 0.29);
    // And the crosshair ray rebuilt for the next frame starts there.
    const ray = cam.rayFor();
    expect(Math.hypot(ray.origin.x - c.x, ray.origin.y - c.y, ray.origin.z - c.z)).toBeLessThan(1e-6);
  });

  it('getting out of a car parked along the quay, its driver side over the sea: he steps out onto the quay, in sight', () => {
    const sim = makeSim({ world: world(), police: false });
    sim.cheats.godMode = true;
    const b = sim.world.layout.bounds;
    const v = sim.spawnVehicle('sedan', b.landMinX + 1.6, 100, Math.PI);
    placeInCar(sim, v);
    const cam = playCamera();
    cam.reset(sim);
    const crowd = new CrowdView();
    play(sim, cam, crowd, 0.5);
    play(sim, cam, crowd, DT, input({ enterExit: true }));
    play(sim, cam, crowd, 1);
    const p = sim.player;
    // The exit on the dry side (combat's findExitSpot): on the quay, not in the sea against its wall.
    expect(p.vehicle).toBeNull();
    expect(p.state).toBe('normal');
    expect(p.pos.x).toBeGreaterThan(b.landMinX + 0.3);
    const r = watch(sim, cam, crowd, 3, input({ moveZ: 1 }), 0.3);
    expect(r.hidden, r.worst).toBe(0);
  });

  it('swimming along the quay wall a hand off it, the quay on his right: the camera takes his left shoulder, over the sea', () => {
    for (const z of [100, 140]) {
      // Northward, the camera behind him: his right shoulder is over the quay, whose edge the line to his head clipped
      // in every frame with the camera kept there.
      const { sim, cam, crowd } = swimmerAt(world().layout.bounds.landMinX - 0.1, z, Math.PI);
      const r = watch(sim, cam, crowd, 4, input({ moveZ: 1 }), 0.5);
      const p = sim.player;
      expect(p.state, `z ${z}`).toBe('swimming');
      expect(z - p.pos.z, `z ${z}`).toBeGreaterThan(8);
      expect(world().layout.bounds.landMinX - p.pos.x, `z ${z}`).toBeCloseTo(0.1, 2);
      expect(r.hidden, `z ${z}: ${r.worst}`).toBe(0);
      // Over his left shoulder.
      const c = cam.camera.position;
      expect(c.x, `z ${z}`).toBeLessThan(p.pos.x - 0.2);
    }
  });

  it('walking off the quay into the sea and swimming on, and wading beside the pier', () => {
    const sim = makeSim({ world: world(), police: false });
    sim.cheats.godMode = true;
    const b = sim.world.layout.bounds;
    const p = sim.player;
    p.pos.x = b.landMinX + 3;
    p.pos.z = 140;
    p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
    p.heading = -Math.PI / 2;
    const cam = playCamera();
    cam.reset(sim);
    cam.yaw = -Math.PI / 2;
    cam.pitch = -0.12;
    const crowd = new CrowdView();
    // In and about 2 m out.
    let splash = -1;
    play(sim, cam, crowd, 2, input({ moveZ: 1 }), false, (k) => {
      if (splash < 0 && p.state === 'swimming') splash = k;
    });
    expect(splash).toBeGreaterThan(0);
    const r = watch(sim, cam, crowd, 2, input(), 0);
    expect(p.state).toBe('swimming');
    expect(b.landMinX - p.pos.x).toBeGreaterThan(1);
    expect(r.hidden, r.worst).toBe(0);
    // Waist deep beside the Azura Pier, his back to its deck.
    const pier = sim.world.layout.decks.find((q) => q.name === 'Azura Pier')!;
    for (const off of [60, 67]) {
      for (const d of [0.5, 1, 2]) {
        const s2 = makeSim({ world: world(), police: false });
        const w = s2.player;
        w.pos.x = b.beachStartX + off;
        w.pos.z = pier.rect.maxZ + d;
        w.pos.y = s2.world.groundHeight(w.pos.x, w.pos.z);
        w.heading = 0;
        expect(w.pos.y).toBeLessThan(WATER_Y - 0.3);
        const c2 = playCamera();
        c2.reset(s2);
        c2.yaw = 0;
        c2.pitch = -0.12;
        const cr2 = new CrowdView();
        const r2 = watch(s2, c2, cr2, 1, input(), 0.5);
        expect(w.state, `${off} ${d}`).toBe('normal');
        expect(r2.hidden, `wading ${off} m out, ${d} m off the pier: ${r2.worst}`).toBe(0);
      }
    }
  });

  it('on land, raised ground behind him stops the boom as a wall does: his back to the top of a stunt ramp', () => {
    const W = world();
    // The west promenade ramp climbs north (heading PI) to its 2.2 m lip.
    const ramp = W.layout.ramps.find((q) => Math.abs(q.heading - Math.PI) < 1e-6 && q.x < W.layout.bounds.landMinX + 30)!;
    expect(ramp).toBeDefined();
    const lipZ = ramp.z - ramp.length / 2;
    for (const d of [0.4, 1, 2]) {
      const sim = new Sim({ world: W, ambient: false, police: false, startHour: 12 });
      const p = sim.player;
      p.pos.x = ramp.x;
      p.pos.z = lipZ - d;
      p.pos.y = W.groundHeight(p.pos.x, p.pos.z);
      p.heading = Math.PI;
      const cam = playCamera();
      cam.reset(sim);
      cam.yaw = Math.PI;
      cam.pitch = -0.12;
      const crowd = new CrowdView();
      play(sim, cam, crowd, 1);
      const c = cam.camera.position;
      const head = headCentre(crowd);
      // Not up on the ramp looking over its lip at nothing: in front of it, with the line to his head clear.
      expect(c.z, `${d} m`).toBeLessThan(lipZ);
      expect(clearance(W, c, head), `${d} m`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Low: walking through an interaction marker

describe('an interaction marker he walks through fades out behind him instead of vanishing', () => {
  it('at a walk, a run and a sprint, the camera 4.3 m behind him: no frame changes the beam by more than 0.05', () => {
    const view = new MarkerView();
    const m = { id: 'save:t', kind: 'save' as const, x: 0, z: 0, radius: 1.5, label: '', color: 0x55ccff, ref: '' };
    for (const speed of [2, 4, 7]) {
      let prev = -1;
      let worst = 0;
      let at = '';
      let drawn = 0;
      // Along +z through the marker's middle, the camera behind his right shoulder; then far out of it.
      for (let i = 0; i <= Math.ceil((14 * 60) / speed); i++) {
        const pz = -4 + (speed * i) / 60;
        const cam = { x: -0.42, y: 2.3, z: pz - 4.3 };
        view.syncMarkers([m], i / 60, cam, { x: 0, z: pz });
        const g = view.group.children[0]!;
        const a = g.visible ? ((g.getObjectByName('beam') as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity : 0;
        if (a > 0.27) drawn++;
        if (prev >= 0 && Math.abs(a - prev) > worst) {
          worst = Math.abs(a - prev);
          at = `${pz.toFixed(2)} m: ${prev.toFixed(3)} -> ${a.toFixed(3)}`;
        }
        prev = a;
      }
      expect(worst, `${speed} m/s, worst at ${at}`).toBeLessThanOrEqual(0.05);
      // Still drawn in full while he is in it, and gone once he and the camera are well past.
      expect(drawn, `${speed} m/s`).toBeGreaterThan(0);
      expect(prev, `${speed} m/s`).toBe(0.28);
    }
    // In it with the camera right on top of it: in full. A step outside, still most of it with the camera behind him as
    // on that walk, but none of it with the camera right on top of it (r2_fix4_actors); 1 m outside, gone.
    const above = { x: -0.42, y: 2.3, z: -1 };
    const alpha = (pz: number, cam = above): number => {
      view.syncMarkers([m], 0, cam, { x: 0, z: pz });
      const g = view.group.children[0]!;
      return g.visible ? ((g.getObjectByName('beam') as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity : 0;
    };
    expect(alpha(1.1)).toBe(0.28);
    expect(alpha(1.6, { x: -0.42, y: 2.3, z: 1.6 - 4.3 })).toBeGreaterThan(0.2);
    expect(alpha(1.6)).toBe(0);
    expect(alpha(2.6)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Low: a trunk left between the camera and a player who stepped away from it and stands still

describe('a trunk he stepped away from does not stay between the camera and him', () => {
  /** Open, isolated street trees with a clear way 0.9-3 m out from them in some axis direction, and no wall behind. */
  function picks(W: StaticWorld): Array<{ q: Prop; yaw: number }> {
    const out: Array<{ q: Prop; yaw: number }> = [];
    const trunks = W.layout.props.filter((q) => q.kind === 'tree' || q.kind === 'palm');
    for (const q of trunks) {
      if (q.kind !== 'tree' || q.scale > 1.05 || trunks.some((o) => o !== q && Math.hypot(o.x - q.x, o.z - q.z) < 4)) continue;
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        let ok = true;
        for (let D = 0.9; D <= 3.0 && ok; D += 0.3) if (!W.isFree(q.x + fx * D, q.z + fz * D, 0.45)) ok = false;
        const ox = q.x + fx * 2;
        const oz = q.z + fz * 2;
        if (!ok || W.grid.raycast(ox, W.groundHeight(ox, oz) + 1.6, oz, -fx, 0, -fz, 6, sightHit, isSolidForSight)) continue;
        out.push({ q, yaw });
        break;
      }
      if (out.length >= 16) break;
    }
    return out;
  }

  /** Does the drawn trunk (a little inside its base radius) cross the line from the camera to (px, py, pz)? */
  function blocks(cam: THREE.Vector3, px: number, py: number, pz: number, q: Prop): boolean {
    const r = 0.26 * q.scale * 0.85;
    const dx = px - cam.x;
    const dz = pz - cam.z;
    const t = Math.max(0, Math.min(1, ((q.x - cam.x) * dx + (q.z - cam.z) * dz) / (dx * dx + dz * dz)));
    const y = cam.y + (py - cam.y) * t;
    return Math.hypot(cam.x + dx * t - q.x, cam.z + dz * t - q.z) < r && y < q.y + 3.2 * q.scale && t > 0.02 && t < 0.98;
  }

  it('his back to a street tree 1 m off, he steps out to 2-2.2 m and stands: within half a second it is out of the way', () => {
    const W = world();
    const trees = picks(W);
    expect(trees.length).toBeGreaterThanOrEqual(8);
    const sim = new Sim({ world: W, ambient: false, police: false, startHour: 12 });
    const p = sim.player;
    let cases = 0;
    const blocked: string[] = [];
    for (const { q, yaw } of trees) {
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const rx = -Math.cos(yaw);
      const rz = Math.sin(yaw);
      for (const lat of [-0.3, 0, 0.3, 0.6, 0.9]) {
        for (const D of [2.0, 2.1, 2.2]) {
          const place = (d: number) => {
            p.pos.x = q.x + fx * d - rx * lat;
            p.pos.z = q.z + fz * d - rz * lat;
            p.pos.y = W.groundHeight(p.pos.x, p.pos.z);
            p.heading = yaw;
          };
          place(D);
          if (!W.isFree(p.pos.x, p.pos.z, 0.35)) continue;
          place(1.0);
          if (!W.isFree(p.pos.x, p.pos.z, 0.35)) continue;
          const cam = playCamera();
          cam.reset(sim);
          cam.yaw = yaw;
          cam.pitch = -0.12;
          for (let i = 0; i < 60; i++) cam.update(DT, sim, false);
          // A small look round first, as a player does: the trunk's hysteresis is armed.
          for (let i = 0; i < 20; i++) {
            cam.yaw = yaw + 0.03 * Math.sin((2 * Math.PI * i) / 20);
            cam.update(DT, sim, false);
          }
          cam.yaw = yaw;
          for (let i = 1; i <= 30; i++) {
            place(1.0 + ((D - 1.0) * i) / 30);
            cam.update(DT, sim, false);
          }
          for (let i = 0; i < 30; i++) cam.update(DT, sim, false);
          cases++;
          if (blocks(cam.camera.position, p.pos.x, p.pos.y + 1.2, p.pos.z, q)) blocked.push(`tree ${q.x.toFixed(1)},${q.z.toFixed(1)} yaw ${yaw.toFixed(2)} lat ${lat} D ${D}`);
        }
      }
    }
    expect(cases).toBeGreaterThan(100);
    expect(blocked, blocked.slice(0, 5).join('; ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Low: the drawn gun on the frame of a shot, and on a clip's last round

describe('on the frame a shot is fired the gun is drawn where the shot left it', () => {
  const GUNS = ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'] as const;

  /** The barrel end of the one `gun` CrowdView draws. */
  const drawnTip = (cv: CrowdView, gun: (typeof GUNS)[number]): THREE.Vector3 => {
    const t = WEAPON_POINTS[gun].tip;
    return new THREE.Vector3(t.x, t.y, t.z).applyMatrix4(matrixOf(gunPart(cv, gun), 0));
  };

  /** The middle of a long straight lane with nothing static near it (props knocked over), facing along it. */
  function openRoad(sim: Sim): { x: number; z: number; h: number } {
    for (const pr of sim.world.grid.colliders) if (pr.breakable || pr.tag === 'tree' || pr.tag === 'palm') pr.broken = true;
    for (const lane of sim.roads.lanes) {
      if (lane.length < 60) continue;
      const x = lane.sx + (lane.dx * lane.length) / 2;
      const z = lane.sz + (lane.dz * lane.length) / 2;
      const rx = -Math.cos(lane.heading);
      const rz = Math.sin(lane.heading);
      let open = true;
      for (let a = -10; a <= 24 && open; a++) for (let l = -4; l <= 4 && open; l++) open = sim.world.isFree(x + lane.dx * a + rx * l, z + lane.dz * a + rz * l, 0.5);
      if (open) return { x, z, h: lane.heading };
    }
    throw new Error('no open road');
  }

  it("the player's shots with every gun, a clip's last round too: the flash and the tracer leave the barrel end as drawn", () => {
    for (const gun of GUNS) {
      for (const last of [false, true]) {
        const sim = makeSim({ police: false });
        sim.cheats.godMode = true;
        const r = openRoad(sim);
        const p = sim.player;
        p.pos.x = r.x;
        p.pos.z = r.z;
        p.pos.y = sim.world.groundHeight(r.x, r.z);
        p.heading = r.h;
        p.inventory.give(gun, 50);
        p.inventory.current = gun;
        p.inventory.slot().clip = last ? 1 : Math.min(3, p.inventory.spec().mag);
        const cam = playCamera();
        cam.reset(sim);
        cam.yaw = r.h;
        cam.pitch = -0.05;
        const crowd = new CrowdView();
        play(sim, cam, crowd, 0.8, input({ aim: true }), true);
        const fired: Array<{ x: number; y: number; z: number }> = [];
        sim.events.on('weaponFired', (e) => {
          if (e.shooter === p) fired.push(e);
        });
        play(sim, cam, crowd, DT, input({ aim: true, fire: true, firePressed: true }), true);
        const label = `${gun}${last ? ', last round' : ''}`;
        expect(fired.length, label).toBe(1);
        if (last) expect(p.reloadTimer, label).toBeGreaterThan(0);
        const e = fired[0]!;
        expect(drawnTip(crowd, gun).distanceTo(new THREE.Vector3(e.x, e.y, e.z)), label).toBeLessThan(0.02);
        // The kick comes in on the next frame (and a last round's reload once the shot is drawn).
        play(sim, cam, crowd, DT, input({ aim: true }), true);
        expect(drawnTip(crowd, gun).distanceTo(new THREE.Vector3(e.x, e.y, e.z)), label).toBeGreaterThan(0.02);
        if (last) {
          play(sim, cam, crowd, 6 * DT, input({ aim: true }), true);
          expect(drawnTip(crowd, gun).distanceTo(new THREE.Vector3(e.x, e.y, e.z)), label).toBeGreaterThan(0.1);
        }
      }
    }
  });

  it("an NPC's shots with every gun, a clip's last round too, the frame drawn as the sim leaves it", () => {
    for (const gun of GUNS) {
      for (const last of [false, true]) {
        const sim = makeSim({ police: false });
        sim.cheats.godMode = true;
        const r = openRoad(sim);
        const p = sim.player;
        p.pos.x = r.x;
        p.pos.z = r.z;
        p.pos.y = sim.world.groundHeight(r.x, r.z);
        const fx = Math.sin(r.h);
        const fz = Math.cos(r.h);
        const cop = sim.spawnCharacter('cop', r.x - fx * 6, r.z - fz * 6);
        cop.owner = 'mission';
        cop.persistent = true;
        cop.heading = r.h;
        cop.inventory.give(gun, 50);
        cop.inventory.current = gun;
        cop.drawnWeapon = gun;
        cop.inventory.slot().clip = last ? 1 : 3;
        cop.inventory.infinite = false;
        const crowd = new CrowdView();
        // The frame before: drawn, gun lowered.
        crowd.sync([cop], cop.pos.x, cop.pos.z, DT);
        const fired: Array<{ x: number; y: number; z: number }> = [];
        sim.events.on('weaponFired', (e) => {
          if (e.shooter === cop) fired.push(e);
        });
        sim.combat.npcFire(cop, p, 1);
        // Sim.updateTimers runs later in the same frame.
        cop.shotTimer -= DT;
        if (cop.reloadTimer > 0) cop.reloadTimer -= DT;
        crowd.sync([cop], cop.pos.x, cop.pos.z, DT);
        const label = `${gun}${last ? ', last round' : ''}`;
        expect(fired.length, label).toBe(1);
        if (last) expect(cop.reloadTimer, label).toBeGreaterThan(0);
        const e = fired[0]!;
        expect(drawnTip(crowd, gun).distanceTo(new THREE.Vector3(e.x, e.y, e.z)), label).toBeLessThan(0.02);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Low: sports-car drivers' arms

describe('a driver holds the wheel with his elbows bent, whatever his height and car', () => {
  const SEE_THROUGH: VehicleKind[] = ['compact', 'sedan', 'taxi', 'police', 'sports', 'muscle', 'pickup'];

  it.each(SEE_THROUGH)('the driver of a %s, 0.9 to 1.07 tall, capped or not: hands on the rim, elbows bent 30 degrees or more', (kind) => {
    const layout = cabinLayout(kind)!;
    for (const height of [0.9, 1, 1.02, 1.07]) {
      for (const hat of [0, 0x222222]) {
        const sim = makeSim({ world: world() });
        const b = sim.world.layout.bounds;
        const v = sim.spawnVehicle(kind, b.beachStartX + 30, (b.landMinZ + b.landMaxZ) / 2, 0);
        const view = new VehicleView(kind);
        view.bind(v);
        view.sync(v, DT, 0, 0);
        view.group.updateMatrixWorld(true);
        const c = sim.spawnCharacter('civilian', v.pos.x, v.pos.z) as Character;
        Object.assign(c.appearance, { build: 1.05, height, hat });
        sim.seat(c, v, 0);
        const cv = new CrowdView();
        cv.sync([c], v.pos.x, v.pos.z, DT);
        const label = `${kind}, ${height}${hat ? ' capped' : ''}`;
        const w = layout.wheel;
        for (let i = 0; i < 2; i++) {
          const up = new THREE.Vector3().setFromMatrixColumn(matrixOf(parts(cv).upperArm!, i), 1).normalize();
          const fore = new THREE.Vector3().setFromMatrixColumn(matrixOf(parts(cv).forearm!, i), 1).normalize();
          const bend = THREE.MathUtils.radToDeg(up.angleTo(fore));
          expect(bend, `${label} arm ${i}`).toBeGreaterThanOrEqual(30);
          // The hand on its rim point (quarter to three, the wheel straight), in the body frame as drawn.
          const hand = new THREE.Vector3().setFromMatrixPosition(matrixOf(parts(cv).hand!, i));
          const rim = new THREE.Vector3(w.x + (i === 0 ? 1 : -1) * w.radius, w.y, w.z).applyMatrix4(view.group.matrix);
          expect(hand.distanceTo(rim), `${label} hand ${i}`).toBeLessThan(0.01);
        }
        // The shoulders reach it from a seat leaning back no further than the car needs (the reach the arms bend over).
        const reach = (SKELETON.upperArm + SKELETON.forearm + SKELETON.hand) * height;
        expect(reach, label).toBeGreaterThan(0.5);
      }
    }
  });
});
