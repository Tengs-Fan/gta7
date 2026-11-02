// Las Lomas County's farmsteads (world/country/farms.ts), drawn only: their colliders are the barns' garage walls and
// roofs, the farmhouses' buildings, the props' and the hedgerows'. The barns' gambrel roofs over the garages' slabs
// (structures.ts draws the walls and slabs), their trim and loft doors; the dairy's silos, the grain bins, the
// windpump's tower and stock tank, the signs, mailboxes and ladders: one draw over the four farms, its boards painted
// on a small atlas of its own (city/attractions.ts Atlas). The hedgerows are a second, which the camera sees through
// where one stands between it and what it frames; the farmyards' and drives' dirt a third; the windpump's wheel turns in
// the wind.

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

/**
 * A gambrel roof over the barn `r` from `eaves` up, its ridge along x (`alongX`) or z: the steep lower pitches to the
 * knees, the shallow upper ones to the ridge, overhanging the walls by `over`; the end walls in `wall`.
 */
function gambrel(g: GeoBuilder, r: Rect, eaves: number, alongX: boolean, roof: RGB, wall: RGB, over = GARAGE_EAVE + 0.1): void {
  const hw = (alongX ? r.maxZ - r.minZ : r.maxX - r.minX) / 2;
  const c = alongX ? rectCZ(r) : rectCX(r);
  const [l0, l1] = alongX ? [r.minX - over, r.maxX + over] : [r.minZ - over, r.maxZ + over];
  // Across the span: the eaves, the knee and the ridge.
  const profile: Array<[number, number]> = [[-(hw + over), eaves - 0.12], [-hw * 0.6, eaves + hw * 0.62], [0, eaves + hw * 0.86], [hw * 0.6, eaves + hw * 0.62], [hw + over, eaves - 0.12]];
  const P = (along: number, across: number, y: number): V => (alongX ? [along, y, c + across] : [c + across, y, along]);
  for (let k = 0; k < 4; k++) {
    const [a0, y0] = profile[k]!;
    const [a1, y1] = profile[k + 1]!;
    const nx = -(y1 - y0);
    const ny = a1 - a0;
    face(g, P(l0, a0, y0), P(l1, a0, y0), P(l1, a1, y1), P(l0, a1, y1), alongX ? [0, ny, nx] : [nx, ny, 0], roof);
  }
  // The end walls: a pentagon at either end, in three triangles, set in from the roof's ends.
  const [e0, e1] = alongX ? [r.minX - 0.02, r.maxX + 0.02] : [r.minZ - 0.02, r.maxZ + 0.02];
  for (const [e, s] of [[e0, -1], [e1, 1]] as const) {
    const q = (a: number, y: number) => P(e, a * (hw / (hw + over)), y);
    const out: V = alongX ? [s, 0, 0] : [0, 0, s];
    const pts = profile.map(([a, y]) => q(a, y));
    const base = (y: number) => [q(-(hw + over), y), q(hw + over, y)];
    const [bl, br] = base(eaves - 0.12);
    tri(g, bl!, br!, pts[3]!, out, wall);
    tri(g, bl!, pts[3]!, pts[1]!, out, wall);
    tri(g, pts[1]!, pts[3]!, pts[2]!, out, wall);
  }
}

/** A barn's roof (of colour `roofColor`), its gable trim, the header over its open doors and the loft door over them. */
export function barn(g: GeoBuilder, f: Pick<Farmstead, 'barn' | 'door'>, height: number, color: number, roofColor: number): void {
  const r = f.barn;
  const top = height + GARAGE_ROOF;
  const alongX = f.door === 'E' || f.door === 'W';
  const wall = hexToRgb(color);
  gambrel(g, r, top, alongX, hexToRgb(roofColor), wall);
  // The front: a white header over the doors and corner boards at its ends; the loft door, braced with a white X.
  const front = f.door === 'E' ? r.maxX : f.door === 'W' ? r.minX : f.door === 'S' ? r.maxZ : r.minZ;
  const out = f.door === 'E' || f.door === 'S' ? 1 : -1;
  const hw = (alongX ? r.maxZ - r.minZ : r.maxX - r.minX) / 2;
  const c = alongX ? rectCZ(r) : rectCX(r);
  const at = (a: number, y: number, o = 0): V => (alongX ? [front + out * (0.06 + o), y, c + a] : [c + a, y, front + out * (0.06 + o)]);
  const n: V = alongX ? [out, 0, 0] : [0, 0, out];
  face(g, at(-hw, height - 0.7), at(hw, height - 0.7), at(hw, height), at(-hw, height), n, WHITE);
  for (const s of [-1, 1]) face(g, at(s * hw - 0.25, 0), at(s * hw + 0.25, 0), at(s * hw + 0.25, height), at(s * hw - 0.25, height), n, WHITE);
  const y0 = top + 0.6;
  const y1 = top + hw * 0.55;
  face(g, at(-1.4, y0), at(1.4, y0), at(1.4, y1), at(-1.4, y1), n, [0.16, 0.1, 0.08]);
  for (const s of [-1, 1]) face(g, at(-1.4 * s - 0.1, y0, 0.02), at(-1.4 * s + 0.1, y0, 0.02), at(1.4 * s + 0.1, y1, 0.02), at(1.4 * s - 0.1, y1, 0.02), n, WHITE);
  face(g, at(-1.5, y0 - 0.12), at(1.5, y0 - 0.12), at(1.5, y0), at(-1.5, y0), n, WHITE);
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

/** A stave silo: concrete in bands, a domed cap, the chute down one side. */
function silo(g: GeoBuilder, x: number, z: number, r: number, h: number): void {
  const concrete: RGB = [0.78, 0.76, 0.72];
  prism(g, x, z, r, r, 0, h, 22, concrete, false);
  for (let y = 1.6; y < h; y += 1.6) prism(g, x, z, r + 0.04, r + 0.04, y, y + 0.1, 22, scaleRgb(concrete, 0.8), false);
  prism(g, x, z, r, r * 0.7, h, h + 1.2, 22, [0.36, 0.42, 0.45], false);
  prism(g, x, z, r * 0.7, 0, h + 1.2, h + 2.1, 22, [0.36, 0.42, 0.45], false);
  boxC(g, x + r - 0.1, 0, z - 0.4, x + r + 0.7, h + 0.6, z + 0.4, [0.62, 0.6, 0.56]);
}

/** A grain bin: corrugated steel, ringed, under a cone roof with its vent and a ladder up it. */
function grainBin(g: GeoBuilder, x: number, z: number, r: number, h: number): void {
  prism(g, x, z, r, r, 0, h, 24, STEEL, false);
  for (let y = 0.8; y < h; y += 0.8) prism(g, x, z, r + 0.03, r + 0.03, y, y + 0.06, 24, scaleRgb(STEEL, 0.82), false);
  prism(g, x, z, r + 0.15, 0.45, h, h + r * 0.75, 24, scaleRgb(STEEL, 1.06), false);
  prism(g, x, z, 0.45, 0.3, h + r * 0.75, h + r * 0.75 + 0.5, 10, scaleRgb(STEEL, 0.9));
  for (const dx of [-0.22, 0.22]) boxC(g, x + dx - 0.03, 0, z + r + 0.08, x + dx + 0.03, h, z + r + 0.14, [0.3, 0.3, 0.32]);
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
    const atlas = new Atlas(1024);
    const blank = atlas.band(8, (ctx) => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 1024, 8);
    });
    for (const f of farms.farmsteads) {
      const gar = layout.garages.find((q) => q.poi === `${f.id}_barn`)!;
      barn(g, f, gar.height, gar.color, BARN_ROOF[f.id]);
      const s = SIGNS[f.id];
      sign(g, painted, f, atlas.board(s.lines, s.bg, 220));
      mailbox(g, f.mailbox.x, f.mailbox.z);
    }
    for (const p of layout.props.slice(layout.country.firstProp)) {
      if (p.kind === 'silo') silo(g, p.x, p.z, p.w / 2, p.h);
      if (p.kind === 'grainbin') grainBin(g, p.x, p.z, p.w / 2, p.h);
      if (p.kind === 'windpump') windpump(g, p.x, p.z, p.h);
    }
    for (const l of farms.ladders) ladder(g, l.x, l.z, l.rot);
    const decor = g.build();
    const uv = decor.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, (blank[0] + blank[1]) / 2);
    const geo = mergeGeometries([decor, painted.build()], false)!;
    decor.dispose();
    view.add(geo, new THREE.MeshStandardMaterial({ map: toTexture(atlas.canvas, true, false), vertexColors: true, roughness: 0.8 }), { shadow: true, name: 'farmsteads', split: false });

    // The hedgerows: a leafy box each, lumped along its top.
    const hedges = new GeoBuilder(false);
    const rng = new Rng(4418);
    for (const h of [...farms.hedges, ...layout.country.valley.hedges]) {
      hedges.box(h.minX, 0, h.minZ, h.maxX, HEDGE_H - 0.25, h.maxZ, { uv: { kind: 'world', scale: 3 } });
      const alongX = h.maxX - h.minX > h.maxZ - h.minZ;
      const len = alongX ? h.maxX - h.minX : h.maxZ - h.minZ;
      for (let a = 0; a < len; a += rng.range(1.6, 3)) {
        const l = rng.range(1.2, 2.6);
        const b = Math.min(len, a + l);
        const top = HEDGE_H + rng.range(-0.15, 0.25);
        if (alongX) hedges.box(h.minX + a, HEDGE_H - 0.3, h.minZ + 0.1, h.minX + b, top, h.maxZ - 0.1, { uv: { kind: 'world', scale: 3 } });
        else hedges.box(h.minX + 0.1, HEDGE_H - 0.3, h.minZ + a, h.maxX - 0.1, top, h.minZ + b, { uv: { kind: 'world', scale: 3 } });
      }
    }
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
