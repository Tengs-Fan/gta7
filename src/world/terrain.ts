// The city's rises: Hillcrest Green's hill and Azura Point's bluff, the only ground higher than a curb apart from the
// decks and ramps. They stand only where nothing assumes flat ground (no road, sidewalk, walk node outside the Azura
// Point path, or building footprint), so the lane graph, traffic and the AI keep their flat world. Pure data and
// queries, no rendering: settleTerrain lays the rises into the layout last and lifts the props onto them, StaticWorld
// adds them to baseGround and buries sight cores in them, and the renderers draw the ground, the cliffs and the sign.

import { CURB_H } from './constants';
import type { CityLayout, Rect } from './layout';

export interface Rise {
  name: string;
  /** 'bell': an elliptical cosine bell, flat on its plateau; 'climb': a slope northward (towards -z) only, flat beyond. */
  kind: 'bell' | 'climb';
  /** Bell: its centre. Climb: the middle of its width, and the z its foot runs along. */
  cx: number;
  cz: number;
  /** Bell: its semi-axes (m). Climb: half its width, and the run (m) north of its foot over which it climbs. */
  rx: number;
  rz: number;
  /** Bell: the plateau's radius along x (m; along z it scales with rz). Climb: the flat beyond the run (m). */
  plateau: number;
  /** Highest it reaches above the curb (m). */
  height: number;
  /** Where it can be above 0. */
  bounds: Rect;
  /** Climb: the land it covers (a headland's rects), 0 off it. A bell covers its whole ellipse (none listed). */
  within: Rect[];
}

/** Hillcrest Green's hill, on the park's fountain: 20% at its steepest across x, 17% along z, 0 a good 7 m inside the lot. */
const HILL = { name: 'Hillcrest Green', rx: 68, rz: 78, plateau: 14, height: 7 } as const;
/**
 * Azura Point's bluff: from the promenade up to 10 m over 72 m (a smoothstep, 20.8% at its steepest, with no
 * cross-slope), flat out to the tip.
 */
const BLUFF = { name: 'Azura Point', run: 72, height: 10 } as const;

/** The sight cores: one box per CORE_STEP m of rise from 1 m up, buried CORE_COVER m deep and inset CORE_INSET m. */
const CORE_STEP = 2;
export const CORE_COVER = 0.5;
/**
 * How far (m) a core keeps inside the contour it is buried under: farther than any body, free-space check or camera that
 * tests a collider's height band against the ground under its own centre reaches from that centre (a bus's half
 * diagonal is 6.1 m), so whatever comes over a core stands on its cover.
 */
export const CORE_INSET = 6.5;

/** Height (m above the curb) of the rises at (x, z). Hot: baseGround calls it, so each rise's bounds reject first. */
export function riseAt(rises: readonly Rise[], x: number, z: number): number {
  let h = 0;
  for (let i = 0; i < rises.length; i++) {
    const r = rises[i]!;
    const b = r.bounds;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    h += r.kind === 'bell' ? bellAt(r, x, z) : climbAt(r, x, z);
  }
  return h;
}

function bellAt(r: Rise, x: number, z: number): number {
  const s = Math.hypot((x - r.cx) / r.rx, (z - r.cz) / r.rz);
  const p = r.plateau / r.rx;
  if (s <= p) return r.height;
  if (s >= 1) return 0;
  return (r.height * (1 + Math.cos((Math.PI * (s - p)) / (1 - p)))) / 2;
}

/** Hillcrest Green's hill among the rises. */
export function hillRise(rises: readonly Rise[]): Rise {
  return rises.find((r) => r.name === HILL.name)!;
}

function climbAt(r: Rise, x: number, z: number): number {
  if (!r.within.some((q) => inRect(q, x, z))) return 0;
  const t = Math.min(1, Math.max(0, (r.cz - z) / r.rz));
  return r.height * t * t * (3 - 2 * t);
}

/** Azura Point's bluff among the rises. */
export function bluffRise(rises: readonly Rise[]): Rise {
  return rises.find((r) => r.name === BLUFF.name)!;
}

export function riseBounds(r: Rise): Rect {
  return r.bounds;
}

/** The highest any rise reaches (m above the curb) over the box x0..x1, z0..z1, by bounds: 0 where none comes. */
export function riseTop(rises: readonly Rise[], x0: number, z0: number, x1: number, z1: number): number {
  let top = 0;
  for (const r of rises) {
    const b = r.bounds;
    if (b.minX <= x1 && b.maxX >= x0 && b.minZ <= z1 && b.maxZ >= z0) top = Math.max(top, r.height);
  }
  return top;
}

/** The hill on Hillcrest Green's fountain and the bluff over Azura Point, from the layout as generateCity built it. */
export function cityRises(layout: CityLayout): Rise[] {
  const park = layout.blocks.find((b) => b.zone === HILL.name)!;
  const cx = (park.lot.minX + park.lot.maxX) / 2;
  const cz = (park.lot.minZ + park.lot.maxZ) / 2;
  const hill: Rise = {
    ...HILL,
    kind: 'bell',
    cx,
    cz,
    bounds: { minX: cx - HILL.rx, minZ: cz - HILL.rz, maxX: cx + HILL.rx, maxZ: cz + HILL.rz },
    within: [],
  };
  // The bluff climbs from the promenade's edge (the headland's south side) over its whole width.
  const point = layout.headlands.find((h) => h.name === BLUFF.name)!;
  const bounds = {
    minX: Math.min(...point.rects.map((q) => q.minX)),
    minZ: Math.min(...point.rects.map((q) => q.minZ)),
    maxX: Math.max(...point.rects.map((q) => q.maxX)),
    maxZ: Math.max(...point.rects.map((q) => q.maxZ)),
  };
  const bluff: Rise = {
    name: BLUFF.name,
    kind: 'climb',
    cx: (bounds.minX + bounds.maxX) / 2,
    cz: bounds.maxZ,
    rx: (bounds.maxX - bounds.minX) / 2,
    rz: BLUFF.run,
    plateau: bounds.maxZ - BLUFF.run - bounds.minZ,
    height: BLUFF.height,
    bounds,
    within: point.rects.map((q) => ({ ...q })),
  };
  return [hill, bluff];
}

/**
 * Lays the rises into the layout and stands every prop on them, after everything else is placed: it draws no random
 * number and moves nothing across the ground, so pickups and mission spots stay where they were. Only the trees and
 * bushes on the lawn the SAN AZURA letters stand on, and down the slope in front of them, go: the sign has to be
 * seen from the street, and a trunk must not stand in a letter.
 */
export function settleTerrain(layout: CityLayout): void {
  layout.rises = cityRises(layout);
  const lawn = signLawn(layout);
  layout.props = layout.props.filter((p) => !((p.kind === 'tree' || p.kind === 'bush') && inRect(lawn, p.x, p.z)));
  for (const p of layout.props) p.y += riseAt(layout.rises, p.x, p.z);
}

function inRect(r: Rect, x: number, z: number): boolean {
  return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
}

// ---------------------------------------------------------------------------
// Sight cores

/** A box buried in a rise, solid for sight (bullets, the camera, line of sight), from y -1 up to y1. */
export interface Core extends Rect {
  y1: number;
}

/**
 * Nested boxes buried in each rise, one every CORE_STEP m of rise from 1 m up: each the axis rectangle inscribed in
 * the contour where the rise stands CORE_COVER over its top, inset CORE_INSET. So no body, camera or free-space check
 * standing on the rise ever meets one (they ignore colliders below their feet, see CORE_INSET), while a line of sight
 * across the hill below its crest, a bullet or a blast stops inside it.
 */
export function terrainCores(rises: readonly Rise[]): Core[] {
  const out: Core[] = [];
  for (const r of rises) {
    for (let k = 1; k + CORE_COVER <= r.height; k += CORE_STEP) {
      const c = k + CORE_COVER;
      if (r.kind === 'bell') {
        // The bell is c high on the ellipse s = sc; the rectangle inscribed in an ellipse has half extents a / sqrt 2.
        const p = r.plateau / r.rx;
        const sc = p + ((1 - p) * Math.acos((2 * c) / r.height - 1)) / Math.PI;
        const hx = (sc * r.rx) / Math.SQRT2 - CORE_INSET;
        const hz = (sc * r.rz) / Math.SQRT2 - CORE_INSET;
        out.push({ minX: r.cx - hx, minZ: r.cz - hz, maxX: r.cx + hx, maxZ: r.cz + hz, y1: CURB_H + k });
      } else {
        // North of zc the climb stands over c (smoothstep inverted), across the narrowest land it spans there.
        const zc = r.cz - r.rz * (0.5 - Math.sin(Math.asin(1 - (2 * c) / r.height) / 3));
        const minZ = Math.min(...r.within.map((q) => q.minZ));
        const over = r.within.filter((q) => q.minZ < zc && q.maxZ > minZ);
        out.push({
          minX: Math.max(...over.map((q) => q.minX)) + CORE_INSET,
          minZ: minZ + CORE_INSET,
          maxX: Math.min(...over.map((q) => q.maxX)) - CORE_INSET,
          maxZ: zc - CORE_INSET,
          y1: CURB_H + k,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The SAN AZURA letters

/** A glyph's stroke in its letter's frame (x across from -w/2, y up from its buried foot; the ground is at y 1). */
export type Stroke = readonly [x0: number, y0: number, x1: number, y1: number] | { readonly d: readonly [xa: number, ya: number, xb: number, yb: number] };

/** Stroke width (m) of the block letters. A diagonal runs on a fifth of it past either end, into the bars it joins. */
export const STROKE_T = 1;
const T = STROKE_T;
/**
 * Block glyphs on the 4.4 m by 7 m letter (6 m out of the ground): bars and posts from the foot, diagonals as `d`.
 * render/city/hillSign.ts draws them, and a leaning letter's colliders follow them (SignLetter.solids).
 */
export const GLYPHS: Readonly<Record<string, readonly Stroke[]>> = {
  S: [[-2.2, 6, 2.2, 7], [-2.2, 3.5, -2.2 + T, 7], [-2.2, 3.5, 2.2, 4.5], [2.2 - T, 0, 2.2, 4.5], [-2.2, 0, 2.2, 2]],
  A: [{ d: [-1.75, 1, -0.45, 7] }, { d: [1.75, 1, 0.45, 7] }, [-1, 6, 1, 7], [-1.3, 2.6, 1.3, 3.6], [-2.3, 0, -1.1, 1.4], [1.1, 0, 2.3, 1.4]],
  N: [[-2.2, 0, -2.2 + T, 7], [2.2 - T, 0, 2.2, 7], { d: [-1.5, 6.6, 1.5, 1.4] }],
  Z: [[-2.2, 6, 2.2, 7], [-2.2, 0, 2.2, 2], { d: [1.5, 6.3, -1.5, 1.7] }],
  U: [[-2.2, 0, -2.2 + T, 7], [2.2 - T, 0, 2.2, 7], [-2.2, 0, 2.2, 2]],
  R: [[-2.2, 0, -2.2 + T, 7], [-2.2, 6, 1.4, 7], [2.2 - T, 4, 2.2, 6.6], [-2.2, 3.5, 1.4, 4.5], { d: [-0.1, 3.8, 1.75, 1.2] }, [1.1, 0, 2.3, 1.4]],
};

/** A stroke's four corners in its letter's frame, as hillSign.ts draws it, in order round it. */
export function strokeCorners(s: Stroke): Array<[number, number]> {
  if (!('d' in s)) {
    const [x0, y0, x1, y1] = s;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
  const [xa, ya, xb, yb] = s.d;
  const len = Math.hypot(xb - xa, yb - ya);
  const ux = (xb - xa) / len;
  const uy = (yb - ya) / len;
  const hl = len / 2 + T * 0.2;
  const cx = (xa + xb) / 2;
  const cy = (ya + yb) / 2;
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([a, b]): [number, number] => [cx + a * hl * ux - (b * T * uy) / 2, cy + a * hl * uy + (b * T * ux) / 2]);
}

/** An axis box in the world, for a collider. */
export type SignBox = Rect & { y0: number; y1: number };

/** One block letter of the hill sign, facing south: its glyph, footprint centre, width and depth, base and height. */
export interface SignLetter {
  char: string;
  x: number;
  z: number;
  w: number;
  d: number;
  /** Its foot, buried 1 m under the ground at its centre, and its height from there (6 m stand out of the ground). */
  y0: number;
  h: number;
  /** Lean about its depth axis (rad, positive towards +x), pivoting on the middle of its foot. */
  tilt: number;
  /** The world box round it (the dressing keeps clear of it). */
  box: SignBox;
  /**
   * Its colliders: standing, the box itself; leaning, a box round its strokes in each SIGN.band m of height, so no
   * invisible wall stands under its overhang or in the open air over its low side.
   */
  solids: SignBox[];
}

/**
 * The sign as laid out on the hill: its line of letters `dz` m south of the summit, each `w` wide, `gap` apart, the
 * words split either side of the old cross path running north-south up the slope (`path` m wide, kept clear) so it
 * still climbs to the fountain, and the last A slumped on its side.
 */
const SIGN = { words: ['SAN', 'AZURA'], dz: 41, w: 4.4, h: 7, d: 1, gap: 1.2, path: 6, sink: 1, slump: (25 * Math.PI) / 180, band: 1 } as const;

export function hillSignLetters(rises: readonly Rise[]): SignLetter[] {
  const hill = hillRise(rises);
  const z = hill.cz + SIGN.dz;
  const span = (n: number) => n * SIGN.w + (n - 1) * SIGN.gap;
  const out: SignLetter[] = [];
  const place = (word: string, x0: number, last: boolean) => {
    [...word].forEach((char, i) => {
      const x = x0 + i * (SIGN.w + SIGN.gap) + SIGN.w / 2;
      const tilt = last && i === word.length - 1 ? SIGN.slump : 0;
      const y0 = CURB_H + riseAt(rises, x, z) - SIGN.sink;
      // A point of the letter's frame in the world's x and y, leaning round the middle of its foot.
      const cos = Math.cos(tilt);
      const sin = Math.sin(tilt);
      const at = (u: number, v: number): [number, number] => [x + u * cos + v * sin, y0 - u * sin + v * cos];
      const corners = [-1, 1].flatMap((u) => [0, SIGN.h].map((v) => at((u * SIGN.w) / 2, v)));
      const box = {
        minX: Math.min(...corners.map((c) => c[0])),
        maxX: Math.max(...corners.map((c) => c[0])),
        minZ: z - SIGN.d / 2,
        maxZ: z + SIGN.d / 2,
        y0: Math.min(...corners.map((c) => c[1])),
        y1: Math.max(...corners.map((c) => c[1])),
      };
      const solids = tilt === 0 ? [box] : bandBoxes(GLYPHS[char]!.map((s) => strokeCorners(s).map(([u, v]) => at(u, v))), z);
      out.push({ char, x, z, w: SIGN.w, d: SIGN.d, y0, h: SIGN.h, tilt, box, solids });
    });
  };
  const [west, east] = SIGN.words;
  place(west, hill.cx - SIGN.path / 2 - span(west.length), false);
  place(east, hill.cx + SIGN.path / 2, true);
  return out;
}

/**
 * Boxes round convex quads (strokes, as corners in the world's x and y) lying in the plane z, one per SIGN.band m of
 * height or less: each spans what of any quad its slice of height holds.
 */
function bandBoxes(quads: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, z: number): SignBox[] {
  const ys = quads.flatMap((q) => q.map((c) => c[1]));
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const n = Math.ceil((hi - lo) / SIGN.band);
  const out: SignBox[] = [];
  for (let k = 0; k < n; k++) {
    const y0 = lo + ((hi - lo) * k) / n;
    const y1 = lo + ((hi - lo) * (k + 1)) / n;
    let minX = Infinity;
    let maxX = -Infinity;
    const take = (x: number) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    };
    for (const q of quads) {
      q.forEach(([px, py], i) => {
        const [rx, ry] = q[(i + 1) % q.length]!;
        if (py >= y0 && py <= y1) take(px);
        for (const y of [y0, y1]) if ((py - y) * (ry - y) < 0) take(px + ((rx - px) * (y - py)) / (ry - py));
      });
    }
    out.push({ minX, maxX, minZ: z - SIGN.d / 2, maxZ: z + SIGN.d / 2, y0, y1 });
  }
  return out;
}

/** The lawn the sign stands on, clear of trees from 3 m behind the letters down to the park's south edge. */
function signLawn(layout: CityLayout): Rect {
  const letters = hillSignLetters(layout.rises);
  const park = layout.blocks.find((b) => b.zone === HILL.name)!;
  return {
    minX: Math.min(...letters.map((l) => l.box.minX)) - 3,
    minZ: letters[0]!.box.minZ - 3,
    maxX: Math.max(...letters.map((l) => l.box.maxX)) + 3,
    maxZ: park.lot.maxZ,
  };
}

// ---------------------------------------------------------------------------
// The lookout

/** Thickness (m) of the lookout's parapet: as the bridges' (and PARAPET_H high, as theirs). */
const LOOKOUT_RAIL_T = 0.35;
/** Length (m) of the railed terrace along the cliff edge in front of the lighthouse. */
const LOOKOUT_SPAN = 24;

/**
 * The parapet of the lookout terrace at Azura Point's tip: along the cliff edge in front of the lighthouse, standing on
 * the plateau (y). The rest of the edge stays open to drive off.
 */
export function lookoutRail(layout: CityLayout): Rect & { y: number } {
  const lighthouse = layout.props.find((p) => p.kind === 'lighthouse')!;
  const tip = layout.headlands.find((h) => h.name === BLUFF.name)!.rects.reduce((a, q) => (q.minZ < a.minZ ? q : a));
  return { minX: lighthouse.x - LOOKOUT_SPAN / 2, minZ: tip.minZ, maxX: lighthouse.x + LOOKOUT_SPAN / 2, maxZ: tip.minZ + LOOKOUT_RAIL_T, y: lighthouse.y };
}
