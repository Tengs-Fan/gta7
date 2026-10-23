// Network-facing views of the simulation: what a client needs to draw and hear each entity, grouped by how often it
// changes, plus interest management (which entities a viewer gets). Pure data, no encoding (see src/net/protocol.ts).
// The server captures each entity once per snapshot and encodes it for every client; a client mirror applies the
// decoded groups back onto entity objects with the apply* helpers.

import type { V3 } from '../core/math';
import type { Axis } from '../world/roads';
import type { Appearance, Character, CharacterRole, CharState, Dent, Helicopter, Owner, Pickup, PickupKind, Projectile, Vehicle } from './entities';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import type { WeaponId } from './specs';
import type { WeatherState } from './weather';

// ---------------------------------------------------------------------------
// Entity groups

/** Changes every tick a vehicle moves. */
export interface VehicleMotion {
  x: number; y: number; z: number;
  heading: number; pitch: number; roll: number;
  vx: number; vz: number; vy: number;
  angVel: number;
  /** Smoothed wheel position, -1..1. */
  steer: number;
  /** Not sent: derived from the velocity (and heading) on decoding. */
  speed: number;
  forwardSpeed: number;
}

/** Engine, controls and lamps: changes while someone drives. */
export interface VehicleEngine {
  /** Engine speed as a fraction of the rev range, 0..1. */
  rpm: number;
  gear: number;
  skid: number;
  throttle: number;
  brake: number;
  ctlSteer: number;
  handbrake: boolean;
  braking: boolean;
  reversing: boolean;
  siren: boolean;
  horn: boolean;
}

/** Damage and occupancy: changes on events. */
export interface VehicleStatus {
  health: number;
  burning: boolean;
  destroyed: boolean;
  flipped: boolean;
  airborne: boolean;
  inWater: boolean;
  /** Whole seconds since destruction (capped at 255). */
  wreckTime: number;
  /** Driver id, 0 for none. */
  driver: number;
  /** Passenger ids by seat (seat 1 first), 0 for an empty seat. */
  passengers: number[];
}

/** Sent when the client first sees the vehicle and whenever any of it changes. */
export interface VehicleRare {
  kind: string;
  color: number;
  owner: string;
  dentVersion: number;
  dents: Dent[];
}

export interface CharacterMotion {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  heading: number;
  /** Not sent: derived from the velocity on decoding. */
  speed: number;
  /** Gait phase, radians modulo 2π (the renderer only reads it through sin/cos and cycleFraction). */
  animPhase: number;
  onGround: boolean;
}

export interface CharacterStatus {
  state: CharState;
  /** Vehicle id, 0 for none. */
  vehicle: number;
  seat: number;
  health: number;
  armor: number;
  /** Civilian cowering (brain mode 'cower'), which the renderer poses. */
  cower: boolean;
}

export interface CharacterCombat {
  weapon: WeaponId;
  reloadWeapon: WeaponId | null;
  aiming: boolean;
  aimZoom: boolean;
  aimPitch: number;
  aimYaw: number;
  punchTimer: number;
  shotTimer: number;
  reloadTimer: number;
  meleeCombo: number;
}

export interface CharacterRare {
  role: CharacterRole;
  appearance: Appearance;
  maxHealth: number;
}

export interface ProjectileState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Owner id, 0 for none. */
  owner: number;
}

export interface HeliState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  heading: number;
  rotor: number;
  health: number;
  destroyed: boolean;
  crashing: boolean;
  spotX: number;
  spotZ: number;
}

export interface PickupState {
  kind: PickupKind;
  x: number; y: number; z: number;
  amount: number;
  weapon: WeaponId | null;
  active: boolean;
  tag: string;
}

export interface VehicleUpdate { id: number; motion?: VehicleMotion; engine?: VehicleEngine; status?: VehicleStatus; rare?: VehicleRare }
export interface CharacterUpdate { id: number; motion?: CharacterMotion; status?: CharacterStatus; combat?: CharacterCombat; rare?: CharacterRare }
export interface ProjectileUpdate { id: number; state?: ProjectileState }
export interface HeliUpdate { id: number; state?: HeliState }
export interface PickupUpdate { id: number; state?: PickupState }

export interface CapturedVehicle { id: number; motion: VehicleMotion; engine: VehicleEngine; status: VehicleStatus; rare: VehicleRare }
export interface CapturedCharacter { id: number; motion: CharacterMotion; status: CharacterStatus; combat: CharacterCombat; rare: CharacterRare }

const TAU = Math.PI * 2;
const ref = (e: { id: number } | null | undefined): number => (e ? e.id : 0);

export function captureVehicle(v: Vehicle): CapturedVehicle {
  return {
    id: v.id,
    motion: {
      x: v.pos.x, y: v.pos.y, z: v.pos.z,
      heading: v.heading, pitch: v.pitch, roll: v.roll,
      vx: v.vel.x, vz: v.vel.z, vy: v.vy,
      angVel: v.angVel,
      steer: v.steer,
      speed: v.speed,
      forwardSpeed: v.forwardSpeed,
    },
    engine: {
      rpm: v.rpm,
      gear: v.gear,
      skid: v.skid,
      throttle: v.controls.throttle,
      brake: v.controls.brake,
      ctlSteer: v.controls.steer,
      handbrake: v.controls.handbrake,
      braking: v.braking,
      reversing: v.reversing,
      siren: v.siren,
      horn: v.horn,
    },
    status: {
      health: v.health,
      burning: v.burning,
      destroyed: v.destroyed,
      flipped: v.flipped,
      airborne: v.airborne,
      inWater: v.inWater,
      wreckTime: Math.min(255, Math.floor(v.wreckTime)),
      driver: ref(v.driver),
      passengers: v.passengers.map(ref),
    },
    rare: { kind: v.kind, color: v.color, owner: v.owner, dentVersion: v.dentVersion, dents: v.dents.map((d) => ({ ...d })) },
  };
}

export function captureCharacter(c: Character): CapturedCharacter {
  const phase = Number.isFinite(c.animPhase) ? c.animPhase - Math.floor(c.animPhase / TAU) * TAU : 0;
  return {
    id: c.id,
    motion: {
      x: c.pos.x, y: c.pos.y, z: c.pos.z,
      vx: c.vel.x, vy: c.vel.y, vz: c.vel.z,
      heading: c.heading,
      speed: c.speed,
      animPhase: phase,
      onGround: c.onGround,
    },
    status: {
      state: c.state,
      vehicle: ref(c.vehicle),
      seat: c.seat,
      health: c.health,
      armor: c.armor,
      cower: c.brain?.mode === 'cower',
    },
    combat: {
      weapon: c.inventory.current,
      reloadWeapon: c.reloadWeapon,
      aiming: c.aiming,
      aimZoom: c.aimZoom,
      aimPitch: c.aimPitch,
      aimYaw: c.aimYaw,
      punchTimer: Math.max(0, c.punchTimer),
      shotTimer: Math.max(0, c.shotTimer),
      reloadTimer: Math.max(0, c.reloadTimer),
      meleeCombo: c.meleeCombo,
    },
    rare: { role: c.role, appearance: { ...c.appearance }, maxHealth: c.maxHealth },
  };
}

export function captureProjectile(p: Projectile): ProjectileState {
  return { x: p.pos.x, y: p.pos.y, z: p.pos.z, vx: p.vel.x, vy: p.vel.y, vz: p.vel.z, owner: ref(p.owner) };
}

export function captureHeli(h: Helicopter): HeliState {
  return {
    x: h.pos.x, y: h.pos.y, z: h.pos.z,
    vx: h.vel.x, vy: h.vel.y, vz: h.vel.z,
    heading: h.heading,
    rotor: h.rotor,
    health: h.health,
    destroyed: h.destroyed,
    crashing: h.crashing,
    spotX: h.spotlight.x,
    spotZ: h.spotlight.z,
  };
}

export function capturePickup(p: Pickup): PickupState {
  return { kind: p.kind, x: p.pos.x, y: p.pos.y, z: p.pos.z, amount: p.amount, weapon: p.weapon, active: p.active, tag: p.tag };
}

// ---------------------------------------------------------------------------
// Applying decoded groups (client mirror side)

export function applyVehicleUpdate(v: Vehicle, u: VehicleUpdate, resolve: (id: number) => Character | null): void {
  const m = u.motion;
  if (m) {
    v.pos.x = m.x; v.pos.y = m.y; v.pos.z = m.z;
    v.heading = m.heading; v.pitch = m.pitch; v.roll = m.roll;
    v.vel.x = m.vx; v.vel.z = m.vz; v.vy = m.vy;
    v.angVel = m.angVel;
    v.steer = m.steer;
    v.speed = m.speed;
    v.forwardSpeed = m.forwardSpeed;
  }
  const e = u.engine;
  if (e) {
    v.rpm = e.rpm; v.gear = e.gear; v.skid = e.skid;
    v.controls.throttle = e.throttle; v.controls.brake = e.brake; v.controls.steer = e.ctlSteer; v.controls.handbrake = e.handbrake;
    v.braking = e.braking; v.reversing = e.reversing; v.siren = e.siren; v.horn = e.horn;
  }
  const s = u.status;
  if (s) {
    v.health = s.health; v.burning = s.burning; v.destroyed = s.destroyed; v.flipped = s.flipped;
    v.airborne = s.airborne; v.inWater = s.inWater; v.wreckTime = s.wreckTime;
    v.driver = s.driver ? resolve(s.driver) : null;
    for (let i = 0; i < v.passengers.length; i++) v.passengers[i] = s.passengers[i] ? resolve(s.passengers[i]!) : null;
  }
  const r = u.rare;
  if (r) {
    v.color = r.color;
    v.owner = r.owner as Owner;
    if (r.dentVersion !== v.dentVersion) {
      v.dents.length = 0;
      for (const d of r.dents) v.dents.push({ ...d });
      v.dentVersion = r.dentVersion;
    }
  }
}

export function applyCharacterUpdate(c: Character, u: CharacterUpdate, resolve: (id: number) => Vehicle | null): void {
  const m = u.motion;
  if (m) {
    c.pos.x = m.x; c.pos.y = m.y; c.pos.z = m.z;
    c.vel.x = m.vx; c.vel.y = m.vy; c.vel.z = m.vz;
    c.heading = m.heading; c.speed = m.speed; c.animPhase = m.animPhase; c.onGround = m.onGround;
  }
  const s = u.status;
  if (s) {
    c.state = s.state;
    c.vehicle = s.vehicle ? resolve(s.vehicle) : null;
    c.seat = s.seat; c.health = s.health; c.armor = s.armor;
  }
  const k = u.combat;
  if (k) {
    c.inventory.current = k.weapon; c.reloadWeapon = k.reloadWeapon;
    c.aiming = k.aiming; c.aimZoom = k.aimZoom; c.aimPitch = k.aimPitch; c.aimYaw = k.aimYaw;
    c.punchTimer = k.punchTimer; c.shotTimer = k.shotTimer; c.reloadTimer = k.reloadTimer; c.meleeCombo = k.meleeCombo;
  }
  const r = u.rare;
  if (r) {
    c.role = r.role;
    c.appearance = { ...r.appearance };
    c.maxHealth = r.maxHealth;
  }
}

// ---------------------------------------------------------------------------
// Globals and static state

export interface ClockState { day: number; hours: number; rate: number }

export interface StaticState {
  brokenProps: number[];
  signalHolds: Array<[node: number, axis: Axis]>;
}

export function captureClock(sim: Sim): ClockState {
  return { day: sim.clock.day, hours: sim.clock.hours, rate: sim.clock.rate };
}

export function captureWeather(sim: Sim): WeatherState {
  const s = sim.weather.state;
  return { ...s, wind: { ...s.wind } };
}

/** Prop indices of every broken breakable prop, ascending. */
export function brokenProps(sim: Sim): number[] {
  const out: number[] = [];
  for (const c of sim.world.grid.colliders) if (c.breakable && c.broken && c.propIndex >= 0) out.push(c.propIndex);
  return out.sort((a, b) => a - b);
}

export function signalHolds(sim: Sim): Array<[number, Axis]> {
  return [...sim.roads.heldSignals.entries()].sort((a, b) => a[0] - b[0]);
}

export function captureStatic(sim: Sim): StaticState {
  return { brokenProps: brokenProps(sim), signalHolds: signalHolds(sim) };
}

// ---------------------------------------------------------------------------
// Interest management

/** One point of view of a client: a player (in mp-core, one per PlayerSlot) or the player a spectator follows. */
export interface Viewer {
  x: number;
  z: number;
  /** The viewer's own character: its vehicle and pursuers are always relevant. */
  character: Character | null;
  /** The viewer's wanted level: from 1 star the police helicopters are relevant at any distance. */
  wanted: number;
}

export interface InterestOptions {
  /** Entities closer than this (m, horizontal) to a viewer enter the snapshot. */
  radius: number;
  /** Already sent entities stay until they are further than this (hysteresis against flicker at the edge). */
  keepRadius: number;
}

export const DEFAULT_INTEREST: InterestOptions = { radius: 250, keepRadius: 258 };

/** Where a character is for distance purposes: its vehicle's position when seated. */
/** A player's own HUD numbers, from his slot. */
export function captureHud(slot: PlayerSlot): { wanted: number; searching: boolean; money: number; clip: number; ammo: number } {
  const inv = slot.character.inventory;
  const w = inv.slots.get(inv.current);
  return { wanted: slot.wanted.level, searching: slot.wanted.searching, money: slot.progress.money, clip: w?.clip ?? 0, ammo: w?.ammo ?? 0 };
}

/** A player's own side job for his HUD: kind ('' for none), status line, objective markers (entities by id). */
export function captureJob(sim: Sim, slot: PlayerSlot): { kind: string; status: string; objectives: Array<{ x: number; z: number; label: string; color: number; radius: number; vehicle: number; character: number }> } {
  const job = sim.activities.jobOf(slot);
  if (!job) return { kind: '', status: '', objectives: [] };
  const objectives = sim.activities.objectives(slot).map((o) => {
    const at = o.vehicle && !o.vehicle.removed ? o.vehicle.pos : o.character && !o.character.removed ? o.character.pos : o;
    return { x: at.x, z: at.z, label: o.label, color: o.color, radius: o.radius, vehicle: o.vehicle && !o.vehicle.removed ? o.vehicle.id : 0, character: o.character && !o.character.removed ? o.character.id : 0 };
  });
  return { kind: job.kind, status: sim.activities.status(slot) ?? '', objectives };
}

export function viewerAt(c: Character, wanted = 0): Viewer {
  const p: V3 = c.vehicle ? c.vehicle.pos : c.pos;
  return { x: p.x, z: p.z, character: c, wanted };
}

function near(viewers: readonly Viewer[], x: number, z: number, r: number): boolean {
  const r2 = r * r;
  for (const v of viewers) {
    const dx = x - v.x;
    const dz = z - v.z;
    if (dx * dx + dz * dz <= r2) return true;
  }
  return false;
}

/**
 * Ids of the entities one client receives: ambient entities near any of its viewers, every player character in the
 * room (`players`) and the vehicle it sits in, each viewer's own vehicle and the vehicles pursuing it, all
 * helicopters while a viewer is wanted, and the occupants of every vehicle sent (so seat references resolve).
 * `prev` is the set sent last time (for the keep radius).
 */
export function selectInterest(sim: Sim, viewers: readonly Viewer[], players: readonly Character[], prev: ReadonlySet<number> | null, opts: InterestOptions = DEFAULT_INTEREST): Set<number> {
  const out = new Set<number>();
  const inRange = (id: number, x: number, z: number) => near(viewers, x, z, prev && prev.has(id) ? opts.keepRadius : opts.radius);
  const own = new Set<Vehicle>();
  const targets = new Set<Character | Vehicle>();
  // The pursuits of wanted viewers: their helicopters are relevant at any distance.
  const hunted = new Set<number>();
  for (const v of viewers) {
    if (!v.character) continue;
    targets.add(v.character);
    if (v.character.vehicle) {
      own.add(v.character.vehicle);
      targets.add(v.character.vehicle);
    }
    const slot = sim.slotOf(v.character);
    if (v.wanted > 0) hunted.add(slot ? slot.id : 0);
  }
  for (const p of players) {
    if (p.removed) continue;
    out.add(p.id);
    if (p.vehicle && !p.vehicle.removed) own.add(p.vehicle);
  }
  for (const v of sim.vehicles) {
    if (v.removed) continue;
    const target = v.ai?.target ?? null;
    if (own.has(v) || (target && targets.has(target)) || inRange(v.id, v.pos.x, v.pos.z)) {
      out.add(v.id);
      for (const o of v.occupants()) out.add(o.id);
    }
  }
  for (const c of sim.characters) {
    if (c.removed || out.has(c.id)) continue;
    if (c.vehicle && !c.vehicle.removed) {
      // Seated characters travel with their vehicle's interest.
      if (out.has(c.vehicle.id)) out.add(c.id);
      continue;
    }
    if (inRange(c.id, c.pos.x, c.pos.z)) out.add(c.id);
  }
  for (const p of sim.projectiles) {
    if (p.removed) continue;
    if ((p.owner && out.has(p.owner.id) && p.owner.isPlayer) || inRange(p.id, p.pos.x, p.pos.z)) out.add(p.id);
  }
  for (const h of sim.helis) {
    if (h.removed) continue;
    if ((hunted.size > 0 && hunted.has(sim.police.targetSlotOf(h))) || inRange(h.id, h.pos.x, h.pos.z)) out.add(h.id);
  }
  for (const p of sim.pickups) {
    if (p.removed) continue;
    if (inRange(p.id, p.pos.x, p.pos.z)) out.add(p.id);
  }
  return out;
}
