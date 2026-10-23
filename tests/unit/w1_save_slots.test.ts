import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentSlot, deleteSlot, firstEmptySlot, loadGame, loadSlot, setCurrentSlot, slotInfos, slotKey, storeGame, storeSlot } from '../../src/settings';
import { applySave, parseSave, serialize } from '../../src/sim/progress';
import { Progress } from '../../src/sim/progress';
import { makeSim } from './helpers';

const LEGACY = 'gta7.save.v1';
const fixtureText = readFileSync(new URL('./fixtures/legacy_v1.save.json', import.meta.url), 'utf8');

let items: Map<string, string>;
beforeEach(() => {
  items = new Map();
  const localStorage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, String(v)), removeItem: (k: string) => void items.delete(k) };
  vi.stubGlobal('window', { localStorage });
});
afterEach(() => vi.unstubAllGlobals());

const hash = (k: string) => createHash('sha1').update(items.get(k) ?? '<none>').digest('hex').slice(0, 10);
const keys = () => [...items.keys()].sort();

function aSave(money: number, done: string[], ext?: Record<string, unknown>) {
  const p = new Progress();
  for (const id of done) p.markDone(id);
  p.money = money;
  return serialize(p, [{ id: 'pistol', ammo: 40 }], 20, 13.5, 2, ext);
}

describe('the single save of earlier versions becomes slot 1', () => {
  it('copies it byte for byte into slot 1 once, leaves slots 2 and 3 empty, and only then removes the old key', () => {
    items.set(LEGACY, fixtureText);
    const before = keys();
    const infos = slotInfos();
    const after = keys();
    console.log('keys before', before, 'after', after);
    expect(items.get(slotKey(1))).toBe(fixtureText);
    expect(infos.map((i) => i.state)).toEqual(['ok', 'empty', 'empty']);
    expect(infos[0]!.data).toEqual(parseSave(JSON.parse(fixtureText)));
    expect(items.has(LEGACY)).toBe(false);
    // Run again ("reload"): nothing moves, nothing is duplicated.
    const again = slotInfos();
    expect(again.map((i) => i.state)).toEqual(['ok', 'empty', 'empty']);
    expect(keys()).toEqual(after);
    expect(loadGame()).toEqual(parseSave(JSON.parse(fixtureText)));
  });

  it('a later old-format save goes to the first empty slot; with all three full it stays where it is', () => {
    storeSlot(1, aSave(100, []));
    items.set(LEGACY, fixtureText);
    expect(slotInfos().map((i) => i.state)).toEqual(['ok', 'ok', 'empty']);
    expect(items.get(slotKey(2))).toBe(fixtureText);
    storeSlot(3, aSave(300, []));
    items.set(LEGACY, fixtureText);
    expect(slotInfos().map((i) => i.state)).toEqual(['ok', 'ok', 'ok']);
    expect(items.get(LEGACY)).toBe(fixtureText);
  });

  it('a version 1 save with no ext loads from any slot with all its progress', () => {
    const expected = parseSave(JSON.parse(fixtureText))!;
    for (const slot of [1, 2, 3]) {
      items.clear();
      items.set(slotKey(slot), fixtureText);
      const sim = makeSim({ ambient: false });
      applySave(sim.progress, loadSlot(slot)!);
      expect(sim.progress.money).toBe(expected.money);
      expect([...sim.progress.missionsDone]).toEqual(expected.missionsDone);
      expect([...sim.progress.packages]).toEqual(expected.packages);
    }
  });
});

describe('three independent slots', () => {
  it('saving or deleting one slot leaves the other two byte-identical', () => {
    // Ext keys no save codec owns (the economy's real 'garage' codec would drop these made-up values on load).
    storeSlot(1, aSave(1000, ['wheels'], { slotTest: ['a'] }));
    storeSlot(2, aSave(2000, ['wheels', 'delivery'], { slotTest: ['b'] }));
    storeSlot(3, aSave(3000, [], { exports: [1] }));
    const h = () => [1, 2, 3].map((s) => hash(slotKey(s)));
    const before = h();
    // Load slot 2, play, save to slot 2 (as the game does: the current slot).
    setCurrentSlot(2);
    const two = loadGame()!;
    expect(two.money).toBe(2000);
    expect(storeGame({ ...two, money: two.money + 555, missionsDone: [...two.missionsDone, 'repo'] })).toBeNull();
    const after = h();
    console.log('slot hashes before', before, 'after saving slot 2', after);
    expect([after[0], after[2]]).toEqual([before[0], before[2]]);
    expect(after[1]).not.toBe(before[1]);
    expect(loadSlot(1)!.money).toBe(1000);
    expect(loadSlot(1)!.ext).toEqual({ slotTest: ['a'] });
    expect(loadSlot(3)!.ext).toEqual({ exports: [1] });
    deleteSlot(3);
    expect(h()[0]).toBe(after[0]);
    expect(h()[1]).toBe(after[1]);
    expect(slotInfos().map((i) => i.state)).toEqual(['ok', 'ok', 'empty']);
    expect(firstEmptySlot()).toBe(3);
  });

  it('a corrupt slot reads as unreadable and does not stop the others', () => {
    storeSlot(1, aSave(1, []));
    items.set(slotKey(2), '{"version":1, broken');
    storeSlot(3, aSave(3, []));
    const infos = slotInfos();
    console.log(infos.map((i) => `${i.slot}: ${i.state}`).join(', '));
    expect(infos.map((i) => i.state)).toEqual(['ok', 'corrupt', 'ok']);
    expect(loadSlot(3)!.money).toBe(3);
  });

  it('the game saves to the slot it was loaded from or last saved to; with all full a new game has none', () => {
    storeSlot(2, aSave(2, []));
    setCurrentSlot(0);
    expect(currentSlot()).toBe(0);
    expect(storeGame(aSave(9, []))).toMatch(/slots are full/);
    expect(slotInfos().map((i) => i.state)).toEqual(['empty', 'ok', 'empty']);
    setCurrentSlot(3);
    expect(storeGame(aSave(9, []))).toBeNull();
    expect(loadSlot(3)!.money).toBe(9);
    expect(loadSlot(2)!.money).toBe(2);
  });
});
