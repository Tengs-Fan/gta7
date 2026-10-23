// Rooms, join and leave (server/rooms.ts, server/room.ts, server/connection.ts) driven headlessly through the real
// connection handler with in-process fake sockets.

import vm from 'node:vm';
import v8 from 'node:v8';
import { describe, expect, it } from 'vitest';
import { encodeMessage, PROTOCOL_VERSION, type Message } from '../../src/net/protocol';
import { neutralInput } from '../../src/sim/input';
import { Connection, type ConnectionOptions } from '../../server/connection';
import type { Room } from '../../server/room';
import { RoomManager } from '../../server/rooms';
import { PuppetSlotProvider } from '../../server/slots';
import { FakePeer } from './net_helpers';

const connOpts: ConnectionOptions = { defaultRoom: 'lobby', maxErrors: 32, ratePerSec: 10_000, rateBurst: 10_000, log: () => {}, now: () => performance.now() };

function manager(over: ConstructorParameters<typeof RoomManager>[0] = {}): RoomManager {
  return new RoomManager({ emptyRoomTtlMs: 60_000, log: () => {}, ...over, room: { realtime: false, snapshotRate: 30, log: () => {}, ...(over.room ?? {}) } });
}

interface Client { peer: FakePeer; conn: Connection; send(m: Message): void }

function connect(mgr: RoomManager, name: string, room = '', defaultRoom = 'lobby', version = PROTOCOL_VERSION): Client {
  const peer = new FakePeer();
  const conn = new Connection(peer, mgr, { ...connOpts, defaultRoom });
  const c: Client = { peer, conn, send: (m) => conn.onMessage(new Uint8Array(encodeMessage(m)), true) };
  c.send({ type: 'hello', version, name, room });
  return c;
}

function stepAll(mgr: RoomManager, n: number): void {
  for (let i = 0; i < n; i++) for (const r of mgr.rooms.values()) r.step();
}

function entityIds(c: Client): Set<number> {
  const ids = new Set<number>();
  for (const s of c.peer.of('snapshot')) {
    for (const list of [s.vehicles, s.characters, s.projectiles, s.helis, s.pickups]) for (const u of list) ids.add(u.id);
    for (const id of s.removed) ids.delete(id);
  }
  return ids;
}

describe('rooms are separate worlds selected by id', () => {
  it('alpha (2 players) and beta (1) share nothing; no room means lobby', () => {
    const mgr = manager();
    const a1 = connect(mgr, 'A1', 'alpha');
    const a2 = connect(mgr, 'A2', '', 'alpha'); // room from the ws URL (?room=alpha)
    const b1 = connect(mgr, 'B1', 'beta');
    const l1 = connect(mgr, 'L1');
    stepAll(mgr, 30);
    const alpha = mgr.room('alpha')!;
    const beta = mgr.room('beta')!;
    expect(mgr.room('lobby')!.members.size).toBe(1);
    expect(alpha.sim).not.toBe(beta.sim);
    expect(alpha.world).not.toBe(beta.world);
    expect(alpha.seed).not.toBe(beta.seed);
    expect(a1.peer.last('welcome')!.roomId).toBe('alpha');
    expect(a2.peer.last('welcome')!.roomId).toBe('alpha');
    expect(l1.peer.last('welcome')!.roomId).toBe('lobby');
    const counts = Object.fromEntries(mgr.status().map((r) => [r.id, r.players + r.spectators]));
    expect(counts).toEqual({ alpha: 2, beta: 1, lobby: 1 });

    const betaBefore = { ids: [...entityIds(b1)].sort((x, y) => x - y), vehicles: beta.sim.vehicles.length, wanted: beta.sim.wanted.level, broken: beta.world.grid.colliders.filter((c) => c.broken).length };
    // In alpha: a car next to the player, a broken prop, three stars.
    const p = alpha.sim.player.pos;
    const car = alpha.sim.spawnVehicle('muscle', p.x + 4, p.z, 0, 0x123456);
    const prop = alpha.world.grid.colliders.find((c) => c.breakable && !c.broken && Math.hypot(c.cx - p.x, c.cz - p.z) < 200)!;
    alpha.sim.onPropBroken(prop, car);
    alpha.sim.wanted.setLevel(3);
    b1.peer.clear();
    stepAll(mgr, 30);
    const aSnaps = a1.peer.of('snapshot');
    const bSnaps = b1.peer.of('snapshot');
    expect(aSnaps.some((s) => s.vehicles.some((v) => v.id === car.id && v.rare?.color === 0x123456))).toBe(true);
    expect(aSnaps.some((s) => s.brokenProps.includes(prop.propIndex))).toBe(true);
    expect(a1.peer.last('snapshot')!.hud.wanted).toBe(3);
    // beta: no muscle car of that colour, no broken prop, no stars, no wanted event, no alpha player.
    expect(bSnaps.every((s) => s.vehicles.every((v) => v.rare?.color !== 0x123456))).toBe(true);
    expect(bSnaps.every((s) => s.brokenProps.length === 0)).toBe(true);
    expect(bSnaps.every((s) => s.hud.wanted === 0)).toBe(true);
    expect(b1.peer.of('event').every((e) => e.events.every((x) => x.type !== 'wanted' && x.type !== 'propBroken'))).toBe(true);
    expect(beta.sim.vehicles.includes(car)).toBe(false);
    expect(beta.world.grid.colliders.filter((c) => c.broken).length).toBe(betaBefore.broken);
    expect(beta.sim.wanted.level).toBe(0);
    const roster = b1.peer.of('snapshot').map((s) => s.roster).filter((r) => r !== null).pop() ?? beta.roster();
    expect(roster.map((r) => r.name)).toEqual(['B1']);
    console.log(`[rooms] counts ${JSON.stringify(counts)}; alpha car ${car.id} + prop ${prop.propIndex} + 3 stars; beta ids before ${betaBefore.ids.length} (${betaBefore.ids.slice(0, 8).join(',')}...), after ${entityIds(b1).size}; beta wanted ${beta.sim.wanted.level}, broken ${beta.world.grid.colliders.filter((c) => c.broken).length}`);
    mgr.closeAll();
  });
});

describe('join and leave', () => {
  it('welcome carries a unique player id, the seed, the tick and the static state; the joiner shows up in the others\' snapshots', () => {
    const mgr = manager();
    const a = connect(mgr, 'Ann', 'r');
    stepAll(mgr, 20);
    const b = connect(mgr, 'Bea', 'r');
    const wa = a.peer.last('welcome')!;
    const wb = b.peer.last('welcome')!;
    expect(wa.playerId).not.toBe(wb.playerId);
    expect(wb.roomSeed).toBe(mgr.room('r')!.seed);
    expect(wb.tick).toBe(20);
    expect(wa.slot).toBe(0);
    expect(wb.slot).toBe(-1); // one-slot Sim: watches until mp-core
    expect(Array.isArray(wb.brokenProps) && Array.isArray(wb.signalHolds) && Array.isArray(wb.pickups)).toBe(true);
    stepAll(mgr, 2);
    expect(a.peer.last('snapshot')!.roster!.map((r) => r.name)).toEqual(['Ann', 'Bea']);
    mgr.closeAll();
  });

  it('bye and a closed socket remove the player at once; the others stop seeing it; a watcher takes the freed slot', () => {
    const mgr = manager();
    const a = connect(mgr, 'Ann', 'r');
    const b = connect(mgr, 'Bea', 'r');
    const c = connect(mgr, 'Cy', 'r');
    stepAll(mgr, 2);
    const room = mgr.room('r')!;
    expect(room.members.size).toBe(3);
    const t0 = performance.now();
    a.send({ type: 'bye', reason: 'quit' });
    expect(room.members.size).toBe(2);
    expect(a.peer.closed?.code).toBe(1000);
    // Bea was watching and now drives slot 0.
    expect([...room.members.values()].find((m) => m.name === 'Bea')!.slot).toBe(0);
    c.conn.onClose();
    const ms = performance.now() - t0;
    expect(room.members.size).toBe(1);
    stepAll(mgr, 2);
    const roster = b.peer.last('snapshot')!.roster!;
    expect(roster.map((r) => [r.name, r.slot])).toEqual([['Bea', 0]]);
    console.log(`[join] bye and close removed both players within ${ms.toFixed(2)} ms`);
    mgr.closeAll();
  });

  it('with a slot per player: leaving takes the character out of its car, which stays behind empty', () => {
    const mgr = manager({ room: { slotProvider: (sim) => new PuppetSlotProvider(sim, 8), sim: { ambient: false } } });
    const a = connect(mgr, 'Ann', 'r');
    const b = connect(mgr, 'Bea', 'r');
    stepAll(mgr, 2);
    const room = mgr.room('r')!;
    const bm = [...room.members.values()].find((m) => m.name === 'Bea')!;
    expect(bm.slot).toBe(1);
    const bc = room.slots.character(1);
    const car = room.sim.spawnVehicle('sedan', bc.pos.x + 3, bc.pos.z, 0);
    room.sim.seat(bc, car, 0);
    stepAll(mgr, 2);
    expect(a.peer.last('snapshot')!.vehicles.find((v) => v.id === car.id)?.status?.driver).toBe(bc.id);
    b.conn.onClose();
    stepAll(mgr, 2);
    expect(bc.removed).toBe(true);
    expect(car.removed).toBe(false);
    expect(car.driver).toBeNull();
    const last = a.peer.last('snapshot')!;
    expect(last.removed).toContain(bc.id);
    expect(last.vehicles.find((v) => v.id === car.id)?.status?.driver).toBe(0);
    expect(last.roster!.map((r) => r.name)).toEqual(['Ann']);
    mgr.closeAll();
  });

  it('rooms take 8 players; the 9th gets "room full"; a version mismatch gets a version error', () => {
    const mgr = manager({ room: { slotProvider: (sim) => new PuppetSlotProvider(sim, 8), sim: { ambient: false } } });
    const clients = Array.from({ length: 8 }, (_, i) => connect(mgr, `P${i + 1}`, 'full'));
    const ids = clients.map((c) => c.peer.last('welcome')!.playerId);
    expect(new Set(ids).size).toBe(8);
    expect(clients.map((c) => c.peer.last('welcome')!.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const ninth = connect(mgr, 'P9', 'full');
    expect(ninth.peer.last('reject')).toMatchObject({ code: 'full' });
    expect(ninth.peer.last('reject')!.text).toMatch(/full/);
    expect(ninth.peer.closed).not.toBeNull();
    expect(mgr.room('full')!.members.size).toBe(8);
    // A hello whose body says another version, and one whose header does.
    const old = connect(mgr, 'Old', 'other', 'lobby', PROTOCOL_VERSION + 1);
    expect(old.peer.last('reject')).toMatchObject({ code: 'version' });
    const peer = new FakePeer();
    const conn = new Connection(peer, mgr, connOpts);
    const raw = new Uint8Array(encodeMessage({ type: 'hello', version: PROTOCOL_VERSION, name: 'x', room: 'other' }));
    raw[1] = PROTOCOL_VERSION + 1;
    conn.onMessage(raw, true);
    expect(peer.last('reject')).toMatchObject({ code: 'version' });
    expect(mgr.room('other')?.members.size ?? 0).toBe(0);
    console.log(`[join] 8 players with slots 0-7 and ids ${ids.join(',')}; 9th: ${ninth.peer.last('reject')!.text}; old client: ${old.peer.last('reject')!.text}`);
    mgr.closeAll();
  });

  it('50 join/leave cycles grow neither slots, listeners nor memory', () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const mgr = manager({ room: { slotProvider: (sim) => new PuppetSlotProvider(sim, 8) } });
    const stay = connect(mgr, 'Stay', 'cyc');
    const room: Room = mgr.room('cyc')!;
    const handlers = () => [...((room.sim.events as unknown as { handlers: Map<string, unknown[]> }).handlers.values())].reduce((n, l) => n + l.length, 0);
    // Some systems (the garage runtime in properties.ts) subscribe once per Sim on their first update; count from after it.
    room.step();
    const baseHandlers = handlers();
    let heap5 = 0;
    const charsAt: number[] = [];
    for (let i = 0; i < 50; i++) {
      const cs = [connect(mgr, `J${i}a`, 'cyc'), connect(mgr, `J${i}b`, 'cyc')];
      for (let k = 0; k < 6; k++) {
        room.step();
        for (const c of cs) c.send({ type: 'input', seq: k + 1, tick: room.tick, input: { ...neutralInput(), moveZ: 1 } });
      }
      cs[0]!.send({ type: 'bye', reason: '' });
      cs[1]!.conn.onClose();
      room.step();
      charsAt.push(room.sim.characters.filter((c) => c.isPlayer).length);
      if (i === 4) {
        gc();
        heap5 = process.memoryUsage().heapUsed;
      }
    }
    gc();
    const heap50 = process.memoryUsage().heapUsed;
    expect(room.members.size).toBe(1);
    expect(handlers()).toBe(baseHandlers);
    expect(new Set(charsAt)).toEqual(new Set([1]));
    expect(room.slots.characters()).toHaveLength(1);
    console.log(`[join] 50 cycles: members ${room.members.size}, sim listeners ${handlers()} (start ${baseHandlers}), player characters ${charsAt[49]}, heap after 5 cycles ${(heap5 / 1048576).toFixed(1)} MB, after 50 ${(heap50 / 1048576).toFixed(1)} MB (${((heap50 / heap5 - 1) * 100).toFixed(1)}%)`);
    expect(heap50).toBeLessThan(heap5 * 1.2);
    void stay;
    mgr.closeAll();
  });

  it('an empty room closes after its grace period', async () => {
    const mgr = manager({ emptyRoomTtlMs: 30 });
    const a = connect(mgr, 'Ann', 'brief');
    a.conn.onClose();
    expect(mgr.room('brief')).toBeDefined();
    await new Promise((r) => setTimeout(r, 80));
    expect(mgr.room('brief')).toBeUndefined();
    mgr.closeAll();
  });

  it('bad room names and garbage before hello are refused without joining', () => {
    const mgr = manager();
    const bad = connect(mgr, 'X', '../etc');
    expect(bad.peer.last('reject')).toMatchObject({ code: 'badHello' });
    const peer = new FakePeer();
    const conn = new Connection(peer, mgr, { ...connOpts, maxErrors: 3 });
    conn.onMessage(new Uint8Array(encodeMessage({ type: 'input', seq: 1, tick: 0, input: neutralInput() })), true);
    conn.onMessage(new Uint8Array([1, 2, 3]), true);
    expect(peer.closed).toBeNull();
    conn.onMessage(new Uint8Array([0x47]), true);
    expect(peer.closed?.code).toBe(1002);
    const text = new FakePeer();
    new Connection(text, mgr, connOpts).onMessage(new Uint8Array([104, 105]), false);
    expect(text.closed?.code).toBe(1003);
    expect(mgr.rooms.size).toBe(0);
    mgr.closeAll();
  });
});
