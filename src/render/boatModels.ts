// The boat models BoatView draws, and the cabin cruisers moored at the Marina (props.ts): procedural planing hulls
// (hullGeometry.ts) with their fittings. The Kenney watercraft in the asset sources fit the specs badly (1.3-2.6 times
// too wide or tall at the spec length) and are a few hundred triangles of boxes, so none is imported.
//
// Speedboat: a runabout with a foredeck, a wraparound glass windscreen, helm and passenger seats behind it, the helm
// console with its wheel, a rear bench, bow and cockpit rails, a rub rail and a big outboard (cowling, leg, gearcase,
// skeg, three-blade propeller). Dinghy: a rigid inflatable, its hard vee hull under grey tubes with grab lines, two
// thwarts and a tiller outboard. Each is one painted draw (the speedboat's topsides and transom, the dinghy's tubes),
// one palette draw for the rest, the windscreen glass, and the foam ring BoatView lays at the waterline.

import * as THREE from 'three';
import type { VehicleKind } from '../sim/specs';
import { VEHICLE_SPECS } from '../sim/specs';
import { cockpitGeometry, foredeckGeometry, hullSection, hullSkin, stations, waterline, type HullSpec } from './hullGeometry';
import type { RiderSeatLayout } from './riders';
import { assemble, assemblePainted, assembleShape, block, gridSurface, lathe, loft, rod, sweep, V, type PartList, type Section } from './shapeKit';

export type BoatStyle = 'speedboat' | 'dinghy';

export interface BoatLamp {
  at: THREE.Vector3;
  size: THREE.Vector3;
  /** 1 faces forward (a bow light, glowing ahead), -1 aft. */
  facing: 1 | -1;
}

export interface BoatModel {
  style: BoatStyle;
  hull: HullSpec;
  length: number;
  width: number;
  /** Top of the gunwale amidships, the cockpit sole and the keel, above the waterline (m). */
  gunwale: number;
  floor: number;
  keel: number;
  painted: THREE.BufferGeometry;
  fittings: THREE.BufferGeometry;
  glass: THREE.BufferGeometry | null;
  shadow: THREE.BufferGeometry;
  /** The waterline at rest (x, z), closed, evenly spaced. */
  waterline: THREE.Vector2[];
  bowLamp: BoatLamp;
  sternLamp: BoatLamp;
  /** Whether the bow lamp lights the water ahead like a head lamp (the speedboat's) or is a running light only. */
  headLamp: boolean;
  seats: RiderSeatLayout[];
  /** Where the driver holds on (left hand, right hand): the wheel's rim or the tiller's grip, and which do count. */
  helm: { points: THREE.Vector3[]; hands: number[] };
  /** The driver's seat top. */
  seatTop: number;
  /** The outboard's own parts (for tests: a cowling, a leg and a propeller). */
  outboard: string[];
}

const P = (x: number, y: number, z: number) => ({ x, y, z });

/** The hand's target off a held point, so the wrist (SKELETON.hand short of the hand's centre) lands on it. */
function handOn(at: THREE.Vector3, forearm: THREE.Vector3, reach = 0.025): THREE.Vector3 {
  return at.clone().addScaledVector(forearm.clone().normalize(), reach);
}

const toP = (v: THREE.Vector3) => P(v.x, v.y, v.z);

/** An outboard hung on the transom at (0, mountY, z0): cowling, leg, cavitation plate, gearcase, skeg, propeller. */
function outboard(parts: PartList, z0: number, mountY: number, size: number, propY: number, white: boolean): string[] {
  const s = size;
  const cowl = white ? 'cowlWhite' : 'cowl';
  const cy = mountY + 0.33 * s;
  const names: string[] = [];
  const add = (name: string, g: THREE.BufferGeometry, f: Parameters<typeof assemble>[0][number][2]) => {
    parts.push([name, g, f]);
    names.push(name);
  };
  add('bracket', block(0.16 * s, 0.3 * s, 0.1 * s, 0, mountY, z0 - 0.05 * s, 4, 10), 'cowl');
  add('cowling', loft([
    { z: z0 - 0.52 * s, y: cy, w: 0.07 * s, up: 0.1 * s, down: 0.12 * s, n: 2.4 },
    { z: z0 - 0.47 * s, y: cy, w: 0.17 * s, up: 0.2 * s, down: 0.22 * s, n: 2.6 },
    { z: z0 - 0.33 * s, y: cy + 0.02 * s, w: 0.22 * s, up: 0.25 * s, down: 0.25 * s, n: 2.8 },
    { z: z0 - 0.17 * s, y: cy, w: 0.22 * s, up: 0.24 * s, down: 0.26 * s, n: 2.8 },
    { z: z0 - 0.07 * s, y: cy - 0.02 * s, w: 0.17 * s, up: 0.18 * s, down: 0.24 * s, n: 2.6 },
  ], 18), cowl);
  add('cowlingBand', loft([
    { z: z0 - 0.48 * s, y: cy - 0.13 * s, w: 0.165 * s, up: 0.05 * s, down: 0.12 * s, n: 3 },
    { z: z0 - 0.08 * s, y: cy - 0.13 * s, w: 0.18 * s, up: 0.05 * s, down: 0.13 * s, n: 3 },
  ], 16), 'dash');
  // The leg: a streamlined strut from under the cowling down to the gearcase.
  const legTop = cy - 0.2 * s;
  const legMid = (legTop + propY) / 2;
  const legHalf = (legTop - propY) / 2;
  add('leg', loft([
    { z: z0 - 0.38 * s, y: legMid, w: 0.012, up: legHalf, down: legHalf, n: 4 },
    { z: z0 - 0.33 * s, y: legMid, w: 0.045 * s, up: legHalf, down: legHalf, n: 4 },
    { z: z0 - 0.2 * s, y: legMid, w: 0.05 * s, up: legHalf, down: legHalf, n: 4 },
    { z: z0 - 0.13 * s, y: legMid, w: 0.02, up: legHalf, down: legHalf, n: 4 },
  ], 12), cowl);
  add('plate', block(0.3 * s, 0.012, 0.28 * s, 0, propY + 0.18 * s, z0 - 0.26 * s, 8, 10), 'cowl');
  add('gearcase', loft([
    { z: z0 - 0.43 * s, y: propY, w: 0.04 * s, up: 0.045 * s, down: 0.045 * s, n: 2 },
    { z: z0 - 0.36 * s, y: propY, w: 0.065 * s, up: 0.07 * s, down: 0.07 * s, n: 2 },
    { z: z0 - 0.14 * s, y: propY, w: 0.06 * s, up: 0.065 * s, down: 0.065 * s, n: 2 },
    { z: z0 - 0.07 * s, y: propY, w: 0.02, up: 0.025, down: 0.025, n: 2 },
  ], 12), cowl);
  add('skeg', loft([
    { z: z0 - 0.36 * s, y: propY - 0.11 * s, w: 0.012, up: 0.06 * s, down: 0.05 * s, n: 3 },
    { z: z0 - 0.18 * s, y: propY - 0.09 * s, w: 0.012, up: 0.04 * s, down: 0.03 * s, n: 3 },
  ], 8), cowl);
  // Three-blade propeller behind the gearcase.
  const pz = z0 - 0.47 * s;
  add('propHub', lathe([[[pz - 0.05 * s, 0], [pz - 0.035 * s, 0.032 * s], [pz + 0.04 * s, 0.04 * s], [pz + 0.05 * s, 0]]], 12, 'z').translate(0, propY, 0), 'steel');
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3 + 0.4;
    const blade = loft([
      { z: 0.02 * s, y: 0, w: 0.04 * s, up: 0.006, down: 0.006, n: 2 },
      { z: 0.09 * s, y: 0, w: 0.065 * s, up: 0.005, down: 0.005, n: 2 },
      { z: 0.16 * s, y: 0, w: 0.04 * s, up: 0.004, down: 0.004, n: 2 },
    ], 8);
    // Its length out from the hub (local +z) turned to radial, pitched about its own axis.
    blade.rotateZ(0.6).rotateX(-Math.PI / 2).rotateZ(a).translate(0, propY, pz);
    add(`propBlade${i}`, blade, 'steel');
  }
  return names;
}

/** A rail along `pts` on posts down to the deck, one post every `every` points. */
function rail(parts: PartList, name: string, pts: THREE.Vector3[], height: number, every: number, r = 0.013): void {
  parts.push([name, sweep(pts.map((p) => p.clone().add(V(0, height, 0))), r, 6, { segments: Math.max(4, pts.length * 3) }), 'steel']);
  pts.forEach((p, i) => {
    if (i % every !== 0 && i !== pts.length - 1) return;
    parts.push([`${name}Post${i}`, rod(p, p.clone().add(V(0, height, 0)), r * 0.9, 5), 'steel']);
  });
}

// ---------------------------------------------------------------------------

function speedboat(kind: VehicleKind): BoatModel {
  const s = VEHICLE_SPECS[kind];
  const L = s.length;
  const hl = L / 2;
  const hull: HullSpec = { length: L, beam: s.width - 0.06, draft: s.boat?.draft ?? 0.45, deadrise: (18 * Math.PI) / 180, sheerAft: 0.78, sheerBow: 0.95, chine: 0.84, shoulder: 0.42, entry: 1.8, keelRise: 0.55, transom: 0.9 };
  const floor = 0.15;
  const deckT = 0.585;
  const ts = stations(26);
  const skin = hullSkin(hull, ts);
  const cockpit = cockpitGeometry(hull, { floor, wall: 0.07, from: 0, to: deckT }, 14);
  const fore = foredeckGeometry(hull, deckT, floor, 0.06, 12);
  const deckZ = hullSection(hull, deckT).z;

  const painted = assemblePainted([['topsides', skin.topsides, 0xffffff], ['transom', skin.transom, 0xffffff]]);
  const parts: PartList = [];
  parts.push(['bottom', skin.bottom, 'antifoul']);
  parts.push(['gunwaleCap', cockpit.cap, 'gelcoat']);
  parts.push(['liner', cockpit.liner, 'gelcoat']);
  parts.push(['sole', cockpit.sole, 'nonSkid']);
  parts.push(['transomInner', cockpit.transomInner, 'gelcoat']);
  parts.push(['foredeck', fore.deck, 'gelcoat']);
  parts.push(['bulkhead', fore.bulkhead, 'gelcoat']);
  // Rub rail along the sheer, both sides, bow to transom.
  for (const side of [1, -1]) {
    const pts = stations(14).map((t) => {
      const q = hullSection(hull, Math.min(t, 0.985));
      return V(side * (q.sheerX + 0.005), q.sheerY - 0.03, q.z);
    });
    parts.push([`rubRail${side > 0 ? 'L' : 'R'}`, sweep(pts, 0.02, 6, { segments: 30, flat: 0.6 }), 'plastic']);
  }
  // Helm console (driver's side), the dash sloping up to the screen, the wheel on its column; the passenger's console.
  const cz0 = deckZ - 0.38;
  for (const x of [0.45, -0.45]) {
    parts.push([`console${x > 0 ? 'Helm' : 'Mate'}`, block(0.56, 0.78, deckZ - cz0 + 0.02, x, floor + 0.39, (cz0 + deckZ) / 2, 5, 12), 'gelcoat']);
    const dash = block(0.52, 0.06, 0.34, 0, 0, 0, 4, 10).rotateX(0.32).translate(x, floor + 0.82, cz0 + 0.17);
    parts.push([`dash${x > 0 ? 'Helm' : 'Mate'}`, dash, 'dash']);
  }
  const wheelC = V(0.45, 1.0, 0.1);
  const tilt = 0.61;
  const wheel = new THREE.TorusGeometry(0.17, 0.017, 6, 24).rotateX(tilt).translate(wheelC.x, wheelC.y, wheelC.z);
  parts.push(['wheel', wheel, 'black']);
  const wheelUp = V(0, Math.cos(tilt), Math.sin(tilt));
  const wheelAxis = V(0, -Math.sin(tilt), Math.cos(tilt));
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3 - Math.PI / 2;
    const rim = wheelC.clone().add(V(Math.cos(a) * 0.165, 0, 0)).addScaledVector(wheelUp, Math.sin(a) * 0.165);
    parts.push([`wheelSpoke${i}`, rod(wheelC, rim, 0.008, 4), 'steel']);
  }
  parts.push(['wheelColumn', rod(wheelC, wheelC.clone().addScaledVector(wheelAxis, 0.16), 0.022, 8), 'dash']);
  parts.push(['throttle', rod(V(0.78, 0.92, 0.2), V(0.8, 1.05, 0.12), 0.012, 5), 'chrome']);
  // Seats: helm and passenger buckets on pedestals, the rear bench across the stern.
  const seatTop = 0.585;
  for (const x of [0.45, -0.45]) {
    const k = x > 0 ? 'Helm' : 'Mate';
    parts.push([`pedestal${k}`, block(0.3, seatTop - 0.12 - floor, 0.3, x, (floor + seatTop - 0.12) / 2, -0.36, 4, 10), 'steel']);
    parts.push([`seat${k}`, loft([
      { z: -0.6, y: seatTop - 0.06, x, w: 0.24, up: 0.06, down: 0.06, n: 4 },
      { z: -0.36, y: seatTop - 0.06, x, w: 0.25, up: 0.06, down: 0.06, n: 4 },
      { z: -0.14, y: seatTop - 0.065, x, w: 0.24, up: 0.055, down: 0.055, n: 4 },
    ], 14), 'cushion']);
    parts.push([`backrest${k}`, block(0.46, 0.44, 0.1, 0, 0, 0, 5, 12).rotateX(0.12).translate(x, seatTop + 0.25, -0.56), 'cushionDark']);
  }
  const benchZ = -hl + 0.6;
  parts.push(['benchBase', block(1.9, seatTop - 0.1 - floor, 0.55, 0, (floor + seatTop - 0.1) / 2, benchZ, 5, 12), 'gelcoat']);
  parts.push(['bench', block(1.86, 0.1, 0.55, 0, seatTop - 0.05, benchZ, 5, 14), 'cushion']);
  parts.push(['benchBack', block(1.86, 0.4, 0.12, 0, 0, 0, 5, 14).rotateX(0.18).translate(0, seatTop + 0.2, benchZ - 0.33), 'cushionDark']);
  // Engine well across the transom behind the bench.
  parts.push(['engineWell', block(1.7, 0.2, 0.2, 0, hull.sheerAft - 0.1, -hl + 0.12, 5, 12), 'gelcoat']);
  // Rails: the bow pulpit round the foredeck, low grab rails along the cockpit gunwales.
  for (const side of [1, -1]) {
    const bow = [0.63, 0.7, 0.77, 0.84, 0.9, 0.95].map((t) => {
      const q = hullSection(hull, t);
      return V(side * Math.max(0.03, q.sheerX - 0.07), q.sheerY + 0.04 * (q.sheerX / (hull.beam / 2)), q.z);
    });
    bow.push(V(0, hullSection(hull, 0.985).sheerY + 0.01, hullSection(hull, 0.985).z));
    rail(parts, `bowRail${side > 0 ? 'L' : 'R'}`, bow, 0.27, 2);
    const cock = [0.08, 0.2, 0.33, 0.46, 0.56].map((t) => {
      const q = hullSection(hull, t);
      return V(side * (q.sheerX - 0.035), q.sheerY, q.z);
    });
    rail(parts, `grabRail${side > 0 ? 'L' : 'R'}`, cock, 0.09, 2, 0.011);
    // Cleats fore and aft.
    for (const t of [0.05, 0.62]) {
      const q = hullSection(hull, t);
      parts.push([`cleat${side > 0 ? 'L' : 'R'}${t}`, block(0.04, 0.03, 0.16, side * (q.sheerX - 0.04), q.sheerY + 0.015, q.z, 4, 8), 'steel']);
    }
  }
  // Windscreen: a raked glass band wrapping round the cockpit's front, framed in chrome.
  const N = 16;
  const base: THREE.Vector3[] = [];
  const top: THREE.Vector3[] = [];
  const sx = hullSection(hull, deckT).sheerX - 0.06;
  for (let i = 0; i <= N; i++) {
    const u = -1 + (2 * i) / N;
    const x = u * sx;
    const zb = deckZ + 0.01 - 0.24 * u * u;
    base.push(V(x, 0.95 - 0.08 * u * u, zb));
    top.push(V(x * 0.94, 1.27 - 0.1 * u * u, zb - 0.21 + 0.05 * u * u));
  }
  const glass = gridSurface([base, top], V(0, 0.3, 1));
  parts.push(['screenFrame', sweep(top, 0.012, 5, { segments: 32 }), 'chrome']);
  for (const i of [0, N]) parts.push([`screenPost${i}`, rod(base[i]!, top[i]!, 0.014, 5), 'chrome']);
  parts.push(['screenBase', sweep(base, 0.015, 5, { segments: 32 }), 'black']);
  // Lamps: a bow light on its post, the all-round stern light on a pole.
  const bowT = 0.93;
  const bq = hullSection(hull, bowT);
  parts.push(['bowLightPost', rod(V(0, bq.sheerY + 0.03, bq.z), V(0, bq.sheerY + 0.1, bq.z), 0.012, 5), 'steel']);
  parts.push(['sternPole', rod(V(0.62, hull.sheerAft, -hl + 0.12), V(0.62, 1.32, -hl + 0.12), 0.014, 5), 'steel']);
  // The outboard.
  const ob = outboard(parts, -hl, hull.sheerAft - 0.16, 1, -0.25, false);

  const fittings = assemble(parts);
  // Driver: hips 1.5 cm over the helm cushion, hands on the wheel at a quarter to three.
  const gl = V(wheelC.x + 0.17, wheelC.y, wheelC.z);
  const gr = V(wheelC.x - 0.17, wheelC.y, wheelC.z);
  const hip = V(0.45, 0.6, -0.34);
  const shoulder = (x: number) => V(x, 1.199, -0.37);
  const tl = handOn(gl, gl.clone().sub(shoulder(0.735)));
  const tr = handOn(gr, gr.clone().sub(shoulder(0.165)));
  const seats: RiderSeatLayout[] = [
    { hip: toP(hip), recline: 0.05, hands: [toP(tl), toP(tr)], feet: [P(0.57, floor, 0.02), P(0.33, floor, 0.02)] },
    { hip: P(-0.45, 0.6, -0.34), recline: 0.15, hands: [P(-0.2, 0.86, -0.05), P(-0.72, 0.86, -0.12)], feet: [P(-0.33, floor, 0.02), P(-0.57, floor, 0.02)] },
    { hip: P(0.4, 0.6, benchZ), recline: 0.2, hands: [P(0.6, 0.7, benchZ + 0.15), P(0.2, 0.7, benchZ + 0.15)], feet: [P(0.5, floor, benchZ + 0.45), P(0.3, floor, benchZ + 0.45)] },
    { hip: P(-0.4, 0.6, benchZ), recline: 0.2, hands: [P(-0.2, 0.7, benchZ + 0.15), P(-0.6, 0.7, benchZ + 0.15)], feet: [P(-0.3, floor, benchZ + 0.45), P(-0.5, floor, benchZ + 0.45)] },
  ];
  return {
    style: 'speedboat',
    hull,
    length: L,
    width: s.width,
    gunwale: hull.sheerAft,
    floor,
    keel: -hull.draft,
    painted,
    fittings,
    glass,
    shadow: shadowProxy(hull, [V(0, 1.0, -hl - 0.4), V(0, 0.55, -0.3)], [0.3, 0.45]),
    waterline: waterline(hull, 64),
    bowLamp: { at: V(0, bq.sheerY + 0.13, bq.z), size: V(0.08, 0.05, 0.06), facing: 1 },
    sternLamp: { at: V(0.62, 1.35, -hl + 0.12), size: V(0.06, 0.06, 0.06), facing: -1 },
    headLamp: true,
    seats,
    helm: { points: [gl, gr], hands: [0, 1] },
    seatTop,
    outboard: ob,
  };
}

function dinghy(kind: VehicleKind): BoatModel {
  const s = VEHICLE_SPECS[kind];
  const L = s.length;
  const hl = L / 2;
  const hull: HullSpec = { length: L, beam: 1.2, draft: s.boat?.draft ?? 0.3, deadrise: (16 * Math.PI) / 180, sheerAft: 0.2, sheerBow: 0.32, chine: 0.8, shoulder: 0.45, entry: 1.4, keelRise: 0.5, transom: 0.92 };
  const floor = 0.05;
  const ts = stations(22);
  const skin = hullSkin(hull, ts);
  const cockpit = cockpitGeometry(hull, { floor, wall: 0.05, from: 0, to: 0.88 }, 12);
  const fore = foredeckGeometry(hull, 0.86, floor, 0.03, 8);
  const parts: PartList = [];
  parts.push(['topsides', skin.topsides, 'gelcoat']);
  parts.push(['transom', skin.transom, 'gelcoat']);
  parts.push(['bottom', skin.bottom, 'gelcoat']);
  parts.push(['liner', cockpit.liner, 'gelcoat']);
  parts.push(['sole', cockpit.sole, 'nonSkid']);
  parts.push(['transomInner', cockpit.transomInner, 'gelcoat']);
  parts.push(['bowDeck', fore.deck, 'gelcoat']);
  parts.push(['bowLocker', fore.bulkhead, 'gelcoat']);
  // The tubes: one U round the bow from stern to stern, coned past the transom, thinner at the bow.
  const tubeR = (t: number) => 0.2 - 0.1 * Math.min(1, Math.max(0, (t - 0.6) / 0.4)) ** 1.5;
  const tubeAt = (t: number, side: number) => {
    const q = hullSection(hull, Math.min(1, Math.max(0, t)));
    const x = q.sheerX + 0.02 * (1 - t ** 4);
    return V(side * x, 0.3 + 0.07 * t * t, q.z);
  };
  const path: THREE.Vector3[] = [];
  const radii: number[] = [];
  const tt = [0, 0.06, 0.15, 0.3, 0.45, 0.6, 0.72, 0.82, 0.9, 0.95, 0.985];
  path.push(V(0.6, 0.31, -hl - 0.24));
  radii.push(0.07);
  for (const t of tt) {
    path.push(tubeAt(t, 1));
    radii.push(tubeR(t));
  }
  path.push(V(0, 0.37, hl + 0.03));
  radii.push(0.1);
  for (const t of tt.slice().reverse()) {
    path.push(tubeAt(t, -1));
    radii.push(tubeR(t));
  }
  path.push(V(-0.6, 0.31, -hl - 0.24));
  radii.push(0.07);
  const radiusAt = (u: number) => {
    const f = u * (radii.length - 1);
    const i = Math.min(radii.length - 2, Math.floor(f));
    return radii[i]! + (radii[i + 1]! - radii[i]!) * (f - i);
  };
  // The tubes take the boat's colour.
  const painted = assemblePainted([['tubes', sweep(path, radiusAt, 14, { segments: 96 }), 0xffffff]]);
  // Grab lines along both tubes' outer tops, scalloped between their D-rings, and the rings' patches.
  for (const side of [1, -1]) {
    const line: THREE.Vector3[] = [];
    const rings = [0.08, 0.18, 0.28, 0.38, 0.48, 0.58, 0.68, 0.78, 0.86];
    rings.forEach((t, i) => {
      const c = tubeAt(t, side);
      const r = tubeR(t);
      const on = c.clone().add(V(side * r * Math.sin(0.9), r * Math.cos(0.9), 0));
      line.push(on);
      parts.push([`dRing${side > 0 ? 'L' : 'R'}${i}`, block(0.03, 0.03, 0.05, on.x, on.y, on.z, 4, 6), 'hypalon']);
      if (i < rings.length - 1) {
        const tm = (t + rings[i + 1]!) / 2;
        const cm = tubeAt(tm, side);
        const rm = tubeR(tm);
        line.push(cm.clone().add(V(side * (rm + 0.01) * Math.sin(1.15), (rm + 0.01) * Math.cos(1.15), 0)));
      }
    });
    parts.push([`grabLine${side > 0 ? 'L' : 'R'}`, sweep(line, 0.008, 5, { segments: 48 }), 'rope']);
  }
  // Two thwarts, the transom pad the motor clamps to, and the motor with its tiller.
  const thwartTop = 0.395;
  for (const [i, z] of [[0, -hl + 0.95], [1, 0.2]] as const) {
    const q = hullSection(hull, (z + hl) / L);
    parts.push([`thwart${i}`, block(2 * (q.sheerX + 0.05), 0.04, 0.3, 0, thwartTop - 0.02, z, 5, 10), 'teak']);
  }
  parts.push(['transomPad', block(0.46, 0.32, 0.05, 0, 0.34, -hl + 0.03, 4, 10), 'gelcoat']);
  const ob = outboard(parts, -hl - 0.02, 0.4, 0.55, -0.15, true);
  const tillerBase = V(0, 0.56, -hl - 0.1);
  const grip = V(0.235, 0.598, -1.19);
  parts.push(['tiller', sweep([tillerBase, tillerBase.clone().lerp(grip, 0.5).add(V(0, 0.03, 0)), grip.clone().lerp(tillerBase, 0.12)], 0.017, 6, { segments: 6 }), 'cowl']);
  parts.push(['tillerGrip', rod(grip.clone().lerp(tillerBase, 0.14), grip.clone().add(grip.clone().sub(tillerBase).normalize().multiplyScalar(0.04)), 0.021, 8), 'rubber']);
  ob.push('tiller');
  parts.push(['bowLightBase', block(0.06, 0.04, 0.08, 0, 0.47, hl - 0.18, 4, 8), 'black']);
  parts.push(['sternPole', rod(V(-0.3, 0.45, -hl + 0.05), V(-0.3, 0.86, -hl + 0.05), 0.012, 5), 'steel']);
  const fittings = assemble(parts);
  const shoulder = V(0.285, 1.0, -0.97);
  const tl = handOn(grip, grip.clone().sub(shoulder));
  const seats: RiderSeatLayout[] = [
    { hip: P(0, 0.41, -hl + 0.95), recline: 0.05, hands: [toP(tl), P(-0.28, 0.405, -hl + 0.95)], feet: [P(0.15, floor, -hl + 1.4), P(-0.15, floor, -hl + 1.4)] },
    { hip: P(0, 0.41, 0.2), recline: 0.1, hands: [P(0.42, 0.47, 0.25), P(-0.42, 0.47, 0.25)], feet: [P(0.15, floor, 0.65), P(-0.15, floor, 0.65)] },
  ];
  return {
    style: 'dinghy',
    hull,
    length: L,
    width: s.width,
    gunwale: 0.42,
    floor,
    keel: -hull.draft,
    painted,
    fittings,
    glass: null,
    shadow: shadowProxy(hull, [V(0, 0.6, -hl - 0.2), V(0, 0.3, 0)], [0.15, 0.78], true),
    waterline: waterline(hull, 56),
    bowLamp: { at: V(0, 0.51, hl - 0.18), size: V(0.05, 0.04, 0.05), facing: 1 },
    sternLamp: { at: V(-0.3, 0.88, -hl + 0.05), size: V(0.05, 0.05, 0.05), facing: -1 },
    headLamp: false,
    seats,
    helm: { points: [grip], hands: [0] },
    seatTop: thwartTop,
    outboard: ob,
  };
}

/** The shadow of a boat: a coarse hull to its sheer, a block for the outboard and one for what stands in the cockpit. */
function shadowProxy(h: HullSpec, motor: THREE.Vector3[], sizes: number[], tubes = false): THREE.BufferGeometry {
  const ts = stations(8);
  const skin = hullSkin(h, ts);
  const parts = [skin.topsides, skin.bottom, skin.transom, block(0.5 * sizes[0]! * 2, 0.6 * sizes[0]! * 2, 0.6 * sizes[0]! * 2, motor[0]!.x, motor[0]!.y, motor[0]!.z, 4, 6)];
  if (tubes) parts.push(block(h.beam + 0.4, sizes[1]! * 0.5, h.length * 0.85, 0, 0.3, -0.1, 4, 8));
  else parts.push(block(h.beam * 0.8, sizes[1]!, 1.2, motor[1]!.x, motor[1]!.y + 0.4, motor[1]!.z, 4, 6));
  return assembleShape(parts);
}

const STYLES: Partial<Record<VehicleKind, BoatStyle>> = { speedboat: 'speedboat', dinghy: 'dinghy' };
const built = new Map<VehicleKind, BoatModel>();

/** The model of a boat kind (a kind with no style of its own is drawn as a speedboat), built once. */
export function boatModel(kind: VehicleKind): BoatModel {
  let m = built.get(kind);
  if (!m) {
    m = (STYLES[kind] ?? 'speedboat') === 'dinghy' ? dinghy(kind) : speedboat(kind);
    built.set(kind, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// The Marina's moored cabin cruisers (props.ts buildBoat): 12 m on the hull and cabin footprints the sim's colliders
// use (world/staticWorld.ts BOAT_HULL, BOAT_CABIN: bow at +x, deck 1.2 m and cabin roof 2.5 m above the prop's y).

let cruiser: { painted: THREE.BufferGeometry; fittings: THREE.BufferGeometry } | null = null;

function cruiserGeometry(): { painted: THREE.BufferGeometry; fittings: THREE.BufferGeometry } {
  if (cruiser) return cruiser;
  const L = 12;
  const hull: HullSpec = { length: L, beam: 2.56, draft: 0.75, deadrise: (16 * Math.PI) / 180, sheerAft: 1.0, sheerBow: 1.2, chine: 0.86, shoulder: 0.5, entry: 1.7, keelRise: 0.62, transom: 0.92 };
  const ts = stations(28);
  const skin = hullSkin(hull, ts);
  const floor = 0.55;
  const deckT = 0.2;
  const cockpit = cockpitGeometry(hull, { floor, wall: 0.07, from: 0, to: deckT }, 6);
  const fore = foredeckGeometry(hull, deckT, floor, 0.08, 16);
  const parts: PartList = [];
  parts.push(['bottom', skin.bottom, 'antifoul']);
  parts.push(['gunwaleCap', cockpit.cap, 'gelcoat']);
  parts.push(['liner', cockpit.liner, 'gelcoat']);
  parts.push(['sole', cockpit.sole, 'teak']);
  parts.push(['transomInner', cockpit.transomInner, 'gelcoat']);
  parts.push(['deck', fore.deck, 'gelcoat']);
  parts.push(['cockpitBulkhead', fore.bulkhead, 'gelcoat']);
  // Swim platform off the transom.
  parts.push(['swimPlatform', block(2.2, 0.08, 0.5, 0, 0.32, -L / 2 - 0.22, 6, 10), 'teak']);
  // The cabin (its x -2.2..1.2 in the prop's frame is z -3.2..0.2 here, the hull's centre at prop x 1): a white
  // superstructure with a raked front, a dark window band and a flat roof.
  const z0 = -3.2;
  const z1 = 0.2;
  const deckY = (z: number) => hullSection(hull, (z + L / 2) / L).sheerY;
  const cabinRows: Section[] = [
    { z: z0, y: deckY(z0) + 0.62, w: 0.93, up: 0.66, down: 0.62, n: 6 },
    { z: z0 + 1.6, y: deckY(z0 + 1.6) + 0.6, w: 0.96, up: 0.66, down: 0.6, n: 6 },
    { z: z1 - 0.7, y: deckY(z1 - 0.7) + 0.5, w: 0.92, up: 0.58, down: 0.5, n: 5 },
    { z: z1, y: deckY(z1) + 0.3, w: 0.82, up: 0.32, down: 0.3, n: 4 },
  ];
  parts.push(['cabin', loft(cabinRows, 20), 'gelcoat']);
  const band: Section[] = [
    { z: z0 + 0.3, y: deckY(z0) + 0.92, w: 0.945, up: 0.2, down: 0.16, n: 8 },
    { z: z1 - 0.75, y: deckY(z1 - 0.75) + 0.82, w: 0.935, up: 0.18, down: 0.14, n: 8 },
    { z: z1 - 0.25, y: deckY(z1 - 0.25) + 0.5, w: 0.86, up: 0.16, down: 0.12, n: 6 },
  ];
  parts.push(['windows', loft(band, 20), 'window']);
  parts.push(['roof', block(1.7, 0.06, 2.9, 0, 2.44, -1.75, 8, 12), 'gelcoat']);
  // Rails round the foredeck and along the side decks, cleats, the rub rail.
  for (const side of [1, -1]) {
    const pts = [0.3, 0.42, 0.54, 0.66, 0.76, 0.85, 0.92, 0.97].map((t) => {
      const q = hullSection(hull, t);
      return V(side * Math.max(0.04, q.sheerX - 0.09), q.sheerY + 0.05, q.z);
    });
    pts.push(V(0, hullSection(hull, 0.99).sheerY + 0.03, hullSection(hull, 0.99).z));
    rail(parts, `rail${side > 0 ? 'L' : 'R'}`, pts, 0.55, 2, 0.018);
    for (const t of [0.04, 0.5, 0.9]) {
      const q = hullSection(hull, t);
      parts.push([`cleat${side > 0 ? 'L' : 'R'}${t}`, block(0.05, 0.04, 0.2, side * (q.sheerX - 0.06), q.sheerY + 0.02, q.z, 4, 8), 'steel']);
    }
    const pts2 = stations(16).map((t) => {
      const r = hullSection(hull, Math.min(t, 0.985));
      return V(side * (r.sheerX + 0.006), r.sheerY - 0.05, r.z);
    });
    parts.push([`rubRail${side > 0 ? 'L' : 'R'}`, sweep(pts2, 0.035, 6, { segments: 36, flat: 0.6 }), 'steel']);
  }
  // Turn it from the hull frame (bow +z, centred) into the prop's (bow +x, the hull from x -5 to 7).
  const toProp = new THREE.Matrix4().makeTranslation(1, 0, 0).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  const painted = assemblePainted([['topsides', skin.topsides, 0xffffff], ['transom', skin.transom, 0xffffff]]).applyMatrix4(toProp);
  const fittings = assemble(parts).applyMatrix4(toProp);
  cruiser = { painted, fittings };
  return cruiser;
}

const cruiserPaints = new Map<number, THREE.MeshStandardMaterial>();

/**
 * A moored cabin cruiser in its prop frame (bow +x, the waterline at y 0): its painted hull and its fittings, two draws
 * that cast and take the sun's shadow.
 */
export function mooredBoat(color: number, palette: THREE.Material): THREE.Group {
  const g = cruiserGeometry();
  let paint = cruiserPaints.get(color);
  if (!paint) {
    paint = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.1, vertexColors: true });
    paint.name = 'moored-hull';
    cruiserPaints.set(color, paint);
  }
  const group = new THREE.Group();
  group.name = 'mooredBoat';
  for (const [geo, mat, name] of [[g.painted, paint, 'hull'], [g.fittings, palette, 'fittings']] as const) {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  return group;
}

/** The moored cruiser's geometry (for tests). */
export function mooredBoatGeometry(): { painted: THREE.BufferGeometry; fittings: THREE.BufferGeometry } {
  return cruiserGeometry();
}
