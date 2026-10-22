// The sea's analytic waves: four Gerstner waves shared by the sea's vertex displacement (High), its per-pixel
// normals (every hardware tier), the software sea (the two longest) and the foam rings that ride on it.
// Free of three.js: the GLSL is plain strings and the CPU twin is used by tests. Visual only: the sim's sea
// stays flat at WATER_Y.

export interface Wave {
  /** Wavelength (m). */
  length: number;
  /** Direction of travel, degrees from onshore (-x, towards the east beach), turning towards +z. */
  angle: number;
  /** Height (m) at sea state 1. */
  amp: number;
  /** Phase at time 0 (rad). */
  phase0: number;
  /**
   * Vertex displacement fades out between these distances (m, along the larger axis from the sea grid's centre),
   * before the grid's cells grow too coarse to sample the wave: 1 m cells reach FINE_EXTENT, 4 m cells COARSE_EXTENT.
   */
  fadeStart: number;
  fadeEnd: number;
}

/** Their heights add up to 0.345 m at sea state 1 (a storm) and 0.10 m at calm's 0.3. */
export const WAVES: readonly Wave[] = [
  { length: 31, angle: 0, amp: 0.15, phase0: 0, fadeStart: 250, fadeEnd: 380 },
  { length: 17.3, angle: 27, amp: 0.09, phase0: 1.7, fadeStart: 150, fadeEnd: 250 },
  { length: 9.1, angle: -38, amp: 0.065, phase0: 4.1, fadeStart: 50, fadeEnd: 74 },
  { length: 4.3, angle: 58, amp: 0.04, phase0: 2.6, fadeStart: 40, fadeEnd: 70 },
];

/** Horizontal Gerstner steepness: crests sharpen, troughs widen. */
export const WAVE_STEEPNESS = 0.6;
/** The shading normals tilt this many times more than the geometry, so calm swell still reads from afar. */
export const NORMAL_GAIN = 3;
/** The sea grid (High): 1 m cells to this half-width, 4 m cells to COARSE_EXTENT, then a flat skirt to SKIRT_EXTENT. */
export const FINE_EXTENT = 80;
export const COARSE_EXTENT = 400;
export const SKIRT_EXTENT = 3000;
export const COARSE_CELL = 4;
/** Sea state with no weather (calm). */
export const CALM_SEA = 0.3;

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
 * Each wave's time phase, wrapped to [0, 2 pi) here in double precision: the shaders get it as a uniform, so the
 * waves never stutter after hours of play the way omega * t in float32 would.
 */
export function wavePhases(time: number, out: number[] = [0, 0, 0, 0]): number[] {
  for (let i = 0; i < WAVES.length; i++) {
    const p = (WAVE_OMEGA[i]! * time + WAVES[i]!.phase0) % TAU;
    out[i] = p < 0 ? p + TAU : p;
  }
  return out;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * CPU twin of the shader's seaDisplace: the offset (dx, dy, dz) of the sea surface at world (x, z) for a grid
 * centred on (ox, oz), at the given phases and sea state.
 */
export function waveDisplacement(x: number, z: number, ox: number, oz: number, phases: readonly number[], seaState: number): [number, number, number] {
  const c = Math.max(Math.abs(x - ox), Math.abs(z - oz));
  const s = Math.min(1, Math.max(0, seaState));
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i]!;
    const [ux, uz] = WAVE_DIR[i]!;
    const a = w.amp * s * (1 - smooth(w.fadeStart, w.fadeEnd, c));
    const th = WAVE_K[i]! * (ux * x + uz * z) - phases[i]!;
    dy += a * Math.sin(th);
    const h = WAVE_STEEPNESS * a * Math.cos(th);
    dx += ux * h;
    dz += uz * h;
  }
  return [dx, dy, dz];
}

const f = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const vec4 = (vals: readonly number[]): string => `vec4(${vals.map(f).join(', ')})`;

/**
 * Uniforms and functions for both shader stages. uWavePhase: wavePhases; uSeaAmp: sea state 0..1; uDisplace: 1 on
 * the High grid, else 0; uSeaOrigin: the grid's centre (world XZ). seaDisplace(world xz) gives the surface offset,
 * seaDisplaceEdge does the same for a vertex on the fine ring's rim (aEdge: the rim's direction, zero elsewhere),
 * interpolating between the coarse ring's neighbouring vertices so the two rings meet without cracks.
 * seaSlope(world xz, distance from the camera) gives the shading slope (dh/dx, dh/dz), each wave fading out
 * before it shrinks below a few pixels.
 */
export const SEA_WAVES_GLSL = /* glsl */ `
uniform vec4 uWavePhase;
uniform float uSeaAmp;
uniform float uDisplace;
uniform vec2 uSeaOrigin;
const vec4 SEA_K = ${vec4(WAVE_K)};
const vec4 SEA_AMP = ${vec4(WAVES.map((w) => w.amp))};
const vec4 SEA_DX = ${vec4(WAVE_DIR.map((d) => d[0]))};
const vec4 SEA_DZ = ${vec4(WAVE_DIR.map((d) => d[1]))};
const vec4 SEA_FADE0 = ${vec4(WAVES.map((w) => w.fadeStart))};
const vec4 SEA_FADE1 = ${vec4(WAVES.map((w) => w.fadeEnd))};
const vec4 SEA_LEN = ${vec4(WAVES.map((w) => w.length))};
vec3 seaDisplace(vec2 p) {
  vec2 l = abs(p - uSeaOrigin);
  float c = max(l.x, l.y);
  vec4 a = SEA_AMP * uSeaAmp * (1.0 - smoothstep(SEA_FADE0, SEA_FADE1, vec4(c)));
  vec4 th = SEA_K * (SEA_DX * p.x + SEA_DZ * p.y) - uWavePhase;
  vec4 h = a * cos(th) * ${f(WAVE_STEEPNESS)};
  return vec3(dot(h, SEA_DX), dot(a, sin(th)), dot(h, SEA_DZ));
}
vec3 seaDisplaceEdge(vec2 p, vec2 edge) {
  if (dot(edge, edge) < 0.5) return seaDisplace(p);
  float s = dot(p, edge);
  float s0 = floor(s / ${f(COARSE_CELL)}) * ${f(COARSE_CELL)};
  vec2 p0 = p + edge * (s0 - s);
  return mix(seaDisplace(p0), seaDisplace(p0 + edge * ${f(COARSE_CELL)}), (s - s0) / ${f(COARSE_CELL)});
}
vec2 seaSlope(vec2 p, float dist) {
  vec4 a = SEA_AMP * uSeaAmp * ${f(NORMAL_GAIN)} * (1.0 - smoothstep(SEA_LEN * 15.0, SEA_LEN * 40.0, vec4(dist)));
  vec4 th = SEA_K * (SEA_DX * p.x + SEA_DZ * p.y) - uWavePhase;
  vec4 d = a * SEA_K * cos(th);
  return vec2(dot(d, SEA_DX), dot(d, SEA_DZ));
}
`;

/** The software sea's cheaper slope: the two longest waves only. Needs the uniforms and constants above. */
export const SEA_SLOPE2_GLSL = /* glsl */ `
vec2 seaSlope2(vec2 p) {
  vec2 a = SEA_AMP.xy * uSeaAmp * ${f(NORMAL_GAIN)};
  vec2 th = SEA_K.xy * (SEA_DX.xy * p.x + SEA_DZ.xy * p.y) - uWavePhase.xy;
  vec2 d = a * SEA_K.xy * cos(th);
  return vec2(dot(d, SEA_DX.xy), dot(d, SEA_DZ.xy));
}
`;
