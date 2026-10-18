// Round 2, fix pass 4, cluster "actors": a marker he just stepped off kept away from the aiming camera's lens; a
// swimmer's camera that glides over a quay or deck edge instead of jumping; the camera with his back to a wall and the
// view turned toward its shoulder.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CameraController } from '../../src/render/camera';
import { CrowdView, LENS_FADE_FULL } from '../../src/render/crowd';
import { MarkerView } from '../../src/render/markers';
import type { Marker } from '../../src/sim/interactions';
import { Sim } from '../../src/sim/sim';
import { isSolidForSight, makeRayHit } from '../../src/world/colliders';
import { WATER_Y } from '../../src/world/constants';
import type { StaticWorld } from '../../src/world/staticWorld';
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

/** The centre of the player's drawn head (the only character drawn). */
function headCentre(crowd: CrowdView): THREE.Vector3 {
  const m = new THREE.Matrix4();
  (crowd as unknown as { parts: Record<string, Part> }).parts.head!.mesh.getMatrixAt(0, m);
  return new THREE.Vector3(0, 0.15, 0).applyMatrix4(m);
}

/** A camera in play (not the title flyover). */
function playCamera(): CameraController {
  const cam = new CameraController(16 / 9);
  cam.mode = 'play';
  return cam;
}

/** One frame of play as the game runs it: the crosshair ray from rayFor, the sim, then the camera. */
function frame(sim: Sim, cam: CameraController, over: Parameters<typeof input>[0] = {}, aiming = false): void {
  const r = cam.rayFor();
  sim.update(DT, input({ ...over, cameraYaw: cam.yaw, aimOrigin: r.origin, aimDir: r.dir }));
  cam.update(DT, sim, aiming);
}

// ---------------------------------------------------------------------------
// Issue 1: the marker he just stepped off, right in front of the aiming camera

describe('a marker he has just stepped off is not drawn right in front of the aiming camera', () => {
  /** What the view draws of `m`: its beam's opacity, its icon's scale, and the icon's distance from the lens. */
  function drawn(view: MarkerView, m: Marker, sim: Sim, cam: CameraController): { alpha: number; icon: number; lens: number } {
    view.syncMarkers([m], 0, cam.camera.position, sim.playerPos());
    const g = view.group.children[0]!;
    g.updateMatrixWorld(true);
    const icon = g.getObjectByName('icon')!;
    const beam = g.getObjectByName('beam') as THREE.Mesh;
    return {
      alpha: g.visible ? (beam.material as THREE.MeshBasicMaterial).opacity : 0,
      icon: g.visible ? icon.scale.x : 0,
      lens: new THREE.Vector3().setFromMatrixPosition(icon.matrixWorld).distanceTo(cam.camera.position),
    };
  }

  /** The safehouse save marker beside the New Game spawn, and a sim with the player D m out from it, his back to it. */
  function besideSave(D: number, heading: number): { sim: Sim; m: Marker; cam: CameraController } {
    const W = world();
    const sim = new Sim({ world: W, ambient: false, police: false, startHour: 12 });
    const m = sim.interactions.markers.find((q) => q.kind === 'save')!;
    const p = sim.player;
    p.pos.x = m.x + Math.sin(heading) * D;
    p.pos.z = m.z + Math.cos(heading) * D;
    p.pos.y = W.groundHeight(p.pos.x, p.pos.z);
    p.heading = heading;
    expect(W.isFree(p.pos.x, p.pos.z, 0.35)).toBe(true);
    p.inventory.give('pistol', 50);
    p.inventory.current = 'pistol';
    const cam = playCamera();
    cam.reset(sim);
    cam.yaw = heading;
    cam.pitch = -0.12;
    return { sim, m, cam };
  }

  it('aiming 1.5 to 2.4 m out from it, his back to it, whichever way he faces: no part of its icon right at the lens', () => {
    let cases = 0;
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      for (const D of [1.5, 1.6, 1.8, 2, 2.2, 2.4]) {
        const { sim, m, cam } = besideSave(D, heading);
        for (let k = 0; k < 60; k++) frame(sim, cam, { aim: true }, true);
        const label = `heading ${heading.toFixed(2)}, ${D} m out`;
        expect(sim.player.aimZoom, label).toBe(true);
        const d = drawn(new MarkerView(), m, sim, cam);
        // (The camera is that close to it: the short aiming boom has it on the far side of the marker's axis.)
        expect(d.lens, label).toBeLessThan(1.6);
        // It drew a diamond 0.9-1.2 m from the lens, filling a corner of the frame (13 degrees across its radius).
        expect(d.icon, label).toBe(0);
        expect(d.alpha, label).toBe(0);
        cases++;
      }
    }
    expect(cases).toBe(24);
  });

  it('not aiming, he takes it along for a step as before; standing in it, it is drawn in full', () => {
    for (const heading of [0, Math.PI]) {
      // A step out with the camera 4.3 m behind him: most of it.
      let s = besideSave(1.6, heading);
      for (let k = 0; k < 60; k++) frame(s.sim, s.cam);
      const out = drawn(new MarkerView(), s.m, s.sim, s.cam);
      expect(out.icon).toBeGreaterThan(0.6);
      // In it (1 m from its centre), even aiming with the camera close: all of it.
      s = besideSave(1, heading);
      for (let k = 0; k < 60; k++) frame(s.sim, s.cam, { aim: true }, true);
      const inIt = drawn(new MarkerView(), s.m, s.sim, s.cam);
      expect(inIt.icon).toBe(1);
      expect(inIt.alpha).toBe(0.28);
    }
  });

  it('walking out of it aiming, the camera close behind him: it fades over his last steps in it, then stays gone', () => {
    for (const heading of [0, Math.PI]) {
      const { sim, m, cam } = besideSave(0.6, heading);
      const view = new MarkerView();
      for (let k = 0; k < 40; k++) frame(sim, cam, { aim: true }, true);
      let prev = drawn(view, m, sim, cam).alpha;
      expect(prev).toBe(0.28);
      let worst = 0;
      let gone = false;
      for (let k = 0; k < 90; k++) {
        frame(sim, cam, { aim: true, moveZ: 1 }, true);
        const d = drawn(view, m, sim, cam);
        worst = Math.max(worst, Math.abs(d.alpha - prev));
        prev = d.alpha;
        const away = Math.hypot(sim.player.pos.x - m.x, sim.player.pos.z - m.z);
        // Out of it, nothing of it near the lens (it drew a diamond 1.2 m from it at 86% of its size).
        if (away > m.radius && d.lens < 1.6) expect(d.icon, `${away.toFixed(2)} m out, ${d.lens.toFixed(2)} m from the lens`).toBe(0);
        if (away > m.radius + 0.1) gone = true;
      }
      expect(gone).toBe(true);
      // Faded over a few frames, not cut in one (the whole beam is 0.28).
      expect(worst).toBeLessThan(0.15);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue 2: the swimmer's camera panned across a quay or deck edge

describe('panned round a swimmer by a quay or deck edge, the camera glides instead of jumping', () => {
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

  /** A swimmer treading water `d` m off the west quay or the marina deck east of x = 594, his back to it, the camera behind him. */
  function swimmer(site: 'quay' | 'deck', d: number): { sim: Sim; cam: CameraController; crowd: CrowdView } {
    const sim = makeSim({ world: world(), police: false });
    sim.cheats.godMode = true;
    const b = sim.world.layout.bounds;
    const p = sim.player;
    p.pos.x = site === 'quay' ? b.landMinX - d : 594 + d;
    p.pos.z = site === 'quay' ? 140 : 465.5;
    p.pos.y = WATER_Y - 1.3;
    p.state = 'swimming';
    p.heading = site === 'quay' ? -Math.PI / 2 : Math.PI / 2;
    const cam = playCamera();
    cam.reset(sim);
    cam.yaw = p.heading;
    cam.pitch = -0.12;
    return { sim, cam, crowd: new CrowdView() };
  }

  /**
   * A full turn of the view in `frames` frames (`sign` the way round), after half a second to settle: the largest
   * one-frame move of the camera and turn of its view, and the frames in which his drawn head is out of the frame, the
   * line to it dips into the terrain or it is dissolving at the lens.
   */
  function pan(site: 'quay' | 'deck', d: number, frames: number, sign: number): { move: number; turn: number; hidden: number; at: string } {
    const { sim, cam, crowd } = swimmer(site, d);
    const each = () => crowd.sync([sim.player], cam.camera.position.x, cam.camera.position.z, DT);
    for (let k = 0; k < 30; k++) {
      frame(sim, cam);
      each();
    }
    let move = 0;
    let turn = 0;
    let hidden = 0;
    let at = '';
    const prev = cam.camera.position.clone();
    const prevDir = cam.camera.getWorldDirection(new THREE.Vector3());
    const dir = new THREE.Vector3();
    for (let k = 0; k < frames; k++) {
      cam.look((-sign * (2 * Math.PI)) / frames / 0.0024, 0);
      frame(sim, cam);
      each();
      const c = cam.camera.position;
      cam.camera.getWorldDirection(dir);
      const mv = c.distanceTo(prev);
      const tn = THREE.MathUtils.radToDeg(dir.angleTo(prevDir));
      if (mv > move || tn > turn) at = `frame ${k}, yaw ${cam.yaw.toFixed(2)}: ${mv.toFixed(2)} m, ${tn.toFixed(1)} degrees`;
      move = Math.max(move, mv);
      turn = Math.max(turn, tn);
      prev.copy(c);
      prevDir.copy(dir);
      const head = headCentre(crowd);
      cam.camera.updateMatrixWorld(true);
      const s = head.clone().project(cam.camera);
      const inFrame = s.z > -1 && s.z < 1 && Math.abs(s.x) <= 1 && Math.abs(s.y) <= 1;
      if (clearance(sim.world, c, head) <= 0 || !inFrame || c.distanceTo(head) < LENS_FADE_FULL + 0.15) hidden++;
    }
    expect(sim.player.state).toBe('swimming');
    return { move, turn, hidden, at };
  }

  it('a full turn in 4 s (1.5 degrees a frame) either way, 0.05 to 1 m off the west quay or a marina deck', () => {
    for (const site of ['quay', 'deck'] as const) {
      for (const d of [0.05, 0.15, 0.3, 1]) {
        for (const sign of [1, -1]) {
          const r = pan(site, d, 240, sign);
          const label = `${site}, ${d} m, ${sign > 0 ? 'left' : 'right'}: ${r.at}`;
          expect(r.hidden, label).toBe(0);
          // It jumped 1.7 to 2.5 m and turned 15 to 19 degrees in a frame as the boom swung over the edge.
          expect(r.move, label).toBeLessThan(0.6);
          expect(r.turn, label).toBeLessThan(d >= 1 ? 3 : 5.25);
        }
      }
    }
  });

  it('looking up from the water (pitch 0.3) as the view turns, he never drops out of the frame', () => {
    for (const site of ['quay', 'deck'] as const) {
      for (const sign of [1, -1]) {
        const { sim, cam, crowd } = swimmer(site, 0.05);
        cam.pitch = 0.3;
        for (let k = 0; k < 90; k++) {
          frame(sim, cam);
          crowd.sync([sim.player], cam.camera.position.x, cam.camera.position.z, DT);
        }
        let out = 0;
        for (let k = 0; k < 240; k++) {
          cam.look((-sign * (2 * Math.PI)) / 240 / 0.0024, 0);
          frame(sim, cam);
          crowd.sync([sim.player], cam.camera.position.x, cam.camera.position.z, DT);
          cam.camera.updateMatrixWorld(true);
          const s = headCentre(crowd).project(cam.camera);
          if (!(s.z > -1 && s.z < 1 && Math.abs(s.x) <= 1 && Math.abs(s.y) <= 1)) out++;
        }
        // The view's tilt eased after the camera as it rose, and his head sank below the frame for 15 to 38 frames.
        expect(out, `${site} ${sign}`).toBe(0);
      }
    }
  });

  it('paused (no time passing), the gliding camera stays exactly where it is', () => {
    const { sim, cam } = swimmer('quay', 0.05);
    for (let k = 0; k < 30; k++) frame(sim, cam);
    for (let k = 0; k < 400; k++) {
      cam.look(-(2 * Math.PI) / 240 / 0.0024, 0);
      frame(sim, cam);
      const c = cam.camera.position.clone();
      const dir = cam.camera.getWorldDirection(new THREE.Vector3());
      for (let i = 0; i < 3; i++) cam.update(0, sim, false);
      expect(cam.camera.position.distanceTo(c), `frame ${k}`).toBe(0);
      expect(cam.camera.getWorldDirection(new THREE.Vector3()).distanceTo(dir), `frame ${k}`).toBe(0);
    }
  });

  it('a slow turn (16 s) right against the quay and the deck', () => {
    for (const site of ['quay', 'deck'] as const) {
      const r = pan(site, 0.05, 960, 1);
      const label = `${site}: ${r.at}`;
      expect(r.hidden, label).toBe(0);
      // (It turned 5 to 8 degrees in a frame at a quarter of a degree's pan.)
      expect(r.move, label).toBeLessThan(0.45);
      expect(r.turn, label).toBeLessThan(4);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue 3: his back to a wall, the view turned toward the camera's shoulder

describe('his back to a wall with the view turned, the camera stays on his side of it and rises over him', () => {
  /** Faces of building tiers (two a side) with open ground 6 m out in front of their middle and no prop near. */
  function openFaces(w: StaticWorld): Array<{ side: string; x: number; z: number; ox: number; oz: number }> {
    const out: Array<{ side: string; x: number; z: number; ox: number; oz: number }> = [];
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
        // The wall is really there, right behind him.
        if (!w.grid.raycast(x + ox, w.groundHeight(x + ox, z + oz) + 1.6, z + oz, -ox, 0, -oz, 1.2, sightHit, isSolidForSight)) continue;
        out.push({ side, x, z, ox, oz });
        count[side]!++;
      }
    }
    return out;
  }

  it('0.36 and 0.45 m from walls facing every way, the view turned half a radian and a radian either way, aiming or not', () => {
    const W = world();
    const faces = openFaces(W);
    expect(faces.length).toBe(8);
    let cases = 0;
    for (const f of faces) {
      for (const gap of [0.36, 0.45]) {
        for (const off of [-1, -0.5, 0.5, 1]) {
          for (const aim of [false, true]) {
            const sim = new Sim({ world: W, ambient: false, police: false, startHour: 12 });
            const p = sim.player;
            p.pos.x = f.x + f.ox * gap;
            p.pos.z = f.z + f.oz * gap;
            p.pos.y = W.groundHeight(p.pos.x, p.pos.z);
            // His back to the wall.
            p.heading = Math.atan2(f.ox, f.oz);
            p.inventory.give('pistol', 50);
            p.inventory.current = 'pistol';
            const cam = playCamera();
            cam.reset(sim);
            cam.yaw = p.heading + off;
            cam.pitch = -0.12;
            const crowd = new CrowdView();
            for (let k = 0; k < 60; k++) {
              frame(sim, cam, { aim }, aim);
              crowd.sync([sim.player], cam.camera.position.x, cam.camera.position.z, DT);
            }
            const label = `${f.side} face, ${gap} m, view ${off} rad${aim ? ', aiming' : ''}`;
            expect(Math.hypot(p.pos.x - (f.x + f.ox * gap), p.pos.z - (f.z + f.oz * gap)), label).toBeLessThan(0.05);
            const c = cam.camera.position;
            const head = headCentre(crowd);
            // On his side of the wall: it was up to 0.12 m inside the building, the line to his head through its wall.
            const front = (c.x - f.x) * f.ox + (c.z - f.z) * f.oz;
            expect(front, label).toBeGreaterThan(0);
            // Where the view runs along the wall (its face inside the frame), clear of it: a centimetre or two off it, the
            // face showed as a strip seen edge-on, the near plane cutting through the wall beside it.
            if (Math.abs(off) >= 1) expect(front, label).toBeGreaterThan(0.08);
            const to = c.clone().sub(head);
            const L = to.length();
            expect(W.grid.raycast(head.x, head.y, head.z, to.x / L, to.y / L, to.z / L, L, sightHit, isSolidForSight), label).toBe(false);
            // Close to him, it has risen over his head: from inside the wall it could not, and stayed below it.
            if (L < 0.7) expect(c.y - head.y, label).toBeGreaterThan(0.2);
            // The crosshair ray rebuilt for the next frame is the view this frame drew.
            const ray = cam.rayFor();
            expect(Math.hypot(ray.origin.x - c.x, ray.origin.y - c.y, ray.origin.z - c.z), label).toBeLessThan(1e-6);
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(128);
  });
});
