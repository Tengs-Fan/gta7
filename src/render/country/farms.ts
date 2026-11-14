// Las Lomas County's farmsteads (world/country/farms.ts), drawn only: their colliders are the barns' garage walls and
// roofs, the farmhouses' buildings, the props' and the hedgerows'. The barns' gambrel roofs and gables in ribbed tin over
// the garages' slabs (structures.ts draws the walls and slabs), their trim, hay hoods, loft doors and cupolas; what the
// farmhouses (city houses the city draws plain) wear: plinths, porches, front doors and chimneys; the dairy's stave silos,
// the corrugated grain bins, the windpump's tower and stock tank, the signs, mailboxes and ladders: one draw over the
// four farms, its tin, staves, doors and boards painted on a small atlas of its own (city/attractions.ts Atlas). The
// hedgerows are a second, which the camera sees through where one stands between it and what it frames; the farmyards'
// and drives' dirt a third; the windpump's wheel turns in the wind.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { V3 } from '../../core/math';
import { Rng } from '../../core/rng';
import { HEDGE_H, STOCK_TANK, type FarmId, type Farmstead } from '../../world/country/farms';
import { makeRayHit, type StaticCollider } from '../../world/colliders';
import { rectCX, rectCZ, type Rect } from '../../world/layout';
import { GARAGE_EAVE, GARAGE_ROOF } from '../../world/staticWorld';
import { Atlas, boxC, face, tri, type V } from '../city/attractions';
import { prism } from '../city/rooftops';
import { GeoBuilder, hexToRgb, scaleRgb, type RGB } from '../geo';
import { fadeNearCamera } from '../props';
import { groundTexture } from '../textures';
import { canvas, noise, toTexture } from '../textures/misc';
import type { CountryView } from './index';

/** Each farm's sign by its drive: lines of [text, px, colour] on its board's colour. */
const SIGNS: Readonly<Record<FarmId, { lines: ReadonlyArray<readonly [string, number, string]>; bg: string }>> = {
  bottoms: { lines: [['HOLLISTER BOTTOMS', 104, '#f6ecd8'], ['THE OTHER HOLLISTER FARM.', 50, '#f2c14e'], ["WE DON'T TALK ABOUT IT.", 44, '#f6ecd8']], bg: '#6e1e16' },
  dairy: { lines: [['CUD & SONS DAIRY', 110, '#1f3a5c'], ['EST. WHENEVER.', 56, '#1f3a5c']], bg: '#f3efe4' },
  orchard: { lines: [['PIPPIN HOLLOW', 104, '#fbf3e2'], ['PICK YOUR OWN.', 50, '#f2c14e'], ['PAY FOR WHAT YOU PICK.', 46, '#fbf3e2']], bg: '#3f5a2a' },
  acres: { lines: [['HALFMOON ACRES', 108, '#2b2416'], ['WHEAT. SUNFLOWERS. BEIGE.', 52, '#2b2416']], bg: '#e8c04a' },
};
/** The barns' roofs and the paint their gables' trim takes. */
const BARN_ROOF: Readonly<Record<FarmId, number>> = { bottoms: 0x5b5651, dairy: 0x3f4a52, orchard: 0x6b6259, acres: 0x5b5651 };
export const WHITE: RGB = [0.93, 0.91, 0.86];
export const WOOD: RGB = [0.48, 0.34, 0.21];
const STEEL: RGB = [0.7, 0.72, 0.74];

/** A square beam from a to b, `t` thick. */
export function beam(g: GeoBuilder, a: V, b: V, t: number, color: RGB): void {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
  const side = new THREE.Vector3().crossVectors(d, Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(t / 2);
  const up = new THREE.Vector3().crossVectors(side, d).normalize().multiplyScalar(t / 2);
  const at = (p: V, s: number, u: number): V => [p[0] + side.x * s + up.x * u, p[1] + side.y * s + up.y * u, p[2] + side.z * s + up.z * u];
  for (const [s0, u0, s1, u1] of [[1, 1, 1, -1], [1, -1, -1, -1], [-1, -1, -1, 1], [-1, 1, 1, 1]] as const) {
    const out: V = [side.x * (s0 + s1) + up.x * (u0 + u1), side.y * (s0 + s1) + up.y * (u0 + u1), side.z * (s0 + s1) + up.z * (u0 + u1)];
    face(g, at(a, s0, u0), at(a, s1, u1), at(b, s1, u1), at(b, s0, u0), out, color);
  }
}

/** How far the ridge cap's top stands over a gambrel's ridge (m): where the crows perched along a ridge stand (life/flocks.ts). */
export const RIDGE_CAP = 0.05;

/** The tin band repeats every TIN_TILE m along a sheet's run, a seam every 0.375 m. */
export const TIN_TILE = 12;

/** The farms' painted surfaces, each on the atlas of the mesh that uses them (the county's farmsteads', the valley's). */
export interface FarmBands {
  /** Ribbed tin, a neutral grey the vertex colour tints, weathered toward its foot (v[0]): barn roofs and gables, porch roofs. */
  tin: [number, number];
  /** Two front doors in its first quarter: a green one (u 0 to DOOR_U) and a red one (DOOR_U to twice it). */
  door: [number, number];
}

/** A door's width in the door band's u: 1.1 m of a 2.3 m tall door on a 256 px band of a 1024 px atlas. */
export const DOOR_U = 0.12;

/** Rows each painted surface's band repeats past its top and its foot, so filtering at its edges never reaches its neighbour's. */
const PAD = 4;

/**
 * A band `h` px tall painted by `draw` (unlit), with its first and last rows repeated PAD px past either edge: a band's
 * neighbour on an atlas is another surface, or the transparent black round two doors, and a roof's eaves sampled at
 * v[0] would take half of it, a dark line that widens with distance as the mipmaps blur it. Its v range is the inner h px.
 */
export function paddedBand(atlas: Atlas, h: number, draw: (ctx: CanvasRenderingContext2D) => void): [number, number] {
  const [c, cctx] = canvas(1024, h);
  draw(cctx);
  const v = atlas.band(h + 2 * PAD, (ctx) => {
    ctx.drawImage(c, 0, PAD);
    ctx.drawImage(c, 0, 0, 1024, 1, 0, 0, 1024, PAD);
    ctx.drawImage(c, 0, h - 1, 1024, 1, 0, h + PAD, 1024, PAD);
  });
  const k = (v[1] - v[0]) / (h + 2 * PAD);
  return [v[0] + PAD * k, v[1] - PAD * k];
}

/** Ribbed tin on `atlas` (FarmBands.tin), TIN_TILE m to the band's width. */
export function tinBand(atlas: Atlas): [number, number] {
  return paddedBand(atlas, 128, (ctx) => {
    const rng = new Rng(4419);
    ctx.fillStyle = '#d6d6d4';
    ctx.fillRect(0, 0, 1024, 128);
    // Streaks down the sheets, and the stain the rain leaves along the eaves.
    for (let k = 0; k < 90; k++) {
      const l = rng.int(170, 230);
      const y = rng.range(0, 90);
      ctx.fillStyle = `rgba(${l},${l},${l - 6},0.5)`;
      ctx.fillRect(rng.range(0, 1024), y, rng.range(2, 8), 128 - y);
    }
    const stain = ctx.createLinearGradient(0, 0, 0, 128);
    stain.addColorStop(0, 'rgba(70,46,28,0)');
    stain.addColorStop(0.6, 'rgba(70,46,28,0.05)');
    stain.addColorStop(1, 'rgba(70,46,28,0.3)');
    ctx.fillStyle = stain;
    ctx.fillRect(0, 0, 1024, 128);
    // The seams: a dark groove beside a bright crest every 32 px, so the band tiles along u.
    for (let x = 0; x < 1024; x += 32) {
      ctx.fillStyle = 'rgba(50,50,50,0.55)';
      ctx.fillRect(x, 0, 2, 128);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(x + 2, 0, 3, 128);
    }
  });
}

export function farmBands(atlas: Atlas): FarmBands {
  const tin = tinBand(atlas);
  const door = atlas.band(256, (ctx) => {
    const w = DOOR_U * 1024;
    for (const [k, paint] of [[0, '#2f4a3a'], [1, '#7a2a22']] as const) {
      const x = k * w;
      ctx.fillStyle = paint;
      ctx.fillRect(x, 0, w, 256);
      // Four lights over two raised panels, a brass knob.
      ctx.fillStyle = '#2a3238';
      ctx.fillRect(x + 16, 18, w - 32, 92);
      ctx.fillStyle = '#dfe6e8';
      ctx.fillRect(x + w / 2 - 2, 18, 4, 92);
      ctx.fillRect(x + 16, 62, w - 32, 4);
      for (const y of [128, 190]) {
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(x + 16, y, w - 32, 50);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x + 20, y + 4, w - 40, 42);
      }
      ctx.fillStyle = '#d8b44a';
      ctx.beginPath();
      ctx.arc(x + w - 16, 132, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  return { tin, door };
}

/** A quad painted with band `v` (its a-b edge on v[0]), u running from 0 at a to `u1` at b. */
function paint(g: GeoBuilder, a: V, b: V, c: V, d: V, toward: V, color: RGB, v: readonly [number, number], u1: number, u0 = 0): void {
  face(g, a, b, c, d, toward, color, [u0, v[0], u1, v[0], u1, v[1], u0, v[1]]);
}

/** A triangle with uvs `uv` (a, b, c's), its winding put right to face `toward`. */
function paintTri(g: GeoBuilder, a: V, b: V, c: V, toward: V, color: RGB, uv: readonly [number, number, number, number, number, number]): void {
  const n = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).cross(new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]));
  if (n.x * toward[0] + n.y * toward[1] + n.z * toward[2] >= 0) g.tri(...a, ...b, ...c, uv, color);
  else g.tri(...c, ...b, ...a, [uv[4], uv[5], uv[2], uv[3], uv[0], uv[1]], color);
}

/** Trim in white, or in a dark green on a whitewashed barn, where white would not show. */
const trimFor = (wall: RGB): RGB => (wall[0] + wall[1] + wall[2] > 2.1 ? [0.2, 0.27, 0.24] : WHITE);

/**
 * A gambrel roof over the barn `r` from `eaves` up, its ridge along x (`alongX`) or z: the steep lower pitches to the
 * knees, the shallow upper ones to the ridge, overhanging the walls by `over`, in ribbed tin; the end walls in the same
 * tin tinted `wall`; a cap along the ridge, and boards in `trim` up the rakes and along the eaves.
 */
function gambrel(g: GeoBuilder, painted: GeoBuilder, tin: readonly [number, number], r: Rect, eaves: number, alongX: boolean, roof: RGB, wall: RGB, trim: RGB, over = GARAGE_EAVE + 0.1): void {
  const hw = (alongX ? r.maxZ - r.minZ : r.maxX - r.minX) / 2;
  const c = alongX ? rectCZ(r) : rectCX(r);
  const [l0, l1] = alongX ? [r.minX - over, r.maxX + over] : [r.minZ - over, r.maxZ + over];
  const run = (l1 - l0) / TIN_TILE;
  // Across the span: the eaves, the knee and the ridge.
  const profile: Array<[number, number]> = [[-(hw + over), eaves - 0.12], [-hw * 0.6, eaves + hw * 0.62], [0, eaves + hw * 0.86], [hw * 0.6, eaves + hw * 0.62], [hw + over, eaves - 0.12]];
  const P = (along: number, across: number, y: number): V => (alongX ? [along, y, c + across] : [c + across, y, along]);
  // The lower pitches take the band's foot, stained along the eaves, the upper ones the rest of it up to the ridge.
  const knee = tin[0] + (tin[1] - tin[0]) * 0.55;
  for (let k = 0; k < 4; k++) {
    const [a0, y0] = profile[k]!;
    const [a1, y1] = profile[k + 1]!;
    const nx = -(y1 - y0);
    const ny = a1 - a0;
    const n: V = alongX ? [0, ny, nx] : [nx, ny, 0];
    // From the lower edge up the slope: on the near side the slope rises from a0 to a1, on the far side from a1 to a0.
    const [lo, hi] = k < 2 ? [a0, a1] : [a1, a0];
    const [ylo, yhi] = k < 2 ? [y0, y1] : [y1, y0];
    const v: [number, number] = k === 0 || k === 3 ? [tin[0], knee] : [knee, tin[1]];
    paint(painted, P(l0, lo, ylo), P(l1, lo, ylo), P(l1, hi, yhi), P(l0, hi, yhi), n, roof, v, run);
  }
  beam(g, P(l0 - 0.04, 0, profile[2]![1] + RIDGE_CAP - 0.07), P(l1 + 0.04, 0, profile[2]![1] + RIDGE_CAP - 0.07), 0.14, scaleRgb(roof, 0.7));
  for (const s of [-1, 1]) {
    const a = s * (hw + over + 0.02);
    beam(g, P(l0, a, eaves - 0.2), P(l1, a, eaves - 0.2), 0.2, trim);
  }
  // The end walls: a pentagon at either end, in three triangles, set in from the roof's ends; the rake boards over them.
  const [e0, e1] = alongX ? [r.minX - 0.02, r.maxX + 0.02] : [r.minZ - 0.02, r.maxZ + 0.02];
  const rise = hw * 0.86 + 0.12;
  for (const [e, s, l] of [[e0, -1, l0], [e1, 1, l1]] as const) {
    const q = (a: number, y: number) => P(e, a * (hw / (hw + over)), y);
    const out: V = alongX ? [s, 0, 0] : [0, 0, s];
    const pts = profile.map(([a, y]) => q(a, y));
    const uv = (k: number): [number, number] => {
      const [a, y] = profile[k]!;
      return [(a * (hw / (hw + over))) / TIN_TILE, tin[0] + ((y - (eaves - 0.12)) / rise) * (tin[1] - tin[0])];
    };
    const [u0, v0] = uv(0);
    const [u4] = uv(4);
    const [u1, v1] = uv(1);
    const [u2, v2] = uv(2);
    const [u3, v3] = uv(3);
    paintTri(painted, pts[0]!, pts[4]!, pts[3]!, out, wall, [u0, v0, u4, v0, u3, v3]);
    paintTri(painted, pts[0]!, pts[3]!, pts[1]!, out, wall, [u0, v0, u3, v3, u1, v1]);
    paintTri(painted, pts[1]!, pts[3]!, pts[2]!, out, wall, [u1, v1, u3, v3, u2, v2]);
    const ro = l + s * 0.06;
    for (let k = 0; k < 4; k++) beam(g, P(ro, profile[k]![0], profile[k]![1] + 0.04), P(ro, profile[k + 1]![0], profile[k + 1]![1] + 0.04), 0.24, trim);
  }
}

/**
 * A barn's roof (of colour `roofColor`, in `bands`' tin), its gable trim, the header over its open doors and the loft
 * door over them under a hay hood, boards at its four corners, and, if `cupola`, a louvred cupola on its ridge with a
 * weathervane (not on the barns whose ridges the crows perch along, life/flocks.ts).
 */
export function barn(g: GeoBuilder, painted: GeoBuilder, tin: readonly [number, number], f: Pick<Farmstead, 'barn' | 'door'>, height: number, color: number, roofColor: number, cupola: boolean): void {
  const r = f.barn;
  const top = height + GARAGE_ROOF;
  const alongX = f.door === 'E' || f.door === 'W';
  const wall = hexToRgb(color);
  const roof = hexToRgb(roofColor);
  const trim = trimFor(wall);
  gambrel(g, painted, tin, r, top, alongX, roof, wall, trim);
  for (const x of [r.minX, r.maxX]) for (const z of [r.minZ, r.maxZ]) boxC(g, x - 0.16, 0, z - 0.16, x + 0.16, top, z + 0.16, trim);
  // The front: a header over the doors; the loft door, braced with an X, under the hood that keeps the hay dry.
  const front = f.door === 'E' ? r.maxX : f.door === 'W' ? r.minX : f.door === 'S' ? r.maxZ : r.minZ;
  const out = f.door === 'E' || f.door === 'S' ? 1 : -1;
  const hw = (alongX ? r.maxZ - r.minZ : r.maxX - r.minX) / 2;
  const c = alongX ? rectCZ(r) : rectCX(r);
  const at = (a: number, y: number, o = 0): V => (alongX ? [front + out * (0.06 + o), y, c + a] : [c + a, y, front + out * (0.06 + o)]);
  const n: V = alongX ? [out, 0, 0] : [0, 0, out];
  face(g, at(-hw, height - 0.7), at(hw, height - 0.7), at(hw, height), at(-hw, height), n, trim);
  const y0 = top + 0.6;
  const y1 = top + hw * 0.55;
  face(g, at(-1.4, y0), at(1.4, y0), at(1.4, y1), at(-1.4, y1), n, [0.16, 0.1, 0.08]);
  for (const s of [-1, 1]) face(g, at(-1.4 * s - 0.1, y0, 0.02), at(-1.4 * s + 0.1, y0, 0.02), at(1.4 * s + 0.1, y1, 0.02), at(1.4 * s - 0.1, y1, 0.02), n, trim);
  face(g, at(-1.5, y0 - 0.12), at(1.5, y0 - 0.12), at(1.5, y0), at(-1.5, y0), n, trim);
  for (const s of [-1, 1]) face(g, at(s * 1.5 - 0.06, y0), at(s * 1.5 + 0.06, y0), at(s * 1.5 + 0.06, y1 + 0.1), at(s * 1.5 - 0.06, y1 + 0.1), n, trim);
  face(g, at(-1.5, y1), at(1.5, y1), at(1.5, y1 + 0.12), at(-1.5, y1 + 0.12), n, trim);
  // The hood: the roof's peak carried out over the loft door at its upper pitch, the hay track's beam under its ridge.
  const ridge = top + hw * 0.86;
  const hoodLen = 1.7;
  const hoodW = Math.min(1.9, hw * 0.3);
  const hoodY = ridge + 0.02;
  const fall = hoodW * (0.24 / 0.6);
  for (const s of [-1, 1]) {
    const a: V = at(0, hoodY, -0.1);
    const b: V = at(0, hoodY, hoodLen);
    const cc: V = at(s * hoodW, hoodY - fall, hoodLen);
    const d: V = at(s * hoodW, hoodY - fall, -0.1);
    const up: V = alongX ? [0, 1, s * 0.4] : [s * 0.4, 1, 0];
    paint(painted, d, cc, b, a, up, roof, [tin[0], tin[0] + (tin[1] - tin[0]) * 0.3], hoodLen / TIN_TILE);
    face(g, at(0, hoodY - 0.06, -0.1), at(0, hoodY - 0.06, hoodLen), at(s * hoodW, hoodY - fall - 0.06, hoodLen), at(s * hoodW, hoodY - fall - 0.06, -0.1), [-up[0], -1, -up[2]], scaleRgb(wall, 0.55));
    beam(g, at(s * (hoodW + 0.04), hoodY - fall - 0.04, hoodLen + 0.06), at(0, hoodY + 0.04, hoodLen + 0.06), 0.18, trim);
  }
  tri(g, at(-hoodW, hoodY - fall - 0.06, hoodLen), at(hoodW, hoodY - fall - 0.06, hoodLen), at(0, hoodY - 0.06, hoodLen), n, scaleRgb(wall, 0.8));
  beam(g, at(0, hoodY - fall - 0.3, -0.1), at(0, hoodY - fall - 0.3, hoodLen - 0.15), 0.16, [0.3, 0.22, 0.15]);
  if (!cupola) return;
  // The cupola: a louvred box straddling the ridge at its middle, its own pyramid roof, a weathervane with its arrow.
  const mx = rectCX(r);
  const mz = rectCZ(r);
  const cw = Math.min(1.1, hw * 0.16);
  const cy0 = ridge - 0.5;
  const cy1 = ridge + 1.3;
  boxC(g, mx - cw, cy0, mz - cw, mx + cw, cy1, mz + cw, trim === WHITE ? wall : WHITE);
  const louvre: RGB = [0.14, 0.11, 0.09];
  for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const P = (s: number, y: number): V => [mx + nx * (cw + 0.01) + nz * s * cw * 0.7, y, mz + nz * (cw + 0.01) - nx * s * cw * 0.7];
    face(g, P(-1, ridge + 0.1), P(1, ridge + 0.1), P(1, cy1 - 0.25), P(-1, cy1 - 0.25), [nx, 0, nz], louvre);
  }
  for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const e = cw + 0.25;
    const a: V = [mx + nx * e - nz * e, cy1, mz + nz * e + nx * e];
    const b: V = [mx + nx * e + nz * e, cy1, mz + nz * e - nx * e];
    paintTri(painted, a, b, [mx, cy1 + cw * 1.3, mz], [nx, 0.8, nz], roof, [0, tin[0], 0.15, tin[0], 0.075, tin[1]]);
  }
  const vane = cy1 + cw * 1.3;
  boxC(g, mx - 0.025, vane, mz - 0.025, mx + 0.025, vane + 1.2, mz + 0.025, IRON);
  beam(g, [mx - 0.55, vane + 0.9, mz + 0.2], [mx + 0.55, vane + 0.9, mz - 0.2], 0.035, IRON);
  tri(g, [mx + 0.55, vane + 0.78, mz - 0.2], [mx + 0.55, vane + 1.02, mz - 0.2], [mx + 0.8, vane + 0.9, mz - 0.29], [0.34, 0, 0.94], IRON);
  tri(g, [mx + 0.55, vane + 1.02, mz - 0.2], [mx + 0.55, vane + 0.78, mz - 0.2], [mx + 0.8, vane + 0.9, mz - 0.29], [-0.34, 0, -0.94], IRON);
  face(g, [mx - 0.55, vane + 0.75, mz + 0.2], [mx - 0.3, vane + 0.75, mz + 0.11], [mx - 0.3, vane + 1.05, mz + 0.11], [mx - 0.55, vane + 1.05, mz + 0.2], [0.34, 0, 0.94], IRON);
  face(g, [mx - 0.55, vane + 0.75, mz + 0.2], [mx - 0.3, vane + 0.75, mz + 0.11], [mx - 0.3, vane + 1.05, mz + 0.11], [mx - 0.55, vane + 1.05, mz + 0.2], [-0.34, 0, -0.94], IRON);
  for (const [dx, dz] of [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]] as const) beam(g, [mx, vane + 0.45, mz], [mx + dx, vane + 0.45, mz + dz], 0.03, IRON);
}

const IRON: RGB = [0.16, 0.16, 0.17];

/** The barns whose ridges the crows perch along (life/flocks.ts): no cupola in their way. */
const CROWS_ON_RIDGE: ReadonlySet<FarmId> = new Set(['acres', 'bottoms']);

/** Which wall of each farmhouse its porch and door are on: the one facing into the yard, toward where the drive comes in. */
const HOUSE_FRONT: Readonly<Record<FarmId, 'N' | 'S'>> = { bottoms: 'N', dairy: 'N', orchard: 'N', acres: 'S' };
/** A farmhouse porch: its depth (m) out from the wall, the deck's height, its roof's height at the wall and at the front. */
export const PORCH: PorchSpec = { y0: 0, depth: 2.6, deck: 0.55, high: 3.45, low: 3.05, inset: 1.0, steps: 3 };

/** Where a farmhouse's porch stands as drawn (decoration only): along `front`, inset from the corners, out to its steps' foot, its roof 0.25 m past the deck either side. */
export function porchRect(house: Rect, front: 'N' | 'S'): Rect {
  const z0 = front === 'S' ? house.maxZ : house.minZ - PORCH.depth - 0.9;
  const z1 = front === 'S' ? house.maxZ + PORCH.depth + 0.9 : house.minZ;
  return { minX: house.minX + PORCH.inset - 0.25, minZ: z0, maxX: house.maxX - PORCH.inset + 0.25, maxZ: z1 };
}

export function farmhouseFront(id: FarmId): 'N' | 'S' {
  return HOUSE_FRONT[id];
}

/** A porch's shape: its foot's height, depth out from the wall, deck height over its foot, its roof's height at the wall and at the front (over its foot), its inset from the house's corners, and the steps down from its deck. */
export interface PorchSpec {
  y0: number;
  depth: number;
  deck: number;
  high: number;
  low: number;
  inset: number;
  steps: number;
}

/**
 * A farmhouse porch along the `front` wall of `house`: the deck on its dark skirting, steps down from its middle, posts
 * along its front edge with a top and a bottom rail and balusters between them, open at the steps; a tin roof, painted
 * boards under it and a fascia board along its front.
 */
export function farmPorch(g: GeoBuilder, painted: GeoBuilder, tin: readonly [number, number], house: Rect, front: 'N' | 'S', P: PorchSpec): void {
  const { minX, maxX } = house;
  const out = front === 'S' ? 1 : -1;
  const wz = front === 'S' ? house.maxZ : house.minZ;
  const x0 = minX + P.inset;
  const x1 = maxX - P.inset;
  const cx = (minX + maxX) / 2;
  const deck: RGB = [0.56, 0.44, 0.32];
  const z = (o: number) => wz + out * o;
  const zr = (a: number, b: number): [number, number] => [Math.min(z(a), z(b)), Math.max(z(a), z(b))];
  const top = P.y0 + P.deck;
  {
    const [za, zb] = zr(0, P.depth);
    boxC(g, x0, P.y0, za, x1, top - 0.1, zb, [0.24, 0.2, 0.17]);
    boxC(g, x0 - 0.05, top - 0.1, za, x1 + 0.05, top, zb, deck);
  }
  for (let s = 0; s < P.steps; s++) {
    const [za, zb] = zr(P.depth, P.depth + 0.3 * (s + 1));
    boxC(g, cx - 0.95, P.y0, za, cx + 0.95, P.y0 + (P.deck * (P.steps - s)) / (P.steps + 1), zb, scaleRgb(deck, 0.92 - s * 0.04));
  }
  const posts = Math.max(3, Math.round((x1 - x0) / 2.6) + 1);
  const postAt = (i: number) => x0 + 0.12 + ((x1 - x0 - 0.24) * i) / (posts - 1);
  const pz = z(P.depth - 0.12);
  // Up to the roof's boards where it passes over them, falling from `high` at the wall to `low` 0.35 m past the deck.
  const postTop = P.y0 + P.high - ((P.high - P.low) * (P.depth - 0.12)) / (P.depth + 0.35);
  for (let i = 0; i < posts; i++) boxC(g, postAt(i) - 0.08, top, pz - 0.08, postAt(i) + 0.08, postTop, pz + 0.08, WHITE);
  const railRun = (xa: number, xb: number, zz: number, alongX: boolean) => {
    for (const y of [top + 0.12, top + 0.9]) {
      if (alongX) boxC(g, xa, y - 0.04, zz - 0.04, xb, y + 0.04, zz + 0.04, WHITE);
      else boxC(g, zz - 0.04, y - 0.04, xa, zz + 0.04, y + 0.04, xb, WHITE);
    }
    for (let a = xa + 0.18; a < xb - 0.1; a += 0.32) {
      if (alongX) boxC(g, a - 0.025, top + 0.12, zz - 0.025, a + 0.025, top + 0.9, zz + 0.025, WHITE);
      else boxC(g, zz - 0.025, top + 0.12, a - 0.025, zz + 0.025, top + 0.9, a + 0.025, WHITE);
    }
  };
  railRun(postAt(0), cx - 1.0, pz, true);
  railRun(cx + 1.0, postAt(posts - 1), pz, true);
  const [sa, sb] = zr(0.1, P.depth - 0.2);
  for (const x of [postAt(0), postAt(posts - 1)]) railRun(sa, sb, x, false);
  const roof: RGB = [0.36, 0.4, 0.42];
  const rw = (x1 - x0 + 0.5) / TIN_TILE;
  const A: V = [x0 - 0.25, P.y0 + P.high, wz];
  const B: V = [x1 + 0.25, P.y0 + P.high, wz];
  const C: V = [x1 + 0.25, P.y0 + P.low, z(P.depth + 0.35)];
  const D: V = [x0 - 0.25, P.y0 + P.low, z(P.depth + 0.35)];
  paint(painted, D, C, B, A, [0, 1, out * 0.15], roof, tin, rw);
  face(g, A, B, C, D, [0, -1, 0], [0.86, 0.84, 0.78]);
  const [za, zb] = zr(P.depth + 0.3, P.depth + 0.4);
  boxC(g, x0 - 0.25, P.y0 + P.low - 0.25, za, x1 + 0.25, P.y0 + P.low + 0.02, zb, WHITE);
}

/**
 * What the county's farmhouses (city houses of their own, which the city draws plain) wear: a stone plinth, corner boards,
 * a porch along the front (farmPorch), the front door behind it, and a brick chimney up through the roof by one end of the
 * ridge (the city's gable runs along the longer side).
 */
function farmhouse(g: GeoBuilder, painted: GeoBuilder, bands: FarmBands, house: Rect, eaves: number, front: 'N' | 'S', k: number): void {
  const { minX, minZ, maxX, maxZ } = house;
  // The plinth's top a few centimetres under the deck's, which runs over its edge along the front.
  const plinth = PORCH.deck - 0.03;
  boxC(g, minX - 0.07, 0, minZ - 0.07, maxX + 0.07, plinth, maxZ + 0.07, [0.5, 0.47, 0.42]);
  for (const x of [minX, maxX]) for (const z of [minZ, maxZ]) boxC(g, x - 0.12, plinth, z - 0.12, x + 0.12, eaves - 0.15, z + 0.12, WHITE);
  farmPorch(g, painted, bands.tin, house, front, PORCH);
  const out = front === 'S' ? 1 : -1;
  const wz = front === 'S' ? maxZ : minZ;
  const cx = (minX + maxX) / 2;
  const zr = (a: number, b: number): [number, number] => [Math.min(wz + out * a, wz + out * b), Math.max(wz + out * a, wz + out * b)];
  // The front door, in its casing, and a lamp beside it.
  const dz = wz + out * 0.04;
  const du = (k % 2) * DOOR_U;
  paint(painted, [cx - 0.55, PORCH.deck, dz], [cx + 0.55, PORCH.deck, dz], [cx + 0.55, PORCH.deck + 2.3, dz], [cx - 0.55, PORCH.deck + 2.3, dz], [0, 0, out], [1, 1, 1], bands.door, out > 0 ? du + DOOR_U : du, out > 0 ? du : du + DOOR_U);
  {
    const [za, zb] = zr(0, 0.09);
    for (const s of [-1, 1]) boxC(g, cx + s * 0.65 - 0.1, PORCH.deck, za, cx + s * 0.65 + 0.1, PORCH.deck + 2.5, zb, WHITE);
    boxC(g, cx - 0.8, PORCH.deck + 2.4, za, cx + 0.8, PORCH.deck + 2.6, zb, WHITE);
    const [la, lb] = zr(0, 0.22);
    boxC(g, cx + 1.0, PORCH.deck + 1.75, la, cx + 1.18, PORCH.deck + 2.05, lb, [0.12, 0.11, 0.1]);
  }
  // The chimney, through the roof a quarter of the way along its ridge.
  const w = maxX - minX;
  const d = maxZ - minZ;
  const ridge = eaves + Math.min(w, d) * 0.35;
  const brick: RGB = [0.52, 0.25, 0.19];
  const [chx, chz] = w >= d ? [minX + w * 0.25, (minZ + maxZ) / 2] : [(minX + maxX) / 2, minZ + d * 0.25];
  boxC(g, chx - 0.5, eaves, chz - 0.38, chx + 0.5, ridge + 1.1, chz + 0.38, brick);
  boxC(g, chx - 0.6, ridge + 1.1, chz - 0.48, chx + 0.6, ridge + 1.25, chz + 0.48, [0.45, 0.43, 0.4]);
}

/** A farm's sign: a board on two posts by its drive, facing (sin rot, cos rot). */
export function sign(g: GeoBuilder, painted: GeoBuilder, f: Pick<Farmstead, 'sign'>, v: readonly [number, number]): void {
  const { x, z, rot } = f.sign;
  const ax = Math.cos(rot);
  const az = -Math.sin(rot);
  const fx = Math.sin(rot);
  const fz = Math.cos(rot);
  const w = 3.4;
  for (const s of [-1, 1]) boxC(g, x + ax * s * 1.55 - 0.07, 0, z + az * s * 1.55 - 0.07, x + ax * s * 1.55 + 0.07, 2.7, z + az * s * 1.55 + 0.07, WOOD);
  const P = (s: number, y: number, o: number): V => [x + ax * s * (w / 2) + fx * o, y, z + az * s * (w / 2) + fz * o];
  face(painted, P(-1, 1.1, 0.1), P(1, 1.1, 0.1), P(1, 2.6, 0.1), P(-1, 2.6, 0.1), [fx, 0, fz], [1, 1, 1], [0, v[0], 1, v[0], 1, v[1], 0, v[1]]);
  face(g, P(1, 1.1, 0.08), P(-1, 1.1, 0.08), P(-1, 2.6, 0.08), P(1, 2.6, 0.08), [-fx, 0, -fz], WOOD);
}

/** A mailbox on its post by the road, its flag up. */
export function mailbox(g: GeoBuilder, x: number, z: number): void {
  boxC(g, x - 0.05, 0, z - 0.05, x + 0.05, 1.05, z + 0.05, WOOD);
  boxC(g, x - 0.14, 1.05, z - 0.26, x + 0.14, 1.3, z + 0.26, [0.3, 0.32, 0.34]);
  boxC(g, x + 0.14, 1.12, z + 0.05, x + 0.17, 1.42, z + 0.09, [0.75, 0.12, 0.1]);
}

/**
 * A drum of `n` sides round (x, z), radius r from y0 to y1, its quads mapped by `uv(k, y0, y1)` (k the side), counter-
 * clockwise seen from outside.
 */
function drum(g: GeoBuilder, x: number, z: number, r: number, y0: number, y1: number, n: number, color: RGB, uv: (k: number, y0: number, y1: number) => number[]): void {
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const b = ((k + 1) / n) * Math.PI * 2;
    g.quad(x + Math.cos(b) * r, y0, z + Math.sin(b) * r, x + Math.cos(a) * r, y0, z + Math.sin(a) * r, x + Math.cos(a) * r, y1, z + Math.sin(a) * r, x + Math.cos(b) * r, y1, z + Math.sin(b) * r, uv(k, y0, y1), color);
  }
}

/** A stave silo's lift: STAVE_LIFT m of concrete staves, half a stave's offset course over course, a steel hoop round its top. */
function staveBand(atlas: Atlas): [number, number] {
  return paddedBand(atlas, 128, (ctx) => {
    const rng = new Rng(4423);
    ctx.fillStyle = '#c9c4b8';
    ctx.fillRect(0, 0, 1024, 128);
    // Two courses of staves, 32 px wide, each its own shade, mortar between them.
    for (let c = 0; c < 2; c++) {
      for (let k = 0; k < 33; k++) {
        const x = k * 32 - (c % 2) * 16;
        const l = rng.int(184, 214);
        ctx.fillStyle = `rgb(${l},${l - 4},${l - 12})`;
        ctx.fillRect(x + 1, 12 + c * 58, 30, 56);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x + 1, 12 + c * 58, 3, 56);
      }
    }
    // The hoop, its shadow under it, and a rust run down from a lug here and there.
    ctx.fillStyle = '#5c5f62';
    ctx.fillRect(0, 2, 1024, 7);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 9, 1024, 3);
    for (let x = 64; x < 1024; x += 256) {
      ctx.fillStyle = '#3e3f40';
      ctx.fillRect(x, 0, 10, 12);
      ctx.fillStyle = 'rgba(120,70,30,0.25)';
      ctx.fillRect(x + 2, 12, 5, rng.int(30, 110));
    }
  });
}

/** A stave silo's lift (m), and the staves' band's width round it. */
const STAVE_LIFT = 1.6;
const STAVE_TILE = 8;

/** A stave silo: concrete staves in lifts under their hoops, on a footing, a domed cap, the chute down one side. */
function silo(g: GeoBuilder, painted: GeoBuilder, v: readonly [number, number], x: number, z: number, r: number, h: number): void {
  const n = 22;
  const round = Math.max(1, Math.round((2 * Math.PI * r) / STAVE_TILE));
  for (let y = 0; y < h - 1e-3; y += STAVE_LIFT) {
    const y1 = Math.min(h, y + STAVE_LIFT);
    const vt = v[0] + ((v[1] - v[0]) * (y1 - y)) / STAVE_LIFT;
    drum(painted, x, z, r, y, y1, n, [1, 1, 1], (k) => [((k + 1) / n) * round, v[0], (k / n) * round, v[0], (k / n) * round, vt, ((k + 1) / n) * round, vt]);
  }
  prism(g, x, z, r + 0.08, r + 0.08, 0, 0.5, n, [0.6, 0.58, 0.54], false);
  prism(g, x, z, r + 0.06, r * 0.7, h, h + 1.2, n, [0.36, 0.42, 0.45], false);
  prism(g, x, z, r * 0.7, 0, h + 1.2, h + 2.1, n, [0.36, 0.42, 0.45], false);
  boxC(g, x + r - 0.1, 0, z - 0.4, x + r + 0.7, h + 0.6, z + 0.4, [0.62, 0.6, 0.56]);
}

/**
 * A grain bin: corrugated steel (the tin band turned on its side, so its ribs run round the bin a tenth of a metre apart),
 * on a concrete ring, under a cone roof whose ribs run down from the vent, a ring at the eaves and a ladder up it.
 */
function grainBin(g: GeoBuilder, painted: GeoBuilder, bands: FarmBands, x: number, z: number, r: number, h: number): void {
  const n = 24;
  const t = bands.tin;
  // A quarter of the band's height round each side, from its top, where the streaks are faint and no stain runs.
  const va = t[1] - (t[1] - t[0]) * 0.25;
  drum(painted, x, z, r, 0, h, n, STEEL, (_k, y0, y1) => [y0 / 3, va, y0 / 3, t[1], y1 / 3, t[1], y1 / 3, va]);
  prism(g, x, z, r + 0.12, r + 0.12, -0.1, 0.25, n, [0.66, 0.64, 0.6], true);
  prism(g, x, z, r + 0.05, r + 0.05, h - 0.12, h + 0.04, n, scaleRgb(STEEL, 0.75), false);
  // The roof: a cone of tin, its seams running down it.
  const top = h + r * 0.75;
  const run = Math.max(1, Math.round((2 * Math.PI * (r + 0.15)) / TIN_TILE));
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const b = ((k + 1) / n) * Math.PI * 2;
    const ro = r + 0.15;
    const ri = 0.45;
    painted.quad(x + Math.cos(b) * ro, h, z + Math.sin(b) * ro, x + Math.cos(a) * ro, h, z + Math.sin(a) * ro, x + Math.cos(a) * ri, top, z + Math.sin(a) * ri, x + Math.cos(b) * ri, top, z + Math.sin(b) * ri, [((k + 1) / n) * run, t[0], (k / n) * run, t[0], (k / n) * run * 0.2, t[1], ((k + 1) / n) * run * 0.2, t[1]], scaleRgb(STEEL, 1.06));
  }
  prism(g, x, z, 0.45, 0.3, top, top + 0.5, 10, scaleRgb(STEEL, 0.9));
  for (const dx of [-0.22, 0.22]) boxC(g, x + dx - 0.03, 0, z + r + 0.08, x + dx + 0.03, h, z + r + 0.14, [0.3, 0.3, 0.32]);
  for (let y = 0.4; y < h; y += 0.4) boxC(g, x - 0.22, y, z + r + 0.09, x + 0.22, y + 0.035, z + r + 0.13, [0.3, 0.3, 0.32]);
  // The hatch at its foot, to the ladder's side.
  boxC(g, x - 0.45, 0.35, z + r - 0.02, x + 0.45, 1.25, z + r + 0.05, scaleRgb(STEEL, 0.8));
}

/** The windpump's tower of four splayed legs and its braces, the platform, the tail vane, the stock tank beside it. */
function windpump(g: GeoBuilder, x: number, z: number, h: number): void {
  const galv: RGB = [0.62, 0.64, 0.66];
  const foot = 1.1;
  const head = 0.25;
  const leg = (sx: number, sz: number, y: number): V => {
    const k = y / h;
    const s = foot + (head - foot) * k;
    return [x + sx * s, y, z + sz * s];
  };
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
  for (const [sx, sz] of corners) beam(g, leg(sx, sz, 0), leg(sx, sz, h), 0.09, galv);
  for (let y = 1.5; y < h; y += 2.2) {
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k]!;
      const [bx, bz] = corners[(k + 1) % 4]!;
      beam(g, leg(ax, az, y), leg(bx, bz, y + 2.2 < h ? y + 2.2 : h), 0.05, galv);
    }
  }
  boxC(g, x - 0.6, h, z - 0.6, x + 0.6, h + 0.1, z + 0.6, WOOD);
  // The gearbox, and the tail vane out behind the wheel (which faces +z).
  boxC(g, x - 0.2, h + 0.1, z - 0.4, x + 0.2, h + 0.55, z + 0.3, galv);
  beam(g, [x, h + 0.35, z - 0.3], [x, h + 0.35, z - 2.6], 0.06, galv);
  face(g, [x - 0.02, h + 0.05, z - 1.9], [x - 0.02, h + 0.05, z - 2.9], [x - 0.02, h + 1.1, z - 2.9], [x - 0.02, h + 0.8, z - 1.9], [-1, 0, 0], [0.82, 0.2, 0.16]);
  face(g, [x + 0.02, h + 0.05, z - 2.9], [x + 0.02, h + 0.05, z - 1.9], [x + 0.02, h + 0.8, z - 1.9], [x + 0.02, h + 1.1, z - 2.9], [1, 0, 0], [0.82, 0.2, 0.16]);
  // The stock tank: an open steel ring, dark inside, the water a little under its rim.
  const t = STOCK_TANK;
  const tx = x + t.dx;
  prism(g, tx, z, t.r, t.r, 0, t.h, 20, galv, false);
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const b = ((i + 1) / 20) * Math.PI * 2;
    const ri = t.r - 0.05;
    face(g, [tx + Math.cos(a) * ri, 0, z + Math.sin(a) * ri], [tx + Math.cos(b) * ri, 0, z + Math.sin(b) * ri], [tx + Math.cos(b) * ri, t.h, z + Math.sin(b) * ri], [tx + Math.cos(a) * ri, t.h, z + Math.sin(a) * ri], [-Math.cos((a + b) / 2), 0, -Math.sin((a + b) / 2)], scaleRgb(galv, 0.55));
    g.tri(tx, t.h - 0.15, z, tx + Math.cos(b) * ri, t.h - 0.15, z + Math.sin(b) * ri, tx + Math.cos(a) * ri, t.h - 0.15, z + Math.sin(a) * ri, [0.5, 0.5, 1, 0, 0, 1], [0.2, 0.28, 0.3]);
  }
}

/** A ladder leaning on an apple tree: its foot at (x, z), leaning along (sin rot, cos rot). */
function ladder(g: GeoBuilder, x: number, z: number, rot: number): void {
  const fx = Math.sin(rot);
  const fz = Math.cos(rot);
  const ax = Math.cos(rot) * 0.22;
  const az = -Math.sin(rot) * 0.22;
  const top: V = [x + fx * 0.95, 2.9, z + fz * 0.95];
  for (const s of [-1, 1]) beam(g, [x + ax * s, 0, z + az * s], [top[0] + ax * s, top[1], top[2] + az * s], 0.05, WOOD);
  for (let k = 1; k < 9; k++) {
    const t = k / 9;
    const p: V = [x + fx * 0.95 * t, 2.9 * t, z + fz * 0.95 * t];
    beam(g, [p[0] - ax, p[1], p[2] - az], [p[0] + ax, p[1], p[2] + az], 0.035, WOOD);
  }
}

/** A hedgerow's leaves: dark and light greens, with a few twigs and gaps. */
function hedgeTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#2f4f22';
  ctx.fillRect(0, 0, 256, 256);
  const rng = new Rng(4417);
  for (let k = 0; k < 1400; k++) {
    const g = rng.int(60, 120);
    ctx.fillStyle = `rgb(${Math.round(g * 0.55)},${g},${Math.round(g * 0.35)})`;
    ctx.beginPath();
    ctx.ellipse(rng.range(0, 256), rng.range(0, 256), rng.range(3, 7), rng.range(2, 4), rng.range(0, Math.PI), 0, Math.PI * 2);
    ctx.fill();
  }
  noise(ctx, 256, 256, rng, 18, 2);
  return toTexture(c);
}

/** A hedgerow's cross-section, from the foot on one side over the top to the other: (across, up) as fractions of its half-thickness and height. */
const HEDGE_PROFILE: ReadonlyArray<readonly [number, number]> = [[-0.9, -0.05], [-1, 0.5], [-0.55, 0.97], [0.55, 0.97], [1, 0.5], [0.9, -0.05]];

/**
 * A hedgerow along `h`: pillows 1.6 to 3.2 m long, each overlapping the last by a third, a little thicker or thinner,
 * taller or lower than its neighbours and tapering to its ends, so the run reads as clipped shrubs rather than a wall
 * (20,080 triangles for the county's and the valley's hedgerows, 5,630 of them the pillows' closed ends, against the
 * 5,020 of the boxes and lumps they were).
 * Its leaves' uvs are projected on the run's length and the profile's height.
 */
function hedgeRun(g: GeoBuilder, rng: Rng, h: Rect): void {
  const alongX = h.maxX - h.minX > h.maxZ - h.minZ;
  const len = alongX ? h.maxX - h.minX : h.maxZ - h.minZ;
  const mid = alongX ? (h.minZ + h.maxZ) / 2 : (h.minX + h.maxX) / 2;
  const half = (alongX ? h.maxZ - h.minZ : h.maxX - h.minX) / 2;
  const start = alongX ? h.minX : h.minZ;
  const P = (along: number, across: number, y: number): V => (alongX ? [start + along, y, mid + across] : [mid + across, y, start + along]);
  const n = HEDGE_PROFILE.length;
  const pillows: Array<{ a: number; l: number; t: number; top: number; lean: number }> = [];
  for (let a = -0.2; a < len - 0.3; ) {
    const l = Math.min(len + 0.2 - a, rng.range(1.6, 3.2));
    pillows.push({ a, l, t: half * rng.range(0.94, 1.1), top: HEDGE_H + rng.range(-0.18, 0.22), lean: rng.range(-0.12, 0.12) });
    a += l * rng.range(0.6, 0.72);
  }
  pillows.forEach(({ a, l, t, top, lean }) => {
    // Three rings along the pillow: its ends at 80 % of its middle's size.
    const ring = (along: number, f: number): V[] => HEDGE_PROFILE.map(([u, v]) => P(along, u * t * f + lean * v, v * top * (0.86 + 0.14 * f)));
    const rings = [ring(a, 0.8), ring(a + l / 2, 1), ring(a + l, 0.8)];
    for (let r = 0; r < 2; r++) {
      const r0 = rings[r]!;
      const r1 = rings[r + 1]!;
      for (let i = 0; i + 1 < n; i++) {
        const [u0, v0] = HEDGE_PROFILE[i]!;
        const [u1, v1] = HEDGE_PROFILE[i + 1]!;
        const out: V = alongX ? [0, u0 + u1 === 0 ? 1 : (v0 + v1) * 0.4, u0 + u1] : [u0 + u1, u0 + u1 === 0 ? 1 : (v0 + v1) * 0.4, 0];
        const s0 = (a + (r * l) / 2) / 3;
        const s1 = (a + ((r + 1) * l) / 2) / 3;
        const w0 = (v0 * top + Math.abs(u0) * t) / 3;
        const w1 = (v1 * top + Math.abs(u1) * t) / 3;
        face(g, r0[i]!, r1[i]!, r1[i + 1]!, r0[i + 1]!, out, [1, 1, 1], [s0, w0, s1, w0, s1, w1, s0, w1]);
      }
    }
    // Both its ends closed: neighbours differ in thickness, height and lean, so an open end pokes out past the next
    // pillow and shows the sky through the hedge. The end ring is convex, so a fan from its first corner closes it,
    // the foot's edge too, in four triangles.
    for (const [end, s] of [[0, -1], [2, 1]] as const) {
      const e = rings[end]!;
      const toward: V = alongX ? [s, 0, 0] : [0, 0, s];
      const uv = (i: number): [number, number] => [HEDGE_PROFILE[i]![0] * 0.3, HEDGE_PROFILE[i]![1] * 0.7];
      for (let i = 1; i + 1 < n; i++) paintTri(g, e[0]!, e[i]!, e[i + 1]!, toward, [1, 1, 1], [...uv(0), ...uv(i), ...uv(i + 1)]);
    }
  });
}

/** Within this distance (m) of the sight line from the camera to what it frames a hedgerow is gone, from twice it whole. */
const HEDGE_OPEN = 1;
/** Seconds the opening takes to grow to its full size, or to close, as a hedgerow comes into the sight line or leaves it. */
const HEDGE_EASE = 0.2;

/** The camera, the subject it frames, and how far open (0..1) the hedgerows between them are. */
export interface SightUniforms {
  uSightCam: { value: THREE.Vector3 };
  uSightSubject: { value: THREE.Vector3 };
  uSightOpen: { value: number };
}

/**
 * A hedgerow's material: the foliage's near-camera dissolve (props.ts fadeNearCamera, which gives the world position
 * vFadeWorld and the dither), and, since the camera looks through a hedgerow rather than stopping at it
 * (world/colliders.ts blocksCamera), an opening round the sight line from the camera to the subject it frames while a
 * hedgerow stands between them (FarmsView.sight). A hedge beyond the subject, the one he faces, stays whole.
 */
function seeThrough(mat: THREE.Material, sight: SightUniforms): void {
  fadeNearCamera(mat);
  const fade = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    fade.call(mat, shader, renderer);
    Object.assign(shader.uniforms, sight);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSightCam;\nuniform vec3 uSightSubject;\nuniform float uSightOpen;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
if ( uSightOpen > 0.0 ) {
  vec3 sight = uSightSubject - uSightCam;
  float along = dot( vFadeWorld - uSightCam, sight ) / dot( sight, sight );
  float off = distance( vFadeWorld, uSightCam + sight * along );
  float open = uSightOpen * ${HEDGE_OPEN.toFixed(2)};
  if ( along < 1.0 && fadeBayer4( gl_FragCoord.xy ) >= smoothstep( open, open * 2.0, off ) ) discard;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'gta7-hedge';
}

const isHedge = (c: StaticCollider): boolean => c.tag === 'hedge';

export class FarmsView {
  /** The windpumps' wheels, turning about their hubs' z axes. */
  private readonly wheels: THREE.Mesh[] = [];
  /** The farmsteads' material: the headlights light it (valley.ts ValleyView.lit), for the porches' decks and steps a car comes up to. */
  readonly material: THREE.MeshStandardMaterial;
  private turn = 0;
  private last = 0;
  /** The camera, its subject and how far open the hedgerows are, which sight() drives. */
  readonly sightUniforms: SightUniforms = { uSightCam: { value: new THREE.Vector3() }, uSightSubject: { value: new THREE.Vector3() }, uSightOpen: { value: 0 } };
  private readonly hit = makeRayHit();

  constructor(private readonly view: CountryView) {
    const layout = view.world.layout;
    const farms = layout.country.farms;
    const g = new GeoBuilder(true);
    const painted = new GeoBuilder(true);
    const atlas = new Atlas(2048);
    const blank = atlas.band(8, (ctx) => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 1024, 8);
    });
    const bands = farmBands(atlas);
    const stave = staveBand(atlas);
    farms.farmsteads.forEach((f, k) => {
      const gar = layout.garages.find((q) => q.poi === `${f.id}_barn`)!;
      barn(g, painted, bands.tin, f, gar.height, gar.color, BARN_ROOF[f.id], !CROWS_ON_RIDGE.has(f.id));
      const house = layout.buildings.find((b) => b.id === f.house)!;
      farmhouse(g, painted, bands, house.rect, house.height, HOUSE_FRONT[f.id], k);
    });
    for (const f of farms.farmsteads) {
      const s = SIGNS[f.id];
      sign(g, painted, f, atlas.board(s.lines, s.bg, 220));
      mailbox(g, f.mailbox.x, f.mailbox.z);
    }
    for (const p of layout.props.slice(layout.country.firstProp)) {
      if (p.kind === 'silo') silo(g, painted, stave, p.x, p.z, p.w / 2, p.h);
      if (p.kind === 'grainbin') grainBin(g, painted, bands, p.x, p.z, p.w / 2, p.h);
      if (p.kind === 'windpump') windpump(g, p.x, p.z, p.h);
    }
    for (const l of farms.ladders) ladder(g, l.x, l.z, l.rot);
    const decor = g.build();
    const uv = decor.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, (blank[0] + blank[1]) / 2);
    const geo = mergeGeometries([decor, painted.build()], false)!;
    decor.dispose();
    // Repeating along u, so the tin runs on along a roof; every band spans the atlas's width.
    const map = toTexture(atlas.canvas, true, false);
    map.wrapS = THREE.RepeatWrapping;
    this.material = new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.8 });
    view.add(geo, this.material, { shadow: true, name: 'farmsteads', split: false });

    // The hedgerows: overlapping pillows of leaves along each, so its sides bulge and its top rolls.
    const hedges = new GeoBuilder(false);
    const rng = new Rng(4418);
    for (const h of [...farms.hedges, ...layout.country.valley.hedges]) hedgeRun(hedges, rng, h);
    const hedgeMat = new THREE.MeshStandardMaterial({ map: hedgeTexture(), roughness: 0.95 });
    seeThrough(hedgeMat, this.sightUniforms);
    view.add(hedges.build(), hedgeMat, { shadow: true, name: 'hedgerows', split: false });

    // The farmyards' and the drives' dirt, just over the grass; a drive follows the ground out to the road.
    const dirt = new GeoBuilder(false);
    const dirtUv = { kind: 'world', scale: 6 } as const;
    const y = (x: number, z: number) => view.world.baseGround(x, z) + 0.008;
    /** A drive's strip, `step` m at a time, each quad at the ground's height. */
    const driveStrip = (drive: readonly [number, number, number, number], step: number): void => {
      const [x0, z0, x1, z1] = drive;
      const len = Math.hypot(x1 - x0, z1 - z0);
      const ux = (x1 - x0) / len;
      const uz = (z1 - z0) / len;
      const half = 2.6;
      for (let s = 0; s < len; s += step) {
        const e = Math.min(len, s + step);
        const ax = x0 + ux * s;
        const az = z0 + uz * s;
        const bx = x0 + ux * e;
        const bz = z0 + uz * e;
        // Out to the left of the way it runs first, so it faces up.
        const px = -uz * half;
        const pz = ux * half;
        const c = [[ax + px, az + pz], [bx + px, bz + pz], [bx - px, bz - pz], [ax - px, az - pz]] as const;
        dirt.quad(c[0][0], y(c[0][0], c[0][1]), c[0][1], c[1][0], y(c[1][0], c[1][1]), c[1][1], c[2][0], y(c[2][0], c[2][1]), c[2][1], c[3][0], y(c[3][0], c[3][1]), c[3][1], c.flatMap(([cx, cz]) => [cx / 6, cz / 6]));
      }
    };
    for (const f of farms.farmsteads) {
      dirt.flat(f.yard.minX, f.yard.minZ, f.yard.maxX, f.yard.maxZ, 0.008, dirtUv);
      driveStrip(f.drive, 4);
    }
    // The valley's two farmyards and drives (world/country/valley.ts), laid in 2 m squares that follow the ground: the
    // winery's stands on the Vineyard Rise's crest, and its drive climbs it.
    const valley = layout.country.valley;
    for (const { yard, drive } of [valley.vineyard.winery, valley.ranch]) {
      for (let x = yard.minX; x < yard.maxX; x += 2) {
        for (let z = yard.minZ; z < yard.maxZ; z += 2) {
          const x1 = Math.min(x + 2, yard.maxX);
          const z1 = Math.min(z + 2, yard.maxZ);
          dirt.quad(x, y(x, z1), z1, x1, y(x1, z1), z1, x1, y(x1, z), z, x, y(x, z), z, [x / 6, z1 / 6, x1 / 6, z1 / 6, x1 / 6, z / 6, x / 6, z / 6]);
        }
      }
      driveStrip(drive, 2);
    }
    view.add(dirt.build(), view.city.wet.patch(new THREE.MeshStandardMaterial({ map: groundTexture('dirt'), roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })), { name: 'farm-dirt', split: false });

    // The windpumps' wheels (the county's and the ranch's): eighteen sails round a rim, facing +z on its hub over the tower.
    const wg = new GeoBuilder(true);
    const sails = 18;
    for (let k = 0; k < sails; k++) {
      const a = (k / sails) * Math.PI * 2;
      const b = a + 0.22;
      const r0 = 0.35;
      const r1 = 1.7;
      const pt = (r: number, t: number, dz: number): V => [Math.cos(t) * r, Math.sin(t) * r, dz];
      const c: RGB = [0.82, 0.83, 0.84];
      face(wg, pt(r0, a, 0.04), pt(r1, a, 0), pt(r1, b, 0), pt(r0, b, 0.04), [0, 0, 1], c);
      face(wg, pt(r0, b, 0.04), pt(r1, b, 0), pt(r1, a, 0), pt(r0, a, 0.04), [0, 0, -1], scaleRgb(c, 0.8));
    }
    boxC(wg, -0.14, -0.14, -0.12, 0.14, 0.14, 0.12, [0.3, 0.3, 0.32]);
    const wheelGeo = wg.build();
    const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide });
    for (const pump of layout.props.filter((p) => p.kind === 'windpump')) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.name = 'windpump-wheel';
      wheel.position.set(pump.x, pump.y + pump.h + 0.35, pump.z + 0.45);
      wheel.castShadow = true;
      view.moving.add(wheel);
      this.wheels.push(wheel);
    }
  }

  /** Hides the windpumps' wheels past `far` m from (x, z), as their towers' cells are. */
  cull(x: number, z: number, far: number): void {
    for (const w of this.wheels) w.visible = Math.hypot(w.position.x - x, w.position.z - z) < far;
  }

  /**
   * Each frame, `dt` s on: the camera at `cam` and the subject it frames (null: none, nothing opens). While a hedgerow
   * stands between them, the hedgerows open round the line from one to the other, over HEDGE_EASE s.
   */
  sight(cam: V3, subject: V3 | null, dt: number): void {
    let to = 0;
    if (subject) {
      const dx = subject.x - cam.x;
      const dy = subject.y - cam.y;
      const dz = subject.z - cam.z;
      const len = Math.hypot(dx, dy, dz);
      if (len > 0 && this.view.world.grid.raycast(cam.x, cam.y, cam.z, dx / len, dy / len, dz / len, len, this.hit, isHedge)) to = 1;
      this.sightUniforms.uSightCam.value.set(cam.x, cam.y, cam.z);
      this.sightUniforms.uSightSubject.value.set(subject.x, subject.y, subject.z);
    }
    const u = this.sightUniforms.uSightOpen;
    u.value = to > u.value ? Math.min(to, u.value + dt / HEDGE_EASE) : Math.max(to, u.value - dt / HEDGE_EASE);
  }

  /** Each frame: the windpumps' wheels turn with the wind (`wind` m/s), a turn every few seconds in a breeze. */
  update(time: number, wind: number): void {
    const dt = Math.min(0.1, Math.max(0, time - this.last));
    this.last = time;
    this.turn += dt * (0.6 + wind * 0.45);
    for (const w of this.wheels) w.rotation.z = this.turn;
  }
}
