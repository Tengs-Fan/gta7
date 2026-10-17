// All characters drawn with one InstancedMesh per body part on a jointed rig: upper arms, forearms,
// thighs and shins hinge at the elbows and knees, feet are planted by the gait (render/gait.ts), and the
// trunk and the weapon in hand come from sim/pose.ts, the pose the simulation shoots from. Drivers and
// passengers are drawn in their seats.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp, lerp, wrapAngle } from '../core/math';
import type { Character, Vehicle } from '../sim/entities';
import {
  aimed, hipSpread, makeTrunk, makeWeaponPose, shoulderSpread, SKELETON, trunkPose, weaponPoseInto, WEAPON_POINTS,
  type Trunk, type WeaponPose,
} from '../sim/pose';
import type { VehicleKind, WeaponId } from '../sim/specs';
import { gait, makeGaitOut, makeTwoBone, solveLeg, solveTwoBone, type LegPose } from './gait';
import { VehicleView } from './vehicleView';

const MAX = 240;
/** Seated drivers and passengers are drawn within this distance of the camera. */
export const OCCUPANT_RANGE = 60;

/** Hip height of the seats above the wheel contact point (v.pos.y). */
export const SEAT_Y: Readonly<Record<VehicleKind, number>> = { compact: 0.42, sedan: 0.45, taxi: 0.45, police: 0.45, sports: 0.36, muscle: 0.42, pickup: 0.62, van: 0.85, swat: 0.9, bus: 1.15 };
/**
 * Front and rear seats along the car (m ahead of its centre). Cars use the simulation's seat offsets
 * (Sim.syncOccupant); the van, the SWAT van and the bus have their cabs and windscreens well forward.
 */
const SEAT_Z: Partial<Record<VehicleKind, readonly [number, number]>> = { van: [1.15, -0.9], swat: [1.45, -0.6], bus: [4.55, -0.9] };
/**
 * The steering wheel the driver holds, relative to the seat (hip) point: centre height and distance ahead
 * (x the driver's height), rim radius, the rim's tilt back from upright, and the turn of the hands at full lock.
 */
export const DRIVER_WHEEL = { up: 0.38, ahead: 0.36, radius: 0.16, tilt: 0.4, lock: 0.65 } as const;

type Gun = Exclude<WeaponId, 'fists'>;
/** Recoil kick (rad) of each weapon just after a shot; it is drawn only, never part of the muzzle. */
export const KICK: Readonly<Record<Gun, number>> = { pistol: 0.12, smg: 0.06, shotgun: 0.3, rifle: 0.1, rocket: 0.15 };
/** The kick is at full strength while shotTimer is above this, then dies away with it. */
const KICK_HOLD = 0.05;
const KICK_BACK = 0.05;

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function mergeAll(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(gs.map((g) => g.toNonIndexed()), false);
  if (!m) throw new Error('merge failed');
  return m;
}

interface Part {
  mesh: THREE.InstancedMesh;
  n: number;
}

type PartName = 'torso' | 'head' | 'hair' | 'hat' | 'neck' | 'upperArm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'shoe';

/** Per-character smoothing between poses. */
interface Anim {
  /** 0 upright .. 1 lying (knocked down or dead). */
  lie: number;
  /** 0 standing .. 1 stepping with the gait. */
  walk: number;
  /** 0 on the ground .. 1 airborne (knees tucked). */
  air: number;
  /** Frame the character was last drawn. */
  frame: number;
}

type P3 = { readonly x: number; readonly y: number; readonly z: number };

// Scratch objects: one character is posed at a time, and each object has one job.
const V = () => new THREE.Vector3();
const S = {
  /** Instance matrix being written. */
  inst: new THREE.Matrix4(),
  /** Body frame rotation of the character being posed (chest, lying or seat frame). */
  body: new THREE.Matrix4(),
  /** Vehicle rotation (seated characters). */
  vrot: new THREE.Matrix4(),
  /** Temporary rotations inside helpers. */
  rot: new THREE.Matrix4(),
  rot2: new THREE.Matrix4(),
  /** Drawn weapon matrix. */
  weapon: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  e: new THREE.Euler(0, 0, 0, 'YXZ'),
  sc: V(),
  // Joints of the character being posed.
  pelvis: V(),
  neck: V(),
  hipL: V(),
  hipR: V(),
  shL: V(),
  shR: V(),
  knee: V(),
  ankle: V(),
  elbow: V(),
  hand: V(),
  wrist: V(),
  // Axes: body frame, hips, vehicle.
  left: V(),
  up: V(),
  fwd: V(),
  hipLeft: V(),
  vleft: V(),
  vup: V(),
  vfwd: V(),
  // Arm targets and IK pole.
  targetL: V(),
  targetR: V(),
  pole: V(),
  // Limb directions and bone basis.
  d1: V(),
  d2: V(),
  bx: V(),
  by: V(),
  bz: V(),
};

const ik = makeTwoBone();

/** Packed colours converted to the working colour space once (setHex does it with three pow calls). */
const colors = new Map<number, THREE.Color>();
function colorOf(hex: number): THREE.Color {
  let c = colors.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    colors.set(hex, c);
  }
  return c;
}

/** Deterministic per-character variation in 0..1. */
function seeded(id: number, salt: number): number {
  const x = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Recoil strength 0..1 from the time left on the shot timer. */
export function kickAmount(shotTimer: number): number {
  return shotTimer > 0 ? clamp(shotTimer / KICK_HOLD, 0, 1) : 0;
}

export class CrowdView {
  readonly group = new THREE.Group();
  private readonly parts: Record<PartName, Part>;
  private readonly weapons = new Map<WeaponId, Part>();
  /** Per-character pose smoothing: the lying angle, and the gait and airborne weights. */
  private readonly lie = new Map<number, Anim>();
  /** Hide this character id (e.g. the player in first-person-ish shots). */
  hiddenId = -1;
  private frame = 0;
  private time = 0;
  private player: Character | null = null;
  private readonly trunk: Trunk = makeTrunk();
  private readonly gaitOut = makeGaitOut();
  private readonly wp: WeaponPose = makeWeaponPose();
  /** Height each vehicle kind's view rotates about (see VehicleView). */
  private readonly pivots = new Map<VehicleKind, number>();

  constructor() {
    this.group.name = 'crowd';
    const mat = () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
    const make = (geo: THREE.BufferGeometry, count: number): Part => {
      const mesh = new THREE.InstancedMesh(geo, mat(), count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Allocate the colour buffer up front.
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      this.group.add(mesh);
      return { mesh, n: 0 };
    };
    const K = SKELETON;
    // Limbs hang along their local -y from the joint at the origin and reach a little past the next
    // joint, so bent elbows and knees show no gap. Lengths are for appearance.height 1, scaled per instance.
    this.parts = {
      torso: make(mergeAll([box(0.44, 0.6, 0.25, 0, 0.3, 0), box(0.4, 0.1, 0.24, 0, 0.62, 0)]), MAX),
      head: make(box(0.23, 0.26, 0.25, 0, 0.15, 0), MAX),
      hair: make(mergeAll([box(0.25, 0.08, 0.27, 0, 0.3, -0.005), box(0.25, 0.18, 0.06, 0, 0.19, -0.11)]), MAX),
      hat: make(mergeAll([box(0.26, 0.09, 0.27, 0, 0.32, 0), box(0.23, 0.03, 0.14, 0, 0.28, 0.18)]), MAX),
      neck: make(box(0.11, 0.08, 0.11, 0, 0.62, 0), MAX),
      upperArm: make(box(0.12, K.upperArm + 0.06, 0.13, 0, -K.upperArm / 2 + 0.01, 0), MAX * 2),
      forearm: make(box(0.105, K.forearm + 0.03, 0.115, 0, -K.forearm / 2 + 0.005, 0), MAX * 2),
      hand: make(box(0.095, 0.1, 0.1, 0, 0, 0), MAX * 2),
      thigh: make(box(0.17, K.thigh + 0.05, 0.18, 0, -K.thigh / 2 + 0.01, 0.005), MAX * 2),
      shin: make(box(0.15, K.shin + 0.05, 0.16, 0, -K.shin / 2 + 0.02, 0), MAX * 2),
      shoe: make(box(0.15, 0.09, K.heel + K.toe, 0, -K.ankleY + 0.045, (K.toe - K.heel) / 2), MAX * 2),
    };
    // Barrel ends (front face centres) are the WEAPON_POINTS tips of sim/pose.ts.
    const weaponGeo: Record<Gun, THREE.BufferGeometry> = {
      pistol: mergeAll([box(0.05, 0.08, 0.22, 0, 0, 0.1), box(0.045, 0.13, 0.06, 0, -0.07, 0.02)]),
      smg: mergeAll([box(0.06, 0.1, 0.42, 0, 0, 0.16), box(0.05, 0.16, 0.06, 0, -0.1, 0.06), box(0.04, 0.12, 0.05, 0, -0.08, 0.2)]),
      shotgun: mergeAll([box(0.06, 0.08, 0.9, 0, 0, 0.3), box(0.06, 0.12, 0.25, 0, -0.04, -0.12)]),
      rifle: mergeAll([box(0.06, 0.1, 0.85, 0, 0, 0.28), box(0.05, 0.18, 0.06, 0, -0.12, 0.12), box(0.06, 0.12, 0.22, 0, -0.03, -0.14)]),
      rocket: mergeAll([new THREE.CylinderGeometry(0.09, 0.09, 1.15, 10).rotateX(Math.PI / 2).translate(0, 0.08, 0.2), box(0.05, 0.14, 0.06, 0, -0.06, 0.1)]),
    };
    for (const [id, geo] of Object.entries(weaponGeo) as Array<[Gun, THREE.BufferGeometry]>) {
      const p = make(geo, MAX);
      (p.mesh.material as THREE.MeshStandardMaterial).color.setHex(id === 'rocket' ? 0x3d4a2f : 0x1e1e20);
      (p.mesh.material as THREE.MeshStandardMaterial).metalness = 0.6;
      (p.mesh.material as THREE.MeshStandardMaterial).roughness = 0.4;
      this.weapons.set(id, p);
    }
  }

  private put(part: Part, m: THREE.Matrix4, color: number): void {
    if (part.n >= part.mesh.instanceMatrix.count) return;
    part.mesh.setMatrixAt(part.n, m);
    part.mesh.setColorAt(part.n, colorOf(color));
    part.n++;
  }

  sync(chars: readonly Character[], camX: number, camZ: number, dt: number): void {
    for (const p of Object.values(this.parts)) p.n = 0;
    for (const p of this.weapons.values()) p.n = 0;
    this.frame++;
    this.time += dt;
    this.player = null;
    for (const c of chars) {
      if (c.isPlayer && !c.removed) {
        this.player = c;
        break;
      }
    }
    for (const c of chars) {
      if (c.removed || c.id === this.hiddenId) continue;
      if (c.state === 'inVehicle') {
        const v = c.vehicle;
        if (!v || v.removed || v.destroyed || v.burning) continue;
        if ((v.pos.x - camX) ** 2 + (v.pos.z - camZ) ** 2 > OCCUPANT_RANGE * OCCUPANT_RANGE) continue;
        this.seated(c, v);
        continue;
      }
      if ((c.pos.x - camX) ** 2 + (c.pos.z - camZ) ** 2 > 200 * 200) continue;
      let anim = this.lie.get(c.id);
      if (!anim) {
        anim = { lie: c.state === 'dead' || c.state === 'knocked' ? 1 : 0, walk: c.speed > 0.3 ? 1 : 0, air: c.onGround ? 0 : 1, frame: 0 };
        this.lie.set(c.id, anim);
      }
      anim.frame = this.frame;
      this.pose(c, anim, dt);
    }
    for (const [id, a] of this.lie) if (a.frame !== this.frame) this.lie.delete(id);
    const finish = (p: Part) => {
      p.mesh.count = p.n;
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    };
    for (const p of Object.values(this.parts)) finish(p);
    for (const p of this.weapons.values()) finish(p);
  }

  // ---------------------------------------------------------------------------
  // Matrices

  /**
   * A limb box hanging from joint a to joint b (its local -y runs from a towards b), its local x turned
   * towards `side`, its length scaled by `sy`. Leaves the unit basis in S.bx/by/bz.
   */
  private bone(part: Part, a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3, sy: number, color: number): void {
    const Y = S.by.subVectors(a, b);
    const l = Y.length();
    if (l > 1e-9) Y.divideScalar(l);
    else Y.set(0, 1, 0);
    const X = S.bx.copy(side).addScaledVector(Y, -side.dot(Y));
    if (X.lengthSq() < 1e-10) {
      // `side` runs along the bone: take the twist from the world axis least aligned with it.
      if (Math.abs(Y.y) < 0.9) X.set(0, 1, 0).addScaledVector(Y, -Y.y);
      else X.set(1, 0, 0).addScaledVector(Y, -Y.x);
    }
    X.normalize();
    const Z = S.bz.crossVectors(X, Y);
    S.inst.makeBasis(X, Y, Z).scale(S.sc.set(1, sy, 1)).setPosition(a);
    this.put(part, S.inst, color);
  }

  /** Upper arm, forearm and hand from the shoulder to the elbow to the centre of the hand. */
  private arm(shoulder: THREE.Vector3, elbow: THREE.Vector3, hand: THREE.Vector3, side: THREE.Vector3, c: Character): void {
    const s = c.appearance.height;
    this.bone(this.parts.upperArm, shoulder, elbow, side, s, c.appearance.shirt);
    const wrist = S.wrist.copy(elbow).lerp(hand, SKELETON.forearm / (SKELETON.forearm + SKELETON.hand));
    this.bone(this.parts.forearm, elbow, wrist, side, s, c.appearance.shirt);
    S.inst.makeBasis(S.bx, S.by, S.bz).scale(S.sc.set(s, s, s)).setPosition(hand);
    this.put(this.parts.hand, S.inst, c.appearance.skin);
  }

  /** Arm by two-bone IK from the shoulder to a hand target, the elbow bending towards `pole`. Returns the hand. */
  private armTo(shoulder: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3, side: THREE.Vector3, c: Character): THREE.Vector3 {
    const s = c.appearance.height;
    solveTwoBone(shoulder.x, shoulder.y, shoulder.z, target.x, target.y, target.z, SKELETON.upperArm * s, (SKELETON.forearm + SKELETON.hand) * s, pole.x, pole.y, pole.z, ik);
    S.elbow.set(ik.mx, ik.my, ik.mz);
    S.hand.set(ik.ex, ik.ey, ik.ez);
    this.arm(shoulder, S.elbow, S.hand, side, c);
    return S.hand;
  }

  /** Limb direction in the body frame: pitched (- forward) after spreading `spread` away from the body on side `sign`. */
  private limbDir(pitch: number, spread: number, sign: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(sign * spread), -Math.cos(spread) * Math.cos(pitch), -Math.cos(spread) * Math.sin(pitch)).transformDirection(S.body);
  }

  /** Arm by angles in the body frame: shoulder pitch, abduction, elbow flex forward and elbow bend outward. */
  private armFK(shoulder: THREE.Vector3, sign: number, pitch: number, abduct: number, elbowFwd: number, elbowOut: number, c: Character): void {
    const s = c.appearance.height;
    S.elbow.copy(shoulder).addScaledVector(this.limbDir(pitch, abduct, sign, S.d1), SKELETON.upperArm * s);
    S.hand.copy(S.elbow).addScaledVector(this.limbDir(pitch - elbowFwd, abduct + elbowOut, sign, S.d2), (SKELETON.forearm + SKELETON.hand) * s);
    this.arm(shoulder, S.elbow, S.hand, S.left, c);
  }

  /**
   * Leg by angles in the body frame: hip pitch (- forward), spread, knee flex; the foot at right angles to
   * the shin, its toes turned towards the knee by `ankle` (negative points them).
   */
  private legFK(hip: THREE.Vector3, sign: number, pitch: number, spread: number, knee: number, ankle: number, c: Character): void {
    const s = c.appearance.height;
    S.knee.copy(hip).addScaledVector(this.limbDir(pitch, spread, sign, S.d1), SKELETON.thigh * s);
    S.ankle.copy(S.knee).addScaledVector(this.limbDir(pitch + knee, spread, sign, S.d2), SKELETON.shin * s);
    this.bone(this.parts.thigh, hip, S.knee, S.left, s, c.appearance.pants);
    this.bone(this.parts.shin, S.knee, S.ankle, S.left, s, c.appearance.pants);
    S.e.set(pitch + knee - ankle, 0, sign * spread, 'YXZ');
    S.inst.copy(S.body).multiply(S.rot.makeRotationFromEuler(S.e)).scale(S.sc.set(1, s, s)).setPosition(S.ankle);
    this.put(this.parts.shoe, S.inst, 0x1a1a1a);
  }

  /** Shoe at the ankle, facing `yaw`, pitched (+ toe up). */
  private shoe(ankle: THREE.Vector3, yaw: number, pitch: number, s: number): void {
    S.e.set(-pitch, yaw, 0, 'YXZ');
    S.q.setFromEuler(S.e);
    S.inst.compose(ankle, S.q, S.sc.set(1, s, s));
    this.put(this.parts.shoe, S.inst, 0x1a1a1a);
  }

  /** Torso, neck, head and hair or hat on the body frame S.body at the pelvis, the head turned and pitched (- up). Sets S.neck. */
  private torso(c: Character, pelvis: THREE.Vector3, headPitch: number, headYaw = 0): void {
    const a = c.appearance;
    const s = a.height;
    S.inst.copy(S.body).scale(S.sc.set(a.build, s, a.build)).setPosition(pelvis);
    this.put(this.parts.torso, S.inst, a.shirt);
    this.put(this.parts.neck, S.inst, a.skin);
    S.neck.set(0, 1, 0).transformDirection(S.body).multiplyScalar(SKELETON.neckY * s).add(pelvis);
    S.e.set(headPitch, headYaw, 0, 'YXZ');
    S.inst.copy(S.body).multiply(S.rot.makeRotationFromEuler(S.e)).scale(S.sc.set(s, s, s)).setPosition(S.neck);
    this.put(this.parts.head, S.inst, a.skin);
    if (a.hat) this.put(this.parts.hat, S.inst, a.hat);
    else this.put(this.parts.hair, S.inst, a.hair);
  }

  /** Body frame axes into S.left/up/fwd and the shoulder joints into S.shL/shR. */
  private shoulders(c: Character, pelvis: THREE.Vector3): void {
    const s = c.appearance.height;
    S.left.set(1, 0, 0).transformDirection(S.body);
    S.up.set(0, 1, 0).transformDirection(S.body);
    S.fwd.set(0, 0, 1).transformDirection(S.body);
    const sx = shoulderSpread(c.appearance.build);
    const shY = SKELETON.shoulderY * s;
    S.shL.copy(pelvis).addScaledVector(S.up, shY).addScaledVector(S.left, sx);
    S.shR.copy(pelvis).addScaledVector(S.up, shY).addScaledVector(S.left, -sx);
  }

  /**
   * The drawn weapon matrix (into S.weapon): the pose frame, with the muzzle kicked up by `angle` about the
   * weapon-local `pivot` and pushed back by `back`.
   */
  private weaponMatrix(w: WeaponPose, angle: number, pivot: P3, back: number): THREE.Matrix4 {
    const m = S.weapon;
    S.bx.set(w.left.x, w.left.y, w.left.z);
    S.by.set(w.up.x, w.up.y, w.up.z);
    S.bz.set(w.dir.x, w.dir.y, w.dir.z);
    m.makeBasis(S.bx, S.by, S.bz).setPosition(w.origin.x, w.origin.y, w.origin.z);
    if (angle === 0 && back === 0) return m;
    // Weapon-local: about the pivot, pitch the muzzle up (a negative turn about x), then push along -z.
    m.multiply(S.rot.makeTranslation(pivot.x, pivot.y, pivot.z - back))
      .multiply(S.rot2.makeRotationX(-angle))
      .multiply(S.rot.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    return m;
  }

  // ---------------------------------------------------------------------------
  // Poses

  private pose(c: Character, anim: Anim, dt: number): void {
    const lying = c.state === 'dead' || c.state === 'knocked';
    anim.lie += clamp((lying ? 1 : 0) - anim.lie, -dt * 3, dt * (c.onGround ? 5 : 2.2));
    if (c.state === 'swimming') {
      anim.lie = 0;
      this.swim(c);
    } else if (anim.lie > 0.001) {
      this.lying(c, anim.lie);
    } else {
      this.upright(c, anim, dt);
    }
  }

  /** Standing, walking, running, jumping, aiming, punching, cowering and climbing into a car. */
  private upright(c: Character, anim: Anim, dt: number): void {
    const a = c.appearance;
    const s = a.height;
    const bw = a.build;
    const t = trunkPose(c, this.trunk);
    const entering = c.state === 'entering';
    const grounded = c.onGround || entering;
    anim.walk = damp(anim.walk, entering ? 1 : t.move, 10, dt);
    anim.air = damp(anim.air, grounded ? 0 : 1, 14, dt);
    // The trunk's gait cycle when it has one (the same speed and direction), else one for standing.
    const g = gait(c.animPhase, entering ? 1.8 : Math.max(0, c.speed), Math.atan2(t.mx, t.mz), this.gaitOut, s, bw, t.move > 0 && !entering ? t.cycle : null);
    const walk = anim.walk * (1 - anim.air);
    // Drawn hip height: the trunk's gait curve eased in and out of standing. The simulation uses the
    // unsmoothed curve, identical once a character walks or stands steadily.
    t.y = lerp(SKELETON.hipY * s, g.hipY, walk);

    const cower = c.brain?.mode === 'cower' && c.state === 'normal';
    const handsUp = cower && this.handsUp(c);
    const crouch = cower && !handsUp;
    const weapon = c.inventory.current;
    const armed = weapon !== 'fists' && !cower && !entering;
    const fists = weapon === 'fists' && !cower && !entering && (c.punchTimer > 0 || aimed(c));
    const punch = fists && c.punchTimer > 0 ? Math.sin(Math.PI * clamp(1 - c.punchTimer / 0.32, 0, 1)) : 0;
    const combo = ((c.meleeCombo % 3) + 3) % 3;

    // Weapon pose from the trunk before any drawn-only offsets, and its recoil.
    let kick = 0;
    if (armed) {
      weaponPoseInto(c, this.wp, t);
      kick = kickAmount(c.shotTimer);
    }

    // Drawn-only trunk offsets: crouching, punch step and twist, recoil.
    let lean = t.lean;
    let chestYaw = t.chestYaw;
    let drop = 0;
    let step = 0;
    if (crouch) {
      drop = 0.35 * s;
      lean = 0.85;
    }
    if (punch > 0) {
      if (combo === 2) {
        // The hook turns the shoulders through and steps the lead (left) foot in.
        chestYaw += 0.5 * punch;
        lean += 0.12 * punch;
        step = 0.1 * punch;
      } else chestYaw += (combo === 0 ? 0.18 : -0.14) * punch;
    }
    if (kick > 0) lean -= 0.04 * kick * (KICK[this.wp.weapon] / 0.12);

    const hipYaw = t.hipYaw;
    const hc = Math.cos(hipYaw);
    const hs = Math.sin(hipYaw);
    const P = S.pelvis.set(c.pos.x, c.pos.y + t.y - drop, c.pos.z);
    S.e.set(lean, chestYaw, 0, 'YXZ');
    S.body.makeRotationFromEuler(S.e);
    const headPitch = crouch ? 0.35 : aimed(c) ? -c.aimPitch * 0.6 - lean * 0.5 : -lean * 0.6;
    // Looking down the barrel of a shouldered gun, over the turned chest.
    this.torso(c, P, headPitch, aimed(c) ? wrapAngle(t.armYaw - chestYaw) : 0);
    this.shoulders(c, P);

    // Legs: planted gait feet, blended with standing feet, the crouch and the airborne tuck.
    const hipLeft = S.hipLeft.set(hc, 0, -hs);
    const hx = hipSpread(bw);
    const hipY = t.y - drop;
    const blend = walk < 0.999 || anim.air > 0.001 || drop > 0 || step > 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const leg = g.legs[i]!;
      if (blend) this.blendLeg(leg, side, hx, s, walk, anim.air, crouch, step, hipY);
      // Hip frame (yaw only, origin on the ground under the hips) to world.
      const hip = (i === 0 ? S.hipL : S.hipR).set(c.pos.x + hc * side * hx, P.y, c.pos.z - hs * side * hx);
      const k = leg.knee;
      const f = leg.ankle;
      S.knee.set(c.pos.x + hc * k.x + hs * k.z, c.pos.y + k.y, c.pos.z - hs * k.x + hc * k.z);
      S.ankle.set(c.pos.x + hc * f.x + hs * f.z, c.pos.y + f.y, c.pos.z - hs * f.x + hc * f.z);
      this.bone(this.parts.thigh, hip, S.knee, hipLeft, s, a.pants);
      this.bone(this.parts.shin, S.knee, S.ankle, hipLeft, s, a.pants);
      this.shoe(S.ankle, hipYaw, leg.foot.pitch, s);
    }

    // Arms.
    const left = S.left;
    const up = S.up;
    const fwd = S.fwd;
    const pole = S.pole;
    const reach = (SKELETON.upperArm + SKELETON.forearm + SKELETON.hand) * s;
    let leftDone = false;
    let rightDone = false;
    if (armed) {
      const w = this.wp;
      const gun = w.weapon;
      // The muzzle kicks up about the grip (pistol) or the shoulder (long guns, launcher) and pushes back.
      const m = this.weaponMatrix(w, kick * KICK[gun], gun === 'pistol' ? WEAPON_POINTS.pistol.grip : WEAPON_POINTS[gun].stock, KICK_BACK * kick);
      this.put(this.weapons.get(gun)!, m, 0xffffff);
      const grip = S.targetR.set(WEAPON_POINTS[gun].grip.x, WEAPON_POINTS[gun].grip.y, WEAPON_POINTS[gun].grip.z).applyMatrix4(m);
      pole.copy(up).negate().addScaledVector(left, w.mode === 'lowered' ? -0.4 : -0.8).addScaledVector(fwd, w.mode === 'lowered' ? -0.6 : -0.2);
      this.armTo(S.shR, grip, pole, left, c);
      rightDone = true;
      if (w.twoHands) {
        // Reloading, the off hand works the magazine or the pump.
        const work = w.mode === 'reload' ? 0.025 * Math.sin(this.time * 9) : 0;
        const off = S.targetL.set(w.offLocal.x, w.offLocal.y, w.offLocal.z + work).applyMatrix4(m);
        pole.copy(up).negate().addScaledVector(left, 0.7).addScaledVector(fwd, -0.2);
        this.armTo(S.shL, off, pole, left, c);
        leftDone = true;
      }
    } else if (fists) {
      // Guard up; punches alternate by combo: right jab, left jab, right hook with a twist and a step.
      for (const side of [1, -1]) {
        const sh = side > 0 ? S.shL : S.shR;
        const target = (side > 0 ? S.targetL : S.targetR).copy(sh).addScaledVector(fwd, (side > 0 ? 0.3 : 0.24) * s).addScaledVector(up, 0.1 * s).addScaledVector(left, -side * 0.13);
        const striking = punch > 0 && (combo === 1 ? side > 0 : side < 0);
        if (striking) {
          if (combo === 2) {
            // Hook: swings out wide, then across to the chin line with the elbow bent.
            S.d1.copy(sh).addScaledVector(fwd, 0.42 * s).addScaledVector(left, 0.12).addScaledVector(up, 0.05 * s);
            target.lerp(S.d1, punch).addScaledVector(left, -side * 0.22 * Math.sin(Math.PI * punch));
          } else {
            S.d1.copy(sh).addScaledVector(fwd, reach * 0.96).addScaledVector(left, -side * 0.06).addScaledVector(up, 0.02);
            target.lerp(S.d1, punch);
          }
        }
        pole.copy(up).negate().addScaledVector(left, side * 0.9).addScaledVector(fwd, -0.2);
        this.armTo(sh, target, pole, left, c);
      }
      leftDone = rightDone = true;
    } else if (cower) {
      for (const side of [1, -1]) {
        const sh = side > 0 ? S.shL : S.shR;
        const target = side > 0 ? S.targetL : S.targetR;
        if (handsUp) {
          target.copy(sh).addScaledVector(up, 0.42 * s).addScaledVector(left, side * 0.14).addScaledVector(fwd, 0.08);
          pole.copy(left).multiplyScalar(side).addScaledVector(up, -0.4);
        } else {
          // Hands clasped over the back of the head.
          target.copy(S.neck).addScaledVector(up, 0.27 * s).addScaledVector(left, side * 0.08).addScaledVector(fwd, -0.02);
          pole.copy(fwd).addScaledVector(left, side * 0.8);
        }
        this.armTo(sh, target, pole, left, c);
      }
      leftDone = rightDone = true;
    } else if (entering) {
      // Reaching for the door handle.
      S.targetR.copy(S.shR).addScaledVector(fwd, 0.5 * s).addScaledVector(up, -0.15 * s).addScaledVector(left, 0.05);
      pole.copy(up).negate().addScaledVector(left, -0.4).addScaledVector(fwd, -0.3);
      this.armTo(S.shR, S.targetR, pole, left, c);
      rightDone = true;
    }
    // Free arms swing with the gait, and go out for balance in the air.
    const air = anim.air;
    for (let i = 0; i < 2; i++) {
      if (i === 0 ? leftDone : rightDone) continue;
      const sw = g.arms[i]!;
      const pitch = lerp(lerp(-0.02, sw.pitch, walk), -0.8, air);
      const abduct = lerp(lerp(0.09, sw.abduct, walk), 0.55, air);
      const elbow = lerp(lerp(0.18, sw.elbow, walk), 0.8, air);
      this.armFK(i === 0 ? S.shL : S.shR, i === 0 ? 1 : -1, pitch, abduct, elbow, 0, c);
    }
  }

  /** Blends a gait leg towards the standing pose, the crouch and the airborne tuck, and re-solves it. */
  private blendLeg(leg: LegPose, side: number, hx: number, s: number, walk: number, air: number, crouch: boolean, step: number, hipY: number): void {
    const f = leg.foot;
    f.x = lerp(side * (hx + (crouch ? 0.08 : 0.015)), f.x, walk);
    f.y = lerp(SKELETON.ankleY * s, f.y, walk);
    f.z = lerp(crouch ? 0.05 * s : 0, f.z, walk) + (side > 0 ? step : 0);
    f.pitch = lerp(0, f.pitch, walk);
    if (air > 0) {
      // Knees drawn up under the body.
      f.x = lerp(f.x, side * hx, air);
      f.y = lerp(f.y, hipY - 0.5 * s, air);
      f.z = lerp(f.z, -0.08 * s, air);
      f.pitch = lerp(f.pitch, -0.45, air);
    }
    solveLeg(side * hx, hipY, s, leg);
  }

  /** Should a cowering ped put its hands up: the player is aiming a gun at it. */
  private handsUp(c: Character): boolean {
    const p = this.player;
    if (!p || p === c || !p.aiming || p.state !== 'normal' || p.inventory.current === 'fists') return false;
    if (c.brain?.threat === p) return true;
    // Peds that freeze when a gun is pointed at them keep no threat: judge by the aim line instead.
    const dx = c.pos.x - p.pos.x;
    const dz = c.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 20) return false;
    const off = Math.atan2(dx, dz) - p.aimYaw;
    return d < 1 || Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) < 0.5;
  }

  /** Knocked down, dead, or getting back up: on the back, limbs posed by angle. */
  private lying(c: Character, lie: number): void {
    const s = c.appearance.height;
    const bw = c.appearance.build;
    const dead = c.state === 'dead';
    const knocked = c.state === 'knocked';
    const ph = c.animPhase;
    // The hips tip over backwards onto the back as `lie` goes 0 -> 1.
    S.rot.makeRotationY(c.heading);
    const P = S.pelvis.set(0, SKELETON.hipY * s * (1 - lie) + 0.16 * lie, -0.5 * lie).applyMatrix4(S.rot).add(c.pos);
    S.body.copy(S.rot).multiply(S.rot2.makeRotationX((-Math.PI / 2) * lie));
    this.torso(c, P, dead ? 0.3 * (seeded(c.id, 1) - 0.5) : -0.25);
    this.shoulders(c, P);
    const hx = hipSpread(bw);
    for (const side of [1, -1]) {
      const sh = side > 0 ? S.shL : S.shR;
      const hip = (side > 0 ? S.hipL : S.hipR).copy(P).addScaledVector(S.left, side * hx);
      if (dead) {
        // Relaxed: arms a little out from the body, elbows slightly bent, legs together with a knee bend.
        const out = 0.25 + 0.5 * seeded(c.id, side > 0 ? 2 : 3);
        this.armFK(sh, side, 0.18, out, 0, -0.15 - 0.35 * seeded(c.id, side > 0 ? 4 : 5), c);
        const k = 0.25 + 0.45 * seeded(c.id, side > 0 ? 6 : 7);
        this.legFK(hip, side, -k * 0.55, 0.03 + 0.06 * seeded(c.id, side > 0 ? 8 : 9), k, -0.35, c);
      } else if (knocked) {
        // Bracing against the ground and kicking.
        this.armFK(sh, side, 0.35, 0.95 + 0.15 * Math.sin(ph * 2 + side), 0, 1.4, c);
        const kick = Math.sin(ph * 2 + side * 1.3) * 0.25;
        this.legFK(hip, side, -0.75 + kick, 0.08, 1.15 - kick, -0.1, c);
      } else {
        // Getting up: legs drawn in and arms pushing off, straightening as the body comes upright.
        this.armFK(sh, side, -0.6 * lie, lerp(0.09, 0.35, lie), lerp(0.18, 0.6, lie), 0, c);
        this.legFK(hip, side, -1.3 * lie, lerp(0.02, 0.12, lie), 1.9 * lie, 0, c);
      }
    }
  }

  /** Swimming face down: crawl strokes and a flutter kick, or treading water when still. */
  private swim(c: Character): void {
    const bw = c.appearance.build;
    const moving = c.speed > 0.3;
    const ph = moving ? c.animPhase : this.time * 3 + c.id;
    S.rot.makeRotationY(c.heading);
    const P = S.pelvis.set(0, 1.2, 0).applyMatrix4(S.rot).add(c.pos);
    S.body.copy(S.rot).multiply(S.rot2.makeRotationX(moving ? 1.25 : 0.35));
    this.torso(c, P, moving ? -0.9 : -0.3);
    this.shoulders(c, P);
    const hx = hipSpread(bw);
    for (const side of [1, -1]) {
      const sh = side > 0 ? S.shL : S.shR;
      const hip = (side > 0 ? S.hipL : S.hipR).copy(P).addScaledVector(S.left, side * hx);
      if (moving) {
        // Crawl: each arm circles overhead, half a stroke apart; the elbow bends on the pull.
        const arm = ph * 0.45 + (side > 0 ? 0 : Math.PI);
        const round = Math.PI * 2;
        this.armFK(sh, side, -(((arm % round) + round) % round), 0.25, 0.5 * Math.max(0, Math.sin(arm)), 0, c);
        const k = ph * 1.2 + side * 1.5;
        this.legFK(hip, side, Math.sin(k) * 0.35, 0.05, 0.25 + 0.15 * Math.sin(k + 1), -1.2, c);
      } else {
        // Treading water: arms sculling at the sides, legs cycling.
        const sc = Math.sin(ph + (side > 0 ? 0 : 1));
        this.armFK(sh, side, -0.5, 0.9 + 0.25 * sc, 0.6, 0, c);
        this.legFK(hip, side, -0.5 + 0.35 * Math.sin(ph * 0.8 + side), 0.1, 0.9, -0.3, c);
      }
    }
  }

  /** Height a vehicle kind's view is rotated about: half the model's height, measured as VehicleView does. */
  private pivotY(kind: VehicleKind): number {
    let p = this.pivots.get(kind);
    if (p === undefined) {
      p = new THREE.Box3().setFromObject(new VehicleView(kind).group).max.y / 2;
      this.pivots.set(kind, p);
    }
    return p;
  }

  /** A driver or passenger in the seat, carried by the vehicle's heading, pitch and roll. */
  private seated(c: Character, v: Vehicle): void {
    const a = c.appearance;
    const s = a.height;
    const bw = a.build;
    const pivot = this.pivotY(v.kind);
    // The vehicle frame exactly as VehicleView draws it: YXZ (heading, -pitch, roll) about the body centre.
    S.e.set(-v.pitch, v.heading, v.roll, 'YXZ');
    const vrot = S.vrot.makeRotationFromEuler(S.e);
    const side = c.seat === 0 || c.seat === 2 ? 1 : -1;
    const [front, rear] = SEAT_Z[v.kind] ?? [0.15, -0.9];
    const P = S.pelvis.set(side * v.halfW * 0.45, SEAT_Y[v.kind] - pivot, c.seat >= 2 ? rear : front).applyMatrix4(vrot);
    P.x += v.pos.x;
    P.y += v.pos.y + pivot;
    P.z += v.pos.z;
    S.vleft.set(1, 0, 0).transformDirection(vrot);
    S.vup.set(0, 1, 0).transformDirection(vrot);
    S.vfwd.set(0, 0, 1).transformDirection(vrot);
    // Sitting up, reclined a little against the seat back.
    S.body.copy(vrot).multiply(S.rot2.makeRotationX(-0.12));
    this.torso(c, P, 0.08);
    this.shoulders(c, P);
    // Thighs along the seat; shins and shoes are down in the footwell, out of sight.
    const hx = hipSpread(bw);
    for (const sd of [1, -1]) {
      const hip = (sd > 0 ? S.hipL : S.hipR).copy(P).addScaledVector(S.vleft, sd * hx);
      S.knee.copy(hip).addScaledVector(S.vfwd, SKELETON.thigh * s).addScaledVector(S.vup, 0.04 * s).addScaledVector(S.vleft, sd * 0.03);
      this.bone(this.parts.thigh, hip, S.knee, S.vleft, s, a.pants);
    }
    const pole = S.pole;
    const weapon = c.inventory.current;
    let busy = 0;
    if (weapon !== 'fists' && c.shotTimer > 0) {
      // Drive-by: the gun out of the window on the car's left, where vehicle shots leave from.
      busy = side;
      this.driveBy(c, v, weapon, side > 0 ? S.shL : S.shR, side);
    }
    for (const sd of [1, -1]) {
      if (sd === busy) continue;
      const target = sd > 0 ? S.targetL : S.targetR;
      if (c.seat === 0) {
        // Hands on the wheel at a quarter to three, turned with the steering (clockwise for a right turn).
        const W = DRIVER_WHEEL;
        const turn = clamp(v.steer, -1, 1) * W.lock;
        const wx = sd * W.radius * Math.cos(turn);
        const wy = sd * W.radius * Math.sin(turn);
        target.set(wx, W.up * s + wy * Math.cos(W.tilt), W.ahead * s - wy * Math.sin(W.tilt));
        pole.copy(S.vup).negate().addScaledVector(S.vleft, sd * 0.6);
      } else {
        // Hands resting in the lap.
        target.set(sd * 0.11, 0.1 * s, 0.26 * s);
        pole.copy(S.vfwd).multiplyScalar(-0.4).addScaledVector(S.vleft, sd * 0.4).sub(S.vup);
      }
      target.applyMatrix4(vrot).add(P);
      this.armTo(sd > 0 ? S.shL : S.shR, target, pole, S.left, c);
    }
  }

  /** A seated shooter's gun held out of the window towards the aim, with the muzzle where combat fires from. */
  private driveBy(c: Character, v: Vehicle, gun: Gun, shoulder: THREE.Vector3, side: number): void {
    const w = this.wp;
    const pts = WEAPON_POINTS[gun];
    w.weapon = gun;
    const yaw = c.aimYaw;
    const pitch = clamp(c.aimPitch, -1.2, 1.2);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    w.dir.x = sy * cp;
    w.dir.y = sp;
    w.dir.z = cy * cp;
    w.left.x = cy;
    w.left.y = 0;
    w.left.z = -sy;
    w.up.x = -sy * sp;
    w.up.y = cp;
    w.up.z = -cy * sp;
    // Muzzle point of CombatSystem.muzzle(c, true).
    const mx = v.pos.x + Math.cos(v.heading) * (v.halfW + 0.2);
    const my = v.pos.y + v.spec.height * 0.75;
    const mz = v.pos.z - Math.sin(v.heading) * (v.halfW + 0.2);
    const dz = pts.tip.z - pts.grip.z;
    const dy = pts.tip.y - pts.grip.y;
    const grip = S.targetL.set(mx - w.dir.x * dz - w.up.x * dy, my - w.dir.y * dz - w.up.y * dy, mz - w.dir.z * dz - w.up.z * dy);
    S.pole.copy(S.up).negate().addScaledVector(S.left, side * 0.5);
    // The hand reaches for the grip; the gun stays in the hand when the window is out of reach.
    const hand = this.armTo(shoulder, grip, S.pole, S.left, c);
    w.origin.x = hand.x - (w.left.x * pts.grip.x + w.up.x * pts.grip.y + w.dir.x * pts.grip.z);
    w.origin.y = hand.y - (w.left.y * pts.grip.x + w.up.y * pts.grip.y + w.dir.y * pts.grip.z);
    w.origin.z = hand.z - (w.left.z * pts.grip.x + w.up.z * pts.grip.y + w.dir.z * pts.grip.z);
    const kick = kickAmount(c.shotTimer);
    this.put(this.weapons.get(gun)!, this.weaponMatrix(w, kick * KICK[gun], pts.grip, KICK_BACK * kick), 0xffffff);
  }
}
