// The multiplayer client end to end against the real server room and connection handler, on virtual time: connecting,
// prediction and reconciliation over a link with 100 ms latency, jitter and loss (VAL-MPCL-005), the local player's
// immediate response to input (VAL-MPCL-004, unit part), watching while the room's slot is taken, losing the server
// and reconnecting (VAL-MPCL-006), and the clean failures of a bad, unreachable or wrong-version server (VAL-MPCL-007).

import { describe, expect, it } from 'vitest';
import { SingleSlotProvider } from '../../server/slots';
import { NetClient } from '../../src/net/client';
import { MAX_CORRECTION_STEP, SNAP_DIST } from '../../src/net/predictor';
import { PROTOCOL_VERSION } from '../../src/net/protocol';
import { BadAddressError } from '../../src/net/transport';
import { neutralInput, type PlayerInput } from '../../src/sim/input';
import type { Vehicle } from '../../src/sim/entities';
import type { RoadNetwork } from '../../src/world/roads';
import { StaticWorld } from '../../src/world/staticWorld';
import { makeClient, pipeFactory, run, testManager, VirtualClock, type PipeEnd } from './net_client_helpers';

const LINK = { latencyMs: 100, jitterMs: 15, loss: 0.02 };

function pct(a: readonly number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] ?? 0;
}

/** A loop of lane points round a few blocks, driving on the right. */
function loopRoute(roads: RoadNetwork): Array<{ x: number; z: number }> {
  // One column east of where it ran before Cortez Canal took line 3.
  const cells: Array<[number, number]> = [[4, 3], [5, 3], [6, 3], [6, 4], [6, 5], [5, 5], [4, 5], [4, 4], [4, 3]];
  const pts: Array<{ x: number; z: number }> = [];
  for (let k = 0; k + 1 < cells.length; k++) {
    const a = roads.node(...cells[k]!).id;
    const b = roads.node(...cells[k + 1]!).id;
    const lanes = roads.lanesBetween(a, b);
    const lane = lanes[lanes.length - 1]!;
    pts.push({ x: lane.sx, z: lane.sz }, { x: lane.ex, z: lane.ez });
  }
  return pts;
}

/** Steers a car round `route` by pure pursuit, slowing for the corners and pulling the handbrake now and then. */
function autopilot(route: Array<{ x: number; z: number }>) {
  let wp = 0;
  let corner = 0;
  const stats = { corners: 0, brakeFrames: 0, handbrakeFrames: 0, steerFrames: 0 };
  const fn = (v: Vehicle): PlayerInput => {
    const inp = neutralInput();
    let target = route[wp]!;
    while (Math.hypot(target.x - v.pos.x, target.z - v.pos.z) < 9) {
      wp = (wp + 1) % route.length;
      if (wp % 2 === 0) corner++;
      target = route[wp]!;
    }
    const want = Math.atan2(target.x - v.pos.x, target.z - v.pos.z);
    let err = want - v.heading;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    // The wheel turns the car towards -steer (see vehiclePhysics): steer right (+) for a target on the right.
    inp.steer = Math.max(-1, Math.min(1, -err * 2.2));
    const toEnd = Math.hypot(route[wp | 1]!.x - v.pos.x, route[wp | 1]!.z - v.pos.z);
    const speed = toEnd < 22 || Math.abs(err) > 0.35 ? 7 : 15;
    if (v.forwardSpeed < speed - 1) inp.throttle = 1;
    else if (v.forwardSpeed > speed + 1.5) inp.brake = 1;
    inp.handbrake = corner % 3 === 2 && Math.abs(err) > 0.5 && v.speed > 5;
    stats.corners = corner;
    if (inp.brake > 0) stats.brakeFrames++;
    if (inp.handbrake) stats.handbrakeFrames++;
    if (Math.abs(inp.steer) > 0.3) stats.steerFrames++;
    return inp;
  };
  return Object.assign(fn, { stats });
}

describe('prediction and reconciliation under 100 ms latency, ±15 ms jitter and 2% loss (VAL-MPCL-005)', () => {
  it('drives 60 s round blocks in traffic, then walks and jumps for 20 s', () => {
    const clock = new VirtualClock();
    const mgr = testManager({ dev: true });
    const c = makeClient(mgr, clock, { link: LINK, seed: 5 });
    run(mgr, clock, [c], 1);
    expect(c.state).toBe('connected');
    const room = mgr.room('r')!;
    const sim = room.sim;
    const route = loopRoute(sim.roads);
    // Rooms run the street systems: a witness phoning in a pedestrian the autopilot clips would end the drive in a bust.
    c.command('debug', JSON.stringify({ teleport: [route[0]!.x, route[0]!.z], godMode: true, neverWanted: true }));
    run(mgr, clock, [c], 0.5);
    c.command('debug', JSON.stringify({ drive: 'sedan' }));
    run(mgr, clock, [c], 1.5);
    expect(sim.player.vehicle).not.toBeNull();
    expect(c.predictor.vehicle?.id).toBe(sim.player.vehicle!.id);

    // Ground truth by tick on the server, the first prediction for each tick on the client.
    const server = new Map<number, { x: number; y: number; z: number }>();
    const predicted = new Map<number, { x: number; y: number; z: number }>();
    const impacts: number[] = [];
    sim.events.on('impact', (e) => {
      if (e.vehicle && e.vehicle === sim.player.vehicle) impacts.push(room.tick);
    });
    sim.events.on('damage', (e) => {
      if (e.victim === sim.player) impacts.push(room.tick);
    });
    // A punch that lands on him is contact too (in god mode it knocks him down without a damage event): an angry
    // driver the autopilot rammed gets out to fight (sim.streetCrime.angryDrivers, on in rooms).
    sim.events.on('melee', (e) => {
      const p = sim.player.pos;
      if (e.hit && Math.hypot(e.x - p.x, e.z - p.z) < 2.5) impacts.push(room.tick);
    });
    let rec = c.predictor.tick;
    const snapsBefore = c.predictor.stats.hardSnaps;
    c.predictor.stats.maxCorrectionStep = 0;
    const record = {
      afterTick: () => {
        const p = sim.player;
        server.set(room.tick, { ...(p.vehicle ? p.vehicle.pos : p.pos) });
      },
      afterFrame: () => {
        const p = c.predictor;
        for (let t = Math.max(rec, p.tick - 30); t < p.tick; t++) {
          const q = p.positionAt(t);
          if (q && !predicted.has(t)) predicted.set(t, q);
        }
        rec = p.tick;
      },
    };
    const snapTicks: number[] = [];
    let snaps = c.predictor.stats.hardSnaps;
    const watchSnaps = () => {
      if (c.predictor.stats.hardSnaps > snaps) snapTicks.push(c.mirror.tick);
      snaps = c.predictor.stats.hardSnaps;
    };
    const drive = autopilot(route);
    let distance = 0;
    let last = { ...sim.player.vehicle!.pos };
    run(mgr, clock, [c], 60, {
      input: () => (c.predictor.vehicle ? drive(c.predictor.vehicle) : neutralInput()),
      afterTick: () => {
        record.afterTick();
        const v = sim.player.vehicle;
        if (v) {
          distance += Math.hypot(v.pos.x - last.x, v.pos.z - last.z);
          last = { ...v.pos };
        }
      },
      afterFrame: () => {
        record.afterFrame();
        watchSnaps();
      },
    });
    const driveErr: number[] = [];
    for (const [t, q] of predicted) {
      const s = server.get(t);
      if (s) driveErr.push(Math.hypot(s.x - q.x, s.y - q.y, s.z - q.z));
    }
    console.log(`[predict drive] ${(distance / 1000).toFixed(2)} km in 60 s, autopilot ${JSON.stringify(drive.stats)}, ${impacts.length} impacts; ${driveErr.length} ticks compared: p50 ${pct(driveErr, 50).toFixed(3)} m, p95 ${pct(driveErr, 95).toFixed(3)} m, p99 ${pct(driveErr, 99).toFixed(3)} m, max ${pct(driveErr, 100).toFixed(3)} m; hard snaps ${c.predictor.stats.hardSnaps - snapsBefore}; ${JSON.stringify(c.debug().prediction)}`);

    // Stop, get out, walk and jump.
    let pressed = false;
    run(mgr, clock, [c], 4, {
      input: () => {
        const inp = neutralInput();
        const v = c.predictor.vehicle;
        if (v && v.forwardSpeed > 0.5) inp.brake = 1;
        else if (v) inp.handbrake = true;
        if (v && !pressed && v.speed < 1) {
          inp.enterExit = true;
          pressed = true;
        }
        return inp;
      },
      ...record,
    });
    expect(sim.player.vehicle).toBeNull();
    const walkFrom = predicted.size;
    const walk0 = clock.t;
    run(mgr, clock, [c], 20, {
      input: (_c, _i, t) => {
        const inp = neutralInput();
        const s = (t - walk0) / 1000;
        inp.moveZ = 1;
        inp.cameraYaw = Math.sin(s * 0.4) * 1.5;
        inp.sprint = Math.floor(s / 4) % 2 === 1;
        inp.jump = Math.floor(s * 60) % 120 === 0;
        return inp;
      },
      afterTick: record.afterTick,
      afterFrame: () => {
        record.afterFrame();
        watchSnaps();
      },
    });
    const walkErr: number[] = [];
    let i = 0;
    for (const [t, q] of predicted) {
      if (i++ < walkFrom) continue;
      const s = server.get(t);
      if (s) walkErr.push(Math.hypot(s.x - q.x, s.y - q.y, s.z - q.z));
    }
    const all = [...driveErr, ...walkErr];
    const st = c.debug().prediction;
    // Hard snaps away from any contact: none of the server's impact or damage ticks within a second of the snap.
    const clean = snapTicks.filter((t) => !impacts.some((x) => Math.abs(x - t) < 60));
    console.log(`[predict walk] ${walkErr.length} ticks compared: p50 ${pct(walkErr, 50).toFixed(3)} m, p95 ${pct(walkErr, 95).toFixed(3)} m, max ${pct(walkErr, 100).toFixed(3)} m`);
    console.log(`[predict all] p95 ${pct(all, 95).toFixed(3)} m over ${all.length} ticks; largest per-frame correction ${st.maxCorrectionStep.toFixed(3)} m; hard snaps ${snapTicks.length} (at ticks ${snapTicks.join(', ') || 'none'}; ${clean.length} with no contact nearby); soft corrections ${st.softCorrections}, replays ${st.replays} (${st.replayedTicks} ticks); resyncs ${c.resyncs}; rtt ${c.debug().rtt} ms; slack ${st.slack} ticks`);
    expect(driveErr.length).toBeGreaterThan(3000);
    expect(walkErr.length).toBeGreaterThan(1000);
    expect(distance).toBeGreaterThan(400);
    expect(pct(all, 95)).toBeLessThanOrEqual(0.5);
    expect(st.maxCorrectionStep).toBeLessThanOrEqual(0.3);
    // At most one hard snap per minute without a contact: 80 s here.
    expect(clean.length).toBeLessThanOrEqual(1);
    expect(SNAP_DIST).toBeGreaterThan(MAX_CORRECTION_STEP);
  });
});

describe('the local player responds at once (VAL-MPCL-004, unit)', () => {
  for (const link of [null, { latencyMs: 100, jitterMs: 0, loss: 0 }]) {
    it(`a move press shows in the same frame${link ? ' with 100 ms latency' : ''}, on foot and in a car`, () => {
      const clock = new VirtualClock();
      const mgr = testManager({ dev: true });
      const c = makeClient(mgr, clock, link ? { link } : {});
      run(mgr, clock, [c], 1.5);
      const press = (car: boolean): number[] => {
        const out: number[] = [];
        for (let k = 0; k < 10; k++) {
          run(mgr, clock, [c], 0.8, { input: () => neutralInput() });
          const me = () => {
            const ch = c.mirror.character(c.predictor.serverCharId)!;
            const p = car && ch.vehicle ? ch.vehicle.pos : ch.pos;
            return { ...p };
          };
          const start = me();
          let frames = -1;
          let n = 0;
          run(mgr, clock, [c], 0.3, {
            input: () => {
              const i = neutralInput();
              if (car) i.throttle = 1;
              else {
                i.moveZ = 1;
                i.cameraYaw = k;
              }
              return i;
            },
            afterFrame: () => {
              const p = me();
              if (frames < 0 && Math.hypot(p.x - start.x, p.z - start.z) > 1e-4) frames = n;
              n++;
            },
          });
          out.push(frames);
          run(mgr, clock, [c], 0.6, { input: () => { const i = neutralInput(); if (car) i.brake = 1; return i; } });
        }
        return out;
      };
      const onFoot = press(false);
      c.command('debug', JSON.stringify({ drive: 'sedan' }));
      run(mgr, clock, [c], 1);
      const inCar = press(true);
      console.log(`[latency ${link ? '100 ms' : '0 ms'}] frames from press to movement: on foot ${onFoot.join(',')}; in car ${inCar.join(',')}`);
      expect(pct(onFoot, 50)).toBeLessThanOrEqual(1);
      expect(pct(inCar, 50)).toBeLessThanOrEqual(1);
    });
  }
});

describe('joining a room whose slot is taken, and taking it over', () => {
  it('the second client watches the first player, then plays when the slot frees', () => {
    const clock = new VirtualClock();
    // Rooms give every player a slot of his own; the one-slot provider still has players watching.
    const mgr = testManager({ dev: true, slotProvider: (sim) => new SingleSlotProvider(sim) });
    const a = makeClient(mgr, clock, { name: 'A' });
    run(mgr, clock, [a], 0.5);
    const b = makeClient(mgr, clock, { name: 'B' });
    run(mgr, clock, [a, b], 1.5);
    expect(b.state).toBe('connected');
    const db = b.debug();
    expect(db.watching).toBe(true);
    expect(db.playerId).toBeGreaterThan(a.debug().playerId);
    expect(b.mirror.localCharacter?.id).toBe(a.predictor.serverCharId);
    expect(b.predictor.active).toBe(false);
    a.close();
    run(mgr, clock, [b], 1);
    expect(b.debug().slot).toBe(0);
    expect(b.predictor.active).toBe(true);
    b.close();
  });
});

describe('losing the server and reconnecting (VAL-MPCL-006, unit)', () => {
  it('a closed connection reports "lost" at once, a silent one within 3 s; a new client joins the room again', () => {
    const clock = new VirtualClock();
    const mgr = testManager({ dev: true });
    const ends: PipeEnd[] = [];
    const a = makeClient(mgr, clock, { name: 'A', ends });
    const b = makeClient(mgr, clock, { name: 'B', ends });
    run(mgr, clock, [a, b], 1.5);
    expect([a.state, b.state]).toEqual(['connected', 'connected']);
    const states: string[] = [];
    a.onState = (s, f) => states.push(`${s}:${f?.kind ?? ''}`);
    // The server goes away under A: the socket closes.
    const t0 = clock.t;
    ends[0]!.drop(1006);
    run(mgr, clock, [a, b], 0.1);
    expect(a.state).toBe('lost');
    expect(a.failure?.text).toMatch(/lost/i);
    expect(clock.t - t0).toBeLessThan(3000);
    // B's server stops answering without closing (a dead link): silence counts as lost within 3 s.
    const t1 = clock.t;
    const room = mgr.room('r')!;
    for (const m of [...room.members.values()]) if (m.name === 'B') (m.peer as { send: (d: unknown) => void }).send = () => {};
    let lostAt = -1;
    run(mgr, clock, [b], 4, { afterFrame: () => { if (lostAt < 0 && b.state === 'lost') lostAt = clock.t; } });
    expect(b.state).toBe('lost');
    expect(lostAt - t1).toBeLessThan(3000);
    // Reconnecting is a new client in the same room: a new player id, the world drawn again.
    const a2 = makeClient(mgr, clock, { name: 'A' });
    run(mgr, clock, [a2], 1.5);
    expect(a2.state).toBe('connected');
    expect(a2.mirror.roomId).toBe('r');
    expect(a2.mirror.playerId).not.toBe(a.mirror.playerId);
    expect(a2.mirror.entityCount).toBeGreaterThan(0);
    expect(states).toEqual(['lost:lost']);
    a2.close();
  });
});

describe('a bad, unreachable or wrong-version server fails cleanly (VAL-MPCL-007, unit)', () => {
  const base = { name: 'A', room: 'r', world: new StaticWorld(), predictionWorld: new StaticWorld() };

  it('an address that is no URL', () => {
    const clock = new VirtualClock();
    const c = new NetClient({ ...base, url: 'not a url', now: () => clock.now(), transport: () => {
      throw new BadAddressError('invalid');
    } });
    expect(c.state).toBe('failed');
    expect(c.failure?.kind).toBe('badAddress');
    expect(c.failure?.text).toContain('not a url');
  });

  it('nothing listening there', () => {
    const clock = new VirtualClock();
    const mgr = testManager();
    const c = new NetClient({ ...base, url: 'ws://127.0.0.1:4299/ws', now: () => clock.now(), transport: pipeFactory(mgr, clock, { refuse: true }) });
    run(mgr, clock, [c], 0.2);
    expect(c.state).toBe('failed');
    expect(c.failure?.kind).toBe('unreachable');
    expect(c.failure?.text).toBe('Could not connect to ws://127.0.0.1:4299/ws.');
  });

  it('a server that never answers', () => {
    const clock = new VirtualClock();
    const mgr = testManager();
    const silent = () => ({ onopen: null, onmessage: null, onclose: null, send() {}, close() {} });
    const c = new NetClient({ ...base, url: 'ws://10.0.0.1:4210/ws', now: () => clock.now(), transport: silent });
    run(mgr, clock, [c], 5.5);
    expect(c.state).toBe('failed');
    expect(c.failure?.text).toMatch(/Could not connect to ws:\/\/10\.0\.0\.1:4210\/ws/);
  });

  it('a server speaking another protocol version', () => {
    const clock = new VirtualClock();
    const mgr = testManager();
    const c = new NetClient({ ...base, url: 'ws://x/ws', version: PROTOCOL_VERSION + 1, now: () => clock.now(), transport: pipeFactory(mgr, clock) });
    run(mgr, clock, [c], 0.5);
    expect(c.state).toBe('failed');
    expect(c.failure?.kind).toBe('version');
    expect(c.failure?.text).toMatch(/protocol/i);
  });
});
