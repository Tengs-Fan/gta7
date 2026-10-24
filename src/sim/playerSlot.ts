// One human player's seat in the sim: the character, its controller, the camera pose the sim last saw, the death state,
// wanted record and progress. Sim.players[0] is the single-player seat; sim.player, sim.wanted and the like alias it.

import type { V3 } from '../core/math';
import type { Character } from './entities';
import { neutralInput, type PlayerInput } from './input';
import { PlayerController } from './player';
import { Progress } from './progress';
import type { Sim } from './sim';
import { WantedSystem } from './wanted';

export interface PlayerCheats {
  godMode: boolean;
  neverWanted: boolean;
}

/** `playerId` of the events a slot emits: explicit for every slot of a multiplayer sim, absent for the single-player seat. */
export type PlayerTag = { playerId?: number };

const NO_TAG: PlayerTag = {};

export class PlayerSlot {
  readonly ctl: PlayerController;
  readonly wanted: WantedSystem;
  readonly progress = new Progress();
  readonly cheats: PlayerCheats = { godMode: false, neverWanted: false };
  /** Camera pose from the last input, used for "is this visible" heuristics. */
  readonly cam: V3 = { x: 0, y: 0, z: 0 };
  readonly camDir: V3 = { x: 0, y: 0, z: 1 };
  /** The input this slot's controller last acted on. */
  input: PlayerInput = neutralInput();
  /** Seconds of control lock remaining (cutscenes, spray shop). */
  controlLock = 0;
  deathTimer = -1;
  deathKind: 'wasted' | 'busted' | null = null;
  /** Wanted level when the player was wasted or busted: the hospital bill and the bail scale with it. */
  deathLevel = 0;
  /** On the grid or on the course of a head-to-head race (set by the race each tick). */
  racing = false;
  private readonly explicitTag: PlayerTag;
  /**
   * Out of the world while nobody plays it (multiplayer: slot 0 between holders): its character is not in
   * sim.characters, and the sim leaves the slot out of everything players do or draw (streaming, police, pickups).
   */
  parked = false;

  constructor(private readonly sim: Sim, readonly id: number, public character: Character) {
    this.explicitTag = { playerId: id };
    this.wanted = new WantedSystem(sim, this);
    this.ctl = new PlayerController(sim, this);
  }

  /** Slot 0 of a sim with one slot and no server stays untagged, so single-player listeners see the payloads they always did. */
  get tag(): PlayerTag {
    return this.id !== 0 || this.sim.multiplayer || this.sim.players.length > 1 ? this.explicitTag : NO_TAG;
  }

  get down(): boolean {
    return this.deathKind !== null;
  }

  /** Where the player is: the vehicle he sits in, else himself. */
  pos(): V3 {
    return this.character.vehicle ? this.character.vehicle.pos : this.character.pos;
  }
}
