// Shallow, batched facade relief. Building footprints, roof heights and street
// clearances still come from the simulation; these are architectural finishes.
import type { Building, Side, Tier } from '../world/layout';
import { GeoBuilder, scaleRgb, type RGB } from './geo';
import { FACADE_CELL, FACADE_WINDOW, HOUSE_SILL } from './textures';

const UV = { kind: 'world' as const, scale: 3 };

/** How far (m) the cornice at the top of each tier stands out from the wall plane. */
export function corniceProjection(b: Building): number {
  switch (b.style) {
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
export function trimColors(b: Building, color: RGB): { trim: RGB; cap: RGB } {
  const glass = b.style === 'glassBlue' || b.style === 'glassTeal';
  const finish: RGB = b.style === 'brick' ? [0.55, 0.47, 0.37] : b.style === 'office' ? [0.48, 0.43, 0.35] : b.style === 'warehouse' ? [0.28, 0.31, 0.34] : [0.68, 0.64, 0.56];
  const trim: RGB = glass ? [0.15, 0.19, 0.23] : [color[0] * finish[0], color[1] * finish[1], color[2] * finish[2]];
  return { trim, cap: glass ? [0.3, 0.36, 0.39] : scaleRgb(trim, 1.12) };
}

/** Sills, cornices and structural piers give the window atlases a real silhouette. */
export function facadeRelief(g: GeoBuilder, b: Building, t: Tier, baseY: number, color: RGB): void {
  const width = t.maxX - t.minX;
  const depth = t.maxZ - t.minZ;
  if (Math.min(width, depth) < 3) return;
  const glass = b.style === 'glassBlue' || b.style === 'glassTeal';
  const first = Math.max(t.y0, baseY);
  // Keep all street-level doorways completely clear.
  const { trim, cap } = trimColors(b, color);
  const band = (y: number, h: number, out: number, c: RGB): void => {
    g.box(t.minX - out, y, t.minZ - out, t.maxX + out, y + h, t.maxZ + out, { uv: UV, color: c, bottom: true });
  };

  if (b.style === 'house') {
    // A stone plinth round the foot of the walls, as high as the sill the ground-floor fronts paint.
    if (t === b.tiers[0]) band(t.y0 - 0.02, HOUSE_SILL + 0.02, 0.04, [0.37, 0.34, 0.29]);
    // Eave fascia has actual thickness even when the gable is viewed edge-on.
    band(t.y1 - 0.16, 0.14, 0.12, [0.82, 0.8, 0.74]);
    return;
  }
  // A continuous shadow line above the storefront and a second at each setback.
  if (first > t.y0 + 0.5 && first < t.y1 - 0.5) band(first - 0.07, 0.14, 0.12, cap);
  if (t.y0 > baseY + 1) band(t.y0 + 0.02, 0.16, 0.12, cap);
  // The crowning cornice: a real shadow line under every roof edge.
  const cornice = corniceProjection(b);
  band(t.y1 - 0.34, 0.12, cornice * 0.55, scaleRgb(cap, 0.92));
  band(t.y1 - 0.22, 0.22, cornice, cap);

  const floorH = FACADE_CELL[b.style].h;
  const every = b.style === 'brick' ? 3 : b.style === 'stucco' ? 2 : glass ? 4 : 1;
  const floor0 = Math.max(1, Math.ceil((first - baseY + 0.5) / floorH));
  for (let floor = floor0; baseY + floor * floorH < t.y1 - 0.8; floor++) {
    if (floor % every !== 0) continue;
    const y = baseY + floor * floorH;
    band(y - 0.07, b.style === 'hotel' ? 0.2 : 0.12, b.style === 'hotel' ? 0.18 : 0.1, trim);
  }

  // Corner piers stop above the entrance band; the amount of relief is shallow
  // enough that it never adds a new obstacle to a walkable street or roof.
  const bottom = Math.max(first + 0.18, t.y0 + 3.2);
  if (bottom >= t.y1 - 0.2) return;
  const pierW = glass ? 0.18 : b.style === 'warehouse' ? 0.32 : 0.24;
  for (const x of [t.minX, t.maxX]) {
    for (const z of [t.minZ, t.maxZ]) {
      g.box(x - pierW / 2, bottom, z - pierW / 2, x + pierW / 2, t.y1 - 0.16, z + pierW / 2, { uv: UV, color: trim });
    }
  }

  if (!glass && b.style !== 'warehouse') return;
  // Alternate glass bays receive a slender external mullion. Placing them on the
  // same continuous perimeter coordinate as the facade UV keeps corners aligned.
  const stride = FACADE_CELL[b.style].w * (glass ? 2 : 1);
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
      const dx = ux !== 0 ? 0.055 : 0.07;
      const dz = ux !== 0 ? 0.07 : 0.055;
      g.box(x - dx, bottom, z - dz, x + dx, t.y1 - 0.16, z + dz, { uv: UV, color: cap });
    }
  }
}

/** How far (m) a balcony stands out from the wall, and its front's height above the slab. */
export const BALCONY_DEPTH: Partial<Record<Building['style'], number>> = { hotel: 1.1, stucco: 0.85 };
const BALCONY_FRONT = 1.0;

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
  const w = t.maxX - t.minX;
  const d = t.maxZ - t.minZ;
  const walls = [
    { side: 'S' as Side, x0: t.minX, z0: t.maxZ, ux: 1, uz: 0, len: w, u: 0 },
    { side: 'E' as Side, x0: t.maxX, z0: t.maxZ, ux: 0, uz: -1, len: d, u: w },
    { side: 'N' as Side, x0: t.maxX, z0: t.minZ, ux: -1, uz: 0, len: w, u: w + d },
    { side: 'W' as Side, x0: t.minX, z0: t.minZ, ux: 0, uz: 1, len: d, u: 2 * w + d },
  ];
  const slab = scaleRgb(wall, 0.92);
  const k0 = Math.max(1, Math.ceil((t.y0 - baseY) / cell.h - 1e-6));
  let n = 0;
  /** An axis-aligned box from wall-local corners (s along the wall, o out from it). */
  const box = (wl: (typeof walls)[number], s0: number, s1: number, o0: number, o1: number, y0: number, y1: number, c: RGB) => {
    const nx = -wl.uz;
    const nz = wl.ux;
    const xs = [wl.x0 + wl.ux * s0 + nx * o0, wl.x0 + wl.ux * s1 + nx * o1];
    const zs = [wl.z0 + wl.uz * s0 + nz * o0, wl.z0 + wl.uz * s1 + nz * o1];
    g.box(Math.min(...xs), y0, Math.min(...zs), Math.max(...xs), y1, Math.max(...zs), { uv: UV, color: c, bottom: true });
  };
  for (const wl of walls) {
    if (!sides.includes(wl.side) || wl.len < cell.w + 1) continue;
    for (let k = k0; baseY + (k + 1) * cell.h <= t.y1 - 0.6; k++) {
      const fy = baseY + k * cell.h;
      if (fy < t.y0 + 0.5) continue;
      // Spans along the wall: the whole wall short of its ends, or one per window of every `every`th column.
      const spans: Array<[number, number]> = [];
      if (b.style === 'hotel') spans.push([0.4, wl.len - 0.4]);
      else {
        const c0 = Math.ceil((wl.u + 0.3) / cell.w);
        for (let c = c0; (c + 1) * cell.w - wl.u <= wl.len - 0.3; c++) {
          if (c % every !== 0) continue;
          const s = c * cell.w - wl.u;
          spans.push([s + cell.w * (win.x0 - 0.06), s + cell.w * (win.x1 + 0.06)]);
        }
      }
      for (const [s0, s1] of spans) {
        box(wl, s0, s1, 0, depth, fy - 0.14, fy, slab);
        box(wl, s0, s1, depth - 0.07, depth, fy, fy + BALCONY_FRONT, wall);
        box(wl, s0, s0 + 0.07, 0, depth - 0.07, fy, fy + BALCONY_FRONT, wall);
        box(wl, s1 - 0.07, s1, 0, depth - 0.07, fy, fy + BALCONY_FRONT, wall);
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
