// The Cud & Sons Dairy's dog (no three.js, no sim state): it lies by the farmhouse until something moves on Creek Road or
// in the yard, then gets up, runs out and barks along the yard's east edge, keeping pace with a passing car as far as the
// run goes, and trots back to lie down when it has gone. It lives on one line, the run, 6 m inside the plot's east edge
// (the hedgerow ends north of the yard; the road's edge is 15 m beyond the plot's), so it can never leave the plot or reach
// the road: only its place along the line is its own.

import { clamp, dampAngle, moveTowards } from '../../../core/math';
import type { StaticWorld } from '../../../world/staticWorld';

/** A car under way or a person on foot, as the dog sees one: where, how fast and how it moves along the run (m/s). */
export interface Visitor {
  x: number;
  z: number;
  speed: number;
  vz: number;
}

export interface DogRun {
  /** The line it runs on, from `z0` (north) to `z1` (south), and where it lies. */
  x: number;
  z0: number;
  z1: number;
  home: number;
}

/** The dairy's run: along the east edge of its yard (the farmhouse's east wall is 4 m west of it). */
export function dogRun(world: StaticWorld): DogRun {
  const farm = world.layout.country.farms.farmsteads.find((f) => f.id === 'dairy')!;
  const plot = world.layout.country.plots.find((p) => p.id === 'dairy')!.rect;
  return { x: plot.maxX - 6, z0: farm.yard.minZ + 2, z1: farm.yard.maxZ - 4, home: farm.yard.maxZ - 7 };
}

/** It notices a visitor this near (m), barks at one this near, and gives it up when none has been that near for GIVE_UP s. */
export const ALERT_R = 70;
export const BARK_R = 55;
const GIVE_UP = 2.5;
const RUN_SPEED = 7.2;
const TROT_SPEED = 2.6;
/** Seconds between barks within a burst of three, and the pause after it. */
const BARK_GAP = 0.34;
const BARK_PAUSE = 1.1;
/** Seconds it takes to get up, and how long it looks before it runs. */
const STAND = 0.5;
const LOOK = 0.7;

export type DogState = 'rest' | 'alert' | 'chase' | 'return';

/** As drawn: its feet at (x, y, z) facing `yaw`, the legs' stride, lying down, the head's lift and the bark's jerk. */
export interface DogPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** The legs' phase (rad) and how far they swing (0 standing to 1 flat out). */
  gait: number;
  swing: number;
  /** 0 standing, 1 lying curled by the house. */
  lie: number;
  /** The head's lift (rad, + up) and a bark's jerk of it (0..1). */
  head: number;
  bark: number;
}

export class Dog {
  state: DogState = 'rest';
  readonly pose: DogPose;
  /** Its place on the run (z), and the speed along it (m/s, + south). */
  private z: number;
  private v = 0;
  private since = 0;
  private lost = 0;
  private nextBark = 0;
  private burst = 0;

  constructor(readonly run: DogRun, ground: number) {
    this.z = run.home;
    this.pose = { x: run.x, y: ground, z: run.home, yaw: -Math.PI / 2, gait: 0, swing: 0, lie: 1, head: 0, bark: 0 };
  }

  /** The nearest visitor within `r` of it, or null. */
  private nearest(visitors: readonly Visitor[], r: number): Visitor | null {
    let best: Visitor | null = null;
    let bd = r;
    for (const v of visitors) {
      const d = Math.hypot(v.x - this.run.x, v.z - this.z);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /** `dt` s on: the visitors (cars, the player on foot) move it; `bark` is told where each bark comes from. */
  update(dt: number, visitors: readonly Visitor[], bark: (x: number, y: number, z: number) => void): void {
    const p = this.pose;
    if (!(dt > 0)) return;
    this.since += dt;
    const near = this.nearest(visitors, ALERT_R);
    this.lost = near ? 0 : this.lost + dt;
    if (this.state === 'rest' || this.state === 'return') {
      if (near) {
        this.state = 'alert';
        this.since = 0;
        this.v = 0;
      }
    }
    let goal = this.z;
    let speedMax = 0;
    let face = p.yaw;
    if (this.state === 'alert') {
      if (near) face = Math.atan2(near.x - this.run.x, near.z - this.z);
      if (this.since >= STAND + LOOK) {
        this.state = 'chase';
        this.since = 0;
      }
    } else if (this.state === 'chase') {
      if (this.lost >= GIVE_UP) {
        this.state = 'return';
        this.since = 0;
      } else if (near) {
        // To where the car will be in half a second, as far along the run as it goes.
        goal = clamp(near.z + near.vz * 0.5, this.run.z0, this.run.z1);
        const off = goal - this.z;
        speedMax = Math.min(RUN_SPEED, 1.5 * Math.abs(off) + 1.5);
        // Running along the fence it faces its way; keeping pace it faces the car.
        face = Math.abs(off) > 1.2 ? (off > 0 ? 0 : Math.PI) : Math.atan2(near.x - this.run.x, near.z - this.z);
        if (Math.abs(off) <= 0.4) speedMax = 0;
        this.barks(dt, near, bark);
      }
    } else if (this.state === 'return') {
      goal = this.run.home;
      speedMax = TROT_SPEED;
      face = this.run.home > this.z ? 0 : Math.PI;
      if (Math.abs(this.run.home - this.z) < 0.2) {
        this.state = 'rest';
        this.since = 0;
        this.z = this.run.home;
        this.v = 0;
        face = -Math.PI / 2;
      }
    }
    // The speed along the run follows what it wants over a third of a second.
    const want = clamp((goal - this.z) * 3, -speedMax, speedMax);
    this.v = moveTowards(this.v, want, 16 * dt);
    this.z = clamp(this.z + this.v * dt, this.run.z0, this.run.z1);
    const speed = Math.abs(this.v);
    p.z = this.z;
    p.yaw = dampAngle(p.yaw, speed > 0.8 ? (this.v > 0 ? 0 : Math.PI) : face, 9, dt);
    p.swing = clamp(speed / RUN_SPEED, 0, 1);
    p.gait += dt * (4 + speed * 2.2);
    p.lie = moveTowards(p.lie, this.state === 'rest' ? 1 : 0, dt / STAND);
    p.head = this.state === 'chase' || this.state === 'alert' ? 0.35 : 0;
    p.bark = Math.max(0, p.bark - dt * 5);
  }

  /** Bursts of three barks a third of a second apart, a pause between. */
  private barks(dt: number, near: Visitor, bark: (x: number, y: number, z: number) => void): void {
    this.nextBark -= dt;
    if (this.nextBark > 0 || Math.hypot(near.x - this.run.x, near.z - this.z) > BARK_R) return;
    this.burst = (this.burst + 1) % 3;
    this.nextBark = this.burst === 0 ? BARK_PAUSE : BARK_GAP;
    this.pose.bark = 1;
    bark(this.run.x, this.pose.y + 0.5, this.z);
  }
}
