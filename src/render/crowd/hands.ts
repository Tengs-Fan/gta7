// Low-poly hands for the character models: a palm, four fingers bent at the knuckles and a thumb, in the rig's rest
// pose (arms straight out, palms down, thumbs forward). The models' own hands carry about a third of their vertices
// in tiny finger segments; these keep a separate thumb and fingers at a fraction of that.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALM, REST } from './rig';

/** Palm length from the wrist, its width and thickness (m), at height 1. */
const PALM_LEN = 0.085;
const PALM_W = 0.078;
const PALM_T = 0.03;
const FINGER = { len: 0.072, w: 0.017, t: 0.018, bend: 0.75 } as const;

function seg(len: number, w: number, t: number): THREE.BufferGeometry {
  // A box from x = 0 to x = len, tapered a little towards its tip; eight shared corners, smooth shaded.
  const box = new THREE.BoxGeometry(len, t, w);
  box.deleteAttribute('normal');
  box.deleteAttribute('uv');
  const g = mergeVertices(box);
  box.dispose();
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const k = x > 0 ? 0.82 : 1;
    p.setXYZ(i, x + len / 2, p.getY(i) * k, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

/** The left hand in its own frame: wrist at the origin, pointing +x, palm down (-y), thumb +z. */
function leftHand(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const palm = seg(PALM_LEN, PALM_W, PALM_T).translate(-0.006, 0, 0);
  parts.push(palm);
  // Fingers from the knuckle line, curled down (relaxed); the middle one longest.
  const lens = [0.92, 1, 0.95, 0.8];
  for (let i = 0; i < 4; i++) {
    const z = (1.5 - i) * (PALM_W / 4) * 0.95;
    const len = FINGER.len * lens[i]!;
    const proximal = seg(len * 0.55, FINGER.w, FINGER.t).rotateZ(-FINGER.bend * 0.45);
    const tipStart = new THREE.Vector3(len * 0.55, 0, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), -FINGER.bend * 0.45);
    const distal = seg(len * 0.5, FINGER.w * 0.92, FINGER.t * 0.9).rotateZ(-FINGER.bend * 1.25).translate(tipStart.x, tipStart.y, 0);
    for (const f of [proximal, distal]) parts.push(f.translate(PALM_LEN - 0.012, -0.002, z));
  }
  // Thumb: from the heel of the palm, out to the front and down.
  const thumb = seg(0.055, 0.02, 0.02).rotateY(-0.95).rotateZ(-0.35).translate(0.018, -0.006, PALM_W / 2 - 0.008);
  parts.push(thumb);
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  return g;
}

/** Both hands in the rest pose (left at REST.handL, right mirrored at REST.handR), each with the bone it is on. */
export function restHands(): Array<{ geometry: THREE.BufferGeometry; bone: 'handL' | 'handR' }> {
  const l = leftHand();
  const left = l.clone().translate(...REST.handL);
  // Mirror in x for the right hand (and flip the triangles' winding).
  const r = l.clone().scale(-1, 1, 1);
  const ix = r.index!;
  for (let i = 0; i < ix.count; i += 3) {
    const t = ix.getX(i + 1);
    ix.setX(i + 1, ix.getX(i + 2));
    ix.setX(i + 2, t);
  }
  r.translate(...REST.handR);
  l.dispose();
  return [{ geometry: left, bone: 'handL' }, { geometry: r, bone: 'handR' }];
}

/** The palm centre the gun grip sits in, PALM from the wrist (rig.ts). */
export const PALM_CENTRE = PALM;
