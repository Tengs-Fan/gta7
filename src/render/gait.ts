// Procedural gait for the character rig: planted feet, two-bone leg IK and arms swinging against the legs.
//
// Pure math without three.js. The hip height and the planted feet come from the gait cycle in sim/pose.ts
// (the simulation needs the hip height for the shoulders and the muzzle), so the legs drawn here always
// reach the ground under the hips the simulation assumes.

import { clamp, lerp, smoothstep } from '../core/math';
import {
  ankleOnGround, counterTwist, cycleFraction, gaitCycle, gaitHipY, gaitLean, hipSpread, makeFootTarget, makeGaitCycle, SKELETON,
  stanceFoot, type FootTarget, type GaitCycle,
} from '../sim/pose';

export interface TwoBone {
  /** Middle joint (knee, elbow). */
  mx: number;
  my: number;
  mz: number;
  /** End of the chain: the target when it is in reach, else the nearest reachable point towards it. */
  ex: number;
  ey: number;
  ez: number;
  /** The end reached the target. */
  reached: boolean;
}

export function makeTwoBone(): TwoBone {
  return { mx: 0, my: 0, mz: 0, ex: 0, ey: 0, ez: 0, reached: true };
}

/**
 * Two-bone IK: a chain of lengths a (root to middle) and b (middle to end) from the root towards the
 * target, bending its middle joint towards the pole direction. Out-of-reach targets clamp (straight or
 * fully folded chain pointing at the target); degenerate input (target on the root, pole along the chain,
 * non-finite numbers) still gives finite joints.
 */
export function solveTwoBone(
  rx: number, ry: number, rz: number,
  tx: number, ty: number, tz: number,
  a: number, b: number,
  px: number, py: number, pz: number,
  out: TwoBone,
): TwoBone {
  let dx = tx - rx;
  let dy = ty - ry;
  let dz = tz - rz;
  let d = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(d)) {
    // No usable target: hang the chain straight down.
    dx = 0;
    dy = -(a + b);
    dz = 0;
    d = a + b;
  }
  let ux: number;
  let uy: number;
  let uz: number;
  if (d > 1e-9) {
    ux = dx / d;
    uy = dy / d;
    uz = dz / d;
  } else {
    ux = 0;
    uy = -1;
    uz = 0;
  }
  const lo = Math.abs(a - b) + 1e-5;
  const hi = Math.max(lo, a + b - 1e-5);
  const dc = clamp(d, lo, hi);
  out.reached = Number.isFinite(d) && d >= lo - 1e-9 && d <= hi + 1e-9;
  const cosA = clamp((a * a + dc * dc - b * b) / (2 * a * dc), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  // Bend direction: the pole with its component along the chain removed.
  if (!Number.isFinite(px + py + pz)) {
    px = 0;
    py = 0;
    pz = 1;
  }
  const pd = px * ux + py * uy + pz * uz;
  let wx = px - pd * ux;
  let wy = py - pd * uy;
  let wz = pz - pd * uz;
  let wl = Math.hypot(wx, wy, wz);
  if (wl < 1e-6) {
    // Pole along the chain: any perpendicular will do.
    if (Math.abs(ux) < 0.9) {
      wx = 0;
      wy = uz;
      wz = -uy;
    } else {
      wx = -uz;
      wy = 0;
      wz = ux;
    }
    wl = Math.hypot(wx, wy, wz);
  }
  wx /= wl;
  wy /= wl;
  wz /= wl;
  out.mx = rx + a * (cosA * ux + sinA * wx);
  out.my = ry + a * (cosA * uy + sinA * wy);
  out.mz = rz + a * (cosA * uz + sinA * wz);
  out.ex = rx + ux * dc;
  out.ey = ry + uy * dc;
  out.ez = rz + uz * dc;
  return out;
}

/** Lowest point of a shoe's sole (relative to the ground) for an ankle at height y pitched by `pitch` (+ toe up). */
export function soleLow(y: number, pitch: number, scale: number): number {
  const s = Math.sin(pitch);
  const c = Math.cos(pitch);
  const down = -SKELETON.ankleY * scale * c;
  return y + Math.min(down - SKELETON.heel * scale * s, down + SKELETON.toe * scale * s);
}

/**
 * A swinging foot at swing progress t (0 lift-off .. 1 touch-down), relative to the point under its hip.
 * The path leaves and meets the ground at the planted foot's speed under the body, so the foot keeps
 * sweeping back briefly after toe-off (the heel kick of a runner) and is pulled back before it lands
 * instead of slapping down while still moving forward.
 */
export function swingFoot(g: GaitCycle, t: number, scale: number, out: FootTarget): FootTarget {
  const tt = clamp(t, 0, 1);
  // Hermite curve from -half to +half; both end slopes equal the stance sweep (-2 half per stance, in swing time).
  const slope = (-2 * (1 - g.duty)) / Math.max(0.05, g.duty);
  const t2 = tt * tt;
  const t3 = t2 * tt;
  const d = g.half * (-1 + (6 * t2 - 4 * t3) + slope * (2 * t3 - 3 * t2 + tt));
  ankleOnGround(g.mx * d, g.mz * d - g.back, lerp(g.pitchOut, g.pitchIn, smoothstep(0, 1, tt)), scale, out);
  out.y += g.lift * Math.sin(Math.PI * Math.pow(tt, 1 - 0.35 * g.kick));
  // Sideways steps cross in front of the planted foot instead of through it.
  out.z += Math.abs(g.mx) * 0.12 * scale * Math.sin(Math.PI * tt);
  const low = soleLow(out.y, out.pitch, scale);
  if (low < 0) out.y -= low;
  return out;
}

export interface LegPose {
  /** Ankle target and foot pitch (hip frame: x left, y up from the ground, z forward). */
  foot: FootTarget;
  planted: boolean;
  /** Solved leg (hip frame): knee and ankle. */
  knee: { x: number; y: number; z: number };
  ankle: { x: number; y: number; z: number };
  /** Hip pitch (- forward), hip roll (+ towards the character's left) and knee flex (0 straight). */
  hipPitch: number;
  hipRoll: number;
  kneeFlex: number;
}

export interface ArmSwing {
  /** Shoulder pitch (- forward), abduction away from the body and elbow flex, in radians. */
  pitch: number;
  abduct: number;
  elbow: number;
}

export interface GaitOut {
  /** Hip joint height above the ground (the pelvis drop and bob included). */
  hipY: number;
  /** Chest counter-rotation against the legs, relative to the hips, and the forward lean. */
  chestYaw: number;
  lean: number;
  /** 0 = left, 1 = right. */
  legs: [LegPose, LegPose];
  arms: [ArmSwing, ArmSwing];
  readonly cycle: GaitCycle;
}

function makeLeg(): LegPose {
  return { foot: makeFootTarget(), planted: true, knee: { x: 0, y: 0, z: 0 }, ankle: { x: 0, y: 0, z: 0 }, hipPitch: 0, hipRoll: 0, kneeFlex: 0 };
}

export function makeGaitOut(): GaitOut {
  return {
    hipY: SKELETON.hipY,
    chestYaw: 0,
    lean: 0,
    legs: [makeLeg(), makeLeg()],
    arms: [{ pitch: 0, abduct: 0, elbow: 0 }, { pitch: 0, abduct: 0, elbow: 0 }],
    cycle: makeGaitCycle(),
  };
}

const ik = makeTwoBone();

/**
 * Solves a leg from its hip joint (hx, hy, 0) to the ankle target, the knee bending forward, and fills the
 * joint positions and angles. Shared by the gait and the blended poses in CrowdView.
 */
export function solveLeg(hx: number, hy: number, scale: number, leg: LegPose): LegPose {
  const a = SKELETON.thigh * scale;
  const b = SKELETON.shin * scale;
  const f = leg.foot;
  solveTwoBone(hx, hy, 0, f.x, f.y, f.z, a, b, 0, 0, 1, ik);
  leg.knee.x = ik.mx;
  leg.knee.y = ik.my;
  leg.knee.z = ik.mz;
  leg.ankle.x = ik.ex;
  leg.ankle.y = ik.ey;
  leg.ankle.z = ik.ez;
  const tx = ik.mx - hx;
  const ty = ik.my - hy;
  const tz = ik.mz;
  leg.hipRoll = Math.atan2(tx, -ty);
  leg.hipPitch = Math.atan2(-tz, Math.hypot(tx, ty));
  const sx = ik.ex - ik.mx;
  const sy = ik.ey - ik.my;
  const sz = ik.ez - ik.mz;
  const dot = (tx * sx + ty * sy + tz * sz) / (a * b);
  leg.kneeFlex = Math.acos(clamp(dot, -1, 1));
  return leg;
}

/**
 * Gait pose at `phase` (radians, one cycle per stride; 0 = left foot touch-down) for moving at `speed`
 * in direction `strafe` relative to the hips (0 forward, +PI/2 to the character's left, PI backwards),
 * for a character of height `scale` and build `build`. `cycle` may pass the gait cycle already set up
 * for exactly these (sim/pose.ts trunkPose computes it).
 */
export function gait(phase: number, speed: number, strafe: number, out: GaitOut, scale = 1, build = 1, cycle: GaitCycle | null = null): GaitOut {
  const st = Number.isFinite(strafe) ? strafe : 0;
  const g = cycle ? Object.assign(out.cycle, cycle) : gaitCycle(speed, Math.sin(st), Math.cos(st), scale, out.cycle);
  const u = cycleFraction(phase);
  const ph = u * Math.PI * 2;
  const v = g.speed;
  out.hipY = gaitHipY(g, u);
  out.chestYaw = counterTwist(v, g.mz, ph);
  out.lean = gaitLean(v, g.mz);
  const hx = hipSpread(build);
  for (let i = 0; i < 2; i++) {
    const leg = out.legs[i]!;
    const side = i === 0 ? 1 : -1;
    const ui = i === 0 ? u : (u + 0.5) % 1;
    leg.planted = ui < g.duty;
    if (leg.planted) stanceFoot(g, ui / g.duty, scale, leg.foot);
    else swingFoot(g, (ui - g.duty) / (1 - g.duty), scale, leg.foot);
    leg.foot.x += side * hx;
    solveLeg(side * hx, out.hipY, scale, leg);
  }
  // Arms swing against the legs: the right arm comes forward with the left leg.
  const run = smoothstep(1.9, 4.3, v);
  const sprint = smoothstep(4.3, 7.4, v);
  const amp = (lerp(0.3, 0.55, run) + 0.35 * sprint) * (0.4 + 0.6 * Math.abs(g.mz)) * smoothstep(0.3, 1.2, v);
  const bias = lerp(0.04, 0.2, run) + 0.1 * sprint;
  const elbow = lerp(0.22, 1.15, run) + 0.3 * sprint;
  for (let i = 0; i < 2; i++) {
    const arm = out.arms[i]!;
    const forward = (i === 0 ? -1 : 1) * Math.cos(ph) * Math.sign(g.mz || 1);
    arm.pitch = -(amp * forward + bias);
    arm.abduct = 0.1 + 0.05 * run;
    arm.elbow = elbow + lerp(0.15, 0.2, run) * Math.max(0, forward);
  }
  return out;
}
