// The drawn body's response to the ground under its wheels, on top of what the sim already draws (its pitch along a
// slope, VehicleView's lean under acceleration and in turns): it rolls with one side up a curb, pitches with a pair of
// wheels up a step the sim's slope samples average out, and is kicked by a sudden step (a curb, a kerbstone, a bump
// at a ramp's foot), springing back with a little overshoot. Presentation only: it reads the ground and the sim's
// vehicle and never writes to either.

import { clamp } from '../core/math';
import type { Vehicle } from '../sim/entities';

/** Spring stiffness (natural frequency, rad/s) and damping ratio of the drawn body. */
const OMEGA = 13;
const ZETA = 0.6;
/** Angular speed (rad/s) a sudden rise under one axle or one side gives the body, per radian of the step it makes. */
const KICK = 6;
/** Largest drawn suspension angle (rad). */
const MAX_ANGLE = 0.12;
/** Steps bigger than this (m) between frames are a teleport, a flight landing or a deck edge: no kick. */
const MAX_STEP = 0.4;

export interface GroundSampler {
  groundHeight(x: number, z: number): number;
}

/** Wheel contact points, as shares of the half length (axles) and half width (track). */
const AXLE = 0.72;
const TRACK = 0.82;

export class Suspension {
  /** Rotation to add to the drawn body: about x (positive dips the nose, as VehicleView's) and about z (positive lifts the left). */
  rotX = 0;
  rotZ = 0;
  private velX = 0;
  private velZ = 0;
  private lastPitch = NaN;
  private lastRoll = NaN;

  constructor(private readonly ground: GroundSampler) {}

  reset(): void {
    this.rotX = this.rotZ = this.velX = this.velZ = 0;
    this.lastPitch = this.lastRoll = NaN;
  }

  update(v: Vehicle, dt: number): this {
    if (!(dt > 0)) return this;
    let pitchT = 0;
    let rollT = 0;
    const grounded = !v.airborne && !v.inWater && !v.flipped && !v.destroyed;
    if (grounded) {
      const fx = Math.sin(v.heading);
      const fz = Math.cos(v.heading);
      const lx = Math.cos(v.heading);
      const lz = -Math.sin(v.heading);
      const a = v.halfL * AXLE;
      const b = v.halfW * TRACK;
      const g = this.ground;
      const h = (u: number, w: number) => g.groundHeight(v.pos.x + fx * u + lx * w, v.pos.z + fz * u + lz * w);
      const fl = h(a, b);
      const fr = h(a, -b);
      const rl = h(-a, b);
      const rr = h(-a, -b);
      // Nose up for front wheels higher than the rear, less the slope the sim already pitches the car by.
      const pitch = Math.atan2((fl + fr - rl - rr) / 2, 2 * a);
      const roll = Math.atan2((fl + rl - fr - rr) / 2, 2 * b);
      if (Number.isFinite(this.lastPitch)) {
        const dp = pitch - this.lastPitch;
        const dr = roll - this.lastRoll;
        if (Math.abs(dp) * 2 * a < MAX_STEP) this.velX -= dp * KICK;
        if (Math.abs(dr) * 2 * b < MAX_STEP) this.velZ += dr * KICK;
      }
      this.lastPitch = pitch;
      this.lastRoll = roll;
      pitchT = -(pitch - v.pitch);
      rollT = roll;
    } else {
      this.lastPitch = this.lastRoll = NaN;
    }
    // Semi-implicit spring steps, sub-stepped so a long frame cannot blow it up.
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.velX += (OMEGA * OMEGA * (pitchT - this.rotX) - 2 * ZETA * OMEGA * this.velX) * h;
      this.velZ += (OMEGA * OMEGA * (rollT - this.rotZ) - 2 * ZETA * OMEGA * this.velZ) * h;
      this.rotX += this.velX * h;
      this.rotZ += this.velZ * h;
    }
    this.rotX = clamp(this.rotX, -MAX_ANGLE, MAX_ANGLE);
    this.rotZ = clamp(this.rotZ, -MAX_ANGLE, MAX_ANGLE);
    return this;
  }
}
