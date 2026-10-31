// Traffic in Las Lomas County's open fields (docs/map.md): a fast drive round the Lomas Highway meets oncoming cars,
// spawned out of view or beyond the 320 m the never-pop-in rule looks, never in view nearer; seen from the city, cars come
// in over the causeway; the county's cruisers are the sheriff's tan ones, the city's black; and the scanner's lines in
// the county are the sheriff's dispatcher's.

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import { SHERIFF_COLOR, VEHICLE_SPECS } from '../../src/sim/specs';
import { COUNTY_BOUNDS } from '../../src/world/country';
import { rectContains } from '../../src/world/layout';
import type { Lane } from '../../src/world/roads';
import { input, makeSim, placeInCar, step, teleport } from './helpers';

/** The lane on from `lane` along the road: straight on at a junction, round a bend. */
function onward(lane: Lane): Lane {
  return (lane.turns.find((t) => t.kind === 'straight') ?? lane.turns[0]!).to;
}

describe('Las Lomas County: traffic in the open', () => {
  it('meets oncoming traffic on a fast drive round the highway, none of it spawned in view within 320 m', () => {
    const sim = makeSim({ seed: 4, police: false, ambient: true, startHour: 12 });
    const roads = sim.roads;
    const car = sim.spawnVehicle('sedan', -1110, -272, -Math.PI / 2);
    placeInCar(sim, car);
    // West from the Hollister T, round the west leg and east along the south leg, at 20 m/s along its lanes.
    let { lane, s } = roads.nearestLane(-1110, -272, -Math.PI / 2);
    const spawns: Array<{ d: number; seen: boolean }> = [];
    const spawn = sim.spawnVehicle.bind(sim);
    sim.spawnVehicle = (kind, x, z, heading, color) => {
      const p = sim.playerPos();
      spawns.push({ d: Math.hypot(x - p.x, z - p.z), seen: sim.isVisible(x, 1, z) });
      return spawn(kind, x, z, heading, color);
    };
    const met = new Set<Vehicle>();
    const fx = () => Math.sin(car.heading);
    const fz = () => Math.cos(car.heading);
    for (let t = 0; t < 60; t += 1 / 60) {
      s += 20 / 60;
      while (s > lane.length) {
        s -= lane.length;
        lane = onward(lane);
      }
      car.pos.x = lane.sx + lane.dx * s;
      car.pos.z = lane.sz + lane.dz * s;
      car.heading = lane.heading;
      car.vel.x = lane.dx * 20;
      car.vel.z = lane.dz * 20;
      step(sim, 1 / 60, input({ aimOrigin: { x: car.pos.x - fx() * 7, y: 3, z: car.pos.z - fz() * 7 }, aimDir: { x: fx(), y: -0.08, z: fz() }, cameraYaw: car.heading }));
      for (const v of sim.vehicles) {
        if (v.removed || v === car || v.owner !== 'traffic') continue;
        const dx = v.pos.x - car.pos.x;
        const dz = v.pos.z - car.pos.z;
        if (Math.hypot(dx, dz) < 20 && Math.sin(v.heading) * fx() + Math.cos(v.heading) * fz() < -0.7) met.add(v);
      }
    }
    const far = spawns.filter((p) => p.d > 320).length;
    console.log(`[rural_streaming] a minute round the highway at 20 m/s: ${met.size} oncoming cars met; ${spawns.length} spawns, ${far} of them beyond 320 m, ${spawns.filter((p) => p.seen).length} in view`);
    expect(met.size).toBeGreaterThanOrEqual(8);
    expect(spawns.filter((p) => p.seen)).toEqual([]);
    expect(rectContains(COUNTY_BOUNDS, car.pos.x, car.pos.z)).toBe(true);
  }, 60_000);

  it('brings traffic in over the Magnolia Causeway to a player on the city\'s side of it', () => {
    const sim = makeSim({ seed: 5, police: false, ambient: true, startHour: 12 });
    // On Harbor Blvd's pavement by the causeway's gateway, looking west down it.
    const g = sim.roads.node(0, 2);
    const x = g.x + 12;
    const z = g.z + 12;
    teleport(sim, x, z);
    const came = new Set<Vehicle>();
    for (let t = 0; t < 90; t += 0.5) {
      step(sim, 0.5, input({ aimOrigin: { x: x + 4, y: 3, z }, aimDir: { x: -1, y: -0.05, z: 0 }, cameraYaw: -Math.PI / 2 }));
      for (const v of sim.vehicles) {
        // Eastbound on the causeway, within 150 m of its landfall.
        if (!v.removed && v.owner === 'traffic' && v.pos.x < g.x - 30 && v.pos.x > g.x - 180 && Math.abs(v.pos.z - g.z) < 9 && v.vel.x > 3) came.add(v);
      }
    }
    console.log(`[rural_streaming] from Harbor Blvd: ${came.size} cars came in over the causeway in 90 s`);
    expect(came.size).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe('Las Lomas County: the sheriff', () => {
  it('sends tan cruisers in the county and black ones in the city', () => {
    const sim = makeSim({ seed: 2, police: true, ambient: false, startHour: 12 });
    const car = sim.spawnVehicle('sedan', -980, -272, -Math.PI / 2);
    placeInCar(sim, car);
    sim.wanted.setLevel(2);
    const county: number[] = [];
    for (let k = 0; k < 6; k++) {
      const v = sim.police.spawnUnit('police', true);
      if (v && rectContains(COUNTY_BOUNDS, v.pos.x, v.pos.z)) county.push(v.color);
    }
    expect(county.length).toBeGreaterThan(0);
    expect(county.every((c) => c === SHERIFF_COLOR)).toBe(true);
    const swat = sim.police.spawnUnit('swat', true)!;
    expect(swat.color).toBe(VEHICLE_SPECS.swat.colors[0]);
    teleport(sim, 120, 40);
    const city = [1, 2, 3].map(() => sim.police.spawnUnit('police', true)).filter((v): v is Vehicle => v !== null);
    expect(city.length).toBeGreaterThan(0);
    for (const v of city) expect(v.color).toBe(VEHICLE_SPECS.police.colors[0]);
  });

  it("puts the sheriff's dispatcher on the air for a crime in the county, and the city's for one in the city", () => {
    const lines = (x: number, z: number): string[] => {
      const sim = makeSim({ seed: 3, police: true, ambient: false, startHour: 12 });
      const car = sim.spawnVehicle('tractor', x, z, 0);
      placeInCar(sim, car);
      const said: string[] = [];
      sim.events.on('dispatch', (e) => said.push(e.text));
      sim.wanted.lastCrime = 'carjack';
      sim.wanted.setLevel(2);
      step(sim, 1);
      return said;
    };
    const county = lines(-980, -110);
    const city = lines(120, 40);
    console.log(`[rural_streaming] county: ${county.join(' / ')}; city: ${city.join(' / ')}`);
    expect(county[0]).toBe("Deputies, we got a carjacking out by Cud & Sons Dairy. Suspect is fleeing on a Haymaker. Deputies, let's not make this a whole thing.");
    expect(city[0]).toMatch(/^All units, a carjacking reported in .+\. Suspect in an? \w+ Haymaker\.$/);
  });
});
