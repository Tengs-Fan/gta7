// The city's large set pieces drawn as city geometry: Port Basin's three ship-to-shore cranes and the Azura Bowl. One
// vertex-coloured geometry over a small atlas (a white band under the paint, the lamps' bands that light up after dark
// through the signs' night glow, and the stadium's painted boards), split into the city's cells like the other shadow
// casters, so each place costs one draw where it is seen. Drawn only: the cranes' legs and the stadium's box are the
// world's colliders (staticWorld.ts, layout.ts buildStadium), and everything drawn keeps to them or stands above reach.

import * as THREE from 'three';
import type { Prop, Rect } from '../../world/layout';
import { GeoBuilder, type RGB } from '../geo';
import { block, face, strut, texel, type V } from '../setPieceModels';
import { Atlas } from './attractions';
import type { CityView } from './index';

/** Vertex colours are linear: the cranes' yellow is the old crane's #e0a21a, the dark steel and glass near black. */
const YELLOW: RGB = [0.75, 0.36, 0.012];
const DARK: RGB = [0.045, 0.048, 0.055];
const WHITE: RGB = [0.8, 0.8, 0.78];
const GLASS: RGB = [0.012, 0.016, 0.022];
const CONCRETE: RGB = [0.42, 0.4, 0.37];

/** The atlas bands every set piece samples: the plain white under the vertex colours, a warm lamp and a red beacon. */
interface Bands {
  plain: number[];
  lamp: number[];
  beacon: number[];
  /** The stadium's concourse glazing: dark blue glass by day, a warm glow from the concourse after dark. */
  concourse: number[];
}

/** A band of one colour on the atlas, `glow` its colour in the glow map (the emissive the signs' night lighting scales). */
function solid(atlas: Atlas, color: string, glow: string | null): number[] {
  const v = atlas.band(8, (ctx) => {
    ctx.fillStyle = ctx.canvas.width < 1024 ? (glow ?? '#000') : color;
    ctx.fillRect(0, 0, 1024, 8);
  }, glow !== null);
  return texel(0.5, (v[0] + v[1]) / 2);
}

// ---------------------------------------------------------------------------
// Port Basin's cranes

/**
 * A ship-to-shore crane at its prop (its legs where the colliders are: x +-6, z +-5, 30 m tall; the cranes stand square
 * to the wharf, rot 0, as their colliders do), its boom out over the basin to +z. The portal: four box legs on dark
 * shoes, portal beams round their heads and K-braces in the two frames along the wharf (traffic runs along x under it,
 * so the frames across it stay open to 22 m). On it the two box girders of the boom, 54 m from the backreach to the
 * tip, with the machinery house on the backreach, the apex frame rising to 47 m with its forestays out to the boom and
 * backstays to the backreach (the silhouette a port crane is known by), the trolley with the driver's cab under it, the
 * hoist ropes and the spreader. Floodlights under the boom and the portal, red beacons on the apex and the boom's tip.
 * About 1,050 triangles a crane.
 */
function crane(g: GeoBuilder, p: Prop, b: Bands): void {
  const o = (x: number, y: number, z: number): V => [p.x + x, p.y + y, p.z + z];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: RGB, uv = b.plain, skip = '') => block(g, p.x + x0, p.y + y0, p.z + z0, p.x + x1, p.y + y1, p.z + z1, c, uv, skip);
  const bar = (a: V, e: V, w: number, c: RGB = YELLOW) => strut(g, o(...a), o(...e), w, c, b.plain);
  // The portal: legs, shoes with their wheels' bogie, the beams round the legs' heads.
  for (const [lx, lz] of [[-6, -5], [6, -5], [-6, 5], [6, 5]] as const) {
    box(lx - 0.5, 1.1, lz - 0.5, lx + 0.5, 28, lz + 0.5, YELLOW, b.plain, 'y');
    box(lx - 0.6, 0, lz - 0.6, lx + 0.6, 1.1, lz + 0.6, DARK);
  }
  for (const z of [-5, 5]) {
    box(-6.6, 26.4, z - 0.6, 6.6, 28.4, z + 0.6, YELLOW);
    // K-braces in the frames along the wharf: from mid-leg up to the beam's middle.
    for (const sx of [-1, 1]) bar([sx * 6, 12, z], [0, 26.4, z], 0.45);
    box(-5.6, 11.6, z - 0.3, 5.6, 12.4, z + 0.3, YELLOW);
  }
  for (const x of [-6, 6]) {
    box(x - 0.6, 26.4, -5.6, x + 0.6, 28.4, 5.6, YELLOW);
    // Knee braces under the portal beam, over the lanes' clearance.
    for (const sz of [-1, 1]) bar([x, 22, sz * 5], [x, 26.4, sz * 2.2], 0.4);
  }
  // The boom: two box girders from the backreach (z -16) to the tip (z 38), ties across them, a handrail on each.
  const zb = -16;
  const zt = 38;
  for (const sx of [-1, 1]) {
    box(sx * 1.8 - 0.5, 28.4, zb, sx * 1.8 + 0.5, 30.6, zt, YELLOW);
    bar([sx * 2.45, 31.6, zb], [sx * 2.45, 31.6, zt], 0.06, WHITE);
    for (let z = zb + 3; z < zt; z += 6) bar([sx * 2.45, 30.6, z], [sx * 2.45, 31.6, z], 0.06, WHITE);
  }
  for (let z = zb + 1; z <= zt - 1; z += 6) box(-1.3, 30, z - 0.25, 1.3, 30.5, z + 0.25, YELLOW, b.plain, 'xX');
  box(-2.4, 28.2, zt - 0.4, 2.4, 30.8, zt, YELLOW);
  // The machinery house on the backreach: white, a band of dark windows, a darker roof.
  box(-3, 30.6, zb + 0.5, 3, 34.6, zb + 9, WHITE, b.plain, 'y');
  box(-3.02, 32.4, zb + 1.5, 3.02, 33.4, zb + 8, GLASS, b.plain, 'yYzZ');
  box(-3.2, 34.6, zb + 0.3, 3.2, 35, zb + 9.2, [0.5, 0.52, 0.54]);
  // The apex: two raked posts each side from the portal up to a cross head 47 m up, braced across, and the stays.
  const apex: V = [0, 47, -1];
  for (const sx of [-1, 1]) {
    bar([sx * 4.2, 30.6, -5], [sx * 1.6, 46.4, -1], 0.75);
    bar([sx * 4.2, 30.6, 5], [sx * 1.6, 46.4, -1], 0.75);
    bar([sx * 1.6, 47.2, -1], [sx * 1.8, 30.6, 20], 0.22, DARK);
    bar([sx * 1.6, 47.2, -1], [sx * 1.8, 30.6, 35], 0.22, DARK);
    bar([sx * 1.6, 47.2, -1], [sx * 1.8, 30.6, -14], 0.28, DARK);
  }
  box(-2.4, 46.2, apex[2] - 0.7, 2.4, 47.6, apex[2] + 0.7, YELLOW);
  bar([-3, 38, -3], [3, 38, -3], 0.4);
  // The trolley on the girders, the driver's cab hung under it (its glass toward the tip), the ropes and the spreader.
  const zc = 14;
  box(-2.6, 30.6, zc - 2.2, 2.6, 32, zc + 2.2, DARK);
  box(-1.1, 25.4, zc - 1, 1.1, 28.2, zc + 1.2, WHITE);
  box(-1.12, 26.4, zc + 0.4, 1.12, 27.8, zc + 1.22, GLASS, b.plain, 'yYz');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar([sx * 1, 28.4, zc + sz * 1.6], [sx * 1, 15.4, zc + sz * 1.0], 0.06, DARK);
  box(-6.1, 14.6, zc - 1.2, 6.1, 15.4, zc + 1.2, YELLOW);
  // Floodlights: down the boom's girders and under the portal's beams; beacons on the apex and the boom's tip.
  for (let z = zb + 6; z < zt; z += 8) for (const sx of [-1, 1]) box(sx * 1.8 - 0.35, 28.25, z - 0.5, sx * 1.8 + 0.35, 28.4, z + 0.5, WHITE, b.lamp, 'Y');
  for (const z of [-5, 5]) for (const sx of [-1, 1]) box(sx * 3.4 - 0.4, 26.25, z - 0.3, sx * 3.4 + 0.4, 26.4, z + 0.3, WHITE, b.lamp, 'Y');
  box(-0.25, 47.6, apex[2] - 0.25, 0.25, 48.1, apex[2] + 0.25, [1, 0.25, 0.2], b.beacon, 'y');
  for (const sx of [-1, 1]) box(sx * 1.8 - 0.2, 30.6, zt - 0.6, sx * 1.8 + 0.2, 31.0, zt - 0.2, [1, 0.25, 0.2], b.beacon, 'y');
}

// ---------------------------------------------------------------------------
// The Azura Bowl

/** The stadium's bowl: its pitch, the stands' foot and rim (superellipse half-widths, m), and heights over the ground. */
const BOWL = {
  /** The box the sim makes solid (layout.ts buildStadium: 22 m); the pitch and the stands' foot sit on its top. */
  deck: 22,
  pitch: [33, 20] as const,
  foot: [36.5, 23.5] as const,
  rim: [48.6, 34.6] as const,
  /** The stands' rows and the rim's height over the deck, the canopy over the upper rows and its inner edge's reach. */
  rows: 12,
  rimY: 12,
  canopyY: 13.6,
  canopyIn: 0.8,
  /** Superellipse exponent: rounded corners, long straight sides. */
  n: 4.5,
  segments: 64,
} as const;

/** A point on a superellipse of half-widths (hx, hz) at parameter k of `n` round, about (cx, cz). */
function oval(cx: number, cz: number, hx: number, hz: number, k: number, segs: number): [number, number] {
  const t = (k / segs) * Math.PI * 2;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const e = 2 / BOWL.n;
  return [cx + hx * Math.sign(c) * Math.abs(c) ** e, cz + hz * Math.sign(s) * Math.abs(s) ** e];
}

/**
 * The Azura Bowl over the box the sim makes of it (`r`, 22 m): a podium clad as a stadium's concourse (a concrete base
 * with the ten gates and their boards, dark glazing behind white fins (lit warm from inside after dark), bands at the
 * concourse levels, a cornice carrying the name on the north and south fronts), and on its top the open bowl: the striped pitch with its markings, twelve
 * rows of stands rising 12 m to a rounded rim (teal and white seating blocks, grey aisles), the outer wall behind them
 * on columns, a canopy over the upper rows with its floodlight strip, and a floodlight mast at each corner of the
 * podium's roof. About 5,800 triangles.
 */
function stadium(g: GeoBuilder, atlas: Atlas, r: Rect, b: Bands): void {
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const top = BOWL.deck;
  const base = 0.15;
  const fin = 0.25;
  // The podium's four walls, each from its own corner along +u, its outward normal (nx, nz).
  const walls = [
    { x0: r.minX, z0: r.minZ, ux: 1, uz: 0, len: r.maxX - r.minX, nx: 0, nz: -1, front: true },
    { x0: r.maxX, z0: r.minZ, ux: 0, uz: 1, len: r.maxZ - r.minZ, nx: 1, nz: 0, front: false },
    { x0: r.maxX, z0: r.maxZ, ux: -1, uz: 0, len: r.maxX - r.minX, nx: 0, nz: 1, front: true },
    { x0: r.minX, z0: r.maxZ, ux: 0, uz: -1, len: r.maxZ - r.minZ, nx: -1, nz: 0, front: false },
  ];
  const name = atlas.board([['AZURA BOWL', 200, '#ff4fa3']], '#f3f1ec', 200);
  const gates = 'ABCDEFGHJK'.split('').map((l) => atlas.board([[`GATE ${l}`, 150, '#ffffff']], '#0b7f87', 200));
  let gate = 0;
  for (const w of walls) {
    const P = (u: number, y: number, out = 0): V => [w.x0 + w.ux * u + w.nx * out, y, w.z0 + w.uz * u + w.nz * out];
    const n: V = [w.nx, 0, w.nz];
    const wall = (u0: number, u1: number, y0: number, y1: number, c: RGB, out = 0, uv = b.plain) => face(g, P(u0, y0, out), P(u1, y0, out), P(u1, y1, out), P(u0, y1, out), n, c, uv);
    const slab = (u0: number, u1: number, y0: number, y1: number, d: number, c: RGB) => {
      wall(u0, u1, y0, y1, c, d);
      face(g, P(u0, y1, 0), P(u1, y1, 0), P(u1, y1, d), P(u0, y1, d), [0, 1, 0], c, b.plain);
      face(g, P(u0, y0, 0), P(u1, y0, 0), P(u1, y0, d), P(u0, y0, d), [0, -1, 0], c, b.plain);
      face(g, P(u0, y0, 0), P(u0, y1, 0), P(u0, y1, d), P(u0, y0, d), [-w.ux, 0, -w.uz], c, b.plain);
      face(g, P(u1, y0, 0), P(u1, y1, 0), P(u1, y1, d), P(u1, y0, d), [w.ux, 0, w.uz], c, b.plain);
    };
    // The base storey with its gates, the glazed concourse, the cornice.
    wall(0, w.len, base, 5, CONCRETE);
    wall(0, w.len, 5, top - 2.6, [1, 1, 1], 0, b.concourse);
    wall(0, w.len, top - 2.6, top + 0.6, WHITE);
    const count = Math.max(2, Math.round(w.len / 34));
    for (let k = 0; k < count; k++) {
      const u = (w.len * (k + 0.5)) / count;
      wall(u - 2.2, u + 2.2, base, 3.6, GLASS, 0.02);
      const gv = gates[gate % gates.length]!;
      // Seen from outside a wall's u runs right to left: the boards' u runs the other way.
      wall(u - 2.2, u + 2.2, 3.8, 4.7, [1, 1, 1], 0.03, [1, gv[0], 0, gv[0], 0, gv[1], 1, gv[1]]);
      gate++;
    }
    // The fins (clear of the name board on the fronts), and the bands at the concourse's levels.
    const nameW = Math.min(30, w.len * 0.36);
    for (let u = 1.5; u < w.len - 1; u += 3.2) {
      if (w.front && Math.abs(u - w.len / 2) < nameW / 2 + 0.4) continue;
      slab(u - 0.2, u + 0.2, 5, top - 2.6, fin, WHITE);
    }
    slab(0, w.len, 4.7, 5.3, 0.18, WHITE);
    slab(0, w.len, 11.2, 11.7, 0.18, WHITE);
    slab(0, w.len, top + 0.6, top + 0.9, 0.3, [0.8, 0.8, 0.78]);
    if (w.front) wall(w.len / 2 - nameW / 2, w.len / 2 + nameW / 2, top - 2.4, top + 0.4, [1, 1, 1], 0.02, [1, name[0], 0, name[0], 0, name[1], 1, name[1]]);
  }
  // The bowl. Rings round it: the pitch's edge, the stands' foot (a 1.2 m wall up from the apron), each row, the rim.
  const N = BOWL.segments;
  const lerp2 = (a: readonly [number, number], c: readonly [number, number], t: number): [number, number] => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
  const rowY = (i: number) => top + 1.2 + (BOWL.rimY - 1.2) * (i / BOWL.rows);
  const rowHalf = (i: number) => lerp2(BOWL.foot, BOWL.rim, i / BOWL.rows);
  const seat = (k: number, i: number): RGB => {
    const block6 = Math.floor((k / N) * 16);
    if (k % 4 === 0) return [0.3, 0.3, 0.29];
    if (i >= BOWL.rows - 3) return [0.62, 0.64, 0.66];
    return block6 % 2 === 0 ? [0.01, 0.24, 0.3] : [0.015, 0.17, 0.24];
  };
  const up: V = [0, 1, 0];
  for (let k = 0; k < N; k++) {
    const [ax, az] = oval(cx, cz, BOWL.foot[0], BOWL.foot[1], k, N);
    const [bx, bz] = oval(cx, cz, BOWL.foot[0], BOWL.foot[1], k + 1, N);
    const mid = oval(cx, cz, BOWL.foot[0], BOWL.foot[1], k + 0.5, N);
    const inward: V = [cx - mid[0], 0, cz - mid[1]];
    // The wall at the foot of the stands, facing the pitch.
    face(g, [ax, top, az], [bx, top, bz], [bx, top + 1.2, bz], [ax, top + 1.2, az], inward, [0.85, 0.85, 0.83], b.plain);
    for (let i = 0; i < BOWL.rows; i++) {
      const h0 = rowHalf(i);
      const h1 = rowHalf(i + 1);
      const [a0x, a0z] = oval(cx, cz, h0[0], h0[1], k, N);
      const [b0x, b0z] = oval(cx, cz, h0[0], h0[1], k + 1, N);
      const [a1x, a1z] = oval(cx, cz, h1[0], h1[1], k, N);
      const [b1x, b1z] = oval(cx, cz, h1[0], h1[1], k + 1, N);
      const y0 = rowY(i);
      const y1 = rowY(i + 1);
      // The tread out to the next row, then the riser up to it, in the block's colour.
      face(g, [a0x, y0, a0z], [b0x, y0, b0z], [b1x, y0, b1z], [a1x, y0, a1z], up, [0.62, 0.62, 0.6], b.plain);
      face(g, [a1x, y0, a1z], [b1x, y0, b1z], [b1x, y1, b1z], [a1x, y1, a1z], inward, seat(k, i), b.plain);
    }
    // The rim's top, the outer wall down to the podium's roof, and that roof out to the podium's edge.
    const [ra, rb] = [oval(cx, cz, BOWL.rim[0], BOWL.rim[1], k, N), oval(cx, cz, BOWL.rim[0], BOWL.rim[1], k + 1, N)];
    const out: V = [-inward[0], 0, -inward[2]];
    face(g, [ra[0], top + BOWL.rimY, ra[1]], [rb[0], top + BOWL.rimY, rb[1]], [rb[0], top + BOWL.rimY + 0.6, rb[1]], [ra[0], top + BOWL.rimY + 0.6, ra[1]], inward, WHITE, b.plain);
    face(g, [ra[0], top, ra[1]], [rb[0], top, rb[1]], [rb[0], top + BOWL.rimY + 0.6, rb[1]], [ra[0], top + BOWL.rimY + 0.6, ra[1]], out, k % 2 === 0 ? [0.035, 0.05, 0.07] : WHITE, b.plain);
    const edge = (q: readonly [number, number]): [number, number] => {
      const dx = q[0] - cx;
      const dz = q[1] - cz;
      const s = Math.min((r.maxX - cx) / Math.abs(dx || 1e-9), (r.maxZ - cz) / Math.abs(dz || 1e-9));
      return [cx + dx * s, cz + dz * s];
    };
    const [ea, eb] = [edge(ra), edge(rb)];
    face(g, [ra[0], top + 0.9, ra[1]], [rb[0], top + 0.9, rb[1]], [eb[0], top + 0.9, eb[1]], [ea[0], top + 0.9, ea[1]], up, [0.56, 0.56, 0.55], b.plain);
    // The canopy over the upper rows: white on top, grey under, its inner fascia with the floodlight strip under it.
    const [ia, ib] = [oval(cx, cz, BOWL.rim[0] * BOWL.canopyIn + 1, BOWL.rim[1] * BOWL.canopyIn + 1, k, N), oval(cx, cz, BOWL.rim[0] * BOWL.canopyIn + 1, BOWL.rim[1] * BOWL.canopyIn + 1, k + 1, N)];
    const yo = top + BOWL.canopyY;
    const yi = yo + 1.4;
    face(g, [ra[0], yo + 0.5, ra[1]], [rb[0], yo + 0.5, rb[1]], [ib[0], yi + 0.4, ib[1]], [ia[0], yi + 0.4, ia[1]], up, [0.94, 0.94, 0.93], b.plain);
    face(g, [ra[0], yo, ra[1]], [rb[0], yo, rb[1]], [ib[0], yi, ib[1]], [ia[0], yi, ia[1]], [0, -1, 0], [0.45, 0.46, 0.48], b.plain);
    face(g, [ia[0], yi, ia[1]], [ib[0], yi, ib[1]], [ib[0], yi + 0.4, ib[1]], [ia[0], yi + 0.4, ia[1]], inward, WHITE, b.plain);
    face(g, [ra[0], yo, ra[1]], [rb[0], yo, rb[1]], [rb[0], yo + 0.5, rb[1]], [ra[0], yo + 0.5, ra[1]], out, WHITE, b.plain);
    if (k % 2 === 0) {
      const [la, lb] = [lerp2(ia, ra, 0.03), lerp2(ib, ra, 0.03)];
      face(g, [la[0], yi - 0.02, la[1]], [lb[0], yi - 0.02, lb[1]], [lb[0] + (ra[0] - la[0]) * 0.06, yi - 0.1, lb[1] + (ra[1] - la[1]) * 0.06], [la[0] + (ra[0] - la[0]) * 0.06, yi - 0.1, la[1] + (ra[1] - la[1]) * 0.06], [0, -1, 0], WHITE, b.lamp);
    }
    // A column under the canopy's back edge at every other segment, from the rim up.
    if (k % 2 === 0) strut(g, [ra[0], top + BOWL.rimY + 0.6, ra[1]], [ra[0], yo, ra[1]], 0.5, WHITE, b.plain, false);
  }
  // The apron round the pitch, the pitch in mown stripes, and its markings.
  const [px, pz] = BOWL.pitch;
  const [fx, fz] = BOWL.foot;
  const y = top + 0.02;
  const flat = (x0: number, z0: number, x1: number, z1: number, yy: number, c: RGB) => face(g, [x0, yy, z0], [x1, yy, z0], [x1, yy, z1], [x0, yy, z1], up, c, b.plain);
  const apron: RGB = [0.05, 0.15, 0.04];
  flat(cx - fx, cz - fz, cx + fx, cz - pz, y, apron);
  flat(cx - fx, cz + pz, cx + fx, cz + fz, y, apron);
  flat(cx - fx, cz - pz, cx - px, cz + pz, y, apron);
  flat(cx + px, cz - pz, cx + fx, cz + pz, y, apron);
  const stripes = 12;
  for (let i = 0; i < stripes; i++) {
    const x0 = cx - px + (2 * px * i) / stripes;
    flat(x0, cz - pz, x0 + (2 * px) / stripes, cz + pz, y, i % 2 === 0 ? [0.07, 0.25, 0.05] : [0.055, 0.2, 0.04]);
  }
  const line: RGB = [0.95, 0.95, 0.93];
  // 6 cm over the grass: at 2 cm they fought it in the depth buffer from the stands' rim.
  const ly = y + 0.06;
  const lw = 0.15;
  flat(cx - px, cz - pz, cx + px, cz - pz + lw, ly, line);
  flat(cx - px, cz + pz - lw, cx + px, cz + pz, ly, line);
  flat(cx - px, cz - pz, cx - px + lw, cz + pz, ly, line);
  flat(cx + px - lw, cz - pz, cx + px, cz + pz, ly, line);
  flat(cx - lw / 2, cz - pz, cx + lw / 2, cz + pz, ly, line);
  for (const s of [-1, 1]) {
    const gx = cx + s * px;
    const bx = gx - s * 10;
    flat(Math.min(gx, bx), cz - 12, Math.max(gx, bx), cz - 12 + lw, ly, line);
    flat(Math.min(gx, bx), cz + 12 - lw, Math.max(gx, bx), cz + 12, ly, line);
    flat(bx - lw / 2, cz - 12, bx + lw / 2, cz + 12, ly, line);
    // The goal: posts and a crossbar, white.
    for (const sz of [-1, 1]) strut(g, [gx, y, cz + sz * 3.7], [gx, y + 2.44, cz + sz * 3.7], 0.12, line, b.plain, false);
    strut(g, [gx, y + 2.44, cz - 3.76], [gx, y + 2.44, cz + 3.76], 0.12, line, b.plain);
  }
  const ring = 24;
  for (let k = 0; k < ring; k++) {
    const a0 = (k / ring) * Math.PI * 2;
    const a1 = ((k + 1) / ring) * Math.PI * 2;
    const r0 = 6;
    const r1 = 6 + lw;
    face(g, [cx + Math.cos(a0) * r0, ly, cz + Math.sin(a0) * r0], [cx + Math.cos(a1) * r0, ly, cz + Math.sin(a1) * r0], [cx + Math.cos(a1) * r1, ly, cz + Math.sin(a1) * r1], [cx + Math.cos(a0) * r1, ly, cz + Math.sin(a0) * r1], up, line, b.plain);
  }
  // The floodlight masts at the podium's corners, leaning in, each head a dark frame of lamps turned to the centre spot.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const foot: V = [cx + sx * (r.maxX - cx - 3.2), top + 0.9, cz + sz * (r.maxZ - cz - 3)];
      const head: V = [cx + sx * (r.maxX - cx - 5.5), top + 32, cz + sz * (r.maxZ - cz - 4.8)];
      strut(g, foot, head, 1.1, [0.58, 0.6, 0.62], b.plain);
      const d = new THREE.Vector3(cx - head[0], -18, cz - head[2]).normalize();
      const side = new THREE.Vector3(-d.z, 0, d.x).normalize();
      const upv = new THREE.Vector3().crossVectors(side, d).normalize();
      const at = (u: number, v: number, w: number): V => [head[0] + side.x * u + upv.x * v + d.x * w, head[1] + 1.6 + side.y * u + upv.y * v + d.y * w, head[2] + side.z * u + upv.z * v + d.z * w];
      const dv: V = [d.x, d.y, d.z];
      face(g, at(-3, -1.8, 0), at(3, -1.8, 0), at(3, 1.8, 0), at(-3, 1.8, 0), dv, DARK, b.plain);
      face(g, at(-3, -1.8, -0.3), at(3, -1.8, -0.3), at(3, 1.8, -0.3), at(-3, 1.8, -0.3), [-d.x, -d.y, -d.z], DARK, b.plain);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
        const u = -2.25 + i * 1.5;
        const v = -1.2 + j * 1.2;
        face(g, at(u - 0.55, v - 0.45, 0.05), at(u + 0.55, v - 0.45, 0.05), at(u + 0.55, v + 0.45, 0.05), at(u - 0.55, v + 0.45, 0.05), dv, WHITE, b.lamp);
      }
    }
  }
}

/** The cranes and the stadium: one geometry and material, split into the city's cells; the lamps glow after dark. */
export function buildSetPieces(view: CityView): void {
  const L = view.world.layout;
  const atlas = Atlas.growing();
  const bands: Bands = { plain: solid(atlas, '#ffffff', null), lamp: solid(atlas, '#fff6e0', '#e8dcc0'), beacon: solid(atlas, '#ff4030', '#ff2a18'), concourse: solid(atlas, '#2a3442', '#2c2418') };
  const g = new GeoBuilder(true);
  for (const p of L.props) if (p.kind === 'crane') crane(g, p, bands);
  if (L.stadium) stadium(g, atlas, L.stadium, bands);
  const mat = new THREE.MeshStandardMaterial({ map: atlas.texture(), emissiveMap: atlas.texture(true), emissive: 0xffffff, emissiveIntensity: 0.4, vertexColors: true, roughness: 0.7, metalness: 0.15 });
  mat.name = 'setpieces';
  view.materials.signs.push(mat);
  view.add(g.build(), mat, { shadow: true, name: 'setpieces' });
}
