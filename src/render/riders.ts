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
