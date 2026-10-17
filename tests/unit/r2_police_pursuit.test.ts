// Round 2, cluster "police" (P10): pursuits that reach a fleeing car (losing the stars is in
// r2_police_escape.test.ts). The flee bot drives a sports car (god mode, ambient city) flat out down
// the lanes, straight on where it can and else the first legal turn, for seeds 3, 11 and 19.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flee, FLEE_SEEDS, type FleeRun, showRuns } from './r2_police_helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pursuit of a fleeing car', () => {
  it('at 3 stars a unit is within 40 m of the car within 30 s in every run', () => {
    const runs = FLEE_SEEDS.map((s) => flee(3, s, 30, false));
    for (const r of runs) {
      expect(r.within40At, showRuns(runs)).toBeGreaterThanOrEqual(0);
      expect(r.within40At, showRuns(runs)).toBeLessThan(30);
    }
  });

  it('at 5 stars a unit gets within 40 m within 30 s and stays near: within 60 m most of the time, few units left trailing', () => {
    const runs = FLEE_SEEDS.map((s) => flee(5, s, 120, false));
    for (const r of runs) {
      expect(r.within40At, showRuns(runs)).toBeGreaterThanOrEqual(0);
      expect(r.within40At, showRuns(runs)).toBeLessThan(30);
    }
    // Over all the 0.5 s samples of the three runs, as the acceptance words it ("in >= 60% of 0.5 s samples",
    // "on average"): a single 2-minute run swings with the seed (about 1 run in 7 has over 1.5 trailing units).
    const mean = (f: (r: FleeRun) => number) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
    expect(mean((r) => r.near60), showRuns(runs)).toBeGreaterThanOrEqual(0.6);
    expect(mean((r) => r.far), showRuns(runs)).toBeLessThanOrEqual(1.5);
  });
});
