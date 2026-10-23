// Aborted static downloads must release their file descriptors: a client that drops the connection mid-download,
// or before the handler's asynchronous stat has resolved, must not leave a paused ReadStream holding its fd open.

import type { ReadStream } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { socketPath } from './net_helpers';

const streams: ReadStream[] = [];
let statGate: Promise<void> | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const s = actual.createReadStream(...args);
      streams.push(s);
      return s;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const info = await actual.stat(...args);
      if (statGate) await statGate;
      return info;
    },
  };
});

const { serveStatic } = await import('../../server/static');

const SIZE = 16 * 1024 * 1024;
let root: string;
let sock: string;
let server: Server;
const closedResponses: number[] = [];

/** Streams still holding a descriptor (`fd` is set while the file is open; it is not in @types/node). */
const openStreams = (from = 0) => streams.slice(from).filter((s) => typeof (s as unknown as { fd?: unknown }).fd === 'number' && !s.destroyed);

async function settle(from: number): Promise<void> {
  for (let i = 0; i < 40 && openStreams(from).length > 0; i++) await delay(25);
}

function download(abortAfterFirstChunk: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const req = request({ socketPath: sock, path: '/big.bin', agent: false }, (res) => {
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (abortAfterFirstChunk) {
          res.destroy();
          req.destroy();
          resolve(bytes);
        }
      });
      res.on('end', () => resolve(bytes));
    });
    req.on('error', (err) => {
      if (!abortAfterFirstChunk) reject(err);
    });
    req.end();
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gta7-static-abort-'));
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(SIZE, 0x61));
  sock = socketPath('static-abort');
  server = createServer((req, res) => {
    res.once('close', () => closedResponses.push(1));
    serveStatic(root, req, res).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(sock, r));
});

afterAll(async () => {
  for (const s of streams) s.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  statGate = null;
});

describe('static file serving under aborted downloads', () => {
  it('completed downloads deliver the whole file and close their streams', async () => {
    const before = streams.length;
    for (let i = 0; i < 2; i++) expect(await download(false)).toBe(SIZE);
    await settle(before);
    expect(streams.length - before).toBe(2);
    expect(openStreams(before)).toHaveLength(0);
  });

  it('a client aborting mid-download releases the file stream', async () => {
    const before = streams.length;
    for (let i = 0; i < 5; i++) {
      const got = await download(true);
      expect(got).toBeGreaterThan(0);
      expect(got).toBeLessThan(SIZE);
    }
    await settle(before);
    expect(streams.length - before).toBe(5);
    expect(openStreams(before)).toHaveLength(0);
    expect(streams.slice(before).every((s) => s.destroyed)).toBe(true);
  });

  it('a client gone before the stat resolves never opens (or immediately releases) a stream', async () => {
    let release!: () => void;
    statGate = new Promise<void>((r) => (release = r));
    const before = streams.length;
    const closesBefore = closedResponses.length;
    const req = request({ socketPath: sock, path: '/big.bin', agent: false });
    req.on('error', () => {});
    req.end();
    // Wait until the server has the request (its response closes when the client resets the socket).
    await delay(50);
    req.destroy();
    for (let i = 0; i < 40 && closedResponses.length === closesBefore; i++) await delay(10);
    expect(closedResponses.length).toBeGreaterThan(closesBefore);
    release();
    await delay(100);
    await settle(before);
    expect(openStreams(before)).toHaveLength(0);
    expect(streams.slice(before).every((s) => s.destroyed)).toBe(true);
  });
});
