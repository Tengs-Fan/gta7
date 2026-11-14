// The grass verges in front of the house lots: where they lie, from the layout alone (no three.js), for the ground's
// lawn mesh, the tree grates that keep out of them and the tyres' sound on soft ground.

import { CROSSWALK_W, SIDEWALK_W } from '../../world/constants';
import { mkRect, type CityLayout, type Rect } from '../../world/layout';

export type Rect4 = [number, number, number, number];

/** Width (m) of the kerbstone band along the kerb edge of every sidewalk. */
export const KERBSTONE_W = 0.3;
/** Lawns spill this far (m) onto the paving where they meet a sidewalk; the shader frays the strip. */
export const LAWN_OVERHANG = 0.18;

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

