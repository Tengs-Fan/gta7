// A locked contact (Vera, until The Big Score is done) must not show on the static map screen: not in the legend's
// missions rows, not on the completion checklist (map screen and STATS read the same rows).

import { describe, expect, it } from 'vitest';
import { completionPercent, completionRows } from '../../src/sim/completion';
import { contactById } from '../../src/sim/missions/contacts';
import { blipKind, collectBlips, legendRows } from '../../src/ui/mapRender';
import { makeSim } from './helpers';
import { CHAPTER1 } from './story2_helpers';

const LIME = contactById('vera').color;

function legendOf(done: readonly string[]) {
  const sim = makeSim({ ambient: false });
  for (const id of done) sim.progress.markDone(id);
  const kinds = legendRows(collectBlips(sim, 0, 0, { map: true }), []).find((r) => r.category?.id === 'missions')!.kinds;
  return { sim, legend: kinds.map(blipKind), rows: completionRows(sim, sim.players[0]!) };
}

describe('locked contact on the static map screen', () => {
  for (const [name, done, who] of [['nothing done', [], 'Mama Lou'], ['wheels..heatwave done', CHAPTER1.slice(0, 5), 'Dex Moreau']] as const) {
    it(`hides Vera's name, letter and colour in the legend and checklist (${name})`, () => {
      const { legend, rows } = legendOf(done);
      // Only the contact with work on the map has a row.
      expect(legend.map((k) => k.name)).toEqual([`${who} (missions)`]);
      expect(legend.some((k) => k.label === 'V' || k.color.toLowerCase() === LIME || /vera|salgado/i.test(k.name))).toBe(false);
      expect(rows.some((r) => /vera|salgado/i.test(r.label) || r.id === 'story:vera')).toBe(false);
      expect(rows.filter((r) => r.group === 'story').map((r) => r.label)).toEqual(['Mama Lou', 'Dex Moreau']);
    });
  }

  it('keeps the completion denominator at 12 missions while locked', () => {
    const sim = makeSim({ ambient: false });
    for (const id of CHAPTER1.slice(0, 5)) sim.progress.markDone(id);
    expect(completionPercent(sim, sim.players[0]!)).toBe(Math.round((5 / 12) * 0.5 * 100));
  });

  it('shows her once The Big Score is done', () => {
    const { legend, rows } = legendOf(CHAPTER1);
    expect(legend).toEqual([{ name: 'Vera Salgado (missions)', color: LIME, label: 'V', shape: 'circle', category: 'missions' }]);
    expect(rows.find((r) => r.id === 'story:vera')).toEqual({ id: 'story:vera', group: 'story', label: 'Vera Salgado', done: 0, total: 6 });
  });
});
