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
   * Vertex displacement fades out between these distances (m, along the larger axis from the sea grid's centre),
   * before the grid's cells grow too coarse to sample the wave: 1 m cells reach FINE_EXTENT, 4 m cells COARSE_EXTENT.
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
  { length: 57, angle: 9, amp: 0.4, steep: 1, phase0: 4.4, fadeStart: 640, fadeEnd: 790 },
  { length: 44, angle: 21, amp: 0.24, steep: 1, phase0: 1.1, fadeStart: 640, fadeEnd: 790 },
  { length: 33, angle: -30, amp: 0.3, steep: 2, phase0: 0.6, fadeStart: 300, fadeEnd: 390 },
  { length: 17.3, angle: 27, amp: 0.18, steep: 2, phase0: 1.7, fadeStart: 150, fadeEnd: 250 },
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
/**
 * The sea grid (High and Medium): 1 m cells to this half-width, 4 m cells to COARSE_EXTENT, then a flat skirt to
 * SKIRT_EXTENT.
 */
export const FINE_EXTENT = 80;
export const COARSE_EXTENT = 800;
export const SKIRT_EXTENT = 3000;
export const COARSE_CELL = 4;
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
 * breakers (on a gently shelving beach, SURF_SHELVE): one wave rolling in along the depth's contours with the swell's
 * period (its phase is the surf's foam bands', SHORE_GLSL, so the foam rides its crests), SURF_SHOAL times the open
 * sea's significant half-height (it grows as it shoals) until the depth caps it, steepened (SURF_Q) and kept under
 * SURF_STEEP of slope. Its phase is depth times SURF_K plus the surf phase; on the east beach's 1:34 sand that is a wave
 * every 17 m, at the depth of SURF_SYNC_DEPTH m in step with the first (onshore) swell wave, so a swell crest rolls on
 * into a breaker.
 */
export const SURF_GAMMA = 0.4;
export const SURF_DEPTH = [1.4, 2.0] as const;
export const SURF_SHOAL = 1.3;
export const SURF_Q = 2.4;
export const SURF_STEEP = 0.33;
/**
 * Breakers roll in only where the seabed shelves gently, fading out as its slope (the depth's gradient) steepens from the
 * first of these to the second: the east beach's sand falls 1 in 34; Las Lomas County's shores, 1 in 5, and the quays'
 * walls get none (their breakers would be a stripe a few metres long).
 */
export const SURF_SHELVE = [0.05, 0.1] as const;
export const SURF_K = 4 * Math.PI;
export const SURF_SYNC_DEPTH = 1.7;
/** The breakers' crests run this far (rad) behind the surf's foam bands, which lie on their fronts. */
export const SURF_LAG = 0.5;

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
 * The surf's phase (the breakers' and the foam bands') for the first wave's phase `phase0` and the east beach's start
 * (Bounds.beachStartX): where the beach is SURF_SYNC_DEPTH m deep, a breaker's crest is where that wave's would be.
 */
export function surfPhase(phase0: number, beachStartX: number): number {
  const x = beachStartX + (BEACH_W * (SURF_SYNC_DEPTH + CURB_H - WATER_Y)) / SAND_DROP;
  // The breaker's height is sin(depth K + surf + lag), the swell's sin(-k0 x - phase0): equal where sin(pi - a) = sin(a).
  const p = (phase0 + Math.PI - SURF_SYNC_DEPTH * SURF_K - SURF_LAG + WAVE_K[0]! * x) % TAU;
  return p < 0 ? p + TAU : p;
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
  out[1] = s[0]! * surf * (1 - smooth(SURF_SHELVE[0], SURF_SHELVE[1], slope)) * Math.min(seaHalfHeight(amps) * SURF_SHOAL, SURF_GAMMA * d, SURF_STEEP / (SURF_K * Math.max(slope, 1e-4)));
  return out;
}

/** The sea as the CPU twin needs it for a frame (sea.ts's seaSurface reads it off the sea's uniforms). */
export interface SeaSurface {
  /** wavePhases. */
  phases: number[];
  /** surfPhase. */
  surf: number;
  /** The sea state, 0..1. */
  sea: number;
  /** The wave grid's centre, which the displacement's fades are measured from. */
  ox: number;
  oz: number;
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
    const a = amps[i]! * deep * (1 - smooth(w.fadeStart, w.fadeEnd, c));
    const th = WAVE_K[i]! * (ux * x + uz * z) - sea.phases[i]!;
    dy += a * Math.sin(th);
    const h = w.steep * a * Math.cos(th);
    dx += ux * h;
    dz += uz * h;
  }
  if (breaker > 0) {
    const ph = s[1]! * SURF_K + sea.surf + SURF_LAG;
    const g = Math.hypot(s[2]!, s[3]!);
    const h = g > 1e-4 ? (SURF_Q * breaker * Math.cos(ph)) / g : 0;
    dx += s[2]! * h;
    dy += breaker * Math.sin(ph);
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

/** The uniforms every material that follows the sea declares (SEA_WAVES_GLSL), bound to the sea's own. */
export const WAVE_UNIFORMS = ['uWavePhase', 'uChopPhase', 'uSeaAmp', 'uDisplace', 'uSeaOrigin', 'uSurfPhase', 'uSeaShelter', 'uSeaShelterBox'] as const;
export type WaveUniform = (typeof WAVE_UNIFORMS)[number];

/**
 * Uniforms and functions for both shader stages. uWavePhase, uChopPhase: wavePhases (the swell's four, the chop's);
 * uSeaAmp: sea state 0..1; uDisplace: 1 on the grid, else 0; uSeaOrigin: the grid's centre (world XZ); uSurfPhase:
 * surfPhase; uSeaShelter, uSeaShelterBox: the shelter map (ShelterMap) and its box (minX, minZ, 1 / width, 1 / depth).
 * seaDisplace(world xz) gives the surface offset, seaDisplaceEdge does the same for a vertex on the fine ring's rim
 * (aEdge: the rim's direction, zero elsewhere), interpolating between the coarse ring's neighbouring vertices so the two
 * rings meet without cracks. seaWave(world xz, the pixel's steps on the water) gives what the shading needs (SeaWave).
 */
export const SEA_WAVES_GLSL = /* glsl */ `
uniform vec4 uWavePhase;
uniform vec4 uChopPhase;
uniform float uSeaAmp;
uniform float uDisplace;
uniform vec2 uSeaOrigin;
uniform float uSurfPhase;
uniform sampler2D uSeaShelter;
uniform vec4 uSeaShelterBox;
${pair('SEA_K', WAVE_K)}
${pair('SEA_AMP', WAVES.map((w) => w.amp))}
${pair('SEA_DX', WAVE_DIR.map((d) => d[0]))}
${pair('SEA_DZ', WAVE_DIR.map((d) => d[1]))}
${pair('SEA_Q', WAVES.map((w) => w.steep))}
${pair('SEA_FADE0', WAVES.map((w) => w.fadeStart))}
${pair('SEA_FADE1', WAVES.map((w) => w.fadeEnd))}
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
  float breaker = s.x * surf * (1.0 - smoothstep(${f(SURF_SHELVE[0])}, ${f(SURF_SHELVE[1])}, slope)) * min(min(seaHalfHeight() * ${f(SURF_SHOAL)}, ${f(SURF_GAMMA)} * d), ${f(SURF_STEEP / SURF_K)} / max(slope, 1e-4));
  return vec2(deep, breaker);
}
/** The breakers' phase at depth d. */
float seaSurfPhase(float d) {
  return d * ${f(SURF_K)} + uSurfPhase + ${f(SURF_LAG)};
}
vec3 seaDisplace(vec2 p) {
  vec4 s = seaShelterAt(p);
  vec2 sh = seaShoal(s);
  vec2 l = abs(p - uSeaOrigin);
  float c = max(l.x, l.y);
  vec4 aA = seaAmpA() * sh.x * (1.0 - smoothstep(SEA_FADE0_A, SEA_FADE1_A, vec4(c)));
  vec4 aB = seaAmpB() * sh.x * (1.0 - smoothstep(SEA_FADE0_B, SEA_FADE1_B, vec4(c)));
  vec4 thA = SEA_K_A * (SEA_DX_A * p.x + SEA_DZ_A * p.y) - uWavePhase;
  vec4 thB = SEA_K_B * (SEA_DX_B * p.x + SEA_DZ_B * p.y) - uChopPhase;
  vec4 hA = aA * SEA_Q_A * cos(thA);
  vec4 hB = aB * SEA_Q_B * cos(thB);
  float ph = seaSurfPhase(s.y);
  // The breaker's water moves along the depth's gradient, out to sea under its trough and shoreward under its crest.
  vec2 side = s.zw * (${f(SURF_Q)} * sh.y * cos(ph) * inversesqrt(max(dot(s.zw, s.zw), 1e-8)));
  return vec3(dot(hA, SEA_DX_A) + dot(hB, SEA_DX_B) + side.x, dot(aA, sin(thA)) + dot(aB, sin(thB)) + sh.y * sin(ph), dot(hA, SEA_DZ_A) + dot(hB, SEA_DZ_B) + side.y);
}
vec3 seaDisplaceEdge(vec2 p, vec2 edge) {
  if (dot(edge, edge) < 0.5) return seaDisplace(p);
  float s = dot(p, edge);
  float s0 = floor(s / ${f(COARSE_CELL)}) * ${f(COARSE_CELL)};
  vec2 p0 = p + edge * (s0 - s);
  return mix(seaDisplace(p0), seaDisplace(p0 + edge * ${f(COARSE_CELL)}), (s - s0) / ${f(COARSE_CELL)});
}
/**
 * What the shading needs of the waves at p, for a pixel stepping dx and dy over the water: their slope (dh/dx, dh/dz,
 * times NORMAL_GAIN), each wave's fading out as its phase outruns the pixels (WAVE_PHASE_PX); kept, the crests'
 * compression those slopes draw (Gerstner's sum of steepness times slope, which narrows the normal's rise at a crest);
 * lost, the mean square slope the fades took; height, the surface over the most the waves reach here (-1 in the deepest
 * trough to 1 where every crest meets); steep, the compression of every wave, faded or not, which is how close the
 * crests are to breaking; most, the compression where every crest meets.
 */
struct SeaWave {
  vec2 slope;
  float kept;
  float lost;
  float height;
  float steep;
  float most;
};
SeaWave seaWave(vec2 p, vec2 dx, vec2 dy) {
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
  w.steep = dot(cA, vec4(1.0)) + dot(cB, vec4(1.0));
  w.most = dot(skA, SEA_Q_A) + dot(skB, SEA_Q_B);
  // The breaker, sh.y sin(seaSurfPhase(depth)): its slope is its height's derivative along the depth's gradient.
  float ph = seaSurfPhase(s.y);
  float ks = ${f(SURF_K)} * length(s.zw);
  float keptS = 1.0 - smoothstep(${f(WAVE_PHASE_PX[0])}, ${f(WAVE_PHASE_PX[1])}, ${f(SURF_K)} * max(abs(dot(s.zw, dx)), abs(dot(s.zw, dy))));
  w.slope += s.zw * (${f(SURF_K)} * sh.y * cos(ph) * keptS * gainA);
  w.lost += 0.5 * (ks * sh.y * gainA) * (ks * sh.y * gainA) * (1.0 - keptS * keptS);
  w.kept += ${f(SURF_Q)} * ks * sh.y * sin(ph) * keptS * gainA;
  w.steep += ${f(SURF_Q)} * ks * sh.y * sin(ph);
  w.most += ${f(SURF_Q)} * ks * sh.y;
  w.height = (dot(aA, sin(thA)) + dot(aB, sin(thB)) + sh.y * sin(ph)) / max(most, 1e-3);
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
