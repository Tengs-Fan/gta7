// Boats (class 'boat'): they float at WATER_Y, push with a propeller and steer with a rudder that needs way on, and
// run aground where the water gets shallower than their draft (beaches, quays, the piers, which are decks over the
// water). The sim's sea is flat: the waves drawn on it are presentation only (render/boatView.ts bobs the hull on
// them), so a boat's simulated height never depends on the sea state.

import { clamp, moveTowards, wrapAngle } from '../core/math';
import { WATER_Y } from '../world/constants';
import type { StaticWorld } from '../world/staticWorld';
import type { Vehicle } from './entities';
import { updateDerived, type VehiclePhysicsHost } from './vehiclePhysics';

/** Water drag on a moving hull: a constant part and one growing with the square of speed (m/s^2). */
const DRAG = 0.1;
const DRAG_SQ = 0.0004;
/** Extra drag with nobody aboard: a drifting boat comes to rest within a few metres. */
const ADRIFT_DRAG = 2.5;
/** Below this forward speed (m/s) the rudder loses its grip on the water; the outboard still swings the stern a little. */
const STEERAGE = 5;
const PIVOT = 0.3;
/** Extra drag (m/s^2) as the hull's shallowest point nears its draft: a boat slows before it grounds. */
const SHALLOW_DRAG = 8;
/** A boat whose centre stands in less than this share of its draft is on land: it does not move under its own power. */
const BEACHED = 0.5;

/** Points of the hull checked for depth, in half lengths along and half widths across: bow, stern, corners, sides. */
const ALONG = [1, 0.7, 0.7, -1, -1, 0, 0, 0];
const ACROSS = [0, 1, -1, 1, -1, 1, -1, 0];

/** The shallowest water under the hull of `v` placed at (x, z) facing h (m; negative over land or a deck). */
export function hullDepth(v: Vehicle, world: StaticWorld, x: number, z: number, h: number): number {
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  let min = Infinity;
  for (let i = 0; i < ALONG.length; i++) {
    const a = ALONG[i]! * v.halfL;
    const b = ACROSS[i]! * v.halfW;
    min = Math.min(min, world.waterDepth(x + fx * a - fz * b, z + fz * a + fx * b));
  }
  return min;
}

/** Whether a boat may float at (x, z): deep enough under its centre that it is not on land. */
export function afloatAt(v: Vehicle, world: StaticWorld, x: number, z: number): boolean {
  return world.waterDepth(x, z) >= (v.spec.boat?.draft ?? 0) * BEACHED;
}

export function stepBoat(v: Vehicle, dt: number, host: VehiclePhysicsHost, throttle: number, brake: number): void {
  const s = v.spec;
  const draft = s.boat?.draft ?? 0.4;
  const world = host.world;
  v.airborne = false;
  v.skid = 0;
  v.braking = false;
  v.reversing = false;
  if (v.destroyed) {
    // A wreck goes down like a car: the sinking path in stepVehicle takes it from the next step.
    v.inWater = true;
    v.sinkTimer = 0;
    updateDerived(v, dt, 0);
    return;
  }
  const oldX = v.pos.x;
  const oldZ = v.pos.z;
  const oldH = v.heading;
  if (!afloatAt(v, world, oldX, oldZ)) {
    // On land (placed there, or a beach): it sits where it is.
    v.vel.x = 0;
    v.vel.z = 0;
    v.angVel = 0;
    v.pos.y = Math.max(WATER_Y, world.groundHeight(oldX, oldZ));
    v.pitch = 0;
    v.roll = 0;
    updateDerived(v, dt, 0);
    return;
  }

  let fx = Math.sin(v.heading);
  let fz = Math.cos(v.heading);
  let vF = v.vel.x * fx + v.vel.z * fz;

  // Rudder: it bites in proportion to the way on (and backwards when going astern); at a standstill the outboard's
  // thrust still swings the boat a little.
  const way = clamp(Math.abs(vF) / STEERAGE, 0, 1);
  const turnRate = s.boat?.turnRate ?? 0.8;
  const yawTarget = -v.steer * turnRate * (way * Math.sign(vF || 1) + (1 - way) * PIVOT * Math.max(throttle, brake));
  v.angVel += (yawTarget - v.angVel) * Math.min(1, 2.5 * dt);
  v.heading = wrapAngle(v.heading + v.angVel * dt);
  if (hullBlocked(v, world, oldX, oldZ, oldH, oldX, oldZ, v.heading, draft)) {
    v.heading = oldH;
    v.angVel = 0;
  }

  fx = Math.sin(v.heading);
  fz = Math.cos(v.heading);
  const rx = -fz;
  const rz = fx;
  vF = v.vel.x * fx + v.vel.z * fz;
  let vR = v.vel.x * rx + v.vel.z * rz;

  let accel = 0;
  if (throttle > 0.01) accel += vF >= -0.5 ? throttle * s.accel * Math.max(0, 1 - (vF / s.maxSpeed) ** 2) : throttle * s.accel;
  if (brake > 0.01) {
    if (vF > 0.5) {
      accel -= brake * s.accel * 0.8;
      v.braking = true;
    } else {
      accel -= brake * s.accel * 0.5 * Math.max(0, 1 - (-vF / s.reverseSpeed) ** 2);
      v.reversing = vF < 0.3;
    }
  }
  if (v.burning) accel *= 0.7;
  vF += accel * dt;
  // Shallowing water drags at a hull heading into it (not at one backing out of it).
  const here = hullDepth(v, world, v.pos.x, v.pos.z, v.heading);
  const dir = vF >= 0 ? 0.5 : -0.5;
  const ahead = hullDepth(v, world, v.pos.x + fx * dir, v.pos.z + fz * dir, v.heading);
  const shallow = ahead < here ? clamp(1 - (here - draft) / draft, 0, 1) : 0;
  let drag = DRAG + DRAG_SQ * vF * vF + shallow * SHALLOW_DRAG;
  if (throttle < 0.01 && brake < 0.01) drag += s.brake;
  if (!v.driver) drag += ADRIFT_DRAG;
  vF = moveTowards(vF, 0, drag * dt);
  vR = moveTowards(vR, 0, (s.grip + (v.driver ? 0 : ADRIFT_DRAG)) * dt);
  v.vel.x = fx * vF + rx * vR;
  v.vel.z = fz * vF + rz * vR;

  let nx = v.pos.x + v.vel.x * dt;
  let nz = v.pos.z + v.vel.z * dt;
  if (hullBlocked(v, world, oldX, oldZ, v.heading, nx, nz, v.heading, draft)) {
    // Aground, or against a quay or a pier: it stops there, and can back off into deeper water.
    const sp = Math.hypot(v.vel.x, v.vel.z);
    if (sp > 4) host.onVehicleImpact(v, null, sp * 0.5, oldX + (v.vel.x / sp) * v.halfL, oldZ + (v.vel.z / sp) * v.halfL);
    nx = oldX;
    nz = oldZ;
    v.vel.x *= -0.1;
    v.vel.z *= -0.1;
  }
  const b = world.bounds;
  v.pos.x = clamp(nx, b.worldMinX + 5, b.worldMaxX - 5);
  v.pos.z = clamp(nz, b.worldMinZ + 5, b.worldMaxZ - 5);
  v.pos.y = WATER_Y;
  v.vy = 0;
  v.pitch = 0;
  v.roll = 0;
  updateDerived(v, dt, throttle);
}

/**
 * Moving the hull from (x0, z0, h0) to (x1, z1, h1) takes it into water shallower than its draft (or onto land or under a
 * deck): its shallowest point there is under the draft and shallower than before. Into deeper water it always goes.
 */
function hullBlocked(v: Vehicle, world: StaticWorld, x0: number, z0: number, h0: number, x1: number, z1: number, h1: number, draft: number): boolean {
  const d1 = hullDepth(v, world, x1, z1, h1);
  if (d1 >= draft) return false;
  return d1 < hullDepth(v, world, x0, z0, h0) - 1e-6;
}
