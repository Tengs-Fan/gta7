// Round 2 fix pass, cluster "police": with the helicopter in the chase a fleeing car can still lose 3 stars.
// The helicopter used to cruise at 40 m/s and see 110 m all round, so the flee bot never even made the stars
// flash; it now cruises at 30 m/s, below a getaway car's speed, and sees 60 m (see r2_police.test.ts for the
// helicopter itself). Flee bot and seeds as in r2_police_escape.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleeRuns, lostTime, median, showRuns } from './r2_police_helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('losing 3 stars in a fleeing car', () => {
  it('loses 3 stars in a median of 90 s at most', () => {
    // Measured in the round 2 fix pass: a median of 66 s, 15 of the 21 runs within 90 s (none in 150 s before
    // the fix). 4 and 5 stars, measured over 200 and 240 s: 16 and 7 of the 21 runs escaped.
    const runs = fleeRuns(3, 90, true);
    expect(median(runs.map(lostTime)), showRuns(runs)).toBeLessThanOrEqual(90);
  }, 600_000);
});
