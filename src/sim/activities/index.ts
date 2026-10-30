// Side activities: the registry of what the job key can start, and the facade the rest of the sim talks to.

import type { Character, Vehicle } from '../entities';
import type { PlayerSlot } from '../playerSlot';
import { slotSim } from '../slotView';
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
import { monorailActivity } from './monorail';
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
export type { MonorailJob } from './monorail';
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
registerActivity(monorailActivity);

export class Activities {
  /** Slot 0's job (single player's only one); other slots' jobs are behind jobOf. */
  job: Job | null = null;
  /**
   * Set by the game each frame: the player's last way out of a vehicle may yet be undone. FIXMYRIDE puts him back in
   * the seat its own F got him out of, and that F acts at once (see exitAtStake in game.ts), so a taxi or vigilante job
   * waits for him while the code is typed, instead of ending as he gets out.
   */
  exitUndoable = false;

  private readonly host: ActivityHost;
  /** The hosts (and jobs) of the slots other than 0, by slot id: every player runs his own job. */
  private readonly others = new Map<number, { host: ActivityHost; job: Job | null }>();

  constructor(private readonly sim: Sim) {
    const self = this;
    this.host = {
      sim,
      get slot() {
        return sim.players[0]!;
      },
      hostOf: (slot) => this.hostOf(slot),
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

  /** The activity host of a slot: slot 0's runs on the sim itself, another's on that slot's view of it (slotSim). */
  hostOf(who: PlayerSlot): ActivityHost {
    if (who.id === 0) return this.host;
    const id = who.id;
    let entry = this.others.get(id);
    if (!entry) {
      const sim = this.sim;
      const e: { host: ActivityHost; job: Job | null } = { host: null as unknown as ActivityHost, job: null };
      const slotNow = () => sim.players.find((s) => s.id === id) ?? who;
      e.host = {
        sim: slotSim(sim, who),
        get slot() {
          return slotNow();
        },
        hostOf: (slot) => this.hostOf(slot),
        get job() {
          return e.job;
        },
        set job(j: ActivityJob | null) {
          e.job = j as Job | null;
        },
        say: (text, duration) => this.say(text, duration, slotNow()),
        end: (text) => this.end(text, slotNow()),
        // FIXMYRIDE (single player only) is the only way out of a car that may yet be undone.
        waitsForPlayer: () => false,
      };
      entry = e;
      this.others.set(id, entry);
    }
    return entry.host;
  }

  /** The job player `who` runs (slot 0 by default), or null. */
  jobOf(who: PlayerSlot | Character | number = this.sim.players[0]!): Job | null {
    const slot = this.sim.resolveSlot(who);
    if (!slot || slot.id === 0) return slot ? this.job : null;
    return this.others.get(slot.id)?.job ?? null;
  }

  get busy(): boolean {
    return this.job !== null;
  }

  /** Whether player `who` runs a job. */
  busyFor(who: PlayerSlot | Character | number): boolean {
    return this.jobOf(who) !== null;
  }

  /** Current objective markers for the HUD / renderer (slot 0's by default). */
  objectives(who: PlayerSlot | Character | number = this.sim.players[0]!): Objective[] {
    const j = this.jobOf(who);
    return j ? (getActivity(j.kind)?.objectives(j) ?? []) : [];
  }

  /** HUD timer / counter text (slot 0's by default). */
  status(who: PlayerSlot | Character | number = this.sim.players[0]!): string | null {
    const j = this.jobOf(who);
    return j ? (getActivity(j.kind)?.status(j) ?? null) : null;
  }

  /** Story missions are slot 0's: one running keeps slot 0 from starting a job, never another slot. */
  private missionFor(slot: PlayerSlot): boolean {
    return slot.id === 0 && this.sim.missions.active !== null;
  }

  /** The T-key prompt for the player's vehicle: what the job key would start there right now, if anything. */
  jobPrompt(who: PlayerSlot | Character = this.sim.players[0]!): string | null {
    const slot = this.sim.resolveSlot(who);
    const c = slot?.character;
    const v = c?.vehicle;
    if (!slot || !c || !v || this.busyFor(slot) || this.missionFor(slot)) return null;
    const host = this.hostOf(slot);
    const def = this.startableBy(host, c, v);
    return def ? def.prompt(host, c, v) : null;
  }

  /** The job key pressed by a player (slot 0 by default): it ends or starts that player's own job only. */
  toggleJob(who: PlayerSlot | Character = this.sim.players[0]!): void {
    const slot = this.sim.resolveSlot(who);
    if (!slot) return;
    const c = slot.character;
    const v = c.vehicle;
    const job = this.jobOf(slot);
    const running = job ? getActivity(job.kind) : undefined;
    if (job && running?.toggleEndText !== undefined) {
      this.end(running.toggleEndText, slot);
      return;
    }
    if (job || this.missionFor(slot)) return;
    if (!v) return;
    const host = this.hostOf(slot);
    this.startableBy(host, c, v)?.start(host, c, v);
  }

  /** Whether `passenger` stays seated as `driver` takes the wheel of `v`: the running job of that driver says so. */
  keepsPassenger(driver: Character, v: Vehicle, passenger: Character): boolean {
    const j = this.jobOf(driver);
    if (!j) return false;
    return getActivity(j.kind)?.keepsAboard?.(j, passenger, v) ?? false;
  }

  /** Ends the job of `slot` (slot 0 by default) for `reason`, with its def's closing text. */
  cancelAll(reason: CancelReason, slot: PlayerSlot = this.sim.players[0]!): void {
    const j = this.jobOf(slot);
    if (!j) return;
    const abort = getActivity(j.kind)?.abortText;
    this.end(abort ? abort(reason) : reason === 'mission' ? '' : 'Job over.', slot);
  }

  streetRunCourses(): readonly StreetRunCourse[] {
    return streetRunCourses(this.sim);
  }

  /** Start the requested course, or the nearest start gate in free roam (for slot 0 by default). */
  startStreetRun(courseId?: string, who: PlayerSlot = this.sim.players[0]!): boolean {
    return streetRunActivity.start(this.hostOf(who), who.character, who.character.vehicle, courseId);
  }

  startRampage(tag: string, who: PlayerSlot = this.sim.players[0]!): boolean {
    return rampageActivity.start(this.hostOf(who), who.character, who.character.vehicle, tag);
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
    // The bonus is the driver's: his money, his record, his HUD.
    const slot = this.sim.slotOf(v.driver);
    onVehicleLanded(slot ? slotSim(this.sim, slot) : this.sim, v);
  }

  update(dt: number): void {
    const j = this.job;
    if (j && !this.sim.playerDown) getActivity(j.kind)?.update(this.host, j, dt);
    if (this.others.size === 0) return;
    for (const slot of this.sim.players) {
      if (slot.id === 0 || slot.down || slot.parked) continue;
      const e = this.others.get(slot.id);
      if (e?.job) getActivity(e.job.kind)?.update(e.host, e.job, dt);
    }
  }

  private startableBy(host: ActivityHost, c: Character, v: Vehicle): ActivityDef | undefined {
    return registry.find((d) => d.canStart(host, c, v));
  }

  private say(text: string, duration = 3, slot?: PlayerSlot): void {
    if (text) this.sim.events.emit('message', { text, duration, ...slot?.tag });
  }

  private end(text: string, slot: PlayerSlot = this.sim.players[0]!): void {
    const j = this.jobOf(slot);
    if (!j) return;
    const host = this.hostOf(slot);
    host.job = null;
    getActivity(j.kind)?.end(host, j, text);
    this.sim.events.emit('activityEnded', { kind: j.kind, ...slot.tag });
    this.say(text, 3, slot);
  }
}
