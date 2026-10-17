// Deterministic procedural layout of San Azura: road grid, districts, parcels,
// buildings, street furniture, points of interest, beach, piers and ramps.
// Pure data, no rendering; consumed by the static world, the simulation and the renderer.

import { Rng } from '../core/rng';
import { clamp } from '../core/math';
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
export type PoiKind = 'safehouse' | 'hospital' | 'police' | 'spray' | 'gunshop' | 'bank' | 'contactLou' | 'contactDex' | 'marina';
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
  bi: number;
  bj: number;
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

// ---------------------------------------------------------------------------
// Static design data

const COL_SIZES = [88, 84, 84, 76, 72, 72, 76, 84, 88, 92];
const ROW_SIZES = [92, 88, 84, 76, 72, 72, 76, 84, 88, 92];
const AVENUES = new Set([0, 2, 5, 8, 10]);
const V_NAMES = ['Harbor Blvd', 'Palmetto St', 'Vista Ave', 'Cortez St', 'Marlin St', 'Azura Ave', 'Coral St', 'Delgado St', 'Sunset Ave', 'Reef St', 'Ocean Dr'];
const H_NAMES = ['Northshore Blvd', 'Hillcrest Rd', 'Magnolia Ave', 'Elm St', 'Union St', 'Central Ave', 'Market St', 'Canal St', 'Southgate Ave', 'Dock St', 'Seaview Blvd'];

const PARKS: ReadonlyArray<{ bi: number; bj: number; name: string }> = [
  { bi: 7, bj: 5, name: 'Azura Park' },
  { bi: 6, bj: 0, name: 'Hillcrest Green' },
  { bi: 4, bj: 8, name: 'Southgate Square' },
];

interface SpecialDef {
  id: string;
  kind: PoiKind;
  bi: number;
  bj: number;
  side: Side;
  name: string;
}

export const SPECIALS: readonly SpecialDef[] = [
  { id: 'safehouse', kind: 'safehouse', bi: 4, bj: 1, side: 'S', name: 'Safehouse' },
  { id: 'hospital', kind: 'hospital', bi: 7, bj: 2, side: 'S', name: 'San Azura General' },
  { id: 'police', kind: 'police', bi: 2, bj: 4, side: 'E', name: 'SAPD Central' },
  { id: 'spray_docks', kind: 'spray', bi: 1, bj: 8, side: 'N', name: 'Spray Shack' },
  { id: 'spray_south', kind: 'spray', bi: 7, bj: 8, side: 'W', name: 'Spray Shack' },
  { id: 'spray_hill', kind: 'spray', bi: 1, bj: 0, side: 'S', name: 'Spray Shack' },
  { id: 'guns_south', kind: 'gunshop', bi: 5, bj: 7, side: 'N', name: 'Bang Bang Guns' },
  { id: 'guns_west', kind: 'gunshop', bi: 0, bj: 3, side: 'E', name: 'Bang Bang Guns' },
  { id: 'bank', kind: 'bank', bi: 5, bj: 3, side: 'W', name: 'First Azura Bank' },
  { id: 'lou', kind: 'contactLou', bi: 2, bj: 9, side: 'N', name: "Lou's Auto Repair" },
  { id: 'dex', kind: 'contactDex', bi: 4, bj: 5, side: 'S', name: 'Moreau Tower' },
];

const STADIUM_BLOCK = { bi: 6, bj: 9 };

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
  };

  // Blocks.
  for (let bj = 0; bj < n; bj++) {
    for (let bi = 0; bi < n; bi++) {
      const r = mkRect(
        vLines[bi]!.pos + vLines[bi]!.width / 2,
        hLines[bj]!.pos + hLines[bj]!.width / 2,
        vLines[bi + 1]!.pos - vLines[bi + 1]!.width / 2,
        hLines[bj + 1]!.pos - hLines[bj + 1]!.width / 2,
      );
      const district = districtOf(bi, bj);
      const park = PARKS.find((p) => p.bi === bi && p.bj === bj);
      layout.blocks.push({
        id: bj * n + bi,
        bi,
        bj,
        rect: r,
        lot: insetRect(r, SIDEWALK_W),
        district,
        zone: park ? park.name : DISTRICT_ZONE[district],
      });
    }
  }

  // Reserved sidewalk spans (drive-in entrances) where no street furniture may stand.
  const reserved: Rect[] = [];

  for (const block of layout.blocks) {
    const brng = new Rng((seed * 7919 + block.id * 104729) >>> 0);
    const special = SPECIALS.filter((s) => s.bi === block.bi && s.bj === block.bj);
    if (block.bi === STADIUM_BLOCK.bi && block.bj === STADIUM_BLOCK.bj) {
      buildStadium(layout, block);
      continue;
    }
    if (block.district === 'park') {
      buildPark(layout, block, brng);
      continue;
    }
    buildBlock(layout, block, brng, special, reserved);
  }

  buildStreetFurniture(layout, rng, reserved);
  buildCoast(layout, rng);
  buildRamps(layout);
  removePropsInRamps(layout);
  assignGroundFloors(layout);

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
  for (let i = 0; i <= sizes.length; i++) widths.push(AVENUES.has(i) ? AVENUE_W : STREET_W);
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

function buildBlock(layout: CityLayout, block: Block, rng: Rng, specials: SpecialDef[], reserved: Rect[]): void {
  const [minS, maxS] = PARCEL_SIZES[block.district];
  const parcels: Rect[] = [];
  splitParcels(block.lot, minS, maxS, rng, parcels);

  const blocked: Rect[] = []; // areas consumed by special structures
  const specialParcels = new Map<Rect, SpecialDef>();

  for (const def of specials) {
    const heading = sideHeading(def.side);
    if (def.kind === 'spray' || def.kind === 'contactLou') {
      const color = def.kind === 'spray' ? 0x2f8f5b : 0x8a4b2a;
      const g = addGarage(layout, block, def, 0, color, reserved);
      blocked.push(insetRect(g, -1.5));
      const marker = def.kind === 'spray' ? sidewalkMarker(block, def.side, 0) : sidewalkMarker(block, def.side, 11);
      layout.pois.push({ id: def.id, kind: def.kind, name: def.name, x: marker.x, z: marker.z, heading, bay: bayOf(g, def.side), block: block.id });
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
    case 'contactDex':
      height = 128;
      style = 'glassTeal';
      roof = 'helipad';
      sign = { text: 'MOREAU', color: '#38e1d2', side: def.side };
      break;
    default:
      break;
  }
  const tiers: Tier[] = [];
  if (def.kind === 'contactDex') {
    tiers.push({ ...fp, y0: CURB_H, y1: 14 });
    const t = insetRect(fp, Math.min(3, Math.min(rectW(fp), rectD(fp)) / 2 - 4));
    tiers.push({ ...t, y0: 14, y1: 112 });
    tiers.push({ ...insetRect(t, Math.min(2.5, Math.min(rectW(t), rectD(t)) / 2 - 3)), y0: 112, y1: height });
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

function buildStadium(layout: CityLayout, block: Block): void {
  const lot = block.lot;
  layout.ground.push({ rect: lot, kind: 'plaza' });
  const fp = insetRect(lot, 5);
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
    if (special === 'bank' || special === 'police' || special === 'hospital' || special === 'contactDex' || special === 'stadium' || (!special && b.district === 'downtown')) {
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
      { side: 'S', ax: r.minX, az: r.maxZ, bx: r.maxX, bz: r.maxZ, nx: 0, nz: -1, avenue: hLines[block.bj + 1]!.avenue },
      { side: 'W', ax: r.minX, az: r.minZ, bx: r.minX, bz: r.maxZ, nx: 1, nz: 0, avenue: vLines[block.bi]!.avenue },
      { side: 'E', ax: r.maxX, az: r.minZ, bx: r.maxX, bz: r.maxZ, nx: -1, nz: 0, avenue: vLines[block.bi + 1]!.avenue },
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
        d === 'beachfront' || (s.side === 'E' && block.bi === n - 1) ? 'palm' : d === 'docks' ? null : s.avenue || d === 'hillcrest' || d === 'downtown' || d === 'park' ? 'tree' : null;
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
      const degree = (i > 0 ? 1 : 0) + (i < n ? 1 : 0) + (j > 0 ? 1 : 0) + (j < n ? 1 : 0);
      if (degree < 3) continue;
      const node = j * (n + 1) + i;
      const x = vLines[i]!.pos;
      const z = hLines[j]!.pos;
      const hw = vLines[i]!.width / 2;
      const hh = hLines[j]!.width / 2;
      // dir: 0 N (moving -z, arrives from the south), 1 E, 2 S, 3 W
      const approaches = [
        { dir: 0, exists: j < n, px: x + hw + PROP_INSET, pz: z + hh + PROP_INSET },
        { dir: 2, exists: j > 0, px: x - hw - PROP_INSET, pz: z - hh - PROP_INSET },
        { dir: 1, exists: i > 0, px: x - hw - PROP_INSET, pz: z + hh + PROP_INSET },
        { dir: 3, exists: i < n, px: x + hw + PROP_INSET, pz: z - hh - PROP_INSET },
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
  layout.decks.push({ rect: pierRect, y: 0.45, name: 'Azura Pier' });
  addProp(layout, 'ferris', beachEndX + 70, pierZ, Math.PI / 2, 1, 0.45);
  for (let x = beachStartX + 20; x < beachEndX + 85; x += 22) {
    addProp(layout, 'lamp', x, pierZ - 6.2, Math.PI, 1, 0.45);
    addProp(layout, 'lamp', x, pierZ + 6.2, 0, 1, 0.45);
  }
  layout.openSpots.push({ x: beachEndX + 50, z: pierZ + 3, district: 'beachfront' });

  layout.decks.push({ rect: marinaMain, y: 0.45, name: 'Marina' });
  for (let k = 0; k < 3; k++) {
    const x = beachEndX - 10 + k * 26;
    layout.decks.push({ rect: mkRect(x - 2, marinaZ + 5, x + 2, marinaZ + 34), y: 0.45, name: 'Marina' });
    const boat = addProp(layout, 'boat', x + 6, marinaZ + 20, 0, 1, -1.0);
    boat.color = rng.pick([0xffffff, 0xe8e2d0, 0x1f4e79, 0xb03a2e]);
  }
  layout.pois.push({ id: 'marina', kind: 'marina', name: 'Marina', x: beachEndX + 52, z: marinaZ, heading: Math.PI / 2, bay: null, block: -1 });

  // Lighthouse at the north-east tip of the promenade.
  addProp(layout, 'lighthouse', beachStartX - 8, landMinZ + 8, 0, 1);

  // Dock cranes on the south-west quay.
  for (let k = 0; k < 3; k++) {
    addProp(layout, 'crane', cityMinX + 60 + k * 70, landMaxZ - 9, 0, 1);
  }

  // Billboards on the promenade facing the ring roads, 9 m inland of the stunt ramp lines
  // (the promenade ramps sit at landMin + 15) so cars landing a jump do not run into the posts.
  addProp(layout, 'billboard', cityMinX - 10, (cityMinZ + cityMaxZ) / 2 - 120, Math.PI / 2, 1);
  addProp(layout, 'billboard', (cityMinX + cityMaxX) / 2 + 60, cityMinZ - 10, 0, 1);
  addProp(layout, 'billboard', (cityMinX + cityMaxX) / 2 - 150, cityMaxZ + 10, Math.PI, 1);

  // Beach collectibles, just seaward of the ramp corridor where the sand is still dry.
  layout.openSpots.push({ x: beachStartX + 30, z: landMinZ + 60, district: 'beachfront' });
  layout.openSpots.push({ x: beachStartX + 30, z: landMaxZ - 120, district: 'beachfront' });
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
  // West promenade, launching north.
  addRamp(b.landMinX + 15, 120, Math.PI, 2.2);
  // North promenade, launching east.
  addRamp(-80, b.landMinZ + 15, Math.PI / 2, 2.2);
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
