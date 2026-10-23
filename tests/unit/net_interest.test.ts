// Snapshots and interest management (src/sim/snapshot.ts, server/room.ts): what each player receives, how entities
// leave and come back, rare data sent only on change, and capture -> encode -> decode -> apply fidelity.

import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, POS_STEP, VEL_STEP, ANGLE_STEP, type SnapshotMsg } from '../../src/net/protocol';
import { Character, Vehicle } from '../../src/sim/entities';
import {
  applyCharacterUpdate, applyVehicleUpdate, captureCharacter, captureVehicle, DEFAULT_INTEREST, selectInterest, viewerAt,
} from '../../src/sim/snapshot';
import { Room } from '../../server/room';
import { FakePeer } from './net_helpers';
import { input, makeSim, step, teleport } from './helpers';

const angDiff = (a: number, b: number) => Math.abs(((((a - b) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);

describe('interest management', () => {
  it('two players 600 m apart: each gets what is near it, every player, and its pursuers', () => {
    const sim = makeSim();
    teleport(sim, -300, 0);
    const b = sim.spawnCharacter('player', 300, 0);
    b.persistent = true;
    const car100 = sim.spawnVehicle('sedan', -300, 100, 0);
    const mid300 = sim.spawnCharacter('civilian', 0, 0);
    const cop = sim.spawnVehicle('police', -40, 0, 0);
    const officer = sim.addDriver(cop, 'cop', 'chase');
    cop.ai!.target = sim.player;
    const nearB = sim.spawnVehicle('taxi', 300, 120, 0);
    const players = [sim.player, b];
    const forA = selectInterest(sim, [viewerAt(sim.player)], players, null);
    const forB = selectInterest(sim, [viewerAt(b)], players, null);
    const name = (id: number) => ({ [car100.id]: 'car@100mA', [mid300.id]: 'civ@300mBoth', [cop.id]: 'pursuer@260mA', [officer.id]: 'officer', [nearB.id]: 'taxi@120mB', [b.id]: 'playerB', [sim.player.id]: 'playerA' })[id] ?? `#${id}`;
    console.log(`[interest] A gets ${[...forA].map(name).join(', ')}; B gets ${[...forB].map(name).join(', ')}`);
    expect(forA.has(car100.id)).toBe(true);
    expect(forB.has(car100.id)).toBe(false);
    expect(forA.has(mid300.id)).toBe(false);
    expect(forB.has(mid300.id)).toBe(false);
    expect(forA.has(b.id)).toBe(true);
    expect(forB.has(sim.player.id)).toBe(true);
    expect(forA.has(cop.id)).toBe(true);
    expect(forA.has(officer.id)).toBe(true);
    expect(forB.has(cop.id)).toBe(false);
    expect(forB.has(nearB.id)).toBe(true);
    expect(forA.has(nearB.id)).toBe(false);
  });

  it('enters inside 250 m, stays until past the keep radius, never beyond 260 m', () => {
    const sim = makeSim();
    teleport(sim, 0, 0);
    const p = sim.player.pos;
    const at = (d: number) => sim.spawnCharacter('civilian', p.x + d, p.z);
    const c239 = at(239);
    const c249 = at(249);
    const c255 = at(255);
    const c262 = at(262);
    const first = selectInterest(sim, [viewerAt(sim.player)], [sim.player], null);
    expect(first.has(c239.id)).toBe(true);
    expect(first.has(c249.id)).toBe(true);
    expect(first.has(c255.id)).toBe(false);
    expect(first.has(c262.id)).toBe(false);
    // Already sent and drifting out: kept to the keep radius, then dropped.
    c249.pos.x = p.x + 256;
    const second = selectInterest(sim, [viewerAt(sim.player)], [sim.player], first);
    expect(second.has(c249.id)).toBe(true);
    c249.pos.x = p.x + DEFAULT_INTEREST.keepRadius + 1;
    const third = selectInterest(sim, [viewerAt(sim.player)], [sim.player], second);
    expect(third.has(c249.id)).toBe(false);
    expect(DEFAULT_INTEREST.keepRadius).toBeLessThanOrEqual(260);
  });

  it('a seated player is placed by its vehicle, and occupants travel with their vehicle', () => {
    const sim = makeSim();
    teleport(sim, 0, 0);
    const car = sim.spawnVehicle('sedan', 500, 0, 0);
    const passenger = sim.spawnCharacter('civilian', 500, 0);
    sim.seat(passenger, car, 1);
    const p2 = sim.spawnCharacter('player', -500, 0);
    sim.seat(p2, sim.spawnVehicle('sports', -500, 0, 0), 0);
    const set = selectInterest(sim, [viewerAt(sim.player)], [sim.player, p2], null);
    expect(set.has(passenger.id)).toBe(false);
    expect(set.has(p2.id)).toBe(true);
    expect(set.has(p2.vehicle!.id)).toBe(true);
    const near = selectInterest(sim, [{ x: 480, z: 0, character: null, wanted: 0 }], [], null);
    expect(near.has(car.id) && near.has(passenger.id)).toBe(true);
  });
});

describe('snapshot stream', () => {
  function setup() {
    const room = new Room('t', 7, { realtime: false, snapshotRate: 30, sim: { ambient: false } });
    const peer = new FakePeer();
    const m = room.join(1, 'Ann', peer);
    if (m === 'full') throw new Error('full');
    peer.send(room.welcome(m));
    const tick = (n = 2) => {
      for (let i = 0; i < n; i++) room.step();
      return peer.last('snapshot')!;
    };
    return { room, peer, m, tick };
  }

  it('leaving the radius sends a removal, coming back re-sends the entity in full, rare data goes on change only', () => {
    const { room, tick } = setup();
    const sim = room.sim;
    const p = sim.player.pos;
    const first = tick();
    expect(first.full).toBe(true);
    expect(first.characters.find((c) => c.id === sim.player.id)?.rare).toBeDefined();
    const car = sim.spawnVehicle('sedan', p.x + 100, p.z, 0);
    const s1 = tick();
    const rec1 = s1.vehicles.find((v) => v.id === car.id)!;
    expect(rec1.motion && rec1.engine && rec1.status && rec1.rare).toBeTruthy();
    // Parked and unchanged: not sent again.
    for (let i = 0; i < 10; i++) {
      const s = tick();
      if (i > 2) expect(s.vehicles.find((v) => v.id === car.id)).toBeUndefined();
    }
    // A dent: only the rare group goes out.
    car.dents.push({ lx: 0, ly: 0.7, lz: car.halfL, nx: 0, nz: -1, depth: 0.2 });
    car.dentVersion++;
    const s2 = tick();
    const rec2 = s2.vehicles.find((v) => v.id === car.id)!;
    expect(rec2.rare?.dents).toHaveLength(1);
    expect(rec2.motion).toBeUndefined();
    // Out of range: removed.
    car.pos.x = p.x + 300;
    const s3 = tick();
    expect(s3.removed).toContain(car.id);
    expect(s3.vehicles.find((v) => v.id === car.id)).toBeUndefined();
    const s4 = tick();
    expect(s4.removed).not.toContain(car.id);
    // Back in range: every group again.
    car.pos.x = p.x + 100;
    const s5 = tick();
    const rec5 = s5.vehicles.find((v) => v.id === car.id)!;
    expect(rec5.motion && rec5.engine && rec5.status && rec5.rare).toBeTruthy();
    expect(rec5.rare!.dents).toHaveLength(1);
    // Removed from the sim: a removal.
    sim.removeVehicle(car);
    const s6 = tick();
    expect(s6.removed).toContain(car.id);
    console.log(`[snapshot] car ${car.id}: full ${!!rec1.rare}, dent-only update ${!rec2.motion}, removed at 300 m ${s3.removed.includes(car.id)}, resent in full ${!!rec5.rare}, removed with the sim entity ${s6.removed.includes(car.id)}`);
  });

  it('broken props, weather and signal holds are sent when they change, not in every snapshot', () => {
    const { room, tick } = setup();
    const sim = room.sim;
    const first = tick();
    expect(first.weather).not.toBeNull();
    expect(first.signalHolds).not.toBeNull();
    const second = tick();
    expect(second.weather).toBeNull();
    expect(second.signalHolds).toBeNull();
    expect(second.brokenProps).toEqual([]);
    const prop = sim.world.grid.colliders.find((c) => c.breakable && !c.broken)!;
    const car = sim.spawnVehicle('sedan', prop.cx, prop.cz, 0);
    sim.onPropBroken(prop, car);
    sim.roads.holdSignal(sim.roads.nodes.find((n) => n.signal)!.id, 'NS');
    const third = tick();
    expect(third.brokenProps).toEqual([prop.propIndex]);
    expect(third.signalHolds).toHaveLength(1);
    const fourth = tick();
    expect(fourth.brokenProps).toEqual([]);
    expect(fourth.signalHolds).toBeNull();
  });

  it('the welcome seeds nearby pickups, which the snapshots then only update on change', () => {
    const room = new Room('t', 7, { realtime: false, snapshotRate: 30, sim: { ambient: false } });
    const sim = room.sim;
    const pk = sim.pickups[0]!;
    teleport(sim, pk.pos.x + 30, pk.pos.z);
    const peer = new FakePeer();
    const m = room.join(1, 'Ann', peer) as Exclude<ReturnType<Room['join']>, 'full'>;
    const welcome = decodeMessage(room.welcome(m));
    if (welcome.type !== 'welcome') throw new Error('no welcome');
    expect(welcome.pickups.map((p) => p.id)).toContain(pk.id);
    room.step();
    room.step();
    expect(peer.last('snapshot')!.pickups.find((p) => p.id === pk.id)).toBeUndefined();
    pk.active = !pk.active;
    room.step();
    room.step();
    expect(peer.last('snapshot')!.pickups.find((p) => p.id === pk.id)?.state?.active).toBe(pk.active);
  });
});

describe('capture, encode, decode, apply', () => {
  it('a busy scene survives the wire field by field within quantization', () => {
    const sim = makeSim({ ambient: true, seed: 3 });
    sim.wanted.setLevel(3);
    step(sim, 25, (t) => input({ moveZ: 1, sprint: t % 4 < 2 }));
    const vs = sim.vehicles.filter((v) => !v.removed);
    const cs = sim.characters.filter((c) => !c.removed);
    expect(vs.length).toBeGreaterThan(10);
    const msg: SnapshotMsg = {
      type: 'snapshot', tick: 1, ackSeq: 0, time: sim.time, full: true, clock: { day: 1, hours: 12, rate: 1 / 60 }, hud: { wanted: 3, searching: false, money: 0 },
      roster: null, weather: null, signalHolds: null, brokenProps: [], projectiles: [], helis: [], pickups: [], removed: [],
      vehicles: vs.map((v) => captureVehicle(v)),
      characters: cs.map((c) => captureCharacter(c)),
    };
    const back = decodeMessage(encodeMessage(msg)) as SnapshotMsg;
    const vById = new Map<number, Vehicle>();
    const cById = new Map<number, Character>();
    for (const u of back.vehicles) vById.set(u.id, new Vehicle(u.id, u.rare!.kind as Vehicle['kind'], 0, 0, 0, 0, 0));
    for (const u of back.characters) cById.set(u.id, new Character(u.id, u.rare!.role, 0, 0, 0, u.rare!.appearance));
    for (const u of back.vehicles) applyVehicleUpdate(vById.get(u.id)!, u, (id) => cById.get(id) ?? null);
    for (const u of back.characters) applyCharacterUpdate(cById.get(u.id)!, u, (id) => vById.get(id) ?? null);
    let worstPos = 0;
    for (const v of vs) {
      const m = vById.get(v.id)!;
      worstPos = Math.max(worstPos, Math.abs(m.pos.x - v.pos.x), Math.abs(m.pos.y - v.pos.y), Math.abs(m.pos.z - v.pos.z));
      expect(angDiff(m.heading, v.heading)).toBeLessThanOrEqual(ANGLE_STEP / 2 + 1e-9);
      expect(Math.abs(m.vel.x - v.vel.x)).toBeLessThanOrEqual(VEL_STEP / 2 + 1e-9);
      // Derived from the quantized velocity and heading on decoding.
      expect(Math.abs(m.forwardSpeed - v.forwardSpeed)).toBeLessThanOrEqual(0.03);
      expect(Math.abs(m.speed - v.speed)).toBeLessThanOrEqual(0.03);
      expect(Math.abs(m.rpm - v.rpm)).toBeLessThanOrEqual(1 / 510 + 1e-9);
      expect(m.kind).toBe(v.kind);
      expect(m.color).toBe(v.color);
      expect(m.owner).toBe(v.owner);
      expect(m.siren).toBe(v.siren);
      expect(m.destroyed).toBe(v.destroyed);
      expect(m.health).toBe(Math.fround(v.health));
      expect(m.driver?.id ?? 0).toBe(v.driver?.id ?? 0);
      expect(m.passengers.map((p) => p?.id ?? 0)).toEqual(v.passengers.map((p) => p?.id ?? 0));
      expect(m.dents.length).toBe(v.dents.length);
    }
    for (const c of cs) {
      const m = cById.get(c.id)!;
      worstPos = Math.max(worstPos, Math.abs(m.pos.x - c.pos.x), Math.abs(m.pos.z - c.pos.z));
      expect(angDiff(m.heading, c.heading)).toBeLessThanOrEqual(ANGLE_STEP / 2 + 1e-9);
      expect(m.state).toBe(c.state);
      expect(m.role).toBe(c.role);
      expect(m.appearance.shirt).toBe(c.appearance.shirt);
      expect(m.vehicle?.id ?? 0).toBe(c.vehicle?.id ?? 0);
      expect(m.inventory.current).toBe(c.inventory.current);
      expect(m.aiming).toBe(c.aiming);
    }
    expect(worstPos).toBeLessThanOrEqual(POS_STEP / 2 + 1e-9);
    const bytes = encodeMessage(msg).byteLength;
    console.log(`[snapshot] ${vs.length} vehicles + ${cs.length} characters in full: ${bytes} bytes (${(bytes / (vs.length + cs.length)).toFixed(1)} per entity), worst position error ${(worstPos * 1000).toFixed(2)} mm`);
  });
});
