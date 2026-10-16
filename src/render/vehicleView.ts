// Vehicle meshes built from extruded side profiles, plus per-vehicle views
// that follow the simulation (wheels, lights, sirens, damage).

import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { Vehicle } from '../sim/entities';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import { taxiSignTexture } from './textures';

type Pt = [number, number];

const BEVEL = 0.07;

interface Profile {
  body: Pt[];
  cabin: Pt[];
  /** Positive: cabin narrower than the body. Negative: glass panels stick out slightly. */
  cabinInset: number;
  wheelR: number;
  wheelFront: number;
  wheelRear: number;
  lightY: number;
}

function profile(kind: VehicleKind): Profile {
  const s = VEHICLE_SPECS[kind];
  const L = s.length;
  const H = s.height;
  const P = (pts: Array<[number, number]>): Pt[] => pts.map(([x, y]) => [x * L, y * H]);
  switch (kind) {
    case 'compact':
      return { body: P([[-0.5, 0.22], [0.49, 0.22], [0.5, 0.4], [0.47, 0.56], [0.24, 0.62], [-0.46, 0.63], [-0.5, 0.5]]), cabin: P([[0.25, 0.61], [0.07, 0.98], [-0.39, 0.98], [-0.47, 0.62]]), cabinInset: 0.1, wheelR: 0.31, wheelFront: 0.33, wheelRear: -0.32, lightY: 0.45 };
    case 'sports':
      return { body: P([[-0.5, 0.2], [0.5, 0.2], [0.5, 0.36], [0.32, 0.52], [-0.4, 0.62], [-0.5, 0.52]]), cabin: P([[0.22, 0.55], [0.02, 0.97], [-0.2, 0.97], [-0.4, 0.61]]), cabinInset: 0.14, wheelR: 0.34, wheelFront: 0.32, wheelRear: -0.31, lightY: 0.38 };
    case 'muscle':
      return { body: P([[-0.5, 0.22], [0.5, 0.22], [0.5, 0.5], [0.14, 0.62], [-0.3, 0.62], [-0.5, 0.56]]), cabin: P([[0.12, 0.61], [-0.02, 0.97], [-0.22, 0.97], [-0.34, 0.61]]), cabinInset: 0.12, wheelR: 0.36, wheelFront: 0.33, wheelRear: -0.31, lightY: 0.45 };
    case 'pickup':
      return { body: P([[-0.5, 0.22], [0.5, 0.22], [0.5, 0.45], [0.45, 0.55], [0.19, 0.58], [-0.5, 0.58]]), cabin: P([[0.18, 0.57], [0.07, 0.97], [-0.13, 0.97], [-0.15, 0.57]]), cabinInset: 0.08, wheelR: 0.42, wheelFront: 0.33, wheelRear: -0.3, lightY: 0.45 };
    case 'van':
      return { body: P([[-0.5, 0.15], [0.5, 0.15], [0.5, 0.4], [0.43, 0.5], [0.3, 0.95], [-0.5, 0.97]]), cabin: P([[0.42, 0.51], [0.31, 0.9], [0.17, 0.9], [0.17, 0.51]]), cabinInset: -0.012, wheelR: 0.38, wheelFront: 0.33, wheelRear: -0.32, lightY: 0.3 };
    case 'swat':
      return { body: P([[-0.5, 0.16], [0.5, 0.16], [0.5, 0.42], [0.42, 0.52], [0.33, 0.95], [-0.5, 0.95]]), cabin: P([[0.41, 0.53], [0.33, 0.85], [0.22, 0.85], [0.22, 0.53]]), cabinInset: -0.012, wheelR: 0.45, wheelFront: 0.33, wheelRear: -0.33, lightY: 0.32 };
    case 'bus':
      return { body: P([[-0.5, 0.12], [0.5, 0.12], [0.5, 0.95], [-0.5, 0.95]]), cabin: P([[0.49, 0.42], [0.49, 0.86], [-0.47, 0.86], [-0.47, 0.42]]), cabinInset: -0.012, wheelR: 0.5, wheelFront: 0.36, wheelRear: -0.3, lightY: 0.22 };
    case 'sedan':
    case 'taxi':
    case 'police':
    default:
      return { body: P([[-0.5, 0.22], [0.49, 0.22], [0.5, 0.38], [0.48, 0.56], [0.2, 0.64], [-0.32, 0.64], [-0.49, 0.58], [-0.5, 0.4]]), cabin: P([[0.21, 0.63], [0.03, 0.98], [-0.22, 0.98], [-0.36, 0.63]]), cabinInset: 0.1, wheelR: 0.34, wheelFront: 0.32, wheelRear: -0.3, lightY: 0.45 };
  }
}

function extrude(pts: Pt[], width: number, bevel: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i]![0], pts[i]![1]);
  shape.closePath();
  const depth = Math.max(0.05, width - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 1 });
  // Shape x (length) -> world +Z, extrusion -> world X, centred.
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

interface KindAssets {
  body: THREE.BufferGeometry;
  cabin: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  lamp: THREE.BufferGeometry;
  prof: Profile;
}

const assets = new Map<VehicleKind, KindAssets>();

function kindAssets(kind: VehicleKind): KindAssets {
  let a = assets.get(kind);
  if (a) return a;
  const s = VEHICLE_SPECS[kind];
  const prof = profile(kind);
  const body = extrude(prof.body, s.width, BEVEL);
  const cabin = extrude(prof.cabin, s.width - prof.cabinInset * 2, prof.cabinInset > 0 ? 0.05 : 0.01);
  const wheel = new THREE.CylinderGeometry(prof.wheelR, prof.wheelR, 0.26, 16);
  wheel.rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(prof.wheelR * 0.62, prof.wheelR * 0.62, 0.28, 10);
  rim.rotateZ(Math.PI / 2);
  const lamp = new THREE.BoxGeometry(0.34, 0.14, 0.06);
  a = { body, cabin, wheel, rim, lamp, prof };
  assets.set(kind, a);
  return a;
}

// Shared materials.
const glassMat = new THREE.MeshStandardMaterial({ color: 0x141c26, roughness: 0.06, metalness: 0.9, envMapIntensity: 1.6 });
const tireMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0xc4c6c8, roughness: 0.3, metalness: 0.9 });
const burntMat = new THREE.MeshStandardMaterial({ color: 0x1d1b19, roughness: 1, metalness: 0.1 });
const headMat = new THREE.MeshStandardMaterial({ color: 0xfffbe8, emissive: 0xfff2c8, emissiveIntensity: 0.3, roughness: 0.2 });
const bodyMats = new Map<number, THREE.MeshStandardMaterial>();

function bodyMaterial(color: number): THREE.MeshStandardMaterial {
  let m = bodyMats.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.55, envMapIntensity: 1.25 });
    bodyMats.set(color, m);
  }
  return m;
}

const taxiSignMat = new THREE.MeshStandardMaterial({ map: taxiSignTexture(), emissiveMap: taxiSignTexture(), emissive: 0xffffff, emissiveIntensity: 0.4 });

export class VehicleView {
  readonly group = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly cabin: THREE.Mesh;
  private readonly wheels: Array<{ pivot: THREE.Group; tire: THREE.Mesh; rim: THREE.Mesh; front: boolean }> = [];
  private readonly tailMat = new THREE.MeshStandardMaterial({ color: 0x3a0505, emissive: 0xff1a10, emissiveIntensity: 0.3, roughness: 0.3 });
  private readonly reverseMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
  private sirenRed: THREE.MeshStandardMaterial | null = null;
  private sirenBlue: THREE.MeshStandardMaterial | null = null;
  private leanX = 0;
  private leanZ = 0;
  private lastSpeed = 0;
  private burnt = false;
  color = -1;

  constructor(readonly kind: VehicleKind) {
    const a = kindAssets(kind);
    const s = VEHICLE_SPECS[kind];
    this.body = new THREE.Mesh(a.body, bodyMaterial(0xffffff));
    this.cabin = new THREE.Mesh(a.cabin, glassMat);
    this.body.castShadow = true;
    this.cabin.castShadow = true;
    this.body.receiveShadow = true;
    this.group.add(this.body, this.cabin);
    const halfW = s.width / 2;
    for (const [front, z] of [[true, a.prof.wheelFront * s.length], [false, a.prof.wheelRear * s.length]] as const) {
      for (const side of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(side * (halfW - 0.1), a.prof.wheelR, z);
        const tire = new THREE.Mesh(a.wheel, tireMat);
        const rim = new THREE.Mesh(a.rim, rimMat);
        tire.castShadow = true;
        pivot.add(tire, rim);
        this.group.add(pivot);
        this.wheels.push({ pivot, tire, rim, front });
      }
    }
    // Lights sit just outside the bevelled body surface so they are never buried.
    const ly = a.prof.lightY * s.height;
    const front = s.length / 2 + BEVEL + 0.02;
    for (const side of [-1, 1]) {
      const h = new THREE.Mesh(a.lamp, headMat);
      h.position.set(side * (halfW - 0.32), ly, front);
      const t = new THREE.Mesh(a.lamp, this.tailMat);
      t.position.set(side * (halfW - 0.3), ly + 0.05, -front);
      this.group.add(h, t);
    }
    const rev = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.05), this.reverseMat);
    rev.position.set(0, ly - 0.05, -front);
    this.group.add(rev);
    if (s.police) {
      const red = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff0000, emissiveIntensity: 0, roughness: 0.3 });
      const blue = new THREE.MeshStandardMaterial({ color: 0x000040, emissive: 0x0040ff, emissiveIntensity: 0, roughness: 0.3 });
      this.sirenRed = red;
      this.sirenBlue = blue;
      const roofY = (kind === 'swat' ? 0.95 : 0.98) * s.height;
      const barZ = kind === 'swat' ? s.length * 0.3 : -0.1 * s.length;
      const base = new THREE.Mesh(new THREE.BoxGeometry(s.width * 0.7, 0.08, 0.32), new THREE.MeshStandardMaterial({ color: 0x222222 }));
      base.position.set(0, roofY + 0.04, barZ);
      const r = new THREE.Mesh(new THREE.BoxGeometry(s.width * 0.32, 0.14, 0.28), red);
      r.position.set(s.width * 0.18, roofY + 0.14, barZ);
      const b = new THREE.Mesh(new THREE.BoxGeometry(s.width * 0.32, 0.14, 0.28), blue);
      b.position.set(-s.width * 0.18, roofY + 0.14, barZ);
      this.group.add(base, r, b);
      if (kind === 'police') {
        // White doors livery stripe.
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(s.width + 0.02, 0.3, s.length * 0.42), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4, metalness: 0.3 }));
        stripe.position.set(0, s.height * 0.45, 0.02 * s.length);
        this.group.add(stripe);
      }
    }
    if (kind === 'taxi') {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.22, 0.32), [taxiSignMat, taxiSignMat, taxiSignMat, taxiSignMat, taxiSignMat, taxiSignMat]);
      sign.position.set(0, s.height * 0.98 + 0.12, -0.08 * s.length);
      this.group.add(sign);
    }
    this.group.rotation.order = 'YXZ';
  }

  bind(v: Vehicle): void {
    this.setBurnt(false);
    this.color = -1;
    this.leanX = 0;
    this.leanZ = 0;
    this.lastSpeed = v.forwardSpeed;
    this.group.visible = true;
  }

  private setBurnt(b: boolean): void {
    if (this.burnt === b) return;
    this.burnt = b;
    this.cabin.material = b ? burntMat : glassMat;
    for (const w of this.wheels) {
      w.tire.visible = !b;
      w.rim.material = b ? burntMat : rimMat;
    }
    if (b) {
      this.body.material = burntMat;
      this.color = -1;
    }
  }

  sync(v: Vehicle, dt: number, time: number, night: number): void {
    if (v.destroyed) this.setBurnt(true);
    else if (this.color !== v.color) {
      this.setBurnt(false);
      this.body.material = bodyMaterial(v.color);
      this.color = v.color;
    }
    // Body lean from acceleration and cornering.
    const acc = dt > 0 ? (v.forwardSpeed - this.lastSpeed) / dt : 0;
    this.lastSpeed = v.forwardSpeed;
    const lat = v.angVel * v.forwardSpeed;
    const onGround = !v.airborne && !v.inWater;
    this.leanX = damp(this.leanX, onGround ? clamp(acc * 0.006, -0.07, 0.07) : 0, 8, dt);
    this.leanZ = damp(this.leanZ, onGround ? clamp(-lat * 0.006, -0.09, 0.09) : 0, 8, dt);
    this.group.position.set(v.pos.x, v.pos.y, v.pos.z);
    this.group.rotation.set(-v.pitch + this.leanX, v.heading, v.roll + this.leanZ);

    const steerAngle = -v.steer * v.spec.steer * 0.85;
    for (const w of this.wheels) {
      if (w.front) w.pivot.rotation.y = steerAngle;
      w.tire.rotation.x = v.wheelSpin;
      w.rim.rotation.x = v.wheelSpin;
    }
    const lightsOn = night > 0.35 && !v.destroyed && v.driver !== null;
    headMat.emissiveIntensity = 0.4 + night * 5;
    this.tailMat.emissiveIntensity = v.destroyed ? 0 : v.braking ? 6 : lightsOn ? 2.2 : 0.3;
    this.reverseMat.emissiveIntensity = v.reversing && v.driver ? 4 : 0;
    if (this.sirenRed && this.sirenBlue) {
      const on = v.siren && !v.destroyed;
      const phase = Math.floor(time * 6) % 2 === 0;
      this.sirenRed.emissiveIntensity = on && phase ? 9 : 0.1;
      this.sirenBlue.emissiveIntensity = on && !phase ? 9 : 0.1;
    }
  }
}

/** Pools vehicle views per kind so meshes are reused instead of rebuilt. */
export class VehicleViewPool {
  private readonly free = new Map<VehicleKind, VehicleView[]>();

  acquire(kind: VehicleKind): VehicleView {
    const list = this.free.get(kind);
    const v = list?.pop();
    return v ?? new VehicleView(kind);
  }

  release(view: VehicleView): void {
    view.group.visible = false;
    let list = this.free.get(view.kind);
    if (!list) {
      list = [];
      this.free.set(view.kind, list);
    }
    list.push(view);
  }
}

export function vehicleMaterials(): { head: THREE.MeshStandardMaterial } {
  return { head: headMat };
}
