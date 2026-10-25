// Small procedural modelling kit for the bike and boat models (bikeModels.ts, boatModels.ts): lofted superellipse
// sections (tanks, fairings, seats, cowlings), swept tubes (frames, bars, rails, exhausts), lathed solids (tyres,
// rims, discs, lamps) and one shared palette material, so a whole assembly of differently finished parts (rubber,
// chrome, cast alloy, leather, teak) merges into a single draw: each part's UVs point at one texel of a small colour
// texture and one of a roughness/metalness texture. Every closed solid is built with its faces outward (checked by its
// signed volume) and smooth normals, with creases only where a part's runs or caps meet.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Palette

interface Finish {
  color: number;
  roughness: number;
  metalness: number;
}

/** Every finish the models use, by name: one texel each in the palette textures. */
const FINISHES = {
  rubber: { color: 0x29292b, roughness: 0.9, metalness: 0 },
  tread: { color: 0x0a0a0b, roughness: 0.96, metalness: 0 },
  alloy: { color: 0xb9bdc2, roughness: 0.28, metalness: 0.85 },
  alloyDark: { color: 0x2b2d31, roughness: 0.35, metalness: 0.7 },
  chrome: { color: 0xdfe2e6, roughness: 0.1, metalness: 1 },
  steel: { color: 0x8d9196, roughness: 0.3, metalness: 0.95 },
  frame: { color: 0x2a2c30, roughness: 0.45, metalness: 0.55 },
  engine: { color: 0x3c3f44, roughness: 0.42, metalness: 0.65 },
  black: { color: 0x121315, roughness: 0.6, metalness: 0.05 },
  plastic: { color: 0x1b1c1f, roughness: 0.55, metalness: 0 },
  leather: { color: 0x151515, roughness: 0.78, metalness: 0 },
  stitch: { color: 0x2e2e2e, roughness: 0.8, metalness: 0 },
  gold: { color: 0xc9a34a, roughness: 0.3, metalness: 0.9 },
  smoke: { color: 0x1d2329, roughness: 0.06, metalness: 0.5 },
  mirror: { color: 0xc8d2dc, roughness: 0.03, metalness: 1 },
  plate: { color: 0xe9e6dc, roughness: 0.5, metalness: 0.1 },
  red: { color: 0x7a0d0d, roughness: 0.35, metalness: 0.1 },
  gelcoat: { color: 0xf1efe9, roughness: 0.3, metalness: 0.05 },
  antifoul: { color: 0x1f2a3a, roughness: 0.6, metalness: 0.05 },
  nonSkid: { color: 0xd6d2c6, roughness: 0.92, metalness: 0 },
  teak: { color: 0xa47a4c, roughness: 0.8, metalness: 0 },
  cushion: { color: 0xece6d8, roughness: 0.7, metalness: 0 },
  cushionDark: { color: 0x2f4a66, roughness: 0.72, metalness: 0 },
  hypalon: { color: 0x3a3e44, roughness: 0.62, metalness: 0 },
  rope: { color: 0xd9cfb4, roughness: 0.9, metalness: 0 },
  window: { color: 0x14202b, roughness: 0.05, metalness: 0.6 },
  dash: { color: 0x101114, roughness: 0.5, metalness: 0.1 },
  cowl: { color: 0x17181b, roughness: 0.3, metalness: 0.2 },
  cowlWhite: { color: 0xe7e7e3, roughness: 0.3, metalness: 0.1 },
} as const satisfies Record<string, Finish>;

export type FinishName = keyof typeof FINISHES;
const NAMES = Object.keys(FINISHES) as FinishName[];

/** The texel centre (u) of a finish in the palette textures. */
export function finishU(name: FinishName): number {
  return (NAMES.indexOf(name) + 0.5) / NAMES.length;
}

function paletteTexture(pixel: (f: Finish) => [number, number, number], srgb: boolean): THREE.DataTexture {
  const data = new Uint8Array(NAMES.length * 4);
  NAMES.forEach((n, i) => {
    const [r, g, b] = pixel(FINISHES[n]);
    data.set([r, g, b, 255], i * 4);
  });
  const t = new THREE.DataTexture(data, NAMES.length, 1, THREE.RGBAFormat);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

let palette: THREE.MeshStandardMaterial | null = null;

/**
 * The one material every palette part draws with: base colour from one texture, roughness (G) and metalness (B) from
 * another, both looked up at the part's texel (no mipmaps, nearest filtering, so a part never bleeds into the next).
 */
export function paletteMaterial(): THREE.MeshStandardMaterial {
  if (palette) return palette;
  const map = paletteTexture((f) => [(f.color >> 16) & 255, (f.color >> 8) & 255, f.color & 255], true);
  const orm = paletteTexture((f) => [255, Math.round(f.roughness * 255), Math.round(f.metalness * 255)], false);
  palette = new THREE.MeshStandardMaterial({ map, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1 });
  palette.name = 'twowheel-boat-palette';
  return palette;
}

/** Points every vertex of `g` at the finish's texel. */
export function finish(g: THREE.BufferGeometry, name: FinishName): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const uv = new Float32Array(n * 2);
  const u = finishU(name);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = u;
    uv[i * 2 + 1] = 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** The finish a palette part's first vertex points at (for tests). */
export function finishOf(g: THREE.BufferGeometry, firstVertex = 0): FinishName | null {
  const uv = g.getAttribute('uv');
  if (!uv) return null;
  const i = Math.floor(uv.getX(firstVertex) * NAMES.length);
  return NAMES[i] ?? null;
}

// ---------------------------------------------------------------------------
// Building blocks

function indexed(pos: number[], idx: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** Signed volume of a (closed) triangle mesh: positive when its faces point outward. */
export function signedVolume(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position');
  const idx = g.index;
  const n = idx ? idx.count : p.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let v = 0;
  for (let i = 0; i < n; i += 3) {
    const ia = idx ? idx.getX(i) : i;
    const ib = idx ? idx.getX(i + 1) : i + 1;
    const ic = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(p, ia);
    b.fromBufferAttribute(p, ib);
    c.fromBufferAttribute(p, ic);
    v += a.dot(b.cross(c)) / 6;
  }
  return v;
}

/** Reverses every triangle of an indexed geometry. */
function flip(g: THREE.BufferGeometry): void {
  const idx = g.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const t = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, t);
  }
}

/** Closed solid: faces outward, smooth normals. */
function solid(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (signedVolume(g) < 0) flip(g);
  g.computeVertexNormals();
  return g;
}

/** Open surface: faces oriented so the normal of its first triangle points along `toward`; smooth normals. */
export function sheet(pos: number[], idx: number[], toward: THREE.Vector3): THREE.BufferGeometry {
  const g = indexed(pos, idx);
  const p = g.getAttribute('position');
  const ix = g.index!;
  // The first non-degenerate triangle decides.
  for (let i = 0; i < ix.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, ix.getX(i));
    const b = new THREE.Vector3().fromBufferAttribute(p, ix.getX(i + 1)).sub(a);
    const c = new THREE.Vector3().fromBufferAttribute(p, ix.getX(i + 2)).sub(a);
    const n = b.cross(c);
    if (n.lengthSq() < 1e-12) continue;
    if (n.dot(toward) < 0) flip(g);
    break;
  }
  g.computeVertexNormals();
  return g;
}

/** A grid surface from rows of points (each row the same length): row i, column j. */
export function gridSurface(rows: THREE.Vector3[][], toward: THREE.Vector3, wrap = false): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const m = rows[0]!.length;
  for (const r of rows) for (const q of r) pos.push(q.x, q.y, q.z);
  const cols = wrap ? m : m - 1;
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * m + j;
      const b = i * m + ((j + 1) % m);
      const c = (i + 1) * m + j;
      const d = (i + 1) * m + ((j + 1) % m);
      idx.push(a, b, c, b, d, c);
    }
  }
  return sheet(pos, idx, toward);
}

/** One section of a loft: a superellipse centred at (x, y) in the plane z, `w` to each side, `up` above, `down` below. */
export interface Section {
  z: number;
  y: number;
  x?: number;
  w: number;
  up: number;
  down: number;
  /** Superellipse exponent: 2 an ellipse, larger squarer (rounded box). Below the centre `nb` if given. */
  n?: number;
  nb?: number;
}

const sgnPow = (v: number, e: number): number => Math.sign(v) * Math.abs(v) ** e;

/** A closed solid lofted through `sections` (in increasing z), `seg` points round each, capped at both ends. */
export function loft(sections: readonly Section[], seg = 20): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const ring = (s: Section, out: number[]): void => {
    for (let j = 0; j < seg; j++) {
      const t = (j / seg) * Math.PI * 2;
      const c = Math.cos(t);
      const sn = Math.sin(t);
      const n = sn >= 0 ? (s.n ?? 2.5) : (s.nb ?? s.n ?? 2.5);
      out.push((s.x ?? 0) + s.w * sgnPow(c, 2 / n), s.y + (sn >= 0 ? s.up : s.down) * sgnPow(sn, 2 / n), s.z);
    }
  };
  for (const s of sections) ring(s, pos);
  for (let i = 0; i < sections.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      const c = (i + 1) * seg + j;
      const d = (i + 1) * seg + ((j + 1) % seg);
      idx.push(a, b, c, b, d, c);
    }
  }
  // Caps of their own vertices (a crease at the rim).
  for (const [k, back] of [[0, true], [sections.length - 1, false]] as const) {
    const s = sections[k]!;
    const base = pos.length / 3;
    ring(s, pos);
    const centre = pos.length / 3;
    pos.push(s.x ?? 0, s.y + (s.up - s.down) * 0, s.z);
    for (let j = 0; j < seg; j++) {
      const a = base + j;
      const b = base + ((j + 1) % seg);
      if (back) idx.push(centre, b, a);
      else idx.push(centre, a, b);
    }
  }
  return solid(indexed(pos, idx));
}

/**
 * A tube swept along `path` (a smooth Catmull-Rom curve through it, or straight segments), radius `r` (or r(t), t 0..1
 * along it), `radial` points round, capped.
 */
export function sweep(path: readonly THREE.Vector3[], r: number | ((t: number) => number), radial = 8, opts: { smooth?: boolean; segments?: number; caps?: boolean; flat?: number } = {}): THREE.BufferGeometry {
  const smooth = opts.smooth ?? path.length > 2;
  const curve: THREE.Curve<THREE.Vector3> = smooth
    ? new THREE.CatmullRomCurve3(path.map((p) => p.clone()), false, 'centripetal')
    : (() => {
        const cp = new THREE.CurvePath<THREE.Vector3>();
        for (let i = 0; i < path.length - 1; i++) cp.add(new THREE.LineCurve3(path[i]!.clone(), path[i + 1]!.clone()));
        return cp;
      })();
  const segs = opts.segments ?? (smooth ? (path.length - 1) * 6 : path.length - 1);
  const radius = typeof r === 'number' ? () => r : r;
  // Frames that do not twist: rotation-minimising (parallel transport) from a start normal off the up axis.
  const pts: THREE.Vector3[] = [];
  const tans: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(curve.getPointAt(t));
    tans.push(curve.getTangentAt(t).normalize());
  }
  const up = Math.abs(tans[0]!.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  let nrm = new THREE.Vector3().crossVectors(tans[0]!, up).normalize();
  const flat = opts.flat ?? 1;
  const pos: number[] = [];
  const idx: number[] = [];
  const rings: Array<{ p: THREE.Vector3; n: THREE.Vector3; b: THREE.Vector3; r: number }> = [];
  for (let i = 0; i <= segs; i++) {
    if (i > 0) {
      const axis = new THREE.Vector3().crossVectors(tans[i - 1]!, tans[i]!);
      const s = axis.length();
      if (s > 1e-9) nrm.applyAxisAngle(axis.normalize(), Math.asin(Math.min(1, s)));
      nrm = nrm.sub(tans[i]!.clone().multiplyScalar(nrm.dot(tans[i]!))).normalize();
    }
    const b = new THREE.Vector3().crossVectors(tans[i]!, nrm).normalize();
    rings.push({ p: pts[i]!, n: nrm.clone(), b, r: radius(i / segs) });
  }
  const at = (k: (typeof rings)[number], j: number, out: number[]): void => {
    const a = (j / radial) * Math.PI * 2;
    const c = Math.cos(a) * k.r;
    const s = Math.sin(a) * k.r * flat;
    out.push(k.p.x + k.n.x * c + k.b.x * s, k.p.y + k.n.y * c + k.b.y * s, k.p.z + k.n.z * c + k.b.z * s);
  };
  for (const k of rings) for (let j = 0; j < radial; j++) at(k, j, pos);
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = (i + 1) * radial + j;
      const d = (i + 1) * radial + ((j + 1) % radial);
      idx.push(a, c, b, b, c, d);
    }
  }
  if (opts.caps ?? true) {
    for (const [k, back] of [[rings[0]!, true], [rings[rings.length - 1]!, false]] as const) {
      const base = pos.length / 3;
      for (let j = 0; j < radial; j++) at(k, j, pos);
      const centre = pos.length / 3;
      pos.push(k.p.x, k.p.y, k.p.z);
      for (let j = 0; j < radial; j++) {
        const a = base + j;
        const b = base + ((j + 1) % radial);
        if (back) idx.push(centre, a, b);
        else idx.push(centre, b, a);
      }
    }
    return solid(indexed(pos, idx));
  }
  const g = indexed(pos, idx);
  g.computeVertexNormals();
  return g;
}

/** A straight rod of radius r from a to b. */
export function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, radial = 8): THREE.BufferGeometry {
  return sweep([a, b], r, radial, { smooth: false });
}

/**
 * A solid of revolution about the x axis (then turned onto `axis`): a closed profile of runs of [axial, radius] points,
 * each run smooth, the corners between runs creased. `rmod(j, k, axial, radius)` may vary the radius per point (tyre
 * tread, sprocket teeth); `seg` points round.
 */
export function lathe(runs: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, seg = 32, axis: 'x' | 'y' | 'z' = 'x', rmod?: (j: number, run: number, k: number, a: number, r: number) => number): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  runs.forEach((run, ri) => {
    const base = pos.length / 3;
    for (let j = 0; j < seg; j++) {
      const phi = (j / seg) * Math.PI * 2;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      run.forEach(([a, r], k) => {
        const rr = rmod ? rmod(j, ri, k, a, r) : r;
        pos.push(a, rr * c, rr * s);
      });
    }
    const m = run.length;
    for (let j = 0; j < seg; j++) {
      for (let k = 0; k < m - 1; k++) {
        const a = base + j * m + k;
        const b = base + j * m + k + 1;
        const c = base + ((j + 1) % seg) * m + k;
        const d = base + ((j + 1) % seg) * m + k + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
  });
  const g = solid(indexed(pos, idx));
  if (axis === 'y') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateY(-Math.PI / 2);
  return g;
}

/** A flat-ended cylinder (disc, hub, can) about the x axis from a0 to a1, radius r (and an inner radius for a ring). */
export function cylinder(a0: number, a1: number, r: number, seg = 24, inner = 0): THREE.BufferGeometry {
  if (inner > 0) return lathe([[[a0, inner], [a0, r]], [[a0, r], [a1, r]], [[a1, r], [a1, inner]], [[a1, inner], [a0, inner]]], seg);
  return lathe([[[a0, 0], [a0, r]], [[a0, r], [a1, r]], [[a1, r], [a1, 0]]], seg);
}

/** A box with rounded vertical edges (a loft of squarish sections): w x h x d centred at (x, y, z). */
export function block(w: number, h: number, d: number, x: number, y: number, z: number, n = 6, seg = 10): THREE.BufferGeometry {
  return loft([{ z: z - d / 2, y, x, w: w / 2, up: h / 2, down: h / 2, n }, { z: z + d / 2, y, x, w: w / 2, up: h / 2, down: h / 2, n }], seg);
}

// ---------------------------------------------------------------------------
// Assembly

/** A named part's triangles in a merged geometry (non-indexed: vertices start*3 .. (start+count)*3). */
export interface PartRange {
  name: string;
  start: number;
  count: number;
}

/** Parts to merge: [name, geometry, finish]. */
export type PartList = Array<[string, THREE.BufferGeometry, FinishName]>;
/** Painted parts: [name, geometry, tone] (a vertex colour the paint colour is multiplied by: 0xffffff for plain paint). */
export type PaintList = Array<[string, THREE.BufferGeometry, number]>;

function prepared(g0: THREE.BufferGeometry, keep: readonly string[]): THREE.BufferGeometry {
  const g = (g0.index ? g0.toNonIndexed() : g0).clone();
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
  return g;
}

/** Painted parts merged as assemble does, with a vertex colour per part (position, normal, color). */
export function assemblePainted(parts: PaintList): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = [];
  const ranges: PartRange[] = [];
  let tri = 0;
  const c = new THREE.Color();
  for (const [name, g0, tone] of parts) {
    const g = prepared(g0, ['position', 'normal']);
    const n = g.getAttribute('position').count;
    c.setHex(tone, THREE.SRGBColorSpace);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(col, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    ranges.push({ name, start: tri, count: n / 3 });
    tri += n / 3;
    list.push(g);
  }
  const m = mergeGeometries(list, false);
  if (!m) throw new Error('part merge failed');
  m.userData.parts = ranges;
  m.computeBoundingBox();
  m.computeBoundingSphere();
  return m;
}

/** Positions only, merged (a shadow caster's proxy). */
export function assembleShape(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts.map((g) => prepared(g, ['position', 'normal'])), false);
  if (!m) throw new Error('shape merge failed');
  m.computeBoundingBox();
  m.computeBoundingSphere();
  return m;
}

/**
 * Merges named parts into one non-indexed geometry with position, normal and uv (the part's palette texel), keeping
 * each part's own (smooth) normals; userData.parts lists every part's triangle range.
 */
export function assemble(parts: PartList): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = [];
  const ranges: PartRange[] = [];
  let tri = 0;
  for (const [name, g0, fin] of parts) {
    const g = finish(prepared(g0, ['position', 'normal']), fin);
    const n = g.getAttribute('position').count / 3;
    ranges.push({ name, start: tri, count: n });
    tri += n;
    list.push(g);
  }
  const m = mergeGeometries(list, false);
  if (!m) throw new Error('part merge failed');
  m.userData.parts = ranges;
  m.computeBoundingBox();
  m.computeBoundingSphere();
  return m;
}

/** The parts of an assembled geometry (assemble). */
export function partsOf(g: THREE.BufferGeometry): PartRange[] {
  return (g.userData.parts as PartRange[] | undefined) ?? [];
}

/** The positions of one part of an assembled geometry, as a geometry of its own (for tests and measurements). */
export function partGeometry(g: THREE.BufferGeometry, name: string): THREE.BufferGeometry | null {
  const r = partsOf(g).find((p) => p.name === name);
  if (!r) return null;
  const src = g.getAttribute('position');
  const arr = new Float32Array(r.count * 9);
  for (let i = 0; i < r.count * 3; i++) {
    arr[i * 3] = src.getX(r.start * 3 + i);
    arr[i * 3 + 1] = src.getY(r.start * 3 + i);
    arr[i * 3 + 2] = src.getZ(r.start * 3 + i);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const uv = g.getAttribute('uv');
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([uv.getX(r.start * 3), uv.getY(r.start * 3)]), 2));
  return out;
}

export const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Mirror of a geometry across x = 0 (faces kept outward, normals mirrored with it). */
export function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = g.clone();
  m.scale(-1, 1, 1);
  if (m.index) flip(m);
  else {
    const p = m.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      for (const name of Object.keys(m.attributes)) {
        const a = m.getAttribute(name);
        for (let c = 0; c < a.itemSize; c++) {
          const t = a.getComponent(i + 1, c);
          a.setComponent(i + 1, c, a.getComponent(i + 2, c));
          a.setComponent(i + 2, c, t);
        }
      }
    }
  }
  return m;
}

/** Both sides: the part as given (its +x side) and its mirror. */
export function pair(g: THREE.BufferGeometry): THREE.BufferGeometry[] {
  return [g, mirrorX(g)];
}

/** Total triangles of a geometry. */
export function triangles(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}

// ---------------------------------------------------------------------------
// Paint

/** The cars' body paint (vehicleView.ts PAINT), so bikes and boats draw with a program the cars compiled. */
const PAINT = { roughness: 0.38, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.2, vertexColors: true } as const;
const paints = new Map<number, THREE.MeshPhysicalMaterial>();

/** Paint of a colour, shared by every bike and boat in it (the geometry's vertex tone shades it per part). */
export function paintMaterial(color: number): THREE.MeshPhysicalMaterial {
  let m = paints.get(color);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({ color, ...PAINT });
    m.name = 'twowheel-boat-paint';
    paints.set(color, m);
  }
  return m;
}
