// The attractions' props (world/attractions.ts) as models: corn rows of alpha-tested cross-cards, pumpkins, headstones
// in three shapes (and the epitaph stones' own), and the cemetery's iron fence. Each is one non-indexed geometry with a
// vertex colour per part (furniture.ts ModelBuilder), its origin at its foot; PropsView instances them.

import * as THREE from 'three';
import { Rng } from '../core/rng';
import { box, cyl, flipped, ModelBuilder } from './furniture';

/** A corn wall segment's length (m) along its local x, as attractions.ts lays them, and the stalks' height. */
export const CORN_LEN = 2;
export const CORN_H = 2.6;

/**
 * A 2 m corn segment: ten stalks in two staggered rows, each two cards crossed at right angles and drawn from both
 * sides (the leaf material is single-sided, which keeps it on the trees' program). The texture's alpha cuts them out.
 */
export function cornGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const rng = new Rng(1952);
  for (let k = 0; k < 10; k++) {
    const x = -CORN_LEN / 2 + 0.1 + (k / 9) * (CORN_LEN - 0.2) + rng.range(-0.06, 0.06);
    const z = (k % 2 ? 0.14 : -0.14) + rng.range(-0.05, 0.05);
    const h = CORN_H * rng.range(0.9, 1.04);
    const w = 0.85 * rng.range(0.9, 1.1);
    const turn = rng.range(0, Math.PI);
    for (const a of [turn, turn + Math.PI / 2]) {
      const card = new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0).rotateY(a).translate(x, 0, z);
      const shade = rng.range(0.85, 1.05);
      b.add('stalk', card.clone(), 0xffffff, shade);
      b.add('stalk', flipped(card), 0xffffff, shade * 0.88);
    }
  }
  return b.build('corn');
}

let cornTex: THREE.CanvasTexture | null = null;

/** One corn plant on a transparent card: stem, arching leaves, a cob or two and the tassel. */
export function cornTexture(): THREE.Texture {
  if (cornTex) return cornTex;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 384;
  const ctx = c.getContext('2d')!;
  const rng = new Rng(77);
  ctx.clearRect(0, 0, 128, 384);
  // The stem.
  ctx.strokeStyle = '#7d8f3a';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(64, 384);
  ctx.lineTo(62, 40);
  ctx.stroke();
  // Leaves: long blades arching out and down from the stem, both sides, paler near the top.
  for (let i = 0; i < 9; i++) {
    const y = 360 - i * 36 + rng.range(-8, 8);
    const side = i % 2 ? 1 : -1;
    const g = 110 + i * 9;
    ctx.strokeStyle = `rgb(${70 + i * 6},${g},${40 + i * 3})`;
    ctx.lineWidth = rng.range(7, 10);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(63, y);
    ctx.quadraticCurveTo(63 + side * 40, y - 46, 63 + side * rng.range(52, 62), y + rng.range(-6, 20));
    ctx.stroke();
  }
  // Cobs in their husks.
  for (const [y, side] of [[210, 1], [250, -1]] as const) {
    ctx.fillStyle = '#c9c46a';
    ctx.beginPath();
    ctx.ellipse(63 + side * 10, y, 7, 22, side * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#a7b04c';
    ctx.beginPath();
    ctx.ellipse(63 + side * 8, y + 6, 6, 18, side * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
  // The tassel.
  ctx.strokeStyle = '#d8b75a';
  ctx.lineWidth = 3;
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    ctx.moveTo(62, 44);
    ctx.lineTo(62 + rng.range(-22, 22), rng.range(4, 26));
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  cornTex = t;
  return t;
}

/** A ribbed pumpkin, wider than tall, with its stem; the instance colour picks its orange. */
export function pumpkinGeometry(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(0.45, 18, 10);
  const p = body.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    // Ten ribs: the surface sinks between them.
    const k = 1 - 0.07 * (0.5 - 0.5 * Math.cos(Math.atan2(z, x) * 10));
    p.setXYZ(i, x * k, p.getY(i) * 0.7 + 0.31, z * k);
  }
  body.computeVertexNormals();
  const b = new ModelBuilder();
  b.add('body', body, 0xffffff);
  b.add('stem', cyl(0.035, 0.05, 0.14, 6, 0, 0.6, 0).rotateZ(0.15), 0x4f5a26);
  return b.build('pumpkin');
}

/** Headstone shapes: a rounded slab, a cross and a pointed obelisk; the epitaph stones have their own, the last. */
export const HEADSTONE_SHAPES = 4;

/** A headstone of `shape`, its face to +z, inside its collider's 0.7 x 0.25 x 1.1 m. */
export function headstoneGeometry(shape: number): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const stone = 0xb9b7b0;
  switch (shape) {
    case 0:
      b.add('base', box(0.7, 0.12, 0.25, 0, 0.06, 0), stone, 0.82);
      b.add('slab', box(0.56, 0.62, 0.14, 0, 0.43, 0), stone);
      // A half disc on the slab: the cylinder's half on +x, its axis turned to z, then the half turned up.
      b.add('top', new THREE.CylinderGeometry(0.28, 0.28, 0.14, 14, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, 0.74, 0), stone);
      break;
    case 1:
      b.add('base', box(0.6, 0.18, 0.25, 0, 0.09, 0), stone, 0.82);
      b.add('post', box(0.14, 0.92, 0.12, 0, 0.64, 0), stone, 0.95);
      b.add('arm', box(0.52, 0.13, 0.12, 0, 0.82, 0), stone, 0.95);
      break;
    case 2:
      b.add('base', box(0.42, 0.16, 0.25, 0, 0.08, 0), stone, 0.8);
      b.add('shaft', cyl(0.12, 0.17, 0.78, 4, 0, 0.16, 0).rotateY(Math.PI / 4), stone, 0.9);
      b.add('tip', new THREE.ConeGeometry(0.12 * Math.SQRT2 * 0.75, 0.16, 4).rotateY(Math.PI / 4).translate(0, 1.02, 0), stone, 0.9);
      break;
    default:
      // An epitaph stone: polished dark granite on a plinth, broad enough to read.
      b.add('plinth', box(0.7, 0.14, 0.25, 0, 0.07, 0), 0x5b5e63);
      b.add('slab', box(0.64, 0.84, 0.13, 0, 0.56, 0), 0x2e3136);
      b.add('face', box(0.5, 0.56, 0.01, 0, 0.56, 0.066), 0x7d8086);
      break;
  }
  return b.build(`headstone-${shape}`);
}

/** A run of the cemetery's wrought-iron fence (its length IRON_FENCE_RUN along local x): posts, rails, spear-topped bars. */
export const IRON_FENCE_RUN = 2.4;

export function ironFenceGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const iron = 0x1c1d20;
  b.add('post', box(0.1, 1.75, 0.1, -IRON_FENCE_RUN / 2 + 0.05, 0.875, 0), iron);
  b.add('finial', new THREE.SphereGeometry(0.07, 6, 4).translate(-IRON_FENCE_RUN / 2 + 0.05, 1.8, 0), iron);
  for (const y of [0.18, 1.32]) b.add('rail', box(IRON_FENCE_RUN, 0.05, 0.04, 0, y, 0), iron);
  for (let k = 0; k < 15; k++) {
    const x = -IRON_FENCE_RUN / 2 + 0.2 + k * 0.145;
    b.add('bar', box(0.025, 1.45, 0.025, x, 0.725, 0), iron);
    b.add('spear', new THREE.ConeGeometry(0.035, 0.12, 4).translate(x, 1.51, 0), iron);
  }
  return b.build('ironfence');
}
