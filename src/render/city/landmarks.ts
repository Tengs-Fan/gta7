// Landmark towers: four of the tallest downtown towers with a flat roof get a crown of their own above the roof (visual only:
// footprints, heights and colliders stay those of the layout, and every addition stands inside the top tier's plan).

import { rectD, rectW, type Building, type CityLayout } from '../../world/layout';
import { scaleRgb, type GeoBuilder, type RGB, type UvMode } from '../geo';
import { facadeSeed } from '../textures';
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
      // The ridge at 92.5% of the 14 m slope, the blade 7 m over it, the mast on the blade.
      top = y + 14 * 0.925 + 7 + spire;
      width90 = 0.12;
      break;
  }
  return { id: b.id, kind, roof: y, top, spire, setbacks, taper90: width90 / base };
}

/**
 * Draws a landmark's crown: the stepped crown's tiers in the tower's own facade (`facade`, with its facade UVs so
 * the window grid carries on, each step's walls seeded with its roof and the building's `night` seed), everything else
 * in the trim batch.
 */
export function drawLandmark(facade: GeoBuilder, trim: GeoBuilder, b: Building, lm: Landmark, uv: UvMode, color: RGB, night: number): void {
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
  const gold: RGB = [0.78, 0.66, 0.38];
  // Dark steel for the open crown and the wedge's blade: in pale metal they melted into the hazy sky seen from the sea.
  const steel: RGB = [0.24, 0.26, 0.29];
  const uv4 = [0, 0, 1, 0, 1, 1, 0, 1];
  const uv3 = [0, 0, 1, 0, 0.5, 1];
  type V3 = [number, number, number];
  /**
   * A quad a, b, c, e wound to face direction `want` (the trim is single-sided), or a triangle where two of its corners
   * meet (the first step of the wedge's side walls): a quad's normal comes from its first three corners, which must not
   * coincide, or the face lights as NaN.
   */
  const faced = (a: V3, b2: V3, c: V3, e: V3, want: V3, col: RGB) => {
    const pts = [a, b2, c, e].filter((p, i, all) => all.findIndex((o) => Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]) < 1e-6) === i);
    const [p0, p1, p2] = pts as [V3, V3, V3];
    const n = [(p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1]), (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]), (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])];
    const ok = n[0]! * want[0] + n[1]! * want[1] + n[2]! * want[2] >= 0;
    if (pts.length === 3) trim.tri(...(ok ? p0 : p1), ...(ok ? p1 : p0), ...p2, uv3, col);
    else trim.quad(...(ok ? a : b2), ...(ok ? b2 : a), ...(ok ? c : e), ...(ok ? e : c), uv4, col);
  };
  /** A slender four-sided pinnacle on a small plinth, its foot at (px, py, pz). */
  const pinnacle = (px: number, py: number, pz: number, r: number, h: number, c: RGB) => {
    trim.box(px - r, py, pz - r, px + r, py + h * 0.25, pz + r, { uv: W, color: c });
    prism(trim, px, pz, r * 1.1, 0, py + h * 0.25, py + h, 4, c);
  };
  switch (lm.kind) {
    case 'stepped': {
      // An Art Deco crown: three setbacks in the tower's facade, each with a capping cornice, piers up the middle of
      // its faces and a pinnacle on each corner, then an octagonal lantern and a ringed spire.
      let y0 = y;
      STEPS.forEach((s, i) => {
        const hw = (w * s) / 2;
        const hd = (d * s) / 2;
        const h = STEP_H[i]!;
        facade.seed = facadeSeed(y0 + h, night);
        facade.box(cx - hw, y0, cz - hd, cx + hw, y0 + h, cz + hd, { uv, color, top: false });
        trim.box(cx - hw - 0.2, y0 + h - 0.3, cz - hd - 0.2, cx + hw + 0.2, y0 + h, cz + hd + 0.2, { uv: W, color: cap });
        // Two piers on each face, rising a little past the cornice.
        const pw = 0.35;
        for (const k of [-1, 1]) {
          const ax = cx + k * hw * 0.3;
          const az = cz + k * hd * 0.3;
          trim.box(ax - pw / 2, y0, cz - hd - 0.25, ax + pw / 2, y0 + h + 0.6, cz - hd + 0.05, { uv: W, color: cap });
          trim.box(ax - pw / 2, y0, cz + hd - 0.05, ax + pw / 2, y0 + h + 0.6, cz + hd + 0.25, { uv: W, color: cap });
          trim.box(cx - hw - 0.25, y0, az - pw / 2, cx - hw + 0.05, y0 + h + 0.6, az + pw / 2, { uv: W, color: cap });
          trim.box(cx + hw - 0.05, y0, az - pw / 2, cx + hw + 0.25, y0 + h + 0.6, az + pw / 2, { uv: W, color: cap });
        }
        // Corner pinnacles on the roof of this step, inside the next step's footprint's margin.
        const r = Math.min(0.55, Math.min(hw, hd) * 0.08);
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) pinnacle(cx + sx * (hw - r - 0.1), y0 + h, cz + sz * (hd - r - 0.1), r, 3.2 - i * 0.6, gold);
        y0 += h;
      });
      const r = Math.min(w, d) * 0.15;
      // The lantern: an octagonal drum with a gold band, a ribbed dome, then the spire with two rings.
      prism(trim, cx, cz, r, r, y0, y0 + 2.6, 8, metal);
      prism(trim, cx, cz, r * 1.08, r * 1.08, y0 + 2.6, y0 + 3.0, 8, gold);
      prism(trim, cx, cz, r * 1.02, r * 0.45, y0 + 3.0, y0 + 4.6, 8, metal);
      prism(trim, cx, cz, r * 0.45, 0, y0 + 4.6, y0 + lm.spire, 8, metal);
      for (const k of [0.35, 0.6]) {
        const ry = y0 + 4.6 + (lm.spire - 4.6) * k;
        const rr = r * 0.45 * (1 - k) + 0.12;
        prism(trim, cx, cz, rr, rr, ry, ry + 0.35, 8, gold);
      }
      break;
    }
    case 'pyramid': {
      const h = 18;
      const i0 = 0.3;
      // A hipped pyramid on a pierced parapet, its faces banded in glass and slate up to a lantern and a mast, with
      // ribs up its hips.
      const x0 = t.minX + i0;
      const x1 = t.maxX - i0;
      const z0 = t.minZ + i0;
      const z1 = t.maxZ - i0;
      const base = 1.6;
      // The parapet: posts round the roof, a rail over them.
      const step = 2.4;
      for (const [ax, az, bx, bz] of [[x0, z1, x1, z1], [x1, z1, x1, z0], [x1, z0, x0, z0], [x0, z0, x0, z1]] as const) {
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(2, Math.round(len / step));
        for (let k = 0; k < n; k++) {
          const px = ax + ((bx - ax) * k) / n;
          const pz = az + ((bz - az) * k) / n;
          trim.box(px - 0.2, y, pz - 0.2, px + 0.2, y + base, pz + 0.2, { uv: W, color: metal });
        }
      }
      trim.box(x0, y + base, z0, x1, y + base + 0.4, z1, { uv: W, color: metal });
      const yb = y + base + 0.4;
      const k = 0.22;
      const tx0 = cx - (w * k) / 2;
      const tx1 = cx + (w * k) / 2;
      const tz0 = cz - (d * k) / 2;
      const tz1 = cz + (d * k) / 2;
      const ph = h - base - 0.4;
      const bands = 7;
      const lerp = (a: number, b2: number, f: number) => a + (b2 - a) * f;
      for (let j = 0; j < bands; j++) {
        const f0 = j / bands;
        const f1 = (j + 1) / bands;
        const glass = j % 2 === 0;
        const c: RGB = glass ? [0.22, 0.32, 0.42] : slate;
        const X0 = (f: number) => lerp(x0, tx0, f);
        const X1 = (f: number) => lerp(x1, tx1, f);
        const Z0 = (f: number) => lerp(z0, tz0, f);
        const Z1 = (f: number) => lerp(z1, tz1, f);
        const Y = (f: number) => yb + ph * f;
        trim.quad(X0(f0), Y(f0), Z1(f0), X1(f0), Y(f0), Z1(f0), X1(f1), Y(f1), Z1(f1), X0(f1), Y(f1), Z1(f1), uv4, c);
        trim.quad(X1(f0), Y(f0), Z1(f0), X1(f0), Y(f0), Z0(f0), X1(f1), Y(f1), Z0(f1), X1(f1), Y(f1), Z1(f1), uv4, scaleRgb(c, 1.15));
        trim.quad(X1(f0), Y(f0), Z0(f0), X0(f0), Y(f0), Z0(f0), X0(f1), Y(f1), Z0(f1), X1(f1), Y(f1), Z0(f1), uv4, c);
        trim.quad(X0(f0), Y(f0), Z0(f0), X0(f0), Y(f0), Z1(f0), X0(f1), Y(f1), Z1(f1), X0(f1), Y(f1), Z0(f1), uv4, scaleRgb(c, 1.15));
      }
      // Hip ribs: a ridge of two narrow faces along each hip, standing 0.25 m off it.
      for (const [bx, bz, ex, ez] of [[x0, z1, tx0, tz1], [x1, z1, tx1, tz1], [x1, z0, tx1, tz0], [x0, z0, tx0, tz0]] as const) {
        const ox = Math.sign(bx - cx) * 0.25;
        const oz = Math.sign(bz - cz) * 0.25;
        // The rib's crest runs 0.2 m out from the hip, from (bx, yb, bz) to (ex, y + h, ez); its two faces fall from it
        // to either side, both facing out of the corner.
        const [rx, rz] = [ox * 0.8, oz * 0.8];
        faced([bx + rx, yb, bz + rz], [bx + ox, yb, bz - oz], [ex + ox * 0.5, y + h, ez - oz * 0.5], [ex + rx * 0.5, y + h, ez + rz * 0.5], [ox, 0.3, oz], metal);
        faced([bx + rx, yb, bz + rz], [bx - ox, yb, bz + oz], [ex - ox * 0.5, y + h, ez + oz * 0.5], [ex + rx * 0.5, y + h, ez + rz * 0.5], [ox, 0.3, oz], metal);
      }
      // The lantern: a glazed box under a small hipped cap, and the mast.
      trim.box(tx0, y + h, tz0, tx1, y + h + 2.2, tz1, { uv: W, color: [0.3, 0.42, 0.5] });
      trim.box(tx0 - 0.15, y + h + 2.2, tz0 - 0.15, tx1 + 0.15, y + h + 2.5, tz1 + 0.15, { uv: W, color: metal });
      prism(trim, cx, cz, Math.min(w, d) * k * 0.6, 0, y + h + 2.5, y + h + 4.5, 4, metal);
      prism(trim, cx, cz, 0.3, 0.1, y + h + 4.5, y + h + lm.spire, 6, metal);
      break;
    }
    case 'crown': {
      // Sized to read on the skyline from the sea (about 0.9 m a pixel at 700 m): corner pylons with pointed caps, two
      // open rings and fins rising towards the middle of each side, so the crown's outline peaks at its centre.
      const fin = 1.3;
      const ht = 11;
      const i0 = 0.35;
      const rh = 1.8;
      const rd = 0.8;
      const mid = 0.6;
      for (const fx of [t.minX + i0, t.maxX - i0 - fin]) {
        for (const fz of [t.minZ + i0, t.maxZ - i0 - fin]) {
          trim.box(fx, y, fz, fx + fin, y + ht, fz + fin, { uv: W, color: steel });
          prism(trim, fx + fin / 2, fz + fin / 2, fin * 0.72, 0, y + ht, y + ht + 3.5, 4, steel);
        }
      }
      const ring = (ry: number, hgt: number) => {
        trim.box(t.minX + i0, ry, t.minZ + i0, t.maxX - i0, ry + hgt, t.minZ + i0 + rd, { uv: W, color: steel });
        trim.box(t.minX + i0, ry, t.maxZ - i0 - rd, t.maxX - i0, ry + hgt, t.maxZ - i0, { uv: W, color: steel });
        trim.box(t.minX + i0, ry, t.minZ + i0 + rd, t.minX + i0 + rd, ry + hgt, t.maxZ - i0 - rd, { uv: W, color: steel });
        trim.box(t.maxX - i0 - rd, ry, t.minZ + i0 + rd, t.maxX - i0, ry + hgt, t.maxZ - i0 - rd, { uv: W, color: steel });
      };
      ring(y + ht - rh, rh);
      ring(y + ht * 0.4, rh * 0.6);
      // Fins up both pairs of sides, the middle ones tallest.
      for (const long of [true, false]) {
        const span = long ? w : d;
        const n = Math.max(3, Math.round(span / 3.2) | 1);
        for (let k = 1; k < n; k++) {
          const a = (long ? t.minX : t.minZ) + (span * k) / n;
          const peak = 1 - Math.abs(k / n - 0.5) * 2;
          const top = y + ht * (0.7 + 0.75 * peak);
          for (const side of [0, 1]) {
            if (long) {
              const z = side ? t.maxZ - i0 - mid : t.minZ + i0;
              trim.box(a - mid / 2, y, z, a + mid / 2, top, z + mid, { uv: W, color: steel });
            } else {
              const x = side ? t.maxX - i0 - mid : t.minX + i0;
              trim.box(x, y, a - mid / 2, x + mid, top, a + mid / 2, { uv: W, color: steel });
            }
          }
        }
      }
      // Twin masts.
      const long = w >= d;
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
      // A glass roof sloping up in four steps (a sloped pane and a short glass riser each) from the low edge to a ridge
      // over the high one, its sides walled in metal, a blade standing up from the ridge and a mast on the blade.
      const n = 4;
      const along = w >= d;
      // Local frame: p from the low edge (0) to the high one (L), q across.
      const L = along ? z1 - z0 : x1 - x0;
      const q0 = along ? x0 : z0;
      const q1 = along ? x1 : z1;
      const P = (p: number, q: number, yy: number): [number, number, number] => (along ? [q, yy, z1 - p] : [x0 + p, yy, q]);
      // Directions in the local frame: up the slope's outward side (towards the low edge, -p), across (q), up.
      const dirP = (sg: number): V3 => (along ? [0, 0, -sg] : [sg, 0, 0]);
      const dirQ = (sg: number): V3 => (along ? [sg, 0, 0] : [0, 0, sg]);
      const up = (v: V3, k: number): V3 => [v[0], k, v[2]];
      const rise = h / n;
      for (let k = 0; k < n; k++) {
        const pa = (L * k) / n;
        const pb = (L * (k + 1)) / n;
        const ya = y + rise * k;
        const yb = ya + rise * 0.7;
        // The sloped pane, then the riser at its back up to the next step.
        faced(P(pa, q1, ya), P(pa, q0, ya), P(pb, q0, yb), P(pb, q1, yb), up(dirP(-1), 1), slate);
        if (k < n - 1) faced(P(pb, q1, yb), P(pb, q0, yb), P(pb, q0, ya + rise), P(pb, q1, ya + rise), dirP(-1), scaleRgb(slate, 1.35));
        // The side walls under this step, at both ends of the slope.
        for (const [qq, sgn] of [[q0, -1], [q1, 1]] as const) faced(P(pa, qq, y), P(pb, qq, y), P(pb, qq, k < n - 1 ? ya + rise : yb), P(pa, qq, ya), dirQ(sgn), steel);
      }
      // The high end's wall, facing out.
      faced(P(L, q0, y), P(L, q1, y), P(L, q1, y + h * 0.925), P(L, q0, y + h * 0.925), dirP(1), scaleRgb(slate, 1.2));
      // The blade: a thin wall up from the ridge, tapering towards one end.
      const bq = (q0 + q1) / 2;
      const bl = (q1 - q0) * 0.35;
      const yr = y + h * 0.925;
      const bt = 0.3;
      for (const s of [-1, 1]) {
        const pp = L - 0.3 + s * bt;
        const tip = P(pp, bq + bl, yr + 7);
        faced(P(pp, bq - bl, yr), P(pp, bq + bl, yr), tip, tip, dirP(s), steel);
      }
      // The blade's tall end and its sloped edge.
      faced(P(L - 0.3 - bt, bq + bl, yr), P(L - 0.3 + bt, bq + bl, yr), P(L - 0.3 + bt, bq + bl, yr + 7), P(L - 0.3 - bt, bq + bl, yr + 7), dirQ(1), steel);
      faced(P(L - 0.3 - bt, bq - bl, yr), P(L - 0.3 + bt, bq - bl, yr), P(L - 0.3 + bt, bq + bl, yr + 7), P(L - 0.3 - bt, bq + bl, yr + 7), up(dirQ(-1), 0.4), steel);
      const [mx, , mz] = P(L - 0.3, bq + bl, 0);
      prism(trim, mx, mz, 0.25, 0.08, yr + 7, yr + 7 + lm.spire, 6, [0.85, 0.85, 0.86]);
      break;
    }
  }
}
