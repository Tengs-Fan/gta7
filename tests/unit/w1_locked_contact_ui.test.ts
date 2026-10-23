// A locked contact (Vera, until The Big Score is done) must not show on the static map screen: not in the legend's
// contacts row, not on the completion checklist (map screen and STATS read the same rows).

import { describe, expect, it } from 'vitest';
import { completionPercent, completionRows } from '../../src/sim/completion';
import { contactById } from '../../src/sim/missions/contacts';
import { MAP_CATEGORIES } from '../../src/ui/mapRender';
import { makeSim } from './helpers';
import { CHAPTER1 } from './story2_helpers';

const LIME = contactById('vera').color;

function legendOf(done: readonly string[]) {
  const sim = makeSim({ ambient: false });
  for (const id of done) sim.progress.markDone(id);
  const cat = MAP_CATEGORIES.find((c) => c.id === 'missions')!;
  return { sim, swatches: cat.legendSwatches!(sim, 0), rows: completionRows(sim, sim.players[0]!) };
}

describe('locked contact on the static map screen', () => {
  for (const [name, done] of [['nothing done', []], ['wheels..heatwave done', CHAPTER1.slice(0, 5)]] as const) {
    it(`hides Vera's name, letter and colour in the legend and checklist (${name})`, () => {
      const { swatches, rows } = legendOf(done);
      expect(swatches.map((s) => s.label)).toEqual(['L', 'D', '?']);
      expect(swatches.some((s) => s.label === 'V' || s.color.toLowerCase() === LIME)).toBe(false);
      expect(rows.some((r) => /vera|salgado/i.test(r.label) || r.id === 'story:vera')).toBe(false);
      expect(rows.filter((r) => r.group === 'story').map((r) => r.label)).toEqual(['Mama Lou', 'Dex Moreau']);
    });
  }

  it('keeps the completion denominator at 12 missions while locked', () => {
    const sim = makeSim({ ambient: false });
    for (const id of CHAPTER1.slice(0, 5)) sim.progress.markDone(id);
    expect(completionPercent(sim, sim.players[0]!)).toBe(Math.round((5 / 12) * 0.5 * 100));
  });

  it('shows her exactly as before once The Big Score is done', () => {
    const { swatches, rows } = legendOf(CHAPTER1);
    expect(swatches).toEqual([
      { color: contactById('lou').color, label: 'L' },
      { color: contactById('dex').color, label: 'D' },
      { color: LIME, label: 'V' },
    ]);
    expect(rows.find((r) => r.id === 'story:vera')).toEqual({ id: 'story:vera', group: 'story', label: 'Vera Salgado', done: 0, total: 6 });
  });
});
