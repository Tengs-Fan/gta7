// Round 2 fix pass 5b, AI: two regressions from fix pass 5's police fixes. A pursuit car that stopped at the sea turns
// back after a target who comes ashore (and still never drives in), and a gunman whose shot runs only within the margin
// kept round a vehicle fires when he has no room to step aside (and still never fires through a crewmate or into a
// vehicle that hides his target). The regression tests fail on 1d5716a; the guards pin what the fixes must keep.

import { describe, expect, it } from 'vitest';
import { rayObb3 } from '../../src/core/collision';
import { makeBrain } from '../../src/sim/brains';
import { DriverAI } from '../../src/sim/driver';
import type { Character, Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { vehicleObb } from '../../src/sim/vehiclePhysics';
import { input, makeSim, placeInCar, step, teleport } from './helpers';

// ---------------------------------------------------------------------------
// Medium: a pursuit car that stops at the sea freezes and never turns back after the player

/** The x on Ocean Beach, at z, where the sea gets `depth` m deep. */
function seaAt(sim: Sim, depth: number, z: number): number {
  let x = sim.world.bounds.beachStartX;
  while (sim.world.waterDepth(x, z) < depth) x += 0.1;
  return x;
}

/** A police car at (x, z) facing `heading`, its driver on the chase policy. */
function cruiser(sim: Sim, x: number, z: number, heading: number): Vehicle {
  const car = sim.spawnVehicle('police', x, z, heading);
  sim.seat(sim.spawnCharacter('cop', x, z), car, 0);
  car.ai = new DriverAI(sim, car, 'chase');
  return car;
}

/** Steps `secs`: how close `car` came to `target`, the deepest water it stood in, how often it backed up, where it ended. */
function follow(sim: Sim, car: Vehicle, secs: number, target: () => { x: number; z: number }) {
  let closest = Infinity;
  let deepest = 0;
  let reverses = 0;
  let backing = false;
  step(sim, secs, () => {
    const t = target();
    closest = Math.min(closest, Math.hypot(car.pos.x - t.x, car.pos.z - t.z));
    deepest = Math.max(deepest, sim.world.waterDepth(car.pos.x, car.pos.z));
    const b = car.forwardSpeed < -0.3;
    if (b && !backing) reverses++;
    backing = b;
    return input();
  });
  return { closest, deepest, reverses, inWater: car.inWater, end: { x: car.pos.x, z: car.pos.z } };
}

describe('a pursuit car stopped at the sea turns back after its target, and still never drives in', () => {
  it.each([
    { depth: 0.4, heading: 0.5, facing: 'down the beach and out to sea, the man ahead to its right' },
    { depth: 0.2, heading: 1.5, facing: 'out to sea, the man behind it' },
  ])('from $depth m of water, facing $facing: it gets to a man on foot 36 m inland', ({ depth, heading }) => {
    const sim = makeSim({ police: false });
    const x = seaAt(sim, depth, -150);
    const car = cruiser(sim, x, -150, heading);
    teleport(sim, x - 20, -120);
    car.ai!.target = sim.player;
    const r = follow(sim, car, 20, () => sim.player.pos);
    // On 1d5716a it stood there for good on the handbrake, 36 m from him (in 0.2 m of water after driving on 7 m).
    expect(r.inWater, JSON.stringify(r)).toBe(false);
    expect(r.closest, JSON.stringify(r)).toBeLessThan(15);
  });

  it("chasing the player's car into the shallows: it stops at the water, waits there, and follows him back inland", () => {
    const sim = makeSim({ police: false });
    const x = seaAt(sim, 0.6, -150);
    const ride = sim.spawnVehicle('sedan', x, -150, Math.PI / 2);
    placeInCar(sim, ride);
    const car = cruiser(sim, x - 50, -150, Math.PI / 2);
    car.ai!.target = sim.player;
    // Out in 0.6 m of water he is across the water from it: it stops short of the deep water (fix pass 5) and waits
    // there, without rocking back and forth.
    const out = follow(sim, car, 8, () => ride.pos);
    expect(out.inWater, JSON.stringify(out)).toBe(false);
    expect(out.deepest, JSON.stringify(out)).toBeLessThan(0.45);
    expect(out.reverses, JSON.stringify(out)).toBe(0);
    expect(out.closest, JSON.stringify(out)).toBeLessThan(12);
    // Back on the sand 36 m inland, he drives off. On 1d5716a the car stayed where it stopped, 27 m from him.
    teleport(sim, x - 36, -150);
    ride.heading = -Math.PI / 2;
    const back = follow(sim, car, 15, () => ride.pos);
    expect(back.inWater, JSON.stringify(back)).toBe(false);
    expect(back.closest, JSON.stringify(back)).toBeLessThan(15);
  });

  it('guard: with him swimming out at sea, it waits at the water without rocking back and forth', () => {
    const sim = makeSim({ police: false });
    const x = seaAt(sim, 0.3, -150);
    const car = cruiser(sim, x, -150, Math.PI / 2);
    teleport(sim, x + 30, -125);
    car.ai!.target = sim.player;
    step(sim, 0.5);
    expect(sim.player.state).toBe('swimming');
    const r = follow(sim, car, 20, () => sim.player.pos);
    expect(r.inWater, JSON.stringify(r)).toBe(false);
    expect(r.reverses, JSON.stringify(r)).toBe(0);
    expect(Math.hypot(r.end.x - x, r.end.z + 150), JSON.stringify(r)).toBeLessThan(2);
  });

  it('guard: pulled up behind his stopped car in the shallows, it waits there instead of backing up every few seconds', () => {
    for (const depth of [0.4, 0.42]) {
      const sim = makeSim({ police: false });
      const x = seaAt(sim, depth, -150);
      const ride = sim.spawnVehicle('sedan', x, -150, Math.PI / 2);
      placeInCar(sim, ride);
      const car = cruiser(sim, x - 40, -150, Math.PI / 2);
      // As the police make for a car that has stopped, so as to pull up behind it (see PoliceSystem.updateUnits).
      car.ai!.dest = ride.pos;
      const r = follow(sim, car, 20, () => ride.pos);
      expect(r.inWater, `${depth} m: ${JSON.stringify(r)}`).toBe(false);
      // (Held up behind something for 9 s, any car backs up a little once to make room.)
      expect(r.reverses, `${depth} m: ${JSON.stringify(r)}`).toBeLessThanOrEqual(1);
    }
  });

  it('guard: standing in 0.6 m of water itself, it never backs further in after a man inland', () => {
    // (Backing up from where the sea holds it back only ever leads out of it when it stands in shallower water.)
    for (const heading of [-Math.PI / 2, Math.PI / 2]) {
      const sim = makeSim({ police: false });
      const x = seaAt(sim, 0.6, -150);
      const car = cruiser(sim, x, -150, heading);
      teleport(sim, x - 36, -150);
      car.ai!.target = sim.player;
      const r = follow(sim, car, 20, () => sim.player.pos);
      expect(r.inWater, `heading ${heading}: ${JSON.stringify(r)}`).toBe(false);
      expect(r.deepest, `heading ${heading}: ${JSON.stringify(r)}`).toBeLessThan(0.65);
    }
  });
});

// ---------------------------------------------------------------------------
// Low: a gang gunman never fires, pressed against a wall, when the margin round a vehicle blocks his shot

/**
 * A bus parked with its side `width` m from the west wall of a garage (the Hillcrest Spray Shack), no bus with `width`
 * null: the wall's face is at `wall`, `x` runs down the gap 0.38 m off the wall, and `z` is level with the wall's middle.
 */
function gap(width: number | null = 0.75): { sim: Sim; wall: number; x: number; z: number; bus: Vehicle | null } {
  const sim = makeSim({ police: false });
  const garage = sim.world.layout.garages.find((g) => g.side !== 'W')!;
  const w = garage.walls.find((o) => o.maxX - o.minX < 1 && o.maxZ - o.minZ > 8)!;
  const z = (w.minZ + w.maxZ) / 2;
  sim.player.health = sim.player.maxHealth = 1e6;
  // 0.75 m is room enough for a man (0.35 m round) between the wall and the bus's side.
  return { sim, wall: w.maxX, x: w.maxX + 0.38, z, bus: width === null ? null : sim.spawnVehicle('bus', w.maxX + width + 1.3, z, 0) };
}

/** A gang gunman with a pistol at (x, z) facing `heading`, fighting the player. */
function gunman(sim: Sim, x: number, z: number, heading: number): Character {
  const c = sim.spawnCharacter('gang', x, z);
  c.inventory.give('pistol', 999);
  c.inventory.current = 'pistol';
  c.inventory.infinite = true;
  c.heading = c.aimYaw = heading;
  c.brain = makeBrain('fight');
  c.brain.brave = c.brain.hostile = true;
  c.brain.modeTimer = 25;
  c.brain.target = sim.player;
  return c;
}

/** A gang member standing still at (x, z). */
function crewmate(sim: Sim, x: number, z: number): Character {
  const m = sim.spawnCharacter('gang', x, z);
  m.brain = makeBrain('stand');
  return m;
}

/** Steps `secs` (calling `each` every frame): the shots `c` fires, his hits on the player and on `mate`, and his rounds into vehicles. */
function tally(sim: Sim, c: Character, secs: number, mate: Character | null = null, each = () => {}) {
  let shots = 0;
  let hits = 0;
  let mateHits = 0;
  let intoVehicles = 0;
  sim.events.on('shot', (e) => {
    if (e.shooter === c) shots++;
  });
  sim.events.on('damage', (e) => {
    if (e.attacker === c && e.victim === sim.player) hits++;
    if (e.attacker === c && e.victim === mate) mateHits++;
  });
  const damageVehicle = sim.combat.damageVehicle.bind(sim.combat);
  sim.combat.damageVehicle = (v, amount, by, kind) => {
    if (by === c) intoVehicles++;
    damageVehicle(v, amount, by, kind);
  };
  step(sim, secs, () => {
    each();
    return input();
  });
  return { shots, hits, mateHits, intoVehicles, end: { x: c.pos.x, z: c.pos.z } };
}

describe('a gunman whose line of fire runs past a vehicle', () => {
  it('fires down a narrow gap between a bus and a wall at the player in plain view, his shot clear of the bus', () => {
    const { sim, x, z, bus: b } = gap();
    const bus = b!;
    const c = gunman(sim, x, z + 4, Math.PI);
    teleport(sim, x, z - 4);
    // Only the margin kept round the bus for the spread of his shot is in the way: the shot itself misses it.
    const m = sim.combat.muzzle(c, false);
    const t = { x: sim.player.pos.x, y: sim.player.pos.y + sim.player.height * 0.62, z: sim.player.pos.z };
    const len = Math.hypot(t.x - m.x, t.y - m.y, t.z - m.z);
    const obb = vehicleObb(bus, { x: 0, z: 0, hw: 0, hl: 0, h: 0 });
    expect(rayObb3(m.x, m.y, m.z, (t.x - m.x) / len, (t.y - m.y) / len, (t.z - m.z) / len, obb, bus.pos.y, bus.pos.y + bus.spec.height, len)).toBe(-1);
    const r = tally(sim, c, 10);
    // On 1d5716a: not a shot in 10 s, his side-step pressing him into the wall; before fix pass 5, 16 shots and 15 hits.
    expect(r.shots, JSON.stringify(r)).toBeGreaterThan(5);
    expect(r.hits, JSON.stringify(r)).toBeGreaterThan(3);
    // His fire goes at the player: a round of its spread may still graze the bus beside his line (1 of 16 here).
    expect(r.intoVehicles, JSON.stringify(r)).toBeLessThanOrEqual(2);
  });

  it('guard: holds his fire from that gap at the player hidden beyond the bus: no round into it', () => {
    const { sim, x, z, bus } = gap();
    const c = gunman(sim, x, z + 4, Math.PI);
    teleport(sim, bus!.pos.x + bus!.halfW + 0.8, z - 2);
    const r = tally(sim, c, 10);
    expect(r, JSON.stringify(r)).toMatchObject({ shots: 0, intoVehicles: 0 });
  });

  it('guard: holds his fire from that gap with a crewmate standing between them', () => {
    const { sim, x, z } = gap();
    const c = gunman(sim, x, z + 4, Math.PI);
    const mate = crewmate(sim, x, z);
    teleport(sim, x, z - 4);
    const r = tally(sim, c, 10, mate);
    expect(r, JSON.stringify(r)).toMatchObject({ shots: 0, mateHits: 0 });
  });

  it('guard: in a 3 m passage beside a bus, a crewmate in his line, he turns back once at most and holds his fire', () => {
    // No side-step there takes his line clear of the crewmate 4 m on: rather than step to and fro across the passage
    // for good, he stands his ground.
    const { sim, wall, z } = gap(3);
    const x = wall + 1.5;
    const c = gunman(sim, x, z + 4, Math.PI);
    const mate = crewmate(sim, x, z);
    teleport(sim, x, z - 4);
    let turns = 0;
    let last = 0;
    const r = tally(sim, c, 10, mate, () => {
      const s = c.brain!.stepSide;
      if (s !== 0 && last !== 0 && s !== last) turns++;
      if (s !== 0) last = s;
    });
    expect({ ...r, turns }, JSON.stringify({ ...r, turns })).toMatchObject({ shots: 0, mateHits: 0 });
    expect(turns, JSON.stringify({ ...r, turns })).toBeLessThanOrEqual(1);
  });

  it('steps the other way, off a wall on the side his id picks, past a crewmate in his line, and fires', () => {
    // (The side-step for a crewmate in line went the way of his id, whatever was there, before fix pass 5 too.)
    const { sim, x, z } = gap(null);
    const c = gunman(sim, x, z, 0);
    // The way his id picks (1: to the right of his line to the player, -1: to its left): the player where that is the wall.
    const side = c.id % 2 === 0 ? 1 : -1;
    const mate = crewmate(sim, x, z + side * 4);
    teleport(sim, x, z + side * 8);
    const r = tally(sim, c, 10, mate);
    // On 1d5716a: no shot, pressed into the wall.
    expect(r.mateHits, JSON.stringify(r)).toBe(0);
    expect(r.shots, JSON.stringify(r)).toBeGreaterThan(5);
    expect(r.end.x - x, JSON.stringify(r)).toBeGreaterThan(0.5);
  });
});
