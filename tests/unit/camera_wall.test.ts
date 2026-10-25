// The on-foot camera with no room behind the player (his back to a wall downtown, in a narrow alley, in a garage and
// its corner): it rises and looks down over his shoulder so that he stays drawn whole, instead of dissolving at the
// lens, and it glides there, aiming or not (the crosshair ray stays the view drawn). Elsewhere (an open street, a trunk
// behind him, the sniper's scope) it frames him as before.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CameraController, raisedView } from '../../src/render/camera';
import { CrowdView, LENS_FADE_FULL } from '../../src/render/crowd';
import type { PlayerInput } from '../../src/sim/input';
import { Sim } from '../../src/sim/sim';
import { isSolidForSight, makeRayHit } from '../../src/world/colliders';
import type { StaticWorld } from '../../src/world/staticWorld';
import { input, world } from './helpers';

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
const REST = -0.12;
const sightHit = makeRayHit();

/**
 * How much of the player CrowdView draws in the frame: every vertex of his drawn parts, those inside the frame, and of
 * those the ones nearer the lens (by depth along the view, as the shader measures it) than LENS_FADE_FULL, which it
 * dissolves.
 */
function drawn(crowd: CrowdView, cam: THREE.PerspectiveCamera): { total: number; inFrame: number; dissolving: number } {
  cam.updateMatrixWorld(true);
  crowd.group.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const q = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const out = { total: 0, inFrame: 0, dissolving: 0 };
  crowd.group.traverse((o) => {
    // (Revised, mission 3 effects: his body only. A modelled gun has some 20 times the vertices of the old box gun and
    // would outweigh the body in these vertex fractions.)
    if (!(o instanceof THREE.InstancedMesh) || o.count === 0 || o.name.startsWith('gun-')) return;
    const pos = o.geometry.getAttribute('position');
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      m.premultiply(o.matrixWorld);
      for (let k = 0; k < pos.count; k++) {
        v.fromBufferAttribute(pos, k).applyMatrix4(m);
        out.total++;
        const depth = -q.copy(v).applyMatrix4(cam.matrixWorldInverse).z;
        const s = q.copy(v).project(cam);
        if (depth <= cam.near || Math.abs(s.x) > 1 || Math.abs(s.y) > 1) continue;
        out.inFrame++;
        if (depth < LENS_FADE_FULL) out.dissolving++;
      }
    }
  });
  return out;
}

/** The fraction of the drawn parts `names`' vertices in the frame and not dissolving at the lens (nearer than LENS_FADE_FULL). */
function readable(crowd: CrowdView, cam: THREE.PerspectiveCamera, names: string[]): Record<string, number> {
  cam.updateMatrixWorld(true);
  crowd.group.updateMatrixWorld(true);
  const parts = (crowd as unknown as { parts: Record<string, { mesh: THREE.InstancedMesh }> }).parts;
  const v = new THREE.Vector3();
  const q = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const out: Record<string, number> = {};
  for (const name of names) {
    const mesh = parts[name]!.mesh;
    const pos = mesh.geometry.getAttribute('position');
    let ok = 0;
    for (let k = 0; k < pos.count; k++) {
      mesh.getMatrixAt(0, m);
      m.premultiply(mesh.matrixWorld);
      v.fromBufferAttribute(pos, k).applyMatrix4(m);
      const depth = -q.copy(v).applyMatrix4(cam.matrixWorldInverse).z;
      const s = q.copy(v).project(cam);
      if (depth >= LENS_FADE_FULL && Math.abs(s.x) <= 1 && Math.abs(s.y) <= 1) ok++;
    }
    out[name] = ok / pos.count;
  }
  return out;
}

/** A camera in play (not the title flyover). */
function playCamera(): CameraController {
  const cam = new CameraController(16 / 9);
  cam.mode = 'play';
  return cam;
}

interface Run {
  sim: Sim;
  cam: CameraController;
  crowd: CrowdView;
}

/** The player at (x, z) facing `heading`, the camera reset behind him and looking `off` rad round from his heading. */
function standAt(w: StaticWorld, x: number, z: number, heading: number, off = 0, pitch = REST): Run {
  const sim = new Sim({ world: w, ambient: false, police: false, startHour: 12 });
  const p = sim.player;
  p.pos.x = x;
  p.pos.z = z;
  p.pos.y = w.groundHeight(x, z);
  p.heading = heading;
  p.inventory.give('pistol', 50);
  p.inventory.current = 'pistol';
  const cam = playCamera();
  cam.reset(sim);
  cam.yaw = heading + off;
  cam.pitch = pitch;
  return { sim, cam, crowd: new CrowdView() };
}

/** One frame as the game runs it: the crosshair ray from rayFor, the sim, the camera, then the crowd. */
function frame(r: Run, over: Partial<PlayerInput> = {}, aiming = false, dt = DT): void {
  const ray = r.cam.rayFor();
  r.sim.update(dt, input({ ...over, cameraYaw: r.cam.yaw, aimOrigin: ray.origin, aimDir: ray.dir }));
  r.cam.update(dt, r.sim, aiming);
  r.crowd.sync([r.sim.player], r.cam.camera.position.x, r.cam.camera.position.z, dt);
}

const viewPitch = (cam: CameraController) => Math.asin(cam.camera.getWorldDirection(new THREE.Vector3()).y);

/** The drawn head's centre (the only character drawn). */
function headCentre(crowd: CrowdView): THREE.Vector3 {
  const m = new THREE.Matrix4();
  (crowd as unknown as { parts: Record<string, { mesh: THREE.InstancedMesh }> }).parts.head!.mesh.getMatrixAt(0, m);
  return new THREE.Vector3(0, 0.15, 0).applyMatrix4(m);
}

/** What every framing must keep: no solid between his head and the lens, and the crosshair ray is the view drawn. */
function expectSoundView(r: Run, label: string): void {
  const c = r.cam.camera.position;
  const head = headCentre(r.crowd);
  const to = c.clone().sub(head);
  const L = to.length();
  expect(r.sim.world.grid.raycast(head.x, head.y, head.z, to.x / L, to.y / L, to.z / L, L, sightHit, isSolidForSight), `${label}: a solid between his head and the lens`).toBe(false);
  const ray = r.cam.rayFor();
  const dir = r.cam.camera.getWorldDirection(new THREE.Vector3());
  expect(Math.hypot(ray.origin.x - c.x, ray.origin.y - c.y, ray.origin.z - c.z), label).toBeLessThan(1e-6);
  expect(Math.hypot(ray.dir.x - dir.x, ray.dir.y - dir.y, ray.dir.z - dir.z), label).toBeLessThan(1e-6);
  // Still looking the way the view's yaw does.
  expect(Math.abs(Math.atan2(Math.sin(Math.atan2(dir.x, dir.z) - r.cam.yaw), Math.cos(Math.atan2(dir.x, dir.z) - r.cam.yaw))), label).toBeLessThan(1e-6);
}

interface Face {
  side: string;
  x: number;
  z: number;
  ox: number;
  oz: number;
}

/** Faces of building tiers (two a side) with open ground 6 m out in front of their middle and no prop near. */
function openFaces(w: StaticWorld): Face[] {
  const out: Face[] = [];
  const count: Record<string, number> = { N: 0, S: 0, E: 0, W: 0 };
  for (const b of w.layout.buildings) {
    const t = b.tiers[0];
    if (!t) continue;
    for (const side of ['N', 'S', 'E', 'W'] as const) {
      if (count[side]! >= 2) continue;
      const alongX = side === 'N' || side === 'S';
      if ((alongX ? t.maxX - t.minX : t.maxZ - t.minZ) < 8) continue;
      const x = side === 'W' ? t.minX : side === 'E' ? t.maxX : (t.minX + t.maxX) / 2;
      const z = side === 'N' ? t.minZ : side === 'S' ? t.maxZ : (t.minZ + t.maxZ) / 2;
      const ox = side === 'W' ? -1 : side === 'E' ? 1 : 0;
      const oz = side === 'N' ? -1 : side === 'S' ? 1 : 0;
      let open = true;
      for (let o = 0.36; o <= 6 && open; o += 0.4) for (const a of [-3, -1.5, 0, 1.5, 3]) if (!w.isFree(x + ox * o + (alongX ? a : 0), z + oz * o + (alongX ? 0 : a), 0.35)) open = false;
      if (!open || w.layout.props.some((q) => Math.hypot(q.x - x, q.z - z) < 7)) continue;
      if (!w.grid.raycast(x + ox, w.groundHeight(x + ox, z + oz) + 1.6, z + oz, -ox, 0, -oz, 1.2, sightHit, isSolidForSight)) continue;
      out.push({ side, x, z, ox, oz });
      count[side]!++;
    }
  }
  return out;
}

/** Alleys: gaps of 1.8 to 4 m between two buildings' tier-0 walls (running north-south), 8 m long or more. */
function alleys(w: StaticWorld): Array<{ west: number; east: number; z: number }> {
  const rects = w.layout.buildings.map((b) => b.tiers[0]).filter((t) => t !== undefined);
  const out: Array<{ west: number; east: number; z: number }> = [];
  for (const a of rects) {
    for (const b of rects) {
      const gap = b.minX - a.maxX;
      if (gap < 1.8 || gap > 4) continue;
      const z0 = Math.max(a.minZ, b.minZ);
      const z1 = Math.min(a.maxZ, b.maxZ);
      if (z1 - z0 < 8) continue;
      const z = (z0 + z1) / 2;
      if (!w.isFree(a.maxX + 0.4, z, 0.35) || !w.isFree(b.minX - 0.4, z, 0.35)) continue;
      out.push({ west: a.maxX, east: b.minX, z });
    }
  }
  return out;
}

describe('raisedView: the look pitch mapped so the rest pitch frames him from above', () => {
  it('is the look itself with no tilt, keeps both ends of the look, puts the rest pitch on `rest` and always turns the way the look does', () => {
    for (let p = -1.25; p <= 1.35; p += 0.01) expect(raisedView(p, REST)).toBeCloseTo(p, 12);
    for (const rest of [-0.4, -0.8, -0.93, -1.2]) {
      expect(raisedView(-1.25, rest)).toBeCloseTo(-1.25, 12);
      expect(raisedView(1.35, rest)).toBeCloseTo(1.35, 12);
      expect(raisedView(REST, rest)).toBeCloseTo(rest, 12);
      let last = -Infinity;
      for (let p = -1.25; p <= 1.35; p += 0.005) {
        const v = raisedView(p, rest);
        expect(v, `rest ${rest}, pitch ${p}`).toBeGreaterThan(last);
        // No jump anywhere: the steepest slope is the upper half's.
        if (last > -Infinity) expect(v - last).toBeLessThan(0.005 * ((1.35 - rest) / (1.35 - REST)) + 1e-9);
        last = v;
      }
    }
    // Never tilts up.
    expect(raisedView(0.2, 0.3)).toBeCloseTo(0.2, 12);
  });
});

describe('his back to a wall, the camera rises over his shoulder and he stays drawn whole', () => {
  it('downtown faces facing every way, 0.36 to 1.2 m off, the view straight out or turned up to a radian either way', () => {
    const W = world();
    const faces = openFaces(W);
    expect(faces.length).toBe(8);
    let cases = 0;
    for (const f of faces) {
      for (const gap of [0.36, 0.45, 0.8, 1.2]) {
        for (const off of [0, -0.5, 0.5, -1, 1]) {
          const r = standAt(W, f.x + f.ox * gap, f.z + f.oz * gap, Math.atan2(f.ox, f.oz), off);
          for (let k = 0; k < 60; k++) frame(r);
          const label = `${f.side} face, ${gap} m, view ${off} rad`;
          const p = r.sim.player;
          expect(Math.hypot(p.pos.x - (f.x + f.ox * gap), p.pos.z - (f.z + f.oz * gap)), label).toBeLessThan(0.05);
          const d = drawn(r.crowd, r.cam.camera);
          // Whole: at most 2% of what is in the frame dissolving (it was all of it, 0.36 m off).
          expect(d.dissolving, `${label}: ${JSON.stringify(d)}`).toBeLessThanOrEqual(0.02 * d.inFrame);
          // And in the frame: all of him looking straight out, most of him with the view turned along the wall.
          expect(d.inFrame / d.total, `${label}: ${JSON.stringify(d)}`).toBeGreaterThan(off === 0 ? 0.7 : 0.45);
          // On his side of the wall.
          const c = r.cam.camera.position;
          expect((c.x - f.x) * f.ox + (c.z - f.z) * f.oz, label).toBeGreaterThan(0);
          expectSoundView(r, label);
          cases++;
        }
      }
    }
    expect(cases).toBe(160);
  });

  it('in narrow alleys, his back to either wall', () => {
    const W = world();
    const list = alleys(W).slice(0, 6);
    expect(list.length).toBe(6);
    for (const a of list) {
      for (const [x, heading] of [[a.west + 0.4, Math.PI / 2], [a.east - 0.4, -Math.PI / 2]] as const) {
        for (const off of [0, 0.6, -0.6]) {
          const r = standAt(W, x, a.z, heading, off);
          for (let k = 0; k < 60; k++) frame(r);
          const label = `alley ${a.west.toFixed(1)}..${a.east.toFixed(1)} at z ${a.z.toFixed(1)}, facing ${heading > 0 ? 'east' : 'west'}, view ${off}`;
          const d = drawn(r.crowd, r.cam.camera);
          expect(d.dissolving, `${label}: ${JSON.stringify(d)}`).toBeLessThanOrEqual(0.02 * d.inFrame);
          expect(d.inFrame / d.total, `${label}: ${JSON.stringify(d)}`).toBeGreaterThan(0.45);
          // Between the alley's walls.
          const c = r.cam.camera.position;
          expect(c.x, label).toBeGreaterThan(a.west);
          expect(c.x, label).toBeLessThan(a.east);
          expectSoundView(r, label);
        }
      }
    }
  });

  it('inside each garage, his back to its back wall and in its back corners, under its roof', () => {
    const W = world();
    expect(W.layout.garages.length).toBeGreaterThanOrEqual(4);
    let cases = 0;
    for (const g of W.layout.garages) {
      const rc = g.rect;
      // Inward from the back wall (opposite the opening), and the inside of the walls.
      const n = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[g.side] as [number, number];
      const inner = { minX: rc.minX + 0.5, maxX: rc.maxX - 0.5, minZ: rc.minZ + 0.5, maxZ: rc.maxZ - 0.5 };
      const cx = (rc.minX + rc.maxX) / 2;
      const cz = (rc.minZ + rc.maxZ) / 2;
      const face = { x: n[0] !== 0 ? (n[0] > 0 ? inner.minX : inner.maxX) : cx, z: n[1] !== 0 ? (n[1] > 0 ? inner.minZ : inner.maxZ) : cz };
      const heading = Math.atan2(n[0], n[1]);
      const right = { x: -Math.cos(heading), z: Math.sin(heading) };
      // Half the inside's width, less the 0.4 m he stands off a side wall.
      const across = 5 - 0.4;
      for (const along of [0, across, -across]) {
        const x = face.x + n[0] * 0.4 + right.x * along;
        const z = face.z + n[1] * 0.4 + right.z * along;
        expect(W.isFree(x, z, 0.35), `${g.poi} ${along}`).toBe(true);
        for (const off of [0, 0.6, -0.6]) {
          const r = standAt(W, x, z, heading, off);
          for (let k = 0; k < 60; k++) frame(r);
          const label = `${g.poi}, ${along === 0 ? 'back wall' : along > 0 ? 'right corner' : 'left corner'}, view ${off}`;
          const d = drawn(r.crowd, r.cam.camera);
          expect(d.dissolving, `${label}: ${JSON.stringify(d)}`).toBeLessThanOrEqual(0.02 * d.inFrame);
          expect(d.inFrame / d.total, `${label}: ${JSON.stringify(d)}`).toBeGreaterThan(0.45);
          const c = r.cam.camera.position;
          expect(c.x > inner.minX && c.x < inner.maxX && c.z > inner.minZ && c.z < inner.maxZ, `${label}: camera ${c.toArray()}`).toBe(true);
          expect(c.y, label).toBeLessThan(r.sim.player.pos.y + g.height - 0.3);
          // Looking straight out, clear of the side walls by more than the near plane's half-width (0.36 m): nearer, the
          // frame's edge showed through the wall.
          for (const s of off === 0 ? [1, -1] : []) {
            const ry = r.cam.yaw;
            expect(W.grid.raycast(c.x, c.y, c.z, -Math.cos(ry) * s, 0, Math.sin(ry) * s, 0.4, sightHit, isSolidForSight), `${label}: a wall 0.4 m to the ${s > 0 ? 'right' : 'left'}`).toBe(false);
          }
          expectSoundView(r, label);
          cases++;
        }
      }
    }
    expect(cases).toBe(W.layout.garages.length * 9);
  });
});

describe('getting there glides, and he never dissolves on the way', () => {
  /**
   * Plays `frames` frames with the input `each` gives, from frame `from` on noting the most the camera moves in a frame
   * along the ground (`slide`) and up or down (`rise`), the most the view's pitch turns in a frame, the most of him
   * dissolving and the least of him in the frame (fractions of his vertices).
   */
  function track(r: Run, frames: number, each: (k: number) => Partial<PlayerInput>, from = 0): { slide: number; rise: number; tilt: number; dissolving: number; lowest: number } {
    const last = new THREE.Vector3().copy(r.cam.camera.position);
    let lastPitch = viewPitch(r.cam);
    const out = { slide: 0, rise: 0, tilt: 0, dissolving: 0, lowest: 1 };
    for (let k = 0; k < frames; k++) {
      frame(r, each(k));
      const c = r.cam.camera.position;
      const v = viewPitch(r.cam);
      if (k >= from) {
        out.slide = Math.max(out.slide, Math.hypot(c.x - last.x, c.z - last.z));
        out.rise = Math.max(out.rise, Math.abs(c.y - last.y));
        out.tilt = Math.max(out.tilt, Math.abs(v - lastPitch));
        const d = drawn(r.crowd, r.cam.camera);
        out.dissolving = Math.max(out.dissolving, d.dissolving / d.total);
        out.lowest = Math.min(out.lowest, d.inFrame / d.total);
      }
      last.copy(c);
      lastPitch = v;
    }
    return out;
  }

  it('walking backward into a wall: the camera rises and tilts as he comes, without a jump, and he stays whole and in the frame', () => {
    const W = world();
    for (const f of openFaces(W).slice(0, 4)) {
      const r = standAt(W, f.x + f.ox * 5, f.z + f.oz * 5, Math.atan2(f.ox, f.oz));
      for (let k = 0; k < 30; k++) frame(r);
      // Backing up (the view stays put), then standing against the wall.
      const t = track(r, 180, (k) => ({ moveZ: k < 120 ? -1 : 0 }));
      const p = r.sim.player;
      expect((p.pos.x - f.x) * f.ox + (p.pos.z - f.z) * f.oz, f.side).toBeLessThan(0.5);
      // Along the ground the boom moves as before: the wall stop takes it 0.3 m short of the wall as it reaches it.
      expect(t.slide, `${f.side}: ${JSON.stringify(t)}`).toBeLessThan(0.31);
      // The rise and the tilt glide (the camera used to stay level, and all but his legs dissolved, 40% of him).
      expect(t.rise, `${f.side}: ${JSON.stringify(t)}`).toBeLessThan(0.1);
      expect(t.tilt, `${f.side}: ${JSON.stringify(t)}`).toBeLessThan(0.1);
      expect(t.dissolving, `${f.side}: ${JSON.stringify(t)}`).toBeLessThan(0.03);
      // For a frame or two as he arrives he passes under the lens, until the wall stop lets it back its last 0.3 m.
      expect(t.lowest, `${f.side}: ${JSON.stringify(t)}`).toBeGreaterThan(0.2);
    }
  });

  it('turning the view across the wall behind him, and up and down, he stays whole', () => {
    const W = world();
    const f = openFaces(W)[1]!;
    const heading = Math.atan2(f.ox, f.oz);
    const pan = standAt(W, f.x + f.ox * 0.36, f.z + f.oz * 0.36, heading, -1.3);
    for (let k = 0; k < 30; k++) frame(pan);
    const t = track(pan, 100, () => {
      pan.cam.look(-0.026 / 0.0024, 0);
      return {};
    });
    expect(t.dissolving, JSON.stringify(t)).toBeLessThan(0.03);
    expect(t.tilt, JSON.stringify(t)).toBeLessThan(0.1);
    const tilt = standAt(W, f.x + f.ox * 0.36, f.z + f.oz * 0.36, heading, 0, -1.2);
    for (let k = 0; k < 30; k++) frame(tilt);
    const u = track(tilt, 140, () => {
      tilt.cam.look(0, -0.02 / 0.0024);
      return {};
    });
    expect(u.dissolving, JSON.stringify(u)).toBeLessThan(0.03);
    // The view turns with the look, never against it, and reaches the top of the look.
    expect(u.tilt, JSON.stringify(u)).toBeLessThan(0.06);
    expect(viewPitch(tilt.cam)).toBeGreaterThan(1.3);
  });

  it('starting to aim against the wall keeps him framed from above without a jump, and paused it holds still', () => {
    const W = world();
    const f = openFaces(W)[2]!;
    const r = standAt(W, f.x + f.ox * 0.36, f.z + f.oz * 0.36, Math.atan2(f.ox, f.oz));
    for (let k = 0; k < 60; k++) frame(r);
    const raised = viewPitch(r.cam);
    expect(raised).toBeLessThan(-0.7);
    const at = r.cam.camera.position.clone();
    for (let k = 0; k < 10; k++) frame(r, {}, false, 0);
    expect(r.cam.camera.position.distanceTo(at)).toBeLessThan(1e-9);
    expect(viewPitch(r.cam)).toBeCloseTo(raised, 9);
    let last = raised;
    let most = 0;
    let moved = 0;
    let prev = r.cam.camera.position.clone();
    for (let k = 0; k < 90; k++) {
      frame(r, { aim: true }, true);
      const v = viewPitch(r.cam);
      most = Math.max(most, Math.abs(v - last));
      last = v;
      moved = Math.max(moved, r.cam.camera.position.distanceTo(prev));
      prev = r.cam.camera.position.clone();
      expectSoundView(r, `aiming, frame ${k}`);
      const seen = readable(r.crowd, r.cam.camera, ['head', 'torso']);
      expect(seen.head, `frame ${k}`).toBeGreaterThan(0.98);
      expect(seen.torso, `frame ${k}`).toBeGreaterThan(0.98);
    }
    // Neither the view nor the camera jumps as the aim narrows the field of view and draws the boom in.
    expect(most).toBeLessThan(0.1);
    expect(moved).toBeLessThan(0.3);
    expect(last).toBeLessThan(-0.7);
  });
});

describe('aiming with his back to a wall keeps his head and torso in the frame', () => {
  /** Settles `r` aiming for 90 frames and checks what every aimed framing must keep. */
  function settleAim(r: Run, label: string, off: number): void {
    for (let k = 0; k < 90; k++) frame(r, { aim: true }, true);
    const seen = readable(r.crowd, r.cam.camera, ['head', 'torso']);
    expect(seen.head, `${label}: ${JSON.stringify(seen)}`).toBeGreaterThan(off === 0 ? 0.99 : 0.9);
    // (Turned toward a corner the torso's far side may leave the frame, as the whole body does unaimed.)
    expect(seen.torso, `${label}: ${JSON.stringify(seen)}`).toBeGreaterThan(off === 0 ? 0.9 : 0.4);
    const d = drawn(r.crowd, r.cam.camera);
    expect(d.dissolving, `${label}: ${JSON.stringify(d)}`).toBeLessThanOrEqual(0.02 * d.inFrame);
    expectSoundView(r, label);
    expect(r.cam.scoped, label).toBe(false);
  }

  it('downtown faces facing every way, 0.36 to 1.2 m off, the view straight out or turned half a radian', () => {
    const W = world();
    let cases = 0;
    for (const f of openFaces(W)) {
      for (const gap of [0.36, 0.8, 1.2]) {
        for (const off of [0, -0.5, 0.5]) {
          const r = standAt(W, f.x + f.ox * gap, f.z + f.oz * gap, Math.atan2(f.ox, f.oz), off);
          settleAim(r, `${f.side} face, ${gap} m, view ${off} rad`, off);
          cases++;
        }
      }
    }
    expect(cases).toBe(72);
  });

  it('in narrow alleys, his back to either wall', () => {
    const W = world();
    const list = alleys(W).slice(0, 6);
    expect(list.length).toBe(6);
    for (const a of list) {
      for (const [x, heading] of [[a.west + 0.4, Math.PI / 2], [a.east - 0.4, -Math.PI / 2]] as const) {
        for (const off of [0, 0.5, -0.5]) {
          const r = standAt(W, x, a.z, heading, off);
          settleAim(r, `alley ${a.west.toFixed(1)}..${a.east.toFixed(1)} at z ${a.z.toFixed(1)}, facing ${heading > 0 ? 'east' : 'west'}, view ${off}`, off);
          const c = r.cam.camera.position;
          expect(c.x).toBeGreaterThan(a.west);
          expect(c.x).toBeLessThan(a.east);
        }
      }
    }
  });

  it('inside each garage, his back to its back wall and in its back corners, under its roof', () => {
    const W = world();
    let cases = 0;
    for (const g of W.layout.garages) {
      const rc = g.rect;
      const n = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[g.side] as [number, number];
      const inner = { minX: rc.minX + 0.5, maxX: rc.maxX - 0.5, minZ: rc.minZ + 0.5, maxZ: rc.maxZ - 0.5 };
      const cx = (rc.minX + rc.maxX) / 2;
      const cz = (rc.minZ + rc.maxZ) / 2;
      const face = { x: n[0] !== 0 ? (n[0] > 0 ? inner.minX : inner.maxX) : cx, z: n[1] !== 0 ? (n[1] > 0 ? inner.minZ : inner.maxZ) : cz };
      const heading = Math.atan2(n[0], n[1]);
      const right = { x: -Math.cos(heading), z: Math.sin(heading) };
      for (const along of [0, 4.6, -4.6]) {
        const x = face.x + n[0] * 0.4 + right.x * along;
        const z = face.z + n[1] * 0.4 + right.z * along;
        for (const off of [0, 0.5, -0.5]) {
          const r = standAt(W, x, z, heading, off);
          const label = `${g.poi}, ${along === 0 ? 'back wall' : along > 0 ? 'right corner' : 'left corner'}, view ${off}`;
          settleAim(r, label, off);
          const c = r.cam.camera.position;
          expect(c.x > inner.minX && c.x < inner.maxX && c.z > inner.minZ && c.z < inner.maxZ, `${label}: camera ${c.toArray()}`).toBe(true);
          expect(c.y, label).toBeLessThan(r.sim.player.pos.y + g.height - 0.3);
          cases++;
        }
      }
    }
    expect(cases).toBe(W.layout.garages.length * 9);
  });

  it('the crosshair ray is the camera ray every frame, through a turn of the look while aiming at the wall', () => {
    const W = world();
    const f = openFaces(W)[0]!;
    const r = standAt(W, f.x + f.ox * 0.36, f.z + f.oz * 0.36, Math.atan2(f.ox, f.oz));
    for (let k = 0; k < 120; k++) {
      r.cam.look(k < 60 ? 3 : -3, k < 30 ? 2 : k < 90 ? -1 : 1);
      frame(r, { aim: true }, true);
      expectSoundView(r, `frame ${k}`);
    }
  });

  it('a shot along the crosshair, with his back to the wall, hits someone it passes through', () => {
    const W = world();
    const f = openFaces(W)[1]!;
    const heading = Math.atan2(f.ox, f.oz);
    const r = standAt(W, f.x + f.ox * 0.36, f.z + f.oz * 0.36, heading);
    for (let k = 0; k < 90; k++) frame(r, { aim: true }, true);
    const p = r.sim.player;
    // The ray's crossing of the vertical plane 3 m ahead of him, and the pitch that puts it at chest height there.
    const crossing = (pitch: number) => {
      r.cam.pitch = pitch;
      const ray = r.cam.rayFor();
      const ahead = Math.hypot(ray.dir.x, ray.dir.z);
      const t = (3 - ((ray.origin.x - p.pos.x) * f.ox + (ray.origin.z - p.pos.z) * f.oz)) / ((ray.dir.x * f.ox + ray.dir.z * f.oz) || ahead);
      return { y: ray.origin.y + ray.dir.y * t, x: ray.origin.x + ray.dir.x * t, z: ray.origin.z + ray.dir.z * t };
    };
    for (let pass = 0; pass < 6; pass++) {
      let lo = -1.2;
      let hi = 1.3;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (crossing(mid).y < p.pos.y + 1.2) lo = mid;
        else hi = mid;
      }
      r.cam.pitch = (lo + hi) / 2;
      for (let k = 0; k < 40; k++) frame(r, { aim: true }, true);
    }
    const at = crossing(r.cam.pitch);
    expect(Math.abs(at.y - (p.pos.y + 1.2))).toBeLessThan(0.05);
    const e = r.sim.spawnCharacter('gang', at.x, at.z);
    e.armor = 5000;
    const spot = { x: e.pos.x, z: e.pos.z };
    const shots: Array<{ shooter: unknown; hit: string }> = [];
    r.sim.events.on('shot', (s) => shots.push(s));
    const home = { x: p.pos.x, z: p.pos.z };
    for (let k = 0; k < 20; k++) {
      p.pos.x = home.x;
      p.pos.z = home.z;
      e.pos.x = spot.x;
      e.pos.z = spot.z;
      e.vel.x = 0;
      e.vel.z = 0;
      frame(r, { aim: true, fire: k === 10, firePressed: k === 10 }, true);
    }
    expect(shots.filter((s) => s.shooter === p).map((s) => s.hit)).toEqual(['flesh']);
    expect(e.armor).toBeLessThan(5000);
  });
});

describe('aiming with room behind him, and through the scope, is framed as before', () => {
  it('in an open street the aim view is the look and the boom is 2.4 m, with no rise', () => {
    const W = world();
    const f = openFaces(W)[3]!;
    const r = standAt(W, f.x + f.ox * 8, f.z + f.oz * 8, Math.atan2(f.ox, f.oz) + Math.PI);
    for (let k = 0; k < 90; k++) frame(r, { aim: true }, true);
    expect(viewPitch(r.cam)).toBeCloseTo(REST, 9);
    const head = headCentre(r.crowd);
    expect(Math.hypot(r.cam.camera.position.x - head.x, r.cam.camera.position.z - head.z)).toBeGreaterThan(2.2);
    expect(r.cam.camera.position.y - head.y).toBeLessThan(0.6);
    expectSoundView(r, 'open street');
  });

  it('with a sniper rifle and his back to the wall the scope is still the eye view: no rise, no tilt, narrowed field of view', () => {
    const W = world();
    const f = openFaces(W)[0]!;
    const r = standAt(W, f.x + f.ox * 0.36, f.z + f.oz * 0.36, Math.atan2(f.ox, f.oz));
    r.sim.player.inventory.give('sniper', 20);
    r.sim.player.inventory.current = 'sniper';
    const baseFov = r.cam.camera.fov;
    for (let k = 0; k < 90; k++) frame(r, { aim: true }, true);
    expect(r.cam.scoped).toBe(true);
    expect(viewPitch(r.cam)).toBeCloseTo(REST + (r.cam as unknown as { swayPitch: number }).swayPitch, 6);
    expect(r.cam.camera.fov).toBeLessThan(baseFov / 2);
    const p = r.sim.player;
    expect(r.cam.camera.position.y - (p.pos.y + 1.62 * p.appearance.height)).toBeCloseTo(0, 9);
    const ray = r.cam.rayFor();
    const c = r.cam.camera.position;
    const dir = r.cam.camera.getWorldDirection(new THREE.Vector3());
    expect(Math.hypot(ray.origin.x - c.x, ray.origin.y - c.y, ray.origin.z - c.z)).toBeLessThan(1e-9);
    expect(Math.hypot(ray.dir.x - dir.x, ray.dir.y - dir.y, ray.dir.z - dir.z)).toBeLessThan(1e-9);
  });
});

describe('with room behind him the camera frames him as before', () => {
  it('in an open street, and with a trunk 2 m behind him, the view is the look and the boom its full length', () => {
    const W = world();
    const f = openFaces(W)[3]!;
    const heading = Math.atan2(f.ox, f.oz);
    // Facing the wall from 6 m out: nothing behind him for the boom.
    const r = standAt(W, f.x + f.ox * 6, f.z + f.oz * 6, heading + Math.PI);
    for (let k = 0; k < 60; k++) frame(r);
    expect(viewPitch(r.cam)).toBeCloseTo(REST, 9);
    expect(r.cam.camera.position.distanceTo(headCentre(r.crowd))).toBeGreaterThan(4);
    const d = drawn(r.crowd, r.cam.camera);
    expect(d.dissolving).toBe(0);
    expect(d.inFrame / d.total).toBeGreaterThan(0.8);

    // A lone street tree 2 m behind him: the trunk stops the boom (no nearer than 1.3 m), which needs no rise.
    const tree = W.layout.props.find((q) => q.kind === 'tree' && W.isFree(q.x, q.z + 2, 0.35) && W.isFree(q.x, q.z + 6, 0.35) && !W.layout.props.some((o) => o !== q && Math.hypot(o.x - q.x, o.z - q.z) < 8) && !W.grid.raycast(q.x, W.groundHeight(q.x, q.z + 2) + 1.7, q.z + 2, 0, 0, 1, 6, sightHit, isSolidForSight))!;
    expect(tree).toBeDefined();
    const t = standAt(W, tree.x, tree.z + 2, 0);
    for (let k = 0; k < 60; k++) frame(t);
    expect(t.cam.camera.position.z).toBeGreaterThan(tree.z);
    expect(viewPitch(t.cam)).toBeCloseTo(REST, 9);
  });
});
