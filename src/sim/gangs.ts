// Street gangs: who they are and how they look, where their turf lies (GANG_TURFS in world/layout.ts), how members in
// their turf answer an armed or hostile player, the gang cars cruising it, and the odd war between two gangs at the
// border of their turfs. Everything here runs only while sim.streetCrime.gangs is on, from its own random generator.

import { Rng } from '../core/rng';
import { GANG_TURFS, type CityLayout, type GangId, type GangTurf } from '../world/layout';
import type { Character, Vehicle } from './entities';
import type { Sim } from './sim';
import { isGun, type VehicleKind } from './specs';
import type { SimSystem } from './systems';

export interface GangSpec {
  id: GangId;
  name: string;
  /** Turf colour on the map (CSS hex). */
  mapColor: string;
  shirts: readonly number[];
  pants: number;
  hat: number;
  cars: readonly VehicleKind[];
  carColors: readonly number[];
}

export const GANGS: Readonly<Record<GangId, GangSpec>> = {
  tiburones: { id: 'tiburones', name: 'Los Tiburones', mapColor: '#14b8a6', shirts: [0x0e7c7b, 0x117864, 0x0b5345], pants: 0x1b1b1b, hat: 0x0e7c7b, cars: ['muscle', 'sedan'], carColors: [0x0e7c7b, 0x0b5345] },
  halcones: { id: 'halcones', name: 'Los Halcones', mapColor: '#d4a017', shirts: [0x7b1424, 0x8e1b2e, 0x5e0f1d], pants: 0xd9cfb8, hat: 0xc9a227, cars: ['pickup', 'sports'], carColors: [0x7b1424, 0xc9a227] },
};

export interface TurfZone {
  turf: GangTurf;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

const zoneCache = new WeakMap<CityLayout, TurfZone[]>();

/** Every gang turf as a world rectangle, out to the centre lines of the roads round its blocks. */
export function turfZones(layout: CityLayout): readonly TurfZone[] {
  let z = zoneCache.get(layout);
  if (!z) {
    z = GANG_TURFS.map((t) => ({ turf: t, minX: layout.vLines[t.minBi]!.pos, maxX: layout.vLines[t.maxBi + 1]!.pos, minZ: layout.hLines[t.minBj]!.pos, maxZ: layout.hLines[t.maxBj + 1]!.pos }));
    zoneCache.set(layout, z);
  }
  return z;
}

/** The turf (x, z) lies in, or null. */
export function turfAt(layout: CityLayout, x: number, z: number): GangTurf | null {
  for (const t of turfZones(layout)) if (x >= t.minX && x < t.maxX && z >= t.minZ && z < t.maxZ) return t.turf;
  return null;
}

/** The gang whose turf (x, z) lies in, or null. */
export function gangAt(layout: CityLayout, x: number, z: number): GangId | null {
  return turfAt(layout, x, z)?.gang ?? null;
}

/** Distance (m) from (x, z) to the nearest turf of `gang` (0 inside it). */
export function distToTurf(layout: CityLayout, gang: GangId, x: number, z: number): number {
  let best = Infinity;
  for (const t of turfZones(layout)) {
    if (t.turf.gang !== gang) continue;
    const dx = Math.max(t.minX - x, 0, x - t.maxX);
    const dz = Math.max(t.minZ - z, 0, z - t.maxZ);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

/** Makes `c` a member of `gang`, dressed in its colours (picked by his id: no random draw). */
export function setGang(c: Character, gang: GangId): void {
  const g = GANGS[gang];
  c.role = 'gang';
  c.gang = gang;
  const a = c.appearance;
  a.shirt = g.shirts[c.id % g.shirts.length]!;
  a.pants = g.pants;
  a.hat = c.id % 5 < 3 ? g.hat : 0;
}

/** Stretches where two gangs' turfs meet: the street between them, from (ax, az) to (bx, bz). */
export interface Border {
  a: GangId;
  b: GangId;
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export function turfBorders(layout: CityLayout): Border[] {
  const zs = turfZones(layout);
  const out: Border[] = [];
  for (let i = 0; i < zs.length; i++) {
    for (let j = i + 1; j < zs.length; j++) {
      const p = zs[i]!;
      const q = zs[j]!;
      if (p.turf.gang === q.turf.gang) continue;
      const z0 = Math.max(p.minZ, q.minZ);
      const z1 = Math.min(p.maxZ, q.maxZ);
      const x0 = Math.max(p.minX, q.minX);
      const x1 = Math.min(p.maxX, q.maxX);
      if ((p.maxX === q.minX || q.maxX === p.minX) && z1 > z0) {
        const x = p.maxX === q.minX ? p.maxX : q.maxX;
        out.push({ a: p.turf.gang, b: q.turf.gang, ax: x, az: z0, bx: x, bz: z1 });
      } else if ((p.maxZ === q.minZ || q.maxZ === p.minZ) && x1 > x0) {
        const z = p.maxZ === q.minZ ? p.maxZ : q.maxZ;
        out.push({ a: p.turf.gang, b: q.turf.gang, ax: x0, az: z, bx: x1, bz: z });
      }
    }
  }
  return out;
}

/** Members in their turf turn on an armed player within this range (m) who they can see. */
export const TURF_SIGHT = 22;
/** Wanted stars from which a car driven through a gang's turf draws their fire. */
export const TURF_CHASE_STARS = 3;
/** An attack on a member brings in his crew this close (m). */
export const CREW_CALL = 30;
/** After the player has been out of their turf this long (s) the members who turned on him only for that calm down. */
export const TURF_LEAVE_CALM = 3;
/** And without fresh provocation (a gun still out in their turf) they calm down after this long (s) anyway. */
export const TURF_CALM = 30;
const CHECK_EVERY = 0.25;
/** Gang cars: at most this many per gang, while the player is within CAR_RANGE m of its turf. */
export const CARS_PER_GANG = 2;
const CAR_RANGE = 260;
const CAR_CHECK_EVERY = 3;
/** Wars: checked this often (s) while the player is within WAR_RANGE m of a border, starting with WAR_CHANCE. */
const WAR_CHECK_EVERY = 20;
const WAR_RANGE = 220;
const WAR_CHANCE = 0.3;
/** A war lasts at most this long (s), and the next waits this long (s) after one ends. */
export const WAR_MAX = 75;
export const WAR_COOLDOWN = 190;
const WAR_SIDE = 3;

export interface GangWar {
  id: number;
  a: GangId;
  b: GangId;
  x: number;
  z: number;
  startedAt: number;
  endedAt: number;
  members: Character[];
}

export class GangSystem implements SimSystem {
  readonly id = 'gangs';
  readonly slot = 'afterPlayers' as const;
  private readonly rng: Rng;
  private checkTimer = 0;
  private carTimer = 1;
  private warTimer = 10;
  private lastWarEnd = -Infinity;
  /** When the player was last inside each gang's turf. */
  private readonly lastIn: Record<GangId, number> = { tiburones: -Infinity, halcones: -Infinity };
  readonly cars: Vehicle[] = [];
  readonly wars: GangWar[] = [];
  private warIds = 0;

  constructor(private readonly sim: Sim) {
    this.rng = new Rng(((sim.seed * 2246822519) ^ 0x6a6e6773) >>> 0);
    // An attack on a member brings his crew in on the attacker, wherever it happens.
    sim.events.on('damage', (e) => {
      if (!sim.streetCrime.gangs) return;
      const v = e.victim;
      const by = e.attacker;
      if (!by || !by.isPlayer || v.role !== 'gang' || !v.gang || v.isPlayer) return;
      for (const c of sim.characters) {
        if (c.removed || !c.alive || c.gang !== v.gang || !c.brain || c.brain.hostile) continue;
        if (c !== v && Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z) > CREW_CALL) continue;
        c.brain.provoked = true;
        if (c.state === 'normal' && c.brain.mode !== 'stand') sim.peds.fight(c, by);
      }
    });
  }

  update(sim: Sim, dt: number): void {
    if (!sim.streetCrime.gangs) return;
    const pp = sim.playerPos();
    const here = gangAt(sim.world.layout, pp.x, pp.z);
    if (here) this.lastIn[here] = sim.time;
    this.checkTimer -= dt;
    if (this.checkTimer <= 0) {
      this.checkTimer = CHECK_EVERY;
      this.turfRules(here);
    }
    this.updateWars();
    if (!sim.ambient) return;
    this.carTimer -= dt;
    if (this.carTimer <= 0) {
      this.carTimer = CAR_CHECK_EVERY;
      this.streamCars();
    }
    this.steerCars();
    this.warTimer -= dt;
    if (this.warTimer <= 0) {
      this.warTimer = WAR_CHECK_EVERY;
      this.maybeStartWar();
    }
  }

  reset(): void {
    this.cars.length = 0;
    this.wars.length = 0;
    this.lastWarEnd = -Infinity;
  }

  /** Whether `c`, a gang member, stands in his own gang's turf. */
  inOwnTurf(c: Character): boolean {
    return !!c.gang && gangAt(this.sim.world.layout, c.pos.x, c.pos.z) === c.gang;
  }

  /**
   * Members in their own turf turn on a player who walks in there on foot with a gun in hand, once they can see him;
   * those who turned on him only for that calm down once he has left their turf, or after TURF_CALM s without it.
   */
  private turfRules(here: GangId | null): void {
    const sim = this.sim;
    const p = sim.player;
    const pp = sim.playerPos();
    // A fugitive driving through at three stars or more counts as armed: the crew shoots at the car as it passes.
    const armed = p.alive && !sim.playerDown && (p.vehicle ? sim.wanted.level >= TURF_CHASE_STARS : p.state === 'normal' && isGun(p.inventory.current));
    for (const c of sim.characters) {
      if (c.removed || !c.alive || c.role !== 'gang' || !c.gang || !c.brain || c.brain.hostile || c.isPlayer) continue;
      const b = c.brain;
      if (b.mode === 'fight' && b.target === p) {
        if (b.provoked || b.turfAggroAt === -Infinity) continue;
        const left = here !== c.gang && sim.time - this.lastIn[c.gang] > TURF_LEAVE_CALM;
        const stale = sim.time - b.turfAggroAt > TURF_CALM && !(armed && here === c.gang);
        if (left || stale) this.calm(c);
        else if (armed && here === c.gang) b.turfAggroAt = Math.max(b.turfAggroAt, sim.time - TURF_CALM + 5);
        continue;
      }
      if (!armed || here !== c.gang || c.state !== 'normal' || b.mode === 'stand' || b.mode === 'fight') continue;
      if (!this.inOwnTurf(c)) continue;
      if (Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z) > TURF_SIGHT) continue;
      if (!sim.world.lineOfSight(c.pos.x, c.pos.y + 1.5, c.pos.z, pp.x, pp.y + 1.4, pp.z)) continue;
      sim.peds.fight(c, p);
      b.turfAggroAt = sim.time;
    }
  }

  private calm(c: Character): void {
    const b = c.brain!;
    const sim = this.sim;
    b.mode = 'wander';
    b.target = null;
    b.turfAggroAt = -Infinity;
    b.toNode = sim.world.walk.nearestNode(c.pos.x, c.pos.z);
    b.fromNode = b.toNode;
    c.aiming = false;
    if (c.inventory.current !== 'fists') c.inventory.current = 'fists';
  }

  // ---------------------------------------------------------------------------
  // Gang cars

  private streamCars(): void {
    const sim = this.sim;
    const layout = sim.world.layout;
    const pp = sim.playerPos();
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const v = this.cars[i]!;
      if (v.removed || !v.driver || v.driver.isPlayer || v.driver.gang === null || !v.driver.alive) this.cars.splice(i, 1);
    }
    for (const gang of Object.keys(GANGS) as GangId[]) {
      if (distToTurf(layout, gang, pp.x, pp.z) > CAR_RANGE) continue;
      if (this.cars.filter((v) => v.driver?.gang === gang).length >= CARS_PER_GANG) continue;
      this.spawnCar(gang);
    }
  }

  /**
   * Gang cars count towards the traffic the city streams round the player (TrafficSystem.targetCount): at that number,
   * an ordinary car well out of his view makes way for the next one.
   */
  private makeRoom(): boolean {
    const sim = this.sim;
    const pp = sim.playerPos();
    let count = 0;
    let spare: Vehicle | null = null;
    let spareD = 0;
    for (const v of sim.vehicles) {
      if (v.removed || v.owner !== 'traffic' || !v.driver || v.driver.isPlayer || v.destroyed) continue;
      count++;
      if (v.driver.gang || v.persistent) continue;
      const d = Math.hypot(v.pos.x - pp.x, v.pos.z - pp.z);
      if (d > 90 && d > spareD && !sim.isVisible(v.pos.x, v.pos.y, v.pos.z)) {
        spare = v;
        spareD = d;
      }
    }
    if (count < sim.traffic.targetCount) return true;
    if (!spare) return false;
    sim.removeVehicle(spare);
    return true;
  }

  /** A gang car on a lane inside `gang`'s turf, 70-170 m from the player and out of his view, its driver a member. */
  spawnCar(gang: GangId, near = false): Vehicle | null {
    const sim = this.sim;
    const pp = sim.playerPos();
    if (!this.makeRoom()) return null;
    const lanes = this.turfLanes(gang);
    if (lanes.length === 0) return null;
    for (let tries = 0; tries < 12; tries++) {
      const lane = lanes[this.rng.int(0, lanes.length - 1)]!;
      const s = this.rng.range(8, Math.max(9, lane.length - 8));
      const x = lane.sx + lane.dx * s;
      const z = lane.sz + lane.dz * s;
      const d = Math.hypot(x - pp.x, z - pp.z);
      if (!near && (d < 70 || d > 170 || sim.isVisible(x, 1, z))) continue;
      if (gangAt(sim.world.layout, x, z) !== gang || !sim.traffic.isClear(x, z, 11)) continue;
      const spec = GANGS[gang];
      const kind = spec.cars[this.rng.int(0, spec.cars.length - 1)]!;
      const v = sim.spawnVehicle(kind, x, z, lane.heading, spec.carColors[this.rng.int(0, spec.carColors.length - 1)]!);
      v.owner = 'traffic';
      const driver = sim.addDriver(v, 'gang', 'traffic');
      driver.owner = 'traffic';
      setGang(driver, gang);
      v.ai!.setLane(lane, s);
      v.vel.x = lane.dx * lane.speedLimit * 0.5;
      v.vel.z = lane.dz * lane.speedLimit * 0.5;
      this.cars.push(v);
      this.nextStop(v, gang);
      return v;
    }
    return null;
  }

  private readonly laneCache = new Map<GangId, ReturnType<GangSystem['laneList']>>();

  private turfLanes(gang: GangId): ReturnType<GangSystem['laneList']> {
    let l = this.laneCache.get(gang);
    if (!l) {
      l = this.laneList(gang);
      this.laneCache.set(gang, l);
    }
    return l;
  }

  private laneList(gang: GangId) {
    const sim = this.sim;
    const layout = sim.world.layout;
    // Lanes well inside the turf (their midpoint 6 m in from its edge), long enough to stop on.
    return sim.roads.lanes.filter((l) => {
      if (l.length < 24) return false;
      const mx = (l.sx + l.ex) / 2;
      const mz = (l.sz + l.ez) / 2;
      return gangAt(layout, mx, mz) === gang && gangAt(layout, mx + 6, mz) === gang && gangAt(layout, mx - 6, mz) === gang && gangAt(layout, mx, mz + 6) === gang && gangAt(layout, mx, mz - 6) === gang;
    });
  }

  /** Sends a gang car on to another spot in its turf. */
  private nextStop(v: Vehicle, gang: GangId): void {
    const lanes = this.turfLanes(gang);
    const lane = lanes[this.rng.int(0, lanes.length - 1)]!;
    v.ai!.setDestination((lane.sx + lane.ex) / 2, (lane.sz + lane.ez) / 2);
  }

  private steerCars(): void {
    for (const v of this.cars) {
      const ai = v.ai;
      const g = v.driver?.gang;
      if (!ai || !g || v.removed || v.driver?.isPlayer) continue;
      if (ai.policy !== 'route') continue;
      if (ai.arrived || ai.routeRemaining() < 20) this.nextStop(v, g);
    }
  }

  // ---------------------------------------------------------------------------
  // Gang wars

  private maybeStartWar(): void {
    const sim = this.sim;
    if (this.wars.some((w) => w.endedAt < 0) || sim.time - this.lastWarEnd < WAR_COOLDOWN || sim.wanted.level > 0) return;
    const pp = sim.playerPos();
    const border = this.nearestBorder(pp.x, pp.z);
    if (!border || border.d > WAR_RANGE) return;
    if (!this.rng.chance(WAR_CHANCE)) return;
    this.startWar(border.b, false);
  }

  private nearestBorder(x: number, z: number): { b: Border; d: number; t: number } | null {
    let best: { b: Border; d: number; t: number } | null = null;
    for (const b of turfBorders(this.sim.world.layout)) {
      const dx = b.bx - b.ax;
      const dz = b.bz - b.az;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - b.ax) * dx + (z - b.az) * dz) / len2)) : 0;
      const d = Math.hypot(b.ax + dx * t - x, b.az + dz * t - z);
      if (!best || d < best.d) best = { b, d, t };
    }
    return best;
  }

  /**
   * Starts a war at the border nearest the player: WAR_SIDE members of each gang on the sidewalks either side of the
   * street between their turfs, 40-110 m from him (`near`: 15-60 m, the debug trigger), each going for the nearest of
   * the other gang. Null when no spot for it turns up.
   */
  startWar(border?: Border, near = false): GangWar | null {
    const sim = this.sim;
    const pp = sim.playerPos();
    const nb = border ? null : this.nearestBorder(pp.x, pp.z);
    const b = border ?? nb?.b;
    if (!b) return null;
    const layout = sim.world.layout;
    const dx = b.bx - b.ax;
    const dz = b.bz - b.az;
    const len = Math.hypot(dx, dz);
    for (let tries = 0; tries < 24; tries++) {
      const t = this.rng.range(0.1, 0.9);
      const cx = b.ax + dx * t;
      const cz = b.az + dz * t;
      const d = Math.hypot(cx - pp.x, cz - pp.z);
      if (near ? d < 15 || d > 60 : d < 40 || d > 110) continue;
      // Across the border: the normal to the street.
      const nx = -dz / len;
      const nz = dx / len;
      const sideOf = (g: GangId) => (gangAt(layout, cx + nx * 10, cz + nz * 10) === g ? 1 : -1);
      const spots: Array<{ x: number; z: number; g: GangId }> = [];
      for (const g of [b.a, b.b]) {
        const sgn = sideOf(g);
        for (let k = 0; k < WAR_SIDE; k++) {
          const ox = cx + nx * sgn * this.rng.range(9, 14) + (dx / len) * this.rng.range(-8, 8);
          const oz = cz + nz * sgn * this.rng.range(9, 14) + (dz / len) * this.rng.range(-8, 8);
          const s = sim.world.findFreeSpot(ox, oz, 0.4, 4);
          if (s && gangAt(layout, s.x, s.z) === g && sim.world.waterDepth(s.x, s.z) < -0.2 && (near || !sim.isVisible(s.x, 1, s.z))) spots.push({ ...s, g });
        }
      }
      if (spots.filter((s) => s.g === b.a).length < 2 || spots.filter((s) => s.g === b.b).length < 2) continue;
      const war: GangWar = { id: ++this.warIds, a: b.a, b: b.b, x: cx, z: cz, startedAt: sim.time, endedAt: -1, members: [] };
      for (const s of spots) {
        const c = sim.spawnCharacter('gang', s.x, s.z);
        c.owner = 'ped';
        setGang(c, s.g);
        const brain = sim.peds.makeGangBrain(s.x, s.z);
        c.brain = brain;
        if (this.rng.chance(0.75)) {
          c.inventory.infinite = true;
          c.inventory.give('pistol', 999);
        }
        c.inventory.current = 'fists';
        war.members.push(c);
      }
      for (const c of war.members) {
        const foe = this.nearestFoe(c, war);
        if (foe) sim.peds.fight(c, foe);
      }
      this.wars.push(war);
      sim.events.emit('gangWar', { a: war.a, b: war.b, x: war.x, z: war.z, started: true });
      return war;
    }
    return null;
  }

  private nearestFoe(c: Character, war: GangWar): Character | null {
    let best: Character | null = null;
    let bd = Infinity;
    for (const o of war.members) {
      if (o.removed || !o.alive || o.gang === c.gang) continue;
      const d = Math.hypot(o.pos.x - c.pos.x, o.pos.z - c.pos.z);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  private updateWars(): void {
    const sim = this.sim;
    for (const w of this.wars) {
      if (w.endedAt >= 0) continue;
      const alive = (g: GangId) => w.members.filter((c) => !c.removed && c.alive && c.gang === g && c.state !== 'dead');
      const a = alive(w.a);
      const b = alive(w.b);
      const over = a.length === 0 || b.length === 0 || sim.time - w.startedAt > WAR_MAX;
      if (over) {
        w.endedAt = sim.time;
        this.lastWarEnd = sim.time;
        for (const c of [...a, ...b]) {
          const br = c.brain;
          if (br && br.mode === 'fight' && br.target && !br.target.isPlayer) this.calm(c);
        }
        sim.events.emit('gangWar', { a: w.a, b: w.b, x: w.x, z: w.z, started: false });
        continue;
      }
      // Whoever lost his man goes for the next of the other gang.
      for (const c of [...a, ...b]) {
        const br = c.brain;
        if (!br || c.state !== 'normal') continue;
        if (br.mode === 'fight' && br.target?.isPlayer) continue;
        if (br.mode !== 'fight' || !br.target || !br.target.alive || br.target.removed) {
          const foe = this.nearestFoe(c, w);
          if (foe) sim.peds.fight(c, foe);
        }
      }
    }
  }

  /** A war going on now, if any. */
  get activeWar(): GangWar | null {
    return this.wars.find((w) => w.endedAt < 0) ?? null;
  }
}

