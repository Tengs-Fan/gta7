// Character skeleton, locomotion trunk and weapon-holding pose, shared by the simulation and the renderer.
//
// Pure math without three.js. CombatSystem.muzzle() returns weaponPose(c).tip and CrowdView draws the
// weapon and the arms holding it from the same pose, so the drawn barrel tip is exactly where bullets and
// rockets leave from. The trunk (hip height, hip and chest yaw, lean) carries the shoulders, so the gait
// cycle that sets the hip height lives here too; render/gait.ts builds the legs and swinging arms under it.
//
// Frames: a character's hip frame has its origin on the ground under the hips (c.pos), yaw `hipYaw`,
// +x to the character's left, +y up and +z forward. Lengths are for appearance.height 1 (a 1.8 m person)
// and scale with the height; the shoulder and hip spread scale with the build instead.

import { clamp, lerp, smoothstep, TAU, wrapAngle, type V3 } from '../core/math';
import type { Character } from './entities';
import type { WeaponId } from './specs';

export const SKELETON = {
  /** Hip joint height when standing. */
  hipY: 0.86,
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

/** Stance progress where the heel rocker (landing) ends. */
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
   * progress where the push-off starts. A pitched foot pivots on the edge that is on the ground.
   */
  pitchIn: number;
  pitchMid: number;
  pitchOut: number;
  rockOut: number;
  /** Swing foot lift (m) and how far it is kicked up behind the body (0 walk .. 1 sprint). */
  lift: number;
  kick: number;
  /** Hip height: walking (top - dip at double support) and running (top - dip at mid-stance), blended by `run`. */
  walkTop: number;
  walkDip: number;
  runTop: number;
  runDip: number;
  run: number;
}

export function makeGaitCycle(): GaitCycle {
  return { speed: 0, duty: 0.62, half: 0, mx: 0, mz: 1, back: 0, pitchIn: 0, pitchMid: 0, pitchOut: 0, rockOut: 0.55, lift: 0, kick: 0, walkTop: SKELETON.hipY, walkDip: 0, runTop: SKELETON.hipY, runDip: 0, run: 0 };
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
  if (t < ROCK_IN) pitch = lerp(g.pitchIn, g.pitchMid, smoothstep(0, ROCK_IN, t));
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
 * height `scale`. The hip height curve is fitted to the planted feet: low enough at every touch-down
 * and lift-off that the leg reaches the ground there.
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
  // Walkers land on the heel and push off the toes; runners land flatter and push off harder.
  const heelRock = 0.26 * (1 - smoothstep(1.9, 4.3, v)) + 0.06;
  const toeRock = lerp(0.5, 0.62, smoothstep(1.45, 7.4, v));
  // Runners spend a shorter time on the foot: the heel comes up earlier in the stance, not faster.
  out.rockOut = lerp(0.55, 0.3, smoothstep(1.9, 7.4, v));
  if (out.mz >= 0) {
    // Fast runners land on the ball of the foot and stay on it.
    const fore = smoothstep(3.4, 6.3, v);
    out.pitchIn = lerp(heelRock, -0.28, fore) * fwd;
    out.pitchMid = -0.18 * fore * fwd;
    out.pitchOut = -toeRock * fwd;
  } else {
    // Backpedalling: land on the toes behind, roll off the heel in front.
    out.pitchIn = -toeRock * fwd;
    out.pitchMid = 0;
    out.pitchOut = heelRock * fwd;
  }
  // The toe push-off leaves more room behind than the heel landing in front.
  out.back = out.half * 0.12 * fwd;
  out.run = smoothstep(0.53, 0.47, duty);
  out.lift = lerp(0.075, 0.24, smoothstep(1.45, 4.3, v)) * scale + 0.14 * smoothstep(4.3, 7.4, v) * scale;
  out.kick = smoothstep(2.8, 7.4, v);

  // Binding moments: touch-down (stance 0) and lift-off (stance 1).
  const margin = 0.006 * scale;
  const cIn = reachLimit(stanceFoot(out, 0, scale, footTmp), scale);
  const cOut = reachLimit(stanceFoot(out, 1, scale, footTmp), scale);
  const limit = Math.min(cIn, cOut) - margin;
  const top = SKELETON.hipY * scale;
  // Walking: lowest at the middle of the double support, highest at mid-stance (single support).
  const uds = Math.max(0, (duty - 0.5) / 2);
  const kWalk = (1 + Math.cos(4 * Math.PI * uds)) / 2;
  out.walkTop = top;
  out.walkDip = clamp((top - limit) / kWalk, 0, 0.22 * scale);
  // Running: lowest at mid-stance (the knee loads), highest in flight.
  const kRun = (1 + Math.cos(TAU * duty)) / 2;
  out.runDip = lerp(0.03, 0.05, smoothstep(4.3, 7.4, v)) * scale;
  out.runTop = Math.min(top, limit + out.runDip * kRun);
  return out;
}

/** Hip joint height at fraction u of the left foot's cycle (0 = left touch-down). */
export function gaitHipY(g: GaitCycle, u: number): number {
  const uds = Math.max(0, (g.duty - 0.5) / 2);
  const walk = g.walkTop - g.walkDip * (1 + Math.cos(4 * Math.PI * (u - uds))) / 2;
  if (g.run <= 0) return walk;
  const run = g.runTop - g.runDip * (1 + Math.cos(4 * Math.PI * (u - g.duty / 2))) / 2;
  return lerp(walk, run, g.run);
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
  /** World yaw of the hips (and legs), of the chest, and of the arms and weapon (the aim when aiming). */
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
    const w = c.inventory.current;
    const shouldered = w !== 'fists' && w !== 'pistol' && !reloading(c);
    out.armYaw = aimYaw;
    out.chestYaw = shouldered ? wrapAngle(aimYaw - BLADE) : aimYaw;
    // Lean into a low aim, back from a high one; into the gun when it is shouldered.
    out.lean = shouldered ? clamp(0.12 - 0.18 * pitch, -0.05, 0.25) : clamp(0.05 - 0.25 * pitch, -0.12, 0.2);
  } else {
    // ~6 degrees of counter-rotation against the legs, and a forward lean that grows with speed.
    const swing = 0.1 * out.move * smoothstep(0.3, 1.5, speed) * Math.max(0, out.mz);
    out.chestYaw = wrapAngle(hipYaw + swing * Math.cos(Number.isFinite(c.animPhase) ? c.animPhase : 0));
    out.armYaw = out.chestYaw;
    out.lean = grounded ? 0.03 + 0.07 * smoothstep(0.3, 1.45, speed) * out.mz + 0.2 * smoothstep(1.45, 7.4, speed) * Math.max(0, out.mz) : 0.1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weapons

type Gun = Exclude<WeaponId, 'fists'>;

/** Points on each weapon model (its own frame: +z along the barrel, +y up, +x left), in metres. */
export interface WeaponPoints {
  /** Barrel end, where shots leave from. */
  tip: V3;
  /** Centre of the trigger hand. */
  grip: V3;
  /** Centre of the supporting hand when aiming. */
  fore: V3;
  /** Butt end that sits in the shoulder (long guns) or rests on it (rocket launcher, the tube centre). */
  stock: V3;
  /** Where the off hand goes while reloading: the magazine, the shotgun's pump or the tube's rear. */
  reload: V3;
}

const P = (x: number, y: number, z: number): V3 => ({ x, y, z });

/** Kept in step with the weapon geometry in render/crowd.ts (barrel ends 0.21, 0.37, 0.75, 0.705, 0.775 m). */
export const WEAPON_POINTS: Readonly<Record<Gun, WeaponPoints>> = {
  pistol: { tip: P(0, 0, 0.21), grip: P(0, -0.065, 0.02), fore: P(0.03, -0.085, 0.005), stock: P(0, 0, -0.01), reload: P(0, -0.15, 0.02) },
  smg: { tip: P(0, 0, 0.37), grip: P(0, -0.1, 0.06), fore: P(0, -0.075, 0.25), stock: P(0, -0.01, -0.05), reload: P(0, -0.15, 0.2) },
  shotgun: { tip: P(0, 0, 0.75), grip: P(0, -0.07, 0.05), fore: P(0, -0.055, 0.31), stock: P(0, -0.04, -0.245), reload: P(0, -0.055, 0.3) },
  rifle: { tip: P(0, 0, 0.705), grip: P(0, -0.1, 0.06), fore: P(0, -0.065, 0.29), stock: P(0, -0.03, -0.25), reload: P(0, -0.2, 0.12) },
  rocket: { tip: P(0, 0.08, 0.775), grip: P(0, -0.075, 0.1), fore: P(0, -0.02, 0.32), stock: P(0, 0.08, 0.2), reload: P(0, 0.06, -0.36) },
};

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
function local(w: WeaponPose, p: V3, out: V3): V3 {
  const o = w.origin;
  return set(
    out,
    o.x + w.left.x * p.x + w.up.x * p.y + w.dir.x * p.z,
    o.y + w.left.y * p.x + w.up.y * p.y + w.dir.y * p.z,
    o.z + w.left.z * p.x + w.up.z * p.y + w.dir.z * p.z,
  );
}

/** Points the weapon frame along (yaw, pitch), rolled by `roll` about the barrel (+ turns its underside to the left). */
function aimFrame(w: WeaponPose, yaw: number, pitch: number, roll: number): void {
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
function anchor(w: WeaponPose, p: V3, x: number, y: number, z: number): void {
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
 * Where the gun in hand is held: raised to the aim (pistol in both hands, long guns in the shoulder,
 * rocket launcher on it), lowered while not aiming, or brought in for a reload. Recoil kick is drawn on
 * top of this and is not part of it. `trunk` may be passed when already computed for `c`.
 */
export function weaponPoseInto(c: Character, out: WeaponPose, trunk?: Trunk): WeaponPose {
  const weapon: Gun = c.inventory.current === 'fists' ? 'pistol' : c.inventory.current;
  const pts = WEAPON_POINTS[weapon];
  const t = trunk ?? trunkPose(c, trunkTmp);
  const s = c.appearance.height;
  const b = c.appearance.build;
  out.weapon = weapon;
  out.mode = reloading(c) ? 'reload' : aimed(c) ? 'raised' : 'lowered';

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
    aimFrame(out, yaw + (weapon === 'pistol' ? 0.15 : 0.35), base - 0.5, 0.55);
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
    const gx = -0.15 + 0.0 * b;
    const up = 0.18 * s;
    const fwd = 0.24 * s;
    anchor(out, pts.grip, hx + cy * gx + sl * sy * up + cl * sy * fwd, hy + cl * up - sl * fwd, hz - sy * gx + sl * cy * up + cl * cy * fwd);
  }
  local(out, pts.tip, out.tip);
  local(out, pts.grip, out.hand);
  const off = out.mode === 'reload' ? pts.reload : pts.fore;
  set(out.offLocal, off.x, off.y, off.z);
  if (out.twoHands) {
    // A short or broad-shouldered character's supporting hand slides back along the gun to within reach.
    const reach = 0.96 * (SKELETON.upperArm + SKELETON.forearm + SKELETON.hand) * s;
    const lx = hx + cy * sx + sl * sy * shY;
    const ly = hy + cl * shY;
    const lz = hz - sy * sx + sl * cy * shY;
    local(out, off, out.offHand);
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
  local(out, out.offLocal, out.offHand);
  return out;
}

/** Pose of the gun `c` holds (fists are treated as a pistol): see weaponPoseInto. */
export function weaponPose(c: Character): WeaponPose {
  return weaponPoseInto(c, makeWeaponPose());
}
