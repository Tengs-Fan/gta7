// The sea's shelter and depth, baked once over the world for the waves (render/waves.ts): how much of the open sea's
// swell reaches each point, and the drawn water's depth and its slope there, which shoal the waves over the beaches.
// The waves die away towards the walls (quays, sea walls, the causeway, headlands, and decks standing in deep water)
// and inside the water cut into the land (the harbour basin, the coves, the bays and the canal), but run on up the
// beaches, where the depth takes over. Render only: the sim's sea stays flat.

import { WATER_Y } from '../world/constants';
import type { StaticWorld } from '../world/staticWorld';
import { seaDepthCpu, type CountyShore } from './sea';
import type { ShelterMap } from './waves';

/** The lattice's spacing (m), and how far (m) it reaches past the world's bounds into the open sea. */
export const SHELTER_CELL = 4;
const SHELTER_MARGIN = 120;
/**
 * A wall is land within WALL_REACH m of water deeper than WALL_DEPTH m: a quay, a sea wall, a headland's rocks. The
 * beaches shelve gently into the sea, so their sand is no wall. A deck is one where it stands in water deeper than
 * DECK_WALL_DEPTH m, where the waves would reach its underside.
 */
export const WALL_DEPTH = 2.5;
export const WALL_REACH = 8;
export const DECK_WALL_DEPTH = 1;
/** The waves grow from nothing at a wall or in the water cut into the land to their full height this far (m) out. */
export const SHELTER_RAMP = [4, 50] as const;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Bakes the shelter map over the world's bounds: per lattice point the shelter (SHELTER_RAMP over the distance to the
 * nearest wall or water cut into the land), the drawn depth (seaDepthCpu with the county's shore; on land, how far the
 * ground stands over the sea, negated) and its gradient.
 */
export function bakeSeaShelter(world: StaticWorld, county: CountyShore): ShelterMap {
  const layout = world.layout;
  const b = layout.bounds;
  const cell = SHELTER_CELL;
  const minX = Math.floor((b.worldMinX - SHELTER_MARGIN) / cell) * cell;
  const minZ = Math.floor((b.worldMinZ - SHELTER_MARGIN) / cell) * cell;
  const nx = Math.ceil((b.worldMaxX + SHELTER_MARGIN - minX) / cell);
  const nz = Math.ceil((b.worldMaxZ + SHELTER_MARGIN - minZ) / cell);
  const n = nx * nz;
  const depth = new Float32Array(n);
  // Land; and the walls and water cut into the land the shelter is measured from.
  const land = new Uint8Array(n);
  const seed = new Uint8Array(n);
  for (let j = 0; j < nz; j++) {
    const z = minZ + (j + 0.5) * cell;
    for (let i = 0; i < nx; i++) {
      const x = minX + (i + 0.5) * cell;
      const g = world.baseGround(x, z);
      const k = j * nx + i;
      if (g > WATER_Y) {
        depth[k] = WATER_Y - g;
        land[k] = 1;
      } else {
        depth[k] = seaDepthCpu(b, x, z, county);
      }
    }
  }
  // Every lattice point a deck covers any of, so a slip narrower than a cell still counts.
  const cells = (lo: number, hi: number, min: number, count: number): [number, number] => [Math.max(0, Math.floor((lo - min) / cell)), Math.min(count - 1, Math.floor((hi - min) / cell))];
  for (const d of layout.decks) {
    const [i0, i1] = cells(d.rect.minX, d.rect.maxX, minX, nx);
    const [j0, j1] = cells(d.rect.minZ, d.rect.maxZ, minZ, nz);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) if (depth[j * nx + i]! > DECK_WALL_DEPTH) seed[j * nx + i] = 1;
    }
  }
  // Land near deep water is a wall (the deep water dilated by WALL_REACH, a square).
  const reach = Math.ceil(WALL_REACH / cell);
  const deepRow = new Uint8Array(n);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let near = 0;
      for (let di = Math.max(0, i - reach); di <= Math.min(nx - 1, i + reach) && !near; di++) if (depth[j * nx + di]! > WALL_DEPTH) near = 1;
      deepRow[j * nx + i] = near;
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!land[k]) continue;
      for (let dj = Math.max(0, j - reach); dj <= Math.min(nz - 1, j + reach); dj++) {
        if (deepRow[dj * nx + i]) {
          seed[k] = 1;
          break;
        }
      }
    }
  }
  for (const w of layout.water) {
    for (const r of w.rects) {
      const [i0, i1] = cells(r.minX + cell / 2, r.maxX - cell / 2, minX, nx);
      const [j0, j1] = cells(r.minZ + cell / 2, r.maxZ - cell / 2, minZ, nz);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) seed[j * nx + i] = 1;
    }
  }
  const dist = chamfer(seed, nx, nz, cell);
  const data = new Float32Array(n * 4);
  const clampDepth = (k: number) => Math.min(7.5, Math.max(-1, depth[k]!));
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const gx = (clampDepth(j * nx + Math.min(nx - 1, i + 1)) - clampDepth(j * nx + Math.max(0, i - 1))) / (2 * cell);
      const gz = (clampDepth(Math.min(nz - 1, j + 1) * nx + i) - clampDepth(Math.max(0, j - 1) * nx + i)) / (2 * cell);
      data[k * 4] = smooth(SHELTER_RAMP[0], SHELTER_RAMP[1], dist[k]!);
      data[k * 4 + 1] = depth[k]!;
      data[k * 4 + 2] = gx;
      data[k * 4 + 3] = gz;
    }
  }
  return { minX, minZ, cell, nx, nz, data };
}

/** Distance (m) from each lattice point to the nearest seed: a two-pass chamfer over the eight neighbours. */
function chamfer(seed: Uint8Array, nx: number, nz: number, cell: number): Float32Array {
  const d = new Float32Array(nx * nz);
  for (let k = 0; k < d.length; k++) d[k] = seed[k] ? 0 : Infinity;
  const diag = cell * Math.SQRT2;
  const relax = (k: number, i: number, j: number, di: number, dj: number, w: number) => {
    const ii = i + di;
    const jj = j + dj;
    if (ii < 0 || ii >= nx || jj < 0 || jj >= nz) return;
    const v = d[jj * nx + ii]! + w;
    if (v < d[k]!) d[k] = v;
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      relax(k, i, j, -1, 0, cell);
      relax(k, i, j, 0, -1, cell);
      relax(k, i, j, -1, -1, diag);
      relax(k, i, j, 1, -1, diag);
    }
  }
  for (let j = nz - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      relax(k, i, j, 1, 0, cell);
      relax(k, i, j, 0, 1, cell);
      relax(k, i, j, 1, 1, diag);
      relax(k, i, j, -1, 1, diag);
    }
  }
  return d;
}
