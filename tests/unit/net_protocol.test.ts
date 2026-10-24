// The multiplayer protocol (src/net/protocol.ts): every message type round-trips through encode and decode within its
// documented quantization, extremes included, and anything malformed is rejected with a ProtocolError.

import { describe, expect, it } from 'vitest';
import {
  ANGLE_STEP, ANGVEL_STEP, AXIS_STEP, AXIS8_STEP, decodeMessage, encodeMessage, FRACTION_STEP, INPUT_FLAG_NAMES, MAGIC, MESSAGE_TYPES,
  POS_STEP, PROTOCOL_VERSION, ProtocolError, quantizeInput, TIMER_STEP, toNetEvent, tryDecode, VEL_STEP, Writer,
  type Message, type MessageOf, type MessageType, type SnapshotMsg,
} from '../../src/net/protocol';
import { neutralInput, type PlayerInput } from '../../src/sim/input';
import type { CharacterUpdate, PickupUpdate, VehicleUpdate } from '../../src/sim/snapshot';
import { Rng } from '../../src/core/rng';
import { makeSim } from './helpers';

const MAXPOS = 83886.07;
const allFlags = (on: boolean): PlayerInput => {
  const p = neutralInput();
  for (const f of INPUT_FLAG_NAMES) p[f] = on;
  return p;
};

function vehicle(id: number, sign = 1, full = true): VehicleUpdate {
  const vx = 89.99 * sign;
  const vz = -327.6;
  const heading = -3.5;
  return {
    id,
    motion: { x: 123.456 * sign, y: -0.37, z: -MAXPOS * sign, heading, pitch: 0.21 * sign, roll: -0.4, vx, vz, vy: 59.99, angVel: -12.345, steer: -1, speed: Math.hypot(vx, vz), forwardSpeed: vx * Math.sin(heading) + vz * Math.cos(heading) },
    engine: { rpm: 0.73, gear: -1, skid: 1, throttle: 0.5, brake: 1, ctlSteer: -0.25, handbrake: true, braking: false, reversing: true, siren: true, horn: false },
    status: { health: -123.5, burning: true, destroyed: false, flipped: true, airborne: false, inWater: true, wreckTime: 255, driver: 4_000_000_000, passengers: [0, 7, 12345] },
    rare: full ? { kind: 'sports', color: 0xffffff, owner: 'parked', dentVersion: 99, dents: [{ lx: 2.25, ly: 0.725, lz: -1.1, nx: 0, nz: -1, depth: 0.4 }, { lx: 0, ly: 1.18, lz: 0, nx: 0, nz: 0, depth: 0.15 }] } : undefined,
  };
}

function character(id: number): CharacterUpdate {
  return {
    id,
    motion: { x: MAXPOS, y: 0, z: -0.01, vx: -3.3, vy: -59.5, vz: 7.4, heading: 6.28, speed: Math.hypot(-3.3, 7.4), animPhase: 3.14, onGround: false },
    status: { state: 'swimming', vehicle: 0, seat: 3, health: 99.5, armor: 37.25, cower: true },
    combat: { weapon: 'rocket', reloadWeapon: null, aiming: true, aimZoom: false, aimPitch: -1.2, aimYaw: 0.3, punchTimer: 0.38, shotTimer: 65.535, reloadTimer: 0, meleeCombo: 2 },
    rare: { role: 'swat', appearance: { skin: 0xf1c27d, shirt: 0, pants: 0x1a1a1a, hair: 0xffffff, hat: 0, height: 1.0625, build: 0.88 }, maxHealth: 150 },
  };
}

const pickup = (id: number): PickupUpdate => ({ id, state: { kind: 'weapon', x: -10.5, y: 0.6, z: 250.25, amount: 120, weapon: 'smg', active: false, tag: 'weapon:smg:3' } });

function snapshot(over: Partial<SnapshotMsg> = {}): SnapshotMsg {
  return {
    type: 'snapshot', tick: 0xffffffff, ackSeq: 0, time: 1234.5678, full: true,
    clock: { day: 65535, hours: 23.999, rate: 1 / 60 },
    hud: { wanted: 5, searching: true, money: 999_999_999, clip: 30, ammo: 9999, down: 'busted', locked: true },
    job: { kind: 'taxi', status: 'FARE 3 · $120 · 0:42', objectives: [
      { x: -83886, z: 83886, label: 'Pick up the fare', color: 0x55ccff, radius: 4, vehicle: 0, character: 4_294_967_295 },
      { x: 12.34, z: -5.67, label: 'Zoë 🚗 東京', color: 0xffffffff, radius: 0, vehicle: 7, character: 0 },
    ] },
    roster: [{ playerId: 1, characterId: 1, slot: 0, name: 'Zoë 🚗 東京' }, { playerId: 2, characterId: 0, slot: -1, name: '' }],
    weather: { kind: 'storm', cloud: 1, rain: 0.5, storm: 0, wet: 0.25, dim: 0.75, fog: 0.1, wind: { x: -12.5, z: 3 }, seaState: 0.3 },
    signalHolds: [[0, 'NS'], [120, 'EW']],
    brokenProps: [0, 3816, 127, 128],
    vehicles: [vehicle(1), vehicle(2, -1, false), { id: 3, rare: vehicle(3).rare }],
    characters: [character(9), { id: 10, combat: character(10).combat }],
    projectiles: [{ id: 50, state: { x: 1, y: 2, z: 3, vx: -60, vy: 0, vz: 60, owner: 9 } }],
    helis: [{ id: 60, state: { x: -400, y: 70, z: 200, vx: 1, vy: -2, vz: 3, heading: 1.5, rotor: 12.6, health: 1600, destroyed: false, crashing: true, spotX: -405.5, spotZ: 210.25 } }],
    pickups: [pickup(70)],
    removed: [4, 5, 4_294_967_295],
    ...over,
  };
}

const SAMPLES: { [K in MessageType]: Array<MessageOf<K>> } = {
  hello: [
    { type: 'hello', version: PROTOCOL_VERSION, name: 'Zoë 🚗 東京', room: 'alpha' },
    { type: 'hello', version: 0, name: '', room: '' },
    { type: 'hello', version: 65535, name: 'x'.repeat(48), room: 'r'.repeat(64) },
  ],
  welcome: [
    { type: 'welcome', playerId: 1, slot: 0, roomId: 'lobby', roomSeed: 0xffffffff, tick: 0, tickRate: 60, snapshotRate: 30, brokenProps: [], signalHolds: [], pickups: [] },
    { type: 'welcome', playerId: 4_294_967_295, slot: -1, roomId: 'ß-room', roomSeed: 0, tick: 0xffffffff, tickRate: 255, snapshotRate: 0, brokenProps: [1, 2, 3816], signalHolds: [[5, 'EW']], pickups: [pickup(1), pickup(2)] },
  ],
  reject: [
    { type: 'reject', code: 'full', text: 'Room "alpha" is full (8 players).' },
    { type: 'reject', code: 'version', text: '' },
    { type: 'reject', code: 'badHello', text: 'ü' },
  ],
  input: [
    { type: 'input', seq: 1, tick: 0, input: allFlags(true) },
    { type: 'input', seq: 0xffffffff, tick: 0xffffffff, input: allFlags(false) },
    { type: 'input', seq: 77, tick: 5, input: { ...allFlags(false), moveX: -1, moveZ: 1, throttle: 0.333, brake: 0, steer: -0.75, cameraYaw: -2.5, aimOrigin: { x: -MAXPOS, y: 3.25, z: MAXPOS }, aimDir: { x: 0.6, y: -0.48, z: -0.64 }, selectSlot: 5, fire: true } },
    { type: 'input', seq: 78, tick: 6, input: { ...allFlags(true), selectSlot: 0, cameraYaw: 0 } },
  ],
  snapshot: [
    snapshot(),
    snapshot({ full: false, roster: null, weather: null, signalHolds: null, brokenProps: [], vehicles: [], characters: [], projectiles: [], helis: [], pickups: [], removed: [], time: 0, tick: 0, clock: { day: 0, hours: 0, rate: 0 }, hud: { wanted: 0, searching: false, money: 0, clip: 0, ammo: 0, down: null, locked: false }, job: null }),
    snapshot({ hud: { wanted: 1, searching: false, money: 5, clip: 0, ammo: 0, down: 'wasted', locked: false } }),
    // A full entity list: hundreds of vehicles and characters in one snapshot.
    snapshot({ vehicles: Array.from({ length: 300 }, (_, i) => vehicle(1000 + i, i % 2 ? 1 : -1)), characters: Array.from({ length: 300 }, (_, i) => character(5000 + i)) }),
  ],
  event: [
    { type: 'event', tick: 10, events: [] },
    {
      type: 'event', tick: 11, events: [
        { type: 'shot', playerId: 0, data: { shooter: { $id: 1 }, weapon: 'pistol', fx: 1.5, fy: 2, fz: -3, tx: 40, ty: 1, tz: -80, hit: 'flesh', nx: 0, ny: 1, nz: 0, pellet: 3 } },
        { type: 'shot', playerId: 0, data: { shooter: null, weapon: 'rifle', fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, hit: 'none', nx: 0, ny: 0, nz: 0, pellet: 0 } },
        { type: 'damage', playerId: 0, data: { victim: { $id: 0 }, attacker: { $id: 4_294_967_294 }, healthLoss: 34, armourLoss: 0, kind: 'bullet', zone: 'head', killed: true, dirX: -0.5, dirZ: 0.5 } },
        { type: 'money', playerId: 3, data: { amount: -250 } },
        { type: 'streetRunFinished', playerId: 1, data: { id: 'magnolia', time: 61.25, medal: 'gold', personalBest: true, reward: 500, nested: { a: [1, 2] }, who: { $id: 7 }, none: null } },
        { type: 'wasted', playerId: 2, data: {} },
      ],
    },
  ],
  cmd: [
    { type: 'cmd', seq: 3, name: 'respawn', arg: '' },
    { type: 'cmd', seq: 0xffffffff, name: 'debug', arg: JSON.stringify({ wanted: 3, teleport: [-4, 0] }) },
  ],
  ping: [{ type: 'ping', clientTime: 123456.789 }, { type: 'ping', clientTime: 0 }],
  pong: [{ type: 'pong', clientTime: 1.5, serverTime: 99999.25, tick: 0xffffffff }],
  bye: [{ type: 'bye', reason: 'quit to title' }, { type: 'bye', reason: '' }],
};

// --- tolerance-aware comparison -------------------------------------------------

const POS_KEYS = new Set(['x', 'y', 'z', 'spotX', 'spotZ', 'lx', 'ly', 'lz']);
const ANGLE_KEYS = new Set(['heading', 'rotor', 'animPhase', 'cameraYaw', 'pitch', 'roll', 'aimPitch', 'aimYaw']);
const VEL_KEYS = new Set(['vx', 'vy', 'vz']);
/** Derived on decoding from the quantized velocity and heading. */
const DERIVED_KEYS = new Set(['speed', 'forwardSpeed']);
const AXIS_KEYS = new Set(['moveX', 'moveZ', 'throttle', 'brake', 'steer', 'ctlSteer', 'nx', 'nz']);
const FRACTION_KEYS = new Set(['rpm', 'skid', 'cloud', 'rain', 'storm', 'wet', 'dim', 'fog', 'seaState']);
const TIMER_KEYS = new Set(['punchTimer', 'shotTimer', 'reloadTimer']);
const F32_KEYS = new Set(['health', 'armor', 'maxHealth', 'hours', 'rate', 'amount', 'height', 'build']);

function angDiff(a: number, b: number): number {
  const d = (((a - b) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return Math.abs(d);
}

function tolerance(path: string[], key: string): ((a: number, e: number) => boolean) | null {
  const parent = path[path.length - 2] ?? '';
  const eps = 1e-9;
  if (parent === 'aimDir') return (a, e) => Math.abs(a - e) <= AXIS_STEP / 2 + eps;
  if (parent === 'wind') return (a, e) => Math.abs(a - e) <= VEL_STEP / 2 + eps;
  if (path.includes('data')) return (a, e) => a === e || Math.abs(a - Math.fround(e)) <= Math.abs(e) * 1e-7 + eps;
  if (key === 'depth') return (a, e) => Math.abs(a - e) <= 0.00005 + eps;
  if (parent === 'engine' && (key === 'throttle' || key === 'brake' || key === 'ctlSteer')) return (a, e) => Math.abs(a - e) <= AXIS8_STEP / 2 + eps;
  if (DERIVED_KEYS.has(key)) return (a, e) => Math.abs(a - e) <= 0.03;
  if (POS_KEYS.has(key)) return (a, e) => Math.abs(a - e) <= POS_STEP / 2 + eps;
  if (ANGLE_KEYS.has(key)) return (a, e) => angDiff(a, e) <= ANGLE_STEP / 2 + eps;
  if (VEL_KEYS.has(key)) return (a, e) => Math.abs(a - e) <= VEL_STEP / 2 + eps;
  if (key === 'angVel') return (a, e) => Math.abs(a - e) <= ANGVEL_STEP / 2 + eps;
  if (AXIS_KEYS.has(key)) return (a, e) => Math.abs(a - e) <= AXIS_STEP / 2 + eps;
  if (FRACTION_KEYS.has(key)) return (a, e) => Math.abs(a - e) <= FRACTION_STEP / 2 + eps;
  if (TIMER_KEYS.has(key)) return (a, e) => Math.abs(a - e) <= TIMER_STEP / 2 + eps;
  if (F32_KEYS.has(key)) return (a, e) => a === Math.fround(e);
  return null;
}

/** Deep comparison: quantized fields within their step, everything else exact. Returns the mismatching paths. */
function diff(actual: unknown, expected: unknown, path: string[] = []): string[] {
  const at = path.join('.') || '(root)';
  if (typeof expected === 'number') {
    if (typeof actual !== 'number') return [`${at}: ${String(actual)} is not a number`];
    const key = path[path.length - 1] ?? '';
    const tol = tolerance(path, key);
    const ok = tol ? tol(actual, expected) : actual === expected;
    return ok ? [] : [`${at}: got ${actual}, want ${expected}`];
  }
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected) ? [] : [`${at}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`];
  if (!actual || typeof actual !== 'object') return [`${at}: got ${JSON.stringify(actual)}`];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${at}: array length ${Array.isArray(actual) ? actual.length : '-'} vs ${expected.length}`];
    return expected.flatMap((e, i) => diff(actual[i], e, [...path, String(i)]));
  }
  const out: string[] = [];
  const ek = Object.keys(expected).filter((k) => (expected as Record<string, unknown>)[k] !== undefined);
  const ak = Object.keys(actual).filter((k) => (actual as Record<string, unknown>)[k] !== undefined);
  if (ek.sort().join() !== ak.sort().join()) out.push(`${at}: keys ${ak.join(',')} vs ${ek.join(',')}`);
  for (const k of ek) out.push(...diff((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], [...path, k]));
  return out;
}

function roundTrip(m: Message): Message {
  return decodeMessage(encodeMessage(m));
}

describe('protocol round trips', () => {
  it('has samples for every message type the protocol defines', () => {
    for (const t of MESSAGE_TYPES) expect(SAMPLES[t]?.length ?? 0, t).toBeGreaterThan(0);
    expect(Object.keys(SAMPLES).sort()).toEqual([...MESSAGE_TYPES].sort());
  });

  for (const type of MESSAGE_TYPES) {
    it(`${type} round-trips within its quantization`, () => {
      for (const m of SAMPLES[type] as Message[]) {
        const buf = encodeMessage(m);
        expect(buf).toBeInstanceOf(ArrayBuffer);
        const view = new DataView(buf);
        expect(view.getUint8(0)).toBe(MAGIC);
        expect(view.getUint8(1)).toBe(PROTOCOL_VERSION);
        expect(MESSAGE_TYPES[view.getUint8(2)]).toBe(type);
        const back = decodeMessage(buf);
        expect(diff(back, m)).toEqual([]);
        // Decoding is exact on the second pass: quantized values are stable.
        expect(encodeMessage(back)).toEqual(buf);
      }
    });
  }

  it('the comparison itself flags values outside their step', () => {
    expect(diff({ x: 1.006 }, { x: 1 })).toHaveLength(1);
    expect(diff({ heading: 0.00002 }, { heading: Math.PI * 2 })).toEqual([]);
    expect(diff({ heading: 0.001 }, { heading: 0 })).toHaveLength(1);
    expect(diff({ seq: 2 }, { seq: 1 })).toHaveLength(1);
    expect(diff({ name: 'a' }, { name: 'b' })).toHaveLength(1);
    expect(diff({ a: 1, b: 2 }, { a: 1 })).toHaveLength(1);
  });

  it('input round trip covers every flag set and cleared, one at a time', () => {
    for (const f of INPUT_FLAG_NAMES) {
      for (const base of [allFlags(false), allFlags(true)]) {
        const inp = { ...base, [f]: !base[f] };
        const back = roundTrip({ type: 'input', seq: 1, tick: 1, input: inp }) as MessageOf<'input'>;
        for (const g of INPUT_FLAG_NAMES) expect(back.input[g], `${f}/${g}`).toBe(inp[g]);
      }
    }
  });

  it('quantizeInput is what the server sees, and stable', () => {
    const raw = { ...neutralInput(), moveX: 0.123456, steer: -0.98765, cameraYaw: 1.23456, aimOrigin: { x: 1.23456, y: 2.34567, z: -3.45678 }, aimDir: { x: 0.267, y: -0.534, z: 0.802 } };
    const q = quantizeInput(raw);
    const seen = (roundTrip({ type: 'input', seq: 1, tick: 0, input: raw }) as MessageOf<'input'>).input;
    expect(seen).toEqual(q);
    expect(quantizeInput(q)).toEqual(q);
    expect(Math.abs(q.aimOrigin.x - raw.aimOrigin.x)).toBeLessThanOrEqual(POS_STEP / 2);
  });

  it('clamps values outside a field range instead of wrapping', () => {
    const v = vehicle(1);
    v.motion!.x = 1e9;
    v.motion!.vx = -1e9;
    v.motion!.z = Number.NaN;
    const back = roundTrip(snapshot({ vehicles: [v] })) as SnapshotMsg;
    expect(back.vehicles[0]!.motion!.x).toBeCloseTo(MAXPOS, 1);
    expect(back.vehicles[0]!.motion!.vx).toBeCloseTo(-327.68, 2);
    expect(back.vehicles[0]!.motion!.z).toBe(0);
  });

  it('values outside the enum tables (content added later) still round-trip', () => {
    const v = vehicle(1);
    v.rare!.kind = 'motorbike';
    const c = character(2);
    c.combat!.weapon = 'sniper' as never;
    c.status!.state = 'drowning' as never;
    const back = roundTrip(snapshot({ vehicles: [v], characters: [c] })) as SnapshotMsg;
    expect(back.vehicles[0]!.rare!.kind).toBe('motorbike');
    expect(back.characters[0]!.combat!.weapon).toBe('sniper');
    expect(back.characters[0]!.status!.state).toBe('drowning');
  });

  it('sim events become id-based net events and round-trip', () => {
    const sim = makeSim();
    const car = sim.spawnVehicle('sedan', 0, 0, 0);
    const shot = toNetEvent('shot', { shooter: sim.player, weapon: 'pistol', fx: 1, fy: 2, fz: 3, tx: 4, ty: 5, tz: 6, hit: 'vehicle', nx: 0, ny: 0, nz: 1, pellet: 0 });
    expect(shot.data.shooter).toEqual({ $id: sim.player.id });
    const scrape = toNetEvent('scrape', { x: 1, y: 2, z: 3, speed: 4, vehicle: car, other: null });
    expect(scrape.data.vehicle).toEqual({ $id: car.id });
    const scoped = toNetEvent('money', { amount: 50, playerId: 4 });
    expect(scoped.playerId).toBe(4);
    expect(scoped.data).toEqual({ amount: 50 });
    const back = roundTrip({ type: 'event', tick: 1, events: [shot, scrape, scoped] }) as MessageOf<'event'>;
    expect(diff(back.events, [shot, scrape, scoped], ['events'])).toEqual([]);
  });
});

describe('malformed messages are rejected', () => {
  const all = (Object.values(SAMPLES) as Message[][]).flat();

  it('a wrong version is rejected with a version error', () => {
    for (const m of all) {
      const b = new Uint8Array(encodeMessage(m));
      b[1] = PROTOCOL_VERSION + 1;
      const r = tryDecode(b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('version');
    }
  });

  it('bad magic and unknown types are rejected', () => {
    const b = new Uint8Array(encodeMessage(SAMPLES.ping[0]!));
    expect(() => decodeMessage(Uint8Array.from([0x00, ...b.subarray(1)]))).toThrow(ProtocolError);
    expect(() => decodeMessage(Uint8Array.from([MAGIC, PROTOCOL_VERSION, 200]))).toThrow(/unknown message type/);
    expect(() => decodeMessage(new Uint8Array(0))).toThrow(ProtocolError);
  });

  it('every truncation of every message throws (never a partial value)', () => {
    let checked = 0;
    for (const m of all) {
      const b = new Uint8Array(encodeMessage(m));
      // Every prefix of the small messages, an even spread of cuts through the big ones.
      const cuts = b.length <= 4096 ? Array.from({ length: b.length }, (_, i) => i) : Array.from({ length: 512 }, (_, i) => Math.floor((i * b.length) / 512));
      for (const n of cuts) {
        const r = tryDecode(b.subarray(0, n));
        expect(r.ok, `${m.type} cut at ${n}/${b.length}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('trailing bytes are rejected', () => {
    for (const m of all) {
      const b = new Uint8Array(encodeMessage(m));
      const r = tryDecode(Uint8Array.from([...b, 0]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('trailing');
    }
  });

  it('length and count fields pointing past the end are rejected before allocating', () => {
    // hello with a name length of 2^31 and five bytes behind it.
    const w = new Writer();
    w.u8(MAGIC); w.u8(PROTOCOL_VERSION); w.u8(MESSAGE_TYPES.indexOf('hello'));
    w.u16(PROTOCOL_VERSION);
    w.varu(0x7fffffff);
    w.raw(new Uint8Array(5));
    expect(() => decodeMessage(w.finish())).toThrow(ProtocolError);
    // An event message claiming 4000 events with no bytes behind the count.
    const e = new Writer();
    e.u8(MAGIC); e.u8(PROTOCOL_VERSION); e.u8(MESSAGE_TYPES.indexOf('event'));
    e.u32(1);
    e.varu(4000);
    const r = tryDecode(e.finish());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/past the end/);
    // A snapshot whose first section claims 60000 records.
    const s = new Uint8Array(encodeMessage(snapshot({ roster: null, weather: null, signalHolds: null, brokenProps: [], vehicles: [], characters: [], projectiles: [], helis: [], pickups: [], removed: [] })));
    const cut = s.length - 6; // five empty section counts and the removal count, one byte each
    const bad = Uint8Array.from([...s.subarray(0, cut), 0xe0, 0xd4, 0x03, 0, 0, 0, 0, 0]);
    expect(tryDecode(bad).ok).toBe(false);
  });

  it('random bytes never decode into a value without throwing a ProtocolError', () => {
    const rng = new Rng(1234);
    let decoded = 0;
    for (let i = 0; i < 20000; i++) {
      const n = rng.int(0, 120);
      const b = new Uint8Array(n);
      for (let k = 0; k < n; k++) b[k] = rng.int(0, 255);
      // Half of them behind a valid header, to get past the first checks.
      if (i % 2 === 0 && n >= 3) {
        b[0] = MAGIC;
        b[1] = PROTOCOL_VERSION;
        b[2] = rng.int(0, MESSAGE_TYPES.length - 1);
      }
      try {
        const m = decodeMessage(b);
        // Whatever does decode is a whole, re-encodable message.
        expect(MESSAGE_TYPES).toContain(m.type);
        encodeMessage(m);
        decoded++;
      } catch (err) {
        expect(err).toBeInstanceOf(ProtocolError);
      }
    }
    console.log(`[protocol] 20000 random frames: ${decoded} happened to be valid messages, the rest threw ProtocolError`);
  });
});
