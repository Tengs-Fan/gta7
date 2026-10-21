import { describe, expect, it } from 'vitest';
import type { StreetRunJob } from '../../src/sim/activities';
import type { Vehicle } from '../../src/sim/entities';
import { applySave, parseSave, Progress, serialize } from '../../src/sim/progress';
import { Sim } from '../../src/sim/sim';
import { buildStreetRunCourses, formatRunTime, runMedal, type StreetRunCourse } from '../../src/sim/streetRuns';
import { input, placeInCar, step, world } from './helpers';

function setup(id = 'magnolia'): { sim: Sim; car: Vehicle; course: StreetRunCourse } {
  const sim = new Sim({ world: world(), ambient: false, police: false });
  const course = sim.activities.streetRunCourses().find((c) => c.id === id)!;
  const car = sim.spawnVehicle('sports', course.start.x, course.start.z, course.start.heading);
  placeInCar(sim, car);
  return { sim, car, course };
}

function job(sim: Sim): StreetRunJob {
  const j = sim.activities.job;
  if (!j || j.kind !== 'streetRun') throw new Error('No street run');
  return j;
}

function start(sim: Sim, id?: string): StreetRunJob {
  expect(sim.activities.startStreetRun(id)).toBe(true);
  step(sim, 3.05);
  expect(job(sim).stage).toBe('racing');
  expect(sim.controlLock).toBe(0);
  return job(sim);
}

/** Follow the actual ordered course at a specified road speed, with fixed dt. */
function driveTo(sim: Sim, car: Vehicle, x: number, z: number, speed = 24): void {
  for (let ticks = 0; ticks < 2000; ticks++) {
    const dx = x - car.pos.x;
    const dz = z - car.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.001 || !sim.activities.busy) return;
    const dt = Math.min(0.1, d / speed);
    car.pos.x += dx / d * speed * dt;
    car.pos.z += dz / d * speed * dt;
    car.vel.x = dx / d * speed;
    car.vel.z = dz / d * speed;
    sim.activities.update(dt);
  }
  throw new Error('Route did not finish');
}

function finish(sim: Sim, car: Vehicle, course: StreetRunCourse, speed = 24): void {
  for (const gate of course.checkpoints) driveTo(sim, car, gate.x, gate.z, speed);
}

describe('authored street courses', () => {
  it('offers three distinct closed routes on connected, drivable streets', () => {
    const roads = world().roads;
    const courses = buildStreetRunCourses(roads);
    expect(courses.map((c) => c.id)).toEqual(['magnolia', 'coastline', 'dockside']);
    for (const course of courses) {
      expect(course.nodes[0]).toBe(course.nodes.at(-1));
      expect(course.checkpoints.length).toBeGreaterThan(8);
      expect(course.distance).toBeGreaterThan(900);
      expect(course.distance).toBeLessThan(1700);
      expect(course.gold).toBeLessThan(course.silver);
      expect(course.silver).toBeLessThan(course.bronze);
      // Gold asks for a brisk but attainable average, well below a road car's
      // top speed, allowing acceleration and the authored corner sequence.
      expect(course.distance / course.gold).toBeLessThan(20);
      for (let i = 1; i < course.nodes.length; i++) expect(roads.lanesBetween(course.nodes[i - 1]!, course.nodes[i]!)).not.toHaveLength(0);
      expect(roads.isOnRoad(course.start.x, course.start.z)).toBe(true);
      for (const gate of course.checkpoints) expect(roads.isOnRoad(gate.x, gate.z)).toBe(true);
      expect(course.checkpoints.at(-1)!.label).toBe('Finish');
      expect(course.checkpoints.at(-1)!.x).toBe(course.start.x);
      expect(course.checkpoints.at(-1)!.z).toBe(course.start.z);
    }
  });

  it('labels upcoming right/left turns correctly and formats tenths across minutes', () => {
    const courses = buildStreetRunCourses(world().roads);
    expect(courses[0]!.checkpoints.filter((g) => g.label.startsWith('Right'))).toHaveLength(4);
    expect(courses[2]!.checkpoints.some((g) => g.label.startsWith('Left'))).toBe(true);
    expect(formatRunTime(61.29)).toBe('1:01.2');
    expect(formatRunTime(0)).toBe('0:00.0');
  });
});

describe('street run start, countdown and lifecycle', () => {
  it('ordinary-car T selects the closest course and guides the player to its start', () => {
    const { sim, car, course } = setup('dockside');
    car.pos.x += 30;
    sim.activities.toggleJob();
    expect(job(sim).course.id).toBe('dockside');
    expect(job(sim).stage).toBe('approach');
    expect(sim.activities.objectives()[0]).toMatchObject({ x: course.start.x, z: course.start.z, radius: 8 });
    sim.activities.update(10);
    expect(job(sim).elapsed).toBe(0);
    car.pos.x = course.start.x;
    car.vel.x = 8;
    sim.activities.update(0.1);
    expect(job(sim).stage).toBe('approach');
    car.vel.x = 0;
    sim.activities.update(0.1);
    expect(job(sim).stage).toBe('countdown');
  });

  it('holds the car for 3 seconds, rejects throttle and exit input, then starts its clock', () => {
    const { sim, car, course } = setup();
    const counts: number[] = [];
    sim.events.on('streetRunCountdown', (e) => counts.push(e.count));
    expect(sim.activities.startStreetRun()).toBe(true);
    step(sim, 2.8, input({ throttle: 1, steer: 1, enterExit: true }));
    expect(job(sim).stage).toBe('countdown');
    expect(job(sim).elapsed).toBe(0);
    expect(car.pos.x).toBe(course.start.x);
    expect(car.pos.z).toBe(course.start.z);
    expect(sim.player.vehicle).toBe(car);
    step(sim, 0.25);
    expect(counts).toEqual([3, 2, 1, 0]);
    expect(job(sim).stage).toBe('racing');
    expect(job(sim).elapsed).toBeLessThan(0.06);
    expect(sim.controlLock).toBe(0);
    step(sim, 1);
    expect(job(sim).elapsed).toBeGreaterThanOrEqual(1);
  });

  it('does not replace a current activity or start when wanted, dead, in a taxi, or at an unknown course', () => {
    const { sim, car } = setup();
    expect(sim.activities.startStreetRun('missing')).toBe(false);
    sim.wanted.setLevel(1);
    expect(sim.activities.startStreetRun()).toBe(false);
    sim.wanted.clear();
    const taxi = sim.spawnVehicle('taxi', car.pos.x, car.pos.z + 10, 0);
    sim.unseat(sim.player);
    placeInCar(sim, taxi);
    expect(sim.activities.startStreetRun()).toBe(false);
    sim.activities.toggleJob();
    expect(sim.activities.job?.kind).toBe('taxi');
    expect(sim.activities.startStreetRun()).toBe(false);
    sim.activities.toggleJob();
    sim.unseat(sim.player);
    placeInCar(sim, car);
    sim.player.health = 0;
    sim.player.state = 'dead';
    expect(sim.activities.startStreetRun()).toBe(false);
  });

  it('releases only its own countdown lock on cancellation and never pays', () => {
    const { sim } = setup();
    const money = sim.progress.money;
    sim.activities.startStreetRun();
    sim.activities.toggleJob();
    expect(sim.controlLock).toBe(0);
    expect(sim.activities.busy).toBe(false);
    expect(sim.activities.objectives()).toEqual([]);
    sim.controlLock = 5;
    sim.activities.startStreetRun();
    sim.activities.cancelAll('mission');
    expect(sim.controlLock).toBe(5);
    expect(sim.progress.money).toBe(money);
    expect(sim.progress.streetRuns).toEqual({});
  });

  it.each(['destroyed', 'removed', 'inWater', 'flipped'] as const)('ends when its car is %s', (field) => {
    const { sim, car } = setup();
    start(sim);
    car[field] = true;
    sim.activities.update(0.1);
    expect(sim.activities.busy).toBe(false);
    expect(sim.progress.money).toBe(250);
    expect(sim.progress.streetRuns).toEqual({});
  });

  it('ends when the driver leaves or dies and cannot pay after respawn', () => {
    for (const outcome of ['exit', 'death'] as const) {
      const { sim } = setup();
      start(sim);
      if (outcome === 'exit') sim.unseat(sim.player);
      else {
        sim.player.health = 0;
        sim.player.state = 'dead';
      }
      sim.activities.update(0.1);
      expect(sim.activities.busy).toBe(false);
      sim.activities.cancelAll('wasted');
      expect(sim.progress.streetRuns).toEqual({});
      expect(sim.progress.money).toBe(250);
    }
  });
});

describe('street run timing, ordered gates and rewards', () => {
  it('cannot finish by sitting on the finish line, or visiting a later gate first', () => {
    const { sim, car, course } = setup();
    const j = start(sim);
    sim.activities.update(1);
    expect(j.checkpoint).toBe(0);
    // Take a different street away from the first gate, at a plausible speed.
    const next = course.checkpoints[1]!;
    driveTo(sim, car, car.pos.x, car.pos.z + 40);
    driveTo(sim, car, next.x, car.pos.z);
    driveTo(sim, car, next.x, next.z);
    expect(j.checkpoint).toBe(0);
    expect(sim.progress.streetRuns).toEqual({});
  });

  it('detects a fast swept crossing and exposes only the next gate to GPS', () => {
    const { sim, car, course } = setup();
    const j = start(sim);
    const gate = course.checkpoints[0]!;
    driveTo(sim, car, gate.x - 13, gate.z);
    expect(j.checkpoint).toBe(0);
    car.pos.x = gate.x + 13;
    sim.activities.update(0.25);
    expect(j.checkpoint).toBe(1);
    expect(sim.activities.objectives()).toHaveLength(1);
    expect(sim.activities.objectives()[0]).toMatchObject({ x: course.checkpoints[1]!.x, z: course.checkpoints[1]!.z });
  });

  it('invalidates a teleport instead of recording a free instant lap', () => {
    const { sim, car, course } = setup();
    start(sim);
    car.pos.x = course.checkpoints[0]!.x;
    car.pos.z = course.checkpoints[0]!.z;
    sim.activities.update(1 / 60);
    expect(sim.activities.busy).toBe(false);
    expect(sim.progress.money).toBe(250);
  });

  it.each(['magnolia', 'coastline', 'dockside'])('completes %s once with cash, a medal and a saved best', (id) => {
    const { sim, car, course } = setup(id);
    const gates: number[] = [];
    let finishes = 0;
    sim.events.on('streetRunCheckpoint', (e) => gates.push(e.index));
    sim.events.on('streetRunFinished', (e) => {
      finishes++;
      expect(sim.activities.busy).toBe(false);
      expect(e.medal).toBe('gold');
      expect(e.personalBest).toBe(true);
      expect(sim.progress.streetRuns[course.id]!.bestTime).toBe(e.time);
      expect(sim.progress.money).toBe(250 + e.reward);
    });
    start(sim, id);
    finish(sim, car, course);
    expect(sim.activities.busy).toBe(false);
    expect(gates).toEqual(course.checkpoints.map((_, index) => index + 1));
    expect(sim.progress.money).toBe(250 + course.reward);
    expect(sim.progress.streetRuns[course.id]).toMatchObject({ medal: 'gold', finishes: 1 });
    for (let i = 0; i < 10; i++) sim.activities.update(0.1);
    expect(finishes).toBe(1);
    expect(sim.progress.money).toBe(250 + course.reward);
  });

  it('keeps the faster personal best on a slower replay', () => {
    const { sim, car, course } = setup();
    start(sim);
    finish(sim, car, course, 26);
    const best = sim.progress.streetRuns.magnolia!.bestTime;
    car.pos.x = course.start.x;
    car.pos.z = course.start.z;
    car.vel.x = car.vel.z = 0;
    start(sim);
    finish(sim, car, course, 20);
    expect(sim.progress.streetRuns.magnolia).toMatchObject({ bestTime: best, finishes: 2 });
  });

  it('fails when bronze time expires, with no money or record, and ignores invalid dt', () => {
    const { sim, course } = setup();
    const j = start(sim);
    const elapsed = j.elapsed;
    for (const invalid of [0, -1, Infinity, NaN]) sim.activities.update(invalid);
    expect(j.elapsed).toBe(elapsed);
    sim.activities.update(course.bronze + 0.1);
    expect(sim.activities.busy).toBe(false);
    expect(sim.progress.streetRuns).toEqual({});
    expect(sim.progress.money).toBe(250);
  });

  it('assigns medals at inclusive thresholds and rejects non-finite or invalid finishes', () => {
    const course = buildStreetRunCourses(world().roads)[0]!;
    expect(runMedal(course, course.gold)).toBe('gold');
    expect(runMedal(course, course.gold + 0.01)).toBe('silver');
    expect(runMedal(course, course.silver)).toBe('silver');
    expect(runMedal(course, course.silver + 0.01)).toBe('bronze');
    expect(runMedal(course, course.bronze)).toBe('bronze');
    for (const invalid of [0, -1, Infinity, NaN, course.bronze + 0.01]) expect(runMedal(course, invalid)).toBeNull();
  });
});

describe('street run save compatibility', () => {
  it('round-trips completed bests without sharing mutable record objects', () => {
    const p = new Progress();
    p.streetRuns.magnolia = { bestTime: 52.341, medal: 'gold', finishes: 3 };
    const serialized = serialize(p, [], 0, 12, 1);
    const parsed = parseSave(JSON.parse(JSON.stringify(serialized)))!;
    const restored = new Progress();
    applySave(restored, parsed);
    expect(restored.streetRuns).toEqual(p.streetRuns);
    serialized.streetRuns!.magnolia!.bestTime = 100;
    parsed.streetRuns!.magnolia!.bestTime = 80;
    expect(p.streetRuns.magnolia!.bestTime).toBe(52.341);
    expect(restored.streetRuns.magnolia!.bestTime).toBe(52.341);
  });

  it('loads old saves and discards malformed, unknown or inherited course records', () => {
    const base = serialize(new Progress(), [], 0, 12, 1);
    delete base.streetRuns;
    expect(parseSave(base)!.streetRuns).toEqual({});
    const corrupt = {
      ...base,
      streetRuns: { magnolia: { bestTime: NaN, medal: 'gold' }, coastline: { bestTime: 56, medal: 'platinum' }, dockside: { bestTime: 75, medal: 'gold', finishes: -8 }, unknown: { bestTime: 5, medal: 'gold' } },
    };
    expect(parseSave(corrupt)!.streetRuns).toEqual({ dockside: { bestTime: 75, medal: 'gold', finishes: 1 } });
    const inherited = Object.create({ magnolia: { bestTime: 1, medal: 'gold' } });
    expect(parseSave({ ...base, streetRuns: inherited })!.streetRuns).toEqual({});
  });
});

describe('street course driving acceptance', () => {
  it.each(['magnolia', 'coastline', 'dockside'])('can drive %s through real physics within the gold target', (id) => {
    const { sim, car, course } = setup(id);
    const route = [course.start, ...course.checkpoints];
    const path: Array<{ x: number; z: number; speed: number }> = [];
    const add = (x: number, z: number, speed: number) => {
      const previous = path.at(-1);
      const n = previous ? Math.max(1, Math.ceil(Math.hypot(x - previous.x, z - previous.z) / 2)) : 1;
      for (let i = 1; i <= n; i++) path.push({ x: previous ? previous.x + (x - previous.x) * i / n : x, z: previous ? previous.z + (z - previous.z) * i / n : z, speed });
    };
    add(course.start.x, course.start.z, 32);
    for (let i = 1; i < route.length - 1; i++) {
      const p = route[i - 1]!;
      const corner = route[i]!;
      const n = route[i + 1]!;
      const inLength = Math.hypot(corner.x - p.x, corner.z - p.z);
      const outLength = Math.hypot(n.x - corner.x, n.z - corner.z);
      const ix = (corner.x - p.x) / inLength;
      const iz = (corner.z - p.z) / inLength;
      const ox = (n.x - corner.x) / outLength;
      const oz = (n.z - corner.z) / outLength;
      if (ix * ox + iz * oz > 0.9) {
        add(corner.x, corner.z, 32);
        continue;
      }
      const radius = Math.min(12, inLength / 3, outLength / 3);
      const ax = corner.x - ix * radius;
      const az = corner.z - iz * radius;
      const bx = corner.x + ox * radius;
      const bz = corner.z + oz * radius;
      add(ax, az, 32);
      for (let slice = 1; slice <= 10; slice++) {
        const t = slice / 10;
        add((1 - t) ** 2 * ax + 2 * (1 - t) * t * corner.x + t * t * bx, (1 - t) ** 2 * az + 2 * (1 - t) * t * corner.z + t * t * bz, 10);
      }
    }
    add(course.start.x, course.start.z, 15);
    start(sim, id);
    let nearest = 0;
    // This bot only sends ordinary analog steering, throttle and brake inputs.
    // No car teleports, stat overrides, invulnerability or physics shortcuts.
    for (let frame = 0; frame < course.bronze * 60 && sim.activities.busy; frame++) {
      let best = Infinity;
      for (let i = nearest; i < Math.min(path.length, nearest + 24); i++) {
        const point = path[i]!;
        const d = Math.hypot(point.x - car.pos.x, point.z - car.pos.z);
        if (d < best) {
          best = d;
          nearest = i;
        }
      }
      let aim = nearest;
      let distance = 0;
      while (aim + 1 < path.length && distance < 8 + car.speed * 0.15) {
        distance += Math.hypot(path[aim + 1]!.x - path[aim]!.x, path[aim + 1]!.z - path[aim]!.z);
        aim++;
      }
      const target = path[aim]!;
      const fx = Math.sin(car.heading);
      const fz = Math.cos(car.heading);
      const dx = target.x - car.pos.x;
      const dz = target.z - car.pos.z;
      const lateral = dx * -fz + dz * fx;
      const forward = dx * fx + dz * fz;
      const curvature = 2 * lateral / Math.max(1, dx * dx + dz * dz);
      const steer = forward < 0 ? Math.sign(lateral) : Math.atan(curvature * car.spec.length * 0.6) / (car.spec.steer / (1 + car.speed / 15));
      let targetSpeed = 32;
      distance = 0;
      for (let i = nearest; i < path.length && distance < 60; i++) {
        if (i > nearest) distance += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
        // 9 m/s² deceleration leaves margin below the Nightjar's brakes.
        targetSpeed = Math.min(targetSpeed, Math.sqrt(path[i]!.speed ** 2 + 18 * Math.max(0, distance - 5)));
      }
      sim.update(1 / 60, input({ steer: Math.max(-1, Math.min(1, steer)), throttle: Math.max(0, Math.min(1, (targetSpeed - car.speed) * 0.6)), brake: Math.max(0, Math.min(1, (car.speed - targetSpeed) * 0.3)) }));
    }
    const record = sim.progress.streetRuns[course.id];
    expect(record, `${id}: ${car.pos.x.toFixed(1)},${car.pos.z.toFixed(1)} health=${car.health.toFixed(0)} gate=${sim.activities.job?.kind === 'streetRun' ? sim.activities.job.checkpoint : 'ended'}`).toBeDefined();
    expect(record!.bestTime).toBeLessThan(course.gold);
    expect(car.condition).toBeGreaterThan(0.85);
  });
});
