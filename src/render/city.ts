// Static city geometry: terrain, roads, markings, sidewalks, buildings, roofs,
// coast, piers, ramps, garages and signs. Everything is merged per material.

import * as THREE from 'three';
import { clamp01 } from '../core/math';
import { Rng } from '../core/rng';
import { BEACH_W, BOARDWALK_W, CROSSWALK_W, CURB_H, DECK_SLAB, LANE_W, SEABED_Y, SIDEWALK_W, WATER_Y } from '../world/constants';
import {
  SPECIALS, frontages, hashInts, rectCX, rectCZ, rectD, rectW, sandHeight, specialOf,
  type Block, type Building, type FacadeStyle, type GroundKind, type Side, type Tier,
} from '../world/layout';
import type { StaticWorld } from '../world/staticWorld';
import { GeoBuilder, hexToRgb, scaleRgb, type RGB, type UvMode } from './geo';
import {
  CELLS, CELL_DESIGN, DOOR_U, FACADE_CELL, FACADE_COLS, FACADE_ROWS, HOUSE_SILL, SHOP_AWNING_TOP, SHOP_FASCIA_FRAC, SHOPS, SWATCHES,
  facadeTextures, groundTexture, helipadTexture, signTexture, storefrontAtlas, storefrontUv, swatchUv,
} from './textures';

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

const GROUND_TEX: Record<GroundKind, 'grass' | 'plaza' | 'asphalt' | 'dirt'> = {
  grass: 'grass',
  yard: 'grass',
  plaza: 'plaza',
  parking: 'asphalt',
  dirt: 'dirt',
};

export interface CityMaterials {
  facades: Map<FacadeStyle, THREE.MeshStandardMaterial>;
  signs: THREE.MeshStandardMaterial[];
  /** Ground floors (shops, lobbies, doors, loading bays) from the storefront atlas. */
  storefront: THREE.MeshStandardMaterial | null;
  /** Awnings, lobby canopies, porches and steps (vertex coloured). */
  decor: THREE.MeshStandardMaterial | null;
}

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

/** Share of shops still lit: about 70% from dusk, closing one by one until the last go dark around 02:00. */
export function shopOccupancy(hours: number): number {
  return 0.7 * clamp01((occupancy(hours) - 0.15) / 0.45);
}

/** How strongly each facade style follows the occupancy, and the share of its floors lit as a whole (offices, towers). */
const STYLE_NIGHT: Record<FacadeStyle, { occ: number; floors: number }> = {
  glassBlue: { occ: 0.8, floors: 0.5 },
  glassTeal: { occ: 0.8, floors: 0.5 },
  office: { occ: 0.85, floors: 0.5 },
  brick: { occ: 1, floors: 0 },
  stucco: { occ: 1, floors: 0 },
  house: { occ: 1.05, floors: 0 },
  warehouse: { occ: 0.35, floors: 0 },
  hotel: { occ: 1.1, floors: 0 },
};

/** Storefront classes, stored in the integer part of a frontage's aSeed (the fraction is its random seed). */
const FRONT_SHOP = 0;
const FRONT_LOBBY = 1;
const FRONT_HOME = 2;
const FRONT_LAMP = 3;

const NIGHT_HASH = /* glsl */ `
float nightHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;

/**
 * Lit windows at night: the emissive map is only a glass mask; which windows glow is decided per
 * window (its cell on the building, never wrapping) and per building (aSeed) against the time of
 * day's occupancy, with warm, cool and flickering-TV tints. Only the colour pass changes: shadow and
 * depth passes use three's own depth materials.
 */
const FACADE_FRAG_MAIN = /* glsl */ `
{
  vec2 cell = floor(vMapUv * vec2(${FACADE_COLS.toFixed(1)}, ${FACADE_ROWS.toFixed(1)}));
  // Whole numbers only: the hash would turn the slightest float error into per-pixel noise.
  float s = floor(vSeed * 1000.0 + 0.5);
  float hCell = nightHash(cell + vec2(s, s * 1.37 + 11.0));
  float hFloor = nightHash(vec2(cell.y * 1.13 + s, s * 0.71 + 17.0));
  float wholeFloor = step(nightHash(vec2(cell.y + 41.0, s + 3.0)), uFloorShare);
  float lit = step(mix(hCell, hFloor, wholeFloor), uOccupancy * uStyleOcc);
  float ht = nightHash(cell * 1.71 + vec2(s * 0.37 + 5.0, 9.0));
  vec3 tint = vec3(1.0, 0.66, 0.36);
  if (ht > 0.75) tint = vec3(0.75, 0.86, 1.0);
  if (ht > 0.95) tint = vec3(0.32, 0.5, 1.0) * (0.6 + 0.4 * sin(uTime * 7.0 + ht * 60.0) * sin(uTime * 2.3 + ht * 17.0));
  float bright = 0.7 + 0.3 * nightHash(cell * 0.73 + vec2(9.0, s));
  totalEmissiveRadiance *= lit * bright * tint;
}`;

/**
 * Shops switch off one by one through the night; lobbies stay lit but dim after the evening;
 * porch lights follow the occupants; loading-bay lamps (and the gun shops) never go out.
 */
const FRONT_FRAG_MAIN = /* glsl */ `
{
  float cls = floor(vSeed);
  float sd = fract(vSeed);
  float on = 1.0;
  if (cls < 0.5) on = step(sd, uShopOcc);
  else if (cls < 1.5) on = 0.3 + 0.7 * clamp(uOccupancy / 0.6, 0.0, 1.0);
  else if (cls < 2.5) on = step(sd, uOccupancy * 1.3);
  totalEmissiveRadiance *= on;
}`;

interface NightUniforms {
  occupancy: { value: number };
  shopOccupancy: { value: number };
  time: { value: number };
}

/** Adds the per-vertex aSeed attribute and a fragment block after the emissive map to a standard material. */
function nightShader(mat: THREE.MeshStandardMaterial, key: string, uniforms: Record<string, { value: number }>, main: string): void {
  const decl = Object.keys(uniforms)
    .map((k) => `uniform float ${k};`)
    .join('\n');
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSeed;\nflat varying float vSeed;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeed = aSeed;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nflat varying float vSeed;\n${decl}\n${NIGHT_HASH}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${main}`);
  };
  // Every material sharing this key gets identical GLSL (per-material values are uniforms), so they share one program.
  mat.customProgramCacheKey = () => key;
}

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
const BEACH_SHOPS = SHOPS.map((s, i) => (s.beach ? i : -1)).filter((i) => i >= 0);
const INLAND_SHOPS = SHOPS.map((s, i) => (s.name === 'SURF SHOP' ? -1 : i)).filter((i) => i >= 0);
const WHITE: RGB = [1, 1, 1];

function linearRgb(hex: number): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

export class CityView {
  readonly group = new THREE.Group();
  readonly materials: CityMaterials = { facades: new Map(), signs: [], storefront: null, decor: null };
  private readonly nightU: NightUniforms = { occupancy: { value: 0 }, shopOccupancy: { value: 0 }, time: { value: 0 } };

  constructor(private readonly world: StaticWorld) {
    this.group.name = 'city';
    this.buildBuildings();
    this.buildGround();
    this.buildRoads();
    this.buildCoast();
    this.buildStructures();
  }

  private add(geo: THREE.BufferGeometry, mat: THREE.Material, opts: { shadow?: boolean; receive?: boolean; name?: string } = {}): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = opts.shadow ?? false;
    m.receiveShadow = opts.receive ?? true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    if (opts.name) m.name = opts.name;
    this.group.add(m);
    return m;
  }

  // ---------------------------------------------------------------------------
  // Buildings

  private buildBuildings(): void {
    const layout = this.world.layout;
    const builders = new Map<FacadeStyle, GeoBuilder>();
    for (const s of STYLES) builders.set(s, new GeoBuilder(true, true));
    const roofs = new GeoBuilder(true);
    const front = new GeoBuilder(true, true);
    const decor = new GeoBuilder(true);
    const rng = new Rng(4242);
    const frontage = frontages(layout);

    for (const b of layout.buildings) {
      const gb = builders.get(b.style)!;
      // Per-building seed (k / 1000) for the night windows, so neighbours of one style never match.
      gb.seed = (hashInts(b.id, 0x5eed) % 1000) / 1000;
      const cell = FACADE_CELL[b.style];
      const tints = STYLE_TINTS[b.style];
      const tint = hexToRgb(tints[Math.floor(b.tint * tints.length) % tints.length]!);
      const shade = 0.88 + rng.next() * 0.14;
      const color = scaleRgb(tint, shade);
      const offU = Math.floor(rng.next() * FACADE_COLS) / FACADE_COLS;
      const offV = Math.floor(rng.next() * FACADE_ROWS) / FACADE_ROWS;
      const f = b.ground !== 'none' ? frontage.get(b) : undefined;
      const block = f?.block ?? null;
      const street = new Set<Side>(f?.sides ?? []);
      // With a ground floor the window grid starts on top of it, on every wall so the rows meet at the corners.
      const baseY = CURB_H + (street.size > 0 ? b.groundH : 0);
      for (const t of b.tiers) {
        const uv = { kind: 'facade' as const, w: cell.w * FACADE_COLS, h: cell.h * FACADE_ROWS, offU, offV, baseY };
        if (t === b.tiers[0] && block && street.size > 0) this.groundTier(gb, front, decor, b, block, t, street, uv, color);
        else gb.box(t.minX, t.y0, t.minZ, t.maxX, t.y1, t.maxZ, { uv, color, top: false });
        if (b.roof === 'gable' && t === b.tiers[b.tiers.length - 1]) this.gable(roofs, t, b, color);
        else {
          const rc = scaleRgb([0.55, 0.54, 0.52], 0.85 + rng.next() * 0.3);
          roofs.flat(t.minX, t.minZ, t.maxX, t.maxZ, t.y1, { kind: 'world', scale: 6 }, rc);
          // Parapet lip.
          const lip = 0.6;
          const lc: RGB = [color[0] * 0.8, color[1] * 0.8, color[2] * 0.8];
          if (rectW(t) > 6 && rectD(t) > 6) {
            roofs.box(t.minX, t.y1, t.minZ, t.maxX, t.y1 + lip, t.minZ + 0.3, { uv: { kind: 'world', scale: 4 }, color: lc });
            roofs.box(t.minX, t.y1, t.maxZ - 0.3, t.maxX, t.y1 + lip, t.maxZ, { uv: { kind: 'world', scale: 4 }, color: lc });
            roofs.box(t.minX, t.y1, t.minZ + 0.3, t.minX + 0.3, t.y1 + lip, t.maxZ - 0.3, { uv: { kind: 'world', scale: 4 }, color: lc });
            roofs.box(t.maxX - 0.3, t.y1, t.minZ + 0.3, t.maxX, t.y1 + lip, t.maxZ - 0.3, { uv: { kind: 'world', scale: 4 }, color: lc });
          }
        }
      }
      if (b.sign) this.addSign(b, b.sign.text, b.sign.color, b.sign.side);
    }

    const nu = this.nightU;
    STYLES.forEach((style, i) => {
      const tex = facadeTextures(style, 100 + i);
      const glass = style === 'glassBlue' || style === 'glassTeal';
      const mat = new THREE.MeshStandardMaterial({
        map: tex.map,
        emissiveMap: tex.emissive,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0,
        roughnessMap: tex.rough,
        roughness: 1,
        metalness: glass ? 0.25 : 0.02,
        vertexColors: true,
        envMapIntensity: glass ? 1.4 : 0.6,
      });
      const sn = STYLE_NIGHT[style];
      nightShader(mat, 'gta7-facade-night', { uOccupancy: nu.occupancy, uTime: nu.time, uStyleOcc: { value: sn.occ }, uFloorShare: { value: sn.floors } }, FACADE_FRAG_MAIN);
      this.materials.facades.set(style, mat);
      const geo = builders.get(style)!.build();
      if (geo.getAttribute('position').count > 0) this.add(geo, mat, { shadow: true, name: `facade-${style}` });
    });
    const roofMat = new THREE.MeshStandardMaterial({ map: groundTexture('roof'), vertexColors: true, roughness: 0.92, metalness: 0 });
    this.add(roofs.build(), roofMat, { shadow: true, name: 'roofs' });

    const atlas = storefrontAtlas();
    const frontMat = new THREE.MeshStandardMaterial({
      map: atlas.map,
      emissiveMap: atlas.emissive,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0,
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.05,
      envMapIntensity: 0.9,
    });
    nightShader(frontMat, 'gta7-storefront-night', { uOccupancy: nu.occupancy, uShopOcc: nu.shopOccupancy }, FRONT_FRAG_MAIN);
    this.materials.storefront = frontMat;
    this.add(front.build(), frontMat, { shadow: true, name: 'storefronts' });
    const decorMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide });
    this.materials.decor = decorMat;
    this.add(decor.build(), decorMat, { shadow: true, name: 'ground-decor' });
  }

  /**
   * The ground tier of a building with street-facing walls: those walls stop at the top of the
   * ground floor and the band below becomes shop, lobby, house or loading-bay frontage; the other
   * walls stay full height.
   */
  private groundTier(gb: GeoBuilder, front: GeoBuilder, decor: GeoBuilder, b: Building, block: Block, t: Tier, street: Set<Side>, uv: UvMode, color: RGB): void {
    const w = t.maxX - t.minX;
    const d = t.maxZ - t.minZ;
    const lot = block.lot;
    const walls: TierWall[] = [
      { side: 'S', x0: t.minX, z0: t.maxZ, x1: t.maxX, z1: t.maxZ, u: 0, gap: lot.maxZ - t.maxZ },
      { side: 'E', x0: t.maxX, z0: t.maxZ, x1: t.maxX, z1: t.minZ, u: w, gap: lot.maxX - t.maxX },
      { side: 'N', x0: t.maxX, z0: t.minZ, x1: t.minX, z1: t.minZ, u: w + d, gap: t.minZ - lot.minZ },
      { side: 'W', x0: t.minX, z0: t.minZ, x1: t.minX, z1: t.maxZ, u: 2 * w + d, gap: t.minX - lot.minX },
    ];
    const entrance = this.entranceSide(b, block, walls.filter((wl) => street.has(wl.side)));
    const top = t.y0 + b.groundH;
    for (const wl of walls) {
      if (!street.has(wl.side)) {
        gb.wall(wl.x0, wl.z0, wl.x1, wl.z1, t.y0, t.y1, uv, color, wl.u);
        continue;
      }
      gb.wall(wl.x0, wl.z0, wl.x1, wl.z1, top, t.y1, uv, color, wl.u);
      this.frontage(front, decor, b, wl, t.y0, top, color, wl.side === entrance);
    }
  }

  /** The side that gets the main door: a special's entrance side, else the street side nearest its lot edge (then the longest). */
  private entranceSide(b: Building, block: Block, walls: TierWall[]): Side {
    const sides = new Set(walls.map((wl) => wl.side));
    const special = specialOf(b);
    if (special) {
      const def = SPECIALS.find((s) => s.kind === special && s.bi === block.bi && s.bj === block.bj);
      if (def && sides.has(def.side)) return def.side;
      if (b.sign && sides.has(b.sign.side)) return b.sign.side;
    }
    const len = (wl: TierWall) => Math.abs(wl.x1 - wl.x0) + Math.abs(wl.z1 - wl.z0);
    return walls.reduce((best, wl) => (wl.gap < best.gap - 0.01 || (Math.abs(wl.gap - best.gap) <= 0.01 && len(wl) > len(best)) ? wl : best)).side;
  }

  /** Frontage quads (one per 5-8 m) for the band of one street-facing wall, plus their awnings, canopies and porches. */
  private frontage(front: GeoBuilder, decor: GeoBuilder, b: Building, wl: TierWall, y0: number, y1: number, wallColor: RGB, entrance: boolean): void {
    const len = Math.hypot(wl.x1 - wl.x0, wl.z1 - wl.z0);
    const ux = (wl.x1 - wl.x0) / len;
    const uz = (wl.z1 - wl.z0) / len;
    const n = Math.max(1, Math.round(len / 6.5));
    const seg = len / n;
    const special = specialOf(b);
    const sideIx = SIDE_INDEX[wl.side];
    const doorAt = Math.floor(n / 2);
    let prevShop = -1;
    for (let i = 0; i < n; i++) {
      const s0 = i * seg;
      const ax = wl.x0 + ux * s0;
      const az = wl.z0 + uz * s0;
      const bx = ax + ux * seg;
      const bz = az + uz * seg;
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
            const split = y0 + (y1 - y0) * (1 - SHOP_FASCIA_FRAC);
            front.seed = seed(FRONT_LAMP);
            quadUv(front, ax, az, bx, bz, y0, split, storefrontUv(PAWN, SHOP_FASCIA_FRAC, 1), WHITE);
            quadUv(front, ax, az, bx, bz, split, y1, swatchUv(SWATCHES.gunFascia), WHITE);
            continue;
          }
          const pool = b.district === 'beachfront' && rnd(2) < 0.75 ? BEACH_SHOPS : INLAND_SHOPS;
          cell = pool[Math.floor(rnd(3) * pool.length)]!;
          if (cell === prevShop) cell = pool[(pool.indexOf(cell) + 1) % pool.length]!;
          prevShop = cell;
          cls = FRONT_SHOP;
          const awning = SHOPS[cell]!.awning;
          if (awning >= 0 && rnd(4) < 0.75) this.awning(decor, ax, az, bx, bz, ux, uz, y0, y1, wl.gap, linearRgb(awning), rnd(5) < 0.5);
          break;
        }
        case 'lobby': {
          const door = entrance && i === doorAt;
          cell = !door ? CELLS.lobbyGlass : special === 'bank' ? CELLS.bank : rnd(6) < 0.5 ? CELLS.lobbyRevolving : CELLS.lobbyDoors;
          cls = FRONT_LOBBY;
          if (door && special === 'bank') this.steps(decor, ax, az, bx, bz, ux, uz, y0);
          else if (door) this.canopy(decor, ax, az, bx, bz, ux, uz, y0, y1, wl.gap, special);
          break;
        }
        case 'house': {
          const door = entrance && i === doorAt;
          cell = !door ? CELLS.houseWindows : rnd(7) < 0.5 ? CELLS.houseDoorA : CELLS.houseDoorB;
          cls = FRONT_HOME;
          tint = wallColor;
          if (door) this.porch(decor, ax, az, ux, uz, seg * (DOOR_U[cell] ?? 0.5), y0, b);
          break;
        }
        case 'loading':
        default:
          cell = CELLS.rollup;
          cls = FRONT_LAMP;
          this.hood(decor, ax, az, bx, bz, ux, uz, y0, y1);
          break;
      }
      front.seed = seed(cls);
      // Plain glass and window cells are mirrored on every other quad to break up the repeat.
      const flip = (cell === CELLS.lobbyGlass || cell === CELLS.houseWindows) && i % 2 === 1;
      const uv = storefrontUv(cell);
      quadUv(front, ax, az, bx, bz, y0, y1, flip ? [uv[2], uv[1], uv[0], uv[3]] : uv, tint);
    }
  }

  /** Striped fabric awning over a shop window: a sloped top, a valance and two side cheeks. */
  private awning(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, ux: number, uz: number, y0: number, y1: number, gap: number, color: RGB, striped: boolean): void {
    const nx = -uz;
    const nz = ux;
    const depth = Math.min(1.5, Math.max(0.8, gap + 0.3));
    const top = y0 + (y1 - y0) * (1 - SHOP_AWNING_TOP / CELL_DESIGN.shop.h);
    const low = top - 0.45;
    const val = 0.28;
    const m = 0.22;
    const sx = ax + ux * m;
    const sz = az + uz * m;
    const len = Math.hypot(bx - ax, bz - az) - 2 * m;
    const stripes = striped ? Math.max(2, Math.round(len / 0.45)) : 1;
    const cream: RGB = [0.92, 0.89, 0.82];
    for (let k = 0; k < stripes; k++) {
      const c = striped && k % 2 === 1 ? cream : color;
      const p0x = sx + ux * ((len * k) / stripes);
      const p0z = sz + uz * ((len * k) / stripes);
      const p1x = sx + ux * ((len * (k + 1)) / stripes);
      const p1z = sz + uz * ((len * (k + 1)) / stripes);
      // Sloped top, from the wall out and down.
      g.quad(p0x + nx * depth, low, p0z + nz * depth, p1x + nx * depth, low, p1z + nz * depth, p1x, top, p1z, p0x, top, p0z, [0, 0, 1, 0, 1, 1, 0, 1], c);
      // Valance hanging from the front edge.
      g.quad(p0x + nx * depth, low - val, p0z + nz * depth, p1x + nx * depth, low - val, p1z + nz * depth, p1x + nx * depth, low, p1z + nz * depth, p0x + nx * depth, low, p0z + nz * depth, [0, 0, 1, 0, 1, 1, 0, 1], c);
    }
    const ex = sx + ux * len;
    const ez = sz + uz * len;
    g.tri(sx, top, sz, sx + nx * depth, low, sz + nz * depth, sx + nx * depth, low - val, sz + nz * depth, [0, 0, 1, 0, 1, 1], color);
    g.tri(ex + nx * depth, low - val, ez + nz * depth, ex + nx * depth, low, ez + nz * depth, ex, top, ez, [0, 0, 1, 0, 1, 1], color);
  }

  /** A cantilevered slab over a lobby entrance. */
  private canopy(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, ux: number, uz: number, y0: number, y1: number, gap: number, special: ReturnType<typeof specialOf>): void {
    const nx = -uz;
    const nz = ux;
    const len = Math.hypot(bx - ax, bz - az);
    const width = Math.min(len * 0.8, 4.6);
    const depth = Math.min(2.6, Math.max(1.4, gap + 0.8));
    const y = y0 + Math.min(4.3, (y1 - y0) * 0.62);
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    const col: RGB = special === 'police' ? [0.05, 0.12, 0.45] : special === 'hospital' ? [0.62, 0.06, 0.06] : [0.12, 0.13, 0.15];
    boxAround(g, mx + nx * (depth / 2), mz + nz * (depth / 2), Math.abs(ux) * width + Math.abs(nx) * depth, Math.abs(uz) * width + Math.abs(nz) * depth, y, y + 0.24, col);
    // A light trim along the front edge.
    boxAround(g, mx + nx * (depth - 0.03), mz + nz * (depth - 0.03), Math.abs(ux) * width + Math.abs(nx) * 0.06, Math.abs(uz) * width + Math.abs(nz) * 0.06, y + 0.24, y + 0.3, [0.75, 0.76, 0.78]);
  }

  /** Three broad stone steps up to the bank's doors. */
  private steps(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, ux: number, uz: number, y0: number): void {
    const nx = -uz;
    const nz = ux;
    const len = Math.hypot(bx - ax, bz - az);
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    const stone: RGB = [0.62, 0.58, 0.5];
    for (let k = 0; k < 3; k++) {
      const depth = 1.05 - k * 0.35;
      const width = len * 0.9 - k * 0.3;
      boxAround(g, mx + nx * (depth / 2), mz + nz * (depth / 2), Math.abs(ux) * width + Math.abs(nx) * depth, Math.abs(uz) * width + Math.abs(nz) * depth, y0 - 0.02, y0 + 0.12 * (k + 1), scaleRgb(stone, 1 - k * 0.04));
    }
  }

  /** Porch deck, a step, two posts and a small roof in front of a house door `along` metres from (ax, az). */
  private porch(g: GeoBuilder, ax: number, az: number, ux: number, uz: number, along: number, y0: number, b: Building): void {
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
  private hood(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, ux: number, uz: number, y0: number, y1: number): void {
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

  /** Pitched roof along the longer side. */
  private gable(gb: GeoBuilder, t: { minX: number; minZ: number; maxX: number; maxZ: number; y1: number }, b: Building, wallColor: RGB): void {
    const w = t.maxX - t.minX;
    const d = t.maxZ - t.minZ;
    const h = Math.min(w, d) * 0.35;
    const y = t.y1;
    const roofCol: RGB = b.tint > 0.5 ? [0.55, 0.22, 0.18] : [0.32, 0.33, 0.36];
    const uv = [0, 0, 1, 0, 1, 1, 0, 1];
    const o = 0.4; // eaves overhang
    if (w >= d) {
      const zm = (t.minZ + t.maxZ) / 2;
      gb.quad(t.minX - o, y - 0.1, t.maxZ + o, t.maxX + o, y - 0.1, t.maxZ + o, t.maxX + o, y + h, zm, t.minX - o, y + h, zm, uv, roofCol);
      gb.quad(t.maxX + o, y - 0.1, t.minZ - o, t.minX - o, y - 0.1, t.minZ - o, t.minX - o, y + h, zm, t.maxX + o, y + h, zm, uv, roofCol);
      gb.tri(t.minX, y, t.minZ, t.minX, y, t.maxZ, t.minX, y + h, zm, [0, 0, 1, 0, 0.5, 1], wallColor);
      gb.tri(t.maxX, y, t.maxZ, t.maxX, y, t.minZ, t.maxX, y + h, zm, [0, 0, 1, 0, 0.5, 1], wallColor);
    } else {
      const xm = (t.minX + t.maxX) / 2;
      gb.quad(t.maxX + o, y - 0.1, t.maxZ + o, t.maxX + o, y - 0.1, t.minZ - o, xm, y + h, t.minZ - o, xm, y + h, t.maxZ + o, uv, roofCol);
      gb.quad(t.minX - o, y - 0.1, t.minZ - o, t.minX - o, y - 0.1, t.maxZ + o, xm, y + h, t.maxZ + o, xm, y + h, t.minZ - o, uv, roofCol);
      gb.tri(t.minX, y, t.maxZ, t.maxX, y, t.maxZ, xm, y + h, t.maxZ, [0, 0, 1, 0, 0.5, 1], wallColor);
      gb.tri(t.maxX, y, t.minZ, t.minX, y, t.minZ, xm, y + h, t.minZ, [0, 0, 1, 0, 0.5, 1], wallColor);
    }
  }

  private addSign(b: Building, text: string, color: string, side: Side): void {
    const tex = signTexture(text, color);
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.4, roughness: 0.6, transparent: false });
    this.materials.signs.push(mat);
    const r = b.rect;
    const along = side === 'N' || side === 'S' ? rectW(r) : rectD(r);
    const w = Math.min(along * 0.8, 16);
    const h = w * (192 / 1024);
    const geo = new THREE.PlaneGeometry(w, h);
    const m = new THREE.Mesh(geo, mat);
    const y = Math.min(b.height - h / 2 - 0.5, 6 + h / 2);
    const off = 0.08;
    switch (side) {
      case 'S':
        m.position.set(rectCX(r), y, r.maxZ + off);
        break;
      case 'N':
        m.position.set(rectCX(r), y, r.minZ - off);
        m.rotation.y = Math.PI;
        break;
      case 'E':
        m.position.set(r.maxX + off, y, rectCZ(r));
        m.rotation.y = Math.PI / 2;
        break;
      case 'W':
        m.position.set(r.minX - off, y, rectCZ(r));
        m.rotation.y = -Math.PI / 2;
        break;
    }
    m.updateMatrix();
    m.matrixAutoUpdate = false;
    this.group.add(m);
  }

  // ---------------------------------------------------------------------------
  // Ground: sidewalks, lots, promenade

  private buildGround(): void {
    const layout = this.world.layout;
    const walk = new GeoBuilder(false);
    const curbs = new GeoBuilder(false);
    const patches = new Map<string, GeoBuilder>();
    const patch = (k: string) => {
      let g = patches.get(k);
      if (!g) {
        g = new GeoBuilder(false);
        patches.set(k, g);
      }
      return g;
    };
    const y = CURB_H;
    const sw = SIDEWALK_W;
    for (const blk of layout.blocks) {
      const r = blk.rect;
      // Sidewalk ring (4 non-overlapping strips).
      walk.flat(r.minX, r.minZ, r.maxX, r.minZ + sw, y, { kind: 'world', scale: 4 });
      walk.flat(r.minX, r.maxZ - sw, r.maxX, r.maxZ, y, { kind: 'world', scale: 4 });
      walk.flat(r.minX, r.minZ + sw, r.minX + sw, r.maxZ - sw, y, { kind: 'world', scale: 4 });
      walk.flat(r.maxX - sw, r.minZ + sw, r.maxX, r.maxZ - sw, y, { kind: 'world', scale: 4 });
      // Curb faces.
      curbs.wall(r.minX, r.maxZ, r.maxX, r.maxZ, 0, y, { kind: 'world', scale: 2 });
      curbs.wall(r.maxX, r.maxZ, r.maxX, r.minZ, 0, y, { kind: 'world', scale: 2 });
      curbs.wall(r.maxX, r.minZ, r.minX, r.minZ, 0, y, { kind: 'world', scale: 2 });
      curbs.wall(r.minX, r.minZ, r.minX, r.maxZ, 0, y, { kind: 'world', scale: 2 });
    }
    for (const gp of layout.ground) {
      const tex = GROUND_TEX[gp.kind];
      patch(tex).flat(gp.rect.minX, gp.rect.minZ, gp.rect.maxX, gp.rect.maxZ, y + 0.004, { kind: 'world', scale: tex === 'plaza' ? 6 : 8 });
    }
    // Parking bay lines.
    const lines = new GeoBuilder(false);
    for (const s of layout.parking) {
      const fx = Math.sin(s.heading);
      const fz = Math.cos(s.heading);
      const sx = Math.cos(s.heading);
      const sz = -Math.sin(s.heading);
      for (const side of [-1, 1]) {
        const cx = s.x + sx * side * 1.6;
        const cz = s.z + sz * side * 1.6;
        const ax = cx - fx * 2.5;
        const az = cz - fz * 2.5;
        const bx = cx + fx * 2.5;
        const bz = cz + fz * 2.5;
        quadLine(lines, ax, az, bx, bz, 0.12, y + 0.012);
      }
    }

    // Outer land around the city: sidewalk ring + promenade strips + boardwalk.
    const b = layout.bounds;
    const prom = patch('plaza');
    const wood = new GeoBuilder(false);
    walk.flat(b.cityMinX - sw, b.cityMinZ - sw, b.cityMaxX + sw, b.cityMinZ, y, { kind: 'world', scale: 4 });
    walk.flat(b.cityMinX - sw, b.cityMaxZ, b.cityMaxX + sw, b.cityMaxZ + sw, y, { kind: 'world', scale: 4 });
    walk.flat(b.cityMinX - sw, b.cityMinZ, b.cityMinX, b.cityMaxZ, y, { kind: 'world', scale: 4 });
    walk.flat(b.cityMaxX, b.cityMinZ, b.cityMaxX + sw, b.cityMaxZ, y, { kind: 'world', scale: 4 });
    curbs.wall(b.cityMinX, b.cityMinZ, b.cityMaxX, b.cityMinZ, 0, y, { kind: 'world', scale: 2 });
    curbs.wall(b.cityMaxX, b.cityMaxZ, b.cityMinX, b.cityMaxZ, 0, y, { kind: 'world', scale: 2 });
    curbs.wall(b.cityMinX, b.cityMaxZ, b.cityMinX, b.cityMinZ, 0, y, { kind: 'world', scale: 2 });
    curbs.wall(b.cityMaxX, b.cityMinZ, b.cityMaxX, b.cityMaxZ, 0, y, { kind: 'world', scale: 2 });
    prom.flat(b.landMinX, b.landMinZ, b.cityMinX - sw, b.landMaxZ, y, { kind: 'world', scale: 6 });
    prom.flat(b.cityMinX - sw, b.landMinZ, b.beachStartX, b.cityMinZ - sw, y, { kind: 'world', scale: 6 });
    prom.flat(b.cityMinX - sw, b.cityMaxZ + sw, b.beachStartX, b.landMaxZ, y, { kind: 'world', scale: 6 });
    wood.flat(b.cityMaxX + sw, b.cityMinZ - sw, b.beachStartX, b.cityMaxZ + sw, y, { kind: 'world', scale: 4 });

    const mat = (tex: THREE.Texture, rough = 0.95) => new THREE.MeshStandardMaterial({ map: tex, roughness: rough, metalness: 0 });
    this.add(walk.build(), mat(groundTexture('sidewalk')), { name: 'sidewalks' });
    this.add(curbs.build(), mat(groundTexture('concrete')), { name: 'curbs' });
    this.add(wood.build(), mat(groundTexture('wood')), { name: 'boardwalk' });
    for (const [k, g] of patches) {
      const m = mat(groundTexture(k as 'grass' | 'plaza' | 'asphalt' | 'dirt'), k === 'asphalt' ? 0.9 : 0.97);
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -1;
      this.add(g.build(), m, { name: `ground-${k}` });
    }
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.add(lines.build(), lineMat, { name: 'parking-lines' });
  }

  // ---------------------------------------------------------------------------
  // Roads

  private buildRoads(): void {
    const roads = this.world.roads;
    const asphalt = new GeoBuilder(false);
    const white = new GeoBuilder(false);
    const yellow = new GeoBuilder(false);
    const yM = 0.02;
    for (const n of roads.nodes) asphalt.flat(n.x - n.halfX, n.z - n.halfZ, n.x + n.halfX, n.z + n.halfZ, 0, { kind: 'world', scale: 8 });
    for (const s of roads.segments) {
      asphalt.flat(s.minX, s.minZ, s.maxX, s.maxZ, 0, { kind: 'world', scale: 8 });
      const line = s.line;
      const c = line.pos;
      // Markings run between the crosswalk bands.
      const a0 = (s.vertical ? s.minZ : s.minX) + CROSSWALK_W;
      const a1 = (s.vertical ? s.maxZ : s.maxX) - CROSSWALK_W;
      const L = (a: number, o: number) => (s.vertical ? { x: c + o, z: a } : { x: a, z: c + o });
      // Centre line(s).
      if (line.lanes === 2) {
        for (const o of [-0.16, 0.16]) {
          const p = L(a0, o);
          const q = L(a1, o);
          quadLine(yellow, p.x, p.z, q.x, q.z, 0.12, yM);
        }
        // Dashed lane dividers.
        for (const o of [-LANE_W, LANE_W]) {
          for (let a = a0 + 2; a + 3 <= a1; a += 9) {
            const p = L(a, o);
            const q = L(a + 3, o);
            quadLine(white, p.x, p.z, q.x, q.z, 0.12, yM);
          }
        }
      } else {
        for (let a = a0 + 1; a + 4 <= a1; a += 7) {
          const p = L(a, 0);
          const q = L(a + 4, 0);
          quadLine(yellow, p.x, p.z, q.x, q.z, 0.13, yM);
        }
      }
      // Edge lines.
      for (const o of [-(line.width / 2 - 0.35), line.width / 2 - 0.35]) {
        const p = L(a0, o);
        const q = L(a1, o);
        quadLine(white, p.x, p.z, q.x, q.z, 0.1, yM);
      }
    }
    // Stop lines and zebra crossings.
    for (const n of roads.nodes) {
      for (let d = 0; d < 4; d++) {
        if (n.neighbors[d]! < 0) continue;
        const vertical = d === 0 || d === 2;
        const sign = d === 0 || d === 3 ? -1 : 1;
        const halfAlong = vertical ? n.halfZ : n.halfX;
        const width = vertical ? n.halfX * 2 : n.halfZ * 2;
        const c0 = halfAlong;
        const c1 = halfAlong + CROSSWALK_W;
        // Zebra: stripes parallel to the road.
        for (let o = -width / 2 + 0.6; o <= width / 2 - 0.6; o += 1.2) {
          const a = c0 + 0.4;
          const b = c1 - 0.4;
          if (vertical) quadLine(white, n.x + o, n.z + sign * a, n.x + o, n.z + sign * b, 0.55, yM);
          else quadLine(white, n.x + sign * a, n.z + o, n.x + sign * b, n.z + o, 0.55, yM);
        }
        // Stop line across the incoming half (traffic arriving from direction d drives on its right).
        const sl = c1 + 0.3;
        if (vertical) {
          // Arriving from north (d=0 side) travels south; its lanes are on the west half.
          const x0 = d === 0 ? n.x - width / 2 + 0.2 : n.x + 0.3;
          const x1 = d === 0 ? n.x - 0.3 : n.x + width / 2 - 0.2;
          quadLine(white, x0, n.z + sign * sl, x1, n.z + sign * sl, 0.45, yM);
        } else {
          const z0 = d === 1 ? n.z - width / 2 + 0.2 : n.z + 0.3;
          const z1 = d === 1 ? n.z - 0.3 : n.z + width / 2 - 0.2;
          quadLine(white, n.x + sign * sl, z0, n.x + sign * sl, z1, 0.45, yM);
        }
      }
    }
    const roadMat = new THREE.MeshStandardMaterial({ map: groundTexture('asphalt'), roughness: 0.88, metalness: 0 });
    this.add(asphalt.build(), roadMat, { name: 'roads' });
    const mk = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.add(white.build(), mk(0xe6e6e0), { name: 'markings-white' });
    this.add(yellow.build(), mk(0xe8b923), { name: 'markings-yellow' });
  }

  // ---------------------------------------------------------------------------
  // Coast

  private buildCoast(): void {
    const b = this.world.layout.bounds;
    const sand = new GeoBuilder(false);
    const walls = new GeoBuilder(false);
    const end = sandHeight(b, b.beachEndX);
    // Sloped beach in strips so the slope reads well under shadows.
    const steps = 10;
    for (let i = 0; i < steps; i++) {
      const x0 = b.beachStartX + (BEACH_W * i) / steps;
      const x1 = b.beachStartX + (BEACH_W * (i + 1)) / steps;
      const y0 = sandHeight(b, x0);
      const y1 = sandHeight(b, x1);
      const s = 1 / 8;
      sand.quad(x0, y0, b.landMaxZ, x1, y1, b.landMaxZ, x1, y1, b.landMinZ, x0, y0, b.landMinZ, [x0 * s, -b.landMaxZ * s, x1 * s, -b.landMaxZ * s, x1 * s, -b.landMinZ * s, x0 * s, -b.landMinZ * s]);
    }
    // Drop-off into deep water.
    sand.quad(b.beachEndX, end, b.landMaxZ, b.beachEndX + 25, SEABED_Y, b.landMaxZ, b.beachEndX + 25, SEABED_Y, b.landMinZ, b.beachEndX, end, b.landMinZ, [0, 0, 1, 0, 1, 1, 0, 1]);
    // Quay walls (W, N, S) and the beach's north/south edges.
    const bottom = SEABED_Y;
    walls.wall(b.landMinX, b.landMinZ, b.landMinX, b.landMaxZ, bottom, CURB_H, { kind: 'world', scale: 3 });
    walls.wall(b.beachStartX, b.landMinZ, b.landMinX, b.landMinZ, bottom, CURB_H, { kind: 'world', scale: 3 });
    walls.wall(b.landMinX, b.landMaxZ, b.beachStartX, b.landMaxZ, bottom, CURB_H, { kind: 'world', scale: 3 });
    for (let i = 0; i < steps; i++) {
      const x0 = b.beachStartX + (BEACH_W * i) / steps;
      const x1 = b.beachStartX + (BEACH_W * (i + 1)) / steps;
      walls.quad(x1, bottom, b.landMinZ, x0, bottom, b.landMinZ, x0, sandHeight(b, x0), b.landMinZ, x1, sandHeight(b, x1), b.landMinZ, [0, 0, 1, 0, 1, 1, 0, 1]);
      walls.quad(x0, bottom, b.landMaxZ, x1, bottom, b.landMaxZ, x1, sandHeight(b, x1), b.landMaxZ, x0, sandHeight(b, x0), b.landMaxZ, [0, 0, 1, 0, 1, 1, 0, 1]);
    }
    const sandMat = new THREE.MeshStandardMaterial({ map: groundTexture('sand'), roughness: 1, metalness: 0 });
    this.add(sand.build(), sandMat, { name: 'beach' });
    this.add(walls.build(), new THREE.MeshStandardMaterial({ map: groundTexture('concrete', 3), roughness: 0.95 }), { name: 'quay' });

    // Piers.
    const deck = new GeoBuilder(false);
    const pillars: THREE.Vector3[] = [];
    for (const d of this.world.layout.decks) {
      deck.box(d.rect.minX, d.y - DECK_SLAB, d.rect.minZ, d.rect.maxX, d.y, d.rect.maxZ, { uv: { kind: 'world', scale: 4 }, bottom: true });
      for (let x = d.rect.minX + 2; x < d.rect.maxX; x += 7) {
        for (const z of [d.rect.minZ + 0.6, d.rect.maxZ - 0.6]) if (WATER_Y > this.world.baseGround(x, z) - 0.1) pillars.push(new THREE.Vector3(x, d.y, z));
      }
    }
    this.add(deck.build(), new THREE.MeshStandardMaterial({ map: groundTexture('wood', 2), roughness: 0.9 }), { shadow: true, name: 'piers' });
    if (pillars.length > 0) {
      const pg = new THREE.CylinderGeometry(0.25, 0.25, 1, 6);
      pg.translate(0, -0.5, 0);
      const pm = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9 }), pillars.length);
      const m = new THREE.Matrix4();
      pillars.forEach((p, i) => {
        const h = p.y - SEABED_Y;
        m.makeScale(1, h, 1);
        m.setPosition(p.x, p.y - DECK_SLAB, p.z);
        pm.setMatrixAt(i, m);
      });
      pm.instanceMatrix.needsUpdate = true;
      pm.computeBoundingSphere();
      this.group.add(pm);
    }
  }

  // ---------------------------------------------------------------------------
  // Garages, ramps, helipads

  private buildStructures(): void {
    const layout = this.world.layout;
    const garageGeo = new GeoBuilder(true);
    for (const g of layout.garages) {
      const col = hexToRgb(g.color);
      for (const w of g.walls) garageGeo.box(w.minX, 0, w.minZ, w.maxX, g.height, w.maxZ, { uv: { kind: 'world', scale: 3 }, color: col });
      garageGeo.box(g.rect.minX - 0.3, g.height, g.rect.minZ - 0.3, g.rect.maxX + 0.3, g.height + 0.4, g.rect.maxZ + 0.3, { uv: { kind: 'world', scale: 3 }, color: scaleRgb(col, 0.7), bottom: true });
      const poi = layout.pois.find((p) => p.id === g.poi)!;
      const text = poi.kind === 'spray' ? 'SPRAY SHACK' : "LOU'S AUTO";
      const color = poi.kind === 'spray' ? '#5cff9d' : '#ff9a5c';
      const fake: Building = { id: -1, rect: g.rect, height: g.height + 3.2, tiers: [], style: 'office', roof: 'flat', tint: 0, district: 'docks', roofProps: [], sign: null, ground: 'none', groundH: 0 };
      this.addSign(fake, text, color, g.side);
    }
    this.add(garageGeo.build(), new THREE.MeshStandardMaterial({ map: groundTexture('metal'), vertexColors: true, roughness: 0.7, metalness: 0.2 }), { shadow: true, name: 'garages' });

    // Stunt ramps: sloped plate plus side panels with hazard colours.
    const plate = new GeoBuilder(false);
    const sides = new GeoBuilder(true);
    for (const r of layout.ramps) {
      const fx = Math.sin(r.heading);
      const fz = Math.cos(r.heading);
      const sx = Math.cos(r.heading);
      const sz = -Math.sin(r.heading);
      const hw = r.width / 2;
      const hl = r.length / 2;
      const base = this.world.baseGround(r.x, r.z);
      const P = (along: number, side: number, h: number): [number, number, number] => [r.x + fx * along + sx * side, base + h, r.z + fz * along + sz * side];
      const a = P(-hl, -hw, 0.02);
      const bq = P(-hl, hw, 0.02);
      const c = P(hl, hw, r.height);
      const d = P(hl, -hw, r.height);
      plate.quad(...a, ...bq, ...c, ...d, [0, 0, 1, 0, 1, 3, 0, 3]);
      // Back face and side triangles.
      const e = P(hl, hw, 0);
      const f = P(hl, -hw, 0);
      sides.quad(...d, ...c, ...e, ...f, [0, 0, 1, 0, 1, 1, 0, 1], [0.9, 0.75, 0.1]);
      sides.tri(...bq, ...e, ...c, [0, 0, 1, 0, 1, 1], [0.95, 0.8, 0.1]);
      sides.tri(...a, ...d, ...f, [0, 0, 1, 1, 1, 0], [0.95, 0.8, 0.1]);
    }
    const plateMat = new THREE.MeshStandardMaterial({ map: groundTexture('metal', 5), roughness: 0.55, metalness: 0.5, side: THREE.DoubleSide });
    this.add(plate.build(), plateMat, { shadow: true, name: 'ramps' });
    this.add(sides.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), { shadow: true, name: 'ramp-sides' });

    // Helipads on rooftops.
    const pads = layout.buildings.flatMap((b) => b.roofProps.filter((p) => p.kind === 'helipad'));
    if (pads.length > 0) {
      const g = new GeoBuilder(false);
      for (const p of pads) {
        const h = p.w / 2;
        g.quad(p.x - h, p.y + 0.06, p.z + h, p.x + h, p.y + 0.06, p.z + h, p.x + h, p.y + 0.06, p.z - h, p.x - h, p.y + 0.06, p.z - h, [0, 0, 1, 0, 1, 1, 0, 1]);
      }
      this.add(g.build(), new THREE.MeshStandardMaterial({ map: helipadTexture(), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), { name: 'helipads' });
    }
  }

  /** Night factor 0..1, the time of day in hours (lit windows and shops) and the render time in seconds (TV flicker). */
  update(night: number, hours: number, time: number): void {
    this.nightU.occupancy.value = occupancy(hours);
    this.nightU.shopOccupancy.value = shopOccupancy(hours);
    this.nightU.time.value = time % 1000;
    for (const m of this.materials.facades.values()) m.emissiveIntensity = night * 1.4;
    if (this.materials.storefront) this.materials.storefront.emissiveIntensity = night * 1.5;
    for (const m of this.materials.signs) m.emissiveIntensity = 0.35 + night * 3.2;
  }
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

/** Thin horizontal strip between two points (for markings). */
function quadLine(g: GeoBuilder, ax: number, az: number, bx: number, bz: number, width: number, y: number): void {
  const dx = bx - ax;
  const dz = bz - az;
  const l = Math.hypot(dx, dz) || 1;
  // Right-hand normal so the quad faces up with CCW winding.
  const nx = (-dz / l) * (width / 2);
  const nz = (dx / l) * (width / 2);
  const ux = dx / l;
  const uz = dz / l;
  // Order: left-start, right-start... choose winding facing +Y.
  const p0 = [ax - nx, az - nz];
  const p1 = [ax + nx, az + nz];
  const p2 = [bx + nx, bz + nz];
  const p3 = [bx - nx, bz - nz];
  // Check orientation: cross((p1-p0),(p2-p0)).y must be > 0.
  const cy = (p1[1]! - p0[1]!) * (p2[0]! - p0[0]!) - (p1[0]! - p0[0]!) * (p2[1]! - p0[1]!);
  void ux;
  void uz;
  if (cy > 0) g.quad(p0[0]!, y, p0[1]!, p1[0]!, y, p1[1]!, p2[0]!, y, p2[1]!, p3[0]!, y, p3[1]!, [0, 0, 1, 0, 1, 1, 0, 1]);
  else g.quad(p3[0]!, y, p3[1]!, p2[0]!, y, p2[1]!, p1[0]!, y, p1[1]!, p0[0]!, y, p0[1]!, [0, 0, 1, 0, 1, 1, 0, 1]);
}

export { BOARDWALK_W };
