// Buildings: facades, storefront frontages, roofs, signs and the night-window shaders.

import * as THREE from 'three';
import { clamp, clamp01 } from '../../core/math';
import { Rng } from '../../core/rng';
import { attractionOf } from '../../world/attractions';
import { CURB_H } from '../../world/constants';
import {
  SPECIALS, blockOf, hashInts, rectD, rectW,
  type Block, type Building, type FacadeStyle, type Side, type Tier,
} from '../../world/layout';
import { GeoBuilder, hexToRgb, scaleRgb, type RGB, type UvMode } from '../geo';
import { balconies, facadeRelief, fireEscape, houseShutters, trimColors } from '../cityArchitecture';
import { drawLandmark, landmarkTowers } from './landmarks';
import { COPING_H, PARAPET_H, drawRooftopItem, parapetThickness, rooftopItems } from './rooftops';
import { createStorefrontMaterial, frontKey, storefrontPlan, type AwningStyle } from './storefronts';
import { DECOR_PROGRAM, NIGHT_HASH, createFacadeMaterial, facadeTexturesOf, withBuildingFog } from './facadeShader';
import {
  CELLS, CELL_DESIGN, DOOR_OPENING, DOOR_U, FACADE_LOOK, LOBBY_GLASS, FACADE_CELL, FACADE_COLS, FACADE_ROWS, HOUSE_SILL, SHOP_AWNING_TOP, SHOP_FASCIA_FRAC, SHOPS, SWATCHES,
  BANK_STEP_TOP, facadeSeed, signTexture, storefrontAtlas, storefrontUv, swatchUv, type DoorOpening,
} from '../textures';
import type { CityView } from './index';

const STYLES: FacadeStyle[] = ['glassBlue', 'glassTeal', 'office', 'brick', 'stucco', 'house', 'warehouse', 'hotel'];

/** Pastel / neutral tints per style (multiplied with the texture). */
const STYLE_TINTS: Record<FacadeStyle, number[]> = {
  glassBlue: [0xffffff, 0xe8f0ff, 0xdfe8f5],
  glassTeal: [0xffffff, 0xe6fff8],
  office: [0xffffff, 0xf3ead8, 0xe6e0d0, 0xd9d4c8],
  brick: [0xffffff, 0xe8d0c0, 0xd6c4b8],
  stucco: [0xffffff, 0xffe9d2, 0xe9f4ff, 0xfff4c9, 0xf5dce8, 0xdff5e1],
  house: [0xfff1dc, 0xffd9c4, 0xd9ecff, 0xfff6b8, 0xe7d2ff, 0xd2f5dc, 0xffffff, 0xf2c9b0],
  warehouse: [0xffffff, 0xd8e2ea, 0xe8e0d0],
  hotel: [0xffffff, 0xfff5e6, 0xeaf6ff],
};

/**
 * Share of windows lit at a time of day: dark by day, busiest in the evening, a few night owls
 * after midnight and early risers before dawn. Piecewise linear over the hours (any value).
 */
export function occupancy(hours: number): number {
  let h = ((hours % 24) + 24) % 24;
  if (h < OCCUPANCY_KEYS[0]![0]) h += 24;
  for (let i = 1; i < OCCUPANCY_KEYS.length; i++) {
    const [h1, v1] = OCCUPANCY_KEYS[i]!;
    if (h <= h1) {
      const [h0, v0] = OCCUPANCY_KEYS[i - 1]!;
      const t = (h - h0) / (h1 - h0);
      // This form is exact at both keys.
      return v0 * (1 - t) + v1 * t;
    }
  }
  return 0;
}

/** [hour, share] keys from 07:30 to 07:30 the next day (hours past midnight run on from 24). */
const OCCUPANCY_KEYS: ReadonlyArray<readonly [number, number]> = [
  [7.5, 0],
  [17, 0],
  [18, 0.6],
  [20, 0.6],
  [27, 0.15],
  [29.5, 0.15],
  [30.5, 0.3],
  [31.5, 0],
];

/**
 * Share of shops still lit: about 70% from dusk until late evening (two thirds at 22:30), closing one by
 * one after that until the last go dark a little after 02:00. Shops keep evening hours only: the early risers before dawn are at home.
 */
export function shopOccupancy(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  if (h >= 3 && h < 12) return 0;
  return 0.7 * clamp01((occupancy(h) - 0.2) / 0.25);
}

/** Storefront classes, stored in the integer part of a frontage's aSeed (the fraction is its random seed). */
const FRONT_SHOP = 0;
const FRONT_LOBBY = 1;
const FRONT_HOME = 2;
const FRONT_LAMP = 3;

/**
 * Shops switch off one by one through the night (down to a dim night light); lobbies stay lit but dim after the evening;
 * porch lights follow the occupants; loading-bay lamps (and the gun shops) never go out.
 */
const FRONT_FRAG_MAIN = /* glsl */ `
{
  float cls = floor(vSeed);
  float sd = fract(vSeed);
  float on = 1.0;
  // A closed shop keeps a dim night light on behind its glass.
  if (cls < 0.5) on = mix(0.15, 1.0, step(sd, uShopOcc));
  // Lobbies are big lit rooms: a little dimmer per square metre than a shop window.
  else if (cls < 1.5) on = 0.75 * (0.3 + 0.7 * clamp(uOccupancy / 0.6, 0.0, 1.0));
  else if (cls < 2.5) on = step(sd, uOccupancy * 1.3);
  totalEmissiveRadiance *= on;
}`;

/** One wall of a ground tier, walked like GeoBuilder.box so the facade UVs stay continuous round the corners. */
interface TierWall {
  side: Side;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Facade u offset of the wall's start (metres round the footprint). */
  u: number;
  /** Distance from the wall to its lot edge. */
  gap: number;
}

const SIDE_INDEX: Record<Side, number> = { N: 0, E: 1, S: 2, W: 3 };
const PAWN = SHOPS.findIndex((s) => s.name === 'PAWN');
const WHITE: RGB = [1, 1, 1];

function linearRgb(hex: number): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Nominal width (m) of a frontage quad: every storefront cell is drawn for 6.5 m of wall. */
const BAY = 6.5;
/** The narrowest quad (m) a door-aware split leaves beside the door. */
const BAY_MIN = 4;
/** The narrowest and widest door quad (m). */
const DOOR_MIN = 5;
const DOOR_MAX = 8;
/** A sign over an entrance keeps this far (m) from the ends of its wall. */
const SIGN_MARGIN = 0.4;

export interface FrontageSplit {
  /** Quad edges along the wall (m), from 0 to its length. */
  edges: number[];
  /** Index of the door quad (-1: none). */
  door: number;
  /** The door quad is drawn mirrored, which puts its door at 1 - u of its width. */
  mirror: boolean;
}

/**
 * Splits a wall `len` m long into frontage quads about BAY wide. Without a door they are equal.
 * With one, the door quad (its door `u` of the way across it, or mirrored at 1 - u) is placed and
 * sized (DOOR_MIN to DOOR_MAX), and the wall left on either side is split into equal quads no
 * narrower than BAY_MIN. Each metre between the door and `at` costs `pull`, against quads stretched
 * or squeezed away from the BAY their cells are drawn for: a strong pull (2) puts a door at its spot
 * wherever the wall allows; a weak one (0.3) centres a door only where the quads stay near BAY.
 */
export function frontageSplit(len: number, door: { at: number; u: number; pull: number } | null): FrontageSplit {
  const edges = [0];
  if (!door || Math.round(len / BAY) <= 1) {
    pushEven(edges, 0, len, Math.max(1, Math.round(len / BAY)));
    // A single quad: mirroring is the only way to move its door towards the spot.
    const mirror = !!door && Math.abs(len * (1 - door.u) - door.at) < Math.abs(len * door.u - door.at) - 1e-9;
    return { edges, door: door ? 0 : -1, mirror };
  }
  let best = { cost: Infinity, s0: 0, w: BAY, mirror: false };
  for (let k = 0; DOOR_MIN + k * 0.05 <= Math.min(DOOR_MAX, len) + 1e-9; k++) {
    const w = DOOR_MIN + k * 0.05;
    for (const mirror of [false, true]) {
      const u = mirror ? 1 - door.u : door.u;
      // Flush with either end of the wall, or as near the spot as leaves BAY_MIN on both sides.
      const starts = [0, len - w];
      if (len - w - BAY_MIN >= BAY_MIN) starts.push(clamp(door.at - w * u, BAY_MIN, len - w - BAY_MIN));
      for (const s0 of starts) {
        const right = len - s0 - w;
        if (s0 < -1e-6 || right < -1e-6 || (s0 > 1e-6 && s0 < BAY_MIN - 1e-6) || (right > 1e-6 && right < BAY_MIN - 1e-6)) continue;
        const cost = door.pull * Math.abs(s0 + w * u - door.at) + 0.25 * (Math.abs(w - BAY) + stretch(s0, right));
        if (cost < best.cost - 1e-9) best = { cost, s0, w, mirror };
      }
    }
  }
  if (best.s0 > 1e-6) pushEven(edges, 0, best.s0, bays(best.s0));
  const ix = edges.length - 1;
  const end = best.s0 + best.w;
  if (len - end > 1e-6) {
    edges.push(end);
    pushEven(edges, end, len, bays(len - end));
  } else {
    edges.push(len);
  }
  return { edges, door: ix, mirror: best.mirror };
}

/** Appends the far edges of k equal quads from a to b, the last exactly b. */
function pushEven(edges: number[], a: number, b: number, k: number): void {
  for (let i = 1; i < k; i++) edges.push(a + ((b - a) * i) / k);
  edges.push(b);
}

/** How many equal quads a stretch `part` m long beside a door gets: each as near BAY wide as can be, none narrower than BAY_MIN. */
function bays(part: number): number {
  const lo = Math.max(1, Math.floor(part / BAY));
  const hi = Math.max(lo, Math.min(lo + 1, Math.floor(part / BAY_MIN)));
  return Math.abs(part / hi - BAY) < Math.abs(part / lo - BAY) ? hi : lo;
}

/** Mean distance (m) from BAY of the quads of the stretches left and right of a door (0 for none). */
function stretch(left: number, right: number): number {
  let sum = 0;
  let n = 0;
  for (const part of [left, right]) {
    if (part <= 1e-6) continue;
    const k = bays(part);
    sum += k * Math.abs(part / k - BAY);
    n += k;
  }
  return n > 0 ? sum / n : 0;
}

/** The SPECIALS entry a special building stands for (none for the stadium and ordinary buildings). */
function specialDef(b: Building, block: Block): (typeof SPECIALS)[number] | undefined {
  const special = b.special;
  return special ? SPECIALS.find((s) => s.kind === special && s.bi === block.bi && s.bj === block.bj) : undefined;
}

/** The door cell of a building's entrance wall, or -1 when its ground floor has no single door (a row of shops, loading bays). */
function entranceCell(b: Building, sideIx: number): number {
  const r = hashInts(b.id, sideIx, 0xd00, 0xf00d) / 4294967296;
  switch (b.ground) {
    case 'lobby':
      return b.special === 'bank' ? CELLS.bank : r < 0.5 ? CELLS.lobbyRevolving : CELLS.lobbyDoors;
    case 'house':
      return r < 0.5 ? CELLS.houseDoorA : CELLS.houseDoorB;
    case 'shops':
      // Every gun shop quad is a barred pawn-shop front with its door; the entrance one is placed.
      return b.special === 'gunshop' ? PAWN : -1;
    default:
      return -1;
  }
}

/** The same atlas rectangle with u running the other way. */
function mirrored(uv: readonly [number, number, number, number]): [number, number, number, number] {
  return [uv[2], uv[1], uv[0], uv[3]];
}

/** Every texture the building materials sample (facade walls, glass and night masks, the storefront atlases). */
export function buildingTextures(view: CityView): THREE.Texture[] {
  const out = new Set<THREE.Texture>();
  for (const m of view.materials.facades.values()) for (const t of facadeTexturesOf(m)) out.add(t);
  const front = view.materials.storefront;
  if (front) for (const t of [front.map, front.emissiveMap, front.userData.interior as THREE.Texture | undefined]) if (t) out.add(t);
  return [...out];
}

export function buildBuildings(view: CityView): void {
  const layout = view.world.layout;
  const builders = new Map<FacadeStyle, GeoBuilder>();
  for (const s of STYLES) builders.set(s, new GeoBuilder(true, true));
  const roofs = new GeoBuilder(true);
  const front = new GeoBuilder(true, true);
  const decor = new GeoBuilder(true);
  const relief = new GeoBuilder(true);
  const rng = new Rng(4242);
  const farmhouses = new Set(layout.country.farms.farmsteads.map((f) => f.house));
  const landmarks = new Map(landmarkTowers(layout).map((l) => [l.id, l]));
  const atlas = storefrontAtlas();
  view.storefronts.clear();
  for (const f of storefrontPlan(layout)) view.storefronts.set(frontKey(f.building, f.side, f.index), f);

  for (const b of layout.buildings) {
    // The county's other buildings are drawn by its own code (Dry Creek's stores: town.ts; the valley's winery and ranch house: valley.ts).
    if (b.district === 'country' && !farmhouses.has(b.id)) continue;
    const gb = builders.get(b.style)!;
    // Per-building seed (k / 1000) for the night windows, so neighbours of one style never match; each tier's walls carry
    // it under their roof's height (facadeSeed).
    const night = (hashInts(b.id, 0x5eed) % 1000) / 1000;
    const cell = FACADE_CELL[b.style];
    const tints = STYLE_TINTS[b.style];
    const tint = hexToRgb(tints[Math.floor(b.tint * tints.length) % tints.length]!);
    const shade = 0.88 + rng.next() * 0.14;
    const color = scaleRgb(tint, shade);
    // A downtown glass tower's podium (the lowest of its three tiers, 10-16 m) is in stone with a pier between every
    // bay, so the shaft above reads as a tower standing on a base.
    const podium = (b.style === 'glassBlue' || b.style === 'glassTeal') && b.tiers.length >= 3;
    const podiumTints = STYLE_TINTS[PODIUM_STYLE];
    const podiumColor = scaleRgb(hexToRgb(podiumTints[Math.floor(b.tint * podiumTints.length) % podiumTints.length]!), shade);
    const offU = Math.floor(rng.next() * FACADE_COLS) / FACADE_COLS;
    const offV = Math.floor(rng.next() * FACADE_ROWS) / FACADE_ROWS;
    // The layout decided which sides get a ground floor (Building.groundSides).
    const block = b.ground !== 'none' ? blockOf(layout, b) : null;
    const street = new Set<Side>(block ? b.groundSides : []);
    // With a ground floor the window grid starts on top of it, on every wall so the rows meet at the corners.
    const baseY = CURB_H + (street.size > 0 ? b.groundH : 0);
    // Hotels run a balcony along every floor of their street walls; a little under half the apartment blocks have one at
    // every other window. Of the special buildings only the Hotel Salgado has them (the hospital, stucco, had them by its
    // hash).
    const balconyEvery = balconyStep(b);
    const escape = hasFireEscape(b);
    for (const t of b.tiers) {
      const stone = podium && t === b.tiers[0];
      const style = stone ? PODIUM_STYLE : b.style;
      const tg = builders.get(style)!;
      const tc = stone ? podiumColor : color;
      const tcell = FACADE_CELL[style];
      tg.seed = facadeSeed(t.y1, stone ? everyBay(night) : night);
      const uv = { kind: 'facade' as const, w: tcell.w * FACADE_COLS, h: tcell.h * FACADE_ROWS, offU, offV, baseY };
      if (t === b.tiers[0] && block && street.size > 0) groundTier(view, tg, front, decor, relief, b, block, t, street, uv, tc, style);
      else tg.box(t.minX, t.y0, t.minZ, t.maxX, t.y1, t.maxZ, { uv, color: tc, top: false });
      facadeRelief(relief, b, t, baseY, tc, style);
      const plainSides = plainStreetSides(b);
      if (balconyEvery > 0 && !landmarks.has(b.id)) balconies(decor, b, t, baseY, plainSides, wallTone(b, color), balconyEvery);
      if (escape && t === b.tiers[0]) fireEscape(decor, b, t, baseY, plainSides);
      if (b.style === 'house' && b.district !== 'country') houseShutters(relief, t, baseY, b.groundSides, offU * FACADE_COLS, offV * FACADE_ROWS);
      if (b.roof === 'gable' && t === b.tiers[b.tiers.length - 1]) gable(roofs, relief, decor, t, b, color);
      else {
        const rc = scaleRgb([0.55, 0.54, 0.52], 0.85 + rng.next() * 0.3);
        roofs.flat(t.minX, t.minZ, t.maxX, t.maxZ, t.y1, { kind: 'world', scale: 6 }, rc);
        // Parapet round every flat roof, flush with the walls below.
        const lip = PARAPET_H;
        const th = parapetThickness(t);
        const lc: RGB = [color[0] * 0.8, color[1] * 0.8, color[2] * 0.8];
        const pu = { kind: 'world' as const, scale: 4 };
        roofs.box(t.minX, t.y1, t.minZ, t.maxX, t.y1 + lip, t.minZ + th, { uv: pu, color: lc });
        roofs.box(t.minX, t.y1, t.maxZ - th, t.maxX, t.y1 + lip, t.maxZ, { uv: pu, color: lc });
        roofs.box(t.minX, t.y1, t.minZ + th, t.minX + th, t.y1 + lip, t.maxZ - th, { uv: pu, color: lc });
        roofs.box(t.maxX - th, t.y1, t.minZ + th, t.maxX, t.y1 + lip, t.maxZ - th, { uv: pu, color: lc });
        // A coping along the parapet's top in the trim's stone, standing a little proud of both faces: the roofline's
        // crisp edge against the sky, where it is seen from the street (on towers' upper roofs it is under a pixel).
        if (t.y1 <= COPING_MAX_Y) {
          const cp = trimColors(b, color).cap;
          const y = t.y1 + lip;
          const o = 0.06;
          const i = th + 0.03;
          relief.box(t.minX - o, y, t.minZ - o, t.maxX + o, y + COPING_H, t.minZ + i, { uv: TRIM_UV, color: cp });
          relief.box(t.minX - o, y, t.maxZ - i, t.maxX + o, y + COPING_H, t.maxZ + o, { uv: TRIM_UV, color: cp });
          relief.box(t.minX - o, y, t.minZ + i, t.minX + i, y + COPING_H, t.maxZ - i, { uv: TRIM_UV, color: cp });
          relief.box(t.maxX - i, y, t.minZ + i, t.maxX + o, y + COPING_H, t.maxZ - i, { uv: TRIM_UV, color: cp });
        }
        // Three brick and apartment blocks in five raise the middle of their street parapet in two steps, a name panel
        // that breaks the flat roofline seen along the street.
        if (t === b.tiers[b.tiers.length - 1] && t.y1 <= COPING_MAX_Y && (b.style === 'brick' || b.style === 'stucco') && b.groundSides.length > 0 && hashInts(b.id, 0x9a4a) / 4294967296 < 0.6) {
          raisedParapet(roofs, relief, t, b.sign?.side ?? b.groundSides[0]!, th, lc, trimColors(b, color).cap, hashInts(b.id, 0x9a4b) / 4294967296);
        }
      }
    }
    const lm = landmarks.get(b.id);
    if (lm) drawLandmark(gb, relief, b, lm, { kind: 'facade', w: cell.w * FACADE_COLS, h: cell.h * FACADE_ROWS, offU, offV, baseY }, color, night);
    else for (const it of rooftopItems(b)) drawRooftopItem(relief, it);
    if (b.sign) addSign(view, b, b.sign.text, b.sign.color, b.sign.side);
  }

  const nu = view.nightU;
  const bu = view.buildingU;
  STYLES.forEach((style, i) => {
    const mat = createFacadeMaterial(style, 100 + i, nu, bu);
    view.materials.facades.set(style, mat);
    const geo = builders.get(style)!.build();
    if (geo.getAttribute('position').count > 0) view.add(geo, mat, { shadow: true, name: `facade-${style}` });
  });
  // Two-sided: from the street a pitched roof's eaves, rakes and the attic gap above the walls are seen
  // from below. The shadow pass keeps drawing back faces only, as a one-sided material does.
  const roofMat = view.surface('roof');
  roofMat.vertexColors = true;
  roofMat.side = THREE.DoubleSide;
  roofMat.shadowSide = THREE.BackSide;
  withBuildingFog(roofMat, 'gta7-roof', bu);
  view.add(roofs.build(), roofMat, { shadow: true, name: 'roofs' });

  const frontMat = createStorefrontMaterial(atlas, { uOccupancy: nu.occupancy, uShopOcc: nu.shopOccupancy }, FRONT_FRAG_MAIN, NIGHT_HASH, bu);
  view.materials.storefront = frontMat;
  view.add(front.build(), frontMat, { shadow: true, name: 'storefronts' });
  const decorMat = withBuildingFog(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide }), DECOR_PROGRAM, bu);
  view.materials.decor = decorMat;
  view.add(decor.build(), decorMat, { shadow: true, name: 'ground-decor' });
  const reliefMat = view.surface('concrete');
  // A neutral albedo retains the per-building finish; concrete supplies microrelief.
  reliefMat.map = null;
  reliefMat.vertexColors = true;
  reliefMat.roughness = 0.78;
  withBuildingFog(reliefMat, 'gta7-building-trim', bu);
  view.add(relief.build(), reliefMat, { shadow: true, name: 'architectural-trim' });
}

/**
 * The ground tier of a building with street-facing walls: those walls stop at the top of the
 * ground floor and the band below becomes shop, lobby, house or loading-bay frontage; the other
 * walls stay full height.
 */
function groundTier(view: CityView, gb: GeoBuilder, front: GeoBuilder, decor: GeoBuilder, relief: GeoBuilder, b: Building, block: Block, t: Tier, street: Set<Side>, uv: UvMode, color: RGB, style: FacadeStyle): void {
  const w = t.maxX - t.minX;
  const d = t.maxZ - t.minZ;
  const lot = block.lot;
  const walls: TierWall[] = [
    { side: 'S', x0: t.minX, z0: t.maxZ, x1: t.maxX, z1: t.maxZ, u: 0, gap: lot.maxZ - t.maxZ },
    { side: 'E', x0: t.maxX, z0: t.maxZ, x1: t.maxX, z1: t.minZ, u: w, gap: lot.maxX - t.maxX },
    { side: 'N', x0: t.maxX, z0: t.minZ, x1: t.minX, z1: t.minZ, u: w + d, gap: t.minZ - lot.minZ },
    { side: 'W', x0: t.minX, z0: t.minZ, x1: t.minX, z1: t.maxZ, u: 2 * w + d, gap: t.minX - lot.minX },
  ];
  const entrance = entranceSide(b, block, walls.filter((wl) => street.has(wl.side)));
  // The sim and the missions put a special's entrance at its POI marker on the sidewalk.
  const def = specialDef(b, block);
  const poi = def ? view.world.layout.pois.find((p) => p.id === def.id) : undefined;
  const top = t.y0 + b.groundH;
  const piers = b.ground !== 'house';
  const { trim } = trimColors(b, color, style);
  for (const wl of walls) {
    if (!street.has(wl.side)) {
      gb.wall(wl.x0, wl.z0, wl.x1, wl.z1, t.y0, t.y1, uv, color, wl.u);
      continue;
    }
    gb.wall(wl.x0, wl.z0, wl.x1, wl.z1, top, t.y1, uv, color, wl.u);
    const main = wl.side === entrance;
    const edges = frontage(view, front, decor, b, wl, t.y0, top, color, main, main && poi ? poi : null);
    if (piers) for (const e of edges.slice(1, -1)) pilaster(relief, wl, e, t.y0, top, trim);
  }
  // A pier on every corner of the band that turns onto a street wall, clasping the corner as the piers above do.
  if (piers) {
    for (const [x, z, sx, sz, a, c] of [
      [t.minX, t.maxZ, -1, 1, 'W', 'S'],
      [t.maxX, t.maxZ, 1, 1, 'S', 'E'],
      [t.maxX, t.minZ, 1, -1, 'E', 'N'],
      [t.minX, t.minZ, -1, -1, 'N', 'W'],
    ] as const) {
      if (!street.has(a) && !street.has(c)) continue;
      const xs = [x + sx * PIER_OUT, x - sx * (PIER_W - PIER_OUT)];
      const zs = [z + sz * PIER_OUT, z - sz * (PIER_W - PIER_OUT)];
      relief.box(Math.min(...xs), t.y0 - 0.02, Math.min(...zs), Math.max(...xs), top - 0.07, Math.max(...zs), { uv: TRIM_UV, color: trim, top: false });
    }
  }
}

/** Every how many window columns a building has a balcony on its street walls' storeys (0: none). */
export function balconyStep(b: Building): number {
  if (b.groundSides.length === 0 || (b.special && b.special !== 'contactVera')) return 0;
  if (b.style === 'hotel') return 1;
  return b.style === 'stucco' && hashInts(b.id, 0xba1c) / 4294967296 < 0.45 ? 2 : 0;
}

/** Whether a brick block has a fire escape down a street wall: two in three, no special building. */
export function hasFireEscape(b: Building): boolean {
  return b.groundSides.length > 0 && b.style === 'brick' && !b.special && hashInts(b.id, 0xe5c) / 4294967296 < 0.65;
}

/** The street walls a balcony or fire escape may take: not the one carrying a sign, which stands over the first storey. */
export function plainStreetSides(b: Building): Side[] {
  return b.groundSides.filter((s) => s !== b.sign?.side);
}

/** The facade of a glass tower's podium. */
const PODIUM_STYLE: FacadeStyle = 'office';

/**
 * A night seed (whole thousandths) near `night` that the facade shader reads as an office with a pier between every
 * bay (it takes the thousandths modulo 3: 0 a ribbon, 1 every other bay, 2 every bay).
 */
export function everyBay(night: number): number {
  const k = Math.round(night * 1000);
  const e = k - (k % 3) + 2;
  return (e > 999 ? e - 3 : e) / 1000;
}

/** Roofs (m) up to which parapets carry a coping. */
const COPING_MAX_Y = 45;

/**
 * A raised middle to the parapet over wall `side` of a flat roof: a panel 0.9 m over the coping, between shoulders half
 * as high, 30-45% of the wall long (`r` picks where in that), each stepped part capped in the trim's stone.
 */
function raisedParapet(roofs: GeoBuilder, relief: GeoBuilder, t: Tier, side: Side, th: number, wall: RGB, cap: RGB, r: number): void {
  const ns = side === 'N' || side === 'S';
  const len = ns ? t.maxX - t.minX : t.maxZ - t.minZ;
  const mid = len * (0.3 + 0.15 * r);
  if (mid < 3) return;
  const y = t.y1 + PARAPET_H + COPING_H;
  const c = ns ? (t.minX + t.maxX) / 2 : (t.minZ + t.maxZ) / 2;
  const [n0, n1] = side === 'S' ? [t.maxZ - th, t.maxZ] : side === 'N' ? [t.minZ, t.minZ + th] : side === 'E' ? [t.maxX - th, t.maxX] : [t.minX, t.minX + th];
  const pu = { kind: 'world' as const, scale: 4 };
  // The middle stands on the shoulders' coping, which runs on under it as a course.
  for (const [half, base, rise] of [[mid / 2 + 0.8, 0, 0.45], [mid / 2, 0.52, 0.9]] as const) {
    const [x0, x1, z0, z1] = ns ? [c - half, c + half, n0, n1] : [n0, n1, c - half, c + half];
    roofs.box(x0, y + base, z0, x1, y + rise, z1, { uv: pu, color: wall, top: false });
    relief.box(x0 - 0.04, y + rise, z0 - 0.04, x1 + 0.04, y + rise + COPING_H, z1 + 0.04, { uv: TRIM_UV, color: cap, bottom: true });
  }
}

/** Width (m) of the piers between the bays of a ground floor, and how far they stand out from the wall. */
export const PIER_W = 0.32;
export const PIER_OUT = 0.1;
const TRIM_UV = { kind: 'world', scale: 3 } as const;

/** A pier `along` metres down a street wall's band, from the pavement to under the band's cornice. */
function pilaster(g: GeoBuilder, wl: TierWall, along: number, y0: number, y1: number, color: RGB): void {
  const len = Math.hypot(wl.x1 - wl.x0, wl.z1 - wl.z0);
  const ux = (wl.x1 - wl.x0) / len;
  const uz = (wl.z1 - wl.z0) / len;
  const nx = -uz;
  const nz = ux;
  const cx = wl.x0 + ux * along;
  const cz = wl.z0 + uz * along;
  const xs = [cx - ux * (PIER_W / 2) - nx * 0.05, cx + ux * (PIER_W / 2) + nx * PIER_OUT];
  const zs = [cz - uz * (PIER_W / 2) - nz * 0.05, cz + uz * (PIER_W / 2) + nz * PIER_OUT];
  g.box(Math.min(...xs), y0 - 0.02, Math.min(...zs), Math.max(...xs), y1 - 0.07, Math.max(...zs), { uv: TRIM_UV, color, top: false });
}

/** The side that gets the main door: a special's entrance side, else the street side nearest its lot edge (then the longest). */
function entranceSide(b: Building, block: Block, walls: TierWall[]): Side {
  const sides = new Set(walls.map((wl) => wl.side));
  if (b.special) {
    const def = specialDef(b, block);
    if (def && sides.has(def.side)) return def.side;
    if (b.sign && sides.has(b.sign.side)) return b.sign.side;
  }
  const len = (wl: TierWall) => Math.abs(wl.x1 - wl.x0) + Math.abs(wl.z1 - wl.z0);
  return walls.reduce((best, wl) => (wl.gap < best.gap - 0.01 || (Math.abs(wl.gap - best.gap) <= 0.01 && len(wl) > len(best)) ? wl : best)).side;
}

/**
 * Frontage quads (about 6.5 m each, see frontageSplit) for the band of one street-facing wall, plus
 * their awnings, canopies and porches; returns the quads' edges along the wall. The entrance wall's
 * door stands in front of `marker` (a special's POI) or in the middle of the wall.
 */
function frontage(view: CityView, front: GeoBuilder, decor: GeoBuilder, b: Building, wl: TierWall, y0: number, y1: number, wallColor: RGB, entrance: boolean, marker: { x: number; z: number } | null): number[] {
  const len = Math.hypot(wl.x1 - wl.x0, wl.z1 - wl.z0);
  const ux = (wl.x1 - wl.x0) / len;
  const uz = (wl.z1 - wl.z0) / len;
  const special = b.special;
  const sideIx = SIDE_INDEX[wl.side];
  const doorCell = entrance ? entranceCell(b, sideIx) : -1;
  const doorU = doorCell >= 0 ? DOOR_U[doorCell]! : 0.5;
  // A marker's spot is where the sim puts the entrance; mid-wall is only tidier.
  const spot = marker ? { at: clamp((marker.x - wl.x0) * ux + (marker.z - wl.z0) * uz, 0, len), u: doorU, pull: 2 } : { at: len / 2, u: doorU, pull: 0.3 };
  const split = frontageSplit(len, doorCell >= 0 ? spot : null);
  for (let i = 0; i + 1 < split.edges.length; i++) {
    const s0 = split.edges[i]!;
    const seg = split.edges[i + 1]! - s0;
    const ax = wl.x0 + ux * s0;
    const az = wl.z0 + uz * s0;
    const bx = ax + ux * seg;
    const bz = az + uz * seg;
    const door = i === split.door;
    // Where the door quad's door stands along it (mirroring moves it across).
    const doorAlong = seg * (split.mirror ? 1 - doorU : doorU);
    if (door) view.entrances.set(b.id, { side: wl.side, x: ax + ux * doorAlong, z: az + uz * doorAlong });
    const h = hashInts(b.id, sideIx, i, 0xf00d);
    const rnd = (k: number) => hashInts(h, k) / 4294967296;
    /** Frontage seed: class in the integer part, a whole number of thousandths as the fraction. */
    const seed = (cls: number) => cls + (hashInts(h, 99) % 1000) / 1000;
    let cell: number;
    let cls: number;
    let tint: RGB = WHITE;
    switch (b.ground) {
      case 'shops': {
        if (special === 'gunshop') {
          // Bang Bang Guns: a barred display under the big sign, on a plain dark fascia.
          const fascia = y0 + (y1 - y0) * (1 - SHOP_FASCIA_FRAC);
          const display = storefrontUv(PAWN, SHOP_FASCIA_FRAC, 1);
          front.seed = seed(FRONT_LAMP);
          const flip = door && split.mirror;
          frontQuad(front, ax, az, bx, bz, y0, fascia, flip ? mirrored(display) : display, flip, WHITE, DOOR_OPENING[PAWN], { w: CELL_DESIGN.shop.w, h: CELL_DESIGN.shop.h * (1 - SHOP_FASCIA_FRAC) });
          quadUv(front, ax, az, bx, bz, fascia, y1, swatchUv(SWATCHES.gunFascia), WHITE);
          continue;
        }
        const plan = view.storefronts.get(frontKey(b.id, wl.side, i));
        cell = plan?.shop ?? 0;
        cls = FRONT_SHOP;
        if (plan && plan.awning !== 'none') awning(decor, ax, az, bx, bz, ux, uz, y0, y1, wl.gap, linearRgb(plan.color), plan.awning);
        else if (rnd(6) < 0.5) planter(decor, ax + ux * seg * 0.5, az + uz * seg * 0.5, ux, uz, y0, Math.min(1.6, seg * 0.3), rnd(7));
        break;
      }
      case 'lobby': {
        // The plain lobby glass takes its three designs in turn, so neighbours never match.
        cell = door ? doorCell : LOBBY_GLASS[(i + (hashInts(b.id, sideIx, 0x10bb) % 3)) % 3]!;
        cls = FRONT_LOBBY;
        if (!door && i % 2 === 0) planter(decor, ax + ux * seg * 0.5, az + uz * seg * 0.5, ux, uz, y0, Math.min(2.2, seg * 0.36), rnd(7));
        if (door && special === 'bank') steps(decor, ax, az, bx, bz, ux, uz, y0);
        else if (door) canopy(decor, ax, az, bx, bz, ux, uz, y0, y1, wl.gap, special);
        break;
      }
      case 'house': {
        cell = door ? doorCell : CELLS.houseWindows;
        cls = FRONT_HOME;
        tint = wallColor;
        // Hollister Farm's farmhouse wears a farmhouse porch across its front instead (render/city/attractions.ts).
        if (door && b.id !== attractionOf(view.world.layout, 'farm').anchors.house) porch(decor, ax, az, ux, uz, doorAlong, y0, b);
        break;
      }
      case 'loading':
      default:
        cell = CELLS.rollup;
        cls = FRONT_LAMP;
        hood(decor, ax, az, bx, bz, ux, uz, y0, y1);
        break;
    }
    front.seed = seed(cls);
    // Plain glass and window cells are mirrored on every other quad to break up the repeat; a door
    // quad is mirrored when that brings its door to its spot.
    const flip = door ? split.mirror : ((LOBBY_GLASS as readonly number[]).includes(cell) || cell === CELLS.houseWindows) && i % 2 === 1;
    const uv = storefrontUv(cell);
    frontQuad(front, ax, az, bx, bz, y0, y1, flip ? mirrored(uv) : uv, flip, tint, DOOR_OPENING[cell], cellDesign(cell));
  }
  return split.edges;
}

/** The frontage (width, height in metres) an atlas cell is drawn for. */
function cellDesign(cell: number): { w: number; h: number } {
  if (cell < CELLS.lobbyRevolving) return CELL_DESIGN.shop;
  if (cell === CELLS.rollup) return CELL_DESIGN.rollup;
  if (cell === CELLS.houseDoorA || cell === CELLS.houseDoorB || cell === CELLS.houseWindows) return CELL_DESIGN.house;
  return CELL_DESIGN.lobby;
}

/**
 * A frontage quad (as quadUv), its doorway set back by the opening's depth behind the wall, with reveals either side,
 * a soffit over it and a threshold under it, each taking the cell's colour just outside the doorway. `design` is the
 * part of the cell the quad shows, in metres as drawn; `mirror` says the quad's uv run the other way.
 */
function frontQuad(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, uv: readonly [number, number, number, number], mirror: boolean, color: RGB, opening: DoorOpening | undefined, design: { w: number; h: number }): void {
  if (!opening) {
    quadUv(g, ax, az, bx, bz, y0, y1, uv, color);
    return;
  }
  const seg = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / seg;
  const uz = (bz - az) / seg;
  // Outward normal of the wall; the doorway is set back along -n.
  const nx = -uz;
  const nz = ux;
  const band = y1 - y0;
  const [u0, v0, u1, v1] = uv;
  const U = (s: number) => u0 + ((u1 - u0) * clamp(s, 0, seg)) / seg;
  const V = (h: number) => v0 + ((v1 - v0) * clamp(h, 0, band)) / band;
  const sx = seg / design.w;
  const sy = band / design.h;
  const s0 = mirror ? seg - opening.x1 * sx : opening.x0 * sx;
  const s1 = mirror ? seg - opening.x0 * sx : opening.x1 * sx;
  const h0 = opening.floor ?? opening.y0 * sy;
  const h1 = opening.y1 * sy;
  const d = opening.depth;
  const P = (s: number, h: number, o: number): [number, number, number] => [ax + ux * s - nx * o, y0 + h, az + uz * s - nz * o];
  const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], e: [number, number, number], uvs: number[]) => g.quad(...a, ...b, ...c, ...e, uvs, color);
  const piece = (sa: number, sb: number, ha: number, hb: number, o: number) => {
    if (sb - sa < 1e-4 || hb - ha < 1e-4) return;
    quad(P(sa, ha, o), P(sb, ha, o), P(sb, hb, o), P(sa, hb, o), [U(sa), V(ha), U(sb), V(ha), U(sb), V(hb), U(sa), V(hb)]);
  };
  // The wall round the doorway, then the door set back.
  piece(0, s0, 0, band, 0);
  piece(s1, seg, 0, band, 0);
  piece(s0, s1, h1, band, 0);
  piece(s0, s1, 0, h0, 0);
  piece(s0, s1, h0, h1, d);
  const out = 0.03;
  // Reveals, facing into the doorway.
  const ul = U(s0 - out);
  const ur = U(s1 + out);
  quad(P(s0, h0, 0), P(s0, h0, d), P(s0, h1, d), P(s0, h1, 0), [ul, V(h0), ul, V(h0), ul, V(h1), ul, V(h1)]);
  quad(P(s1, h0, d), P(s1, h0, 0), P(s1, h1, 0), P(s1, h1, d), [ur, V(h0), ur, V(h0), ur, V(h1), ur, V(h1)]);
  // Soffit (facing down) and threshold (facing up, just clear of the ground under the building).
  const vs = V(h1 + out);
  quad(P(s0, h1, d), P(s1, h1, d), P(s1, h1, 0), P(s0, h1, 0), [U(s0), vs, U(s1), vs, U(s1), vs, U(s0), vs]);
  const vt = V(h0 > 0 ? h0 - out : 0.01);
  const lift = h0 > 0 ? 0 : 0.006;
  quad(P(s0, h0 + lift, 0), P(s1, h0 + lift, 0), P(s1, h0 + lift, d), P(s0, h0 + lift, d), [U(s0), vt, U(s1), vt, U(s1), vt, U(s0), vt]);
}

/** Awning depth (m) out from the wall over a frontage whose wall stands `gap` m from its lot edge. */
export function awningDepth(gap: number): number {
  return Math.min(1.5, Math.max(0.8, gap + 0.3));
}

/**
 * A fabric awning over a shop window: sloped (plain or striped, with a valance and side cheeks), a rounded dome, or
 * a flat box canopy. All are double-sided geometry, so their undersides show from the street.
 */
function awning(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, ux: number, uz: number, y0: number, y1: number, gap: number, color: RGB, style: AwningStyle): void {
  const nx = -uz;
  const nz = ux;
  const depth = awningDepth(gap);
  const top = y0 + (y1 - y0) * (1 - SHOP_AWNING_TOP / CELL_DESIGN.shop.h);
  const m = 0.22;
  const sx = ax + ux * m;
  const sz = az + uz * m;
  const len = Math.hypot(bx - ax, bz - az) - 2 * m;
  const cream: RGB = [0.92, 0.89, 0.82];
  const uv4 = [0, 0, 1, 0, 1, 1, 0, 1];
  if (style === 'box') {
    const mx = sx + (ux * len) / 2;
    const mz = sz + (uz * len) / 2;
    boxAround(g, mx + nx * (depth / 2), mz + nz * (depth / 2), Math.abs(ux) * len + Math.abs(nx) * depth, Math.abs(uz) * len + Math.abs(nz) * depth, top - 0.3, top - 0.08, color);
    boxAround(g, mx + nx * (depth - 0.02), mz + nz * (depth - 0.02), Math.abs(ux) * len + Math.abs(nx) * 0.04, Math.abs(uz) * len + Math.abs(nz) * 0.04, top - 0.42, top - 0.08, scaleRgb(color, 0.7));
    return;
  }
  if (style === 'dome') {
    // A quarter-round profile from the wall out and down, in strips along the window.
    const seg = 5;
    const rise = 0.75;
    const prof = Array.from({ length: seg + 1 }, (_, k) => {
      const a = (k / seg) * (Math.PI / 2);
      return [Math.sin(a) * depth, top - (1 - Math.cos(a)) * rise] as const;
    });
    for (let k = 0; k < seg; k++) {
      const [o0, h0] = prof[k]!;
      const [o1, h1] = prof[k + 1]!;
      const c = scaleRgb(color, 0.9 + 0.1 * (k % 2));
      g.quad(sx + nx * o1, h1, sz + nz * o1, sx + ux * len + nx * o1, h1, sz + uz * len + nz * o1, sx + ux * len + nx * o0, h0, sz + uz * len + nz * o0, sx + nx * o0, h0, sz + nz * o0, uv4, c);
      g.tri(sx, h1, sz, sx + nx * o1, h1, sz + nz * o1, sx + nx * o0, h0, sz + nz * o0, [0, 0, 1, 0, 1, 1], color);
      g.tri(sx + ux * len + nx * o0, h0, sz + uz * len + nz * o0, sx + ux * len + nx * o1, h1, sz + uz * len + nz * o1, sx + ux * len, h1, sz + uz * len, [0, 0, 1, 0, 1, 1], color);
    }
    return;
  }
  const striped = style === 'striped';
  const low = top - 0.45;
  const val = 0.28;
  const stripes = striped ? Math.max(2, Math.round(len / 0.45)) : 1;
  for (let k = 0; k < stripes; k++) {
    const c = striped && k % 2 === 1 ? cream : color;
    const p0x = sx + ux * ((len * k) / stripes);
    const p0z = sz + uz * ((len * k) / stripes);
    const p1x = sx + ux * ((len * (k + 1)) / stripes);
    const p1z = sz + uz * ((len * (k + 1)) / stripes);
    // Sloped top, from the wall out and down.
    g.quad(p0x + nx * depth, low, p0z + nz * depth, p1x + nx * depth, low, p1z + nz * depth, p1x, top, p1z, p0x, top, p0z, uv4, c);
    // Valance hanging from the front edge.
    g.quad(p0x + nx * depth, low - val, p0z + nz * depth, p1x + nx * depth, low - val, p1z + nz * depth, p1x + nx * depth, low, p1z + nz * depth, p0x + nx * depth, low, p0z + nz * depth, uv4, c);
  }
  const ex = sx + ux * len;
  const ez = sz + uz * len;
  g.tri(sx, top, sz, sx + nx * depth, low, sz + nz * depth, sx + nx * depth, low - val, sz + nz * depth, [0, 0, 1, 0, 1, 1], color);
  g.tri(ex + nx * depth, low - val, ez + nz * depth, ex + nx * depth, low, ez + nz * depth, ex, top, ez, [0, 0, 1, 0, 1, 1], color);
}

/** Depth (m) of a planter standing against a wall. */
export const PLANTER_DEPTH = 0.55;

/** A planter box with clipped shrubs, `w` m long, its back against the wall at (cx, cz). */
function planter(g: GeoBuilder, cx: number, cz: number, ux: number, uz: number, y0: number, w: number, r: number): void {
  const nx = -uz;
  const nz = ux;
  const d = PLANTER_DEPTH;
  const box = r < 0.5 ? ([0.56, 0.36, 0.26] as RGB) : ([0.6, 0.6, 0.58] as RGB);
  const px = cx + nx * (0.03 + d / 2);
  const pz = cz + nz * (0.03 + d / 2);
  const span = (a: number, b: number): [number, number] => [Math.abs(ux) * a + Math.abs(nx) * b, Math.abs(uz) * a + Math.abs(nz) * b];
  let [sx, sz] = span(w, d);
  boxAround(g, px, pz, sx, sz, y0 - 0.02, y0 + 0.5, box);
  const n = Math.max(2, Math.round(w / 0.5));
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n - 0.5;
    const h = 0.35 + 0.25 * (((k * 7 + Math.floor(r * 13)) % 5) / 4);
    const green: RGB = [0.15 + 0.05 * (k % 3), 0.34 + 0.06 * ((k + 1) % 3), 0.13];
    [sx, sz] = span(w / n - 0.04, d - 0.12);
    boxAround(g, px + ux * t * w, pz + uz * t * w, sx, sz, y0 + 0.5, y0 + 0.5 + h, green);
  }
}

/** A cantilevered slab over a lobby entrance. */
function canopy(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, ux: number, uz: number, y0: number, y1: number, gap: number, special: Building['special']): void {
  const nx = -uz;
  const nz = ux;
  const len = Math.hypot(bx - ax, bz - az);
  const width = Math.min(len * 0.8, 4.6);
  const depth = Math.min(2.4, Math.max(1.4, gap + 0.8));
  const y = y0 + Math.min(4.3, (y1 - y0) * 0.62);
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  const col: RGB = special === 'police' ? [0.05, 0.12, 0.45] : special === 'hospital' ? [0.62, 0.06, 0.06] : [0.12, 0.13, 0.15];
  boxAround(g, mx + nx * (depth / 2), mz + nz * (depth / 2), Math.abs(ux) * width + Math.abs(nx) * depth, Math.abs(uz) * width + Math.abs(nz) * depth, y, y + 0.24, col);
  // A light trim along the front edge.
  boxAround(g, mx + nx * (depth - 0.03), mz + nz * (depth - 0.03), Math.abs(ux) * width + Math.abs(nx) * 0.06, Math.abs(uz) * width + Math.abs(nz) * 0.06, y + 0.24, y + 0.3, [0.75, 0.76, 0.78]);
}

/** Three broad stone steps up to the bank's doors, the top one level with its doorway's floor (BANK_STEP_TOP). */
function steps(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, ux: number, uz: number, y0: number): void {
  const nx = -uz;
  const nz = ux;
  const len = Math.hypot(bx - ax, bz - az);
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  const stone: RGB = [0.62, 0.58, 0.5];
  for (let k = 0; k < 3; k++) {
    const depth = 1.05 - k * 0.35;
    const width = len * 0.9 - k * 0.3;
    boxAround(g, mx + nx * (depth / 2), mz + nz * (depth / 2), Math.abs(ux) * width + Math.abs(nx) * depth, Math.abs(uz) * width + Math.abs(nz) * depth, y0 - 0.02, y0 + (BANK_STEP_TOP / 3) * (k + 1), scaleRgb(stone, 1 - k * 0.04));
  }
}

/** Porch deck, a step, two posts and a small roof in front of a house door `along` metres from (ax, az). */
function porch(g: GeoBuilder, ax: number, az: number, ux: number, uz: number, along: number, y0: number, b: Building): void {
  const nx = -uz;
  const nz = ux;
  const cx = ax + ux * along;
  const cz = az + uz * along;
  const deckW = 2.5;
  const deckD = 1.6;
  const deckTop = y0 + HOUSE_SILL;
  const span = (w: number, dpt: number): [number, number] => [Math.abs(ux) * w + Math.abs(nx) * dpt, Math.abs(uz) * w + Math.abs(nz) * dpt];
  const wood: RGB = [0.42, 0.3, 0.21];
  const white: RGB = [0.9, 0.9, 0.87];
  const roofCol: RGB = b.tint > 0.5 ? [0.55, 0.22, 0.18] : [0.32, 0.33, 0.36];
  let [sx, sz] = span(deckW, deckD);
  boxAround(g, cx + nx * (deckD / 2), cz + nz * (deckD / 2), sx, sz, y0 - 0.02, deckTop, wood);
  [sx, sz] = span(1.4, 0.4);
  boxAround(g, cx + nx * (deckD + 0.2), cz + nz * (deckD + 0.2), sx, sz, y0 - 0.02, y0 + HOUSE_SILL / 2, [0.6, 0.6, 0.58]);
  const roofY = y0 + 2.75;
  for (const side of [-1, 1]) {
    const px = cx + ux * side * (deckW / 2 - 0.12) + nx * (deckD - 0.12);
    const pz = cz + uz * side * (deckW / 2 - 0.12) + nz * (deckD - 0.12);
    boxAround(g, px, pz, 0.12, 0.12, deckTop, roofY, white);
  }
  [sx, sz] = span(deckW + 0.4, deckD + 0.25);
  boxAround(g, cx + nx * ((deckD + 0.25) / 2), cz + nz * ((deckD + 0.25) / 2), sx, sz, roofY, roofY + 0.14, roofCol);
}

/** A sheet-metal hood over a loading-bay door. */
function hood(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, ux: number, uz: number, y0: number, y1: number): void {
  const nx = -uz;
  const nz = ux;
  const len = Math.hypot(bx - ax, bz - az);
  // Over the door's housing (0.35-5.05 m across the 6.5 m cell), 0.45 m below the top of the 5 m band.
  const c0 = (0.35 / CELL_DESIGN.rollup.w) * len;
  const c1 = (5.05 / CELL_DESIGN.rollup.w) * len;
  const mx = ax + ux * ((c0 + c1) / 2);
  const mz = az + uz * ((c0 + c1) / 2);
  const y = y0 + (y1 - y0) * (1 - 0.45 / CELL_DESIGN.rollup.h);
  const w = c1 - c0;
  boxAround(g, mx + nx * 0.3, mz + nz * 0.3, Math.abs(ux) * w + Math.abs(nx) * 0.6, Math.abs(uz) * w + Math.abs(nz) * 0.6, y, y + 0.12, [0.3, 0.32, 0.34]);
}

/** Lap boards (m) of a house's gable end, and how far the foot of each stands out over the board below. */
const SIDING_COURSE = 0.2;
const SIDING_LAP = 0.03;
/** Eaves and rake overhang (m) of a pitched roof. */
const EAVES = 0.4;
const ROOF_TRIM: RGB = [0.82, 0.8, 0.74];

/** The colour a facade paints its wall in: the building's tint times its style's base, as the facade shader has it. */
function wallTone(b: Building, color: RGB): RGB {
  const base = linearRgb(FACADE_LOOK[b.style].base);
  return [color[0] * base[0], color[1] * base[1], color[2] * base[2]];
}

/**
 * A quad a, b, c, d whose winding is turned, if need be, so it faces `want` (a direction). c and d may be one point (a
 * triangle): GeoBuilder takes the normal from the first three corners, so the turned quad starts b, a, d.
 */
function facing(g: GeoBuilder, p: ReadonlyArray<readonly [number, number, number]>, want: readonly [number, number, number], color: RGB): void {
  const [a, b, c, d] = p as [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const q = n[0]! * want[0] + n[1]! * want[1] + n[2]! * want[2] >= 0 ? [a, b, c, d] : [b, a, d, c];
  g.quad(...q[0]!, ...q[1]!, ...q[2]!, ...q[3]!, [0, 0, 1, 0, 1, 1, 0, 1], color);
}

/**
 * Pitched roof along the longer side, with its trim: the gable ends in the wall's colour (a house's in lap boards round
 * an attic vent), fascia boards along the eaves, barge boards up the rakes and a ridge cap; a house gets a chimney and
 * downpipes at two corners. The county's farmhouses keep their plain roofs.
 */
function gable(roofs: GeoBuilder, relief: GeoBuilder, decor: GeoBuilder, t: Tier, b: Building, wallColor: RGB): void {
  const w = t.maxX - t.minX;
  const d = t.maxZ - t.minZ;
  const h = Math.min(w, d) * 0.35;
  const y = t.y1;
  const roofCol: RGB = b.tint > 0.5 ? [0.55, 0.22, 0.18] : [0.32, 0.33, 0.36];
  const o = EAVES;
  // Local frame: p runs along the ridge, q across it.
  const alongX = w >= d;
  const P = (p: number, q: number, yy: number): [number, number, number] => (alongX ? [p, yy, q] : [q, yy, p]);
  const dirP = (sgn: number): [number, number, number] => (alongX ? [sgn, 0, 0] : [0, 0, sgn]);
  const dirQ = (sgn: number): [number, number, number] => (alongX ? [0, 0, sgn] : [sgn, 0, 0]);
  const p0 = alongX ? t.minX : t.minZ;
  const p1 = alongX ? t.maxX : t.maxZ;
  const q0 = alongX ? t.minZ : t.minX;
  const q1 = alongX ? t.maxZ : t.maxX;
  const qm = (q0 + q1) / 2;
  const half = (q1 - q0) / 2;
  // The two roof slopes.
  for (const s of [-1, 1]) {
    const qe = qm + s * (half + o);
    facing(roofs, [P(p0 - o, qe, y - 0.1), P(p1 + o, qe, y - 0.1), P(p1 + o, qm, y + h), P(p0 - o, qm, y + h)], [dirQ(s)[0], 1, dirQ(s)[2]], roofCol);
  }
  if (b.district === 'country') {
    // The county's farmhouses keep their plain gable ends, in the wall's tint on the roof's material.
    for (const s of [-1, 1]) {
      const pe = s < 0 ? p0 : p1;
      facing(roofs, [P(pe, q0, y), P(pe, q1, y), P(pe, qm, y + h), P(pe, qm, y + h)], dirP(s), wallColor);
    }
    return;
  }
  const house = b.style === 'house';
  const gableCol = wallTone(b, wallColor);
  for (const s of [-1, 1]) {
    const pe = s < 0 ? p0 : p1;
    const out = dirP(s);
    if (house) {
      // Lap boards, each course's foot standing out over the one below.
      const halfAt = (yy: number) => half * Math.max(0, 1 - (yy - y) / h);
      for (let ya = y; ya < y + h - 1e-3; ya += SIDING_COURSE) {
        const yb = Math.min(ya + SIDING_COURSE, y + h);
        const a = pe + s * SIDING_LAP;
        const c = pe + s * 0.004;
        facing(relief, [P(a, qm - halfAt(ya), ya), P(a, qm + halfAt(ya), ya), P(c, qm + halfAt(yb), yb), P(c, qm - halfAt(yb), yb)], out, gableCol);
      }
      // A louvred vent under the apex.
      const vy = y + h * 0.42;
      const vw = Math.min(0.6, half * 0.4);
      const vb = alongX ? { x0: pe - 0.02, x1: pe + s * 0.07, z0: qm - vw / 2, z1: qm + vw / 2 } : { x0: qm - vw / 2, x1: qm + vw / 2, z0: pe - 0.02, z1: pe + s * 0.07 };
      relief.box(Math.min(vb.x0, vb.x1), vy, Math.min(vb.z0, vb.z1), Math.max(vb.x0, vb.x1), vy + vw * 0.75, Math.max(vb.z0, vb.z1), { uv: TRIM_UV, color: ROOF_TRIM });
      const f = pe + s * 0.072;
      const i = 0.06;
      facing(relief, [P(f, qm - vw / 2 + i, vy + i), P(f, qm + vw / 2 - i, vy + i), P(f, qm + vw / 2 - i, vy + vw * 0.75 - i), P(f, qm - vw / 2 + i, vy + vw * 0.75 - i)], out, [0.06, 0.06, 0.07]);
    } else {
      facing(relief, [P(pe, q0, y), P(pe, q1, y), P(pe, qm, y + h), P(pe, qm, y + h)], out, gableCol);
    }
    // Barge boards up both rakes, 0.18 m deep under the roof's edge, just proud of the gable.
    const pb = pe + s * (o + 0.005);
    for (const r of [-1, 1]) {
      const qe = qm + r * (half + o);
      facing(decor, [P(pb, qe, y - 0.1 - 0.18), P(pb, qm, y + h - 0.18), P(pb, qm, y + h + 0.02), P(pb, qe, y - 0.08)], out, ROOF_TRIM);
    }
  }
  // Fascia boards along the eaves, and the ridge cap.
  for (const s of [-1, 1]) {
    const qe = qm + s * (half + o);
    const [ax, , az] = P(p0 - o - 0.02, qe - 0.03, 0);
    const [bx, , bz] = P(p1 + o + 0.02, qe + 0.03, 0);
    relief.box(Math.min(ax, bx), y - 0.28, Math.min(az, bz), Math.max(ax, bx), y - 0.07, Math.max(az, bz), { uv: TRIM_UV, color: ROOF_TRIM, bottom: true });
  }
  {
    const [ax, , az] = P(p0 - o, qm - 0.09, 0);
    const [bx, , bz] = P(p1 + o, qm + 0.09, 0);
    roofs.box(Math.min(ax, bx), y + h - 0.05, Math.min(az, bz), Math.max(ax, bx), y + h + 0.06, Math.max(az, bz), { uv: { kind: 'world', scale: 6 }, color: scaleRgb(roofCol, 0.75) });
  }
  if (!house) return;
  const r = (k: number) => hashInts(b.id, k, 0xc41) / 4294967296;
  // A chimney through one slope near a gable end, in brick or in the wall's render.
  if (r(1) < 0.75) {
    const pc = p0 + (p1 - p0) * (r(2) < 0.5 ? 0.2 : 0.8);
    const qc = qm + (r(3) < 0.5 ? -1 : 1) * Math.min(0.9, half * 0.35);
    const col: RGB = r(4) < 0.55 ? [0.36, 0.15, 0.1] : gableCol;
    const [ax, , az] = P(pc - 0.33, qc - 0.3, 0);
    const [bx, , bz] = P(pc + 0.33, qc + 0.3, 0);
    relief.box(Math.min(ax, bx), y, Math.min(az, bz), Math.max(ax, bx), y + h + 0.9, Math.max(az, bz), { uv: TRIM_UV, color: col, top: false });
    relief.box(Math.min(ax, bx) - 0.06, y + h + 0.9, Math.min(az, bz) - 0.06, Math.max(ax, bx) + 0.06, y + h + 0.98, Math.max(az, bz) + 0.06, { uv: TRIM_UV, color: [0.5, 0.49, 0.46], bottom: true });
  }
  // Downpipes from the eaves at two opposite corners.
  if (b.tiers.length === 1) {
    for (const [pp, s] of [[p0 + 0.16, 1], [p1 - 0.16, -1]] as const) {
      const qe = qm + s * (half + 0.07);
      const [ax, , az] = P(pp - 0.045, qe - 0.045, 0);
      const [bx, , bz] = P(pp + 0.045, qe + 0.045, 0);
      relief.box(Math.min(ax, bx), t.y0, Math.min(az, bz), Math.max(ax, bx), y - 0.2, Math.max(az, bz), { uv: TRIM_UV, color: ROOF_TRIM });
    }
  }
}

export function addSign(view: CityView, b: Building, text: string, color: string, side: Side): void {
  const tex = signTexture(text, color);
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.4, roughness: 0.6, transparent: false });
  view.materials.signs.push(mat);
  const r = b.rect;
  const ns = side === 'N' || side === 'S';
  const along = ns ? rectW(r) : rectD(r);
  const w = Math.min(along * 0.8, 16);
  // Centre along the side, from its west (N, S) or north (E, W) end: over the main door when it is
  // in this wall, as near as the sign can get while it stays on the wall; else mid-wall.
  let c = along / 2;
  const door = view.entrances.get(b.id);
  if (door && door.side === side) c = clamp(ns ? door.x - r.minX : door.z - r.minZ, Math.min(along / 2, w / 2 + SIGN_MARGIN), Math.max(along / 2, along - w / 2 - SIGN_MARGIN));
  const h = w * (192 / 1024);
  const geo = new THREE.PlaneGeometry(w, h);
  const m = new THREE.Mesh(geo, mat);
  m.name = 'sign';
  m.userData.building = b.id;
  // Above the ground floor (lobby, shops) when there is one, else from 6 m up.
  const bottom = b.ground !== 'none' ? CURB_H + b.groundH + 0.3 : 6;
  const y = Math.min(b.height - h / 2 - 0.3, bottom + h / 2);
  const off = 0.08;
  switch (side) {
    case 'S':
      m.position.set(r.minX + c, y, r.maxZ + off);
      break;
    case 'N':
      m.position.set(r.minX + c, y, r.minZ - off);
      m.rotation.y = Math.PI;
      break;
    case 'E':
      m.position.set(r.maxX + off, y, r.minZ + c);
      m.rotation.y = Math.PI / 2;
      break;
    case 'W':
      m.position.set(r.minX - off, y, r.minZ + c);
      m.rotation.y = -Math.PI / 2;
      break;
  }
  m.updateMatrix();
  m.matrixAutoUpdate = false;
  view.group.add(m);
}

/** Vertical quad from (ax, az) to (bx, bz) between heights y0 and y1, facing right of the direction, mapped to an atlas rectangle. */
function quadUv(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, uv: readonly [number, number, number, number], color: RGB): void {
  const [u0, v0, u1, v1] = uv;
  g.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, [u0, v0, u1, v0, u1, v1, u0, v1], color);
}

/** Axis-aligned box centred on (cx, cz) with the given footprint, between heights y0 and y1 (top and bottom included). */
function boxAround(g: GeoBuilder, cx: number, cz: number, sx: number, sz: number, y0: number, y1: number, color: RGB): void {
  g.box(cx - sx / 2, y0, cz - sz / 2, cx + sx / 2, y1, cz + sz / 2, { uv: { kind: 'unit' }, color, bottom: true });
}
