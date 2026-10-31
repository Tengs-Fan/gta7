// Las Lomas County's ground: grass on the land, sand on the beaches down to the seabed, and the causeway's verges, cell
// by cell, each cell twice (CountryView.addCell). Its near mesh follows the sim's ground on a 2 m lattice wherever a
// rise (country.rises) reaches the cell, the slopes' triangles within a centimetre of the sim's, and elsewhere draws
// the flat land as a few quads and the beaches on a 4 m lattice. Its far mesh, drawn past COUNTRY_NEAR, follows the
// ground on a 16 m lattice, its flat land a few quads again, with 2 m skirts hanging under its edges so no gap opens
// where it meets a neighbour's finer mesh. Both take the terrain fog (city/facadeShader.ts): on the hardware tiers the
// far meshes of the cells under a rise stay drawn past the fog's cull, Coyote Ridge's outline in the haze. The city's
// ground surfaces draw it.

import * as THREE from 'three';
import { CAUSEWAY } from '../../world/country';
import { mkRect, rectsMinus, rectsOverlap, type Rect } from '../../world/layout';
import { riseBounds } from '../../world/terrain';
import { withTerrainFog } from '../city/facadeShader';
import { NO_RECT, setGroundAttribute } from '../city/surfaces';
import { GeoBuilder, type UvMode } from '../geo';
import { COUNTRY_CELL } from '../quality';
import type { CountryView } from './index';

/** Lattices (m) of the near mesh where a rise reaches its cell and elsewhere (the beaches), and of the far mesh. */
const SLOPE_STEP = 2;
const NEAR_STEP = 4;
const FAR_STEP = 16;
/** How far (m) the far mesh's skirts hang under its edges: more than its chords ever stray from the finer meshes'. */
const SKIRT = 2;

/** r and the cell's overlap, or null. */
function clip(r: Rect, cell: Rect): Rect | null {
  const q = mkRect(Math.max(r.minX, cell.minX), Math.max(r.minZ, cell.minZ), Math.min(r.maxX, cell.maxX), Math.min(r.maxZ, cell.maxZ));
  return q.maxX > q.minX && q.maxZ > q.minZ ? q : null;
}

/**
 * Skirts under the sides of q that lie on the cell's edges, facing out of the cell, from the ground at each `step` m of
 * the side down SKIRT m. A neighbour's finer mesh along that edge stands within SKIRT of the far mesh's chords.
 */
function skirts(g: GeoBuilder, q: Rect, cell: Rect, step: number, h: (x: number, z: number) => number, uv: UvMode): void {
  const s = uv.kind === 'world' ? 1 / uv.scale : 0;
  const along = (a: number, b: number) => {
    const out = [a];
    for (let v = (Math.floor(a / step) + 1) * step; v < b - 1e-6; v += step) if (v > a + 1e-6) out.push(v);
    out.push(b);
    return out;
  };
  // Each side from one end to the other with the cell's outside on its left, so the quad faces out.
  const side = (pts: Array<[number, number]>) => {
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1]!;
      const [bx, bz] = pts[i]!;
      const ay = h(ax, az);
      const by = h(bx, bz);
      g.quad(ax, ay - SKIRT, az, bx, by - SKIRT, bz, bx, by, bz, ax, ay, az, [ax * s, -az * s, bx * s, -bz * s, bx * s, -bz * s, ax * s, -az * s]);
    }
  };
  const xs = along(q.minX, q.maxX);
  const zs = along(q.minZ, q.maxZ);
  if (q.minZ === cell.minZ) side(xs.map((x): [number, number] => [x, q.minZ]).reverse());
  if (q.maxZ === cell.maxZ) side(xs.map((x): [number, number] => [x, q.maxZ]));
  if (q.minX === cell.minX) side(zs.map((z): [number, number] => [q.minX, z]));
  if (q.maxX === cell.maxX) side(zs.map((z): [number, number] => [q.maxX, z]).reverse());
}

export function buildCountryGround(view: CountryView): void {
  const world = view.world;
  const country = world.layout.country;
  const surfaces = view.city.ground;
  const grassUv = { kind: 'world', scale: surfaces.tile('grass') } as const;
  const sandUv = { kind: 'world', scale: surfaces.tile('sand') } as const;
  const ground = (x: number, z: number) => world.baseGround(x, z);
  const fog = view.city.buildingU;
  const grassMat = withTerrainFog(surfaces.patch(surfaces.material('grass'), 'grass'), fog);
  const sandMat = withTerrainFog(surfaces.patch(surfaces.material('sand'), 'sand'), fog);
  const b = country.bounds;
  // The beaches and the seabed round the land, short of the causeway's verges.
  const sea = rectsMinus([b], [...country.land, CAUSEWAY]);
  const c = COUNTRY_CELL;
  for (let x0 = Math.floor(b.minX / c) * c; x0 < b.maxX; x0 += c) {
    for (let z0 = Math.floor(b.minZ / c) * c; z0 < b.maxZ; z0 += c) {
      const cell = mkRect(x0, z0, x0 + c, z0 + c);
      const sloped = country.rises.some((rise) => rectsOverlap(riseBounds(rise), cell));
      const near = { grass: new GeoBuilder(false), sand: new GeoBuilder(false) };
      const far = { grass: new GeoBuilder(false), sand: new GeoBuilder(false) };
      for (const r of country.land) {
        const q = clip(r, cell);
        if (!q) continue;
        if (country.rises.some((rise) => rectsOverlap(riseBounds(rise), q))) {
          near.grass.heightGrid(q.minX, q.minZ, q.maxX, q.maxZ, SLOPE_STEP, ground, grassUv);
          far.grass.heightGrid(q.minX, q.minZ, q.maxX, q.maxZ, FAR_STEP, ground, grassUv);
          skirts(far.grass, q, cell, FAR_STEP, ground, grassUv);
        } else {
          near.grass.flat(q.minX, q.minZ, q.maxX, q.maxZ, 0, grassUv);
          far.grass.flat(q.minX, q.minZ, q.maxX, q.maxZ, 0, grassUv);
        }
      }
      for (const r of sea) {
        const q = clip(r, cell);
        if (!q) continue;
        near.sand.heightGrid(q.minX, q.minZ, q.maxX, q.maxZ, sloped ? SLOPE_STEP : NEAR_STEP, ground, sandUv);
        far.sand.heightGrid(q.minX, q.minZ, q.maxX, q.maxZ, FAR_STEP, ground, sandUv);
        skirts(far.sand, q, cell, FAR_STEP, ground, sandUv);
      }
      // The causeway's verges either side of its carriageway, which the roads draw over, in the cells they cross.
      const verge = clip(CAUSEWAY, cell);
      if (verge) for (const g of [near.grass, far.grass]) g.flat(verge.minX, verge.minZ, verge.maxX, verge.maxZ, 0, grassUv);
      const mesh = (g: GeoBuilder, mat: THREE.Material, name: string) => {
        if (g.vertexCount === 0) return null;
        const m = new THREE.Mesh(setGroundAttribute(g.build(), [], NO_RECT), mat);
        m.name = name;
        return m;
      };
      view.addCell(
        cell,
        [mesh(near.grass, grassMat, 'country-grass'), mesh(near.sand, sandMat, 'country-sand')].filter((m) => m !== null),
        [mesh(far.grass, grassMat, 'country-grass-far'), mesh(far.sand, sandMat, 'country-sand-far')].filter((m) => m !== null),
        sloped,
      );
    }
  }
}
