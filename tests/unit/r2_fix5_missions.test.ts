// Round 2 fix pass 5, missions cluster: a passed mission is marked done, paid and saved at its goal (a quit during
// its closing lines cannot lose it), the finished objective leaves the screen with the goal, and a car's GPS route
// leads on to the junction ahead instead of back to the one behind.

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { SimEvents } from '../../src/sim/events';
import type { MissionCtx } from '../../src/sim/missions/runner';
import { missionSpots } from '../../src/sim/missions/spots';
import { applySave, parseSave, serialize, type SaveData } from '../../src/sim/progress';
import type { Sim, SimOptions } from '../../src/sim/sim';
import { gpsRoute } from '../../src/ui/mapRender';
import type { Lane } from '../../src/world/roads';
import { input, makeSim, placeInCar, step, teleport } from './helpers';

// --- helpers ------------------------------------------------------------------

const STORY = ['wheels', 'delivery', 'repo', 'loose_lips', 'heatwave', 'big_score'];
const REWARD: Record<string, number> = { wheels: 500, delivery: 1200, repo: 2500, loose_lips: 4000, heatwave: 6000, big_score: 25000 };
/** Everything before mission `id`. */
const before = (id: string) => STORY.slice(0, STORY.indexOf(id));

function setup(done: string[], opts: SimOptions = {}): Sim {
  const sim = makeSim({ ambient: false, police: false, ...opts });
  for (const d of done) sim.progress.markDone(d);
  sim.cheats.godMode = true;
  step(sim, 0.1);
  return sim;
}

/** Steps until the predicate holds (or fails after `max` seconds). */
function stepUntil(sim: Sim, pred: () => boolean, max: number): void {
  for (let t = 0; t < max; t += 1 / 60) {
    if (pred()) return;
    sim.update(1 / 60, input());
  }
  expect(pred(), 'condition not reached in time').toBe(true);
}

const objective = (sim: Sim) => sim.missions.active?.objectiveText ?? '';

function startAtMarker(sim: Sim, id: string): MissionCtx {
  const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === id);
  expect(marker, `marker for ${id}`).toBeDefined();
  teleport(sim, marker!.x, marker!.z);
  step(sim, 0.1);
  sim.update(1 / 60, input({ interact: true }));
  expect(sim.missions.active?.def.id).toBe(id);
  return sim.missions.active!;
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

/** Records every event of `type`. */
function record<K extends keyof SimEvents>(sim: Sim, type: K): Array<SimEvents[K]> {
  const out: Array<SimEvents[K]> = [];
  sim.events.on(type, (e) => out.push(e));
  return out;
}

/** What each autosave writes, as Game.save serializes it. */
function disk(sim: Sim): SaveData[] {
  const saves: SaveData[] = [];
  sim.events.on('saveRequested', () => {
    const inv = sim.player.inventory;
    const weapons = inv.owned().filter((w) => w !== 'fists').map((id) => ({ id, ammo: inv.total(id) }));
    saves.push(serialize(sim.progress, weapons, sim.player.armor, sim.clock.hours, sim.clock.day));
  });
  return saves;
}

/** QUIT TO TITLE, then CONTINUE: a fresh game loaded from that save. */
function continueFrom(save: SaveData): Sim {
  const sim = makeSim({ ambient: false, police: false });
  applySave(sim.progress, parseSave(JSON.parse(JSON.stringify(save)))!);
  return sim;
}

/** Plays mission `id` up to just before its goal; `meet` meets it. */
function toGoal(sim: Sim, id: string): { m: MissionCtx; meet: () => void; car: Vehicle | null } {
  const spots = missionSpots(sim.world);
  if (id === 'wheels') {
    const m = startAtMarker(sim, 'wheels');
    stepUntil(sim, () => objective(sim) === 'Steal a car', 20);
    const lane = sim.roads.nearestLane(spots.lou.x, spots.lou.z).lane;
    const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 20, lane.sz + lane.dz * 20, lane.heading);
    enterVehicle(sim, car);
    stepUntil(sim, () => objective(sim).startsWith('Drive'), 2);
    return { m, car, meet: () => parkIn(sim, car, spots.louBay.x, spots.louBay.z) };
  }
  if (id === 'delivery') {
    const m = startAtMarker(sim, 'delivery');
    stepUntil(sim, () => objective(sim) === 'Collect the package', 20);
    teleport(sim, spots.packagePickup.x, spots.packagePickup.z);
    stepUntil(sim, () => m.timer !== null, 2);
    for (const v of m.vehicles.filter((v) => v.kind === 'muscle')) sim.removeVehicle(v);
    return { m, car: null, meet: () => teleport(sim, spots.packageDrop.x, spots.packageDrop.z) };
  }
  if (id === 'repo') {
    const m = startAtMarker(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    const car = m.vehicles[0]!;
    enterVehicle(sim, car);
    stepUntil(sim, () => objective(sim).startsWith('Bring'), 2);
    for (const v of m.vehicles.filter((v) => v !== car)) sim.removeVehicle(v);
    return { m, car, meet: () => parkIn(sim, car, spots.louBay.x, spots.louBay.z) };
  }
  if (id === 'loose_lips') {
    const m = startAtMarker(sim, 'loose_lips');
    stepUntil(sim, () => objective(sim) === 'Take out Benny', 20);
    const benny = m.characters[0]!;
    return { m, car: null, meet: () => sim.combat.damageCharacter(benny, 500, sim.player, 'bullet', 0, 0, 1) };
  }
  if (id === 'heatwave') {
    expect(sim.missions.start('heatwave', { resume: 1 })).toBe(true);
    step(sim, 0.1);
    const m = sim.missions.active!;
    stepUntil(sim, () => objective(sim) === 'Lose the cops', 2);
    return { m, car: null, meet: () => sim.wanted.clear() };
  }
  // The Big Score from its checkpoint: in the getaway car, then the Marina.
  expect(sim.missions.start('big_score', { resume: 1 })).toBe(true);
  step(sim, 0.1);
  const m = sim.missions.active!;
  const car = m.vehicles[0]!;
  placeInCar(sim, car);
  stepUntil(sim, () => objective(sim) === 'Escape to the Marina', 2);
  return { m, car, meet: () => parkIn(sim, car, spots.marina.x, spots.marina.z) };
}

// --- S3: the pass is kept from its goal on ----------------------------------------------

describe('a passed mission is marked done, paid and saved at its goal, not after its closing lines', () => {
  for (const id of STORY) {
    it(`${id}: a quit during the closing lines keeps it; it is paid and saved once`, () => {
      const sim = setup(before(id));
      const money0 = sim.progress.money;
      const { m, meet } = toGoal(sim, id);
      const saves = disk(sim);
      const paid = record(sim, 'money');
      const big = record(sim, 'big');
      const objectives = record(sim, 'objective');
      meet();
      stepUntil(sim, () => m.won, 3);
      // The goal is met and the closing lines are still to come.
      expect(sim.missions.active).toBe(m);
      expect(m.reward).toBe(REWARD[id]);
      expect(sim.progress.missionsDone).toContain(id);
      expect(sim.progress.money).toBe(money0 + m.reward);
      expect(saves).toHaveLength(1);
      expect(saves[0]!.missionsDone).toContain(id);
      expect(saves[0]!.money).toBe(money0 + m.reward);
      // Nothing of the finished objective is left on screen, and it is cleared once.
      expect(m.objectiveText).toBe('');
      expect(objectives.map((e) => e.text)).toEqual(['']);
      // QUIT TO TITLE now, then CONTINUE: the mission stays done and is not offered again.
      const after = continueFrom(saves[0]!);
      expect(after.progress.hasDone(id)).toBe(true);
      expect(after.progress.money).toBe(money0 + m.reward);
      expect(after.missions.offers().map((d) => d.id)).not.toContain(id);
      // The closing lines play out: MISSION PASSED with that reward, which was paid once and saved once.
      stepUntil(sim, () => sim.missions.active === null, 20);
      expect(sim.progress.money).toBe(money0 + m.reward);
      expect(paid.filter((e) => e.amount === m.reward)).toHaveLength(1);
      expect(big.find((b) => b.style === 'passed')?.sub).toBe(`$${m.reward.toLocaleString('en-US')}`);
      expect(saves).toHaveLength(1);
      expect(sim.progress.missionsDone.filter((d) => d === id)).toHaveLength(1);
    });
  }

  it("Repo Man: Lou's lower pay for a battered Nightjar is what is paid and saved at the goal", () => {
    const sim = setup(before('repo'));
    const money0 = sim.progress.money;
    const { m, meet, car } = toGoal(sim, 'repo');
    car!.health = car!.spec.health * 0.3;
    const saves = disk(sim);
    const big = record(sim, 'big');
    meet();
    stepUntil(sim, () => m.won, 3);
    expect(m.reward).toBe(1500);
    expect(sim.progress.money).toBe(money0 + 1500);
    expect(saves[0]!.money).toBe(money0 + 1500);
    stepUntil(sim, () => sim.missions.active === null, 20);
    expect(sim.progress.money).toBe(money0 + 1500);
    expect(big.find((b) => b.style === 'passed')?.sub).toBe('$1,500');
  });

  it("Loose Lips: busted during Dex's closing line, the goal's save already holds the pass; the respawn saves the bail", () => {
    const sim = setup(before('loose_lips'), { police: true });
    const money0 = sim.progress.money;
    const { m, meet } = toGoal(sim, 'loose_lips');
    const saves = disk(sim);
    const subs = record(sim, 'subtitle');
    meet();
    stepUntil(sim, () => subs.some((s) => s.speaker === 'Dex Moreau'), 3);
    expect(m.won).toBe(true);
    expect(sim.wanted.level).toBeGreaterThanOrEqual(1);
    expect(saves).toHaveLength(1);
    sim.bustPlayer();
    step(sim, 0.1);
    expect(sim.missions.active).toBeNull();
    expect(sim.playerDown).toBe(true);
    // QUIT TO TITLE on the BUSTED screen: the pass and its pay are on disk.
    const after = continueFrom(saves.at(-1)!);
    expect(after.progress.hasDone('loose_lips')).toBe(true);
    expect(after.progress.money).toBe(money0 + 4000);
    // Back up after the respawn, the game is saved again with the bail paid.
    step(sim, 6);
    expect(sim.playerDown).toBe(false);
    expect(saves).toHaveLength(2);
    expect(saves[1]!.missionsDone).toContain('loose_lips');
    expect(saves[1]!.money).toBe(sim.progress.money);
    expect(saves[1]!.money).toBeLessThan(money0 + 4000);
  });
});

// --- N0: no finished objective under the closing lines ------------------------------------

describe('the finished objective leaves with the goal', () => {
  it("Loose Lips and Heatwave: Dex's closing line plays with no objective left on screen", () => {
    for (const id of ['loose_lips', 'heatwave']) {
      const sim = setup(before(id));
      const { m, meet } = toGoal(sim, id);
      expect(m.objectiveText, id).not.toBe('');
      const objectives = record(sim, 'objective');
      const subs = record(sim, 'subtitle');
      meet();
      stepUntil(sim, () => subs.some((s) => s.speaker === 'Dex Moreau'), 3);
      expect(sim.missions.active, id).toBe(m);
      expect(m.objectiveText, id).toBe('');
      expect(objectives.map((e) => e.text), id).toEqual(['']);
    }
  });
});

// --- S2: the GPS route leads on ahead -------------------------------------------------------

/** The reported spot: a sedan heading south on the street at x -470, 37 m past the junction at (-470, -474). */
const SPOT = { x: -472, z: -437 };
const FAR = { x: 365, z: 369 };

function carAt(sim: Sim, x: number, z: number, heading: number): Vehicle {
  const v = sim.spawnVehicle('sedan', x, z, heading);
  placeInCar(sim, v);
  return v;
}

function polyLen(pts: Array<{ x: number; z: number }>): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z);
  return l;
}

/** The drive on to the end of `lane`, then on from there without turning straight back, to the target. */
function aheadLen(sim: Sim, lane: Lane, x: number, z: number, tx: number, tz: number): number {
  const roads = sim.roads;
  const b = roads.nearestNode(tx, tz);
  const ids = roads.findRoute(lane.to, b.id, lane.from)!;
  const pts = [{ x, z }, ...ids.map((id) => ({ x: roads.nodes[id]!.x, z: roads.nodes[id]!.z })), { x: tx, z: tz }];
  return polyLen(pts);
}

const at = (sim: Sim, id: number) => ({ x: sim.roads.nodes[id]!.x, z: sim.roads.nodes[id]!.z });

describe('the GPS route of a car leads on to the junction ahead', () => {
  it('the reported spot: on south to (-470, -369), not back to the junction behind and east', () => {
    const sim = setup([]);
    carAt(sim, SPOT.x, SPOT.z, 0);
    const route = gpsRoute(sim, FAR.x, FAR.z);
    expect(route[0]).toEqual(SPOT);
    expect(route[1]).toEqual({ x: -470, z: -369 });
    expect(route.at(-1)).toEqual(FAR);
  });

  it('a missed turn: stopped 38.5 m past it, the route carries on to the next junction', () => {
    const sim = setup([]);
    carAt(sim, -472, -330.5, 0);
    expect(gpsRoute(sim, FAR.x, FAR.z)[1]).toEqual({ x: -470, z: -268 });
  });

  it('driving on south, re-planned every second as the radar does: the route never starts behind the car', () => {
    const sim = setup([]);
    const v = carAt(sim, SPOT.x, SPOT.z, 0);
    for (let t = 0; t < 6; t++) {
      const p = sim.playerPos();
      const first = gpsRoute(sim, FAR.x, FAR.z)[1]!;
      expect((first.x - p.x) * Math.sin(v.heading) + (first.z - p.z) * Math.cos(v.heading), `t ${t}`).toBeGreaterThan(0);
      step(sim, 1, input({ throttle: 1 }));
    }
  });

  it('a target behind the car: turning back to the junction behind is clearly shorter, so the route does', () => {
    const sim = setup([]);
    // Southbound, 30% along a block with another block behind it.
    const lane = sim.roads.lanes.find((l) => l.dir === 2 && l.length > 80 && sim.roads.nodes[l.from]!.neighbors[0] >= 0)!;
    carAt(sim, lane.sx + lane.dx * lane.length * 0.3, lane.sz + lane.dz * lane.length * 0.3, lane.heading);
    // The junction after the one behind, up the same road.
    const north = at(sim, sim.roads.nodes[lane.from]!.neighbors[0]);
    const route = gpsRoute(sim, north.x + 4, north.z);
    expect(route[1]).toEqual(at(sim, lane.from));
    expect(route[2]).toEqual(north);
  });

  it('a car past the middle of a junction can still turn there', () => {
    const sim = setup([]);
    const { lane } = sim.roads.nearestLane(SPOT.x, SPOT.z, 0);
    const j = at(sim, lane.from);
    carAt(sim, j.x - 2, j.z + 4, 0);
    // The far east end of the junction's own road: the route turns east at the junction he is in.
    const east = sim.roads.nodes[lane.from]!;
    let end = east;
    while (end.neighbors[1] >= 0) end = sim.roads.nodes[end.neighbors[1]]!;
    const route = gpsRoute(sim, end.x, end.z + 4);
    expect(route[1]).toEqual(j);
    expect(route[2]).toEqual(at(sim, east.neighbors[1]));
  });

  it('on foot, and off the road in a car, it still starts from the nearest junction', () => {
    const sim = setup([]);
    teleport(sim, SPOT.x - 4, SPOT.z);
    const near = sim.roads.nearestNode(SPOT.x - 4, SPOT.z);
    expect(gpsRoute(sim, FAR.x, FAR.z)[1]).toEqual({ x: near.x, z: near.z });
    // In a car facing south, but deep in a block (more than 12 m from any lane).
    const b = sim.world.layout.blocks.find((k) => k.rect.maxX - k.rect.minX > 60 && k.rect.maxZ - k.rect.minZ > 60)!;
    const cx = (b.rect.minX + b.rect.maxX) / 2;
    const cz = (b.rect.minZ + b.rect.maxZ) / 2;
    carAt(sim, cx, cz, 0);
    expect(sim.roads.nearestLane(cx, cz, 0).dist).toBeGreaterThan(12);
    const n = sim.roads.nearestNode(cx, cz);
    expect(gpsRoute(sim, FAR.x, FAR.z)[1]).toEqual({ x: n.x, z: n.z });
  });

  it('sweep: from 10% to 90% along every lane, a route turns back only when that is at least 40 m shorter than carrying on', () => {
    const sim = setup([]);
    const v = carAt(sim, SPOT.x, SPOT.z, 0);
    const roads = sim.roads;
    const n = Math.round(Math.sqrt(roads.nodes.length)) - 1;
    const targets = [roads.node(0, 0), roads.node(n, 0), roads.node(0, n), roads.node(n, n)].map((c) => ({ x: c.x + 6, z: c.z + 6 }));
    let total = 0;
    let back = 0;
    const bad: string[] = [];
    for (const lane of roads.lanes) {
      if (lane.length <= 40) continue;
      for (const f of [0.1, 0.3, 0.45, 0.7, 0.9]) {
        const x = lane.sx + lane.dx * lane.length * f;
        const z = lane.sz + lane.dz * lane.length * f;
        v.pos.x = x;
        v.pos.z = z;
        v.heading = lane.heading;
        for (const tg of targets) {
          if (Math.hypot(tg.x - x, tg.z - z) < 150) continue;
          total++;
          const route = gpsRoute(sim, tg.x, tg.z);
          const from = at(sim, lane.from);
          if (route[1]!.x !== from.x || route[1]!.z !== from.z) continue;
          back++;
          if (aheadLen(sim, lane, x, z, tg.x, tg.z) < polyLen(route) + 40 - 1e-6) bad.push(`lane ${lane.id} at ${f}: to (${tg.x}, ${tg.z})`);
        }
      }
    }
    expect(total).toBeGreaterThan(5000);
    expect(back).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
