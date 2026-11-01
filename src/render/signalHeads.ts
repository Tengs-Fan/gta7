// What a traffic signal's lit parts show at a moment, read from its junction's cycle on the clock drivers and
// pedestrians obey (RoadNetwork.signalState, signalTimeLeft, pedCanCross): its lenses, the countdown beside a head and
// its walk heads; and the quads they are drawn on (PropsView), laid out from the signal's model (furniture.ts).

import { lensAt, onFace, type SignalLayout, type SignalStyle } from './furniture';
import { SIGNAL_TILE } from './textures';
import { AVENUE_W } from '../world/constants';
import type { Prop } from '../world/layout';
import { axisOf, PED_WALK, SIGNAL_GREEN, type Axis, type Dir, type RoadNetwork, type SignalState } from '../world/roads';

/**
 * Which kind of signal stands at an approach: Las Lomas County's junction hangs its heads from span wires; in the city
 * an avenue's approach gets a mast arm over its two lanes, a street's a bracket arm over its one.
 */
export function signalStyle(roads: RoadNetwork, p: Prop): SignalStyle {
  if (p.node >= roads.gridNodeCount) return 'span';
  const node = roads.nodes[p.node]!;
  return 2 * (axisOf(p.dir as Dir) === 'NS' ? node.halfX : node.halfZ) >= AVENUE_W ? 'mast' : 'bracket';
}

/** The lit quads' palette (PropsView sets the colours): lit and unlit lenses, the countdown's two colours, walk and hand. */
export const LIT = { off: 0, red: 1, yellow: 2, green: 3, redOff: 4, yellowOff: 5, greenOff: 6, countRed: 7, countGreen: 8, walk: 9, hand: 10 } as const;
export const LIT_COLORS = 11;

const LENS_STATES: readonly SignalState[] = ['red', 'yellow', 'green'];
const LENS_ON = [LIT.red, LIT.yellow, LIT.green] as const;
const LENS_OFF = [LIT.redOff, LIT.yellowOff, LIT.greenOff] as const;

/**
 * The traffic each walk head's people cross: the first faces across the approach's own road, the second across the road
 * to the approach's right, which a T junction may not have (null: no crosswalk there, nobody reads that head).
 */
export function walkAxes(roads: RoadNetwork, p: Prop): [Axis, Axis | null] {
  const own = axisOf(p.dir as Dir);
  return [own, roads.nodes[p.node]!.neighbors[(p.dir + 1) % 4]! >= 0 ? (own === 'NS' ? 'EW' : 'NS') : null];
}

/** The countdown beside a vehicle head: whole seconds left in its red or green; blank (null) in the yellow and while held. */
export function signalCount(roads: RoadNetwork, node: number, axis: Axis, t: number): number | null {
  const left = roads.signalTimeLeft(node, axis, t);
  return left === null || roads.signalState(node, axis, t) === 'yellow' ? null : Math.ceil(left);
}

export type WalkSymbol = 'walk' | 'hand' | 'dark';

/** What a walk head shows the people about to cross `crossed` traffic. */
export interface WalkShow {
  readonly symbol: WalkSymbol;
  readonly count: number | null;
}

/**
 * The walk head before people about to cross `crossed` traffic: the walking figure while they may start (pedCanCross),
 * counting down to the end of the walk; then the hand, flashing through the rest of the green beside them (whoever is
 * across finishes, nobody starts) and counting it down; steady when that green is over. A held junction walks, or
 * stops, without a count.
 */
export function walkShow(roads: RoadNetwork, node: number, crossed: Axis, t: number): WalkShow {
  const beside: Axis = crossed === 'NS' ? 'EW' : 'NS';
  const left = roads.signalTimeLeft(node, beside, t);
  if (roads.pedCanCross(node, crossed, t)) return { symbol: 'walk', count: left === null ? null : Math.ceil(left - (SIGNAL_GREEN - PED_WALK)) };
  if (left !== null && roads.signalState(node, beside, t) === 'green') return { symbol: (t % 1 + 1) % 1 < 0.5 ? 'hand' : 'dark', count: Math.ceil(left) };
  return { symbol: 'hand', count: null };
}

/** Everything a signal shows at a moment: its light (null when knocked over), its countdown and its walk heads'. */
export interface SignalShow {
  readonly state: SignalState | null;
  readonly count: number | null;
  readonly walks: readonly WalkShow[];
}

/** A knocked-over signal shows nothing. */
export const DARK_SIGNAL: SignalShow = { state: null, count: null, walks: [{ symbol: 'dark', count: null }, { symbol: 'dark', count: null }] };

const SYMBOLS: readonly WalkSymbol[] = ['walk', 'hand', 'dark'];

/** One number for everything a signal shows, which changes whenever any of it does. */
export function showKey(s: SignalShow): number {
  let key = (s.state === null ? 3 : LENS_STATES.indexOf(s.state)) * 101 + (s.count ?? -1) + 1;
  for (const w of s.walks) key = (key * 3 + SYMBOLS.indexOf(w.symbol)) * 101 + (w.count ?? -1) + 1;
  return key;
}

/** What a quad shows: a lens of head `head`, digit `k` (0 the tens) of every countdown, or a walk head's figure or digit. */
export type QuadRole =
  | { readonly kind: 'lens'; readonly head: number; readonly k: number }
  | { readonly kind: 'count'; readonly k: number }
  | { readonly kind: 'walk'; readonly walk: number }
  | { readonly kind: 'walkCount'; readonly walk: number; readonly k: number };

/** A lit quad in its signal's frame: its centre, its turn about y (0 faces +z), its size and what it shows. */
export interface SignalQuad {
  readonly at: readonly [number, number, number];
  readonly turn: number;
  readonly w: number;
  readonly h: number;
  readonly role: QuadRole;
}

/** The quads stand this far (m) out of the faces of their housings. */
const PROUD = 0.012;

/** Every lit quad of a signal of this layout. */
export function signalQuads(layout: SignalLayout): SignalQuad[] {
  const out: SignalQuad[] = [];
  layout.heads.forEach((h, head) => {
    for (let k = 0; k < 3; k++) {
      const [x, y, z] = lensAt(h, k);
      out.push({ at: [x + Math.sin(h.turn) * PROUD, y, z + Math.cos(h.turn) * PROUD], turn: h.turn, w: h.lens, h: h.lens, role: { kind: 'lens', head, k } });
    }
  });
  for (const c of layout.counts) {
    for (let k = 0; k < 2; k++) out.push({ at: onFace(c, (k - 0.5) * c.h * 0.55, 0, PROUD), turn: c.turn, w: c.h / 2, h: c.h, role: { kind: 'count', k } });
  }
  layout.walks.forEach((f, walk) => {
    out.push({ at: onFace(f, -0.12, 0, PROUD), turn: f.turn, w: 0.24, h: 0.24, role: { kind: 'walk', walk } });
    for (let k = 0; k < 2; k++) out.push({ at: onFace(f, 0.08 + k * 0.1, 0, PROUD), turn: f.turn, w: 0.09, h: 0.18, role: { kind: 'walkCount', walk, k } });
  });
  return out;
}

/** A digit of a two-digit number (0 the tens; no leading zero), or null for an unlit one. */
function digit(n: number | null, k: number): number | null {
  if (n === null) return null;
  if (k === 1) return n % 10;
  return n >= 10 ? Math.floor(n / 10) % 10 : null;
}

/** The atlas tile and palette entry a quad shows: `out` gets [tile, colour]. */
export function quadLit(role: QuadRole, show: SignalShow, out: [number, number]): [number, number] {
  switch (role.kind) {
    case 'lens':
      out[0] = SIGNAL_TILE.lens;
      out[1] = show.state === LENS_STATES[role.k] ? LENS_ON[role.k]! : LENS_OFF[role.k]!;
      return out;
    case 'count': {
      const d = digit(show.count, role.k);
      out[0] = d ?? 8;
      out[1] = d === null ? LIT.off : show.state === 'green' ? LIT.countGreen : LIT.countRed;
      return out;
    }
    case 'walk': {
      const w = show.walks[role.walk]!;
      out[0] = w.symbol === 'walk' ? SIGNAL_TILE.walk : SIGNAL_TILE.hand;
      out[1] = w.symbol === 'walk' ? LIT.walk : w.symbol === 'hand' ? LIT.hand : LIT.off;
      return out;
    }
    case 'walkCount': {
      const w = show.walks[role.walk]!;
      const d = digit(w.count, role.k);
      out[0] = d ?? 8;
      out[1] = d === null ? LIT.off : w.symbol === 'walk' ? LIT.walk : LIT.hand;
      return out;
    }
  }
}
