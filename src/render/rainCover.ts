// The rain cover map: for every COVER_CELL square over the world, the height of the highest roof over its centre
// (buildings, garage roofs, pier and marina decks). Rain streaks below it are not drawn and the ground under it stays
// dry. Pure data, built once from the static world, so tests can read it without a GPU.

import { GARAGE_EAVE, GARAGE_ROOF, type StaticWorld } from '../world/staticWorld';
import type { Rect } from '../world/layout';

/** Cell size of the cover map in metres. */
export const COVER_CELL = 2;
/** Height stored where nothing covers a cell: far below any ground, so nothing counts as under it. */
export const COVER_NONE = -1000;

export interface CoverMap {
  /** Row-major heights, `width` cells along x per row, `height` rows along z. */
  data: Float32Array;
  width: number;
  height: number;
  minX: number;
  minZ: number;
  cell: number;
}

/** Raises every cell whose centre lies inside `r` to at least `y`. */
function cover(map: CoverMap, r: Rect, y: number): void {
  const { cell, minX, minZ, width, height, data } = map;
  const i0 = Math.max(0, Math.ceil((r.minX - minX) / cell - 0.5));
  const i1 = Math.min(width - 1, Math.floor((r.maxX - minX) / cell - 0.5));
  const j0 = Math.max(0, Math.ceil((r.minZ - minZ) / cell - 0.5));
  const j1 = Math.min(height - 1, Math.floor((r.maxZ - minZ) / cell - 0.5));
  for (let j = j0; j <= j1; j++) {
    const row = j * width;
    for (let i = i0; i <= i1; i++) if (data[row + i]! < y) data[row + i] = y;
  }
}

export function buildCoverMap(world: StaticWorld, cell = COVER_CELL): CoverMap {
  const L = world.layout;
  const b = L.bounds;
  const width = Math.ceil((b.worldMaxX - b.worldMinX) / cell);
  const height = Math.ceil((b.worldMaxZ - b.worldMinZ) / cell);
  const map: CoverMap = { data: new Float32Array(width * height).fill(COVER_NONE), width, height, minX: b.worldMinX, minZ: b.worldMinZ, cell };
  for (const bld of L.buildings) for (const t of bld.tiers) cover(map, t, t.y1);
  for (const g of L.garages) {
    const r = g.rect;
    cover(map, { minX: r.minX - GARAGE_EAVE, minZ: r.minZ - GARAGE_EAVE, maxX: r.maxX + GARAGE_EAVE, maxZ: r.maxZ + GARAGE_EAVE }, g.height + GARAGE_ROOF);
  }
  for (const d of L.decks) cover(map, d.rect, d.y);
  return map;
}

/** The cover height of the cell holding (x, z); COVER_NONE outside the map. */
export function coverAt(map: CoverMap, x: number, z: number): number {
  const i = Math.floor((x - map.minX) / map.cell);
  const j = Math.floor((z - map.minZ) / map.cell);
  if (i < 0 || j < 0 || i >= map.width || j >= map.height) return COVER_NONE;
  return map.data[j * map.width + i]!;
}
