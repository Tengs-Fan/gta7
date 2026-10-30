// The attractions' buildings and fittings (world/attractions.ts), drawn only: their colliders are the attractions'
// solids and the barn's garage walls. Hollister Farm: the barn's gable over the garage it is (structures.ts draws its
// walls and roof slab), its loft door and sign, the silo, the farm stand and the hay bales over the farm's kicker.
// Eternal Palms Cemetery: the chapel with its bell tower and stained glass (lit at night with the signs), the three
// mausoleums and the gate. All of it is one draw (see Atlas).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../../core/rng';
import { attractionOf } from '../../world/attractions';
import { CURB_H } from '../../world/constants';
import { rectCX, rectCZ, type Rect } from '../../world/layout';
import { GARAGE_EAVE, GARAGE_ROOF } from '../../world/staticWorld';
import { GeoBuilder, hexToRgb, type RGB } from '../geo';
import { canvas, toTexture } from '../textures/misc';
import type { CityView } from './index';
import { prism } from './rooftops';

type V = readonly [number, number, number];

/** A quad facing `toward`: its winding put right, since the attractions are drawn from the front only. */
function face(g: GeoBuilder, a: V, b: V, c: V, d: V, toward: V, color: RGB, uv: readonly number[] = [0, 0, 1, 0, 1, 1, 0, 1]): void {
  const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
  if (n[0]! * toward[0] + n[1]! * toward[1] + n[2]! * toward[2] >= 0) g.quad(...a, ...b, ...c, ...d, uv, color);
  else g.quad(...d, ...c, ...b, ...a, [uv[6]!, uv[7]!, uv[4]!, uv[5]!, uv[2]!, uv[3]!, uv[0]!, uv[1]!], color);
}

function tri(g: GeoBuilder, a: V, b: V, c: V, toward: V, color: RGB): void {
  const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
  const uv = [0, 0, 1, 0, 0.5, 1];
  if (n[0]! * toward[0] + n[1]! * toward[1] + n[2]! * toward[2] >= 0) g.tri(...a, ...b, ...c, uv, color);
  else g.tri(...c, ...b, ...a, uv, color);
}

function boxC(g: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: RGB): void {
  g.box(x0, y0, z0, x1, y1, z1, { uv: { kind: 'world', scale: 4 }, color });
}

/**
 * A pitched roof over `r` from height `eaves` to `ridge`, its ridge along x (`alongX`) or z, overhanging by `over`, with
 * the gable triangles at its ends in `wall` colour.
 */
function pitched(g: GeoBuilder, r: Rect, eaves: number, ridge: number, alongX: boolean, over: number, roof: RGB, wall: RGB | null): void {
  const { minX, minZ, maxX, maxZ } = r;
  if (alongX) {
    const cz = (minZ + maxZ) / 2;
    face(g, [minX - over, eaves, minZ - over], [maxX + over, eaves, minZ - over], [maxX + over, ridge, cz], [minX - over, ridge, cz], [0, 1, -1], roof);
    face(g, [minX - over, eaves, maxZ + over], [maxX + over, eaves, maxZ + over], [maxX + over, ridge, cz], [minX - over, ridge, cz], [0, 1, 1], roof);
    if (wall) for (const [x, s] of [[minX, -1], [maxX, 1]] as const) tri(g, [x, eaves, minZ], [x, eaves, maxZ], [x, ridge - 0.05, cz], [s, 0, 0], wall);
  } else {
    const cx = (minX + maxX) / 2;
    face(g, [minX - over, eaves, minZ - over], [minX - over, eaves, maxZ + over], [cx, ridge, maxZ + over], [cx, ridge, minZ - over], [-1, 1, 0], roof);
    face(g, [maxX + over, eaves, minZ - over], [maxX + over, eaves, maxZ + over], [cx, ridge, maxZ + over], [cx, ridge, minZ - over], [1, 1, 0], roof);
    if (wall) for (const [z, s] of [[minZ, -1], [maxZ, 1]] as const) tri(g, [minX, eaves, z], [maxX, eaves, z], [cx, ridge - 0.05, z], [0, 0, s], wall);
  }
}

/**
 * Everything the attractions draw shares one texture, a column of 1024 px wide bands (ATLAS_H tall in all), so they are
 * one draw: a white band under the vertex-coloured buildings, the painted boards, the hay and the stained glass. Its
 * twin, the glow texture, is black but for the glass, which lights up after dark (the signs' emissive, CityView.update).
 */
const ATLAS_H = 2048;
const GLOW_SHRINK = 4;

class Atlas {
  readonly canvas: HTMLCanvasElement;
  readonly glowCanvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly glow: CanvasRenderingContext2D;
  private y = 0;

  constructor() {
    [this.canvas, this.ctx] = canvas(1024, ATLAS_H);
    // The glow only needs the glass's colours: a quarter of the size.
    [this.glowCanvas, this.glow] = canvas(1024 / GLOW_SHRINK, ATLAS_H / GLOW_SHRINK);
    this.glow.fillStyle = '#000';
    this.glow.fillRect(0, 0, 1024 / GLOW_SHRINK, ATLAS_H / GLOW_SHRINK);
  }

  /** A band `h` px tall drawn by `draw` (its origin at the band's top left), in the glow too if `lit`; its v range, bottom to top. */
  band(h: number, draw: (ctx: CanvasRenderingContext2D) => void, lit = false): [number, number] {
    for (const ctx of lit ? [this.ctx, this.glow] : [this.ctx]) {
      ctx.save();
      if (ctx === this.glow) ctx.scale(1 / GLOW_SHRINK, 1 / GLOW_SHRINK);
      ctx.translate(0, this.y);
      draw(ctx);
      ctx.restore();
    }
    const v: [number, number] = [1 - (this.y + h) / ATLAS_H, 1 - this.y / ATLAS_H];
    this.y += h;
    return v;
  }

  /** Stained glass: panes of saturated colour in dark lead. */
  glass(): [number, number] {
    const hues = ['#c0262d', '#2350b0', '#e0a92a', '#2e8b57', '#7b3fa0', '#d4622a'];
    const panes = Array.from({ length: 6 * 38 }, (_, i) => hues[new Rng(1888 + i).int(0, hues.length - 1)]!);
    return this.band(192, (ctx) => {
      ctx.fillStyle = '#16120e';
      ctx.fillRect(0, 0, 1024, 192);
      for (let r = 0; r < 6; r++) {
        for (let k = 0; k < 38; k++) {
          ctx.fillStyle = panes[r * 38 + k]!;
          ctx.fillRect(4 + k * 27, 4 + r * 31.5, 23, 27);
        }
      }
    }, true);
  }

  /** A board of painted text: lines of [text, size in px, colour] on `bg`. */
  board(lines: ReadonlyArray<readonly [string, number, string]>, bg: string, h = 256, frame = ''): [number, number] {
    return this.band(h, (ctx) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 1024, h);
      if (frame) {
        ctx.strokeStyle = frame;
        ctx.lineWidth = 10;
        ctx.strokeRect(10, 10, 1004, h - 20);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const total = lines.reduce((sum, l) => sum + l[1] * 1.15, 0);
      let y = (h - total) / 2;
      for (const [text, size, color] of lines) {
        let px = size;
        ctx.font = `700 ${px}px Anton, Impact, "Arial Black", sans-serif`;
        while (ctx.measureText(text).width > 960 && px > 20) {
          px -= 4;
          ctx.font = `700 ${px}px Anton, Impact, "Arial Black", sans-serif`;
        }
        ctx.fillStyle = color;
        ctx.fillText(text, 512, y + (size * 1.15) / 2);
        y += size * 1.15;
      }
    });
  }

  /** Hay bales in rows seen from above: golden straw, twine across each bale, dark seams between them. */
  hay(): [number, number] {
    const rng = new Rng(52);
    const H = 384;
    return this.band(H, (ctx) => {
      ctx.fillStyle = '#5e4a22';
      ctx.fillRect(0, 0, 1024, H);
      for (let row = 0; row < 12; row++) {
        for (let k = -1; k < 4; k++) {
          const x = k * 300 + (row % 2) * 150;
          const y = row * (H / 12);
          ctx.fillStyle = `rgb(${200 + rng.int(-14, 14)},${168 + rng.int(-14, 14)},${84 + rng.int(-10, 10)})`;
          ctx.fillRect(x + 4, y + 3, 292, H / 12 - 6);
          ctx.strokeStyle = 'rgba(120,90,40,0.6)';
          ctx.lineWidth = 1;
          for (let n = 0; n < 50; n++) {
            const sx = x + rng.range(8, 290);
            const sy = y + rng.range(5, H / 12 - 5);
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + rng.range(-8, 8), sy + rng.range(-2, 2));
            ctx.stroke();
          }
          ctx.fillStyle = '#7a5a2c';
          for (const tx of [x + 95, x + 200]) ctx.fillRect(tx, y + 3, 4, H / 12 - 6);
        }
      }
    });
  }
}

export function buildAttractionViews(view: CityView): void {
  const L = view.world.layout;
  const g = new GeoBuilder(true);
  const atlas = new Atlas();
  const blank = atlas.band(8, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1024, 8);
  });
  const glassV = atlas.glass();
  const painted = new GeoBuilder(true);
  /** A board of w x h m, centred at (x, y, z) and facing (sin rot, cos rot), painted with the atlas band `v`. */
  const board = (v: [number, number], w: number, h: number, x: number, y: number, z: number, rot: number) => {
    const ax = Math.cos(rot) * (w / 2);
    const az = -Math.sin(rot) * (w / 2);
    painted.quad(x - ax, y - h / 2, z - az, x + ax, y - h / 2, z + az, x + ax, y + h / 2, z + az, x - ax, y + h / 2, z - az, [0, v[0], 1, v[0], 1, v[1], 0, v[1]], [1, 1, 1]);
  };

  // --- Hollister Farm
  const farm = attractionOf(L, 'farm').anchors;
  const red = hexToRgb(0x8e2b1f);
  const white: RGB = [0.93, 0.91, 0.86];
  const tin: RGB = [0.36, 0.33, 0.31];
  const b = farm.barn;
  const top = L.garages.find((q) => q.poi === 'farm_barn')!.height + GARAGE_ROOF;
  // The gable over the roof slab, its ridge running from the doors (west) to the back wall.
  pitched(g, { minX: b.minX - GARAGE_EAVE, minZ: b.minZ, maxX: b.maxX + GARAGE_EAVE, maxZ: b.maxZ }, top, top + 4.4, true, 0.35, tin, red);
  // A white header over the open doors, and the hayloft door under the ridge: dark, braced with a white X.
  boxC(g, b.minX - 0.05, 6.2, b.minZ, b.minX + 0.35, 7, b.maxZ, white);
  const cz = rectCZ(b);
  const lx = b.minX - GARAGE_EAVE - 0.04;
  face(g, [lx, top + 0.5, cz - 1.3], [lx, top + 0.5, cz + 1.3], [lx, top + 2.7, cz + 1.3], [lx, top + 2.7, cz - 1.3], [-1, 0, 0], [0.18, 0.1, 0.08]);
  for (const s of [-1, 1]) face(g, [lx - 0.02, top + 0.5, cz - 1.3 * s - 0.1], [lx - 0.02, top + 0.5, cz - 1.3 * s + 0.1], [lx - 0.02, top + 2.7, cz + 1.3 * s + 0.1], [lx - 0.02, top + 2.7, cz + 1.3 * s - 0.1], [-1, 0, 0], white);
  board(atlas.board([['HOLLISTER FARM', 150, '#f3eadb']], '#6e1e16', 220), 9, 1.95, rectCX(b), 4.1, b.maxZ + 0.06, 0);
  // The silo: galvanised steel in bands, a domed cap and a ladder up its west side.
  const s = farm.silo;
  const steel: RGB = [0.66, 0.68, 0.7];
  prism(g, s.x, s.z, s.r, s.r, 0, s.height, 24, steel, false);
  for (let y = 2; y < s.height; y += 2.5) prism(g, s.x, s.z, s.r + 0.05, s.r + 0.05, y, y + 0.14, 24, [0.5, 0.52, 0.54], false);
  prism(g, s.x, s.z, s.r, s.r * 0.8, s.height, s.height + 1.1, 24, [0.72, 0.74, 0.76], false);
  prism(g, s.x, s.z, s.r * 0.8, 0, s.height + 1.1, s.height + 2.6, 24, [0.72, 0.74, 0.76], false);
  for (const dz of [-0.25, 0.25]) boxC(g, s.x - s.r - 0.15, 0, s.z + dz - 0.03, s.x - s.r - 0.09, s.height, s.z + dz + 0.03, [0.3, 0.3, 0.32]);
  for (let y = 0.4; y < s.height; y += 0.45) boxC(g, s.x - s.r - 0.15, y, s.z - 0.25, s.x - s.r - 0.11, y + 0.04, s.z + 0.25, [0.3, 0.3, 0.32]);
  // The farm stand by the gate: a plank counter, two posts and the sign.
  const st = farm.stand;
  const wood: RGB = [0.48, 0.33, 0.2];
  boxC(g, st.x - 1.3, CURB_H, st.z - 0.5, st.x + 1.3, CURB_H + 1, st.z + 0.5, wood);
  for (const dx of [-1.5, 1.5]) boxC(g, st.x + dx - 0.07, CURB_H, st.z - 0.62, st.x + dx + 0.07, CURB_H + 3.3, st.z - 0.48, wood);
  board(atlas.board([['HOLLISTER FARM', 96, '#fbf3e2'], ['EST. 1952', 44, '#f2c14e'], ['NOT FOR SALE. NOT NOW. NOT EVER.', 56, '#fbf3e2']], '#3f5a2a', 280, '#fbf3e2'), 3.4, 0.95, st.x, CURB_H + 2.65, st.z - 0.46, st.rot);

  // The hay-bale kicker: the ramp's slope under a skin of bales (its plate's texture), stacked bales down its sides.
  const r = L.ramps[farm.ramp]!;
  const fx = Math.sin(r.heading);
  const fz = Math.cos(r.heading);
  const sx = Math.cos(r.heading);
  const sz = -Math.sin(r.heading);
  const base = view.world.baseGround(r.x, r.z);
  const P = (along: number, side: number, h: number): V => [r.x + fx * along + sx * side, base + h, r.z + fz * along + sz * side];
  const hw = r.width / 2;
  const hl = r.length / 2;
  const [h0, h1] = atlas.hay();
  face(painted, P(-hl, -hw, 0.03), P(-hl, hw, 0.03), P(hl, hw, r.height + 0.01), P(hl, -hw, r.height + 0.01), [0, 1, 0], [1, 1, 1], [0, h0, 1, h0, 1, h1, 0, h1]);
  const straw: RGB = [0.78, 0.64, 0.33];
  tri(g, P(-hl, hw, 0), P(hl, hw, 0), P(hl, hw, r.height), [sx, 0, sz], straw);
  tri(g, P(-hl, -hw, 0), P(hl, -hw, 0), P(hl, -hw, r.height), [-sx, 0, -sz], straw);
  face(g, P(hl, -hw, 0), P(hl, hw, 0), P(hl, hw, r.height), P(hl, -hw, r.height), [fx, 0, fz], [0.72, 0.58, 0.3]);

  // --- Eternal Palms Cemetery
  const cem = attractionOf(L, 'cemetery').anchors;
  const plaster: RGB = [0.94, 0.93, 0.89];
  const slate: RGB = [0.24, 0.26, 0.3];
  const n = cem.nave;
  boxC(g, n.rect.minX, CURB_H, n.rect.minZ, n.rect.maxX, n.eaves, n.rect.maxZ, plaster);
  pitched(g, n.rect, n.eaves, n.ridge, false, 0.45, slate, plaster);
  // Three tall windows down each long wall, a round one in the south gable.
  for (const [x, out] of [[n.rect.minX - 0.04, -1], [n.rect.maxX + 0.04, 1]] as const) {
    for (let k = 0; k < 3; k++) {
      const z = n.rect.minZ + ((k + 1) * (n.rect.maxZ - n.rect.minZ)) / 4;
      face(painted, [x, 2, z - 0.55], [x, 2, z + 0.55], [x, 5.1, z + 0.55], [x, 5.1, z - 0.55], [out, 0, 0], [1, 1, 1], [0.1 * k, glassV[0], 0.1 * k + 0.08, glassV[0], 0.1 * k + 0.08, glassV[1], 0.1 * k, glassV[1]]);
    }
  }
  const ncx = rectCX(n.rect);
  face(painted, [ncx - 1, n.eaves + 0.3, n.rect.maxZ + 0.04], [ncx + 1, n.eaves + 0.3, n.rect.maxZ + 0.04], [ncx + 1, n.eaves + 2.1, n.rect.maxZ + 0.04], [ncx - 1, n.eaves + 2.1, n.rect.maxZ + 0.04], [0, 0, 1], [1, 1, 1], [0.6, glassV[0], 0.8, glassV[0], 0.8, glassV[1], 0.6, glassV[1]]);
  // The tower: plain to the belfry, open arches there, a cornice and a slate spire with its cross.
  const t = cem.tower;
  const tr = t.rect;
  const tcx = rectCX(tr);
  const tcz = rectCZ(tr);
  boxC(g, tr.minX, CURB_H, tr.minZ, tr.maxX, t.height, tr.maxZ, plaster);
  boxC(g, tr.minX - 0.2, t.height - 0.35, tr.minZ - 0.2, tr.maxX + 0.2, t.height, tr.maxZ + 0.2, [0.85, 0.84, 0.8]);
  const dark: RGB = [0.08, 0.07, 0.07];
  for (const [nx, nz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    const x = nx === 0 ? tcx : nx < 0 ? tr.minX - 0.03 : tr.maxX + 0.03;
    const z = nz === 0 ? tcz : nz < 0 ? tr.minZ - 0.03 : tr.maxZ + 0.03;
    const ax = nz !== 0 ? 1 : 0;
    const az = nx !== 0 ? 1 : 0;
    face(g, [x - ax * 0.9, 13.6, z - az * 0.9], [x + ax * 0.9, 13.6, z + az * 0.9], [x + ax * 0.9, 16.4, z + az * 0.9], [x - ax * 0.9, 16.4, z - az * 0.9], [nx, 0, nz], dark);
  }
  const ty = t.height;
  const corners: V[] = [[tr.minX - 0.1, ty, tr.minZ - 0.1], [tr.maxX + 0.1, ty, tr.minZ - 0.1], [tr.maxX + 0.1, ty, tr.maxZ + 0.1], [tr.minX - 0.1, ty, tr.maxZ + 0.1]];
  const apex: V = [tcx, ty + 6, tcz];
  for (let k = 0; k < 4; k++) {
    const a = corners[k]!;
    const c = corners[(k + 1) % 4]!;
    tri(g, a, c, apex, [(a[0] + c[0]) / 2 - tcx, 0.5, (a[2] + c[2]) / 2 - tcz], slate);
  }
  const gold: RGB = [0.75, 0.6, 0.25];
  boxC(g, tcx - 0.06, ty + 6, tcz - 0.06, tcx + 0.06, ty + 7.6, tcz + 0.06, gold);
  boxC(g, tcx - 0.45, ty + 6.95, tcz - 0.06, tcx + 0.45, ty + 7.1, tcz + 0.06, gold);
  // The door under the tower, facing the gate.
  face(g, [tcx - 0.8, CURB_H, tr.minZ - 0.03], [tcx + 0.8, CURB_H, tr.minZ - 0.03], [tcx + 0.8, 3.2, tr.minZ - 0.03], [tcx - 0.8, 3.2, tr.minZ - 0.03], [0, 0, -1], [0.3, 0.18, 0.1]);

  // The mausoleums: grey stone, a pediment over the door on two columns, the family's name on the frieze.
  const stone: RGB = [0.66, 0.65, 0.62];
  for (const m of cem.mausoleums) {
    const q = m.rect;
    const mx = rectCX(q);
    boxC(g, q.minX, CURB_H, q.minZ, q.maxX, 4.2, q.maxZ, stone);
    boxC(g, q.minX - 0.25, 4.2, q.minZ - 0.6, q.maxX + 0.25, 4.5, q.maxZ + 0.25, [0.58, 0.57, 0.55]);
    tri(g, [q.minX - 0.25, 4.5, q.minZ - 0.6], [q.maxX + 0.25, 4.5, q.minZ - 0.6], [mx, 5.4, q.minZ - 0.6], [0, 0, -1], [0.7, 0.69, 0.66]);
    for (const dx of [-1.3, 1.3]) prism(g, mx + dx, q.minZ - 0.35, 0.2, 0.2, CURB_H, 4.2, 10, [0.8, 0.79, 0.76], false);
    face(g, [mx - 0.75, CURB_H, q.minZ - 0.03], [mx + 0.75, CURB_H, q.minZ - 0.03], [mx + 0.75, 2.6, q.minZ - 0.03], [mx - 0.75, 2.6, q.minZ - 0.03], [0, 0, -1], [0.2, 0.17, 0.12]);
    board(atlas.board([[m.family, 130, '#2a2a2c']], '#b4b1a9', 160), 3, 0.47, mx, 3.55, q.minZ - 0.62, Math.PI);
  }

  // The gate: two stone piers and an iron arch carrying the name.
  const gz = cem.fence.minZ + 0.1;
  for (const x of [cem.gate.x0 - 0.4, cem.gate.x1 + 0.4]) {
    boxC(g, x - 0.4, CURB_H, gz - 0.4, x + 0.4, 2.8, gz + 0.4, [0.62, 0.6, 0.57]);
    boxC(g, x - 0.48, 2.8, gz - 0.48, x + 0.48, 3.0, gz + 0.48, [0.55, 0.53, 0.5]);
  }
  const iron: RGB = [0.1, 0.1, 0.11];
  const gx0 = cem.gate.x0 - 0.4;
  const gx1 = cem.gate.x1 + 0.4;
  for (const y of [3.0, 4.15]) boxC(g, gx0, y, gz - 0.04, gx1, y + 0.08, gz + 0.04, iron);
  for (let k = 0; k <= 8; k++) {
    const x = gx0 + ((gx1 - gx0) * k) / 8;
    const y = 4.23 + Math.sin((k / 8) * Math.PI) * 0.7;
    boxC(g, x - 0.04, 4.15, gz - 0.04, x + 0.04, y, gz + 0.04, iron);
  }
  board(atlas.board([['ETERNAL PALMS CEMETERY', 120, '#e8dcc0']], '#1a1a1c', 180, '#8a7a50'), gx1 - gx0 - 0.4, 0.9, (gx0 + gx1) / 2, 3.6, gz - 0.06, Math.PI);

  // The buildings sample the atlas's white band; one geometry, one material, one draw (casting shadows: a few
  // pieces in two places, which cells would only split into more draws).
  const decor = g.build();
  const uv = decor.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, (blank[0] + blank[1]) / 2);
  const geo = mergeGeometries([decor, painted.build()], false)!;
  decor.dispose();
  const mat = new THREE.MeshStandardMaterial({
    map: toTexture(atlas.canvas, true, false),
    emissiveMap: toTexture(atlas.glowCanvas, true, false),
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.4,
    vertexColors: true,
    roughness: 0.8,
  });
  view.materials.signs.push(mat);
  view.add(geo, mat, { shadow: true, split: false, name: 'attractions' });
}
