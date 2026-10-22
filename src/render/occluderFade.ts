// How much of a thin occluder (a lamp or signal pole, a tree or palm trunk) is drawn for a camera framing a subject
// (the player's head on foot, the car when driving). PropsView feeds these constants to its shader uniforms and runs
// the same function on the CPU; the GLSL below mirrors it line for line. No three.js here, so tests run it directly.

import type { V3 } from '../core/math';

/** An occluder whose axis is within this distance (m) of the camera-to-subject segment is fully dissolved. */
export const OCCLUDER_CAPSULE_R = 0.35;
/** ...and is drawn in full from twice that out. */
export const OCCLUDER_CAPSULE_FULL = 2 * OCCLUDER_CAPSULE_R;
/** An axis within OCCLUDER_LENS_NEAR (m) of the lens is fully dissolved, and drawn in full beyond OCCLUDER_LENS_FAR. */
export const OCCLUDER_LENS_NEAR = 1;
export const OCCLUDER_LENS_FAR = 1.5;

export type OccluderKind = 'lamp' | 'signal' | 'tree' | 'palm';

/**
 * Each kind's axis in its prop's frame (before the prop's scale): from (0, from, 0) to (0, to, 0). Lamps run to the arm
 * and head, signals to the top of the head; a tree's runs up its trunk to where the canopy (which fades on its own)
 * takes over, a palm's to its crown.
 */
export const OCCLUDER_AXIS: Readonly<Record<OccluderKind, { from: number; to: number }>> = {
  lamp: { from: 0, to: 6.5 },
  signal: { from: 0, to: 5.5 },
  tree: { from: 0, to: 4.8 },
  palm: { from: 0, to: 8.7 },
};

/** A signal bulb's axis relative to the bulb itself: down the pole it hangs on, so the bulbs go with their pole. */
export const SIGNAL_BULB_AXIS = { from: -4.9, to: 0.7 } as const;

const EPS = 1e-8;

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Distance from point p to segment ab. */
export function pointSegmentDistance(p: V3, a: V3, b: V3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > EPS ? Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t), p.z - (a.z + abz * t));
}

/** Closest distance between segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function segmentDistance(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1x = q1.x - p1.x;
  const d1y = q1.y - p1.y;
  const d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x;
  const d2y = q2.y - p2.y;
  const d2z = q2.z - p2.z;
  const rx = p1.x - p2.x;
  const ry = p1.y - p2.y;
  const rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0;
  let t = 0;
  if (a <= EPS && e <= EPS) return Math.hypot(rx, ry, rz);
  if (a <= EPS) {
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      // Relative: in float32 (the shader) a parallel pair leaves rounding noise in a * e - b * b.
      s = denom > 1e-6 * a * e ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  return Math.hypot(p1.x + d1x * s - (p2.x + d2x * t), p1.y + d1y * s - (p2.y + d2y * t), p1.z + d1z * s - (p2.z + d2z * t));
}

/**
 * Opacity (0 dissolved .. 1 drawn in full) of an occluder whose axis runs from `base` to `top`, for a camera at `cam`
 * framing `subject`: 0 with the axis inside the OCCLUDER_CAPSULE_R capsule round the sight line or within
 * OCCLUDER_LENS_NEAR of the lens, 1 from OCCLUDER_CAPSULE_FULL off the line and OCCLUDER_LENS_FAR from the lens, and
 * smooth in between (both distances move at most 1 m per metre, so the opacity changes by at most 0.043 per cm).
 */
export function occluderOpacity(cam: V3, subject: V3, base: V3, top: V3): number {
  const line = segmentDistance(cam, subject, base, top);
  const lens = pointSegmentDistance(cam, base, top);
  return Math.min(smooth(OCCLUDER_CAPSULE_R, OCCLUDER_CAPSULE_FULL, line), smooth(OCCLUDER_LENS_NEAR, OCCLUDER_LENS_FAR, lens));
}

/** The four fade edges as the shader takes them (uOccFade): capsule near and far, lens near and far. */
export const OCCLUDER_FADE_EDGES = [OCCLUDER_CAPSULE_R, OCCLUDER_CAPSULE_FULL, OCCLUDER_LENS_NEAR, OCCLUDER_LENS_FAR] as const;

/** GLSL twins of pointSegmentDistance and segmentDistance, for the vertex shader. */
export const OCCLUDER_GLSL = /* glsl */ `
float occPointSeg( vec3 p, vec3 a, vec3 b ) {
  vec3 ab = b - a;
  float l2 = dot( ab, ab );
  float t = l2 > 1e-8 ? clamp( dot( p - a, ab ) / l2, 0.0, 1.0 ) : 0.0;
  return distance( p, a + ab * t );
}
float occSegSeg( vec3 p1, vec3 q1, vec3 p2, vec3 q2 ) {
  vec3 d1 = q1 - p1;
  vec3 d2 = q2 - p2;
  vec3 r = p1 - p2;
  float a = dot( d1, d1 );
  float e = dot( d2, d2 );
  float f = dot( d2, r );
  float s = 0.0;
  float t = 0.0;
  if ( a <= 1e-8 && e <= 1e-8 ) return length( r );
  if ( a <= 1e-8 ) {
    t = clamp( f / e, 0.0, 1.0 );
  } else {
    float c = dot( d1, r );
    if ( e <= 1e-8 ) {
      s = clamp( -c / a, 0.0, 1.0 );
    } else {
      float b = dot( d1, d2 );
      float denom = a * e - b * b;
      s = denom > 1e-6 * a * e ? clamp( ( b * f - c * e ) / denom, 0.0, 1.0 ) : 0.0;
      t = ( b * s + f ) / e;
      if ( t < 0.0 ) {
        t = 0.0;
        s = clamp( -c / a, 0.0, 1.0 );
      } else if ( t > 1.0 ) {
        t = 1.0;
        s = clamp( ( b - c ) / a, 0.0, 1.0 );
      }
    }
  }
  return distance( p1 + d1 * s, p2 + d2 * t );
}`;
