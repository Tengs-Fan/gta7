// Immutable city data plus the queries the simulation needs: colliders,
// ground height, water, zones and free-space searches.

import { circleVsAabb, makeContact } from '../core/collision';
import { CITY_SEED, CURB_H, SEABED_Y, SWIM_DEPTH, WATER_Y } from './constants';
import { StaticGrid, makeRayHit, type StaticCollider } from './colliders';
import { cellBlock, generateCity, headlandAt, PARAPET_H, rectContains, sandHeight, waterAt, type Block, type CityLayout, type District, type Prop, type Ramp, type Rect } from './layout';
import { RoadNetwork } from './roads';
import { SidewalkGraph } from './sidewalks';
import { hillSignLetters, lookoutRail, riseAt, terrainCores } from './terrain';

/**
 * The roof slab over a garage's walls, as render/city/structures.ts draws it: from the top of the walls up this
 * thick (m), overhanging the garage's rectangle by GARAGE_EAVE on every side.
 */
export const GARAGE_ROOF = 0.4;
export const GARAGE_EAVE = 0.3;

/**
 * A moored boat as render/props.ts buildBoat draws it, in its own frame (x along the hull, bow at +x;
 * the boat is turned rot + PI/2 about Y): the hull's and the cabin's footprints, and the deck and cabin
 * roof heights above the prop's y.
 */
export const BOAT_HULL = { x0: -5, x1: 7, z0: -1.3, z1: 1.3 };
export const BOAT_CABIN = { x0: -2.2, x1: 1.2, z0: -1, z1: 1 };
export const BOAT_DECK = 1.2;
export const BOAT_ROOF = 2.5;
/** How far under the surface a body floats in deep water: its feet (sim/characterPhysics SWIM_FLOAT). */
export const FLOAT_FEET = 1.3;
/**
 * The Ferris wheel as render/props.ts buildFerris draws it, in its own frame (turned by rot about Y; the wheel turns about
 * its local z axis): its hub stands FERRIS_HUB above the prop's y, high enough that the gondolas, hung 2.6 m under a rim of
 * radius 22, pass 3.9 m over the deck (a bus is 3.2 m tall). Two A-frames at z = +-FERRIS_LEG_Z hold it, each leg straight
 * from the hub through x = +-FERRIS_LEG_X at the prop's y, beside the deck, and on down into the sea.
 */
export const FERRIS_HUB = 28.5;
export const FERRIS_LEG_X = 12.1;
export const FERRIS_LEG_Z = 3.2;

export class StaticWorld {
  readonly layout: CityLayout;
  readonly roads: RoadNetwork;
  readonly walk: SidewalkGraph;
  readonly grid: StaticGrid;
  /** Collider id for each prop index (or -1). */
  readonly propColliders: number[] = [];
  private readonly contact = makeContact();
  /** Decks and ramps by grid cell, for groundHeight. */
  private readonly surfaces: SurfaceGrid;
  readonly scratchHit = makeRayHit();

  constructor(seed: number = CITY_SEED) {
    this.layout = generateCity(seed);
    this.roads = new RoadNetwork(this.layout);
    this.walk = new SidewalkGraph(this.layout, this.roads);
    const b = this.layout.bounds;
    this.grid = new StaticGrid(b.worldMinX, b.worldMinZ, b.worldMaxX, b.worldMaxZ, 12);
    this.buildColliders();
    this.surfaces = buildSurfaceGrid(this.layout.decks.map((d) => d.rect), this.layout.ramps.map(rampBounds));
  }

  private buildColliders(): void {
    const g = this.grid;
    for (const b of this.layout.buildings) {
      b.tiers.forEach((t, i) => g.addBox(t.minX, t.minZ, t.maxX, t.maxZ, i === 0 ? 0 : t.y0, t.y1, 'building'));
    }
    for (const gar of this.layout.garages) {
      for (const w of gar.walls) g.addBox(w.minX, w.minZ, w.maxX, w.maxZ, 0, gar.height, 'wall');
      // The roof hides the bay from the helicopter and stops shots and the camera from above. It is no
      // obstacle on the way in: cars and people collide only with what overlaps their own height.
      const r = gar.rect;
      g.addBox(r.minX - GARAGE_EAVE, r.minZ - GARAGE_EAVE, r.maxX + GARAGE_EAVE, r.maxZ + GARAGE_EAVE, gar.height, gar.height + GARAGE_ROOF, 'wall');
    }
    for (const r of this.layout.parapets) g.addBox(r.minX, r.minZ, r.maxX, r.maxZ, CURB_H, CURB_H + PARAPET_H, 'wall');
    this.layout.props.forEach((p, i) => {
      this.propColliders[i] = this.addPropCollider(p, i);
    });
    // The rises' sight cores, buried out of reach of anything on the ground (world/terrain.ts), the letters of the hill
    // sign and the parapet of the lookout at Azura Point.
    for (const c of terrainCores(this.layout.rises)) g.addBox(c.minX, c.minZ, c.maxX, c.maxZ, -1, c.y1, 'terrain');
    for (const l of hillSignLetters(this.layout.rises)) g.addBox(l.box.minX, l.box.minZ, l.box.maxX, l.box.maxZ, l.box.y0, l.box.y1, 'wall');
    const rail = lookoutRail(this.layout);
    g.addBox(rail.minX, rail.minZ, rail.maxX, rail.maxZ, rail.y, rail.y + PARAPET_H, 'wall');
  }

  private addPropCollider(p: Prop, i: number): number {
    const g = this.grid;
    const s = p.scale;
    switch (p.kind) {
      case 'lamp':
        return g.addCircle(p.x, p.z, 0.17, p.y, p.y + 6.5, 'lamp', i, true).id;
      case 'signal':
        return g.addCircle(p.x, p.z, 0.2, p.y, p.y + 5.5, 'signal', i, true).id;
      case 'tree':
        return g.addCircle(p.x, p.z, 0.32 * s, p.y, p.y + 7 * s, 'tree').id;
      case 'palm':
        return g.addCircle(p.x, p.z, 0.3 * s, p.y, p.y + 9 * s, 'palm').id;
      case 'hydrant':
        return g.addCircle(p.x, p.z, 0.22, p.y, p.y + 0.8, 'hydrant', i, true).id;
      case 'bin':
        return g.addCircle(p.x, p.z, 0.32, p.y, p.y + 1.1, 'bin', i, true).id;
      case 'bench': {
        const along = Math.abs(Math.sin(p.rot)) > 0.7; // facing E/W => bench extends along Z
        const hw = along ? 0.35 : 0.95;
        const hd = along ? 0.95 : 0.35;
        return g.addBox(p.x - hw, p.z - hd, p.x + hw, p.z + hd, p.y, p.y + 0.9, 'bench', i, true).id;
      }
      case 'fountain':
        return g.addCircle(p.x, p.z, 3.3, p.y, p.y + 1.3, 'rock').id;
      case 'container':
        return g.addBox(p.x - p.w / 2, p.z - p.d / 2, p.x + p.w / 2, p.z + p.d / 2, p.y, p.y + p.h, 'container').id;
      case 'lighthouse':
        return g.addCircle(p.x, p.z, 3.6, p.y, p.y + 26, 'pillar').id;
      case 'crane': {
        // Four legs of a gantry crane spanning 12 m x 10 m.
        for (const [lx, lz] of [[-6, -5], [6, -5], [-6, 5], [6, 5]] as const) g.addBox(p.x + lx - 0.6, p.z + lz - 0.6, p.x + lx + 0.6, p.z + lz + 0.6, 0, 30, 'pillar');
        return -1;
      }
      case 'ferris': {
        // Nothing of the wheel comes near the deck: the gondolas pass 3.9 m over it, and the legs stand in the sea on either
        // side. A post round each leg where it meets the water, from below the swimmers' collision band up to the deck.
        const out = FERRIS_LEG_X * (1 + (p.y - WATER_Y) / FERRIS_HUB);
        const cos = Math.cos(p.rot);
        const sin = Math.sin(p.rot);
        let id = -1;
        for (const lx of [-out, out]) {
          for (const lz of [-FERRIS_LEG_Z, FERRIS_LEG_Z]) id = g.addCircle(p.x + lx * cos + lz * sin, p.z - lx * sin + lz * cos, 0.45, WATER_Y - 1.5, p.y, 'pillar').id;
        }
        return id;
      }
      case 'billboard': {
        // Posts under the rendered legs (render/props.ts buildBillboard, local x = +-4.5).
        const along = Math.abs(Math.sin(p.rot)) > 0.7;
        const ox = along ? 0 : 4.5;
        const oz = along ? 4.5 : 0;
        g.addCircle(p.x - ox, p.z - oz, 0.35, p.y, p.y + 9, 'pillar');
        return g.addCircle(p.x + ox, p.z + oz, 0.35, p.y, p.y + 9, 'pillar').id;
      }
      case 'boat': {
        // The hull up to its deck, from below the swimmers' collision band, and the cabin on top: two
        // boxes rather than one up to the cabin roof, which would stand an invisible wall over the low
        // deck. Both are solid for sight, so shots, the camera and line of sight stop at a moored boat.
        this.addBoatBox(p, BOAT_HULL, WATER_Y - 1.5, p.y + BOAT_DECK);
        return this.addBoatBox(p, BOAT_CABIN, p.y + BOAT_DECK, p.y + BOAT_ROOF).id;
      }
      case 'bush':
      default:
        return -1;
    }
  }

  /**
   * A box of a moored boat (`r` in the boat's own frame, as render/props.ts buildBoat draws it) between
   * heights y0 and y1: the world-axis box round it once turned by rot + PI/2 about Y (exact at quarter
   * turns; every boat lies along Z today).
   */
  private addBoatBox(p: Prop, r: { x0: number; x1: number; z0: number; z1: number }, y0: number, y1: number): StaticCollider {
    const a = p.rot + Math.PI / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const lx of [r.x0, r.x1]) {
      for (const lz of [r.z0, r.z1]) {
        const x = p.x + lx * cos + lz * sin;
        const z = p.z - lx * sin + lz * cos;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
    return this.grid.addBox(minX, minZ, maxX, maxZ, y0, y1, 'boat');
  }

  get bounds() {
    return this.layout.bounds;
  }

  /** Terrain height ignoring ramps and decks: the rises (world/terrain.ts) stand on lawns and the headland only. */
  baseGround(x: number, z: number): number {
    const b = this.layout.bounds;
    if (x < b.landMinX || z < b.landMinZ || z > b.landMaxZ || x > b.beachEndX) return headlandAt(this.layout, x, z) ? CURB_H + riseAt(this.layout.rises, x, z) : SEABED_Y;
    if (waterAt(this.layout, x, z)) return SEABED_Y;
    if (x >= b.beachStartX) return sandHeight(b, x);
    if (this.roads.isOnRoad(x, z)) return 0;
    return CURB_H + riseAt(this.layout.rises, x, z);
  }

  /** Height of the ground, a deck or a ramp's surface at (x, z), whichever is highest. */
  groundHeight(x: number, z: number): number {
    const base = this.baseGround(x, z);
    const s = this.surfaces;
    const cx = Math.floor((x - s.minX) / SURFACE_CELL);
    const cz = Math.floor((z - s.minZ) / SURFACE_CELL);
    // Also false for NaN.
    if (!(cx >= 0 && cx < s.nx && cz >= 0 && cz < s.nz)) return base;
    const c = cz * s.nx + cx;
    let h = base;
    const decks = this.layout.decks;
    for (let i = s.deckStart[c]!, end = s.deckStart[c + 1]!; i < end; i++) {
      const d = decks[s.deckIndex[i]!]!;
      if (d.y > h && rectContains(d.rect, x, z)) h = d.y;
    }
    const ramps = this.layout.ramps;
    for (let i = s.rampStart[c]!, end = s.rampStart[c + 1]!; i < end; i++) {
      const rh = rampHeight(ramps[s.rampIndex[i]!]!, x, z);
      if (rh > 0) {
        const top = base + rh;
        if (top > h) h = top;
      }
    }
    return h;
  }

  /** Positive when the point is under water by that many metres. */
  waterDepth(x: number, z: number): number {
    return WATER_Y - this.groundHeight(x, z);
  }

  isOnRoad(x: number, z: number): boolean {
    return this.roads.isOnRoad(x, z);
  }

  zoneName(x: number, z: number): string {
    const l = this.layout;
    for (const d of l.decks) if (rectContains(d.rect, x, z)) return d.name;
    const b = l.bounds;
    if (x < b.landMinX || z < b.landMinZ || z > b.landMaxZ || x > b.beachEndX) return headlandAt(l, x, z)?.name ?? 'San Azura Bay';
    const water = waterAt(l, x, z);
    if (water) return water.name;
    if (x > b.cityMaxX) return 'Ocean Beach';
    return this.blockNear(x, z).zone;
  }

  /** The block on the cell under (x, z), or by a sea cell the nearest block. */
  blockNear(x: number, z: number): Block {
    const l = this.layout;
    const block = cellBlock(l, lineSegment(l.vLines, x), lineSegment(l.hLines, z));
    if (block) return block;
    let best = l.blocks[0]!;
    let bd = Infinity;
    for (const b of l.blocks) {
      const d = Math.hypot(Math.max(b.rect.minX - x, x - b.rect.maxX, 0), Math.max(b.rect.minZ - z, z - b.rect.maxZ, 0));
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  /**
   * True when a circle at ground level overlaps no solid static collider and is not deep water (or, with
   * allowWater, a body floating there in deep water overlaps none: a moored boat's hull blocks it).
   */
  isFree(x: number, z: number, r: number, allowWater = false): boolean {
    // NaN fails every bounds test below and would come out free.
    if (!Number.isFinite(x + z + r)) return false;
    const b = this.layout.bounds;
    if (x < b.worldMinX + 1 || x > b.worldMaxX - 1 || z < b.worldMinZ + 1 || z > b.worldMaxZ - 1) return false;
    const depth = this.waterDepth(x, z);
    if (!allowWater && depth > 0.3) return false;
    const y = depth > SWIM_DEPTH ? WATER_Y - FLOAT_FEET : this.groundHeight(x, z);
    let free = true;
    this.grid.query(x - r, z - r, x + r, z + r, (c) => {
      if (!free) return;
      if (c.y0 > y + 1.8 || c.y1 < y + 0.2) return;
      if (c.circle) {
        if ((c.cx - x) ** 2 + (c.cz - z) ** 2 < (c.r + r) ** 2) free = false;
      } else if (circleVsAabb(x, z, r, c, this.contact)) {
        free = false;
      }
    });
    return free;
  }

  /** Searches outward in rings for a free spot near (x, z). */
  findFreeSpot(x: number, z: number, r: number, maxRadius = 30, allowWater = false): { x: number; z: number } | null {
    if (!Number.isFinite(x + z)) return null;
    if (this.isFree(x, z, r, allowWater)) return { x, z };
    for (let ring = 1; ring * 1.5 <= maxRadius; ring++) {
      const rad = ring * 1.5;
      const steps = Math.max(8, Math.round(rad * 4));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const px = x + Math.cos(a) * rad;
        const pz = z + Math.sin(a) * rad;
        if (this.isFree(px, pz, r, allowWater)) return { x: px, z: pz };
      }
    }
    return null;
  }

  /** Marks a breakable prop as broken. Returns the prop index or -1. */
  breakCollider(c: StaticCollider): number {
    if (!c.breakable || c.broken) return -1;
    c.broken = true;
    return c.propIndex;
  }

  /** Restores every broken prop (new game). */
  resetBroken(): void {
    for (const c of this.grid.colliders) c.broken = false;
  }

  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.grid.lineOfSight(ax, ay, az, bx, by, bz, this.scratchHit);
  }

  /**
   * The district at (x, z): a city block's district (roads and the promenades take the nearest block's),
   * 'beach' east of the city down to the waterline, and 'sea' over water (decks included).
   */
  districtAt(x: number, z: number): District | 'beach' | 'sea' {
    if (!Number.isFinite(x) || !Number.isFinite(z) || this.baseGround(x, z) < WATER_Y) return 'sea';
    const l = this.layout;
    if (x > l.bounds.cityMaxX) return 'beach';
    return this.blockNear(x, z).district;
  }
}

/** Side of a groundHeight grid cell (m). */
const SURFACE_CELL = 16;
/** Bounds are widened by this much (m) so float rounding at an edge can never leave a deck or ramp out of a cell. */
const SURFACE_PAD = 0.05;

/**
 * Decks and ramps listed per cell of a uniform grid over their joint bounds (compressed rows: the indices of cell c are
 * index[start[c] .. start[c + 1]]), in their layout order.
 */
interface SurfaceGrid {
  minX: number;
  minZ: number;
  nx: number;
  nz: number;
  deckStart: Int32Array;
  deckIndex: Int32Array;
  rampStart: Int32Array;
  rampIndex: Int32Array;
}

/** The world-axis box round a ramp's footprint. */
function rampBounds(r: Ramp): Rect {
  const ex = (Math.abs(Math.sin(r.heading)) * r.length + Math.abs(Math.cos(r.heading)) * r.width) / 2;
  const ez = (Math.abs(Math.cos(r.heading)) * r.length + Math.abs(Math.sin(r.heading)) * r.width) / 2;
  return { minX: r.x - ex, maxX: r.x + ex, minZ: r.z - ez, maxZ: r.z + ez };
}

function buildSurfaceGrid(decks: readonly Rect[], ramps: readonly Rect[]): SurfaceGrid {
  const all = [...decks, ...ramps];
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const r of all) {
    minX = Math.min(minX, r.minX - SURFACE_PAD);
    minZ = Math.min(minZ, r.minZ - SURFACE_PAD);
    maxX = Math.max(maxX, r.maxX + SURFACE_PAD);
    maxZ = Math.max(maxZ, r.maxZ + SURFACE_PAD);
  }
  if (!all.length) {
    minX = minZ = 0;
    maxX = maxZ = 0;
  }
  const nx = Math.max(1, Math.ceil((maxX - minX) / SURFACE_CELL));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / SURFACE_CELL));
  const bucket = (rects: readonly Rect[]): { start: Int32Array; index: Int32Array } => {
    const cells: number[][] = Array.from({ length: nx * nz }, () => []);
    rects.forEach((r, i) => {
      const x0 = Math.max(0, Math.floor((r.minX - SURFACE_PAD - minX) / SURFACE_CELL));
      const x1 = Math.min(nx - 1, Math.floor((r.maxX + SURFACE_PAD - minX) / SURFACE_CELL));
      const z0 = Math.max(0, Math.floor((r.minZ - SURFACE_PAD - minZ) / SURFACE_CELL));
      const z1 = Math.min(nz - 1, Math.floor((r.maxZ + SURFACE_PAD - minZ) / SURFACE_CELL));
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) cells[cz * nx + cx]!.push(i);
    });
    const start = new Int32Array(nx * nz + 1);
    for (let c = 0; c < cells.length; c++) start[c + 1] = start[c]! + cells[c]!.length;
    return { start, index: Int32Array.from(cells.flat()) };
  };
  const d = bucket(decks);
  const r = bucket(ramps);
  return { minX, minZ, nx, nz, deckStart: d.start, deckIndex: d.index, rampStart: r.start, rampIndex: r.index };
}

/** Height of a ramp surface above its base at (x, z), or 0 when outside. */
export function rampHeight(r: Ramp, x: number, z: number): number {
  const fx = Math.sin(r.heading);
  const fz = Math.cos(r.heading);
  const dx = x - r.x;
  const dz = z - r.z;
  const along = dx * fx + dz * fz;
  const side = dx * fz - dz * fx;
  if (Math.abs(along) > r.length / 2 || Math.abs(side) > r.width / 2) return 0;
  return (r.height * (along + r.length / 2)) / r.length;
}

/** Index i of the cell between lines i and i + 1 holding v (clamped). */
function lineSegment(lines: readonly { pos: number }[], v: number): number {
  for (let i = 0; i < lines.length - 1; i++) if (v < lines[i + 1]!.pos) return i;
  return lines.length - 2;
}
