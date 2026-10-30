// The shore: every stretch where land meets the sea along the land rectangle's west, north and south edges, round the
// water cut into it and round the headlands, and the rocky foreshore along the open stretches. Shared by the coast's
// walls and boulders (render/city/coast.ts) and the map, so both draw the same ragged line.

import { Rng } from '../core/rng';
import { WATER_Y } from './constants';
import { hashInts, rectContains, type Rect } from './layout';
import type { StaticWorld } from './staticWorld';

/** A stretch of shore from (x0, z0) to (x1, z1), the water on the side of (nx, nz). */
export interface Shore {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  nx: number;
  nz: number;
  /** A plain quay (the harbour basin, the canal): no foreshore. */
  built: boolean;
  /** Round a headland: a wider, heavier foreshore. */
  headland: boolean;
}

/** The foreshore's band beyond the wall (m): its width wanders between these along the shore. */
export const FORESHORE_REACH = [2, 11] as const;
export const HEADLAND_REACH = [4, 16] as const;
/** Metres between the band width's lattice points along a shore. */
const REACH_WAVE = 28;

export function shores(world: StaticWorld): Shore[] {
  const layout = world.layout;
  const b = layout.bounds;
  const land = (x: number, z: number) => world.baseGround(x, z) > WATER_Y;
  const built: Rect[] = layout.water.filter((w) => w.name === 'Port Basin' || w.name === 'Cortez Canal').flatMap((w) => w.area);
  const headlands = layout.headlands.flatMap((h) => h.rects);
  const near = (rs: Rect[], x: number, z: number) => rs.some((r) => rectContains(r, x, z, 1));
  const rects = [...layout.water.flatMap((w) => w.rects), ...headlands];
  const edges: Array<{ vertical: boolean; at: number; t0: number; t1: number }> = [
    { vertical: true, at: b.landMinX, t0: b.landMinZ, t1: b.landMaxZ },
    { vertical: false, at: b.landMinZ, t0: b.landMinX, t1: b.beachStartX },
    { vertical: false, at: b.landMaxZ, t0: b.landMinX, t1: b.beachStartX },
  ];
  for (const r of rects) {
    edges.push({ vertical: true, at: r.minX, t0: r.minZ, t1: r.maxZ }, { vertical: true, at: r.maxX, t0: r.minZ, t1: r.maxZ });
    edges.push({ vertical: false, at: r.minZ, t0: r.minX, t1: r.maxX }, { vertical: false, at: r.maxZ, t0: r.minX, t1: r.maxX });
  }
  // Land and water can only change hands at a rectangle's edge: split every edge there.
  const xs = [b.landMinX, b.beachStartX, ...rects.flatMap((r) => [r.minX, r.maxX])];
  const zs = [b.landMinZ, b.landMaxZ, ...rects.flatMap((r) => [r.minZ, r.maxZ])];
  const done = new Set<string>();
  const out: Shore[] = [];
  for (const e of edges) {
    const cuts = [e.t0, e.t1, ...(e.vertical ? zs : xs).filter((t) => t > e.t0 && t < e.t1)].sort((p, q) => p - q);
    for (let k = 1; k < cuts.length; k++) {
      const t0 = cuts[k - 1]!;
      const t1 = cuts[k]!;
      const key = `${e.vertical ? 'x' : 'z'}${e.at.toFixed(2)}:${t0.toFixed(2)}`;
      if (t1 - t0 < 0.01 || done.has(key)) continue;
      const m = (t0 + t1) / 2;
      const before = e.vertical ? land(e.at - 0.3, m) : land(m, e.at - 0.3);
      const after = e.vertical ? land(e.at + 0.3, m) : land(m, e.at + 0.3);
      if (before === after) continue;
      done.add(key);
      const n = before ? 1 : -1;
      const s = e.vertical ? { x0: e.at, z0: t0, x1: e.at, z1: t1, nx: n, nz: 0 } : { x0: t0, z0: e.at, x1: t1, z1: e.at, nx: 0, nz: n };
      const mx = (s.x0 + s.x1) / 2;
      const mz = (s.z0 + s.z1) / 2;
      out.push({ ...s, built: near(built, mx + s.nx, mz + s.nz), headland: near(headlands, mx - s.nx, mz - s.nz) });
    }
  }
  return out;
}

/**
 * The foreshore's width (m beyond the wall) `d` m along shore `s`: smoothly between seeded lattice values, squared so
 * wide rocky fingers are rare. The same for the boulders and the map.
 */
export function foreshoreReach(s: Shore): (d: number) => number {
  const len = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
  const rng = new Rng(hashInts(Math.round(s.x0), Math.round(s.z0), Math.round(s.x1), Math.round(s.z1)));
  const lattice = Array.from({ length: Math.ceil(len / REACH_WAVE) + 2 }, () => rng.next() ** 2);
  const [lo, hi] = s.headland ? HEADLAND_REACH : FORESHORE_REACH;
  return (d) => {
    const f = d / REACH_WAVE;
    const i = Math.floor(f);
    const u = f - i;
    const w = u * u * (3 - 2 * u);
    return lo + (hi - lo) * (lattice[i]! * (1 - w) + lattice[i + 1]! * w);
  };
}
