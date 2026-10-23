// How the multiplayer client talks to a server: a message pipe (binary frames, in order) with open/close callbacks.
// The browser uses a WebSocket; tests use an in-process pipe; LinkSim wraps either with latency, jitter and loss.
// No DOM: WebSocket is a global in browsers and in Node.

import { BadAddressError } from './url';

export interface Transport {
  send(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: ArrayBuffer) => void) | null;
  /** Fires once, whether the server closed the connection, it failed to open, or close() was called. */
  onclose: ((code: number, reason: string) => void) | null;
}

export type TransportFactory = (url: string) => Transport;

export { BadAddressError };

/** A browser WebSocket as a Transport. Throws BadAddressError for a malformed URL. */
export function webSocketTransport(url: string): Transport {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new BadAddressError('WebSocket is not available here');
  let ws: WebSocket;
  try {
    ws = new WS(url);
  } catch (err) {
    throw new BadAddressError(err instanceof Error ? err.message : String(err));
  }
  ws.binaryType = 'arraybuffer';
  let closed = false;
  const t: Transport = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send(data) {
      if (ws.readyState === 1) ws.send(data);
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      try {
        ws.close(code, reason);
      } catch {
        ws.close();
      }
      fire(code, reason);
    },
  };
  const fire = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    t.onclose?.(code, reason);
  };
  ws.onopen = () => t.onopen?.();
  ws.onmessage = (e: MessageEvent) => {
    if (e.data instanceof ArrayBuffer) t.onmessage?.(e.data);
  };
  // A failed connection reports onerror, then onclose (1006): the close carries everything the client needs.
  ws.onerror = () => {};
  ws.onclose = (e: CloseEvent) => fire(e.code, e.reason);
  return t;
}

export interface LinkConditions {
  /** One-way delay (ms) in each direction. */
  latencyMs: number;
  /** Each message's delay varies by up to ± this much (ms); order is kept, as on a TCP stream. */
  jitterMs: number;
  /** Fraction of messages lost in each direction (0..1). */
  loss: number;
}

export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
}

const realScheduler: Scheduler = { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms) };

/** A small seeded generator, so a simulated link behaves the same on every run. */
export function linkRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/**
 * Wraps a transport with a simulated network: every message in either direction arrives `latencyMs` ± `jitterMs` later,
 * never before the one sent before it, and `loss` of them never arrive. Used by tests and by the `?lag=` URL option.
 */
export function simulatedLink(inner: Transport, cond: LinkConditions, sched: Scheduler = realScheduler, random = linkRandom(0x9e3779b9)): Transport {
  let upAt = 0;
  let downAt = 0;
  let closed = false;
  const delay = () => cond.latencyMs + (random() * 2 - 1) * cond.jitterMs;
  const t: Transport = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send(data) {
      if (closed || random() < cond.loss) return;
      upAt = Math.max(upAt, sched.now() + delay());
      sched.setTimeout(() => inner.send(data), Math.max(0, upAt - sched.now()));
    },
    close(code, reason) {
      closed = true;
      inner.close(code, reason);
    },
  };
  inner.onopen = () => {
    sched.setTimeout(() => t.onopen?.(), Math.max(0, cond.latencyMs * 2));
  };
  inner.onmessage = (data) => {
    if (random() < cond.loss) return;
    downAt = Math.max(downAt, sched.now() + delay());
    sched.setTimeout(() => {
      if (!closed) t.onmessage?.(data);
    }, Math.max(0, downAt - sched.now()));
  };
  inner.onclose = (code, reason) => {
    closed = true;
    t.onclose?.(code, reason);
  };
  return t;
}
