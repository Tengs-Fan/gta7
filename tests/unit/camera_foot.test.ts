// The on-foot camera on an open road: how much of the frame the player fills at rest, on the far zoom and aiming, and on
// each Field of view setting; that it keeps up with him at a steady walk or sprint and has a little weight when he
// starts, stops or turns, with no bob and no roll; and that the over-the-shoulder aim still shoots what the crosshair is
// on, near and far, with him clear of the target.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CameraController, FOOT_BOOM, FOOT_BOOM_AIM, FOOT_BOOM_FAR, FOOT_FOV_AIM, FOOT_FOV_FAR, FOOT_FOV_REST, footBoom, footFov } from '../../src/render/camera';
import { CrowdView } from '../../src/render/crowd';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import { input, makeSim, teleport } from './helpers';

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
    return new Proxy(store, { get: (o, k) => (k in o ? o[k] : () => {}) });
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

interface Run {
  sim: Sim;
  cam: CameraController;
  crowd: CrowdView;
  h: number;
}

/** The player in the middle of a long open road facing along it (trees and breakables cleared), the camera behind him. */
function openRoad(base = 68): Run {
  const sim = makeSim({ police: false });
  for (const c of sim.world.grid.colliders) if (c.breakable || c.tag === 'tree' || c.tag === 'palm') c.broken = true;
  for (const lane of sim.roads.lanes) {
    if (lane.length < 80) continue;
    const s = lane.length / 2;
    const x = lane.sx + lane.dx * s;
    const z = lane.sz + lane.dz * s;
    const rx = -Math.cos(lane.heading);
    const rz = Math.sin(lane.heading);
    let open = true;
    for (let a = -12; a <= 30 && open; a++) for (let l = -4; l <= 4 && open; l++) open = sim.world.isFree(x + lane.dx * a + rx * l, z + lane.dz * a + rz * l, 0.5);
    if (!open || sim.world.layout.props.some((q) => Math.hypot(q.x - x, q.z - z) < 14)) continue;
    teleport(sim, x, z);
    sim.player.heading = lane.heading;
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    cam.baseFov = base;
    cam.reset(sim);
    cam.yaw = lane.heading;
    return { sim, cam, crowd: new CrowdView(), h: lane.heading };
  }
  throw new Error('no open road');
}

/** One frame as the game runs it: the crosshair ray from rayFor, the sim, the camera, then the crowd. */
function frame(r: Run, over: Partial<PlayerInput> = {}, aiming = false): void {
  const ray = r.cam.rayFor();
  r.sim.update(DT, input({ ...over, aim: aiming, cameraYaw: r.cam.yaw, aimOrigin: ray.origin, aimDir: ray.dir }));
  r.cam.update(DT, r.sim, aiming);
  r.crowd.sync([r.sim.player], r.cam.camera.position.x, r.cam.camera.position.z, DT);
}

/** The player's drawn figure on screen (normalised device coordinates): its top and bottom, and its share of the frame's height. */
function figure(r: Run): { top: number; bottom: number; share: number; left: number; right: number } {
  const cam = r.cam.camera;
  cam.updateMatrixWorld(true);
  r.crowd.group.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const out = { top: -Infinity, bottom: Infinity, share: 0, left: Infinity, right: -Infinity };
  r.crowd.group.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh) || o.count === 0 || o.name.startsWith('gun-')) return;
    const pos = o.geometry.getAttribute('position');
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      m.premultiply(o.matrixWorld);
      for (let k = 0; k < pos.count; k++) {
        v.fromBufferAttribute(pos, k).applyMatrix4(m).project(cam);
        out.top = Math.max(out.top, v.y);
        out.bottom = Math.min(out.bottom, v.y);
        out.left = Math.min(out.left, v.x);
        out.right = Math.max(out.right, v.x);
      }
    }
  });
  out.share = (out.top - out.bottom) / 2;
  return out;
}

/** How far (m) the camera stands back from his head along the view: the boom's length. */
function boom(r: Run): number {
  const p = r.sim.player;
  const c = r.cam.camera.position;
  const d = r.cam.camera.getWorldDirection(new THREE.Vector3());
  return (p.pos.x - c.x) * d.x + (p.pos.y + 1.58 * p.appearance.height - c.y) * d.y + (p.pos.z - c.z) * d.z;
}

describe('the on-foot camera frames him close, over the right shoulder', () => {
  it('at rest he stands 45 to 50% of the frame, whole, his head just above the middle and left of the crosshair', () => {
    const r = openRoad();
    for (let i = 0; i < 90; i++) frame(r);
    expect(r.cam.camera.fov).toBeCloseTo(68 + FOOT_FOV_REST, 1);
    expect(boom(r)).toBeCloseTo(FOOT_BOOM, 1);
    const f = figure(r);
    expect(f.share).toBeGreaterThan(0.45);
    expect(f.share).toBeLessThan(0.5);
    // Soles at least 6% of the frame clear of its bottom edge, crown below its top.
    expect(f.bottom).toBeGreaterThan(-0.88);
    expect(f.top).toBeLessThan(0.3);
    expect(f.top).toBeGreaterThan(0.05);
    // All of him left of the crosshair.
    expect(f.right).toBeLessThan(0);
  });

  it('the far zoom is a distinctly wider view: the full setting, a longer boom, him under two thirds of the size', () => {
    const r = openRoad();
    for (let i = 0; i < 90; i++) frame(r);
    const rest = figure(r).share;
    r.cam.zoomLevel = 1;
    for (let i = 0; i < 120; i++) frame(r);
    expect(r.cam.camera.fov).toBeCloseTo(68 + FOOT_FOV_FAR, 1);
    expect(boom(r)).toBeCloseTo(FOOT_BOOM_FAR, 1);
    const far = figure(r);
    expect(far.share).toBeLessThan(rest * 0.67);
    expect(far.share).toBeGreaterThan(0.25);
    expect(far.bottom).toBeGreaterThan(-0.8);
  });

  it('the Field of view setting moves every foot lens with it, the far zoom always wider than rest and aiming narrower', () => {
    let last = Infinity;
    for (const base of [55, 68, 80, 90]) {
      expect(footFov(base, false, false, 0)).toBe(base + FOOT_FOV_REST);
      expect(footFov(base, false, true, 0)).toBe(base + FOOT_FOV_FAR);
      expect(footFov(base, true, false, 0)).toBe(base + FOOT_FOV_AIM);
      expect(footFov(base, true, true, 7)).toBe(base + FOOT_FOV_AIM);
      expect(footFov(base, false, true, 0)).toBeGreaterThan(footFov(base, false, false, 0) + 5);
      const r = openRoad(base);
      for (let i = 0; i < 90; i++) frame(r);
      expect(r.cam.camera.fov, `setting ${base}`).toBeCloseTo(base + FOOT_FOV_REST, 1);
      const f = figure(r);
      // A wider setting shows him smaller (on the widest, 90 degrees, he is as big as the 68 degree setting showed him
      // from 4.3 m); a narrower one never crops his feet: the boom stands back further instead (footBoom).
      expect(f.share, `setting ${base}`).toBeLessThan(last);
      expect(f.share, `setting ${base}`).toBeGreaterThan(0.3);
      expect(f.bottom, `setting ${base}`).toBeGreaterThan(-0.92);
      expect(boom(r), `setting ${base}`).toBeCloseTo(footBoom(base, false), 1);
      if (base < 60) expect(footBoom(base, false)).toBeGreaterThan(FOOT_BOOM + 0.5);
      else expect(footBoom(base, false)).toBe(FOOT_BOOM);
      last = f.share;
    }
  });
});

describe('the on-foot camera moves with him', () => {
  it('keeps up at a steady walk and sprint (no trail), the sprint opening the lens a little', () => {
    for (const sprint of [false, true]) {
      const r = openRoad();
      for (let i = 0; i < 60; i++) frame(r);
      const rest = figure(r).share;
      for (let i = 0; i < 150; i++) frame(r, { moveZ: 1, sprint });
      const speed = Math.hypot(r.sim.player.vel.x, r.sim.player.vel.z);
      expect(speed).toBeGreaterThan(sprint ? 7 : 4);
      // The boom as at rest, to a few cm: a follow point easing after him at 22/s used to trail a sprinter by 0.34 m.
      expect(Math.abs(boom(r) - FOOT_BOOM), sprint ? 'sprint' : 'walk').toBeLessThan(0.06);
      const share = figure(r).share;
      if (sprint) {
        expect(r.cam.camera.fov).toBeGreaterThan(68 + FOOT_FOV_REST + 3);
        expect(share).toBeGreaterThan(rest * 0.78);
      } else {
        expect(r.cam.camera.fov).toBeCloseTo(68 + FOOT_FOV_REST, 0);
        expect(share).toBeGreaterThan(rest * 0.94);
      }
    }
  });

  it('has a little weight starting, stopping and turning, settles within a second, and never bobs or rolls', () => {
    const r = openRoad();
    for (let i = 0; i < 60; i++) frame(r);
    const y0 = r.cam.camera.position.y;
    const along = () => {
      const p = r.sim.player.pos;
      const c = r.cam.camera.position;
      return (p.x - c.x) * Math.sin(r.h) + (p.z - c.z) * Math.cos(r.h);
    };
    const rest = along();
    let most = 0;
    let lowest = Infinity;
    let highest = -Infinity;
    const watch = () => {
      most = Math.max(most, Math.abs(along() - rest));
      lowest = Math.min(lowest, r.cam.camera.position.y);
      highest = Math.max(highest, r.cam.camera.position.y);
      const up = r.cam.camera.up;
      expect(Math.hypot(up.x, up.z)).toBeLessThan(1e-9);
    };
    // Starting to sprint: the camera falls back, then comes up to its place.
    for (let i = 0; i < 20; i++) {
      frame(r, { moveZ: 1, sprint: true });
      watch();
    }
    expect(most).toBeGreaterThan(0.1);
    expect(most).toBeLessThan(0.33);
    for (let i = 0; i < 60; i++) frame(r, { moveZ: 1, sprint: true });
    expect(Math.abs(along() - rest)).toBeLessThan(0.05);
    // Stopping: it drifts in, and is back in place within a second.
    most = 0;
    for (let i = 0; i < 60; i++) {
      frame(r);
      watch();
    }
    expect(most).toBeGreaterThan(0.1);
    expect(most).toBeLessThan(0.33);
    expect(Math.abs(along() - rest)).toBeLessThan(0.03);
    // Turning a corner at a walk (the stick held right of ahead): a sideways sway, as small.
    let side = 0;
    for (let i = 0; i < 40; i++) {
      frame(r, { moveZ: 1, moveX: i < 20 ? 0 : 1 });
      const p = r.sim.player.pos;
      const c = r.cam.camera.position;
      side = Math.max(side, Math.abs((p.x - c.x) * -Math.cos(r.h) + (p.z - c.z) * Math.sin(r.h) + 0.42));
      watch();
    }
    expect(side).toBeLessThan(0.33);
    // On flat ground the camera holds its height to a centimetre the whole time: no bob.
    expect(highest - lowest).toBeLessThan(0.01);
    expect(Math.abs(highest - y0)).toBeLessThan(0.01);
  });
});

describe('aiming over the shoulder', () => {
  it('a pistol shot hits the person under the crosshair, 3 m off and 14 m off, and he never covers that person', () => {
    for (const dist of [3, 14]) {
      for (const side of [-0.5, 0, 0.4]) {
        const r = openRoad();
        const p = r.sim.player;
        p.inventory.give('pistol', 50);
        p.inventory.current = 'pistol';
        for (let i = 0; i < 40; i++) frame(r, {}, true);
        const yaw = r.h + side / dist;
        const civ = r.sim.spawnCharacter('civilian', p.pos.x + Math.sin(yaw) * dist, p.pos.z + Math.cos(yaw) * dist);
        civ.owner = 'mission';
        civ.persistent = true;
        const chest = new THREE.Vector3(civ.pos.x, civ.pos.y + 1.15, civ.pos.z);
        // Turn the view until the crosshair ray from where the camera stands passes through his chest, as a player does.
        for (let k = 0; k < 60; k++) {
          const ray = r.cam.rayFor();
          r.cam.yaw = Math.atan2(chest.x - ray.origin.x, chest.z - ray.origin.z);
          r.cam.pitch = Math.atan2(chest.y - ray.origin.y, Math.hypot(chest.x - ray.origin.x, chest.z - ray.origin.z));
          if (k % 3 === 0) frame(r, {}, true);
        }
        for (let i = 0; i < 30; i++) frame(r, {}, true);
        const label = `${dist} m, ${side} m aside`;
        expect(boom(r), label).toBeCloseTo(FOOT_BOOM_AIM, 1);
        expect(r.cam.camera.fov, label).toBeCloseTo(68 + FOOT_FOV_AIM, 1);
        // He stays left of the crosshair: nothing of him within 4% of the frame's width of the target's chest.
        const f = figure(r);
        const at = chest.clone().project(r.cam.camera);
        expect(Math.abs(at.x), label).toBeLessThan(0.01);
        expect(f.right, label).toBeLessThan(at.x - 0.08);
        const before = civ.health;
        const ray = r.cam.rayFor();
        r.sim.update(DT, input({ aim: true, fire: true, firePressed: true, cameraYaw: r.cam.yaw, aimOrigin: ray.origin, aimDir: ray.dir }));
        expect(civ.health, label).toBeLessThan(before);
      }
    }
  });
});
