// Modelled guns, built from parts in the weapon's own frame (+z along the barrel, +y up, +x to the gun's left), so that
// CrowdView can place them with the sim's WeaponPose. Every gun is one merged geometry with vertex colours (one draw per
// gun kind for everyone holding it). Its sockets are measured on its parts: the muzzle is the front face of the part
// marked `muzzle`, the grip the centre of the part marked `grip`, the stock the butt (or, for the launcher, the tube
// centre) of the part marked `stock`; they sit on WEAPON_POINTS (sim/pose.ts), which the models are built around.
//
// The bodies are side profiles extruded across the gun with their edges chamfered (`slab`): from the aiming camera,
// 2.4 m behind the shoulder, a pistol is about 25 px long, so what reads is the silhouette (slide over frame, a raked
// grip, a magazine, a stock, a scope) and the tones (a grey steel slide or receiver over black polymer, wood, olive),
// not sub-pixel grooves. The crowd draws every gun with one lit material (metalness 0.45), under which the colours
// below are what the eye sees; anything darker than about 0x303030 reads as black there.

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

type Pts = ReadonlyArray<readonly [number, number]>;

// --- Part builders ---------------------------------------------------------------------------------------------

/** A box w x h x d centred at (x, y, z), turned by rx about x (positive: its bottom swings back). For parts under 1 cm. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  return g.translate(x, y, z);
}

/**
 * A cylinder along z from z0 to z1 (radius r0 at z0, r1 at z1), its axis at (x, y). `seg` 8 with `flats` puts flat
 * faces on top, bottom and sides (an octagonal handguard).
 */
function rod(r0: number, r1: number, z0: number, z1: number, x: number, y: number, seg = 10, open = false, flats = false): THREE.BufferGeometry {
  // CylinderGeometry runs along +y with radiusTop at +y; rotateX(+90deg) turns +y into +z.
  return new THREE.CylinderGeometry(r1, r0, z1 - z0, seg, 1, open, flats ? Math.PI / seg : 0).rotateX(Math.PI / 2).translate(x, y, (z0 + z1) / 2);
}

/** A flat ring facing +z at depth z: the face of a muzzle around its bore. */
function ring(inner: number, outer: number, x: number, y: number, z: number, seg: number): THREE.BufferGeometry {
  return new THREE.RingGeometry(inner, outer, seg, 1).translate(x, y, z);
}

/** A disc facing +z (or -z). */
function disc(r: number, x: number, y: number, z: number, seg: number, back = false): THREE.BufferGeometry {
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
function bore(rOuter: number, rBore: number, z0: number, z1: number, x: number, y: number, depth: number, color: number, seg: number): Piece[] {
  return [
    { geo: rod(rOuter, rOuter, z0, z1, x, y, seg, true), color, role: 'muzzle' },
    { geo: ring(rBore, rOuter, x, y, z1, seg), color, role: 'muzzle' },
    { geo: inward(rod(rBore, rBore, z1 - depth, z1, x, y, seg, true)), color: BORE },
    { geo: disc(rBore, x, y, z1 - depth, seg), color: BORE },
  ];
}

/**
 * A side profile (points as [z, y]) extruded `w` wide about x, its outline exact (the bevel is cut inward, so a socket
 * read off its bounds stays put) and its edges chamfered by `bevel`; `holes` are cut through it (a trigger guard).
 * 8n - 4 triangles for n outline points.
 */
function slab(points: Pts, w: number, bevel = 0.002, x = 0, holes: Pts[] = []): THREE.BufferGeometry {
  const s = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  for (const h of holes) s.holes.push(new THREE.Path(h.map(([z, y]) => new THREE.Vector2(z, y))));
  const depth = w - bevel * 2;
  const g = new THREE.ExtrudeGeometry(s, { depth, steps: 1, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1, curveSegments: 1 });
  // Shape x -> weapon z, shape y -> weapon y, extrusion (+z) -> weapon -x: a rotation (not a mirror), so the faces keep
  // their winding.
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  return g.translate(x + depth / 2, 0, 0);
}

/** A flat panel facing along `axis` (+x, -x, +y, -y, +z or -z) at `at`, `u` x `v` big: a port, a groove, a sight dot. */
function panel(axis: '+x' | '-x' | '+y' | '-y' | '-z', at: readonly [number, number, number], u: number, v: number): THREE.BufferGeometry {
  // PlaneGeometry faces +z with u along x and v along y.
  const g = new THREE.PlaneGeometry(u, v);
  if (axis === '+x') g.rotateY(Math.PI / 2); // u along -z, v along y
  else if (axis === '-x') g.rotateY(-Math.PI / 2);
  else if (axis === '+y') g.rotateX(-Math.PI / 2); // u along x, v along -z
  else if (axis === '-y') g.rotateX(Math.PI / 2);
  else g.rotateY(Math.PI);
  return g.translate(at[0], at[1], at[2]);
}

/** The same panel on both sides of a part w wide (x = +-w/2), centred at (y, z), u along z and v along y. */
function sides(w: number, y: number, z: number, u: number, v: number, color: number): Piece[] {
  return [
    { geo: panel('+x', [w / 2, y, z], u, v), color },
    { geo: panel('-x', [-w / 2, y, z], u, v), color },
  ];
}

/** Moves a part so that its bounding box's centre is at `at` (a grip whose socket is its centre). */
function centreOn(g: THREE.BufferGeometry, at: readonly [number, number, number]): THREE.Matrix4 {
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new THREE.Vector3());
  const m = new THREE.Matrix4().makeTranslation(at[0] - c.x, at[1] - c.y, at[2] - c.z);
  g.applyMatrix4(m);
  return m;
}

/**
 * A raked pistol grip from its outline drawn upright ([z, y], its front at +z, its top at y = 0), tilted back by `rake`
 * and moved so its centre is the grip socket; its base plate (the magazine's or the grip cap) goes with it.
 */
function gripPieces(outline: Pts, w: number, bevel: number, rake: number, at: readonly [number, number, number], color: number, base: { color: number; h: number } | null): Piece[] {
  const g = slab(outline, w, bevel).rotateX(rake);
  const m = centreOn(g, at);
  const out: Piece[] = [{ geo: g, color, role: 'grip' }];
  if (base) {
    const zs = outline.map(([z]) => z);
    const bottom = Math.min(...outline.map(([, y]) => y));
    const d = Math.max(...zs) - Math.min(...zs);
    const cz = (Math.max(...zs) + Math.min(...zs)) / 2;
    out.push({ geo: box(w + 0.002, base.h, d * 0.92, 0, bottom - base.h / 2 + 0.002, cz).rotateX(rake).applyMatrix4(m), color: base.color });
  }
  return out;
}

/** A trigger guard: half a ring in the y-z plane below (y, z), `span` long; three sides to its tube. */
function guard(span: number, tube: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.TorusGeometry(span / 2, tube, 3, 8, Math.PI).rotateZ(Math.PI).rotateY(Math.PI / 2).translate(0, y, z);
}

/** A trigger: a curved blade hanging from (y, z). */
function trigger(y: number, z: number): THREE.BufferGeometry {
  return slab([[z + 0.003, y], [z + 0.002, y - 0.012], [z - 0.004, y - 0.017], [z - 0.002, y - 0.008], [z - 0.003, y]], 0.006, 0.001);
}

// --- Palette ---------------------------------------------------------------------------------------------------

const BORE = 0x050505;
/** A pistol's slide and a rifle's receiver: grey steel. */
const GUNMETAL = 0x6c7077;
/** Bare steel where it shows: a barrel's crown, a bolt, a hood in the ejection port. */
const STEEL = 0xa2a6ad;
/** Darker steel: barrels, magazines, sights and small parts. */
const BLUED = 0x41454c;
const POLYMER = 0x2b2c2f;
const GRIP = 0x232426;
const PORT = 0x111214;
const WOOD = 0x9a6436;
const WOOD_DARK = 0x5d3a1e;
const OLIVE = 0x66704a;
const OLIVE_DARK = 0x4a5236;
const TAN = 0xa08a62;
const RUBBER = 0x1c1c1d;
const DOT = 0xeae4c6;
const LENS = 0x34618f;

// --- The guns --------------------------------------------------------------------------------------------------

function pistol(): Piece[] {
  // Slide (the stock socket is its rear face): a 4 mm chamfer along its top edges, the front of its top cut down to the
  // muzzle, its rear face raked back.
  const slide = slab([[-0.01, -0.0155], [0.204, -0.0155], [0.204, 0.011], [0.197, 0.0165], [-0.004, 0.0165], [-0.01, 0.01]], 0.027, 0.0035);
  const out: Piece[] = [
    { geo: slide, color: GUNMETAL, role: 'stock' },
    // Barrel crown standing out of the slide's front, hollow.
    ...bore(0.0078, 0.0046, 0.198, 0.21, 0, 0, 0.012, STEEL, 10),
    // Ejection port on the right (-x) side and over the top, the barrel's hood showing in it.
    { geo: panel('-x', [-0.01355, 0.006, 0.096], 0.042, 0.012), color: PORT },
    { geo: panel('-x', [-0.0137, 0.0068, 0.096], 0.032, 0.007), color: STEEL },
    { geo: panel('+y', [-0.004, 0.01655, 0.096], 0.011, 0.042), color: PORT },
    { geo: panel('+y', [-0.001, 0.0167, 0.096], 0.006, 0.032), color: STEEL },
    // Frame, its dust cover with a rail under it and the trigger guard cut through it, the beavertail over the hand.
    {
      geo: slab(
        [[-0.008, -0.0155], [0.188, -0.0155], [0.19, -0.0195], [0.188, -0.031], [0.122, -0.031], [0.116, -0.034], [0.11, -0.054], [0.104, -0.06], [0.07, -0.06], [0.062, -0.054], [0.056, -0.04], [0.0, -0.032], [-0.02, -0.028], [-0.027, -0.023], [-0.025, -0.0185]],
        0.025, 0.003, 0,
        [[[0.1, -0.035], [0.097, -0.051], [0.093, -0.055], [0.072, -0.055], [0.066, -0.049], [0.064, -0.035]]],
      ),
      color: POLYMER,
    },
    // Rail slots under the dust cover.
    ...[0.135, 0.152, 0.169].map((z): Piece => ({ geo: panel('-y', [0, -0.0312, z], 0.019, 0.005), color: PORT })),
    // Raked grip with its palm swell, and the magazine's base plate.
    ...gripPieces([[0.02, 0], [0.023, -0.03], [0.021, -0.06], [0.02, -0.093], [-0.021, -0.093], [-0.024, -0.06], [-0.026, -0.03], [-0.022, 0]], 0.03, 0.005, 0.3, [0, -0.065, 0.02], GRIP, { color: BLUED, h: 0.007 }),
    { geo: trigger(-0.035, 0.083), color: BLUED },
    // Slide stop and takedown lever on the left.
    { geo: box(0.0016, 0.0035, 0.024, 0.0131, -0.0185, 0.088), color: BLUED },
    { geo: box(0.0016, 0.003, 0.009, 0.0131, -0.0245, 0.112), color: BLUED },
    // Sights: a front post with a white dot facing the shooter, a notched rear sight with two dots.
    { geo: box(0.0035, 0.006, 0.006, 0, 0.0195, 0.193), color: BLUED },
    { geo: panel('-z', [0, 0.0205, 0.1899], 0.0024, 0.0024), color: DOT },
    { geo: box(0.0075, 0.0065, 0.007, 0.0062, 0.0197, 0.006), color: BLUED },
    { geo: box(0.0075, 0.0065, 0.007, -0.0062, 0.0197, 0.006), color: BLUED },
    { geo: panel('-z', [0.0062, 0.0205, 0.0024], 0.0022, 0.0022), color: DOT },
    { geo: panel('-z', [-0.0062, 0.0205, 0.0024], 0.0022, 0.0022), color: DOT },
  ];
  // Cocking serrations at the back of the slide and at its front.
  for (let i = 0; i < 6; i++) out.push(...sides(0.0272, -0.0005, 0.004 + i * 0.0055, 0.0022, 0.021, PORT));
  for (let i = 0; i < 4; i++) out.push(...sides(0.0272, -0.0005, 0.158 + i * 0.0055, 0.0022, 0.021, PORT));
  return out;
}

function smg(): Piece[] {
  const out: Piece[] = [
    // Upper receiver in grey steel, its top running down to the barrel shroud.
    { geo: slab([[-0.03, -0.02], [-0.03, 0.022], [-0.022, 0.03], [0.2, 0.03], [0.238, 0.022], [0.25, 0.01], [0.25, -0.02]], 0.042, 0.004), color: GUNMETAL },
    // Lower receiver in polymer: the magazine well ahead of the trigger guard cut through it.
    {
      geo: slab(
        [[-0.022, -0.02], [0.215, -0.02], [0.215, -0.032], [0.206, -0.04], [0.204, -0.062], [0.156, -0.062], [0.153, -0.042], [0.142, -0.042], [0.138, -0.072], [0.13, -0.08], [0.1, -0.08], [0.092, -0.06], [0.04, -0.045], [-0.022, -0.04]],
        0.036, 0.003, 0,
        [[[0.134, -0.046], [0.131, -0.068], [0.126, -0.074], [0.104, -0.074], [0.099, -0.062], [0.099, -0.046]]],
      ),
      color: POLYMER,
    },
    // Handguard (where the off hand holds) with its grip grooves.
    { geo: slab([[0.215, -0.022], [0.33, -0.022], [0.33, -0.05], [0.32, -0.058], [0.225, -0.058], [0.215, -0.05]], 0.046, 0.005), color: POLYMER, role: 'fore' },
    ...[0.24, 0.26, 0.28, 0.3].flatMap((z) => sides(0.0462, -0.042, z, 0.006, 0.02, GRIP)),
    // Barrel shroud and the hollow muzzle.
    { geo: rod(0.016, 0.014, 0.25, 0.345, 0, 0, 8, true), color: BLUED },
    ...bore(0.0105, 0.0055, 0.345, 0.37, 0, 0, 0.014, BLUED, 8),
    // Straight box magazine raked a little forward, its base plate.
    { geo: slab([[0.158, -0.04], [0.2, -0.04], [0.21, -0.168], [0.17, -0.168]], 0.026, 0.003), color: BLUED },
    { geo: box(0.03, 0.008, 0.046, 0, -0.17, 0.19), color: POLYMER },
    // Raked pistol grip, trigger.
    ...gripPieces([[0.021, 0], [0.024, -0.035], [0.022, -0.07], [0.02, -0.1], [-0.02, -0.1], [-0.023, -0.07], [-0.025, -0.035], [-0.021, 0]], 0.032, 0.006, 0.28, [0, -0.1, 0.06], GRIP, null),
    { geo: trigger(-0.045, 0.118), color: BLUED },
    // Folded stock: the butt plate at the back, its struts along both sides.
    { geo: slab([[-0.05, 0.025], [-0.036, 0.025], [-0.036, -0.045], [-0.05, -0.045]], 0.05, 0.004), color: POLYMER, role: 'stock' },
    { geo: box(0.005, 0.008, 0.17, 0.0255, 0.012, 0.04), color: BLUED },
    { geo: box(0.005, 0.008, 0.17, -0.0255, -0.03, 0.04), color: BLUED },
    // Cocking knob on the left, ejection port on the right, slots in the top.
    { geo: box(0.012, 0.01, 0.014, 0.027, 0.016, 0.205), color: BLUED },
    { geo: panel('-x', [-0.0211, 0.008, 0.12], 0.045, 0.014), color: PORT },
    ...[0.04, 0.07, 0.1, 0.13, 0.16].map((z): Piece => ({ geo: panel('+y', [0, 0.0302, z], 0.012, 0.008), color: PORT })),
    // Aperture rear sight and a front post between its ears.
    { geo: box(0.016, 0.014, 0.012, 0, 0.037, 0.0), color: BLUED },
    { geo: box(0.022, 0.016, 0.01, 0, 0.034, 0.232), color: BLUED },
  ];
  return out;
}

function shotgun(): Piece[] {
  const out: Piece[] = [
    // Receiver, its top rounded off into the barrel, the loading port under it and the ejection port on the right.
    { geo: slab([[-0.03, 0.012], [-0.022, 0.02], [0.158, 0.02], [0.172, 0.012], [0.172, -0.03], [0.12, -0.036], [-0.03, -0.036]], 0.042, 0.004), color: BLUED },
    { geo: panel('-x', [-0.0211, 0.003, 0.075], 0.06, 0.016), color: PORT },
    { geo: panel('-y', [0, -0.0362, 0.06], 0.024, 0.08), color: PORT },
    // Barrel with a ventilated rib and a bead; the magazine tube under it and the clamp joining them.
    { geo: rod(0.0125, 0.0125, 0.17, 0.725, 0, 0, 10, true), color: BLUED },
    { geo: slab([[0.17, 0.011], [0.722, 0.011], [0.722, 0.0175], [0.17, 0.0175]], 0.008, 0.001), color: BLUED },
    { geo: box(0.004, 0.004, 0.004, 0, 0.0195, 0.716), color: DOT },
    ...bore(0.0135, 0.0095, 0.725, 0.75, 0, 0, 0.016, STEEL, 10),
    { geo: rod(0.011, 0.011, 0.17, 0.66, 0, -0.026, 10, true), color: BLUED },
    { geo: disc(0.011, 0, -0.026, 0.66, 10), color: STEEL },
    { geo: slab([[0.628, 0.006], [0.646, 0.006], [0.646, -0.04], [0.628, -0.04]], 0.03, 0.003), color: BLUED },
    // Pump (where the off hand holds): a wooden forend round the tube, ringed with grooves.
    { geo: slab([[0.24, -0.004], [0.4, -0.004], [0.404, -0.012], [0.404, -0.036], [0.396, -0.042], [0.248, -0.042], [0.24, -0.034]], 0.044, 0.008), color: WOOD, role: 'fore' },
    ...[0.27, 0.29, 0.31, 0.33, 0.35, 0.37].flatMap((z): Piece[] => [...sides(0.0442, -0.023, z, 0.006, 0.026, WOOD_DARK), { geo: panel('-y', [0, -0.0422, z], 0.022, 0.006), color: WOOD_DARK }]),
    // Pistol grip, trigger guard and trigger.
    ...gripPieces([[0.02, 0], [0.023, -0.03], [0.021, -0.06], [0.02, -0.082], [-0.02, -0.082], [-0.024, -0.06], [-0.025, -0.03], [-0.021, 0]], 0.03, 0.006, 0.32, [0, -0.07, 0.05], WOOD, { color: RUBBER, h: 0.006 }),
    { geo: guard(0.045, 0.0035, -0.036, 0.098), color: BLUED },
    { geo: trigger(-0.036, 0.098), color: STEEL },
    // Wooden stock, its comb sloping down from the receiver to the rubber butt pad.
    { geo: slab([[-0.03, 0.012], [-0.12, 0.007], [-0.233, 0.006], [-0.233, -0.081], [-0.16, -0.066], [-0.07, -0.046], [-0.03, -0.036]], 0.036, 0.005), color: WOOD, role: 'stock' },
    { geo: slab([[-0.245, 0.01], [-0.232, 0.01], [-0.232, -0.0832], [-0.245, -0.0832]], 0.038, 0.004), color: RUBBER, role: 'stock' },
  ];
  return out;
}

function rifle(): Piece[] {
  const out: Piece[] = [
    // Upper receiver, the top rail running on over the handguard with its slots.
    { geo: slab([[-0.035, -0.014], [-0.035, 0.017], [0.22, 0.017], [0.22, -0.014]], 0.032, 0.003), color: GUNMETAL },
    { geo: slab([[-0.03, 0.017], [0.48, 0.017], [0.48, 0.027], [-0.03, 0.027]], 0.022, 0.002), color: BLUED },
    ...[0.2, 0.25, 0.3, 0.35, 0.4].map((z): Piece => ({ geo: panel('+y', [0, 0.0272, z], 0.018, 0.012), color: PORT })),
    // Lower receiver: the magazine well flaring ahead of the trigger guard cut through it.
    {
      geo: slab(
        [[-0.03, -0.014], [0.215, -0.014], [0.215, -0.03], [0.205, -0.04], [0.2, -0.066], [0.142, -0.066], [0.138, -0.072], [0.13, -0.08], [0.1, -0.08], [0.093, -0.06], [-0.03, -0.042]],
        0.032, 0.003, 0,
        [[[0.134, -0.046], [0.128, -0.074], [0.104, -0.074], [0.1, -0.046]]],
      ),
      color: GUNMETAL,
    },
    // Curved magazine.
    { geo: slab([[0.146, -0.06], [0.198, -0.06], [0.212, -0.13], [0.24, -0.19], [0.194, -0.205], [0.168, -0.14]], 0.024, 0.003), color: BLUED },
    // Raked pistol grip and trigger.
    ...gripPieces([[0.02, 0], [0.022, -0.04], [0.019, -0.1], [-0.02, -0.1], [-0.023, -0.05], [-0.02, 0]], 0.028, 0.005, 0.35, [0, -0.1, 0.06], TAN, null),
    { geo: trigger(-0.046, 0.118), color: BLUED },
    // Octagonal handguard (where the off hand holds).
    { geo: rod(0.032, 0.032, 0.22, 0.48, 0, -0.016, 8, false, true), color: TAN, role: 'fore' },
    // Barrel, gas block with its front sight, flash hider with its slots.
    { geo: rod(0.009, 0.009, 0.48, 0.665, 0, 0, 8, true), color: BLUED },
    { geo: box(0.022, 0.024, 0.026, 0, -0.002, 0.53), color: BLUED },
    { geo: slab([[0.518, 0.008], [0.542, 0.008], [0.536, 0.052], [0.524, 0.052]], 0.01, 0.002), color: BLUED },
    ...bore(0.0115, 0.0065, 0.665, 0.705, 0, 0, 0.02, STEEL, 8),
    ...sides(0.0232, 0, 0.688, 0.022, 0.003, BORE),
    // A compact sight on the rail: its tube, the lens facing the shooter and the one facing out.
    { geo: box(0.02, 0.012, 0.05, 0, 0.033, 0.09), color: BLUED },
    { geo: rod(0.016, 0.016, 0.062, 0.12, 0, 0.054, 8, true), color: POLYMER },
    { geo: disc(0.015, 0, 0.054, 0.062, 8, true), color: LENS },
    { geo: disc(0.015, 0, 0.054, 0.118, 8), color: LENS },
    // Ejection port on the right, buffer tube.
    { geo: panel('-x', [-0.0161, 0.002, 0.09], 0.05, 0.014), color: PORT },
    { geo: rod(0.015, 0.015, -0.15, -0.03, 0, -0.004, 8, true), color: BLUED },
    // Stock with a rubber butt pad.
    { geo: slab([[-0.12, 0.018], [-0.236, 0.018], [-0.24, 0.012], [-0.24, -0.074], [-0.2, -0.07], [-0.14, -0.03], [-0.12, -0.024]], 0.034, 0.004), color: TAN, role: 'stock' },
    { geo: slab([[-0.25, 0.016], [-0.239, 0.016], [-0.239, -0.0784], [-0.25, -0.0784]], 0.036, 0.003), color: RUBBER, role: 'stock' },
  ];
  return out;
}

function sniper(): Piece[] {
  const out: Piece[] = [
    // Round receiver and the bolt, its handle and knob on the right.
    { geo: rod(0.017, 0.017, -0.02, 0.26, 0, 0, 10, true), color: BLUED },
    { geo: disc(0.017, 0, 0, -0.02, 10, true), color: STEEL },
    { geo: box(0.04, 0.007, 0.007, -0.03, -0.002, 0.02), color: STEEL },
    { geo: box(0.016, 0.016, 0.016, -0.05, -0.006, 0.02), color: STEEL },
    // Long tapered barrel and a muzzle brake with ports on both sides.
    { geo: rod(0.012, 0.0095, 0.26, 0.975, 0, 0, 8, true), color: BLUED },
    { geo: slab([[0.965, -0.012], [1.0, -0.012], [1.006, -0.006], [1.006, 0.008], [1.0, 0.012], [0.965, 0.012]], 0.03, 0.003), color: STEEL },
    ...sides(0.0302, 0, 0.977, 0.007, 0.014, BORE),
    ...sides(0.0302, 0, 0.99, 0.007, 0.014, BORE),
    ...bore(0.0115, 0.0065, 0.995, 1.02, 0, 0, 0.03, STEEL, 8),
    // The stock: a forend under the barrel (where the off hand holds), a pistol grip, and the butt with a raised cheek
    // rest and its pad.
    { geo: slab([[-0.02, -0.014], [0.5, -0.014], [0.52, -0.02], [0.52, -0.032], [0.49, -0.045], [-0.02, -0.045]], 0.048, 0.007), color: OLIVE, role: 'fore' },
    ...gripPieces([[0.02, 0], [0.024, -0.04], [0.021, -0.11], [-0.02, -0.11], [-0.024, -0.05], [-0.02, 0]], 0.032, 0.006, 0.25, [0, -0.1, 0.06], OLIVE_DARK, null),
    { geo: slab([[-0.02, 0.001], [-0.06, 0.026], [-0.2, 0.027], [-0.256, 0.026], [-0.256, -0.084], [-0.13, -0.06], [-0.02, -0.048]], 0.042, 0.006), color: OLIVE, role: 'stock' },
    { geo: slab([[-0.27, 0.027], [-0.255, 0.027], [-0.255, -0.0852], [-0.27, -0.0852]], 0.044, 0.004), color: RUBBER, role: 'stock' },
    // Box magazine, trigger guard and trigger.
    { geo: box(0.03, 0.05, 0.07, 0, -0.06, 0.15), color: BLUED },
    { geo: guard(0.042, 0.0035, -0.045, 0.1), color: BLUED },
    { geo: trigger(-0.045, 0.1), color: STEEL },
    // Scope: tube, objective and eyepiece bells with their lenses, two turrets and the rings.
    { geo: rod(0.015, 0.015, 0.0, 0.27, 0, 0.068, 10, true), color: POLYMER },
    { geo: rod(0.015, 0.026, 0.27, 0.34, 0, 0.068, 10, true), color: POLYMER },
    { geo: disc(0.026, 0, 0.068, 0.34, 10), color: LENS },
    { geo: rod(0.021, 0.015, -0.06, 0.0, 0, 0.068, 10, true), color: POLYMER },
    { geo: disc(0.021, 0, 0.068, -0.06, 10, true), color: LENS },
    { geo: new THREE.CylinderGeometry(0.011, 0.011, 0.024, 6).translate(0, 0.093, 0.13), color: BLUED },
    { geo: new THREE.CylinderGeometry(0.011, 0.011, 0.024, 6).rotateZ(Math.PI / 2).translate(0.026, 0.068, 0.13), color: BLUED },
    { geo: box(0.036, 0.05, 0.016, 0, 0.04, 0.05), color: BLUED },
    { geo: box(0.036, 0.05, 0.016, 0, 0.04, 0.21), color: BLUED },
  ];
  return out;
}

function rocket(): Piece[] {
  const y = 0.08;
  const out: Piece[] = [
    // The tube (its centre is the stock point, which rests on the shoulder), with darker bands.
    { geo: rod(0.075, 0.075, -0.33, 0.735, 0, y, 12, true), color: OLIVE, role: 'stock' },
    ...[-0.2, 0.58].map((z): Piece => ({ geo: rod(0.078, 0.078, z, z + 0.03, 0, y, 12, true), color: OLIVE_DARK })),
    // Flared muzzle with the open bore, and the rear blast cone, open too.
    ...bore(0.085, 0.068, 0.735, 0.775, 0, y, 0.3, OLIVE_DARK, 12),
    { geo: rod(0.075, 0.075, -0.375, -0.33, 0, y, 12, true), color: OLIVE_DARK, role: 'stock' },
    { geo: rod(0.092, 0.076, -0.375, -0.345, 0, y, 12, true), color: OLIVE_DARK },
    { geo: new THREE.RingGeometry(0.066, 0.092, 12, 1).rotateY(Math.PI).translate(0, y, -0.375), color: OLIVE_DARK },
    { geo: inward(rod(0.066, 0.066, -0.375, -0.15, 0, y, 12, true)), color: BORE },
    { geo: disc(0.066, 0, y, -0.15, 12, true), color: BORE },
    // Sight on the left of the tube's top: its mount, the body with a lens at each end.
    { geo: slab([[0.26, y + 0.06], [0.34, y + 0.06], [0.33, y + 0.09], [0.27, y + 0.09]], 0.032, 0.003), color: TAN },
    { geo: slab([[0.25, y + 0.09], [0.35, y + 0.09], [0.35, y + 0.132], [0.25, y + 0.132]], 0.03, 0.004), color: OLIVE_DARK },
    { geo: disc(0.011, 0, y + 0.111, 0.3501, 8), color: LENS },
    { geo: disc(0.011, 0, y + 0.111, 0.2499, 8, true), color: LENS },
    // Trigger mount under the tube, raked grip and guard; a vertical foregrip for the off hand.
    { geo: slab([[0.05, 0.012], [0.17, 0.012], [0.165, -0.032], [0.06, -0.032]], 0.034, 0.004), color: TAN },
    ...gripPieces([[0.02, 0], [0.023, -0.04], [0.02, -0.1], [-0.022, -0.1], [-0.025, -0.05], [-0.021, 0]], 0.03, 0.006, 0.25, [0, -0.075, 0.1], GRIP, null),
    { geo: guard(0.04, 0.0035, -0.033, 0.145), color: GRIP },
    { geo: trigger(-0.033, 0.143), color: STEEL },
    { geo: slab([[0.3, 0.016], [0.342, 0.016], [0.338, -0.0575], [0.304, -0.0575]], 0.03, 0.005), color: GRIP, role: 'fore' },
    // Shoulder pad along the tube's underside behind the grip.
    { geo: slab([[-0.12, 0.012], [0.04, 0.012], [0.03, -0.006], [-0.11, -0.006]], 0.04, 0.004), color: RUBBER },
  ];
  return out;
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
 * Gun models per tier: the same modelled geometry everywhere (it is small: under 600 triangles, one draw per gun kind
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
