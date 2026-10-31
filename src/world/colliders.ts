import { rayAabb3, rayCylinderY, type AABB } from '../core/collision';

export type ColliderTag =
  | 'building'
  | 'wall'
  | 'container'
  | 'tree'
  | 'palm'
  | 'lamp'
  | 'signal'
  | 'hydrant'
  | 'bench'
  | 'bin'
  | 'rock'
  | 'pillar'
  | 'boat'
  /** A sight core buried in a rise (world/terrain.ts): nothing standing on the ground ever reaches one. */
  | 'terrain'
  /** Standing crops (the corn maze): they stop people and slow cars, but hide nothing from sight. */
  | 'crop';

export interface StaticCollider extends AABB {
  id: number;
  circle: boolean;
  cx: number;
  cz: number;
  r: number;
  y0: number;
  y1: number;
  tag: ColliderTag;
  /** Knocked over (and removed from collision) by fast vehicles. */
  breakable: boolean;
  broken: boolean;
  /** Index into CityLayout.props for breakable props, otherwise -1. */
  propIndex: number;
}

export interface RayHit {
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  collider: StaticCollider | null;
}

export function makeRayHit(): RayHit {
  return { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, collider: null };
}

/** Tags that block bullets, cameras and line of sight. */
export function isSolidForSight(c: StaticCollider): boolean {
  return c.tag === 'building' || c.tag === 'wall' || c.tag === 'container' || c.tag === 'pillar' || c.tag === 'boat' || c.tag === 'terrain';
}

/**
 * Uniform grid over static colliders with a DDA ray traversal.
 * Colliders spanning several cells are stored in each of them and
 * de-duplicated per query with a stamp array.
 */
export class StaticGrid {
  readonly colliders: StaticCollider[] = [];
  readonly cols: number;
  readonly rows: number;
  private readonly cells: number[][];
  private stamp = new Uint32Array(1024);
  private stampId = 0;

  constructor(
    readonly minX: number,
    readonly minZ: number,
    readonly maxX: number,
    readonly maxZ: number,
    readonly cell: number,
  ) {
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cell));
    this.rows = Math.max(1, Math.ceil((maxZ - minZ) / cell));
    this.cells = new Array(this.cols * this.rows);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
  }

  addBox(minX: number, minZ: number, maxX: number, maxZ: number, y0: number, y1: number, tag: ColliderTag, propIndex = -1, breakable = false): StaticCollider {
    return this.insert({
      id: this.colliders.length,
      circle: false,
      minX,
      minZ,
      maxX,
      maxZ,
      cx: (minX + maxX) / 2,
      cz: (minZ + maxZ) / 2,
      r: 0,
      y0,
      y1,
      tag,
      breakable,
      broken: false,
      propIndex,
    });
  }

  addCircle(cx: number, cz: number, r: number, y0: number, y1: number, tag: ColliderTag, propIndex = -1, breakable = false): StaticCollider {
    return this.insert({
      id: this.colliders.length,
      circle: true,
      minX: cx - r,
      minZ: cz - r,
      maxX: cx + r,
      maxZ: cz + r,
      cx,
      cz,
      r,
      y0,
      y1,
      tag,
      breakable,
      broken: false,
      propIndex,
    });
  }

  private insert(c: StaticCollider): StaticCollider {
    this.colliders.push(c);
    if (this.stamp.length < this.colliders.length) {
      const s = new Uint32Array(this.stamp.length * 2);
      s.set(this.stamp);
      this.stamp = s;
    }
    const x0 = this.cellX(c.minX);
    const x1 = this.cellX(c.maxX);
    const z0 = this.cellZ(c.minZ);
    const z1 = this.cellZ(c.maxZ);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.cells[z * this.cols + x]!.push(c.id);
    return c;
  }

  private cellX(x: number): number {
    const i = Math.floor((x - this.minX) / this.cell);
    return i < 0 ? 0 : i >= this.cols ? this.cols - 1 : i;
  }

  private cellZ(z: number): number {
    const i = Math.floor((z - this.minZ) / this.cell);
    return i < 0 ? 0 : i >= this.rows ? this.rows - 1 : i;
  }

  private nextStamp(): number {
    this.stampId = (this.stampId + 1) >>> 0;
    if (this.stampId === 0) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    return this.stampId;
  }

  /** Calls `fn` once for every non-broken collider whose bounds overlap the query box. */
  query(minX: number, minZ: number, maxX: number, maxZ: number, fn: (c: StaticCollider) => void): void {
    // Bounds from a body that blew up (NaN or infinite) overlap nothing, rather than every cell or none by accident.
    if (!Number.isFinite(minX + minZ + maxX + maxZ)) return;
    const st = this.nextStamp();
    const x0 = this.cellX(minX);
    const x1 = this.cellX(maxX);
    const z0 = this.cellZ(minZ);
    const z1 = this.cellZ(maxZ);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const list = this.cells[z * this.cols + x]!;
        for (let i = 0; i < list.length; i++) {
          const id = list[i]!;
          if (this.stamp[id] === st) continue;
          this.stamp[id] = st;
          const c = this.colliders[id]!;
          if (c.broken) continue;
          if (c.minX > maxX || c.maxX < minX || c.minZ > maxZ || c.maxZ < minZ) continue;
          fn(c);
        }
      }
    }
  }

  /**
   * Casts a ray (direction must be normalized) against the static colliders.
   * Returns true and fills `out` with the closest hit within `maxDist`.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    out: RayHit,
    filter?: (c: StaticCollider) => boolean,
  ): boolean {
    // A non-finite ray would index the grid with NaN (and throw): it hits nothing.
    if (!Number.isFinite(ox + oy + oz + dx + dy + dz + maxDist)) return false;
    const cs = this.cell;
    const gMaxX = this.minX + this.cols * cs;
    const gMaxZ = this.minZ + this.rows * cs;
    const tEnter = rayAabb3(ox, 0, oz, dx, 0, dz, this.minX, -1, this.minZ, gMaxX, 1, gMaxZ, maxDist);
    if (tEnter < 0) return false;
    const px = ox + dx * tEnter;
    const pz = oz + dz * tEnter;
    let ix = this.cellX(px);
    let iz = this.cellZ(pz);
    const stepX = dx > 1e-12 ? 1 : dx < -1e-12 ? -1 : 0;
    const stepZ = dz > 1e-12 ? 1 : dz < -1e-12 ? -1 : 0;
    let tMaxX = stepX > 0 ? (this.minX + (ix + 1) * cs - ox) / dx : stepX < 0 ? (this.minX + ix * cs - ox) / dx : Infinity;
    let tMaxZ = stepZ > 0 ? (this.minZ + (iz + 1) * cs - oz) / dz : stepZ < 0 ? (this.minZ + iz * cs - oz) / dz : Infinity;
    const tDeltaX = stepX !== 0 ? cs / Math.abs(dx) : Infinity;
    const tDeltaZ = stepZ !== 0 ? cs / Math.abs(dz) : Infinity;

    const st = this.nextStamp();
    let bestT = Infinity;
    let best: StaticCollider | null = null;
    for (let guard = 0; guard < 100000; guard++) {
      const list = this.cells[iz * this.cols + ix]!;
      for (let i = 0; i < list.length; i++) {
        const id = list[i]!;
        if (this.stamp[id] === st) continue;
        this.stamp[id] = st;
        const c = this.colliders[id]!;
        if (c.broken) continue;
        if (filter && !filter(c)) continue;
        const t = c.circle
          ? rayCylinderY(ox, oy, oz, dx, dy, dz, c.cx, c.cz, c.r, c.y0, c.y1, maxDist)
          : rayAabb3(ox, oy, oz, dx, dy, dz, c.minX, c.y0, c.minZ, c.maxX, c.y1, c.maxZ, maxDist);
        if (t >= 0 && t < bestT) {
          bestT = t;
          best = c;
        }
      }
      const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (bestT <= tNext || tNext > maxDist) break;
      if (tMaxX < tMaxZ) {
        ix += stepX;
        if (ix < 0 || ix >= this.cols) break;
        tMaxX += tDeltaX;
      } else {
        iz += stepZ;
        if (iz < 0 || iz >= this.rows) break;
        tMaxZ += tDeltaZ;
      }
    }
    if (!best || bestT > maxDist) return false;
    out.t = bestT;
    out.x = ox + dx * bestT;
    out.y = oy + dy * bestT;
    out.z = oz + dz * bestT;
    out.collider = best;
    computeNormal(best, out);
    return true;
  }

  /** True when no sight-blocking collider lies on the segment between the two points. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, scratch: RayHit): boolean {
    // Nobody sees to or from a non-finite point.
    if (!Number.isFinite(ax + ay + az + bx + by + bz)) return false;
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return true;
    return !this.raycast(ax, ay, az, dx / len, dy / len, dz / len, len, scratch, isSolidForSight);
  }
}

function computeNormal(c: StaticCollider, h: RayHit): void {
  if (c.circle) {
    if (h.y >= c.y1 - 1e-4) {
      h.nx = 0;
      h.ny = 1;
      h.nz = 0;
      return;
    }
    const dx = h.x - c.cx;
    const dz = h.z - c.cz;
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    h.nx = dx / l;
    h.ny = 0;
    h.nz = dz / l;
    return;
  }
  // Pick the face closest to the hit point.
  let bd = Math.abs(h.x - c.minX);
  h.nx = -1;
  h.ny = 0;
  h.nz = 0;
  const face = (d: number, nx: number, ny: number, nz: number) => {
    if (d < bd) {
      bd = d;
      h.nx = nx;
      h.ny = ny;
      h.nz = nz;
    }
  };
  face(Math.abs(h.x - c.maxX), 1, 0, 0);
  face(Math.abs(h.z - c.minZ), 0, 0, -1);
  face(Math.abs(h.z - c.maxZ), 0, 0, 1);
  face(Math.abs(h.y - c.y1), 0, 1, 0);
  face(Math.abs(h.y - c.y0), 0, -1, 0);
}
