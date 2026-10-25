// Landmark towers: four of the tallest downtown towers with a flat roof get a crown of their own above the roof (visual only:
// footprints, heights and colliders stay those of the layout, and every addition stands inside the top tier's plan).

import { rectD, rectW, type Building, type CityLayout } from '../../world/layout';
import { scaleRgb, type GeoBuilder, type RGB, type UvMode } from '../geo';
import { prism } from './rooftops';

export type LandmarkKind = 'stepped' | 'pyramid' | 'crown' | 'wedge';

export interface Landmark {
  id: number;
  kind: LandmarkKind;
  /** Height of the roof the crown stands on and of the crown's highest point (m). */
  roof: number;
  top: number;
  /** Spire or mast height above whatever it stands on (m), 0 for none. */
  spire: number;
  /** Plan narrowing of each setback of a stepped crown (fraction, e.g. 0.2 = 20% narrower than the step below). */
  setbacks: number[];
  /** Width of the silhouette at 90% of the top height divided by the footprint's width. */
  taper90: number;
}

const ORDER: LandmarkKind[] = ['stepped', 'pyramid', 'crown', 'wedge'];

/**
 * The skyline is seen from the sea, to the east, along sight lines running west (along x). The towers stand in a grid,
 * so the tallest four line up in pairs from the sea and one crown hides another: landmarks stand at least CLEAR_Z apart
 * across those sight lines, and none stands behind a nearer tower that reaches within HIDE_H of its roof.
 */
const CLEAR_Z = 45;
const HIDE_H = 4;

/** Whether a tower nearer the sea covers at least half of `b`'s width and reaches within HIDE_H of its roof. */
function hiddenFromSea(b: Building, all: readonly Building[]): boolean {
  return all.some((o) => {
    if (o === b || o.rect.minX <= b.rect.maxX || o.height < b.height - HIDE_H) return false;
    const overlap = Math.min(o.rect.maxZ, b.rect.maxZ) - Math.max(o.rect.minZ, b.rect.minZ);
    return overlap > 0.5 * rectD(b.rect);
  });
}

/**
 * The landmark towers, one crown kind each: the tallest flat-roofed downtown and midtown towers, taken in height order
 * and skipping any that stands in line with one already chosen or behind a nearer tower, so every crown reads on its
 * own on the skyline from the sea.
 */
export function landmarkTowers(layout: CityLayout): Landmark[] {
  const candidates = layout.buildings
    .filter((b) => (b.district === 'downtown' || b.district === 'midtown') && b.roof === 'flat' && b.tiers.length > 0)
    .sort((a, b) => b.height - a.height || a.id - b.id);
  const cz = (b: Building) => (b.rect.minZ + b.rect.maxZ) / 2;
  const towers: Building[] = [];
  for (const b of candidates) {
    if (towers.length === ORDER.length) break;
    if (towers.some((t) => Math.abs(cz(t) - cz(b)) < CLEAR_Z) || hiddenFromSea(b, layout.buildings)) continue;
    towers.push(b);
  }
  return towers.map((b, i) => describe(b, ORDER[i]!));
}

const STEPS = [0.8, 0.64, 0.5];
const STEP_H = [5.5, 4.5, 3.5];

function describe(b: Building, kind: LandmarkKind): Landmark {
  const t = b.tiers[b.tiers.length - 1]!;
  const base = Math.min(rectW(b.tiers[0]!), rectD(b.tiers[0]!));
  const w = Math.min(rectW(t), rectD(t));
  const y = t.y1;
  let top = y;
  let spire = 0;
  let setbacks: number[] = [];
  let width90 = w;
  switch (kind) {
    case 'stepped': {
      setbacks = STEPS.map((s, i) => 1 - s / (i === 0 ? 1 : STEPS[i - 1]!));
      const crown = STEP_H.reduce((a, c) => a + c, 0);
      spire = 24;
      top = y + crown + spire;
      width90 = 0.3 * w * 0.5;
      break;
    }
    case 'pyramid':
      spire = 12;
      top = y + 18 + spire;
      width90 = 0.25 * w;
      break;
    case 'crown':
      spire = 22;
      top = y + spire;
      width90 = 0.6 * w;
      break;
    case 'wedge':
      spire = 9;
      top = y + 14 + spire;
      width90 = 0.12;
      break;
  }
  return { id: b.id, kind, roof: y, top, spire, setbacks, taper90: width90 / base };
}

/**
 * Draws a landmark's crown: the stepped crown's tiers in the tower's own facade (`facade`, with its facade UVs so
 * the window grid carries on), everything else in the trim batch.
 */
export function drawLandmark(facade: GeoBuilder, trim: GeoBuilder, b: Building, lm: Landmark, uv: UvMode, color: RGB): void {
  const t = b.tiers[b.tiers.length - 1]!;
  const cx = (t.minX + t.maxX) / 2;
  const cz = (t.minZ + t.maxZ) / 2;
  const w = rectW(t);
  const d = rectD(t);
  const y = t.y1;
  const metal: RGB = [0.62, 0.64, 0.66];
  const slate: RGB = [0.16, 0.2, 0.25];
  const cap = scaleRgb(color, 0.7);
  const W = { kind: 'world' as const, scale: 3 };
  switch (lm.kind) {
    case 'stepped': {
      let y0 = y;
      STEPS.forEach((s, i) => {
        const hw = (w * s) / 2;
        const hd = (d * s) / 2;
        facade.box(cx - hw, y0, cz - hd, cx + hw, y0 + STEP_H[i]!, cz + hd, { uv, color, top: false });
        trim.box(cx - hw - 0.2, y0 + STEP_H[i]! - 0.3, cz - hd - 0.2, cx + hw + 0.2, y0 + STEP_H[i]!, cz + hd + 0.2, { uv: W, color: cap });
        y0 += STEP_H[i]!;
      });
      const r = Math.min(w, d) * 0.15;
      prism(trim, cx, cz, r, r * 0.6, y0, y0 + 2, 4, metal);
      prism(trim, cx, cz, r * 0.6, 0, y0 + 2, y0 + lm.spire, 4, metal);
      prism(trim, cx, cz, 0.35, 0.35, y0 + lm.spire - 4, y0 + lm.spire - 3.4, 8, [0.9, 0.86, 0.7]);
      break;
    }
    case 'pyramid': {
      const h = 18;
      const i0 = 0.3;
      // A hipped glass-and-metal pyramid on the roof, narrowing to a quarter of the roof plan.
      const x0 = t.minX + i0;
      const x1 = t.maxX - i0;
      const z0 = t.minZ + i0;
      const z1 = t.maxZ - i0;
      const k = 0.25;
      const tx0 = cx - (w * k) / 2;
      const tx1 = cx + (w * k) / 2;
      const tz0 = cz - (d * k) / 2;
      const tz1 = cz + (d * k) / 2;
      const uv4 = [0, 0, 1, 0, 1, 1, 0, 1];
      trim.quad(x0, y, z1, x1, y, z1, tx1, y + h, tz1, tx0, y + h, tz1, uv4, slate);
      trim.quad(x1, y, z1, x1, y, z0, tx1, y + h, tz0, tx1, y + h, tz1, uv4, scaleRgb(slate, 1.15));
      trim.quad(x1, y, z0, x0, y, z0, tx0, y + h, tz0, tx1, y + h, tz0, uv4, slate);
      trim.quad(x0, y, z0, x0, y, z1, tx0, y + h, tz1, tx0, y + h, tz0, uv4, scaleRgb(slate, 1.15));
      // Ribs up the hips, and a lantern on top with the mast.
      trim.box(tx0, y + h, tz0, tx1, y + h + 1.2, tz1, { uv: W, color: metal });
      prism(trim, cx, cz, 0.3, 0.12, y + h + 1.2, y + h + lm.spire, 6, metal);
      break;
    }
    case 'crown': {
      // Sized to read on the skyline from the sea (about 0.9 m a pixel at 700 m): corner pylons, an open ring and fins.
      const fin = 1.3;
      const ht = 11;
      const i0 = 0.35;
      const rh = 1.8;
      const rd = 0.8;
      const mid = 0.6;
      for (const fx of [t.minX + i0, t.maxX - i0 - fin]) {
        for (const fz of [t.minZ + i0, t.maxZ - i0 - fin]) trim.box(fx, y, fz, fx + fin, y + ht, fz + fin, { uv: W, color: metal });
      }
      // The open ring at the top of the pylons, and mid-height fins along the long sides.
      const ry = y + ht - rh;
      trim.box(t.minX + i0, ry, t.minZ + i0, t.maxX - i0, ry + rh, t.minZ + i0 + rd, { uv: W, color: metal });
      trim.box(t.minX + i0, ry, t.maxZ - i0 - rd, t.maxX - i0, ry + rh, t.maxZ - i0, { uv: W, color: metal });
      trim.box(t.minX + i0, ry, t.minZ + i0 + rd, t.minX + i0 + rd, ry + rh, t.maxZ - i0 - rd, { uv: W, color: metal });
      trim.box(t.maxX - i0 - rd, ry, t.minZ + i0 + rd, t.maxX - i0, ry + rh, t.maxZ - i0 - rd, { uv: W, color: metal });
      const long = w >= d;
      for (let k = 1; k < 4; k++) {
        const a = long ? t.minX + (w * k) / 4 : t.minZ + (d * k) / 4;
        for (const side of [0, 1]) {
          if (long) {
            const z = side ? t.maxZ - i0 - mid : t.minZ + i0;
            trim.box(a - mid / 2, y, z, a + mid / 2, y + ht * 0.75, z + mid, { uv: W, color: metal });
          } else {
            const x = side ? t.maxX - i0 - mid : t.minX + i0;
            trim.box(x, y, a - mid / 2, x + mid, y + ht * 0.75, a + mid / 2, { uv: W, color: metal });
          }
        }
      }
      // Twin masts.
      const off = (long ? w : d) * 0.12;
      for (const s of [-1, 1]) {
        const mx = long ? cx + s * off : cx;
        const mz = long ? cz : cz + s * off;
        prism(trim, mx, mz, 0.6, 0.15, y, y + lm.spire * (s > 0 ? 1 : 0.8), 6, [0.85, 0.85, 0.86]);
      }
      break;
    }
    case 'wedge': {
      const h = 14;
      const i0 = 0.3;
      const x0 = t.minX + i0;
      const x1 = t.maxX - i0;
      const z0 = t.minZ + i0;
      const z1 = t.maxZ - i0;
      const uv4 = [0, 0, 1, 0, 1, 1, 0, 1];
      const uv3 = [0, 0, 1, 0, 0.5, 1];
      // A sloped glass roof rising from the south edge to a ridge over the north edge, with a mast on the ridge.
      if (w >= d) {
        trim.quad(x0, y, z1, x1, y, z1, x1, y + h, z0, x0, y + h, z0, uv4, slate);
        trim.quad(x1, y, z0, x0, y, z0, x0, y + h, z0, x1, y + h, z0, uv4, scaleRgb(slate, 1.2));
        trim.tri(x1, y, z1, x1, y, z0, x1, y + h, z0, uv3, scaleRgb(slate, 1.1));
        trim.tri(x0, y, z0, x0, y, z1, x0, y + h, z0, uv3, scaleRgb(slate, 1.1));
        trim.box(x0, y + h, z0, x1, y + h + 0.4, z0 + 0.4, { uv: W, color: metal });
      } else {
        trim.quad(x0, y, z0, x0, y, z1, x1, y + h, z1, x1, y + h, z0, uv4, slate);
        trim.quad(x1, y, z1, x1, y, z0, x1, y + h, z0, x1, y + h, z1, uv4, scaleRgb(slate, 1.2));
        trim.tri(x0, y, z1, x1, y, z1, x1, y + h, z1, uv3, scaleRgb(slate, 1.1));
        trim.tri(x1, y, z0, x0, y, z0, x1, y + h, z0, uv3, scaleRgb(slate, 1.1));
        trim.box(x1 - 0.4, y + h, z0, x1, y + h + 0.4, z1, { uv: W, color: metal });
      }
      const mx = w >= d ? cx : x1 - 0.2;
      const mz = w >= d ? z0 + 0.2 : cz;
      prism(trim, mx, mz, 0.25, 0.08, y + h + 0.4, y + h + 0.4 + lm.spire, 6, [0.85, 0.85, 0.86]);
      break;
    }
  }
}
