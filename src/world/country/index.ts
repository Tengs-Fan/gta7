// Las Lomas County: about 1.7 km2 of farm country west of the city across Lomas Sound, reached over the Magnolia
// Causeway (off Magnolia Ave at Harbor Blvd) and the Southgate Bridge (off Southgate Ave), with a loop of curved country
// roads that joins the city's lane graph (docs/map.md, "Las Lomas: roads outside the grid"), and, west of Coyote Ridge
// and reached through Coyote Pass, Las Lomas Valley with Lake Lomas and its own loop of roads. Pure data and queries, no
// rendering. buildCountry is the last pass of generateCity: it only appends (a headland, a deck, two parapets, props) and
// moves four props out of the links' mouths through the promenade, keeping their indices, so every older index stays.
// The city's lookups keep their own code: county behaviour branches only on an outer node or lane, or a point off the
// city or land rectangle.

import { CROSSWALK_W, CURB_H, PROP_INSET, SEABED_Y, WATER_Y } from '../constants';
import { addProp, mkRect, PARAPET_T, rectContains, rectsMinus, type CityLayout, type Rect } from '../layout';
import { riseAt, type Rise } from '../terrain';
import { buildFarms, noFarms, type CountyFarms } from './farms';
import { buildHills } from './hills';
import { buildLakeland, noLakeland, type CountyLakeland } from './lakeland';
import { buildPlaces, noPlaces, type CountyPlaces } from './places';

export type CountryRoadKind = 'highway' | 'country';

/** A county road: its centre line from end to end through its bends, every stretch of it a straight lane. */
export interface CountryRoad {
  name: string;
  kind: CountryRoadKind;
  /** Right of way: at a junction without lights the roads of lower priority stop for the highest (highway 2, country 1). */
  priority: number;
  /** Lanes each way. */
  lanes: 1 | 2;
  width: number;
  /** The centre line's vertices as x, z pairs: its two ends, the junctions it passes and its bends' vertices. */
  pts: number[];
  /** The radius (m) of the curve each stretch between two vertices lies on; Infinity along a straight. */
  radii: number[];
}

export type PlotKind = 'town' | 'farm' | 'venue' | 'wild';

/** A named piece of the county, the content passes' to fill: each keeps 12 m off the road edges but Dry Creek. */
export interface CountyPlot {
  id: string;
  name: string;
  rect: Rect;
  kind: PlotKind;
}

/** A footpath of the content passes' (a town's sidewalk, a boardwalk): its pedestrians spawn on it when `spawn`. */
export interface CountyWalk {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  spawn: boolean;
}

/** A node of the county's road graph: its id in the lane graph, after the grid's, and the links meeting there. */
export interface OuterVertex {
  id: number;
  x: number;
  z: number;
  /** Indices into CountryGraph.links. */
  links: number[];
  /** Half the widest road meeting here at a junction (its box), 0 at a bend. */
  half: number;
}

/** A stretch of county road between two nodes (a grid node at a gateway), one way along its road's centre line. */
export interface OuterLink {
  a: number;
  b: number;
  road: CountryRoad;
  radius: number;
}

export interface CountryGraph {
  /** The county's own nodes, by id from the grid's node count on. */
  vertices: OuterVertex[];
  links: OuterLink[];
  /** Each road's nodes in order along it (grid ids at the gateways). */
  roadNodes: number[][];
  /** The grid nodes the links leave the city from, with the link they gain. */
  gateways: Array<{ node: number; link: number }>;
  /** The named junctions' node ids. */
  junctions: Record<CountyJunction, number>;
}

export interface Country {
  /** The land: axis rectangles, the ground flat (0) inside them. */
  land: readonly Rect[];
  /** The land as the sea's shelf falls away from it: the same with Lake Lomas filled in, which has no shelf. */
  shelf: readonly Rect[];
  /** The box round Lake Lomas, whose shore countryFloor rounds. */
  lake: Rect;
  /** Where countryGround is above the seabed: the land and its beaches. */
  bounds: Rect;
  roads: readonly CountryRoad[];
  graph: CountryGraph;
  plots: readonly CountyPlot[];
  /** The county's rises, read by countryGround alone (the landscape pass fills it). */
  rises: Rise[];
  walks: CountyWalk[];
  /** The farms (world/country/farms.ts): their fields, farmsteads, hedgerows and the props kept by index. */
  farms: CountyFarms;
  /** Dry Creek, the Moonbeam Drive-In and Gravel Gulch (places.ts). */
  places: CountyPlaces;
  /** Lake Lomas's dock, cabins and campground, Pinewood and the valley's north (lakeland.ts). */
  lakeland: CountyLakeland;
  /**
   * The first prop, parapet, building and garage of the county's: StaticWorld adds their colliders after every older
   * one.
   */
  firstProp: number;
  firstParapet: number;
  firstBuilding: number;
  firstGarage: number;
}

export type CountyJunction = 'drycreek' | 'hollister' | 'creek' | 'coyote' | 'valley';

export const COUNTY_NAME = 'Las Lomas County';
export const CAUSEWAY_NAME = 'Magnolia Causeway';
export const BRIDGE_NAME = 'Southgate Bridge';
/** What the HUD calls the county's land west of Coyote Ridge, and the lake cut into it. */
export const VALLEY_NAME = 'Las Lomas Valley';
export const LAKE_NAME = 'Lake Lomas';
/** The valley's east edge (x, m): west of it the land is the valley's, east of it the county's. */
export const VALLEY_EDGE = -1560;

/** Lomas Sound, between the city's west promenade and the county's east shore. */
export const SOUND = mkRect(-700, -580, -512, 580);
/** The causeway: a 16 m carriageway with a 6 m verge either side, on Magnolia Ave's line. */
export const CAUSEWAY = mkRect(-700, -282, -512, -254);
/** The bridge's deck, on Southgate Ave's line: its carriageway and a metre either side to the parapets. */
export const BRIDGE = mkRect(-700, 258, -512, 278);

/**
 * The Southgate Bridge's steel through-arch (render/country/bridge.ts draws it): a rib over either parapet springing
 * from a portal post at either end of the span and rising `rise` m over the deck. The posts are solid, pillars of radius
 * `post` from the seabed up to `postTop`; the ribs, hangers and bracing over the traffic are only drawn.
 */
export const BRIDGE_ARCH = { x0: BRIDGE.minX + 10, x1: BRIDGE.maxX - 10, ribs: [BRIDGE.minZ + 0.2, BRIDGE.maxZ - 0.2], rise: 22, post: 0.45, postTop: 8.1 } as const;

/**
 * Lake Lomas: holes in the valley's land, which the sea shows through at sea level as in the coves, 280 m from the
 * north-west to the south-east and up to 150 m across. The main body steps down from the north-west in six rectangles, a
 * bay opens on its east side, a narrow inlet runs north from its west end, and two bays in its south shore leave a point
 * between them. The steps are rounded where the ground is made (LAKE_ROUND), so the shore winds as a lake's does.
 */
export const LAKE_RECTS: readonly Rect[] = [
  mkRect(-2120, -345, -2020, -325),
  mkRect(-2140, -325, -2000, -300),
  mkRect(-2155, -300, -1970, -275),
  mkRect(-2145, -275, -1940, -250),
  mkRect(-2130, -250, -1910, -225),
  mkRect(-2105, -225, -1950, -200),
  mkRect(-1985, -305, -1875, -245),
  mkRect(-2095, -200, -2040, -155),
  mkRect(-1990, -215, -1940, -165),
  mkRect(-2100, -400, -2055, -340),
];

/** The box round the lake's water. */
export const LAKE = mkRect(
  Math.min(...LAKE_RECTS.map((r) => r.minX)),
  Math.min(...LAKE_RECTS.map((r) => r.minZ)),
  Math.max(...LAKE_RECTS.map((r) => r.maxX)),
  Math.max(...LAKE_RECTS.map((r) => r.maxZ)),
);

/** Whether (x, z) is over the lake's water as the holes in the land draw it (its beach included). */
export function inLake(x: number, z: number): boolean {
  return LAKE_RECTS.some((r) => rectContains(r, x, z));
}

/** The valley's coves: a bay in the west coast, one in the north coast and one in the south. */
const VALLEY_COVES: readonly Rect[] = [mkRect(-2300, 140, -2215, 250), mkRect(-2080, -580, -1960, -525), mkRect(-2080, 520, -1950, 580)];

/** The county east of the valley: the box x -1560 to -700 but for a cove on the north coast and one on the south, and the south-west corner. */
const EAST_LAND: readonly Rect[] = [
  mkRect(-1560, -440, -700, 170),
  mkRect(-1170, -580, -700, -440),
  mkRect(-1560, -580, -1350, -440),
  mkRect(-1440, 170, -700, 400),
  mkRect(-1440, 400, -1020, 580),
  mkRect(-880, 400, -700, 580),
];

/** South of this z (m) the valley's land runs on east to STRIP_EDGE (m), 120 m past VALLEY_EDGE, beyond the ridge's south end. */
const STRIP_Z = 170;
const STRIP_EDGE = -1440;

/** The valley west of Coyote Ridge: x -2300 to -1560, to -1440 south of z 170. */
const VALLEY: readonly Rect[] = [mkRect(-2300, -580, VALLEY_EDGE, STRIP_Z), mkRect(-2300, STRIP_Z, STRIP_EDGE, 580)];

/** Whether (x, z), on the land or its beaches, is the valley's rather than the county's east of the ridge. */
export function inValley(x: number, z: number): boolean {
  return x < VALLEY_EDGE || (z > STRIP_Z && x < STRIP_EDGE);
}

/** The land: the county east of the ridge, and the valley but for the lake and the coves. */
export const COUNTY_LAND: readonly Rect[] = [...EAST_LAND, ...rectsMinus(VALLEY, [...LAKE_RECTS, ...VALLEY_COVES])];

/** The land as the sea's shelf sees it (Country.shelf): the lake is filled in. */
export const COUNTY_SHELF: readonly Rect[] = [...EAST_LAND, ...rectsMinus(VALLEY, VALLEY_COVES)];

/** The beach off the land's edge: the waterline WATERLINE m out, the seabed SEABED_OUT m out. */
const WATERLINE = 8;
const SEABED_OUT = 45;

export const COUNTY_BOUNDS = mkRect(
  Math.min(...COUNTY_LAND.map((r) => r.minX)) - SEABED_OUT,
  Math.min(...COUNTY_LAND.map((r) => r.minZ)) - SEABED_OUT,
  Math.max(...COUNTY_LAND.map((r) => r.maxX)) + SEABED_OUT,
  Math.max(...COUNTY_LAND.map((r) => r.maxZ)) + SEABED_OUT,
);

/** The z (m) of Coyote Pass and the Pass Road along it, from the Coyote T on the Lomas Highway to Valley Cross. */
export const PASS_Z = 84;
/** Valley Cross, where the Pass Road meets the Valley Loop, which runs due north and south through it. */
const CROSS = { x: -1840, z: PASS_Z } as const;
/**
 * The Valley Loop's corners, clockwise from Valley Cross (x, z, radius of the curve in m): the loop runs straight south out
 * of the cross, sweeps west round the south bend past the south cove, wanders up the west side round the west cove, the
 * bluff and the lake, round the north-west and the north cove, and back along the lake's east side and straight south to the
 * cross. Nine curves of 125 to 200 m turning 6 to 77 degrees, between straights of 22 to 238 m, each long enough for its
 * curves' tangents; the straights either side of the cross are long (230 m and 185 m), as the roads that meet at a stop
 * sign's are, so the few cars that spawn on the Pass Road are not swamped by the loop's many short arc lanes.
 */
const LOOP_CORNERS: ReadonlyArray<readonly [x: number, z: number, r: number]> = [
  [-1840, 430, 150],
  [-2050, 480, 145],
  [-2190, 400, 125],
  [-2150, 40, 200],
  [-2215, -170, 150],
  [-2205, -440, 130],
  [-1990, -490, 150],
  [-1810, -395, 150],
  [-1840, -100, 200],
];

/** The junctions by name: Dry Creek's crossroads, the Hollister T, the Creek T, the Coyote T and Valley Cross. */
export const COUNTY_JUNCTIONS: Readonly<Record<CountyJunction, readonly [number, number]>> = {
  drycreek: [-840, -268],
  hollister: [-1104, -268],
  creek: [-840, 268],
  coyote: [-1330, PASS_Z],
  valley: [CROSS.x, CROSS.z],
};

/** The junctions with stop signs instead of lights: the roads of lower priority stop for the highest (CountryRoad.priority). */
export const STOP_SIGNS: readonly CountyJunction[] = ['hollister', 'creek', 'coyote', 'valley'];

/** Speed limits (m/s) by kind of road, each capped on a curve to what a car holds round it (sqrt(4.5 r)). */
export const COUNTRY_SPEED: Readonly<Record<CountryRoadKind, number>> = { highway: 22, country: 15 };

/**
 * Builds a centre line from its start on a heading (facing (sin h, cos h)): straight on to a point, or round an arc
 * that turns the heading by `deg` degrees (positive turns left: south towards east, west towards south) in `steps`
 * equal chords. The vertices are kept to the millimetre, so an arc's end meets the straight after it exactly.
 */
class Centreline {
  readonly pts: number[];
  readonly radii: number[] = [];
  private h: number;

  constructor(x: number, z: number, heading: number) {
    this.pts = [x, z];
    this.h = heading;
  }

  to(x: number, z: number): this {
    const [px, pz] = this.last();
    this.h = Math.atan2(x - px, z - pz);
    this.pts.push(x, z);
    this.radii.push(Infinity);
    return this;
  }

  arc(r: number, deg: number, steps: number): this {
    const [x0, z0] = this.last();
    const h0 = this.h;
    const turn = (deg * Math.PI) / 180;
    const k = Math.sign(deg) / r;
    for (let i = 1; i <= steps; i++) {
      const h = h0 + (turn * i) / steps;
      this.pts.push(mm(x0 + (Math.cos(h0) - Math.cos(h)) / k), mm(z0 + (Math.sin(h) - Math.sin(h0)) / k));
      this.radii.push(r);
    }
    this.h = h0 + turn;
    return this;
  }

  /**
   * Rounds the corner at (x, z) on the way on to (nx, nz): straight on to where an arc of radius r that touches both legs
   * begins, then round it in equal chords of 20-30 m turning 10 degrees or less each. The corner's legs must be long enough
   * for its tangents (r tan(turn / 2) each).
   */
  corner(x: number, z: number, r: number, nx: number, nz: number): this {
    const [px, pz] = this.last();
    const h0 = Math.atan2(x - px, z - pz);
    const out = Math.atan2(nx - x, nz - z) - h0;
    const turn = Math.atan2(Math.sin(out), Math.cos(out));
    const t = r * Math.tan(Math.abs(turn) / 2);
    this.to(mm(x - Math.sin(h0) * t), mm(z - Math.cos(h0) * t));
    return this.arc(r, (turn * 180) / Math.PI, Math.max(Math.ceil((Math.abs(turn) * 18) / Math.PI), Math.ceil((r * Math.abs(turn)) / 30)));
  }

  private last(): [number, number] {
    return [this.pts[this.pts.length - 2]!, this.pts[this.pts.length - 1]!];
  }
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

const W = -Math.PI / 2;
const N = Math.PI;
const S = 0;

function road(name: string, kind: CountryRoadKind, line: Centreline, priority = kind === 'highway' ? 2 : 1): CountryRoad {
  const lanes = kind === 'highway' ? 2 : 1;
  return { name, kind, priority, lanes, width: kind === 'highway' ? 16 : 10, pts: line.pts, radii: line.radii };
}

/**
 * The county's roads, every rule of docs/map.md kept: no dead end, junction arms on the axes, bend vertices 20-30 m
 * apart turning 10 degrees at most on curves of 120 m and more, none within 30 m of a junction, all of them flat.
 * - The Magnolia Causeway runs Magnolia Ave on from Harbor Blvd to Dry Creek.
 * - The Lomas Highway goes on west from Dry Creek past the Hollister T, bends south round a 180 m curve, runs down the
 *   west of the county, bends east round a 150 m one and comes back along Southgate Ave's line past the Creek T and over
 *   the Southgate Bridge to Harbor Blvd.
 * - Hollister Lane loops north from Dry Creek round the farm and back to the Hollister T.
 * - Creek Road runs south from Dry Creek to the Creek T, swerving 11 m east and back on the way.
 * - Coyote Pass Road leaves the highway's west leg at the Coyote T (a stop sign, the highway has priority), runs west
 *   along z 84 through Coyote Pass in Coyote Ridge's south shoulder, and stops at Valley Cross for the Valley Loop.
 * - The Valley Loop runs round the valley, through Valley Cross, with Lake Lomas inside it on its west side.
 */
export const COUNTRY_ROADS: readonly CountryRoad[] = [
  road('Magnolia Causeway', 'highway', new Centreline(-470, -268, W).to(-840, -268)),
  road('Lomas Highway', 'highway', new Centreline(-840, -268, W).to(-1104, -268).to(-1150, -268).arc(180, 90, 10).to(-1330, PASS_Z).to(-1330, 118).arc(150, 90, 9).to(-840, 268).to(-470, 268)),
  road('Hollister Lane', 'country', new Centreline(-840, -268, N).to(-840, -400).arc(120, 90, 9).to(-984, -520).arc(120, 90, 9).to(-1104, -268)),
  road('Creek Road', 'country', new Centreline(-840, -268, S).to(-840, -193).arc(160, 15, 2).arc(160, -30, 3).arc(160, 15, 2).to(-840, 268)),
  road('Coyote Pass Road', 'country', new Centreline(-1330, PASS_Z, W).to(CROSS.x, CROSS.z), 0),
  road('Valley Loop', 'country', valleyLoop()),
];

/** The Valley Loop: from Valley Cross south, round LOOP_CORNERS and back to it from the north. */
function valleyLoop(): Centreline {
  const line = new Centreline(CROSS.x, CROSS.z, S);
  LOOP_CORNERS.forEach(([x, z, r], k) => {
    const [nx, nz] = LOOP_CORNERS[k + 1] ?? [CROSS.x, CROSS.z];
    line.corner(x, z, r, nx, nz);
  });
  return line.to(CROSS.x, CROSS.z);
}

export const COUNTY_PLOTS: readonly CountyPlot[] = [
  { id: 'drycreek', name: 'Dry Creek', rect: mkRect(-930, -330, -750, -200), kind: 'town' },
  { id: 'bottoms', name: 'Hollister Bottoms', rect: mkRect(-1059, -470, -885, -342), kind: 'farm' },
  { id: 'dairy', name: 'Cud & Sons Dairy', rect: mkRect(-1080, -180, -860, 60), kind: 'farm' },
  { id: 'orchard', name: 'Pippin Hollow', rect: mkRect(-1295, -150, -1100, 40), kind: 'farm' },
  { id: 'acres', name: 'Halfmoon Acres', rect: mkRect(-1170, 80, -860, 244), kind: 'farm' },
  { id: 'drivein', name: 'Moonbeam Drive-In', rect: mkRect(-820, 40, -712, 200), kind: 'venue' },
  { id: 'track', name: 'Gravel Gulch', rect: mkRect(-1290, 300, -1060, 540), kind: 'venue' },
  { id: 'ridge', name: 'Coyote Ridge', rect: mkRect(-1600, -560, -1360, 48), kind: 'wild' },
  // The valley's, bare until the next stage fills them: the pass (the one plot a road runs through, its rock walls and
  // the stretch of the Pass Road across the ridge), the vineyard (on the Vineyard Rise, the one farm with a rise on it)
  // and the lake inside the Valley Loop, the ranch east of its south bend and the pine wood east of its north side.
  { id: 'pass', name: 'Coyote Pass', rect: mkRect(-1620, 48, -1352, 122), kind: 'wild' },
  { id: 'vineyard', name: 'Sunset Vineyard', rect: mkRect(-2125, -100, -1900, 290), kind: 'farm' },
  { id: 'ranch', name: 'Lazy Q Ranch', rect: mkRect(-1810, 215, -1520, 470), kind: 'farm' },
  { id: 'lake', name: LAKE_NAME, rect: mkRect(-2165, -402, -1882, -145), kind: 'venue' },
  { id: 'pinewood', name: 'Pinewood', rect: mkRect(-1770, -520, -1625, 40), kind: 'wild' },
];

/** How far (m) the sea reached west of the city's land before the county: the world's edge was there. */
const CITY_SEA = 160;

/**
 * Whether x lies west of where the world ended before Las Lomas County: the AI's county ways start there, so whatever
 * the city's own world holds keeps the ways it had.
 */
export function pastCitySea(layout: CityLayout, x: number): boolean {
  return x < layout.bounds.landMinX - CITY_SEA;
}

/** The slot (0 N, 1 E, 2 S, 3 W) a link leaving a node towards (dx, dz) takes there: its bearing to the nearest axis. */
export function slotOf(dx: number, dz: number): number {
  return (((Math.round(Math.atan2(dx, -dz) / (Math.PI / 2)) % 4) + 4) % 4);
}

/**
 * The county's road graph: a node at every vertex of every road (one where roads meet, keyed to the decimetre like the
 * walk graph's), numbered after the grid's (n + 1)^2 nodes, a link per stretch. A road's end on a grid junction (a
 * gateway) is that junction.
 */
export function countryGraph(layout: CityLayout, roads: readonly CountryRoad[]): CountryGraph {
  const { n, vLines, hLines } = layout;
  const first = (n + 1) * (n + 1);
  const vertices: OuterVertex[] = [];
  const links: OuterLink[] = [];
  const keys = new Map<string, number>();
  const gridAt = (x: number, z: number) => {
    const i = vLines.findIndex((l) => l.pos === x);
    const j = hLines.findIndex((l) => l.pos === z);
    return i >= 0 && j >= 0 ? j * (n + 1) + i : -1;
  };
  const nodeAt = (x: number, z: number) => {
    const grid = gridAt(x, z);
    if (grid >= 0) return grid;
    const key = `${Math.round(x * 10)},${Math.round(z * 10)}`;
    let id = keys.get(key);
    if (id === undefined) {
      id = first + vertices.length;
      vertices.push({ id, x, z, links: [], half: 0 });
      keys.set(key, id);
    }
    return id;
  };
  const gateways: CountryGraph['gateways'] = [];
  const roadNodes = roads.map((r) => {
    const ids: number[] = [];
    for (let k = 0; k < r.pts.length; k += 2) ids.push(nodeAt(r.pts[k]!, r.pts[k + 1]!));
    for (let k = 1; k < ids.length; k++) {
      const link = links.length;
      links.push({ a: ids[k - 1]!, b: ids[k]!, road: r, radius: r.radii[k - 1]! });
      for (const id of [ids[k - 1]!, ids[k]!]) {
        if (id >= first) vertices[id - first]!.links.push(link);
        else gateways.push({ node: id, link });
      }
    }
    return ids;
  });
  for (const v of vertices) if (v.links.length >= 3) v.half = Math.max(...v.links.map((l) => links[l]!.road.width / 2));
  const junctions = Object.fromEntries(Object.entries(COUNTY_JUNCTIONS).map(([name, [x, z]]) => [name, nodeAt(x, z)])) as Record<CountyJunction, number>;
  return { vertices, links, roadNodes, gateways, junctions };
}

/** Ground height in the county and round it: flat on the land, a beach off its edge down to the seabed, and the rises. */
export function countryGround(country: Country, x: number, z: number): number {
  return countryFloor(country, x, z) + riseAt(country.rises, x, z);
}

/**
 * The ground the county's rises stand on: flat on the land, a beach off its edge down to the seabed. Lake Lomas's shore
 * is rounded (LAKE_ROUND): the lake's water is its holes opened by a disc, so the land runs on into the water's corners
 * and its steps' treads, and a straight shore, a land point and every metre of land stay where the rectangles put them.
 */
export function countryFloor(country: Country, x: number, z: number): number {
  const b = country.bounds;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return SEABED_Y;
  let d = landGap(country.land, x, z);
  if (d > 0 && rectContains(country.lake, x, z)) {
    let far = d;
    for (const [dx, dz] of LAKE_DISC) far = Math.max(far, landGap(country.land, x + dx, z + dz));
    d = Math.max(0, far - LAKE_ROUND);
  }
  return beachHeight(d);
}

/** The distance (m) from (x, z) to the nearest of `land` (0 on it). */
function landGap(land: readonly Rect[], x: number, z: number): number {
  let d2 = Infinity;
  for (const r of land) {
    const dx = Math.max(r.minX - x, 0, x - r.maxX);
    const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
    d2 = Math.min(d2, dx * dx + dz * dz);
  }
  return Math.sqrt(d2);
}

/** The radius (m) the lake's water is opened by, and the points that stand for the disc: a ring of twelve and an inner one of six. */
const LAKE_ROUND = 10;
const LAKE_DISC: ReadonlyArray<readonly [number, number]> = [
  ...Array.from({ length: 12 }, (_, k): [number, number] => [Math.cos((k * Math.PI) / 6) * LAKE_ROUND, Math.sin((k * Math.PI) / 6) * LAKE_ROUND]),
  ...Array.from({ length: 6 }, (_, k): [number, number] => [Math.cos((k * Math.PI) / 3 + 0.3) * (LAKE_ROUND / 2), Math.sin((k * Math.PI) / 3 + 0.3) * (LAKE_ROUND / 2)]),
];

/** The beach's height `d` m off the land: WATER_Y at WATERLINE, the seabed from SEABED_OUT on. */
function beachHeight(d: number): number {
  if (d <= WATERLINE) return (WATER_Y * d) / WATERLINE;
  return Math.max(SEABED_Y, WATER_Y + ((SEABED_Y - WATER_Y) * (d - WATERLINE)) / (SEABED_OUT - WATERLINE));
}

/** Whether (x, z) is on the county's land (its beaches aside). */
export function onCountyLand(country: Country, x: number, z: number): boolean {
  return country.land.some((r) => rectContains(r, x, z));
}

/** The plot at (x, z), or null. */
export function plotAt(country: Country, x: number, z: number): CountyPlot | null {
  return country.plots.find((p) => rectContains(p.rect, x, z)) ?? null;
}

/** The props that stood in the links' mouths through the west promenade (by place), and the z each now stands at. */
const MOUTH_MOVES: ReadonlyArray<{ x: number; z: number; to: number }> = [
  // A railing lamp, the tree behind it and a bench by Magnolia Ave; a railing lamp by Southgate Ave.
  { x: -510.8, z: -276, to: -279 },
  { x: -485, z: -261, to: -257 },
  { x: -509.4, z: -269, to: -255 },
  { x: -510.8, z: 264, to: 257 },
];

/** A lamp every LAMP_GAP m along each of the causeway's verges, staggered between the two. */
const LAMP_GAP = 30;

/**
 * The county, last in generateCity (after settleTerrain, so every older index is final): its land and roads, the two
 * links, the mouths' props moved and the signal heads, the causeway's lamps.
 */
export function buildCountry(layout: CityLayout): void {
  const graph = countryGraph(layout, COUNTRY_ROADS);
  layout.country = {
    land: COUNTY_LAND,
    shelf: COUNTY_SHELF,
    lake: LAKE,
    bounds: COUNTY_BOUNDS,
    roads: COUNTRY_ROADS,
    graph,
    plots: COUNTY_PLOTS,
    rises: [],
    walks: [],
    farms: noFarms(),
    places: noPlaces(),
    lakeland: noLakeland(),
    firstProp: layout.props.length,
    firstParapet: layout.parapets.length,
    firstBuilding: layout.buildings.length,
    firstGarage: layout.garages.length,
  };
  // The links. The causeway is a headland of its own at road level, quay walls and rocks along its sides (shore.ts) and
  // none at either end, where it meets land; the bridge is a deck at road level with a parapet along either edge and no
  // footways.
  layout.headlands.push({ name: CAUSEWAY_NAME, y: 0, rects: [CAUSEWAY] });
  layout.decks.push({ rect: BRIDGE, y: 0, name: BRIDGE_NAME, bridge: true });
  layout.parapets.push(mkRect(BRIDGE.minX, BRIDGE.minZ, BRIDGE.maxX, BRIDGE.minZ + PARAPET_T), mkRect(BRIDGE.minX, BRIDGE.maxZ - PARAPET_T, BRIDGE.maxX, BRIDGE.maxZ));
  for (const m of MOUTH_MOVES) for (const p of layout.props) if (Math.abs(p.x - m.x) < 0.01 && Math.abs(p.z - m.z) < 0.01) p.z = m.to;

  // Signal heads: for the eastbound approach the gateways gain, and for every approach at the county's junctions. At a
  // stop sign the arms that stop have the sign where the head would stand, and the others a lamp over the junction.
  // The valley's two (the Coyote T and Valley Cross) come last, after the causeway's lamps, so every older prop and
  // collider before the landscape's keeps its index.
  const stops = new Set(STOP_SIGNS.map((name) => graph.junctions[name]));
  const valley = new Set([graph.junctions.coyote, graph.junctions.valley]);
  for (const g of graph.gateways) {
    const i = g.node % (layout.n + 1);
    const j = Math.floor(g.node / (layout.n + 1));
    signalHead(layout, g.node, 1, layout.vLines[i]!.pos, layout.hLines[j]!.pos, layout.vLines[i]!.width / 2, layout.hLines[j]!.width / 2);
  }
  const junctionHeads = (vertices: readonly OuterVertex[]) => {
    for (const v of vertices) {
      const top = Math.max(...v.links.map((l) => graph.links[l]!.road.priority));
      for (const l of v.links) {
        const link = graph.links[l]!;
        const other = link.a === v.id ? link.b : link.a;
        const o = nodeXZ(layout, graph, other);
        // Traffic coming in along this arm travels the other way.
        const kind = !stops.has(v.id) ? 'signal' : link.road.priority < top ? 'stopSign' : 'lamp';
        signalHead(layout, v.id, (slotOf(o.x - v.x, o.z - v.z) + 2) % 4, v.x, v.z, v.half, v.half, kind);
      }
    }
  };
  const junctions = graph.vertices.filter((v) => v.links.length >= 3);
  junctionHeads(junctions.filter((v) => !valley.has(v.id)));
  // The causeway's lamps, their heads over the carriageway.
  const half = COUNTRY_ROADS[0]!.width / 2;
  for (let x = CAUSEWAY.maxX - 15; x > CAUSEWAY.minX + 5; x -= LAMP_GAP) {
    addProp(layout, 'lamp', x, -268 - half - 1, 0, 1, 0);
    addProp(layout, 'lamp', x - LAMP_GAP / 2, -268 + half + 1, Math.PI, 1, 0);
  }
  junctionHeads(junctions.filter((v) => valley.has(v.id)));
  // The content passes go here, in this order, each one call that only appends: buildHills (the landscape), buildFarms,
  // buildPlaces, buildLakeland (Lake Lomas's shore and Pinewood).
  buildHills(layout);
  buildFarms(layout);
  buildPlaces(layout);
  buildLakeland(layout);
}

/** A node's place: a grid node's line crossing, or a county vertex. */
export function nodeXZ(layout: CityLayout, graph: CountryGraph, id: number): { x: number; z: number } {
  const first = (layout.n + 1) * (layout.n + 1);
  if (id >= first) return graph.vertices[id - first]!;
  return { x: layout.vLines[id % (layout.n + 1)]!.pos, z: layout.hLines[Math.floor(id / (layout.n + 1))]!.pos };
}

/**
 * The signal head serving traffic travelling `dir` (0 N, 1 E, 2 S, 3 W) into the junction at (x, z) with half extents
 * hw, hh: at the corner on the approach's right, facing it, as generateCity stands the city's. A stop sign stands there
 * the same way; a lamp leans over the junction.
 */
function signalHead(layout: CityLayout, node: number, dir: number, x: number, z: number, hw: number, hh: number, kind: 'signal' | 'stopSign' | 'lamp' = 'signal'): void {
  const i = PROP_INSET;
  const [px, pz] = dir === 0 ? [x + hw + i, z + hh + i] : dir === 2 ? [x - hw - i, z - hh - i] : dir === 1 ? [x - hw - i, z + hh + i] : [x + hw + i, z - hh - i];
  const tx = dir === 1 ? 1 : dir === 3 ? -1 : 0;
  const tz = dir === 2 ? 1 : dir === 0 ? -1 : 0;
  // On a gateway's sidewalk corner, at the kerb's height; in the county, on its ground.
  const rot = kind === 'lamp' ? Math.atan2(x - px, z - pz) : Math.atan2(-tx, -tz);
  const p = addProp(layout, kind, px, pz, rot, 1, px < layout.bounds.landMinX ? countryGround(layout.country, px, pz) : CURB_H);
  p.node = node;
  p.dir = dir;
}

/** The county before buildCountry lays it down. */
export function noCountry(): Country {
  return {
    land: [],
    shelf: [],
    lake: mkRect(0, 0, 0, 0),
    bounds: mkRect(0, 0, 0, 0),
    roads: [],
    graph: { vertices: [], links: [], roadNodes: [], gateways: [], junctions: { drycreek: -1, hollister: -1, creek: -1, coyote: -1, valley: -1 } },
    plots: [],
    rises: [],
    walks: [],
    farms: noFarms(),
    places: noPlaces(),
    lakeland: noLakeland(),
    firstProp: 0,
    firstParapet: 0,
    firstBuilding: 0,
    firstGarage: 0,
  };
}

/** The lane graph's end-of-lane offset at a node: a junction's box and its crosswalk, or half a metre at a bend. */
export function laneEnd(half: number): number {
  return half > 0 ? half + CROSSWALK_W : 0.5;
}
