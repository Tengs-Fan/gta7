// Fits a Quaternius character (src/assets, 62-bone CharacterArmature in a T-pose) to the canonical rest pose of rig.ts,
// and maps its bones onto the twenty rig bones.
//
// The models have stylised proportions (big head and hands, short upper arms, narrow shoulders); the game's skeleton
// (sim/pose.ts SKELETON) has its own, which the hit capsules, the arm IK and the weapon points rely on. The fit moves
// the model's joints onto SKELETON's: the trunk by a smooth map of height (hip joints, shoulder joints and neck pivot
// onto SKELETON's), each limb segment by an affine map from its own joints onto SKELETON's (stretched along the bone,
// widened across it), the head and hands scaled about their joints. Finger bones fold into the hand with a relaxed
// curl, so a hand is one rig bone. Each vertex keeps its weights, summed per rig bone (at most four).
import * as THREE from 'three';
import { SKELETON } from '../../sim/pose';
import { BONE, REST, HEAD_ABOVE_NECK, type RigBone } from './rig';

/** Manifest joint names (CHARACTER_JOINTS) that are rig bones, and the rig bone each becomes. */
const JOINT_TO_RIG: Readonly<Record<string, RigBone>> = {
  pelvis: 'hips', spine: 'abdomen', chest: 'torso', upperChest: 'chest', neck: 'neck', head: 'head',
  clavicleL: 'clavL', shoulderL: 'armL', elbowL: 'foreL', wristL: 'handL',
  clavicleR: 'clavR', shoulderR: 'armR', elbowR: 'foreR', wristR: 'handR',
  hipL: 'thighL', kneeL: 'shinL', ankleL: 'footL', hipR: 'thighR', kneeR: 'shinR', ankleR: 'footR',
};

/** Shape of the fit (multipliers on the model's own girth). */
export const FIT = {
  /** Head and hands: uniform scale about their joints. */
  head: 1.0,
  hand: 0.86,
  /** Across the upper arm and the forearm. */
  upperArm: 1.0,
  /** Across the shoulder top (the clavicle's region), flattened so the shoulder line drops from the neck. */
  clavicle: 0.72,
  forearm: 1.06,
  thigh: 1.03,
  shin: 1.0,
  /** Height of the model's ankle joint above its soles (the Foot bone sits at the sole). */
  ankle: 0.085,
  /** Finger curl at the knuckles, the middle and the end joints (rad). */
  curl: [0.22, 0.42, 0.32] as const,
} as const;

/** Trunk width (x) and depth (z) multipliers by height in the model (0 hip joints .. 1 shoulder joints, beyond 1 above). */
function trunkWidth(t: number): number {
  if (t < 0) return 0.94;
  if (t < 0.35) return THREE.MathUtils.lerp(0.94, 1.02, t / 0.35);
  if (t < 0.85) return THREE.MathUtils.lerp(1.02, 1.28, (t - 0.35) / 0.5);
  if (t < 1) return 1.28;
  if (t < 1.3) return THREE.MathUtils.lerp(1.28, 1, (t - 1) / 0.3);
  return 1;
}
function trunkDepth(t: number): number {
  if (t < 0.4) return 1;
  if (t < 0.85) return THREE.MathUtils.lerp(1, 1.06, (t - 0.4) / 0.45);
  if (t < 1.3) return THREE.MathUtils.lerp(1.06, 1, Math.min(1, (t - 0.85) / 0.45));
  return 1;
}

/** The model's own joints (bind pose, model space) that the fit maps from. */
export interface ModelJoints {
  legY: number;
  shoulderY: number;
  neckY: number;
  headY: number;
  z0: number;
  get(b: RigBone): THREE.Vector3;
  ankle(side: 0 | 1): THREE.Vector3;
}

export interface FittedPrimitive {
  name: string;
  material: string;
  color: THREE.Color;
  /** Indexed, in the rest pose: position, normal, skinIndex (rig bones), skinWeight. */
  geometry: THREE.BufferGeometry;
}

export interface FittedModel {
  id: string;
  primitives: FittedPrimitive[];
  joints: ModelJoints;
}

type Fn = (v: THREE.Vector3, n: THREE.Vector3) => void;

/** Rotation taking a's direction to b's, then: stretch `k` along b's direction and `g` across it, all about the origin. */
function segmentMatrix(qa: THREE.Vector3, qb: THREE.Vector3, sa: THREE.Vector3, sb: THREE.Vector3, g: number): THREE.Matrix4 {
  const dq = qb.clone().sub(qa);
  const ds = sb.clone().sub(sa);
  const k = ds.length() / dq.length();
  const u = ds.clone().normalize();
  const rot = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(dq.clone().normalize(), u));
  const sc = new THREE.Matrix4();
  const e = sc.elements;
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) e[c * 4 + r] = (r === c ? g : 0) + (k - g) * u.getComponent(r) * u.getComponent(c);
  return new THREE.Matrix4().makeTranslation(sa.x, sa.y, sa.z).multiply(sc).multiply(rot).multiply(new THREE.Matrix4().makeTranslation(-qa.x, -qa.y, -qa.z));
}

function affine(m: THREE.Matrix4): Fn {
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  return (v, n) => {
    v.applyMatrix4(m);
    n.applyMatrix3(nm);
  };
}

const rest = (b: RigBone): THREE.Vector3 => new THREE.Vector3(...REST[b]);

/**
 * Fits model `scene` (a clone; it is posed and modified) with joint map `bones` (manifest: joint -> bone name).
 * Returns null when the model lacks a skinned mesh or a mapped bone.
 */
export function fitCharacter(id: string, scene: THREE.Object3D, bones: Readonly<Record<string, string>>): FittedModel | null {
  const meshes: THREE.SkinnedMesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
  });
  if (meshes.length === 0) return null;
  const skeleton = meshes[0]!.skeleton;
  skeleton.pose();
  scene.updateMatrixWorld(true);
  const byName = new Map<string, THREE.Bone>();
  for (const m of meshes) for (const b of m.skeleton.bones) byName.set(b.name, b);
  const rigOfBone = new Map<THREE.Bone, RigBone>();
  for (const [joint, name] of Object.entries(bones)) {
    const rig = JOINT_TO_RIG[joint];
    const b = byName.get(name);
    if (!rig) continue;
    if (!b) return null;
    rigOfBone.set(b, rig);
  }
  const pos = (b: RigBone): THREE.Vector3 => {
    for (const [bone, r] of rigOfBone) if (r === b) return new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
    throw new Error(`${id}: no bone for ${b}`);
  };
  // Relaxed fingers: each finger joint turns about the hand's forward axis, towards the palm (palms face down at rest).
  for (const b of byName.values()) {
    const m = /^(Index|Middle|Ring|Pinky)([123])([LR])$/.exec(b.name);
    if (!m) continue;
    const angle = FIT.curl[Number(m[2]) - 1]! * (m[3] === 'L' ? -1 : 1);
    const world = new THREE.Quaternion();
    b.getWorldQuaternion(world);
    const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(world.invert());
    b.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis.normalize(), angle));
    b.updateMatrixWorld(true);
  }
  scene.updateMatrixWorld(true);

  const legY = pos('thighL').y;
  const z0 = pos('thighL').z;
  const shoulderY = pos('armL').y;
  const neckY = pos('neck').y;
  const headY = pos('head').y;
  const K = SKELETON;
  const sHip = K.hipY;
  const sShoulder = K.hipY + K.shoulderY;
  const sNeck = K.hipY + K.neckY;
  const sHead = sNeck + HEAD_ABOVE_NECK;
  /** The trunk's height map, and its slope. */
  const mapY = (y: number): number => {
    if (y <= legY) return sHip + (y - legY);
    if (y <= shoulderY) return sHip + ((y - legY) / (shoulderY - legY)) * (sShoulder - sHip);
    if (y <= neckY) return sShoulder + ((y - shoulderY) / (neckY - shoulderY)) * (sNeck - sShoulder);
    if (y <= headY) return sNeck + ((y - neckY) / (headY - neckY)) * (sHead - sNeck);
    return sHead + (y - headY) * FIT.head;
  };
  const slopeY = (y: number): number => {
    if (y <= legY) return 1;
    if (y <= shoulderY) return (sShoulder - sHip) / (shoulderY - legY);
    if (y <= neckY) return (sNeck - sShoulder) / (neckY - shoulderY);
    if (y <= headY) return (sHead - sNeck) / (headY - neckY);
    return FIT.head;
  };
  const tOf = (y: number): number => (y - legY) / (shoulderY - legY);
  const trunkPoint = (v: THREE.Vector3): THREE.Vector3 => {
    const t = tOf(v.y);
    return v.set(v.x * trunkWidth(t), mapY(v.y), (v.z - z0) * trunkDepth(t));
  };
  const trunk: Fn = (v, n) => {
    const t = tOf(v.y);
    const gx = trunkWidth(t);
    const gz = trunkDepth(t);
    const sy = slopeY(v.y);
    trunkPoint(v);
    n.set(n.x / gx, n.y / sy, n.z / gz);
  };

  const fns = new Map<RigBone, Fn>();
  for (const b of ['hips', 'abdomen', 'torso', 'chest', 'neck'] as const) fns.set(b, trunk);
  const head = pos('head');
  fns.set('head', affine(new THREE.Matrix4().makeTranslation(...REST.head).multiply(new THREE.Matrix4().makeScale(FIT.head, FIT.head, FIT.head)).multiply(new THREE.Matrix4().makeTranslation(-head.x, -head.y, -head.z))));
  const ankles: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  for (const [i, side] of [[0, 'L'], [1, 'R']] as const) {
    const clav = `clav${side}` as RigBone;
    const arm = `arm${side}` as RigBone;
    const fore = `fore${side}` as RigBone;
    const hand = `hand${side}` as RigBone;
    const thigh = `thigh${side}` as RigBone;
    const shin = `shin${side}` as RigBone;
    const foot = `foot${side}` as RigBone;
    const qc = pos(clav);
    fns.set(clav, affine(segmentMatrix(qc, pos(arm), trunkPoint(qc.clone()), rest(arm), FIT.clavicle)));
    fns.set(arm, affine(segmentMatrix(pos(arm), pos(fore), rest(arm), rest(fore), FIT.upperArm)));
    fns.set(fore, affine(segmentMatrix(pos(fore), pos(hand), rest(fore), rest(hand), FIT.forearm)));
    const qw = pos(hand);
    const turn = new THREE.Quaternion().setFromUnitVectors(qw.clone().sub(pos(fore)).normalize(), rest(hand).sub(rest(fore)).normalize());
    fns.set(hand, affine(new THREE.Matrix4().makeTranslation(...REST[hand]).multiply(new THREE.Matrix4().makeRotationFromQuaternion(turn)).multiply(new THREE.Matrix4().makeScale(FIT.hand, FIT.hand, FIT.hand)).multiply(new THREE.Matrix4().makeTranslation(-qw.x, -qw.y, -qw.z))));
    fns.set(thigh, affine(segmentMatrix(pos(thigh), pos(shin), rest(thigh), rest(shin), FIT.thigh)));
    const qf = pos(foot);
    const qa = ankles[i].set(qf.x, qf.y + FIT.ankle, qf.z);
    fns.set(shin, affine(segmentMatrix(pos(shin), qa, rest(shin), rest(foot), FIT.shin)));
    // The sole lands SKELETON.ankleY below the ankle; the toe is fitted to SKELETON.toe (sole envelope, see feet()).
    const ky = K.ankleY / (qa.y - Math.min(0, qf.y - 0.03));
    fns.set(foot, affine(new THREE.Matrix4().makeTranslation(...REST[foot]).multiply(new THREE.Matrix4().makeScale(1, ky, 1)).multiply(new THREE.Matrix4().makeTranslation(-qa.x, -qa.y, -qa.z))));
  }

  // Rig bone of every model bone: its own, or its nearest mapped ancestor; anything else (root, pole targets) the hips.
  const rigOf = (b: THREE.Object3D | null): RigBone => {
    for (let o: THREE.Object3D | null = b; o; o = o.parent) {
      const r = rigOfBone.get(o as THREE.Bone);
      if (r) return r;
    }
    return 'hips';
  };

  const primitives: FittedPrimitive[] = [];
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const acc = new THREE.Vector3();
  const accN = new THREE.Vector3();
  const raw = new THREE.Vector3();
  const rawN = new THREE.Vector3();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const P = g.getAttribute('position');
    const N = g.getAttribute('normal');
    const SI = g.getAttribute('skinIndex');
    const SW = g.getAttribute('skinWeight');
    const C = g.getAttribute('color');
    const sk = mesh.skeleton;
    // Per bone: raw vertex -> model space (mesh world * bind inverse * bone world * inverse bind * bind).
    const toModel = sk.bones.map((b, i) => new THREE.Matrix4().copy(mesh.matrixWorld).multiply(mesh.bindMatrixInverse).multiply(b.matrixWorld).multiply(sk.boneInverses[i]!).multiply(mesh.bindMatrix));
    const toModelN = toModel.map((m) => new THREE.Matrix3().getNormalMatrix(m));
    const boneRig = sk.bones.map((b) => BONE[rigOf(b)]);
    const count = P.count;
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const color = C ? new Float32Array(count * 3) : null;
    const w = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      acc.set(0, 0, 0);
      accN.set(0, 0, 0);
      w.clear();
      let total = 0;
      for (let k = 0; k < 4; k++) {
        const weight = SW.getComponent(i, k);
        if (weight <= 0) continue;
        const bi = SI.getComponent(i, k);
        raw.fromBufferAttribute(P, i).applyMatrix4(toModel[bi]!);
        rawN.fromBufferAttribute(N, i).applyMatrix3(toModelN[bi]!);
        const r = boneRig[bi]!;
        fns.get(RIG_NAME[r]!)!(v.copy(raw), n.copy(rawN));
        acc.addScaledVector(v, weight);
        accN.addScaledVector(n.normalize(), weight);
        w.set(r, (w.get(r) ?? 0) + weight);
        total += weight;
      }
      if (total <= 0) {
        // Unweighted vertex: bound to the hips as it is.
        raw.fromBufferAttribute(P, i).applyMatrix4(mesh.matrixWorld);
        trunk(acc.copy(raw), accN.set(0, 1, 0));
        w.set(BONE.hips, 1);
        total = 1;
      } else acc.divideScalar(total);
      position.set([acc.x, acc.y, acc.z], i * 3);
      accN.normalize();
      normal.set([accN.x, accN.y, accN.z], i * 3);
      const top = [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((s, e) => s + e[1], 0);
      top.forEach(([bone, weight], k) => {
        skinIndex[i * 4 + k] = bone;
        skinWeight[i * 4 + k] = weight / sum;
      });
      if (color && C) color.set([C.getX(i), C.getY(i), C.getZ(i)], i * 3);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(position, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    out.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    out.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    if (color) out.setAttribute('color', new THREE.BufferAttribute(color, 3));
    if (g.index) out.setIndex(g.index.clone());
    // Mirrored mesh transforms flip the winding.
    if (mesh.matrixWorld.determinant() < 0 && out.index) {
      const ix = out.index.array as Uint16Array | Uint32Array;
      for (let i = 0; i < ix.length; i += 3) {
        const t = ix[i + 1]!;
        ix[i + 1] = ix[i + 2]!;
        ix[i + 2] = t;
      }
    }
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    primitives.push({ name: mesh.name, material: mat?.name ?? '', color: (mat?.color ?? new THREE.Color(1, 1, 1)).clone(), geometry: smoothWeld(out) });
  }
  const joints: ModelJoints = { legY, shoulderY, neckY, headY, z0, get: pos, ankle: (side) => ankles[side].clone() };
  return { id, primitives, joints };
}

/** Normals closer than this (rad) are averaged where faces meet; sharper edges keep their crease. */
export const SMOOTH_ANGLE = 0.8;

/**
 * Welds the models' per-face (flat) vertices: those at one position whose normals are within SMOOTH_ANGLE become one
 * vertex with their mean normal, so the skin, cloth and joints shade smoothly and each character has about a third of
 * the vertices to skin.
 */
export function smoothWeld(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = g.index;
  if (!index) return g;
  const P = g.getAttribute('position');
  const N = g.getAttribute('normal');
  const n = P.count;
  const groups = new Map<string, number[]>();
  const remap = new Int32Array(n);
  const reps: number[] = [];
  const normals: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  const cos = Math.cos(SMOOTH_ANGLE);
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(P.getX(i) * 1e5)},${Math.round(P.getY(i) * 1e5)},${Math.round(P.getZ(i) * 1e5)}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    v.fromBufferAttribute(N, i).normalize();
    let found = -1;
    for (const c of list) {
      if (normals[c]!.clone().normalize().dot(v) >= cos) {
        found = c;
        break;
      }
    }
    if (found < 0) {
      found = reps.length;
      reps.push(i);
      normals.push(v.clone());
      list.push(found);
    } else normals[found]!.add(v);
    remap[i] = found;
  }
  if (reps.length === n) return g;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const Arr = a.array.constructor as new (len: number) => THREE.TypedArray;
    const arr = new Arr(reps.length * a.itemSize);
    reps.forEach((src, j) => {
      for (let k = 0; k < a.itemSize; k++) (arr as unknown as number[])[j * a.itemSize + k] = a.getComponent(src, k);
    });
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  const nn = out.getAttribute('normal');
  normals.forEach((m, j) => {
    m.normalize();
    nn.setXYZ(j, m.x, m.y, m.z);
  });
  const ix: number[] = [];
  for (let t = 0; t < index.count; t++) ix.push(remap[index.getX(t)]!);
  out.setIndex(ix);
  return out;
}

/** Cell size (m) the hands' vertices are clustered to: the models' fingers carry about a third of all vertices. */
export const HAND_CELL = 0.022;
/** Cells are longer along the hand (rest pose: the hands point along x) than across it. */
const HAND_CELL_ALONG = 0.036;

/**
 * Vertex clustering on the hands only: vertices bound wholly to a hand bone snap to a HAND_CELL grid (by side and
 * normal hemisphere, so the two faces of a finger stay apart), merged into their mean, and triangles left degenerate
 * are dropped. The rest of the mesh is kept as it is.
 */
export function simplifyHands(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = g.index;
  if (!index) return g;
  const P = g.getAttribute('position');
  const N = g.getAttribute('normal');
  const SI = g.getAttribute('skinIndex');
  const SW = g.getAttribute('skinWeight');
  const C = g.getAttribute('color');
  const n = P.count;
  const remap = new Int32Array(n);
  const cells = new Map<string, number>();
  const keep: number[] = [];
  const sums: number[][] = [];
  for (let i = 0; i < n; i++) {
    const b = SI.getX(i);
    if ((b === BONE.handL || b === BONE.handR) && SW.getX(i) > 0.999) {
      const key = `${b}:${Math.floor(P.getX(i) / HAND_CELL_ALONG)}:${Math.floor(P.getY(i) / HAND_CELL)}:${Math.floor(P.getZ(i) / HAND_CELL)}:${N.getY(i) > 0 ? 1 : 0}`;
      const c = cells.get(key);
      if (c !== undefined) {
        remap[i] = c;
        const s = sums[c]!;
        s[0]! += P.getX(i); s[1]! += P.getY(i); s[2]! += P.getZ(i);
        s[3]! += N.getX(i); s[4]! += N.getY(i); s[5]! += N.getZ(i);
        s[6]!++;
        continue;
      }
      cells.set(key, keep.length);
    }
    remap[i] = keep.length;
    sums.push([P.getX(i), P.getY(i), P.getZ(i), N.getX(i), N.getY(i), N.getZ(i), 1]);
    keep.push(i);
  }
  if (keep.length === n) return g;
  const m = keep.length;
  const pos = new Float32Array(m * 3);
  const nor = new Float32Array(m * 3);
  const si = new Uint16Array(m * 4);
  const sw = new Float32Array(m * 4);
  const col = C ? new Float32Array(m * 3) : null;
  const nv = new THREE.Vector3();
  keep.forEach((src, j) => {
    const s = sums[j]!;
    pos.set([s[0]! / s[6]!, s[1]! / s[6]!, s[2]! / s[6]!], j * 3);
    nv.set(s[3]!, s[4]!, s[5]!).normalize();
    nor.set([nv.x, nv.y, nv.z], j * 3);
    for (let k = 0; k < 4; k++) {
      si[j * 4 + k] = SI.getComponent(src, k);
      sw[j * 4 + k] = SW.getComponent(src, k);
    }
    if (col && C) col.set([C.getX(src), C.getY(src), C.getZ(src)], j * 3);
  });
  const ix: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = remap[index.getX(t)]!;
    const b = remap[index.getX(t + 1)]!;
    const c = remap[index.getX(t + 2)]!;
    if (a === b || b === c || a === c) continue;
    ix.push(a, b, c);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  out.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(ix);
  return out;
}

const RIG_NAME = Object.fromEntries(Object.entries(BONE).map(([k, v]) => [v, k])) as Record<number, RigBone>;
