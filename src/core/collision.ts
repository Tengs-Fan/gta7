// 2D collision primitives in the XZ plane plus 3D ray tests against
// extruded shapes. All "contact" results use a normal that points from the
// second shape towards the first one, i.e. the direction in which the first
// shape must move to resolve the overlap.

export interface AABB {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Oriented box. `hw` is the half extent along local X, `hl` along local Z (forward). */
export interface OBB {
  x: number;
  z: number;
  hw: number;
  hl: number;
  h: number;
}

export interface Contact {
  nx: number;
  nz: number;
  depth: number;
  /** Approximate contact point in world space. */
  px: number;
  pz: number;
}

export function makeContact(): Contact {
  return { nx: 0, nz: 0, depth: 0, px: 0, pz: 0 };
}

const corners = new Float64Array(8);

export function obbCorners(o: OBB, out: Float64Array | number[]): void {
  const fx = Math.sin(o.h) * o.hl;
  const fz = Math.cos(o.h) * o.hl;
  const sx = Math.cos(o.h) * o.hw;
  const sz = -Math.sin(o.h) * o.hw;
  out[0] = o.x + fx + sx;
  out[1] = o.z + fz + sz;
  out[2] = o.x + fx - sx;
  out[3] = o.z + fz - sz;
  out[4] = o.x - fx - sx;
  out[5] = o.z - fz - sz;
  out[6] = o.x - fx + sx;
  out[7] = o.z - fz + sz;
}

/** Bounding radius of an OBB in the XZ plane. */
export function obbRadius(o: OBB): number {
  return Math.sqrt(o.hw * o.hw + o.hl * o.hl);
}

/** World-space bounds of an OBB. */
export function obbBounds(o: OBB, out: AABB): AABB {
  const c = Math.abs(Math.cos(o.h));
  const s = Math.abs(Math.sin(o.h));
  const ex = o.hw * c + o.hl * s;
  const ez = o.hw * s + o.hl * c;
  out.minX = o.x - ex;
  out.maxX = o.x + ex;
  out.minZ = o.z - ez;
  out.maxZ = o.z + ez;
  return out;
}

const CONTACT_EPS = 0.03;

/**
 * Separating-axis test between an oriented box and an axis aligned box.
 * The returned normal pushes the OBB out of the AABB.
 */
export function obbVsAabb(o: OBB, b: AABB, out: Contact): boolean {
  const fx = Math.sin(o.h);
  const fz = Math.cos(o.h);
  const sx = Math.cos(o.h);
  const sz = -Math.sin(o.h);
  const bcx = (b.minX + b.maxX) * 0.5;
  const bcz = (b.minZ + b.maxZ) * 0.5;
  const bhx = (b.maxX - b.minX) * 0.5;
  const bhz = (b.maxZ - b.minZ) * 0.5;
  const dx = o.x - bcx;
  const dz = o.z - bcz;

  let best = Infinity;
  let nx = 0;
  let nz = 0;
  let boxFace = true;

  // World X axis.
  let ov = o.hw * Math.abs(sx) + o.hl * Math.abs(fx) + bhx - Math.abs(dx);
  if (ov <= 0) return false;
  best = ov;
  nx = dx >= 0 ? 1 : -1;
  nz = 0;

  // World Z axis.
  ov = o.hw * Math.abs(sz) + o.hl * Math.abs(fz) + bhz - Math.abs(dz);
  if (ov <= 0) return false;
  if (ov < best) {
    best = ov;
    nx = 0;
    nz = dz >= 0 ? 1 : -1;
  }

  // OBB forward axis.
  let dp = dx * fx + dz * fz;
  ov = o.hl + bhx * Math.abs(fx) + bhz * Math.abs(fz) - Math.abs(dp);
  if (ov <= 0) return false;
  if (ov < best - 1e-6) {
    best = ov;
    const sg = dp >= 0 ? 1 : -1;
    nx = fx * sg;
    nz = fz * sg;
    boxFace = false;
  }

  // OBB side axis.
  dp = dx * sx + dz * sz;
  ov = o.hw + bhx * Math.abs(sx) + bhz * Math.abs(sz) - Math.abs(dp);
  if (ov <= 0) return false;
  if (ov < best - 1e-6) {
    best = ov;
    const sg = dp >= 0 ? 1 : -1;
    nx = sx * sg;
    nz = sz * sg;
    boxFace = false;
  }

  out.nx = nx;
  out.nz = nz;
  out.depth = best;

  if (boxFace) {
    // A corner of the OBB penetrates a face of the AABB: deepest OBB corners.
    obbCorners(o, corners);
    averageExtremeCorners(corners, 4, nx, nz, -1, out);
  } else {
    // A corner of the AABB penetrates a face of the OBB.
    corners[0] = b.minX;
    corners[1] = b.minZ;
    corners[2] = b.maxX;
    corners[3] = b.minZ;
    corners[4] = b.maxX;
    corners[5] = b.maxZ;
    corners[6] = b.minX;
    corners[7] = b.maxZ;
    averageExtremeCorners(corners, 4, nx, nz, 1, out);
  }
  return true;
}

/**
 * Picks the corners that are extreme along the normal (min when sign = -1,
 * max when sign = 1) and averages them into the contact point.
 */
function averageExtremeCorners(pts: Float64Array, count: number, nx: number, nz: number, sign: number, out: Contact): void {
  let ext = -Infinity;
  for (let i = 0; i < count; i++) {
    const d = sign * (pts[i * 2]! * nx + pts[i * 2 + 1]! * nz);
    if (d > ext) ext = d;
  }
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const d = sign * (pts[i * 2]! * nx + pts[i * 2 + 1]! * nz);
    if (d >= ext - CONTACT_EPS) {
      sx += pts[i * 2]!;
      sz += pts[i * 2 + 1]!;
      n++;
    }
  }
  out.px = sx / n;
  out.pz = sz / n;
}

const cornersB = new Float64Array(8);
const satAxes = new Float64Array(8);

/** SAT between two oriented boxes. The normal pushes `a` away from `b`. */
export function obbVsObb(a: OBB, b: OBB, out: Contact): boolean {
  const afx = Math.sin(a.h);
  const afz = Math.cos(a.h);
  const asx = Math.cos(a.h);
  const asz = -Math.sin(a.h);
  const bfx = Math.sin(b.h);
  const bfz = Math.cos(b.h);
  const bsx = Math.cos(b.h);
  const bsz = -Math.sin(b.h);
  const dx = a.x - b.x;
  const dz = a.z - b.z;

  // Axes 0,1 belong to B and 2,3 to A.
  satAxes[0] = bfx;
  satAxes[1] = bfz;
  satAxes[2] = bsx;
  satAxes[3] = bsz;
  satAxes[4] = afx;
  satAxes[5] = afz;
  satAxes[6] = asx;
  satAxes[7] = asz;

  let best = Infinity;
  let nx = 0;
  let nz = 0;
  let ownerB = true;
  for (let i = 0; i < 4; i++) {
    const ux = satAxes[i * 2]!;
    const uz = satAxes[i * 2 + 1]!;
    const ra = a.hw * Math.abs(asx * ux + asz * uz) + a.hl * Math.abs(afx * ux + afz * uz);
    const rb = b.hw * Math.abs(bsx * ux + bsz * uz) + b.hl * Math.abs(bfx * ux + bfz * uz);
    const dp = dx * ux + dz * uz;
    const ov = ra + rb - Math.abs(dp);
    if (ov <= 0) return false;
    if (ov < best - 1e-6) {
      best = ov;
      const sg = dp >= 0 ? 1 : -1;
      nx = ux * sg;
      nz = uz * sg;
      ownerB = i < 2;
    }
  }

  out.nx = nx;
  out.nz = nz;
  out.depth = best;
  if (ownerB) {
    // A's corner penetrates B's face.
    obbCorners(a, corners);
    averageExtremeCorners(corners, 4, nx, nz, -1, out);
  } else {
    obbCorners(b, cornersB);
    averageExtremeCorners(cornersB, 4, nx, nz, 1, out);
  }
  return true;
}

/** Circle vs AABB. The normal pushes the circle out of the box. */
export function circleVsAabb(cx: number, cz: number, r: number, b: AABB, out: Contact): boolean {
  const qx = cx < b.minX ? b.minX : cx > b.maxX ? b.maxX : cx;
  const qz = cz < b.minZ ? b.minZ : cz > b.maxZ ? b.maxZ : cz;
  const dx = cx - qx;
  const dz = cz - qz;
  const d2 = dx * dx + dz * dz;
  if (d2 > 1e-12) {
    if (d2 >= r * r) return false;
    const d = Math.sqrt(d2);
    out.nx = dx / d;
    out.nz = dz / d;
    out.depth = r - d;
    out.px = qx;
    out.pz = qz;
    return true;
  }
  // Center inside the box: push out through the nearest face.
  const left = cx - b.minX;
  const right = b.maxX - cx;
  const top = cz - b.minZ;
  const bottom = b.maxZ - cz;
  let m = left;
  out.nx = -1;
  out.nz = 0;
  if (right < m) {
    m = right;
    out.nx = 1;
    out.nz = 0;
  }
  if (top < m) {
    m = top;
    out.nx = 0;
    out.nz = -1;
  }
  if (bottom < m) {
    m = bottom;
    out.nx = 0;
    out.nz = 1;
  }
  out.depth = m + r;
  out.px = cx;
  out.pz = cz;
  return true;
}

const localBox: AABB = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

/** Circle vs OBB. The normal pushes the circle out of the box. */
export function circleVsObb(cx: number, cz: number, r: number, o: OBB, out: Contact): boolean {
  const fx = Math.sin(o.h);
  const fz = Math.cos(o.h);
  const sx = Math.cos(o.h);
  const sz = -Math.sin(o.h);
  const dx = cx - o.x;
  const dz = cz - o.z;
  const lx = dx * sx + dz * sz;
  const lz = dx * fx + dz * fz;
  localBox.minX = -o.hw;
  localBox.minZ = -o.hl;
  localBox.maxX = o.hw;
  localBox.maxZ = o.hl;
  if (!circleVsAabb(lx, lz, r, localBox, out)) return false;
  const nlx = out.nx;
  const nlz = out.nz;
  const plx = out.px;
  const plz = out.pz;
  out.nx = sx * nlx + fx * nlz;
  out.nz = sz * nlx + fz * nlz;
  out.px = o.x + sx * plx + fx * plz;
  out.pz = o.z + sz * plx + fz * plz;
  return true;
}

export function circleVsCircle(ax: number, az: number, ar: number, bx: number, bz: number, br: number, out: Contact): boolean {
  const dx = ax - bx;
  const dz = az - bz;
  const rr = ar + br;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return false;
  const d = Math.sqrt(d2);
  if (d > 1e-9) {
    out.nx = dx / d;
    out.nz = dz / d;
  } else {
    out.nx = 1;
    out.nz = 0;
  }
  out.depth = rr - d;
  out.px = bx + out.nx * br;
  out.pz = bz + out.nz * br;
  return true;
}

export function pointInAabb(x: number, z: number, b: AABB): boolean {
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

export function aabbOverlap(a: AABB, b: AABB): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

/**
 * Ray vs 3D axis aligned box (slab method). Direction need not be normalized;
 * the result is in units of the direction vector. Returns -1 on miss and 0
 * when the origin is inside the box.
 */
export function rayAabb3(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  maxT: number,
): number {
  let tmin = 0;
  let tmax = maxT;
  // X slab
  if (Math.abs(dx) < 1e-12) {
    if (ox < minX || ox > maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Y slab
  if (Math.abs(dy) < 1e-12) {
    if (oy < minY || oy > maxY) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv;
    let t2 = (maxY - oy) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Z slab
  if (Math.abs(dz) < 1e-12) {
    if (oz < minZ || oz > maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv;
    let t2 = (maxZ - oz) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** Ray vs an OBB extruded vertically between y0 and y1. */
export function rayObb3(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  o: OBB, y0: number, y1: number, maxT: number,
): number {
  const fx = Math.sin(o.h);
  const fz = Math.cos(o.h);
  const sx = Math.cos(o.h);
  const sz = -Math.sin(o.h);
  const rx = ox - o.x;
  const rz = oz - o.z;
  const lox = rx * sx + rz * sz;
  const loz = rx * fx + rz * fz;
  const ldx = dx * sx + dz * sz;
  const ldz = dx * fx + dz * fz;
  return rayAabb3(lox, oy, loz, ldx, dy, ldz, -o.hw, y0, -o.hl, o.hw, y1, o.hl, maxT);
}

/**
 * Ray vs vertical capped cylinder centered at (cx, cz). Returns the first
 * intersection distance (in direction units) or -1. Returns 0 if the origin is inside.
 */
export function rayCylinderY(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cz: number, r: number, y0: number, y1: number, maxT: number,
): number {
  const px = ox - cx;
  const pz = oz - cz;
  const inside2d = px * px + pz * pz <= r * r;
  if (inside2d && oy >= y0 && oy <= y1) return 0;
  let best = -1;
  const a = dx * dx + dz * dz;
  if (a > 1e-12) {
    const b = 2 * (px * dx + pz * dz);
    const c = px * px + pz * pz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (let k = 0; k < 2; k++) {
        const t = (-b + (k === 0 ? -sq : sq)) / (2 * a);
        if (t >= 0 && t <= maxT) {
          const y = oy + dy * t;
          if (y >= y0 && y <= y1 && (best < 0 || t < best)) best = t;
        }
      }
    }
  }
  // Caps.
  if (Math.abs(dy) > 1e-12) {
    for (let k = 0; k < 2; k++) {
      const t = ((k === 0 ? y0 : y1) - oy) / dy;
      if (t >= 0 && t <= maxT) {
        const hx = px + dx * t;
        const hz = pz + dz * t;
        if (hx * hx + hz * hz <= r * r && (best < 0 || t < best)) best = t;
      }
    }
  }
  return best;
}

/**
 * Ray vs capsule: the points within `r` of the segment from A to B. Returns the first intersection distance (in
 * direction units) up to `maxT`, 0 if the origin is inside, or -1.
 */
export function rayCapsule(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number, maxT: number,
): number {
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-12)) return -1;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const max = maxT * len;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const oax = ox - ax;
  const oay = oy - ay;
  const oaz = oz - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const r2 = r * r;
  // The origin within r of the segment.
  const h0 = baba > 1e-12 ? Math.min(1, Math.max(0, baoa / baba)) : 0;
  const ix = oax - bax * h0;
  const iy = oay - bay * h0;
  const iz = oaz - baz * h0;
  if (ix * ix + iy * iy + iz * iz <= r2) return 0;
  let best = -1;
  // The side: an infinite cylinder about AB, kept between its end planes.
  const bard = bax * ux + bay * uy + baz * uz;
  const rdoa = ux * oax + uy * oay + uz * oaz;
  const a = baba - bard * bard;
  if (baba > 1e-12 && a > 1e-12) {
    const b = baba * rdoa - baoa * bard;
    const c = baba * oaoa - baoa * baoa - r2 * baba;
    const h = b * b - a * c;
    if (h >= 0) {
      const t = (-b - Math.sqrt(h)) / a;
      const y = baoa + t * bard;
      if (t >= 0 && t <= max && y > 0 && y < baba) best = t;
    }
  }
  // The end caps: spheres at A and B.
  for (let k = 0; k < 2; k++) {
    const cx = k === 0 ? oax : ox - bx;
    const cy = k === 0 ? oay : oy - by;
    const cz = k === 0 ? oaz : oz - bz;
    const b = ux * cx + uy * cy + uz * cz;
    const h = b * b - (cx * cx + cy * cy + cz * cz - r2);
    if (h < 0) continue;
    const t = -b - Math.sqrt(h);
    if (t >= 0 && t <= max && (best < 0 || t < best)) best = t;
  }
  return best < 0 ? -1 : best / len;
}

/** True if the 2D segment AB intersects the box. */
export function segmentHitsAabb(ax: number, az: number, bx: number, bz: number, b: AABB): boolean {
  return rayAabb3(ax, 0, az, bx - ax, 0, bz - az, b.minX, -1, b.minZ, b.maxX, 1, b.maxZ, 1) >= 0;
}
