// Thrown weapons in flight: grenades (bounce, then blow up when the fuse runs out) and molotovs (break on the first
// thing they hit and set it alight). The same stepping draws the aiming arc (predictThrow), so the preview ends where the
// throw lands.

import { rayCylinderY, rayObb3, type OBB } from '../core/collision';
import { clamp, type V3 } from '../core/math';
import { makeRayHit } from '../world/colliders';
import { WATER_Y } from '../world/constants';
import type { StaticWorld } from '../world/staticWorld';
import type { Character, Vehicle } from './entities';
import type { Sim } from './sim';
import { WEAPONS, type ThrownSpec, type WeaponId } from './specs';
import { vehicleObb } from './vehiclePhysics';

export const THROW_GRAVITY = 9.81;
/** Share of the speed into a surface a bounce gives back, and of the speed along it that a bounce keeps. */
export const BOUNCE_RESTITUTION = 0.38;
export const BOUNCE_FRICTION = 0.65;
/** Deceleration (m/s^2) of a grenade rolling or sliding on the ground. */
const ROLL_DECEL = 5;
/** Below this speed into the ground a grenade stops bouncing and rolls. */
const SETTLE_SPEED = 1.2;
/** Integration step (s): fine enough not to tunnel through a kerb or a car's side at throwing speeds. */
const STEP = 1 / 120;
/** A throw cannot hit its thrower for this long (s). */
const ARMING = 0.2;
/** Sinking speed (m/s) of a grenade in the sea, down to its floor (or SINK_DEPTH below the surface). */
const SINK_SPEED = 1.5;
const SINK_DEPTH = 1.2;
/** The arc preview runs for at most this long (s). */
const PREVIEW_TIME = 4;

const hit = makeRayHit();
const obb: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };

export class Thrown {
  removed = false;
  /** Seconds since the throw. */
  age = 0;
  bounces = 0;
  inWater = false;
  /** Lying still on the ground (a grenade waiting for its fuse). */
  resting = false;
  /** Where and when (age) a molotov broke, or the grenade blew up. */
  doneAt = -1;
  constructor(
    readonly id: number,
    readonly weapon: WeaponId,
    readonly pos: V3,
    readonly vel: V3,
    readonly owner: Character | null,
  ) {}

  get spec(): ThrownSpec {
    return WEAPONS[this.weapon].thrown!;
  }
}

/** What one step of a throw ran into (shared scratch object). */
export interface ThrowContact {
  kind: 'none' | 'world' | 'ground' | 'vehicle' | 'character' | 'water';
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  vehicle: Vehicle | null;
  character: Character | null;
}

function makeContact(): ThrowContact {
  return { kind: 'none', x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, vehicle: null, character: null };
}

/** The world a throw moves through: the city, its vehicles and (for a molotov) its people. */
export interface ThrowWorld {
  readonly world: StaticWorld;
  readonly vehicles: readonly Vehicle[];
  readonly characters: readonly Character[];
}

/**
 * Where a throw by `c` leaves the hand and how fast, aimed along the unit `dir` (the crosshair ray): from over his right
 * shoulder, its pitch raised by the spec's loft. Pure, so the arc preview and the throw agree.
 */
export function throwLaunch(world: StaticWorld, c: Character, dir: V3, spec: ThrownSpec): { pos: V3; vel: V3 } {
  const yaw = Math.atan2(dir.x, dir.z);
  const pitch = clamp(Math.asin(clamp(dir.y, -1, 1)) + spec.loft, -0.7, 1.25);
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  // Right of the aim is (-fz, fx).
  const chest = { x: c.pos.x, y: c.pos.y + c.height * 0.75, z: c.pos.z };
  let pos = { x: c.pos.x + fx * 0.25 - fz * 0.22, y: c.pos.y + c.height * 0.92, z: c.pos.z + fz * 0.25 + fx * 0.22 };
  // Never from the far side of a wall he stands against.
  if (!world.lineOfSight(chest.x, chest.y, chest.z, pos.x, pos.y, pos.z)) pos = chest;
  const cp = Math.cos(pitch);
  return { pos, vel: { x: fx * cp * spec.speed, y: Math.sin(pitch) * spec.speed, z: fz * cp * spec.speed } };
}

/**
 * Moves a throw at `pos` with `vel` on by `h` seconds against `w`, bouncing off what it meets (grenade) or stopping at
 * it (`stopAtFirst`, a molotov and the preview). `ignore` is a character it passes through (its thrower while arming);
 * characters only stop it with `hitPeople`. Returns what it ran into this step ('none' while in the air or rolling).
 */
export function stepThrow(w: ThrowWorld, pos: V3, vel: V3, h: number, state: { resting: boolean; bounces: number }, stopAtFirst: boolean, hitPeople: boolean, ignore: Character | null, out: ThrowContact = makeContact()): ThrowContact {
  out.kind = 'none';
  out.vehicle = null;
  out.character = null;
  const world = w.world;
  if (state.resting) {
    // Rolling to a stop on the ground (a grenade waiting for its fuse).
    const sp = Math.hypot(vel.x, vel.z);
    const k = sp > 1e-6 ? Math.max(0, sp - ROLL_DECEL * h) / sp : 0;
    vel.x *= k;
    vel.z *= k;
    vel.y = 0;
    const nx = pos.x + vel.x * h;
    const nz = pos.z + vel.z * h;
    const gy = world.groundHeight(nx, nz);
    if (Math.abs(gy - pos.y) < 0.35 && world.isFree(nx, nz, 0.05)) {
      pos.x = nx;
      pos.z = nz;
      pos.y = gy;
    } else {
      vel.x = 0;
      vel.z = 0;
    }
    if (world.waterDepth(pos.x, pos.z) > 0 && pos.y <= WATER_Y) contact(out, 'water', pos.x, WATER_Y, pos.z, 0, 1, 0);
    return out;
  }
  // Exact under constant gravity: the step covers the average of its start and end vertical speeds.
  const vy0 = vel.y;
  vel.y -= THROW_GRAVITY * h;
  const sx = vel.x * h;
  const sy = ((vy0 + vel.y) / 2) * h;
  const sz = vel.z * h;
  const len = Math.hypot(sx, sy, sz);
  if (!(len > 1e-9)) return out;
  const dx = sx / len;
  const dy = sy / len;
  const dz = sz / len;
  let best = len;
  if (world.grid.raycast(pos.x, pos.y, pos.z, dx, dy, dz, len, hit)) {
    best = hit.t;
    contact(out, 'world', pos.x + dx * hit.t, pos.y + dy * hit.t, pos.z + dz * hit.t, hit.nx, hit.ny, hit.nz);
  }
  // The ground (roads, kerbs, decks, sand): where the step's height drops under the ground at its end.
  const ex = pos.x + sx;
  const ez = pos.z + sz;
  const gEnd = world.groundHeight(ex, ez);
  if (pos.y + sy < gEnd) {
    const g0 = world.groundHeight(pos.x, pos.z);
    // From above the ground (a kerb's or a deck's edge in the way counts as a wall-like face of it).
    const above = pos.y - gEnd;
    const t = above > 0 && dy < 0 ? clamp(above / -dy, 0, len) : 0;
    if (t < best) {
      best = t;
      if (pos.y >= g0 - 0.05 && above > -0.05) contact(out, 'ground', pos.x + dx * t, Math.max(gEnd, pos.y + dy * t), pos.z + dz * t, 0, 1, 0);
      else {
        // Ran into a step up (a kerb, the side of a deck): bounce back off it.
        const hl = Math.hypot(dx, dz) || 1;
        contact(out, 'world', pos.x, pos.y, pos.z, -dx / hl, 0, -dz / hl);
      }
    }
  }
  for (const v of w.vehicles) {
    if (v.removed) continue;
    if (Math.abs(v.pos.x - pos.x) > v.halfL + len + 1 || Math.abs(v.pos.z - pos.z) > v.halfL + len + 1) continue;
    vehicleObb(v, obb);
    const top = v.pos.y + v.spec.height;
    const t = rayObb3(pos.x, pos.y, pos.z, dx, dy, dz, obb, v.pos.y + 0.15, top, best);
    if (t >= 0 && t < best) {
      best = t;
      const hx = pos.x + dx * t;
      const hy = pos.y + dy * t;
      const hz = pos.z + dz * t;
      // The face hit: the roof from above, else the side or end the point lies on.
      if (hy > top - 0.08) contact(out, 'vehicle', hx, hy, hz, 0, 1, 0);
      else {
        const c = Math.cos(v.heading);
        const s = Math.sin(v.heading);
        const lx = (hx - v.pos.x) * c - (hz - v.pos.z) * s;
        const lz = (hx - v.pos.x) * s + (hz - v.pos.z) * c;
        if (Math.abs(lx) / v.halfW > Math.abs(lz) / v.halfL) contact(out, 'vehicle', hx, hy, hz, Math.sign(lx) * c, 0, -Math.sign(lx) * s);
        else contact(out, 'vehicle', hx, hy, hz, Math.sign(lz) * s, 0, Math.sign(lz) * c);
      }
      out.vehicle = v;
    }
  }
  if (hitPeople) {
    for (const c of w.characters) {
      if (c.removed || c === ignore || c.state === 'inVehicle' || !c.alive) continue;
      if (Math.abs(c.pos.x - pos.x) > len + 1 || Math.abs(c.pos.z - pos.z) > len + 1) continue;
      const lying = c.state === 'knocked' || c.state === 'dead';
      const t = rayCylinderY(pos.x, pos.y, pos.z, dx, dy, dz, c.pos.x, c.pos.z, lying ? 0.6 : 0.36, c.pos.y, c.pos.y + (lying ? 0.4 : c.height), best);
      if (t >= 0 && t < best) {
        best = t;
        contact(out, 'character', pos.x + dx * t, pos.y + dy * t, pos.z + dz * t, -dx, -dy, -dz);
        out.character = c;
        out.vehicle = null;
      }
    }
  }
  // Into the sea before anything else.
  if (pos.y > WATER_Y && pos.y + sy <= WATER_Y) {
    const t = ((pos.y - WATER_Y) / -sy) * len;
    const wx = pos.x + dx * t;
    const wz = pos.z + dz * t;
    if (t <= best && world.waterDepth(wx, wz) > 0) {
      contact(out, 'water', wx, WATER_Y, wz, 0, 1, 0);
      out.vehicle = null;
      out.character = null;
      pos.x = wx;
      pos.y = WATER_Y;
      pos.z = wz;
      return out;
    }
  }
  if (out.kind === 'none') {
    pos.x += sx;
    pos.y += sy;
    pos.z += sz;
    return out;
  }
  // To the contact, a hair off the surface.
  pos.x = out.x + out.nx * 0.02;
  pos.y = out.y + out.ny * 0.02;
  pos.z = out.z + out.nz * 0.02;
  if (stopAtFirst) return out;
  const vn = vel.x * out.nx + vel.y * out.ny + vel.z * out.nz;
  if (vn < 0) {
    // Reflect the part into the surface (losing most of it) and keep some of the part along it.
    const tx = vel.x - vn * out.nx;
    const ty = vel.y - vn * out.ny;
    const tz = vel.z - vn * out.nz;
    const rn = -vn * BOUNCE_RESTITUTION;
    vel.x = tx * BOUNCE_FRICTION + rn * out.nx;
    vel.y = ty * BOUNCE_FRICTION + rn * out.ny;
    vel.z = tz * BOUNCE_FRICTION + rn * out.nz;
    state.bounces++;
    if (out.kind === 'ground' && -vn < SETTLE_SPEED) {
      state.resting = true;
      vel.y = 0;
      pos.y = out.y;
    }
  }
  return out;
}

function contact(o: ThrowContact, kind: ThrowContact['kind'], x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
  o.kind = kind;
  o.x = x;
  o.y = y;
  o.z = z;
  o.nx = nx;
  o.ny = ny;
  o.nz = nz;
}

/** The arc a throw from `pos` at `vel` would fly, sampled about every 1/30 s, up to where it first lands or hits something. */
export function predictThrow(w: ThrowWorld, pos: V3, vel: V3): { points: V3[]; landing: V3 | null; kind: ThrowContact['kind'] } {
  const p = { ...pos };
  const v = { ...vel };
  const state = { resting: false, bounces: 0 };
  const points: V3[] = [{ ...p }];
  const out = makeContact();
  const steps = Math.round(PREVIEW_TIME / STEP);
  for (let i = 1; i <= steps; i++) {
    stepThrow(w, p, v, STEP, state, true, false, null, out);
    if (out.kind !== 'none') {
      points.push({ x: out.x, y: out.y, z: out.z });
      return { points, landing: { x: out.x, y: out.y, z: out.z }, kind: out.kind };
    }
    if (i % 4 === 0) points.push({ ...p });
  }
  return { points, landing: null, kind: 'none' };
}

/** Thrown weapons in flight, stepped with the combat system each frame. */
export class ThrowSystem {
  readonly list: Thrown[] = [];
  private readonly out = makeContact();

  constructor(private readonly sim: Sim) {}

  /** Throws `c`'s current throwable along the crosshair ray `dir`. */
  throwFrom(c: Character, dir: V3): Thrown {
    const sim = this.sim;
    const weapon = c.inventory.current;
    const spec = WEAPONS[weapon].thrown!;
    const l = throwLaunch(sim.world, c, dir, spec);
    const t = new Thrown(sim.newId(), weapon, l.pos, l.vel, c);
    this.list.push(t);
    sim.events.emit('thrown', { by: c, weapon, x: l.pos.x, y: l.pos.y, z: l.pos.z });
    return t;
  }

  reset(): void {
    this.list.length = 0;
  }

  update(dt: number): void {
    const sim = this.sim;
    for (const t of this.list) {
      if (t.removed) continue;
      const steps = Math.max(1, Math.ceil(dt / STEP - 1e-6));
      const h = dt / steps;
      for (let i = 0; i < steps && !t.removed; i++) {
        t.age += h;
        const spec = t.spec;
        if (spec.fuse !== undefined && t.age >= spec.fuse) {
          this.detonate(t);
          break;
        }
        if (t.inWater) {
          // Sinking: no more collisions, it goes off (or fizzles) down there.
          t.vel.x *= Math.exp(-4 * h);
          t.vel.z *= Math.exp(-4 * h);
          t.pos.x += t.vel.x * h;
          t.pos.z += t.vel.z * h;
          t.pos.y = Math.max(sim.world.groundHeight(t.pos.x, t.pos.z), WATER_Y - SINK_DEPTH, t.pos.y - SINK_SPEED * h);
          continue;
        }
        const ignore = t.age < ARMING ? t.owner : null;
        const r = stepThrow(sim, t.pos, t.vel, h, t, !!spec.fire, !!spec.fire, ignore, this.out);
        if (r.kind === 'water') {
          sim.events.emit('splash', { x: r.x, y: WATER_Y, z: r.z, big: false });
          if (spec.fire) {
            // A molotov in the sea makes no fire.
            t.removed = true;
            t.doneAt = t.age;
          } else {
            t.inWater = true;
            t.resting = false;
            t.vel.y = 0;
          }
          break;
        }
        if (spec.fire && r.kind !== 'none') {
          t.removed = true;
          t.doneAt = t.age;
          sim.events.emit('glassBreak', { x: r.x, y: r.y, z: r.z });
          // The burning fuel runs down to the ground under where it broke (off a wall, a car's side or a man).
          sim.combat.fire.ignite(r.x, sim.world.groundHeight(r.x, r.z), r.z, t.owner, r.vehicle, r.character);
          break;
        }
      }
    }
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i]!.removed) this.list.splice(i, 1);
  }

  private detonate(t: Thrown): void {
    const sim = this.sim;
    t.removed = true;
    t.doneAt = t.age;
    const spec = t.spec;
    const radius = spec.blast ?? 6;
    const damage = WEAPONS[t.weapon].damage;
    if (t.inWater) {
      // Under the surface it throws up a column of water, as a rocket into the sea does.
      sim.events.emit('splash', { x: t.pos.x, y: WATER_Y, z: t.pos.z, big: true });
      sim.combat.explosion(t.pos.x, WATER_Y, t.pos.z, radius, damage, t.owner, null, true);
      return;
    }
    sim.combat.explosion(t.pos.x, t.pos.y + 0.25, t.pos.z, radius, damage, t.owner, null);
  }
}
