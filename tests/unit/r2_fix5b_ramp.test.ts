// Fix pass 5b, vehicle physics: the side of a ramp stops a car driving past it with its centre just outside it. Fix pass 5
// made a step face a step in the ground (FACE_JUMP), so that a bus climbing a 2.6 m beach ramp is no longer stopped at its
// foot (tests/unit/r2_fix5_physics.test.ts). But under the inner side of a car driving past a ramp the ground rises just as
// smoothly as under a climbing nose, and the car's height follows only the ground under its centre: its inner side went
// through the solid ramp (2.6 m deep, over a sedan's roof) and it drove on past. A slope is no face only where the body's
// centre line rises with it.

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { VehicleKind } from '../../src/sim/specs';
import type { Ramp } from '../../src/world/layout';
import { input, makeSim, placeInCar, step, world } from './helpers';

/** MAX_STEP_UP in sim/vehiclePhysics.ts: ground this far over a body's floor is a step it climbs. */
const STEP_UP = 1.0;

interface PastRun {
  impacts: number;
  /** How far the ramp stood over the floor of the car's inner side, at the most (m). */
  deepest: number;
  /** How far the car's centre got past the ramp's middle, along the ramp (m). */
  furthest: number;
  v: Vehicle;
}

/**
 * Drives `kind` along ramp `r`'s line at `speed` m/s (held with the throttle) for `seconds`, from 12 m before its foot, with
 * its centre `out` m outside the ramp's left side (side 1) or right side (side -1), so that its inner side is over the ramp.
 */
function drivePast(kind: VehicleKind, r: Ramp, side: 1 | -1, out: number, speed: number, seconds = 6): PastRun {
  const sim = makeSim({ police: false });
  const fx = Math.sin(r.heading);
  const fz = Math.cos(r.heading);
  // The ramp's left (its local +X).
  const lx = Math.cos(r.heading);
  const lz = -Math.sin(r.heading);
  const back = r.length / 2 + 12;
  const across = side * (r.width / 2 + out);
  const v = sim.spawnVehicle(kind, r.x - fx * back + lx * across, r.z - fz * back + lz * across, r.heading);
  placeInCar(sim, v);
  v.vel.x = fx * speed;
  v.vel.z = fz * speed;
  const run: PastRun = { impacts: 0, deepest: 0, furthest: -Infinity, v };
  sim.events.on('impact', (e) => {
    if (e.vehicle === v) run.impacts++;
  });
  step(sim, seconds, () => {
    run.furthest = Math.max(run.furthest, (v.pos.x - r.x) * fx + (v.pos.z - r.z) * fz);
    // The ground over the floor along the car's inner side, 5 cm in from its edge, from the tail to the nose.
    const hx = Math.sin(v.heading);
    const hz = Math.cos(v.heading);
    const lift = Math.sin(v.pitch);
    for (const k of [-1, -0.5, 0, 0.5, 1]) {
      const a = k * v.halfL;
      const px = v.pos.x + hx * a - lx * side * (v.halfW - 0.05);
      const pz = v.pos.z + hz * a - lz * side * (v.halfW - 0.05);
      run.deepest = Math.max(run.deepest, sim.world.groundHeight(px, pz) - (v.pos.y + a * lift));
    }
    const fwd = v.vel.x * hx + v.vel.z * hz;
    return input({ throttle: fwd < speed ? 1 : 0 });
  });
  return run;
}

const pastLabel = (r: PastRun): string =>
  `${r.impacts} impacts, the ramp up to ${r.deepest.toFixed(2)} m over its inner side's floor, its centre up to ${r.furthest.toFixed(1)} m past the ramp's middle`;

describe('a car driving past a ramp with its centre just outside the ramp\'s side', () => {
  it('a sedan with its inner 0.45 m over beach ramp 0 at 12 m/s hits the side instead of driving through it', () => {
    const run = drivePast('sedan', world().layout.ramps[0]!, 1, 0.5, 12, 10);
    expect(run.impacts, pastLabel(run)).toBeGreaterThan(0);
    // Stopped where the ramp stands a step over its floor (it went 2.6 m deep, over its 1.45 m roof, and 100 m on).
    expect(run.deepest, pastLabel(run)).toBeLessThan(STEP_UP + 0.05);
    expect(run.furthest, pastLabel(run)).toBeLessThan(0);
  });

  it('sedans and buses past either side of every ramp, 0.1 and 0.5 m outside it, at 8, 12 and 20 m/s are stopped by the side', () => {
    const bad: string[] = [];
    for (const r of world().layout.ramps) {
      for (const kind of ['sedan', 'bus'] as const) {
        for (const side of [1, -1] as const) {
          for (const out of [0.1, 0.5]) {
            for (const speed of [8, 12, 20]) {
              const run = drivePast(kind, r, side, out, speed);
              if (run.impacts === 0 || run.deepest > STEP_UP + 0.05 || run.furthest > 0) {
                bad.push(`${kind} past ramp ${r.id}'s ${side > 0 ? 'left' : 'right'} side, ${out} m out, at ${speed} m/s: ${pastLabel(run)}`);
              }
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

interface ClimbRun {
  /** Impacts on the vehicle before it first left the ground. */
  impacts: number;
  /** Its longest time in the air, and the ramp it last took off from. */
  air: number;
  ramp: number;
  /** Its lowest forward speed before it first left the ground (a crash bounces it backwards). */
  slowest: number;
}

/**
 * Drives `kind` straight up ramp `r` at `speed` m/s (held with the throttle) for 5 s, from 20 m before its foot, `left` m to
 * the left of the ramp's middle line (negative: to its right).
 */
function climb(kind: VehicleKind, r: Ramp, speed: number, left: number): ClimbRun {
  const sim = makeSim({ police: false });
  const fx = Math.sin(r.heading);
  const fz = Math.cos(r.heading);
  const back = r.length / 2 + 20;
  const v = sim.spawnVehicle(kind, r.x - fx * back + Math.cos(r.heading) * left, r.z - fz * back - Math.sin(r.heading) * left, r.heading);
  placeInCar(sim, v);
  v.vel.x = fx * speed;
  v.vel.z = fz * speed;
  const run: ClimbRun = { impacts: 0, air: 0, ramp: -1, slowest: Infinity };
  let flown = false;
  sim.events.on('impact', (e) => {
    if (e.vehicle === v && !flown) run.impacts++;
  });
  step(sim, 5, (t) => {
    if (v.airborne) {
      flown = true;
      if (v.airTime > run.air) {
        run.air = v.airTime;
        run.ramp = v.launchRamp;
      }
    }
    const fwd = v.vel.x * Math.sin(v.heading) + v.vel.z * Math.cos(v.heading);
    if (!flown && t > 0) run.slowest = Math.min(run.slowest, fwd);
    return input({ throttle: fwd < speed ? 1 : 0 });
  });
  return run;
}

const climbLabel = (r: ClimbRun): string => `${r.impacts} impacts before the jump, ${r.air.toFixed(2)} s in the air (ramp ${r.ramp}), slowest ${r.slowest.toFixed(1)} m/s`;

describe('a body climbing a ramp beside its middle line still climbs it', () => {
  it('a bus straight up a beach ramp at 24 and 28 m/s, 2-3 m off its middle line (at 3 m its outer side over the sand), takes off without an impact', () => {
    const bad: string[] = [];
    for (const r of world().layout.ramps.filter((p) => p.height > 2.5)) {
      for (const left of [-3, -2, 2, 3]) {
        for (const speed of [24, 28]) {
          const run = climb('bus', r, speed, left);
          if (run.impacts > 0 || run.air < 0.8 || run.ramp !== r.id || run.slowest < speed - 3) bad.push(`ramp ${r.id}, ${left} m left of its line, at ${speed} m/s: ${climbLabel(run)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('a sedan up any ramp at 25 m/s with its centre 0.25 m inside the side (its outer 0.7 m over the ground beside) takes off without an impact', () => {
    const bad: string[] = [];
    for (const r of world().layout.ramps) {
      for (const left of [-3, 3]) {
        const run = climb('sedan', r, 25, left);
        if (run.impacts > 0 || run.air < 0.6 || run.ramp !== r.id || run.slowest < 22) bad.push(`ramp ${r.id}, ${left} m left of its line: ${climbLabel(run)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
