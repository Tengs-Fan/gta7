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
