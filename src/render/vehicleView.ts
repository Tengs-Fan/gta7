// Vehicle meshes built from extruded side profiles, plus per-vehicle views
// that follow the simulation (wheels, lights, sirens, damage).

import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { Vehicle } from '../sim/entities';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import { taxiSignTexture } from './textures';
import { addPanel, addPrism, displace, GeoBuilder, spanAt, topAt, type Pt } from './vehicleGeometry';
import { crackedGlassTexture, GLASS_TINT } from './vehicleTextures';

const BEVEL = 0.07;
/** Vertex shade of the cabin interior, window backings and wheel wells (paint is 1). */
const DARK = 0.08;
/** Clearance between a tyre and its wheel arch. */
const ARCH_GAP = 0.11;
/** Glass panels float this far above the bevelled body surface. */
const GLASS_LIFT = 0.015;
/** Wrecks settle this much lower, tilted by WRECK_ROLL to one side. */
const WRECK_SAG = 0.12;
const WRECK_ROLL = 0.05;
/** Lamps closer than this to a dent are smashed. */
const LAMP_BREAK_DIST = 0.8;
/** Tail lamp emissive intensity while braking (running lights 1.2, off 0.3). */
const BRAKE_GLOW = 1.8;

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
  const base = { panes: [] as Pane[], rearSeats: false };
  switch (kind) {
    case 'compact':
      return { ...base, body: P([[-0.5, 0.22], [0.49, 0.22], [0.5, 0.4], [0.47, 0.56], [0.24, 0.62], [-0.46, 0.63], [-0.5, 0.5]]), cabin: P([[0.25, 0.61], [0.07, 0.98], [-0.39, 0.98], [-0.47, 0.62]]), cabinInset: 0.1, wheelR: 0.31, wheelFront: 0.33, wheelRear: -0.32, lightY: 0.45 };
    case 'sports':
      return { ...base, body: P([[-0.5, 0.2], [0.5, 0.2], [0.5, 0.36], [0.32, 0.52], [-0.4, 0.62], [-0.5, 0.52]]), cabin: P([[0.22, 0.55], [0.02, 0.97], [-0.2, 0.97], [-0.4, 0.61]]), cabinInset: 0.14, wheelR: 0.34, wheelFront: 0.32, wheelRear: -0.31, lightY: 0.38 };
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
 * Dark interior inside a glass cabin, merged into the body: a floor over the painted body top, seat backs behind where
 * the sim seats the occupants (0.15 m ahead of the centre, 0.45 x the half width out; the rear row 0.9 m behind the
 * centre), a steering wheel in front of the driver (local +X) and a dashboard under the windshield.
 */
function addInterior(b: GeoBuilder, prof: Profile, kind: VehicleKind): void {
  const s = VEHICLE_SPECS[kind];
  const hw = s.width / 2;
  const cabinHalf = hw - prof.cabinInset;
  const c0 = Math.min(...prof.cabin.map((p) => p[0]));
  const c1 = Math.max(...prof.cabin.map((p) => p[0]));
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k <= 24; k++) {
    const t = topAt(prof.body, c0 + ((c1 - c0) * k) / 24) + BEVEL;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  // From below the body's surface to just above its highest point under the cabin.
  const floorTop = hi + 0.03;
  const fl = spanAt(prof.cabin, floorTop + 0.01);
  if (!fl) return;
  b.box(-(cabinHalf - 0.03), lo - 0.03, fl[0] + 0.03, cabinHalf - 0.03, floorTop, fl[1] - 0.03, DARK);
  // Ahead of the driver, but clear of the raked windshield at the rim's height.
  const ringR = 0.16;
  const ringY = floorTop + 0.02;
  const shield = spanAt(prof.cabin, ringY + ringR);
  const wheelZ = shield ? Math.min(0.5, shield[1] - 0.14) : 0.4;
  if (wheelZ > 0.22) {
    const ring = new THREE.TorusGeometry(ringR, 0.022, 4, 12);
    const m = new THREE.Matrix4().makeTranslation(hw * 0.45, ringY, wheelZ).multiply(new THREE.Matrix4().makeRotationX(0.45));
    b.geometry(ring, m, DARK);
    ring.dispose();
    const dashTop = floorTop + 0.09;
    const dash = spanAt(prof.cabin, dashTop);
    if (dash && dash[1] - 0.03 > wheelZ + 0.1) b.box(-(cabinHalf - 0.05), floorTop - 0.02, wheelZ + 0.05, cabinHalf - 0.05, dashTop, dash[1] - 0.03, DARK);
  }
  const seat = (z: number, x0: number, x1: number, maxH: number): void => {
    const h = Math.min(maxH, topAt(prof.cabin, z) - floorTop - 0.1);
    if (h > 0.12 && z - 0.06 > fl[0] + 0.05 && z + 0.06 < fl[1]) b.box(x0, floorTop - 0.02, z - 0.06, x1, floorTop + h, z + 0.06, DARK, -0.18);
  };
  seat(-0.09, hw * 0.45 - 0.24, hw * 0.45 + 0.24, 0.45);
  seat(-0.09, -hw * 0.45 - 0.24, -hw * 0.45 + 0.24, 0.45);
  if (prof.rearSeats) seat(-1.14, -(cabinHalf - 0.12), cabinHalf - 0.12, 0.38);
}

/**
 * Painted roof and window pillars over a glass cabin (merged into the body), so the see-through glass reads as windows
 * in a car body; a burnt-out wreck, whose glass is gone, keeps them as an empty frame. The cabin profile runs
 * front-bottom, front-top, rear-top, rear-bottom.
 */
function addRoof(b: GeoBuilder, prof: Profile, kind: VehicleKind): void {
  const s = VEHICLE_SPECS[kind];
  const cabinHalf = s.width / 2 - prof.cabinInset;
  const [fb, ft, rt, rb] = prof.cabin as [Pt, Pt, Pt, Pt];
  const glassBevel = 0.05;
  const top = Math.max(ft[1], rt[1]) + glassBevel;
  // The roof panel is subdivided like the body, so a roof dent bends it.
  const roof: Pt[] = [[rt[0] - 0.03, top - 0.015], [ft[0] + 0.03, top - 0.015], [ft[0] + 0.03, top + 0.035], [rt[0] - 0.03, top + 0.035]];
  addPrism(b, roof, { width: 2 * (cabinHalf + 0.012), bevel: 0.012, steps: 6, maxEdge: 0.2, steiner: 0 });
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -(cabinHalf + 0.012) : cabinHalf - 0.06;
    const x1 = side < 0 ? -(cabinHalf - 0.06) : cabinHalf + 0.012;
    // A pillars along the windshield, C pillars along the rear window.
    b.bar(x0, x1, fb, ft, 0.07, glassBevel * 0.5, 1, 0.03);
    b.bar(x0, x1, rt, rb, 0.07, glassBevel * 0.5, 1, 0.03);
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
    holes: box ? [prof.cabin] : [],
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
    // Wheel-well humps: the rear tyres reach above the bed floor.
    const wz = prof.wheelRear * s.length;
    const hump = prof.wheelR * 2 + 0.07;
    const reach = prof.wheelR + 0.1;
    bb.box(hw - 0.38, floorTop - 0.02, wz - reach, hw - 0.09, hump, wz + reach, 1);
    bb.box(-hw + 0.09, floorTop - 0.02, wz - reach, -hw + 0.38, hump, wz + reach, 1);
  }
  if (!box) {
    addInterior(bb, prof, kind);
    addRoof(bb, prof, kind);
  }
  const body = bb.build();
  const gb = new GeoBuilder();
  addPrism(gb, prof.cabin, { width: s.width - prof.cabinInset * 2, bevel: prof.cabinInset > 0 ? 0.05 : 0.01, steps: 4, maxEdge: spacing, steiner: spacing });
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

export class VehicleView {
  readonly group = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly cabin: THREE.Mesh;
  private readonly kindAssets: KindAssets;
  private readonly wheels: Array<{ pivot: THREE.Group; tire: THREE.Mesh; rim: THREE.Mesh; front: boolean }> = [];
  /** Head, tail and reverse lamps with their working material (smashed and burnt ones swap theirs out). */
  private readonly lamps: Array<{ mesh: THREE.Mesh; mat: THREE.Material; broken: boolean }> = [];
  private readonly headMat = new THREE.MeshStandardMaterial({ color: 0xfffbe8, emissive: 0xfff2c8, emissiveIntensity: 0.3, roughness: 0.2 });
  private readonly tailMat = new THREE.MeshStandardMaterial({ color: 0x2a0000, emissive: 0xff0000, emissiveIntensity: 0.3, roughness: 0.3 });
  private readonly reverseMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
  private sirenRed: THREE.MeshStandardMaterial | null = null;
  private sirenBlue: THREE.MeshStandardMaterial | null = null;
  /** Height above the wheel contact point that the body rotates about (half the mesh height). */
  private readonly pivotY: number;
  private readonly centre = new THREE.Vector3();
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
  private dentBody: THREE.BufferGeometry | null = null;
  private dentGlass: THREE.BufferGeometry | null = null;
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
        this.wheels.push({ pivot, tire, rim, front });
      }
    }
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
      this.lamps.push({ mesh: h, mat: this.headMat, broken: false }, { mesh: t, mat: this.tailMat, broken: false });
    }
    const rev = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.05), this.reverseMat);
    rev.position.set(0, ly - 0.05, -front);
    rev.name = 'lamp';
    this.group.add(rev);
    this.lamps.push({ mesh: rev, mat: this.reverseMat, broken: false });
    if (s.police) {
      const red = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff0000, emissiveIntensity: 0, roughness: 0.3 });
      const blue = new THREE.MeshStandardMaterial({ color: 0x000040, emissive: 0x0040ff, emissiveIntensity: 0, roughness: 0.3 });
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
      if (kind === 'police') {
        // White doors livery stripe.
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(s.width + 0.02, 0.3, s.length * 0.42), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4, metalness: 0.3 }));
        stripe.position.set(0, s.height * 0.45, 0.02 * s.length);
        this.group.add(stripe);
      }
    }
    if (kind === 'taxi') {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.22, 0.32), [taxiSignMat, taxiSignMat, taxiSignMat, taxiSignMat, taxiSignMat, taxiSignMat]);
      sign.position.set(0, s.height * 0.98 + 0.085 + 0.11, -0.08 * s.length);
      this.group.add(sign);
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
    this.group.visible = true;
  }

  /** Hands the view back to the pool: frees its dented geometry. */
  release(): void {
    this.restoreShape();
    this.group.visible = false;
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
    for (const l of this.lamps) l.broken = false;
    this.dentVersion = -1;
    this.applyLampMaterials();
  }

  /** Shows the vehicle's dents: displaced per-view copies of the body and glass, and the lamps near a dent smashed. */
  private applyDents(v: Vehicle): void {
    if (v.dents.length === 0) {
      this.restoreShape();
      this.dentVersion = v.dentVersion;
      return;
    }
    this.dentVersion = v.dentVersion;
    const a = this.kindAssets;
    if (!this.dentBody) {
      this.dentBody = a.body.clone();
      this.body.geometry = this.dentBody;
    }
    if (!this.dentGlass) {
      this.dentGlass = a.cabin.clone();
      this.cabin.geometry = this.dentGlass;
    }
    for (const [src, dst] of [[a.body, this.dentBody], [a.cabin, this.dentGlass]] as const) {
      const pos = dst.getAttribute('position') as THREE.BufferAttribute;
      displace(src.getAttribute('position').array, pos.array as Float32Array, v.dents);
      pos.needsUpdate = true;
      dst.computeVertexNormals();
    }
    for (const l of this.lamps) {
      const p = l.mesh.position;
      l.broken = v.dents.some((d) => Math.hypot(p.x - d.lx, p.y - d.ly, p.z - d.lz) < LAMP_BREAK_DIST);
    }
    this.applyLampMaterials();
  }

  private applyLampMaterials(): void {
    for (const l of this.lamps) l.mesh.material = this.burnt ? burntMat : l.broken ? brokenLampMat : l.mat;
  }

  private setBurnt(b: boolean): void {
    if (this.burnt === b) return;
    this.burnt = b;
    // The glass of a burnt-out wreck is gone.
    this.cabin.visible = !b;
    this.cabin.material = glassMat;
    for (const w of this.wheels) {
      w.tire.visible = !b;
      w.rim.material = b ? burntMat : rimMat;
    }
    // Views are pooled, so the lamps must also be restored when b is false.
    this.applyLampMaterials();
    if (b) {
      this.body.material = burntMat;
      this.color = -1;
    }
  }

  sync(v: Vehicle, dt: number, time: number, night: number): void {
    const s = v.spec;
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
    // Body lean from acceleration and cornering, scaled per vehicle class.
    const acc = dt > 0 ? (v.forwardSpeed - this.lastSpeed) / dt : 0;
    this.lastSpeed = v.forwardSpeed;
    const lat = v.angVel * v.forwardSpeed;
    const onGround = !v.airborne && !v.inWater;
    const pg = s.pitchGain;
    const rg = s.rollGain;
    // +rotation.x dips the nose (local +Z) and +rotation.z lifts local +X, the left side:
    // squat under acceleration, dive under braking, roll away from the turn centre.
    this.leanX = damp(this.leanX, onGround ? clamp(-acc * 0.006 * pg, -0.07 * pg, 0.07 * pg) : 0, 8, dt);
    this.leanZ = damp(this.leanZ, onGround ? clamp(lat * 0.006 * rg, -0.09 * rg, 0.09 * rg) : 0, 8, dt);
    const rot = this.group.rotation;
    rot.set(-v.pitch + this.leanX, v.heading, v.roll + this.leanZ + (this.burnt ? this.wreckRoll : 0));
    // Rotate about the body centre, not the wheel contact point at v.pos: a car on its roof
    // (roll = PI) then rests on the road instead of being mirrored underneath it.
    const c = this.centre.set(0, this.pivotY, 0).applyEuler(rot);
    // A burnt-out wreck sits low on its rims.
    this.group.position.set(v.pos.x - c.x, v.pos.y + this.pivotY - c.y - (this.burnt ? WRECK_SAG : 0), v.pos.z - c.z);

    // Front wheels at the angle the physics steers with (it shrinks with speed); spin from this kind's wheel radius.
    const steerAngle = -v.steer * Math.min(s.steer * 0.85, (s.steer / (1 + Math.abs(v.forwardSpeed) / 15)) * 1.3);
    this.spin += (v.forwardSpeed / this.kindAssets.prof.wheelR) * dt;
    if (Math.abs(this.spin) > 1e4) this.spin %= Math.PI * 2;
    for (const w of this.wheels) {
      if (w.front) w.pivot.rotation.y = steerAngle;
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
      this.sirenRed.emissiveIntensity = on && phase ? 9 : 0.1;
      this.sirenBlue.emissiveIntensity = on && !phase ? 9 : 0.1;
    }
  }
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
