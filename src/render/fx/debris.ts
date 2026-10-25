// Debris: modelled pieces (bent body panels, bumpers, wheels, crumpled chunks, struts, mirrors) thrown by explosions and
// hard crashes. They fly, tumble, bounce off walls, fall under gravity and settle flat on the ground with their lowest
// point on it, then shrink away. All pieces are one InstancedMesh: its geometry holds every shape, and a per-instance
// shape index collapses the others in the vertex shader, so any mix of pieces is one draw (and one shadow draw).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01 } from './noise';

export const DEBRIS_SHAPES = ['panel', 'bumper', 'wheel', 'chunk', 'strut', 'mirror'] as const;
export type DebrisShape = (typeof DEBRIS_SHAPES)[number];

export const DEBRIS_GRAVITY = 12;

/** The ground and walls a piece moves among (StaticWorld has both). */
export interface DebrisWorld {
  groundHeight(x: number, z: number): number;
  /** Positive where the point is that deep under water: pieces sink out of sight there instead of lying on the seabed. */
  waterDepth?(x: number, z: number): number;
  lineOfSight?(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
}

interface ShapeInfo {
  /** Vertices (local), for the exact lowest point of a turned piece. */
  verts: Float32Array;
  /** Local half extents (bounding box), for laying it on its largest face and its reach. */
  half: THREE.Vector3;
}

function tint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const ni = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(ni.attributes)) if (name !== 'position' && name !== 'normal') ni.deleteAttribute(name);
  const c = new THREE.Color(hex);
  const n = ni.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  ni.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return ni;
}

/** Pushes the vertices of a geometry about by a seeded amount (crumpled metal), keeping faces flat-shaded. */
function crumple(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    // The same displacement for the same corner wherever it repeats (non-indexed), so no cracks open.
    const k = Math.round(p.getX(i) * 997) * 31 + Math.round(p.getY(i) * 991) * 17 + Math.round(p.getZ(i) * 983) + seed;
    p.setXYZ(i, p.getX(i) + (hash01(k) - 0.5) * amount, p.getY(i) + (hash01(k + 1) - 0.5) * amount, p.getZ(i) + (hash01(k + 2) - 0.5) * amount);
  }
  g.computeVertexNormals();
  return g;
}

function panel(): THREE.BufferGeometry {
  // A hood or door skin, bent across and crumpled at one corner.
  const g = new THREE.BoxGeometry(1.0, 0.035, 0.72, 5, 1, 3).toNonIndexed();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    p.setY(i, p.getY(i) + 0.13 * Math.cos((x / 1.0) * Math.PI) - 0.06 * Math.max(0, x + z) ** 2);
  }
  return tint(crumple(g, 0.025, 3), 0xffffff);
}

function bumper(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1.4, 0.14, 0.18, 6, 1, 1).toNonIndexed();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setY(i, p.getY(i) - 0.22 * (x / 0.7) ** 2);
  }
  return tint(crumple(g, 0.02, 5), 0xffffff);
}

function wheel(): THREE.BufferGeometry {
  // A burnt tyre round a bare rim, lying flat (axis up).
  const tyre = new THREE.CylinderGeometry(0.33, 0.33, 0.2, 14, 1, true);
  const wall = new THREE.RingGeometry(0.2, 0.33, 14, 1).rotateX(-Math.PI / 2).translate(0, 0.1, 0);
  const wall2 = new THREE.RingGeometry(0.2, 0.33, 14, 1).rotateX(Math.PI / 2).translate(0, -0.1, 0);
  const rim = new THREE.CylinderGeometry(0.2, 0.2, 0.16, 10);
  const hub = new THREE.CylinderGeometry(0.07, 0.07, 0.19, 8);
  const m = mergeGeometries([tint(tyre, 0x1a1816), tint(wall, 0x221f1c), tint(wall2, 0x221f1c), tint(rim, 0x6a655e), tint(hub, 0x3a3632)], false)!;
  return m;
}

function chunk(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.22, 0).scale(1.2, 0.55, 0.9).toNonIndexed();
  return tint(crumple(g, 0.09, 7), 0xffffff);
}

function strut(): THREE.BufferGeometry {
  // A bent exhaust pipe or axle: two tubes at an angle.
  const a = new THREE.CylinderGeometry(0.035, 0.035, 0.55, 7).rotateZ(Math.PI / 2 - 0.35).translate(-0.24, 0.05, 0);
  const b = new THREE.CylinderGeometry(0.035, 0.035, 0.45, 7).rotateZ(Math.PI / 2 + 0.3).translate(0.24, 0.04, 0);
  return mergeGeometries([tint(a, 0x8a857c), tint(b, 0x8a857c)], false)!;
}

function mirror(): THREE.BufferGeometry {
  const shell = new THREE.BoxGeometry(0.2, 0.11, 0.07, 2, 1, 1);
  const glass = new THREE.PlaneGeometry(0.17, 0.08).translate(0, 0, 0.0355);
  return mergeGeometries([tint(crumple(shell.toNonIndexed(), 0.012, 9), 0xffffff), tint(glass, 0x8fa0aa)], false)!;
}

const BUILD: Record<DebrisShape, () => THREE.BufferGeometry> = { panel, bumper, wheel, chunk, strut, mirror };

let shared: { geometry: THREE.BufferGeometry; info: ShapeInfo[] } | null = null;

/** Every debris shape in one geometry, each vertex tagged with its shape index (aShape). */
export function debrisGeometry(): { geometry: THREE.BufferGeometry; info: ShapeInfo[] } {
  if (shared) return shared;
  const parts: THREE.BufferGeometry[] = [];
  const info: ShapeInfo[] = [];
  DEBRIS_SHAPES.forEach((name, k) => {
    const g = BUILD[name]();
    const n = g.getAttribute('position').count;
    g.setAttribute('aShape', new THREE.BufferAttribute(new Float32Array(n).fill(k), 1));
    g.computeBoundingBox();
    const b = g.boundingBox!;
    const half = new THREE.Vector3().subVectors(b.max, b.min).multiplyScalar(0.5);
    const c = b.getCenter(new THREE.Vector3());
    // Centred on its box, so it turns about its middle.
    g.translate(-c.x, -c.y, -c.z);
    info.push({ verts: (g.getAttribute('position') as THREE.BufferAttribute).array.slice() as Float32Array, half });
    parts.push(g);
  });
  const geometry = mergeGeometries(parts, false)!;
  geometry.computeBoundingSphere();
  shared = { geometry, info };
  return shared;
}

const SHAPE_PATCH = {
  vertex(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aShape;\nattribute float iShape;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  if (abs(aShape - iShape) > 0.5) transformed = vec3(0.0);');
  },
};

interface Piece {
  shape: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  spin: THREE.Vector3;
  scale: number;
  color: THREE.Color;
  age: number;
  life: number;
  fade: number;
  resting: boolean;
  ground: (x: number, z: number) => number;
  world: DebrisWorld | null;
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export class Debris {
  readonly mesh: THREE.InstancedMesh;
  /** Its shadow-pass material (the same shape patch on a depth material). */
  readonly depth: THREE.MeshDepthMaterial;
  private readonly pieces: Piece[] = [];
  private readonly free: Piece[] = [];
  private readonly info: ShapeInfo[];
  private readonly iShape: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly e = new THREE.Vector3();
  private cap: number;

  constructor(readonly max: number) {
    const { geometry, info } = debrisGeometry();
    this.info = info;
    const geo = geometry.clone();
    this.iShape = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iShape', this.iShape);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.35, vertexColors: true });
    mat.name = 'fx-debris';
    mat.onBeforeCompile = SHAPE_PATCH.vertex;
    mat.customProgramCacheKey = () => 'fx-debris-shape';
    this.depth = new THREE.MeshDepthMaterial();
    this.depth.name = 'fx-debris-depth';
    this.depth.onBeforeCompile = SHAPE_PATCH.vertex;
    this.depth.customProgramCacheKey = () => 'fx-debris-shape';
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.customDepthMaterial = this.depth;
    // Creates the colour attribute up front, so the shader compiled at warm-up is the one used later.
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'fx-debris';
    this.cap = max;
    for (let i = 0; i < max; i++) {
      this.free.push({ shape: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), spin: new THREE.Vector3(), scale: 1, color: new THREE.Color(), age: 0, life: 0, fade: 1, resting: false, ground: () => 0, world: null });
    }
  }

  setCap(cap: number, shadows: boolean): void {
    this.cap = Math.max(1, Math.min(this.max, cap));
    while (this.pieces.length > this.cap) this.free.push(this.pieces.shift()!);
    this.mesh.castShadow = shadows;
  }

  get capacity(): number {
    return this.cap;
  }

  get active(): number {
    return this.pieces.length;
  }

  /** Pieces thrown so far that have come to rest. */
  get resting(): number {
    let n = 0;
    for (const p of this.pieces) if (p.resting) n++;
    return n;
  }

  /**
   * Throws a piece of `shape` from (x, y, z) at velocity v, tumbling at `spin` (rad/s per axis), scaled by `scale`,
   * coloured `color` (linear, multiplied into the shape's own tones), for `life` s then a `fade` s shrink. A full pool
   * recycles its oldest piece.
   */
  spawn(shape: DebrisShape, x: number, y: number, z: number, vx: number, vy: number, vz: number, spin: THREE.Vector3, scale: number, color: THREE.Color, life: number, fade: number, world: DebrisWorld | ((x: number, z: number) => number)): void {
    if (!Number.isFinite(x + y + z + vx + vy + vz)) return;
    const p = this.pieces.length >= this.cap ? this.pieces.shift()! : this.free.pop() ?? this.pieces.shift()!;
    p.shape = DEBRIS_SHAPES.indexOf(shape);
    p.pos.set(x, y, z);
    p.vel.set(vx, vy, vz);
    p.quat.setFromAxisAngle(this.axis.set(spin.x, spin.y + 1e-3, spin.z).normalize(), (spin.x + spin.z) * 0.37);
    p.spin.copy(spin);
    p.scale = scale;
    p.color.copy(color);
    p.age = 0;
    p.life = life;
    p.fade = fade;
    p.resting = false;
    if (typeof world === 'function') {
      p.ground = world;
      p.world = null;
    } else {
      p.world = world;
      p.ground = (gx, gz) => {
        const h = world.groundHeight(gx, gz);
        const d = world.waterDepth?.(gx, gz) ?? -1;
        // Over water a piece goes down to just under the surface and lies there, out of sight, until it fades.
        return d > 0.6 ? h + d - 0.6 : h;
      };
    }
    this.pieces.push(p);
  }

  /** How far the lowest vertex of a piece is below its centre, as it is turned and scaled now. */
  lowest(p: { shape: number; quat: THREE.Quaternion; scale: number }): number {
    this.m.makeRotationFromQuaternion(p.quat);
    const e = this.m.elements;
    const v = this.info[p.shape]!.verts;
    let min = Infinity;
    for (let i = 0; i < v.length; i += 3) {
      const y = e[1]! * v[i]! + e[5]! * v[i + 1]! + e[9]! * v[i + 2]!;
      if (y < min) min = y;
    }
    return -min * p.scale;
  }

  /** The ground under a piece: the highest of its centre and four points round it (it rests on a kerb's lip, not in it). */
  private floorUnder(p: Piece): number {
    const r = Math.max(this.info[p.shape]!.half.x, this.info[p.shape]!.half.z) * p.scale * 0.7;
    const { x, z } = p.pos;
    return Math.max(p.ground(x, z), p.ground(x + r, z), p.ground(x - r, z), p.ground(x, z + r), p.ground(x, z - r));
  }

  /** Rotation that lays a piece on its largest face: its thinnest local axis turned straight up or down. */
  private flatten(p: Piece): THREE.Quaternion {
    this.m.makeRotationFromQuaternion(p.quat);
    const e = this.m.elements;
    const h = this.info[p.shape]!.half;
    const size = [h.x, h.y, h.z];
    let k = 0;
    for (let i = 1; i < 3; i++) if (size[i]! < size[k]!) k = i;
    this.axis.set(e[k * 4]!, e[k * 4 + 1]!, e[k * 4 + 2]!).normalize();
    return this.q.setFromUnitVectors(this.axis, e[k * 4 + 1]! >= 0 ? UP : DOWN).multiply(p.quat);
  }

  update(dt: number): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i]!;
      p.age += dt;
      if (p.age >= p.life + p.fade) {
        this.free.push(p);
        this.pieces.splice(i, 1);
        continue;
      }
      if (dt <= 0) continue;
      if (!p.resting) {
        p.vel.y -= DEBRIS_GRAVITY * dt;
        const nx = p.pos.x + p.vel.x * dt;
        const ny = p.pos.y + p.vel.y * dt;
        const nz = p.pos.z + p.vel.z * dt;
        // Walls: a piece that would pass into one bounces back off it instead.
        if (p.world?.lineOfSight && !p.world.lineOfSight(p.pos.x, p.pos.y, p.pos.z, nx, ny, nz)) {
          p.vel.x *= -0.35;
          p.vel.z *= -0.35;
          p.pos.y = ny;
        } else {
          p.pos.set(nx, ny, nz);
        }
        const w = p.spin.length();
        if (w > 1e-6) p.quat.premultiply(this.q.setFromAxisAngle(this.axis.copy(p.spin).divideScalar(w), w * dt));
      } else {
        // Settle flat on the ground.
        p.quat.slerp(this.flatten(p), 1 - Math.exp(-12 * dt));
      }
      const floor = this.floorUnder(p) + this.lowest(p);
      if (p.pos.y < floor || p.resting) {
        p.pos.y = floor;
        if (!p.resting) {
          if (p.vel.y < 0) p.vel.y = -p.vel.y * 0.3;
          p.vel.x *= 0.6;
          p.vel.z *= 0.6;
          p.spin.multiplyScalar(0.5);
          if (Math.hypot(p.vel.x, p.vel.z) < 0.8 && p.vel.y < 1.4) {
            p.resting = true;
            p.vel.set(0, 0, 0);
            p.spin.set(0, 0, 0);
          }
        }
      }
    }
    let n = 0;
    for (const p of this.pieces) {
      const k = p.age > p.life ? Math.max(0, 1 - (p.age - p.life) / p.fade) : 1;
      const sc = Math.max(1e-4, k) * p.scale;
      this.m.compose(p.pos, p.quat, this.s.set(sc, sc, sc));
      // A shrinking resting piece keeps its lowest point on the ground.
      if (k < 1 && p.resting) this.m.elements[13] = p.pos.y - this.lowest(p) * (1 - k);
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, p.color);
      this.iShape.setX(n, p.shape);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.iShape.needsUpdate = true;
  }

  /** World lowest point, centre and ground height of each live piece (tests and the debug hook). */
  probe(): Array<{ shape: DebrisShape; x: number; y: number; z: number; low: number; ground: number; resting: boolean; age: number }> {
    return this.pieces.map((p) => ({ shape: DEBRIS_SHAPES[p.shape]!, x: p.pos.x, y: p.pos.y, z: p.pos.z, low: p.pos.y - this.lowest(p), ground: p.ground(p.pos.x, p.pos.z), resting: p.resting, age: p.age }));
  }

  clear(): void {
    while (this.pieces.length) this.free.push(this.pieces.pop()!);
    this.mesh.count = 0;
  }

  /** Scratch for callers building spin vectors without allocating. */
  get scratch(): THREE.Vector3 {
    return this.e;
  }
}
