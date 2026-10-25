// Rooftop dressing: HVAC units, stair housings, water tanks, vents, antennas and roof gardens on the flat roofs,
// merged into the city's trim batches (no mesh of their own). Placement is a pure function of the building, so
// tests can check every item against its roof; the layout's own roof props (drawn by the props view) are avoided.

import { Rng } from '../../core/rng';
import { CURB_H } from '../../world/constants';
import { hashInts, rectD, rectW, type Building, type Tier } from '../../world/layout';
import type { GeoBuilder, RGB } from '../geo';
import { FACADE_CELL } from '../textures';

export type RooftopKind = 'hvac' | 'stair' | 'tank' | 'vent' | 'antenna' | 'garden';

export interface RooftopItem {
  kind: RooftopKind;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** The roof height it stands on, and its top. */
  y0: number;
  y1: number;
  /** 0..1, per item, for its colour and details. */
  seed: number;
}

/** Parapet round every flat roof: its height above the roof and its thickness (thinner on narrow roofs). */
export const PARAPET_H = 0.6;
export function parapetThickness(t: Tier): number {
  return Math.min(0.3, Math.min(rectW(t), rectD(t)) / 8);
}
/** Clearance of rooftop items from the inside face of the parapet (m). */
export const ROOF_ITEM_CLEARANCE = 0.3;

/** Storeys of a building: its height over the storey height of its facade style. */
export function storeys(b: Building): number {
  return Math.max(1, Math.floor((b.height - CURB_H) / FACADE_CELL[b.style].h + 0.15));
}

const KIND_WEIGHTS: Record<string, Array<[RooftopKind, number]>> = {
  tower: [['hvac', 4], ['stair', 2], ['vent', 2], ['antenna', 1], ['tank', 1]],
  brick: [['tank', 3], ['stair', 2], ['vent', 2], ['hvac', 2]],
  homey: [['garden', 3], ['hvac', 2], ['tank', 2], ['vent', 1], ['stair', 1]],
  industrial: [['vent', 3], ['hvac', 3], ['tank', 1]],
};

function family(b: Building): keyof typeof KIND_WEIGHTS {
  if (b.style === 'brick') return 'brick';
  if (b.style === 'stucco' || b.style === 'hotel' || b.style === 'house') return 'homey';
  if (b.style === 'warehouse') return 'industrial';
  return 'tower';
}

function pick(rng: Rng, weights: Array<[RooftopKind, number]>): RooftopKind {
  const total = weights.reduce((s, w) => s + w[1], 0);
  let r = rng.next() * total;
  for (const [k, w] of weights) {
    r -= w;
    if (r <= 0) return k;
  }
  return weights[0]![0];
}

/** Footprint (w, d) and height of an item of a kind. */
function sizeOf(kind: RooftopKind, rng: Rng): [number, number, number] {
  switch (kind) {
    case 'hvac':
      return [rng.range(1.6, 3.2), rng.range(1.2, 2.0), rng.range(1.0, 1.6)];
    case 'stair': {
      const s = rng.range(2.6, 3.6);
      return [s, rng.range(2.6, 3.4), rng.range(2.6, 3.2)];
    }
    case 'tank': {
      const r = rng.range(1.7, 2.6);
      return [r, r, rng.range(2.8, 3.8)];
    }
    case 'vent':
      return [rng.range(0.8, 1.6), rng.range(0.6, 1.2), rng.range(0.7, 1.2)];
    case 'antenna':
      return [0.9, 0.9, rng.range(4, 7.5)];
    case 'garden':
      return [rng.range(2.4, 5), rng.range(1.0, 1.6), 1.1];
  }
}

/** The rooftop items of a building (none on pitched roofs, landmarks or roofs too small to stand on). */
export function rooftopItems(b: Building, landmark = false): RooftopItem[] {
  if (b.roof === 'gable' || landmark || b.tiers.length === 0) return [];
  const t = b.tiers[b.tiers.length - 1]!;
  const inset = parapetThickness(t) + ROOF_ITEM_CLEARANCE;
  const minX = t.minX + inset;
  const maxX = t.maxX - inset;
  const minZ = t.minZ + inset;
  const maxZ = t.maxZ - inset;
  if (maxX - minX < 1.2 || maxZ - minZ < 1.2) return [];
  const rng = new Rng(hashInts(b.id, 0x700f));
  const area = (maxX - minX) * (maxZ - minZ);
  const want = Math.max(1, Math.min(6, 1 + Math.floor(area / 160)));
  // The layout's roof props stand on the top roof too: keep clear of them (and of a helipad's whole pad).
  const blocked = b.roofProps.filter((p) => Math.abs(p.y - t.y1) < 0.5).map((p) => {
    const h = Math.max(p.w, p.d) / 2 + (p.kind === 'helipad' ? 1.5 : 0.4);
    return { minX: p.x - h, maxX: p.x + h, minZ: p.z - h, maxZ: p.z + h };
  });
  const out: RooftopItem[] = [];
  const weights = KIND_WEIGHTS[family(b)]!;
  for (let attempt = 0; attempt < want * 8 && out.length < want; attempt++) {
    let kind = pick(rng, weights);
    if (kind === 'stair' && (out.some((o) => o.kind === 'stair') || storeys(b) < 4)) kind = 'hvac';
    let [w, d, h] = sizeOf(kind, rng);
    if (rng.chance(0.5)) [w, d] = [d, w];
    w = Math.min(w, maxX - minX);
    d = Math.min(d, maxZ - minZ);
    const x0 = minX + rng.next() * (maxX - minX - w);
    const z0 = minZ + rng.next() * (maxZ - minZ - d);
    const box = { minX: x0, maxX: x0 + w, minZ: z0, maxZ: z0 + d };
    const hit = (o: { minX: number; maxX: number; minZ: number; maxZ: number }) => box.minX < o.maxX + 0.4 && box.maxX > o.minX - 0.4 && box.minZ < o.maxZ + 0.4 && box.maxZ > o.minZ - 0.4;
    if (blocked.some(hit) || out.some(hit)) continue;
    out.push({ kind, ...box, y0: t.y1, y1: t.y1 + h, seed: rng.next() });
  }
  return out;
}

const UVW = { kind: 'world' as const, scale: 3 };

function boxC(g: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: RGB): void {
  g.box(x0, y0, z0, x1, y1, z1, { uv: UVW, color: c });
}

/** A vertical n-sided prism (or a cone when r1 is 0) round (cx, cz). */
export function prism(g: GeoBuilder, cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, n: number, c: RGB, cap = true): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const b = ((i + 1) / n) * Math.PI * 2;
    const ax = Math.cos(a);
    const az = Math.sin(a);
    const bx = Math.cos(b);
    const bz = Math.sin(b);
    // Counter-clockwise seen from outside: walk the circle clockwise from above.
    if (r1 > 1e-4) g.quad(cx + bx * r0, y0, cz + bz * r0, cx + ax * r0, y0, cz + az * r0, cx + ax * r1, y1, cz + az * r1, cx + bx * r1, y1, cz + bz * r1, [0, 0, 1, 0, 1, 1, 0, 1], c);
    else g.tri(cx + bx * r0, y0, cz + bz * r0, cx + ax * r0, y0, cz + az * r0, cx, y1, cz, [0, 0, 1, 0, 0.5, 1], c);
    if (cap && r1 > 1e-4) g.tri(cx, y1, cz, cx + bx * r1, y1, cz + bz * r1, cx + ax * r1, y1, cz + az * r1, [0.5, 0.5, 1, 0, 0, 1], c);
  }
}

export function drawRooftopItem(g: GeoBuilder, it: RooftopItem): void {
  const s = it.seed;
  const grey: RGB = [0.6 + s * 0.12, 0.61 + s * 0.12, 0.62 + s * 0.1];
  const dark: RGB = [0.12, 0.13, 0.14];
  const w = it.maxX - it.minX;
  const d = it.maxZ - it.minZ;
  const cx = (it.minX + it.maxX) / 2;
  const cz = (it.minZ + it.maxZ) / 2;
  const y = it.y0;
  const h = it.y1 - it.y0;
  switch (it.kind) {
    case 'hvac': {
      boxC(g, it.minX, y, it.minZ, it.maxX, y + 0.15, it.maxZ, [0.35, 0.36, 0.37]);
      boxC(g, it.minX + 0.05, y + 0.15, it.minZ + 0.05, it.maxX - 0.05, it.y1, it.maxZ - 0.05, grey);
      // Fan grilles on top.
      const fans = w > d ? Math.max(1, Math.floor(w / 1.1)) : Math.max(1, Math.floor(d / 1.1));
      const r = Math.min(w > d ? w / fans : d / fans, w > d ? d : w) * 0.36;
      for (let k = 0; k < fans; k++) {
        const fx = w > d ? it.minX + (w * (k + 0.5)) / fans : cx;
        const fz = w > d ? cz : it.minZ + (d * (k + 0.5)) / fans;
        prism(g, fx, fz, r, r, it.y1, it.y1 + 0.06, 10, dark);
      }
      break;
    }
    case 'stair': {
      boxC(g, it.minX, y, it.minZ, it.maxX, it.y1, it.maxZ, [0.66 + s * 0.08, 0.64 + s * 0.08, 0.6 + s * 0.06]);
      boxC(g, it.minX - 0.08, it.y1, it.minZ - 0.08, it.maxX + 0.08, it.y1 + 0.18, it.maxZ + 0.08, [0.4, 0.4, 0.41]);
      // A steel door on the long side facing +z, standing just proud of the wall.
      const dw = Math.min(1, w * 0.4);
      g.quad(cx - dw / 2, y + 0.05, it.maxZ + 0.02, cx + dw / 2, y + 0.05, it.maxZ + 0.02, cx + dw / 2, y + 2.1, it.maxZ + 0.02, cx - dw / 2, y + 2.1, it.maxZ + 0.02, [0, 0, 1, 0, 1, 1, 0, 1], [0.22, 0.26, 0.3]);
      boxC(g, it.maxX - 0.5, it.y1 + 0.18, it.minZ + 0.3, it.maxX - 0.2, it.y1 + 0.6, it.minZ + 0.6, dark);
      break;
    }
    case 'tank': {
      const r = Math.min(w, d) / 2 - 0.05;
      const legs = Math.min(1.1, h * 0.3);
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const px = cx + lx * r * 0.62;
        const pz = cz + lz * r * 0.62;
        boxC(g, px - 0.07, y, pz - 0.07, px + 0.07, y + legs, pz + 0.07, [0.3, 0.3, 0.31]);
      }
      const wood: RGB = s > 0.5 ? [0.46, 0.34, 0.24] : [0.58, 0.6, 0.62];
      prism(g, cx, cz, r, r, y + legs, it.y1 - r * 0.45, 10, wood);
      prism(g, cx, cz, r * 1.04, 0, it.y1 - r * 0.45, it.y1, 10, s > 0.5 ? [0.3, 0.24, 0.2] : [0.45, 0.47, 0.5]);
      break;
    }
    case 'vent': {
      const n = 2 + Math.floor(s * 2.99);
      for (let k = 0; k < n; k++) {
        const fx = it.minX + (w * (k + 0.5)) / n;
        const hh = h * (0.6 + 0.4 * ((k * 0.37 + s) % 1));
        prism(g, fx, cz, Math.min(0.18, w / n / 2.5), Math.min(0.18, w / n / 2.5), y, y + hh, 6, [0.55, 0.56, 0.57]);
        prism(g, fx, cz, Math.min(0.3, w / n / 2), 0, y + hh, y + hh + 0.18, 6, [0.4, 0.41, 0.42]);
      }
      break;
    }
    case 'antenna': {
      boxC(g, cx - 0.35, y, cz - 0.35, cx + 0.35, y + 0.3, cz + 0.35, [0.4, 0.4, 0.42]);
      boxC(g, cx - 0.06, y + 0.3, cz - 0.06, cx + 0.06, it.y1, cz + 0.06, [0.75, 0.75, 0.76]);
      for (const k of [0.55, 0.8]) boxC(g, cx - 0.4, y + h * k, cz - 0.03, cx + 0.4, y + h * k + 0.06, cz + 0.03, [0.7, 0.7, 0.72]);
      break;
    }
    case 'garden': {
      const n = Math.max(1, Math.round(Math.max(w, d) / 1.4));
      const along = w > d;
      for (let k = 0; k < n; k++) {
        const a0 = (along ? it.minX : it.minZ) + ((along ? w : d) * k) / n + 0.05;
        const a1 = (along ? it.minX : it.minZ) + ((along ? w : d) * (k + 1)) / n - 0.05;
        const [x0, x1, z0, z1] = along ? [a0, a1, it.minZ, it.maxZ] : [it.minX, it.maxX, a0, a1];
        boxC(g, x0, y, z0, x1, y + 0.45, z1, [0.45, 0.36, 0.28]);
        const green: RGB = [0.16 + ((k * 0.31 + s) % 1) * 0.1, 0.36 + ((k * 0.17 + s) % 1) * 0.12, 0.14];
        boxC(g, x0 + 0.08, y + 0.45, z0 + 0.08, x1 - 0.08, it.y1, z1 - 0.08, green);
      }
      break;
    }
  }
}
