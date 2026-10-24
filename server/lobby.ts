// A room's multiplayer rules on top of the shared Sim: every player's own look, kills and car damage credited to the
// player who did them (kill feed, per-player kills and deaths), the head-to-head Street Run (open, join within the
// window, shared countdown, results) and the room state the clients' player list and race panel show.

import { FEED_EVENT, RACE_COMMAND, RACE_JOIN_WINDOW, RACE_START_REACH, ROOM_EVENT, type FeedEntry, type RaceCommand, type RaceView, type RoomPlayer, type RoomState } from '../src/net/lobby';
import type { JobHud } from '../src/net/protocol';
import { playerAppearance, playerColor } from '../src/sim/appearance';
import type { Character, Vehicle } from '../src/sim/entities';
import { HeadToHead } from '../src/sim/headToHead';
import type { PlayerInput } from '../src/sim/input';
import type { PlayerSlot } from '../src/sim/playerSlot';
import { streetRunCourses } from '../src/sim/activities/streetRun';
import { registerCommand } from './commands';
import type { Member, Room } from './room';

/** The room state goes out on every change, and at least this often (s) for clients that missed one. */
const STATE_EVERY = 2;

interface Stats {
  kills: number;
  deaths: number;
  carDamage: number;
}

export class RoomRules {
  race: HeadToHead | null = null;
  private raceHost = 0;
  /** Tick the race's entries close. */
  private closeTick = -1;
  private readonly stats = new Map<number, Stats>();
  private readonly stars = new Map<number, number>();
  private version = 0;
  private sentVersion = -1;
  private lastSentTick = -Infinity;

  constructor(private readonly room: Room) {
    const combat = room.sim.combat;
    const damageVehicle = combat.damageVehicle.bind(combat);
    // Credits car damage between players without touching the sim: combat calls this through the instance, also
    // from inside itself.
    combat.damageVehicle = (v, amount, attacker, kind) => {
      const before = v.health;
      const wasDestroyed = v.destroyed;
      damageVehicle(v, amount, attacker, kind);
      this.onCarDamage(v, attacker, Math.max(0, before - v.health), !wasDestroyed && v.destroyed);
    };
  }

  private get sim() {
    return this.room.sim;
  }

  private changed(): void {
    this.version++;
  }

  private slotOf(m: Member): PlayerSlot | undefined {
    return m.slot === null ? undefined : this.sim.players.find((s) => s.id === m.slot);
  }

  private wantedOf(m: Member): number {
    return m.slot === null ? 0 : this.room.slots.hud(m.slot).wanted;
  }

  private memberOfCharacter(c: Character | null | undefined): Member | null {
    if (!c || !c.isPlayer) return null;
    const slot = this.sim.slotOf(c);
    return slot ? this.room.memberOfSlot(slot.id) : null;
  }

  private statsOf(playerId: number): Stats {
    let s = this.stats.get(playerId);
    if (!s) this.stats.set(playerId, (s = { kills: 0, deaths: 0, carDamage: 0 }));
    return s;
  }

  // ---------------------------------------------------------------------------
  // Players

  /** A member has its slot: his own look (the slot's colour, details from his name). */
  onJoin(m: Member): void {
    this.statsOf(m.playerId);
    if (m.slot !== null) this.room.slots.character(m.slot).appearance = playerAppearance(m.slot, m.name);
    this.feed({ kind: 'join', text: `${m.name} joined` }, m);
    this.changed();
  }

  onLeave(m: Member, slot: number | null): void {
    if (this.race && slot !== null && this.race.racer(slot)?.entrant.id === m.playerId) {
      this.race.depart(slot, 'left');
      if (this.race.stage === 'lobby' && this.race.racers.length === 0) this.dropRace();
      else if (this.race.stage === 'lobby' && this.raceHost === m.playerId) this.raceHost = this.race.racers[0]!.entrant.id;
    }
    this.stats.delete(m.playerId);
    this.stars.delete(m.playerId);
    this.feed({ kind: 'leave', text: `${m.name} left` });
    this.changed();
  }

  /** A watcher promoted to a freed slot (slot providers with fewer slots than players). */
  onSlot(m: Member): void {
    if (m.slot !== null) this.room.slots.character(m.slot).appearance = playerAppearance(m.slot, m.name);
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // Per tick

  /** Before the sim steps: the job key at a course's start gate opens or joins its race instead of a solo run. */
  beforeStep(inputs: Map<number, PlayerInput>): void {
    for (const [slotId, inp] of inputs) {
      const slot = this.sim.players.find((s) => s.id === slotId);
      if (!slot) continue;
      const r = this.race?.racer(slot);
      // Racers' T does nothing during a race (no solo run, no other job).
      if (r && this.race!.stage !== 'lobby') {
        inp.job = false;
        continue;
      }
      if (!inp.job) continue;
      const course = this.courseNear(slot);
      if (!course) continue;
      inp.job = false;
      const m = this.room.memberOfSlot(slotId);
      if (!m) continue;
      if (r) this.command(m, JSON.stringify({ action: 'leave' } satisfies RaceCommand));
      else this.command(m, JSON.stringify({ action: this.race ? 'join' : 'open', course: course.id } satisfies RaceCommand));
    }
  }

  private courseNear(slot: PlayerSlot): ReturnType<typeof streetRunCourses>[number] | null {
    const p = slot.pos();
    for (const c of streetRunCourses(this.sim)) if (Math.hypot(c.start.x - p.x, c.start.z - p.z) <= RACE_START_REACH) return c;
    return null;
  }

  afterStep(): void {
    const tick = this.room.tick;
    const race = this.race;
    if (race) {
      const stage = race.stage;
      if (stage === 'lobby' && tick >= this.closeTick) this.startRace();
      else race.update(tick);
      if (race.stage !== stage) {
        this.changed();
        if (race.stage === 'results') this.announceResults();
      }
      if (race.done) this.dropRace();
      // Gates and finishes show in the panel as they happen.
      else if (race.stage === 'racing' && tick % 15 === 0) this.changed();
    }
    for (const m of this.room.members.values()) {
      const wanted = this.wantedOf(m);
      if (this.stars.get(m.playerId) !== wanted) {
        this.stars.set(m.playerId, wanted);
        this.changed();
      }
    }
    if (this.version !== this.sentVersion || (tick - this.lastSentTick) / this.room.opts.tickRate >= STATE_EVERY) this.sendState();
  }

  /** A sim event (the room sees every one): kills, arrests and car owners. */
  onSimEvent(type: string, payload: unknown): void {
    if (type === 'characterKilled') {
      const e = payload as { victim: Character; killer: Character | null };
      const victim = this.memberOfCharacter(e.victim);
      if (!victim) return;
      const killer = this.memberOfCharacter(e.killer);
      this.statsOf(victim.playerId).deaths++;
      const weapon = e.killer?.inventory.current;
      if (killer && killer !== victim) {
        this.statsOf(killer.playerId).kills++;
        this.feed({ kind: 'kill', text: `${killer.name} killed ${victim.name}`, killer: killer.name, victim: victim.name, killerId: killer.playerId, victimId: victim.playerId, weapon });
        this.message(victim, `${killer.name} killed you.`, 5);
        this.message(killer, `You killed ${victim.name}.`, 4);
      } else {
        const by = e.killer?.isLaw ? ' by the police' : '';
        this.feed({ kind: 'death', text: `${victim.name} was wasted${by}`, victim: victim.name, victimId: victim.playerId });
      }
      this.changed();
    } else if (type === 'busted') {
      const pid = (payload as { playerId?: number }).playerId ?? 0;
      const m = this.room.memberOfSlot(pid);
      if (m) this.feed({ kind: 'busted', text: `${m.name} was busted`, victim: m.name, victimId: m.playerId });
    }
  }

  private onCarDamage(v: Vehicle, attacker: Character | null, amount: number, destroyed: boolean): void {
    const by = this.memberOfCharacter(attacker);
    if (!by) return;
    const owner = this.memberOfCharacter(v.driver ?? v.lastDriver);
    if (!owner || owner === by) return;
    if (amount > 0) this.statsOf(by.playerId).carDamage += amount;
    if (destroyed) this.feed({ kind: 'wreck', text: `${by.name} wrecked ${owner.name}'s car`, killer: by.name, victim: owner.name, killerId: by.playerId, victimId: owner.playerId });
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // The head-to-head Street Run

  command(m: Member, arg: string): void {
    let cmd: RaceCommand;
    try {
      cmd = JSON.parse(arg) as RaceCommand;
    } catch {
      return;
    }
    const slot = this.slotOf(m);
    if (!slot) return;
    const race = this.race;
    switch (cmd.action) {
      case 'open': {
        if (race) {
          if (race.stage === 'lobby' && race.course.id === cmd.course) return this.command(m, JSON.stringify({ action: 'join' }));
          return this.message(m, race.stage === 'lobby' ? `${this.hostName()} has a race open: ${race.course.name}. Join that one or wait.` : 'A race is on. Wait for the results.');
        }
        const course = streetRunCourses(this.sim).find((c) => c.id === cmd.course);
        if (!course) return;
        const next = new HeadToHead(this.sim, course, this.room.opts.tickRate);
        const why = next.join(slot, { id: m.playerId, name: m.name });
        if (why) return this.message(m, why);
        this.race = next;
        this.raceHost = m.playerId;
        this.closeTick = this.room.tick + RACE_JOIN_WINDOW * this.room.opts.tickRate;
        this.feed({ kind: 'race', text: `${m.name} opened a head-to-head ${course.name}: join from the pause menu's STREET RUNS within ${RACE_JOIN_WINDOW} s` });
        this.message(m, `Race open: ${course.name}. Others have ${RACE_JOIN_WINDOW} s to join; START NOW in STREET RUNS starts it sooner.`, 5);
        this.changed();
        return;
      }
      case 'join': {
        if (!race || race.stage !== 'lobby') return this.message(m, 'No race is open to join.');
        if (cmd.course && cmd.course !== race.course.id) return this.message(m, `The open race is ${race.course.name}.`);
        if (race.racer(slot)) return;
        const why = race.join(slot, { id: m.playerId, name: m.name });
        if (why) return this.message(m, why);
        this.feed({ kind: 'race', text: `${m.name} joined the ${race.course.name} race` });
        this.changed();
        return;
      }
      case 'leave': {
        if (!race || !race.racer(slot)) return;
        race.leave(slot, 'quit');
        this.message(m, race.stage === 'lobby' ? 'You left the race.' : 'You quit the race.');
        if (race.stage === 'lobby' && race.racers.length === 0) this.dropRace();
        else if (race.stage === 'lobby' && this.raceHost === m.playerId) this.raceHost = race.racers[0]!.entrant.id;
        this.changed();
        return;
      }
      case 'start': {
        if (!race || race.stage !== 'lobby' || !race.racer(slot)) return;
        if (this.raceHost !== m.playerId) return this.message(m, `Only ${this.hostName()}, who opened it, can start the race early.`);
        this.startRace();
        this.changed();
        return;
      }
    }
  }

  private hostName(): string {
    return this.room.members.get(this.raceHost)?.name ?? this.race?.racers.find((r) => r.entrant.id === this.raceHost)?.entrant.name ?? 'Someone';
  }

  private startRace(): void {
    const race = this.race;
    if (!race || race.stage !== 'lobby') return;
    race.begin(this.room.tick, (slot) => playerColor(slot.id));
    this.changed();
  }

  private dropRace(): void {
    this.race?.release();
    this.race = null;
    this.raceHost = 0;
    this.closeTick = -1;
    this.changed();
  }

  private announceResults(): void {
    const race = this.race!;
    const winner = race.results().find((r) => r.position === 1);
    const name = winner?.name || null;
    this.feed({ kind: 'race', text: name ? `${name} won the ${race.course.name} race` : `Nobody finished the ${race.course.name} race` });
  }

  /** The race HUD (status line, gate marker) of a racer, in place of his side job's. */
  jobFor(slotId: number): JobHud | null {
    const race = this.race;
    if (!race) return null;
    const slot = this.sim.players.find((s) => s.id === slotId);
    if (!slot) return null;
    const h = race.hud(slot, this.room.tick);
    if (!h) return null;
    return { kind: 'headToHead', status: h.status, objectives: h.objectives.map((o) => ({ ...o, vehicle: 0, character: 0 })) };
  }

  /** Whether `slotId` is held by the race (the countdown's lock). */
  racing(slotId: number): boolean {
    const r = this.race?.racer(slotId);
    return !!r && this.race!.stage !== 'lobby';
  }

  // ---------------------------------------------------------------------------
  // To the clients

  raceView(): RaceView | null {
    const race = this.race;
    if (!race) return null;
    const res = race.results();
    const c = race.course;
    return {
      courseId: c.id,
      courseName: c.name,
      hostId: this.raceHost,
      hostName: this.hostName(),
      stage: race.stage,
      closeTick: race.stage === 'lobby' ? this.closeTick : -1,
      goTick: race.goTick,
      endTick: race.endTick,
      gates: c.checkpoints.length,
      medals: { gold: c.gold, silver: c.silver, bronze: c.bronze },
      entrants: res.map((r) => ({
        playerId: r.entrantId,
        name: r.name,
        status: r.status,
        gate: r.gates,
        position: r.position,
        time: r.time,
        finishTick: r.finishTick,
        medal: r.medal,
        reason: r.reason,
      })),
    };
  }

  state(): RoomState {
    const players: RoomPlayer[] = [...this.room.members.values()].map((m) => {
      const s = this.statsOf(m.playerId);
      return { playerId: m.playerId, name: m.name, slot: m.slot ?? -1, kills: s.kills, deaths: s.deaths, wanted: this.wantedOf(m), carDamage: Math.round(s.carDamage) };
    });
    return { version: this.version, tick: this.room.tick, tickRate: this.room.opts.tickRate, players, race: this.raceView() };
  }

  private sendState(): void {
    this.sentVersion = this.version;
    this.lastSentTick = this.room.tick;
    const data = this.state() as unknown as Record<string, unknown>;
    for (const m of this.room.members.values()) this.room.pushEvent(ROOM_EVENT, { state: data }, m.playerId);
  }

  /** A kill feed line for every player (`except` one: a joining player is not told he joined). */
  private feed(entry: FeedEntry, except?: Member): void {
    for (const m of this.room.members.values()) if (m !== except) this.room.pushEvent(FEED_EVENT, { ...entry }, m.playerId);
  }

  private message(m: Member, text: string, duration = 3): void {
    const slot = this.slotOf(m);
    if (slot) this.sim.events.emit('message', { text, duration, ...slot.tag });
  }
}

registerCommand(RACE_COMMAND, (room, m, arg) => room.rules.command(m, arg));
