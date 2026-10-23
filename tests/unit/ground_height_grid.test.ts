// StaticWorld.groundHeight looks only at the decks and ramps in a grid cell round the point (track D, VAL-PERF2-007).
// It must return exactly what the old scan over every deck and ramp returned, kept here as the reference.

import { describe, expect, it } from 'vitest';
import { WATER_Y } from '../../src/world/constants';
import { rectContains } from '../../src/world/layout';
import { rampHeight, StaticWorld } from '../../src/world/staticWorld';

const W = new StaticWorld();

/** The pre-grid implementation: every deck and every ramp, per call. */
function scanGroundHeight(w: StaticWorld, x: number, z: number): number {
  let h = w.baseGround(x, z);
  const decks = w.layout.decks;
  for (let i = 0; i < decks.length; i++) {
    const d = decks[i]!;
    if (d.y > h && rectContains(d.rect, x, z)) h = d.y;
  }
  const ramps = w.layout.ramps;
  for (let i = 0; i < ramps.length; i++) {
    const rh = rampHeight(ramps[i]!, x, z);
    if (rh > 0) {
      const top = w.baseGround(x, z) + rh;
      if (top > h) h = top;
    }
  }
  return h;
}

/** Deterministic points: mulberry32. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function testPoints(): Float64Array {
  const r = rng(7);
  const pts: number[] = [];
  const b = W.layout.bounds;
  for (let i = 0; i < 200_000; i++) pts.push(b.worldMinX + r() * (b.worldMaxX - b.worldMinX), b.worldMinZ + r() * (b.worldMaxZ - b.worldMinZ));
  const near = (x: number, z: number): void => {
    for (let k = 0; k < 12; k++) pts.push(x + (r() - 0.5) * 0.1, z + (r() - 0.5) * 0.1);
    pts.push(x, z);
  };
  for (const d of W.layout.decks) {
    const q = d.rect;
    for (const [x, z] of [[q.minX, q.minZ], [q.maxX, q.minZ], [q.minX, q.maxZ], [q.maxX, q.maxZ]] as const) near(x, z);
    for (let k = 0; k <= 40; k++) {
      const t = k / 40;
      near(q.minX + (q.maxX - q.minX) * t, q.minZ);
      near(q.minX + (q.maxX - q.minX) * t, q.maxZ);
      near(q.minX, q.minZ + (q.maxZ - q.minZ) * t);
      near(q.maxX, q.minZ + (q.maxZ - q.minZ) * t);
    }
  }
  for (const p of W.layout.ramps) {
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    // Along (fx, fz) and across (fz, -fx), as rampHeight measures them.
    const at = (a: number, s: number): [number, number] => [p.x + fx * a + fz * s, p.z + fz * a - fx * s];
    const L = p.length / 2;
    const S = p.width / 2;
    for (const [a, s] of [[-L, -S], [L, -S], [-L, S], [L, S]] as const) near(...at(a, s));
    for (let k = 0; k <= 40; k++) {
      const t = k / 40;
      near(...at(-L + 2 * L * t, -S));
      near(...at(-L + 2 * L * t, S));
      near(...at(-L, -S + 2 * S * t));
      near(...at(L, -S + 2 * S * t));
    }
    // On the slope.
    for (let k = 0; k < 400; k++) pts.push(...at((r() * 2 - 1) * L, (r() * 2 - 1) * S));
  }
  return Float64Array.from(pts);
}

describe('groundHeight grid', () => {
  it('returns exactly the old full scan over the map, at every deck and ramp edge and corner, and on the slopes', () => {
    const pts = testPoints();
    let mismatches = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i]!;
      const z = pts[i + 1]!;
      if (W.groundHeight(x, z) !== scanGroundHeight(W, x, z)) mismatches++;
    }
    console.log(`groundHeight grid: ${pts.length / 2} points compared, ${mismatches} mismatches (${W.layout.decks.length} decks, ${W.layout.ramps.length} ramps)`);
    expect(pts.length / 2).toBeGreaterThanOrEqual(200_000);
    expect(mismatches).toBe(0);
    // Off the map and non-finite input behave as before.
    for (const [x, z] of [[1e6, 0], [-1e6, -1e6], [NaN, 0], [0, Infinity]] as const) expect(Object.is(W.groundHeight(x, z), scanGroundHeight(W, x, z))).toBe(true);
  });

  it('waterDepth follows groundHeight', () => {
    const pts = testPoints();
    let mismatches = 0;
    for (let i = 0; i < pts.length; i += 2) if (W.waterDepth(pts[i]!, pts[i + 1]!) !== WATER_Y - scanGroundHeight(W, pts[i]!, pts[i + 1]!)) mismatches++;
    expect(mismatches).toBe(0);
  });

  it('is at least twice as fast as the scan over a million random points (median of 5)', () => {
    const r = rng(11);
    const b = W.layout.bounds;
    const n = 1_000_000;
    const xs = new Float64Array(n);
    const zs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = b.worldMinX + r() * (b.worldMaxX - b.worldMinX);
      zs[i] = b.worldMinZ + r() * (b.worldMaxZ - b.worldMinZ);
    }
    const time = (f: (x: number, z: number) => number): number => {
      let sink = 0;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) sink += f(xs[i]!, zs[i]!);
      const t = performance.now() - t0;
      expect(Number.isFinite(sink)).toBe(true);
      return t;
    };
    const grid = (x: number, z: number): number => W.groundHeight(x, z);
    const scan = (x: number, z: number): number => scanGroundHeight(W, x, z);
    time(grid);
    time(scan);
    const median = (a: number[]): number => a.sort((p, q) => p - q)[2]!;
    const g: number[] = [];
    const s: number[] = [];
    for (let k = 0; k < 5; k++) {
      s.push(time(scan));
      g.push(time(grid));
    }
    const mg = median(g);
    const ms = median(s);
    console.log(`groundHeight 1e6 calls: scan ${ms.toFixed(1)} ms, grid ${mg.toFixed(1)} ms, ${(ms / mg).toFixed(2)}x`);
    expect(ms / mg).toBeGreaterThanOrEqual(2);
  });
});
