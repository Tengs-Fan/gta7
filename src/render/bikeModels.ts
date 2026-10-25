// The motorbike models BikeView draws (procedural, sculpted from lofts, sweeps and lathed parts; see shapeKit.ts): a
// sport bike (fuel tank, nose fairing with twin lamps and a smoked screen, belly pan, tail, twin-spar frame, swingarm,
// inline-four engine with headers and an underslung silencer, chain, upside-down fork with twin discs and calipers,
// clip-on bars, fairing mirrors) and a scooter (leg shield, floorboard, rear body, bar cover with lamp and mirrors,
// engine unit, silencer, twin-leg fork, disc and drum wheels). The CC0 motorbikes in the asset sources read as toys,
// so none is imported.
//
// Every model is in the bike's frame (+x left, +y up from the ground, +z forward) and comes as a few merged draws: the
// painted bodywork (paint colour times a vertex tone), the frame and running gear (palette finishes), the parts that
// steer (fork, bars, mudguard; in the steering head's frame, its -y down the fork), and one tyre and two rims drawn
// through the shared vehicle part batches, plus a low-poly shadow proxy. The rider's seat, grips and pegs are part of
// the model, so riders sit, hold and stand where the parts are.

import * as THREE from 'three';
import type { VehicleKind } from '../sim/specs';
import type { RiderSeatLayout } from './riders';
import { assemble, assemblePainted, assembleShape, block, cylinder, finish, finishU, lathe, loft, rod, sweep, V, type PaintList, type PartList, type Section } from './shapeKit';

export type BikeStyle = 'sport' | 'scooter';

/** A lamp lens (the shared LAMP_LENS shape): centre, size (x across, y up, z depth) and the way its face looks. */
export interface LensPlace {
  at: THREE.Vector3;
  size: THREE.Vector3;
  /** Yaw of the face off straight ahead (+z) or straight behind. */
  yaw: number;
  facing: 1 | -1;
}

export interface BikeModel {
  style: BikeStyle;
  wheelR: number;
  rearZ: number;
  frontZ: number;
  headY: number;
  headZ: number;
  rake: number;
  /** Steering head to front axle along the fork. */
  forkLen: number;
  painted: THREE.BufferGeometry;
  frame: THREE.BufferGeometry;
  /** In the steering head's frame. */
  steer: THREE.BufferGeometry;
  /** The tyre (unit width: scaled across by each wheel's halfWidth / TYRE_HW) and each wheel's rim, about their axles. */
  tyre: THREE.BufferGeometry;
  frontRim: THREE.BufferGeometry;
  rearRim: THREE.BufferGeometry;
  frontTyreScale: number;
  rearTyreScale: number;
  /** Everything at rest, coarse: drawn into the sun's shadow only. */
  shadow: THREE.BufferGeometry;
  headLamps: LensPlace[];
  /** The head lamps sit on the bars (scooter) and turn with them (then `at` is in the steering head's frame). */
  headOnFork: boolean;
  tailLamp: LensPlace;
  seats: RiderSeatLayout[];
  /** The driver's hand targets (left, then right) in the steering head's frame: they turn with the bars. */
  handsOnBars: [THREE.Vector3, THREE.Vector3];
  /** Points on the grips' axes (left, right) in the steering head's frame (for tests: where the wrists should be). */
  grips: [THREE.Vector3, THREE.Vector3];
  /** The driver's foot pegs or floorboard spots (left, right) in the bike frame. */
  pegs: [THREE.Vector3, THREE.Vector3];
  /** Height of the seat's top under the driver's and the pillion's hips. */
  seatTop: [number, number];
  /** Spokes per rim, and the tyre's lugs round its circumference. */
  spokes: number;
  lugs: number;
}

/** Tyre lathe resolution: two segments per lug (a lug and a groove), so LUGS lugs. */
const LUGS = 24;
const TYRE_SEG = LUGS * 2;
const TREAD_DEPTH = 0.006;
/** The shared tyre is built this wide (half width, m) and scaled across per wheel. */
const TYRE_HW = 0.08;

const P = (x: number, y: number, z: number) => ({ x, y, z });

/** The steering head's frame (position and rake) as a matrix, and its inverse. */
export function headFrame(headY: number, headZ: number, rake: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(0, headY, headZ).multiply(new THREE.Matrix4().makeRotationX(-rake));
}

/**
 * The tyre about the x axis: a rounded section from bead to bead, the crown lugged (TREAD_DEPTH grooves every other
 * segment, offset between the centre and the shoulders so the lugs read as a chevron), closed along the rim.
 */
function tyreGeometry(R: number, rimR: number): THREE.BufferGeometry {
  const hw = TYRE_HW;
  const sh = R - rimR;
  const side = (s: number): Array<[number, number]> => [
    [s * 0.8 * hw, rimR + 0.004],
    [s * 0.98 * hw, R - 0.32 * sh],
    [s * 0.46 * hw, R - 0.04 * sh],
  ];
  const surface: Array<[number, number]> = [...side(-1), [0, R], ...side(1).reverse()];
  const closing: Array<[number, number]> = [[0.8 * hw, rimR + 0.004], [-0.8 * hw, rimR + 0.004]];
  const grooved = new Set<number>();
  const m = surface.length;
  const g = lathe([surface, closing], TYRE_SEG, 'x', (j, run, k, _a, r) => {
    if (run !== 0 || k < 2 || k > 4) return r;
    const shift = k === 3 ? 0 : 1;
    if ((j + shift) % 2 !== 0) return r;
    grooved.add(j * m + k);
    return r - TREAD_DEPTH;
  });
  // The lugs in rubber, the grooves darker (neighbouring palette texels, so the switch falls halfway between them).
  finish(g, 'rubber');
  const uv = g.getAttribute('uv');
  const u = finishU('tread');
  for (const i of grooved) uv.setX(i, u);
  return g;
}

interface RimSpec {
  rimR: number;
  hw: number;
  hubR: number;
  hubW: number;
  spokes: number;
  /** Paired spokes (a split six) or evenly spread (a five-star). */
  split: boolean;
  spokeR: number;
  finish: 'alloy' | 'gold' | 'alloyDark';
  discs: Array<[number, number]>;
  sprocket?: [number, number];
  drum?: boolean;
}

/** Rim, hub, spokes, brake discs (with carrier arms), sprocket or drum: one rim's parts about the x axis. */
function rimGeometry(s: RimSpec): THREE.BufferGeometry {
  const parts: PartList = [];
  parts.push(['rim', cylinder(-0.82 * s.hw, 0.82 * s.hw, s.rimR + 0.006, 24, s.rimR - 0.016), s.finish]);
  parts.push(['hub', cylinder(-s.hubW, s.hubW, s.hubR, 16), 'alloyDark']);
  parts.push(['axle', cylinder(-s.hubW - 0.012, s.hubW + 0.012, s.hubR * 0.45, 10), 'steel']);
  const wp = (a: number, r: number, phi: number) => V(a, r * Math.cos(phi), r * Math.sin(phi));
  for (let i = 0; i < s.spokes; i++) {
    const phi = s.split ? Math.floor(i / 2) * ((Math.PI * 2) / (s.spokes / 2)) + (i % 2 ? 0.2 : -0.2) : (i * Math.PI * 2) / s.spokes;
    const bend = s.split ? (i % 2 ? -0.07 : 0.07) : 0.06;
    const r0 = s.hubR * 0.85;
    const r1 = s.rimR - 0.014;
    parts.push([`spoke${i}`, sweep([wp(0, r0, phi), wp(0, (r0 + r1) / 2, phi + bend * 0.5), wp(0, r1, phi + bend)], (t) => s.spokeR * (1.15 - 0.3 * t), 4, { segments: 3, flat: 0.5 }), s.finish]);
  }
  s.discs.forEach(([a, r], i) => {
    parts.push([`disc${i}`, cylinder(a - 0.0025, a + 0.0025, r, 20, r - 0.038), 'steel']);
    for (let k = 0; k < 4; k++) {
      const phi = (k * Math.PI * 2) / 4 + 0.3;
      parts.push([`carrier${i}.${k}`, rod(wp(a, s.hubR * 0.8, phi), wp(a, r - 0.034, phi), 0.007, 4), 'alloyDark']);
    }
  });
  if (s.sprocket) {
    const [a, r] = s.sprocket;
    const t = 0.003;
    const ring = lathe([[[a - t, r - 0.03], [a - t, r]], [[a - t, r], [a + t, r]], [[a + t, r], [a + t, r - 0.03]], [[a + t, r - 0.03], [a - t, r - 0.03]]], 40, 'x', (j, _run, _k, _a, rr) => (rr > r - 0.001 ? rr + (j % 2 ? 0.006 : -0.002) : rr));
    parts.push(['sprocket', ring, 'steel']);
    for (let k = 0; k < 5; k++) {
      const phi = (k * Math.PI * 2) / 5;
      parts.push([`sprocketArm${k}`, rod(wp(a, s.hubR * 0.8, phi), wp(a, r - 0.026, phi), 0.008, 4), 'steel']);
    }
  }
  if (s.drum) parts.push(['drum', cylinder(-0.045, 0.05, s.hubR * 2.3, 20), 'alloyDark']);
  return assemble(parts);
}

/** A loft whose sections are given as [z, y, w, up, down] (all sharing exponent n). */
function lofted(rows: ReadonlyArray<readonly [number, number, number, number, number]>, n = 2.6, seg = 16, x = 0, nb?: number): THREE.BufferGeometry {
  return loft(rows.map(([z, y, w, up, down]): Section => ({ z, y, x, w, up, down, n, nb })), seg);
}

/** A mirror on a stalk: the stalk from `root` to the housing at `at`, its glass facing back. */
function mirror(root: THREE.Vector3, at: THREE.Vector3, w: number, h: number): Array<[string, THREE.BufferGeometry, 'black' | 'mirror' | 'alloyDark']> {
  const side = Math.sign(at.x) > 0 ? 'L' : 'R';
  return [
    [`mirrorStalk${side}`, sweep([root, V((root.x + at.x) / 2, at.y - 0.01, (root.z + at.z) / 2), V(at.x * 0.96, at.y - h * 0.4, at.z)], 0.008, 5, { segments: 4 }), 'alloyDark'],
    [`mirror${side}`, loft([{ z: at.z - 0.012, y: at.y, x: at.x, w, up: h, down: h, n: 2.4 }, { z: at.z + 0.012, y: at.y, x: at.x, w: w * 0.92, up: h * 0.9, down: h * 0.9, n: 2.4 }, { z: at.z + 0.03, y: at.y, x: at.x, w: w * 0.6, up: h * 0.55, down: h * 0.55, n: 2.2 }], 8), 'black'],
    [`mirrorGlass${side}`, loft([{ z: at.z - 0.016, y: at.y, x: at.x, w: w * 0.86, up: h * 0.82, down: h * 0.82, n: 2.4 }, { z: at.z - 0.011, y: at.y, x: at.x, w: w * 0.86, up: h * 0.82, down: h * 0.82, n: 2.4 }], 8), 'mirror'],
  ];
}

/**
 * The bar-end grip (rubber over the bar) from `inner` out to `outer`, and the hand's target a little off its axis, so
 * the wrist (SKELETON.hand short of the hand's centre, along the forearm) lands on the grip: the hand centre lies
 * `reach` along `forearm` past the grip axis point `at`.
 */
function handOn(at: THREE.Vector3, forearm: THREE.Vector3, reach = 0.025): THREE.Vector3 {
  return at.clone().addScaledVector(forearm.clone().normalize(), reach);
}

// ---------------------------------------------------------------------------
// Sport bike

function sportModel(): BikeModel {
  const wheelR = 0.31;
  const rearZ = -0.7;
  const frontZ = 0.72;
  const headY = 0.98;
  const headZ = 0.5;
  const rake = Math.atan2(frontZ - headZ, headY - wheelR);
  const forkLen = (headY - wheelR) / Math.cos(rake);
  const H = headFrame(headY, headZ, rake);
  const inv = H.clone().invert();
  const hp = (x: number, y: number, z: number) => V(x, y, z).applyMatrix4(H);

  // Driver: hips 1 cm over the seat, crouched (recline -0.6) to clip-on grips he reaches from every rider height.
  const gripL = V(0.29, 1.121, 0.386);
  const forearm = V(0, -0.455, 0.301);
  const handL = handOn(gripL, forearm);
  const seats: RiderSeatLayout[] = [
    { hip: P(0, 1.06, -0.24), recline: -0.6, hands: [P(handL.x, handL.y, handL.z), P(-handL.x, handL.y, handL.z)], feet: [P(0.2, 0.44, -0.16), P(-0.2, 0.44, -0.16)] },
    { hip: P(0, 1.14, -0.56), recline: -0.25, hands: [P(0.17, 1.2, -0.3), P(-0.17, 1.2, -0.3)], feet: [P(0.21, 0.5, -0.46), P(-0.21, 0.5, -0.46)] },
  ];

  const tank = lofted([
    [-0.14, 0.985, 0.075, 0.05, 0.05],
    [-0.08, 0.99, 0.095, 0.07, 0.08],
    [0.02, 0.99, 0.125, 0.09, 0.11],
    [0.14, 0.99, 0.155, 0.1, 0.12],
    [0.26, 0.985, 0.16, 0.095, 0.115],
    [0.36, 0.97, 0.145, 0.075, 0.1],
    [0.44, 0.95, 0.1, 0.05, 0.07],
  ], 2.6, 18);
  // The fairing: a wedge narrowing to a beak over the front wheel, the twin lamps in its flanks, its sides wrapping
  // down round the radiator and the engine's front (clear of the knees behind and of the tyre turning under it).
  const nose = lofted([
    [0.28, 0.69, 0.15, 0.2, 0.26],
    [0.42, 0.76, 0.2, 0.25, 0.26],
    [0.56, 0.82, 0.2, 0.205, 0.22],
    [0.68, 0.86, 0.16, 0.14, 0.15],
    [0.8, 0.865, 0.1, 0.08, 0.095],
    [0.89, 0.855, 0.05, 0.045, 0.05],
    [0.935, 0.85, 0.012, 0.012, 0.015],
  ], 3.4, 20);
  const tail = lofted([
    [-0.14, 0.86, 0.11, 0.1, 0.1],
    [-0.3, 0.9, 0.125, 0.11, 0.08],
    [-0.46, 0.95, 0.115, 0.11, 0.07],
    [-0.62, 0.99, 0.095, 0.1, 0.06],
    [-0.76, 1.02, 0.07, 0.075, 0.05],
    [-0.86, 1.03, 0.05, 0.045, 0.035],
    [-0.875, 1.03, 0.04, 0.036, 0.028],
  ], 3, 16);
  const painted: PaintList = [
    ['tank', tank, 0xffffff],
    ['fairing', nose, 0xffffff],
    ['tail', tail, 0xffffff],
  ];

  const frame: PartList = [];
  // Twin spars from the steering head round the engine to the swingarm pivot, and the subframe under the seat.
  for (const s of [1, -1]) {
    frame.push([`spar${s > 0 ? 'L' : 'R'}`, sweep([V(s * 0.06, 0.99, 0.46), V(s * 0.125, 0.9, 0.3), V(s * 0.132, 0.79, 0.06), V(s * 0.125, 0.65, -0.14), V(s * 0.11, 0.52, -0.24)], 0.03, 6, { segments: 8, flat: 0.6 }), 'frame']);
    frame.push([`subframe${s > 0 ? 'L' : 'R'}`, rod(V(s * 0.09, 0.78, -0.18), V(s * 0.07, 0.94, -0.78), 0.011, 5), 'frame']);
    frame.push([`swingarm${s > 0 ? 'L' : 'R'}`, sweep([V(s * 0.11, 0.5, -0.25), V(s * 0.125, 0.42, -0.48), V(s * 0.125, 0.31, -0.7)], (t) => 0.034 - t * 0.012, 6, { segments: 5, flat: 0.55 }), 'alloy']);
    frame.push([`axleBlock${s > 0 ? 'L' : 'R'}`, block(0.02, 0.04, 0.06, s * 0.125, 0.31, -0.7), 'alloyDark']);
    // Rearsets: a hanger plate and the peg.
    frame.push([`hanger${s > 0 ? 'L' : 'R'}`, block(0.012, 0.13, 0.07, s * 0.135, 0.49, -0.19), 'alloy']);
    frame.push([`peg${s > 0 ? 'L' : 'R'}`, rod(V(s * 0.135, 0.44, -0.16), V(s * 0.235, 0.44, -0.16), 0.011, 6), 'steel']);
    frame.push([`pillionPeg${s > 0 ? 'L' : 'R'}`, rod(V(s * 0.1, 0.52, -0.44), V(s * 0.24, 0.5, -0.46), 0.01, 5), 'steel']);
  }
  frame.push(['swingarmBrace', rod(V(0.11, 0.46, -0.38), V(-0.11, 0.46, -0.38), 0.018, 6), 'alloy']);
  frame.push(['shock', rod(V(0, 0.78, -0.16), V(0, 0.47, -0.36), 0.022, 6), 'gold']);
  // Inline four: crankcase, the cylinder block leaning forward, cam cover, side covers, oil sump.
  frame.push(['crankcase', lofted([
    [-0.2, 0.42, 0.12, 0.13, 0.15],
    [-0.08, 0.42, 0.15, 0.16, 0.18],
    [0.12, 0.43, 0.155, 0.16, 0.18],
    [0.3, 0.45, 0.12, 0.12, 0.14],
  ], 4, 16), 'engine']);
  const cyl = block(0.27, 0.22, 0.2, 0, 0, 0, 5, 14);
  cyl.rotateX(-0.45).translate(0, 0.67, 0.18);
  frame.push(['cylinders', cyl, 'engine']);
  const cam = block(0.25, 0.06, 0.16, 0, 0, 0, 4, 14);
  cam.rotateX(-0.45).translate(0, 0.79, 0.24);
  frame.push(['camCover', cam, 'alloyDark']);
  frame.push(['clutchCover', cylinder(-0.19, -0.16, 0.095, 14).translate(0, 0.41, -0.02), 'alloyDark']);
  frame.push(['alternatorCover', cylinder(0.155, 0.18, 0.075, 16).translate(0, 0.43, 0.12), 'alloyDark']);
  frame.push(['sprocketCover', block(0.025, 0.1, 0.12, 0.165, 0.38, -0.15), 'black']);
  frame.push(['bellyPan', lofted([
    [-0.06, 0.24, 0.09, 0.04, 0.035],
    [0.06, 0.23, 0.13, 0.05, 0.04],
    [0.3, 0.27, 0.13, 0.06, 0.05],
    [0.4, 0.33, 0.08, 0.05, 0.04],
  ], 3, 14), 'plastic']);
  frame.push(['radiator', block(0.3, 0.26, 0.035, 0, 0, 0, 8, 10).rotateX(-0.2).translate(0, 0.7, 0.385), 'black']);
  // Four headers down the front of the engine and under it to the collector and the underslung silencer.
  [0.105, 0.035, -0.035, -0.105].forEach((x, i) => {
    frame.push([`header${i}`, sweep([V(x, 0.66, 0.31), V(x * 1.05, 0.5, 0.42), V(x * 0.8, 0.24, 0.36), V(x * 0.35, 0.18, 0.12), V(-0.05, 0.2, -0.04)], 0.017, 5, { segments: 5 }), 'steel']);
  });
  frame.push(['silencer', lofted([
    [-0.04, 0.21, 0.055, 0.055, 0.055],
    [-0.1, 0.225, 0.07, 0.065, 0.065],
    [-0.3, 0.27, 0.075, 0.07, 0.065],
    [-0.36, 0.285, 0.06, 0.055, 0.05],
  ], 3, 14, -0.13), 'alloyDark']);
  frame.push(['silencerTip', cylinder(-0.01, 0.03, 0.03, 12, 0.02).rotateY(Math.PI / 2).translate(-0.13, 0.285, -0.39), 'steel']);
  // Chain: top and bottom runs between the sprockets (left side).
  frame.push(['chainTop', rod(V(0.085, 0.425, -0.15), V(0.085, 0.41, -0.7), 0.007, 4), 'steel']);
  frame.push(['chainBottom', rod(V(0.085, 0.335, -0.15), V(0.085, 0.21, -0.7), 0.007, 4), 'steel']);
  // Seats: the rider's, 1 cm under his hips, and the pillion pad on the tail.
  frame.push(['seat', lofted([
    [-0.12, 1.02, 0.085, 0.02, 0.03],
    [-0.17, 1.03, 0.12, 0.02, 0.04],
    [-0.3, 1.03, 0.13, 0.02, 0.05],
    [-0.4, 1.04, 0.115, 0.025, 0.05],
    [-0.45, 1.05, 0.095, 0.02, 0.04],
  ], 3.2, 16), 'leather']);
  frame.push(['pillionPad', lofted([
    [-0.47, 1.085, 0.07, 0.02, 0.03],
    [-0.52, 1.09, 0.09, 0.035, 0.03],
    [-0.62, 1.095, 0.085, 0.03, 0.03],
    [-0.68, 1.09, 0.06, 0.02, 0.025],
  ], 3.2, 14), 'leather']);
  // Cockpit: the smoked screen over the nose, the dash under it, the fairing mirrors.
  frame.push(['screen', lofted([
    [0.5, 1.03, 0.1, 0.045, 0.02],
    [0.56, 1.025, 0.15, 0.06, 0.03],
    [0.66, 1.0, 0.15, 0.045, 0.03],
    [0.76, 0.96, 0.11, 0.025, 0.03],
  ], 2.2, 16), 'smoke']);
  frame.push(['dash', block(0.14, 0.05, 0.06, 0, 1.025, 0.47, 4, 10), 'dash']);
  for (const s of [1, -1]) {
    for (const p of mirror(V(s * 0.18, 1.0, 0.6), V(s * 0.29, 1.075, 0.62), 0.055, 0.03)) frame.push(p);
  }
  frame.push(['tailLampHousing', block(0.1, 0.05, 0.03, 0, 1.03, -0.868, 4, 10), 'black']);
  frame.push(['plateHolder', rod(V(0, 0.95, -0.82), V(0, 0.86, -0.93), 0.012, 5), 'black']);
  frame.push(['plate', block(0.17, 0.12, 0.006, 0, 0.83, -0.935, 8, 8), 'plate']);

  // Steering: upside-down fork (gold outer tubes, chrome sliders), clamps, clip-ons, levers, calipers, mudguard.
  const steer: PartList = [];
  const legX = 0.1;
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    steer.push([`forkTube${side}`, rod(V(s * legX, 0.11, 0), V(s * legX, -0.36, 0), 0.029, 10), 'gold']);
    steer.push([`forkSlider${side}`, rod(V(s * legX, -0.36, 0), V(s * legX, -forkLen + 0.03, 0), 0.021, 10), 'chrome']);
    steer.push([`axleLug${side}`, block(0.036, 0.07, 0.05, s * legX, -forkLen, 0.005, 4, 10), 'alloyDark']);
    steer.push([`caliper${side}`, block(0.03, 0.09, 0.05, s * 0.074, -forkLen + 0.118, -0.083, 3, 10).rotateX(0).translate(0, 0, 0), 'gold']);
    // Clip-on: from its clamp on the fork tube out and back to the grip.
    const gripIn = V(s * 0.205, 1.117, 0.392).applyMatrix4(inv);
    const gripOut = V(s * 0.318, 1.123, 0.383).applyMatrix4(inv);
    const clamp = V(s * legX, 0.06, 0);
    steer.push([`clipOn${side}`, sweep([clamp, clamp.clone().lerp(gripIn, 0.5).add(V(0, 0.012, 0)), gripIn], 0.011, 6, { segments: 4 }), 'alloyDark']);
    steer.push([`grip${side}`, rod(gripIn, gripOut, 0.017, 8), 'rubber']);
    steer.push([`barEnd${side}`, cylinder(-0.012, 0.012, 0.016, 8).applyMatrix4(new THREE.Matrix4().makeTranslation(gripOut.x + s * 0.006, gripOut.y, gripOut.z)), 'alloy']);
    const lever = [V(s * 0.21, 1.115, 0.41), V(s * 0.27, 1.105, 0.445), V(s * 0.32, 1.095, 0.45)].map((p) => p.applyMatrix4(inv));
    steer.push([`lever${side}`, sweep(lever, 0.006, 4, { segments: 4 }), 'alloy']);
  }
  steer.push(['topClamp', block(0.26, 0.028, 0.07, 0, 0.075, -0.012, 4, 12), 'alloy']);
  steer.push(['bottomClamp', block(0.26, 0.04, 0.08, 0, -0.11, -0.012, 4, 12), 'alloyDark']);
  steer.push(['reservoir', block(0.04, 0.035, 0.04, -0.15, 0.135, -0.03, 3, 8), 'black']);
  // The mudguard: an arc over the tyre about the axle, in the wheel's plane.
  const axleB = V(0, wheelR, frontZ);
  const arc: THREE.Vector3[] = [];
  for (let k = 0; k <= 6; k++) {
    const th = -0.75 + (k / 6) * 1.75;
    arc.push(axleB.clone().add(V(0, Math.cos(th) * (wheelR + 0.022), -Math.sin(th) * (wheelR + 0.022))).applyMatrix4(inv));
  }
  steer.push(['mudguard', sweep(arc, 0.075, 8, { segments: 8, flat: 0.38 }), 'plastic']);

  const front: RimSpec = { rimR: 0.216, hw: 0.062, hubR: 0.045, hubW: 0.07, spokes: 6, split: true, spokeR: 0.013, finish: 'gold', discs: [[0.074, 0.155], [-0.074, 0.155]] };
  const rear: RimSpec = { rimR: 0.216, hw: 0.092, hubR: 0.05, hubW: 0.09, spokes: 6, split: true, spokeR: 0.015, finish: 'gold', discs: [[-0.085, 0.11]], sprocket: [0.085, 0.105] };

  const steerGeo = assemble(steer);
  const frameGeo = assemble(frame);
  const paintedGeo = assemblePainted(painted);
  const model: BikeModel = {
    style: 'sport',
    wheelR,
    rearZ,
    frontZ,
    headY,
    headZ,
    rake,
    forkLen,
    painted: paintedGeo,
    frame: frameGeo,
    steer: steerGeo,
    tyre: tyreGeometry(wheelR, 0.216),
    frontRim: rimGeometry(front),
    rearRim: rimGeometry(rear),
    frontTyreScale: 0.064 / TYRE_HW,
    rearTyreScale: 0.092 / TYRE_HW,
    shadow: new THREE.BufferGeometry(),
    headLamps: [-1, 1].map((s) => ({ at: V(s * 0.05, 0.85, 0.845), size: V(0.07, 0.04, 0.03), yaw: s * 0.55, facing: 1 as const })),
    headOnFork: false,
    tailLamp: { at: V(0, 1.03, -0.88), size: V(0.08, 0.035, 0.02), yaw: 0, facing: -1 },
    seats,
    handsOnBars: [V(handL.x, handL.y, handL.z).applyMatrix4(inv), V(-handL.x, handL.y, handL.z).applyMatrix4(inv)],
    grips: [gripL.clone().applyMatrix4(inv), V(-gripL.x, gripL.y, gripL.z).applyMatrix4(inv)],
    pegs: [V(0.2, 0.44, -0.16), V(-0.2, 0.44, -0.16)],
    seatTop: [1.05, 1.125],
    spokes: 6,
    lugs: LUGS,
  };
  model.shadow = shadowProxy(model, [tank, nose, tail], [
    rod(V(0, 0.42, -0.2), V(0, 0.45, 0.3), 0.15, 6),
    rod(V(0, 0.9, 0.45), V(0, 0.5, -0.25), 0.1, 6),
    rod(V(0, 1.04, -0.12), V(0, 1.08, -0.68), 0.1, 6),
    rod(hp(0.1, 0, 0), hp(0.1, -forkLen, 0), 0.025, 4),
    rod(hp(-0.1, 0, 0), hp(-0.1, -forkLen, 0), 0.025, 4),
    rod(V(0.32, 1.12, 0.39), V(-0.32, 1.12, 0.39), 0.015, 4),
  ]);
  return model;
}

// ---------------------------------------------------------------------------
// Scooter

function scooterModel(): BikeModel {
  const wheelR = 0.22;
  const rearZ = -0.6;
  const frontZ = 0.62;
  const headY = 0.92;
  const headZ = 0.48;
  const rake = Math.atan2(frontZ - headZ, headY - wheelR);
  const forkLen = (headY - wheelR) / Math.cos(rake);
  const H = headFrame(headY, headZ, rake);
  const inv = H.clone().invert();
  const hp = (x: number, y: number, z: number) => V(x, y, z).applyMatrix4(H);

  // Upright on the seat's front, close enough to the bars for every rider height; feet on the floorboard.
  const gripL = V(0.27, 1.106, 0.281);
  const handL = handOn(gripL, V(-0.015, -0.369, 0.43));
  const seats: RiderSeatLayout[] = [
    { hip: P(0, 0.86, -0.1), recline: 0.05, hands: [P(handL.x, handL.y, handL.z), P(-handL.x, handL.y, handL.z)], feet: [P(0.13, 0.311, 0.18), P(-0.13, 0.311, 0.18)] },
    { hip: P(0, 0.9, -0.55), recline: 0.1, hands: [P(0.18, 0.98, -0.24), P(-0.18, 0.98, -0.24)], feet: [P(0.17, 0.35, -0.32), P(-0.17, 0.35, -0.32)] },
  ];

  // The leg shield: a slab rising from the floorboard's front to the steering column, narrowing as it goes.
  const shieldLen = 0.74;
  const shield = loft([0, 0.2, 0.42, 0.6, shieldLen].map((h, i): Section => ({ z: h, y: 0, w: [0.24, 0.235, 0.215, 0.17, 0.1][i]!, up: 0.045, down: 0.03, n: 3.2 })), 18);
  // Its own z up the shield (rising 0.64 m while leaning 0.12 m forward), its +y (the fuller face) forward, its x
  // mirrored (the slab is symmetric) so the turn is a proper rotation.
  const tilt = Math.atan2(0.12, 0.64);
  const up = V(0, Math.cos(tilt), Math.sin(tilt));
  const fwd = V(0, -Math.sin(tilt), Math.cos(tilt));
  shield.applyMatrix4(new THREE.Matrix4().makeBasis(V(-1, 0, 0), fwd, up));
  shield.translate(0, 0.29, 0.335);
  const floor = lofted([
    [-0.1, 0.24, 0.14, 0.06, 0.07],
    [-0.04, 0.24, 0.175, 0.06, 0.08],
    [0.2, 0.24, 0.18, 0.06, 0.08],
    [0.36, 0.25, 0.16, 0.06, 0.08],
  ], 4, 14);
  const body = lofted([
    [-0.06, 0.5, 0.13, 0.25, 0.22],
    [-0.2, 0.53, 0.2, 0.22, 0.22],
    [-0.42, 0.56, 0.215, 0.19, 0.2],
    [-0.64, 0.6, 0.18, 0.15, 0.14],
    [-0.8, 0.64, 0.12, 0.1, 0.08],
    [-0.88, 0.66, 0.05, 0.045, 0.04],
  ], 3, 18);
  const painted: PaintList = [
    ['legShield', shield, 0xffffff],
    ['floorBase', floor, 0xffffff],
    ['rearBody', body, 0xffffff],
  ];

  const frame: PartList = [];
  frame.push(['floorMat', block(0.3, 0.012, 0.38, 0, 0.305, 0.12, 6, 10), 'rubber']);
  frame.push(['seat', lofted([
    [0.0, 0.79, 0.1, 0.03, 0.05],
    [-0.08, 0.8, 0.15, 0.05, 0.07],
    [-0.18, 0.8, 0.16, 0.05, 0.07],
    [-0.38, 0.815, 0.16, 0.055, 0.07],
    [-0.55, 0.83, 0.15, 0.055, 0.07],
    [-0.72, 0.84, 0.12, 0.04, 0.06],
    [-0.8, 0.84, 0.07, 0.025, 0.04],
  ], 3, 18), 'leather']);
  frame.push(['engineUnit', lofted([
    [-0.12, 0.27, 0.05, 0.1, 0.1],
    [-0.2, 0.26, 0.055, 0.11, 0.1],
    [-0.5, 0.23, 0.05, 0.075, 0.07],
    [-0.62, 0.22, 0.04, 0.05, 0.05],
  ], 3, 14, 0.13), 'engine']);
  frame.push(['silencer', lofted([
    [-0.34, 0.3, 0.045, 0.045, 0.045],
    [-0.42, 0.31, 0.055, 0.055, 0.055],
    [-0.76, 0.35, 0.055, 0.055, 0.05],
    [-0.82, 0.36, 0.04, 0.04, 0.04],
  ], 2.6, 14, -0.14), 'alloyDark']);
  frame.push(['silencerShield', lofted([
    [-0.44, 0.33, 0.04, 0.04, 0.02],
    [-0.72, 0.36, 0.04, 0.04, 0.02],
  ], 2.4, 10, -0.18), 'chrome']);
  frame.push(['grabRail', sweep([V(0.13, 0.8, -0.56), V(0.12, 0.84, -0.78), V(0, 0.855, -0.87), V(-0.12, 0.84, -0.78), V(-0.13, 0.8, -0.56)], 0.012, 6, { segments: 16 }), 'chrome']);
  frame.push(['tailLampHousing', block(0.15, 0.06, 0.03, 0, 0.67, -0.872, 4, 10), 'black']);
  frame.push(['plate', block(0.16, 0.11, 0.006, 0, 0.5, -0.865, 8, 8), 'plate']);
  for (const s of [1, -1]) frame.push([`pillionPeg${s > 0 ? 'L' : 'R'}`, rod(V(s * 0.16, 0.35, -0.32), V(s * 0.24, 0.35, -0.32), 0.012, 5), 'black']);
  frame.push(['stand', rod(V(0, 0.18, -0.25), V(0, 0.06, -0.34), 0.012, 5), 'black']);
  frame.push(['headTube', rod(V(0, 0.98, 0.46), V(0, 0.84, 0.49), 0.035, 8), 'black']);

  const steer: PartList = [];
  const legX = 0.085;
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    steer.push([`forkTube${side}`, rod(V(s * legX, -0.24, 0), V(s * legX, -0.5, 0), 0.022, 10), 'black']);
    steer.push([`forkSlider${side}`, rod(V(s * legX, -0.5, 0), V(s * legX, -forkLen + 0.025, 0), 0.017, 10), 'chrome']);
    steer.push([`axleLug${side}`, block(0.03, 0.06, 0.045, s * legX, -forkLen, 0.004, 4, 10), 'alloyDark']);
    const gripIn = V(s * 0.19, 1.104, 0.285).applyMatrix4(inv);
    const gripOut = V(s * 0.31, 1.107, 0.279).applyMatrix4(inv);
    steer.push([`bar${side}`, rod(V(s * 0.1, 1.1, 0.29).applyMatrix4(inv), gripIn, 0.011, 6), 'alloyDark']);
    steer.push([`grip${side}`, rod(gripIn, gripOut, 0.017, 8), 'rubber']);
    const lever = [V(s * 0.2, 1.1, 0.3), V(s * 0.26, 1.09, 0.335), V(s * 0.3, 1.08, 0.34)].map((p) => p.applyMatrix4(inv));
    steer.push([`lever${side}`, sweep(lever, 0.006, 4, { segments: 4 }), 'alloy']);
    for (const p of mirror(V(s * 0.16, 1.1, 0.4).applyMatrix4(inv), V(s * 0.26, 1.24, 0.43).applyMatrix4(inv), 0.05, 0.035)) steer.push(p);
  }
  steer.push(['caliperL', block(0.026, 0.07, 0.045, 0.062, -forkLen + 0.085, -0.06, 3, 10), 'alloyDark']);
  steer.push(['column', rod(V(0, 0.16, 0), V(0, -0.26, 0), 0.026, 8), 'black']);
  steer.push(['forkBridge', block(0.2, 0.035, 0.06, 0, -0.25, 0, 4, 10), 'black']);
  // The bar cover round the column top: the head lamp in its nose, the grips out of its sides.
  steer.push(['barCover', lofted([
    [0.27, 1.075, 0.12, 0.035, 0.035],
    [0.33, 1.075, 0.2, 0.045, 0.05],
    [0.44, 1.07, 0.19, 0.055, 0.06],
    [0.53, 1.045, 0.12, 0.05, 0.055],
    [0.565, 1.04, 0.05, 0.035, 0.04],
  ], 3, 16).applyMatrix4(inv), 'plastic']);
  const axleB = V(0, wheelR, frontZ);
  const arc: THREE.Vector3[] = [];
  for (let k = 0; k <= 6; k++) {
    const th = -0.55 + (k / 6) * 1.65;
    arc.push(axleB.clone().add(V(0, Math.cos(th) * (wheelR + 0.028), -Math.sin(th) * (wheelR + 0.028))).applyMatrix4(inv));
  }
  steer.push(['mudguard', sweep(arc, 0.07, 8, { segments: 8, flat: 0.3 }), 'plastic']);

  const front: RimSpec = { rimR: 0.152, hw: 0.055, hubR: 0.035, hubW: 0.05, spokes: 5, split: false, spokeR: 0.016, finish: 'alloy', discs: [[0.058, 0.11]] };
  const rear: RimSpec = { rimR: 0.152, hw: 0.062, hubR: 0.038, hubW: 0.06, spokes: 5, split: false, spokeR: 0.017, finish: 'alloy', discs: [], drum: true };

  const model: BikeModel = {
    style: 'scooter',
    wheelR,
    rearZ,
    frontZ,
    headY,
    headZ,
    rake,
    forkLen,
    painted: assemblePainted(painted),
    frame: assemble(frame),
    steer: assemble(steer),
    tyre: tyreGeometry(wheelR, 0.152),
    frontRim: rimGeometry(front),
    rearRim: rimGeometry(rear),
    frontTyreScale: 0.056 / TYRE_HW,
    rearTyreScale: 0.064 / TYRE_HW,
    shadow: new THREE.BufferGeometry(),
    headLamps: [{ at: V(0, 1.045, 0.568).applyMatrix4(inv), size: V(0.15, 0.06, 0.03), yaw: 0, facing: 1 }],
    headOnFork: true,
    tailLamp: { at: V(0, 0.67, -0.89), size: V(0.13, 0.04, 0.02), yaw: 0, facing: -1 },
    seats,
    handsOnBars: [V(handL.x, handL.y, handL.z).applyMatrix4(inv), V(-handL.x, handL.y, handL.z).applyMatrix4(inv)],
    grips: [gripL.clone().applyMatrix4(inv), V(-gripL.x, gripL.y, gripL.z).applyMatrix4(inv)],
    pegs: [V(0.13, 0.311, 0.18), V(-0.13, 0.311, 0.18)],
    seatTop: [0.85, 0.885],
    spokes: 5,
    lugs: LUGS,
  };
  model.shadow = shadowProxy(model, [shield, floor, body], [
    rod(V(0, 0.8, 0), V(0, 0.84, -0.78), 0.12, 6),
    rod(hp(0.085, -0.24, 0), hp(0.085, -forkLen, 0), 0.02, 4),
    rod(hp(-0.085, -0.24, 0), hp(-0.085, -forkLen, 0), 0.02, 4),
    rod(V(0.3, 1.1, 0.3), V(-0.3, 1.1, 0.3), 0.03, 4),
  ]);
  return model;
}

/** The sun's shadow of a bike: its bodywork, coarse stand-ins for the rest, and both wheels as discs. */
function shadowProxy(m: BikeModel, body: THREE.BufferGeometry[], extra: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const wheel = (z: number, hw: number) => cylinder(-hw, hw, m.wheelR, 14).translate(0, m.wheelR, z);
  return assembleShape([...body, ...extra, wheel(m.frontZ, 0.06), wheel(m.rearZ, 0.08)]);
}

const STYLES: Partial<Record<VehicleKind, BikeStyle>> = { sportbike: 'sport', scooter: 'scooter' };
const built = new Map<BikeStyle, BikeModel>();

/** The model of a bike kind (a kind with no style of its own is drawn as a sport bike), built once. */
export function bikeModel(kind: VehicleKind): BikeModel {
  const style = STYLES[kind] ?? 'sport';
  let m = built.get(style);
  if (!m) {
    m = style === 'scooter' ? scooterModel() : sportModel();
    built.set(style, m);
  }
  return m;
}

export const TREAD = { lugs: LUGS, depth: TREAD_DEPTH, halfWidth: TYRE_HW } as const;
