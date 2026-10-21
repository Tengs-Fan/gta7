// Third-person camera: over-the-shoulder on foot, chase cam in vehicles,
// orbit when wasted, slow flyover on the title screen. Collides with buildings.

import * as THREE from 'three';
import { rayAabb3 } from '../core/collision';
import { clamp, damp, dampAngle, smoothstep, wrapAngle, type V3 } from '../core/math';
import type { Vehicle } from '../sim/entities';
import type { Sim } from '../sim/sim';
import { isSolidForSight, makeRayHit, type StaticCollider } from '../world/colliders';
import { CURB_H, WATER_Y } from '../world/constants';
import type { StaticWorld } from '../world/staticWorld';
import { FOLIAGE_FADE_FAR, foliageKept, foliagePoints, foliageSpheres } from './props';

export type CameraMode = 'play' | 'title';

const hit = makeRayHit();

/** Shake and speed rumble are smooth noise: three sines per axis at these frequencies (Hz). */
const NOISE_HZ = [6.3, 9.7, 13.1] as const;
/** Impact kick: a damped spring (natural frequency rad/s, damping ratio) with a capped swing (m). */
const KICK_OMEGA = 18;
const KICK_ZETA = 0.5;
const KICK_MAX = 0.35;
/** Peak of the spring's first swing per m/s of kick speed (the swing peaks at a 60 degree phase). */
const KICK_PEAK = (() => {
  const wd = KICK_OMEGA * Math.sqrt(1 - KICK_ZETA * KICK_ZETA);
  const tp = Math.atan2(wd, KICK_ZETA * KICK_OMEGA) / wd;
  return (Math.exp(-KICK_ZETA * KICK_OMEGA * tp) * Math.sin(wd * tp)) / wd;
})();
/** On-foot boom as update() places it at rest: distance back (normal and far zoom), shoulder offset (m) and pitch after a reset. */
const FOOT_BOOM = 4.3;
const FOOT_BOOM_FAR = 6.6;
const FOOT_SHOULDER = 0.42;
const RESET_PITCH = -0.12;
/** Reset framing accepts only foliage outside the entire near-camera dissolve band. */
const KEPT_UNSEEN = 1;
/**
 * On foot the boom also stops in front of tree and palm trunks, except one hugging the player's back
 * (nearer than this to the look point): pulling the camera in there would put it in his head.
 */
const TRUNK_SKIP = 1.6;
/**
 * Hysteresis round TRUNK_SKIP. Going from one side of it to the other is a cut, so a trunk keeps last
 * frame's side until it is clearly past: one that hugged his back stops the boom only once its near
 * side is beyond HUG_RELEASE, and the one holding the boom back hugs only within HOLD_RELEASE, which
 * keeps the camera (never nearer than TRUNK_SKIP - 0.3) clear of its bark. Without it a trunk near the
 * threshold flipped the camera about 3 m back and forth on a pan of a few degrees.
 */
const HUG_RELEASE = TRUNK_SKIP + 0.25;
const HOLD_RELEASE = TRUNK_SKIP - 0.15;
/**
 * The wider HUG_RELEASE holds only while the view turns, and for this long (s) after: the flips it prevents come
 * from pans. A player who walks or stands without turning the view gets the plain TRUNK_SKIP cut, once, instead of a
 * trunk left between him and the camera for as long as he stands there.
 */
const HUG_HOLD = 0.4;
/**
 * Radius (m) of the camera's lens for the trunk stop: the boom stops where a sphere this big round the
 * camera would touch a trunk, so it is also caught by trunks it would only have grazed.
 */
const LENS = 0.5;
/**
 * A wall that cuts the on-foot boom shorter than CLOSE_BOOM (m from its root beside the head; a trunk never does, see
 * TRUNK_SKIP) lifts the camera by up to CLOSE_LIFT and slides it out over the shoulder by up to CLOSE_SIDE, in full
 * from CLOSE_FULL in, so it looks past his head instead of out of it. Whatever is still that close to the lens,
 * CrowdView dissolves (crowd.ts LENS_FADE_GONE), so the near plane never cuts him open.
 */
const CLOSE_BOOM = 1.3;
const CLOSE_FULL = 0.35;
const CLOSE_LIFT = 0.35;
const CLOSE_SIDE = 0.2;
/**
 * On foot a wall stops the boom 0.3 m short of it, but never nearer his head than 0.35 m, unless the wall itself is
 * nearer: then the camera stays this far (m) in front of it along the boom, on his side of it, where closeBoom can lift
 * it and slide it out. That holds while the wall is behind the view; where the view runs along it (its face inside the
 * frame's sides) the boom stops the full 0.3 m short of it, down to his head: a hair off its face, the wall showed as a
 * strip seen edge-on, the near plane cutting through it beside that.
 */
const WALL_SKIN = 0.02;
/**
 * The chase camera stays out of its own vehicle: within BODY_CLEAR (m) of the body's sides or ends it rises to
 * ROOF_CLEAR over the roof (easing in from BODY_BAND further out) and looks at the car from there. Further off than
 * that no part of the body comes nearer the lens than its near plane, whichever way the frustum's edges run.
 */
const BODY_CLEAR = 0.5;
const ROOF_CLEAR = 0.45;
const BODY_BAND = 0.6;
/**
 * On foot, raised ground (a quay over the sea, a deck, a stunt ramp: StaticWorld.groundHeight, which the camera's floor
 * follows but no collider marks) must not come between the camera and the player: the line from the camera to his head
 * clears it by SIGHT_MARGIN (m), checked every SIGHT_STEP along the ground. On land, or aiming, his boom stops short of
 * where it would not, TERRAIN_GAP in front, as at a wall. In the water (a swimmer, or someone wading and not aiming) he
 * is looked down on instead, over the quay or deck he has his back to: the camera rises by up to SIGHT_RISE over its
 * floor, the boom shortening as far as that needs (down to a view from right above him), and the view tilts down with
 * it to keep him where he was in the frame.
 */
const SIGHT_MARGIN = 0.1;
const SIGHT_STEP = 0.1;
const TERRAIN_GAP = 0.3;
const SIGHT_RISE = 3;
/** The sight line ends this far over the camera target: a walker's head centre, a swimmer's face. */
const SIGHT_HEAD = 0.15;
const SIGHT_HEAD_SWIM = 0.2;
/**
 * A swimmer's camera changes shoulders when the other one would see him with at least SIDE_SWAP m less of that rise
 * (swimming along a quay, the right one looks across its edge), and changes back once the gain is under SIDE_BACK; it
 * glides across at SIDE_RATE (1/s).
 */
const SIDE_SWAP = 0.5;
const SIDE_BACK = 0.1;
const SIDE_RATE = 5;
/**
 * In the water what that rule adds glides rather than jumps: how far the camera is drawn in along its boom and lifted
 * over it change by up to GLIDE_RATE (m/s), never leaving the camera lower or further out than the rule needs at that
 * moment, so he stays in sight whatever the view does (the boom itself, swung by the view, stopped by a wall or drawn in
 * to aim, does not glide). While the view turns it also heads for where the rule will want it GLIDE_LEAD (s) into the
 * turn (at most GLIDE_LEAD_MAX rad ahead). Close to a quay or a deck the height that keeps him in sight changes by
 * metres over a few degrees of yaw: taken frame by frame, a steady pan (1.5 degrees a frame) dropped or raised the
 * camera 1.8 m and turned the view 18 degrees from one frame to the next.
 */
const GLIDE_RATE = 12;
const GLIDE_LEAD = 0.35;
const GLIDE_LEAD_MAX = 1.1;
/** Short of GLIDE_RATE, the glide closes this fraction (1/s, exponentially) of the way still to go: small changes ease in. */
const GLIDE_EASE = 9;
/**
 * The view's tilt follows the glide at TILT_EASE (1/s, exponentially), never more than TILT_LAG (rad) behind, nor so far
 * that his head leaves the middle TILT_KEEP of the frame's height: the camera passing out over a quay's edge raises the
 * floor its tilt is measured from by a metre at once.
 */
const TILT_EASE = 10;
const TILT_LAG = 0.4;
const TILT_KEEP = 0.8;

const isTrunk = (c: StaticCollider) => c.tag === 'tree' || c.tag === 'palm';
const ZERO: V3 = { x: 0, y: 0, z: 0 };

/** The chase camera looks at a point this far up a vehicle (x its height). */
export const CHASE_TARGET_Y = 0.75;

/**
 * Where the chase camera settles relative to its look point (CHASE_TARGET_Y up the vehicle) for a vehicle of this
 * length and height: `back` m behind it along the view's heading, `up` m above it, looking down by -`pitch`. `k` sells
 * the speed (0 at rest .. 1 from 55 m/s: the boom drops and pulls back 18%), `far` is the far zoom and `orbitPitch`
 * the player's look up or down. VehicleView cuts its roofs back from this, so the player shows in his car.
 */
export function chaseOffset(
  spec: { readonly length: number; readonly height: number },
  k: number,
  far: boolean,
  orbitPitch = 0,
  out = { back: 0, up: 0, pitch: 0 },
): { back: number; up: number; pitch: number } {
  const dist = (5.2 + spec.length * 0.72) * (far ? 1.5 : 1) * (1 + 0.18 * k);
  const height = (1.3 + spec.height * 0.6) * (far ? 1.25 : 1) * (1 - 0.18 * k);
  out.pitch = -0.08 + orbitPitch;
  out.back = Math.cos(out.pitch) * dist;
  // The longer boom gives back some height through its pitch.
  out.up = height - Math.sin(out.pitch) * dist * 0.3;
  return out;
}

/** The foliage of a prop near a reset: its bounding spheres, to skip it cheaply, and points on its faces (see props.ts). */
interface Leaves {
  spheres: Array<{ x: number; y: number; z: number; r: number }>;
  points: number[];
}

/**
 * True when a camera at `cam` with this yaw and pitch, field of view and aspect sees no leaves
 * dissolving: no point of the foliage in its frame loses any of its fragments to the
 * dissolve (the camera inside a canopy fails too).
 */
function leavesClear(cam: V3, yaw: number, pitch: number, fovDeg: number, aspect: number, leaves: readonly Leaves[]): boolean {
  const f = { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
  const r = { x: -Math.cos(yaw), z: Math.sin(yaw) };
  // Up = right x forward (right has no y).
  const u = { x: -r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y };
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * aspect;
  for (const l of leaves) {
    let near = false;
    for (const s of l.spheres) {
      const d = Math.hypot(s.x - cam.x, s.y - cam.y, s.z - cam.z);
      // Inside a canopy's core (its insphere is over 0.79 of the radius): every way it looks is leaves.
      if (d < 0.79 * s.r) return false;
      if (d - s.r < FOLIAGE_FADE_FAR) near = true;
    }
    if (!near) continue;
    const p = l.points;
    for (let k = 0; k < p.length; k += 3) {
      const vx = p[k]! - cam.x;
      const vy = p[k + 1]! - cam.y;
      const vz = p[k + 2]! - cam.z;
      const z = vx * f.x + vy * f.y + vz * f.z;
      if (z <= 0 || foliageKept(Math.hypot(vx, vy, vz)) >= KEPT_UNSEEN) continue;
      if (Math.abs(vx * r.x + vz * r.z) < z * tanH && Math.abs(vx * u.x + vy * u.y + vz * u.z) < z * tanV) return false;
    }
  }
  return true;
}

/**
 * How far along the on-foot boom (from `from` along the unit vector `d`, `len` long) the lens first
 * touches a tree or palm trunk (`t`, Infinity for none; never under TRUNK_SKIP - 0.3, the old ray
 * stop's minimum) and which trunk that is. Trunks hugging his back (their near side within TRUNK_SKIP
 * along the boom) are ignored and go into `hugging`; with hysteresis (HUG_RELEASE, HOLD_RELEASE) for the
 * trunks that hugged last frame (`hugged`, while the view is `turning`: see HUG_HOLD) and the one holding
 * the boom back (`held`). Trunk colliders are vertical cylinders taller than the boom is high, so this is
 * the boom's track over the ground against each trunk's circle grown by LENS.
 */
function trunkStop(sim: Sim, from: V3, d: V3, len: number, hugged: ReadonlySet<number>, turning: boolean, held: number, hugging: Set<number>): { t: number; id: number } {
  const stop = { t: Infinity, id: -1 };
  const h2 = d.x * d.x + d.z * d.z;
  if (h2 < 1e-6) return stop;
  const ex = from.x + d.x * len;
  const ez = from.z + d.z * len;
  const pad = 1 + LENS;
  sim.world.grid.query(Math.min(from.x, ex) - pad, Math.min(from.z, ez) - pad, Math.max(from.x, ex) + pad, Math.max(from.z, ez) + pad, (c) => {
    if (!isTrunk(c) || !c.circle) return;
    const ox = from.x - c.cx;
    const oz = from.z - c.cz;
    const r = c.r + LENS;
    // |from + d t - centre| = r over the ground: h2 t^2 + 2 b t + q = 0; the entry is the smaller root.
    const b = ox * d.x + oz * d.z;
    const q = ox * ox + oz * oz - r * r;
    const disc = b * b - h2 * q;
    if (disc < 0) return;
    const sq = Math.sqrt(disc);
    if ((-b + sq) / h2 <= 0) return;
    const t = Math.max(TRUNK_SKIP - 0.3, (-b - sq) / h2);
    if (t >= len) return;
    const y = from.y + d.y * t;
    if (y < c.y0 - LENS || y > c.y1 + LENS) return;
    // Along the boom to where it passes the trunk's centre, less the trunk's own radius.
    const skip = hugged.has(c.id) && turning ? HUG_RELEASE : c.id === held ? HOLD_RELEASE : TRUNK_SKIP;
    if (-b / h2 - c.r <= skip) hugging.add(c.id);
    else if (t < stop.t) {
      stop.t = t;
      stop.id = c.id;
    }
  });
  return stop;
}

/** The lowest the camera may be over (x, z): above the ground, and above the sea, whose surface is invisible from below. */
function floorAt(world: StaticWorld, x: number, z: number): number {
  return Math.max(world.groundHeight(x, z), WATER_Y) + 0.35;
}

/** The highest the terrain reaches (curbs, decks, ramps; see StaticWorld.groundHeight) over the box x0..x1, z0..z1. */
function terrainTop(world: StaticWorld, x0: number, z0: number, x1: number, z1: number): number {
  let top = CURB_H;
  for (const d of world.layout.decks) {
    if (d.y > top && d.rect.minX <= x1 && d.rect.maxX >= x0 && d.rect.minZ <= z1 && d.rect.maxZ >= z0) top = d.y;
  }
  for (const r of world.layout.ramps) {
    const reach = Math.hypot(r.length, r.width) / 2;
    if (CURB_H + r.height > top && r.x + reach >= x0 && r.x - reach <= x1 && r.z + reach >= z0 && r.z - reach <= z1) top = CURB_H + r.height;
  }
  return top;
}

/**
 * The lowest camera height over (cx, cz) from which the line down to the head point (tx, ty, tz) clears the terrain
 * between them (ground, decks and ramps) by SIGHT_MARGIN; -Infinity when no terrain there comes near the line (`cy`,
 * the camera's height as it stands, tells). A step in the ground is located between two samples to the centimetre,
 * so the line is never let through the corner of an edge.
 */
function sightFloor(world: StaticWorld, tx: number, ty: number, tz: number, cx: number, cy: number, cz: number): number {
  if (Math.min(ty, cy) > terrainTop(world, Math.min(tx, cx), Math.min(tz, cz), Math.max(tx, cx), Math.max(tz, cz)) + SIGHT_MARGIN) return -Infinity;
  const ground = (s: number) => world.groundHeight(tx + (cx - tx) * s, tz + (cz - tz) * s) + SIGHT_MARGIN;
  const n = Math.max(1, Math.ceil(Math.hypot(cx - tx, cz - tz) / SIGHT_STEP));
  let need = -Infinity;
  let s0 = 0;
  let g0 = ground(0);
  for (let i = 1; i <= n; i++) {
    const s = i / n;
    const g = ground(s);
    let at = s;
    if (g > g0 + 0.05) {
      // The ground steps up between the two samples: find where, and hold the line over the edge itself.
      let lo = s0;
      let hi = s;
      const mid = (g0 + g) / 2;
      for (let k = 0; k < 10; k++) {
        const m = (lo + hi) / 2;
        if (ground(m) > mid) hi = m;
        else lo = m;
      }
      at = Math.max(1e-3, lo);
    }
    need = Math.max(need, ty + (g - ty) / at);
    s0 = s;
    g0 = g;
  }
  return need;
}

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  /** Horizontal view heading (same convention as entity headings). */
  yaw = 0;
  pitch = -0.12;
  sensitivity = 1;
  invertY = false;
  zoomLevel = 0;
  mode: CameraMode = 'title';
  private vehYaw = 0;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private lookIdle = 10;
  private readonly target = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly dir = new THREE.Vector3(0, 0, 1);
  private readonly chase = { back: 0, up: 0, pitch: 0 };
  private fov = 68;
  private dist = 4.4;
  private shakeAmt = 0;
  /** Seconds of play the shake / rumble noise has run (it stands still while paused). */
  private noiseT = 0;
  /** Random phase per axis and frequency, so the axes and every session move differently. */
  private readonly noisePhase = Array.from({ length: 18 }, () => Math.random() * Math.PI * 2);
  /** Speed rumble amplitude (m) for this frame. */
  private rumbleAmt = 0;
  /** Impact kick spring: offset (m) and its velocity (m/s). */
  private readonly kickPos = new THREE.Vector3();
  private readonly kickVel = new THREE.Vector3();
  /** Shake, rumble and kick added to the camera this frame (zero while paused). */
  private readonly offset = new THREE.Vector3();
  /** Boom length (m) the trunks behind the player allow (Infinity: none), eased in quickly and out slowly. */
  private trunkReach = Infinity;
  /** Trunks the boom ignored last frame and this one, for hugging the player's back (see trunkStop). */
  private hugging = new Set<number>();
  private huggingNow = new Set<number>();
  /** Set by reset() and on leaving a vehicle: the next on-foot frame has no earlier boom to glide from. */
  private freshBoom = true;
  /** The trunk the boom was last held back by (collider id, -1: none). */
  private heldBy = -1;
  /** The on-foot view's yaw and pitch last frame, and how long ago (s) it last turned (see HUG_HOLD). */
  private lastYaw = 0;
  private lastPitch = 0;
  private stillFor = Infinity;
  private titleT = 0;
  private deathT = 0;
  private wasInVehicle = false;
  private initialized = false;
  /**
   * What rayFor() rebuilds the on-foot view from: whether the last update() framed the player on foot,
   * its shoulder offset, how far along the boom the camera ended up (1 = not pulled in), how far it then rose
   * and slid right (a wall close behind him, an edge between him and the camera), how far the view tilted down to
   * keep a swimmer framed from up there, and the floor it was kept above.
   */
  private footView = false;
  private shoulder = 0.42;
  private boom = 1;
  private footLift = 0;
  private footSide = 0;
  private footTilt = 0;
  private floorY = -Infinity;
  /** The on-foot camera's shoulder: +1 his right, -1 his left (a swimmer's, see SIDE_SWAP), and where it is going. */
  private shoulderSide = 1;
  private sideTarget = 1;
  /** The point on the player the on-foot camera keeps in sight over raised ground (see SIGHT_HEAD), as the target moves. */
  private readonly head = new THREE.Vector3();
  /** Where the chase camera looks (a little ahead of and above its target). */
  private readonly chaseLook = new THREE.Vector3();
  private readonly bodyEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly bodyTurn = new THREE.Quaternion();
  private readonly scratch = new THREE.Vector3();
  private readonly vehicleRay = new THREE.Vector3();
  /** Come back out gently after a bus or van moves away, but never travel through it. */
  private vehicleBoom = Infinity;
  /** What closeBoom put on the on-foot camera beside its boom, while liftSight shortens that. */
  private readonly boomOff = new THREE.Vector3();
  /**
   * The camera in the water as it glides (see GLIDE_RATE): whether it is gliding, how far (m) it is in from the boom as
   * the walls leave it, how far (m) it is up from that boom's own height, and its view's tilt (rad).
   */
  private glideOn = false;
  private glideIn = 0;
  private glideUp = 0;
  private glideTilt = 0;
  /** How fast the on-foot view turns (rad/s, smoothed), for the glide's lead. */
  private yawRate = 0;
  /** liftSight's scratch: the boom a moment into the turn, and where the rule puts the camera now and there. */
  private readonly aheadFrom = new THREE.Vector3();
  private readonly aheadDir = new THREE.Vector3();
  private readonly spot = new THREE.Vector3();
  private readonly wantNow = { reach: 0, y: 0, moved: false };
  private readonly wantAhead = { reach: 0, y: 0, moved: false };
  baseFov = 68;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(68, aspect, 0.3, 2400);
    this.camera.position.set(0, 80, 200);
  }

  /** Mouse / stick look input in pixels (or equivalent). */
  look(dx: number, dy: number): void {
    const k = 0.0024 * this.sensitivity;
    const ky = (this.invertY ? -1 : 1) * k;
    if (this.wasInVehicle) {
      this.orbitYaw = wrapAngle(this.orbitYaw - dx * k);
      this.orbitPitch = clamp(this.orbitPitch - dy * ky, -0.5, 0.6);
    } else {
      this.yaw = wrapAngle(this.yaw - dx * k);
      // Steep enough to aim at the police helicopter orbiting overhead (about 1 rad up).
      this.pitch = clamp(this.pitch - dy * ky, -1.25, 1.35);
    }
    // Any look input counts: a gentle stick pan at a high frame rate is well under a pixel per frame.
    if (dx !== 0 || dy !== 0) this.lookIdle = 0;
  }

  addShake(amount: number): void {
    this.shakeAmt = Math.min(2, this.shakeAmt + amount);
  }

  /**
   * A jolt from a hit on the player's car: the camera swings towards the impact (dirX, dirZ point
   * from the car's centre to the contact) by up to min(0.35, strength / 60) m and springs back.
   * A hit with no horizontal direction (a landing) dips the camera instead.
   */
  addKick(dirX: number, dirZ: number, strength: number): void {
    if (!(strength > 0) || !Number.isFinite(strength)) return;
    const amp = Math.min(KICK_MAX, strength / 60);
    const len = Number.isFinite(dirX) && Number.isFinite(dirZ) ? Math.hypot(dirX, dirZ) : 0;
    const dir = len > 1e-3 ? new THREE.Vector3(dirX / len, 0, dirZ / len) : new THREE.Vector3(0, -1, 0);
    this.kickVel.addScaledVector(dir, amp / KICK_PEAK);
    // Kicks in quick succession never swing further than one full-strength kick.
    const maxVel = KICK_MAX / KICK_PEAK;
    if (this.kickVel.length() > maxVel) this.kickVel.setLength(maxVel);
  }

  /** Ray through the centre of the screen. */
  aimRay(): { origin: V3; dir: V3 } {
    return {
      origin: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      dir: { x: this.dir.x, y: this.dir.y, z: this.dir.z },
    };
  }

  /**
   * The crosshair ray for the current yaw and pitch, without waiting for update().
   * aimRay() still points where the last frame looked, so a look and a shot in the same frame would miss.
   * On foot the view is rebuilt the way update() frames it, from the current target and distance (no smoothing step),
   * pulled in along the boom, lifted, slid right and tilted as far as the last frame's collision did and kept above its
   * floor (no new raycast).
   * In a vehicle, while wasted and on the title screen it is aimRay().
   * It changes nothing.
   */
  rayFor(): { origin: V3; dir: V3 } {
    if (!this.footView) return this.aimRay();
    const cy = Math.cos(this.pitch);
    const dx = Math.sin(this.yaw) * cy;
    const dy = Math.sin(this.pitch);
    const dz = Math.cos(this.yaw) * cy;
    const rx = -Math.cos(this.yaw);
    const rz = Math.sin(this.yaw);
    const t = this.target;
    const s = this.shoulder;
    // lookFrom and the desired camera point of update()'s on-foot branch.
    const lx = t.x + rx * s * 0.5;
    const lz = t.z + rz * s * 0.5;
    const px = t.x - dx * this.dist + rx * s;
    const py = t.y - dy * this.dist + 0.18;
    const pz = t.z - dz * this.dist + rz * s;
    const k = this.boom;
    const side = this.footSide;
    const view = this.pitch + this.footTilt;
    const cv = Math.cos(view);
    return {
      origin: { x: lx + (px - lx) * k + rx * side, y: Math.max(t.y + (py - t.y) * k + this.footLift, this.floorY), z: lz + (pz - lz) * k + rz * side },
      dir: { x: Math.sin(this.yaw) * cv, y: Math.sin(view), z: Math.cos(this.yaw) * cv },
    };
  }

  update(dt: number, sim: Sim, aiming: boolean): void {
    this.lookIdle += dt;
    this.footView = false;
    this.footLift = 0;
    this.footSide = 0;
    this.footTilt = 0;
    if (this.mode === 'title') {
      this.updateTitle(dt);
      return;
    }
    const p = sim.player;
    const v = p.vehicle;
    const cam = this.camera;
    if (!this.initialized) {
      this.initialized = true;
      this.yaw = p.heading;
      this.target.set(p.pos.x, p.pos.y + 1.55, p.pos.z);
    }
    if (v && !this.wasInVehicle) {
      this.vehYaw = v.heading;
      this.orbitYaw = wrapAngle(this.yaw - v.heading);
      this.orbitPitch = 0;
      this.shoulderSide = 1;
      this.sideTarget = 1;
    } else if (!v && this.wasInVehicle) {
      this.yaw = wrapAngle(this.vehYaw + this.orbitYaw);
      this.pitch = RESET_PITCH;
      // The view jumps from the chase camera to the boom, so a trunk in the way is a cut, as after a reset.
      this.freshBoom = true;
    }
    this.wasInVehicle = !!v;

    let lookFrom: THREE.Vector3;
    let fovTarget = this.baseFov;
    let swimming = false;
    // In the water and not aiming: raised ground is looked over (liftSight) rather than stopping the boom.
    let lookOver = false;
    this.rumbleAmt = 0;
    if (sim.playerDown && sim.deathKind === 'wasted') {
      this.deathT += dt;
      const tx = p.pos.x;
      const tz = p.pos.z;
      this.target.lerp(new THREE.Vector3(tx, p.pos.y + 0.5, tz), 1 - Math.exp(-6 * dt));
      const a = this.yaw + this.deathT * 0.35;
      const r = 6 + this.deathT * 0.6;
      this.desired.set(tx - Math.sin(a) * r, p.pos.y + 3 + this.deathT * 0.8, tz - Math.cos(a) * r);
      lookFrom = this.target.clone();
      this.dir.copy(this.target).sub(this.desired).normalize();
    } else if (v) {
      this.deathT = 0;
      const speed = v.speed;
      let desiredYaw = v.heading;
      if (speed > 6 && v.forwardSpeed > 0) desiredYaw = Math.atan2(v.vel.x, v.vel.z);
      if (v.forwardSpeed < -4) desiredYaw = v.heading;
      // Lead into a turn, so the camera looks where the car is going instead of swinging wide.
      desiredYaw += clamp(0.25 * v.angVel, -0.25, 0.25);
      this.vehYaw = dampAngle(this.vehYaw, desiredYaw, v.airborne ? 1.5 : 4.2, dt);
      if (this.lookIdle > 1.4) {
        this.orbitYaw = dampAngle(this.orbitYaw, 0, 2.6, dt);
        this.orbitPitch = damp(this.orbitPitch, 0, 2.6, dt);
      }
      const yaw = this.vehYaw + this.orbitYaw;
      this.yaw = wrapAngle(yaw);
      const s = v.spec;
      // Selling the speed: from 15 m/s the camera drops and pulls back by up to 18% (see chaseOffset),
      // and the FOV (below) widens with the absolute speed rather than the fraction of each car's top speed.
      const k = smoothstep(15, 55, speed);
      const boom = chaseOffset(s, k, this.zoomLevel === 1, this.orbitPitch, this.chase);
      this.target.lerp(new THREE.Vector3(v.pos.x, v.pos.y + s.height * CHASE_TARGET_Y, v.pos.z), 1 - Math.exp(-18 * dt));
      this.desired.set(this.target.x - Math.sin(yaw) * boom.back, this.target.y + boom.up, this.target.z - Math.cos(yaw) * boom.back);
      this.chaseLook.set(this.target.x + Math.sin(yaw) * 3, this.target.y + 0.3, this.target.z + Math.cos(yaw) * 3);
      this.dir.copy(this.chaseLook).sub(this.desired).normalize();
      lookFrom = this.target.clone();
      fovTarget = this.baseFov + 15 * smoothstep(8, 58, speed);
      this.rumbleAmt = 0.03 * smoothstep(30, 60, speed);
      this.pitch = Math.asin(clamp(this.dir.y, -1, 1));
    } else {
      this.deathT = 0;
      swimming = p.state === 'swimming';
      // The camera cannot dip under the sea surface, so looking up from the water would lose the swimmer;
      // swimmers cannot aim either, so they keep the wider camera.
      if (swimming && this.pitch > 0.3) this.pitch = 0.3;
      const aim = aiming && !swimming;
      lookOver = !aim && (swimming || p.pos.y < WATER_Y);
      const lying = p.state === 'knocked' || p.state === 'dead';
      const headY = swimming ? 1.6 : lying ? 0.7 : 1.58 * p.appearance.height;
      this.target.lerp(new THREE.Vector3(p.pos.x, p.pos.y + headY, p.pos.z), 1 - Math.exp(-22 * dt));
      // `aiming` is the aim button (Character.aimZoom): hip fire keeps the wide view.
      const distTarget = aim ? 2.4 : this.zoomLevel === 1 ? 6.6 : 4.3;
      this.dist = damp(this.dist, distTarget, 10, dt);
      const cy = Math.cos(this.pitch);
      this.dir.set(Math.sin(this.yaw) * cy, Math.sin(this.pitch), Math.cos(this.yaw) * cy);
      const rx = -Math.cos(this.yaw);
      const rz = Math.sin(this.yaw);
      // (Eased like the framing: the sea takes a swimmer 0.4 m down in one frame as he lands in it.)
      this.head.set(this.target.x, this.target.y + (swimming ? SIGHT_HEAD_SWIM : SIGHT_HEAD), this.target.z);
      // Over his right shoulder; a swimmer's camera takes the left one where that sees him better (SIDE_SWAP).
      const across = aim ? 0.62 : 0.42;
      this.sideTarget = swimming ? this.openSide(sim, across, rx, rz) : 1;
      this.shoulderSide = damp(this.shoulderSide, this.sideTarget, SIDE_RATE, dt);
      const shoulder = across * this.shoulderSide;
      this.footView = true;
      this.shoulder = shoulder;
      // Right of the camera is (-cos yaw, sin yaw): shift the character to the left of the crosshair.
      this.desired.set(this.target.x - this.dir.x * this.dist + rx * shoulder, this.target.y - this.dir.y * this.dist + 0.18, this.target.z - this.dir.z * this.dist + rz * shoulder);
      lookFrom = new THREE.Vector3(this.target.x + rx * shoulder * 0.5, this.target.y, this.target.z + rz * shoulder * 0.5);
      fovTarget = aim ? this.baseFov - 16 : this.baseFov;
    }

    // Shake, speed rumble and impact kick, before the collision checks below so that none of them
    // pushes the camera into a wall. None while paused (dt = 0): nothing could decay behind the menu.
    this.offset.set(0, 0, 0);
    if (dt > 0) {
      this.noiseT += dt;
      this.stepKick(dt);
      this.offset.copy(this.kickPos);
      if (this.shakeAmt > 0.001) {
        const s = this.shakeAmt * 0.12;
        this.offset.x += this.noise(0) * s;
        this.offset.y += this.noise(1) * s;
        this.offset.z += this.noise(2) * s;
        this.shakeAmt *= Math.exp(-5 * dt);
      }
      if (this.rumbleAmt > 0) {
        const r = this.rumbleAmt;
        this.offset.x += this.noise(3) * r * 0.5;
        this.offset.y += this.noise(4) * r;
        this.offset.z += this.noise(5) * r * 0.5;
      }
      this.desired.add(this.offset);
    }

    // Keep the camera out of buildings, and on foot in front of tree trunks. A building wall stops the
    // boom at once; a trunk (thin, and swept across by every turn of the camera) pulls it in over a
    // few frames and lets it back out slowly, so the camera glides instead of popping.
    const d = this.desired.clone().sub(lookFrom);
    const len = d.length();
    const onFoot = !v && !(sim.playerDown && sim.deathKind === 'wasted');
    if (onFoot) {
      // How long the view has held still, for the trunk hysteresis (HUG_HOLD), and how fast it turns (GLIDE_LEAD; a cut,
      // such as the one leaving a car, is no turn).
      const turn = wrapAngle(this.yaw - this.lastYaw);
      const turned = Math.abs(turn) > 1e-5 || Math.abs(this.pitch - this.lastPitch) > 1e-5;
      this.stillFor = turned ? 0 : this.stillFor + dt;
      if (dt > 0) this.yawRate = Math.abs(turn) > 0.5 ? 0 : damp(this.yawRate, turn / dt, 20, dt);
      this.lastYaw = this.yaw;
      this.lastPitch = this.pitch;
    }
    let reach = len;
    if (len > 0.01) {
      d.divideScalar(len);
      if (sim.world.grid.raycast(lookFrom.x, lookFrom.y, lookFrom.z, d.x, d.y, d.z, len, hit, isSolidForSight)) {
        reach = Math.max(0.35, hit.t - 0.3);
        if (onFoot) {
          // Never into the wall: with his back to one and the view turned toward the camera's shoulder, the boom meets
          // it nearer than that, and from inside it closeBoom found no room to rise or slide (see WALL_SKIN).
          const facing = Math.abs(Math.sin(this.yaw) * hit.nx + Math.cos(this.yaw) * hit.nz);
          const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect);
          const along = smoothstep(Math.sin(Math.min(half + 0.15, 1.5)), Math.sin(Math.max(half - 0.1, 0)), facing);
          reach = Math.max(0, Math.min(reach, hit.t - (WALL_SKIN + (0.3 - WALL_SKIN) * along)));
        }
      }
      if (onFoot) {
        const vehicleStop = this.vehicleStop(sim, lookFrom, d, len);
        this.vehicleBoom = Math.min(vehicleStop, this.vehicleBoom + 6 * dt);
        reach = Math.min(reach, this.vehicleBoom);
        this.huggingNow.clear();
        const stop = trunkStop(sim, lookFrom, d, len, this.hugging, this.stillFor < HUG_HOLD, this.heldBy, this.huggingNow);
        const cur = Math.min(this.trunkReach, len);
        if (stop.t < cur) {
          // In from the boom's current length; but a trunk that hugged his back last frame has the camera
          // behind it, and gliding in front of it would drag the camera through it: that is a cut, as is
          // the first frame after a reset, which has no earlier boom to glide from.
          this.trunkReach = this.hugging.has(stop.id) || this.freshBoom ? stop.t : damp(cur, stop.t, 12, dt);
          this.heldBy = stop.id;
        } else if (this.huggingNow.has(this.heldBy)) {
          // The trunk the camera stood in front of now hugs his back (he backed up to it): easing out
          // would drag the camera back through it, so it cuts out behind it.
          this.trunkReach = stop.t;
          this.heldBy = -1;
        } else {
          // Out again at 6 m/s, after which no trunk holds it back.
          this.trunkReach = Math.min(stop.t, this.trunkReach + 6 * dt);
          if (this.trunkReach >= len) this.heldBy = -1;
        }
        [this.hugging, this.huggingNow] = [this.huggingNow, this.hugging];
        this.freshBoom = false;
        reach = Math.min(reach, this.trunkReach);
        // Raised ground between him and the camera stops the boom as a wall would (in the water: liftSight).
        if (!lookOver) {
          const seen = this.sightReach(sim.world, lookFrom, d, reach, 0, ZERO);
          if (seen < reach) reach = Math.max(0, seen - TERRAIN_GAP);
        }
      }
      if (reach < len) this.desired.copy(lookFrom).addScaledVector(d, reach);
    }
    this.boom = len > 0.01 ? Math.min(1, reach / len) : 1;
    if (!onFoot) {
      this.vehicleBoom = Infinity;
      this.trunkReach = Infinity;
      this.hugging.clear();
      this.heldBy = -1;
    }
    if (onFoot && len > 0.01) {
      this.closeBoom(sim, reach);
      if (lookOver) this.liftSight(sim.world, lookFrom, d, len, dt);
    } else if (v) {
      this.clearBody(sim, v);
    }
    // Out of the water (or aiming) the camera does not glide: the next time it does, it starts where the rule puts it.
    if (!(onFoot && len > 0.01 && lookOver)) this.glideOn = false;
    // Stay above the ground and above the sea, whose surface plane is invisible from below. The floor rises at once
    // but sinks over a moment (the camera passing off a deck or a quay out over the sea would drop 0.8 m in one
    // frame), unless the camera jumped anyway.
    const ground = floorAt(sim.world, this.desired.x, this.desired.z);
    const moved = Math.hypot(this.desired.x - cam.position.x, this.desired.z - cam.position.z);
    const floor = ground >= this.floorY || moved > 3 ? ground : damp(this.floorY, ground, 8, dt);
    if (this.desired.y < floor) this.desired.y = floor;
    this.floorY = floor;

    cam.position.copy(this.desired);
    this.fov = damp(this.fov, fovTarget, 6, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    cam.lookAt(cam.position.x + this.dir.x, cam.position.y + this.dir.y, cam.position.z + this.dir.z);
  }

  /**
   * A wall right behind the player (the on-foot boom cut to `reach` m, shorter than CLOSE_BOOM): the camera rises and
   * slides out over the shoulder it is on, as far as nothing solid comes within 0.3 m of the lens.
   */
  private closeBoom(sim: Sim, reach: number): void {
    const k = 1 - smoothstep(CLOSE_FULL, CLOSE_BOOM, reach);
    if (k <= 0) return;
    const p = this.desired;
    const grid = sim.world.grid;
    let lift = CLOSE_LIFT * k;
    if (grid.raycast(p.x, p.y, p.z, 0, 1, 0, lift + 0.3, hit, isSolidForSight)) lift = Math.max(0, hit.t - 0.3);
    p.y += lift;
    // Out to his right, or his left with a swimmer's camera over that shoulder (between the two while it changes).
    const out = this.shoulderSide;
    const ox = -Math.cos(this.yaw) * Math.sign(out);
    const oz = Math.sin(this.yaw) * Math.sign(out);
    let slide = CLOSE_SIDE * k * Math.abs(out);
    if (slide > 0 && grid.raycast(p.x, p.y, p.z, ox, 0, oz, slide + 0.3, hit, isSolidForSight)) slide = Math.max(0, hit.t - 0.3);
    p.x += ox * slide;
    p.z += oz * slide;
    this.footLift += lift;
    // (footSide is along his right.)
    this.footSide += slide * Math.sign(out);
  }

  /**
   * The longest boom, up to `reach` m from `from` along the unit vector `d` (and `off` beside it), whose camera point,
   * kept above its floor, needs at most `rise` m more height to see the player's head (this.head) over raised ground
   * (see sightFloor); 0 when not even the boom's root does. With no rise, the floor may not lift the camera above his
   * head either (onto a ramp's lip or a deck he stands below): it would look out over him.
   */
  private sightReach(world: StaticWorld, from: V3, d: V3, reach: number, rise: number, off: V3): number {
    const h = this.head;
    const q = this.scratch;
    const fits = (len: number): boolean => {
      q.set(from.x + d.x * len + off.x, from.y + d.y * len + off.y, from.z + d.z * len + off.z);
      const floor = floorAt(world, q.x, q.z);
      if (rise === 0 && floor > h.y) return false;
      const base = Math.max(q.y, floor);
      return sightFloor(world, h.x, h.y, h.z, q.x, base, q.z) - base <= rise;
    };
    if (fits(reach)) return reach;
    let lo = 0;
    let hi = reach;
    for (let k = 0; k < 12; k++) {
      const m = (lo + hi) / 2;
      if (fits(m)) lo = m;
      else hi = m;
    }
    return lo;
  }

  /**
   * Keeps the player in the water in view over raised ground (see SIGHT_RISE): the camera (this.desired, at this.boom of
   * the boom from `lookFrom` along the unit vector `d`, `len` long in full, plus what closeBoom added) rises as far as the
   * line down to his head needs, on a shorter boom where the one it has would need more than SIGHT_RISE, gliding there
   * (GLIDE_RATE) over the `dt` s of this frame, and the view tilts down with it, keeping him where he was in the frame.
   */
  private liftSight(world: StaticWorld, lookFrom: THREE.Vector3, d: THREE.Vector3, len: number, dt: number): void {
    const h = this.head;
    const p = this.desired;
    const gliding = this.glideOn;
    const y0 = Math.max(p.y, floorAt(world, p.x, p.z));
    const h0 = Math.hypot(p.x - h.x, p.z - h.z);
    // What closeBoom added stays with the camera as the boom shortens.
    const reach = this.boom * len;
    const off = this.boomOff.copy(p).sub(this.scratch.copy(lookFrom).addScaledVector(d, reach));
    const now = this.sightTarget(world, lookFrom, d, reach, off, this.wantNow);
    let wantReach = now.reach;
    let wantY = now.y;
    // Turning, it also heads for where it will be wanted a moment into the turn: the boom there as update() lays it out
    // (no wall stops it: one stops the boom at once when it is there). Not while a wall holds the boom in here: the
    // camera would rise right beside his head (a moored hull), turning the view by tens of degrees a frame.
    const lead = clamp(this.yawRate * GLIDE_LEAD, -GLIDE_LEAD_MAX, GLIDE_LEAD_MAX);
    if (Math.abs(lead) > 0.01 && reach > 0.98 * len) {
      const yaw = this.yaw + lead;
      const cp = Math.cos(this.pitch);
      const rx = -Math.cos(yaw);
      const rz = Math.sin(yaw);
      const t = this.target;
      const s = this.shoulder;
      const from = this.aheadFrom.set(t.x + rx * s * 0.5, t.y, t.z + rz * s * 0.5);
      const dir = this.aheadDir.set(t.x - Math.sin(yaw) * cp * this.dist + rx * s, t.y - Math.sin(this.pitch) * this.dist + 0.18, t.z - Math.cos(yaw) * cp * this.dist + rz * s).sub(from);
      const ahead = dir.length();
      if (ahead > 0.01) {
        // (Only where the rule moves it: the free boom there ends higher than one a wall holds in here.)
        const there = this.sightTarget(world, from, dir.divideScalar(ahead), ahead, ZERO, this.wantAhead);
        if (there.moved) {
          wantReach = Math.min(wantReach, (there.reach / ahead) * len);
          wantY = Math.max(wantY, there.y);
        }
      }
    }
    // Only what the rule adds glides: how far in from the boom and how far up from its height the camera is (the boom
    // itself, swung by the view, cut by a wall or drawn in to aim, does not). A step of the way still to go, each no
    // further than GLIDE_RATE allows; never further out than the rule allows now.
    // (As fast for the far boom, which has as much further to go.)
    const ease = 1 - Math.exp(-GLIDE_EASE * dt);
    const most = GLIDE_RATE * Math.max(1, this.dist / FOOT_BOOM) * dt;
    const step = (from: number, to: number) => (dt <= 0 ? from : Math.abs(to - from) < 1e-4 ? to : from + clamp((to - from) * ease, -most, most));
    this.glideIn = gliding ? step(this.glideIn, reach - wantReach) : reach - now.reach;
    const at = clamp(reach - this.glideIn, 0, now.reach);
    this.glideIn = reach - at;
    p.copy(lookFrom).addScaledVector(d, at).add(off);
    this.boom = at / len;
    this.glideUp = gliding ? step(this.glideUp, Math.max(0, wantY - p.y)) : Math.max(0, now.y - p.y);
    // Never lower than the line down to his head needs from there.
    const need = sightFloor(world, h.x, h.y, h.z, p.x, Math.max(p.y + this.glideUp, floorAt(world, p.x, p.z)), p.z);
    const lift = Math.max(this.glideUp, need - p.y);
    this.glideUp = lift > 0 ? this.headroom(world, p, lift) : 0;
    this.footLift += this.glideUp;
    p.y += this.glideUp;
    // (He is not aiming.) The view tilts down by as much as he now lies further below it (following it, see TILT_EASE).
    const y1 = Math.max(p.y, floorAt(world, p.x, p.z));
    const h1 = Math.hypot(p.x - h.x, p.z - h.z);
    const below = Math.atan2(h.y - y1, h1);
    const tilt = below - Math.atan2(h.y - y0, h0);
    this.glideTilt = gliding ? clamp(damp(this.glideTilt, tilt, TILT_EASE, dt), tilt - TILT_LAG, tilt + TILT_LAG) : tilt;
    // (Never easing him out of the frame: where the rule's own view keeps him in it.)
    const keep = (TILT_KEEP * THREE.MathUtils.degToRad(this.camera.fov)) / 2;
    const exact = this.pitch + tilt;
    this.glideTilt = clamp(this.pitch + this.glideTilt, Math.min(exact, below - keep), Math.max(exact, below + keep)) - this.pitch;
    this.glideOn = true;
    const view = clamp(this.pitch + this.glideTilt, -1.45, 1.4);
    this.footTilt = view - this.pitch;
    const cv = Math.cos(view);
    this.dir.set(Math.sin(this.yaw) * cv, Math.sin(view), Math.cos(this.yaw) * cv);
  }

  /**
   * Where liftSight's rule puts the camera for the boom from `from` along the unit vector `d`, `reach` long, plus `off`
   * beside it, written to `out`: the boom it shortens to (m, see sightReach), the height it rises to (m, before the
   * floor), which is the boom's own height where he is in sight from there as it stands, and whether it moved it at all.
   */
  private sightTarget(world: StaticWorld, from: V3, d: V3, reach: number, off: V3, out: { reach: number; y: number; moved: boolean }): { reach: number; y: number; moved: boolean } {
    const h = this.head;
    const q = this.spot.set(from.x + d.x * reach + off.x, from.y + d.y * reach + off.y, from.z + d.z * reach + off.z);
    out.reach = reach;
    out.y = q.y;
    out.moved = false;
    const y0 = Math.max(q.y, floorAt(world, q.x, q.z));
    if (sightFloor(world, h.x, h.y, h.z, q.x, y0, q.z) <= y0) return out;
    const fit = this.sightReach(world, from, d, reach, SIGHT_RISE, off);
    if (fit < reach) {
      q.set(from.x + d.x * fit + off.x, from.y + d.y * fit + off.y, from.z + d.z * fit + off.z);
      out.reach = fit;
      out.y = q.y;
      out.moved = true;
    }
    const base = Math.max(q.y, floorAt(world, q.x, q.z));
    const need = sightFloor(world, h.x, h.y, h.z, q.x, base, q.z);
    if (need > base) {
      out.y = q.y + this.headroom(world, q, need - q.y);
      out.moved = true;
    }
    return out;
  }

  /** How far (m, up to `lift`) the camera at `p` may rise before anything solid overhead (an eave, an upper storey reaching out) comes within 0.3 m of it. */
  private headroom(world: StaticWorld, p: V3, lift: number): number {
    return world.grid.raycast(p.x, p.y, p.z, 0, 1, 0, lift + 0.3, hit, isSolidForSight) ? Math.max(0, hit.t - 0.3) : lift;
  }

  /**
   * The shoulder (+1 right, -1 left) a swimmer's camera should go over, `across` m out from his head beside its boom
   * (whose right is (rx, rz)): the right one, unless raised ground beside him hides him from it so much more than from
   * the left one that the view from there needs less of the rise (SIDE_SWAP, SIDE_BACK).
   */
  private openSide(sim: Sim, across: number, rx: number, rz: number): number {
    const w = sim.world;
    const h = this.head;
    const t = this.target;
    const extra = (side: number): number => {
      const x = t.x - this.dir.x * this.dist + rx * across * side;
      const y = t.y - this.dir.y * this.dist + 0.18;
      const z = t.z - this.dir.z * this.dist + rz * across * side;
      const base = Math.max(y, floorAt(w, x, z));
      return Math.max(0, sightFloor(w, h.x, h.y, h.z, x, base, z) - base);
    };
    const gain = extra(1) - extra(-1);
    if (this.sideTarget > 0) return gain > SIDE_SWAP ? -1 : 1;
    return gain < SIDE_BACK ? 1 : -1;
  }

  /**
   * Keeps the chase camera out of its own vehicle `v`: near its body (see BODY_CLEAR) the camera rises over the roof,
   * as far as a ceiling lets it, and looks at the car from there. The body frame is the vehicle's as drawn: turned,
   * pitched and rolled about the middle of its height.
   */
  private clearBody(sim: Sim, v: Vehicle): void {
    const p = this.desired;
    const h = v.spec.height;
    const turn = this.bodyTurn.setFromEuler(this.bodyEuler.set(-v.pitch, v.heading, v.roll, 'YXZ')).invert();
    // A world rise lifts the camera this much in the body frame: no help on a car tipped far over (it is upright again
    // or he is out of it within moments).
    const up = this.scratch.set(0, 1, 0).applyQuaternion(turn).y;
    if (!(up > 0.5)) return;
    const local = this.scratch.set(p.x - v.pos.x, p.y - v.pos.y - h / 2, p.z - v.pos.z).applyQuaternion(turn);
    const out = Math.hypot(Math.max(0, Math.abs(local.x) - v.halfW), Math.max(0, Math.abs(local.z) - v.halfL));
    const near = 1 - smoothstep(BODY_CLEAR, BODY_CLEAR + BODY_BAND, out);
    let lift = (near * Math.max(0, h / 2 + ROOF_CLEAR - local.y)) / up;
    if (!(lift > 1e-4)) return;
    if (sim.world.grid.raycast(p.x, p.y, p.z, 0, 1, 0, lift + 0.3, hit, isSolidForSight)) lift = Math.max(0, hit.t - 0.3);
    p.y += lift;
    this.dir.copy(this.chaseLook).sub(p).normalize();
    this.pitch = Math.asin(clamp(this.dir.y, -1, 1));
  }

  /** The lens stays on the player's side of nearby vehicles, including tilted wrecks. */
  private vehicleStop(sim: Sim, from: THREE.Vector3, dir: THREE.Vector3, length: number): number {
    let reach = length;
    const pad = 0.16;
    for (const v of sim.vehicles) {
      if (v.removed) continue;
      const h = v.spec.height / 2;
      const radius = Math.hypot(v.halfW, v.halfL, h);
      if (Math.hypot(v.pos.x - from.x, v.pos.y + h - from.y, v.pos.z - from.z) > reach + radius + pad) continue;
      const turn = this.bodyTurn.setFromEuler(this.bodyEuler.set(-v.pitch, v.heading, v.roll, 'YXZ')).invert();
      const local = this.scratch.set(from.x - v.pos.x, from.y - v.pos.y - h, from.z - v.pos.z).applyQuaternion(turn);
      const ray = this.vehicleRay.copy(dir).applyQuaternion(turn);
      const t = rayAabb3(local.x, local.y, local.z, ray.x, ray.y, ray.z,
        -v.halfW - pad, -h - pad, -v.halfL - pad, v.halfW + pad, h + pad, v.halfL + pad, reach);
      if (t >= 0) reach = Math.max(0, t - 0.08);
    }
    return reach;
  }

  private updateTitle(dt: number): void {
    this.titleT += dt;
    const a = this.titleT * 0.045 + 0.6;
    const r = 260;
    const cam = this.camera;
    cam.position.set(Math.cos(a) * r, 95 + Math.sin(this.titleT * 0.1) * 12, Math.sin(a) * r);
    const look = new THREE.Vector3(0, 30, 0);
    this.dir.copy(look).sub(cam.position).normalize();
    cam.lookAt(look);
    if (cam.fov !== 55) {
      cam.fov = 55;
      cam.updateProjectionMatrix();
    }
  }

  /** Smooth noise in [-1, 1] for one axis: three sines with that axis's random phases. */
  private noise(axis: number): number {
    const t = this.noiseT * Math.PI * 2;
    let n = 0;
    for (let i = 0; i < 3; i++) n += Math.sin(t * NOISE_HZ[i]! + this.noisePhase[axis * 3 + i]!);
    return n / 3;
  }

  /** Advances the kick spring by dt, in short sub-steps: the stiff spring would blow up at 10 fps. */
  private stepKick(dt: number): void {
    const p = this.kickPos;
    const v = this.kickVel;
    if (p.lengthSq() < 1e-10 && v.lengthSq() < 1e-8) {
      p.set(0, 0, 0);
      v.set(0, 0, 0);
      return;
    }
    const n = Math.ceil(dt * 240);
    const h = dt / n;
    const w2 = KICK_OMEGA * KICK_OMEGA;
    const c = 2 * KICK_ZETA * KICK_OMEGA;
    for (let i = 0; i < n; i++) {
      v.x += (-w2 * p.x - c * v.x) * h;
      v.y += (-w2 * p.y - c * v.y) * h;
      v.z += (-w2 * p.z - c * v.z) * h;
      p.addScaledVector(v, h);
    }
  }

  /**
   * Yaw for an on-foot reset: the player's heading, or the nearest yaw to it (in 5 degree steps, up to
   * a half turn) whose camera point keeps 2.6 x scale m from every street tree and palm trunk, so the
   * camera does not start inside a canopy (the first New Game frame was a third leaves), and shows no
   * leaves dissolving (see leavesClear). Where no yaw does both, the nearest one clear of the trunks;
   * then the heading.
   */
  private clearYaw(sim: Sim): number {
    const p = sim.player;
    const boom = this.zoomLevel === 1 ? FOOT_BOOM_FAR : FOOT_BOOM;
    const props = sim.world.layout.props.filter((q) => (q.kind === 'tree' || q.kind === 'palm' || q.kind === 'bush') && Math.hypot(q.x - p.pos.x, q.z - p.pos.z) < boom + 8);
    if (props.length === 0) return p.heading;
    const trunks = props.filter((q) => q.kind !== 'bush');
    const leaves = props.filter((q) => q.kind !== 'palm').map((q) => ({ spheres: foliageSpheres(q), points: foliagePoints(q) }));
    // The camera point update() settles at: behind the head and up the pitched boom, over the right shoulder.
    const back = boom * Math.cos(RESET_PITCH);
    const cam = { x: 0, y: p.pos.y + 1.58 * p.appearance.height - Math.sin(RESET_PITCH) * boom + 0.18, z: 0 };
    let trunksOnly: number | null = null;
    for (let k = 0; k <= 72; k++) {
      // 0, +5, -5, +10, ... degrees, ending with the half turn.
      const yaw = p.heading + (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 36);
      cam.x = p.pos.x - Math.sin(yaw) * back - Math.cos(yaw) * FOOT_SHOULDER;
      cam.z = p.pos.z - Math.cos(yaw) * back + Math.sin(yaw) * FOOT_SHOULDER;
      if (!trunks.every((q) => Math.hypot(q.x - cam.x, q.z - cam.z) >= 2.6 * q.scale)) continue;
      // The view eases to the base FOV from wherever it was (wider after a fast drive).
      if (leavesClear(cam, yaw, RESET_PITCH, Math.max(this.baseFov, this.fov), this.camera.aspect, leaves)) return wrapAngle(yaw);
      trunksOnly ??= wrapAngle(yaw);
    }
    return trunksOnly ?? p.heading;
  }

  /** Snap behind the player (after respawn / teleport). */
  reset(sim: Sim): void {
    const p = sim.player;
    this.yaw = p.vehicle ? p.vehicle.heading : this.clearYaw(sim);
    this.vehYaw = this.yaw;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.pitch = RESET_PITCH;
    this.shakeAmt = 0;
    this.rumbleAmt = 0;
    this.kickPos.set(0, 0, 0);
    this.kickVel.set(0, 0, 0);
    this.offset.set(0, 0, 0);
    this.trunkReach = Infinity;
    this.hugging.clear();
    this.heldBy = -1;
    this.freshBoom = true;
    this.lastYaw = this.yaw;
    this.lastPitch = this.pitch;
    this.stillFor = Infinity;
    this.floorY = -Infinity;
    this.vehicleBoom = Infinity;
    this.shoulderSide = 1;
    this.sideTarget = 1;
    this.glideOn = false;
    this.yawRate = 0;
    const pos = sim.playerPos();
    this.target.set(pos.x, pos.y + 1.5, pos.z);
    this.wasInVehicle = !!p.vehicle;
    this.initialized = true;
  }
}
