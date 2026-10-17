// Round 2, cluster "police" (P10): pursuits that reach a fleeing car (losing the stars is in
// r2_police_escape*.test.ts). Flee bot as there. Each run is a chaotic trajectory, so the test asks for a share of
// the runs rather than every one.
// Round 2 fix pass 2: each run is exact (the sim is deterministic). Over seeds 1-126 a unit came within 40 m within
// 30 s in 125 runs (in a median of 4.5 s), so at least 38 of 42 fails in 0.002% of seed draws (0.15% if the true rate
// were as low as 98%; with 21 runs and 20 asked for it was 1.2%). Without the units that cut a fast player off from
// ahead and without the recycling of trailing units (before P10), only 39 of seeds 1-63 did (62%; 24 of seeds
// 1-42), which passes this bound in 0.003% of draws.

import { describe, expect, it } from 'vitest';
import { fleeRuns, seeds, showRuns } from './r2_police_helpers';

describe('pursuit of a fleeing car at 3 stars', () => {
  it('a unit gets within 40 m of the car within 30 s in at least 38 of 42 runs', () => {
    const runs = fleeRuns(3, 30, false, seeds(42));
    const reached = runs.filter((r) => r.within40At >= 0 && r.within40At < 30).length;
    expect(reached, showRuns(runs)).toBeGreaterThanOrEqual(38);
  }, 600_000);
});
