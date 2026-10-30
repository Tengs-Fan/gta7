// Regression tests for the "progress_world" review cluster: frame-rate independent
// mission timers, Loose Lips / Repo Man / Big Score fixes, Spray Shack and the
// mission wanted floor, vigilante and taxi side jobs, and world placement
// (billboards on ramp lines, beach props below the waterline, sidewalk sampling).

import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import type { Character, Vehicle } from '../../src/sim/entities';
import { missionSpots } from '../../src/sim/missions/spots';
import type { Sim, SimOptions } from '../../src/sim/sim';
import { drownsInSinkingCar } from '../../src/sim/sinking';
import { WATER_Y } from '../../src/world/constants';
import { rectContains, rectCX, rectCZ, type Rect } from '../../src/world/layout';
import type { StaticCollider } from '../../src/world/colliders';
import { input, makeSim, placeInCar, step, teleport, world, legacyLane } from './helpers';

// --- helpers ------------------------------------------------------------------

function setup(done: string[], opts: SimOptions = {}): Sim {
  const sim = makeSim({ ambient: false, ...opts });
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

/** Steps at `dt` until the predicate holds (or fails after `max` seconds of sim time). */
function stepUntil(sim: Sim, pred: () => boolean, max: number, dt = 1 / 60): void {
  for (let t = 0; t < max; t += dt) {
    if (pred()) return;
    sim.update(dt, input());
  }
  expect(pred(), 'condition not reached in time').toBe(true);
}

const objective = (sim: Sim) => sim.missions.active?.objectiveText ?? '';

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

/** The road intersection farthest from (x, z) among the four city corners. */
function farCorner(sim: Sim, x: number, z: number): { x: number; z: number } {
  const n = sim.world.layout.n;
  const corners = [sim.roads.node(1, 1), sim.roads.node(n - 1, 1), sim.roads.node(1, n - 1), sim.roads.node(n - 1, n - 1)];
  corners.sort((a, b) => Math.hypot(b.x - x, b.z - z) - Math.hypot(a.x - x, a.z - z));
  return { x: corners[0]!.x, z: corners[0]!.z };
}

/** Local X of a point relative to a vehicle (+ = left / driver side, - = right / passenger side). */
function localX(v: Vehicle, x: number, z: number): number {
  return (x - v.pos.x) * Math.cos(v.heading) - (z - v.pos.z) * Math.sin(v.heading);
}

// --- mission timers -----------------------------------------------------------

describe('mission timers run on mission time, not frames', () => {
  for (const dt of [1 / 30, 1 / 144]) {
    it(`The Big Score vault takes 20 s at ${Math.round(1 / dt)} fps`, () => {
      const sim = setup(['wheels', 'delivery', 'repo', 'loose_lips', 'heatwave'], { police: false });
      const spots = missionSpots(sim.world);
      startMission(sim, 'big_score');
      stepUntil(sim, () => objective(sim) === 'Go to the First Azura Bank', 20);
      teleport(sim, spots.bank.x, spots.bank.z);
      stepUntil(sim, () => objective(sim).startsWith('Hold'), 2, dt);
      const t0 = sim.time;
      stepUntil(sim, () => objective(sim) === 'Get in the getaway car', 60, dt);
      expect(Math.abs(sim.time - t0 - 20)).toBeLessThan(0.25);
    });

    it(`Benny gets away after 10 s out of range at ${Math.round(1 / dt)} fps`, () => {
      const sim = setup(['wheels', 'delivery', 'repo'], { police: false });
      startMission(sim, 'loose_lips');
      stepUntil(sim, () => objective(sim) === 'Take out Benny', 20);
      const m = sim.missions.active!;
      const benny = m.characters[0]!;
      const far = farCorner(sim, benny.pos.x, benny.pos.z);
      teleport(sim, far.x, far.z);
      const t0 = sim.time;
      stepUntil(sim, () => sim.missions.active === null, 40, dt);
      expect(m.failedReason).toBe('Benny got away.');
      expect(Math.abs(sim.time - t0 - 10)).toBeLessThan(0.25);
    });
  }
});

// --- Loose Lips -----------------------------------------------------------------

/** Plays Loose Lips up to the point where the player has carjacked Benny's sedan. */
function jackBenny(sim: Sim): { benny: Character; car: Vehicle } {
  startMission(sim, 'loose_lips');
  stepUntil(sim, () => objective(sim) === 'Take out Benny', 20);
  const benny = sim.missions.active!.characters[0]!;
  const car = benny.vehicle!;
  // Stand in for a red light: his sedan is stopped when the player walks up to it.
  car.vel.x = 0;
  car.vel.z = 0;
  car.ai!.hold = true;
  enterVehicle(sim, car);
  expect(benny.vehicle).toBeNull();
  expect(benny.alive).toBe(true);
  return { benny, car };
}

describe('Loose Lips tracks Benny himself', () => {
  it('moves the marker onto Benny when the player carjacks him', () => {
    const sim = setup(['wheels', 'delivery', 'repo'], { police: false });
    const { benny, car } = jackBenny(sim);
    const markers = sim.missions.active!.markers;
    expect(markers.some((o) => o.character === benny)).toBe(true);
    expect(markers.some((o) => o.vehicle === car)).toBe(false);
  });

  it('fails when the player drives off in his car and leaves Benny behind', () => {
    const sim = setup(['wheels', 'delivery', 'repo'], { police: false });
    const { benny } = jackBenny(sim);
    const m = sim.missions.active!;
    const far = farCorner(sim, benny.pos.x, benny.pos.z);
    teleport(sim, far.x, far.z);
    stepUntil(sim, () => sim.missions.active === null, 15);
    expect(m.failedReason).toBe('Benny got away.');
  });

  it('does not pass when the empty car blows up, only when Benny dies', () => {
    const sim = setup(['wheels', 'delivery', 'repo'], { police: false });
    const money = sim.progress.money;
    const { benny, car } = jackBenny(sim);
    expect(sim.playerCtl.exitVehicle(false)).toBe(true);
    const away = sim.world.findFreeSpot(car.pos.x + 25, car.pos.z, 0.5, 20)!;
    teleport(sim, away.x, away.z);
    const safe = sim.world.findFreeSpot(car.pos.x - 30, car.pos.z, 0.5, 20)!;
    benny.pos.x = safe.x;
    benny.pos.z = safe.z;
    sim.combat.explodeVehicle(car);
    // Longer than Dex's closing line, which is all that stood between the wreck and a pass.
    step(sim, 8);
    expect(benny.alive).toBe(true);
    expect(sim.missions.active?.def.id).toBe('loose_lips');
    expect(sim.progress.missionsDone).not.toContain('loose_lips');
    sim.combat.damageCharacter(benny, 500, sim.player, 'bullet', 0, 0, 1);
    stepUntil(sim, () => sim.missions.active === null, 30);
    expect(sim.progress.missionsDone).toContain('loose_lips');
    expect(sim.progress.money).toBe(money + 4000);
  });

  // Wave 1 (VAL-DRIVE-005): people in a sinking car used to vanish (Benny "removed", and the mission passed); they now
  // swim out or drown (sim/sinking.ts). Drowned, Benny is down and the mission passes; swimming, he is still the target.
  it('passes when Benny drowns with his car; swimming out of it he is still the target', () => {
    const sim = setup(['wheels', 'delivery', 'repo'], { police: false });
    startMission(sim, 'loose_lips');
    stepUntil(sim, () => objective(sim) === 'Take out Benny', 20);
    const benny = sim.missions.active!.characters[0]!;
    const car = benny.vehicle!;
    car.pos.x = sim.world.bounds.landMinX - 40;
    car.pos.z = 0;
    car.pos.y = WATER_Y;
    stepUntil(sim, () => benny.vehicle === null, 3);
    expect(benny.removed).toBe(false);
    if (drownsInSinkingCar(benny)) {
      stepUntil(sim, () => !benny.alive, 6);
    } else {
      step(sim, 2);
      expect(benny.alive).toBe(true);
      expect(benny.state).toBe('swimming');
      expect(sim.missions.active?.def.id).toBe('loose_lips');
      sim.combat.damageCharacter(benny, 500, sim.player, 'bullet', 0, 0, 1);
    }
    stepUntil(sim, () => sim.missions.active === null, 30);
    expect(sim.progress.missionsDone).toContain('loose_lips');
  });

  it('gives Benny legs: he runs from a burning car instead of freezing', () => {
    const sim = setup(['wheels', 'delivery', 'repo'], { police: false });
    startMission(sim, 'loose_lips');
    stepUntil(sim, () => objective(sim) === 'Take out Benny', 20);
    const benny = sim.missions.active!.characters[0]!;
    const car = benny.vehicle!;
    sim.combat.igniteVehicle(car, 5);
    step(sim, 0.1);
    expect(benny.vehicle).toBeNull();
    const p0 = { x: benny.pos.x, z: benny.pos.z };
    step(sim, 2);
    expect(Math.hypot(benny.pos.x - p0.x, benny.pos.z - p0.z)).toBeGreaterThan(2);
  });
});

// --- Repo Man -------------------------------------------------------------------

describe('Repo Man', () => {
  it('accepts a Nightjar that arrives burning (Lou puts the fire out, reduced pay)', () => {
    const sim = setup(['wheels', 'delivery']);
    const spots = missionSpots(sim.world);
    const money = sim.progress.money;
    startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    const car = sim.missions.active!.vehicles[0]!;
    enterVehicle(sim, car);
    stepUntil(sim, () => objective(sim).startsWith('Bring'), 2);
    sim.combat.igniteVehicle(car, 4);
    parkIn(sim, car, spots.louBay.x, spots.louBay.z);
    stepUntil(sim, () => sim.missions.active === null, 30);
    expect(sim.progress.missionsDone).toContain('repo');
    expect(sim.progress.money).toBe(money + Math.round(2500 * 0.6));
    expect(car.destroyed).toBe(false);
  });

  it('marks the Nightjar again when the player gets out of it', () => {
    const sim = setup(['wheels', 'delivery']);
    const spots = missionSpots(sim.world);
    const money = sim.progress.money;
    startMission(sim, 'repo');
    stepUntil(sim, () => objective(sim) === 'Steal the Nightjar GT', 20);
    const m = sim.missions.active!;
    const car = m.vehicles[0]!;
    enterVehicle(sim, car);
    stepUntil(sim, () => objective(sim).startsWith('Bring'), 2);
    expect(m.markers.some((o) => o.label === "Lou's garage")).toBe(true);
    expect(sim.playerCtl.exitVehicle(false)).toBe(true);
    step(sim, 0.1);
    expect(objective(sim)).toBe('Get back in the Nightjar');
    expect(m.markers.some((o) => o.vehicle === car)).toBe(true);
    // The garage marker goes away so the GPS points at the car.
    expect(m.markers.some((o) => o.label === "Lou's garage")).toBe(false);
    enterVehicle(sim, car);
    stepUntil(sim, () => objective(sim).startsWith('Bring'), 2);
    expect(m.markers.some((o) => o.vehicle === car)).toBe(false);
    parkIn(sim, car, spots.louBay.x, spots.louBay.z);
    stepUntil(sim, () => sim.missions.active === null, 30);
    expect(sim.progress.missionsDone).toContain('repo');
    expect(sim.progress.money).toBeGreaterThan(money);
  });
});

// --- Spray Shack ----------------------------------------------------------------

describe('Spray Shack and the mission wanted floor', () => {
  it('refuses (without charging) while a mission pins the wanted level, and works again after', () => {
    const sim = makeSim({ police: false });
    const poi = sim.world.layout.pois.find((p) => p.id === 'spray_hill')!;
    const bay = poi.bay!;
    const car = sim.spawnVehicle('sedan', rectCX(bay), rectCZ(bay), poi.heading + Math.PI);
    placeInCar(sim, car);
    const texts: string[] = [];
    let sprayed = 0;
    sim.events.on('message', (e) => texts.push(e.text));
    sim.events.on('sprayed', () => sprayed++);
    sim.wanted.floor = 4;
    sim.wanted.setLevel(4);
    sim.progress.addMoney(1000); // enough for a four-star respray
    const money = sim.progress.money;
    step(sim, 0.5);
    expect(sim.wanted.level).toBe(4);
    expect(sim.wanted.floor).toBe(4);
    expect(sim.progress.money).toBe(money);
    expect(sprayed).toBe(0);
    expect(texts.filter((t) => t.startsWith('Spray Shack')).length).toBe(1);

    // Without a floor the same shop clears the heat as before.
    sim.wanted.floor = 0;
    teleport(sim, rectCX(bay) + Math.sin(poi.heading) * 14, rectCZ(bay) + Math.cos(poi.heading) * 14);
    step(sim, 0.2);
    teleport(sim, rectCX(bay), rectCZ(bay));
    step(sim, 0.5);
    expect(sprayed).toBe(1);
    expect(sim.wanted.level).toBe(0);
    // Round 2 (police, P62): a respray costs $100 per star (four here).
    expect(sim.progress.money).toBe(money - 400);
  });
});

// --- Vigilante ------------------------------------------------------------------

interface VigilanteJobView {
  kind: 'vigilante';
  level: number;
  target: Vehicle | null;
}

function startVigilante(sim: Sim): () => VigilanteJobView {
  const lane = legacyLane(sim, 40);
  const cop = sim.spawnVehicle('police', lane.sx + lane.dx * 20, lane.sz + lane.dz * 20, lane.heading);
  placeInCar(sim, cop);
  step(sim, 0.1);
  sim.activities.toggleJob();
  const job = () => sim.activities.job as unknown as VigilanteJobView;
  expect(job().kind).toBe('vigilante');
  stepUntil(sim, () => job().target !== null, 15);
  return job;
}

describe('vigilante suspects are released', () => {
  it('releases a dead suspect so the body streams out', () => {
    const sim = makeSim({ police: false });
    const job = startVigilante(sim);
    const suspect = job().target!.driver!;
    sim.combat.damageCharacter(suspect, 1000, sim.player, 'bullet', 0, 0, 1);
    step(sim, 0.1);
    expect(job().level).toBe(2);
    expect(suspect.persistent).toBe(false);
    expect(suspect.owner).toBe('ped');
    expect(suspect.missionTag).toBe('');
    const far = farCorner(sim, suspect.pos.x, suspect.pos.z);
    teleport(sim, far.x, far.z);
    sim.peds.updateStreaming(1);
    expect(suspect.removed).toBe(true);
  });

  it('releases a suspect who bails out of a burning car, and he runs', () => {
    const sim = makeSim({ police: false });
    const job = startVigilante(sim);
    const car = job().target!;
    const suspect = car.driver!;
    sim.combat.igniteVehicle(car, 5);
    step(sim, 0.1);
    expect(suspect.alive).toBe(true);
    expect(suspect.vehicle).toBeNull();
    expect(job().level).toBe(2);
    expect(suspect.persistent).toBe(false);
    expect(suspect.owner).toBe('ped');
    expect(suspect.brain).not.toBeNull();
    const p0 = { x: suspect.pos.x, z: suspect.pos.z };
    step(sim, 2);
    expect(Math.hypot(suspect.pos.x - p0.x, suspect.pos.z - p0.z)).toBeGreaterThan(2);
  });

  it('hands a suspect still at the wheel back to traffic when the job ends', () => {
    const sim = makeSim({ police: false });
    const job = startVigilante(sim);
    const car = job().target!;
    const suspect = car.driver!;
    sim.activities.toggleJob();
    expect(sim.activities.job).toBeNull();
    expect(suspect.vehicle).toBe(car);
    expect(suspect.persistent).toBe(false);
    expect(suspect.owner).toBe('traffic');
    expect(suspect.missionTag).toBe('');
    expect(car.persistent).toBe(false);
    expect(car.ai?.policy).toBe('traffic');
    expect(car.ai?.target).toBeNull();
  });
});

// --- Taxi -----------------------------------------------------------------------

interface TaxiJobView {
  kind: 'taxi';
  fare: Character | null;
  destX: number;
  destZ: number;
}

/** Starts a taxi job on a one-lane street (the cab optionally facing against traffic), picks up the fare and stops at their curb. */
function taxiDropOff(reversed: boolean): { sim: Sim; taxi: Vehicle; fare: Character } {
  const sim = makeSim({ police: false });
  const lane = sim.roads.lanes.find((l) => l.lanesInDir === 1 && l.length > 60 && Math.abs(l.sx) < 300 && Math.abs(l.sz) < 300)!;
  const s = lane.length / 2;
  const x = lane.sx + lane.dx * s;
  const z = lane.sz + lane.dz * s;
  const taxi = sim.spawnVehicle('taxi', x, z, lane.heading + (reversed ? Math.PI : 0));
  placeInCar(sim, taxi);
  step(sim, 0.05);
  sim.activities.toggleJob();
  const job = () => sim.activities.job as unknown as TaxiJobView;
  expect(job().kind).toBe('taxi');
  const fare = job().fare!;
  // Right of the lane's travel direction: towards the curb in right-hand traffic.
  const rx = -Math.cos(lane.heading);
  const rz = Math.sin(lane.heading);
  fare.pos.x = x + rx * 3.5;
  fare.pos.z = z + rz * 3.5;
  // He walks to the cab's door first.
  step(sim, 2);
  expect(fare.vehicle).toBe(taxi);
  // The destination is the sidewalk at the curb next to the cab.
  job().destX = x + rx * 5.2;
  job().destZ = z + rz * 5.2;
  step(sim, 0.05);
  expect(fare.vehicle).toBeNull();
  return { sim, taxi, fare };
}

describe('taxi fares get out at the curb', () => {
  it('drops the fare on the passenger side, off the road', () => {
    const { sim, taxi, fare } = taxiDropOff(false);
    expect(localX(taxi, fare.pos.x, fare.pos.z)).toBeLessThan(0);
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(false);
  });

  it('uses the curb the destination is on when the cab stopped facing against traffic', () => {
    const { sim, taxi, fare } = taxiDropOff(true);
    expect(localX(taxi, fare.pos.x, fare.pos.z)).toBeGreaterThan(0);
    expect(sim.world.isOnRoad(fare.pos.x, fare.pos.z)).toBe(false);
  });
});

// --- World placement ------------------------------------------------------------

describe('world placement', () => {
  const w = world();
  const L = w.layout;
  const b = L.bounds;

  it('keeps solid props off the stunt ramp lines well past the landing zone', () => {
    const hits: string[] = [];
    const overlaps = (c: StaticCollider, r: Rect) => {
      if (!c.circle) return c.minX < r.maxX && c.maxX > r.minX && c.minZ < r.maxZ && c.maxZ > r.minZ;
      const qx = Math.max(r.minX, Math.min(c.cx, r.maxX));
      const qz = Math.max(r.minZ, Math.min(c.cz, r.maxZ));
      return Math.hypot(c.cx - qx, c.cz - qz) < c.r;
    };
    for (const ramp of L.ramps) {
      // Ramps point along the axes, so the run-out lane is an axis-aligned rectangle.
      const fx = Math.round(Math.sin(ramp.heading));
      const fz = Math.round(Math.cos(ramp.heading));
      const half = ramp.width / 2 + 1.5;
      const a0 = ramp.length / 2 + 0.5;
      const a1 = 300;
      const xs = [ramp.x + fx * a0, ramp.x + fx * a1];
      const zs = [ramp.z + fz * a0, ramp.z + fz * a1];
      const lane: Rect = {
        minX: Math.min(...xs) - (fx === 0 ? half : 0),
        maxX: Math.max(...xs) + (fx === 0 ? half : 0),
        minZ: Math.min(...zs) - (fz === 0 ? half : 0),
        maxZ: Math.max(...zs) + (fz === 0 ? half : 0),
      };
      w.grid.query(lane.minX, lane.minZ, lane.maxX, lane.maxZ, (c) => {
        if (!c.breakable && overlaps(c, lane)) hits.push(`ramp ${ramp.id}: ${c.tag} at ${c.cx.toFixed(1)},${c.cz.toFixed(1)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('puts billboard post colliders under the rendered legs', () => {
    for (const p of L.props) {
      if (p.kind !== 'billboard') continue;
      // Rendered legs sit at local x = +-4.5 (render/props.ts).
      for (const s of [-1, 1]) {
        const x = p.x + Math.cos(p.rot) * 4.5 * s;
        const z = p.z - Math.sin(p.rot) * 4.5 * s;
        let found = false;
        w.grid.query(x - 0.1, z - 0.1, x + 0.1, z + 0.1, (c) => {
          if (c.tag === 'pillar' && c.circle && Math.hypot(c.cx - x, c.cz - z) < 0.05) found = true;
        });
        expect(found, `billboard at ${p.x},${p.z} leg ${s}`).toBe(true);
      }
    }
  });

  it('places every open spot where the pickup system accepts it', () => {
    for (const s of L.openSpots) {
      expect(w.isFree(s.x, s.z, 0.6) && w.waterDepth(s.x, s.z) < -0.1, `open spot ${s.x},${s.z} (${s.district})`).toBe(true);
    }
    const sim = makeSim({ police: false });
    const onSand = sim.pickups.filter((p) => p.pos.x > b.beachStartX && p.pos.x < b.beachEndX && !L.decks.some((d) => rectContains(d.rect, p.pos.x, p.pos.z)));
    expect(onSand.length).toBeGreaterThan(0);
  });

  it('keeps beach palms on dry sand and out from under the piers', () => {
    const palms = L.props.filter((p) => p.kind === 'palm' && p.x > b.beachStartX);
    expect(palms.length).toBeGreaterThan(15);
    for (const p of palms) {
      expect(w.baseGround(p.x, p.z) - WATER_Y, `palm at ${p.x},${p.z}`).toBeGreaterThan(0.1);
      for (const d of L.decks) expect(rectContains(d.rect, p.x, p.z, 1), `palm at ${p.x},${p.z} under ${d.name}`).toBe(false);
    }
  });

  it('samples sidewalk points inside the requested distance band', () => {
    const walk = w.walk;
    const rng = new Rng(4242);
    const inBandExists = (px: number, pz: number, minD: number, maxD: number) => {
      for (const [a, bb] of walk.walkEdges) {
        const na = walk.nodes[a]!;
        const nb = walk.nodes[bb]!;
        const len = Math.hypot(nb.x - na.x, nb.z - na.z);
        for (let s = 0; s <= len; s += 0.25) {
          const t = s / len;
          const d = Math.hypot(na.x + (nb.x - na.x) * t - px, na.z + (nb.z - na.z) * t - pz);
          if (d >= minD && d <= maxD) return true;
        }
      }
      return false;
    };
    let outside = 0;
    let falseNulls = 0;
    for (let i = 0; i < 1500; i++) {
      const [a, bb] = rng.pick(walk.walkEdges);
      const na = walk.nodes[a]!;
      const nb = walk.nodes[bb]!;
      const t = rng.next();
      const px = na.x + (nb.x - na.x) * t;
      const pz = na.z + (nb.z - na.z) * t;
      for (const [minD, maxD] of [[22, 48], [22, 70], [70, 220]] as const) {
        const r = walk.randomPointNear(rng, px, pz, minD, maxD);
        if (!r) {
          if (inBandExists(px, pz, minD, maxD)) falseNulls++;
          continue;
        }
        const d = Math.hypot(r.x - px, r.z - pz);
        if (d < minD - 1e-6 || d > maxD + 1e-6) outside++;
        // The returned edge parameters must describe the returned point.
        const ea = walk.nodes[r.a]!;
        const eb = walk.nodes[r.b]!;
        expect(Math.hypot(ea.x + (eb.x - ea.x) * r.t - r.x, ea.z + (eb.z - ea.z) * r.t - r.z)).toBeLessThan(1e-6);
      }
    }
    expect(outside).toBe(0);
    expect(falseNulls).toBe(0);
  });
});
