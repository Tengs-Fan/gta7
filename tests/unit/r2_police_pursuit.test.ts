// Round 2, cluster "police" (P10): pursuits that reach a fleeing car (losing the stars is in
// r2_police_escape*.test.ts). Flee bot and seeds as there: 21 seeds, each run a chaotic trajectory, so the
// test asks for a share of the runs (measured clear of its bound) rather than every one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleeRuns, showRuns } from './r2_police_helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pursuit of a fleeing car at 3 stars', () => {
  it('a unit gets within 40 m of the car within 30 s in at least 20 of the 21 runs', () => {
    // Measured in the round 2 fix pass: in all 21, after a median of 5 s.
    const runs = fleeRuns(3, 30, false);
    const reached = runs.filter((r) => r.within40At >= 0 && r.within40At < 30).length;
    expect(reached, showRuns(runs)).toBeGreaterThanOrEqual(20);
  }, 600_000);
});
