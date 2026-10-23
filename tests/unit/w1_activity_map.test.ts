// VAL-W1X-007: the wave-1 activities are on the map, in a legend row of their own that hides and shows them.

import { describe, expect, it } from 'vitest';
import { places } from '../../src/sim/activities/places';
import { collectBlips, MAP_CATEGORIES } from '../../src/ui/mapRender';
import { makeSim } from './helpers';

describe('activity sites on the map', () => {
  it('marks where each new activity is taken, under an activities legend row that switches them off and on', () => {
    const sim = makeSim({ ambient: false });
    const cat = MAP_CATEGORIES.find((c) => c.id === 'activities');
    expect(cat, 'an activities legend row').toBeDefined();
    expect(cat!.label).toMatch(/paramedic/i);
    expect(cat!.label).toMatch(/courier/i);
    const at = places(sim.world);
    const marker = (id: string) => sim.interactions.markers.find((m) => m.id === id)!;
    const sites = [
      { what: 'ambulance depot', ...at.depots.find((d) => d.kind === 'ambulance')! },
      { what: 'fire station', ...at.depots.find((d) => d.kind === 'firetruck')! },
      // The stop a car pulls up at; the on-foot marker beside it is a few metres off.
      { what: 'courier office', x: at.courier.x, z: at.courier.z },
      { what: "Lou's export board", x: marker('export_board').x, z: marker('export_board').z },
    ];
    const shown = collectBlips(sim, 0, 0, { map: true }).filter((b) => b.category === 'activities');
    const rows: string[] = [];
    for (const s of sites) {
      const b = shown.find((q) => Math.hypot(q.x - s.x, q.z - s.z) < 1);
      expect(b, `${s.what} on the map`).toBeDefined();
      expect(b!.label).not.toBe('');
      rows.push(`${s.what}: ${b!.label} at ${b!.x.toFixed(1)}, ${b!.z.toFixed(1)}`);
    }
    console.log(rows.join('\n'));
    expect(shown).toHaveLength(sites.length);
    expect(cat!.swatches.map((w) => w.label)).toEqual(shown.map((b) => b.label));
    const hidden = collectBlips(sim, 0, 0, { map: true, hidden: new Set(['activities']) });
    expect(hidden.some((b) => b.category === 'activities')).toBe(false);
    expect(hidden.length).toBe(collectBlips(sim, 0, 0, { map: true }).length - sites.length);
  });

  it("draws Lou's mission marker over her export board's icon beside it", () => {
    const sim = makeSim({ ambient: false });
    const blips = collectBlips(sim, 0, 0, { map: true });
    const lou = blips.findIndex((b) => b.category === 'missions' && b.label === 'L');
    const board = blips.findIndex((b) => b.category === 'activities' && b.label === 'E');
    expect(lou, "Lou's offer").toBeGreaterThanOrEqual(0);
    expect(board).toBeGreaterThanOrEqual(0);
    expect(lou, 'drawn later, on top').toBeGreaterThan(board);
  });
});
