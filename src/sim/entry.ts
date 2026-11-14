// Which vehicle F takes from where a character stands, and what the prompt says F will do there. The sim's player
// controller, the sim's Interactions and a multiplayer client's prompt all ask it, so the wording and the picking rules
// are one copy. In single player the prompt and the key are over the same vehicles and agree exactly. On a client the
// key is predicted over its own copies of the vehicles around the player and the prompt names what that prediction
// picks, so they agree as far as the prediction does; the server judges the press last, on its own state, and a car
// at the edge of reach or of the 7 m/s limit can still be refused there.

import { circleVsObb, makeContact, segmentHitsAabb } from '../core/collision';
import type { StaticWorld } from '../world/staticWorld';
import { MAX_STEP } from './characterPhysics';
import type { Character, Vehicle } from './entities';
import { vehicleObb } from './vehiclePhysics';
import type { PlayerView } from './viewState';

const contact = makeContact();
const obb = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };

/** Boats: how far from the hull he can board one or step off it (m), and how high a deck he can climb to. */
export const BOARD_REACH = 3.2;
export const BOARD_RISE = 3;

export interface EntryPoint { x: number; z: number }
export interface EntryRoute { side: 1 | -1; points: EntryPoint[]; length: number }

/** The ground a walk to a door crosses. */
export type EntryWorld = Pick<StaticWorld, 'groundHeight' | 'isFree' | 'waterDepth'>;

/** What a search for an enterable vehicle looks at: the vehicles about and the world they stand in. */
export interface EntryHost {
  readonly vehicles: readonly Vehicle[];
  readonly world: EntryWorld;
}

/** A point in a vehicle's local frame (x to its left, z ahead) as a point on the ground. */
export function entryWorld(v: Vehicle, point: EntryPoint): EntryPoint {
  const s = Math.sin(v.heading);
  const c = Math.cos(v.heading);
  return { x: v.pos.x + c * point.x + s * point.z, z: v.pos.z - s * point.x + c * point.z };
}

/** A short swept walk, including body width: a sight ray alone misses thin posts and wall corners. */
function entrySegmentClear(world: EntryWorld, p: Character, v: Vehicle, a: EntryPoint, b: EntryPoint): boolean {
  const s = Math.sin(v.heading);
  const c = Math.cos(v.heading);
  const ax = a.x - v.pos.x;
  const az = a.z - v.pos.z;
  const bx = b.x - v.pos.x;
  const bz = b.z - v.pos.z;
  // The tiny tolerance lets a character already touching the body's physics
  // margin move away; it never permits a path through the vehicle itself.
  const bodyMargin = p.radius - 0.05;
  if (segmentHitsAabb(ax * c - az * s, ax * s + az * c, bx * c - bz * s, bx * s + bz * c,
    { minX: -v.halfW - bodyMargin, maxX: v.halfW + bodyMargin, minZ: -v.halfL - bodyMargin, maxZ: v.halfL + bodyMargin })) return false;
  const distance = Math.hypot(b.x - a.x, b.z - a.z);
  const samples = Math.max(1, Math.ceil(distance / 0.2));
  let ground = world.groundHeight(a.x, a.z);
  for (let i = 1; i <= samples; i++) {
    const x = a.x + (b.x - a.x) * i / samples;
    const z = a.z + (b.z - a.z) * i / samples;
    const nextGround = world.groundHeight(x, z);
    if (!world.isFree(x, z, p.radius, true) || world.waterDepth(x, z) > 1 || Math.abs(nextGround - ground) > MAX_STEP) return false;
    ground = nextGround;
  }
  return true;
}

/** Whether the walk from `p` through `points` (in `v`'s frame) is clear of the vehicle's body and of obstacles. */
export function entryRouteClear(world: EntryWorld, p: Character, v: Vehicle, points: readonly EntryPoint[]): boolean {
  let previous: EntryPoint = p.pos;
  for (const point of points) {
    const next = entryWorld(v, point);
    if (!entrySegmentClear(world, p, v, previous, next)) return false;
    previous = next;
  }
  return true;
}

/** Both doors, directly or around either end. No general city pathfinding for a nearby car. */
export function entryRoute(world: EntryWorld, p: Character, v: Vehicle): EntryRoute | null {
  let best: EntryRoute | null = null;
  for (const side of [1, -1] as const) {
    const door = { x: (v.halfW + 0.55) * side, z: 0.35 };
    const paths = [[door]];
    for (const end of [1, -1]) {
      const corner = { x: (v.halfW + 0.7) * side, z: (v.halfL + 0.7) * end };
      paths.push([corner, door], [{ x: -corner.x, z: corner.z }, corner, door]);
    }
    for (const points of paths) {
      let previous: EntryPoint = p.pos;
      let length = 0;
      for (const point of points) {
        const next = entryWorld(v, point);
        length += Math.hypot(next.x - previous.x, next.z - previous.z);
        previous = next;
      }
      if (length > 24 || (best && length >= best.length) || !entryRouteClear(world, p, v, points)) continue;
      best = { side, points, length };
    }
  }
  return best;
}

/**
 * Nearest vehicle whose body is in reach and has a walkable approach to a door; or a boat whose hull is within
 * BOARD_REACH of him (from the quay, a pier or the water: he steps or climbs straight in). Only boats when `swimming`.
 */
export function findEnterable(host: EntryHost, p: Character, swimming = false): Vehicle | null {
  let best: Vehicle | null = null;
  let bd = Infinity;
  for (const v of host.vehicles) {
    if (v.spec.class === 'boat') {
      if (v.removed || !v.drivable || v.speed > 3 || (v.driver && v.driver.isPlayer)) continue;
      const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
      if (d > 12 || Math.abs(v.pos.y - p.pos.y) > BOARD_RISE) continue;
      vehicleObb(v, obb);
      if (!circleVsObb(p.pos.x, p.pos.z, BOARD_REACH, obb, contact)) continue;
      if (d < bd) {
        bd = d;
        best = v;
      }
      continue;
    }
    if (swimming) continue;
    if (v.removed || !v.drivable || v.airborne || v.speed > 7) continue;
    const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
    if (d > 12 || Math.abs(v.pos.y - p.pos.y) > 2.5) continue;
    vehicleObb(v, obb);
    if (!circleVsObb(p.pos.x, p.pos.z, 2.0, obb, contact)) continue;
    if (v.driver && v.driver.isPlayer) continue;
    if (d < bd && entryRoute(host.world, p, v)) {
      bd = d;
      best = v;
    }
  }
  return best;
}

/** Whether F can take a vehicle for `slot` now: he is on foot or swimming, up, and not locked out of control (a ride on AzuraLink, a countdown). */
export function canTakeVehicle(slot: PlayerView): boolean {
  return slot.character.onFoot && !slot.down && slot.controlLock <= 0;
}

/**
 * What F does on foot beside `v`, which findEnterable picked: one with someone at the wheel is a carjacking, an empty
 * police vehicle a theft.
 */
export function enterPromptFor(v: Vehicle): string {
  const name = v.spec.name;
  if (v.driver) return `Press F to carjack the ${name}`;
  if (v.spec.class === 'boat') return `Press F to board the ${name}`;
  if (v.spec.class === 'bike') return `Press F to get on the ${name}`;
  // The controller's own test for the theft: a cruiser the police still own (one left at a roadblock), not one he has taken and left.
  if (v.owner === 'police') return `Press F to steal the ${name}`;
  return `Press F to get in the ${name}`;
}
