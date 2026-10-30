// Small geometry accumulator used to merge thousands of boxes and quads into
// a handful of BufferGeometries (one per material).

import * as THREE from 'three';

export type RGB = readonly [number, number, number];

export function hexToRgb(hex: number): RGB {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

export function scaleRgb(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

export type UvMode =
  /** World-space planar mapping with the given metres per texture repeat. */
  | { kind: 'world'; scale: number }
  /** Facade mapping: u along the wall, v up the wall, in units of (w, h) metres. */
  | { kind: 'facade'; w: number; h: number; offU: number; offV: number; baseY: number }
  /** 0..1 over each face. */
  | { kind: 'unit' };

export interface BoxOpts {
  uv: UvMode;
  color?: RGB;
  /** Which faces to emit (default: all except bottom). */
  top?: boolean;
  bottom?: boolean;
  sides?: boolean;
}

export class GeoBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private seeds: number[] = [];
  private idx: number[] = [];
  private n = 0;
  /** Written to the per-vertex float attribute `aSeed` of every vertex added while set (seeded builders only). */
  seed = 0;

  constructor(
    readonly colored = false,
    readonly seeded = false,
  ) {}

  get vertexCount(): number {
    return this.n;
  }

  /** Adds a quad with vertices a, b, c, d in counter-clockwise order seen from the front. */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    uvs: readonly number[],
    color?: RGB,
  ): void {
    // Face normal from the first triangle.
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.n;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 4; i++) this.nrm.push(nx, ny, nz);
    this.uv.push(...uvs);
    if (this.colored) {
      const c = color ?? [1, 1, 1];
      for (let i = 0; i < 4; i++) this.col.push(c[0], c[1], c[2]);
    }
    if (this.seeded) this.seeds.push(this.seed, this.seed, this.seed, this.seed);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.n += 4;
  }

  /** Triangle with explicit uvs. */
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, uvs: readonly number[], color?: RGB): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.n;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) this.nrm.push(nx, ny, nz);
    this.uv.push(...uvs);
    if (this.colored) {
      const c = color ?? [1, 1, 1];
      for (let i = 0; i < 3; i++) this.col.push(c[0], c[1], c[2]);
    }
    if (this.seeded) this.seeds.push(this.seed, this.seed, this.seed);
    this.idx.push(base, base + 1, base + 2);
    this.n += 3;
  }

  /** Horizontal rectangle at height y facing up. */
  flat(minX: number, minZ: number, maxX: number, maxZ: number, y: number, uv: UvMode, color?: RGB): void {
    const uvs = this.planarUv(uv, minX, minZ, maxX, maxZ);
    this.quad(minX, y, maxZ, maxX, y, maxZ, maxX, y, minZ, minX, y, minZ, uvs, color);
  }

  /**
   * Ground over the rectangle following h(x, z): a grid of quads on the world lattice of `step` m (plus the rectangle's
   * own edges), so neighbouring patches meet at the same vertices along their shared edges, with smooth normals from
   * central differences of h. World uvs as flat's; 'unit' spans the rectangle.
   */
  heightGrid(minX: number, minZ: number, maxX: number, maxZ: number, step: number, h: (x: number, z: number) => number, uv: UvMode, color?: RGB): void {
    const lattice = (a: number, b: number) => {
      const out = [a];
      for (let v = (Math.floor(a / step) + 1) * step; v < b - 1e-6; v += step) if (v > a + 1e-6) out.push(v);
      out.push(b);
      return out;
    };
    const xs = lattice(minX, maxX);
    const zs = lattice(minZ, maxZ);
    const base = this.n;
    const e = step / 2;
    const s = uv.kind === 'world' ? 1 / uv.scale : 0;
    for (const z of zs) {
      for (const x of xs) {
        const y = h(x, z);
        this.pos.push(x, y, z);
        const nx = h(x - e, z) - h(x + e, z);
        const nz = h(x, z - e) - h(x, z + e);
        const l = Math.hypot(nx, 2 * e, nz);
        this.nrm.push(nx / l, (2 * e) / l, nz / l);
        if (uv.kind === 'world') this.uv.push(x * s, -z * s);
        else this.uv.push((x - minX) / (maxX - minX), (maxZ - z) / (maxZ - minZ));
        if (this.colored) {
          const c = color ?? [1, 1, 1];
          this.col.push(c[0], c[1], c[2]);
        }
        if (this.seeded) this.seeds.push(this.seed);
      }
    }
    const row = xs.length;
    for (let j = 0; j + 1 < zs.length; j++) {
      for (let i = 0; i + 1 < row; i++) {
        // As flat's quad: (x0, z1), (x1, z1), (x1, z0), (x0, z0), counter-clockwise seen from above.
        const d = base + j * row + i;
        const c = d + 1;
        const a = d + row;
        const b = a + 1;
        this.idx.push(a, b, c, a, c, d);
      }
    }
    this.n += xs.length * zs.length;
  }

  private planarUv(uv: UvMode, minX: number, minZ: number, maxX: number, maxZ: number): number[] {
    if (uv.kind === 'world') {
      const s = 1 / uv.scale;
      return [minX * s, -maxZ * s, maxX * s, -maxZ * s, maxX * s, -minZ * s, minX * s, -minZ * s];
    }
    return [0, 0, 1, 0, 1, 1, 0, 1];
  }

  /** Vertical wall quad from (x0,z0) to (x1,z1), between heights y0 and y1, facing to the right of the direction. */
  wall(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, uv: UvMode, color?: RGB, uStart = 0): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    let uvs: number[];
    if (uv.kind === 'facade') {
      const u0 = uStart / uv.w + uv.offU;
      const u1 = (uStart + len) / uv.w + uv.offU;
      const v0 = (y0 - uv.baseY) / uv.h + uv.offV;
      const v1 = (y1 - uv.baseY) / uv.h + uv.offV;
      uvs = [u0, v0, u1, v0, u1, v1, u0, v1];
    } else if (uv.kind === 'world') {
      const s = 1 / uv.scale;
      uvs = [uStart * s, y0 * s, (uStart + len) * s, y0 * s, (uStart + len) * s, y1 * s, uStart * s, y1 * s];
    } else {
      uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    }
    this.quad(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0, uvs, color);
  }

  /** Axis-aligned box. Side faces face outward. */
  box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, o: BoxOpts): void {
    const sides = o.sides ?? true;
    if (sides) {
      // Walk the footprint counter-clockwise seen from above so each wall faces out.
      const w = maxX - minX;
      const d = maxZ - minZ;
      this.wall(minX, maxZ, maxX, maxZ, minY, maxY, o.uv, o.color, 0); // south (+Z)
      this.wall(maxX, maxZ, maxX, minZ, minY, maxY, o.uv, o.color, w); // east (+X)
      this.wall(maxX, minZ, minX, minZ, minY, maxY, o.uv, o.color, w + d); // north (-Z)
      this.wall(minX, minZ, minX, maxZ, minY, maxY, o.uv, o.color, 2 * w + d); // west (-X)
    }
    if (o.top ?? true) this.flat(minX, minZ, maxX, maxZ, maxY, o.uv.kind === 'facade' ? { kind: 'world', scale: 8 } : o.uv, o.color);
    if (o.bottom) {
      const uvs = this.planarUv(o.uv.kind === 'facade' ? { kind: 'world', scale: 8 } : o.uv, minX, minZ, maxX, maxZ);
      this.quad(minX, minY, minZ, maxX, minY, minZ, maxX, minY, maxZ, minX, minY, maxZ, uvs, o.color);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.colored) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.seeded) g.setAttribute('aSeed', new THREE.Float32BufferAttribute(this.seeds, 1));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
