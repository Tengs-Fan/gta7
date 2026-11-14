// The Ferris wheel's models for PropsView (props.ts buildFerris): its cabins, its braced rims and hub, and its A-frames.
// Geometry only; PropsView places and turns them. The wheel's parts keep their meshes (rim, cabins, legs), so none adds
// a draw.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bar, ModelBuilder } from './furniture';

// ---------------------------------------------------------------------------
// The Ferris wheel

/**
 * A gondola hung from its pivot (the origin, on the rim's middle plane): a round cabin 2.2 m across and 2 m tall whose
 * floor is 2.6 m under the pivot (the old box's envelope), its lower body and domed roof in the instance colour, a band
 * of dark glass between them split by six mullions, and the yoke up to the pivot. About 390 triangles.
 */
export function gondolaGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const seg = 10;
  const lathe = (pts: Array<[number, number]>) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  b.add('floor', lathe([[0, -2.6], [0.72, -2.6], [0.98, -2.47], [1.08, -2.22], [1.1, -1.76]]), 0xffffff, 0.92);
  b.add('glass', lathe([[1.1, -1.76], [1.07, -1.02]]), 0x1a2228);
  b.add('roof', lathe([[1.07, -1.02], [1.08, -0.92], [0.98, -0.8], [0.72, -0.68], [0.36, -0.6], [0, -0.58]]), 0xffffff, 1.08);
  b.add('sill', new THREE.TorusGeometry(1.105, 0.035, 4, seg).rotateX(Math.PI / 2).translate(0, -1.76, 0), 0xe8e8e8);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    b.add('mullion', new THREE.BoxGeometry(0.07, 0.76, 0.05).rotateY(-a).translate(Math.cos(a) * 1.09, -1.39, Math.sin(a) * 1.09), 0xffffff, 0.95);
  }
  // The yoke: a short arm on either side of the pivot down to the roof.
  b.add('hanger', bar(new THREE.Vector3(0, 0.05, 0), new THREE.Vector3(0, -0.62, 0), 0.07, 6), 0xd8d8d8);
  b.add('yoke', new THREE.BoxGeometry(0.16, 0.12, 0.9).translate(0, 0, 0), 0xd8d8d8);
  return b.build('gondola');
}

/** The wheel's two rims sit this far (m) either side of its middle plane, and the hub's flanges this far out. */
export const FERRIS_RIM_Z = 1.6;
const FLANGE_Z = 2.1;

/**
 * The wheel, about its hub (local z the axle): two rim tubes 2 FERRIS_RIM_Z apart braced by cross tubes and a zigzag of
 * diagonals into one truss (32 bays, one cross tube at each gondola's pivot), an inner ring each side, 32 tension
 * spokes from the hub's flanges to their rims (the two flanges' half a bay apart), the hub drum and the axle out to
 * `axleHalf` m. About 3,900 triangles, 1,000 more than the plain rims; finer lacing put the Medium view under the wheel
 * past 6% more triangles.
 */
export function ferrisWheelGeometry(R: number, axleHalf: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const P = (a: number, r: number, z: number) => new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, z);
  for (const z of [-FERRIS_RIM_Z, FERRIS_RIM_Z]) {
    parts.push(new THREE.TorusGeometry(R, 0.3, 6, 64).translate(0, 0, z));
    parts.push(new THREE.TorusGeometry(R * 0.35, 0.2, 6, 24).translate(0, 0, z));
  }
  const bays = 32;
  for (let k = 0; k < bays; k++) {
    const a = (k / bays) * Math.PI * 2;
    const a1 = ((k + 1) / bays) * Math.PI * 2;
    parts.push(bar(P(a, R, -FERRIS_RIM_Z), P(a, R, FERRIS_RIM_Z), 0.13, 4));
    const s = k % 2 === 0 ? 1 : -1;
    parts.push(bar(P(a, R, -s * FERRIS_RIM_Z), P(a1, R, s * FERRIS_RIM_Z), 0.09, 4));
  }
  for (const side of [-1, 1]) {
    for (let k = 0; k < 16; k++) {
      const a = ((k + (side > 0 ? 0 : 0.5)) / 16) * Math.PI * 2;
      parts.push(bar(P(a, 1.3, side * FLANGE_Z), P(a, R, side * FERRIS_RIM_Z), 0.06, 4));
    }
  }
  // The hub: a drum between two flanges, and the axle through it.
  parts.push(new THREE.CylinderGeometry(1.05, 1.05, 2 * FLANGE_Z, 16).rotateX(Math.PI / 2));
  for (const z of [-FLANGE_Z, FLANGE_Z]) parts.push(new THREE.CylinderGeometry(1.5, 1.5, 0.22, 16).rotateX(Math.PI / 2).translate(0, 0, z));
  parts.push(new THREE.CylinderGeometry(0.55, 0.55, 2 * axleHalf, 12).rotateX(Math.PI / 2));
  return mergedPlain(parts);
}

/** The A-frames' legs are octagonal tubes this thick at the foot and at the hub (m). */
const LEG_R0 = 0.5;
const LEG_R1 = 0.36;
/** One leg's tube: 8 sides, no caps (its foot in the sea, its head in the hub); non-indexed, so 48 vertices. */
export const LEG_VERTICES = 48;

/**
 * The wheel's two A-frames in the legs' frame (origin at the prop, local z the axle): each leg an octagonal tube cut
 * level at both ends, from its foot `sink` m down at x = +-`out` to the hub `rise` m up, at z = +-`legZ`; then the
 * bracing, all of it clear of the deck: a tie across each A-frame 15 m up (over the cabins' sweep, which keeps between
 * the frames), and on either side of the deck struts between the front and back legs at the deck, 9 and 18 m up with
 * crossed diagonals between them. The four legs come first, LEG_VERTICES each.
 */
export function ferrisLegsGeometry(out: number, sink: number, rise: number, legZ: number): THREE.BufferGeometry {
  const legs: THREE.BufferGeometry[] = [];
  /** The leg's centre line's x at height y (0 at the hub). */
  const xAt = (y: number) => out * (1 - (y + sink) / (rise + sink));
  for (const z of [-legZ, legZ]) {
    for (const sx of [-1, 1]) {
      const pos: number[] = [];
      const nrm: number[] = [];
      // Each vertex's normal points straight out from the leg's axis, so the octagon shades round.
      const ring = (y: number, r: number, k: number) => {
        const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
        pos.push(sx * xAt(y) + Math.cos(a) * r, y, z + Math.sin(a) * r);
        nrm.push(Math.cos(a), 0, Math.sin(a));
      };
      for (let k = 0; k < 8; k++) {
        ring(-sink, LEG_R0, k);
        ring(rise, LEG_R1, k + 1);
        ring(-sink, LEG_R0, k + 1);
        ring(-sink, LEG_R0, k);
        ring(rise, LEG_R1, k);
        ring(rise, LEG_R1, k + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      legs.push(g);
    }
  }
  const brace: THREE.BufferGeometry[] = [];
  const at = (sx: number, y: number, z: number) => new THREE.Vector3(sx * xAt(y), y, z);
  for (const z of [-legZ, legZ]) brace.push(bar(at(-1, 15, z), at(1, 15, z), 0.2, 8));
  for (const sx of [-1, 1]) {
    const levels = [0.2, 9, 18];
    for (const y of levels) brace.push(bar(at(sx, y, -legZ), at(sx, y, legZ), 0.16, 6));
    for (let i = 0; i + 1 < levels.length; i++) {
      brace.push(bar(at(sx, levels[i]!, -legZ), at(sx, levels[i + 1]!, legZ), 0.11, 6));
      brace.push(bar(at(sx, levels[i]!, legZ), at(sx, levels[i + 1]!, -legZ), 0.11, 6));
    }
  }
  return mergedPlain([...legs, ...brace]);
}

/** Merges geometries into one non-indexed geometry with position, normal and a zero uv. */
function mergedPlain(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count * 2), 2));
    return n;
  });
  const m = mergeGeometries(prepared, false);
  if (!m) throw new Error('mergeGeometries failed');
  return m;
}

