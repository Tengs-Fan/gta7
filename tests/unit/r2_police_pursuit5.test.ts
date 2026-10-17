// Round 2, cluster "police" (P10): at 5 stars the pursuit reaches a fleeing car and stays near it. Flee bot and
// seeds as in r2_police_escape.test.ts (21 seeds of 120 s). Round 2 fix pass: the closeness bounds are taken over
// the samples in which the police are in pursuit (wanted and not searching), over all 21 runs together, because
// 5 stars can now be shaken off: a search after the car got away counts its units far from it by design.
// Round 2 fix pass 2: each run is exact (the sim is deterministic). Over seeds 1-126 a unit came within 40 m within
// 30 s in every run, and over the pursuit samples a unit was within 60 m in 74.7% of them with 0.86 units over 150 m
// away; resampling 21 runs, this case fails in 0.19% of seed draws (mostly by the 60% bound, which stays as P10 set
// it). The units over 150 m away, which recycling keeps few, are bounded at 1.15 rather than P10's 1.5: without the
// units that cut a fast player off from ahead and without the recycling of trailing units (before P10) there were
// 1.65 (blocks of 21: 1.33-2.01; seeds 1-21: reached in 17, within 60 m 62%, 1.33 far), and the case passed in
// 0.02% of resampled draws. (It does not catch a missing response phase: within 60 m 61%, 0.98 far, seeds 1-21.)

import { describe, expect, it } from 'vitest';
import { fleeRuns, showRuns } from './r2_police_helpers';

describe('pursuit of a fleeing car at 5 stars', () => {
  it('a unit gets within 40 m within 30 s and, while in pursuit, stays within 60 m most of the time with few units left trailing', () => {
    const runs = fleeRuns(5, 120, false);
    const reached = runs.filter((r) => r.within40At >= 0 && r.within40At < 30).length;
    expect(reached, showRuns(runs)).toBeGreaterThanOrEqual(20);
    const samples = runs.reduce((a, r) => a + r.pursuit.samples, 0);
    const near = runs.reduce((a, r) => a + r.pursuit.near60, 0) / samples;
    const far = runs.reduce((a, r) => a + r.pursuit.far, 0) / samples;
    const msg = `${samples} pursuit samples: within 60 m ${(near * 100).toFixed(0)}%, ${far.toFixed(2)} units over 150 m; ${showRuns(runs)}`;
    expect(samples, msg).toBeGreaterThan(runs.length * 60);
    expect(near, msg).toBeGreaterThanOrEqual(0.6);
    expect(far, msg).toBeLessThanOrEqual(1.15);
  }, 900_000);
});
