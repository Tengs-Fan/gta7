// Doppler shift of a moving source heard by a moving listener (on the ground plane).

import { clamp } from '../core/math';

export const SPEED_OF_SOUND = 343;
/** Speeds along the line of sight are capped here, and the factor to this range, so it stays finite and sane. */
const MAX_LOS_SPEED = 120;
export const DOPPLER_RANGE: readonly [number, number] = [0.7, 1.4];

/**
 * Pitch factor for a source at (sx, sz) moving (svx, svz) heard at (lx, lz) moving (lvx, lvz):
 * (c + listener speed toward the source) / (c - source speed toward the listener). 1 for a stationary pair.
 */
export function dopplerFactor(sx: number, sz: number, svx: number, svz: number, lx: number, lz: number, lvx: number, lvz: number): number {
  const dx = lx - sx;
  const dz = lz - sz;
  const d = Math.hypot(dx, dz);
  if (!Number.isFinite(d) || d < 1e-3) return 1;
  const nx = dx / d;
  const nz = dz / d;
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  const vs = clamp(fin(svx) * nx + fin(svz) * nz, -MAX_LOS_SPEED, MAX_LOS_SPEED);
  const vl = clamp(-(fin(lvx) * nx + fin(lvz) * nz), -MAX_LOS_SPEED, MAX_LOS_SPEED);
  if (vs === 0 && vl === 0) return 1;
  const f = (SPEED_OF_SOUND + vl) / (SPEED_OF_SOUND - vs);
  return Number.isFinite(f) ? clamp(f, DOPPLER_RANGE[0], DOPPLER_RANGE[1]) : 1;
}
