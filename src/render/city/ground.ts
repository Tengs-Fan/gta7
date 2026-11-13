// Ground: sidewalks, lots, promenade.

import * as THREE from 'three';
import { CROSSWALK_W, CURB_H, SIDEWALK_W } from '../../world/constants';
import { cellBlock, mkRect, rectContains, rectsMinus, rectsOverlap, waterAt, type Block, type CityLayout, type GroundKind, type Rect } from '../../world/layout';
import type { RoadNetwork } from '../../world/roads';
import { riseAt, riseBounds } from '../../world/terrain';
import { GeoBuilder, type UvMode } from '../geo';
import type { CityView } from './index';
import { quadLine } from './shared';
import { KERBSTONE_W, LAWN_OVERHANG, NO_RECT, rectRange, setGroundAttribute, type GroundDetail, type GroundRange } from './surfaces';

const GROUND_TEX: Record<GroundKind, 'grass' | 'plaza' | 'asphalt' | 'dirt'> = {
  grass: 'grass',
  yard: 'grass',
  plaza: 'plaza',
  parking: 'asphalt',
  dirt: 'dirt',
};

const DETAIL: Record<'grass' | 'plaza' | 'asphalt' | 'dirt', GroundDetail> = { grass: 'grass', plaza: 'paving', asphalt: 'lot', dirt: 'plain' };

type Rect4 = [number, number, number, number];
const rect4 = (r: Rect): Rect4 => [r.minX, r.minZ, r.maxX, r.maxZ];

/** Lattice (m) of the ground drawn over a rise: the sim's cosine slopes stay within a centimetre of its triangles. */
const RISE_STEP = 2;

/**
 * In front of a house lot a grass verge runs between the kerbstones and the footpath, from VERGE_FROM to VERGE_TO (m)
 * out from the kerb: the lamps (0.9 m) and trees (1.1 m) stand in it, and people walk the footpath beyond (2.2 m).
 */
export const VERGE_FROM = KERBSTONE_W;
export const VERGE_TO = 1.8;
/** Verges stop this far (m) short of a block's corners, so the crossings land on paving. */
const VERGE_CORNER = CROSSWALK_W + 1;

export interface Verge {
  /** The grass drawn. */
  rect: Rect;
  /** The lawn rectangle its shader frays out from: only the footpath side lies inside the drawn grass, by LAWN_OVERHANG. */
  edge: Rect4;
}

/** The verges in front of every house lot (yard), in layout order. */
export function vergesOf(layout: CityLayout): Verge[] {
  const out: Verge[] = [];
  for (const g of layout.ground) {
    if (g.kind !== 'yard') continue;
    const b = layout.blocks.find((bl) => g.rect.minX >= bl.rect.minX - 0.01 && g.rect.maxX <= bl.rect.maxX + 0.01 && g.rect.minZ >= bl.rect.minZ - 0.01 && g.rect.maxZ <= bl.rect.maxZ + 0.01);
    if (!b) continue;
    const r = b.rect;
    const sides = [
      { on: Math.abs(g.rect.minZ - (r.minZ + SIDEWALK_W)) < 0.01, alongX: true, k0: r.minZ + VERGE_FROM, k1: r.minZ + VERGE_TO, out: 1 },
      { on: Math.abs(g.rect.maxZ - (r.maxZ - SIDEWALK_W)) < 0.01, alongX: true, k0: r.maxZ - VERGE_TO, k1: r.maxZ - VERGE_FROM, out: -1 },
      { on: Math.abs(g.rect.minX - (r.minX + SIDEWALK_W)) < 0.01, alongX: false, k0: r.minX + VERGE_FROM, k1: r.minX + VERGE_TO, out: 1 },
      { on: Math.abs(g.rect.maxX - (r.maxX - SIDEWALK_W)) < 0.01, alongX: false, k0: r.maxX - VERGE_TO, k1: r.maxX - VERGE_FROM, out: -1 },
    ];
    for (const s of sides) {
      if (!s.on) continue;
      const lo = Math.max(s.alongX ? g.rect.minX : g.rect.minZ, (s.alongX ? r.minX : r.minZ) + VERGE_CORNER);
      const hi = Math.min(s.alongX ? g.rect.maxX : g.rect.maxZ, (s.alongX ? r.maxX : r.maxZ) - VERGE_CORNER);
      if (hi - lo < 1) continue;
      // The footpath edge is k1 on a verge whose lot lies towards +; k0 otherwise.
      const e0 = s.out > 0 ? s.k0 - 1 : s.k0 + LAWN_OVERHANG;
      const e1 = s.out > 0 ? s.k1 - LAWN_OVERHANG : s.k1 + 1;
      out.push(
        s.alongX
          ? { rect: mkRect(lo, s.k0, hi, s.k1), edge: [lo - 1, e0, hi + 1, e1] }
          : { rect: mkRect(s.k0, lo, s.k1, hi), edge: [e0, lo - 1, e1, hi + 1] },
      );
    }
  }
  return out;
}

/** A tactile pad runs from just behind the kerbstones to this far (m) from the kerb, along the crossing short of its stripes' ends. */
export const TACTILE_TO = 0.95;
const TACTILE_FROM = KERBSTONE_W + 0.04;
const TACTILE_INSET = 0.4;

export interface TactilePad {
  rect: Rect;
  /** The kerb rectangle of the sidewalk it lies on (a block's, or the city's for the promenade ring). */
  kerb: Rect4;
}

/** A tactile pad on the sidewalk at both ends of every zebra crossing that lands on one (not a bridge's or the sea's side). */
export function tactilePads(layout: CityLayout, roads: RoadNetwork): TactilePad[] {
  const b = layout.bounds;
  const city: Rect4 = [b.cityMinX, b.cityMinZ, b.cityMaxX, b.cityMaxZ];
  const kerbAt = (x: number, z: number): Rect4 | null => {
    const blk = layout.blocks.find((k) => rectContains(k.rect, x, z));
    if (blk) return Math.min(x - blk.rect.minX, blk.rect.maxX - x, z - blk.rect.minZ, blk.rect.maxZ - z) < SIDEWALK_W ? rect4(blk.rect) : null;
    const out = Math.max(b.cityMinX - x, x - b.cityMaxX, b.cityMinZ - z, z - b.cityMaxZ);
    return out > 0 && out < SIDEWALK_W && !waterAt(layout, x, z) ? city : null;
  };
  const out: TactilePad[] = [];
  for (const n of roads.gridNodes) {
    for (let d = 0; d < 4; d++) {
      // A gateway's arm out to the county crosses the promenade, not a sidewalk (as the sidewalk graph has it).
      if (n.neighbors[d]! < 0 || n.neighbors[d]! >= roads.gridNodeCount) continue;
      // As the zebra in roads.ts: CROSSWALK_W along the road beyond the junction box, across the road's full width.
      const vertical = d === 0 || d === 2;
      const sign = d === 0 || d === 3 ? -1 : 1;
      const halfAlong = vertical ? n.halfZ : n.halfX;
      const halfAcross = vertical ? n.halfX : n.halfZ;
      const a0 = sign * (halfAlong + TACTILE_INSET);
      const a1 = sign * (halfAlong + CROSSWALK_W - TACTILE_INSET);
      for (const side of [-1, 1]) {
        const c0 = side * (halfAcross + TACTILE_FROM);
        const c1 = side * (halfAcross + TACTILE_TO);
        const rect = vertical
          ? mkRect(n.x + Math.min(c0, c1), n.z + Math.min(a0, a1), n.x + Math.max(c0, c1), n.z + Math.max(a0, a1))
          : mkRect(n.x + Math.min(a0, a1), n.z + Math.min(c0, c1), n.x + Math.max(a0, a1), n.z + Math.max(c0, c1));
        const kerb = kerbAt((rect.minX + rect.maxX) / 2, (rect.minZ + rect.maxZ) / 2);
        if (kerb) out.push({ rect, kerb });
      }
    }
  }
  return out;
}

export function buildGround(view: CityView): void {
  const layout = view.world.layout;
  const surfaces = view.ground;
  const walk = new GeoBuilder(false);
  const walkRanges: GroundRange[] = [];
  const curbs = new GeoBuilder(false);
  const patches = new Map<string, { g: GeoBuilder; ranges: GroundRange[] }>();
  const patch = (k: string) => {
    let p = patches.get(k);
    if (!p) {
      p = { g: new GeoBuilder(false), ranges: [] };
      patches.set(k, p);
    }
    return p;
  };
  const y = CURB_H;
  const sw = SIDEWALK_W;
  const rises = layout.rises;
  // A patch on a rise follows it (a grid on the shared lattice); every other one is a flat quad.
  const patchSurface = (g: GeoBuilder, minX: number, minZ: number, maxX: number, maxZ: number, uv: UvMode) => {
    if (rises.some((r) => rectsOverlap(riseBounds(r), mkRect(minX, minZ, maxX, maxZ)))) g.heightGrid(minX, minZ, maxX, maxZ, RISE_STEP, (x, z) => y + 0.004 + riseAt(rises, x, z), uv);
    else g.flat(minX, minZ, maxX, maxZ, y + 0.004, uv);
  };
  const walkUv = { kind: 'world', scale: surfaces.tile('kerb') } as const;
  const curbUv = { kind: 'world', scale: surfaces.tile('curb') } as const;
  // Each sidewalk strip carries the rectangle whose sides are its kerbs (the shader darkens the paving along them).
  const strip = (minX: number, minZ: number, maxX: number, maxZ: number, kerb: Rect4) => {
    const start = walk.vertexCount;
    walk.flat(minX, minZ, maxX, maxZ, y, walkUv);
    walkRanges.push(rectRange(start, walk.vertexCount, kerb));
  };
  for (const blk of layout.blocks) {
    const r = blk.rect;
    const kerb = rect4(r);
    // Sidewalk ring (4 non-overlapping strips).
    strip(r.minX, r.minZ, r.maxX, r.minZ + sw, kerb);
    strip(r.minX, r.maxZ - sw, r.maxX, r.maxZ, kerb);
    strip(r.minX, r.minZ + sw, r.minX + sw, r.maxZ - sw, kerb);
    strip(r.maxX - sw, r.minZ + sw, r.maxX, r.maxZ - sw, kerb);
    // Curb faces, except where the sidewalk meets the canal (its quay wall runs on down there).
    const cz = (r.minZ + r.maxZ) / 2;
    const cx = (r.minX + r.maxX) / 2;
    if (!waterAt(layout, cx, r.maxZ + 0.5)) curbs.wall(r.minX, r.maxZ, r.maxX, r.maxZ, 0, y, curbUv);
    if (!waterAt(layout, r.maxX + 0.5, cz)) curbs.wall(r.maxX, r.maxZ, r.maxX, r.minZ, 0, y, curbUv);
    if (!waterAt(layout, cx, r.minZ - 0.5)) curbs.wall(r.maxX, r.minZ, r.minX, r.minZ, 0, y, curbUv);
    if (!waterAt(layout, r.minX - 0.5, cz)) curbs.wall(r.minX, r.minZ, r.minX, r.maxZ, 0, y, curbUv);
  }
  for (const gp of layout.ground) {
    const tex = GROUND_TEX[gp.kind];
    const detail = DETAIL[tex];
    const scale = detail === 'plain' ? 8 : surfaces.tile(detail);
    const p = patch(tex);
    const start = p.g.vertexCount;
    if (tex === 'grass') {
      // A lawn meeting a sidewalk spills a frayed strip onto the paving; the shader works its edge out from the
      // sidewalk's inner rectangle.
      const blk = layout.blocks.find((bl) => gp.rect.minX >= bl.rect.minX - 0.01 && gp.rect.maxX <= bl.rect.maxX + 0.01 && gp.rect.minZ >= bl.rect.minZ - 0.01 && gp.rect.maxZ <= bl.rect.maxZ + 0.01);
      const inner: Rect4 = blk ? [blk.rect.minX + sw, blk.rect.minZ + sw, blk.rect.maxX - sw, blk.rect.maxZ - sw] : [...NO_RECT];
      const out = (a: number, edge: number) => (Math.abs(a - edge) < 0.01 ? LAWN_OVERHANG : 0);
      const minX = gp.rect.minX - out(gp.rect.minX, inner[0]);
      const minZ = gp.rect.minZ - out(gp.rect.minZ, inner[1]);
      const maxX = gp.rect.maxX + out(gp.rect.maxX, inner[2]);
      const maxZ = gp.rect.maxZ + out(gp.rect.maxZ, inner[3]);
      patchSurface(p.g, minX, minZ, maxX, maxZ, { kind: 'world', scale });
      p.ranges.push(rectRange(start, p.g.vertexCount, inner));
    } else {
      patchSurface(p.g, gp.rect.minX, gp.rect.minZ, gp.rect.maxX, gp.rect.maxZ, { kind: 'world', scale });
    }
  }
  for (const v of vergesOf(layout)) {
    const p = patch('grass');
    const start = p.g.vertexCount;
    p.g.flat(v.rect.minX, v.rect.minZ, v.rect.maxX, v.rect.maxZ, y + 0.004, { kind: 'world', scale: surfaces.tile('grass') });
    p.ranges.push(rectRange(start, p.g.vertexCount, v.edge));
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

  // Outer land around the city, short of the sea where it comes in: sidewalk ring + promenade strips + boardwalk.
  const b = layout.bounds;
  const water = layout.water.flatMap((w) => w.rects);
  const prom = patch('plaza').g;
  const wood = new GeoBuilder(false);
  const city: Rect4 = [b.cityMinX, b.cityMinZ, b.cityMaxX, b.cityMaxZ];
  const ring = [
    mkRect(b.cityMinX - sw, b.cityMinZ - sw, b.cityMaxX + sw, b.cityMinZ),
    mkRect(b.cityMinX - sw, b.cityMaxZ, b.cityMaxX + sw, b.cityMaxZ + sw),
    mkRect(b.cityMinX - sw, b.cityMinZ, b.cityMinX, b.cityMaxZ),
    mkRect(b.cityMaxX, b.cityMinZ, b.cityMaxX + sw, b.cityMaxZ),
  ];
  // Las Lomas County's links run through the west promenade at road level (render/country/roads.ts draws their mouths).
  const mouths = view.world.roads.mouths;
  for (const r of rectsMinus(ring, [...water, ...mouths])) strip(r.minX, r.minZ, r.maxX, r.maxZ, city);
  const promenade = [
    mkRect(b.landMinX, b.landMinZ, b.cityMinX - sw, b.landMaxZ),
    mkRect(b.cityMinX - sw, b.landMinZ, b.beachStartX, b.cityMinZ - sw),
    mkRect(b.cityMinX - sw, b.cityMaxZ + sw, b.beachStartX, b.landMaxZ),
  ];
  for (const r of rectsMinus(promenade, [...water, ...mouths])) prom.flat(r.minX, r.minZ, r.maxX, r.maxZ, y, { kind: 'world', scale: 6 });
  // The quays between the coast roads and the water: what the sea's cells keep inside the ring road.
  const roads = view.world.roads;
  const paved: Rect[] = [...roads.segments, ...roads.live.map((nd) => mkRect(nd.x - nd.halfX, nd.z - nd.halfZ, nd.x + nd.halfX, nd.z + nd.halfZ)), ...layout.blocks.map((bl) => bl.rect)];
  for (const w of layout.water) {
    const inside = w.area.map((r) => mkRect(Math.max(r.minX, b.cityMinX), Math.max(r.minZ, b.cityMinZ), Math.min(r.maxX, b.cityMaxX), Math.min(r.maxZ, b.cityMaxZ)));
    // A quay's strips abut one another: their rectangles come with minZ > maxZ, the shader's flag for no kerbstones.
    for (const r of rectsMinus(inside, [...w.rects, ...paved])) strip(r.minX, r.minZ, r.maxX, r.maxZ, [r.minX, r.maxZ, r.maxX, r.minZ]);
  }
  // Tactile pads a centimetre over the paving, their kerb rectangle reversed (the shader's flag for buff domed slabs).
  for (const t of tactilePads(layout, roads)) {
    const start = walk.vertexCount;
    walk.flat(t.rect.minX, t.rect.minZ, t.rect.maxX, t.rect.maxZ, y + 0.01, walkUv);
    walkRanges.push(rectRange(start, walk.vertexCount, [t.kerb[2], t.kerb[3], t.kerb[0], t.kerb[1]]));
  }
  // Kerbs along every road edge with no block beside it: the ring road's outer edge, the coast roads, the bridges.
  const n = layout.n;
  const cell = (bi: number, bj: number) => (bi >= 0 && bi < n && bj >= 0 && bj < n ? cellBlock(layout, bi, bj) : null);
  for (const sg of roads.segments) {
    const a = roads.nodes[sg.a]!;
    if (sg.vertical) {
      if (!cell(a.i - 1, a.j)) curbs.wall(sg.minX, sg.maxZ, sg.minX, sg.minZ, 0, y, curbUv);
      if (!cell(a.i, a.j)) curbs.wall(sg.maxX, sg.minZ, sg.maxX, sg.maxZ, 0, y, curbUv);
    } else {
      if (!cell(a.i, a.j - 1)) curbs.wall(sg.minX, sg.minZ, sg.maxX, sg.minZ, 0, y, curbUv);
      if (!cell(a.i, a.j)) curbs.wall(sg.maxX, sg.maxZ, sg.minX, sg.maxZ, 0, y, curbUv);
    }
  }
  for (const nd of roads.live) {
    const x0 = nd.x - nd.halfX;
    const x1 = nd.x + nd.halfX;
    const z0 = nd.z - nd.halfZ;
    const z1 = nd.z + nd.halfZ;
    // A side with no road leaving it meets the pavement, unless one block runs on across it (inside a superblock).
    const open = (p: Block | null, q: Block | null) => !(p && p === q);
    if (nd.neighbors[0]! < 0 && open(cell(nd.i - 1, nd.j - 1), cell(nd.i, nd.j - 1))) curbs.wall(x0, z0, x1, z0, 0, y, curbUv);
    if (nd.neighbors[2]! < 0 && open(cell(nd.i - 1, nd.j), cell(nd.i, nd.j))) curbs.wall(x1, z1, x0, z1, 0, y, curbUv);
    if (nd.neighbors[3]! < 0 && open(cell(nd.i - 1, nd.j - 1), cell(nd.i - 1, nd.j))) curbs.wall(x0, z1, x0, z0, 0, y, curbUv);
    if (nd.neighbors[1]! < 0 && open(cell(nd.i, nd.j - 1), cell(nd.i, nd.j))) curbs.wall(x1, z0, x1, z1, 0, y, curbUv);
  }
  // The promenade's kerbs either side of each mouth, facing into it.
  for (const m of mouths) {
    curbs.wall(m.minX, m.minZ, m.maxX, m.minZ, 0, y, curbUv);
    curbs.wall(m.maxX, m.maxZ, m.minX, m.maxZ, 0, y, curbUv);
  }
  wood.flat(b.cityMaxX + sw, b.cityMinZ - sw, b.beachStartX, b.cityMaxZ + sw, y, { kind: 'world', scale: 4 });

  const wet = view.wet;
  view.add(setGroundAttribute(walk.build(), walkRanges, NO_RECT), surfaces.patch(wet.patch(surfaces.material('kerb')), 'kerb'), { name: 'sidewalks' });
  view.add(setGroundAttribute(curbs.build(), []), surfaces.patch(wet.patch(surfaces.material('curb')), 'curb'), { name: 'curbs' });
  view.add(wood.build(), wet.patch(view.surface('wood')), { name: 'boardwalk' });
  for (const [k, p] of patches) {
    const tex = k as 'grass' | 'plaza' | 'asphalt' | 'dirt';
    const detail = DETAIL[tex];
    const m = surfaces.material(detail, tex);
    // Grass soaks the rain up rather than shining.
    if (k !== 'grass') wet.patch(m);
    surfaces.patch(m, detail);
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -1;
    view.add(setGroundAttribute(p.g.build(), p.ranges, NO_RECT), m, { name: `ground-${k}` });
  }
  const lineMat = wet.patch(new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  view.add(lines.build(), lineMat, { name: 'parking-lines' });
}
