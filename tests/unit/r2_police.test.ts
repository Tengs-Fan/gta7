// Round 2, cluster "police": police that fight, chase and can be read.
// Lethal force and arrests (P9), the response phase and pursuit units (P10), escalation and consequences
// (P62), the helicopter's sight and spotlight (P88), readable evasion on the radar and map (P24) and dispatch
// chatter (P58). The statistical cases, rates and medians over many seeds, have files of their own:
// r2_police_force (P9 in the ambient city), r2_police_pursuit and r2_police_pursuit5 (flee-bot pursuits),
// r2_police_escape and r2_police_escape3 (losing the stars) and r2_police_dispatch (a long chase).

import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beamFade, MarkerView } from '../../src/render/markers';
import { colourName, compassName } from '../../src/sim/dispatch';
import { Helicopter, type Character, type Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { HELI_DASH_SPEED, HELI_SPEED, SPOT_REACH } from '../../src/sim/police';
import { HELI_NIGHT_SIGHT, HELI_SIGHT, RESPONSE_BASE, RESPONSE_PER_STAR, RISE_GAP, SPOT_RADIUS, SPOT_SEE } from '../../src/sim/wanted';
import { collectBlips, HELI_SIGHT_RANGE, searchArea } from '../../src/ui/mapRender';
import { aimAt, input, makeSim, placeInCar, step, teleport } from './helpers';
import { at, chaseCamera, countPoliceShots, dist, fleeBot, internals, liveUnits, longestLane, officer, seedMathRandom, stepUntil, visibleSpot } from './r2_police_helpers';

// Headless render stubs (copied from fix_render.test.ts): the procedural textures need a 2D canvas.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = (): unknown => {
    const store: Record<string | symbol, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      measureText: () => ({ width: 100 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
    };
    // Every other 2D call is a no-op; property writes are kept.
    return new Proxy(store, {
      get: (o, k) => (k in o ? o[k] : () => {}),
      set: (o, k, v) => {
        o[k] = v;
        return true;
      },
    });
  };
  const canvas = (): Record<string, unknown> => ({
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 720,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? ctx2d() : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  g.document ??= { createElement: canvas, createElementNS: canvas };
  g.window ??= { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: () => {} };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Ends the response phase that a new level starts (the police then only know what they see). */
function noResponse(sim: Sim): void {
  sim.wanted.responseUntil = 0;
}

// ---------------------------------------------------------------------------
// P9: lethal force from 3 stars, fire from cars, arrests only of a player who stopped fighting

describe('lethal force and arrests', () => {
  // The statistical cases (standing still at 4 stars, the rifle at 4-5 stars) are in r2_police_force.test.ts.

  it('at 2 stars a cop 15 m away busts an unarmed player standing still within 8 s', () => {
    const sim = makeSim();
    const p = sim.player;
    sim.wanted.setLevel(2);
    const spot = visibleSpot(sim, p.pos.x, p.pos.z, 15);
    officer(sim, spot.x, spot.z);
    const t = stepUntil(sim, 8, () => sim.deathKind === 'busted');
    expect(t).toBeGreaterThan(0);
  });

  it('an officer 20 m above the player (on a roof) never busts him; one beside him does', () => {
    for (const above of [20, 0]) {
      const sim = makeSim();
      sim.cheats.godMode = true;
      const p = sim.player;
      sim.wanted.setLevel(2);
      const cop = officer(sim, p.pos.x + 1, p.pos.z);
      const t = stepUntil(sim, 10, () => sim.deathKind === 'busted', () => {
        // Pinned right beside him: on his level, or up on a roof.
        cop.pos.x = p.pos.x + 1;
        cop.pos.z = p.pos.z;
        cop.pos.y = p.pos.y + above;
        cop.vel.x = cop.vel.y = cop.vel.z = 0;
        return input();
      });
      if (above > 0) expect(t, 'busted from the roof').toBe(-1);
      else expect(t).toBeGreaterThan(0);
    }
  });

  it('at 1 star a passive player draws no police fire', () => {
    seedMathRandom(7);
    const sim = makeSim({ ambient: true, seed: 7 });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    sim.wanted.setLevel(1);
    const shots = countPoliceShots(sim, true);
    let officersNear = 0;
    step(sim, 30, () => {
      if (sim.characters.some((c) => c.isLaw && c.state === 'normal' && dist(c.pos, sim.player.pos) < 20)) officersNear++;
      return input();
    });
    // They came for him on foot, and nobody fired.
    expect(officersNear).toBeGreaterThan(0);
    expect(shots.n).toBe(0);
  });

  it('at 1 star a player holding an officer at gunpoint is fired on within a few seconds, and one aiming elsewhere is arrested', () => {
    // Round 2 fix pass (police): holding the aim button used to make a 1-star player impossible to arrest,
    // and nobody fired either, so the officer stood at arm's length for ever.
    for (const atCop of [true, false]) {
      const sim = makeSim();
      sim.cheats.godMode = true;
      const p = sim.player;
      p.inventory.give('pistol', 48);
      p.inventory.current = 'pistol';
      sim.wanted.setLevel(1);
      const spot = visibleSpot(sim, p.pos.x, p.pos.z, 10);
      const cop = officer(sim, spot.x, spot.z);
      cop.health = cop.maxHealth = 1e6;
      const shots = countPoliceShots(sim);
      let bustedAt = -1;
      const aim = (t: number) => {
        if (bustedAt < 0 && sim.deathKind === 'busted') bustedAt = t;
        return atCop ? aimAt(sim, { x: cop.pos.x, y: cop.pos.y + 1.2, z: cop.pos.z }, { aim: true }) : aimAt(sim, { x: p.pos.x + 0.5, y: p.pos.y + 30, z: p.pos.z + 0.5 }, { aim: true });
      };
      const firedAt = stepUntil(sim, 6, () => shots.n > 0, aim);
      if (atCop) {
        expect(firedAt, 'fired on').toBeGreaterThan(0);
        expect(firedAt).toBeLessThan(4);
        expect(bustedAt).toBe(-1);
      } else {
        expect(bustedAt, 'aiming at the sky: busted').toBeGreaterThan(0);
        expect(bustedAt).toBeLessThan(6);
        expect(firedAt).toBe(-1);
      }
    }
  });

  it('at 1 star aiming at a gang member with an officer standing behind him threatens nobody', () => {
    // Round 2 fix pass (police, review): the threat is the first person along the crosshair ray, not anyone
    // near it.
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const p = sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    sim.wanted.setLevel(1);
    const near = visibleSpot(sim, p.pos.x, p.pos.z, 7);
    const dx = (near.x - p.pos.x) / 7;
    const dz = (near.z - p.pos.z) / 7;
    const gang = sim.spawnCharacter('gang', near.x, near.z);
    gang.health = gang.maxHealth = 1e6;
    const cop = officer(sim, p.pos.x + dx * 13, p.pos.z + dz * 13);
    cop.health = cop.maxHealth = 1e6;
    expect(sim.world.lineOfSight(p.pos.x, p.pos.y + 1.5, p.pos.z, cop.pos.x, cop.pos.y + 1.2, cop.pos.z)).toBe(true);
    const at = (c: Character) => () => aimAt(sim, { x: c.pos.x, y: c.pos.y + 1.2, z: c.pos.z }, { aim: true });
    step(sim, 0.5, at(gang));
    expect(sim.wanted.lastCopAssaultAt).toBe(-Infinity);
    // Stepping aside to aim past him at the officer does count.
    gang.pos.x += dz * 3;
    gang.pos.z -= dx * 3;
    step(sim, 0.5, at(cop));
    expect(sim.wanted.lastCopAssaultAt).toBeGreaterThan(sim.time - 1);
  });

  it('at 1 star officers fire back right after an attack on one of them, and stop again after 4 s', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const p = sim.player;
    sim.wanted.setLevel(1);
    const spot = visibleSpot(sim, p.pos.x, p.pos.z, 14);
    const cop = officer(sim, spot.x, spot.z);
    cop.health = cop.maxHealth = 1e6;
    const shots = countPoliceShots(sim);
    step(sim, 1);
    expect(shots.n).toBe(0);
    sim.wanted.crime('assaultCop', cop.pos.x, cop.pos.z);
    step(sim, 3.5);
    expect(shots.n).toBeGreaterThan(0);
    step(sim, 1);
    const n = shots.n;
    step(sim, 3);
    expect(shots.n).toBe(n);
  });

  it('from 3 stars nobody walks up to an armed player: they keep their distance and shoot', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    const p = sim.player;
    p.inventory.give('pistol', 48);
    p.inventory.current = 'pistol';
    sim.wanted.setLevel(3);
    const crew = [0, 1].map((k) => {
      const s = visibleSpot(sim, p.pos.x, p.pos.z, 26, k * 1.3);
      const c = officer(sim, s.x, s.z);
      c.health = c.maxHealth = 1e6;
      return c;
    });
    const shots = countPoliceShots(sim);
    let closest = Infinity;
    step(sim, 15, () => {
      for (const c of crew) closest = Math.min(closest, dist(c.pos, p.pos));
      return input();
    });
    expect(sim.deathKind).toBeNull();
    expect(closest).toBeGreaterThan(10);
    expect(shots.n).toBeGreaterThan(5);
  });

  it('covers an arrester walking up for 12 s at most: one who cannot get through is no reason to hold fire for ever', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    const p = sim.player;
    sim.wanted.setLevel(2);
    // The arrester is stuck 8 m away; his partner has a clear shot from 16 m.
    const near = visibleSpot(sim, p.pos.x, p.pos.z, 8);
    const stuck = officer(sim, near.x, near.z);
    const far = visibleSpot(sim, p.pos.x, p.pos.z, 16, 2);
    const partner = officer(sim, far.x, far.z);
    let partnerShots: number[] = [];
    sim.events.on('shot', (e) => {
      if (e.shooter === partner) partnerShots.push(sim.time);
    });
    const t0 = sim.time;
    step(sim, 15, () => {
      stuck.pos.x = near.x;
      stuck.pos.z = near.z;
      partner.pos.x = far.x;
      partner.pos.z = far.z;
      return input();
    });
    expect(internals(sim).arrester).toBe(stuck);
    expect(sim.deathKind).toBeNull();
    partnerShots = partnerShots.map((t) => t - t0);
    expect(partnerShots.length).toBeGreaterThan(0);
    expect(partnerShots[0]!).toBeGreaterThanOrEqual(12);
  });

  it('never sends SWAT to make an arrest', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    const p = sim.player;
    sim.wanted.setLevel(4);
    const near = visibleSpot(sim, p.pos.x, p.pos.z, 8);
    officer(sim, near.x, near.z, 'swat');
    step(sim, 0.2);
    expect(internals(sim).arrester).toBeNull();
    const far = visibleSpot(sim, p.pos.x, p.pos.z, 16, 2);
    const cop = officer(sim, far.x, far.z);
    step(sim, 0.2);
    expect(internals(sim).arrester).toBe(cop);
  });

  it('at 3 stars a pursuit unit keeping within 30 m of a sedan doing 20 m/s shoots it up (150+ bullet damage in 10 s)', () => {
    for (const seed of [1, 2, 3]) {
      seedMathRandom(seed);
      const sim = makeSim({ seed });
      const lane = longestLane(sim, true);
      const car = sim.spawnVehicle('sedan', at(lane, 30).x, at(lane, 30).z, lane.heading);
      placeInCar(sim, car);
      car.vel.x = lane.dx * 20;
      car.vel.z = lane.dz * 20;
      const bot = fleeBot(sim, car, 20);
      sim.wanted.setLevel(3);
      let unit: Vehicle | null = null;
      for (let i = 0; i < 20 && !unit; i++) unit = sim.police.spawnUnit('police', true);
      const u = unit!;
      const behind = at(lane, 5);
      u.pos.x = behind.x;
      u.pos.z = behind.z;
      u.pos.y = sim.world.groundHeight(behind.x, behind.z);
      u.heading = lane.heading;
      u.vel.x = lane.dx * 20;
      u.vel.z = lane.dz * 20;
      u.ai!.setLane(lane, 5);
      let damage = 0;
      const orig = sim.combat.damageVehicle.bind(sim.combat);
      sim.combat.damageVehicle = (v, amount, attacker, kind) => {
        if (v === car && kind === 'bullet' && attacker?.isLaw) damage += amount;
        orig(v, amount, attacker, kind);
      };
      let farthest = 0;
      let speed = 0;
      let frames = 0;
      step(sim, 10, () => {
        farthest = Math.max(farthest, dist(u.pos, car.pos));
        speed += car.speed;
        frames++;
        return bot();
      });
      expect(speed / frames, `seed ${seed}: average speed`).toBeGreaterThan(18);
      expect(farthest, `seed ${seed}`).toBeLessThan(30);
      expect(damage, `seed ${seed}`).toBeGreaterThanOrEqual(150);
      vi.restoreAllMocks();
    }
  });

  it('crews hold their fire from the car while a partner arrests the player', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    const lane = longestLane(sim);
    const car = sim.spawnVehicle('sedan', at(lane, 60).x, at(lane, 60).z, lane.heading);
    placeInCar(sim, car);
    sim.wanted.setLevel(2);
    const unit = sim.police.spawnUnit('police', true)!;
    const crew = unit.passengers.find((c) => c)!;
    const behind = at(lane, 40);
    unit.pos.x = behind.x;
    unit.pos.z = behind.z;
    unit.heading = lane.heading;
    unit.vel.x = unit.vel.z = 0;
    unit.ai!.setLane(lane, 40);
    // An officer at the driver's door of the player's stopped car.
    officer(sim, car.pos.x + Math.cos(car.heading) * (car.halfW + 0.8), car.pos.z - Math.sin(car.heading) * (car.halfW + 0.8));
    let crewShots = 0;
    sim.events.on('shot', (e) => {
      if (e.shooter === crew) crewShots++;
    });
    let inCar = 0;
    const t = stepUntil(sim, 5, () => sim.deathKind === 'busted', () => {
      unit.ai!.hold = true;
      if (crew.vehicle === unit) inCar++;
      return input({ handbrake: true });
    });
    expect(t).toBeGreaterThan(0);
    expect(inCar).toBeGreaterThan(60);
    expect(crewShots).toBe(0);
  });

  it('a crew keeping pace on the player\'s tail fires, but holds fire while ramming him', () => {
    const sim = makeSim();
    const lane = longestLane(sim, true);
    const car = sim.spawnVehicle('sedan', at(lane, 40).x, at(lane, 40).z, lane.heading);
    placeInCar(sim, car);
    sim.wanted.setLevel(3);
    const unit = sim.police.spawnUnit('police', true)!;
    const fire = (sim.police as unknown as { fireFromCar(v: Vehicle, d: number, level: number): void }).fireFromCar.bind(sim.police);
    const crew = unit.passengers.find((c) => c)!;
    let shots = 0;
    sim.events.on('shot', (e) => {
      if (e.shooter === crew) shots++;
    });
    const put = (gap: number, unitSpeed: number) => {
      const p = at(lane, 40 - gap);
      unit.pos.x = p.x;
      unit.pos.z = p.z;
      unit.heading = lane.heading;
      unit.vel.x = lane.dx * unitSpeed;
      unit.vel.z = lane.dz * unitSpeed;
      car.vel.x = lane.dx * 20;
      car.vel.z = lane.dz * 20;
      crew.fireCooldown = 0;
      crew.reloadTimer = 0;
      fire(unit, gap, 3);
    };
    put(6, 30); // closing in at 10 m/s: ramming
    expect(shots).toBe(0);
    put(6, 20); // on his tail at his speed
    expect(shots).toBe(1);
    put(20, 30); // closing, but from further back
    expect(shots).toBe(2);
  });

  it('a crew checks its line of fire from the window it shoots from, not from the middle of the car', () => {
    // Round 2 fix pass (police): shots from a car window have no wall check of their own, so the crew's
    // line-of-sight test must start where the shot does (CombatSystem.muzzle), or a wall beside the car is
    // shot through. Here the window is stubbed inside a tower: no clear line, no shot.
    const sim = makeSim();
    const lane = longestLane(sim, true);
    const car = sim.spawnVehicle('sedan', at(lane, 40).x, at(lane, 40).z, lane.heading);
    placeInCar(sim, car);
    sim.wanted.setLevel(3);
    const unit = sim.police.spawnUnit('police', true)!;
    const fire = (sim.police as unknown as { fireFromCar(v: Vehicle, d: number, level: number): void }).fireFromCar.bind(sim.police);
    const crew = unit.passengers.find((c) => c)!;
    let shots = 0;
    sim.events.on('shot', (e) => {
      if (e.shooter === crew) shots++;
    });
    const behind = at(lane, 20);
    unit.pos.x = behind.x;
    unit.pos.z = behind.z;
    unit.heading = lane.heading;
    unit.vel.x = car.vel.x = lane.dx * 20;
    unit.vel.z = car.vel.z = lane.dz * 20;
    const tower = sim.world.layout.buildings.reduce((a, b) => (Math.max(...b.tiers.map((t) => t.y1)) > Math.max(...a.tiers.map((t) => t.y1)) ? b : a));
    const inWall = { x: (tower.rect.minX + tower.rect.maxX) / 2, y: 10, z: (tower.rect.minZ + tower.rect.maxZ) / 2 };
    const muzzle = sim.combat.muzzle.bind(sim.combat);
    sim.combat.muzzle = (c, fromVehicle) => (c === crew && fromVehicle ? { ...inWall } : muzzle(c, fromVehicle));
    crew.fireCooldown = 0;
    fire(unit, 20, 3);
    expect(shots).toBe(0);
    // The window back where it is: a clear line along the avenue, and the crew fires.
    sim.combat.muzzle = muzzle;
    sim.time += 1;
    crew.fireCooldown = 0;
    fire(unit, 20, 3);
    expect(shots).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P10: response phase, recycling, cutting off a fast player, helicopter

describe('the response phase', () => {
  it('lasts 4 + 3 per star seconds after the level rises, while the police know where the player is', () => {
    for (const level of [1, 3]) {
      const sim = makeSim();
      sim.cheats.godMode = true;
      sim.missions.noBust = true;
      sim.wanted.setLevel(level);
      expect(sim.wanted.inResponse).toBe(true);
      expect(sim.wanted.responseUntil).toBeCloseTo(sim.time + RESPONSE_BASE + RESPONSE_PER_STAR * level, 6);
      // He slips 300 m away at once: they still know where he is until the phase is over.
      const n = sim.roads.nearestNode(sim.player.pos.x + 300, sim.player.pos.z);
      teleport(sim, n.x + 9, n.z + 9);
      const end = RESPONSE_BASE + RESPONSE_PER_STAR * level;
      step(sim, end - 0.5);
      expect(sim.wanted.searching).toBe(false);
      expect(sim.wanted.evadeProgress()).toBe(0);
      expect(dist({ x: sim.wanted.lastSeenX, z: sim.wanted.lastSeenZ }, sim.player.pos)).toBeLessThan(1);
      // Then they lose him like any other time.
      step(sim, 3.5);
      expect(sim.wanted.inResponse).toBe(false);
      expect(sim.wanted.searching).toBe(true);
    }
  });

  it('starts again on every rise, but not when the level stays or drops', () => {
    const sim = makeSim();
    sim.policeEnabled = false;
    sim.wanted.setLevel(2);
    step(sim, 11);
    expect(sim.wanted.inResponse).toBe(false);
    sim.wanted.setLevel(2);
    expect(sim.wanted.inResponse).toBe(false);
    sim.wanted.setLevel(3);
    expect(sim.wanted.inResponse).toBe(true);
    step(sim, 14);
    sim.wanted.setLevel(1);
    expect(sim.wanted.inResponse).toBe(false);
  });
});

describe('pursuit units', () => {
  it('a unit trailing far behind and not closing in is recycled for one dispatched near the player', () => {
    seedMathRandom(5);
    const sim = makeSim({ ambient: true, seed: 5 });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    sim.traffic.updateStreaming = () => {};
    sim.peds.updateStreaming = () => {};
    sim.wanted.setLevel(2);
    // A unit stuck 200 m away, out of sight behind the camera.
    const p = sim.player.pos;
    let stuck: Vehicle | null = null;
    for (const lane of sim.roads.lanes) {
      const pt = at(lane, lane.length / 2);
      const d = dist(pt, p);
      if (d < 190 || d > 230 || sim.isVisible(pt.x, 1, pt.z) || !sim.traffic.isClear(pt.x, pt.z, 9)) continue;
      stuck = sim.police.spawnUnit('police', true);
      if (!stuck) continue;
      stuck.pos.x = pt.x;
      stuck.pos.z = pt.z;
      stuck.ai!.setLane(lane, lane.length / 2);
      break;
    }
    expect(stuck).not.toBeNull();
    const removedAt = stepUntil(sim, 16, () => stuck!.removed, () => {
      if (!stuck!.removed) {
        stuck!.ai!.hold = true;
        stuck!.vel.x = stuck!.vel.z = 0;
      }
      return input();
    });
    expect(removedAt).toBeGreaterThan(5);
    expect(removedAt).toBeLessThan(14);
    // Dispatch filled the slot nearer to the player.
    expect(liveUnits(sim).some((v) => dist(v.pos, p) < 170)).toBe(true);
  });

  it('cuts off a fast player: every second pursuit unit waits round the corner at a junction 90-180 m ahead, or comes his way', () => {
    // Round 2 fix pass (police): the road ahead is in the driver's view, so only the cross streets just
    // round the corners there, or roads coming his way out of his sight, hide a unit until he gets there.
    let ahead = 0;
    let corners = 0;
    let total = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const sim = makeSim({ seed });
      // Avenues through the middle of town, a different one each time.
      const inner = sim.roads.lanes.filter((l) => l.line.avenue && Math.max(Math.abs(l.sx), Math.abs(l.sz), Math.abs(l.ex), Math.abs(l.ez)) < 260);
      const lane = inner[(seed * 37) % inner.length]!;
      const car = sim.spawnVehicle('sports', at(lane, 20).x, at(lane, 20).z, lane.heading);
      placeInCar(sim, car);
      car.vel.x = lane.dx * 30;
      car.vel.z = lane.dz * 30;
      car.speed = 30;
      // The chase camera behind him, looking down the road: spots in plain view ahead are not used.
      sim.cam.x = car.pos.x - lane.dx * 7;
      sim.cam.y = car.pos.y + 3;
      sim.cam.z = car.pos.z - lane.dz * 7;
      sim.camDir.x = lane.dx;
      sim.camDir.y = -0.1;
      sim.camDir.z = lane.dz;
      sim.wanted.setLevel(2);
      for (let k = 0; k < 8; k++) {
        const v = sim.police.spawnUnit('police', true);
        if (!v) continue;
        total++;
        const along = (v.pos.x - car.pos.x) * lane.dx + (v.pos.z - car.pos.z) * lane.dz;
        const facing = Math.sin(v.heading) * lane.dx + Math.cos(v.heading) * lane.dz;
        const vl = v.ai!.currentLane()!;
        const node = sim.roads.nodes[vl.to]!;
        // Heading into a junction on his road ahead from a cross street, a few metres short of its line.
        const nodeAhead = (node.x - car.pos.x) * lane.dx + (node.z - car.pos.z) * lane.dz;
        const nodeSide = Math.abs((node.x - car.pos.x) * lane.dz - (node.z - car.pos.z) * lane.dx);
        const toLine = vl.length - ((v.pos.x - vl.sx) * vl.dx + (v.pos.z - vl.sz) * vl.dz);
        const corner = Math.abs(facing) < 0.3 && nodeAhead >= 90 && nodeAhead <= 180 && nodeSide < 12 && toLine >= 8 - 1e-6 && toLine <= 30 + 1e-6;
        if (corner || (along >= 90 && along <= 180 && facing < -0.5)) {
          ahead++;
          if (corner) corners++;
          expect(sim.isVisible(v.pos.x, 1, v.pos.z)).toBe(false);
        }
        sim.removeVehicle(v);
      }
    }
    expect(total).toBeGreaterThanOrEqual(25);
    // About half: the other half comes from the usual ring (which may land ahead now and then too).
    expect(ahead).toBeGreaterThanOrEqual(Math.floor(total * 0.4));
    expect(corners).toBeGreaterThan(ahead / 2);
  });

  it("the flee bot's camera looks along the car's travel going forward, and along its nose when backing up", () => {
    const sim = makeSim();
    const lane = longestLane(sim);
    const car = sim.spawnVehicle('sports', at(lane, 30).x, at(lane, 30).z, lane.heading);
    car.vel.x = -lane.dx * 4;
    car.vel.z = -lane.dz * 4;
    car.speed = 4;
    car.forwardSpeed = -4;
    const back = chaseCamera(car).aimDir;
    expect(back.x * lane.dx + back.z * lane.dz).toBeGreaterThan(0.9);
    car.vel.x = lane.dx * 20;
    car.vel.z = lane.dz * 20;
    car.speed = 20;
    car.forwardSpeed = 20;
    const ahead = chaseCamera(car);
    expect(ahead.aimDir.x * lane.dx + ahead.aimDir.z * lane.dz).toBeGreaterThan(0.9);
    // From behind the car.
    expect((car.pos.x - ahead.aimOrigin.x) * lane.dx + (car.pos.z - ahead.aimOrigin.z) * lane.dz).toBeGreaterThan(6);
  });

  it('cuts off neither a 1-star suspect nor, below 5 stars, one with a unit on his tail or one just caught up with', () => {
    // [stars, a unit 25 m behind him, seconds since a unit was within 40 m of him, cut off?]
    for (const [stars, tail, contact, cut] of [
      [1, false, Infinity, false],
      [3, true, Infinity, false],
      [3, false, Infinity, true],
      [3, false, 5, false],
      [3, false, 13, true],
      [5, true, 0.5, false],
      [5, true, 2, true],
    ] as const) {
      const sim = makeSim({ seed: 4 });
      const inner = sim.roads.lanes.filter((l) => l.line.avenue && Math.max(Math.abs(l.sx), Math.abs(l.sz), Math.abs(l.ex), Math.abs(l.ez)) < 260);
      const lane = inner[3]!;
      const car = sim.spawnVehicle('sports', at(lane, 20).x, at(lane, 20).z, lane.heading);
      placeInCar(sim, car);
      car.vel.x = lane.dx * 30;
      car.vel.z = lane.dz * 30;
      car.speed = 30;
      sim.cam.x = car.pos.x - lane.dx * 7;
      sim.cam.y = car.pos.y + 3;
      sim.cam.z = car.pos.z - lane.dz * 7;
      sim.camDir.x = lane.dx;
      sim.camDir.y = -0.1;
      sim.camDir.z = lane.dz;
      sim.wanted.setLevel(stars);
      if (tail) {
        // A unit 25 m behind him.
        const u = sim.police.spawnUnit('police', false)!;
        u.pos.x = car.pos.x - lane.dx * 25;
        u.pos.z = car.pos.z - lane.dz * 25;
      }
      (sim.police as unknown as { contactAt: number }).contactAt = sim.time - contact;
      // Count the cut-offs tried: the corner search ahead of him.
      const police = sim.police as unknown as { cornerAhead(): unknown };
      const corner = police.cornerAhead.bind(sim.police);
      let tried = 0;
      police.cornerAhead = () => {
        tried++;
        return corner();
      };
      for (let k = 0; k < 10; k++) {
        const v = sim.police.spawnUnit('police', true);
        if (v) sim.removeVehicle(v);
      }
      const label = `${stars} stars, unit on his tail: ${tail}, ${contact} s since one caught up`;
      if (cut) expect(tried, label).toBeGreaterThanOrEqual(4);
      else expect(tried, label).toBe(0);
    }
  });

  it('a slow player gets units from the usual ring only', () => {
    const sim = makeSim({ seed: 2 });
    const lane = longestLane(sim, true);
    const car = sim.spawnVehicle('sedan', at(lane, 20).x, at(lane, 20).z, lane.heading);
    placeInCar(sim, car);
    car.vel.x = lane.dx * 6;
    car.vel.z = lane.dz * 6;
    car.speed = 6;
    sim.wanted.setLevel(2);
    for (let k = 0; k < 6; k++) {
      const v = sim.police.spawnUnit('police', true);
      if (!v) continue;
      const d = dist(v.pos, car.pos);
      expect(d).toBeGreaterThanOrEqual(95);
      expect(d).toBeLessThanOrEqual(215);
      sim.removeVehicle(v);
    }
  });
});

describe('the police helicopter', () => {
  it('is sent from 150 m out', () => {
    seedMathRandom(3);
    const sim = makeSim({ ambient: true, seed: 3 });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    sim.wanted.setLevel(3);
    step(sim, 1 / 60);
    expect(sim.helis.length).toBe(1);
    const d = dist(sim.helis[0]!.pos, sim.player.pos);
    expect(d).toBeGreaterThan(148);
    expect(d).toBeLessThan(152);
  });

  it('dashes in at up to 55 m/s from afar on its way out, and to catch up with a player standing still', () => {
    const HELI_DASH_RANGE_M = 120;
    // (After a car faster than its cruise speed it does not dash: see the outrun cases below.)
    for (const [from, cap] of [[400, HELI_DASH_SPEED], [100, HELI_DASH_SPEED]] as const) {
      const sim = makeSim();
      sim.cheats.godMode = true;
      sim.missions.noBust = true;
      sim.wanted.setLevel(3);
      const p = sim.player.pos;
      // High above anything on the way in, so no roof gets in its way.
      let top = 0;
      sim.world.grid.query(p.x - 20, p.z - 20, p.x + 20, p.z + from + 20, (c) => {
        top = Math.max(top, c.y1);
      });
      const h = new Helicopter(sim.newId(), p.x, top + 30, p.z + from);
      h.orbit = 0;
      sim.helis.push(h);
      let fastest = 0;
      step(sim, 6, () => {
        // Over the ground: it climbs and sinks on top of that.
        fastest = Math.max(fastest, Math.hypot(h.vel.x, h.vel.z));
        return input();
      });
      expect(fastest, `from ${from} m`).toBeGreaterThan(from > HELI_DASH_RANGE_M ? cap - 5 : HELI_SPEED + 5);
      expect(fastest, `from ${from} m`).toBeLessThanOrEqual(cap + 1e-6);
    }
  });

  /** Round 2 fix pass (police): 3 stars, no other police, the helicopter right behind a car doing `speed` m/s straight down Azura Ave. */
  function outrun(speed: number, hour: number, seen = false, orbit?: number) {
    const sim = makeSim({ startHour: hour });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const n = sim.roads.node(5, 0);
    const x0 = n.x - 2;
    const z0 = n.z + n.halfZ + 8;
    const car = sim.spawnVehicle('sports', x0, z0, 0);
    placeInCar(sim, car);
    sim.wanted.setLevel(3);
    noResponse(sim);
    const h = new Helicopter(sim.newId(), x0 + 12, sim.world.groundHeight(x0, z0) + 36, z0 - 12);
    h.spotlight = { x: x0, z: z0 };
    if (orbit !== undefined) h.orbit = orbit;
    sim.helis.push(h);
    // It has been on the scene a while: no dash for a car faster than it.
    (sim.police as unknown as { heliArrived: WeakSet<Helicopter> }).heliArrived.add(h);
    let lostAt = -1;
    let fastest = 0;
    let beamOut = 0;
    let i = 0;
    step(sim, 18, (t) => {
      // Kinematic, held on the inner southbound lane whatever it meets (as the P41 run down the avenue).
      car.vel.x = 0;
      car.vel.z = speed;
      car.heading = 0;
      car.angVel = 0;
      car.pos.x = x0;
      car.pos.z = z0 + speed * i++ * (1 / 60);
      if (lostAt < 0 && sim.wanted.searching) lostAt = t;
      if (!seen) fastest = Math.max(fastest, Math.hypot(h.vel.x, h.vel.z));
      beamOut = Math.max(beamOut, Math.hypot(h.spotlight.x - h.pos.x, h.spotlight.z - h.pos.z));
      return input({ aimOrigin: { x: car.pos.x, y: car.pos.y + 3, z: car.pos.z - 9 }, aimDir: { x: 0, y: -0.1, z: 1 } });
    });
    return { lostAt, fastest, beamOut };
  }

  it('cannot keep up with a getaway car faster than its cruise speed: it loses sight of it, by day and at night', () => {
    // The helicopter used to cruise at 40 m/s, dash at 55 and see 110 m all round, so a fleeing car never even
    // made the stars flash.
    for (const hour of [14, 22.5]) {
      // Wherever it is on its orbit round the car when the chase starts.
      for (let k = 0; k < 4; k++) {
        const r = outrun(40, hour, false, (k * Math.PI) / 2);
        expect(r.lostAt, `${hour}:00, orbit ${k}`).toBeGreaterThan(0);
        expect(r.lostAt, `${hour}:00, orbit ${k}`).toBeLessThan(12);
        expect(r.fastest).toBeLessThanOrEqual(HELI_SPEED + 1e-6);
        // Its beam reaches the street only so far out from under it.
        expect(r.beamOut).toBeLessThanOrEqual(SPOT_REACH + 1e-6);
      }
    }
  });

  it('keeps a car slower than its cruise speed in sight, wherever it is on its orbit', () => {
    // Round 2 fix pass (police, review): it used to steer only for its orbit spot round the car and trailed it
    // by the car's speed over its gain, so at 25-28 m/s it lost cars it could outfly.
    for (const speed of [22, 25, 28]) {
      for (let k = 0; k < 8; k++) {
        const r = outrun(speed, 14, false, (k * Math.PI) / 4);
        expect(r.lostAt, `${speed} m/s, orbit ${k}`).toBe(-1);
      }
    }
  });

  it('dashes in again after a recall, and its gunner fires only at someone its crew can make out', () => {
    // Round 2 fix pass (police, review). Recalled when the stars drop below 3, a helicopter sent back in dashes
    // in again; and from 4 stars the gun (90 m reach) fires only at a player within the crew's sight.
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const n = sim.roads.node(5, 0);
    const x0 = n.x - 2;
    const z0 = n.z + n.halfZ + 8;
    const car = sim.spawnVehicle('sports', x0, z0, 0);
    placeInCar(sim, car);
    sim.wanted.setLevel(3);
    noResponse(sim);
    const h = new Helicopter(sim.newId(), x0, sim.world.groundHeight(x0, z0) + 36, z0 - 10);
    h.spotlight = { x: x0, z: z0 };
    h.orbit = 0;
    sim.helis.push(h);
    const cam = () => input({ aimOrigin: { x: car.pos.x, y: car.pos.y + 3, z: car.pos.z - 9 }, aimDir: { x: 0, y: -0.1, z: 1 } });
    step(sim, 3, cam);
    const arrived = (sim.police as unknown as { heliArrived: WeakSet<Helicopter> }).heliArrived;
    expect(arrived.has(h)).toBe(true);
    sim.wanted.clear();
    // It leaves; well away, it is sent back in.
    for (let t = 0; t < 20 && dist(h.pos, car.pos) < 220; t += 0.5) step(sim, 0.5, cam);
    expect(h.removed).toBe(false);
    expect(dist(h.pos, car.pos)).toBeGreaterThan(215);
    // Back at 3 stars (the response phase tells the police where he is) and driving off at 35 m/s, faster than
    // it cruises: it dashes after him all the same, as it did when it was first sent.
    sim.wanted.setLevel(3);
    let fastest = 0;
    let i = 0;
    const zs = car.pos.z;
    step(sim, 6, () => {
      car.vel.x = 0;
      car.vel.z = 35;
      car.heading = 0;
      car.angVel = 0;
      car.pos.x = x0;
      car.pos.z = zs + 35 * i++ * (1 / 60);
      fastest = Math.max(fastest, Math.hypot(h.vel.x, h.vel.z));
      return cam();
    });
    expect(fastest).toBeGreaterThan(HELI_DASH_SPEED - 10);
    // The gunner: a helicopter held 75 m (along the ground) from him with a clear view fires no round; 40 m away it does.
    sim.wanted.setLevel(4);
    let rounds = 0;
    sim.events.on('shot', (e) => {
      if (!e.shooter) rounds++;
    });
    const shoot = (sim.police as unknown as { heliShot(h: Helicopter): void }).heliShot.bind(sim.police);
    const pp = sim.playerPos();
    for (const [gap, fires] of [[75, false], [40, true]] as const) {
      h.pos.x = pp.x;
      h.pos.z = pp.z - gap;
      h.pos.y = sim.world.groundHeight(pp.x, pp.z) + 36;
      expect(sim.world.lineOfSight(h.pos.x, h.pos.y - 1.5, h.pos.z, pp.x, pp.y + 1.2, pp.z), `clear view from ${gap} m`).toBe(true);
      const before = rounds;
      for (let k = 0; k < 5; k++) shoot(h);
      expect(rounds > before, `${gap} m`).toBe(fires);
    }
  });

  it('after a slow quarry it dashes again', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    sim.wanted.setLevel(3);
    const p = sim.player.pos;
    let top = 0;
    sim.world.grid.query(p.x - 20, p.z - 20, p.x + 20, p.z + 420, (c) => {
      top = Math.max(top, c.y1);
    });
    const h = new Helicopter(sim.newId(), p.x, top + 30, p.z + 400);
    h.orbit = 0;
    sim.helis.push(h);
    (sim.police as unknown as { heliArrived: WeakSet<Helicopter> }).heliArrived.add(h);
    let fastest = 0;
    step(sim, 6, () => {
      fastest = Math.max(fastest, Math.hypot(h.vel.x, h.vel.y, h.vel.z));
      return input();
    });
    // The player stands on the sidewalk: slower than its cruise speed, so it dashes.
    expect(fastest).toBeGreaterThan(HELI_DASH_SPEED - 5);
  });

  it('sends no new helicopter for 45 s after one is shot down', () => {
    seedMathRandom(4);
    const sim = makeSim({ ambient: true, seed: 4 });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    sim.wanted.setLevel(3);
    sim.wanted.floor = 3;
    step(sim, 2);
    expect(sim.helis.length).toBe(1);
    sim.helis[0]!.health = 0;
    step(sim, 1 / 60);
    const downAt = sim.time;
    expect(sim.helis[0]!.destroyed).toBe(true);
    let firstNew = -1;
    step(sim, 50, () => {
      if (firstNew < 0 && sim.helis.some((h) => !h.destroyed)) firstNew = sim.time - downAt;
      return input();
    });
    expect(firstNew).toBeGreaterThanOrEqual(45);
    expect(firstNew).toBeLessThan(46);
  });
});

// ---------------------------------------------------------------------------
// P62: escalation pacing and star-scaled consequences

describe('escalation', () => {
  it('a shootout from 2 stars climbs one star per 8 s at most: 4 stars not before 16 s, 5 not before 24 s', () => {
    for (const seed of [1, 2]) {
      seedMathRandom(seed);
      const sim = makeSim({ ambient: true, seed });
      sim.cheats.godMode = true;
      sim.missions.noBust = true;
      const p = sim.player;
      p.inventory.give('rifle', 5000);
      p.inventory.current = 'rifle';
      sim.wanted.setLevel(2);
      // A unit's crew is already on the scene.
      for (let k = 0; k < 3; k++) {
        const s = visibleSpot(sim, p.pos.x, p.pos.z, 14 + k * 3, k * 2);
        officer(sim, s.x, s.z);
      }
      const rises: Array<{ level: number; t: number }> = [{ level: 2, t: sim.time }];
      sim.events.on('wanted', (e) => rises.push({ level: e.level, t: sim.time }));
      const t0 = sim.time;
      let frame = 0;
      let hits = 0;
      sim.events.on('shot', (e) => {
        if (e.shooter === p && e.hit === 'flesh') hits++;
      });
      step(sim, 45, () => {
        if (sim.wanted.level === 5) return input();
        // Shoot the nearest officer every 0.3 s.
        const pull = frame++ % 18 === 0;
        let target: Character | null = null;
        for (const c of sim.characters) if (c.isLaw && c.alive && !c.vehicle && (!target || dist(c.pos, p.pos) < dist(target.pos, p.pos))) target = c;
        const aim = target ? { x: target.pos.x, y: target.pos.y + 1.2, z: target.pos.z } : { x: p.pos.x, y: p.pos.y + 20, z: p.pos.z + 1 };
        return aimAt(sim, aim, { aim: true, fire: pull, firePressed: pull });
      });
      const when = (level: number) => rises.find((r) => r.level === level)?.t ?? Infinity;
      const log = rises.map((r) => `${r.level}@${(r.t - t0).toFixed(1)}`).join(' ');
      expect(hits, log).toBeGreaterThan(10);
      // Heat enough for more is there at once; the stars come at the pace of the cap.
      expect(when(3) - t0, log).toBeGreaterThanOrEqual(RISE_GAP);
      expect(when(3) - t0, log).toBeLessThan(RISE_GAP + 1);
      expect(when(4) - t0, log).toBeGreaterThanOrEqual(16);
      expect(when(5) - t0, log).toBeGreaterThanOrEqual(24);
      // It does escalate, a star at a time, every level above 2 held at least 8 s.
      expect(when(4), log).toBeLessThan(Infinity);
      for (let i = 1; i < rises.length; i++) {
        expect(rises[i]!.level, log).toBe(rises[i - 1]!.level + 1);
        if (rises[i - 1]!.level > 2) expect(rises[i]!.t - rises[i - 1]!.t, log).toBeGreaterThanOrEqual(RISE_GAP - 1e-9);
      }
      vi.restoreAllMocks();
    }
  });

  it('crimes still raise the level at once up to 2 stars, and missions can set any level at once', () => {
    const sim = makeSim();
    sim.wanted.crime('killCop', 0, 0);
    expect(sim.wanted.level).toBe(2);
    // A rocket into a police car full of officers: heat for 3 stars, but the third waits.
    sim.wanted.crime('destroyPolice', 0, 0);
    sim.wanted.crime('killCop', 0, 0);
    expect(sim.wanted.level).toBe(2);
    expect(sim.wanted.heat).toBeGreaterThan(720);
    sim.policeEnabled = false;
    step(sim, RISE_GAP + 0.1);
    expect(sim.wanted.level).toBe(3);
    sim.wanted.setLevel(5);
    expect(sim.wanted.level).toBe(5);
  });

  it('an assault on an officer is 70 heat and killing one 300', () => {
    const sim = makeSim();
    sim.wanted.crime('assaultCop', 0, 0);
    expect(sim.wanted.heat).toBe(70);
    sim.wanted.crime('killCop', 0, 0);
    expect(sim.wanted.heat).toBe(370);
    expect(sim.wanted.lastCopAssaultAt).toBe(sim.time);
  });
});

describe('the cost of getting caught', () => {
  function caught(kind: 'busted' | 'wasted', stars: number): { charged: number; weapons: boolean; text: string } {
    const sim = makeSim();
    const p = sim.player;
    p.inventory.give('smg', 60);
    sim.progress.addMoney(5000);
    const money = sim.progress.money;
    const texts: string[] = [];
    sim.events.on('message', (e) => texts.push(e.text));
    sim.wanted.setLevel(stars);
    if (kind === 'busted') sim.bustPlayer();
    else sim.combat.damageCharacter(p, 500, null, 'fall', 0, -1, 0);
    step(sim, 5.5);
    expect(sim.deathKind).toBeNull();
    return { charged: money - sim.progress.money, weapons: p.inventory.has('smg'), text: texts.find((t) => t.startsWith(kind === 'busted' ? 'Bail' : 'Hospital')) ?? '' };
  }

  it('bail is $100 + $150 a star, and from 2 stars the guns are confiscated', () => {
    const three = caught('busted', 3);
    expect(three.charged).toBe(550);
    expect(three.weapons).toBe(false);
    expect(three.text).toBe('Bail paid: $550. Your weapons were confiscated.');
    const one = caught('busted', 1);
    expect(one.charged).toBe(250);
    expect(one.weapons).toBe(true);
    expect(one.text).toBe('Bail paid: $250. You kept your weapons.');
  });

  it('the hospital bill is $100 + $100 a star, and weapons are kept', () => {
    const two = caught('wasted', 2);
    expect(two.charged).toBe(300);
    expect(two.weapons).toBe(true);
    expect(two.text).toBe('Hospital bill: $300. You kept your weapons.');
    expect(caught('wasted', 0).charged).toBe(100);
  });
});

describe('the Spray Shack', () => {
  function inBay(sim: Sim) {
    const spray = sim.world.layout.pois.find((q) => q.id === 'spray_docks')!;
    const bay = spray.bay!;
    const c = { x: (bay.minX + bay.maxX) / 2, z: (bay.minZ + bay.maxZ) / 2 };
    const v = sim.spawnVehicle('sedan', c.x, c.z, spray.heading + Math.PI);
    return { v, c };
  }

  it('refuses a car the police watched drive in, without charging', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    sim.progress.addMoney(1000);
    const { v, c } = inBay(sim);
    const spot = visibleSpot(sim, c.x, c.z, 20);
    const cop = officer(sim, spot.x, spot.z);
    cop.health = cop.maxHealth = 1e6;
    const texts: string[] = [];
    sim.events.on('message', (e) => texts.push(e.text));
    placeInCar(sim, v);
    sim.wanted.setLevel(4);
    const money = sim.progress.money;
    step(sim, 1);
    expect(texts).toContain('Spray Shack: They saw you drive in!');
    expect(sim.wanted.level).toBe(4);
    expect(sim.progress.money).toBe(money);
  });

  it('with the stars flashing it clears all four of them for $400', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.progress.addMoney(1000);
    const { v } = inBay(sim);
    const lane = longestLane(sim);
    teleport(sim, at(lane, 20).x, at(lane, 20).z);
    sim.wanted.setLevel(4);
    noResponse(sim);
    step(sim, 3);
    expect(sim.wanted.searching).toBe(true);
    const texts: string[] = [];
    sim.events.on('message', (e) => texts.push(e.text));
    placeInCar(sim, v);
    const money = sim.progress.money;
    step(sim, 0.5);
    expect(sim.wanted.level).toBe(0);
    expect(sim.progress.money).toBe(money - 400);
    expect(texts).toContain('New paint, new plates. The cops have lost you. ($400)');
  });

  it('a repair alone costs $100', () => {
    const sim = makeSim({ police: false });
    const { v } = inBay(sim);
    v.health = v.spec.health * 0.5;
    placeInCar(sim, v);
    const money = sim.progress.money;
    step(sim, 0.5);
    expect(v.health).toBe(v.spec.health);
    expect(sim.progress.money).toBe(money - 100);
  });
});

// ---------------------------------------------------------------------------
// P88: the helicopter needs a line of sight; the spotlight no longer washes out the screen

describe('helicopter sightings', () => {
  /** The tallest downtown tower, a hiding spot against its south face, and a hover spot over the street north of it. */
  function tower(sim: Sim) {
    const height = (b: (typeof sim.world.layout.buildings)[number]) => Math.max(...b.tiers.map((t) => t.y1));
    const t = sim.world.layout.buildings.filter((b) => b.district === 'downtown').sort((a, b) => height(b) - height(a))[0]!;
    const cx = (t.rect.minX + t.rect.maxX) / 2;
    const hide = sim.world.findFreeSpot(cx, t.rect.maxZ + 1.2, 0.4, 3)!;
    const open = sim.world.findFreeSpot(cx, t.rect.minZ - 8, 0.4, 6)!;
    const hover = { x: cx, y: sim.world.groundHeight(cx, t.rect.minZ - 14) + 36, z: t.rect.minZ - 14 };
    return { hide, open, hover };
  }

  /** 3 stars, no other police, and a helicopter held in place (the police system is off, so nothing moves it). */
  function hovering(sim: Sim, hover: { x: number; y: number; z: number }): Helicopter {
    sim.policeEnabled = false;
    const h = new Helicopter(sim.newId(), hover.x, hover.y, hover.z);
    h.spotlight = { x: hover.x, z: hover.z + 14 };
    sim.helis.push(h);
    return h;
  }

  it('cannot see through a tower, so the stars clear after the evade time; out in the open it sees', () => {
    const sim = makeSim();
    const { hide, open, hover } = tower(sim);
    hovering(sim, hover);
    // Within the crew's sight range: only the tower is in the way.
    expect(dist(hide, hover)).toBeLessThan(HELI_SIGHT);
    teleport(sim, hide.x, hide.z);
    expect(sim.wanted.copWitness(hide.x, hide.z)).toBe(false);
    expect(sim.wanted.copWitness(open.x, open.z)).toBe(true);
    sim.wanted.setLevel(3);
    noResponse(sim);
    // Last seen a block away: he is out of the search area, and the clock runs.
    sim.wanted.lastSeenX = hide.x + 160;
    const t = sim.wanted.evadeTime();
    step(sim, t - 1);
    expect(sim.wanted.level).toBe(3);
    step(sim, 2);
    expect(sim.wanted.level).toBe(0);

    // The same in the open: it keeps the player in sight.
    const sim2 = makeSim();
    hovering(sim2, hover);
    teleport(sim2, open.x, open.z);
    sim2.wanted.setLevel(3);
    noResponse(sim2);
    sim2.wanted.lastSeenX = open.x + 160;
    step(sim2, t + 2);
    expect(sim2.wanted.level).toBe(3);
  });

  it('at night it only makes out what its spotlight shows, or what is close below it', () => {
    const sim = makeSim({ startHour: 22.5 });
    const { open, hover } = tower(sim);
    const h = hovering(sim, hover);
    expect(sim.wanted.copWitness(open.x, open.z)).toBe(true); // in the light and near
    // Street spots in plain view: one within the crew's HELI_SIGHT along the ground but over HELI_NIGHT_SIGHT
    // from the helicopter and away from the light, and one beyond HELI_SIGHT.
    const sees = (x: number, z: number) => sim.world.lineOfSight(h.pos.x, h.pos.y - 1.5, h.pos.z, x, sim.world.groundHeight(x, z) + 1.2, z);
    const spots = sim.roads.lanes.flatMap((l) => Array.from({ length: Math.floor(l.length / 3) }, (_, k) => at(l, k * 3 + 1.5)));
    const flat = (q: { x: number; z: number }) => Math.hypot(q.x - h.pos.x, q.z - h.pos.z);
    const far = spots.find((q) => flat(q) < HELI_SIGHT - 1 && Math.hypot(flat(q), h.pos.y - sim.world.groundHeight(q.x, q.z) - 1.2) > HELI_NIGHT_SIGHT + 1 && dist(q, h.spotlight) > SPOT_SEE + 5 && sees(q.x, q.z))!;
    expect(far).toBeDefined();
    expect(sim.wanted.copWitness(far.x, far.z)).toBe(false);
    h.spotlight = { x: far.x + SPOT_SEE - 2, z: far.z };
    expect(sim.wanted.copWitness(far.x, far.z)).toBe(true);
    // By day the light does not matter, within HELI_SIGHT.
    h.spotlight = { x: hover.x, z: hover.z };
    sim.clock.set(14);
    expect(sim.wanted.copWitness(far.x, far.z)).toBe(true);
    const beyond = spots.find((q) => flat(q) > HELI_SIGHT + 5 && flat(q) < 110 && sees(q.x, q.z))!;
    expect(beyond).toBeDefined();
    expect(sim.wanted.copWitness(beyond.x, beyond.z)).toBe(false);
  });
});

describe('the spotlight beam', () => {
  it('is a soft additive beam that vanishes when the camera is inside it, landing on a pool whose rim marks the edge of the light', () => {
    const view = new MarkerView();
    const sim = makeSim();
    const h = new Helicopter(sim.newId(), 0, 40, 0);
    h.spotlight = { x: 4, z: 3 };
    view.syncHelis([h], 1, () => 0);
    const v = (view as unknown as { heliViews: Map<number, { cone: THREE.Mesh; pool: THREE.Mesh }> }).heliViews.get(h.id)!;
    const mat = v.cone.material as THREE.ShaderMaterial;
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    expect(mat.side).toBe(THREE.FrontSide);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.fog).toBe(false);
    expect(mat.depthWrite).toBe(false);
    expect(mat.uniforms.uAlpha!.value).toBeCloseTo(0.1, 6);
    // Round 2 fix pass (police): the pool is as wide as the beam's footprint, and its rim, not its centre,
    // is bright: the night crew makes out what is within SPOT_SEE (twice the pool's radius) of its centre.
    const pool = v.pool.material as THREE.MeshBasicMaterial;
    expect(pool.blending).toBe(THREE.AdditiveBlending);
    expect(pool.depthWrite).toBe(false);
    v.pool.geometry.computeBoundingSphere();
    expect(v.pool.geometry.boundingSphere!.radius).toBeCloseTo(SPOT_RADIUS, 3);
    v.cone.geometry.computeBoundingBox();
    const bb = v.cone.geometry.boundingBox!;
    expect((bb.max.x - bb.min.x) / 2).toBeCloseTo(SPOT_RADIUS, 3);
    expect(SPOT_SEE).toBe(2 * SPOT_RADIUS);
    const img = pool.map!.image as { data: Uint8Array; width: number };
    const alpha = (r: number) => img.data[(Math.floor(img.width / 2) * img.width + Math.min(img.width - 1, Math.floor((img.width / 2) * (1 + r)))) * 4 + 3]! / 255;
    // A dim centre (an unlit player is no silhouette), a bright ring near the edge, nothing beyond it.
    expect(alpha(0) * pool.opacity).toBeLessThan(0.04);
    expect(alpha(0.82) * pool.opacity).toBeGreaterThan(0.12);
    expect(alpha(0.82)).toBeGreaterThan(3 * alpha(0));
    expect(alpha(0.99)).toBeLessThan(0.2);
    // The beam fades out for a camera near its axis (here by the spot on the ground), per camera.
    v.cone.updateMatrixWorld(true);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(4, 3, 7);
    cam.updateMatrixWorld(true);
    v.cone.onBeforeRender(null as never, null as never, cam, null as never, mat, null as never);
    expect(mat.uniforms.uFade!.value).toBe(0);
    cam.position.set(40, 3, 30);
    cam.updateMatrixWorld(true);
    v.cone.onBeforeRender(null as never, null as never, cam, null as never, mat, null as never);
    expect(mat.uniforms.uFade!.value).toBe(1);
    expect(beamFade(new THREE.Vector3(8, 20, 0), new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, 0, 0))).toBeCloseTo(0.5, 6);
    // Round 2 fix pass (police, review): straddling a curb, the pool lies at the higher ground under its rim,
    // so its far side does not sink under the sidewalk.
    view.syncHelis([h], 1, (x) => (x > h.spotlight.x + 2 ? 0.15 : 0));
    expect(v.pool.position.y).toBeGreaterThan(0.15);
    view.syncHelis([h], 1, () => 0);
    expect(v.pool.position.y).toBeLessThan(0.15);
    // Each helicopter has its own beam material: two beams fade separately.
    const h2 = new Helicopter(sim.newId(), 50, 40, 0);
    view.syncHelis([h, h2], 1, () => 0);
    const v2 = (view as unknown as { heliViews: Map<number, { cone: THREE.Mesh }> }).heliViews.get(h2.id)!;
    expect(v2.cone.material).not.toBe(v.cone.material);
  });
});

// ---------------------------------------------------------------------------
// P24: the search area, evade progress and every officer on the radar and map

describe('readable evasion', () => {
  it('shows every police unit and officer on foot as a blinking blip', () => {
    const sim = makeSim();
    sim.wanted.setLevel(2);
    const unit = sim.police.spawnUnit('police', true)!;
    expect(unit.occupants().length).toBe(2);
    internals(sim).deploy(unit);
    const police = (time: number) => collectBlips(sim, time).filter((b) => b.color === '#ff3030' || b.color === '#3060ff');
    const blips = police(0);
    expect(blips.length).toBe(3);
    expect(blips.filter((b) => b.shape === 'dot').length).toBe(1);
    expect(blips.filter((b) => b.shape === 'pip').length).toBe(2);
    // They blink red / blue together.
    expect(new Set(police(0).map((b) => b.color)).size).toBe(1);
    expect(police(0)[0]!.color).not.toBe(police(0.25)[0]!.color);
    sim.wanted.clear();
    expect(police(0).length).toBe(0);
  });

  it("draws the helicopter's sighting ring as far out as its crew sees", () => {
    expect(HELI_SIGHT_RANGE).toBe(HELI_SIGHT);
  });

  it('searchArea is the circle the police search, while the stars flash', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    expect(searchArea(sim)).toBeNull();
    sim.wanted.setLevel(2);
    expect(searchArea(sim)).toBeNull();
    noResponse(sim);
    sim.wanted.lastSeen = sim.time - 3;
    step(sim, 0.1);
    expect(sim.wanted.searching).toBe(true);
    expect(searchArea(sim)).toEqual({ x: sim.wanted.lastSeenX, z: sim.wanted.lastSeenZ, r: sim.wanted.searchRadius() });
    expect(sim.wanted.searchCenter).toEqual({ x: sim.wanted.lastSeenX, z: sim.wanted.lastSeenZ });
  });

  it('evadeProgress is 0 at a sighting, grows at 1/evadeTime a second outside the area and hits 1 as the stars clear', () => {
    const sim = makeSim();
    sim.policeEnabled = false;
    sim.wanted.setLevel(2);
    noResponse(sim);
    const w = sim.wanted;
    expect(w.evadeProgress()).toBe(0);
    // Out of the search area at once.
    const far = sim.roads.nearestNode(sim.player.pos.x + 250, sim.player.pos.z);
    teleport(sim, far.x + 9, far.z + 9);
    expect(w.outside).toBe(true);
    const t = w.evadeTime();
    step(sim, 5);
    expect(w.evadeProgress()).toBeCloseTo(5 / t, 2);
    let last = 0;
    let clearedAfter = -1;
    step(sim, t, (s) => {
      if (w.level > 0) last = w.evadeProgress();
      else if (clearedAfter < 0) clearedAfter = 5 + s;
      return input();
    });
    expect(clearedAfter).toBeCloseTo(t, 1);
    expect(last).toBeGreaterThan(1 - 2 / 60 / t);
    expect(last).toBeLessThanOrEqual(1);
    expect(w.evadeProgress()).toBe(0);
  });

  it('evadeProgress drops back to 0 when the player is spotted again', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    sim.wanted.setLevel(2);
    noResponse(sim);
    const far = sim.roads.nearestNode(sim.player.pos.x + 250, sim.player.pos.z);
    teleport(sim, far.x + 9, far.z + 9);
    step(sim, 5);
    expect(sim.wanted.evadeProgress()).toBeGreaterThan(0.2);
    const p = sim.player.pos;
    const spot = visibleSpot(sim, p.x, p.z, 10);
    officer(sim, spot.x, spot.z);
    step(sim, 0.4);
    expect(sim.wanted.evadeProgress()).toBe(0);
    expect(sim.wanted.searching).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P58: police radio on its own HUD line

describe('dispatch chatter', () => {
  function recordDispatch(sim: Sim): Array<{ text: string; t: number }> {
    const lines: Array<{ text: string; t: number }> = [];
    sim.events.on('dispatch', (e) => lines.push({ text: e.text, t: sim.time }));
    return lines;
  }

  it('names the crime, the district and the suspect when the police are called', () => {
    const sim = makeSim();
    const lines = recordDispatch(sim);
    sim.wanted.setLevel(2);
    step(sim, 1);
    expect(lines.length).toBe(1);
    const zone = sim.world.zoneName(sim.player.pos.x, sim.player.pos.z);
    expect(lines[0]!.text).toContain(zone);
    expect(lines[0]!.text).toMatch(/^All units, .+ reported in .+\. Suspect on foot\.$/);
  });

  it('describes the suspect vehicle by colour and model, and the crime from what he did', () => {
    const sim = makeSim();
    const lines = recordDispatch(sim);
    const lane = longestLane(sim);
    const car = sim.spawnVehicle('sedan', at(lane, 30).x, at(lane, 30).z, lane.heading, 0x1f618d);
    placeInCar(sim, car);
    sim.wanted.crime('murder', car.pos.x, car.pos.z);
    step(sim, 0.5);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toContain('a homicide');
    expect(lines[0]!.text).toContain('Suspect in a blue Velora.');
  });

  it('reports losing sight within a second, then the stand-down after an escape', () => {
    const sim = makeSim();
    sim.policeEnabled = true;
    const lines = recordDispatch(sim);
    sim.wanted.setLevel(1);
    let searchingAt = -1;
    let wasSearching = false;
    step(sim, 50, () => {
      if (!wasSearching && sim.wanted.searching && sim.wanted.level > 0) searchingAt = sim.time;
      wasSearching = sim.wanted.searching;
      return input();
    });
    const lost = lines.find((l) => l.text.startsWith('We lost visual.'));
    expect(lost, lines.map((l) => l.text).join(' | ')).toBeDefined();
    expect(searchingAt).toBeGreaterThan(0);
    expect(lost!.t - searchingAt).toBeLessThan(1);
    expect(lost!.text).toContain(sim.world.zoneName(sim.wanted.lastSeenX, sim.wanted.lastSeenZ));
    expect(sim.wanted.level).toBe(0);
    expect(lines[lines.length - 1]!.text).toBe('All units, return to patrol.');
  });

  it('reports a sighting after a search with the suspect heading', () => {
    const sim = makeSim();
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const lines = recordDispatch(sim);
    sim.wanted.setLevel(2);
    noResponse(sim);
    // The opening line, then 'lost visual' as soon as the gap allows; the sighting comes after the next gap.
    step(sim, 13);
    expect(sim.wanted.searching).toBe(true);
    const p = sim.player.pos;
    const spot = visibleSpot(sim, p.x, p.z, 10);
    officer(sim, spot.x, spot.z);
    step(sim, 1);
    const seen = lines.find((l) => l.text.startsWith('Suspect spotted heading '));
    expect(seen, lines.map((l) => l.text).join(' | ')).toBeDefined();
    expect(seen!.text).toMatch(/^Suspect spotted heading (north|northeast|east|southeast|south|southwest|west|northwest) through .+\.$/);
  });

  // The pacing over a long 5-star chase is in r2_police_dispatch.test.ts.

  it('announces SWAT and the air unit when the chase escalates', () => {
    seedMathRandom(2);
    const sim = makeSim({ ambient: true, seed: 2 });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const lines = recordDispatch(sim);
    sim.wanted.setLevel(2);
    step(sim, 7);
    sim.wanted.setLevel(3);
    step(sim, 7);
    sim.wanted.setLevel(4);
    step(sim, 1);
    const texts = lines.map((l) => l.text);
    expect(texts).toContain('Air unit on scene.');
    expect(texts).toContain('SWAT is rolling.');
  });

  it('forgets the crime of an earlier chase', () => {
    const sim = makeSim();
    const lines = recordDispatch(sim);
    sim.wanted.crime('murder', sim.player.pos.x, sim.player.pos.z);
    step(sim, 0.5);
    expect(lines[0]!.text).toContain('a homicide');
    sim.wanted.clear();
    step(sim, 7);
    sim.wanted.setLevel(3);
    step(sim, 0.5);
    expect(lines.length).toBe(2);
    expect(lines[1]!.text).toContain('a disturbance');
  });

  it('names colours and compass points', () => {
    expect(colourName(0x101820)).toBe('black');
    expect(colourName(0xf4c20d)).toBe('yellow');
    expect(colourName(0xb03a2e)).toBe('red');
    expect(colourName(0x922b21)).toBe('red');
    expect(colourName(0x117a65)).toBe('teal');
    expect(colourName(0xca6f1e)).toBe('orange');
    expect(colourName(0x7f8c8d)).toBe('grey');
    expect(colourName(0xeeeeee)).toBe('white');
    expect(colourName(0x6c3483)).toBe('purple');
    expect(colourName(0x186a3b)).toBe('green');
    expect(colourName(0x1f618d)).toBe('blue');
    // +X east, +Z south.
    expect(compassName(0, -1)).toBe('north');
    expect(compassName(1, 0)).toBe('east');
    expect(compassName(0, 1)).toBe('south');
    expect(compassName(-1, 0)).toBe('west');
    expect(compassName(1, -1)).toBe('northeast');
    expect(compassName(-1, 1)).toBe('southwest');
  });
});
