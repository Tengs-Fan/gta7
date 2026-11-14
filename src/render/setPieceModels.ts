// The set pieces' models: the Ferris wheel's cabins, braced rims and A-frames and the docks' shipping containers, which
// PropsView places, turns and instances (props.ts buildFerris, buildContainers), and the kit of flat-shaded blocks and
// struts the city's set pieces are built from (city/setPieces.ts: the dock cranes and the Azura Bowl). Geometry and
// textures only. The wheel keeps its meshes and the containers their instanced batches, so neither adds a draw.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng';
import { bar, ModelBuilder } from './furniture';
import { GeoBuilder, type RGB } from './geo';
import { canvas, toTexture } from './textures/misc';

// ---------------------------------------------------------------------------
// The kit: quads wound to face a way, axis-aligned blocks and square struts, every face sampling one texel

export type V = readonly [number, number, number];

/** A quad a, b, c, d (in order round it) wound to face `toward`. */
export function face(g: GeoBuilder, a: V, b: V, c: V, d: V, toward: V, color: RGB, uv: readonly number[]): void {
  const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
  if (n[0]! * toward[0] + n[1]! * toward[1] + n[2]! * toward[2] >= 0) g.quad(...a, ...b, ...c, ...d, uv, color);
  else g.quad(...d, ...c, ...b, ...a, [uv[6]!, uv[7]!, uv[4]!, uv[5]!, uv[2]!, uv[3]!, uv[0]!, uv[1]!], color);
}

/** The same (u, v) at a quad's four corners. */
export const texel = (u: number, v: number): number[] => [u, v, u, v, u, v, u, v];

/** An axis-aligned block, every face outward and sampling `uv`; `skip` names the faces left off (x X y Y z Z: min and max). */
export function block(g: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: RGB, uv: readonly number[], skip = ''): void {
  if (!skip.includes('x')) face(g, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], color, uv);
  if (!skip.includes('X')) face(g, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], color, uv);
  if (!skip.includes('z')) face(g, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], color, uv);
  if (!skip.includes('Z')) face(g, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], color, uv);
  if (!skip.includes('Y')) face(g, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], color, uv);
  if (!skip.includes('y')) face(g, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], color, uv);
}

/** A square strut `w` thick from a to b (its sides and ends), sampling `uv`. */
export function strut(g: GeoBuilder, a: V, b: V, w: number, color: RGB, uv: readonly number[], ends = true): void {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
  const up = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const s = new THREE.Vector3().crossVectors(d, up).normalize().multiplyScalar(w / 2);
  const t = new THREE.Vector3().crossVectors(d, s).normalize().multiplyScalar(w / 2);
  const corner = (p: V, i: number): V => {
    const ks = i === 0 || i === 3 ? -1 : 1;
    const kt = i < 2 ? -1 : 1;
    return [p[0] + s.x * ks + t.x * kt, p[1] + s.y * ks + t.y * kt, p[2] + s.z * ks + t.z * kt];
  };
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const mid = corner(a, i).map((v, k) => (v + corner(a, j)[k]!) / 2 - a[k]!) as unknown as V;
    face(g, corner(a, i), corner(a, j), corner(b, j), corner(b, i), mid, color, uv);
  }
  if (ends) {
    face(g, corner(a, 0), corner(a, 1), corner(a, 2), corner(a, 3), [-d.x, -d.y, -d.z], color, uv);
    face(g, corner(b, 0), corner(b, 1), corner(b, 2), corner(b, 3), [d.x, d.y, d.z], color, uv);
  }
}

// ---------------------------------------------------------------------------
// Shipping containers

/** The container the model is built at (m): its length along local z, width along x, height; the yard's are all this size. */
export const CONTAINER = { len: 12.2, wid: 2.45, h: 2.6 } as const;
/** Metres of wall one repeat of the corrugation texture covers (eight ribs of 0.28 m). */
const RIB_REPEAT = 2.24;
/** The texture's rows: the corrugation below WALL_V, a flat band above it that the frame samples. */
const WALL_V = 0.88;
const FLAT_UV = texel(0.5, 0.95);
/** Vertex tones the instance colour is multiplied by: the walls, the frame's posts and rails, the locking bars, the seam. */
const WALL: RGB = [1, 1, 1];
const FRAME: RGB = [0.72, 0.72, 0.72];
const BARS: RGB = [0.5, 0.5, 0.5];
const SEAM: RGB = [0.18, 0.18, 0.18];

/**
 * A 40 ft container, its foot's middle at the origin and its length along z: corrugated walls set 5 cm into a frame of
 * corner posts and top and bottom rails, the doors at +z with their seam and four locking bars and handles, a roof. The
 * instance colour paints it, the frame a shade darker. 182 triangles (the plain box's 12), inside its collider's box.
 */
export function containerGeometry(): THREE.BufferGeometry {
  const g = new GeoBuilder(true);
  const { len, wid, h } = CONTAINER;
  const hx = wid / 2;
  const hz = len / 2;
  const t = 0.05;
  const post = 0.16;
  const ru = len / RIB_REPEAT;
  const eu = wid / RIB_REPEAT;
  const wv = (y: number) => (y / h) * WALL_V;
  const wallUv = (u: number) => [0, wv(0.16), u, wv(0.16), u, wv(h - 0.12), 0, wv(h - 0.12)];
  // The walls: the long sides and the closed end ribbed across, the roof ribbed along.
  for (const s of [-1, 1]) {
    const x = s * (hx - t);
    face(g, [x, 0.16, -hz + post], [x, 0.16, hz - post], [x, h - 0.12, hz - post], [x, h - 0.12, -hz + post], [s, 0, 0], WALL, wallUv(ru));
  }
  face(g, [-hx + post, 0.16, -hz + t], [hx - post, 0.16, -hz + t], [hx - post, h - 0.12, -hz + t], [-hx + post, h - 0.12, -hz + t], [0, 0, -1], WALL, wallUv(eu));
  face(g, [-hx + post, h - 0.03, -hz + post], [hx - post, h - 0.03, -hz + post], [hx - post, h - 0.03, hz - post], [-hx + post, h - 0.03, hz - post], [0, 1, 0], [0.92, 0.92, 0.92], [0, 0, eu, 0, eu, WALL_V * 0.5, 0, WALL_V * 0.5]);
  // The doors: two leaves ribbed like the walls, the seam between them and the locking bars with their handles.
  const dz = hz - t;
  face(g, [-hx + post, 0.16, dz], [hx - post, 0.16, dz], [hx - post, h - 0.12, dz], [-hx + post, h - 0.12, dz], [0, 0, 1], WALL, wallUv(eu));
  face(g, [-0.015, 0.16, dz + 0.004], [0.015, 0.16, dz + 0.004], [0.015, h - 0.12, dz + 0.004], [-0.015, h - 0.12, dz + 0.004], [0, 0, 1], SEAM, FLAT_UV);
  for (const x of [-0.85, -0.3, 0.3, 0.85]) {
    block(g, x - 0.025, 0.22, dz, x + 0.025, h - 0.18, dz + 0.05, BARS, FLAT_UV, 'zy');
    const hx0 = Math.min(x - 0.03 * Math.sign(x), x + 0.11 * Math.sign(x));
    const hx1 = Math.max(x - 0.03 * Math.sign(x), x + 0.11 * Math.sign(x));
    block(g, hx0, 1.05, dz, hx1, 1.13, dz + 0.05, BARS, FLAT_UV, 'z');
  }
  // The frame: corner posts, top and bottom rails along the sides and across the ends (no faces that only meet others).
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) block(g, sx > 0 ? hx - post : -hx, 0, sz > 0 ? hz - post : -hz, sx > 0 ? hx : -hx + post, h, sz > 0 ? hz : -hz + post, FRAME, FLAT_UV, 'y');
    const x0 = sx > 0 ? hx - 0.1 : -hx;
    const x1 = sx > 0 ? hx : -hx + 0.1;
    block(g, x0, h - 0.12, -hz + post, x1, h, hz - post, FRAME, FLAT_UV, 'zZy');
    block(g, x0, 0, -hz + post, x1, 0.16, hz - post, FRAME, FLAT_UV, 'zZy');
  }
  for (const sz of [-1, 1]) {
    const z0 = sz > 0 ? hz - 0.1 : -hz;
    const z1 = sz > 0 ? hz : -hz + 0.1;
    block(g, -hx + post, h - 0.14, z0, hx - post, h, z1, FRAME, FLAT_UV, 'xXy');
    block(g, -hx + post, 0, z0, hx - post, 0.16, z1, FRAME, FLAT_UV, 'xXy');
  }
  const geo = g.build();
  geo.name = 'container';
  return geo;
}

let containerTex: THREE.CanvasTexture | null = null;

/**
 * The containers' corrugated steel, grey for the instance colour to paint: across u eight trapezoidal ribs (a lit face,
 * the crest, a shaded face, the trough), down v the weather (rust run from the top rail, grime at the foot); a flat band
 * at the top for the frame.
 */
export function containerTexture(): THREE.Texture {
  if (containerTex) return containerTex;
  const W = 128;
  const H = 128;
  const [c, ctx] = canvas(W, H);
  const rng = new Rng(4040);
  const wallH = Math.round(H * WALL_V);
  const rib = W / 8;
  for (let k = 0; k < 8; k++) {
    const x = k * rib;
    for (const [from, w, col] of [[0, 1, '#d2d2d2'], [0.1, 0.18, '#f2f2f2'], [0.28, 0.3, '#e2e2e2'], [0.58, 0.14, '#a5a5a5'], [0.72, 0.28, '#bababa']] as const) {
      ctx.fillStyle = col;
      ctx.fillRect(x + rib * from, H - wallH, rib * w, wallH);
    }
  }
  for (let i = 0; i < 14; i++) {
    const x = rng.range(0, W);
    const len = rng.range(0.15, 0.6) * wallH;
    const gr = ctx.createLinearGradient(0, H - wallH, 0, H - wallH + len);
    gr.addColorStop(0, `rgba(96,52,26,${rng.range(0.25, 0.5).toFixed(2)})`);
    gr.addColorStop(1, 'rgba(96,52,26,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(x, H - wallH, rng.range(1, 3), len);
  }
  const foot = ctx.createLinearGradient(0, H, 0, H - wallH * 0.3);
  foot.addColorStop(0, 'rgba(40,34,28,0.45)');
  foot.addColorStop(1, 'rgba(40,34,28,0)');
  ctx.fillStyle = foot;
  ctx.fillRect(0, H - wallH * 0.3, W, wallH * 0.3);
  ctx.fillStyle = '#c4c4c4';
  ctx.fillRect(0, 0, W, H - wallH);
  containerTex = toTexture(c, true, true);
  containerTex.anisotropy = 4;
  return containerTex;
}

// ---------------------------------------------------------------------------
// The Ferris wheel

/**
 * A gondola hung from its pivot (the origin, on the rim's middle plane): a round cabin 2.2 m across and 2 m tall whose
 * floor is 2.6 m under the pivot (the old box's envelope), its lower body and domed roof in the instance colour, a band
 * of dark glass between them split by six mullions, and the yoke up to the pivot. About 390 triangles.
 */
export function gondolaGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const seg = 10;
  const lathe = (pts: Array<[number, number]>) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  b.add('floor', lathe([[0, -2.6], [0.72, -2.6], [0.98, -2.47], [1.08, -2.22], [1.1, -1.76]]), 0xffffff, 0.92);
  b.add('glass', lathe([[1.1, -1.76], [1.07, -1.02]]), 0x1a2228);
  b.add('roof', lathe([[1.07, -1.02], [1.08, -0.92], [0.98, -0.8], [0.72, -0.68], [0.36, -0.6], [0, -0.58]]), 0xffffff, 1.08);
  b.add('sill', new THREE.TorusGeometry(1.105, 0.035, 4, seg).rotateX(Math.PI / 2).translate(0, -1.76, 0), 0xe8e8e8);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    b.add('mullion', new THREE.BoxGeometry(0.07, 0.76, 0.05).rotateY(-a).translate(Math.cos(a) * 1.09, -1.39, Math.sin(a) * 1.09), 0xffffff, 0.95);
  }
  // The yoke: a short arm on either side of the pivot down to the roof.
  b.add('hanger', bar(new THREE.Vector3(0, 0.05, 0), new THREE.Vector3(0, -0.62, 0), 0.07, 6), 0xd8d8d8);
  b.add('yoke', new THREE.BoxGeometry(0.16, 0.12, 0.9), 0xd8d8d8);
  // The lathes' normals on their axis come out short (0.46 long at the floor's middle): unit length, or they shade wrong.
  const g = b.build('gondola');
  g.normalizeNormals();
  return g;
}

/** The wheel's two rims sit this far (m) either side of its middle plane, and the hub's flanges this far out. */
export const FERRIS_RIM_Z = 1.6;
const FLANGE_Z = 2.1;

/**
 * The wheel, about its hub (local z the axle): two rim tubes 2 FERRIS_RIM_Z apart joined by 32 cross tubes into a
 * ladder truss (one at each gondola's pivot, one midway between), an inner ring each side, 32 tension spokes from the
 * hub's flanges to their rims (the two flanges' half a bay apart), the hub drum and the axle out to `axleHalf` m. No
 * diagonals: a cabin hangs within 0.15 m of the rim's line at 3 and 9 o'clock, and one crossing the middle plane half a
 * bay from its pivot ran through its roof and floor. About 3,400 triangles.
 */
export function ferrisWheelGeometry(R: number, axleHalf: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const P = (a: number, r: number, z: number) => new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, z);
  for (const z of [-FERRIS_RIM_Z, FERRIS_RIM_Z]) {
    parts.push(new THREE.TorusGeometry(R, 0.3, 6, 64).translate(0, 0, z));
    parts.push(new THREE.TorusGeometry(R * 0.35, 0.2, 6, 24).translate(0, 0, z));
  }
  const bays = 32;
  for (let k = 0; k < bays; k++) {
    const a = (k / bays) * Math.PI * 2;
    parts.push(bar(P(a, R, -FERRIS_RIM_Z), P(a, R, FERRIS_RIM_Z), 0.13, 4));
  }
  for (const side of [-1, 1]) {
    for (let k = 0; k < 16; k++) {
      const a = ((k + (side > 0 ? 0 : 0.5)) / 16) * Math.PI * 2;
      parts.push(bar(P(a, 1.3, side * FLANGE_Z), P(a, R, side * FERRIS_RIM_Z), 0.06, 4));
    }
  }
  // The hub: a drum between two flanges, and the axle through it.
  parts.push(new THREE.CylinderGeometry(1.05, 1.05, 2 * FLANGE_Z, 16).rotateX(Math.PI / 2));
  for (const z of [-FLANGE_Z, FLANGE_Z]) parts.push(new THREE.CylinderGeometry(1.5, 1.5, 0.22, 16).rotateX(Math.PI / 2).translate(0, 0, z));
  parts.push(new THREE.CylinderGeometry(0.55, 0.55, 2 * axleHalf, 12).rotateX(Math.PI / 2));
  return mergedPlain(parts);
}

/** The A-frames' legs are octagonal tubes this thick at the foot and at the hub (m). */
const LEG_R0 = 0.5;
const LEG_R1 = 0.36;
/** One leg's tube: 8 sides, no caps (its foot in the sea, its head in the hub); non-indexed, so 48 vertices. */
export const LEG_VERTICES = 48;

/**
 * The wheel's two A-frames in the legs' frame (origin at the prop, local z the axle): each leg an octagonal tube cut
 * level at both ends, from its foot `sink` m down at x = +-`out` to the hub `rise` m up, at z = +-`legZ`; then the
 * bracing, all of it clear of the deck: a tie across each A-frame 15 m up (over the cabins' sweep, which keeps between
 * the frames), and on either side of the deck struts between the front and back legs at the deck, 9 and 18 m up with
 * crossed diagonals between them. The four legs come first, LEG_VERTICES each.
 */
export function ferrisLegsGeometry(out: number, sink: number, rise: number, legZ: number): THREE.BufferGeometry {
  const legs: THREE.BufferGeometry[] = [];
  /** The leg's centre line's x at height y (0 at the hub). */
  const xAt = (y: number) => out * (1 - (y + sink) / (rise + sink));
  for (const z of [-legZ, legZ]) {
    for (const sx of [-1, 1]) {
      const pos: number[] = [];
      const nrm: number[] = [];
      // Each vertex's normal points straight out from the leg's axis, so the octagon shades round.
      const ring = (y: number, r: number, k: number) => {
        const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
        pos.push(sx * xAt(y) + Math.cos(a) * r, y, z + Math.sin(a) * r);
        nrm.push(Math.cos(a), 0, Math.sin(a));
      };
      for (let k = 0; k < 8; k++) {
        ring(-sink, LEG_R0, k);
        ring(rise, LEG_R1, k + 1);
        ring(-sink, LEG_R0, k + 1);
        ring(-sink, LEG_R0, k);
        ring(rise, LEG_R1, k);
        ring(rise, LEG_R1, k + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      legs.push(g);
    }
  }
  const brace: THREE.BufferGeometry[] = [];
  const at = (sx: number, y: number, z: number) => new THREE.Vector3(sx * xAt(y), y, z);
  for (const z of [-legZ, legZ]) brace.push(bar(at(-1, 15, z), at(1, 15, z), 0.2, 8));
  for (const sx of [-1, 1]) {
    const levels = [0.2, 9, 18];
    for (const y of levels) brace.push(bar(at(sx, y, -legZ), at(sx, y, legZ), 0.16, 6));
    for (let i = 0; i + 1 < levels.length; i++) {
      brace.push(bar(at(sx, levels[i]!, -legZ), at(sx, levels[i + 1]!, legZ), 0.11, 6));
      brace.push(bar(at(sx, levels[i]!, legZ), at(sx, levels[i + 1]!, -legZ), 0.11, 6));
    }
  }
  return mergedPlain([...legs, ...brace]);
}

/** Merges geometries into one non-indexed geometry with position, normal and a zero uv. */
function mergedPlain(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.getAttribute('position').count * 2), 2));
    return n;
  });
  const m = mergeGeometries(prepared, false);
  if (!m) throw new Error('mergeGeometries failed');
  return m;
}

