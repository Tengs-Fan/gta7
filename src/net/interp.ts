// Interpolation of remote entities: where on the server's tick line the client draws them, and the motion samples
// each entity is drawn from. Pure TypeScript.

import { wrapAngle } from '../core/math';

/**
 * The client's estimate of the server's tick line from snapshot arrivals, and the tick it renders remote entities at:
 * `delayTicks` behind the newest snapshot that could have arrived by now. Snapshots arrive 2-3 ticks apart with jitter
 * and some lost; the arrival line follows the earliest arrivals (a late one says less about the line than an early one)
 * and drifts down slowly so a slower link or a clock drift is followed too. The render tick advances with real time and
 * eases towards its target by at most `maxWarp` of the frame's step, so drawn motion never jumps.
 */
export class RenderClock {
  /** Server tick at local time 0 on the earliest-arrival line; NaN before the first snapshot. */
  private offset = NaN;
  private lastArrival = 0;
  renderTick = NaN;
  /** Ticks per second. */
  readonly rate: number;
  delayTicks: number;
  /** Ticks per second the arrival line sinks between snapshots (follows a link that got slower). */
  decay = 0.5;
  maxWarp = 0.1;

  constructor(rate = 60, delayTicks = 6) {
    this.rate = rate;
    this.delayTicks = delayTicks;
  }

  get started(): boolean {
    return !Number.isNaN(this.offset);
  }

  /** A snapshot of `tick` arrived at local time `nowMs`. */
  onSnapshot(tick: number, nowMs: number): void {
    const sample = tick - (nowMs * this.rate) / 1000;
    if (Number.isNaN(this.offset)) {
      this.offset = sample;
    } else {
      const sunk = this.offset - (this.decay * Math.max(0, nowMs - this.lastArrival)) / 1000;
      this.offset = Math.max(sample, sunk);
    }
    this.lastArrival = nowMs;
  }

  /** The newest server tick that could have arrived by `nowMs`. */
  observed(nowMs: number): number {
    return (nowMs * this.rate) / 1000 + this.offset;
  }

  /** Advances the render tick by a frame of `dt` seconds; returns it. */
  advance(dt: number, nowMs: number): number {
    if (!this.started) return NaN;
    const target = this.observed(nowMs) - this.delayTicks;
    if (Number.isNaN(this.renderTick) || Math.abs(target - this.renderTick) > this.delayTicks * 2) {
      this.renderTick = target;
      return target;
    }
    const step = dt * this.rate;
    const warp = Math.max(-this.maxWarp * step, Math.min(this.maxWarp * step, (target - this.renderTick) * 4 * dt));
    this.renderTick += step + warp;
    return this.renderTick;
  }

  /** Forget the line (a new connection). */
  reset(): void {
    this.offset = NaN;
    this.renderTick = NaN;
  }
}

/** One motion sample: the values the renderer reads that change continuously, at a server tick. */
export interface MotionSample {
  tick: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  heading: number;
  pitch: number;
  roll: number;
  /** Vehicles: wheel position; others 0. */
  steer: number;
  angVel: number;
}

export function emptySample(tick: number): MotionSample {
  return { tick, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, heading: 0, pitch: 0, roll: 0, steer: 0, angVel: 0 };
}

/** Samples are extrapolated along their velocity for at most this long past the newest one (ticks), then held. */
export const MAX_EXTRAPOLATE_TICKS = 6;
const KEEP = 12;

/** The recent motion samples of one entity, oldest first, by server tick. */
export class MotionTrack {
  readonly samples: MotionSample[] = [];

  get latest(): MotionSample | undefined {
    return this.samples[this.samples.length - 1];
  }

  /**
   * Adds a sample at its tick. `knownUntil` is the tick of the snapshot before this one: an entity whose motion was not
   * in it had not moved since its last sample, so that sample is repeated there first (a parked car that drives off
   * starts from rest instead of creeping since it parked).
   */
  push(s: MotionSample, knownUntil: number): void {
    const last = this.latest;
    if (last && s.tick <= last.tick) {
      if (s.tick === last.tick) this.samples[this.samples.length - 1] = s;
      return;
    }
    if (last && knownUntil > last.tick && knownUntil < s.tick) this.samples.push({ ...last, tick: knownUntil });
    this.samples.push(s);
    while (this.samples.length > KEEP) this.samples.shift();
  }

  clear(): void {
    this.samples.length = 0;
  }

  /** The motion at `tick` (fractional): between the samples around it, else extrapolated or held. */
  sample(tick: number, out: MotionSample): MotionSample {
    const ss = this.samples;
    const n = ss.length;
    if (n === 0) return out;
    if (tick <= ss[0]!.tick || n === 1) return copy(ss[0]!, out, tick);
    const last = ss[n - 1]!;
    if (tick >= last.tick) {
      copy(last, out, tick);
      const dt = Math.min(tick - last.tick, MAX_EXTRAPOLATE_TICKS) / 60;
      out.x += last.vx * dt;
      out.y += last.vy * dt;
      out.z += last.vz * dt;
      out.heading = wrapAngle(last.heading + last.angVel * dt);
      return out;
    }
    let i = n - 2;
    while (i > 0 && ss[i]!.tick > tick) i--;
    const a = ss[i]!;
    const b = ss[i + 1]!;
    const t = (tick - a.tick) / (b.tick - a.tick);
    out.tick = tick;
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.vx = a.vx + (b.vx - a.vx) * t;
    out.vy = a.vy + (b.vy - a.vy) * t;
    out.vz = a.vz + (b.vz - a.vz) * t;
    out.heading = wrapAngle(a.heading + wrapAngle(b.heading - a.heading) * t);
    out.pitch = a.pitch + wrapAngle(b.pitch - a.pitch) * t;
    out.roll = a.roll + wrapAngle(b.roll - a.roll) * t;
    out.steer = a.steer + (b.steer - a.steer) * t;
    out.angVel = a.angVel + (b.angVel - a.angVel) * t;
    return out;
  }
}

function copy(s: MotionSample, out: MotionSample, tick: number): MotionSample {
  Object.assign(out, s);
  out.tick = tick;
  return out;
}
