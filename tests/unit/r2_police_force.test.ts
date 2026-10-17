// Round 2, cluster "police" (P9): lethal force from 3 stars and arrests only of a player who stopped fighting,
// in the ambient city. Each run depends on how the first units get through the traffic, a chaotic trajectory,
// so (round 2 fix pass) the cases are rates over many seeds with bounds the measured rates clear by a margin.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { aimAt, makeSim, step } from './helpers';
import { countPoliceShots, seedMathRandom } from './r2_police_helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

/** `seeds` runs of 60 s at 4 stars standing still, holding `weapon`, in the ambient city: how each ended. */
function standStill(weapon: 'pistol' | 'fists', seeds: readonly number[]): string[] {
  const out: string[] = [];
  for (const seed of seeds) {
    seedMathRandom(seed);
    const sim = makeSim({ ambient: true, seed });
    if (weapon === 'pistol') {
      sim.player.inventory.give('pistol', 48);
      sim.player.inventory.current = 'pistol';
    }
    sim.wanted.setLevel(4);
    let outcome: string | null = null;
    for (let t = 0; t < 60 && !outcome; t += 0.5) {
      step(sim, 0.5);
      outcome = sim.deathKind;
    }
    out.push(`${seed}:${outcome ?? 'none'}`);
    vi.restoreAllMocks();
  }
  return out;
}

const SEEDS_21 = Array.from({ length: 21 }, (_, i) => i + 1);

describe('lethal force and arrests', () => {
  it('at 4 stars shoot a player who stands still with a gun in hand (WASTED, not BUSTED)', () => {
    // Seeds 1-5 as in the acceptance: wasted in every one of 21 seeds measured.
    const outcomes = standStill('pistol', [1, 2, 3, 4, 5]);
    expect(outcomes.filter((o) => o.endsWith(':wasted')).length, outcomes.join(', ')).toBeGreaterThanOrEqual(4);
  }, 300_000);

  it('at 4 stars arrest a player who stands still unarmed (BUSTED) in most runs', () => {
    // A rate of about 86% (18 of 21, the rest shot in the crossfire), against which the acceptance's 4 of 5
    // flips with any reshuffle of the trajectories: 21 seeds, at least 15 busted.
    const outcomes = standStill('fists', SEEDS_21);
    expect(outcomes.filter((o) => o.endsWith(':busted')).length, outcomes.join(', ')).toBeGreaterThanOrEqual(15);
  }, 600_000);

  it('never busts a player firing a rifle into the air every 0.5 s at 4-5 stars, and fires at him', () => {
    // 21 seeds, 4 stars in the odd ones and 5 in the even. Whether the first unit gets through the traffic within
    // the 30 s depends on the seed: the police fired 15 shots or more in 20 of 21 runs at each level (measured in
    // the round 2 fix pass), so 18 of 21 are asked for; the arrest must never happen.
    const runs: string[] = [];
    let fired = 0;
    for (const seed of SEEDS_21) {
      const level = seed % 2 === 1 ? 4 : 5;
      seedMathRandom(seed);
      const sim = makeSim({ ambient: true, seed });
      sim.cheats.godMode = true;
      const p = sim.player;
      p.inventory.give('rifle', 2000);
      p.inventory.current = 'rifle';
      sim.wanted.setLevel(level);
      const shots = countPoliceShots(sim);
      let busted = false;
      let frame = 0;
      step(sim, 30, () => {
        if (sim.deathKind === 'busted') busted = true;
        const pull = frame++ % 30 === 0;
        return aimAt(sim, { x: p.pos.x + 0.5, y: p.pos.y + 30, z: p.pos.z + 0.5 }, { fire: pull, firePressed: pull });
      });
      expect(busted, `seed ${seed}, ${level} stars`).toBe(false);
      if (shots.n >= 15) fired++;
      runs.push(`seed ${seed} (${level} stars): ${shots.n} police shots`);
      vi.restoreAllMocks();
    }
    expect(fired, runs.join(', ')).toBeGreaterThanOrEqual(18);
  }, 600_000);
});
