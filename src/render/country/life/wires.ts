// The wires the crows perch on: the wires of each span between two poles (each a segment, two ends and a sag), so the
// perch logic (flocks.ts) takes any poles, whatever the number of wires a span carries or the order the spans come in.
// Until the roadside branch's telephone poles land they are this placeholder line of poles beside Creek Road's west verge
// (7 m off the road's edge from Halfmoon Acres' hedge to its highway): the poles and wires are drawn by life/index.ts so
// the crows have something to sit on.
//
// At the merge with the roadside branch (oddities, four wires a span, every road): make SPANS the wires of its poles'
// spans, one array of Wire per span (its insulators' ends and its sag), and delete the stand-ins:
//   - here: PLACEHOLDER_POLES, POLE_H, ARM_Y, ARM_WIRES and WIRE_SAG, and SPANS' derivation from them;
//   - models.ts: poleGeometry;
//   - index.ts: the poles and wires meshes (`poles`, `wires`, `polesAt`, POLES_RANGE, wireLines() and the lines that show
//     them) and the imports of PLACEHOLDER_POLES and poleGeometry;
//   - the tests that name them: country_life.test.ts' wire flock test (PLACEHOLDER_POLES, ARM_Y) and
//     country_life_view.test.ts' model list (poleGeometry) and mesh names ('placeholder-poles', 'placeholder-wires').
// crowSites picks the two spans of each wire flock nearest the dairy's or Halfmoon Acres' yard, so nothing else changes.

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

/** The wires of each span, hung from one pole's crossarm to the next: the list the crows perch on. */
export const SPANS: ReadonlyArray<readonly Wire[]> = PLACEHOLDER_POLES.slice(1).map((b, i) => {
  const a = PLACEHOLDER_POLES[i]!;
  return ARM_WIRES.map((dx) => ({ ax: a.x + dx, ay: ARM_Y, az: a.z, bx: b.x + dx, by: ARM_Y, bz: b.z, sag: WIRE_SAG }));
});

/** The point `t` (0..1) along a wire, hanging in its curve: [x, y, z]. */
export function wirePoint(w: Wire, t: number): [number, number, number] {
  return [w.ax + (w.bx - w.ax) * t, w.ay + (w.by - w.ay) * t - w.sag * 4 * t * (1 - t), w.az + (w.bz - w.az) * t];
}
