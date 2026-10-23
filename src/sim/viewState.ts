// What the presentation layer (renderer, camera, crowd, HUD, hints, map, menus, audio) may read of the game. Sim
// satisfies it; a network client's mirror of the server's state can too. Types only: nothing here imports three.js or the DOM.

import type { Emitter } from '../core/emitter';
import type { V3 } from '../core/math';
import type { RoadNetwork } from '../world/roads';
import type { StaticWorld } from '../world/staticWorld';
import type { Activities } from './activities';
import type { GameClock } from './clock';
import type { CombatSystem } from './combat';
import type { Character, Helicopter, Pickup, Projectile, Vehicle } from './entities';
import type { SimEvents } from './events';
import type { Interactions } from './interactions';
import type { MissionSystem } from './missions/runner';
import type { PlayerController } from './player';
import type { PlayerCheats, PlayerTag } from './playerSlot';
import type { Progress } from './progress';
import type { WantedSystem } from './wanted';
import type { WeatherSystem } from './weather';

/** What the screens read of one player's wanted record. */
export type WantedView = Pick<WantedSystem, 'level' | 'searching' | 'floor' | 'searchCenter' | 'searchRadius' | 'evadeProgress' | 'lastSeenX' | 'lastSeenZ'>;

/** One player's seat, as the presentation sees it. PlayerSlot satisfies it. */
export interface PlayerView {
  readonly id: number;
  readonly character: Character;
  /** `playerId` for the events about this player; empty for slot 0. */
  readonly tag: PlayerTag;
  readonly ctl: Pick<PlayerController, 'findEnterable'>;
  readonly wanted: WantedView;
  readonly progress: Progress;
  readonly cheats: PlayerCheats;
  readonly controlLock: number;
  readonly deathKind: 'wasted' | 'busted' | null;
  readonly deathTimer: number;
  /** Wasted or busted, waiting to respawn. */
  readonly down: boolean;
  /** Where the player is: the vehicle he sits in, else himself. */
  pos(): V3;
}

export type MissionView = Pick<MissionSystem, 'active' | 'defs' | 'offers' | 'retryOffer' | 'retryMenuOffer' | 'retryAfterCops'>;
export type ActivitiesView = Pick<Activities, 'busy' | 'job' | 'objectives' | 'status' | 'streetRunCourses' | 'jobPrompt'>;
export type InteractionsView = Pick<Interactions, 'markers' | 'current' | 'canSave' | 'prompt' | 'priceOf' | 'buy'>;
/** Throws in flight and ground fires are optional: a view without them draws none. */
export type CombatView = Pick<CombatSystem, 'muzzleBlocked'> & Partial<Pick<CombatSystem, 'throws' | 'fire'>>;

export interface ViewState {
  readonly world: StaticWorld;
  readonly roads: RoadNetwork;
  readonly events: Emitter<SimEvents>;
  readonly clock: GameClock;
  readonly weather: Pick<WeatherSystem, 'state'>;
  readonly time: number;
  readonly frame: number;
  readonly characters: readonly Character[];
  readonly vehicles: readonly Vehicle[];
  readonly pickups: readonly Pickup[];
  readonly projectiles: readonly Projectile[];
  readonly helis: readonly Helicopter[];
  /** Every player in the game; `localPlayerId` picks the one this screen belongs to. */
  readonly players: readonly PlayerView[];
  readonly missions: MissionView;
  readonly activities: ActivitiesView;
  readonly interactions: InteractionsView;
  readonly combat: CombatView;
}

/** The local player's seat: the slot with that id, or the first one while it has not joined yet. */
export function playerOf(view: ViewState, localPlayerId: number): PlayerView {
  return view.players.find((p) => p.id === localPlayerId) ?? view.players[0]!;
}
