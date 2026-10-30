// Reads back the joints CrowdView draws for one character. CrowdView needs installCanvasStubs.

import * as THREE from 'three';
import type { CrowdView } from '../../src/render/crowd';
import type { Character } from '../../src/sim/entities';
import { SKELETON } from '../../src/sim/pose';

type Part = { mesh: THREE.InstancedMesh };
const partsOf = (cv: CrowdView) => (cv as unknown as { parts: Record<string, Part> }).parts;

function at(p: Part, i: number): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  p.mesh.getMatrixAt(i, m);
  return m;
}

/**
 * The joints the crowd draws for its one character: the parts' pivots (CrowdView.bone and arm put each limb at its
 * upper joint), the pelvis (the torso's origin), the neck (the head's), and the wrist SKELETON.hand short of the hand
 * along the forearm. Sides by the body's left axis.
 */
export function segmentJoints(cv: CrowdView, c: Character): Map<string, THREE.Vector3> {
  const P = partsOf(cv);
  const out = new Map<string, THREE.Vector3>();
  const torso = at(P.torso!, 0);
  const pelvis = new THREE.Vector3().setFromMatrixPosition(torso);
  const left = new THREE.Vector3(1, 0, 0).transformDirection(new THREE.Matrix4().extractRotation(torso));
  out.set('pelvis', pelvis);
  out.set('neck', new THREE.Vector3().setFromMatrixPosition(at(P.head!, 0)));
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
