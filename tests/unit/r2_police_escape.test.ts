// Round 2, cluster "police" (P10 with the lead's balance bounds, made robust in the round 2 fix pass): a fleeing
// player can lose 1 or 2 stars. The flee bot drives a sports car (god mode, ambient city) down the lanes,
// straight on where it can and else the first legal turn, steering round slow and queued traffic as a human
// driver would, under a chase camera like the game's (see r2_police_helpers fleeBot), for 21 seeds. A run stops
// at the bound, and one that keeps the stars that long counts as never.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleeRuns, lostTime, median, showRuns } from './r2_police_helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('losing the police in a fleeing car', () => {
  it('loses 1 star in a median of 30 s at most', () => {
    // Measured in the round 2 fix pass: a median of 21.7 s, 16 of these 21 runs within 30 s (37 of 52 seeds).
    const runs = fleeRuns(1, 30, true);
    expect(median(runs.map(lostTime)), showRuns(runs)).toBeLessThanOrEqual(30);
  }, 600_000);

  it('loses 2 stars in a median of 75 s at most', () => {
    // Measured: a median of 33.3 s, 18 of these 21 runs within 75 s (46 of 52 seeds).
    const runs = fleeRuns(2, 75, true);
    expect(median(runs.map(lostTime)), showRuns(runs)).toBeLessThanOrEqual(75);
  }, 600_000);
});
