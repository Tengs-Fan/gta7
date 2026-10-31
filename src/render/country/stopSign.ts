// Las Lomas County's stop signs (world/country STOP_SIGNS): a red octagon with a white rim and STOP on it, on a post,
// facing the traffic that stops (its local +z), drawn instanced with the city's street furniture (render/props.ts).

import * as THREE from 'three';
import { box, cyl, ModelBuilder } from '../furniture';

const RED = 0xb01a1e;
const WHITE = 0xf2f0ea;
const POST = 0x8c9196;
/** The plate's centre over the ground, and the octagon's radius to a corner (75 cm across its flats). */
const PLATE_Y = 2.15;
const PLATE_R = 0.75 / 2 / Math.cos(Math.PI / 8);

/** One stroke of a letter: x, y (from the plate's centre) and its width and height, m. */
type Stroke = readonly [number, number, number, number];

/** S, T, O and P in strokes 3 cm thick on a 15 cm by 20 cm cell, each letter's strokes about its own centre. */
const LETTERS: ReadonlyArray<readonly Stroke[]> = [
  [[0, 0.085, 0.13, 0.03], [0, 0, 0.13, 0.03], [0, -0.085, 0.13, 0.03], [-0.05, 0.043, 0.03, 0.09], [0.05, -0.043, 0.03, 0.09]],
  [[0, 0.085, 0.15, 0.03], [0, -0.015, 0.03, 0.17]],
  [[0, 0.085, 0.13, 0.03], [0, -0.085, 0.13, 0.03], [-0.05, 0, 0.03, 0.2], [0.05, 0, 0.03, 0.2]],
  [[-0.05, 0, 0.03, 0.2], [0, 0.085, 0.13, 0.03], [0, 0, 0.13, 0.03], [0.05, 0.043, 0.03, 0.09]],
];

/** An octagon of corner radius `r` in the plate's plane, flat side up, `z` in front of the post. */
function octagon(r: number, z: number): THREE.BufferGeometry {
  return new THREE.CircleGeometry(r, 8, Math.PI / 8).translate(0, PLATE_Y, z);
}

export function stopSignGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('post', cyl(0.035, 0.035, PLATE_Y + 0.1, 6), POST, 0.9);
  // The plate's back and edge, then its white rim, the red face and the letters, each a few millimetres proud.
  b.add('plate', new THREE.CylinderGeometry(PLATE_R + 0.02, PLATE_R + 0.02, 0.02, 8).rotateY(Math.PI / 8).rotateX(Math.PI / 2).translate(0, PLATE_Y, 0.045), POST, 0.75);
  b.add('rim', octagon(PLATE_R, 0.058), WHITE);
  b.add('face', octagon(PLATE_R - 0.035, 0.06), RED);
  LETTERS.forEach((strokes, k) => {
    const cx = (k - 1.5) * 0.15;
    for (const [x, y, w, h] of strokes) b.add('letter', box(w, h, 0.004, cx + x, PLATE_Y + y, 0.062), WHITE);
  });
  return b.build('stop-sign');
}
