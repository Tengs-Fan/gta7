// Mission framework. Missions are generator scripts that yield wait predicates;
// the runner resumes them synchronously inside Sim.update, which keeps the
// story deterministic and testable without any async timing.

import { rectContains, type Rect } from '../../world/layout';
import type { Objective } from '../activities';
import { makeBrain, type PedMode } from '../brains';
import type { Character, CharacterRole, Vehicle } from '../entities';
import type { Sim } from '../sim';
import type { VehicleKind, WeaponId } from '../specs';
import { STORY } from './story';

/**
 * A wait condition: the script resumes once it returns true. `dt` is the mission
 * time since the previous check (0 on the first check), so anything that
 * accumulates time stays correct at any frame rate.
 */
export type Wait = (dt: number) => boolean;
export type Script = Generator<Wait, void, undefined>;

export interface MissionDef {
  id: string;
  title: string;
  giver: 'lou' | 'dex';
  reward: number;
  requires: string[];
  blurb: string;
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
  timer: { label: string; endsAt: number; reason: string } | null = null;
  /** Free-form HUD counter (e.g. "VAULT 12/20"). */
  counter: string | null = null;
  private fails: FailCheck[] = [];
  private failSeq = 0;
  failedReason: string | null = null;
  done = false;
  private readonly it: Script;
  private current: Wait | null = null;
  /** Reward override (scripts may pay less for a damaged delivery). */
  reward: number;

  constructor(
    readonly sim: Sim,
    readonly def: MissionDef,
  ) {
    this.reward = def.reward;
    this.it = def.run(this);
  }

  // --- runner ---------------------------------------------------------------

  tick(dt: number): void {
    if (this.done || this.failedReason) return;
    this.time += dt;
    try {
      if (this.timer && this.sim.time >= this.timer.endsAt) {
        this.fail(this.timer.reason);
        return;
      }
      for (const f of this.fails) {
        if (f.check(dt)) {
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
    while (this.current === null || this.current(waited)) {
      // A wait yielded during this tick is checked right away, but it has not waited through this frame.
      waited = 0;
      if (++guard > 64) break;
      let r: IteratorResult<Wait, void>;
      try {
        r = this.it.next();
      } catch (err) {
        // A broken script must never take the game down with it.
        console.error(`Mission ${this.def.id} script error`, err);
        this.failedReason = this.failedReason ?? 'Something went wrong.';
        return;
      }
      if (this.failedReason) return;
      if (r.done) {
        this.done = true;
        return;
      }
      this.current = r.value;
    }
  }

  fail(reason: string): void {
    if (this.done || this.failedReason) return;
    this.failedReason = reason;
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

  *say(speaker: string, text: string, seconds?: number): Script {
    const s = seconds ?? Math.min(6, 1.6 + text.length * 0.055);
    this.sim.events.emit('subtitle', { speaker, text, duration: s });
    yield* this.wait(s);
  }

  objective(text: string): void {
    this.objectiveText = text;
    this.sim.events.emit('objective', { text });
  }

  /** Waits until the player reaches a point. Returns false when `abortIf` ended the wait instead. */
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
    } = {},
  ): Generator<Wait, boolean, undefined> {
    const marker: Objective = { x, z, label: opts.label ?? '', color: opts.color ?? 0xffd23d, radius: opts.radius ?? 3 };
    this.markers.push(marker);
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
        arrived = true;
        return true;
      };
    } finally {
      this.unmark(marker);
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
    this.markers.push(o);
    return o;
  }

  unmark(o: Objective): void {
    const i = this.markers.indexOf(o);
    if (i >= 0) this.markers.splice(i, 1);
  }

  failIf(check: (dt: number) => boolean, reason: string): number {
    const id = ++this.failSeq;
    this.fails.push({ id, check, reason });
    return id;
  }

  clearFail(id: number): void {
    this.fails = this.fails.filter((f) => f.id !== id);
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
    const v = this.sim.spawnVehicle(kind, x, z, heading, color);
    v.owner = 'mission';
    v.persistent = true;
    v.missionTag = this.def.id;
    this.vehicles.push(v);
    return v;
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

  givePlayer(weapon: WeaponId, ammo: number): void {
    const p = this.sim.player;
    const had = p.inventory.has(weapon);
    p.inventory.give(weapon, ammo);
    if (!had) p.inventory.current = weapon;
  }

  /** Releases or removes mission entities when the mission ends. */
  cleanup(): void {
    const sim = this.sim;
    for (const v of this.vehicles) {
      if (v.removed) continue;
      v.persistent = false;
      v.missionTag = '';
      v.owner = 'none';
      if (v.driver && !v.driver.isPlayer) {
        v.driver.persistent = false;
        v.driver.owner = 'traffic';
      }
    }
    for (const c of this.characters) {
      if (c.removed) continue;
      c.persistent = false;
      c.missionTag = '';
      c.owner = c.state === 'inVehicle' ? 'traffic' : 'ped';
      if (c.brain && c.alive && c.state !== 'inVehicle') {
        c.brain.hostile = false;
        c.brain.target = null;
        c.brain.mode = 'wander';
        c.brain.toNode = -1;
      }
    }
    this.markers.length = 0;
    void sim;
  }
}

export class MissionSystem {
  readonly defs: readonly MissionDef[] = STORY;
  active: MissionCtx | null = null;
  /** Debug / tests: disables arrests. */
  noBust = false;
  private refreshed = false;

  constructor(private readonly sim: Sim) {}

  available(): MissionDef[] {
    const prog = this.sim.progress;
    return this.defs.filter((d) => !prog.hasDone(d.id) && d.requires.every((r) => prog.hasDone(r)));
  }

  /** The next mission each contact offers. */
  offers(): MissionDef[] {
    const out: MissionDef[] = [];
    for (const giver of ['lou', 'dex'] as const) {
      const d = this.available().find((m) => m.giver === giver);
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
      const poi = sim.world.layout.pois.find((p) => p.id === d.giver)!;
      markers.push({ id: `mission:${d.id}`, kind: 'mission', x: poi.x, z: poi.z, radius: 1.6, label: `Press E to start "${d.title}"`, color: d.giver === 'lou' ? 0xff4fa3 : 0x38e1d2, ref: d.id });
    }
  }

  start(id: string): boolean {
    const sim = this.sim;
    if (this.active || sim.playerDown) return false;
    const def = this.defs.find((d) => d.id === id);
    if (!def || !this.available().includes(def)) return false;
    sim.activities.cancelAll('mission');
    this.active = new MissionCtx(sim, def);
    this.refreshMarkers();
    sim.events.emit('missionStarted', { id: def.id, title: def.title });
    sim.events.emit('big', { text: def.title.toUpperCase(), sub: def.giver === 'lou' ? 'Mama Lou' : 'Dex Moreau', style: 'title', duration: 3.5 });
    return true;
  }

  update(dt: number): void {
    if (!this.refreshed) {
      this.refreshed = true;
      this.refreshMarkers();
    }
    const m = this.active;
    if (!m) return;
    m.tick(dt);
    if (m.failedReason) this.finish(false, m.failedReason);
    else if (m.done) this.finish(true, '');
  }

  private finish(passed: boolean, reason: string): void {
    const sim = this.sim;
    const m = this.active;
    if (!m) return;
    this.active = null;
    m.cleanup();
    sim.wanted.floor = 0;
    if (passed) {
      sim.progress.markDone(m.def.id);
      sim.progress.addMoney(m.reward);
      sim.events.emit('money', { amount: m.reward });
      sim.events.emit('big', { text: 'MISSION PASSED', sub: `$${m.reward.toLocaleString('en-US')}`, style: 'passed', duration: 5 });
      sim.events.emit('saveRequested', { poi: 'auto' });
    } else {
      sim.events.emit('big', { text: 'MISSION FAILED', sub: reason, style: 'failed', duration: 4.5 });
    }
    sim.events.emit('missionEnded', { id: m.def.id, passed });
    this.refreshMarkers();
  }

  onPlayerDown(kind: 'wasted' | 'busted'): void {
    if (this.active) this.active.fail(kind === 'wasted' ? 'You got wasted.' : 'You got busted.');
  }

  /** Abandons the current mission (pause menu). */
  abandon(): void {
    if (this.active) this.active.fail('Mission abandoned.');
  }
}
