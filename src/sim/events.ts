import type { DamageKind, HitZone } from './combat';
import type { Character, PickupKind, Vehicle } from './entities';
import type { WeaponId } from './specs';
import type { StreetRunId, StreetRunMedal } from './streetRuns';

export type BigStyle = 'title' | 'passed' | 'failed' | 'wasted' | 'busted' | 'stunt' | 'info';
export type HitKind = 'none' | 'world' | 'flesh' | 'vehicle';

/** The player an event is about; absent means player slot 0, the single-player seat. */
export interface PlayerScoped {
  playerId?: number;
}

/** Everything the presentation layer (renderer, audio, HUD) reacts to. Events about one player carry `playerId`. */
export interface SimEvents {
  /** One bullet, pellet or rocket launch; `pellet` is its 0-based index within the trigger pull (0 for single-shot weapons and helicopter rounds). */
  shot: { shooter: Character | null; weapon: WeaponId; fx: number; fy: number; fz: number; tx: number; ty: number; tz: number; hit: HitKind; nx: number; ny: number; nz: number; pellet: number };
  /** Exactly one per trigger pull of a gun (player, NPC, rocket launch) from the muzzle along the aim before spread. Not for melee or helicopter rounds. */
  weaponFired: { shooter: Character | null; weapon: WeaponId; x: number; y: number; z: number; dx: number; dy: number; dz: number; pellets: number };
  /** Every hit CombatSystem.damageCharacter applies, also one the armour absorbed completely; (dirX, dirZ) is the normalised hit direction, 0 when it has none. */
  damage: { victim: Character; attacker: Character | null; healthLoss: number; armourLoss: number; kind: DamageKind; zone: HitZone; killed: boolean; dirX: number; dirZ: number };
  explosion: { x: number; y: number; z: number; radius: number };
  impact: { x: number; y: number; z: number; strength: number; vehicle: Vehicle | null };
  blood: { x: number; y: number; z: number; dx: number; dy: number; dz: number };
  melee: { x: number; y: number; z: number; hit: boolean };
  propBroken: { index: number; dirX: number; dirZ: number };
  /** A vehicle grinding along a wall or another vehicle (at most 15 per second per vehicle); a grinding pair is reported once, for the faster car, with the slower as `other`. */
  scrape: { x: number; y: number; z: number; speed: number; vehicle: Vehicle; other?: Vehicle | null };
  splash: { x: number; y: number; z: number; big: boolean };
  /** A lightning strike in a storm, `dist` metres from the player (for the flash and the thunder's delay). */
  lightning: { x: number; z: number; dist: number };
  horn: { vehicle: Vehicle };
  vehicleEnter: { vehicle: Vehicle; character: Character; jacked: boolean };
  vehicleExit: { vehicle: Vehicle; character: Character };
  vehicleDestroyed: { vehicle: Vehicle };
  characterKilled: { victim: Character; killer: Character | null };
  pickup: { kind: PickupKind; x: number; y: number; z: number };
  money: { amount: number } & PlayerScoped;
  wanted: { level: number; previous: number } & PlayerScoped;
  /** A police radio line for the HUD's dispatch scanner (never a subtitle). */
  dispatch: { text: string } & PlayerScoped;
  wasted: PlayerScoped;
  busted: PlayerScoped;
  respawn: { where: 'hospital' | 'police' } & PlayerScoped;
  message: { text: string; duration: number } & PlayerScoped;
  subtitle: { speaker: string; text: string; duration: number } & PlayerScoped;
  big: { text: string; sub: string; style: BigStyle; duration: number } & PlayerScoped;
  objective: { text: string } & PlayerScoped;
  stunt: { airTime: number; distance: number; bonus: number; unique: boolean } & PlayerScoped;
  shopOpen: { poi: string } & PlayerScoped;
  saveRequested: { poi: string } & PlayerScoped;
  sprayed: { cost: number } & PlayerScoped;
  scream: { x: number; y: number; z: number };
  missionStarted: { id: string; title: string } & PlayerScoped;
  missionEnded: { id: string; passed: boolean } & PlayerScoped;
  /** A side activity is over, whatever the outcome. */
  activityEnded: { kind: string } & PlayerScoped;
  /** A paid side-activity milestone, after all of its cash, bonuses and progress have been committed. */
  activityMilestone: { kind: string; reward: number } & PlayerScoped;
  streetRunCountdown: { count: 0 | 1 | 2 | 3 } & PlayerScoped;
  streetRunCheckpoint: { index: number; total: number; elapsed: number } & PlayerScoped;
  /** Emitted after cash and records are committed, so autosave sees the result. */
  streetRunFinished: { id: StreetRunId; time: number; medal: StreetRunMedal; personalBest: boolean; reward: number } & PlayerScoped;
  reload: { character: Character };
  fade: { duration: number } & PlayerScoped;
}
