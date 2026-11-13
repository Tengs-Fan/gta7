// What a drive through town costs the people on its streets: a bot at the wheel for two and a half minutes at 58 km/h
// at most, steering round the cars and the people it sees ahead as a player who looks where he is going does
// (fleeBot), on streets as full as a new game finds them at half past five, over 24 seeds (41 km in all).
// Round 8 put half as many people again on the pavements. Measured this way that costs such a driver nothing: nobody
// hit before round 8 (a746489), nobody on its fuller pavements before anyone dodged (a8729e6), nobody now. Who pays for
// fuller streets is the driver who does not look (scripts/playtests/firstjob.mjs has one).

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { input, makeSim, step, teleport } from './helpers';
import { fleeBot } from './r2_police_helpers';

const SEEDS = Array.from({ length: 24 }, (_, k) => k + 1);
const DT = 1 / 60;
/** The bot's top speed (m/s) and how long it drives (s). */
const CRUISE = 16;
const SECONDS = 150;

function getIn(sim: Sim, v: Vehicle): void {
  teleport(sim, v.pos.x + Math.cos(v.heading) * (v.halfW + 0.8), v.pos.z - Math.sin(v.heading) * (v.halfW + 0.8));
  sim.update(DT, input({ enterExit: true }));
  for (let t = 0; t < 3 && sim.player.vehicle !== v; t += DT) sim.update(DT, input());
  expect(sim.player.vehicle).toBe(v);
}

describe('a drive through town at 58 km/h', () => {
  it('by someone who looks where he is going hits nobody, or next to nobody', () => {
    const rows: string[] = [];
    let hits = 0;
    let killed = 0;
    let seedsWithHit = 0;
    let metres = 0;
    for (const seed of SEEDS) {
      const sim = makeSim({ ambient: true, police: true, seed, startHour: 17.5 });
      // The people are what is counted: no police for whoever is hit.
      sim.cheats.neverWanted = true;
      step(sim, 0.1);
      const p = sim.playerPos();
      const lane = sim.roads.nearestLane(p.x, p.z);
      const car = sim.spawnVehicle('sedan', lane.lane.sx + lane.lane.dx * lane.s, lane.lane.sz + lane.lane.dz * lane.s, lane.lane.heading);
      getIn(sim, car);
      // The streets fill round him before he sets off.
      step(sim, 20);
      let mine = 0;
      let dead = 0;
      const was = sim.onCharacterHitByVehicle.bind(sim);
      sim.onCharacterHitByVehicle = (c, v, rel, nx, nz) => {
        const alive = c.alive;
        const r = was(c, v, rel, nx, nz);
        if (v === car && !c.isPlayer) {
          mine++;
          if (alive && !c.alive) dead++;
        }
        return r;
      };
      const bot = fleeBot(sim, car, CRUISE);
      let far = 0;
      for (let t = 0; t < SECONDS && sim.player.vehicle === car && !car.destroyed; t += DT) {
        step(sim, DT, bot(DT));
        far += car.speed * DT;
      }
      rows.push(`seed ${seed}: ${far.toFixed(0)} m driven, ${mine} hit${dead ? `, ${dead} killed` : ''}, car ${car.health.toFixed(0)}${sim.player.vehicle === car ? '' : ' (out of the car)'}`);
      hits += mine;
      killed += dead;
      metres += far;
      if (mine > 0) seedsWithHit++;
    }
    console.log(`[town] a drive at ${CRUISE} m/s at most, ${SECONDS} s a seed:\n${rows.join('\n')}\n[town] summary: ${hits} people hit (${killed} killed) in ${seedsWithHit} of ${SEEDS.length} drives, ${(metres / 1000).toFixed(1)} km driven`);
    expect(metres).toBeGreaterThan(30_000);
    expect(hits).toBeLessThanOrEqual(2);
  }, 900_000);
});
