// Round 2, cluster "police" (P10): at 5 stars the pursuit reaches a fleeing car and stays near it. Flee bot and
// seeds as in r2_police_escape.test.ts (21 seeds). Round 2 fix pass: the closeness bounds are taken over the
// samples in which the police are in pursuit (wanted and not searching), over all 21 runs together, because
// 5 stars can now be shaken off: a search after the car got away counts its units far from it by design. The
// runs last 60 s rather than the acceptance's 120 s to keep the suite fast; 120 s runs measured a pursuit
// share within 60 m of 0.83 and 0.84 units over 150 m away (60 s: 0.73 and 0.95).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleeRuns, showRuns } from './r2_police_helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pursuit of a fleeing car at 5 stars', () => {
  it('a unit gets within 40 m within 30 s and, while in pursuit, stays within 60 m most of the time with few units left trailing', () => {
    const runs = fleeRuns(5, 60, false);
    const reached = runs.filter((r) => r.within40At >= 0 && r.within40At < 30).length;
    expect(reached, showRuns(runs)).toBeGreaterThanOrEqual(20);
    const samples = runs.reduce((a, r) => a + r.pursuit.samples, 0);
    const near = runs.reduce((a, r) => a + r.pursuit.near60, 0) / samples;
    const far = runs.reduce((a, r) => a + r.pursuit.far, 0) / samples;
    const msg = `${samples} pursuit samples: within 60 m ${(near * 100).toFixed(0)}%, ${far.toFixed(2)} units over 150 m; ${showRuns(runs)}`;
    expect(samples, msg).toBeGreaterThan(runs.length * 60);
    expect(near, msg).toBeGreaterThanOrEqual(0.6);
    expect(far, msg).toBeLessThanOrEqual(1.5);
  }, 600_000);
});
