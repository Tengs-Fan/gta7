// The wires the crows perch on: the wires of each span between two of the county's telephone poles (world/country/oddities.ts,
// drawn by render/country/poles.ts), each a segment, two ends and a sag, so the perch logic (flocks.ts) takes any poles,
// whatever the number of wires a span carries or the order the spans come in.

import { insulator, POLE, sagAt, type CountyOddities } from '../../../world/country/oddities';

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

/** The wires of each span, hung from one pole's insulators to the next's: the list the crows perch on. */
export function spanWires({ poles, spans }: CountyOddities): Wire[][] {
  return spans.map((s) => {
    const len = Math.hypot(poles[s.b]!.x - poles[s.a]!.x, poles[s.b]!.z - poles[s.a]!.z);
    return POLE.wires.map((_, k) => {
      const [ax, ay, az] = insulator(poles[s.a]!, k);
      const [bx, by, bz] = insulator(poles[s.b]!, k);
      return { ax, ay, az, bx, by, bz, sag: sagAt(len, 0.5) };
    });
  });
}

/** The point `t` (0..1) along a wire, hanging in its curve: [x, y, z]. */
export function wirePoint(w: Wire, t: number): [number, number, number] {
  return [w.ax + (w.bx - w.ax) * t, w.ay + (w.by - w.ay) * t - w.sag * 4 * t * (1 - t), w.az + (w.bz - w.az) * t];
}
