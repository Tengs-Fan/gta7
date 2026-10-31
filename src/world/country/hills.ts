// Las Lomas County's landscape: Coyote Ridge along the west coast with six wind turbines along its top, the foothills
// between the farms, the gravel fire road that climbs the ridge's south end to Lookout Point, and the lookout itself.
// Pure data and queries, no rendering. buildHills is the first of the content passes at the end of buildCountry: it only
// appends (the rises to country.rises, which countryGround alone reads, and props standing on that ground). Every rise is
// 0 within 12 m of every road's edge, off every plot but the wild ones and at every verge walk node, so the roads, the
// verges and the farms' and places' pads stay flat (docs/map.md, "Las Lomas: roads outside the grid", the landscape).

import { Rng } from '../../core/rng';
import { addProp, hashInts, mkRect, type CityLayout, type Rect } from '../layout';
import { CORE_INSET, ridgeBounds, riseAt, terrainCores, type Core, type Rise } from '../terrain';
import { COUNTY_LAND, countryGround, type Country } from './index';

export const RIDGE_NAME = 'Coyote Ridge';

/**
 * Coyote Ridge: a 24 m crest along x -1475 from z -470 to -80, 20 m wide across its flat top. Its east flank falls over
 * 115 m to the foot 12 m off the Lomas Highway's west leg (32.8% at its steepest), its west flank over 108 m to the
 * beach (34.9%), running out 33 m over the sand, its north end over 110 m to the north shore (34.3%) and its south end
 * over 270 m (14%), the long shoulder the fire road climbs.
 */
const RIDGE = { cx: -1475, cz: -275, plateau: 10, rx: 115, rz: 195, height: 24, runs: { west: 108, north: 110, south: 270 } } as const;

/**
 * The foothills, cosine bells on the wild ground between the farms: north of the highway's bend, west of Gravel Gulch,
 * beside the south coast's cove, on the sound's shore south of Dry Creek and inside the bend.
 */
const FOOTHILLS: ReadonlyArray<Pick<Rise, 'name' | 'cx' | 'cz' | 'rx' | 'rz' | 'plateau' | 'height'>> = [
  { name: 'Coyote Knoll', cx: -1252, cz: -372, rx: 96, rz: 62, plateau: 14, height: 9 },
  { name: 'Gulch Hill', cx: -1371, cz: 456, rx: 62, rz: 96, plateau: 8, height: 10 },
  { name: 'Cove Rise', cx: -950, cz: 340, rx: 56, rz: 42, plateau: 6, height: 5 },
  { name: 'Sound Bluff', cx: -760, cz: -82, rx: 42, rz: 100, plateau: 6, height: 6 },
  { name: 'Bend Knoll', cx: -1226, cz: -181, rx: 34, rz: 30, plateau: 4, height: 4 },
];

/** The county's rises: the ridge and the foothills, in that order. */
export function countyRises(): Rise[] {
  const ridge: Omit<Rise, 'bounds'> = { name: RIDGE_NAME, kind: 'ridge', ...RIDGE, runs: { ...RIDGE.runs }, within: [] };
  return [
    { ...ridge, bounds: ridgeBounds(ridge) },
    ...FOOTHILLS.map((f): Rise => ({ ...f, kind: 'bell', bounds: mkRect(f.cx - f.rx, f.cz - f.rz, f.cx + f.rx, f.cz + f.rz), within: [] })),
  ];
}

/** Coyote Ridge among the county's rises. */
export function ridgeRise(rises: readonly Rise[]): Rise {
  return rises.find((r) => r.name === RIDGE_NAME)!;
}

// ---------------------------------------------------------------------------
// The fire road and Lookout Point

/** The fire road's width (m) and the radius (m) its centre line takes round each corner. */
export const FIRE_ROAD_W = 6;
export const FIRE_CORNER = 12;

/**
 * The fire road's centre line, corner to corner: from the gravel turn-off on the Lomas Highway's west leg it climbs the
 * ridge's south shoulder in switchbacks, west and north by turns (each west leg where the shoulder is low enough to
 * climb it at 18% or less), then north along the crest's flat top to the car park at Lookout Point.
 */
export const FIRE_ROAD: ReadonlyArray<readonly [number, number]> = [
  [-1338, 105],
  [-1385, 105],
  [-1385, 78],
  [-1430, 78],
  [-1430, 50],
  [RIDGE.cx + 3.5, 50],
  [RIDGE.cx + 3.5, -84],
];

/** A point of the fire road's centre line, `s` m along it from the turn-off, and the heading it runs on there. */
export interface RoadPoint {
  x: number;
  z: number;
  s: number;
  heading: number;
}

/**
 * The fire road's centre line sampled every `step` m or less: straight along each leg, round a quarter circle of radius
 * FIRE_CORNER at each corner.
 */
export function fireRoadLine(step: number): RoadPoint[] {
  const out: RoadPoint[] = [];
  const push = (x: number, z: number, heading: number) => {
    const last = out[out.length - 1];
    out.push({ x, z, heading, s: last ? last.s + Math.hypot(x - last.x, z - last.z) : 0 });
  };
  const dir = (k: number) => {
    const [ax, az] = FIRE_ROAD[k]!;
    const [bx, bz] = FIRE_ROAD[k + 1]!;
    const l = Math.hypot(bx - ax, bz - az);
    return [(bx - ax) / l, (bz - az) / l] as const;
  };
  let [x0, z0] = FIRE_ROAD[0]!;
  for (let k = 0; k + 1 < FIRE_ROAD.length; k++) {
    const [ux, uz] = dir(k);
    const [px, pz] = FIRE_ROAD[k + 1]!;
    const corner = k + 2 < FIRE_ROAD.length;
    // The straight up to the corner's arc (or the end).
    const ex = corner ? px - ux * FIRE_CORNER : px;
    const ez = corner ? pz - uz * FIRE_CORNER : pz;
    const len = Math.hypot(ex - x0, ez - z0);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = k === 0 ? 0 : 1; i <= n; i++) push(x0 + ((ex - x0) * i) / n, z0 + ((ez - z0) * i) / n, Math.atan2(ux, uz));
    if (!corner) break;
    // The quarter circle from the leg in to the leg out, centred a radius in from both.
    const [vx, vz] = dir(k + 1);
    const cx = ex + vx * FIRE_CORNER;
    const cz = ez + vz * FIRE_CORNER;
    const m = Math.max(2, Math.ceil((FIRE_CORNER * Math.PI) / 2 / step));
    for (let i = 1; i <= m; i++) {
      const a = (Math.PI / 2) * (i / m);
      const tx = ux * Math.cos(a) + vx * Math.sin(a);
      const tz = uz * Math.cos(a) + vz * Math.sin(a);
      push(cx - vx * FIRE_CORNER * Math.cos(a) + ux * FIRE_CORNER * Math.sin(a), cz - vz * FIRE_CORNER * Math.cos(a) + uz * FIRE_CORNER * Math.sin(a), Math.atan2(tx, tz));
    }
    x0 = px + vx * FIRE_CORNER;
    z0 = pz + vz * FIRE_CORNER;
  }
  return out;
}

/**
 * Lookout Point at the top of the fire road, on the crest's flat top facing the city across the county and the sound:
 * the car park, a parapet along its east edge, the plaque and the coin telescope at the parapet, and a timber fire
 * lookout tower on the car park's west side (four posts under a cab).
 */
export const LOOKOUT = {
  pad: mkRect(RIDGE.cx - 9, -122, RIDGE.cx + 9, -82),
  parapet: mkRect(RIDGE.cx + 9.3, -118, RIDGE.cx + 9.65, -86),
  plaque: { x: RIDGE.cx + 7.8, z: -103 },
  telescope: { x: RIDGE.cx + 8, z: -94 },
  tower: { x: RIDGE.cx - 5.5, z: -103, half: 2, cab: 9, top: 12.6, post: 0.22 },
} as const;

/**
 * Where the six turbines stand, 110 m apart along the ridge's top on the crest's west half, clear of the fire road and of
 * Lookout Point: the first just off the crest's north end, three more along it, and the last two past Lookout Point down
 * the south shoulder, 22 m and 9 m up. The crest holds no more: a row of six 110 m apart runs 550 m, and the 390 m crest
 * keeps 40 m clear of the lookout.
 */
const TURBINE_X = RIDGE.cx - 5;
const TURBINE_Z: readonly number[] = [-473, -363, -253, -143, -33, 77];

/** Salt of the generator that scatters the tree belts. */
const TREE_SALT = 0x0c07e1;
/** The belts along the ridge's east foot: two rows, a tree about every TREE_GAP m along each. */
const TREE_ROWS: readonly number[] = [-1357, -1368];
const TREE_GAP = 9;
/** The stretch of the foot the fire road's turn-off crosses, left open. */
const TURN_OFF = { minZ: 88, maxZ: 122 } as const;
/** Salt of the generator that scatters the scrub, and how many bushes it tries per 1000 m2 of each rise's bounds. */
const SCRUB_SALT = 0x5c2b;
const SCRUB_DENSITY = 3;
/** Scrub grows only where a rise stands this high (m), and keeps this far (m) off the fire road, the car park and the turbines. */
const SCRUB_LOW = 2.5;
const SCRUB_CLEAR = 7;

/**
 * Lays the landscape into the county: the ridge and the foothills, the turbines along its top, the tree belts along the
 * ridge's east foot and scrub over the rises, each prop on the ground (countryGround). Draws only from its own
 * generators.
 */
export function buildHills(layout: CityLayout): void {
  const country = layout.country;
  country.rises.push(...countyRises());
  for (const z of TURBINE_Z) addProp(layout, 'turbine', TURBINE_X, z, 0, 1, countryGround(country, TURBINE_X, z));
  const rng = new Rng(hashInts(layout.seed, TREE_SALT));
  const ridge = ridgeRise(country.rises);
  for (const [row, x0] of TREE_ROWS.entries()) {
    for (let z = ridge.bounds.minZ + 24 + row * (TREE_GAP / 2); z < ridge.bounds.maxZ - 30; z += TREE_GAP) {
      const x = x0 + rng.range(-2, 2);
      const tz = z + rng.range(-2.5, 2.5);
      const scale = rng.range(0.8, 1.25);
      const rot = rng.range(0, Math.PI * 2);
      if (tz > TURN_OFF.minZ && tz < TURN_OFF.maxZ) continue;
      addProp(layout, 'tree', x, tz, rot, scale, countryGround(country, x, tz));
    }
  }
  // Scrub: bushes (no collider) scattered over the slopes, clear of the road, the car park and the turbines' feet.
  const scrub = new Rng(hashInts(layout.seed, SCRUB_SALT));
  const road = fireRoadLine(4);
  const pad = LOOKOUT.pad;
  const clear = (x: number, z: number) =>
    road.every((p) => Math.hypot(p.x - x, p.z - z) > SCRUB_CLEAR) &&
    (x < pad.minX - SCRUB_CLEAR || x > pad.maxX + SCRUB_CLEAR || z < pad.minZ - SCRUB_CLEAR || z > pad.maxZ + SCRUB_CLEAR) &&
    TURBINE_Z.every((tz) => Math.hypot(TURBINE_X - x, tz - z) > SCRUB_CLEAR);
  for (const r of country.rises) {
    const b = r.bounds;
    const tries = Math.round(((b.maxX - b.minX) * (b.maxZ - b.minZ) * SCRUB_DENSITY) / 1000);
    for (let i = 0; i < tries; i++) {
      const x = scrub.range(b.minX, b.maxX);
      const z = scrub.range(b.minZ, b.maxZ);
      const scale = scrub.range(0.75, 1.3);
      const rot = scrub.range(0, Math.PI * 2);
      if (riseAt([r], x, z) >= SCRUB_LOW && countryGround(country, x, z) >= SCRUB_LOW && clear(x, z)) addProp(layout, 'bush', x, z, rot, scale, countryGround(country, x, z));
    }
  }
}

/**
 * The county rises' sight cores (terrainCores on ground with no curb), each kept inside the land by CORE_INSET: the
 * ridge's west flank runs on over the beach, whose ground is lower than the rise alone, so no core comes under it.
 */
export function countyCores(country: Country): Core[] {
  const land: Rect = {
    minX: Math.min(...COUNTY_LAND.map((r) => r.minX)) + CORE_INSET,
    minZ: Math.min(...COUNTY_LAND.map((r) => r.minZ)) + CORE_INSET,
    maxX: Math.max(...COUNTY_LAND.map((r) => r.maxX)) - CORE_INSET,
    maxZ: Math.max(...COUNTY_LAND.map((r) => r.maxZ)) - CORE_INSET,
  };
  return terrainCores(country.rises, 0).map((c) => ({ minX: Math.max(c.minX, land.minX), minZ: Math.max(c.minZ, land.minZ), maxX: Math.min(c.maxX, land.maxX), maxZ: Math.min(c.maxZ, land.maxZ), y1: c.y1 }));
}
