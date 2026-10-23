// The multiplayer game server: the built client over HTTP, a status endpoint, and the game over WebSocket at /ws,
// all on one port.

import { rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { Connection, type ConnectionOptions } from './connection';
import { RoomManager, DEFAULT_ROOM, type ManagerOptions } from './rooms';
import type { Peer, RoomOptions } from './room';
import { PuppetSlotProvider } from './slots';
import { serveStatic } from './static';
import type { Sim } from '../src/sim/sim';

export interface ServerOptions {
  port: number;
  host: string;
  /** Listen on this Unix socket instead of a TCP port (tests: no TCP port is bound). */
  socketPath: string | null;
  /** Built client to serve (npm run build writes dist/). */
  distDir: string;
  /** Enables the 'debug' command. */
  dev: boolean;
  /** Dev only: extra players walk as stand-in characters (PuppetSlotProvider) instead of watching. */
  puppets: boolean;
  /** WebSocket frames above this are refused (ws checks the declared length before reading the payload). */
  maxPayload: number;
  /** A socket that does not answer a ping within two of these is dropped. */
  heartbeatMs: number;
  /** Period of the status log line per room (0: none). */
  statusLogMs: number;
  room: Partial<RoomOptions>;
  manager: Partial<Omit<ManagerOptions, 'room' | 'log'>>;
  connection: Partial<Omit<ConnectionOptions, 'log' | 'defaultRoom'>>;
  log: (line: string) => void;
}

export const DEFAULT_PORT = 4210;

export interface GameServer {
  /** TCP port, or 0 on a Unix socket. */
  readonly port: number;
  readonly socketPath: string | null;
  readonly http: Server;
  readonly wss: WebSocketServer;
  readonly manager: RoomManager;
  /** Every address the server can be opened on (localhost and each LAN interface). */
  urls(): string[];
  status(): ServerStatus;
  close(): Promise<void>;
}

export interface ServerStatus {
  uptime: number;
  /** Process memory, MB. */
  rssMB: number;
  heapMB: number;
  connections: number;
  players: number;
  rooms: ReturnType<RoomManager['status']>;
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

export function statusLine(r: ReturnType<RoomManager['status']>[number]): string {
  return `[status] room=${r.id} players=${r.players} spectators=${r.spectators} tick=${r.tick} rate=${r.tickRate.toFixed(1)}Hz ` +
    `tick_ms_mean=${r.tickMs.mean.toFixed(3)} tick_ms_p95=${r.tickMs.p95.toFixed(3)} tick_ms_max=${r.tickMs.max.toFixed(3)} ` +
    `snapshots=${r.snapshotRate.toFixed(1)}Hz snapshot_bytes_mean=${r.snapshotBytes.mean} out=${(r.bytesOutPerSec / 1024).toFixed(1)}KB/s ` +
    `vehicles=${r.entities.vehicles} characters=${r.entities.characters} helis=${r.entities.helis} dropped_ticks=${r.droppedTicks} tick_errors=${r.tickErrors}`;
}

export async function startServer(options: Partial<ServerOptions> & { distDir: string }): Promise<GameServer> {
  const opts: ServerOptions = {
    port: DEFAULT_PORT,
    host: '0.0.0.0',
    socketPath: null,
    dev: false,
    puppets: false,
    maxPayload: 64 * 1024,
    heartbeatMs: 1000,
    statusLogMs: 10_000,
    room: {},
    manager: {},
    connection: {},
    log: (line) => console.log(line),
    ...options,
  };
  const log = opts.log;
  const started = performance.now();
  const puppets = opts.dev && opts.puppets ? { slotProvider: (sim: Sim) => new PuppetSlotProvider(sim, 8) } : {};
  const manager = new RoomManager({ ...opts.manager, log, room: { dev: opts.dev, log, ...puppets, ...opts.room } });
  const sockets = new Set<WebSocket>();

  const status = (): ServerStatus => ({
    uptime: Math.round((performance.now() - started) / 100) / 10,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    connections: sockets.size,
    players: manager.playerCount,
    rooms: manager.status(),
  });

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/status') {
      const body = JSON.stringify(status(), null, 2);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (path === '/ws') {
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8', upgrade: 'websocket' });
      res.end('WebSocket upgrade required\n');
      return;
    }
    serveStatic(opts.distDir, req, res).catch((err: unknown) => {
      log(`[http] ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };

  const http = createServer(onRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload, perMessageDeflate: false });

  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // Falls through to the refusal below.
    }
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    sockets.add(ws);
    alive.set(ws, true);
    let room = DEFAULT_ROOM;
    try {
      room = new URL(req.url ?? '/', 'http://localhost').searchParams.get('room') || DEFAULT_ROOM;
    } catch {
      // Keep the default.
    }
    const peer: Peer = {
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
    };
    const conn = new Connection(peer, manager, {
      defaultRoom: room,
      maxErrors: 32,
      ratePerSec: 240,
      rateBurst: 480,
      now: () => performance.now(),
      ...opts.connection,
      log,
    });
    ws.on('message', (data, isBinary) => conn.onMessage(data as ArrayBufferView | ArrayBufferView[], isBinary));
    ws.on('pong', () => alive.set(ws, true));
    ws.on('close', () => {
      sockets.delete(ws);
      conn.onClose();
    });
    ws.on('error', (err) => {
      // Oversized frames, bad framing, resets: the socket closes and the close handler cleans up.
      log(`[conn] socket error: ${err.message}`);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, opts.heartbeatMs);
  const statusTimer = opts.statusLogMs > 0
    ? setInterval(() => {
      for (const r of manager.status()) log(statusLine(r));
    }, opts.statusLogMs)
    : null;

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    const done = () => {
      http.off('error', reject);
      resolve();
    };
    if (opts.socketPath) {
      rmSync(opts.socketPath, { force: true });
      http.listen(opts.socketPath, done);
    } else http.listen(opts.port, opts.host, done);
  });
  http.on('error', (err) => log(`[http] ${err.message}`));
  const port = opts.socketPath ? 0 : (http.address() as AddressInfo).port;

  return {
    port,
    socketPath: opts.socketPath,
    http,
    wss,
    manager,
    urls: () => {
      if (opts.socketPath) return [`unix:${opts.socketPath}`];
      const hosts = opts.host === '0.0.0.0' || opts.host === '::' ? ['127.0.0.1', ...lanAddresses()] : [opts.host];
      return hosts.map((h) => `http://${h}:${port}/`);
    },
    status,
    close: async () => {
      clearInterval(heartbeat);
      if (statusTimer) clearInterval(statusTimer);
      manager.closeAll();
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      if (opts.socketPath) rmSync(opts.socketPath, { force: true });
    },
  };
}
