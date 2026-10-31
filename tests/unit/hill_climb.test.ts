// The Coyote Ridge Hill Climb (sim/activities/hillClimb.ts): T starts it only in a vehicle at the fire road's foot gate,
// its gates count only in order, a scripted Nightjar run up the fire road lands inside the gold time that run set the
// medals by, leaving the car ends it, the best run is kept through a save, and multiplayer says it is single-player only.

import { describe, expect, it, vi } from 'vitest';
import { clamp, wrapAngle } from '../../src/core/math';
import { multiplayerInteractions } from '../../src/net/mpPlaces';
import { completionRows } from '../../src/sim/completion';
import type { Vehicle } from '../../src/sim/entities';
import { HILL_CLIMB_GATE_R, HILL_CLIMB_GATES, HILL_CLIMB_REWARD, HILL_CLIMB_START, HILL_CLIMB_TIMES, hillClimbMedal, MP_NO_HILL_CLIMB, type HillClimbJob } from '../../src/sim/activities/hillClimb';
import { activityRecords } from '../../src/sim/activities/records';
import { applySave, parseSave, serialize } from '../../src/sim/progress';
import { applyExt, serializeExt } from '../../src/sim/saveExt';
import type { Sim } from '../../src/sim/sim';
import { fireRoadLine, LOOKOUT } from '../../src/world/country/hills';
import { rectContains } from '../../src/world/layout';
import { input, makeSim, placeInCar, world } from './helpers';

await vi.hoisted(async () => {
  const m = await import('../support/canvasStub');
  m.installCanvasStubs();
});

const line = fireRoadLine(1);
const job = (sim: Sim) => sim.activities.job as HillClimbJob | null;

/** A sim with the player at the wheel of a `kind` at (x, z), facing `heading`. */
function inCar(x: number = HILL_CLIMB_START.x, z: number = HILL_CLIMB_START.z, heading: number = HILL_CLIMB_START.heading, opts: { multiplayer?: boolean; kind?: 'sports' | 'sedan' } = {}): { sim: Sim; car: Vehicle } {
  const sim = makeSim({ seed: 21, police: false, multiplayer: opts.multiplayer });
  const car = sim.spawnVehicle(opts.kind ?? 'sports', x, z, heading);
  placeInCar(sim, car);
  return { sim, car };
}

/**
 * The scripted driver: aims at the fire road's centre line some metres ahead of where it is (more the faster it goes),
 * at full throttle, braking ahead of a bend to `bend` m/s and easing off while the nose is far off line.
 */
function driver(car: Vehicle, throttle = 1, bend = 11) {
  let i = 0;
  let near = Infinity;
  for (const [k, p] of line.entries()) {
    const d = Math.hypot(p.x - car.pos.x, p.z - car.pos.z);
    if (d < near) {
      near = d;
      i = k;
    }
  }
  const aim = line[Math.min(line.length - 1, i + Math.round(6 + car.speed * 0.35))]!;
  const err = wrapAngle(Math.atan2(aim.x - car.pos.x, aim.z - car.pos.z) - car.heading);
  // The next bend: where the road's heading has turned a quarter from here, within the braking distance.
  let brake = false;
  for (let k = i; k < line.length && line[k]!.s - line[i]!.s < 40; k++) {
    if (Math.abs(wrapAngle(line[k]!.heading - line[i]!.heading)) > 0.5) {
      const d = line[k]!.s - line[i]!.s;
      brake = car.speed > bend + 0.5 && d < (car.speed ** 2 - bend ** 2) / 14 + 4;
      break;
    }
  }
  return input({ throttle: brake ? 0 : (Math.abs(err) > 0.8 ? 0.5 : 1) * throttle, brake: brake ? 1 : 0, steer: clamp(-err * 2.5, -1, 1) });
}

/** Starts the climb from the foot gate and waits out the countdown. */
function launched(r = inCar()): { sim: Sim; car: Vehicle } {
  r.sim.activities.toggleJob();
  expect(job(r.sim)?.stage).toBe('countdown');
  for (let i = 0; i < 60 * 3.2; i++) r.sim.update(1 / 60, input());
  expect(job(r.sim)?.stage).toBe('racing');
  return r;
}

/** The scripted run, at `throttle`: the time on the clock when the last gate is passed, or null if it never was. */
function run(sim: Sim, car: Vehicle, throttle = 1): number | null {
  let time: number | null = null;
  for (let i = 0; i < 60 * 90 && job(sim); i++) {
    const j = job(sim)!;
    sim.update(1 / 60, driver(car, throttle));
    if (!job(sim) && j.gate === HILL_CLIMB_GATES.length) time = j.elapsed;
  }
  return time;
}

describe('Coyote Ridge Hill Climb', () => {
  it('has six gates on the fire road, the last at Lookout Point, and its foot gate on the gravel off the highway', () => {
    expect(HILL_CLIMB_GATES.length).toBe(6);
    expect(HILL_CLIMB_GATES[5]!.label).toBe('Lookout Point');
    expect(rectContains(LOOKOUT.pad, HILL_CLIMB_GATES[5]!.x, HILL_CLIMB_GATES[5]!.z)).toBe(true);
    for (const g of HILL_CLIMB_GATES) expect(Math.min(...line.map((p) => Math.hypot(p.x - g.x, p.z - g.z)))).toBeLessThan(0.75);
    const W = world();
    expect(W.groundHeight(HILL_CLIMB_START.x, HILL_CLIMB_START.z)).toBe(0);
    expect(Math.min(...line.map((p) => Math.hypot(p.x - HILL_CLIMB_START.x, p.z - HILL_CLIMB_START.z)))).toBeLessThan(0.75);
  });

  it('starts in any road vehicle at the foot gate, not elsewhere, and not in multiplayer', () => {
    const at = inCar(HILL_CLIMB_START.x + 9, HILL_CLIMB_START.z + 6, 0, { kind: 'sedan' });
    expect(at.sim.activities.jobPrompt()).toBe('Press T to start the Coyote Ridge Hill Climb');
    at.sim.activities.toggleJob();
    expect(job(at.sim)?.kind).toBe('hillClimb');
    expect(job(at.sim)?.stage).toBe('approach');
    expect(at.sim.activities.objectives()[0]).toMatchObject({ x: HILL_CLIMB_START.x, z: HILL_CLIMB_START.z });
    expect(at.sim.activities.status()).toBe('COYOTE RIDGE HILL CLIMB · STOP IN THE FOOT GATE');
    // T again gives it up.
    at.sim.activities.toggleJob();
    expect(at.sim.activities.job).toBeNull();
    // On the highway 20 m off, it is a street run's.
    const far = inCar(HILL_CLIMB_START.x + 20, HILL_CLIMB_START.z, 0);
    expect(far.sim.activities.jobPrompt()).toBe('Press T to start a street run');
    // A multiplayer room says why not, and a client at the foot gate is told so.
    const mp = inCar(HILL_CLIMB_START.x, HILL_CLIMB_START.z, HILL_CLIMB_START.heading, { multiplayer: true });
    const said: string[] = [];
    mp.sim.events.on('message', (e) => said.push(e.text));
    mp.sim.activities.toggleJob();
    expect(mp.sim.activities.job).toBeNull();
    expect(said).toContain(MP_NO_HILL_CLIMB);
    const view = multiplayerInteractions(world());
    const c = { ...mp.sim.player, pos: { x: HILL_CLIMB_START.x, y: 0, z: HILL_CLIMB_START.z }, state: 'normal', vehicle: null };
    expect(view.prompt({ character: c, down: false, pos: () => c.pos } as never)).toBe(MP_NO_HILL_CLIMB);
  });

  it('counts the gates only in order', () => {
    const { sim, car } = launched();
    // Through gate 1, then straight up the slope past gate 3, wide of gate 2: that counts for nothing.
    const [g1, , g3] = HILL_CLIMB_GATES as [typeof HILL_CLIMB_GATES[0], typeof HILL_CLIMB_GATES[0], typeof HILL_CLIMB_GATES[0]];
    const steerFor = (x: number, z: number) => input({ throttle: 0.6, steer: clamp(-wrapAngle(Math.atan2(x - car.pos.x, z - car.pos.z) - car.heading) * 2.5, -1, 1) });
    for (let i = 0; i < 60 * 20 && job(sim)!.gate === 0; i++) sim.update(1 / 60, steerFor(g1.x, g1.z));
    expect(job(sim)!.gate).toBe(1);
    expect(sim.activities.status()).toMatch(/^COYOTE RIDGE HILL CLIMB · GATE 2\/6 · 0:\d\d\.\d$/);
    for (let i = 0; i < 60 * 20 && Math.hypot(car.pos.x - g3.x, car.pos.z - g3.z) > 3; i++) sim.update(1 / 60, steerFor(g3.x, g3.z));
    expect(Math.hypot(car.pos.x - g3.x, car.pos.z - g3.z)).toBeLessThanOrEqual(3);
    expect(job(sim)!.gate).toBe(1);
  });

  it('a scripted Nightjar run up the fire road finishes inside the gold time, about 5% faster, and pays gold', () => {
    const { sim, car } = launched();
    const money = sim.progress.money;
    const t = run(sim, car);
    console.log(`[hill_climb] scripted run ${t?.toFixed(2)} s; gold ${HILL_CLIMB_TIMES.gold} (+${((HILL_CLIMB_TIMES.gold / t! - 1) * 100).toFixed(1)}%), silver ${HILL_CLIMB_TIMES.silver} (+${((HILL_CLIMB_TIMES.silver / t! - 1) * 100).toFixed(1)}%), bronze ${HILL_CLIMB_TIMES.bronze} (+${((HILL_CLIMB_TIMES.bronze / t! - 1) * 100).toFixed(1)}%)`);
    expect(t).not.toBeNull();
    expect(hillClimbMedal(t!)).toBe('gold');
    expect(HILL_CLIMB_TIMES.gold / t!).toBeGreaterThan(1.03);
    expect(HILL_CLIMB_TIMES.gold / t!).toBeLessThan(1.07);
    expect(HILL_CLIMB_TIMES.silver / t!).toBeCloseTo(1.25, 1);
    expect(HILL_CLIMB_TIMES.bronze / t!).toBeCloseTo(1.6, 1);
    expect(sim.progress.money - money).toBe(HILL_CLIMB_REWARD);
    expect(sim.activities.job).toBeNull();
    // It ends at the top, on the car park.
    expect(car.pos.y).toBeCloseTo(24, 1);
  });

  it('ends without pay when the driver leaves the car', () => {
    const { sim, car } = launched();
    for (let i = 0; i < 60 * 2; i++) sim.update(1 / 60, driver(car));
    sim.update(1 / 60, input({ enterExit: true }));
    for (let i = 0; i < 60; i++) sim.update(1 / 60, input());
    expect(sim.player.vehicle).toBeNull();
    expect(sim.activities.job).toBeNull();
    expect(activityRecords(sim.progress).hillClimbBest).toBe(0);
  });

  it('keeps the best run through a save, and a slower one does not replace it', () => {
    const { sim, car } = launched();
    const t = run(sim, car)!;
    const best = activityRecords(sim.progress).hillClimbBest;
    expect(best).toBe(Math.round(t * 1000));
    const saved = parseSave(JSON.parse(JSON.stringify(serialize(sim.progress, [], 0, 12, 1, serializeExt(sim)))))!;
    const again = inCar();
    applySave(again.sim.progress, saved);
    applyExt(again.sim, saved.ext);
    expect(activityRecords(again.sim.progress).hillClimbBest).toBe(best);
    launched(again);
    const slow = run(again.sim, again.car, 0.7)!;
    console.log(`[hill_climb] seven-tenths-throttle run ${slow.toFixed(2)} s (${hillClimbMedal(slow)})`);
    expect(slow).toBeGreaterThan(t);
    expect(activityRecords(again.sim.progress).hillClimbBest).toBe(best);
    // The checklist's row shows the medal.
    const row = completionRows(again.sim, again.sim.players[0]!).find((r) => r.id === 'activity:hillClimb')!;
    expect([row.label, row.done, row.total]).toEqual(['Hill Climb medal', 1, 1]);
  });

  it('keeps the gates the size of the road and a little over', () => {
    expect(HILL_CLIMB_GATE_R).toBeGreaterThan(3);
    expect(HILL_CLIMB_GATE_R).toBeLessThan(10);
  });
});
