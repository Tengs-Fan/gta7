// The sea's analytic waves: eight Gerstner waves, a long swell rolling in from the open sea to the east and the wind's
// chop on it, shared by the sea's vertex displacement (High and Medium), its per-pixel normals and crests (every
// hardware tier), the software sea (the two longest) and everything that rides on it (foam rings, boat wakes, boats,
// swimmers, buoys). The shelter map (render/seaShelter.ts) calms them in the harbours and along the quays, and over the
// beaches they shoal: the open sea's waves fade into breakers that roll in along the depth's contours, in step with the
// surf's foam bands.
// Free of three.js: the GLSL is plain strings and the CPU twin is used by the views and tests. Visual only: the sim's
// sea stays flat at WATER_Y.

import { BEACH_W, CURB_H, SAND_DROP, SEABED_Y, WATER_Y } from '../world/constants';

export interface Wave {
  /** Wavelength (m). */
  length: number;
  /** Direction of travel, degrees from onshore (-x, towards the east beach), turning towards +z. */
  angle: number;
  /** Height (m, crest over the mean) at sea state 1, a storm (waveAmps scales it to the sea state). */
  amp: number;
  /** Gerstner's steepness: how far (times the height) the water moves sideways, sharpening the crests. */
  steep: number;
  /** Phase at time 0 (rad). */
  phase0: number;
  /**
   * On High, vertex displacement fades out between these distances (m, along the larger axis from the sea grid's
   * centre), before the grid's cells grow too coarse to sample the wave (SEA_GRIDS holds the fades of each tier).
   */
  fadeStart: number;
  fadeEnd: number;
}

/**
 * The swell (the first four, within 21 degrees of onshore, the onshore one first and the longest next) and the wind's
 * chop (the last four). Significant heights (four times the standard deviation of the surface) of 1.1 m at calm's
 * sea state of 0.3 and 2.7 m in a storm; the crests reach at most 0.85 and 2.3 m over the mean.
 */
export const WAVES: readonly Wave[] = [
  { length: 72, angle: 0, amp: 0.62, steep: 1, phase0: 0, fadeStart: 640, fadeEnd: 790 },
  { length: 94, angle: -13, amp: 0.38, steep: 1, phase0: 2.3, fadeStart: 640, fadeEnd: 790 },
  { length: 57, angle: 9, amp: 0.4, steep: 1, phase0: 4.4, fadeStart: 380, fadeEnd: 470 },
  { length: 44, angle: 21, amp: 0.24, steep: 1, phase0: 1.1, fadeStart: 380, fadeEnd: 470 },
  { length: 33, angle: -30, amp: 0.3, steep: 2, phase0: 0.6, fadeStart: 300, fadeEnd: 390 },
  { length: 17.3, angle: 27, amp: 0.18, steep: 2, phase0: 1.7, fadeStart: 150, fadeEnd: 235 },
  { length: 9.1, angle: -38, amp: 0.1, steep: 2, phase0: 4.1, fadeStart: 50, fadeEnd: 74 },
  { length: 4.3, angle: 58, amp: 0.05, steep: 2, phase0: 2.6, fadeStart: 40, fadeEnd: 70 },
];
/** The first SWELL of WAVES are the swell, the rest the chop. */
export const SWELL = 4;
/**
 * At sea state s the swell stands at SWELL_BASE + (1 - SWELL_BASE) s of its storm height (the open sea's swell comes from
 * far off and is there on a still day), the chop at s^CHOP_POWER of its own (next to none on a still day).
 */
export const SWELL_BASE = 0.22;
export const CHOP_POWER = 1.5;

/**
 * The shading normals tilt this many times more than the waves' own slopes, the swell's and the breakers' (first) more
 * than the chop's: a swell a metre high on a wave 70 m long tilts the water by little more than a degree, which the
 * ripples would hide.
 * Less on the displaced grid (High and Medium), whose shape shows the swell too, than on the flat plane (Low), where
 * only the light can.
 */
export const NORMAL_GAIN = { grid: [2.6, 1.4], flat: [3.4, 2.2] } as const;
/** A ring of the sea grid: square cells of `cell` m out to a half-width of `extent` m round its centre. */
export interface SeaRing {
  readonly cell: number;
  readonly extent: number;
}

/**
 * The wave grid on High: rings of square cells round its centre, each cell doubling as the cells shrink under a pixel
 * with distance (1 m cells to FINE_EXTENT, 16 m by COARSE_EXTENT), then a flat skirt to SKIRT_EXTENT. Every wave fades
 * out before the cells grow past a quarter of its length.
 */
export const SEA_RINGS: readonly SeaRing[] = [
  { cell: 1, extent: 80 },
  { cell: 4, extent: 240 },
  { cell: 8, extent: 480 },
  { cell: 16, extent: 800 },
];
export const FINE_EXTENT = SEA_RINGS[0]!.extent;
export const COARSE_EXTENT = SEA_RINGS[SEA_RINGS.length - 1]!.extent;
export const SKIRT_EXTENT = 3000;
/** The grid moves in whole steps of its largest cell, so every ring's vertices stay on a fixed world lattice. */
export const SEA_SNAP = SEA_RINGS[SEA_RINGS.length - 1]!.cell;
/** The grid's cell size (m) at `c` m (along the larger axis) from its centre. */
export function seaCellAt(c: number): number {
  return (SEA_RINGS.find((r) => c <= r.extent) ?? SEA_RINGS[SEA_RINGS.length - 1]!).cell;
}

/**
 * A tier's wave grid: its rings, the step it moves in (its largest cell), and the distances (m, from the grid's centre
 * along the larger axis) between which each wave's vertex displacement fades out, to nothing (-1 to 0) for a wave its
 * cells cannot sample. The drawn surface, and with it the CPU twin (SeaSurface), follows these.
 */
export interface SeaGridSpec {
  readonly rings: readonly SeaRing[];
  readonly snap: number;
  /** Whether the sea's shading leaves out what the water cannot show where it is deep (the surf past SURF_REACH, the quays' foam far from a quay). */
  readonly skip: boolean;
  readonly fadeStart: readonly number[];
  readonly fadeEnd: readonly number[];
}

export type SeaGridName = 'fine' | 'coarse';

/**
 * The two wave grids (TierSpec.waterRings). The fine one is High's. The coarse one, Medium's, has a tenth of the vertices
 * and shorter rings: an integrated GPU shades a pixel once for every triangle its samples touch, and with the fine one's
 * cells under a pixel tall from a low camera past some 40 m (a 4 m cell at 240 m is a fifth of a pixel) it ran the whole
 * sea shader three to four times over per pixel. Its cells stay a few pixels tall as far as the eye reaches into the
 * swell, and only the waves it can sample (four vertices a wavelength) displace: the 9 and 4 m chop only shade.
 */
export const SEA_GRIDS: Readonly<Record<SeaGridName, SeaGridSpec>> = {
  fine: { rings: SEA_RINGS, snap: SEA_SNAP, skip: false, fadeStart: WAVES.map((w) => w.fadeStart), fadeEnd: WAVES.map((w) => w.fadeEnd) },
  coarse: {
    rings: [
      { cell: 4, extent: 64 },
      { cell: 8, extent: 128 },
    ],
    snap: 8,
    skip: true,
    fadeStart: [90, 90, 90, 90, 90, 40, -1, -1],
    fadeEnd: [124, 124, 124, 124, 124, 62, 0, 0],
  },
};

/** Sea state with no weather (calm). */
export const CALM_SEA = 0.3;
/**
 * Each wave's slope in the shading fades out as its phase moves from the first to the second of these (rad) across a
 * pixel, before it shrinks under three pixels a wave and shimmers; what it loses goes into the roughness.
 */
export const WAVE_PHASE_PX = [1.2, 2.4] as const;

/**
 * The shoaling over a beach. The open sea's waves are capped at SURF_GAMMA times the depth (a wave breaks once it is
 * about 0.8 times the depth from trough to crest), and fade out between SURF_DEPTH[1] and SURF_DEPTH[0] m deep into the
 * breakers (on a gently shelving beach, SURF_SHELVE): the first SURF_WAVES swell waves, each slowing as the water
 * shallows (its phase grows as the root of the depth, SURF_S, so the crests bunch up shoreward), keeping its wavenumber
 * along the beach (SURF_KZ) and in step with its own swell wave where the beach is SURF_SYNC_DEPTH m deep, so a swell
 * crest rolls on into a breaker. Summed by their heights (SURF_W) they beat into sets and lulls about a minute apart.
 * Their height is SURF_SHOAL times the open sea's significant half-height (it grows as it shoals) until the depth caps
 * it, steepened (SURF_Q). They feel the sand's depth with render-only bars and rip channels along the beach (surfDepth),
 * so they break first over a bar and late or not at all in a rip.
 */
export const SURF_GAMMA = 0.4;
export const SURF_DEPTH = [1.4, 2.0] as const;
export const SURF_SHOAL = 1.3;
export const SURF_Q = 2.4;
/**
 * Breakers roll in only where the seabed shelves gently, fading out as its slope (the depth's gradient) steepens from the
 * first of these to the second: the east beach's sand falls 1 in 34; Las Lomas County's shores, 1 in 5, and the quays'
 * walls get none (their breakers would be a stripe a few metres long).
 */
export const SURF_SHELVE = [0.05, 0.1] as const;
export const SURF_SYNC_DEPTH = 1.7;
/** How many of the swell waves (the first, onshore, ones) break on the beach. */
export const SURF_WAVES = 3;
/**
 * The bars and rips: the breakers feel the sand's depth times 1 + SURF_BAR surfBar(z), the bars fading out between these
 * depths (m) so the breakers keep in step with the swell where they take over from it.
 */
export const SURF_BAR = 0.3;
export const SURF_BAR_FADE = [1.1, 1.6] as const;
/** The swash runs up the sand this long (rad of each breaker's phase, about 1.4 s) after a breaker reaches the waterline. */
export const SWASH_DELAY = 1.4;
/**
 * Deeper than this (m) nothing of the surf can show, whatever the set: the breakers fade out by SURF_DEPTH[1], a set
 * breaks no deeper than that, its roller, lip and the rearing of its face end within 1.7 times that (seaSurfFoam,
 * seaSurfFace), and the swash and the wash end shallower. A tier that asks for it (SeaGridSpec.skip) leaves the surf's
 * terms out there, which costs the water nothing it would have shown.
 */
export const SURF_REACH = 3.5;

/**
 * The sea's shelter and depth on a square lattice over the world (render/seaShelter.ts bakes it; the shaders sample it
 * as a texture): per point the share of the open sea's waves that reach it (0 in a harbour or at a quay, 1 offshore),
 * the drawn water's depth (m, negative on land) and that depth's gradient along x and z. Point (i, j) is centred on
 * (minX + (i + 0.5) cell, minZ + (j + 0.5) cell), four values per point, rows along +x going +z. Past its edge the sea
 * is as at the edge, open and deep.
 */
export interface ShelterMap {
  minX: number;
  minZ: number;
  cell: number;
  nx: number;
  nz: number;
  data: Float32Array;
}

/** The open sea where there is no map: unsheltered, and as deep as the sim's seabed. */
export const OPEN_SEA: readonly number[] = [1, WATER_Y - SEABED_Y, 0, 0];

/** CPU twin of the shaders' seaShelterAt: the map sampled bilinearly at (x, z), clamped at its edge, into `out`. */
export function shelterAt(m: ShelterMap | null, x: number, z: number, out: number[] = [0, 0, 0, 0]): number[] {
  if (!m) {
    for (let c = 0; c < 4; c++) out[c] = OPEN_SEA[c]!;
    return out;
  }
  const u = Math.min(m.nx - 1, Math.max(0, (x - m.minX) / m.cell - 0.5));
  const v = Math.min(m.nz - 1, Math.max(0, (z - m.minZ) / m.cell - 0.5));
  const i = Math.min(Math.floor(u), m.nx - 2);
  const j = Math.min(Math.floor(v), m.nz - 2);
  const tu = u - i;
  const tv = v - j;
  const d = m.data;
  const k = (j * m.nx + i) * 4;
  const k2 = k + m.nx * 4;
  for (let c = 0; c < 4; c++) out[c] = (d[k + c]! * (1 - tu) + d[k + 4 + c]! * tu) * (1 - tv) + (d[k2 + c]! * (1 - tu) + d[k2 + 4 + c]! * tu) * tv;
  return out;
}

const G = 9.81;
const TAU = Math.PI * 2;

export const WAVE_K: readonly number[] = WAVES.map((w) => TAU / w.length);
/** Deep-water dispersion: omega = sqrt(g k). */
export const WAVE_OMEGA: readonly number[] = WAVE_K.map((k) => Math.sqrt(G * k));
/** Unit direction of travel in XZ. */
export const WAVE_DIR: readonly (readonly [number, number])[] = WAVES.map((w) => {
  const a = (w.angle * Math.PI) / 180;
  return [-Math.cos(a), Math.sin(a)] as const;
});
/**
 * Each breaker's phase per root metre of depth: in shallow water a wave runs at sqrt(g d), so over the east beach's even
 * slope m its phase grows as 2 omega sqrt(d) / (m sqrt(g)): crests some 28 m apart where they break and 10 m at the swash.
 */
export const SURF_S: readonly number[] = WAVE_OMEGA.slice(0, SURF_WAVES).map((w) => (2 * w) / ((SAND_DROP / BEACH_W) * Math.sqrt(G)));
/** Each breaker's wavenumber along the beach (+z): its swell wave's, which refraction keeps (Snell). */
export const SURF_KZ: readonly number[] = WAVE_K.slice(0, SURF_WAVES).map((k, i) => k * WAVE_DIR[i]![1]);
/** Each breaker's share of the surf's height: its swell wave's share of their heights. */
export const SURF_W: readonly number[] = WAVES.slice(0, SURF_WAVES).map((w, _, a) => w.amp / a.reduce((t, v) => t + v.amp, 0));

/** Each wave's height (m) at sea state `sea` (0..1): SWELL_BASE, CHOP_POWER. */
export function waveAmps(sea: number, out: number[] = new Array<number>(WAVES.length).fill(0)): number[] {
  const s = Math.min(1, Math.max(0, sea));
  const swell = SWELL_BASE + (1 - SWELL_BASE) * s;
  const chop = Math.pow(s, CHOP_POWER);
  for (let i = 0; i < WAVES.length; i++) out[i] = WAVES[i]!.amp * (i < SWELL ? swell : chop);
  return out;
}

/** Half the open sea's significant height (m) for the waves' heights `amps` (waveAmps): twice the surface's deviation. */
export function seaHalfHeight(amps: readonly number[]): number {
  let v = 0;
  for (const a of amps) v += (a * a) / 2;
  return 2 * Math.sqrt(v);
}

/**
 * Each wave's time phase, wrapped to [0, 2 pi) here in double precision: the shaders get them as uniforms, so the
 * waves never stutter after hours of play the way omega * t in float32 would.
 */
export function wavePhases(time: number, out: number[] = new Array<number>(WAVES.length).fill(0)): number[] {
  for (let i = 0; i < WAVES.length; i++) {
    const p = (WAVE_OMEGA[i]! * time + WAVES[i]!.phase0) % TAU;
    out[i] = p < 0 ? p + TAU : p;
  }
  return out;
}

/**
 * The breakers' phases at the waterline at z = 0 (SeaSurface.surf, the shaders' uSurfPhase) for the swell's phases
 * `phases` (wavePhases) and the east beach's start (Bounds.beachStartX): where the beach is SURF_SYNC_DEPTH m deep each
 * breaker's crest is where its swell wave's would be. Breaker i's phase at depth d is SURF_S[i] sqrt(d) - SURF_KZ[i] z
 * plus this.
 */
export function surfPhases(phases: readonly number[], beachStartX: number, out: number[] = new Array<number>(SURF_WAVES).fill(0)): number[] {
  const x = beachStartX + (BEACH_W * (SURF_SYNC_DEPTH + CURB_H - WATER_Y)) / SAND_DROP;
  for (let i = 0; i < SURF_WAVES; i++) {
    // The breaker's height is sin(S sqrt(d) - kz z + surf), the swell's sin(k (dx x + dz z) - phase): equal where
    // sin(pi - a) = sin(a), the z terms cancelling.
    const p = (Math.PI - WAVE_K[i]! * WAVE_DIR[i]![0] * x - SURF_S[i]! * Math.sqrt(SURF_SYNC_DEPTH) + phases[i]!) % TAU;
    out[i] = p < 0 ? p + TAU : p;
  }
  return out;
}

/** The bars and rips along the beach at z, -1..1: two crests 91 and 40 m long, the shorter wandering. */
export function surfBar(z: number): number {
  return 0.6 * Math.sin(z * 0.069 + 1.3) + 0.4 * Math.sin(z * 0.157 + 0.4 + 0.5 * Math.sin(z * 0.031));
}

/** CPU twin of the shaders' seaSurfDepth: the depth the breakers feel at z over sand `d` m deep (SURF_BAR). */
export function surfDepth(z: number, d: number): number {
  const dd = Math.max(d, 0);
  return dd * (1 + SURF_BAR * surfBar(z) * (1 - smooth(SURF_BAR_FADE[0], SURF_BAR_FADE[1], dd)));
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * CPU twin of the shaders' seaShoal: at a point with shelter and depth `s` (shelterAt), the scale of the open sea's
 * waves (their heights times it) and the breakers' height (m), for the heights `amps` (waveAmps).
 */
export function seaShoal(s: readonly number[], amps: readonly number[], out: [number, number] = [0, 0]): [number, number] {
  const d = Math.max(s[1]!, 0);
  const surf = 1 - smooth(SURF_DEPTH[0], SURF_DEPTH[1], d);
  let sum = 0;
  for (const a of amps) sum += a;
  const r = (SURF_GAMMA * d) / Math.max(s[0]! * sum, 1e-3);
  out[0] = (s[0]! * r) / Math.sqrt(Math.sqrt(1 + r * r * r * r)) * (1 - surf);
  const slope = Math.hypot(s[2]!, s[3]!);
  out[1] = s[0]! * surf * (1 - smooth(SURF_SHELVE[0], SURF_SHELVE[1], slope)) * Math.min(seaHalfHeight(amps) * SURF_SHOAL, SURF_GAMMA * d);
  return out;
}

/** The sea as the CPU twin needs it for a frame (sea.ts's seaSurface reads it off the sea's uniforms). */
export interface SeaSurface {
  /** wavePhases. */
  phases: number[];
  /** surfPhases. */
  surf: number[];
  /** The sea state, 0..1. */
  sea: number;
  /** The wave grid's centre, which the displacement's fades are measured from. */
  ox: number;
  oz: number;
  /** Each wave's fade distances (SeaGridSpec), those of the grid being drawn. */
  fadeStart: number[];
  fadeEnd: number[];
  shelter: ShelterMap | null;
}

const scratchS = [0, 0, 0, 0];
const scratchAmps = new Array<number>(WAVES.length).fill(0);
const scratchShoal: [number, number] = [0, 0];

/**
 * CPU twin of the shader's seaDisplace: the offset (dx, dy, dz) of the sea surface from the point at rest at world
 * (x, z), written into `out` when given.
 */
export function waveDisplacement(sea: SeaSurface, x: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const s = shelterAt(sea.shelter, x, z, scratchS);
  const amps = waveAmps(sea.sea, scratchAmps);
  const [deep, breaker] = seaShoal(s, amps, scratchShoal);
  const c = Math.max(Math.abs(x - sea.ox), Math.abs(z - sea.oz));
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i]!;
    const [ux, uz] = WAVE_DIR[i]!;
    const a = amps[i]! * deep * (1 - smooth(sea.fadeStart[i]!, sea.fadeEnd[i]!, c));
    const th = WAVE_K[i]! * (ux * x + uz * z) - sea.phases[i]!;
    dy += a * Math.sin(th);
    const h = w.steep * a * Math.cos(th);
    dx += ux * h;
    dz += uz * h;
  }
  if (breaker > 0) {
    // The breakers, summed by their heights: up the depth's gradient under their crests, as seaDisplace.
    const r = Math.sqrt(surfDepth(z, s[1]!));
    let bs = 0;
    let bc = 0;
    for (let i = 0; i < SURF_WAVES; i++) {
      const ph = SURF_S[i]! * r - SURF_KZ[i]! * z + sea.surf[i]!;
      bs += SURF_W[i]! * Math.sin(ph);
      bc += SURF_W[i]! * Math.cos(ph);
    }
    const g = Math.hypot(s[2]!, s[3]!);
    const h = g > 1e-4 ? (SURF_Q * breaker * bc) / g : 0;
    dx += s[2]! * h;
    dy += breaker * bs;
    dz += s[3]! * h;
  }
  out[0] = dx;
  out[1] = dy;
  out[2] = dz;
  return out;
}

const scratchD: [number, number, number] = [0, 0, 0];

/**
 * The drawn sea's height (m over WATER_Y) at world (x, z): the surface moves sideways too, so the point at rest whose
 * water is over (x, z) is found by stepping back along that push (twice), and its height taken.
 */
export function seaHeight(sea: SeaSurface, x: number, z: number): number {
  let px = x;
  let pz = z;
  for (let k = 0; k < 2; k++) {
    const d = waveDisplacement(sea, px, pz, scratchD);
    px = x - d[0];
    pz = z - d[2];
  }
  return waveDisplacement(sea, px, pz, scratchD)[1];
}

const f = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const vec4 = (vals: readonly number[]): string => `vec4(${vals.map(f).join(', ')})`;
/** The swell's (A) and the chop's (B) values of one of WAVES' fields, as a GLSL vec4 each. */
const pair = (name: string, vals: readonly number[]): string => `const vec4 ${name}_A = ${vec4(vals.slice(0, SWELL))};\nconst vec4 ${name}_B = ${vec4(vals.slice(SWELL))};`;
const sumSq = (from: number, to: number): number => WAVES.slice(from, to).reduce((s, w) => s + w.amp * w.amp, 0);
const vec3 = (vals: readonly number[]): string => `vec3(${vals.map(f).join(', ')})`;

/**
 * The breakers' wavenumbers along the beach and shares of the surf (SURF_KZ, SURF_W), and seaSwash(surf, z): how far up
 * the sand the swash has run, 0..1, at z for the breakers' phases `surf` (surfPhases), SWASH_DELAY after each breaker
 * reaches the waterline, its reach growing with the set. For the sea's shore foam and the sand's lace alike.
 */
export const SURF_SWASH_GLSL = /* glsl */ `
const vec3 SURF_KZ3 = ${vec3(SURF_KZ)};
const vec3 SURF_W3 = ${vec3(SURF_W)};
float seaSwash(vec3 surf, float z) {
  return 0.5 + 0.5 * dot(SURF_W3, sin(surf - SURF_KZ3 * z - ${f(SWASH_DELAY)}));
}
`;

/** The uniforms every material that follows the sea declares (SEA_WAVES_GLSL), bound to the sea's own. */
export const WAVE_UNIFORMS = ['uWavePhase', 'uChopPhase', 'uSeaAmp', 'uDisplace', 'uSeaOrigin', 'uSeaFade', 'uSurfPhase', 'uSeaShelter', 'uSeaShelterBox'] as const;
export type WaveUniform = (typeof WAVE_UNIFORMS)[number];

/**
 * Uniforms and functions for both shader stages. uWavePhase, uChopPhase: wavePhases (the swell's four, the chop's);
 * uSeaAmp: sea state 0..1; uDisplace: 1 on the grid, else 0; uSeaOrigin: the grid's centre (world XZ); uSurfPhase:
 * the breakers' phases (surfPhases); uSeaShelter, uSeaShelterBox: the shelter map (ShelterMap) and its box (minX, minZ,
 * 1 / width, 1 / depth). seaSurfPhases(world xz, depth) gives the breakers' phases there.
 * seaDisplace(world xz) gives the surface offset, seaDisplaceEdge does the same for a vertex on a ring's outer rim that
 * falls between the next ring's vertices (aEdge: the rim's direction times the next ring's cell, zero elsewhere),
 * interpolating between those neighbours so the rings meet without cracks. seaWave(world xz, the pixel's steps on the water, skip) gives what the shading needs (SeaWave; skip 1 leaves the surf out where it cannot show).
 */
export const SEA_WAVES_GLSL = /* glsl */ `
uniform vec4 uWavePhase;
uniform vec4 uChopPhase;
uniform float uSeaAmp;
uniform float uDisplace;
uniform vec2 uSeaOrigin;
uniform vec4 uSeaFade[4];
uniform vec3 uSurfPhase;
uniform sampler2D uSeaShelter;
uniform vec4 uSeaShelterBox;
${pair('SEA_K', WAVE_K)}
${pair('SEA_AMP', WAVES.map((w) => w.amp))}
${pair('SEA_DX', WAVE_DIR.map((d) => d[0]))}
${pair('SEA_DZ', WAVE_DIR.map((d) => d[1]))}
${pair('SEA_Q', WAVES.map((w) => w.steep))}
${SURF_SWASH_GLSL}
const vec3 SURF_S3 = ${vec3(SURF_S)};
/** Shelter, depth and the depth's gradient at p (ShelterMap). */
vec4 seaShelterAt(vec2 p) {
  return textureLod(uSeaShelter, (p - uSeaShelterBox.xy) * uSeaShelterBox.zw, 0.0);
}
vec4 seaAmpA() {
  return SEA_AMP_A * (${f(SWELL_BASE)} + ${f(1 - SWELL_BASE)} * uSeaAmp);
}
vec4 seaAmpB() {
  return SEA_AMP_B * pow(uSeaAmp, ${f(CHOP_POWER)});
}
/** seaHalfHeight. */
float seaHalfHeight() {
  float swell = ${f(SWELL_BASE)} + ${f(1 - SWELL_BASE)} * uSeaAmp;
  return 2.0 * sqrt(0.5 * (${f(sumSq(0, SWELL))} * swell * swell + ${f(sumSq(SWELL, WAVES.length))} * pow(uSeaAmp, ${f(2 * CHOP_POWER)})));
}
/** The open sea's waves' scale (x) and the breakers' height (y) at a point with shelter and depth s (seaShoal). */
vec2 seaShoal(vec4 s) {
  float d = max(s.y, 0.0);
  float surf = 1.0 - smoothstep(${f(SURF_DEPTH[0])}, ${f(SURF_DEPTH[1])}, d);
  float r = ${f(SURF_GAMMA)} * d / max(s.x * (dot(seaAmpA(), vec4(1.0)) + dot(seaAmpB(), vec4(1.0))), 1e-3);
  float deep = s.x * r * inversesqrt(sqrt(1.0 + r * r * r * r)) * (1.0 - surf);
  float slope = length(s.zw);
  float breaker = s.x * surf * (1.0 - smoothstep(${f(SURF_SHELVE[0])}, ${f(SURF_SHELVE[1])}, slope)) * min(seaHalfHeight() * ${f(SURF_SHOAL)}, ${f(SURF_GAMMA)} * d);
  return vec2(deep, breaker);
}
/** The depth the breakers feel at p over sand d deep, with the bars and rips (surfDepth). */
float seaSurfDepth(vec2 p, float d) {
  d = max(d, 0.0);
  float bar = 0.6 * sin(p.y * 0.069 + 1.3) + 0.4 * sin(p.y * 0.157 + 0.4 + 0.5 * sin(p.y * 0.031));
  return d * (1.0 + ${f(SURF_BAR)} * bar * (1.0 - smoothstep(${f(SURF_BAR_FADE[0])}, ${f(SURF_BAR_FADE[1])}, d)));
}
/** The breakers' phases at p over sand d deep, felt as e deep (seaSurfDepth). */
vec3 seaSurfPhases(vec2 p, float e) {
  return SURF_S3 * sqrt(e) - SURF_KZ3 * p.y + uSurfPhase;
}
vec3 seaDisplace(vec2 p) {
  vec4 s = seaShelterAt(p);
  vec2 sh = seaShoal(s);
  vec2 l = abs(p - uSeaOrigin);
  float c = max(l.x, l.y);
  vec4 aA = seaAmpA() * sh.x * (1.0 - smoothstep(uSeaFade[0], uSeaFade[1], vec4(c)));
  vec4 aB = seaAmpB() * sh.x * (1.0 - smoothstep(uSeaFade[2], uSeaFade[3], vec4(c)));
  vec4 thA = SEA_K_A * (SEA_DX_A * p.x + SEA_DZ_A * p.y) - uWavePhase;
  vec4 thB = SEA_K_B * (SEA_DX_B * p.x + SEA_DZ_B * p.y) - uChopPhase;
  vec4 hA = aA * SEA_Q_A * cos(thA);
  vec4 hB = aB * SEA_Q_B * cos(thB);
  vec3 ph = seaSurfPhases(p, seaSurfDepth(p, s.y));
  // The breakers' water moves along the depth's gradient, out to sea under their troughs and shoreward under their crests.
  vec2 side = s.zw * (${f(SURF_Q)} * sh.y * dot(SURF_W3, cos(ph)) * inversesqrt(max(dot(s.zw, s.zw), 1e-8)));
  return vec3(dot(hA, SEA_DX_A) + dot(hB, SEA_DX_B) + side.x, dot(aA, sin(thA)) + dot(aB, sin(thB)) + sh.y * dot(SURF_W3, sin(ph)), dot(hA, SEA_DZ_A) + dot(hB, SEA_DZ_B) + side.y);
}
vec3 seaDisplaceEdge(vec2 p, vec2 edge) {
  float cell = length(edge);
  if (cell < 0.5) return seaDisplace(p);
  vec2 dir = edge / cell;
  float s = dot(p, dir);
  float s0 = floor(s / cell) * cell;
  vec2 p0 = p + dir * (s0 - s);
  return mix(seaDisplace(p0), seaDisplace(p0 + dir * cell), (s - s0) / cell);
}
/**
 * What the shading needs of the waves at p, for a pixel stepping dx and dy over the water: their slope (dh/dx, dh/dz,
 * times NORMAL_GAIN), each wave's fading out as its phase outruns the pixels (WAVE_PHASE_PX); kept, the crests'
 * compression those slopes draw (Gerstner's sum of steepness times slope, which narrows the normal's rise at a crest);
 * lost, the mean square slope the fades took; height, the surface over the most the waves reach here (-1 in the deepest
 * trough to 1 where every crest meets, of the waves the pixel shows); steep, the compression of the waves the pixel shows,
 * which is how close the crests are to breaking; spread, the variance of the compression of those it cannot show (a sine
 * of amplitude c has a variance of c^2 / 2), which blurs the whitecaps' threshold rather than aliasing into it; most,
 * the compression where every crest meets; surf, the breakers' phases (seaSurfPhases); surfDepth, the depth they feel; deep,
 * 1 where skip asked for the surf to be left out and the sea is deeper than it reaches (SURF_REACH): then surf is 0, the
 * breakers' terms are not summed, and nothing of the surf below can show.
 */
struct SeaWave {
  vec2 slope;
  float kept;
  float lost;
  float height;
  float steep;
  float spread;
  float most;
  vec3 surf;
  float surfDepth;
  float deep;
};
SeaWave seaWave(vec2 p, vec2 dx, vec2 dy, float skip) {
  vec4 s = seaShelterAt(p);
  vec2 sh = seaShoal(s);
  vec4 aA = seaAmpA() * sh.x;
  vec4 aB = seaAmpB() * sh.x;
  vec4 thA = SEA_K_A * (SEA_DX_A * p.x + SEA_DZ_A * p.y) - uWavePhase;
  vec4 thB = SEA_K_B * (SEA_DX_B * p.x + SEA_DZ_B * p.y) - uChopPhase;
  vec4 keptA = 1.0 - smoothstep(${f(WAVE_PHASE_PX[0])}, ${f(WAVE_PHASE_PX[1])}, SEA_K_A * max(abs(SEA_DX_A * dx.x + SEA_DZ_A * dx.y), abs(SEA_DX_A * dy.x + SEA_DZ_A * dy.y)));
  vec4 keptB = 1.0 - smoothstep(${f(WAVE_PHASE_PX[0])}, ${f(WAVE_PHASE_PX[1])}, SEA_K_B * max(abs(SEA_DX_B * dx.x + SEA_DZ_B * dx.y), abs(SEA_DX_B * dy.x + SEA_DZ_B * dy.y)));
  float gainA = mix(${f(NORMAL_GAIN.flat[0])}, ${f(NORMAL_GAIN.grid[0])}, uDisplace);
  float gain = mix(${f(NORMAL_GAIN.flat[1])}, ${f(NORMAL_GAIN.grid[1])}, uDisplace);
  vec4 skA = aA * SEA_K_A;
  vec4 skB = aB * SEA_K_B;
  vec4 gA = skA * cos(thA) * keptA * gainA;
  vec4 gB = skB * cos(thB) * keptB * gain;
  vec4 cA = skA * SEA_Q_A * sin(thA);
  vec4 cB = skB * SEA_Q_B * sin(thB);
  SeaWave w;
  w.slope = vec2(dot(gA, SEA_DX_A) + dot(gB, SEA_DX_B), dot(gA, SEA_DZ_A) + dot(gB, SEA_DZ_B));
  w.kept = dot(cA, keptA) * gainA + dot(cB, keptB) * gain;
  // A sine of slope amplitude g has a mean square slope of g^2 / 2.
  w.lost = (dot(skA * skA, 1.0 - keptA * keptA) * gainA * gainA + dot(skB * skB, 1.0 - keptB * keptB) * gain * gain) * 0.5;
  float most = dot(aA, vec4(1.0)) + dot(aB, vec4(1.0)) + sh.y;
  w.steep = dot(cA, keptA) + dot(cB, keptB);
  vec4 cmA = skA * SEA_Q_A;
  vec4 cmB = skB * SEA_Q_B;
  w.spread = 0.5 * (dot(cmA * cmA, 1.0 - keptA * keptA) + dot(cmB * cmB, 1.0 - keptB * keptB));
  w.most = dot(cmA, vec4(1.0)) + dot(cmB, vec4(1.0));
  // The breakers, sh.y sum(SURF_W sin(seaSurfPhases)): their slopes are their heights' derivatives along the depth's
  // gradient, each phase growing by SURF_S / (2 sqrt(depth)) a metre of depth (the bars' stretch of it left out).
  // Deeper than they reach (sh.y is 0 from SURF_DEPTH[1] down) each of their terms adds nothing.
  vec3 ws = vec3(0.0);
  vec3 keptS = vec3(0.0);
  w.deep = step(${f(SURF_REACH)}, s.y) * skip;
  if (w.deep > 0.5) {
    w.surfDepth = s.y;
    w.surf = vec3(0.0);
  } else {
    w.surfDepth = seaSurfDepth(p, s.y);
    w.surf = seaSurfPhases(p, w.surfDepth);
    vec3 dk = SURF_S3 * (0.5 * inversesqrt(max(w.surfDepth, 0.04)));
    vec3 kS = dk * length(s.zw);
    keptS = 1.0 - smoothstep(${f(WAVE_PHASE_PX[0])}, ${f(WAVE_PHASE_PX[1])}, dk * max(abs(dot(s.zw, dx)), abs(dot(s.zw, dy))));
    ws = SURF_W3 * sin(w.surf);
    vec3 wk2 = SURF_W3 * SURF_W3 * kS * kS;
    w.slope += s.zw * (sh.y * dot(SURF_W3 * cos(w.surf) * dk, keptS) * gainA);
    w.lost += 0.5 * sh.y * sh.y * gainA * gainA * dot(wk2, 1.0 - keptS * keptS);
    w.kept += ${f(SURF_Q)} * sh.y * dot(ws * kS, keptS) * gainA;
    w.steep += ${f(SURF_Q)} * sh.y * dot(ws * kS, keptS);
    w.spread += 0.5 * ${f(SURF_Q * SURF_Q)} * sh.y * sh.y * dot(wk2, 1.0 - keptS * keptS);
    w.most += ${f(SURF_Q)} * sh.y * dot(SURF_W3, kS);
  }
  w.height = (dot(aA * keptA, sin(thA)) + dot(aB * keptB, sin(thB)) + sh.y * dot(ws, keptS)) / max(most, 1e-3);
  return w;
}
`;

/** The software sea's cheaper slope: the two longest waves only, sheltered. Needs the uniforms and functions above. */
export const SEA_SLOPE2_GLSL = /* glsl */ `
vec2 seaSlope2(vec2 p) {
  vec2 a = seaAmpA().xy * seaShoal(seaShelterAt(p)).x * ${f(NORMAL_GAIN.flat[0])};
  vec2 th = SEA_K_A.xy * (SEA_DX_A.xy * p.x + SEA_DZ_A.xy * p.y) - uWavePhase.xy;
  vec2 d = a * SEA_K_A.xy * cos(th);
  return vec2(dot(d, SEA_DX_A.xy), dot(d, SEA_DZ_A.xy));
}
`;
