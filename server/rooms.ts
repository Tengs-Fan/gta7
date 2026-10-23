// The rooms of one server, by id. A room is created by its first player and closed a while after its last one left.

import type { RejectCode } from '../src/net/protocol';
import { Member, Room, type Peer, type RoomOptions, type RoomStatus } from './room';

export interface ManagerOptions {
  room: Partial<RoomOptions>;
  /** An empty room stays (world, wrecks, clock) this long for players to come back to. */
  emptyRoomTtlMs: number;
  maxRooms: number;
  /** Mixed into every room seed (0: a room's seed follows from its id alone). */
  seedSalt: number;
  log: (line: string) => void;
}

export const DEFAULT_MANAGER_OPTIONS: ManagerOptions = {
  room: {},
  emptyRoomTtlMs: 30_000,
  maxRooms: 32,
  seedSalt: 0,
  log: (line) => console.log(line),
};

export const DEFAULT_ROOM = 'lobby';
const ROOM_ID = /^[A-Za-z0-9_.-]{1,32}$/;

export function validRoomId(id: string): boolean {
  return ROOM_ID.test(id);
}

/** FNV-1a of the room id: rooms get different seeds, and a room id always the same one. */
export function seedFor(roomId: string, salt = 0): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < roomId.length; i++) {
    h ^= roomId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type JoinResult = { room: Room; member: Member } | { reject: RejectCode; text: string };

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  readonly opts: ManagerOptions;
  private nextPlayerId = 1;
  private readonly closeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: Partial<ManagerOptions> = {}) {
    this.opts = { ...DEFAULT_MANAGER_OPTIONS, ...opts };
  }

  get playerCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.members.size;
    return n;
  }

  room(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  private open(id: string): Room | null {
    let room = this.rooms.get(id);
    if (room) return room;
    if (this.rooms.size >= this.opts.maxRooms) return null;
    room = new Room(id, seedFor(id, this.opts.seedSalt), { log: this.opts.log, ...this.opts.room });
    const r = room;
    r.onEmpty = () => this.scheduleClose(r);
    this.rooms.set(id, room);
    this.opts.log(`[room ${id}] opened (seed ${room.seed})`);
    return room;
  }

  join(roomId: string, name: string, peer: Peer): JoinResult {
    const id = roomId || DEFAULT_ROOM;
    if (!validRoomId(id)) return { reject: 'badHello', text: 'Room names are 1-32 letters, digits, ".", "_" or "-".' };
    const room = this.open(id);
    if (!room) return { reject: 'full', text: `The server is full (${this.opts.maxRooms} rooms).` };
    const t = this.closeTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.closeTimers.delete(id);
    }
    const member = room.join(this.nextPlayerId, name, peer);
    if (member === 'full') {
      if (room.members.size === 0) this.scheduleClose(room);
      return { reject: 'full', text: `Room "${id}" is full (${room.opts.maxPlayers} players).` };
    }
    this.nextPlayerId++;
    return { room, member };
  }

  leave(room: Room, member: Member): void {
    room.leave(member);
  }

  private scheduleClose(room: Room): void {
    if (this.closeTimers.has(room.id)) return;
    const close = () => {
      this.closeTimers.delete(room.id);
      if (room.members.size > 0 || this.rooms.get(room.id) !== room) return;
      room.close();
      this.rooms.delete(room.id);
      this.opts.log(`[room ${room.id}] closed (empty)`);
    };
    if (this.opts.emptyRoomTtlMs <= 0) return close();
    this.closeTimers.set(room.id, setTimeout(close, this.opts.emptyRoomTtlMs));
  }

  status(): RoomStatus[] {
    return [...this.rooms.values()].map((r) => r.status());
  }

  closeAll(): void {
    for (const t of this.closeTimers.values()) clearTimeout(t);
    this.closeTimers.clear();
    for (const r of this.rooms.values()) r.close();
    this.rooms.clear();
  }
}
