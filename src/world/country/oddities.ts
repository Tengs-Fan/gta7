// Las Lomas County's roadside oddities (docs/map.md, "Las Lomas: roadside oddities"): the telephone poles along its roads
// and the wires between them, and the small useless things beside them: a giant fibreglass cow on a flatbed beside a
// farm stand, a crashed saucer holding up the sign of the Little Green Diner, Bigfoot at a gravel pull-off, a row of
// mismatched mailboxes, three hand-painted signs, an abandoned pickup, a school bus turned henhouse, a payphone that rings,
// and a crop circle in the wheat. Pure data, no rendering. buildOddities is the last of the county's content passes and
// only appends: every solid goes into `oddities.solids` (StaticWorld adds them after the places' solids, so every older
// collider keeps its id), the mailboxes and signs are props of their own (kind 'roadside': they are knocked over), and it
// draws from no generator, so a run that never comes near them runs as it did. A pole's collider is a rock's (solid, but
// sight, shots and the camera see through it, as through a street lamp): as a pillar it stopped the camera and thinned the
// traffic streaming round it, which is placed out of the player's sight; it is not a lamp's because the camera's
// occluders (camera_occluders) know every lamp collider for a prop.

import type { AttractionSolid } from '../attractions';
import { addProp, mkRect, rectContains, type CityLayout, type Rect } from '../layout';
import { countryGround, onCountyLand, plotAt, type CountryRoad } from './index';
import { FIRE_ROAD } from './hills';

/**
 * A telephone pole: its foot, and the heading (radians, facing (sin rot, cos rot)) of the line it carries along its road,
 * which its crossarm lies across.
 */
export interface Pole {
  x: number;
  y: number;
  z: number;
  rot: number;
}

/** A run of wire between two poles (indices into `poles`), four wires of it, one on each of the crossarm's insulators. */
export interface Span {
  a: number;
  b: number;
}

/**
 * The poles: a pole every `gap` m along one side of each county road, `off` m outside its edge, `h` tall, tapering from
 * `base` to `top` in radius, with a crossarm `arm` m long at `armY` carrying four insulators at the `wires` offsets across
 * the line, their wires strung `wireY` up. A wire hangs as a catenary of parameter `sag` m (the sag of a span of length L
 * is about L^2 / (8 sag)); a pole is left out within `clear` m of a junction's box, and a wire spans one such gap at most
 * `maxSpan` m.
 */
export const POLE = {
  gap: 40,
  off: 4,
  h: 8.6,
  base: 0.17,
  top: 0.12,
  armY: 7.75,
  arm: 2.4,
  wires: [-1.05, -0.45, 0.45, 1.05],
  wireY: 8.0,
  sag: 300,
  clear: 16,
  maxSpan: 82,
} as const;

/** The oddities that stand on their own, each at (x, z) facing (sin rot, cos rot) (render/country/oddities.ts draws them). */
export type StaticKind = 'cow' | 'stand' | 'diner' | 'bigfoot' | 'plaque' | 'pickup' | 'bus' | 'hives' | 'payphone';

export interface Placed {
  kind: StaticKind;
  x: number;
  z: number;
  rot: number;
}

/**
 * The shapes of the roadside furniture that breaks (props of kind 'roadside', each one's shape in its `color`): six
 * mailboxes of different makes, the fish among them, and three hand-painted signs, each on a post `h` m tall and `w` m
 * across (a sign's board, a mailbox's reach about its post): a car meets a circle of w / 2 m at the post, which for a
 * sign is wide enough to take in both of its posts, or a car clipping one end would pass through it.
 */
export const ROADSIDE = [
  { name: 'mailbox', h: 1.35, w: 0.5 },
  { name: 'fish', h: 1.55, w: 1.0 },
  { name: 'barn', h: 1.6, w: 0.6 },
  { name: 'churn', h: 1.5, w: 0.4 },
  { name: 'birdhouse', h: 1.55, w: 0.5 },
  { name: 'rusty', h: 1.35, w: 0.5 },
  { name: 'eggs', h: 1.9, w: 1.2 },
  { name: 'honey', h: 1.9, w: 1.7 },
  { name: 'slow', h: 2.0, w: 1.7 },
] as const;

/** What the hand-painted signs say, by their index in ROADSIDE. */
export const SIGN_TEXT: Readonly<Record<number, readonly [string, string]>> = {
  6: ['FRESH', 'EGGS'],
  7: ['HONEY', '(ASK THE BEES)'],
  8: ['SLOW:', 'KIDS, DOGS, GOATS, GRANDPA'],
};

/** The payphone: where it stands, and where the player stands to answer it (in front of its open side). */
export interface Payphone {
  x: number;
  z: number;
  rot: number;
  at: { x: number; z: number };
}

/** A part of the crop circle's pattern: the ring from `r0` to `r1` m round (cx, cz) (a disc when r0 is 0), mown flat. */
export interface Mown {
  cx: number;
  cz: number;
  r0: number;
  r1: number;
}

/** The crop circle mown into one of the wheat fields: which (an index into farms.fields) and what is flat. */
export interface CropCircle {
  field: number;
  cx: number;
  cz: number;
  /** The pattern's reach: no part of it is farther from (cx, cz). */
  radius: number;
  mown: Mown[];
}

export interface CountyOddities {
  /** The first prop of the oddities' pass: the places' own props are every one before it. */
  firstProp: number;
  /** The oddities' solids: StaticWorld adds them after the places'. */
  solids: AttractionSolid[];
  poles: Pole[];
  spans: Span[];
  statics: Placed[];
  /** Gravel the pull-offs are laid with. */
  pads: Rect[];
  payphone: Payphone;
  cropCircle: CropCircle;
}

export function noOddities(): CountyOddities {
  return {
    firstProp: 0,
    solids: [],
    poles: [],
    spans: [],
    statics: [],
    pads: [],
    payphone: { x: 0, z: 0, rot: 0, at: { x: 0, z: 0 } },
    cropCircle: { field: -1, cx: 0, cz: 0, radius: 0, mown: [] },
  };
}

/** The wire `k` of a pole's four: where it leaves its insulator (x, y, z). */
export function insulator(p: Pole, k: number): [number, number, number] {
  const across = POLE.wires[k]!;
  return [p.x + Math.cos(p.rot) * across, p.y + POLE.wireY, p.z - Math.sin(p.rot) * across];
}

/** How far (m) a wire of length `span` hangs below the straight line between its ends, `t` (0..1) along it: a catenary. */
export function sagAt(span: number, t: number): number {
  const c = POLE.sag;
  const half = span / 2;
  return c * (Math.cosh(half / c) - Math.cosh(((t - 0.5) * span) / c));
}

/** Whether (x, z) is in a part of the pattern: mown flat. */
export function isMown(circle: CropCircle, x: number, z: number): boolean {
  return circle.mown.some((m) => {
    const d = Math.hypot(x - m.cx, z - m.cz);
    return d >= m.r0 && d <= m.r1;
  });
}

// ---------------------------------------------------------------------------
// Where everything stands

/** A solid's footprint in its oddity's own frame: u across it (the way (cos rot, -sin rot) points), d along it (the way it faces). */
interface Local {
  u0: number;
  u1: number;
  d0: number;
  d1: number;
  y0: number;
  y1: number;
  tag: AttractionSolid['tag'];
}

/** What each static oddity is solid in, as boxes in its own frame: the cow's trailer and tongue, the stand, the bus and so on. */
const SOLIDS: Readonly<Record<StaticKind, readonly Local[]>> = {
  cow: [
    { u0: -1.35, u1: 1.35, d0: -4.2, d1: 4.2, y0: 0, y1: 6.1, tag: 'building' },
    { u0: -0.3, u1: 0.3, d0: 4.2, d1: 6.6, y0: 0, y1: 0.9, tag: 'wall' },
  ],
  stand: [{ u0: -2, u1: 2, d0: -1.3, d1: 1.3, y0: 0, y1: 2.7, tag: 'building' }],
  diner: [],
  bigfoot: [],
  plaque: [{ u0: -1.0, u1: 1.0, d0: -0.48, d1: 0.48, y0: 0, y1: 1.0, tag: 'wall' }],
  pickup: [{ u0: -1.0, u1: 1.0, d0: -3.2, d1: 2.4, y0: 0, y1: 1.9, tag: 'building' }],
  bus: [{ u0: -1.25, u1: 1.25, d0: -5.0, d1: 5.7, y0: 0, y1: 3.1, tag: 'building' }],
  hives: [{ u0: -1.5, u1: 1.5, d0: -0.55, d1: 0.55, y0: 0, y1: 1.4, tag: 'bin' }],
  payphone: [{ u0: -0.6, u1: 0.6, d0: -0.6, d1: 0.6, y0: 0, y1: 2.6, tag: 'wall' }],
};

/** Their round solids: (u, d, radius, top, tag) in their frames: the diner sign's posts and the saucer beside it, Bigfoot. */
const ROUND: Readonly<Partial<Record<StaticKind, ReadonlyArray<readonly [number, number, number, number, AttractionSolid['tag']]>>>> = {
  // The posts stand under the board's ends (render/country/oddityModels.ts DINER_BOARD), the saucer lies by its end (DINER_SAUCER).
  diner: [[-3.1, 0, 0.17, 5.4, 'rock'], [3.1, 0, 0.17, 5.4, 'rock'], [5.4, -1.1, 2.1, 2.4, 'building']],
  bigfoot: [[0, 0, 1.0, 4.4, 'building']],
};

/** The static oddities, each 4 to 40 m off the road it is seen from. */
const STATICS: readonly Placed[] = [
  // The cow on her trailer faces east along the highway's south leg, her stand beside her with its counter to the road.
  { kind: 'cow', x: -1040, z: 288, rot: Math.PI / 2 },
  { kind: 'stand', x: -1022, z: 286, rot: Math.PI },
  // The diner's sign on the north straight, facing the traffic coming from Dry Creek.
  { kind: 'diner', x: -1190, z: -290, rot: 1.1 },
  // Bigfoot waves at the highway's west leg from his pull-off, his plaque beside him.
  { kind: 'bigfoot', x: -1346.5, z: -60, rot: Math.PI / 2 },
  { kind: 'plaque', x: -1342.3, z: -64, rot: Math.PI / 2 },
  // The pickup in the grass south of the north straight, the bus (henhouse) north of it, the bees on the west leg.
  { kind: 'pickup', x: -1050, z: -247, rot: Math.PI / 2 + 0.3 },
  { kind: 'bus', x: -1172, z: -299, rot: Math.PI / 2 },
  { kind: 'hives', x: -1312, z: -36, rot: -Math.PI / 2 },
];

/** The gravel pull-off Bigfoot stands at, off the highway's west leg. */
const PULL_OFF = mkRect(-1349, -84, -1338.2, -36);

/** The payphone, at Hollister Lane's northmost reach: nothing round it but corn and sea. */
const PAYPHONE: Placed = { kind: 'payphone', x: -972, z: -540, rot: 0 };

/** The mailboxes along the east side of Creek Road across from the dairy's drive: x, z, the way it faces (to the road, west) and its make (a ROADSIDE index). */
const MAILBOXES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-830.9, 6, -Math.PI / 2 + 0.08, 0],
  [-830.6, 9.4, -Math.PI / 2 - 0.1, 3],
  [-831.1, 12.9, -Math.PI / 2 + 0.04, 1],
  [-830.5, 16.2, -Math.PI / 2 + 0.14, 2],
  [-830.9, 19.7, -Math.PI / 2 - 0.06, 5],
  [-830.7, 23, -Math.PI / 2 + 0.02, 4],
];

/** The signs: x, z, the way each faces (towards the traffic it is meant for, a little round to the road) and which it is. */
const SIGNS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-1158, -285, Math.PI / 2 - 0.35, 6],
  [-1319, -41.5, Math.PI + 0.35, 7],
  [-872, 257, -Math.PI / 2 + 0.35, 8],
];

/**
 * The crop circle: a disc, two rings and a ring of six small discs between them, 50 m to its farthest ring, in the
 * north-west corner of the wheat field (the nearest to Lookout Point).
 */
function cropCircle(layout: CityLayout): CropCircle {
  const farms = layout.country.farms;
  const field = farms.fields.findIndex((f) => f.crop === 'wheat');
  const r = farms.fields[field]!.rect;
  const radius = 50;
  const cx = r.minX + radius + 3;
  const cz = r.minZ + radius + 3;
  const mown: Mown[] = [
    { cx, cz, r0: 0, r1: 10 },
    { cx, cz, r0: 17, r1: 21.5 },
    { cx, cz, r0: 29.5, r1: 32 },
    { cx, cz, r0: 41, r1: radius },
  ];
  for (let k = 0; k < 6; k++) mown.push({ cx: cx + Math.cos((k * Math.PI) / 3) * 36, cz: cz + Math.sin((k * Math.PI) / 3) * 36, r0: 0, r1: 4.5 });
  return { field, cx, cz, radius, mown };
}

/** The point (x, z) at u across and d along the frame of an oddity. */
export function inFrame(p: Placed, u: number, d: number): { x: number; z: number } {
  return { x: p.x + u * Math.cos(p.rot) + d * Math.sin(p.rot), z: p.z - u * Math.sin(p.rot) + d * Math.cos(p.rot) };
}

/** The axis-aligned box round a footprint u0..u1 by d0..d1 of an oddity. */
function box(p: Placed, l: Pick<Local, 'u0' | 'u1' | 'd0' | 'd1'>): Rect {
  const corners = [inFrame(p, l.u0, l.d0), inFrame(p, l.u1, l.d0), inFrame(p, l.u1, l.d1), inFrame(p, l.u0, l.d1)];
  return mkRect(Math.min(...corners.map((c) => c.x)), Math.min(...corners.map((c) => c.z)), Math.max(...corners.map((c) => c.x)), Math.max(...corners.map((c) => c.z)));
}

/** The box round everything of an oddity's that is solid, grown by `margin`: what the poles keep off. */
function footprint(p: Placed, margin: number): Rect {
  const rects = [
    ...SOLIDS[p.kind].map((l) => box(p, l)),
    ...(ROUND[p.kind] ?? []).map(([u, d, r]) => {
      const c = inFrame(p, u, d);
      return mkRect(c.x - r, c.z - r, c.x + r, c.z + r);
    }),
  ];
  return mkRect(
    Math.min(...rects.map((r) => r.minX)) - margin,
    Math.min(...rects.map((r) => r.minZ)) - margin,
    Math.max(...rects.map((r) => r.maxX)) + margin,
    Math.max(...rects.map((r) => r.maxZ)) + margin,
  );
}

// ---------------------------------------------------------------------------
// The poles

/** The side of each road its poles stand on: the right of its direction of travel (the outside of Hollister Lane's loop). */
const SIDE = 1;
/** The poles keep this far (m) from a farm drive's centre line, a farm sign or mailbox, and from the other drives' and the fire road's mouths. */
const DRIVE_CLEAR = 10;
const MOUTH_CLEAR = 14;
/** How far (m) past a ramp the lane that stunts run out along is kept free of solids, and how much wider (m) than the ramp it is each side. */
const RUN_OUT = 300;
const RUN_OUT_SIDE = 1.5;
/** A pole keeps this far (m) from an oddity's solids, a mailbox and a sign. */
export const ODDITY_CLEAR = 3;

/** The shortest distance (m) from (x, z) to the segment (ax, az)-(bx, bz). */
function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

/** Whether (x, z) is in the lane a ramp (the track's whoops and tabletops among them) throws a car along: no solid stands in it. */
function onRunOut(layout: CityLayout, x: number, z: number): boolean {
  return layout.ramps.some((r) => {
    // Ramps point along the axes.
    const fx = Math.round(Math.sin(r.heading));
    const fz = Math.round(Math.cos(r.heading));
    const along = (x - r.x) * fx + (z - r.z) * fz;
    const across = Math.abs((x - r.x) * fz - (z - r.z) * fx);
    return along > r.length / 2 + 0.5 && along < RUN_OUT && across < r.width / 2 + RUN_OUT_SIDE;
  });
}

/** Whether a pole may stand at (x, z): on the county's land, off the causeway's end, clear of the town, the junctions, every drive, the ramps' run-outs and the other oddities. */
function poleSite(layout: CityLayout, x: number, z: number, keepOut: readonly Rect[]): boolean {
  const country = layout.country;
  if (!onCountyLand(country, x, z) || x > -712 || plotAt(country, x, z)?.kind === 'town' || onRunOut(layout, x, z)) return false;
  for (const v of country.graph.vertices) if (v.half > 0 && Math.max(Math.abs(x - v.x), Math.abs(z - v.z)) < v.half + POLE.clear) return false;
  for (const f of country.farms.farmsteads) {
    const [ax, az, bx, bz] = f.drive;
    if (segDist(x, z, ax, az, bx, bz) < DRIVE_CLEAR) return false;
    // The farm's sign and mailbox stand by its drive's ends: they are inside that reach but for a pole off to the side.
    if (Math.hypot(x - f.sign.x, z - f.sign.z) < DRIVE_CLEAR || Math.hypot(x - f.mailbox.x, z - f.mailbox.z) < DRIVE_CLEAR) return false;
  }
  const { driveIn, track } = country.places;
  for (const d of [driveIn.drive, track.drive]) if (rectContains(d, x, z, MOUTH_CLEAR)) return false;
  if (keepOut.some((r) => rectContains(r, x, z))) return false;
  const [tx, tz] = FIRE_ROAD[0]!;
  return Math.hypot(x - tx, z - tz) >= MOUTH_CLEAR;
}

/** One road's poles in order along it, and the spans between those near enough to be strung. */
function poleLine(layout: CityLayout, road: CountryRoad, keepOut: readonly Rect[], poles: Pole[], spans: Span[]): void {
  const half = road.width / 2 + POLE.off;
  let last = -1;
  let s = 0;
  let next = POLE.gap / 2;
  for (let k = 2; k < road.pts.length; k += 2) {
    const ax = road.pts[k - 2]!;
    const az = road.pts[k - 1]!;
    const len = Math.hypot(road.pts[k]! - ax, road.pts[k + 1]! - az);
    const dx = (road.pts[k]! - ax) / len;
    const dz = (road.pts[k + 1]! - az) / len;
    for (; next <= s + len; next += POLE.gap) {
      const t = next - s;
      const x = ax + dx * t - dz * half * SIDE;
      const z = az + dz * t + dx * half * SIDE;
      if (!poleSite(layout, x, z, keepOut)) continue;
      const here = poles.length;
      poles.push({ x, y: countryGround(layout.country, x, z), z, rot: Math.atan2(dx, dz) });
      if (last >= 0 && Math.hypot(poles[last]!.x - x, poles[last]!.z - z) <= POLE.maxSpan) spans.push({ a: last, b: here });
      last = here;
    }
    s += len;
  }
}

/**
 * The oddities, the last of the county's content passes (after the landscape, the farms and the places): the static
 * ones with their solids, the mailboxes and signs as props, the payphone and the crop circle, and then the poles and the
 * wires along every county road, which keep clear of all of them.
 */
export function buildOddities(layout: CityLayout): void {
  const country = layout.country;
  const o = noOddities();
  country.oddities = o;
  o.firstProp = layout.props.length;
  const ground = (x: number, z: number) => countryGround(country, x, z);

  o.statics.push(...STATICS, PAYPHONE);
  for (const p of o.statics) {
    const y = ground(p.x, p.z);
    for (const l of SOLIDS[p.kind]) o.solids.push({ rect: box(p, l), y0: y + l.y0, y1: y + l.y1, tag: l.tag });
    for (const [u, d, r, top, tag] of ROUND[p.kind] ?? []) {
      const c = inFrame(p, u, d);
      o.solids.push({ rect: mkRect(c.x - r, c.z - r, c.x + r, c.z + r), y0: y, y1: y + top, tag, round: true });
    }
  }
  o.pads.push(PULL_OFF);
  o.payphone = { x: PAYPHONE.x, z: PAYPHONE.z, rot: PAYPHONE.rot, at: inFrame(PAYPHONE, 0, 1.3) };
  for (const [x, z, rot, shape] of [...MAILBOXES, ...SIGNS]) addProp(layout, 'roadside', x, z, rot, 1, ground(x, z)).color = shape;
  o.cropCircle = cropCircle(layout);

  const near = (x: number, z: number) => mkRect(x - ODDITY_CLEAR, z - ODDITY_CLEAR, x + ODDITY_CLEAR, z + ODDITY_CLEAR);
  const keepOut = [...o.statics.map((p) => footprint(p, ODDITY_CLEAR)), PULL_OFF, ...layout.props.slice(o.firstProp).map((p) => near(p.x, p.z))];
  for (const road of country.roads) poleLine(layout, road, keepOut, o.poles, o.spans);
  const r = POLE.base;
  for (const p of o.poles) o.solids.push({ rect: mkRect(p.x - r, p.z - r, p.x + r, p.z + r), y0: p.y, y1: p.y + POLE.h, tag: 'rock', round: true });
}
