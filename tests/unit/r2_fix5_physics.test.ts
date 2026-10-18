// Fix pass 5, vehicle physics: a step face is a step in the ground, not a slope. A bus at 23-28 m/s used to be stopped dead at
// the foot of the 2.6 m beach ramps (0 and 1): its nose, 5.75 m ahead of the centre, was over a metre up the plate while its
// damped pitch still lagged, so the smooth slope read as the ramp's back wall (an impact, a bounce and no jump).

import { describe, expect, it } from 'vitest';
import type { Vehicle, VehicleKind } from '../../src/sim/entities';
import type { Ramp } from '../../src/world/layout';
import { input, makeSim, placeInCar, step, world } from './helpers';

interface Run {
  /** Impacts on the vehicle before it first left the ground. */
  impacts: number;
  /** Its longest time in the air, and the ramp it last took off from. */
  air: number;
  ramp: number;
  /** Its lowest forward speed before it first left the ground (a crash bounces it backwards). */
  slowest: number;
  v: Vehicle;
}

/**
 * Drives `kind` at `speed` (m/s, held with the throttle; 0 = from a standstill at full throttle) from `back` m before the
 * foot of ramp `r` towards the middle of its foot, `off` rad off the ramp's heading, for `seconds`.
 */
function rampRun(kind: VehicleKind, r: Ramp, speed: number, off: number, back: number, seconds = 5): Run {
  const sim = makeSim({ police: false });
  const fx = Math.sin(r.heading);
  const fz = Math.cos(r.heading);
  const footX = r.x - (fx * r.length) / 2;
  const footZ = r.z - (fz * r.length) / 2;
  const h = r.heading + off;
  const v = sim.spawnVehicle(kind, footX - Math.sin(h) * back, footZ - Math.cos(h) * back, h);
  placeInCar(sim, v);
  v.vel.x = Math.sin(h) * speed;
  v.vel.z = Math.cos(h) * speed;
  const run: Run = { impacts: 0, air: 0, ramp: -1, slowest: Infinity, v };
  let flown = false;
  sim.events.on('impact', (e) => {
    if (e.vehicle === v && !flown) run.impacts++;
  });
  step(sim, seconds, (t) => {
    if (v.airborne) {
      flown = true;
      if (v.airTime > run.air) {
        run.air = v.airTime;
        run.ramp = v.launchRamp;
      }
    }
    const fwd = v.vel.x * Math.sin(v.heading) + v.vel.z * Math.cos(v.heading);
    if (!flown && t > 0) run.slowest = Math.min(run.slowest, fwd);
    return input({ throttle: speed === 0 || fwd < speed ? 1 : 0 });
  });
  return run;
}

const label = (r: Run): string => `${r.impacts} impacts before the jump, ${r.air.toFixed(2)} s in the air (ramp ${r.ramp}), slowest ${r.slowest.toFixed(1)} m/s`;

describe('a bus up the 2.6 m beach ramps', () => {
  const ramps = () => world().layout.ramps.filter((r) => r.height > 2.5);

  it('the beach ramps are the 2.6 m ones', () => {
    expect(ramps().map((r) => r.id)).toEqual([0, 1]);
  });

  it('straight on at 24, 26 and 28 m/s it takes off from the top instead of crashing at the foot', () => {
    const bad: string[] = [];
    for (const r of ramps()) {
      for (const speed of [24, 26, 28]) {
        const run = rampRun('bus', r, speed, 0, 20);
        if (run.impacts > 0 || run.air < 0.8 || run.ramp !== r.id || run.slowest < speed - 3) bad.push(`ramp ${r.id} at ${speed} m/s: ${label(run)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('0.3 rad off the ramp\'s line at 19-23 m/s it takes off too', () => {
    const bad: string[] = [];
    for (const r of ramps()) {
      for (const off of [-0.3, 0.3]) {
        for (const speed of [19, 21, 23]) {
          const run = rampRun('bus', r, speed, off, 20);
          if (run.impacts > 0 || run.air < 0.5 || run.slowest < speed - 3) bad.push(`ramp ${r.id} at ${off} rad, ${speed} m/s: ${label(run)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('from a standstill 130 m back at full throttle (24 m/s at the foot) it jumps ramp 0', () => {
    const run = rampRun('bus', ramps()[0]!, 0, 0, 130, 12);
    expect(run.impacts, label(run)).toBe(0);
    expect(run.air, label(run)).toBeGreaterThan(0.8);
    expect(run.ramp).toBe(0);
  });

  it('driven into the high end of either ramp from behind it still hits a wall', () => {
    const bad: string[] = [];
    for (const r of ramps()) {
      for (const kind of ['bus', 'sedan'] as const) {
        const sim = makeSim({ police: false });
        const fx = Math.sin(r.heading);
        const fz = Math.cos(r.heading);
        // From beyond the high end (r.x + f * length / 2), driving back along the ramp's line.
        const v = sim.spawnVehicle(kind, r.x + fx * (r.length / 2 + 20), r.z + fz * (r.length / 2 + 20), r.heading + Math.PI);
        placeInCar(sim, v);
        v.vel.x = -fx * 24;
        v.vel.z = -fz * 24;
        let impacts = 0;
        let top = 0;
        sim.events.on('impact', (e) => {
          if (e.vehicle === v) impacts++;
        });
        step(sim, 2, () => {
          top = Math.max(top, v.pos.y - world().baseGround(v.pos.x, v.pos.z));
          return input({ throttle: 1 });
        });
        if (impacts === 0 || top > 0.5) bad.push(`${kind} into ramp ${r.id}'s high end: ${impacts} impacts, rose ${top.toFixed(2)} m`);
      }
    }
    expect(bad).toEqual([]);
  });
});
