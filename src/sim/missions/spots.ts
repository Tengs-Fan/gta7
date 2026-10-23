// Deterministic mission locations derived from the generated city.

import { rectCX, rectCZ, type ParkingSpot, type Poi } from '../../world/layout';
import type { Lane } from '../../world/roads';
import type { StaticWorld } from '../../world/staticWorld';

export interface MissionSpots {
  lou: Poi;
  dex: Poi;
  bank: Poi;
  marina: Poi;
  louBay: { x: number; z: number };
  packagePickup: { x: number; z: number };
  packageDrop: { x: number; z: number };
  repoCar: ParkingSpot;
  repoGuards: Array<{ x: number; z: number }>;
  vans: ParkingSpot[];
  getaway: { x: number; z: number; heading: number; lane: Lane };
}

const cache = new WeakMap<StaticWorld, MissionSpots>();

function blockCenter(world: StaticWorld, bi: number, bj: number): { x: number; z: number } {
  const b = world.layout.blocks[bj * world.layout.n + bi]!;
  return { x: rectCX(b.rect), z: rectCZ(b.rect) };
}

/**
 * The free parking spot nearest to (x, z), at least 30 m from those in `exclude`; optionally only in
 * `zone`, or only a street-side bay (within 15 m of a lane) that a car can pull out of.
 */
function nearestParking(world: StaticWorld, x: number, z: number, opts: { exclude?: ParkingSpot[]; zone?: string; street?: boolean } = {}): ParkingSpot | null {
  let best: ParkingSpot | null = null;
  let bd = Infinity;
  for (const s of world.layout.parking) {
    if (opts.exclude?.some((e) => Math.hypot(e.x - s.x, e.z - s.z) < 30)) continue;
    if (!world.isFree(s.x, s.z, 1.6)) continue;
    if (opts.zone && world.zoneName(s.x, s.z) !== opts.zone) continue;
    if (opts.street && world.roads.nearestLane(s.x, s.z).dist > 15) continue;
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

function found<T>(spot: T | null): T {
  if (!spot) throw new Error('No parking spot found');
  return spot;
}

/**
 * Where a parcel dropped at parking spot `s` lies: out in the lot's aisle, in front of the bay,
 * where no parked car can end up on top of it.
 */
function aisleSpot(world: StaticWorld, s: ParkingSpot): { x: number; z: number } {
  const x = s.x + Math.sin(s.heading) * 4.6;
  const z = s.z + Math.cos(s.heading) * 4.6;
  return world.isFree(x, z, 0.6) ? { x, z } : (world.findFreeSpot(x, z, 0.6, 3) ?? { x: s.x, z: s.z });
}

export function missionSpots(world: StaticWorld): MissionSpots {
  const cached = cache.get(world);
  if (cached) return cached;
  const poi = (id: string) => {
    const p = world.layout.pois.find((q) => q.id === id);
    if (!p) throw new Error(`Missing POI ${id}`);
    return p;
  };
  const lou = poi('lou');
  const dex = poi('dex');
  const bank = poi('bank');
  const marina = poi('marina');
  const bay = lou.bay!;

  const mid = blockCenter(world, 7, 3);
  const pickupSpot = found(nearestParking(world, mid.x, mid.z));
  const hill = blockCenter(world, 8, 0);
  const drop = world.layout.openSpots
    .filter((s) => s.district === 'hillcrest' && world.isFree(s.x, s.z, 0.8))
    .sort((a, b) => Math.hypot(a.x - hill.x, a.z - hill.z) - Math.hypot(b.x - hill.x, b.z - hill.z))[0];
  if (!drop) throw new Error('No package drop spot');

  const west = blockCenter(world, 1, 5);
  // Lou says the Nightjar is parked in Westside: the block's nearest lots can lie across the zone line.
  const repoCar = nearestParking(world, west.x, west.z, { zone: 'Westside' }) ?? found(nearestParking(world, west.x, west.z));
  const repoGuards: Array<{ x: number; z: number }> = [];
  for (const [ox, oz] of [[4, 3], [-4, 2.5], [0.5, -4.5], [5, -3]] as const) {
    const s = world.findFreeSpot(repoCar.x + ox, repoCar.z + oz, 0.5, 4);
    if (s && repoGuards.length < 3) repoGuards.push(s);
  }

  const vans: ParkingSpot[] = [];
  for (const [bi, bj] of [[0, 9], [8, 8], [2, 1]] as const) {
    const c = blockCenter(world, bi, bj);
    // Street-side, so the last one can make a run for it (see Heatwave).
    vans.push(found(nearestParking(world, c.x, c.z, { exclude: vans, street: true }) ?? nearestParking(world, c.x, c.z, { exclude: vans })));
  }

  const near = world.roads.nearestLane(bank.x + Math.sin(bank.heading) * 10, bank.z + Math.cos(bank.heading) * 10);
  const lane = near.lane;
  const s = Math.min(Math.max(near.s, 8), lane.length - 8);
  const getaway = { x: lane.sx + lane.dx * s, z: lane.sz + lane.dz * s, heading: lane.heading, lane };

  const spots: MissionSpots = {
    lou,
    dex,
    bank,
    marina,
    louBay: { x: rectCX(bay), z: rectCZ(bay) },
    packagePickup: aisleSpot(world, pickupSpot),
    packageDrop: { x: drop.x, z: drop.z },
    repoCar,
    repoGuards,
    vans,
    getaway,
  };
  cache.set(world, spots);
  return spots;
}

/** A point on a lane: `s` m along it, its position and heading. */
export interface LaneSpot {
  lane: Lane;
  s: number;
  x: number;
  z: number;
  heading: number;
}

/** Where Vera Salgado's chapter 2 missions happen. */
export interface Chapter2Spots {
  vera: Poi;
  /** The lane in front of Hotel Salgado: the car Vera leaves for a job, and where deliveries end. */
  curb: LaneSpot;
  /** Shadow Play: the courier waits here, drives to `tailMeet`, then on to `tailEnd`. */
  tailStart: LaneSpot;
  tailMeet: LaneSpot;
  tailEnd: LaneSpot;
  /** Shadow Play's retry from its checkpoint: the player on the sidewalk, his car on the lane, behind the meeting. */
  tailResume: { x: number; z: number; heading: number };
  tailResumeCar: LaneSpot;
  /** Showroom Condition: the yellow Nightjar in Hillcrest, its two minders, and where a retry puts the player. */
  stealCar: ParkingSpot;
  stealGuards: Array<{ x: number; z: number }>;
  stealResume: { x: number; z: number; heading: number };
  /** Rush Hour: the three pickups, in order (the last stop is the curb). */
  pickupStops: LaneSpot[];
  /** Last Call: the evidence box in the impound lot by SAPD Central. */
  evidence: { x: number; z: number };
}

const cache2 = new WeakMap<StaticWorld, Chapter2Spots>();

function laneSpot(lane: Lane, s: number): LaneSpot {
  const at = Math.min(Math.max(s, 8), lane.length - 8);
  return { lane, s: at, x: lane.sx + lane.dx * at, z: lane.sz + lane.dz * at, heading: lane.heading };
}

/** The lane nearest (x, z) (travelling along `heading` when given), at the point nearest it. */
function laneAt(world: StaticWorld, x: number, z: number, heading?: number): LaneSpot {
  const near = world.roads.nearestLane(x, z, heading);
  return laneSpot(near.lane, near.s);
}

/** A free spot `out` m to the side of a lane point, on the side away from the road (the kerb's). */
function besideLane(world: StaticWorld, p: LaneSpot, out: number): { x: number; z: number; heading: number } {
  const sides = [1, -1].map((k) => ({ x: p.x + p.lane.dz * out * k, z: p.z - p.lane.dx * out * k }));
  const off = (q: { x: number; z: number }) => world.roads.nearestLane(q.x, q.z).dist;
  const side = off(sides[0]!) >= off(sides[1]!) ? sides[0]! : sides[1]!;
  const at = world.findFreeSpot(side.x, side.z, 0.5, 6) ?? side;
  return { x: at.x, z: at.z, heading: p.heading };
}

export function chapter2Spots(world: StaticWorld): Chapter2Spots {
  const cached = cache2.get(world);
  if (cached) return cached;
  const vera = world.layout.pois.find((p) => p.id === 'vera');
  if (!vera) throw new Error('Missing POI vera');
  const out = laneAt(world, vera.x + Math.sin(vera.heading) * 8, vera.z + Math.cos(vera.heading) * 8);
  const curb = laneSpot(out.lane, out.s + 10);

  // The courier waits up the street from the hotel, meets his contact by the Midtown line and ends downtown.
  const ahead = { x: curb.x + curb.lane.dx * 75, z: curb.z + curb.lane.dz * 75 };
  const tailStart = laneAt(world, ahead.x, ahead.z, curb.heading);
  const meet = world.roads.node(7, 6);
  const meetNext = world.roads.node(7, 7);
  const tailMeet = laneAt(world, (meet.x + meetNext.x) / 2, (meet.z + meetNext.z) / 2);
  const end = world.roads.node(4, 5);
  const endNext = world.roads.node(4, 6);
  const tailEnd = laneAt(world, (end.x + endNext.x) / 2, (end.z + endNext.z) / 2);
  const tailResumeCar = laneSpot(tailMeet.lane, tailMeet.s - 45);
  const tailResume = besideLane(world, tailResumeCar, 6.5);

  const hill = blockCenter(world, 3, 1);
  const stealCar = nearestParking(world, hill.x, hill.z, { zone: 'Hillcrest', street: true }) ?? found(nearestParking(world, hill.x, hill.z, { street: true }));
  const stealGuards: Array<{ x: number; z: number }> = [];
  for (const [ox, oz] of [[3.5, 3], [-3.5, -3], [4, -3.5], [-4, 3.5]] as const) {
    const s = world.findFreeSpot(stealCar.x + ox, stealCar.z + oz, 0.5, 4);
    if (s && stealGuards.length < 2) stealGuards.push(s);
  }
  const sx = Math.cos(stealCar.heading);
  const sz = -Math.sin(stealCar.heading);
  const nextTo = world.findFreeSpot(stealCar.x + sx * 2.6, stealCar.z + sz * 2.6, 0.5, 5) ?? { x: stealCar.x + sx * 2.6, z: stealCar.z + sz * 2.6 };
  const stealResume = { x: nextTo.x, z: nextTo.z, heading: stealCar.heading };

  const pickupStops = ([[7, 7], [8, 4], [5, 6]] as const).map(([bi, bj]) => {
    const c = blockCenter(world, bi, bj);
    const spot = found(nearestParking(world, c.x, c.z, { street: true }));
    return laneAt(world, spot.x, spot.z);
  });

  const police = world.layout.pois.find((p) => p.id === 'police');
  if (!police) throw new Error('Missing POI police');
  const lot = found(nearestParking(world, police.x, police.z));
  const evidence = aisleSpot(world, lot);

  const spots: Chapter2Spots = { vera, curb, tailStart, tailMeet, tailEnd, tailResume, tailResumeCar, stealCar, stealGuards, stealResume, pickupStops, evidence };
  cache2.set(world, spots);
  return spots;
}
