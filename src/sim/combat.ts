// Weapons, damage, deaths, burning vehicles, explosions and rockets.

import { rayCylinderY, rayObb3, type OBB } from '../core/collision';
import { clamp, type V3 } from '../core/math';
import { isSolidForSight, makeRayHit, type RayHit } from '../world/colliders';
import { makeBrain } from './brains';
import type { Character, Vehicle } from './entities';
import { Projectile } from './entities';
import type { HitKind } from './events';
import type { PlayerInput } from './input';
import type { Sim } from './sim';
import { WEAPONS, type WeaponSpec } from './specs';
import { launchVehicle, vehicleObb } from './vehiclePhysics';
import type { CrimeType } from './wanted';

export type DamageKind = 'bullet' | 'melee' | 'explosion' | 'vehicle' | 'fall' | 'fire' | 'impact' | 'drown';
/** Where a hit landed: standing characters have a head volume above the body; everyone else is all body. */
export type HitZone = 'head' | 'body';

const hit = makeRayHit();
/** Scratch hit of the muzzle wall check (muzzleWall); read by the trigger pull that asked. */
const wallHit = makeRayHit();
const obb: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };
/** Seconds before a weapon just switched to can fire. */
const SWAP_TIME = 0.25;
/** An assault on one victim is reported at most once per this many seconds: just under the pistol's 0.25 s cadence. */
const ASSAULT_GAP = 0.24;
/** Most of a fire cooldown's overshoot (s) that counts towards the next shot, so the rate holds at any frame rate. */
const MAX_CARRY = 0.05;
/** A semi-automatic trigger press this close (s) to the weapon being ready is queued, and kept that long. */
const QUEUE_WINDOW = 0.1;
/** Head hits of NPC shooters (the player's use WeaponSpec.headMul). */
const NPC_HEAD_MUL = 2;
/** SWAT helmets: their head hits take this share of the multiplier (never less than a body hit). */
const HELMET = 0.6;
/** The muzzle wall check starts from the chest, this share of the shooter's height up. */
const CHEST = 0.75;
/** Standing characters: body cylinder up to NECK of the height, head cylinder from there to the top. */
const BODY_R = 0.36;
const HEAD_R = 0.16;
const NECK = 0.86;
/** Rocket launch speed (m/s); a rocket self-destructs once it has flown the launcher's range. */
const ROCKET_SPEED = 58;
const ROCKET_LIFE = WEAPONS.rocket.range / ROCKET_SPEED;
const ROCKET_BLAST = 8;
/** A rocket cannot hit its owner for this long after launch (s). */
const ROCKET_ARMING = 0.15;
/** Heights above a character's feet that a blast must see to hurt him fully. */
const EXPOSURE_HEIGHTS = [0.3, 1.0, 1.6] as const;

/** The upright cylinder a character occupies as a whole (shared scratch object). */
const body = { r: 0, y0: 0, y1: 0 };
function bodyOf(c: Character): typeof body {
  const lying = c.state === 'dead' || c.state === 'knocked';
  body.r = lying ? 0.6 : BODY_R;
  body.y0 = c.state === 'swimming' ? c.pos.y + 0.9 : c.pos.y;
  body.y1 = c.state === 'swimming' ? c.pos.y + c.height : c.pos.y + (lying ? 0.45 : c.height);
  return body;
}

/** The cylinder of one hit zone of a character (shared scratch object); lying and swimming characters are one body volume. */
const zoneVol = { r: 0, y0: 0, y1: 0 };
function zoneOf(c: Character, zone: HitZone): typeof zoneVol {
  if (c.state !== 'normal') {
    const b = bodyOf(c);
    zoneVol.r = b.r;
    zoneVol.y0 = b.y0;
    zoneVol.y1 = b.y1;
  } else if (zone === 'head') {
    zoneVol.r = HEAD_R;
    zoneVol.y0 = c.pos.y + NECK * c.height;
    zoneVol.y1 = c.pos.y + c.height;
  } else {
    zoneVol.r = BODY_R;
    zoneVol.y0 = c.pos.y;
    zoneVol.y1 = c.pos.y + NECK * c.height;
  }
  return zoneVol;
}

interface RayResult {
  t: number;
  kind: HitKind;
  character: Character | null;
  /** The zone of `character` the ray hit ('body' for anything else). */
  zone: HitZone;
  vehicle: Vehicle | null;
  heli: number;
  nx: number;
  ny: number;
  nz: number;
}

/** The point a shot from the muzzle aims at, and who (and which zone) the crosshair is on there. */
interface AimPoint extends V3 {
  character: Character | null;
  zone: HitZone;
}

export class CombatSystem {
  /** Vehicle -> who last damaged it (for crimes and stats on destruction). */
  private readonly damagedBy = new WeakMap<Vehicle, Character>();
  private fireWarnCooldown = 0;
  /** Victims already charged with a crime for the shot being resolved (one per victim per trigger pull). */
  private volley: Set<object> | null = null;
  /** Who and which zone the player's crosshair is on, for the trigger pull being resolved. */
  private aimed: { character: Character; zone: HitZone } | null = null;
  /** Sim time each victim was last reported as assaulted. */
  private readonly assaulted = new WeakMap<object, number>();
  /** Sim time each rocket was launched (or first seen), for its arming delay. */
  private readonly launched = new WeakMap<Projectile, number>();

  constructor(private readonly sim: Sim) {}

  update(dt: number): void {
    // Weapons change hands in many places (slot keys, pickups, shops, missions): drop stale reloads
    // and start the swap time here, before the timers run them out and before the HUD shows them.
    for (const c of this.sim.characters) {
      this.syncWeapon(c);
      if (c.fireQueued > 0) c.fireQueued -= dt;
    }
    this.updateProjectiles(dt);
    this.updateBurning(dt);
    if (this.fireWarnCooldown > 0) this.fireWarnCooldown -= dt;
  }

  // ---------------------------------------------------------------------------
  // Firing

  muzzle(c: Character, fromVehicle: boolean): V3 {
    if (fromVehicle && c.vehicle) {
      const v = c.vehicle;
      const sx = Math.cos(v.heading);
      const sz = -Math.sin(v.heading);
      return { x: v.pos.x + sx * (v.halfW + 0.2), y: v.pos.y + v.spec.height * 0.75, z: v.pos.z + sz * (v.halfW + 0.2) };
    }
    const yaw = c.aiming ? c.aimYaw : c.heading;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    return { x: c.pos.x + fx * 0.55 - fz * 0.18, y: c.pos.y + c.height * 0.76, z: c.pos.z + fz * 0.55 + fx * 0.18 };
  }

  playerFire(p: Character, input: PlayerInput, fromVehicle: boolean): void {
    this.syncWeapon(p);
    const w = p.inventory.spec();
    if (w.id === 'fists') {
      if (input.firePressed && !fromVehicle) this.melee(p);
      return;
    }
    if (p.reloadTimer > 0) return;
    if (!w.auto && !input.firePressed && !(p.fireQueued > 0)) return;
    const slot = p.inventory.slot();
    // An empty gun reloads on the trigger like on R, even while it is still being drawn.
    if (slot.clip <= 0) {
      if (slot.ammo > 0) this.startReload(p);
      else if (input.firePressed) {
        // Out of ammo: switch back to fists.
        p.inventory.current = 'fists';
        this.sim.events.emit('message', { text: `Out of ammo for the ${w.name}.`, duration: 2 });
      }
      return;
    }
    if (p.fireCooldown > 0) {
      // A semi-automatic pull just before the gun is ready fires the moment it is.
      if (!w.auto && input.firePressed && p.fireCooldown <= QUEUE_WINDOW) p.fireQueued = QUEUE_WINDOW;
      return;
    }
    p.fireQueued = 0;
    slot.clip--;
    this.startCooldown(p, 1 / w.rate);
    p.shotTimer = 0.07;
    p.aimHold = 1.0;
    this.sim.progress.stats.shotsFired++;
    const from = this.muzzle(p, fromVehicle);
    const target = this.cameraTarget(input.aimOrigin, input.aimDir, w.range + 8, p, from);
    let dx = target.x - from.x;
    let dy = target.y - from.y;
    let dz = target.z - from.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    // Hip fire is looser than aiming, and so is shooting on the move: together at most twice the spread.
    const spreadMul = fromVehicle ? 1.6 : Math.min(2, (p.speed > 3 ? 1.5 : 1) * (p.aimZoom ? 1 : 1.5));
    this.aimed = target.character ? { character: target.character, zone: target.zone } : null;
    try {
      this.discharge(p, w, from, dx, dy, dz, w.spread * spreadMul, fromVehicle ? null : this.muzzleWall(p, from));
    } finally {
      this.aimed = null;
    }
    this.sim.wanted.crime('gunfire', p.pos.x, p.pos.z);
    if (slot.clip === 0 && slot.ammo > 0) this.startReload(p);
  }

  /** NPC shooting at a target character (or the vehicle it is in), on foot or from the vehicle it sits in. */
  npcFire(c: Character, target: Character, accuracy: number, fromVehicle = false): void {
    this.syncWeapon(c);
    const w = c.inventory.spec();
    if (w.id === 'fists' || c.fireCooldown > 0 || c.reloadTimer > 0) return;
    const slot = c.inventory.slot();
    if (slot.clip <= 0) {
      this.startReload(c);
      return;
    }
    if (!c.inventory.infinite) slot.clip--;
    else slot.clip = Math.max(0, slot.clip - 1);
    this.startCooldown(c, (1 / w.rate) * (w.auto ? 1.4 : 2.2) + this.sim.rng.range(0, 0.25));
    c.shotTimer = 0.07;
    c.aimHold = 1.2;
    const from = this.muzzle(c, fromVehicle);
    const tp = target.vehicle ? target.vehicle.pos : target.pos;
    const ty = target.vehicle ? tp.y + 0.9 : tp.y + target.height * 0.62;
    let dx = tp.x - from.x;
    let dy = ty - from.y;
    let dz = tp.z - from.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    dx /= dist;
    dy /= dist;
    dz /= dist;
    const tSpeed = target.vehicle ? target.vehicle.speed : target.speed;
    const err = w.spread + (1 - accuracy) * 0.075 + tSpeed * 0.004 + dist * 0.0009;
    this.discharge(c, w, from, dx, dy, dz, err, fromVehicle ? null : this.muzzleWall(c, from));
    if (slot.clip === 0) this.startReload(c);
  }

  /**
   * Starts the cooldown after a shot. What the last frame overran the previous cooldown by counts
   * towards this one (up to MAX_CARRY), so weapons keep their rate of fire at any frame rate.
   */
  private startCooldown(c: Character, seconds: number): void {
    c.fireCooldown = Math.max(c.fireCooldown, -MAX_CARRY) + seconds;
    c.inventory.slot().readyAt = this.sim.time + c.fireCooldown;
  }

  /**
   * One trigger pull from `from` along (dx, dy, dz): a weaponFired event, then the rocket or one ray
   * per pellet within `spread`. A gun whose muzzle pokes through a wall (`wall`, see muzzleWall) fires
   * into that wall instead: the flash comes from the chest and every pellet stops at the wall face.
   */
  private discharge(shooter: Character, w: WeaponSpec, from: V3, dx: number, dy: number, dz: number, spread: number, wall: RayHit | null): void {
    const sim = this.sim;
    if (wall) {
      const ax = shooter.pos.x;
      const ay = shooter.pos.y + CHEST * shooter.height;
      const az = shooter.pos.z;
      sim.events.emit('weaponFired', { shooter, weapon: w.id, x: ax, y: ay, z: az, dx, dy, dz, pellets: w.pellets });
      for (let i = 0; i < w.pellets; i++) {
        sim.events.emit('shot', { shooter, weapon: w.id, fx: ax, fy: ay, fz: az, tx: wall.x, ty: wall.y, tz: wall.z, hit: 'world', nx: wall.nx, ny: wall.ny, nz: wall.nz, pellet: i });
      }
      if (w.projectile) {
        // The rocket goes off in the shooter's face, just short of the wall like a rocket in flight.
        const bx = wall.x - ax;
        const by = wall.y - ay;
        const bz = wall.z - az;
        const k = Math.max(0, 1 - 0.2 / (Math.hypot(bx, by, bz) || 1));
        this.explosion(ax + bx * k, ay + by * k, az + bz * k, ROCKET_BLAST, WEAPONS.rocket.damage, shooter, null);
      }
      return;
    }
    sim.events.emit('weaponFired', { shooter, weapon: w.id, x: from.x, y: from.y, z: from.z, dx, dy, dz, pellets: w.pellets });
    if (w.projectile) {
      this.launchRocket(shooter, from, dx, dy, dz);
      return;
    }
    this.volley = new Set();
    try {
      for (let i = 0; i < w.pellets; i++) {
        const d = this.spread(dx, dy, dz, spread);
        this.fireRay(shooter, from, d.x, d.y, d.z, w, i);
      }
    } finally {
      this.volley = null;
    }
  }

  /**
   * The wall face between a character's chest and his muzzle, when the gun pokes through a solid wall
   * (building, wall, container, pillar); null when the muzzle is clear. The hit is a shared scratch object.
   */
  private muzzleWall(c: Character, muzzle: V3): RayHit | null {
    const ax = c.pos.x;
    const ay = c.pos.y + CHEST * c.height;
    const az = c.pos.z;
    const dx = muzzle.x - ax;
    const dy = muzzle.y - ay;
    const dz = muzzle.z - az;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-6)) return null;
    return this.sim.world.grid.raycast(ax, ay, az, dx / len, dy / len, dz / len, len, wallHit, isSolidForSight) ? wallHit : null;
  }

  /** True when the character's gun pokes through a wall on foot, so its shots would only hit that wall. */
  muzzleBlocked(c: Character): boolean {
    return this.muzzleWall(c, this.muzzle(c, false)) !== null;
  }

  private spread(dx: number, dy: number, dz: number, angle: number): V3 {
    if (angle <= 0) return { x: dx, y: dy, z: dz };
    // Random direction inside a cone around d.
    const rng = this.sim.rng;
    const a = rng.next() * Math.PI * 2;
    const r = Math.sqrt(rng.next()) * Math.tan(angle);
    // Build an orthonormal basis.
    let ux = -dz;
    let uy = 0;
    let uz = dx;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-6) {
      ux = 1;
      uy = 0;
      uz = 0;
      ul = 1;
    }
    ux /= ul;
    uz /= ul;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;
    const ox = dx + (ux * Math.cos(a) + vx * Math.sin(a)) * r;
    const oy = dy + (uy * Math.cos(a) + vy * Math.sin(a)) * r;
    const oz = dz + (uz * Math.cos(a) + vz * Math.sin(a)) * r;
    const l = Math.hypot(ox, oy, oz) || 1;
    return { x: ox / l, y: oy / l, z: oz / l };
  }

  /**
   * Point the crosshair ray hits first (ignoring the shooter), and who and which zone it is on there.
   * The camera sits behind the shooter, so only what lies beyond the muzzle's depth along the ray counts:
   * a van the camera has backed into, or a car or person between the camera and the player, would
   * otherwise be shot from the muzzle backwards.
   */
  cameraTarget(o: V3, d: V3, range: number, shooter: Character, muzzle: V3): AimPoint {
    const t0 = Math.max(0, (muzzle.x - o.x) * d.x + (muzzle.y - o.y) * d.y + (muzzle.z - o.z) * d.z);
    const far = t0 + range + 12;
    const r = this.castRay(o.x, o.y, o.z, d.x, d.y, d.z, far, shooter, true, t0);
    // A prop the ray is inside at the muzzle's depth gives no direction: aim along the crosshair.
    const t = r.kind === 'none' || r.t <= t0 ? far : r.t;
    const c = r.character;
    const flat = d.x * d.x + d.z * d.z;
    if (c && flat > 1e-9) {
      const b = bodyOf(c);
      // Where the crosshair ray reaches the cylinder he fills as a whole (his head volume is narrower).
      const te = rayCylinderY(o.x, o.y, o.z, d.x, d.y, d.z, c.pos.x, c.pos.z, b.r, b.y0, b.y1, t);
      // Just past the muzzle, where the crosshair ray enters someone is the edge of him as seen from the muzzle,
      // and shots there graze past. Shoot through his middle instead (where the crosshair ray passes nearest his
      // axis), aimed at the spot where that line from the muzzle enters the zone the crosshair is on (head or
      // body) at the crosshair's height on him: aiming at a point inside him would land the shot lower, as the
      // muzzle is below the camera. The spot stays inside the zone's top and bottom (0.1 m, less in the head) so
      // that pellets do not fly over his head. With the muzzle above his top (he lies on the ground, or is below
      // the shooter) that line would run down his side into the road, so the shot goes to the crosshair's point
      // on his top instead.
      if ((te >= 0 ? te : t) - t0 < 2 * b.r && muzzle.y < b.y1) {
        const v = zoneOf(c, r.zone);
        const tm = Math.max(t, ((c.pos.x - o.x) * d.x + (c.pos.z - o.z) * d.z) / flat);
        const ux = o.x + d.x * tm - muzzle.x;
        const uz = o.z + d.z * tm - muzzle.z;
        const l = Math.hypot(ux, uz);
        // How far that line runs (on the ground plane) before it reaches the zone; 0 with the muzzle inside it.
        const s = l > 1e-6 ? rayCylinderY(muzzle.x, 0, muzzle.z, ux / l, 0, uz / l, c.pos.x, c.pos.z, v.r, -1, 1, l) : -1;
        if (s > 0) {
          // Where the crosshair ray enters the zone: at point blank that is short of t, which castRay moves on to the muzzle's depth.
          const tv = rayCylinderY(o.x, o.y, o.z, d.x, d.y, d.z, c.pos.x, c.pos.z, v.r, v.y0, v.y1, t);
          const m = Math.min(0.1, (v.y1 - v.y0) / 4);
          const y = clamp(o.y + d.y * (tv >= 0 ? tv : t), v.y0 + m, v.y1 - m);
          return { x: muzzle.x + (ux / l) * s, y, z: muzzle.z + (uz / l) * s, character: c, zone: r.zone };
        }
      }
    }
    return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t, character: c, zone: r.zone };
  }

  /**
   * Nearest hit along a ray against world, vehicles, characters and helicopters. Nothing nearer than
   * `minT` counts: the world is cast from there, and anything else the ray entered before it is skipped,
   * except a person who stands past it.
   */
  castRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, range: number, ignore: Character | null, forAim = false, minT = 0): RayResult {
    const sim = this.sim;
    const res: RayResult = { t: range, kind: 'none', character: null, zone: 'body', vehicle: null, heli: -1, nx: 0, ny: 1, nz: 0 };
    if (sim.world.grid.raycast(ox + dx * minT, oy + dy * minT, oz + dz * minT, dx, dy, dz, range - minT, hit)) {
      res.t = minT + hit.t;
      res.kind = 'world';
      res.nx = hit.nx;
      res.ny = hit.ny;
      res.nz = hit.nz;
    }
    // Ground plane hit (roads / beach).
    if (dy < -1e-4) {
      const tg = (sim.world.groundHeight(ox, oz) - oy) / dy;
      if (tg >= 0 && tg < res.t) {
        const gx = ox + dx * tg;
        const gz = oz + dz * tg;
        const tg2 = (sim.world.groundHeight(gx, gz) - oy) / dy;
        if (tg2 >= minT && tg2 < res.t) {
          res.t = tg2;
          res.kind = 'world';
          res.nx = 0;
          res.ny = 1;
          res.nz = 0;
        }
      }
    }
    const ignoreVehicle = ignore?.vehicle ?? null;
    for (const v of sim.vehicles) {
      if (v.removed || v === ignoreVehicle) continue;
      const cx = v.pos.x - ox;
      const cz = v.pos.z - oz;
      const along = cx * dx + cz * dz;
      if (along < -6 || along > res.t + 6) continue;
      vehicleObb(v, obb);
      const t = rayObb3(ox, oy, oz, dx, dy, dz, obb, v.pos.y + 0.15, v.pos.y + v.spec.height, res.t);
      if (t >= minT && t < res.t) {
        res.t = t;
        res.kind = 'vehicle';
        res.vehicle = v;
        res.character = null;
        res.nx = -dx;
        res.ny = -dy;
        res.nz = -dz;
      }
    }
    const flat = dx * dx + dz * dz;
    for (const c of sim.characters) {
      if (c.removed || c === ignore || c.state === 'inVehicle' || c.state === 'entering') continue;
      if (c.state === 'dead' && forAim) continue;
      const cx = c.pos.x - ox;
      const cz = c.pos.z - oz;
      const along = cx * dx + cz * dz;
      if (along < -1 || along > res.t + 1) continue;
      let t: number;
      let zone: HitZone = 'body';
      if (c.state === 'normal') {
        // Standing: a body cylinder up to the shoulders and a narrower head on top; the nearer hit counts.
        const neck = c.pos.y + NECK * c.height;
        t = rayCylinderY(ox, oy, oz, dx, dy, dz, c.pos.x, c.pos.z, BODY_R, c.pos.y, neck, res.t);
        const th = rayCylinderY(ox, oy, oz, dx, dy, dz, c.pos.x, c.pos.z, HEAD_R, neck, c.pos.y + c.height, res.t);
        if (th >= 0 && (t < 0 || th < t)) {
          t = th;
          zone = 'head';
        }
      } else {
        const b = bodyOf(c);
        t = rayCylinderY(ox, oy, oz, dx, dy, dz, c.pos.x, c.pos.z, b.r, b.y0, b.y1, res.t);
      }
      // At point blank the crosshair ray enters someone in front of the player before the muzzle's depth:
      // a person counts by where he stands (the ray's closest approach to his axis), and is hit just past it.
      if (minT > 0 && t >= 0) {
        const tc = flat > 1e-9 ? along / flat : -1;
        t = tc >= minT ? Math.max(t, minT + 1e-3) : -1;
      }
      if (t >= minT && t < res.t) {
        res.t = t;
        res.kind = 'flesh';
        res.character = c;
        res.zone = zone;
        res.vehicle = null;
        res.nx = -dx;
        res.ny = -dy;
        res.nz = -dz;
      }
    }
    for (let i = 0; i < sim.helis.length; i++) {
      const h = sim.helis[i]!;
      if (h.removed || h.destroyed) continue;
      const t = raySphere(ox, oy, oz, dx, dy, dz, h.pos.x, h.pos.y + 1.2, h.pos.z, 3.2);
      if (t >= minT && t < res.t) {
        res.t = t;
        res.kind = 'vehicle';
        res.heli = i;
        res.character = null;
        res.zone = 'body';
        res.vehicle = null;
      }
    }
    return res;
  }

  /** One bullet or pellet (number `pellet` of its trigger pull) from `from` along (dx, dy, dz). */
  private fireRay(shooter: Character, from: V3, dx: number, dy: number, dz: number, w: WeaponSpec, pellet: number): void {
    const sim = this.sim;
    const r = this.castRay(from.x, from.y, from.z, dx, dy, dz, w.range, shooter);
    const tx = from.x + dx * r.t;
    const ty = from.y + dy * r.t;
    const tz = from.z + dz * r.t;
    if (r.character) {
      const c = r.character;
      let zone = r.zone;
      // The gun sits below the eyes, so on its way to the head under the crosshair a round can clip that man's
      // shoulder first (at close range nearly always). A round still on course for that head is the headshot aimed.
      const aimed = this.aimed;
      if (zone === 'body' && aimed && aimed.character === c && aimed.zone === 'head' && c.state === 'normal') {
        const head = zoneOf(c, 'head');
        if (rayCylinderY(from.x, from.y, from.z, dx, dy, dz, c.pos.x, c.pos.z, head.r, head.y0, head.y1, w.range) >= 0) zone = 'head';
      }
      let dmg = w.damage;
      if (zone === 'head') {
        const mul = shooter.isPlayer ? w.headMul : NPC_HEAD_MUL;
        dmg *= c.role === 'swat' ? Math.max(1, mul * HELMET) : mul;
        if (shooter.isPlayer && c.alive) sim.progress.stats.headshots++;
      }
      if (w.id === 'shotgun' && r.t < 8) dmg *= 1.3;
      if (shooter.role === 'cop' || shooter.role === 'swat' || shooter.role === 'gang') dmg *= c.isPlayer ? 0.55 : 1;
      this.damageCharacter(c, dmg, shooter, 'bullet', dx, dy, dz, zone);
      sim.events.emit('blood', { x: tx, y: ty, z: tz, dx, dy, dz });
    } else if (r.vehicle) {
      const mult = shooter.isPlayer ? 1.4 : 0.8;
      this.damageVehicle(r.vehicle, w.damage * mult, shooter, 'bullet');
    } else if (r.heli >= 0) {
      const h = sim.helis[r.heli]!;
      h.health -= w.damage * (shooter.isPlayer ? 1.2 : 0);
      if (shooter.isPlayer) this.reportAttack(h, 'assaultCop', h.pos.x, h.pos.z);
    }
    sim.events.emit('shot', { shooter, weapon: w.id, fx: from.x, fy: from.y, fz: from.z, tx, ty, tz, hit: r.kind, nx: r.nx, ny: r.ny, nz: r.nz, pellet });
  }

  melee(c: Character): void {
    const sim = this.sim;
    this.syncWeapon(c);
    if (c.fireCooldown > 0) return;
    c.fireCooldown = 1 / WEAPONS.fists.rate;
    c.inventory.slot().readyAt = sim.time + c.fireCooldown;
    c.punchTimer = 0.32;
    c.meleeCombo = (c.meleeCombo + 1) % 3;
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    let best: Character | null = null;
    let bd = 1.75;
    for (const o of sim.characters) {
      if (o === c || o.removed || !o.alive || (o.state !== 'normal' && o.state !== 'knocked')) continue;
      // Gang members crowding the player never punch each other.
      if (sim.peds.allied(c, o)) continue;
      const dx = o.pos.x - c.pos.x;
      const dz = o.pos.z - c.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bd || Math.abs(o.pos.y - c.pos.y) > 1.2) continue;
      if (d > 0.3 && (dx * fx + dz * fz) / d < 0.45) continue;
      best = o;
      bd = d;
    }
    const hx = c.pos.x + fx * 0.8;
    const hz = c.pos.z + fz * 0.8;
    if (best) {
      const dmg = WEAPONS.fists.damage * (c.isPlayer ? 1 : 0.7);
      best.staggerHits++;
      best.meleeComboTimer = 2;
      if (best.staggerHits >= 3 && best.state === 'normal') {
        best.state = 'knocked';
        best.knockTimer = 1.6;
        best.vel.x = fx * 3.5;
        best.vel.z = fz * 3.5;
        best.vel.y = 2.5;
        best.onGround = false;
        best.staggerHits = 0;
      } else {
        best.vel.x += fx * 1.5;
        best.vel.z += fz * 1.5;
      }
      this.damageCharacter(best, dmg, c, 'melee', fx, 0, fz);
      sim.events.emit('melee', { x: hx, y: c.pos.y + 1.3, z: hz, hit: true });
    } else {
      sim.events.emit('melee', { x: hx, y: c.pos.y + 1.3, z: hz, hit: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Reloading

  startReload(c: Character): void {
    this.syncWeapon(c);
    const spec = c.inventory.spec();
    const slot = c.inventory.slot();
    if (spec.mag === 0 || c.reloadTimer > 0 || slot.clip >= spec.mag) return;
    if (slot.ammo <= 0 && !c.inventory.infinite) return;
    c.reloadTimer = spec.reload;
    c.reloadWeapon = spec.id;
    this.sim.events.emit('reload', { character: c });
  }

  finishReload(c: Character): void {
    const weapon = c.reloadWeapon;
    c.reloadTimer = 0;
    c.reloadWeapon = null;
    if (weapon !== c.inventory.current) return;
    const spec = c.inventory.spec();
    const slot = c.inventory.slot();
    const need = spec.mag - slot.clip;
    if (need <= 0) return;
    const take = c.inventory.infinite ? need : Math.min(need, slot.ammo);
    slot.clip += take;
    if (!c.inventory.infinite) slot.ammo -= take;
  }

  /**
   * Catches up with a weapon change. A reload whose weapon is no longer in hand is cancelled (that weapon
   * keeps its partial clip). The weapon now in hand fires once the swap time and its own cooldown from
   * its last shot have both passed, so switching back and forth never beats a weapon's rate of fire.
   */
  private syncWeapon(c: Character): void {
    const current = c.inventory.current;
    if (c.reloadTimer > 0 && c.reloadWeapon !== current) {
      c.reloadTimer = 0;
      c.reloadWeapon = null;
    }
    if (c.drawnWeapon === current) return;
    // The weapon a character is first seen with (spawned with) is ready at once.
    if (c.drawnWeapon !== null) c.fireCooldown = Math.max(SWAP_TIME, c.inventory.slot().readyAt - this.sim.time);
    c.drawnWeapon = current;
  }

  // ---------------------------------------------------------------------------
  // Damage

  /**
   * Applies a hit (armour first, except for falls and drowning) and emits a 'damage' event for it, also
   * when the armour took all of it. Ignored, with no event, on the dead, the removed, and the player in
   * god mode or while wasted / busted. (dx, dz) is the direction the hit travels in.
   */
  damageCharacter(c: Character, amount: number, attacker: Character | null, kind: DamageKind, dx: number, _dy: number, dz: number, zone: HitZone = 'body'): void {
    const sim = this.sim;
    if (c.removed || !c.alive || !(amount > 0)) return;
    if (c.isPlayer && sim.playerDown) return;
    if (c.isPlayer && sim.cheats.godMode) return;
    let armourLoss = 0;
    if (c.armor > 0 && kind !== 'fall' && kind !== 'drown') {
      armourLoss = Math.min(c.armor, amount);
      c.armor -= armourLoss;
      amount -= armourLoss;
    }
    const healthLoss = Math.min(amount, Math.max(0, c.health));
    c.health -= amount;
    c.hurtTimer = 0.35;
    if (attacker && attacker !== c) {
      c.lastAttacker = attacker;
      c.lastAttackTime = sim.time;
    }
    const killed = c.health <= 0;
    const hl = Math.hypot(dx, dz);
    const dir = Number.isFinite(hl) && hl > 1e-9;
    const dirX = dir ? dx / hl : 0;
    const dirZ = dir ? dz / hl : 0;
    sim.events.emit('damage', { victim: c, attacker, healthLoss, armourLoss, kind, zone, killed, dirX, dirZ });
    if (killed) {
      this.kill(c, attacker, kind, dx, dz);
      return;
    }
    if (attacker && attacker.isPlayer && !c.isPlayer) {
      if (c.isLaw) this.reportAttack(c, 'assaultCop', c.pos.x, c.pos.z);
      else if (kind === 'melee' || kind === 'bullet') this.reportAttack(c, 'assault', c.pos.x, c.pos.z);
    }
    if (!c.isPlayer) {
      if (c.isLaw) sim.police.onCopAttacked(c, attacker);
      else sim.peds.onAttacked(c, attacker);
    }
  }

  /**
   * Reports the player attacking `victim`. The pellets of one shot are one crime per victim, and so are
   * hits on one victim within ASSAULT_GAP of the last reported one: automatic fire adds heat no faster
   * than the pistol does.
   */
  private reportAttack(victim: object, type: CrimeType, x: number, z: number): void {
    if (this.volley) {
      if (this.volley.has(victim)) return;
      this.volley.add(victim);
    }
    const last = this.assaulted.get(victim);
    if (last !== undefined && this.sim.time - last < ASSAULT_GAP) return;
    this.assaulted.set(victim, this.sim.time);
    this.sim.wanted.crime(type, x, z);
  }

  kill(c: Character, killer: Character | null, kind: DamageKind, dx: number, dz: number): void {
    const sim = this.sim;
    if (!c.alive) return;
    c.health = Math.min(0, c.health);
    if (c.vehicle) {
      const v = c.vehicle;
      sim.unseat(c);
      const sx = Math.cos(v.heading);
      const sz = -Math.sin(v.heading);
      const spot = sim.world.findFreeSpot(v.pos.x + sx * (v.halfW + 0.7), v.pos.z + sz * (v.halfW + 0.7), 0.4, 6, true) ?? { x: v.pos.x, z: v.pos.z };
      c.pos.x = spot.x;
      c.pos.z = spot.z;
      c.pos.y = Math.max(sim.world.groundHeight(spot.x, spot.z), sim.world.groundHeight(v.pos.x, v.pos.z));
    }
    c.state = 'dead';
    c.deadTime = 0;
    c.moveSpeed = 0;
    c.aiming = false;
    c.reloadTimer = 0;
    c.reloadWeapon = null;
    if (kind === 'bullet' || kind === 'melee') {
      c.vel.x += dx * 2.5;
      c.vel.z += dz * 2.5;
    }
    if (c.isPlayer) {
      sim.playerDied();
    } else {
      if (killer && killer.isPlayer) {
        sim.progress.stats.kills++;
        if (c.isLaw) {
          sim.progress.stats.copsKilled++;
          sim.wanted.crime('killCop', c.pos.x, c.pos.z);
        } else if (c.role === 'gang' || c.missionTag === 'enemy') {
          sim.wanted.crime('killGang', c.pos.x, c.pos.z);
        } else {
          sim.wanted.crime('murder', c.pos.x, c.pos.z);
        }
      }
      if (c.cash > 0) sim.pickupSys.dropMoney(c.pos.x, c.pos.z, c.cash);
      c.cash = 0;
      if (c.owner === 'traffic') c.owner = 'ped';
    }
    sim.events.emit('characterKilled', { victim: c, killer });
  }

  damageVehicle(v: Vehicle, amount: number, attacker: Character | null, kind: DamageKind): void {
    if (v.destroyed || v.removed || !(amount > 0)) return;
    if (this.sim.cheats.godMode && v.driver?.isPlayer) return;
    v.health -= amount;
    if (attacker) this.damagedBy.set(v, attacker);
    if (attacker && attacker.isPlayer && v.spec.police && kind === 'bullet') this.reportAttack(v, 'assaultCop', v.pos.x, v.pos.z);
    if (v.driver && !v.driver.isPlayer && v.driver.brain && attacker) v.driver.brain.threat = attacker;
    if (kind === 'explosion' && v.health < -v.spec.health * 0.35) {
      this.explodeVehicle(v);
      return;
    }
    if (v.health <= 0 && !v.burning) this.igniteVehicle(v, this.sim.rng.range(3.5, 5.5));
  }

  igniteVehicle(v: Vehicle, seconds: number): void {
    if (v.destroyed || v.burning) return;
    v.burning = true;
    v.burnTimer = seconds;
    v.health = Math.min(v.health, 0);
    if (v.driver?.isPlayer && this.fireWarnCooldown <= 0) {
      this.fireWarnCooldown = 6;
      this.sim.events.emit('message', { text: 'Your vehicle is on fire! Press F to get out!', duration: 3 });
    }
  }

  explodeVehicle(v: Vehicle): void {
    const sim = this.sim;
    if (v.destroyed) return;
    const culprit = this.damagedBy.get(v) ?? null;
    v.destroyed = true;
    v.burning = false;
    v.health = -v.spec.health;
    v.wreckTime = 0;
    v.siren = false;
    v.ai = null;
    for (const o of v.occupants()) this.damageCharacter(o, 1000, culprit, 'explosion', 0, 1, 0);
    launchVehicle(v, 0, 0, 6.5, 2.5);
    if (culprit && culprit.isPlayer) {
      sim.progress.stats.vehiclesDestroyed++;
      sim.wanted.crime(v.spec.police ? 'destroyPolice' : 'destroyVehicle', v.pos.x, v.pos.z);
    }
    sim.events.emit('vehicleDestroyed', { vehicle: v });
    this.explosion(v.pos.x, v.pos.y + 0.8, v.pos.z, 7.5, 360, culprit, v);
  }

  explosion(x: number, y: number, z: number, radius: number, damage: number, owner: Character | null, source: Vehicle | null): void {
    const sim = this.sim;
    sim.events.emit('explosion', { x, y, z, radius });
    for (const c of sim.characters) {
      if (c.removed || c.state === 'inVehicle') continue;
      const dx = c.pos.x - x;
      const dy = c.pos.y + 1 - y;
      const dz = c.pos.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      // Walls shelter: the blast hurts and throws as much of him as it can see.
      const e = this.exposure(c, x, y, z);
      const f = (1 - d / radius) * e;
      const hl = Math.hypot(dx, dz) || 1;
      c.vel.x = (dx / hl) * 13 * f;
      c.vel.z = (dz / hl) * 13 * f;
      c.vel.y = (3 + 6 * (1 - d / radius)) * e;
      c.onGround = false;
      if ((c.state === 'normal' || c.state === 'swimming') && e >= 0.5) {
        c.state = 'knocked';
        c.knockTimer = 1.8 + (1 - d / radius);
      }
      this.damageCharacter(c, damage * f * 0.8, owner, 'explosion', dx / hl, 0.5, dz / hl);
    }
    for (const v of sim.vehicles) {
      if (v.removed || v === source) continue;
      const dx = v.pos.x - x;
      const dz = v.pos.z - z;
      const d = Math.hypot(dx, v.pos.y + 0.8 - y, dz);
      if (d > radius + v.halfL * 0.5) continue;
      const f = clamp(1 - d / (radius + v.halfL * 0.5), 0, 1);
      const hl = Math.hypot(dx, dz) || 1;
      const massScale = clamp(1600 / v.spec.mass, 0.2, 1.4);
      launchVehicle(v, dx / hl, dz / hl, 9 * f * massScale, 5 * f * massScale);
      this.damageVehicle(v, damage * f * 3.2, owner, 'explosion');
    }
    sim.world.grid.query(x - radius, z - radius, x + radius, z + radius, (c) => {
      if (!c.breakable) return;
      if (Math.hypot(c.cx - x, c.cz - z) > radius * 0.7) return;
      const idx = sim.world.breakCollider(c);
      if (idx >= 0) {
        const hl = Math.hypot(c.cx - x, c.cz - z) || 1;
        sim.events.emit('propBroken', { index: idx, dirX: (c.cx - x) / hl, dirZ: (c.cz - z) / hl });
      }
    });
    for (const h of sim.helis) {
      if (h.removed || h.destroyed) continue;
      const d = Math.hypot(h.pos.x - x, h.pos.y - y, h.pos.z - z);
      if (d < radius * 1.6) h.health -= damage * 3 * (1 - d / (radius * 1.6));
    }
    if (owner && owner.isPlayer) sim.wanted.crime('explosion', x, z);
    sim.peds.onViolence(x, z, owner, 60);
  }

  /**
   * How much of a character a blast at (x, y, z) sees: line of sight from just above it to his feet,
   * middle and head (0.3, 1.0 and 1.6 m up), as a share of the three, but at least a quarter.
   */
  private exposure(c: Character, x: number, y: number, z: number): number {
    const world = this.sim.world;
    let seen = 0;
    for (const k of EXPOSURE_HEIGHTS) if (world.lineOfSight(x, y + 0.5, z, c.pos.x, c.pos.y + k, c.pos.z)) seen++;
    return Math.max(0.25, seen / EXPOSURE_HEIGHTS.length);
  }

  // ---------------------------------------------------------------------------
  // Rockets

  private launchRocket(owner: Character, from: V3, dx: number, dy: number, dz: number): void {
    const p = new Projectile(this.sim.newId(), { ...from }, { x: dx * ROCKET_SPEED, y: dy * ROCKET_SPEED, z: dz * ROCKET_SPEED }, owner);
    p.life = ROCKET_LIFE;
    this.launched.set(p, this.sim.time);
    this.sim.projectiles.push(p);
    this.sim.events.emit('shot', { shooter: owner, weapon: 'rocket', fx: from.x, fy: from.y, fz: from.z, tx: from.x + dx, ty: from.y + dy, tz: from.z + dz, hit: 'none', nx: 0, ny: 1, nz: 0, pellet: 0 });
  }

  private updateProjectiles(dt: number): void {
    const sim = this.sim;
    for (const p of sim.projectiles) {
      if (p.removed) continue;
      p.life -= dt;
      const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
      const step = sp * dt;
      const dx = p.vel.x / sp;
      const dy = p.vel.y / sp;
      const dz = p.vel.z / sp;
      // Projectiles made elsewhere (scripts, tests) arm from when they are first seen.
      let born = this.launched.get(p);
      if (born === undefined) {
        born = sim.time;
        this.launched.set(p, born);
      }
      const ignore = sim.time - born < ROCKET_ARMING ? p.owner : null;
      const r = this.castRay(p.pos.x, p.pos.y, p.pos.z, dx, dy, dz, step, ignore ?? (p.owner && p.owner.vehicle ? p.owner : null));
      if (r.kind !== 'none' || p.life <= 0) {
        const t = r.kind !== 'none' ? Math.max(0, r.t - 0.2) : 0;
        p.removed = true;
        // A direct rocket hit always destroys a vehicle.
        if (r.vehicle) this.damageVehicle(r.vehicle, r.vehicle.spec.health * 3, p.owner, 'explosion');
        this.explosion(p.pos.x + dx * t, p.pos.y + dy * t, p.pos.z + dz * t, ROCKET_BLAST, WEAPONS.rocket.damage, p.owner, null);
        continue;
      }
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;
    }
  }

  // ---------------------------------------------------------------------------
  // Fire

  private updateBurning(dt: number): void {
    const sim = this.sim;
    for (const v of sim.vehicles) {
      if (v.removed || !v.burning || v.destroyed) continue;
      v.burnTimer -= dt;
      // NPC occupants abandon a burning vehicle.
      for (const o of v.occupants()) {
        if (o.isPlayer) continue;
        sim.unseat(o);
        const sx = Math.cos(v.heading);
        const sz = -Math.sin(v.heading);
        const spot = sim.world.findFreeSpot(v.pos.x + sx * (v.halfW + 0.8), v.pos.z + sz * (v.halfW + 0.8), 0.4, 6) ?? { x: v.pos.x + sx * 2, z: v.pos.z + sz * 2 };
        o.pos.x = spot.x;
        o.pos.z = spot.z;
        o.pos.y = sim.world.groundHeight(spot.x, spot.z);
        o.state = 'normal';
        if (o.owner === 'traffic') o.owner = 'ped';
        if (o.isLaw) sim.police.onCopBailed(o);
        else {
          // Traffic drivers are spawned without a brain and would just stand in the fire.
          if (!o.brain) o.brain = makeBrain('wander');
          sim.peds.flee(o, v.pos.x, v.pos.z, null);
        }
      }
      if (v.burnTimer <= 0) this.explodeVehicle(v);
    }
    // Standing in flames hurts. Cars in the sea do not burn (a car that drowns is also marked destroyed).
    for (const v of sim.vehicles) {
      if (v.removed || v.inWater || !(v.burning || (v.destroyed && v.wreckTime < 12))) continue;
      for (const c of sim.characters) {
        if (c.removed || !c.alive || c.state === 'inVehicle') continue;
        const d = Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z);
        if (d < v.halfL + 0.4 && Math.abs(c.pos.y - v.pos.y) < 2) {
          this.damageCharacter(c, 22 * dt, null, 'fire', 0, 0, 0);
          // An attacker-less hit makes peds flee from where they stand (an arbitrary direction,
          // possibly into the car): make them run from the flames instead.
          if (c.alive && c.brain?.mode === 'flee') {
            c.brain.threatX = v.pos.x;
            c.brain.threatZ = v.pos.z;
          }
        }
      }
    }
  }
}

function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number): number {
  const lx = ox - cx;
  const ly = oy - cy;
  const lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  const t2 = -b + s;
  return t2 >= 0 ? 0 : -1;
}
