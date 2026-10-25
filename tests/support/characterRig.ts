// Poses one character in a chosen pose on two CrowdViews at once, one drawing segments (the d98da7b crowd) and one
// drawing the skinned models, and reads back the joints each one draws. CrowdView needs installCanvasStubs and the
// character models loaded (loadAssetsFromDisk) for the skinned one.

import * as THREE from 'three';
import { CrowdView } from '../../src/render/crowd';
import { drawnJoint, HEAD_ABOVE_NECK, REST, RIG, trunkJoint, makeRigPose, type RigBone } from '../../src/render/crowd/rig';
import { makeBrain } from '../../src/sim/brains';
import { stepCharacter, type CharacterPhysicsHost } from '../../src/sim/characterPhysics';
import { Character, type Appearance } from '../../src/sim/entities';
import { SKELETON, strideLength } from '../../src/sim/pose';
import type { Sim } from '../../src/sim/sim';
import type { WeaponId } from '../../src/sim/specs';
import type { StaticWorld } from '../../src/world/staticWorld';

export const flat: CharacterPhysicsHost = {
  world: { groundHeight: () => 0, bounds: { worldMinX: -1e5, worldMaxX: 1e5, worldMinZ: -1e5, worldMaxZ: 1e5 } } as unknown as StaticWorld,
  onCharacterHitByVehicle: () => {},
  onCharacterLanded: () => {},
  onCharacterSplash: () => {},
};

export const BASE_LOOK: Appearance = { skin: 0xc68642, shirt: 0x2a2c33, pants: 0x34557f, hair: 0x15110e, hat: 0, height: 1, build: 1 };

/** The joints compared: the bone the skinned crowd draws them with, and the manifest's joint name. */
export const COMPARED: ReadonlyArray<[string, RigBone]> = [
  ['pelvis', 'hips'], ['spine', 'abdomen'], ['chest', 'chest'], ['neck', 'neck'], ['head', 'head'],
  ['shoulderL', 'armL'], ['elbowL', 'foreL'], ['wristL', 'handL'], ['shoulderR', 'armR'], ['elbowR', 'foreR'], ['wristR', 'handR'],
  ['hipL', 'thighL'], ['kneeL', 'shinL'], ['ankleL', 'footL'], ['hipR', 'thighR'], ['kneeR', 'shinR'], ['ankleR', 'footR'],
];

type Part = { mesh: THREE.InstancedMesh };
const partsOf = (cv: CrowdView) => (cv as unknown as { parts: Record<string, Part> }).parts;

function at(p: Part, i: number): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  p.mesh.getMatrixAt(i, m);
  return m;
}

/**
 * The joints the segment crowd draws for its one character: the parts' pivots (CrowdView.bone and arm put each limb
 * at its upper joint), the wrist SKELETON.hand short of the hand along the forearm, and the trunk joints rigid with
 * the torso, as the segment body's one-piece torso carries them. Sides by the body's left axis.
 */
export function segmentJoints(cv: CrowdView, c: Character): Map<string, THREE.Vector3> {
  const P = partsOf(cv);
  const out = new Map<string, THREE.Vector3>();
  const torso = at(P.torso!, 0);
  const pelvis = new THREE.Vector3().setFromMatrixPosition(torso);
  const rot = new THREE.Matrix4().extractRotation(torso);
  const left = new THREE.Vector3(1, 0, 0).transformDirection(rot);
  const fake = makeRigPose();
  fake.pelvis.copy(pelvis);
  fake.body.copy(rot);
  fake.s = c.appearance.height;
  fake.build = c.appearance.build;
  out.set('pelvis', pelvis);
  out.set('spine', trunkJoint(fake, 'abdomen', new THREE.Vector3()));
  out.set('chest', trunkJoint(fake, 'chest', new THREE.Vector3()));
  const head = at(P.head!, 0);
  const neck = new THREE.Vector3().setFromMatrixPosition(head);
  out.set('neck', neck);
  out.set('head', new THREE.Vector3(0, HEAD_ABOVE_NECK * c.appearance.height, 0).applyMatrix4(new THREE.Matrix4().extractRotation(head)).add(neck));
  const side = (v: THREE.Vector3) => (v.clone().sub(pelvis).dot(left) >= 0 ? 'L' : 'R');
  const pair = (name: string, joint: string): Array<[string, THREE.Matrix4]> => {
    const p = P[name]!;
    const r: Array<[string, THREE.Matrix4]> = [];
    for (let i = 0; i < p.mesh.count; i++) {
      const m = at(p, i);
      const o = new THREE.Vector3().setFromMatrixPosition(m);
      r.push([joint + side(o), m]);
    }
    return r;
  };
  for (const [k, m] of pair('upperArm', 'shoulder')) out.set(k, new THREE.Vector3().setFromMatrixPosition(m));
  for (const [k, m] of pair('forearm', 'elbow')) out.set(k, new THREE.Vector3().setFromMatrixPosition(m));
  // The hands pair with the forearms: the hand a forearm's length from its elbow (the pairing with the smaller sum).
  const hands = P.hand!;
  const hs = Array.from({ length: hands.mesh.count }, (_, i) => new THREE.Vector3().setFromMatrixPosition(at(hands, i)));
  const reach = (SKELETON.forearm + SKELETON.hand) * c.appearance.height;
  const eL = out.get('elbowL');
  const eR = out.get('elbowR');
  if (hs.length === 2 && eL && eR) {
    const cost = (a: THREE.Vector3, b: THREE.Vector3) => Math.abs(eL.distanceTo(a) - reach) + Math.abs(eR.distanceTo(b) - reach);
    const [hl, hr] = cost(hs[0]!, hs[1]!) <= cost(hs[1]!, hs[0]!) ? [hs[0]!, hs[1]!] : [hs[1]!, hs[0]!];
    out.set('wristL', eL.clone().lerp(hl, SKELETON.forearm / (SKELETON.forearm + SKELETON.hand)));
    out.set('wristR', eR.clone().lerp(hr, SKELETON.forearm / (SKELETON.forearm + SKELETON.hand)));
  }
  const thighs = pair('thigh', 'hip');
  for (const [k, m] of thighs) {
    out.set(k, new THREE.Vector3().setFromMatrixPosition(m));
    // A seated rider's knee is where his thigh ends (no shin is drawn in the footwell).
    const y = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
    out.set('kneeEnd' + k.slice(3), new THREE.Vector3().setFromMatrixPosition(m).addScaledVector(y, -SKELETON.thigh * c.appearance.height));
  }
  for (const [k, m] of pair('shin', 'knee')) out.set(k, new THREE.Vector3().setFromMatrixPosition(m));
  for (const [k, m] of pair('shoe', 'ankle')) out.set(k, new THREE.Vector3().setFromMatrixPosition(m));
  for (const s of ['L', 'R']) if (!out.has('knee' + s) && out.has('kneeEnd' + s)) out.set('knee' + s, out.get('kneeEnd' + s)!);
  return out;
}

/** The joints the skinned crowd draws for character `id` (bone matrices applied to the rest joints). */
export function skinnedJoints(cv: CrowdView, id: number): Map<string, THREE.Vector3> | null {
  const b = cv.models?.bonesOf(id);
  if (!b) return null;
  const out = new Map<string, THREE.Vector3>();
  for (const [name, bone] of COMPARED) out.set(name, drawnJoint(b.data, b.offset, RIG.indexOf(bone), b.root, new THREE.Vector3()));
  return out;
}

export interface JointError {
  max: number;
  mean: number;
  worst: string;
  nan: boolean;
  compared: number;
}

export function compareJoints(seg: Map<string, THREE.Vector3>, skin: Map<string, THREE.Vector3>): JointError {
  let max = 0;
  let sum = 0;
  let n = 0;
  let worst = '';
  let nan = false;
  for (const [name] of COMPARED) {
    const a = seg.get(name);
    const b = skin.get(name);
    if (!b) continue;
    if (![b.x, b.y, b.z].every(Number.isFinite)) nan = true;
    if (!a) continue;
    const d = a.distanceTo(b);
    sum += d;
    n++;
    if (d > max) {
      max = d;
      worst = name;
    }
  }
  return { max, mean: n ? sum / n : 0, worst, nan, compared: n };
}

export type PoseName = string;

export interface PoseCase {
  name: PoseName;
  /** Sets up the character (and the sim when it needs one), then how many frames to settle. */
  setup: (c: Character, sim: Sim | null) => void;
  frames: number;
  /** Physics steps on flat ground each frame (walking); otherwise the pose is held. */
  step?: boolean;
  needsSim?: boolean;
  /** Joints the segment crowd does not draw in this pose. */
  skip?: readonly string[];
}

function arm(c: Character, w: WeaponId, pitch: number | null): void {
  c.inventory.give(w, 100);
  c.inventory.current = w;
  c.aiming = pitch !== null;
  c.aimPitch = pitch ?? 0;
  c.aimYaw = c.heading;
}

/** The poses VAL-CHR-002 lists. Walk and run phases are sampled by frame offsets within one stride. */
export function poseCases(): PoseCase[] {
  const cases: PoseCase[] = [{ name: 'idle', setup: () => {}, frames: 40 }];
  for (const [label, speed] of [['walk', 1.45], ['run', 4.3]] as const) {
    const period = strideLength(speed) / speed;
    for (let k = 0; k < 8; k++) {
      cases.push({
        name: `${label}-${k}`,
        setup: (c) => {
          c.moveX = 0;
          c.moveZ = 1;
          c.moveSpeed = speed;
        },
        frames: 120 + Math.round(((k / 8) * period) * 120),
        step: true,
      });
    }
  }
  for (const gun of ['pistol', 'rifle'] as const) {
    for (const pitch of [-0.5, 0, 0.6]) cases.push({ name: `${gun}-aim-${pitch}`, setup: (c) => arm(c, gun, pitch), frames: 40 });
  }
  cases.push({ name: 'crouch', setup: (c) => { c.brain = makeBrain('cower'); }, frames: 40 });
  cases.push({ name: 'entering', setup: (c) => { c.state = 'entering'; }, frames: 40 });
  cases.push({ name: 'downed', setup: (c) => { c.onGround = true; c.state = 'knocked'; }, frames: 90 });
  cases.push({ name: 'swim-tread', setup: (c) => { c.state = 'swimming'; c.speed = 0; }, frames: 40 });
  cases.push({ name: 'swim-crawl', setup: (c) => { c.state = 'swimming'; c.speed = 2; c.animPhase = 1.3; }, frames: 40 });
  cases.push({ name: 'phone', setup: (c) => { c.phoneTimer = 5; }, frames: 40 });
  cases.push({ name: 'throw', setup: (c) => arm(c, 'grenade', 0.2), frames: 40 });
  cases.push({
    name: 'driving',
    needsSim: true,
    setup: (c, sim) => {
      const s = sim!;
      const v = s.spawnVehicle('sedan', c.pos.x, c.pos.z, 0.4);
      s.seat(c, v, 0);
      v.steer = 0.4;
    },
    frames: 30,
    skip: ['ankleL', 'ankleR'],
  });
  return cases;
}

/** A fresh character for a pose case, standing at the origin facing +z (or on the sim's ground). */
export function personFor(id: number, appearance: Partial<Appearance> = {}, role: 'civilian' | 'player' = 'civilian'): Character {
  return new Character(id, role, 0, 0, 0, { ...BASE_LOOK, ...appearance });
}

/** Runs `pc` on both views; returns the character after the last frame. */
export function runPose(pc: PoseCase, c: Character, seg: CrowdView, skin: CrowdView, sim: Sim | null): Character {
  pc.setup(c, sim);
  const dt = pc.step ? 1 / 120 : 1 / 60;
  for (let i = 0; i < pc.frames; i++) {
    if (pc.step) stepCharacter(c, dt, flat);
    // The camera stands 4 m off: inside SKIN_RANGE, and near enough for the pool.
    seg.sync([c], c.pos.x + 4, c.pos.z, dt);
    skin.sync([c], c.pos.x + 4, c.pos.z, dt);
  }
  return c;
}

export const RIG_REST = REST;
