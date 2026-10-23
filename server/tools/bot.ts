// A headless game client over a real WebSocket (Node, ws): joins a room, sends inputs and commands, and records every
// snapshot it receives (arrival time, tick, size). Used by the server tests and the measurement tools.

import WebSocket from 'ws';
import {
  decodeMessage, encodeMessage, PROTOCOL_VERSION, type CmdMsg, type EventMsg, type Message, type RejectMsg, type SnapshotMsg,
  type WelcomeMsg,
} from '../../src/net/protocol';
import { neutralInput, type PlayerInput } from '../../src/sim/input';

export interface BotOptions {
  url: string;
  name?: string;
  room?: string;
  version?: number;
  /** Keep every decoded snapshot (memory grows); otherwise only the latest. */
  keepAll?: boolean;
}

export interface SnapshotRecord { at: number; tick: number; ackSeq: number; bytes: number; entities: number; removed: number }

export class Bot {
  readonly ws: WebSocket;
  welcome: WelcomeMsg | null = null;
  rejected: RejectMsg | null = null;
  readonly snapshots: SnapshotRecord[] = [];
  readonly decoded: SnapshotMsg[] = [];
  latest: SnapshotMsg | null = null;
  readonly events: EventMsg[] = [];
  eventBytes = 0;
  bytesIn = 0;
  bytesOut = 0;
  inputsSent = 0;
  decodeErrors = 0;
  seq = 0;
  closed = false;
  closeCode = 0;
  closeReason = '';
  /** Ids the client currently knows (entities added by snapshots, minus removals). */
  readonly known = new Set<number>();
  private readonly waiters: Array<() => void> = [];

  private constructor(readonly opts: BotOptions) {
    this.ws = new WebSocket(opts.url, { perMessageDeflate: false });
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data: ArrayBuffer, isBinary: boolean) => this.onMessage(data, isBinary));
    this.ws.on('close', (code, reason) => {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason.toString();
      this.wake();
    });
    this.ws.on('error', () => {
      // The close event follows.
    });
  }

  /** Connects and sends hello; resolves once welcomed, rejected or closed. */
  static async connect(opts: BotOptions, timeoutMs = 10_000): Promise<Bot> {
    const bot = new Bot(opts);
    await new Promise<void>((resolve, reject) => {
      bot.ws.once('open', () => resolve());
      bot.ws.once('error', (e) => reject(e));
    });
    bot.send({ type: 'hello', version: opts.version ?? PROTOCOL_VERSION, name: opts.name ?? 'bot', room: opts.room ?? '' });
    await bot.until(() => !!bot.welcome || !!bot.rejected || bot.closed, timeoutMs);
    return bot;
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves when `pred` holds (checked on every message), or rejects after `timeoutMs`. */
  until(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bot wait timed out')), timeoutMs);
      const check = () => {
        if (pred()) {
          clearTimeout(timer);
          resolve();
        } else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  private onMessage(data: ArrayBuffer, isBinary: boolean): void {
    if (!isBinary) return;
    this.bytesIn += data.byteLength;
    let msg: Message;
    try {
      msg = decodeMessage(data);
    } catch {
      this.decodeErrors++;
      return;
    }
    if (msg.type === 'welcome') this.welcome = msg;
    else if (msg.type === 'reject') this.rejected = msg;
    else if (msg.type === 'snapshot') {
      this.latest = msg;
      if (this.opts.keepAll) this.decoded.push(msg);
      let n = 0;
      for (const list of [msg.vehicles, msg.characters, msg.projectiles, msg.helis, msg.pickups]) {
        for (const u of list) this.known.add(u.id);
        n += list.length;
      }
      for (const id of msg.removed) this.known.delete(id);
      this.snapshots.push({ at: performance.now(), tick: msg.tick, ackSeq: msg.ackSeq, bytes: data.byteLength, entities: n, removed: msg.removed.length });
    } else if (msg.type === 'event') {
      this.events.push(msg);
      this.eventBytes += data.byteLength;
    }
    this.wake();
  }

  send(msg: Message): void {
    this.sendRaw(encodeMessage(msg));
  }

  sendRaw(data: ArrayBuffer | Uint8Array | string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    this.ws.send(data);
  }

  input(over: Partial<PlayerInput> = {}): void {
    this.seq++;
    this.inputsSent++;
    this.send({ type: 'input', seq: this.seq, tick: this.latest?.tick ?? 0, input: { ...neutralInput(), ...over } });
  }

  cmd(name: string, arg: unknown = ''): void {
    const msg: CmdMsg = { type: 'cmd', seq: ++this.seq, name, arg: typeof arg === 'string' ? arg : JSON.stringify(arg) };
    this.send(msg);
  }

  bye(): void {
    this.send({ type: 'bye', reason: 'done' });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.ws.close(1000, 'done');
    await this.until(() => this.closed, 3000).catch(() => this.ws.terminate());
  }

  terminate(): void {
    this.ws.terminate();
  }
}
