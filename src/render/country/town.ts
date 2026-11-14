// Dry Creek (world/country/places.ts): its stores' false fronts with their cornices, gables, shop fronts in bays and
// porches (the diner's awning) over the boardwalks, their signs; Gas & Grits' canopy and islands (the pumps are props:
// render/props.ts draws them with pumpGeometry); the grain elevator, the water tower and the World's Second-Largest Corn
// Cob; the town's two billboards; the gravel of the forecourt and the parking; and Moo-Moo's neon cow, which kicks after
// dark. The stores' walls take the city's facade materials (and so its night windows), a draw a style; the rest is the
// town's piece of the places' atlas (kit.ts) but for the neon, a draw of its own.

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { Store, StoreKind, TownAnchors } from '../../world/country/places';
import { hashInts, rectContains, type FacadeStyle } from '../../world/layout';
import { boxC, face, tri, type V } from '../city/attractions';
import { prism } from '../city/rooftops';
import { box, cyl, ModelBuilder } from '../furniture';
import { GeoBuilder, scaleRgb, type RGB } from '../geo';
import { FACADE_CELL, FACADE_COLS, FACADE_ROWS } from '../textures/facade';
import { canvas, toTexture } from '../textures/misc';
import type { CountryView } from './index';
import { beam, paddedBand, TIN_TILE, tinBand } from './farms';
import { DIRT_Y, type PlacePieces, type PlacesKit } from './kit';

/** The shop windows' band, from the boardwalk up; the porch roofs over the boardwalks, from the fronts out. */
const SHOP_TOP = 3.2;
const PORCH = { high: 3.6, low: 3.15, post: 0.14, gap: 4 };
/** The height of the boardwalks' decks over the flush ground. */
const DECK_Y = 0.06;

/** How bright a lit sign's letters glow after dark, and a billboard's whole face. */
export const SIGN_GLOW = 0.45;
const BOARD_GLOW = 0.3;
const WOOD: RGB = [0.4, 0.28, 0.18];
const TIN: RGB = [0.44, 0.33, 0.27];
const CONCRETE: RGB = [0.72, 0.7, 0.66];
const WHITE: RGB = [0.95, 0.95, 0.93];

/** Each store's colours (multiplied with its facade's texture), its sign's, and its shop window's design. */
const LOOK: Readonly<Record<StoreKind | 'mercantile' | 'hardware' | 'saloon', { wall: RGB; trim: RGB; sign: [string, string]; front: 'shop' | 'diner' | 'sheriff' | 'gas' }>> = {
  feed: { wall: [0.62, 0.24, 0.19], trim: WHITE, sign: ['#f4ecd8', '#2f4a2c'], front: 'shop' },
  guns: { wall: [1, 0.93, 0.86], trim: [0.15, 0.14, 0.13], sign: ['#ffcf3d', '#151515'], front: 'shop' },
  diner: { wall: [1, 0.96, 0.88], trim: [0.2, 0.62, 0.62], sign: ['#d8263b', '#fbf3e0'], front: 'diner' },
  gas: { wall: WHITE, trim: [0.78, 0.12, 0.12], sign: ['#ffffff', '#c41f1f'], front: 'gas' },
  sheriff: { wall: [0.97, 0.97, 0.95], trim: [0.32, 0.24, 0.16], sign: ['#1d2a44', '#f2efe6'], front: 'sheriff' },
  shop: { wall: [0.93, 0.8, 0.5], trim: WOOD, sign: ['#3a2414', '#e9d39a'], front: 'shop' },
  mercantile: { wall: [0.93, 0.8, 0.5], trim: WOOD, sign: ['#3a2414', '#e9d39a'], front: 'shop' },
  hardware: { wall: [1, 0.9, 0.84], trim: [0.2, 0.2, 0.22], sign: ['#ffffff', '#8c1d18'], front: 'shop' },
  saloon: { wall: [0.66, 0.52, 0.4], trim: [0.3, 0.2, 0.12], sign: ['#f3dfb5', '#4a2c18'], front: 'shop' },
};

function look(s: Store): (typeof LOOK)[keyof typeof LOOK] {
  if (s.name === 'PRAIRIE MERCANTILE') return LOOK.mercantile;
  if (s.name === 'HOLLOWAY HARDWARE') return LOOK.hardware;
  if (s.name === 'THE RUSTY SPUR') return LOOK.saloon;
  return LOOK[s.kind];
}

/** Gas & Grits' pump, its origin at its foot, facing +z: a plinth, the cabinet with its display, two holstered nozzles and the hose. */
export function pumpGeometry(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add('plinth', box(0.9, 0.12, 0.62, 0, 0, 0), 0x9a9890);
  b.add('cabinet', box(0.72, 1.45, 0.48, 0, 0.12, 0), 0xd42a20);
  b.add('band', box(0.74, 0.22, 0.5, 0, 1.0, 0), 0xf2f0ea);
  b.add('head', box(0.76, 0.3, 0.52, 0, 1.57, 0), 0xf2f0ea);
  for (const z of [-0.255, 0.255]) {
    b.add('display', box(0.46, 0.2, 0.01, 0, 1.08, z), 0x1d2a2e);
    b.add('holster', box(0.12, 0.2, 0.08, 0.26, 0.7, z * 1.2), 0x262626);
    b.add('nozzle', cyl(0.025, 0.03, 0.22, 6, 0.26, 0.55, z * 1.3), 0x1a1a1a);
  }
  b.add('hose', cyl(0.03, 0.03, 0.9, 6, 0.4, 0.4, 0).rotateZ(0.12), 0x111111);
  return b.build('pump');
}

/**
 * Paints a band of a lit sign: the board and its letters, and in the glow its letters alone at SIGN_GLOW (the signs'
 * material outshines the city's lamps after dark: CityView.update).
 */
export function sign(kit: PlacesKit, lines: ReadonlyArray<readonly [string, number]>, fg: string, bg: string, h = 128): [number, number] {
  return kit.atlas.band(h, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    ctx.fillStyle = glow ? '#000' : bg;
    ctx.fillRect(0, 0, 1024, h);
    if (glow) ctx.globalAlpha = SIGN_GLOW;
    if (!glow) {
      ctx.strokeStyle = fg;
      ctx.lineWidth = 6;
      ctx.strokeRect(9, 9, 1006, h - 18);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fg;
    const total = lines.reduce((s, l) => s + l[1] * 1.12, 0);
    let y = (h - total) / 2;
    for (const [text, size] of lines) {
      let px = size;
      ctx.font = `700 ${px}px Anton, Impact, "Arial Black", sans-serif`;
      while (ctx.measureText(text).width > 950 && px > 16) {
        px -= 4;
        ctx.font = `700 ${px}px Anton, Impact, "Arial Black", sans-serif`;
      }
      ctx.fillText(text, 512, y + (size * 1.12) / 2);
      y += size * 1.12;
    }
  }, true);
}

/**
 * A shop front's band (lit after dark): four bays side by side, each a quarter of the band and BAY_W wide on the wall,
 * so a front of any width repeats them instead of stretching one. Bay 0 is the door's: the door under its transom
 * between two narrow lights; bays 1 to 3 are display windows, each with its own goods behind the glass; in one of four
 * designs.
 */
function shopFront(kit: PlacesKit, kind: 'shop' | 'diner' | 'sheriff' | 'gas'): [number, number] {
  const H = 192;
  const T = 256;
  return kit.atlas.band(H, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    const frame = kind === 'diner' ? '#c9d2d4' : kind === 'gas' ? '#e8e6e0' : '#4a3322';
    const kick = kind === 'gas' || kind === 'diner' ? '#b8242a' : '#3a2616';
    const rng = new Rng(4421);
    /** Glass at (x, y), w by h, lit warm; `goods` the display behind it (0 none, 1 shelves, 2 a sign, 3 a blind, 4 the diner's counter). */
    const lit = (x: number, y: number, w: number, h: number, goods: number) => {
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, glow ? '#5a4520' : '#f3d88f');
      g.addColorStop(1, glow ? '#3a2a10' : '#b8873c');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      if (glow) return;
      if (goods === 1) {
        // Shelves of tins and sacks.
        ctx.fillStyle = 'rgba(70,44,20,0.55)';
        for (let k = 1; k < 4; k++) ctx.fillRect(x, y + (h * k) / 4, w, 3);
        for (let s = 0; s < 3; s++) {
          for (let k = 4; k < w - 10; k += rng.int(12, 20)) {
            const hh = rng.int(8, (h / 4) * 0.8);
            ctx.fillStyle = `rgba(${rng.int(60, 140)},${rng.int(40, 90)},${rng.int(20, 60)},0.75)`;
            ctx.fillRect(x + k, y + ((s + 1) * h) / 4 - hh, rng.int(6, 11), hh);
          }
        }
      } else if (goods === 2) {
        // A hand-lettered card in the window, a pyramid of cans under it.
        ctx.fillStyle = '#f4ecd2';
        ctx.fillRect(x + w * 0.2, y + h * 0.18, w * 0.6, h * 0.3);
        ctx.fillStyle = '#8c1d18';
        ctx.font = '700 22px Anton, Impact, "Arial Black", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(rng.pick(['OPEN', 'SALE', 'NO CREDIT', 'FRESH BAIT', 'WE BUY HAY']), x + w / 2, y + h * 0.33, w * 0.56);
        ctx.fillStyle = 'rgba(80,50,24,0.7)';
        for (let r = 0; r < 4; r++) for (let k = 0; k <= r; k++) ctx.fillRect(x + w / 2 - r * 7 + k * 14 - 6, y + h - 12 - (3 - r) * 11, 12, 10);
      } else if (goods === 3) {
        // A blind pulled half down, its slats.
        ctx.fillStyle = '#d9cfb4';
        ctx.fillRect(x, y, w, h * 0.45);
        ctx.fillStyle = 'rgba(90,70,40,0.35)';
        for (let k = 4; k < h * 0.45; k += 6) ctx.fillRect(x, y + k, w, 1);
        ctx.fillStyle = 'rgba(70,44,20,0.5)';
        ctx.fillRect(x, y + h * 0.75, w, 3);
      } else if (goods === 4) {
        // The counter's red stools under the glass, a pie case at the back.
        ctx.fillStyle = 'rgba(80,60,40,0.4)';
        ctx.fillRect(x, y + h * 0.62, w, 6);
        ctx.fillStyle = '#c4262e';
        for (let k = 18; k < w; k += 52) ctx.fillRect(x + k, y + h - 24, 26, 20);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(x + w * 0.3, y + h * 0.2, w * 0.4, h * 0.25);
      }
    };
    /** The window's frame: a mullion, a transom bar, a sill. */
    const sash = (x: number, y: number, w: number, h: number, bars: number) => {
      if (glow) return;
      ctx.fillStyle = frame;
      for (let k = 1; k < bars; k++) ctx.fillRect(x + (w * k) / bars - 3, y, 6, h);
      ctx.fillRect(x, y + 24, w, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(x, y, w, 3);
    };
    const kickPlate = (x: number, w: number) => {
      ctx.fillStyle = kick;
      ctx.fillRect(x, 148, w, 38);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 2;
      for (let k = x + 8; k < x + w - 30; k += (w - 16) / Math.max(1, Math.round((w - 16) / 60))) ctx.strokeRect(k, 154, (w - 16) / Math.max(1, Math.round((w - 16) / 60)) - 8, 26);
    };
    ctx.fillStyle = glow ? '#000' : frame;
    ctx.fillRect(0, 0, 1024, H);
    for (let t = 0; t < 4; t++) {
      ctx.save();
      ctx.translate(t * T, 0);
      if (!glow) {
        // The frame's shadow line round the bay, so the bays read apart where they meet.
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(0, 0, 4, H);
        ctx.fillRect(T - 4, 0, 4, H);
      }
      if (t === 0) {
        // The door: glass over a panel, a transom over it, a narrow light either side over a kick plate.
        const door = kind === 'diner' ? '#9aa4a6' : kind === 'sheriff' ? '#5a4128' : '#3a2616';
        lit(96, 10, 64, 18, 0);
        lit(96, 34, 64, 70, 0);
        for (const x of [14, 176]) lit(x, 30, 66, 112, rng.chance(0.5) ? 1 : 3);
        if (!glow) {
          ctx.fillStyle = door;
          ctx.fillRect(90, 28, 76, 6);
          ctx.fillRect(90, 104, 76, 84);
          for (const x of [90, 160]) ctx.fillRect(x, 28, 6, 160);
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(102, 116, 52, 28);
          ctx.fillRect(102, 152, 52, 28);
          ctx.fillStyle = '#d8c070';
          ctx.fillRect(148, 112, 6, 12);
          for (const x of [14, 176]) kickPlate(x, 66);
          if (kind === 'sheriff') {
            ctx.fillStyle = '#e8c547';
            ctx.beginPath();
            for (let k = 0; k < 10; k++) {
              const a = -Math.PI / 2 + (k * Math.PI) / 5;
              const r = k % 2 === 0 ? 22 : 9;
              ctx.lineTo(128 + Math.cos(a) * r, 68 + Math.sin(a) * r);
            }
            ctx.fill();
          }
          if (kind === 'diner') {
            ctx.fillStyle = '#c4262e';
            ctx.font = '700 16px Anton, Impact, "Arial Black", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('PUSH', 128, 98);
          }
        }
      } else if (kind === 'diner') {
        // A ribbon of glass along the counter, running on from bay to bay; chrome mullions.
        lit(0, 36, T, 108, 4);
        if (!glow) {
          ctx.fillStyle = '#7d878a';
          for (const x of [0, T / 2 - 3, T - 6]) ctx.fillRect(x, 36, 6, 108);
          ctx.fillStyle = '#e8eef0';
          ctx.fillRect(0, 30, T, 6);
          ctx.fillRect(0, 144, T, 6);
          kickPlate(0, T);
        }
      } else {
        // A display window under its transom lights, over a panelled kick plate.
        const goods = kind === 'sheriff' ? 3 : t;
        lit(14, 30, 228, 112, goods);
        // A card in the window hangs in one pane, no mullion across it.
        sash(14, 30, 228, 112, goods === 2 ? 1 : kind === 'gas' ? 2 : 3);
        if (!glow) {
          kickPlate(14, 228);
          if (kind === 'sheriff') {
            ctx.fillStyle = '#2c2c2e';
            for (let x = 30; x < 240; x += 26) ctx.fillRect(x, 30, 4, 112);
          }
          if (kind === 'gas') {
            ctx.fillStyle = '#1f6fb2';
            ctx.fillRect(40 + t * 12, 50, 60, 80);
            ctx.fillStyle = '#ffcf3d';
            ctx.fillRect(140, 60 + t * 6, 70, 46);
          }
        }
      }
      ctx.restore();
    }
  }, true);
}

/** A shop front's bay on the wall (m): a quarter of the band's 1024 px, at the band's 192 px to SHOP_TOP. */
const BAY_W = (SHOP_TOP * 256) / 192;

/** Splits a front of width `w` into an odd number of bays near BAY_W each, so the door's stands in the middle. */
export function bays(w: number): number {
  const n = Math.max(1, Math.round(w / BAY_W));
  if (n % 2 === 1) return n;
  // Of the odd counts either side, the one whose bays stretch or squeeze the band the least.
  const off = (k: number) => Math.max(w / k / BAY_W, (k * BAY_W) / w);
  return off(n + 1) < off(n - 1) ? n + 1 : n - 1;
}

/** A canvas awning's band: broad stripes of the trim's colour and white, eight to the band's width. */
function stripes(kit: PlacesKit, color: string): [number, number] {
  return kit.atlas.band(32, (ctx) => {
    for (let k = 0; k < 16; k++) {
      ctx.fillStyle = k % 2 === 0 ? color : '#f4f0e6';
      ctx.fillRect(k * 64, 0, 64, 32);
    }
  });
}

/** The cob's kernels: rows of rounded yellow kernels. */
function kernels(kit: PlacesKit): [number, number] {
  return kit.atlas.band(128, (ctx) => {
    ctx.fillStyle = '#a77a12';
    ctx.fillRect(0, 0, 1024, 128);
    for (let r = 0; r < 8; r++) {
      for (let k = 0; k < 40; k++) {
        ctx.fillStyle = (r + k) % 7 === 0 ? '#f7d24a' : '#f2c230';
        ctx.beginPath();
        ctx.ellipse(13 + k * 25.6 + (r % 2) * 12, 8 + r * 16, 11, 7, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}

/**
 * A cylinder band of `v` round (cx, cz) of radius r, from y0 to y1, centred on the bearing `toward` (radians from +x
 * towards +z) and `span` radians wide, in `n` quads facing out.
 */
function wrap(p: PlacePieces, v: [number, number], cx: number, cz: number, r: number, y0: number, y1: number, toward: number, span: number, n: number): void {
  for (let k = 0; k < n; k++) {
    const a0 = toward + span / 2 - (span * k) / n;
    const a1 = toward + span / 2 - (span * (k + 1)) / n;
    const u0 = k / n;
    const u1 = (k + 1) / n;
    const ax = cx + Math.cos(a0) * r;
    const az = cz + Math.sin(a0) * r;
    const bx = cx + Math.cos(a1) * r;
    const bz = cz + Math.sin(a1) * r;
    p.painted.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, [u0, v[0], u1, v[0], u1, v[1], u0, v[1]]);
  }
}

/** The painted surfaces the stores share: their shop fronts' bands by design, the tin of the porch roofs, the diner's awning. */
interface StoreBands {
  fronts: Record<'shop' | 'diner' | 'sheriff' | 'gas', [number, number]>;
  tin: [number, number];
  awning: [number, number];
}

function drawStore(view: CountryView, kit: PlacesKit, p: PlacePieces, facades: Map<FacadeStyle, GeoBuilder>, s: Store, bands: StoreBands): void {
  const tin = bands.tin;
  const b = view.world.layout.buildings.find((q) => q.id === s.building)!;
  const L = look(s);
  const south = s.front === 'S';
  const slab = b.tiers[0]!;
  const body = s.body;
  const h = hashInts(b.id, 0x7c0);
  const cell = FACADE_CELL[b.style];
  const uv = { kind: 'facade' as const, w: cell.w * FACADE_COLS, h: cell.h * FACADE_ROWS, offU: (h % FACADE_COLS) / FACADE_COLS, offV: ((h >>> 8) % FACADE_ROWS) / FACADE_ROWS, baseY: SHOP_TOP + 0.1 };
  let gb = facades.get(b.style);
  if (!gb) facades.set(b.style, (gb = new GeoBuilder(true, true)));
  gb.seed = (hashInts(b.id, 0x5eed) % 1000) / 1000;
  const wall = L.wall;
  gb.box(slab.minX, 0, slab.minZ, slab.maxX, s.top, slab.maxZ, { uv, color: wall, top: false });
  gb.box(body.minX, 0, body.minZ, body.maxX, s.eaves, body.maxZ, { uv, color: wall, top: false });
  // The gable runs back from the false front, low enough to hide behind it.
  const w = body.maxX - body.minX;
  const rise = Math.min(w * 0.18, s.top - s.eaves - 0.35);
  // Its two slopes in the places' tin, running back from the front, and its back gable in the wall's colour.
  {
    const cx = (body.minX + body.maxX) / 2;
    const [z0, z1] = [body.minZ - 0.3, body.maxZ + 0.3];
    const run = (z1 - z0) / TIN_TILE;
    for (const sx of [-1, 1]) {
      const ex = sx < 0 ? body.minX - 0.3 : body.maxX + 0.3;
      face(p.painted, [ex, s.eaves - 0.05, z0], [ex, s.eaves - 0.05, z1], [cx, s.eaves + rise, z1], [cx, s.eaves + rise, z0], [sx, 1, 0], TIN, [0, tin[0], run, tin[0], run, tin[1], 0, tin[1]]);
      face(p.plain, [ex, s.eaves - 0.08, z0], [ex, s.eaves - 0.08, z1], [cx, s.eaves + rise - 0.03, z1], [cx, s.eaves + rise - 0.03, z0], [-sx, -1, 0], scaleRgb(WOOD, 0.8));
    }
    for (const [z, sz] of [[body.minZ, -1], [body.maxZ, 1]] as const) tri(p.plain, [body.minX, s.eaves, z], [body.maxX, s.eaves, z], [cx, s.eaves + rise - 0.05, z], [0, 0, sz], scaleRgb(wall, 0.92));
    beam(p.plain, [cx, s.eaves + rise + 0.02, z0], [cx, s.eaves + rise + 0.02, z1], 0.14, scaleRgb(TIN, 0.7));
  }
  const fz = south ? slab.maxZ : slab.minZ;
  const out = south ? 1 : -1;
  /** A box on the front from x0 to x1, y0 to y1, standing `d` m proud of it. */
  const onFront = (x0: number, y0: number, x1: number, y1: number, d: number, c: RGB) => boxC(p.plain, x0, y0, Math.min(fz, fz + out * d), x1, y1, Math.max(fz, fz + out * d), c);
  // The false front's cap, a cornice on brackets under it, the corner boards up its edges.
  boxC(p.plain, slab.minX - 0.12, s.top, slab.minZ - 0.12, slab.maxX + 0.12, s.top + 0.22, slab.maxZ + 0.12, L.trim);
  const dark = scaleRgb(L.trim, 0.82);
  onFront(slab.minX - 0.05, s.top - 0.3, slab.maxX + 0.05, s.top, 0.3, L.trim);
  const corbels = Math.max(2, Math.round((slab.maxX - slab.minX) / 1.6));
  for (let k = 0; k <= corbels; k++) {
    const x = slab.minX + 0.2 + ((slab.maxX - slab.minX - 0.4) * k) / corbels;
    onFront(x - 0.07, s.top - 0.5, x + 0.07, s.top - 0.3, 0.26, dark);
  }
  for (const x of [slab.minX, slab.maxX - 0.25]) boxC(p.plain, x, 0, fz - 0.06, x + 0.25, s.top, fz + 0.06, L.trim);
  // The shop front in bays of the band's quarters, the door's in the middle: pilasters between them on plinths, a sill
  // ledge under the windows, the door's casing, a frieze over them all.
  const rot = south ? 0 : Math.PI;
  const cx = (slab.minX + slab.maxX) / 2;
  const x0 = slab.minX + 0.25;
  const x1 = slab.maxX - 0.25;
  const n = bays(x1 - x0);
  const bw = (x1 - x0) / n;
  const pick = hashInts(b.id, 0xba7);
  for (let k = 0; k < n; k++) {
    const bx = x0 + bw * (k + 0.5);
    const door = k === (n - 1) / 2;
    const tile = door ? 0 : 1 + ((pick >>> (k * 2)) % 3);
    kit.board(p, bands.fronts[L.front], bw, SHOP_TOP, bx, SHOP_TOP / 2 + 0.02, fz + out * 0.03, rot, (tile * 256 + 3) / 1024, ((tile + 1) * 256 - 3) / 1024);
    if (door) {
      // The casing round the door's glass (0.375 to 0.625 of the bay, up to the transom's head), and its step.
      const d0 = bx - 0.125 * bw - 0.12;
      const d1 = bx + 0.125 * bw + 0.12;
      for (const x of [d0, d1 - 0.12]) onFront(x, 0, x + 0.12, SHOP_TOP - 0.12, 0.1, L.trim);
      onFront(d0 - 0.1, SHOP_TOP - 0.17, d1 + 0.1, SHOP_TOP - 0.03, 0.14, L.trim);
      onFront(d0 - 0.1, 0, d1 + 0.1, DECK_Y + 0.1, 0.32, scaleRgb(WOOD, 0.85));
    }
    if (L.front !== 'diner' && !door) onFront(bx - bw / 2 + 0.2, 0.72, bx + bw / 2 - 0.2, 0.8, 0.14, dark);
    if (k > 0) {
      const x = x0 + bw * k;
      onFront(x - 0.14, 0, x + 0.14, SHOP_TOP, 0.1, L.trim);
      onFront(x - 0.18, 0, x + 0.18, 0.5, 0.14, dark);
    }
  }
  onFront(slab.minX + 0.1, SHOP_TOP, slab.maxX - 0.1, SHOP_TOP + 0.3, 0.16, L.trim);
  // Over the boardwalk: the diner's striped awning on iron rods, everyone else's porch roof in tin on posts.
  if (L.front === 'diner') awning(p, bands.awning, slab.minX + 0.4, slab.maxX - 0.4, fz, out);
  else porchRoof(p, bands.tin, slab, fz, out, L.trim);
  // The sign between the porch and the cornice: its board on a backing of the trim, a moulding along its top and foot.
  const lo = PORCH.high + 0.25;
  const hi = s.top - 0.6;
  const sh = Math.min(1.5, hi - lo - 0.3);
  const sy = (lo + hi) / 2;
  const sw = Math.min(slab.maxX - slab.minX - 1.6, sh * 8);
  onFront(cx - sw / 2 - 0.14, sy - sh / 2 - 0.14, cx + sw / 2 + 0.14, sy + sh / 2 + 0.14, 0.08, L.trim);
  for (const y of [sy - sh / 2 - 0.2, sy + sh / 2 + 0.08]) onFront(cx - sw / 2 - 0.22, y, cx + sw / 2 + 0.22, y + 0.12, 0.14, dark);
  kit.board(p, sign(kit, [[s.name, 92]], L.sign[0], L.sign[1]), sw, sh, cx, sy, fz + out * 0.09, rot);
}

/**
 * A porch roof over a boardwalk, from the front at `fz` out 3 m: tin on top falling to the street, boards and joists
 * under it, a beam along its edge on posts PORCH.gap apart, each post on a base block with a knee brace either side.
 */
function porchRoof(p: PlacePieces, tin: [number, number], slab: { minX: number; maxX: number }, fz: number, out: number, trim: RGB): void {
  const ph = PORCH;
  const edge = fz + out * 3;
  const xa = slab.minX - 0.1;
  const xb = slab.maxX + 0.1;
  const run = (xb - xa) / TIN_TILE;
  const top: V[] = [[xa, ph.high, fz], [xb, ph.high, fz], [xb, ph.low, edge + out * 0.15], [xa, ph.low, edge + out * 0.15]];
  face(p.painted, top[3]!, top[2]!, top[1]!, top[0]!, [0, 1, out * 0.2], TIN, [0, tin[0], run, tin[0], run, tin[1], 0, tin[1]]);
  face(p.plain, [xa, ph.high - 0.05, fz], [xb, ph.high - 0.05, fz], [xb, ph.low - 0.05, edge], [xa, ph.low - 0.05, edge], [0, -1, 0], scaleRgb(WOOD, 0.8));
  // Joists under the boards, from a ledger on the front to the beam.
  const zr = (a: number, b: number): [number, number] => [Math.min(fz + out * a, fz + out * b), Math.max(fz + out * a, fz + out * b)];
  const [la, lb] = zr(0, 0.12);
  boxC(p.plain, xa, ph.high - 0.25, la, xb, ph.high - 0.05, lb, scaleRgb(WOOD, 0.7));
  for (let x = xa + 0.6; x < xb - 0.3; x += 1.2) beam(p.plain, [x, ph.high - 0.12, fz + out * 0.12], [x, ph.low - 0.12, edge - out * 0.12], 0.09, scaleRgb(WOOD, 0.7));
  // The beam on the posts' heads, 2.8 m out, just under the boards there.
  const [ea, eb] = zr(2.66, 2.94);
  boxC(p.plain, xa, ph.low - 0.26, ea, xb, ph.low - 0.02, eb, trim);
  const posts = Math.max(2, Math.round((slab.maxX - slab.minX) / ph.gap) + 1);
  const pz = edge - out * 0.2;
  for (let k = 0; k < posts; k++) {
    const x = slab.minX + 0.1 + ((slab.maxX - slab.minX - 0.2) * k) / (posts - 1);
    boxC(p.plain, x - ph.post / 2, DECK_Y, pz - ph.post / 2, x + ph.post / 2, ph.low - 0.26, pz + ph.post / 2, trim);
    boxC(p.plain, x - 0.13, DECK_Y, pz - 0.13, x + 0.13, DECK_Y + 0.22, pz + 0.13, scaleRgb(trim, 0.8));
    for (const s of [-1, 1]) {
      if ((k === 0 && s < 0) || (k === posts - 1 && s > 0)) continue;
      beam(p.plain, [x, ph.low - 0.85, pz], [x + s * 0.6, ph.low - 0.26, pz], 0.08, trim);
    }
  }
}

/**
 * A canvas awning over the boardwalk from x0 to x1: striped, falling from 3.65 m at the front to 3.05 m 2 m out, its
 * valance hanging at the edge, the iron rods that hold it out from the wall.
 */
function awning(p: PlacePieces, band: [number, number], x0: number, x1: number, fz: number, out: number): void {
  const u0 = x0 / 8;
  const u1 = x1 / 8;
  const ez = fz + out * 2;
  const uv = [u0, band[0], u1, band[0], u1, band[1], u0, band[1]];
  face(p.painted, [x0, 3.05, ez], [x1, 3.05, ez], [x1, 3.65, fz], [x0, 3.65, fz], [0, 1, out * 0.3], [1, 1, 1], uv);
  face(p.painted, [x0, 3.04, ez], [x1, 3.04, ez], [x1, 3.64, fz], [x0, 3.64, fz], [0, -1, 0], [0.7, 0.7, 0.7], uv);
  face(p.painted, [x0, 2.78, ez], [x1, 2.78, ez], [x1, 3.05, ez], [x0, 3.05, ez], [0, 0, out], [1, 1, 1], uv);
  face(p.painted, [x0, 2.78, ez], [x1, 2.78, ez], [x1, 3.05, ez], [x0, 3.05, ez], [0, 0, -out], [0.7, 0.7, 0.7], uv);
  for (let x = x0 + 0.3; x < x1; x += 2.4) beam(p.plain, [x, 2.6, fz], [x, 3.08, ez - out * 0.1], 0.04, [0.16, 0.16, 0.17]);
}

/** Slipformed concrete: the lifts' faint seams across it, darker streaks run down from the top, a little grime toward the foot (v[0]). */
function concreteBand(kit: PlacesKit): [number, number] {
  return paddedBand(kit.atlas, 256, (ctx) => {
    const rng = new Rng(4420);
    ctx.fillStyle = '#d2cdc2';
    ctx.fillRect(0, 0, 1024, 256);
    for (let k = 0; k < 160; k++) {
      const l = rng.int(150, 215);
      ctx.fillStyle = `rgba(${l},${l - 4},${l - 12},0.35)`;
      ctx.fillRect(rng.range(0, 1024), 0, rng.range(2, 10), rng.range(30, 256));
    }
    ctx.fillStyle = 'rgba(90,84,74,0.1)';
    for (let y = 64; y < 256; y += 64) ctx.fillRect(0, y, 1024, 2);
    const grime = ctx.createLinearGradient(0, 0, 0, 256);
    grime.addColorStop(0, 'rgba(60,54,44,0.03)');
    grime.addColorStop(0.5, 'rgba(60,54,44,0)');
    grime.addColorStop(1, 'rgba(60,54,44,0.07)');
    ctx.fillStyle = grime;
    ctx.fillRect(0, 0, 1024, 256);
  });
}

/** The concrete band's tile round a silo (m): its width spans about CONCRETE_TILE m of wall (a whole number of them round it), its height a sixth of the silo. */
const CONCRETE_TILE = 8;

/**
 * The grain elevator: concrete silos in lifts of the concrete band under a rim and a low cone, on a darker footing, a
 * caged ladder up the west one; the head house across their tops and the leg tower at their east end in ribbed tin with
 * a strip of windows, roofed in tin; the spout from the leg down to the head house.
 */
function elevator(p: PlacePieces, e: TownAnchors['elevator'], tin: [number, number], concrete: [number, number]): void {
  const n = 24;
  const lifts = 6;
  // A whole number of the band's widths round a silo, so its u meets itself where the circle closes.
  const round = Math.max(1, Math.round((2 * Math.PI * e.r) / CONCRETE_TILE));
  for (const s of e.silos) {
    for (let j = 0; j < lifts; j++) {
      const y0 = (e.height * j) / lifts;
      const y1 = (e.height * (j + 1)) / lifts;
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2;
        const a1 = ((k + 1) / n) * Math.PI * 2;
        const P = (a: number, y: number): V => [s.x + Math.cos(a) * e.r, y, s.z + Math.sin(a) * e.r];
        const am = (a0 + a1) / 2;
        face(p.painted, P(a1, y0), P(a0, y0), P(a0, y1), P(a1, y1), [Math.cos(am), 0, Math.sin(am)], [1, 1, 1], [((k + 1) / n) * round, concrete[0], (k / n) * round, concrete[0], (k / n) * round, concrete[1], ((k + 1) / n) * round, concrete[1]]);
      }
    }
    prism(p.plain, s.x, s.z, e.r + 0.08, e.r + 0.08, 0, 0.9, n, scaleRgb(CONCRETE, 0.78), false);
    prism(p.plain, s.x, s.z, e.r + 0.1, e.r + 0.1, e.height - 0.1, e.height + 0.35, n, scaleRgb(CONCRETE, 0.95), false);
    prism(p.plain, s.x, s.z, e.r + 0.1, e.r * 0.25, e.height + 0.35, e.height + 1.1, n, scaleRgb(CONCRETE, 0.86));
  }
  // The caged ladder up the west silo's south side: two stiles, rungs every 0.4 m, hoops from 3 m up.
  const w = e.silos[0]!;
  const lz = w.z + e.r + 0.25;
  const iron: RGB = [0.32, 0.33, 0.35];
  for (const dx of [-0.25, 0.25]) boxC(p.plain, w.x + dx - 0.03, 0.9, lz - 0.03, w.x + dx + 0.03, e.height + 0.9, lz + 0.03, iron);
  for (let y = 1.2; y < e.height + 0.6; y += 0.4) boxC(p.plain, w.x - 0.25, y, lz - 0.02, w.x + 0.25, y + 0.035, lz + 0.02, iron);
  for (let y = 3; y < e.height + 0.6; y += 1.5) {
    boxC(p.plain, w.x - 0.4, y, lz + 0.62, w.x + 0.4, y + 0.06, lz + 0.68, iron);
    for (const dx of [-0.4, 0.4]) boxC(p.plain, w.x + dx - 0.03, y, lz - 0.05, w.x + dx + 0.03, y + 0.06, lz + 0.68, iron);
  }
  for (const dx of [-0.4, 0.4]) boxC(p.plain, w.x + dx - 0.025, 3, lz + 0.62, w.x + dx + 0.025, e.height + 0.6, lz + 0.66, iron);
  // The head house and the leg tower: tin walls round a box, windows along the head house, tin roofs.
  const grey: RGB = [0.74, 0.76, 0.78];
  const walls = (r: { minX: number; minZ: number; maxX: number; maxZ: number }, y0: number, y1: number) => {
    const rise = tin[1] - tin[0];
    const v: [number, number] = [tin[0] + rise * 0.15, tin[1]];
    paintWall(p, [r.minX, y0, r.maxZ], [r.maxX, y0, r.maxZ], y1, [0, 0, 1], grey, v);
    paintWall(p, [r.maxX, y0, r.minZ], [r.minX, y0, r.minZ], y1, [0, 0, -1], grey, v);
    paintWall(p, [r.maxX, y0, r.maxZ], [r.maxX, y0, r.minZ], y1, [1, 0, 0], scaleRgb(grey, 0.95), v);
    paintWall(p, [r.minX, y0, r.minZ], [r.minX, y0, r.maxZ], y1, [-1, 0, 0], scaleRgb(grey, 0.95), v);
  };
  walls(e.head, e.height, e.headTop);
  // The head house's floor over the gaps between the silos' tops, seen from the ground between them.
  const hd = e.head;
  face(p.plain, [hd.minX, e.height, hd.maxZ], [hd.maxX, e.height, hd.maxZ], [hd.maxX, e.height, hd.minZ], [hd.minX, e.height, hd.minZ], [0, -1, 0], scaleRgb(grey, 0.7));
  walls(e.leg, 0, e.top - 1.5);
  const roofs = (r: { minX: number; minZ: number; maxX: number; maxZ: number }, y: number, rise: number) => {
    const cz = (r.minZ + r.maxZ) / 2;
    const run = (r.maxX - r.minX + 0.5) / TIN_TILE;
    for (const s of [-1, 1]) {
      const ez = s < 0 ? r.minZ - 0.25 : r.maxZ + 0.25;
      face(p.painted, [r.minX - 0.25, y - 0.05, ez], [r.maxX + 0.25, y - 0.05, ez], [r.maxX + 0.25, y + rise, cz], [r.minX - 0.25, y + rise, cz], [0, 1, s], TIN, [0, tin[0], run, tin[0], run, tin[1], 0, tin[1]]);
      tri(p.plain, [r.minX, y, s < 0 ? r.minZ : r.maxZ], [r.minX, y, cz], [r.minX, y + rise - 0.05, cz], [-1, 0, 0], grey);
      tri(p.plain, [r.maxX, y, s < 0 ? r.minZ : r.maxZ], [r.maxX, y, cz], [r.maxX, y + rise - 0.05, cz], [1, 0, 0], grey);
    }
  };
  roofs(e.head, e.headTop, 1.6);
  roofs(e.leg, e.top - 1.5, 1.5);
  const glass: RGB = [0.16, 0.2, 0.24];
  for (let x = e.head.minX + 1.2; x < e.head.maxX - 1; x += 2.2) {
    for (const [z, s] of [[e.head.maxZ + 0.03, 1], [e.head.minZ - 0.03, -1]] as const) face(p.plain, [x, e.headTop - 2.1, z], [x + 1.1, e.headTop - 2.1, z], [x + 1.1, e.headTop - 1.3, z], [x, e.headTop - 1.3, z], [0, 0, s], glass);
  }
  for (let y = 6; y < e.top - 3; y += 6) face(p.plain, [e.leg.minX + 1.2, y, e.leg.maxZ + 0.03], [e.leg.maxX - 1.2, y, e.leg.maxZ + 0.03], [e.leg.maxX - 1.2, y + 1, e.leg.maxZ + 0.03], [e.leg.minX + 1.2, y + 1, e.leg.maxZ + 0.03], [0, 0, 1], glass);
  // The spout from the leg down to the head house, and a catwalk rail along the head house's south edge.
  boxC(p.plain, e.head.maxX, e.headTop - 1.2, -318.2, e.leg.minX, e.headTop - 0.8, -317.8, [0.5, 0.5, 0.52]);
  beam(p.plain, [e.leg.minX - 0.1, e.top - 4, -318], [e.head.maxX - 2, e.headTop + 0.6, -318], 0.35, [0.55, 0.56, 0.58]);
}

/** A wall from a to b (its foot, left to right seen from outside) up to `y1`, in band `v` along its length. */
function paintWall(p: PlacePieces, a: V, b: V, y1: number, toward: V, tint: RGB, v: readonly [number, number]): void {
  const run = Math.hypot(b[0] - a[0], b[2] - a[2]) / TIN_TILE;
  face(p.painted, a, b, [b[0], y1, b[2]], [a[0], y1, a[2]], toward, tint, [0, v[0], run, v[0], run, v[1], 0, v[1]]);
}

export function buildTown(view: CountryView, kit: PlacesKit): (night: number, time: number) => void {
  const L = view.world.layout;
  const town = L.country.places.town;
  const p = kit.place('dry-creek');
  const facades = new Map<FacadeStyle, GeoBuilder>();
  // The unlit bands first, together at the atlas's top, the concrete between the tin and the cob's kernels: a lit band's
  // glow next to the concrete reached its edges at the coarser mipmaps, and every lift of the silos glowed in a ring at
  // its top after dark.
  const tin = tinBand(kit.atlas);
  const concrete = concreteBand(kit);
  const k = kernels(kit);
  const bands: StoreBands = {
    fronts: { shop: shopFront(kit, 'shop'), diner: shopFront(kit, 'diner'), sheriff: shopFront(kit, 'sheriff'), gas: shopFront(kit, 'gas') },
    tin,
    awning: stripes(kit, '#2f9c9c'),
  };
  for (const s of town.stores) drawStore(view, kit, p, facades, s, bands);
  for (const [style, gb] of facades) view.add(gb.build(), view.city.materials.facades.get(style)!, { shadow: true, split: false, name: `dry-creek-${style}` });

  // The boardwalks: plank decks a few centimetres up (the city's boardwalk timber), a fascia board along their street
  // edge.
  const planks = new GeoBuilder(false);
  for (const r of town.boardwalks) {
    planks.flat(r.minX, r.minZ, r.maxX, r.maxZ, DECK_Y, { kind: 'world', scale: 4 });
    const north = r.maxZ < -268;
    const z = north ? r.maxZ : r.minZ;
    boxC(p.plain, r.minX, 0, z - 0.04, r.maxX, DECK_Y, z + 0.04, WOOD);
  }
  view.add(planks.build(), view.city.wet.patch(view.city.surface('wood')), { split: false, name: 'dry-creek-boardwalks' });
  // Packed dirt on the forecourt and the parking, white lines between the bays, the islands under the pumps.
  const dirtUv = { kind: 'world', scale: view.city.ground.tile('plain') } as const;
  for (const r of town.lots) kit.dirt.flat(r.minX, r.minZ, r.maxX, r.maxZ, DIRT_Y, dirtUv);
  const bays = L.parking.filter((b) => rectContains(town.lots[1]!, b.x, b.z) || rectContains(town.lots[2]!, b.x, b.z));
  for (const b of bays) for (const dx of [-1.8, 1.8]) boxC(p.plain, b.x + dx - 0.06, 0, b.z - 2.3, b.x + dx + 0.06, DIRT_Y + 0.012, b.z + 2.3, [0.86, 0.86, 0.82]);
  for (const x of [-796, -784]) boxC(p.plain, x - 0.7, 0, -296.6, x + 0.7, 0.16, -283.4, CONCRETE);

  // Gas & Grits' canopy: a white slab on red posts, its name round the fascia and lit panels underneath.
  const c = town.canopy;
  const [y0, y1] = town.canopyY;
  boxC(p.plain, c.minX, y0, c.minZ, c.maxX, y1, c.maxZ, WHITE);
  for (const [x, z] of [[-796, -284], [-796, -296], [-784, -284], [-784, -296]] as const) boxC(p.plain, x - 0.2, 0, z - 0.2, x + 0.2, y0, z + 0.2, [0.78, 0.12, 0.12]);
  const fascia = sign(kit, [['GAS & GRITS', 70]], '#ffffff', '#c41f1f', 96);
  const cxm = (c.minX + c.maxX) / 2;
  const czm = (c.minZ + c.maxZ) / 2;
  kit.board(p, fascia, c.maxX - c.minX, y1 - y0, cxm, (y0 + y1) / 2, c.maxZ + 0.02, 0);
  kit.board(p, fascia, c.maxX - c.minX, y1 - y0, cxm, (y0 + y1) / 2, c.minZ - 0.02, Math.PI);
  kit.board(p, fascia, c.maxZ - c.minZ, y1 - y0, c.maxX + 0.02, (y0 + y1) / 2, czm, Math.PI / 2);
  kit.board(p, fascia, c.maxZ - c.minZ, y1 - y0, c.minX - 0.02, (y0 + y1) / 2, czm, -Math.PI / 2);
  // The panels' light lit in the middle third of its band only, so the bands either side never sample its glow at their
  // edges (the CO-OP's sign, painted next, showed a line of it along its top after dark).
  const lit = kit.atlas.band(48, (ctx) => {
    ctx.fillStyle = '#fffaf0';
    if (ctx.canvas === kit.atlas.canvas) ctx.fillRect(0, 0, 1024, 48);
    else ctx.fillRect(0, 16, 1024, 16);
  }, true);
  const panel: [number, number] = [lit[0] + (lit[1] - lit[0]) / 3, lit[1] - (lit[1] - lit[0]) / 3];
  for (const x of [-796, -784]) {
    const q: V[] = [[x - 1.6, y0 - 0.02, -283], [x + 1.6, y0 - 0.02, -283], [x + 1.6, y0 - 0.02, -297], [x - 1.6, y0 - 0.02, -297]];
    face(p.painted, q[0]!, q[1]!, q[2]!, q[3]!, [0, -1, 0], [1, 1, 1], [0, panel[0], 1, panel[0], 1, panel[1], 0, panel[1]]);
  }

  // The grain elevator: concrete silos, the corrugated head house over them and the leg tower at their end.
  elevator(p, town.elevator, tin, concrete);
  const e = town.elevator;
  kit.board(p, sign(kit, [['DRY CREEK CO-OP', 96]], '#f6f1e4', '#7a2e1c'), 12, 1.6, (e.head.minX + e.head.maxX) / 2, e.height + 3.2, e.head.maxZ + 0.04, 0);

  // The water tower: the tank on four legs with a ring of rails, a cone on top, its words to the main street.
  const t = town.tower;
  const steel: RGB = [0.82, 0.84, 0.85];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) boxC(p.plain, t.x + sx * t.legs - 0.18, 0, t.z + sz * t.legs - 0.18, t.x + sx * t.legs + 0.18, t.y0, t.z + sz * t.legs + 0.18, [0.55, 0.57, 0.6]);
  for (const y of [6, 12]) {
    boxC(p.plain, t.x - t.legs, y, t.z - t.legs - 0.06, t.x + t.legs, y + 0.12, t.z - t.legs + 0.06, [0.55, 0.57, 0.6]);
    boxC(p.plain, t.x - t.legs, y, t.z + t.legs - 0.06, t.x + t.legs, y + 0.12, t.z + t.legs + 0.06, [0.55, 0.57, 0.6]);
    boxC(p.plain, t.x - t.legs - 0.06, y, t.z - t.legs, t.x - t.legs + 0.06, y + 0.12, t.z + t.legs, [0.55, 0.57, 0.6]);
    boxC(p.plain, t.x + t.legs - 0.06, y, t.z - t.legs, t.x + t.legs + 0.06, y + 0.12, t.z + t.legs, [0.55, 0.57, 0.6]);
  }
  prism(p.plain, t.x, t.z, 0.35, 0.35, 0, t.y0, 8, [0.5, 0.5, 0.52], false);
  prism(p.plain, t.x, t.z, t.r + 0.7, t.r + 0.7, t.y0 - 0.1, t.y0 + 0.05, 24, [0.5, 0.52, 0.55]);
  prism(p.plain, t.x, t.z, t.r, t.r, t.y0, t.y1, 24, steel, false);
  prism(p.plain, t.x, t.z, t.r, 0.4, t.y1, t.y1 + 2.4, 24, scaleRgb(steel, 0.9));
  const words = kit.atlas.band(256, (ctx) => {
    ctx.fillStyle = '#d1d6d9';
    ctx.fillRect(0, 0, 1024, 256);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1f3a66';
    ctx.font = '700 132px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('DRY CREEK.', 512, 92, 980);
    ctx.font = '700 64px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText("YOU'RE ALMOST SOMEWHERE.", 512, 200, 980);
  });
  // Towards the crossroads (north-west of it).
  wrap(p, words, t.x, t.z, t.r + 0.03, t.y0 + 1.2, t.y1 - 0.8, Math.atan2(-268 - t.z, -840 - t.x), 1.9, 16);

  // The World's Second-Largest Corn Cob on its plinth, husk leaves round its foot, and its plaque.
  const cob = town.cob;
  boxC(p.plain, cob.x - 1.8, 0, cob.z - 1.8, cob.x + 1.8, 0.6, cob.z + 1.8, CONCRETE);
  const segs = [[0.6, 1.25], [2.5, 1.3], [5, 1.18], [7, 0.95], [8.2, 0.62], [cob.height, 0.08]] as const;
  for (let s = 1; s < segs.length; s++) {
    const [ya, ra] = segs[s - 1]!;
    const [yb, rb] = segs[s]!;
    for (let q = 0; q < 16; q++) {
      const a0 = (q / 16) * Math.PI * 2;
      const a1 = ((q + 1) / 16) * Math.PI * 2;
      const u0 = (q % 4) / 4;
      const u1 = u0 + 0.25;
      p.painted.quad(cob.x + Math.cos(a1) * ra, ya, cob.z + Math.sin(a1) * ra, cob.x + Math.cos(a0) * ra, ya, cob.z + Math.sin(a0) * ra, cob.x + Math.cos(a0) * rb, yb, cob.z + Math.sin(a0) * rb, cob.x + Math.cos(a1) * rb, yb, cob.z + Math.sin(a1) * rb, [u1, k[0], u0, k[0], u0, k[1], u1, k[1]]);
    }
  }
  const husk: RGB = [0.42, 0.6, 0.22];
  for (let q = 0; q < 7; q++) {
    const a = (q / 7) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const base: V = [cob.x + ca * 1.2, 0.6, cob.z + sa * 1.2];
    const tip: V = [cob.x + ca * 1.9, 4.6 + (q % 3) * 0.5, cob.z + sa * 1.9];
    const l: V = [base[0] - sa * 0.7, 0.6, base[2] + ca * 0.7];
    const r: V = [base[0] + sa * 0.7, 0.6, base[2] - ca * 0.7];
    tri(p.plain, l, r, tip, [ca, 0.2, sa], husk);
    tri(p.plain, r, l, tip, [-ca, 0, -sa], scaleRgb(husk, 0.8));
  }
  const pl = cob.plaque;
  boxC(p.plain, pl.x - 0.08, 0, pl.z - 0.08, pl.x + 0.08, 1.1, pl.z + 0.08, [0.3, 0.26, 0.2]);
  boxC(p.plain, pl.x - 1.25, 1.1, pl.z - 0.06, pl.x + 1.25, 1.95, pl.z + 0.02, [0.36, 0.25, 0.12]);
  kit.board(p, sign(kit, [["WORLD'S SECOND-LARGEST CORN COB", 64], ["THE LARGEST IS IN A COUNTY WE DON'T SPEAK OF.", 38]], '#f1d27a', '#4a3216', 192), 2.4, 0.8, pl.x, 1.52, pl.z + 0.03, 0);

  // The billboards: two posts and a 12 x 6 m panel, the ad on both faces, lit after dark.
  for (const bb of town.billboards) {
    const q = L.props[bb.prop]!;
    const ad = kit.atlas.band(512, (ctx) => {
      if (ctx.canvas !== kit.atlas.canvas) ctx.globalAlpha = BOARD_GLOW;
      const g = ctx.createLinearGradient(0, 0, 1024, 512);
      g.addColorStop(0, bb.lines[0].startsWith('INJURED') ? '#f4e6c6' : '#c8262c');
      g.addColorStop(1, bb.lines[0].startsWith('INJURED') ? '#e0b45c' : '#7a1218');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1024, 512);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = bb.lines[0].startsWith('INJURED') ? '#2a1a0c' : '#fff6e0';
      ctx.font = '700 128px Anton, Impact, "Arial Black", sans-serif';
      ctx.fillText(bb.lines[0], 512, 190, 960);
      ctx.font = '700 60px Anton, Impact, "Arial Black", sans-serif';
      ctx.fillText(bb.lines[1], 512, 350, 960);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 12;
      ctx.strokeRect(6, 6, 1012, 500);
    }, true);
    for (const dz of [-4.5, 4.5]) prism(p.plain, q.x, q.z + dz, 0.28, 0.25, 0, 9, 8, [0.33, 0.34, 0.37]);
    boxC(p.plain, q.x - 0.15, 5.1, q.z - 6.05, q.x + 0.15, 11.3, q.z + 6.05, [0.33, 0.34, 0.37]);
    kit.board(p, ad, 12, 6, q.x + 0.17, 8.2, q.z, Math.PI / 2);
    kit.board(p, ad, 12, 6, q.x - 0.17, 8.2, q.z, -Math.PI / 2);
  }

  return neonCow(view, town.neon);
}

/**
 * Moo-Moo's neon cow on the diner's false front: a cow in pink and white tubes that kicks a hind leg out after dark,
 * two frames side by side in its own small texture, swapped twice a second. Unlit by day.
 */
function neonCow(view: CountryView, at: { x: number; z: number; y: number }): (night: number, time: number) => void {
  const [c, ctx] = canvas(512, 256);
  for (let f = 0; f < 2; f++) {
    ctx.save();
    ctx.translate(f * 256, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const tube = (color: string, w: number, path: () => void) => {
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.lineWidth = w;
      ctx.beginPath();
      path();
      ctx.stroke();
    };
    tube('#ff5fb4', 7, () => {
      ctx.ellipse(120, 120, 62, 34, 0, 0, Math.PI * 2);
      ctx.moveTo(182, 106);
      ctx.lineTo(214, 92);
      ctx.lineTo(228, 112);
      ctx.lineTo(206, 128);
      ctx.lineTo(182, 124);
    });
    tube('#ffffff', 6, () => {
      for (const x of [78, 96, 154]) {
        ctx.moveTo(x, 150);
        ctx.lineTo(x, 196);
      }
      // The fourth leg: down, or kicked out behind.
      if (f === 0) {
        ctx.moveTo(140, 150);
        ctx.lineTo(140, 196);
      } else {
        ctx.moveTo(68, 140);
        ctx.lineTo(28, 168);
      }
      ctx.moveTo(58, 110);
      ctx.quadraticCurveTo(36, 120, 40, 150);
      ctx.moveTo(206, 92);
      ctx.lineTo(200, 76);
      ctx.moveTo(220, 96);
      ctx.lineTo(232, 82);
    });
    tube('#ffe066', 5, () => {
      ctx.font = '700 40px Anton, Impact, "Arial Black", sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeText('MOO!', 128, 42);
    });
    ctx.restore();
  }
  const tex = toTexture(c, true, false);
  tex.repeat.set(0.5, 1);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color(0.25, 0.25, 0.25), fog: false });
  const geo = new THREE.PlaneGeometry(5.6, 2.8);
  geo.translate(at.x, at.y + 1.4, at.z);
  view.add(geo, mat, { split: false, receive: false, name: 'dry-creek-neon' });
  return (night, time) => {
    tex.offset.x = night > 0.3 && Math.floor(time * 2) % 2 === 1 ? 0.5 : 0;
    mat.color.setScalar(0.25 + night * 1.6);
  };
}
