// Las Lomas County: about 0.9 km2 of farm country west of the city across Lomas Sound, reached over the Magnolia
// Causeway (off Magnolia Ave at Harbor Blvd) and the Southgate Bridge (off Southgate Ave), with a loop of curved country
// roads that joins the city's lane graph (docs/map.md, "Las Lomas: roads outside the grid"). Pure data and queries, no
// rendering. buildCountry is the last pass of generateCity: it only appends (a headland, a deck, two parapets, props) and
// moves four props out of the links' mouths through the promenade, keeping their indices, so every older index stays.
// The city's lookups keep their own code: county behaviour branches only on an outer node or lane, or a point off the
// city or land rectangle.

import { CROSSWALK_W, CURB_H, PROP_INSET, SEABED_Y, WATER_Y } from '../constants';
import { addProp, mkRect, PARAPET_T, rectContains, type CityLayout, type Rect } from '../layout';
import { riseAt, type Rise } from '../terrain';

export type CountryRoadKind = 'highway' | 'country';

/** A county road: its centre line from end to end through its bends, every stretch of it a straight lane. */
export interface CountryRoad {
  name: string;
  kind: CountryRoadKind;
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
  /** Where countryGround is above the seabed: the land and its beaches. */
  bounds: Rect;
  roads: readonly CountryRoad[];
  graph: CountryGraph;
  plots: readonly CountyPlot[];
  /** The county's rises, read by countryGround alone (the landscape pass fills it). */
  rises: Rise[];
  walks: CountyWalk[];
  /** The first prop and the first parapet of the county's: StaticWorld adds their colliders after every older one. */
  firstProp: number;
  firstParapet: number;
}

export type CountyJunction = 'drycreek' | 'hollister' | 'creek';

export const COUNTY_NAME = 'Las Lomas County';
export const CAUSEWAY_NAME = 'Magnolia Causeway';
export const BRIDGE_NAME = 'Southgate Bridge';

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

/** The land: the full box but for a cove on the north coast and one on the south, and the south-west corner. */
export const COUNTY_LAND: readonly Rect[] = [
  mkRect(-1560, -440, -700, 170),
  mkRect(-1170, -580, -700, -440),
  mkRect(-1560, -580, -1350, -440),
  mkRect(-1440, 170, -700, 400),
  mkRect(-1440, 400, -1020, 580),
  mkRect(-880, 400, -700, 580),
];

/** The beach off the land's edge: the waterline WATERLINE m out, the seabed SEABED_OUT m out. */
const WATERLINE = 8;
const SEABED_OUT = 45;

export const COUNTY_BOUNDS = mkRect(
  Math.min(...COUNTY_LAND.map((r) => r.minX)) - SEABED_OUT,
  Math.min(...COUNTY_LAND.map((r) => r.minZ)) - SEABED_OUT,
  Math.max(...COUNTY_LAND.map((r) => r.maxX)) + SEABED_OUT,
  Math.max(...COUNTY_LAND.map((r) => r.maxZ)) + SEABED_OUT,
);

/** The junctions by name: Dry Creek's crossroads, the Hollister T and the Creek T. */
export const COUNTY_JUNCTIONS: Readonly<Record<CountyJunction, readonly [number, number]>> = {
  drycreek: [-840, -268],
  hollister: [-1104, -268],
  creek: [-840, 268],
};

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

  private last(): [number, number] {
    return [this.pts[this.pts.length - 2]!, this.pts[this.pts.length - 1]!];
  }
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

const W = -Math.PI / 2;
const N = Math.PI;
const S = 0;

function road(name: string, kind: CountryRoadKind, line: Centreline): CountryRoad {
  const lanes = kind === 'highway' ? 2 : 1;
  return { name, kind, lanes, width: kind === 'highway' ? 16 : 10, pts: line.pts, radii: line.radii };
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
 */
export const COUNTRY_ROADS: readonly CountryRoad[] = [
  road('Magnolia Causeway', 'highway', new Centreline(-470, -268, W).to(-840, -268)),
  road('Lomas Highway', 'highway', new Centreline(-840, -268, W).to(-1104, -268).to(-1150, -268).arc(180, 90, 10).to(-1330, 118).arc(150, 90, 9).to(-840, 268).to(-470, 268)),
  road('Hollister Lane', 'country', new Centreline(-840, -268, N).to(-840, -400).arc(120, 90, 9).to(-984, -520).arc(120, 90, 9).to(-1104, -268)),
  road('Creek Road', 'country', new Centreline(-840, -268, S).to(-840, -193).arc(160, 15, 2).arc(160, -30, 3).arc(160, 15, 2).to(-840, 268)),
];

export const COUNTY_PLOTS: readonly CountyPlot[] = [
  { id: 'drycreek', name: 'Dry Creek', rect: mkRect(-930, -330, -750, -200), kind: 'town' },
  { id: 'bottoms', name: 'Hollister Bottoms', rect: mkRect(-1059, -470, -885, -342), kind: 'farm' },
  { id: 'dairy', name: 'Cud & Sons Dairy', rect: mkRect(-1080, -180, -860, 60), kind: 'farm' },
  { id: 'orchard', name: 'Pippin Hollow', rect: mkRect(-1295, -150, -1100, 40), kind: 'farm' },
  { id: 'acres', name: 'Halfmoon Acres', rect: mkRect(-1170, 80, -860, 244), kind: 'farm' },
  { id: 'drivein', name: 'Moonbeam Drive-In', rect: mkRect(-820, 40, -712, 200), kind: 'venue' },
  { id: 'track', name: 'Gravel Gulch', rect: mkRect(-1290, 300, -1060, 540), kind: 'venue' },
  { id: 'ridge', name: 'Coyote Ridge', rect: mkRect(-1560, -560, -1360, 120), kind: 'wild' },
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
  const b = country.bounds;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return SEABED_Y;
  let d2 = Infinity;
  for (const r of country.land) {
    const dx = Math.max(r.minX - x, 0, x - r.maxX);
    const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
    d2 = Math.min(d2, dx * dx + dz * dz);
  }
  return beachHeight(Math.sqrt(d2)) + riseAt(country.rises, x, z);
}

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
    bounds: COUNTY_BOUNDS,
    roads: COUNTRY_ROADS,
    graph,
    plots: COUNTY_PLOTS,
    rises: [],
    walks: [],
    firstProp: layout.props.length,
    firstParapet: layout.parapets.length,
  };
  // The links. The causeway is a headland of its own at road level, quay walls and rocks along its sides (shore.ts) and
  // none at either end, where it meets land; the bridge is a deck at road level with a parapet along either edge and no
  // footways.
  layout.headlands.push({ name: CAUSEWAY_NAME, y: 0, rects: [CAUSEWAY] });
  layout.decks.push({ rect: BRIDGE, y: 0, name: BRIDGE_NAME, bridge: true });
  layout.parapets.push(mkRect(BRIDGE.minX, BRIDGE.minZ, BRIDGE.maxX, BRIDGE.minZ + PARAPET_T), mkRect(BRIDGE.minX, BRIDGE.maxZ - PARAPET_T, BRIDGE.maxX, BRIDGE.maxZ));
  for (const m of MOUTH_MOVES) for (const p of layout.props) if (Math.abs(p.x - m.x) < 0.01 && Math.abs(p.z - m.z) < 0.01) p.z = m.to;

  // Signal heads: for the eastbound approach the gateways gain, and for every approach at the county's junctions.
  for (const g of graph.gateways) {
    const i = g.node % (layout.n + 1);
    const j = Math.floor(g.node / (layout.n + 1));
    signalHead(layout, g.node, 1, layout.vLines[i]!.pos, layout.hLines[j]!.pos, layout.vLines[i]!.width / 2, layout.hLines[j]!.width / 2);
  }
  for (const v of graph.vertices) {
    if (v.links.length < 3) continue;
    for (const l of v.links) {
      const link = graph.links[l]!;
      const other = link.a === v.id ? link.b : link.a;
      const o = nodeXZ(layout, graph, other);
      // Traffic coming in along this arm travels the other way.
      signalHead(layout, v.id, (slotOf(o.x - v.x, o.z - v.z) + 2) % 4, v.x, v.z, v.half, v.half);
    }
  }
  // The causeway's lamps, their heads over the carriageway.
  const half = COUNTRY_ROADS[0]!.width / 2;
  for (let x = CAUSEWAY.maxX - 15; x > CAUSEWAY.minX + 5; x -= LAMP_GAP) {
    addProp(layout, 'lamp', x, -268 - half - 1, 0, 1, 0);
    addProp(layout, 'lamp', x - LAMP_GAP / 2, -268 + half + 1, Math.PI, 1, 0);
  }
  // The content passes go here, in this order, each one call that only appends: buildHills (the landscape), buildFarms,
  // buildPlaces.
}

/** A node's place: a grid node's line crossing, or a county vertex. */
export function nodeXZ(layout: CityLayout, graph: CountryGraph, id: number): { x: number; z: number } {
  const first = (layout.n + 1) * (layout.n + 1);
  if (id >= first) return graph.vertices[id - first]!;
  return { x: layout.vLines[id % (layout.n + 1)]!.pos, z: layout.hLines[Math.floor(id / (layout.n + 1))]!.pos };
}

/**
 * The signal head serving traffic travelling `dir` (0 N, 1 E, 2 S, 3 W) into the junction at (x, z) with half extents
 * hw, hh: at the corner on the approach's right, facing it, as generateCity stands the city's.
 */
function signalHead(layout: CityLayout, node: number, dir: number, x: number, z: number, hw: number, hh: number): void {
  const i = PROP_INSET;
  const [px, pz] = dir === 0 ? [x + hw + i, z + hh + i] : dir === 2 ? [x - hw - i, z - hh - i] : dir === 1 ? [x - hw - i, z + hh + i] : [x + hw + i, z - hh - i];
  const tx = dir === 1 ? 1 : dir === 3 ? -1 : 0;
  const tz = dir === 2 ? 1 : dir === 0 ? -1 : 0;
  // On a gateway's sidewalk corner, at the kerb's height; in the county, on its ground.
  const p = addProp(layout, 'signal', px, pz, Math.atan2(-tx, -tz), 1, px < layout.bounds.landMinX ? countryGround(layout.country, px, pz) : CURB_H);
  p.node = node;
  p.dir = dir;
}

/** The county before buildCountry lays it down. */
export function noCountry(): Country {
  return {
    land: [],
    bounds: mkRect(0, 0, 0, 0),
    roads: [],
    graph: { vertices: [], links: [], roadNodes: [], gateways: [], junctions: { drycreek: -1, hollister: -1, creek: -1 } },
    plots: [],
    rises: [],
    walks: [],
    firstProp: 0,
    firstParapet: 0,
  };
}

/** The lane graph's end-of-lane offset at a node: a junction's box and its crosswalk, or half a metre at a bend. */
export function laneEnd(half: number): number {
  return half > 0 ? half + CROSSWALK_W : 0.5;
}
