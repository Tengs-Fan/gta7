import type { Character, Vehicle } from '../entities';
import type { Sim } from '../sim';
import type { PlayerView, ViewState } from '../viewState';
import type { RampageJob } from './rampage';
import type { StreetRunJob } from './streetRun';
import type { TaxiJob } from './taxi';
import type { VigilanteJob } from './vigilante';
import type { AmbulanceJob } from './ambulance';
import type { CourierJob } from './courier';
import type { ExportJob } from './carExport';
import type { FireJob } from './firefighter';

export interface Objective {
  x: number;
  z: number;
  label: string;
  /** Blip / marker colour. */
  color: number;
  radius: number;
  /** Follow an entity instead of a fixed point. */
  vehicle?: Vehicle | null;
  character?: Character | null;
}

/** The running activity's state; `kind` names the ActivityDef that owns it. */
export interface ActivityJob {
  kind: string;
}

/**
 * Job state by kind. An activity that adds a `declare module './types'` entry here is part of the `Activities.job`
 * union, so callers narrow on `job.kind` as they do for the built-in four.
 */
export interface JobKinds {
  taxi: TaxiJob;
  vigilante: VigilanteJob;
  rampage: RampageJob;
  streetRun: StreetRunJob;
  ambulance: AmbulanceJob;
  firefighter: FireJob;
  courier: CourierJob;
  carExport: ExportJob;
}

export type Job = JobKinds[keyof JobKinds];

/** The player's seat in the sim; today the player's Character. */
export type ActivitySlot = Character;

export type CancelReason = 'wasted' | 'busted' | 'mission';

/** What a def sees of the facade. Defs are shared by every Sim, so all per-run state lives in the job or the sim. */
export interface ActivityHost {
  readonly sim: Sim;
  /** The running job; a def's `start` sets it. */
  job: ActivityJob | null;
  say(text: string, duration?: number): void;
  /** Ends the running job: its def's `end` runs, then `activityEnded` and the text. */
  end(text: string): void;
  /**
   * The job holds still for the player, out of its car by a way out that may yet be undone (exitUndoable), as long as
   * that car can take him back: it still drives, nobody else sits at its wheel, and he is in no other vehicle.
   */
  waitsForPlayer(car: Vehicle): boolean;
}

export interface ActivityDef<J extends ActivityJob = ActivityJob> {
  readonly kind: J['kind'];
  /** Said when the job key ends the running job. Absent: the key leaves it running. */
  readonly toggleEndText?: string;
  /**
   * Which def the job key tries first: higher goes first, equals in registration order. Default 0; the street run is
   * -1 so that it stays the fallback for any vehicle nobody else claims.
   */
  readonly priority?: number;
  /** The job carries on on foot: E at a marker does not end it (as it does a vehicle job the player got out of). */
  readonly onFoot?: boolean;
  /** Whether the job key starts this activity for a player in `vehicle`. The first registered def to say yes is the one. */
  canStart(host: ActivityHost, slot: ActivitySlot, vehicle?: Vehicle | null): boolean;
  /** The prompt offered while `canStart` holds, or null when the activity is not on offer right now. */
  prompt(host: ActivityHost, slot: ActivitySlot, vehicle?: Vehicle | null): string | null;
  /** Begins the activity (setting `host.job`); false when it refuses. `arg` is the activity's own parameter. */
  start(host: ActivityHost, slot: ActivitySlot, vehicle?: Vehicle | null, arg?: string): boolean;
  /** Once per sim update while the job runs. */
  update(host: ActivityHost, job: J, dt: number): void;
  /** Cleans up after the job; the job is already cleared and `activityEnded` follows. */
  end(host: ActivityHost, job: J, reason: string): void;
  objectives(job: J): Objective[];
  status(job: J): string | null;
  /** The text that closes the job when the game ends it (death, arrest, a mission starting). Absent: '' for a mission, 'Job over.' otherwise. */
  abortText?(reason: CancelReason): string;
  /** Called once as each Activities facade is built, for listeners the activity keeps on the sim. */
  attach?(host: ActivityHost): void;
  /** Its row in the completion checklist (map screen, STATS): what counts as done of how much. Absent: no row. */
  completion?(view: ViewState, me: PlayerView): { label: string; done: number; total: number } | null;
}
