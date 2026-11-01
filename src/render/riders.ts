// Where riders sit on vehicles that are not cars (bikes, boats): their views publish a frame and a seat layout per
// vehicle, and CrowdView poses the riders in it (see CrowdView.riding). Cars use cabinLayout/drawnFrame instead.

import type * as THREE from 'three';
import type { Vehicle } from '../sim/entities';

type P3 = { readonly x: number; readonly y: number; readonly z: number };

/** One seat, in the frame of its mount (+x left, +y up, +z forward). */
export interface RiderSeatLayout {
  /** The centre between the hip joints. */
  readonly hip: P3;
  /** Torso tilt (rad): positive leans back, negative forward (a sport bike's crouch). */
  readonly recline: number;
  /** Where the hands hold on (left, then right): handlebar grips, a wheel, a tiller, a rail. */
  readonly hands: readonly [P3, P3];
  /** Where the soles rest (left, then right): foot pegs, a floorboard, the deck. */
  readonly feet: readonly [P3, P3];
}

export interface RiderMount {
  /** The object whose world matrix carries the seats (the leaning, pitching body as drawn). */
  readonly frame: THREE.Object3D;
  /** Seat layouts by seat index (0: the driver); a seat past the end sits in the last one. */
  readonly seats: readonly RiderSeatLayout[];
  /** How much of the vehicle is drawn (its fade, 0..1): its riders are drawn as much. Whole if absent. */
  readonly level?: number;
  /**
   * Takes a world point on the vehicle as the sim poses it to where the view draws it (a boat heaving, pitching and
   * rolling on the drawn swell while the sim floats it flat). Absent: drawn where the sim has it.
   */
  readonly simToDrawn?: THREE.Matrix4;
}

const mounts = new WeakMap<Vehicle, { owner: { vehicle: Vehicle | null }; mount: RiderMount }>();

/** Called by a view each sync: `owner` draws `v` with `mount`. */
export function setRiderMount(v: Vehicle, owner: { vehicle: Vehicle | null }, mount: RiderMount): void {
  const m = mounts.get(v);
  if (m && m.owner === owner && m.mount === mount) return;
  mounts.set(v, { owner, mount });
}

/** The mount `v` was last drawn with, or null if no view draws it now. */
export function riderMount(v: Vehicle): RiderMount | null {
  const m = mounts.get(v);
  return m && m.owner.vehicle === v ? m.mount : null;
}

/**
 * Moves `p`, a point the sim places on `v` (a window's muzzle, its smoke), to where `v` is drawn (RiderMount.simToDrawn),
 * in place.
 */
export function onDrawn<T extends { x: number; y: number; z: number }>(v: Vehicle, p: T): T {
  const m = riderMount(v)?.simToDrawn;
  if (!m) return p;
  const e = m.elements;
  const { x, y, z } = p;
  p.x = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
  p.y = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
  p.z = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
  return p;
}
