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

function nearestParking(world: StaticWorld, x: number, z: number, exclude: ParkingSpot[] = []): ParkingSpot {
  let best: ParkingSpot | null = null;
  let bd = Infinity;
  for (const s of world.layout.parking) {
    if (exclude.some((e) => Math.hypot(e.x - s.x, e.z - s.z) < 30)) continue;
    if (!world.isFree(s.x, s.z, 1.6)) continue;
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  if (!best) throw new Error('No parking spot found');
  return best;
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
  const pickupSpot = nearestParking(world, mid.x, mid.z);
  const hill = blockCenter(world, 8, 0);
  const drop = world.layout.openSpots
    .filter((s) => s.district === 'hillcrest' && world.isFree(s.x, s.z, 0.8))
    .sort((a, b) => Math.hypot(a.x - hill.x, a.z - hill.z) - Math.hypot(b.x - hill.x, b.z - hill.z))[0];
  if (!drop) throw new Error('No package drop spot');

  const west = blockCenter(world, 1, 5);
  const repoCar = nearestParking(world, west.x, west.z);
  const repoGuards: Array<{ x: number; z: number }> = [];
  for (const [ox, oz] of [[4, 3], [-4, 2.5], [0.5, -4.5], [5, -3]] as const) {
    const s = world.findFreeSpot(repoCar.x + ox, repoCar.z + oz, 0.5, 4);
    if (s && repoGuards.length < 3) repoGuards.push(s);
  }

  const vans: ParkingSpot[] = [];
  for (const [bi, bj] of [[0, 9], [8, 8], [2, 1]] as const) {
    const c = blockCenter(world, bi, bj);
    vans.push(nearestParking(world, c.x, c.z, vans));
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
    packagePickup: { x: pickupSpot.x, z: pickupSpot.z },
    packageDrop: { x: drop.x, z: drop.z },
    repoCar,
    repoGuards,
    vans,
    getaway,
  };
  cache.set(world, spots);
  return spots;
}
