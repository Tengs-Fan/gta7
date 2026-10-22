// Street Run laps through ambient traffic, on a reduced seed set (the 16-seed acceptance run uses the same bot).
// The course bot is the flee bot (a DriverAI that ignores lights and picks its line round traffic) steered through
// the course's node sequence. With whole-junction gates and the green wave, a lap through traffic should hit
// nothing much and hardly ever crawl, credit every gate in order, and earn silver or better.

import { describe, expect, it } from 'vitest';
import type { StreetRunJob } from '../../src/sim/activities';
import type { Vehicle } from '../../src/sim/entities';
import type { Lane, Turn } from '../../src/world/roads';
import { makeSim, placeInCar, step } from './helpers';
import { fleeBot } from './r2_police_helpers';

const SEEDS = [1, 2, 3, 4, 5, 6];
/** Acceptance thresholds per course (gameplay F1): mean impacts per lap and mean seconds below 4 m/s while racing. */
const MAX_IMPACTS = 0.6;
const MAX_CRAWL = 3;

interface Lap {
  seed: number;
  traffic: boolean;
  finished: number;
  medal: string;
  impacts: number;
  crawl: number;
  gates: number[];
  total: number;
}

function lap(courseId: string, seed: number, traffic: boolean): Lap {
  const sim = makeSim({ ambient: traffic, police: true, seed, startHour: 18 });
  sim.cheats.neverWanted = true;
  const course = sim.activities.streetRunCourses().find((c) => c.id === courseId)!;
  const car = sim.spawnVehicle('sports', course.start.x, course.start.z, course.start.heading);
  placeInCar(sim, car);
  // Let traffic stream in around the start first.
  step(sim, 8);
  sim.activities.startStreetRun(courseId);
  const nodes = course.nodes;
  const bot = fleeBot(sim, car);
  const priv = bot.ai as unknown as { chooseTurn(l: Lane): Turn | null };
  priv.chooseTurn = (lane: Lane) => {
    for (let k = 0; k < nodes.length - 1; k++) {
      if (nodes[k] === lane.to && (k === 0 || nodes[k - 1] === lane.from)) {
        const t = sim.roads.turnTowards(lane, nodes[k + 1]!);
        if (t) return t;
      }
    }
    return lane.turns.find((t) => t.kind === 'straight') ?? lane.turns[0] ?? null;
  };
  bot.ai.resetPath();
  let impacts = 0;
  const impact = sim.onVehicleImpact.bind(sim);
  sim.onVehicleImpact = (v: Vehicle, other: Vehicle | null, deltaV: number, ...rest: unknown[]) => {
    if ((v === car || other === car) && other && deltaV > 3) impacts++;
    return (impact as (...a: unknown[]) => void)(v, other, deltaV, ...rest);
  };
  let finished = -1;
  let medal = '';
  sim.events.on('streetRunFinished', (e) => {
    finished = e.time;
    medal = e.medal;
  });
  const gates: number[] = [];
  sim.events.on('streetRunCheckpoint', (e) => gates.push(e.index));
  let ended = false;
  sim.events.on('activityEnded', () => (ended = true));
  let crawl = 0;
  const dt = 1 / 60;
  for (let f = 0; f < 60 * 140 && !ended; f++) {
    const racing = (sim.activities.job as StreetRunJob | null)?.stage === 'racing';
    step(sim, dt, bot(dt));
    if (racing && car.speed < 4) crawl += dt;
  }
  return { seed, traffic, finished, medal, impacts, crawl, gates, total: course.checkpoints.length };
}

describe('street run laps through traffic', () => {
  it.each(['magnolia', 'coastline', 'dockside'])('%s: few impacts, little crawling, every gate in order, medals within reach', (id) => {
    const course = makeSim().activities.streetRunCourses().find((c) => c.id === id)!;
    const clear = lap(id, 1, false);
    const laps = SEEDS.map((s) => lap(id, s, true));
    const impacts = laps.reduce((a, r) => a + r.impacts, 0) / laps.length;
    const crawl = laps.reduce((a, r) => a + r.crawl, 0) / laps.length;
    const times = laps.map((r) => r.finished).sort((a, b) => a - b);
    const median = times.length % 2 ? times[(times.length - 1) / 2]! : (times[times.length / 2 - 1]! + times[times.length / 2]!) / 2;
    console.log(
      `[run] ${id} gold ${course.gold}s silver ${course.silver}s bronze ${course.bronze}s: clear lap ${clear.finished.toFixed(1)}s; traffic ${laps.map((r) => (r.finished > 0 ? r.finished.toFixed(1) : `DNF@${r.gates.length}/${r.total}`)).join(' ')} (median ${median.toFixed(1)}s), medals ${laps.map((r) => r.medal || '-').join(',')}; impacts ${impacts.toFixed(2)}/lap; crawl ${crawl.toFixed(2)}s`,
    );
    for (const r of [clear, ...laps]) {
      expect(r.finished, `seed ${r.seed} traffic=${r.traffic} gates ${r.gates.join(',')}`).toBeGreaterThan(0);
      // Each gate credited once, in order: the inside line through a corner counts.
      expect(r.gates).toEqual(Array.from({ length: r.total }, (_, k) => k + 1));
    }
    expect(clear.finished).toBeLessThanOrEqual(course.gold);
    expect(median).toBeLessThanOrEqual(course.silver);
    expect(impacts).toBeLessThanOrEqual(MAX_IMPACTS);
    expect(crawl).toBeLessThanOrEqual(MAX_CRAWL);
  });
});
