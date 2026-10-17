// Mesh building blocks for vehicle bodies: a bevelled prism extruded from a side profile whose sides and caps are
// finely subdivided (so dents can bend them), boxes and rings merged into the same geometry, and a vertex shade
// (colour) attribute that darkens interiors, window backings and wheel wells inside one draw call.

import * as THREE from 'three';

/** A point in a side profile: [s along the length (front +), t height above the ground]. */
export type Pt = [number, number];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Collects non-indexed triangles with uvs and a grey shade, then builds one BufferGeometry with flat normals. */
export class GeoBuilder {
  private readonly pos: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];

  /** Adds a triangle; corners are world positions [x, y, z] with uvs [u, v]. */
  tri(a: readonly number[], b: readonly number[], c: readonly number[], ua: readonly number[], ub: readonly number[], uc: readonly number[], shade: number): void {
    this.pos.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, c[0]!, c[1]!, c[2]!);
    this.uv.push(ua[0]!, ua[1]!, ub[0]!, ub[1]!, uc[0]!, uc[1]!);
    for (let i = 0; i < 3; i++) this.col.push(shade, shade, shade);
  }

  /** Adds every triangle of `g` (indexed or not) transformed by `m`. */
  geometry(g: THREE.BufferGeometry, m: THREE.Matrix4, shade: number): void {
    const p = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    const index = g.getIndex();
    const n = index ? index.count : p.count;
    for (let i = 0; i < n; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      _a.fromBufferAttribute(p, ia).applyMatrix4(m);
      _b.fromBufferAttribute(p, ib).applyMatrix4(m);
      _c.fromBufferAttribute(p, ic).applyMatrix4(m);
      const u = (k: number): number[] => (uv ? [uv.getX(k), uv.getY(k)] : [0, 0]);
      this.tri([_a.x, _a.y, _a.z], [_b.x, _b.y, _b.z], [_c.x, _c.y, _c.z], u(ia), u(ib), u(ic), shade);
    }
  }

  /** An axis-aligned box from (x0, y0, z0) to (x1, y1, z1), optionally tilted about X through its bottom centre. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, shade: number, tilt = 0): void {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate(0, (y1 - y0) / 2, 0);
    const m = new THREE.Matrix4().makeTranslation((x0 + x1) / 2, y0, (z0 + z1) / 2).multiply(new THREE.Matrix4().makeRotationX(tilt));
    this.geometry(g, m, shade);
    g.dispose();
  }

  /**
   * A bar along the profile edge p -> q (extended by `extend` at both ends) across x0..x1, `thickness` thick and
   * centred `offset` outward from the edge (outward for a counter-clockwise profile).
   */
  bar(x0: number, x1: number, p: Pt, q: Pt, thickness: number, offset: number, shade: number, extend = 0): void {
    const ds = q[0] - p[0];
    const dt = q[1] - p[1];
    const len = Math.hypot(ds, dt);
    if (len < 1e-6) return;
    const g = new THREE.BoxGeometry(x1 - x0, len + extend * 2, thickness);
    const ns = dt / len;
    const nt = -ds / len;
    const m = new THREE.Matrix4()
      .makeTranslation((x0 + x1) / 2, (p[1] + q[1]) / 2 + nt * offset, (p[0] + q[0]) / 2 + ns * offset)
      .multiply(new THREE.Matrix4().makeRotationX(Math.atan2(ds, dt)));
    this.geometry(g, m, shade);
    g.dispose();
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

function signedArea(pts: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Splits every edge of the closed polygon so that none is longer than `maxEdge`. */
export function resample(pts: readonly Pt[], maxEdge: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-6) continue;
    const n = Math.max(1, Math.ceil(len / maxEdge - 1e-9));
    for (let k = 0; k < n; k++) out.push([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n]);
  }
  return out;
}

export function pointInPolygon(s: number, t: number, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > t !== b[1] > t && s < ((b[0] - a[0]) * (t - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distToPolygon(s: number, t: number, poly: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((s - a[0]) * dx + (t - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(s - a[0] - dx * k, t - a[1] - dy * k));
  }
  return best;
}

/**
 * Interior points on a grid of `spacing` (slightly jittered, so no four are cocircular), inside `outer`, outside every
 * hole and at least 0.4 spacing from every edge.
 */
function steinerPoints(outer: readonly Pt[], holes: readonly (readonly Pt[])[], spacing: number): Pt[] {
  let minS = Infinity;
  let maxS = -Infinity;
  let minT = Infinity;
  let maxT = -Infinity;
  for (const p of outer) {
    minS = Math.min(minS, p[0]);
    maxS = Math.max(maxS, p[0]);
    minT = Math.min(minT, p[1]);
    maxT = Math.max(maxT, p[1]);
  }
  const out: Pt[] = [];
  const clear = spacing * 0.4;
  let k = 0;
  for (let s = minS + spacing / 2; s < maxS; s += spacing) {
    for (let t = minT + spacing / 2; t < maxT; t += spacing) {
      // Deterministic jitter of up to 6% of the spacing.
      k++;
      const js = s + spacing * 0.06 * Math.sin(k * 12.9898);
      const jt = t + spacing * 0.06 * Math.sin(k * 78.233);
      if (!pointInPolygon(js, jt, outer) || distToPolygon(js, jt, outer) < clear) continue;
      if (holes.some((h) => pointInPolygon(js, jt, h) || distToPolygon(js, jt, h) < clear)) continue;
      out.push([js, jt]);
    }
  }
  return out;
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Positive when d lies inside the circumcircle of the counter-clockwise triangle abc. */
function inCircle(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const ax = a[0] - d[0];
  const ay = a[1] - d[1];
  const bx = b[0] - d[0];
  const by = b[1] - d[1];
  const cx = c[0] - d[0];
  const cy = c[1] - d[1];
  return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
}

/**
 * Constrained Delaunay triangulation of a polygon with holes plus interior points, keeping every outline vertex (no
 * T-junctions with the side walls built on the same outline). Earcut triangulates the outline, boundary points it
 * dropped as collinear are put back, then the interior points are inserted one by one with Lawson flips; outline and
 * hole edges never flip. Returns counter-clockwise index triples into [...outer, ...holes, ...inner].
 */
export function triangulateCDT(outer: readonly Pt[], holes: readonly (readonly Pt[])[], inner: readonly Pt[]): Array<[number, number, number]> {
  const pts: Pt[] = [...outer, ...holes.flat(), ...inner];
  const N = pts.length;
  const rings: number[][] = [];
  let base = 0;
  for (const ring of [outer, ...holes]) {
    rings.push(ring.map((_, i) => base + i));
    base += ring.length;
  }
  const constraint = new Set<number>();
  const ekey = (a: number, b: number): number => (a < b ? a * N + b : b * N + a);
  for (const r of rings) for (let i = 0; i < r.length; i++) constraint.add(ekey(r[i]!, r[(i + 1) % r.length]!));

  const tris: Array<[number, number, number]> = [];
  const edges = new Map<number, number>();
  const put = (t: [number, number, number], id = tris.length): void => {
    const [a, b, c] = t;
    tris[id] = t;
    edges.set(a * N + b, id);
    edges.set(b * N + c, id);
    edges.set(c * N + a, id);
  };
  const drop = (id: number): void => {
    const [a, b, c] = tris[id]!;
    for (const k of [a * N + b, b * N + c, c * N + a]) if (edges.get(k) === id) edges.delete(k);
  };
  const ccw = (a: number, b: number, c: number): [number, number, number] => (orient(pts[a]!, pts[b]!, pts[c]!) > 0 ? [a, b, c] : [a, c, b]);

  // Outline triangulation; restore outline vertices earcut skipped on straight runs.
  const faces = THREE.ShapeUtils.triangulateShape(
    outer.map((p) => new THREE.Vector2(p[0], p[1])),
    holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1]))),
  );
  const boundary = base;
  /**
   * Outline and hole vertices lying strictly inside the segment u-v, ordered from u: earcut drops vertices on straight
   * runs and next to the bridges it cuts to holes, which would leave T-junctions with the side walls.
   */
  const onSegment = (u: number, v: number): number[] => {
    const a = pts[u]!;
    const b = pts[v]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const out: Array<[number, number]> = [];
    for (let m = 0; m < boundary; m++) {
      if (m === u || m === v) continue;
      const p = pts[m]!;
      const k = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
      if (k <= 1e-9 || k >= 1 - 1e-9) continue;
      if (Math.abs(orient(a, b, p)) > 1e-9 * Math.max(1, l2)) continue;
      out.push([k, m]);
    }
    return out.sort((p, q) => p[0] - q[0]).map((e) => e[1]);
  };
  const queue: Array<[number, number, number]> = faces.map((f) => ccw(f[0]!, f[1]!, f[2]!));
  while (queue.length > 0) {
    const tri = queue.pop()!;
    if (Math.abs(orient(pts[tri[0]]!, pts[tri[1]]!, pts[tri[2]]!)) < 1e-12) continue;
    // Split along an edge that passes through skipped vertices (a fan from the opposite corner); the new triangles
    // are checked again for their other edges.
    let split = false;
    for (let e = 0; e < 3 && !split; e++) {
      const u = tri[e]!;
      const v = tri[(e + 1) % 3]!;
      const w = tri[(e + 2) % 3]!;
      const mids = onSegment(u, v);
      if (mids.length === 0) continue;
      const chain = [u, ...mids, v];
      for (let i = 0; i < chain.length - 1; i++) queue.push(ccw(chain[i]!, chain[i + 1]!, w));
      split = true;
    }
    if (!split) put(tri);
  }

  // Lawson flips: make every non-constraint edge locally Delaunay.
  const stack: Array<[number, number]> = [];
  const legalize = (): void => {
    let guard = 0;
    while (stack.length > 0 && guard++ < 200000) {
      const [a, b] = stack.pop()!;
      if (constraint.has(ekey(a, b))) continue;
      const t1 = edges.get(a * N + b);
      const t2 = edges.get(b * N + a);
      if (t1 === undefined || t2 === undefined) continue;
      const T1 = tris[t1]!;
      const T2 = tris[t2]!;
      const c = T1.find((x) => x !== a && x !== b)!;
      const d = T2.find((x) => x !== a && x !== b)!;
      const pa = pts[a]!;
      const pb = pts[b]!;
      const pc = pts[c]!;
      const pd = pts[d]!;
      // T1 = (a, b, c) and T2 = (b, a, d), both counter-clockwise.
      if (inCircle(pa, pb, pc, pd) <= 1e-12) continue;
      if (orient(pa, pd, pc) <= 1e-12 || orient(pd, pb, pc) <= 1e-12) continue;
      drop(t1);
      drop(t2);
      put([a, d, c], t1);
      put([d, b, c], t2);
      stack.push([a, d], [d, b], [b, c], [c, a]);
    }
  };
  for (let id = 0; id < tris.length; id++) {
    const [a, b, c] = tris[id]!;
    stack.push([a, b], [b, c], [c, a]);
  }
  legalize();

  // Insert the interior points.
  const first = outer.length + holes.reduce((n, h) => n + h.length, 0);
  for (let p = first; p < N; p++) {
    const P = pts[p]!;
    let best = -1;
    let bestMin = -Infinity;
    for (let id = 0; id < tris.length; id++) {
      const [a, b, c] = tris[id]!;
      const A = pts[a]!;
      const B = pts[b]!;
      const C = pts[c]!;
      const area = orient(A, B, C);
      const m = Math.min(orient(A, B, P), orient(B, C, P), orient(C, A, P)) / area;
      if (m > bestMin) {
        bestMin = m;
        best = id;
      }
    }
    if (best < 0 || bestMin < -1e-9) continue;
    const [a, b, c] = tris[best]!;
    drop(best);
    put([a, b, p], best);
    put([b, c, p]);
    put([c, a, p]);
    stack.push([a, b], [b, c], [c, a]);
    legalize();
  }
  return tris;
}

/** Triangulates a polygon (with holes, plus interior points every `spacing`) into counter-clockwise [s, t] triangles. */
function triangulate(outer: readonly Pt[], holes: readonly (readonly Pt[])[], spacing: number): Pt[][] {
  const inner = spacing > 0 ? steinerPoints(outer, holes, spacing) : [];
  const pts: Pt[] = [...outer, ...holes.flat(), ...inner];
  return triangulateCDT(outer, holes, inner).map((t) => t.map((i) => pts[i]!));
}

export interface PrismOptions {
  /** Total width across X; the caps sit at +-width/2. */
  width: number;
  /** Bevel size and thickness: the sides bulge out by this much, the caps keep the profile. */
  bevel: number;
  bevelSegments?: number;
  /** Layers across the inner width (between the bevels). */
  steps?: number;
  /** Extra layer positions across the inner width, e.g. the edges of a window, so faces can be shaded exactly. */
  extraX?: readonly number[];
  /** Longest profile edge after resampling. */
  maxEdge?: number;
  /** Spacing of interior cap vertices (0: outline only). */
  steiner?: number;
  /** Polygons cut out of both caps and filled with `holeShade` (window backings). */
  holes?: readonly (readonly Pt[])[];
  holeShade?: number;
  /** Shade of the side face over profile segment (a -> b) at width position x (default 1). */
  sideShade?: (a: Pt, b: Pt, x: number) => number;
}

/**
 * Adds a bevelled prism: the counter-clockwise profile (s -> world +Z, t -> world +Y) extruded across X, centred.
 * Like THREE.ExtrudeGeometry with bevels, but the profile is resampled, the inner width split into steps and the
 * caps triangulated with interior points, so that every surface has vertices to displace.
 */
export function addPrism(b: GeoBuilder, profile: readonly Pt[], o: PrismOptions): void {
  const maxEdge = o.maxEdge ?? 0.3;
  let base = profile.slice();
  if (signedArea(base) < 0) base = base.reverse();
  const pts = maxEdge > 0 ? resample(base, maxEdge) : base;
  const n = pts.length;
  // Outward offset direction of each point (mitred, like ExtrudeGeometry's bevel vectors).
  const move: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n]!;
    const c = pts[i]!;
    const q = pts[(i + 1) % n]!;
    const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const l2 = Math.hypot(q[0] - c[0], q[1] - c[1]);
    const n1: Pt = [(c[1] - p[1]) / l1, -(c[0] - p[0]) / l1];
    const n2: Pt = [(q[1] - c[1]) / l2, -(q[0] - c[0]) / l2];
    const d = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    let mx = d > 1e-6 ? (n1[0] + n2[0]) / d : n1[0];
    let my = d > 1e-6 ? (n1[1] + n2[1]) / d : n1[1];
    const l = mx * mx + my * my;
    if (l > 2) {
      const k = Math.sqrt(2 / l);
      mx *= k;
      my *= k;
    }
    move.push([mx, my]);
  }
  const half = o.width / 2;
  const bevel = Math.min(o.bevel, half * 0.45);
  const inner = half - bevel;
  const segs = o.bevelSegments ?? 2;
  const steps = o.steps ?? 4;
  const layers: Array<{ x: number; off: number }> = [];
  for (let k = 0; k < segs; k++) {
    const a = ((k / segs) * Math.PI) / 2;
    layers.push({ x: -(inner + bevel * Math.cos(a)), off: bevel * Math.sin(a) });
  }
  const xs = new Set<number>();
  for (let k = 0; k <= steps; k++) xs.add(-inner + (2 * inner * k) / steps);
  for (const x of o.extraX ?? []) if (Math.abs(x) < inner - 1e-4) xs.add(x);
  const sorted = [...xs].sort((p, q) => p - q);
  const inside: number[] = [];
  for (const x of sorted) if (inside.length === 0 || x - inside[inside.length - 1]! > 1e-4) inside.push(x);
  for (const x of inside) layers.push({ x, off: bevel });
  for (let k = segs - 1; k >= 0; k--) {
    const a = ((k / segs) * Math.PI) / 2;
    layers.push({ x: inner + bevel * Math.cos(a), off: bevel * Math.sin(a) });
  }
  const arc: number[] = [0];
  for (let i = 1; i <= n; i++) arc.push(arc[i - 1]! + Math.hypot(pts[i % n]![0] - pts[i - 1]![0], pts[i % n]![1] - pts[i - 1]![1]));
  const vert = (li: number, i: number): number[] => {
    const L = layers[li]!;
    const p = pts[i % n]!;
    const m = move[i % n]!;
    return [L.x, p[1] + m[1] * L.off, p[0] + m[0] * L.off];
  };
  for (let li = 0; li < layers.length - 1; li++) {
    const x0 = layers[li]!.x;
    const x1 = layers[li + 1]!.x;
    for (let i = 0; i < n; i++) {
      const shade = o.sideShade ? o.sideShade(pts[i]!, pts[(i + 1) % n]!, (x0 + x1) / 2) : 1;
      const A = vert(li, i);
      const B = vert(li, i + 1);
      const C = vert(li + 1, i + 1);
      const D = vert(li + 1, i);
      const uA = [arc[i]!, x0];
      const uB = [arc[i + 1]!, x0];
      const uC = [arc[i + 1]!, x1];
      const uD = [arc[i]!, x1];
      b.tri(A, C, B, uA, uC, uB, shade);
      b.tri(A, D, C, uA, uD, uC, shade);
    }
  }
  // Caps: the left one (-X) faces -X, which counter-clockwise (s, t) triangles do; the right one is mirrored.
  const holes = (o.holes ?? []).map((h) => (maxEdge > 0 ? resample(h, maxEdge) : h.slice()));
  const spacing = o.steiner ?? 0.3;
  const caps = triangulate(pts, holes, spacing);
  const fills = holes.map((h) => triangulate(h, [], spacing));
  for (const side of [-1, 1]) {
    const x = side * half;
    const put = (tris: Pt[][], shade: number): void => {
      for (const [p, q, r] of tris) {
        const P = [x, p![1], p![0]];
        const Q = [x, q![1], q![0]];
        const R = [x, r![1], r![0]];
        if (side < 0) b.tri(P, Q, R, p!, q!, r!, shade);
        else b.tri(P, R, Q, p!, r!, q!, shade);
      }
    };
    put(caps, 1);
    for (const f of fills) put(f, o.holeShade ?? 1);
  }
}

/** A flat panel: a grid of nu x nv quads from `origin` spanning the world vectors `u` and `v`, facing u x v. */
export function addPanel(b: GeoBuilder, origin: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, nu: number, nv: number, shade: number): void {
  const p = (i: number, j: number): number[] => {
    const x = origin.x + (u.x * i) / nu + (v.x * j) / nv;
    const y = origin.y + (u.y * i) / nu + (v.y * j) / nv;
    const z = origin.z + (u.z * i) / nu + (v.z * j) / nv;
    return [x, y, z];
  };
  const lu = u.length();
  const lv = v.length();
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const A = p(i, j);
      const B = p(i + 1, j);
      const C = p(i + 1, j + 1);
      const D = p(i, j + 1);
      const uA = [(lu * i) / nu, (lv * j) / nv];
      const uB = [(lu * (i + 1)) / nu, (lv * j) / nv];
      const uC = [(lu * (i + 1)) / nu, (lv * (j + 1)) / nv];
      const uD = [(lu * i) / nu, (lv * (j + 1)) / nv];
      b.tri(A, B, C, uA, uB, uC, shade);
      b.tri(A, C, D, uA, uC, uD, shade);
    }
  }
}

/** Highest point of the polygon's outline over s (its top at that length position), or -Infinity outside it. */
export function topAt(poly: readonly Pt[], s: number): number {
  let best = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const c = poly[(i + 1) % poly.length]!;
    const lo = Math.min(a[0], c[0]);
    const hi = Math.max(a[0], c[0]);
    if (s < lo - 1e-9 || s > hi + 1e-9) continue;
    const t = hi - lo < 1e-9 ? Math.max(a[1], c[1]) : a[1] + ((c[1] - a[1]) * (s - a[0])) / (c[0] - a[0]);
    best = Math.max(best, t);
  }
  return best;
}

/** Range of s where the horizontal line at height t crosses the polygon (its first and last crossing). */
export function spanAt(poly: readonly Pt[], t: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const c = poly[(i + 1) % poly.length]!;
    if ((a[1] - t) * (c[1] - t) > 0 || a[1] === c[1]) continue;
    const s = a[0] + ((c[0] - a[0]) * (t - a[1])) / (c[1] - a[1]);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  return lo <= hi ? [lo, hi] : null;
}

export interface DentLike {
  lx: number;
  ly: number;
  lz: number;
  nx: number;
  nz: number;
  depth: number;
}

/** Reach of a dent: vertices closer than this to its centre move. */
export function dentRadius(d: DentLike): number {
  return 0.6 + d.depth;
}

/** Writes the point (x, y, z) displaced by `dents` (see displace) into out[o..o+2]. */
function displacePoint(x: number, y: number, z: number, dents: readonly DentLike[], out: Float32Array, o: number): void {
  let ox = 0;
  let oy = 0;
  let oz = 0;
  for (let j = 0; j < dents.length; j++) {
    const d = dents[j]!;
    const r = 0.6 + d.depth;
    const dx = x - d.lx;
    const dy = y - d.ly;
    const dz = z - d.lz;
    const q = dx * dx + dy * dy + dz * dz;
    if (q >= r * r) continue;
    const k = 1 - Math.sqrt(q) / r;
    const w = d.depth * k * k;
    if (d.nx === 0 && d.nz === 0) oy -= w;
    else {
      ox += d.nx * w;
      oz += d.nz * w;
    }
  }
  out[o] = x + ox;
  out[o + 1] = y + oy;
  out[o + 2] = z + oz;
}

/**
 * Writes `src` positions displaced by `dents` into `dst`: every vertex within r = 0.6 + depth of a dent moves by
 * depth * (1 - d / r)^2 along its inward normal (straight down for a roof dent, whose normal is zero).
 */
export function displace(src: ArrayLike<number>, dst: Float32Array, dents: readonly DentLike[]): void {
  for (let i = 0; i < src.length; i += 3) displacePoint(src[i]!, src[i + 1]!, src[i + 2]!, dents, dst, i);
}

/** Cells of the triangle grid (m). */
const CELL = 0.5;

/** Triangles of a non-indexed geometry bucketed by the grid cells their bounds overlap. */
interface TriangleGrid {
  cells: Map<number, number[]>;
  count: number;
}

const grids = new WeakMap<THREE.BufferGeometry, TriangleGrid>();

const cellKey = (i: number, j: number, k: number): number => ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);

function triangleGrid(g: THREE.BufferGeometry): TriangleGrid {
  let grid = grids.get(g);
  if (grid) return grid;
  const p = g.getAttribute('position').array as ArrayLike<number>;
  const count = p.length / 9;
  const cells = new Map<number, number[]>();
  for (let t = 0; t < count; t++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let v = 0; v < 3; v++) {
      const o = t * 9 + v * 3;
      x0 = Math.min(x0, p[o]!);
      x1 = Math.max(x1, p[o]!);
      y0 = Math.min(y0, p[o + 1]!);
      y1 = Math.max(y1, p[o + 1]!);
      z0 = Math.min(z0, p[o + 2]!);
      z1 = Math.max(z1, p[o + 2]!);
    }
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
      for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) {
        for (let k = Math.floor(z0 / CELL); k <= Math.floor(z1 / CELL); k++) {
          const key = cellKey(i, j, k);
          let list = cells.get(key);
          if (!list) cells.set(key, (list = []));
          list.push(t);
        }
      }
    }
  }
  grid = { cells, count };
  grids.set(g, grid);
  return grid;
}

/**
 * A per-view copy of a shared, flat-shaded (non-indexed) geometry that dents bend. A change re-evaluates only the
 * triangles within reach of the dents that changed since the last update (a grid finds them) and recomputes their face
 * normals, instead of displacing every vertex against every dent and recomputing every normal: a crash costs about a
 * third to a sixth of what a full rebuild did (2-4 ms per change).
 *
 * The changed attributes are then uploaded whole, not in stretches. Chrome's WebGL on Vulkan (ANGLE) turns a partial
 * update of a buffer the GPU may still be reading into a copy outside the render pass, and a crash-heavy frame (a
 * chase, a blast that dents a row of cars) made dozens of them: past 15 in one render pass ANGLE splits it and warns
 * "Running out of reserved outsideRenderPass queueSerial". A whole upload lets it swap in a fresh buffer instead.
 */
export class DentedGeometry {
  readonly geometry: THREE.BufferGeometry;
  private readonly src: ArrayLike<number>;
  private readonly srcNormal: ArrayLike<number>;
  private readonly grid: TriangleGrid;
  private readonly bounds: THREE.Box3;
  /** The dents shown, as of the last update. */
  private shown: DentLike[] = [];
  /** Per-triangle stamp of the last pass that queued it. */
  private readonly stamp: Uint32Array;
  private pass = 0;
  private readonly queue: number[] = [];
  /** Triangles re-evaluated by the last update (the work a change cost). */
  touched = 0;

  constructor(readonly source: THREE.BufferGeometry) {
    this.geometry = source.clone();
    this.src = source.getAttribute('position').array as ArrayLike<number>;
    this.srcNormal = source.getAttribute('normal').array as ArrayLike<number>;
    this.grid = triangleGrid(source);
    if (!source.boundingBox) source.computeBoundingBox();
    this.bounds = source.boundingBox!.clone();
    this.stamp = new Uint32Array(this.grid.count);
  }

  /** Shows `dents`; returns whether any vertex may have moved. */
  update(dents: readonly DentLike[]): boolean {
    const changed: DentLike[] = [];
    const n = Math.max(dents.length, this.shown.length);
    for (let i = 0; i < n; i++) {
      const a = this.shown[i];
      const b = dents[i];
      if (a && b && a.lx === b.lx && a.ly === b.ly && a.lz === b.lz && a.nx === b.nx && a.nz === b.nz && a.depth === b.depth) continue;
      if (a) changed.push(a);
      if (b) changed.push(b);
    }
    this.shown = dents.map((d) => ({ lx: d.lx, ly: d.ly, lz: d.lz, nx: d.nx, nz: d.nz, depth: d.depth }));
    this.touched = 0;
    if (changed.length === 0) return false;
    // Triangles within reach of a changed dent, before or after the change.
    this.pass = (this.pass + 1) >>> 0 || 1;
    const q = this.queue;
    q.length = 0;
    for (const d of changed) {
      const r = dentRadius(d);
      const b = this.bounds;
      if (d.lx + r < b.min.x || d.lx - r > b.max.x || d.ly + r < b.min.y || d.ly - r > b.max.y || d.lz + r < b.min.z || d.lz - r > b.max.z) continue;
      for (let i = Math.floor((d.lx - r) / CELL); i <= Math.floor((d.lx + r) / CELL); i++) {
        for (let j = Math.floor((d.ly - r) / CELL); j <= Math.floor((d.ly + r) / CELL); j++) {
          for (let k = Math.floor((d.lz - r) / CELL); k <= Math.floor((d.lz + r) / CELL); k++) {
            const list = this.grid.cells.get(cellKey(i, j, k));
            if (!list) continue;
            for (const t of list) {
              if (this.stamp[t] === this.pass) continue;
              this.stamp[t] = this.pass;
              q.push(t);
            }
          }
        }
      }
    }
    if (q.length === 0) return false;
    this.touched = q.length;
    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nAttr = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const nor = nAttr.array as Float32Array;
    const src = this.src;
    const sn = this.srcNormal;
    const live = this.shown;
    for (const t of q) {
      const o = t * 9;
      let moved = false;
      for (let v = 0; v < 9; v += 3) {
        displacePoint(src[o + v]!, src[o + v + 1]!, src[o + v + 2]!, live, pos, o + v);
        if (pos[o + v] !== src[o + v] || pos[o + v + 1] !== src[o + v + 1] || pos[o + v + 2] !== src[o + v + 2]) moved = true;
      }
      if (!moved) {
        for (let v = 0; v < 9; v++) nor[o + v] = sn[o + v]!;
        continue;
      }
      // Flat face normal, as computeVertexNormals gives a non-indexed geometry.
      const ux = pos[o + 3]! - pos[o]!;
      const uy = pos[o + 4]! - pos[o + 1]!;
      const uz = pos[o + 5]! - pos[o + 2]!;
      const wx = pos[o + 6]! - pos[o]!;
      const wy = pos[o + 7]! - pos[o + 1]!;
      const wz = pos[o + 8]! - pos[o + 2]!;
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz);
      if (l > 0) {
        nx /= l;
        ny /= l;
        nz /= l;
      }
      for (let v = 0; v < 9; v += 3) {
        nor[o + v] = nx;
        nor[o + v + 1] = ny;
        nor[o + v + 2] = nz;
      }
    }
    // Uploaded whole (see the class comment).
    posAttr.needsUpdate = true;
    nAttr.needsUpdate = true;
    return true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
