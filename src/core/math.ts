// Scalar and 2D (XZ-plane) math helpers shared by the simulation and the renderer.
//
// Conventions used everywhere in the game:
//   - World axes follow three.js: +X east, +Z south, +Y up. "North" is -Z.
//   - A heading angle `h` points along (sin h, cos h) in the XZ plane, which is
//     exactly the direction of an object's local +Z axis after `rotation.y = h`.
//   - The right-hand side of heading h is (-cos h, sin h).

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export interface V2 {
  x: number;
  z: number;
}

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01(invLerp(e0, e1, x));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach of `current` towards `target`. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wraps an angle to the range (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Signed shortest rotation from angle a to angle b. */
export function angleDiff(a: number, b: number): number {
  return wrapAngle(b - a);
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return wrapAngle(current + angleDiff(current, target) * (1 - Math.exp(-lambda * dt)));
}

export function moveAngleTowards(current: number, target: number, maxDelta: number): number {
  const d = angleDiff(current, target);
  if (Math.abs(d) <= maxDelta) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxDelta);
}

export function headingX(h: number): number {
  return Math.sin(h);
}

export function headingZ(h: number): number {
  return Math.cos(h);
}

/** Heading angle of a direction vector in the XZ plane. */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

export function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distSq2(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

export function dist3(a: V3, b: V3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Distance from point P to segment AB in the XZ plane. */
export function pointSegDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 1e-12 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
  t = clamp01(t);
  return dist2(px, pz, ax + abx * t, az + abz * t);
}

export function formatMoney(n: number): string {
  const v = Math.max(0, Math.floor(n));
  return '$' + v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}
