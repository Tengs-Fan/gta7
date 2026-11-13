// A story mission against the clock, driven through the real streets by a bot that keeps to 80 km/h: Lou's Hot
// Delivery, the package from a Midtown lot to a buyer in Hillcrest on a 64 s clock set for the streets before round 8
// filled them. Round 8 as it first landed left the fuller traffic in place as the clock started, and over 24 seeds the
// bot reached the buyer's street with a median of 26.2 s left where it had 38.0 s. Now a clock sends the streets back to
// what it was set on at once (TrafficSystem.onTheClock: the old numbers of cars and people, those over them out of
// view let go, nobody jumping clear), and the median is 37.7 s.
// (Vera's Rush Hour was measured the same way and is no yardstick: the bot gets home in 3 of 24 seeds before round 8,
// 3 of 24 as it landed and 4 of 24 now, missing the stops' five metres whatever the streets hold.)

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import { missionSpots } from '../../src/sim/missions/spots';
import type { Sim } from '../../src/sim/sim';
import type { Lane, Turn } from '../../src/world/roads';
import { input, makeSim, step, teleport } from './helpers';
import { fleeBot } from './r2_police_helpers';

const SEEDS = Array.from({ length: 24 }, (_, k) => k + 1);
const DT = 1 / 60;
/** The bot's top speed (m/s): a player in no great hurry, not the racer the street runs are tuned on. */
const CRUISE = 22;

/** Of the seconds left on the clock per seed (-1: never made it): how many made it, and the median and least of those. */
function stats(spare: readonly number[]): { made: number; median: number; least: number; tight: number } {
  const made = spare.filter((x) => x >= 0).sort((a, b) => a - b);
  const mid = made.length >> 1;
  const median = made.length === 0 ? -1 : made.length % 2 ? made[mid]! : (made[mid - 1]! + made[mid]!) / 2;
  return { made: made.length, median, least: made[0] ?? -1, tight: made.filter((x) => x < 15).length };
}

function summary(spare: readonly number[]): string {
  const s = stats(spare);
  return `${s.made} of ${spare.length} made it; of those median ${s.median.toFixed(1)} s left, least ${s.least.toFixed(1)} s, under 15 s left: ${s.tight}`;
}

function setup(seed: number, done: string[]): Sim {
  const sim = makeSim({ ambient: true, police: true, seed, startHour: 17.5 });
  for (const d of done) sim.progress.markDone(d);
  // The clock is what is measured: no stars for whoever the bot clips on the way.
  sim.cheats.neverWanted = true;
  step(sim, 0.1);
  return sim;
}

function startMission(sim: Sim, id: string): void {
  const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === id);
  expect(marker, `marker for ${id}`).toBeDefined();
  teleport(sim, marker!.x, marker!.z);
  step(sim, 0.1);
  sim.update(DT, input({ interact: true }));
  expect(sim.missions.active?.def.id).toBe(id);
}

function stepUntil(sim: Sim, pred: () => boolean, max: number, inp = input()): void {
  for (let t = 0; t < max && !pred(); t += DT) sim.update(DT, inp);
  expect(pred(), 'condition not reached in time').toBe(true);
}

function getIn(sim: Sim, v: Vehicle): void {
  teleport(sim, v.pos.x + Math.cos(v.heading) * (v.halfW + 0.8), v.pos.z - Math.sin(v.heading) * (v.halfW + 0.8));
  sim.update(DT, input({ enterExit: true }));
  stepUntil(sim, () => sim.player.vehicle === v, 3);
}

/** A bot at the wheel of `car` that makes for the lane `at` lies on and drives down it, slowing to `near` m/s within 45 m of it. */
function driver(sim: Sim, car: Vehicle, at: () => { x: number; z: number; heading?: number }, near: number) {
  const bot = fleeBot(sim, car, CRUISE);
  const priv = bot.ai as unknown as { chooseTurn(l: Lane): Turn | null };
  priv.chooseTurn = (lane: Lane) => {
    const p = at();
    const goal = sim.roads.nearestLane(p.x, p.z, p.heading).lane;
    if (lane.to === goal.from) return sim.roads.turnTowards(lane, goal.to) ?? lane.turns[0] ?? null;
    const route = sim.roads.findRoute(lane.to, goal.from, lane.from) ?? sim.roads.findRoute(lane.to, goal.from);
    const next = route && route.length > 1 ? sim.roads.turnTowards(lane, route[1]!) : null;
    return next ?? lane.turns.find((t) => t.kind === 'straight') ?? lane.turns[0] ?? null;
  };
  bot.ai.resetPath();
  return (dt: number) => {
    const p = at();
    bot.ai.maxSpeed = Math.hypot(car.pos.x - p.x, car.pos.z - p.z) < 45 ? near : CRUISE;
    return bot(dt);
  };
}

describe('a mission against the clock leaves room on the fuller streets', () => {
  it("Hot Delivery: the drive from the package to the buyer's street is done with the clock to spare", () => {
    const rows: string[] = [];
    const spare: number[] = [];
    for (const seed of SEEDS) {
      const sim = setup(seed, ['wheels']);
      const spots = missionSpots(sim.world);
      startMission(sim, 'delivery');
      stepUntil(sim, () => sim.missions.active!.objectiveText === 'Collect the package', 20);
      // He has driven to the lot: his car waits on the road beside it, the streets round it as they are by then.
      const lane = sim.roads.nearestLane(spots.packagePickup.x, spots.packagePickup.z);
      const car = sim.spawnVehicle('sedan', lane.lane.sx + lane.lane.dx * lane.s, lane.lane.sz + lane.lane.dz * lane.s, lane.lane.heading);
      teleport(sim, spots.packagePickup.x + 6, spots.packagePickup.z + 6);
      step(sim, 8);
      teleport(sim, spots.packagePickup.x, spots.packagePickup.z);
      stepUntil(sim, () => sim.missions.active!.objectiveText.startsWith('Deliver') || sim.missions.active!.objectiveText.startsWith('Lose'), 2);
      const clock = sim.missions.active!.timer!;
      const allowed = clock.endsAt - sim.time;
      getIn(sim, car);
      // The buyer stands on a lawn 38 m off the road: the drive ends on the road abreast of him, the clock then has
      // to cover those 38 m (eight seconds over the grass, or a sprint).
      const end = sim.roads.nearestLane(spots.packageDrop.x, spots.packageDrop.z);
      const abreast = { x: end.lane.sx + end.lane.dx * end.s, z: end.lane.sz + end.lane.dz * end.s, heading: end.lane.heading };
      const drive = driver(sim, car, () => abreast, 9);
      const near = () => Math.hypot(car.pos.x - abreast.x, car.pos.z - abreast.z) < 10;
      for (let t = 0; t < allowed + 30 && !near() && sim.missions.active; t += DT) step(sim, DT, drive(DT));
      const left = sim.missions.active?.timer ? sim.missions.active.timer.endsAt - sim.time : -1;
      rows.push(`seed ${seed}: clock ${allowed.toFixed(0)} s, abreast of the buyer with ${left.toFixed(1)} s left${near() ? '' : ` (NOT THERE: ${Math.hypot(car.pos.x - abreast.x, car.pos.z - abreast.z).toFixed(0)} m off, mission ${sim.missions.active?.objectiveText ?? 'over'}, car ${car.health.toFixed(0)}, in car ${sim.player.vehicle === car})`}`);
      spare.push(near() ? left : -1);
    }
    console.log(`[timed] Hot Delivery, bot at ${CRUISE} m/s at most:\n${rows.join('\n')}\n[timed] Hot Delivery summary: ${summary(spare)}`);
    // As before round 8 (20 of 24 made it, a median of 38.0 s left, none under 15 s): the bot wrecks its car in a
    // few seeds on any streets, and the rest keep over half the clock for the last 38 m to the buyer.
    const s = stats(spare);
    expect(s.made).toBeGreaterThanOrEqual(20);
    expect(s.median).toBeGreaterThanOrEqual(32);
    expect(s.tight).toBeLessThanOrEqual(3);
  }, 240_000);
});
