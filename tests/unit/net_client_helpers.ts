// In-process multiplayer client harness: a virtual clock, a pipe between a NetClient and the real server connection
// handler, and an optional simulated link (latency, jitter, loss) on it. Everything runs on virtual time, so a minute of
// play takes as long as its simulation and every run is the same.

import { Connection, type ConnectionOptions } from '../../server/connection';
import type { Peer } from '../../server/room';
import { RoomManager, type ManagerOptions } from '../../server/rooms';
import { NetClient, type NetClientOptions } from '../../src/net/client';
import { linkRandom, simulatedLink, type LinkConditions, type Scheduler, type Transport, type TransportFactory } from '../../src/net/transport';
import { StaticWorld } from '../../src/world/staticWorld';

export class VirtualClock implements Scheduler {
  t = 0;
  private seq = 0;
  private timers: Array<{ at: number; seq: number; fn: () => void }> = [];

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fn });
    return this.seq;
  }

  /** Moves time on to `t + ms`, running every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.timers.length; i++) {
        const x = this.timers[i]!;
        if (x.at > end) continue;
        if (best < 0 || x.at < this.timers[best]!.at || (x.at === this.timers[best]!.at && x.seq < this.timers[best]!.seq)) best = i;
      }
      if (best < 0) break;
      const x = this.timers.splice(best, 1)[0]!;
      this.t = Math.max(this.t, x.at);
      x.fn();
    }
    this.t = end;
  }
}

export interface PipeEnd {
  peer: Peer;
  conn: Connection | null;
  transport: Transport;
  /** Kills the connection from the server side (a server going away). */
  drop(code?: number, reason?: string): void;
}

/** A transport factory whose connections go straight into `mgr` through the real Connection handler. */
export function pipeFactory(mgr: RoomManager, clock: VirtualClock, opts: { link?: LinkConditions; seed?: number; ends?: PipeEnd[]; refuse?: boolean } = {}): TransportFactory {
  const connOpts: ConnectionOptions = { defaultRoom: 'lobby', maxErrors: 32, ratePerSec: 10_000, rateBurst: 10_000, log: () => {}, now: () => clock.now() };
  let n = 0;
  return () => {
    let open = true;
    const client: Transport = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send(data) {
        if (!open || !end.conn) return;
        end.conn.onMessage(new Uint8Array(data), true);
      },
      close() {
        if (!open) return;
        open = false;
        end.conn?.onClose();
      },
    };
    const peer: Peer = {
      bufferedAmount: 0,
      send(data) {
        if (!open) throw new Error('closed');
        const copy = data instanceof ArrayBuffer ? data.slice(0) : data.slice().buffer;
        clock.setTimeout(() => {
          if (open) client.onmessage?.(copy as ArrayBuffer);
        }, 0);
      },
      close(code, reason) {
        if (!open) return;
        open = false;
        clock.setTimeout(() => client.onclose?.(code, reason), 0);
      },
    };
    const end: PipeEnd = {
      peer,
      conn: null,
      transport: client,
      drop(code = 1006, reason = '') {
        if (!open) return;
        open = false;
        end.conn?.onClose();
        clock.setTimeout(() => client.onclose?.(code, reason), 0);
      },
    };
    if (opts.refuse) {
      open = false;
      clock.setTimeout(() => client.onclose?.(1006, ''), 1);
    } else {
      end.conn = new Connection(peer, mgr, connOpts);
      clock.setTimeout(() => client.onopen?.(), 0);
    }
    opts.ends?.push(end);
    return opts.link ? simulatedLink(client, opts.link, clock, linkRandom((opts.seed ?? 1) * 7919 + ++n)) : client;
  };
}

export function testManager(room: ManagerOptions['room'] = {}): RoomManager {
  return new RoomManager({ emptyRoomTtlMs: 60_000, log: () => {}, room: { realtime: false, log: () => {}, ...room } });
}

let sharedWorld: StaticWorld | null = null;
/** One StaticWorld for the clients' mirrors and predictions (building one takes a while). */
export function clientWorld(): StaticWorld {
  sharedWorld ??= new StaticWorld();
  return sharedWorld;
}

export function makeClient(mgr: RoomManager, clock: VirtualClock, over: Partial<NetClientOptions> & { link?: LinkConditions; seed?: number; ends?: PipeEnd[] } = {}): NetClient {
  const { link, seed, ends, ...rest } = over;
  return new NetClient({
    url: 'ws://test/ws',
    name: 'T',
    room: 'r',
    world: new StaticWorld(),
    predictionWorld: new StaticWorld(),
    transport: pipeFactory(mgr, clock, { link, seed, ends }),
    now: () => clock.now(),
    ...rest,
  });
}

/**
 * Runs server and clients together for `seconds` of virtual time: the server ticks at 60 Hz, each client renders at
 * `fps` (frames slightly out of phase with the ticks), `input` gives each client's input for a frame.
 */
export function run(mgr: RoomManager, clock: VirtualClock, clients: NetClient[], seconds: number, opts: { fps?: number; input?: (c: NetClient, i: number, t: number) => import('../../src/sim/input').PlayerInput | null; afterTick?: () => void; afterFrame?: (c: NetClient, i: number) => void } = {}): void {
  const fps = opts.fps ?? 60;
  const tickMs = 1000 / 60;
  const frameMs = 1000 / fps;
  const end = clock.t + seconds * 1000;
  let nextTick = Math.ceil(clock.t / tickMs) * tickMs + 0.37;
  let nextFrame = clock.t + 3.1;
  while (clock.t < end) {
    const at = Math.min(nextTick, nextFrame);
    clock.advance(at - clock.t);
    if (at === nextTick) {
      for (const r of mgr.rooms.values()) r.step();
      opts.afterTick?.();
      nextTick += tickMs;
    } else {
      clients.forEach((c, i) => {
        c.frame(frameMs / 1000, opts.input?.(c, i, clock.t) ?? null);
        opts.afterFrame?.(c, i);
      });
      nextFrame += frameMs;
    }
  }
}
