// The AI on Las Lomas County's roads (world/country): a route car drives the loop at speed on its lanes, ambient
// traffic streams and flows round the county for ten minutes without sticking or ending up in the water, the police
// chase a car over the causeway with units placed on the county's lanes, a roadblock stands on the causeway, and the
// GPS leads into the fields.

import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../../src/sim/entities';
import type { Sim } from '../../src/sim/sim';
import { gpsRoute } from '../../src/ui/mapRender';
import { CAUSEWAY } from '../../src/world/country';
import { axisOf, type Lane } from '../../src/world/roads';
import { input, makeSim, placeInCar, step } from './helpers';
import { chaseCamera, fleeBot, liveUnits } from './r2_police_helpers';

/** The county lane leaving node `from` towards `to`, lane `index`. */
function outerLane(sim: Sim, from: number, to: number, index = 0): Lane {
  return sim.roads.lanesBetween(from, to)[index]!;
}

/** A third-person camera behind (or with `back`, looking back past) a car. */
function camera(car: Vehicle, back = false) {
  const fx = Math.sin(car.heading) * (back ? -1 : 1);
  const fz = Math.cos(car.heading) * (back ? -1 : 1);
  const n = Math.hypot(1, 0.1);
  return input({ aimOrigin: { x: car.pos.x - fx * 8, y: car.pos.y + 3, z: car.pos.z - fz * 8 }, aimDir: { x: fx / n, y: -0.1 / n, z: fz / n }, cameraYaw: Math.atan2(fx, fz) });
}

describe('Las Lomas County: driving AI', () => {
  it('drives a route car from Magnolia Ave round the loop and home over the Southgate Bridge, on its lanes, at speed', () => {
    const sim = makeSim({ seed: 3, police: false, ambient: false });
    const roads = sim.roads;
    const g22 = roads.node(0, 2).id;
    const lane = outerLane(sim, g22, roads.nodes[g22]!.neighbors[3]!);
    const v = sim.spawnVehicle('sedan', lane.sx + lane.dx * 5, lane.sz + lane.dz * 5, lane.heading);
    v.owner = 'traffic';
    sim.addDriver(v, 'civilian', 'route');
    v.ai!.speedMul = 1;
    v.ai!.setLane(lane, 5);
    // Round the west leg first (the Lomas Highway's bends), then back to Southgate Ave east of Harbor Blvd.
    const legs = [{ x: -1330, z: 0 }, { x: -430, z: 270 }];
    v.ai!.setDestination(legs[0]!.x, legs[0]!.z);
    const priv = v.ai as unknown as { pathOffset: number };
    let worst = 0;
    let leg = 0;
    let t = 0;
    let fastest = 0;
    const visited = new Set<string>();
    for (; t < 300 && leg < legs.length; t += 1 / 60) {
      step(sim, 1 / 60);
      if (v.speed > 3 && Number.isFinite(priv.pathOffset)) worst = Math.max(worst, priv.pathOffset);
      fastest = Math.max(fastest, v.speed);
      visited.add(sim.world.zoneName(v.pos.x, v.pos.z));
      if (Math.hypot(v.pos.x - legs[leg]!.x, v.pos.z - legs[leg]!.z) < 12) {
        leg++;
        if (leg < legs.length) v.ai!.setDestination(legs[leg]!.x, legs[leg]!.z);
      }
      expect(v.inWater).toBe(false);
    }
    console.log(`[country_ai] route car round the loop in ${t.toFixed(1)} s, worst path offset ${worst.toFixed(2)} m, top speed ${fastest.toFixed(1)} m/s, through ${[...visited].join(', ')}`);
    expect(leg).toBe(legs.length);
    expect(worst).toBeLessThan(2);
    expect(fastest).toBeGreaterThan(18);
    expect(visited.has('Magnolia Causeway')).toBe(true);
    expect(visited.has('Southgate Bridge')).toBe(true);
  });

  it('streams ambient traffic round the county for ten minutes: none stuck 30 s but at a red light, none in the water', () => {
    const sim = makeSim({ seed: 6, police: false, ambient: true, startHour: 12 });
    // On the Lomas Highway's verge between Dry Creek and the Hollister T, slowly looking round.
    const x = -972;
    const z = -279;
    const p = sim.player;
    let yaw = 0;
    let worst = 0;
    let seen = 0;
    const counted = new Set<Vehicle>();
    const stuck = new Map<Vehicle, number>();
    for (let f = 0; f < 600 * 60; f++) {
      p.pos.x = x;
      p.pos.z = z;
      yaw += (1 / 60) * 0.15;
      const d = { x: Math.sin(yaw), y: -0.1, z: Math.cos(yaw) };
      sim.update(1 / 60, input({ cameraYaw: yaw, aimDir: d, aimOrigin: { x: x - d.x * 4.3, y: p.pos.y + 2.6, z: z - d.z * 4.3 } }));
      if (f % 30 !== 0) continue;
      for (const v of sim.vehicles) {
        if (v.removed || !v.ai || !v.driver || v.driver.isPlayer || v.destroyed) continue;
        counted.add(v);
        expect(v.inWater, `vehicle ${v.id} at ${v.pos.x.toFixed(0)}, ${v.pos.z.toFixed(0)}`).toBe(false);
        const lane = v.ai.currentLane();
        // Waiting at a light that is not green is no stall.
        const red = lane !== null && sim.roads.signalState(lane.to, axisOf(lane.dir), sim.time) !== 'green';
        const s = red ? 0 : (stuck.get(v) ?? 0) + 0.5 * (v.speed < 0.5 ? 1 : 0);
        if (v.speed >= 0.5) stuck.set(v, 0);
        else stuck.set(v, s);
        worst = Math.max(worst, stuck.get(v)!);
      }
      seen = Math.max(seen, sim.vehicles.filter((v) => !v.removed && v.owner === 'traffic').length);
    }
    const county = [...counted].filter((v) => v.pos.x < CAUSEWAY.minX).length;
    console.log(`[country_ai] ten minutes on the highway: ${counted.size} cars (${county} last seen in the county), up to ${seen} at once, longest stall outside a red ${worst.toFixed(1)} s`);
    expect(counted.size).toBeGreaterThan(20);
    expect(seen).toBeGreaterThan(4);
    expect(worst).toBeLessThanOrEqual(30);
  }, 300_000);

  it('chases a getaway car west over the causeway with units placed on the county\'s lanes, in the ring round him', () => {
    const sim = makeSim({ seed: 4, police: true, ambient: true, startHour: 12 });
    sim.cheats.godMode = true;
    sim.missions.noBust = true;
    const roads = sim.roads;
    // West along Magnolia Ave from Palmetto St, through the gateway onto the causeway.
    const lane = roads.lanesBetween(roads.node(1, 2).id, roads.node(0, 2).id)[0]!;
    const car = sim.spawnVehicle('sports', lane.sx + lane.dx * 10, lane.sz + lane.dz * 10, lane.heading);
    placeInCar(sim, car);
    car.vel.x = lane.dx * 15;
    car.vel.z = lane.dz * 15;
    const bot = fleeBot(sim, car, Infinity, true);
    sim.wanted.setLevel(3);
    const placed: Array<{ lane: Lane; d: number }> = [];
    const known = new Set<Vehicle>();
    let maxWest = 0;
    for (let t = 0; t < 70; t += 1 / 60) {
      const inp = bot(1 / 60);
      Object.assign(inp, chaseCamera(car));
      sim.update(1 / 60, inp);
      maxWest = Math.min(maxWest, car.pos.x);
      for (const v of liveUnits(sim)) {
        if (known.has(v)) continue;
        known.add(v);
        const on = v.ai?.currentLane();
        if (on && car.pos.x < CAUSEWAY.minX + 28) placed.push({ lane: on, d: Math.hypot(v.pos.x - car.pos.x, v.pos.z - car.pos.z) });
      }
      sim.wanted.setLevel(3);
    }
    const outer = placed.filter((p) => p.lane.line.index < 0);
    console.log(`[country_ai] getaway reached x ${maxWest.toFixed(0)}; ${placed.length} units placed while he was past the causeway's middle, ${outer.length} on county lanes, ${placed.map((p) => p.d.toFixed(0)).join(' ')} m from him`);
    expect(maxWest).toBeLessThan(-900);
    expect(outer.length).toBeGreaterThan(0);
    for (const p of outer) expect(p.d).toBeLessThanOrEqual(215);
  }, 120_000);

  it('stands a roadblock mid-causeway in front of a car heading west', () => {
    const sim = makeSim({ seed: 2, police: true, ambient: false, streetCrime: true });
    const roads = sim.roads;
    const g22 = roads.node(0, 2).id;
    const lane = outerLane(sim, g22, roads.nodes[g22]!.neighbors[3]!, 1);
    const car = sim.spawnVehicle('sedan', lane.sx + lane.dx * 8, lane.sz + lane.dz * 8, lane.heading);
    placeInCar(sim, car);
    car.vel.x = lane.dx * 20;
    car.vel.z = lane.dz * 20;
    sim.wanted.setLevel(3);
    // Looking back over his shoulder: the road ahead is out of his view.
    step(sim, 0.1, camera(car, true));
    const rb = sim.roadblocks.place(3);
    expect(rb).not.toBeNull();
    console.log(`[country_ai] roadblock at ${rb!.x.toFixed(1)}, ${rb!.z.toFixed(1)}, ${rb!.ahead} m ahead, ${rb!.cars.length} cruisers`);
    expect(rb!.x).toBeLessThan(car.pos.x - 100);
    expect(rb!.x).toBeGreaterThan(CAUSEWAY.minX + 16);
    expect(Math.abs(rb!.z + 268)).toBeLessThan(0.01);
    for (const c of rb!.cars) expect(Math.abs(c.pos.z + 268)).toBeLessThan(8);
  });

  it('leads the GPS from the city down Magnolia Ave or Southgate Ave and on into the fields', () => {
    const sim = makeSim({ seed: 1, police: false, ambient: false });
    const dairy = { x: -970, z: -60 };
    const route = gpsRoute(sim, dairy.x, dairy.z);
    const roads = sim.roads;
    const ids = route.slice(1, -1).map((p) => roads.nearestNode(p.x, p.z).id);
    console.log(`[country_ai] GPS from the start to the dairy: ${route.length} points, via ${ids.filter((id) => id < roads.gridNodeCount).slice(-1)}`);
    expect(route.length).toBeGreaterThan(4);
    expect(ids.some((id) => id === roads.node(0, 2).id || id === roads.node(0, 8).id)).toBe(true);
    expect(ids.some((id) => id >= roads.gridNodeCount)).toBe(true);
    const end = route[route.length - 2]!;
    expect(Math.hypot(end.x - dairy.x, end.z - dairy.z)).toBeLessThan(260);
  });
});
