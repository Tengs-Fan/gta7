// Lake Lomas and Pinewood (docs/map.md, "Lake Lomas and Pinewood"): the lake's wooden fishing dock with the dinghies
// moored at it, its cabins, campground, reeds, signs and waterfowl; Pinewood's pine forest, dirt track and fire lookout
// tower; and the wild country between them, the valley's north half: scattered pines and oaks thinning toward the
// lake, boulders and wildflower patches. Pure data and queries, no rendering. buildLakeland is the last of the county's
// content passes and only appends: decks (the dock), buildings (the cabins), props (the pines, the oaks and bushes among
// them), and the solids StaticWorld adds after the places'. It owns the lake plot, the pinewood plot, the pass plot's
// little, and the valley's land north of the Pass Road outside the vineyard; it draws from its own generator
// (hashInts(seed, LAKELAND_SALT)) and keeps clear of every road (`roadGap`).

import { pointSegDist } from '../../core/math';
import { Rng } from '../../core/rng';
import { addProp, hashInts, mkRect, rectContains, rectsOverlap, type CityLayout, type Rect, type Side } from '../layout';
import { COUNTRY_ROADS, countryGround, LAKE_RECTS } from './index';
import { buildLake } from './lake';
import { buildWoods } from './woods';

/** A sign board on two posts: the lines it carries (the first is the headline), facing (sin rot, cos rot). */
export interface LakeSign {
  id: 'lake' | 'swim' | 'camp' | 'fire' | 'pinewood' | 'welcome' | 'toilet';
  x: number;
  z: number;
  rot: number;
  lines: readonly string[];
}

/** A cabin: its building, its porch (a deck along its front) and the lamp on the porch post. */
export interface LakeCabin {
  building: number;
  rect: Rect;
  front: Side;
  porch: Rect;
  lamp: { x: number; y: number; z: number };
}

export type TentKind = 'ridge' | 'dome' | 'family';

export interface Tent {
  kind: TentKind;
  x: number;
  z: number;
  /** Where its door faces (sin rot, cos rot). */
  rot: number;
}

/** A picnic table: its top 1.8 x 0.8 m, along (cos rot, -sin rot). */
export interface Table {
  x: number;
  z: number;
  rot: number;
}

/** A clump of reeds standing in the shallows: where its foot is, how tall, how many blades and which way they lean. */
export interface Reed {
  x: number;
  y: number;
  z: number;
  h: number;
  blades: number;
  lean: number;
}

/** A bird on the water (drawn only): it swims an ellipse about (cx, cz) and the loons dive. */
export interface Waterfowl {
  kind: 'duck' | 'loon';
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  /** Radians per second round its path, and where on it the bird starts. */
  speed: number;
  phase: number;
}

/** A boulder (drawn, and solid to a car): the ground it sits in, its size (m, the widest lump), turn, shape and shade. */
export interface Boulder {
  x: number;
  y: number;
  z: number;
  size: number;
  yaw: number;
  variant: number;
  tint: number;
}

export type FlowerHue = 'buttercup' | 'lupine' | 'daisy' | 'poppy' | 'clover';

/** A patch of wildflowers: tufts scattered over a disc, `count` of them, from its seed. */
export interface FlowerPatch {
  x: number;
  z: number;
  r: number;
  hue: FlowerHue;
  count: number;
  seed: number;
}

/** A dirt lane or track: its centre line (x, z pairs, from the road's edge in) and its width. */
export interface Lane {
  pts: readonly number[];
  width: number;
}

/** A fire lookout tower's frame (render/country/hills.ts draws it, world/country/hills.ts LOOKOUT.tower is the ridge's). */
export interface FireTower {
  x: number;
  z: number;
  half: number;
  cab: number;
  top: number;
  post: number;
}

export interface LakeCamp {
  fire: { x: number; z: number; y: number };
  /** The stone ring's radius (m). */
  ring: number;
  tents: Tent[];
  van: { x: number; z: number; rot: number };
  toilet: { x: number; z: number; rot: number };
  /** The gravel under the camp. */
  pad: Rect;
  /** The fire's log seats: where each lies and how it turns. */
  logs: Array<{ x: number; z: number; rot: number }>;
}

export interface CountyLakeland {
  /** The lake's dock: its walkway and T-head (decks in layout.decks, y above), the lamp at its end and the cabin lamps' pools. */
  dock: { walk: Rect; head: Rect; y: number; lamp: { x: number; y: number; z: number } };
  cabins: LakeCabin[];
  camp: LakeCamp;
  tables: Table[];
  signs: LakeSign[];
  /** An overturned rowboat on the beach by the dock: where it lies and its heading. */
  rowboat: { x: number; z: number; rot: number };
  reeds: Reed[];
  waterfowl: Waterfowl[];
  boulders: Boulder[];
  flowers: FlowerPatch[];
  /** The dirt: lanes and tracks, and gravel pads (the car park, the camp, the tower's). */
  lanes: Lane[];
  pads: Rect[];
  /** Pinewood's fire lookout tower on Pine Rise's top, and its telescope and plaque at its foot. */
  tower: FireTower;
  telescope: { x: number; z: number; rot: number };
  plaque: { x: number; z: number; rot: number };
  /** The places the map names: Lake Lomas's campground and the lookout. */
  labels: Array<{ name: string; x: number; z: number }>;
  /** The first prop and the first solid (country.places.solids) the lakeland added: every prop from `first` on is its (the forest's `pines`, the valley's scatter, then the `shade` oaks by the cabins and the camp), as is every solid from `firstSolid`. */
  forest: { first: number; pines: number; shade: number };
  firstSolid: number;
}

export function noLakeland(): CountyLakeland {
  return {
    dock: { walk: mkRect(0, 0, 0, 0), head: mkRect(0, 0, 0, 0), y: 0, lamp: { x: 0, y: 0, z: 0 } },
    cabins: [],
    camp: { fire: { x: 0, z: 0, y: 0 }, ring: 0, tents: [], van: { x: 0, z: 0, rot: 0 }, toilet: { x: 0, z: 0, rot: 0 }, pad: mkRect(0, 0, 0, 0), logs: [] },
    tables: [],
    signs: [],
    rowboat: { x: 0, z: 0, rot: 0 },
    reeds: [],
    waterfowl: [],
    boulders: [],
    flowers: [],
    lanes: [],
    pads: [],
    tower: { x: 0, z: 0, half: 0, cab: 0, top: 0, post: 0 },
    telescope: { x: 0, z: 0, rot: 0 },
    plaque: { x: 0, z: 0, rot: 0 },
    labels: [],
    forest: { first: 0, pines: 0, shade: 0 },
    firstSolid: 0,
  };
}

/** Salt of the generator behind all of it (hashInts(seed, LAKELAND_SALT)). */
const LAKELAND_SALT = 9421;

/** Every county road's centre line as segments with its half width: roadGap's (made on first use, the county's roads being defined after this module loads). */
let roadSegments: Array<readonly [number, number, number, number, number]> | null = null;

/** How far (m) (x, z) lies outside the nearest county road's edge (negative on the carriageway). */
export function roadGap(x: number, z: number): number {
  roadSegments ??= COUNTRY_ROADS.flatMap((r) => {
    const out: Array<readonly [number, number, number, number, number]> = [];
    for (let k = 2; k < r.pts.length; k += 2) out.push([r.pts[k - 2]!, r.pts[k - 1]!, r.pts[k]!, r.pts[k + 1]!, r.width / 2]);
    return out;
  });
  let best = Infinity;
  for (const [ax, az, bx, bz, half] of roadSegments) best = Math.min(best, pointSegDist(x, z, ax, az, bx, bz) - half);
  return best;
}

/** The point (x, z) of the Valley Loop's east side at `z`, as far as its centre line: the x of the road there. */
export function loopX(z: number): number {
  const loop = COUNTRY_ROADS.find((r) => r.name === 'Valley Loop')!;
  for (let k = 2; k < loop.pts.length; k += 2) {
    const az = loop.pts[k - 1]!;
    const bz = loop.pts[k + 1]!;
    const ax = loop.pts[k - 2]!;
    // The east side runs from the north-east corner south to the cross, x above -1900.
    if (ax > -1900 && loop.pts[k]! > -1900 && (z - az) * (z - bz) <= 0 && az !== bz) return ax + ((loop.pts[k]! - ax) * (z - az)) / (bz - az);
  }
  throw new Error(`the Valley Loop's east side does not reach z ${z}`);
}

/** The valley's land north of the Pass Road (z 84), outside the vineyard, inside the box x -2300..-1560, z -580..70: a tree keeps 9 m off the road's edge, which is at z 79. */
export const NORTH_VALLEY = mkRect(-2300, -580, -1560, 70);

/** A smooth value noise of (x, z) in 0..1 over cells of `scale` m, from `salt`. */
export function valueNoise(x: number, z: number, scale: number, salt: number): number {
  const gx = Math.floor(x / scale);
  const gz = Math.floor(z / scale);
  const fx = x / scale - gx;
  const fz = z / scale - gz;
  const at = (i: number, j: number) => (hashInts(i, j, salt) % 10_000) / 10_000;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  return (at(gx, gz) * (1 - sx) + at(gx + 1, gz) * sx) * (1 - sz) + (at(gx, gz + 1) * (1 - sx) + at(gx + 1, gz + 1) * sx) * sz;
}

/** The distance (m) from (x, z) to the lake's nearest water rectangle (0 over it). */
export function lakeGap(x: number, z: number): number {
  let d = Infinity;
  for (const r of LAKE_RECTS) d = Math.min(d, Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ)));
  return d;
}

/** What the passes keep trees and props off: boxes, and dirt lines with a half width. */
export interface Keepout {
  rects: Rect[];
  lines: Array<{ pts: readonly number[]; r: number }>;
}

/** Whether a disc of radius r at (x, z) touches a keepout. */
export function blocked(k: Keepout, x: number, z: number, r: number): boolean {
  for (const q of k.rects) if (rectContains(q, x, z, r)) return true;
  for (const l of k.lines) {
    for (let i = 2; i < l.pts.length; i += 2) if (pointSegDist(x, z, l.pts[i - 2]!, l.pts[i - 1]!, l.pts[i]!, l.pts[i + 1]!) < l.r + r) return true;
  }
  return false;
}

/** The ground a prop stands on, and whether it is dry land well clear of the water (beach, lake and coves) at `margin` m. */
export function dryLand(layout: CityLayout, x: number, z: number, margin = 5): boolean {
  const c = layout.country;
  if (countryGround(c, x, z) < 0) return false;
  for (let a = 0; a < 6; a++) {
    if (countryGround(c, x + Math.cos(a * 1.0472) * margin, z + Math.sin(a * 1.0472) * margin) < 0) return false;
  }
  return true;
}

/** Whether the rect keeps off the lake's water and its beach. */
export function offLake(r: Rect, margin = 12): boolean {
  return !LAKE_RECTS.some((q) => rectsOverlap(q, r, margin));
}

export function nextBuildingId(layout: CityLayout): number {
  return layout.buildings.reduce((m, b) => Math.max(m, b.id), -1) + 1;
}

/** The lakeland's own prop: on the county's ground. */
export function prop(layout: CityLayout, kind: Parameters<typeof addProp>[1], x: number, z: number, rot: number, scale = 1): void {
  addProp(layout, kind, x, z, rot, scale, countryGround(layout.country, x, z));
}

/** The lakeland, the county's last content pass (after the places): the lake's dock, cabins and camp, Pinewood, the north valley. */
export function buildLakeland(layout: CityLayout): void {
  const rng = new Rng(hashInts(layout.seed, LAKELAND_SALT));
  const land = noLakeland();
  layout.country.lakeland = land;
  land.firstSolid = layout.country.places.solids.length;
  const keep: Keepout = { rects: [], lines: [] };
  buildLake(layout, land, rng, keep);
  buildWoods(layout, land, rng, keep);
}
