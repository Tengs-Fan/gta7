// Shallow, batched facade relief. Building footprints, roof heights and street
// clearances still come from the simulation; these are architectural finishes.
import { hashInts, type Building, type FacadeStyle, type Side, type Tier } from '../world/layout';
import { COPING_H, PARAPET_H } from './city/rooftops';
import { GeoBuilder, scaleRgb, type RGB } from './geo';
import { FACADE_CELL, FACADE_WINDOW, HOUSE_SILL, facadeWindowAt, facadeWindowFit } from './textures';

const UV = { kind: 'world' as const, scale: 3 };

/** How far (m) the cornice at the top of each tier stands out from the wall plane. */
export function corniceProjection(b: Building, style: FacadeStyle = b.style): number {
  switch (style) {
    case 'glassBlue':
    case 'glassTeal':
      return 0.18;
    case 'hotel':
      return 0.32;
    case 'brick':
      return 0.36;
    case 'office':
      return 0.28;
    case 'warehouse':
      return 0.2;
    default:
      return 0.26;
  }
}

/**
 * The trim of a building whose walls take `color`: its bands and piers, and the lighter cap of its cornices. The darker
 * aluminium on curtain walls reads as structure; pale stone catches the sun on masonry.
 */
export function trimColors(b: Building, color: RGB, style: FacadeStyle = b.style): { trim: RGB; cap: RGB } {
  const glass = style === 'glassBlue' || style === 'glassTeal';
  const finish: RGB = style === 'brick' ? [0.55, 0.47, 0.37] : style === 'office' ? [0.48, 0.43, 0.35] : style === 'warehouse' ? [0.28, 0.31, 0.34] : [0.68, 0.64, 0.56];
  const trim: RGB = glass ? [0.15, 0.19, 0.23] : [color[0] * finish[0], color[1] * finish[1], color[2] * finish[2]];
  return { trim, cap: glass ? [0.3, 0.36, 0.39] : scaleRgb(trim, 1.12) };
}

/** Sills, cornices and structural piers give the window atlases a real silhouette. */
/** `style` is the facade the tier is drawn in (a glass tower's podium is in stone). */
export function facadeRelief(g: GeoBuilder, b: Building, t: Tier, baseY: number, color: RGB, style: FacadeStyle = b.style): void {
  const width = t.maxX - t.minX;
  const depth = t.maxZ - t.minZ;
  if (Math.min(width, depth) < 3) return;
  const glass = style === 'glassBlue' || style === 'glassTeal';
  const first = Math.max(t.y0, baseY);
  // Keep all street-level doorways completely clear.
  const { trim, cap } = trimColors(b, color, style);
  const band = (y: number, h: number, out: number, c: RGB): void => {
    g.box(t.minX - out, y, t.minZ - out, t.maxX + out, y + h, t.maxZ + out, { uv: UV, color: c, bottom: true });
  };

  if (style === 'house') {
    if (t === b.tiers[0] && b.district !== 'country') housePlinth(g, t);
    // Eave fascia has actual thickness even when the gable is viewed edge-on.
    band(t.y1 - 0.16, 0.14, 0.12, [0.82, 0.8, 0.74]);
    return;
  }
  // A cornice crowning the ground floor (a deep band and a lip over it), and a shadow line at each setback.
  if (first > t.y0 + 0.5 && first < t.y1 - 0.5) {
    band(first - 0.1, 0.2, 0.16, cap);
    band(first + 0.1, 0.07, 0.24, scaleRgb(cap, 1.06));
  }
  if (t.y0 > baseY + 1) band(t.y0 + 0.02, 0.16, 0.12, cap);
  // The crowning cornice: a real shadow line under every roof edge.
  const cornice = corniceProjection(b, style);
  band(t.y1 - 0.34, 0.12, cornice * 0.55, scaleRgb(cap, 0.92));
  band(t.y1 - 0.22, 0.22, cornice, cap);

  const floorH = FACADE_CELL[style].h;
  const every = style === 'brick' ? 3 : style === 'stucco' ? 2 : glass ? 4 : 1;
  const floor0 = Math.max(1, Math.ceil((first - baseY + 0.5) / floorH));
  // String courses at floor lines, hung just under the line, so a balcony's or fire escape's floor on that line covers
  // its top instead of a course standing 5 to 13 cm proud of the floor along the wall.
  for (let floor = floor0; baseY + floor * floorH < t.y1 - 0.8; floor++) {
    if (floor % every !== 0) continue;
    const y = baseY + floor * floorH;
    const bh = style === 'hotel' ? 0.2 : 0.12;
    band(y - bh - 0.005, bh, style === 'hotel' ? 0.18 : 0.1, trim);
  }

  // Corner piers stop above the entrance band; the amount of relief is shallow
  // enough that it never adds a new obstacle to a walkable street or roof.
  const bottom = Math.max(first + 0.18, t.y0 + 3.2);
  if (bottom >= t.y1 - 0.2) return;
  const pierW = glass ? 0.18 : style === 'warehouse' ? 0.32 : 0.24;
  for (const x of [t.minX, t.maxX]) {
    for (const z of [t.minZ, t.maxZ]) {
      g.box(x - pierW / 2, bottom, z - pierW / 2, x + pierW / 2, t.y1 - 0.16, z + pierW / 2, { uv: UV, color: trim });
    }
  }

  if (!glass && style !== 'warehouse') return;
  // External mullions on the cell edges, on the same continuous perimeter coordinate as the facade UV so corners
  // align: a fin 0.3 m deep on every bay of the teal curtain walls, whose glass runs floor to floor, so they read as
  // vertical from the street; a 0.2 m one on every other bay of the blue ones, whose spandrels band them; slender
  // ribs on the warehouses' cladding.
  const teal = style === 'glassTeal';
  const stride = FACADE_CELL[style].w * (glass && !teal ? 2 : 1);
  const fin = teal ? 0.3 : glass ? 0.2 : 0.14;
  const half = teal ? 0.035 : 0.055;
  const walls = [
    [t.minX, t.maxZ, 1, 0, width, 0],
    [t.maxX, t.maxZ, 0, -1, depth, width],
    [t.maxX, t.minZ, -1, 0, width, width + depth],
    [t.minX, t.minZ, 0, 1, depth, 2 * width + depth],
  ] as const;
  for (const [ax, az, ux, uz, length, perimeter] of walls) {
    const offset = Math.ceil((perimeter + 0.5) / stride) * stride - perimeter;
    for (let d = offset; d < length - 0.5; d += stride) {
      const x = ax + ux * d;
      const z = az + uz * d;
      // From 2 cm inside the wall (its back face hidden in it, off the wall's plane) out to `fin` (the wall's outward
      // normal is (-uz, ux)), `half` either side of the cell edge.
      const [ix, iz] = [x + uz * 0.02, z - ux * 0.02];
      const [ox, oz] = [x - uz * fin, z + ux * fin];
      const x0 = Math.min(ix, ox) - Math.abs(ux) * half;
      const x1 = Math.max(ix, ox) + Math.abs(ux) * half;
      const z0 = Math.min(iz, oz) - Math.abs(uz) * half;
      const z1 = Math.max(iz, oz) + Math.abs(uz) * half;
      g.box(x0, bottom, z0, x1, t.y1 - 0.16, z1, { uv: UV, color: cap });
    }
  }
}

/** Stone of the houses' plinths. */
const PLINTH: RGB = [0.37, 0.34, 0.29];

/**
 * A stone plinth round the foot of a house's walls, as high as the sill its ground-floor fronts paint (HOUSE_SILL),
 * standing 4 cm out with a weathered top sloping off the wall. Faces only, no cap over the footprint: no level surface
 * near the ground (the headlights' pools light every such surface, see light_sprites.test.ts).
 */
function housePlinth(g: GeoBuilder, t: Tier): void {
  const top = t.y0 + HOUSE_SILL;
  const out = 0.04;
  for (const wl of tierWalls(t)) {
    const a = wallPoint(wl, -out, out, t.y0 - 0.02);
    const b = wallPoint(wl, wl.len + out, out, t.y0 - 0.02);
    const c = wallPoint(wl, wl.len + out, out, top - 0.03);
    const d = wallPoint(wl, -out, out, top - 0.03);
    g.quad(...a, ...b, ...c, ...d, [0, 0, 1, 0, 1, 1, 0, 1], PLINTH);
    const e = wallPoint(wl, wl.len + out, 0, top);
    const f = wallPoint(wl, -out, 0, top);
    g.quad(...d, ...c, ...e, ...f, [0, 0, 1, 0, 1, 1, 0, 1], scaleRgb(PLINTH, 1.08));
  }
}

/** How far (m) a balcony stands out from the wall, and its front's height above the slab. */
export const BALCONY_DEPTH: Partial<Record<Building['style'], number>> = { hotel: 1.1, stucco: 0.85 };
const BALCONY_FRONT = 1.0;
/** Thickness (m) of a balcony's slab. */
export const BALCONY_SLAB = 0.14;

/**
 * Balconies on the street walls (`sides`) of an apartment block or hotel, on every storey above the ground floor whose
 * top is at least 0.6 m under the roof: a hotel runs one along each floor, an apartment block has one per window of
 * every `every`th column. Each is a slab with a solid front and ends in the wall's colour, its floor at the storey's
 * (the window grid's rows start at baseY). Returns how many it drew.
 */
export function balconies(g: GeoBuilder, b: Building, t: Tier, baseY: number, sides: readonly Side[], wall: RGB, every: number): number {
  const depth = BALCONY_DEPTH[b.style];
  if (!depth) return 0;
  const cell = FACADE_CELL[b.style];
  const win = FACADE_WINDOW[b.style];
  const slab = scaleRgb(wall, 0.92);
  const k0 = Math.max(1, Math.ceil((t.y0 - baseY) / cell.h - 1e-6));
  let n = 0;
  for (const wl of tierWalls(t)) {
    if (!sides.includes(wl.side) || wl.len < cell.w + 1) continue;
    for (let k = k0; baseY + (k + 1) * cell.h <= t.y1 - 0.6; k++) {
      const fy = baseY + k * cell.h;
      // On a setback tier the slab's underside clears the parapet and coping of the roof below.
      if (fy < t.y0 + (t === b.tiers[0] ? 0.5 : PARAPET_H + COPING_H + BALCONY_SLAB + 0.05)) continue;
      // Spans along the wall: the whole wall short of its ends, or one per window of every `every`th column.
      const spans: Array<[number, number]> = [];
      if (b.style === 'hotel') spans.push([0.4, wl.len - 0.4]);
      else {
        for (const c of wholeCells(wl, cell.w, 0.3)) {
          if (c % every !== 0) continue;
          const s = c * cell.w - wl.u;
          spans.push([s + cell.w * (win.x0 - 0.06), s + cell.w * (win.x1 + 0.06)]);
        }
      }
      for (const [s0, s1] of spans) {
        wallBox(g, wl, s0, s1, 0, depth, fy - BALCONY_SLAB, fy, slab, true);
        wallBox(g, wl, s0, s1, depth - 0.07, depth, fy, fy + BALCONY_FRONT, wall);
        wallBox(g, wl, s0, s0 + 0.07, 0, depth - 0.07, fy, fy + BALCONY_FRONT, wall);
        wallBox(g, wl, s1 - 0.07, s1, 0, depth - 0.07, fy, fy + BALCONY_FRONT, wall);
        n++;
      }
    }
  }
  return n;
}

/**
 * One wall of a tier, walked counter-clockwise from above as GeoBuilder.box walks it, so `u` (metres round the
 * footprint to its start) is where the facade's window grid stands on it: its cells' edges fall at whole multiples of
 * the cell width in u.
 */
export interface TierWallFrame {
  side: Side;
  x0: number;
  z0: number;
  ux: number;
  uz: number;
  len: number;
  u: number;
}

export function tierWalls(t: Tier): TierWallFrame[] {
  const w = t.maxX - t.minX;
  const d = t.maxZ - t.minZ;
  return [
    { side: 'S', x0: t.minX, z0: t.maxZ, ux: 1, uz: 0, len: w, u: 0 },
    { side: 'E', x0: t.maxX, z0: t.maxZ, ux: 0, uz: -1, len: d, u: w },
    { side: 'N', x0: t.maxX, z0: t.minZ, ux: -1, uz: 0, len: w, u: w + d },
    { side: 'W', x0: t.minX, z0: t.minZ, ux: 0, uz: 1, len: d, u: 2 * w + d },
  ];
}

/** The window-grid columns lying wholly on a wall, at least `margin` m from its ends (column c spans c * cw - u to (c + 1) * cw - u). */
export function wholeCells(wl: TierWallFrame, cw: number, margin: number): number[] {
  const out: number[] = [];
  for (let c = Math.ceil((wl.u + margin) / cw - 1e-9); (c + 1) * cw - wl.u <= wl.len - margin + 1e-9; c++) out.push(c);
  return out;
}

/** A point `s` m along a wall, `o` m out from it, at height y. */
function wallPoint(wl: TierWallFrame, s: number, o: number, y: number): [number, number, number] {
  return [wl.x0 + wl.ux * s - wl.uz * o, y, wl.z0 + wl.uz * s + wl.ux * o];
}

/** An axis-aligned box between wall-local corners (s along the wall, o out from it); its underside only where it overhangs (`bottom`). */
export function wallBox(g: GeoBuilder, wl: TierWallFrame, s0: number, s1: number, o0: number, o1: number, y0: number, y1: number, c: RGB, bottom = false): void {
  const [ax, , az] = wallPoint(wl, s0, o0, 0);
  const [bx, , bz] = wallPoint(wl, s1, o1, 0);
  g.box(Math.min(ax, bx), y0, Math.min(az, bz), Math.max(ax, bx), y1, Math.max(az, bz), { uv: UV, color: c, bottom });
}

/** A quad from wall-local corners (s, o, y), for a double-sided material (the street decor's). */
function wallQuad(g: GeoBuilder, wl: TierWallFrame, p: ReadonlyArray<readonly [number, number, number]>, c: RGB): void {
  const q = p.map(([s, o, y]) => wallPoint(wl, s, o, y));
  g.quad(...q[0]!, ...q[1]!, ...q[2]!, ...q[3]!, [0, 0, 1, 0, 1, 1, 0, 1], c);
}

/** Iron of the fire escapes: black, or a dark green on some. */
const IRON: RGB = [0.045, 0.045, 0.05];
const IRON_GREEN: RGB = [0.05, 0.085, 0.065];
/** A fire escape's landings stand this far (m) out from the wall; its rail is this high over them. */
export const ESCAPE_DEPTH = 1.1;
const ESCAPE_RAIL = 0.95;
/**
 * A landing's floor stands this far (m) over its storey's floor line: its 6 cm deck and its stairs' stringers (12 cm
 * under it) clear the ground floor's cornice, whose lip reaches 0.17 m over the line of the first storey (facadeRelief).
 */
export const ESCAPE_FLOOR = 0.3;
/** How far (m) the drop ladder hangs under the lowest landing. */
export const LADDER_DROP = 0.95;

/**
 * A fire escape on a brick block's street wall: an iron landing at every storey above the ground floor, two window
 * columns wide, with rails, zigzag stairs between the landings and a drop ladder hanging from the lowest, which ends
 * well over the heads of people on the pavement. Placed on the two columns at one end of the wall in `sides` with the
 * most of them (three at least); drawn with a double-sided material. Returns the landings drawn.
 */
export function fireEscape(g: GeoBuilder, b: Building, t: Tier, baseY: number, sides: readonly Side[]): number {
  const cell = FACADE_CELL[b.style];
  const h = cell.h;
  let best: { wl: TierWallFrame; cols: number[] } | null = null;
  for (const wl of tierWalls(t)) {
    if (!sides.includes(wl.side)) continue;
    const cols = wholeCells(wl, cell.w, 0.4);
    if (cols.length >= 3 && (!best || cols.length > best.cols.length)) best = { wl, cols };
  }
  if (!best) return 0;
  const { wl, cols } = best;
  const r = (k: number) => hashInts(b.id, k, 0xf1e) / 4294967296;
  const c = r(1) < 0.5 ? cols[0]! : cols[cols.length - 2]!;
  const s0 = c * cell.w - wl.u + 0.15;
  const s1 = (c + 2) * cell.w - wl.u - 0.15;
  const iron = r(2) < 0.3 ? IRON_GREEN : IRON;
  const D = ESCAPE_DEPTH;
  const floors: number[] = [];
  for (let k = Math.max(0, Math.ceil((t.y0 - baseY) / h - 1e-6)); baseY + k * h + ESCAPE_FLOOR + ESCAPE_RAIL <= t.y1 - 0.4; k++) floors.push(baseY + k * h + ESCAPE_FLOOR);
  if (floors.length < 2) return 0;
  const bar = 0.045;
  floors.forEach((fy, i) => {
    // The landing, its toe board and rails, and posts at its outer corners.
    wallBox(g, wl, s0, s1, 0, D, fy - 0.06, fy, iron, true);
    wallBox(g, wl, s0, s1, D - bar, D, fy, fy + 0.1, iron);
    wallBox(g, wl, s0, s1, D - bar, D, fy + ESCAPE_RAIL - bar, fy + ESCAPE_RAIL, iron);
    for (const s of [s0, s1 - bar]) wallBox(g, wl, s, s + bar, 0, D, fy + ESCAPE_RAIL - bar, fy + ESCAPE_RAIL, iron);
    for (const s of [s0, s1 - bar]) wallBox(g, wl, s, s + bar, D - bar, D, fy, fy + ESCAPE_RAIL, iron);
    // Stairs up to the next landing, along the wall's side of it, turning back at every storey.
    const up = floors[i + 1];
    if (up !== undefined) {
      const run = (up - fy) / Math.tan((50 * Math.PI) / 180);
      const fromEnd = i % 2 === 0;
      const a = fromEnd ? s1 - 0.2 : s0 + 0.2;
      const e = fromEnd ? a - run : a + run;
      const [o0, o1] = [0.1, 0.7];
      // Treads (one sloped plane) and the two stringers.
      wallQuad(g, wl, [[a, o0, fy], [a, o1, fy], [e, o1, up], [e, o0, up]], iron);
      for (const o of [o0, o1]) wallQuad(g, wl, [[a, o, fy - 0.12], [e, o, up - 0.12], [e, o, up + 0.12], [a, o, fy + 0.12]], iron);
    }
  });
  // The drop ladder, hanging from the lowest landing's outer edge, short of the shop awnings, whose tops are 1 m under
  // the ground floor's top.
  const fy = floors[0]!;
  const ls = r(3) < 0.5 ? s0 + 0.5 : s1 - 1.0;
  for (const s of [ls, ls + 0.45]) wallBox(g, wl, s, s + bar, D - 0.3, D - 0.3 + bar, fy - LADDER_DROP, fy, iron);
  for (let k = 1; k <= 3; k++) wallBox(g, wl, ls, ls + 0.45 + bar, D - 0.3, D - 0.3 + 0.03, fy - k * 0.3, fy - k * 0.3 + 0.03, iron);
  return floors.length;
}

/** Louvred shutters either side of the upper windows of a house, in the green of its ground floor's. */
export const SHUTTER: RGB = [0.05, 0.11, 0.075];

/**
 * Shutters either side of every whole window of a house above its ground floor (on its street walls, `sides`) or on
 * its other walls, where the facade's grid (offset `col0`, `row0` cells, as the facade uv's offU and offV) paints one:
 * a house paints windows in two cells of three (FACADE_WINDOW.skip).
 */
export function houseShutters(g: GeoBuilder, t: Tier, baseY: number, sides: readonly Side[], col0: number, row0: number): number {
  const cell = FACADE_CELL.house;
  const win = FACADE_WINDOW.house;
  let n = 0;
  for (const wl of tierWalls(t)) {
    for (const c of wholeCells(wl, cell.w, 0.2)) {
      for (let k = Math.floor((t.y0 - baseY) / cell.h); baseY + k * cell.h < t.y1; k++) {
        // The window as the facade draws it, lowered and shortened under the eaves on the top floor; none below the
        // plinth or in a street wall's ground floor.
        const fit = facadeWindowFit('house', baseY + k * cell.h, t.y1);
        if (!fit) continue;
        const wy0 = baseY + k * cell.h + fit.y0;
        const wy1 = baseY + k * cell.h + fit.y1;
        if (wy0 < t.y0 + 0.35 || (sides.includes(wl.side) && wy0 < baseY)) continue;
        const col = (((c + col0) % 8) + 8) % 8;
        const row = 7 - ((((k + row0) % 8) + 8) % 8);
        if (!facadeWindowAt('house', col, row)) continue;
        const s = c * cell.w - wl.u;
        const a = s + win.x0 * cell.w;
        const e = s + win.x1 * cell.w;
        const sw = (e - a) * 0.42;
        wallBox(g, wl, a - sw - 0.03, a - 0.03, -0.02, 0.05, wy0, wy1, SHUTTER);
        wallBox(g, wl, e + 0.03, e + sw + 0.03, -0.02, 0.05, wy0, wy1, SHUTTER);
        n++;
      }
    }
  }
  return n;
}

/**
 * Flush ironwork sits below the road paint and cannot affect driving. Cast iron is about as dark as the asphalt round
 * it (#3a3b3e, 0.04 linear), with a worn rim and darker slots: a pale cover read as a light disc under the cars parked
 * over it (they stop on a lane's centre, where the covers are).
 */
export function manhole(g: GeoBuilder, x: number, z: number): void {
  const r = 0.48;
  const segments = 20;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    const ax = x + Math.cos(a) * r;
    const az = z + Math.sin(a) * r;
    const bx = x + Math.cos(b) * r;
    const bz = z + Math.sin(b) * r;
    g.tri(x, 0.009, z, bx, 0.009, bz, ax, 0.009, az, [0.5, 0.5, 1, 0, 0, 0], [0.05, 0.05, 0.052]);
    const aiX = x + Math.cos(a) * (r - 0.045);
    const aiZ = z + Math.sin(a) * (r - 0.045);
    const biX = x + Math.cos(b) * (r - 0.045);
    const biZ = z + Math.sin(b) * (r - 0.045);
    g.quad(ax, 0.011, az, aiX, 0.011, aiZ, biX, 0.011, biZ, bx, 0.011, bz, [0, 0, 1, 0, 1, 1, 0, 1], [0.075, 0.074, 0.072]);
  }
  for (let k = -2; k <= 2; k++) {
    const half = Math.sqrt(0.36 * 0.36 - (k * 0.12) ** 2);
    g.flat(x - half, z + k * 0.12 - 0.018, x + half, z + k * 0.12 + 0.018, 0.012, UV, [0.022, 0.022, 0.024]);
  }
}

export function stormDrain(g: GeoBuilder, x: number, z: number, vertical: boolean): void {
  const halfX = vertical ? 0.19 : 0.48;
  const halfZ = vertical ? 0.48 : 0.19;
  g.flat(x - halfX, z - halfZ, x + halfX, z + halfZ, 0.009, UV, [0.03, 0.032, 0.034]);
  for (let k = -3; k <= 3; k++) {
    const cx = x + (vertical ? 0 : k * 0.12);
    const cz = z + (vertical ? k * 0.12 : 0);
    const sx = vertical ? halfX : 0.024;
    const sz = vertical ? 0.024 : halfZ;
    g.flat(cx - sx, cz - sz, cx + sx, cz + sz, 0.013, UV, [0.07, 0.07, 0.068]);
  }
}
