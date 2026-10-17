// Round 2 fix pass, cluster "police": with the helicopter in the chase a fleeing car can still lose 3 stars. Flee bot
// and seeds as in r2_police_escape.test.ts; a run stops at its bound, and one that keeps the stars that long counts as
// never.
//
// Round 2 fix pass 2: the helicopter used to cruise at 40 m/s, dash at 55 m/s, see 110 m and fire at anyone in
// range; it now cruises at 30 m/s, below a getaway car's speed, and sees 60 m (see r2_police.test.ts for the
// helicopter itself). In the whole chase the units on the ground and the buildings in the way decide most runs, so
// the time to lose 3 stars barely tells the two helicopters apart (over seeds 1-168: a median of 67 s now against
// 91 s with the old rules, but within 90 s in 70% of runs against 49%, which no affordable number of seeds
// separates), and this test used to pass with the old helicopter. Even with only the helicopter after the car it
// keeps losing sight of it behind buildings and in traffic. So the first case runs the getaways on empty streets
// with only the helicopter after the car: there the car's pace decides, which is what the helicopter's rules are
// about.

import { describe, expect, it } from 'vitest';
import { fleeRuns, lostTime, median, seeds, showRuns } from './r2_police_helpers';

describe('losing 3 stars in a fleeing car', () => {
  it('outruns the helicopter: with only the helicopter after him on empty streets, the stars go soon after the response phase', () => {
    // The earliest the stars can go is 43.6 s (13 s of response phase, 28 s of evade time, leaving the search area).
    // Over seeds 1-168: within 55 s in 97.6% of runs now (blocks of 42: 39-42), so at least 36 of 42 fails in
    // 0.006% of seed draws; with the old helicopter rules in 57% (blocks of 42: 18-27; 26 of seeds 1-42), which
    // passes it in 0.007%.
    const runs = fleeRuns(3, 55, true, seeds(42), { units: false, traffic: false });
    const lost = runs.filter((r) => r.lostAt >= 0).length;
    expect(lost, showRuns(runs)).toBeGreaterThanOrEqual(36);
    // With a helicopter in it at all (Codex review: without one, every run gets away): its crew made the car out in
    // 165 of seeds 1-168 (blocks of 42: 40-42), so at least 37 of 42 fails in 0.01% of seed draws.
    expect(runs.filter((r) => r.heliSeenAt >= 0).length, showRuns(runs)).toBeGreaterThanOrEqual(37);
  }, 900_000);

  it('loses 3 stars in a median of 2 minutes at most with every unit after him', () => {
    // Over seeds 1-168: within 120 s in 81% of runs (blocks of 21: 15-20), so the median of 21 runs is over 2 minutes
    // in 0.06% of seed draws (within the old bound, 90 s, in 70%: 2.5% of draws failed it).
    const runs = fleeRuns(3, 120, true);
    expect(median(runs.map(lostTime)), showRuns(runs)).toBeLessThanOrEqual(120);
  }, 900_000);
});
