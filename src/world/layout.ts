// Deterministic procedural layout of San Azura: road grid, districts, parcels,
// buildings, street furniture, points of interest, beach, piers and ramps.
// Pure data, no rendering; consumed by the static world, the simulation and the renderer.

import { Rng } from '../core/rng';
import { clamp } from '../core/math';
import { buildMonorail, noMonorail, type Monorail } from './monorail';
import {
  AVENUE_W, BEACH_W, BOARDWALK_W, CITY_SEED, CROSSWALK_W, CURB_H, GRID_N, PED_INSET,
  PROMENADE_W, PROP_INSET, SAND_DROP, SIDEWALK_W, STREET_W, WATER_Y,
} from './constants';

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export type District = 'downtown' | 'midtown' | 'hillcrest' | 'westside' | 'docks' | 'southgate' | 'beachfront' | 'park';
export type Side = 'N' | 'E' | 'S' | 'W';
export type FacadeStyle = 'glassBlue' | 'glassTeal' | 'office' | 'brick' | 'stucco' | 'house' | 'warehouse' | 'hotel';
export type RoofStyle = 'flat' | 'gable' | 'helipad';
export type GroundKind = 'grass' | 'plaza' | 'parking' | 'dirt' | 'yard';
export type PropKind =
  | 'tree' | 'palm' | 'lamp' | 'signal' | 'hydrant' | 'bench' | 'bin' | 'container' | 'bush'
  | 'fountain' | 'crane' | 'boat' | 'lighthouse' | 'ferris' | 'billboard';
/** The `contact...` kinds are mission givers' places: which one a POI is, and how it is built, is the SPECIALS row's business. */
export type PoiKind = 'safehouse' | 'hospital' | 'police' | 'spray' | 'gunshop' | 'bank' | 'marina' | `contact${string}`;
export type RoofPropKind = 'ac' | 'tank' | 'antenna' | 'billboard' | 'helipad';
/** Street-level treatment of a building's ground floor (drawn by the renderer only). */
export type GroundFloor = 'shops' | 'lobby' | 'house' | 'loading' | 'none';

export interface RoadLine {
  index: number;
  vertical: boolean;
  /** x for vertical lines, z for horizontal lines. */
  pos: number;
  width: number;
  lanes: 1 | 2;
  avenue: boolean;
  name: string;
}

export interface Tier extends Rect {
  y0: number;
  y1: number;
}

export interface RoofProp {
  kind: RoofPropKind;
  x: number;
  z: number;
  y: number;
  w: number;
  d: number;
  h: number;
  rot: number;
}

export interface Building {
  id: number;
  rect: Rect;
  height: number;
  tiers: Tier[];
  style: FacadeStyle;
  roof: RoofStyle;
  /** Random 0..1 used by the renderer for colour variation. */
  tint: number;
  district: District;
  roofProps: RoofProp[];
  sign: { text: string; color: string; side: Side } | null;
  /** The special structure this building is (bank, police, safehouse, stadium...), or null. */
  special: PoiKind | 'stadium' | null;
  /**
   * Ground-floor treatment of the street frontage of the first tier, assigned after generation
   * (see assignGroundFloors) so it never changes the generated geometry.
   */
  ground: GroundFloor;
  /** Height of the ground-floor band above CURB_H in metres (0 when ground is 'none'). */
  groundH: number;
  /** Sides of the first tier that get the ground floor (empty when ground is 'none'). */
  groundSides: Side[];
}

export interface Block {
  id: number;
  /** The cells it covers: bi..bi2 by bj..bj2 (one cell, or several for a superblock). */
  bi: number;
  bj: number;
  bi2: number;
  bj2: number;
  rect: Rect;
  lot: Rect;
  district: District;
  zone: string;
}

export interface GroundPatch {
  rect: Rect;
  kind: GroundKind;
}

export interface Prop {
  kind: PropKind;
  x: number;
  z: number;
  y: number;
  rot: number;
  scale: number;
  /** Packed RGB colour for coloured props such as containers. */
  color: number;
  /** For containers: footprint and height. */
  w: number;
  d: number;
  h: number;
  /** For signals: the road node and travel direction (0 N, 1 E, 2 S, 3 W) served. */
  node: number;
  dir: number;
}

export interface Poi {
  id: string;
  kind: PoiKind;
  name: string;
  /** Marker position (on the sidewalk in front of the entrance). */
  x: number;
  z: number;
  /** Direction the entrance faces. */
  heading: number;
  /** Drive-in trigger area for garages (spray shops, Lou's garage). */
  bay: Rect | null;
  block: number;
}

export interface Garage {
  poi: string;
  rect: Rect;
  side: Side;
  walls: Rect[];
  height: number;
  color: number;
}

export interface Ramp {
  id: number;
  x: number;
  z: number;
  heading: number;
  length: number;
  width: number;
  height: number;
}

export interface Deck {
  rect: Rect;
  y: number;
  name: string;
  /** A bridge's carriageway or footway over the canal (a slab with parapets), not a pier on pilings. */
  bridge: boolean;
}

/** Sea inside the land: a cove, a harbour basin or a canal. */
export interface WaterBody {
  name: string;
  /** Rectangles of water (they may touch). */
  rects: Rect[];
  /** Their bounding box. */
  bounds: Rect;
  /** The cells given to it: the water and the quay round it, short of the roads and blocks. */
  area: Rect[];
}

/** Land reaching out beyond the promenade into the sea. */
export interface Headland {
  name: string;
  rects: Rect[];
}

export interface ParkingSpot {
  x: number;
  z: number;
  heading: number;
}

export interface Bounds {
  cityMinX: number;
  cityMaxX: number;
  cityMinZ: number;
  cityMaxZ: number;
  landMinX: number;
  landMinZ: number;
  landMaxZ: number;
  beachStartX: number;
  beachEndX: number;
  /** Hard limits for anything that moves (swimming players, cars that fall in). */
  worldMinX: number;
  worldMaxX: number;
  worldMinZ: number;
  worldMaxZ: number;
}

export interface CityLayout {
  seed: number;
  n: number;
  vLines: RoadLine[];
  hLines: RoadLine[];
  blocks: Block[];
  /** The block on each grid cell (bj * n + bi): a superblock is on several, and a sea cell has none. */
  cells: (Block | null)[];
  /**
   * Which road segments exist: roadH[j * n + i] joins junctions (i, j) and (i + 1, j), roadV[j * (n + 1) + i] joins
   * (i, j) and (i, j + 1). A segment exists when it borders a land block and does not run inside a superblock.
   */
  roadH: boolean[];
  roadV: boolean[];
  water: WaterBody[];
  headlands: Headland[];
  /** Parapets along the bridges' footways over the water, PARAPET_H high above the footway. */
  parapets: Rect[];
  buildings: Building[];
  ground: GroundPatch[];
  props: Prop[];
  pois: Poi[];
  garages: Garage[];
  ramps: Ramp[];
  decks: Deck[];
  parking: ParkingSpot[];
  /** Free positions inside lots/parks used for pickups and collectibles. */
  openSpots: { x: number; z: number; district: District }[];
  stadium: Rect | null;
  bounds: Bounds;
  /** AzuraLink, the monorail along Cortez Canal (world/monorail.ts). */
  monorail: Monorail;
}

// ---------------------------------------------------------------------------
// Rect helpers

export function mkRect(minX: number, minZ: number, maxX: number, maxZ: number): Rect {
  return { minX, minZ, maxX, maxZ };
}

export function rectW(r: Rect): number {
  return r.maxX - r.minX;
}

export function rectD(r: Rect): number {
  return r.maxZ - r.minZ;
}

export function rectCX(r: Rect): number {
  return (r.minX + r.maxX) / 2;
}

export function rectCZ(r: Rect): number {
  return (r.minZ + r.maxZ) / 2;
}

export function insetRect(r: Rect, d: number): Rect {
  return { minX: r.minX + d, minZ: r.minZ + d, maxX: r.maxX - d, maxZ: r.maxZ - d };
}

export function rectContains(r: Rect, x: number, z: number, margin = 0): boolean {
  return x >= r.minX - margin && x <= r.maxX + margin && z >= r.minZ - margin && z <= r.maxZ + margin;
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return a.minX < b.maxX + margin && a.maxX > b.minX - margin && a.minZ < b.maxZ + margin && a.maxZ > b.minZ - margin;
}

/** The parts of r outside cut: r itself, nothing, or up to four rectangles. */
export function rectMinus(r: Rect, cut: Rect): Rect[] {
  if (!rectsOverlap(r, cut)) return [r];
  const out: Rect[] = [];
  if (cut.minZ > r.minZ) out.push(mkRect(r.minX, r.minZ, r.maxX, cut.minZ));
  if (cut.maxZ < r.maxZ) out.push(mkRect(r.minX, cut.maxZ, r.maxX, r.maxZ));
  const z0 = Math.max(r.minZ, cut.minZ);
  const z1 = Math.min(r.maxZ, cut.maxZ);
  if (cut.minX > r.minX) out.push(mkRect(r.minX, z0, cut.minX, z1));
  if (cut.maxX < r.maxX) out.push(mkRect(cut.maxX, z0, r.maxX, z1));
  return out;
}

/** The parts of rects outside every cut. */
export function rectsMinus(rects: readonly Rect[], cuts: readonly Rect[]): Rect[] {
  let out = [...rects];
  for (const c of cuts) out = out.flatMap((r) => rectMinus(r, c));
  return out;
}

/** The water body at (x, z), or null. */
export function waterAt(layout: CityLayout, x: number, z: number): WaterBody | null {
  for (const w of layout.water) {
    if (!rectContains(w.bounds, x, z)) continue;
    for (const r of w.rects) if (rectContains(r, x, z)) return w;
  }
  return null;
}

/** The headland at (x, z), or null. */
export function headlandAt(layout: CityLayout, x: number, z: number): Headland | null {
  for (const h of layout.headlands) for (const r of h.rects) if (rectContains(r, x, z)) return h;
  return null;
}

export function sideHeading(side: Side): number {
  switch (side) {
    case 'N':
      return Math.PI;
    case 'S':
      return 0;
    case 'E':
      return Math.PI / 2;
    case 'W':
      return -Math.PI / 2;
  }
}

/** Whether a road leaves junction (i, j) towards dir (0 N, 1 E, 2 S, 3 W). */
export function roadFrom(layout: CityLayout, i: number, j: number, dir: number): boolean {
  const n = layout.n;
  switch (dir) {
    case 0:
      return j > 0 && layout.roadV[(j - 1) * (n + 1) + i]!;
    case 1:
      return i < n && layout.roadH[j * n + i]!;
    case 2:
      return j < n && layout.roadV[j * (n + 1) + i]!;
    default:
      return i > 0 && layout.roadH[j * n + i - 1]!;
  }
}

/** The block on cell (bi, bj), or null for a sea cell. */
export function cellBlock(layout: CityLayout, bi: number, bj: number): Block | null {
  return layout.cells[bj * layout.n + bi] ?? null;
}

// ---------------------------------------------------------------------------
// Static design data

// Columns 2 and 3 gave 11 m each to the canal (see CANAL), so every other line stays where it was.
const COL_SIZES = [88, 84, 73, 65, 72, 72, 76, 84, 88, 92];
const ROW_SIZES = [92, 88, 84, 76, 72, 72, 76, 84, 88, 92];
const AVENUES = new Set([0, 2, 5, 8, 10]);
const V_NAMES = ['Harbor Blvd', 'Palmetto St', 'Vista Ave', 'Cortez Canal', 'Marlin St', 'Azura Ave', 'Coral St', 'Delgado St', 'Sunset Ave', 'Reef St', 'Ocean Dr'];
const H_NAMES = ['Northshore Blvd', 'Hillcrest Rd', 'Magnolia Ave', 'Elm St', 'Union St', 'Central Ave', 'Market St', 'Canal St', 'Southgate Ave', 'Dock St', 'Seaview Blvd'];

/** Height of the bridges' parapets above their footways (m). */
export const PARAPET_H = 1.05;
/** Their thickness (m). */
const PARAPET_T = 0.35;

/** The vertical line given to a canal from the north coast to the south coast, bridged at every street. */
const CANAL = { line: 3, name: 'Cortez Canal', width: 32 };

/** The shared generator's state where the coast began before the city was broken up: the beach keeps its places. */
const COAST_STATE = 1821245402;

/** Superblocks: one block over cells bi..bi2 by bj..bj2, the streets between them closed. */
const SUPERBLOCKS: ReadonlyArray<{ bi: number; bj: number; bi2: number; bj2: number }> = [
  // Hillcrest Green, a big park on the hill.
  { bi: 5, bj: 0, bi2: 6, bj2: 1 },
  // Civic Plaza, an open square between downtown towers.
  { bi: 5, bj: 6, bi2: 6, bj2: 6 },
  // The Azura Bowl and its car parks.
  { bi: 6, bj: 9, bi2: 7, bj2: 9 },
];

/** The superblock built round an open square. */
const PLAZA_BLOCK = { bi: 5, bj: 6, name: 'Civic Plaza' };

interface SeaBody {
  name: string;
  cells: ReadonlyArray<readonly [number, number]>;
  /** The quay (m) left between the water and the coast road round it: a sidewalk's width, or a wharf for the cranes. */
  quay: number;
  /**
   * Built as land and drowned once the street furniture stands (see drown()): every other block keeps the random
   * draws it had while these cells were land.
   */
  drowned?: true;
}

/** Cells given to the sea. */
const SEA_BODIES: readonly SeaBody[] = [
  { name: 'Hillcrest Cove', cells: [[0, 0], [1, 0]], quay: SIDEWALK_W },
  { name: 'Port Basin', cells: [[0, 9], [1, 9]], quay: 20 },
  // West of Hillcrest Green, and east of it beside Azura Point: the north shore steps in and out round the park.
  { name: 'Gull Bay', cells: [[4, 0]], quay: SIDEWALK_W, drowned: true },
  { name: 'Northshore Bay', cells: [[7, 0], [8, 0]], quay: SIDEWALK_W, drowned: true },
  // A harbour bitten out of Westside's shore.
  { name: 'Pelican Harbor', cells: [[0, 5], [0, 6]], quay: SIDEWALK_W, drowned: true },
  // The south shore turns in before the beach.
  { name: 'Coral Bay', cells: [[8, 9]], quay: SIDEWALK_W, drowned: true },
];

const PARKS: ReadonlyArray<{ bi: number; bj: number; name: string }> = [
  { bi: 7, bj: 5, name: 'Azura Park' },
  { bi: 5, bj: 0, name: 'Hillcrest Green' },
  { bi: 4, bj: 8, name: 'Southgate Square' },
];

/** A garage with its own sidewalk marker, `markerOffset` m along the frontage. */
interface GarageBuild {
  type: 'garage';
  color: number;
  markerOffset: number;
}

/** A stepped tower: a podium up to `podium`, a shaft up to `shaft`, a top up to `height`. */
interface TowerBuild {
  type: 'tower';
  height: number;
  podium: number;
  shaft: number;
  style: FacadeStyle;
  roof: RoofStyle;
  sign: { text: string; color: string };
}

interface SpecialDef {
  id: string;
  kind: PoiKind;
  bi: number;
  bj: number;
  side: Side;
  name: string;
  /** How a contact's place is built (the other kinds are built by kind). */
  build?: GarageBuild | TowerBuild;
}

const SPRAY_GARAGE: GarageBuild = { type: 'garage', color: 0x2f8f5b, markerOffset: 0 };

export const SPECIALS: readonly SpecialDef[] = [
  { id: 'safehouse', kind: 'safehouse', bi: 4, bj: 1, side: 'S', name: 'Safehouse' },
  { id: 'hospital', kind: 'hospital', bi: 7, bj: 2, side: 'S', name: 'San Azura General' },
  { id: 'police', kind: 'police', bi: 2, bj: 4, side: 'S', name: 'SAPD Central' },
  { id: 'spray_docks', kind: 'spray', bi: 1, bj: 8, side: 'N', name: 'Spray Shack' },
  { id: 'spray_south', kind: 'spray', bi: 7, bj: 8, side: 'W', name: 'Spray Shack' },
  { id: 'spray_hill', kind: 'spray', bi: 2, bj: 0, side: 'S', name: 'Spray Shack' },
  { id: 'guns_south', kind: 'gunshop', bi: 5, bj: 7, side: 'N', name: 'Bang Bang Guns' },
  { id: 'guns_west', kind: 'gunshop', bi: 0, bj: 3, side: 'E', name: 'Bang Bang Guns' },
  { id: 'bank', kind: 'bank', bi: 5, bj: 3, side: 'W', name: 'First Azura Bank' },
  { id: 'lou', kind: 'contactLou', bi: 2, bj: 9, side: 'N', name: "Lou's Auto Repair", build: { type: 'garage', color: 0x8a4b2a, markerOffset: 11 } },
  {
    id: 'dex',
    kind: 'contactDex',
    bi: 4,
    bj: 5,
    side: 'S',
    name: 'Moreau Tower',
    build: { type: 'tower', height: 128, podium: 14, shaft: 112, style: 'glassTeal', roof: 'helipad', sign: { text: 'MOREAU', color: '#38e1d2' } },
  },
  { id: 'vera', kind: 'contactVera', bi: 5, bj: 9, side: 'E', name: 'Hotel Salgado', build: { type: 'tower', height: 30, podium: 6, shaft: 24, style: 'hotel', roof: 'flat', sign: { text: 'HOTEL SALGADO', color: '#b8e62e' } } },
];

/** The building kinds that are towers: their ground floor is a lobby. */
const TOWER_KINDS: ReadonlySet<string> = new Set(SPECIALS.filter((s) => s.build?.type === 'tower').map((s) => s.kind));

const STADIUM_BLOCK = { bi: 6, bj: 9 };

/** The street gangs of San Azura. */
export type GangId = 'tiburones' | 'halcones';

/**
 * A gang's turf: the blocks bi minBi..maxBi, bj minBj..maxBj (inclusive) out to the centre lines of the roads round
 * them. Turfs never overlap, so a point lies in at most one gang's turf.
 */
export interface GangTurf {
  gang: GangId;
  name: string;
  minBi: number;
  maxBi: number;
  minBj: number;
  maxBj: number;
}

export const GANG_TURFS: readonly GangTurf[] = [
  { gang: 'tiburones', name: 'Port Azura Docks', minBi: 0, maxBi: 2, minBj: 7, maxBj: 9 },
  { gang: 'tiburones', name: 'Westside', minBi: 0, maxBi: 1, minBj: 2, maxBj: 6 },
  { gang: 'halcones', name: 'Southgate', minBi: 3, maxBi: 8, minBj: 7, maxBj: 9 },
];

export function districtOf(bi: number, bj: number): District {
  if (PARKS.some((p) => p.bi === bi && p.bj === bj)) return 'park';
  if (bi === GRID_N - 1) return 'beachfront';
  if (bj <= 1) return 'hillcrest';
  if (bi <= 2 && bj >= 7) return 'docks';
  if (bi <= 1) return 'westside';
  if (bi >= 3 && bi <= 6 && bj >= 3 && bj <= 6) return 'downtown';
  if (bj >= 7) return 'southgate';
  return 'midtown';
}

const DISTRICT_ZONE: Record<District, string> = {
  downtown: 'Downtown',
  midtown: 'Midtown',
  hillcrest: 'Hillcrest',
  westside: 'Westside',
  docks: 'Port Azura Docks',
  southgate: 'Southgate',
  beachfront: 'Ocean Beach',
  park: 'Park',
};

// ---------------------------------------------------------------------------

export function generateCity(seed: number = CITY_SEED): CityLayout {
  const rng = new Rng(seed);
  const n = GRID_N;

  const vLines = makeLines(true, COL_SIZES);
  const hLines = makeLines(false, ROW_SIZES);

  const first = (l: RoadLine[]) => l[0]!;
  const last = (l: RoadLine[]) => l[l.length - 1]!;
  const cityMinX = first(vLines).pos - first(vLines).width / 2;
  const cityMaxX = last(vLines).pos + last(vLines).width / 2;
  const cityMinZ = first(hLines).pos - first(hLines).width / 2;
  const cityMaxZ = last(hLines).pos + last(hLines).width / 2;
  const beachStartX = cityMaxX + BOARDWALK_W;
  const beachEndX = beachStartX + BEACH_W;
  const bounds: Bounds = {
    cityMinX,
    cityMaxX,
    cityMinZ,
    cityMaxZ,
    landMinX: cityMinX - PROMENADE_W,
    landMinZ: cityMinZ - PROMENADE_W,
    landMaxZ: cityMaxZ + PROMENADE_W,
    beachStartX,
    beachEndX,
    worldMinX: cityMinX - PROMENADE_W - 160,
    worldMaxX: beachEndX + 160,
    worldMinZ: cityMinZ - PROMENADE_W - 160,
    worldMaxZ: cityMaxZ + PROMENADE_W + 160,
  };

  const layout: CityLayout = {
    seed,
    n,
    vLines,
    hLines,
    blocks: [],
    cells: [],
    roadH: [],
    roadV: [],
    water: [],
    headlands: [],
    parapets: [],
    buildings: [],
    ground: [],
    props: [],
    pois: [],
    garages: [],
    ramps: [],
    decks: [],
    parking: [],
    openSpots: [],
    stadium: null,
    bounds,
    monorail: noMonorail(),
  };

  // Blocks: one per cell, one per superblock, none on a sea cell.
  const cells: (Block | null)[] = layout.cells;
  for (let k = 0; k < n * n; k++) cells.push(null);
  const sea = new Set(SEA_BODIES.filter((w) => !w.drowned).flatMap((w) => w.cells.map(([bi, bj]) => bj * n + bi)));
  for (let bj = 0; bj < n; bj++) {
    for (let bi = 0; bi < n; bi++) {
      if (sea.has(bj * n + bi) || cells[bj * n + bi]) continue;
      const sb = SUPERBLOCKS.find((q) => q.bi === bi && q.bj === bj);
      const bi2 = sb ? sb.bi2 : bi;
      const bj2 = sb ? sb.bj2 : bj;
      const r = mkRect(
        vLines[bi]!.pos + vLines[bi]!.width / 2,
        hLines[bj]!.pos + hLines[bj]!.width / 2,
        vLines[bi2 + 1]!.pos - vLines[bi2 + 1]!.width / 2,
        hLines[bj2 + 1]!.pos - hLines[bj2 + 1]!.width / 2,
      );
      const district = districtOf(bi, bj);
      const park = PARKS.find((p) => p.bi === bi && p.bj === bj);
      const plaza = PLAZA_BLOCK.bi === bi && PLAZA_BLOCK.bj === bj;
      const block: Block = {
        id: bj * n + bi,
        bi,
        bj,
        bi2,
        bj2,
        rect: r,
        lot: insetRect(r, SIDEWALK_W),
        district,
        zone: park ? park.name : plaza ? PLAZA_BLOCK.name : DISTRICT_ZONE[district],
      };
      layout.blocks.push(block);
      for (let cj = bj; cj <= bj2; cj++) for (let ci = bi; ci <= bi2; ci++) cells[cj * n + ci] = block;
    }
  }
  layoutRoads(layout);
  buildWater(layout, SEA_BODIES.filter((w) => !w.drowned), new Set());
  buildCanal(layout);
  buildHeadland(layout);

  // Reserved sidewalk spans (drive-in entrances) where no street furniture may stand.
  const reserved: Rect[] = [];

  for (const block of layout.blocks) {
    const brng = new Rng((seed * 7919 + block.id * 104729) >>> 0);
    const special = SPECIALS.filter((s) => s.bi === block.bi && s.bj === block.bj);
    if (block.bi === STADIUM_BLOCK.bi && block.bj === STADIUM_BLOCK.bj) {
      buildStadium(layout, block, brng);
      continue;
    }
    if (block.district === 'park') {
      buildPark(layout, block, brng);
      continue;
    }
    if (block.bi === PLAZA_BLOCK.bi && block.bj === PLAZA_BLOCK.bj) {
      buildPlaza(layout, block, brng, reserved);
      continue;
    }
    buildBlock(layout, block, brng, special, reserved);
  }

  buildStreetFurniture(layout, rng, reserved);
  drown(layout, SEA_BODIES.filter((w) => w.drowned));
  // The coast draws from its own generator, so changes to the city's blocks leave the beach and promenade as they are.
  buildCoast(layout, new Rng(seed === CITY_SEED ? COAST_STATE : hashInts(seed, 6151)));
  buildRamps(layout);
  removePropsInRamps(layout);
  layout.props = layout.props.filter((p) => p.kind === 'boat' || !waterAt(layout, p.x, p.z));
  layout.parking = layout.parking.filter((p) => !waterAt(layout, p.x, p.z));
  layout.openSpots = layout.openSpots.filter((p) => !waterAt(layout, p.x, p.z));
  assignGroundFloors(layout);
  buildMonorail(layout);

  // Final sanity: never leave NaN in generated data.
  for (const b of layout.buildings) {
    if (![b.rect.minX, b.rect.maxX, b.rect.minZ, b.rect.maxZ, b.height, b.groundH].every(Number.isFinite)) {
      throw new Error(`Non-finite building ${b.id}`);
    }
  }
  return layout;
}

function makeLines(vertical: boolean, sizes: number[]): RoadLine[] {
  const widths: number[] = [];
  for (let i = 0; i <= sizes.length; i++) widths.push(vertical && i === CANAL.line ? CANAL.width : AVENUES.has(i) ? AVENUE_W : STREET_W);
  let total = 0;
  for (const w of widths) total += w;
  for (const s of sizes) total += s;
  let x = -total / 2;
  const lines: RoadLine[] = [];
  for (let i = 0; i <= sizes.length; i++) {
    const w = widths[i]!;
    lines.push({
      index: i,
      vertical,
      pos: x + w / 2,
      width: w,
      lanes: AVENUES.has(i) ? 2 : 1,
      avenue: AVENUES.has(i),
      name: (vertical ? V_NAMES : H_NAMES)[i] ?? `Road ${i}`,
    });
    x += w;
    if (i < sizes.length) x += sizes[i]!;
  }
  return lines;
}

/**
 * Decides which road segments exist: those with a land block on at least one side, unless the same block is on both
 * (the street runs inside a superblock).
 */
function layoutRoads(layout: CityLayout): void {
  const { n, cells } = layout;
  const cell = (bi: number, bj: number) => (bi >= 0 && bi < n && bj >= 0 && bj < n ? (cells[bj * n + bi] ?? null) : null);
  const exists = (a: Block | null, b: Block | null) => (a !== null || b !== null) && a !== b;
  for (let j = 0; j <= n; j++) for (let i = 0; i < n; i++) layout.roadH.push(exists(cell(i, j - 1), cell(i, j)));
  for (let j = 0; j < n; j++) for (let i = 0; i <= n; i++) layout.roadV.push(i !== CANAL.line && exists(cell(i - 1, j), cell(i, j)));
}

/**
 * Gives the drowned bodies' cells to the sea once the city round them stands: their blocks and everything on them go,
 * the roads that bordered only them close, except the ring road, which crosses the bay's mouth on a bridge so the coast
 * road runs on and no junction on it is left with a single way out; a signal stays only where three roads still meet
 * on a live approach, and the water comes in.
 */
function drown(layout: CityLayout, bodies: readonly SeaBody[]): void {
  const { n } = layout;
  const gone: Rect[] = [];
  for (const body of bodies) {
    for (const [bi, bj] of body.cells) {
      gone.push(layout.cells[bj * n + bi]!.rect);
      layout.cells[bj * n + bi] = null;
    }
  }
  const dry = (x: number, z: number) => !gone.some((r) => rectContains(r, x, z));
  layout.blocks = layout.blocks.filter((b) => dry(rectCX(b.rect), rectCZ(b.rect)));
  layout.buildings = layout.buildings.filter((b) => dry(rectCX(b.rect), rectCZ(b.rect)));
  layout.ground = layout.ground.filter((g) => dry(rectCX(g.rect), rectCZ(g.rect)));
  layout.garages = layout.garages.filter((g) => dry(rectCX(g.rect), rectCZ(g.rect)));
  layout.props = layout.props.filter((p) => dry(p.x, p.z));
  layout.parking = layout.parking.filter((p) => dry(p.x, p.z));
  layout.openSpots = layout.openSpots.filter((p) => dry(p.x, p.z));
  layout.roadH = [];
  layout.roadV = [];
  layoutRoads(layout);
  const bridged = new Set<string>();
  for (const body of bodies) {
    for (const [bi, bj] of body.cells) {
      if (bj === 0) bridged.add(`h${bi},0`);
      if (bj === n - 1) bridged.add(`h${bi},${n}`);
      if (bi === 0) bridged.add(`v0,${bj}`);
      if (bi === n - 1) bridged.add(`v${n},${bj}`);
    }
  }
  for (const key of bridged) {
    const [i, j] = key.slice(1).split(',').map(Number) as [number, number];
    if (key[0] === 'h') layout.roadH[j * n + i] = true;
    else layout.roadV[j * (n + 1) + i] = true;
  }
  layout.props = layout.props.filter((p) => {
    if (p.kind !== 'signal') return true;
    const i = p.node! % (n + 1);
    const j = Math.floor(p.node! / (n + 1));
    const roads = [0, 1, 2, 3].filter((d) => roadFrom(layout, i, j, d));
    return roads.length >= 3 && roads.includes((p.dir! + 2) % 4);
  });
  buildWater(layout, bodies, bridged);
}

/**
 * The sea cells' water: each cell out to the coast or to the middle of its roads, short of the live roads and their
 * quay. The `bridged` road segments (`h<i>,<j>` east of junction (i, j), `v<i>,<j>` south of it) and the junctions they
 * alone serve stand over the water instead, on bridge decks with parapets along their footways.
 */
function buildWater(layout: CityLayout, bodies: readonly SeaBody[], bridged: ReadonlySet<string>): void {
  const { n, vLines, hLines, bounds: b } = layout;
  // The segment leaving junction (i, j) towards dir (0 N, 1 E, 2 S, 3 W), by its key.
  const segKey = (i: number, j: number, d: number) => (d === 0 ? `v${i},${j - 1}` : d === 1 ? `h${i},${j}` : d === 2 ? `v${i},${j}` : `h${i - 1},${j}`);
  const onLand = (i: number, j: number, d: number) => roadFrom(layout, i, j, d) && !bridged.has(segKey(i, j, d));
  for (const body of bodies) {
    const q = body.quay;
    const keep: Rect[] = [];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const v = vLines[i]!;
        const h = hLines[j]!;
        if ([0, 1, 2, 3].some((d) => onLand(i, j, d))) keep.push(mkRect(v.pos - v.width / 2 - q, h.pos - h.width / 2 - q, v.pos + v.width / 2 + q, h.pos + h.width / 2 + q));
        if (onLand(i, j, 1)) keep.push(mkRect(v.pos, h.pos - h.width / 2 - q, vLines[i + 1]!.pos, h.pos + h.width / 2 + q));
        if (onLand(i, j, 2)) keep.push(mkRect(v.pos - v.width / 2 - q, h.pos, v.pos + v.width / 2 + q, hLines[j + 1]!.pos));
      }
    }
    const cells = body.cells.map(([bi, bj]) =>
      mkRect(bi === 0 ? b.landMinX : vLines[bi]!.pos, bj === 0 ? b.landMinZ : hLines[bj]!.pos, vLines[bi + 1]!.pos, bj === n - 1 ? b.landMaxZ : hLines[bj + 1]!.pos),
    );
    const rects = rectsMinus(cells, keep);
    const bounds = mkRect(Math.min(...rects.map((r) => r.minX)), Math.min(...rects.map((r) => r.minZ)), Math.max(...rects.map((r) => r.maxX)), Math.max(...rects.map((r) => r.maxZ)));
    layout.water.push({ name: body.name, rects, bounds, area: cells });
    // The bridges over this body's water: the carriageway at road level, a footway either side, a parapet outside each.
    const overWater = (r: Rect) => rects.map((w) => mkRect(Math.max(r.minX, w.minX), Math.max(r.minZ, w.minZ), Math.min(r.maxX, w.maxX), Math.min(r.maxZ, w.maxZ))).filter((x) => x.maxX > x.minX && x.maxZ > x.minZ);
    for (const key of bridged) {
      const [i, j] = key.slice(1).split(',').map(Number) as [number, number];
      // Across the road: its two kerb lines; along it: junction centre to junction centre.
      const [k0, k1, a0, a1] = key[0] === 'h' ? [hLines[j]!.pos - hLines[j]!.width / 2, hLines[j]!.pos + hLines[j]!.width / 2, vLines[i]!.pos, vLines[i + 1]!.pos] : [vLines[i]!.pos - vLines[i]!.width / 2, vLines[i]!.pos + vLines[i]!.width / 2, hLines[j]!.pos, hLines[j + 1]!.pos];
      const strip = (c0: number, c1: number) => (key[0] === 'h' ? mkRect(a0, c0, a1, c1) : mkRect(c0, a0, c1, a1));
      const deck = (c0: number, c1: number, y: number) => {
        for (const r of overWater(strip(c0, c1))) layout.decks.push({ rect: r, y, name: body.name, bridge: true });
      };
      deck(k0, k1, 0);
      deck(k0 - SIDEWALK_W, k0, CURB_H);
      deck(k1, k1 + SIDEWALK_W, CURB_H);
      layout.parapets.push(...overWater(strip(k0 - SIDEWALK_W, k0 - SIDEWALK_W + PARAPET_T)), ...overWater(strip(k1 + SIDEWALK_W - PARAPET_T, k1 + SIDEWALK_W)));
    }
  }
}

/**
 * Cortez Canal: the canal line's whole width from coast to coast, a bridge where every street crosses it (the
 * junction's box as carriageway, a sidewalk-wide footway either side of it) and a footbridge on each promenade.
 */
function buildCanal(layout: CityLayout): void {
  const { n, vLines, hLines, bounds: b } = layout;
  const line = vLines[CANAL.line]!;
  const x0 = line.pos - line.width / 2;
  const x1 = line.pos + line.width / 2;
  const water = mkRect(x0, b.landMinZ, x1, b.landMaxZ);
  layout.water.push({ name: CANAL.name, rects: [water], bounds: water, area: [water] });
  const deck = (z0: number, z1: number, y: number) => layout.decks.push({ rect: mkRect(x0, z0, x1, z1), y, name: CANAL.name, bridge: true });
  for (let j = 0; j <= n; j++) {
    if (!roadFrom(layout, CANAL.line, j, 1)) continue;
    const h = hLines[j]!;
    const z0 = h.pos - h.width / 2;
    const z1 = h.pos + h.width / 2;
    deck(z0, z1, 0);
    deck(z0 - SIDEWALK_W, z0, CURB_H);
    deck(z1, z1 + SIDEWALK_W, CURB_H);
    layout.parapets.push(mkRect(x0, z0 - SIDEWALK_W, x1, z0 - SIDEWALK_W + PARAPET_T), mkRect(x0, z1 + SIDEWALK_W - PARAPET_T, x1, z1 + SIDEWALK_W));
  }
  // The promenades' footbridges, along their seaward edge, clear of the stunt ramps' run-out lanes.
  for (const z of [b.landMinZ + 2, b.landMaxZ - 8]) {
    deck(z, z + 6, CURB_H);
    layout.parapets.push(mkRect(x0, z, x1, z + PARAPET_T), mkRect(x0, z + 6 - PARAPET_T, x1, z + 6));
  }
}

/** Azura Point: parkland reaching north from the promenade beyond Hillcrest Green, the lighthouse at its tip. */
function buildHeadland(layout: CityLayout): void {
  const { vLines, bounds: b } = layout;
  const x0 = vLines[5]!.pos + 24;
  const x1 = vLines[7]!.pos - 12;
  const cx = (x0 + x1) / 2;
  const base = mkRect(x0, b.landMinZ - 50, x1, b.landMinZ);
  const tip = mkRect(cx - 32, b.landMinZ - 118, cx + 32, b.landMinZ - 50);
  layout.headlands.push({ name: 'Azura Point', rects: [base, tip] });
}

// ---------------------------------------------------------------------------
// Blocks

function splitParcels(r: Rect, minSize: number, maxSize: number, rng: Rng, out: Rect[]): void {
  const w = rectW(r);
  const d = rectD(r);
  const canX = w >= 2 * minSize;
  const canZ = d >= 2 * minSize;
  const needX = w > maxSize && canX;
  const needZ = d > maxSize && canZ;
  if (!needX && !needZ) {
    out.push(r);
    return;
  }
  const splitX = needX && needZ ? w >= d : needX;
  const len = splitX ? w : d;
  const cut = clamp(Math.round(len * rng.range(0.36, 0.64)), minSize, len - minSize);
  if (splitX) {
    splitParcels(mkRect(r.minX, r.minZ, r.minX + cut, r.maxZ), minSize, maxSize, rng, out);
    splitParcels(mkRect(r.minX + cut, r.minZ, r.maxX, r.maxZ), minSize, maxSize, rng, out);
  } else {
    splitParcels(mkRect(r.minX, r.minZ, r.maxX, r.minZ + cut), minSize, maxSize, rng, out);
    splitParcels(mkRect(r.minX, r.minZ + cut, r.maxX, r.maxZ), minSize, maxSize, rng, out);
  }
}

const PARCEL_SIZES: Record<District, [number, number]> = {
  downtown: [26, 40],
  midtown: [18, 34],
  hillcrest: [16, 24],
  westside: [16, 28],
  docks: [24, 46],
  southgate: [18, 34],
  beachfront: [22, 40],
  park: [999, 999],
};

function sidePoint(lot: Rect, side: Side): { x: number; z: number } {
  switch (side) {
    case 'N':
      return { x: rectCX(lot), z: lot.minZ };
    case 'S':
      return { x: rectCX(lot), z: lot.maxZ };
    case 'E':
      return { x: lot.maxX, z: rectCZ(lot) };
    case 'W':
      return { x: lot.minX, z: rectCZ(lot) };
  }
}

/** Marker position on the sidewalk in front of the middle of a block side. */
function sidewalkMarker(block: Block, side: Side, along = 0): { x: number; z: number } {
  const r = block.rect;
  switch (side) {
    case 'N':
      return { x: rectCX(r) + along, z: r.minZ + PED_INSET };
    case 'S':
      return { x: rectCX(r) + along, z: r.maxZ - PED_INSET };
    case 'E':
      return { x: r.maxX - PED_INSET, z: rectCZ(r) + along };
    case 'W':
      return { x: r.minX + PED_INSET, z: rectCZ(r) + along };
  }
}

/** Rectangle of a garage opening onto `side`, flush with the lot edge, centred at `along`. */
function garageRect(lot: Rect, side: Side, along: number, width: number, depth: number): Rect {
  const cx = rectCX(lot) + along;
  const cz = rectCZ(lot) + along;
  switch (side) {
    case 'N':
      return mkRect(cx - width / 2, lot.minZ, cx + width / 2, lot.minZ + depth);
    case 'S':
      return mkRect(cx - width / 2, lot.maxZ - depth, cx + width / 2, lot.maxZ);
    case 'E':
      return mkRect(lot.maxX - depth, cz - width / 2, lot.maxX, cz + width / 2);
    case 'W':
      return mkRect(lot.minX, cz - width / 2, lot.minX + depth, cz + width / 2);
  }
}

function garageWalls(g: Rect, side: Side, t: number): Rect[] {
  // Back wall opposite the opening plus two side walls.
  switch (side) {
    case 'N':
      return [mkRect(g.minX, g.maxZ - t, g.maxX, g.maxZ), mkRect(g.minX, g.minZ, g.minX + t, g.maxZ), mkRect(g.maxX - t, g.minZ, g.maxX, g.maxZ)];
    case 'S':
      return [mkRect(g.minX, g.minZ, g.maxX, g.minZ + t), mkRect(g.minX, g.minZ, g.minX + t, g.maxZ), mkRect(g.maxX - t, g.minZ, g.maxX, g.maxZ)];
    case 'E':
      return [mkRect(g.minX, g.minZ, g.minX + t, g.maxZ), mkRect(g.minX, g.minZ, g.maxX, g.minZ + t), mkRect(g.minX, g.maxZ - t, g.maxX, g.maxZ)];
    case 'W':
      return [mkRect(g.maxX - t, g.minZ, g.maxX, g.maxZ), mkRect(g.minX, g.minZ, g.maxX, g.minZ + t), mkRect(g.minX, g.maxZ - t, g.maxX, g.maxZ)];
  }
}

/** Sidewalk span in front of a garage, kept clear of street furniture. */
function frontageSpan(block: Block, side: Side, g: Rect, pad: number): Rect {
  const r = block.rect;
  switch (side) {
    case 'N':
      return mkRect(g.minX - pad, r.minZ - 1, g.maxX + pad, r.minZ + SIDEWALK_W + 1);
    case 'S':
      return mkRect(g.minX - pad, r.maxZ - SIDEWALK_W - 1, g.maxX + pad, r.maxZ + 1);
    case 'E':
      return mkRect(r.maxX - SIDEWALK_W - 1, g.minZ - pad, r.maxX + 1, g.maxZ + pad);
    case 'W':
      return mkRect(r.minX - 1, g.minZ - pad, r.minX + SIDEWALK_W + 1, g.maxZ + pad);
  }
}

function addGarage(layout: CityLayout, block: Block, def: SpecialDef, along: number, color: number, reserved: Rect[]): Rect {
  const g = garageRect(block.lot, def.side, along, 11, 13);
  const walls = garageWalls(g, def.side, 0.5);
  layout.garages.push({ poi: def.id, rect: g, side: def.side, walls, height: 5.5, color });
  reserved.push(frontageSpan(block, def.side, g, 2));
  layout.ground.push({ rect: g, kind: 'plaza' });
  return g;
}

function bayOf(g: Rect, side: Side): Rect {
  // Interior trigger area: inside the walls, not counting the first metre at the opening.
  const inner = insetRect(g, 1.1);
  switch (side) {
    case 'N':
      return mkRect(inner.minX, g.minZ + 1.5, inner.maxX, inner.maxZ);
    case 'S':
      return mkRect(inner.minX, inner.minZ, inner.maxX, g.maxZ - 1.5);
    case 'E':
      return mkRect(inner.minX, inner.minZ, g.maxX - 1.5, inner.maxZ);
    case 'W':
      return mkRect(g.minX + 1.5, inner.minZ, inner.maxX, inner.maxZ);
  }
}

function buildBlock(layout: CityLayout, block: Block, rng: Rng, specials: SpecialDef[], reserved: Rect[], areas: Rect[] = [block.lot]): void {
  const [minS, maxS] = PARCEL_SIZES[block.district];
  const parcels: Rect[] = [];
  for (const a of areas) splitParcels(a, minS, maxS, rng, parcels);

  const blocked: Rect[] = []; // areas consumed by special structures
  const specialParcels = new Map<Rect, SpecialDef>();

  for (const def of specials) {
    const heading = sideHeading(def.side);
    const garage = def.kind === 'spray' ? SPRAY_GARAGE : def.build?.type === 'garage' ? def.build : null;
    if (garage) {
      const g = addGarage(layout, block, def, 0, garage.color, reserved);
      blocked.push(insetRect(g, -1.5));
      const marker = sidewalkMarker(block, def.side, garage.markerOffset);
      layout.pois.push({ id: def.id, kind: def.kind, name: def.name, x: marker.x, z: marker.z, heading, bay: bayOf(g, def.side), block: block.id });
      // The marker beside the door stays clear of lamps, trees and benches too, for a bus parked on it.
      reserved.push(mkRect(marker.x - 6, marker.z - 6, marker.x + 6, marker.z + 6));
    } else {
      const p = sidePoint(block.lot, def.side);
      const parcel = parcels.find((q) => rectContains(q, p.x, p.z, 0.01));
      if (!parcel) throw new Error(`No parcel for special ${def.id}`);
      specialParcels.set(parcel, def);
      const marker = sidewalkMarker(block, def.side, 0);
      layout.pois.push({ id: def.id, kind: def.kind, name: def.name, x: marker.x, z: marker.z, heading, bay: null, block: block.id });
      // Keep the entrance clear of lamps, trees and benches.
      reserved.push(mkRect(marker.x - 3.5, marker.z - 3.5, marker.x + 3.5, marker.z + 3.5));
    }
  }

  const centerX = 0;
  const centerZ = 0;
  for (const parcel of parcels) {
    if (blocked.some((b) => rectsOverlap(b, parcel))) {
      layout.ground.push({ rect: parcel, kind: 'plaza' });
      continue;
    }
    const def = specialParcels.get(parcel);
    if (def) {
      layout.buildings.push(specialBuilding(layout.buildings.length, parcel, def, block.district, rng));
      layout.ground.push({ rect: parcel, kind: 'plaza' });
      continue;
    }
    const cx = rectCX(parcel);
    const cz = rectCZ(parcel);
    const dc = Math.sqrt((cx - centerX) ** 2 + (cz - centerZ) ** 2);
    makeParcel(layout, parcel, block, rng, dc);
  }
}

function makeParcel(layout: CityLayout, p: Rect, block: Block, rng: Rng, distCenter: number): void {
  const d = block.district;
  const w = rectW(p);
  const dd = rectD(p);
  const interior = p.minX > block.lot.minX + 0.5 && p.maxX < block.lot.maxX - 0.5 && p.minZ > block.lot.minZ + 0.5 && p.maxZ < block.lot.maxZ - 0.5;

  // Some parcels are parking lots or yards instead of buildings.
  const parkingChance = d === 'midtown' ? 0.14 : d === 'southgate' ? 0.2 : d === 'beachfront' ? 0.15 : d === 'westside' ? 0.1 : d === 'docks' ? 0.12 : d === 'downtown' ? 0.06 : 0;
  if (!interior && w >= 18 && dd >= 18 && rng.chance(parkingChance)) {
    makeParkingLot(layout, p, rng);
    return;
  }
  if (d === 'docks' && w >= 24 && dd >= 24 && rng.chance(0.4)) {
    makeContainerYard(layout, p, rng);
    return;
  }
  if ((d === 'hillcrest' || d === 'westside') && interior) {
    makeYard(layout, p, rng);
    return;
  }

  let setback: number;
  let height: number;
  let style: FacadeStyle;
  let roof: RoofStyle = 'flat';
  switch (d) {
    case 'downtown': {
      setback = rng.range(1, 2.5);
      const centerFactor = clamp(1 - distCenter / 260, 0, 1);
      height = 38 + rng.range(10, 40) + centerFactor * rng.range(40, 105);
      style = rng.pick(['glassBlue', 'glassTeal', 'office', 'glassBlue'] as const);
      break;
    }
    case 'midtown':
      setback = rng.range(1, 3);
      height = rng.range(12, 42);
      style = rng.pick(['office', 'brick', 'stucco', 'office'] as const);
      break;
    case 'southgate':
      setback = rng.range(1, 3);
      height = rng.range(9, 28);
      style = rng.pick(['brick', 'stucco', 'office', 'brick'] as const);
      break;
    case 'beachfront':
      setback = rng.range(2.5, 5);
      height = rng.chance(0.6) ? rng.range(18, 52) : rng.range(7, 11);
      style = height > 14 ? rng.pick(['hotel', 'stucco', 'hotel'] as const) : 'stucco';
      break;
    case 'docks':
      setback = rng.range(1.5, 3);
      height = rng.range(8, 14);
      style = rng.chance(0.75) ? 'warehouse' : 'brick';
      break;
    case 'westside':
      if (rng.chance(0.55)) {
        setback = rng.range(3, 5);
        height = rng.range(5.5, 8.5);
        style = 'house';
        roof = 'gable';
      } else {
        setback = rng.range(1.5, 3);
        height = rng.range(9, 19);
        style = rng.pick(['stucco', 'brick'] as const);
      }
      break;
    case 'hillcrest':
    default:
      if (rng.chance(0.85)) {
        setback = rng.range(3, 5.5);
        height = rng.range(5.5, 8.5);
        style = 'house';
        roof = 'gable';
      } else {
        setback = rng.range(2, 3);
        height = rng.range(9, 14);
        style = 'stucco';
      }
      break;
  }

  const fp = insetRect(p, setback);
  // Random asymmetric shrink of one side for variety (never grows the footprint).
  if (rectW(fp) > 14 && rng.chance(0.4)) {
    const s = rng.range(0, 3);
    if (rng.chance(0.5)) fp.minX += s;
    else fp.maxX -= s;
  }
  if (rectD(fp) > 14 && rng.chance(0.4)) {
    const s = rng.range(0, 3);
    if (rng.chance(0.5)) fp.minZ += s;
    else fp.maxZ -= s;
  }
  if (rectW(fp) < 6 || rectD(fp) < 6) {
    makeYard(layout, p, rng);
    return;
  }

  const id = layout.buildings.length;
  const tiers: Tier[] = [];
  if (d === 'downtown' && height > 55) {
    const podium = rng.range(10, 16);
    tiers.push({ ...fp, y0: CURB_H, y1: podium });
    const towerInset = Math.min(rng.range(2, 5), Math.min(rectW(fp), rectD(fp)) / 2 - 4);
    const tower = insetRect(fp, Math.max(0.5, towerInset));
    const crownStart = height * rng.range(0.82, 0.92);
    tiers.push({ ...tower, y0: podium, y1: crownStart });
    const crownInset = Math.min(rng.range(1.5, 4), Math.min(rectW(tower), rectD(tower)) / 2 - 3);
    tiers.push({ ...insetRect(tower, Math.max(0.5, crownInset)), y0: crownStart, y1: height });
    if (height > 110 && rng.chance(0.4)) roof = 'helipad';
  } else if ((d === 'midtown' || d === 'beachfront') && height > 26 && rng.chance(0.5)) {
    const split = height * rng.range(0.55, 0.75);
    tiers.push({ ...fp, y0: CURB_H, y1: split });
    const inset = Math.min(rng.range(1.5, 3.5), Math.min(rectW(fp), rectD(fp)) / 2 - 3);
    tiers.push({ ...insetRect(fp, Math.max(0.5, inset)), y0: split, y1: height });
  } else {
    tiers.push({ ...fp, y0: CURB_H, y1: height });
  }

  const b: Building = {
    id,
    rect: fp,
    height,
    tiers,
    style,
    roof,
    tint: rng.next(),
    district: d,
    roofProps: [],
    sign: null,
    special: null,
    ground: 'none',
    groundH: 0,
    groundSides: [],
  };
  addRoofProps(b, rng);
  layout.buildings.push(b);

  // Front yards for houses get a tree or bush.
  if (style === 'house') {
    layout.ground.push({ rect: p, kind: 'yard' });
    if (rng.chance(0.6)) {
      const tx = rng.chance(0.5) ? p.minX + 1.6 : p.maxX - 1.6;
      const tz = rng.chance(0.5) ? p.minZ + 1.6 : p.maxZ - 1.6;
      if (!rectContains(fp, tx, tz, 1.2)) addProp(layout, 'tree', tx, tz, rng.range(0, 6.28), rng.range(0.7, 1.05));
    }
  } else if (d === 'docks') {
    layout.ground.push({ rect: p, kind: 'dirt' });
  } else {
    layout.ground.push({ rect: p, kind: 'plaza' });
  }
  // Leftover space between building and parcel edge is a good collectible spot.
  if (setback >= 2.5) layout.openSpots.push({ x: (p.minX + fp.minX) / 2, z: rectCZ(p), district: d });
}

function addRoofProps(b: Building, rng: Rng): void {
  const top = b.tiers[b.tiers.length - 1]!;
  const w = rectW(top);
  const d = rectD(top);
  if (b.roof === 'gable') return;
  if (b.roof === 'helipad') {
    b.roofProps.push({ kind: 'helipad', x: rectCX(top), z: rectCZ(top), y: top.y1, w: Math.min(w, d) * 0.8, d: Math.min(w, d) * 0.8, h: 0.2, rot: 0 });
    return;
  }
  const count = Math.floor(rng.range(1, 4) * Math.min(1, (w * d) / 300));
  for (let i = 0; i < count; i++) {
    const kind: RoofPropKind = b.district === 'downtown' && rng.chance(0.3) ? 'antenna' : rng.chance(0.3) ? 'tank' : 'ac';
    const sw = kind === 'tank' ? 2.6 : kind === 'antenna' ? 0.5 : rng.range(1.6, 3);
    const sd = kind === 'tank' ? 2.6 : kind === 'antenna' ? 0.5 : rng.range(1.2, 2.2);
    const sh = kind === 'tank' ? 3.5 : kind === 'antenna' ? rng.range(6, 18) : rng.range(1, 1.8);
    if (w < sw + 2 || d < sd + 2) continue;
    b.roofProps.push({
      kind,
      x: rng.range(top.minX + sw / 2 + 0.8, top.maxX - sw / 2 - 0.8),
      z: rng.range(top.minZ + sd / 2 + 0.8, top.maxZ - sd / 2 - 0.8),
      y: top.y1,
      w: sw,
      d: sd,
      h: sh,
      rot: 0,
    });
  }
  if ((b.district === 'midtown' || b.district === 'southgate') && b.height < 30 && w > 10 && rng.chance(0.18)) {
    b.roofProps.push({ kind: 'billboard', x: rectCX(top), z: rectCZ(top), y: top.y1, w: Math.min(12, w - 2), d: 0.4, h: 5, rot: rng.chance(0.5) ? 0 : Math.PI / 2 });
  }
}

function specialBuilding(id: number, parcel: Rect, def: SpecialDef, district: District, rng: Rng): Building {
  const fp = insetRect(parcel, 1.2);
  let height = 12;
  let style: FacadeStyle = 'office';
  let roof: RoofStyle = 'flat';
  let sign: Building['sign'] = null;
  switch (def.kind) {
    case 'safehouse':
      height = 7.5;
      style = 'house';
      roof = 'gable';
      break;
    case 'hospital':
      height = 30;
      style = 'stucco';
      roof = 'helipad';
      sign = { text: 'HOSPITAL', color: '#e03434', side: def.side };
      break;
    case 'police':
      height = 18;
      style = 'office';
      sign = { text: 'POLICE', color: '#2f6bff', side: def.side };
      break;
    case 'gunshop':
      height = 8;
      style = 'brick';
      sign = { text: 'BANG BANG GUNS', color: '#ff8a1f', side: def.side };
      break;
    case 'bank':
      height = 26;
      style = 'office';
      sign = { text: 'FIRST AZURA BANK', color: '#f5c542', side: def.side };
      break;
    default:
      break;
  }
  const tower = def.build?.type === 'tower' ? def.build : null;
  if (tower) {
    height = tower.height;
    style = tower.style;
    roof = tower.roof;
    sign = { text: tower.sign.text, color: tower.sign.color, side: def.side };
  }
  const tiers: Tier[] = [];
  if (tower) {
    tiers.push({ ...fp, y0: CURB_H, y1: tower.podium });
    const t = insetRect(fp, Math.min(3, Math.min(rectW(fp), rectD(fp)) / 2 - 4));
    tiers.push({ ...t, y0: tower.podium, y1: tower.shaft });
    tiers.push({ ...insetRect(t, Math.min(2.5, Math.min(rectW(t), rectD(t)) / 2 - 3)), y0: tower.shaft, y1: height });
  } else {
    tiers.push({ ...fp, y0: CURB_H, y1: height });
  }
  const b: Building = { id, rect: fp, height, tiers, style, roof, tint: rng.next(), district, roofProps: [], sign, special: def.kind, ground: 'none', groundH: 0, groundSides: [] };
  addRoofProps(b, rng);
  return b;
}

function makeParkingLot(layout: CityLayout, p: Rect, rng: Rng): void {
  layout.ground.push({ rect: p, kind: 'parking' });
  // A row of spots along the longer axis, cars facing inward.
  const w = rectW(p);
  const d = rectD(p);
  const spacing = 3.2;
  if (w >= d) {
    const count = Math.floor((w - 4) / spacing);
    for (let i = 0; i < count; i++) {
      const x = p.minX + 2 + spacing * (i + 0.5);
      layout.parking.push({ x, z: p.minZ + 3.2, heading: 0 });
      if (d > 22) layout.parking.push({ x, z: p.maxZ - 3.2, heading: Math.PI });
    }
  } else {
    const count = Math.floor((d - 4) / spacing);
    for (let i = 0; i < count; i++) {
      const z = p.minZ + 2 + spacing * (i + 0.5);
      layout.parking.push({ x: p.minX + 3.2, z, heading: Math.PI / 2 });
      if (w > 22) layout.parking.push({ x: p.maxX - 3.2, z, heading: -Math.PI / 2 });
    }
  }
  if (rng.chance(0.5)) addProp(layout, 'lamp', rectCX(p), rectCZ(p), 0, 1);
  layout.openSpots.push({ x: rectCX(p) + 2, z: rectCZ(p) + 2, district: 'midtown' });
}

function makeContainerYard(layout: CityLayout, p: Rect, rng: Rng): void {
  layout.ground.push({ rect: p, kind: 'dirt' });
  const colors = [0xc0392b, 0x2471a3, 0x1e8449, 0xd68910, 0x7d3c98, 0x839192, 0xa04000];
  const len = 12.2;
  const wid = 2.45;
  const hgt = 2.6;
  const alongX = rectW(p) >= rectD(p);
  const rows = Math.floor(((alongX ? rectD(p) : rectW(p)) - 6) / 6);
  const perRow = Math.floor(((alongX ? rectW(p) : rectD(p)) - 4) / (len + 1.5));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < perRow; c++) {
      if (rng.chance(0.2)) continue;
      const stack = rng.int(1, 3);
      const a = (alongX ? p.minX : p.minZ) + 2 + c * (len + 1.5) + len / 2;
      const b = (alongX ? p.minZ : p.minX) + 4 + r * 6 + wid / 2;
      const x = alongX ? a : b;
      const z = alongX ? b : a;
      for (let s = 0; s < stack; s++) {
        layout.props.push({
          kind: 'container',
          x,
          z,
          y: CURB_H + s * hgt,
          rot: alongX ? Math.PI / 2 : 0,
          scale: 1,
          color: rng.pick(colors),
          w: alongX ? len : wid,
          d: alongX ? wid : len,
          h: hgt,
          node: -1,
          dir: -1,
        });
      }
    }
  }
  layout.openSpots.push({ x: p.maxX - 1.5, z: p.maxZ - 1.5, district: 'docks' });
}

function makeYard(layout: CityLayout, p: Rect, rng: Rng): void {
  layout.ground.push({ rect: p, kind: 'grass' });
  const cx = rectCX(p);
  const cz = rectCZ(p);
  const count = Math.floor((rectW(p) * rectD(p)) / 120);
  for (let i = 0; i < count; i++) {
    const x = rng.range(p.minX + 2, p.maxX - 2);
    const z = rng.range(p.minZ + 2, p.maxZ - 2);
    // Keep the yard centre free: it is reserved for pickups and collectibles.
    if ((x - cx) ** 2 + (z - cz) ** 2 < 3 * 3) continue;
    addProp(layout, rng.chance(0.7) ? 'tree' : 'bush', x, z, rng.range(0, 6.28), rng.range(0.7, 1.1));
  }
  layout.openSpots.push({ x: cx, z: cz, district: 'hillcrest' });
}

function buildPark(layout: CityLayout, block: Block, rng: Rng): void {
  const lot = block.lot;
  const cx = rectCX(lot);
  const cz = rectCZ(lot);
  // Cross-shaped paths with a fountain in the middle; ground patches never overlap.
  const pw = 2.5;
  layout.ground.push({ rect: mkRect(lot.minX, lot.minZ, cx - pw, cz - pw), kind: 'grass' });
  layout.ground.push({ rect: mkRect(cx + pw, lot.minZ, lot.maxX, cz - pw), kind: 'grass' });
  layout.ground.push({ rect: mkRect(lot.minX, cz + pw, cx - pw, lot.maxZ), kind: 'grass' });
  layout.ground.push({ rect: mkRect(cx + pw, cz + pw, lot.maxX, lot.maxZ), kind: 'grass' });
  layout.ground.push({ rect: mkRect(cx - pw, lot.minZ, cx + pw, lot.maxZ), kind: 'plaza' });
  layout.ground.push({ rect: mkRect(lot.minX, cz - pw, cx - pw, cz + pw), kind: 'plaza' });
  layout.ground.push({ rect: mkRect(cx + pw, cz - pw, lot.maxX, cz + pw), kind: 'plaza' });
  addProp(layout, 'fountain', cx, cz, 0, 1);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    addProp(layout, 'bench', cx + Math.cos(a) * 7.5, cz + Math.sin(a) * 7.5, -a + Math.PI / 2, 1);
  }
  // Trees in the four quadrants, away from the paths.
  const quads: Rect[] = [
    mkRect(lot.minX + 2, lot.minZ + 2, cx - 5, cz - 5),
    mkRect(cx + 5, lot.minZ + 2, lot.maxX - 2, cz - 5),
    mkRect(lot.minX + 2, cz + 5, cx - 5, lot.maxZ - 2),
    mkRect(cx + 5, cz + 5, lot.maxX - 2, lot.maxZ - 2),
  ];
  for (const q of quads) {
    const spot = { x: rectCX(q), z: q.minZ + 1.5 };
    const count = Math.floor((rectW(q) * rectD(q)) / 70);
    const placed: { x: number; z: number }[] = [];
    for (let i = 0; i < count * 3 && placed.length < count; i++) {
      const x = rng.range(q.minX, q.maxX);
      const z = rng.range(q.minZ, q.maxZ);
      if (placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 25)) continue;
      if ((spot.x - x) ** 2 + (spot.z - z) ** 2 < 3 * 3) continue;
      placed.push({ x, z });
      addProp(layout, rng.chance(0.8) ? 'tree' : 'bush', x, z, rng.range(0, 6.28), rng.range(0.85, 1.35));
    }
    layout.openSpots.push({ ...spot, district: 'park' });
  }
}

/** Towers at either end of the block and an open square between them, with a fountain, trees and benches. */
function buildPlaza(layout: CityLayout, block: Block, rng: Rng, reserved: Rect[]): void {
  const lot = block.lot;
  const sq = mkRect(rectCX(lot) - 34, lot.minZ, rectCX(lot) + 34, lot.maxZ);
  buildBlock(layout, block, rng, [], reserved, [mkRect(lot.minX, lot.minZ, sq.minX, lot.maxZ), mkRect(sq.maxX, lot.minZ, lot.maxX, lot.maxZ)]);
  const cx = rectCX(sq);
  const cz = rectCZ(sq);
  // Paving round the edge and across the middle, two lawns north and south of the fountain (patches never overlap).
  const inner = mkRect(sq.minX + 10, sq.minZ + 8, sq.maxX - 10, sq.maxZ - 8);
  const lawnN = mkRect(inner.minX, inner.minZ, inner.maxX, cz - 14);
  const lawnS = mkRect(inner.minX, cz + 14, inner.maxX, inner.maxZ);
  layout.ground.push({ rect: lawnN, kind: 'grass' }, { rect: lawnS, kind: 'grass' });
  layout.ground.push(
    { rect: mkRect(sq.minX, sq.minZ, sq.maxX, inner.minZ), kind: 'plaza' },
    { rect: mkRect(sq.minX, inner.maxZ, sq.maxX, sq.maxZ), kind: 'plaza' },
    { rect: mkRect(sq.minX, inner.minZ, inner.minX, inner.maxZ), kind: 'plaza' },
    { rect: mkRect(inner.maxX, inner.minZ, sq.maxX, inner.maxZ), kind: 'plaza' },
    { rect: mkRect(inner.minX, lawnN.maxZ, inner.maxX, lawnS.minZ), kind: 'plaza' },
  );
  for (const lawn of [lawnN, lawnS]) {
    for (const [fx, fz] of [[0.25, 0.5], [0.75, 0.5]] as const) {
      addProp(layout, 'tree', lawn.minX + rectW(lawn) * fx, lawn.minZ + rectD(lawn) * fz, rng.range(0, 6.28), rng.range(1.1, 1.35));
    }
  }
  addProp(layout, 'fountain', cx, cz, 0, 1);
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    addProp(layout, 'bench', cx + Math.cos(a) * 11, cz + Math.sin(a) * 11, -a + Math.PI / 2, 1);
  }
  // Two rows of trees along the square, and lamps between them.
  for (const x of [sq.minX + 5, sq.maxX - 5]) {
    for (let z = sq.minZ + 6; z <= sq.maxZ - 6; z += 11) addProp(layout, 'tree', x, z, rng.range(0, 6.28), rng.range(0.85, 1.1));
    for (let z = sq.minZ + 11.5; z <= sq.maxZ - 11.5; z += 22) addProp(layout, 'lamp', x + (x < cx ? 4 : -4), z, x < cx ? Math.PI / 2 : -Math.PI / 2, 1);
  }
  layout.openSpots.push({ x: cx, z: sq.minZ + 4, district: block.district });
  layout.openSpots.push({ x: cx, z: sq.maxZ - 4, district: block.district });
}

function buildStadium(layout: CityLayout, block: Block, rng: Rng): void {
  const lot = block.lot;
  // The bowl in the middle, a car park at either end.
  const bowlW = Math.min(rectW(lot) - 50, 1.45 * rectD(lot));
  const bowl = mkRect(rectCX(lot) - bowlW / 2, lot.minZ, rectCX(lot) + bowlW / 2, lot.maxZ);
  layout.ground.push({ rect: bowl, kind: 'plaza' });
  for (const side of [mkRect(lot.minX, lot.minZ, bowl.minX, lot.maxZ), mkRect(bowl.maxX, lot.minZ, lot.maxX, lot.maxZ)]) makeParkingLot(layout, side, rng);
  const fp = insetRect(bowl, 5);
  layout.stadium = fp;
  const stadium: Building = {
    id: layout.buildings.length,
    rect: fp,
    height: 22,
    tiers: [{ ...fp, y0: CURB_H, y1: 22 }],
    style: 'office',
    roof: 'flat',
    tint: 0.5,
    district: 'southgate',
    roofProps: [],
    sign: { text: 'AZURA BOWL', color: '#ff4fa3', side: 'N' },
    special: 'stadium',
    ground: 'none',
    groundH: 0,
    groundSides: [],
  };
  layout.buildings.push(stadium);
  layout.openSpots.push({ x: lot.minX + 2.5, z: lot.minZ + 2.5, district: 'southgate' });
}

// ---------------------------------------------------------------------------
// Ground floors. A pure post-pass over the finished layout: it draws only from its own
// per-building generators, so the shared rng sequence, and with it every rect, tier, prop,
// POI and parking spot, is exactly what it would be without it.

/** Ground-floor band heights above CURB_H, in metres. */
export const GROUND_H = { shops: 4.5, lobbyMin: 6, lobbyMax: 7, house: 3, loading: 5 } as const;

/** Deterministic 32-bit hash of a few integers (murmur3 mixing). */
export function hashInts(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    let k = Math.imul(x | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= xs.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The block whose lot holds a building (every building stands inside one lot). */
export function blockOf(layout: CityLayout, b: Building): Block | null {
  const cx = rectCX(b.rect);
  const cz = rectCZ(b.rect);
  return layout.blocks.find((bl) => rectContains(bl.lot, cx, cz)) ?? null;
}

/**
 * The street frontage of every building: the sides of its first tier with nothing (no other
 * building, no garage) between them and the lot edge. That is every street-facing wall (one
 * standing within 10 m of the lot edge: parcels are at least 16 m deep, so nothing fits in
 * front of those), plus walls that look across open ground (a parking lot, plaza or yard) all
 * the way to the street.
 */
export function frontages(layout: CityLayout): Map<Building, { block: Block; sides: Side[] }> {
  const byBlock = new Map<Block, Building[]>();
  for (const b of layout.buildings) {
    const block = blockOf(layout, b);
    if (!block) continue;
    const list = byBlock.get(block);
    if (list) list.push(b);
    else byBlock.set(block, [b]);
  }
  const out = new Map<Building, { block: Block; sides: Side[] }>();
  for (const [block, list] of byBlock) {
    const lot = block.lot;
    const garages = layout.garages.filter((g) => rectsOverlap(g.rect, lot)).map((g) => g.rect);
    for (const b of list) {
      const t = b.tiers[0];
      if (!t) continue;
      const blockers = [...list.filter((o) => o !== b).map((o) => o.rect), ...garages];
      const m = 0.5;
      const sides: Side[] = [];
      for (const side of ['S', 'E', 'N', 'W'] as const) {
        const corridor =
          side === 'S' ? mkRect(t.minX + m, t.maxZ, t.maxX - m, lot.maxZ)
          : side === 'E' ? mkRect(t.maxX, t.minZ + m, lot.maxX, t.maxZ - m)
          : side === 'N' ? mkRect(t.minX + m, lot.minZ, t.maxX - m, t.minZ)
          : mkRect(lot.minX, t.minZ + m, t.minX, t.maxZ - m);
        if (!blockers.some((r) => rectsOverlap(r, corridor))) sides.push(side);
      }
      out.set(b, { block, sides });
    }
  }
  return out;
}

function assignGroundFloors(layout: CityLayout): void {
  const front = frontages(layout);
  for (const b of layout.buildings) {
    const f = front.get(b);
    const t0 = b.tiers[0];
    if (!f || !t0 || f.sides.length === 0) continue;
    const rng = new Rng(hashInts(layout.seed, b.id));
    const special = b.special;
    let ground: GroundFloor;
    let h: number;
    if (special === 'bank' || special === 'police' || special === 'hospital' || (special !== null && TOWER_KINDS.has(special)) || special === 'stadium' || (!special && b.district === 'downtown')) {
      ground = 'lobby';
      h = rng.range(GROUND_H.lobbyMin, GROUND_H.lobbyMax);
    } else if (special === 'safehouse' || b.style === 'house') {
      ground = 'house';
      h = GROUND_H.house;
    } else if (b.district === 'docks') {
      ground = 'loading';
      h = GROUND_H.loading;
    } else {
      // Gun shops, and the apartment and office blocks of midtown, southgate, beachfront,
      // westside and hillcrest: a row of shops.
      ground = 'shops';
      h = GROUND_H.shops;
    }
    // Always leave a real upper storey above the band.
    b.ground = ground;
    b.groundH = Math.min(h, (t0.y1 - t0.y0) * 0.6);
    b.groundSides = f.sides;
  }
}

// ---------------------------------------------------------------------------
// Street furniture

export function addProp(layout: CityLayout, kind: PropKind, x: number, z: number, rot: number, scale: number, y = CURB_H): Prop {
  const p: Prop = { kind, x, z, y, rot, scale, color: 0, w: 0, d: 0, h: 0, node: -1, dir: -1 };
  layout.props.push(p);
  return p;
}

function inReserved(reserved: Rect[], x: number, z: number): boolean {
  return reserved.some((r) => rectContains(r, x, z));
}

function buildStreetFurniture(layout: CityLayout, rng: Rng, reserved: Rect[]): void {
  const { vLines, hLines, n } = layout;
  const cornerClear = CROSSWALK_W + 4;

  for (const block of layout.blocks) {
    const r = block.rect;
    const d = block.district;
    const sides: Array<{ side: Side; ax: number; az: number; bx: number; bz: number; nx: number; nz: number; avenue: boolean }> = [
      { side: 'N', ax: r.minX, az: r.minZ, bx: r.maxX, bz: r.minZ, nx: 0, nz: 1, avenue: hLines[block.bj]!.avenue },
      { side: 'S', ax: r.minX, az: r.maxZ, bx: r.maxX, bz: r.maxZ, nx: 0, nz: -1, avenue: hLines[block.bj2 + 1]!.avenue },
      { side: 'W', ax: r.minX, az: r.minZ, bx: r.minX, bz: r.maxZ, nx: 1, nz: 0, avenue: vLines[block.bi]!.avenue },
      { side: 'E', ax: r.maxX, az: r.minZ, bx: r.maxX, bz: r.maxZ, nx: -1, nz: 0, avenue: vLines[block.bi2 + 1]!.avenue },
    ];
    for (const s of sides) {
      const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
      const ux = (s.bx - s.ax) / len;
      const uz = (s.bz - s.az) / len;
      // Facing the street: opposite of the inward normal.
      const faceRot = Math.atan2(-s.nx, -s.nz);
      const lampSpacing = 26;
      const lampCount = Math.max(1, Math.floor((len - 2 * cornerClear) / lampSpacing) + 1);
      const span = (lampCount - 1) * lampSpacing;
      const start = (len - span) / 2;
      const used: number[] = [];
      for (let i = 0; i < lampCount; i++) {
        const t = start + i * lampSpacing;
        const x = s.ax + ux * t + s.nx * PROP_INSET;
        const z = s.az + uz * t + s.nz * PROP_INSET;
        if (inReserved(reserved, x, z)) continue;
        addProp(layout, 'lamp', x, z, faceRot, 1);
        used.push(t);
      }
      // Trees / palms between the lamps.
      const treeKind: PropKind | null =
        d === 'beachfront' || (s.side === 'E' && block.bi2 === n - 1) ? 'palm' : d === 'docks' ? null : s.avenue || d === 'hillcrest' || d === 'downtown' || d === 'park' ? 'tree' : null;
      if (treeKind) {
        for (let i = 0; i < lampCount - 1; i++) {
          const t = start + (i + 0.5) * lampSpacing;
          if (rng.chance(treeKind === 'palm' ? 0.95 : 0.75)) {
            const x = s.ax + ux * t + s.nx * (PROP_INSET + 0.2);
            const z = s.az + uz * t + s.nz * (PROP_INSET + 0.2);
            if (inReserved(reserved, x, z)) continue;
            addProp(layout, treeKind, x, z, rng.range(0, 6.28), rng.range(0.8, 1.1));
            used.push(t);
          }
        }
      }
      // One hydrant, a bin or a bench per side, away from other furniture.
      for (const kind of ['hydrant', rng.chance(0.5) ? 'bin' : 'bench'] as const) {
        for (let tries = 0; tries < 6; tries++) {
          const t = rng.range(cornerClear, len - cornerClear);
          if (used.some((u) => Math.abs(u - t) < 4)) continue;
          const inset = kind === 'hydrant' ? PROP_INSET : SIDEWALK_W - 0.55;
          const x = s.ax + ux * t + s.nx * inset;
          const z = s.az + uz * t + s.nz * inset;
          if (inReserved(reserved, x, z)) continue;
          addProp(layout, kind, x, z, kind === 'bench' ? faceRot : 0, 1);
          used.push(t);
          break;
        }
      }
    }
  }

  // Traffic signals at every intersection with three or more roads.
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const roads = [0, 1, 2, 3].map((d) => roadFrom(layout, i, j, d));
      if (roads.filter(Boolean).length < 3) continue;
      const node = j * (n + 1) + i;
      const x = vLines[i]!.pos;
      const z = hLines[j]!.pos;
      const hw = vLines[i]!.width / 2;
      const hh = hLines[j]!.width / 2;
      // dir: 0 N (moving -z, arrives from the south), 1 E, 2 S, 3 W
      const approaches = [
        { dir: 0, exists: roads[2]!, px: x + hw + PROP_INSET, pz: z + hh + PROP_INSET },
        { dir: 2, exists: roads[0]!, px: x - hw - PROP_INSET, pz: z - hh - PROP_INSET },
        { dir: 1, exists: roads[3]!, px: x - hw - PROP_INSET, pz: z + hh + PROP_INSET },
        { dir: 3, exists: roads[1]!, px: x + hw + PROP_INSET, pz: z - hh - PROP_INSET },
      ];
      for (const a of approaches) {
        if (!a.exists) continue;
        // The head faces the approaching traffic (opposite to travel direction).
        const travel = DIR_VECTORS[a.dir]!;
        const p = addProp(layout, 'signal', a.px, a.pz, Math.atan2(-travel.x, -travel.z), 1);
        p.node = node;
        p.dir = a.dir;
      }
    }
  }
}

export const DIR_VECTORS: ReadonlyArray<{ x: number; z: number }> = [
  { x: 0, z: -1 },
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
];

// ---------------------------------------------------------------------------
// Coast: promenade, beach, piers, docks, landmarks

function buildCoast(layout: CityLayout, rng: Rng): void {
  const b = layout.bounds;
  const { cityMinX, cityMaxX, cityMinZ, cityMaxZ, landMinX, landMinZ, landMaxZ, beachStartX, beachEndX } = b;

  // Promenade lamps, trees and benches (W, N, S strips). Keep the middle lane clear for ramps.
  const strips: Array<{ ax: number; az: number; bx: number; bz: number; ox: number; oz: number }> = [
    { ax: landMinX, az: landMinZ, bx: landMinX, bz: landMaxZ, ox: 1, oz: 0 }, // west, outward edge at landMinX
    { ax: landMinX, az: landMinZ, bx: beachStartX, bz: landMinZ, ox: 0, oz: 1 }, // north
    { ax: landMinX, az: landMaxZ, bx: beachStartX, bz: landMaxZ, ox: 0, oz: -1 }, // south
  ];
  for (const s of strips) {
    const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
    const ux = (s.bx - s.ax) / len;
    const uz = (s.bz - s.az) / len;
    for (let t = 30; t < len - 30; t += 30) {
      const px = s.ax + ux * t;
      const pz = s.az + uz * t;
      // Seaward railing lamps.
      addProp(layout, 'lamp', px + s.ox * 1.2, pz + s.oz * 1.2, Math.atan2(s.ox, s.oz), 1);
      // Inner tree row near the ring road sidewalk.
      if (rng.chance(0.8)) addProp(layout, 'tree', px + s.ox * (PROMENADE_W - SIDEWALK_W - 3) + ux * 15, pz + s.oz * (PROMENADE_W - SIDEWALK_W - 3) + uz * 15, rng.range(0, 6.28), rng.range(0.85, 1.15));
      if (rng.chance(0.5)) addProp(layout, 'bench', px + s.ox * 2.6 + ux * 7, pz + s.oz * 2.6 + uz * 7, Math.atan2(-s.ox, -s.oz), 1);
    }
  }
  layout.openSpots.push({ x: landMinX + 4, z: 0, district: 'westside' });
  layout.openSpots.push({ x: 0, z: landMinZ + 4, district: 'hillcrest' });

  // Boardwalk palms along the east coast.
  for (let z = landMinZ + 20; z < landMaxZ - 20; z += 18) {
    addProp(layout, 'palm', beachStartX - 2.2, z, rng.range(0, 6.28), rng.range(0.9, 1.2));
  }
  // The pier and the marina deck span the whole beach.
  const pierZ = (cityMinZ + cityMaxZ) / 2 + 40;
  const pierRect = mkRect(beachStartX - 1, pierZ - 7, beachEndX + 90, pierZ + 7);
  const marinaZ = landMaxZ - 70;
  const marinaMain = mkRect(beachStartX - 1, marinaZ - 5, beachEndX + 60, marinaZ + 5);
  // Scattered beach palms on dry sand, seaward of the ramp corridor (x in [start+15, start+29]) and
  // of the collectible spots at start+30, at least 0.15 m above the water.
  const dryEnd = beachOffsetAt(WATER_Y + 0.15);
  for (let i = 0; i < 26; i++) {
    const x = beachStartX + rng.range(31.5, dryEnd);
    const z = rng.range(landMinZ + 30, landMaxZ - 30);
    const rot = rng.range(0, 6.28);
    const scale = rng.range(0.9, 1.3);
    if (rectContains(pierRect, x, z, 1.5) || rectContains(marinaMain, x, z, 1.5)) continue;
    addProp(layout, 'palm', x, z, rot, scale, sandHeight(b, x));
  }

  // Azura Pier with a Ferris wheel (centre of the beach) and the marina piers (south).
  layout.decks.push({ rect: pierRect, y: 0.45, name: 'Azura Pier', bridge: false });
  addProp(layout, 'ferris', beachEndX + 70, pierZ, Math.PI / 2, 1, 0.45);
  // Railing lamps along both edges, their heads over the deck.
  for (let x = beachStartX + 20; x < beachEndX + 85; x += 22) {
    addProp(layout, 'lamp', x, pierZ - 6.2, 0, 1, 0.45);
    addProp(layout, 'lamp', x, pierZ + 6.2, Math.PI, 1, 0.45);
  }
  layout.openSpots.push({ x: beachEndX + 50, z: pierZ + 3, district: 'beachfront' });

  layout.decks.push({ rect: marinaMain, y: 0.45, name: 'Marina', bridge: false });
  for (let k = 0; k < 3; k++) {
    const x = beachEndX - 10 + k * 26;
    layout.decks.push({ rect: mkRect(x - 2, marinaZ + 5, x + 2, marinaZ + 34), y: 0.45, name: 'Marina', bridge: false });
    const boat = addProp(layout, 'boat', x + 6, marinaZ + 20, 0, 1, -1.0);
    boat.color = rng.pick([0xffffff, 0xe8e2d0, 0x1f4e79, 0xb03a2e]);
  }
  layout.pois.push({ id: 'marina', kind: 'marina', name: 'Marina', x: beachEndX + 52, z: marinaZ, heading: Math.PI / 2, bay: null, block: -1 });

  // Dock cranes on the wharf between the docks' last street and Port Basin, boats moored in the basin.
  const dockSt = layout.hLines[layout.n - 1]!;
  const wharf = dockSt.pos + dockSt.width / 2 + 10;
  for (let k = 0; k < 3; k++) addProp(layout, 'crane', cityMinX + 30 + k * 60, wharf, 0, 1);
  for (let k = 0; k < 4; k++) {
    const boat = addProp(layout, 'boat', cityMinX + 10 + k * 46, wharf + 40 + (k % 2) * 16, 0, 1, -1.0);
    boat.color = rng.pick([0xffffff, 0xe8e2d0, 0x1f4e79, 0xb03a2e]);
  }

  // Billboards on the promenade facing the ring roads, 9 m inland of the stunt ramp lines
  // (the promenade ramps sit at landMin + 15) so cars landing a jump do not run into the posts.
  addProp(layout, 'billboard', cityMinX - 10, (cityMinZ + cityMaxZ) / 2 - 120, Math.PI / 2, 1);
  addProp(layout, 'billboard', (cityMinX + cityMaxX) / 2 + 60, cityMinZ - 10, 0, 1);
  addProp(layout, 'billboard', (cityMinX + cityMaxX) / 2 - 150, cityMaxZ + 10, Math.PI, 1);

  // Beach collectibles, just seaward of the ramp corridor where the sand is still dry.
  layout.openSpots.push({ x: beachStartX + 30, z: landMinZ + 60, district: 'beachfront' });
  layout.openSpots.push({ x: beachStartX + 30, z: landMaxZ - 120, district: 'beachfront' });

  buildPoint(layout, rng);
}

/** Azura Point: lawns either side of a path out to the lighthouse, trees, benches and lamps along it. */
function buildPoint(layout: CityLayout, rng: Rng): void {
  const [base, tip] = layout.headlands.find((h) => h.name === 'Azura Point')!.rects as [Rect, Rect];
  const cx = rectCX(tip);
  const yard = mkRect(cx - 9, tip.minZ + 4, cx + 9, tip.minZ + 22);
  const path = mkRect(cx - 2.5, yard.maxZ, cx + 2.5, base.maxZ);
  for (const r of rectsMinus([base, tip], [yard, path])) layout.ground.push({ rect: r, kind: 'grass' });
  layout.ground.push({ rect: yard, kind: 'plaza' }, { rect: path, kind: 'plaza' });
  addProp(layout, 'lighthouse', cx, yard.minZ + 7, 0, 1);
  for (let z = path.maxZ - 10, k = 0; z > path.minZ + 4; z -= 16, k++) {
    const side = k % 2 === 0 ? -1 : 1;
    addProp(layout, 'bench', cx + side * 4.2, z, side < 0 ? Math.PI / 2 : -Math.PI / 2, 1);
    addProp(layout, 'lamp', cx - side * 3.6, z - 8, side < 0 ? -Math.PI / 2 : Math.PI / 2, 1);
  }
  for (const r of [base, tip]) {
    const count = Math.floor((rectW(r) * rectD(r)) / 160);
    for (let i = 0; i < count; i++) {
      const x = rng.range(r.minX + 3, r.maxX - 3);
      const z = rng.range(r.minZ + 3, r.maxZ - 3);
      if (Math.abs(x - cx) < 7 || rectContains(yard, x, z, 4)) continue;
      addProp(layout, rng.chance(0.75) ? 'tree' : 'bush', x, z, rng.range(0, 6.28), rng.range(0.8, 1.2));
    }
  }
  layout.openSpots.push({ x: cx + 6, z: yard.maxZ + 2, district: 'park' }, { x: base.minX + 8, z: rectCZ(base), district: 'park' });
}

/** Height of the sloping beach sand at x (independent of z). */
export function sandHeight(b: Bounds, x: number): number {
  const t = (x - b.beachStartX) / BEACH_W;
  return CURB_H - t * SAND_DROP;
}

/** Distance from the beach start at which the sand is at height y (inverse of sandHeight). */
export function beachOffsetAt(y: number): number {
  return (BEACH_W * (CURB_H - y)) / SAND_DROP;
}

// ---------------------------------------------------------------------------
// Stunt ramps

function buildRamps(layout: CityLayout): void {
  const b = layout.bounds;
  const addRamp = (x: number, z: number, heading: number, height = 2.4) =>
    layout.ramps.push({ id: layout.ramps.length, x, z, heading, length: 11, width: 6.5, height });
  // Beach, launching south and north along the sand.
  addRamp(b.beachStartX + 22, b.landMinZ + 150, 0, 2.6);
  addRamp(b.beachStartX + 22, b.landMaxZ - 190, Math.PI, 2.6);
  // West promenade by the docks, between Pelican Harbor and Port Basin, launching north.
  addRamp(b.landMinX + 15, 290, Math.PI, 2.2);
  // North promenade below Hillcrest Green, between Gull Bay and Northshore Bay, launching east.
  addRamp(62, b.landMinZ + 15, Math.PI / 2, 2.2);
  // South promenade near the docks, launching west.
  addRamp(120, b.landMaxZ - 15, -Math.PI / 2, 2.2);
}

function removePropsInRamps(layout: CityLayout): void {
  // Keep a corridor of 90 m in front of and 50 m behind each ramp free of props.
  const blocked = (x: number, z: number) =>
    layout.ramps.some((r) => {
      const fx = Math.sin(r.heading);
      const fz = Math.cos(r.heading);
      const dx = x - r.x;
      const dz = z - r.z;
      const along = dx * fx + dz * fz;
      const side = Math.abs(dx * fz - dz * fx);
      return along > -55 && along < 95 && side < 7;
    });
  layout.props = layout.props.filter((p) => p.kind === 'signal' || !blocked(p.x, p.z));
}
