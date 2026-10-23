// The server over real sockets, in process: static files from dist/ (and nothing outside it), /status, and the
// WebSocket upgrade on /ws only. The server listens on a Unix socket (no TCP port); set GTA7_MP_TEST_PORT (a port in
// the mission's range) to also check plain TCP on localhost and on the LAN address.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { lanAddresses, startServer, type GameServer } from '../../server/server';
import { resolveStatic } from '../../server/static';
import { Bot } from '../../server/tools/bot';
import { httpGet, socketPath } from './net_helpers';

let server: GameServer;
let dist: string;
let sock: string;
const TCP_PORT = process.env.GTA7_MP_TEST_PORT ? Number(process.env.GTA7_MP_TEST_PORT) : 0;

const get = (path: string, method = 'GET') => httpGet(sock, path, method);
const wsUrl = (path: string) => `ws+unix://${sock}:${path}`;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'gta7-mpserver-'));
  dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script type="module" src="./assets/index-AbCdEf12.js"></script><link rel="stylesheet" href="./assets/index-XyZ98765.css">');
  writeFileSync(join(dist, 'assets', 'index-AbCdEf12.js'), 'console.log(1)');
  writeFileSync(join(dist, 'assets', 'index-XyZ98765.css'), 'body{}');
  writeFileSync(join(root, 'secret.txt'), 'outside dist');
  sock = socketPath('http');
  server = await startServer({ socketPath: sock, distDir: dist, statusLogMs: 0, log: () => {} });
});

afterAll(async () => {
  await server.close();
});

describe('HTTP', () => {
  it('serves index.html and the assets it references with their content types', async () => {
    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.type).toMatch(/^text\/html/);
    expect(index.body).toContain('index-AbCdEf12.js');
    const head = await get('/', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    const withQuery = await get('/?mp=1&room=alpha');
    expect(withQuery.status).toBe(200);
    const js = await get('/assets/index-AbCdEf12.js');
    expect(js.status).toBe(200);
    expect(js.type).toMatch(/^text\/javascript/);
    const css = await get('/assets/index-XyZ98765.css');
    expect(css.status).toBe(200);
    expect(css.type).toMatch(/^text\/css/);
  });

  it('unknown paths are 404 and nothing outside dist/ is served', async () => {
    expect((await get('/nope.js')).status).toBe(404);
    // node:http sends each path exactly as given (like curl --path-as-is).
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt', '/%2e%2e%2fsecret.txt', '/..\\secret.txt', '/%00', '/%E0%A4%A']) {
      const r = await get(p);
      expect(r.status, p).toBe(404);
      expect(r.body).not.toContain('outside dist');
    }
    expect(resolveStatic('/srv/dist', '/../package.json')).toBeNull();
    expect(resolveStatic('/srv/dist', '/a/b.js?x=1')).toBe('/srv/dist/a/b.js');
    expect((await get('/', 'POST')).status).toBe(405);
  });

  it('reports rooms on GET /status as JSON', async () => {
    const bot = await Bot.connect({ url: wsUrl('/ws?room=stat'), name: 'S' });
    await bot.until(() => bot.snapshots.length >= 3);
    const r = await get('/status');
    expect(r.type).toMatch(/^application\/json/);
    const s = JSON.parse(r.body) as ReturnType<GameServer['status']>;
    const room = s.rooms.find((x) => x.id === 'stat')!;
    expect(room.players).toBe(1);
    expect(room.tickMs.mean).toBeGreaterThan(0);
    expect(room.tickMs.p95).toBeGreaterThanOrEqual(room.tickMs.mean * 0.5);
    expect(room.snapshotRate).toBeGreaterThan(0);
    expect(s.connections).toBe(1);
    await bot.close();
  });

  it.skipIf(!TCP_PORT)('listens on all interfaces over TCP: localhost and the LAN address', async () => {
    const tcp = await startServer({ port: TCP_PORT, host: '0.0.0.0', distDir: dist, statusLogMs: 0, log: () => {} });
    try {
      for (const host of ['127.0.0.1', ...lanAddresses()]) {
        const status = await new Promise<number>((resolve, reject) => {
          const req = request({ host, port: TCP_PORT, path: '/' }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          });
          req.on('error', reject);
          req.end();
        });
        console.log(`[http] GET http://${host}:${TCP_PORT}/ -> ${status}`);
        expect(status, host).toBe(200);
      }
      const ws = new WebSocket(`ws://127.0.0.1:${TCP_PORT}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      ws.close();
    } finally {
      await tcp.close();
    }
  });
});

describe('WebSocket', () => {
  it('upgrades on /ws and refuses other paths', async () => {
    const ok = new WebSocket(wsUrl('/ws'));
    await new Promise<void>((resolve, reject) => {
      ok.once('open', () => resolve());
      ok.once('error', reject);
    });
    ok.close();
    for (const path of ['/', '/socket', '/ws/x']) {
      const bad = new WebSocket(wsUrl(path));
      const err = await new Promise<Error>((resolve) => {
        bad.once('open', () => resolve(new Error('opened')));
        bad.once('error', (e) => resolve(e));
      });
      expect(err.message, path).toMatch(/404|Unexpected server response/);
    }
    expect((await get('/ws')).status).toBe(426);
  });

  it('refuses an oversized frame from its header alone', async () => {
    // A raw client: handshake by hand, then a frame header declaring 1 GiB and only a few bytes of it.
    const raw = netConnect(sock);
    await new Promise<void>((r) => raw.once('connect', () => r()));
    const rssBefore = process.memoryUsage().rss;
    const key = randomBytes(16).toString('base64');
    raw.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const handshake = await new Promise<string>((r) => raw.once('data', (d: Buffer) => r(d.toString())));
    expect(handshake).toMatch(/^HTTP\/1\.1 101/);
    const header = Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0x40, 0, 0, 0, 1, 2, 3, 4]);
    const closed = new Promise<void>((r) => raw.once('close', () => r()));
    raw.on('data', () => {});
    raw.on('error', () => {});
    raw.write(Buffer.concat([header, Buffer.alloc(64)]));
    await closed;
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(256 * 1024 * 1024);
  });
});
