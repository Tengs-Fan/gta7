// Police roadblocks and spike strips (3 stars and up): two cruisers parked across the road ahead of the player on the
// way he is driving, out of his sight, their officers posted beside them, and a spike strip across the road short of
// them that bursts the tyres that cross it. Removed once well behind him, and all cleared when the stars drop below 3.
// Runs only while sim.streetCrime.roadblocks is on, from its own random generator.

import { circleVsObb, makeContact, type OBB } from '../core/collision';
import { Rng } from '../core/rng';
import { LANE_W } from '../world/constants';
import type { Lane } from '../world/roads';
import { DriverAI } from './driver';
import type { Character, Vehicle } from './entities';
import type { PlayerSlot } from './playerSlot';
import type { Sim } from './sim';
import type { SimSystem } from './systems';
import { vehicleObb } from './vehiclePhysics';

/** From this many stars. */
export const ROADBLOCK_LEVEL = 3;
/** Placed this far ahead (m) along the player's way, never nearer than ROADBLOCK_MIN_AHEAD. */
export const ROADBLOCK_AHEAD_MIN = 110;
// Down a straight road in plain view the first spot out of his sight lies past the sight range (Sim.isVisible, 320 m).
export const ROADBLOCK_AHEAD_MAX = 340;
export const ROADBLOCK_MIN_AHEAD = 80;
/** Removed once behind the player and this far (m) from him. */
export const ROADBLOCK_REMOVE_BEHIND = 250;
/** First try this long (s) after the stars reach 3, then every ROADBLOCK_RETRY s while none stands; the next one waits ROADBLOCK_GAP s. */
const ROADBLOCK_FIRST = 4;
const ROADBLOCK_RETRY = 1.5;
const ROADBLOCK_GAP = 60;
/** The strip lies this far (m) short of the cruisers, across the whole road, ROADBLOCK_STRIP_DEPTH m deep. */
export const STRIP_SHORT = 16;
export const STRIP_DEPTH = 0.9;
/** A strip is picked up after this long (s) even if its roadblock still stands. */
export const STRIP_LIFE = 90;
/** Posted officers stay at the cruisers until the player comes this close (m), or for at most POST_MAX s. */
const POST_RANGE = 55;
const POST_MAX = 45;
/** The opening a roadblock leaves on the player's lane (m), and half a cruiser's length. */
export const LANE_OPENING = 4;
const CRUISER_HALF_LENGTH = 2.45;
/** The player counts as through a roadblock this far (m) past its cruisers along the road. */
const PASSED = 30;
const PASSED_FAR = 90;
/** A cruiser holding up a police unit this long (s) drives off to make way. */
const MAKE_WAY = 2.5;

export interface SpikeStrip {
  id: number;
  /** Centre, the unit along the road (the way traffic crosses it) and the half-length across the road. */
  x: number;
  y: number;
  z: number;
  ux: number;
  uz: number;
  halfLen: number;
  createdAt: number;
  removed: boolean;
  /** Tyres it burst. */
  bursts: number;
  /** The player slot whose roadblock laid it (absent: slot 0). */
  slot?: number;
}

/** Each player's roadblock timing: every wanted player gets his own roadblocks. */
interface SlotState {
  timer: number;
  lastPlaced: number;
  wasLevel: number;
}

export interface Roadblock {
  id: number;
  x: number;
  z: number;
  /** Unit along the road towards the player's side (the way he comes from). */
  ux: number;
  uz: number;
  cars: Vehicle[];
  officers: Character[];
  strip: SpikeStrip | null;
  createdAt: number;
  level: number;
  /** Route distance ahead of the player (m) and whether it was in his view when placed (never, see place). */
  ahead: number;
  visibleAtSpawn: boolean;
  removedAt: number;
  /** Seconds it has been behind the player without a break, and holding up a police unit. */
  behindFor: number;
  blockedFor: number;
  /** The player slot it was placed for. */
  slot: number;
}

const contact = makeContact();
const obb: OBB = { x: 0, z: 0, hw: 0, hl: 0, h: 0 };

export class RoadblockSystem implements SimSystem {
  readonly id = 'roadblocks';
  readonly slot = 'afterPhysics' as const;
  readonly roadblocks: Roadblock[] = [];
  readonly strips: SpikeStrip[] = [];
  /** Every roadblock placed (also the removed ones), for tests and telemetry. */
  readonly log: Roadblock[] = [];
  private readonly rng: Rng;
  private ids = 0;
  /** Timing by slot id, and the player (and timing) the code below works for: the one updating, else slot 0. */
  private readonly states = new Map<number, SlotState>();
  private cur: PlayerSlot;
  private st: SlotState = { timer: ROADBLOCK_FIRST, lastPlaced: -Infinity, wasLevel: 0 };
  /** Cruisers parked in a roadblock (see isParked). */
  private readonly parked = new WeakSet<Vehicle>();
  /** Last wheel positions per vehicle, for strips crossed between two frames. */
  private readonly wheels = new WeakMap<Vehicle, Float64Array>();
  /** Officers that wait at their cruisers, and until when. */
  private readonly posted = new Map<Character, number>();

  constructor(private readonly sim: Sim) {
    this.rng = new Rng(((sim.seed * 3266489917) ^ 0x726f6164) >>> 0);
    this.cur = sim.players[0]!;
    this.states.set(0, this.st);
  }

  private get timer(): number { return this.st.timer; }
  private set timer(v: number) { this.st.timer = v; }
  private get lastPlaced(): number { return this.st.lastPlaced; }
  private set lastPlaced(v: number) { this.st.lastPlaced = v; }
  private get wasLevel(): number { return this.st.wasLevel; }
  private set wasLevel(v: number) { this.st.wasLevel = v; }

  /** Works for player `slot` until the next call. */
  private use(slot: PlayerSlot): void {
    this.cur = slot;
    let st = this.states.get(slot.id);
    if (!st) {
      st = { timer: ROADBLOCK_FIRST, lastPlaced: -Infinity, wasLevel: 0 };
      this.states.set(slot.id, st);
    }
    this.st = st;
  }

  /** The current player's standing roadblocks. */
  private mine(): Roadblock[] {
    const id = this.cur.id;
    return this.sim.players.length > 1 ? this.roadblocks.filter((rb) => rb.slot === id) : this.roadblocks;
  }

  /** A cruiser parked across the road in a roadblock that still stands. */
  isParked(v: Vehicle): boolean {
    return this.parked.has(v);
  }

  /** Is this officer posted at a roadblock (waiting there, not after the player yet)? */
  isPosted(c: Character): boolean {
    return this.posted.has(c);
  }

  /**
   * An officer of a roadblock that still stands. Its cruisers (isParked) and officers stay until the roadblock itself is
   * taken down (remove), never by the police's generic distance cleanup: it stands up to 340 m ahead, out of sight.
   */
  holds(c: Character): boolean {
    for (const rb of this.roadblocks) if (rb.removedAt < 0 && rb.officers.includes(c)) return true;
    return false;
  }

  reset(): void {
    this.roadblocks.length = 0;
    this.strips.length = 0;
    this.posted.clear();
    for (const st of this.states.values()) {
      st.timer = ROADBLOCK_FIRST;
      st.lastPlaced = -Infinity;
    }
  }

  /** Every wanted player gets his own roadblocks, in slot order. */
  update(sim: Sim, dt: number): void {
    this.checkStrips();
    this.releaseOfficers();
    for (const slot of sim.activePlayers()) {
      this.use(slot);
      this.updateFor(sim, dt);
    }
    this.use(sim.players[0]!);
  }

  private updateFor(sim: Sim, dt: number): void {
    const on = sim.streetCrime.roadblocks && sim.policeEnabled;
    const slot = this.cur;
    const level = !on || slot.down ? 0 : slot.wanted.level;
    const multi = sim.players.length > 1;
    if (level < ROADBLOCK_LEVEL) {
      if (this.mine().length > 0 || this.strips.some((s) => !s.removed && (!multi || (s.slot ?? 0) === slot.id))) this.clearAll();
      this.wasLevel = level;
      return;
    }
    if (this.wasLevel < ROADBLOCK_LEVEL) this.timer = ROADBLOCK_FIRST;
    this.wasLevel = level;
    this.removeBehind(dt);
    this.dropEmpty();
    this.makeWay(dt);
    for (const s of this.strips) if (!s.removed && sim.time - s.createdAt > STRIP_LIFE) s.removed = true;
    this.compact();
    if (this.mine().length >= 1 || sim.time - this.lastPlaced < ROADBLOCK_GAP) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = ROADBLOCK_RETRY;
    this.place(level);
  }

  /**
   * The way the player is driving: his lane, then straight on through the junctions (or the one turn there is), as
   * (lane, s, distance ahead) samples every 10 m from ROADBLOCK_AHEAD_MIN to ROADBLOCK_AHEAD_MAX m.
   */
  private route(): Array<{ lane: Lane; s: number; ahead: number }> {
    const sim = this.sim;
    const pv = this.cur.character.vehicle;
    if (!pv) return [];
    const start = sim.roads.nearestLane(pv.pos.x, pv.pos.z, pv.heading);
    if (start.dist > 8) return [];
    const out: Array<{ lane: Lane; s: number; ahead: number }> = [];
    let lane: Lane | null = start.lane;
    let s = start.s;
    let ahead = 0;
    let next = ROADBLOCK_AHEAD_MIN;
    for (let hops = 0; lane && hops < 8 && next <= ROADBLOCK_AHEAD_MAX; ) {
      // A county road's bends are no junctions: they do not count.
      if (!sim.roads.isBend(sim.roads.nodes[lane.to]!)) hops++;
      while (next <= ROADBLOCK_AHEAD_MAX && next - ahead <= lane.length - s) {
        out.push({ lane, s: s + (next - ahead), ahead: next });
        next += 10;
      }
      ahead += lane.length - s;
      s = 0;
      const turns: Lane['turns'] = lane.turns;
      lane = (turns.find((t) => t.kind === 'straight') ?? (turns.length === 1 ? turns[0] : undefined))?.to ?? null;
    }
    return out;
  }

  /**
   * Places a roadblock on the player's way: mid-block (16 m clear of either junction), at least ROADBLOCK_MIN_AHEAD m
   * from him and out of his view, the two cruisers clear of buildings, other vehicles and him. Returns it, or null.
   */
  place(level = this.cur.wanted.level): Roadblock | null {
    const sim = this.sim;
    const pp = this.cur.pos();
    const slotId = this.cur.id;
    const spots = this.route();
    // Nearer spots first, a little shuffled so they do not always stand at the same distance.
    const order = spots.map((sp, i) => ({ sp, k: i + this.rng.range(0, 3) })).sort((a, b) => a.k - b.k);
    for (const { sp } of order) {
      const { lane } = sp;
      if (sp.s < 16 || sp.s > lane.length - 16) continue;
      const lx = lane.sx + lane.dx * sp.s;
      const lz = lane.sz + lane.dz * sp.s;
      if (Math.hypot(lx - pp.x, lz - pp.z) < ROADBLOCK_MIN_AHEAD) continue;
      // The road's centre line through this point (a county lane's, its own offset back to its left), and the way across it.
      const along = Math.abs(lane.dx) > 0.5;
      const off = LANE_W * (lane.index + 0.5);
      const outer = lane.line.index < 0;
      const cx = outer ? lx + lane.dz * off : along ? lx : lane.line.pos;
      const cz = outer ? lz - lane.dx * off : along ? lane.line.pos : lz;
      if (sim.isVisible(cx, 1, cz)) continue;
      // Across the road, positive towards the curb of the player's side. The cruisers block the road but for an opening
      // the width of his lane, where it runs on through the roadblock; the spike strip covers that too.
      let ax = -lane.dz;
      let az = lane.dx;
      const laneOff = (lx - cx) * ax + (lz - cz) * az;
      if (laneOff < 0) {
        ax = -ax;
        az = -az;
      }
      const half = lane.line.width / 2;
      const ux = -lane.dx;
      const uz = -lane.dz;
      const carSpots = cruiserLayout(half, Math.abs(laneOff)).map((c) => ({ x: cx + ax * c.off - ux * c.back, z: cz + az * c.off - uz * c.back, heading: c.cross ? lane.heading + Math.PI / 2 : lane.heading }));
      const heads = carSpots.map((c) => c.heading);
      if (!carSpots.every((c) => sim.traffic.isClear(c.x, c.z, 6.5) && Math.hypot(c.x - pp.x, c.z - pp.z) > 30 && this.bodyClear(c.x, c.z, c.heading))) continue;
      // Nor on top of another player.
      if (sim.players.length > 1 && carSpots.some((c) => sim.distToPlayer(c.x, c.z) <= 30)) continue;
      const rb: Roadblock = { id: ++this.ids, x: cx, z: cz, ux, uz, cars: [], officers: [], strip: null, createdAt: sim.time, level, ahead: sp.ahead, visibleAtSpawn: sim.isVisible(cx, 1, cz), removedAt: -1, behindFor: 0, blockedFor: 0, slot: slotId };
      carSpots.forEach((c, i) => {
        const v = sim.spawnVehicle(level >= 5 && i === 0 ? 'swat' : 'police', c.x, c.z, heads[i]!);
        v.owner = 'police';
        v.siren = true;
        this.parked.add(v);
        rb.cars.push(v);
        // His officer stands at the cruiser's end away from the player's side.
        const ox = c.x - rb.ux * 2.6;
        const oz = c.z - rb.uz * 2.6;
        const spot = sim.world.findFreeSpot(ox, oz, 0.4, 4) ?? { x: ox, z: oz };
        const o = sim.spawnCharacter(v.kind === 'swat' ? 'swat' : 'cop', spot.x, spot.z);
        sim.police.equipOfficer(o, null, slotId);
        if (slotId !== 0) sim.police.assign(v, slotId);
        o.heading = Math.atan2(rb.ux, rb.uz);
        rb.officers.push(o);
        this.posted.set(o, sim.time + POST_MAX);
      });
      // The strip across the whole road, STRIP_SHORT m on the player's side of the cruisers.
      const sx = cx + rb.ux * STRIP_SHORT;
      const sz = cz + rb.uz * STRIP_SHORT;
      const strip: SpikeStrip = { id: rb.id, x: sx, y: sim.world.groundHeight(sx, sz), z: sz, ux: rb.ux, uz: rb.uz, halfLen: half, createdAt: sim.time, removed: false, bursts: 0 };
      if (slotId !== 0) strip.slot = slotId;
      rb.strip = strip;
      this.strips.push(strip);
      this.roadblocks.push(rb);
      this.log.push(rb);
      this.lastPlaced = sim.time;
      sim.events.emit('roadblock', { x: cx, z: cz, strip: true });
      return rb;
    }
    return null;
  }

  /** Room for a cruiser's body at (x, z) facing `heading`: no building, wall or prop under it. */
  private bodyClear(x: number, z: number, heading: number): boolean {
    const w = this.sim.world;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    for (const k of [-2.1, -1, 0, 1, 2.1]) if (!w.isFree(x + fx * k, z + fz * k, 1)) return false;
    return true;
  }

  /** Lets posted officers go after the player once he is near, or once they have waited long enough. */
  private releaseOfficers(): void {
    const sim = this.sim;
    const pp = sim.playerPos();
    const multi = sim.players.length > 1;
    for (const [o, until] of this.posted) {
      // His own player, the one his roadblock was placed for.
      const op = multi ? sim.playerPos(sim.police.targetSlotOf(o)) : pp;
      if (o.removed || !o.alive || sim.time > until || Math.hypot(o.pos.x - op.x, o.pos.z - op.z) < POST_RANGE) this.posted.delete(o);
    }
  }

  private removeBehind(dt: number): void {
    const sim = this.sim;
    const p = this.cur.character;
    const pp = this.cur.pos();
    const vx = p.vehicle ? p.vehicle.vel.x : p.vel.x;
    const vz = p.vehicle ? p.vehicle.vel.z : p.vel.z;
    const sp = Math.hypot(vx, vz);
    const hx = sp > 1 ? vx / sp : Math.sin(p.vehicle?.heading ?? p.heading);
    const hz = sp > 1 ? vz / sp : Math.cos(p.vehicle?.heading ?? p.heading);
    for (const rb of this.mine()) {
      const dx = rb.x - pp.x;
      const dz = rb.z - pp.z;
      const d = Math.hypot(dx, dz);
      // Behind him for a moment, not just while a crash spins his car round.
      if (dx * hx + dz * hz < 0) rb.behindFor += dt;
      else rb.behindFor = 0;
      if ((rb.behindFor > 2 && d > ROADBLOCK_REMOVE_BEHIND) || d > 400) {
        this.remove(rb);
        continue;
      }
      // Once he is through (past the cruisers along the road), the strip is pulled in and the cruisers are taken off the
      // road where he cannot see it, so the units on his tail do not pile up behind them.
      const past = (pp.x - rb.x) * -rb.ux + (pp.z - rb.z) * -rb.uz;
      if (past > PASSED) {
        if (rb.strip && !rb.strip.removed) rb.strip.removed = true;
        for (const o of rb.officers) this.posted.delete(o);
        // Well past it, it goes even in his mirror: his chasers come through it.
        for (const v of rb.cars) {
          if (v.removed || v.driver || (past < PASSED_FAR && sim.isVisible(v.pos.x, v.pos.y, v.pos.z))) continue;
          this.parked.delete(v);
          sim.removeVehicle(v);
        }
      }
    }
  }

  /** A roadblock whose cruisers and officers are all gone (removed some other way, or dead) no longer stands. */
  private dropEmpty(): void {
    for (const rb of this.roadblocks) {
      if (rb.removedAt < 0 && rb.cars.every((v) => v.removed) && rb.officers.every((o) => o.removed || !o.alive)) this.remove(rb);
    }
  }

  /**
   * A cruiser of the roadblock holding up one of their own pursuit units (held up behind it for MAKE_WAY s) is driven
   * off by its officer to join the chase, and the roadblock is down: the units coming through are never stuck behind it.
   */
  private makeWay(dt: number): void {
    const sim = this.sim;
    const blocking = new Set<Vehicle>();
    for (const v of sim.vehicles) {
      if (v.removed || v.owner !== 'police' || !v.driver?.isLaw || !v.ai || this.parked.has(v)) continue;
      const b = v.ai.heldUpBy;
      if (b && this.parked.has(b)) blocking.add(b);
    }
    for (const rb of this.mine()) {
      if (rb.cars.some((c) => blocking.has(c))) rb.blockedFor += dt;
      else rb.blockedFor = 0;
      if (rb.blockedFor < MAKE_WAY) continue;
      rb.blockedFor = 0;
      if (rb.strip) rb.strip.removed = true;
      rb.cars.forEach((v, i) => this.driveOff(v, rb.officers[i] ?? null, rb.slot));
    }
  }

  /** The officer posted at a cruiser takes its wheel (he stands beside it) and chases the player in it. */
  private driveOff(v: Vehicle, o: Character | null, slotId = 0): void {
    const sim = this.sim;
    this.parked.delete(v);
    if (o) this.posted.delete(o);
    if (v.removed || v.destroyed || v.driver) return;
    // Only while the pursuit it joins has fewer units than its stars send (PoliceSystem.hasRoom); else it goes unseen.
    if (!sim.police.hasRoom(slotId) || !o || o.removed || !o.alive || o.state !== 'normal' || Math.hypot(o.pos.x - v.pos.x, o.pos.z - v.pos.z) > 8) {
      if (!sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) sim.removeVehicle(v);
      return;
    }
    sim.seat(o, v, 0);
    if (o.brain) o.brain.car = v;
    v.ai = new DriverAI(sim, v, 'chase');
    v.ai.target = sim.players.find((s) => s.id === slotId)?.character ?? sim.player;
    v.siren = true;
    if (slotId !== 0) sim.police.assign(v, slotId);
  }

  /** Takes a roadblock down: its strip at once; its cruisers and officers too, where the player cannot see them go. */
  private remove(rb: Roadblock): void {
    const sim = this.sim;
    rb.removedAt = sim.time;
    if (rb.strip) rb.strip.removed = true;
    for (const v of rb.cars) {
      this.parked.delete(v);
      if (!v.removed && !v.driver && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) sim.removeVehicle(v);
    }
    for (const o of rb.officers) {
      this.posted.delete(o);
      if (!o.removed && o.state !== 'inVehicle' && !sim.isVisible(o.pos.x, o.pos.y, o.pos.z)) sim.removeCharacter(o);
    }
  }

  /** Takes down the current player's roadblocks and strips (all of them in single player). */
  private clearAll(): void {
    const multi = this.sim.players.length > 1;
    for (const rb of this.mine()) if (rb.removedAt < 0) this.remove(rb);
    for (const s of this.strips) if (!multi || (s.slot ?? 0) === this.cur.id) s.removed = true;
    this.compact();
  }

  private compact(): void {
    for (let i = this.roadblocks.length - 1; i >= 0; i--) if (this.roadblocks[i]!.removedAt >= 0) this.roadblocks.splice(i, 1);
    for (let i = this.strips.length - 1; i >= 0; i--) if (this.strips[i]!.removed) this.strips.splice(i, 1);
  }

  /** Bursts the tyres of every vehicle (but a strip's own roadblock cruisers) whose wheel crossed a strip since the last frame. */
  private checkStrips(): void {
    const sim = this.sim;
    const live = this.strips.filter((s) => !s.removed);
    for (const v of sim.vehicles) {
      if (v.removed) continue;
      const cur = wheelPoints(v);
      const prev = this.wheels.get(v);
      this.wheels.set(v, cur);
      if (!prev || live.length === 0 || v.airborne || v.inWater || this.parked.has(v)) continue;
      for (const s of live) {
        if (Math.abs(v.pos.x - s.x) > s.halfLen + 8 && Math.abs(v.pos.z - s.z) > s.halfLen + 8) continue;
        if (Math.hypot(v.pos.x - s.x, v.pos.z - s.z) > s.halfLen + 8) continue;
        for (let w = 0; w < 4; w++) {
          if (v.flat[w]) continue;
          if (crosses(s, prev[w * 2]!, prev[w * 2 + 1]!, cur[w * 2]!, cur[w * 2 + 1]!)) {
            v.flat[w] = true;
            s.bursts++;
            sim.events.emit('tyreBurst', { vehicle: v, wheel: w, x: cur[w * 2]!, y: v.pos.y, z: cur[w * 2 + 1]! });
          }
        }
      }
    }
  }

  /** Anything (a vehicle's body) overlapping a strip's rectangle right now, for tests. */
  stripUnder(v: Vehicle): SpikeStrip | null {
    vehicleObb(v, obb);
    for (const s of this.strips) if (!s.removed && circleVsObb(s.x, s.z, 0.5, obb, contact)) return s;
    return null;
  }
}

/** The four wheel contact points of `v` (x, z pairs): front left, front right, rear left, rear right. */
export function wheelPoints(v: Vehicle): Float64Array {
  const fx = Math.sin(v.heading);
  const fz = Math.cos(v.heading);
  // Left of the heading (see vehiclePhysics: right is (-fz, fx)).
  const lx = fz;
  const lz = -fx;
  const a = v.halfL * 0.62;
  const b = v.halfW * 0.85;
  const out = new Float64Array(8);
  const put = (i: number, f: number, l: number) => {
    out[i * 2] = v.pos.x + fx * a * f + lx * b * l;
    out[i * 2 + 1] = v.pos.z + fz * a * f + lz * b * l;
  };
  put(0, 1, 1);
  put(1, 1, -1);
  put(2, -1, 1);
  put(3, -1, -1);
  return out;
}

/** Did a wheel going from (ax, az) to (bx, bz) cross, or stand on, strip `s`? */
function crosses(s: SpikeStrip, ax: number, az: number, bx: number, bz: number): boolean {
  // Strip frame: along the road (u) and across it (w).
  const wx = -s.uz;
  const wz = s.ux;
  const ua = (ax - s.x) * s.ux + (az - s.z) * s.uz;
  const ub = (bx - s.x) * s.ux + (bz - s.z) * s.uz;
  const h = STRIP_DEPTH / 2;
  if ((ua > h && ub > h) || (ua < -h && ub < -h)) return false;
  // Where the path is within the strip's depth, across the road.
  const t = Math.abs(ub - ua) < 1e-9 ? 0.5 : Math.max(0, Math.min(1, (0 - ua) / (ub - ua)));
  const px = ax + (bx - ax) * t;
  const pz = az + (bz - az) * t;
  return Math.abs((px - s.x) * wx + (pz - s.z) * wz) <= s.halfLen;
}

/**
 * Where a roadblock's two cruisers stand on a road `half` m wide each side of its centre line, the player's lane centred
 * `laneOff` m to his side of it: `off` m across (positive to his curb), `back` m further along the road from him, and
 * whether parked across it. They block the road but for an opening LANE_OPENING m wide on his lane: across it on the
 * far side of the opening while there is room (two abreast, 5 m apart), else one across there and the other parked along
 * the road on his curb side of the opening or, without room there either, across behind the first.
 */
export function cruiserLayout(half: number, laneOff: number): Array<{ off: number; back: number; cross: boolean }> {
  const open0 = laneOff - LANE_OPENING / 2;
  const open1 = laneOff + LANE_OPENING / 2;
  const reach = CRUISER_HALF_LENGTH + 0.1;
  const out: Array<{ off: number; back: number; cross: boolean }> = [];
  // Across, from the opening's far edge out towards the far curb.
  for (let c = open0 - reach; c - reach >= -half - 0.3 && out.length < 2; c -= 2 * reach + 0.2) out.push({ off: c, back: 0, cross: true });
  if (out.length === 0) out.push({ off: Math.max(-half + reach, open0 - reach), back: 0, cross: true });
  if (out.length < 2) {
    if (half - open1 >= 2.2) out.push({ off: (open1 + half) / 2, back: 0, cross: false });
    else out.push({ off: out[0]!.off, back: 5.5, cross: true });
  }
  return out;
}
