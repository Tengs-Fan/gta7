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
 * fully folded chain pointing at the target); degenerate input (target on the root, pole along the chain)
 * still gives finite joints.
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
  const d = Math.hypot(dx, dy, dz);
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
  out.reached = d >= lo - 1e-9 && d <= hi + 1e-9;
  const cosA = clamp((a * a + dc * dc - b * b) / (2 * a * dc), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  // Bend direction: the pole with its component along the chain removed.
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
  /** Forearm turned out from the upper arm (negative: the hand comes in across the body). */
  out: number;
}

/**
 * How one person walks, beyond what the simulation sets (the stride, the pace of the cycle and the hip height, which
 * the planted feet depend on): how far the arms swing (x), how much more the elbows bend (rad), and how far his feet
 * fall from the line under his hips (x the hip spread).
 */
export interface GaitStyle {
  swing: number;
  elbow: number;
  width: number;
}

export const PLAIN_GAIT: Readonly<GaitStyle> = { swing: 1, elbow: 0, width: 1 };

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
    arms: [{ pitch: 0, abduct: 0, elbow: 0, out: 0 }, { pitch: 0, abduct: 0, elbow: 0, out: 0 }],
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
 * How far a swinging foot may be bent up towards the shin from square to it (rad, 20 degrees), about what a running
 * ankle reaches. A foot carried level through the swing was bent up 60 to 70 degrees as the heel kicked up behind a
 * jogger or a sprinter, the shin near level, the sole showing to the front.
 */
const SWING_DORSI = 0.35;
const TOE_REACH = Math.hypot(SKELETON.toe, SKELETON.ankleY);
const TOE_ANGLE = Math.atan2(SKELETON.ankleY, SKELETON.toe);

/**
 * Turns a swinging foot's toe down as far as the ankle needs (SWING_DORSI), in the middle of the swing: it leaves the
 * ground and lands at the pitch the stance gives it. Never through the ground: a low ankle keeps the toe above it.
 */
function swingAnkle(leg: LegPose, t: number, scale: number): void {
  const f = leg.foot;
  // The shin's lean (+ the knee ahead of the ankle): a foot square to it is pitched toe down by as much.
  const shin = Math.atan2(leg.knee.z - leg.ankle.z, leg.knee.y - leg.ankle.y);
  const most = SWING_DORSI - shin;
  if (f.pitch <= most) return;
  let pitch = lerp(f.pitch, most, smoothstep(0, 0.3, t) * smoothstep(1, 0.7, t));
  const y = leg.ankle.y / (TOE_REACH * scale);
  if (y < 1) pitch = Math.max(pitch, TOE_ANGLE - Math.asin(y));
  f.pitch = Math.min(f.pitch, pitch);
}

/**
 * Gait pose at `phase` (radians, one cycle per stride; 0 = left foot touch-down) for moving at `speed`
 * in direction `strafe` relative to the hips (0 forward, +PI/2 to the character's left, PI backwards),
 * for a character of height `scale` and build `build`. `cycle` may pass the gait cycle already set up
 * for exactly these (sim/pose.ts trunkPose computes it). `style`: the person's own way of walking.
 */
export function gait(phase: number, speed: number, strafe: number, out: GaitOut, scale = 1, build = 1, cycle: GaitCycle | null = null, style: Readonly<GaitStyle> = PLAIN_GAIT): GaitOut {
  const g = cycle ? Object.assign(out.cycle, cycle) : gaitCycle(speed, Math.sin(strafe), Math.cos(strafe), scale, out.cycle);
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
    const t = (ui - g.duty) / (1 - g.duty);
    if (leg.planted) stanceFoot(g, ui / g.duty, scale, leg.foot);
    else swingFoot(g, t, scale, leg.foot);
    leg.foot.x += side * hx * style.width;
    solveLeg(side * hx, out.hipY, scale, leg);
    if (!leg.planted) swingAnkle(leg, t, scale);
  }
  // Arms swing against the legs, the right arm forward with the left leg, about a point relative to the chest (+ forward,
  // rad): a walker's a little forward of hanging, so with his lean they swing 20 degrees either side of plumb; a jogger's
  // a little behind it, so the hand passes back beyond the hip (a swing about a point ahead of the shoulder kept both
  // hands in front of the belly through the whole stride, 0.01 to 0.45 m ahead of the shoulder at 4.3 m/s); a sprinter's
  // forward again, the hands driving up to the chin. The elbow bends more as the arm comes forward: 13 to 35 degrees
  // walking, 57 to 100 jogging, and the forward hand comes in across the body.
  const run = smoothstep(1.9, 4.3, v);
  const sprint = smoothstep(4.3, 7.4, v);
  const amp = (lerp(0.33, 0.61, run) + 0.22 * sprint) * (0.4 + 0.6 * Math.abs(g.mz)) * smoothstep(0.3, 1.2, v) * style.swing;
  const mid = lerp(0.04, -0.02, run) + 0.19 * sprint;
  const elbow = lerp(0.22, 1.0, run) + 0.15 * sprint + style.elbow;
  const bend = lerp(0.38, 0.75, run);
  for (let i = 0; i < 2; i++) {
    const arm = out.arms[i]!;
    const forward = (i === 0 ? -1 : 1) * Math.cos(ph) * Math.sign(g.mz || 1);
    const ahead = (forward + 1) / 2;
    arm.pitch = -(amp * forward + mid);
    arm.abduct = 0.1 + 0.05 * run;
    arm.elbow = elbow + bend * ahead;
    arm.out = -0.4 * run * ahead * ahead;
  }
  return out;
}
