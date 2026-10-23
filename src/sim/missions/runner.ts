// Mission framework. Missions are generator scripts that yield wait predicates;
// the runner resumes them synchronously inside Sim.update, which keeps the
// story deterministic and testable without any async timing.

import { pointSegDist } from '../../core/math';
import { rectContains, type Rect } from '../../world/layout';
import type { Lane } from '../../world/roads';
import type { StaticWorld } from '../../world/staticWorld';
import type { Objective } from '../activities';
import { makeBrain, type PedMode } from '../brains';
import type { DriverPolicy } from '../driver';
import type { Character, CharacterRole, Pickup, Vehicle, WeaponSlot } from '../entities';
import type { Sim } from '../sim';
import type { VehicleKind, WeaponId } from '../specs';
import { findVehicleRoom, vehiclesInTheWay } from '../vehicleRoom';
import { CONTACTS, contactById, contactColorNumber, type ContactId } from './contacts';
import { STORY } from './index';

/**
 * A wait condition: the script resumes once it returns true. `dt` is the mission
 * time since the previous check (0 on the first check), so anything that
 * accumulates time stays correct at any frame rate.
 */
export type Wait = (dt: number) => boolean;
export type Script = Generator<Wait, void, undefined>;

/** Seconds after a failure during which the mission can be restarted with one key press. */
export const RETRY_WINDOW = 20;
/** A line of dialogue can be skipped once it has been up this long. */
const SKIP_AFTER = 0.4;
/**
 * A contact's marker: getting out of any vehicle parked on it, which lands 1.6 m (a compact) to 2.02 m (the bus)
 * from where it stood, puts the player on it.
 */
const MARKER_RADIUS = 2.1;
/** A retry fades the screen out and back in over this long, locking the controls... */
const RETRY_FADE = 1.2;
/** ...and moves the player while it is black. */
const RETRY_SWAP = 0.6;

const ABANDONED = 'Mission abandoned.';
const WASTED = 'You got wasted.';
const BUSTED = 'You got busted.';

export interface MissionDef {
  id: string;
  title: string;
  giver: ContactId;
  reward: number;
  requires: string[];
  blurb: string;
  /** Where a retry puts the player (by default, the giver's marker). */
  retryAt?(world: StaticWorld): { x: number; z: number; heading?: number };
  /** A title card shown after MISSION PASSED (The Big Score's CHAPTER 1 COMPLETE). */
  outro?: { text: string; sub: string; duration: number };
  run(m: MissionCtx): Script;
}

interface FailCheck {
  id: number;
  check: (dt: number) => boolean;
  reason: string;
}

export class MissionCtx {
  time = 0;
  objectiveText = '';
  readonly markers: Objective[] = [];
  readonly vehicles: Vehicle[] = [];
  readonly characters: Character[] = [];
  /** Mission pickups (the Hot Delivery parcel); removed when the mission ends. */
  readonly pickups: Pickup[] = [];
  timer: { label: string; endsAt: number; reason: string } | null = null;
  /** Free-form HUD counter (e.g. "VAULT 12/20"). */
  counter: string | null = null;
  private fails: FailCheck[] = [];
  private failSeq = 0;
  failedReason: string | null = null;
  done = false;
  /** The goal is met (see complete): nothing fails the mission any more. */
  won = false;
  /** Marked done, paid and autosaved (see MissionSystem.settle). */
  settled = false;
  private readonly it: Script;
  private current: Wait | null = null;
  /** Reward override (scripts may pay less for a damaged delivery). */
  reward: number;
  /** Highest checkpoint reached: a retry after a failure resumes from it. */
  checkpointReached: number;
  /** Markers on enemies. They stay behind every other marker, so the GPS keeps leading to the objective. */
  private readonly enemyMarks = new Set<Objective>();
  /** The line of dialogue on screen (see say): when it started and when it ends, in mission time. */
  private line: { start: number; end: number } | null = null;

  constructor(
    readonly sim: Sim,
    readonly def: MissionDef,
    /** Restarted after a failure: the intro is skipped. */
    readonly retrying = false,
    /** The checkpoint this attempt starts from (0: the beginning). */
    readonly resume = 0,
    /**
     * Rounds per weapon the player got between a failure and this retry (see MissionSystem.restart): he
     * keeps them on top of a mission handout, which tops up only what he had before (see givePlayer).
     */
    private readonly kept: ReadonlyMap<WeaponId, number> = new Map(),
  ) {
    this.reward = def.reward;
    this.checkpointReached = resume;
    this.it = def.run(this);
  }

  // --- runner ---------------------------------------------------------------

  tick(dt: number): void {
    if (this.done || this.failedReason) return;
    this.time += dt;
    try {
      if (!this.won && this.timer && this.sim.time >= this.timer.endsAt) {
        this.fail(this.timer.reason);
        return;
      }
      for (const f of this.fails) {
        // Past the goal the checks still run, as the watches ride on them, but they fail nothing.
        if (f.check(dt) && !this.won) {
          this.fail(f.reason);
          return;
        }
      }
    } catch (err) {
      // A broken fail check must never take the game down with it either (see the script below).
      console.error(`Mission ${this.def.id} check error`, err);
      this.fail('Something went wrong.');
      return;
    }
    let guard = 0;
    let waited = dt;
    for (;;) {
      if (this.current !== null) {
        let ready: boolean;
        try {
          ready = this.current(waited);
        } catch (err) {
          // Nor a broken wait (until, goTo's checks, a line of dialogue): the mission fails, as for the script.
          console.error(`Mission ${this.def.id} wait error`, err);
          this.fail('Something went wrong.');
          return;
        }
        if (!ready) return;
      }
      // A wait yielded during this tick is checked right away, but it has not waited through this frame.
      waited = 0;
      if (++guard > 64) return;
      let r: IteratorResult<Wait, void>;
      try {
        r = this.it.next();
      } catch (err) {
        // A broken script must never take the game down with it (past its goal, it ends passed all the same).
        console.error(`Mission ${this.def.id} script error`, err);
        if (this.won) this.done = true;
        else this.failedReason = this.failedReason ?? 'Something went wrong.';
        return;
      }
      if (this.failedReason || this.done) return;
      if (r.done) {
        this.done = true;
        return;
      }
      this.current = r.value;
    }
  }

  /**
   * The mission's goal is met (each script calls this right after its last objective, its reward set): it is
   * passed from here on, whatever happens during its closing hand-over and lines. Its timer and fail checks stop
   * counting, and a wasted, a busted or an abandon only cuts the rest short (see fail). It is marked done, paid
   * and saved now, not at the end of those lines, so quitting during them cannot lose it (see MissionSystem.settle).
   */
  complete(): void {
    if (this.done || this.failedReason) return;
    this.won = true;
    this.timer = null;
    // The finished objective must not sit under the closing lines either (goTo clears its own).
    if (this.objectiveText) {
      this.objectiveText = '';
      this.sim.events.emit('objective', { text: '' });
    }
    this.sim.missions.settle(this);
  }

  /** Ends the mission as failed; past its goal (see complete) it ends passed instead, cut short. */
  fail(reason: string): void {
    if (this.done || this.failedReason) return;
    if (this.won) this.done = true;
    else this.failedReason = reason;
    // Its dialogue ends with it: a line cut short must not run on over MISSION FAILED (or the offer card).
    if (this.line && this.time < this.line.end) this.sim.events.emit('subtitle', { speaker: '', text: '', duration: 0 });
    this.line = null;
    try {
      this.it.return(undefined);
    } catch {
      // Scripts must not throw from finally blocks; ignore if they do.
    }
  }

  // --- waiting --------------------------------------------------------------

  until(pred: Wait): Wait {
    return pred;
  }

  *wait(seconds: number): Script {
    const end = this.time + seconds;
    yield () => this.time >= end;
  }

  /**
   * A line of dialogue. A fresh press of the interact key skips it once it has been up for a moment
   * (in a vehicle, where that key is the horn, it skips instead of honking: see canSkipLine).
   */
  *say(speaker: string, text: string, seconds?: number): Script {
    const s = seconds ?? Math.min(6, 1.6 + text.length * 0.055);
    this.sim.events.emit('subtitle', { speaker, text, duration: s });
    const line = { start: this.time, end: this.time + s };
    this.line = line;
    let skipped = false;
    yield () => {
      if (this.time - line.start >= SKIP_AFTER && this.sim.missions.skipPressed) skipped = true;
      return skipped || this.time >= line.end;
    };
    if (this.line === line) this.line = null;
    // Take the skipped line off the screen; a next line replaces it in the same frame anyway.
    if (skipped) this.sim.events.emit('subtitle', { speaker: '', text: '', duration: 0 });
  }

  /** A line of dialogue is on screen and has been up long enough to be skipped. */
  get canSkipLine(): boolean {
    return this.line !== null && this.time - this.line.start >= SKIP_AFTER;
  }

  /** The opening dialogue, skipped entirely on a retry. */
  *intro(lines: ReadonlyArray<readonly [speaker: string, text: string]>): Script {
    if (this.retrying) return;
    for (const [speaker, text] of lines) yield* this.say(speaker, text);
  }

  objective(text: string): void {
    this.objectiveText = text;
    this.sim.events.emit('objective', { text });
  }

  /** Records a checkpoint: a retry after a failure from here on starts from it. */
  checkpoint(n: number): void {
    if (n <= this.checkpointReached) return;
    this.checkpointReached = n;
    this.sim.events.emit('message', { text: 'Checkpoint reached', duration: 2 });
  }

  /**
   * Waits until the player reaches a point, then clears the objective (a finished objective must not
   * sit under the closing dialogue). Returns false when `abortIf` ended the wait instead.
   */
  *goTo(
    x: number,
    z: number,
    opts: {
      radius?: number;
      label?: string;
      color?: number;
      vehicle?: Vehicle | 'any' | null;
      onFoot?: boolean;
      maxSpeed?: number;
      area?: Rect;
      abortIf?: () => boolean;
      /** While true, getting there does not count yet (the marker stays). */
      hold?: () => boolean;
    } = {},
  ): Generator<Wait, boolean, undefined> {
    const marker: Objective = { x, z, label: opts.label ?? '', color: opts.color ?? 0xffd23d, radius: opts.radius ?? 3 };
    this.addMarker(marker);
    let arrived = false;
    try {
      yield () => {
        if (opts.abortIf?.()) return true;
        const sim = this.sim;
        const p = sim.player;
        const pos = sim.playerPos();
        const inside = opts.area ? rectContains(opts.area, pos.x, pos.z) : Math.hypot(pos.x - x, pos.z - z) <= marker.radius;
        if (!inside || !p.alive) return false;
        if (opts.onFoot && p.state !== 'normal') return false;
        if (opts.vehicle === 'any' && !p.vehicle) return false;
        if (opts.vehicle && opts.vehicle !== 'any' && p.vehicle !== opts.vehicle) return false;
        if (opts.maxSpeed !== undefined && p.vehicle && p.vehicle.speed > opts.maxSpeed) return false;
        if (opts.hold?.()) return false;
        arrived = true;
        return true;
      };
    } finally {
      this.unmark(marker);
    }
    if (arrived) {
      this.objectiveText = '';
      this.sim.events.emit('objective', { text: '' });
    }
    return arrived;
  }

  mark(target: Vehicle | Character | { x: number; z: number }, label: string, color = 0xff3b3b, radius = 3): Objective {
    const o: Objective = { x: 0, z: 0, label, color, radius };
    if ('kind' in target && 'spec' in target) o.vehicle = target as Vehicle;
    else if ('role' in target) o.character = target as Character;
    else {
      o.x = target.x;
      o.z = target.z;
    }
    this.addMarker(o);
    return o;
  }

  /** Marks an enemy (a red arrow and blip) behind every other marker: the GPS never leads to it. */
  markEnemy(target: Vehicle | Character, label: string): Objective {
    const o = this.mark(target, label);
    this.unmark(o);
    this.markers.push(o);
    this.enemyMarks.add(o);
    return o;
  }

  unmark(o: Objective): void {
    const i = this.markers.indexOf(o);
    if (i >= 0) this.markers.splice(i, 1);
    this.enemyMarks.delete(o);
  }

  /** Adds a marker in front of the enemy markers. */
  private addMarker(o: Objective): void {
    const i = this.markers.findIndex((m) => this.enemyMarks.has(m));
    if (i < 0) this.markers.push(o);
    else this.markers.splice(i, 0, o);
  }

  failIf(check: (dt: number) => boolean, reason: string): number {
    const id = ++this.failSeq;
    this.fails.push({ id, check, reason });
    return id;
  }

  clearFail(id: number): void {
    this.fails = this.fails.filter((f) => f.id !== id);
  }

  /**
   * Runs `fn` every tick, before the script resumes, until unwatch(id). It rides on the fail
   * checks, so whatever guards them guards this too.
   */
  watch(fn: (dt: number) => void): number {
    return this.failIf((dt) => {
      fn(dt);
      return false;
    }, '');
  }

  unwatch(id: number): void {
    this.clearFail(id);
  }

  setTimer(label: string, seconds: number, reason: string): void {
    this.timer = { label, endsAt: this.sim.time + seconds, reason };
  }

  clearTimer(): void {
    this.timer = null;
  }

  // --- world helpers --------------------------------------------------------

  playerVehicle(): Vehicle | null {
    const v = this.sim.player.vehicle;
    return v && !v.removed ? v : null;
  }

  spawnVehicle(kind: VehicleKind, x: number, z: number, heading: number, color?: number): Vehicle {
    const at = this.makeRoom(kind, x, z, heading);
    const v = this.sim.spawnVehicle(kind, at.x, at.z, heading, color);
    v.owner = 'mission';
    v.persistent = true;
    v.missionTag = this.def.id;
    this.vehicles.push(v);
    return v;
  }

  /**
   * Clears the spot a mission vehicle spawns at: whatever was left standing in its way goes, such as a
   * failed attempt's wreck or car on the spot a retry spawns its new one at, or a car parked in its bay.
   * Only a car the player is in, or one another job holds on to, stays: then the new one goes to the
   * nearest spot within 15 m where it fits, or, with none there either, to its own spot after all.
   */
  private makeRoom(kind: VehicleKind, x: number, z: number, heading: number): { x: number; z: number } {
    const sim = this.sim;
    let blocked = false;
    for (const v of vehiclesInTheWay(sim, kind, x, z, heading)) {
      if (v.persistent || v.occupants().some((c) => c.isPlayer)) blocked = true;
      else sim.removeVehicle(v);
    }
    return (blocked && findVehicleRoom(sim, kind, x, z, heading, 15)) || { x, z };
  }

  spawnCharacter(role: CharacterRole, x: number, z: number, mode: PedMode, weapon?: WeaponId): Character {
    const c = this.sim.spawnCharacter(role, x, z);
    c.owner = 'mission';
    c.persistent = true;
    c.missionTag = role === 'gang' ? 'enemy' : this.def.id;
    const b = makeBrain(mode);
    b.homeX = x;
    b.homeZ = z;
    b.brave = role === 'gang';
    b.hostile = role === 'gang';
    b.accuracy = 0.3;
    c.brain = b;
    if (weapon) {
      c.inventory.infinite = true;
      c.inventory.give(weapon, 999);
      c.inventory.current = weapon;
    }
    this.characters.push(c);
    return c;
  }

  /**
   * A mission car at `s` m along `lane`, driven by a mission character of `role` on `policy`;
   * with `dest` he takes the route policy there instead.
   */
  spawnDriver(kind: VehicleKind, lane: Lane, s: number, role: CharacterRole, policy: DriverPolicy, dest?: { x: number; z: number }): Vehicle {
    const v = this.spawnVehicle(kind, lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
    this.addDriver(v, role, policy);
    v.ai!.setLane(lane, s);
    if (dest) v.ai!.setDestination(dest.x, dest.z);
    return v;
  }

  /** Seats a mission driver of `role` with a DriverAI on `policy` in `v` (one of this mission's vehicles). */
  addDriver(v: Vehicle, role: CharacterRole, policy: DriverPolicy): Character {
    const d = this.sim.addDriver(v, role, policy);
    d.owner = 'mission';
    d.persistent = true;
    d.missionTag = role === 'gang' ? 'enemy' : this.def.id;
    // Nobody thinks behind the wheel: the brain is for when he gets out (carjacked, car on fire).
    const b = makeBrain('wander');
    b.brave = role === 'gang';
    b.hostile = role === 'gang';
    b.accuracy = 0.3;
    d.brain = b;
    if (role === 'gang') {
      // Drawn when he fights on foot.
      d.inventory.infinite = true;
      d.inventory.give('pistol', 999);
    }
    this.characters.push(d);
    return d;
  }

  /**
   * `n` police officers on foot answering an alarm at (x, z), at free sidewalk spots 25-45 m away
   * (out of the player's view when possible) and equipped like PoliceSystem.equip. They belong to
   * the police, who run them and send them home, not to the mission.
   */
  spawnResponders(x: number, z: number, n: number, role: 'cop' | 'swat'): Character[] {
    const sim = this.sim;
    const out: Character[] = [];
    for (let tries = 0; tries < n * 12 && out.length < n; tries++) {
      const pt = sim.world.walk.randomPointNear(sim.rng, x, z, 25, 45);
      const spot = pt && sim.world.findFreeSpot(pt.x, pt.z, 0.4, 4);
      if (!spot || sim.world.waterDepth(spot.x, spot.z) > -0.1) continue;
      const d = Math.hypot(spot.x - x, spot.z - z);
      if (d < 25 || d > 45 || (tries < n * 8 && sim.isVisible(spot.x, 1, spot.z))) continue;
      const c = sim.spawnCharacter(role, spot.x, spot.z);
      const gun: WeaponId = role === 'swat' ? 'smg' : 'pistol';
      c.owner = 'police';
      c.inventory.infinite = true;
      c.inventory.give(gun, 999);
      c.inventory.current = gun;
      const b = makeBrain('chase');
      b.accuracy = role === 'swat' ? 0.62 : 0.45;
      b.brave = true;
      c.brain = b;
      c.heading = Math.atan2(x - spot.x, z - spot.z);
      out.push(c);
    }
    return out;
  }

  /**
   * A clear lane point `minD`-`maxD` m from the player for a car sent after him: out of his view and
   * on a lane heading his way when possible. Null if there is none.
   */
  laneSpotNear(minD: number, maxD: number): { lane: Lane; s: number } | null {
    const sim = this.sim;
    const pp = sim.playerPos();
    const lanes = sim.roads.lanes.filter((l) => l.length >= 16 && pointSegDist(pp.x, pp.z, l.sx, l.sz, l.ex, l.ez) <= maxD);
    if (lanes.length === 0) return null;
    for (let tries = 0; tries < 60; tries++) {
      const lane = sim.rng.pick(lanes);
      const s = sim.rng.range(6, lane.length - 6);
      const x = lane.sx + lane.dx * s;
      const z = lane.sz + lane.dz * s;
      const d = Math.hypot(x - pp.x, z - pp.z);
      if (d < minD || d > maxD) continue;
      if (tries < 30 && (pp.x - x) * lane.dx + (pp.z - z) * lane.dz < 0) continue;
      if (tries < 45 && sim.isVisible(x, 1, z)) continue;
      if (!sim.traffic.isClear(x, z, 9)) continue;
      return { lane, s };
    }
    return null;
  }

  /** A parcel the player picks up on foot (Hot Delivery). */
  spawnParcel(x: number, z: number): Pickup {
    const p = this.sim.pickupSys.addMissionParcel(x, z);
    this.pickups.push(p);
    return p;
  }

  /**
   * Gives a mission weapon, topped up to at least `ammo` rounds (never more on a restart). On a retry the top-up
   * goes against what the player had before the attempt: what he got after the failure stays on top of it.
   */
  givePlayer(weapon: WeaponId, ammo: number): void {
    const inv = this.sim.player.inventory;
    const kept = this.kept.get(weapon) ?? 0;
    const before = Math.max(0, inv.total(weapon) - kept);
    // Drawn unless he had it before the attempt (a slot only the kept rounds made does not count).
    const had = inv.has(weapon) && (kept === 0 || before > 0);
    if (ammo > before) inv.give(weapon, ammo - before);
    if (!had) inv.current = weapon;
  }

  /** Releases or removes mission entities when the mission ends. */
  cleanup(): void {
    for (const v of this.vehicles) {
      if (v.removed) continue;
      v.persistent = false;
      v.missionTag = '';
      const npc = v.driver && !v.driver.isPlayer ? v.driver : null;
      v.owner = npc ? 'traffic' : 'none';
      if (npc) {
        npc.persistent = false;
        npc.owner = 'traffic';
        // Plain traffic again: no more chasing, fleeing or heading for a destination.
        if (v.ai) {
          v.ai.setPolicy('traffic');
          v.ai.target = null;
          v.ai.dest = null;
          v.ai.resetPath();
        }
      }
    }
    for (const c of this.characters) {
      if (c.removed) continue;
      c.persistent = false;
      c.missionTag = '';
      c.owner = c.state === 'inVehicle' ? 'traffic' : 'ped';
      if (c.brain && c.alive) {
        c.brain.hostile = false;
        c.brain.target = null;
        if (c.state !== 'inVehicle') {
          c.brain.mode = 'wander';
          c.brain.toNode = -1;
        }
      }
    }
    for (const p of this.pickups) p.removed = true;
    this.markers.length = 0;
    this.enemyMarks.clear();
  }
}

/** What the player carries: weapons and ammo, the weapon in hand, and armour. */
interface Loadout {
  slots: Array<[WeaponId, WeaponSlot]>;
  current: WeaponId;
  armor: number;
}

function takeLoadout(p: Character): Loadout {
  return {
    slots: [...p.inventory.slots].map(([id, s]): [WeaponId, WeaponSlot] => [id, { ammo: s.ammo, clip: s.clip, readyAt: 0 }]),
    current: p.inventory.current,
    armor: p.armor,
  };
}

/** What a retry gives the player back (see restoreLoadout). */
interface RetryBase {
  /** His loadout from before the first attempt. */
  start: Loadout;
  /** Rounds per weapon he got between a failure and its retry, which he keeps on every later retry too. */
  kept: Map<WeaponId, number>;
  /** Armour he put on between a failure and its retry (0: none). */
  keptArmor: number;
}

/**
 * `base` with what the player carries now beyond `failed` (his loadout right after a failure, or at the
 * last respawn since) added to what he keeps: rounds and armour he got since, bought or picked up.
 */
function keepGains(p: Character, base: RetryBase, failed: Loadout): RetryBase {
  const inv = p.inventory;
  const kept = new Map(base.kept);
  for (const id of inv.owned()) {
    if (id === 'fists') continue;
    const before = failed.slots.find(([w]) => w === id)?.[1];
    const g = inv.total(id) - (before ? before.ammo + before.clip : 0);
    if (g > 0) kept.set(id, (kept.get(id) ?? 0) + g);
  }
  const keptArmor = p.armor > failed.armor ? Math.max(base.keptArmor, p.armor) : base.keptArmor;
  return { start: base.start, kept, keptArmor };
}

/**
 * Gives the player his loadout from before the first attempt back: weapons a bust confiscated return,
 * ammo picked up during a failed attempt goes. What he got after a failure (see keepGains) he keeps on top.
 */
function restoreLoadout(p: Character, base: RetryBase): void {
  const inv = p.inventory;
  inv.slots.clear();
  for (const [id, s] of base.start.slots) inv.slots.set(id, { ammo: s.ammo, clip: s.clip, readyAt: 0 });
  if (!inv.slots.has('fists')) inv.slots.set('fists', { ammo: 0, clip: 0, readyAt: 0 });
  for (const [id, g] of base.kept) inv.give(id, g);
  inv.current = inv.has(base.start.current) ? base.start.current : 'fists';
  p.armor = Math.max(base.start.armor, base.keptArmor);
  p.reloadTimer = 0;
  p.reloadWeapon = null;
}

/** How the player takes the retry of a mission that just failed, from where he is (MISSION FAILED's sub-line). */
function retryHint(sim: Sim): string {
  // In the order Interactions' retry prompt names them.
  if (sim.wanted.level > 0) return 'Lose the cops, then press E to retry';
  // In a vehicle E is the horn: the retry is taken on foot.
  if (sim.player.vehicle) return 'Get out of the vehicle to retry';
  return 'Press E to retry';
}

/** A failed mission the player can restart with one key press. */
interface RetryOffer extends RetryBase {
  id: string;
  /** Checkpoint the restart resumes from. */
  resume: number;
  /** His loadout right after the failure (null until the respawn after a wasted / busted). */
  failed: Loadout | null;
  /**
   * Sim time the quick E prompt lapses; the pause-menu retry remains available. Null until armed:
   * at the respawn after a wasted / busted, and once the police are lost after a failure with them on him.
   */
  until: number | null;
}

/** Why story missions do not start in a multiplayer sim. */
export const MP_NO_STORY = 'Story missions are single-player only.';

export class MissionSystem {
  readonly defs: readonly MissionDef[] = STORY;
  active: MissionCtx | null = null;
  /** Debug / tests: disables arrests. */
  noBust = false;
  /** The interact key went down this frame: skips a line of dialogue (see MissionCtx.say). */
  skipPressed = false;
  private interactWas = false;
  private refreshed = false;
  /** What a retry of the active mission gives back: its loadout from before the first attempt, and what he keeps. */
  private base: RetryBase | null = null;
  private retry: RetryOffer | null = null;
  /** A retry under way: the player is moved and the mission restarted at `at`, behind the fade. */
  private pendingRetry: (RetryOffer & { at: number }) | null = null;
  /** A mission passed while the player was down: its autosave waits until he is back up (see settle and finish). */
  private saveOnRespawn = false;

  constructor(private readonly sim: Sim) {
    sim.events.on('respawn', () => this.armRetry());
  }

  available(): MissionDef[] {
    const prog = this.sim.progress;
    return this.defs.filter((d) => !prog.hasDone(d.id) && d.requires.every((r) => prog.hasDone(r)));
  }

  /** Why no story mission can start in this sim at all (multiplayer), or null. */
  get refusal(): string | null {
    return this.sim.multiplayer ? MP_NO_STORY : null;
  }

  /** The next mission each contact offers (none in multiplayer). */
  offers(): MissionDef[] {
    const out: MissionDef[] = [];
    if (this.refusal) return out;
    for (const contact of CONTACTS) {
      const d = this.available().find((m) => m.giver === contact.id);
      if (d) out.push(d);
    }
    return out;
  }

  refreshMarkers(): void {
    const sim = this.sim;
    const markers = sim.interactions.markers;
    for (let i = markers.length - 1; i >= 0; i--) if (markers[i]!.kind === 'mission') markers.splice(i, 1);
    if (this.active) return;
    for (const d of this.offers()) {
      const contact = contactById(d.giver);
      const poi = sim.world.layout.pois.find((p) => p.id === contact.poiId)!;
      markers.push({ id: `mission:${d.id}`, kind: 'mission', x: poi.x, z: poi.z, radius: MARKER_RADIUS, label: `Press E to start "${d.title}"`, color: contactColorNumber(contact), ref: d.id });
    }
  }

  start(id: string, opts: { retrying?: boolean; resume?: number } = {}): boolean {
    const sim = this.sim;
    if (this.refusal) {
      sim.events.emit('message', { text: this.refusal, duration: 3 });
      return false;
    }
    if (this.active || sim.playerDown) return false;
    const def = this.defs.find((d) => d.id === id);
    if (!def || !this.available().includes(def)) return false;
    sim.activities.cancelAll('mission');
    // A restart keeps the loadout from before the first attempt, and what he keeps on top (restart put both back).
    if (!opts.retrying || !this.base) this.base = { start: takeLoadout(sim.player), kept: new Map(), keptArmor: 0 };
    this.retry = null;
    this.pendingRetry = null;
    this.active = new MissionCtx(sim, def, !!opts.retrying, opts.resume ?? 0, this.base.kept);
    this.refreshMarkers();
    sim.events.emit('missionStarted', { id: def.id, title: def.title });
    // A retry goes straight back to work, as it skips the intro: no title card.
    if (!opts.retrying) sim.events.emit('big', { text: def.title.toUpperCase(), sub: contactById(def.giver).name, style: 'title', duration: 3.5 });
    return true;
  }

  /** A line of dialogue can be skipped now (Game lets the horn key skip it in a vehicle, see Input.skipLine). */
  get lineSkippable(): boolean {
    return this.active?.canSkipLine ?? false;
  }

  update(dt: number): void {
    const sim = this.sim;
    // Multiplayer: no markers, no missions, no autosaves.
    if (this.refusal) return;
    const press = sim.lastInput.interact;
    this.skipPressed = press && !this.interactWas;
    this.interactWas = press;
    if (!this.refreshed) {
      this.refreshed = true;
      this.refreshMarkers();
    }
    this.saveAfterRespawn();
    const offer = this.retry;
    if (offer) {
      if (offer.until === null) {
        // A failure with the police on him: the window opens once they are lost (see retryAfterCops).
        if (offer.failed && sim.wanted.level === 0 && !sim.playerDown) offer.until = sim.time + RETRY_WINDOW;
      }
    }
    const pending = this.pendingRetry;
    if (pending && sim.time >= pending.at) {
      this.pendingRetry = null;
      this.restart(pending);
    }
    const m = this.active;
    if (!m) return;
    m.tick(dt);
    if (m.failedReason) this.finish(false, m.failedReason);
    else if (m.done) this.finish(true, '');
  }

  /**
   * A passed mission is marked done, paid and autosaved, once: at its goal (see MissionCtx.complete), before its
   * closing lines. Passed while the player is down, the save waits until he is back up (see update).
   */
  settle(m: MissionCtx): void {
    if (m.settled) return;
    m.settled = true;
    const sim = this.sim;
    sim.progress.markDone(m.def.id);
    sim.progress.addMoney(m.reward);
    sim.events.emit('money', { amount: m.reward });
    if (sim.playerDown) this.saveOnRespawn = true;
    else sim.events.emit('saveRequested', { poi: 'auto' });
  }

  /**
   * QUIT TO TITLE must finish a passed mission's pending autosave. A death during its outro
   * already ended the mission; settle that ending and its real respawn bill before discarding
   * the sim. Ordinary unsaved free roam and NEW GAME keep their existing discard semantics.
   */
  settleOnQuit(): void {
    const sim = this.sim;
    if (!this.saveOnRespawn && !(sim.playerDown && this.active?.settled)) return;
    if (this.active?.settled) this.finish(true, '');
    sim.finishRespawn();
    this.saveAfterRespawn();
  }

  /** Flush once after the respawn event and its complete money/equipment transaction. */
  saveAfterRespawn(): void {
    if (!this.saveOnRespawn || this.sim.playerDown) return;
    this.saveOnRespawn = false;
    this.sim.events.emit('saveRequested', { poi: 'auto' });
  }

  private finish(passed: boolean, reason: string): void {
    const sim = this.sim;
    const m = this.active;
    if (!m) return;
    this.active = null;
    m.cleanup();
    sim.wanted.floor = 0;
    const base = this.base;
    this.base = null;
    this.retry = null;
    let sub = reason;
    if (!passed && reason !== ABANDONED && base) {
      // After a wasted or busted the offer waits for the respawn (see armRetry); after a failure with the
      // police on him, until they are lost (see update): its window must not run out while he cannot take it.
      const down = reason === WASTED || reason === BUSTED;
      const cops = !down && sim.wanted.level > 0;
      this.retry = { id: m.def.id, resume: m.checkpointReached, ...base, failed: down ? null : takeLoadout(sim.player), until: down || cops ? null : sim.time + RETRY_WINDOW };
      if (!down) sub = `${reason} - ${retryHint(sim)}`;
    }
    if (passed) {
      // Settled at its goal already (see MissionCtx.complete), unless its script ended without one.
      const settled = m.settled;
      this.settle(m);
      sim.events.emit('big', { text: 'MISSION PASSED', sub: `$${m.reward.toLocaleString('en-US')}`, style: 'passed', duration: 5 });
      if (m.def.outro) sim.events.emit('big', { ...m.def.outro, style: 'title' });
      // Wasted or busted during its closing lines: saved again after the respawn, which pays the bill and keeps
      // what the police take, so a loaded game cannot undo either.
      if (settled && sim.playerDown) this.saveOnRespawn = true;
    } else {
      sim.events.emit('big', { text: 'MISSION FAILED', sub, style: 'failed', duration: 4.5 });
    }
    sim.events.emit('missionEnded', { id: m.def.id, passed });
    this.refreshMarkers();
  }

  /**
   * A respawn with a retry on offer: after a wasted / busted mission (or one interrupted during a retry's fade, or
   * waiting for the police to be lost) it opens the retry window.
   */
  private armRetry(): void {
    const r = this.retry;
    if (!r) return;
    const p = this.sim.player;
    // What he got since the failure and still has (the police keep what they take) stays his on the retry,
    // and what he gets from here on counts from his loadout now.
    if (r.failed) Object.assign(r, keepGains(p, r, r.failed));
    r.failed = takeLoadout(p);
    if (r.until === null) r.until = this.sim.time + RETRY_WINDOW;
  }

  /** The failed mission a retry would restart, while one is on offer. */
  retryOffer(): MissionDef | null {
    const r = this.retry;
    if (!r || r.until === null || this.sim.time >= r.until || this.active || this.sim.playerDown) return null;
    return this.defs.find((d) => d.id === r.id) ?? null;
  }

  /** The failed mission whose retry is offered once the police are lost (its window opens then), if any. */
  retryAfterCops(): MissionDef | null {
    const r = this.retry;
    if (!r || r.until !== null || !r.failed || this.active || this.sim.playerDown) return null;
    return this.defs.find((d) => d.id === r.id) ?? null;
  }

  /**
   * A failed mission remains recoverable from pause after the quick on-screen offer has expired. Seated in a vehicle
   * (or getting in) is fine: restart() takes him out of it.
   */
  retryMenuOffer(): { id: string; title: string; checkpoint: number; blocked: string | null } | null {
    const sim = this.sim;
    const r = this.retry;
    if (!r || this.active) return null;
    const def = this.defs.find((d) => d.id === r.id);
    if (!def) return null;
    const state = sim.player.state;
    const blocked = sim.playerDown || state === 'knocked' || state === 'dead' ? 'Wait until you recover to retry.'
      : sim.wanted.level > 0 ? 'Lose the cops before retrying.'
      : sim.activities.job?.kind === 'rampage' ? 'Finish the rampage first.'
      : null;
    return { id: def.id, title: def.title, checkpoint: r.resume, blocked };
  }

  /**
   * Restarts the failed mission on offer (the interact key, see Interactions): the screen fades,
   * the player gets his loadout from before the first attempt back, and the mission starts over at
   * its giver's marker without the intro, from its last checkpoint. False if there is nothing to
   * retry or the player cannot right now (wanted, on a rampage). The interact key also needs him
   * on foot, since in a vehicle it is the horn. A pause-menu action can use the retained offer
   * after the quick E prompt has expired, seated or not.
   */
  retryNow(fromMenu = false): boolean {
    const sim = this.sim;
    const r = this.retry;
    if (!r) return false;
    if (fromMenu) {
      const offer = this.retryMenuOffer();
      if (!offer || offer.blocked) return false;
      // An on-foot menu action commits an exit whose F might otherwise still be a cheat-code prefix.
      sim.activities.exitUndoable = false;
      sim.activities.cancelAll('mission');
    } else if (!this.retryOffer() || sim.wanted.level > 0 || sim.activities.busy || !sim.player.onFoot) return false;
    this.retry = null;
    sim.controlLock = Math.max(sim.controlLock, RETRY_FADE);
    sim.events.emit('fade', { duration: RETRY_FADE });
    this.pendingRetry = { ...r, at: sim.time + RETRY_SWAP };
    return true;
  }

  private restart(r: RetryOffer): void {
    const sim = this.sim;
    const def = this.defs.find((d) => d.id === r.id);
    if (!def || this.active || !this.available().includes(def)) return;
    if (sim.playerDown) {
      // Killed or busted during the fade: offer it again after the respawn (see armRetry).
      this.retry = { ...r, until: null };
      return;
    }
    if (sim.wanted.level > 0) {
      // Something drew the police during the fade: offer it again once they are lost, with a fresh window.
      this.retry = { ...r, failed: r.failed ?? takeLoadout(sim.player), until: null };
      return;
    }
    const p = sim.player;
    if (p.vehicle) sim.playerCtl.ejectPlayer(true);
    // A later retry starts from the same loadout, and keeps what he got this time too.
    this.base = keepGains(p, r, r.failed ?? takeLoadout(p));
    restoreLoadout(p, this.base);
    const giver = sim.world.layout.pois.find((q) => q.id === contactById(def.giver).poiId)!;
    const at = def.retryAt?.(sim.world) ?? { x: giver.x, z: giver.z, heading: giver.heading };
    const spot = sim.world.findFreeSpot(at.x, at.z, 0.5, 8) ?? at;
    p.state = 'normal';
    p.pos.x = spot.x;
    p.pos.z = spot.z;
    p.pos.y = sim.world.groundHeight(spot.x, spot.z);
    p.vel.x = 0;
    p.vel.y = 0;
    p.vel.z = 0;
    p.onGround = true;
    p.swimTime = 0;
    if (at.heading !== undefined) p.heading = at.heading;
    this.start(def.id, { retrying: true, resume: r.resume });
  }

  onPlayerDown(kind: 'wasted' | 'busted'): void {
    if (this.active) this.active.fail(kind === 'wasted' ? WASTED : BUSTED);
  }

  /** Abandons the current mission (pause menu). */
  abandon(): void {
    if (this.active) this.active.fail(ABANDONED);
  }
}
