// The multiplayer wire protocol: one binary WebSocket frame per message, a versioned header, then the message body.
// Pure TypeScript shared by the server and the browser client (no three.js, DOM or Node APIs).
//
// Header: u8 MAGIC, u8 PROTOCOL_VERSION, u8 message type (index into MESSAGE_TYPES).
// Quantization (see the codecs below): positions 1 cm (signed 24-bit, ±83 km), headings and other angles 2π/65536,
// velocities 0.01 m/s (signed 16-bit, ±327 m/s), angular velocity 0.001 rad/s, player input axes 1/32767, the controls
// of other vehicles 1/127, unit fractions (rpm, skid, weather) 1/255, timers 1 ms, health f32. Speeds that follow from
// a velocity (a vehicle's speed and forward speed, a character's speed) are not sent but derived on decoding. Ids and counts are LEB128 varints. Anything malformed throws a ProtocolError and nothing of it
// is returned; counts and string lengths are checked against the bytes left before anything is allocated.

import type { Appearance, CharState, Dent } from '../sim/entities';
import type { PlayerInput } from '../sim/input';
import type {
  CharacterCombat, CharacterMotion, CharacterRare, CharacterStatus, CharacterUpdate, ClockState, HeliState, HeliUpdate,
  PickupState, PickupUpdate, ProjectileState, ProjectileUpdate, VehicleEngine, VehicleMotion, VehicleRare, VehicleStatus,
  VehicleUpdate,
} from '../sim/snapshot';
import { WEAPON_ORDER, type WeaponId } from '../sim/specs';
import { WEATHER_KINDS, type WeatherState } from '../sim/weather';
import type { Axis } from '../world/roads';
import { ProtocolError, Reader, Writer } from './wire';

export { ProtocolError, Reader, Writer } from './wire';

export const MAGIC = 0x47;
export const PROTOCOL_VERSION = 3;
export const HEADER_BYTES = 3;

export const MESSAGE_TYPES = ['hello', 'welcome', 'reject', 'input', 'snapshot', 'event', 'cmd', 'ping', 'pong', 'bye'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MAX_NAME_BYTES = 48;
export const MAX_ROOM_BYTES = 64;
export const MAX_CMD_ARG_BYTES = 2048;

// ---------------------------------------------------------------------------
// Message shapes

export interface HelloMsg { type: 'hello'; version: number; name: string; room: string }

export interface WelcomeMsg {
  type: 'welcome';
  playerId: number;
  /** PlayerSlot index the player controls, or -1 while it only watches (no free slot in the room's Sim). */
  slot: number;
  roomId: string;
  roomSeed: number;
  tick: number;
  tickRate: number;
  snapshotRate: number;
  brokenProps: number[];
  signalHolds: Array<[number, Axis]>;
  /** The pickups the first snapshots treat as already known. */
  pickups: PickupUpdate[];
}

export const REJECT_CODES = ['full', 'version', 'badHello', 'shutdown', 'kicked'] as const;
export type RejectCode = (typeof REJECT_CODES)[number];
export interface RejectMsg { type: 'reject'; code: RejectCode; text: string }

export interface InputMsg { type: 'input'; seq: number; tick: number; input: PlayerInput }

export interface RosterEntry { playerId: number; characterId: number; slot: number; name: string }

/**
 * The receiving player's own HUD numbers, from his slot: stars, money and the rounds of the weapon in his hand; and
 * whether the server holds him (down: wasted or busted; locked: his controls are), when nothing of his may be predicted.
 */
export interface Hud { wanted: number; searching: boolean; money: number; clip: number; ammo: number; down: 'wasted' | 'busted' | null; locked: boolean }

/** A job objective marker (Activities' Objective) with its followed entity as an id (0: a fixed point). */
export interface NetObjective { x: number; z: number; label: string; color: number; radius: number; vehicle: number; character: number }

/** The receiving player's own side job: its kind ('' for none), HUD status line and objective markers. */
export interface JobHud { kind: string; status: string; objectives: NetObjective[] }

export interface SnapshotMsg {
  type: 'snapshot';
  tick: number;
  /** Last input seq the server applied for this client. */
  ackSeq: number;
  time: number;
  /** The first snapshot after joining: every entity in it is new to the client. */
  full: boolean;
  clock: ClockState;
  hud: Hud;
  /** Sent when it changes. */
  job: JobHud | null;
  /** Sent when it changes. */
  roster: RosterEntry[] | null;
  weather: WeatherState | null;
  signalHolds: Array<[number, Axis]> | null;
  /** Props broken since the previous snapshot. */
  brokenProps: number[];
  vehicles: VehicleUpdate[];
  characters: CharacterUpdate[];
  projectiles: ProjectileUpdate[];
  helis: HeliUpdate[];
  pickups: PickupUpdate[];
  /** Entities gone from the client's view (removed, or out of its interest). */
  removed: number[];
}

/** An entity reference in an event, by id. */
export interface NetRef { $id: number }
export interface NetEvent { type: string; /** 0: not player-scoped. */ playerId: number; data: Record<string, unknown> }
export interface EventMsg { type: 'event'; tick: number; events: NetEvent[] }

export interface CmdMsg { type: 'cmd'; seq: number; name: string; arg: string }
export interface PingMsg { type: 'ping'; clientTime: number }
export interface PongMsg { type: 'pong'; clientTime: number; serverTime: number; tick: number }
export interface ByeMsg { type: 'bye'; reason: string }

export type Message = HelloMsg | WelcomeMsg | RejectMsg | InputMsg | SnapshotMsg | EventMsg | CmdMsg | PingMsg | PongMsg | ByeMsg;
export type MessageOf<T extends MessageType> = Extract<Message, { type: T }>;

// ---------------------------------------------------------------------------
// Scalar codecs

export const POS_STEP = 0.01;
export const VEL_STEP = 0.01;
export const ANGVEL_STEP = 0.001;
export const ANGLE_STEP = (Math.PI * 2) / 65536;
export const AXIS_STEP = 1 / 32767;
export const AXIS8_STEP = 1 / 127;
export const FRACTION_STEP = 1 / 255;
export const TIMER_STEP = 0.001;

const TAU = Math.PI * 2;
const fin = (v: number) => (Number.isFinite(v) ? v : 0);
const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

export function wPos(w: Writer, v: number): void { w.i24(clampInt(fin(v) / POS_STEP, -0x800000, 0x7fffff)); }
export function rPos(r: Reader): number { return r.i24() * POS_STEP; }
export function wVel(w: Writer, v: number): void { w.i16(clampInt(fin(v) / VEL_STEP, -32768, 32767)); }
export function rVel(r: Reader): number { return r.i16() * VEL_STEP; }
/** Any angle, kept modulo 2π; decodes into [0, 2π). */
export function wAngle(w: Writer, a: number): void {
  const x = fin(a) / TAU;
  w.u16(Math.round((x - Math.floor(x)) * 65536) & 0xffff);
}
export function rAngle(r: Reader): number { return r.u16() * ANGLE_STEP; }
/** A small signed angle (pitch, roll, aim pitch): wrapped into [-π, π). */
export function wSAngle(w: Writer, a: number): void {
  const x = fin(a) / TAU;
  const u = x - Math.floor(x + 0.5);
  w.i16(clampInt(u * 65536, -32768, 32767));
}
export function rSAngle(r: Reader): number { return r.i16() * ANGLE_STEP; }
export function wAxis(w: Writer, v: number): void { w.i16(clampInt(fin(v) * 32767, -32767, 32767)); }
export function rAxis(r: Reader): number { return r.i16() / 32767; }
export function wAxis8(w: Writer, v: number): void { w.i8(clampInt(fin(v) * 127, -127, 127)); }
export function rAxis8(r: Reader): number { return r.i8() / 127; }
export function wFrac(w: Writer, v: number): void { w.u8(clampInt(fin(v) * 255, 0, 255)); }
export function rFrac(r: Reader): number { return r.u8() / 255; }
export function wTimer(w: Writer, v: number): void { w.u16(clampInt(fin(v) / TIMER_STEP, 0, 65535)); }
export function rTimer(r: Reader): number { return r.u16() * TIMER_STEP; }
function wBool(w: Writer, b: boolean): void { w.u8(b ? 1 : 0); }
function rBool(r: Reader): boolean {
  const b = r.u8();
  if (b > 1) throw new ProtocolError('value', `bad boolean ${b}`);
  return b === 1;
}
function rFinite(r: Reader, read: () => number): number {
  const v = read.call(r);
  if (!Number.isFinite(v)) throw new ProtocolError('value', 'non-finite number');
  return v;
}

const ENUM_NULL = 253;
const ENUM_STR = 254;
/** A value from a known table as one byte; values outside it (content added later) as a string. */
export function wEnum(w: Writer, table: readonly string[], v: string | null): void {
  if (v === null) return w.u8(ENUM_NULL);
  const i = table.indexOf(v);
  if (i >= 0 && i < ENUM_NULL) return w.u8(i);
  w.u8(ENUM_STR);
  w.str(v, 64);
}
export function rEnumOrNull(r: Reader, table: readonly string[]): string | null {
  const b = r.u8();
  if (b === ENUM_NULL) return null;
  if (b === ENUM_STR) return r.str(64);
  const v = table[b];
  if (v === undefined) throw new ProtocolError('value', `enum index ${b} out of range`);
  return v;
}
export function rEnum(r: Reader, table: readonly string[]): string {
  const v = rEnumOrNull(r, table);
  if (v === null) throw new ProtocolError('value', 'unexpected null enum');
  return v;
}

function flagsOut(w: Writer, bits: readonly boolean[]): void {
  let f = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i]) f |= 1 << i;
  if (bits.length <= 8) w.u8(f);
  else w.u16(f);
}
function flagsIn(r: Reader, n: number): boolean[] {
  const f = n <= 8 ? r.u8() : r.u16();
  if (f >>> n !== 0) throw new ProtocolError('value', 'unknown flag bits');
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push((f & (1 << i)) !== 0);
  return out;
}

// Tables for compact enums. Unknown values still encode (as strings), so new content needs no protocol change.
export const VEHICLE_KINDS = ['compact', 'sedan', 'taxi', 'sports', 'muscle', 'pickup', 'van', 'bus', 'police', 'swat'] as const;
export const OWNERS = ['none', 'traffic', 'parked', 'ped', 'police', 'mission'] as const;
export const ROLES = ['player', 'civilian', 'cop', 'swat', 'gang', 'mission'] as const;
export const CHAR_STATES = ['normal', 'knocked', 'dead', 'inVehicle', 'entering', 'swimming'] as const;
export const PICKUP_KINDS = ['health', 'armor', 'weapon', 'money', 'package', 'rampage', 'parcel'] as const;
const AXES = ['NS', 'EW'] as const;

// ---------------------------------------------------------------------------
// PlayerInput (input message)

const INPUT_FLAGS = ['sprint', 'jump', 'fire', 'firePressed', 'aim', 'enterExit', 'interact', 'reload', 'nextWeapon', 'prevWeapon', 'steerDigital', 'handbrake', 'horn', 'hornPressed', 'job'] as const;
export type InputFlag = (typeof INPUT_FLAGS)[number];
export const INPUT_FLAG_NAMES: readonly InputFlag[] = INPUT_FLAGS;

export function writeInput(w: Writer, p: PlayerInput): void {
  wAxis(w, p.moveX);
  wAxis(w, p.moveZ);
  wAxis(w, p.throttle);
  wAxis(w, p.brake);
  wAxis(w, p.steer);
  wAngle(w, p.cameraYaw);
  wPos(w, p.aimOrigin.x);
  wPos(w, p.aimOrigin.y);
  wPos(w, p.aimOrigin.z);
  wAxis(w, p.aimDir.x);
  wAxis(w, p.aimDir.y);
  wAxis(w, p.aimDir.z);
  flagsOut(w, INPUT_FLAGS.map((k) => p[k]));
  w.i8(clampInt(p.selectSlot, -1, 127));
}

export function readInput(r: Reader): PlayerInput {
  const moveX = rAxis(r);
  const moveZ = rAxis(r);
  const throttle = rAxis(r);
  const brake = rAxis(r);
  const steer = rAxis(r);
  const cameraYaw = rAngle(r);
  const aimOrigin = { x: rPos(r), y: rPos(r), z: rPos(r) };
  const aimDir = { x: rAxis(r), y: rAxis(r), z: rAxis(r) };
  const f = flagsIn(r, INPUT_FLAGS.length);
  const selectSlot = r.i8();
  if (selectSlot < -1) throw new ProtocolError('value', `bad weapon slot ${selectSlot}`);
  const out = { moveX, moveZ, throttle, brake, steer, cameraYaw, aimOrigin, aimDir, selectSlot } as PlayerInput;
  INPUT_FLAGS.forEach((k, i) => {
    out[k] = f[i]!;
  });
  return out;
}

/** The input exactly as the server will see it: client-side prediction must run on this, not on the raw input. */
export function quantizeInput(p: PlayerInput): PlayerInput {
  const w = new Writer(64);
  writeInput(w, p);
  return readInput(new Reader(w.view8()));
}

// ---------------------------------------------------------------------------
// Entity group codecs

interface Codec<T> { w(w: Writer, v: T): void; r(r: Reader): T }

const vehicleMotion: Codec<VehicleMotion> = {
  w(w, v) {
    wPos(w, v.x); wPos(w, v.y); wPos(w, v.z);
    wAngle(w, v.heading); wSAngle(w, v.pitch); wSAngle(w, v.roll);
    wVel(w, v.vx); wVel(w, v.vz); wVel(w, v.vy);
    w.i16(clampInt(fin(v.angVel) / ANGVEL_STEP, -32768, 32767));
    wAxis(w, v.steer);
  },
  r(r) {
    const x = rPos(r), y = rPos(r), z = rPos(r);
    const heading = rAngle(r), pitch = rSAngle(r), roll = rSAngle(r);
    const vx = rVel(r), vz = rVel(r), vy = rVel(r);
    const angVel = r.i16() * ANGVEL_STEP;
    const steer = rAxis(r);
    // As vehiclePhysics derives them from the velocity.
    return { x, y, z, heading, pitch, roll, vx, vz, vy, angVel, steer, speed: Math.hypot(vx, vz), forwardSpeed: vx * Math.sin(heading) + vz * Math.cos(heading) };
  },
};

const vehicleEngine: Codec<VehicleEngine> = {
  w(w, v) {
    wFrac(w, v.rpm);
    w.i8(clampInt(v.gear, -128, 127));
    wFrac(w, v.skid);
    wAxis8(w, v.throttle);
    wAxis8(w, v.brake);
    wAxis8(w, v.ctlSteer);
    flagsOut(w, [v.handbrake, v.braking, v.reversing, v.siren, v.horn]);
  },
  r(r) {
    const rpm = rFrac(r);
    const gear = r.i8();
    const skid = rFrac(r);
    const throttle = rAxis8(r);
    const brake = rAxis8(r);
    const ctlSteer = rAxis8(r);
    const [handbrake, braking, reversing, siren, horn] = flagsIn(r, 5) as [boolean, boolean, boolean, boolean, boolean];
    return { rpm, gear, skid, throttle, brake, ctlSteer, handbrake, braking, reversing, siren, horn };
  },
};

const vehicleStatus: Codec<VehicleStatus> = {
  w(w, v) {
    w.f32(fin(v.health));
    flagsOut(w, [v.burning, v.destroyed, v.flipped, v.airborne, v.inWater]);
    w.u8(clampInt(v.wreckTime, 0, 255));
    w.varu(v.driver);
    w.varu(v.passengers.length);
    for (const p of v.passengers) w.varu(p);
  },
  r(r) {
    const health = rFinite(r, r.f32);
    const [burning, destroyed, flipped, airborne, inWater] = flagsIn(r, 5) as [boolean, boolean, boolean, boolean, boolean];
    const wreckTime = r.u8();
    const driver = r.varu();
    const n = r.count(1, 32);
    const passengers: number[] = [];
    for (let i = 0; i < n; i++) passengers.push(r.varu());
    return { health, burning, destroyed, flipped, airborne, inWater, wreckTime, driver, passengers };
  },
};

const DENT_STEP = 0.0001;
const vehicleRare: Codec<VehicleRare> = {
  w(w, v) {
    wEnum(w, VEHICLE_KINDS, v.kind);
    w.u32(v.color >>> 0);
    wEnum(w, OWNERS, v.owner);
    w.varu(v.dentVersion);
    w.varu(v.dents.length);
    for (const d of v.dents) {
      w.i16(clampInt(d.lx / POS_STEP, -32768, 32767));
      w.i16(clampInt(d.ly / POS_STEP, -32768, 32767));
      w.i16(clampInt(d.lz / POS_STEP, -32768, 32767));
      wAxis(w, d.nx);
      wAxis(w, d.nz);
      w.u16(clampInt(d.depth / DENT_STEP, 0, 65535));
    }
  },
  r(r) {
    const kind = rEnum(r, VEHICLE_KINDS);
    const color = r.u32();
    const owner = rEnum(r, OWNERS);
    const dentVersion = r.varu();
    const n = r.count(12, 64);
    const dents: Dent[] = [];
    for (let i = 0; i < n; i++) {
      dents.push({ lx: r.i16() * POS_STEP, ly: r.i16() * POS_STEP, lz: r.i16() * POS_STEP, nx: rAxis(r), nz: rAxis(r), depth: r.u16() * DENT_STEP });
    }
    return { kind, color, owner, dentVersion, dents };
  },
};

const characterMotion: Codec<CharacterMotion> = {
  w(w, c) {
    wPos(w, c.x); wPos(w, c.y); wPos(w, c.z);
    wVel(w, c.vx); wVel(w, c.vy); wVel(w, c.vz);
    wAngle(w, c.heading);
    wAngle(w, c.animPhase);
    wBool(w, c.onGround);
  },
  r(r) {
    const x = rPos(r), y = rPos(r), z = rPos(r);
    const vx = rVel(r), vy = rVel(r), vz = rVel(r);
    const heading = rAngle(r);
    const animPhase = rAngle(r);
    const onGround = rBool(r);
    // characterPhysics derives it the same way.
    return { x, y, z, vx, vy, vz, heading, speed: Math.hypot(vx, vz), animPhase, onGround };
  },
};

const characterStatus: Codec<CharacterStatus> = {
  w(w, c) {
    wEnum(w, CHAR_STATES, c.state);
    w.varu(c.vehicle);
    w.u8(clampInt(c.seat, 0, 255));
    w.f32(fin(c.health));
    w.f32(fin(c.armor));
    wBool(w, c.cower);
  },
  r(r) {
    return { state: rEnum(r, CHAR_STATES) as CharState, vehicle: r.varu(), seat: r.u8(), health: rFinite(r, r.f32), armor: rFinite(r, r.f32), cower: rBool(r) };
  },
};

const characterCombat: Codec<CharacterCombat> = {
  w(w, c) {
    wEnum(w, WEAPON_ORDER, c.weapon);
    wEnum(w, WEAPON_ORDER, c.reloadWeapon);
    flagsOut(w, [c.aiming, c.aimZoom]);
    wSAngle(w, c.aimPitch);
    wSAngle(w, c.aimYaw);
    wTimer(w, c.punchTimer);
    wTimer(w, c.shotTimer);
    wTimer(w, c.reloadTimer);
    w.u8(clampInt(c.meleeCombo, 0, 255));
  },
  r(r) {
    const weapon = rEnum(r, WEAPON_ORDER) as WeaponId;
    const reloadWeapon = rEnumOrNull(r, WEAPON_ORDER) as WeaponId | null;
    const [aiming, aimZoom] = flagsIn(r, 2) as [boolean, boolean];
    return { weapon, reloadWeapon, aiming, aimZoom, aimPitch: rSAngle(r), aimYaw: rSAngle(r), punchTimer: rTimer(r), shotTimer: rTimer(r), reloadTimer: rTimer(r), meleeCombo: r.u8() };
  },
};

const appearanceCodec: Codec<Appearance> = {
  w(w, a) {
    w.u32(a.skin >>> 0); w.u32(a.shirt >>> 0); w.u32(a.pants >>> 0); w.u32(a.hair >>> 0); w.u32(a.hat >>> 0);
    w.f32(fin(a.height)); w.f32(fin(a.build));
  },
  r(r) {
    return { skin: r.u32(), shirt: r.u32(), pants: r.u32(), hair: r.u32(), hat: r.u32(), height: rFinite(r, r.f32), build: rFinite(r, r.f32) };
  },
};

const characterRare: Codec<CharacterRare> = {
  w(w, c) {
    wEnum(w, ROLES, c.role);
    appearanceCodec.w(w, c.appearance);
    w.f32(fin(c.maxHealth));
  },
  r(r) {
    return { role: rEnum(r, ROLES) as CharacterRare['role'], appearance: appearanceCodec.r(r), maxHealth: rFinite(r, r.f32) };
  },
};

const projectileState: Codec<ProjectileState> = {
  w(w, p) {
    wPos(w, p.x); wPos(w, p.y); wPos(w, p.z);
    wVel(w, p.vx); wVel(w, p.vy); wVel(w, p.vz);
    w.varu(p.owner);
  },
  r(r) {
    return { x: rPos(r), y: rPos(r), z: rPos(r), vx: rVel(r), vy: rVel(r), vz: rVel(r), owner: r.varu() };
  },
};

const heliState: Codec<HeliState> = {
  w(w, h) {
    wPos(w, h.x); wPos(w, h.y); wPos(w, h.z);
    wVel(w, h.vx); wVel(w, h.vy); wVel(w, h.vz);
    wAngle(w, h.heading);
    wAngle(w, h.rotor);
    w.f32(fin(h.health));
    flagsOut(w, [h.destroyed, h.crashing]);
    wPos(w, h.spotX); wPos(w, h.spotZ);
  },
  r(r) {
    const x = rPos(r), y = rPos(r), z = rPos(r);
    const vx = rVel(r), vy = rVel(r), vz = rVel(r);
    const heading = rAngle(r);
    const rotor = rAngle(r);
    const health = rFinite(r, r.f32);
    const [destroyed, crashing] = flagsIn(r, 2) as [boolean, boolean];
    return { x, y, z, vx, vy, vz, heading, rotor, health, destroyed, crashing, spotX: rPos(r), spotZ: rPos(r) };
  },
};

const pickupState: Codec<PickupState> = {
  w(w, p) {
    wEnum(w, PICKUP_KINDS, p.kind);
    wPos(w, p.x); wPos(w, p.y); wPos(w, p.z);
    w.f32(fin(p.amount));
    wEnum(w, WEAPON_ORDER, p.weapon);
    wBool(w, p.active);
    w.str(p.tag, 128);
  },
  r(r) {
    return {
      kind: rEnum(r, PICKUP_KINDS) as PickupState['kind'],
      x: rPos(r), y: rPos(r), z: rPos(r),
      amount: rFinite(r, r.f32),
      weapon: rEnumOrNull(r, WEAPON_ORDER) as WeaponId | null,
      active: rBool(r),
      tag: r.str(128),
    };
  },
};

/** One entity section of a snapshot: its record groups in wire order (bit i of a record's mask = group i). */
export interface SectionDef { key: SectionKey; groups: ReadonlyArray<readonly [name: string, codec: Codec<never>]> }
export type SectionKey = 'vehicles' | 'characters' | 'projectiles' | 'helis' | 'pickups';

const g = <T>(name: string, c: Codec<T>) => [name, c as unknown as Codec<never>] as const;
export const SECTIONS: readonly SectionDef[] = [
  { key: 'vehicles', groups: [g('motion', vehicleMotion), g('engine', vehicleEngine), g('status', vehicleStatus), g('rare', vehicleRare)] },
  { key: 'characters', groups: [g('motion', characterMotion), g('status', characterStatus), g('combat', characterCombat), g('rare', characterRare)] },
  { key: 'projectiles', groups: [g('state', projectileState)] },
  { key: 'helis', groups: [g('state', heliState)] },
  { key: 'pickups', groups: [g('state', pickupState)] },
];

/** Encodes one group on its own (the server caches these per entity and compares them per client). */
export function encodeGroup(section: SectionKey, group: string, value: unknown, w: Writer): void {
  const def = SECTIONS.find((s) => s.key === section)!;
  const codec = def.groups.find((x) => x[0] === group)![1] as unknown as Codec<unknown>;
  codec.w(w, value);
}

// ---------------------------------------------------------------------------
// Events

type FieldKind = 'f' | 'u' | 'b' | 's' | 'r';
interface EventSchema { type: string; fields: ReadonlyArray<readonly [string, FieldKind]> }

const XYZ = [['x', 'f'], ['y', 'f'], ['z', 'f']] as const;
/** Compact layouts for the frequent world events; any other event type goes out in the generic form. */
export const EVENT_SCHEMAS: readonly EventSchema[] = [
  { type: 'shot', fields: [['shooter', 'r'], ['weapon', 's'], ['fx', 'f'], ['fy', 'f'], ['fz', 'f'], ['tx', 'f'], ['ty', 'f'], ['tz', 'f'], ['hit', 's'], ['nx', 'f'], ['ny', 'f'], ['nz', 'f'], ['pellet', 'u']] },
  { type: 'weaponFired', fields: [['shooter', 'r'], ['weapon', 's'], ...XYZ, ['dx', 'f'], ['dy', 'f'], ['dz', 'f'], ['pellets', 'u']] },
  { type: 'damage', fields: [['victim', 'r'], ['attacker', 'r'], ['healthLoss', 'f'], ['armourLoss', 'f'], ['kind', 's'], ['zone', 's'], ['killed', 'b'], ['dirX', 'f'], ['dirZ', 'f']] },
  { type: 'explosion', fields: [...XYZ, ['radius', 'f']] },
  { type: 'impact', fields: [...XYZ, ['strength', 'f'], ['vehicle', 'r']] },
  { type: 'blood', fields: [...XYZ, ['dx', 'f'], ['dy', 'f'], ['dz', 'f']] },
  { type: 'melee', fields: [...XYZ, ['hit', 'b']] },
  { type: 'propBroken', fields: [['index', 'u'], ['dirX', 'f'], ['dirZ', 'f']] },
  { type: 'scrape', fields: [...XYZ, ['speed', 'f'], ['vehicle', 'r'], ['other', 'r']] },
  { type: 'splash', fields: [...XYZ, ['big', 'b']] },
  { type: 'lightning', fields: [['x', 'f'], ['z', 'f'], ['dist', 'f']] },
  { type: 'horn', fields: [['vehicle', 'r']] },
  { type: 'vehicleEnter', fields: [['vehicle', 'r'], ['character', 'r'], ['jacked', 'b']] },
  { type: 'vehicleExit', fields: [['vehicle', 'r'], ['character', 'r']] },
  { type: 'vehicleDestroyed', fields: [['vehicle', 'r']] },
  { type: 'characterKilled', fields: [['victim', 'r'], ['killer', 'r']] },
  { type: 'pickup', fields: [['kind', 's'], ...XYZ] },
  { type: 'scream', fields: [...XYZ] },
  { type: 'reload', fields: [['character', 'r']] },
];
const GENERIC_EVENT = 255;

const isRef = (v: unknown): v is NetRef => !!v && typeof v === 'object' && typeof (v as NetRef).$id === 'number' && Object.keys(v).length === 1;

/**
 * A sim event as plain data: entity objects (anything with an id and a position) become { $id }, undefined fields are
 * dropped, and a payload's `playerId` moves to the event.
 */
export function toNetEvent(type: string, payload: unknown, playerId = 0): NetEvent {
  const data: Record<string, unknown> = {};
  let pid = playerId;
  if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (k === 'playerId' && typeof v === 'number') {
        pid = v;
        continue;
      }
      if (v && typeof v === 'object' && 'id' in v && 'pos' in v) data[k] = { $id: (v as { id: number }).id };
      else data[k] = v;
    }
  }
  return { type, playerId: pid, data };
}

const G_NULL = 0, G_NUM = 1, G_STR = 2, G_BOOL = 3, G_REF = 4, G_JSON = 5;

function writeEvent(w: Writer, e: NetEvent): void {
  const si = EVENT_SCHEMAS.findIndex((s) => s.type === e.type);
  if (si >= 0) {
    w.u8(si);
    w.varu(e.playerId);
    for (const [name, kind] of EVENT_SCHEMAS[si]!.fields) {
      const v = e.data[name];
      switch (kind) {
        case 'f': w.f32(typeof v === 'number' ? v : 0); break;
        case 'u': w.varu(typeof v === 'number' ? Math.max(0, Math.round(v)) : 0); break;
        case 'b': wBool(w, v === true); break;
        case 's': w.str(typeof v === 'string' ? v : '', 64); break;
        case 'r': w.varu(isRef(v) ? v.$id + 1 : 0); break;
      }
    }
    return;
  }
  w.u8(GENERIC_EVENT);
  w.str(e.type, 64);
  w.varu(e.playerId);
  const entries = Object.entries(e.data);
  w.varu(entries.length);
  for (const [k, v] of entries) {
    w.str(k, 64);
    if (v === null || v === undefined) w.u8(G_NULL);
    else if (typeof v === 'number') { w.u8(G_NUM); w.f64(v); }
    else if (typeof v === 'string') { w.u8(G_STR); w.str(v, 4096); }
    else if (typeof v === 'boolean') { w.u8(G_BOOL); wBool(w, v); }
    else if (isRef(v)) { w.u8(G_REF); w.varu(v.$id); }
    else { w.u8(G_JSON); w.str(JSON.stringify(v) ?? 'null', 8192); }
  }
}

function readEvent(r: Reader): NetEvent {
  const si = r.u8();
  if (si !== GENERIC_EVENT) {
    const schema = EVENT_SCHEMAS[si];
    if (!schema) throw new ProtocolError('value', `unknown event schema ${si}`);
    const playerId = r.varu();
    const data: Record<string, unknown> = {};
    for (const [name, kind] of schema.fields) {
      switch (kind) {
        case 'f': data[name] = r.f32(); break;
        case 'u': data[name] = r.varu(); break;
        case 'b': data[name] = rBool(r); break;
        case 's': data[name] = r.str(64); break;
        case 'r': {
          const id = r.varu();
          data[name] = id === 0 ? null : { $id: id - 1 };
          break;
        }
      }
    }
    return { type: schema.type, playerId, data };
  }
  const type = r.str(64);
  const playerId = r.varu();
  const n = r.count(2, 256);
  const data: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const k = r.str(64);
    const tag = r.u8();
    switch (tag) {
      case G_NULL: data[k] = null; break;
      case G_NUM: data[k] = r.f64(); break;
      case G_STR: data[k] = r.str(4096); break;
      case G_BOOL: data[k] = rBool(r); break;
      case G_REF: data[k] = { $id: r.varu() }; break;
      case G_JSON: {
        const s = r.str(8192);
        try {
          data[k] = JSON.parse(s) as unknown;
        } catch {
          throw new ProtocolError('value', 'bad JSON event field');
        }
        break;
      }
      default: throw new ProtocolError('value', `unknown event field tag ${tag}`);
    }
  }
  return { type, playerId, data };
}

// ---------------------------------------------------------------------------
// Snapshot pieces

function writeClock(w: Writer, c: ClockState): void {
  w.u16(clampInt(c.day, 0, 65535));
  w.f32(fin(c.hours));
  w.f32(fin(c.rate));
}
function readClock(r: Reader): ClockState {
  return { day: r.u16(), hours: rFinite(r, r.f32), rate: rFinite(r, r.f32) };
}

export function writeWeather(w: Writer, s: WeatherState): void {
  wEnum(w, WEATHER_KINDS, s.kind);
  for (const v of [s.cloud, s.rain, s.storm, s.wet, s.dim, s.fog, s.seaState]) wFrac(w, v);
  wVel(w, s.wind.x);
  wVel(w, s.wind.z);
}
function readWeather(r: Reader): WeatherState {
  const kind = rEnum(r, WEATHER_KINDS) as WeatherState['kind'];
  const [cloud, rain, storm, wet, dim, fog, seaState] = [rFrac(r), rFrac(r), rFrac(r), rFrac(r), rFrac(r), rFrac(r), rFrac(r)];
  return { kind, cloud, rain, storm, wet, dim, fog, seaState, wind: { x: rVel(r), z: rVel(r) } };
}

export function writeIds(w: Writer, ids: readonly number[]): void {
  w.varu(ids.length);
  for (const id of ids) w.varu(id);
}
function readIds(r: Reader, max = 0xffff): number[] {
  const n = r.count(1, max);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(r.varu());
  return out;
}

function writeHolds(w: Writer, holds: ReadonlyArray<readonly [number, Axis]>): void {
  w.varu(holds.length);
  for (const [n, a] of holds) {
    w.varu(n);
    w.u8(AXES.indexOf(a) === 1 ? 1 : 0);
  }
}
function readHolds(r: Reader): Array<[number, Axis]> {
  const n = r.count(2, 4096);
  const out: Array<[number, Axis]> = [];
  for (let i = 0; i < n; i++) {
    const node = r.varu();
    const a = r.u8();
    if (a > 1) throw new ProtocolError('value', `bad axis ${a}`);
    out.push([node, AXES[a]!]);
  }
  return out;
}

/** Writes one entity record from already encoded groups (null = not sent). Returns false when nothing is sent. */
export function writeRecord(w: Writer, id: number, groups: ReadonlyArray<Uint8Array | null>): boolean {
  let mask = 0;
  for (let i = 0; i < groups.length; i++) if (groups[i]) mask |= 1 << i;
  if (mask === 0) return false;
  w.varu(id);
  w.u8(mask);
  for (const b of groups) if (b) w.raw(b);
  return true;
}

function writeSection(w: Writer, def: SectionDef, updates: ReadonlyArray<Record<string, unknown> & { id: number }>): void {
  w.varu(updates.length);
  const scratch = new Writer(256);
  for (const u of updates) {
    let mask = 0;
    def.groups.forEach(([name], i) => {
      if (u[name] !== undefined) mask |= 1 << i;
    });
    w.varu(u.id);
    w.u8(mask);
    for (const [name, codec] of def.groups) {
      const v = u[name];
      if (v === undefined) continue;
      scratch.reset();
      (codec as unknown as Codec<unknown>).w(scratch, v);
      w.raw(scratch.view8());
    }
  }
}

function readSection(r: Reader, def: SectionDef): Array<Record<string, unknown> & { id: number }> {
  const n = r.count(2, 0xffff);
  const out: Array<Record<string, unknown> & { id: number }> = [];
  for (let i = 0; i < n; i++) {
    const rec: Record<string, unknown> & { id: number } = { id: r.varu() };
    const mask = r.u8();
    if (mask >>> def.groups.length !== 0) throw new ProtocolError('value', `bad group mask ${mask} in ${def.key}`);
    def.groups.forEach(([name, codec], gi) => {
      if (mask & (1 << gi)) rec[name] = (codec as unknown as Codec<unknown>).r(r);
    });
    out.push(rec);
  }
  return out;
}

export interface SnapshotHead {
  tick: number;
  ackSeq: number;
  time: number;
  full: boolean;
  clock: ClockState;
  hud: Hud;
  job: JobHud | null;
  roster: RosterEntry[] | null;
  weather: WeatherState | null;
  signalHolds: ReadonlyArray<readonly [number, Axis]> | null;
  brokenProps: readonly number[];
}

const MAX_OBJECTIVES = 32;
const MAX_JOB_TEXT = 256;

/** A job HUD block on its own (the server compares these bytes to send it only on change). */
export function writeJobHud(w: Writer, j: JobHud): void {
  w.str(j.kind, 64);
  w.str(j.status, MAX_JOB_TEXT);
  const list = j.objectives.slice(0, MAX_OBJECTIVES);
  w.varu(list.length);
  for (const o of list) {
    w.i24(clampInt(fin(o.x) / POS_STEP, -0x800000, 0x7fffff));
    w.i24(clampInt(fin(o.z) / POS_STEP, -0x800000, 0x7fffff));
    w.str(o.label, MAX_JOB_TEXT);
    w.u32(clampInt(o.color, 0, 0xffffffff) >>> 0);
    w.f32(fin(o.radius));
    w.varu(clampInt(o.vehicle, 0, 0xffffffff));
    w.varu(clampInt(o.character, 0, 0xffffffff));
  }
}

function readJobHud(r: Reader): JobHud {
  const kind = r.str(64);
  const status = r.str(MAX_JOB_TEXT);
  const n = r.count(12, MAX_OBJECTIVES);
  const objectives: NetObjective[] = [];
  for (let i = 0; i < n; i++) {
    const x = r.i24() * POS_STEP;
    const z = r.i24() * POS_STEP;
    objectives.push({ x, z, label: r.str(MAX_JOB_TEXT), color: r.u32(), radius: rFinite(r, r.f32), vehicle: r.varu(), character: r.varu() });
  }
  return { kind, status, objectives };
}

/** Header and globals of a snapshot; the five entity sections and the removal list follow (see writeSnapshot). */
export function writeSnapshotHead(w: Writer, h: SnapshotHead): void {
  writeHeader(w, 'snapshot');
  w.u32(h.tick >>> 0);
  w.u32(h.ackSeq >>> 0);
  w.f64(fin(h.time));
  flagsOut(w, [h.full, h.roster !== null, h.weather !== null, h.signalHolds !== null, h.job !== null]);
  writeClock(w, h.clock);
  w.u8(clampInt(h.hud.wanted, 0, 255));
  flagsOut(w, [h.hud.searching, h.hud.down === 'wasted', h.hud.down === 'busted', h.hud.locked]);
  w.varu(clampInt(h.hud.money, 0, 0xffffffff));
  w.varu(clampInt(h.hud.clip, 0, 0xffffffff));
  w.varu(clampInt(h.hud.ammo, 0, 0xffffffff));
  if (h.job) writeJobHud(w, h.job);
  if (h.roster) {
    w.varu(h.roster.length);
    for (const p of h.roster) {
      w.varu(p.playerId);
      w.varu(p.characterId);
      w.i8(clampInt(p.slot, -1, 127));
      w.str(p.name, MAX_NAME_BYTES);
    }
  }
  if (h.weather) writeWeather(w, h.weather);
  if (h.signalHolds) writeHolds(w, h.signalHolds);
  writeIds(w, h.brokenProps);
}

function writeHeader(w: Writer, type: MessageType): void {
  w.u8(MAGIC);
  w.u8(PROTOCOL_VERSION);
  w.u8(MESSAGE_TYPES.indexOf(type));
}

// ---------------------------------------------------------------------------
// Encode / decode

export function encodeMessage(msg: Message, w: Writer = new Writer(256)): ArrayBuffer {
  w.reset();
  if (msg.type === 'snapshot') {
    writeSnapshotHead(w, msg);
    for (const def of SECTIONS) writeSection(w, def, msg[def.key] as unknown as Array<Record<string, unknown> & { id: number }>);
    writeIds(w, msg.removed);
    return w.finish();
  }
  writeHeader(w, msg.type);
  switch (msg.type) {
    case 'hello':
      w.u16(msg.version);
      w.str(msg.name, MAX_NAME_BYTES);
      w.str(msg.room, MAX_ROOM_BYTES);
      break;
    case 'welcome':
      w.varu(msg.playerId);
      w.i8(clampInt(msg.slot, -1, 127));
      w.str(msg.roomId, MAX_ROOM_BYTES);
      w.u32(msg.roomSeed >>> 0);
      w.u32(msg.tick >>> 0);
      w.u8(clampInt(msg.tickRate, 0, 255));
      w.u8(clampInt(msg.snapshotRate, 0, 255));
      writeIds(w, msg.brokenProps);
      writeHolds(w, msg.signalHolds);
      writeSection(w, SECTIONS[4]!, msg.pickups as unknown as Array<Record<string, unknown> & { id: number }>);
      break;
    case 'reject':
      w.u8(REJECT_CODES.indexOf(msg.code));
      w.str(msg.text, 512);
      break;
    case 'input':
      w.u32(msg.seq >>> 0);
      w.u32(msg.tick >>> 0);
      writeInput(w, msg.input);
      break;
    case 'event':
      w.u32(msg.tick >>> 0);
      w.varu(msg.events.length);
      for (const e of msg.events) writeEvent(w, e);
      break;
    case 'cmd':
      w.u32(msg.seq >>> 0);
      w.str(msg.name, 32);
      w.str(msg.arg, MAX_CMD_ARG_BYTES);
      break;
    case 'ping':
      w.f64(fin(msg.clientTime));
      break;
    case 'pong':
      w.f64(fin(msg.clientTime));
      w.f64(fin(msg.serverTime));
      w.u32(msg.tick >>> 0);
      break;
    case 'bye':
      w.str(msg.reason, 256);
      break;
  }
  return w.finish();
}

/** The message type of a frame with a valid header, without decoding the body (or null). */
export function peekType(data: ArrayBuffer | ArrayBufferView): { type: MessageType | null; version: number } | null {
  const r = new Reader(data);
  if (r.remaining < HEADER_BYTES) return null;
  if (r.u8() !== MAGIC) return null;
  const version = r.u8();
  return { version, type: MESSAGE_TYPES[r.u8()] ?? null };
}

export function decodeMessage(data: ArrayBuffer | ArrayBufferView): Message {
  const r = new Reader(data);
  if (r.remaining < HEADER_BYTES) throw new ProtocolError('truncated', 'message shorter than its header');
  if (r.u8() !== MAGIC) throw new ProtocolError('magic', 'not a GTA7 message');
  const version = r.u8();
  if (version !== PROTOCOL_VERSION) throw new ProtocolError('version', `protocol version ${version}, expected ${PROTOCOL_VERSION}`);
  const ti = r.u8();
  const type = MESSAGE_TYPES[ti];
  if (!type) throw new ProtocolError('type', `unknown message type ${ti}`);
  const msg = decodeBody(type, r);
  r.end();
  return msg;
}

function decodeBody(type: MessageType, r: Reader): Message {
  switch (type) {
    case 'hello':
      return { type, version: r.u16(), name: r.str(MAX_NAME_BYTES), room: r.str(MAX_ROOM_BYTES) };
    case 'welcome': {
      const playerId = r.varu();
      const slot = r.i8();
      const roomId = r.str(MAX_ROOM_BYTES);
      const roomSeed = r.u32();
      const tick = r.u32();
      const tickRate = r.u8();
      const snapshotRate = r.u8();
      const brokenProps = readIds(r);
      const signalHolds = readHolds(r);
      const pickups = readSection(r, SECTIONS[4]!) as unknown as PickupUpdate[];
      return { type, playerId, slot, roomId, roomSeed, tick, tickRate, snapshotRate, brokenProps, signalHolds, pickups };
    }
    case 'reject': {
      const ci = r.u8();
      const code = REJECT_CODES[ci];
      if (!code) throw new ProtocolError('value', `unknown reject code ${ci}`);
      return { type, code, text: r.str(512) };
    }
    case 'input':
      return { type, seq: r.u32(), tick: r.u32(), input: readInput(r) };
    case 'snapshot': {
      const tick = r.u32();
      const ackSeq = r.u32();
      const time = rFinite(r, r.f64);
      const [full, hasRoster, hasWeather, hasHolds, hasJob] = flagsIn(r, 5) as [boolean, boolean, boolean, boolean, boolean];
      const clock = readClock(r);
      const wanted = r.u8();
      const [searching, wasted, busted, locked] = flagsIn(r, 4) as [boolean, boolean, boolean, boolean];
      if (wasted && busted) throw new ProtocolError('value', 'wasted and busted at once');
      const hud: Hud = { wanted, searching, money: r.varu(), clip: r.varu(), ammo: r.varu(), down: wasted ? 'wasted' : busted ? 'busted' : null, locked };
      const job = hasJob ? readJobHud(r) : null;
      let roster: RosterEntry[] | null = null;
      if (hasRoster) {
        const n = r.count(4, 256);
        roster = [];
        for (let i = 0; i < n; i++) roster.push({ playerId: r.varu(), characterId: r.varu(), slot: r.i8(), name: r.str(MAX_NAME_BYTES) });
      }
      const weather = hasWeather ? readWeather(r) : null;
      const signalHolds = hasHolds ? readHolds(r) : null;
      const brokenProps = readIds(r);
      const sec = SECTIONS.map((def) => readSection(r, def));
      const removed = readIds(r);
      return {
        type, tick, ackSeq, time, full, clock, hud, job, roster, weather, signalHolds, brokenProps,
        vehicles: sec[0] as unknown as VehicleUpdate[],
        characters: sec[1] as unknown as CharacterUpdate[],
        projectiles: sec[2] as unknown as ProjectileUpdate[],
        helis: sec[3] as unknown as HeliUpdate[],
        pickups: sec[4] as unknown as PickupUpdate[],
        removed,
      };
    }
    case 'event': {
      const tick = r.u32();
      const n = r.count(2, 4096);
      const events: NetEvent[] = [];
      for (let i = 0; i < n; i++) events.push(readEvent(r));
      return { type, tick, events };
    }
    case 'cmd':
      return { type, seq: r.u32(), name: r.str(32), arg: r.str(MAX_CMD_ARG_BYTES) };
    case 'ping':
      return { type, clientTime: rFinite(r, r.f64) };
    case 'pong':
      return { type, clientTime: rFinite(r, r.f64), serverTime: rFinite(r, r.f64), tick: r.u32() };
    case 'bye':
      return { type, reason: r.str(256) };
  }
}

/** decodeMessage without throwing: the error for anything that is not a valid message. */
export function tryDecode(data: ArrayBuffer | ArrayBufferView): { ok: true; msg: Message } | { ok: false; error: ProtocolError } {
  try {
    return { ok: true, msg: decodeMessage(data) };
  } catch (e) {
    if (e instanceof ProtocolError) return { ok: false, error: e };
    return { ok: false, error: new ProtocolError('value', e instanceof Error ? e.message : String(e)) };
  }
}
