// Weapons, damage, deaths, burning vehicles, explosions and rockets.

import { rayCapsule, rayCylinderY, rayObb3, type OBB } from '../core/collision';
import { clamp, pointSegDist, wrapAngle, type V3 } from '../core/math';
import { makeRayHit, type RayHit } from '../world/colliders';
import { WATER_Y } from '../world/constants';
import { makeBrain } from './brains';
import type { CharState, Character, Vehicle } from './entities';
import { Projectile } from './entities';
import type { HitKind } from './events';
import type { PlayerInput } from './input';
import type { PlayerSlot } from './playerSlot';
import { cowerCrouched } from './peds';
import { makeWeaponPose, reloading, seatSide, SKELETON, upright, weaponPose, weaponPoseInto, windowMuzzle, type WeaponPose } from './pose';
import type { Sim } from './sim';
import { FireSystem, BURN_DPS } from './fire';
import { isGun, weaponKindOf, WEAPONS, type WeaponId, type WeaponSpec } from './specs';
import { ThrowSystem } from './throwables';
import { launchVehicle, vehicleObb } from './vehiclePhysics';
import type { CrimeType } from './wanted';

export type DamageKind = 'bullet' | 'melee' | 'explosion' | 'vehicle' | 'fall' | 'fire' | 'impact' | 'drown';
/**
 * Where a hit landed: standing characters have a head volume above the body, lying ones a head at the end of the
 * torso (see LIE_HIP); everyone else is all body.
 */
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
/** A semi-automatic trigger press this close (s) to the weapon being ready is queued, and kept that long after it is. */
const QUEUE_WINDOW = 0.1;
/** Head hits of NPC shooters (the player's use WeaponSpec.headMul). */
const NPC_HEAD_MUL = 2;
/** Share of a weapon's damage an NPC's round does to the player, whoever fires it (police, gangs, a mission's guards). */
const NPC_ON_PLAYER = 0.55;
/** An NPC holds fire while someone he must not hit stands this close (m) to his line of fire at the muzzle (see inLineOfFire)... */
const LINE_CLEAR = 0.8;
/** ...and further out, this much (m) more per metre from his muzzle: the spread of an NPC's shot. */
const LINE_SPREAD = 0.08;
/**
 * Seconds after getting up from a knockdown during which blows do not count towards the next one (they still hurt): a
 * moment to find his feet, so a brawler, or three, cannot floor him again on the frame he is up.
 */
export const GET_UP_GRACE = 0.5;
/** SWAT helmets: their head hits take this share of the multiplier (never less than a body hit). */
const HELMET = 0.6;
/** The muzzle wall check starts from the chest, this share of the shooter's height up (also where a punch lands). */
const CHEST = 0.75;
/** A punch is thrown from the shoulders, this share of the puncher's height up. */
const SHOULDER = 0.82;
/** Standing characters: body cylinder up to NECK of the height, head cylinder from there to the top. */
const BODY_R = 0.36;
const HEAD_R = 0.16;
const NECK = 0.86;
/**
 * A cowering civilian crouched with his hands over his head (peds.cowerCrouched) is hit as CrowdView draws him: one body
 * volume (no head of its own) up to CROUCH_TOP of his height, its axis CROUCH_FWD of his height ahead of his feet (he leans
 * into the crouch), CROUCH_R of his height wide. Rounds that pass over him miss him.
 */
const CROUCH_TOP = 0.7;
const CROUCH_FWD = 0.2;
const CROUCH_R = 0.24;
/** Rocket launch speed (m/s); a rocket self-destructs once it has flown the launcher's range. */
const ROCKET_SPEED = 58;
const ROCKET_LIFE = WEAPONS.rocket.range / ROCKET_SPEED;
const ROCKET_BLAST = 8;
/** A rocket cannot hit its owner for this long after launch (s). */
const ROCKET_ARMING = 0.15;
/** Heights above a character's feet that a blast must see to hurt him fully. */
const EXPOSURE_HEIGHTS = [0.3, 1.0, 1.6] as const;
/**
 * Most steps of raiseGun; it stops sooner once a step moves the aim by less than RAISE_SETTLED (rad). Each step aims
 * from the gun's pivot, which the aim moves only a little, so the barrel's miss shrinks about threefold per step even
 * at point blank (from 0.5 to 30 m, 60 degrees up or down, starting 0.6 rad off: 29 cm, 9 cm, 1.6 cm and 5 mm after one
 * to four steps); at ordinary ranges two or three steps settle it.
 */
const RAISE_STEPS = 10;
const RAISE_SETTLED = 1e-7;
/**
 * A raised barrel passing further than this (m) from the target cannot point at it: the pose limits the pitch (80 degrees
 * standing, 20 down to 69 up treading water). That shot leaves the tip straight at the target.
 */
const RAISE_MISS = 0.02;
/** Scratch pose of raiseGun. */
const raisePose: WeaponPose = makeWeaponPose();
/**
 * An NPC's held aim (holdAim) is raised again once he or the point he aims at has moved this share of the range
 * between them (about 0.2 degrees of aim), and at most HOLD_MOVED (m).
 */
const HOLD_ANGLE = 0.0035;
const HOLD_MOVED = 0.02;

/** What an NPC's held aim was last raised for (see holdAim). */
interface HeldAim {
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  bearing: number;
  weapon: WeaponId;
  state: CharState;
  reload: boolean;
  yaw: number;
  pitch: number;
}

/**
 * A body on its back (knocked down or dead) is hit as CrowdView.lying draws it, along his heading: the pelvis LIE_HIP
 * m behind his position and LIE_Y up, the legs out ahead of it and the torso and head behind it. Lengths are in his
 * skeleton scale (appearance.height). Three capsules: the legs and hips from the pelvis to LIE_LEGS ahead of it,
 * LIE_LEGS_R thick; the torso from the pelvis to the neck pivot (SKELETON.neckY behind it), LIE_TORSO_R thick; and the
 * head, LIE_HEAD_R thick between LIE_HEAD0 and LIE_HEAD1 beyond the neck pivot (the drawn skull runs from 0.025 to
 * about 0.32 past it, hair included).
 */
const LIE_HIP = 0.5;
const LIE_Y = 0.16;
const LIE_LEGS = 0.85;
const LIE_LEGS_R = 0.19;
const LIE_TORSO_R = 0.17;
const LIE_HEAD0 = 0.12;
const LIE_HEAD1 = 0.2;
const LIE_HEAD_R = 0.13;
/** Result of lyingHit (shared scratch object): ray distance (-1 for a miss) and the zone hit. */
const lieHit: { t: number; zone: HitZone } = { t: -1, zone: 'body' };

function lying(c: Character): boolean {
  return c.state === 'dead' || c.state === 'knocked';
}

/** Up on his feet as far as being hit goes: standing, or climbing into a car beside it. */
function onFeet(c: Character): boolean {
  return c.state === 'normal' || c.state === 'entering';
}

/** Where a ray first enters a lying body (see LIE_HIP): its legs, torso or head. */
function lyingHit(c: Character, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): typeof lieHit {
  const s = c.appearance.height;
  const fx = Math.sin(c.heading);
  const fz = Math.cos(c.heading);
  const px = c.pos.x - fx * LIE_HIP;
  const pz = c.pos.z - fz * LIE_HIP;
  const y = c.pos.y + LIE_Y;
  const neck = SKELETON.neckY * s;
  const legs = rayCapsule(ox, oy, oz, dx, dy, dz, px, y, pz, px + fx * LIE_LEGS * s, y, pz + fz * LIE_LEGS * s, LIE_LEGS_R, maxT);
  const torso = rayCapsule(ox, oy, oz, dx, dy, dz, px, y, pz, px - fx * neck, y, pz - fz * neck, LIE_TORSO_R, maxT);
  const h0 = neck + LIE_HEAD0 * s;
  const h1 = neck + LIE_HEAD1 * s;
  const head = rayCapsule(ox, oy, oz, dx, dy, dz, px - fx * h0, y, pz - fz * h0, px - fx * h1, y, pz - fz * h1, LIE_HEAD_R, maxT);
  lieHit.t = legs >= 0 && (torso < 0 || legs < torso) ? legs : torso;
  lieHit.zone = 'body';
  if (head >= 0 && (lieHit.t < 0 || head < lieHit.t)) {
    lieHit.t = head;
    lieHit.zone = 'head';
  }
  return lieHit;
}

/**
 * The upright cylinder a character occupies as a whole (shared scratch object): axis at (x, z), radius r, from y0 to y1.
 * `crouch`: he cowers crouched (see CROUCH_TOP). For a lying body this is only a rough footprint about his position:
 * shots hit the drawn pose (lyingHit).
 */
const body = { x: 0, z: 0, r: 0, y0: 0, y1: 0 };
function bodyOf(c: Character, crouch = false): typeof body {
  body.x = c.pos.x;
  body.z = c.pos.z;
  if (crouch) {
    body.x += Math.sin(c.heading) * CROUCH_FWD * c.height;
    body.z += Math.cos(c.heading) * CROUCH_FWD * c.height;
    body.r = CROUCH_R * c.height;
    body.y0 = c.pos.y;
    body.y1 = c.pos.y + CROUCH_TOP * c.height;
    return body;
  }
  const down = lying(c);
  body.r = down ? 0.6 : BODY_R;
  body.y0 = c.state === 'swimming' ? c.pos.y + 0.9 : c.pos.y;
  body.y1 = c.state === 'swimming' ? c.pos.y + c.height : c.pos.y + (down ? 0.45 : c.height);
  return body;
}

/**
 * The cylinder of one hit zone of a character (shared scratch object); lying, swimming and crouching (`crouch`, see
 * CROUCH_TOP) characters are one body volume.
 */
const zoneVol = { x: 0, z: 0, r: 0, y0: 0, y1: 0 };
function zoneOf(c: Character, zone: HitZone, crouch = false): typeof zoneVol {
  zoneVol.x = c.pos.x;
  zoneVol.z = c.pos.z;
  if (!onFeet(c) || crouch) {
    const b = bodyOf(c, crouch);
    zoneVol.x = b.x;
    zoneVol.z = b.z;
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
  /**
   * Vehicle -> who answers for it (crimes, stats and kills when it burns or blows up): who last damaged it, but once it
   * burns, who set it alight, unless a later hit blows it up there and then.
   */
  private readonly damagedBy = new WeakMap<Vehicle, Character>();
  /**
   * Vigilante suspects and their cars. The player stops them for the law: hurting, killing or wrecking them is no
   * crime, and the wreck that burns out and blows up afterwards is nobody's doing. Remembered after the job lets go of
   * them once stopped (it clears their missionTag when it counts the stop, seconds before the burning wreck explodes);
   * see followVigilante.
   */
  private readonly outlaws = new WeakSet<Character | Vehicle>();
  /** The vigilante job's suspect and his car as of the last frame (see followVigilante). */
  private readonly hunted: { car: Vehicle | null; suspect: Character | null } = { car: null, suspect: null };
  private fireWarnCooldown = 0;
  /** Victims already charged with a crime for the shot being resolved (one per victim per trigger pull). */
  private volley: Set<object> | null = null;
  /** Who and which zone the player's crosshair is on, for the trigger pull being resolved. */
  private aimed: { character: Character; zone: HitZone } | null = null;
  /** Victims of a headshot in the trigger pull being resolved: the stat counts one per victim per pull. */
  private headshotsThisPull: Set<Character> | null = null;
  /** Sim time each culprit last reported each victim as assaulted; culprits are rate-limited separately. */
  private readonly assaulted = new WeakMap<Character, WeakMap<object, number>>();
  /** Sim time each rocket was launched (or first seen), for its arming delay. */
  private readonly launched = new WeakMap<Projectile, number>();
  /** What each NPC shooter's held aim was last raised for. */
  private readonly held = new WeakMap<Character, HeldAim>();
  /** Set while bleeding and burning are dealt: those hits are no fresh attack to react to. */
  private lingering = false;
  /** Grenades and molotovs in flight. */
  readonly throws: ThrowSystem;
  /** Ground fires (molotovs). */
  readonly fire: FireSystem;

  constructor(private readonly sim: Sim) {
    this.throws = new ThrowSystem(sim);
    this.fire = new FireSystem(sim);
  }

  update(dt: number): void {
    this.followVigilante();
    // Weapons change hands in many places (slot keys, pickups, shops, missions): drop stale reloads
    // and start the swap time here, before the timers run them out and before the HUD shows them.
    for (const c of this.sim.characters) {
      this.syncWeapon(c);
      if (c.fireQueued > 0) c.fireQueued -= dt;
    }
    this.updateProjectiles(dt);
    this.throws.update(dt);
    this.fire.update(dt);
    this.updateBurning(dt);
    this.updateWounds(dt);
    if (this.fireWarnCooldown > 0) this.fireWarnCooldown -= dt;
  }

  /**
   * Knife wounds bleed and the flames of a molotov burn on: each a hit with no attacker, the one who cut or lit him
   * credited with a death by it. Water puts the flames out.
   */
  private updateWounds(dt: number): void {
    this.lingering = true;
    try {
      for (const c of this.sim.characters) {
        if (c.removed || !c.alive) {
          c.bleedTimer = 0;
          c.burnTimer = 0;
          continue;
        }
        if (c.bleedTimer > 0) {
          const t = Math.min(dt, c.bleedTimer);
          c.bleedTimer -= dt;
          this.damageCharacter(c, c.bleedRate * t, null, 'melee', 0, 0, 0, 'body', c.bleedBy);
          if (c.bleedTimer <= 0) c.bleedBy = null;
        }
        if (c.burnTimer > 0 && c.alive) {
          if (c.state === 'swimming' || c.state === 'inVehicle') c.burnTimer = 0;
          else {
            const t = Math.min(dt, c.burnTimer);
            c.burnTimer -= dt;
            this.damageCharacter(c, BURN_DPS * t, null, 'fire', 0, 0, 0, 'body', c.burnBy);
          }
          if (c.burnTimer <= 0) c.burnBy = null;
        }
      }
    } finally {
      this.lingering = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Firing

  muzzle(c: Character, fromVehicle: boolean): V3 {
    if (fromVehicle && c.vehicle) {
      // Out of the shooter's own window (seats 0 and 2 on the left, local +X, the others on the right, as
      // Sim.syncOccupant seats them): the point CrowdView draws the barrel end of the gun held out there on.
      return windowMuzzle(c.vehicle, c.seat, { x: 0, y: 0, z: 0 });
    }
    const yaw = c.aiming ? c.aimYaw : c.heading;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // On foot a gun fires from its barrel tip as drawn (sim/pose.ts). With someone in front nearer than the
    // barrel reaches, the barrel ends beside or inside him: the shot then leaves from the chest, where a punch
    // lands, which the point-blank aiming of cameraTarget is built around.
    if (isGun(c.inventory.current)) {
      const tip = weaponPose(c).tip;
      if (!this.barrelCrowded(c, tip, fx, fz)) return tip;
    }
    return chestMuzzle(c, fx, fz);
  }

  /**
   * Someone on foot stands along the barrel ending at `tip` (forward fx, fz): ahead of `c`, nearer than
   * the tip plus his body, and beside the barrel line no further than his body plus the shoulder camera's
   * offset (the crosshair can be on him there at point blank).
   */
  private barrelCrowded(c: Character, tip: V3, fx: number, fz: number): boolean {
    const reach = (tip.x - c.pos.x) * fx + (tip.z - c.pos.z) * fz;
    // Sideways offsets are measured to the left: (fz, -fx).
    const line = (tip.x - c.pos.x) * fz - (tip.z - c.pos.z) * fx;
    for (const o of this.sim.characters) {
      if (o === c || o.removed || o.state === 'inVehicle') continue;
      const b = bodyOf(o, this.crouched(o));
      const dx = b.x - c.pos.x;
      const dz = b.z - c.pos.z;
      const along = dx * fx + dz * fz;
      if (along <= 0) continue;
      if (tip.y < b.y0 - 0.2 || tip.y > b.y1 + 0.2 || along > reach + b.r) continue;
      if (Math.abs(dx * fz - dz * fx - line) < b.r + 0.3) return true;
    }
    return false;
  }

  playerFire(p: Character, input: PlayerInput, fromVehicle: boolean): void {
    this.syncWeapon(p);
    const w = p.inventory.spec();
    const kind = weaponKindOf(w.id);
    if (kind === 'melee') {
      if (input.firePressed && !fromVehicle) this.melee(p);
      return;
    }
    if (kind === 'thrown') {
      if (input.firePressed && !fromVehicle) this.throwNow(p, input);
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
      // The press is kept until then and a little after, so frame timing cannot lose it.
      // On foot only: from a car, playerFire runs only while the button is held.
      if (!w.auto && !fromVehicle && input.firePressed && p.fireCooldown <= QUEUE_WINDOW) p.fireQueued = p.fireCooldown + QUEUE_WINDOW;
      return;
    }
    p.fireQueued = 0;
    slot.clip--;
    this.startCooldown(p, 1 / w.rate);
    p.shotTimer = 0.07;
    p.aimHold = 1.0;
    this.slotFor(p).progress.stats.shotsFired++;
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
      this.discharge(p, w, from, dx, dy, dz, w.spread * spreadMul, fromVehicle && p.vehicle ? null : this.muzzleWall(p, from));
    } finally {
      this.aimed = null;
    }
    // Shots from the cruiser on vigilante duty are the law's, not gunfire in the street (hits on anyone else still count).
    if (!(fromVehicle && this.onDuty(p))) this.sim.wanted.crime('gunfire', p.pos.x, p.pos.z, p);
    if (slot.clip === 0 && slot.ammo > 0) this.startReload(p);
  }

  /** The player throws the grenade or molotov in hand along his crosshair ray, when it is ready and he has one left. */
  private throwNow(p: Character, input: PlayerInput): void {
    if (p.fireCooldown > 0) return;
    const w = p.inventory.spec();
    const slot = p.inventory.slot();
    if (slot.ammo <= 0 && !p.inventory.infinite) {
      p.inventory.current = 'fists';
      this.sim.events.emit('message', { text: 'Out of ' + w.name + 's.', duration: 2 });
      return;
    }
    this.throws.throwFrom(p, input.aimDir);
    if (!p.inventory.infinite) slot.ammo--;
    this.startCooldown(p, 1 / w.rate);
    p.punchTimer = 0.32;
    p.meleeCombo = 0;
  }

  /** NPC shooting at a target character (or the vehicle it is in), on foot or from the vehicle it sits in. */
  npcFire(c: Character, target: Character, accuracy: number, fromVehicle = false): void {
    this.syncWeapon(c);
    const w = c.inventory.spec();
    if (!isGun(w.id) || c.fireCooldown > 0 || c.reloadTimer > 0) return;
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
    const tp = target.vehicle ? target.vehicle.pos : target.pos;
    const ty = target.vehicle ? tp.y + 0.9 : tp.y + target.height * 0.62;
    const fromWindow = fromVehicle && !!c.vehicle;
    // On foot the gun is raised at the target first, its barrel as drawn pointing through him, and the shot leaves from
    // its tip along it: the aim, the drawn gun, the flash and the tracer all agree.
    // (Knocked down, dead or getting in, nobody holds a gun up: those shots leave from muzzle() at the target.)
    const pose = !fromWindow && (upright(c) || c.state === 'swimming') ? this.raiseGun(c, tp.x, ty, tp.z) : null;
    const fx = Math.sin(c.aimYaw);
    const fz = Math.cos(c.aimYaw);
    let from: V3;
    let dx: number;
    let dy: number;
    let dz: number;
    let dist: number;
    const along = pose ? (tp.x - pose.tip.x) * pose.dir.x + (ty - pose.tip.y) * pose.dir.y + (tp.z - pose.tip.z) * pose.dir.z : 0;
    if (pose && along > 0 && !this.barrelCrowded(c, pose.tip, fx, fz)) {
      from = { x: pose.tip.x, y: pose.tip.y, z: pose.tip.z };
      dx = tp.x - from.x;
      dy = ty - from.y;
      dz = tp.z - from.z;
      dist = Math.hypot(dx, dy, dz) || 1;
      if (dist * dist - along * along <= RAISE_MISS * RAISE_MISS) {
        // The barrel runs through the target: along it, published as drawn.
        dx = pose.dir.x;
        dy = pose.dir.y;
        dz = pose.dir.z;
        this.aimAlong(c, dx, dy, dz);
      } else {
        // Steeper than the pose can raise the gun: from its tip straight at the target, drawn as near it as it goes.
        dx /= dist;
        dy /= dist;
        dz /= dist;
      }
    } else {
      // From a car window (a fixed muzzle), or with the barrel reaching into or past someone at point blank: the shot
      // then leaves from the chest (as in muzzle()), the gun still drawn pointing at the target.
      from = pose ? chestMuzzle(c, fx, fz) : this.muzzle(c, fromVehicle);
      dx = tp.x - from.x;
      dy = ty - from.y;
      dz = tp.z - from.z;
      dist = Math.hypot(dx, dy, dz) || 1;
      dx /= dist;
      dy /= dist;
      dz /= dist;
      // The gun held out of a car window points along the shot.
      if (!pose) this.aimAlong(c, dx, dy, dz);
    }
    const tSpeed = target.vehicle ? target.vehicle.speed : target.speed;
    const err = w.spread + (1 - accuracy) * 0.075 + tSpeed * 0.004 + dist * 0.0009;
    // From a car window there is no chest-to-muzzle wall check; on foot (also when asked for a car he has left) there is.
    this.discharge(c, w, from, dx, dy, dz, err, fromWindow ? null : this.muzzleWall(c, from));
    if (slot.clip === 0) this.startReload(c);
  }

  /**
   * What an NPC shooting at `target` must not fire through, null when the way is clear: someone up on his feet (or
   * swimming) for whom `spare` holds, from the muzzle up to the target (or at the muzzle, the shot leaving from inside
   * him), within LINE_CLEAR of the line across the ground there and LINE_SPREAD more per metre out, as far as the spread
   * of the shot reaches; and with `cover`, a vehicle other than his own in the way of his shot at a target on foot
   * (who takes cover behind it, or stands beyond the van the shooter guards), so his rounds would end in it: within
   * `pad` of it (by default LINE_CLEAR / 2, for the spread of the shot; 0 for the shot itself).
   */
  inLineOfFire(shooter: Character, target: Character, spare: (o: Character) => boolean, cover = false, pad = LINE_CLEAR / 2): Character | Vehicle | null {
    const sim = this.sim;
    const tp = target.vehicle ? target.vehicle.pos : target.pos;
    const m = this.muzzle(shooter, !!shooter.vehicle);
    const dx = tp.x - m.x;
    const dz = tp.z - m.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return null;
    for (const o of sim.characters) {
      if (o === shooter || o === target || o.removed || !o.alive || (o.state !== 'normal' && o.state !== 'swimming') || !spare(o)) continue;
      const ox = o.pos.x - m.x;
      const oz = o.pos.z - m.z;
      const along = (ox * dx + oz * dz) / len;
      if (along > -BODY_R && along < len && Math.abs(ox * dz - oz * dx) / len < LINE_CLEAR + Math.max(0, along) * LINE_SPREAD) return o;
    }
    if (!cover || target.vehicle) return null;
    // The shot itself, from the muzzle at his chest as npcFire aims it, kept `pad` clear of every vehicle.
    const dy = target.pos.y + target.height * 0.62 - m.y;
    const l = Math.hypot(dx, dy, dz);
    for (const v of sim.vehicles) {
      if (v.removed || v === shooter.vehicle || pointSegDist(v.pos.x, v.pos.z, m.x, m.z, tp.x, tp.z) > v.halfL + v.halfW + pad) continue;
      vehicleObb(v, obb);
      obb.hw += pad;
      obb.hl += pad;
      const t = rayObb3(m.x, m.y, m.z, dx / l, dy / l, dz / l, obb, v.pos.y, v.pos.y + v.spec.height + pad, l);
      if (t >= 0 && t < l - BODY_R) return v;
    }
    return null;
  }

  /**
   * Another player (on foot, or in his car) in the way of a police shot at `target`, null when the way is clear and
   * always in single player: within inLineOfFire's tolerance of the line from the muzzle to the target, and also of its
   * continuation as far as the shooter's weapon reaches, since a round that misses the target flies on and hits whoever
   * stands behind him. `beyond` tells which side of the target he is on.
   */
  bystanderInFire(shooter: Character, target: Character): { pos: { x: number; z: number }; beyond: boolean } | null {
    const sim = this.sim;
    if (sim.players.length < 2) return null;
    const tp = target.vehicle ? target.vehicle.pos : target.pos;
    const m = this.muzzle(shooter, !!shooter.vehicle);
    const dx = tp.x - m.x;
    const dz = tp.z - m.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return null;
    const reach = len + shooter.inventory.spec().range;
    for (const s of sim.players) {
      const o = s.character;
      if (o === target || s.down || !o.alive || o.removed) continue;
      const body = o.vehicle ?? o;
      if (o.vehicle && o.vehicle === target.vehicle) continue;
      if (!o.vehicle && o.state !== 'normal' && o.state !== 'swimming') continue;
      const ox = body.pos.x - m.x;
      const oz = body.pos.z - m.z;
      const along = (ox * dx + oz * dz) / len;
      const radius = o.vehicle ? (o.vehicle.halfL + o.vehicle.halfW) / 2 : LINE_CLEAR;
      if (along > -BODY_R && along < reach && Math.abs(ox * dz - oz * dx) / len < radius + Math.max(0, along) * LINE_SPREAD) return { pos: body.pos, beyond: along >= len };
    }
    return null;
  }

  /** Points a character's aim (yaw and pitch, as drawn and as the barrel tip follows) along (dx, dy, dz). */
  private aimAlong(c: Character, dx: number, dy: number, dz: number): void {
    const l = Math.hypot(dx, dy, dz);
    if (!(l > 1e-9)) return;
    c.aimYaw = Math.atan2(dx, dz);
    c.aimPitch = Math.asin(clamp(dy / l, -1, 1));
  }

  /**
   * Raises a foot shooter's gun at (x, y, z): points his aim so that the barrel as drawn (sim/pose.ts) runs through
   * that point, and returns that pose (a shared scratch object).
   * A gun turns about the shoulder: a long gun's stock sits in its pocket, the pistol swings with both arms about the
   * shoulder line, the launcher rests on it. The aim moves that pivot only a little (the chest turns and leans with it),
   * so each step aims from the barrel line's point beside the shoulder joint and converges quickly (see RAISE_STEPS).
   * Aiming from the tip instead swings it by the whole reach of the gun and overshoots within about 2 m.
   */
  private raiseGun(c: Character, x: number, y: number, z: number): WeaponPose {
    c.aiming = true;
    const w = raisePose;
    for (let k = 0; k < RAISE_STEPS; k++) {
      weaponPoseInto(c, w);
      const t = w.tip;
      const d = w.dir;
      const s = (w.shoulder.x - t.x) * d.x + (w.shoulder.y - t.y) * d.y + (w.shoulder.z - t.z) * d.z;
      const yaw = c.aimYaw;
      const pitch = c.aimPitch;
      this.aimAlong(c, x - (t.x + d.x * s), y - (t.y + d.y * s), z - (t.z + d.z * s));
      if (Math.abs(wrapAngle(c.aimYaw - yaw)) + Math.abs(c.aimPitch - pitch) < RAISE_SETTLED) break;
    }
    return weaponPoseInto(c, w);
  }

  /**
   * Holds an NPC's gun on `target` between shots, raised as npcFire raises it for each shot (the barrel through the
   * point it aims at), so the shot itself no longer swings it. Raised again only once the shooter, or the point he
   * aims at, has moved HOLD_ANGLE of the range between them (at most HOLD_MOVED), or his gun, his state or how he holds
   * it has changed, or something else has turned his aim. Brought in for a reload, the gun turns with the bearing to
   * the target instead (raising it then would point the reload pose instead); with fists, in a car, or down on the
   * ground he faces the plain bearing.
   */
  holdAim(c: Character, target: Character): void {
    const tp = target.vehicle ? target.vehicle.pos : target.pos;
    const ty = target.vehicle ? tp.y + 0.9 : tp.y + target.height * 0.62;
    const bearing = Math.atan2(tp.x - c.pos.x, tp.z - c.pos.z);
    c.aiming = true;
    if (c.vehicle || !isGun(c.inventory.current) || !(upright(c) || c.state === 'swimming')) {
      c.aimYaw = bearing;
      this.held.delete(c);
      return;
    }
    const reload = reloading(c) && !(c.shotTimer > 0);
    let h = this.held.get(c);
    if (h) {
      const tol = Math.min(HOLD_MOVED, HOLD_ANGLE * Math.hypot(tp.x - c.pos.x, ty - c.pos.y, tp.z - c.pos.z));
      const still =
        h.weapon === c.inventory.current &&
        h.state === c.state &&
        h.reload === reload &&
        h.yaw === c.aimYaw &&
        h.pitch === c.aimPitch &&
        Math.hypot(c.pos.x - h.x, c.pos.y - h.y, c.pos.z - h.z) < tol &&
        Math.hypot(tp.x - h.tx, ty - h.ty, tp.z - h.tz) < tol;
      if (still) return;
    }
    if (!reload) this.raiseGun(c, tp.x, ty, tp.z);
    else c.aimYaw = h ? wrapAngle(c.aimYaw + wrapAngle(bearing - h.bearing)) : bearing;
    if (!h) {
      h = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, bearing: 0, weapon: c.inventory.current, state: c.state, reload, yaw: 0, pitch: 0 };
      this.held.set(c, h);
    }
    h.x = c.pos.x;
    h.y = c.pos.y;
    h.z = c.pos.z;
    h.tx = tp.x;
    h.ty = ty;
    h.tz = tp.z;
    h.bearing = bearing;
    h.weapon = c.inventory.current;
    h.state = c.state;
    h.reload = reload;
    h.yaw = c.aimYaw;
    h.pitch = c.aimPitch;
  }

  /**
   * Starts the cooldown after a shot.
   * What the last frame overran the previous cooldown by counts towards this one (up to MAX_CARRY),
   * so weapons keep their rate of fire at any frame rate.
   */
  private startCooldown(c: Character, seconds: number): void {
    c.fireCooldown = Math.max(c.fireCooldown, -MAX_CARRY) + seconds;
    c.inventory.slot().readyAt = this.sim.time + c.fireCooldown;
  }

  /**
   * One trigger pull from `from` along (dx, dy, dz): a weaponFired event, then the rocket or one ray per pellet within `spread`.
   * A gun whose muzzle pokes through a wall (`wall`, see muzzleWall) fires into that wall instead:
   * the flash comes from the chest and every pellet stops at the wall face.
   */
  private discharge(shooter: Character, w: WeaponSpec, from: V3, dx: number, dy: number, dz: number, spread: number, wall: RayHit | null): void {
    const sim = this.sim;
    if (wall) {
      const ax = shooter.pos.x;
      const ay = shooter.pos.y + CHEST * shooter.height;
      const az = shooter.pos.z;
      sim.events.emit('weaponFired', { shooter, weapon: w.id, x: ax, y: ay, z: az, dx, dy, dz, pellets: w.pellets, ...this.tagOf(shooter) });
      for (let i = 0; i < w.pellets; i++) {
        sim.events.emit('shot', { shooter, weapon: w.id, fx: ax, fy: ay, fz: az, tx: wall.x, ty: wall.y, tz: wall.z, hit: 'world', nx: wall.nx, ny: wall.ny, nz: wall.nz, pellet: i, ...this.tagOf(shooter) });
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
    sim.events.emit('weaponFired', { shooter, weapon: w.id, x: from.x, y: from.y, z: from.z, dx, dy, dz, pellets: w.pellets, ...this.tagOf(shooter) });
    if (w.projectile) {
      this.launchRocket(shooter, from, dx, dy, dz);
      return;
    }
    this.volley = new Set();
    this.headshotsThisPull = new Set();
    try {
      for (let i = 0; i < w.pellets; i++) {
        const d = this.spread(dx, dy, dz, spread);
        this.fireRay(shooter, from, d.x, d.y, d.z, w, i);
      }
    } finally {
      this.volley = null;
      this.headshotsThisPull = null;
    }
  }

  /**
   * The wall face between a character's chest and his muzzle, when the gun pokes through a solid wall
   * (building, wall, container, pillar); null when the muzzle is clear.
   * The hit is a shared scratch object.
   */
  private muzzleWall(c: Character, muzzle: V3): RayHit | null {
    return this.sim.world.grid.lineOfSight(c.pos.x, c.pos.y + CHEST * c.height, c.pos.z, muzzle.x, muzzle.y, muzzle.z, wallHit) ? null : wallHit;
  }

  /**
   * True when a shot fired now on foot would come from inside a wall, so it would only hit that wall.
   * Firing raises the gun towards the aim (muzzle() follows `aiming`), wherever the body faces at the moment.
   */
  muzzleBlocked(c: Character): boolean {
    const aiming = c.aiming;
    c.aiming = true;
    try {
      return this.muzzleWall(c, this.muzzle(c, false)) !== null;
    } finally {
      c.aiming = aiming;
    }
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
   * a van the camera has backed into, or a car or person between the camera and the player,
   * would otherwise be shot from the muzzle backwards.
   */
  cameraTarget(o: V3, d: V3, range: number, shooter: Character, muzzle: V3): AimPoint {
    const t0 = Math.max(0, (muzzle.x - o.x) * d.x + (muzzle.y - o.y) * d.y + (muzzle.z - o.z) * d.z);
    const far = t0 + range + 12;
    const r = this.castRay(o.x, o.y, o.z, d.x, d.y, d.z, far, shooter, t0);
    // A prop the ray is inside at the muzzle's depth gives no direction: aim along the crosshair.
    const t = r.kind === 'none' || r.t <= t0 ? far : r.t;
    const c = r.character;
    const flat = d.x * d.x + d.z * d.z;
    if (c && flat > 1e-9) {
      const crouch = this.crouched(c);
      const b = bodyOf(c, crouch);
      // Where the crosshair ray reaches the cylinder he fills as a whole (his head volume is narrower).
      const te = rayCylinderY(o.x, o.y, o.z, d.x, d.y, d.z, b.x, b.z, b.r, b.y0, b.y1, t);
      // Just past the muzzle, where the crosshair ray enters someone is the edge of him as seen from the muzzle,
      // and shots there graze past.
      // Shoot through his middle instead (where the crosshair ray passes nearest his axis),
      // aimed at the spot where that line from the muzzle enters the zone the crosshair is on (head or body)
      // at the crosshair's height on him.
      // Aiming at a point inside him would land the shot lower, as the muzzle is below the camera.
      // The spot stays inside the zone's top and bottom (0.1 m, less in the head) so that pellets do not fly over his head.
      // With the muzzle above his top (he lies on the ground, or is below the shooter) that line would run down his side
      // into the road, so the shot goes to the crosshair's point on his top instead.
      if ((te >= 0 ? te : t) - t0 < 2 * b.r && muzzle.y < b.y1) {
        const v = zoneOf(c, r.zone, crouch);
        const tm = Math.max(t, ((v.x - o.x) * d.x + (v.z - o.z) * d.z) / flat);
        const ux = o.x + d.x * tm - muzzle.x;
        const uz = o.z + d.z * tm - muzzle.z;
        const l = Math.hypot(ux, uz);
        // How far that line runs (on the ground plane) before it reaches the zone; 0 with the muzzle inside it.
        const s = l > 1e-6 ? rayCylinderY(muzzle.x, 0, muzzle.z, ux / l, 0, uz / l, v.x, v.z, v.r, -1, 1, l) : -1;
        if (s > 0) {
          // Where the crosshair ray enters the zone: at point blank that is short of t, which castRay moves on to the muzzle's depth.
          const tv = rayCylinderY(o.x, o.y, o.z, d.x, d.y, d.z, v.x, v.z, v.r, v.y0, v.y1, t);
          const m = Math.min(0.1, (v.y1 - v.y0) / 4);
          const y = clamp(o.y + d.y * (tv >= 0 ? tv : t), v.y0 + m, v.y1 - m);
          return { x: muzzle.x + (ux / l) * s, y, z: muzzle.z + (uz / l) * s, character: c, zone: r.zone };
        }
      }
    }
    return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t, character: c, zone: r.zone };
  }

  /**
   * Someone standing whom the crosshair ray (from `o` along the unit `d`) is on, looking from the shooter's own depth
   * along it out to `range` past that, and the point of the ray nearest his axis (where the shot through him goes, see
   * cameraTarget); null when the ray meets anything else first, or nothing. Things between the camera and the shooter
   * are passed over.
   */
  crosshairPerson(o: V3, d: V3, range: number, shooter: Character): V3 | null {
    const t0 = Math.max(0, (shooter.pos.x - o.x) * d.x + (shooter.pos.y + CHEST * shooter.height - o.y) * d.y + (shooter.pos.z - o.z) * d.z);
    const r = this.castRay(o.x, o.y, o.z, d.x, d.y, d.z, t0 + range, shooter, t0);
    const c = r.character;
    const flat = d.x * d.x + d.z * d.z;
    if (!c || !onFeet(c) || !(flat > 1e-9)) return null;
    const t = Math.max(r.t, ((c.pos.x - o.x) * d.x + (c.pos.z - o.z) * d.z) / flat);
    return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
  }

  /**
   * Nearest hit along a ray against world, vehicles, characters and helicopters. Nothing nearer than
   * `minT` counts: the world is cast from there, and anything else the ray entered before it is skipped,
   * except a person who stands past it. The dead count too: the crosshair on a body on the ground is on him.
   */
  castRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, range: number, ignore: Character | null, minT = 0): RayResult {
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
      // Someone climbing into a car is still on his feet beside it: hit as standing.
      if (c.removed || c === ignore || c.state === 'inVehicle') continue;
      const cx = c.pos.x - ox;
      const cz = c.pos.z - oz;
      const along = cx * dx + cz * dz;
      const down = lying(c);
      const span = down ? 2 : 1;
      if (along < -span || along > res.t + span) continue;
      let t: number;
      let zone: HitZone = 'body';
      const crouch = this.crouched(c);
      const standing = onFeet(c) && !crouch;
      if (down) {
        const l = lyingHit(c, ox, oy, oz, dx, dy, dz, res.t);
        t = l.t;
        zone = l.zone;
      } else if (standing) {
        // Standing: a body cylinder up to the shoulders and a narrower head on top; the nearer hit counts.
        const neck = c.pos.y + NECK * c.height;
        t = rayCylinderY(ox, oy, oz, dx, dy, dz, c.pos.x, c.pos.z, BODY_R, c.pos.y, neck, res.t);
        const th = rayCylinderY(ox, oy, oz, dx, dy, dz, c.pos.x, c.pos.z, HEAD_R, neck, c.pos.y + c.height, res.t);
        if (th >= 0 && (t < 0 || th < t)) {
          t = th;
          zone = 'head';
        }
      } else {
        const b = bodyOf(c, crouch);
        t = rayCylinderY(ox, oy, oz, dx, dy, dz, b.x, b.z, b.r, b.y0, b.y1, res.t);
      }
      // At point blank the crosshair ray enters someone in front of the player before the muzzle's depth:
      // a person counts by where he stands (the ray's closest approach to his axis), and is hit just past it.
      // One level with the muzzle, his axis up to his radius short of its depth, still counts when he stands
      // wholly in front of the shooter; beside or behind the shooter's shoulder he is out of the gun's way.
      if (minT > 0 && t >= 0) {
        const tc = flat > 1e-9 ? along / flat : -1;
        let reach = tc >= minT;
        if (!reach && ignore && flat > 1e-9) {
          const r = standing ? BODY_R : bodyOf(c, crouch).r;
          const ahead = ((c.pos.x - ignore.pos.x) * dx + (c.pos.z - ignore.pos.z) * dz) / Math.sqrt(flat);
          reach = tc >= minT - r && ahead >= r;
        }
        t = reach ? Math.max(t, minT + 1e-3) : -1;
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
      // The gun sits below the eyes, so on its way to the head under the crosshair a round can clip that man's shoulder first
      // (at close range nearly always).
      // A round still on course for that head is the headshot aimed.
      const aimed = this.aimed;
      if (zone === 'body' && aimed && aimed.character === c && aimed.zone === 'head' && onFeet(c) && !this.crouched(c)) {
        const head = zoneOf(c, 'head');
        if (rayCylinderY(from.x, from.y, from.z, dx, dy, dz, c.pos.x, c.pos.z, head.r, head.y0, head.y1, w.range) >= 0) zone = 'head';
      }
      let dmg = w.damage;
      if (zone === 'head') {
        const mul = shooter.isPlayer ? w.headMul : NPC_HEAD_MUL;
        dmg *= c.role === 'swat' ? Math.max(1, mul * HELMET) : mul;
        if (shooter.isPlayer && c.alive && !this.headshotsThisPull?.has(c)) {
          this.slotFor(shooter).progress.stats.headshots++;
          this.headshotsThisPull?.add(c);
        }
      }
      if (w.id === 'shotgun' && r.t < 8) dmg *= 1.3;
      if (!shooter.isPlayer && c.isPlayer) dmg *= NPC_ON_PLAYER;
      // A hit that does no damage (god mode, the player while down) draws no blood.
      if (this.damageCharacter(c, dmg, shooter, 'bullet', dx, dy, dz, zone)) sim.events.emit('blood', { x: tx, y: ty, z: tz, dx, dy, dz });
    } else if (r.vehicle) {
      const mult = shooter.isPlayer ? 1.4 : 0.8;
      this.damageVehicle(r.vehicle, w.damage * mult, shooter, 'bullet');
    } else if (r.heli >= 0) {
      const h = sim.helis[r.heli]!;
      h.health -= w.damage * (shooter.isPlayer ? 1.2 : 0);
      if (shooter.isPlayer) h.shotBy = shooter;
      if (shooter.isPlayer) this.reportAttack(h, 'assaultCop', h.pos.x, h.pos.z, shooter);
    }
    sim.events.emit('shot', { shooter, weapon: w.id, fx: from.x, fy: from.y, fz: from.z, tx, ty, tz, hit: r.kind, nx: r.nx, ny: r.ny, nz: r.nz, pellet, ...this.tagOf(shooter) });
  }

  /**
   * A punch, or a swing of the bat or knife in hand. A swing made soon after the last one was ready again chains on it
   * (MeleeSpec.combo) and is ready again sooner.
   */
  melee(c: Character): void {
    const sim = this.sim;
    this.syncWeapon(c);
    if (c.fireCooldown > 0) return;
    const id: WeaponId = weaponKindOf(c.inventory.current) === 'melee' ? c.inventory.current : 'fists';
    const w = WEAPONS[id];
    const m = w.melee;
    let cooldown = 1 / w.rate;
    if (m) {
      if (sim.time <= c.comboUntil) cooldown *= m.combo.mul;
      c.comboUntil = sim.time + cooldown + m.combo.gap;
    }
    c.fireCooldown = cooldown;
    c.inventory.slot().readyAt = sim.time + c.fireCooldown;
    c.punchTimer = 0.32;
    c.meleeCombo = (c.meleeCombo + 1) % 3;
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    let best: Character | null = null;
    let bd = id === 'fists' ? 1.75 : w.range;
    for (const o of sim.characters) {
      if (o === c || o.removed || !o.alive || (o.state !== 'normal' && o.state !== 'knocked')) continue;
      // Gang members crowding the player never punch each other.
      if (sim.peds.allied(c, o)) continue;
      const dx = o.pos.x - c.pos.x;
      const dz = o.pos.z - c.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bd || Math.abs(o.pos.y - c.pos.y) > 1.2) continue;
      if (d > 0.3 && (dx * fx + dz * fz) / d < 0.45) continue;
      // Not through a wall (the thin garage walls put two people 1.3 m apart on either side): the fist must reach his
      // chest from the shoulder.
      if (!sim.world.lineOfSight(c.pos.x, c.pos.y + SHOULDER * c.height, c.pos.z, o.pos.x, o.pos.y + (o.state === 'knocked' ? 0.3 : CHEST * o.height), o.pos.z)) continue;
      best = o;
      bd = d;
    }
    const hx = c.pos.x + fx * 0.8;
    const hz = c.pos.z + fz * 0.8;
    if (best) {
      const dmg = w.damage * (c.isPlayer ? 1 : 0.7);
      // Only blows to a man on his feet, past his first moments back up, build up to a knockdown: on the ground, or
      // just up, he takes the damage and the shove. A bat floors him with every such blow.
      const counts = best.state === 'normal' && !(best.getUpTimer > 0);
      if (counts) {
        best.staggerHits++;
        best.meleeComboTimer = 2;
      }
      const spared = best.isPlayer && m?.knockdown === true && (this.slotFor(best).cheats.godMode || this.slotFor(best).down);
      if (counts && !spared && (best.staggerHits >= 3 || m?.knockdown)) {
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
      const hurt = this.damageCharacter(best, dmg, c, 'melee', fx, 0, fz);
      if (hurt && m?.bleed && best.alive) {
        best.bleedTimer = m.bleed.seconds;
        best.bleedRate = m.bleed.dps;
        best.bleedBy = c;
      }
      // A bat or a blade draws blood; a hit that does no damage (god mode) does not.
      if (hurt && id !== 'fists') sim.events.emit('blood', { x: best.pos.x - fx * 0.3, y: best.pos.y + (best.state === 'knocked' ? 0.4 : best.height * 0.7), z: best.pos.z - fz * 0.3, dx: fx, dy: 0, dz: fz });
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
   * Applies a hit (armour first, except for falls and drowning) and emits a 'damage' event for it,
   * also when the armour took all of it.
   * Ignored, with no event, on the dead, the removed, and the player in god mode or while wasted / busted.
   * (dx, dz) is the direction the hit travels in. `credit` is who answers for a death by a hit with no attacker (the
   * flames of a car someone set alight): it counts for the kill only, not for the hit or the victim's reaction to it.
   * Returns whether the hit was applied.
   */
  damageCharacter(c: Character, amount: number, attacker: Character | null, kind: DamageKind, dx: number, _dy: number, dz: number, zone: HitZone = 'body', credit: Character | null = null): boolean {
    const sim = this.sim;
    if (c.removed || !c.alive || !(amount > 0)) return false;
    if (c.isPlayer && this.slotFor(c).down) return false;
    if (c.isPlayer && this.slotFor(c).cheats.godMode) return false;
    // A stray round or blast (a cruiser the chase shot burning) of the police after one player never hurts another.
    if (attacker?.isLaw && c.isPlayer && sim.players.length > 1 && sim.police.targetSlotOf(attacker) !== this.slotFor(c).id) return false;
    // One crew never hurts its own (a stray round or a punch in the crowd round the player): no damage, no blood.
    if (attacker && !attacker.isPlayer && !c.isPlayer && sim.peds.allied(c, attacker)) return false;
    let armourLoss = 0;
    if (c.armor > 0 && kind !== 'fall' && kind !== 'drown') {
      armourLoss = Math.min(c.armor, amount);
      c.armor -= armourLoss;
      amount -= armourLoss;
    }
    const healthLoss = Math.min(amount, Math.max(0, c.health));
    c.health -= amount;
    c.hurtTimer = 0.35;
    c.lastHitBy = attacker;
    if (attacker && attacker !== c) {
      c.lastAttacker = attacker;
      c.lastAttackTime = sim.time;
    }
    const killed = c.health <= 0;
    const hl = Math.hypot(dx, dz);
    const dir = Number.isFinite(hl) && hl > 1e-9;
    const dirX = dir ? dx / hl : 0;
    const dirZ = dir ? dz / hl : 0;
    sim.events.emit('damage', { victim: c, attacker, healthLoss, armourLoss, kind, zone, killed, dirX, dirZ, ...this.tagOf(attacker) });
    if (killed) {
      this.kill(c, attacker ?? credit, kind, dx, dz);
      return true;
    }
    if (attacker && attacker.isPlayer && !c.isPlayer && !this.isOutlaw(c)) {
      if (c.isLaw) this.reportAttack(c, 'assaultCop', c.pos.x, c.pos.z, attacker);
      else if (kind === 'melee' || kind === 'bullet') this.reportAttack(c, 'assault', c.pos.x, c.pos.z, attacker);
    }
    if (!c.isPlayer && !this.lingering) {
      if (c.isLaw) sim.police.onCopAttacked(c, attacker);
      else sim.peds.onAttacked(c, attacker);
    }
    return true;
  }

  /**
   * Reports the player attacking `victim`. The pellets of one shot are one crime per victim, and so are
   * hits by one culprit on one victim within ASSAULT_GAP of the last reported one: automatic fire adds heat no faster
   * than the pistol does.
   */
  reportAttack(victim: object, type: CrimeType, x: number, z: number, by: Character): void {
    if (this.volley) {
      if (this.volley.has(victim)) return;
      this.volley.add(victim);
    }
    let byVictim = this.assaulted.get(by);
    if (!byVictim) this.assaulted.set(by, (byVictim = new WeakMap()));
    const last = byVictim.get(victim);
    if (last !== undefined && this.sim.time - last < ASSAULT_GAP) return;
    byVictim.set(victim, this.sim.time);
    this.sim.wanted.crime(type, x, z, by);
  }

  /** The playerId of a world event a player's action caused (none for slot 0's, or nobody's). */
  private tagOf(c: Character | null | undefined): { playerId?: number } {
    return (c && c.isPlayer ? this.sim.slotOf(c)?.tag : undefined) ?? {};
  }

  /** The slot of a player character; a stray 'player' character outside any slot counts for slot 0. */
  private slotFor(c: Character): PlayerSlot {
    return this.sim.slotOf(c) ?? this.sim.players[0]!;
  }

  /** A cowering civilian crouched as CrowdView draws him (hit by CROUCH_TOP's volume). */
  private crouched(c: Character): boolean {
    return cowerCrouched(c, this.sim.nearestPlayer(c.pos.x, c.pos.z).character);
  }

  /** A vigilante suspect or his car (see outlaws): the player's attacks on them are no crime. */
  isOutlaw(o: Character | Vehicle): boolean {
    return o.missionTag === 'vigilante' || this.outlaws.has(o);
  }

  /**
   * Keeps `outlaws` in step with the vigilante job: its suspect and his car while it hunts them, and for good once
   * they are stopped (his car wrecked or left, or he is dead: what the job counts as a stop). A job that lets them go
   * without one (out of time, he got away, the player quit or left the cruiser) hands back ordinary people.
   */
  private followVigilante(): void {
    const job = this.sim.activities.job;
    const car = job?.kind === 'vigilante' ? job.target : null;
    const suspect = job?.kind === 'vigilante' ? job.suspect : null;
    const h = this.hunted;
    if (h.car && h.car !== car) {
      const t = h.car;
      const stopped = t.destroyed || t.removed || !t.driver || !t.driver.alive;
      if (!stopped) {
        this.outlaws.delete(t);
        if (h.suspect && h.suspect !== suspect) this.outlaws.delete(h.suspect);
      }
    }
    h.car = car;
    h.suspect = suspect;
    if (car) this.outlaws.add(car);
    if (suspect) this.outlaws.add(suspect);
  }

  /** The player is on vigilante duty: at the wheel of the job's police car. */
  private onDuty(p: Character): boolean {
    const job = this.sim.activities.job;
    return job?.kind === 'vigilante' && !!p.vehicle && p.vehicle === job.car;
  }

  /** Who answers for what `v` does when it burns out or blows up: its culprit, but nobody for a vigilante suspect's wreck. */
  private blameFor(v: Vehicle): Character | null {
    return this.isOutlaw(v) ? null : (this.damagedBy.get(v) ?? null);
  }

  /**
   * Forgets `c` as the culprit of every vehicle he damaged. On the respawn: crimes and credit from a previous life are
   * void, and a car he set alight before he died (or a rocket he fired then lit) no longer charges him when it blows up.
   */
  forgetCulprit(c: Character): void {
    for (const v of this.sim.vehicles) if (this.damagedBy.get(v) === c) this.damagedBy.delete(v);
  }

  kill(c: Character, killer: Character | null, kind: DamageKind, dx: number, dz: number): void {
    const sim = this.sim;
    if (!c.alive) return;
    c.health = Math.min(0, c.health);
    if (c.vehicle) {
      const v = c.vehicle;
      const door = seatExit(v, c.seat, v.halfW + 0.7);
      sim.unseat(c);
      const spot = sim.world.findFreeSpot(door.x, door.z, 0.4, 6, true) ?? { x: v.pos.x, z: v.pos.z };
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
      sim.playerDied(this.slotFor(c));
    } else {
      if (killer && killer.isPlayer) {
        const stats = this.slotFor(killer).progress.stats;
        stats.kills++;
        if (c.isLaw) {
          stats.copsKilled++;
          sim.wanted.crime('killCop', c.pos.x, c.pos.z, killer);
        } else if (this.isOutlaw(c)) {
          // The vigilante's suspect: stopped for the law.
        } else if (c.role === 'gang' || c.missionTag === 'enemy') {
          sim.wanted.crime('killGang', c.pos.x, c.pos.z, killer);
        } else {
          sim.wanted.crime('murder', c.pos.x, c.pos.z, killer);
        }
      }
      if (c.cash > 0) sim.pickupSys.dropMoney(c.pos.x, c.pos.z, c.cash);
      c.cash = 0;
      if (c.owner === 'traffic') c.owner = 'ped';
    }
    sim.events.emit('characterKilled', { victim: c, killer, ...this.tagOf(killer) });
  }

  damageVehicle(v: Vehicle, amount: number, attacker: Character | null, kind: DamageKind): void {
    if (v.destroyed || v.removed || !(amount > 0)) return;
    if (this.sim.slotOf(v.driver)?.cheats.godMode) return;
    v.health -= amount;
    const blowsUp = kind === 'explosion' && v.health < -v.spec.health * 0.35;
    // Who set it alight answers for it: a later hit takes that over only by blowing it up there and then
    // (a stray round on a car someone else lit does not).
    if (attacker && (!v.burning || blowsUp)) this.damagedBy.set(v, attacker);
    if (attacker && attacker.isPlayer && v.spec.police && kind === 'bullet') this.reportAttack(v, 'assaultCop', v.pos.x, v.pos.z, attacker);
    if (v.driver && !v.driver.isPlayer && v.driver.brain && attacker) v.driver.brain.threat = attacker;
    if (blowsUp) {
      this.explodeVehicle(v);
      return;
    }
    if (v.health <= 0 && !v.burning) this.igniteVehicle(v, this.sim.rng.range(3.5, 5.5));
  }

  /** Sets the vehicle alight as the doing of the one given (a molotov's flames): he answers for it when it burns out or blows up. */
  igniteVehicleBy(v: Vehicle, seconds: number, by: Character | null): void {
    if (v.destroyed || v.burning || this.sim.slotOf(v.driver)?.cheats.godMode) return;
    if (by) this.damagedBy.set(v, by);
    this.igniteVehicle(v, seconds);
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
    const blame = this.blameFor(v);
    v.destroyed = true;
    v.burning = false;
    v.health = -v.spec.health;
    v.wreckTime = 0;
    v.siren = false;
    v.ai = null;
    for (const o of v.occupants()) this.damageCharacter(o, 1000, blame, 'explosion', 0, 1, 0);
    launchVehicle(v, 0, 0, 6.5, 2.5);
    if (culprit && culprit.isPlayer) {
      this.slotFor(culprit).progress.stats.vehiclesDestroyed++;
      if (blame) sim.wanted.crime(v.spec.police ? 'destroyPolice' : 'destroyVehicle', v.pos.x, v.pos.z, culprit);
    }
    sim.events.emit('vehicleDestroyed', { vehicle: v });
    this.explosion(v.pos.x, v.pos.y + 0.8, v.pos.z, 7.5, 360, blame, v);
  }

  /**
   * A blast at (x, y, z). With water set it goes off in the sea (a rocket or a grenade there), which is no crime of
   * itself: only one that catches someone or something is reported.
   */
  explosion(x: number, y: number, z: number, radius: number, damage: number, owner: Character | null, source: Vehicle | null, water = false): void {
    const sim = this.sim;
    sim.events.emit('explosion', { x, y, z, radius });
    let caught = false;
    for (const c of sim.characters) {
      if (c.removed || c.state === 'inVehicle') continue;
      const dx = c.pos.x - x;
      const dy = c.pos.y + 1 - y;
      const dz = c.pos.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      if (c !== owner) caught = true;
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
      caught = true;
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
      if (d < radius * 1.6) {
        h.health -= damage * 3 * (1 - d / (radius * 1.6));
        if (owner && owner.isPlayer) h.shotBy = owner;
      }
    }
    if (owner && owner.isPlayer && (!water || caught)) sim.wanted.crime('explosion', x, z, owner);
    sim.peds.onViolence(x, z, owner, 60);
  }

  /**
   * How much of a character a blast at (x, y, z) sees:
   * line of sight from just above it to his feet, middle and head (0.3, 1.0 and 1.6 m up),
   * as a share of the three, but at least a quarter.
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
    this.sim.events.emit('shot', { shooter: owner, weapon: 'rocket', fx: from.x, fy: from.y, fz: from.z, tx: from.x + dx, ty: from.y + dy, tz: from.z + dz, hit: 'none', nx: 0, ny: 1, nz: 0, pellet: 0, ...this.tagOf(owner) });
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
      // Into the sea before it hits anything: it goes off at the surface rather than flying on under it.
      if (dy < 0 && p.pos.y > WATER_Y) {
        const tw = (p.pos.y - WATER_Y) / -dy;
        const wx = p.pos.x + dx * tw;
        const wz = p.pos.z + dz * tw;
        if (tw <= step && (r.kind === 'none' || tw < r.t) && sim.world.waterDepth(wx, wz) > 0) {
          p.removed = true;
          sim.events.emit('splash', { x: wx, y: WATER_Y, z: wz, big: true });
          this.explosion(wx, WATER_Y, wz, ROCKET_BLAST, WEAPONS.rocket.damage, p.owner, null, true);
          continue;
        }
      }
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
        // Out of his own door: each on his seat's side and row, not all at one spot by the driver's.
        const door = seatExit(v, o.seat, v.halfW + 0.8);
        sim.unseat(o);
        const spot = sim.world.findFreeSpot(door.x, door.z, 0.4, 6) ?? door;
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
      // Whoever set it alight answers for a death in its flames (the flames are no attack: hurt, people run from the fire).
      const credit = this.blameFor(v);
      for (const c of sim.characters) {
        if (c.removed || !c.alive || c.state === 'inVehicle') continue;
        const d = Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z);
        if (d < v.halfL + 0.4 && Math.abs(c.pos.y - v.pos.y) < 2) {
          this.damageCharacter(c, 22 * dt, null, 'fire', 0, 0, 0, 'body', credit);
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

/**
 * Where a shot on foot leaves when the barrel tip is no use (fists, or someone standing along the barrel at point
 * blank): from the chest, 0.55 m ahead along (fx, fz) and 0.18 m to the right, at 0.76 of the height, where a punch lands.
 */
function chestMuzzle(c: Character, fx: number, fz: number): V3 {
  return { x: c.pos.x + fx * 0.55 - fz * 0.18, y: c.pos.y + c.height * 0.76, z: c.pos.z + fz * 0.55 + fx * 0.18 };
}

/**
 * Where the occupant of seat `seat` comes out of `v`: beside his own door, on his seat's side (pose.seatSide), `across`
 * m from the centre line, level with his row (the rear seats 0.9 m back), as Sim.syncOccupant seats him.
 */
function seatExit(v: Vehicle, seat: number, across: number): { x: number; z: number } {
  const side = seatSide(seat) * across;
  const back = seat >= 2 ? -0.9 : 0.15;
  const sx = Math.cos(v.heading);
  const sz = -Math.sin(v.heading);
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  return { x: v.pos.x + sx * side + fx * back, z: v.pos.z + sz * side + fz * back };
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
