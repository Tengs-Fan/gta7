// The client's copy of the server's game: entity objects rebuilt from snapshots, drawn through the same ViewState the
// single-player Sim offers, so the renderer, HUD and audio need no multiplayer path. Remote entities are drawn from an
// interpolation buffer behind the newest snapshot; the server's events are re-emitted on the mirror's own emitter with
// entity ids turned back into the mirror's objects. Pure TypeScript (no three.js, no DOM).

import { Emitter } from '../core/emitter';
import type { V3 } from '../core/math';
import { GameClock } from '../sim/clock';
import { Character, Helicopter, Pickup, Projectile, Vehicle, type Appearance } from '../sim/entities';
import type { SimEvents } from '../sim/events';
import type { PlayerCheats, PlayerTag } from '../sim/playerSlot';
import { gaitPhaseStep } from '../sim/pose';
import { Progress } from '../sim/progress';
import {
  applyCharacterUpdate, applyVehicleUpdate, type CharacterUpdate, type HeliUpdate, type PickupUpdate, type ProjectileUpdate,
  type VehicleUpdate,
} from '../sim/snapshot';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import type { ActivitiesView, CombatView, InteractionsView, MissionView, PlayerView, ViewState, WantedView } from '../sim/viewState';
import { clearWeather } from '../sim/weather';
import type { StaticCollider } from '../world/colliders';
import type { StaticWorld } from '../world/staticWorld';
import { emptySample, MotionTrack, RenderClock, type MotionSample } from './interp';
import type { Objective } from '../sim/activities/types';
import type { EventMsg, Hud, JobHud, NetEvent, NetRef, RosterEntry, SnapshotMsg, WelcomeMsg } from './protocol';

/** Event fields that must resolve to a known entity; an event missing one is dropped (its effect has no subject). */
const REQUIRED_REFS: Readonly<Record<string, readonly string[]>> = {
  damage: ['victim'],
  scrape: ['vehicle'],
  horn: ['vehicle'],
  vehicleEnter: ['vehicle', 'character'],
  vehicleExit: ['vehicle', 'character'],
  vehicleDestroyed: ['vehicle'],
  characterKilled: ['victim'],
  reload: ['character'],
};

/** Seconds after a death past the server's respawn (4.8 s) at which the client stops waiting for its respawn event. */
const RESPAWN_FALLBACK = 6.5;

/** World events are shown this many ticks before their broadcast tick on the render timeline (they happened in the ticks since the last snapshot). */
const EVENT_LEAD_TICKS = 2;

const isRef = (v: unknown): v is NetRef => !!v && typeof v === 'object' && typeof (v as NetRef).$id === 'number' && Object.keys(v).length === 1;

/** A player's wanted record as far as the client knows it: level and search state from the server's HUD data. */
class NetWanted implements WantedView {
  level = 0;
  searching = false;
  floor = 0;
  lastSeenX = 0;
  lastSeenZ = 0;

  get searchCenter(): { x: number; z: number } {
    return { x: this.lastSeenX, z: this.lastSeenZ };
  }

  searchRadius(level = this.level): number {
    return 60 + level * 25;
  }

  evadeProgress(): number {
    return 0;
  }
}

const NO_ENTER = { findEnterable: (): Vehicle | null => null };

/** One player of the room as the presentation sees it. */
export class NetPlayer implements PlayerView {
  tag: PlayerTag;
  readonly ctl = NO_ENTER;
  readonly wanted = new NetWanted();
  readonly progress = new Progress();
  readonly cheats: PlayerCheats = { godMode: false, neverWanted: false };
  controlLock = 0;
  deathKind: 'wasted' | 'busted' | null = null;
  deathTimer = -1;
  name = '';
  slot = -1;

  constructor(public id: number, public character: Character) {
    this.tag = { playerId: id };
  }

  get down(): boolean {
    return this.deathKind !== null;
  }

  pos(): V3 {
    return this.character.vehicle ? this.character.vehicle.pos : this.character.pos;
  }
}

const NO_MISSIONS: MissionView = {
  active: null,
  defs: [],
  offers: () => [],
  retryOffer: () => null,
  retryMenuOffer: () => null,
  retryAfterCops: () => null,
};

const NO_INTERACTIONS: InteractionsView = {
  markers: [],
  current: () => null,
  canSave: () => false,
  prompt: () => null,
  priceOf: () => 0,
  buy: () => 'Not available in multiplayer.',
};

const NO_COMBAT: CombatView = { muzzleBlocked: () => false };

type Kind = 'vehicle' | 'character' | 'projectile' | 'heli' | 'pickup';
type Entity = Vehicle | Character | Projectile | Helicopter | Pickup;

/** Raw server values of an entity's groups as last received (the mirror's objects may show interpolated or predicted ones). */
export interface RawGroups {
  kind: Kind;
  groups: Record<string, unknown>;
}

export interface MirrorOptions {
  world: StaticWorld;
  /** Muzzle-in-wall checks (the renderer's muzzle flash): a Sim's CombatSystem over the same world. */
  combat?: CombatView;
  tickRate?: number;
  /** Interpolation delay behind the earliest-arrival line of the snapshots, in ticks (7 = 117 ms at 60 Hz). */
  delayTicks?: number;
}

export interface ApplyResult {
  /** The snapshot was older than one already applied, and ignored. */
  stale: boolean;
  /** Snapshots were missed before this one (lost on the way): what is known may be out of date until a resync. */
  gap: boolean;
  /** Updates for entities the mirror cannot build (their first full record was lost); a resync is needed. */
  missing: number;
}

export interface MirrorStats {
  snapshots: number;
  gaps: number;
  stale: number;
  missing: number;
  events: number;
  eventsDropped: number;
  unknownKinds: number;
}

export class Mirror implements ViewState {
  readonly world: StaticWorld;
  readonly roads: StaticWorld['roads'];
  readonly events = new Emitter<SimEvents>();
  readonly clock = new GameClock(12);
  readonly weather = { state: clearWeather() };
  time = 0;
  frame = 0;
  readonly characters: Character[] = [];
  readonly vehicles: Vehicle[] = [];
  readonly pickups: Pickup[] = [];
  readonly projectiles: Projectile[] = [];
  readonly helis: Helicopter[] = [];
  readonly players: NetPlayer[] = [];
  readonly missions = NO_MISSIONS;
  /** The local player's own side job, from the snapshots (status line and objective markers; no job object). */
  readonly activities: ActivitiesView;
  readonly interactions = NO_INTERACTIONS;
  readonly combat: CombatView;

  /** This client's player id (0 before the welcome). */
  playerId = 0;
  /** The PlayerSlot this client controls, -1 while it watches. */
  slot = -1;
  roomId = '';
  roomSeed = 0;
  tickRate: number;
  snapshotRate = 25;
  /** Tick of the newest snapshot applied (-1: none yet). */
  tick = -1;
  ackSeq = 0;
  hud: Hud = { wanted: 0, searching: false, money: 0, clip: 0, ammo: 0 };
  jobHud: JobHud = { kind: '', status: '', objectives: [] };
  roster: RosterEntry[] = [];
  readonly renderClock: RenderClock;
  /** Entities a predictor draws itself (the local player and his car): update() leaves their motion alone. */
  readonly locallyDriven = new Set<number>();
  readonly stats: MirrorStats = { snapshots: 0, gaps: 0, stale: 0, missing: 0, events: 0, eventsDropped: 0, unknownKinds: 0 };

  private readonly byId = new Map<number, { kind: Kind; e: Entity }>();
  private readonly raw = new Map<number, RawGroups>();
  private readonly tracks = new Map<number, MotionTrack>();
  private readonly playersById = new Map<number, NetPlayer>();
  /** The local player's view: always present, so the presentation has someone to follow from the start. */
  readonly me: NetPlayer;
  private readonly placeholder: Character;
  private readonly queued: Array<{ tick: number; type: string; payload: Record<string, unknown> }> = [];
  private readonly broken = new Set<number>();
  private readonly pendingBroken: number[] = [];
  private readonly colliderOfProp = new Map<number, StaticCollider>();
  private readonly scratch: MotionSample = emptySample(0);
  private snapTime = 0;

  constructor(opts: MirrorOptions) {
    this.world = opts.world;
    this.roads = opts.world.roads;
    this.combat = opts.combat ?? NO_COMBAT;
    this.tickRate = opts.tickRate ?? 60;
    this.renderClock = new RenderClock(this.tickRate, opts.delayTicks ?? 7);
    for (const c of this.world.grid.colliders) if (c.breakable && c.propIndex >= 0) this.colliderOfProp.set(c.propIndex, c);
    const home = this.world.layout.pois.find((p) => p.id === 'safehouse');
    this.placeholder = new Character(0, 'player', home?.x ?? 0, this.world.groundHeight(home?.x ?? 0, home?.z ?? 0), home?.z ?? 0, PLACEHOLDER_LOOK);
    this.me = new NetPlayer(0, this.placeholder);
    this.players.push(this.me);
    const self = this;
    this.activities = {
      get busy() {
        return self.jobHud.kind !== '';
      },
      job: null,
      objectives: () => this.jobObjectives(),
      status: () => this.jobHud.status || null,
      streetRunCourses: () => [],
      jobPrompt: () => null,
    };
  }

  /** The job's markers, following the entities the mirror knows (a point where it does not). */
  private jobObjectives(): Objective[] {
    return this.jobHud.objectives.map((o) => {
      const vehicle = o.vehicle ? this.vehicle(o.vehicle) : null;
      const character = o.character ? this.character(o.character) : null;
      const at = vehicle?.pos ?? character?.pos ?? o;
      return { x: at.x, z: at.z, label: o.label, color: o.color, radius: o.radius, vehicle, character };
    });
  }

  // ---------------------------------------------------------------------------
  // Lookups

  entity(id: number): Entity | undefined {
    return this.byId.get(id)?.e;
  }

  vehicle(id: number): Vehicle | null {
    const x = this.byId.get(id);
    return x && x.kind === 'vehicle' ? (x.e as Vehicle) : null;
  }

  character(id: number): Character | null {
    const x = this.byId.get(id);
    return x && x.kind === 'character' ? (x.e as Character) : null;
  }

  /** The groups the server last sent for an entity, as decoded (before interpolation or prediction). */
  rawOf(id: number): RawGroups | undefined {
    return this.raw.get(id);
  }

  track(id: number): MotionTrack | undefined {
    return this.tracks.get(id);
  }

  /** Number of entities the mirror holds (the client's interest set). */
  get entityCount(): number {
    return this.byId.size;
  }

  /** The character this screen follows: its own player's, or while watching the controlling player's. */
  get localCharacter(): Character | null {
    return this.me.character === this.placeholder ? null : this.me.character;
  }

  /** Server character id of the local player's own slot (0 while watching). */
  get ownCharacterId(): number {
    if (this.slot < 0) return 0;
    return this.roster.find((r) => r.playerId === this.playerId)?.characterId ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Messages

  applyWelcome(w: WelcomeMsg): void {
    this.playerId = w.playerId;
    this.slot = w.slot;
    this.roomId = w.roomId;
    this.roomSeed = w.roomSeed;
    this.tickRate = w.tickRate || this.tickRate;
    this.snapshotRate = w.snapshotRate || this.snapshotRate;
    this.playersById.clear();
    this.playersById.set(w.playerId, this.me);
    this.me.id = w.playerId;
    this.me.tag = { playerId: w.playerId };
    this.markBroken(w.brokenProps, true);
    this.applyHolds(w.signalHolds);
    for (const u of w.pickups) this.applyPickup(u);
  }

  /** The tick of the snapshot that follows one at `tick` (the server spreads snapshots evenly over its ticks). */
  nextSnapshotTick(tick: number): number {
    const r = this.snapshotRate / this.tickRate;
    let t = tick + 1;
    while (Math.floor(t * r) <= Math.floor((t - 1) * r) && t < tick + this.tickRate) t++;
    return t;
  }

  applySnapshot(s: SnapshotMsg, nowMs: number): ApplyResult {
    const res: ApplyResult = { stale: false, gap: false, missing: 0 };
    if (s.tick <= this.tick) {
      this.stats.stale++;
      res.stale = true;
      return res;
    }
    if (this.tick >= 0 && !s.full && s.tick > this.nextSnapshotTick(this.tick)) {
      res.gap = true;
      this.stats.gaps++;
    }
    const knownUntil = this.tick;
    this.stats.snapshots++;
    // A full snapshot after a resync lists everything the client should have; the first one after the welcome leaves
    // out the pickups the welcome brought.
    const present = s.full && this.tick >= 0 ? new Set<number>() : null;

    this.hud = s.hud;
    if (s.job) this.jobHud = s.job;
    if (s.roster) this.roster = s.roster;
    if (s.weather) Object.assign(this.weather.state, s.weather, { wind: { ...s.weather.wind } });
    if (s.signalHolds) this.applyHolds(s.signalHolds);
    this.markBroken(s.brokenProps, false);
    for (const id of s.removed) this.remove(id);

    // Build what is new first, so seat references between vehicles and characters resolve in either order.
    for (const u of s.vehicles) {
      present?.add(u.id);
      if (!this.byId.has(u.id) && !this.createVehicle(u)) res.missing++;
    }
    for (const u of s.characters) {
      present?.add(u.id);
      if (!this.byId.has(u.id) && !this.createCharacter(u)) res.missing++;
    }
    for (const u of s.vehicles) {
      const v = this.vehicle(u.id);
      if (!v) continue;
      this.store(u.id, 'vehicle', u);
      applyVehicleUpdate(v, u, (id) => this.character(id));
      if (u.motion) this.trackOf(u.id).push(vehicleSample(s.tick, u), knownUntil);
    }
    for (const u of s.characters) {
      const c = this.character(u.id);
      if (!c) continue;
      this.store(u.id, 'character', u);
      applyCharacterUpdate(c, u, (id) => this.vehicle(id));
      if (u.status) this.seatLinks(c);
      if (u.motion) this.trackOf(u.id).push(characterSample(s.tick, u), knownUntil);
    }
    for (const u of s.projectiles) {
      present?.add(u.id);
      if (!this.applyProjectile(u, s.tick, knownUntil)) res.missing++;
    }
    for (const u of s.helis) {
      present?.add(u.id);
      if (!this.applyHeli(u, s.tick, knownUntil)) res.missing++;
    }
    for (const u of s.pickups) {
      present?.add(u.id);
      if (!this.applyPickup(u)) res.missing++;
    }
    if (present) for (const id of [...this.byId.keys()]) if (!present.has(id)) this.remove(id);

    this.stats.missing += res.missing;
    this.tick = s.tick;
    this.ackSeq = s.ackSeq;
    this.snapTime = s.time;
    this.clock.day = s.clock.day;
    this.clock.hours = s.clock.hours;
    this.clock.rate = s.clock.rate;
    this.renderClock.onSnapshot(s.tick, nowMs);
    this.syncPlayers();
    return res;
  }

  /** Queues an event message: world events play on the render timeline, the local player's at once. */
  queueEvents(m: EventMsg): void {
    const mine = this.localCharacter;
    for (const ev of m.events) {
      const payload = this.resolveEvent(ev);
      if (!payload) {
        this.stats.eventsDropped++;
        continue;
      }
      const aboutMe = ev.playerId !== 0 || (mine !== null && Object.values(payload).some((v) => v === mine || (v instanceof Vehicle && v.driver === mine)));
      if (aboutMe) this.emit(ev.type, payload);
      else this.queued.push({ tick: m.tick - EVENT_LEAD_TICKS, type: ev.type, payload });
    }
  }

  /**
   * Breaks every prop the server reports broken in the world again and re-emits a propBroken for each: for a world reset
   * and a renderer attached after the welcome (whose listeners missed the first ones).
   */
  replayBroken(): void {
    for (const i of this.broken) {
      this.breakLocal(i);
      (this.events.emit as (t: string, p: unknown) => void)('propBroken', { index: i, dirX: 0, dirZ: 0 });
    }
    this.pendingBroken.length = 0;
  }

  /** Re-emits every queued event now (tests; leaving a session). */
  flushEvents(): void {
    for (const q of this.queued.splice(0)) this.emit(q.type, q.payload);
  }

  // ---------------------------------------------------------------------------
  // Per frame

  /** Advances the render timeline by `dt` s at local time `nowMs`: interpolates remote entities, plays due events. */
  update(dt: number, nowMs: number): void {
    this.frame++;
    for (const i of this.pendingBroken.splice(0)) this.emit('propBroken', { index: i, dirX: 0, dirZ: 0 });
    const rt = this.renderClock.advance(dt, nowMs);
    this.clock.update(dt);
    for (const p of this.players) if (p.deathKind) p.deathTimer += dt;
    // The server respawns 4.8 s after a death; a respawn event that never came (lost on a lossy link) must not leave
    // the screen on WASTED or BUSTED once the player is up again.
    const mine = this.localCharacter;
    if (this.me.deathKind && this.me.deathTimer > RESPAWN_FALLBACK && mine && mine.state !== 'dead') {
      this.me.deathKind = null;
      this.me.deathTimer = -1;
    }
    if (Number.isNaN(rt)) return;
    this.time = Math.max(this.time, this.timeAt(rt));
    const s = this.scratch;
    for (const v of this.vehicles) {
      if (this.locallyDriven.has(v.id)) continue;
      const tr = this.tracks.get(v.id);
      if (!tr || tr.samples.length === 0) continue;
      tr.sample(rt, s);
      v.pos.x = s.x; v.pos.y = s.y; v.pos.z = s.z;
      v.vel.x = s.vx; v.vel.z = s.vz; v.vy = s.vy;
      v.heading = s.heading; v.pitch = s.pitch; v.roll = s.roll;
      v.steer = s.steer; v.angVel = s.angVel;
      v.speed = Math.hypot(s.vx, s.vz);
      v.forwardSpeed = s.vx * Math.sin(s.heading) + s.vz * Math.cos(s.heading);
    }
    for (const c of this.characters) {
      if (this.locallyDriven.has(c.id)) continue;
      if (c.vehicle && c.state === 'inVehicle') {
        placeOccupant(c, c.vehicle);
        continue;
      }
      const tr = this.tracks.get(c.id);
      if (tr && tr.samples.length > 0) {
        tr.sample(rt, s);
        c.pos.x = s.x; c.pos.y = s.y; c.pos.z = s.z;
        c.vel.x = s.vx; c.vel.y = s.vy; c.vel.z = s.vz;
        c.heading = s.heading;
        c.speed = Math.hypot(s.vx, s.vz);
      }
      if (c.state === 'entering') c.animPhase += dt * 8;
      else if (c.state === 'normal' || c.state === 'swimming') c.animPhase += gaitPhaseStep(c.speed, dt);
    }
    for (const p of this.projectiles) {
      const tr = this.tracks.get(p.id);
      if (!tr) continue;
      tr.sample(rt, s);
      p.pos.x = s.x; p.pos.y = s.y; p.pos.z = s.z;
    }
    for (const h of this.helis) {
      const tr = this.tracks.get(h.id);
      if (tr) {
        tr.sample(rt, s);
        h.pos.x = s.x; h.pos.y = s.y; h.pos.z = s.z;
        h.vel.x = s.vx; h.vel.y = s.vy; h.vel.z = s.vz;
        h.heading = s.heading;
      }
      h.rotor += dt * (h.crashing ? 18 : 32);
    }
    if (this.queued.length > 0) {
      let n = 0;
      while (n < this.queued.length && this.queued[n]!.tick <= rt) n++;
      for (const q of this.queued.splice(0, n)) this.emit(q.type, q.payload);
    }
  }

  /** Server sim time at a (fractional) server tick. */
  timeAt(tick: number): number {
    return this.snapTime + (tick - this.tick) / this.tickRate;
  }

  // ---------------------------------------------------------------------------
  // Internals

  private emit(type: string, payload: Record<string, unknown>): void {
    this.stats.events++;
    if (type === 'propBroken') {
      const i = payload.index as number;
      if (this.broken.has(i) && !this.pendingBroken.includes(i)) return;
      const k = this.pendingBroken.indexOf(i);
      if (k >= 0) this.pendingBroken.splice(k, 1);
      this.breakLocal(i);
    }
    if (payload.playerId === this.playerId && this.playerId !== 0) {
      if (type === 'wasted' || type === 'busted') {
        this.me.deathKind = type;
        this.me.deathTimer = 0;
      } else if (type === 'respawn') {
        this.me.deathKind = null;
        this.me.deathTimer = -1;
      } else if (type === 'wanted') {
        this.me.wanted.level = payload.level as number;
      }
    }
    (this.events.emit as (t: string, p: unknown) => void)(type, payload);
  }

  private resolveEvent(ev: NetEvent): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ev.data)) {
      if (isRef(v)) out[k] = this.entity(v.$id) ?? null;
      else out[k] = v;
    }
    for (const k of REQUIRED_REFS[ev.type] ?? []) if (!out[k]) return null;
    if (ev.playerId !== 0) out.playerId = ev.playerId;
    return out;
  }

  private markBroken(indices: readonly number[], immediate: boolean): void {
    for (const i of indices) {
      if (this.broken.has(i)) continue;
      this.breakLocal(i);
      if (immediate) this.emit('propBroken', { index: i, dirX: 0, dirZ: 0 });
      else this.pendingBroken.push(i);
    }
  }

  private breakLocal(i: number): void {
    this.broken.add(i);
    const c = this.colliderOfProp.get(i);
    if (c) this.world.breakCollider(c);
  }

  private applyHolds(holds: ReadonlyArray<readonly [number, 'NS' | 'EW']>): void {
    this.roads.clearSignalHolds();
    for (const [node, axis] of holds) this.roads.holdSignal(node, axis);
  }

  private store(id: number, kind: Kind, u: { id: number }): void {
    let r = this.raw.get(id);
    if (!r) {
      r = { kind, groups: {} };
      this.raw.set(id, r);
    }
    for (const [k, v] of Object.entries(u)) if (k !== 'id' && v !== undefined) r.groups[k] = v;
  }

  private trackOf(id: number): MotionTrack {
    let t = this.tracks.get(id);
    if (!t) {
      t = new MotionTrack();
      this.tracks.set(id, t);
    }
    return t;
  }

  private add(kind: Kind, e: Entity): void {
    this.byId.set(e.id, { kind, e });
    if (kind === 'vehicle') this.vehicles.push(e as Vehicle);
    else if (kind === 'character') this.characters.push(e as Character);
    else if (kind === 'projectile') this.projectiles.push(e as Projectile);
    else if (kind === 'heli') this.helis.push(e as Helicopter);
    else this.pickups.push(e as Pickup);
  }

  private createVehicle(u: VehicleUpdate): boolean {
    if (!u.rare || !u.motion) return false;
    let kind = u.rare.kind as VehicleKind;
    if (!(kind in VEHICLE_SPECS)) {
      // Content this build does not know yet: drawn as the nearest thing it has rather than not at all.
      this.stats.unknownKinds++;
      kind = 'sedan';
    }
    const m = u.motion;
    const v = new Vehicle(u.id, kind, m.x, m.y, m.z, m.heading, u.rare.color);
    this.add('vehicle', v);
    return true;
  }

  private createCharacter(u: CharacterUpdate): boolean {
    if (!u.rare || !u.motion) return false;
    const m = u.motion;
    const c = new Character(u.id, u.rare.role, m.x, m.y, m.z, { ...u.rare.appearance } as Appearance);
    this.add('character', c);
    return true;
  }

  /** After a status update: the character's seat agrees with his vehicle's (its own status may not have been resent). */
  private seatLinks(c: Character): void {
    for (const v of this.vehicles) {
      if (v === c.vehicle) continue;
      if (v.driver === c) v.driver = null;
      for (let i = 0; i < v.passengers.length; i++) if (v.passengers[i] === c) v.passengers[i] = null;
    }
    const v = c.vehicle;
    if (!v || c.state !== 'inVehicle') return;
    if (c.seat === 0) v.driver = c;
    else if (c.seat - 1 < v.passengers.length) v.passengers[c.seat - 1] = c;
  }

  private applyProjectile(u: ProjectileUpdate, tick: number, knownUntil: number): boolean {
    let p = this.byId.get(u.id)?.e as Projectile | undefined;
    const st = u.state;
    if (!p) {
      if (!st) return false;
      p = new Projectile(u.id, { x: st.x, y: st.y, z: st.z }, { x: st.vx, y: st.vy, z: st.vz }, st.owner ? this.character(st.owner) : null);
      this.add('projectile', p);
    }
    if (!st) return true;
    this.store(u.id, 'projectile', u);
    p.pos.x = st.x; p.pos.y = st.y; p.pos.z = st.z;
    p.vel.x = st.vx; p.vel.y = st.vy; p.vel.z = st.vz;
    this.trackOf(u.id).push({ ...emptySample(tick), x: st.x, y: st.y, z: st.z, vx: st.vx, vy: st.vy, vz: st.vz }, knownUntil);
    return true;
  }

  private applyHeli(u: HeliUpdate, tick: number, knownUntil: number): boolean {
    let h = this.byId.get(u.id)?.e as Helicopter | undefined;
    const st = u.state;
    if (!h) {
      if (!st) return false;
      h = new Helicopter(u.id, st.x, st.y, st.z);
      h.rotor = st.rotor;
      this.add('heli', h);
    }
    if (!st) return true;
    this.store(u.id, 'heli', u);
    h.pos.x = st.x; h.pos.y = st.y; h.pos.z = st.z;
    h.vel.x = st.vx; h.vel.y = st.vy; h.vel.z = st.vz;
    h.heading = st.heading;
    h.health = st.health;
    h.destroyed = st.destroyed;
    h.crashing = st.crashing;
    h.spotlight.x = st.spotX;
    h.spotlight.z = st.spotZ;
    this.trackOf(u.id).push({ ...emptySample(tick), x: st.x, y: st.y, z: st.z, vx: st.vx, vy: st.vy, vz: st.vz, heading: st.heading }, knownUntil);
    return true;
  }

  private applyPickup(u: PickupUpdate): boolean {
    let p = this.byId.get(u.id)?.e as Pickup | undefined;
    const st = u.state;
    if (!p) {
      if (!st) return false;
      p = new Pickup(u.id, st.kind, { x: st.x, y: st.y, z: st.z }, st.amount, st.weapon, 0, st.tag);
      this.add('pickup', p);
    }
    if (!st) return true;
    this.store(u.id, 'pickup', u);
    p.pos.x = st.x; p.pos.y = st.y; p.pos.z = st.z;
    p.amount = st.amount;
    p.weapon = st.weapon;
    p.active = st.active;
    return true;
  }

  private remove(id: number): void {
    const x = this.byId.get(id);
    if (!x) return;
    this.byId.delete(id);
    this.raw.delete(id);
    this.tracks.delete(id);
    x.e.removed = true;
    const list: Entity[] = x.kind === 'vehicle' ? this.vehicles : x.kind === 'character' ? this.characters : x.kind === 'projectile' ? this.projectiles : x.kind === 'heli' ? this.helis : this.pickups;
    const i = list.indexOf(x.e);
    if (i >= 0) list.splice(i, 1);
    if (x.kind === 'character') {
      const c = x.e as Character;
      for (const v of this.vehicles) {
        if (v.driver === c) v.driver = null;
        for (let k = 0; k < v.passengers.length; k++) if (v.passengers[k] === c) v.passengers[k] = null;
      }
    } else if (x.kind === 'vehicle') {
      for (const c of this.characters) if (c.vehicle === x.e) {
        c.vehicle = null;
        if (c.state === 'inVehicle') c.state = 'normal';
      }
    }
  }

  /** Rebuilds the player list from the roster: one view per player with a slot, and the local one always. */
  private syncPlayers(): void {
    const seen = new Set<number>();
    this.players.length = 0;
    const controller = this.roster.find((r) => r.slot === 0);
    for (const r of this.roster) {
      seen.add(r.playerId);
      let p = this.playersById.get(r.playerId);
      if (!p) {
        p = new NetPlayer(r.playerId, this.placeholder);
        this.playersById.set(r.playerId, p);
      }
      p.name = r.name;
      p.slot = r.slot;
      // A watcher follows the player in slot 0, as the server's interest for it does.
      const charId = r.slot >= 0 ? r.characterId : r.playerId === this.playerId ? controller?.characterId ?? 0 : 0;
      p.character = this.character(charId) ?? this.placeholder;
      if (r.playerId === this.playerId) this.slot = r.slot;
      if (r.slot >= 0 || r.playerId === this.playerId) this.players.push(p);
    }
    if (!this.players.includes(this.me)) this.players.push(this.me);
    for (const id of [...this.playersById.keys()]) if (!seen.has(id) && id !== this.playerId) this.playersById.delete(id);
    const me = this.me;
    me.progress.money = this.hud.money;
    if (me.wanted.level === 0 && this.hud.wanted > 0) {
      const at = me.pos();
      me.wanted.lastSeenX = at.x;
      me.wanted.lastSeenZ = at.z;
    }
    if (this.hud.searching && !me.wanted.searching) {
      const at = me.pos();
      me.wanted.lastSeenX = at.x;
      me.wanted.lastSeenZ = at.z;
    }
    me.wanted.level = this.hud.wanted;
    me.wanted.searching = this.hud.searching;
    // The rounds of the gun in his hand (snapshots carry no inventories, only the weapon held).
    const c = this.localCharacter;
    if (c && this.slot >= 0 && c.inventory.current !== 'fists') {
      const w = c.inventory.slots.get(c.inventory.current);
      if (w) {
        w.clip = this.hud.clip;
        w.ammo = this.hud.ammo;
      } else c.inventory.slots.set(c.inventory.current, { clip: this.hud.clip, ammo: this.hud.ammo, readyAt: 0 });
    }
  }
}

const PLACEHOLDER_LOOK: Appearance = { skin: 0x8d5524, shirt: 0x2b2b2b, pants: 0x202020, hair: 0x111111, hat: 0, height: 1, build: 1 };

function vehicleSample(tick: number, u: VehicleUpdate): MotionSample {
  const m = u.motion!;
  return { tick, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz, heading: m.heading, pitch: m.pitch, roll: m.roll, steer: m.steer, angVel: m.angVel };
}

function characterSample(tick: number, u: CharacterUpdate): MotionSample {
  const m = u.motion!;
  return { tick, x: m.x, y: m.y, z: m.z, vx: m.vx, vy: m.vy, vz: m.vz, heading: m.heading, pitch: 0, roll: 0, steer: 0, angVel: 0 };
}

/** Where a seated character sits in his vehicle (as Sim.syncOccupant places him). */
export function placeOccupant(c: Character, v: Vehicle): void {
  const side = c.seat === 0 || c.seat === 2 ? 1 : -1;
  const back = c.seat >= 2 ? -0.9 : 0.15;
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  const sx = Math.cos(v.heading);
  const sz = -Math.sin(v.heading);
  c.pos.x = v.pos.x + sx * side * v.halfW * 0.45 + fx * back;
  c.pos.z = v.pos.z + sz * side * v.halfW * 0.45 + fz * back;
  c.pos.y = v.pos.y + 0.25;
  c.heading = v.heading;
}
