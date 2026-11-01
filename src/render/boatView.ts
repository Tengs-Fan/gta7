// Boats (class 'boat'), drawn by their own view from the procedural hulls in boatModels.ts: the painted topsides, one
// palette draw for the rest (bottom, cockpit, seats, console and wheel, rails, outboard), the speedboat's glass
// windscreen, and a foam ring at the waterline; the bow and stern lights go through the shared part batches, and a
// coarse proxy casts the shadow. The sim floats a boat flat at WATER_Y; this view heaves, pitches and rolls the hull on
// the waves the sea draws (render/waves.ts, through the sea's own uniforms: on High and Medium the displaced wave grid,
// elsewhere a gentle bob of a few centimetres), its bow and stern sprung to the sea and falling freely out of it, so at
// speed in rough water it leaves a crest and slams down beyond it; it lifts the bow as it planes and leans it a little
// out of a turn, and lays the foam ring on the drawn sea surface round the hull. All of that is presentation: nothing
// here feeds back into the sim. Riders sit in its frame (riders.ts, posed by CrowdView).

import * as THREE from 'three';
import { damp } from '../core/math';
import type { Vehicle } from '../sim/entities';
import { lampsLit } from '../sim/lamps';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import { WATER_Y } from '../world/constants';
import { boatModel, type BoatLamp, type BoatModel } from './boatModels';
import type { LampGlow } from './lightSprites';
import { setRiderMount, type RiderMount } from './riders';
import { seaSurface, seaWaveUniforms, type SeaWaveUniforms } from './sea';
import { paintMaterial, paletteMaterial } from './shapeKit';
import { PART_LAYER, SHADOW_LAYER, type VehiclePartBatches } from './vehicleBatches';
import { LAMP_LENS, vehicleGlass } from './vehicleView';
import { CALM_SEA, seaHeight, type SeaSurface } from './waves';
import { GroupFade } from './viewFade';
import { burntMaterial } from './fx/burnt';

/** Without the wave grid (Low, software) the hull bobs this much (m) and pitches this much (rad). */
export const GENTLE_BOB = 0.05;
const GENTLE_PITCH = 0.012;
/** Bow lift (rad) at full planing speed, and lean (rad) per rad/s of yaw rate. */
const PLANE_PITCH = 0.07;
const TURN_LEAN = 0.06;
/** The foam ring floats this far over the drawn sea (m), from FOAM_IN to FOAM_OUT outside the waterline. */
export const FOAM_LIFT = 0.03;
export const FOAM_IN = 0.02;
export const FOAM_OUT = 0.5;
/**
 * In the water the hull's bow and stern are each pulled to the sea under them by a damped spring (buoyancy and the
 * planing lift: HULL_SPRING per s^2 per m under it, HULL_DAMP per s against the sea's own speed), stiff enough to ride
 * the swell and soft enough to plough through the short chop at speed rather than take its every face; out of it they
 * fall freely (HULL_FALL, m/s^2).
 */
export const HULL_SPRING = 100;
export const HULL_DAMP = 12;
export const HULL_FALL = 9.81;
/** A hull coming down on the water this fast (m/s, against the surface) slams into it (BoatView.slam). */
export const SLAM_SPEED = 1.5;
/**
 * The bow and stern ride the sea this share of the hull's half length out from its middle, each on the mean of the
 * sea at three points HULL_SPREAD of the half length apart along the hull (as the hull spans the short chop's crests and
 * troughs, rather than bobbing on each).
 */
const HULL_REACH = 0.8;
const HULL_SPREAD = 0.3;

/** Soot, char and bare metal (fx/burnt.ts), shared by every wreck. */
const burntMat = burntMaterial();
/** Never drawn by a camera (SHADOW_LAYER): the proxy only writes the shadow map, with three's depth material. */
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000 });

/** Soft foam blobs (alpha in G, as three's alphaMap reads it), tiling. */
function foamTexture(): THREE.DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  const hash = (x: number, y: number) => {
    const h = Math.sin((x % n) * 127.1 + (y % n) * 311.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const noise = (x: number, y: number, cell: number) => {
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    const fx = x / cell - gx;
    const fy = y / cell - gy;
    const c = n / cell;
    const v = (i: number, j: number) => hash(((gx + i) % c) * cell, ((gy + j) % c) * cell);
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    return (v(0, 0) * (1 - sx) + v(1, 0) * sx) * (1 - sy) + (v(0, 1) * (1 - sx) + v(1, 1) * sx) * sy;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const f = 0.55 * noise(x, y, 16) + 0.3 * noise(x, y, 8) + 0.15 * noise(x, y, 4);
      const a = 0.25 + 0.75 * Math.min(1, Math.max(0, (f - 0.3) / 0.35));
      data.set([255, Math.round(a * 255), 255, 255], (y * n + x) * 4);
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

let foam: THREE.MeshStandardMaterial | null = null;
/** The foam ring's material: lit white, its alpha from the vertex (dense at the hull, none at the rim) times the blobs. */
export function foamMaterial(): THREE.MeshStandardMaterial {
  if (foam) return foam;
  foam = new THREE.MeshStandardMaterial({
    color: 0xf3f7f8,
    roughness: 0.9,
    metalness: 0,
    vertexColors: true,
    alphaMap: foamTexture(),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  foam.name = 'boat-foam';
  return foam;
}

/** Rows of the foam ring: distance out from the waterline and alpha. */
const FOAM_ROWS: ReadonlyArray<readonly [number, number]> = [[FOAM_IN, 0.92], [0.12, 0.72], [0.28, 0.34], [FOAM_OUT, 0]];

/** The ring's layout in the boat's frame (x, z per vertex) and its geometry (positions filled per frame). */
function foamRing(m: BoatModel): { base: Float32Array; geometry: THREE.BufferGeometry } {
  const wl = m.waterline;
  const n = wl.length;
  const rows = FOAM_ROWS.length;
  const base = new Float32Array(n * rows * 2);
  const color = new Float32Array(n * rows * 4);
  const uv = new Float32Array(n * rows * 2);
  const normal = new Float32Array(n * rows * 3);
  let perimeter = 0;
  for (let i = 0; i < n; i++) perimeter += wl[i]!.distanceTo(wl[(i + 1) % n]!);
  // Winding: the outline's signed area says which side is out.
  let area = 0;
  for (let i = 0; i < n; i++) area += wl[i]!.x * wl[(i + 1) % n]!.y - wl[(i + 1) % n]!.x * wl[i]!.y;
  const outSign = area > 0 ? 1 : -1;
  let along = 0;
  for (let i = 0; i < n; i++) {
    const p = wl[i]!;
    const a = wl[(i + n - 1) % n]!;
    const b = wl[(i + 1) % n]!;
    // Outward normal of the outline at p (perpendicular to its tangent).
    const tx = b.x - a.x;
    const tz = b.y - a.y;
    const tl = Math.hypot(tx, tz) || 1;
    const nx = (tz / tl) * outSign;
    const nz = (-tx / tl) * outSign;
    if (i > 0) along += p.distanceTo(wl[i - 1]!);
    // A little ragged at the rim, the same way for every boat of the kind.
    const ragged = 0.85 + 0.3 * (0.5 + 0.5 * Math.sin(i * 2.3) * Math.cos(i * 0.7));
    for (let r = 0; r < rows; r++) {
      const [d, alpha] = FOAM_ROWS[r]!;
      const k = i * rows + r;
      const dist = r === rows - 1 ? d * ragged : d;
      base[k * 2] = p.x + nx * dist;
      base[k * 2 + 1] = p.y + nz * dist;
      color.set([1, 1, 1, alpha], k * 4);
      uv[k * 2] = (along / perimeter) * Math.round(perimeter / 1.4);
      uv[k * 2 + 1] = d / 1.4;
      normal.set([0, 1, 0], k * 3);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (let r = 0; r < rows - 1; r++) {
      const a = i * rows + r;
      const b = j * rows + r;
      const c = i * rows + r + 1;
      const d = j * rows + r + 1;
      // Faces up whichever way the outline runs (counter-clockwise in x-z is clockwise seen from above).
      if (outSign > 0) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * rows * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(color, 4));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), m.length / 2 + FOAM_OUT + 1);
  return { base, geometry: g };
}

/** The sea under a hull: its heave (m, the mean of four points round it), pitch and roll (rad), and its ends' heights (m). */
export interface Swell {
  heave: number;
  pitch: number;
  roll: number;
  bow: number;
  stern: number;
}

/** Scratch for seaSampler (it runs per boat per frame). */
const SURFACE: SeaSurface = seaSurface(seaWaveUniforms());

/** The drawn sea's height over WATER_Y for many points of a frame: the uniforms read once (0 everywhere without the grid). */
function seaSampler(sea: SeaWaveUniforms | null): (x: number, z: number) => number {
  const displace = sea ? sea.uDisplace.value : 0;
  if (!sea || displace <= 0) return () => 0;
  const s = seaSurface(sea, SURFACE);
  return (x, z) => seaHeight(s, x, z) * displace;
}

/** The drawn sea under the boat at time `time`, for the hull's pose: see BoatView.sync. */
export function boatSwell(v: Vehicle, sea: SeaWaveUniforms | null, time: number, out: Swell): Swell {
  const displace = sea ? sea.uDisplace.value : 0;
  const a = v.halfL * HULL_REACH;
  if (sea && displace > 0) {
    const height = seaSampler(sea);
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const b = v.halfW;
    const d = v.halfL * HULL_SPREAD;
    /** The sea along the hull, `along` m forward of its middle and `side` m to its left (three points d apart). */
    const at = (along: number, side: number) => {
      const x = v.pos.x + fx * along - fz * side;
      const z = v.pos.z + fz * along + fx * side;
      return (height(x - fx * d, z - fz * d) + height(x, z) + height(x + fx * d, z + fz * d)) / 3;
    };
    const bow = at(a, 0);
    const stern = at(-a, 0);
    const left = at(0, b);
    const right = at(0, -b);
    out.heave = (bow + stern + left + right) / 4;
    out.pitch = Math.atan2(bow - stern, 2 * a);
    out.roll = Math.atan2(left - right, 2 * b);
  } else {
    // No wave grid: a gentle bob that grows a little with the sea state, out of step from boat to boat.
    const amp = sea ? Math.max(CALM_SEA, sea.uSeaAmp.value) : CALM_SEA;
    const k = 0.6 + 0.4 * amp;
    const t = time + (v.id % 17) * 0.37;
    out.heave = GENTLE_BOB * k * Math.sin(t * 1.3);
    out.pitch = GENTLE_PITCH * k * Math.sin(t * 1.1 + 0.7);
    out.roll = GENTLE_PITCH * k * Math.sin(t * 0.9 + 1.9);
  }
  out.bow = out.heave + a * Math.tan(out.pitch);
  out.stern = out.heave - a * Math.tan(out.pitch);
  return out;
}

/**
 * One end of the hull over `dt` s as the sea under it goes from where it was to `sea` (HULL_SPRING, HULL_FALL), in steps
 * of at most a 60th of a second: thrown up a wave's face faster than the sea falls away beyond its crest, it leaves the
 * water. Returns how hard (m/s, against the sea's own speed) it came down, or 0.
 */
function ride(end: { y: number; vy: number; sea: number }, sea: number, dt: number): number {
  const n = Math.ceil(dt * 60);
  const h = dt / n;
  const rate = (sea - end.sea) / dt;
  let impact = 0;
  for (let i = 0; i < n; i++) {
    const s = end.sea + rate * h * i;
    const flying = end.y > s;
    end.vy += (flying ? -HULL_FALL : HULL_SPRING * (s - end.y) + HULL_DAMP * (rate - end.vy)) * h;
    end.y += end.vy * h;
    if (flying && end.y <= s + rate * h) impact = Math.max(impact, rate - end.vy);
  }
  end.sea = sea;
  return impact;
}

function lampMesh(l: BoatLamp, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(LAMP_LENS, mat);
  m.name = 'lamp';
  m.position.copy(l.at);
  m.scale.copy(l.size);
  if (l.facing < 0) m.rotation.y = Math.PI;
  m.layers.set(PART_LAYER);
  m.userData.batched = true;
  return m;
}

export class BoatView {
  readonly group = new THREE.Group();
  /** The boat's own frame (+x left, +y up from the waterline, +z forward) as drawn: what riders sit in. */
  private readonly body = new THREE.Group();
  private readonly hull: THREE.Mesh;
  private readonly fittings: THREE.Mesh;
  private readonly glass: THREE.Mesh | null = null;
  private readonly foam: THREE.Mesh;
  private readonly foamBase: Float32Array;
  private readonly lampMat = new THREE.MeshStandardMaterial({ color: 0xfffbe8, emissive: 0xfff2c8, emissiveIntensity: 0.2, roughness: 0.2 });
  private readonly sternMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.2, roughness: 0.3 });
  private readonly bowLamp: THREE.Mesh;
  private readonly sternLamp: THREE.Mesh;
  private readonly model: BoatModel;
  private readonly mount: RiderMount;
  private readonly swell: Swell = { heave: 0, pitch: 0, roll: 0, bow: 0, stern: 0 };
  /** The hull's bow and stern as drawn (m over WATER_Y), their speeds (m/s) and the sea under them last frame (ride). */
  private readonly bow = { y: 0, vy: 0, sea: 0 };
  private readonly stern = { y: 0, vy: 0, sea: 0 };
  /** Whether the bow and stern rode the sea last frame (else they start on it). */
  private riding = false;
  /** How hard (m/s) the hull last slammed into the water, for the renderer's spray; it clears it once used. */
  slam = 0;
  private readonly tmp = new THREE.Vector3();
  /** The hull as the sim poses it (flat on WATER_Y), and from it to the hull as drawn: the rider mount's simToDrawn. */
  private readonly simPose = new THREE.Matrix4();
  private readonly simToDrawn = new THREE.Matrix4();
  private plane = 0;
  private lean = 0;
  private burnt = false;
  private lit = false;
  private color = -1;
  private sea: SeaWaveUniforms | null = null;
  private readonly fade = new GroupFade();
  vehicle: Vehicle | null = null;

  constructor(readonly kind: VehicleKind) {
    const m = boatModel(kind);
    this.model = m;
    this.group.rotation.order = 'YXZ';
    this.body.rotation.order = 'YXZ';
    this.group.add(this.body);
    this.hull = this.own(m.painted, paintMaterial(0xffffff), 'body');
    this.fittings = this.own(m.fittings, paletteMaterial(), 'fittings');
    if (m.glass) {
      this.glass = this.own(m.glass, vehicleGlass.intact, 'glass');
      this.glass.receiveShadow = false;
    }
    const shadow = new THREE.Mesh(m.shadow, shadowMat);
    shadow.name = 'shadow';
    shadow.castShadow = true;
    shadow.layers.set(SHADOW_LAYER);
    this.body.add(shadow);
    this.bowLamp = lampMesh(m.bowLamp, this.lampMat);
    this.sternLamp = lampMesh(m.sternLamp, this.sternMat);
    this.body.add(this.bowLamp, this.sternLamp);
    // The foam ring rides the sea, not the hull: in the outer group, laid on the drawn surface each sync. Until the
    // first sync every vertex sits at the boat's origin (drawing nothing and adding nothing to its bounds).
    const ring = foamRing(m);
    this.foamBase = ring.base;
    this.foam = new THREE.Mesh(ring.geometry, foamMaterial());
    this.foam.name = 'foam';
    this.foam.receiveShadow = true;
    this.foam.renderOrder = 1;
    this.group.add(this.foam);
    const fade = this.fade;
    this.mount = { frame: this.body, seats: m.seats, simToDrawn: this.simToDrawn, get level() { return fade.level; } };
  }

  private own(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.body.add(mesh);
    return mesh;
  }

  /** Shares the sea's wave uniforms, so the hull rides the waves the sea draws. */
  bindSea(u: SeaWaveUniforms | null): void {
    this.sea = u;
  }

  bind(v: Vehicle): void {
    this.vehicle = v;
    this.color = -1;
    this.plane = 0;
    this.lean = 0;
    this.riding = false;
    this.slam = 0;
    this.setBurnt(false);
    this.group.visible = true;
  }

  release(): void {
    this.vehicle = null;
    this.group.visible = false;
  }

  /** Boats have no separate distant model: they are cheap enough as they are. */
  setDistant(_distant: boolean, _coarse = false): void {}

  get isDistant(): boolean {
    return false;
  }

  /** Adds the bow and stern lights to the shared part batches, where the last sync (or a warm-up) put them. */
  drawParts(batches: VehiclePartBatches): void {
    if (!this.vehicle) this.group.updateMatrixWorld(true);
    const f = this.fade.level;
    for (const l of [this.bowLamp, this.sternLamp]) batches.addShaped(LAMP_LENS, this.burnt ? burntMat : (l.material as THREE.Material), l.matrixWorld, f);
  }

  hideParts(hidden: boolean): void {
    this.bowLamp.visible = this.sternLamp.visible = !hidden;
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
    return this.model.headLamp && !this.burnt ? 2 : 0;
  }

  get lightsOn(): boolean {
    return this.lit;
  }

  private setBurnt(b: boolean): void {
    if (this.burnt === b) return;
    this.burnt = b;
    this.fade.swap(this.fittings, b ? burntMat : paletteMaterial());
    if (this.glass) this.glass.visible = !b;
    if (b) {
      this.fade.swap(this.hull, burntMat);
      this.color = -1;
    }
  }

  sync(v: Vehicle, dt: number, time: number, night: number, _glow = true): void {
    this.vehicle = v;
    if (v.destroyed) this.setBurnt(true);
    else if (!this.burnt && this.color !== v.color) {
      this.fade.swap(this.hull, paintMaterial(v.color));
      this.color = v.color;
    }
    // Waves move a boat afloat, not one sinking, or standing on the sand or on a trailer.
    const afloat = !v.inWater && Math.abs(v.pos.y - WATER_Y) < 0.05;
    const sw = boatSwell(v, this.sea, time, this.swell);
    // The bow and stern ride the sea, leaving it over a crest taken too fast; a fresh boat (or one back in the water, or
    // moved further than it could go in a frame) starts on it.
    const a = v.halfL * HULL_REACH;
    if (!afloat || !this.riding || Math.hypot(this.group.position.x - v.pos.x, this.group.position.z - v.pos.z) > 20) {
      this.bow.y = this.bow.sea = sw.bow;
      this.stern.y = this.stern.sea = sw.stern;
      this.bow.vy = this.stern.vy = 0;
    } else if (dt > 0) {
      const step = Math.min(dt, 0.1);
      this.slam = Math.max(this.slam, ride(this.bow, sw.bow, step), ride(this.stern, sw.stern, step));
    }
    this.riding = afloat;
    const heave = (this.bow.y + this.stern.y) / 2;
    const pitch = Math.atan2(this.bow.y - this.stern.y, 2 * a);
    // Planing lifts the bow with speed (a speedboat more than a dinghy); turning leans it out of the turn.
    const speed01 = Math.min(1, Math.max(0, v.forwardSpeed) / v.spec.maxSpeed);
    this.plane = damp(this.plane, PLANE_PITCH * Math.sin(Math.PI * Math.min(1, speed01 * 1.6)) * (this.model.gunwale > 0.6 ? 1 : 0.5), 2.5, dt);
    this.lean = damp(this.lean, Math.max(-0.12, Math.min(0.12, v.angVel * TURN_LEAN * speed01)), 3, dt);
    this.group.position.set(v.pos.x, v.pos.y + (afloat ? heave : 0), v.pos.z);
    this.group.rotation.set(-v.pitch, v.heading, v.roll);
    this.body.rotation.set(afloat ? -(pitch + this.plane) : 0, 0, afloat ? sw.roll - this.lean : 0);
    // No ring of foam round a hull in the air.
    this.layFoam(v, afloat && !v.destroyed && heave - sw.heave < 0.25);
    this.lit = lampsLit(v, night);
    this.lampMat.emissiveIntensity = this.lit ? 0.6 + night * 4 : 0.2;
    this.sternMat.emissiveIntensity = this.lit ? 1.2 : 0.2;
    this.group.updateMatrixWorld(true);
    // The sim's pose is the group's without the heave, and the body's without its drawn pitch and roll.
    this.simPose.makeRotationFromEuler(this.group.rotation).setPosition(v.pos.x, v.pos.y, v.pos.z);
    this.simToDrawn.multiplyMatrices(this.body.matrixWorld, this.simPose.invert());
    setRiderMount(v, this, this.mount);
  }

  /** Lays the foam ring on the drawn sea round the hull (in the outer group's frame: turned by the heading only). */
  private layFoam(v: Vehicle, shown: boolean): void {
    this.foam.visible = shown;
    if (!shown) return;
    const pos = this.foam.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const base = this.foamBase;
    const c = Math.cos(v.heading);
    const s = Math.sin(v.heading);
    const y0 = WATER_Y + FOAM_LIFT - this.group.position.y;
    const height = seaSampler(this.sea);
    // Every vertex on the sea: the storm's chop is short enough to bend the ring between its rows.
    for (let k = 0; k < base.length / 2; k++) {
      arr[k * 3] = base[k * 2]!;
      arr[k * 3 + 1] = y0 + height(v.pos.x + base[k * 2]! * c + base[k * 2 + 1]! * s, v.pos.z - base[k * 2]! * s + base[k * 2 + 1]! * c);
      arr[k * 3 + 2] = base[k * 2 + 1]!;
    }
    pos.needsUpdate = true;
  }

  /** The foam ring's vertices in world space, as last laid (for tests and probes). */
  foamWorld(): THREE.Vector3[] {
    const pos = this.foam.geometry.getAttribute('position');
    this.foam.updateMatrixWorld();
    return Array.from({ length: pos.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(this.foam.matrixWorld));
  }

  lampWorldPositions(out: LampGlow[], n = 0): number {
    const v = this.vehicle;
    if (!v || v.destroyed || !this.lit) return n;
    const e = this.body.matrixWorld.elements;
    const fl = Math.hypot(e[8]!, e[10]!) || 1;
    const add = (lamp: THREE.Mesh, kind: LampGlow['kind'], dir: number): void => {
      const p = lamp.getWorldPosition(this.tmp);
      const g = out[n] ?? (out[n] = { kind, x: 0, y: 0, z: 0, fx: 0, fz: 0 });
      g.kind = kind;
      g.x = p.x;
      g.y = p.y;
      g.z = p.z;
      g.fx = (e[8]! / fl) * dir;
      g.fz = (e[10]! / fl) * dir;
      n++;
    };
    // A speedboat's bow lamp lights the water like a head lamp; a dinghy's is a running light, white like the stern's.
    add(this.bowLamp, this.model.headLamp ? 'head' : 'reverse', 1);
    add(this.sternLamp, 'reverse', -1);
    return n;
  }
}

/** Every boat kind in the specs. */
export function boatKinds(): VehicleKind[] {
  return Object.values(VEHICLE_SPECS).filter((s) => s.class === 'boat').map((s) => s.kind);
}
