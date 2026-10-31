// Las Lomas County's farm props (world/country/farms.ts) as models for PropsView to instance: post-and-rail fence runs,
// the propane tank, the cows, the scarecrows, bale stacks and the apples on the orchard's trees (whose trunks and crowns
// are the city's trees', drawn smaller). Each is one non-indexed geometry with a vertex colour per part (furniture.ts
// ModelBuilder), its origin at its foot, facing +z.

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { COW_H, FENCE_H, FENCE_RUN, PROPANE } from '../../world/country/farms';
import { box, cyl, ModelBuilder } from '../furniture';
import { canvas, toTexture } from '../textures/misc';

/** A run of post-and-rail fence along local x: a post at either end, three rails between. */
export function farmFenceGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const wood = 0x8a6d4c;
  for (const x of [-FENCE_RUN / 2 + 0.07, FENCE_RUN / 2 - 0.07]) b.add('post', box(0.13, FENCE_H + 0.05, 0.13, x, (FENCE_H + 0.05) / 2, 0), wood, 0.85);
  for (const y of [0.45, 0.85, 1.2]) b.add('rail', box(FENCE_RUN, 0.11, 0.045, 0, y, 0.085), wood);
  return b.build('farm-fence');
}

/** The propane tank: a white cylinder along local x with domed ends, on two concrete saddles, its valve on top. */
export function propaneGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const { len, r, axis } = PROPANE;
  const body = len - 2 * r * 0.6;
  b.add('shell', new THREE.CylinderGeometry(r, r, body, 18, 1, true).rotateZ(Math.PI / 2).translate(0, axis, 0), 0xf1f0ea);
  for (const s of [-1, 1]) {
    const dome = new THREE.SphereGeometry(r, 18, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1).rotateZ(-s * Math.PI / 2).translate((s * body) / 2, axis, 0);
    b.add('dome', dome, 0xe9e8e1);
    b.add('saddle', box(0.35, axis - r * 0.55, r * 1.5, (s * body) / 3, (axis - r * 0.55) / 2, 0), 0x9b9890);
  }
  b.add('valve', cyl(0.12, 0.14, 0.18, 8, 0, axis + r - 0.02, 0), 0x6b6f72);
  b.add('cap', cyl(0.06, 0.06, 0.12, 6, 0.25, axis + r - 0.02, 0), 0xb8a640);
  return b.build('propane');
}

/**
 * A cow, facing +z, inside its collider (COW_R round, COW_H tall): a boxy body on four legs, the head forward (its
 * vertices beyond COW_NECK, which the material's grazing nod turns down and up about the neck), ears, horns, the udder
 * and the tail. The body and head take the hide texture; the instance colour picks the coat.
 */
export const COW_NECK = { y: 1.18, z: 0.78 } as const;

/** A part off the hide's patches: every uv on the texture's white strip. */
function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, 0.02);
  return g;
}

export function cowGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const hide = 0xffffff;
  const hoof = 0x2b2522;
  const pink = 0xe0a0a0;
  b.add('body', new THREE.BoxGeometry(0.78, 0.74, 1.62, 2, 2, 3).translate(0, 1.0, -0.06), hide);
  b.add('neck', box(0.42, 0.42, 0.42, 0, 1.14, 0.84), hide, 0.96);
  b.add('head', box(0.34, 0.36, 0.5, 0, 1.12, 1.12), hide);
  b.add('muzzle', plain(box(0.3, 0.22, 0.16, 0, 1.02, 1.42)), pink);
  for (const s of [-1, 1]) {
    b.add('ear', box(0.16, 0.06, 0.1, s * 0.24, 1.27, 1.0), hide, 0.9);
    b.add('horn', plain(cyl(0.015, 0.035, 0.12, 5, s * 0.12, 1.29, 1.02)), 0xe6dcc4);
    for (const z of [-0.6, 0.48]) {
      b.add('leg', box(0.16, 0.56, 0.16, s * 0.25, 0.36, z), hide, 0.92);
      b.add('hoof', plain(box(0.17, 0.09, 0.17, s * 0.25, 0.045, z)), hoof);
    }
  }
  b.add('udder', plain(box(0.3, 0.16, 0.3, 0, 0.6, -0.38)), pink);
  b.add('tail', box(0.05, 0.62, 0.05, 0, 0.98, -0.89), hide, 0.85);
  b.add('tuft', plain(box(0.09, 0.14, 0.09, 0, 0.62, -0.9)), hoof);
  const g = b.build('cow');
  // No part of her stands above COW_H.
  g.userData.height = COW_H;
  return g;
}

let hideTex: THREE.CanvasTexture | null = null;

/** A cow's hide: white with black patches (the instance colour tints the white for a brown or a black coat). */
export function cowTexture(): THREE.Texture {
  if (hideTex) return hideTex;
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  const rng = new Rng(1866);
  ctx.fillStyle = '#1c1a1a';
  for (let k = 0; k < 9; k++) {
    const x = rng.range(0, 128);
    const y = rng.range(0, 128);
    ctx.beginPath();
    for (let a = 0; a < 12; a++) {
      const t = (a / 12) * Math.PI * 2;
      const rr = rng.range(10, 22);
      ctx.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr * 0.8);
    }
    ctx.fill();
  }
  // The strip the plain parts sample (plain()).
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 118, 128, 10);
  hideTex = toTexture(c);
  return hideTex;
}

/** A scarecrow on its post: straw-stuffed plaid shirt on a crossbar, denim legs hanging, a sack head under a straw hat. */
export function scarecrowGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const wood = 0x7a5a3a;
  const straw = 0xd9b65c;
  b.add('post', box(0.09, 2.15, 0.09, 0, 1.075, -0.04), wood);
  b.add('crossbar', box(1.5, 0.07, 0.07, 0, 1.68, -0.04), wood);
  b.add('shirt', box(0.5, 0.62, 0.24, 0, 1.45, 0.02), 0xa8352c);
  b.add('sleeves', box(1.24, 0.18, 0.2, 0, 1.68, 0.02), 0x8f2c25);
  for (const s of [-1, 1]) {
    b.add('cuff', new THREE.ConeGeometry(0.1, 0.18, 6).rotateZ((s * Math.PI) / 2).translate(s * 0.7, 1.68, 0.02), straw);
    b.add('leg', box(0.16, 0.62, 0.17, s * 0.12, 0.85, 0.02), 0x3d5a80);
    b.add('boot', new THREE.ConeGeometry(0.09, 0.16, 6).translate(s * 0.12, 0.48, 0.02), straw);
  }
  b.add('head', new THREE.SphereGeometry(0.2, 10, 7).scale(1, 1.1, 0.95).translate(0, 2.0, 0.02), 0xc8b28a);
  for (const s of [-1, 1]) b.add('eye', box(0.05, 0.05, 0.02, s * 0.07, 2.04, 0.21), 0x1a1a1a);
  b.add('mouth', box(0.14, 0.02, 0.02, 0, 1.93, 0.205), 0x3a2a1a);
  b.add('brim', cyl(0.34, 0.34, 0.03, 14, 0, 2.15, 0.02), straw, 0.95);
  b.add('crown', cyl(0.15, 0.18, 0.2, 10, 0, 2.17, 0.02), straw);
  return b.build('scarecrow');
}

let baleTex: THREE.CanvasTexture | null = null;

/** The faces of a stack of bales: four by four bales of straw, twine round each, dark seams between. */
export function baleTexture(): THREE.Texture {
  if (baleTex) return baleTex;
  const [c, ctx] = canvas(256, 256);
  const rng = new Rng(52);
  ctx.fillStyle = '#6a5426';
  ctx.fillRect(0, 0, 256, 256);
  for (let row = 0; row < 4; row++) {
    for (let k = -1; k < 4; k++) {
      const x = k * 64 + (row % 2) * 32;
      const y = row * 64;
      ctx.fillStyle = `rgb(${204 + rng.int(-14, 14)},${170 + rng.int(-14, 14)},${88 + rng.int(-10, 10)})`;
      ctx.fillRect(x + 2, y + 2, 60, 60);
      ctx.strokeStyle = 'rgba(120,90,40,0.55)';
      ctx.lineWidth = 1;
      for (let n = 0; n < 40; n++) {
        const sx = x + rng.range(4, 60);
        const sy = y + rng.range(4, 60);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + rng.range(-6, 6), sy + rng.range(-2, 2));
        ctx.stroke();
      }
      ctx.fillStyle = '#7a5a2c';
      for (const tx of [x + 20, x + 42]) ctx.fillRect(tx, y + 2, 3, 60);
    }
  }
  baleTex = toTexture(c);
  return baleTex;
}

/** Apples on an orchard tree's crown (the crown PropsView draws: the shrubs' leaves, scaled up): nine red ones. */
export function applesGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const rng = new Rng(1987);
  for (let k = 0; k < 9; k++) {
    const a = rng.range(0, Math.PI * 2);
    const y = rng.range(2.0, 3.2);
    const r = 1.45 - Math.abs(y - 2.6) * 0.5;
    b.add('apple', new THREE.OctahedronGeometry(0.08, 0).translate(Math.cos(a) * r, y, Math.sin(a) * r), rng.chance(0.25) ? 0xd9a531 : 0xc0262d);
  }
  return b.build('apples');
}
