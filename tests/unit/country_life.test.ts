// Life in Las Lomas County's countryside (render/country/life): the crows that lift off a car and the player and settle
// again, the dairy's dog that runs the yard's fence line after a passing car and trots home, the crop-duster's sorties,
// the combine's circuit of the wheat and the balloon's dawn, as the pure functions of the clocks they are. None of it
// touches the sim.

import { describe, expect, it } from 'vitest';
import { Dog, dogRun, type Visitor } from '../../src/render/country/life/dog';
import { CALM_FOR, Flock, MIN_AIR, SCARE_R, SETTLE_R, crowSites, type Threat } from '../../src/render/country/life/flocks';
import {
  BALLOON_DAY, BALLOON_MEADOWS, BIPLANE_SPEED, COMBINE_DAY, DUSTER_HOURS, DUST_RUNS, PASS_ALT, SORTIE_PERIOD,
  balloonAt, biplaneAt, burnerAt, combineAt, combinePath, dustPaths, newPose, type Balloon, type Combine,
} from '../../src/render/country/life/flight';
import { ARM_Y, PLACEHOLDER_POLES, WIRES, wirePoint } from '../../src/render/country/life/wires';
import { rectContains } from '../../src/world/layout';
import { world } from './helpers';

const W = world();
const farms = W.layout.country.farms;
const elevator = W.layout.country.places.town.elevator;
const tower = W.layout.country.places.town.tower;

const none: Threat[] = [];
type Caw = (x: number, y: number, z: number) => void;
const caw: Caw = () => undefined;

/** A flock on the ground at x = 0..8 (z 0), steps it `seconds` s at 30 fps with `threats(t)`. */
function flockOf(n = 5, y = 0): Flock {
  return new Flock(1, Array.from({ length: n }, (_, i) => ({ x: i * 2, y, z: 0, yaw: 0, ground: true })));
}
function run(flock: Flock, seconds: number, threats: (t: number) => Threat[] = () => none, time0 = 0, onCaw: Caw = caw): number {
  let t = time0;
  for (let k = 0; k < seconds * 30; k++) {
    t += 1 / 30;
    flock.update(1 / 30, t, threats(t), onCaw);
  }
  return t;
}

describe('crows: a flock lifts off a car or the player, circles and settles', () => {
  it('stays on its perches with nothing near, pecking on the ground', () => {
    const f = flockOf();
    run(f, 20);
    expect(f.state).toBe('perched');
    f.crows.forEach((c, i) => expect([c.x, c.y, c.z]).toEqual([i * 2, 0, 0]));
  });

  it('lifts off when a threat comes within the scare radius of any bird, and not before', () => {
    for (const [gap, up] of [[SCARE_R - 1, true], [SCARE_R + 1, false]] as const) {
      const f = flockOf();
      // Beyond the last bird (x = 8), `gap` m from it.
      run(f, 2, () => [{ x: 8 + gap, z: 0 }]);
      expect(f.state === 'perched', `${gap} m`).toBe(!up);
    }
  });

  it('caws on take-off, three times in the first seconds, from over the flock', () => {
    const f = flockOf();
    const caws: Array<[number, number, number]> = [];
    run(f, 2, (t) => (t > 0.5 ? [{ x: 4, z: 10 }] : none), 0, (x, y, z) => caws.push([x, y, z]));
    expect(caws.length).toBe(3);
    for (const [x, y, z] of caws) {
      expect(Math.abs(x - 4)).toBeLessThan(40);
      expect(y).toBeGreaterThan(0);
      expect(Math.abs(z)).toBeLessThan(40);
    }
  });

  it('circles over its place, up in the air, wings spread, flapping', () => {
    const f = flockOf();
    const t = run(f, 8, (t) => (t < 0.5 ? none : [{ x: 4, z: 10 }]));
    expect(f.state).toBe('circling');
    for (const c of f.crows) {
      expect(c.y).toBeGreaterThan(7);
      expect(c.y).toBeLessThan(21);
      expect(Math.hypot(c.x - f.cx, c.z - f.cz)).toBeLessThan(31);
      expect(c.open).toBe(1);
    }
    const before = f.crows.map((c) => c.flap);
    run(f, 0.5, () => [{ x: 4, z: 10 }], t);
    f.crows.forEach((c, i) => expect(c.flap).toBeGreaterThan(before[i]!));
  });

  it('stays up while something moves within the settle radius of its middle, however long', () => {
    const f = flockOf();
    // Put up by a car 10 m off, which then idles 27 m away: out of the birds' scare radius, within the settle radius.
    const t = run(f, 1, () => [{ x: 4, z: 10 }]);
    run(f, 40, () => [{ x: 4, z: SETTLE_R - 3 }], t);
    expect(f.state).toBe('circling');
    run(f, 40, () => none, t + 40);
    expect(f.state).toBe('perched');
  });

  it('settles on its own perches once nothing has been near for the calm time and the least time aloft', () => {
    const f = flockOf();
    // Up at once, then the threat goes (it was near for 1 s).
    let t = run(f, 1, () => [{ x: 4, z: 10 }]);
    expect(f.state).not.toBe('perched');
    t = run(f, MIN_AIR - 1 + CALM_FOR - 1, () => none, t);
    // Not yet down: it keeps to the least time aloft and the calm that must pass.
    expect(f.state).not.toBe('perched');
    t = run(f, 12, () => none, t);
    expect(f.state).toBe('perched');
    f.crows.forEach((c, i) => {
      expect(c.x).toBeCloseTo(i * 2, 6);
      expect(c.y).toBeCloseTo(0, 6);
      expect(c.open).toBe(0);
    });
  });

  it('goes up again if something comes while it is landing', () => {
    const f = flockOf();
    let t = run(f, 1, () => [{ x: 4, z: 10 }]);
    // Until it is coming down.
    for (let k = 0; k < 30 * 40 && f.state !== 'landing'; k++) {
      t += 1 / 30;
      f.update(1 / 30, t, none, caw);
    }
    expect(f.state).toBe('landing');
    t = run(f, 1, () => none, t);
    expect(f.state).toBe('landing');
    run(f, 0.2, () => [{ x: 4, z: 5 }], t);
    expect(f.state).toBe('rising');
  });

  it('does not move when time stands still (paused)', () => {
    const f = flockOf();
    const t = run(f, 1, () => [{ x: 4, z: 10 }]);
    const before = JSON.stringify(f.crows);
    for (let k = 0; k < 10; k++) f.update(0, t, [{ x: 4, z: 10 }], caw);
    expect(JSON.stringify(f.crows)).toBe(before);
  });

  it("puts only the tier's share of the birds out", () => {
    const f = flockOf(8);
    f.setCount(3);
    expect(f.count).toBe(3);
    run(f, 4, () => [{ x: 4, z: 10 }]);
    expect(f.crows[3]!.y).toBe(0);
    expect(f.crows[2]!.y).toBeGreaterThan(1);
  });
});

describe('crows: where the flocks are', () => {
  const sites = crowSites(W);

  it('keeps ground flocks on flat county land off the roads, clear of colliders and crops', () => {
    for (const s of sites) {
      for (const p of s.perches.filter((q) => q.ground)) {
        expect(W.groundHeight(p.x, p.z)).toBe(0);
        expect(W.isOnRoad(p.x, p.z)).toBe(false);
        expect(W.isFree(p.x, p.z, 0.7)).toBe(true);
        expect(W.cropAt(p.x, p.z)).toBe(false);
      }
    }
    expect(sites.filter((s) => s.perches[0]!.ground).map((s) => s.perches.length).every((n) => n >= 5)).toBe(true);
  });

  it('seats the wire flocks on the wires, the barn flocks on the ridges and the tower flock on its cone', () => {
    const wired = sites.filter((s) => !s.perches[0]!.ground && s.perches[0]!.x < -800 + 400 && Math.abs(s.perches[0]!.x - PLACEHOLDER_POLES[0]!.x) < 2);
    expect(wired.length).toBe(2);
    for (const s of wired) {
      for (const p of s.perches) {
        // On some wire's curve, within a few centimetres.
        const d = Math.min(...WIRES.map((w) => Math.min(...Array.from({ length: 41 }, (_, k) => { const [x, y, z] = wirePoint(w, k / 40); return Math.hypot(x - p.x, y + 0.02 - p.y, z - p.z); }))));
        expect(d).toBeLessThan(0.5);
        expect(p.y).toBeLessThan(ARM_Y + 0.1);
      }
    }
    for (const id of ['acres', 'bottoms'] as const) {
      const barn = farms.farmsteads.find((f) => f.id === id)!.barn;
      const s = sites.find((q) => q.perches.every((p) => rectContains(barn, p.x, p.z)))!;
      expect(s, id).toBeTruthy();
      const gar = W.layout.garages.find((g) => g.poi === `${id}_barn`)!;
      for (const p of s.perches) expect(p.y).toBeGreaterThan(gar.height + 3);
    }
    const cone = sites.find((q) => q.perches.every((p) => Math.hypot(p.x - tower.x, p.z - tower.z) < tower.r))!;
    expect(cone.perches.length).toBe(4);
    for (const p of cone.perches) expect(p.y).toBeGreaterThan(tower.y1);
  });
});

describe('the dairy dog', () => {
  const run0 = dogRun(W);
  const plot = W.layout.country.plots.find((p) => p.id === 'dairy')!.rect;
  const car = (z: number, vz: number): Visitor => ({ x: -837.5, z, speed: Math.abs(vz), vz });

  it('has a run inside the plot, off the hedgerow and the farmhouse, 20 m and more from the road', () => {
    expect(run0.x).toBeLessThan(plot.maxX - 5);
    expect(run0.x).toBeGreaterThan(plot.minX);
    for (let z = run0.z0; z <= run0.z1; z += 0.5) {
      expect(W.isFree(run0.x, z, 0.5), `z ${z}`).toBe(true);
      expect(z).toBeGreaterThan(plot.minZ);
      expect(z).toBeLessThan(plot.maxZ);
    }
    for (const h of farms.hedges) expect(run0.x < h.minX - 1 || run0.x > h.maxX + 1 || run0.z0 > h.maxZ + 3 || run0.z1 < h.minZ - 3).toBe(true);
    // The road is 15 m and more from every point of the run (and so from the plot's edge, 6 m east of it).
    for (let z = run0.z0; z <= run0.z1; z += 2) for (let x = run0.x; x <= run0.x + 15; x += 1) expect(W.isOnRoad(x, z), `${x},${z}`).toBe(false);
  });

  it('lies at home until something moves, then gets up, runs out and barks, keeping pace with a car as far as the run goes', () => {
    const d = new Dog(run0, 0);
    const barks: number[] = [];
    let t = 0;
    const step = (v: Visitor[]) => {
      t += 1 / 30;
      d.update(1 / 30, v, () => barks.push(t));
    };
    for (let k = 0; k < 90; k++) step([]);
    expect(d.state).toBe('rest');
    expect(d.pose.lie).toBe(1);
    expect(d.pose.z).toBe(run0.home);
    // A car southbound on Creek Road at 15 m/s from 60 m north of the run.
    let z = run0.z0 - 60;
    let chased = false;
    let reachedEnd = false;
    for (let k = 0; k < 30 * 12; k++) {
      z += 0.5;
      step([car(z, 15)]);
      if (d.state === 'chase') chased = true;
      if (Math.abs(d.pose.z - run0.z1) < 0.5) reachedEnd = true;
      expect(d.pose.x).toBe(run0.x);
      expect(d.pose.z).toBeGreaterThanOrEqual(run0.z0);
      expect(d.pose.z).toBeLessThanOrEqual(run0.z1);
    }
    expect(chased).toBe(true);
    expect(reachedEnd).toBe(true);
    expect(barks.length).toBeGreaterThanOrEqual(3);
    expect(d.pose.swing).toBeGreaterThanOrEqual(0);
  });

  it('runs alongside a car it can keep up with: its place on the run follows the car as it passes', () => {
    const d = new Dog(run0, 0);
    let z = run0.z0 - 50;
    let worst = 0;
    let caught = false;
    for (let k = 0; k < 30 * 22; k++) {
      z += 6 / 30;
      d.update(1 / 30, [car(z, 6)], () => undefined);
      caught ||= Math.abs(d.pose.z - z) < 3;
      if (caught && z < run0.z1) worst = Math.max(worst, Math.abs(d.pose.z - z));
    }
    // It comes out to meet the car, and then stays within a few metres of its place along the road.
    expect(caught).toBe(true);
    expect(worst).toBeLessThan(8);
  });

  it('trots back to lie down at home when the car has gone', () => {
    const d = new Dog(run0, 0);
    let z = run0.z0 - 50;
    for (let k = 0; k < 30 * 8; k++) {
      z += 0.5;
      d.update(1 / 30, [car(z, 15)], () => undefined);
    }
    expect(d.pose.z).toBeGreaterThan(run0.z1 - 4);
    for (let k = 0; k < 30 * 30 && d.state !== 'rest'; k++) d.update(1 / 30, [], () => undefined);
    expect(d.state).toBe('rest');
    expect(d.pose.z).toBeCloseTo(run0.home, 1);
    for (let k = 0; k < 30; k++) d.update(1 / 30, [], () => undefined);
    expect(d.pose.lie).toBe(1);
  });

  it('never leaves its line whatever comes by, from either side, or stands on the spot', () => {
    const d = new Dog(run0, 0);
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let k = 0; k < 30 * 120; k++) {
      const v: Visitor[] = r() < 0.5 ? [{ x: -900 + r() * 100, z: run0.z0 - 80 + r() * 220, speed: r() * 20, vz: (r() - 0.5) * 30 }] : [];
      d.update(1 / 30, v, () => undefined);
      expect(d.pose.x).toBe(run0.x);
      expect(d.pose.z).toBeGreaterThanOrEqual(run0.z0);
      expect(d.pose.z).toBeLessThanOrEqual(run0.z1);
    }
  });
});

describe('the crop-duster', () => {
  const paths = dustPaths(W);
  const AIRSPACE = { minX: -1760, maxX: -540, minZ: -200, maxZ: 330 };
  const fields = farms.fields.map((f) => f.rect);

  it('flies each run inside the airspace over the county, clear of the ground and the tall buildings', () => {
    const p = newPose();
    paths.forEach((path, i) => {
      expect(path.length, DUST_RUNS[i]!.name).toBeGreaterThan(1200);
      for (let s = 0; s <= path.length; s += 1) {
        path.sample(s, BIPLANE_SPEED, p);
        expect(p.x).toBeGreaterThan(AIRSPACE.minX);
        expect(p.x).toBeLessThan(AIRSPACE.maxX);
        expect(p.z).toBeGreaterThan(AIRSPACE.minZ);
        expect(p.z).toBeLessThan(AIRSPACE.maxZ);
        expect(p.y - W.groundHeight(p.x, p.z), `${i} at ${s}`).toBeGreaterThanOrEqual(PASS_ALT - 1e-3);
        // The grain elevator and the water tower: high over them or well clear.
        for (const [x, z, top] of [[elevator.silos[0]!.x, elevator.silos[0]!.z, elevator.top], [tower.x, tower.z, tower.y1 + 2.4]] as const) {
          if (Math.hypot(p.x - x, p.z - z) < 40) expect(p.y).toBeGreaterThan(top + 5);
        }
      }
    });
  });

  it('keeps its up and nose unit and square to each other, and banks in its turns and flies inverted at the loop top', () => {
    const p = newPose();
    let bankMax = 0;
    let inverted = false;
    for (const path of paths) {
      for (let s = 0; s <= path.length; s += 1) {
        path.sample(s, BIPLANE_SPEED, p);
        expect(Math.hypot(p.fx, p.fy, p.fz)).toBeCloseTo(1, 4);
        expect(Math.hypot(p.ux, p.uy, p.uz)).toBeCloseTo(1, 4);
        expect(Math.abs(p.fx * p.ux + p.fy * p.uy + p.fz * p.uz)).toBeLessThan(0.02);
        bankMax = Math.max(bankMax, Math.acos(Math.min(1, Math.max(-1, p.uy))));
        if (p.uy < -0.9) inverted = true;
      }
    }
    expect(bankMax).toBeGreaterThan(0.8);
    expect(inverted).toBe(true);
  });

  it('sprays only low over a field, and over crops on each run', () => {
    const p = newPose();
    for (const path of paths) {
      let sprayed = 0;
      for (let s = 0; s <= path.length; s += 1) {
        path.sample(s, BIPLANE_SPEED, p);
        if (!p.spray) continue;
        sprayed++;
        expect(p.y - W.groundHeight(p.x, p.z)).toBeLessThan(14);
        expect(fields.some((r) => rectContains(r, p.x, p.z))).toBe(true);
      }
      expect(sprayed).toBeGreaterThan(150);
    }
  });

  it('flies a sortie every SORTIE_PERIOD s by day in fair weather, the runs in turn, and is in the hangar between and at night', () => {
    const p = newPose();
    expect(biplaneAt(paths, 0.5, 12, true, p)).toBe(true);
    // The first run's first x: 330 m east of its pass.
    expect(p.x).toBeGreaterThan(DUST_RUNS[0]!.xE + 300);
    expect(biplaneAt(paths, SORTIE_PERIOD + 10, 12, true, p)).toBe(true);
    expect(p.z).toBeLessThan(0);
    expect(biplaneAt(paths, 2 * SORTIE_PERIOD + 10, 12, true, p)).toBe(true);
    expect(p.z).toBeGreaterThan(100);
    const out = Math.max(...paths.map((q) => q.length / BIPLANE_SPEED));
    expect(out).toBeLessThan(SORTIE_PERIOD - 20);
    expect(biplaneAt(paths, out + 5, 12, true, p)).toBe(false);
    expect(biplaneAt(paths, 10, DUSTER_HOURS.from - 0.01, true, p)).toBe(false);
    expect(biplaneAt(paths, 10, DUSTER_HOURS.to, true, p)).toBe(false);
    expect(biplaneAt(paths, 10, 12, false, p)).toBe(false);
  });

  it('moves at its speed along its nose, and the pose is continuous second to second', () => {
    const p = newPose();
    const q = newPose();
    for (let t = 1; t < 55; t += 1) {
      biplaneAt(paths, t, 12, true, p);
      biplaneAt(paths, t + 1 / 30, 12, true, q);
      expect(Math.hypot(p.vx, p.vy, p.vz)).toBeCloseTo(BIPLANE_SPEED, 3);
      expect(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)).toBeCloseTo(BIPLANE_SPEED / 30, 1);
    }
  });
});

describe('the combine', () => {
  const wheat = farms.fields.find((f) => f.crop === 'wheat')!.rect;
  const path = combinePath(wheat);
  const c: Combine = { x: 0, z: 0, heading: 0, working: false, speed: 0 };

  it('stays inside the field, 6 m and more from its edge, on every lane of the circuit', () => {
    for (let h = COMBINE_DAY.from - 1; h <= COMBINE_DAY.to + 1; h += 0.01) {
      combineAt(path, h, c);
      expect(c.x).toBeGreaterThan(wheat.minX + 6);
      expect(c.x).toBeLessThan(wheat.maxX - 6);
      expect(c.z).toBeGreaterThan(wheat.minZ + 6);
      expect(c.z).toBeLessThan(wheat.maxZ - 6);
    }
  });

  it('works from 07:00 to 17:30, standing at the start before and at the end of the circuit after', () => {
    combineAt(path, 6.5, c);
    const start = { x: c.x, z: c.z };
    expect(c.working).toBe(false);
    combineAt(path, 7.2, c);
    expect(c.working).toBe(true);
    combineAt(path, 12, c);
    expect(c.working).toBe(true);
    combineAt(path, 17.4, c);
    expect(c.working).toBe(true);
    combineAt(path, COMBINE_DAY.to, c);
    expect(c.working).toBe(false);
    const end = { x: c.x, z: c.z };
    combineAt(path, 23, c);
    expect([c.x, c.z]).toEqual([end.x, end.z]);
    expect(end).not.toEqual(start);
    combineAt(path, 3, c);
    expect([c.x, c.z]).toEqual([start.x, start.z]);
  });

  it('goes up and down the field in lanes along its rows (x), turning at the ends, and covers the field', () => {
    const lanes = new Set<number>();
    let turns = 0;
    let last = 0;
    for (let h = 7; h <= 17.5; h += 0.005) {
      combineAt(path, h, c);
      const east = Math.sin(c.heading);
      if (Math.abs(east) > 0.999) lanes.add(Math.round(c.z));
      if (last !== 0 && Math.sign(east) !== last && Math.abs(east) > 0.9) turns++;
      if (Math.abs(east) > 0.9) last = Math.sign(east);
    }
    expect(lanes.size).toBeGreaterThanOrEqual(12);
    expect(turns).toBeGreaterThanOrEqual(10);
    const zs = [...lanes];
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(wheat.maxZ - wheat.minZ - 40);
  });
});

describe('the balloon', () => {
  const b: Balloon = { x: 0, y: 0, z: 0, yaw: 0, fill: 0, height: 0, heading: 0, speed: 0 };

  it('is out from 05:30 to 08:30 only, and not in the rain', () => {
    expect(balloonAt(W, BALLOON_DAY.from - 0.01, true, b)).toBe(false);
    expect(balloonAt(W, BALLOON_DAY.from + 0.1, true, b)).toBe(true);
    expect(balloonAt(W, 7, true, b)).toBe(true);
    expect(balloonAt(W, BALLOON_DAY.to - 0.1, true, b)).toBe(true);
    expect(balloonAt(W, BALLOON_DAY.to, true, b)).toBe(false);
    expect(balloonAt(W, 12, true, b)).toBe(false);
    expect(balloonAt(W, 0, true, b)).toBe(false);
    expect(balloonAt(W, 7, false, b)).toBe(false);
  });

  it('swells on one meadow, lifts, drifts over the county and sets down on the other, filling and folding at the ends', () => {
    balloonAt(W, BALLOON_DAY.from + 0.05, true, b);
    expect(b.fill).toBeLessThan(0.6);
    expect(b.height).toBe(0);
    expect([b.x, b.z]).toEqual([BALLOON_MEADOWS.from.x, BALLOON_MEADOWS.from.z]);
    balloonAt(W, BALLOON_DAY.lift, true, b);
    expect(b.fill).toBeCloseTo(1, 6);
    let peak = 0;
    for (let h = BALLOON_DAY.lift; h <= BALLOON_DAY.land; h += 0.01) {
      balloonAt(W, h, true, b);
      peak = Math.max(peak, b.height);
      expect(W.groundHeight(b.x, b.z)).toBe(0);
      // Over the county's land the whole way.
      expect(b.x).toBeGreaterThan(-1500);
      expect(b.x).toBeLessThan(-700);
      expect(b.z).toBeGreaterThan(-440);
      expect(b.z).toBeLessThan(400);
    }
    expect(peak).toBeGreaterThan(80);
    expect(peak).toBeLessThan(140);
    balloonAt(W, BALLOON_DAY.land, true, b);
    expect(b.height).toBeCloseTo(0, 4);
    expect([b.x, b.z]).toEqual([BALLOON_MEADOWS.to.x, BALLOON_MEADOWS.to.z]);
    balloonAt(W, BALLOON_DAY.to - 0.03, true, b);
    expect(b.fill).toBeLessThan(0.3);
  });

  it('rises from and sets down in meadows clear of every collider', () => {
    for (const m of [BALLOON_MEADOWS.from, BALLOON_MEADOWS.to]) {
      for (const [dx, dz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]] as const) expect(W.isFree(m.x + dx, m.z + dz, 2), `${m.x},${m.z}`).toBe(true);
      expect(W.isOnRoad(m.x, m.z)).toBe(false);
    }
  });

  it('fires its burner in flares of a few seconds, often as it swells and climbs, now and then in the drift and never once down', () => {
    let swell = 0;
    let cruise = 0;
    for (let t = 0; t < 600; t += 0.25) {
      if (burnerAt(t, 5.6, 1) > 0) swell++;
      if (burnerAt(t, 7, 1) > 0) cruise++;
      expect(burnerAt(t, BALLOON_DAY.land + 0.1, 1)).toBe(0);
    }
    expect(swell).toBeGreaterThan(cruise * 1.5);
    expect(cruise).toBeGreaterThan(30);
    expect(cruise).toBeLessThan(swell);
    // A flare is no longer than FLARE_PERIOD, rises and falls.
    let on = 0;
    for (let t = 0; t < 11; t += 0.05) if (burnerAt(t, 5.6, 1) > 0.01) on++;
    expect(on * 0.05).toBeLessThan(7.5);
  });
});
