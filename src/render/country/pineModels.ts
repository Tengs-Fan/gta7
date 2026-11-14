// Pinewood's pines (world/country/lakeland.ts) as one model for PropsView to instance: a slender conical conifer, a bare
// lower trunk under seven overlapping skirts of needles that narrow to a spire, each skirt's hem notched like a spray of
// boughs whose tips droop. The silhouette is nothing like the city's round broadleaf crowns, and it is cheap (110
// triangles): one non-indexed geometry with a vertex colour per vertex, its origin at its foot, 11.7 m tall at scale 1.
// A skirt's normals are the cone's, not its facets', so it shades round rather than in hard flat panels, and its colour
// runs from sunlit tips to the dark inner corners of its notches.

import * as THREE from 'three';
import { cyl, ModelBuilder } from '../furniture';

/** The pine's skirts of needles: from the lowest, its hem's height over the foot, its radius there and its height. */
export const PINE_TIERS = Array.from({ length: 7 }, (_, k) => ({ y: 1.7 + k * 1.35, r: 2.05 - k * 0.27, h: 2.5 - k * 0.12 }));
/** The pine's whole height (m, at scale 1). */
export const PINE_H = PINE_TIERS[6]!.y + PINE_TIERS[6]!.h;
/** Boughs round each skirt's hem. */
const BOUGHS = 7;
/** How far a bough's tip droops under the hem (m), and how far up the notch between two tips rises over it. */
const DROOP = 0.22;
const NOTCH = 0.16;

/**
 * A skirt: a cone from its apex down to a hem of `n` boughs, the tips at `r` drooping DROOP under `y`, the notches between
 * them at 0.72 r and NOTCH over it. Each vertex takes the cone's normal there (straight up at the apex), and `shade` gets
 * each vertex's brightness: the tips lit, the notches deep in shadow, the apex between.
 */
function skirt(y: number, r: number, h: number, n: number, phase: number, shade: number[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  // The cone's slope: its normal leans out by the angle the hem's radius makes with the height.
  const len = Math.hypot(r, h);
  const ny = r / len;
  const nr = h / len;
  const hem = (i: number): { p: [number, number, number]; n: [number, number, number]; s: number } => {
    const a = phase + (i / (2 * n)) * Math.PI * 2;
    const tip = i % 2 === 0;
    const out = tip ? r : r * 0.72;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // A tip's normal leans further out, a notch's further up, so the boughs read as boughs in the light.
    const lean = tip ? 1.1 : 0.75;
    const l = Math.hypot(nr * lean, ny);
    return { p: [c * out, tip ? y - DROOP : y + NOTCH, s * out], n: [(c * nr * lean) / l, ny / l, (s * nr * lean) / l], s: tip ? 1.12 : 0.62 };
  };
  for (let i = 0; i < 2 * n; i++) {
    const a = hem(i);
    const b = hem(i + 1 === 2 * n ? 0 : i + 1);
    // Wound to face outward and up (seen from outside, counter-clockwise).
    pos.push(0, y + h, 0, ...b.p, ...a.p);
    nrm.push(0, 1, 0, ...b.n, ...a.n);
    shade.push(0.9, b.s, a.s);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

export function pineGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  // The trunk open at both ends: its foot is in the ground and its top inside the spire.
  const trunk = cyl(0.06, 0.24, 11.2, 6, 0, 0, 0, true);
  const trunkCount = trunk.index ? trunk.index.count : trunk.getAttribute('position').count;
  b.add('trunk', trunk, 0x6e4c34);
  const shade: number[] = [];
  PINE_TIERS.forEach((t, k) => b.add('needles', skirt(t.y, t.r, t.h, BOUGHS, k * 0.7, shade), 0x2d6a46, 0.8 + 0.05 * k));
  const g = b.build('pine');
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  shade.forEach((s, i) => col.setXYZ(trunkCount + i, col.getX(trunkCount + i) * s, col.getY(trunkCount + i) * s, col.getZ(trunkCount + i) * s));
  return g;
}
