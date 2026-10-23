import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { applySave, parseSave, SAVE_VERSION, serialize } from '../../src/sim/progress';
import { applyExt, registerSaveCodec, saveCodecKeys, serializeExt, unregisterSaveCodec, type SaveCodec } from '../../src/sim/saveExt';
import type { Sim } from '../../src/sim/sim';
import { makeSim } from './helpers';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// Per-sim state of the fixture module, as a real module would keep it.
const state = new WeakMap<Sim, { garage: string[]; level: number }>();
const defaults = () => ({ garage: [] as string[], level: 0 });
const get = (sim: Sim) => {
  let s = state.get(sim);
  if (!s) state.set(sim, (s = defaults()));
  return s;
};

const calls: unknown[] = [];
const fixtureCodec: SaveCodec<{ garage: string[]; level: number }> = {
  key: 'fixture',
  serialize: (sim) => ({ garage: [...get(sim).garage], level: get(sim).level }),
  parse(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    if (!Array.isArray(o.garage) || !o.garage.every((g) => typeof g === 'string')) return undefined;
    if (typeof o.level !== 'number' || !Number.isFinite(o.level)) return undefined;
    return { garage: o.garage as string[], level: o.level };
  },
  apply(sim, value) {
    calls.push(value);
    state.set(sim, { garage: [...value.garage], level: value.level });
  },
};
const throwingCodec: SaveCodec<number> = {
  key: 'throws',
  serialize: () => 1,
  parse() {
    throw new Error('boom');
  },
  apply() {},
};
const otherCodec: SaveCodec<{ n: number }> = {
  key: 'other',
  serialize: () => ({ n: 7 }),
  parse: (raw) => (raw && typeof raw === 'object' && typeof (raw as { n?: unknown }).n === 'number' ? { n: (raw as { n: number }).n } : undefined),
  apply: () => {},
};

afterEach(() => {
  for (const k of saveCodecKeys()) unregisterSaveCodec(k);
  calls.length = 0;
});

function coreOf(save: ReturnType<typeof parseSave>) {
  const { ext: _ext, savedAt: _savedAt, ...core } = save!;
  return core;
}

describe('save version', () => {
  it('stays 1 and the storage key is unchanged', () => {
    expect(SAVE_VERSION).toBe(1);
    expect(serialize(makeSim().progress, [], 0, 12, 1).version).toBe(1);
    expect(readFileSync(new URL('../../src/settings.ts', import.meta.url), 'utf8')).toContain("'gta7.save.v1'");
  });
});

describe('registered save extension', () => {
  it('round-trips through JSON and parseSave into a fresh sim, with the core intact', () => {
    registerSaveCodec(fixtureCodec);
    const a = makeSim();
    a.progress.addMoney(4321);
    a.progress.markDone('wheels');
    a.progress.packages.push(2, 9);
    a.progress.stunts.push(1);
    a.progress.rampages.push('docks');
    a.progress.streetRuns.dockside = { bestTime: 80, medal: 'silver', finishes: 2 };
    a.progress.stats.kills = 12;
    state.set(a, { garage: ['sedan', 'sports'], level: 3 });
    const weapons = [{ id: 'pistol' as const, ammo: 30 }, { id: 'smg' as const, ammo: 120 }];
    const written = JSON.parse(JSON.stringify(serialize(a.progress, weapons, 40, 9.5, 4, serializeExt(a))));
    expect(written.version).toBe(1);
    expect(written.ext).toEqual({ fixture: { garage: ['sedan', 'sports'], level: 3 } });

    const parsed = parseSave(written)!;
    expect(parsed).not.toBeNull();
    const b = makeSim();
    applySave(b.progress, parsed);
    applyExt(b, parsed.ext);
    expect(state.get(b)).toEqual({ garage: ['sedan', 'sports'], level: 3 });
    expect(b.progress.money).toBe(a.progress.money);
    expect(b.progress.missionsDone).toEqual(['wheels']);
    expect(b.progress.packages).toEqual([2, 9]);
    expect(b.progress.stunts).toEqual([1]);
    expect(b.progress.rampages).toEqual(['docks']);
    expect(b.progress.streetRuns).toEqual(a.progress.streetRuns);
    expect(b.progress.stats).toEqual(a.progress.stats);
    expect(parsed.weapons).toEqual(weapons);
    expect(parsed.armor).toBe(40);
    expect(parsed.hours).toBe(9.5);
    expect(parsed.day).toBe(4);
  });

  it('writes no ext key while nothing is registered or carried', () => {
    const sim = makeSim();
    expect(serializeExt(sim)).toBeUndefined();
    expect('ext' in serialize(sim.progress, [], 0, 12, 1, serializeExt(sim))).toBe(false);
  });

  it('refuses a second codec for the same key', () => {
    registerSaveCodec(fixtureCodec);
    expect(() => registerSaveCodec(fixtureCodec)).toThrow();
  });
});

describe('legacy v1 save', () => {
  it('parses to exactly what the baseline (72d0b98) parseSave produced, with no ext and no codec applied', () => {
    registerSaveCodec(fixtureCodec);
    const raw = fixture('legacy_v1.save.json');
    expect('ext' in raw).toBe(false);
    const parsed = parseSave(raw);
    expect(parsed).toStrictEqual(fixture('legacy_v1.parsed.baseline.json'));
    expect('ext' in parsed!).toBe(false);

    const sim = makeSim();
    applySave(sim.progress, parsed!);
    applyExt(sim, parsed!.ext);
    expect(calls).toEqual([]);
    expect(state.get(sim)).toBeUndefined();
    expect(sim.progress.money).toBe(18450);
    expect(sim.progress.missionsDone).toEqual(['wheels', 'delivery', 'repo']);
    expect(sim.progress.streetRuns.dockside).toEqual({ bestTime: 74.5, medal: 'gold', finishes: 3 });
    expect(parsed!.weapons.map((w) => w.id)).toEqual(['pistol', 'smg', 'shotgun']);
    expect(parsed!.armor).toBe(55);
    expect(parsed!.hours).toBe(21.5);
    expect(parsed!.day).toBe(6);
  });
});

describe('corrupt ext', () => {
  const base = () => fixture('legacy_v1.save.json');
  const expectCore = (save: ReturnType<typeof parseSave>) => {
    expect(save).not.toBeNull();
    expect(coreOf(save)).toEqual(coreOf(parseSave(base())));
  };

  it.each([['a string', 'x'], ['a number', 5], ['an array', [1, 2]], ['null', null]])('ignores ext that is %s', (_name, ext) => {
    registerSaveCodec(fixtureCodec);
    const save = parseSave({ ...base(), ext });
    expectCore(save);
    expect(save!.ext).toBeUndefined();
  });

  it('drops an entry whose codec rejects the shape, and does not apply it', () => {
    registerSaveCodec(fixtureCodec);
    const save = parseSave({ ...base(), ext: { fixture: { garage: 'nope', level: 1 } } });
    expectCore(save);
    expect(save!.ext).toEqual({});
    const sim = makeSim();
    applyExt(sim, save!.ext);
    expect(calls).toEqual([]);
    expect(get(sim)).toEqual(defaults());
  });

  it('keeps a valid entry next to a corrupt one', () => {
    registerSaveCodec(fixtureCodec);
    registerSaveCodec(otherCodec);
    const save = parseSave({ ...base(), ext: { fixture: { garage: ['van'], level: 2 }, other: { n: 'x' } } });
    expectCore(save);
    expect(save!.ext).toEqual({ fixture: { garage: ['van'], level: 2 } });
    const sim = makeSim();
    applyExt(sim, save!.ext);
    expect(state.get(sim)).toEqual({ garage: ['van'], level: 2 });
  });

  it('survives a codec whose parse throws', () => {
    registerSaveCodec(throwingCodec);
    registerSaveCodec(fixtureCodec);
    const save = parseSave({ ...base(), ext: { throws: 1, fixture: { garage: [], level: 1 } } });
    expectCore(save);
    expect(save!.ext).toEqual({ fixture: { garage: [], level: 1 } });
  });

  it('survives a codec whose apply throws', () => {
    registerSaveCodec<{ x: number }>({ key: 'badapply', serialize: () => undefined, parse: () => ({ x: 1 }), apply: () => { throw new Error('no'); } });
    registerSaveCodec(fixtureCodec);
    const save = parseSave({ ...base(), ext: { badapply: {}, fixture: { garage: ['a'], level: 1 } } })!;
    const sim = makeSim();
    expect(() => applyExt(sim, save.ext)).not.toThrow();
    expect(state.get(sim)).toEqual({ garage: ['a'], level: 1 });
  });
});

describe('unknown ext keys', () => {
  it('are kept across load and save, next to the registered key holding current state', () => {
    registerSaveCodec(fixtureCodec);
    const future = { a: 1, b: [2, 3] };
    const save = parseSave({ ...fixture('legacy_v1.save.json'), ext: { fixture: { garage: ['bus'], level: 5 }, futureModule: future } })!;
    expect(save.ext).toEqual({ fixture: { garage: ['bus'], level: 5 }, futureModule: future });

    const sim = makeSim();
    applyExt(sim, save.ext);
    expect(state.get(sim)).toEqual({ garage: ['bus'], level: 5 });
    state.set(sim, { garage: ['bus', 'taxi'], level: 6 });

    const again = JSON.parse(JSON.stringify(serialize(sim.progress, [], 0, 12, 1, serializeExt(sim))));
    expect(again.ext.futureModule).toEqual(future);
    expect(again.ext.fixture).toEqual({ garage: ['bus', 'taxi'], level: 6 });
  });

  it('a __proto__ key stays an own data key', () => {
    const save = parseSave(JSON.parse('{"version":1,"ext":{"__proto__":{"polluted":true}}}'))!;
    expect(Object.keys(save.ext!)).toEqual(['__proto__']);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
