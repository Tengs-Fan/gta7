// Shared, opaque foliage geometry: detailed silhouettes stay in one instanced draw per material.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';

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

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts, false);
  if (!geometry) throw new Error('Foliage geometry attributes must match');
  for (const part of parts) part.dispose();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

const broadleafCache = new Map<BroadleafKind, { geometry: THREE.BufferGeometry; samples: number[] }>();

function broadleaf(kind: BroadleafKind): { geometry: THREE.BufferGeometry; samples: number[] } {
  const cached = broadleafCache.get(kind);
  if (cached) return cached;
  const parts = broadleafClusters(kind).map(({ scale, at }, cluster) => {
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const p = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const colors: number[] = [];
    const n = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      // Irregular scalloped lobes, always inside the cluster envelope. Smooth normals give a leafy
      // mass its soft lighting, while each lobe's form and dappled colour break up the sphere.
      const ripple = Math.sin(x * 8 + cluster * 1.7) * Math.sin(z * 7 - y * 5 + cluster);
      const radius = 0.91 + 0.085 * ripple;
      p.setXYZ(i, at[0] + x * scale[0] * radius, at[1] + y * scale[1] * radius, at[2] + z * scale[2] * radius);
      n.set(x / scale[0], y / scale[1], z / scale[2]).normalize();
      normal.setXYZ(i, n.x, n.y, n.z);
      const shade = 0.75 + y * 0.16 + ripple * 0.10 + Math.sin(cluster * 2.3) * 0.055;
      colors.push(shade * (1.02 + y * 0.045), shade, shade * (0.86 - y * 0.025));
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geometry;
  });
  const geometry = merge(parts);
  const positions = geometry.getAttribute('position');
  const samples: number[] = [];
  const seen = new Set<string>();
  // Include every rendered corner and a quarter-edge barycentric grid. Sampling the real surface
  // keeps reset-camera clearance honest even when the crown shape changes.
  const add = (x: number, y: number, z: number): void => {
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    if (!seen.has(key)) { seen.add(key); samples.push(x, y, z); }
  };
  for (let i = 0; i < positions.count; i += 3) {
    for (let a = 0; a <= 4; a++) {
      for (let b = 0; b <= 4 - a; b++) {
        const u = a / 4, v = b / 4, w = 1 - u - v;
        add(positions.getX(i) * u + positions.getX(i + 1) * v + positions.getX(i + 2) * w,
          positions.getY(i) * u + positions.getY(i + 1) * v + positions.getY(i + 2) * w,
          positions.getZ(i) * u + positions.getZ(i + 1) * v + positions.getZ(i + 2) * w);
      }
    }
  }
  const value = { geometry, samples };
  broadleafCache.set(kind, value);
  return value;
}

export function broadleafGeometry(kind: BroadleafKind): THREE.BufferGeometry {
  return broadleaf(kind).geometry.clone();
}

export function broadleafSamples(kind: BroadleafKind): readonly number[] {
  return broadleaf(kind).samples;
}

let leafTexture: THREE.CanvasTexture | null = null;

/** A repeating canopy of overlapping leaves; opaque so clustered trees need no transparency sorting. */
export function broadleafTexture(): THREE.CanvasTexture {
  if (leafTexture) return leafTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const rng = new Rng(683);
  ctx.fillStyle = '#7b8570';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1100; i++) {
    const x = rng.range(0, 256), y = rng.range(0, 256);
    const length = rng.range(3.5, 8.0), width = length * rng.range(0.32, 0.49);
    const angle = rng.range(0, Math.PI * 2);
    const value = rng.int(145, 241);
    // Wrap the marks themselves at every edge; a mipmapped seam cannot reveal the sphere's UVs.
    for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) {
      if (x + ox < -10 || x + ox > 266 || y + oy < -10 || y + oy > 266) continue;
      ctx.save();
      ctx.translate(x + ox, y + oy); ctx.rotate(angle);
      ctx.fillStyle = 'rgba(31,43,24,0.24)';
      ctx.beginPath(); ctx.ellipse(0.8, 1.1, length + 0.8, width + 0.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgb(${value},${Math.min(255, value + 4)},${value - 12})`;
      ctx.beginPath(); ctx.ellipse(0, 0, length, width, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(242,248,207,0.15)'; ctx.lineWidth = 0.65;
      ctx.beginPath(); ctx.moveTo(-length * 0.75, 0); ctx.lineTo(length * 0.75, 0); ctx.stroke();
      ctx.restore();
    }
  }
  leafTexture = new THREE.CanvasTexture(canvas);
  leafTexture.colorSpace = THREE.SRGBColorSpace;
  leafTexture.wrapS = leafTexture.wrapT = THREE.RepeatWrapping;
  leafTexture.anisotropy = 4;
  return leafTexture;
}

function bark(geometry: THREE.BufferGeometry, palm: boolean): THREE.BufferGeometry {
  const p = geometry.getAttribute('position');
  const colors: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const around = Math.atan2(p.getX(i), p.getZ(i));
    const grain = Math.sin(around * 9 + y * 0.9) * 0.055;
    const ring = palm ? Math.cos(y * Math.PI * 4) * 0.11 : 0;
    const shade = 0.85 + grain + ring;
    colors.push(shade, shade * 0.94, shade * 0.84);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function branch(from: Point, to: Point, bottom: number, top: number): THREE.BufferGeometry {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(top, bottom, d.length(), 7).toNonIndexed();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return bark(g, false);
}

export function treeTrunkGeometry(): THREE.BufferGeometry {
  return merge([
    branch([0, 0, 0], [0, 4.1, 0], 0.26, 0.085),
    branch([0, 2.85, 0], [-0.85, 4.18, 0.25], 0.10, 0.025),
    branch([0, 3.05, 0], [0.82, 4.45, 0.45], 0.095, 0.025),
    branch([0, 3.35, 0], [0.02, 4.75, -0.85], 0.075, 0.02),
  ]);
}

export function palmTrunkGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.14, 0.24, 8.5, 10, 34).translate(0, 4.25, 0);
  const p = trunk.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    // Shallow rings remain inside the original 0.3 m collider, including at the broad base.
    const ridge = 1 + 0.045 * Math.cos(p.getY(i) * Math.PI * 4);
    p.setXYZ(i, p.getX(i) * ridge, p.getY(i), p.getZ(i) * ridge);
  }
  trunk.computeVertexNormals();
  const crown = new THREE.CylinderGeometry(0.23, 0.28, 0.65, 10).translate(0, 8.38, 0);
  return merge([bark(trunk.toNonIndexed(), true), bark(crown.toNonIndexed(), false)]);
}

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
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
