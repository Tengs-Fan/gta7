// Round 2, cluster "police" (P58): dispatch chatter keeps its pace over a long chase. Round 2 fix pass: three
// seeds rather than one, with the line count taken over them together; the count in a single two-minute run
// swings with its trajectory (2-10 lines over 21 seeds measured, under 4 in 2 of them).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISPATCH_GAP } from '../../src/sim/dispatch';
import { makeSim, step, teleport } from './helpers';
import { getaway, seedMathRandom } from './r2_police_helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dispatch chatter', () => {
  it('keeps 6 s between lines over two-minute 5-star chases, and never uses the subtitle line', () => {
    let total = 0;
    const log: string[] = [];
    for (const seed of [11, 3, 19]) {
      seedMathRandom(seed);
      const sim = makeSim({ ambient: true, seed });
      sim.cheats.godMode = true;
      sim.missions.noBust = true;
      const lines: Array<{ text: string; t: number }> = [];
      sim.events.on('dispatch', (e) => lines.push({ text: e.text, t: sim.time }));
      let subtitles = 0;
      sim.events.on('subtitle', () => subtitles++);
      const { car, bot } = getaway(sim, seed);
      sim.wanted.setLevel(5);
      sim.wanted.floor = 5;
      let last = 0;
      step(sim, 120, (t) => {
        // Now and then he gets away for a while (out of sight across town), so there is news to report.
        if (t - last > 25) {
          last = t;
          const n = sim.roads.nearestNode(-car.pos.x * 0.8, -car.pos.z * 0.8);
          teleport(sim, n.x + 8, n.z + 8);
        }
        return bot();
      });
      for (let i = 1; i < lines.length; i++) expect(lines[i]!.t - lines[i - 1]!.t, `seed ${seed}`).toBeGreaterThanOrEqual(DISPATCH_GAP - 1e-9);
      expect(subtitles, `seed ${seed}`).toBe(0);
      total += lines.length;
      log.push(`seed ${seed}: ${lines.map((l) => l.text).join(' | ')}`);
      vi.restoreAllMocks();
    }
    // 18 lines in these three runs, about 6 a run over 21 seeds.
    expect(total, log.join('\n')).toBeGreaterThanOrEqual(9);
  }, 600_000);
});
