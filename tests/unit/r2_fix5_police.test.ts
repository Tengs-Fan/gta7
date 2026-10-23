// Round 2 fix pass 5, police cluster: no NPC fires through a colleague, a crewmate or the van he guards; a player
// hiding behind a wall can be lost; the police come for a player on the pier, the marina's decks and the beach; and
// their cars never follow him into the sea (each test fails on the code before its fix).

import { describe, expect, it } from 'vitest';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { PlayerInput } from '../../src/sim/input';
import type { MissionCtx } from '../../src/sim/missions/runner';
import { missionSpots } from '../../src/sim/missions/spots';
import type { Sim, SimOptions } from '../../src/sim/sim';
import { at, internals, longestLane, officer } from './r2_police_helpers';
import { input, makeSim, placeInCar, step, teleport } from './helpers';

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// Medium: officers shoot through the colleague in their line of fire

describe('officers never fire through anyone standing in their line of fire', () => {
  it('two officers in line in front of an armed player at 3 stars: the one behind steps aside and fires past the other', () => {
    const bad: string[] = [];
    let landed = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const sim = makeSim({ seed });
      const p = sim.player;
      p.health = 1e6;
      p.inventory.give('pistol', 48);
      p.inventory.current = 'pistol';
      const lane = longestLane(sim);
      const at40 = at(lane, 40);
      teleport(sim, at40.x, at40.z);
      const f = at(lane, 49);
      const r = at(lane, 58);
      const front = officer(sim, f.x, f.z);
      const rear = officer(sim, r.x, r.z);
      sim.wanted.setLevel(3);
      let throughFront = 0;
      let shots = 0;
      sim.events.on('damage', (e) => {
        if (e.victim === front && e.attacker === rear) throughFront++;
        if (e.victim === p && e.attacker === rear) landed++;
      });
      sim.events.on('shot', (e) => {
        if (e.shooter === rear) shots++;
      });
      step(sim, 6);
      if (throughFront > 0 || !front.alive || shots === 0) bad.push(`seed ${seed}: ${throughFront} hits on the officer in front (${front.alive ? 'alive' : 'dead'}), ${shots} shots`);
    }
    expect(bad).toEqual([]);
    // Not by never shooting: he hits the player from his new spot.
    expect(landed).toBeGreaterThan(0);
  });

  it('nor out of a cruiser window through an officer on foot by the car', () => {
    const fireFromCar = (sim: Sim, v: Vehicle) => (sim.police as unknown as { fireFromCar(v: Vehicle, d: number, level: number): void }).fireFromCar(v, Math.hypot(v.pos.x - sim.player.vehicle!.pos.x, v.pos.z - sim.player.vehicle!.pos.z), 3);
    for (const aside of [0, 4]) {
      const sim = makeSim();
      sim.missions.noBust = true;
      const lane = longestLane(sim);
      const q = at(lane, 64);
      const ride = sim.spawnVehicle('sedan', q.x, q.z, lane.heading);
      placeInCar(sim, ride);
      // A parked cruiser 24 m behind the player's car with an officer in its passenger seat, and an officer on foot
      // between them (on the line from the window, or 4 m to the side of it).
      const c = at(lane, 40);
      const cruiser = sim.spawnVehicle('police', c.x, c.z, lane.heading);
      cruiser.owner = 'police';
      const crew = sim.spawnCharacter('cop', c.x, c.z);
      internals(sim).equip(crew, cruiser);
      sim.seat(crew, cruiser, 1);
      const m = sim.combat.muzzle(crew, true);
      const w = { x: m.x + (q.x - m.x) * 0.4 - lane.dz * aside, z: m.z + (q.z - m.z) * 0.4 + lane.dx * aside };
      const walker = officer(sim, w.x, w.z);
      walker.health = walker.maxHealth = 1e6;
      sim.wanted.setLevel(3);
      let hits = 0;
      let shots = 0;
      sim.events.on('damage', (e) => {
        if (e.victim === walker && e.attacker === crew) hits++;
      });
      sim.events.on('shot', (e) => {
        if (e.shooter === crew) shots++;
      });
      for (let i = 0; i < 4 * 60; i++) {
        sim.update(DT, input());
        walker.pos.x = w.x;
        walker.pos.z = w.z;
        fireFromCar(sim, cruiser);
      }
      expect(hits, `walker ${aside} m aside`).toBe(0);
      if (aside === 0) expect(shots).toBe(0);
      else expect(shots).toBeGreaterThan(3);
    }
  });

  it('in the city at 4 stars no police round hits an officer between the shooter and the player, and few officers die', () => {
    // On the code before the fix: 222 such hits and 24 officers killed by police rounds in these four minutes. Rounds that
    // miss the player and fly on into an officer beyond him (crossfire past the player) still happen now and then.
    let between = 0;
    let killed = 0;
    for (const seed of [1, 2, 3, 4]) {
      const sim = makeSim({ ambient: true, seed });
      const p = sim.player;
      p.maxHealth = p.health = 1e7;
      p.inventory.give('pistol', 48);
      p.inventory.current = 'pistol';
      sim.wanted.setLevel(4);
      sim.wanted.floor = 4;
      sim.events.on('damage', (e) => {
        if (e.kind !== 'bullet' || !e.victim.isLaw || !e.attacker?.isLaw) return;
        if (e.killed) killed++;
        const s = e.attacker;
        const pp = sim.playerPos();
        const len = Math.hypot(pp.x - s.pos.x, pp.z - s.pos.z);
        if (((e.victim.pos.x - s.pos.x) * (pp.x - s.pos.x) + (e.victim.pos.z - s.pos.z) * (pp.z - s.pos.z)) / len < len) between++;
      });
      step(sim, 60);
    }
    expect(between).toBe(0);
    expect(killed).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Medium: The Big Score's bank guards shoot each other; low: gunmen shoot into the vehicle they guard

const STORY = ['wheels', 'delivery', 'repo', 'loose_lips', 'heatwave', 'big_score'];

function storySim(id: string, seed: number, opts: SimOptions = {}): Sim {
  const sim = makeSim({ ambient: false, police: false, seed, ...opts });
  for (const d of STORY.slice(0, STORY.indexOf(id))) sim.progress.markDone(d);
  sim.cheats.godMode = true;
  step(sim, 0.1);
  return sim;
}

function startMission(sim: Sim, id: string, until: (o: string) => boolean): MissionCtx {
  const marker = sim.interactions.markers.find((m) => m.kind === 'mission' && m.ref === id)!;
  teleport(sim, marker.x, marker.z);
  step(sim, 0.1);
  sim.update(DT, input({ interact: true }));
  const m = sim.missions.active!;
  expect(m.def.id).toBe(id);
  for (let t = 0; t < 20 && !until(m.objectiveText); t += DT) sim.update(DT, input());
  expect(until(m.objectiveText), m.objectiveText).toBe(true);
  return m;
}

describe("a mission's gunmen are one crew, and fire neither through each other nor into what they guard", () => {
  it("The Big Score's two bank guards, the player on the sidewalk past one of them in line with both: no shot at each other", () => {
    const bad: string[] = [];
    for (const seed of [1, 2]) {
      for (const left of [9, -9, 12, -12]) {
        const sim = storySim('big_score', seed);
        startMission(sim, 'big_score', (o) => o === 'Go to the First Azura Bank');
        const bank = missionSpots(sim.world).bank;
        const guards = sim.characters.filter((c) => c.owner === 'mission' && c.missionTag === 'enemy' && c.role === 'mission');
        expect(guards).toHaveLength(2);
        const h = bank.heading;
        teleport(sim, bank.x + Math.cos(h) * left + Math.sin(h) * 1.5, bank.z - Math.sin(h) * left + Math.cos(h) * 1.5);
        let hits = 0;
        let turned = 0;
        sim.events.on('damage', (e) => {
          if (guards.includes(e.victim) && e.attacker && guards.includes(e.attacker)) hits++;
        });
        step(sim, 12, () => {
          if (guards.some((g) => g.brain?.target && guards.includes(g.brain.target))) turned++;
          return input();
        });
        if (hits > 0 || turned > 0 || guards.some((g) => !g.alive)) bad.push(`seed ${seed}, ${left} m along the facade: ${hits} hits, turned on each other for ${turned} frames, ${guards.filter((g) => !g.alive).length} dead`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("Heatwave: the guard beyond a van from the player steps out from behind it instead of emptying his SMG into it", () => {
    for (const side of [1, -1]) {
      const sim = storySim('heatwave', 1);
      const m = startMission(sim, 'heatwave', (o) => o.startsWith('Destroy the vans'));
      const van = m.vehicles[0]!;
      const sx = Math.cos(van.heading);
      const sz = -Math.sin(van.heading);
      const crew = sim.characters.filter((c) => c.owner === 'mission' && c.role === 'gang' && c.alive && Math.hypot(c.pos.x - van.pos.x, c.pos.z - van.pos.z) < 6);
      const near = crew.filter((c) => ((c.pos.x - van.pos.x) * sx + (c.pos.z - van.pos.z) * sz) * side > 0);
      const far = crew.filter((c) => !near.includes(c));
      expect([near.length, far.length]).toEqual([1, 1]);
      // The player 13 m out from the van's side shoots the guard on his side; the other stands beyond the van.
      teleport(sim, van.pos.x + sx * side * (van.halfW + 13), van.pos.z + sz * side * (van.halfW + 13));
      sim.combat.damageCharacter(near[0]!, 999, sim.player, 'bullet', 0, -1, 0);
      let into = 0;
      let shots = 0;
      const damageVehicle = sim.combat.damageVehicle.bind(sim.combat);
      sim.combat.damageVehicle = (v, amount, by, kind) => {
        if (v === van && by === far[0]) into++;
        damageVehicle(v, amount, by, kind);
      };
      sim.events.on('shot', (e) => {
        if (e.shooter === far[0]) shots++;
      });
      step(sim, 40);
      // On the code before the fix: 86-89 of his rounds went into the van (down to a quarter of its health).
      expect(into, `side ${side}`).toBe(0);
      expect(m.objectiveText).toBe('Destroy the vans (0/3)');
      expect(shots, `side ${side}`).toBeGreaterThan(20);
    }
  });

  it('Repo Man: the guards never wreck the Nightjar the player shelters behind (the mission used to fail on its own)', () => {
    const bad: string[] = [];
    for (let k = 0; k < 8; k += 2) {
      const sim = storySim('repo', 1);
      const m = startMission(sim, 'repo', (o) => o === 'Steal the Nightjar GT');
      const car = m.vehicles[0]!;
      const guards = sim.characters.filter((c) => c.owner === 'mission' && c.role === 'gang' && c.alive);
      // 1.6 m out from the car's body, all round it.
      const a = (k / 8) * Math.PI * 2;
      const fx = Math.sin(car.heading);
      const fz = Math.cos(car.heading);
      const ext = Math.abs(Math.cos(a)) * car.halfW + Math.abs(Math.sin(a)) * car.halfL + 1.6;
      teleport(sim, car.pos.x + (fz * Math.cos(a) + fx * Math.sin(a)) * ext, car.pos.z + (-fx * Math.cos(a) + fz * Math.sin(a)) * ext);
      let into = 0;
      const damageVehicle = sim.combat.damageVehicle.bind(sim.combat);
      sim.combat.damageVehicle = (v, amount, by, kind) => {
        if (v === car && by && guards.includes(by as Character)) into++;
        damageVehicle(v, amount, by, kind);
      };
      step(sim, 60);
      if (into > 0 || car.destroyed || sim.missions.active !== m) bad.push(`position ${k}: ${into} rounds into the car, ${car.destroyed ? 'wrecked' : `${Math.round(car.health)} hp`}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Medium (round 2 regression): a player hiding behind a wall at 3+ stars is never lost

describe('an armed player hiding in a garage at 3 stars, an officer coming round from behind its back wall', () => {
  it('is no longer seen through the wall: the officer looks for him, gets a line of fire, or the stars clear', () => {
    const bad: string[] = [];
    const garages = makeSim().world.layout.garages;
    for (const g of garages) {
      const sim = makeSim({ seed: 3 });
      const cx = (g.rect.minX + g.rect.maxX) / 2;
      const cz = (g.rect.minZ + g.rect.maxZ) / 2;
      const [ox, oz] = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[g.side];
      const hx = (g.rect.maxX - g.rect.minX) / 2;
      const hz = (g.rect.maxZ - g.rect.minZ) / 2;
      // The player 2 m in front of the back wall; the officer 20 m out behind it.
      teleport(sim, cx - ox * (ox ? hx - 2 : 0), cz - oz * (oz ? hz - 2 : 0));
      sim.player.inventory.give('pistol', 24);
      sim.player.inventory.current = 'pistol';
      const c = officer(sim, cx - ox * (hx + 20), cz - oz * (hz + 20));
      sim.wanted.setLevel(3);
      let sight = 0;
      step(sim, 120, () => {
        const p = sim.player;
        if (!c.removed && sim.world.lineOfSight(c.pos.x, c.pos.y + 1.6, c.pos.z, p.pos.x, p.pos.y + 1.2, p.pos.z)) sight++;
        return input();
      });
      // On the code before the fix he stood 7.4 m off behind the wall for good: no line of sight, stars kept, never flashing.
      if (sight === 0 && sim.wanted.level > 0) bad.push(`${g.poi}: no line of fire in 120 s, stars still ${sim.wanted.level}`);
    }
    expect(bad).toEqual([]);
  });

  it('crimes are still heard through a wall within 8 m; sightings need a line of sight', () => {
    const sim = makeSim();
    const g = sim.world.layout.garages[0]!;
    const cx = (g.rect.minX + g.rect.maxX) / 2;
    const cz = (g.rect.minZ + g.rect.maxZ) / 2;
    const [ox, oz] = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[g.side];
    const hx = (g.rect.maxX - g.rect.minX) / 2;
    const hz = (g.rect.maxZ - g.rect.minZ) / 2;
    const inside = { x: cx - ox * (ox ? hx - 2 : 0), z: cz - oz * (oz ? hz - 2 : 0) };
    officer(sim, cx - ox * (hx + 3), cz - oz * (hz + 3));
    expect(sim.wanted.copWitness(inside.x, inside.z)).toBe(true);
    expect(sim.wanted.copWitness(inside.x, inside.z, 80, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Medium: police never come for a player on the pier, the marina's decks or the seaward half of the beach

describe('the police come for a wanted player out on the pier, the marina or the beach', () => {
  /** An unarmed player standing still at (x, z) with `stars`, in the ambient city at noon: when he is busted, or wasted (-1: never). */
  function standStill(seed: number, x: number, z: number, stars: number, secs: number): { busted: number; wasted: number } {
    const sim = makeSim({ ambient: true, seed });
    sim.clock.set(12);
    teleport(sim, x, z);
    sim.player.inventory.current = 'fists';
    sim.wanted.setLevel(stars);
    let busted = -1;
    let wasted = -1;
    sim.events.on('busted', () => {
      if (busted < 0) busted = sim.time;
    });
    sim.events.on('wasted', () => {
      if (wasted < 0) wasted = sim.time;
    });
    const p = sim.player;
    for (let t = 0; t < secs && busted < 0 && wasted < 0; t++) step(sim, 1, () => input({ aimOrigin: { x: p.pos.x - 5, y: p.pos.y + 3, z: p.pos.z }, aimDir: { x: 1, y: -0.1, z: 0 } }));
    return { busted, wasted };
  }

  it('busts him on the pier, the marina deck and a finger pier, on the wet sand and in the shallows, at 2 and 3 stars', () => {
    // On the code before the fix nobody came to any of these spots: the stars ran out at 2 stars, and at 3 they stayed for
    // good with only the helicopter overhead. Officers who could not get to him used to shoot him instead in the end.
    const runs: string[] = [];
    let busted = 0;
    for (const [name, x, z] of [
      ['pier', 560, 40],
      ['marina', 600, 446],
      ['finger pier', 592, 470],
      ['wet sand', 550, -200],
      ['shallows', 545, -200],
    ] as const) {
      for (const [stars, seed] of [
        [2, 1],
        [3, 2],
      ] as const) {
        const r = standStill(seed, x, z, stars, 90);
        if (r.busted >= 0) busted++;
        runs.push(`${name} at ${stars} stars (seed ${seed}): ${r.busted >= 0 ? `busted at ${r.busted.toFixed(1)} s` : r.wasted >= 0 ? `WASTED at ${r.wasted.toFixed(1)} s` : 'not busted in 90 s'}`);
      }
    }
    expect(runs.filter((r) => r.includes('WASTED'))).toEqual([]);
    expect(busted, runs.join('; ')).toBeGreaterThanOrEqual(9);
  });

  it('a street control is busted as before', () => {
    expect(standStill(2, 400, -183, 2, 60).busted).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Medium: police cars chasing the player across Ocean Beach drive into the sea and sink

describe('police cars chasing the player across Ocean Beach stop at the water', () => {
  function cam(sim: Sim, yaw: number, over: Partial<PlayerInput> = {}): PlayerInput {
    const p = sim.playerPos();
    return input({ cameraYaw: yaw, aimOrigin: { x: p.x - Math.sin(yaw) * 6, y: p.y + 3, z: p.z - Math.cos(yaw) * 6 }, aimDir: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }, ...over });
  }

  /** 2 stars, a sedan on the boardwalk: waits for a crewed unit within `near` m, then drives with `drive` for `secs`; the police cars that sank. */
  function escape(seed: number, z0: number, near: number, secs: number, drive: (sim: Sim, ride: Vehicle) => PlayerInput): { sunk: string[]; found: boolean } {
    const sim = makeSim({ ambient: true, seed });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const ride = sim.spawnVehicle('sedan', sim.world.layout.bounds.cityMaxX + 8, z0, Math.PI / 2);
    placeInCar(sim, ride);
    sim.wanted.setLevel(2);
    let found = false;
    for (let i = 0; i < 60 * 90 && !found; i++) {
      sim.update(DT, cam(sim, Math.PI / 2, { handbrake: true }));
      found = sim.vehicles.some((v) => v.owner === 'police' && !v.removed && !!v.driver && Math.hypot(v.pos.x - ride.pos.x, v.pos.z - ride.pos.z) < near);
    }
    const sunk: string[] = [];
    const crewed = new Set<Vehicle>();
    for (let i = 0; i < 60 * secs; i++) {
      sim.update(DT, drive(sim, ride));
      for (const v of sim.vehicles) {
        if (v.owner !== 'police' || v.removed) continue;
        if (!v.inWater && v.occupants().some((c: Character) => c.isLaw)) crewed.add(v);
        else if (v.inWater && crewed.delete(v)) sunk.push(`seed ${seed}, z ${z0}: police car #${v.id} sank at (${v.pos.x.toFixed(1)}, ${v.pos.z.toFixed(1)}) at ${sim.time.toFixed(1)} s`);
      }
    }
    return { sunk, found };
  }

  it('a sedan driven into the sea at 2 stars: no chasing police car follows it in', () => {
    // On the code before the fix a cruiser drove in after him and sank, its crew removed, in 9 of these 18 runs.
    const sunk: string[] = [];
    for (const z0 of [-200, -120, 60]) {
      for (const seed of [11, 12, 13, 14, 15, 16]) {
        const r = escape(seed, z0, 45, 25, (sim, ride) => cam(sim, Math.PI / 2, { throttle: !ride.inWater && sim.player.vehicle === ride ? 1 : 0 }));
        expect(r.found).toBe(true);
        sunk.push(...r.sunk);
      }
    }
    expect(sunk).toEqual([]);
  });

  it('a sedan turning north on the dry sand: the cruiser that overshoots him does not arc out to sea', () => {
    let turned = false;
    const r = escape(44, -150, 50, 10, (sim, ride) => {
      if (ride.pos.x > 500) turned = true;
      const want = turned ? Math.PI : Math.PI / 2;
      const off = Math.atan2(Math.sin(want - ride.heading), Math.cos(want - ride.heading));
      return cam(sim, ride.heading, { throttle: ride.speed > 16 ? 0 : 1, brake: ride.speed > 19 ? 0.6 : 0, steer: Math.max(-1, Math.min(1, -off * 2.5)) });
    });
    expect(r.found).toBe(true);
    expect(r.sunk).toEqual([]);
  });
});
