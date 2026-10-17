// Round 2, missions cluster: route drivers that arrive (P96), mission and activity bugs (P87), retry,
// skippable dialogue and checkpoints (P4), the restaged missions (P35) and finished objectives (P57a).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { wrapAngle } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import type { MissionCtx } from '../../src/sim/missions/runner';
import { RETRY_WINDOW } from '../../src/sim/missions/runner';
import { missionSpots } from '../../src/sim/missions/spots';
import { Sim, type SimOptions } from '../../src/sim/sim';
import { ARRIVE_RADIUS } from '../../src/sim/driver';
import { SIGNAL_CYCLE, SIGNAL_GREEN } from '../../src/world/roads';
import { StaticWorld } from '../../src/world/staticWorld';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

// --- helpers ------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(done: string[], opts: SimOptions = {}): Sim {
  const sim = makeSim({ ambient: false, ...opts });
  for (const d of done) sim.progress.markDone(d);
  sim.cheats.godMode = true;
  step(sim, 0.1);
  return sim;
}

const STORY = ['wheels', 'delivery', 'repo', 'loose_lips', 'heatwave', 'big_score'];
/** Everything before mission `id`. */
const before = (id: string) => STORY.slice(0, STORY.indexOf(id));

function startMission(sim: Sim, id: string): MissionCtx {
  const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === id);
  expect(marker, `marker for ${id}`).toBeDefined();
  teleport(sim, marker!.x, marker!.z);
  step(sim, 0.1);
  sim.update(1 / 60, input({ interact: true }));
  expect(sim.missions.active?.def.id).toBe(id);
  return sim.missions.active!;
}

/** Steps until the predicate holds (or fails after `max` seconds). */
function stepUntil(sim: Sim, pred: () => boolean, max: number, dt = 1 / 60): void {
  for (let t = 0; t < max; t += dt) {
    if (pred()) return;
    sim.update(dt, input());
  }
  expect(pred(), 'condition not reached in time').toBe(true);
}

const objective = (sim: Sim) => sim.missions.active?.objectiveText ?? '';
const press = (sim: Sim) => sim.update(1 / 60, input({ interact: true }));

function enterVehicle(sim: Sim, v: Vehicle): void {
  const sx = Math.cos(v.heading);
  const sz = -Math.sin(v.heading);
  teleport(sim, v.pos.x + sx * (v.halfW + 0.8), v.pos.z + sz * (v.halfW + 0.8));
  sim.update(1 / 60, input({ enterExit: true }));
  stepUntil(sim, () => sim.player.vehicle === v, 3);
}

function parkIn(sim: Sim, v: Vehicle, x: number, z: number): void {
  v.pos.x = x;
  v.pos.z = z;
  v.pos.y = sim.world.groundHeight(x, z);
  v.vel.x = 0;
  v.vel.z = 0;
}

/** Records every event of `type`. */
function record<K extends keyof SimEvents>(sim: Sim, type: K): Array<SimEvents[K]> {
  const out: Array<SimEvents[K]> = [];
  sim.events.on(type, (e) => out.push(e));
  return out;
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** Plays Hot Delivery up to the parcel being collected (the timer and the tail start then). */
function collectParcel(sim: Sim): MissionCtx {
  const m = startMission(sim, 'delivery');
  stepUntil(sim, () => objective(sim) === 'Collect the package', 20);
  const pick = missionSpots(sim.world).packagePickup;
  teleport(sim, pick.x, pick.z);
  stepUntil(sim, () => m.timer !== null, 2);
  return m;
}

// --- P96: route drivers -----------------------------------------------------------

describe('route drivers reach their destination', () => {
  it('caches distanceField per goal and measures shortest road distances', () => {
    const roads = world().roads;
    const goal = roads.node(3, 4).id;
    const f = roads.distanceField(goal);
    expect(roads.distanceField(goal)).toBe(f);
    expect(f[goal]).toBe(0);
    for (const from of [roads.node(0, 0).id, roads.node(9, 7).id, roads.node(3, 10).id]) {
      const route = roads.findRoute(from, goal)!;
      let len = 0;
      for (let i = 1; i < route.length; i++) len += dist(roads.nodes[route[i - 1]!]!, roads.nodes[route[i]!]!);
      expect(f[from]).toBeCloseTo(len, 6);
    }
  });

  /**
   * Drives a route sedan from 20 random lanes to random road points 300-900 m away. Per run: whether
   * it arrived (within 25 m), when, the A* route length and the signalled junctions on that route, and
   * whether `arrived` ever showed more than 30 m out or the car was still moving 3 s after arriving.
   */
  function routeRuns(sim: Sim, seed: number): Array<{ arrivedAt: number; astar: number; signals: number; ok: boolean; log: string }> {
    const roads = sim.roads;
    const rng = new Rng(seed);
    const lanes = roads.lanes.filter((l) => l.length > 30);
    const out: Array<{ arrivedAt: number; astar: number; signals: number; ok: boolean; log: string }> = [];
    for (let run = 0; run < 20; run++) {
      let lane = lanes[0]!;
      let s = 0;
      let dest = { x: 0, z: 0 };
      for (;;) {
        lane = rng.pick(lanes);
        s = rng.range(6, lane.length - 12);
        const dl = rng.pick(lanes);
        const ds = rng.range(0, dl.length);
        dest = { x: dl.sx + dl.dx * ds, z: dl.sz + dl.dz * ds };
        const d = Math.hypot(lane.sx + lane.dx * s - dest.x, lane.sz + lane.dz * s - dest.z);
        if (d >= 300 && d <= 900) break;
      }
      const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * s, lane.sz + lane.dz * s, lane.heading);
      sim.addDriver(car, 'civilian', 'route');
      car.ai!.setLane(lane, s);
      car.ai!.setDestination(dest.x, dest.z);
      const goal = roads.nearestNode(dest.x, dest.z);
      const route = roads.findRoute(lane.to, goal.id)!;
      let astar = lane.length - s + dist(goal, dest);
      for (let i = 1; i < route.length; i++) astar += dist(roads.nodes[route[i - 1]!]!, roads.nodes[route[i]!]!);
      const signals = route.filter((id) => roads.nodes[id]!.signal).length;
      let arrivedAt = -1;
      let early = false;
      let stopped = false;
      let closest = Infinity;
      const dt = 1 / 30;
      for (let t = 0; t < astar / 4 + 60; t += dt) {
        sim.update(dt, input());
        const d = dist(car.pos, dest);
        closest = Math.min(closest, d);
        if (car.ai!.arrived && d > 30) early = true;
        if (car.ai!.arrived && arrivedAt < 0) arrivedAt = t;
        if (arrivedAt >= 0 && t >= arrivedAt + 3) {
          stopped = car.speed < 0.5;
          break;
        }
      }
      const log = `run ${run}: lane ${lane.id} dest ${dest.x.toFixed(0)},${dest.z.toFixed(0)} astar ${astar.toFixed(0)} signals ${signals} arrived ${arrivedAt.toFixed(1)} closest ${closest.toFixed(1)} stopped ${stopped} early ${early}`;
      out.push({ arrivedAt, astar, signals, ok: arrivedAt >= 0 && closest <= 25 && !early && stopped, log });
      sim.removeVehicle(car);
      sim.update(dt, input());
    }
    return out;
  }

  it('arrives within 25 m of destinations 300-900 m away from 20 random lanes, then stops and holds', () => {
    // The routes themselves, without signals: P96's budget, the A* length at 8 m/s plus 30 s.
    const open = new StaticWorld();
    for (const n of open.roads.nodes) n.signal = false;
    const runs = routeRuns(new Sim({ world: open, ambient: false, police: false }), 9001);
    const log = runs.map((r) => r.log).join('\n');
    expect(runs.every((r) => r.ok), log).toBe(true);
    expect(runs.filter((r) => r.arrivedAt <= r.astar / 8 + 30).length, log).toBeGreaterThanOrEqual(18);
    // With the signals working, law-abiding drivers also wait at red lights, which P96's budget left
    // out (only 9-14 of 20 runs make it over six seeds). The same budget plus the expected wait at each
    // signalled junction on the route (a car arriving at a random moment finds no green 21 s in 32
    // and waits half of that on average: 6.9 s) still holds for 18 of 20, and none takes absurdly long.
    const notGreen = SIGNAL_CYCLE - SIGNAL_GREEN;
    const redWait = (notGreen / SIGNAL_CYCLE) * (notGreen / 2);
    expect(redWait).toBeCloseTo(6.89, 2);
    const lit = routeRuns(new Sim({ world: world(), ambient: false, police: false }), 9001);
    const litLog = lit.map((r) => r.log).join('\n');
    expect(lit.every((r) => r.ok), litLog).toBe(true);
    expect(lit.filter((r) => r.arrivedAt <= r.astar / 8 + 30 + r.signals * redWait).length, litLog).toBeGreaterThanOrEqual(18);
    expect(lit.every((r) => r.arrivedAt <= r.astar / 5 + 30), litLog).toBe(true);
  });

  it('reports the driving distance left and stops counting at the destination', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const lane = sim.roads.lanes.find((l) => l.length > 60 && l.turns.length > 0)!;
    const next = lane.turns.find((t) => t.kind === 'straight')!.to;
    const dest = { x: next.sx + next.dx * 40, z: next.sz + next.dz * 40 };
    const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading);
    sim.addDriver(car, 'civilian', 'route');
    car.ai!.setLane(lane, 10);
    car.ai!.setDestination(dest.x, dest.z);
    const left0 = car.ai!.routeRemaining();
    // Along this lane, through the junction and 40 m into the next lane.
    expect(left0).toBeGreaterThan(lane.length - 10 + 30);
    expect(left0).toBeLessThan(lane.length - 10 + 40 + 40);
    step(sim, 3, input(), 1 / 30);
    expect(car.ai!.routeRemaining()).toBeLessThan(left0 - 10);
    stepUntil(sim, () => car.ai!.arrived, 40, 1 / 30);
    expect(dist(car.pos, dest)).toBeLessThanOrEqual(ARRIVE_RADIUS + 0.5);
    expect(car.ai!.routeRemaining()).toBe(0);
  });

  it('a new destination clears the arrival, however it is set', () => {
    const sim = new Sim({ world: world(), ambient: false, police: false });
    const lane = sim.roads.lanes.find((l) => l.length > 60 && l.turns.length > 0)!;
    const near = { x: lane.sx + lane.dx * 30, z: lane.sz + lane.dz * 30 };
    const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 5, lane.sz + lane.dz * 5, lane.heading);
    sim.addDriver(car, 'civilian', 'route');
    car.ai!.setLane(lane, 5);
    car.ai!.setDestination(near.x, near.z);
    stepUntil(sim, () => car.ai!.arrived && car.speed < 0.3, 20, 1 / 30);
    const next = lane.turns.find((t) => t.kind === 'straight')!.to;
    const far = { x: next.sx + next.dx * 40, z: next.sz + next.dz * 40 };
    car.ai!.dest = far;
    expect(car.ai!.arrived).toBe(false);
    expect(car.ai!.routeRemaining()).toBeGreaterThan(40);
    stepUntil(sim, () => car.ai!.arrived, 40, 1 / 30);
    expect(dist(car.pos, far)).toBeLessThanOrEqual(ARRIVE_RADIUS + 0.5);
  });

  it('spawnDriver puts a mission-owned car and driver on a lane, with a route when given a destination', () => {
    const sim = setup([]);
    const m = startMission(sim, 'wheels');
    const lane = sim.roads.lanes.find((l) => l.length > 40)!;
    const dest = { x: 100, z: 100 };
    const v = m.spawnDriver('sedan', lane, 12, 'gang', 'traffic', dest);
    const d = v.driver!;
    expect(v.owner).toBe('mission');
    expect(v.persistent).toBe(true);
    expect(d.owner).toBe('mission');
    expect(d.persistent).toBe(true);
    expect(d.role).toBe('gang');
    expect(m.vehicles).toContain(v);
    expect(m.characters).toContain(d);
    expect(v.ai!.policy).toBe('route');
    expect(v.ai!.dest).toEqual(dest);
    expect(dist(v.pos, { x: lane.sx + lane.dx * 12, z: lane.sz + lane.dz * 12 })).toBeLessThan(0.01);
    const c = m.spawnDriver('muscle', lane, 30, 'gang', 'chase');
    expect(c.ai!.policy).toBe('chase');
    expect(c.ai!.dest).toBeNull();
  });
});

// --- P87: mission and activity bugs -------------------------------------------------

describe('mission and activity fixes', () => {
  it('pays nothing for a fare who bailed out of a burning cab, and finds a new fare', () => {
    const sim = makeSim({ police: false, ambient: false });
    const lane = sim.roads.lanes.find((l) => l.lanesInDir === 1 && l.length > 60 && Math.abs(l.sx) < 300 && Math.abs(l.sz) < 300)!;
    const x = lane.sx + lane.dx * lane.length * 0.5;
    const z = lane.sz + lane.dz * lane.length * 0.5;
    const taxi = sim.spawnVehicle('taxi', x, z, lane.heading);
    placeInCar(sim, taxi);
    step(sim, 0.05);
    sim.activities.toggleJob();
    const job = () => sim.activities.job as unknown as { kind: string; stage: string; fare: Character | null; destX: number; destZ: number };
    const fare = job().fare!;
    fare.pos.x = x - Math.cos(lane.heading) * 3.5;
    fare.pos.z = z + Math.sin(lane.heading) * 3.5;
    step(sim, 0.05);
    expect(job().stage).toBe('dropoff');
    expect(fare.vehicle).toBe(taxi);
    const money = sim.progress.money;
    const fares = sim.progress.stats.taxiFares;
    const messages = record(sim, 'message');
    sim.combat.igniteVehicle(taxi, 5);
    step(sim, 0.1);
    expect(fare.vehicle).toBeNull();
    expect(messages.some((e) => e.text.startsWith('The fare bailed. No fare, no tip.'))).toBe(true);
    // Straight to the old destination: nobody to pay.
    parkIn(sim, taxi, job().destX, job().destZ);
    step(sim, 0.5);
    expect(sim.progress.money).toBe(money);
    expect(sim.progress.stats.taxiFares).toBe(fares);
    expect(job().kind).toBe('taxi');
    expect(job().stage).toBe('pickup');
    expect(job().fare).not.toBeNull();
    expect(job().fare).not.toBe(fare);
    // The bailed fare is an ordinary pedestrian again, still running from the fire.
    expect(fare.persistent).toBe(false);
    expect(fare.brain?.mode).toBe('flee');
  });

  it("calls Benny's car off when Loose Lips is abandoned", () => {
    const sim = setup(before('loose_lips'), { police: false });
    const m = startMission(sim, 'loose_lips');
    stepUntil(sim, () => objective(sim) === 'Take out Benny', 20);
    const car = m.characters[0]!.vehicle!;
    expect(car.ai!.policy).toBe('route');
    sim.missions.abandon();
    step(sim, 0.1);
    expect(sim.missions.active).toBeNull();
    expect(car.ai!.policy).toBe('traffic');
    expect(car.ai!.target).toBeNull();
    expect(car.ai!.dest).toBeNull();
    expect(car.persistent).toBe(false);
    expect(car.owner).toBe('traffic');
  });

  it('parks the Nightjar in Westside, as Lou says', () => {
    const w = world();
    const s = missionSpots(w);
    expect(w.zoneName(s.repoCar.x, s.repoCar.z)).toBe('Westside');
    expect(s.repoGuards.length).toBe(3);
  });
});

// --- P4: retry, skippable dialogue, checkpoints ---------------------------------------

describe('retrying a failed mission', () => {
  it('restarts Hot Delivery at Lou after the timer runs out, with one press of E', () => {
    const sim = setup(['wheels']);
    const spots = missionSpots(sim.world);
    const big = record(sim, 'big');
    const m = collectParcel(sim);
    stepUntil(sim, () => sim.missions.active === null, 100, 1 / 30);
    expect(m.failedReason).toBe('The buyer walked.');
    expect(big.at(-1)).toEqual(expect.objectContaining({ text: 'MISSION FAILED', sub: 'The buyer walked. - Press E to retry' }));
    expect(sim.interactions.current()).toBeNull();
    expect(sim.interactions.prompt()).toBe('Press E to retry "Hot Delivery"');
    press(sim);
    stepUntil(sim, () => objective(sim) === 'Collect the package', 1);
    const again = sim.missions.active!;
    expect(again).not.toBe(m);
    expect(again.def.id).toBe('delivery');
    expect(again.retrying).toBe(true);
    expect(dist(sim.player.pos, spots.lou)).toBeLessThan(6);
    expect(sim.interactions.prompt()).toBeNull();
  });

  it('skips the intro on a retry', () => {
    const sim = setup(['wheels']);
    const m = startMission(sim, 'delivery');
    m.fail('test');
    step(sim, 0.1);
    const subs = record(sim, 'subtitle');
    teleport(sim, sim.player.pos.x + 20, sim.player.pos.z);
    press(sim);
    stepUntil(sim, () => objective(sim) === 'Collect the package', 1);
    expect(subs.filter((s) => s.speaker)).toEqual([]);
  });

  it('skips the title card on a retry too: straight back to work', () => {
    const sim = setup(['wheels']);
    const big = record(sim, 'big');
    const m = startMission(sim, 'delivery');
    expect(big.filter((b) => b.style === 'title').map((b) => b.text)).toEqual(['HOT DELIVERY']);
    m.fail('test');
    step(sim, 0.1);
    teleport(sim, sim.player.pos.x + 20, sim.player.pos.z);
    press(sim);
    stepUntil(sim, () => objective(sim) === 'Collect the package', 1);
    expect(sim.missions.active!.retrying).toBe(true);
    expect(big.filter((b) => b.style === 'title')).toHaveLength(1);
  });

  it('a failure in a vehicle says to get out to retry: E is the horn there', () => {
    const sim = setup(['wheels']);
    const big = record(sim, 'big');
    const m = collectParcel(sim);
    const lane = sim.roads.nearestLane(sim.player.pos.x, sim.player.pos.z).lane;
    placeInCar(sim, sim.spawnVehicle('sedan', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading));
    m.setTimer('DELIVERY', 0.05, 'The buyer walked.');
    step(sim, 0.2);
    expect(big.at(-1)).toEqual(expect.objectContaining({ text: 'MISSION FAILED', sub: 'The buyer walked. - Get out of the vehicle to retry' }));
    expect(sim.interactions.prompt()).toBe('Get out of the vehicle to retry "Hot Delivery"');
  });

  it('a failure takes the line being said off the screen at once; with no line up it says nothing', () => {
    const sim = setup(['wheels']);
    const subs = record(sim, 'subtitle');
    startMission(sim, 'delivery');
    step(sim, 0.5);
    expect(subs.map((s) => s.speaker)).toEqual(['Mama Lou']);
    sim.missions.abandon();
    expect(subs.at(-1)).toEqual({ speaker: '', text: '', duration: 0 });
    step(sim, 0.1);
    expect(subs).toHaveLength(2);
    // Past the intro nothing is being said: a failure adds no line.
    const m = startMission(sim, 'delivery');
    stepUntil(sim, () => objective(sim) === 'Collect the package', 20);
    const n = subs.length;
    m.fail('test');
    step(sim, 0.1);
    expect(subs).toHaveLength(n);
  });

  it('restores the pistol ammo of the pre-mission loadout on a Repo Man retry', () => {
    const sim = setup(before('repo'));
    const inv = sim.player.inventory;
    inv.give('pistol', 150);
    inv.current = 'fists';
    const m = startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    expect(inv.total('pistol')).toBe(150);
    // Shots fired and ammo picked up during the attempt.
    inv.slots.get('pistol')!.clip -= 5;
    inv.give('pistol', 30);
    sim.player.armor = 0;
    sim.combat.explodeVehicle(m.vehicles[0]!);
    step(sim, 0.5);
    expect(m.failedReason).toBe('The Nightjar was wrecked.');
    expect(inv.total('pistol')).toBe(175);
    // Off Lou's marker, which would start the mission afresh.
    teleport(sim, sim.player.pos.x + 20, sim.player.pos.z);
    press(sim);
    stepUntil(sim, () => sim.missions.active?.retrying === true && objective(sim) === 'Steal the Nightjar GT', 2);
    expect(inv.total('pistol')).toBe(150);
    expect(inv.current).toBe('fists');
  });

  it('gives back weapons a bust took, keeps what was bought after the failure, and grants mission weapons afresh', () => {
    const sim = setup(before('repo'));
    sim.cheats.godMode = false;
    const inv = sim.player.inventory;
    inv.give('smg', 90);
    const m = startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    expect(inv.total('pistol')).toBe(72);
    inv.slots.get('pistol')!.clip = 0;
    // The police keep the guns only from 2 stars (police P62).
    sim.wanted.setLevel(2);
    sim.bustPlayer();
    step(sim, 0.1);
    expect(m.failedReason).toBe('You got busted.');
    // The offer opens at the respawn, not before.
    expect(sim.missions.retryOffer()).toBeNull();
    step(sim, 5.5);
    expect(inv.has('smg')).toBe(false);
    expect(sim.missions.retryOffer()?.id).toBe('repo');
    sim.progress.addMoney(5000);
    expect(sim.interactions.buy('buy:shotgun')).toBeNull();
    const shotgun = inv.total('shotgun');
    press(sim);
    stepUntil(sim, () => sim.missions.active?.retrying === true && objective(sim) === 'Steal the Nightjar GT', 2);
    expect(inv.total('smg')).toBe(90);
    expect(inv.total('shotgun')).toBe(shotgun);
    expect(inv.total('pistol')).toBe(72);
  });

  it('does not raise the mission pistol above the grant when Repo Man is restarted from its marker', () => {
    const sim = setup(before('repo'));
    const inv = sim.player.inventory;
    const m = startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    inv.slots.get('pistol')!.clip -= 5;
    sim.combat.explodeVehicle(m.vehicles[0]!);
    step(sim, 0.5);
    expect(sim.missions.active).toBeNull();
    expect(inv.total('pistol')).toBe(67);
    // The marker beats the retry offer, and starts the mission from scratch.
    startMission(sim, 'repo');
    expect(sim.missions.active!.retrying).toBe(false);
    expect(sim.missions.retryOffer()).toBeNull();
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    expect(inv.total('pistol')).toBe(72);
  });

  it('resumes The Big Score at the getaway car after dying past the vault', () => {
    const sim = setup(before('big_score'));
    const spots = missionSpots(sim.world);
    sim.missions.noBust = true;
    const messages = record(sim, 'message');
    const m = startMission(sim, 'big_score');
    stepUntil(sim, () => objective(sim) === 'Go to the First Azura Bank', 20);
    teleport(sim, spots.bank.x, spots.bank.z);
    stepUntil(sim, () => objective(sim) === 'Get in the getaway car', 40, 1 / 30);
    expect(m.checkpointReached).toBe(1);
    expect(messages.some((e) => e.text === 'Checkpoint reached')).toBe(true);
    sim.cheats.godMode = false;
    sim.combat.damageCharacter(sim.player, 999, null, 'fall', 0, -1, 0);
    step(sim, 0.1);
    expect(m.failedReason).toBe('You got wasted.');
    expect(sim.missions.retryOffer()).toBeNull();
    step(sim, 6);
    expect(sim.player.alive).toBe(true);
    expect(sim.missions.retryOffer()?.id).toBe('big_score');
    press(sim);
    stepUntil(sim, () => objective(sim) === 'Get in the getaway car', 2);
    expect(sim.wanted.level).toBeGreaterThanOrEqual(4);
    expect(dist(sim.player.pos, spots.bank)).toBeLessThan(15);
    expect(sim.player.inventory.has('rifle')).toBe(true);
    expect(sim.missions.active!.vehicles[0]!.kind).toBe('sports');
  });

  it('resumes Heatwave at losing the cops after dying past the third van', () => {
    const sim = setup(before('heatwave'));
    const m = startMission(sim, 'heatwave');
    stepUntil(sim, () => objective(sim).startsWith('Destroy the vans'), 20);
    for (const v of [...m.vehicles]) {
      sim.combat.damageVehicle(v, 99999, sim.player, 'explosion');
      step(sim, 0.2);
    }
    stepUntil(sim, () => objective(sim) === 'Lose the cops', 3);
    expect(m.checkpointReached).toBe(1);
    sim.cheats.godMode = false;
    sim.combat.damageCharacter(sim.player, 999, null, 'fall', 0, -1, 0);
    step(sim, 6);
    press(sim);
    stepUntil(sim, () => objective(sim) === 'Lose the cops', 2);
    expect(sim.wanted.level).toBe(2);
    expect(sim.missions.active!.vehicles.length).toBe(0);
  });

  it('arms no offer for an abandoned mission, and lets offers lapse after 20 s', () => {
    const sim = setup(['wheels']);
    const big = record(sim, 'big');
    startMission(sim, 'delivery');
    sim.missions.abandon();
    step(sim, 0.1);
    expect(big.at(-1)!.sub).toBe('Mission abandoned.');
    expect(sim.missions.retryOffer()).toBeNull();
    teleport(sim, sim.player.pos.x + 20, sim.player.pos.z);
    expect(sim.interactions.prompt()).toBeNull();

    startMission(sim, 'delivery').fail('test');
    step(sim, 0.1);
    teleport(sim, sim.player.pos.x + 20, sim.player.pos.z);
    expect(sim.missions.retryOffer()?.id).toBe('delivery');
    step(sim, RETRY_WINDOW - 0.6);
    expect(sim.interactions.prompt()).toBe('Press E to retry "Hot Delivery"');
    step(sim, 1);
    expect(sim.missions.retryOffer()).toBeNull();
    expect(sim.interactions.prompt()).toBeNull();
    press(sim);
    step(sim, 1);
    expect(sim.missions.active).toBeNull();
  });

  it('asks to lose the cops or leave the vehicle first, and lets a marker underfoot win', () => {
    const sim = setup(['wheels']);
    startMission(sim, 'delivery').fail('test');
    step(sim, 0.1);
    // Standing on Lou's marker: the marker's own prompt and action.
    expect(sim.interactions.current()?.kind).toBe('mission');
    expect(sim.interactions.prompt()).toBe('Press E to start "Hot Delivery"');
    teleport(sim, sim.player.pos.x + 20, sim.player.pos.z);
    sim.wanted.setLevel(1);
    expect(sim.interactions.prompt()).toBe('Lose the cops before retrying.');
    press(sim);
    step(sim, 1);
    expect(sim.missions.active).toBeNull();
    sim.wanted.clear();
    const lane = sim.roads.nearestLane(sim.player.pos.x, sim.player.pos.z).lane;
    const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading);
    placeInCar(sim, car);
    expect(sim.interactions.prompt()).toBe('Get out of the vehicle to retry "Hot Delivery"');
    expect(sim.missions.retryNow()).toBe(false);
    sim.playerCtl.ejectPlayer(true);
    step(sim, 0.2);
    expect(sim.interactions.prompt()).toBe('Press E to retry "Hot Delivery"');
  });

  it('offers a retry swallowed by a death during the fade again after the respawn', () => {
    const sim = setup(['wheels']);
    sim.cheats.godMode = false;
    startMission(sim, 'delivery').fail('test');
    step(sim, 0.1);
    teleport(sim, sim.player.pos.x + 20, sim.player.pos.z);
    press(sim);
    expect(sim.controlLock).toBeGreaterThan(1);
    sim.combat.damageCharacter(sim.player, 999, null, 'fall', 0, -1, 0);
    step(sim, 1);
    expect(sim.missions.active).toBeNull();
    expect(sim.missions.retryOffer()).toBeNull();
    step(sim, 5);
    expect(sim.player.alive).toBe(true);
    expect(sim.missions.retryOffer()?.id).toBe('delivery');
    press(sim);
    stepUntil(sim, () => objective(sim) === 'Collect the package', 1);
  });

  it('asks to lose the cops before anything else, in a vehicle too', () => {
    const sim = setup(['wheels']);
    startMission(sim, 'delivery').fail('test');
    step(sim, 0.1);
    const lane = sim.roads.nearestLane(sim.player.pos.x + 20, sim.player.pos.z).lane;
    placeInCar(sim, sim.spawnVehicle('sedan', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading));
    sim.wanted.setLevel(1);
    expect(sim.interactions.prompt()).toBe('Lose the cops before retrying.');
  });

  it('skips a line of dialogue on a fresh E press once it has been up for 0.4 s', () => {
    const sim = setup(['wheels']);
    const subs = record(sim, 'subtitle');
    startMission(sim, 'delivery');
    const lines = () => subs.filter((s) => s.text);
    expect(lines().length).toBe(1);
    step(sim, 0.2);
    press(sim);
    expect(lines().length).toBe(1);
    step(sim, 0.3);
    press(sim);
    expect(lines().length).toBe(2);
    // Held down, the key does not skip again.
    step(sim, 0.5, input({ interact: true }));
    expect(lines().length).toBe(2);
    step(sim, 0.1);
    press(sim);
    expect(lines().length).toBe(2);
    // Skipping the last line clears it at once and goes on with the mission.
    expect(subs.at(-1)).toEqual({ speaker: '', text: '', duration: 0 });
    expect(objective(sim)).toBe('Collect the package');
  });

  it('says when a line can be skipped (0.4 s into it), so the horn key can skip it in a vehicle', () => {
    const sim = setup(['wheels']);
    const subs = record(sim, 'subtitle');
    startMission(sim, 'delivery');
    expect(sim.missions.lineSkippable).toBe(false);
    step(sim, 0.3);
    expect(sim.missions.lineSkippable).toBe(false);
    step(sim, 0.15);
    expect(sim.missions.lineSkippable).toBe(true);
    // From a car as on foot: a fresh interact press skips it (Input sends one for E in a car only then).
    const lane = sim.roads.nearestLane(sim.player.pos.x, sim.player.pos.z).lane;
    placeInCar(sim, sim.spawnVehicle('sedan', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading));
    press(sim);
    expect(subs.filter((s) => s.text)).toHaveLength(2);
    expect(sim.missions.lineSkippable).toBe(false);
    step(sim, 0.45);
    expect(sim.missions.lineSkippable).toBe(true);
    step(sim, 0.1);
    press(sim);
    expect(sim.missions.lineSkippable).toBe(false);
    expect(objective(sim)).toBe('Collect the package');
  });

  it('tops mission weapons up instead of adding to them', () => {
    const sim = setup(['wheels']);
    const m = startMission(sim, 'delivery');
    const inv = sim.player.inventory;
    m.givePlayer('smg', 100);
    expect(inv.total('smg')).toBe(100);
    expect(inv.current).toBe('smg');
    inv.current = 'fists';
    m.givePlayer('smg', 100);
    expect(inv.total('smg')).toBe(100);
    inv.slots.get('smg')!.ammo -= 40;
    m.givePlayer('smg', 100);
    expect(inv.total('smg')).toBe(100);
    inv.give('smg', 50);
    m.givePlayer('smg', 100);
    expect(inv.total('smg')).toBe(150);
    expect(inv.current).toBe('fists');
  });
});

// --- P35: the staged missions ---------------------------------------------------

describe('staged missions', () => {
  it("Wheels: Lou calls when it starts away from her garage, and talks in person at it", () => {
    const sim = setup([]);
    const lou = missionSpots(sim.world).lou;
    const subs = record(sim, 'subtitle');
    const far = sim.world.findFreeSpot(lou.x + 100, lou.z, 0.5, 20)!;
    teleport(sim, far.x, far.z);
    expect(sim.missions.start('wheels')).toBe(true);
    step(sim, 0.1);
    expect(subs[0]!.speaker).toBe('Mama Lou (phone)');
    sim.missions.abandon();
    step(sim, 0.1);
    subs.length = 0;
    startMission(sim, 'wheels');
    expect(subs[0]!.speaker).toBe('Mama Lou');
  });

  it('Hot Delivery: a parcel to pick up on foot, a buyer at the drop and a timer that fits the drive', () => {
    const sim = setup(['wheels']);
    const spots = missionSpots(sim.world);
    const m = startMission(sim, 'delivery');
    const parcel = sim.pickups.find((p) => p.kind === 'parcel')!;
    expect(parcel.active).toBe(true);
    expect(dist(parcel.pos, spots.packagePickup)).toBeLessThan(0.01);
    expect(m.pickups).toContain(parcel);
    const buyer = sim.characters.find((c) => c.missionTag === 'delivery' && c.alive);
    expect(buyer).toBeDefined();
    // Beside the drop, outside its 4 m marker by more than a car's reach, facing it.
    const drop = spots.packageDrop;
    expect(dist(buyer!.pos, drop)).toBeGreaterThanOrEqual(4 + 3.1 + 0.4);
    expect(dist(buyer!.pos, drop)).toBeLessThanOrEqual(9);
    expect(Math.abs(wrapAngle(buyer!.heading - Math.atan2(drop.x - buyer!.pos.x, drop.z - buyer!.pos.z)))).toBeLessThan(0.01);
    stepUntil(sim, () => objective(sim) === 'Collect the package', 20);
    // Not from a car.
    const lane = sim.roads.nearestLane(spots.packagePickup.x, spots.packagePickup.z).lane;
    const car = sim.spawnVehicle('sedan', lane.sx, lane.sz, lane.heading);
    placeInCar(sim, car);
    teleport(sim, spots.packagePickup.x, spots.packagePickup.z);
    step(sim, 0.5);
    expect(parcel.active).toBe(true);
    sim.playerCtl.ejectPlayer(true);
    sim.removeVehicle(car);
    teleport(sim, spots.packagePickup.x, spots.packagePickup.z);
    stepUntil(sim, () => m.timer !== null, 2);
    expect(parcel.active).toBe(false);
    const seconds = m.timer!.endsAt - sim.time;
    expect(seconds).toBeGreaterThanOrEqual(59.9);
    expect(seconds).toBeLessThanOrEqual(90);
    // A Tiburones muscle car comes for it, from out of view.
    const tail = m.vehicles.find((v) => v.kind === 'muscle')!;
    expect(tail.driver?.role).toBe('gang');
    expect(tail.ai?.policy).toBe('chase');
    expect(tail.ai?.target).toBe(sim.player);
    const d = dist(tail.pos, sim.player.pos);
    expect(d).toBeGreaterThanOrEqual(80);
    expect(d).toBeLessThanOrEqual(140);
    expect(m.markers[0]!.label).toBe('Buyer');
    expect(m.markers.some((o) => o.vehicle === tail)).toBe(true);
    // The parcel goes with the mission.
    sim.missions.abandon();
    step(sim, 0.1);
    expect(parcel.removed).toBe(true);
    expect(sim.pickups.includes(parcel)).toBe(false);
  });

  it('Hot Delivery: the parcel is drawn over the objective beam it stands in, so it stays cardboard brown', async () => {
    // The marker view builds its textures on a 2D canvas: a stub that takes any call will do.
    const ctx2d = () => new Proxy({} as Record<string | symbol, unknown>, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop: () => undefined })), set: (o, k, v) => ((o[k] = v), true) });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: ctx2d }) });
    const THREE = await import('three');
    const { MarkerView } = await import('../../src/render/markers');
    const sim = setup(['wheels']);
    const m = startMission(sim, 'delivery');
    stepUntil(sim, () => objective(sim) === 'Collect the package', 20);
    const parcel = m.pickups[0]!;
    const view = new MarkerView();
    view.syncObjectives(m.markers, () => 0, 0);
    view.syncPickups(sim.pickups, 0, parcel.pos.x, parcel.pos.z);
    const meshes: Array<InstanceType<typeof THREE.Mesh>> = [];
    view.group.traverseVisible((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    const beam = meshes.find((o) => (o.material as InstanceType<typeof THREE.Material>).blending === THREE.AdditiveBlending)!;
    const box = meshes.find((o) => o.name === 'icon' && (o.material as InstanceType<typeof THREE.MeshStandardMaterial>).color.getHex() === 0x8a5a2c)!;
    expect(beam).toBeDefined();
    expect(box).toBeDefined();
    // Both in the transparent pass, the box after the beam: the beam's additive cyan never lands on it.
    expect((beam.material as InstanceType<typeof THREE.Material>).transparent).toBe(true);
    expect((box.material as InstanceType<typeof THREE.Material>).transparent).toBe(true);
    expect(box.renderOrder).toBeGreaterThan(beam.renderOrder);
  });

  it('Hot Delivery: the buyer does not deal with a tail in tow', () => {
    const sim = setup(['wheels']);
    const spots = missionSpots(sim.world);
    const m = collectParcel(sim);
    const objectives = record(sim, 'objective');
    const tail = m.vehicles.find((v) => v.kind === 'muscle')!;
    const drop = spots.packageDrop;
    teleport(sim, drop.x, drop.z);
    const lane = sim.roads.nearestLane(drop.x, drop.z).lane;
    const s = Math.min(lane.length - 5, Math.max(5, (drop.x - lane.sx) * lane.dx + (drop.z - lane.sz) * lane.dz));
    const near = sim.world.findFreeSpot(lane.sx + lane.dx * s, lane.sz + lane.dz * s, 2.5, 20)!;
    // Parked 30-60 m off, held there.
    const hold = () => {
      tail.pos.x = near.x;
      tail.pos.z = near.z;
      tail.vel.x = 0;
      tail.vel.z = 0;
      return input();
    };
    expect(dist(near, sim.player.pos)).toBeLessThan(60);
    step(sim, 2, hold);
    expect(sim.missions.active).toBe(m);
    expect(objective(sim)).toBe('Lose the tail');
    expect(m.markers.some((o) => o.label === 'Buyer')).toBe(true);
    sim.removeVehicle(tail);
    stepUntil(sim, () => objectives.at(-1)?.text === '', 3);
    expect(objectives.map((e) => e.text)).toEqual(['Lose the tail', 'Deliver the package to Hillcrest', '']);
    stepUntil(sim, () => sim.missions.active === null, 30);
    expect(sim.progress.missionsDone).toContain('delivery');
  });

  it('Hot Delivery is not failed by the buyer dying after the drop', () => {
    const sim = setup(['wheels']);
    const spots = missionSpots(sim.world);
    const m = collectParcel(sim);
    const tail = m.vehicles.find((v) => v.kind === 'muscle');
    if (tail) sim.removeVehicle(tail);
    teleport(sim, spots.packageDrop.x, spots.packageDrop.z);
    stepUntil(sim, () => m.objectiveText === '', 2);
    const buyer = m.characters.find((c) => c.missionTag === 'delivery')!;
    sim.combat.damageCharacter(buyer, 500, null, 'bullet', 0, 0, 1);
    stepUntil(sim, () => sim.missions.active === null, 30);
    expect(m.failedReason).toBeNull();
    expect(sim.progress.missionsDone).toContain('delivery');
  });

  it('Hot Delivery: driving into the marker never kills the buyer, from any side at 12 or 18 m/s', () => {
    // A fresh mission per run on one world, started as a retry (no intro), its tail removed.
    const w = new StaticWorld();
    const spots = missionSpots(w);
    const drop = spots.packageDrop;
    const report: string[] = [];
    let excused = 0;
    let stoppedRuns = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      for (const speed of [12, 18]) {
        w.resetBroken();
        const sim = new Sim({ world: w, ambient: false, police: false });
        sim.progress.markDone('wheels');
        sim.cheats.godMode = true;
        step(sim, 0.05);
        expect(sim.missions.start('delivery', { retrying: true })).toBe(true);
        const m = sim.missions.active!;
        step(sim, 0.05);
        teleport(sim, spots.packagePickup.x, spots.packagePickup.z);
        stepUntil(sim, () => m.timer !== null, 2);
        for (const v of m.vehicles.filter((v) => v.kind === 'muscle')) sim.removeVehicle(v);
        const buyer = m.characters.find((c) => c.missionTag === 'delivery')!;
        const health = buyer.health;
        // A sedan 15 m out, driven straight at the drop and kept at speed.
        const sx = drop.x + Math.sin(a) * 15;
        const sz = drop.z + Math.cos(a) * 15;
        const heading = Math.atan2(drop.x - sx, drop.z - sz);
        const car = sim.spawnVehicle('sedan', sx, sz, heading);
        placeInCar(sim, car);
        car.vel.x = Math.sin(heading) * speed;
        car.vel.z = Math.cos(heading) * speed;
        let hitAt = -1;
        for (let t = 0; t < 3 && sim.missions.active === m && m.objectiveText !== ''; t += 1 / 60) {
          sim.update(1 / 60, input({ throttle: car.speed < speed ? 1 : 0 }));
          if (hitAt < 0 && buyer.health < health) hitAt = dist(car.pos, drop);
        }
        const delivered = sim.missions.active === m && m.objectiveText === '';
        // A tree on the way in stops the car short of the marker: no drive-in from that side.
        const stopped = !delivered && m.failedReason === null && car.speed < 1;
        if (stopped) stoppedRuns++;
        // Excused only where he stands in the car's way before it reaches the marker: its corridor (half
        // its width plus his own 0.4 m and a margin) runs through his spot, outside the marker.
        const b = buyer.pos;
        const along = (b.x - sx) * Math.sin(heading) + (b.z - sz) * Math.cos(heading);
        const off = Math.abs((b.x - sx) * Math.cos(heading) - (b.z - sz) * Math.sin(heading));
        const inTheWay = dist(b, drop) > 4 && along > 0 && along < 15 && off < car.halfW + 0.4 + 0.3;
        if (inTheWay) excused++;
        report.push(`a=${a.toFixed(2)} v=${speed}: delivered ${delivered} failed ${m.failedReason} stopped ${stopped} buyer hit at ${hitAt.toFixed(1)} m in the way ${inTheWay}`);
        if (!inTheWay) {
          expect(buyer.health, report.join('\n')).toBe(health);
          expect(m.failedReason, report.join('\n')).toBe(null);
          if (!stopped) expect(delivered, report.join('\n')).toBe(true);
        }
      }
    }
    // Only the line through his own spot (both speeds), and at most one side blocked by a tree.
    expect(excused, report.join('\n')).toBeLessThanOrEqual(2 * 2);
    expect(stoppedRuns, report.join('\n')).toBeLessThanOrEqual(2 * 2);
  });

  it('Hot Delivery fails when the buyer dies', () => {
    const sim = setup(['wheels']);
    const m = startMission(sim, 'delivery');
    const buyer = sim.characters.find((c) => c.missionTag === 'delivery')!;
    sim.combat.damageCharacter(buyer, 500, null, 'bullet', 0, 0, 1);
    step(sim, 0.1);
    expect(m.failedReason).toBe('The buyer is dead.');
  });

  it('Repo Man: two Tiburones cars come after the Nightjar once it is stolen', () => {
    const sim = setup(before('repo'));
    const m = startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    const car = m.vehicles[0]!;
    expect(m.vehicles.length).toBe(1);
    enterVehicle(sim, car);
    stepUntil(sim, () => objective(sim).startsWith('Bring'), 2);
    const chasers = m.vehicles.slice(1);
    expect(chasers.map((v) => v.kind).sort()).toEqual(['muscle', 'sedan']);
    for (const v of chasers) {
      expect(v.driver?.role).toBe('gang');
      expect(v.ai?.policy).toBe('chase');
      expect(v.ai?.target).toBe(sim.player);
      const d = dist(v.pos, car.pos);
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(160);
      expect(m.markers.some((o) => o.vehicle === v)).toBe(true);
    }
    // The GPS keeps leading to the garage.
    expect(m.markers[0]!.label).toBe("Lou's garage");
    // A wrecked chaser loses its marker.
    sim.combat.explodeVehicle(chasers[0]!);
    step(sim, 0.1);
    expect(m.markers.some((o) => o.vehicle === chasers[0])).toBe(false);
  });

  it('Loose Lips: Benny drives to the SAPD, a good way off, and sings if he gets there', () => {
    for (const seed of [1, 2, 3]) {
      const sim = setup(before('loose_lips'), { police: false, seed });
      const police = sim.world.layout.pois.find((p) => p.id === 'police')!;
      const m = startMission(sim, 'loose_lips');
      stepUntil(sim, () => objective(sim) === 'Take out Benny', 20);
      const benny = m.characters[0]!;
      const car = benny.vehicle!;
      expect(car.ai!.policy).toBe('route');
      expect(dist(car.ai!.dest!, police)).toBeLessThanOrEqual(30);
      expect(m.counter).toMatch(/^BENNY TO SAPD \d+ m$/);
      expect(car.ai!.routeRemaining()).toBeGreaterThanOrEqual(300);
      if (seed === 1) {
        // Left alone (the player trailing far behind him, unnoticed), he gets there.
        for (let t = 0; t < 150 && sim.missions.active; t += 1 / 30) {
          const d = dist(sim.player.pos, car.pos);
          if (d > 250 || d < 100) teleport(sim, car.pos.x - Math.sin(car.heading) * 150, car.pos.z - Math.cos(car.heading) * 150);
          sim.update(1 / 30, input());
        }
        expect(m.failedReason).toBe('Benny is singing to the SAPD.');
      } else {
        const lane = sim.roads.nearestLane(police.x, police.z).lane;
        const s = (police.x - lane.sx) * lane.dx + (police.z - lane.sz) * lane.dz;
        const along = s > lane.length / 2 ? s - 19 : s + 19;
        parkIn(sim, car, lane.sx + lane.dx * along, lane.sz + lane.dz * along);
        step(sim, 0.1);
        expect(m.failedReason).toBe('Benny is singing to the SAPD.');
      }
    }
  });

  it('Loose Lips: once Benny notices the player he flees and the SAPD counter goes', () => {
    const sim = setup(before('loose_lips'), { police: false });
    const m = startMission(sim, 'loose_lips');
    stepUntil(sim, () => objective(sim) === 'Take out Benny', 20);
    const car = m.characters[0]!.vehicle!;
    teleport(sim, car.pos.x + 20, car.pos.z + 20);
    step(sim, 0.5);
    expect(car.ai!.policy).toBe('flee');
    expect(car.ai!.dest).toBeNull();
    expect(car.ai!.target).toBe(sim.player);
    expect(m.counter).toBeNull();
  });

  it('Heatwave: two SMG guards per van, and the last van runs', () => {
    const sim = setup(before('heatwave'));
    const m = startMission(sim, 'heatwave');
    stepUntil(sim, () => objective(sim).startsWith('Destroy the vans'), 20);
    const guards = m.characters.filter((c) => c.role === 'gang' && c.inventory.current === 'smg' && c.brain?.mode === 'guard');
    expect(guards.length).toBeGreaterThanOrEqual(6);
    for (const v of m.vehicles) expect(guards.filter((g) => dist(g.pos, v.pos) < 8).length).toBe(2);
    const messages = record(sim, 'message');
    const [a, b, c] = m.vehicles;
    sim.combat.damageVehicle(a!, 99999, sim.player, 'explosion');
    sim.combat.damageVehicle(b!, 99999, sim.player, 'explosion');
    step(sim, 0.2);
    expect(c!.driver?.role).toBe('gang');
    expect(c!.ai?.policy).toBe('flee');
    expect(c!.ai?.target).toBe(sim.player);
    expect(messages.some((e) => e.text.includes('run for it'))).toBe(true);
    const p0 = { x: c!.pos.x, z: c!.pos.z };
    step(sim, 4, input(), 1 / 30);
    expect(dist(c!.pos, p0)).toBeGreaterThan(8);
  });

  it('Heatwave: only the crew still by the last van piles in', () => {
    const sim = setup(before('heatwave'));
    const m = startMission(sim, 'heatwave');
    stepUntil(sim, () => objective(sim).startsWith('Destroy the vans'), 20);
    const [a, b, c] = m.vehicles;
    const crew = m.characters.filter((g) => g.role === 'gang' && dist(g.pos, c!.pos) < 8);
    expect(crew.length).toBe(2);
    // One of them went after the player and is far off now.
    const away = sim.world.findFreeSpot(c!.pos.x + 40, c!.pos.z, 0.5, 20)!;
    crew[0]!.pos.x = away.x;
    crew[0]!.pos.z = away.z;
    sim.combat.damageVehicle(a!, 99999, sim.player, 'explosion');
    sim.combat.damageVehicle(b!, 99999, sim.player, 'explosion');
    step(sim, 0.2);
    expect(c!.driver).toBe(crew[1]);
    expect(crew[0]!.vehicle).toBeNull();
    expect(c!.passengers.filter(Boolean).length).toBe(0);
  });

  it('The Big Score: guards at the door, police answering the alarm and SWAT halfway', () => {
    const sim = setup(before('big_score'));
    const spots = missionSpots(sim.world);
    sim.missions.noBust = true;
    const m = startMission(sim, 'big_score');
    const guards = m.characters.filter((c) => c.missionTag === 'enemy');
    expect(guards.length).toBe(2);
    for (const g of guards) {
      expect(g.role).toBe('mission');
      expect(g.brain?.hostile).toBe(true);
      expect(g.inventory.current).toBe('pistol');
      expect(dist(g.pos, spots.bank)).toBeLessThan(8);
    }
    stepUntil(sim, () => objective(sim) === 'Go to the First Azura Bank', 20);
    teleport(sim, spots.bank.x, spots.bank.z);
    stepUntil(sim, () => objective(sim).startsWith('Hold'), 2);
    let shots = 0;
    sim.events.on('shot', (e) => {
      const s = e.shooter;
      if (!s || s.isPlayer || !(s.isLaw || s.brain?.hostile)) return;
      const pp = sim.player.pos;
      const tx = e.tx - e.fx;
      const tz = e.tz - e.fz;
      const px = pp.x - e.fx;
      const pz = pp.z - e.fz;
      if ((tx * px + tz * pz) / ((Math.hypot(tx, tz) || 1) * (Math.hypot(px, pz) || 1)) > 0.9) shots++;
    });
    step(sim, 15, input(), 1 / 30);
    const armed = sim.characters.filter((c) => !c.removed && c.alive && (c.isLaw || c.brain?.hostile) && c.inventory.current !== 'fists' && dist(c.pos, sim.player.pos) <= 45);
    expect(armed.length).toBeGreaterThanOrEqual(3);
    const responders = sim.characters.filter((c) => c.isLaw && c.owner === 'police' && !c.brain?.car);
    expect(responders.length).toBeGreaterThanOrEqual(2);
    for (const c of responders) {
      expect(c.inventory.infinite).toBe(true);
      expect(c.inventory.current).toBe('pistol');
      expect(c.brain!.brave).toBe(true);
      expect(c.brain!.accuracy).toBe(0.45);
    }
    expect(sim.vehicles.some((v) => v.kind === 'swat' && v.owner === 'police')).toBe(true);
    stepUntil(sim, () => objective(sim) === 'Get in the getaway car', 30, 1 / 30);
    expect(shots).toBeGreaterThanOrEqual(5);
    // At most a handful of officers answer the alarm at once.
    expect(sim.characters.filter((c) => c.isLaw && !c.removed && c.alive && !c.brain?.car).length).toBeLessThanOrEqual(6 + 4);
  });

  it('spawns no responders while the police are off', () => {
    const sim = setup(before('big_score'), { police: false });
    const spots = missionSpots(sim.world);
    startMission(sim, 'big_score');
    stepUntil(sim, () => objective(sim) === 'Go to the First Azura Bank', 20);
    teleport(sim, spots.bank.x, spots.bank.z);
    stepUntil(sim, () => objective(sim) === 'Get in the getaway car', 40, 1 / 30);
    expect(sim.characters.some((c) => c.isLaw)).toBe(false);
  });
});

// --- P57a: finished objectives clear ---------------------------------------------

describe('finished objectives clear', () => {
  it('clears the objective when goTo arrives', () => {
    const sim = setup([]);
    const spots = missionSpots(sim.world);
    const objectives = record(sim, 'objective');
    const m = startMission(sim, 'wheels');
    stepUntil(sim, () => m.objectiveText === 'Steal a car', 20);
    const lane = sim.roads.nearestLane(spots.lou.x, spots.lou.z).lane;
    const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 20, lane.sz + lane.dz * 20, lane.heading);
    enterVehicle(sim, car);
    stepUntil(sim, () => m.objectiveText.startsWith('Drive'), 2);
    parkIn(sim, car, spots.louBay.x, spots.louBay.z);
    stepUntil(sim, () => m.objectiveText === '', 2);
    expect(objectives.at(-1)!.text).toBe('');
    // ...and only on arrival: an aborted goTo (Repo Man, out of the car) keeps its objective going.
  });

  it('keeps the objective when goTo is aborted', () => {
    const sim = setup(before('repo'));
    const m = startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    const car = m.vehicles[0]!;
    enterVehicle(sim, car);
    stepUntil(sim, () => objective(sim).startsWith('Bring'), 2);
    const objectives = record(sim, 'objective');
    expect(sim.playerCtl.exitVehicle(false)).toBe(true);
    step(sim, 0.1);
    expect(objectives.map((e) => e.text)).toEqual(['Get back in the Nightjar']);
  });
});
