import { describe, expect, it } from 'vitest';
import { missionSpots } from '../../src/sim/missions/spots';
import type { Sim } from '../../src/sim/sim';
import type { Vehicle } from '../../src/sim/entities';
import { input, makeSim, step, teleport } from './helpers';

function setup(done: string[]): Sim {
  const sim = makeSim({ ambient: false });
  for (const d of done) sim.progress.markDone(d);
  sim.cheats.godMode = true;
  step(sim, 0.1);
  return sim;
}

function startMission(sim: Sim, id: string): void {
  const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === id);
  expect(marker, `marker for ${id}`).toBeDefined();
  teleport(sim, marker!.x, marker!.z);
  step(sim, 0.1);
  sim.update(1 / 60, input({ interact: true }));
  expect(sim.missions.active?.def.id).toBe(id);
}

/** Steps until the predicate holds (or fails after `max` seconds). */
function stepUntil(sim: Sim, pred: () => boolean, max: number, inp = input()): void {
  for (let t = 0; t < max; t += 1 / 60) {
    if (pred()) return;
    sim.update(1 / 60, inp);
  }
  expect(pred(), 'condition not reached in time').toBe(true);
}

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

function expectPassed(sim: Sim, id: string, money0: number, reward: number): void {
  stepUntil(sim, () => sim.missions.active === null, 30);
  expect(sim.progress.missionsDone).toContain(id);
  expect(sim.progress.money).toBe(money0 + reward);
}

describe('story missions are completable', () => {
  it('1. Wheels', () => {
    const sim = setup([]);
    const spots = missionSpots(sim.world);
    const money = sim.progress.money;
    startMission(sim, 'wheels');
    stepUntil(sim, () => sim.missions.active!.objectiveText === 'Steal a car', 20);
    const lane = sim.roads.nearestLane(spots.lou.x, spots.lou.z).lane;
    const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 20, lane.sz + lane.dz * 20, lane.heading);
    enterVehicle(sim, car);
    stepUntil(sim, () => sim.missions.active!.objectiveText.startsWith('Drive'), 2);
    parkIn(sim, car, spots.louBay.x, spots.louBay.z);
    expectPassed(sim, 'wheels', money, 500);
    expect(sim.player.vehicle).toBeNull();
  });

  it('2. Hot Delivery (and its timer can fail it)', () => {
    const sim = setup(['wheels']);
    const spots = missionSpots(sim.world);
    const money = sim.progress.money;
    startMission(sim, 'delivery');
    stepUntil(sim, () => sim.missions.active!.objectiveText === 'Collect the package', 20);
    teleport(sim, spots.packagePickup.x, spots.packagePickup.z);
    stepUntil(sim, () => sim.missions.active!.objectiveText.startsWith('Deliver'), 2);
    expect(sim.missions.active!.timer).not.toBeNull();
    teleport(sim, spots.packageDrop.x, spots.packageDrop.z);
    expectPassed(sim, 'delivery', money, 1200);

    // Failure: let the timer run out.
    const sim2 = setup(['wheels']);
    startMission(sim2, 'delivery');
    stepUntil(sim2, () => sim2.missions.active!.objectiveText === 'Collect the package', 20);
    teleport(sim2, spots.packagePickup.x, spots.packagePickup.z);
    stepUntil(sim2, () => sim2.missions.active === null, 200);
    expect(sim2.progress.missionsDone).not.toContain('delivery');
    // The mission is offered again afterwards.
    expect(sim2.interactions.markers.some((m) => m.ref === 'delivery')).toBe(true);
  });

  it('3. Repo Man (and wrecking the car fails it)', () => {
    const sim = setup(['wheels', 'delivery']);
    const spots = missionSpots(sim.world);
    const money = sim.progress.money;
    startMission(sim, 'repo');
    stepUntil(sim, () => sim.missions.active!.objectiveText === 'Steal the Nightjar GT', 20);
    expect(sim.player.inventory.has('pistol')).toBe(true);
    const car = sim.missions.active!.vehicles[0]!;
    expect(car.kind).toBe('sports');
    expect(sim.characters.filter((c) => c.role === 'gang' && c.persistent).length).toBe(3);
    enterVehicle(sim, car);
    stepUntil(sim, () => sim.missions.active!.objectiveText.startsWith('Bring'), 2);
    parkIn(sim, car, spots.louBay.x, spots.louBay.z);
    expectPassed(sim, 'repo', money, 2500);

    const sim2 = setup(['wheels', 'delivery']);
    startMission(sim2, 'repo');
    stepUntil(sim2, () => sim2.missions.active!.objectiveText === 'Steal the Nightjar GT', 20);
    sim2.combat.explodeVehicle(sim2.missions.active!.vehicles[0]!);
    step(sim2, 0.5);
    expect(sim2.missions.active).toBeNull();
    expect(sim2.progress.missionsDone).not.toContain('repo');
  });

  it('4. Loose Lips', () => {
    const sim = setup(['wheels', 'delivery', 'repo']);
    const money = sim.progress.money;
    startMission(sim, 'loose_lips');
    stepUntil(sim, () => sim.missions.active!.objectiveText === 'Take out Benny', 20);
    const benny = sim.missions.active!.characters[0]!;
    expect(benny.state).toBe('inVehicle');
    const car = benny.vehicle!;
    // Get close: he should notice and flee.
    teleport(sim, car.pos.x + 20, car.pos.z + 20);
    step(sim, 0.5);
    expect(car.ai?.policy).toBe('flee');
    step(sim, 3);
    sim.combat.damageCharacter(benny, 500, sim.player, 'bullet', 0, 0, 1);
    expectPassed(sim, 'loose_lips', money, 4000);
  });

  it('5. Heatwave', () => {
    const sim = setup(['wheels', 'delivery', 'repo', 'loose_lips']);
    const money = sim.progress.money;
    startMission(sim, 'heatwave');
    stepUntil(sim, () => sim.missions.active!.objectiveText.startsWith('Destroy the vans'), 20);
    const vans = sim.missions.active!.vehicles;
    expect(vans.length).toBe(3);
    for (const v of vans) {
      sim.combat.damageVehicle(v, 99999, sim.player, 'explosion');
      step(sim, 0.2);
    }
    stepUntil(sim, () => sim.missions.active!.objectiveText === 'Lose the cops', 3);
    expect(sim.wanted.level).toBeGreaterThanOrEqual(2);
    sim.police.dismissAll();
    // Round 2 (police, P10): sit out the response phase (4 + 3 per star seconds), in which the police
    // know where he is, so the teleport leaves them looking around the vans.
    step(sim, 12);
    const far = sim.roads.node(9, 1);
    teleport(sim, far.x + 12, far.z + 12);
    stepUntil(sim, () => sim.wanted.level === 0, 60);
    expectPassed(sim, 'heatwave', money, 6000);
  });

  it('6. The Big Score', () => {
    const sim = setup(['wheels', 'delivery', 'repo', 'loose_lips', 'heatwave']);
    const spots = missionSpots(sim.world);
    const money = sim.progress.money;
    startMission(sim, 'big_score');
    stepUntil(sim, () => sim.missions.active!.objectiveText === 'Go to the First Azura Bank', 20);
    // Officers answer the alarm during the hold; whether they may arrest a player standing there is
    // the police's business (the e2e test sets the same flag).
    sim.missions.noBust = true;
    teleport(sim, spots.bank.x, spots.bank.z);
    stepUntil(sim, () => sim.missions.active!.objectiveText.startsWith('Hold'), 2);
    expect(sim.wanted.level).toBe(3);
    stepUntil(sim, () => sim.missions.active!.objectiveText === 'Get in the getaway car', 30);
    expect(sim.wanted.level).toBe(4);
    const car = sim.missions.active!.vehicles[0]!;
    enterVehicle(sim, car);
    stepUntil(sim, () => sim.missions.active!.objectiveText === 'Escape to the Marina', 2);
    parkIn(sim, car, spots.marina.x - 3, spots.marina.z);
    expectPassed(sim, 'big_score', money, 25000);
    expect(sim.wanted.level).toBe(0);
    expect(sim.missions.offers()).toEqual([]);
  });

  it('fails the active mission when the player is wasted and allows a retry', () => {
    const sim = setup([]);
    sim.cheats.godMode = false;
    startMission(sim, 'wheels');
    step(sim, 1);
    sim.combat.damageCharacter(sim.player, 999, null, 'fall', 0, -1, 0);
    step(sim, 0.2);
    expect(sim.missions.active).toBeNull();
    step(sim, 6);
    expect(sim.player.alive).toBe(true);
    startMission(sim, 'wheels');
  });

  it('places mission spots on free, dry land', () => {
    const sim = setup([]);
    const s = missionSpots(sim.world);
    const pts = [s.louBay, s.packagePickup, s.packageDrop, s.repoCar, ...s.repoGuards, ...s.vans, s.getaway, s.bank, s.marina, s.lou, s.dex];
    for (const p of pts) {
      expect(sim.world.waterDepth(p.x, p.z), `spot ${p.x},${p.z}`).toBeLessThan(0);
      expect(sim.world.isFree(p.x, p.z, 0.5), `spot ${p.x},${p.z}`).toBe(true);
    }
    expect(s.repoGuards.length).toBe(3);
    expect(new Set(s.vans.map((v) => `${v.x},${v.z}`)).size).toBe(3);
  });
});
