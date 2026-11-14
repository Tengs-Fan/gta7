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
/**
 * The cards a canopy keeps when its batch is far from the camera (PropsView's distance level): the first of the list,
 * which mixes rim and body cards. Past 60 m a card is a few pixels, and the coverage boost (FOLIAGE_COVERAGE) keeps
 * the crown as full as the near one.
 */
export const LEAF_CARDS_FAR: Readonly<Record<BroadleafKind, number>> = { tree: 96, bush: 50 };

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
  // The cards: sprays round each cluster, the twig end inward, each inside the envelopes with the storm margin. The
  // every fifth is the rim's: smaller open sprays near the clusters' surface, standing out from it (their face across
  // the radius rather than along it), so a crown's outline seen from any side breaks into sprays of leaves.
  const volume = clusters.map(({ scale }) => scale[0] * scale[1] * scale[2]);
  const total = volume.reduce((a, b) => a + b, 0);
  const half = kind === 'tree' ? [0.28, 0.41] : [0.17, 0.26];
  // The crown's height, for its shading: a crown is darker underneath, where the leaves above shade it.
  const bottom = Math.min(...clusters.map(({ at, scale }) => at[1] - scale[1]));
  const top = Math.max(...clusters.map(({ at, scale }) => at[1] + scale[1]));
  const centre = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();
  const corner = new THREE.Vector3(), normal = new THREE.Vector3(), out = new THREE.Vector3();
  let cards = 0;
  for (let attempt = 0; cards < LEAF_CARDS[kind] && attempt < 20000; attempt++) {
    // Rim and body cards alternate through the list, so a far crown drawn with its first LEAF_CARDS_FAR cards keeps both.
    const rim = cards % 5 === 0;
    let pick = rng.range(0, total);
    let ci = 0;
    while (ci < clusters.length - 1 && pick > volume[ci]!) pick -= volume[ci++]!;
    const { scale, at } = clusters[ci]!;
    d.set(rng.range(-1, 1), rng.range(-0.55, 1), rng.range(-1, 1));
    if (d.lengthSq() < 1e-3) continue;
    d.normalize();
    const f = rim ? rng.range(0.72, 0.95) : rng.range(0.35, 0.9);
    centre.set(at[0] + d.x * scale[0] * f, at[1] + d.y * scale[1] * f, at[2] + d.z * scale[2] * f);
    if (rim) {
      // Facing across the radius, its top outward.
      n.set(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      n.addScaledVector(d, -0.85 * n.dot(d));
      if (n.lengthSq() < 1e-4) continue;
      n.normalize();
    } else {
      n.set(d.x + rng.range(-0.7, 0.7), d.y + rng.range(-0.7, 0.7), d.z + rng.range(-0.7, 0.7)).normalize();
    }
    up.copy(d).addScaledVector(n, -d.dot(n));
    if (up.lengthSq() < 1e-3) up.set(0, 1, 0).addScaledVector(n, -n.y);
    up.normalize().applyAxisAngle(n, rng.range(-0.6, 0.6));
    right.crossVectors(up, n).normalize();
    const s = rng.range(half[0]!, half[1]!) * (rim ? 0.75 : 1) * (attempt > 8000 ? 0.75 : 1);
    const corners: THREE.Vector3[] = [];
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) corners.push(centre.clone().addScaledVector(right, a * s).addScaledVector(up, b * s));
    if (!corners.every((c) => inEnvelope(clusters, c, leafMargin(c.y)))) continue;
    // Inside the crown, three in five cards are dense clumps, which give it body; the rest, and every rim card, are open sprays.
    const [u0, v0, u1, v1] = LEAF_TILES[!rim && f < 0.7 && rng.chance(0.6) ? 3 : rng.int(0, 2)]!;
    const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] as const;
    // Lighter outward and upward: 0.62 of the light at the crown's foot, the full light at its top.
    const height = Math.min(1, Math.max(0, (centre.y - bottom) / (top - bottom)));
    const shade = (0.62 + 0.38 * Math.sqrt(height)) * (0.9 + f * 0.2) + rng.range(-0.06, 0.06);
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
    const around = Math.atan2(p.getX(i) - (palm ? palmCurve(y) : 0), p.getZ(i));
    const grain = Math.sin(around * 9 + y * 0.9) * 0.055;
    // Palms: a dark leaf-scar groove at the foot of every ring, lighter towards its flared top, the scars staggered
    // round the trunk from ring to ring; the foot greyer and the top, under the boot, browner.
    const t = y / PALM_RING - Math.floor(y / PALM_RING);
    const ring = palm ? t * 0.55 - 0.3 + Math.sin(around * 2 + Math.floor(y / PALM_RING) * 2.4) * 0.05 * t : 0;
    const age = palm ? Math.min(1, y / 6) : 1;
    const shade = 0.85 + grain + ring;
    colors.push(shade * (0.92 + 0.08 * age), shade * (0.92 + 0.02 * age), shade * (0.9 - 0.06 * age));
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Metres of trunk one repeat of the bark tile spans (textures/misc.ts barkTextures), and its repeats round a trunk. */
const BARK_V = 1.1;
const BARK_U = 2;

/**
 * A bark-covered tube through `path` (a Catmull-Rom curve), a ring of `radial` sides at each station `t` (0..1 along
 * it), the radius at a station `r(t, angle, y)`. Frames are carried along the curve without twist. UVs wrap the bark tile
 * BARK_U times round it and run up it in metres from `v0`; the vertex colour is `shade(t)` times a light grain.
 */
function barkTube(path: readonly Point[], stations: readonly number[], radial: number, r: (t: number, a: number, y: number) => number, shade: (t: number, y: number) => number, v0 = 0): THREE.BufferGeometry {
  const pts = path.map((p) => new THREE.Vector3(...p));
  const curve = pts.length > 2 ? new THREE.CatmullRomCurve3(pts, false, 'centripetal') : new THREE.LineCurve3(pts[0]!, pts[1]!);
  const length = curve.getLength();
  const tan = curve.getTangentAt(0).normalize();
  let nrm = new THREE.Vector3().crossVectors(tan, Math.abs(tan.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  let prev = tan.clone();
  const cols = radial + 1;
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  for (const t of stations) {
    const p = curve.getPointAt(t);
    const d = curve.getTangentAt(t).normalize();
    const axis = new THREE.Vector3().crossVectors(prev, d);
    const s = axis.length();
    if (s > 1e-9) nrm.applyAxisAngle(axis.normalize(), Math.asin(Math.min(1, s)));
    nrm = nrm.sub(d.clone().multiplyScalar(nrm.dot(d))).normalize();
    prev = d;
    const bin = new THREE.Vector3().crossVectors(d, nrm).normalize();
    const k = shade(t, p.y);
    for (let j = 0; j < cols; j++) {
      const a = (j / radial) * Math.PI * 2;
      const rr = r(t, a, p.y);
      pos.push(p.x + (nrm.x * Math.cos(a) + bin.x * Math.sin(a)) * rr, p.y + (nrm.y * Math.cos(a) + bin.y * Math.sin(a)) * rr, p.z + (nrm.z * Math.cos(a) + bin.z * Math.sin(a)) * rr);
      uv.push((j / radial) * BARK_U, (v0 + t * length) / BARK_V);
      const grain = 1 + Math.sin(a * 3 + t * 7 + v0) * 0.04;
      col.push(k * grain, k * grain * 0.97, k * grain * 0.92);
    }
  }
  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, e = c + 1;
      idx.push(a, b, c, b, e, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // The seam's two columns share one normal, so the tube shades round without a crease.
  const n = g.getAttribute('normal');
  for (let i = 0; i < stations.length; i++) {
    const a = i * cols, b = a + radial;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l);
    n.setXYZ(b, x / l, y / l, z / l);
  }
  return g.toNonIndexed();
}

/** A limb: where it leaves its parent, the point it forks at (or ends), its radius at each end. */
export interface Limb { readonly from: Point; readonly to: Point; readonly r0: number; readonly r1: number }

/**
 * The broadleaf trunk's four main limbs: each leaves the trunk below the canopy (which starts near 2.9 m) and runs
 * 0.55 to 0.6 m out to where it forks, under the canopy's edge, so the fork shows from the street.
 */
export const TREE_LIMBS: readonly Limb[] = [
  { from: [0, 2.3, 0], to: [-0.55, 3.05, 0.06], r0: 0.095, r1: 0.06 },
  { from: [0, 2.5, 0], to: [0.5, 3.15, 0.3], r0: 0.09, r1: 0.058 },
  { from: [0, 2.7, 0], to: [-0.1, 3.3, -0.55], r0: 0.085, r1: 0.055 },
  { from: [0, 2.85, 0], to: [0.06, 3.45, 0.6], r0: 0.08, r1: 0.05 },
];

/** Where each fork of a main limb (TREE_LIMBS, two each) reaches, into the canopy's lower clusters. */
export const TREE_FORKS: readonly Point[][] = [
  [[-1.0, 3.75, -0.35], [-0.85, 4.3, 0.35]],
  [[0.8, 3.75, 0.75], [0.95, 4.35, 0.05]],
  [[0.35, 4.0, -0.95], [-0.5, 4.25, -0.9]],
  [[-0.4, 4.15, 1.0], [0.42, 4.25, 0.92]],
];

/** The trunk's height: it tapers from its flared foot into the canopy's middle. */
const TRUNK_TOP = 4.4;

/** The trunk's radius at height y, before the root flare: 0.2 m at the foot, 0.07 m at the top. */
function trunkRadius(y: number): number {
  return 0.07 + 0.13 * Math.max(0, 1 - y / TRUNK_TOP) ** 0.9;
}

/** Bark tone up the trunk: darker and a touch greener at the foot, where soil splashes and moss grows. */
function trunkShade(y: number): number {
  return 0.78 + 0.22 * Math.min(1, y / 1.2);
}

/**
 * The broadleaf tree's woody frame: a trunk that flares into five root buttresses at its foot (at most 0.3 m out,
 * inside the 0.32 m collider) and tapers as it bends a little on its way up, four limbs that leave it under the canopy
 * and fork into two branches each, all barked (barkTextures). 238 triangles.
 */
export function treeTrunkGeometry(): THREE.BufferGeometry {
  const flare = (a: number, y: number) => 1 + 0.45 * Math.exp(-y / 0.22) * (0.68 + 0.32 * Math.cos(5 * a + 0.7));
  const trunk = barkTube(
    [[0, 0, 0], [0.03, 1.3, 0.02], [-0.03, 2.6, 0.04], [0.05, 3.6, -0.02], [0.08, TRUNK_TOP, 0]],
    [0, 0.03, 0.08, 0.2, 0.42, 0.64, 0.82, 1],
    7,
    (_t, a, y) => trunkRadius(y) * flare(a, y),
    (_t, y) => trunkShade(y),
  );
  const parts = [trunk];
  TREE_LIMBS.forEach((l, k) => {
    // The limb bows up a little on its way out.
    const mid: Point = [(l.from[0] + l.to[0]) * 0.5, (l.from[1] + l.to[1]) * 0.5 + 0.08, (l.from[2] + l.to[2]) * 0.5];
    parts.push(barkTube([l.from, mid, l.to], [0, 0.5, 1], 5, (t) => l.r0 + (l.r1 - l.r0) * t, () => 0.95, l.from[1]));
    for (const end of TREE_FORKS[k]!) parts.push(barkTube([l.to, end], [0, 1], 4, (t) => l.r1 * (0.8 - 0.45 * t), () => 1, l.to[1]));
  });
  return merge(parts);
}

/**
 * The trunk drawn when its batch is far from the camera (PropsView's distance level): the same flared trunk on five
 * sides, its four limbs straight out to between their forks, three-sided. 54 triangles, 242 near.
 */
export function treeTrunkFarGeometry(): THREE.BufferGeometry {
  const flare = (y: number) => 1 + 0.38 * Math.exp(-y / 0.22);
  const parts = [barkTube([[0, 0, 0], [0.03, 1.3, 0.02], [-0.03, 2.6, 0.04], [0.08, TRUNK_TOP, 0]], [0, 0.1, 0.5, 1], 5, (_t, _a, y) => trunkRadius(y) * flare(y), (_t, y) => trunkShade(y))];
  TREE_LIMBS.forEach((l, k) => {
    const [a, b] = TREE_FORKS[k]!;
    const end: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    parts.push(barkTube([l.from, end], [0, 1], 3, (t) => l.r0 * (1 - 0.6 * t), () => 0.95, l.from[1]));
  });
  const g = merge(parts);
  g.name = 'tree-trunk-far';
  return g;
}

/** A cypress's trunk: straight and plain, hidden but for its foot inside the column of leaves it carries. */
export function cypressTrunkGeometry(): THREE.BufferGeometry {
  return merge([barkTube([[0, 0, 0], [0, TRUNK_TOP, 0]], [0, 0.06, 0.4, 1], 6, (_t, _a, y) => trunkRadius(y) * (1 + 0.3 * Math.exp(-y / 0.25)), (_t, y) => trunkShade(y))]);
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
    // The foot swells into a bulb of roots, 0.29 m out at most (inside the 0.3 m collider).
    const ridge = (0.92 + 0.12 * t * t) * (1 + 0.15 * Math.exp(-y / 0.45));
    p.setXYZ(i, p.getX(i) * ridge + palmCurve(y), y, p.getZ(i) * ridge);
  }
  trunk.computeVertexNormals();
  const crown = new THREE.CylinderGeometry(0.23, 0.28, 0.65, 8).translate(palmCurve(8.38), 8.38, 0);
  return merge([bark(trunk.toNonIndexed(), true), bark(crown.toNonIndexed(), false), palmBoot()]);
}

/**
 * The boot: the split bases of old fronds round the crown, fourteen wedges standing up and out from it in two staggered
 * tiers, all above 8 m (the rings below are the trunk's own), browner than the trunk.
 */
function palmBoot(): THREE.BufferGeometry {
  const positions: number[] = [];
  const x0 = palmCurve(8.38);
  for (let k = 0; k < 14; k++) {
    const a = k * (Math.PI * 2 / 7) + (k >= 7 ? Math.PI / 7 : 0);
    const y = k >= 7 ? 8.42 : 8.12;
    const out = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const side = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    const foot = new THREE.Vector3(x0, y, 0).addScaledVector(out, 0.2);
    const tip = foot.clone().addScaledVector(out, 0.2).add(new THREE.Vector3(0, 0.3, 0));
    const l = foot.clone().addScaledVector(side, -0.1), r = foot.clone().addScaledVector(side, 0.1);
    const back = foot.clone().addScaledVector(out, -0.08).add(new THREE.Vector3(0, 0.18, 0));
    // A wedge: its outer face, its two flanks and its back against the crown.
    for (const [p, q, w] of [[l, r, tip], [r, back, tip], [back, l, tip], [l, back, r]] as const) positions.push(p.x, p.y, p.z, q.x, q.y, q.z, w.x, w.y, w.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  const n = positions.length / 3;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([0.74, 0.6, 0.44], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
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
  // Three dead fronds hang under the green ones, dry and brown: each a folded strip, narrowing to its tip, from the crown
  // down along the trunk. Their colour is what the fronds' green tint (PropsView.buildPalms) turns a straw brown.
  for (let k = 0; k < 3; k++) {
    const angle = k * 2.1 + 0.6;
    const along = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    const across = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle));
    // Out from the crown and down beside the trunk, following its curve.
    const at = (t: number): THREE.Vector3 => {
      const y = 8.45 - t * 1.5 - k * 0.12;
      return along.clone().multiplyScalar(0.28 + 0.2 * Math.sin(t * Math.PI * 0.8)).addScaledVector(up, y).add(new THREE.Vector3(palmCurve(y) - PALM_BEND, 0, 0));
    };
    const dry = 0.62 + k * 0.05;
    for (let segment = 0; segment < 5; segment++) {
      const t0 = segment / 5, t1 = (segment + 1) / 5;
      const a = at(t0), b = at(t1);
      const w0 = 0.2 * (1 - t0 * 0.8), w1 = 0.2 * (1 - t1 * 0.8);
      // Folded down the middle: its edges hang a little lower and further out than its spine.
      const edge = (p: THREE.Vector3, w: number, s: number) => p.clone().addScaledVector(across, s * w).addScaledVector(along, w * 0.25).addScaledVector(up, -w * 0.3);
      for (const s of [-1, 1]) {
        const p0 = edge(a, w0, s), p1 = edge(b, w1, s);
        for (const [x, y, z] of s > 0 ? [[a, b, p0], [p0, b, p1]] : [[a, p0, b], [p0, p1, b]]) {
          for (const v of [x!, y!, z!]) { positions.push(v.x, v.y, v.z); colors.push(dry * 1.9, dry * 1.18, dry * 1.75); }
        }
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
