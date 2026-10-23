// Shared pieces of the multiplayer server tests: in-process fake client sockets.

import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMessage, type Message, type MessageOf } from '../../src/net/protocol';
import type { Peer } from '../../server/room';
import type { ServerStatus } from '../../server/server';

/** A client socket that records what the server sends it. */
export class FakePeer implements Peer {
  readonly sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  bufferedAmount = 0;

  send(data: ArrayBuffer | Uint8Array): void {
    if (this.closed) throw new Error('send on a closed socket');
    this.sent.push(data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : data.slice());
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  messages(): Message[] {
    return this.sent.map((b) => decodeMessage(b));
  }

  of<T extends Message['type']>(type: T): Array<MessageOf<T>> {
    return this.messages().filter((m): m is MessageOf<T> => m.type === type);
  }

  last<T extends Message['type']>(type: T): MessageOf<T> | undefined {
    const all = this.of(type);
    return all[all.length - 1];
  }

  /** Drops what was received so far (keeps memory flat in long runs). */
  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * A real server process (`tsx server/main.ts`, as `npm run server` starts it). It listens on a Unix socket, so tests
 * bind no TCP port (and parallel runs never collide); clients use `ws+unix:` URLs.
 */
export interface ServerProcess {
  socket: string;
  /** ws+unix URL of the game socket. */
  wsUrl: (query?: string) => string;
  proc: ChildProcess;
  output: () => string;
  status: () => Promise<ServerStatus>;
  stop: () => Promise<number | null>;
}

const ROOT = join(__dirname, '../..');
let sockets = 0;

/** A fresh Unix socket path under the temp dir. */
export function socketPath(tag: string): string {
  return join(tmpdir(), `gta7-mp-${tag}-${process.pid}-${++sockets}.sock`);
}

/** GET over a Unix socket (or TCP when `socket` is a host). */
export function httpGet(socket: string, path: string, method = 'GET'): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function spawnServer(extra: string[] = []): Promise<ServerProcess> {
  const socket = socketPath('proc');
  const proc = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['server/main.ts', '--socket', socket, '--status-every', '0', ...extra], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
    const check = () => {
      if (out.includes('listening on unix:')) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout!.on('data', check);
    proc.once('exit', (code) => reject(new Error(`server exited (${code}):\n${out}`)));
  });
  return {
    socket,
    wsUrl: (query = '') => `ws+unix://${socket}:/ws${query}`,
    proc,
    output: () => out,
    status: async () => JSON.parse((await httpGet(socket, '/status')).body) as ServerStatus,
    stop: () => new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve(proc.exitCode);
      proc.once('exit', (code) => resolve(code));
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 4000).unref();
    }),
  };
}

/** Snapshot rates of one client per consecutive window (s), from arrival times in ms. */
export function windowRates(times: readonly number[], windowS: number): number[] {
  if (times.length < 2) return [];
  const t0 = times[0]!;
  const out: number[] = [];
  const n = Math.floor((times[times.length - 1]! - t0) / (windowS * 1000));
  for (let w = 0; w < n; w++) {
    const a = t0 + w * windowS * 1000;
    const b = a + windowS * 1000;
    out.push(times.filter((t) => t >= a && t < b).length / windowS);
  }
  return out;
}

export function maxGap(times: readonly number[]): number {
  let g = 0;
  for (let i = 1; i < times.length; i++) g = Math.max(g, times[i]! - times[i - 1]!);
  return g;
}
