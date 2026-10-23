// Single-track extras for motorbikes (class 'bike') on top of the arcade car model in vehiclePhysics.ts: the lean
// into a turn, the sport bike's wheelie, and what a crash or a bad landing does to a bike (it ends on its side; the
// rider is thrown off by sim/bikes.ts).

import { clamp, damp } from '../core/math';
import type { Vehicle } from './entities';

/** A bike lands upright when its pitch and roll are both within this (rad); past it, it lands on its side. */
export const BIKE_UPRIGHT = 0.8;
/** How quickly the lean follows the lateral acceleration (1/s), and how quickly a wheelie rises and comes down. */
const LEAN_RATE = 10;
const WHEELIE_UP = 5;
const WHEELIE_DOWN = 7;
/** Throttle from which the sport bike's front starts to lift (full lift at full throttle). */
const WHEELIE_THROTTLE = 0.6;
/** A parked bike leans on its side stand (rad, to the left), a fallen one lies on its side. */
export const STAND_LEAN = -0.17;
export const FALLEN_LEAN = 1.4;

/**
 * The lean a bike holds for the lateral acceleration `lat` (m/s^2, the turn's centripetal acceleration, positive to the
 * left): in proportion to it up to the tyres' grip limit (1.12 grip, see stepVehicle's yaw limit), where it reaches the
 * spec's cap. Positive to the right, so a left turn leans left.
 */
export function leanFor(v: Vehicle, lat: number): number {
  const cap = v.spec.bike?.leanCap ?? 0;
  const limit = 1.12 * v.spec.grip;
  if (!(limit > 0) || !Number.isFinite(lat)) return 0;
  return -cap * clamp(lat / limit, -1, 1);
}

/**
 * Per physics step, after the car model has moved the bike: its lean follows the turn (upright in the air, at a stop
 * and without a rider; on its stand when parked; on its side when toppled) and the wheelie follows the throttle.
 */
export function stepBike(v: Vehicle, dt: number, throttle: number): void {
  const b = v.spec.bike;
  if (!b) return;
  const ridden = v.driver !== null && !v.destroyed;
  let target = 0;
  if (v.toppled) target = Math.sign(v.lean || 1) * FALLEN_LEAN;
  else if (!ridden) target = v.speed < 0.5 ? STAND_LEAN : 0;
  else if (!v.airborne) target = leanFor(v, v.forwardSpeed * v.angVel);
  v.lean = damp(v.lean, target, v.toppled ? 6 : LEAN_RATE, dt);
  if (!Number.isFinite(v.lean)) v.lean = 0;

  const w = b.wheelie;
  let lift = 0;
  if (w && ridden && !v.toppled && !v.airborne && throttle > WHEELIE_THROTTLE && v.forwardSpeed > -0.5 && v.forwardSpeed < w.speed) {
    lift = w.pitch * clamp((throttle - WHEELIE_THROTTLE) / (1 - WHEELIE_THROTTLE), 0, 1);
  }
  v.wheelie = damp(v.wheelie, lift, lift > v.wheelie ? WHEELIE_UP : WHEELIE_DOWN, dt);
  if (!Number.isFinite(v.wheelie) || v.wheelie < 1e-5) v.wheelie = 0;
}

/**
 * A bike touching down: one landing far off upright (on its side, its nose or its back) does not stay on its roof the
 * way a car does but falls on its side, back on its wheels' footprint; true then (sim/bikes.ts throws the rider off).
 */
export function bikeTouchdown(v: Vehicle): boolean {
  const upright = Math.abs(v.roll) < BIKE_UPRIGHT && Math.abs(v.pitch) < BIKE_UPRIGHT && !v.flipped;
  if (upright) return false;
  v.lean = Math.sign(v.roll || v.lean || 1) * FALLEN_LEAN;
  v.flipped = false;
  v.roll = 0;
  v.pitch = 0;
  v.wheelie = 0;
  v.toppled = true;
  return true;
}
