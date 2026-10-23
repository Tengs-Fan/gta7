// Arcade vehicle dynamics and collision response (static world and vehicle vs vehicle).

import { circleVsObb, makeContact, obbBounds, obbVsAabb, obbVsObb, type AABB, type Contact, type OBB } from '../core/collision';
import { clamp, damp, dampAngle, moveTowards, wrapAngle } from '../core/math';
import type { StaticCollider } from '../world/colliders';
import { DECK_SLAB, WATER_Y } from '../world/constants';
import { rectContains } from '../world/layout';
import type { StaticWorld } from '../world/staticWorld';
import type { Vehicle } from './entities';

export const VEHICLE_GRAVITY = 17;
/** Deceleration (m/s^2) of a driven car with neither throttle nor brake pressed. */
export const ENGINE_BRAKE = 1.4;
const MAX_STEP_UP = 1.0;
/** Cars sink where the water is deeper than this. */
const SINK_DEPTH = 0.8;
/**
 * The drag of the water on a vehicle standing at the deep end of wading (see stepVehicle), per m/s^2 of its engine's pull
 * (2 m/s^2 on a sedan): a share of the engine rather than the same for all, so that half the engine backs every vehicle out
 * again, a bus as well as a sedan.
 */
const WADE_DRAG = 2 / 10.5;
/** Explosion kicks: the horizontal speed (m/s) a kick may raise a car to, and the top launch speed upwards. */
const LAUNCH_MAX_SPEED = 24;
const LAUNCH_MAX_VY = 12;
/** Horizontal speed (m/s) above which an airborne car feels air drag. */
const AIR_DRAG_SPEED = 35;

export interface VehiclePhysicsHost {
  world: StaticWorld;
  vehicles: Vehicle[];
  /**
   * `otherRammed`: `other` was closing in faster than `v`, i.e. it drove into `v` (not the other way round).
   * (nx, nz): the contact normal pushing `v` out of the contact, i.e. into its body (absent for ledge hits).
   */
  onVehicleImpact(v: Vehicle, other: Vehicle | null, deltaV: number, x: number, z: number, otherRammed?: boolean, nx?: number, nz?: number): void;
  onPropBroken(c: StaticCollider, v: Vehicle): void;
  onVehicleLanded(v: Vehicle, impact: number): void;
  onVehicleEnteredWater(v: Vehicle): void;
  /** `v` slides along a wall or another vehicle (`other`) touching it at (x, z), `speed` m/s along the contact (over SCRAPE_SPEED). */
  onVehicleScrape(v: Vehicle, x: number, z: number, speed: number, other?: Vehicle): void;
}

/** Sliding speed along a contact (m/s) above which a vehicle scrapes (sparks). */
export const SCRAPE_SPEED = 4;

const contact: Contact = makeContact();
const obbA: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
const obbB: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
const bounds: AABB = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

export function vehicleObb(v: Vehicle, out: OBB): OBB {
  out.x = v.pos.x;
  out.z = v.pos.z;
  out.hw = v.halfW;
  out.hl = v.halfL;
  out.h = v.heading;
  return out;
}

/** Distance from the centre to the body's leading edge along the unit direction (ux, uz), capped at 2.2 m. */
function leadingEdge(v: Vehicle, ux: number, uz: number): number {
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  return Math.min(2.2, v.halfL * Math.abs(ux * fx + uz * fz) + v.halfW * Math.abs(ux * fz - uz * fx));
}

/**
 * True when a vehicle centred at (x, z) would have its centre or leading edge on a ledge it cannot climb.
 * Airborne cars are checked too, so a car flying low into a ramp end bounces off instead of landing on top.
 */
function ledgeTooHigh(v: Vehicle, world: StaticWorld, x: number, z: number, ux: number, uz: number, edge: number): boolean {
  return Math.max(world.groundHeight(x, z), world.groundHeight(x + ux * edge, z + uz * edge)) > v.pos.y + MAX_STEP_UP;
}

/** True when pushing a vehicle by d along the unit direction (ux, uz) would move it onto a ledge it cannot climb. */
function pushBlocked(v: Vehicle, world: StaticWorld, ux: number, uz: number, d: number): boolean {
  const x = v.pos.x + ux * d;
  const z = v.pos.z + uz * d;
  return ledgeTooHigh(v, world, x, z, ux, uz, leadingEdge(v, ux, uz)) || faceAhead(v, world, v.pos.x, v.pos.z, v.heading, x, z, v.heading, ux, uz, false);
}

/**
 * The side of a deck (the pier, the marina) stops a vehicle whose wheels are more than this far below the deck, though it is
 * lower than MAX_STEP_UP: its first metres over the sand are a 0.3-1 m slab. The 0.3 m step up from the boardwalk stays drivable.
 */
const DECK_STEP = 0.4;
/**
 * A step face is a step in the ground: the ground under a point of the body must rise more than this from the point's old
 * position to its new one. That is under the lowest real face (the deck sides rise DECK_STEP and more from the sand, the
 * backs and sides of the ramps more than MAX_STEP_UP) and over what a smooth slope gains in one physics step (a ramp with
 * the sand under it about 0.2 m at the 90 m/s speed cap). So a ramp a long body's nose climbs well ahead of the pitch that
 * follows it (a bus's, over a metre up the plate at the foot) is no face.
 * A slope beside the body is one, though: the body rises with the ground under its centre and pitches with the ground on its
 * centre line, nothing else. So a slope under a point is climbed only where the centre line as far out stands within this
 * of it (a bus's corners stand within about 0.26 m of its nose on a ramp it climbs up to 1 rad off the ramp's line); where
 * the line stays below, the slope buries that side (a car driving past a ramp with its centre just outside the ramp's side).
 */
const FACE_JUMP = 0.3;
/**
 * Points of the body checked for step faces (see faceAhead), in half lengths along it and half widths across it: the corners,
 * the middles of the ends and the sides, and the centre.
 */
const FACE_ALONG = [1, 1, 1, -1, -1, -1, 0, 0, 0];
const FACE_ACROSS = [1, 0, -1, 1, 0, -1, 1, -1, 0];

/** Bounding boxes (min x, min z, max x, max z) of every deck and ramp of a world (see nearRaisedGround). */
const raisedBoxes = new WeakMap<StaticWorld, Float64Array>();

/** Whether a deck or a ramp is within `r` of the segment from (x0, z0) to (x1, z1) (by bounding boxes). */
function nearRaisedGround(world: StaticWorld, x0: number, z0: number, x1: number, z1: number, r: number): boolean {
  let boxes = raisedBoxes.get(world);
  if (!boxes) {
    const { decks, ramps } = world.layout;
    boxes = new Float64Array((decks.length + ramps.length) * 4);
    let i = 0;
    for (const d of decks) {
      boxes[i++] = d.rect.minX;
      boxes[i++] = d.rect.minZ;
      boxes[i++] = d.rect.maxX;
      boxes[i++] = d.rect.maxZ;
    }
    for (const p of ramps) {
      const h = Math.hypot(p.length, p.width) / 2;
      boxes[i++] = p.x - h;
      boxes[i++] = p.z - h;
      boxes[i++] = p.x + h;
      boxes[i++] = p.z + h;
    }
    raisedBoxes.set(world, boxes);
  }
  const minX = Math.min(x0, x1) - r;
  const maxX = Math.max(x0, x1) + r;
  const minZ = Math.min(z0, z1) - r;
  const maxZ = Math.max(z0, z1) + r;
  for (let i = 0; i < boxes.length; i += 4) {
    if (boxes[i]! <= maxX && boxes[i + 2]! >= minX && boxes[i + 1]! <= maxZ && boxes[i + 3]! >= minZ) return true;
  }
  return false;
}

/** Whether (x, z), with the ground at height y, is on a deck. */
function onDeck(world: StaticWorld, x: number, z: number, y: number): boolean {
  for (const d of world.layout.decks) if (d.y >= y - 1e-6 && rectContains(d.rect, x, z)) return true;
  return false;
}

/**
 * Whether the ground at (x, z), at height y, is a step face for a point of a body at height `from`: it stands more than
 * MAX_STEP_UP above the point, or is a deck more than DECK_STEP above it.
 */
function inFace(world: StaticWorld, x: number, z: number, y: number, from: number): boolean {
  return y > from + MAX_STEP_UP || (y > from + DECK_STEP && onDeck(world, x, z, y));
}

/**
 * True when moving a vehicle from (x0, z0), facing h0, to (x1, z1), facing h1, runs a point of its body into a step face (see
 * inFace), taken at the point's own height: the vehicle's, raised or lowered along its length by the pitch. Moving along the
 * unit direction (ux, uz), only the part of the body that leads counts (its leading corners and the middle of its leading end
 * or side), and the centre; turning on the spot (ux = uz = 0), every point does, as a turn swings the two ends opposite ways.
 * ledgeTooHigh probes no further ahead than 2.2 m along the way the vehicle moves, which lets a long vehicle's nose into a
 * ledge (a bus's up to 3.5 m into the side of the pier), and not at all as the body swings round. Only a step in the ground
 * (FACE_JUMP) is a face, not a ramp's slope, which the nose of a long body climbs well ahead of the pitch that follows it,
 * unless the slope is beside the body: ground under the point standing more than FACE_JUMP over the ground on the centre
 * line as far out, which the body does not rise with.
 * Only a point that enters a face stops the body: one already in it (a car shoved off the side of a deck rests with its near
 * side under the deck's edge) moves on in it or out of it, so the body drives along the face or away from it, and the centre,
 * never in a face on the ground, keeps a body that straddles one from climbing onto it. Sinking (`sinking`), the face is the
 * edge of water too shallow to sink in, crossed from deeper water (see sinkBlocked).
 */
function faceAhead(v: Vehicle, world: StaticWorld, x0: number, z0: number, h0: number, x1: number, z1: number, h1: number, ux: number, uz: number, sinking: boolean): boolean {
  // On land, ground higher than a curb comes only from decks and ramps (the land's edge a car reaches only sinking): far
  // from all of them, there is nothing to probe for.
  if (!sinking && !nearRaisedGround(world, x0, z0, x1, z1, v.halfL + v.halfW)) return false;
  const turning = ux === 0 && uz === 0;
  const f0x = Math.sin(h0);
  const f0z = Math.cos(h0);
  const f1x = Math.sin(h1);
  const f1z = Math.cos(h1);
  const lift = Math.sin(v.pitch);
  for (let i = 0; i < FACE_ALONG.length; i++) {
    const a = FACE_ALONG[i]! * v.halfL;
    const b = FACE_ACROSS[i]! * v.halfW;
    const ox = f1x * a - f1z * b;
    const oz = f1z * a + f1x * b;
    if (!turning && (a !== 0 || b !== 0) && ox * ux + oz * uz < 1e-3) continue;
    const px1 = x1 + ox;
    const pz1 = z1 + oz;
    const px0 = x0 + f0x * a - f0z * b;
    const pz0 = z0 + f0z * a + f0x * b;
    if (sinking) {
      if (world.baseGround(px1, pz1) > WATER_Y - SINK_DEPTH && world.baseGround(px0, pz0) <= WATER_Y - SINK_DEPTH) return true;
      continue;
    }
    const from = v.pos.y + a * lift;
    const g1 = world.groundHeight(px1, pz1);
    if (!inFace(world, px1, pz1, g1, from)) continue;
    const g0 = world.groundHeight(px0, pz0);
    if (inFace(world, px0, pz0, g0, from)) continue;
    if (g1 - g0 > FACE_JUMP || g1 - world.groundHeight(x1 + f1x * a, z1 + f1z * a) > FACE_JUMP) return true;
  }
  return false;
}

/** How high a vehicle centred at (x, z) may sit with its roof under the slab of every deck over it (Infinity in the open). */
function deckCeiling(v: Vehicle, world: StaticWorld, x: number, z: number): number {
  vehicleObb(v, obbA);
  obbA.x = x;
  obbA.z = z;
  let y = Infinity;
  for (const d of world.layout.decks) if (obbVsAabb(obbA, d.rect, contact)) y = Math.min(y, d.y - DECK_SLAB - v.spec.height - 0.05);
  return y;
}

/** Height at which a vehicle sinking at (x, z) settles: out of sight in deep water, on the sand where it is shallower, under any deck. */
function sinkFloor(v: Vehicle, world: StaticWorld, x: number, z: number): number {
  return Math.min(Math.max(WATER_Y - 3.2, world.baseGround(x, z) - 0.3), deckCeiling(v, world, x, z));
}

/** The nearer of 0 and PI to the pitch or roll angle a: a sinking car settles on its wheels or on its roof, whichever is closer. */
function nearerFace(a: number): number {
  return Math.abs(wrapAngle(a)) > Math.PI / 2 ? Math.PI : 0;
}

/**
 * True when a sinking vehicle may not drift on to (x, z): its centre or leading edge would reach water too shallow to sink in
 * (quays, the beach), it would have to rise to settle there (the sand at the beach's ends; the slack still lets it slide up
 * the gentle beach slope), or it would slide under a deck its roof is still above.
 */
function sinkBlocked(v: Vehicle, world: StaticWorld, x: number, z: number): boolean {
  const sp = Math.hypot(v.vel.x, v.vel.z);
  if (sp < 1e-6) return false;
  const ux = v.vel.x / sp;
  const uz = v.vel.z / sp;
  const edge = leadingEdge(v, ux, uz);
  if (Math.max(world.baseGround(x, z), world.baseGround(x + ux * edge, z + uz * edge)) > WATER_Y - SINK_DEPTH) return true;
  if (faceAhead(v, world, v.pos.x, v.pos.z, v.heading, x, z, v.heading, ux, uz, true)) return true;
  const ceil = deckCeiling(v, world, x, z);
  if (v.pos.y > ceil && ceil < deckCeiling(v, world, v.pos.x, v.pos.z)) return true;
  return sinkFloor(v, world, x, z) > v.pos.y + 0.05;
}

const NO_FLATS = { grip: 1, speed: 1, drag: 0, pull: 0 };

/**
 * What flat tyres (a police spike strip, Vehicle.flat) do to a car: a share of its grip (a flat front tyre costs the
 * most, it steers on its rim), of its top speed, extra rolling drag (m/s^2), and a pull (rad/s at speed) towards the
 * side with more flats.
 */
export function flatTyreEffect(v: Vehicle): { grip: number; speed: number; drag: number; pull: number } {
  const f = v.flat;
  if (!f[0] && !f[1] && !f[2] && !f[3]) return NO_FLATS;
  const front = (f[0] ? 1 : 0) + (f[1] ? 1 : 0);
  const rear = (f[2] ? 1 : 0) + (f[3] ? 1 : 0);
  const left = (f[0] ? 1 : 0) + (f[2] ? 1 : 0);
  const right = (f[1] ? 1 : 0) + (f[3] ? 1 : 0);
  const n = front + rear;
  // Positive yaw turns left (see the bicycle model: positive steer is right and gives negative yaw).
  return { grip: 1 - 0.28 * Math.min(front, 1) - 0.06 * Math.max(front - 1, 0) - 0.05 * rear, speed: 1 - 0.035 * n, drag: 0.25 * n, pull: 0.05 * (left - right) };
}

export function stepVehicle(v: Vehicle, dt: number, host: VehiclePhysicsHost): void {
  if (v.removed) return;
  const s = v.spec;
  const world = host.world;
  const c = v.controls;
  const hasDriver = v.driver !== null;
  const canDrive = hasDriver && v.drivable;
  const throttle = canDrive ? clamp(c.throttle, 0, 1) : 0;
  const brake = canDrive ? clamp(c.brake, 0, 1) : 0;
  const handbrake = canDrive ? c.handbrake : false;

  // Steering wheel position follows input; returns to centre faster than it turns.
  const steerIn = canDrive ? clamp(c.steer, -1, 1) : 0;
  const steerRate = Math.abs(steerIn) > Math.abs(v.steer) && Math.sign(steerIn) === Math.sign(v.steer || steerIn) ? 4.2 : 7.5;
  v.steer = moveTowards(v.steer, steerIn, steerRate * dt);

  const oldX = v.pos.x;
  const oldZ = v.pos.z;

  if (v.inWater) {
    // Sinking: heavy damping, slow descent.
    const k = Math.exp(-2.5 * dt);
    v.vel.x *= k;
    v.vel.z *= k;
    v.angVel *= k;
    v.vy = -0.9;
    // A wreck pushed back towards land (a blast, a collision) stops instead of popping up out of the sea.
    const nx = v.pos.x + v.vel.x * dt;
    const nz = v.pos.z + v.vel.z * dt;
    if (sinkBlocked(v, world, nx, nz)) {
      v.vel.x = 0;
      v.vel.z = 0;
    } else {
      v.pos.x = nx;
      v.pos.z = nz;
    }
    v.pos.y = Math.max(sinkFloor(v, world, v.pos.x, v.pos.z), v.pos.y + v.vy * dt);
    // Level out: sinkFloor only keeps a level body under the deck and the surface, so the end that tipped up going
    // over an edge (or in a blast's tumble) would otherwise poke through the deck or out of the water for good.
    v.pitch = dampAngle(v.pitch, nearerFace(v.pitch), 3, dt);
    v.roll = dampAngle(v.roll, nearerFace(v.roll), 3, dt);
    v.sinkTimer += dt;
    updateDerived(v, dt, 0);
    return;
  }

  let fx = Math.sin(v.heading);
  let fz = Math.cos(v.heading);
  let vF = v.vel.x * fx + v.vel.z * fz;
  const tyres = flatTyreEffect(v);

  if (!v.airborne) {
    // --- Yaw (kinematic bicycle model limited by tyre grip) ---
    const speedAbs = Math.abs(vF);
    const wheelbase = s.length * 0.6;
    const maxSteer = s.steer / (1 + speedAbs / 15);
    const delta = -v.steer * maxSteer;
    let yawTarget = (vF * Math.tan(delta)) / wheelbase + tyres.pull * Math.min(1, speedAbs / 12);
    const gripLimit = ((handbrake ? 2.0 : 1.12) * s.grip * tyres.grip) / Math.max(speedAbs, 2.5);
    yawTarget = clamp(yawTarget, -gripLimit, gripLimit);
    if (v.destroyed || v.flipped) yawTarget = 0;
    const resp = handbrake ? 5.5 : 9;
    v.angVel += (yawTarget - v.angVel) * Math.min(1, resp * dt);
  } else {
    v.angVel *= Math.exp(-0.4 * dt);
  }
  const oldH = v.heading;
  v.heading = wrapAngle(v.heading + v.angVel * dt);
  // A body swinging round into a step face (a nose turning in along the side of the pier) stops turning there.
  if (v.heading !== oldH && faceAhead(v, world, oldX, oldZ, oldH, oldX, oldZ, v.heading, 0, 0, false)) {
    v.heading = oldH;
    v.angVel = 0;
  }

  fx = Math.sin(v.heading);
  fz = Math.cos(v.heading);
  const rx = -fz;
  const rz = fx;
  vF = v.vel.x * fx + v.vel.z * fz;
  let vR = v.vel.x * rx + v.vel.z * rz;

  v.braking = false;
  v.reversing = false;
  if (!v.airborne) {
    // Wading (its wheels on the ground under up to SINK_DEPTH of water): drag, less grip and, at the deep end, half the
    // engine, instead of full power on dry sand right up to flooding at once. Half the engine still takes a car on into
    // deeper water, and back out again.
    const wade = clamp((WATER_Y - v.pos.y) / SINK_DEPTH, 0, 1);
    const engine = 1 - 0.5 * wade;
    // --- Longitudinal ---
    let accel = 0;
    if (throttle > 0.01) {
      if (vF >= -0.5) accel += throttle * s.accel * engine * Math.max(0, 1 - (vF / (s.maxSpeed * tyres.speed)) ** 2);
      else {
        accel += throttle * s.brake;
        v.braking = true;
      }
    }
    if (brake > 0.01) {
      if (vF > 0.5) {
        accel -= brake * s.brake;
        v.braking = true;
      } else {
        accel -= brake * s.accel * engine * 0.65 * Math.max(0, 1 - (-vF / s.reverseSpeed) ** 2);
        v.reversing = vF < 0.3;
      }
    }
    if (v.burning) accel *= 0.7;
    const before = vF;
    vF += accel * dt;
    // Braking may not reverse the direction of travel within one step.
    if (brake > 0.01 && before > 0.5 && vF < 0) vF = 0;
    if (throttle > 0.01 && before < -0.5 && vF > 0) vF = 0;

    let friction = 0.35 + 0.012 * Math.abs(vF);
    if (throttle < 0.01 && brake < 0.01) friction += ENGINE_BRAKE;
    if (!hasDriver) friction += 5.5; // parked: handbrake on
    if (handbrake) friction += 7.5;
    if (v.destroyed || v.flipped) friction += 9;
    friction += tyres.drag;
    friction += wade * (WADE_DRAG * s.accel + 0.04 * vF * vF);
    vF = moveTowards(vF, 0, friction * dt);

    // --- Lateral grip ---
    const grip = (handbrake ? s.grip * 0.3 : v.destroyed || v.flipped ? s.grip * 1.5 : s.grip * tyres.grip) * (1 - 0.4 * wade);
    const skidLat = Math.abs(vR);
    vR = moveTowards(vR, 0, grip * dt);
    const skidTarget = clamp((skidLat - 2.2) / 6, 0, 1) + (handbrake && Math.abs(vF) > 5 ? 0.6 : 0) + (v.braking && Math.abs(vF) > 12 && brake > 0.8 ? 0.35 : 0);
    // Tyres sliding under water neither squeal nor smoke nor leave marks (all three follow v.skid).
    v.skid = damp(v.skid, clamp(skidTarget, 0, 1) * clamp(1 - wade * 10, 0, 1), 10, dt);
  } else {
    v.skid = damp(v.skid, 0, 10, dt);
    // Air drag above ramp-jump speeds: wrecks blown across the map slow down; a jump barely notices it.
    if (vF * vF + vR * vR > AIR_DRAG_SPEED * AIR_DRAG_SPEED) {
      const k = Math.exp(-0.12 * dt);
      vF *= k;
      vR *= k;
    }
  }

  v.vel.x = fx * vF + rx * vR;
  v.vel.z = fz * vF + rz * vR;

  // --- Integrate horizontal position with step-up blocking (ramp backs, high ledges) ---
  let nx = v.pos.x + v.vel.x * dt;
  let nz = v.pos.z + v.vel.z * dt;
  // Probe along the direction of travel, not the heading: a sliding or spinning car meets ledges side-first.
  const sp = Math.hypot(v.vel.x, v.vel.z);
  const sg = Math.sign(vF || 1);
  const ux = sp > 1e-3 ? v.vel.x / sp : fx * sg;
  const uz = sp > 1e-3 ? v.vel.z / sp : fz * sg;
  const probe = leadingEdge(v, ux, uz);
  if (ledgeTooHigh(v, world, nx, nz, ux, uz, probe) || faceAhead(v, world, oldX, oldZ, v.heading, nx, nz, v.heading, ux, uz, false)) {
    nx = oldX;
    nz = oldZ;
    // Treat as a wall hit, where the body meets it.
    const reach = v.halfL * Math.abs(ux * fx + uz * fz) + v.halfW * Math.abs(ux * fz - uz * fx);
    if (sp > 4) host.onVehicleImpact(v, null, sp * 0.6, oldX + ux * reach, oldZ + uz * reach);
    v.vel.x *= -0.15;
    v.vel.z *= -0.15;
  }
  v.pos.x = nx;
  v.pos.z = nz;

  // --- Vertical ---
  const gy = world.groundHeight(v.pos.x, v.pos.z);
  if (v.airborne) {
    v.vy -= VEHICLE_GRAVITY * dt;
    v.pos.y += v.vy * dt;
    v.pitch += v.pitchVel * dt;
    v.roll += v.rollVel * dt;
    v.airTime += dt;
    // Nose drops slightly during flight for a natural arc.
    v.pitch = damp(v.pitch, clamp(v.vy * 0.03, -0.35, 0.25), v.pitchVel !== 0 ? 0 : 1.5, dt);
    if (v.pos.y <= gy) {
      const impact = -v.vy;
      v.pos.y = gy;
      v.vy = 0;
      v.airborne = false;
      v.pitchVel = 0;
      v.rollVel = 0;
      v.flipped = landsUpsideDown(v);
      host.onVehicleLanded(v, impact);
    }
  } else {
    if (gy >= v.pos.y - 0.4 || (gy > v.pos.y - 1.2 && v.climbRate < 1.5)) {
      // Follow the ground. Large ground drops (> 0.4 m, e.g. quay edge or ramp end) start a flight.
      // The climb rate is capped above the steepest ramp slope (0.24), so popping up a curb or
      // ledge in a single step never turns into launch speed.
      const rate = Math.min((gy - v.pos.y) / dt, 0.3 * Math.hypot(v.vel.x, v.vel.z));
      if (gy < v.pos.y - 0.4) {
        v.pos.y = damp(v.pos.y, gy, 25, dt);
      } else {
        v.pos.y = gy;
      }
      v.climbRate = damp(v.climbRate, rate, 30, dt);
    } else {
      v.airborne = true;
      v.airTime = 0;
      v.launchX = v.pos.x;
      v.launchZ = v.pos.z;
      v.launchRamp = rampAt(world, v.pos.x - fx * 2, v.pos.z - fz * 2);
      v.vy = Math.max(0, Math.min(v.climbRate, 14));
      v.climbRate = 0;
    }
    // Visual pitch from the terrain slope (ramps), settle roll/pitch otherwise.
    if (!v.flipped) {
      const hf = world.groundHeight(v.pos.x + fx * v.halfL * 0.8, v.pos.z + fz * v.halfL * 0.8);
      const hb = world.groundHeight(v.pos.x - fx * v.halfL * 0.8, v.pos.z - fz * v.halfL * 0.8);
      const slope = Math.atan2(hf - hb, v.halfL * 1.6);
      v.pitch = dampAngle(v.pitch, clamp(slope, -0.6, 0.6), 12, dt);
      v.roll = dampAngle(v.roll, 0, 8, dt);
    } else {
      v.roll = dampAngle(v.roll, Math.PI, 6, dt);
      v.pitch = dampAngle(v.pitch, 0, 6, dt);
    }
  }

  // --- Water ---
  if (v.pos.y < WATER_Y + 0.15 && world.waterDepth(v.pos.x, v.pos.z) > SINK_DEPTH) {
    v.inWater = true;
    v.airborne = false;
    host.onVehicleEnteredWater(v);
  }

  // Keep inside the world.
  const b = world.bounds;
  v.pos.x = clamp(v.pos.x, b.worldMinX + 5, b.worldMaxX - 5);
  v.pos.z = clamp(v.pos.z, b.worldMinZ + 5, b.worldMaxZ - 5);

  updateDerived(v, dt, throttle);
}

/** A live car landing with its body's up axis lower than this (the cosine of 1.9 rad from upright) stays on its roof. */
const LIVE_UPSIDE = Math.cos(1.9);

/**
 * Whether a vehicle touching down rests on its roof (true) or on its wheels; the ground then settles it there (see stepVehicle).
 * The body's up axis points up by cos(roll) cos(pitch). A wreck settles on whichever face is nearer, wheels or roof, as one
 * sinking does (see nearerFace); a live car only well past its side, so that one landing on its side or nose is put back on
 * its wheels.
 * The same orientation has two sets of angles (YXZ Euler angles with x = -pitch): (heading, pitch, roll) and (heading + PI,
 * PI - pitch, roll + PI). The ground turns pitch and roll each the short way, to level and to 0 or PI: the attitude is
 * written with the set from which those two turns add up to less, so that a car comes to rest the near way round (one on
 * its tail past upright goes over onto its roof facing back, one that lands on its wheels keeps facing its way).
 */
function landsUpsideDown(v: Vehicle): boolean {
  const up = Math.cos(v.roll) * Math.cos(v.pitch);
  const upside = v.destroyed ? up < 0 : up < LIVE_UPSIDE;
  let pitch = wrapAngle(v.pitch);
  let roll = wrapAngle(v.roll);
  const p = Math.abs(pitch);
  const r = Math.abs(roll);
  // Onto the roof the turns are p + (PI - r), or (PI - p) + r with the other set; onto the wheels p + r, or 2 PI - p - r.
  if (upside ? p > r : p + r > Math.PI) {
    v.heading = wrapAngle(v.heading + Math.PI);
    pitch = wrapAngle(Math.PI - pitch);
    roll = wrapAngle(roll + Math.PI);
  }
  v.pitch = pitch;
  v.roll = roll;
  return upside;
}

/** Id of the stunt ramp under (x, z), or -1. */
function rampAt(world: StaticWorld, x: number, z: number): number {
  for (const r of world.layout.ramps) {
    const dx = x - r.x;
    const dz = z - r.z;
    const along = dx * Math.sin(r.heading) + dz * Math.cos(r.heading);
    const side = dx * Math.cos(r.heading) - dz * Math.sin(r.heading);
    if (Math.abs(along) < r.length / 2 + 3 && Math.abs(side) < r.width / 2 + 1.5) return r.id;
  }
  return -1;
}

function updateDerived(v: Vehicle, dt: number, throttle: number): void {
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  v.forwardSpeed = v.vel.x * fx + v.vel.z * fz;
  v.speed = Math.hypot(v.vel.x, v.vel.z);
  v.wheelSpin += (v.forwardSpeed / 0.34) * dt;
  if (v.wheelSpin > 1e6 || v.wheelSpin < -1e6) v.wheelSpin = 0;
  const ratio = clamp(Math.abs(v.forwardSpeed) / v.spec.maxSpeed, 0, 0.999);
  const gears = 5;
  v.gear = 1 + Math.floor(ratio * gears);
  const inGear = ratio * gears - (v.gear - 1);
  const target = v.driver ? (throttle > 0.05 ? 0.3 + 0.68 * inGear : 0.18 + 0.45 * inGear) : 0;
  v.rpm = damp(v.rpm, v.airborne && throttle > 0.05 ? 1 : target, 7, dt);
  if (v.impactTimer > 0) v.impactTimer -= dt;
  if (v.hornTimer > 0) v.hornTimer -= dt;
}

/** Resolves overlap with static colliders; returns true if any contact happened. */
export function collideVehicleStatic(v: Vehicle, host: VehiclePhysicsHost): boolean {
  if (v.removed) return false;
  const world = host.world;
  vehicleObb(v, obbA);
  obbBounds(obbA, bounds);
  let any = false;
  const bottom = v.pos.y + 0.25;
  const top = v.pos.y + v.spec.height;
  world.grid.query(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, (c) => {
    if (c.y1 < bottom || c.y0 > top) return;
    vehicleObb(v, obbA);
    let hit: boolean;
    if (c.circle) {
      hit = circleVsObb(c.cx, c.cz, c.r, obbA, contact);
      if (hit) {
        contact.nx = -contact.nx;
        contact.nz = -contact.nz;
      }
    } else {
      hit = obbVsAabb(obbA, c, contact);
    }
    if (!hit) return;
    any = true;
    if (c.breakable && v.speed > 3.5) {
      host.onPropBroken(c, v);
      const k = c.tag === 'bench' || c.tag === 'bin' || c.tag === 'hydrant' ? 0.95 : 0.85;
      v.vel.x *= k;
      v.vel.z *= k;
      return;
    }
    resolveStatic(v, contact, host);
  });
  return any;
}

function resolveStatic(v: Vehicle, ct: Contact, host: VehiclePhysicsHost): void {
  v.pos.x += ct.nx * (ct.depth + 0.001);
  v.pos.z += ct.nz * (ct.depth + 0.001);
  const m = v.spec.mass;
  const inertia = v.inertia;
  const px = ct.px - v.pos.x;
  const pz = ct.pz - v.pos.z;
  const vcx = v.vel.x + v.angVel * pz;
  const vcz = v.vel.z - v.angVel * px;
  const vn = vcx * ct.nx + vcz * ct.nz;
  // Sliding speed along the wall, before any impulse: a car grinding along a wall has vn ~ 0, so it is
  // reported before the early return below. Reporting changes nothing in the response.
  const tx = -ct.nz;
  const tz = ct.nx;
  const vt = vcx * tx + vcz * tz;
  if (Math.abs(vt) > SCRAPE_SPEED) host.onVehicleScrape(v, ct.px, ct.pz, Math.abs(vt));
  if (vn >= 0) return;
  const e = 0.2;
  const rn = pz * ct.nx - px * ct.nz;
  const j = (-(1 + e) * vn) / (1 / m + (rn * rn) / inertia);
  v.vel.x += (j * ct.nx) / m;
  v.vel.z += (j * ct.nz) / m;
  v.angVel += (j * rn) / inertia;
  // Coulomb friction along the wall.
  const rt = pz * tx - px * tz;
  let jt = -vt / (1 / m + (rt * rt) / inertia);
  const mu = 0.35;
  jt = clamp(jt, -mu * j, mu * j);
  v.vel.x += (jt * tx) / m;
  v.vel.z += (jt * tz) / m;
  v.angVel += (jt * rt) / inertia;
  v.angVel = clamp(v.angVel, -6, 6);
  const dv = j / m;
  if (dv > 1.5) host.onVehicleImpact(v, null, dv, ct.px, ct.pz, false, ct.nx, ct.nz);
}

/** Pairwise vehicle collisions (brute force with a cheap radius test). */
export function collideVehicles(vehicles: Vehicle[], host: VehiclePhysicsHost): void {
  const n = vehicles.length;
  for (let i = 0; i < n; i++) {
    const a = vehicles[i]!;
    if (a.removed) continue;
    const ra = Math.hypot(a.halfW, a.halfL);
    for (let j = i + 1; j < n; j++) {
      const b = vehicles[j]!;
      if (b.removed) continue;
      const rb = Math.hypot(b.halfW, b.halfL);
      const dx = a.pos.x - b.pos.x;
      const dz = a.pos.z - b.pos.z;
      if (dx * dx + dz * dz > (ra + rb) * (ra + rb)) continue;
      // Vertical separation (airborne car flying over another).
      if (a.pos.y > b.pos.y + b.spec.height - 0.2 || b.pos.y > a.pos.y + a.spec.height - 0.2) continue;
      vehicleObb(a, obbA);
      vehicleObb(b, obbB);
      if (!obbVsObb(obbA, obbB, contact)) continue;
      resolvePair(a, b, contact, host);
    }
  }
}

function resolvePair(a: Vehicle, b: Vehicle, ct: Contact, host: VehiclePhysicsHost): void {
  const ma = a.spec.mass;
  const mb = b.spec.mass;
  const ia = a.inertia;
  const ib = b.inertia;
  const wa = 1 / ma;
  const wb = 1 / mb;
  const corr = ct.depth + 0.001;
  let ka = wa / (wa + wb);
  let kb = wb / (wa + wb);
  // A car pinned against a ledge is never shoved up it (stepVehicle only guards a car's own motion):
  // the other car takes the whole push-out if it can.
  const w = host.world;
  if (pushBlocked(a, w, ct.nx, ct.nz, corr * ka)) {
    ka = 0;
    kb = pushBlocked(b, w, -ct.nx, -ct.nz, corr) ? 0 : 1;
  } else if (pushBlocked(b, w, -ct.nx, -ct.nz, corr * kb)) {
    ka = pushBlocked(a, w, ct.nx, ct.nz, corr) ? 0 : 1;
    kb = 0;
  }
  a.pos.x += ct.nx * corr * ka;
  a.pos.z += ct.nz * corr * ka;
  b.pos.x -= ct.nx * corr * kb;
  b.pos.z -= ct.nz * corr * kb;

  const pax = ct.px - a.pos.x;
  const paz = ct.pz - a.pos.z;
  const pbx = ct.px - b.pos.x;
  const pbz = ct.pz - b.pos.z;
  const vax = a.vel.x + a.angVel * paz;
  const vaz = a.vel.z - a.angVel * pax;
  const vbx = b.vel.x + b.angVel * pbz;
  const vbz = b.vel.z - b.angVel * pbx;
  const rvx = vax - vbx;
  const rvz = vaz - vbz;
  const vn = rvx * ct.nx + rvz * ct.nz;
  // Relative sliding speed along the contact, before any impulse (see resolveStatic). One report per pair, for the
  // faster of the two: the one doing the grinding, whose motion the sparks follow.
  const tx = -ct.nz;
  const tz = ct.nx;
  const vt = rvx * tx + rvz * tz;
  const faster = Math.hypot(b.vel.x, b.vel.z) > Math.hypot(a.vel.x, a.vel.z) ? b : a;
  if (Math.abs(vt) > SCRAPE_SPEED) host.onVehicleScrape(faster, ct.px, ct.pz, Math.abs(vt), faster === a ? b : a);
  if (vn >= 0) return;
  // Who drove into whom: each car's own speed towards the other (the normal points from b to a).
  const closingA = -(a.vel.x * ct.nx + a.vel.z * ct.nz);
  const closingB = b.vel.x * ct.nx + b.vel.z * ct.nz;
  const e = 0.25;
  const rna = paz * ct.nx - pax * ct.nz;
  const rnb = pbz * ct.nx - pbx * ct.nz;
  const j = (-(1 + e) * vn) / (wa + wb + (rna * rna) / ia + (rnb * rnb) / ib);
  a.vel.x += j * ct.nx * wa;
  a.vel.z += j * ct.nz * wa;
  a.angVel += (j * rna) / ia;
  b.vel.x -= j * ct.nx * wb;
  b.vel.z -= j * ct.nz * wb;
  b.angVel -= (j * rnb) / ib;

  const rta = paz * tx - pax * tz;
  const rtb = pbz * tx - pbx * tz;
  let jt = -vt / (wa + wb + (rta * rta) / ia + (rtb * rtb) / ib);
  const mu = 0.3;
  jt = clamp(jt, -mu * j, mu * j);
  a.vel.x += jt * tx * wa;
  a.vel.z += jt * tz * wa;
  a.angVel += (jt * rta) / ia;
  b.vel.x -= jt * tx * wb;
  b.vel.z -= jt * tz * wb;
  b.angVel -= (jt * rtb) / ib;
  a.angVel = clamp(a.angVel, -6, 6);
  b.angVel = clamp(b.angVel, -6, 6);

  const dva = j * wa;
  const dvb = j * wb;
  if (dva > 1.5) host.onVehicleImpact(a, b, dva, ct.px, ct.pz, closingB > closingA, ct.nx, ct.nz);
  if (dvb > 1.5) host.onVehicleImpact(b, a, dvb, ct.px, ct.pz, closingA > closingB, -ct.nx, -ct.nz);
}

/**
 * Gives a vehicle an explosion kick: upward launch, push and tumble. Kicks from chained blasts must not
 * add up: a wreck takes half the push, and a kick never takes a car past LAUNCH_MAX_SPEED (or past the
 * speed it already had) nor up faster than LAUNCH_MAX_VY.
 */
export function launchVehicle(v: Vehicle, dirX: number, dirZ: number, strength: number, spin: number): void {
  const s0 = Math.hypot(v.vel.x, v.vel.z);
  const push = v.destroyed ? strength * 0.5 : strength;
  v.vel.x += dirX * push;
  v.vel.z += dirZ * push;
  const cap = Math.max(s0, LAUNCH_MAX_SPEED);
  const s1 = Math.hypot(v.vel.x, v.vel.z);
  if (s1 > cap) {
    v.vel.x *= cap / s1;
    v.vel.z *= cap / s1;
  }
  v.vy = Math.min(Math.max(v.vy, strength * 0.9), LAUNCH_MAX_VY);
  if (!v.airborne) {
    v.airborne = true;
    v.airTime = 0;
    v.launchRamp = -1;
    v.pos.y += 0.05;
  }
  // A random tumble, from the vehicle's own generator so that runs repeat.
  v.pitchVel += (v.rng.next() - 0.5) * spin;
  v.rollVel += (v.rng.next() - 0.5) * spin * 1.4;
  v.angVel += (v.rng.next() - 0.5) * spin * 0.5;
}
