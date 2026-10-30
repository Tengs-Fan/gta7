// Round 2 fix pass 3, missions cluster: a mission is passed once its goal is met, Lou takes no wanted car, the
// finale stops the car on the Marina deck and puts its fire out, retries keep what was gained between attempts,
// and the prompts, the safehouse, the gun shop and the taxi fare behave at the edges.

import { describe, expect, it } from 'vitest';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import type { MissionCtx } from '../../src/sim/missions/runner';
import { RETRY_WINDOW } from '../../src/sim/missions/runner';
import { missionSpots } from '../../src/sim/missions/spots';
import { parseSave, serialize } from '../../src/sim/progress';
import type { Sim, SimOptions } from '../../src/sim/sim';
import { STAR_HEAT } from '../../src/sim/wanted';
import { input, makeSim, placeInCar, step, teleport, legacyLane } from './helpers';

// --- helpers ------------------------------------------------------------------

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

/** Records the order of some events, as 'type' strings. */
function sequence(sim: Sim, types: Array<keyof SimEvents>): string[] {
  const out: string[] = [];
  for (const t of types) sim.events.on(t, () => out.push(t));
  return out;
}

/** Plays Wheels up to Lou's garage, in a sedan stolen near her: the objective is to drive it in. */
function wheelsToGarage(sim: Sim): { m: MissionCtx; car: Vehicle } {
  const spots = missionSpots(sim.world);
  const m = startMission(sim, 'wheels');
  stepUntil(sim, () => objective(sim) === 'Steal a car', 20);
  const lane = sim.roads.nearestLane(spots.lou.x, spots.lou.z).lane;
  const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 20, lane.sz + lane.dz * 20, lane.heading);
  enterVehicle(sim, car);
  stepUntil(sim, () => objective(sim).startsWith('Drive'), 2);
  return { m, car };
}

/** Plays Hot Delivery up to the parcel being collected, its tail taken away. */
function collectParcel(sim: Sim): MissionCtx {
  const m = startMission(sim, 'delivery');
  stepUntil(sim, () => objective(sim) === 'Collect the package', 20);
  const pick = missionSpots(sim.world).packagePickup;
  teleport(sim, pick.x, pick.z);
  stepUntil(sim, () => m.timer !== null, 2);
  for (const v of m.vehicles.filter((v) => v.kind === 'muscle')) sim.removeVehicle(v);
  return m;
}

/** Off the contact's marker (which would start the mission afresh), where E takes the retry. */
function offMarker(sim: Sim): void {
  const p = sim.player.pos;
  const spot = sim.world.findFreeSpot(p.x + 20, p.z, 0.5, 10)!;
  teleport(sim, spot.x, spot.z);
}

/** Takes the retry on offer with E (once a fade still running has given the controls back), until it runs. */
function takeRetry(sim: Sim, objectiveText: string): void {
  stepUntil(sim, () => sim.controlLock === 0, 2);
  press(sim);
  stepUntil(sim, () => sim.missions.active?.retrying === true && objective(sim) === objectiveText, 2);
}

// --- a mission is passed once its goal is met ----------------------------------------

describe('a mission is passed once its goal is met', () => {
  it('Wheels: a bust during Lou\'s closing line pays and marks it done; the autosave waits for the respawn and its bail', () => {
    const sim = setup([]);
    const money = sim.progress.money;
    const { car } = wheelsToGarage(sim);
    const spots = missionSpots(sim.world);
    parkIn(sim, car, spots.louBay.x, spots.louBay.z);
    const subs = record(sim, 'subtitle');
    stepUntil(sim, () => subs.some((s) => s.text.startsWith('Not bad')), 5);
    const ended = record(sim, 'missionEnded');
    const big = record(sim, 'big');
    const order = sequence(sim, ['respawn', 'saveRequested']);
    let savedMoney = -1;
    sim.events.on('saveRequested', () => (savedMoney = sim.progress.money));
    sim.bustPlayer();
    step(sim, 0.1);
    expect(sim.missions.active).toBeNull();
    expect(ended).toEqual([{ id: 'wheels', passed: true }]);
    expect(sim.progress.missionsDone).toContain('wheels');
    expect(big.map((b) => b.text)).toEqual(['BUSTED', 'MISSION PASSED']);
    expect(sim.progress.money).toBe(money + 500);
    // Lou's line is cut, not left running over BUSTED.
    expect(subs.at(-1)).toEqual({ speaker: '', text: '', duration: 0 });
    // Not saved while he is down: the bail and the respawn come first.
    expect(order).toEqual([]);
    step(sim, 6);
    expect(order).toEqual(['respawn', 'saveRequested']);
    expect(savedMoney).toBe(money + 500 - 100);
    expect(sim.progress.money).toBe(savedMoney);
    expect(sim.missions.retryOffer()).toBeNull();
  });

  it('Hot Delivery: wasted during Lou\'s closing line, the delivery still pays', () => {
    const sim = setup(['wheels'], { police: false });
    sim.cheats.godMode = false;
    const money = sim.progress.money;
    const m = collectParcel(sim);
    const drop = missionSpots(sim.world).packageDrop;
    teleport(sim, drop.x, drop.z);
    // Delivered: the objective clears, Lou's line follows.
    stepUntil(sim, () => objective(sim) === '' && m.markers.length === 0, 2);
    const ended = record(sim, 'missionEnded');
    sim.combat.damageCharacter(sim.player, 999, null, 'fall', 0, -1, 0);
    step(sim, 0.1);
    expect(ended).toEqual([{ id: 'delivery', passed: true }]);
    expect(m.failedReason).toBeNull();
    expect(sim.progress.missionsDone).toContain('delivery');
    expect(sim.progress.money).toBe(money + 1200);
  });

  it('Loose Lips: a bust during Dex\'s closing line (Benny\'s murder brings a star) still passes it', () => {
    const sim = setup(before('loose_lips'));
    const money = sim.progress.money;
    const m = startMission(sim, 'loose_lips');
    stepUntil(sim, () => objective(sim) === 'Take out Benny', 20);
    const benny = m.characters[0]!;
    sim.combat.damageCharacter(benny, 500, sim.player, 'bullet', 0, 0, 1);
    const subs = record(sim, 'subtitle');
    stepUntil(sim, () => subs.some((s) => s.speaker === 'Dex Moreau'), 3);
    expect(sim.wanted.level).toBeGreaterThanOrEqual(1);
    const ended = record(sim, 'missionEnded');
    sim.bustPlayer();
    step(sim, 0.1);
    expect(ended).toEqual([{ id: 'loose_lips', passed: true }]);
    expect(sim.progress.money).toBe(money + 4000);
  });

  it('an abandon past the goal ends it passed too; before the goal, a bust still fails it', () => {
    const sim = setup(['wheels'], { police: false });
    const m = collectParcel(sim);
    const ended = record(sim, 'missionEnded');
    sim.bustPlayer();
    step(sim, 0.1);
    expect(m.failedReason).toBe('You got busted.');
    expect(ended).toEqual([{ id: 'delivery', passed: false }]);
    step(sim, 6);
    const again = collectParcel(sim);
    const drop = missionSpots(sim.world).packageDrop;
    teleport(sim, drop.x, drop.z);
    stepUntil(sim, () => objective(sim) === '' && again.markers.length === 0, 2);
    // Its timer is over with the delivery.
    expect(again.timer).toBeNull();
    sim.missions.abandon();
    step(sim, 0.1);
    expect(ended.at(-1)).toEqual({ id: 'delivery', passed: true });
  });
});

// --- Lou takes no car with the police after it -----------------------------------------

describe("Lou's garage takes no wanted car", () => {
  it('Wheels: the bay holds the car while wanted, the objective says to lose the cops, and takes it once they are lost', () => {
    const sim = setup([], { police: false });
    const spots = missionSpots(sim.world);
    const money = sim.progress.money;
    const { m, car } = wheelsToGarage(sim);
    const objectives = record(sim, 'objective');
    sim.wanted.setLevel(1);
    step(sim, 0.1);
    expect(objective(sim)).toBe('Lose the cops first');
    parkIn(sim, car, spots.louBay.x, spots.louBay.z);
    // Held there at 1 star: no hand-over, the player stays in his car, the marker stays.
    for (let i = 0; i < 120; i++) {
      sim.wanted.setLevel(1);
      sim.update(1 / 60, input());
    }
    expect(sim.missions.active).toBe(m);
    expect(sim.player.vehicle).toBe(car);
    expect(m.markers.some((o) => o.label === "Lou's garage")).toBe(true);
    expect(objective(sim)).toBe('Lose the cops first');
    sim.wanted.clear();
    stepUntil(sim, () => sim.missions.active === null, 15);
    expect(objectives.map((e) => e.text)).toEqual(['Lose the cops first', "Drive it into Lou's garage", '']);
    expect(sim.progress.missionsDone).toContain('wheels');
    expect(sim.progress.money).toBe(money + 500);
  });

  it('Repo Man: the Nightjar is held at the bay while wanted too', () => {
    const sim = setup(before('repo'), { police: false });
    const spots = missionSpots(sim.world);
    const m = startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    const car = m.vehicles[0]!;
    enterVehicle(sim, car);
    stepUntil(sim, () => objective(sim).startsWith('Bring'), 2);
    sim.wanted.setLevel(2);
    parkIn(sim, car, spots.louBay.x, spots.louBay.z);
    for (let i = 0; i < 90; i++) {
      sim.wanted.setLevel(2);
      sim.update(1 / 60, input());
    }
    expect(sim.player.vehicle).toBe(car);
    expect(m.markers.some((o) => o.label === "Lou's garage")).toBe(true);
    expect(objective(sim)).toBe('Lose the cops first');
    sim.wanted.clear();
    // Taken once the stars are gone: the hand-over gets him out.
    stepUntil(sim, () => sim.player.vehicle === null, 4);
    expect(sim.missions.active).toBe(m);
  });
});

// --- The Big Score's finale ---------------------------------------------------------------

describe("The Big Score's finale at the Marina", () => {
  /** The finale from its getaway car, the player in it on the Marina deck `back` m short of the marker's centre. */
  function finale(opts: SimOptions = {}, back = 60): { sim: Sim; m: MissionCtx; car: Vehicle; marina: { x: number; z: number } } {
    const sim = setup(before('big_score'), { police: false, ...opts });
    expect(sim.missions.start('big_score', { resume: 1 })).toBe(true);
    step(sim, 0.1);
    const m = sim.missions.active!;
    const car = m.vehicles[0]!;
    placeInCar(sim, car);
    const marina = missionSpots(sim.world).marina;
    parkIn(sim, car, marina.x - back, marina.z);
    car.heading = Math.PI / 2;
    step(sim, 0.05);
    expect(objective(sim)).toBe('Escape to the Marina');
    return { sim, m, car, marina };
  }

  it('stops the getaway car on the deck at any arrival speed: no plunge off its end, and CHAPTER 1 COMPLETE follows MISSION PASSED', () => {
    for (const speed of [18, 30, 50]) {
      const { sim, car } = finale();
      const big = record(sim, 'big');
      let atEnd: { x: number; inWater: boolean; inCar: boolean; state: string } | null = null;
      sim.events.on('big', (e) => {
        if (e.text === 'CHAPTER 1 COMPLETE') atEnd = { x: car.pos.x, inWater: car.inWater, inCar: sim.player.vehicle === car, state: sim.player.state };
      });
      // Flat out down the deck, kept at `speed` until the marker locks the controls; then hands off.
      for (let t = 0; t < 3 && sim.controlLock === 0; t += 1 / 60) {
        car.vel.x = speed;
        car.vel.z = 0;
        sim.update(1 / 60, input({ throttle: 1 }));
      }
      expect(sim.controlLock, `speed ${speed}`).toBeGreaterThan(0);
      stepUntil(sim, () => sim.missions.active === null, 15);
      expect(atEnd, `speed ${speed}`).toEqual({ x: expect.any(Number), inWater: false, inCar: true, state: 'inVehicle' });
      // On the deck, short of its end (x 664).
      expect(atEnd!.x, `speed ${speed}`).toBeLessThan(660);
      expect(big.map((b) => b.text).slice(-2)).toEqual(['MISSION PASSED', 'CHAPTER 1 COMPLETE']);
      expect(sim.progress.missionsDone).toContain('big_score');
    }
  });

  it('holds the stopped car while the controls are locked: a pursuer running into it cannot shove it into the sea', () => {
    const { sim, car, marina } = finale();
    for (let t = 0; t < 3 && sim.controlLock === 0; t += 1 / 60) {
      car.vel.x = 40;
      car.vel.z = 0;
      sim.update(1 / 60, input({ throttle: 1 }));
    }
    const x0 = car.pos.x;
    // A heavy van rams it from behind at 30 m/s.
    const van = sim.spawnVehicle('van', x0 - 9, marina.z, Math.PI / 2);
    van.vel.x = 30;
    step(sim, 2);
    expect(car.inWater).toBe(false);
    expect(car.pos.x - x0).toBeLessThan(3);
    expect(sim.player.vehicle).toBe(car);
  });

  it('puts out a burning getaway car on arrival: the player locked inside survives, and the finale passes', () => {
    const { sim, car } = finale({}, 15);
    sim.cheats.godMode = false;
    sim.combat.damageVehicle(car, car.health + 1, null, 'bullet');
    expect(car.burning).toBe(true);
    car.burnTimer = 1.5;
    const ended = record(sim, 'missionEnded');
    const wasted = record(sim, 'wasted');
    for (let t = 0; t < 4 && sim.controlLock === 0; t += 1 / 60) {
      car.vel.x = 6;
      car.vel.z = 0;
      sim.update(1 / 60, input({ throttle: 0.3 }));
    }
    expect(sim.controlLock).toBeGreaterThan(0);
    expect(car.burning).toBe(false);
    // Trying to get out all through the lock and the line.
    for (let i = 0; i < 60 * 10 && sim.missions.active; i++) sim.update(1 / 60, input({ enterExit: i % 6 === 0 }));
    expect(wasted).toEqual([]);
    expect(sim.player.alive).toBe(true);
    expect(car.destroyed).toBe(false);
    expect(ended).toEqual([{ id: 'big_score', passed: true }]);
  });

  it('never takes stars away: arriving with 5 keeps 5 through the hold and the vault, and the heat behind them', () => {
    const sim = setup(before('big_score'), { police: false });
    sim.missions.noBust = true;
    const spots = missionSpots(sim.world);
    startMission(sim, 'big_score');
    stepUntil(sim, () => objective(sim) === 'Go to the First Azura Bank', 20);
    sim.wanted.setLevel(5);
    teleport(sim, spots.bank.x, spots.bank.z);
    stepUntil(sim, () => objective(sim).startsWith('Hold'), 2);
    expect(sim.wanted.level).toBe(5);
    expect(sim.wanted.floor).toBe(3);
    stepUntil(sim, () => objective(sim) === 'Get in the getaway car', 40, 1 / 30);
    expect(sim.wanted.level).toBe(5);
    expect(sim.wanted.heat).toBeGreaterThanOrEqual(STAR_HEAT[5]);
    expect(sim.wanted.floor).toBe(4);
    // Resumed past the vault at 5 stars: still 5.
    const sim2 = setup(before('big_score'), { police: false });
    sim2.wanted.setLevel(5);
    expect(sim2.missions.start('big_score', { resume: 1 })).toBe(true);
    step(sim2, 0.1);
    expect(sim2.wanted.level).toBe(5);
    // Below the pin it still raises the stars, as before.
    const sim3 = setup(before('big_score'), { police: false });
    expect(sim3.missions.start('big_score', { resume: 1 })).toBe(true);
    step(sim3, 0.1);
    expect(sim3.wanted.level).toBe(4);
  });

  it('the alarm tells the police where he is, also when he arrives with more stars than it pins', () => {
    const sim = setup(before('big_score'), { police: false });
    sim.missions.noBust = true;
    const spots = missionSpots(sim.world);
    startMission(sim, 'big_score');
    stepUntil(sim, () => objective(sim) === 'Go to the First Azura Bank', 20);
    sim.wanted.setLevel(4);
    // Out of their sight long enough that they search where they saw him last.
    stepUntil(sim, () => sim.wanted.searching, 40, 1 / 30);
    teleport(sim, spots.bank.x, spots.bank.z);
    stepUntil(sim, () => objective(sim).startsWith('Hold'), 2);
    expect(sim.wanted.level).toBe(4);
    expect(sim.wanted.searching).toBe(false);
    expect(Math.hypot(sim.wanted.lastSeenX - spots.bank.x, sim.wanted.lastSeenZ - spots.bank.z)).toBeLessThan(4);
  });
});

// --- retries keep what was gained between attempts ---------------------------------------

describe('a retry keeps what the player got after a failure', () => {
  it('a purchase made between attempts survives every later retry (its money is not wasted)', () => {
    const sim = setup(['wheels'], { police: false });
    const inv = sim.player.inventory;
    sim.progress.addMoney(5000);
    startMission(sim, 'delivery').fail('test');
    step(sim, 0.1);
    offMarker(sim);
    expect(sim.interactions.buy('buy:shotgun')).toBeNull();
    expect(sim.interactions.buy('armor')).toBeNull();
    const shells = inv.total('shotgun');
    expect(shells).toBeGreaterThan(0);
    for (let attempt = 1; attempt <= 3; attempt++) {
      takeRetry(sim, 'Collect the package');
      expect(inv.total('shotgun'), `retry ${attempt}`).toBe(shells);
      expect(sim.player.armor, `retry ${attempt}`).toBe(100);
      // Shots fired and armour lost during the attempt come back on the next retry, as the rest of his loadout does.
      inv.slots.get('shotgun')!.clip = 0;
      sim.player.armor = 20;
      sim.missions.active!.fail('test');
      step(sim, 0.1);
      offMarker(sim);
    }
  });

  it('Repo Man: pistol ammo bought after the failure stays on top of the top-up, and the pistol is drawn', () => {
    const sim = setup(before('repo'), { police: false });
    const inv = sim.player.inventory;
    const m = startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    expect(inv.total('pistol')).toBe(72);
    sim.combat.explodeVehicle(m.vehicles[0]!);
    step(sim, 0.5);
    expect(m.failedReason).toBe('The Nightjar was wrecked.');
    const money = sim.progress.money;
    expect(sim.interactions.buy('buy:pistol')).toBeNull();
    expect(sim.progress.money).toBe(money - 60);
    expect(inv.total('pistol')).toBe(120);
    inv.current = 'fists';
    offMarker(sim);
    takeRetry(sim, 'Steal the Nightjar GT');
    expect(inv.total('pistol')).toBe(120);
    expect(inv.current).toBe('pistol');
    // And on the next retry too.
    sim.combat.explodeVehicle(sim.missions.active!.vehicles[0]!);
    step(sim, 0.5);
    offMarker(sim);
    takeRetry(sim, 'Steal the Nightjar GT');
    expect(inv.total('pistol')).toBe(120);
  });

  it('Heatwave: an SMG picked up after a wasted adds to the 240 the retry hands out', () => {
    const sim = setup(before('heatwave'), { police: false });
    const inv = sim.player.inventory;
    const m = startMission(sim, 'heatwave');
    stepUntil(sim, () => objective(sim).startsWith('Destroy the vans'), 20);
    for (const v of [...m.vehicles]) {
      sim.combat.damageVehicle(v, 99999, sim.player, 'explosion');
      step(sim, 0.2);
    }
    stepUntil(sim, () => objective(sim) === 'Lose the cops', 3);
    expect(inv.total('smg')).toBe(240);
    sim.cheats.godMode = false;
    sim.combat.damageCharacter(sim.player, 999, null, 'fall', 0, -1, 0);
    step(sim, 6);
    expect(sim.missions.retryOffer()?.id).toBe('heatwave');
    // The hospital's SMG pickup.
    inv.give('smg', 90);
    takeRetry(sim, 'Lose the cops');
    expect(inv.total('smg')).toBe(330);
  });

  it('a gun bought after a failure and kept through a later bust (the police took his others) stays his on the retry', () => {
    const sim = setup(before('repo'), { police: false });
    const inv = sim.player.inventory;
    const m = startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    sim.combat.explodeVehicle(m.vehicles[0]!);
    step(sim, 0.5);
    expect(m.failedReason).toBe('The Nightjar was wrecked.');
    // Busted at 2 stars before he takes the retry: the police keep his guns, the mission pistol too.
    sim.wanted.setLevel(2);
    sim.bustPlayer();
    step(sim, 5.5);
    expect(inv.has('pistol')).toBe(false);
    expect(sim.missions.retryOffer()?.id).toBe('repo');
    // A new pistol from the shop.
    sim.progress.addMoney(5000);
    expect(sim.interactions.buy('buy:pistol')).toBeNull();
    const bought = inv.total('pistol');
    takeRetry(sim, 'Steal the Nightjar GT');
    expect(inv.total('pistol')).toBe(72 + bought);
  });

  it('what he bought after a failure with stars, then kept through a death before losing them, stays his', () => {
    const sim = setup(['wheels'], { police: false });
    sim.cheats.godMode = false;
    const inv = sim.player.inventory;
    const m = startMission(sim, 'delivery');
    stepUntil(sim, () => objective(sim) === 'Collect the package', 20);
    sim.wanted.setLevel(1);
    sim.combat.damageCharacter(m.characters.find((c) => c.missionTag === 'delivery')!, 1000, null, 'bullet', 0, 0, 1);
    step(sim, 0.1);
    expect(m.failedReason).toBe('The buyer is dead.');
    sim.progress.addMoney(5000);
    expect(sim.interactions.buy('buy:shotgun')).toBeNull();
    const shells = inv.total('shotgun');
    sim.combat.damageCharacter(sim.player, 999, null, 'fall', 0, -1, 0);
    step(sim, 6);
    expect(sim.player.alive).toBe(true);
    expect(sim.missions.retryOffer()?.id).toBe('delivery');
    takeRetry(sim, 'Collect the package');
    expect(inv.total('shotgun')).toBe(shells);
  });

  it('a marker restart (no retry) still only tops the mission weapon up', () => {
    const sim = setup(before('repo'), { police: false });
    const inv = sim.player.inventory;
    const m = startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    sim.combat.explodeVehicle(m.vehicles[0]!);
    step(sim, 0.5);
    expect(sim.interactions.buy('buy:pistol')).toBeNull();
    expect(inv.total('pistol')).toBe(120);
    startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    expect(inv.total('pistol')).toBe(120);
  });
});

// --- the retry offer after a failure with the police on him ------------------------------

describe('a failure with stars', () => {
  it('says to lose the cops first, and opens the retry window only once they are lost', () => {
    const sim = setup(['wheels'], { police: false });
    const big = record(sim, 'big');
    const m = startMission(sim, 'delivery');
    stepUntil(sim, () => objective(sim) === 'Collect the package', 20);
    sim.wanted.setLevel(1);
    const buyer = m.characters.find((c) => c.missionTag === 'delivery')!;
    sim.combat.damageCharacter(buyer, 1000, null, 'bullet', 0, 0, 1);
    step(sim, 0.1);
    expect(m.failedReason).toBe('The buyer is dead.');
    expect(big.at(-1)).toEqual(expect.objectContaining({ text: 'MISSION FAILED', sub: 'The buyer is dead. - Lose the cops, then press E to retry' }));
    offMarker(sim);
    expect(sim.interactions.prompt()).toBe('Lose the cops before retrying.');
    press(sim);
    step(sim, 1);
    expect(sim.missions.active).toBeNull();
    // Longer than the window, still wanted.
    step(sim, RETRY_WINDOW + 5, () => {
      sim.wanted.setLevel(1);
      return input();
    });
    expect(sim.interactions.prompt()).toBe('Lose the cops before retrying.');
    sim.wanted.clear();
    step(sim, 0.1);
    expect(sim.interactions.prompt()).toBe('Press E to retry "Hot Delivery"');
    // The full window from here.
    step(sim, RETRY_WINDOW - 1);
    expect(sim.missions.retryOffer()?.id).toBe('delivery');
    takeRetry(sim, 'Collect the package');
  });

  it('a retry the police interrupt during its fade waits for them to be lost, with a fresh window', () => {
    const sim = setup(['wheels'], { police: false });
    startMission(sim, 'delivery').fail('test');
    step(sim, 0.1);
    offMarker(sim);
    step(sim, RETRY_WINDOW - 2);
    press(sim);
    sim.wanted.setLevel(1);
    step(sim, 1);
    expect(sim.missions.active).toBeNull();
    expect(sim.interactions.prompt()).toBe('Lose the cops before retrying.');
    step(sim, 5, () => {
      sim.wanted.setLevel(1);
      return input();
    });
    sim.wanted.clear();
    step(sim, RETRY_WINDOW - 1);
    expect(sim.interactions.prompt()).toBe('Press E to retry "Hot Delivery"');
    takeRetry(sim, 'Collect the package');
  });
});

// --- CHAPTER 1 COMPLETE after MISSION PASSED ------------------------------------------------------

describe("The Big Score's last cards", () => {
  it('shows MISSION PASSED, with its sting and money, before CHAPTER 1 COMPLETE', () => {
    const sim = setup(before('big_score'), { police: false });
    expect(sim.missions.start('big_score', { resume: 1 })).toBe(true);
    step(sim, 0.1);
    const car = sim.missions.active!.vehicles[0]!;
    placeInCar(sim, car);
    const marina = missionSpots(sim.world).marina;
    const big = record(sim, 'big');
    parkIn(sim, car, marina.x - 3, marina.z);
    stepUntil(sim, () => sim.missions.active === null, 15);
    expect(big.map((b) => b.text)).toEqual(['MISSION PASSED', 'CHAPTER 1 COMPLETE']);
    expect(big[1]).toEqual({ text: 'CHAPTER 1 COMPLETE', sub: 'Vera Salgado has work: the lime V, Hotel Salgado', style: 'title', duration: 6 });
  });
});

// --- markers, the safehouse and the rampage ------------------------------------------------

/** Starts a rampage at the first live skull. */
function onRampage(sim: Sim): void {
  const skull = sim.pickups.find((p) => p.kind === 'rampage' && p.active)!;
  teleport(sim, skull.pos.x, skull.pos.z);
  step(sim, 0.2);
  expect(sim.activities.job?.kind).toBe('rampage');
}

describe('prompts at the markers', () => {
  it("in a car on a contact's marker the prompt says to get out, and getting out lands on the marker", () => {
    const sim = setup([], { police: false });
    const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === 'wheels')!;
    const car = sim.spawnVehicle('sedan', marker.x, marker.z, Math.PI / 2);
    placeInCar(sim, car);
    step(sim, 0.1);
    expect(sim.interactions.current()).toBeNull();
    expect(sim.interactions.prompt()).toBe('Get out of the vehicle to start "Wheels"');
    sim.wanted.setLevel(1);
    expect(sim.interactions.prompt()).toBe('Lose the cops before starting a mission.');
    sim.wanted.clear();
    sim.update(1 / 60, input({ enterExit: true }));
    stepUntil(sim, () => sim.player.state === 'normal', 3);
    expect(sim.interactions.current()?.ref).toBe('wheels');
    expect(sim.interactions.prompt()).toBe('Press E to start "Wheels"');
    // Nothing to say in a car away from the markers.
    const lane = legacyLane(sim, 40);
    const far = sim.spawnVehicle('sedan', lane.sx + lane.dx * 20, lane.sz + lane.dz * 20, lane.heading);
    placeInCar(sim, far);
    expect(sim.interactions.prompt()).toBeNull();
  });

  it("getting out of any vehicle parked on a contact's marker lands on the marker, the bus too", () => {
    for (const kind of ['compact', 'sedan', 'van', 'swat', 'bus'] as const) {
      const sim = setup([], { police: false });
      const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === 'wheels')!;
      placeInCar(sim, sim.spawnVehicle(kind, marker.x, marker.z, Math.PI / 2));
      step(sim, 0.1);
      sim.update(1 / 60, input({ enterExit: true }));
      stepUntil(sim, () => sim.player.state === 'normal', 3);
      expect(sim.interactions.current()?.ref, kind).toBe('wheels');
    }
  });

  it('the safehouse marker says why it will not save before E is pressed: wanted, a mission, a rampage', () => {
    const sim = setup(['wheels'], { police: false });
    const save = sim.interactions.markers.find((m) => m.kind === 'save')!;
    teleport(sim, save.x, save.z);
    step(sim, 0.1);
    expect(sim.interactions.prompt()).toBe('Press E to save your game');
    sim.wanted.setLevel(1);
    expect(sim.interactions.prompt()).toBe('Lose the cops before saving.');
    sim.wanted.clear();
    expect(sim.missions.start('delivery')).toBe(true);
    step(sim, 0.1);
    expect(sim.interactions.prompt()).toBe("You can't save during a mission.");
  });

  it('the safehouse neither saves nor heals during a rampage', () => {
    const sim = setup([], { police: false });
    onRampage(sim);
    const save = sim.interactions.markers.find((m) => m.kind === 'save')!;
    teleport(sim, save.x, save.z);
    step(sim, 0.1);
    sim.player.health = 30;
    expect(sim.interactions.prompt()).toBe("You can't save during a rampage.");
    const saves = record(sim, 'saveRequested');
    const messages = record(sim, 'message');
    press(sim);
    expect(saves).toEqual([]);
    expect(sim.player.health).toBe(30);
    expect(messages.map((e) => e.text)).toContain("You can't save during a rampage.");
    expect(sim.activities.job?.kind).toBe('rampage');
  });

  it("a contact's marker and a retry offer refuse to start a mission during a rampage, which goes on", () => {
    const sim = setup(['wheels'], { police: false });
    onRampage(sim);
    const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === 'delivery')!;
    teleport(sim, marker.x, marker.z);
    step(sim, 0.1);
    expect(sim.interactions.prompt()).toBe('Finish the rampage first.');
    press(sim);
    step(sim, 0.5);
    expect(sim.missions.active).toBeNull();
    expect(sim.activities.job?.kind).toBe('rampage');
    // A retry offer, taken during a rampage.
    const sim2 = setup(['wheels'], { police: false });
    startMission(sim2, 'delivery').fail('test');
    step(sim2, 0.1);
    onRampage(sim2);
    expect(sim2.missions.retryOffer()?.id).toBe('delivery');
    expect(sim2.interactions.prompt()).toBe('Finish the rampage first.');
    expect(sim2.missions.retryNow()).toBe(false);
    press(sim2);
    step(sim2, 1);
    expect(sim2.missions.active).toBeNull();
    expect(sim2.activities.job?.kind).toBe('rampage');
  });

  it('a mission started during a rampage anyway (the debug start) says the rampage is off', () => {
    const sim = setup([], { police: false });
    onRampage(sim);
    const messages = record(sim, 'message');
    expect(sim.missions.start('wheels')).toBe(true);
    expect(sim.activities.job).toBeNull();
    expect(messages.map((e) => e.text)).toContain('Rampage abandoned.');
  });
});

// --- the taxi fare --------------------------------------------------------------------

describe('a taxi job ending with the fare aboard', () => {
  function cabWithFare(): { sim: Sim; taxi: Vehicle; fare: Character } {
    const sim = makeSim({ ambient: false });
    const lane = [...sim.roads.lanes].sort((a, b) => b.length - a.length)[0]!;
    const taxi = sim.spawnVehicle('taxi', lane.sx + lane.dx * 8, lane.sz + lane.dz * 8, lane.heading);
    placeInCar(sim, taxi);
    step(sim, 0.05);
    sim.activities.toggleJob();
    const fare = (sim.activities.job as unknown as { fare: Character }).fare;
    fare.pos.x = taxi.pos.x - Math.cos(taxi.heading) * 3.5;
    fare.pos.z = taxi.pos.z + Math.sin(taxi.heading) * 3.5;
    // He walks to its door first.
    stepUntil(sim, () => fare.vehicle === taxi, 3);
    return { sim, taxi, fare };
  }

  for (const end of ['T', 'bail'] as const) {
    it(`lets him out at the curb, unhurt, when it ends in a left handbrake slide (${end === 'T' ? 'T pressed' : 'the player bails out'})`, () => {
      const { sim, taxi, fare } = cabWithFare();
      const health = fare.health;
      step(sim, 3, input({ throttle: 1 }));
      step(sim, 0.6, input({ throttle: 1, steer: -1, handbrake: true }));
      if (end === 'bail') expect(taxi.speed).toBeGreaterThan(11);
      sim.update(1 / 60, input(end === 'T' ? { job: true, throttle: 1, steer: -1, handbrake: true } : { enterExit: true }));
      expect(sim.activities.job).toBeNull();
      expect(fare.vehicle).toBeNull();
      const at = { x: fare.pos.x, z: fare.pos.z };
      step(sim, 0.5, input(end === 'T' ? { throttle: 1 } : {}));
      // Not run over by the sliding cab (a murder, and a star, on the player).
      expect(fare.alive).toBe(true);
      expect(fare.health).toBe(health);
      expect(fare.state).toBe('normal');
      expect(fare.lastAttacker).toBeNull();
      expect(sim.wanted.level).toBe(0);
      // Let out on the sidewalk, not in the traffic lane.
      expect(sim.world.isOnRoad(at.x, at.z)).toBe(false);
    });
  }
});

describe('a taxi fare walks to the cab', () => {
  interface Job {
    stage: string;
    fare: Character | null;
  }

  /** A taxi job on a one-lane street, the cab stopped in its lane `dist` m from the fare, who waits on the sidewalk 4 m to its right. */
  function cabAndFare(dist: number): { sim: Sim; taxi: Vehicle; fare: Character; job: () => Job } {
    const sim = makeSim({ ambient: false, police: false });
    const lane = sim.roads.lanes.find((l) => l.lanesInDir === 1 && l.length > 60 && Math.abs(l.sx) < 300 && Math.abs(l.sz) < 300)!;
    const x = lane.sx + lane.dx * lane.length * 0.3;
    const z = lane.sz + lane.dz * lane.length * 0.3;
    const taxi = sim.spawnVehicle('taxi', x, z, lane.heading);
    placeInCar(sim, taxi);
    step(sim, 0.05);
    sim.activities.toggleJob();
    const job = () => sim.activities.job as unknown as Job;
    const fare = job().fare!;
    const ahead = Math.sqrt(dist * dist - 16);
    fare.pos.x = x - Math.cos(lane.heading) * 4 + lane.dx * ahead;
    fare.pos.z = z + Math.sin(lane.heading) * 4 + lane.dz * ahead;
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(false);
    return { sim, taxi, fare, job };
  }

  /** Steps until the fare is aboard: how long it took, his fastest pace on foot (m/s), and the step from his last spot into the seat. */
  function walkAboard(sim: Sim, taxi: Vehicle, fare: Character): { t: number; fastest: number; step: number } {
    let last = { x: fare.pos.x, z: fare.pos.z };
    let fastest = 0;
    let t = 0;
    while (t < 8 && fare.vehicle !== taxi) {
      sim.update(1 / 60, input());
      t += 1 / 60;
      if (fare.vehicle === taxi) break;
      fastest = Math.max(fastest, Math.hypot(fare.pos.x - last.x, fare.pos.z - last.z) * 60);
      last = { x: fare.pos.x, z: fare.pos.z };
    }
    expect(fare.vehicle).toBe(taxi);
    return { t, fastest, step: Math.hypot(fare.pos.x - last.x, fare.pos.z - last.z) };
  }

  it('does not jump into a cab stopped 8.9 m away: he walks to it, and is aboard within 4 s', () => {
    const { sim, taxi, fare } = cabAndFare(8.9);
    const at = { x: fare.pos.x, z: fare.pos.z };
    sim.update(1 / 60, input());
    expect(fare.vehicle).toBeNull();
    expect(Math.hypot(fare.pos.x - at.x, fare.pos.z - at.z)).toBeLessThan(2.2 / 60);
    const { t, fastest } = walkAboard(sim, taxi, fare);
    // A walk (1.6 m/s); a long one ends with him getting in a little short of the door.
    expect(fastest).toBeLessThan(2.2);
    expect(t).toBeGreaterThan(3);
    expect(t).toBeLessThan(4.1);
  });

  it('gets in at the door nearest him, one step from his seat', () => {
    const { sim, taxi, fare } = cabAndFare(6);
    const { t, fastest, step: into } = walkAboard(sim, taxi, fare);
    expect(t).toBeGreaterThan(1.5);
    expect(fastest).toBeLessThan(2.2);
    expect(into).toBeLessThan(2.3);
    // Ahead of the cab on its right: the front passenger door.
    expect(fare.seat).toBe(1);
  });

  it('walks back to his spot on the sidewalk if the cab pulls away, and waits there for it', () => {
    const { sim, taxi, fare, job } = cabAndFare(7);
    const spot = { x: fare.pos.x, z: fare.pos.z };
    step(sim, 1.2);
    expect(fare.vehicle).toBeNull();
    expect(Math.hypot(fare.pos.x - spot.x, fare.pos.z - spot.z)).toBeGreaterThan(1);
    // The cab drives off.
    step(sim, 2, input({ throttle: 1 }));
    step(sim, 6, input({ brake: 1 }));
    expect(fare.vehicle).toBeNull();
    expect(job().stage).toBe('pickup');
    expect(Math.hypot(fare.pos.x - spot.x, fare.pos.z - spot.z)).toBeLessThan(0.7);
    expect(fare.brain?.mode).toBe('stand');
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(false);
    // Back and waiting beside him: he gets in.
    parkIn(sim, taxi, spot.x + Math.cos(taxi.heading) * 3.2, spot.z - Math.sin(taxi.heading) * 3.2);
    stepUntil(sim, () => fare.vehicle === taxi, 4);
    expect(job().stage).toBe('dropoff');
  });

  it('a job called off while he walks out to the cab sends him back to the sidewalk he came from', () => {
    const { sim, fare } = cabAndFare(7);
    const spot = { x: fare.pos.x, z: fare.pos.z };
    step(sim, 2.2);
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(true);
    const from = Math.hypot(fare.pos.x - spot.x, fare.pos.z - spot.z);
    sim.update(1 / 60, input({ job: true }));
    expect(sim.activities.job).toBeNull();
    expect(fare.persistent).toBe(false);
    // Off the road again within a couple of seconds, back where he came from (not on across the street)...
    step(sim, 2);
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(false);
    expect(Math.hypot(fare.pos.x - spot.x, fare.pos.z - spot.z)).toBeLessThan(Math.min(1.5, from));
    // ...and a pedestrian like any other from there.
    step(sim, 2);
    expect(fare.brain?.mode).toBe('wander');
  });

  it('a cab that stops again while he walks back, then leaves, still sends him back to the sidewalk', () => {
    const { sim, taxi, fare } = cabAndFare(7);
    const spot = { x: fare.pos.x, z: fare.pos.z };
    // Out towards the cab, into the road.
    step(sim, 2.2);
    expect(fare.vehicle).toBeNull();
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(true);
    /** Backs the cab up at `speed` m/s (0: holds it) for `secs` s. */
    const back = (speed: number, secs: number) => {
      for (let t = 0; t < secs; t += 1 / 60) {
        taxi.vel.x = -Math.sin(taxi.heading) * speed;
        taxi.vel.z = -Math.cos(taxi.heading) * speed;
        sim.update(1 / 60, input({ handbrake: speed === 0 }));
      }
    };
    // It backs off; while he walks back, still in the road, it stops again, and he turns to it once more...
    back(4, 0.3);
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(true);
    back(0, 0.5);
    expect(fare.vehicle).toBeNull();
    // ...then it leaves for good: back to the sidewalk spot he first set off from.
    back(10, 2);
    back(0, 6);
    expect(fare.vehicle).toBeNull();
    expect(Math.hypot(fare.pos.x - spot.x, fare.pos.z - spot.z)).toBeLessThan(0.7);
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(false);
  });
});

describe('a fare let out of a cab left across the road', () => {
  it('lands on the sidewalk, whichever way the cab points', () => {
    const sim = makeSim({ ambient: false, police: false });
    const lanes = sim.roads.lanes.filter((l) => l.length > 40).filter((_, i) => i % 7 === 0);
    const fare = sim.spawnCharacter('civilian', 0, 0);
    const place = (sim.activities as unknown as { placeOnSidewalk(c: Character, v: Vehicle): void }).placeOnSidewalk.bind(sim.activities);
    const cab = sim.spawnVehicle('taxi', 0, 0, 0);
    const onRoad: string[] = [];
    for (const lane of lanes) {
      for (const turn of [0, 0.4, 0.8, Math.PI / 2, Math.PI]) {
        cab.pos.x = lane.sx + lane.dx * lane.length * 0.5;
        cab.pos.z = lane.sz + lane.dz * lane.length * 0.5;
        cab.heading = lane.heading + turn;
        place(fare, cab);
        if (sim.world.isOnRoad(fare.pos.x, fare.pos.z)) onRoad.push(`lane ${lane.id} turn ${turn.toFixed(2)}`);
      }
    }
    expect(lanes.length).toBeGreaterThan(20);
    expect(onRoad).toEqual([]);
  });

  it('lets him out clear of the cab and out of its way, however it points and rolls', () => {
    const sim = makeSim({ ambient: false, police: false });
    const lanes = sim.roads.lanes.filter((l) => l.length > 40).filter((_, i) => i % 7 === 0);
    const fare = sim.spawnCharacter('civilian', 0, 0);
    const place = (sim.activities as unknown as { placeOnSidewalk(c: Character, v: Vehicle): void }).placeOnSidewalk.bind(sim.activities);
    const cab = sim.spawnVehicle('taxi', 0, 0, 0);
    const hit: string[] = [];
    for (const lane of lanes) {
      for (const turn of [0, 0.4, 0.8, Math.PI / 2, Math.PI]) {
        // At rest, rolling forwards or backwards, sliding to either side.
        for (const [ahead, side] of [[0, 0], [6, 0], [-6, 0], [0, 5], [0, -5]] as const) {
          cab.pos.x = lane.sx + lane.dx * lane.length * 0.5;
          cab.pos.z = lane.sz + lane.dz * lane.length * 0.5;
          cab.heading = lane.heading + turn;
          const fx = Math.sin(cab.heading);
          const fz = Math.cos(cab.heading);
          const rx = -Math.cos(cab.heading);
          const rz = Math.sin(cab.heading);
          cab.vel.x = fx * ahead + rx * side;
          cab.vel.z = fz * ahead + rz * side;
          place(fare, cab);
          // Where the cab will be over the next 0.8 s: never on him (his radius 0.4).
          for (let t = 0; t <= 0.8; t += 0.1) {
            const dx = fare.pos.x - (cab.pos.x + cab.vel.x * t);
            const dz = fare.pos.z - (cab.pos.z + cab.vel.z * t);
            if (Math.abs(dx * fx + dz * fz) < cab.halfL + 0.4 && Math.abs(dx * rx + dz * rz) < cab.halfW + 0.4) {
              hit.push(`lane ${lane.id} turn ${turn.toFixed(2)} rolling ${ahead},${side} at ${t.toFixed(1)} s`);
              break;
            }
          }
        }
      }
    }
    expect(hit).toEqual([]);
  });

  it("still gets out on his destination's side when the cab creeps that way as it stops there", () => {
    const sim = makeSim({ ambient: false, police: false });
    const lane = sim.roads.lanes.find((l) => l.lanesInDir === 1 && l.length > 60 && Math.abs(l.sx) < 300 && Math.abs(l.sz) < 300)!;
    const x = lane.sx + lane.dx * lane.length * 0.5;
    const z = lane.sz + lane.dz * lane.length * 0.5;
    const taxi = sim.spawnVehicle('taxi', x, z, lane.heading);
    placeInCar(sim, taxi);
    step(sim, 0.05);
    sim.activities.toggleJob();
    const job = () => sim.activities.job as unknown as { stage: string; fare: Character | null; timer: number; destX: number; destZ: number };
    const fare = job().fare!;
    fare.pos.x = x - Math.cos(lane.heading) * 3.5;
    fare.pos.z = z + Math.sin(lane.heading) * 3.5;
    stepUntil(sim, () => fare.vehicle === taxi, 3);
    // At his destination, 4 m to the cab's right, still sliding that way at 1.5 m/s (northbound on Marlin St).
    parkIn(sim, taxi, -87, -304);
    taxi.heading = Math.PI;
    job().destX = -83;
    job().destZ = -304;
    job().timer = 50;
    taxi.vel.x = 1.5;
    const fares = sim.progress.stats.taxiFares;
    sim.update(1 / 60, input());
    expect(sim.progress.stats.taxiFares).toBe(fares + 1);
    expect(fare.vehicle).toBeNull();
    expect(fare.pos.x).toBeGreaterThan(taxi.pos.x + taxi.halfW);
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(false);
  });

  it('is not run over by a cab left across the road and still reversing when his time runs out', () => {
    const sim = makeSim({ ambient: false, police: false });
    const lane = sim.roads.lanes.find((l) => l.lanesInDir === 1 && l.length > 60 && Math.abs(l.sx) < 300 && Math.abs(l.sz) < 300)!;
    const x = lane.sx + lane.dx * lane.length * 0.5;
    const z = lane.sz + lane.dz * lane.length * 0.5;
    const taxi = sim.spawnVehicle('taxi', x, z, lane.heading);
    placeInCar(sim, taxi);
    step(sim, 0.05);
    sim.activities.toggleJob();
    const job = () => sim.activities.job as unknown as { stage: string; fare: Character | null; timer: number };
    const fare = job().fare!;
    fare.pos.x = x - Math.cos(lane.heading) * 3.5;
    fare.pos.z = z + Math.sin(lane.heading) * 3.5;
    stepUntil(sim, () => fare.vehicle === taxi, 3);
    // Square across a street running east-west, backing up at 6 m/s as the fare's time runs out (the north ring road).
    parkIn(sim, taxi, -45, -468.1);
    expect(Math.abs(Math.sin(sim.roads.nearestLane(-45, -468.1).lane.heading))).toBeCloseTo(1, 3);
    taxi.heading = Math.PI;
    taxi.vel.z = 6;
    job().timer = 0.001;
    const health = fare.health;
    sim.update(1 / 60, input());
    expect(fare.vehicle).toBeNull();
    expect(sim.activities.job).toBeNull();
    step(sim, 0.6);
    expect(fare.health).toBe(health);
    expect(fare.state).toBe('normal');
    expect(fare.lastAttacker).toBeNull();
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(false);
  });
});

// --- the gun shop and the save at the ammo cap -----------------------------------------------

describe('the ammo cap', () => {
  it('the gun shop takes no money for ammo a full gun cannot hold', () => {
    const sim = setup([], { police: false });
    sim.progress.addMoney(1e6);
    const inv = sim.player.inventory;
    inv.give('pistol', 20000);
    const total = inv.total('pistol');
    const money = sim.progress.money;
    expect(sim.interactions.buy('buy:pistol')).toBe("You can't carry any more.");
    expect(sim.progress.money).toBe(money);
    expect(inv.total('pistol')).toBe(total);
    // Below the cap it still sells.
    inv.slots.get('pistol')!.ammo = 9000;
    expect(sim.interactions.buy('buy:pistol')).toBeNull();
    expect(sim.progress.money).toBe(money - 60);
  });

  it('a save and continue keeps a full gun\'s loaded magazine', () => {
    const sim = setup([], { police: false });
    const inv = sim.player.inventory;
    for (const id of ['pistol', 'smg', 'shotgun', 'rifle', 'rocket'] as const) inv.give(id, 20000);
    const weapons = (['pistol', 'smg', 'shotgun', 'rifle', 'rocket'] as const).map((id) => ({ id, ammo: inv.total(id) }));
    const parsed = parseSave(JSON.parse(JSON.stringify(serialize(sim.progress, weapons, 0, 12, 1))))!;
    const sim2 = setup([], { police: false });
    for (const w of parsed.weapons) sim2.player.inventory.give(w.id, w.ammo);
    for (const { id, ammo } of weapons) expect(sim2.player.inventory.total(id), id).toBe(ammo);
    // A forged save cannot slip in a name every object has.
    expect(parseSave({ version: 1, weapons: [{ id: 'toString', ammo: 5 }, { id: 'pistol', ammo: 5 }] })!.weapons).toEqual([{ id: 'pistol', ammo: 5 }]);
  });
});
