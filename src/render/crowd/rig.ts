// The skinned characters' rig: twenty bones driven by the pose CrowdView solves for the segment crowd (sim/pose.ts
// trunk, arm IK, gait leg IK), so a skinned body bends exactly where the segment body would.
//
// Every character model is refitted once (boneMap.ts) to one canonical rest pose: a T-pose with SKELETON's joints at
// height 1 and build 1, +x to the character's left, +y up, +z forward, feet on y = 0. A bone's skinning matrix maps
// that rest pose to the drawn pose: K = T(joint) * R * S * R*^T * T(-rest joint), where R* is the bone's frame in the
// rest pose, R its drawn frame and S the height, build and body-type scale. Its joint therefore lands exactly on the
// pose's joint. The matrices are written relative to `root` (under the pelvis on the ground) for float precision and
// for the batched crowd's per-instance bounds.
import * as THREE from 'three';
import { shoulderSpread, SKELETON } from '../../sim/pose';

export const RIG = [
  'hips', 'abdomen', 'torso', 'chest', 'neck', 'head',
  'clavL', 'armL', 'foreL', 'handL', 'clavR', 'armR', 'foreR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
] as const;
export type RigBone = (typeof RIG)[number];
export const BONE = Object.fromEntries(RIG.map((n, i) => [n, i])) as Record<RigBone, number>;
export const RIG_BONES = RIG.length;
/** Two more matrices per character carry its fade, lens flag and outfit colours to the shaders (see writeData). */
export const DATA_BONES = 2;
export const BONES_PER_CHAR = RIG_BONES + DATA_BONES;
export const FLOATS_PER_CHAR = BONES_PER_CHAR * 16;
/** Outfit colour slots (vertex attribute `slot`): 0 keeps the vertex colour. */
export const SLOTS = 7;
export type Slot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const SLOT = { fixed: 0, skin: 1, hair: 2, shirt: 3, pants: 4, hat: 5, shoes: 6, accent: 7 } as const;

/** The rest pose's spine and head pivots above the hip joints that the model fit maps the model's own onto. */
export const REST_SPINE = { abdomen: 0.05, torso: 0.22, chest: 0.44 } as const;
/** Head bone above the neck pivot (the point the segment head turns about) at rest. */
export const HEAD_ABOVE_NECK = 0.095;
/** Palm centre from the wrist along the hand: where a gun's grip sits (SKELETON.hand). */
export const PALM = SKELETON.hand;

const K = SKELETON;
const sh0 = shoulderSpread(1);
/** Clavicle pivot at rest: in from the shoulder joint, at the top of the chest. */
const CLAV = { x: 0.07, y: K.hipY + 0.5 } as const;

/** Rest joint positions (height 1, build 1). */
export const REST: Readonly<Record<RigBone, readonly [number, number, number]>> = {
  hips: [0, K.hipY, 0],
  abdomen: [0, K.hipY + REST_SPINE.abdomen, 0],
  torso: [0, K.hipY + REST_SPINE.torso, 0],
  chest: [0, K.hipY + REST_SPINE.chest, 0],
  neck: [0, K.hipY + K.neckY, 0],
  head: [0, K.hipY + K.neckY + HEAD_ABOVE_NECK, 0],
  clavL: [CLAV.x, CLAV.y, 0],
  armL: [sh0, K.hipY + K.shoulderY, 0],
  foreL: [sh0 + K.upperArm, K.hipY + K.shoulderY, 0],
  handL: [sh0 + K.upperArm + K.forearm, K.hipY + K.shoulderY, 0],
  clavR: [-CLAV.x, CLAV.y, 0],
  armR: [-sh0, K.hipY + K.shoulderY, 0],
  foreR: [-sh0 - K.upperArm, K.hipY + K.shoulderY, 0],
  handR: [-sh0 - K.upperArm - K.forearm, K.hipY + K.shoulderY, 0],
  thighL: [K.hipX, K.hipY, 0],
  shinL: [K.hipX, K.hipY - K.thigh, 0],
  footL: [K.hipX, K.hipY - K.thigh - K.shin, 0],
  thighR: [-K.hipX, K.hipY, 0],
  shinR: [-K.hipX, K.hipY - K.thigh, 0],
  footR: [-K.hipX, K.hipY - K.thigh - K.shin, 0],
};

/**
 * Rest frames of the limb bones, matching the segment crowd's bone basis (CrowdView.bone): local y runs from the far
 * joint back to the bone's own, local x is the side reference (the body's left) square to it. Arms rest straight out:
 * the frame that hangs them down with the palms in has x up on the left arm and down on the right. Trunk, head and feet
 * rest unrotated.
 */
const ARM_L = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1));
const ARM_R = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
export const REST_FRAME: Readonly<Record<RigBone, THREE.Matrix4>> = Object.fromEntries(RIG.map((n) => {
  if (n === 'armL' || n === 'foreL' || n === 'handL') return [n, ARM_L];
  if (n === 'armR' || n === 'foreR' || n === 'handR') return [n, ARM_R];
  return [n, new THREE.Matrix4()];
})) as Record<RigBone, THREE.Matrix4>;

/** Girth multipliers of a body type, by the bones they widen (across the bone, not along it). */
export interface BodyType {
  id: string;
  hips: number;
  belly: number;
  chest: number;
  arms: number;
  legs: number;
}
export const BODY_TYPES: readonly BodyType[] = [
  { id: 'average', hips: 1, belly: 1, chest: 1, arms: 1, legs: 1 },
  { id: 'slim', hips: 0.94, belly: 0.88, chest: 0.93, arms: 0.88, legs: 0.9 },
  { id: 'heavy', hips: 1.08, belly: 1.22, chest: 1.08, arms: 1.1, legs: 1.1 },
  { id: 'athletic', hips: 0.98, belly: 0.95, chest: 1.1, arms: 1.12, legs: 1.04 },
];

function girth(t: BodyType, b: number): number {
  switch (b) {
    case BONE.hips: return t.hips;
    case BONE.abdomen: return t.belly;
    case BONE.torso: return (t.belly + t.chest) / 2;
    case BONE.chest: return t.chest;
    case BONE.armL: case BONE.armR: return t.arms;
    case BONE.foreL: case BONE.foreR: return (1 + t.arms) / 2;
    case BONE.thighL: case BONE.thighR: return t.legs;
    case BONE.shinL: case BONE.shinR: return (1 + t.legs) / 2;
    default: return 1;
  }
}

type V = THREE.Vector3;
const v3 = () => new THREE.Vector3();
const m4 = () => new THREE.Matrix4();

/**
 * The pose of one character as CrowdView solved it (world space), recorded instead of drawn with segments. Index 0 is
 * the character's left side.
 */
export interface RigPose {
  id: number;
  /** appearance.height and .build. */
  s: number;
  build: number;
  pelvis: V;
  /** Chest frame (rotation only), the head's and the limbs' (CrowdView.bone's basis), and each foot's. */
  body: THREE.Matrix4;
  neck: V;
  head: THREE.Matrix4;
  shoulder: [V, V];
  upper: [THREE.Matrix4, THREE.Matrix4];
  elbow: [V, V];
  fore: [THREE.Matrix4, THREE.Matrix4];
  /** Centre of the hand (CrowdView's hand), the wrist SKELETON.hand short of it. */
  hand: [V, V];
  hip: [V, V];
  thigh: [THREE.Matrix4, THREE.Matrix4];
  knee: [V, V];
  shin: [THREE.Matrix4, THREE.Matrix4];
  ankle: [V, V];
  foot: [THREE.Matrix4, THREE.Matrix4];
  /** Which parts were recorded this frame (bits, see HAVE). */
  have: number;
  /** First-draw / removal fade 0..1 and whether the near-lens dissolve applies. */
  fade: number;
  lens: boolean;
  /** Weight of the standing idle motion (0..1) and the character's own clock for it (s). */
  idle: number;
  time: number;
  look: number;
  bodyType: number;
  /** Linear outfit colours for slots 1..7. */
  colors: Float32Array;
}

export const HAVE = { torso: 1, head: 2, armL: 4, armR: 8, legL: 16, legR: 32, footL: 64, footR: 128 } as const;
export const HAVE_ALL = 255;

export function makeRigPose(): RigPose {
  return {
    id: -1, s: 1, build: 1, pelvis: v3(), body: m4(), neck: v3(), head: m4(),
    shoulder: [v3(), v3()], upper: [m4(), m4()], elbow: [v3(), v3()], fore: [m4(), m4()], hand: [v3(), v3()],
    hip: [v3(), v3()], thigh: [m4(), m4()], knee: [v3(), v3()], shin: [m4(), m4()], ankle: [v3(), v3()], foot: [m4(), m4()],
    have: 0, fade: 1, lens: true, idle: 0, time: 0, look: 0, bodyType: 0, colors: new Float32Array(SLOTS * 3),
  };
}

// ---------------------------------------------------------------------------
// Idle motion: presentation only, never part of the sim; rotations about the joints, and a small swing of each arm
// about its shoulder, so no joint moves more than about a centimetre and a half.

/** Phase seed in 0..1 from an id (render-side hash, not the sim's RNG). */
export function idSeed(id: number, salt: number): number {
  let h = Math.imul(id ^ Math.imul(salt + 1, 0x9e3779b9), 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export interface IdleAngles {
  /** Breathing (chest pitch), weight shift (abdomen roll and the chest's counter-roll), head yaw and pitch, arm swing and the extra elbow flex. */
  breath: number;
  sway: number;
  headYaw: number;
  headPitch: number;
  armL: number;
  armR: number;
  elbow: number;
}

const DEG = Math.PI / 180;
/** Share of the upper arm's drop below the shoulder line that the clavicle follows. */
export const CLAV_DROP = 0.4;
/** Extra elbow bend standing idle, on top of the segment pose's (rad). */
export const IDLE_ELBOW = 0.035;

export function idleAngles(id: number, t: number, out: IdleAngles): IdleAngles {
  const a = idSeed(id, 1) * Math.PI * 2;
  const b = idSeed(id, 2) * Math.PI * 2;
  const c = idSeed(id, 3) * Math.PI * 2;
  const f = 0.9 + 0.2 * idSeed(id, 4);
  out.breath = 1.3 * DEG * Math.sin(2 * Math.PI * 0.28 * f * t + a);
  out.sway = 1.4 * DEG * Math.sin(2 * Math.PI * 0.26 * f * t + b);
  out.headYaw = 5 * DEG * Math.sin(2 * Math.PI * 0.3 * f * t + c) + 2 * DEG * Math.sin(2 * Math.PI * 0.13 * t + a);
  out.headPitch = 1.6 * DEG * Math.sin(2 * Math.PI * 0.37 * f * t + b + c);
  out.armL = 0.6 * DEG * Math.sin(2 * Math.PI * 0.26 * f * t + b + 0.6);
  out.armR = 0.6 * DEG * Math.sin(2 * Math.PI * 0.26 * f * t + b + 2.4);
  out.elbow = IDLE_ELBOW + 0.4 * DEG * Math.sin(2 * Math.PI * 0.33 * f * t + a + 1);
  return out;
}

// ---------------------------------------------------------------------------
// Bone matrices

const T = {
  q0: new THREE.Quaternion(),
  q1: new THREE.Quaternion(),
  q2: new THREE.Quaternion(),
  r: m4(),
  r2: m4(),
  l: m4(),
  pelvisRot: m4(),
  bodyRot: m4(),
  headRot: m4(),
  a: v3(),
  b: v3(),
  c: v3(),
  d: v3(),
  x: v3(),
  y: v3(),
  z: v3(),
  rest: v3(),
  restB: v3(),
  sh: v3(),
  el: v3(),
  wr: v3(),
  axis: v3(),
  euler: new THREE.Euler(),
  idle: { breath: 0, sway: 0, headYaw: 0, headPitch: 0, armL: 0, armR: 0, elbow: 0 } as IdleAngles,
  limb: [m4(), m4()] as [THREE.Matrix4, THREE.Matrix4],
  fore: [m4(), m4()] as [THREE.Matrix4, THREE.Matrix4],
};

/** The spine bones and how far each turns from the pelvis towards the chest. */
const SPINE = [['abdomen', 0.4], ['torso', 0.75], ['chest', 1]] as const;

/** Writes K' = T(p - root) * L * T(-rest) into out[o .. o+16] (column-major) where L is the 3x3 part of `l`. */
function writeBone(out: Float32Array, o: number, l: THREE.Matrix4, p: V, root: V, rest: readonly [number, number, number]): void {
  const e = l.elements;
  const rx = rest[0];
  const ry = rest[1];
  const rz = rest[2];
  out[o] = e[0]!; out[o + 1] = e[1]!; out[o + 2] = e[2]!; out[o + 3] = 0;
  out[o + 4] = e[4]!; out[o + 5] = e[5]!; out[o + 6] = e[6]!; out[o + 7] = 0;
  out[o + 8] = e[8]!; out[o + 9] = e[9]!; out[o + 10] = e[10]!; out[o + 11] = 0;
  out[o + 12] = p.x - root.x - (e[0]! * rx + e[4]! * ry + e[8]! * rz);
  out[o + 13] = p.y - root.y - (e[1]! * rx + e[5]! * ry + e[9]! * rz);
  out[o + 14] = p.z - root.z - (e[2]! * rx + e[6]! * ry + e[10]! * rz);
  out[o + 15] = 1;
}

/** l = rot * diag(sx, sy, sz) * restFrame^T (3x3 parts). */
function frameScale(l: THREE.Matrix4, rot: THREE.Matrix4, sx: number, sy: number, sz: number, restFrame: THREE.Matrix4): THREE.Matrix4 {
  l.copy(rot);
  const e = l.elements;
  e[0]! *= sx; e[1]! *= sx; e[2]! *= sx;
  e[4]! *= sy; e[5]! *= sy; e[6]! *= sy;
  e[8]! *= sz; e[9]! *= sz; e[10]! *= sz;
  e[12] = 0; e[13] = 0; e[14] = 0;
  return l.multiply(T.r2.copy(restFrame).transpose());
}

function restV(b: RigBone, out: V): V {
  const r = REST[b];
  return out.set(r[0], r[1], r[2]);
}

/** Root the bone matrices are written relative to: under the pelvis on the ground (the rest pose's origin). */
export function rigRoot(p: RigPose, out: V): V {
  return out.copy(p.pelvis).addScaledVector(T.y.set(0, 1, 0), -K.hipY * p.s);
}

/**
 * Trunk joint `b` of pose `p`: rigid with the chest frame from the pelvis, scaled by build and height, as the segment
 * crowd draws its one-piece torso. Also the segment crowd's equivalent of that joint.
 */
export function trunkJoint(p: RigPose, b: RigBone, out: V): V {
  const r = REST[b];
  return out.set(r[0] * p.build, (r[1] - K.hipY) * p.s, r[2] * p.build).applyMatrix4(T.bodyRot.extractRotation(p.body)).add(p.pelvis);
}

/** Rotation that takes unit vector a to unit vector b, into m. */
function alignInto(a: V, b: V, m: THREE.Matrix4): THREE.Matrix4 {
  T.q0.setFromUnitVectors(a, b);
  return m.makeRotationFromQuaternion(T.q0);
}

/**
 * Fills out[o .. o + FLOATS_PER_CHAR] with pose p's bone matrices (relative to `root`) and its data matrices. With
 * `idle` false the idle motion is left out (tests compare the bare pose with the segment crowd).
 */
export function poseBones(p: RigPose, out: Float32Array, o: number, root: V, idle = true): void {
  const s = p.s;
  const bw = p.build;
  const type = BODY_TYPES[p.bodyType] ?? BODY_TYPES[0]!;
  const w = idle ? p.idle : 0;
  const ia = w > 0 ? idleAngles(p.id, p.time, T.idle) : null;
  const body = T.bodyRot.extractRotation(p.body);
  // Pelvis: across the hip joints, upright with the chest's lean.
  const x = T.x.subVectors(p.hip[0], p.hip[1]);
  const up = T.y.set(0, 1, 0).transformDirection(body);
  if ((p.have & (HAVE.legL | HAVE.legR)) === (HAVE.legL | HAVE.legR) && x.lengthSq() > 1e-8) {
    x.normalize();
    up.addScaledVector(x, -up.dot(x)).normalize();
    T.z.crossVectors(x, up);
    T.pelvisRot.makeBasis(x, up, T.z);
  } else T.pelvisRot.copy(body);
  T.q0.setFromRotationMatrix(T.pelvisRot);
  T.q1.setFromRotationMatrix(body);

  const trunk = (b: RigBone, rot: THREE.Matrix4): void => {
    const g = girth(type, BONE[b]);
    frameScale(T.l, rot, bw * g, s, bw * g, REST_FRAME[b]);
    writeBone(out, o + BONE[b] * 16, T.l, trunkJoint(p, b, T.a), root, REST[b]);
  };
  trunk('hips', T.pelvisRot);
  // The spine turns from the pelvis to the chest; idle breathing pitches the chest and the weight shift rolls the waist.
  for (const [b, f] of SPINE) {
    T.q2.slerpQuaternions(T.q0, T.q1, f);
    T.r.makeRotationFromQuaternion(T.q2);
    if (ia) {
      const pitch = b === 'chest' ? ia.breath * w : b === 'torso' ? ia.breath * 0.5 * w : 0;
      const roll = (b === 'abdomen' ? ia.sway : b === 'torso' ? -ia.sway * 0.4 : -ia.sway * 0.3) * w;
      T.r.multiply(T.r2.makeRotationFromEuler(T.euler.set(-pitch, 0, roll, 'YXZ')));
    }
    trunk(b, T.r);
  }

  // Head: the segment head frame (about the neck pivot), turned a little by the idle motion; the neck between.
  T.headRot.extractRotation(p.head);
  if (ia) T.headRot.multiply(T.r2.makeRotationFromEuler(T.euler.set(-ia.headPitch * w, ia.headYaw * w, 0, 'YXZ')));
  T.q2.setFromRotationMatrix(T.headRot);
  T.q0.copy(T.q1).slerp(T.q2, 0.6);
  T.r.makeRotationFromQuaternion(T.q0);
  frameScale(T.l, T.r, s, s, s, REST_FRAME.neck);
  writeBone(out, o + BONE.neck * 16, T.l, p.neck, root, REST.neck);
  frameScale(T.l, T.headRot, s, s, s, REST_FRAME.head);
  T.a.set(0, HEAD_ABOVE_NECK * s, 0).applyMatrix4(T.headRot).add(p.neck);
  writeBone(out, o + BONE.head * 16, T.l, T.a, root, REST.head);

  // Arms (index 0 left).
  for (let i = 0; i < 2; i++) {
    const L = i === 0;
    const clav: RigBone = L ? 'clavL' : 'clavR';
    const arm: RigBone = L ? 'armL' : 'armR';
    const fore: RigBone = L ? 'foreL' : 'foreR';
    const hand: RigBone = L ? 'handL' : 'handR';
    const sh = T.sh.copy(p.shoulder[i]!);
    const el = T.el.copy(p.elbow[i]!);
    const upper = T.limb[i]!.copy(p.upper[i]!);
    const foreRot = T.fore[i]!.copy(p.fore[i]!);
    // Wrist: SKELETON.hand short of the hand centre along the forearm (CrowdView.arm).
    const wr = T.wr.copy(el).lerp(p.hand[i]!, K.forearm / (K.forearm + K.hand));
    if (ia) {
      // Arm swing about the shoulder (the body's left axis), and a slightly softer elbow.
      const swing = (L ? ia.armL : ia.armR) * w;
      T.r.makeRotationAxis(T.axis.set(1, 0, 0).transformDirection(body), swing);
      el.sub(sh).applyMatrix4(T.r).add(sh);
      wr.sub(sh).applyMatrix4(T.r).add(sh);
      upper.premultiply(T.r);
      foreRot.premultiply(T.r);
      const flex = -ia.elbow * w;
      T.r.makeRotationAxis(T.axis.set(1, 0, 0).transformDirection(foreRot), flex);
      wr.sub(el).applyMatrix4(T.r).add(el);
      foreRot.premultiply(T.r);
    }
    // Clavicle: from its pivot on the chest out to the shoulder joint, stretched to reach it.
    const pc = trunkJoint(p, clav, T.a);
    const d = T.b.subVectors(sh, pc).applyMatrix4(T.r2.copy(body).transpose());
    const dl = d.length();
    const rest = T.rest.set(REST[arm][0] - REST[clav][0], REST[arm][1] - REST[clav][1], REST[arm][2] - REST[clav][2]);
    const rl = rest.length();
    rest.divideScalar(rl);
    d.divideScalar(Math.max(dl, 1e-6));
    alignInto(rest, d, T.r);
    // body * align * (s I + (k - s) u u^T): stretched along the rest direction u, scaled by height across it.
    const k = dl / rl;
    const u = rest;
    const e = T.l.identity().elements;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) e[c * 4 + r] = (r === c ? s : 0) + (k - s) * u.getComponent(r) * u.getComponent(c);
    T.l.premultiply(T.r);
    // A lowered arm takes the shoulder top down with it a little (about the clavicle pivot, as the models' own
    // clips do), so the deltoid rounds over instead of standing up as a pad.
    T.c.subVectors(el, sh).applyMatrix4(T.r2.copy(body).transpose());
    const drop = Math.asin(THREE.MathUtils.clamp(-T.c.y / Math.max(T.c.length(), 1e-6), 0, 1));
    if (drop > 0) T.l.premultiply(T.r.makeRotationZ((L ? -1 : 1) * CLAV_DROP * drop));
    T.l.premultiply(body);
    writeBone(out, o + BONE[clav] * 16, T.l, pc, root, REST[clav]);
    const ga = girth(type, BONE[arm]);
    frameScale(T.l, upper.extractRotation(upper), ga * s, s, ga * s, REST_FRAME[arm]);
    writeBone(out, o + BONE[arm] * 16, T.l, sh, root, REST[arm]);
    const gf = girth(type, BONE[fore]);
    frameScale(T.l, foreRot.extractRotation(foreRot), gf * s, s, gf * s, REST_FRAME[fore]);
    writeBone(out, o + BONE[fore] * 16, T.l, el, root, REST[fore]);
    frameScale(T.l, foreRot, s, s, s, REST_FRAME[hand]);
    writeBone(out, o + BONE[hand] * 16, T.l, wr, root, REST[hand]);
  }

  // Legs.
  for (let i = 0; i < 2; i++) {
    const L = i === 0;
    const thigh: RigBone = L ? 'thighL' : 'thighR';
    const shin: RigBone = L ? 'shinL' : 'shinR';
    const foot: RigBone = L ? 'footL' : 'footR';
    const gt = girth(type, BONE[thigh]);
    frameScale(T.l, T.r.extractRotation(p.thigh[i]!), gt * s, s, gt * s, REST_FRAME[thigh]);
    writeBone(out, o + BONE[thigh] * 16, T.l, p.hip[i]!, root, REST[thigh]);
    const gs = girth(type, BONE[shin]);
    frameScale(T.l, T.r.extractRotation(p.shin[i]!), gs * s, s, gs * s, REST_FRAME[shin]);
    writeBone(out, o + BONE[shin] * 16, T.l, p.knee[i]!, root, REST[shin]);
    frameScale(T.l, T.r.extractRotation(p.foot[i]!), s, s, s, REST_FRAME[foot]);
    writeBone(out, o + BONE[foot] * 16, T.l, p.ankle[i]!, root, REST[foot]);
  }
  writeData(p, out, o + RIG_BONES * 16);
}

/** Data matrices: [fade, lens, 0, 0], then the seven slot colours as (r, g, b, 0). */
export function writeData(p: RigPose, out: Float32Array, o: number): void {
  out[o] = p.fade;
  out[o + 1] = p.lens ? 1 : 0;
  out[o + 2] = 0;
  out[o + 3] = 0;
  for (let i = 0; i < SLOTS; i++) {
    out[o + 4 + i * 4] = p.colors[i * 3]!;
    out[o + 5 + i * 4] = p.colors[i * 3 + 1]!;
    out[o + 6 + i * 4] = p.colors[i * 3 + 2]!;
    out[o + 7 + i * 4] = 0;
  }
}

/** World position of rig bone b as drawn by the matrices at out[o..] (its rest joint carried by its matrix). */
export function drawnJoint(out: Float32Array, o: number, b: number, root: V, target: V): V {
  const r = REST[RIG[b]!];
  const e = o + b * 16;
  return target.set(
    out[e]! * r[0] + out[e + 4]! * r[1] + out[e + 8]! * r[2] + out[e + 12]! + root.x,
    out[e + 1]! * r[0] + out[e + 5]! * r[1] + out[e + 9]! * r[2] + out[e + 13]! + root.y,
    out[e + 2]! * r[0] + out[e + 6]! * r[1] + out[e + 10]! * r[2] + out[e + 14]! + root.z,
  );
}

/** Skins rest-pose point (x, y, z) with one bone's matrix at out[o..]: the drawn point relative to the root. */
export function skinPoint(out: Float32Array, o: number, b: number, x: number, y: number, z: number, target: V): V {
  const e = o + b * 16;
  return target.set(
    out[e]! * x + out[e + 4]! * y + out[e + 8]! * z + out[e + 12]!,
    out[e + 1]! * x + out[e + 5]! * y + out[e + 9]! * z + out[e + 13]!,
    out[e + 2]! * x + out[e + 6]! * y + out[e + 10]! * z + out[e + 14]!,
  );
}

export const restVector = restV;

/**
 * Fills the limbs a pose did not record (the segment pose leaves none out on foot; a rider's or a lying pose may):
 * arms and legs hang straight down from their joints in the chest frame, feet flat under the shins.
 */
export function completePose(p: RigPose): void {
  if ((p.have & HAVE_ALL) === HAVE_ALL) return;
  const body = T.bodyRot.extractRotation(p.body);
  const up = T.y.set(0, 1, 0).transformDirection(body);
  const s = p.s;
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;
    if (!(p.have & (i === 0 ? HAVE.armL : HAVE.armR))) {
      p.shoulder[i]!.set(side * shoulderSpread(p.build), K.shoulderY * s, 0).applyMatrix4(body).add(p.pelvis);
      p.elbow[i]!.copy(p.shoulder[i]!).addScaledVector(up, -K.upperArm * s);
      p.hand[i]!.copy(p.elbow[i]!).addScaledVector(up, -(K.forearm + K.hand) * s);
      p.upper[i]!.copy(body);
      p.fore[i]!.copy(body);
    }
    if (!(p.have & (i === 0 ? HAVE.legL : HAVE.legR))) {
      p.hip[i]!.set(side * K.hipX * p.build, 0, 0).applyMatrix4(body).add(p.pelvis);
      p.knee[i]!.copy(p.hip[i]!).addScaledVector(up, -K.thigh * s);
      p.thigh[i]!.copy(body);
      p.shin[i]!.copy(body);
      p.ankle[i]!.copy(p.knee[i]!).addScaledVector(up, -K.shin * s);
      p.foot[i]!.copy(body);
    } else if (!(p.have & (i === 0 ? HAVE.footL : HAVE.footR))) {
      p.ankle[i]!.copy(p.knee[i]!).addScaledVector(T.z.set(0, 1, 0).transformDirection(p.shin[i]!), -K.shin * s);
      p.foot[i]!.copy(body);
    }
  }
  p.have = HAVE_ALL;
}
