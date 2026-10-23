// How a room's players map onto PlayerSlots of its Sim. PlayerSlotProvider (the default) gives every joining player
// his own PlayerSlot in sim.players; SingleSlotProvider (one player drives slot 0, the others watch) and
// PuppetSlotProvider (--dev --puppets: inert walkers) remain for tests and measurements.

import type { Character } from '../src/sim/entities';
import { neutralInput, type PlayerInput } from '../src/sim/input';
import type { PlayerSlot } from '../src/sim/playerSlot';
import type { Sim } from '../src/sim/sim';
import { captureHud, captureJob } from '../src/sim/snapshot';
import type { Hud, JobHud } from '../src/net/protocol';

export interface SlotProvider {
  /** PlayerSlots players can control. */
  readonly capacity: number;
  /** Claims a free slot for a joining player, or returns null when none is free (the player watches). */
  claim(playerId: number): number | null;
  /**
   * Frees a slot when its player leaves. A provider that removes the slot's character must unseat it first, so its
   * vehicle stays behind empty (never with a ghost driver).
   */
  release(slot: number): void;
  /** The character a slot controls (also the one a watcher follows). */
  character(slot: number): Character;
  /** Every claimed slot's character: all of them go to every client at any distance. */
  characters(): Character[];
  hud(slot: number): Hud;
  /** The slot's side job for its HUD (kind '' when it runs none). */
  job(slot: number): JobHud;
  /** The slot a player-scoped sim event belongs to (its payload's playerId; undefined means slot 0). */
  slotOfEvent(playerId: number | undefined): number;
  /** One fixed tick: each claimed slot's input (a slot without one gets a neutral input). */
  step(dt: number, inputs: ReadonlyMap<number, PlayerInput>): void;
}

/** A plausible camera behind the character, for the Sim's visibility heuristics when a client sends none. */
export function withCamera(c: Character, inp: PlayerInput): PlayerInput {
  const o = inp.aimOrigin;
  if (o.x !== 0 || o.y !== 0 || o.z !== 0) return inp;
  const p = c.vehicle ? c.vehicle.pos : c.pos;
  const h = c.vehicle ? c.vehicle.heading : c.heading;
  inp.aimOrigin = { x: p.x - Math.sin(h) * 6, y: p.y + 3, z: p.z - Math.cos(h) * 6 };
  inp.aimDir = { x: Math.sin(h), y: -0.15, z: Math.cos(h) };
  return inp;
}

const NO_JOB: JobHud = { kind: '', status: '', objectives: [] };

/** Where the n-th player to join stands: on the sidewalk by the safehouse door, a couple of metres apart. */
function spawnSpot(sim: Sim, n: number): { x: number; z: number } {
  const home = sim.world.layout.pois.find((p) => p.id === 'safehouse')!;
  const along = (n % 4) * 1.6 - 2.4;
  const out = 3.2 + Math.floor(n / 4) * 1.6;
  const x = home.x + Math.cos(home.heading) * out + Math.sin(home.heading) * along;
  const z = home.z - Math.sin(home.heading) * out + Math.cos(home.heading) * along;
  return sim.world.findFreeSpot(x, z, 0.5, 8) ?? { x, z };
}

/**
 * Every player is a real PlayerSlot of the room's Sim (controller, weapons, wanted level, pursuit, job): the first to
 * join takes slot 0 (parked while nobody holds it, see Sim.parkPlayer), later ones get sim.addPlayer slots, and a
 * player who leaves is taken out of the sim (his car stays behind, empty).
 */
export class PlayerSlotProvider implements SlotProvider {
  private readonly holders = new Map<number, number>();
  private joins = 0;

  constructor(private readonly sim: Sim, readonly capacity = 8) {
    sim.parkPlayer(sim.players[0]!);
  }

  private slot(id: number): PlayerSlot | undefined {
    return this.sim.players.find((s) => s.id === id);
  }

  claim(playerId: number): number | null {
    if (this.holders.size >= this.capacity) return null;
    const sim = this.sim;
    const at = spawnSpot(sim, this.joins++ % 12);
    let slot: PlayerSlot;
    if (!this.holders.has(0)) {
      slot = sim.players[0]!;
      sim.unparkPlayer(slot, at.x, at.z);
    } else slot = sim.addPlayer(at.x, at.z);
    const home = sim.world.layout.pois.find((p) => p.id === 'safehouse')!;
    slot.character.heading = home.heading;
    this.holders.set(slot.id, playerId);
    return slot.id;
  }

  release(id: number): void {
    if (!this.holders.delete(id)) return;
    const slot = this.slot(id);
    if (!slot) return;
    if (id === 0) this.sim.parkPlayer(slot);
    else this.sim.removePlayer(slot);
  }

  character(id: number): Character {
    return (this.slot(id) ?? this.sim.players[0]!).character;
  }

  characters(): Character[] {
    return this.sim.activePlayers().map((s) => s.character);
  }

  hud(id: number): Hud {
    return captureHud(this.slot(id) ?? this.sim.players[0]!);
  }

  job(id: number): JobHud {
    const slot = this.slot(id);
    return slot ? captureJob(this.sim, slot) : NO_JOB;
  }

  slotOfEvent(playerId: number | undefined): number {
    return playerId ?? 0;
  }

  step(dt: number, inputs: ReadonlyMap<number, PlayerInput>): void {
    const map = new Map<number, PlayerInput>();
    for (const s of this.sim.activePlayers()) map.set(s.id, withCamera(s.character, inputs.get(s.id) ?? neutralInput()));
    this.sim.update(dt, map);
  }
}

export class SingleSlotProvider implements SlotProvider {
  readonly capacity = 1;
  private holder: number | null = null;

  constructor(private readonly sim: Sim) {}

  claim(playerId: number): number | null {
    if (this.holder !== null) return null;
    this.holder = playerId;
    return 0;
  }

  release(slot: number): void {
    if (slot === 0) this.holder = null;
  }

  character(): Character {
    return this.sim.player;
  }

  characters(): Character[] {
    return [this.sim.player];
  }

  hud(): Hud {
    return captureHud(this.sim.players[0]!);
  }

  job(): JobHud {
    return captureJob(this.sim, this.sim.players[0]!);
  }

  slotOfEvent(): number {
    return 0;
  }

  step(dt: number, inputs: ReadonlyMap<number, PlayerInput>): void {
    const inp = inputs.get(0) ?? neutralInput();
    this.sim.update(dt, withCamera(this.sim.player, inp));
  }
}

/**
 * A stand-in for the multi-player Sim (dev and tests only, `--dev --puppets`): slot 0 is the Sim's real player and
 * slots 1..capacity-1 are extra 'player' characters that only walk where their input's move axes point (no entering
 * cars, no weapons, no wanted level). It exercises everything the server does per slot (join, leave, interest, roster,
 * snapshots) before mp-core gives every slot a real PlayerController.
 */
export class PuppetSlotProvider implements SlotProvider {
  private readonly holders: Array<number | null>;
  private readonly puppets: Array<Character | null>;

  constructor(private readonly sim: Sim, readonly capacity = 8) {
    this.holders = new Array<number | null>(capacity).fill(null);
    this.puppets = new Array<Character | null>(capacity).fill(null);
  }

  claim(playerId: number): number | null {
    const slot = this.holders.indexOf(null);
    if (slot < 0) return null;
    this.holders[slot] = playerId;
    if (slot > 0) {
      const p = this.sim.player.pos;
      const spot = this.sim.world.findFreeSpot(p.x + 2 * slot, p.z + 1.5, 0.5, 12) ?? { x: p.x + 2 * slot, z: p.z };
      const c = this.sim.spawnCharacter('player', spot.x, spot.z);
      c.persistent = true;
      c.heading = this.sim.player.heading;
      this.puppets[slot] = c;
    }
    return slot;
  }

  release(slot: number): void {
    if (slot < 0 || slot >= this.capacity) return;
    this.holders[slot] = null;
    const c = this.puppets[slot];
    if (c) {
      // Out of its seat first: a car it sat in stays behind empty.
      if (c.vehicle) this.sim.unseat(c);
      this.sim.removeCharacter(c);
      this.puppets[slot] = null;
    }
  }

  character(slot: number): Character {
    return (slot > 0 ? this.puppets[slot] : null) ?? this.sim.player;
  }

  characters(): Character[] {
    const out: Character[] = [this.sim.player];
    for (const c of this.puppets) if (c && !c.removed) out.push(c);
    return out;
  }

  hud(slot: number): Hud {
    if (slot === 0) return captureHud(this.sim.players[0]!);
    return { wanted: 0, searching: false, money: 0, clip: 0, ammo: 0 };
  }

  job(slot: number): JobHud {
    return slot === 0 ? captureJob(this.sim, this.sim.players[0]!) : NO_JOB;
  }

  slotOfEvent(): number {
    return 0;
  }

  step(dt: number, inputs: ReadonlyMap<number, PlayerInput>): void {
    for (let s = 1; s < this.capacity; s++) {
      const c = this.puppets[s];
      if (!c || c.removed || c.state !== 'normal') continue;
      const inp = inputs.get(s) ?? neutralInput();
      const fx = Math.sin(inp.cameraYaw);
      const fz = Math.cos(inp.cameraYaw);
      const dx = fx * inp.moveZ - fz * inp.moveX;
      const dz = fz * inp.moveZ + fx * inp.moveX;
      const m = Math.min(1, Math.hypot(dx, dz));
      c.moveX = m > 1e-6 ? dx / Math.hypot(dx, dz) : 0;
      c.moveZ = m > 1e-6 ? dz / Math.hypot(dx, dz) : 0;
      c.moveSpeed = m > 0.05 ? (inp.sprint ? 7.4 : 4.3) * m : 0;
      if (m > 0.05) c.heading = Math.atan2(c.moveX, c.moveZ);
      c.wantJump = inp.jump;
    }
    const inp = inputs.get(0) ?? neutralInput();
    this.sim.update(dt, withCamera(this.sim.player, inp));
  }
}
