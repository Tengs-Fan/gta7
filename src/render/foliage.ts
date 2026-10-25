// Shared, opaque foliage geometry: detailed silhouettes stay in one instanced draw per material.
//
// Broadleaf canopies are alpha-tested leaf cards (sprays and dense clumps from the leaf atlas,
// src/assets/textures/leaf_atlas), all inside the cluster envelopes below even when the wind (wind.ts) pushes them as far as a storm
// can. Palms have curved, ringed trunks; PropsView adds a per-palm lean through the instance matrix.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { assets } from './assets';
import { WIND_AMP_MAX, windMaxDisplacement } from './wind';

type Point = readonly [number, number, number];
export type BroadleafKind = 'tree' | 'bush';
export interface FoliageCluster { readonly scale: Point; readonly at: Point }

// The camera uses these same envelopes and the actual surface vertices below. Keep foliage above
// the pedestrian corridor; the woody trunks retain the simulation's original collision radii.
const TREE: readonly FoliageCluster[] = [
  { scale: [1.18, 1.25, 1.10], at: [0, 4.25, 0] },
  { scale: [0.98, 1.12, 0.93], at: [0.15, 5.25, 0.12] },
  { scale: [1.00, 0.90, 0.85], at: [-0.88, 4.15, 0.10] },
  { scale: [0.90, 1.00, 0.88], at: [0.90, 4.50, 0.20] },
  { scale: [0.95, 0.80, 0.88], at: [-0.15, 4.20, 1.00] },
  { scale: [0.95, 0.93, 0.82], at: [-0.20, 4.60, -0.92] },
  { scale: [0.75, 0.86, 0.73], at: [0.85, 5.20, -0.55] },
  { scale: [0.77, 0.80, 0.74], at: [-0.75, 5.05, 0.55] },
  { scale: [0.70, 0.70, 0.75], at: [0.50, 3.60, 0.65] },
  { scale: [0.65, 0.67, 0.70], at: [-0.85, 3.65, -0.55] },
].map(({ scale, at }) => ({ scale: [scale[0]! * 0.9, scale[1]!, scale[2]! * 0.9] as Point, at: [at[0]! * 0.9, at[1]!, at[2]! * 0.9] as Point }));
const BUSH: readonly FoliageCluster[] = [
  { scale: [0.65, 0.60, 0.62], at: [0, 0.57, 0] },
  { scale: [0.51, 0.40, 0.50], at: [-0.49, 0.40, 0.08] },
  { scale: [0.48, 0.45, 0.52], at: [0.48, 0.45, 0.12] },
  { scale: [0.49, 0.43, 0.44], at: [0.10, 0.43, -0.48] },
  { scale: [0.53, 0.42, 0.47], at: [-0.10, 0.42, 0.44] },
];

export function broadleafClusters(kind: BroadleafKind): readonly FoliageCluster[] {
  return kind === 'tree' ? TREE : BUSH;
}

/** The range of prop scales trees and bushes are placed at (world/layout.ts): the cards keep clear of the envelopes for all of them. */
export const BROADLEAF_SCALE = { min: 0.7, max: 1.35 } as const;

/**
 * How far (in the prop's own units) a leaf at local height `y` stays inside its envelope: the most a storm can push it
 * (world metres, at the tallest scale) over the smallest scale, plus a centimetre.
 */
export function leafMargin(y: number): number {
  return windMaxDisplacement(y * BROADLEAF_SCALE.max, WIND_AMP_MAX) / BROADLEAF_SCALE.min + 0.01;
}

/** Leaf cards per canopy (each a spray of the atlas, drawn from both sides). */
export const LEAF_CARDS: Readonly<Record<BroadleafKind, number>> = { tree: 140, bush: 72 };

/** The atlas: three open sprays (tiles 0-2) and a dense round clump (tile 3) in a 2x2 grid; [u0, v0, u1, v1] with v up. */
const PAD = 0.004;
export const LEAF_TILES: ReadonlyArray<readonly [number, number, number, number]> = [0, 1, 2, 3].map((k) => {
  const c = k % 2;
  const r = Math.floor(k / 2);
  return [c / 2 + PAD, 1 - (r + 1) / 2 + PAD, (c + 1) / 2 - PAD, 1 - r / 2 - PAD] as const;
});

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts, false);
  if (!geometry) throw new Error('Foliage geometry attributes must match');
  for (const part of parts) part.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The old scalloped canopy surface, no longer drawn: its samples keep the camera's clearance (foliagePoints) as it was. */
function hullSamples(kind: BroadleafKind): number[] {
  const samples: number[] = [];
  broadleafClusters(kind).forEach(({ scale, at }, cluster) => {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.getAttribute('position');
    const xyz: number[] = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const ripple = Math.sin(x * 8 + cluster * 1.7) * Math.sin(z * 7 - y * 5 + cluster);
      const radius = 0.91 + 0.085 * ripple;
      xyz.push(at[0] + x * scale[0] * radius, at[1] + y * scale[1] * radius, at[2] + z * scale[2] * radius);
    }
    g.dispose();
    for (let i = 0; i < xyz.length; i += 9) {
      for (let a = 0; a <= 4; a++) {
        for (let b = 0; b <= 4 - a; b++) {
          const u = a / 4, v = b / 4, w = 1 - u - v;
          for (let k = 0; k < 3; k++) samples.push(xyz[i + k]! * u + xyz[i + 3 + k]! * v + xyz[i + 6 + k]! * w);
        }
      }
    }
  });
  return samples;
}

/** Whether `p` (local) lies in some cluster's envelope with `margin` to spare. */
function inEnvelope(clusters: readonly FoliageCluster[], p: THREE.Vector3, margin: number): boolean {
  return clusters.some(({ scale, at }) => Math.hypot(p.x - at[0], p.y - at[1], p.z - at[2]) <= Math.max(...scale) - margin);
}

const broadleafCache = new Map<BroadleafKind, { geometry: THREE.BufferGeometry; samples: number[]; cards: number }>();

function broadleaf(kind: BroadleafKind): { geometry: THREE.BufferGeometry; samples: number[]; cards: number } {
  const cached = broadleafCache.get(kind);
  if (cached) return cached;
  const clusters = broadleafClusters(kind);
  const rng = new Rng(kind === 'tree' ? 4411 : 4412);
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], col: number[] = [];
  const push = (p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, shade: number, warm: number): void => {
    pos.push(p.x, p.y, p.z);
    nrm.push(n.x, n.y, n.z);
    uv.push(u, v);
    col.push(shade * (1 + warm), shade, shade * (0.92 - warm * 0.5));
  };
  // The cards: sprays round each cluster, the twig end inward, each inside the envelopes with the storm margin.
  const volume = clusters.map(({ scale }) => scale[0] * scale[1] * scale[2]);
  const total = volume.reduce((a, b) => a + b, 0);
  const half = kind === 'tree' ? [0.28, 0.41] : [0.17, 0.26];
  const centre = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();
  const corner = new THREE.Vector3(), normal = new THREE.Vector3(), out = new THREE.Vector3();
  let cards = 0;
  for (let attempt = 0; cards < LEAF_CARDS[kind] && attempt < 20000; attempt++) {
    let pick = rng.range(0, total);
    let ci = 0;
    while (ci < clusters.length - 1 && pick > volume[ci]!) pick -= volume[ci++]!;
    const { scale, at } = clusters[ci]!;
    d.set(rng.range(-1, 1), rng.range(-0.55, 1), rng.range(-1, 1));
    if (d.lengthSq() < 1e-3) continue;
    d.normalize();
    const f = rng.range(0.35, 0.9);
    centre.set(at[0] + d.x * scale[0] * f, at[1] + d.y * scale[1] * f, at[2] + d.z * scale[2] * f);
    n.set(d.x + rng.range(-0.7, 0.7), d.y + rng.range(-0.7, 0.7), d.z + rng.range(-0.7, 0.7)).normalize();
    up.copy(d).addScaledVector(n, -d.dot(n));
    if (up.lengthSq() < 1e-3) up.set(0, 1, 0).addScaledVector(n, -n.y);
    up.normalize().applyAxisAngle(n, rng.range(-0.6, 0.6));
    right.crossVectors(up, n).normalize();
    const s = rng.range(half[0]!, half[1]!) * (attempt > 8000 ? 0.75 : 1);
    const corners: THREE.Vector3[] = [];
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) corners.push(centre.clone().addScaledVector(right, a * s).addScaledVector(up, b * s));
    if (!corners.every((c) => inEnvelope(clusters, c, leafMargin(c.y)))) continue;
    // Deep inside the crown, half the cards are dense clumps, which give it body; the rest are open sprays.
    const [u0, v0, u1, v1] = LEAF_TILES[f < 0.55 && rng.chance(0.5) ? 3 : rng.int(0, 2)]!;
    const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] as const;
    const shade = 0.82 + f * 0.22 + rng.range(-0.06, 0.06);
    const warm = rng.range(-0.04, 0.06);
    // Both faces carry the same normal, bent out from the cluster, so the canopy shades as one soft mass.
    out.copy(d);
    if (n.dot(out) < 0) n.negate();
    const quad = (order: readonly number[]): void => {
      for (const k of order) {
        corner.copy(corners[k]!);
        normal.set((corner.x - at[0]) / scale[0], (corner.y - at[1]) / scale[1], (corner.z - at[2]) / scale[2]).normalize().multiplyScalar(0.7).addScaledVector(n, 0.3).normalize();
        push(corner, normal, uvs[k]![0], uvs[k]![1], shade, warm);
      }
    };
    quad([0, 1, 2, 0, 2, 3]);
    quad([0, 2, 1, 0, 3, 2]);
    cards++;
  }
  if (cards < LEAF_CARDS[kind]) throw new Error(`${kind}: placed only ${cards} leaf cards`);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.leafCards = cards;
  const samples = hullSamples(kind);
  // Every drawn corner too, so the camera knows exactly where the leaves are.
  for (let i = 0; i < pos.length; i++) samples.push(pos[i]!);
  const value = { geometry, samples, cards };
  broadleafCache.set(kind, value);
  return value;
}

export function broadleafGeometry(kind: BroadleafKind): THREE.BufferGeometry {
  const g = broadleaf(kind).geometry.clone();
  g.userData.leafCards = broadleaf(kind).cards;
  return g;
}

export function broadleafSamples(kind: BroadleafKind): readonly number[] {
  return broadleaf(kind).samples;
}

/** Manifest id of the leaf atlas. */
export const LEAF_ATLAS_ID = 'tex.leaf_atlas.albedo';

let leafTexture: THREE.Texture | null = null;

/**
 * The leaf atlas from the asset library, or (Node tests, ?assets=0, a failed load) a canvas stand-in with the same tile
 * layout: open sprays of leaf shapes with alpha and an opaque core tile.
 */
export function broadleafTexture(): THREE.Texture {
  const loaded = assets.texture(LEAF_ATLAS_ID);
  if (loaded) {
    loaded.wrapS = loaded.wrapT = THREE.ClampToEdgeWrapping;
    loaded.anisotropy = 4;
    return loaded;
  }
  if (leafTexture) return leafTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const rng = new Rng(683);
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = '#2c421e';
  ctx.beginPath();
  ctx.arc(192, 192, 44, 0, Math.PI * 2);
  ctx.fill();
  for (let k = 0; k < 4; k++) {
    const ox = (k % 2) * 128;
    const oy = Math.floor(k / 2) * 128;
    for (let i = 0; i < (k === 3 ? 90 : 40); i++) {
      const x = ox + rng.range(14, 114), y = oy + rng.range(14, 114);
      const length = rng.range(6, 11), width = length * rng.range(0.45, 0.6);
      const value = rng.int(70, 140);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rng.range(0, Math.PI * 2));
      ctx.fillStyle = `rgb(${value - 30},${value + 20},${value - 55})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, length, width, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  leafTexture = tex;
  return tex;
}

function bark(geometry: THREE.BufferGeometry, palm: boolean): THREE.BufferGeometry {
  const p = geometry.getAttribute('position');
  const colors: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const around = Math.atan2(p.getX(i), p.getZ(i));
    const grain = Math.sin(around * 9 + y * 0.9) * 0.055;
    // Palms: a dark leaf-scar groove at the foot of every ring, lighter towards its flared top.
    const ring = palm ? (y / PALM_RING - Math.floor(y / PALM_RING)) * 0.42 - 0.2 : 0;
    const shade = 0.85 + grain + ring;
    colors.push(shade, shade * 0.94, shade * 0.84);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function branch(from: Point, to: Point, bottom: number, top: number): THREE.BufferGeometry {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(top, bottom, d.length(), 6, 1, true).toNonIndexed();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return bark(g, false);
}

/** The broadleaf trunk's limbs: from where they leave the trunk (all below the canopy, which starts near 3 m) out to it. */
export const TREE_LIMBS: ReadonlyArray<{ from: Point; to: Point; r0: number; r1: number }> = [
  { from: [0, 2.35, 0], to: [-0.95, 3.85, 0.2], r0: 0.12, r1: 0.04 },
  { from: [0, 2.55, 0], to: [0.9, 4.0, 0.4], r0: 0.115, r1: 0.04 },
  { from: [0, 2.75, 0], to: [-0.1, 4.1, -0.95], r0: 0.105, r1: 0.035 },
  { from: [0, 2.9, 0], to: [0.15, 4.2, 0.95], r0: 0.1, r1: 0.035 },
  { from: [0.45, 3.3, 0.2], to: [0.95, 4.6, -0.45], r0: 0.055, r1: 0.022 },
  { from: [-0.5, 3.15, 0.1], to: [-0.75, 4.7, 0.5], r0: 0.055, r1: 0.022 },
];

export function treeTrunkGeometry(): THREE.BufferGeometry {
  return merge([
    branch([0, 0, 0], [0, 4.1, 0], 0.26, 0.085),
    ...TREE_LIMBS.map((l) => branch(l.from, l.to, l.r0, l.r1)),
  ]);
}

/** A palm trunk's built-in curve: its centre line leans this far (m, along local +x) at its top, PALM_TOP m up. */
export const PALM_BEND = 0.85;
export const PALM_TOP = 8.5;
/** Height (m) of one leaf-scar ring of the palm trunk. */
export const PALM_RING = PALM_TOP / 27;

/** The palm trunk's centre line at height y (local): the lean along +x. */
export function palmCurve(y: number): number {
  return PALM_BEND * (y / PALM_TOP) ** 2;
}

export function palmTrunkGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.14, 0.24, PALM_TOP, 8, 54, true).translate(0, PALM_TOP / 2, 0);
  const p = trunk.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    // Stacked rings, each flaring a little at its top; inside the original 0.3 m collider, including at the broad base.
    // Two segments per ring; the nudge keeps a ring's foot (t = 0) from rounding up to the ring below's top.
    const t = y / PALM_RING + 1e-4 - Math.floor(y / PALM_RING + 1e-4);
    const ridge = 0.92 + 0.12 * t * t;
    p.setXYZ(i, p.getX(i) * ridge + palmCurve(y), y, p.getZ(i) * ridge);
  }
  trunk.computeVertexNormals();
  const crown = new THREE.CylinderGeometry(0.23, 0.28, 0.65, 8).translate(palmCurve(8.38), 8.38, 0);
  return merge([bark(trunk.toNonIndexed(), true), bark(crown.toNonIndexed(), false)]);
}

/** Where the fronds spring from (local), for their wind: they bend more the further out they reach. */
export const PALM_CROWN: Point = [PALM_BEND, 8.67, 0];

/** Curved rachises and tapered paired leaflets have an open feathered silhouette, without alpha cards. */
export function palmFrondsGeometry(): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, shade: number): void => {
    for (const p of [a, b, c]) { positions.push(p.x, p.y, p.z); colors.push(shade * 1.04, shade, shade * 0.78); }
  };
  const up = new THREE.Vector3(0, 1, 0);
  for (let frond = 0; frond < 11; frond++) {
    const angle = frond * Math.PI * 2 / 11 + Math.sin(frond * 2.3) * 0.12;
    const along = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    const across = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle));
    const upper = frond % 3 === 0;
    const length = upper ? 2.65 : 3.25 + Math.sin(frond * 1.7) * 0.3;
    const lift = upper ? 1.30 : 0.62;
    const droop = upper ? 1.15 : 1.75;
    const centre = (t: number): THREE.Vector3 => along.clone().multiplyScalar(length * t)
      .addScaledVector(up, 8.67 + Math.sin(t * Math.PI * 0.9) * lift - t * t * droop);
    // Tapered central rib, curved in nine segments.
    for (let segment = 0; segment < 9; segment++) {
      const t0 = segment / 9, t1 = (segment + 1) / 9;
      const a = centre(t0), b = centre(t1);
      const w0 = 0.038 * (1 - t0) + 0.007, w1 = 0.038 * (1 - t1) + 0.007;
      const l0 = a.clone().addScaledVector(across, -w0), r0 = a.clone().addScaledVector(across, w0);
      const l1 = b.clone().addScaledVector(across, -w1), r1 = b.clone().addScaledVector(across, w1);
      tri(l0, l1, r0, 0.79); tri(r0, l1, r1, 0.79);
    }
    for (let leaf = 0; leaf < 12; leaf++) {
      const t = 0.12 + leaf * 0.067;
      const width = Math.sin(Math.PI * (t * 0.88 + 0.06)) * (upper ? 0.63 : 0.79);
      for (const side of [-1, 1]) {
        const root = centre(t + (side > 0 ? 0.013 : 0));
        const tip = root.clone().addScaledVector(across, width * side).addScaledVector(along, 0.29 + t * 0.16).addScaledVector(up, -0.16 - t * 0.2);
        const middle = root.clone().lerp(tip, 0.5).addScaledVector(up, 0.055);
        const halfWidth = 0.095 * (1 - t * 0.60);
        const left = middle.clone().addScaledVector(along, -halfWidth);
        const right = middle.clone().addScaledVector(along, halfWidth);
        const ridge = middle.clone().addScaledVector(up, 0.032);
        const shade = 0.72 + 0.18 * Math.sin(t * Math.PI) + Math.sin(frond * 1.9 + leaf * 0.7) * 0.045;
        tri(root, left, ridge, shade); tri(root, ridge, right, shade * 1.05);
        tri(left, tip, ridge, shade); tri(ridge, tip, right, shade * 1.05);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.translate(PALM_BEND, 0, 0);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
