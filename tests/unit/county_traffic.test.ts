// Las Lomas County's traffic (docs/map.md): the Haymaker tractor and the farm pickups take the city's kinds by a hash
// of the place, only in the county; the county streams 0.4 of the city's traffic; a tractor tops out at 12 m/s and goes
// round a corner on its wheels; the traffic behind one queues and honks instead of overtaking; and the kind and colour
// cross the multiplayer wire.

import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, type SnapshotMsg } from '../../src/net/protocol';
import type { Vehicle } from '../../src/sim/entities';
import { captureVehicle } from '../../src/sim/snapshot';
import { countryKind, TRAFFIC_MIX, VEHICLE_SPECS, type VehicleKind } from '../../src/sim/specs';
import { COUNTY_BOUNDS } from '../../src/world/country';
import { input, makeSim, placeInCar, step } from './helpers';

const KINDS = Object.keys(VEHICLE_SPECS) as VehicleKind[];

describe('Las Lomas County: the Haymaker and the farm pickups', () => {
  it('remaps kinds by place alone, and only in the county', () => {
    // The city, its promenade and beach and the sound off it: every kind stays itself.
    for (let x = -650; x <= 762; x += 37) {
      for (let z = -1060; z <= 676; z += 41) for (const k of KINDS) expect(countryKind(k, x, z), `${k} at ${x}, ${z}`).toBe(k);
    }
    let pickups = 0;
    let points = 0;
    for (let x = COUNTY_BOUNDS.minX + 5; x < COUNTY_BOUNDS.maxX; x += 23) {
      for (let z = COUNTY_BOUNDS.minZ + 5; z < COUNTY_BOUNDS.maxZ; z += 29) {
        points++;
        expect(countryKind('taxi', x, z)).toBe('tractor');
        expect(countryKind('bus', x, z)).toBe('pickup');
        expect(countryKind('sports', x, z)).toBe('muscle');
        for (const k of ['compact', 'pickup', 'van', 'muscle', 'police', 'tractor'] as const) expect(countryKind(k, x, z)).toBe(k);
        const sedan = countryKind('sedan', x, z);
        expect(countryKind('sedan', x, z)).toBe(sedan);
        if (sedan === 'pickup') pickups++;
        else expect(sedan).toBe('sedan');
      }
    }
    console.log(`[county_traffic] ${pickups} of ${points} county sedans come as pickups`);
    expect(pickups / points).toBeGreaterThan(0.4);
    expect(pickups / points).toBeLessThan(0.6);
  });

  it("streams 0.4 of the city's traffic in the county, with no taxi, bus or sports car among it", () => {
    const sim = makeSim({ seed: 3, police: false, ambient: true, startHour: 12 });
    expect(sim.traffic.targetCount).toBe(26);
    const car = sim.spawnVehicle('sedan', -980, -272, -Math.PI / 2);
    placeInCar(sim, car);
    expect(sim.traffic.targetCount).toBe(10);
    const seen = new Map<VehicleKind, number>();
    const counted = new Set<Vehicle>();
    for (let t = 0; t < 120; t += 1) {
      step(sim, 1);
      for (const v of sim.vehicles) {
        if (v.removed || v.owner !== 'traffic' || counted.has(v)) continue;
        counted.add(v);
        seen.set(v.kind, (seen.get(v.kind) ?? 0) + 1);
      }
    }
    console.log(`[county_traffic] county spawns: ${[...seen].map(([k, n]) => `${k} ${n}`).join(', ')}`);
    expect(counted.size).toBeGreaterThan(8);
    for (const k of ['taxi', 'bus', 'sports'] as const) expect(seen.get(k) ?? 0, k).toBe(0);
    expect(TRAFFIC_MIX.some(([k]) => k === 'taxi')).toBe(true);
  }, 60_000);
});

describe('Las Lomas County: driving the Haymaker', () => {
  it('tops out at 12 m/s, and goes round a 90-degree corner at full speed on its wheels', () => {
    const sim = makeSim({ seed: 1, police: false, ambient: false });
    // West along the causeway from the gateway.
    const v = sim.spawnVehicle('tractor', -500, -264, -Math.PI / 2);
    placeInCar(sim, v);
    let top = 0;
    step(sim, 30, () => {
      top = Math.max(top, v.speed);
      return input({ throttle: 1 });
    });
    console.log(`[county_traffic] Haymaker top speed ${top.toFixed(2)} m/s`);
    expect(top).toBeGreaterThan(11);
    expect(top).toBeLessThanOrEqual(12);
    // On Dry Creek's junction, flat out with the wheel hard over until it heads south.
    v.pos.x = -840;
    v.pos.z = -268;
    v.heading = -Math.PI / 2;
    v.vel.x = -12;
    v.vel.z = 0;
    const h0 = v.heading;
    let t = 0;
    for (; t < 8 && Math.abs(v.heading - h0) < Math.PI / 2; t += 1 / 60) {
      step(sim, 1 / 60, input({ throttle: 1, steer: 1 }));
      expect(v.flipped).toBe(false);
      expect(v.airborne).toBe(false);
    }
    console.log(`[county_traffic] a quarter turn at full lock in ${t.toFixed(2)} s, ${v.speed.toFixed(1)} m/s out of it`);
    expect(Math.abs(v.heading - h0)).toBeGreaterThanOrEqual(Math.PI / 2);
    expect(t).toBeLessThan(6);
  });

  it('holds up the traffic behind it on the Lomas Highway, which queues and honks instead of passing', () => {
    const sim = makeSim({ seed: 2, police: false, ambient: false });
    const roads = sim.roads;
    // Southbound down the west leg's straight, the curve round to the south leg ahead.
    const { lane, s } = roads.nearestLane(-1331, 60, 0);
    expect(lane.line.index).toBeLessThan(0);
    const at = (d: number) => ({ x: lane.sx + lane.dx * (s - d), z: lane.sz + lane.dz * (s - d) });
    const drive = (kind: VehicleKind, d: number): Vehicle => {
      const p = at(d);
      const v = sim.spawnVehicle(kind, p.x, p.z, lane.heading);
      v.owner = 'traffic';
      sim.addDriver(v, 'civilian', 'traffic').owner = 'traffic';
      v.ai!.setLane(lane, s - d);
      v.vel.x = lane.dx * 10;
      v.vel.z = lane.dz * 10;
      return v;
    };
    const tractor = drive('tractor', 0);
    const queue = [drive('pickup', 25), drive('sedan', 50), drive('pickup', 75)];
    const honks = new Set<Vehicle>();
    sim.events.on('horn', (e) => honks.add(e.vehicle));
    let slowest = Infinity;
    let fastest = 0;
    for (let t = 0; t < 45; t += 1 / 60) {
      step(sim, 1 / 60);
      if (t > 8) {
        slowest = Math.min(slowest, tractor.speed);
        fastest = Math.max(fastest, tractor.speed);
      }
    }
    // Along the road: none of them got past it, and they all caught up with it.
    const ahead = (v: Vehicle) => (v.pos.x - tractor.pos.x) * Math.sin(tractor.heading) + (v.pos.z - tractor.pos.z) * Math.cos(tractor.heading);
    const gaps = queue.map((v) => Math.hypot(v.pos.x - tractor.pos.x, v.pos.z - tractor.pos.z));
    console.log(`[county_traffic] the Haymaker at ${slowest.toFixed(1)}-${fastest.toFixed(1)} m/s; the queue ${gaps.map((g) => g.toFixed(0)).join(', ')} m behind it at ${queue.map((v) => v.speed.toFixed(1)).join(', ')} m/s, ${honks.size} honking`);
    expect(slowest).toBeGreaterThan(9);
    expect(fastest).toBeLessThan(11.5);
    for (const v of queue) expect(ahead(v)).toBeLessThan(0);
    expect(Math.max(...gaps)).toBeLessThan(75);
    for (const v of queue) expect(Math.abs(v.speed - tractor.speed)).toBeLessThan(2);
    expect([...honks].some((v) => queue.includes(v))).toBe(true);
    expect(honks.has(tractor)).toBe(false);
  }, 60_000);

  it('keeps its kind and colour through a multiplayer snapshot', () => {
    const sim = makeSim({ seed: 1, police: false, ambient: false });
    const v = sim.spawnVehicle('tractor', -980, -272, 0, VEHICLE_SPECS.tractor.colors[2]);
    const msg: SnapshotMsg = {
      type: 'snapshot', tick: 1, ackSeq: 0, time: 1, full: true,
      clock: { day: 1, hours: 7, rate: 1 / 60 },
      hud: { wanted: 0, searching: false, money: 0, clip: 0, ammo: 0, down: null, locked: false },
      job: { kind: '', status: '', objectives: [] },
      roster: [],
      weather: { kind: 'clear', cloud: 0, rain: 0, storm: 0, wet: 0, dim: 0, fog: 0, wind: { x: 0, z: 0 }, seaState: 0 },
      signalHolds: [],
      brokenProps: [],
      vehicles: [captureVehicle(v)],
      characters: [],
      projectiles: [],
      helis: [],
      pickups: [],
      removed: [],
    };
    const back = decodeMessage(encodeMessage(msg)) as SnapshotMsg;
    expect(back.vehicles[0]!.rare!.kind).toBe('tractor');
    expect(back.vehicles[0]!.rare!.color).toBe(0xc4762e);
  });
});
