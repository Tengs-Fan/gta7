// Foliage wind: how far a leaf card or palm frond is pushed at a point, at a render time, for a wind speed. The GLSL
// below (the leaf and frond vertex shaders) mirrors windOffset line for line; no three.js here, so tests run it
// directly. Render time and position only: nothing reads or changes the simulation.

/** Height (m) above the prop's foot where wind starts to move foliage, and where it moves it fully. */
export const WIND_FLOOR = 1;
export const WIND_FULL = 4.5;
/** Sway amplitude (m) for a wind speed (m/s): calm air still stirs, a storm (12 m/s) about 2.4 times the clear (2 m/s) sway. */
export const WIND_AMP_MIN = 0.04;
export const WIND_AMP_MAX = 0.12;
/** The sway's largest magnitude per unit amplitude (main sway 1, cross flutter 0.14, vertical 0.105). */
export const WIND_PEAK = Math.hypot(1, 0.14, 0.105);

export function windAmplitude(speed: number): number {
  return Math.min(WIND_AMP_MAX, Math.max(WIND_AMP_MIN, 0.05 + 0.007 * (speed - 2)));
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Share of the sway at height `h` (m) above the foot: 0 below WIND_FLOOR. */
export function windWeight(h: number): number {
  return smooth(WIND_FLOOR, WIND_FULL, h);
}

/** The largest displacement (m) anywhere at height `h` for amplitude `amp`. */
export function windMaxDisplacement(h: number, amp: number): number {
  return windWeight(h) * amp * WIND_PEAK;
}

/**
 * Displacement (m) of a foliage point at world (x, y, z), `h` m above its prop's foot, `reach` (0..1) the share of the
 * sway its distance from the attachment allows (1 for leaf cards; palm fronds grow from 0 at the crown), at render time
 * `t` with amplitude `amp` blowing along the unit (dirX, dirZ).
 */
export function windOffset(x: number, y: number, z: number, h: number, reach: number, t: number, amp: number, dirX: number, dirZ: number): [number, number, number] {
  const phase = x * 0.37 + z * 0.29;
  const sway = Math.sin(t * 1.3 + phase) * 0.7 + Math.sin(t * 2.9 + phase * 1.7 + y * 0.8) * 0.3;
  const flutter = Math.sin(t * 7.1 + x * 3.1 + y * 2.3 + z * 2.7) * 0.35;
  const w = windWeight(h) * reach * amp;
  return [w * (dirX * sway - dirZ * flutter * 0.4), w * flutter * 0.3, w * (dirZ * sway + dirX * flutter * 0.4)];
}

/** GLSL twin of windOffset (uniforms uWindTime, uWindAmp, uWindDir). */
export const WIND_GLSL = /* glsl */ `
uniform float uWindTime;
uniform float uWindAmp;
uniform vec2 uWindDir;
vec3 windOffset( vec3 p, float h, float reach ) {
  float phase = p.x * 0.37 + p.z * 0.29;
  float sway = sin( uWindTime * 1.3 + phase ) * 0.7 + sin( uWindTime * 2.9 + phase * 1.7 + p.y * 0.8 ) * 0.3;
  float flutter = sin( uWindTime * 7.1 + p.x * 3.1 + p.y * 2.3 + p.z * 2.7 ) * 0.35;
  float w = smoothstep( ${WIND_FLOOR.toFixed(2)}, ${WIND_FULL.toFixed(2)}, h ) * reach * uWindAmp;
  return w * vec3( uWindDir.x * sway - uWindDir.y * flutter * 0.4, flutter * 0.3, uWindDir.y * sway + uWindDir.x * flutter * 0.4 );
}`;
