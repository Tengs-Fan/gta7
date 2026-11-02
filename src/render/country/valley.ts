// Las Lomas Valley's farms (world/country/valley.ts), drawn: Sunset Vineyard's rows (vines.ts), its stone winery on the rise's
// crest with a tasting porch under strings of bulbs that shine after dark, the barrel stack, the wooden sign at the
// drive's mouth; the Lazy Q Ranch's house, the gambrel roof over its red barn, the gate over its drive with the brand
// on it, the round bales and the paddocks' shelters; and the ruined barn on the Willow Knoll. The stone is one coursed
// texture in vertex colours (the winery's warm limestone, the ruin's grey), the ranch house takes the city's house
// facade (and so its windows lit at night), and the rest is the valley's own atlas of painted boards, windows and bulbs,
// which the signs' emissive lights after dark, as the county's places' atlas is. The yards' and drives' dirt is
// farms.ts's, the windpump's too.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../../core/rng';
import type { ValleyFarms } from '../../world/country/valley';
import { hashInts, rectCX, rectCZ, type Rect } from '../../world/layout';
import { Atlas, boxC, face, pitched, type V } from '../city/attractions';
import { prism } from '../city/rooftops';
import { GeoBuilder, scaleRgb, type RGB } from '../geo';
import { FACADE_CELL, FACADE_COLS, FACADE_ROWS } from '../textures/facade';
import { canvas, glowTexture, toTexture } from '../textures/misc';
import type { WindUniforms } from '../props';
import { barn, beam, mailbox, sign, WOOD } from './farms';
import type { CountryView } from './index';
import { Vines } from './vines';

const STONE: RGB = [0.86, 0.78, 0.64];
const MOSS: RGB = [0.78, 0.74, 0.66];
const TILE: RGB = [0.36, 0.16, 0.1];
const OAK: RGB = [0.5, 0.34, 0.2];
const IRON: RGB = [0.2, 0.2, 0.22];
const STRAW: RGB = [0.72, 0.55, 0.25];
const BULB: RGB = [1, 0.93, 0.7];

/** The pieces of one place: vertex-coloured geometry and geometry painted on the atlas's bands. */
interface Pieces {
  plain: GeoBuilder;
  painted: GeoBuilder;
}

const pieces = (): Pieces => ({ plain: new GeoBuilder(true), painted: new GeoBuilder(true) });

/** Coursed limestone blocks in tan and grey, mortar between, 4 m a tile (a block about 0.5 by 0.3 m). */
function stoneTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const rng = new Rng(4410);
  ctx.fillStyle = '#8f8a7c';
  ctx.fillRect(0, 0, S, S);
  const rowH = S / 13;
  for (let r = 0; r < 13; r++) {
    let x = -rng.range(0, 30);
    while (x < S) {
      const w = rng.range(22, 40);
      const l = rng.int(176, 214);
      ctx.fillStyle = `rgb(${l},${Math.round(l * 0.94)},${Math.round(l * 0.82)})`;
      ctx.fillRect(x + 1.5, r * rowH + 1.5, w - 3, rowH - 3);
      x += w;
    }
  }
  return toTexture(c);
}

/** The ranch's gate board: LAZY and a Q lying on its side, the brand, burnt in pale letters on dark planks. */
function gateBoard(atlas: Atlas): [number, number] {
  const H = 256;
  return atlas.band(H, (ctx) => {
    ctx.fillStyle = '#4a2e1a';
    ctx.fillRect(0, 0, 1024, H);
    ctx.strokeStyle = 'rgba(20,10,4,0.45)';
    ctx.lineWidth = 3;
    for (let y = 40; y < H; y += 44) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1024, y);
      ctx.stroke();
    }
    ctx.fillStyle = '#f0dcb0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 190px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('LAZY', 380, 136);
    ctx.save();
    ctx.translate(800, 128);
    ctx.rotate(Math.PI / 2);
    ctx.font = '700 230px Anton, Impact, "Arial Black", sans-serif';
    ctx.fillText('Q', 0, 8);
    ctx.restore();
  });
}

/** An arched window (its glass lit after dark) in a stone frame, and an arched double door, on bands of their own. */
function openings(atlas: Atlas): { window: [number, number]; door: [number, number] } {
  const window = atlas.band(192, (ctx) => {
    const glow = ctx.canvas !== atlas.canvas;
    const arch = (x: number, y: number, w: number, h: number) => {
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + w / 2);
      ctx.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
    };
    ctx.fillStyle = glow ? '#000' : '#cfc6b0';
    ctx.fillRect(0, 0, 1024, 192);
    if (!glow) {
      ctx.fillStyle = '#6f6a5c';
      arch(300, 6, 424, 186);
      ctx.fill();
    }
    const g = ctx.createLinearGradient(0, 0, 0, 192);
    g.addColorStop(0, glow ? '#8a6420' : '#3d4a52');
    g.addColorStop(1, glow ? '#c98a2e' : '#2b343a');
    ctx.fillStyle = g;
    arch(330, 20, 364, 172);
    ctx.fill();
    if (glow) return;
    ctx.fillStyle = '#e8e0cc';
    ctx.fillRect(506, 20, 12, 172);
    ctx.fillRect(330, 108, 364, 10);
  }, true);
  const door = atlas.band(256, (ctx) => {
    const glow = ctx.canvas !== atlas.canvas;
    ctx.fillStyle = glow ? '#000' : '#cfc6b0';
    ctx.fillRect(0, 0, 1024, 256);
    ctx.beginPath();
    ctx.moveTo(220, 256);
    ctx.lineTo(220, 130);
    ctx.arc(512, 130, 292, Math.PI, 0);
    ctx.lineTo(804, 256);
    ctx.closePath();
    ctx.fillStyle = glow ? '#3a2410' : '#4a2f1c';
    ctx.fill();
    if (glow) return;
    ctx.strokeStyle = '#2a1a0e';
    ctx.lineWidth = 6;
    for (let x = 290; x < 800; x += 56) {
      ctx.beginPath();
      ctx.moveTo(x, 120);
      ctx.lineTo(x, 256);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(512, 0);
    ctx.lineTo(512, 256);
    ctx.stroke();
    ctx.fillStyle = '#2a2a2c';
    ctx.fillRect(220, 160, 584, 10);
    ctx.fillRect(220, 214, 584, 10);
  }, true);
  return { window, door };
}

/** A barrel lying along z (its middle at (x, y, z)), `len` long, `r` round at its belly, bound with iron hoops. */
function barrelLying(g: GeoBuilder, x: number, y: number, z: number, r: number, len: number): void {
  const n = 10;
  const ring = (zz: number, rr: number, k: number): V => [x + Math.cos((k / n) * Math.PI * 2) * rr, y + Math.sin((k / n) * Math.PI * 2) * rr, zz];
  const rings = [[z - len / 2, r * 0.86], [z - len / 4, r * 0.97], [z, r], [z + len / 4, r * 0.97], [z + len / 2, r * 0.86]] as const;
  for (let s = 0; s + 1 < rings.length; s++) {
    const [z0, r0] = rings[s]!;
    const [z1, r1] = rings[s + 1]!;
    for (let k = 0; k < n; k++) {
      const a = (((k + 0.5) / n) * Math.PI * 2);
      face(g, ring(z0, r0, k), ring(z1, r1, k), ring(z1, r1, k + 1), ring(z0, r0, k + 1), [Math.cos(a), Math.sin(a), 0], OAK);
    }
  }
  for (const [zz, rr] of [[z - len * 0.36, r * 0.9], [z + len * 0.36, r * 0.9]] as const) {
    for (let k = 0; k < n; k++) {
      const a = (((k + 0.5) / n) * Math.PI * 2);
      face(g, ring(zz - 0.03, rr * 1.03, k), ring(zz + 0.03, rr * 1.03, k), ring(zz + 0.03, rr * 1.03, k + 1), ring(zz - 0.03, rr * 1.03, k + 1), [Math.cos(a), Math.sin(a), 0], IRON);
    }
  }
  for (const [zz, s] of [[z - len / 2, -1], [z + len / 2, 1]] as const) {
    const c: V = [x, y, zz];
    for (let k = 0; k < n; k++) g.tri(...c, ...ring(zz, r * 0.86, k + (s > 0 ? 1 : 0)), ...ring(zz, r * 0.86, k + (s > 0 ? 0 : 1)), [0.5, 0.5, 1, 0, 0, 1], scaleRgb(OAK, 1.15));
  }
}

/** A round bale on its side, its axis along (sin yaw, cos yaw): a drum of straw in twine bands, its faces paler. */
function roundBale(g: GeoBuilder, x: number, z: number, yaw: number, r: number, len: number): void {
  const n = 14;
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const at = (t: number, k: number, rr: number): V => {
    const a = (k / n) * Math.PI * 2;
    const lx = Math.cos(a) * rr;
    return [x + lx * c + s * t, r + Math.sin(a) * rr, z - lx * s + c * t];
  };
  for (let k = 0; k < n; k++) {
    const a = ((k + 0.5) / n) * Math.PI * 2;
    const out: V = [Math.cos(a) * c, Math.sin(a), -Math.cos(a) * s];
    const band = (t0: number, t1: number, color: RGB) => face(g, at(t0, k, r), at(t1, k, r), at(t1, k + 1, r), at(t0, k + 1, r), out, color);
    band(-len / 2, -len * 0.18, STRAW);
    band(-len * 0.18, -len * 0.1, scaleRgb(STRAW, 0.72));
    band(-len * 0.1, len * 0.1, scaleRgb(STRAW, 1.04));
    band(len * 0.1, len * 0.18, scaleRgb(STRAW, 0.72));
    band(len * 0.18, len / 2, STRAW);
  }
  for (const [t, d] of [[-len / 2, -1], [len / 2, 1]] as const) {
    const mid: V = [x + s * t, r, z + c * t];
    for (let k = 0; k < n; k++) g.tri(...mid, ...at(t, k + (d > 0 ? 1 : 0), r), ...at(t, k + (d > 0 ? 0 : 1), r), [0.5, 0.5, 1, 0, 0, 1], scaleRgb(STRAW, 1.14));
  }
}

/** A hanging string of bulbs from `a` to `b` sagging `sag` m: the bulbs' places, each an octahedron on the plain's lit band, and a thin wire between. */
function bulbString(p: Pieces, lit: [number, number], a: V, b: V, sag: number, n: number, out: V[]): void {
  const mid = (lit[0] + lit[1]) / 2;
  const at = (t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
  for (let k = 0; k <= n; k++) {
    const q = at(k / n);
    if (k > 0) beam(p.plain, at((k - 1) / n), q, 0.018, IRON);
    if (k === 0 || k === n) continue;
    const r = 0.075;
    const top: V = [q[0], q[1] + r * 1.2, q[2]];
    const bottom: V = [q[0], q[1] - r * 1.4, q[2]];
    const ring: V[] = [[q[0] + r, q[1], q[2]], [q[0], q[1], q[2] + r], [q[0] - r, q[1], q[2]], [q[0], q[1], q[2] - r]];
    for (let i = 0; i < 4; i++) {
      const u = ring[i]!;
      const w = ring[(i + 1) % 4]!;
      p.painted.tri(...top, ...u, ...w, [0.5, mid, 0.5, mid, 0.5, mid], BULB);
      p.painted.tri(...bottom, ...w, ...u, [0.5, mid, 0.5, mid, 0.5, mid], BULB);
    }
    out.push(q);
  }
}

export class ValleyView {
  private readonly vines: Vines;
  /** Materials the headlights light (renderer.ts): the farms' atlas, whose decks, posts and boards stand within the pool's reach of a car. */
  readonly lit: THREE.MeshStandardMaterial[] = [];
  private readonly halos: THREE.Points;
  private readonly haloMat: THREE.PointsMaterial;

  constructor(view: CountryView, wind: WindUniforms) {
    const layout = view.world.layout;
    const v = layout.country.valley;
    this.vines = new Vines(view, v.vineyard, wind);
    const atlas = new Atlas(1024);
    const blank = atlas.band(8, (ctx) => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 1024, 8);
    });
    const white = (blank[0] + blank[1]) / 2;
    const lit = atlas.band(16, (ctx) => {
      ctx.fillStyle = ctx.canvas === atlas.canvas ? '#fff4d0' : '#ffd070';
      ctx.fillRect(0, 0, 1024, 16);
    }, true);
    const { window: windowBand, door: doorBand } = openings(atlas);
    // Each place a piece of its own (the winery's stone, the ruin's stone, the vineyard's and the ranch's wood, tile and
    // boards), so a mesh's bounds hug what it draws and the cull hides it from far away.
    const wineryStone = new GeoBuilder(true);
    const ruinStone = new GeoBuilder(true);
    const vineyard = pieces();
    const ranch = pieces();
    const bulbs: V[] = [];
    this.winery(v, wineryStone, vineyard, windowBand, doorBand, lit, atlas, bulbs);
    this.ruin(v, ruinStone);
    this.ranch(v, view, ranch, atlas);
    // The stone, one coursed texture in vertex colours.
    const stoneMat = new THREE.MeshStandardMaterial({ map: stoneTexture(), vertexColors: true, roughness: 0.92 });
    stoneMat.name = 'valley-stone';
    view.add(wineryStone.build(), stoneMat, { shadow: true, split: false, name: 'winery-stone' });
    view.add(ruinStone.build(), stoneMat, { shadow: true, split: false, name: 'ruin-stone' });
    // Everything else on the atlas: wood, tile, painted boards and the lit bands.
    const mat = new THREE.MeshStandardMaterial({
      map: toTexture(atlas.canvas, true, false),
      emissiveMap: toTexture(atlas.glowCanvas, true, false),
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.4,
      vertexColors: true,
      roughness: 0.8,
    });
    mat.name = 'valley-farms';
    this.lit.push(mat);
    // Lit up after dark with the city's signs (CityView.update).
    view.city.materials.signs.push(mat);
    for (const [name, p] of [['sunset-vineyard', vineyard], ['lazy-q-ranch', ranch]] as const) {
      const plain = p.plain.build();
      const uv = plain.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, white);
      const geo = mergeGeometries([plain, p.painted.build()], false)!;
      plain.dispose();
      view.add(geo, mat, { shadow: true, split: false, name });
    }
    // A glow round every bulb after dark.
    const pos = new Float32Array(bulbs.length * 3);
    bulbs.forEach((b, i) => pos.set(b, i * 3));
    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.haloMat = new THREE.PointsMaterial({ map: glowTexture(), color: 0xffc766, size: 0.85, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    this.halos = new THREE.Points(haloGeo, this.haloMat);
    this.halos.name = 'winery-string-lights';
    this.halos.visible = false;
    view.group.add(this.halos);
  }

  /** The winery's hall, its roof and porch, the string lights and the barrels, the sign at the drive's mouth. */
  private winery(v: ValleyFarms, stone: GeoBuilder, p: Pieces, windowBand: [number, number], doorBand: [number, number], lit: [number, number], atlas: Atlas, bulbs: V[]): void {
    const w = v.vineyard.winery;
    const { hall, porch } = w;
    const y = w.y;
    const top = y + w.eaves;
    const uv = { kind: 'world', scale: 4 } as const;
    // The hall: coursed limestone on a darker plinth.
    stone.box(hall.minX - 0.1, y - 0.8, hall.minZ - 0.1, hall.maxX + 0.1, y + 0.45, hall.maxZ + 0.1, { uv, color: scaleRgb(STONE, 0.78), top: false });
    stone.box(hall.minX, y + 0.4, hall.minZ, hall.maxX, top, hall.maxZ, { uv, color: STONE, top: false });
    // Chimney on the north slope.
    stone.box(hall.minX + 4, top, hall.minZ + 0.6, hall.minX + 5.2, top + 3.6, hall.minZ + 1.8, { uv, color: scaleRgb(STONE, 0.9) });
    const ridge = top + 2.8;
    pitched(p.plain, hall, top, ridge, true, 0.6, TILE, null);
    // The gable ends in the same stone: a triangle under the ridge at either end, on the stone's texture.
    for (const [x, s] of [[hall.minX, -1], [hall.maxX, 1]] as const) {
      const a: V = [x, top, hall.minZ];
      const b: V = [x, top, hall.maxZ];
      const c: V = [x, ridge - 0.05, rectCZ(hall)];
      const uv = (q: V) => [q[2] / 4, q[1] / 4];
      if (s > 0) stone.tri(...b, ...a, ...c, [...uv(b), ...uv(a), ...uv(c)], STONE);
      else stone.tri(...a, ...b, ...c, [...uv(a), ...uv(b), ...uv(c)], STONE);
    }
    // Openings, set just off the walls: windows along both long walls, the back wall's pair, and the east front's doors and windows.
    const open = (band: [number, number], wm: number, hm: number, cx: number, cz: number, y0: number, toward: 'N' | 'S' | 'E' | 'W') => {
      const o = toward === 'E' ? [1, 0] : toward === 'W' ? [-1, 0] : toward === 'S' ? [0, 1] : [0, -1];
      // Left to right as seen from outside.
      const dir = toward === 'E' ? [0, -1] : toward === 'W' ? [0, 1] : toward === 'S' ? [1, 0] : [-1, 0];
      const e = 0.03;
      const P = (s: number, yy: number): V => [cx + dir[0]! * s * (wm / 2) + o[0]! * e, yy, cz + dir[1]! * s * (wm / 2) + o[1]! * e];
      face(p.painted, P(-1, y0), P(1, y0), P(1, y0 + hm), P(-1, y0 + hm), [o[0]!, 0, o[1]!], [1, 1, 1], [0, band[0], 1, band[0], 1, band[1], 0, band[1]]);
    };
    const baseY = y + 0.45;
    for (const x of [-2024.5, -2021, -2017.5]) open(windowBand, 1.5, 2.1, x, hall.minZ, baseY + 1.3, 'N');
    for (const x of [-2028.5, -2025, -2021.5, -2018]) open(windowBand, 1.5, 2.1, x, hall.maxZ, baseY + 1.3, 'S');
    for (const z of [125, 129]) open(windowBand, 1.5, 2.1, hall.minX, z, baseY + 1.3, 'W');
    const midZ = rectCZ(hall);
    open(doorBand, 3.4, 3.4, hall.maxX, midZ, baseY, 'E');
    for (const dz of [-3.4, 3.4]) open(windowBand, 1.5, 2.1, hall.maxX, midZ + dz, baseY + 1.3, 'E');
    // The porch: a plank deck a step up, posts along its front, a lean-to roof of tile on beams back to the wall.
    const deck = y + 0.3;
    boxC(p.plain, porch.minX, y - 0.2, porch.minZ, porch.maxX, deck, porch.maxZ, scaleRgb(WOOD, 1.15));
    const front = porch.maxX - 0.25;
    const lowY = top - 1.3;
    const posts = [porch.minZ + 0.4, 122, 132, porch.maxZ - 0.4];
    for (const z of posts) boxC(p.plain, front - 0.1, deck, z - 0.1, front + 0.1, lowY, z + 0.1, WOOD);
    boxC(p.plain, front - 0.12, lowY - 0.22, porch.minZ, front + 0.12, lowY, porch.maxZ, WOOD);
    for (const z of [porch.minZ + 0.3, 123.5, 127, 130.5, porch.maxZ - 0.3]) boxC(p.plain, hall.maxX, top - 0.3, z - 0.07, front + 0.4, top - 0.12, z + 0.07, WOOD);
    face(p.plain, [hall.maxX, top - 0.1, porch.minZ - 0.3], [front + 0.5, lowY - 0.05, porch.minZ - 0.3], [front + 0.5, lowY - 0.05, porch.maxZ + 0.3], [hall.maxX, top - 0.1, porch.maxZ + 0.3], [0.5, 1, 0], TILE);
    // Tables, a barrel each with two stools, under the roof.
    for (const z of [121.4, 132.6]) {
      prism(p.plain, front - 2.6, z, 0.46, 0.46, deck, deck + 0.95, 10, OAK, true);
      prism(p.plain, front - 2.6, z, 0.49, 0.49, deck + 0.25, deck + 0.31, 10, IRON, false);
      prism(p.plain, front - 2.6, z, 0.49, 0.49, deck + 0.7, deck + 0.76, 10, IRON, false);
      for (const dz of [-0.95, 0.95]) prism(p.plain, front - 2.6, z + dz, 0.25, 0.25, deck, deck + 0.55, 8, scaleRgb(WOOD, 1.2), true);
    }
    // The string lights: along the porch's front beam between its posts, out to the two poles and across between them.
    const [pa, pb] = w.poles;
    for (const [px, pz] of w.poles) boxC(p.plain, px - 0.07, y, pz - 0.07, px + 0.07, y + 3.9, pz + 0.07, WOOD);
    const rail = (z: number): V => [front, lowY - 0.05, z];
    const poleTop = (pole: readonly [number, number]): V => [pole[0], y + 3.8, pole[1]];
    for (let k = 0; k + 1 < posts.length; k++) bulbString(p, lit, rail(posts[k]!), rail(posts[k + 1]!), 0.35, k === 1 ? 14 : 6, bulbs);
    bulbString(p, lit, rail(posts[0]!), poleTop(pa!), 0.8, 9, bulbs);
    bulbString(p, lit, rail(posts[posts.length - 1]!), poleTop(pb!), 0.8, 9, bulbs);
    bulbString(p, lit, poleTop(pa!), poleTop(pb!), 1.1, 16, bulbs);
    bulbString(p, lit, poleTop(pa!), rail(127), 1.4, 11, bulbs);
    bulbString(p, lit, poleTop(pb!), rail(127), 1.4, 11, bulbs);
    // The barrel stack against the north wall: four, three, two, lying with their ends to the wall.
    const b = w.barrels;
    const bx = (b.minX + b.maxX) / 2;
    const bz = (b.minZ + b.maxZ) / 2;
    for (const [row, count] of [[0, 4], [1, 3], [2, 2]] as const) {
      for (let k = 0; k < count; k++) barrelLying(p.plain, bx - ((count - 1) * 1.0) / 2 + k * 1.0, y + 0.5 + row * 0.86, bz, 0.5, 1.05);
    }
    // Two barrels standing at the yard's edge, a crate of bottles' worth of crates stacked beside them.
    for (const [x, z] of [[-2034, 142], [-2032.6, 140.6]] as const) {
      prism(p.plain, x, z, 0.46, 0.5, y - 0.05, y + 0.45, 10, OAK, false);
      prism(p.plain, x, z, 0.5, 0.46, y + 0.45, y + 0.95, 10, OAK, true);
    }
    // The sign at the drive's mouth, and the mailbox by the road.
    const board = atlas.board([['SUNSET VINEYARD', 108, '#f4e6c8'], ['TASTINGS 11 TO SUNSET', 52, '#e8b04a'], ['PLEASE SPIT RESPONSIBLY.', 44, '#f4e6c8']], '#4a1d2c', 220);
    sign(p.plain, p.painted, w, board);
    mailbox(p.plain, w.mailbox.x, w.mailbox.z);
  }

  /** The ruin: the walls' stumps in broken columns, the gable end's jagged top, a rafter or two fallen, rubble at the foot. */
  private ruin(v: ValleyFarms, stone: GeoBuilder): void {
    const { walls, y } = v.ruin;
    const rng = new Rng(4411);
    const uv = { kind: 'world', scale: 4 } as const;
    for (const wall of walls) {
      const r = wall.rect;
      const alongX = r.maxX - r.minX > r.maxZ - r.minZ;
      const len = alongX ? r.maxX - r.minX : r.maxZ - r.minZ;
      const tall = wall.h > 5;
      for (let a = 0; a < len - 0.01;) {
        const w = Math.min(len - a, rng.range(0.9, 1.7));
        const t = (a + w / 2) / len;
        // The gable end rises to a peak over its middle; the stumps are lower and ragged.
        const h = tall ? wall.h * (0.28 + 0.72 * (1 - Math.abs(2 * t - 1) ** 1.2)) * rng.range(0.88, 1) : wall.h * rng.range(0.55, 1);
        const col = scaleRgb(MOSS, rng.range(0.82, 1.06));
        if (alongX) stone.box(r.minX + a, y - 0.5, r.minZ, r.minX + a + w, y + h, r.maxZ, { uv, color: col });
        else stone.box(r.minX, y - 0.5, r.minZ + a, r.maxX, y + h, r.minZ + a + w, { uv, color: col });
        a += w;
      }
    }
    const r = v.ruin.rect;
    // Two rafters of the roof still leaning from the standing gable end to the ground inside, and a beam fallen across the floor.
    const wood: RGB = [0.34, 0.25, 0.18];
    for (const z of [r.minZ + 2.4, r.maxZ - 2.4]) beam(stone, [r.minX + 0.4, y + 5.6, z], [r.minX + 4.6, y + 0.3, z], 0.2, wood);
    beam(stone, [r.minX + 3, y + 0.3, r.minZ + 1], [r.maxX - 3.5, y + 0.6, r.maxZ - 1.5], 0.24, wood);
    for (let k = 0; k < 16; k++) {
      const x = rng.range(r.minX - 2.5, r.maxX + 2.5);
      const z = rng.range(r.minZ - 2.5, r.maxZ + 2.5);
      const s = rng.range(0.25, 0.7);
      if (walls.some((q) => x > q.rect.minX - 0.2 && x < q.rect.maxX + 0.2 && z > q.rect.minZ - 0.2 && z < q.rect.maxZ + 0.2)) continue;
      stone.box(x - s / 2, y - 0.2, z - s / 2, x + s / 2, y + s * 0.7, z + s / 2, { uv, color: scaleRgb(MOSS, rng.range(0.7, 0.95)) });
    }
  }

  /** The ranch's house, barn roof, gate, bales and the paddocks' shelters. */
  private ranch(v: ValleyFarms, view: CountryView, p: Pieces, atlas: Atlas): void {
    const layout = view.world.layout;
    const r = v.ranch;
    const rng = new Rng(4412);
    // The house on the city's house facade: cream walls, a low slate roof, a deep porch along its south front on posts, a chimney.
    const house = layout.buildings.find((b) => b.id === r.house)!;
    const hr = r.houseRect;
    const cell = FACADE_CELL.house;
    const facade = new GeoBuilder(true, true);
    const h = hashInts(house.id, 0x7c1);
    facade.seed = (hashInts(house.id, 0x5eed) % 1000) / 1000;
    const wallH = 3.4;
    facade.box(hr.minX, 0, hr.minZ, hr.maxX, wallH, hr.maxZ, {
      uv: { kind: 'facade', w: cell.w * FACADE_COLS, h: cell.h * FACADE_ROWS, offU: (h % FACADE_COLS) / FACADE_COLS, offV: ((h >>> 8) % FACADE_ROWS) / FACADE_ROWS, baseY: 0 },
      color: [0.98, 0.94, 0.84],
      top: false,
    });
    view.add(facade.build(), view.city.materials.facades.get('house')!, { shadow: true, split: false, name: 'lazy-q-house' });
    pitched(p.plain, hr, wallH, wallH + 2.2, true, 0.7, [0.17, 0.2, 0.2], [0.98, 0.94, 0.84]);
    boxC(p.plain, hr.minX + 3, wallH, hr.minZ + 0.8, hr.minX + 4.2, wallH + 3.4, hr.minZ + 2, scaleRgb(STONE, 0.78));
    const porch = hr.maxZ + 3;
    boxC(p.plain, hr.minX, 0, hr.maxZ, hr.maxX, 0.3, porch, scaleRgb(WOOD, 1.1));
    for (let x = hr.minX + 0.4; x < hr.maxX; x += 3.55) boxC(p.plain, x - 0.1, 0.3, porch - 0.3 - 0.1, x + 0.1, wallH - 0.2, porch - 0.3 + 0.1, [0.95, 0.93, 0.88]);
    face(p.plain, [hr.minX - 0.3, wallH - 0.2, hr.maxZ], [hr.maxX + 0.3, wallH - 0.2, hr.maxZ], [hr.maxX + 0.3, wallH - 0.7, porch + 0.2], [hr.minX - 0.3, wallH - 0.7, porch + 0.2], [0, 1, 1], [0.17, 0.2, 0.2]);
    // The barn's gambrel roof (its walls are a garage the city draws) in blue-grey tin.
    const gar = layout.garages.find((q) => q.poi === 'ranch_barn')!;
    barn(p.plain, r, gar.height, gar.color, 0x383d42);
    // The gate: two timber posts over the drive's mouth under a lintel, the brand's board on it facing the road and the ranch.
    const board = gateBoard(atlas);
    const gx = r.gate.x;
    const gz = r.gate.z;
    for (const dz of [-3.6, 3.6]) boxC(p.plain, gx - 0.22, 0, gz + dz - 0.22, gx + 0.22, 4.4, gz + dz + 0.22, WOOD);
    boxC(p.plain, gx - 0.2, 4.0, gz - 3.9, gx + 0.2, 4.4, gz + 3.9, scaleRgb(WOOD, 0.9));
    for (const side of [-1, 1]) {
      const o = gx + side * 0.24;
      const Q = (s: number, yy: number): V => [o, yy, gz + s * 3.3 * -side];
      face(p.painted, Q(-1, 2.9), Q(1, 2.9), Q(1, 4.0), Q(-1, 4.0), [side, 0, 0], [1, 1, 1], [0, board[0], 1, board[0], 1, board[1], 0, board[1]]);
    }
    mailbox(p.plain, r.mailbox.x, r.mailbox.z);
    // Round bales, each its own way, and the paddocks' shelters: three posts, a tin roof sloping to the back, along the south fence.
    for (const b of r.bales) roundBale(p.plain, b.x, b.z, rng.range(0, Math.PI), 0.75, 1.25);
    for (const [k, pad] of r.paddocks.slice(0, 2).entries()) shelter(p.plain, pad, k);
  }

  /** Hides the vineyard's chunks past `far` m from (x, z). */
  cull(x: number, z: number, far: number): void {
    this.vines.cull(x, z, far);
  }

  /** Each frame: the string lights' glow, as night falls. */
  update(night: number): void {
    this.haloMat.opacity = night * 0.85;
    this.halos.visible = night > 0.02;
  }
}

/** A run-in shelter on the south side of a paddock: a back wall and two sides of weathered boards under a tin roof sloping to the back. */
function shelter(g: GeoBuilder, pad: Rect, k: number): void {
  const cx = rectCX(pad) + (k === 0 ? 8 : -8);
  const z1 = pad.maxZ - 1.2;
  const z0 = z1 - 3.6;
  const x0 = cx - 3.2;
  const x1 = cx + 3.2;
  const board: RGB = [0.45, 0.33, 0.22];
  boxC(g, x0, 0, z1 - 0.12, x1, 2.3, z1, board);
  for (const x of [x0, x1 - 0.12]) boxC(g, x, 0, z0, x + 0.12, 2.5, z1, board);
  face(g, [x0 - 0.3, 2.7, z0 - 0.4], [x1 + 0.3, 2.7, z0 - 0.4], [x1 + 0.3, 2.15, z1 + 0.2], [x0 - 0.3, 2.15, z1 + 0.2], [0, 1, 0.2], [0.55, 0.57, 0.58]);
}
