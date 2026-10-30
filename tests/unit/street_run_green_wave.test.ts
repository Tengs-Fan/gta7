// Street Run gates (the whole junction counts) and the green wave: the next two course junctions are held green
// along the course for the racer, cross streets red and pedestrians kept off his road, and released however the
// run ends.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreetRunJob } from '../../src/sim/activities';
import { makeBrain } from '../../src/sim/brains';
import type { Vehicle } from '../../src/sim/entities';
import { Sim } from '../../src/sim/sim';
import { buildStreetRunCourses, type StreetRunCourse } from '../../src/sim/streetRuns';
import { CROSSWALK_W } from '../../src/world/constants';
import { SIGNAL_CYCLE, type Axis, type RoadNetwork } from '../../src/world/roads';
import { StaticWorld } from '../../src/world/staticWorld';
import { freshWorld, placeInCar, step, world } from './helpers';

const OLD_MEDALS = { magnolia: [65, 85, 115], coastline: [85, 110, 145], dockside: [78, 100, 130] } as const;

function setup(id = 'magnolia', opts: { world?: StaticWorld; ambient?: boolean; seed?: number } = {}): { sim: Sim; car: Vehicle; course: StreetRunCourse } {
  const sim = new Sim({ world: opts.world ?? world(), ambient: opts.ambient ?? false, police: false, seed: opts.seed });
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

function race(sim: Sim, id?: string): StreetRunJob {
  expect(sim.activities.startStreetRun(id)).toBe(true);
  step(sim, 3.05);
  expect(job(sim).stage).toBe('racing');
  return job(sim);
}

/** The course's way into a junction: 'NS' when the previous course node is on the same north-south road. */
function incomingAxis(roads: RoadNetwork, course: StreetRunCourse, nodeId: number): Axis {
  const k = course.nodes.indexOf(nodeId, 1);
  const a = roads.nodes[course.nodes[k - 1]!]!;
  const b = roads.nodes[nodeId]!;
  return a.i === b.i ? 'NS' : 'EW';
}

/** The junctions the green wave should hold for a racer whose next gate is `checkpoint`. */
function expectedHolds(roads: RoadNetwork, course: StreetRunCourse, checkpoint: number): Map<number, Axis> {
  const want = new Map<number, Axis>();
  for (const k of [checkpoint + 1, checkpoint + 2]) {
    const id = course.nodes[k];
    // A canal bridge has no signal to hold.
    if (id !== undefined && roads.nodes[id]!.signal && !want.has(id)) want.set(id, incomingAxis(roads, course, id));
  }
  return want;
}

/** Every signalised junction reads its normal cycle except `held`, which reads green along its axis only. */
function expectSignals(roads: RoadNetwork, held: Map<number, Axis>, t: number): void {
  for (const node of roads.nodes) {
    if (!node.signal) continue;
    const axis = held.get(node.id);
    for (const a of ['NS', 'EW'] as const) {
      if (axis) {
        expect(roads.signalState(node.id, a, t), `node ${node.i},${node.j} ${a} at ${t}`).toBe(a === axis ? 'green' : 'red');
        expect(roads.pedCanCross(node.id, a, t), `peds ${node.i},${node.j} ${a} at ${t}`).toBe(a !== axis);
      } else {
        expect(roads.signalState(node.id, a, t), `node ${node.i},${node.j} ${a} at ${t}`).toBe(roads.cycleSignalState(node.id, a, t));
        expect(roads.pedCanCross(node.id, a, t), `peds ${node.i},${node.j} ${a} at ${t}`).toBe(roads.cyclePedCanCross(node.id, a, t));
      }
    }
  }
}

function expectReleased(sim: Sim): void {
  expect([...sim.roads.heldSignals.keys()]).toEqual([]);
  expectSignals(sim.roads, new Map(), sim.time);
}

/** Follow the ordered course at a road speed, with fixed dt (activities only, as in street_runs.test.ts). */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('street run gates', () => {
  it('cover the whole junction box plus 3 m on every course, the finish keeps 8 m and the drawn ring matches', async () => {
    const roads = world().roads;
    const rows: string[] = [];
    for (const course of buildStreetRunCourses(roads)) {
      for (const gate of course.checkpoints) {
        if (gate.label === 'Finish') {
          expect(gate.radius).toBe(8);
          continue;
        }
        const node = roads.nodes[gate.nodeId]!;
        expect(gate.radius, `${course.id} ${gate.label}`).toBe(Math.hypot(node.halfX, node.halfZ) + 3);
      }
      rows.push(`${course.id}: ${course.checkpoints.map((g) => g.radius.toFixed(2)).join(' ')}`);
    }
    console.log(`[gates]\n${rows.join('\n')}`);

    // The marker ring the renderer draws for the next gate has the gate's own radius.
    const ctx2d = () => new Proxy({} as Record<string | symbol, unknown>, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop: () => undefined })), set: (o, k, v) => ((o[k] = v), true) });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: ctx2d }) });
    const THREE = await import('three');
    const { MarkerView } = await import('../../src/render/markers');
    const { sim, car, course } = setup();
    const j = race(sim);
    const view = new MarkerView();
    const v = new THREE.Vector3();
    for (let k = 0; k < course.checkpoints.length; k++) {
      j.checkpoint = k;
      const [objective] = sim.activities.objectives();
      expect(objective!.radius).toBe(course.checkpoints[k]!.radius);
      view.syncObjectives([objective!], () => 0, 0);
      view.group.updateMatrixWorld(true);
      let ring = 0;
      view.group.traverseVisible((o) => {
        if (!(o instanceof THREE.Mesh) || o.name !== 'outline') return;
        const pos = o.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          // The ground ring lies 0.12 m above the road; the corner posts rise from the road itself.
          if (Math.abs(v.y - 0.12) < 0.02) ring = Math.max(ring, Math.hypot(v.x - objective!.x, v.z - objective!.z));
        }
      });
      expect(Math.abs(ring - objective!.radius), `gate ${k + 1}`).toBeLessThan(0.1);
    }
    expect(car.removed).toBe(false);
  });

  it('credits a tight inside line 12.1 m from the Magnolia gate-6 junction centre, but not airborne', () => {
    for (const airborne of [false, true]) {
      const { sim, car, course } = setup();
      const j = race(sim);
      const node = sim.roads.node(8, 5);
      j.checkpoint = course.checkpoints.findIndex((g) => g.nodeId === node.id);
      expect(j.checkpoint).toBe(5);
      // The right turn from (8,4) into (7,5): its inside corner is toward both of those neighbours.
      const from = sim.roads.node(8, 4);
      const to = sim.roads.node(7, 5);
      let ix = Math.sign(from.x - node.x) + Math.sign(to.x - node.x);
      let iz = Math.sign(from.z - node.z) + Math.sign(to.z - node.z);
      const l = Math.hypot(ix, iz);
      ix /= l;
      iz /= l;
      const px = node.x + ix * 12.1;
      const pz = node.z + iz * 12.1;
      // A short chord perpendicular to the radius: its closest approach is exactly 12.1 m.
      j.previousX = px + iz * 3;
      j.previousZ = pz - ix * 3;
      car.pos.x = px - iz * 3;
      car.pos.z = pz + ix * 3;
      car.airborne = airborne;
      sim.activities.update(0.1);
      expect(j.checkpoint, `airborne=${airborne}`).toBe(airborne ? 5 : 6);
    }
  });
});

describe('street run green wave', () => {
  it('holds the next two course junctions along the course for a full cycle, and nothing during the countdown', () => {
    for (const id of ['magnolia', 'coastline', 'dockside']) {
      const { sim, course } = setup(id);
      expect(sim.activities.startStreetRun(id)).toBe(true);
      step(sim, 1);
      expect(job(sim).stage).toBe('countdown');
      expectSignals(sim.roads, new Map(), sim.time);
      step(sim, 2.05);
      const j = job(sim);
      expect(j.stage).toBe('racing');
      const want = expectedHolds(sim.roads, course, 0);
      // Two junctions ahead, one where the first of them is a canal bridge (the Dockside Switchback).
      expect(want.size).toBe(id === 'dockside' ? 1 : 2);
      expect(new Map(sim.roads.heldSignals)).toEqual(want);
      for (let t = 0; t <= SIGNAL_CYCLE + 1; t += 0.5) {
        expectSignals(sim.roads, want, sim.time);
        step(sim, 0.5);
      }
      expect(j.checkpoint).toBe(0);
      sim.activities.toggleJob();
    }
  });

  it('matches a world with the same seed and no run on every other junction', () => {
    const { sim, course } = setup('magnolia', { world: freshWorld(), seed: 5 });
    const plain = new Sim({ world: freshWorld(), ambient: false, police: false, seed: 5 });
    race(sim, 'magnolia');
    const want = expectedHolds(sim.roads, course, 0);
    for (let t = 0; t <= SIGNAL_CYCLE; t += 0.5) {
      const time = sim.time + t;
      for (const node of sim.roads.nodes) {
        if (!node.signal || want.has(node.id)) continue;
        for (const a of ['NS', 'EW'] as const) {
          expect(sim.roads.signalState(node.id, a, time)).toBe(plain.roads.signalState(node.id, a, time));
          expect(sim.roads.pedCanCross(node.id, a, time)).toBe(plain.roads.pedCanCross(node.id, a, time));
        }
      }
    }
  });

  it('advances with each gate and holds only the junctions still ahead near the end', () => {
    for (const id of ['magnolia', 'coastline', 'dockside']) {
      const { sim, car, course } = setup(id);
      const j = race(sim, id);
      for (let k = 0; k < course.checkpoints.length - 1; k++) {
        expect(j.checkpoint).toBe(k);
        expect(new Map(sim.roads.heldSignals), `${id} before gate ${k + 1}`).toEqual(expectedHolds(sim.roads, course, k));
        const passed = course.checkpoints[k]!.nodeId;
        driveTo(sim, car, course.checkpoints[k]!.x, course.checkpoints[k]!.z);
        expect(j.checkpoint).toBe(k + 1);
        // On the tick that credits the gate, the junction just passed is back on its normal cycle.
        if (!course.nodes.slice(k + 2, k + 4).includes(passed)) expect(sim.roads.signalHold(passed)).toBeNull();
        expect(new Map(sim.roads.heldSignals), `${id} after gate ${k + 1}`).toEqual(expectedHolds(sim.roads, course, k + 1));
      }
      // Only the finish is left: the start junction was the last one held and has been passed.
      expect(j.checkpoint).toBe(course.checkpoints.length - 1);
      expect(sim.roads.heldSignals.size).toBe(0);
      sim.activities.toggleJob();
    }
  });

  it('is released on finish, cancel, running out of time, leaving the car, death, busted, a mission and quitting', () => {
    const routes: Record<string, (sim: Sim, car: Vehicle, course: StreetRunCourse) => void> = {
      finish: (sim, car, course) => {
        for (const gate of course.checkpoints) driveTo(sim, car, gate.x, gate.z);
        expect(sim.progress.streetRuns.magnolia).toBeDefined();
      },
      cancel: (sim) => sim.activities.toggleJob(),
      timeout: (sim, _car, course) => sim.activities.update(course.bronze + 0.1),
      exit: (sim) => {
        sim.unseat(sim.player);
        sim.activities.update(0.1);
      },
      wasted: (sim) => sim.playerDied(),
      busted: (sim) => sim.bustPlayer(),
      mission: (sim) => sim.activities.cancelAll('mission'),
    };
    for (const [route, end] of Object.entries(routes)) {
      const { sim, car, course } = setup();
      race(sim);
      expect(sim.roads.heldSignals.size, route).toBe(2);
      end(sim, car, course);
      expect(sim.activities.busy, route).toBe(false);
      expectReleased(sim);
      step(sim, 0.5);
      expectReleased(sim);
    }
    // QUIT TO TITLE drops the game's Sim mid-run and builds the title's on the same world.
    const shared = freshWorld();
    const { sim } = setup('magnolia', { world: shared });
    race(sim);
    expect(sim.roads.heldSignals.size).toBe(2);
    const title = new Sim({ world: shared, ambient: false, police: false });
    expect(title.roads).toBe(sim.roads);
    expectReleased(title);
  });

  it('holds only the second run’s junctions after a cancel', () => {
    const { sim, car } = setup('magnolia');
    race(sim, 'magnolia');
    sim.activities.toggleJob();
    expectReleased(sim);
    const coast = sim.activities.streetRunCourses().find((c) => c.id === 'coastline')!;
    car.pos.x = coast.start.x;
    car.pos.z = coast.start.z;
    car.heading = coast.start.heading;
    car.vel.x = car.vel.z = 0;
    race(sim, 'coastline');
    expect(new Map(sim.roads.heldSignals)).toEqual(expectedHolds(sim.roads, coast, 0));
    sim.activities.toggleJob();
    expectReleased(sim);
  });

  it('stops ambient cross traffic and pedestrians at held junctions, and they resume after a cancel', () => {
    const { sim, car, course } = setup('magnolia', { world: freshWorld(), ambient: true, seed: 3 });
    step(sim, 8);
    car.pos.x = course.start.x;
    car.pos.z = course.start.z;
    car.vel.x = car.vel.z = 0;
    race(sim, 'magnolia');
    const held = new Map(sim.roads.heldSignals);
    expect(held.size).toBe(2);
    const nodes = [...held].map(([id, axis]) => ({ node: sim.roads.nodes[id]!, axis }));
    /** Along the cross road, just short of the junction box. */
    const atCrossLine = (v: Vehicle, n: (typeof nodes)[number]) => {
      const along = n.axis === 'NS' ? Math.abs(v.pos.x - n.node.x) - n.node.halfX : Math.abs(v.pos.z - n.node.z) - n.node.halfZ;
      const across = n.axis === 'NS' ? Math.abs(v.pos.z - n.node.z) < n.node.halfZ : Math.abs(v.pos.x - n.node.x) < n.node.halfX;
      const crossHeading = n.axis === 'NS' ? Math.abs(Math.sin(v.heading)) > 0.8 : Math.abs(Math.cos(v.heading)) > 0.8;
      return across && crossHeading && along > 0 && along < 14;
    };
    const inBox = (x: number, z: number, n: (typeof nodes)[number]) => Math.abs(x - n.node.x) < n.node.halfX && Math.abs(z - n.node.z) < n.node.halfZ;
    /** On a crosswalk across the racer's road (the held axis) at this junction. */
    const onRacerCrosswalk = (x: number, z: number, n: (typeof nodes)[number]) => {
      const dx = Math.abs(x - n.node.x);
      const dz = Math.abs(z - n.node.z);
      return n.axis === 'NS'
        ? dx < n.node.halfX - 0.3 && dz > n.node.halfZ - 0.3 && dz < n.node.halfZ + CROSSWALK_W + 0.3
        : dz < n.node.halfZ - 0.3 && dx > n.node.halfX - 0.3 && dx < n.node.halfX + CROSSWALK_W + 0.3;
    };
    const traffic = () => sim.vehicles.filter((v) => !v.removed && v !== car && v.ai && v.driver);
    const waiting = new Set<Vehicle>();
    const ranLight: string[] = [];
    const alreadyCrossing = new Set(sim.characters.filter((c) => nodes.some((n) => onRacerCrosswalk(c.pos.x, c.pos.z, n))));
    const startedCrossing: string[] = [];
    let walkers = 0;
    // One full normal signal cycle with the racer still in the start gate.
    for (let f = 0; f < 60 * (SIGNAL_CYCLE + 2); f++) {
      step(sim, 1 / 60);
      for (const v of traffic()) {
        for (const n of nodes) {
          if (atCrossLine(v, n) && v.speed < 0.5) waiting.add(v);
          if (waiting.has(v) && inBox(v.pos.x, v.pos.z, n)) ranLight.push(`vehicle ${v.id} at ${n.node.i},${n.node.j}`);
        }
      }
      for (const c of sim.characters) {
        if (c.isPlayer || c.vehicle || alreadyCrossing.has(c) || c.brain?.mode === 'flee') continue;
        for (const n of nodes) {
          if (Math.hypot(c.pos.x - n.node.x, c.pos.z - n.node.z) < 30) walkers++;
          if (onRacerCrosswalk(c.pos.x, c.pos.z, n)) startedCrossing.push(`ped ${c.id} at ${n.node.i},${n.node.j}`);
        }
      }
    }
    expect(job(sim).stage).toBe('racing');
    expect(waiting.size, 'cross traffic reached the held junctions').toBeGreaterThan(0);
    expect(walkers, 'pedestrians were about the held junctions').toBeGreaterThan(0);
    expect(ranLight).toEqual([]);
    expect([...new Set(startedCrossing)]).toEqual([]);

    // Released, the cross traffic waiting there goes through within one signal cycle.
    sim.activities.toggleJob();
    expectReleased(sim);
    const through = new Set<Vehicle>();
    for (let f = 0; f < 60 * (SIGNAL_CYCLE + 2); f++) {
      step(sim, 1 / 60);
      for (const v of waiting) if (!v.removed && nodes.some((n) => inBox(v.pos.x, v.pos.z, n))) through.add(v);
    }
    expect(through.size).toBeGreaterThan(0);
  });
});

describe('pedestrians at a held junction', () => {
  it('wait at the kerb for as long as the junction is held, and cross once it is released', () => {
    const sim = new Sim({ world: freshWorld(), ambient: false, police: false });
    const walk = sim.world.walk;
    const from = walk.nodes.find((n) => n.edges.some((e) => e.crosswalk && sim.roads.nodes[e.roadNode]!.signal))!;
    const edge = from.edges.find((e) => e.crosswalk && sim.roads.nodes[e.roadNode]!.signal)!;
    // Held along the road this crosswalk crosses: no crossing until the racer is through.
    sim.roads.holdSignal(edge.roadNode, edge.axis!);
    expect(sim.roads.pedCanCross(edge.roadNode, edge.axis!, sim.time)).toBe(false);
    const ped = sim.spawnCharacter('civilian', from.x, from.z);
    ped.owner = 'ped';
    const brain = makeBrain('cross');
    brain.fromNode = from.id;
    brain.toNode = edge.to;
    ped.brain = brain;
    // Past the 40 s after which a pedestrian gives up on a light that never changes.
    step(sim, 50);
    expect(ped.brain.mode).toBe('cross');
    expect(Math.hypot(ped.pos.x - from.x, ped.pos.z - from.z)).toBeLessThan(1.5);
    sim.roads.releaseSignal(edge.roadNode);
    const to = walk.nodes[edge.to]!;
    let crossed = false;
    for (let f = 0; f < 60 * (SIGNAL_CYCLE + 20) && !crossed; f++) {
      step(sim, 1 / 60);
      crossed = Math.hypot(ped.pos.x - to.x, ped.pos.z - to.z) < 1.5;
    }
    expect(crossed).toBe(true);
  });
});

describe('street run medals', () => {
  it('are re-tuned below the old times for the faster laps and keep their inclusive boundaries', () => {
    for (const course of buildStreetRunCourses(world().roads)) {
      const [gold, silver, bronze] = OLD_MEDALS[course.id];
      expect(course.gold).toBeLessThan(course.silver);
      expect(course.silver).toBeLessThan(course.bronze);
      expect(course.gold).toBeLessThan(gold);
      expect(course.silver).toBeLessThan(silver);
      expect(course.bronze).toBeLessThan(bronze);
    }
  });
});
