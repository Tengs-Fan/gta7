// Arcade vehicle dynamics and collision response (static world and vehicle vs vehicle).

import { circleVsObb, makeContact, obbBounds, obbVsAabb, obbVsObb, type AABB, type Contact, type OBB } from '../core/collision';
import { clamp, damp, dampAngle, moveTowards, wrapAngle } from '../core/math';
import type { StaticCollider } from '../world/colliders';
import { WATER_Y } from '../world/constants';
import type { StaticWorld } from '../world/staticWorld';
import type { Vehicle } from './entities';

export const VEHICLE_GRAVITY = 17;
const MAX_STEP_UP = 1.0;

export interface VehiclePhysicsHost {
  world: StaticWorld;
  vehicles: Vehicle[];
  onVehicleImpact(v: Vehicle, other: Vehicle | null, deltaV: number, x: number, z: number): void;
  onPropBroken(c: StaticCollider, v: Vehicle): void;
  onVehicleLanded(v: Vehicle, impact: number): void;
  onVehicleEnteredWater(v: Vehicle): void;
}

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
    v.pos.x += v.vel.x * dt;
    v.pos.z += v.vel.z * dt;
    v.pos.y = Math.max(WATER_Y - 3.2, v.pos.y + v.vy * dt);
    v.sinkTimer += dt;
    updateDerived(v, dt, 0);
    return;
  }

  let fx = Math.sin(v.heading);
  let fz = Math.cos(v.heading);
  let vF = v.vel.x * fx + v.vel.z * fz;

  if (!v.airborne) {
    // --- Yaw (kinematic bicycle model limited by tyre grip) ---
    const speedAbs = Math.abs(vF);
    const wheelbase = s.length * 0.6;
    const maxSteer = s.steer / (1 + speedAbs / 15);
    const delta = -v.steer * maxSteer;
    let yawTarget = (vF * Math.tan(delta)) / wheelbase;
    const gripLimit = ((handbrake ? 2.0 : 1.12) * s.grip) / Math.max(speedAbs, 2.5);
    yawTarget = clamp(yawTarget, -gripLimit, gripLimit);
    if (v.destroyed || v.flipped) yawTarget = 0;
    const resp = handbrake ? 5.5 : 9;
    v.angVel += (yawTarget - v.angVel) * Math.min(1, resp * dt);
  } else {
    v.angVel *= Math.exp(-0.4 * dt);
  }
  v.heading = wrapAngle(v.heading + v.angVel * dt);

  fx = Math.sin(v.heading);
  fz = Math.cos(v.heading);
  const rx = -fz;
  const rz = fx;
  vF = v.vel.x * fx + v.vel.z * fz;
  let vR = v.vel.x * rx + v.vel.z * rz;

  v.braking = false;
  v.reversing = false;
  if (!v.airborne) {
    // --- Longitudinal ---
    let accel = 0;
    if (throttle > 0.01) {
      if (vF >= -0.5) accel += throttle * s.accel * Math.max(0, 1 - (vF / s.maxSpeed) ** 2);
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
        accel -= brake * s.accel * 0.65 * Math.max(0, 1 - (-vF / s.reverseSpeed) ** 2);
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
    if (throttle < 0.01 && brake < 0.01) friction += 1.4; // engine braking
    if (!hasDriver) friction += 5.5; // parked: handbrake on
    if (handbrake) friction += 7.5;
    if (v.destroyed || v.flipped) friction += 9;
    vF = moveTowards(vF, 0, friction * dt);

    // --- Lateral grip ---
    const grip = handbrake ? s.grip * 0.3 : v.destroyed || v.flipped ? s.grip * 1.5 : s.grip;
    const skidLat = Math.abs(vR);
    vR = moveTowards(vR, 0, grip * dt);
    const skidTarget = clamp((skidLat - 2.2) / 6, 0, 1) + (handbrake && Math.abs(vF) > 5 ? 0.6 : 0) + (v.braking && Math.abs(vF) > 12 && brake > 0.8 ? 0.35 : 0);
    v.skid = damp(v.skid, clamp(skidTarget, 0, 1), 10, dt);
  } else {
    v.skid = damp(v.skid, 0, 10, dt);
  }

  v.vel.x = fx * vF + rx * vR;
  v.vel.z = fz * vF + rz * vR;

  // --- Integrate horizontal position with step-up blocking (ramp backs, high ledges) ---
  let nx = v.pos.x + v.vel.x * dt;
  let nz = v.pos.z + v.vel.z * dt;
  const probe = Math.sign(vF || 1) * Math.min(v.halfL, 2.2);
  const ahead = world.groundHeight(nx + fx * probe, nz + fz * probe);
  if (!v.airborne && ahead > v.pos.y + MAX_STEP_UP) {
    nx = oldX;
    nz = oldZ;
    // Treat as a wall hit.
    const sp = Math.hypot(v.vel.x, v.vel.z);
    if (sp > 4) host.onVehicleImpact(v, null, sp * 0.6, oldX + fx * probe, oldZ + fz * probe);
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
      const upside = Math.abs(wrapAngle(v.roll)) > 1.9 || Math.abs(wrapAngle(v.pitch)) > 1.9;
      v.pitchVel = 0;
      v.rollVel = 0;
      if (upside && !v.destroyed) v.flipped = true;
      host.onVehicleLanded(v, impact);
    }
  } else {
    if (gy >= v.pos.y - 0.4 || (gy > v.pos.y - 1.2 && v.climbRate < 1.5)) {
      // Follow the ground. Large ground drops (> 0.4 m, e.g. quay edge or ramp end) start a flight.
      const rate = (gy - v.pos.y) / dt;
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
  if (v.pos.y < WATER_Y + 0.15 && world.waterDepth(v.pos.x, v.pos.z) > 0.8) {
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
  if (vn >= 0) return;
  const e = 0.2;
  const rn = pz * ct.nx - px * ct.nz;
  const j = (-(1 + e) * vn) / (1 / m + (rn * rn) / inertia);
  v.vel.x += (j * ct.nx) / m;
  v.vel.z += (j * ct.nz) / m;
  v.angVel += (j * rn) / inertia;
  // Coulomb friction along the wall.
  const tx = -ct.nz;
  const tz = ct.nx;
  const vt = vcx * tx + vcz * tz;
  const rt = pz * tx - px * tz;
  let jt = -vt / (1 / m + (rt * rt) / inertia);
  const mu = 0.35;
  jt = clamp(jt, -mu * j, mu * j);
  v.vel.x += (jt * tx) / m;
  v.vel.z += (jt * tz) / m;
  v.angVel += (jt * rt) / inertia;
  v.angVel = clamp(v.angVel, -6, 6);
  const dv = j / m;
  if (dv > 1.5) host.onVehicleImpact(v, null, dv, ct.px, ct.pz);
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
  a.pos.x += ct.nx * corr * (wa / (wa + wb));
  a.pos.z += ct.nz * corr * (wa / (wa + wb));
  b.pos.x -= ct.nx * corr * (wb / (wa + wb));
  b.pos.z -= ct.nz * corr * (wb / (wa + wb));

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
  if (vn >= 0) return;
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

  const tx = -ct.nz;
  const tz = ct.nx;
  const vt = rvx * tx + rvz * tz;
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
  if (dva > 1.5) host.onVehicleImpact(a, b, dva, ct.px, ct.pz);
  if (dvb > 1.5) host.onVehicleImpact(b, a, dvb, ct.px, ct.pz);
}

/** Gives a vehicle an explosion kick: upward launch, push and tumble. */
export function launchVehicle(v: Vehicle, dirX: number, dirZ: number, strength: number, spin: number): void {
  v.vel.x += dirX * strength;
  v.vel.z += dirZ * strength;
  v.vy = Math.max(v.vy, strength * 0.9);
  if (!v.airborne) {
    v.airborne = true;
    v.airTime = 0;
    v.launchRamp = -1;
    v.pos.y += 0.05;
  }
  v.pitchVel += (Math.random() - 0.5) * spin;
  v.rollVel += (Math.random() - 0.5) * spin * 1.4;
  v.angVel += (Math.random() - 0.5) * spin * 0.5;
}
