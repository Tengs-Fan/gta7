// Room for a vehicle: whether one of a kind fits at a spot, clear not only of the static world
// (StaticWorld.isFree knows nothing else) but of the cars and the people already there, and the
// nearest spot where it does. A vehicle spawned into another one is shoved out by the physics in
// plain view on its first step. Mission vehicles, SPAWNSPORTS and the parked cars streamed into
// their bays (traffic.ts) all ask here.

import { circleVsObb, makeContact, obbRadius, obbVsObb, type OBB } from '../core/collision';
import type { Vehicle } from './entities';
import type { Sim } from './sim';
import { VEHICLE_SPECS, type VehicleKind } from './specs';
import { vehicleObb } from './vehiclePhysics';

/** Clearance kept around a new vehicle's body (m): it starts off touching nothing. */
export const ROOM_GAP = 0.3;

const box: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
const other: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
const contact = makeContact();

/** The body of a `kind` at (x, z) facing `heading`, grown by ROOM_GAP on every side. */
function footprint(kind: VehicleKind, x: number, z: number, heading: number): OBB {
  const s = VEHICLE_SPECS[kind];
  box.x = x;
  box.z = z;
  box.hw = s.width / 2 + ROOM_GAP;
  box.hl = s.length / 2 + ROOM_GAP;
  box.h = heading;
  return box;
}

/** Collects into `out` (or stops at the first one without it) the vehicles in the way; true if there are any. */
function scanVehicles(sim: Sim, kind: VehicleKind, x: number, z: number, heading: number, out?: Vehicle[]): boolean {
  const b = footprint(kind, x, z, heading);
  const reach = obbRadius(b);
  const y = sim.world.groundHeight(x, z);
  const height = VEHICLE_SPECS[kind].height;
  let found = false;
  for (const v of sim.vehicles) {
    if (v.removed) continue;
    if (Math.hypot(v.pos.x - x, v.pos.z - z) > reach + Math.hypot(v.halfW, v.halfL)) continue;
    // One overhead (on a deck, in the air) or below is not in the way: vehicles at different heights do not
    // collide (the same rule as collideVehicles).
    if (v.pos.y > y + height - 0.2 || y > v.pos.y + v.spec.height - 0.2) continue;
    if (!obbVsObb(b, vehicleObb(v, other), contact)) continue;
    found = true;
    if (!out) return true;
    out.push(v);
  }
  return found;
}

/** The vehicles in the way of a `kind` placed at (x, z) facing `heading`. */
export function vehiclesInTheWay(sim: Sim, kind: VehicleKind, x: number, z: number, heading: number): Vehicle[] {
  const out: Vehicle[] = [];
  scanVehicles(sim, kind, x, z, heading, out);
  return out;
}

/** Whether a `kind` placed at (x, z) facing `heading` keeps ROOM_GAP clear of every vehicle's body at its height. */
export function clearOfVehicles(sim: Sim, kind: VehicleKind, x: number, z: number, heading: number): boolean {
  return !scanVehicles(sim, kind, x, z, heading);
}

/** Someone on foot (the player too) or a body lies where a `kind` at (x, z) facing `heading` would stand. */
function peopleInTheWay(sim: Sim, kind: VehicleKind, x: number, z: number, heading: number): boolean {
  const b = footprint(kind, x, z, heading);
  for (const c of sim.characters) {
    if (c.removed || c.state === 'inVehicle') continue;
    if (circleVsObb(c.pos.x, c.pos.z, c.radius, b, contact)) return true;
  }
  return false;
}

/** A `kind` at (x, z) facing `heading` fits there: clear of walls, props and deep water, of cars and of people. */
export function vehicleFits(sim: Sim, kind: VehicleKind, x: number, z: number, heading: number): boolean {
  const s = VEHICLE_SPECS[kind];
  return sim.world.isFree(x, z, Math.hypot(s.width / 2, s.length / 2)) && clearOfVehicles(sim, kind, x, z, heading) && !peopleInTheWay(sim, kind, x, z, heading);
}

/**
 * The spot nearest (x, z) where a `kind` facing `heading` fits, searched outward in rings of 1.5 m
 * up to `maxRadius` like StaticWorld.findFreeSpot; null if there is none.
 */
export function findVehicleRoom(sim: Sim, kind: VehicleKind, x: number, z: number, heading: number, maxRadius = 20): { x: number; z: number } | null {
  if (vehicleFits(sim, kind, x, z, heading)) return { x, z };
  for (let ring = 1; ring * 1.5 <= maxRadius; ring++) {
    const rad = ring * 1.5;
    const steps = Math.max(8, Math.round(rad * 4));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const px = x + Math.cos(a) * rad;
      const pz = z + Math.sin(a) * rad;
      if (vehicleFits(sim, kind, px, pz, heading)) return { x: px, z: pz };
    }
  }
  return null;
}
