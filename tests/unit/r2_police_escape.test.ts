// Round 2, cluster "police" (P10 with the lead's balance bounds, made robust in the round 2 fix pass): a fleeing
// player can lose 1 or 2 stars. The flee bot drives a sports car (god mode, ambient city) down the lanes,
// straight on where it can and else the first legal turn, steering round slow and queued traffic as a human
// driver would, under a chase camera like the game's (see r2_police_helpers fleeBot). A run stops at the bound,
// and one that keeps the stars that long counts as never.
// Round 2 fix pass 2: each run is exact (the sim is deterministic), the bounds come from seeds 1-126 with margins a
// reshuffle of the trajectories (any unrelated change) crosses in well under 1% of seed draws, and each test fails
// with the rule it guards as it was before its fix.

import { describe, expect, it } from 'vitest';
import { fleeRuns, lostTime, median, seeds, showRuns } from './r2_police_helpers';

describe('losing the police in a fleeing car', () => {
  it('loses 1 star in a median of 30 s at most, and soon after a clean getaway', () => {
    // Seeds 1-126: within 30 s in 73% of runs (blocks of 42: 29-32), so the median of 42 runs is over 30 s in 0.12%
    // of seed draws (with 21 runs it was 1.2%). That bound does not catch the rule it was set for, though: with
    // P10's first evade time, 9 s + 5 s a star (14 s at 1 star, sticky with the bot of the time), the median is
    // 26 s with today's bot. The quickest getaways do: no run can lose the star before the response phase (7 s)
    // and the evade time have passed and it has left the 85 m search area, so with 14 s none can within 22 s
    // (the first did at 22.7 s), while 43% of runs do now (the first at 18.7 s); the quickest of 42 has to.
    const runs = fleeRuns(1, 30, true, seeds(42));
    const times = runs.map(lostTime);
    expect(median(times), showRuns(runs)).toBeLessThanOrEqual(30);
    expect(Math.min(...times), showRuns(runs)).toBeLessThanOrEqual(22);
  }, 600_000);

  it('loses 2 stars in a median of 75 s at most, and within 40 s in many runs', () => {
    // Seeds 1-126: within 75 s in 86% of runs, so the median of 42 is over 75 s in under 1e-7 of seed draws. What it
    // guards is when units are sent to cut a fast player off from ahead: sent whenever he drives fast (every second
    // unit, as P10 first had it), they put the median at 55 s (seeds 1-63), which that bound allows. They make a getaway
    // work at once far less often, though: within 40 s in 64% of runs now (blocks of 42: 25-29) against 22% then
    // (seeds 1-42: 29 now, 11 then), so at least 18 of 42 fails now in 0.14% of draws and passes then in 0.23%.
    // (With the round 2 fix pass's first rule, cut-offs whenever no unit is within 60 m but without the breather after
    // a unit has caught up with him, the median is 40 s and 48% get away within 40 s: too close to tell apart.)
    const runs = fleeRuns(2, 75, true, seeds(42));
    const times = runs.map(lostTime);
    expect(median(times), showRuns(runs)).toBeLessThanOrEqual(75);
    expect(times.filter((t) => t <= 40).length, showRuns(runs)).toBeGreaterThanOrEqual(18);
  }, 900_000);
});
