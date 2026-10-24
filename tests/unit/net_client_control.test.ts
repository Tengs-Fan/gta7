// The multiplayer client against the server's authority over the local player's control and the world's props:
// - a prop broken live reaches the mirror's listeners exactly once (snapshot and event both report it), separately from
//   the startup replay of a late joiner (VAL-MPCL-002);
// - while the server holds the local player down (BUSTED, WASTED) or locks his controls, the prediction is suspended, so
//   the client shows no movement or shots the server does not have, and it starts again from the server's state once
//   he is up (architecture §4.4, VAL-MPCL-004/005, VAL-MPPLAY-006).
// Real Room, Connection, binary codec and NetClient on virtual time, over a simulated lossy link.

import { describe, expect, it } from 'vitest';
import type { NetClient } from '../../src/net/client';
import { decodeMessage, type Message } from '../../src/net/protocol';
import type { Transport, TransportFactory } from '../../src/net/transport';
import { neutralInput, type PlayerInput } from '../../src/sim/input';
import type { PlayerSlot } from '../../src/sim/playerSlot';
import { makeClient, pipeFactory, run, testManager, VirtualClock } from './net_client_helpers';

const LINK = { latencyMs: 100, jitterMs: 15, loss: 0.02 };
const QUIET = { ambient: false, police: false, streetCrime: false, weather: 'clear' as const };

type V3 = { x: number; y: number; z: number };
const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** A transport factory that throws away the server's messages `drop` picks (a lost message the test chooses). */
function dropping(inner: TransportFactory, drop: (m: Message) => boolean): TransportFactory {
  return (url) => {
    const t = inner(url);
    const out: Transport = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send: (d) => t.send(d),
      close: (c, r) => t.close(c, r),
    };
    t.onopen = () => out.onopen?.();
    t.onmessage = (d) => {
      if (!drop(decodeMessage(d))) out.onmessage?.(d);
    };
    t.onclose = (c, r) => out.onclose?.(c, r);
    return out;
  };
}

/** Game.enterNet's order: the world restored, the presentation's listeners on, then the replay of what is broken. */
function attachLikeGame(c: NetClient, seen: number[], dirs?: number[]): void {
  c.onReady = () => {
    c.mirror.events.on('propBroken', (e) => {
      seen.push(e.index);
      dirs?.push(e.dirX);
    });
    c.mirror.world.resetBroken();
    c.mirror.replayBroken();
  };
}

describe('a prop broken live is shown exactly once (MP-SCR-CLIENT-001, VAL-MPCL-002)', () => {
  for (const link of [undefined, LINK]) {
    it(`snapshot and event both report it; listeners hear it once${link ? ' (100 ms, ±15 ms, 2% loss)' : ''}`, () => {
      const clock = new VirtualClock();
      const mgr = testManager({ dev: true, sim: QUIET, now: () => clock.now() });
      const c = makeClient(mgr, clock, { predict: false, link, seed: 5 });
      const seen: number[] = [];
      const dirs: number[] = [];
      attachLikeGame(c, seen, dirs);
      run(mgr, clock, [c], 1.5);
      expect(c.ready).toBe(true);
      expect(seen).toEqual([]);
      const room = mgr.room('r')!;
      const props = room.world.grid.colliders.filter((k) => k.breakable && !k.broken && k.propIndex >= 0).slice(0, 6);
      const indices: number[] = [];
      for (const col of props) {
        const index = room.world.breakCollider(col);
        indices.push(index);
        room.sim.events.emit('propBroken', { index, dirX: 1, dirZ: 0 });
        run(mgr, clock, [c], 0.4);
      }
      run(mgr, clock, [c], 1);
      expect(seen.sort((a, b) => a - b)).toEqual([...indices].sort((a, b) => a - b));
      for (const i of indices) expect(c.mirror.world.grid.colliders.find((k) => k.propIndex === i && k.breakable)!.broken).toBe(true);
      // With no loss the server's own event (which knows the direction) is the one shown.
      if (!link) expect(dirs.every((d) => d === 1)).toBe(true);

      // A late joiner hears the same props once, from its startup replay.
      const late = makeClient(mgr, clock, { predict: false, name: 'Late', link, seed: 6 });
      const lateSeen: number[] = [];
      attachLikeGame(late, lateSeen);
      run(mgr, clock, [c, late], 1.5);
      expect(late.ready).toBe(true);
      expect(lateSeen.sort((a, b) => a - b)).toEqual([...indices].sort((a, b) => a - b));
      expect(seen.length).toBe(indices.length);
      c.close();
      late.close();
      room.close();
    });
  }

  it('once also when the event message is lost (the snapshot alone) or the snapshot is (the event alone)', () => {
    for (const lose of ['event', 'snapshot'] as const) {
      const clock = new VirtualClock();
      const mgr = testManager({ dev: true, sim: QUIET, now: () => clock.now() });
      let armed = false;
      let dropped = 0;
      const transport = dropping(pipeFactory(mgr, clock), (m) => {
        if (!armed || dropped > 0) return false;
        const hit = lose === 'event' ? m.type === 'event' && m.events.some((e) => e.type === 'propBroken') : m.type === 'snapshot' && m.brokenProps.length > 0;
        if (hit) dropped++;
        return hit;
      });
      const c = makeClient(mgr, clock, { predict: false, transport });
      const seen: number[] = [];
      attachLikeGame(c, seen);
      run(mgr, clock, [c], 1.5);
      const room = mgr.room('r')!;
      const col = room.world.grid.colliders.find((k) => k.breakable && !k.broken && k.propIndex >= 0)!;
      armed = true;
      const index = room.world.breakCollider(col);
      room.sim.events.emit('propBroken', { index, dirX: 0, dirZ: 1 });
      run(mgr, clock, [c], 2);
      expect(dropped, lose).toBe(1);
      expect(seen, lose).toEqual([index]);
      c.close();
      room.close();
    }
  });
});

interface BustRun {
  shownWhileDown: number;
  serverShotsWhileDown: number;
  maxDrawnMove: number;
  maxServerMove: number;
  framesPredictingWhileDown: number;
  framesDown: number;
}

/** Holds W and pulls the trigger every 450 ms for `seconds` while the server keeps `slot` down or locked. */
function holdWalkAndFire(mgr: ReturnType<typeof testManager>, clock: VirtualClock, clients: NetClient[], c: NetClient, slot: PlayerSlot, seconds: number, held: () => boolean): BustRun {
  const room = mgr.room('r')!;
  const start = { ...slot.character.pos };
  const drawnStart = { ...c.mirror.localCharacter!.pos };
  const out: BustRun = { shownWhileDown: 0, serverShotsWhileDown: 0, maxDrawnMove: 0, maxServerMove: 0, framesPredictingWhileDown: 0, framesDown: 0 };
  const offClient = c.mirror.events.on('weaponFired', (e) => {
    if (e.shooter === c.mirror.localCharacter && held()) out.shownWhileDown++;
  });
  const offServer = room.sim.events.on('weaponFired', (e) => {
    if (e.shooter === slot.character && held()) out.serverShotsWhileDown++;
  });
  const t0 = clock.t;
  run(mgr, clock, clients, seconds, {
    input: (k) => {
      if (k !== c) return neutralInput();
      const inp: PlayerInput = neutralInput();
      inp.moveZ = 1;
      inp.aimOrigin = { x: start.x, y: start.y + 1.4, z: start.z };
      inp.aimDir = { x: 0, y: 0.8, z: 0.6 };
      inp.firePressed = (clock.t - t0) % 450 < 17;
      inp.fire = inp.firePressed;
      return inp;
    },
    afterTick: () => {
      out.maxServerMove = Math.max(out.maxServerMove, dist(slot.character.pos, start));
    },
    afterFrame: (k) => {
      if (k !== c || !held()) return;
      out.framesDown++;
      if (c.predictor.active) out.framesPredictingWhileDown++;
      out.maxDrawnMove = Math.max(out.maxDrawnMove, dist(c.mirror.localCharacter!.pos, drawnStart));
    },
  });
  offClient();
  offServer();
  return out;
}

/** Walks forward for `seconds`, recording each tick's first prediction and the server's position at that tick. */
function walkErrors(mgr: ReturnType<typeof testManager>, clock: VirtualClock, clients: NetClient[], c: NetClient, slot: PlayerSlot, seconds: number): number[] {
  const room = mgr.room('r')!;
  const server = new Map<number, V3>();
  const first = new Map<number, V3>();
  let rec = c.predictor.tick;
  run(mgr, clock, clients, seconds, {
    input: (k) => {
      const inp = neutralInput();
      if (k === c) inp.moveZ = 1;
      return inp;
    },
    afterTick: () => server.set(room.tick, { ...slot.character.pos }),
    afterFrame: (k) => {
      if (k !== c || !c.predictor.active) return;
      for (let t = Math.max(rec, c.predictor.tick - 30); t < c.predictor.tick; t++) {
        const q = c.predictor.positionAt(t);
        if (q && !first.has(t)) first.set(t, q);
      }
      rec = c.predictor.tick;
    },
  });
  const errs: number[] = [];
  for (const [t, q] of first) {
    const s = server.get(t);
    if (s) errs.push(dist(s, q));
  }
  return errs.sort((a, b) => a - b);
}

const p95 = (sorted: number[]) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;

describe('no local control while the server holds the player (MP-SCR-CLIENT-002)', () => {
  for (const link of [undefined, LINK]) {
    it(`BUSTED: no predicted movement or shots; the other player sees him stand; prediction resumes from the respawn${link ? ' (100 ms, ±15 ms, 2% loss)' : ''}`, () => {
      const clock = new VirtualClock();
      const mgr = testManager({ dev: true, sim: QUIET, now: () => clock.now() });
      const c = makeClient(mgr, clock, { link, seed: 7 });
      const other = makeClient(mgr, clock, { link, seed: 8, name: 'Other' });
      const clients = [c, other];
      run(mgr, clock, clients, 1.5);
      expect(c.state).toBe('connected');
      const room = mgr.room('r')!;
      const slot = room.sim.players[c.mirror.slot]!;
      slot.character.inventory.give('pistol', 60);
      slot.character.inventory.current = 'pistol';
      run(mgr, clock, clients, 1);
      expect(c.predictor.active).toBe(true);

      room.sim.bustPlayer(slot);
      // The client learns of it one way later; from then on nothing of his own may move or fire.
      run(mgr, clock, clients, 0.5);
      expect(slot.down).toBe(true);
      expect(c.mirror.me.down).toBe(true);
      expect(c.mirror.me.deathKind).toBe('busted');
      expect(c.predictor.active).toBe(false);
      const r = holdWalkAndFire(mgr, clock, clients, c, slot, 2, () => slot.down && c.mirror.me.down);
      console.log(`[busted${link ? ' lossy' : ''}] ${r.framesDown} frames down: predicting ${r.framesPredictingWhileDown}, drawn moved ${r.maxDrawnMove.toFixed(3)} m (server ${r.maxServerMove.toFixed(3)} m), shots shown ${r.shownWhileDown} (server ${r.serverShotsWhileDown})`);
      expect(r.framesDown).toBeGreaterThan(100);
      expect(r.maxServerMove).toBe(0);
      expect(r.framesPredictingWhileDown).toBe(0);
      expect(r.maxDrawnMove).toBeLessThan(0.02);
      expect(r.serverShotsWhileDown).toBe(0);
      expect(r.shownWhileDown).toBe(0);
      expect(c.mirror.locallyDriven.size).toBe(0);
      // The other player's mirror shows him where the server has him.
      const seenByOther = other.mirror.character(c.mirror.ownCharacterId)!;
      expect(seenByOther).toBeTruthy();
      expect(dist(seenByOther.pos, slot.character.pos)).toBeLessThan(0.05);

      // Respawned at the police station: the prediction starts again there and follows the server closely.
      run(mgr, clock, clients, 4, { input: () => neutralInput() });
      expect(slot.down).toBe(false);
      expect(c.mirror.me.down).toBe(false);
      expect(c.predictor.active).toBe(true);
      expect(dist(c.predictor.char.pos, slot.character.pos)).toBeLessThan(0.05);
      const errs = walkErrors(mgr, clock, clients, c, slot, 3);
      console.log(`[busted${link ? ' lossy' : ''}] after respawn: ${errs.length} ticks compared, p95 ${p95(errs).toFixed(3)} m, max ${(errs[errs.length - 1] ?? 0).toFixed(3)} m`);
      expect(errs.length).toBeGreaterThan(120);
      expect(p95(errs)).toBeLessThanOrEqual(0.5);
      c.close();
      other.close();
      room.close();
    });
  }

  it('BUSTED with its event lost: the snapshot alone suspends the prediction and shows the arrest', () => {
    const clock = new VirtualClock();
    const mgr = testManager({ dev: true, sim: QUIET, now: () => clock.now() });
    let dropped = 0;
    const transport = dropping(pipeFactory(mgr, clock, { link: LINK, seed: 9 }), (m) => {
      const hit = m.type === 'event' && m.events.some((e) => e.type === 'busted' || e.type === 'respawn');
      if (hit) dropped++;
      return hit;
    });
    const c = makeClient(mgr, clock, { transport });
    run(mgr, clock, [c], 2.5);
    const room = mgr.room('r')!;
    const slot = room.sim.players[c.mirror.slot]!;
    expect(c.predictor.active).toBe(true);
    room.sim.bustPlayer(slot);
    run(mgr, clock, [c], 0.5);
    expect(c.mirror.me.deathKind).toBe('busted');
    const r = holdWalkAndFire(mgr, clock, [c], c, slot, 2, () => slot.down);
    expect(r.framesPredictingWhileDown).toBe(0);
    expect(r.maxDrawnMove).toBeLessThan(0.02);
    expect(r.shownWhileDown).toBe(0);
    run(mgr, clock, [c], 3.5, { input: () => neutralInput() });
    expect(dropped).toBe(2);
    expect(slot.down).toBe(false);
    expect(c.mirror.me.down).toBe(false);
    expect(c.predictor.active).toBe(true);
    c.close();
    room.close();
  });

  it('WASTED: suspended while dead, predicted again after the hospital respawn', () => {
    const clock = new VirtualClock();
    const mgr = testManager({ dev: true, sim: QUIET, now: () => clock.now() });
    const c = makeClient(mgr, clock, { link: LINK, seed: 10 });
    run(mgr, clock, [c], 2.5);
    const room = mgr.room('r')!;
    const slot = room.sim.players[c.mirror.slot]!;
    slot.character.health = 0;
    slot.character.state = 'dead';
    room.sim.playerDied(slot);
    run(mgr, clock, [c], 0.5);
    expect(c.mirror.me.deathKind).toBe('wasted');
    const r = holdWalkAndFire(mgr, clock, [c], c, slot, 2, () => slot.down);
    expect(r.framesPredictingWhileDown).toBe(0);
    expect(r.shownWhileDown).toBe(0);
    run(mgr, clock, [c], 4, { input: () => neutralInput() });
    expect(slot.down).toBe(false);
    expect(c.predictor.active).toBe(true);
    expect(dist(c.predictor.char.pos, slot.character.pos)).toBeLessThan(0.05);
    c.close();
    room.close();
  });

  it('a control lock (a respray, a race countdown) suspends the prediction until the server lets go', () => {
    const clock = new VirtualClock();
    const mgr = testManager({ dev: true, sim: QUIET, now: () => clock.now() });
    const c = makeClient(mgr, clock, { link: LINK, seed: 12 });
    run(mgr, clock, [c], 2.5);
    const room = mgr.room('r')!;
    const slot = room.sim.players[c.mirror.slot]!;
    slot.character.inventory.give('pistol', 60);
    slot.character.inventory.current = 'pistol';
    run(mgr, clock, [c], 0.5);
    expect(c.predictor.active).toBe(true);
    slot.controlLock = 2.5;
    run(mgr, clock, [c], 0.4);
    const r = holdWalkAndFire(mgr, clock, [c], c, slot, 1.8, () => slot.controlLock > 0);
    console.log(`[locked] ${r.framesDown} frames locked: predicting ${r.framesPredictingWhileDown}, drawn moved ${r.maxDrawnMove.toFixed(3)} m (server ${r.maxServerMove.toFixed(3)} m), shots shown ${r.shownWhileDown}`);
    expect(r.framesDown).toBeGreaterThan(80);
    expect(r.maxServerMove).toBeLessThan(0.01);
    expect(r.framesPredictingWhileDown).toBe(0);
    expect(r.maxDrawnMove).toBeLessThan(0.02);
    expect(r.shownWhileDown).toBe(0);
    run(mgr, clock, [c], 0.6, { input: () => neutralInput() });
    expect(slot.controlLock).toBe(0);
    expect(c.predictor.active).toBe(true);
    const errs = walkErrors(mgr, clock, [c], c, slot, 2);
    expect(errs.length).toBeGreaterThan(80);
    expect(p95(errs)).toBeLessThanOrEqual(0.5);
    c.close();
    room.close();
  });
});
