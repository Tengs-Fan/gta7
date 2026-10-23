// Motorbikes (class 'bike'), drawn by their own view: a frame and bodywork in the bike's paint, the engine, seat and
// running gear, two spinning wheels, the front fork turning with the steering, and head and tail lamps. The whole bike
// leans into turns about its tyres' contact line (Vehicle.lean) and lifts its front about the rear tyre in a wheelie
// (Vehicle.wheelie); riders sit in its frame (riders.ts, posed by CrowdView). Built from a few shared geometries per
// kind, so it costs about ten draws and keeps the same look on every tier.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vehicle } from '../sim/entities';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import { steerLimit } from '../sim/vehiclePhysics';
import type { LampGlow } from './lightSprites';
import { setRiderMount, type RiderMount, type RiderSeatLayout } from './riders';

/** Tail lamp emissive intensity braking, with running lights on, and off (as VehicleView's). */
const BRAKE_GLOW = 1.8;
const TAIL_RUNNING = 1.0;
const TAIL_OFF = 0.3;

type Style = 'sport' | 'scooter';

interface BikeModel {
  wheelR: number;
  rearZ: number;
  frontZ: number;
  /** Steering head (where the fork pivots) and the fork's rake back from vertical. */
  headY: number;
  headZ: number;
  rake: number;
  painted: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  chrome: THREE.BufferGeometry;
  /** Fork, bars and (scooter) front shield trim, in the steering head's frame (y down the fork, z forward). */
  fork: THREE.BufferGeometry;
  tyre: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  lamp: THREE.BufferGeometry;
  headLamp: THREE.Vector3;
  /** The head lamp sits on the bars (scooter) and turns with them, or on the fairing. */
  headOnFork: boolean;
  tailLamp: THREE.Vector3;
  seats: RiderSeatLayout[];
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  return g.translate(x, y, z);
}

/** A cylinder of radius r from a to b (y, z in the bike's side plane, x across). */
function rod(r: number, x: number, ay: number, az: number, by: number, bz: number): THREE.BufferGeometry {
  const len = Math.hypot(by - ay, bz - az);
  const g = new THREE.CylinderGeometry(r, r, len, 8);
  // The cylinder's axis is y; tilt it into the side plane towards (by - ay, bz - az).
  g.rotateX(Math.atan2(bz - az, by - ay));
  return g.translate(x, (ay + by) / 2, (az + bz) / 2);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  if (!m) throw new Error('bike geometry merge failed');
  m.computeVertexNormals();
  return m;
}

const P = (x: number, y: number, z: number) => ({ x, y, z });

function sportModel(): BikeModel {
  const wheelR = 0.31;
  const rearZ = -0.7;
  const frontZ = 0.72;
  const headY = 0.98;
  const headZ = 0.5;
  const rake = Math.atan2(frontZ - headZ, headY - wheelR);
  return {
    wheelR,
    rearZ,
    frontZ,
    headY,
    headZ,
    rake,
    painted: merge([
      box(0.34, 0.22, 0.5, 0, 0.95, 0.12, 0.08),
      box(0.44, 0.4, 0.34, 0, 0.82, 0.55, -0.55),
      box(0.26, 0.15, 0.55, 0, 0.92, -0.52, -0.22),
      box(0.3, 0.18, 0.62, 0, 0.47, 0.06),
      box(0.12, 0.28, 0.32, 0.17, 0.66, 0.1),
      box(0.12, 0.28, 0.32, -0.17, 0.66, 0.1),
    ]),
    dark: merge([
      box(0.32, 0.3, 0.44, 0, 0.58, -0.02),
      box(0.27, 0.07, 0.42, 0, 1.03, -0.3, -0.1),
      box(0.06, 0.07, 0.62, 0.13, 0.38, -0.4, 0.12),
      box(0.06, 0.07, 0.62, -0.13, 0.38, -0.4, 0.12),
      box(0.24, 0.16, 0.06, 0, 1.05, 0.66, -0.9),
      box(0.05, 0.05, 0.22, 0.2, 0.45, -0.1),
      box(0.05, 0.05, 0.22, -0.2, 0.45, -0.1),
    ]),
    chrome: merge([rod(0.055, -0.2, 0.5, -0.25, 0.62, -0.82), rod(0.045, 0.2, 0.52, -0.2, 0.5, 0.2)]),
    fork: merge([
      rod(0.03, 0.1, 0, 0, -(headY - wheelR) / Math.cos(rake), 0),
      rod(0.03, -0.1, 0, 0, -(headY - wheelR) / Math.cos(rake), 0),
      box(0.62, 0.035, 0.035, 0, 0.06, -0.06),
      box(0.12, 0.05, 0.08, 0, 0.02, -0.02),
    ]),
    tyre: new THREE.TorusGeometry(wheelR - 0.06, 0.06, 8, 22).rotateY(Math.PI / 2),
    rim: new THREE.CylinderGeometry(wheelR - 0.09, wheelR - 0.09, 0.07, 14).rotateZ(Math.PI / 2),
    lamp: new THREE.BoxGeometry(0.16, 0.09, 0.05),
    headLamp: new THREE.Vector3(0, 0.84, 0.75),
    headOnFork: false,
    tailLamp: new THREE.Vector3(0, 0.95, -0.81),
    seats: [
      { hip: P(0, 1.06, -0.24), recline: -0.6, hands: [P(0.29, 1.05, 0.45), P(-0.29, 1.05, 0.45)], feet: [P(0.2, 0.44, -0.16), P(-0.2, 0.44, -0.16)] },
      { hip: P(0, 1.14, -0.56), recline: -0.25, hands: [P(0.17, 1.2, -0.3), P(-0.17, 1.2, -0.3)], feet: [P(0.21, 0.5, -0.46), P(-0.21, 0.5, -0.46)] },
    ],
  };
}

function scooterModel(): BikeModel {
  const wheelR = 0.22;
  const rearZ = -0.6;
  const frontZ = 0.62;
  const headY = 0.92;
  const headZ = 0.48;
  const rake = Math.atan2(frontZ - headZ, headY - wheelR);
  return {
    wheelR,
    rearZ,
    frontZ,
    headY,
    headZ,
    rake,
    painted: merge([
      box(0.5, 0.62, 0.1, 0, 0.62, 0.42, -0.22),
      box(0.36, 0.07, 0.62, 0, 0.3, 0.0),
      box(0.42, 0.34, 0.72, 0, 0.53, -0.42),
      box(0.22, 0.08, 0.3, 0, 0.36, 0.6, 0.2),
    ]),
    dark: merge([
      box(0.32, 0.08, 0.56, 0, 0.74, -0.36),
      box(0.16, 0.18, 0.46, -0.13, 0.26, -0.5),
      box(0.4, 0.04, 0.6, 0, 0.27, 0.0),
    ]),
    chrome: merge([rod(0.035, -0.15, 0.32, -0.55, 0.36, -0.82)]),
    fork: merge([
      rod(0.04, 0, 0, 0, -(headY - wheelR) / Math.cos(rake), 0),
      box(0.58, 0.035, 0.035, 0, 0.1, -0.04),
      box(0.2, 0.12, 0.14, 0, 0.1, 0.0),
    ]),
    tyre: new THREE.TorusGeometry(wheelR - 0.05, 0.05, 8, 20).rotateY(Math.PI / 2),
    rim: new THREE.CylinderGeometry(wheelR - 0.075, wheelR - 0.075, 0.08, 12).rotateZ(Math.PI / 2),
    lamp: new THREE.BoxGeometry(0.14, 0.08, 0.04),
    headLamp: new THREE.Vector3(0, 0.12, 0.08),
    headOnFork: true,
    tailLamp: new THREE.Vector3(0, 0.6, -0.79),
    seats: [
      { hip: P(0, 0.86, -0.32), recline: 0.05, hands: [P(0.27, 1.02, 0.4), P(-0.27, 1.02, 0.4)], feet: [P(0.13, 0.31, 0.12), P(-0.13, 0.31, 0.12)] },
      { hip: P(0, 0.9, -0.62), recline: 0.1, hands: [P(0.2, 0.95, -0.38), P(-0.2, 0.95, -0.38)], feet: [P(0.15, 0.31, -0.22), P(-0.15, 0.31, -0.22)] },
    ],
  };
}

/** The look of each bike kind; a bike kind with none is drawn as a sport bike. */
const STYLES: Partial<Record<VehicleKind, Style>> = { sportbike: 'sport', scooter: 'scooter' };

const models = new Map<VehicleKind, BikeModel>();
function modelOf(kind: VehicleKind): BikeModel {
  let m = models.get(kind);
  if (!m) {
    m = (STYLES[kind] ?? 'sport') === 'scooter' ? scooterModel() : sportModel();
    models.set(kind, m);
  }
  return m;
}

const tyreMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0x9a9da0, roughness: 0.3, metalness: 0.85 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.65, metalness: 0.2 });
const chromeMat = new THREE.MeshStandardMaterial({ color: 0xd0d2d4, roughness: 0.18, metalness: 0.95 });
const burntMat = new THREE.MeshStandardMaterial({ color: 0x1d1b19, roughness: 1, metalness: 0.1 });
const paints = new Map<number, THREE.MeshStandardMaterial>();
function paint(color: number): THREE.MeshStandardMaterial {
  let m = paints.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.35 });
    paints.set(color, m);
  }
  return m;
}

export class BikeView {
  readonly group = new THREE.Group();
  /** Leans about the tyres' contact line, inside the heading and slope pitch. */
  private readonly leanGroup = new THREE.Group();
  /** Pitches about the rear tyre's contact point in a wheelie. */
  private readonly wheelieGroup = new THREE.Group();
  /** The bike's own frame (+x left, +y up from the ground, +z forward): what riders sit in. */
  private readonly body = new THREE.Group();
  private readonly steerGroup = new THREE.Group();
  private readonly painted: THREE.Mesh;
  private readonly wheels: Array<{ tyre: THREE.Mesh; rim: THREE.Mesh }> = [];
  private readonly parts: THREE.Mesh[] = [];
  private readonly headMat = new THREE.MeshStandardMaterial({ color: 0xfffbe8, emissive: 0xfff2c8, emissiveIntensity: 0.3, roughness: 0.2 });
  private readonly tailMat = new THREE.MeshStandardMaterial({ color: 0x2a0000, emissive: 0xff0000, emissiveIntensity: 0.3, roughness: 0.3 });
  private readonly headLamp: THREE.Mesh;
  private readonly tailLamp: THREE.Mesh;
  private readonly model: BikeModel;
  private readonly mount: RiderMount;
  private readonly tmp = new THREE.Vector3();
  private spin = 0;
  private burnt = false;
  private lit = false;
  private color = -1;
  vehicle: Vehicle | null = null;

  constructor(readonly kind: VehicleKind) {
    const m = modelOf(kind);
    this.model = m;
    this.group.rotation.order = 'YXZ';
    this.group.add(this.leanGroup);
    this.leanGroup.add(this.wheelieGroup);
    this.wheelieGroup.position.z = m.rearZ;
    this.body.position.z = -m.rearZ;
    this.wheelieGroup.add(this.body);
    this.painted = this.mesh(m.painted, paint(0xffffff), 'body');
    this.mesh(m.dark, darkMat, 'frame');
    this.mesh(m.chrome, chromeMat, 'exhaust');
    // The fork turns about the steering head, tilted back by the rake.
    const head = new THREE.Group();
    head.position.set(0, m.headY, m.headZ);
    head.rotation.x = -m.rake;
    head.add(this.steerGroup);
    this.body.add(head);
    this.mesh(m.fork, darkMat, 'fork', this.steerGroup);
    const forkLen = (m.headY - m.wheelR) / Math.cos(m.rake);
    for (const front of [true, false]) {
      const tyre = this.mesh(m.tyre, tyreMat, 'tire', front ? this.steerGroup : this.body);
      const rim = this.mesh(m.rim, rimMat, 'rim', front ? this.steerGroup : this.body);
      if (front) {
        // At the fork's foot, in the steering head's frame (the fork runs down its -y).
        tyre.position.set(0, -forkLen, 0);
        rim.position.set(0, -forkLen, 0);
        tyre.rotation.x = rim.rotation.x = 0;
      } else {
        tyre.position.set(0, m.wheelR, m.rearZ);
        rim.position.set(0, m.wheelR, m.rearZ);
      }
      this.wheels.push({ tyre, rim });
    }
    this.headLamp = this.mesh(m.lamp, this.headMat, 'lamp', m.headOnFork ? this.steerGroup : this.body);
    this.headLamp.position.copy(m.headLamp);
    this.tailLamp = this.mesh(m.lamp, this.tailMat, 'lamp');
    this.tailLamp.position.copy(m.tailLamp);
    this.tailLamp.scale.set(0.9, 0.6, 1);
    this.mount = { frame: this.body, seats: m.seats };
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, parent: THREE.Object3D = this.body): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = name === 'body' || name === 'frame';
    parent.add(mesh);
    this.parts.push(mesh);
    return mesh;
  }

  bind(v: Vehicle): void {
    this.vehicle = v;
    this.spin = 0;
    this.color = -1;
    this.setBurnt(false);
    this.group.visible = true;
  }

  release(): void {
    this.vehicle = null;
    this.group.visible = false;
  }

  /** Bikes have no separate distant model: they are cheap enough as they are. */
  setDistant(_distant: boolean): void {}

  get headLamps(): number {
    return this.burnt ? 0 : 2;
  }

  get lightsOn(): boolean {
    return this.lit;
  }

  private setBurnt(b: boolean): void {
    if (this.burnt === b) return;
    this.burnt = b;
    for (const p of this.parts) {
      if (p.name === 'tire') p.visible = !b;
      else if (p !== this.painted && p.name !== 'lamp') p.material = b ? burntMat : p.name === 'fork' || p.name === 'frame' ? darkMat : p.name === 'rim' ? rimMat : chromeMat;
    }
    this.headLamp.material = b ? burntMat : this.headMat;
    this.tailLamp.material = b ? burntMat : this.tailMat;
    if (b) {
      this.painted.material = burntMat;
      this.color = -1;
    }
  }

  sync(v: Vehicle, dt: number, _time: number, night: number, _glow = true): void {
    this.vehicle = v;
    if (v.destroyed && !v.inWater) this.setBurnt(true);
    else if (!this.burnt && this.color !== v.color) {
      this.painted.material = paint(v.color);
      this.color = v.color;
    }
    const s = v.spec;
    const m = this.model;
    this.group.position.set(v.pos.x, v.pos.y, v.pos.z);
    this.group.rotation.set(-v.pitch, v.heading, v.roll);
    // +rotation.z swings the top towards -x, the bike's right: a positive lean is to the right.
    this.leanGroup.rotation.z = Number.isFinite(v.lean) ? v.lean : 0;
    this.wheelieGroup.rotation.x = -(Number.isFinite(v.wheelie) ? v.wheelie : 0);
    this.steerGroup.rotation.y = -v.steer * steerLimit(s, v.forwardSpeed);
    this.spin += (v.forwardSpeed / m.wheelR) * dt;
    if (Math.abs(this.spin) > 1e4) this.spin %= Math.PI * 2;
    for (const w of this.wheels) {
      w.tyre.rotation.x = this.spin;
      w.rim.rotation.x = this.spin;
    }
    // Lights with a rider aboard (a parked bike is dark), as VehicleView does for cars.
    const powered = !v.destroyed && v.driver !== null;
    this.lit = night > 0.35 && powered && !this.burnt;
    this.headMat.emissiveIntensity = powered ? 0.4 + night * 5 : 0.3;
    this.tailMat.emissiveIntensity = v.destroyed ? 0 : v.braking ? BRAKE_GLOW : this.lit ? TAIL_RUNNING : TAIL_OFF;
    this.group.updateMatrixWorld(true);
    setRiderMount(v, this, this.mount);
  }

  /** Glows of the lit lamps (as VehicleView.lampWorldPositions): head and tail with the lights on, the brake lamp braking. */
  lampWorldPositions(out: LampGlow[], n = 0): number {
    const v = this.vehicle;
    if (!v || v.destroyed || this.burnt) return n;
    const e = this.body.matrixWorld.elements;
    const fl = Math.hypot(e[8]!, e[10]!) || 1;
    const fx = e[8]! / fl;
    const fz = e[10]! / fl;
    const add = (lamp: THREE.Mesh, kind: LampGlow['kind'], dir: number): void => {
      const p = lamp.getWorldPosition(this.tmp);
      const g = out[n] ?? (out[n] = { kind, x: 0, y: 0, z: 0, fx: 0, fz: 0 });
      g.kind = kind;
      g.x = p.x;
      g.y = p.y;
      g.z = p.z;
      g.fx = fx * dir;
      g.fz = fz * dir;
      n++;
    };
    if (this.lit) add(this.headLamp, 'head', 1);
    if (v.braking) add(this.tailLamp, 'brake', -1);
    else if (this.lit) add(this.tailLamp, 'tail', -1);
    return n;
  }
}

/** The bike kinds' models are built on demand; the size of a kind's model, for tests. */
export function bikeModelSize(kind: VehicleKind): { length: number; height: number } {
  const v = new BikeView(kind);
  v.group.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(v.group);
  return { length: b.max.z - b.min.z, height: b.max.y - b.min.y };
}

/** Every bike kind in the specs (for the renderer's warm-up and tests). */
export function bikeKinds(): VehicleKind[] {
  return Object.values(VEHICLE_SPECS).filter((s) => s.class === 'bike').map((s) => s.kind);
}
