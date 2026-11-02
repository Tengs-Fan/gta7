// Dry Creek (world/country/places.ts): its stores' false fronts, gables, shop windows and porches over the boardwalks,
// their signs; Gas & Grits' canopy and islands (the pumps are props: render/props.ts draws them with pumpGeometry); the
// grain elevator, the water tower and the World's Second-Largest Corn Cob; the town's two billboards; the gravel of the
// forecourt and the parking; and Moo-Moo's neon cow, which kicks after dark. The stores' walls take the city's facade
// materials (and so its night windows), a draw a style; the rest is the town's piece of the places' atlas (kit.ts) but
// for the neon, a draw of its own.

import * as THREE from 'three';
import type { Store, StoreKind } from '../../world/country/places';
import { hashInts, rectContains, type FacadeStyle } from '../../world/layout';
import { boxC, face, pitched, tri, type V } from '../city/attractions';
import { prism } from '../city/rooftops';
import { box, cyl, ModelBuilder } from '../furniture';
import { GeoBuilder, scaleRgb, type RGB } from '../geo';
import { FACADE_CELL, FACADE_COLS, FACADE_ROWS } from '../textures/facade';
import { canvas, toTexture } from '../textures/misc';
import type { CountryView } from './index';
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

/** A shop window band (lit after dark): display windows and a door in a timber frame, in one of four designs. */
function shopFront(kit: PlacesKit, kind: 'shop' | 'diner' | 'sheriff' | 'gas'): [number, number] {
  const H = 192;
  return kit.atlas.band(H, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    const frame = glow ? '#000' : kind === 'diner' ? '#c9d2d4' : kind === 'gas' ? '#e8e6e0' : '#4a3322';
    const lit = (x: number, y: number, w: number, h: number) => {
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, glow ? '#5a4520' : '#f3d88f');
      g.addColorStop(1, glow ? '#3a2a10' : '#b8873c');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      if (glow) return;
      // Shelves and goods behind the glass.
      ctx.fillStyle = 'rgba(70,44,20,0.55)';
      for (let k = 1; k < 4; k++) ctx.fillRect(x, y + (h * k) / 4, w, 4);
      for (let k = 0; k < w; k += 23) ctx.fillRect(x + k + 4, y + h * 0.55, 12, h * 0.2);
    };
    ctx.fillStyle = frame;
    ctx.fillRect(0, 0, 1024, H);
    if (kind === 'diner') {
      // A ribbon of glass along the counter, chrome stools under it, the door at the left.
      lit(150, 40, 840, 100);
      if (!glow) {
        ctx.fillStyle = '#c4262e';
        for (let x = 190; x < 980; x += 60) ctx.fillRect(x, 118, 26, 22);
        ctx.fillStyle = '#7d878a';
        for (let x = 300; x < 990; x += 120) ctx.fillRect(x, 40, 6, 100);
      }
      lit(30, 30, 90, 150);
      return;
    }
    // Two display windows either side of the door, transoms over them, a kick plate under.
    lit(40, 30, 380, 110);
    lit(604, 30, 380, 110);
    lit(452, 30, 120, 150);
    if (glow) return;
    ctx.fillStyle = frame;
    for (const x of [228, 792]) ctx.fillRect(x, 30, 8, 110);
    ctx.fillRect(40, 64, 380, 6);
    ctx.fillRect(604, 64, 380, 6);
    ctx.fillStyle = kind === 'gas' ? '#c41f1f' : '#3a2616';
    ctx.fillRect(40, 146, 380, 40);
    ctx.fillRect(604, 146, 380, 40);
    // The door: a panel under its glass and a handle.
    ctx.fillStyle = kind === 'sheriff' ? '#5a4128' : '#3a2616';
    ctx.fillRect(452, 110, 120, 70);
    ctx.fillStyle = '#d8c070';
    ctx.fillRect(552, 120, 8, 14);
    if (kind === 'sheriff') {
      // The star on the door, and bars across the windows.
      ctx.fillStyle = '#e8c547';
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const r = k % 2 === 0 ? 30 : 13;
        ctx.lineTo(512 + Math.cos(a) * r, 72 + Math.sin(a) * r);
      }
      ctx.fill();
      ctx.fillStyle = '#2c2c2e';
      for (let x = 60; x < 420; x += 40) ctx.fillRect(x, 30, 5, 110);
      for (let x = 624; x < 984; x += 40) ctx.fillRect(x, 30, 5, 110);
    }
    if (kind === 'gas') {
      ctx.fillStyle = '#1f6fb2';
      for (let x = 620; x < 970; x += 70) ctx.fillRect(x, 36, 56, 96);
    }
  }, true);
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

function drawStore(view: CountryView, kit: PlacesKit, p: PlacePieces, facades: Map<FacadeStyle, GeoBuilder>, s: Store, fronts: Record<string, [number, number]>): void {
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
  pitched(p.plain, body, s.eaves, s.eaves + rise, false, 0.3, TIN, scaleRgb(wall, 0.92));
  // The false front's cap and corner boards.
  boxC(p.plain, slab.minX - 0.12, s.top, slab.minZ - 0.12, slab.maxX + 0.12, s.top + 0.22, slab.maxZ + 0.12, L.trim);
  const fz = south ? slab.maxZ : slab.minZ;
  const out = south ? 1 : -1;
  for (const x of [slab.minX, slab.maxX - 0.25]) boxC(p.plain, x, 0, fz - 0.06, x + 0.25, s.top, fz + 0.06, L.trim);
  // The shop windows across the front, the porch roof over the boardwalk on its posts, and the sign above it.
  const rot = south ? 0 : Math.PI;
  const cx = (slab.minX + slab.maxX) / 2;
  kit.board(p, fronts[L.front]!, slab.maxX - slab.minX - 0.6, SHOP_TOP, cx, SHOP_TOP / 2 + 0.02, fz + out * 0.03, rot);
  const edge = fz + out * 3;
  const ph = PORCH;
  const roof: V[] = [[slab.minX - 0.1, ph.high, fz], [slab.maxX + 0.1, ph.high, fz], [slab.maxX + 0.1, ph.low, edge], [slab.minX - 0.1, ph.low, edge]];
  face(p.plain, roof[0]!, roof[1]!, roof[2]!, roof[3]!, [0, 1, out * 0.2], TIN);
  face(p.plain, roof[3]!, roof[2]!, roof[1]!, roof[0]!, [0, -1, 0], scaleRgb(WOOD, 0.8));
  boxC(p.plain, slab.minX - 0.1, ph.low - 0.2, edge - 0.06, slab.maxX + 0.1, ph.low, edge + 0.06, L.trim);
  const posts = Math.max(2, Math.round((slab.maxX - slab.minX) / ph.gap) + 1);
  for (let k = 0; k < posts; k++) {
    const x = slab.minX + 0.1 + ((slab.maxX - slab.minX - 0.2) * k) / (posts - 1);
    boxC(p.plain, x - ph.post / 2, DECK_Y, edge - out * 0.2 - ph.post / 2, x + ph.post / 2, ph.low, edge - out * 0.2 + ph.post / 2, L.trim);
  }
  const sh = Math.min(1.5, s.top - ph.high - 0.5);
  const sw = Math.min(slab.maxX - slab.minX - 1.6, sh * 8);
  kit.board(p, sign(kit, [[s.name, 92]], L.sign[0], L.sign[1]), sw, sh, cx, (ph.high + s.top) / 2 + 0.15, fz + out * 0.05, rot);
}

export function buildTown(view: CountryView, kit: PlacesKit): (night: number, time: number) => void {
  const L = view.world.layout;
  const town = L.country.places.town;
  const p = kit.place('dry-creek');
  const facades = new Map<FacadeStyle, GeoBuilder>();
  const front: Record<string, [number, number]> = {};
  for (const k of ['shop', 'diner', 'sheriff', 'gas'] as const) front[k] = shopFront(kit, k);
  for (const s of town.stores) drawStore(view, kit, p, facades, s, front);
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
  const panel = kit.atlas.band(16, (ctx) => {
    ctx.fillStyle = '#fffaf0';
    ctx.fillRect(0, 0, 1024, 16);
  }, true);
  for (const x of [-796, -784]) {
    const q: V[] = [[x - 1.6, y0 - 0.02, -283], [x + 1.6, y0 - 0.02, -283], [x + 1.6, y0 - 0.02, -297], [x - 1.6, y0 - 0.02, -297]];
    face(p.painted, q[0]!, q[1]!, q[2]!, q[3]!, [0, -1, 0], [1, 1, 1], [0, panel[0], 1, panel[0], 1, panel[1], 0, panel[1]]);
  }

  // The grain elevator: concrete silos, the corrugated head house over them and the leg tower at their end.
  const e = town.elevator;
  for (const s of e.silos) {
    prism(p.plain, s.x, s.z, e.r, e.r, 0, e.height, 20, CONCRETE, false);
    prism(p.plain, s.x, s.z, e.r, e.r * 0.25, e.height, e.height + 0.8, 20, scaleRgb(CONCRETE, 0.9));
  }
  boxC(p.plain, e.head.minX, e.height, e.head.minZ, e.head.maxX, e.headTop, e.head.maxZ, [0.62, 0.64, 0.66]);
  pitched(p.plain, e.head, e.headTop, e.headTop + 1.6, true, 0.25, TIN, [0.6, 0.62, 0.64]);
  boxC(p.plain, e.leg.minX, 0, e.leg.minZ, e.leg.maxX, e.top - 1.5, e.leg.maxZ, [0.6, 0.62, 0.64]);
  pitched(p.plain, e.leg, e.top - 1.5, e.top, true, 0.2, TIN, [0.6, 0.62, 0.64]);
  // A spout from the leg down to the silos, and the co-op's name on the head house over the town.
  boxC(p.plain, e.head.maxX, e.headTop - 1.2, -318.2, e.leg.minX, e.headTop - 0.8, -317.8, [0.5, 0.5, 0.52]);
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
  const k = kernels(kit);
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
