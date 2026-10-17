import type { DamageKind, HitZone } from './combat';
import type { Character, PickupKind, Vehicle } from './entities';
import type { WeaponId } from './specs';

export type BigStyle = 'title' | 'passed' | 'failed' | 'wasted' | 'busted' | 'stunt' | 'info';
export type HitKind = 'none' | 'world' | 'flesh' | 'vehicle';

/** Everything the presentation layer (renderer, audio, HUD) reacts to. */
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
  splash: { x: number; y: number; z: number; big: boolean };
  horn: { vehicle: Vehicle };
  vehicleEnter: { vehicle: Vehicle; character: Character; jacked: boolean };
  vehicleExit: { vehicle: Vehicle; character: Character };
  vehicleDestroyed: { vehicle: Vehicle };
  characterKilled: { victim: Character; killer: Character | null };
  pickup: { kind: PickupKind; x: number; y: number; z: number };
  money: { amount: number };
  wanted: { level: number; previous: number };
  /** A police radio line for the HUD's dispatch scanner (never a subtitle). */
  dispatch: { text: string };
  wasted: Record<string, never>;
  busted: Record<string, never>;
  respawn: { where: 'hospital' | 'police' };
  message: { text: string; duration: number };
  subtitle: { speaker: string; text: string; duration: number };
  big: { text: string; sub: string; style: BigStyle; duration: number };
  objective: { text: string };
  stunt: { airTime: number; distance: number; bonus: number; unique: boolean };
  shopOpen: { poi: string };
  saveRequested: { poi: string };
  sprayed: { cost: number };
  scream: { x: number; y: number; z: number };
  missionStarted: { id: string; title: string };
  missionEnded: { id: string; passed: boolean };
  /** A side activity (taxi, vigilante, rampage) is over, whatever the outcome. */
  activityEnded: { kind: 'taxi' | 'vigilante' | 'rampage' };
  reload: { character: Character };
  fade: { duration: number };
}
