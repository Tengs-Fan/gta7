// Round 2, cluster "police" (P10 with the lead's balance bounds): a fleeing player can still lose 1 or 2
// stars. The flee bot drives a sports car (god mode, ambient city) flat out down the lanes, straight on
// where it can and else the first legal turn, for seeds 3, 11 and 19.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flee, FLEE_SEEDS, type FleeRun, median, showRuns } from './r2_police_helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('losing the police in a fleeing car', () => {
  // A run is cut off at the bound: one that keeps the stars that long counts as never (Infinity),
  // which can only push the median up.
  const lost = (r: FleeRun) => (r.lostAt < 0 ? Infinity : r.lostAt);

  it('loses 1 star in a median of 30 s at most', () => {
    const runs = FLEE_SEEDS.map((s) => flee(1, s, 30, true));
    expect(median(runs.map(lost)), showRuns(runs)).toBeLessThanOrEqual(30);
  });

  it('loses 2 stars in a median of 75 s at most', () => {
    const runs = FLEE_SEEDS.map((s) => flee(2, s, 75, true));
    expect(median(runs.map(lost)), showRuns(runs)).toBeLessThanOrEqual(75);
  });
});
