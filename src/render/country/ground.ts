// Las Lomas County's ground: grass on the land, sand on the beaches down to the seabed, and the causeway's verges, cell
// by cell. The land is flat but under a rise (country.rises), where it follows the sim's ground on a 4 m lattice as the
// beaches do; the city's ground surfaces draw it. The flat grass is a few quads a cell, so, like the city's thin ground
// layers, it is one mesh: in cells it would only add draws; the beaches' lattice is culled by cell.

import { CAUSEWAY } from '../../world/country';
import { mkRect, rectsMinus, rectsOverlap, type Rect } from '../../world/layout';
import { riseBounds } from '../../world/terrain';
import { NO_RECT, setGroundAttribute } from '../city/surfaces';
import { GeoBuilder } from '../geo';
import { COUNTRY_CELL } from '../quality';
import type { CountryView } from './index';

/** Lattice (m) of the ground that is not flat: the beaches, and the land under a rise. */
const GROUND_STEP = 4;

/** r and the cell's overlap, or null. */
function clip(r: Rect, cell: Rect): Rect | null {
  const q = mkRect(Math.max(r.minX, cell.minX), Math.max(r.minZ, cell.minZ), Math.min(r.maxX, cell.maxX), Math.min(r.maxZ, cell.maxZ));
  return q.maxX > q.minX && q.maxZ > q.minZ ? q : null;
}

export function buildCountryGround(view: CountryView): void {
  const world = view.world;
  const country = world.layout.country;
  const surfaces = view.city.ground;
  const grass = new GeoBuilder(false);
  const sand = new GeoBuilder(false);
  const grassUv = { kind: 'world', scale: surfaces.tile('grass') } as const;
  const sandUv = { kind: 'world', scale: surfaces.tile('sand') } as const;
  const ground = (x: number, z: number) => world.baseGround(x, z);
  const b = country.bounds;
  // The beaches and the seabed round the land, short of the causeway's verges.
  const sea = rectsMinus([b], [...country.land, CAUSEWAY]);
  const c = COUNTRY_CELL;
  for (let x0 = Math.floor(b.minX / c) * c; x0 < b.maxX; x0 += c) {
    for (let z0 = Math.floor(b.minZ / c) * c; z0 < b.maxZ; z0 += c) {
      const cell = mkRect(x0, z0, x0 + c, z0 + c);
      for (const r of country.land) {
        const q = clip(r, cell);
        if (!q) continue;
        if (country.rises.some((rise) => rectsOverlap(riseBounds(rise), q))) grass.heightGrid(q.minX, q.minZ, q.maxX, q.maxZ, GROUND_STEP, ground, grassUv);
        else grass.flat(q.minX, q.minZ, q.maxX, q.maxZ, 0, grassUv);
      }
      for (const r of sea) {
        const q = clip(r, cell);
        if (q) sand.heightGrid(q.minX, q.minZ, q.maxX, q.maxZ, GROUND_STEP, ground, sandUv);
      }
    }
  }
  // The causeway's verges either side of its carriageway, which the roads draw over.
  grass.flat(CAUSEWAY.minX, CAUSEWAY.minZ, CAUSEWAY.maxX, CAUSEWAY.maxZ, 0, grassUv);
  view.add(setGroundAttribute(grass.build(), [], NO_RECT), surfaces.patch(surfaces.material('grass'), 'grass'), { name: 'country-grass', split: country.rises.length > 0 });
  view.add(setGroundAttribute(sand.build(), []), surfaces.patch(surfaces.material('sand'), 'sand'), { name: 'country-sand' });
}
