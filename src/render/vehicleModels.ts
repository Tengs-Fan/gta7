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
 * chunky cabins) clash with the Quaternius characters, and its sedan, taxi, van and fire truck do not fit the specs
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
    try {
      m = buildModel(kind, spec, t.scene, t.entry.sockets ?? {}, t.entry.wheelRadius ?? 0.33, t.entry.wheelNodes ?? {}, key);
    } catch {
      // A model that cannot be split as expected is drawn procedurally.
      m = null;
    }
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

/** Conforming refinement: every edge longer than `maxEdge` is halved (for both its triangles) until none is. */
function refine(positions: THREE.Vector3[], tris: Array<[number, number, number]>, parts: Part[], maxEdge: number): { positions: THREE.Vector3[]; tris: Array<[number, number, number]>; parts: Part[] } {
  let T = tris;
  let P = parts;
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
    T.forEach(([a, b, c], t) => {
      const part = P[t]!;
      const ab = mid.get(key(a, b));
      const bc = mid.get(key(b, c));
      const ca = mid.get(key(c, a));
      const emit = (x: number, y: number, z: number): void => {
        NT.push([x, y, z]);
        NP.push(part);
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
  }
  return { positions, tris: T, parts: P };
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
 * crisp (as the model was drawn), however the refinement split its faces.
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

/**
 * The model's number plates: trim faces that look straight out of an end, near the middle, in the last 6 % of the
 * length (marked 'plate', so they wear the plate texture). Returns each end's plate extent, or null without a plate.
 */
function findPlates(tris: Tri[], length: number): PlateFrames | null {
  const frames: Partial<PlateFrames> = {};
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (const end of [1, -1] as const) {
    const hits: Tri[] = [];
    for (const t of tris) {
      if (t.part !== 'metal' && t.part !== 'dark') continue;
      const cx = (t.p[0].x + t.p[1].x + t.p[2].x) / 3;
      const cz = (t.p[0].z + t.p[1].z + t.p[2].z) / 3;
      if (cz * end < length * 0.44 || Math.abs(cx) > 0.42) continue;
      const n = ab.subVectors(t.p[1], t.p[0]).cross(ac.subVectors(t.p[2], t.p[0])).normalize();
      if (n.z * end < 0.85) continue;
      hits.push(t);
    }
    // A plate is a small flat rectangle, about 0.2-0.7 m wide.
    const b = new THREE.Box3();
    for (const t of hits) for (const p of t.p) b.expandByPoint(p);
    const w = b.max.x - b.min.x;
    const h = b.max.y - b.min.y;
    if (hits.length === 0 || w < 0.2 || w > 0.7 || h < 0.06 || h > 0.4) continue;
    for (const t of hits) t.part = 'plate';
    frames[end > 0 ? 'front' : 'rear'] = { x0: b.min.x, x1: b.max.x, y0: b.min.y, y1: b.max.y };
  }
  if (!frames.front && !frames.rear) return null;
  const fill = { x0: -0.2, x1: 0.2, y0: 0, y1: 0.15 };
  return { front: frames.front ?? fill, rear: frames.rear ?? fill };
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
  const plates = findPlates(tris, s.length) ?? undefined;
  const kept = tris.filter((t) => t.part !== 'head' && t.part !== 'tail');
  const coarse = weld(kept);
  const fine = refine(coarse.positions.map((v) => v.clone()), coarse.tris, coarse.parts, MAX_EDGE);
  const fineNormals = cornerNormals(fine.positions, fine.tris, fine.parts);
  const coarseNormals = cornerNormals(coarse.positions, coarse.tris, coarse.parts);
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
  return {
    kind,
    id: spec.id,
    key,
    scale: [sx, sy, sz],
    paint: make(fine, ['paint'], 'paint'),
    livery: hasLivery ? make(fine, ['livery'], 'paint') : null,
    trim: make(fine, ['dark', 'metal', 'plate'], 'trim'),
    glass: make(fine, ['glass'], 'glass'),
    // Everything from under the beltline up, along the whole car: through the windows a look reaches the bonnet's and
    // the boot lid's insides too.
    liner: linerOf(fine.positions, fine.tris, fine.parts, fineNormals, -Infinity, Infinity, yLo - 0.12, roofTopY + 0.05),
    // (With the cabin's lining, so the far version's windows are as dark a band as the near one's.)
    farPaint: mergeGeometries([make(coarse, ['paint'], 'paint'), linerOf(coarse.positions, coarse.tris, coarse.parts, coarseNormals, -Infinity, Infinity, yLo - 0.12, roofTopY + 0.05)])!,
    farTrim: make(coarse, ['dark', 'metal', 'plate'], 'trim'),
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
