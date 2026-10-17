// Round 2, cluster "police" (P9): lethal force from 3 stars and arrests only of a player who stopped fighting,
// in the ambient city. Each run depends on how the first units get through the traffic, a chaotic trajectory,
// so (round 2 fix pass) the cases are rates over many seeds with bounds the measured rates clear by a margin.
// Round 2 fix pass 2: the sim is deterministic, so every seed's outcome is exact; each bound is set from rates
// measured over 105-210 seeds so that a reshuffle of the trajectories (any unrelated change) fails it in well under
// 1% of seed draws, and each case was run against the rule it guards as it was before its fix, where it fails.

import { describe, expect, it } from 'vitest';
import { aimAt, makeSim, step } from './helpers';
import { countPoliceShots } from './r2_police_helpers';

/** `seeds` runs of 60 s at 4 stars standing still, holding `weapon`, in the ambient city: how each ended. */
function standStill(weapon: 'pistol' | 'fists', seeds: readonly number[]): string[] {
  const out: string[] = [];
  for (const seed of seeds) {
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
  }
  return out;
}

const SEEDS_21 = Array.from({ length: 21 }, (_, i) => i + 1);

describe('lethal force and arrests', () => {
  it('at 4 stars shoot a player who stands still with a gun in hand (WASTED, not BUSTED)', () => {
    // Seeds 1-5 as in the acceptance: wasted in each of seeds 1-126. With the arrest rule before P9 (the nearest
    // officer walks up to arrest any player standing still, armed or not, while the others hold fire) he was busted
    // in each of seeds 1-21.
    const outcomes = standStill('pistol', [1, 2, 3, 4, 5]);
    expect(outcomes.filter((o) => o.endsWith(':wasted')).length, outcomes.join(', ')).toBeGreaterThanOrEqual(4);
  }, 300_000);

  it('at 4 stars arrest a player who stands still unarmed (BUSTED) rather than shoot him dead', () => {
    // Round 2 fix pass 2: everyone now holds fire while he waits for an officer to cuff him (see pickArrester).
    // Busted in 208 of seeds 1-210 (99%; every block of 42 seeds: 41-42), so at least 38 of 42 fails in 0.005%
    // of seed draws (0.8% if the true rate were as low as 97%). Before, SWAT, who never make the arrest, and the
    // helicopter shot him dead before an officer who could came: busted in 92 of seeds 1-126 (73%; 33 of seeds
    // 1-42), so that rule passes this bound in 0.5% of draws. (The old bound, 30 of 42, sat at that rate.)
    const outcomes = standStill('fists', Array.from({ length: 42 }, (_, i) => i + 1));
    expect(outcomes.filter((o) => o.endsWith(':busted')).length, outcomes.join(', ')).toBeGreaterThanOrEqual(38);
  }, 900_000);

  it('never busts a player firing a rifle into the air every 0.5 s at 4-5 stars, and fires at him', () => {
    // 21 seeds, 4 stars in the odd ones and 5 in the even. Whether the first unit gets through the traffic within
    // the 30 s depends on the seed: the police fired 15 shots or more in 103 of seeds 1-105 (round 2 fix pass 2),
    // so 18 of 21 are asked for (failing in under 0.1% of seed draws); the arrest must never happen (busted in none
    // of the 105). With the arrest rule before P9 he was busted in 15 of seeds 1-21 and drew no shot in any.
    const runs: string[] = [];
    let fired = 0;
    for (const seed of SEEDS_21) {
      const level = seed % 2 === 1 ? 4 : 5;
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
    }
    expect(fired, runs.join(', ')).toBeGreaterThanOrEqual(18);
  }, 600_000);
});
