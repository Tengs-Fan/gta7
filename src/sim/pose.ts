// Character skeleton, locomotion trunk and weapon-holding pose, shared by the simulation and the renderer.
//
// Pure math without three.js. CombatSystem.muzzle() returns weaponPose(c).tip and CrowdView draws the
// weapon and the arms holding it from the same pose, so the drawn barrel tip is where bullets and rockets
// leave from (CrowdView eases the hips in and out of a stride, the only moments the two part, by
// centimetres). The trunk (hip height, hip and chest yaw, lean) carries the shoulders, so the gait cycle
// that sets the hip height lives here too; render/gait.ts builds the legs and swinging arms under it.
//
// Frames: a character's hip frame has its origin on the ground under the hips (c.pos), yaw `hipYaw`,
// +x to the character's left, +y up and +z forward. Lengths are for appearance.height 1 (a 1.8 m person)
// and scale with the height; the shoulder and hip spread scale with the build instead.

import { clamp, lerp, smoothstep, TAU, wrapAngle, type V3 } from '../core/math';
import type { Character, Vehicle } from './entities';
import { firingRowsOf, GUN_PORT, isGun, WEAPONS, weaponPointsOf, type VehicleKind, type WeaponId, type WeaponPoints } from './specs';

export const SKELETON = {
  /**
   * Hip joint height when standing: a millimetre short of the leg's full length (thigh + shin + ankleY), so a standing
   * leg is all but straight (about 5 degrees of knee bend) instead of squatting.
   */
  hipY: 0.894,
  /** Hip joints sit this far either side of the centre line (x build). */
  hipX: 0.11,
  thigh: 0.43,
  shin: 0.39,
  /** The ankle joint sits this high above the sole; the shoe reaches `heel` behind and `toe` in front of it. */
  ankleY: 0.075,
  heel: 0.07,
  toe: 0.19,
  /** Shoulder joints: height above the hip joints, and half spread shoulderX * build + shoulderPad. */
  shoulderY: 0.6,
  shoulderX: 0.22,
  shoulderPad: 0.065,
  upperArm: 0.3,
  forearm: 0.26,
  /** Wrist to the centre of the hand. */
  hand: 0.05,
  /** Neck pivot above the hip joints. */
  neckY: 0.64,
} as const;

export function shoulderSpread(build: number): number {
  return SKELETON.shoulderX * build + SKELETON.shoulderPad;
}

export function hipSpread(build: number): number {
  return SKELETON.hipX * build;
}

/** Below this speed a character stands (the gait phase holds). */
export const IDLE_SPEED = 0.3;

/** A swimmer's hips sit this far above c.pos.y; treading water he leans forward by SWIM_TREAD_LEAN (CrowdView swim). */
export const SWIM_HIP = 1.2;
export const SWIM_TREAD_LEAN = 0.35;
/** A swimmer holds a gun up out of the water at most this far below level. */
const SWIM_AIM_LOW = -0.35;

// ---------------------------------------------------------------------------
// Gait cycle

/** Distance covered per gait cycle (two steps): 1.4 m at a 1.45 m/s walk, 2.2 m at a 4.3 m/s jog, 3.2 m at a 7.4 m/s sprint. */
export function strideLength(speed: number): number {
  if (!(speed > 1.45)) return 1.4;
  if (speed < 4.3) return 1.4 + ((speed - 1.45) / (4.3 - 1.45)) * 0.8;
  if (speed < 7.4) return 2.2 + ((speed - 4.3) / (7.4 - 4.3)) * 1.0;
  return 3.2;
}

/** Gait phase advance (radians) for moving `dt` seconds at `speed`: one cycle per stride, so planted feet stay put. */
export function gaitPhaseStep(speed: number, dt: number): number {
  return speed > 0 ? (speed / strideLength(speed)) * TAU * dt : 0;
}

/** Fraction of a cycle each foot is planted: above 0.5 a walk (both feet down at times), below a run (both up at times). */
export function dutyFactor(speed: number): number {
  const v = Number.isFinite(speed) ? speed : 0;
  if (v <= 1.45) return 0.62;
  if (v <= 1.9) return lerp(0.62, 0.6, (v - 1.45) / 0.45);
  if (v <= 2.8) return lerp(0.6, 0.55, (v - 1.9) / 0.9);
  if (v <= 4.3) return lerp(0.55, 0.4, (v - 2.8) / 1.5);
  if (v <= 7.4) return lerp(0.4, 0.3, (v - 4.3) / 3.1);
  return Math.max(0.24, 0.3 - (v - 7.4) * 0.012);
}

/** Stance progress where a forward step's heel rocker (landing) ends. */
const ROCK_IN = 0.18;

/** Everything about one gait cycle that the hip height and the legs must agree on. */
export interface GaitCycle {
  speed: number;
  /** Fraction of the cycle a foot is planted. */
  duty: number;
  /** A planted foot travels from +half to -half along the movement direction (m). */
  half: number;
  /** Movement direction in the hip frame (x left, z forward), unit. */
  mx: number;
  mz: number;
  /** The planted stretch is centred this far behind the hip joint (body -z, m). */
  back: number;
  /**
   * Foot pitch (+ toe up) at touch-down, through the middle of the stance and at lift-off, and the stance
   * progress where the landing roll ends and where the push-off starts. A pitched foot pivots on the edge
   * that is on the ground.
   */
  pitchIn: number;
  pitchMid: number;
  pitchOut: number;
  rockIn: number;
  rockOut: number;
  /** Swing foot lift (m) and how far it is kicked up behind the body (0 walk .. 1 sprint). */
  lift: number;
  kick: number;
  /**
   * Hip height: walking (top, falling by dip to its lowest at cycle fraction walkLow and again half a cycle on) and
   * running (top - dip at mid-stance), blended by `run`.
   */
  walkTop: number;
  walkDip: number;
  walkLow: number;
  runTop: number;
  runDip: number;
  run: number;
}

export function makeGaitCycle(): GaitCycle {
  return { speed: 0, duty: 0.62, half: 0, mx: 0, mz: 1, back: 0, pitchIn: 0, pitchMid: 0, pitchOut: 0, rockIn: ROCK_IN, rockOut: 0.55, lift: 0, kick: 0, walkTop: SKELETON.hipY, walkDip: 0, walkLow: 0.06, runTop: SKELETON.hipY, runDip: 0, run: 0 };
}

export interface FootTarget {
  /** Ankle joint in the hip frame (y above the ground). */
  x: number;
  y: number;
  z: number;
  /** Foot pitch, + toe up. */
  pitch: number;
}

export function makeFootTarget(): FootTarget {
  return { x: 0, y: 0, z: 0, pitch: 0 };
}

/**
 * Ankle of a foot whose flat-footed ankle would sit at (x, z) (relative to the point under its hip),
 * pitched by `pitch`: toe up pivots about the heel edge, heel up about the toe edge, so the pivot edge
 * stays on the ground.
 */
export function ankleOnGround(x: number, z: number, pitch: number, scale: number, out: FootTarget): FootTarget {
  const ay = SKELETON.ankleY * scale;
  out.x = x;
  out.pitch = pitch;
  if (pitch === 0) {
    out.y = ay;
    out.z = z;
    return out;
  }
  // Ankle relative to the pivot edge as (forward, up), rotated by the pitch.
  const f = pitch > 0 ? SKELETON.heel * scale : -SKELETON.toe * scale;
  const pz = z - f;
  const c = Math.cos(pitch);
  const s = Math.sin(pitch);
  out.z = pz + f * c - ay * s;
  out.y = f * s + ay * c;
  return out;
}

/** Ankle and foot pitch of a planted foot at stance progress t (0 touch-down .. 1 lift-off), relative to the point under its hip. */
export function stanceFoot(g: GaitCycle, t: number, scale: number, out: FootTarget): FootTarget {
  const d = g.half * (1 - 2 * t);
  let pitch = g.pitchMid;
  if (t < g.rockIn) pitch = lerp(g.pitchIn, g.pitchMid, smoothstep(0, g.rockIn, t));
  else if (t > g.rockOut) pitch = lerp(g.pitchMid, g.pitchOut, smoothstep(g.rockOut, 1, t));
  return ankleOnGround(g.mx * d, g.mz * d - g.back, pitch, scale, out);
}

const footTmp = makeFootTarget();

/** Highest the hip joint may be for the leg to reach a foot target with a slightly bent knee. */
function reachLimit(f: FootTarget, scale: number): number {
  const r = (SKELETON.thigh + SKELETON.shin) * scale * 0.995;
  const h2 = f.x * f.x + f.z * f.z;
  return f.y + Math.sqrt(Math.max(0, r * r - h2));
}

/**
 * Sets up the gait cycle for moving at `speed` along (mx, mz) (hip frame, unit) for a character of
 * height `scale`. The hip height curve is fitted to the planted feet: a walker's through the whole
 * stance (see fitWalk), a runner's low enough at every touch-down and lift-off that the leg reaches
 * the ground there.
 */
export function gaitCycle(speed: number, mx: number, mz: number, scale: number, out: GaitCycle): GaitCycle {
  const v = Number.isFinite(speed) ? clamp(speed, 0, 20) : 0;
  const ml = Math.hypot(mx, mz);
  out.mx = ml > 1e-6 ? mx / ml : 0;
  out.mz = ml > 1e-6 ? mz / ml : 1;
  out.speed = v;
  // Sideways steps have no heel-to-toe roll to lengthen the leg: shorter contacts (a side shuffle)
  // keep the hips from bobbing.
  const duty = dutyFactor(v) * (1 - 0.3 * Math.abs(out.mx) * smoothstep(1, 2.5, v));
  out.duty = duty;
  out.half = (duty * strideLength(v)) / 2;
  const fwd = Math.abs(out.mz);
  // From walking (0) to running (1) by speed: the walking foot placement below gives way to the runner's.
  const jog = smoothstep(2.8, 4.3, v);
  // Walkers land on the heel and push off the toes, rolling far up onto them before the foot leaves the
  // ground (WALK_TOE); runners land flatter and push off harder, fast ones on the ball of the foot.
  const heelRock = 0.26 * (1 - smoothstep(1.9, 4.3, v)) + 0.06;
  const fore = smoothstep(3.4, 6.3, v);
  const landing = lerp(heelRock, -0.28, fore);
  const flat = -0.18 * fore;
  const pushOff = -lerp(WALK_TOE, lerp(0.5, 0.62, smoothstep(1.45, 7.4, v)), jog);
  // Runners spend a shorter time on the foot: the heel comes up earlier in the stance, not faster.
  const heelUp = lerp(0.55, 0.3, smoothstep(1.9, 7.4, v));
  if (out.mz >= 0) {
    out.pitchIn = landing * fwd;
    out.pitchOut = pushOff * fwd;
    out.rockIn = ROCK_IN;
    out.rockOut = heelUp;
  } else {
    // Backpedalling is the same stance played backwards: land on the toes behind, the heel coming down,
    // and roll off the heel in front.
    out.pitchIn = pushOff * fwd;
    out.pitchOut = landing * fwd;
    out.rockIn = 1 - heelUp;
    out.rockOut = 1 - ROCK_IN;
  }
  out.pitchMid = flat * fwd;
  // The toe roll leaves more room behind than the heel in front, so the planted stretch is centred behind
  // the hip (for a walker by WALK_BACK of its half length, for a runner by 0.12).
  out.back = out.half * lerp(WALK_BACK, 0.12, jog) * fwd;
  out.run = smoothstep(0.53, 0.47, duty);
  out.lift = lerp(0.075, 0.24, smoothstep(1.45, 4.3, v)) * scale + 0.14 * smoothstep(4.3, 7.4, v) * scale;
  out.kick = smoothstep(2.8, 7.4, v);

  // Binding moments: touch-down (stance 0) and lift-off (stance 1).
  const margin = 0.006 * scale;
  const cIn = reachLimit(stanceFoot(out, 0, scale, footTmp), scale);
  const cOut = reachLimit(stanceFoot(out, 1, scale, footTmp), scale);
  const limit = Math.min(cIn, cOut) - margin;
  const top = SKELETON.hipY * scale;
  if (out.run < 1) fitWalk(out, scale, top, lerp(WALK_BOB, WALK_BOB_FAST, smoothstep(1.45, 2.8, v)) * scale);
  else {
    // A runner's hips follow the running curve alone.
    out.walkTop = top;
    out.walkDip = 0;
    out.walkLow = 0;
  }
  // Running: lowest at mid-stance (the knee loads), highest in flight.
  const kRun = (1 + Math.cos(TAU * duty)) / 2;
  out.runDip = lerp(0.03, 0.05, smoothstep(4.3, 7.4, v)) * scale;
  out.runTop = Math.min(top, limit + out.runDip * kRun);
  return out;
}

/**
 * Where a walker's planted stretch is centred, as a fraction of its half length behind the hip, and how far up onto
 * his toes he rolls before the foot leaves the ground (rad, 46 degrees). Both bring his feet in under him: the leading
 * foot lands nearer, the trailing one reaches further, so his hips need not sink far between his feet.
 */
const WALK_BACK = 0.22;
const WALK_TOE = 0.8;
/** A walker's hips rise and fall this much (m, height 1): 4.5 cm at an ordinary pace, 6 cm at a fast one (2.8 m/s). */
const WALK_BOB = 0.045;
const WALK_BOB_FAST = 0.06;
/** A walker's stance knee stays bent at least this much (rad, 8 degrees): it never locks straight. */
const WALK_KNEE = (8 * Math.PI) / 180;
/** Samples of a stance in the walk fit, plus the other foot's touch-down and lift-off. */
const WALK_SAMPLES = 16;
const walkRoom = new Float64Array(WALK_SAMPLES + 3);
const walkShape = new Float64Array(WALK_SAMPLES + 3);

/**
 * Fits the walking hip curve (gaitHipY) under the planted feet. It is a sine twice a cycle, lowest at walkLow: for a
 * forward walker at the touch-down, so the hips rise as the leg comes under them and the knee straightens through the
 * stance; backwards at the front foot's lift-off, the same moment played backwards; sideways in the middle of the
 * double support. Its top is as high as it can be, never above standing, with every planted leg still reaching its foot
 * with the knee bent at least WALK_KNEE at every moment of the stance, and the hips falling at most `bob` in between.
 */
function fitWalk(g: GaitCycle, scale: number, top: number, bob: number): void {
  const duty = g.duty;
  const uds = Math.max(0, (duty - 0.5) / 2);
  g.walkLow = uds * (1 - g.mz);
  const a = SKELETON.thigh * scale;
  const b = SKELETON.shin * scale;
  // The hip-to-ankle distance with the knee bent WALK_KNEE.
  const r2 = a * a + b * b + 2 * a * b * Math.cos(WALK_KNEE);
  // The left foot's stance, sampled evenly and at the right foot's lift-off and touch-down; the right
  // foot's stance is the same half a cycle on, and the curve repeats every half cycle.
  let n = 0;
  let wTop = top;
  for (let i = 0; i <= WALK_SAMPLES + 2; i++) {
    const u = i <= WALK_SAMPLES ? (i / WALK_SAMPLES) * duty : i === WALK_SAMPLES + 1 ? duty - 0.5 : 0.5;
    if (u < 0 || u > duty) continue;
    let rm = hipRoom(g, u / duty, scale, r2);
    if (u <= duty - 0.5) rm = Math.min(rm, hipRoom(g, (u + 0.5) / duty, scale, r2));
    if (u >= 0.5) rm = Math.min(rm, hipRoom(g, (u - 0.5) / duty, scale, r2));
    const sh = (1 + Math.cos(4 * Math.PI * (u - g.walkLow))) / 2;
    walkRoom[n] = rm;
    walkShape[n] = sh;
    n++;
    wTop = Math.min(wTop, rm + bob * sh);
  }
  // Below standing height the curve may not need its whole fall.
  let dip = 0;
  for (let i = 0; i < n; i++) if (walkShape[i]! > 1e-3) dip = Math.max(dip, (wTop - walkRoom[i]!) / walkShape[i]!);
  g.walkTop = wTop;
  g.walkDip = clamp(dip, 0, bob);
}

/** Highest the hip joint may be over a foot planted at stance progress t, for a hip-to-ankle distance of sqrt(r2). */
function hipRoom(g: GaitCycle, t: number, scale: number, r2: number): number {
  const f = stanceFoot(g, clamp(t, 0, 1), scale, footTmp);
  return f.y + Math.sqrt(Math.max(0, r2 - f.x * f.x - f.z * f.z));
}

/** Hip joint height at fraction u of the left foot's cycle (0 = left touch-down). */
export function gaitHipY(g: GaitCycle, u: number): number {
  const walk = g.walkTop - g.walkDip * (1 + Math.cos(4 * Math.PI * (u - g.walkLow))) / 2;
  if (g.run <= 0) return walk;
  const run = g.runTop - g.runDip * (1 + Math.cos(4 * Math.PI * (u - g.duty / 2))) / 2;
  return lerp(walk, run, g.run);
}

/** Forward lean of an upright torso moving at `speed` (along mz in the hip frame): 0.03 standing, 0.1 walking, 0.3 sprinting. */
export function gaitLean(speed: number, mz: number): number {
  return 0.03 + 0.07 * smoothstep(IDLE_SPEED, 1.45, speed) * mz + 0.2 * smoothstep(1.45, 7.4, speed) * Math.max(0, mz);
}

/** Chest yaw against the legs at gait phase `phase`: about 6 degrees each way at a walk, the right shoulder forward with the left foot. */
export function counterTwist(speed: number, mz: number, phase: number): number {
  return 0.1 * smoothstep(IDLE_SPEED, 1.5, speed) * Math.max(0, mz) * Math.cos(Number.isFinite(phase) ? phase : 0);
}

/** Fraction of the left foot's gait cycle (0..1) for a gait phase in radians. */
export function cycleFraction(phase: number): number {
  const u = (Number.isFinite(phase) ? phase : 0) / TAU;
  return u - Math.floor(u);
}

// ---------------------------------------------------------------------------
// Trunk

export interface Trunk {
  /** Hip joint height above the feet (c.pos.y). */
  y: number;
  /** World yaw of the hips (and legs), of the chest (turned right of the aim behind a long gun), and of the aim. */
  hipYaw: number;
  chestYaw: number;
  armYaw: number;
  /** Forward lean of the torso. */
  lean: number;
  /** Movement direction in the hip frame (x left, z forward), unit; (0, 1) when standing. */
  mx: number;
  mz: number;
  /** Weight of the gait, 0 standing .. 1 moving (on the ground). */
  move: number;
  /** The gait cycle the hips follow (valid when move > 0). */
  readonly cycle: GaitCycle;
}

export function makeTrunk(): Trunk {
  return { y: SKELETON.hipY, hipYaw: 0, chestYaw: 0, armYaw: 0, lean: 0, mx: 0, mz: 1, move: 0, cycle: makeGaitCycle() };
}

/** The chest turns to the aim; the hips follow once the twist would exceed this. */
const MAX_TWIST = 0.6;
/** A shouldered long gun or launcher turns the chest this far right of the aim, so the left hand reaches the forend. */
export const BLADE = 0.65;

/** Upright on its feet: the states the trunk, gait and weapon poses describe. */
export function upright(c: Character): boolean {
  return c.state === 'normal';
}

/** Arms up at the aim: a gun raised or fists up, whatever the reload is doing. */
export function aimed(c: Character): boolean {
  return c.aiming && upright(c);
}

/** Pose of the hips and chest of an upright character, from simulation state only. */
export function trunkPose(c: Character, out: Trunk = makeTrunk()): Trunk {
  const s = c.appearance.height;
  const heading = Number.isFinite(c.heading) ? c.heading : 0;
  const isAimed = aimed(c);
  const aimYaw = Number.isFinite(c.aimYaw) ? c.aimYaw : heading;
  let hipYaw = heading;
  if (isAimed) {
    const d = wrapAngle(aimYaw - heading);
    if (d > MAX_TWIST) hipYaw = wrapAngle(aimYaw - MAX_TWIST);
    else if (d < -MAX_TWIST) hipYaw = wrapAngle(aimYaw + MAX_TWIST);
  }
  out.hipYaw = hipYaw;
  const speed = Number.isFinite(c.speed) ? c.speed : 0;
  // Movement direction relative to the hips: sideways and backwards steps follow the actual velocity.
  const vx = Number.isFinite(c.vel.x) ? c.vel.x : 0;
  const vz = Number.isFinite(c.vel.z) ? c.vel.z : 0;
  const lx = vx * Math.cos(hipYaw) - vz * Math.sin(hipYaw);
  const lz = vx * Math.sin(hipYaw) + vz * Math.cos(hipYaw);
  const lm = Math.hypot(lx, lz);
  out.mx = lm > 0.05 ? lx / lm : 0;
  out.mz = lm > 0.05 ? lz / lm : 1;
  const grounded = c.onGround && upright(c);
  out.move = grounded ? smoothstep(IDLE_SPEED, 0.6, speed) : 0;
  const top = SKELETON.hipY * s;
  if (out.move > 0) {
    gaitCycle(speed, out.mx, out.mz, s, out.cycle);
    out.y = lerp(top, gaitHipY(out.cycle, cycleFraction(c.animPhase)), out.move);
  } else {
    out.y = top;
  }
  if (isAimed) {
    const pitch = Number.isFinite(c.aimPitch) ? c.aimPitch : 0;
    // A long gun or launcher keeps the bladed stance through its reloads, so the chest never snaps round.
    const w = c.inventory.current;
    const bladed = isGun(w) && w !== 'pistol';
    out.armYaw = aimYaw;
    out.chestYaw = bladed ? wrapAngle(aimYaw - BLADE) : aimYaw;
    // Lean into a low aim, back from a high one; into the gun when it is shouldered.
    out.lean = bladed && !reloadHeld(c) ? clamp(0.12 - 0.18 * pitch, -0.05, 0.25) : clamp(0.05 - 0.25 * pitch, -0.12, 0.2);
  } else {
    // Counter-rotation against the legs, and a forward lean that grows with speed.
    out.chestYaw = wrapAngle(hipYaw + out.move * counterTwist(speed, out.mz, c.animPhase));
    out.armYaw = out.chestYaw;
    out.lean = grounded ? gaitLean(speed, out.mz) : 0.1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weapons

type Gun = Exclude<WeaponId, 'fists'>;

export type { WeaponPoints };

/** The current guns' points, by gun (read from the specs when this module loads); weaponPointsOf also answers weapons added later. */
export const WEAPON_POINTS: { readonly [K in Gun]: WeaponPoints } = Object.fromEntries(
  Object.values(WEAPONS)
    .filter((w) => isGun(w.id))
    .map((w) => [w.id, weaponPointsOf(w.id)]),
) as { readonly [K in Gun]: WeaponPoints };

export type HoldMode = 'raised' | 'lowered' | 'reload';

export interface WeaponPose {
  weapon: Gun;
  mode: HoldMode;
  /** Right shoulder joint. */
  shoulder: V3;
  /** Centre of the trigger (right) hand. */
  hand: V3;
  /** Centre of the supporting (left) hand, also in the weapon's own frame; only meaningful when `twoHands`. */
  offHand: V3;
  offLocal: V3;
  twoHands: boolean;
  /** Barrel end: where shots leave from. */
  tip: V3;
  /** Unit barrel direction. */
  dir: V3;
  /** The weapon model's frame: origin and its +x (left) and +y (up) axes; `dir` is its +z. */
  origin: V3;
  left: V3;
  up: V3;
}

export function makeWeaponPose(): WeaponPose {
  const v = (): V3 => ({ x: 0, y: 0, z: 0 });
  return { weapon: 'pistol', mode: 'lowered', shoulder: v(), hand: v(), offHand: v(), offLocal: v(), twoHands: false, tip: v(), dir: v(), origin: v(), left: v(), up: v() };
}

const trunkTmp = makeTrunk();

function set(o: V3, x: number, y: number, z: number): V3 {
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
}

/** World point of weapon-local p in the frame (origin, left, up, dir). */
export function weaponPoint(w: WeaponPose, p: V3, out: V3): V3 {
  const o = w.origin;
  return set(
    out,
    o.x + w.left.x * p.x + w.up.x * p.y + w.dir.x * p.z,
    o.y + w.left.y * p.x + w.up.y * p.y + w.dir.y * p.z,
    o.z + w.left.z * p.x + w.up.z * p.y + w.dir.z * p.z,
  );
}

/** Points the weapon frame along (yaw, pitch), rolled by `roll` about the barrel (+ turns its underside to the left). */
export function aimFrame(w: WeaponPose, yaw: number, pitch: number, roll: number): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  set(w.dir, sy * cp, sp, cy * cp);
  const lx = cy;
  const lz = -sy;
  const ux = -sy * sp;
  const uy = cp;
  const uz = -cy * sp;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  set(w.left, lx * cr + ux * sr, uy * sr, lz * cr + uz * sr);
  set(w.up, -lx * sr + ux * cr, uy * cr, -lz * sr + uz * cr);
}

/** Places the weapon frame so that weapon-local point `p` lands on world point (x, y, z). */
export function anchor(w: WeaponPose, p: V3, x: number, y: number, z: number): void {
  set(
    w.origin,
    x - (w.left.x * p.x + w.up.x * p.y + w.dir.x * p.z),
    y - (w.left.y * p.x + w.up.y * p.y + w.dir.y * p.z),
    z - (w.left.z * p.x + w.up.z * p.y + w.dir.z * p.z),
  );
}

/** The gun in hand is being reloaded (combat cancels a reload when the weapon changes). */
export function reloading(c: Character): boolean {
  return c.reloadTimer > 0 && (c.reloadWeapon === null || c.reloadWeapon === c.inventory.current);
}

/**
 * The gun is held in for the reload: reloading, and no shot still leaving it. A clip's last round (every rocket) starts
 * the reload on the frame it is fired; it is drawn fired from the raised gun, where it left, and the gun comes in after.
 */
function reloadHeld(c: Character): boolean {
  return reloading(c) && !(c.shotTimer > 0);
}

/**
 * Where the gun in hand is held: raised to the aim (pistol in both hands, long guns in the shoulder,
 * rocket launcher on it), lowered while not aiming, or brought in for a reload. Recoil kick is drawn on
 * top of this and is not part of it. `trunk` may be passed when already computed for `c`.
 */
export function weaponPoseInto(c: Character, out: WeaponPose, trunk?: Trunk): WeaponPose {
  const weapon: Gun = isGun(c.inventory.current) ? (c.inventory.current as Gun) : 'pistol';
  const pts = weaponPointsOf(weapon);
  const t = trunk ?? trunkPose(c, trunkTmp);
  const s = c.appearance.height;
  const b = c.appearance.build;
  out.weapon = weapon;
  if (c.state === 'swimming') return swimmerGun(c, out, weapon, s, b);
  out.mode = reloadHeld(c) ? 'reload' : aimed(c) ? 'raised' : 'lowered';

  // Chest frame (world): yaw then forward lean.
  const cy = Math.cos(t.chestYaw);
  const sy = Math.sin(t.chestYaw);
  const cl = Math.cos(t.lean);
  const sl = Math.sin(t.lean);
  // left = (cy, 0, -sy); up = (sl*sy, cl, sl*cy); fwd = (cl*sy, -sl, cl*cy)
  const hx = c.pos.x;
  const hy = c.pos.y + t.y;
  const hz = c.pos.z;
  const sx = shoulderSpread(b);
  const shY = SKELETON.shoulderY * s;
  const sh = set(out.shoulder, hx - cy * sx + sl * sy * shY, hy + cl * shY, hz + sy * sx + sl * cy * shY);
  // Centre of the shoulder line and the chest-relative directions used below.
  const mx = hx + sl * sy * shY;
  const my = hy + cl * shY;
  const mz = hz + sl * cy * shY;

  const pitch = Number.isFinite(c.aimPitch) ? clamp(c.aimPitch, -1.4, 1.4) : 0;
  const yaw = t.armYaw;
  out.twoHands = weapon !== 'pistol' || out.mode !== 'lowered';
  if (weapon === 'rocket') {
    // The tube rests on the right shoulder: raised to the aim, tilted up when carried, dipped to reload.
    const p = out.mode === 'raised' ? pitch : out.mode === 'reload' ? -0.25 : 0.45;
    aimFrame(out, yaw, p, 0);
    // Contact point on top of the shoulder, the tube axis one radius above it, balanced a third of the
    // way from its rear so the trigger hand sits ahead of the shoulder.
    const top = 0.07 * s;
    const ax = sh.x + sl * sy * top + out.up.x * 0.09 + out.dir.x * 0.3;
    const ay = sh.y + cl * top + out.up.y * 0.09 + out.dir.y * 0.3;
    const az = sh.z + sl * cy * top + out.up.z * 0.09 + out.dir.z * 0.3;
    anchor(out, pts.stock, ax, ay, az);
    out.twoHands = out.mode !== 'lowered';
  } else if (out.mode === 'raised') {
    aimFrame(out, yaw, pitch, 0);
    if (weapon === 'pistol') {
      // Both arms out, the grip in front of the chest just right of centre, swinging with the aim about the shoulders.
      const reach = 0.47 * s;
      anchor(out, pts.grip, mx + out.dir.x * reach - out.left.x * 0.06 - out.up.x * 0.05, my + out.dir.y * reach - out.left.y * 0.06 - out.up.y * 0.05, mz + out.dir.z * reach - out.left.z * 0.06 - out.up.z * 0.05);
    } else {
      // Butt in the shoulder pocket, just inside and ahead of the joint.
      const ix = sh.x + cy * 0.1 + cl * sy * 0.05;
      const iy = sh.y - sl * 0.05 + 0.02;
      const iz = sh.z - sy * 0.1 + cl * cy * 0.05;
      anchor(out, pts.stock, ix, iy, iz);
    }
  } else if (out.mode === 'reload') {
    // Brought in front of the chest, muzzle dipped about half a radian and rolled to show the magazine.
    const base = aimed(c) ? pitch : 0;
    aimFrame(out, t.chestYaw + (weapon === 'pistol' ? 0.15 : 0.35), base - 0.5, 0.55);
    const reach = (weapon === 'pistol' ? 0.36 : 0.3) * s;
    const drop = (weapon === 'pistol' ? 0.12 : 0.2) * s;
    anchor(out, pts.grip, mx - cy * 0.08 + cl * sy * reach, my - drop - sl * reach, mz + sy * 0.08 + cl * cy * reach);
  } else if (weapon === 'pistol') {
    // Hanging at the right side, pointing at the ground ahead, swinging a little with the stride.
    aimFrame(out, yaw, -1.15, 0.15);
    const swing = 0.06 * t.move * Math.cos(Number.isFinite(c.animPhase) ? c.animPhase : 0) * s;
    const drop = (SKELETON.upperArm + SKELETON.forearm + SKELETON.hand) * 0.93 * s;
    const fwd = 0.1 * s + swing;
    anchor(out, pts.grip, sh.x - sl * sy * drop + cl * sy * fwd, sh.y - cl * drop - sl * fwd, sh.z - sl * cy * drop + cl * cy * fwd);
  } else {
    // Low ready: across the body, muzzle down and to the left, the grip by the right hip.
    aimFrame(out, yaw + 0.45, -0.6, 0.2);
    const gx = -0.15;
    const up = 0.18 * s;
    const fwd = 0.24 * s;
    anchor(out, pts.grip, hx + cy * gx + sl * sy * up + cl * sy * fwd, hy + cl * up - sl * fwd, hz - sy * gx + sl * cy * up + cl * cy * fwd);
  }
  weaponPoint(out, pts.tip, out.tip);
  weaponPoint(out, pts.grip, out.hand);
  const off = out.mode === 'reload' ? pts.reload : pts.fore;
  set(out.offLocal, off.x, off.y, off.z);
  if (out.twoHands) {
    // A short or broad-shouldered character's supporting hand slides back along the gun to within reach.
    const reach = 0.96 * (SKELETON.upperArm + SKELETON.forearm + SKELETON.hand) * s;
    const lx = hx + cy * sx + sl * sy * shY;
    const ly = hy + cl * shY;
    const lz = hz - sy * sx + sl * cy * shY;
    weaponPoint(out, off, out.offHand);
    const qx = out.offHand.x - lx;
    const qy = out.offHand.y - ly;
    const qz = out.offHand.z - lz;
    const q2 = qx * qx + qy * qy + qz * qz;
    if (q2 > reach * reach) {
      const qd = qx * out.dir.x + qy * out.dir.y + qz * out.dir.z;
      const disc = qd * qd - q2 + reach * reach;
      const back = disc >= 0 ? qd - Math.sqrt(disc) : qd;
      out.offLocal.z -= clamp(back, 0, Math.max(0, off.z - pts.grip.z - 0.08));
    }
  }
  weaponPoint(out, out.offLocal, out.offHand);
  return out;
}

/** The side of the car a seat is on: seats 0 and 2 on the left (local +x), 1 and 3 on the right. */
export function seatSide(seat: number): number {
  return seat === 0 || seat === 2 ? 1 : -1;
}

export { GUN_PORT };

/**
 * How far ahead of a vehicle's centre (m) its front or rear row of seats fires from: the side window beside the row
 * (VehicleSpec.firingRows, as a fraction of the length; [0, 0] for a kind without). A car's riders fire beside their
 * seats; its rear row sits here too (VehicleView seats it here, its heads under the roof's rear edge). The van's and the
 * riot van's side windows are in the cab, well forward of the centre; the riot van's crew in the back fire through its
 * gun ports. A bus's windows run its whole length.
 */
export function firingRow(kind: VehicleKind, length: number, rear: boolean): number {
  return firingRowsOf(kind)[rear ? 1 : 0] * length;
}

/**
 * Where a shot fired from seat `seat` of vehicle `v` leaves: out of that seat's own window (VehicleSpec.firingRows), 0.2 m outside
 * the body side at three quarters of the vehicle's height, pitched with the body (about its centre, half its height up,
 * as VehicleView draws it) on a slope or a ramp. This is the point CombatSystem.muzzle(c, true) fires from (the shooter's
 * own window by seat), and CrowdView draws the barrel end of a drive-by gun on it.
 */
export function windowMuzzle(v: Pick<Vehicle, 'pos' | 'heading' | 'pitch' | 'halfW' | 'spec'>, seat: number, out: V3): V3 {
  const across = seatSide(seat) * (v.halfW + 0.2);
  const along = firingRow(v.spec.kind, v.spec.length, seat >= 2);
  const centre = v.spec.height * 0.5;
  const up = v.spec.height * 0.75 - centre;
  const ch = Math.cos(v.heading);
  const sh = Math.sin(v.heading);
  const pitch = Number.isFinite(v.pitch) ? v.pitch : 0;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // Body axes, nose up for a positive pitch: left (ch, 0, -sh), up (-sh sp, cp, -ch sp), forward (sh cp, sp, ch cp).
  return set(
    out,
    v.pos.x + ch * across - sh * sp * up + sh * cp * along,
    v.pos.y + centre + cp * up + sp * along,
    v.pos.z - sh * across - ch * sp * up + ch * cp * along,
  );
}

/**
 * A swimmer treading water (hips SWIM_HIP up, leaning forward SWIM_TREAD_LEAN, facing his heading) holds the gun up out
 * of the water in his right hand, his arm reaching along the aim (never below SWIM_AIM_LOW): shots then leave above the
 * surface, from the gun CrowdView draws in his hand.
 */
function swimmerGun(c: Character, out: WeaponPose, weapon: Gun, s: number, b: number): WeaponPose {
  const pts = weaponPointsOf(weapon);
  const h = Number.isFinite(c.heading) ? c.heading : 0;
  const ch = Math.cos(h);
  const sh = Math.sin(h);
  const cl = Math.cos(SWIM_TREAD_LEAN);
  const sl = Math.sin(SWIM_TREAD_LEAN);
  // Right shoulder: (-spread, shoulder height, 0) in the body frame, leaned forward about x, turned by the heading.
  const lx = -shoulderSpread(b);
  const ly = SKELETON.shoulderY * s * cl;
  const lz = SKELETON.shoulderY * s * sl;
  const shoulder = set(out.shoulder, c.pos.x + lx * ch + lz * sh, c.pos.y + SWIM_HIP + ly, c.pos.z - lx * sh + lz * ch);
  out.mode = 'raised';
  out.twoHands = false;
  const yaw = c.aiming && Number.isFinite(c.aimYaw) ? c.aimYaw : h;
  const pitch = c.aiming && Number.isFinite(c.aimPitch) ? clamp(c.aimPitch, SWIM_AIM_LOW, 1.2) : 0;
  aimFrame(out, yaw, pitch, 0);
  const reach = 0.9 * (SKELETON.upperArm + SKELETON.forearm + SKELETON.hand) * s;
  anchor(out, pts.grip, shoulder.x + out.dir.x * reach, shoulder.y + out.dir.y * reach, shoulder.z + out.dir.z * reach);
  weaponPoint(out, pts.tip, out.tip);
  weaponPoint(out, pts.grip, out.hand);
  set(out.offLocal, pts.fore.x, pts.fore.y, pts.fore.z);
  weaponPoint(out, out.offLocal, out.offHand);
  return out;
}

/** Pose of the gun `c` holds (fists, melee weapons and throwables are treated as a pistol): see weaponPoseInto. */
export function weaponPose(c: Character): WeaponPose {
  return weaponPoseInto(c, makeWeaponPose());
}
