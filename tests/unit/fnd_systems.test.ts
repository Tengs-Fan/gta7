import { describe, expect, it } from 'vitest';
import type { Sim } from '../../src/sim/sim';
import { SYSTEM_SLOTS, registerSystem, unregisterSystem, type SimSystem, type SystemSlot } from '../../src/sim/systems';
import { input, makeSim, step } from './helpers';

/** Wraps the built-in steps so the log shows where the test systems land between them. */
function instrument(sim: Sim, log: string[]): void {
  const wrap = (obj: object, name: string, label: string) => {
    const o = obj as Record<string, (...a: unknown[]) => unknown>;
    const orig = o[name]!.bind(obj);
    o[name] = (...a: unknown[]) => {
      log.push(label);
      return orig(...a);
    };
  };
  wrap(sim.playerCtl, 'update', 'playerCtl');
  wrap(sim.police, 'update', 'police');
  wrap(sim.combat, 'update', 'combat');
  wrap(sim.wanted, 'update', 'wanted');
  wrap(sim.interactions, 'update', 'interactions');
  wrap(sim.activities, 'update', 'activities');
  wrap(sim.missions, 'update', 'missions');
}

const recorder = (log: string[], id: string, slot: SystemSlot): SimSystem => ({ id, slot, update: () => void log.push(id) });

function build(log: string[]): Sim {
  const sim = makeSim();
  instrument(sim, log);
  sim.addSystem(recorder(log, 'late-a', 'late'));
  sim.addSystem(recorder(log, 'combat-1', 'afterCombat'));
  sim.addSystem(recorder(log, 'combat-2', 'afterCombat'));
  sim.addSystem(recorder(log, 'pre', 'preInput'));
  return sim;
}

describe('system slots', () => {
  it('lists the slots in a fixed order', () => {
    expect(SYSTEM_SLOTS).toEqual(['preInput', 'afterPlayers', 'afterTraffic', 'afterPhysics', 'afterCombat', 'afterInteractions', 'afterMissions', 'late']);
  });

  it('runs registered systems once per update, in their slot, in registration order, identically every update and sim', () => {
    const logA: string[] = [];
    const simA = build(logA);
    const per: string[][] = [];
    for (let i = 0; i < 10; i++) {
      logA.length = 0;
      step(simA, 1 / 60);
      per.push([...logA]);
    }
    const first = per[0]!;
    expect(first.filter((e) => e === 'pre')).toHaveLength(1);
    expect(first.indexOf('pre')).toBeLessThan(first.indexOf('playerCtl'));
    // Same slot: registration order, right after the built-in steps of that slot.
    expect(first.indexOf('wanted')).toBeLessThan(first.indexOf('combat-1'));
    expect(first.indexOf('combat-1') + 1).toBe(first.indexOf('combat-2'));
    expect(first.indexOf('combat-2')).toBeLessThan(first.indexOf('interactions'));
    expect(first.indexOf('combat')).toBeLessThan(first.indexOf('combat-1'));
    expect(first.filter((e) => e === 'late-a')).toHaveLength(1);
    expect(first[first.length - 1]).toBe('late-a');
    expect(first.indexOf('missions')).toBeLessThan(first.indexOf('late-a'));
    for (const p of per) expect(p).toEqual(first);

    const logB: string[] = [];
    const simB = build(logB);
    step(simB, 1 / 60);
    expect(logB).toEqual(first);
  });

  it('puts every slot at its place among the built-in steps', () => {
    const log: string[] = [];
    const sim = makeSim();
    instrument(sim, log);
    for (const slot of SYSTEM_SLOTS) sim.addSystem(recorder(log, `@${slot}`, slot));
    step(sim, 1 / 60);
    expect(log).toEqual([
      '@preInput', 'playerCtl', '@afterPlayers', 'police', '@afterTraffic', '@afterPhysics', 'combat', 'wanted', '@afterCombat',
      'interactions', '@afterInteractions', 'activities', 'missions', '@afterMissions', '@late',
    ]);
  });

  it('calls reset when systems are reset for a new game', () => {
    const sim = makeSim();
    const resets: string[] = [];
    sim.addSystem({ id: 'r1', slot: 'late', update: () => {}, reset: (s) => void (s === sim && resets.push('r1')) });
    sim.addSystem({ id: 'r2', slot: 'preInput', update: () => {} });
    sim.resetSystems();
    expect(resets).toEqual(['r1']);
  });

  it('installs globally registered systems in every new sim, and can remove one', () => {
    const log: string[] = [];
    registerSystem(recorder(log, 'global', 'afterCombat'));
    try {
      step(makeSim(), 1 / 60);
      expect(log).toEqual(['global']);
    } finally {
      unregisterSystem('global');
    }
    log.length = 0;
    const sim = makeSim();
    sim.addSystem(recorder(log, 'x', 'late'));
    sim.removeSystem('x');
    step(sim, 1 / 60);
    expect(log).toEqual([]);
  });

  it('rejects an unknown slot and a duplicate id', () => {
    const sim = makeSim();
    expect(() => sim.addSystem({ id: 'bad', slot: 'nowhere' as SystemSlot, update: () => {} })).toThrow();
    sim.addSystem(recorder([], 'dup', 'late'));
    expect(() => sim.addSystem(recorder([], 'dup', 'late'))).toThrow();
  });

  it('a no-op system changes nothing: same seed gives the same positions, wanted level and events after 600 frames', () => {
    const run = (withSystem: boolean) => {
      const sim = makeSim({ seed: 11, ambient: true });
      const events: string[] = [];
      for (const name of ['wanted', 'horn', 'message', 'pickup', 'vehicleExit', 'characterKilled', 'dispatch'] as const) sim.events.on(name, () => void events.push(name));
      if (withSystem) for (const slot of SYSTEM_SLOTS) sim.addSystem({ id: `noop-${slot}`, slot, update: () => {} });
      sim.wanted.crime('assault', sim.player.pos.x, sim.player.pos.z);
      step(sim, 10, input({ moveZ: 1 }));
      return {
        player: { ...sim.player.pos },
        wanted: sim.wanted.level,
        vehicles: sim.vehicles.map((v) => [v.id, v.pos.x, v.pos.z]),
        characters: sim.characters.map((c) => [c.id, c.pos.x, c.pos.z]),
        events,
      };
    };
    expect(run(true)).toEqual(run(false));
  });
});
