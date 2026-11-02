// Las Lomas Valley's farms (docs/map.md, "Las Lomas Valley: the farms"): Sunset Vineyard on the Vineyard Rise, the Lazy Q
// Ranch east of the loop's south bend, and the open land south of the Pass Road between them, a farmed country of oaks,
// hedgerows, hay fields, a pumpkin patch and a ruined barn on the Willow Knoll. Pure data, no rendering. buildValley is
// a content pass of the county's (after the places and the lakeland, before the oddities): it only appends (props, a building each for the winery and the
// ranch house, the ranch's barn, parking bays), draws from its own generator, keeps every solid 12 m off every road edge,
// every prop, building and solid south of the Pass Road (z 100 on; the vine rows follow the rise's ellipses, which reach
// z 43) and out of the pass's plot. Its animals (the ranch's horses and sheep) are
// presentation only: where they live is data here, how they move is render/country/livestock.ts.

import { Rng } from '../../core/rng';
import type { AttractionSolid } from '../attractions';
import { addProp, hashInts, insetRect, mkRect, rectContains, type CityLayout, type Rect, type Side } from '../layout';
import { barn, boxProp, fenceLine, fenceRound, prop, WINDPUMP_H, type Field } from './farms';
import { COUNTRY_ROADS, countryGround, DRIVE_CLEAR, onCountyLand, type Country } from './index';

/** The z (m) the valley's props, buildings and solids keep south of: 16 m past the Pass Road's edge, so nothing of the valley's north half is theirs (the vine rows stand on the rise, z 43 and on). */
export const VALLEY_FARMS_FROM = 100;

/** A length (m) of vine row each instance of the vineyard's trellis covers. */
export const VINE_SEG = 3;

/** One run of trellis: its middle, and the yaw (rad) that turns the model's +x along the row. */
export interface VineSegment {
  x: number;
  z: number;
  yaw: number;
}

export interface Winery {
  /** The stone hall, its building's id, the ground under it and its eaves above that. */
  hall: Rect;
  building: number;
  y: number;
  eaves: number;
  /** The tasting porch along the hall's east side, facing the loop. */
  porch: Rect;
  /** The gravel yard on the rise's flat top, and the poles the porch's string lights hang from. */
  yard: Rect;
  poles: ReadonlyArray<readonly [x: number, z: number]>;
  /** The barrel stack against the hall's north wall (a solid). */
  barrels: Rect;
  /** The dirt drive's centre line, from the loop's edge up to the yard, the sign at its mouth and the mailbox by the road. */
  drive: readonly [number, number, number, number];
  sign: { x: number; z: number; rot: number };
  mailbox: { x: number; z: number };
}

export interface Vineyard {
  /** The Vineyard Rise's centre and semi-axes: the rows follow its contours. */
  rise: { cx: number; cz: number; rx: number; rz: number };
  segments: VineSegment[];
  winery: Winery;
}

export interface Ranch {
  house: number;
  /** The house's walls, the ground it stands on and its eaves above that; its porch runs along the south front. */
  houseRect: Rect;
  barn: Rect;
  door: Side;
  yard: Rect;
  drive: readonly [number, number, number, number];
  /** The gate's arch over the drive (it faces the road) and the mailbox beside it. */
  gate: { x: number; z: number };
  mailbox: { x: number; z: number };
  /** The round bales (solids), by their middle; every one is BALE_R round. */
  bales: Array<{ x: number; z: number }>;
  /** The two paddocks and the corral the horses live in, and the horses: where each stands first, its coat (0..4) and its paddock. */
  paddocks: Rect[];
  /** Where each paddock's horses keep: inside the fence, and clear of the shelter along the paddocks' south fence. */
  roam: Rect[];
  /** The run-in shelters along the south fence of the first two paddocks (their walls are solids). */
  shelters: Shelter[];
  horses: Array<{ x: number; z: number; coat: number; paddock: number }>;
  /** The sheep's pasture along the loop, and how many graze it. */
  pasture: Rect;
  sheep: number;
}

/** A wall's footprint and its top (m over the ground it stands on). */
export interface Wall {
  rect: Rect;
  h: number;
}

/** A paddock's run-in shelter: the footprint its roof covers (open to the north) and its three walls, which are solid. */
export interface Shelter {
  roof: Rect;
  walls: Wall[];
}

/** The ruined stone barn on the Willow Knoll: its footprint, the ground it stands on and the wall stumps left, with their tops. */
export interface Ruin {
  rect: Rect;
  y: number;
  walls: Wall[];
}

export interface ValleyFarms {
  /** The props the valley's farms added are [firstProp, endProp): its oaks and bushes are drawn as one batch each, not one per cell. */
  firstProp: number;
  endProp: number;
  vineyard: Vineyard;
  ranch: Ranch;
  ruin: Ruin;
  /** The hay fields and the pumpkin patch's furrows (FieldsView draws them with the county's). */
  fields: Field[];
  /** Hedgerows, HEDGE_H tall (world/country/farms.ts): solid for sight and shots, not for the camera. */
  hedges: Rect[];
  /** The winery's barrels, the ranch's round bales and shelters' walls and the ruin's walls (StaticWorld adds their colliders after the places'). */
  solids: AttractionSolid[];
  /** The ranch barn's inside, where the police see a target only up close (StaticWorld.coverAt). */
  cover: Rect[];
  /** The drives, as the rects reflector posts keep out of. */
  drives: Rect[];
}

/** A round bale's radius (m) and height. */
export const BALE_R = 0.85;
export const BALE_H = 1.5;
/** The sheep that graze the ranch's pasture. */
export const SHEEP_COUNT = 18;

const SALT = 0x7a11e5;
const E = Math.PI / 2;
const W = -Math.PI / 2;

/** The vineyard: the rise, the winery on its crest. */
const RISE = { cx: -2015, cz: 130, rx: 105, rz: 95 } as const;
const WINERY_HALL = mkRect(-2031, 122, -2015, 132);
const WINERY_YARD = mkRect(-2041, 108, -1993, 146);
const WINERY_EAVES = 4.6;
const DRIVE_Z = 127;
/** The rows run from this share of the rise's semi-axes out to the other, a step apart: clear of the yard, over the slopes. */
export const VINE_ROWS = { from: 0.31, to: 0.94, step: 0.032 } as const;
/** The ranch: its drive's z, the pasture along the loop (its fence 8 m off the road's edge, so a car in the near lane passes 10 m from the sheep), the yard and the horses' paddocks. */
const RANCH_DRIVE_Z = 246;
const PASTURE = mkRect(-1826, 268, -1762, 372);
const RANCH_YARD = mkRect(-1730, 222, -1630, 300);
const PADDOCK_A = mkRect(-1730, 316, -1682, 376);
const PADDOCK_B = mkRect(-1682, 316, -1634, 376);
const CORRAL = mkRect(-1666, 276, -1638, 304);
/** The Willow Knoll's ruin. */
const RUIN = mkRect(-2066, 364, -2054, 372);

/** How far (m) (x, z) is from the nearest county road's edge. */
export function roadEdgeDistance(x: number, z: number): number {
  let d = Infinity;
  for (const r of COUNTRY_ROADS) {
    for (let k = 0; k + 3 < r.pts.length; k += 2) {
      const ax = r.pts[k]!;
      const az = r.pts[k + 1]!;
      const bx = r.pts[k + 2]!;
      const bz = r.pts[k + 3]!;
      const l2 = (bx - ax) ** 2 + (bz - az) ** 2;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / l2));
      d = Math.min(d, Math.hypot(x - ax - t * (bx - ax), z - az - t * (bz - az)) - r.width / 2);
    }
  }
  return d;
}

export function noValley(): ValleyFarms {
  const none = mkRect(0, 0, 0, 0);
  return {
    firstProp: 0,
    endProp: 0,
    vineyard: { rise: RISE, segments: [], winery: { hall: none, building: -1, y: 0, eaves: 0, porch: none, yard: none, poles: [], barrels: none, drive: [0, 0, 0, 0], sign: { x: 0, z: 0, rot: 0 }, mailbox: { x: 0, z: 0 } } },
    ranch: { house: -1, houseRect: none, barn: none, door: 'W', yard: none, drive: [0, 0, 0, 0], gate: { x: 0, z: 0 }, mailbox: { x: 0, z: 0 }, bales: [], paddocks: [], roam: [], shelters: [], horses: [], pasture: none, sheep: 0 },
    ruin: { rect: none, y: 0, walls: [] },
    fields: [],
    hedges: [],
    solids: [],
    cover: [],
    drives: [],
  };
}

/** A building of the valley's farms: a country building (drawn by the valley's own code, as Dry Creek's stores are), `h` tall from the ground at `y`. */
function building(layout: CityLayout, rect: Rect, y: number, h: number, style: 'house' | 'brick', rng: Rng): number {
  const id = layout.buildings.reduce((m, b) => Math.max(m, b.id), -1) + 1;
  layout.buildings.push({
    id, rect, height: h, tiers: [{ ...rect, y0: 0, y1: y + h }], style, roof: 'gable', tint: rng.next(), district: 'country',
    roofProps: [], sign: null, special: null, ground: 'none', groundH: 0, groundSides: [],
  });
  return id;
}

/** The vine rows: ellipses round the rise's crest, each a trellis of VINE_SEG m runs laid chord to chord, but through the yard and across the drive. */
function vineRows(rise: Vineyard['rise'], skip: (x: number, z: number) => boolean): VineSegment[] {
  const segments: VineSegment[] = [];
  for (let s = VINE_ROWS.from; s <= VINE_ROWS.to + 1e-6; s += VINE_ROWS.step) {
    const at = (t: number): [number, number] => [rise.cx + rise.rx * s * Math.cos(t), rise.cz + rise.rz * s * Math.sin(t)];
    let t = 0;
    let [px, pz] = at(t);
    for (;;) {
      // The next point on the ellipse a run's length on.
      const speed = Math.hypot(rise.rx * s * Math.sin(t), rise.rz * s * Math.cos(t));
      let t1 = t + VINE_SEG / speed;
      let [qx, qz] = at(t1);
      for (let k = 0; k < 3; k++) {
        t1 += (VINE_SEG - Math.hypot(qx - px, qz - pz)) / speed;
        [qx, qz] = at(t1);
      }
      if (t1 > Math.PI * 2 - 0.5 / speed) break;
      const x = (px + qx) / 2;
      const z = (pz + qz) / 2;
      if (!skip(x, z)) segments.push({ x, z, yaw: Math.atan2(-(qz - pz), qx - px) });
      t = t1;
      [px, pz] = [qx, qz];
    }
  }
  return segments;
}

/** Sunset Vineyard: the rows, the winery with its porch, barrels and parking, its drive and sign. */
function buildVineyard(layout: CityLayout, v: ValleyFarms, rng: Rng, taken: Rect[]): void {
  const country = layout.country;
  const hall = WINERY_HALL;
  const y = countryGround(country, (hall.minX + hall.maxX) / 2, (hall.minZ + hall.maxZ) / 2);
  const building_ = building(layout, hall, y, WINERY_EAVES, 'brick', rng);
  const porch = mkRect(hall.maxX, 119, hall.maxX + 7, 135);
  const barrels = mkRect(-2030, 120.8, -2026, 121.85);
  const drive = [-1845, DRIVE_Z, WINERY_YARD.maxX, DRIVE_Z] as const;
  const cx = (hall.minX + hall.maxX) / 2;
  const cz = (hall.minZ + hall.maxZ) / 2;
  const segments = vineRows(RISE, (x, z) => Math.hypot(x - cx, z - cz) < 33 || rectContains(WINERY_YARD, x, z, VINE_SEG / 2) || (Math.abs(z - DRIVE_Z) < 4.6 && x > WINERY_YARD.maxX - 2));
  v.vineyard = {
    rise: RISE,
    segments,
    winery: {
      hall, building: building_, y, eaves: WINERY_EAVES, porch, yard: WINERY_YARD,
      poles: [[-1999, 118], [-1999, 136]],
      barrels,
      drive,
      sign: { x: -1860, z: DRIVE_Z + 8, rot: E },
      mailbox: { x: -1849, z: DRIVE_Z - 7 },
    },
  };
  v.solids.push({ rect: barrels, y0: y, y1: y + 2.5, tag: 'container' });
  layout.parking.push({ x: -2003, z: 141, heading: W }, { x: -1998, z: 141, heading: W });
  v.drives.push(mkRect(drive[2], DRIVE_Z - 2.6, drive[0], DRIVE_Z + 2.6));
  taken.push(WINERY_YARD, mkRect(drive[2], DRIVE_Z - 6, drive[0], DRIVE_Z + 6), mkRect(-1864, DRIVE_Z + 4, -1856, DRIVE_Z + 12));
  // Oaks round the yard, and a hedgerow along the loop's west verge, open at the drive.
  for (const [x, z] of [[-2030, 100], [-2049, 130], [-2005, 151]] as const) oak(layout, x, z, rng);
  v.hedges.push(mkRect(-1858.5, 141, -1857.1, 300), mkRect(-1858.5, 104, -1857.1, 114));
}

function oak(layout: CityLayout, x: number, z: number, rng: Rng): void {
  prop(layout, 'tree', x, z, rng.range(0, Math.PI * 2), rng.range(1.15, 1.35));
}

/** The runs of a fence left open for a gate: `n` from the `k0`th. */
const gap = (k0: number, n = 2): number[] => Array.from({ length: n }, (_, i) => k0 + i);

/** The Lazy Q Ranch: the house and barn round a dirt yard, the windpump, the bales, the paddocks and corral, the sheep's pasture, the gate and drive. */
function buildRanch(layout: CityLayout, v: ValleyFarms, rng: Rng, taken: Rect[]): void {
  const yard = RANCH_YARD;
  const houseRect = mkRect(-1722, 226, -1700, 238);
  const house = building(layout, houseRect, 0, 3.4, 'house', rng);
  const barnRect = mkRect(-1666, 250, -1636, 270);
  barn(layout, 'ranch', barnRect, 'W', 6.5, 0x8e2b1f);
  v.cover.push(insetRect(barnRect, 0.5));
  boxProp(layout, 'windpump', -1692, 296, 2, 2, WINDPUMP_H);
  const bales = [[-1626, 254], [-1626, 258.4], [-1626, 262.8], [-1622, 256], [-1622, 260.4], [-1618, 258]].map(([x, z]) => ({ x: x!, z: z! }));
  for (const b of bales) v.solids.push({ rect: mkRect(b.x - BALE_R, b.z - BALE_R, b.x + BALE_R, b.z + BALE_R), y0: 0, y1: BALE_H, tag: 'container', round: true });
  // The paddocks, the corral and the pasture, each fenced round by whole runs, a gate (two runs) left open in each.
  fenceRound(layout, PASTURE, { N: gap(11), E: gap(10) });
  fenceRound(layout, PADDOCK_A, { N: gap(5) });
  fenceLine(layout, PADDOCK_B.minX, PADDOCK_B.minZ, PADDOCK_B.maxX, PADDOCK_B.minZ, gap(5));
  fenceLine(layout, PADDOCK_B.minX, PADDOCK_B.maxZ, PADDOCK_B.maxX, PADDOCK_B.maxZ);
  fenceLine(layout, PADDOCK_B.maxX, PADDOCK_B.minZ, PADDOCK_B.maxX, PADDOCK_B.maxZ);
  fenceRound(layout, CORRAL, { N: gap(2, 3) });
  const paddocks = [PADDOCK_A, PADDOCK_B, CORRAL];
  const roam = [mkRect(PADDOCK_A.minX + 3, PADDOCK_A.minZ + 3, PADDOCK_A.maxX - 3, PADDOCK_A.maxZ - 8), mkRect(PADDOCK_B.minX + 3, PADDOCK_B.minZ + 3, PADDOCK_B.maxX - 3, PADDOCK_B.maxZ - 8), insetRect(CORRAL, 3)];
  const horses = [
    { x: -1712, z: 340, coat: 0, paddock: 0 }, { x: -1700, z: 356, coat: 3, paddock: 0 }, { x: -1718, z: 362, coat: 2, paddock: 0 },
    { x: -1664, z: 346, coat: 1, paddock: 1 }, { x: -1650, z: 360, coat: 4, paddock: 1 },
    { x: -1652, z: 292, coat: 2, paddock: 2 },
  ];
  // A shelter against the south fence of each of the two paddocks: a back wall and two sides, open to the north.
  const shelters = [PADDOCK_A, PADDOCK_B].map((pad, k): Shelter => {
    const cx = (pad.minX + pad.maxX) / 2 + (k === 0 ? 8 : -8);
    const z1 = pad.maxZ - 1.2;
    const roof = mkRect(cx - 3.2, z1 - 3.6, cx + 3.2, z1);
    return {
      roof,
      walls: [
        { rect: mkRect(roof.minX, z1 - 0.12, roof.maxX, z1), h: 2.3 },
        { rect: mkRect(roof.minX, roof.minZ, roof.minX + 0.12, z1), h: 2.5 },
        { rect: mkRect(roof.maxX - 0.12, roof.minZ, roof.maxX, z1), h: 2.5 },
      ],
    };
  });
  for (const s of shelters) for (const wall of s.walls) v.solids.push({ rect: wall.rect, y0: 0, y1: wall.h, tag: 'wall' });
  const driveEnd = yard.minX;
  v.ranch = {
    house, houseRect, barn: barnRect, door: 'W', yard,
    drive: [-1835, RANCH_DRIVE_Z, driveEnd, RANCH_DRIVE_Z],
    gate: { x: -1806, z: RANCH_DRIVE_Z },
    mailbox: { x: -1832, z: RANCH_DRIVE_Z - 7 },
    bales, paddocks, roam, shelters, horses, pasture: PASTURE, sheep: SHEEP_COUNT,
  };
  layout.parking.push({ x: -1712, z: 270, heading: E }, { x: -1712, z: 275, heading: E });
  v.drives.push(mkRect(-1835, RANCH_DRIVE_Z - 2.6, driveEnd, RANCH_DRIVE_Z + 2.6));
  taken.push(yard, PASTURE, mkRect(PADDOCK_A.minX, PADDOCK_A.minZ, PADDOCK_B.maxX, PADDOCK_A.maxZ), CORRAL, mkRect(-1835, RANCH_DRIVE_Z - 6, driveEnd, RANCH_DRIVE_Z + 6), mkRect(-1626 - 4, 250, -1612, 268));
  // Oaks for the house's shade and along the yard's north side; a hedgerow along the loop beside the drive.
  for (const [x, z] of [[-1736, 228], [-1712, 217], [-1690, 216], [-1664, 216], [-1630, 218], [-1750, 306]] as const) oak(layout, x, z, rng);
  v.hedges.push(mkRect(-1822, 208, -1820.6, 238));
}

/** The hay fields, the pumpkin patch with its scarecrow, the hedgerow along hay field A. */
function buildFields(layout: CityLayout, v: ValleyFarms, rng: Rng, taken: Rect[]): void {
  const hayA = mkRect(-1816, 104, -1764, 200);
  const hayB = mkRect(-1604, 222, -1530, 298);
  const patch = mkRect(-1616, 336, -1546, 396);
  v.fields.push({ rect: hayA, crop: 'wheat', rowAngle: 0 }, { rect: hayB, crop: 'wheat', rowAngle: E }, { rect: patch, crop: 'furrow', rowAngle: 0 });
  v.hedges.push(mkRect(-1822, 104, -1820.6, 204));
  taken.push(hayA, hayB, patch);
  // Forty pumpkins scattered over the patch, across its furrows, a scarecrow among them.
  for (let n = 0; n < 40; n++) {
    const x = rng.range(patch.minX + 3, patch.maxX - 3);
    const z = rng.range(patch.minZ + 3, patch.maxZ - 3);
    prop(layout, 'pumpkin', x, z, rng.range(0, 1), rng.range(0.8, 1.3));
  }
  prop(layout, 'scarecrow', (patch.minX + patch.maxX) / 2, (patch.minZ + patch.maxZ) / 2, rng.range(-Math.PI, Math.PI), 1);
  // Two round bales left in hay field B, and a third by field A.
  for (const [x, z] of [[-1580, 250], [-1560, 270], [-1790, 150]] as const) {
    v.ranch.bales.push({ x, z });
    v.solids.push({ rect: mkRect(x - BALE_R, z - BALE_R, x + BALE_R, z + BALE_R), y0: 0, y1: BALE_H, tag: 'container', round: true });
  }
}

/** The ruined stone barn on the Willow Knoll's crown: three stumps of wall, one gable end still standing. */
function buildRuin(layout: CityLayout, v: ValleyFarms, taken: Rect[]): void {
  const r = RUIN;
  const y = countryGround(layout.country, (r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2);
  const t = 0.7;
  const walls = [
    { rect: mkRect(r.minX, r.minZ, r.maxX - 5.5, r.minZ + t), h: 2.9 },
    { rect: mkRect(r.maxX - 3.5, r.minZ, r.maxX, r.minZ + t), h: 1.5 },
    { rect: mkRect(r.minX, r.maxZ - t, r.minX + 6, r.maxZ), h: 1.9 },
    { rect: mkRect(r.minX, r.minZ, r.minX + t, r.maxZ), h: 6.4 },
    { rect: mkRect(r.maxX - t, r.minZ + 1.5, r.maxX, r.minZ + 4.8), h: 1.2 },
  ];
  v.ruin = { rect: r, y, walls };
  for (const w of walls) v.solids.push({ rect: w.rect, y0: y, y1: y + w.h, tag: 'wall' });
  taken.push(mkRect(r.minX - 3, r.minZ - 3, r.maxX + 3, r.maxZ + 3));
}

/** Oaks and bushes over the open land: groves round the knoll, a windbreak along the loop's west verge and single trees in the meadows. */
function scatter(layout: CityLayout, v: ValleyFarms, rng: Rng, taken: Rect[]): void {
  const country = layout.country;
  const placed: Array<{ x: number; z: number }> = [];
  for (const p of layout.props.slice(v.firstProp)) if (p.kind === 'tree') placed.push(p);
  const rise = v.vineyard.rise;
  const free = (x: number, z: number, edge: number, gap: number) =>
    z >= VALLEY_FARMS_FROM &&
    Math.hypot((x - rise.cx) / rise.rx, (z - rise.cz) / rise.rz) > 0.99 &&
    countryGround(country, x, z) >= 0 &&
    [[-30, -30], [30, -30], [-30, 30], [30, 30]].every(([dx, dz]) => onCountyLand(country, x + dx!, z + dz!)) &&
    roadEdgeDistance(x, z) >= edge &&
    !taken.some((r) => rectContains(r, x, z, 3)) &&
    !placed.some((p) => Math.hypot(p.x - x, p.z - z) < gap);
  // The windbreak: oaks every 20 to 34 m along the loop's west verge, 20 m off its edge, from the vineyard's drive to the bend.
  for (let z = 150; z < 300; z += rng.range(20, 34)) {
    const x = -1866 - rng.range(0, 6);
    if (free(x, z, 18, 12)) {
      oak(layout, x, z, rng);
      placed.push({ x, z });
    }
  }
  // Groves: round the Willow Knoll, between the vineyard and the loop's south bend, round the ranch's south and east.
  const groves = [[-2060, 370, 70], [-1960, 340, 60], [-1920, 420, 50], [-1760, 440, 70], [-1580, 450, 60], [-1700, 130, 50], [-2060, 250, 40]] as const;
  for (const [gx, gz, gr] of groves) {
    for (let n = 0, tries = 0; n < 7 && tries < 80; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * gr;
      const x = gx + Math.cos(a) * d;
      const z = gz + Math.sin(a) * d;
      if (!free(x, z, 22, 11)) continue;
      oak(layout, x, z, rng);
      placed.push({ x, z });
      n++;
    }
  }
  // Single oaks in the meadows, and bushes: in clumps at the groves and along the fences, a few alone.
  for (let n = 0, tries = 0; n < 12 && tries < 400; tries++) {
    const x = rng.range(-2260, -1470);
    const z = rng.range(VALLEY_FARMS_FROM + 20, 560);
    if (!free(x, z, 26, 40)) continue;
    oak(layout, x, z, rng);
    placed.push({ x, z });
    n++;
  }
  const bushAt = (x: number, z: number) => addProp(layout, 'bush', x, z, rng.range(0, Math.PI * 2), rng.range(0.85, 1.3), countryGround(country, x, z));
  for (const t of placed.slice()) {
    if (!rng.chance(0.7)) continue;
    for (let k = rng.int(1, 3); k > 0; k--) {
      const x = t.x + rng.range(-5, 5);
      const z = t.z + rng.range(-5, 5);
      if (z >= VALLEY_FARMS_FROM && Math.hypot((x - rise.cx) / rise.rx, (z - rise.cz) / rise.rz) > 0.99 && countryGround(country, x, z) >= 0 && roadEdgeDistance(x, z) >= 14 && !taken.some((r) => rectContains(r, x, z, 1.5))) bushAt(x, z);
    }
  }
  for (let n = 0, tries = 0; n < 30 && tries < 400; tries++) {
    const x = rng.range(-2260, -1470);
    const z = rng.range(VALLEY_FARMS_FROM + 10, 560);
    if (free(x, z, 22, 0)) {
      bushAt(x, z);
      n++;
    }
  }
}

/** The valley's farms, after the places (buildCountry): every prop, building, garage, field and solid appended. */
export function buildValley(layout: CityLayout): void {
  const country: Country = layout.country;
  const v = noValley();
  v.firstProp = layout.props.length;
  const rng = new Rng(hashInts(layout.seed, SALT));
  const taken: Rect[] = [];
  buildVineyard(layout, v, rng, taken);
  buildRanch(layout, v, rng, taken);
  buildFields(layout, v, rng, taken);
  buildRuin(layout, v, taken);
  scatter(layout, v, rng, taken);
  v.endProp = layout.props.length;
  // Each farm's drive, its sign or gate and its mailbox, for the poles to keep off (as the county's farms do).
  const at = (x: number, z: number) => mkRect(x, z, x, z);
  const { winery } = v.vineyard;
  const { ranch } = v;
  for (const [drive, sign, mailbox] of [[winery.drive, winery.sign, winery.mailbox], [ranch.drive, ranch.gate, ranch.mailbox]] as const) {
    const [ax, az, bx, bz] = drive;
    country.approaches.push({ rect: mkRect(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)), pad: DRIVE_CLEAR }, { rect: at(sign.x, sign.z), pad: DRIVE_CLEAR }, { rect: at(mailbox.x, mailbox.z), pad: DRIVE_CLEAR });
  }
  country.valley = v;
}
