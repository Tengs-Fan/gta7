// The models of Las Lomas County's roadside oddities (world/country/oddities.ts), each one non-indexed geometry with a vertex
// colour per part (furniture.ts ModelBuilder), its origin at its foot (on the ground, in the middle of its footprint) and
// its front towards +z. render/country/oddities.ts stands them where the world puts them and paints the boards on them.

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { bar, box, cyl, ModelBuilder } from '../furniture';
import { cowGeometry } from './farmModels';

/** The scale the giant fibreglass cow is the farms' cow at, and the height of the flatbed's deck it stands on. */
export const GIANT_COW = 3.2;
export const DECK_Y = 1.15;

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** An ellipsoid of radius `r` scaled by (sx, sy, sz), centred at (x, y, z). */
function ball(r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, seg = 12): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1)).scale(sx, sy, sz).translate(x, y, z);
}

/** A box w x h x d turned by (rx, ry, rz) about its own centre, which then stands at (x, y, z). */
function slab(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).rotateX(rx).rotateY(ry).rotateZ(rz).translate(x, y, z);
}

/** A wheel of radius r and width w whose axle runs along x, centred at (x, y, z). */
function wheel(r: number, w: number, x: number, y: number, z: number, seg = 14): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, w, seg).rotateZ(Math.PI / 2).translate(x, y, z);
}

// ---------------------------------------------------------------------------------------------------------------------
// The giant fibreglass cow

/** The flatbed trailer the cow stands on: a deck 2.7 x 8.4 m at DECK_Y, tandem wheels, the A-frame tongue to +z and the straps over her. */
export function flatbedGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const steel = 0x3a4047;
  b.add('deck', box(2.7, 0.14, 8.4, 0, DECK_Y - 0.07, 0), 0x806644);
  b.add('frame', box(2.4, 0.22, 8.2, 0, DECK_Y - 0.25, 0), steel);
  for (const s of [-1, 1]) {
    b.add('rail', box(0.07, 0.2, 8.4, s * 1.33, DECK_Y + 0.1, 0), steel);
    for (const z of [-1.5, -2.5]) {
      b.add('tyre', wheel(0.44, 0.3, s * 1.2, 0.44, z), 0x1b1b1d);
      b.add('rim', wheel(0.22, 0.32, s * 1.2, 0.44, z, 8), 0xb9bcbf);
      b.add('fender', slab(0.4, 0.05, 1.7, s * 1.2, 0.98, -2), steel, 1.1);
    }
    // The tongue's two bars from the deck's front corners to the coupler, and the red lamps at the back.
    b.add('tongue', bar(v3(s * 0.95, 0.85, 4.1), v3(0, 0.78, 6.4), 0.05, 5), steel);
    b.add('lamp', box(0.16, 0.1, 0.04, s * 1.1, DECK_Y - 0.2, -4.2), 0xc0201e);
    // Ratchet straps over the cow's belly.
    for (const z of [-1.7, 0.2, 2.0]) b.add('strap', box(0.05, 2.05, 0.1, s * 1.27, DECK_Y + 1.0, z), 0xef8a1a);
  }
  b.add('coupler', box(0.2, 0.16, 0.26, 0, 0.78, 6.5), steel);
  b.add('jack', cyl(0.04, 0.04, 0.8, 6, 0, 0, 5.4), 0x6b6f72);
  b.add('jackFoot', box(0.28, 0.04, 0.28, 0, 0.02, 5.4), 0x6b6f72);
  return b.build('flatbed');
}

/** The giant cow: the farms' cow (farmModels.ts cowGeometry, her hide's texture on her) GIANT_COW times as big, on the deck. */
export function giantCowGeometry(): THREE.BufferGeometry {
  return cowGeometry().scale(GIANT_COW, GIANT_COW, GIANT_COW).translate(0, DECK_Y, 0);
}

/** Her collar and bell, for the vertex-coloured oddities: a red ribbon round the neck, a brass bell hung under it. */
export function cowTrimGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const neck = v3(0, DECK_Y + 1.14 * GIANT_COW, 0.84 * GIANT_COW);
  b.add('collar', new THREE.TorusGeometry(0.68, 0.09, 6, 16).translate(neck.x, neck.y, neck.z), 0xc4262e);
  b.add('bell', ball(0.17, neck.x, neck.y - 0.78, neck.z + 0.12), 0xe3b43a);
  b.add('bellTop', box(0.06, 0.2, 0.06, neck.x, neck.y - 0.62, neck.z + 0.12), 0x6b4a2b);
  return b.build('cow-trim');
}

/** The farm stand beside her, 4 x 2.6 m, its counter and awning to +z, a board on its roof for its name. */
export function standGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const wood = 0x8a6a45;
  const dark = 0x6a4c2e;
  for (const x of [-1.9, 1.9]) for (const z of [-1.15, 1.15]) b.add('post', box(0.12, 2.5, 0.12, x, 1.25, z), dark);
  b.add('back', box(3.9, 2.0, 0.07, 0, 1.15, -1.2), wood);
  for (const s of [-1, 1]) b.add('side', box(0.07, 1.1, 2.3, s * 1.92, 0.65, 0), wood);
  b.add('floor', box(3.9, 0.08, 2.4, 0, 0.06, 0), dark);
  b.add('roof', slab(4.5, 0.08, 3.0, 0, 2.62, 0.1, 0.12), 0x5e5a56);
  // The counter, a plank face and a top, the awning's stripes hung over it.
  b.add('counter', box(3.8, 0.1, 0.8, 0, 0.98, 0.7), wood);
  b.add('counterFace', box(3.8, 0.9, 0.08, 0, 0.5, 1.06), dark);
  for (let k = 0; k < 8; k++) b.add('awning', box(0.57, 0.34, 0.04, -1.99 + k * 0.57, 2.28, 1.42), k % 2 ? 0xf1ede2 : 0xc4262e);
  // Crates of what she gives: apples, pumpkins, corn, and pies in rows.
  const fruit: Array<[number, number, number]> = [[-1.5, 0xb0291f, 0.5], [-0.75, 0xd9792a, 0.5], [0, 0xe2c548, 0.5], [0.75, 0x5b8b3c, 0.5]];
  for (const [x, c] of fruit) {
    b.add('crate', box(0.6, 0.24, 0.5, x, 1.15, 0.7), dark);
    b.add('goods', box(0.5, 0.06, 0.4, x, 1.29, 0.7), c);
  }
  for (let k = 0; k < 3; k++) b.add('pie', cyl(0.22, 0.19, 0.07, 10, 1.42 + (k % 2) * 0.1, 1.03, 0.55 + k * 0.01 + (k > 1 ? 0.2 : 0)), 0xd9b26a);
  // The honesty box, with its coin slot, at the counter's end; the board's frame on the roof.
  b.add('honesty', box(0.34, 0.26, 0.24, -1.62, 1.16, 0.95), 0x2f5d3a);
  b.add('slot', box(0.14, 0.02, 0.01, -1.62, 1.24, 1.075), 0x101010);
  for (const x of [-1.8, 1.8]) b.add('boardPost', box(0.08, 0.7, 0.08, x, 3.0, 0.2), dark);
  return b.build('farm-stand');
}

// ---------------------------------------------------------------------------------------------------------------------
// LITTLE GREEN DINER

/** The sign's board is this wide and tall (m), its face at +z, standing from `y` (render/country/oddities.ts paints it). */
export const DINER_BOARD = { w: 7.2, h: 2.3, y: 2.8 } as const;
/** Where the crashed saucer lies, beside the board. */
export const DINER_SAUCER = { u: 5.4, d: -1.1 } as const;

/** The sign: two steel posts, the board's frame and trim, and a little green alien on its corner with a pie. */
export function dinerSignGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const { w, h, y } = DINER_BOARD;
  const steel = 0x4b5057;
  for (const s of [-1, 1]) {
    b.add('post', cyl(0.14, 0.17, y + h + 0.3, 8, s * (w / 2 - 0.5), 0, 0), steel);
    b.add('plate', box(0.6, 0.06, 0.6, s * (w / 2 - 0.5), 0.03, 0), 0x8a8c8e);
  }
  b.add('back', box(w, h, 0.06, 0, y + h / 2, -0.12), 0x1a3a28);
  b.add('frame', box(w + 0.2, 0.14, 0.26, 0, y - 0.07, 0), 0xf2d24a);
  b.add('frame', box(w + 0.2, 0.14, 0.26, 0, y + h + 0.07, 0), 0xf2d24a);
  for (const s of [-1, 1]) b.add('frame', box(0.14, h + 0.28, 0.26, s * (w / 2 + 0.03), y + h / 2, 0), 0xf2d24a);
  // The alien on the board's top corner, holding a pie.
  const top = y + h + 0.14;
  const ax = -w / 2 + 0.8;
  const green = 0x5cc66c;
  b.add('legs', cyl(0.07, 0.09, 0.4, 6, ax - 0.1, top, 0), green);
  b.add('legs', cyl(0.07, 0.09, 0.4, 6, ax + 0.1, top, 0), green);
  b.add('body', cyl(0.14, 0.2, 0.5, 8, ax, top + 0.38, 0), green);
  b.add('head', ball(0.3, ax, top + 1.1, 0, 1, 1.25, 1), green);
  for (const s of [-1, 1]) {
    b.add('eye', ball(0.1, ax + s * 0.15, top + 1.12, 0.22, 0.8, 1.5, 0.5, 8), 0x0c0c0c);
    b.add('antenna', bar(v3(ax + s * 0.12, top + 1.5, 0), v3(ax + s * 0.28, top + 1.9, 0), 0.015, 4), green);
    b.add('antennaTip', ball(0.05, ax + s * 0.28, top + 1.92, 0, 1, 1, 1, 6), 0xf2d24a);
  }
  b.add('arm', bar(v3(ax + 0.15, top + 0.72, 0), v3(ax + 0.6, top + 0.95, 0.2), 0.04, 5), green);
  b.add('arm', bar(v3(ax - 0.15, top + 0.72, 0), v3(ax - 0.4, top + 0.45, 0.1), 0.04, 5), green);
  b.add('pie', cyl(0.24, 0.21, 0.09, 10, ax + 0.6, top + 0.95, 0.2), 0xd9b26a);
  b.add('crust', cyl(0.25, 0.25, 0.05, 10, ax + 0.6, top + 1.02, 0.2), 0xe9cf92);
  return b.build('diner-sign');
}

/**
 * The crashed saucer: a lens of grey metal with a green glass dome and a ring of lamps, tipped over on its side and buried
 * to its rim in a mound of earth, `d` m behind the board's plane at its end. Its beacon is drawn apart (it blinks).
 */
export function saucerGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const hull = new THREE.LatheGeometry(
    [[0.02, 0], [0.7, 0.03], [1.5, 0.22], [2.1, 0.5], [2.2, 0.62], [2.1, 0.74], [1.5, 0.96], [0.9, 1.06], [0.02, 1.1]].map(([x, y]) => new THREE.Vector2(x, y)),
    24,
  );
  const parts: Array<[string, THREE.BufferGeometry, number]> = [
    ['hull', hull, 0xb7bec6],
    ['band', new THREE.CylinderGeometry(2.14, 2.14, 0.1, 24, 1, true).translate(0, 0.62, 0), 0x5e666e],
    ['dome', new THREE.SphereGeometry(0.85, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1).translate(0, 1.02, 0), 0x7fe0a4],
    ['hatch', cyl(0.3, 0.3, 0.08, 10, 0, 1.74, 0), 0x8c9299],
  ];
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    parts.push(['lamp', ball(0.09, Math.cos(a) * 2.12, 0.62, Math.sin(a) * 2.12, 1, 1, 1, 6), k % 2 ? 0xffd34a : 0xff7a3a]);
  }
  // A scorch of black round the crash.
  parts.push(['scorch', box(0.9, 0.02, 0.7, 1.2, 0.5, 0.3), 0x2b2724]);
  // Tipped about two axes, then sunk so that its lowest rim is under the ground.
  const tip = new THREE.Matrix4().makeRotationZ(0.42).premultiply(new THREE.Matrix4().makeRotationX(-0.3));
  const bounds = new THREE.Box3();
  for (const [, g] of parts) {
    g.applyMatrix4(tip);
    g.computeBoundingBox();
    bounds.union(g.boundingBox!);
  }
  for (const [name, g, c] of parts) b.add(name, g.translate(0, -bounds.min.y - 0.55, 0), c);
  // Where the dome's top has come to: the beacon is drawn there.
  const top = new THREE.Vector3(0, 1.82, 0).applyMatrix4(tip);
  const beacon: [number, number, number] = [top.x, top.y - bounds.min.y - 0.55, top.z];
  // The mound it ploughed up, and clods of it thrown about.
  b.add('mound', ball(2.2, 0, 0, 0.5, 1.15, 0.28, 1.0, 12), 0x5a4533);
  for (const [x, z, r] of [[-2.6, 1.2, 0.35], [2.7, -0.4, 0.3], [1.6, 2.2, 0.42], [-1.9, -2.1, 0.28]] as const) b.add('clod', ball(r, x, 0.1, z, 1, 0.5, 1, 6), 0x4e3c2c);
  const out = b.build('saucer');
  out.userData.beacon = beacon;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bigfoot

/** Bigfoot's statue, 4.3 m to his crown, one hand up in a wave, on a concrete plinth. */
export function bigfootGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const fur = 0x4a2f1c;
  const dark = 0x2f1d11;
  const light = 0x66442b;
  const skin = 0x8d6a52;
  b.add('plinth', box(2.0, 0.4, 2.0, 0, 0.2, 0), 0x9a9890);
  for (const s of [-1, 1]) {
    b.add('foot', ball(0.32, s * 0.4, 0.62, 0.2, 1, 0.5, 1.7), dark);
    b.add('leg', cyl(0.27, 0.36, 1.5, 9, s * 0.4, 0.45, 0), fur);
    b.add('shoulder', ball(0.42, s * 0.92, 3.2, 0, 1, 1, 1), fur);
  }
  b.add('hips', ball(0.62, 0, 2.0, 0, 1.1, 0.8, 0.9), fur);
  b.add('torso', ball(0.88, 0, 2.75, 0, 1.05, 1.3, 0.8), fur);
  b.add('chest', ball(0.5, 0, 2.85, 0.4, 1, 1.1, 0.5), light);
  // His left arm hangs, his right is up, waving.
  b.add('arm', bar(v3(-0.95, 3.2, 0), v3(-1.12, 1.95, 0.2), 0.21, 7), fur);
  b.add('hand', ball(0.25, -1.14, 1.8, 0.2, 1, 1.3, 0.8), dark);
  b.add('arm', bar(v3(0.95, 3.2, 0), v3(1.3, 3.85, 0.3), 0.21, 7), fur);
  b.add('forearm', bar(v3(1.3, 3.85, 0.3), v3(1.5, 4.7, 0.4), 0.17, 7), fur);
  b.add('hand', ball(0.26, 1.52, 4.85, 0.4, 0.9, 1.3, 0.6), dark);
  // The head: a brow like a shelf, a long face, two white eyes, a dark mouth.
  b.add('head', ball(0.55, 0, 3.95, 0.1, 1, 1.1, 1), fur);
  b.add('brow', box(0.9, 0.16, 0.34, 0, 4.05, 0.5), dark);
  b.add('face', ball(0.34, 0, 3.8, 0.52, 1, 1.1, 0.5), skin);
  b.add('muzzle', ball(0.24, 0, 3.66, 0.68, 1.1, 0.8, 0.6), 0x6e4e38);
  for (const s of [-1, 1]) {
    b.add('eye', ball(0.095, s * 0.2, 3.95, 0.6, 1, 1, 0.6, 8), 0xf3f0e6);
    b.add('pupil', ball(0.05, s * 0.2, 3.95, 0.66, 1, 1, 0.6, 6), 0x0c0c0c);
  }
  b.add('mouth', box(0.34, 0.05, 0.05, 0, 3.55, 0.82), 0x1a0d08);
  // Shaggy fur: spikes of it over his body, in the order a seeded hand puts them.
  const rng = new Rng(8700);
  for (let k = 0; k < 70; k++) {
    const a = rng.range(0, Math.PI * 2);
    const y = rng.range(1.4, 3.9);
    const r = y > 3.5 ? 0.5 : y > 2.2 ? 0.85 : 0.35;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r * 0.75;
    const tuft = new THREE.ConeGeometry(0.11, 0.42, 4).translate(0, 0.21, 0);
    tuft.rotateZ(-Math.cos(a) * 0.9).rotateX(Math.sin(a) * 0.6).translate(x, y, z);
    b.add('fur', tuft, k % 3 ? fur : light);
  }
  return b.build('bigfoot');
}

/** The stone the plaque sits on: a lectern 2 m wide, its face tipped back 0.5 rad to be read (render/country/oddities.ts paints it). */
export const PLAQUE = { w: 2.0, len: 0.95, tilt: 0.5, y: 0.74 } as const;

export function plaqueGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('stone', box(PLAQUE.w, 0.5, PLAQUE.len, 0, 0.25, 0), 0x8f8d86);
  b.add('back', box(PLAQUE.w, 0.95, 0.2, 0, 0.475, -0.375), 0x85837c);
  b.add('slope', slab(PLAQUE.w, 0.07, PLAQUE.len, 0, PLAQUE.y, 0, PLAQUE.tilt), 0x6f6d66);
  return b.build('plaque-stone');
}

// ---------------------------------------------------------------------------------------------------------------------
// The abandoned pickup

/** The pickup: faded teal and rust, its tyres flat, its hood up, its windows gone, with weeds through it, nose to +z. */
export function pickupGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const paint = 0x5f867b;
  const rust = 0x7d4a2d;
  const glass = 0x16222a;
  b.add('lower', box(1.9, 0.5, 5.2, 0, 0.78, -0.4), paint);
  b.add('rustSill', box(1.92, 0.16, 5.2, 0, 0.58, -0.4), rust);
  b.add('cab', box(1.8, 0.78, 1.85, 0, 1.42, -0.55), paint, 0.96);
  b.add('roof', box(1.74, 0.08, 1.78, 0, 1.85, -0.55), rust, 0.9);
  b.add('screen', slab(1.6, 0.62, 0.05, 0, 1.45, 0.38, -0.3), glass);
  b.add('rearGlass', box(1.5, 0.5, 0.05, 0, 1.46, -1.5), glass);
  for (const s of [-1, 1]) b.add('sideGlass', box(0.05, 0.5, 1.2, s * 0.91, 1.5, -0.55), glass);
  // The bed: a floor, two sides, a tailgate hanging open, a drift of leaves in it.
  b.add('bedFloor', box(1.75, 0.08, 2.1, 0, 0.98, -2.0), rust, 0.8);
  for (const s of [-1, 1]) b.add('bedSide', box(0.08, 0.55, 2.2, s * 0.9, 1.25, -2.0), paint);
  b.add('bedFront', box(1.75, 0.55, 0.08, 0, 1.25, -0.92), paint);
  b.add('tailgate', slab(1.75, 0.5, 0.06, 0, 0.7, -3.3, -1.45), rust);
  // The hood: its hinge at the cowl, tipped up, the engine's dark bay under it.
  b.add('bay', box(1.5, 0.2, 1.4, 0, 1.0, 1.55), 0x2a2420);
  b.add('engine', box(0.9, 0.45, 0.9, 0, 1.15, 1.5), rust, 0.6);
  b.add('hood', new THREE.BoxGeometry(1.8, 0.1, 1.5).translate(0, 0, 0.75).rotateX(-1.05).translate(0, 1.12, 0.82), paint, 0.95);
  b.add('grille', box(1.5, 0.45, 0.06, 0, 0.9, 2.25), 0x1b1b1c);
  b.add('bumper', box(2.0, 0.16, 0.2, 0, 0.5, 2.38), 0x93979a, 0.75);
  b.add('bumper', box(2.0, 0.16, 0.2, 0, 0.5, -3.05), 0x93979a, 0.75);
  for (const s of [-1, 1]) b.add('headlamp', box(0.3, 0.2, 0.06, s * 0.68, 1.02, 2.27), 0x2f3236);
  // Flat tyres on rusty rims, the near side sunk deeper.
  for (const s of [-1, 1]) {
    for (const z of [1.25, -2.35]) {
      const sink = s > 0 ? 0.13 : 0;
      b.add('tyre', new THREE.CylinderGeometry(0.4, 0.4, 0.27, 14).rotateZ(Math.PI / 2).scale(1, 0.62, 1).translate(s * 0.93, 0.27 - sink, z), 0x1a1a1b);
      b.add('rim', wheel(0.18, 0.3, s * 0.93, 0.3 - sink, z, 8), rust);
    }
  }
  // Weeds up through the wheel arches, the bed, the engine bay and the cab: blades leaning every way, a sunflower in the bed.
  const rng = new Rng(9100);
  const blade = (x: number, y: number, z: number, h: number, green: number) => {
    const g = new THREE.ConeGeometry(0.045, h, 4).translate(0, h / 2, 0).rotateZ(rng.range(-0.55, 0.55)).rotateX(rng.range(-0.55, 0.55)).translate(x, y, z);
    b.add('weed', g, green);
  };
  const greens = [0x5f8a34, 0x7a9d3c, 0x9aa84a, 0x486e2a, 0xb3a655];
  const tufts: Array<[number, number, number, number, number]> = [
    [0.93, 0.4, 1.25, 8, 0.7], [-0.93, 0.45, 1.25, 7, 0.7], [0.93, 0.35, -2.35, 9, 0.8], [-0.93, 0.4, -2.35, 6, 0.8],
    [0, 1.06, -2.0, 14, 1.0], [0.3, 1.0, 1.6, 8, 0.9], [-0.4, 1.0, 1.4, 5, 0.9], [0, 1.9, -0.5, 4, 0.5], [0.45, 1.1, -2.9, 6, 0.9],
  ];
  for (const [x, y, z, n, h] of tufts) for (let k = 0; k < n; k++) blade(x + rng.range(-0.25, 0.25), y, z + rng.range(-0.3, 0.3), h * rng.range(0.6, 1.3), rng.pick(greens));
  b.add('stem', cyl(0.03, 0.04, 1.5, 5, 0.1, 1.0, -2.2), 0x4d7a2c);
  b.add('flower', ball(0.19, 0.1, 2.55, -2.2, 1, 1, 0.35, 10), 0xf1bd2a);
  b.add('seeds', ball(0.1, 0.1, 2.55, -2.17, 1, 1, 0.4, 8), 0x4a2f16);
  return b.build('abandoned-pickup').rotateZ(0.05);
}

// ---------------------------------------------------------------------------------------------------------------------
// The school bus henhouse

/** A hen standing at the origin, facing +z. */
function hen(b: ModelBuilder, x: number, z: number, yaw: number, color: number): void {
  const at = (g: THREE.BufferGeometry) => g.rotateY(yaw).translate(x, 0, z);
  b.add('hen', at(ball(0.2, 0, 0.3, 0, 0.9, 0.85, 1.2, 8)), color);
  b.add('hen', at(slab(0.1, 0.25, 0.2, 0, 0.45, -0.28, 0.5)), color, 0.85);
  b.add('hen', at(ball(0.09, 0, 0.55, 0.2, 1, 1, 1, 6)), color);
  b.add('beak', at(new THREE.ConeGeometry(0.03, 0.08, 4).rotateX(Math.PI / 2).translate(0, 0.54, 0.31)), 0xe0a020);
  b.add('comb', at(box(0.025, 0.07, 0.1, 0, 0.64, 0.2)), 0xc4262e);
  for (const s of [-1, 1]) b.add('leg', at(box(0.015, 0.2, 0.015, s * 0.06, 0.1, 0.02)), 0xd9a03a);
}

/** The bus: a 1950s school bus on its flat tyres, the road side (-x) open to nest boxes, a ramp up to its door, hens about it, its nose to +z. */
export function busGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const yellow = 0xd7a21f;
  const worn = 0xb98a1c;
  const black = 0x1f1f20;
  const glass = 0x1b2a33;
  b.add('body', box(2.4, 1.6, 8.8, 0, 1.5, -0.6), yellow);
  b.add('skirt', box(2.46, 0.5, 8.9, 0, 0.78, -0.6), worn);
  b.add('roof', box(2.2, 0.16, 8.6, 0, 2.38, -0.6), 0xc8c4b6);
  b.add('roofCrown', box(1.6, 0.1, 8.4, 0, 2.5, -0.6), 0xc8c4b6, 0.95);
  b.add('nose', box(2.2, 1.0, 1.9, 0, 1.15, 4.5), yellow);
  b.add('hood', box(2.0, 0.1, 1.6, 0, 1.7, 4.6), worn);
  b.add('windshield', box(2.2, 0.8, 0.07, 0, 1.95, 3.78), glass);
  b.add('bumper', box(2.6, 0.26, 0.28, 0, 0.55, 5.5), black);
  b.add('grille', box(1.5, 0.6, 0.05, 0, 1.0, 5.47), 0x2a2a2c);
  for (const y of [1.15, 1.62]) b.add('stripe', box(2.42, 0.07, 8.8, 0, y, -0.6), black);
  // Windows, a pane each 0.95 m on a 1.2 m pitch, some under chicken wire, the road side's lower ones cut to hatches.
  for (let k = 0; k < 7; k++) {
    const z = -3.9 + k * 1.2;
    for (const s of [-1, 1]) b.add('window', box(0.05, 0.62, 0.95, s * 1.21, 1.95, z), glass);
    // Hatches open to the road side, a nest box under each, and hay in it.
    if (k % 2 === 0) {
      b.add('hatch', box(0.05, 0.42, 0.7, -1.23, 0.88, z), 0x8a6a45);
      b.add('nest', box(0.4, 0.22, 0.7, -1.4, 0.62, z), 0x7a5a3a);
      b.add('hay', box(0.34, 0.07, 0.6, -1.4, 0.74, z), 0xd6bd68);
    }
  }
  b.add('wire', box(0.02, 0.68, 4.0, -1.22, 1.95, -1.7), 0xaeb3b6, 0.8);
  // The folding door by the driver's seat, and its ramp: planks up from the ground, cleated.
  b.add('door', box(0.06, 1.7, 0.9, -1.22, 1.15, 3.1), 0x2c2f33);
  b.add('plank', slab(2.8, 0.07, 0.9, -2.55, 0.43, 3.1, 0, 0, 0.27), 0x9a7a52);
  for (let k = 0; k < 5; k++) b.add('cleat', slab(0.05, 0.05, 0.9, -1.55 - k * 0.5, 0.52 - k * 0.12, 3.1), 0x6a4c2e);
  // The stop arm, folded out, and a rooster on the roof.
  b.add('stopArm', new THREE.CylinderGeometry(0.22, 0.22, 0.03, 8).rotateZ(Math.PI / 2).translate(-1.35, 1.55, 2.2), 0xc4262e);
  b.add('rooster', ball(0.2, 0, 2.78, 3.2, 0.8, 1, 1.3), 0xb5622a);
  b.add('roosterHead', ball(0.1, 0, 3.05, 3.38, 1, 1, 1, 6), 0xb5622a);
  b.add('roosterComb', box(0.03, 0.12, 0.12, 0, 3.17, 3.36), 0xc4262e);
  b.add('roosterTail', slab(0.06, 0.4, 0.14, 0, 3.0, 3.0, 0.4), 0x2e2a28);
  // Tyres flat and sunk, on blocks of concrete.
  for (const s of [-1, 1]) {
    for (const z of [3.2, -3.5, -2.8]) {
      b.add('tyre', new THREE.CylinderGeometry(0.52, 0.52, 0.3, 14).rotateZ(Math.PI / 2).scale(1, 0.72, 1).translate(s * 1.1, 0.34, z), 0x1a1a1b);
      b.add('rim', wheel(0.25, 0.32, s * 1.1, 0.4, z, 8), 0x7a4a2c);
    }
  }
  for (const [x, z] of [[-0.9, 0.2], [0.9, 0.2], [-0.9, -1.6], [0.9, -1.6]] as const) b.add('block', box(0.4, 0.5, 0.4, x, 0.25, z), 0x9a9a95);
  // The hens: in front of the ramp and under the nests, in brown, white, black and red-gold.
  const coats = [0x8a4f2a, 0xece6d6, 0x2e2a28, 0xb5622a, 0x8a4f2a, 0xece6d6, 0xb5622a];
  [[-3.2, 2.5, 0.8], [-3.6, 3.9, 2.4], [-2.4, 1.2, -0.6], [-3.0, -0.4, 1.9], [-2.2, 4.5, 3.5], [-3.8, 1.8, 0.2], [-2.8, -2.2, 2.9]].forEach(([x, z, yaw], k) => hen(b, x!, z!, yaw!, coats[k]!));
  return b.build('school-bus-henhouse');
}

// ---------------------------------------------------------------------------------------------------------------------
// The payphone, the hives

/** The kiosk: a concrete base, four aluminium posts, three panes, a tin roof and the phone on its back wall, open to +z. */
export function payphoneGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const alu = 0xaab1b6;
  b.add('base', box(1.2, 0.16, 1.2, 0, 0.08, 0), 0x8f8d86);
  for (const x of [-0.55, 0.55]) for (const z of [-0.55, 0.55]) b.add('post', box(0.08, 2.3, 0.08, x, 1.31, z), alu);
  b.add('roof', slab(1.3, 0.1, 1.3, 0, 2.5, 0, -0.05), 0x7e8489);
  b.add('lip', box(1.34, 0.12, 0.06, 0, 2.42, 0.64), alu);
  // Panes: back and both sides, in a pale blue-grey, a rail across them.
  b.add('pane', box(1.0, 1.5, 0.03, 0, 1.2, -0.55), 0x9ec0cc);
  for (const s of [-1, 1]) b.add('pane', box(0.03, 1.5, 1.0, s * 0.55, 1.2, 0), 0x9ec0cc, 0.95);
  b.add('rail', box(1.1, 0.06, 0.06, 0, 0.5, 0.55), alu);
  // The phone: a dark green case on the back wall, a coin slot and a keypad, a handset on a silver cord, the directory.
  b.add('case', box(0.38, 0.62, 0.14, 0, 1.4, -0.46), 0x2b5a3b);
  b.add('plate', box(0.3, 0.2, 0.01, 0, 1.58, -0.385), 0xb8bcbf);
  b.add('slot', box(0.1, 0.02, 0.012, 0.0, 1.65, -0.38), 0x101010);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) b.add('key', box(0.05, 0.04, 0.012, (c - 1) * 0.08, 1.45 - r * 0.07, -0.385), 0xd9d6cc);
  b.add('handset', bar(v3(-0.26, 1.7, -0.42), v3(-0.26, 1.35, -0.4), 0.032, 6), 0x1b1b1d);
  b.add('earpiece', ball(0.05, -0.26, 1.7, -0.42, 1, 1, 1, 6), 0x1b1b1d);
  b.add('cord', bar(v3(-0.26, 1.35, -0.4), v3(-0.18, 1.12, -0.42), 0.012, 4), 0xaeb3b6);
  b.add('shelf', box(0.6, 0.04, 0.3, 0.05, 1.02, -0.38), 0x6b6f72);
  b.add('directory', box(0.2, 0.26, 0.05, 0.05, 0.86, -0.4), 0xe2c548);
  // The lamp over it all, and the sign frame on the roof's front.
  b.add('lamp', box(0.7, 0.04, 0.2, 0, 2.43, -0.3), 0xfff0c8);
  b.add('signFrame', box(0.96, 0.34, 0.1, 0, 2.78, 0.5), alu);
  return b.build('payphone');
}

/** The bees' hives: three stacks of painted boxes on a pallet, each under a tin lid with a brick on it, facing +z. */
export function hivesGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('pallet', box(3.0, 0.1, 1.1, 0, 0.3, 0), 0x8a6a45);
  for (const x of [-1.3, 0, 1.3]) for (const z of [-0.4, 0.4]) b.add('foot', box(0.16, 0.25, 0.16, x, 0.125, z), 0x6a4c2e);
  const paints = [[0xf1ede2, 0xf1ede2, 0xe9d27a], [0xf1ede2, 0x9ec0cc, 0xf1ede2], [0xe9d27a, 0xf1ede2, 0xf1ede2]] as const;
  [-1, 0, 1].forEach((k, i) => {
    const x = k * 0.95;
    paints[i]!.forEach((c, n) => b.add('super', box(0.52, 0.26, 0.44, x, 0.48 + n * 0.27, 0), c));
    b.add('entrance', box(0.3, 0.05, 0.02, x, 0.38, 0.23), 0x1a1410);
    b.add('lid', box(0.58, 0.05, 0.5, x, 1.3, 0), 0xa3a8ac);
    b.add('brick', box(0.2, 0.07, 0.1, x + 0.1, 1.36, 0.05), 0xa0522d);
  });
  return b.build('hives');
}
