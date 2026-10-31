// Shared by the farms' tests (country_fields, country_farms): how far a place is from Las Lomas County's roads.

import { COUNTRY_ROADS } from '../../src/world/country';
import type { Rect } from '../../src/world/layout';
import { world } from './helpers';

/** How far (m) (x, z) is from the nearest county road's edge (its junctions' boxes included). */
export function roadClearance(x: number, z: number): number {
  let d = Infinity;
  for (const r of COUNTRY_ROADS) {
    for (let k = 0; k + 3 < r.pts.length; k += 2) {
      const [ax, az, bx, bz] = [r.pts[k]!, r.pts[k + 1]!, r.pts[k + 2]!, r.pts[k + 3]!];
      const l2 = (bx - ax) ** 2 + (bz - az) ** 2;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / l2));
      d = Math.min(d, Math.hypot(x - ax - t * (bx - ax), z - az - t * (bz - az)) - r.width / 2);
    }
  }
  for (const v of world().layout.country.graph.vertices) if (v.half > 0) d = Math.min(d, Math.max(Math.abs(x - v.x), Math.abs(z - v.z)) - v.half);
  return d;
}

/** The least road clearance round a rectangle's edge (sampled every half metre). */
export function rectClearance(r: Rect): number {
  let d = Infinity;
  for (let t = 0; t <= 1; t += 0.5 / Math.max(r.maxX - r.minX, r.maxZ - r.minZ, 1)) {
    for (const [x, z] of [[r.minX + (r.maxX - r.minX) * t, r.minZ], [r.minX + (r.maxX - r.minX) * t, r.maxZ], [r.minX, r.minZ + (r.maxZ - r.minZ) * t], [r.maxX, r.minZ + (r.maxZ - r.minZ) * t]] as const) d = Math.min(d, roadClearance(x, z));
  }
  return d;
}
