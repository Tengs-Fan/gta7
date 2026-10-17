// Regressions for the police / pedestrian AI review (cluster "police_peds").

import { describe, expect, it } from 'vitest';
import { clamp } from '../../src/core/math';
import { makeBrain } from '../../src/sim/brains';
import { Helicopter, type Character, type Vehicle } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { Sim } from '../../src/sim/sim';
import type { Lane } from '../../src/world/roads';
import { aimAt, input, makeSim, placeInCar, step, teleport } from './helpers';

/** PoliceSystem internals the scenarios need to set up. */
interface PoliceInternals {
  equip(c: Character, car: Vehicle): void;
  deploy(v: Vehicle): void;
  chasingUnits(): number;
  patrols(dt: number, level: number): void;
}
const police = (sim: Sim) => sim.police as unknown as PoliceInternals;

function longestLane(sim: Sim): Lane {
  return [...sim.roads.lanes].sort((a, b) => b.length - a.length)[0]!;
}

function at(lane: Lane, s: number): { x: number; z: number } {
  return { x: lane.sx + lane.dx * s, z: lane.sz + lane.dz * s };
}

/** Puts a vehicle on `lane` at distance `s`, moving along it at `speed`. */
function putOnLane(v: Vehicle, sim: Sim, lane: Lane, s: number, speed = 0): void {
  const p = at(lane, s);
  v.pos.x = p.x;
  v.pos.z = p.z;
  v.pos.y = sim.world.groundHeight(p.x, p.z);
  v.heading = lane.heading;
  v.vel.x = lane.dx * speed;
  v.vel.z = lane.dz * speed;
  v.ai?.setLane(lane, s);
}

function placeOnFoot(sim: Sim, c: Character, x: number, z: number): void {
  if (c.vehicle) sim.unseat(c);
  const spot = sim.world.findFreeSpot(x, z, 0.4, 10) ?? { x, z };
  c.state = 'normal';
  c.pos.x = spot.x;
  c.pos.z = spot.z;
  c.pos.y = sim.world.groundHeight(spot.x, spot.z);
}

/** A free spot about `r` m from (x, z) with a clear line of sight to it. */
function visibleSpot(sim: Sim, x: number, z: number, r: number, a0 = 0): { x: number; z: number } {
  const y = sim.world.groundHeight(x, z);
  for (let k = 0; k < 64; k++) {
    const a = a0 + (k / 64) * Math.PI * 2;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    const py = sim.world.groundHeight(px, pz);
    if (Math.abs(py - y) > 0.5 || !sim.world.isFree(px, pz, 0.6)) continue;
    if (sim.world.lineOfSight(px, py + 1.6, pz, x, y + 1.2, z)) return { x: px, z: pz };
  }
  throw new Error('no visible spot');
}

function mustSpawnUnit(sim: Sim, kind: 'police' | 'swat' = 'police'): Vehicle {
  // Spawning picks random lanes and may miss; a few attempts always find one.
  let v: Vehicle | null = null;
  for (let i = 0; i < 10 && !v; i++) v = sim.police.spawnUnit(kind, true);
  expect(v).not.toBeNull();
  return v!;
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

describe('stolen police cars', () => {
  it('never seats an officer beside the player in a stolen cruiser, so the stars can still be lost', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const lane = longestLane(sim);
    const car = sim.spawnVehicle('police', at(lane, 20).x, at(lane, 20).z, lane.heading);
    car.owner = 'police';
    // Its officer is on foot 40 m up the road when the player takes the car.
    const cop = sim.spawnCharacter('cop', at(lane, 60).x, at(lane, 60).z);
    police(sim).equip(cop, car);
    placeOnFoot(sim, cop, at(lane, 60).x, at(lane, 60).z);
    placeInCar(sim, car);
    sim.wanted.setLevel(1);
    expect(police(sim).chasingUnits()).toBe(0);
    let boarded = false;
    step(sim, 15, () => {
      if (cop.vehicle === car || car.passengers.includes(cop)) boarded = true;
      return input();
    });
    expect(boarded).toBe(false);
    expect(cop.brain!.mode).not.toBe('return');
    // The player's own car never counts as a pursuing unit.
    expect(police(sim).chasingUnits()).toBe(0);
    // Drive far away: with nobody riding along, the wanted level can be evaded.
    const far = sim.roads.node(8, 8);
    teleport(sim, far.x + 9, far.z);
    step(sim, 45);
    expect(sim.wanted.level).toBe(0);
  });

  it('does not count player-driven police cars as units or patrols', () => {
    const sim = makeSim();
    const lane = longestLane(sim);
    const mine = sim.spawnVehicle('police', at(lane, 30).x, at(lane, 30).z, lane.heading);
    mine.owner = 'police';
    placeInCar(sim, mine);
    expect(police(sim).chasingUnits()).toBe(0);
    mustSpawnUnit(sim);
    expect(police(sim).chasingUnits()).toBe(1);
    // Patrols top up to two real patrol cars around the player (each tick spawns at most one, and may miss).
    sim.ambient = true;
    for (let i = 0; i < 8; i++) police(sim).patrols(7.1, 0);
    const others = sim.vehicles.filter((v) => v.owner === 'police' && v !== mine && v.driver?.isLaw);
    expect(others.length).toBe(2);
  });
});

describe('pursuit units', () => {
  it('pull up behind a stopped player car and arrest instead of shoving it down the road', () => {
    const sim = makeSim();
    const lane = longestLane(sim);
    const car = sim.spawnVehicle('sedan', at(lane, 80).x, at(lane, 80).z, lane.heading);
    placeInCar(sim, car);
    sim.wanted.setLevel(1);
    const unit = mustSpawnUnit(sim);
    putOnLane(unit, sim, lane, 25, 18);
    const start = { x: car.pos.x, z: car.pos.z };
    let pushed = 0;
    let bustedAt = -1;
    step(sim, 25, (t) => {
      if (sim.player.vehicle === car) pushed = Math.max(pushed, dist(car.pos, start));
      if (bustedAt < 0 && sim.deathKind === 'busted') bustedAt = t;
      return input({ handbrake: true });
    });
    expect(pushed).toBeLessThan(3);
    expect(bustedAt).toBeGreaterThan(0);
  });
});

describe('arrests an unarmed player standing still at 2 stars', () => {
  for (const god of [true, false]) {
    it(`lets a foot cop walk up and arrest a player standing still (god mode ${god})`, () => {
      const sim = makeSim();
      sim.cheats.godMode = god;
      const p = sim.player;
      p.armor = 100;
      sim.wanted.setLevel(2);
      const unit = mustSpawnUnit(sim);
      const spot = visibleSpot(sim, p.pos.x, p.pos.z, 15);
      for (const c of unit.occupants()) placeOnFoot(sim, c, spot.x, spot.z);
      let outcome: string | null = null;
      step(sim, 25, () => {
        outcome ??= sim.deathKind;
        return input();
      });
      expect(outcome).toBe('busted');
    });
  }
});

describe("officers in 'return' mode", () => {
  it('drop back to the chase when the player stops next to an officer whose ride is full', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const lane = longestLane(sim);
    const pcar = sim.spawnVehicle('sedan', at(lane, 70).x, at(lane, 70).z, lane.heading);
    placeInCar(sim, pcar);
    sim.wanted.setLevel(2);
    // A full cruiser 40 m back, parked, and its third officer on foot right next to the player.
    const unit = sim.spawnVehicle('police', at(lane, 30).x, at(lane, 30).z, lane.heading);
    unit.owner = 'police';
    for (let seat = 0; seat < 2; seat++) {
      const c = sim.spawnCharacter('cop', unit.pos.x, unit.pos.z);
      police(sim).equip(c, unit);
      sim.seat(c, unit, seat);
    }
    const sx = Math.cos(pcar.heading);
    const sz = -Math.sin(pcar.heading);
    const straggler = sim.spawnCharacter('cop', pcar.pos.x + sx * 6, pcar.pos.z + sz * 6);
    police(sim).equip(straggler, unit);
    placeOnFoot(sim, straggler, pcar.pos.x + sx * 6, pcar.pos.z + sz * 6);
    straggler.brain!.mode = 'return';
    let shots = 0;
    sim.events.on('shot', (e) => {
      if (e.shooter === straggler) shots++;
    });
    step(sim, 3);
    expect(straggler.brain!.mode).not.toBe('return');
    expect(dist(straggler.pos, pcar.pos)).toBeLessThan(12);
    expect(shots).toBeGreaterThan(0);
  });
});

describe('wanted level 0', () => {
  it('waits for the whole crew to get back in before the car leaves', () => {
    const sim = makeSim();
    const lane = longestLane(sim);
    sim.wanted.setLevel(1);
    const unit = mustSpawnUnit(sim);
    putOnLane(unit, sim, lane, 40, 0);
    const crew = unit.occupants();
    expect(crew.length).toBe(2);
    police(sim).deploy(unit);
    placeOnFoot(sim, crew[0]!, at(lane, 32).x, at(lane, 32).z);
    placeOnFoot(sim, crew[1]!, at(lane, 52).x, at(lane, 52).z);
    // The player watches from the sidewalk (right of the lane), out of the car's way.
    const side = sim.world.findFreeSpot(at(lane, 60).x - lane.dz * 8, at(lane, 60).z + lane.dx * 8, 0.5, 6)!;
    teleport(sim, side.x, side.z);
    sim.wanted.clear();
    let boardedBoth = false;
    step(sim, 30, () => {
      if (crew.every((c) => c.vehicle === unit)) boardedBoth = true;
      return input();
    });
    expect(boardedBoth).toBe(true);
    expect(dist(unit.pos, at(lane, 40))).toBeGreaterThan(10);
  });

  it('lets officers too far from their car walk off so cleanup can remove them', () => {
    const sim = makeSim();
    sim.wanted.setLevel(1);
    const unit = mustSpawnUnit(sim);
    const crew = unit.occupants();
    police(sim).deploy(unit);
    const p = sim.player.pos;
    placeOnFoot(sim, crew[0]!, p.x + 3, p.z);
    expect(dist(crew[0]!.pos, unit.pos)).toBeGreaterThan(60);
    sim.wanted.clear();
    step(sim, 2);
    expect(crew[0]!.brain!.car).toBeNull();
  });
});

describe('searching', () => {
  it('sweeps the last-seen area instead of homing in on a hidden player, who can then lose the stars', () => {
    const sim = makeSim({ ambient: true });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const node = sim.roads.node(3, 6);
    teleport(sim, node.x + 10, node.z + 10);
    sim.wanted.setLevel(3);
    step(sim, 15);
    expect(sim.vehicles.filter((v) => v.owner === 'police' && v.driver?.isLaw).length).toBeGreaterThanOrEqual(2);
    expect(sim.helis.length).toBeGreaterThan(0);
    // The player slipped away a while ago and hides out of sight, 400+ m from his last sighting.
    const hide = sim.roads.node(7, 3);
    teleport(sim, hide.x + 10, hide.z + 12);
    sim.wanted.lastSeen = sim.time - 3;
    let searchFrames = 0;
    let homing = 0;
    let heliClosest = Infinity;
    let wasSearching = false;
    step(sim, 40, () => {
      const w = sim.wanted;
      // `searching` flips at the end of a frame; the police react in the next one.
      const searching = w.level > 0 && w.searching;
      const check = searching && wasSearching;
      wasSearching = searching;
      if (check) {
        searchFrames++;
        for (const v of sim.vehicles) {
          if (v.owner !== 'police' || !v.ai || !v.driver?.isLaw) continue;
          const d = v.ai.dest;
          if (v.ai.target || !d || Math.hypot(d.x - w.lastSeenX, d.z - w.lastSeenZ) > w.searchRadius() + 5) homing++;
        }
        for (const h of sim.helis) heliClosest = Math.min(heliClosest, dist(h.pos, sim.playerPos()));
      }
      return input();
    });
    expect(searchFrames).toBeGreaterThan(60);
    expect(homing).toBe(0);
    expect(heliClosest).toBeGreaterThan(110);
    expect(sim.wanted.level).toBe(0);
  });

  it('sends officers on foot to the last sighting, not to where the player hides', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const p = sim.player;
    sim.wanted.setLevel(2);
    // Round 2 (police, P10): no response phase, in which the police would know where he hides.
    sim.wanted.responseUntil = 0;
    const unit = mustSpawnUnit(sim);
    const crew = unit.occupants();
    const spot = visibleSpot(sim, p.pos.x, p.pos.z, 12);
    for (const c of crew) placeOnFoot(sim, c, spot.x, spot.z);
    step(sim, 2);
    const seen = { x: sim.wanted.lastSeenX, z: sim.wanted.lastSeenZ };
    // Hide about 140 m away.
    const n = sim.roads.nearestNode(p.pos.x + 150, p.pos.z + 40);
    teleport(sim, n.x + 9, n.z + 9);
    let closest = Infinity;
    let farthest = 0;
    step(sim, 30, () => {
      if (sim.wanted.level > 0 && sim.wanted.searching) {
        for (const c of crew) {
          closest = Math.min(closest, dist(c.pos, p.pos));
          farthest = Math.max(farthest, dist(c.pos, seen));
        }
      }
      return input();
    });
    expect(closest).toBeGreaterThan(80);
    expect(farthest).toBeLessThan(50);
    expect(sim.wanted.level).toBe(0);
  });
});

describe('police helicopter', () => {
  it('never flies inside downtown towers', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const L = sim.world.layout;
    const tower = L.buildings.filter((b) => b.district === 'downtown').sort((a, b) => Math.max(...b.tiers.map((t) => t.y1)) - Math.max(...a.tiers.map((t) => t.y1)))[0]!;
    const spot = sim.world.findFreeSpot((tower.rect.minX + tower.rect.maxX) / 2, tower.rect.maxZ + 3, 0.5, 12)!;
    teleport(sim, spot.x, spot.z);
    sim.wanted.setLevel(3);
    sim.helis.push(new Helicopter(sim.newId(), spot.x + 180, 175, spot.z + 60));
    const solids = sim.world.grid.colliders.filter((c) => c.tag === 'building');
    let samples = 0;
    let inside = 0;
    step(sim, 50, () => {
      for (const h of sim.helis) {
        if (h.removed || h.crashing) continue;
        samples++;
        // Body, skids and rotor plane: about 1.5 m above and below the centre.
        if (solids.some((c) => h.pos.x > c.minX && h.pos.x < c.maxX && h.pos.z > c.minZ && h.pos.z < c.maxZ && h.pos.y - 1.5 < c.y1 && h.pos.y + 1.5 > c.y0)) inside++;
      }
      return input();
    });
    expect(samples).toBeGreaterThan(2500);
    expect(inside).toBe(0);
  });

  it('keeps its usual low orbit over low-rise districts', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const p = sim.player.pos;
    sim.wanted.setLevel(3);
    sim.helis.push(new Helicopter(sim.newId(), p.x + 100, 60, p.z));
    step(sim, 20);
    const h = sim.helis[0]!;
    expect(h.pos.y - sim.world.groundHeight(p.x, p.z)).toBeLessThan(40);
    expect(dist(h.pos, p)).toBeLessThan(40);
  });
});

describe('NPC shooters', () => {
  it('fire from a muzzle on the side facing their target', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const p = sim.player;
    const gSpot = visibleSpot(sim, p.pos.x, p.pos.z, 10);
    const g = sim.spawnCharacter('gang', gSpot.x, gSpot.z);
    const b = makeBrain('fight');
    b.hostile = true;
    b.brave = true;
    b.target = p;
    b.modeTimer = 999;
    g.brain = b;
    g.inventory.infinite = true;
    g.inventory.give('pistol', 999);
    g.inventory.current = 'pistol';
    sim.wanted.setLevel(2);
    const unit = mustSpawnUnit(sim);
    const cop = unit.occupants()[0]!;
    const ga = Math.atan2(gSpot.z - p.pos.z, gSpot.x - p.pos.x);
    const cSpot = visibleSpot(sim, p.pos.x, p.pos.z, 12, ga + Math.PI);
    placeOnFoot(sim, cop, cSpot.x, cSpot.z);
    let shots = 0;
    let backwards = 0;
    sim.events.on('shot', (e) => {
      const s = e.shooter;
      if (s !== g && s !== cop) return;
      shots++;
      const t = s === g ? (g.brain!.target ?? p) : p;
      const tx = t.pos.x - s.pos.x;
      const tz = t.pos.z - s.pos.z;
      if ((e.fx - s.pos.x) * tx + (e.fz - s.pos.z) * tz <= 0) backwards++;
    });
    step(sim, 4);
    expect(shots).toBeGreaterThan(3);
    expect(backwards).toBe(0);
  });
});

describe('gang loyalty', () => {
  function guards(sim: Sim, n: number): Character[] {
    const p = sim.player.pos;
    const base = visibleSpot(sim, p.x, p.z, 11);
    const out: Character[] = [];
    for (let i = 0; i < n; i++) {
      const s = sim.world.findFreeSpot(base.x + (i - 1) * 2.5, base.z, 0.5, 6)!;
      const g = sim.spawnCharacter('gang', s.x, s.z);
      g.owner = 'mission';
      g.persistent = true;
      g.missionTag = 'enemy';
      const b = makeBrain('guard');
      b.homeX = s.x;
      b.homeZ = s.z;
      b.brave = true;
      b.hostile = true;
      b.accuracy = 0.3;
      g.brain = b;
      g.inventory.infinite = true;
      g.inventory.give('pistol', 999);
      g.inventory.current = 'pistol';
      out.push(g);
    }
    return out;
  }

  it('keeps hostile guards on the player instead of each other when one opens fire', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    const p = sim.player;
    const gs = guards(sim, 3);
    sim.peds.fight(gs[0]!, p);
    let turned = 0;
    step(sim, 6, () => {
      for (const g of gs) if (g.brain!.target && g.brain!.target !== p) turned++;
      return input();
    });
    expect(turned).toBe(0);
    expect(gs.every((g) => g.alive)).toBe(true);
    // The rest of the crew backs him up.
    expect(gs.filter((g) => g.brain!.target === p).length).toBe(3);
  });

  it('never lets rampage gangs retarget each other', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.activities.startRampage('test');
    let turned = 0;
    step(sim, 25, () => {
      for (const c of sim.characters) if (c.missionTag === 'rampage' && c.alive && c.brain?.target && !c.brain.target.isPlayer) turned++;
      return input();
    });
    expect(sim.characters.some((c) => c.missionTag === 'rampage')).toBe(true);
    expect(turned).toBe(0);
  });
});

describe('fleeing', () => {
  it('gets the driver of a burning car away from it alive', () => {
    const sim = makeSim();
    const lane = longestLane(sim);
    const v = sim.spawnVehicle('sedan', at(lane, 40).x, at(lane, 40).z, lane.heading);
    v.owner = 'traffic';
    const driver = sim.addDriver(v, 'civilian', 'traffic');
    driver.owner = 'traffic';
    sim.combat.igniteVehicle(v, 4);
    step(sim, 7);
    expect(v.destroyed).toBe(true);
    expect(driver.alive).toBe(true);
    expect(dist(driver.pos, v.pos)).toBeGreaterThan(8);
  });

  it('works for characters spawned without a brain', () => {
    const sim = makeSim();
    const p = sim.player.pos;
    const spot = visibleSpot(sim, p.x, p.z, 8);
    const c = sim.spawnCharacter('civilian', spot.x, spot.z);
    expect(c.brain).toBeNull();
    sim.peds.flee(c, p.x, p.z, null);
    expect(c.brain?.mode).toBe('flee');
    const d0 = dist(c.pos, p);
    step(sim, 1.5);
    expect(dist(c.pos, p)).toBeGreaterThan(d0 + 4);
  });
});

// ---------------------------------------------------------------------------
// Round 2 (cluster "police").

/** A sidewalk spot on the corner of intersection (i, j). */
function corner(sim: Sim, i: number, j: number): { x: number; z: number } {
  const n = sim.roads.node(i, j);
  return sim.world.findFreeSpot(n.x + n.halfX + 3, n.z + n.halfZ + 3, 0.5, 8)!;
}

/** Wanted at `level`, and out of sight of the police since a moment ago (where he stands now). */
function lostSight(sim: Sim, level: number): void {
  sim.wanted.setLevel(level);
  // Round 2 (police, P10): no response phase, in which the police would know where he is.
  sim.wanted.responseUntil = 0;
  sim.wanted.lastSeen = sim.time - 3;
  sim.wanted.searching = true;
}

describe('searching with reinforcements', () => {
  for (const level of [1, 2]) {
    it(`sends units to search for a player who stays where he was last seen (${level} star${level > 1 ? 's' : ''})`, () => {
      const sim = makeSim({ ambient: true });
      sim.cheats.godMode = true;
      sim.missions.noBust = true;
      const spot = corner(sim, 4, 4);
      teleport(sim, spot.x, spot.z);
      // No unit is near yet: every one has to come from dispatch.
      lostSight(sim, level);
      const seenAt = sim.wanted.lastSeen;
      const searchers = new Set<Vehicle>();
      let foundAt = -1;
      step(sim, 40, (t) => {
        const w = sim.wanted;
        if (foundAt < 0 && w.lastSeen > seenAt) foundAt = t;
        if (foundAt < 0) {
          for (const v of sim.vehicles) {
            const d = v.ai?.dest;
            if (v.owner === 'police' && v.driver?.isLaw && !v.ai!.target && d && Math.hypot(d.x - w.lastSeenX, d.z - w.lastSeenZ) <= w.searchRadius()) searchers.add(v);
          }
        }
        return input();
      });
      expect(searchers.size).toBeGreaterThan(0);
      // They find him well before he could sit the stars out.
      expect(foundAt).toBeGreaterThan(0);
      expect(sim.wanted.level).toBe(level);
    });
  }

  it('still lets a player who leaves the search area lose the stars, with reinforcements sweeping the area', () => {
    const sim = makeSim({ ambient: true });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const spot = corner(sim, 4, 4);
    teleport(sim, spot.x, spot.z);
    lostSight(sim, 2);
    // He slipped three blocks away, out of the area.
    const hide = corner(sim, 7, 4);
    teleport(sim, hide.x, hide.z);
    const searchers = new Set<Vehicle>();
    let homing = 0;
    step(sim, 30, () => {
      const w = sim.wanted;
      if (w.level > 0 && w.searching) {
        for (const v of sim.vehicles) {
          if (v.owner !== 'police' || !v.ai || !v.driver?.isLaw) continue;
          const d = v.ai.dest;
          if (v.ai.target || !d || Math.hypot(d.x - w.lastSeenX, d.z - w.lastSeenZ) > w.searchRadius() + 5) homing++;
          else searchers.add(v);
        }
      }
      return input();
    });
    expect(searchers.size).toBeGreaterThan(0);
    expect(homing).toBe(0);
    expect(sim.wanted.level).toBe(0);
  });

  it('keeps searching units around the area instead of losing them to cleanup or crashes', () => {
    let units = 0;
    let lost = 0;
    for (const [i, j] of [[2, 2], [4, 1], [7, 7], [3, 6], [6, 3], [5, 8], [1, 4], [4, 4]] as const) {
      const sim = makeSim({ seed: 3 });
      sim.cheats.godMode = true;
      sim.missions.noBust = true;
      const spot = corner(sim, i, j);
      teleport(sim, spot.x, spot.z);
      sim.wanted.setLevel(2);
      // A long search: the mission floor keeps the stars while he hides four blocks away.
      sim.wanted.floor = 2;
      const crew: Vehicle[] = [];
      for (let k = 0; k < 40 && crew.length < 3; k++) {
        const v = sim.police.spawnUnit('police', true);
        if (v) crew.push(v);
      }
      lostSight(sim, 2);
      const hide = corner(sim, i < 5 ? i + 4 : i - 4, j);
      teleport(sim, hide.x, hide.z);
      step(sim, 90);
      units += crew.length;
      lost += crew.filter((v) => v.removed || v.destroyed).length;
    }
    expect(units).toBe(24);
    expect(lost).toBeLessThanOrEqual(8);
  });
});

describe('police helicopter sightings', () => {
  /** Last seen on the road in front of the tallest downtown tower, now hiding against its far wall. */
  function towerHideout(sim: Sim): { seen: { x: number; z: number }; hide: { x: number; z: number } } {
    const height = (b: (typeof sim.world.layout.buildings)[number]) => Math.max(...b.tiers.map((t) => t.y1));
    const tower = sim.world.layout.buildings.filter((b) => b.district === 'downtown').sort((a, b) => height(b) - height(a))[0]!;
    const cx = (tower.rect.minX + tower.rect.maxX) / 2;
    const { lane, s } = sim.roads.nearestLane(cx, tower.rect.minZ - 14);
    return { seen: at(lane, s), hide: sim.world.findFreeSpot(cx, tower.rect.maxZ + 1.2, 0.4, 3)! };
  }

  /** 3 stars, last seen at `seen` a moment ago, now at `spot`, with the helicopter circling the sighting. */
  function heliSearch(sim: Sim, seen: { x: number; z: number }, spot: { x: number; z: number }): number {
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    teleport(sim, seen.x, seen.z);
    sim.wanted.setLevel(3);
    // Round 2 (police, P10): no response phase, in which the police would know where he is.
    sim.wanted.responseUntil = 0;
    teleport(sim, spot.x, spot.z);
    sim.wanted.lastSeen = sim.time - 3;
    sim.wanted.searching = true;
    sim.helis.push(new Helicopter(sim.newId(), seen.x + 24, sim.world.groundHeight(seen.x, seen.z) + 36, seen.z));
    return sim.wanted.lastSeen;
  }

  it('cannot see through a tower: hiding behind one near the last sighting loses the stars', () => {
    const sim = makeSim();
    const { seen, hide } = towerHideout(sim);
    const seenAt = heliSearch(sim, seen, hide);
    let closest = Infinity;
    let spotted = false;
    step(sim, 70, () => {
      if (sim.wanted.level > 0 && sim.wanted.lastSeen > seenAt) spotted = true;
      for (const h of sim.helis) closest = Math.min(closest, dist(h.pos, sim.player.pos));
      return input();
    });
    // In sighting range nearly all along, but never in sight.
    expect(closest).toBeLessThan(110);
    expect(spotted).toBe(false);
    expect(sim.wanted.level).toBe(0);
  });

  it('still spots a player out in the open', () => {
    const sim = makeSim();
    const { seen } = towerHideout(sim);
    const seenAt = heliSearch(sim, seen, seen);
    step(sim, 20);
    expect(sim.wanted.level).toBe(3);
    expect(sim.wanted.lastSeen).toBeGreaterThan(seenAt);
    expect(sim.time - sim.wanted.lastSeen).toBeLessThan(1);
  });
});

describe('arrests against an armed player', () => {
  /** 2 stars; the two officers of a unit on foot, 16 and 20 m away in sight, and too tough to drop. */
  function standoff(sim: Sim): Character[] {
    const p = sim.player;
    sim.cheats.godMode = true;
    sim.wanted.setLevel(2);
    const crew = mustSpawnUnit(sim).occupants();
    const a = visibleSpot(sim, p.pos.x, p.pos.z, 16);
    const b = visibleSpot(sim, p.pos.x, p.pos.z, 20, Math.atan2(a.z - p.pos.z, a.x - p.pos.x) + 0.6);
    [a, b].forEach((s, k) => {
      const c = crew[k]!;
      placeOnFoot(sim, c, s.x, s.z);
      c.maxHealth = 1e6;
      c.health = 1e6;
    });
    p.inventory.give('pistol', 500);
    p.inventory.current = 'pistol';
    return crew;
  }

  function countShots(sim: Sim, crew: Character[]): Map<Character, number> {
    const shots = new Map<Character, number>(crew.map((c) => [c, 0]));
    sim.events.on('shot', (e) => {
      if (e.shooter && shots.has(e.shooter)) shots.set(e.shooter, shots.get(e.shooter)! + 1);
    });
    return shots;
  }

  const chest = (c: Character) => ({ x: c.pos.x, y: c.pos.y + 1.3, z: c.pos.z });

  it('has every officer, the nearest included, fire back at a player who stands and shoots', () => {
    const sim = makeSim();
    const crew = standoff(sim);
    const shots = countShots(sim, crew);
    let frame = 0;
    step(sim, 8, () => aimAt(sim, chest(crew[0]!), { aim: true, fire: true, firePressed: frame++ % 18 === 0 }));
    expect(sim.deathKind).toBeNull();
    for (const c of crew) expect(shots.get(c)).toBeGreaterThan(3);
  });

  it('walks up and arrests him once he puts the gun away', () => {
    const sim = makeSim();
    const crew = standoff(sim);
    let frame = 0;
    step(sim, 3, () => aimAt(sim, chest(crew[0]!), { aim: true, fire: true, firePressed: frame++ % 18 === 0 }));
    expect(sim.deathKind).toBeNull();
    let outcome: string | null = null;
    step(sim, 15, (t) => {
      outcome ??= sim.deathKind;
      return input({ selectSlot: t === 0 ? 0 : -1 });
    });
    expect(sim.player.inventory.current).toBe('fists');
    expect(outcome).toBe('busted');
  });

  it('fires back at a player shooting from a stopped car, and arrests him once he stops', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    const lane = longestLane(sim);
    const car = sim.spawnVehicle('sedan', at(lane, 60).x, at(lane, 60).z, lane.heading);
    placeInCar(sim, car);
    sim.player.inventory.give('pistol', 500);
    sim.player.inventory.current = 'pistol';
    sim.wanted.setLevel(2);
    const crew = mustSpawnUnit(sim).occupants();
    crew.forEach((c, k) => {
      placeOnFoot(sim, c, at(lane, 46 - k * 5).x, at(lane, 46 - k * 5).z);
      c.maxHealth = 1e6;
      c.health = 1e6;
    });
    const shots = countShots(sim, crew);
    let frame = 0;
    step(sim, 5, () => aimAt(sim, chest(crew[0]!), { handbrake: true, fire: true, firePressed: frame++ % 18 === 0 }));
    expect(sim.deathKind).toBeNull();
    for (const c of crew) expect(shots.get(c)).toBeGreaterThan(3);
    let outcome: string | null = null;
    step(sim, 15, () => {
      outcome ??= sim.deathKind;
      return input({ handbrake: true });
    });
    expect(outcome).toBe('busted');
  });
});

describe('pursuit units at speed', () => {
  it('never lock the handbrake behind a player who lifts off the throttle', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const lane = longestLane(sim);
    const car = sim.spawnVehicle('sedan', at(lane, 30).x, at(lane, 30).z, lane.heading);
    placeInCar(sim, car);
    putOnLane(car, sim, lane, 30, 20);
    sim.wanted.setLevel(1);
    const unit = mustSpawnUnit(sim);
    putOnLane(unit, sim, lane, 15, 24);
    let locked = 0;
    step(sim, 5, (t) => {
      if (unit.speed > 8 && (unit.ai?.hold || unit.controls.handbrake)) locked++;
      return input({ throttle: t < 2 ? 1 : 0 });
    });
    expect(locked).toBe(0);
    // It stayed on his tail all along.
    expect(dist(unit.pos, car.pos)).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
// Round 2 follow-up (cluster "police").

describe('searching while the player is far from the last sighting', () => {
  /** Ambient dispatch, but no traffic or pedestrians streaming in: only the police come and go. */
  function dispatchOnly(seed: number): Sim {
    const sim = makeSim({ ambient: true, seed });
    sim.traffic.updateStreaming = () => {};
    sim.peds.updateStreaming = () => {};
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    return sim;
  }

  /** Steps `seconds` of a search with no unit around yet: what went wrong for the player, if anything, and how many units were sent. */
  function evade(sim: Sim, seconds: number, inp: () => PlayerInput = () => input()): { failed: string | null; sent: number } {
    const w = sim.wanted;
    const seen = { x: w.lastSeenX, z: w.lastSeenZ };
    const seenAt = w.lastSeen;
    const sent = new Set<Vehicle>();
    let againAt = -1;
    let againDist = 0;
    step(sim, seconds, (t) => {
      if (againAt < 0 && w.lastSeen > seenAt) {
        againAt = t;
        againDist = dist(sim.playerPos(), seen);
      }
      if (w.level > 0) for (const v of sim.vehicles) if (v.owner === 'police') sent.add(v);
      return inp();
    });
    const failed = againAt >= 0 ? `seen again after ${againAt.toFixed(1)} s, ${Math.round(againDist)} m from the sighting` : w.level > 0 ? 'kept the stars' : null;
    return { failed, sent: sent.size };
  }

  it('lets a player standing 450-800 m from his last sighting lose the stars: no unit sent to the search passes him', () => {
    const failures: string[] = [];
    let sent = 0;
    for (const level of [1, 2]) {
      for (const [li, lj, fi, fj, seed] of [
        [1, 1, 7, 7, 1], [2, 8, 8, 2, 2], [8, 8, 2, 3, 3], [1, 5, 8, 5, 4], [5, 1, 5, 8, 5], [9, 2, 2, 7, 6],
        [3, 3, 9, 8, 7], [7, 1, 1, 6, 8], [4, 9, 6, 2, 9], [1, 2, 6, 3, 10], [8, 1, 3, 2, 11], [5, 9, 5, 3, 12],
      ] as const) {
        const sim = dispatchOnly(seed);
        const seen = corner(sim, li, lj);
        teleport(sim, seen.x, seen.z);
        lostSight(sim, level);
        const hide = corner(sim, fi, fj);
        teleport(sim, hide.x, hide.z);
        const run = evade(sim, 30);
        sent += run.sent;
        if (run.failed) failures.push(`${level} star(s), (${li},${lj}) -> (${fi},${fj}): ${run.failed}`);
      }
    }
    expect(failures).toEqual([]);
    // The search was reinforced all the same.
    expect(sent).toBeGreaterThan(0);
  });

  it('lets a player driving away from 450 to 870 m from his last sighting lose the stars', () => {
    const failures: string[] = [];
    for (const level of [1, 2]) {
      for (const [j, dir, seed] of [[2, 1, 1], [3, -1, 2], [5, 1, 3], [7, -1, 4], [8, 1, 5], [2, -1, 6], [3, 1, 7], [5, -1, 8], [7, 1, 9], [8, -1, 10]] as const) {
        const sim = dispatchOnly(seed);
        // Last seen at one end of a street across town, now driving along it from the middle to the other end.
        const end = sim.roads.node(dir > 0 ? 0 : 10, j);
        const seen = sim.world.findFreeSpot(end.x + dir * (end.halfX + 3), end.z + end.halfZ + 3, 0.5, 8)!;
        const middle = sim.roads.node(5, j);
        const lane = sim.roads.lanes.find((l) => l.from === middle.id && Math.abs(l.dx - dir) < 0.01)!;
        const car = sim.spawnVehicle('sports', lane.sx + lane.dx * 10, lane.sz, lane.heading);
        placeInCar(sim, car);
        const from = { x: car.pos.x, z: car.pos.z };
        teleport(sim, seen.x, seen.z);
        lostSight(sim, level);
        teleport(sim, from.x, from.z);
        car.vel.x = dir * 25;
        const run = evade(sim, 30, () => {
          // Keep to the lane at 25 m/s, and stop before the edge of town.
          const az = lane.sz - car.pos.z;
          const right = dir * 20 * -Math.cos(car.heading) + az * Math.sin(car.heading);
          const want = Math.abs(car.pos.x) > 400 ? 0 : 25;
          return input({ throttle: car.speed < want - 0.5 ? 1 : 0, brake: car.speed > want + 2 ? 1 : 0, steer: clamp((right / Math.hypot(20, az)) * 2.5, -1, 1) });
        });
        if (run.failed) failures.push(`${level} star(s), street ${j} heading ${dir > 0 ? 'east' : 'west'}: ${run.failed}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('starts every unit sent to a search far from the player nearer to the sighting, heading for it and away from him', () => {
    const wrong: string[] = [];
    let sent = 0;
    for (const [level, li, lj, fi, fj] of [
      [1, 8, 3, 2, 1], [1, 2, 5, 9, 4], [1, 0, 6, 8, 5], [1, 4, 0, 4, 8], [2, 1, 7, 8, 6], [2, 5, 0, 5, 7], [2, 9, 9, 3, 2], [2, 0, 2, 7, 3],
    ] as const) {
      const sim = makeSim({ seed: li * 10 + lj });
      const seen = corner(sim, li, lj);
      teleport(sim, seen.x, seen.z);
      lostSight(sim, level);
      const hide = corner(sim, fi, fj);
      teleport(sim, hide.x, hide.z);
      for (let k = 0; k < 40; k++) {
        const v = sim.police.spawnUnit('police', true);
        if (!v) continue;
        sent++;
        const fx = Math.sin(v.heading);
        const fz = Math.cos(v.heading);
        const toSeen = (seen.x - v.pos.x) * fx + (seen.z - v.pos.z) * fz;
        const fromHim = (v.pos.x - hide.x) * fx + (v.pos.z - hide.z) * fz;
        if (dist(v.pos, seen) > dist(hide, seen) || toSeen < 0 || fromHim < 0) wrong.push(`${level} star(s), (${li},${lj}) -> (${fi},${fj}): unit at (${Math.round(v.pos.x)}, ${Math.round(v.pos.z)})`);
        // Off duty again (crew and all), so the next one finds a spot of its own.
        sim.removeVehicle(v);
      }
    }
    expect(wrong).toEqual([]);
    expect(sent).toBeGreaterThan(25);
  });
});
