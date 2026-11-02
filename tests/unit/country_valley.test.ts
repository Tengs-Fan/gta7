// Las Lomas Valley (world/country): Coyote Pass cut flat across the ridge's south shoulder with rock walls either side,
// the Pass Road and the Valley Loop on the lane graph (a route car drives them, ambient traffic streams on them, the
// sheriff's cruisers patrol them), Lake Lomas a hole in the valley's land that the sea can neither reach nor stir, and
// the scanner names the valley's places.

import { describe, expect, it } from 'vitest';
import { bakeSeaShelter } from '../../src/render/seaShelter';
import { countyShore } from '../../src/render/sea';
import { COUNTY_ZONES } from '../../src/sim/dispatch';
import type { Vehicle } from '../../src/sim/entities';
import { SHERIFF_COLOR } from '../../src/sim/specs';
import { WATER_Y } from '../../src/world/constants';
import { COUNTY_BOUNDS, COUNTY_PLOTS, LAKE, PASS_Z, VALLEY_NAME } from '../../src/world/country';
import { rectContains } from '../../src/world/layout';
import { input, makeSim, placeInCar, step, teleport, world } from './helpers';

const W = world();
const L = W.layout;
const roads = W.roads;
const shelterOf = (() => {
  let map: ReturnType<typeof bakeSeaShelter> | null = null;
  return (x: number, z: number): number => {
    map ??= bakeSeaShelter(W, countyShore(L.country));
    const i = Math.min(map.nx - 1, Math.max(0, Math.floor((x - map.minX) / map.cell)));
    const j = Math.min(map.nz - 1, Math.max(0, Math.floor((z - map.minZ) / map.cell)));
    return map.data[(j * map.nx + i) * 4]!;
  };
})();

describe('Coyote Pass', () => {
  it('is flat as the road across the ridge, 35 m wide, with rock walls rising either side to the shoulder', () => {
    for (let x = -1600; x <= -1352; x += 4) for (let dz = -17.5; dz <= 17.5; dz += 2.5) expect(W.groundHeight(x, PASS_Z + dz), `${x}, ${PASS_Z + dz}`).toBe(0);
    // The walls climb 8.5 m to the crest beside the road, and the shoulder runs on at its own height beyond them.
    const crest = L.country.rises[0]!.cx;
    const north = Array.from({ length: 60 }, (_, k) => W.groundHeight(crest, PASS_Z - 10 - k));
    const south = Array.from({ length: 60 }, (_, k) => W.groundHeight(crest, PASS_Z + 10 + k));
    expect(Math.max(...north)).toBeGreaterThan(12);
    expect(Math.max(...south)).toBeLessThan(5);
    expect(north.findIndex((h) => h > 8)).toBeLessThan(30);
    expect(W.groundHeight(crest, PASS_Z - 29.5)).toBeGreaterThan(11.9);
  });

  it('is named, and the road crosses the ridge in it', () => {
    expect(W.zoneName(-1480, PASS_Z)).toBe('Coyote Pass');
    expect(W.zoneName(-1480, PASS_Z - 25)).toBe('Coyote Pass');
    expect(W.zoneName(-1480, -100)).toBe('Coyote Ridge');
  });

  it('stops a car at its walls and lets one through along the road', () => {
    const sim = makeSim({ police: false });
    const car = sim.spawnVehicle('sports', -1480, PASS_Z, 0);
    placeInCar(sim, car);
    // North at 25 m/s across the pass's floor into the wall: it stops short of the shoulder's height.
    car.vel.z = -25;
    car.heading = Math.PI;
    for (let i = 0; i < 60 * 6; i++) {
      car.vel.z = Math.min(car.vel.z, -25 + (i < 40 ? 0 : 25));
      sim.update(1 / 60, input({ throttle: 1 }));
    }
    expect(car.pos.z).toBeGreaterThan(PASS_Z - 28);
    expect(car.pos.y).toBeLessThan(6);
    // West along the road at the same speed, from the Coyote T's side to Valley Cross, it never leaves the ground.
    const through = makeSim({ police: false });
    const c2 = through.spawnVehicle('sports', -1360, PASS_Z + 2, -Math.PI / 2);
    placeInCar(through, c2);
    for (let i = 0; i < 60 * 20 && c2.pos.x > -1700; i++) {
      c2.vel.x = -25;
      c2.vel.z = 0;
      c2.heading = -Math.PI / 2;
      c2.angVel = 0;
      through.update(1 / 60, input());
      expect(c2.airborne).toBe(false);
      expect(c2.pos.y).toBeCloseTo(0, 6);
    }
    expect(c2.pos.x).toBeLessThanOrEqual(-1700);
  });

  it('leaves the fire road to Lookout Point crossing it at ground level, not cut', () => {
    const [cx] = [-1370];
    for (let z = 105; z >= 50; z -= 1) expect(W.groundHeight(cx, z)).toBeLessThan(1.1);
    expect(roads.isOnRoad(cx, PASS_Z)).toBe(true);
  });
});

describe('Las Lomas Valley: roads', () => {
  it('joins the lane graph with a route car that drives the Pass Road and a lap of the Valley Loop', () => {
    const sim = makeSim({ seed: 5, police: false, ambient: false });
    // On the highway's west leg north of the Coyote T, heading south.
    const lane = roads.nearestLane(-1334, 20, 0).lane;
    const v = sim.spawnVehicle('sedan', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading);
    v.owner = 'traffic';
    sim.addDriver(v, 'civilian', 'route');
    v.ai!.speedMul = 1;
    v.ai!.setLane(lane, 10);
    const legs = [{ x: -2165, z: 0 }, { x: -2000, z: -470 }];
    v.ai!.setDestination(legs[0]!.x, legs[0]!.z);
    const visited = new Set<string>();
    let leg = 0;
    let t = 0;
    let fastest = 0;
    for (; t < 400 && leg < legs.length; t += 1 / 60) {
      step(sim, 1 / 60);
      fastest = Math.max(fastest, v.speed);
      visited.add(sim.world.zoneName(v.pos.x, v.pos.z));
      expect(v.inWater).toBe(false);
      if (Math.hypot(v.pos.x - legs[leg]!.x, v.pos.z - legs[leg]!.z) < 14) {
        leg++;
        if (leg < legs.length) v.ai!.setDestination(legs[leg]!.x, legs[leg]!.z);
      }
    }
    console.log(`[country_valley] route car from the highway to the loop's west side and its north side in ${t.toFixed(1)} s, top speed ${fastest.toFixed(1)} m/s, through ${[...visited].join(', ')}`);
    expect(leg).toBe(legs.length);
    expect(fastest).toBeGreaterThan(12);
    expect(visited.has('Coyote Pass')).toBe(true);
    expect(visited.has(VALLEY_NAME)).toBe(true);
  }, 120_000);

  it('streams ambient traffic on the Pass Road and the loop for a player in the valley, none in the lake', () => {
    const sim = makeSim({ seed: 8, police: false, ambient: true, startHour: 12 });
    const x = -1856;
    const z = 98;
    const p = sim.player;
    teleport(sim, x, z);
    const counted = new Set<Vehicle>();
    let yaw = 0;
    for (let f = 0; f < 240 * 60; f++) {
      p.pos.x = x;
      p.pos.z = z;
      yaw += (1 / 60) * 0.15;
      const d = { x: Math.sin(yaw), y: -0.1, z: Math.cos(yaw) };
      sim.update(1 / 60, input({ cameraYaw: yaw, aimDir: d, aimOrigin: { x: x - d.x * 4.3, y: p.pos.y + 2.6, z: z - d.z * 4.3 } }));
      if (f % 30 !== 0) continue;
      for (const v of sim.vehicles) {
        if (v.removed || v.owner !== 'traffic' || v.driver?.isPlayer) continue;
        counted.add(v);
        expect(v.inWater, `vehicle ${v.id} at ${v.pos.x.toFixed(0)}, ${v.pos.z.toFixed(0)}`).toBe(false);
      }
    }
    const valley = [...counted].filter((v) => v.pos.x < -1600).length;
    console.log(`[country_valley] four minutes at Valley Cross: ${counted.size} cars, ${valley} last seen in the valley`);
    expect(counted.size).toBeGreaterThan(3);
    expect(valley).toBeGreaterThan(0);
  }, 120_000);

  it('spawns no pedestrian in the valley, and draws nothing to try', () => {
    const a = makeSim({ seed: 2 });
    const b = makeSim({ seed: 2 });
    for (const [x, z] of [[-1856, 98], [-2000, 300], [-1700, -200]] as const) expect(a.world.walk.randomPointNear(a.rng, x, z, 20, 100)).toBeNull();
    expect(a.rng.next()).toBe(b.rng.next());
  });
});

describe('Las Lomas Valley: the sheriff', () => {
  it('has the valley inside the county for its traffic, its tan cruisers and its dispatcher', () => {
    for (const [x, z] of [[-2200, 0], [-1480, PASS_Z], [-2000, -250], [-1700, 300]] as const) {
      expect(rectContains(COUNTY_BOUNDS, x, z)).toBe(true);
      expect(COUNTY_ZONES.has(W.zoneName(x, z)), W.zoneName(x, z)).toBe(true);
    }
    for (const p of COUNTY_PLOTS) expect(COUNTY_ZONES.has(p.name), p.name).toBe(true);
  });

  it('puts the sheriff\'s cruisers on the valley\'s lanes round a wanted player there', () => {
    const sim = makeSim({ seed: 9, police: true, ambient: true, startHour: 12 });
    sim.cheats.godMode = true;
    teleport(sim, -1856, 98);
    sim.wanted.setLevel(3);
    let cruisers = 0;
    let tan = 0;
    for (let f = 0; f < 60 * 25; f++) {
      step(sim, 1 / 60);
      const here = sim.vehicles.filter((v) => !v.removed && v.kind === 'police' && v.pos.x < -1560);
      cruisers = Math.max(cruisers, here.length);
      tan = Math.max(tan, here.filter((v) => v.color === SHERIFF_COLOR).length);
    }
    console.log(`[country_valley] up to ${cruisers} cruisers in the valley after 25 s of three stars, ${tan} of them the sheriff's tan`);
    expect(cruisers).toBeGreaterThan(0);
    expect(tan).toBe(cruisers);
  }, 60_000);
});

describe('Lake Lomas', () => {
  it('is calm: no swell reaches it, though the open sea east of the city has all of it', () => {
    for (const [x, z] of [[(LAKE.minX + LAKE.maxX) / 2, (LAKE.minZ + LAKE.maxZ) / 2], [LAKE.minX + 14, LAKE.minZ + 14], [LAKE.maxX - 14, LAKE.maxZ - 14]] as const) expect(shelterOf(x, z), `${x}, ${z}`).toBeLessThan(0.02);
    expect(shelterOf(L.bounds.beachEndX + 120, 0)).toBeGreaterThan(0.95);
    // The sea west of the valley lies in the lee of the whole county.
    expect(shelterOf(-2350, -250)).toBeLessThan(0.5);
  });

  it('is deep in the middle, with a beach all round, and no boat gets to it from the sea', () => {
    expect(W.waterDepth(-2000, -250)).toBeGreaterThan(5);
    const sim = makeSim({ police: false });
    // A speedboat out at sea west of the valley, full ahead east: it grounds on the beach, 175 m short of the lake.
    const boat = sim.spawnVehicle('speedboat', -2350, -250, Math.PI / 2);
    placeInCar(sim, boat);
    for (let f = 0; f < 60 * 40; f++) sim.update(1 / 60, input({ throttle: 1 }));
    expect(boat.pos.x).toBeLessThan(-2285);
    // And one on the lake cannot leave it, whichever way it heads.
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const s = makeSim({ police: false });
      const b = s.spawnVehicle('speedboat', -2000, -250, heading);
      placeInCar(s, b);
      for (let f = 0; f < 60 * 30; f++) s.update(1 / 60, input({ throttle: 1 }));
      expect(rectContains(LAKE, b.pos.x, b.pos.z), `heading ${heading}`).toBe(true);
      expect(W.baseGround(b.pos.x, b.pos.z)).toBeLessThan(WATER_Y);
    }
  }, 120_000);
});
