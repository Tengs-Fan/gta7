// Modelled guns, built from parts in the weapon's own frame (+z along the barrel, +y up, +x to the gun's left), so that
// CrowdView can place them with the sim's WeaponPose. Every gun is one merged geometry with vertex colours (one draw per
// gun kind for everyone holding it). Its sockets are measured on its parts: the muzzle is the front face of the part
// marked `muzzle`, the grip the centre of the part marked `grip`, the stock the butt (or, for the launcher, the tube
// centre) of the part marked `stock`; they sit on WEAPON_POINTS (sim/pose.ts), which the models are built around.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WeaponId } from '../sim/specs';

/** The guns (WEAPON_POINTS has a point set for each). */
export type GunId = 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'rocket' | 'sniper';
export const GUN_IDS: readonly GunId[] = ['pistol', 'smg', 'shotgun', 'rifle', 'rocket', 'sniper'];

type Role = 'muzzle' | 'grip' | 'stock' | 'fore';

interface Piece {
  geo: THREE.BufferGeometry;
  color: number;
  role?: Role;
}

export interface GunSockets {
  /** Centre of the muzzle's front face (where shots leave). */
  muzzle: THREE.Vector3;
  /** Unit barrel axis, from the back of the muzzle part to its front. */
  axis: THREE.Vector3;
  grip: THREE.Vector3;
  /** Butt end (long guns), the rear of the slide (pistol) or the tube centre (launcher). */
  stock: THREE.Vector3;
  /** Where the off hand holds (forend, pump, foregrip), or null when the gun has no part for it. */
  fore: THREE.Vector3 | null;
}

export interface GunModel {
  id: GunId;
  geometry: THREE.BufferGeometry;
  sockets: GunSockets;
  triangles: number;
}

// --- Part builders ---------------------------------------------------------------------------------------------

/** A box w x h x d centred at (x, y, z), turned by rx about x (positive: its bottom swings back, a raked grip). */
function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  return g.translate(x, y, z);
}

/** A cylinder along z from z0 to z1 (radius r0 at z0, r1 at z1), its axis at (x, y). */
function rod(r0: number, r1: number, z0: number, z1: number, x: number, y: number, seg = 12, open = false): THREE.BufferGeometry {
  // CylinderGeometry runs along +y with radiusTop at +y; rotateX(+90deg) turns +y into +z.
  return new THREE.CylinderGeometry(r1, r0, z1 - z0, seg, 1, open).rotateX(Math.PI / 2).translate(x, y, (z0 + z1) / 2);
}

/** A flat ring facing +z at depth z: the face of a muzzle around its bore. */
function ring(inner: number, outer: number, x: number, y: number, z: number, seg = 12): THREE.BufferGeometry {
  return new THREE.RingGeometry(inner, outer, seg).translate(x, y, z);
}

/** A disc facing +z (or -z). */
function disc(r: number, x: number, y: number, z: number, seg = 12, back = false): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(r, seg);
  if (back) g.rotateY(Math.PI);
  return g.translate(x, y, z);
}

/** Turns a closed surface inside out: front faces and normals point inward (the inner wall of a bore). */
function inward(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ni = g.index ? g.toNonIndexed() : g;
  const p = ni.getAttribute('position') as THREE.BufferAttribute;
  const n = ni.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i += 3) {
    for (const a of [p, n]) {
      const x = a.getX(i + 1), y = a.getY(i + 1), z = a.getZ(i + 1);
      a.setXYZ(i + 1, a.getX(i + 2), a.getY(i + 2), a.getZ(i + 2));
      a.setXYZ(i + 2, x, y, z);
    }
  }
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return ni;
}

/** A hollow barrel end: the outer tube from z0 to z1, the annular face at z1 and a dark bore `depth` deep with its floor. */
function bore(rOuter: number, rBore: number, z0: number, z1: number, x: number, y: number, depth: number, color: number, seg = 12): Piece[] {
  return [
    { geo: rod(rOuter, rOuter, z0, z1, x, y, seg, true), color, role: 'muzzle' },
    { geo: ring(rBore, rOuter, x, y, z1, seg), color, role: 'muzzle' },
    { geo: inward(rod(rBore, rBore, z1 - depth, z1, x, y, seg, true)), color: BORE },
    { geo: disc(rBore, x, y, z1 - depth, seg), color: BORE },
  ];
}

/** A side profile (points as [z, y]) extruded `w` wide, centred on x = 0: stocks and receivers with sloped lines. */
function profile(points: ReadonlyArray<readonly [number, number]>, w: number, bevel = 0.003): THREE.BufferGeometry {
  const s = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth: w - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
  // Shape x -> weapon z, shape y -> weapon y, extrusion (+z) -> weapon x.
  // A rotation (not a mirror), so the faces keep their winding.
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  return g.translate((w - bevel * 2) / 2, 0, 0);
}

/** Half a torus in the y-z plane below (x, y, z): a trigger guard spanning `span` along z. */
function guard(span: number, tube: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.TorusGeometry(span / 2, tube, 4, 10, Math.PI).rotateZ(Math.PI).rotateY(Math.PI / 2).translate(x, y, z);
}

// --- Palette ---------------------------------------------------------------------------------------------------

const BORE = 0x040404;
const STEEL = 0x3a3d42;
const BLUED = 0x24272c;
const POLYMER = 0x1b1c1e;
const GRIP = 0x141414;
const PANEL = 0x2a2724;
const WOOD = 0x6a4224;
const WOOD_DARK = 0x4a2c17;
const OLIVE = 0x4a5236;
const OLIVE_DARK = 0x353b27;
const TAN = 0x7a6a4c;
const RUBBER = 0x101010;
const DOT = 0xd8d2b4;
const LENS = 0x203a5a;

/** Grooves across a part along z: thin dark bands standing proud of a surface w wide. */
function grooves(n: number, w: number, h: number, x: number, y: number, z0: number, step: number, color: number): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < n; i++) out.push({ geo: box(w, h, 0.0025, x, y, z0 + i * step), color });
  return out;
}

// --- The guns --------------------------------------------------------------------------------------------------

function pistol(): Piece[] {
  const rake = 0.3;
  return [
    // Slide: its rear face is the stock point, the barrel crown is the tip.
    { geo: box(0.028, 0.032, 0.21, 0, 0, 0.095), color: STEEL, role: 'stock' },
    ...grooves(5, 0.0292, 0.024, 0, 0.002, 0.004, 0.006, BLUED),
    // Ejection port on the right (-x) side, and the barrel hood showing in it.
    { geo: box(0.002, 0.012, 0.034, -0.0142, 0.007, 0.085), color: BLUED },
    ...bore(0.0085, 0.0048, 0.19, 0.21, 0, 0, 0.012, STEEL, 10),
    // Frame, accessory rail and dust cover.
    { geo: box(0.026, 0.017, 0.165, 0, -0.024, 0.088), color: POLYMER },
    { geo: box(0.022, 0.008, 0.055, 0, -0.035, 0.15), color: POLYMER },
    ...grooves(4, 0.0225, 0.004, 0, -0.04, 0.13, 0.012, BLUED),
    // Raked grip with textured panels and the magazine's base plate.
    { geo: box(0.03, 0.105, 0.046, 0, -0.065, 0.02, rake), color: GRIP, role: 'grip' },
    { geo: box(0.0322, 0.066, 0.032, 0, -0.07, 0.018, rake), color: PANEL },
    { geo: box(0.032, 0.008, 0.05, 0, -0.118, 0.004, rake), color: POLYMER },
    // Beavertail and hammer.
    { geo: box(0.022, 0.01, 0.018, 0, -0.022, -0.012), color: POLYMER },
    { geo: box(0.008, 0.014, 0.008, 0, 0.004, -0.013, -0.4), color: BLUED },
    // Trigger guard and trigger.
    { geo: guard(0.042, 0.0032, 0, -0.032, 0.055), color: POLYMER },
    { geo: box(0.005, 0.016, 0.005, 0, -0.041, 0.052, -0.25), color: BLUED },
    // Sights: a front post with a dot, a notched rear sight.
    { geo: box(0.005, 0.007, 0.007, 0, 0.0195, 0.198), color: BLUED },
    { geo: box(0.0028, 0.0028, 0.001, 0, 0.0205, 0.2018), color: DOT },
    { geo: box(0.0075, 0.007, 0.007, 0.0065, 0.0195, 0.003), color: BLUED },
    { geo: box(0.0075, 0.007, 0.007, -0.0065, 0.0195, 0.003), color: BLUED },
    { geo: box(0.018, 0.003, 0.007, 0, 0.0175, 0.003), color: BLUED },
  ];
}

function smg(): Piece[] {
  return [
    // Receiver and the lower trigger housing.
    { geo: box(0.044, 0.056, 0.29, 0, 0, 0.115), color: STEEL },
    { geo: box(0.038, 0.03, 0.13, 0, -0.04, 0.075), color: POLYMER },
    // Handguard (where the off hand holds) with grip grooves.
    { geo: box(0.05, 0.05, 0.1, 0, -0.03, 0.27), color: POLYMER, role: 'fore' },
    ...grooves(5, 0.0505, 0.036, 0, -0.03, 0.23, 0.02, GRIP),
    // Barrel, a short shroud and the muzzle.
    { geo: rod(0.017, 0.015, 0.26, 0.345, 0, 0, 12), color: BLUED },
    ...bore(0.011, 0.0055, 0.345, 0.37, 0, 0, 0.014, BLUED),
    // Magazine, a little curved forward, under the receiver's front.
    { geo: box(0.026, 0.14, 0.036, 0, -0.1, 0.19, -0.1), color: BLUED },
    // Raked pistol grip, trigger guard and trigger.
    { geo: box(0.03, 0.1, 0.042, 0, -0.1, 0.06, 0.28), color: GRIP, role: 'grip' },
    { geo: box(0.0322, 0.06, 0.03, 0, -0.105, 0.058, 0.28), color: PANEL },
    { geo: guard(0.04, 0.0035, 0, -0.054, 0.105), color: POLYMER },
    { geo: box(0.005, 0.015, 0.005, 0, -0.062, 0.1, -0.25), color: BLUED },
    // Folded stock: a butt plate at the back and its two struts along the sides.
    { geo: box(0.046, 0.075, 0.016, 0, -0.01, -0.042), color: POLYMER, role: 'stock' },
    { geo: box(0.006, 0.008, 0.16, 0.026, 0.006, 0.03), color: BLUED },
    { geo: box(0.006, 0.008, 0.16, -0.026, -0.026, 0.03), color: BLUED },
    // Charging handle on the left, ejection port on the right.
    { geo: rod(0.005, 0.005, 0.2, 0.235, 0.025, 0.016, 6), color: BLUED },
    { geo: box(0.002, 0.014, 0.04, -0.0225, 0.01, 0.13), color: GRIP },
    // Drum rear sight and a hooded front post.
    { geo: new THREE.CylinderGeometry(0.011, 0.011, 0.02, 10).rotateZ(Math.PI / 2).translate(0, 0.036, 0.01), color: BLUED },
    { geo: box(0.004, 0.022, 0.012, 0.011, 0.035, 0.315), color: BLUED },
    { geo: box(0.004, 0.022, 0.012, -0.011, 0.035, 0.315), color: BLUED },
    { geo: box(0.004, 0.014, 0.006, 0, 0.033, 0.315), color: BLUED },
  ];
}

function shotgun(): Piece[] {
  return [
    // Receiver with the loading port underneath and the ejection port on the right.
    { geo: profile([[-0.03, 0.02], [0.17, 0.02], [0.17, -0.034], [0.11, -0.036], [-0.03, -0.036]], 0.042), color: BLUED },
    { geo: box(0.002, 0.016, 0.06, -0.0215, 0.002, 0.07), color: GRIP },
    // Barrel and the magazine tube under it; a bead front sight.
    { geo: rod(0.0125, 0.0125, 0.17, 0.725, 0, 0, 14), color: BLUED },
    ...bore(0.0135, 0.0095, 0.725, 0.75, 0, 0, 0.016, STEEL, 14),
    { geo: rod(0.011, 0.011, 0.17, 0.66, 0, -0.026, 12), color: BLUED },
    { geo: disc(0.011, 0, -0.026, 0.66, 12), color: STEEL },
    { geo: new THREE.SphereGeometry(0.0035, 6, 4).translate(0, 0.0155, 0.735), color: DOT },
    // Barrel ring joining the tube at the front.
    { geo: box(0.026, 0.05, 0.016, 0, -0.012, 0.64), color: BLUED },
    // Pump (where the off hand holds): a grooved wooden forend round the magazine tube.
    { geo: rod(0.022, 0.022, 0.24, 0.4, 0, -0.02, 12), color: WOOD, role: 'fore' },
    ...[0.255, 0.275, 0.295, 0.315, 0.335, 0.355, 0.375].map((z): Piece => ({ geo: rod(0.0228, 0.0228, z, z + 0.006, 0, -0.02, 12), color: WOOD_DARK })),
    // Pistol grip, trigger guard and trigger.
    { geo: box(0.03, 0.085, 0.042, 0, -0.07, 0.05, 0.32), color: WOOD, role: 'grip' },
    { geo: guard(0.045, 0.0035, 0, -0.036, 0.098), color: BLUED },
    { geo: box(0.005, 0.016, 0.005, 0, -0.045, 0.095, -0.25), color: STEEL },
    // Wooden stock, its comb sloping down to the rubber butt pad.
    { geo: profile([[-0.03, 0.015], [-0.228, 0.008], [-0.228, -0.086], [-0.12, -0.064], [-0.03, -0.036]], 0.036), color: WOOD, role: 'stock' },
    { geo: box(0.038, 0.096, 0.017, 0, -0.039, -0.2365), color: RUBBER, role: 'stock' },
  ];
}

function rifle(): Piece[] {
  return [
    // Upper receiver with a top rail, lower receiver, buffer tube.
    { geo: box(0.034, 0.044, 0.265, 0, 0, 0.1), color: STEEL },
    { geo: box(0.022, 0.009, 0.56, 0, 0.0265, 0.2), color: BLUED },
    ...grooves(14, 0.0226, 0.006, 0, 0.029, -0.06, 0.04, POLYMER),
    { geo: box(0.032, 0.036, 0.2, 0, -0.038, 0.085), color: BLUED },
    { geo: rod(0.016, 0.016, -0.14, -0.03, 0, -0.004, 10), color: BLUED },
    // Octagonal handguard (where the off hand holds) with vents.
    { geo: rod(0.034, 0.034, 0.22, 0.48, 0, -0.016, 8), color: POLYMER, role: 'fore' },
    ...[0.25, 0.3, 0.35, 0.4, 0.45].flatMap((z): Piece[] => [
      { geo: box(0.0695, 0.012, 0.022, 0, -0.016, z), color: GRIP },
    ]),
    // Barrel, gas block and front sight post, flash hider with its slots.
    { geo: rod(0.009, 0.009, 0.48, 0.665, 0, 0, 10), color: BLUED },
    { geo: box(0.02, 0.026, 0.024, 0, -0.002, 0.53), color: BLUED },
    { geo: box(0.012, 0.042, 0.014, 0, 0.026, 0.53), color: BLUED },
    { geo: box(0.004, 0.016, 0.004, 0, 0.054, 0.53), color: BLUED },
    ...bore(0.0115, 0.0065, 0.665, 0.705, 0, 0, 0.02, STEEL, 10),
    { geo: box(0.0236, 0.003, 0.024, 0, 0.0035, 0.688), color: BORE },
    { geo: box(0.003, 0.0236, 0.024, 0, -0.002, 0.688), color: BORE },
    // Curved magazine.
    { geo: box(0.024, 0.075, 0.062, 0, -0.085, 0.118, -0.1), color: BLUED },
    { geo: box(0.024, 0.075, 0.062, 0, -0.152, 0.13, -0.28), color: BLUED },
    // Raked pistol grip, trigger guard and trigger.
    { geo: box(0.028, 0.1, 0.04, 0, -0.1, 0.06, 0.35), color: GRIP, role: 'grip' },
    { geo: box(0.012, 0.005, 0.06, 0, -0.074, 0.11), color: BLUED },
    { geo: box(0.01, 0.022, 0.006, 0, -0.064, 0.14), color: BLUED },
    { geo: box(0.005, 0.016, 0.005, 0, -0.064, 0.105, -0.25), color: STEEL },
    // Rear sight and charging handle; ejection port with its forward assist on the right.
    { geo: box(0.02, 0.022, 0.03, 0, 0.042, 0.02), color: BLUED },
    { geo: box(0.004, 0.012, 0.012, 0, 0.058, 0.02), color: BLUED },
    { geo: box(0.032, 0.008, 0.02, 0, 0.02, -0.04), color: BLUED },
    { geo: box(0.002, 0.014, 0.05, -0.0175, 0.004, 0.09), color: GRIP },
    { geo: rod(0.006, 0.006, 0.01, 0.04, -0.018, 0.012, 6), color: BLUED },
    // Stock: a sloped butt on the buffer tube, with a rubber pad.
    { geo: profile([[-0.11, 0.018], [-0.24, 0.018], [-0.24, -0.078], [-0.18, -0.06], [-0.11, -0.024]], 0.034), color: POLYMER, role: 'stock' },
    { geo: box(0.036, 0.098, 0.012, 0, -0.03, -0.244), color: RUBBER, role: 'stock' },
  ];
}

function sniper(): Piece[] {
  return [
    // Round receiver on a chassis, bolt handle on the right.
    { geo: rod(0.018, 0.018, -0.02, 0.26, 0, 0, 14), color: BLUED },
    { geo: box(0.04, 0.028, 0.29, 0, -0.03, 0.12), color: OLIVE },
    { geo: new THREE.CylinderGeometry(0.0045, 0.0045, 0.045, 6).rotateZ(Math.PI / 2).translate(-0.04, -0.004, 0.02), color: STEEL },
    { geo: new THREE.SphereGeometry(0.009, 8, 6).translate(-0.064, -0.012, 0.02), color: STEEL },
    // Long, slightly tapered barrel and a ported muzzle brake.
    { geo: rod(0.012, 0.0095, 0.26, 0.975, 0, 0, 12), color: BLUED },
    { geo: box(0.032, 0.024, 0.045, 0, 0, 0.9875), color: STEEL },
    ...bore(0.0115, 0.0065, 0.9875, 1.02, 0, 0, 0.03, STEEL, 10),
    { geo: box(0.0325, 0.006, 0.008, 0, 0, 0.978), color: BORE },
    { geo: box(0.0325, 0.006, 0.008, 0, 0, 0.995), color: BORE },
    // Forend under the barrel (where the off hand holds), with a folded bipod.
    { geo: profile([[0.0, -0.008], [0.52, -0.008], [0.52, -0.03], [0.46, -0.042], [0.0, -0.042]], 0.046), color: OLIVE, role: 'fore' },
    { geo: box(0.006, 0.006, 0.2, 0.012, -0.047, 0.4), color: BLUED },
    { geo: box(0.006, 0.006, 0.2, -0.012, -0.047, 0.4), color: BLUED },
    // Box magazine.
    { geo: box(0.03, 0.1, 0.07, 0, -0.085, 0.14), color: BLUED },
    // Raked pistol grip, trigger guard and trigger.
    { geo: box(0.03, 0.11, 0.042, 0, -0.1, 0.06, 0.25), color: OLIVE_DARK, role: 'grip' },
    { geo: guard(0.042, 0.0035, 0, -0.044, 0.1), color: BLUED },
    { geo: box(0.005, 0.015, 0.005, 0, -0.052, 0.097, -0.25), color: STEEL },
    // Stock with a raised cheek rest and a rubber pad.
    { geo: profile([[-0.02, 0.0], [-0.12, 0.024], [-0.255, 0.024], [-0.255, -0.082], [-0.12, -0.056], [-0.02, -0.044]], 0.04), color: OLIVE, role: 'stock' },
    { geo: box(0.042, 0.11, 0.015, 0, -0.03, -0.2625), color: RUBBER, role: 'stock' },
    // Scope: tube, bells with lenses, turrets and two rings.
    { geo: rod(0.016, 0.016, 0.0, 0.27, 0, 0.068, 14), color: POLYMER },
    { geo: rod(0.016, 0.026, 0.27, 0.34, 0, 0.068, 14), color: POLYMER },
    { geo: disc(0.024, 0, 0.068, 0.3402, 14), color: LENS },
    { geo: rod(0.021, 0.016, -0.06, 0.0, 0, 0.068, 14), color: POLYMER },
    { geo: disc(0.019, 0, 0.068, -0.0602, 14, true), color: LENS },
    { geo: new THREE.CylinderGeometry(0.011, 0.011, 0.022, 10).translate(0, 0.093, 0.13), color: BLUED },
    { geo: new THREE.CylinderGeometry(0.011, 0.011, 0.022, 10).rotateZ(Math.PI / 2).translate(0.024, 0.068, 0.13), color: BLUED },
    { geo: box(0.036, 0.05, 0.016, 0, 0.04, 0.05), color: BLUED },
    { geo: box(0.036, 0.05, 0.016, 0, 0.04, 0.21), color: BLUED },
  ];
}

function rocket(): Piece[] {
  const y = 0.08;
  return [
    // The tube (its centre is the stock point, which rests on the shoulder), with darker bands.
    { geo: rod(0.075, 0.075, -0.33, 0.735, 0, y, 18, true), color: OLIVE, role: 'stock' },
    ...[-0.2, 0.42, 0.6].map((z): Piece => ({ geo: rod(0.078, 0.078, z, z + 0.03, 0, y, 18), color: OLIVE_DARK })),
    // Flared muzzle with the open bore, and the rear blast cone, open too.
    ...bore(0.085, 0.068, 0.735, 0.775, 0, y, 0.3, OLIVE_DARK, 18),
    { geo: rod(0.075, 0.075, -0.375, -0.33, 0, y, 18, true), color: OLIVE_DARK, role: 'stock' },
    { geo: rod(0.092, 0.076, -0.375, -0.345, 0, y, 18, true), color: OLIVE_DARK },
    { geo: new THREE.RingGeometry(0.066, 0.092, 18).rotateY(Math.PI).translate(0, y, -0.375), color: OLIVE_DARK },
    { geo: inward(rod(0.066, 0.066, -0.375, -0.15, 0, y, 18, true)), color: BORE },
    { geo: disc(0.066, 0, y, -0.15, 18, true), color: BORE },
    // Sight block on top with its lens.
    { geo: box(0.034, 0.024, 0.06, 0, y + 0.085, 0.3), color: TAN },
    { geo: box(0.03, 0.04, 0.09, 0, y + 0.115, 0.3), color: OLIVE_DARK },
    { geo: disc(0.012, 0, y + 0.118, 0.3452, 10), color: LENS },
    // Trigger mount, raked grip, trigger guard; a vertical foregrip for the off hand.
    { geo: box(0.032, 0.05, 0.11, 0, -0.008, 0.11), color: TAN },
    { geo: box(0.03, 0.1, 0.045, 0, -0.075, 0.1, 0.25), color: GRIP, role: 'grip' },
    { geo: guard(0.04, 0.0035, 0, -0.033, 0.145), color: GRIP },
    { geo: box(0.005, 0.015, 0.005, 0, -0.04, 0.143, -0.25), color: STEEL },
    { geo: box(0.028, 0.075, 0.04, 0, -0.02, 0.32), color: GRIP, role: 'fore' },
    // Shoulder pad along the tube's underside behind the grip.
    { geo: box(0.04, 0.016, 0.16, 0, 0.0, -0.04), color: RUBBER },
  ];
}

const BUILDERS: Readonly<Record<GunId, () => Piece[]>> = { pistol, smg, shotgun, rifle, rocket, sniper };

/** How each gun's stock socket is read off its `stock` parts: the butt (rear face), or the tube centre (launcher). */
const STOCK_AT: Readonly<Record<GunId, 'rear' | 'centre'>> = { pistol: 'rear', smg: 'rear', shotgun: 'rear', rifle: 'rear', sniper: 'rear', rocket: 'centre' };

function boundsOf(pieces: readonly Piece[], role: Role): THREE.Box3 | null {
  const b = new THREE.Box3();
  let any = false;
  for (const p of pieces) {
    if (p.role !== role) continue;
    p.geo.computeBoundingBox();
    b.union(p.geo.boundingBox!);
    any = true;
  }
  return any ? b : null;
}

function socketsOf(id: GunId, pieces: readonly Piece[]): GunSockets {
  const m = boundsOf(pieces, 'muzzle')!;
  const g = boundsOf(pieces, 'grip')!;
  const s = boundsOf(pieces, 'stock')!;
  // The launcher's tube runs through its muzzle: its centre is taken over both.
  if (STOCK_AT[id] === 'centre') s.union(m);
  const f = boundsOf(pieces, 'fore');
  const mc = m.getCenter(new THREE.Vector3());
  const sc = s.getCenter(new THREE.Vector3());
  return {
    muzzle: new THREE.Vector3(mc.x, mc.y, m.max.z),
    axis: new THREE.Vector3(mc.x, mc.y, m.max.z).sub(new THREE.Vector3(mc.x, mc.y, m.min.z)).normalize(),
    grip: g.getCenter(new THREE.Vector3()),
    stock: STOCK_AT[id] === 'centre' ? sc : new THREE.Vector3(sc.x, sc.y, s.min.z),
    // The off hand wraps a grip part round its centre, and holds a forend from under it.
    fore: f ? (id === 'rocket' ? f.getCenter(new THREE.Vector3()) : new THREE.Vector3((f.min.x + f.max.x) / 2, f.min.y, (f.min.z + f.max.z) / 2)) : null,
  };
}

/** One geometry from coloured parts: non-indexed, position + normal + linear vertex colour (no uvs). */
function merge(pieces: readonly Piece[]): THREE.BufferGeometry {
  const c = new THREE.Color();
  const parts = pieces.map((p) => {
    const g = (p.geo.index ? p.geo.toNonIndexed() : p.geo.clone());
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    c.setHex(p.color);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
  const m = mergeGeometries(parts, false);
  if (!m) throw new Error('weapon merge failed');
  m.computeBoundingBox();
  m.computeBoundingSphere();
  return m;
}

const cache = new Map<GunId, GunModel>();

/** The modelled gun `id` (shared: callers must not dispose it). */
export function gunModel(id: GunId): GunModel {
  let model = cache.get(id);
  if (!model) {
    const pieces = BUILDERS[id]();
    const geometry = merge(pieces);
    model = { id, geometry, sockets: socketsOf(id, pieces), triangles: geometry.getAttribute('position').count / 3 };
    cache.set(id, model);
  }
  return model;
}

/** A fresh copy of a gun's geometry, for a mesh that owns it (CrowdView adds its own per-instance attributes). */
export function gunGeometry(id: GunId): THREE.BufferGeometry {
  return gunModel(id).geometry.clone();
}

/** Whether a weapon is one of the modelled guns (the rest are melee weapons and throwables, held in the hand). */
export function isGunId(id: WeaponId): id is GunId {
  return (GUN_IDS as readonly string[]).includes(id);
}

/**
 * Gun models per tier: the same modelled geometry everywhere (it is small: 0.3-1.6k triangles, one draw per gun kind
 * in view), drawn with the crowd's lit material on hardware tiers and its vertex-lit swap on software.
 */
export const GUN_TIERS = {
  high: 'modelled, lit, casts shadows',
  medium: 'modelled, lit, casts shadows',
  low: 'modelled, lit, no shadows (Low has none)',
  software: 'modelled, vertex-lit (software swap)',
} as const;

/** The most of one gun kind drawn at once: one InstancedMesh per kind, sized like the crowd (CrowdView MAX). */
export const GUN_CAP = 240;
