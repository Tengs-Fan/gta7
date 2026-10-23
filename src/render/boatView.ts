// Boats (class 'boat'), drawn by their own view: an open hull in the boat's paint with a floor, seats and (speedboat) a
// console with a windscreen and wheel, or (dinghy) side tubes and an outboard with a tiller. The sim floats a boat flat
// at WATER_Y; this view bobs, pitches and rolls the hull on the waves the sea draws (render/waves.ts, through the sea's
// own uniforms: on High the displaced wave grid, elsewhere a gentle bob of a few centimetres), lifts the bow as it
// planes and leans it a little out of a turn. All of that is presentation: nothing here feeds back into the sim.
// Riders sit in its frame (riders.ts, posed by CrowdView).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { damp } from '../core/math';
import type { Vehicle } from '../sim/entities';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import { WATER_Y } from '../world/constants';
import type { LampGlow } from './lightSprites';
import { setRiderMount, type RiderMount, type RiderSeatLayout } from './riders';
import type { SeaUniforms } from './sea';
import { CALM_SEA, waveDisplacement } from './waves';
import type { VehiclePartBatches } from './vehicleBatches';
import { GroupFade } from './viewFade';

/** Without the wave grid (Medium, Low, software) the hull bobs this much (m) and pitches this much (rad). */
export const GENTLE_BOB = 0.05;
const GENTLE_PITCH = 0.012;
/** Bow lift (rad) at full planing speed, and lean (rad) per rad/s of yaw rate. */
const PLANE_PITCH = 0.07;
const TURN_LEAN = 0.06;

type Style = 'speedboat' | 'dinghy';

interface BoatModel {
  length: number;
  width: number;
  /** Top of the gunwale, the floor inside and the keel, above the waterline (m). */
  gunwale: number;
  floor: number;
  keel: number;
  hull: THREE.BufferGeometry;
  deck: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
  glass: THREE.BufferGeometry | null;
  lamp: THREE.Vector3 | null;
  stern: THREE.Vector3;
  seats: RiderSeatLayout[];
}

/** The hull's plan: a square stern, parallel sides and a bow drawn to a point, in (x across, z forward). */
function outline(length: number, width: number, inset: number): THREE.Vector2[] {
  const hl = length / 2 - inset;
  const hw = width / 2 - inset;
  const shoulder = length * 0.12;
  const pts: THREE.Vector2[] = [new THREE.Vector2(-hw, -hl), new THREE.Vector2(hw, -hl), new THREE.Vector2(hw, shoulder)];
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    // A quarter ellipse from the shoulder to the stem.
    pts.push(new THREE.Vector2(hw * Math.cos((t * Math.PI) / 2), shoulder + (hl - shoulder) * Math.sin((t * Math.PI) / 2)));
  }
  for (let i = 7; i >= 1; i--) {
    const t = i / 8;
    pts.push(new THREE.Vector2(-hw * Math.cos((t * Math.PI) / 2), shoulder + (hl - shoulder) * Math.sin((t * Math.PI) / 2)));
  }
  pts.push(new THREE.Vector2(-hw, shoulder));
  return pts;
}

/** A shape in (x, z) laid flat at height y: the shape's second axis is the boat's forward axis. */
function flat(shape: THREE.Shape, y: number, up: boolean): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(shape);
  // ShapeGeometry lies in xy facing +z: a quarter turn about x keeps its y forward (+z) and faces it down; mirrored
  // across x (the outlines are symmetric) it faces up.
  g.rotateX(Math.PI / 2);
  if (up) g.scale(-1, 1, 1);
  return g.translate(0, y, 0);
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  return g.translate(x, y, z);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k);
    return n;
  }), false);
  if (!m) throw new Error('boat geometry merge failed');
  m.computeVertexNormals();
  return m;
}

const P = (x: number, y: number, z: number) => ({ x, y, z });

function model(style: Style, kind: VehicleKind): BoatModel {
  const s = VEHICLE_SPECS[kind];
  const length = s.length;
  const width = s.width;
  const keel = -(s.boat?.draft ?? 0.4);
  const gunwale = style === 'speedboat' ? 0.75 : 0.42;
  const floor = style === 'speedboat' ? 0.15 : 0.05;
  const wall = style === 'speedboat' ? 0.1 : 0.08;
  const outer = new THREE.Shape(outline(length, width, 0));
  const inner = new THREE.Path(outline(length, width, wall).reverse());
  const shell = new THREE.Shape(outline(length, width, 0));
  shell.holes.push(inner);
  // The walls: the outline less the inner one, extruded from the keel up to the gunwale.
  const walls = new THREE.ExtrudeGeometry(shell, { depth: gunwale - keel, bevelEnabled: false, curveSegments: 4 });
  // Extruded along z: stood up (the extrusion to +y) and turned half about y (det +1, so the faces keep their winding)
  // to bring the bow back to +z.
  walls.rotateX(-Math.PI / 2);
  walls.scale(-1, 1, -1);
  walls.translate(0, keel, 0);
  const hull = merge([walls, flat(outer, keel, false)]);
  const deck = merge([flat(new THREE.Shape(outline(length, width, wall)), floor, true)]);
  const hl = length / 2;
  if (style === 'speedboat') {
    const consoleZ = 0.35;
    return {
      length,
      width,
      gunwale,
      floor,
      keel,
      hull,
      deck,
      dark: merge([
        box(0.9, 0.7, 0.5, 0.45, floor + 0.35, consoleZ),
        box(0.55, 0.42, 0.55, 0.45, floor + 0.21, -0.45),
        box(0.55, 0.42, 0.55, -0.45, floor + 0.21, -0.45),
        box(width - 0.3, 0.42, 0.55, 0, floor + 0.21, -hl + 0.6),
        box(0.7, 0.75, 0.55, 0, 0.55, -hl - 0.2),
      ]),
      trim: merge([
        box(width + 0.04, 0.08, length * 0.7, 0, gunwale - 0.12, -length * 0.1),
        new THREE.TorusGeometry(0.17, 0.025, 6, 16).rotateX(-0.9).translate(0.45, floor + 0.85, consoleZ - 0.18),
      ]),
      glass: box(width - 0.3, 0.42, 0.05, 0, gunwale + 0.18, consoleZ + 0.35, -0.5),
      lamp: new THREE.Vector3(0, gunwale + 0.05, hl - 0.35),
      stern: new THREE.Vector3(0, gunwale + 0.05, -hl + 0.1),
      seats: [
        { hip: P(0.45, floor + 0.45, -0.45), recline: 0.05, hands: [P(0.6, floor + 0.88, consoleZ - 0.22), P(0.3, floor + 0.88, consoleZ - 0.22)], feet: [P(0.56, floor, -0.02), P(0.34, floor, -0.02)] },
        { hip: P(-0.45, floor + 0.45, -0.45), recline: 0.15, hands: [P(-0.2, floor + 0.62, -0.25), P(-0.7, floor + 0.62, -0.25)], feet: [P(-0.34, floor, -0.02), P(-0.56, floor, -0.02)] },
        { hip: P(0.4, floor + 0.45, -hl + 0.6), recline: 0.2, hands: [P(0.6, floor + 0.55, -hl + 0.75), P(0.2, floor + 0.55, -hl + 0.75)], feet: [P(0.5, floor, -hl + 1.05), P(0.3, floor, -hl + 1.05)] },
        { hip: P(-0.4, floor + 0.45, -hl + 0.6), recline: 0.2, hands: [P(-0.2, floor + 0.55, -hl + 0.75), P(-0.6, floor + 0.55, -hl + 0.75)], feet: [P(-0.3, floor, -hl + 1.05), P(-0.5, floor, -hl + 1.05)] },
      ],
    };
  }
  // Dinghy: side tubes over a low hull, a thwart and an outboard steered by its tiller.
  const tube = (side: number) => new THREE.CylinderGeometry(0.2, 0.2, length * 0.78, 10).rotateX(Math.PI / 2).translate(side * (width / 2 - 0.2), gunwale - 0.12, -length * 0.08);
  return {
    length,
    width,
    gunwale,
    floor,
    keel,
    hull,
    deck,
    dark: merge([
      box(width - 0.3, 0.06, 0.32, 0, floor + 0.3, -hl + 0.95),
      box(width - 0.3, 0.06, 0.32, 0, floor + 0.3, 0.2),
      box(0.26, 0.42, 0.3, 0, 0.42, -hl - 0.1),
      box(0.08, 0.5, 0.1, 0, 0.0, -hl - 0.1),
      box(0.05, 0.05, 0.55, 0, 0.55, -hl + 0.2, -0.15),
    ]),
    trim: merge([tube(1), tube(-1)]),
    glass: null,
    lamp: null,
    stern: new THREE.Vector3(0, 0.66, -hl - 0.1),
    seats: [
      { hip: P(0.0, floor + 0.36, -hl + 0.95), recline: 0.05, hands: [P(0.05, 0.58, -hl + 0.45), P(-0.25, floor + 0.36, -hl + 0.95)], feet: [P(0.15, floor, -hl + 1.4), P(-0.15, floor, -hl + 1.4)] },
      { hip: P(0.0, floor + 0.36, 0.2), recline: 0.1, hands: [P(0.4, gunwale, 0.25), P(-0.4, gunwale, 0.25)], feet: [P(0.15, floor, 0.65), P(-0.15, floor, 0.65)] },
    ],
  };
}

const STYLES: Partial<Record<VehicleKind, Style>> = { speedboat: 'speedboat', dinghy: 'dinghy' };
const models = new Map<VehicleKind, BoatModel>();
function modelOf(kind: VehicleKind): BoatModel {
  let m = models.get(kind);
  if (!m) {
    m = model(STYLES[kind] ?? 'speedboat', kind);
    models.set(kind, m);
  }
  return m;
}

const deckMat = new THREE.MeshStandardMaterial({ color: 0xcfc6b3, roughness: 0.85 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.7, metalness: 0.15 });
const trimMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.6 });
const tubeMat = new THREE.MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.6 });
const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fb8c8, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.45 });
const burntMat = new THREE.MeshStandardMaterial({ color: 0x1d1b19, roughness: 1, metalness: 0.1 });
const paints = new Map<number, THREE.MeshStandardMaterial>();
function paint(color: number): THREE.MeshStandardMaterial {
  let m = paints.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.1 });
    paints.set(color, m);
  }
  return m;
}

/** The hull's drawn heave (m), pitch and roll (rad) on the sea at time `time`, for the boat's pose: see BoatView.sync. */
export function boatSwell(v: Vehicle, sea: SeaUniforms | null, time: number, out: { heave: number; pitch: number; roll: number }): { heave: number; pitch: number; roll: number } {
  const displace = sea ? sea.uDisplace.value : 0;
  if (sea && displace > 0) {
    const ph = sea.uWavePhase.value;
    const phases = [ph.x, ph.y, ph.z, ph.w];
    const amp = sea.uSeaAmp.value;
    const ox = sea.uSeaOrigin.value.x;
    const oz = sea.uSeaOrigin.value.y;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const a = v.halfL * 0.8;
    const b = v.halfW;
    const at = (u: number, w: number) => waveDisplacement(v.pos.x + fx * u - fz * w, v.pos.z + fz * u + fx * w, ox, oz, phases, amp)[1] * displace;
    const bow = at(a, 0);
    const stern = at(-a, 0);
    const left = at(0, b);
    const right = at(0, -b);
    out.heave = (bow + stern + left + right) / 4;
    out.pitch = Math.atan2(bow - stern, 2 * a);
    out.roll = Math.atan2(left - right, 2 * b);
    return out;
  }
  // No wave grid: a gentle bob that grows a little with the sea state, out of step from boat to boat.
  const amp = sea ? Math.max(CALM_SEA, sea.uSeaAmp.value) : CALM_SEA;
  const k = 0.6 + 0.4 * amp;
  const t = time + (v.id % 17) * 0.37;
  out.heave = GENTLE_BOB * k * Math.sin(t * 1.3);
  out.pitch = GENTLE_PITCH * k * Math.sin(t * 1.1 + 0.7);
  out.roll = GENTLE_PITCH * k * Math.sin(t * 0.9 + 1.9);
  return out;
}

export class BoatView {
  readonly group = new THREE.Group();
  /** The boat's own frame (+x left, +y up from the waterline, +z forward) as drawn: what riders sit in. */
  private readonly body = new THREE.Group();
  private readonly hull: THREE.Mesh;
  private readonly parts: THREE.Mesh[] = [];
  private readonly lampMat = new THREE.MeshStandardMaterial({ color: 0xfffbe8, emissive: 0xfff2c8, emissiveIntensity: 0.2, roughness: 0.2 });
  private readonly sternMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.2, roughness: 0.3 });
  private readonly lamp: THREE.Mesh | null = null;
  private readonly sternLamp: THREE.Mesh;
  private readonly model: BoatModel;
  private readonly mount: RiderMount;
  private readonly swell = { heave: 0, pitch: 0, roll: 0 };
  private readonly tmp = new THREE.Vector3();
  private plane = 0;
  private lean = 0;
  private burnt = false;
  private lit = false;
  private color = -1;
  private sea: SeaUniforms | null = null;
  private readonly fade = new GroupFade();
  vehicle: Vehicle | null = null;

  constructor(readonly kind: VehicleKind) {
    const m = modelOf(kind);
    this.model = m;
    this.group.rotation.order = 'YXZ';
    this.body.rotation.order = 'YXZ';
    this.group.add(this.body);
    this.hull = this.mesh(m.hull, paint(0xffffff), 'body');
    this.mesh(m.deck, deckMat, 'deck');
    this.mesh(m.dark, darkMat, 'fittings');
    this.mesh(m.trim, (STYLES[kind] ?? 'speedboat') === 'dinghy' ? tubeMat : trimMat, 'trim');
    if (m.glass) this.mesh(m.glass, glassMat, 'glass').castShadow = false;
    const lampGeo = new THREE.SphereGeometry(0.06, 8, 6);
    if (m.lamp) {
      this.lamp = this.mesh(lampGeo, this.lampMat, 'lamp');
      this.lamp.position.copy(m.lamp);
    }
    this.sternLamp = this.mesh(lampGeo, this.sternMat, 'lamp');
    this.sternLamp.position.copy(m.stern);
    this.mount = { frame: this.body, seats: m.seats };
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = name !== 'lamp';
    mesh.receiveShadow = name === 'deck' || name === 'body';
    this.body.add(mesh);
    this.parts.push(mesh);
    return mesh;
  }

  /** Shares the sea's wave uniforms, so the hull rides the waves the sea draws. */
  bindSea(u: SeaUniforms | null): void {
    this.sea = u;
  }

  bind(v: Vehicle): void {
    this.vehicle = v;
    this.color = -1;
    this.plane = 0;
    this.lean = 0;
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

  /** Nothing of a boat is drawn through the car part batches (vehicleBatches.ts). */
  drawParts(_batches: VehiclePartBatches): void {}

  hideParts(_hidden: boolean): void {}

  get fading(): boolean {
    return this.fade.active;
  }

  /** Starts fading the view out where it is (its vehicle was removed in view); setFade sets how much is left. */
  beginFade(): void {
    this.fade.begin(this.group);
  }

  setFade(f: number): void {
    this.fade.set(this.group, f);
  }

  /** Ends a fade; returns the fade materials for the caller to dispose. */
  endFade(): THREE.Material[] {
    return this.fade.end();
  }

  get headLamps(): number {
    return this.lamp && !this.burnt ? 2 : 0;
  }

  get lightsOn(): boolean {
    return this.lit;
  }

  private setBurnt(b: boolean): void {
    if (this.burnt === b) return;
    this.burnt = b;
    for (const p of this.parts) {
      if (p.name === 'deck') p.material = b ? burntMat : deckMat;
      else if (p.name === 'fittings') p.material = b ? burntMat : darkMat;
      else if (p.name === 'glass') p.visible = !b;
    }
    if (b) {
      this.hull.material = burntMat;
      this.color = -1;
    }
  }

  sync(v: Vehicle, dt: number, time: number, night: number, _glow = true): void {
    this.vehicle = v;
    if (v.destroyed) this.setBurnt(true);
    else if (!this.burnt && this.color !== v.color) {
      this.hull.material = paint(v.color);
      this.color = v.color;
    }
    // Waves move a boat afloat, not one sinking, or standing on the sand or on a trailer.
    const afloat = !v.inWater && Math.abs(v.pos.y - WATER_Y) < 0.05;
    const sw = boatSwell(v, this.sea, time, this.swell);
    // Planing lifts the bow with speed (a speedboat more than a dinghy); turning leans it out of the turn.
    const speed01 = Math.min(1, Math.max(0, v.forwardSpeed) / v.spec.maxSpeed);
    this.plane = damp(this.plane, PLANE_PITCH * Math.sin(Math.PI * Math.min(1, speed01 * 1.6)) * (this.model.gunwale > 0.6 ? 1 : 0.5), 2.5, dt);
    this.lean = damp(this.lean, Math.max(-0.12, Math.min(0.12, v.angVel * TURN_LEAN * speed01)), 3, dt);
    this.group.position.set(v.pos.x, v.pos.y + (afloat ? sw.heave : 0), v.pos.z);
    this.group.rotation.set(-v.pitch, v.heading, v.roll);
    this.body.rotation.set(afloat ? -(sw.pitch + this.plane) : 0, 0, afloat ? sw.roll - this.lean : 0);
    const powered = !v.destroyed && v.driver !== null;
    this.lit = night > 0.35 && powered && !this.burnt;
    this.lampMat.emissiveIntensity = this.lit ? 0.6 + night * 4 : 0.2;
    this.sternMat.emissiveIntensity = this.lit ? 1.2 : 0.2;
    this.group.updateMatrixWorld(true);
    setRiderMount(v, this, this.mount);
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
    if (this.lamp) add(this.lamp, 'head', 1);
    add(this.sternLamp, 'tail', -1);
    return n;
  }
}

/** Every boat kind in the specs. */
export function boatKinds(): VehicleKind[] {
  return Object.values(VEHICLE_SPECS).filter((s) => s.class === 'boat').map((s) => s.kind);
}
