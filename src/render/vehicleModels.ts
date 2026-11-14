// Imported car bodies: the Quaternius models of src/assets, fitted to VEHICLE_SPECS and split into the parts a
// VehicleView draws with its own materials (paint, livery, trim, glass) and the places of its lamp lenses. The view stays
// procedural wherever a model is missing (Node tests, a failed load) or no model suits the kind.
//
// Fitting: each axis is scaled so the body's bounding box is the spec's length, width and height (VAL-CAR-002 holds by
// construction), the ground stays at the tyres' contact, and the length is warped piecewise so the model's wheel
// centres land on the physics axles (wheelbase = 0.6 x length). The fitted mesh is then refined until no edge is
// longer than MAX_EDGE (conforming: every split edge is split for both triangles sharing it), so dents can bend it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { VEHICLE_SPECS, type VehicleKind } from '../sim/specs';
import { assets } from './assets';
import type { Pt } from './vehicleGeometry';

/** What each triangle of a model becomes. */
type Part = 'paint' | 'livery' | 'dark' | 'metal' | 'plate' | 'glass' | 'head' | 'tail' | 'drop';

/** Model-space box [x0, y0, z0, x1, y1, z1]: triangles whose centroid is inside are dropped. */
type Box = readonly [number, number, number, number, number, number];

interface ModelSpec {
  id: string;
  /** Part by material name. */
  materials: Readonly<Record<string, Part>>;
  /**
   * Atlas-textured models: part by atlas cell ('col,row' of 16-pixel cells of the 512-pixel atlas) at the triangle's
   * texture-coordinate centroid. 'glass' cells are glass only above `glassAbove` (model units), dark trim below (a
   * grille that shares the windows' cell).
   */
  cells?: Readonly<Record<string, Part>>;
  glassAbove?: number;
  /** Parts the view draws itself (a roof sign, a light bar), dropped from the model. */
  drop?: readonly Box[];
}

const CARS_PACK = { Windows: 'glass', Black: 'dark', Grey: 'metal', Headlights: 'head', TailLights: 'tail' } as const;

/**
 * The model each kind is drawn with. Quaternius models only: the Kenney car kit's toy proportions (oversized wheels,
 * chunky cabins) clash with the other Quaternius models, and its sedan, taxi, van and fire truck do not fit the specs
 * (VAL-CAR-003, see the cars report). The sedan shares the taxi's body (without its roof sign), as the procedural
 * sedan family did; the box vehicles (van, bus, riot van, ambulance, fire truck) stay procedural. Kenney's ambulance
 * fits within 20 %, but its cab sits 1.0-1.8 m ahead of the centre: the sim seats a front row 0.15 m ahead of it
 * (Sim.syncOccupant, combat seatExit) and fires its drive-bys from there (pose.ts windowMuzzle), so its crew would
 * be drawn a metre and more from where they get out, are hit and shoot from.
 */
const MODELS: Readonly<Partial<Record<VehicleKind, ModelSpec>>> = (() => {
  // The taxi's roof sign: the view draws its own (taxiSignMat), and the sedan none.
  const sign: Box = [-0.42, 1.3, -0.26, 0.42, 3, 0.15];
  const taxi: ModelSpec = { id: 'veh.q.taxi', materials: { ...CARS_PACK, Yellow: 'paint' }, drop: [sign] };
  return {
    compact: { id: 'veh.q.suv', materials: { ...CARS_PACK, White: 'paint' } },
    sedan: taxi,
    taxi,
    sports: { id: 'veh.q.sports2', materials: { ...CARS_PACK, White: 'paint' } },
    // The cruiser: black body (paint), white doors (the livery), and the light bar the view draws itself.
    police: { id: 'veh.q.police', materials: { ...CARS_PACK, Black: 'paint', White: 'livery', WhiteLights: 'drop', BlueLights: 'drop' }, drop: [[-0.6, 1.505, -0.72, 0.6, 3, -0.34]] },
    muscle: {
      id: 'veh.q.sports',
      materials: { Headlights: 'head', BrakeLight: 'tail' },
      cells: { '0,28': 'paint', '2,28': 'dark', '3,28': 'metal', '1,28': 'glass' },
      glassAbove: 1.1,
    },
    pickup: {
      id: 'veh.q.pickup',
      materials: { Headlights: 'head', BrakeLight: 'tail' },
      // Blue cab and white flanks (both painted), dark bed and underbody, dark windows (and the grille below them).
      cells: { '0,26': 'paint', '3,26': 'paint', '2,26': 'dark', '4,26': 'dark', '1,26': 'glass' },
      glassAbove: 1.15,
    },
  };
})();

/** Longest edge of the fitted, refined body (m): dents move vertices this far apart smoothly. */
const MAX_EDGE = 0.22;
/** Drawn wheel centres: the physics' axles, as fractions of the length (as vehicleView's AXLE). */
const AXLE = 0.3;

/**
 * A lamp lens where the model has a lamp: the centre of the lamp's face, its outward normal, the across direction in
 * its plane (level), and its size along that and up the face.
 */
export interface ModelLamp {
  readonly at: THREE.Vector3;
  readonly size: readonly [number, number];
  readonly normal: THREE.Vector3;
  readonly across: THREE.Vector3;
}

export interface CarModel {
  readonly kind: VehicleKind;
  readonly id: string;
  /** Distinguishes one load of the model from another (caches key on it). */
  readonly key: string;
  /** Per-axis scale applied before the length warp (for the report). */
  readonly scale: readonly [number, number, number];
  /** Refined, flat-shaded, non-indexed parts in the view's frame (+x left, +y up from the contact, +z forward). */
  readonly paint: THREE.BufferGeometry;
  readonly livery: THREE.BufferGeometry | null;
  /** Trim with texture coordinates in the exterior atlas (dark rubber and satin metal cells). */
  readonly trim: THREE.BufferGeometry;
  readonly glass: THREE.BufferGeometry;
  /**
   * The inside of the cabin's shell: the body and trim round the windows again, facing in and dark. A model's panels
   * are single surfaces facing out, so from outside, through a window, the far door's and the roof's insides were culled
   * and the street showed through them.
   */
  readonly liner: THREE.BufferGeometry;
  /** The same parts unrefined, for the far versions. */
  readonly farPaint: THREE.BufferGeometry;
  readonly farTrim: THREE.BufferGeometry;
  readonly farGlass: THREE.BufferGeometry;
  /** Lamps: left (+x) then right, and one reverse lamp. */
  readonly head: readonly ModelLamp[];
  readonly tail: readonly ModelLamp[];
  readonly reverse: ModelLamp;
  /** The fitted model's wheel radius (the drawn tyres are this big and spin by it) and wheel x (outer track). */
  readonly wheelR: number;
  readonly wheelX: number;
  /** Side outline of the windows: front-bottom, front-top, rear-top, rear-bottom (z, y). */
  readonly cabin: readonly Pt[];
  /** Half width of the glass at the beltline, the beltline (bottom of the side windows), the inner roof and the roof top. */
  readonly cabinHalf: number;
  readonly beltY: number;
  readonly roofY: number;
  readonly roofTopY: number;
  /** Lowest point of the body (ground clearance). */
  readonly bottom: number;
  /** The rear window's foot: its rearmost z and its lowest y (null without one behind the side windows). */
  readonly rearWindow: { readonly z: number; readonly y: number } | null;
}

const built = new Map<string, CarModel | null>();

/** The kind's imported body, fitted and split, or null (no model for the kind, or not loaded): draw it procedurally. */
export function carModel(kind: VehicleKind): CarModel | null {
  const spec = MODELS[kind];
  if (!spec) return null;
  const t = assets.model(spec.id);
  if (!t) return null;
  const key = `${kind}:${t.scene.uuid}`;
  let m = built.get(key);
  if (m === undefined) {
    m = buildModel(kind, spec, t.scene, t.entry.sockets ?? {}, t.entry.wheelRadius ?? 0.33, t.entry.wheelNodes ?? {}, key);
    built.set(key, m);
  }
  return m;
}

/** The model id each kind is drawn with when loaded (for tools and tests). */
export function modelIdFor(kind: VehicleKind): string | null {
  return MODELS[kind]?.id ?? null;
}

interface Tri {
  p: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  part: Part;
}

function inBox(b: Box, x: number, y: number, z: number): boolean {
  return x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5];
}

/** The model's triangles (model space), each with its part; the wheels left out. */
function collect(spec: ModelSpec, scene: THREE.Object3D, wheelNodes: Readonly<Record<string, string>>): Tri[] {
  const wheels = new Set(Object.values(wheelNodes));
  scene.updateMatrixWorld(true);
  const out: Tri[] = [];
  const inWheel = (o: THREE.Object3D): boolean => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (wheels.has(p.name)) return true;
    return false;
  };
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || inWheel(mesh)) return;
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    const index = g.getIndex();
    const n = index ? index.count : pos.count;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const materialAt = (i: number): THREE.Material => {
      if (!Array.isArray(mesh.material)) return mesh.material;
      for (const gr of g.groups) if (i >= gr.start && i < gr.start + gr.count) return materials[gr.materialIndex ?? 0]!;
      return materials[0]!;
    };
    for (let i = 0; i + 2 < n; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      const p = [ia, ib, ic].map((k) => new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld)) as Tri['p'];
      const cx = (p[0].x + p[1].x + p[2].x) / 3;
      const cy = (p[0].y + p[1].y + p[2].y) / 3;
      const cz = (p[0].z + p[1].z + p[2].z) / 3;
      let part: Part | undefined = spec.materials[materialAt(i).name];
      if (part === undefined) {
        part = 'paint';
        if (spec.cells && uv) {
          const u = (uv.getX(ia) + uv.getX(ib) + uv.getX(ic)) / 3;
          const v = (uv.getY(ia) + uv.getY(ib) + uv.getY(ic)) / 3;
          part = spec.cells[`${Math.floor((u * 512) / 16)},${Math.floor((v * 512) / 16)}`] ?? 'dark';
          if (part === 'glass' && cy < (spec.glassAbove ?? 0)) part = 'dark';
        }
      }
      if (part !== 'drop' && spec.drop?.some((b) => inBox(b, cx, cy, cz))) part = 'drop';
      if (part !== 'drop') out.push({ p, part });
    }
  });
  return out;
}

/** Piecewise-linear map along the length: the model's axles (zr, zf) onto the physics' (-a, a), the ends kept. */
function lengthWarp(half: number, zr: number, zf: number, a: number): (z: number) => number {
  return (z) => {
    if (z >= zf) return a + ((z - zf) * (half - a)) / Math.max(1e-6, half - zf);
    if (z <= zr) return -a + ((z - zr) * (half - a)) / Math.max(1e-6, half + zr);
    return -a + ((z - zr) * 2 * a) / (zf - zr);
  };
}

/**
 * Conforming refinement: every edge longer than `maxEdge` is halved (for both its triangles) until none is. `normals`
 * (per triangle corner, 9 per triangle) are carried along: a corner on a split edge takes the normalised mean of the
 * edge's two corner normals in its own triangle, so the refined body shades as the coarse one does, smooth across each
 * of the model's faces. (Normals computed on the refined mesh instead are flat over the middle of every original face
 * and bend only in a band one refined edge wide along its edges, which drew the low-poly facets as wavy blotches.)
 */
function refine(positions: THREE.Vector3[], tris: Array<[number, number, number]>, parts: Part[], normals: Float32Array, maxEdge: number): { positions: THREE.Vector3[]; tris: Array<[number, number, number]>; parts: Part[]; normals: Float32Array } {
  let T = tris;
  let P = parts;
  let N: ArrayLike<number> = normals;
  const max2 = maxEdge * maxEdge;
  for (let pass = 0; pass < 12; pass++) {
    const mid = new Map<string, number>();
    const key = (a: number, b: number): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const long = (a: number, b: number): boolean => positions[a]!.distanceToSquared(positions[b]!) > max2;
    let any = false;
    for (const [a, b, c] of T) {
      for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
        if (!long(u, v)) continue;
        const k = key(u, v);
        if (!mid.has(k)) {
          mid.set(k, positions.length);
          positions.push(positions[u]!.clone().add(positions[v]!).multiplyScalar(0.5));
          any = true;
        }
      }
    }
    if (!any) break;
    const NT: Array<[number, number, number]> = [];
    const NP: Part[] = [];
    const NN: number[] = [];
    const n = new THREE.Vector3();
    T.forEach(([a, b, c], t) => {
      const part = P[t]!;
      const ab = mid.get(key(a, b));
      const bc = mid.get(key(b, c));
      const ca = mid.get(key(c, a));
      // The triangle's corner normals by vertex, with its split edges' midpoints.
      const corner = new Map<number, readonly number[]>([
        [a, [N[t * 9]!, N[t * 9 + 1]!, N[t * 9 + 2]!]],
        [b, [N[t * 9 + 3]!, N[t * 9 + 4]!, N[t * 9 + 5]!]],
        [c, [N[t * 9 + 6]!, N[t * 9 + 7]!, N[t * 9 + 8]!]],
      ]);
      for (const [m, u, v] of [[ab, a, b], [bc, b, c], [ca, c, a]] as const) {
        if (m === undefined) continue;
        const nu = corner.get(u)!;
        const nv = corner.get(v)!;
        n.set(nu[0]! + nv[0]!, nu[1]! + nv[1]!, nu[2]! + nv[2]!);
        if (n.lengthSq() < 1e-12) n.set(nu[0]!, nu[1]!, nu[2]!);
        n.normalize();
        corner.set(m, [n.x, n.y, n.z]);
      }
      const emit = (x: number, y: number, z: number): void => {
        NT.push([x, y, z]);
        NP.push(part);
        for (const k of [x, y, z]) NN.push(...corner.get(k)!);
      };
      if (ab !== undefined && bc !== undefined && ca !== undefined) {
        emit(a, ab, ca);
        emit(ab, b, bc);
        emit(ca, bc, c);
        emit(ab, bc, ca);
      } else if (ab !== undefined && bc !== undefined) {
        emit(ab, b, bc);
        emit(a, ab, bc);
        emit(a, bc, c);
      } else if (bc !== undefined && ca !== undefined) {
        emit(bc, c, ca);
        emit(a, b, bc);
        emit(a, bc, ca);
      } else if (ca !== undefined && ab !== undefined) {
        emit(a, ab, ca);
        emit(ab, b, c);
        emit(ab, c, ca);
      } else if (ab !== undefined) {
        emit(a, ab, c);
        emit(ab, b, c);
      } else if (bc !== undefined) {
        emit(a, b, bc);
        emit(a, bc, c);
      } else if (ca !== undefined) {
        emit(a, b, ca);
        emit(ca, b, c);
      } else emit(a, b, c);
    });
    T = NT;
    P = NP;
    N = NN;
  }
  return { positions, tris: T, parts: P, normals: Float32Array.from(N) };
}

/** Welds the triangles by position into an indexed list. */
function weld(tris: Tri[]): { positions: THREE.Vector3[]; tris: Array<[number, number, number]>; parts: Part[] } {
  const positions: THREE.Vector3[] = [];
  const at = new Map<string, number>();
  const id = (v: THREE.Vector3): number => {
    const k = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    let i = at.get(k);
    if (i === undefined) {
      i = positions.length;
      positions.push(v.clone());
      at.set(k, i);
    }
    return i;
  };
  const out: Array<[number, number, number]> = [];
  const parts: Part[] = [];
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (const t of tris) {
    // Slivers with no area (the models have a few) would have no normal: a zero normal is NaN in the shaders, and
    // bloom spreads one NaN pixel over the whole frame.
    if (ab.subVectors(t.p[1], t.p[0]).cross(ac.subVectors(t.p[2], t.p[0])).lengthSq() < 1e-12) continue;
    const a = id(t.p[0]);
    const b = id(t.p[1]);
    const c = id(t.p[2]);
    if (a === b || b === c || c === a) continue;
    out.push([a, b, c]);
    parts.push(t.part);
  }
  return { positions, tris: out, parts };
}

/** Atlas cells of the exterior fittings' material (vehicleDetails exteriorGeometry): rubber and satin metal. */
const TRIM_UV: Readonly<Partial<Record<Part, readonly [number, number]>>> = { dark: [0.25, 0.25], metal: [0.75, 0.25] };
/** The fittings atlas's number-plate cell (finish 2), inside its gutter. */
const PLATE_U0 = 0.015;
const PLATE_U1 = 0.485;
const PLATE_V0 = 0.515;
const PLATE_V1 = 0.985;

/** Surfaces meeting at less than this angle are shaded smooth across their shared edge; sharper edges stay hard. */
const CREASE = Math.cos((38 * Math.PI) / 180);

/**
 * Per-corner normals of a welded mesh: each corner averages (by area) the faces round its vertex of the same part that
 * turn less than the crease angle from its own face, so the model's curved panels shade smooth and its creases stay
 * crisp (as the model was drawn). Computed on the model's own faces; the refinement carries them onto its pieces.
 */
function cornerNormals(positions: readonly THREE.Vector3[], tris: ReadonlyArray<readonly [number, number, number]>, parts: readonly Part[]): Float32Array {
  const face: THREE.Vector3[] = [];
  const around: number[][] = positions.map(() => []);
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  tris.forEach(([a, b, c], t) => {
    ab.subVectors(positions[b]!, positions[a]!);
    ac.subVectors(positions[c]!, positions[a]!);
    face.push(new THREE.Vector3().crossVectors(ab, ac));
    around[a]!.push(t);
    around[b]!.push(t);
    around[c]!.push(t);
  });
  const unit = face.map((n) => n.clone().normalize());
  const out = new Float32Array(tris.length * 9);
  const n = new THREE.Vector3();
  tris.forEach((tri, t) => {
    for (let k = 0; k < 3; k++) {
      n.set(0, 0, 0);
      for (const o of around[tri[k]!]!) if (parts[o] === parts[t] && unit[o]!.dot(unit[t]!) > CREASE) n.add(face[o]!);
      if (n.lengthSq() < 1e-20) n.copy(unit[t]!);
      if (n.lengthSq() < 1e-20) n.set(0, 1, 0);
      n.normalize();
      out.set([n.x, n.y, n.z], t * 9 + k * 3);
    }
  });
  return out;
}

/** A non-indexed geometry of the triangles of `want` parts (normals per corner), with the attributes the view's materials read. */
function geometryOf(positions: readonly THREE.Vector3[], tris: ReadonlyArray<readonly [number, number, number]>, parts: readonly Part[], want: readonly Part[], kind: 'paint' | 'trim' | 'glass', normals: Float32Array, plates?: PlateFrames): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  tris.forEach((t, i) => {
    const part = parts[i]!;
    if (!want.includes(part)) return;
    for (let c = 0; c < 9; c++) nor.push(normals[i * 9 + c]!);
    for (const k of t) {
      const v = positions[k]!;
      pos.push(v.x, v.y, v.z);
      if (part === 'plate' && plates) {
        // The plate texture spread over each end's plate (read the right way round from outside).
        const f = v.z >= 0 ? plates.front : plates.rear;
        const u = (v.x - f.x0) / Math.max(1e-6, f.x1 - f.x0);
        const w = (v.y - f.y0) / Math.max(1e-6, f.y1 - f.y0);
        uv.push(PLATE_U0 + (v.z >= 0 ? u : 1 - u) * (PLATE_U1 - PLATE_U0), PLATE_V0 + w * (PLATE_V1 - PLATE_V0));
      } else if (kind === 'trim') uv.push(...(TRIM_UV[part] ?? TRIM_UV.dark!));
      // Glass: planar coordinates, so the cracked panes' texture spreads over the windows.
      else if (kind === 'glass') uv.push((v.z + v.x) * 0.9, v.y * 0.9);
      else uv.push(0, 0);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (kind === 'paint') g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(1), 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** Where each end's number plate lies (vehicle frame): its extent across and up. */
interface PlateFrames {
  front: { x0: number; x1: number; y0: number; y1: number };
  rear: { x0: number; x1: number; y0: number; y1: number };
}

/** The number plates' size (m), as the procedural bodies' (vehicleDetails), and how far they stand off the body. */
const PLATE_W = 0.4;
const PLATE_H = 0.145;
const PLATE_PROUD = 0.01;

/**
 * A plate where it lies: its middle `y` (centred across), how far out along the end its middle face is (`out`, m), its
 * outward lean per metre up (`slope`), and its size.
 */
interface PlatePlace {
  y: number;
  out: number;
  slope: number;
  w: number;
  h: number;
}

/** The plate's two triangles (facing out of the end) and its extent. */
function plateQuad(end: 1 | -1, p: PlatePlace): { tris: Tri[]; frame: PlateFrames['front'] } {
  const h = p.h / 2 / Math.sqrt(1 + p.slope * p.slope);
  const corner = (x: number, oy: number): THREE.Vector3 => new THREE.Vector3(x, p.y + oy, end * (p.out + p.slope * oy));
  const [a, b, c, d] = [corner(-p.w / 2, -h), corner(p.w / 2, -h), corner(p.w / 2, h), corner(-p.w / 2, h)];
  const tris: Tri[] = end > 0 ? [{ p: [a, b, c], part: 'plate' }, { p: [a, c, d], part: 'plate' }] : [{ p: [a, c, b], part: 'plate' }, { p: [a, d, c], part: 'plate' }];
  return { tris, frame: { x0: -p.w / 2, x1: p.w / 2, y0: p.y - h, y1: p.y + h } };
}

/**
 * The model's own plate panel at an end, with the plate laid on it: the largest flat patch of trim (connected faces of
 * one part looking straight out of the end near the middle, in the last 6 % of the length) about the size of a plate.
 * The plate is as big as fits in it, up to PLATE_W x PLATE_H. Null without a panel.
 */
function platePanel(tris: readonly Tri[], length: number, end: 1 | -1): { place: PlatePlace; tris: Tri[]; box: THREE.Box3 } | null {
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const hits: Tri[] = [];
  for (const t of tris) {
    if (t.part !== 'metal' && t.part !== 'dark') continue;
    const cx = (t.p[0].x + t.p[1].x + t.p[2].x) / 3;
    const cz = (t.p[0].z + t.p[1].z + t.p[2].z) / 3;
    if (cz * end < length * 0.44 || Math.abs(cx) > 0.42) continue;
    if (ab.subVectors(t.p[1], t.p[0]).cross(ac.subVectors(t.p[2], t.p[0])).normalize().z * end < 0.85) continue;
    hits.push(t);
  }
  // Patches: faces of one part sharing a corner.
  const root = hits.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i]!)));
  const owner = new Map<string, number>();
  hits.forEach((t, i) => {
    for (const p of t.p) {
      const k = `${t.part}:${Math.round(p.x * 1e3)},${Math.round(p.y * 1e3)},${Math.round(p.z * 1e3)}`;
      const o = owner.get(k);
      if (o === undefined) owner.set(k, i);
      else root[find(o)] = find(i);
    }
  });
  interface Patch {
    box: THREE.Box3;
    area: number;
    normal: THREE.Vector3;
    at: THREE.Vector3;
    tris: Tri[];
  }
  const patches = new Map<number, Patch>();
  hits.forEach((t, i) => {
    const r = find(i);
    let q = patches.get(r);
    if (!q) patches.set(r, (q = { box: new THREE.Box3(), area: 0, normal: new THREE.Vector3(), at: new THREE.Vector3(), tris: [] }));
    for (const p of t.p) q.box.expandByPoint(p);
    const n = ab.subVectors(t.p[1], t.p[0]).cross(ac.subVectors(t.p[2], t.p[0]));
    const a = n.length() / 2;
    q.area += a;
    q.normal.add(n);
    q.at.addScaledVector(t.p[0].clone().add(t.p[1]).add(t.p[2]), a / 3);
    q.tris.push(t);
  });
  // The outermost (a plate panel stands proud of a bumper strip round it).
  let best: Patch | null = null;
  for (const q of patches.values()) {
    const w = q.box.max.x - q.box.min.x;
    const h = q.box.max.y - q.box.min.y;
    if (w < 0.3 || w > 0.8 || h < 0.1 || h > 0.3) continue;
    if (!best || q.box.max.z * end > best.box.max.z * end + 0.005 || (q.box.max.z * end > best.box.max.z * end - 0.005 && q.area > best.area)) best = q;
  }
  if (!best) return null;
  const n = best.normal.normalize();
  const at = best.at.multiplyScalar(1 / best.area);
  const y = (best.box.min.y + best.box.max.y) / 2;
  // The panel's plane as outward distance along the end against height; the plate clears all of the panel's facets.
  const slope = (-n.y / n.z) * end;
  const plane = (px: number, py: number): number => at.z * end + slope * (py - at.y) - (n.x / n.z) * end * (px - at.x);
  let poke = 0;
  for (const t of best.tris) for (const p of t.p) poke = Math.max(poke, p.z * end - plane(p.x, p.y));
  let w = Math.min(PLATE_W, best.box.max.x - best.box.min.x - 0.01);
  let h = (w * PLATE_H) / PLATE_W;
  const room = best.box.max.y - best.box.min.y - 0.005;
  if (h > room) {
    h = room;
    w = (h * PLATE_W) / PLATE_H;
  }
  return { place: { y, out: plane(0, y) + poke + PLATE_PROUD, slope, w, h }, tris: best.tris, box: best.box };
}

/** How far out along an end (m) the first surface is at (x, y): null for none, or for a lamp (its lens is drawn there). */
type EndCast = (x: number, y: number) => number | null;

function endCast(tris: readonly Tri[], half: number, end: 1 | -1): EndCast {
  const near = tris.filter((t) => t.part !== 'glass' && t.p.some((p) => p.z * end > half - 0.8) && t.p.some((p) => Math.abs(p.x) < PLATE_W));
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -end));
  const at = new THREE.Vector3();
  return (x, y) => {
    ray.origin.set(x, y, end * (half + 1));
    let out = -Infinity;
    let part: Part | null = null;
    for (const t of near) {
      if (!ray.intersectTriangle(t.p[0], t.p[1], t.p[2], false, at) || at.z * end <= out) continue;
      out = at.z * end;
      part = t.part;
    }
    return part === null || part === 'head' || part === 'tail' ? null : out;
  };
}

/** The plate's sample grid (fractions of its half size). */
const PLATE_STEPS = [-1, -0.5, 0, 0.5, 1];

/**
 * A panel's plate brought out in front of anything the rays find over it (a plate panel inside a bumper strip, a lip),
 * or null when that would stand it more than 3 cm off, or a lamp is under it.
 */
function clearPlate(cast: EndCast, p: PlatePlace): PlatePlace | null {
  let need = -Infinity;
  for (const sy of PLATE_STEPS) {
    for (const sx of PLATE_STEPS) {
      const oy = (sy * p.h) / 2;
      const o = cast((sx * p.w) / 2, p.y + oy);
      if (o === null) return null;
      need = Math.max(need, o - p.slope * oy + 0.005);
    }
  }
  if (need - p.out > 0.03) return null;
  return { ...p, out: Math.max(p.out, need) };
}

/**
 * A plate where the model has no plate panel: laid on the flattest stretch of the end's outer surface near `yPref`
 * (rays cast at a 5 x 5 grid over the plate), upright or leaning with the surface, clear of every lamp and of `avoid`.
 */
function platePlace(cast: EndCast, yPref: number, yLo: number, yHi: number, avoid: ModelLamp | null): PlatePlace | null {
  const dy = PLATE_H / 2;
  const steps = PLATE_STEPS;
  let pick: { place: PlatePlace; score: number } | null = null;
  for (let y = yLo; y <= yHi + 1e-6; y += 0.02) {
    if (avoid && Math.abs(avoid.at.x) < (PLATE_W + avoid.size[0]) / 2 && Math.abs(avoid.at.y - y) < (PLATE_H + avoid.size[1]) / 2) continue;
    const rows: number[][] = [];
    for (const sy of steps) {
      const row = steps.map((sx) => cast((sx * PLATE_W) / 2, y + sy * dy));
      if (row.some((o) => o === null)) break;
      rows.push(row as number[]);
    }
    if (rows.length < steps.length) continue;
    const mean = rows.map((r) => r.reduce((s, o) => s + o, 0) / r.length);
    // Outward lean per metre up, fitted to the rows (the plate leans with the surface, up to about 37 degrees).
    let num = 0;
    let den = 0;
    steps.forEach((sy, i) => {
      num += sy * dy * (mean[i]! - mean[2]!);
      den += sy * dy * sy * dy;
    });
    const slope = num / den;
    if (Math.abs(slope) > 0.75) continue;
    let poke = -Infinity;
    let dev = 0;
    rows.forEach((r, i) => {
      for (const o of r) {
        const d = o - (mean[2]! + slope * steps[i]! * dy);
        poke = Math.max(poke, d);
        dev = Math.max(dev, Math.abs(d));
      }
    });
    // A plate standing off more than 4 cm anywhere floats.
    if (dev > 0.02) continue;
    const score = dev + 0.4 * Math.abs(y - yPref) + 0.02 * Math.abs(slope);
    if (!pick || score < pick.score) pick = { place: { y, out: mean[2]! + poke + PLATE_PROUD, slope, w: PLATE_W, h: PLATE_H }, score };
  }
  return pick?.place ?? null;
}

/** How dark the cabin's lining is (a vertex shade of the paint). */
const LINER_SHADE = 0.1;

/**
 * Inward-facing, dark copies of the triangles of the cabin's shell (everything but glass and lamps between the beltline
 * and the roof, along the windows), with flipped normals and the paint's attributes.
 */
function linerOf(positions: readonly THREE.Vector3[], tris: ReadonlyArray<readonly [number, number, number]>, parts: readonly Part[], normals: Float32Array, z0: number, z1: number, y0: number, y1: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  tris.forEach((t, i) => {
    const part = parts[i]!;
    if (part === 'glass' || part === 'head' || part === 'tail') return;
    const cy = (positions[t[0]]!.y + positions[t[1]]!.y + positions[t[2]]!.y) / 3;
    const cz = (positions[t[0]]!.z + positions[t[1]]!.z + positions[t[2]]!.z) / 3;
    if (cy < y0 || cy > y1 || cz < z0 || cz > z1) return;
    for (const k of [2, 1, 0]) {
      const v = positions[t[k]!]!;
      pos.push(v.x, v.y, v.z);
      nor.push(-normals[i * 9 + k * 3]!, -normals[i * 9 + k * 3 + 1]!, -normals[i * 9 + k * 3 + 2]!);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(LINER_SHADE), 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Lamps of one part at one end (front: z > 0) on each side: centroid, extent and the area-weighted face normal. (A
 * model's 'Headlights' may hold its white rear lamps too.)
 */
function lampsOf(tris: readonly Tri[], part: Part, front: boolean): ModelLamp[] {
  const out: ModelLamp[] = [];
  for (const side of [1, -1]) {
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    let area = 0;
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    for (const t of tris) {
      if (t.part !== part) continue;
      const cx = (t.p[0].x + t.p[1].x + t.p[2].x) / 3;
      const cz = (t.p[0].z + t.p[1].z + t.p[2].z) / 3;
      if (cx * side < 0 || (cz > 0) !== front) continue;
      ab.subVectors(t.p[1], t.p[0]);
      ac.subVectors(t.p[2], t.p[0]);
      const cr = ab.cross(ac);
      const a = cr.length() / 2;
      if (a <= 0) continue;
      n.add(cr);
      area += a;
      c.addScaledVector(t.p[0].clone().add(t.p[1]).add(t.p[2]).multiplyScalar(1 / 3), a);
    }
    if (area === 0) continue;
    c.multiplyScalar(1 / area);
    n.normalize();
    // The lamp's extent in its own plane: across (level) and up the face.
    const across = new THREE.Vector3(0, 1, 0).cross(n);
    if (across.lengthSq() < 1e-6) across.set(1, 0, 0);
    across.normalize();
    const up = new THREE.Vector3().crossVectors(n, across);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    const d = new THREE.Vector3();
    for (const t of tris) {
      if (t.part !== part) continue;
      const tx = (t.p[0].x + t.p[1].x + t.p[2].x) / 3;
      const tz = (t.p[0].z + t.p[1].z + t.p[2].z) / 3;
      if (tx * side < 0 || (tz > 0) !== front) continue;
      for (const p of t.p) {
        d.subVectors(p, c);
        u0 = Math.min(u0, d.dot(across));
        u1 = Math.max(u1, d.dot(across));
        v0 = Math.min(v0, d.dot(up));
        v1 = Math.max(v1, d.dot(up));
      }
    }
    // Centred on its own extent (the centroid of a wedge-shaped lamp sits off its middle).
    c.addScaledVector(across, (u0 + u1) / 2).addScaledVector(up, (v0 + v1) / 2);
    out.push({ at: c, size: [Math.max(0.08, u1 - u0), Math.max(0.05, v1 - v0)], normal: n, across });
  }
  return out;
}

/** What a ray meets first on the fitted body: the point, the face's normal turned back along the ray, and its part. */
interface Hit {
  readonly at: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly part: Part;
}

/** Casts a ray (origin, unit direction) at the body's triangles that `keep` passes (never its glass). */
type SurfaceCast = (origin: THREE.Vector3, dir: THREE.Vector3) => Hit | null;

function surfaceCast(tris: readonly Tri[], keep: (t: Tri) => boolean): SurfaceCast {
  const list = tris.filter((t) => t.part !== 'glass' && keep(t));
  const ray = new THREE.Ray();
  const at = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  return (origin, dir) => {
    ray.set(origin, dir);
    let best = Infinity;
    let hit: Tri | null = null;
    const p = new THREE.Vector3();
    for (const t of list) {
      if (!ray.intersectTriangle(t.p[0], t.p[1], t.p[2], false, at)) continue;
      const d = at.distanceToSquared(origin);
      if (d >= best) continue;
      best = d;
      hit = t;
      p.copy(at);
    }
    if (!hit) return null;
    const n = new THREE.Vector3().crossVectors(ab.subVectors(hit.p[1], hit.p[0]), ac.subVectors(hit.p[2], hit.p[0])).normalize();
    if (n.dot(dir) > 0) n.negate();
    return { at: p, normal: n, part: hit.part };
  };
}

/** Painted parts, which the fittings may be laid over (the model's own trim keeps its own). */
const PAINTED = (h: Hit | null): h is Hit => h !== null && (h.part === 'paint' || h.part === 'livery');

/**
 * Fittings laid onto an imported body, in the fittings atlas (dark rubber and satin metal): non-indexed triangles with
 * the trim's attributes, merged into its draw. `near` has everything; `far` only what still reads at 40 m and beyond.
 */
class Kit {
  private readonly pos: number[][] = [[], []];
  private readonly nor: number[][] = [[], []];
  private readonly uv: number[][] = [[], []];

  private tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out: THREE.Vector3, cell: 'dark' | 'metal', far: boolean): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.lengthSq() < 1e-14) return;
    // Wound to face `out`.
    const [p, q] = n.dot(out) >= 0 ? [b, c] : [c, b];
    n.normalize().multiplyScalar(Math.sign(n.dot(out)) || 1);
    const [u, v] = TRIM_UV[cell]!;
    for (const k of far ? [0, 1] : [0]) {
      for (const x of [a, p, q]) {
        this.pos[k]!.push(x.x, x.y, x.z);
        this.nor[k]!.push(n.x, n.y, n.z);
        this.uv[k]!.push(u, v);
      }
    }
  }

  /**
   * A patch laid over the body: `grid` is rows of hits (null: nothing there), each lifted `lift` off the surface along
   * its normal; a cell is drawn when its four corners hit paint. Less than `minShare` of its cells drawn (scraps round
   * the model's own trim, cut into by its curves) and none is.
   */
  patch(grid: ReadonlyArray<ReadonlyArray<Hit | null>>, lift: number, cell: 'dark' | 'metal', far: boolean, minShare = 0.6): void {
    const up = (h: Hit): THREE.Vector3 => h.at.clone().addScaledVector(h.normal, lift);
    const cells: Hit[][] = [];
    let all = 0;
    for (let r = 0; r + 1 < grid.length; r++) {
      for (let c = 0; c + 1 < grid[r]!.length; c++) {
        const q = [grid[r]![c], grid[r]![c + 1], grid[r + 1]![c + 1], grid[r + 1]![c]];
        all++;
        if (q.every(PAINTED)) cells.push(q as Hit[]);
      }
    }
    if (cells.length < minShare * all) return;
    for (const h of cells) {
      const out = h.reduce((v, x) => v.add(x.normal), new THREE.Vector3());
      const [a, b, c, d] = h.map(up) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
      this.tri(a, b, c, out, cell, far);
      this.tri(a, c, d, out, cell, far);
    }
  }

  /** A whole geometry (moved into place), every face in `cell`. */
  solid(g: THREE.BufferGeometry, cell: 'dark' | 'metal', far: boolean): void {
    const src = g.index ? g.toNonIndexed() : g;
    const p = src.getAttribute('position');
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const mid = new THREE.Vector3();
    src.computeBoundingBox();
    const centre = src.boundingBox!.getCenter(new THREE.Vector3());
    for (let i = 0; i + 2 < p.count; i += 3) {
      a.fromBufferAttribute(p, i);
      b.fromBufferAttribute(p, i + 1);
      c.fromBufferAttribute(p, i + 2);
      // Closed convex pieces: each face looks away from the piece's middle.
      n.subVectors(b, a).cross(c.clone().sub(a));
      mid.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(centre);
      this.tri(a, b, c, n.dot(mid) >= 0 ? n.clone() : n.clone().negate(), cell, far);
    }
    if (src !== g) src.dispose();
    g.dispose();
  }

  build(far: boolean): THREE.BufferGeometry {
    const k = far ? 1 : 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos[k]!, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor[k]!, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv[k]!, 2));
    return g;
  }
}

/** Spaced samples from a to b, no step longer than `step` (both ends included). */
function steps(a: number, b: number, step: number): number[] {
  const n = Math.max(1, Math.ceil(Math.abs(b - a) / step));
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
}

/** What the fittings are laid round: the lamps, the plates, the body's foot, the wheels and the side windows. */
interface KitFrame {
  readonly head: readonly ModelLamp[];
  readonly tail: readonly ModelLamp[];
  readonly plates: PlateFrames;
  readonly low: number;
  readonly half: number;
  readonly hw: number;
  readonly wheelR: number;
  readonly beltY: number;
  /** z of the front door's rear edge and of the rear door's (a two-door: the one door's, and null). */
  readonly doors: readonly number[];
}

/** Spacing of a fitting's vertices (m): within the refined body's, so dents bend it with the panel under it. */
const KIT_STEP = 0.18;

/**
 * The fittings an imported body is given where its paint runs on (it has none of its own there): a dark grille with
 * satin slats and a top bar between the head lamps, a dark panel under a satin bar joining the tail lamps, a dark
 * valance across the foot of the tail, an exhaust tip (two on the sports and muscle cars), dark sills between the wheel arches, and a door handle at the rear edge of
 * each door. Every piece is laid on the body by rays, a few millimetres proud of it.
 */
function modelKit(kind: VehicleKind, tris: readonly Tri[], f: KitFrame): Kit {
  const kit = new Kit();
  const { half, hw, low } = f;
  const front = surfaceCast(tris, (t) => t.p.some((p) => p.z > half - 1.2));
  const rear = surfaceCast(tris, (t) => t.p.some((p) => p.z < -half + 1.2));
  const fromEnd = (cast: SurfaceCast, end: 1 | -1) => (x: number, y: number): Hit | null => cast(new THREE.Vector3(x, y, end * (half + 1)), new THREE.Vector3(0, 0, -end));
  const atFront = fromEnd(front, 1);
  const atRear = fromEnd(rear, -1);
  // On the ends the pieces follow the body closely (a 5 by 4 cm grid): a coarser one's flat cells cut into the curve
  // of a bumper or a tail panel and showed only in broken scraps.
  const band = (at: (x: number, y: number) => Hit | null, x0: number, x1: number, y0: number, y1: number): Array<Array<Hit | null>> => {
    const xs = steps(x0, x1, 0.05);
    return steps(y0, y1, 0.04).map((y) => xs.map((x) => at(x, y)));
  };
  // The grille: between the head lamps' inner edges, from over the plate to the lamps' tops. The end patches stand
  // 8 mm proud: a dent bends them on their fine grid and the body on its coarser one, and at 4 mm an 8 cm dent sank
  // a third of the sedan's grille under the paint.
  const lampY = f.head.reduce((y, l) => y + l.at.y, 0) / f.head.length;
  const lampH = f.head.reduce((h, l) => h + l.size[1], 0) / f.head.length;
  const inner = Math.min(...f.head.map((l) => Math.abs(l.at.x) - l.size[0] / 2)) - 0.03;
  const gTop = lampY + Math.min(0.05, lampH * 0.3);
  const gBot = Math.max(f.plates.front.y1 + 0.03, lampY - Math.max(0.1, lampH * 0.7));
  if (inner > 0.15 && gTop - gBot > 0.06) {
    const x0 = -inner;
    const x1 = inner;
    kit.patch(band(atFront, x0, x1, gBot, gTop), 0.008, 'dark', true);
    // Satin slats across it and a bar along its top.
    const slats = Math.max(2, Math.floor((gTop - gBot) / 0.045));
    for (let i = 1; i <= slats; i++) {
      const y = gBot + ((gTop - gBot) * i) / (slats + 1);
      kit.patch(band(atFront, x0 + 0.03, x1 - 0.03, y - 0.006, y + 0.006), 0.013, 'metal', false);
    }
    kit.patch(band(atFront, x0, x1, gTop - 0.004, gTop + 0.016), 0.015, 'metal', true);
  }
  const rp = f.plates.rear;
  // A dark valance across the foot of the tail, where its paint runs down square to the end (its corners turn away and
  // left only scraps of it): the lowest height at which a ray along the car meets paint within 30 cm of the end.
  let foot: number | null = null;
  for (let y = low; y < low + 0.45 && foot === null; y += 0.01) {
    const h = atRear(0, y);
    if (PAINTED(h) && h.at.z < -half + 0.3) foot = y;
  }
  if (foot !== null) kit.patch(band(atRear, -hw * 0.5, hw * 0.5, foot + 0.01, foot + 0.1), 0.008, 'dark', true, 0.85);
  // A dark panel joining the tail lamps under a satin bar, so they read as one cluster across the tail (where the
  // panel between them is all paint).
  const tailY = f.tail.reduce((y, l) => y + l.at.y, 0) / f.tail.length;
  const tailH = f.tail.reduce((h, l) => h + l.size[1], 0) / f.tail.length;
  const tIn = Math.min(...f.tail.map((l) => Math.abs(l.at.x) - l.size[0] / 2)) + 0.01;
  const tTop = tailY + tailH * 0.3;
  const tBot = Math.max(tailY - tailH * 0.3, rp.y1 + 0.03);
  if (f.tail.length > 1 && tIn > 0.15 && tTop - tBot > 0.04) {
    kit.patch(band(atRear, -tIn, tIn, tBot, tTop), 0.008, 'dark', true, 0.95);
    kit.patch(band(atRear, -tIn, tIn, tTop - 0.002, tTop + 0.02), 0.013, 'metal', true, 0.95);
  }
  // Exhaust tips 4 cm over the foot of the tail (the lowest height where a ray along the car meets its end): on the
  // right (-x), and both sides on the sports and muscle cars.
  for (const side of kind === 'sports' || kind === 'muscle' ? [-1, 1] : [-1]) {
    const x = side * hw * 0.55;
    let h: Hit | null = null;
    for (let y = low; y < low + 0.45; y += 0.01) {
      const at = atRear(x, y);
      if (!PAINTED(at) || at.at.z > -half + 0.3) continue;
      h = atRear(x, y + 0.04);
      break;
    }
    if (!h) continue;
    const y = h.at.y;
    const pipe = new THREE.CylinderGeometry(0.036, 0.036, 0.09, 10, 1, true);
    pipe.rotateX(Math.PI / 2);
    // Its open end 3.5 cm out of the body.
    pipe.translate(x, y, h.at.z - 0.01);
    kit.solid(pipe, 'metal', false);
  }
  // Dark sills between the wheel arches.
  const z0 = -AXLE * 2 * half + f.wheelR + 0.14;
  const z1 = AXLE * 2 * half - f.wheelR - 0.14;
  const sides = surfaceCast(tris, (t) => t.p.some((p) => p.y < low + 0.3));
  for (const side of [-1, 1]) {
    const at = (z: number, y: number): Hit | null => sides(new THREE.Vector3(side * (hw + 1), y, z), new THREE.Vector3(-side, 0, 0));
    const zs = steps(z0, z1, KIT_STEP);
    kit.patch([0.03, 0.1].map((y) => zs.map((z) => at(z, low + y))), 0.004, 'dark', true);
  }
  // A satin handle at the rear edge of each door, on a dark recess.
  const flank = surfaceCast(tris, (t) => t.p.some((p) => Math.abs(p.y - f.beltY) < 0.4));
  const hy = f.beltY - 0.09;
  for (const side of [-1, 1]) {
    for (const zd of f.doors) {
      const z = zd + 0.16;
      const h = flank(new THREE.Vector3(side * (hw + 1), hy, z), new THREE.Vector3(-side, 0, 0));
      if (!PAINTED(h)) continue;
      // Turned so its depth (x) runs along the panel's level normal.
      const turn = Math.atan2(-h.normal.z, h.normal.x);
      for (const [w, t, d, lift, cell] of [[0.24, 0.055, 0.012, 0.004, 'dark'], [0.19, 0.026, 0.02, 0.012, 'metal']] as const) {
        const g = new THREE.BoxGeometry(d, t, w);
        g.rotateY(turn);
        const c = h.at.clone().addScaledVector(h.normal, lift);
        g.translate(c.x, c.y, c.z);
        kit.solid(g, cell, false);
      }
    }
  }
  return kit;
}

/**
 * Where the doors end (z of each door's rear edge): the side windows are split by the B pillar where the car has
 * rear doors (the widest break in the side glass), and the one door of a two-door ends at its window's foot.
 */
function doorEdges(glass: readonly THREE.Vector3[], cabinHalf: number, yLo: number, fb: number, rb: number): number[] {
  const zs = glass.filter((p) => Math.abs(p.x) > cabinHalf - 0.2 && p.y > yLo + 0.04 && p.y < yLo + 0.3 && p.z < fb - 0.1 && p.z > rb + 0.1).map((p) => p.z);
  zs.sort((a, b) => a - b);
  let gap = 0;
  let at = 0;
  for (let i = 1; i < zs.length; i++) {
    if (zs[i]! - zs[i - 1]! > gap) {
      gap = zs[i]! - zs[i - 1]!;
      at = zs[i - 1]!;
    }
  }
  return gap > 0.05 ? [at + gap / 2, rb] : [rb];
}

/** The model's own trim with the kit's fittings merged into it (one draw). */
function withKit(trim: THREE.BufferGeometry, kit: THREE.BufferGeometry): THREE.BufferGeometry {
  if (kit.getAttribute('position').count === 0) return trim;
  const g = mergeGeometries([trim, kit])!;
  trim.dispose();
  kit.dispose();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function buildModel(kind: VehicleKind, spec: ModelSpec, scene: THREE.Object3D, sockets: Readonly<Record<string, readonly [number, number, number]>>, wheelRadius: number, wheelNodes: Readonly<Record<string, string>>, key: string): CarModel {
  const s = VEHICLE_SPECS[kind];
  const tris = collect(spec, scene, wheelNodes);
  if (!tris.some((t) => t.part === 'glass') || !tris.some((t) => t.part === 'paint')) throw new Error(`${spec.id}: no glass or paint`);
  // The body's extent (everything kept), the ground at the model's own contact (y = 0).
  const box = new THREE.Box3();
  for (const t of tris) for (const p of t.p) box.expandByPoint(p);
  const sx = s.width / (box.max.x - box.min.x);
  const sy = s.height / box.max.y;
  const sz = s.length / (box.max.z - box.min.z);
  const cz = (box.max.z + box.min.z) / 2;
  const cx = (box.max.x + box.min.x) / 2;
  const half = s.length / 2;
  const front = sockets.wheelFL ?? sockets.wheelFR;
  const rear = sockets.wheelRL ?? sockets.wheelRR;
  const zf = front ? (front[2] - cz) * sz : AXLE * s.length;
  const zr = rear ? (rear[2] - cz) * sz : -AXLE * s.length;
  const warp = lengthWarp(half, zr, zf, AXLE * s.length);
  const fit = (v: THREE.Vector3): THREE.Vector3 => v.set((v.x - cx) * sx, v.y * sy, warp((v.z - cz) * sz));
  for (const t of tris) for (const p of t.p) fit(p);
  // Lamps from the fitted lamp parts.
  const head = lampsOf(tris, 'head', true);
  const tail = lampsOf(tris, 'tail', false);
  if (head.length === 0 || tail.length === 0) throw new Error(`${spec.id}: no lamps`);
  // The reverse lamp: the model's white rear lamp (on the left) where it has one, else under the tail lamps' middle.
  const white = lampsOf(tris, 'head', false);
  const tailMid = tail.reduce((v, l) => v.add(l.at), new THREE.Vector3()).multiplyScalar(1 / tail.length);
  const reverse: ModelLamp = white[0] ?? { at: new THREE.Vector3(0, tailMid.y - 0.09, tailMid.z), size: [0.16, 0.06], normal: new THREE.Vector3(0, 0, -1), across: new THREE.Vector3(-1, 0, 0) };
  // Draw parts (lamps are the view's lenses), refined for dents; and the unrefined ones for the far versions.
  // Number plates on both ends, as the procedural bodies carry.
  let low = Infinity;
  for (const t of tris) if (t.part !== 'glass') for (const p of t.p) low = Math.min(low, p.y);
  const plateTris: Tri[] = [];
  const frames: Partial<PlateFrames> = {};
  for (const end of [1, -1] as const) {
    const lamps = end > 0 ? head : tail;
    const lampY = lamps.reduce((y, l) => y + l.at.y, 0) / lamps.length;
    const yPref = end > 0 ? Math.max(low + 0.16, lampY - 0.22) : Math.max(low + 0.2, lampY - 0.25);
    const cast = endCast(tris, half, end);
    const panel = platePanel(tris, s.length, end);
    const onPanel = panel && clearPlate(cast, panel.place);
    const key = end > 0 ? 'front' : 'rear';
    if (!onPanel && panel) {
      const w = panel.box.max.x - panel.box.min.x;
      const h = panel.box.max.y - panel.box.min.y;
      if (w / h > 2.2 && w / h < 3.4) {
        // A plate-shaped panel set into the body, too tight for a plate laid on it: the panel wears the plate.
        for (const t of panel.tris) t.part = 'plate';
        frames[key] = { x0: panel.box.min.x, x1: panel.box.max.x, y0: panel.box.min.y, y1: panel.box.max.y };
        continue;
      }
    }
    const place = onPanel ?? platePlace(cast, yPref, low + 0.09, lampY + 0.02, end < 0 && !white[0] ? reverse : null);
    if (!place) continue;
    const plate = plateQuad(end, place);
    plateTris.push(...plate.tris);
    frames[key] = plate.frame;
  }
  const fill = { x0: -PLATE_W / 2, x1: PLATE_W / 2, y0: 0, y1: PLATE_H };
  const plates: PlateFrames = { front: frames.front ?? fill, rear: frames.rear ?? fill };
  const kept = [...tris.filter((t) => t.part !== 'head' && t.part !== 'tail'), ...plateTris];
  const coarse = weld(kept);
  const coarseNormals = cornerNormals(coarse.positions, coarse.tris, coarse.parts);
  const fine = refine(coarse.positions.map((v) => v.clone()), coarse.tris, coarse.parts, coarseNormals, MAX_EDGE);
  const fineNormals = fine.normals;
  const make = (w: typeof coarse, parts: Part[], kindOf: 'paint' | 'trim' | 'glass'): THREE.BufferGeometry => geometryOf(w.positions, w.tris, w.parts, parts, kindOf, w === fine ? fineNormals : coarseNormals, plates);
  const hasLivery = kept.some((t) => t.part === 'livery');
  // Windows: their side outline and the beltline and roof they sit between.
  const glassPts: THREE.Vector3[] = [];
  for (const t of tris) if (t.part === 'glass') glassPts.push(...t.p);
  let yLo = Infinity;
  let yHi = -Infinity;
  for (const p of glassPts) {
    yLo = Math.min(yLo, p.y);
    yHi = Math.max(yHi, p.y);
  }
  const band = (yHi - yLo) * 0.18;
  let fb = -Infinity;
  let ft = -Infinity;
  let rt = Infinity;
  let rb = Infinity;
  let cabinHalf = 0;
  for (const p of glassPts) {
    if (p.y < yLo + band) {
      fb = Math.max(fb, p.z);
      rb = Math.min(rb, p.z);
      cabinHalf = Math.max(cabinHalf, Math.abs(p.x));
    }
    if (p.y > yHi - band) {
      ft = Math.max(ft, p.z);
      rt = Math.min(rt, p.z);
    }
  }
  // The rear window: glass behind the side windows' rear edge.
  let rwZ = Infinity;
  let rwY = Infinity;
  for (const p of glassPts) {
    if (p.z > rb - 0.1) continue;
    rwZ = Math.min(rwZ, p.z);
    rwY = Math.min(rwY, p.y);
  }
  // The roof's top over the cabin (where roof gear stands) and the body's lowest point.
  let roofTopY = yHi;
  let bottom = Infinity;
  for (const t of kept) {
    for (const p of t.p) {
      if (t.part !== 'glass') bottom = Math.min(bottom, p.y);
      if (Math.abs(p.x) < 0.3 && p.z > rt && p.z < ft && t.part !== 'glass') roofTopY = Math.max(roofTopY, p.y);
    }
  }
  const wheelX = (front ? Math.abs(front[0] - cx) : s.width / 2 - 0.15) * sx;
  const kit = modelKit(kind, tris, { head, tail, plates, low, half, hw: s.width / 2, wheelR: wheelRadius * sy, beltY: yLo, doors: doorEdges(glassPts, cabinHalf, yLo, fb, rb) });
  return {
    kind,
    id: spec.id,
    key,
    scale: [sx, sy, sz],
    paint: make(fine, ['paint'], 'paint'),
    livery: hasLivery ? make(fine, ['livery'], 'paint') : null,
    trim: withKit(make(fine, ['dark', 'metal', 'plate'], 'trim'), kit.build(false)),
    glass: make(fine, ['glass'], 'glass'),
    // Everything from under the beltline up, along the whole car: through the windows a look reaches the bonnet's and
    // the boot lid's insides too.
    liner: linerOf(fine.positions, fine.tris, fine.parts, fineNormals, -Infinity, Infinity, yLo - 0.12, roofTopY + 0.05),
    // (With the cabin's lining, so the far version's windows are as dark a band as the near one's.)
    farPaint: mergeGeometries([make(coarse, ['paint'], 'paint'), linerOf(coarse.positions, coarse.tris, coarse.parts, coarseNormals, -Infinity, Infinity, yLo - 0.12, roofTopY + 0.05)])!,
    farTrim: withKit(make(coarse, ['dark', 'metal', 'plate'], 'trim'), kit.build(true)),
    farGlass: make(coarse, ['glass'], 'glass'),
    head,
    tail,
    reverse,
    wheelR: wheelRadius * sy,
    wheelX,
    cabin: [[fb, yLo], [ft, yHi], [rt, yHi], [rb, yLo]],
    cabinHalf,
    beltY: yLo,
    roofY: yHi - 0.015,
    roofTopY,
    bottom: Number.isFinite(bottom) ? bottom : 0.2,
    rearWindow: Number.isFinite(rwZ) ? { z: rwZ, y: rwY } : null,
  };
}
