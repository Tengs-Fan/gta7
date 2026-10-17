// Vehicle meshes built from extruded side profiles, plus per-vehicle views
// that follow the simulation (wheels, lights, sirens, damage).

import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { Vehicle } from '../sim/entities';
import { GUN_PORT, SKELETON } from '../sim/pose';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import { chaseOffset, CHASE_TARGET_Y } from './camera';
import { taxiSignTexture } from './textures';
import { addPanel, addPrism, DentedGeometry, displace, GeoBuilder, spanAt, topAt, type DentLike, type Pt } from './vehicleGeometry';
import { crackedGlassTexture, GLASS_TINT } from './vehicleTextures';

const BEVEL = 0.07;
/** Vertex shade of the cabin interior, window backings and wheel wells (paint is 1). */
const DARK = 0.08;
/** Clearance between a tyre and its wheel arch. */
const ARCH_GAP = 0.11;
/**
 * How far the body of a sedan (wheel radius 0.34, gains 1) may come down onto a planted wheel as it leans: the arch's
 * clearance over the tyre (about 4 cm once the body's bevel is counted) and 2 cm of the tyre tucking into its well as
 * the springs compress. Other classes travel in proportion to their wheels and how soft P42 makes them (leanRoom).
 */
const LEAN_ARCH_ROOM = 0.06;
const LEAN_WHEEL_R = 0.34;

/**
 * How far the body of a `kind` may come down onto a planted wheel as it leans (m): a stiff sports car on its low-profile
 * tyres a few centimetres, a soft van, pickup or bus on its big wheels about twice a sedan's. Long-travel classes so keep
 * the extra lean P42 gives them (rollGain, pitchGain) in hard braking and cornering instead of all meeting one limit,
 * and no tyre comes up through the bodywork over it.
 */
export function leanRoom(kind: VehicleKind): number {
  const s = VEHICLE_SPECS[kind];
  return LEAN_ARCH_ROOM * (profile(kind).wheelR / LEAN_WHEEL_R) * Math.max(s.pitchGain, s.rollGain);
}
/** Glass panels float this far above the bevelled body surface. */
const GLASS_LIFT = 0.015;
/** Bevel of a see-through cabin's glass (the glass prism bulges this far out of the cabin profile). */
const CABIN_GLASS_BEVEL = 0.05;
/** Wrecks settle this much lower, tilted by WRECK_ROLL to one side. */
const WRECK_SAG = 0.12;
const WRECK_ROLL = 0.05;
/** Lamps closer than this to a deep dent are smashed; shallower dents reach less far (see lampBreakRadius). */
const LAMP_BREAK_DIST = 0.8;
/** Tail lamp emissive intensity while braking (running lights 1.2, off 0.3). */
const BRAKE_GLOW = 1.8;

type Rgb = readonly [number, number, number];
/**
 * A light bar's lit red and blue lenses (linear RGB; unlit they fall to a tenth of plain red and blue). ACES tone-maps a
 * lamp far above 1 to a near-white core, so with bloom each one's luminance stays above the bloom threshold (2.6) and
 * the halo round it carries the colour. Without bloom (Low, or no half-float target) only that core is drawn, so they
 * stay where ACES keeps the hue: a red that reads red and a blue that reads blue (as props.ts LAMPS does for signals).
 */
const SIREN: Readonly<Record<'glow' | 'flat', { readonly red: Rgb; readonly blue: Rgb }>> = {
  glow: { red: [13, 0.4, 0.1], blue: [0.1, 1.6, 26] },
  flat: { red: [1, 0.02, 0.01], blue: [0.02, 0.1, 1.5] },
};
let sirenGlow = true;

/** Whether bloom draws halos round bright lights (GameRenderer.setQuality), which picks the light bars' colours (SIREN). */
export function setVehicleGlow(on: boolean): void {
  sirenGlow = on;
}

/**
 * How far from a dent of `depth` a lamp is smashed: nothing below 4 cm (a parking bump), growing to LAMP_BREAK_DIST at
 * 20 cm (a crash at about 18 m/s). A light knock breaks only the lamp it lands on.
 */
export function lampBreakRadius(depth: number): number {
  return LAMP_BREAK_DIST * clamp((depth - 0.04) / 0.16, 0, 1);
}

// ---------------------------------------------------------------------------
// The seat frame: where riders sit in a see-through cabin, shared by the interior built here and the riders CrowdView
// draws, so heads clear the roof and the seat backs, shoulders clear the waistline and the driver's hands hold the
// wheel that is drawn. Local frame of a vehicle view: +x left, +y up from the wheel contact point, +z forward.

/** The driver's steering wheel: rim centre (x on the driver's side), rim radius and the tilt of its top away from him. */
export interface SteeringWheel {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly tilt: number;
}

export interface CabinLayout {
  /** Top of the dark floor laid over the body under the glass: the waistline riders sit behind. */
  readonly floor: number;
  /** Hip joints of the front and the rear row, m ahead of the vehicle's centre (riders sit 0.45 x the half width out). */
  readonly frontZ: number;
  readonly rearZ: number | null;
  /** Recline of the seat backs, rad back from upright; riders lean back further when their heads or legs need it. */
  readonly recline: number;
  /** The lowest a rider's hip joint may sit: his thighs stay inside the body, over its floor pan. */
  readonly seatLow: number;
  readonly wheel: SteeringWheel;
  /** Side profile of the cabin glass: front-bottom, front-top, rear-top, rear-bottom. */
  readonly glass: readonly Pt[];
  /** The painted roof panel over the glass: its span along the car and its underside. */
  readonly roof: { readonly z0: number; readonly z1: number; readonly y: number };
}

/** A seated rider: hip joint height above the contact point and place along the car, and the torso's recline. */
export interface RiderSeat {
  y: number;
  z: number;
  recline: number;
}

/** A rider's shoulder joints sit this far above the cabin floor, so his shoulders show over the waistline. */
export const SEAT_SHOULDER_CLEAR = 0.02;
/** Room kept between a rider's head (or cap) and the roof or glass. */
export const SEAT_HEADROOM = 0.025;
/** Height of the back of the player's head (above its lowest point) that the chase camera sees past the roof. */
const CHASE_HEAD = 0.3;
/** Front seat backs reach this far above the floor: under a rider's head, so it shows from behind. */
const SEAT_BACK_TOP = 0.1;
const MAX_RECLINE = 0.8;
/** A seated rider's thighs reach this far under his hip joints (their half thickness and a margin). */
const THIGH_LOW = 0.11;
/** The steering wheel: rim radius, tilt, height of its centre above the floor and distance ahead of the driver's hips. */
const WHEEL_RADIUS = 0.16;
const WHEEL_TILT = 0.45;
const WHEEL_LIFT = 0.1;
const WHEEL_AHEAD = 0.22;

/** The lowest the roof or the glass comes over length position z of a cabin (what a rider's head must stay under). */
export function cabinCeiling(c: CabinLayout, z: number): number {
  if (z >= c.roof.z0 && z <= c.roof.z1) return c.roof.y;
  // Under the sloping glass: its outer surface lies a bevel off the profile; keep most of that as margin.
  return topAt(c.glass, z) + CABIN_GLASS_BEVEL * 0.4;
}

/** Head points that reach highest or furthest (hair or cap top, front and back; the cap's peak), head-local, x height. */
const HEAD_TOPS: ReadonlyArray<readonly [number, number]> = [
  [0.34, 0.13],
  [0.34, -0.14],
  [0.28, 0.125],
];
const CAP_TOPS: ReadonlyArray<readonly [number, number]> = [
  [0.365, 0.135],
  [0.365, -0.135],
  [0.295, 0.25],
];

/** How far the head of a rider seated at (y, z) with recline r pokes into the headroom (<= 0 when it fits). */
function headOver(c: CabinLayout, y: number, z: number, r: number, s: number, hat: boolean): number {
  const neckY = y + SKELETON.neckY * s * Math.cos(r);
  const neckZ = z - SKELETON.neckY * s * Math.sin(r);
  // The head is pitched forward by 0.8 of the recline (CrowdView), so it leans back by 0.2 of it.
  const ch = Math.cos(0.2 * r);
  const sh = Math.sin(0.2 * r);
  let over = -Infinity;
  for (const [ly, lz] of hat ? CAP_TOPS : HEAD_TOPS) {
    const py = neckY + (ly * ch + lz * sh) * s;
    const pz = neckZ + (-ly * sh + lz * ch) * s;
    over = Math.max(over, py + SEAT_HEADROOM - cabinCeiling(c, pz));
  }
  return over;
}

/**
 * Seats a rider of `height` (appearance.height) in the front or rear row: shoulders just above the floor, leaning back
 * like the seat, and sitting lower when his head or cap would not fit under the roof. Leaning back raises his hips
 * under shoulders at the same height, which keeps the legs of a rider in a low car inside its body (seatLow), and helps
 * his head where the roof comes down in front of it (a raked windscreen): the least recline that does best is taken.
 */
export function riderSeat(c: CabinLayout, rear: boolean, height: number, hat: boolean, out: RiderSeat): RiderSeat {
  const s = height;
  const z = rear && c.rearZ !== null ? c.rearZ : c.frontZ;
  const hipFor = (r: number): number => c.floor + SEAT_SHOULDER_CLEAR - SKELETON.shoulderY * s * Math.cos(r);
  // (Bounded: a head corner outside the cabin's length would see no roof at all.)
  const overAt = (r: number): number => clamp(headOver(c, hipFor(r), z, r, s, hat), 0, 0.5);
  let recline = c.recline;
  let over = overAt(recline);
  let fits = hipFor(recline) - over >= c.seatLow;
  if (over > 0 || !fits) {
    for (let r = c.recline + 0.04; r <= MAX_RECLINE + 1e-9; r += 0.04) {
      const o = overAt(r);
      const f = hipFor(r) - o >= c.seatLow;
      // Legs inside the car first; then shoulders as high as the head allows (5 mm better, or the lesser recline);
      // with neither possible, the highest hips.
      const better = f !== fits ? f : f ? o < over - 0.005 : hipFor(r) - o > hipFor(recline) - over;
      if (better) {
        recline = r;
        over = o;
        fits = f;
      }
    }
  }
  out.y = hipFor(recline) - over;
  out.z = z;
  out.recline = recline;
  return out;
}

const layouts = new Map<VehicleKind, CabinLayout | null>();

/** The seat frame of a vehicle kind, or null when nobody inside can be seen (vans and buses have dark windows). */
export function cabinLayout(kind: VehicleKind): CabinLayout | null {
  let l = layouts.get(kind);
  if (l === undefined) {
    const prof = profile(kind);
    l = prof.cabinInset < 0 ? null : computeLayout(kind, prof);
    layouts.set(kind, l);
  }
  return l;
}

function computeLayout(kind: VehicleKind, prof: Profile): CabinLayout {
  const s = VEHICLE_SPECS[kind];
  const hw = s.width / 2;
  const [, ft, rt] = prof.cabin as [Pt, Pt, Pt, Pt];
  const c0 = Math.min(...prof.cabin.map((p) => p[0]));
  const c1 = Math.max(...prof.cabin.map((p) => p[0]));
  let hi = -Infinity;
  for (let k = 0; k <= 24; k++) hi = Math.max(hi, topAt(prof.body, c0 + ((c1 - c0) * k) / 24) + BEVEL);
  // Just above the body's highest point under the cabin.
  const floor = hi + 0.03;
  const top = Math.max(ft[1], rt[1]) + CABIN_GLASS_BEVEL;
  // The steering wheel as far forward as the raked windscreen lets its rim pass under the glass, and the driver's seat
  // behind it (but no further forward than the simulation's seats, 0.15 m ahead of the centre).
  const wy = floor + WHEEL_LIFT;
  const rimTop = wy + WHEEL_RADIUS * Math.cos(WHEEL_TILT);
  const shield = spanAt(prof.cabin, rimTop + 0.03);
  const wzMax = (shield ? shield[1] : ft[0]) - 0.03 - WHEEL_RADIUS * Math.sin(WHEEL_TILT);
  const frontZ = Math.min(0.15, wzMax - WHEEL_AHEAD);
  const wheel = { x: hw * 0.45, y: wy, z: Math.min(wzMax, frontZ + WHEEL_AHEAD), radius: WHEEL_RADIUS, tilt: WHEEL_TILT };
  // The rear row far enough forward that its heads, tall and capped ones too, are under the roof, not the sloping rear
  // window.
  const rearZ = prof.rearSeats ? Math.max(-0.9, rt[0] + 0.4) : null;
  // Riders sit no lower than their thighs' depth over the body's bevelled floor pan.
  const seatLow = prof.body[0]![1] - BEVEL + THIGH_LOW;
  const layout = { floor, frontZ, rearZ, recline: 0.36, seatLow, wheel, glass: prof.cabin, roof: { z0: rt[0] - 0.03, z1: ft[0] + 0.03, y: top - 0.015 } };
  // The player's head must show through the rear window from the chase camera (camera.ts chaseOffset), which looks
  // steeply down past the roof's rear edge, most steeply at rest (at speed it drops and pulls back, zoomed out it stands
  // further off). Where the roof runs too far back for CHASE_HEAD of the back of his head to show under it, its painted
  // panel stops short and the glass under it carries on as a glass roof: 0.2-0.5 m of it on the cars, 1 m on the
  // compact hatchback, none on the pickup.
  const ref = riderSeat(layout, false, 1.02, false, { y: 0, z: 0, recline: 0 });
  const neckY = ref.y + SKELETON.neckY * 1.02 * Math.cos(ref.recline);
  const neckZ = ref.z - SKELETON.neckY * 1.02 * Math.sin(ref.recline);
  const zt = neckZ - 0.12 * 1.02;
  const yt = neckY + (0.02 + CHASE_HEAD) * 1.02;
  const cam = chaseOffset(s, 0, false);
  const camBack = cam.back;
  const camY = s.height * CHASE_TARGET_Y + cam.up;
  const edge = zt - ((layout.roof.y - yt) * (zt + camBack)) / (camY - yt);
  // A light bar or taxi sign keeps the roof under it.
  const gear = s.police ? -0.1 * s.length - 0.25 : kind === 'taxi' ? -0.08 * s.length - 0.25 : Infinity;
  layout.roof.z0 = Math.min(layout.roof.z1 - 0.6, gear, Math.max(layout.roof.z0, edge));
  return layout;
}

/** A window on a flat segment of the body profile (a -> b, in profile order), across x0..x1. */
interface Pane {
  a: Pt;
  b: Pt;
  x0: number;
  x1: number;
}

interface Profile {
  body: Pt[];
  cabin: Pt[];
  /** Positive: cabin narrower than the body. Negative: glass panels stick out slightly. */
  cabinInset: number;
  wheelR: number;
  wheelFront: number;
  wheelRear: number;
  lightY: number;
  /** Windshield and rear windows of box-shaped vehicles, whose cabin is part of the body. */
  panes: Pane[];
  /** More side windows of box-shaped vehicles, cut and glazed like the cab's (the riot van's gun ports). */
  ports: Pt[][];
  /** A rear bench behind the front seats. */
  rearSeats: boolean;
}

/** The point at fraction k along a -> b. */
function lerpPt(a: Pt, b: Pt, k: number): Pt {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}

function profile(kind: VehicleKind): Profile {
  const s = VEHICLE_SPECS[kind];
  const L = s.length;
  const H = s.height;
  const hw = s.width / 2;
  const P = (pts: Array<[number, number]>): Pt[] => pts.map(([x, y]) => [x * L, y * H]);
  const base = { panes: [] as Pane[], ports: [] as Pt[][], rearSeats: false };
  switch (kind) {
    case 'compact':
      return { ...base, body: P([[-0.5, 0.22], [0.49, 0.22], [0.5, 0.4], [0.47, 0.56], [0.24, 0.62], [-0.46, 0.63], [-0.5, 0.5]]), cabin: P([[0.25, 0.61], [0.07, 0.98], [-0.39, 0.98], [-0.47, 0.62]]), cabinInset: 0.1, wheelR: 0.31, wheelFront: 0.33, wheelRear: -0.32, lightY: 0.45 };
    case 'sports':
      return { ...base, body: P([[-0.5, 0.2], [0.5, 0.2], [0.5, 0.36], [0.32, 0.545], [-0.4, 0.545], [-0.5, 0.52]]), cabin: P([[0.22, 0.55], [0.02, 0.97], [-0.2, 0.97], [-0.4, 0.54]]), cabinInset: 0.14, wheelR: 0.32, wheelFront: 0.32, wheelRear: -0.31, lightY: 0.38 };
    case 'muscle':
      return { ...base, body: P([[-0.5, 0.22], [0.5, 0.22], [0.5, 0.5], [0.14, 0.62], [-0.3, 0.62], [-0.5, 0.56]]), cabin: P([[0.12, 0.61], [-0.02, 0.97], [-0.22, 0.97], [-0.34, 0.61]]), cabinInset: 0.12, wheelR: 0.36, wheelFront: 0.33, wheelRear: -0.31, lightY: 0.45 };
    case 'pickup': {
      // Cab plus an open bed: the body reaches the beltline only up to the cab's back wall, behind it the bed
      // floor's surface (the profile plus the bevel) lies at 0.42 of the height; side walls and a tailgate are boxes.
      const floor = 0.42 * H - BEVEL;
      const body = [...P([[-0.5, 0.22], [0.5, 0.22], [0.5, 0.45], [0.45, 0.55], [0.19, 0.58], [-0.16, 0.58]]), [-0.16 * L, floor] as Pt, [-0.5 * L, floor] as Pt];
      return { ...base, body, cabin: P([[0.18, 0.57], [0.07, 0.97], [-0.13, 0.97], [-0.15, 0.57]]), cabinInset: 0.08, wheelR: 0.42, wheelFront: 0.33, wheelRear: -0.3, lightY: 0.45 };
    }
    case 'van': {
      const body = P([[-0.5, 0.15], [0.5, 0.15], [0.5, 0.4], [0.43, 0.5], [0.3, 0.95], [-0.5, 0.97]]);
      const slopeA = body[3]!;
      const slopeB = body[4]!;
      const rearTop = body[5]!;
      const rearBottom = body[0]!;
      const x = hw - 0.14;
      return {
        ...base,
        body,
        // Side windows of the cab, clear of the windshield's pillar.
        cabin: P([[0.395, 0.53], [0.29, 0.9], [0.15, 0.9], [0.15, 0.53]]),
        cabinInset: -GLASS_LIFT,
        wheelR: 0.38,
        wheelFront: 0.33,
        wheelRear: -0.32,
        lightY: 0.3,
        panes: [
          { a: lerpPt(slopeA, slopeB, 0.07), b: lerpPt(slopeA, slopeB, 0.93), x0: -x, x1: x },
          // Two rear door windows.
          { a: lerpPt(rearTop, rearBottom, (0.97 - 0.86) / 0.82), b: lerpPt(rearTop, rearBottom, (0.97 - 0.56) / 0.82), x0: 0.06, x1: x },
          { a: lerpPt(rearTop, rearBottom, (0.97 - 0.86) / 0.82), b: lerpPt(rearTop, rearBottom, (0.97 - 0.56) / 0.82), x0: -x, x1: -0.06 },
        ],
      };
    }
    case 'swat': {
      const body = P([[-0.5, 0.16], [0.5, 0.16], [0.5, 0.42], [0.42, 0.52], [0.33, 0.95], [-0.5, 0.95]]);
      const slopeA = body[3]!;
      const slopeB = body[4]!;
      const rearTop = body[5]!;
      const rearBottom = body[0]!;
      const x = hw - 0.16;
      return {
        ...base,
        body,
        cabin: P([[0.39, 0.55], [0.325, 0.84], [0.22, 0.84], [0.22, 0.55]]),
        // Gun ports in the windowless back, for the crew in the rear seats (sim/pose.ts fires from them).
        ports: [P([[GUN_PORT.z1, GUN_PORT.y0], [GUN_PORT.z1, GUN_PORT.y1], [GUN_PORT.z0, GUN_PORT.y1], [GUN_PORT.z0, GUN_PORT.y0]])],
        cabinInset: -GLASS_LIFT,
        wheelR: 0.45,
        wheelFront: 0.33,
        wheelRear: -0.33,
        lightY: 0.32,
        panes: [
          { a: lerpPt(slopeA, slopeB, 0.1), b: lerpPt(slopeA, slopeB, 0.9), x0: -x, x1: x },
          // Small armoured rear windows.
          { a: lerpPt(rearTop, rearBottom, (0.95 - 0.82) / 0.79), b: lerpPt(rearTop, rearBottom, (0.95 - 0.62) / 0.79), x0: 0.16, x1: hw - 0.28 },
          { a: lerpPt(rearTop, rearBottom, (0.95 - 0.82) / 0.79), b: lerpPt(rearTop, rearBottom, (0.95 - 0.62) / 0.79), x0: -(hw - 0.28), x1: -0.16 },
        ],
      };
    }
    case 'bus': {
      const body = P([[-0.5, 0.12], [0.5, 0.12], [0.5, 0.95], [-0.5, 0.95]]);
      const fb = body[1]!;
      const ft = body[2]!;
      const rt = body[3]!;
      const rb = body[0]!;
      const span = 0.95 - 0.12;
      const front = (t: number): Pt => lerpPt(fb, ft, (t - 0.12) / span);
      const rear = (t: number): Pt => lerpPt(rt, rb, (0.95 - t) / span);
      return {
        ...base,
        body,
        cabin: P([[0.49, 0.42], [0.49, 0.86], [-0.47, 0.86], [-0.47, 0.42]]),
        cabinInset: -GLASS_LIFT,
        wheelR: 0.5,
        wheelFront: 0.36,
        wheelRear: -0.3,
        lightY: 0.22,
        panes: [
          { a: front(0.42), b: front(0.86), x0: -(hw - 0.12), x1: hw - 0.12 },
          // Destination sign above the windshield.
          { a: front(0.885), b: front(0.935), x0: -(hw - 0.3), x1: hw - 0.3 },
          { a: rear(0.86), b: rear(0.55), x0: -(hw - 0.3), x1: hw - 0.3 },
        ],
      };
    }
    case 'sedan':
    case 'taxi':
    case 'police':
    default:
      return { ...base, rearSeats: true, body: P([[-0.5, 0.22], [0.49, 0.22], [0.5, 0.38], [0.48, 0.56], [0.2, 0.64], [-0.32, 0.64], [-0.49, 0.58], [-0.5, 0.4]]), cabin: P([[0.21, 0.63], [0.03, 0.98], [-0.22, 0.98], [-0.36, 0.63]]), cabinInset: 0.1, wheelR: 0.34, wheelFront: 0.32, wheelRear: -0.3, lightY: 0.45 };
  }
}

/** Distance from p to the segment a -> b, and p's fraction along it. */
function segParam(p: Pt, a: Pt, b: Pt): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const k = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  return [Math.hypot(p[0] - a[0] - dx * k, p[1] - a[1] - dy * k), k];
}

/** Inserts the points of every pane (on its segment) into the profile, so window edges are profile vertices. */
function withPaneVertices(body: Pt[], panes: readonly Pane[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < body.length; i++) {
    const a = body[i]!;
    const b = body[(i + 1) % body.length]!;
    out.push(a);
    const extra: Array<[number, Pt]> = [];
    for (const pane of panes) {
      for (const p of [pane.a, pane.b]) {
        const [d, k] = segParam(p, a, b);
        if (d < 1e-6 && k > 1e-6 && k < 1 - 1e-6 && !extra.some((e) => Math.abs(e[0] - k) < 1e-6)) extra.push([k, p]);
      }
    }
    extra.sort((p, q) => p[0] - q[0]);
    for (const [, p] of extra) out.push(p);
  }
  return out;
}

/**
 * Cuts a wheel arch for every wheel into the profile's bottom edge (its first segment, rear to front), so the inset
 * wheels show from the side. An arch is capped below the body's top where the body is too low to clear the tyre.
 * Returns the profile and the arch segments (shaded as dark wheel wells).
 */
function withArches(body: Pt[], prof: Profile, L: number): { pts: Pt[]; arches: Array<[Pt, Pt]> } {
  const r0 = body[0]!;
  const f0 = body[1]!;
  const yb = r0[1];
  const out: Pt[] = [r0];
  const arches: Array<[Pt, Pt]> = [];
  for (const zc of [prof.wheelRear * L, prof.wheelFront * L]) {
    const cy = prof.wheelR;
    const R = prof.wheelR + ARCH_GAP;
    if (Math.abs(yb - cy) >= R) continue;
    let cap = cy + R;
    for (let k = 0; k <= 20; k++) cap = Math.min(cap, topAt(body, zc - R + (2 * R * k) / 20) - 0.09);
    if (cap < yb + 0.08) continue;
    const delta = Math.asin((yb - cy) / R);
    const arc: Pt[] = [];
    const N = 12;
    for (let k = 0; k <= N; k++) {
      const phi = Math.PI - delta - ((Math.PI - 2 * delta) * k) / N;
      arc.push([zc + R * Math.cos(phi), Math.min(cy + R * Math.sin(phi), cap)]);
    }
    arc[0]![1] = yb;
    arc[N]![1] = yb;
    for (let k = 0; k < N; k++) arches.push([arc[k]!, arc[k + 1]!]);
    out.push(...arc);
  }
  out.push(f0, ...body.slice(2));
  return { pts: out, arches };
}

/**
 * Dark interior inside a glass cabin, merged into the body, laid out by the seat frame (cabinLayout): a floor over the
 * painted body top, a steering wheel and a dashboard under the windshield, and low seat backs (and a rear bench) just
 * behind where riders' backs are, below their heads.
 */
function addInterior(b: GeoBuilder, prof: Profile, kind: VehicleKind, c: CabinLayout): void {
  const s = VEHICLE_SPECS[kind];
  const hw = s.width / 2;
  const cabinHalf = hw - prof.cabinInset;
  const c0 = Math.min(...prof.cabin.map((p) => p[0]));
  const c1 = Math.max(...prof.cabin.map((p) => p[0]));
  let lo = Infinity;
  for (let k = 0; k <= 24; k++) lo = Math.min(lo, topAt(prof.body, c0 + ((c1 - c0) * k) / 24) + BEVEL);
  const floor = c.floor;
  const fl = spanAt(prof.cabin, floor + 0.01);
  if (!fl) return;
  b.box(-(cabinHalf - 0.03), lo - 0.03, fl[0] + 0.03, cabinHalf - 0.03, floor, fl[1] - 0.03, DARK);
  const w = c.wheel;
  const ring = new THREE.TorusGeometry(w.radius, 0.022, 4, 12);
  b.geometry(ring, new THREE.Matrix4().makeTranslation(w.x, w.y, w.z).multiply(new THREE.Matrix4().makeRotationX(w.tilt)), DARK);
  ring.dispose();
  // The dash ahead of the wheel, low enough to leave the hands on the rim in view.
  const dashTop = floor + 0.05;
  const dash = spanAt(prof.cabin, dashTop);
  if (dash && dash[1] - 0.03 > w.z + 0.12) b.box(-(cabinHalf - 0.05), floor - 0.02, w.z + 0.06, cabinHalf - 0.05, dashTop, dash[1] - 0.03, DARK);
  // Seat backs: slabs reclined like the rider, their front face just behind the back of a rider of average size.
  const ref: RiderSeat = { y: 0, z: 0, recline: 0 };
  const back = (rear: boolean, x0: number, x1: number): void => {
    riderSeat(c, rear, 1, false, ref);
    const r = ref.recline;
    const depth = 0.125 * 1.08;
    const y0 = floor - 0.04;
    const t0 = (y0 - ref.y + depth * Math.sin(r)) / Math.cos(r);
    const zBack = ref.z - t0 * Math.sin(r) - depth * Math.cos(r) - 0.015 / Math.cos(r);
    const zc = zBack - 0.05;
    const h = (floor + SEAT_BACK_TOP - y0) / Math.cos(r);
    if (zc - 0.06 > fl[0] && zBack < fl[1]) b.box(x0, y0, zc - 0.05, x1, y0 + h, zc + 0.05, DARK, -r);
  };
  back(false, hw * 0.45 - 0.24, hw * 0.45 + 0.24);
  back(false, -hw * 0.45 - 0.24, -hw * 0.45 + 0.24);
  if (c.rearZ !== null) back(true, -(cabinHalf - 0.12), cabinHalf - 0.12);
}

/**
 * Painted roof and window pillars over a glass cabin (merged into the body), so the see-through glass reads as windows
 * in a car body; a burnt-out wreck, whose glass is gone, keeps them as an empty frame. The cabin profile runs
 * front-bottom, front-top, rear-top, rear-bottom.
 */
function addRoof(b: GeoBuilder, prof: Profile, kind: VehicleKind, c: CabinLayout): void {
  const s = VEHICLE_SPECS[kind];
  const cabinHalf = s.width / 2 - prof.cabinInset;
  const [fb, ft, rt, rb] = prof.cabin as [Pt, Pt, Pt, Pt];
  const glassBevel = CABIN_GLASS_BEVEL;
  const top = Math.max(ft[1], rt[1]) + glassBevel;
  // The roof panel is subdivided like the body, so a roof dent bends it; behind it a glass roof may carry on (see
  // computeLayout), framed by rails from the panel to the C pillars.
  const z0 = c.roof.z0;
  const roof: Pt[] = [[z0, top - 0.015], [ft[0] + 0.03, top - 0.015], [ft[0] + 0.03, top + 0.035], [z0, top + 0.035]];
  addPrism(b, roof, { width: 2 * (cabinHalf + 0.012), bevel: 0.012, steps: 6, maxEdge: 0.2, steiner: 0 });
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -(cabinHalf + 0.012) : cabinHalf - 0.06;
    const x1 = side < 0 ? -(cabinHalf - 0.06) : cabinHalf + 0.012;
    // A pillars along the windshield, C pillars along the rear window.
    b.bar(x0, x1, fb, ft, 0.07, glassBevel * 0.5, 1, 0.03);
    b.bar(x0, x1, rt, rb, 0.07, glassBevel * 0.5, 1, 0.03);
    // Rails over the glass roof's sides (profile order, so the bar sits outward, on top of the glass).
    if (z0 > rt[0] - 0.02) b.bar(x0, x1, [z0 + 0.02, rt[1]], rt, 0.07, glassBevel * 0.5, 1, 0.03);
    if (prof.rearSeats) {
      // B pillar between the front and rear side windows.
      const z = -0.42;
      b.box(side < 0 ? -(cabinHalf + 0.012) : cabinHalf - 0.04, topAt(prof.body, z) - 0.02, z - 0.045, side < 0 ? -(cabinHalf - 0.04) : cabinHalf + 0.012, top, z + 0.045, 1);
    }
  }
}

interface KindAssets {
  body: THREE.BufferGeometry;
  cabin: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  lamp: THREE.BufferGeometry;
  prof: Profile;
}

const assets = new Map<VehicleKind, KindAssets>();

function kindAssets(kind: VehicleKind): KindAssets {
  let a = assets.get(kind);
  if (a) return a;
  const s = VEHICLE_SPECS[kind];
  const prof = profile(kind);
  const hw = s.width / 2;
  const { pts, arches } = withArches(withPaneVertices(prof.body, prof.panes), prof, s.length);
  const onArch = (p: Pt, q: Pt): boolean => {
    const m: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    return arches.some(([a0, a1]) => segParam(m, a0, a1)[0] < 1e-6);
  };
  const inPane = (p: Pt, q: Pt, x: number): boolean => {
    const m: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    return prof.panes.some((w) => {
      const [d, k] = segParam(m, w.a, w.b);
      return d < 1e-6 && k > 0 && k < 1 && x > w.x0 && x < w.x1;
    });
  };
  const box = prof.cabinInset < 0;
  // Vertex spacing that dents can bend; coarser on the big vehicles.
  const spacing = s.length > 8 ? 0.45 : s.length > 5 ? 0.3 : 0.2;
  const bb = new GeoBuilder();
  addPrism(bb, pts, {
    width: s.width,
    bevel: BEVEL,
    steps: 4,
    maxEdge: spacing,
    steiner: spacing,
    extraX: prof.panes.flatMap((w) => [w.x0, w.x1]),
    // Side windows of box-shaped vehicles: dark backing behind the glass, cut into the flanks.
    holes: box ? [prof.cabin, ...prof.ports] : [],
    holeShade: DARK,
    sideShade: (p, q, x) => (onArch(p, q) || inPane(p, q, x) ? DARK : 1),
  });
  if (kind === 'pickup') {
    // Bed walls and tailgate, standing on the bed floor's edge up to just under the cab's beltline.
    const floorTop = 0.42 * s.height;
    const top = 0.58 * s.height + 0.05;
    const tail = -s.length / 2 - BEVEL;
    const cabBack = -0.16 * s.length - BEVEL;
    const floorEdge = floorTop - BEVEL;
    bb.box(hw - 0.09, floorEdge, tail, hw + 0.002, top, cabBack, 1);
    bb.box(-hw - 0.002, floorEdge, tail, -hw + 0.09, top, cabBack, 1);
    bb.box(-hw + 0.09, floorTop, tail, hw - 0.09, top, tail + 0.08, 1);
    // Wheel-well humps: the rear tyres reach above the bed floor, and come up further into them as the body leans.
    const wz = prof.wheelRear * s.length;
    const hump = prof.wheelR * 2 + leanRoom(kind) + 0.02;
    const reach = prof.wheelR + 0.1;
    bb.box(hw - 0.38, floorTop - 0.02, wz - reach, hw - 0.09, hump, wz + reach, 1);
    bb.box(-hw + 0.09, floorTop - 0.02, wz - reach, -hw + 0.38, hump, wz + reach, 1);
  }
  const layout = cabinLayout(kind);
  if (layout) {
    addInterior(bb, prof, kind, layout);
    addRoof(bb, prof, kind, layout);
  }
  const body = bb.build();
  const gb = new GeoBuilder();
  for (const glass of [prof.cabin, ...prof.ports]) addPrism(gb, glass, { width: s.width - prof.cabinInset * 2, bevel: prof.cabinInset > 0 ? 0.05 : 0.01, steps: 4, maxEdge: spacing, steiner: spacing });
  for (const w of prof.panes) {
    // Glass over the window's dark backing: outward from the profile by the bevel plus a gap.
    const dx = w.b[0] - w.a[0];
    const dy = w.b[1] - w.a[1];
    const len = Math.hypot(dx, dy);
    const off = BEVEL + GLASS_LIFT;
    const o = new THREE.Vector3(w.x0, w.a[1] + (-dx / len) * off, w.a[0] + (dy / len) * off);
    const u = new THREE.Vector3(w.x1 - w.x0, 0, 0);
    const v = new THREE.Vector3(0, dy, dx);
    addPanel(gb, o, u, v, Math.max(1, Math.ceil(u.length() / spacing)), Math.max(1, Math.ceil(len / spacing)), 1);
  }
  const cabin = gb.build();
  const wheel = new THREE.CylinderGeometry(prof.wheelR, prof.wheelR, 0.26, 16);
  wheel.rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(prof.wheelR * 0.62, prof.wheelR * 0.62, 0.28, 10);
  rim.rotateZ(Math.PI / 2);
  const lamp = new THREE.BoxGeometry(0.34, 0.14, 0.06);
  a = { body, cabin, wheel, rim, lamp, prof };
  assets.set(kind, a);
  return a;
}

// Shared materials.
/** Transparent tinted glass. A white map keeps it on the same shader as the cracked variants (no hitch on first damage). */
const GLASS = { transparent: true, opacity: 0.55, depthWrite: false, roughness: 0.05, envMapIntensity: 1.4 } as const;

function plainTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 4, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const glassMat = new THREE.MeshStandardMaterial({ color: GLASS_TINT, map: plainTexture(), ...GLASS });
/** Cracked (condition < 0.55) and shattered (< 0.25) glass; the tint is part of the texture. */
const crackedGlassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: crackedGlassTexture(false), ...GLASS });
const shatteredGlassMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: crackedGlassTexture(true), ...GLASS });
const tireMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0xc4c6c8, roughness: 0.3, metalness: 0.9 });
const burntMat = new THREE.MeshStandardMaterial({ color: 0x1d1b19, roughness: 1, metalness: 0.1 });
/** A smashed lamp: dark, never lit. */
const brokenLampMat = new THREE.MeshStandardMaterial({ color: 0x161616, emissive: 0x000000, emissiveIntensity: 0, roughness: 0.7 });
const bodyMats = new Map<number, THREE.MeshStandardMaterial>();

/** Body paint; the geometry's vertex shade darkens the interior and wheel wells within the same draw. */
function bodyMaterial(color: number): THREE.MeshStandardMaterial {
  let m = bodyMats.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.55, envMapIntensity: 1.25, vertexColors: true });
    bodyMats.set(color, m);
  }
  return m;
}

const taxiSignMat = new THREE.MeshStandardMaterial({ map: taxiSignTexture(), emissiveMap: taxiSignTexture(), emissive: 0xffffff, emissiveIntensity: 0.4 });

/** The shared window glass materials: intact, cracked and shattered. */
export const vehicleGlass = { intact: glassMat, cracked: crackedGlassMat, shattered: shatteredGlassMat } as const;

/** Glass for a vehicle's condition (0..1). */
export function glassFor(condition: number): THREE.Material {
  return condition < 0.25 ? shatteredGlassMat : condition < 0.55 ? crackedGlassMat : glassMat;
}

/** The view that last drew each vehicle (see drawnFrame). */
const drawing = new WeakMap<Vehicle, VehicleView>();

/**
 * The transform a vehicle's body was last drawn with: its view's local frame (+x left, +y up from the wheel contact
 * point, +z forward) to the world, with heading, pitch, roll, body lean and a wreck's sag; null when no view draws it.
 * Riders drawn by CrowdView sit in this frame, so they lean with the body.
 */
export function drawnFrame(v: Vehicle): THREE.Matrix4 | null {
  const view = drawing.get(v);
  return view && view.vehicle === v ? view.group.matrix : null;
}

export class VehicleView {
  readonly group = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly cabin: THREE.Mesh;
  private readonly kindAssets: KindAssets;
  /** Wheels with their pivot's place on the body: they stay planted on the road while the body leans. */
  private readonly wheels: Array<{ pivot: THREE.Group; tire: THREE.Mesh; rim: THREE.Mesh; front: boolean; base: THREE.Vector3 }> = [];
  /** Head, tail and reverse lamps with their working material (smashed and burnt ones swap theirs out) and place. */
  private readonly lamps: Array<{ mesh: THREE.Mesh; mat: THREE.Material; broken: boolean; base: THREE.Vector3; head: boolean }> = [];
  /** Separate parts on the body (lamps, roof gear) and where they sit undamaged: dents carry them along. */
  private readonly attached: Array<{ obj: THREE.Object3D; base: THREE.Vector3 }> = [];
  /** Livery and roof gear that char with a wreck (police stripe, light bar, taxi sign), with what they wear intact. */
  private readonly livery: Array<{ mesh: THREE.Mesh; mat: THREE.Material | THREE.Material[] }> = [];
  /** The police livery stripe: its own subdivided geometry, bent with the body, and its undamaged positions. */
  private stripe: { geo: THREE.BufferGeometry; base: Float32Array } | null = null;
  private readonly headMat = new THREE.MeshStandardMaterial({ color: 0xfffbe8, emissive: 0xfff2c8, emissiveIntensity: 0.3, roughness: 0.2 });
  private readonly tailMat = new THREE.MeshStandardMaterial({ color: 0x2a0000, emissive: 0xff0000, emissiveIntensity: 0.3, roughness: 0.3 });
  private readonly reverseMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
  private sirenRed: THREE.MeshStandardMaterial | null = null;
  private sirenBlue: THREE.MeshStandardMaterial | null = null;
  /** Height above the wheel contact point that the body rotates about (half the mesh height). */
  private readonly pivotY: number;
  /** How far the furthest axle sits from the body's centre, and the wheels' half track: the lean's lever arms. */
  private readonly axle: number;
  private readonly track: number;
  /** How far the body may come down onto a wheel as it leans (leanRoom). */
  private readonly room: number;
  private readonly centre = new THREE.Vector3();
  /** The point the body leans about on its springs: over the centre, at the height of the tyres' tops. */
  private readonly leanAxis: THREE.Vector3;
  private readonly leanTmp = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly qBody = new THREE.Quaternion();
  private readonly qPlanted = new THREE.Quaternion();
  private readonly qSteer = new THREE.Quaternion();
  private readonly yAxis = new THREE.Vector3(0, 1, 0);
  private leanX = 0;
  private leanZ = 0;
  private lastSpeed = 0;
  private burnt = false;
  /** Wheel rotation, accumulated from this view's own wheel radius. */
  private spin = 0;
  /** Roll a wreck settles at (its sign is picked per vehicle). */
  private wreckRoll = WRECK_ROLL;
  /** The vehicle's dentVersion this view shows (-1: not synced since bind). */
  private dentVersion = -1;
  /** Per-view dented copies of the body and glass geometry, or null while the shared ones are shown. */
  private dentBody: DentedGeometry | null = null;
  private dentGlass: DentedGeometry | null = null;
  /** The vehicle this view shows (null while pooled). */
  vehicle: Vehicle | null = null;
  color = -1;

  constructor(readonly kind: VehicleKind) {
    const a = kindAssets(kind);
    this.kindAssets = a;
    const s = VEHICLE_SPECS[kind];
    this.body = new THREE.Mesh(a.body, bodyMaterial(0xffffff));
    this.cabin = new THREE.Mesh(a.cabin, glassMat);
    this.body.name = 'body';
    this.cabin.name = 'glass';
    this.body.castShadow = true;
    this.cabin.castShadow = true;
    this.body.receiveShadow = true;
    this.group.add(this.body, this.cabin);
    const halfW = s.width / 2;
    for (const [front, z] of [[true, a.prof.wheelFront * s.length], [false, a.prof.wheelRear * s.length]] as const) {
      for (const side of [-1, 1]) {
        const pivot = new THREE.Group();
        // Inset so the tyre's outer face stays inside the body outline; the wheel arch shows it.
        pivot.position.set(side * (halfW - 0.15), a.prof.wheelR, z);
        const tire = new THREE.Mesh(a.wheel, tireMat);
        const rim = new THREE.Mesh(a.rim, rimMat);
        tire.name = 'tire';
        rim.name = 'rim';
        tire.castShadow = true;
        pivot.add(tire, rim);
        this.group.add(pivot);
        this.wheels.push({ pivot, tire, rim, front, base: pivot.position.clone() });
      }
    }
    // As the body leans, the arch over the furthest axle and the outer track comes down the most.
    this.axle = Math.max(Math.abs(a.prof.wheelFront), Math.abs(a.prof.wheelRear)) * s.length;
    this.track = halfW - 0.15;
    this.room = leanRoom(kind);
    this.leanAxis = new THREE.Vector3(0, 2 * a.prof.wheelR, 0);
    // Lights sit just outside the bevelled body surface so they are never buried.
    const ly = a.prof.lightY * s.height;
    const front = s.length / 2 + BEVEL + 0.02;
    for (const side of [-1, 1]) {
      const h = new THREE.Mesh(a.lamp, this.headMat);
      h.position.set(side * (halfW - 0.32), ly, front);
      const t = new THREE.Mesh(a.lamp, this.tailMat);
      t.position.set(side * (halfW - 0.3), ly + 0.05, -front);
      h.name = 'lamp';
      t.name = 'lamp';
      this.group.add(h, t);
      this.lamps.push({ mesh: h, mat: this.headMat, broken: false, base: h.position.clone(), head: true }, { mesh: t, mat: this.tailMat, broken: false, base: t.position.clone(), head: false });
    }
    const rev = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.05), this.reverseMat);
    rev.position.set(0, ly - 0.05, -front);
    rev.name = 'lamp';
    this.group.add(rev);
    this.lamps.push({ mesh: rev, mat: this.reverseMat, broken: false, base: rev.position.clone(), head: false });
    for (const l of this.lamps) this.attached.push({ obj: l.mesh, base: l.base });
    if (s.police) {
      // Emissive colours set by sync() (SIREN).
      const red = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.3 });
      const blue = new THREE.MeshStandardMaterial({ color: 0x000040, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.3 });
      this.sirenRed = red;
      this.sirenBlue = blue;
      // The cruiser's bar stands on its painted roof panel (see addRoof).
      const roofY = kind === 'swat' ? 0.95 * s.height : 0.98 * s.height + 0.085;
      const barZ = kind === 'swat' ? s.length * 0.3 : -0.1 * s.length;
      const base = new THREE.Mesh(new THREE.BoxGeometry(s.width * 0.7, 0.08, 0.32), new THREE.MeshStandardMaterial({ color: 0x222222 }));
      base.position.set(0, roofY + 0.04, barZ);
      const r = new THREE.Mesh(new THREE.BoxGeometry(s.width * 0.32, 0.14, 0.28), red);
      r.position.set(s.width * 0.18, roofY + 0.14, barZ);
      const b = new THREE.Mesh(new THREE.BoxGeometry(s.width * 0.32, 0.14, 0.28), blue);
      b.position.set(-s.width * 0.18, roofY + 0.14, barZ);
      this.group.add(base, r, b);
      this.attached.push({ obj: base, base: base.position.clone() }, { obj: r, base: r.position.clone() }, { obj: b, base: b.position.clone() });
      for (const m of [base, r, b]) this.livery.push({ mesh: m, mat: m.material as THREE.Material });
      if (kind === 'police') {
        // White doors livery stripe, subdivided so a side dent bends it with the doors under it.
        const geo = new THREE.BoxGeometry(s.width + 0.02, 0.3, s.length * 0.42, 1, 2, 10);
        geo.translate(0, s.height * 0.45, 0.02 * s.length);
        const stripe = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4, metalness: 0.3 }));
        this.group.add(stripe);
        this.stripe = { geo, base: Float32Array.from(geo.getAttribute('position').array) };
        this.livery.push({ mesh: stripe, mat: stripe.material as THREE.Material });
      }
    }
    if (kind === 'taxi') {
      const signMats = [taxiSignMat, taxiSignMat, taxiSignMat, taxiSignMat, taxiSignMat, taxiSignMat];
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.22, 0.32), signMats);
      sign.position.set(0, s.height * 0.98 + 0.085 + 0.11, -0.08 * s.length);
      this.group.add(sign);
      this.attached.push({ obj: sign, base: sign.position.clone() });
      this.livery.push({ mesh: sign, mat: signMats });
    }
    this.group.rotation.order = 'YXZ';
    // Includes roof gear (light bar, taxi sign), so a car on its roof rests on it.
    this.pivotY = new THREE.Box3().setFromObject(this.group).max.y / 2;
  }

  bind(v: Vehicle): void {
    this.restoreShape();
    this.setBurnt(false);
    this.color = -1;
    this.leanX = 0;
    this.leanZ = 0;
    this.lastSpeed = v.forwardSpeed;
    this.spin = 0;
    this.wreckRoll = (Math.imul(v.id, 0x9e3779b1) >>> 16) & 1 ? WRECK_ROLL : -WRECK_ROLL;
    this.vehicle = v;
    this.group.visible = true;
  }

  /** Hands the view back to the pool: frees its dented geometry. */
  release(): void {
    this.restoreShape();
    this.vehicle = null;
    this.group.visible = false;
  }

  /** Head lamps that still work (0-2): smashed or burnt ones are dark. */
  get headLamps(): number {
    if (this.burnt) return 0;
    let n = 0;
    for (const l of this.lamps) if (l.head && !l.broken) n++;
    return n;
  }

  /** Back to the kind's shared, undamaged geometry and working lamps. */
  private restoreShape(): void {
    if (this.dentBody) {
      this.body.geometry = this.kindAssets.body;
      this.dentBody.dispose();
      this.dentBody = null;
    }
    if (this.dentGlass) {
      this.cabin.geometry = this.kindAssets.cabin;
      this.dentGlass.dispose();
      this.dentGlass = null;
    }
    for (const a of this.attached) a.obj.position.copy(a.base);
    if (this.stripe && this.stripeBent) {
      const pos = this.stripe.geo.getAttribute('position') as THREE.BufferAttribute;
      (pos.array as Float32Array).set(this.stripe.base);
      pos.needsUpdate = true;
      this.stripe.geo.computeVertexNormals();
      this.stripeBent = false;
    }
    for (const l of this.lamps) l.broken = false;
    this.dentVersion = -1;
    this.applyLampMaterials();
  }

  /** Whether the stripe's geometry is bent (restoreShape puts it back). */
  private stripeBent = false;

  /**
   * Shows the vehicle's dents: displaced per-view copies of the body and glass, the lamps, roof gear and livery carried
   * along with the metal, and the lamps a dent reaches smashed (how far one reaches grows with its depth).
   */
  private applyDents(v: Vehicle): void {
    if (v.dents.length === 0) {
      this.restoreShape();
      this.dentVersion = v.dentVersion;
      return;
    }
    this.dentVersion = v.dentVersion;
    const a = this.kindAssets;
    if (!this.dentBody) {
      this.dentBody = new DentedGeometry(a.body);
      this.body.geometry = this.dentBody.geometry;
    }
    this.dentBody.update(v.dents);
    // The glass is copied only once a dent reaches it (most crashes stay below the windows).
    if (!this.dentGlass && v.dents.some((d) => reaches(d, a.cabin))) {
      this.dentGlass = new DentedGeometry(a.cabin);
      this.cabin.geometry = this.dentGlass.geometry;
    }
    this.dentGlass?.update(v.dents);
    // Parts on the body move with the metal under them.
    const p3 = new Float32Array(3);
    for (const part of this.attached) {
      displace([part.base.x, part.base.y, part.base.z], p3, v.dents);
      part.obj.position.set(p3[0]!, p3[1]!, p3[2]!);
    }
    if (this.stripe) {
      const pos = this.stripe.geo.getAttribute('position') as THREE.BufferAttribute;
      displace(this.stripe.base, pos.array as Float32Array, v.dents);
      pos.needsUpdate = true;
      this.stripe.geo.computeVertexNormals();
      this.stripeBent = true;
    }
    for (const l of this.lamps) {
      const p = l.base;
      l.broken = v.dents.some((d) => Math.hypot(p.x - d.lx, p.y - d.ly, p.z - d.lz) < lampBreakRadius(d.depth));
    }
    this.applyLampMaterials();
  }

  private applyLampMaterials(): void {
    for (const l of this.lamps) l.mesh.material = this.burnt ? burntMat : l.broken ? brokenLampMat : l.mat;
  }

  private setBurnt(b: boolean): void {
    if (this.burnt === b) return;
    this.burnt = b;
    // The glass of a burnt-out wreck is gone, and its livery, light bar and taxi sign are charred with the rest.
    this.cabin.visible = !b;
    this.cabin.material = glassMat;
    for (const w of this.wheels) {
      w.tire.visible = !b;
      w.rim.material = b ? burntMat : rimMat;
    }
    for (const l of this.livery) l.mesh.material = b ? burntMat : l.mat;
    // Views are pooled, so the lamps must also be restored when b is false.
    this.applyLampMaterials();
    if (b) {
      this.body.material = burntMat;
      this.color = -1;
    }
  }

  sync(v: Vehicle, dt: number, time: number, night: number): void {
    const s = v.spec;
    this.vehicle = v;
    drawing.set(v, this);
    // A car that drowned is destroyed too, but not burnt out; a wreck that is already burnt stays so.
    if (v.destroyed && !v.inWater) this.setBurnt(true);
    else if (!this.burnt && this.color !== v.color) {
      this.setBurnt(false);
      this.body.material = bodyMaterial(v.color);
      this.color = v.color;
    }
    if (v.dentVersion !== this.dentVersion) this.applyDents(v);
    if (!this.burnt) {
      const glass = glassFor(v.condition);
      if (this.cabin.material !== glass) this.cabin.material = glass;
    }
    // Body lean from acceleration and cornering, scaled per vehicle class, and never so far that a wheel arch comes
    // down onto a tyre (long and tall vehicles reach that sooner).
    const acc = dt > 0 ? (v.forwardSpeed - this.lastSpeed) / dt : 0;
    this.lastSpeed = v.forwardSpeed;
    const lat = v.angVel * v.forwardSpeed;
    const onGround = !v.airborne && !v.inWater;
    const pg = s.pitchGain;
    const rg = s.rollGain;
    // +rotation.x dips the nose (local +Z) and +rotation.z lifts local +X, the left side:
    // squat under acceleration, dive under braking, roll away from the turn centre.
    let pitch = clamp(-acc * 0.006 * pg, -0.07 * pg, 0.07 * pg);
    let roll = clamp(lat * 0.006 * rg, -0.09 * rg, 0.09 * rg);
    // Diving and rolling both bring a corner's wheel arch down onto its tyre: together they share the class's room.
    const drop = this.axle * Math.abs(pitch) + this.track * Math.abs(roll);
    if (drop > this.room) {
      pitch *= this.room / drop;
      roll *= this.room / drop;
    }
    this.leanX = damp(this.leanX, onGround ? pitch : 0, 8, dt);
    this.leanZ = damp(this.leanZ, onGround ? roll : 0, 8, dt);
    // A burnt-out wreck sits low on its rims, tilted, while it stands on its wheels; on its roof or side it rests on that.
    const upright = this.burnt ? Math.max(0, Math.cos(v.roll)) * Math.max(0, Math.cos(v.pitch)) : 0;
    const bodyRoll = v.roll + this.wreckRoll * upright;
    // The planted pose rotates about the body centre, not the wheel contact point at v.pos: a car on its roof (roll = PI)
    // then rests on the road instead of being mirrored underneath it.
    this.qPlanted.setFromEuler(this.euler.set(-v.pitch, v.heading, bodyRoll, 'YXZ'));
    const c = this.centre.set(0, this.pivotY, 0).applyQuaternion(this.qPlanted);
    const px = v.pos.x - c.x;
    const py = v.pos.y + this.pivotY - c.y - WRECK_SAG * upright;
    const pz = v.pos.z - c.z;
    // The body leans on its springs about the axis through its tyres' tops, so the wheel arches stay over the planted
    // tyres instead of swinging off them sideways.
    const rot = this.group.rotation;
    rot.set(-v.pitch + this.leanX, v.heading, bodyRoll + this.leanZ);
    this.qBody.setFromEuler(rot);
    const lean = this.leanAxis;
    const a = this.centre.copy(lean).applyQuaternion(this.qPlanted);
    const b = this.leanTmp.copy(lean).applyQuaternion(this.qBody);
    this.group.position.set(px + a.x - b.x, py + a.y - b.y, pz + a.z - b.z);
    this.group.updateMatrix();
    // The wheels stay where the planted body would put them: on the road (the lean is the body on its springs).
    const undo = this.qBody.invert().multiply(this.qPlanted);

    // Front wheels follow the physics' steering limit, which shrinks with speed (steer / (1 + |v| / 15)), shown 30%
    // larger so it reads at speed and capped at 85% of full lock; they spin by this kind's own wheel radius.
    const steerAngle = -v.steer * Math.min(s.steer * 0.85, (s.steer / (1 + Math.abs(v.forwardSpeed) / 15)) * 1.3);
    this.spin += (v.forwardSpeed / this.kindAssets.prof.wheelR) * dt;
    if (Math.abs(this.spin) > 1e4) this.spin %= Math.PI * 2;
    for (const w of this.wheels) {
      w.pivot.position.copy(w.base).sub(lean).applyQuaternion(undo).add(lean);
      w.pivot.quaternion.copy(undo);
      if (w.front) w.pivot.quaternion.multiply(this.qSteer.setFromAxisAngle(this.yAxis, steerAngle));
      w.tire.rotation.x = this.spin;
      w.rim.rotation.x = this.spin;
    }
    // Parked, abandoned and wrecked cars keep their lights off (a deployed police car keeps its siren running).
    const powered = !v.destroyed && (v.driver !== null || v.siren);
    const lightsOn = night > 0.35 && powered;
    this.headMat.emissiveIntensity = powered ? 0.4 + night * 5 : 0.3;
    // Braking stays at 1.8: brighter red saturates under ACES tone mapping and turns orange (3 renders as 255, 130, 67).
    this.tailMat.emissiveIntensity = v.destroyed ? 0 : v.braking ? BRAKE_GLOW : lightsOn ? 1.2 : 0.3;
    this.reverseMat.emissiveIntensity = v.reversing && v.driver ? 4 : 0;
    if (this.sirenRed && this.sirenBlue) {
      const on = v.siren && !v.destroyed;
      const phase = Math.floor(time * 6) % 2 === 0;
      const lit = SIREN[sirenGlow ? 'glow' : 'flat'];
      if (on && phase) this.sirenRed.emissive.setRGB(...lit.red);
      else this.sirenRed.emissive.setRGB(0.1, 0, 0);
      if (on && !phase) this.sirenBlue.emissive.setRGB(...lit.blue);
      else this.sirenBlue.emissive.setRGB(0, 0.005, 0.1);
    }
  }
}

/** Whether a dent reaches into a geometry's bounding box. */
function reaches(d: DentLike, g: THREE.BufferGeometry): boolean {
  if (!g.boundingBox) g.computeBoundingBox();
  const b = g.boundingBox!;
  const r = 0.6 + d.depth;
  return d.lx + r > b.min.x && d.lx - r < b.max.x && d.ly + r > b.min.y && d.ly - r < b.max.y && d.lz + r > b.min.z && d.lz - r < b.max.z;
}

/** Pools vehicle views per kind so meshes are reused instead of rebuilt. */
export class VehicleViewPool {
  private readonly free = new Map<VehicleKind, VehicleView[]>();

  acquire(kind: VehicleKind): VehicleView {
    const list = this.free.get(kind);
    const v = list?.pop();
    return v ?? new VehicleView(kind);
  }

  release(view: VehicleView): void {
    view.release();
    let list = this.free.get(view.kind);
    if (!list) {
      list = [];
      this.free.set(view.kind, list);
    }
    list.push(view);
  }
}
