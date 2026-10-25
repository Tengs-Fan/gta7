// The fireball of a blast: a cluster of volume puffs whose sizes, heat and opacity are pure functions of their age and
// of a presentation seed (never sim.rng), so the same seed always gives the same fireball. The cluster blooms to its
// full size within FIREBALL_GROW (+ the last lobe's delay), burns white-yellow to orange, cools into dark smoke that
// rises, and is gone by FIREBALL_LIFE; the smoke column and the wreck fire carry on as simulated puffs.

import { hash01 } from './noise';

/** Seconds for a lobe to reach full size, and the latest a lobe starts after the blast. */
export const FIREBALL_GROW = 0.28;
export const FIREBALL_DELAY = 0.08;
/** No fireball puff is left after this (s). */
export const FIREBALL_LIFE = 1.85;
/** Fireball radius (m) per metre of blast radius: a car (7.5 m) burns about 3.4 m round. */
export const FIREBALL_SCALE = 0.45;

export interface FireballLobe {
  /** Offset direction (unit) and how far out it ends, in fireball radii. */
  dx: number;
  dy: number;
  dz: number;
  dist: number;
  delay: number;
  /** Quad size in fireball radii. */
  size: number;
  /** Seconds to cool from its peak heat to smoke. */
  cool: number;
  /** Peak heat (the core lobes burn hotter). */
  hot: number;
  /** When it has faded out (s). */
  end: number;
  rot: number;
  spin: number;
  seed: number;
  /** Smoke albedo once cool (linear grey). */
  grey: number;
}

/** Fills `out` with `n` lobes for `seed` (deterministic; reuses the objects in `out`). */
export function fireballLobes(seed: number, n: number, out: FireballLobe[] = []): FireballLobe[] {
  out.length = n;
  const h = (i: number, k: number) => hash01(seed * 131 + i * 17 + k * 7 + 1);
  for (let i = 0; i < n; i++) {
    // Lobes spread over a dome: mostly sideways and up, a few low ones rolling along the ground.
    const az = h(i, 0) * Math.PI * 2 + i * 2.39996;
    const el = -0.15 + h(i, 1) * 1.15;
    const ce = Math.cos(el);
    const core = i < 3;
    const l = out[i] ?? ({} as FireballLobe);
    l.dx = Math.cos(az) * ce;
    l.dy = Math.sin(el);
    l.dz = Math.sin(az) * ce;
    l.dist = core ? 0.1 + h(i, 2) * 0.2 : 0.35 + h(i, 2) * 0.4;
    l.delay = core ? 0 : h(i, 3) * FIREBALL_DELAY;
    l.size = core ? 0.95 + h(i, 4) * 0.25 : 0.6 + h(i, 4) * 0.35;
    l.cool = 0.55 + h(i, 5) * 0.45;
    l.hot = core ? 0.95 : 0.72 + h(i, 6) * 0.22;
    l.end = FIREBALL_LIFE - 0.35 + h(i, 7) * 0.35;
    l.rot = h(i, 8) * Math.PI * 2;
    l.spin = (h(i, 9) - 0.5) * 1.2;
    l.seed = h(i, 10);
    l.grey = 0.05 + h(i, 11) * 0.04;
    out[i] = l;
  }
  return out;
}

export interface LobeState {
  /** Offset from the blast point (m). */
  x: number;
  y: number;
  z: number;
  size: number;
  heat: number;
  alpha: number;
  rot: number;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);

/** A lobe of a fireball of radius `R` (m) at `age` seconds after the blast. */
export function lobeAt(l: FireballLobe, R: number, age: number, out: LobeState): LobeState {
  const a = Math.max(0, age - l.delay);
  const grow = easeOut(Math.min(1, a / FIREBALL_GROW));
  const started = age >= l.delay ? 1 : 0;
  const reach = l.dist * R * (0.35 + 0.65 * grow);
  // The whole ball rises, faster as it cools (buoyant), the outer lobes a little less.
  const rise = R * (0.22 * age + 0.32 * age * age) * (1 - 0.25 * l.dist);
  out.x = l.dx * reach;
  out.y = l.dy * reach * 0.8 + rise;
  out.z = l.dz * reach;
  out.size = started * l.size * R * (0.3 + 0.7 * grow) * (1 + 0.04 * a);
  const c = Math.max(0, 1 - a / l.cool);
  out.heat = started * l.hot * c * Math.sqrt(c);
  const fadeIn = Math.min(1, a / 0.04 + (l.delay === 0 ? 0.6 : 0));
  const fadeOut = Math.max(0, Math.min(1, (l.end - age) / 0.55));
  out.alpha = started * Math.min(1, fadeIn) * fadeOut * 0.95;
  out.rot = l.rot + l.spin * age;
  return out;
}

/**
 * The fireball's look over time, summed over its lobes: `area` (sum of size^2 x opacity, m^2), `glow` (the same weighted
 * by heat) and `lobes` drawn. For tests and the docs; the view uses lobeAt directly.
 */
export function fireballProfile(seed: number, radius: number, n: number, age: number): { area: number; glow: number; lobes: number } {
  const lobes = fireballLobes(seed, n);
  const R = radius * FIREBALL_SCALE;
  const s: LobeState = { x: 0, y: 0, z: 0, size: 0, heat: 0, alpha: 0, rot: 0 };
  let area = 0;
  let glow = 0;
  let count = 0;
  for (const l of lobes) {
    lobeAt(l, R, age, s);
    if (s.alpha <= 0.002 || s.size <= 0) continue;
    count++;
    area += s.size * s.size * s.alpha;
    glow += s.size * s.size * s.alpha * s.heat;
  }
  return { area, glow, lobes: count };
}
