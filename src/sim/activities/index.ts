// Side activities: the registry of what the job key can start, and the facade the rest of the sim talks to.

import type { Character, Vehicle } from '../entities';
import type { PlayerSlot } from '../playerSlot';
import type { Sim } from '../sim';
import type { StreetRunCourse } from '../streetRuns';
import { cabActivity } from './cab';
import { rampageActivity } from './rampage';
import { onVehicleLanded } from './stunts';
import { streetRunActivity, streetRunCourses } from './streetRun';
import { placeOnSidewalk, taxiActivity } from './taxi';
import { vigilanteActivity } from './vigilante';
import { ambulanceActivity } from './ambulance';
import { carExportActivity } from './carExport';
import { courierActivity } from './courier';
import { firefighterActivity } from './firefighter';
import './serviceVehicles';
import type { ActivityDef, ActivityHost, ActivityJob, CancelReason, Job, Objective } from './types';

export type { CabJob } from './cab';
export type { RampageJob } from './rampage';
export type { StreetRunJob } from './streetRun';
export type { TaxiJob } from './taxi';
export type { VigilanteJob } from './vigilante';
export type { AmbulanceJob } from './ambulance';
export type { CourierJob } from './courier';
export type { ExportJob } from './carExport';
export type { FireJob } from './firefighter';
export type { ActivityDef, ActivityHost, ActivityJob, ActivitySlot, CancelReason, Job, JobKinds, Objective } from './types';

/** In the job key's order: the first def whose `canStart` holds starts, and its prompt is the one offered. */
const registry: ActivityDef[] = [];

export function registerActivity<J extends ActivityJob>(def: ActivityDef<J>): void {
  if (registry.some((d) => d.kind === def.kind)) throw new Error(`Activity "${def.kind}" is already registered`);
  const at = registry.findIndex((d) => (d.priority ?? 0) < (def.priority ?? 0));
  registry.splice(at < 0 ? registry.length : at, 0, def as ActivityDef);
}

export function unregisterActivity(kind: string): boolean {
  const i = registry.findIndex((d) => d.kind === kind);
  if (i < 0) return false;
  registry.splice(i, 1);
  return true;
}

export function getActivity(kind: string): ActivityDef | undefined {
  return registry.find((d) => d.kind === kind);
}

export function activityKinds(): string[] {
  return registry.map((d) => d.kind);
}

registerActivity(taxiActivity);
registerActivity(vigilanteActivity);
registerActivity(rampageActivity);
registerActivity(ambulanceActivity);
registerActivity(firefighterActivity);
registerActivity(courierActivity);
registerActivity(carExportActivity);
registerActivity(streetRunActivity);
registerActivity(cabActivity);

export class Activities {
  job: Job | null = null;
  /**
   * Set by the game each frame: the player's last way out of a vehicle may yet be undone. FIXMYRIDE puts him back in
   * the seat its own F got him out of, and that F acts at once (see exitAtStake in game.ts), so a taxi or vigilante job
   * waits for him while the code is typed, instead of ending as he gets out.
   */
  exitUndoable = false;

  private readonly host: ActivityHost;

  constructor(private readonly sim: Sim) {
    const self = this;
    this.host = {
      sim,
      get job() {
        return self.job;
      },
      set job(j: ActivityJob | null) {
        self.job = j as Job | null;
      },
      say: (text, duration) => this.say(text, duration),
      end: (text) => this.end(text),
      waitsForPlayer: (car) => sim.player.vehicle === null && this.exitUndoable && !car.removed && car.drivable && car.driver === null,
    };
    for (const def of registry) def.attach?.(this.host);
  }

  get busy(): boolean {
    return this.job !== null;
  }

  /** Current objective markers for the HUD / renderer. */
  objectives(): Objective[] {
    const j = this.job;
    return j ? (getActivity(j.kind)?.objectives(j) ?? []) : [];
  }

  /** HUD timer / counter text. */
  status(): string | null {
    const j = this.job;
    return j ? (getActivity(j.kind)?.status(j) ?? null) : null;
  }

  /** The T-key prompt for the player's vehicle: what the job key would start there right now, if anything. */
  jobPrompt(who: PlayerSlot | Character = this.sim.players[0]!): string | null {
    const slot = this.jobSeat(who);
    const v = slot?.vehicle;
    if (!slot || !v || this.busy || this.sim.missions.active) return null;
    const def = this.startableBy(slot, v);
    return def ? def.prompt(this.host, slot, v) : null;
  }

  /**
   * The job key pressed by a player (slot 0 by default). There is one job at a time and it belongs to slot 0, so the
   * key does nothing for any other slot: it neither starts a job for it nor ends slot 0's.
   */
  toggleJob(who: PlayerSlot | Character = this.sim.players[0]!): void {
    const slot = this.jobSeat(who);
    if (!slot) return;
    const v = slot.vehicle;
    const running = this.job ? getActivity(this.job.kind) : undefined;
    if (this.job && running?.toggleEndText !== undefined) {
      this.end(running.toggleEndText);
      return;
    }
    if (this.job || this.sim.missions.active) return;
    if (!v) return;
    this.startableBy(slot, v)?.start(this.host, slot, v);
  }

  /** The character of the player the single job belongs to, if `who` is that player. */
  private jobSeat(who: PlayerSlot | Character): Character | null {
    const owner = this.sim.players[0]!;
    const c = this.sim.resolveSlot(who)?.character ?? (who as Character);
    return c === owner.character ? c : null;
  }

  /** Whether `passenger` stays seated as `driver` takes the wheel of `v`: the running job of that player says so. */
  keepsPassenger(driver: Character, v: Vehicle, passenger: Character): boolean {
    const j = this.job;
    if (!j || this.jobSeat(driver) === null) return false;
    return getActivity(j.kind)?.keepsAboard?.(j, passenger, v) ?? false;
  }

  cancelAll(reason: CancelReason): void {
    const j = this.job;
    if (!j) return;
    const abort = getActivity(j.kind)?.abortText;
    this.end(abort ? abort(reason) : reason === 'mission' ? '' : 'Job over.');
  }

  streetRunCourses(): readonly StreetRunCourse[] {
    return streetRunCourses(this.sim);
  }

  /** Start the requested course, or the nearest start gate in free roam. */
  startStreetRun(courseId?: string): boolean {
    return streetRunActivity.start(this.host, this.sim.player, this.sim.player.vehicle, courseId);
  }

  startRampage(tag: string): boolean {
    return rampageActivity.start(this.host, this.sim.player, this.sim.player.vehicle, tag);
  }

  /** Takes Lou's export list (her board's marker): false while a job or a mission runs. */
  startExport(): boolean {
    if (this.busy || this.sim.missions.active) return false;
    return carExportActivity.start(this.host, this.sim.player, this.sim.player.vehicle);
  }

  /** Lets a fare out of `v` on the curb side (also called directly by tests). */
  placeOnSidewalk(c: Character, v: Vehicle, towardX?: number, towardZ?: number): void {
    placeOnSidewalk(this.host, c, v, towardX, towardZ);
  }

  onVehicleLanded(v: Vehicle): void {
    onVehicleLanded(this.sim, v);
  }

  update(dt: number): void {
    const j = this.job;
    if (!j || this.sim.playerDown || !(dt > 0) || !Number.isFinite(dt)) return;
    getActivity(j.kind)?.update(this.host, j, dt);
  }

  private startableBy(slot: Character, v: Vehicle): ActivityDef | undefined {
    return registry.find((d) => d.canStart(this.host, slot, v));
  }

  private say(text: string, duration = 3): void {
    if (text) this.sim.events.emit('message', { text, duration });
  }

  private end(text: string): void {
    const j = this.job;
    this.job = null;
    if (!j) return;
    getActivity(j.kind)?.end(this.host, j, text);
    this.sim.events.emit('activityEnded', { kind: j.kind });
    this.say(text);
  }
}
