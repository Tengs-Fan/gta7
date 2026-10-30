// Hails (src/sim/activities/taxiHail.ts) and the taxi job's fares (taxi.ts, fares.ts): a pedestrian at the curb ahead
// waves down a taxi the player drives and becomes the fare when it stops beside him, a waiting fare waves at his cab,
// fares say where to and goodbye in their own voice, and the first-time hints point the player at all of it.

import { describe, expect, it } from 'vitest';
import { makeBrain } from '../../src/sim/brains';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import { fareOf, FARES } from '../../src/sim/activities/fares';
import type { TaxiJob } from '../../src/sim/activities';
import type { PlayerSlot } from '../../src/sim/playerSlot';
import type { Sim } from '../../src/sim/sim';
import { dialogueKey, SPEECH } from '../../src/sim/speech';
import { STORY } from '../../src/sim/missions';
import { HintSystem } from '../../src/ui/hints';
import type { HintOptions } from '../../src/ui/hud';
import type { Lane } from '../../src/world/roads';
import { BARKS, CAST, SPEAKERS } from '../../scripts/assets/speech/script';
import { input, legacyLane, makeSim, placeInCar, step, teleport } from './helpers';

/** How far up the lane the cab starts (m), and the pedestrian stands ahead of it. */
const START = 20;
const AHEAD = 35;

/** A spot on the sidewalk to the right of `lane`, `s` metres along it: the first free ground off the road, a step in. */
function curbside(sim: Sim, lane: Lane, s: number): { x: number; z: number } {
  const rx = -Math.cos(lane.heading);
  const rz = Math.sin(lane.heading);
  const x0 = lane.sx + lane.dx * s;
  const z0 = lane.sz + lane.dz * s;
  for (let d = 1; d < 20; d += 0.25) {
    const x = x0 + rx * d;
    const z = z0 + rz * d;
    if (!sim.world.isOnRoad(x, z) && sim.world.isFree(x, z, 0.4)) return { x: x + rx, z: z + rz };
  }
  throw new Error(`no sidewalk beside lane ${lane.id}`);
}

/** A pedestrian standing about on the sidewalk (as the ambient ones do now and then on their walk). */
function plantPed(sim: Sim, at: { x: number; z: number }): Character {
  const c = sim.spawnCharacter('civilian', at.x, at.z);
  c.owner = 'ped';
  c.brain = makeBrain('idle');
  c.brain.modeTimer = 60;
  return c;
}

/** The outermost lane of the long straight road that roadPoint uses, or of another one far from it. */
function laneOf(sim: Sim, legacy: number): Lane {
  const l = legacyLane(sim, legacy);
  return sim.roads.lanesBetween(l.from, l.to).reduce((a, b) => (b.index > a.index ? b : a));
}

function placeOnLane(v: Vehicle, sim: Sim, lane: Lane, s: number): void {
  v.pos.x = lane.sx + lane.dx * s;
  v.pos.z = lane.sz + lane.dz * s;
  v.pos.y = sim.world.groundHeight(v.pos.x, v.pos.z);
  v.heading = lane.heading;
  v.vel.x = 0;
  v.vel.z = 0;
  v.angVel = 0;
}

/** Steps with the cab held at `speed` along its heading (a steady drive up the lane). */
function cruise(sim: Sim, cabs: Vehicle[], seconds: number, speed = 8): void {
  step(sim, seconds, () => {
    for (const v of cabs) {
      v.vel.x = Math.sin(v.heading) * speed;
      v.vel.z = Math.cos(v.heading) * speed;
    }
    return input();
  });
}

interface Rig {
  sim: Sim;
  lane: Lane;
  taxi: Vehicle;
  ped: Character;
  hails: Array<SimEvents['taxiHail']>;
  subs: Array<SimEvents['subtitle']>;
  bigs: string[];
}

/** The player at the wheel of a stopped taxi long enough for a hail (the first one's wait spent), a pedestrian ahead. */
function rig(sim = makeSim({ ambient: false, police: false }), legacy = 40): Rig {
  const lane = laneOf(sim, legacy);
  const taxi = sim.spawnVehicle('taxi', lane.sx + lane.dx * START, lane.sz + lane.dz * START, lane.heading);
  placeInCar(sim, taxi);
  const ped = plantPed(sim, curbside(sim, lane, START + AHEAD));
  const hails: Array<SimEvents['taxiHail']> = [];
  const subs: Array<SimEvents['subtitle']> = [];
  const bigs: string[] = [];
  sim.events.on('taxiHail', (e) => hails.push(e));
  sim.events.on('subtitle', (e) => subs.push(e));
  sim.events.on('big', (e) => bigs.push(e.text));
  step(sim, 6.5);
  return { sim, lane, taxi, ped, hails, subs, bigs };
}

/** Along-lane position of `c` on `lane`. */
function alongOf(lane: Lane, c: Character): number {
  return (c.pos.x - lane.sx) * lane.dx + (c.pos.z - lane.sz) * lane.dz;
}

function taxiJob(sim: Sim, who?: PlayerSlot): TaxiJob {
  const j = sim.activities.jobOf(who);
  expect(j?.kind).toBe('taxi');
  return j as TaxiJob;
}

describe('a pedestrian waves down the taxi the player drives', () => {
  it('raises his arm and calls out as the cab comes up the road', () => {
    const { sim, taxi, ped, hails } = rig();
    expect(hails).toEqual([]);
    cruise(sim, [taxi], 1);
    expect(ped.hailTimer).toBeGreaterThan(0);
    expect(ped.brain!.mode).toBe('idle');
    expect(hails).toHaveLength(1);
    expect(hails[0]).toMatchObject({ caller: ped, started: true, missed: false });
    expect(sim.activities.job).toBeNull();
  });

  it('stopping beside him starts the taxi job with him as the fare, and he names his stop and pays', () => {
    const { sim, lane, taxi, ped, subs, bigs } = rig();
    cruise(sim, [taxi], 1);
    expect(ped.hailTimer).toBeGreaterThan(0);
    placeOnLane(taxi, sim, lane, alongOf(lane, ped));
    step(sim, 0.2);
    const job = taxiJob(sim);
    expect(job.fare).toBe(ped);
    expect(bigs).toContain('TAXI DRIVER');
    expect(ped.owner).toBe('mission');
    expect(ped.hailTimer).toBe(0);
    step(sim, 5);
    expect(ped.vehicle).toBe(taxi);
    expect(job.stage).toBe('dropoff');
    const fare = fareOf(ped);
    const ask = subs.find((s) => s.speaker === fare.speaker);
    expect(ask).toMatchObject({ speaker: fare.speaker, text: fare.ask(job.destName) });
    // Recorded, whichever stop he names.
    expect(SPEECH.dialogue[dialogueKey(ask!.speaker, ask!.text)], ask!.text).toBeDefined();
    const money: number[] = [];
    sim.events.on('money', (e) => money.push(e.amount));
    teleport(sim, job.destX, job.destZ);
    step(sim, 0.5);
    expect(money.length).toBeGreaterThan(0);
    expect(bigs).toContain('FARE COMPLETE');
    expect(subs.at(-1)).toMatchObject({ speaker: fare.speaker, text: fare.paid });
    expect(SPEECH.dialogue[dialogueKey(fare.speaker, fare.paid)]).toBeDefined();
    expect(sim.progress.stats.taxiFares).toBe(1);
    expect(ped.owner).toBe('ped');
  });

  it('driving past leaves him grumbling, and he walks on', () => {
    const { sim, taxi, ped, hails } = rig();
    cruise(sim, [taxi], 1);
    expect(ped.hailTimer).toBeGreaterThan(0);
    cruise(sim, [taxi], 8);
    expect(hails.at(-1)).toMatchObject({ caller: ped, started: false, missed: true });
    expect(ped.hailTimer).toBe(0);
    expect(ped.brain!.mode).toBe('wander');
    expect(sim.activities.job).toBeNull();
  });

  it('never for a stopped cab, a wanted player, during a story mission, or a passenger', () => {
    const stopped = rig();
    step(stopped.sim, 10);
    expect(stopped.hails).toEqual([]);

    const wanted = rig();
    wanted.sim.wanted.setLevel(1);
    cruise(wanted.sim, [wanted.taxi], 2);
    expect(wanted.hails).toEqual([]);
    expect(wanted.ped.hailTimer).toBe(0);

    // A story mission (the first, from Lou's marker), then the taxi.
    const sim = makeSim({ ambient: false, police: false });
    const lou = sim.world.layout.pois.find((p) => p.id === 'lou')!;
    teleport(sim, lou.x, lou.z);
    step(sim, 0.1);
    const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === STORY[0]!.id)!;
    teleport(sim, marker.x, marker.z);
    step(sim, 0.1);
    sim.update(1 / 60, input({ interact: true }));
    step(sim, 0.5);
    expect(sim.missions.active).not.toBeNull();
    const mission = rig(sim);
    cruise(sim, [mission.taxi], 2);
    expect(sim.missions.active).not.toBeNull();
    expect(mission.hails).toEqual([]);

    // Riding in the back of a cab somebody else drives.
    const ride = makeSim({ ambient: false, police: false });
    const lane = laneOf(ride, 40);
    const cab = ride.spawnVehicle('taxi', lane.sx + lane.dx * START, lane.sz + lane.dz * START, lane.heading);
    ride.seat(ride.spawnCharacter('civilian', cab.pos.x, cab.pos.z), cab, 0);
    ride.seat(ride.player, cab, 1);
    const ped = plantPed(ride, curbside(ride, lane, START + AHEAD));
    const hails: Array<SimEvents['taxiHail']> = [];
    ride.events.on('taxiHail', (e) => hails.push(e));
    step(ride, 6.5);
    cruise(ride, [cab], 2);
    expect(hails).toEqual([]);
    expect(ped.hailTimer).toBe(0);
  });

  it('draws the same hails from the same seed', () => {
    const run = () => {
      const r = rig(makeSim({ ambient: true, police: false, seed: 23 }));
      const log: string[] = [];
      r.sim.events.on('taxiHail', (e) => log.push(`${r.sim.frame} ${e.caller.id} ${e.started} ${e.missed}`));
      cruise(r.sim, [r.taxi], 30, 7);
      return log;
    };
    const a = run();
    expect(a.length).toBeGreaterThan(1);
    expect(run()).toEqual(a);
  });

  it('gives each of two players in two taxis his own hailer and his own fare', () => {
    const sim = makeSim({ ambient: false, police: false });
    const a = rig(sim, 40);
    const laneB = laneOf(sim, 400);
    const slotB = sim.addPlayer(laneB.sx, laneB.sz);
    const taxiB = sim.spawnVehicle('taxi', laneB.sx + laneB.dx * START, laneB.sz + laneB.dz * START, laneB.heading);
    sim.seat(slotB.character, taxiB, 0);
    const pedB = plantPed(sim, curbside(sim, laneB, START + AHEAD));
    expect(Math.hypot(taxiB.pos.x - a.taxi.pos.x, taxiB.pos.z - a.taxi.pos.z)).toBeGreaterThan(150);
    step(sim, 6.5);
    cruise(sim, [a.taxi, taxiB], 1);
    expect(a.ped.hailTimer).toBeGreaterThan(0);
    expect(pedB.hailTimer).toBeGreaterThan(0);
    expect(a.hails.filter((e) => e.started).map((e) => e.caller)).toEqual([a.ped, pedB]);
    placeOnLane(a.taxi, sim, a.lane, alongOf(a.lane, a.ped));
    placeOnLane(taxiB, sim, laneB, alongOf(laneB, pedB));
    step(sim, 5);
    const slotA = sim.players[0]!;
    expect(taxiJob(sim, slotA).fare).toBe(a.ped);
    expect(taxiJob(sim, slotB).fare).toBe(pedB);
    expect(a.ped.vehicle).toBe(a.taxi);
    expect(pedB.vehicle).toBe(taxiB);
  });
});

describe('the taxi job started with the job key', () => {
  it('has its waiting fare wave at the cab coming his way, and lower his arm as he walks to it', () => {
    const { sim, taxi, hails } = rig();
    sim.activities.toggleJob();
    const job = taxiJob(sim);
    const fare = job.fare!;
    expect(fare.hailTimer).toBe(0);
    // 30 m off, stopped on the road beside him.
    const lane = sim.roads.nearestLane(fare.pos.x, fare.pos.z).lane;
    const s = (fare.pos.x - lane.sx) * lane.dx + (fare.pos.z - lane.sz) * lane.dz;
    placeOnLane(taxi, sim, lane, Math.max(0, s - 30));
    expect(Math.hypot(taxi.pos.x - fare.pos.x, taxi.pos.z - fare.pos.z)).toBeLessThan(40);
    step(sim, 0.5);
    expect(fare.hailTimer).toBeGreaterThan(0);
    expect(hails.filter((e) => e.started)).toEqual([expect.objectContaining({ caller: fare, started: true })]);
    step(sim, 1);
    placeOnLane(taxi, sim, lane, s);
    step(sim, 0.3);
    expect(job.boarding).toBeGreaterThanOrEqual(0);
    expect(fare.hailTimer).toBe(0);
    step(sim, 4);
    expect(fare.vehicle).toBe(taxi);
    expect(hails.filter((e) => e.started)).toHaveLength(1);
  });

  it('has a knocked-down fare lie still, and wave and call out once back on his feet', () => {
    const { sim, taxi, hails } = rig();
    sim.activities.toggleJob();
    const fare = taxiJob(sim).fare!;
    const lane = sim.roads.nearestLane(fare.pos.x, fare.pos.z).lane;
    placeOnLane(taxi, sim, lane, Math.max(0, alongOf(lane, fare) - 25));
    // Turned away from the cab, as the cab clipping him at the curb would leave him.
    fare.heading = Math.atan2(fare.pos.x - taxi.pos.x, fare.pos.z - taxi.pos.z);
    fare.state = 'knocked';
    fare.knockTimer = 3;
    const heading = fare.heading;
    step(sim, 0.5);
    expect(fare.state).toBe('knocked');
    expect(fare.hailTimer).toBe(0);
    expect(fare.heading).toBe(heading);
    expect(hails).toEqual([]);
    step(sim, 4);
    expect(fare.state).toBe('normal');
    expect(fare.hailTimer).toBeGreaterThan(0);
    expect(hails).toEqual([expect.objectContaining({ caller: fare, started: true })]);
  });

  it('has a fare scared off on his way to the cab run without waving', () => {
    const { sim, taxi } = rig();
    sim.activities.toggleJob();
    const job = taxiJob(sim);
    const fare = job.fare!;
    const lane = sim.roads.nearestLane(fare.pos.x, fare.pos.z).lane;
    placeOnLane(taxi, sim, lane, alongOf(lane, fare));
    step(sim, 0.3);
    expect(fare.brain!.mode).toBe('guard');
    sim.peds.onViolence(fare.pos.x, fare.pos.z, null, 60);
    expect(fare.brain!.mode).toBe('flee');
    let waved = 0;
    step(sim, 1, () => {
      waved = Math.max(waved, fare.hailTimer);
      return input();
    });
    expect(fare.brain!.mode).toBe('flee');
    expect(job.boarding).toBe(-1);
    expect(waved).toBe(0);
  });

  it('lets a fare killed while he waves go with his arm down', () => {
    const { sim, taxi } = rig();
    sim.activities.toggleJob();
    const fare = taxiJob(sim).fare!;
    const lane = sim.roads.nearestLane(fare.pos.x, fare.pos.z).lane;
    placeOnLane(taxi, sim, lane, Math.max(0, alongOf(lane, fare) - 25));
    step(sim, 0.5);
    expect(fare.hailTimer).toBeGreaterThan(0);
    sim.combat.kill(fare, null, 'bullet', 0, 0);
    step(sim, 0.1);
    expect(taxiJob(sim).fare).not.toBe(fare);
    expect(fare.owner).toBe('ped');
    expect(fare.hailTimer).toBe(0);
  });

  it('lets a pedestrian who hails the cab on its way to the fare take his place', () => {
    const { sim, lane, taxi, ped } = rig();
    sim.activities.toggleJob();
    const job = taxiJob(sim);
    const marked = job.fare!;
    expect(marked).not.toBe(ped);
    cruise(sim, [taxi], 1);
    expect(ped.hailTimer).toBeGreaterThan(0);
    placeOnLane(taxi, sim, lane, alongOf(lane, ped));
    step(sim, 0.2);
    expect(job.fare).toBe(ped);
    expect(sim.activities.job).toBe(job);
    expect(marked.owner).toBe('ped');
    expect(marked.missionTag).toBe('');
    expect(marked.persistent).toBe(false);
    step(sim, 5);
    expect(ped.vehicle).toBe(taxi);
    expect(job.stage).toBe('dropoff');
  });
});

function hintRig(sim: Sim) {
  const seen = ['drive', 'wanted', 'weapon', 'mouse'];
  const pending = new Map<string, { text: string; options: HintOptions }>();
  const hints = new HintSystem({
    enabled: () => true,
    seen: () => seen,
    markSeen: (id) => seen.push(id),
    pending: (id) => pending.has(id),
    show: (text, _duration, options) => {
      pending.set(options.id, { text, options });
      return true;
    },
  });
  const update = () => hints.update(1 / 60, sim, { device: 'kb', mouseFree: false });
  return { pending, seen, update };
}

describe('the first-time taxi hints', () => {
  it('tell a cab driver about hails and the job key, and a taxi job about pay and how to end it', () => {
    const sim = makeSim({ ambient: false, police: false });
    const lane = laneOf(sim, 40);
    const sedan = sim.spawnVehicle('sedan', lane.sx + lane.dx * START, lane.sz + lane.dz * START, lane.heading);
    placeInCar(sim, sedan);
    const h = hintRig(sim);
    h.update();
    expect(h.pending.has('taxi')).toBe(false);
    sim.unseat(sim.player);
    const taxi = sim.spawnVehicle('taxi', lane.sx + lane.dx * (START + 30), lane.sz + lane.dz * (START + 30), lane.heading);
    placeInCar(sim, taxi);
    h.update();
    expect(h.pending.get('taxi')?.text).toContain('wave down cabs');
    expect(h.pending.has('taxi:shift')).toBe(false);
    sim.activities.toggleJob();
    h.update();
    expect(h.pending.get('taxi')!.options.valid!()).toBe(false);
    expect(h.pending.get('taxi:shift')?.text).toContain('$500 bonus');
  });
});

describe('the fares voices', () => {
  it('hails in the voice the hailer talks in once aboard', () => {
    for (const kind of ['hail', 'hailMissed'] as const) {
      expect(BARKS[kind].voices).toHaveLength(FARES.length);
      FARES.forEach((f, i) => expect(BARKS[kind].voices[i], `${kind} ${f.speaker}`).toBe(CAST[SPEAKERS[f.speaker]!]));
      expect(SPEECH.barks[kind]).toHaveLength(FARES.length);
    }
  });
});
