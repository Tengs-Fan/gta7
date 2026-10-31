// Las Lomas County's four farms (docs/map.md, "Las Lomas: the farms"), each on its plot: Hollister Bottoms (corn, a
// gambrel barn, three grain bins and a windpump), the Cud & Sons Dairy (twin silos, a pasture of cows behind post-and-rail
// fences, the propane tank behind the milking barn), Pippin Hollow (apple rows) and Halfmoon Acres (wheat, sunflowers,
// bales). Fields at field scale are data only (the renderer draws what the camera sees of them); the farmsteads are a
// garage for each barn, a building for each farmhouse and props for the rest; hedgerows run along the plots' edges with
// gaps at the gates. Fifteen cows and twenty scarecrows are breakable props whose indices are kept here. Pure data.
// buildFarms is one call in buildCountry: it only appends, draws from its own generator, keeps 12 m off every road edge
// (every farm plot does) and adds no open spot.

import { Rng } from '../../core/rng';
import { addProp, garageWalls, hashInts, insetRect, mkRect, rectContains, type CityLayout, type Prop, type PropKind, type Rect, type Side } from '../layout';
import { countryGround } from './index';

export type Crop = 'corn' | 'wheat' | 'sunflower' | 'furrow' | 'lettuce';

/** A field: its crop sown in rows running along (sin rowAngle, cos rowAngle). */
export interface Field {
  rect: Rect;
  crop: Crop;
  rowAngle: number;
}

/** Crops a person stands hidden in and a car drags through. */
export const TALL_CROPS: ReadonlySet<Crop> = new Set<Crop>(['corn', 'sunflower']);

export type FarmId = 'bottoms' | 'dairy' | 'orchard' | 'acres';

export interface Farmstead {
  id: FarmId;
  yard: Rect;
  /** The barn: a garage (walls and a roof slab that hides the bay from the helicopter) drawn with a gambrel roof. */
  barn: Rect;
  door: Side;
  /** The farmhouse's building id. */
  house: number;
  /** The farm drive's centre line, from the road's edge to the yard: dirt, drawn only (no lane leads in). */
  drive: readonly [number, number, number, number];
  /** The farm's sign at the drive's mouth on the plot's edge, and its mailbox by the road; each faces the road. */
  sign: { x: number; z: number; rot: number };
  mailbox: { x: number; z: number; rot: number };
}

export interface CountyFarms {
  fields: Field[];
  farmsteads: Farmstead[];
  /** Where the police see a target only up close (StaticWorld.coverAt): the tall crops and the barns' insides. */
  cover: Rect[];
  /** Where a car drags through a tall crop (StaticWorld.cropAt). */
  tall: Rect[];
  /** The box round the cover (and so round the tall crops). */
  bounds: Rect;
  /** Hedgerows, HEDGE_H tall: solid for sight and shots, not for the camera. */
  hedges: Rect[];
  /** Prop indices: the cows, the scarecrows, the propane tank and the windpump. */
  cows: number[];
  scarecrows: number[];
  propane: number;
  windpump: number;
  /** Ladders against apple trees: where each one's foot stands and which way it leans. */
  ladders: Array<{ x: number; z: number; rot: number }>;
}

/** Hedgerows' height and thickness (m). */
export const HEDGE_H = 2.2;
export const HEDGE_T = 1.4;
/** A post-and-rail fence's run (m) between posts, and its height. */
export const FENCE_RUN = 4;
export const FENCE_H = 1.3;
/** A cow's body: its collider's radius and height (render/country/farms.ts draws it inside these). */
export const COW_R = 0.9;
export const COW_H = 1.5;
/** The scarecrows and the cows: how many. */
export const SCARECROW_COUNT = 20;
export const COW_COUNT = 15;
/** The windpump: its tower's height, and its stock tank's offset (along +x), radius and rim height. */
export const WINDPUMP_H = 10;
export const STOCK_TANK = { dx: 3.4, r: 1.6, h: 0.75 } as const;
/** The propane tank, lying along its rot: length, radius and the height of its axis. */
export const PROPANE = { len: 3, r: 0.65, axis: 1 } as const;

/** Seed salt of the farms' generator (hashInts(seed, FARMS_SALT)). */
const FARMS_SALT = 7301;

export function noFarms(): CountyFarms {
  return { fields: [], farmsteads: [], cover: [], tall: [], bounds: mkRect(0, 0, 0, 0), hedges: [], cows: [], scarecrows: [], propane: -1, windpump: -1, ladders: [] };
}

/** A prop of the county's, on its ground. */
function prop(layout: CityLayout, kind: PropKind, x: number, z: number, rot: number, scale = 1): Prop {
  return addProp(layout, kind, x, z, rot, scale, countryGround(layout.country, x, z));
}

/** A prop with a footprint (a fence run, a bale stack, a silo: w x d, h tall), its index. */
function boxProp(layout: CityLayout, kind: PropKind, x: number, z: number, w: number, d: number, h: number, rot = 0, color = 0): number {
  const p = prop(layout, kind, x, z, rot);
  p.w = w;
  p.d = d;
  p.h = h;
  p.color = color;
  return layout.props.length - 1;
}

function nextBuildingId(layout: CityLayout): number {
  return layout.buildings.reduce((m, b) => Math.max(m, b.id), -1) + 1;
}

/** A farmhouse of `rect`, `h` tall to its eaves, gable-roofed: facades, lit windows and colliders as a city house's. */
function farmhouse(layout: CityLayout, rect: Rect, h: number, rng: Rng): number {
  const id = nextBuildingId(layout);
  layout.buildings.push({
    id, rect, height: h, tiers: [{ ...rect, y0: 0, y1: h }], style: 'house', roof: 'gable', tint: rng.next(), district: 'country',
    roofProps: [], sign: null, special: null, ground: 'none', groundH: 0, groundSides: [],
  });
  return id;
}

/** A barn: a garage open on `door`, its walls `h` tall. */
function barn(layout: CityLayout, id: FarmId, rect: Rect, door: Side, h: number, color: number): void {
  layout.garages.push({ poi: `${id}_barn`, rect, side: door, walls: garageWalls(rect, door, 0.5), height: h, color });
}

/** Fence runs along the straight line from (x0, z0) to (x1, z1) (on an axis, a whole number of runs), but for `gaps` (indices). */
function fenceLine(layout: CityLayout, x0: number, z0: number, x1: number, z1: number, gaps: readonly number[] = []): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.round(len / FENCE_RUN);
  const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  for (let k = 0; k < n; k++) {
    if (gaps.includes(k)) continue;
    const t = (k + 0.5) / n;
    boxProp(layout, 'fence', x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, FENCE_RUN, 0.2, FENCE_H, alongX ? 0 : Math.PI / 2);
  }
}

/** Fence runs round `r` (its sides whole numbers of runs), but for the gaps on each side (indices along it, west to east or north to south). */
function fenceRound(layout: CityLayout, r: Rect, gaps: Partial<Record<Side, readonly number[]>> = {}): void {
  fenceLine(layout, r.minX, r.minZ, r.maxX, r.minZ, gaps.N);
  fenceLine(layout, r.minX, r.maxZ, r.maxX, r.maxZ, gaps.S);
  fenceLine(layout, r.minX, r.minZ, r.minX, r.maxZ, gaps.W);
  fenceLine(layout, r.maxX, r.minZ, r.maxX, r.maxZ, gaps.E);
}

/** A hedgerow along a plot's edge on `side`, from `a` to `b` along it. */
function hedge(farms: CountyFarms, plot: Rect, side: Side, a: number, b: number): void {
  const t = HEDGE_T;
  farms.hedges.push(
    side === 'N' ? mkRect(a, plot.minZ, b, plot.minZ + t)
      : side === 'S' ? mkRect(a, plot.maxZ - t, b, plot.maxZ)
      : side === 'W' ? mkRect(plot.minX, a, plot.minX + t, b)
      : mkRect(plot.maxX - t, a, plot.maxX, b),
  );
}

function field(farms: CountyFarms, crop: Crop, rect: Rect, rowAngle: number): void {
  farms.fields.push({ rect, crop, rowAngle });
}

function scarecrow(layout: CityLayout, farms: CountyFarms, x: number, z: number, rng: Rng): void {
  prop(layout, 'scarecrow', x, z, rng.range(-Math.PI, Math.PI), rng.range(0.92, 1.08));
  farms.scarecrows.push(layout.props.length - 1);
}

const plotRect = (layout: CityLayout, id: FarmId) => layout.country.plots.find((p) => p.id === id)!.rect;

const E = Math.PI / 2;
const W = -Math.PI / 2;

/** The farms, after the landscape and before the places (buildCountry): every prop, building and garage appended. */
export function buildFarms(layout: CityLayout): void {
  const farms = layout.country.farms;
  const rng = new Rng(hashInts(layout.seed, FARMS_SALT));
  buildBottoms(layout, farms, rng);
  buildDairy(layout, farms, rng);
  buildOrchard(layout, farms, rng);
  buildAcres(layout, farms, rng);
  farms.tall = farms.fields.filter((f) => TALL_CROPS.has(f.crop)).map((f) => f.rect);
  farms.cover = [...farms.tall, ...farms.farmsteads.map((f) => insetRect(f.barn, 0.5))];
  farms.bounds = mkRect(
    Math.min(...farms.cover.map((r) => r.minX)),
    Math.min(...farms.cover.map((r) => r.minZ)),
    Math.max(...farms.cover.map((r) => r.maxX)),
    Math.max(...farms.cover.map((r) => r.maxZ)),
  );
}

/**
 * Hollister Bottoms, inside Hollister Lane's loop: corn either side of a mown aisle and north of the farmyard, which
 * opens east onto the lane. A red gambrel barn, three grain bins, a windpump over its stock tank, the farmhouse.
 */
function buildBottoms(layout: CityLayout, farms: CountyFarms, rng: Rng): void {
  const P = plotRect(layout, 'bottoms');
  const yard = mkRect(P.maxX - 52, P.maxZ - 62, P.maxX, P.maxZ);
  const barnRect = mkRect(yard.minX + 4, yard.minZ + 4, yard.minX + 22, yard.minZ + 18);
  barn(layout, 'bottoms', barnRect, 'E', 6, 0x8e2b1f);
  const house = farmhouse(layout, mkRect(yard.maxX - 20, yard.maxZ - 20, yard.maxX - 6, yard.maxZ - 8), 7.2, rng);
  for (let k = 0; k < 3; k++) boxProp(layout, 'grainbin', yard.minX + 6 + k * 6, yard.maxZ - 14, 5.2, 5.2, 9);
  farms.windpump = boxProp(layout, 'windpump', yard.maxX - 10, yard.minZ + 10, 2, 2, WINDPUMP_H);
  for (const dz of [23, 18.5]) layout.parking.push({ x: yard.maxX - 18, z: yard.minZ + dz, heading: W });
  const driveZ = yard.minZ + 31;
  farms.farmsteads.push({
    id: 'bottoms', yard, barn: barnRect, door: 'E', house, drive: [P.maxX + 40, driveZ, P.maxX, driveZ],
    sign: { x: P.maxX - 2, z: driveZ + 5, rot: E }, mailbox: { x: P.maxX + 37.5, z: driveZ + 5, rot: E },
  });
  // The corn: two fields either side of a 4 m aisle running north from a gate in the south hedge, and one north of the yard.
  const aisle = (P.minX + yard.minX) / 2;
  field(farms, 'corn', mkRect(P.minX + 4, P.minZ + 4, aisle - 2, P.maxZ - 4), 0);
  field(farms, 'corn', mkRect(aisle + 2, P.minZ + 4, yard.minX - 4, P.maxZ - 4), 0);
  field(farms, 'corn', mkRect(yard.minX, P.minZ + 4, P.maxX - 4, yard.minZ - 4), E);
  for (const z of [P.minZ + 30, P.minZ + 70, P.minZ + 110]) scarecrow(layout, farms, aisle, z, rng);
  scarecrow(layout, farms, yard.minX + 24, yard.minZ - 2, rng);
  hedge(farms, P, 'S', P.minX, aisle - 2);
  hedge(farms, P, 'S', aisle + 2, yard.minX - 4);
  hedge(farms, P, 'W', P.minZ, P.maxZ);
  hedge(farms, P, 'E', P.minZ, yard.minZ - 4);
}

/**
 * The Cud & Sons Dairy, west of Creek Road: the farmyard opens east onto the road, the whitewashed milking barn opening
 * north onto it with its twin silos, the propane tank behind it, the farmhouse; a fenced pasture of cows west of the
 * yard, lettuce north of it and furrows down the east side.
 */
function buildDairy(layout: CityLayout, farms: CountyFarms, rng: Rng): void {
  const P = plotRect(layout, 'dairy');
  const yard = mkRect(P.maxX - 80, P.maxZ - 64, P.maxX, P.maxZ);
  const barnRect = mkRect(yard.minX + 8, yard.maxZ - 30, yard.minX + 32, yard.maxZ - 14);
  barn(layout, 'dairy', barnRect, 'N', 5.5, 0xd8d2c4);
  for (const z of [barnRect.minZ + 3.2, barnRect.minZ + 9.8]) boxProp(layout, 'silo', barnRect.maxX + 3.6, z, 6, 6, 16);
  const house = farmhouse(layout, mkRect(yard.maxX - 24, yard.maxZ - 26, yard.maxX - 10, yard.maxZ - 12), 7.2, rng);
  farms.propane = boxProp(layout, 'propane', (barnRect.minX + barnRect.maxX) / 2, barnRect.maxZ + 7, PROPANE.len, PROPANE.r * 2, PROPANE.axis + PROPANE.r);
  for (const dz of [10, 15]) layout.parking.push({ x: yard.maxX - 32, z: yard.minZ + dz, heading: E });
  const driveZ = yard.minZ + 28;
  farms.farmsteads.push({
    id: 'dairy', yard, barn: barnRect, door: 'N', house, drive: [P.maxX + 15, driveZ, P.maxX, driveZ],
    sign: { x: P.maxX - 2, z: driveZ - 6, rot: E }, mailbox: { x: P.maxX + 12.5, z: driveZ - 6, rot: E },
  });
  // The pasture, its gate on the east side by the yard (the runs at 132..140 m down it).
  const pasture = mkRect(P.minX + 4, P.minZ + 56, P.minX + 132, P.maxZ - 4);
  fenceRound(layout, pasture, { E: [33, 34] });
  const inner = insetRect(pasture, 4);
  const cows: Array<{ x: number; z: number }> = [];
  while (cows.length < COW_COUNT) {
    const x = rng.range(inner.minX, inner.maxX);
    const z = rng.range(inner.minZ, inner.maxZ);
    if (cows.some((c) => Math.hypot(c.x - x, c.z - z) < 9)) continue;
    cows.push({ x, z });
    prop(layout, 'cow', x, z, rng.range(-Math.PI, Math.PI), rng.range(0.94, 1.06)).color = rng.int(0, 3);
    farms.cows.push(layout.props.length - 1);
  }
  const lettuce = mkRect(P.minX + 4, P.minZ + 4, pasture.maxX, pasture.minZ - 6);
  field(farms, 'lettuce', lettuce, E);
  const furrow = mkRect(pasture.maxX + 10, P.minZ + 4, P.maxX - 4, yard.minZ - 8);
  field(farms, 'furrow', furrow, 0);
  for (const x of [lettuce.minX + 36, lettuce.maxX - 36]) scarecrow(layout, farms, x, (lettuce.minZ + lettuce.maxZ) / 2, rng);
  for (const z of [furrow.minZ + 56, furrow.maxZ - 40]) scarecrow(layout, farms, (furrow.minX + furrow.maxX) / 2, z, rng);
  hedge(farms, P, 'E', P.minZ, yard.minZ - 4);
  hedge(farms, P, 'E', driveZ + 8, P.maxZ);
}

/**
 * Pippin Hollow, east of the Lomas Highway's west leg: apple trees in rows across the plot, ladders against a few, and
 * the farmyard by the road with its packing barn (opening north onto it) and the farmhouse.
 */
function buildOrchard(layout: CityLayout, farms: CountyFarms, rng: Rng): void {
  const P = plotRect(layout, 'orchard');
  const yard = mkRect(P.minX, P.maxZ - 68, P.minX + 48, P.maxZ - 4);
  const barnRect = mkRect(yard.minX + 6, yard.maxZ - 18, yard.minX + 22, yard.maxZ - 4);
  barn(layout, 'orchard', barnRect, 'N', 5, 0x9b3d24);
  const house = farmhouse(layout, mkRect(yard.maxX - 20, yard.maxZ - 18, yard.maxX - 6, yard.maxZ - 4), 7, rng);
  for (const dz of [26, 31]) layout.parking.push({ x: yard.maxX - 10, z: yard.minZ + dz, heading: W });
  const driveZ = yard.minZ + 32;
  farms.farmsteads.push({
    id: 'orchard', yard, barn: barnRect, door: 'N', house, drive: [P.minX - 27, driveZ, P.minX, driveZ],
    sign: { x: P.minX + 2, z: driveZ - 6, rot: W }, mailbox: { x: P.minX - 24.5, z: driveZ - 6, rot: W },
  });
  // Rows east to west, 8 m apart, a tree every 7 m: south of the yard from the plot's west edge, east of it beyond.
  const trees: Array<{ x: number; z: number }> = [];
  for (let z = P.minZ + 6; z < P.maxZ - 4; z += 8) {
    const x0 = z < yard.minZ - 4 ? P.minX + 6 : yard.maxX + 6;
    for (let x = x0; x < P.maxX - 3; x += 7) {
      if (rng.chance(0.04)) continue;
      const tx = x + rng.range(-0.3, 0.3);
      const tz = z + rng.range(-0.3, 0.3);
      prop(layout, 'orchardTree', tx, tz, rng.range(-Math.PI, Math.PI), rng.range(0.85, 1.12));
      trees.push({ x: tx, z: tz });
    }
  }
  for (const t of rng.shuffle(trees).slice(0, 12)) {
    const rot = rng.range(-Math.PI, Math.PI);
    farms.ladders.push({ x: t.x + Math.sin(rot) * 1.3, z: t.z + Math.cos(rot) * 1.3, rot: rot + Math.PI });
  }
  // The scarecrows stand in the aisles between the rows.
  for (const [dx, k] of [[60, 3], [110, 9], [140, 15], [30, 5]] as const) scarecrow(layout, farms, P.minX + dx + 3.5, P.minZ + 6 + k * 8 + 4, rng);
  hedge(farms, P, 'W', P.minZ, driveZ - 4);
  hedge(farms, P, 'W', driveZ + 4, P.maxZ);
  hedge(farms, P, 'N', P.minX, P.maxX);
}

/**
 * Halfmoon Acres, north of the Lomas Highway's south leg: wheat across the west of the plot, sunflowers either side of
 * an aisle, furrows by the farmyard, which opens south onto the highway, its red barn, the bale stacks and the farmhouse.
 */
function buildAcres(layout: CityLayout, farms: CountyFarms, rng: Rng): void {
  const P = plotRect(layout, 'acres');
  const yard = mkRect(P.maxX - 74, P.maxZ - 66, P.maxX, P.maxZ);
  const barnRect = mkRect(yard.minX + 4, yard.minZ + 4, yard.minX + 22, yard.minZ + 20);
  barn(layout, 'acres', barnRect, 'S', 6, 0x8e2b1f);
  const house = farmhouse(layout, mkRect(yard.maxX - 24, yard.minZ + 8, yard.maxX - 10, yard.minZ + 22), 7.2, rng);
  for (const [dx, dz, w, d, h] of [[26, 8, 4.8, 2.4, 2.4], [26, 11.2, 4.8, 2.4, 1.6], [26, 16, 2.4, 4.8, 2.4], [31, 16, 2.4, 4.8, 1.6], [36, 9, 4.8, 2.4, 0.8]] as const) {
    boxProp(layout, 'bale', yard.minX + dx, yard.minZ + dz, w, d, h);
  }
  for (const dx of [40, 44]) layout.parking.push({ x: yard.minX + dx, z: yard.minZ + 36, heading: 0 });
  const driveX = yard.minX + 36;
  farms.farmsteads.push({
    id: 'acres', yard, barn: barnRect, door: 'S', house, drive: [driveX, P.maxZ + 16, driveX, P.maxZ],
    sign: { x: driveX + 6, z: P.maxZ - 2, rot: 0 }, mailbox: { x: driveX + 6, z: P.maxZ + 13.5, rot: 0 },
  });
  const wheat = mkRect(P.minX + 4, P.minZ + 4, P.minX + 164, P.maxZ - 4);
  field(farms, 'wheat', wheat, E);
  const sun0 = wheat.maxX + 4;
  const aisle = sun0 + 32;
  field(farms, 'sunflower', mkRect(sun0, P.minZ + 4, aisle - 2, P.maxZ - 4), 0);
  field(farms, 'sunflower', mkRect(aisle + 2, P.minZ + 4, yard.minX - 4, P.maxZ - 4), 0);
  const furrow = mkRect(yard.minX + 4, P.minZ + 4, P.maxX - 4, yard.minZ - 4);
  field(farms, 'furrow', furrow, 0);
  for (const [x, z] of [[wheat.minX + 36, wheat.minZ + 36], [wheat.minX + 86, wheat.maxZ - 40], [wheat.maxX - 34, wheat.minZ + 50], [wheat.minX + 20, wheat.maxZ - 20]] as const) scarecrow(layout, farms, x, z, rng);
  for (const z of [P.minZ + 40, P.maxZ - 44]) scarecrow(layout, farms, aisle, z, rng);
  for (const z of [furrow.minZ + 24, furrow.maxZ - 22]) scarecrow(layout, farms, (furrow.minX + furrow.maxX) / 2, z, rng);
  hedge(farms, P, 'S', P.minX, aisle - 2);
  hedge(farms, P, 'S', aisle + 2, yard.minX - 4);
  hedge(farms, P, 'E', P.minZ, yard.minZ - 4);
}

/** Whether (x, z) is in a tall crop (corn, sunflowers). */
export function inTallCrop(farms: CountyFarms, x: number, z: number): boolean {
  const b = farms.bounds;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
  return farms.tall.some((r) => rectContains(r, x, z));
}

/** Whether (x, z) is in the farms' cover (a tall crop, a barn). */
export function inFarmCover(farms: CountyFarms, x: number, z: number): boolean {
  const b = farms.bounds;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
  return farms.cover.some((r) => rectContains(r, x, z));
}
