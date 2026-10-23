// One multiplayer room: its own StaticWorld and Sim stepped at a fixed rate, the players in it, and the per-client
// snapshot stream (interest-filtered, each entity's groups sent only when they changed since that client last got them).

import {
  captureCharacter, captureHeli, capturePickup, captureProjectile, captureStatic, captureVehicle, captureClock,
  captureWeather, DEFAULT_INTEREST, selectInterest, signalHolds, viewerAt, type InterestOptions, type Viewer,
} from '../src/sim/snapshot';
import { Sim, type SimOptions } from '../src/sim/sim';
import { StaticWorld } from '../src/world/staticWorld';
import {
  encodeGroup, encodeMessage, writeIds, writeJobHud, writeRecord, writeSnapshotHead, writeWeather, Writer, type JobHud, type NetEvent,
  type RosterEntry, type SectionKey,
} from '../src/net/protocol';
import type { PickupUpdate } from '../src/sim/snapshot';
import { InputLatch } from './latch';
import { FixedLoop } from './loop';
import { PlayerSlotProvider, type SlotProvider } from './slots';
import { RateMeter, Rolling } from './stats';
import { classifyEvent, eventRelevant, type RoutedEvent } from './events';
import type { PlayerInput } from '../src/sim/input';
import { runCommand } from './commands';
import { RoomRules } from './lobby';

/** What a room needs of a client connection. */
export interface Peer {
  send(data: ArrayBuffer | Uint8Array): void;
  close(code: number, reason: string): void;
  readonly bufferedAmount: number;
}

export interface RoomOptions {
  tickRate: number;
  /**
   * Snapshots per second. Ticks are spread evenly: at 25 Hz from 60 Hz a snapshot follows 2 or 3 ticks after the last
   * (whole divisors of 60 would sit on the 20 or 30 Hz edge of the allowed range).
   */
  snapshotRate: number;
  maxPlayers: number;
  interest: InterestOptions;
  /** Allow the 'debug' command (tests, measurements). */
  dev: boolean;
  /** Run the real-time loop; false leaves stepping to the caller (tests). */
  realtime: boolean;
  /** A client with more than this queued is skipped for a snapshot; above closeBufferedBytes it is dropped. */
  maxBufferedBytes: number;
  closeBufferedBytes: number;
  log: (line: string) => void;
  slotProvider: (sim: Sim) => SlotProvider;
  /** Overrides for the room's Sim (tests: no ambient life, a start hour). */
  sim: Partial<SimOptions>;
  now: () => number;
}

export const DEFAULT_ROOM_OPTIONS: RoomOptions = {
  tickRate: 60,
  snapshotRate: 25,
  maxPlayers: 8,
  interest: DEFAULT_INTEREST,
  dev: false,
  realtime: true,
  maxBufferedBytes: 512 * 1024,
  closeBufferedBytes: 8 * 1024 * 1024,
  log: (line) => console.log(line),
  slotProvider: (sim) => new PlayerSlotProvider(sim),
  sim: {},
  now: () => performance.now(),
};

interface Known {
  groups: Array<Uint8Array | null>;
}

export class Member {
  readonly latch = new InputLatch();
  /** Controlled PlayerSlot, or null while watching. */
  slot: number | null = null;
  readonly known = new Map<number, Known>();
  interest: Set<number> | null = null;
  sentFirst = false;
  rosterVersion = -1;
  weather: Uint8Array | null = null;
  /** The job HUD block last sent (see JobHud), as encoded. */
  job: Uint8Array | null = null;
  holdsKey = '';
  brokenSent = 0;
  bytesOut = 0;
  snapshots = 0;
  snapshotsSkipped = 0;
  lastSnapshotBytes = 0;
  firstSnapshotBytes = 0;
  readonly joinedAt: number;

  constructor(readonly playerId: number, readonly name: string, readonly peer: Peer, now: number) {
    this.joinedAt = now;
  }

  /** The next snapshot is a full one again (every entity, globals and broken props), as after joining. */
  resync(): void {
    this.known.clear();
    this.sentFirst = false;
    this.rosterVersion = -1;
    this.weather = null;
    this.job = null;
    this.holdsKey = '';
    this.brokenSent = 0;
  }
}

const SECTION_ORDER: readonly SectionKey[] = ['vehicles', 'characters', 'projectiles', 'helis', 'pickups'];

function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface RoomStatus {
  id: string;
  seed: number;
  tick: number;
  simTime: number;
  players: number;
  spectators: number;
  /** Measured over the last 5 s. */
  tickRate: number;
  tickMs: { mean: number; p95: number; max: number; samples: number };
  snapshotRate: number;
  bytesOutPerSec: number;
  snapshotBytes: { mean: number; p95: number; max: number };
  droppedTicks: number;
  tickErrors: number;
  entities: { vehicles: number; characters: number; pickups: number; projectiles: number; helis: number };
  members: Array<{ playerId: number; name: string; slot: number; snapshots: number; skipped: number; ackSeq: number; bytesOut: number; interest: number }>;
}

export class Room {
  readonly world: StaticWorld;
  readonly sim: Sim;
  readonly slots: SlotProvider;
  /** Multiplayer rules: looks, kill credit, the head-to-head race, the room state for the clients. */
  readonly rules: RoomRules;
  readonly members = new Map<number, Member>();
  readonly opts: RoomOptions;
  readonly dt: number;
  tick = 0;
  tickErrors = 0;
  private events: RoutedEvent[] = [];
  private readonly brokenLog: number[] = [];
  private rosterVersion = 0;
  private readonly loop: FixedLoop | null;
  private readonly writer = new Writer(16 * 1024);
  private readonly scratch = new Writer(512);
  private readonly sectionWriter = new Writer(8 * 1024);
  readonly tickMs = new Rolling(600);
  readonly snapshotBytes = new Rolling(600);
  private readonly tickMeter = new RateMeter(5000);
  private readonly snapshotMeter = new RateMeter(5000);
  private readonly bytesMeter = new RateMeter(5000);
  readonly createdAt: number;
  closed = false;
  /** Called when the last member leaves. */
  onEmpty: (() => void) | null = null;

  constructor(readonly id: string, readonly seed: number, opts: Partial<RoomOptions> = {}) {
    this.opts = { ...DEFAULT_ROOM_OPTIONS, ...opts };
    this.dt = 1 / this.opts.tickRate;
    this.world = new StaticWorld();
    // The single-player game's street systems (gangs, roadblocks, witnesses, angry drivers, world weapon pickups),
    // with story missions, cheats and saving off (SimOptions.multiplayer).
    this.sim = new Sim({ ambient: true, police: true, weather: 'dynamic', streetCrime: true, multiplayer: true, seed, ...this.opts.sim, world: this.world });
    this.slots = this.opts.slotProvider(this.sim);
    this.captureEvents();
    this.rules = new RoomRules(this);
    this.loop = this.opts.realtime ? new FixedLoop(() => this.step(), { hz: this.opts.tickRate, maxCatchUp: 5, maxLagMs: 250, now: this.opts.now }) : null;
    this.createdAt = this.opts.now();
    this.loop?.start();
  }

  get droppedTicks(): number {
    return this.loop?.dropped ?? 0;
  }

  // -------------------------------------------------------------------------
  // Players

  /** Adds a player (controlling a free slot, else watching), or returns 'full'. */
  join(playerId: number, name: string, peer: Peer): Member | 'full' {
    if (this.members.size >= this.opts.maxPlayers) return 'full';
    const m = new Member(playerId, name, peer, this.opts.now());
    m.slot = this.slots.claim(playerId);
    this.members.set(playerId, m);
    this.rosterVersion++;
    this.rules.onJoin(m);
    return m;
  }

  /** The welcome message for a member that just joined; seeds what it knows (static state, nearby pickups). */
  welcome(m: Member): ArrayBuffer {
    const st = captureStatic(this.sim);
    m.brokenSent = this.brokenLog.length;
    const interest = selectInterest(this.sim, this.viewersOf(m), this.slots.characters(), null, this.opts.interest);
    const pickups: PickupUpdate[] = [];
    for (const p of this.sim.pickups) {
      if (p.removed || !interest.has(p.id)) continue;
      const state = capturePickup(p);
      pickups.push({ id: p.id, state });
      m.known.set(p.id, { groups: [this.encode('pickups', 'state', state)] });
    }
    return encodeMessage({
      type: 'welcome',
      playerId: m.playerId,
      slot: m.slot ?? -1,
      roomId: this.id,
      roomSeed: this.seed,
      tick: this.tick,
      tickRate: this.opts.tickRate,
      snapshotRate: this.opts.snapshotRate,
      brokenProps: st.brokenProps,
      signalHolds: st.signalHolds,
      pickups,
    });
  }

  leave(m: Member): void {
    if (!this.members.delete(m.playerId)) return;
    this.rules.onLeave(m, m.slot);
    if (m.slot !== null) {
      const slot = m.slot;
      this.slots.release(slot);
      m.slot = null;
      // The longest-waiting watcher takes the freed slot over.
      for (const other of this.members.values()) {
        if (other.slot !== null) continue;
        const got = this.slots.claim(other.playerId);
        if (got === null) break;
        other.slot = got;
        other.latch.clear();
        this.rules.onSlot(other);
        break;
      }
    }
    this.rosterVersion++;
    if (this.members.size === 0) this.onEmpty?.();
  }

  memberOfSlot(slot: number): Member | null {
    for (const m of this.members.values()) if (m.slot === slot) return m;
    return null;
  }

  input(m: Member, seq: number, input: PlayerInput, clientTick: number): void {
    m.latch.push(seq, input, clientTick);
  }

  command(m: Member, name: string, arg: string): void {
    runCommand(this, m, name, arg);
  }

  roster(): RosterEntry[] {
    return [...this.members.values()].map((m) => ({
      playerId: m.playerId,
      characterId: m.slot !== null ? this.slots.character(m.slot).id : 0,
      slot: m.slot ?? -1,
      name: m.name,
    }));
  }

  /** A member's points of view: its slot's character, or slot 0's while it watches. */
  viewersOf(m: Member): Viewer[] {
    const slot = m.slot ?? 0;
    return [viewerAt(this.slots.character(slot), this.slots.hud(slot).wanted)];
  }

  // -------------------------------------------------------------------------
  // Loop

  private captureEvents(): void {
    const events = this.sim.events;
    const emit = events.emit.bind(events);
    // The server forwards every event type, also ones added after this file, so it listens below the typed API.
    events.emit = ((type: string, payload: unknown) => {
      this.onSimEvent(type, payload);
      (emit as (t: string, p: unknown) => void)(type, payload);
    }) as typeof events.emit;
  }

  private onSimEvent(type: string, payload: unknown): void {
    this.rules?.onSimEvent(type, payload);
    if (type === 'propBroken') this.brokenLog.push((payload as { index: number }).index);
    const routed = classifyEvent(type, payload, (pid) => {
      const holder = this.memberOfSlot(this.slots.slotOfEvent(pid));
      return holder ? holder.playerId : 0;
    });
    routed.tick = this.tick + 1;
    this.events.push(routed);
  }

  /** One fixed tick: every slot's latched input, one Sim update at dt, and a snapshot when one is due. */
  step(): void {
    if (this.closed) return;
    const t0 = this.opts.now();
    const inputs = new Map<number, PlayerInput>();
    for (const m of this.members.values()) {
      const inp = m.latch.next();
      if (m.slot !== null) inputs.set(m.slot, inp);
    }
    this.rules.beforeStep(inputs);
    try {
      this.slots.step(this.dt, inputs);
    } catch (err) {
      this.tickErrors++;
      if (this.tickErrors <= 3 || this.tickErrors % 600 === 0) this.opts.log(`[room ${this.id}] tick ${this.tick} failed (${this.tickErrors}): ${err instanceof Error ? err.stack : String(err)}`);
    }
    this.tick++;
    try {
      this.rules.afterStep();
    } catch (err) {
      this.tickErrors++;
      if (this.tickErrors <= 3) this.opts.log(`[room ${this.id}] rules at tick ${this.tick} failed: ${err instanceof Error ? err.stack : String(err)}`);
    }
    const r = this.opts.snapshotRate / this.opts.tickRate;
    if (Math.floor(this.tick * r) > Math.floor((this.tick - 1) * r)) this.broadcast();
    const now = this.opts.now();
    this.tickMs.add(now - t0);
    this.tickMeter.mark(now);
  }

  private encode(section: SectionKey, group: string, value: unknown): Uint8Array {
    this.scratch.reset();
    encodeGroup(section, group, value, this.scratch);
    return this.scratch.view8().slice();
  }

  /** Every entity's encoded groups, for this broadcast. */
  private captureAll(): Map<number, Uint8Array[]> {
    const out = new Map<number, Uint8Array[]>();
    const sim = this.sim;
    for (const v of sim.vehicles) {
      if (v.removed) continue;
      const c = captureVehicle(v);
      out.set(v.id, [this.encode('vehicles', 'motion', c.motion), this.encode('vehicles', 'engine', c.engine), this.encode('vehicles', 'status', c.status), this.encode('vehicles', 'rare', c.rare)]);
    }
    for (const ch of sim.characters) {
      if (ch.removed) continue;
      const c = captureCharacter(ch);
      out.set(ch.id, [this.encode('characters', 'motion', c.motion), this.encode('characters', 'status', c.status), this.encode('characters', 'combat', c.combat), this.encode('characters', 'rare', c.rare)]);
    }
    for (const p of sim.projectiles) if (!p.removed) out.set(p.id, [this.encode('projectiles', 'state', captureProjectile(p))]);
    for (const h of sim.helis) if (!h.removed) out.set(h.id, [this.encode('helis', 'state', captureHeli(h))]);
    for (const p of sim.pickups) if (!p.removed) out.set(p.id, [this.encode('pickups', 'state', capturePickup(p))]);
    return out;
  }

  private broadcast(): void {
    const sim = this.sim;
    const now = this.opts.now();
    const groups = this.captureAll();
    const lists: Record<SectionKey, ReadonlyArray<{ id: number; removed: boolean }>> = {
      vehicles: sim.vehicles, characters: sim.characters, projectiles: sim.projectiles, helis: sim.helis, pickups: sim.pickups,
    };
    this.scratch.reset();
    writeWeather(this.scratch, captureWeather(sim));
    const weather = this.scratch.view8().slice();
    const holds = signalHolds(sim);
    const holdsKey = holds.map(([n, a]) => `${n}${a}`).join(',');
    const clock = captureClock(sim);
    const players = this.slots.characters();
    const roster = this.roster();
    const events = this.events;
    this.events = [];

    for (const m of [...this.members.values()]) {
      if (m.peer.bufferedAmount > this.opts.closeBufferedBytes) {
        this.opts.log(`[room ${this.id}] dropping player ${m.playerId} (${m.name}): ${m.peer.bufferedAmount} bytes queued`);
        m.peer.close(1013, 'too far behind');
        this.leave(m);
        continue;
      }
      if (m.peer.bufferedAmount > this.opts.maxBufferedBytes) {
        m.snapshotsSkipped++;
        continue;
      }
      const viewers = this.viewersOf(m);
      const interest = selectInterest(sim, viewers, players, m.interest, this.opts.interest);
      m.interest = interest;
      const w = this.writer;
      w.reset();
      const slot = m.slot ?? 0;
      const job = (m.slot !== null ? this.rules.jobFor(m.slot) : null) ?? this.slots.job(slot);
      const jobBytes = this.jobBytes(job);
      const jobChanged = !m.sentFirst || !sameBytes(m.job, jobBytes);
      writeSnapshotHead(w, {
        tick: this.tick,
        ackSeq: m.latch.ackSeq,
        time: sim.time,
        full: !m.sentFirst,
        clock,
        hud: this.slots.hud(slot),
        job: jobChanged ? job : null,
        roster: m.rosterVersion !== this.rosterVersion ? roster : null,
        weather: sameBytes(m.weather, weather) ? null : (sim.weather.state),
        signalHolds: m.sentFirst && m.holdsKey === holdsKey ? null : holds,
        brokenProps: this.brokenLog.slice(m.brokenSent),
      });
      for (const key of SECTION_ORDER) {
        const sw = this.sectionWriter;
        sw.reset();
        let count = 0;
        for (const e of lists[key]) {
          if (e.removed || !interest.has(e.id)) continue;
          const now8 = groups.get(e.id);
          if (!now8) continue;
          const known = m.known.get(e.id);
          const send = now8.map((b, i) => (known && sameBytes(known.groups[i], b) ? null : b));
          if (writeRecord(sw, e.id, send)) count++;
          if (known) known.groups = now8;
          else m.known.set(e.id, { groups: now8 });
        }
        w.varu(count);
        w.raw(sw.view8());
      }
      const removed: number[] = [];
      for (const id of m.known.keys()) if (!interest.has(id) || !groups.has(id)) removed.push(id);
      for (const id of removed) m.known.delete(id);
      writeIds(w, removed);
      const bytes = w.view8();
      if (!this.sendTo(m, bytes)) continue;
      if (!m.sentFirst) m.firstSnapshotBytes = bytes.length;
      m.sentFirst = true;
      m.rosterVersion = this.rosterVersion;
      m.weather = weather;
      m.job = jobBytes;
      m.holdsKey = holdsKey;
      m.brokenSent = this.brokenLog.length;
      m.snapshots++;
      m.lastSnapshotBytes = bytes.length;
      this.snapshotBytes.add(bytes.length);
      this.bytesMeter.mark(now, bytes.length);

      const mine = events.filter((e) => eventRelevant(e, m.playerId, viewers, interest, this.opts.interest.keepRadius)).map((e) => this.forMember(e.ev, viewers));
      if (mine.length > 0) {
        const buf = encodeMessage({ type: 'event', tick: this.tick, events: mine.slice(0, 4000) as NetEvent[] }, this.scratch);
        if (this.sendTo(m, new Uint8Array(buf))) this.bytesMeter.mark(now, buf.byteLength);
      }
    }
    this.snapshotMeter.mark(now);
  }

  private jobBytes(job: JobHud): Uint8Array {
    this.scratch.reset();
    writeJobHud(this.scratch, job);
    return this.scratch.view8().slice();
  }

  /** An event as one member gets it: a lightning strike's distance is from him (the thunder's delay), not from slot 0. */
  private forMember(ev: NetEvent, viewers: readonly { x: number; z: number }[]): NetEvent {
    const v = viewers[0];
    if (ev.type !== 'lightning' || !v || typeof ev.data.x !== 'number' || typeof ev.data.z !== 'number') return ev;
    return { ...ev, data: { ...ev.data, dist: Math.hypot(ev.data.x - v.x, ev.data.z - v.z) } };
  }

  private sendTo(m: Member, bytes: Uint8Array): boolean {
    try {
      m.peer.send(bytes.slice());
      m.bytesOut += bytes.length;
      return true;
    } catch (err) {
      this.opts.log(`[room ${this.id}] send to player ${m.playerId} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.leave(m);
      return false;
    }
  }

  /**
   * An event of the room's own (not the sim's) for the next broadcast: to one member (`toPlayerId`), shown by its client
   * at once, or with 0 to every client.
   */
  pushEvent(type: string, data: Record<string, unknown>, toPlayerId = 0): void {
    this.events.push({ ev: { type, playerId: toPlayerId, data }, tick: this.tick + 1, scoped: toPlayerId !== 0, x: null, z: null, refs: [] });
  }

  /** Sends a message to every member (roster-independent notices, shutdown). */
  sendAll(buf: ArrayBuffer): void {
    for (const m of [...this.members.values()]) this.sendTo(m, new Uint8Array(buf));
  }

  status(): RoomStatus {
    const now = this.opts.now();
    let players = 0;
    for (const m of this.members.values()) if (m.slot !== null) players++;
    const sim = this.sim;
    const live = <T extends { removed: boolean }>(a: readonly T[]) => a.filter((e) => !e.removed).length;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    return {
      id: this.id,
      seed: this.seed,
      tick: this.tick,
      simTime: r3(sim.time),
      players,
      spectators: this.members.size - players,
      tickRate: Math.round(this.tickMeter.rate(now, this.createdAt) * 10) / 10,
      tickMs: { mean: r3(this.tickMs.mean()), p95: r3(this.tickMs.percentile(95)), max: r3(this.tickMs.max()), samples: this.tickMs.count },
      snapshotRate: Math.round(this.snapshotMeter.rate(now, this.createdAt) * 10) / 10,
      bytesOutPerSec: Math.round(this.bytesMeter.rate(now, this.createdAt, true)),
      snapshotBytes: { mean: Math.round(this.snapshotBytes.mean()), p95: this.snapshotBytes.percentile(95), max: this.snapshotBytes.max() },
      droppedTicks: this.droppedTicks,
      tickErrors: this.tickErrors,
      entities: { vehicles: live(sim.vehicles), characters: live(sim.characters), pickups: live(sim.pickups), projectiles: live(sim.projectiles), helis: live(sim.helis) },
      members: [...this.members.values()].map((m) => ({ playerId: m.playerId, name: m.name, slot: m.slot ?? -1, snapshots: m.snapshots, skipped: m.snapshotsSkipped, ackSeq: m.latch.ackSeq, bytesOut: m.bytesOut, interest: m.interest?.size ?? 0 })),
    };
  }

  close(): void {
    this.closed = true;
    this.loop?.stop();
  }
}
