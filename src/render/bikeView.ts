// Motorbikes (class 'bike'), drawn by their own view from the sculpted models in bikeModels.ts: the painted bodywork,
// the frame and running gear, and the parts that steer (fork, bars, mudguard) turning about the raked steering head,
// each one draw; the tyres, rims and lamp lenses go through the shared vehicle part batches (vehicleBatches.ts), one
// draw for every bike and car showing them; a coarse proxy casts the shadow. The whole bike leans into turns about its
// tyres' contact line (Vehicle.lean) and lifts its front about the rear tyre in a wheelie (Vehicle.wheelie); riders
// sit in its frame (riders.ts, posed by CrowdView), the driver's hands on the grips as the bars turn.

import * as THREE from 'three';
import type { Vehicle } from '../sim/entities';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import { steerLimit } from '../sim/vehiclePhysics';
import { bikeModel, type BikeModel, type LensPlace } from './bikeModels';
import type { LampGlow } from './lightSprites';
import { setRiderMount, type RiderMount, type RiderSeatLayout } from './riders';
import { paintMaterial as paint, paletteMaterial } from './shapeKit';
import { PART_LAYER, SHADOW_LAYER, type VehiclePartBatches } from './vehicleBatches';
import { HEAD_OFF, LAMP_LENS } from './vehicleView';
import { GroupFade } from './viewFade';
import { burntMaterial } from './fx/burnt';

/** Tail lamp emissive intensity braking, with running lights on, and off (as VehicleView's). */
const BRAKE_GLOW = 1.8;
const TAIL_RUNNING = 1.0;
const TAIL_OFF = 0.3;

/** Soot, char and bare metal (fx/burnt.ts), shared by every wreck. */
const burntMat = burntMaterial();
/** Never drawn by a camera (SHADOW_LAYER): the proxy only writes the shadow map, with three's depth material. */
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000 });

/** A part drawn through the part batches: the mesh holds its place, no camera draws it. */
function markPart(m: THREE.Object3D): void {
  m.layers.set(PART_LAYER);
  m.userData.batched = true;
}

function lens(place: LensPlace, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(LAMP_LENS, mat);
  m.name = 'lamp';
  m.position.copy(place.at);
  m.scale.copy(place.size);
  m.rotation.y = place.yaw + (place.facing < 0 ? Math.PI : 0);
  markPart(m);
  return m;
}

type Mutable3 = { x: number; y: number; z: number };

export class BikeView {
  readonly group = new THREE.Group();
  /** Leans about the tyres' contact line, inside the heading and slope pitch. */
  private readonly leanGroup = new THREE.Group();
  /** Pitches about the rear tyre's contact point in a wheelie. */
  private readonly wheelieGroup = new THREE.Group();
  /** The bike's own frame (+x left, +y up from the ground, +z forward): what riders sit in. */
  private readonly body = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly steerGroup = new THREE.Group();
  private readonly painted: THREE.Mesh;
  private readonly frame: THREE.Mesh;
  private readonly steer: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  /** Spinning wheel pivots, and their tyre and rim part meshes (drawn by the batches). */
  private readonly wheels: Array<{ pivot: THREE.Object3D; tyre: THREE.Mesh; rim: THREE.Mesh }> = [];
  private readonly lenses: THREE.Mesh[] = [];
  private readonly headMat = new THREE.MeshStandardMaterial({ color: 0xfffbe8, emissive: 0xfff2c8, emissiveIntensity: 0.3, roughness: 0.2 });
  private readonly tailMat = new THREE.MeshStandardMaterial({ color: 0x2a0000, emissive: 0xff0000, emissiveIntensity: 0.3, roughness: 0.3 });
  private readonly heads: THREE.Mesh[] = [];
  private readonly tailLamp: THREE.Mesh;
  private readonly model: BikeModel;
  /** This view's seat layouts: the driver's hands follow the grips as the bars turn. */
  private readonly seats: RiderSeatLayout[];
  private readonly hands: [Mutable3, Mutable3];
  private readonly mount: RiderMount;
  private readonly tmp = new THREE.Vector3();
  private readonly mtx = new THREE.Matrix4();
  private spin = 0;
  private burnt = false;
  private lit = false;
  private color = -1;
  private readonly fade = new GroupFade();
  vehicle: Vehicle | null = null;

  constructor(readonly kind: VehicleKind) {
    const m = bikeModel(kind);
    this.model = m;
    this.group.rotation.order = 'YXZ';
    this.group.add(this.leanGroup);
    this.leanGroup.add(this.wheelieGroup);
    this.wheelieGroup.position.z = m.rearZ;
    this.body.position.z = -m.rearZ;
    this.wheelieGroup.add(this.body);
    const pal = paletteMaterial();
    this.painted = this.own(m.painted, paint(0xffffff), 'body', this.body);
    this.frame = this.own(m.frame, pal, 'frame', this.body);
    // The fork turns about the steering head, tilted back by the rake.
    this.head.position.set(0, m.headY, m.headZ);
    this.head.rotation.x = -m.rake;
    this.head.add(this.steerGroup);
    this.body.add(this.head);
    this.steer = this.own(m.steer, pal, 'fork', this.steerGroup);
    this.shadow = new THREE.Mesh(m.shadow, shadowMat);
    this.shadow.name = 'shadow';
    this.shadow.castShadow = true;
    this.shadow.layers.set(SHADOW_LAYER);
    this.body.add(this.shadow);
    for (const front of [true, false]) {
      const pivot = new THREE.Group();
      if (front) pivot.position.set(0, -m.forkLen, 0);
      else pivot.position.set(0, m.wheelR, m.rearZ);
      (front ? this.steerGroup : this.body).add(pivot);
      const tyre = new THREE.Mesh(m.tyre, pal);
      tyre.name = 'tire';
      tyre.scale.x = front ? m.frontTyreScale : m.rearTyreScale;
      const rim = new THREE.Mesh(front ? m.frontRim : m.rearRim, pal);
      rim.name = 'rim';
      markPart(tyre);
      markPart(rim);
      pivot.add(tyre, rim);
      this.wheels.push({ pivot, tyre, rim });
    }
    for (const h of m.headLamps) {
      const l = lens(h, this.headMat);
      (m.headOnFork ? this.steerGroup : this.body).add(l);
      this.heads.push(l);
      this.lenses.push(l);
    }
    this.tailLamp = lens(m.tailLamp, this.tailMat);
    this.body.add(this.tailLamp);
    this.lenses.push(this.tailLamp);
    const d = m.seats[0]!;
    this.hands = [{ ...d.hands[0] }, { ...d.hands[1] }];
    this.seats = [{ ...d, hands: this.hands }, ...m.seats.slice(1)];
    const fade = this.fade;
    this.mount = { frame: this.body, seats: this.seats, get level() { return fade.level; } };
  }

  private own(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, parent: THREE.Object3D): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    // The proxy casts the shadow; these only take it.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    parent.add(mesh);
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
  setDistant(_distant: boolean, _coarse = false): void {}

  get isDistant(): boolean {
    return false;
  }

  /** Adds the tyres, rims and lamp lenses to the shared part batches, where the last sync (or a warm-up) put them. */
  drawParts(batches: VehiclePartBatches): void {
    if (!this.vehicle) this.group.updateMatrixWorld(true);
    const f = this.fade.level;
    for (const w of this.wheels) {
      if (!this.burnt) batches.add(w.tyre.geometry, w.tyre.material as THREE.Material, w.tyre.matrixWorld, {}, undefined, f);
      batches.add(w.rim.geometry, this.burnt ? burntMat : (w.rim.material as THREE.Material), w.rim.matrixWorld, {}, undefined, f);
    }
    for (const l of this.lenses) batches.addShaped(LAMP_LENS, this.burnt ? burntMat : (l.material as THREE.Material), l.matrixWorld, f);
  }

  /** Takes the part meshes out of three's walks of the scene for the frame's draw (the batches draw them). */
  hideParts(hidden: boolean): void {
    for (const w of this.wheels) w.tyre.visible = w.rim.visible = !hidden;
    for (const l of this.lenses) l.visible = !hidden;
  }

  get fading(): boolean {
    return this.fade.active;
  }

  /** Starts a fade (in, as the vehicle appears, or out where it is, its vehicle removed); setFade sets how much shows. */
  beginFade(): void {
    this.fade.begin(this.group);
  }

  setFade(f: number): void {
    this.fade.set(this.group, f);
  }

  /** How much of the view is drawn (1 unless fading). */
  get fadeLevel(): number {
    return this.fade.level;
  }

  /** Ends a fade; returns the fade materials for the caller to dispose. */
  endFade(): THREE.Material[] {
    return this.fade.end();
  }

  get headLamps(): number {
    return this.burnt ? 0 : 2;
  }

  get lightsOn(): boolean {
    return this.lit;
  }

  private setBurnt(b: boolean): void {
    if (this.burnt === b) return;
    this.burnt = b;
    const pal = paletteMaterial();
    this.fade.swap(this.frame, b ? burntMat : pal);
    this.fade.swap(this.steer, b ? burntMat : pal);
    if (b) {
      this.fade.swap(this.painted, burntMat);
      this.color = -1;
    }
  }

  sync(v: Vehicle, dt: number, _time: number, night: number, _glow = true): void {
    this.vehicle = v;
    if (v.destroyed && !v.inWater) this.setBurnt(true);
    else if (!this.burnt && this.color !== v.color) {
      this.fade.swap(this.painted, paint(v.color));
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
    for (const w of this.wheels) w.pivot.rotation.x = this.spin;
    // The driver's hands on the grips, where the bars have turned to (in the bike's frame).
    this.head.updateMatrix();
    this.steerGroup.updateMatrix();
    this.mtx.multiplyMatrices(this.head.matrix, this.steerGroup.matrix);
    const hands = this.hands;
    for (let i = 0; i < 2; i++) {
      const p = this.tmp.copy(m.handsOnBars[i]!).applyMatrix4(this.mtx);
      hands[i]!.x = p.x;
      hands[i]!.y = p.y;
      hands[i]!.z = p.z;
    }
    // Lights with a rider aboard (a parked bike is dark), as VehicleView does for cars.
    const powered = !v.destroyed && v.driver !== null;
    this.lit = night > 0.35 && powered && !this.burnt;
    this.headMat.emissiveIntensity = powered ? 0.4 + night * 5 : HEAD_OFF * night;
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
    // One glow for the head lamps (a twin pair sits a hand's width apart: one light).
    if (this.lit) add(this.heads.length > 1 ? this.midLamp() : this.heads[0]!, 'head', 1);
    if (v.braking) add(this.tailLamp, 'brake', -1);
    else if (this.lit) add(this.tailLamp, 'tail', -1);
    return n;
  }

  private readonly mid = new THREE.Mesh();
  /** A stand-in between a twin pair of head lamps, for their one glow. */
  private midLamp(): THREE.Mesh {
    const a = this.heads[0]!.getWorldPosition(new THREE.Vector3());
    const b = this.heads[1]!.getWorldPosition(new THREE.Vector3());
    this.mid.position.copy(a.add(b).multiplyScalar(0.5));
    this.mid.updateMatrixWorld();
    return this.mid;
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
