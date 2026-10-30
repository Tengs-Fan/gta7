// The city's rises: Hillcrest Green's hill, the only ground higher than a curb apart from the decks and ramps. It
// stands only where nothing assumes flat ground (no road, sidewalk, walk node or building footprint), so the lane
// graph, traffic and the AI keep their flat world. Pure data and queries, no rendering: settleTerrain lays the rises
// into the layout last and lifts the props onto them, StaticWorld adds them to baseGround and buries sight cores in
// them, and the renderers draw the ground and the sign.

import { CURB_H } from './constants';
import type { CityLayout, Rect } from './layout';

export interface Rise {
  name: string;
  /** 'bell': an elliptical cosine bell, flat on its plateau. */
  kind: 'bell';
  /** Its centre. */
  cx: number;
  cz: number;
  /** Its semi-axes (m). */
  rx: number;
  rz: number;
  /** The plateau's radius along x (m; along z it scales with rz). */
  plateau: number;
  /** Highest it reaches above the curb (m). */
  height: number;
  /** Where it can be above 0. */
  bounds: Rect;
}

/** Hillcrest Green's hill, on the park's fountain: 20% at its steepest across x, 17% along z, 0 a good 7 m inside the lot. */
const HILL = { name: 'Hillcrest Green', rx: 68, rz: 78, plateau: 14, height: 7 } as const;

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
    h += bellAt(r, x, z);
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

/** The hill on Hillcrest Green's fountain, from the layout as generateCity built it. */
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
  };
  return [hill];
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
      // The bell is c high on the ellipse s = sc; the rectangle inscribed in an ellipse has half extents a / sqrt 2.
      const c = k + CORE_COVER;
      const p = r.plateau / r.rx;
      const sc = p + ((1 - p) * Math.acos((2 * c) / r.height - 1)) / Math.PI;
      const hx = (sc * r.rx) / Math.SQRT2 - CORE_INSET;
      const hz = (sc * r.rz) / Math.SQRT2 - CORE_INSET;
      out.push({ minX: r.cx - hx, minZ: r.cz - hz, maxX: r.cx + hx, maxZ: r.cz + hz, y1: CURB_H + k });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The SAN AZURA letters

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
  /** The world box round it, for its collider. */
  box: Rect & { y0: number; y1: number };
}

/**
 * The sign as laid out on the hill: its line of letters `dz` m south of the summit, each `w` wide, `gap` apart, the
 * words split either side of the old cross path running north-south up the slope (`path` m wide, kept clear) so it
 * still climbs to the fountain, and the last A slumped on its side.
 */
const SIGN = { words: ['SAN', 'AZURA'], dz: 41, w: 4.4, h: 7, d: 1, gap: 1.2, path: 6, sink: 1, slump: (25 * Math.PI) / 180 } as const;

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
      // The corners of the leaning letter round the middle of its foot.
      const cos = Math.cos(tilt);
      const sin = Math.sin(tilt);
      const xs = [-1, 1].flatMap((u) => [0, SIGN.h].map((v) => (u * SIGN.w) / 2 * cos + v * sin));
      const ys = [-1, 1].flatMap((u) => [0, SIGN.h].map((v) => -(u * SIGN.w) / 2 * sin + v * cos));
      out.push({
        char,
        x,
        z,
        w: SIGN.w,
        d: SIGN.d,
        y0,
        h: SIGN.h,
        tilt,
        box: { minX: x + Math.min(...xs), maxX: x + Math.max(...xs), minZ: z - SIGN.d / 2, maxZ: z + SIGN.d / 2, y0: y0 + Math.min(...ys), y1: y0 + Math.max(...ys) },
      });
    });
  };
  const [west, east] = SIGN.words;
  place(west, hill.cx - SIGN.path / 2 - span(west.length), false);
  place(east, hill.cx + SIGN.path / 2, true);
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
