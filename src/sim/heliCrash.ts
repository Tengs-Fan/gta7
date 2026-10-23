// Where a shot-down helicopter's fall ends against the city: on a roof (buildings, garages, the police station), or
// against the side of a building, garage, pillar (the lighthouse, crane legs) or the Ferris wheel.

import { isSolidForSight } from '../world/colliders';
import { FERRIS_HUB, type StaticWorld } from '../world/staticWorld';

/**
 * The helicopter's body round its centre (render/markers.ts buildHeli): skids 1.41 m below, rotor hub 1.5 m above, and a
 * fuselage 3 m wide (the 11 m rotor folds on contact and is left out).
 */
export const HELI_BOTTOM = 1.41;
export const HELI_TOP = 1.5;
export const HELI_RADIUS = 1.5;
/**
 * The Ferris wheel as a solid disc about its hub: the rim (22 m, render/props.ts FERRIS_R) with the gondolas, and the
 * spread of its A-frame legs across the wheel (FERRIS_LEG_Z).
 */
const FERRIS_DISC_R = 24;
const FERRIS_DISC_HALF = 3.2;

/**
 * Blast radius (m) of a helicopter that comes down on a garage roof: the blast (centred on the helicopter, 1.4 m over
 * the roof 5.9 m up) then stops more than a car's half length short of the cars on the floor under it.
 */
export const HELI_ROOF_BLAST = 3.5;

export interface HeliCrash {
  /** Height the helicopter's centre ends at. */
  y: number;
  /** It came down on top of a garage (a wall-tagged roof): the blast must stay off the cars parked under it. */
  garageRoof: boolean;
}

/**
 * Whether a falling helicopter now at (x, y, z), having come down `fell` m this step, has hit something: landed on a
 * roof or wall top it came down onto (resting with its skids on it), or run into the side of a solid structure (ending
 * where it is). Null while its way is clear.
 */
export function heliCrashHit(world: StaticWorld, x: number, y: number, z: number, fell: number): HeliCrash | null {
  const R = HELI_RADIUS;
  const bottom = y - HELI_BOTTOM;
  const before = bottom + Math.max(0, fell);
  let hit: HeliCrash | null = null;
  world.grid.query(x - R, z - R, x + R, z + R, (c) => {
    if (!isSolidForSight(c) || c.tag === 'boat') return;
    const near = c.circle ? Math.hypot(x - c.cx, z - c.cz) <= c.r + R : Math.hypot(Math.max(c.minX - x, 0, x - c.maxX), Math.max(c.minZ - z, 0, z - c.maxZ)) <= R;
    if (!near || bottom > c.y1 || y + HELI_TOP < c.y0) return;
    // Coming down onto the top this step (its skids were still above it): it rests there.
    const onTop = before >= c.y1 - 0.05;
    const at: HeliCrash = onTop ? { y: c.y1 + HELI_BOTTOM, garageRoof: c.tag === 'wall' } : { y, garageRoof: false };
    if (!hit || at.y > hit.y) hit = at;
  });
  if (hit) return hit;
  for (const p of world.layout.props) {
    if (p.kind !== 'ferris') continue;
    const dx = x - p.x;
    const dy = y - (p.y + FERRIS_HUB);
    const dz = z - p.z;
    // The wheel turns in its local x-y plane, about its local z (render/props.ts: rotation.y = rot).
    const along = dx * Math.sin(p.rot) + dz * Math.cos(p.rot);
    const across = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
    if (Math.abs(along) <= FERRIS_DISC_HALF + R && across <= FERRIS_DISC_R + R) return { y, garageRoof: false };
  }
  return null;
}

/** The disc a falling helicopter treats as the Ferris wheel (for tests): hub, axle direction, radius, half thickness. */
export function ferrisDisc(world: StaticWorld): { x: number; y: number; z: number; ax: number; az: number; r: number; half: number } | null {
  const p = world.layout.props.find((q) => q.kind === 'ferris');
  return p ? { x: p.x, y: p.y + FERRIS_HUB, z: p.z, ax: Math.sin(p.rot), az: Math.cos(p.rot), r: FERRIS_DISC_R, half: FERRIS_DISC_HALF } : null;
}
