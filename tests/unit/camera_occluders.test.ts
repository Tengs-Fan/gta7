// Thin occluders and the camera: lamp and signal poles and tree and palm trunks between the lens and the player dissolve
// (render/occluderFade.ts, PropsView.setOccluderView) instead of standing in front of him, poles stay non-solid for the
// boom, and the floating diamond of the marker he stands in fades while he aims there.
// The census runs the real CameraController headlessly. CAM_WALKS (sidewalk walks, default 120) and CAM_DRIVE_SEEDS
// (default "1") scale it up for the full measurement: CAM_WALKS=120 CAM_DRIVE_SEEDS=1,2,3 CAM_DRIVE_SECONDS=200.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { V3 } from '../../src/core/math';
import { CameraController } from '../../src/render/camera';
import { shadesContact } from '../../src/render/contactShadows';
import { MarkerView } from '../../src/render/markers';
import {
  OCCLUDER_AXIS,
  OCCLUDER_CAPSULE_FULL,
  OCCLUDER_CAPSULE_R,
  OCCLUDER_FADE_EDGES,
  OCCLUDER_LENS_FAR,
  OCCLUDER_LENS_NEAR,
  occluderOpacity,
  type OccluderKind,
} from '../../src/render/occluderFade';
import { PropsView } from '../../src/render/props';
import { DriverAI } from '../../src/sim/driver';
import type { Sim } from '../../src/sim/sim';
import type { StaticCollider } from '../../src/world/colliders';
import type { Prop } from '../../src/world/layout';
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

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

/** A vertical axis at (x, z) from the ground to 6.5 m, like a lamp's. */
const pole = (x: number, z: number): [V3, V3] => [v(x, 0, z), v(x, 6.5, z)];

describe('the occluder fade helper', () => {
  // Camera 4.3 m behind and 0.8 m above a head 1.6 m up, looking along +z.
  const cam = v(0, 2.4, -4.3);
  const head = v(0, 1.6, 0);
  const at = (x: number, z: number) => occluderOpacity(cam, head, ...pole(x, z));

  it('pins the capsule radius to 0.35 m and the full-opacity distance to twice it', () => {
    expect(OCCLUDER_CAPSULE_R).toBe(0.35);
    expect(OCCLUDER_CAPSULE_FULL).toBe(0.7);
    expect(OCCLUDER_LENS_NEAR).toBe(1);
    expect(OCCLUDER_LENS_FAR).toBe(1.6);
    // The shader's uniforms come from the same constants.
    expect(OCCLUDER_FADE_EDGES).toEqual([0.35, 0.7, 1, 1.6]);
  });

  it('dissolves an axis inside the capsule round the sight line, and one within 1 m of the lens', () => {
    for (const z of [-3, -2, -1, -0.5]) {
      for (const x of [0, 0.1, -0.2, 0.34, -0.34]) expect(at(x, z), `${x}, ${z}`).toBe(0);
    }
    // Beside the lens, off the line: 0.9 m to the side of the camera.
    expect(at(0.9, -4.3)).toBe(0);
    expect(at(-0.6, -4.9)).toBe(0);
  });

  it('draws in full an axis 0.7 m or more off the line and more than 1.5 m from the lens', () => {
    for (const z of [-2.5, -1.5, -0.5]) {
      for (const x of [0.7, -0.7, 1, 3]) expect(at(x, z), `${x}, ${z}`).toBe(1);
    }
    // Beyond the subject, and behind the camera out of reach.
    expect(at(0, 0.8)).toBe(1);
    expect(at(0, -6)).toBe(1);
  });

  it('is smooth and monotonic in between: at most 0.05 per cm', () => {
    let worst = 0;
    for (const z of [-3.5, -2.8, -2, -1, -0.3]) {
      let prev = at(0, z);
      for (let x = 0.01; x <= 2.5; x += 0.01) {
        const o = at(x, z);
        expect(o, `x ${x.toFixed(2)}, z ${z}`).toBeGreaterThanOrEqual(prev - 1e-12);
        worst = Math.max(worst, Math.abs(o - prev));
        prev = o;
      }
    }
    // Toward the lens along the camera's side.
    let prev = at(2, -4.3);
    for (let x = 1.99; x >= 0; x -= 0.01) {
      const o = at(x, -4.3);
      expect(o).toBeLessThanOrEqual(prev + 1e-12);
      worst = Math.max(worst, Math.abs(o - prev));
      prev = o;
    }
    expect(worst).toBeLessThanOrEqual(0.05);
    expect(worst).toBeGreaterThan(0.02);
  });

  it('takes the axis length into account: a short trunk under the sight line is not dissolved', () => {
    // The camera high above a 1 m stump between it and the head: the line passes over it.
    expect(occluderOpacity(v(0, 6, -4), head, v(0, 0, -2), v(0, 1, -2))).toBe(1);
    // A tall one there is.
    expect(occluderOpacity(v(0, 6, -4), head, v(0, 0, -2), v(0, 8, -2))).toBe(0);
  });
});

/** The scale of a tree or palm from its collider radius (staticWorld.ts addPropCollider). */
function propOf(sim: Sim): Map<string, Prop> {
  const out = new Map<string, Prop>();
  for (const p of sim.world.layout.props) out.set(`${p.x},${p.z}`, p);
  return out;
}

type Tally = { frames: number; occluded: number; drawn: number; poleDrawn: number; trunkDrawn: number; lens: number; lensDrawn: number };
const tally = (): Tally => ({ frames: 0, occluded: 0, drawn: 0, poleDrawn: 0, trunkDrawn: 0, lens: 0, lensDrawn: 0 });

/**
 * One frame of the census (research/gameplay/camera.measure.ts): every pole or trunk on the segment from the camera to the
 * point it frames (within its radius + 0.12 m, at that point's height), and every pole right in front of the lens (under
 * 1.3 m ahead, in the middle of the frame), with the opacity it is drawn at for the camera's occlusion subject.
 */
function census(sim: Sim, props: Map<string, Prop>, cam: V3, dir: V3, subject: V3, tx: number, ty: number, tz: number, t: Tally): void {
  t.frames++;
  const dx = tx - cam.x;
  const dz = tz - cam.z;
  const len2 = dx * dx + dz * dz;
  let occluded = false;
  let drawnPole = false;
  let drawnTrunk = false;
  let lens = false;
  let lensDrawn = false;
  const pad = 2;
  sim.world.grid.query(Math.min(cam.x, tx) - pad, Math.min(cam.z, tz) - pad, Math.max(cam.x, tx) + pad, Math.max(cam.z, tz) + pad, (c: StaticCollider) => {
    if (!c.circle || c.broken) return;
    const isPole = c.tag === 'lamp' || c.tag === 'signal';
    const isTrunk = c.tag === 'tree' || c.tag === 'palm';
    if (!isPole && !isTrunk) return;
    const p = props.get(`${c.cx},${c.cz}`)!;
    const a = OCCLUDER_AXIS[c.tag as OccluderKind];
    const opacity = occluderOpacity(cam, subject, v(p.x, p.y + a.from * p.scale, p.z), v(p.x, p.y + a.to * p.scale, p.z));
    const s = len2 > 1e-6 ? ((c.cx - cam.x) * dx + (c.cz - cam.z) * dz) / len2 : 0;
    if (s > 0.02 && s < 0.97) {
      const off = Math.hypot(c.cx - (cam.x + dx * s), c.cz - (cam.z + dz * s));
      const y = cam.y + (ty - cam.y) * s;
      if (off < c.r + 0.12 && y > c.y0 && y < c.y1) {
        occluded = true;
        if (opacity > 0.5) {
          if (isPole) drawnPole = true;
          else drawnTrunk = true;
        }
      }
    }
    if (isPole) {
      const vx = c.cx - cam.x;
      const vz = c.cz - cam.z;
      const ahead = vx * dir.x + vz * dir.z;
      const side = Math.abs(vx * dir.z - vz * dir.x);
      if (ahead > 0 && ahead < 1.3 && side < ahead * 0.6 + c.r && cam.y < c.y1) {
        lens = true;
        if (opacity > 0.5) lensDrawn = true;
      }
    }
  });
  if (occluded) t.occluded++;
  if (drawnPole || drawnTrunk) t.drawn++;
  if (drawnPole) t.poleDrawn++;
  if (drawnTrunk) t.trunkDrawn++;
  if (lens) t.lens++;
  if (lensDrawn) t.lensDrawn++;
}

const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(3)}%`;
const show = (label: string, t: Tally) =>
  `[camera] ${label}: ${t.frames} frames; pole or trunk on the sight line ${pct(t.occluded, t.frames)}, drawn over 50% ${pct(t.drawn, t.frames)} (poles ${pct(t.poleDrawn, t.frames)}, trunks ${pct(t.trunkDrawn, t.frames)}); pole filling the lens ${pct(t.lens, t.frames)}, drawn over 50% ${pct(t.lensDrawn, t.frames)}`;

const WALKS = Number(process.env.CAM_WALKS ?? 120);
const DRIVE_SEEDS = (process.env.CAM_DRIVE_SEEDS ?? '1').split(',').map(Number);
const DRIVE_SECONDS = Number(process.env.CAM_DRIVE_SECONDS ?? 120);

/** Walks along the sidewalk right of `count` long lanes (camera.measure.ts), calling `frame` after each camera update. */
function walk(sim: Sim, cam: CameraController, count: number, frame: () => void): void {
  const p = sim.player;
  const rng = new Rng(5);
  const dt = 1 / 60;
  const lanes = sim.roads.lanes.filter((l) => l.length > 40);
  for (let k = 0; k < count; k++) {
    const lane = lanes[(k * 7919) % lanes.length]!;
    const half = lane.line.width / 2 + 2.2;
    const centre = (lane.index + 0.5) * 4;
    const off = half - centre + (rng.next() - 0.5) * 1.5;
    const sx = -Math.cos(lane.heading);
    const sz = Math.sin(lane.heading);
    let s = 6;
    const place = () => {
      p.pos.x = lane.sx + lane.dx * s + sx * off;
      p.pos.z = lane.sz + lane.dz * s + sz * off;
      p.pos.y = sim.world.groundHeight(p.pos.x, p.pos.z);
      p.heading = lane.heading;
    };
    place();
    cam.reset(sim);
    cam.yaw = lane.heading;
    let pan = 0;
    let panV = 0;
    while (s < lane.length - 6) {
      s += 1.6 * dt;
      place();
      panV += (rng.next() - 0.5) * 0.4;
      panV *= 0.97;
      pan = Math.max(-0.9, Math.min(0.9, pan + panV * dt));
      cam.yaw = lane.heading + pan;
      cam.update(dt, sim, false);
      frame();
      sim.update(dt, input());
      place();
    }
  }
}

describe('poles and trunks between the camera and the player are dissolved', () => {
  it(`on foot, ${WALKS} sidewalk walks: at most 0.1% of frames show an occluding pole or trunk over 50% opacity`, () => {
    const sim = makeSim({ police: false, ambient: false });
    const props = propOf(sim);
    const cam = new CameraController(16 / 9);
    cam.mode = 'play';
    const p = sim.player;
    const t = tally();
    walk(sim, cam, WALKS, () => {
      const subject = cam.occlusionSubject()!;
      census(sim, props, cam.camera.position, cam.aimRay().dir, subject, p.pos.x, p.pos.y + 1.55 * p.appearance.height, p.pos.z, t);
    });
    console.log(show(`on foot, ${WALKS} sidewalk walks`, t));
    // (Something to dissolve: about 2% of frames have one on the line.)
    expect(t.occluded / t.frames).toBeGreaterThan(0.005);
    expect(t.drawn / t.frames).toBeLessThanOrEqual(0.001);
    expect(t.lensDrawn / t.frames).toBeLessThanOrEqual(0.001);
  });

  it(`driving with the chase camera (seeds ${DRIVE_SEEDS.join(',')}, ${DRIVE_SECONDS} s): no more than 0.05% poles, no trunks over 50% opacity`, () => {
    const t = tally();
    for (const seed of DRIVE_SEEDS) {
      const sim = makeSim({ police: false, ambient: true, seed });
      const props = propOf(sim);
      const lane = sim.roads.lanes.filter((l) => l.length > 70)[seed * 13]!;
      const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading);
      placeInCar(sim, car);
      const ai = new DriverAI(sim, car, 'route');
      const rng = new Rng(seed);
      const newDest = () => {
        const n = sim.roads.nodes[rng.int(0, sim.roads.nodes.length - 1)]!;
        ai.setDestination(n.x, n.z);
      };
      newDest();
      const cam = new CameraController(16 / 9);
      cam.mode = 'play';
      cam.reset(sim);
      const dt = 1 / 60;
      for (let f = 0; f < 60 * DRIVE_SECONDS; f++) {
        if (ai.arrived || f % (60 * 40) === 0) newDest();
        ai.update(dt);
        const c = car.controls;
        cam.update(dt, sim, false);
        const cp = cam.camera.position;
        const d = cam.aimRay().dir;
        if (f > 30) census(sim, props, cp, d, cam.occlusionSubject()!, car.pos.x, car.pos.y + car.spec.height * 0.75, car.pos.z, t);
        sim.update(dt, input({ throttle: c.throttle, brake: c.brake, steer: c.steer, handbrake: c.handbrake, aimOrigin: { x: cp.x, y: cp.y, z: cp.z }, aimDir: { x: d.x, y: d.y, z: d.z } }));
      }
    }
    console.log(show(`driving, seeds ${DRIVE_SEEDS.join(',')} x ${DRIVE_SECONDS} s`, t));
    expect(t.poleDrawn / t.frames).toBeLessThanOrEqual(0.0005);
    expect(t.trunkDrawn).toBe(0);
  });
});

describe('poles stay non-solid for the camera', () => {
  it('walking past lamp poles, removing every pole changes nothing in the camera distance trace', () => {
    const trace = (withoutPoles: boolean): { dist: number[]; dissolved: number } => {
      const sim = makeSim({ police: false, ambient: false });
      if (withoutPoles) for (const c of sim.world.grid.colliders) if (c.tag === 'lamp' || c.tag === 'signal') c.broken = true;
      const cam = new CameraController(16 / 9);
      cam.mode = 'play';
      const W = sim.world;
      const lamps = W.layout.props.filter((q) => q.kind === 'lamp');
      const dist: number[] = [];
      let dissolved = 0;
      walk(sim, cam, 12, () => {
        const c = cam.camera.position;
        const s = cam.occlusionSubject()!;
        dist.push(Math.hypot(c.x - s.x, c.y - s.y, c.z - s.z));
        for (const q of lamps) {
          if (Math.abs(q.x - c.x) > 8 || Math.abs(q.z - c.z) > 8) continue;
          if (occluderOpacity(c, s, v(q.x, q.y, q.z), v(q.x, q.y + OCCLUDER_AXIS.lamp.to, q.z)) < 1) dissolved++;
        }
      });
      return { dist, dissolved };
    };
    const solid = trace(false);
    const none = trace(true);
    expect(solid.dist.length).toBe(none.dist.length);
    // The walks do bring lamp poles between the camera and him...
    expect(solid.dissolved).toBeGreaterThan(20);
    // ...and the boom does not react to them at all: frame-to-frame changes attributable to poles are zero.
    let worst = 0;
    solid.dist.forEach((d, i) => (worst = Math.max(worst, Math.abs(d - none.dist[i]!))));
    expect(worst).toBe(0);
  });
});

type Priv = { refs: Map<number, Array<{ mesh: THREE.InstancedMesh }>>; occUniforms: { uOccCam: { value: THREE.Vector3 }; uOccSubject: { value: THREE.Vector3 }; uOccFade: { value: THREE.Vector4 } } };

describe('the props view dissolves poles and trunks through uniforms only', () => {
  const W = world();
  const props = new PropsView(W);
  const priv = props as unknown as Priv;
  const meshesOf = (index: number) => [...new Set((priv.refs.get(index) ?? []).map((r) => r.mesh))];
  const first = (kind: string) => W.layout.props.findIndex((q) => q.kind === kind);

  it('patches the lamp pole, head and lens, the signal pole and bulbs, and both trunks, with one program key', () => {
    const names = new Set<string>();
    for (const kind of ['lamp', 'signal', 'tree', 'palm']) {
      const i = first(kind);
      expect(i, kind).toBeGreaterThanOrEqual(0);
      for (const m of meshesOf(i)) {
        const mat = m.material as THREE.Material;
        if (mat.customProgramCacheKey() === 'gta7-occluder') names.add(`${kind}:${m.geometry.name || m.geometry.type}`);
      }
    }
    // The lamp's three parts, the signal's pole and bulbs, and each trunk (the canopies keep their own near fade).
    expect([...names].filter((n) => n.startsWith('lamp:')).sort()).toEqual(['lamp:lamp-head', 'lamp:lamp-lens', 'lamp:lamp-pole']);
    expect([...names].filter((n) => n.startsWith('signal:')).length).toBe(2);
    expect([...names].filter((n) => n.startsWith('tree:')).length).toBe(1);
    expect([...names].filter((n) => n.startsWith('palm:')).length).toBe(1);
  });

  it('every patched shader takes the shared uniforms and discards by a dither, standard and basic alike', () => {
    const lamp = first('lamp');
    const mats = new Set(meshesOf(lamp).map((m) => m.material as THREE.Material).filter((m) => m.customProgramCacheKey() === 'gta7-occluder'));
    expect(mats.size).toBe(3);
    for (const mat of mats) {
      const lib = mat instanceof THREE.MeshBasicMaterial ? THREE.ShaderLib.basic : THREE.ShaderLib.standard;
      const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
      mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(shader.vertexShader).toContain('vOccKeep = min(');
      expect(shader.vertexShader).toContain('float occSegSeg(');
      expect(shader.fragmentShader).toContain('occBayer4( gl_FragCoord.xy ) >= vOccKeep ) discard;');
      // Shared objects: setting the view updates every material at once, without touching programs.
      expect(shader.uniforms.uOccCam).toBe(priv.occUniforms.uOccCam);
      expect(shader.uniforms.uOccSubject).toBe(priv.occUniforms.uOccSubject);
      expect(shader.uniforms.uOccFade).toBe(priv.occUniforms.uOccFade);
    }
  });

  it('standing at a lamp with the camera beyond it: that lamp dissolves, leaves the contact shadows, and comes back', () => {
    const lamp = first('lamp');
    const q = W.layout.props[lamp]!;
    const versions = meshesOf(lamp).map((m) => (m.material as THREE.Material).version);
    // The player 1 m past the pole, the camera 3 m behind it on the same line.
    const head = v(q.x + 1, q.y + 1.6, q.z);
    const camAt = v(q.x - 3, q.y + 2.3, q.z);
    const on = props.setOccluderView(camAt, head);
    expect(on).toContain(lamp);
    expect(priv.occUniforms.uOccFade.value.toArray()).toEqual([...OCCLUDER_FADE_EDGES]);
    expect(priv.occUniforms.uOccCam.value.toArray()).toEqual([camAt.x, camAt.y, camAt.z]);
    for (const m of meshesOf(lamp)) expect(m.userData.contactShadow).toBe(false);
    // The contact-shadow pass leaves such a batch out of its depth and normal draws (revised for track D: the pass
    // picks draws from the frame's render list with shadesContact instead of hiding objects for a second walk).
    const flagged = meshesOf(lamp)[0]!;
    flagged.updateMatrixWorld(true);
    const at = new THREE.Vector3(q.x, q.y, q.z);
    expect(shadesContact({ object: flagged, geometry: flagged.geometry, material: flagged.material as THREE.Material, group: null }, at, 110)).toBe(false);
    expect(flagged.visible).toBe(true);
    // Stepping 3 m to the side: drawn in full and back in the contact shadows.
    expect(props.setOccluderView(v(camAt.x, camAt.y, camAt.z + 3), v(head.x, head.y, head.z + 3))).not.toContain(lamp);
    for (const m of meshesOf(lamp)) expect(m.userData.contactShadow).toBeUndefined();
    // Off (title screen): the fade edges are all negative, so the shader keeps everything.
    expect(props.setOccluderView(camAt, null)).toEqual([]);
    expect(Math.max(...priv.occUniforms.uOccFade.value.toArray())).toBeLessThan(0);
    // None of it compiled anything new.
    expect(meshesOf(lamp).map((m) => (m.material as THREE.Material).version)).toEqual(versions);
  });

  it('a knocked-over signal dissolves along its fallen axis, a knocked-down lamp no more, and a new game stands them up', () => {
    const sig = first('signal');
    const lamp = first('lamp');
    const s = W.layout.props[sig]!;
    const l = W.layout.props[lamp]!;
    props.breakProp(sig, 1, 0);
    props.breakProp(lamp, 1, 0);
    // The signal lies along +x: a camera 3 m out along it, 1 m up, looking back at a head beyond its foot.
    expect(props.setOccluderView(v(s.x + 3, s.y + 0.6, s.z - 0.5), v(s.x + 3, s.y + 0.6, s.z + 3))).toContain(sig);
    expect(props.setOccluderView(v(l.x - 3, l.y + 2.3, l.z), v(l.x + 1, l.y + 1.6, l.z))).not.toContain(lamp);
    props.restoreAll();
    expect(props.setOccluderView(v(s.x + 3, s.y + 0.6, s.z - 0.5), v(s.x + 3, s.y + 0.6, s.z + 3))).not.toContain(sig);
    expect(props.setOccluderView(v(l.x - 3, l.y + 2.3, l.z), v(l.x + 1, l.y + 1.6, l.z))).toContain(lamp);
  });
});

describe('the floating diamond of the marker he stands in fades while he aims there', () => {
  const m = { id: 'save:t', kind: 'save' as const, x: 0, z: 0, radius: 1.5, label: '', color: 0x55ccff, ref: '' };
  /** The diamond's opacity, size and material after `frames` frames at 60 fps, the camera 2.4 m behind him as when aiming. */
  function diamond(view: MarkerView, player: { x: number; z: number }, aiming: boolean, frames: number, t0: number) {
    let t = t0;
    for (let i = 0; i < frames; i++) {
      t += 1 / 60;
      view.syncMarkers([m], t, { x: player.x - 0.62, y: 2.0, z: player.z - 2.4 }, player, aiming);
    }
    const g = view.group.children[0]!;
    const icon = g.getObjectByName('icon') as THREE.Mesh;
    const mat = icon.material as THREE.MeshStandardMaterial;
    return {
      opacity: icon.visible ? mat.opacity : 0,
      scale: icon.scale.x,
      mat,
      beam: ((g.getObjectByName('beam') as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity,
      t,
    };
  }

  it('in a marker: faded out by opacity within about a fifth of a second of aiming, back once he lets go, the beam untouched', () => {
    const view = new MarkerView();
    const at = { x: 0.3, z: 0.2 };
    let d = diamond(view, at, false, 30, 0);
    expect(d.opacity).toBe(1);
    expect(d.scale).toBe(1);
    expect(d.mat.depthWrite).toBe(true);
    const mat = d.mat;
    const version = mat.version;
    d = diamond(view, at, true, 3, d.t);
    // Fading, not popping.
    expect(d.opacity).toBeLessThan(1);
    expect(d.opacity).toBeGreaterThan(0.5);
    expect(d.mat.depthWrite).toBe(false);
    // Not after 0.1 s, but by 0.25 s.
    d = diamond(view, at, true, 3, d.t);
    expect(d.opacity).toBeGreaterThan(0);
    d = diamond(view, at, true, 9, d.t);
    expect(d.opacity).toBe(0);
    // It fades rather than shrinking away.
    expect(d.scale).toBeGreaterThanOrEqual(0.75);
    expect(d.beam).toBe(0.28);
    d = diamond(view, at, false, 15, d.t);
    expect(d.opacity).toBe(1);
    expect(d.scale).toBe(1);
    expect(d.mat.depthWrite).toBe(true);
    // The same always-transparent material throughout: no new shader program for the fade.
    expect(d.mat).toBe(mat);
    expect(mat.transparent).toBe(true);
    expect(mat.version).toBe(version);
  });

  it('aiming outside a marker leaves its diamond alone, and stepping out while aiming brings it back', () => {
    const view = new MarkerView();
    // 6 m away, the camera far from it: drawn in full whether or not he aims.
    let d = diamond(view, { x: 0, z: -6 }, true, 30, 0);
    expect(d.opacity).toBe(1);
    // In it and aiming: faded out.
    d = diamond(view, { x: 0, z: 0 }, true, 30, d.t);
    expect(d.opacity).toBe(0);
    // Walked well out of it, still aiming, with the camera far from it again: back in full.
    d = diamond(view, { x: 0, z: -7 }, true, 30, d.t);
    expect(d.opacity).toBe(1);
  });

  it('one marker fading leaves another of the same colour solid', () => {
    const view = new MarkerView();
    const other = { ...m, id: 'save:u', x: 30 };
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += 1 / 60;
      view.syncMarkers([m, other], t, { x: -0.62, y: 2.0, z: -2.4 }, { x: 0, z: 0 }, true);
    }
    const [a, b] = view.group.children.map((g) => (g.getObjectByName('icon') as THREE.Mesh).material as THREE.MeshStandardMaterial);
    expect(a!.opacity).toBe(0);
    expect(b!.opacity).toBe(1);
  });
});
