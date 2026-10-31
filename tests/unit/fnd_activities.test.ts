import { afterEach, describe, expect, it } from 'vitest';
import { Activities, activityKinds, getActivity, registerActivity, unregisterActivity, type ActivityDef, type ActivityJob, type Objective } from '../../src/sim/activities';
import type { Vehicle } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import type { Sim } from '../../src/sim/sim';
import { makeSim, placeInCar, roadPoint, step } from './helpers';

/** Every public member the facade had before the registry, named so that removing or renaming one fails the typecheck. */
type BaselineFacade = Pick<Activities,
  'job' | 'busy' | 'exitUndoable' | 'objectives' | 'status' | 'toggleJob' | 'cancelAll' | 'streetRunCourses' | 'startStreetRun' | 'startRampage' | 'onVehicleLanded' | 'update' | 'placeOnSidewalk' | 'jobPrompt'>;
const _facadeKeepsItsApi = (a: Activities): BaselineFacade => a;
void _facadeKeepsItsApi;

function driverIn(sim: Sim, kind: Parameters<Sim['spawnVehicle']>[0]): Vehicle {
  const road = roadPoint(sim);
  const car = sim.spawnVehicle(kind, road.x, road.z, road.heading);
  placeInCar(sim, car);
  car.speed = 0;
  return car;
}

/** What game.ts asked before the prompt moved to the registry. */
function baselinePrompt(sim: Sim): string | null {
  const v = sim.player.vehicle;
  if (!v || sim.activities.busy || sim.missions.active) return null;
  if (v.kind === 'taxi' && v.speed < 1) return 'Press T to start a taxi job';
  if (v.spec.police && v.speed < 1) return 'Press T to start a vigilante job';
  if (v.drivable && !v.burning && v.speed < 1 && sim.wanted.level === 0) return 'Press T to start a street run';
  return null;
}

interface FixtureJob extends ActivityJob {
  kind: 'fixture';
  ticks: number;
}

function fixture(calls: { updates: number[]; ends: string[] }): ActivityDef<FixtureJob> {
  return {
    kind: 'fixture',
    toggleEndText: 'Fixture over.',
    canStart: (_host, _slot, vehicle) => vehicle?.kind === 'pickup',
    prompt: () => 'Press T to start the fixture',
    start(host) {
      const job: FixtureJob = { kind: 'fixture', ticks: 0 };
      host.job = job;
      return true;
    },
    update(host, job, dt) {
      calls.updates.push(dt);
      job.ticks++;
      if (job.ticks === 5 && host.sim.wanted.level > 0) host.end('Fixture failed.');
    },
    end(_host, _job, reason) {
      calls.ends.push(reason);
    },
    objectives: (job): Objective[] => [{ x: job.ticks, z: 0, label: 'Fixture', color: 0xffffff, radius: 1 }],
    status: (job) => `FIXTURE ${job.ticks}`,
  };
}

/**
 * The registry's kinds: the four built-in ones, wave 1's four service jobs (w1_activities.test.ts), the Gull Regatta,
 * the street run, then the cab and AzuraLink's ride (called from the phone and a station's marker, never by the job key,
 * so they sit after the street run).
 */
const KINDS = ['taxi', 'vigilante', 'rampage', 'ambulance', 'firefighter', 'courier', 'carExport', 'regatta', 'streetRun', 'cab', 'monorail'];

describe('activity registry', () => {
  afterEach(() => {
    unregisterActivity('fixture');
  });

  it('holds taxi, vigilante, rampage, street run and cab (and the wave-1 jobs), each implementing the full ActivityDef', () => {
    expect(activityKinds()).toEqual(KINDS);
    for (const kind of activityKinds()) {
      const def = getActivity(kind)!;
      for (const member of ['canStart', 'prompt', 'start', 'update', 'end', 'objectives', 'status'] as const) {
        expect(typeof def[member], `${kind}.${member}`).toBe('function');
      }
    }
  });

  it('refuses a second registration of a kind and forgets unregistered ones', () => {
    const calls = { updates: [], ends: [] };
    registerActivity(fixture(calls));
    expect(() => registerActivity(fixture(calls))).toThrow(/already registered/);
    expect(unregisterActivity('fixture')).toBe(true);
    expect(unregisterActivity('fixture')).toBe(false);
    expect(activityKinds()).toEqual(KINDS);
  });

  it('offers the real activities in the situations game.ts did', () => {
    const sim = makeSim();
    for (const kind of ['taxi', 'police', 'swat', 'sedan', 'pickup'] as const) {
      const car = driverIn(sim, kind);
      for (const speed of [0, 0.5, 3]) {
        for (const wanted of [0, 2]) {
          for (const burning of [false, true]) {
            car.speed = speed;
            car.burning = burning;
            sim.wanted.setLevel(wanted);
            expect(sim.activities.jobPrompt(), `${kind} speed ${speed} wanted ${wanted} burning ${burning}`).toBe(baselinePrompt(sim));
          }
        }
      }
      sim.removeVehicle(car);
    }
  });

  it('offers no prompt on foot, in a mission, or during a job', () => {
    const sim = makeSim();
    expect(sim.activities.jobPrompt()).toBeNull();
    driverIn(sim, 'taxi');
    expect(sim.activities.jobPrompt()).toBe('Press T to start a taxi job');
    sim.activities.toggleJob();
    expect(sim.activities.job?.kind).toBe('taxi');
    expect(sim.activities.jobPrompt()).toBeNull();
  });

  it('starts the matching real activity from the job key', () => {
    const kinds: Array<[Parameters<Sim['spawnVehicle']>[0], string]> = [['taxi', 'taxi'], ['police', 'vigilante'], ['sedan', 'streetRun']];
    for (const [vehicle, kind] of kinds) {
      const sim = makeSim();
      driverIn(sim, vehicle);
      sim.activities.toggleJob();
      expect(sim.activities.job?.kind).toBe(kind);
      sim.activities.toggleJob();
      expect(sim.activities.job).toBeNull();
    }
  });

  describe('fixture activity', () => {
    it('is offered, started, updated, reported and ended without touching the facade', () => {
      const calls = { updates: [] as number[], ends: [] as string[] };
      registerActivity(fixture(calls));
      expect(activityKinds()).toEqual([...KINDS.slice(0, -3), 'fixture', 'streetRun', 'cab', 'monorail']);

      const sim = makeSim();
      const ended: Array<SimEvents['activityEnded']> = [];
      sim.events.on('activityEnded', (e) => ended.push(e));

      // Offered only where canStart holds; the street run is still what other cars get.
      driverIn(sim, 'sedan');
      expect(sim.activities.jobPrompt()).toBe('Press T to start a street run');
      const pickup = driverIn(sim, 'pickup');
      expect(sim.activities.jobPrompt()).toBe('Press T to start the fixture');

      sim.activities.toggleJob();
      expect(sim.activities.job?.kind).toBe('fixture');
      expect(sim.activities.busy).toBe(true);
      expect(sim.activities.jobPrompt()).toBeNull();
      expect(sim.activities.status()).toBe('FIXTURE 0');
      expect(sim.activities.objectives()).toEqual([{ x: 0, z: 0, label: 'Fixture', color: 0xffffff, radius: 1 }]);

      // update(dt) once per sim update, with that update's dt.
      step(sim, 3 / 60);
      expect(calls.updates).toEqual(Array(3).fill(1 / 60));
      expect(sim.activities.status()).toBe('FIXTURE 3');
      expect(sim.activities.objectives()[0]!.x).toBe(3);

      // The job key again ends it with the def's text.
      sim.activities.toggleJob();
      expect(calls.ends).toEqual(['Fixture over.']);
      expect(sim.activities.job).toBeNull();
      expect(sim.activities.status()).toBeNull();
      expect(sim.activities.objectives()).toEqual([]);
      expect(ended).toEqual([{ kind: 'fixture' }]);

      // A fail condition ends it too.
      sim.wanted.setLevel(2);
      sim.activities.toggleJob();
      expect(sim.activities.job?.kind).toBe('fixture');
      step(sim, 5 / 60);
      expect(calls.ends).toEqual(['Fixture over.', 'Fixture failed.']);
      expect(sim.activities.job).toBeNull();
      expect(pickup.removed).toBe(false);

      // A game-level abort closes it with the default text.
      sim.activities.toggleJob();
      sim.activities.cancelAll('wasted');
      expect(calls.ends.at(-1)).toBe('Job over.');
      expect(sim.activities.job).toBeNull();
    });

    it('leaves the real activities as they were, before and after it is registered', () => {
      const calls = { updates: [] as number[], ends: [] as string[] };
      registerActivity(fixture(calls));
      const sim = makeSim();
      driverIn(sim, 'taxi');
      expect(sim.activities.jobPrompt()).toBe('Press T to start a taxi job');
      sim.activities.toggleJob();
      expect(sim.activities.job?.kind).toBe('taxi');
      expect(calls.updates).toEqual([]);
      unregisterActivity('fixture');

      const police = makeSim();
      driverIn(police, 'police');
      police.activities.toggleJob();
      expect(police.activities.job?.kind).toBe('vigilante');
    });
  });
});
