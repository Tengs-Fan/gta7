// The wires the crows perch on: a list of segments (two ends and a sag), so the perch logic (flocks.ts) takes any of them.
// Until the roadside branch's telephone poles land they are this placeholder line of poles beside Creek Road's west verge
// (7 m off the road's edge from Halfmoon Acres' hedge to its highway): the poles and wires are drawn by life/index.ts so
// the crows have something to sit on. When the real poles merge, point WIRES at their spans and delete the poles' drawing.

export interface Wire {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  /** How far (m) the wire hangs below the straight line at its middle. */
  sag: number;
}

/** The placeholder poles, their height (m) and where the three wires hang on the crossarm. */
export const PLACEHOLDER_POLES: ReadonlyArray<{ x: number; z: number }> = [96, 124, 152, 180, 208, 236].map((z) => ({ x: -852, z }));
export const POLE_H = 9;
export const ARM_Y = 8.5;
/** Offsets (m) of the wires across the line, and the crossarm's half-width. */
export const ARM_WIRES = [-0.8, 0, 0.8] as const;
const WIRE_SAG = 0.7;

/** Every span's three wires, hung from one pole's crossarm to the next. */
export const WIRES: readonly Wire[] = PLACEHOLDER_POLES.slice(1).flatMap((b, i) => {
  const a = PLACEHOLDER_POLES[i]!;
  return ARM_WIRES.map((dx) => ({ ax: a.x + dx, ay: ARM_Y, az: a.z, bx: b.x + dx, by: ARM_Y, bz: b.z, sag: WIRE_SAG }));
});

/** The point `t` (0..1) along a wire, hanging in its curve: [x, y, z]. */
export function wirePoint(w: Wire, t: number): [number, number, number] {
  return [w.ax + (w.bx - w.ax) * t, w.ay + (w.by - w.ay) * t - w.sag * 4 * t * (1 - t), w.az + (w.bz - w.az) * t];
}
