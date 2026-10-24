// Types and helpers shared by the city builders.

import type * as THREE from 'three';
import type { FacadeStyle, Side } from '../../world/layout';
import type { GeoBuilder } from '../geo';

export interface CityMaterials {
  facades: Map<FacadeStyle, THREE.MeshStandardMaterial>;
  signs: THREE.MeshStandardMaterial[];
  /** Ground floors (shops, lobbies, doors, loading bays) from the storefront atlas. */
  storefront: THREE.MeshStandardMaterial | null;
  /** Awnings, lobby canopies, porches and steps (vertex coloured). */
  decor: THREE.MeshStandardMaterial | null;
}

export interface NightUniforms {
  occupancy: { value: number };
  shopOccupancy: { value: number };
  time: { value: number };
}

/** The drawn main door of a building: the wall it is in and its centre at the foot of that wall. */
export interface Entrance {
  side: Side;
  x: number;
  z: number;
}

/** Thin horizontal strip between two points (for markings). */
export function quadLine(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, width: number, y: number): void {
  const dx = bx - ax;
  const dz = bz - az;
  const l = Math.hypot(dx, dz) || 1;
  // Right-hand normal so the quad faces up with CCW winding.
  const nx = (-dz / l) * (width / 2);
  const nz = (dx / l) * (width / 2);
  const ux = dx / l;
  const uz = dz / l;
  // Order: left-start, right-start... choose winding facing +Y.
  const p0 = [ax - nx, az - nz];
  const p1 = [ax + nx, az + nz];
  const p2 = [bx + nx, bz + nz];
  const p3 = [bx - nx, bz - nz];
  // Check orientation: cross((p1-p0),(p2-p0)).y must be > 0.
  const cy = (p1[1]! - p0[1]!) * (p2[0]! - p0[0]!) - (p1[0]! - p0[0]!) * (p2[1]! - p0[1]!);
  void ux;
  void uz;
  if (cy > 0) g.quad(p0[0]!, y, p0[1]!, p1[0]!, y, p1[1]!, p2[0]!, y, p2[1]!, p3[0]!, y, p3[1]!, [0, 0, 1, 0, 1, 1, 0, 1]);
  else g.quad(p3[0]!, y, p3[1]!, p2[0]!, y, p2[1]!, p1[0]!, y, p1[1]!, p0[0]!, y, p0[1]!, [0, 0, 1, 0, 1, 1, 0, 1]);
}
