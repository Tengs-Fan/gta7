// Third-person camera: over-the-shoulder on foot, chase cam in vehicles,
// orbit when wasted, slow flyover on the title screen. Collides with buildings.

import * as THREE from 'three';
import { clamp, damp, dampAngle, smoothstep, wrapAngle, type V3 } from '../core/math';
import type { Sim } from '../sim/sim';
import { isSolidForSight, makeRayHit, type StaticCollider } from '../world/colliders';
import { WATER_Y } from '../world/constants';
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
/** Leaves the dissolve keeps more of than this show no screen-door pattern worth the name. */
const KEPT_UNSEEN = 0.9;
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
 * Radius (m) of the camera's lens for the trunk stop: the boom stops where a sphere this big round the
 * camera would touch a trunk, so it is also caught by trunks it would only have grazed.
 */
const LENS = 0.5;

const isTrunk = (c: StaticCollider) => c.tag === 'tree' || c.tag === 'palm';

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
 * dissolving: no point of the foliage in its frame loses a tenth or more of its fragments to the
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
 * trunks that hugged last frame (`hugged`) and the one holding the boom back (`held`). Trunk colliders are
 * vertical cylinders taller than the boom is high, so this is the boom's track over the ground against
 * each trunk's circle grown by LENS.
 */
function trunkStop(sim: Sim, from: V3, d: V3, len: number, hugged: ReadonlySet<number>, held: number, hugging: Set<number>): { t: number; id: number } {
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
    const skip = hugged.has(c.id) ? HUG_RELEASE : c.id === held ? HOLD_RELEASE : TRUNK_SKIP;
    if (-b / h2 - c.r <= skip) hugging.add(c.id);
    else if (t < stop.t) {
      stop.t = t;
      stop.id = c.id;
    }
  });
  return stop;
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
  private titleT = 0;
  private deathT = 0;
  private wasInVehicle = false;
  private initialized = false;
  /**
   * What rayFor() rebuilds the on-foot view from: whether the last update() framed the player on foot,
   * its shoulder offset, how far along the boom the camera ended up (1 = not pulled in) and the floor it was kept above.
   */
  private footView = false;
  private shoulder = 0.42;
  private boom = 1;
  private floorY = -Infinity;
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
   * pulled in along the boom as far as the last frame's collision did and kept above its floor (no new raycast).
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
    return {
      origin: { x: lx + (px - lx) * k, y: Math.max(t.y + (py - t.y) * k, this.floorY), z: lz + (pz - lz) * k },
      dir: { x: dx, y: dy, z: dz },
    };
  }

  update(dt: number, sim: Sim, aiming: boolean): void {
    this.lookIdle += dt;
    this.footView = false;
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
    } else if (!v && this.wasInVehicle) {
      this.yaw = wrapAngle(this.vehYaw + this.orbitYaw);
      this.pitch = RESET_PITCH;
      // The view jumps from the chase camera to the boom, so a trunk in the way is a cut, as after a reset.
      this.freshBoom = true;
    }
    this.wasInVehicle = !!v;

    let lookFrom: THREE.Vector3;
    let fovTarget = this.baseFov;
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
      const look = new THREE.Vector3(this.target.x + Math.sin(yaw) * 3, this.target.y + 0.3, this.target.z + Math.cos(yaw) * 3);
      this.dir.copy(look).sub(this.desired).normalize();
      lookFrom = this.target.clone();
      fovTarget = this.baseFov + 15 * smoothstep(8, 58, speed);
      this.rumbleAmt = 0.03 * smoothstep(30, 60, speed);
      this.pitch = Math.asin(clamp(this.dir.y, -1, 1));
    } else {
      this.deathT = 0;
      const swimming = p.state === 'swimming';
      // The camera cannot dip under the sea surface, so looking up from the water would lose the swimmer;
      // swimmers cannot aim either, so they keep the wider camera.
      if (swimming && this.pitch > 0.3) this.pitch = 0.3;
      const aim = aiming && !swimming;
      const lying = p.state === 'knocked' || p.state === 'dead';
      const headY = swimming ? 1.6 : lying ? 0.7 : 1.58 * p.appearance.height;
      this.target.lerp(new THREE.Vector3(p.pos.x, p.pos.y + headY, p.pos.z), 1 - Math.exp(-22 * dt));
      // `aiming` is the aim button (Character.aimZoom): hip fire keeps the wide view.
      const distTarget = aim ? 2.4 : this.zoomLevel === 1 ? 6.6 : 4.3;
      this.dist = damp(this.dist, distTarget, 10, dt);
      const shoulder = aim ? 0.62 : 0.42;
      this.footView = true;
      this.shoulder = shoulder;
      const cy = Math.cos(this.pitch);
      this.dir.set(Math.sin(this.yaw) * cy, Math.sin(this.pitch), Math.cos(this.yaw) * cy);
      const rx = -Math.cos(this.yaw);
      const rz = Math.sin(this.yaw);
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
    if (len > 0.01) {
      d.divideScalar(len);
      let reach = len;
      if (sim.world.grid.raycast(lookFrom.x, lookFrom.y, lookFrom.z, d.x, d.y, d.z, len, hit, isSolidForSight)) reach = Math.max(0.35, hit.t - 0.3);
      if (onFoot) {
        this.huggingNow.clear();
        const stop = trunkStop(sim, lookFrom, d, len, this.hugging, this.heldBy, this.huggingNow);
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
      }
      if (reach < len) this.desired.copy(lookFrom).addScaledVector(d, reach);
    }
    this.boom = len > 0.01 ? Math.min(1, this.desired.distanceTo(lookFrom) / len) : 1;
    if (!onFoot) {
      this.trunkReach = Infinity;
      this.hugging.clear();
      this.heldBy = -1;
    }
    // Stay above the ground and above the sea, whose surface plane is invisible from below.
    const floor = Math.max(sim.world.groundHeight(this.desired.x, this.desired.z), WATER_Y) + 0.35;
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
    const pos = sim.playerPos();
    this.target.set(pos.x, pos.y + 1.5, pos.z);
    this.wasInVehicle = !!p.vehicle;
    this.initialized = true;
  }
}
