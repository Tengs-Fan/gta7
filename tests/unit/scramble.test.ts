// The Gravel Gulch scramble (sim/activities/scramble.ts, world/country/places.ts): the track inside its plot, a
// scripted ride of the two laps on a Viper 600 that sets the medals, the gates in order, the record saved and loaded,
// and the track's whoops and tabletops kept out of the stunt jumps.

import { describe, expect, it } from 'vitest';
import type { ScrambleJob } from '../../src/sim/activities';
import { activityRecords } from '../../src/sim/activities/records';
import { MP_NO_SCRAMBLE, SCRAMBLE_REWARD, SCRAMBLE_TIMES, scrambleGates, scrambleMedal } from '../../src/sim/activities/scramble';
import { completionRows } from '../../src/sim/completion';
import type { Vehicle } from '../../src/sim/entities';
import { onVehicleLanded } from '../../src/sim/activities/stunts';
import { applySave, parseSave, serialize } from '../../src/sim/progress';
import { applyExt, serializeExt } from '../../src/sim/saveExt';
import { Sim } from '../../src/sim/sim';
import { COUNTY_PLOTS } from '../../src/world/country';
import { rectContains } from '../../src/world/layout';
import { input, placeInCar, step, world } from './helpers';

const W = world();
const track = W.layout.country.places.track;
const plot = COUNTY_PLOTS.find((p) => p.id === 'track')!.rect;

function setup(kind: 'sportbike' | 'sedan' = 'sportbike'): { sim: Sim; v: Vehicle } {
  const sim = new Sim({ world: world(), ambient: false, police: false });
  const v = sim.spawnVehicle(kind, track.start.x, track.start.z, track.start.heading);
  placeInCar(sim, v);
  return { sim, v };
}

function job(sim: Sim): ScrambleJob {
  const j = sim.activities.job;
  if (!j || j.kind !== 'scramble') throw new Error('No scramble');
  return j;
}

/** Rides both laps with ordinary steering, throttle and brake: the line at speed, easing off for the turns and the tables. */
function ride(sim: Sim, v: Vehicle): { time: number | null; gates: number[] } {
  const gates: number[] = [];
  sim.events.on('streetRunCheckpoint', (e) => gates.push(e.index));
  const turnAt = (i: number) => track.turns.some((q) => Math.abs(Math.hypot(track.line[i]!.x - q.cx, track.line[i]!.z - q.cz) - q.r) < 0.5);
  const tableAt = (i: number) => track.tables.some((r) => rectContains(r, track.line[i]!.x, track.line[i]!.z, 22));
  const lap = track.line.map((p, i) => ({ x: p.x, z: p.z, speed: turnAt(i) ? 13 : tableAt(i) ? 17 : 26 }));
  const path = [...lap, ...lap.slice(1), ...lap.slice(1, 12)];
  sim.activities.toggleJob();
  step(sim, 3.05);
  expect(job(sim).stage).toBe('racing');
  let nearest = 0;
  for (let frame = 0; frame < SCRAMBLE_TIMES.bronze * 60 && sim.activities.busy; frame++) {
    let best = Infinity;
    for (let i = nearest; i < Math.min(path.length, nearest + 24); i++) {
      const d = Math.hypot(path[i]!.x - v.pos.x, path[i]!.z - v.pos.z);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    let aim = nearest;
    let distance = 0;
    while (aim + 1 < path.length && distance < 6 + v.speed * 0.2) {
      distance += Math.hypot(path[aim + 1]!.x - path[aim]!.x, path[aim + 1]!.z - path[aim]!.z);
      aim++;
    }
    const target = path[aim]!;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const dx = target.x - v.pos.x;
    const dz = target.z - v.pos.z;
    const lateral = dx * -fz + dz * fx;
    const forward = dx * fx + dz * fz;
    const curvature = (2 * lateral) / Math.max(1, dx * dx + dz * dz);
    const steer = forward < 0 ? Math.sign(lateral) : Math.atan(curvature * v.spec.length * 0.6) / (v.spec.steer / (1 + v.speed / 15));
    let targetSpeed = 26;
    distance = 0;
    for (let i = nearest; i < path.length && distance < 50; i++) {
      if (i > nearest) distance += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
      targetSpeed = Math.min(targetSpeed, Math.sqrt(path[i]!.speed ** 2 + 16 * Math.max(0, distance - 4)));
    }
    sim.update(1 / 60, input({ steer: Math.max(-1, Math.min(1, steer)), throttle: Math.max(0, Math.min(1, (targetSpeed - v.speed) * 0.6)), brake: Math.max(0, Math.min(1, (v.speed - targetSpeed) * 0.3)) }));
  }
  const best = activityRecords(sim.progress).scrambleBest;
  return { time: best > 0 ? best / 1000 : null, gates };
}

describe('Gravel Gulch: the track', () => {
  it('closes a lap of about 1.1 km in its plot, its gates evenly round it, its whoops and tables no stunt', () => {
    expect(track.length).toBeGreaterThan(1050);
    expect(track.length).toBeLessThan(1150);
    const end = track.line.at(-1)!;
    expect(Math.hypot(end.x - track.line[0]!.x, end.z - track.line[0]!.z)).toBeLessThan(1e-6);
    for (const p of track.line) expect(rectContains(plot, p.x, p.z, -track.width / 2)).toBe(true);
    expect(track.gates).toHaveLength(10);
    expect(track.gates.at(-1)).toEqual(track.line[0]);
    for (const id of track.ramps) {
      const r = W.layout.ramps[id]!;
      expect(r.stunt).toBe(false);
      expect(rectContains(plot, r.x, r.z)).toBe(true);
    }
    // The coast's five and the farm's kicker, as before the track.
    expect(W.layout.ramps.filter((r) => r.stunt).map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5]);
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const rows = completionRows(sim, sim.players[0]!).filter((r) => r.id === 'stunts');
    expect(rows[0]!.total).toBe(6);
    // A landing off a whoop pays nothing and records nothing.
    const car = sim.spawnVehicle('sedan', track.start.x, track.start.z, 0);
    placeInCar(sim, car);
    car.launchRamp = track.ramps[0]!;
    car.airTime = 1.5;
    car.launchX = car.pos.x - 30;
    onVehicleLanded(sim, car);
    expect(sim.progress.stunts).toEqual([]);
    expect(car.launchRamp).toBe(-1);
  });
});

describe('Gravel Gulch: the scramble', () => {
  it('is ridden on a Viper 600 in two laps under gold, every gate in order', () => {
    const { sim, v } = setup();
    const money = sim.progress.money;
    const { time, gates } = ride(sim, v);
    console.log(`[scramble] Viper 600 ride ${time?.toFixed(1)} s over two laps of ${track.length.toFixed(0)} m; gold ${SCRAMBLE_TIMES.gold}, silver ${SCRAMBLE_TIMES.silver}, bronze ${SCRAMBLE_TIMES.bronze}`);
    expect(time).not.toBeNull();
    expect(gates).toEqual(scrambleGates(W).map((_, k) => k + 1));
    expect(time!).toBeLessThan(SCRAMBLE_TIMES.gold);
    // The medals: gold about 5% over the ride, silver 25%, bronze 60%.
    expect(SCRAMBLE_TIMES.gold / time!).toBeGreaterThan(1.03);
    expect(SCRAMBLE_TIMES.gold / time!).toBeLessThan(1.08);
    expect(scrambleMedal(time!)).toBe('gold');
    expect(sim.progress.money).toBe(money + SCRAMBLE_REWARD);
    expect(sim.activities.busy).toBe(false);
  });

  it('takes no gate out of order, starts only near the gate, and is single player', () => {
    const { sim, v } = setup('sedan');
    sim.activities.toggleJob();
    step(sim, 3.05);
    const j = job(sim);
    expect(j.stage).toBe('racing');
    // Straight across the infield to the fifth gate: nothing counts before the first.
    const g = track.gates;
    for (const target of [g[4]!, g[0]!]) {
      for (let k = 0; k < 400 && Math.hypot(target.x - v.pos.x, target.z - v.pos.z) > 0.5; k++) {
        const d = Math.hypot(target.x - v.pos.x, target.z - v.pos.z);
        v.pos.x += ((target.x - v.pos.x) / d) * Math.min(d, 1);
        v.pos.z += ((target.z - v.pos.z) / d) * Math.min(d, 1);
        sim.activities.update(1 / 30);
      }
      expect(j.gate).toBe(target === g[0] ? 1 : 0);
    }
    expect(sim.activities.objectives()[0]).toMatchObject({ x: g[1]!.x, z: g[1]!.z, label: 'Lap 1/2 · Gate 2/10' });
    sim.activities.toggleJob();
    expect(sim.activities.busy).toBe(false);
    // Far from the gate the job key starts a street run instead.
    v.pos.x = track.start.x + 200;
    expect(sim.activities.jobPrompt()).not.toBe('Press T to ride the Gravel Gulch scramble');
    const mp = new Sim({ world: world(), ambient: false, police: false, multiplayer: true });
    const bike = mp.spawnVehicle('sportbike', track.start.x, track.start.z, track.start.heading);
    placeInCar(mp, bike);
    const said: string[] = [];
    mp.events.on('message', (e) => said.push(e.text));
    mp.activities.toggleJob();
    expect(mp.activities.busy).toBe(false);
    expect(said).toContain(MP_NO_SCRAMBLE);
  });

  it('saves its best and loads it back, a row in the checklist and the stats', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    expect(completionRows(sim, sim.players[0]!).find((r) => r.label === 'Gravel Gulch medal')).toMatchObject({ done: 0, total: 1 });
    activityRecords(sim.progress).scrambleBest = 117_250;
    const saved = parseSave(JSON.parse(JSON.stringify(serialize(sim.progress, [], 0, 12, 1, serializeExt(sim)))))!;
    const again = new Sim({ world: world(), ambient: false, police: false });
    applySave(again.progress, saved);
    applyExt(again, saved.ext);
    expect(activityRecords(again.progress).scrambleBest).toBe(117_250);
    expect(completionRows(again, again.players[0]!).find((r) => r.label === 'Gravel Gulch medal')).toMatchObject({ done: 1, total: 1 });
  });
});
