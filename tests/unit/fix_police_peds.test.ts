// Regressions for the police / pedestrian AI review (cluster "police_peds").

import { describe, expect, it } from 'vitest';
import { makeBrain } from '../../src/sim/brains';
import { Helicopter, type Character, type Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import type { Lane } from '../../src/world/roads';
import { input, makeSim, placeInCar, step, teleport } from './helpers';

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

describe('arrests at 2+ stars', () => {
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
