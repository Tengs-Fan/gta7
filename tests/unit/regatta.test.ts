// The Gull Regatta (sim/activities/regatta.ts): T starts it only in a boat at the Marina, its gates count only in order,
// a scripted Marlin lap is inside the gold time that lap set the medals by, running out of time or leaving the boat ends
// it, and the best lap is kept through a save.

import { describe, expect, it } from 'vitest';
import { clamp, wrapAngle } from '../../src/core/math';
import { multiplayerInteractions } from '../../src/net/mpPlaces';
import { activityRecords } from '../../src/sim/activities/records';
import { MP_NO_REGATTA, REGATTA_GATE_R, REGATTA_GATES, REGATTA_START, REGATTA_TIMES, regattaMedal, type RegattaJob } from '../../src/sim/activities/regatta';
import type { Vehicle } from '../../src/sim/entities';
import { applySave, parseSave, serialize } from '../../src/sim/progress';
import { applyExt, serializeExt } from '../../src/sim/saveExt';
import { Sim } from '../../src/sim/sim';
import { WATER_Y } from '../../src/world/constants';
import { headlandAt } from '../../src/world/layout';
import { foreshoreReach, shores } from '../../src/world/shore';
import { input, makeSim, placeInCar, step, world } from './helpers';

/** A sim with the player at the helm of a Marlin at (x, z), facing `heading`. */
function inBoat(x: number = REGATTA_START.x, z: number = REGATTA_START.z, heading: number = REGATTA_START.heading, opts: { multiplayer?: boolean } = {}): { sim: Sim; boat: Vehicle } {
  const sim = makeSim({ seed: 21, police: false, ...opts });
  const boat = sim.spawnVehicle('speedboat', x, z, heading);
  boat.pos.y = WATER_Y;
  placeInCar(sim, boat);
  return { sim, boat };
}

const job = (sim: Sim) => sim.activities.job as RegattaJob | null;

/**
 * The scripted skipper: for gate `i`, aimed a little past its centre towards the gate after it, at full throttle, braking
 * ahead of a gate where the course turns hard (to 12-24 m/s, by how hard) and easing off while the bow is far off line.
 * `throttle` scales its throttle.
 */
function skipper(boat: Vehicle, i: number, throttle = 1) {
  const g = REGATTA_GATES[i]!;
  const next = REGATTA_GATES[i + 1];
  const prev = i > 0 ? REGATTA_GATES[i - 1]! : REGATTA_START;
  let ax = g.x;
  let az = g.z;
  let turn = 0;
  if (next) {
    const d = Math.hypot(next.x - g.x, next.z - g.z);
    ax += ((next.x - g.x) / d) * 8;
    az += ((next.z - g.z) / d) * 8;
    turn = Math.abs(wrapAngle(Math.atan2(next.x - g.x, next.z - g.z) - Math.atan2(g.x - prev.x, g.z - prev.z)));
  }
  const err = wrapAngle(Math.atan2(ax - boat.pos.x, az - boat.pos.z) - boat.heading);
  const slowTo = turn < 0.6 ? 40 : turn < 1.1 ? 24 : turn < 1.6 ? 17 : 12;
  const brake = boat.speed > slowTo + 1 && Math.hypot(g.x - boat.pos.x, g.z - boat.pos.z) < (boat.speed ** 2 - slowTo ** 2) / 14 + 12;
  return input({ throttle: brake ? 0 : (Math.abs(err) > 1.2 ? 0.5 : 1) * throttle, brake: brake ? 1 : 0, steer: clamp(-err * 3, -1, 1) });
}

/** Steers the boat at full throttle straight for the point (x, z). */
function steerFor(boat: Vehicle, x: number, z: number) {
  const err = wrapAngle(Math.atan2(x - boat.pos.x, z - boat.pos.z) - boat.heading);
  return input({ throttle: 1, steer: clamp(-err * 3, -1, 1) });
}

/** Starts the regatta from the start line and waits out the countdown. */
function launched(r = inBoat()): { sim: Sim; boat: Vehicle } {
  r.sim.activities.toggleJob();
  expect(job(r.sim)?.stage).toBe('countdown');
  step(r.sim, 3.2);
  expect(job(r.sim)?.stage).toBe('racing');
  return r;
}

/**
 * The scripted lap: each gate in turn, aimed at its centre, at `throttle`. Returns the time on the clock when the last
 * gate is passed, or null if it never was.
 */
function lap(sim: Sim, boat: Vehicle, throttle = 1): number | null {
  let time: number | null = null;
  for (let i = 0; i < 60 * 240 && job(sim); i++) {
    const j = job(sim)!;
    sim.update(1 / 60, skipper(boat, j.gate, throttle));
    if (!job(sim) && j.gate === REGATTA_GATES.length) time = j.elapsed;
  }
  return time;
}

describe('Gull Regatta', () => {
  it('lays every gate 30 m clear of the turbines and of the rocks round the Key, out in deep water', () => {
    const W = world();
    const towers = W.layout.props.filter((p) => p.kind === 'turbine');
    const keyShores = shores(W).filter((s) => headlandAt(W.layout, (s.x0 + s.x1) / 2 - s.nx, (s.z0 + s.z1) / 2 - s.nz)?.name === "Smuggler's Key");
    expect(keyShores.length).toBeGreaterThan(4);
    for (const g of REGATTA_GATES) {
      for (const t of towers) expect(Math.hypot(g.x - t.x, g.z - t.z), `${g.label} to a turbine`).toBeGreaterThanOrEqual(30);
      for (const s of keyShores) {
        const len = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
        const reach = foreshoreReach(s);
        for (let d = 0; d <= len; d += 1) {
          const o = reach(d);
          const rx = s.x0 + ((s.x1 - s.x0) * d) / len + s.nx * o;
          const rz = s.z0 + ((s.z1 - s.z0) * d) / len + s.nz * o;
          expect(Math.hypot(g.x - rx, g.z - rz), `${g.label} to the Key's rocks`).toBeGreaterThanOrEqual(30);
        }
      }
      for (let a = 0; a < 8; a++) expect(W.waterDepth(g.x + Math.cos(a) * REGATTA_GATE_R, g.z + Math.sin(a) * REGATTA_GATE_R)).toBeGreaterThan(3);
    }
    expect(REGATTA_GATES.length).toBe(14);
    expect(REGATTA_GATES.find((g) => g.label === 'Lighthouse')!.z).toBeLessThan(-650);
  });

  it('starts only from a boat at the Marina, and not in multiplayer', () => {
    const marina = world().layout.pois.find((p) => p.kind === 'marina')!;
    const at = inBoat(marina.x + 30, marina.z - 30);
    expect(at.sim.activities.jobPrompt()).toBe('Press T to start the Gull Regatta');
    at.sim.activities.toggleJob();
    expect(job(at.sim)?.kind).toBe('regatta');
    expect(job(at.sim)?.stage).toBe('approach');
    expect(at.sim.activities.objectives()[0]).toMatchObject({ x: REGATTA_START.x, z: REGATTA_START.z });
    // T again gives it up.
    at.sim.activities.toggleJob();
    expect(at.sim.activities.job).toBeNull();
    // Out at sea a boat has nothing to start.
    const far = inBoat(700, -300);
    expect(far.sim.activities.jobPrompt()).toBeNull();
    far.sim.activities.toggleJob();
    expect(far.sim.activities.job).toBeNull();
    // A car on the Marina's deck is offered a street run, not the regatta.
    const car = makeSim({ seed: 21, police: false });
    const sedan = car.spawnVehicle('sedan', marina.x - 20, marina.z, Math.PI / 2);
    placeInCar(car, sedan);
    expect(car.activities.jobPrompt()).toBe('Press T to start a street run');
    // A multiplayer room says why not.
    const mp = inBoat(REGATTA_START.x, REGATTA_START.z, REGATTA_START.heading, { multiplayer: true });
    const said: string[] = [];
    mp.sim.events.on('message', (e) => said.push(e.text));
    mp.sim.activities.toggleJob();
    expect(mp.sim.activities.job).toBeNull();
    expect(said).toContain(MP_NO_REGATTA);
    // And a multiplayer client says so on the Marina's deck.
    const view = multiplayerInteractions(world());
    const c = { ...mp.sim.player, pos: { x: marina.x, y: 0.45, z: marina.z }, state: 'normal', vehicle: null };
    expect(view.prompt({ character: c, down: false, pos: () => c.pos } as never)).toBe(MP_NO_REGATTA);
  });

  it('counts the gates only in order', () => {
    const { sim, boat } = launched();
    // Straight for gate 2, wide of gate 1: passing it first counts for nothing.
    const g1 = REGATTA_GATES[0]!;
    const g2 = REGATTA_GATES[1]!;
    let closest = Infinity;
    for (let i = 0; i < 60 * 40 && Math.hypot(boat.pos.x - g2.x, boat.pos.z - g2.z) > 5; i++) {
      sim.update(1 / 60, steerFor(boat, g2.x - 25, g2.z));
      closest = Math.min(closest, Math.hypot(boat.pos.x - g1.x, boat.pos.z - g1.z));
    }
    expect(closest).toBeGreaterThan(REGATTA_GATE_R);
    expect(job(sim)?.gate).toBe(0);
    for (let i = 0; i < 60 * 40 && job(sim)?.gate === 0; i++) sim.update(1 / 60, steerFor(boat, g1.x, g1.z));
    expect(job(sim)?.gate).toBe(1);
    expect(sim.activities.status()).toMatch(/^GULL REGATTA · GATE 2\/14 · \d:\d\d\.\d$/);
  });

  it('a scripted Marlin lap finishes inside the gold time, about 5% faster, and pays gold', () => {
    const { sim, boat } = launched();
    const money = sim.progress.money;
    const t = lap(sim, boat);
    console.log(`[regatta] scripted lap ${t?.toFixed(2)} s; gold ${REGATTA_TIMES.gold} (+${(((REGATTA_TIMES.gold / t!) - 1) * 100).toFixed(1)}%), silver ${REGATTA_TIMES.silver} (+${(((REGATTA_TIMES.silver / t!) - 1) * 100).toFixed(1)}%), bronze ${REGATTA_TIMES.bronze} (+${(((REGATTA_TIMES.bronze / t!) - 1) * 100).toFixed(1)}%)`);
    expect(t).not.toBeNull();
    expect(regattaMedal(t!)).toBe('gold');
    expect(REGATTA_TIMES.gold / t!).toBeGreaterThan(1.03);
    expect(REGATTA_TIMES.gold / t!).toBeLessThan(1.07);
    expect(REGATTA_TIMES.silver / t!).toBeCloseTo(1.25, 1);
    expect(REGATTA_TIMES.bronze / t!).toBeCloseTo(1.6, 1);
    expect(sim.progress.money - money).toBe(1500);
    expect(sim.activities.job).toBeNull();
  });

  it('ends without pay when the time runs out or the skipper leaves the boat', () => {
    const idle = launched();
    const big: string[] = [];
    idle.sim.events.on('big', (e) => big.push(e.text));
    step(idle.sim, REGATTA_TIMES.bronze + 1);
    expect(idle.sim.activities.job).toBeNull();
    expect(big).toContain('OUT OF TIME');
    expect(activityRecords(idle.sim.progress).regattaBest).toBe(0);
    const left = launched();
    step(left.sim, 2, input({ throttle: 1 }));
    step(left.sim, 0.1, input({ enterExit: true }));
    step(left.sim, 1);
    expect(left.sim.player.vehicle).toBeNull();
    expect(left.sim.activities.job).toBeNull();
  });

  it('keeps the best lap through a save, and a slower one does not replace it', () => {
    const { sim, boat } = launched();
    const t = lap(sim, boat)!;
    const best = activityRecords(sim.progress).regattaBest;
    expect(best).toBe(Math.round(t * 1000));
    const saved = parseSave(JSON.parse(JSON.stringify(serialize(sim.progress, [], 0, 12, 1, serializeExt(sim)))))!;
    const again = makeSim({ seed: 21, police: false });
    applySave(again.progress, saved);
    applyExt(again, saved.ext);
    expect(activityRecords(again.progress).regattaBest).toBe(best);
    // A lap at three quarters throttle still finishes, slower, and leaves the best as it was.
    const boat2 = again.spawnVehicle('speedboat', REGATTA_START.x, REGATTA_START.z, REGATTA_START.heading);
    boat2.pos.y = WATER_Y;
    placeInCar(again, boat2);
    launched({ sim: again, boat: boat2 });
    const slow = lap(again, boat2, 0.75)!;
    console.log(`[regatta] three-quarter-throttle lap ${slow.toFixed(2)} s (${regattaMedal(slow)})`);
    expect(slow).toBeGreaterThan(t);
    expect(activityRecords(again.progress).regattaBest).toBe(best);
  });
});
