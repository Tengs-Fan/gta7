// The countryside's creatures and machines as geometry (each facing +z, up +y, its left +x, its origin at its feet or
// its middle): a crow with wings a shader folds and beats, the dairy's dog, the crop-duster, the combine harvester, the
// hot-air balloon's envelope, basket and flame, and the placeholder poles. The moving ones are rigs (rig.ts).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bar, box, cyl, ModelBuilder } from '../../furniture';
import { RigBuilder } from './rig';
import { ARM_WIRES, PLACEHOLDER_POLES, POLE_H } from './wires';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** A cylinder along z, its `rTop` end at +z. */
const cylZ = (rTop: number, rBot: number, len: number, seg: number, x: number, y: number, z: number) => new THREE.CylinderGeometry(rTop, rBot, len, seg).rotateX(Math.PI / 2).translate(x, y, z);
/** A cylinder along x. */
const cylX = (r: number, len: number, seg: number, x: number, y: number, z: number) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2).translate(x, y, z);
/** An ellipsoid of half-extents (rx, ry, rz) at (x, y, z). */
const ball = (rx: number, ry: number, rz: number, x: number, y: number, z: number, seg = 10) => new THREE.SphereGeometry(1, seg, Math.max(4, seg - 3)).scale(rx, ry, rz).translate(x, y, z);

// ---------------------------------------------------------------------------------------------------------------------
// The crow

/** Where a crow's wing starts out from its body (m) and how far out it reaches. */
export const SHOULDER = 0.05;
const WING = 0.45;

/**
 * A crow, 0.5 m from beak to tail with a metre of wing: the body, head, beak, tail and legs, and a wing either side as a
 * strip of four quads whose vertices carry `aWing`, their distance out along it (0..1; 0 on the body). The crows'
 * material folds and beats the wings by it (crows.ts).
 */
export function crowGeometry(): THREE.BufferGeometry {
  const feather = [0.045, 0.047, 0.058] as const;
  const parts: Array<[THREE.BufferGeometry, readonly number[], number]> = [];
  const solid = (g: THREE.BufferGeometry, c: readonly number[]) => parts.push([g.index ? g.toNonIndexed() : g, c, 0]);
  solid(ball(0.085, 0.085, 0.19, 0, 0.18, 0), [0.055, 0.058, 0.07]);
  solid(ball(0.062, 0.062, 0.07, 0, 0.265, 0.18, 8), [0.05, 0.053, 0.065]);
  solid(new THREE.ConeGeometry(0.03, 0.12, 6).rotateX(Math.PI / 2).translate(0, 0.255, 0.3), [0.14, 0.14, 0.15]);
  solid(new THREE.BoxGeometry(0.14, 0.012, 0.22).rotateX(0.18).translate(0, 0.165, -0.26), feather);
  for (const x of [-0.035, 0.035]) solid(new THREE.BoxGeometry(0.014, 0.12, 0.014).translate(x, 0.06, 0.01), [0.1, 0.09, 0.09]);
  for (const side of [-1, 1]) {
    // The wing's strip: leading and trailing edges at each of five stations, sweeping back and narrowing to the tip.
    const pos: number[] = [];
    const wing: number[] = [];
    const edge = (k: number) => {
      const u = k / 4;
      const taper = 1 - 0.55 * u * u * u;
      return { u, x: side * (SHOULDER + u * WING), zl: (0.09 - 0.1 * u) * taper, zt: (-0.1 - 0.1 * u) * taper };
    };
    for (let k = 0; k < 4; k++) {
      const a = edge(k);
      const b = edge(k + 1);
      const quad: Array<[number, number, number, number]> = [[a.x, 0.2, a.zl, a.u], [b.x, 0.2, b.zl, b.u], [b.x, 0.2, b.zt, b.u], [a.x, 0.2, a.zt, a.u]];
      for (const i of side > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
        pos.push(quad[i]![0], quad[i]![1], quad[i]![2]);
        wing.push(quad[i]![3]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing.map((u) => Math.max(u, 0.01)), 1));
    parts.push([g, feather, 1]);
  }
  const geos = parts.map(([g, c, wing]) => {
    const n = g.getAttribute('position').count;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'aWing') g.deleteAttribute(name);
    g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => c).flat(), 3));
    if (!wing) g.setAttribute('aWing', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
    return g;
  });
  const out = mergeGeometries(geos, false)!;
  geos.forEach((g) => g.dispose());
  out.name = 'crow';
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The dog

/** The dog's parts, for the rig's pose. */
export const DOG_PART = { body: 0, head: 1, tail: 2, legFL: 3, legFR: 4, legBL: 5, legBR: 6 } as const;
/** The head's and tail's pivots, and the hips' (x, y, z). */
export const DOG_NECK = [0, 0.6, 0.32] as const;
export const DOG_TAIL = [0, 0.5, -0.33] as const;
const HIP_Y = 0.33;
const HIPS = { legFL: [0.1, 0.22], legFR: [-0.1, 0.22], legBL: [0.1, -0.22], legBR: [-0.1, -0.22] } as const;

/** A farm collie: black with a white blaze, chest, socks and tail tip, about 0.55 m at the shoulder. */
export function dogGeometry(): THREE.BufferGeometry {
  const black = 0x15161a;
  const white = 0xece9e0;
  const b = new RigBuilder();
  b.add(0, [0, 0, 0], box(0.26, 0.27, 0.62, 0, 0.45, -0.02), black);
  b.add(0, [0, 0, 0], box(0.19, 0.2, 0.14, 0, 0.42, 0.27), white);
  b.add(0, [0, 0, 0], box(0.15, 0.2, 0.15, 0, 0.58, 0.29), black);
  b.add(1, DOG_NECK, box(0.15, 0.15, 0.17, 0, 0.67, 0.42), black);
  b.add(1, DOG_NECK, box(0.08, 0.07, 0.13, 0, 0.635, 0.55), white);
  b.add(1, DOG_NECK, box(0.045, 0.04, 0.025, 0, 0.64, 0.62), 0x0b0b0c);
  for (const s of [-1, 1]) b.add(1, DOG_NECK, new THREE.BoxGeometry(0.04, 0.1, 0.06).rotateZ(-s * 0.3).translate(s * 0.07, 0.78, 0.4), black);
  b.add(2, DOG_TAIL, new THREE.BoxGeometry(0.06, 0.06, 0.34).rotateX(-0.35).translate(0, 0.52, -0.5), black);
  b.add(2, DOG_TAIL, new THREE.BoxGeometry(0.065, 0.065, 0.1).rotateX(-0.35).translate(0, 0.57, -0.69), white);
  (Object.keys(HIPS) as Array<keyof typeof HIPS>).forEach((k, i) => {
    const [x, z] = HIPS[k];
    b.add(3 + i, [x, HIP_Y, z], box(0.07, 0.33, 0.07, x, HIP_Y - 0.165, z), black);
    b.add(3 + i, [x, HIP_Y, z], box(0.074, 0.1, 0.074, x, 0.05, z), white);
  });
  return b.build('dog');
}

// ---------------------------------------------------------------------------------------------------------------------
// The crop-duster

/** The biplane's propeller's pivot: its hub on the nose. */
export const PROP_HUB = [0, 0, 3.4] as const;
/** The spray boom's nozzles (x, y, z) under the lower wing. */
export const NOZZLES: ReadonlyArray<readonly [number, number, number]> = [[-3.1, -0.64, 0.4], [3.1, -0.64, 0.4]];

/** A yellow radial-engined biplane, 8.8 m across and 7 m long, its hopper ahead of the cockpit and a boom under the lower wing. */
export function biplaneGeometry(): THREE.BufferGeometry {
  const red = 0xb92f1b;
  const yellow = 0xeab51c;
  const cream = 0xf0e8d0;
  const grey = 0x484b50;
  const dark = 0x1a1b1e;
  const b = new RigBuilder();
  const body = (g: THREE.BufferGeometry, c: number, shade = 1) => b.add(0, [0, 0, 0], g, c, shade);
  body(cylZ(0.46, 0.12, 6, 12, 0, 0, -0.3), red);
  body(cylZ(0.5, 0.5, 0.9, 16, 0, 0, 2.85), grey);
  body(new THREE.ConeGeometry(0.25, 0.5, 12).rotateX(Math.PI / 2).translate(0, 0, 3.55), 0xb9bdc2);
  body(box(0.62, 0.28, 1.2, 0, 0.55, -0.75), dark);
  body(ball(0.15, 0.16, 0.15, 0, 0.78, -0.75), 0xd9a47e);
  body(ball(0.17, 0.12, 0.17, 0, 0.87, -0.75), 0x4a2f1c);
  body(box(0.6, 0.3, 0.04, 0, 0.74, 0.0), 0x8fb4c4);
  body(box(0.7, 0.36, 1.1, 0, 0.62, 0.8), yellow, 0.9);
  // The wings: the lower one a little shorter and further back, each tipped in red.
  body(box(8.2, 0.09, 1.55, 0, -0.38, 0.35), yellow);
  body(box(8.8, 0.09, 1.55, 0, 1.12, 0.55), yellow);
  for (const s of [-1, 1]) {
    body(box(0.7, 0.095, 1.56, s * 3.95, -0.38, 0.35), red);
    body(box(0.7, 0.095, 1.56, s * 4.25, 1.12, 0.55), red);
    for (const z of [0.0, 0.95]) body(bar(v3(s * 2.4, -0.34, z), v3(s * 2.4, 1.08, z + 0.2), 0.04), dark);
    body(bar(v3(s * 0.28, 0.5, 0.15), v3(s * 1.5, 1.08, 0.5), 0.04), dark);
    body(bar(v3(s * 0.5, -0.1, 0.5), v3(s * 0.95, -1.12, 0.75), 0.05), dark);
    body(cylX(0.42, 0.2, 14, s * 1.0, -1.12, 0.75), dark);
  }
  body(box(2.7, 0.07, 0.95, 0, 0.05, -3.05), red);
  body(box(0.07, 0.95, 0.9, 0, 0.62, -3.1), red);
  body(box(0.06, 0.8, 0.45, 0, 0.58, -3.7), cream);
  body(ball(0.12, 0.12, 0.12, 0, -0.12, -3.35, 6), dark);
  // The spray boom hung under the lower wing, a nozzle at each end.
  body(bar(v3(-3.4, -0.62, 0.4), v3(3.4, -0.62, 0.4), 0.035), grey);
  for (const n of NOZZLES) body(box(0.12, 0.1, 0.12, n[0], n[1] - 0.04, n[2]), dark);
  // The propeller on the nose: two blades.
  b.add(1, PROP_HUB, box(0.15, 2.1, 0.04, 0, 0, 3.42), 0x2a2b2e);
  b.add(1, PROP_HUB, ball(0.12, 0.12, 0.12, 0, 0, 3.4, 6), 0x8a8e93);
  return b.build('biplane');
}

// ---------------------------------------------------------------------------------------------------------------------
// The combine

/** The reel's axis (x, y, z), its radius, and the header's width and the cutter bar's reach in front (z). */
export const REEL = { pivot: [0, 1.95, 5.0] as const, r: 0.9 };
export const HEADER_W = 7.6;

/** A combine harvester, 11 m with its header, 7.6 m across, green with yellow wheels, its reel a rig part. */
export function combineGeometry(): THREE.BufferGeometry {
  const green = 0x2a6a2e;
  const light = 0x4b8a45;
  const grey = 0x7d8184;
  const dark = 0x1b1c1f;
  const yellow = 0xe8b818;
  const b = new RigBuilder();
  const body = (g: THREE.BufferGeometry, c: number, shade = 1) => b.add(0, [0, 0, 0], g, c, shade);
  body(box(3.0, 1.5, 6.2, 0, 1.9, -0.4), green);
  body(box(2.8, 1.3, 4.2, 0, 3.25, -1.4), light);
  body(box(2.4, 1.3, 1.9, 0, 2.55, -4.2), green, 0.85);
  body(box(1.9, 1.7, 1.9, 0, 3.45, 2.0), green);
  body(box(1.8, 1.0, 0.06, 0, 3.55, 2.97), 0x7fa6b4);
  for (const s of [-1, 1]) body(box(0.06, 1.0, 1.4, s * 0.93, 3.55, 2.0), 0x7fa6b4);
  body(box(2.1, 0.12, 2.1, 0, 4.36, 2.0), grey);
  body(ball(0.12, 0.1, 0.12, 0, 4.5, 2.0, 6), 0xf0a020);
  body(box(1.9, 1.1, 1.9, 0, 1.55, 3.55), green, 0.9);
  // The header: a trough across the front, its end plates, the cutter bar's knife along its lip.
  body(box(HEADER_W, 0.5, 1.2, 0, 0.95, 4.7), green, 0.95);
  body(box(HEADER_W, 1.0, 0.1, 0, 1.45, 4.15), green, 0.8);
  body(box(HEADER_W + 0.2, 0.1, 0.45, 0, 0.62, 5.5), grey);
  for (const s of [-1, 1]) body(box(0.1, 1.6, 1.8, s * (HEADER_W / 2), 1.5, 4.85), light);
  // The unloading auger folded along the tank's left side, and the exhaust.
  body(box(0.32, 0.32, 5.4, 1.5, 4.1, 0.2), grey);
  body(cyl(0.1, 0.1, 1.3, 8, 0.9, 3.0, -4.7), dark);
  // Wheels: big drivers at the front, small steerers behind.
  for (const s of [-1, 1]) {
    body(cylX(1.0, 0.65, 16, s * 1.9, 1.0, 1.6), dark);
    body(cylX(0.5, 0.67, 10, s * 1.9, 1.0, 1.6), yellow);
    body(cylX(0.62, 0.45, 12, s * 1.25, 0.62, -3.7), dark);
    body(cylX(0.32, 0.47, 8, s * 1.25, 0.62, -3.7), yellow);
  }
  // The reel: four slats on spokes, turning over the header.
  const [rx, ry, rz] = REEL.pivot;
  b.add(1, REEL.pivot, cylX(0.12, HEADER_W - 0.2, 8, rx, ry, rz), grey);
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    b.add(1, REEL.pivot, box(HEADER_W - 0.3, 0.1, 0.16, rx, ry + Math.cos(a) * REEL.r, rz + Math.sin(a) * REEL.r), yellow, k === 0 ? 1.1 : 0.95);
    for (const s of [-1, 1]) b.add(1, REEL.pivot, bar(v3(s * (HEADER_W / 2 - 0.4), ry, rz), v3(s * (HEADER_W / 2 - 0.4), ry + Math.cos(a) * REEL.r, rz + Math.sin(a) * REEL.r), 0.03), grey);
  }
  return b.build('combine');
}

// ---------------------------------------------------------------------------------------------------------------------
// The balloon

/** Height (m) of the basket's rim, of the burner over the ground, and of the envelope's mouth over the basket's floor. */
export const BALLOON_BURNER_Y = 2.7;
export const BALLOON_MOUTH_Y = 5.2;
const GORES = 16;
const GORE_COLORS = [0xd8452f, 0xf3e5bd, 0x2c7ba3, 0xefb23a] as const;

/** The envelope: a lathed teardrop 17 m across and 20 m tall from its mouth, gores alternating in four colours, a cream band round its middle. */
export function envelopeGeometry(): THREE.BufferGeometry {
  const profile: Array<[number, number]> = [[2.4, 0], [3.6, 1.2], [5.6, 3.2], [7.4, 6], [8.3, 9], [8.5, 11.2], [8.2, 13.5], [7.2, 16], [5.6, 18.2], [3.4, 19.8], [0.2, 20.4]];
  const lathe = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), GORES).toNonIndexed();
  const pos = lathe.getAttribute('position');
  const col: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const gore = Math.floor(((Math.atan2(cx, cz) + Math.PI) / (Math.PI * 2)) * GORES) % GORES;
    c.setHex(cy > 8.2 && cy < 9.9 ? 0xf3e5bd : GORE_COLORS[gore % GORE_COLORS.length]!);
    for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
  }
  lathe.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  lathe.deleteAttribute('uv');
  // The mouth's skirt: a dark band of fabric under the envelope's lip.
  const skirt = new THREE.CylinderGeometry(2.4, 2.0, 1.3, GORES, 1, true).translate(0, -0.65, 0).toNonIndexed();
  skirt.deleteAttribute('uv');
  const dark = new THREE.Color(0x2a2220);
  skirt.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: skirt.getAttribute('position').count }, () => [dark.r, dark.g, dark.b]).flat(), 3));
  const out = mergeGeometries([lathe, skirt], false)!;
  lathe.dispose();
  skirt.dispose();
  out.name = 'balloon-envelope';
  return out;
}

/** The wicker basket on the ground, its corner posts to the burner's frame, the burner, two gas bottles and the cables up to the mouth. */
export function basketGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('basket', box(1.5, 1.0, 1.5, 0, 0.5, 0), 0x8a5f33);
  b.add('rim', box(1.58, 0.1, 1.58, 0, 1.02, 0), 0x6d4a28);
  b.add('bottles', cyl(0.26, 0.26, 0.95, 10, 0.4, 0.1, 0.38), 0xe8e6de);
  b.add('bottles', cyl(0.26, 0.26, 0.95, 10, -0.4, 0.1, -0.38), 0xe8e6de);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.add('post', bar(v3(sx * 0.7, 1.0, sz * 0.7), v3(sx * 0.7, BALLOON_BURNER_Y + 0.5, sz * 0.7), 0.035), 0x9aa0a4);
      b.add('cable', bar(v3(sx * 0.7, BALLOON_BURNER_Y + 0.5, sz * 0.7), v3(sx * 2.2, BALLOON_MOUTH_Y, sz * 2.2), 0.015), 0x6b6560);
    }
  }
  b.add('frame', box(1.5, 0.06, 0.06, 0, BALLOON_BURNER_Y + 0.5, 0), 0x9aa0a4);
  b.add('burner', cyl(0.14, 0.2, 0.55, 10, 0, BALLOON_BURNER_Y - 0.25, 0), 0xb4b8bb);
  return b.build('balloon-basket');
}

/** The burner's flame: a cone 2.4 m tall, white-hot at the foot, to dark (additive) at the tip. */
export function flameGeometry(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.3, 2.4, 8, 1, true).translate(0, 1.2, 0).toNonIndexed();
  g.deleteAttribute('uv');
  const pos = g.getAttribute('position');
  const col: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / 2.4;
    col.push(1.2 * (1 - t) + 0.1, 0.8 * (1 - t) ** 1.5, 0.3 * (1 - t) ** 3);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// ---------------------------------------------------------------------------------------------------------------------
// The placeholder poles

/** The placeholder poles along Creek Road (wires.ts): each a tapered pole with its crossarm and three insulators, in world coordinates. */
export function poleGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  for (const { x, z } of PLACEHOLDER_POLES) {
    b.add('pole', cyl(0.11, 0.17, POLE_H, 8, x, 0, z), 0x4d3a28);
    b.add('arm', box(2.0, 0.12, 0.12, x, POLE_H - 0.75, z), 0x4d3a28);
    for (const dx of ARM_WIRES) b.add('insulator', cyl(0.04, 0.05, 0.16, 6, x + dx, POLE_H - 0.69, z), 0x5a8a8c);
  }
  return b.build('placeholder-poles');
}
