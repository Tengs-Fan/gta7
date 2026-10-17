// Interaction markers, objective beams/arrows, pickups and helicopters.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Objective } from '../sim/activities';
import type { Helicopter, Pickup, PickupKind } from '../sim/entities';
import type { Marker } from '../sim/interactions';
import { beamTexture, glowTexture } from './textures';

const beamTex = beamTexture();
const glowTex = glowTexture();

/** Helicopter spotlight: beam opacity at the lamp, the camera distance from the beam's axis inside which it vanishes, and the fade-in width. */
const SPOT_ALPHA = 0.1;
const SPOT_CLEAR = 6;
const SPOT_FADE = 4;
/** Opacity of the pool of light on the ground (see buildHeli). */
const SPOT_POOL = 0.1;

/**
 * How visible the spotlight beam is from a camera at `cam`, for a beam from `a` (the lamp) to `b`: 0
 * within SPOT_CLEAR m of its axis (the camera is in the light, where a glowing cone would only wash out
 * the screen), fully visible SPOT_FADE m further out.
 */
export function beamFade(cam: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 1e-9 ? THREE.MathUtils.clamp(((cam.x - a.x) * abx + (cam.y - a.y) * aby + (cam.z - a.z) * abz) / l2, 0, 1) : 0;
  const d = Math.hypot(cam.x - (a.x + abx * t), cam.y - (a.y + aby * t), cam.z - (a.z + abz * t));
  return THREE.MathUtils.clamp((d - SPOT_CLEAR) / SPOT_FADE, 0, 1);
}

/** The beam: additive, front faces only, unfogged, brightest at the lamp and gone at the ground. */
function spotlightMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xeef4ff) }, uAlpha: { value: SPOT_ALPHA }, uFade: { value: 1 } },
    vertexShader: /* glsl */ `
      varying float vAlong;
      void main() {
        // The cone runs from the lamp (y = 0) to the ground (y = -1) before scaling.
        vAlong = clamp(-position.y, 0.0, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uFade;
      varying float vAlong;
      void main() {
        // (1 - v)^1.5, kept off pow(): interpolation can push v a hair past 1, and pow() of a negative
        // number is NaN, which the bloom pass would smear over the whole frame.
        float k = clamp(1.0 - vAlong, 0.0, 1.0);
        gl_FragColor = vec4(uColor, uAlpha * k * sqrt(k) * uFade);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    depthWrite: false,
    fog: false,
  });
}

const fadeCam = new THREE.Vector3();
const fadeA = new THREE.Vector3();
const fadeB = new THREE.Vector3();

/** Before each draw of a beam (per camera, so reflections get their own), fades it by that camera's distance from its axis. */
function fadeBeam(cone: THREE.Mesh, camera: THREE.Camera): void {
  fadeCam.setFromMatrixPosition(camera.matrixWorld);
  fadeA.set(0, 0, 0).applyMatrix4(cone.matrixWorld);
  fadeB.set(0, -1, 0).applyMatrix4(cone.matrixWorld);
  const m = cone.material as THREE.ShaderMaterial;
  m.uniforms.uFade!.value = beamFade(fadeCam, fadeA, fadeB);
  m.uniformsNeedUpdate = true;
}

function beamMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map: beamTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
}

function iconGeometry(kind: PickupKind): THREE.BufferGeometry {
  const m = (gs: THREE.BufferGeometry[]) => {
    const r = mergeGeometries(gs.map((g) => g.toNonIndexed()), false);
    if (!r) throw new Error('merge failed');
    return r;
  };
  switch (kind) {
    case 'health':
      return m([new THREE.BoxGeometry(0.62, 0.2, 0.2), new THREE.BoxGeometry(0.2, 0.62, 0.2)]);
    case 'armor':
      return new THREE.OctahedronGeometry(0.36, 0);
    case 'weapon':
      return m([new THREE.BoxGeometry(0.12, 0.16, 0.7).translate(0, 0.05, 0), new THREE.BoxGeometry(0.1, 0.28, 0.12).translate(0, -0.12, -0.12)]);
    case 'money':
      return m([new THREE.BoxGeometry(0.5, 0.22, 0.3), new THREE.BoxGeometry(0.52, 0.06, 0.1).translate(0, 0.12, 0)]);
    case 'package':
      return m([new THREE.BoxGeometry(0.45, 0.45, 0.45), new THREE.BoxGeometry(0.47, 0.1, 0.47)]);
    case 'rampage':
      return m([new THREE.SphereGeometry(0.3, 10, 8), new THREE.BoxGeometry(0.34, 0.2, 0.3).translate(0, -0.25, 0.02)]);
    case 'parcel':
      // A taped cardboard box.
      return m([
        new THREE.BoxGeometry(0.62, 0.42, 0.46),
        new THREE.BoxGeometry(0.64, 0.05, 0.12).translate(0, 0.2, 0),
        new THREE.BoxGeometry(0.1, 0.44, 0.48).translate(0.18, 0, 0),
        new THREE.BoxGeometry(0.1, 0.44, 0.48).translate(-0.18, 0, 0),
      ]);
  }
}

const ICON_COLOR: Record<PickupKind, number> = {
  health: 0xff3a3a,
  armor: 0x4aa8ff,
  weapon: 0xd8d8d8,
  money: 0x3fd96b,
  package: 0xf5c542,
  rampage: 0xd01818,
  parcel: 0x8a5a2c,
};

export class MarkerView {
  readonly group = new THREE.Group();
  private readonly markerViews = new Map<string, THREE.Group>();
  private readonly objectivePool: THREE.Group[] = [];
  private readonly arrowPool: THREE.Mesh[] = [];
  private readonly pickupViews = new Map<number, THREE.Group>();
  private readonly heliViews = new Map<number, { g: THREE.Group; rotor: THREE.Object3D; tail: THREE.Object3D; cone: THREE.Mesh; pool: THREE.Mesh }>();
  // Views come and go as things stream in and out of range; their geometry and materials are
  // shared so a returning view uploads nothing new (and nothing has to be disposed).
  private readonly beamGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true).translate(0, 0.5, 0);
  private readonly arrowGeo = new THREE.ConeGeometry(0.45, 0.9, 4).rotateX(Math.PI);
  private readonly markerIconGeo = new THREE.OctahedronGeometry(0.32, 0);
  private readonly markerMats = new Map<number, { beam: THREE.MeshBasicMaterial; icon: THREE.MeshStandardMaterial }>();
  private readonly iconGeos = new Map<PickupKind, THREE.BufferGeometry>();
  private readonly iconMats = new Map<PickupKind, THREE.MeshStandardMaterial>();
  private readonly glowMats = new Map<number, THREE.SpriteMaterial>();
  /** Helicopter built once; each view is a clone sharing its geometry and materials. */
  private heliTemplate: { g: THREE.Group; cone: THREE.Mesh; pool: THREE.Mesh } | null = null;

  private glowSprite(color: number, size: number): THREE.Sprite {
    let mat = this.glowMats.get(color);
    if (!mat) {
      mat = new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.45 });
      this.glowMats.set(color, mat);
    }
    const s = new THREE.Sprite(mat);
    s.scale.set(size, size, size);
    return s;
  }

  syncMarkers(markers: readonly Marker[], time: number): void {
    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.id);
      let g = this.markerViews.get(m.id);
      if (!g) {
        g = new THREE.Group();
        let mats = this.markerMats.get(m.color);
        if (!mats) {
          mats = { beam: beamMaterial(m.color, 0.28), icon: new THREE.MeshStandardMaterial({ color: m.color, emissive: m.color, emissiveIntensity: 1.2, roughness: 0.3 }) };
          this.markerMats.set(m.color, mats);
        }
        const beam = new THREE.Mesh(this.beamGeo, mats.beam);
        beam.scale.set(1.1, 1.3, 1.1);
        const icon = new THREE.Mesh(this.markerIconGeo, mats.icon);
        icon.position.y = 1.7;
        icon.name = 'icon';
        g.add(beam, icon);
        this.markerViews.set(m.id, g);
        this.group.add(g);
      }
      g.position.set(m.x, 0.15, m.z);
      const icon = g.getObjectByName('icon');
      if (icon) {
        icon.rotation.y = time * 2;
        icon.position.y = 1.7 + Math.sin(time * 3) * 0.12;
      }
    }
    for (const [id, g] of this.markerViews) {
      if (!seen.has(id)) {
        this.group.remove(g);
        this.markerViews.delete(id);
      }
    }
  }

  syncObjectives(objs: readonly Objective[], groundAt: (x: number, z: number) => number, time: number): void {
    let beams = 0;
    let arrows = 0;
    for (const o of objs) {
      const target = o.vehicle ?? o.character ?? null;
      if (target && !target.removed) {
        const arrow = this.arrowPool[arrows] ?? this.newArrow();
        arrows++;
        const h = 'spec' in target ? target.spec.height + 1.6 : target.height + 0.9;
        arrow.position.set(target.pos.x, target.pos.y + h + Math.sin(time * 4) * 0.2, target.pos.z);
        arrow.rotation.y = time * 2.5;
        (arrow.material as THREE.MeshStandardMaterial).color.setHex(o.color);
        (arrow.material as THREE.MeshStandardMaterial).emissive.setHex(o.color);
        arrow.visible = true;
      } else if (!target) {
        const g = this.objectivePool[beams] ?? this.newBeam();
        beams++;
        g.position.set(o.x, groundAt(o.x, o.z), o.z);
        g.scale.set(Math.max(1.2, o.radius), 1, Math.max(1.2, o.radius));
        const beam = g.children[0] as THREE.Mesh;
        (beam.material as THREE.MeshBasicMaterial).color.setHex(o.color);
        (beam.material as THREE.MeshBasicMaterial).opacity = 0.45 + Math.sin(time * 3) * 0.08;
        g.visible = true;
      }
    }
    for (let i = beams; i < this.objectivePool.length; i++) this.objectivePool[i]!.visible = false;
    for (let i = arrows; i < this.arrowPool.length; i++) this.arrowPool[i]!.visible = false;
  }

  private newBeam(): THREE.Group {
    const g = new THREE.Group();
    const beam = new THREE.Mesh(this.beamGeo, beamMaterial(0xffd23d, 0.5));
    beam.scale.set(1, 7, 1);
    g.add(beam);
    this.objectivePool.push(g);
    this.group.add(g);
    return g;
  }

  private newArrow(): THREE.Mesh {
    const a = new THREE.Mesh(this.arrowGeo, new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff3b3b, emissiveIntensity: 1.5, roughness: 0.3 }));
    this.arrowPool.push(a);
    this.group.add(a);
    return a;
  }

  syncPickups(pickups: readonly Pickup[], time: number, camX: number, camZ: number): void {
    const seen = new Set<number>();
    for (const p of pickups) {
      if (p.removed || !p.active) continue;
      if ((p.pos.x - camX) ** 2 + (p.pos.z - camZ) ** 2 > 160 * 160) continue;
      seen.add(p.id);
      let g = this.pickupViews.get(p.id);
      if (!g) {
        g = new THREE.Group();
        let mat = this.iconMats.get(p.kind);
        if (!mat) {
          const c = ICON_COLOR[p.kind];
          mat = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: p.kind === 'weapon' ? 0.4 : 0.9, roughness: 0.35, metalness: p.kind === 'weapon' ? 0.7 : 0.1 });
          this.iconMats.set(p.kind, mat);
        }
        let geo = this.iconGeos.get(p.kind);
        if (!geo) {
          geo = iconGeometry(p.kind);
          this.iconGeos.set(p.kind, geo);
        }
        const icon = new THREE.Mesh(geo, mat);
        icon.name = 'icon';
        icon.castShadow = true;
        g.add(icon, this.glowSprite(ICON_COLOR[p.kind], p.kind === 'package' ? 2.2 : 1.6));
        this.pickupViews.set(p.id, g);
        this.group.add(g);
      }
      g.position.set(p.pos.x, p.pos.y + 0.8 + Math.sin(time * 2.5 + p.bob) * 0.12, p.pos.z);
      const icon = g.children[0]!;
      icon.rotation.y = time * 1.8 + p.bob;
      g.visible = true;
    }
    for (const [id, g] of this.pickupViews) {
      if (!seen.has(id)) {
        this.group.remove(g);
        this.pickupViews.delete(id);
      }
    }
  }

  syncHelis(helis: readonly Helicopter[], night: number, groundAt: (x: number, z: number) => number): void {
    const seen = new Set<number>();
    for (const h of helis) {
      if (h.removed) continue;
      seen.add(h.id);
      let v = this.heliViews.get(h.id);
      if (!v) v = this.newHeli(h.id);
      v.g.position.set(h.pos.x, h.pos.y, h.pos.z);
      v.g.rotation.set(h.crashing ? Math.sin(h.rotor * 0.3) * 0.4 : -h.vel.z * 0.0, h.heading, 0);
      v.rotor.rotation.y = h.rotor;
      v.tail.rotation.x = h.rotor * 1.6;
      const showLight = night > 0.25 && !h.destroyed;
      v.cone.visible = showLight;
      v.pool.visible = showLight;
      if (showLight) {
        const gy = groundAt(h.spotlight.x, h.spotlight.z);
        const dx = h.spotlight.x - h.pos.x;
        const dy = gy - (h.pos.y - 1);
        const dz = h.spotlight.z - h.pos.z;
        const len = Math.hypot(dx, dy, dz);
        v.cone.position.set(h.pos.x, h.pos.y - 1, h.pos.z);
        v.cone.scale.set(1, len, 1);
        v.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
        v.pool.position.set(h.spotlight.x, gy + 0.08, h.spotlight.z);
      }
    }
    for (const [id, v] of this.heliViews) {
      if (!seen.has(id)) {
        this.group.remove(v.g, v.cone, v.pool);
        (v.cone.material as THREE.Material).dispose();
        this.heliViews.delete(id);
      }
    }
  }

  private newHeli(id: number) {
    const t = (this.heliTemplate ??= this.buildHeli());
    // clone() shares geometry and materials; transforms and visibility stay per view. The beam has
    // its own material (same shader program) because its fade depends on where it is.
    const g = t.g.clone();
    const cone = t.cone.clone();
    cone.material = (t.cone.material as THREE.ShaderMaterial).clone();
    cone.onBeforeRender = (_r, _s, camera) => fadeBeam(cone, camera);
    const pool = t.pool.clone();
    this.group.add(g, cone, pool);
    const v = { g, rotor: g.getObjectByName('rotor')!, tail: g.getObjectByName('tailRotor')!, cone, pool };
    this.heliViews.set(id, v);
    return v;
  }

  private buildHeli(): { g: THREE.Group; cone: THREE.Mesh; pool: THREE.Mesh } {
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d2a44, roughness: 0.4, metalness: 0.4 });
    const white = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.4, metalness: 0.3 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x112233, roughness: 0.05, metalness: 0.9 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 10).scale(1, 0.85, 1.7), dark);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8).scale(1, 0.8, 1).translate(0, 0.1, 1.5), glass);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.05, 0.35, 2.4), white);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.4, 5.5).translate(0, 0.3, -4.2), dark);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.2, 0.8).translate(0, 0.9, -6.7), dark);
    const skids = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.4).translate(0.9, -1.35, 0), dark);
    const skids2 = skids.clone();
    skids2.position.x = -1.8;
    const rotor = new THREE.Group();
    rotor.name = 'rotor';
    rotor.position.y = 1.45;
    rotor.add(new THREE.Mesh(new THREE.BoxGeometry(11, 0.06, 0.32), dark), new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.06, 11), dark));
    const tailRotor = new THREE.Group();
    tailRotor.name = 'tailRotor';
    tailRotor.position.set(0.25, 0.9, -6.7);
    tailRotor.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.8, 0.18), dark));
    g.add(body, nose, stripe, tail, fin, skids, skids2, rotor, tailRotor);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    g.rotation.order = 'YXZ';
    const coneGeo = new THREE.ConeGeometry(4.5, 1, 20, 1, true).translate(0, -0.5, 0);
    const cone = new THREE.Mesh(coneGeo, spotlightMaterial());
    // The pool only marks where the light points: added to a dark night street, more than this lights up
    // the ground around an unlit player and makes him a black silhouette (0.35 put the frame at 1.46x).
    const pool = new THREE.Mesh(new THREE.CircleGeometry(3.5, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glowTex, color: 0xeef4ff, transparent: true, opacity: SPOT_POOL, blending: THREE.AdditiveBlending, depthWrite: false }));
    return { g, cone, pool };
  }
}
