// One client connection: validates and rate-limits what it sends, joins it to a room on hello, feeds its inputs and
// commands to the room, and leaves the room when the socket goes away.

import { decodeMessage, encodeMessage, peekType, PROTOCOL_VERSION, ProtocolError, type Message, type RejectCode } from '../src/net/protocol';
import type { Member, Peer, Room } from './room';
import type { RoomManager } from './rooms';

export interface ConnectionOptions {
  /** Room for a hello that names none (the ws URL's ?room=, else 'lobby'). */
  defaultRoom: string;
  /** Protocol errors tolerated before the connection is closed. */
  maxErrors: number;
  /** Messages per second accepted on average, and the burst above it; the rest are dropped. */
  ratePerSec: number;
  rateBurst: number;
  log: (line: string) => void;
  now: () => number;
}

export const CLOSE = { normal: 1000, unsupported: 1003, protocol: 1002, policy: 1008, version: 4001, full: 4002, badHello: 4003 } as const;

const closeFor: Record<RejectCode, number> = { full: CLOSE.full, version: CLOSE.version, badHello: CLOSE.badHello, shutdown: 1001, kicked: CLOSE.policy };

function cleanName(raw: string): string {
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 24);
  return s || 'Player';
}

export class Connection {
  room: Room | null = null;
  member: Member | null = null;
  closed = false;
  errors = 0;
  dropped = 0;
  received = 0;
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly peer: Peer, private readonly manager: RoomManager, private readonly opts: ConnectionOptions) {
    this.tokens = opts.rateBurst;
    this.lastRefill = opts.now();
  }

  private send(msg: Message): void {
    try {
      this.peer.send(encodeMessage(msg));
    } catch {
      // The socket is going away; its close event cleans up.
    }
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.leaveRoom();
    try {
      this.peer.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private reject(code: RejectCode, text: string): void {
    this.send({ type: 'reject', code, text });
    this.close(closeFor[code], text.slice(0, 120));
  }

  private fail(reason: string): void {
    this.errors++;
    if (this.errors >= this.opts.maxErrors) {
      this.opts.log(`[conn] closing after ${this.errors} protocol errors (last: ${reason})`);
      this.close(CLOSE.protocol, 'too many protocol errors');
    }
  }

  private allow(): boolean {
    const now = this.opts.now();
    this.tokens = Math.min(this.opts.rateBurst, this.tokens + ((now - this.lastRefill) / 1000) * this.opts.ratePerSec);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  onMessage(data: ArrayBuffer | ArrayBufferView | ArrayBufferView[], isBinary: boolean): void {
    if (this.closed) return;
    this.received++;
    if (!isBinary) {
      this.close(CLOSE.unsupported, 'binary messages only');
      return;
    }
    if (!this.allow()) {
      this.dropped++;
      return;
    }
    const bytes = Array.isArray(data) ? concat(data) : data;
    let msg: Message;
    try {
      msg = decodeMessage(bytes);
    } catch (err) {
      const e = err instanceof ProtocolError ? err : new ProtocolError('value', String(err));
      if (e.code === 'version' && !this.member && peekType(bytes)?.type === 'hello') {
        this.reject('version', `This server speaks protocol ${PROTOCOL_VERSION}; reload the game to update it.`);
        return;
      }
      this.fail(e.message);
      return;
    }
    try {
      this.handle(msg);
    } catch (err) {
      this.opts.log(`[conn] ${msg.type} handling failed: ${err instanceof Error ? err.stack : String(err)}`);
      this.fail('handler error');
    }
  }

  private handle(msg: Message): void {
    switch (msg.type) {
      case 'hello': {
        if (this.member) return this.fail('second hello');
        if (msg.version !== PROTOCOL_VERSION) return this.reject('version', `This server speaks protocol ${PROTOCOL_VERSION}, the game ${msg.version}; reload the game to update it.`);
        const res = this.manager.join(msg.room || this.opts.defaultRoom, cleanName(msg.name), this.peer);
        if ('reject' in res) return this.reject(res.reject, res.text);
        this.room = res.room;
        this.member = res.member;
        try {
          this.peer.send(res.room.welcome(res.member));
        } catch {
          // Closing; the close event removes the member.
        }
        this.opts.log(`[room ${res.room.id}] player ${res.member.playerId} "${res.member.name}" joined (${res.member.slot === null ? 'watching' : `slot ${res.member.slot}`}, ${res.room.members.size} in room)`);
        return;
      }
      case 'input':
        if (!this.member || !this.room) return this.fail('input before hello');
        this.room.input(this.member, msg.seq, msg.input, msg.tick);
        return;
      case 'cmd':
        if (!this.member || !this.room) return this.fail('cmd before hello');
        this.room.command(this.member, msg.name, msg.arg);
        return;
      case 'ping':
        this.send({ type: 'pong', clientTime: msg.clientTime, serverTime: this.opts.now(), tick: this.room?.tick ?? 0 });
        return;
      case 'bye':
        this.close(CLOSE.normal, 'bye');
        return;
      default:
        this.fail(`unexpected ${msg.type} from a client`);
    }
  }

  private leaveRoom(): void {
    if (this.room && this.member) {
      const { room, member } = this;
      this.manager.leave(room, member);
      this.opts.log(`[room ${room.id}] player ${member.playerId} "${member.name}" left (${room.members.size} in room)`);
    }
    this.room = null;
    this.member = null;
  }

  /** The socket closed (cleanly or not). */
  onClose(): void {
    this.closed = true;
    this.leaveRoom();
  }
}

function concat(parts: ArrayBufferView[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o);
    o += p.byteLength;
  }
  return out;
}
