// Pinewood's pines (world/country/lakeland.ts) as one model for PropsView to instance: a slender conical conifer, a bare
// lower trunk under seven overlapping skirts of needles that narrow to a spire, each skirt's hem notched like a spray of
// boughs. The silhouette is nothing like the city's round broadleaf crowns, and it is cheap (about a hundred triangles): one
// non-indexed geometry with a vertex colour per part, its origin at its foot, 11.7 m tall at scale 1.

import * as THREE from 'three';
import { cyl, ModelBuilder } from '../furniture';

/** The pine's skirts of needles: from the lowest, its hem's height over the foot, its radius there and its height. */
export const PINE_TIERS = Array.from({ length: 7 }, (_, k) => ({ y: 1.7 + k * 1.35, r: 2.05 - k * 0.27, h: 2.5 - k * 0.12 }));
/** The pine's whole height (m, at scale 1) and the widest its needles reach (the lowest skirt's hem). */
export const PINE_H = PINE_TIERS[6]!.y + PINE_TIERS[6]!.h;
export const PINE_R = PINE_TIERS[0]!.r;

/** A skirt: a cone from its apex down to a hem of `n` notches, the points at `r`, the inner corners at 0.74 r and a little lower. */
function skirt(y: number, r: number, h: number, n: number, phase: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const hem = (i: number): [number, number, number] => {
    const a = phase + (i / (2 * n)) * Math.PI * 2;
    const out = i % 2 === 0 ? r : r * 0.74;
    return [Math.cos(a) * out, i % 2 === 0 ? y : y + 0.1, Math.sin(a) * out];
  };
  for (let i = 0; i < 2 * n; i++) {
    const a = hem(i);
    const b = hem(i + 1 === 2 * n ? 0 : i + 1);
    // Wound to face outward and up (seen from outside, counter-clockwise).
    pos.push(0, y + h, 0, b[0], b[1], b[2], a[0], a[1], a[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function pineGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('trunk', cyl(0.06, 0.3, 11.2, 6), 0x5e4531);
  PINE_TIERS.forEach((t, k) => b.add('needles', skirt(t.y, t.r, t.h, 6, k * 0.7), 0x2d6a46, 0.8 + 0.05 * k));
  return b.build('pine');
}
