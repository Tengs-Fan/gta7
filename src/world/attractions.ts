// The attractions pass: single cells of the finished city rebuilt as places of their own, Hollister Farm and Eternal
// Palms Cemetery. Modelled on drown() (layout.ts): it runs once the street furniture, the drowned bays, the coast, the
// stunt ramps and the water filters are done, and draws only from its own generators, so every other block, lamp, tree
// and parked car stays where it was. Unlike drown() it keeps the cell's sidewalk ring and its furniture, but for a gate,
// and it keeps every open spot, free: the hidden packages are placed over the open spots (pickups.ts), so losing one
// would move all twenty. Pure data, like the rest of the layout.

import { Rng } from '../core/rng';
import type { ColliderTag } from './colliders';
import { CURB_H, SIDEWALK_W } from './constants';
import {
  addProp, cellBlock, garageWalls, hashInts, insetRect, mkRect, rectContains, rectCX, rectCZ, rectsMinus,
  type Block, type CityLayout, type GroundKind, type Prop, type Rect, type Side,
} from './layout';

/** A solid of an attraction (StaticWorld adds it to the colliders): a box, or with `round` the upright cylinder in its square. */
export interface AttractionSolid {
  rect: Rect;
  y0: number;
  y1: number;
  tag: ColliderTag;
  round?: true;
}

/** One half of the corn maze: `cols` by `rows` cells of `cell` m from its north-west corner, and its two ways in. */
export interface MazeHalf {
  rect: Rect;
  cols: number;
  rows: number;
  cell: number;
  /** The cells the two entrances open from, and the side they open through. */
  entrances: Array<{ col: number; row: number; side: Side }>;
}

export interface FarmAnchors {
  mazes: MazeHalf[];
  /** The gravel lane from the gate on Hillcrest Rd, and the mown aisle it runs on as through the corn to the coast. */
  lane: Rect;
  /** The forty pumpkins' prop indices (later passes only append props, so these hold). */
  pumpkins: number[];
  /** The farmhouse (a building id) and where its owner stands, in front of its porch. */
  house: number;
  porch: { x: number; z: number; heading: number };
  /** The barn (a garage) and the silo. */
  barn: Rect;
  silo: { x: number; z: number; r: number; height: number };
  /** The hay-bale kicker's ramp id. */
  ramp: number;
  /** The farm stand by the gate: where its sign stands and the way it faces. */
  stand: { x: number; z: number; rot: number };
}

export interface Mausoleum {
  rect: Rect;
  family: string;
  /** The side its door is in. */
  door: Side;
}

export interface CemeteryAnchors {
  /** The twelve epitaph stones, in EPITAPHS order (sim/epitaphs.ts): prop index, and where a reader stands in front. */
  epitaphs: Array<{ prop: number; x: number; z: number }>;
  /** The chapel's nave (its walls' and ridge's heights) and its bell tower. */
  nave: { rect: Rect; eaves: number; ridge: number };
  tower: { rect: Rect; height: number };
  mausoleums: Mausoleum[];
  /** The Bramble family crypt's door, where the whisper is heard. */
  crypt: { x: number; z: number };
  /** The gap in the iron fence round the lot, on its north side. */
  fence: Rect;
  gate: { x0: number; x1: number };
}

interface AttractionBase {
  id: string;
  name: string;
  /** The lot it was built on. */
  rect: Rect;
  solids: AttractionSolid[];
  /** Where the police see a target only up close (StaticWorld.coverAt, wanted.ts). */
  cover: Rect[];
}

export type Attraction = AttractionBase & ({ kind: 'farm'; anchors: FarmAnchors } | { kind: 'cemetery'; anchors: CemeteryAnchors });

interface AttractionDef {
  id: string;
  name: string;
  bi: number;
  bj: number;
  /** The span of sidewalk (x0..x1, on the lot's `side`) cleared of furniture for the gate. */
  gate(lot: Rect): { side: Side; x0: number; x1: number };
  build(layout: CityLayout, block: Block, rng: Rng): Attraction;
}

/** The attractions, each on one cell: the HUD, the map and the police scanner name the cell after it. */
export const ATTRACTIONS: readonly AttractionDef[] = [
  { id: 'farm', name: 'Hollister Farm', bi: 3, bj: 0, gate: (lot) => ({ side: 'S', x0: farmLaneX(lot) - FARM.gate / 2, x1: farmLaneX(lot) + FARM.gate / 2 }), build: buildFarm },
  { id: 'cemetery', name: 'Eternal Palms Cemetery', bi: 1, bj: 1, gate: (lot) => ({ side: 'N', x0: rectCX(lot) + CEMETERY.gate[0], x1: rectCX(lot) + CEMETERY.gate[1] }), build: buildCemetery },
];

/** No collider of an attraction comes within this far (m) of a kept open spot. */
export const SPOT_CLEAR = 1;

/** Rebuilds every ATTRACTIONS cell. generateCity calls it once, after every shared draw and before the ground floors. */
export function buildAttractions(layout: CityLayout): void {
  const blocks = ATTRACTIONS.map((def) => cellBlock(layout, def.bi, def.bj)!);
  // Every lot is cleared before any is built: clearing one after another was built would renumber its props.
  ATTRACTIONS.forEach((def, k) => {
    const block = blocks[k]!;
    const g = def.gate(block.lot);
    const r = block.rect;
    clearLot(layout, block.lot, g.side === 'S' ? mkRect(g.x0, r.maxZ - SIDEWALK_W, g.x1, r.maxZ) : mkRect(g.x0, r.minZ, g.x1, r.minZ + SIDEWALK_W));
    block.zone = def.name;
  });
  ATTRACTIONS.forEach((def, k) => layout.attractions.push(def.build(layout, blocks[k]!, new Rng(hashInts(layout.seed, 9001, k)))));
}

/**
 * Takes away what stood in the lot (buildings, ground, garages, props, parking) and the furniture of the gate's span of
 * sidewalk. The open spots stay; building ids keep their gap, as drown() leaves them.
 */
function clearLot(layout: CityLayout, lot: Rect, gate: Rect): void {
  const out = (x: number, z: number) => !rectContains(lot, x, z) && !rectContains(gate, x, z);
  layout.buildings = layout.buildings.filter((b) => out(rectCX(b.rect), rectCZ(b.rect)));
  layout.ground = layout.ground.filter((g) => out(rectCX(g.rect), rectCZ(g.rect)));
  layout.garages = layout.garages.filter((g) => out(rectCX(g.rect), rectCZ(g.rect)));
  layout.props = layout.props.filter((p) => out(p.x, p.z));
  layout.parking = layout.parking.filter((p) => out(p.x, p.z));
}

/** Distance (m) from (x, z) to a rectangle (0 inside). */
function rectDist(r: Rect, x: number, z: number): number {
  return Math.hypot(Math.max(r.minX - x, x - r.maxX, 0), Math.max(r.minZ - z, z - r.maxZ, 0));
}

/** The open spots in `r`, which stay free. */
function spotsIn(layout: CityLayout, r: Rect): Array<{ x: number; z: number }> {
  return layout.openSpots.filter((s) => rectContains(r, s.x, s.z, 2));
}

/** A prop with a footprint (corn, headstones: like the containers), its index. */
function addBoxProp(layout: CityLayout, kind: Prop['kind'], x: number, z: number, w: number, d: number, h: number, rot: number, scale = 1, color = 0): number {
  const p = addProp(layout, kind, x, z, rot, scale);
  p.w = w;
  p.d = d;
  p.h = h;
  p.color = color;
  return layout.props.length - 1;
}

function pushGround(layout: CityLayout, rects: readonly Rect[], kind: GroundKind): void {
  for (const rect of rects) if (rect.maxX - rect.minX > 0.01 && rect.maxZ - rect.minZ > 0.01) layout.ground.push({ rect, kind });
}

/** 1 + the largest building id: drown() left gaps, so the list's length could name a building that exists. */
function nextBuildingId(layout: CityLayout): number {
  return layout.buildings.reduce((m, b) => Math.max(m, b.id), -1) + 1;
}

// ---------------------------------------------------------------------------
// Hollister Farm

/**
 * The farm's plan, in metres from the lot's edges. The lane runs down the line of the old yards' setback spots (four of
 * the cell's eight open spots lie on it), the maze fills the north half either side of it, the farmhouse, the barn and
 * the silo the south.
 */
const FARM = {
  /** The lane's centre line from the lot's west edge, its width and the gate's. */
  lane: 30.5,
  laneW: 7,
  gate: 8,
  /** Each maze half: columns and rows of `cell` m, `north` m in from the lot's north edge. */
  maze: { cols: 5, rows: 9, cell: 4, north: 4 },
  /** A corn wall segment: length, thickness and height (m). */
  corn: { len: 2, thick: 0.6, h: 2.6 },
  /** The farmhouse: west edge and south edge in from the lot's, size and height. */
  house: { west: 7, south: 5, w: 14, d: 14, h: 7.2 },
  /** The barn: past the lane, in from the lot's south edge; depth (x) by width (z), height, the old red. */
  barn: { gap: 1, south: 4, depth: 14, width: 18, h: 7, color: 0x8e2b1f },
  /** The silo's centre past the lane and in from the lot's south edge, radius and height. */
  silo: { east: 15, south: 31, r: 3.5, h: 20 },
  /** The kicker's centre in from the lot's south edge: the run-up comes through the gate, the jump goes down the aisle. */
  ramp: { south: 28, length: 11, width: 6.5, height: 2.4 },
  pumpkins: 40,
} as const;

function farmLaneX(lot: Rect): number {
  return lot.minX + FARM.lane;
}

function buildFarm(layout: CityLayout, block: Block, rng: Rng): Attraction {
  const lot = block.lot;
  const spots = spotsIn(layout, lot);
  const x = farmLaneX(lot);
  const hw = FARM.laneW / 2;
  const lane = mkRect(x - hw, lot.minZ, x + hw, lot.maxZ);
  const { cols, rows, cell, north } = FARM.maze;
  const mz0 = lot.minZ + north;
  const mz1 = mz0 + rows * cell;
  const west = mkRect(lane.minX - cols * cell, mz0, lane.minX, mz1);
  const east = mkRect(lane.maxX, mz0, lane.maxX + cols * cell, mz1);

  // The farmhouse on the west, its door to the south; its owner stands in front of the porch.
  const H = FARM.house;
  const hr = mkRect(lot.minX + H.west, lot.maxZ - H.south - H.d, lot.minX + H.west + H.w, lot.maxZ - H.south);
  const house = nextBuildingId(layout);
  layout.buildings.push({
    id: house, rect: hr, height: H.h, tiers: [{ ...hr, y0: CURB_H, y1: H.h }], style: 'house', roof: 'gable', tint: rng.next(), district: block.district,
    roofProps: [], sign: null, special: null, ground: 'none', groundH: 0, groundSides: [],
  });
  const porch = { x: rectCX(hr), z: hr.maxZ + 2.4, heading: 0 };

  // The barn opens onto the lane; walls and roof as a garage's (StaticWorld), its gable drawn on top (render/city/attractions.ts).
  const B = FARM.barn;
  const barn = mkRect(lane.maxX + B.gap, lot.maxZ - B.south - B.width, lane.maxX + B.gap + B.depth, lot.maxZ - B.south);
  layout.garages.push({ poi: 'farm_barn', rect: barn, side: 'W', walls: garageWalls(barn, 'W', 0.5), height: B.h, color: B.color });
  const silo = { x: lane.maxX + FARM.silo.east, z: lot.maxZ - FARM.silo.south, r: FARM.silo.r, height: FARM.silo.h };
  const R = FARM.ramp;
  const ramp = layout.ramps.length;
  layout.ramps.push({ id: ramp, x, z: lot.maxZ - R.south, heading: Math.PI, length: R.length, width: R.width, height: R.height });

  pushGround(layout, [lane, west, east], 'dirt');
  const yard = mkRect(lot.minX, mz1, lane.minX, lot.maxZ);
  pushGround(layout, [yard], 'yard');
  pushGround(layout, [barn], 'plaza');
  const barnyard = mkRect(lane.maxX, mz1, lot.maxX, lot.maxZ);
  pushGround(layout, rectsMinus([barnyard], [barn]), 'dirt');
  pushGround(layout, rectsMinus([lot], [lane, west, east, yard, barnyard]), 'grass');

  // The maze: two halves either side of the aisle, each a perfect maze with a way in from the aisle and one from outside.
  const halves: MazeHalf[] = [];
  const deadEnds: Array<{ x: number; z: number }> = [];
  for (const [rect, aisleSide, outer] of [[west, 'E', 'W'], [east, 'W', 'E']] as const) {
    const m = carveMaze(cols, rows, rng);
    const entrances = [
      { col: aisleSide === 'E' ? cols - 1 : 0, row: rng.int(1, rows - 2), side: aisleSide as Side },
      { col: outer === 'W' ? 0 : cols - 1, row: rng.int(1, rows - 2), side: outer as Side },
    ];
    for (const e of entrances) m.v[e.row * (cols + 1) + (e.side === 'E' ? e.col + 1 : e.col)] = false;
    halves.push({ rect, cols, rows, cell, entrances });
    for (const seg of mazeSegments(m, rect, cols, rows, cell)) {
      if (spots.some((s) => rectDist(seg, s.x, s.z) < SPOT_CLEAR + 0.2)) continue;
      const along = seg.maxX - seg.minX > seg.maxZ - seg.minZ;
      addBoxProp(layout, 'corn', rectCX(seg), rectCZ(seg), seg.maxX - seg.minX, seg.maxZ - seg.minZ, FARM.corn.h, along ? 0 : Math.PI / 2, 1, Math.floor(rng.next() * 0xffff));
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const open = [m.h[r * cols + c], m.h[(r + 1) * cols + c], m.v[r * (cols + 1) + c], m.v[r * (cols + 1) + c + 1]].filter((w) => !w).length;
        if (open === 1) deadEnds.push({ x: rect.minX + (c + 0.5) * cell, z: rect.minZ + (r + 0.5) * cell });
      }
    }
  }

  // Pumpkins: in the dead ends first, then in a row down the east edge, past the maze and on beside the barn.
  const candidates = rng.shuffle(deadEnds);
  for (let z = east.minZ + 1; z < lot.maxZ - 1; z += 2) candidates.push({ x: (east.maxX + lot.maxX) / 2, z });
  const pumpkins: number[] = [];
  for (const c of candidates) {
    if (pumpkins.length === FARM.pumpkins) break;
    const px = c.x + rng.range(-0.4, 0.4);
    const pz = c.z + rng.range(-0.4, 0.4);
    if (spots.some((s) => Math.hypot(s.x - px, s.z - pz) < SPOT_CLEAR + 0.7) || Math.hypot(silo.x - px, silo.z - pz) < silo.r + 1 || rectDist(barn, px, pz) < 1) continue;
    addProp(layout, 'pumpkin', px, pz, rng.range(0, Math.PI * 2), rng.range(0.85, 1.2));
    pumpkins.push(layout.props.length - 1);
  }

  return {
    id: 'farm',
    kind: 'farm',
    name: block.zone,
    rect: lot,
    solids: [{ rect: mkRect(silo.x - silo.r, silo.z - silo.r, silo.x + silo.r, silo.z + silo.r), y0: 0, y1: silo.height, tag: 'pillar', round: true }],
    // The maze, and the barn: inside, the helicopter crew sees him only from overhead, where the roof is in the way.
    cover: [west, east, insetRect(barn, 0.5)],
    anchors: { mazes: halves, lane, pumpkins, house, porch, barn, silo, ramp, stand: { x: lane.minX - 2.5, z: lot.maxZ - 1.5, rot: 0 } },
  };
}

/** A perfect maze by recursive backtracking: `h[r * cols + c]` is the wall north of cell (c, r) (row `rows` the south edge), `v[r * (cols + 1) + c]` the one west of it. */
function carveMaze(cols: number, rows: number, rng: Rng): { h: boolean[]; v: boolean[] } {
  const h = new Array<boolean>((rows + 1) * cols).fill(true);
  const v = new Array<boolean>(rows * (cols + 1)).fill(true);
  const seen = new Array<boolean>(cols * rows).fill(false);
  const stack = [rng.int(0, cols * rows - 1)];
  seen[stack[0]!] = true;
  while (stack.length > 0) {
    const at = stack[stack.length - 1]!;
    const c = at % cols;
    const r = Math.floor(at / cols);
    const next = ([[0, -1], [1, 0], [0, 1], [-1, 0]] as const).filter(([dc, dr]) => c + dc >= 0 && c + dc < cols && r + dr >= 0 && r + dr < rows && !seen[(r + dr) * cols + c + dc]);
    if (next.length === 0) {
      stack.pop();
      continue;
    }
    const [dc, dr] = rng.pick(next);
    if (dr !== 0) h[(dr > 0 ? r + 1 : r) * cols + c] = false;
    else v[r * (cols + 1) + (dc > 0 ? c + 1 : c)] = false;
    const to = (r + dr) * cols + c + dc;
    seen[to] = true;
    stack.push(to);
  }
  return { h, v };
}

/** The corn wall segments of a maze: every standing wall of a cell's edge, in segments of FARM.corn.len. */
function mazeSegments(m: { h: boolean[]; v: boolean[] }, rect: Rect, cols: number, rows: number, cell: number): Rect[] {
  const { len, thick } = FARM.corn;
  const t = thick / 2;
  const out: Rect[] = [];
  const n = Math.round(cell / len);
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!m.h[r * cols + c]) continue;
      const z = rect.minZ + r * cell;
      for (let k = 0; k < n; k++) out.push(mkRect(rect.minX + c * cell + k * len, z - t, rect.minX + c * cell + (k + 1) * len, z + t));
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols; c++) {
      if (!m.v[r * (cols + 1) + c]) continue;
      const x = rect.minX + c * cell;
      for (let k = 0; k < n; k++) out.push(mkRect(x - t, rect.minZ + r * cell + k * len, x + t, rect.minZ + r * cell + (k + 1) * len));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Eternal Palms Cemetery

/**
 * The cemetery's plan, in metres from the lot's centre (x) and its north edge (z). The four paths across it run where
 * the cell's fifteen open spots lie, three paths down it, the gate on the middle one, facing the cove.
 */
const CEMETERY = {
  /** Centre lines of the paths across (from the lot's north edge) and down (from its centre); their half widths. */
  across: [13, 36.5, 55, 71.75],
  acrossHalf: 2.5,
  down: [-19, 0, 19],
  downHalf: 2,
  /** The gate in the fence, from the lot's centre. */
  gate: [-3, 3] as readonly [number, number],
  /** The nave (x from the centre, z from the north edge), its eaves and ridge; the tower over its north end. */
  nave: { x0: 25, x1: 34, z0: 19.5, z1: 32.5, eaves: 6.5, ridge: 10 },
  tower: { x0: 27, x1: 32, z0: 16, z1: 21, h: 18 },
  /** The mausoleums: x0, z0 (from the centre and the north edge), size, height and the family. */
  mausoleums: [
    { x0: -34, z0: 42, w: 6, d: 7, family: 'BRAMBLE', door: 'N' },
    { x0: -12.5, z0: 60, w: 6, d: 6.5, family: 'VANCE', door: 'N' },
    { x0: 26, z0: 60, w: 6, d: 6.5, family: 'HOLLISTER', door: 'N' },
  ] as ReadonlyArray<{ x0: number; z0: number; w: number; d: number; family: string; door: Side }>,
  mausoleumH: 5,
  /** Headstones: their footprint and height, the rows' spacing, how many and how many carry an epitaph. */
  stone: { w: 0.7, d: 0.25, h: 1.1 },
  rows: { along: 2.4, apart: 3, inset: 2 },
  stones: 140,
  epitaphs: 12,
} as const;

function buildCemetery(layout: CityLayout, block: Block, rng: Rng): Attraction {
  const lot = block.lot;
  const spots = spotsIn(layout, lot);
  const cx = rectCX(lot);
  const C = CEMETERY;
  const across = C.across.map((z) => mkRect(lot.minX, lot.minZ + z - C.acrossHalf, lot.maxX, lot.minZ + z + C.acrossHalf));
  const down = rectsMinus(C.down.map((x) => mkRect(cx + x - C.downHalf, lot.minZ, cx + x + C.downHalf, lot.maxZ)), across);
  pushGround(layout, [...across, ...down], 'plaza');
  const plots = rectsMinus([lot], [...across, ...down]);
  pushGround(layout, plots, 'grass');

  const nave = mkRect(cx + C.nave.x0, lot.minZ + C.nave.z0, cx + C.nave.x1, lot.minZ + C.nave.z1);
  const tower = mkRect(cx + C.tower.x0, lot.minZ + C.tower.z0, cx + C.tower.x1, lot.minZ + C.tower.z1);
  const mausoleums: Mausoleum[] = C.mausoleums.map((m) => ({ rect: mkRect(cx + m.x0, lot.minZ + m.z0, cx + m.x0 + m.w, lot.minZ + m.z0 + m.d), family: m.family, door: m.door }));
  const crypt = mausoleums[0]!;
  const solids: AttractionSolid[] = [
    { rect: nave, y0: 0, y1: C.nave.eaves, tag: 'building' },
    // The roof's core, round its ridge: what a shot over the eaves still hits.
    { rect: mkRect(rectCX(nave) - 2, nave.minZ, rectCX(nave) + 2, nave.maxZ), y0: C.nave.eaves, y1: C.nave.ridge - 0.5, tag: 'building' },
    { rect: tower, y0: 0, y1: C.tower.h, tag: 'building' },
    ...mausoleums.map((m) => ({ rect: m.rect, y0: 0, y1: C.mausoleumH, tag: 'building' as const })),
  ];
  const buildings = [nave, tower, ...mausoleums.map((m) => m.rect)];

  // Palms either side of the gate, and cypresses in pairs down the middle path.
  const gate = { x0: cx + C.gate[0], x1: cx + C.gate[1] };
  for (const gx of [gate.x0 - 2.5, gate.x1 + 2.5]) addProp(layout, 'palm', gx, lot.minZ + 2.5, rng.range(0, Math.PI * 2), rng.range(1, 1.15));
  const trees: Array<{ x: number; z: number }> = [];
  const mid = down.filter((r) => Math.abs(rectCX(r) - cx) < 1);
  for (const r of mid) {
    for (let z = r.minZ + 3; z < r.maxZ - 2; z += 6) {
      for (const tx of [r.minX - 1.3, r.maxX + 1.3]) {
        if (spots.some((s) => Math.hypot(s.x - tx, s.z - z) < SPOT_CLEAR + 0.6) || z < lot.minZ + 6) continue;
        addProp(layout, 'cypress', tx, z, rng.range(0, Math.PI * 2), rng.range(0.9, 1.15));
        trees.push({ x: tx, z });
      }
    }
  }

  // Headstones in rows across every plot, facing north (the gate, the cove), clear of the buildings, the trees and the
  // fence; thinned at random to C.stones so the rows have their gaps, and twelve of them, well apart, carry an epitaph.
  const { along, apart, inset } = C.rows;
  const cand: Array<{ x: number; z: number }> = [];
  for (const p of plots) {
    if (p.maxX - p.minX < 2 * inset || p.maxZ - p.minZ < 2 * inset) continue;
    const nx = Math.floor((p.maxX - p.minX - 2 * inset) / along) + 1;
    const nz = Math.floor((p.maxZ - p.minZ - 2 * inset) / apart) + 1;
    const x0 = rectCX(p) - ((nx - 1) * along) / 2;
    const z0 = rectCZ(p) - ((nz - 1) * apart) / 2;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * along;
        const z = z0 + j * apart;
        if (buildings.some((b) => rectDist(b, x, z) < 2) || trees.some((t) => Math.hypot(t.x - x, t.z - z) < 1.6)) continue;
        if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < SPOT_CLEAR + 0.8)) continue;
        cand.push({ x, z });
      }
    }
  }
  const kept = new Set(rng.shuffle(cand.map((_, i) => i)).slice(0, C.stones));
  const stones: number[] = [];
  const S = C.stone;
  cand.forEach((s, i) => {
    if (kept.has(i)) stones.push(addBoxProp(layout, 'headstone', s.x, s.z, S.w, S.d, S.h, Math.PI, rng.range(0.92, 1.08), Math.floor(rng.next() * 0xffff)));
  });
  const epitaphs: Array<{ prop: number; x: number; z: number }> = [];
  // The reader stands a step in front of the stone's face (north), well inside the fence round the lot.
  const inner = insetRect(lot, 3);
  for (const i of rng.shuffle([...stones])) {
    const p = layout.props[i]!;
    if (epitaphs.length === C.epitaphs) break;
    if (!rectContains(inner, p.x, p.z - 1.1) || epitaphs.some((e) => Math.hypot(layout.props[e.prop]!.x - p.x, layout.props[e.prop]!.z - p.z) < 9)) continue;
    epitaphs.push({ prop: i, x: p.x, z: p.z - 1.1 });
  }

  return {
    id: 'cemetery',
    kind: 'cemetery',
    name: block.zone,
    rect: lot,
    solids,
    cover: [],
    anchors: {
      epitaphs,
      nave: { rect: nave, eaves: C.nave.eaves, ridge: C.nave.ridge },
      tower: { rect: tower, height: C.tower.h },
      mausoleums,
      crypt: { x: rectCX(crypt.rect), z: crypt.rect.minZ - 1 },
      fence: lot,
      gate,
    },
  };
}

/** The attraction of a kind in a layout (each kind is built once). */
export function attractionOf<K extends Attraction['kind']>(layout: CityLayout, kind: K): Extract<Attraction, { kind: K }> {
  return layout.attractions.find((a) => a.kind === kind) as Extract<Attraction, { kind: K }>;
}
