// Lake Lomas's shore (world/country/lake.ts): the dock's bollards, crates and lantern (the piers themselves are the city's:
// render/city/coast.ts draws every deck), four log cabins with porches and a lamp by each door, the campground (a ring of
// stones round the campfire's logs, three tents, a camper van, a pit toilet, picnic tables), an overturned rowboat, the
// signs, the gravel and the dirt lanes, the reeds in the shallows and the ducks and loons on the water. The pieces are one
// place's meshes in a kit of their own (kit.ts), lit after dark with the county's signs: the cabins' windows and the lamps'
// glass. The lamps' halos and the pools of light they throw on the ground are a draw each, their strength the night's; the
// fire's own (embers, flames, light) is campfire.ts.

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { EAVES_Y, RIDGE_Y } from '../../world/country/lake';
import type { CountyLakeland, LakeCabin, LakeSign, Table, Tent } from '../../world/country/lakeland';
import { WATER_Y } from '../../world/constants';
import { boxC, face, pitched, tri, type V } from '../city/attractions';
import { prism } from '../city/rooftops';
import { GeoBuilder, scaleRgb, type RGB } from '../geo';
import { fadeNearCamera, type WindUniforms } from '../props';
import { canvas, glowTexture, toTexture } from '../textures/misc';
import type { ViewState } from '../../sim/viewState';
import type { Camera, CountryView } from './index';
import type { PlacePieces, PlacesKit } from './kit';

const WOOD: RGB = [0.45, 0.31, 0.19];
const DARK_WOOD: RGB = [0.27, 0.19, 0.12];
const STONE: RGB = [0.52, 0.5, 0.46];
const LOGS: readonly RGB[] = [[0.58, 0.39, 0.23], [0.5, 0.34, 0.21], [0.62, 0.45, 0.27], [0.46, 0.3, 0.2]];
const ROOFS: readonly RGB[] = [[0.2, 0.31, 0.27], [0.45, 0.2, 0.16], [0.26, 0.24, 0.23], [0.22, 0.28, 0.36]];
const DECK_Y = 0.16;
/** The camp's glow and the lamps' warm light (linear colour of the pools and halos). */
const LAMP_GLOW = 0xffc578;

/** A triangle mesh into `g`, painted `color`, transformed by `m` (flat shaded). */
function put(g: GeoBuilder, geo: THREE.BufferGeometry, color: RGB, m?: THREE.Matrix4): void {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const pos = src.getAttribute('position');
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let i = 0; i + 2 < pos.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      v[k]!.fromBufferAttribute(pos, i + k);
      if (m) v[k]!.applyMatrix4(m);
    }
    g.tri(v[0]!.x, v[0]!.y, v[0]!.z, v[1]!.x, v[1]!.y, v[1]!.z, v[2]!.x, v[2]!.y, v[2]!.z, [0, 0, 1, 0, 0.5, 1], color);
  }
  if (src !== geo) src.dispose();
  geo.dispose();
}

/** A local frame turned by a quarter turn: a point (lx, ly, lz) of a piece standing at (ox, oz) facing (sin rot, cos rot). */
function frame(ox: number, oz: number, rot: number): (lx: number, ly: number, lz: number) => V {
  const c = Math.round(Math.cos(rot));
  const s = Math.round(Math.sin(rot));
  return (lx, ly, lz) => [ox + lx * c + lz * s, ly, oz + lz * c - lx * s];
}

/** An axis-aligned box in a quarter-turned frame (so still axis-aligned in the world). */
function qbox(g: GeoBuilder, f: ReturnType<typeof frame>, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: RGB): void {
  const a = f(x0, y0, z0);
  const b = f(x1, y1, z1);
  boxC(g, Math.min(a[0], b[0]), y0, Math.min(a[2], b[2]), Math.max(a[0], b[0]), y1, Math.max(a[2], b[2]), color);
}

/** The rim of a log wall painted into a band: courses of logs, with windows (lit in the glow) and a door at the given u fractions. */
function logWall(kit: PlacesKit, h: number, windows: readonly number[], door: number | null, seed: number): [number, number] {
  return kit.atlas.band(h, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    ctx.fillStyle = glow ? '#000' : '#6b4829';
    ctx.fillRect(0, 0, 1024, h);
    const rng = new Rng(seed);
    if (!glow) {
      const course = h / 9;
      for (let k = 0; k < 9; k++) {
        const y = k * course;
        const shade = 92 + rng.range(-14, 16);
        ctx.fillStyle = `rgb(${shade + 38},${shade + 4},${shade - 32})`;
        ctx.fillRect(0, y + 2, 1024, course - 4);
        ctx.fillStyle = 'rgba(255,230,190,0.16)';
        ctx.fillRect(0, y + 3, 1024, course * 0.22);
        ctx.fillStyle = 'rgba(30,16,8,0.55)';
        ctx.fillRect(0, y + course - 4, 1024, 4);
        for (let n = 0; n < 5; n++) ctx.fillRect(rng.range(0, 1024), y + 5, 2, course - 12);
      }
    }
    const win = (u: number) => {
      const w = 190;
      const x = u * 1024 - w / 2;
      const y = h * 0.3;
      const wh = h * 0.4;
      if (glow) {
        const g = ctx.createLinearGradient(0, y, 0, y + wh);
        g.addColorStop(0, '#7a5a2a');
        g.addColorStop(1, '#5a4020');
        ctx.fillStyle = g;
        ctx.fillRect(x + 12, y + 12, w - 24, wh - 24);
        return;
      }
      ctx.fillStyle = '#f1ead8';
      ctx.fillRect(x, y, w, wh);
      ctx.fillStyle = '#3c4f5b';
      ctx.fillRect(x + 12, y + 12, w - 24, wh - 24);
      ctx.fillStyle = '#a9bcc4';
      ctx.fillRect(x + 12, y + 12, (w - 24) * 0.4, (wh - 24) * 0.35);
      ctx.fillStyle = '#f1ead8';
      ctx.fillRect(x + w / 2 - 4, y, 8, wh);
      ctx.fillRect(x, y + wh / 2 - 4, w, 8);
      ctx.fillStyle = '#b53a2c';
      ctx.fillRect(x - 6, y - 8, 34, wh + 16);
      ctx.fillRect(x + w - 28, y - 8, 34, wh + 16);
    };
    for (const u of windows) win(u);
    if (door !== null) {
      const w = 150;
      const x = door * 1024 - w / 2;
      if (glow) {
        ctx.fillStyle = '#4a361a';
        ctx.fillRect(x + w * 0.2, h * 0.14, w * 0.6, h * 0.22);
      } else {
        ctx.fillStyle = '#2d1c11';
        ctx.fillRect(x - 8, h * 0.08, w + 16, h * 0.92);
        ctx.fillStyle = '#7a3b22';
        ctx.fillRect(x, h * 0.1, w, h * 0.9);
        ctx.fillStyle = '#3c4f5b';
        ctx.fillRect(x + w * 0.2, h * 0.14, w * 0.6, h * 0.22);
        ctx.fillStyle = '#e0c060';
        ctx.fillRect(x + w * 0.8, h * 0.62, 10, 10);
      }
    }
  }, true);
}

/** A sign board's band (px), 5.33 times as wide as it is tall. */
const SIGN_H = 192;

/** A sign board's band: its lines of text auto-fitted on a weathered board (the first line the headline, in the board's accent). */
function signBand(kit: PlacesKit, s: LakeSign): [number, number] {
  const tone = { lake: ['#1f4d52', '#f4efe0', '#f2c14e'], swim: ['#f4efe0', '#b8201a', '#1a1a1a'], camp: ['#4a3322', '#f4efe0', '#f2c14e'], fire: ['#2b2b2b', '#f4a742', '#f4efe0'], pinewood: ['#27422d', '#f4efe0', '#f2c14e'], welcome: ['#6e3b1c', '#f4efe0', '#f2c14e'] }[s.id];
  const H = SIGN_H;
  return kit.atlas.band(H, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    ctx.fillStyle = glow ? '#000' : tone[0]!;
    ctx.fillRect(0, 0, 1024, H);
    if (glow) return;
    ctx.strokeStyle = tone[1]!;
    ctx.lineWidth = 8;
    ctx.strokeRect(12, 12, 1000, H - 24);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const raw = s.lines.map((_l, k) => (k === 0 ? 72 : 40));
    const fit = Math.min(1, (H - 28) / raw.reduce((a, b) => a + b * 1.12, 0));
    const sizes = raw.map((v) => v * fit);
    const total = sizes.reduce((a, b) => a + b * 1.12, 0);
    let y = (H - total) / 2;
    s.lines.forEach((text, k) => {
      let px = sizes[k]!;
      ctx.font = `700 ${px}px Anton, Impact, "Arial Black", sans-serif`;
      while (ctx.measureText(text).width > 940 && px > 18) {
        px -= 4;
        ctx.font = `700 ${px}px Anton, Impact, "Arial Black", sans-serif`;
      }
      ctx.fillStyle = k === 0 ? tone[2]! : tone[1]!;
      ctx.fillText(text, 512, y + (sizes[k]! * 1.12) / 2);
      y += sizes[k]! * 1.12;
    });
  }, true);
}

/** A sign: its board on two posts, facing (sin rot, cos rot). */
function drawSign(kit: PlacesKit, p: PlacePieces, s: LakeSign): void {
  const ax = Math.cos(s.rot);
  const az = -Math.sin(s.rot);
  const fx = Math.sin(s.rot);
  const fz = Math.cos(s.rot);
  const w = s.id === 'fire' ? 1.7 : 3.2;
  const h = (w * SIGN_H) / 1024;
  const top = s.id === 'fire' ? 1.35 : 2.3;
  for (const k of [-1, 1]) boxC(p.plain, s.x + ax * k * (w / 2 - 0.12) - 0.07, 0, s.z + az * k * (w / 2 - 0.12) - 0.07, s.x + ax * k * (w / 2 - 0.12) + 0.07, top + 0.1, s.z + az * k * (w / 2 - 0.12) + 0.07, WOOD);
  kit.board(p, signBand(kit, s), w, h, s.x + fx * 0.09, top - h / 2, s.z + fz * 0.09, s.rot);
  // The backing slab behind the board: 0.14 m thick, its face 2 cm behind the board's.
  const cx = s.x - fx * 0.05;
  const cz = s.z - fz * 0.05;
  const hx = Math.abs(ax) * (w / 2 + 0.05) + Math.abs(fx) * 0.07;
  const hz = Math.abs(az) * (w / 2 + 0.05) + Math.abs(fz) * 0.07;
  boxC(p.plain, cx - hx, top - h - 0.04, cz - hz, cx + hx, top + 0.04, cz + hz, DARK_WOOD);
}

/** A picnic table, its top along (cos rot, -sin rot): a top of boards, two benches and two A-frame ends. */
function picnicTable(g: GeoBuilder, t: Table): void {
  const f = frame(t.x, t.z, Math.round(t.rot / (Math.PI / 2)) * (Math.PI / 2));
  const w: RGB = [0.22, 0.14, 0.08];
  qbox(g, f, -0.9, 0.72, -0.4, 0.9, 0.78, 0.4, w);
  for (const s of [-1, 1]) {
    qbox(g, f, -0.9, 0.42, s * 0.78 - 0.14, 0.9, 0.46, s * 0.78 + 0.14, scaleRgb(w, 0.9));
    for (const x of [-0.65, 0.65]) qbox(g, f, x - 0.04, 0, s * 0.42 - 0.04, x + 0.04, 0.72, s * 0.42 + 0.04, scaleRgb(w, 0.7));
    for (const x of [-0.65, 0.65]) qbox(g, f, x - 0.04, 0, s * 0.78 - 0.04, x + 0.04, 0.42, s * 0.78 + 0.04, scaleRgb(w, 0.7));
  }
}

/** The cabins' walls as bands of the atlas, shared by all four: the front with its door and two windows, a side, the back and the gable's bare logs. */
interface CabinBands {
  front: [number, number];
  side: [number, number];
  back: [number, number];
  gable: [number, number];
}

function cabinBands(kit: PlacesKit): CabinBands {
  return { front: logWall(kit, 300, [0.2, 0.8], 0.5, 31), side: logWall(kit, 300, [0.5], null, 41), back: logWall(kit, 300, [0.28, 0.72], null, 51), gable: logWall(kit, 180, [], null, 61) };
}

/** A log cabin: its walls painted with their windows, the gable roof, a stone chimney and the porch with its posts, rail and lamp. */
function drawCabin(kit: PlacesKit, p: PlacePieces, c: LakeCabin, k: number, bands: CabinBands): void {
  const r = c.rect;
  const w = r.maxX - r.minX;
  const d = r.maxZ - r.minZ;
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const { front, side, back, gable } = bands;
  const E = EAVES_Y;
  // Each cabin's logs take their own stain.
  const wall = LOGS[k % LOGS.length]!;
  const stain: RGB = [wall[0] / 0.55, wall[1] / 0.55, wall[2] / 0.55];
  kit.board(p, front, w, E, cx, E / 2, r.maxZ + 0.02, 0, 0, 1, stain);
  kit.board(p, back, w, E, cx, E / 2, r.minZ - 0.02, Math.PI, 0, 1, stain);
  kit.board(p, side, d, E, r.maxX + 0.02, E / 2, cz, Math.PI / 2, 0, 1, stain);
  kit.board(p, side, d, E, r.minX - 0.02, E / 2, cz, -Math.PI / 2, 0, 1, stain);
  const roof = ROOFS[k % ROOFS.length]!;
  pitched(p.plain, r, E, RIDGE_Y, true, 0.5, roof, scaleRgb(wall, 0.9));
  // The gable ends' logs, painted over the plain triangles.
  p.painted.tri(r.minX - 0.02, E, r.minZ, r.minX - 0.02, E, r.maxZ, r.minX - 0.02, RIDGE_Y - 0.05, cz, [0, gable[0], 1, gable[0], 0.5, gable[1]], stain);
  p.painted.tri(r.maxX + 0.02, E, r.maxZ, r.maxX + 0.02, E, r.minZ, r.maxX + 0.02, RIDGE_Y - 0.05, cz, [0, gable[0], 1, gable[0], 0.5, gable[1]], stain);
  // The chimney: stone, up the north wall's east end past the ridge.
  boxC(p.plain, r.maxX - 1.9, 0, r.minZ - 0.55, r.maxX - 1.0, RIDGE_Y + 0.9, r.minZ + 0.05, STONE);
  boxC(p.plain, r.maxX - 2.0, RIDGE_Y + 0.9, r.minZ - 0.65, r.maxX - 0.9, RIDGE_Y + 1.05, r.minZ + 0.15, scaleRgb(STONE, 0.7));
  // The porch along the front: a deck, three posts, a lean-to roof and a rail with a gap at the door.
  const pr = c.porch;
  boxC(p.plain, pr.minX - 0.1, 0, pr.minZ, pr.maxX + 0.1, DECK_Y, pr.maxZ, WOOD);
  for (const x of [pr.minX + 0.12, pr.maxX - 0.12]) boxC(p.plain, x - 0.1, DECK_Y, pr.maxZ - 0.3, x + 0.1, 2.35, pr.maxZ - 0.1, DARK_WOOD);
  const roofLow = 2.3;
  face(p.plain, [pr.minX - 0.25, E - 0.1, pr.minZ], [pr.maxX + 0.25, E - 0.1, pr.minZ], [pr.maxX + 0.25, roofLow, pr.maxZ + 0.2], [pr.minX - 0.25, roofLow, pr.maxZ + 0.2], [0, 1, 0.4], roof);
  face(p.plain, [pr.minX - 0.25, roofLow - 0.08, pr.maxZ + 0.2], [pr.maxX + 0.25, roofLow - 0.08, pr.maxZ + 0.2], [pr.maxX + 0.25, E - 0.18, pr.minZ], [pr.minX - 0.25, E - 0.18, pr.minZ], [0, -1, 0], scaleRgb(wall, 0.7));
  for (const [x0, x1] of [[pr.minX + 0.1, cx - 0.9], [cx + 0.9, pr.maxX - 0.1]] as const) boxC(p.plain, x0, 0.85, pr.maxZ - 0.22, x1, 0.92, pr.maxZ - 0.16, DARK_WOOD);
  for (const x of [cx - 1.05, cx + 1.05]) boxC(p.plain, x - 0.05, DECK_Y, pr.maxZ - 0.25, x + 0.05, 0.92, pr.maxZ - 0.15, DARK_WOOD);
  // The step down from the deck at the door, and the lamp on the east post: a dark cage round warm glass.
  boxC(p.plain, cx - 0.9, 0, pr.maxZ, cx + 0.9, 0.08, pr.maxZ + 0.5, scaleRgb(WOOD, 0.8));
  const l = c.lamp;
  boxC(p.plain, l.x - 0.1, l.y - 0.14, l.z - 0.1, l.x + 0.1, l.y + 0.14, l.z + 0.1, [0.12, 0.1, 0.09]);
  boxC(p.plain, l.x - 0.12, l.y + 0.14, l.z - 0.12, l.x + 0.12, l.y + 0.2, l.z + 0.12, [0.12, 0.1, 0.09]);
  const bulb = kit.atlas.band(32, (ctx) => {
    ctx.fillStyle = '#ffd890';
    ctx.fillRect(0, 0, 1024, 32);
  }, true);
  kit.board(p, bulb, 0.14, 0.2, l.x, l.y, l.z + 0.11, 0);
  kit.board(p, bulb, 0.14, 0.2, l.x, l.y, l.z - 0.11, Math.PI);
  kit.board(p, bulb, 0.14, 0.2, l.x + 0.11, l.y, l.z, Math.PI / 2);
  kit.board(p, bulb, 0.14, 0.2, l.x - 0.11, l.y, l.z, -Math.PI / 2);
}

/** A tent in a quarter-turned frame, its door facing (sin rot, cos rot): a ridge tent of green canvas, an orange dome, a big family tent. */
function drawTent(g: GeoBuilder, t: Tent): void {
  const f = frame(t.x, t.z, t.rot);
  const dark: RGB = [0.07, 0.07, 0.08];
  if (t.kind === 'dome') {
    const m = new THREE.Matrix4().makeTranslation(t.x, 0, t.z);
    const dome = new THREE.SphereGeometry(1.55, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.9, 1).toNonIndexed();
    const pos = dome.getAttribute('position');
    const orange: RGB = [0.88, 0.42, 0.13];
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const a = Math.atan2(pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2), pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2));
      const panel = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 7) % 2;
      const c = panel ? orange : scaleRgb(orange, 0.72);
      const v = [0, 1, 2].map((k) => new THREE.Vector3(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)).applyMatrix4(m));
      g.tri(v[0]!.x, v[0]!.y, v[0]!.z, v[1]!.x, v[1]!.y, v[1]!.z, v[2]!.x, v[2]!.y, v[2]!.z, [0, 0, 1, 0, 0.5, 1], c);
    }
    dome.dispose();
    // The door: a dark panel in the dome's front.
    const d0 = f(-0.45, 0, 1.46);
    const d1 = f(0.45, 0.85, 1.28);
    face(g, [d0[0], 0, d0[2]], [d1[0], 0, d1[2]], [d1[0], 0.85, d1[2]], [d0[0], 0.85, d0[2]], [Math.sin(t.rot), 0, Math.cos(t.rot)], dark);
    return;
  }
  const ridge = t.kind === 'ridge';
  const [l, w, h] = ridge ? [3.2, 2.3, 1.6] : [4.6, 3.6, 2.1];
  const canvasColor: RGB = ridge ? [0.3, 0.4, 0.2] : [0.34, 0.44, 0.58];
  const trim: RGB = ridge ? [0.22, 0.28, 0.14] : [0.85, 0.5, 0.15];
  const P = (lx: number, ly: number, lz: number): V => f(lx, ly, lz);
  const hw = w / 2;
  const hl = l / 2;
  const wall = ridge ? 0 : 1.15;
  // Two slopes, the back wall and the door's gable with its dark flap.
  face(g, P(-hw, wall, -hl), P(-hw, wall, hl), P(0, h, hl), P(0, h, -hl), P(-1, 1, 0), canvasColor);
  face(g, P(hw, wall, -hl), P(hw, wall, hl), P(0, h, hl), P(0, h, -hl), P(1, 1, 0), scaleRgb(canvasColor, 0.9));
  if (!ridge) {
    face(g, P(-hw, 0, -hl), P(-hw, 0, hl), P(-hw, wall, hl), P(-hw, wall, -hl), P(-1, 0, 0), scaleRgb(canvasColor, 0.8));
    face(g, P(hw, 0, -hl), P(hw, 0, hl), P(hw, wall, hl), P(hw, wall, -hl), P(1, 0, 0), scaleRgb(canvasColor, 0.8));
  }
  const toward = (lx: number, lz: number): V => { const a = f(0, 0, 0); const b = f(lx, 0, lz); return [b[0] - a[0], 0, b[2] - a[2]]; };
  face(g, P(-hw, 0, -hl), P(hw, 0, -hl), P(hw, wall, -hl), P(-hw, wall, -hl), toward(0, -1), scaleRgb(canvasColor, 0.85));
  tri(g, P(-hw, wall, -hl), P(hw, wall, -hl), P(0, h, -hl), toward(0, -1), scaleRgb(canvasColor, 0.85));
  face(g, P(-hw, 0, hl), P(hw, 0, hl), P(hw, wall, hl), P(-hw, wall, hl), toward(0, 1), scaleRgb(canvasColor, 0.95));
  tri(g, P(-hw, wall, hl), P(hw, wall, hl), P(0, h, hl), toward(0, 1), scaleRgb(canvasColor, 0.95));
  face(g, P(-0.45, 0, hl + 0.01), P(0.45, 0, hl + 0.01), P(0.25, wall + (h - wall) * 0.6, hl + 0.01), P(-0.25, wall + (h - wall) * 0.6, hl + 0.01), toward(0, 1), dark);
  // The ridge pole's trim and the guy lines' pegs.
  boxC(g, ...(() => { const a = P(-0.04, h - 0.04, -hl); const b = P(0.04, h + 0.04, hl); return [Math.min(a[0], b[0]), h - 0.04, Math.min(a[2], b[2]), Math.max(a[0], b[0]), h + 0.04, Math.max(a[2], b[2])] as const; })(), trim);
}

/** The camper van, nose to -x or +x by its quarter-turn rot: two-tone, a pop-top, windows, round headlights, four wheels and an awning with two chairs. */
function drawVan(g: GeoBuilder, van: { x: number; z: number; rot: number }): void {
  const f = frame(van.x, van.z, van.rot);
  const teal: RGB = [0.22, 0.55, 0.55];
  const cream: RGB = [0.92, 0.88, 0.76];
  const glass: RGB = [0.12, 0.16, 0.19];
  qbox(g, f, -1.0, 0.4, -2.55, 1.0, 1.25, 2.55, teal);
  qbox(g, f, -1.0, 1.25, -2.5, 1.0, 1.95, 2.3, cream);
  qbox(g, f, -0.95, 1.95, -1.9, 0.95, 2.3, 1.3, cream);
  // The windscreen, windows down both sides and a skirt along the sills.
  qbox(g, f, -0.9, 1.45, 2.3, 0.9, 1.88, 2.34, glass);
  for (const s of [-1, 1]) {
    const [x0, x1] = s > 0 ? [1.0, 1.03] : [-1.03, -1.0];
    for (const [z0, z1] of [[1.1, 2.0], [-0.1, 0.9], [-1.3, -0.3]] as const) qbox(g, f, x0, 1.4, z0, x1, 1.85, z1, glass);
    qbox(g, f, x0, 0.62, -2.2, x1, 0.68, 2.2, scaleRgb(teal, 0.6));
  }
  // Headlights, bumpers and the spare on the back.
  for (const s of [-1, 1]) qbox(g, f, s * 0.6 - 0.14, 0.75, 2.55, s * 0.6 + 0.14, 1.05, 2.62, [1, 0.95, 0.8]);
  qbox(g, f, -1.05, 0.3, 2.5, 1.05, 0.45, 2.68, [0.75, 0.76, 0.78]);
  qbox(g, f, -1.05, 0.3, -2.62, 1.05, 0.45, -2.5, [0.75, 0.76, 0.78]);
  for (const sx of [-1, 1]) for (const z of [-1.55, 1.55]) {
    const c = f(sx * 1.0, 0.36, z);
    const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.22, 14).rotateZ(Math.PI / 2);
    put(g, wheel, [0.1, 0.1, 0.11], new THREE.Matrix4().makeTranslation(c[0], c[1], c[2]).multiply(new THREE.Matrix4().makeRotationY(van.rot)));
    const hub = new THREE.CylinderGeometry(0.16, 0.16, 0.24, 8).rotateZ(Math.PI / 2);
    put(g, hub, [0.8, 0.8, 0.78], new THREE.Matrix4().makeTranslation(c[0], c[1], c[2]).multiply(new THREE.Matrix4().makeRotationY(van.rot)));
  }
  // The awning: out over the side that faces the fire, striped, with two folding chairs under it.
  const side = 1;
  const A = (lx: number, ly: number, lz: number) => f(lx, ly, lz);
  for (let k = 0; k < 5; k++) {
    const z0 = -2.2 + k * 0.88;
    const stripe: RGB = k % 2 ? [0.9, 0.35, 0.2] : [0.95, 0.92, 0.84];
    const a = A(side * 1.0, 2.0, z0);
    const b = A(side * 1.0, 2.0, z0 + 0.88);
    const c2 = A(side * 2.6, 1.7, z0 + 0.88);
    const d = A(side * 2.6, 1.7, z0);
    face(g, a, b, c2, d, [0, 1, 0], stripe);
  }
  for (const z of [-0.5, 1.0]) {
    qbox(g, f, 1.55, 0.32, z - 0.28, 1.95, 0.38, z + 0.28, [0.8, 0.25, 0.22]);
    qbox(g, f, 1.85, 0.38, z - 0.28, 1.95, 0.9, z + 0.28, [0.8, 0.25, 0.22]);
    for (const dz of [-0.26, 0.26]) qbox(g, f, 1.6, 0, z + dz - 0.02, 1.65, 0.32, z + dz + 0.02, [0.5, 0.52, 0.55]);
  }
}

/** The pit toilet: a plank box with a slanted tin roof, a vent pipe and a moon cut in its door, on the side that faces `rot`. */
function drawToilet(kit: PlacesKit, p: PlacePieces, t: { x: number; z: number; rot: number }): void {
  const g = p.plain;
  const f = frame(t.x, t.z, t.rot);
  const plank: RGB = [0.5, 0.42, 0.3];
  qbox(g, f, -0.7, 0, -0.7, 0.7, 2.25, 0.7, plank);
  const P = (lx: number, ly: number, lz: number): V => f(lx, ly, lz);
  face(g, P(-0.85, 2.55, -0.85), P(0.85, 2.55, -0.85), P(0.85, 2.2, 0.85), P(-0.85, 2.2, 0.85), [0, 1, 0], [0.55, 0.57, 0.58]);
  face(g, P(-0.85, 2.2, 0.85), P(0.85, 2.2, 0.85), P(0.85, 2.55, -0.85), P(-0.85, 2.55, -0.85), [0, -1, 0], [0.3, 0.3, 0.3]);
  const [vx, vy, vz] = P(0.4, 0, -0.4);
  prism(g, vx, vz, 0.07, 0.07, vy + 2.4, vy + 3.1, 6, [0.4, 0.4, 0.42]);
  const door = kit.atlas.band(256, (ctx) => {
    const glow = ctx.canvas !== kit.atlas.canvas;
    ctx.fillStyle = glow ? '#000' : '#3f5a3c';
    ctx.fillRect(0, 0, 1024, 256);
    if (glow) return;
    // The door's planks, 148 px of the band, and a crescent moon cut in it, the privy's tradition.
    ctx.fillStyle = '#2a3f28';
    for (let k = 0; k < 5; k++) ctx.fillRect(438 + k * 37, 0, 4, 256);
    ctx.fillStyle = '#0c0f0c';
    ctx.beginPath();
    ctx.arc(512, 62, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3f5a3c';
    ctx.beginPath();
    ctx.arc(521, 57, 19, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8d0b0';
    ctx.fillRect(500, 150, 24, 8);
  }, true);
  const c = P(0, 1.1, 0.72);
  kit.board(p, door, 1.1, 1.9, c[0], 1.1, c[2], t.rot, 0.4277, 0.5723);
}

/** The rowboat turned over on the beach: a red hull, a keel strip and two oars in the grass beside it. */
function drawRowboat(g: GeoBuilder, r: { x: number; z: number; rot: number }, y: number): void {
  const m = new THREE.Matrix4().makeTranslation(r.x, y, r.z).multiply(new THREE.Matrix4().makeRotationY(r.rot)).multiply(new THREE.Matrix4().makeScale(1.85, 0.62, 0.72));
  put(g, new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), [0.62, 0.17, 0.13], m);
  const k = new THREE.Matrix4().makeTranslation(r.x, y + 0.6, r.z).multiply(new THREE.Matrix4().makeRotationY(r.rot)).multiply(new THREE.Matrix4().makeScale(1.7, 0.05, 0.08));
  put(g, new THREE.BoxGeometry(2, 1, 1), [0.82, 0.8, 0.7], k);
  for (const s of [-1, 1]) {
    const o = new THREE.Matrix4().makeTranslation(r.x + Math.cos(r.rot) * 0.2 + Math.sin(r.rot) * s * 1.35, y + 0.05, r.z - Math.sin(r.rot) * 0.2 + Math.cos(r.rot) * s * 1.35).multiply(new THREE.Matrix4().makeRotationY(r.rot + 0.1 * s));
    put(g, new THREE.BoxGeometry(1.9, 0.05, 0.09), [0.72, 0.58, 0.38], o);
    put(g, new THREE.BoxGeometry(0.4, 0.05, 0.22), [0.72, 0.58, 0.38], o.clone().multiply(new THREE.Matrix4().makeTranslation(0.95, 0, 0)));
  }
}

/** The dock's furniture: a bollard every few metres along the walkway, crates at its root, a lantern post at the head's corner. */
function drawDock(g: GeoBuilder, land: CountyLakeland): void {
  const { walk, head, y, lamp } = land.dock;
  const z0 = walk.minZ + 0.18;
  const z1 = walk.maxZ - 0.18;
  for (let x = walk.minX + 4; x < walk.maxX - 2; x += 6) for (const z of [z0, z1]) prism(g, x, z, 0.1, 0.09, y, y + 0.42, 7, [0.22, 0.2, 0.18]);
  for (const z of [head.minZ + 0.25, head.maxZ - 0.25]) for (const x of [head.minX + 0.3, head.maxX - 0.3]) prism(g, x, z, 0.11, 0.1, y, y + 0.46, 7, [0.22, 0.2, 0.18]);
  // Crates and a bucket at the walkway's root, and the rods in their holders along the head's east side.
  boxC(g, walk.maxX - 3.2, y, walk.minZ + 0.3, walk.maxX - 2.4, y + 0.55, walk.minZ + 1.0, [0.55, 0.42, 0.26]);
  boxC(g, walk.maxX - 3.0, y + 0.55, walk.minZ + 0.4, walk.maxX - 2.5, y + 0.95, walk.minZ + 0.85, [0.5, 0.38, 0.23]);
  prism(g, walk.maxX - 4.4, walk.maxZ - 0.6, 0.18, 0.14, y, y + 0.34, 9, [0.2, 0.35, 0.6]);
  for (const dz of [-3, 0, 3]) {
    boxC(g, head.maxX - 0.2, y, (head.minZ + head.maxZ) / 2 + dz - 0.05, head.maxX - 0.05, y + 0.35, (head.minZ + head.maxZ) / 2 + dz + 0.05, DARK_WOOD);
    const a = new THREE.Vector3(head.maxX - 0.12, y + 0.3, (head.minZ + head.maxZ) / 2 + dz);
    const b = new THREE.Vector3(head.maxX - 2.4, y + 1.7, (head.minZ + head.maxZ) / 2 + dz);
    const rod = new THREE.CylinderGeometry(0.012, 0.025, a.distanceTo(b), 4);
    rod.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    rod.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    put(g, rod, [0.12, 0.12, 0.13]);
  }
  // The lantern post.
  boxC(g, lamp.x - 0.07, y, lamp.z - 0.07, lamp.x + 0.07, y + 2.7, lamp.z + 0.07, DARK_WOOD);
  boxC(g, lamp.x - 0.07, y + 2.5, lamp.z - 0.07, lamp.x + 0.5, y + 2.58, lamp.z + 0.07, DARK_WOOD);
}

/** The fire's ring of stones, its log seats and the standing logs of the fire: round (cx, cz), `ring` m in radius. */
function drawFireRing(g: GeoBuilder, camp: CountyLakeland['camp'], y: number): void {
  const { x, z } = camp.fire;
  const rng = new Rng(7717);
  for (let k = 0; k < 11; k++) {
    const a = (k / 11) * Math.PI * 2 + rng.range(-0.1, 0.1);
    const s = rng.range(0.26, 0.38);
    const m = new THREE.Matrix4().makeTranslation(x + Math.cos(a) * camp.ring * 0.88, y + s * 0.4, z + Math.sin(a) * camp.ring * 0.88).multiply(new THREE.Matrix4().makeRotationY(rng.range(0, 3))).multiply(new THREE.Matrix4().makeScale(s * 1.2, s * 0.85, s));
    const c = rng.range(0.42, 0.62);
    put(g, new THREE.IcosahedronGeometry(1, 0), [c, c * 0.97, c * 0.92], m);
  }
  // Ash and charred ground inside the ring.
  prism(g, x, z, camp.ring * 0.78, camp.ring * 0.78, y + 0.02, y + 0.05, 14, [0.1, 0.095, 0.09]);
  // Log seats round it, and a teepee of split logs standing in it.
  for (const l of camp.logs) {
    const m = new THREE.Matrix4().makeTranslation(l.x, y + 0.2, l.z).multiply(new THREE.Matrix4().makeRotationY(l.rot));
    put(g, new THREE.CylinderGeometry(0.2, 0.22, 1.7, 8).rotateZ(Math.PI / 2), [0.4, 0.28, 0.18], m);
  }
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const base = new THREE.Vector3(x + Math.cos(a) * 0.4, y + 0.04, z + Math.sin(a) * 0.4);
    const tip = new THREE.Vector3(x + Math.cos(a) * 0.05, y + 0.85, z + Math.sin(a) * 0.05);
    const len = base.distanceTo(tip);
    const log = new THREE.CylinderGeometry(0.045, 0.06, len, 5);
    log.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tip.clone().sub(base).normalize()));
    log.translate((base.x + tip.x) / 2, (base.y + tip.y) / 2, (base.z + tip.z) / 2);
    put(g, log, [0.28, 0.2, 0.13]);
  }
}

/** A night light of the lake's: where it hangs, how wide the pool of light it throws is and how high over its ground. */
export interface LakeLamp {
  x: number;
  y: number;
  z: number;
  pool: number;
  ground: number;
}

/** The lake's lamps: a lantern by each cabin's door and at the dock's head, each with its halo and its pool of light on the ground. */
export function lakeLamps(land: CountyLakeland): LakeLamp[] {
  const out: LakeLamp[] = [];
  for (const c of land.cabins) out.push({ x: c.lamp.x, y: c.lamp.y, z: c.lamp.z, pool: 8, ground: DECK_Y + 0.04 });
  const d = land.dock;
  out.push({ x: d.lamp.x, y: d.y + 2.5, z: d.lamp.z, pool: 9, ground: d.y + 0.05 });
  return out;
}

/** The reeds: blades of reeds and a few cattails, every clump leaning its own way, swaying on the props' wind from their feet up. */
function reedGeometry(land: CountyLakeland): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const sway: number[] = [];
  const rng = new Rng(8113);
  const blade = (x: number, y: number, z: number, h: number, ang: number, lean: number, c: RGB): void => {
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const w = 0.07;
    const tx = x + Math.cos(ang + 1.57) * lean * h;
    const tz = z + Math.sin(ang + 1.57) * lean * h;
    const mx = x + Math.cos(ang + 1.57) * lean * h * 0.35;
    const mz = z + Math.sin(ang + 1.57) * lean * h * 0.35;
    // Two triangles: a tapered blade bent halfway up.
    for (const [ax, ay, az, bx, by, bz, cx, cy, cz, s0, s1, s2] of [
      [x - dx * w, y, z - dz * w, x + dx * w, y, z + dz * w, mx + dx * w * 0.6, y + h * 0.5, mz + dz * w * 0.6, 0, 0, 0.5],
      [x - dx * w, y, z - dz * w, mx + dx * w * 0.6, y + h * 0.5, mz + dz * w * 0.6, mx - dx * w * 0.6, y + h * 0.5, mz - dz * w * 0.6, 0, 0.5, 0.5],
      [mx - dx * w * 0.6, y + h * 0.5, mz - dz * w * 0.6, mx + dx * w * 0.6, y + h * 0.5, mz + dz * w * 0.6, tx, y + h, tz, 0.5, 0.5, 1],
    ] as const) {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      for (let i = 0; i < 3; i++) col.push(c[0], c[1], c[2]);
      sway.push(s0, s1, s2);
    }
  };
  for (const r of land.reeds) {
    const base = rng.range(0, Math.PI * 2);
    for (let k = 0; k < r.blades + 3; k++) {
      const h = r.h * rng.range(0.7, 1);
      const g = rng.range(0.9, 1.25);
      blade(r.x + rng.range(-0.3, 0.3), r.y - 0.1, r.z + rng.range(-0.3, 0.3), h, base + (k / r.blades) * Math.PI * 2 + rng.range(-0.3, 0.3), r.lean + rng.range(-0.1, 0.1), [0.5 * g, 0.62 * g, 0.26 * g]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.computeVertexNormals();
  return g;
}

/** The cattails: a brown spike on a stalk above some of the clumps. */
function cattailGeometry(land: CountyLakeland): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const rng = new Rng(8114);
  for (const r of land.reeds) {
    if (!rng.chance(0.4)) continue;
    const h = r.h * 0.95;
    const stalk = new THREE.CylinderGeometry(0.012, 0.018, h, 4).translate(r.x + rng.range(-0.2, 0.2), r.y + h / 2 - 0.1, r.z + rng.range(-0.2, 0.2));
    const head = new THREE.CylinderGeometry(0.045, 0.045, 0.28, 6).translate(stalk.getAttribute('position').getX(0), r.y + h - 0.35, stalk.getAttribute('position').getZ(0));
    for (const [geo, c] of [[stalk, [0.4, 0.5, 0.22]], [head, [0.3, 0.19, 0.1]]] as const) {
      const g = geo.toNonIndexed();
      const n = g.getAttribute('position').count;
      g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => c).flat(), 3));
      g.setAttribute('aSway', new THREE.Float32BufferAttribute(Array.from({ length: n }, (_, i) => (g.getAttribute('position').getY(i) - r.y + 0.1) / r.h), 1));
      g.deleteAttribute('uv');
      parts.push(g);
      geo.dispose();
    }
  }
  const geo = parts.length > 0 ? mergeParts(parts) : new THREE.BufferGeometry();
  return geo;
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const total = parts.reduce((n, p) => n + p.getAttribute('position').count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color', 'aSway']) {
    const size = parts[0]!.getAttribute(name).itemSize;
    const data = new Float32Array(total * size);
    let at = 0;
    for (const p of parts) {
      data.set(p.getAttribute(name).array as Float32Array, at);
      at += p.getAttribute(name).array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  for (const p of parts) p.dispose();
  return out;
}

/** Makes a material sway its vertices by their `aSway` (0 at the foot, 1 at the tip) on the props' wind: reeds, cattails, wildflowers. */
export function swayOnWind(mat: THREE.Material, wind: WindUniforms, reach: number): void {
  fadeNearCamera(mat);
  const fade = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    fade.call(mat, shader, renderer);
    Object.assign(shader.uniforms, wind);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSway;\nuniform float uWindTime;\nuniform float uWindAmp;\nuniform vec2 uWindDir;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  float ph = position.x * 0.71 + position.z * 0.53;
  float gust = sin( uWindTime * 1.9 + ph ) * 0.6 + sin( uWindTime * 3.3 + ph * 1.7 ) * 0.4;
  float amp = ( 0.35 + uWindAmp * 2.4 ) * aSway * aSway * ${reach.toFixed(2)};
  transformed.xz += uWindDir * gust * amp * 0.12 + vec2( sin( ph ), cos( ph ) ) * amp * 0.03;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'gta7-sway';
}

/** The waterfowl: a duck and a loon as small vertex-coloured models, facing +z, their feet on the water's surface (y 0). */
export function duckGeometry(): THREE.BufferGeometry {
  const g = new GeoBuilder(true);
  const ellipsoid = (x: number, y: number, z: number, rx: number, ry: number, rz: number, c: RGB) => put(g, new THREE.SphereGeometry(1, 10, 6), c, new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeScale(rx, ry, rz)));
  ellipsoid(0, 0.1, -0.02, 0.17, 0.12, 0.28, [0.46, 0.4, 0.34]);
  ellipsoid(0, 0.12, 0.17, 0.15, 0.11, 0.16, [0.42, 0.27, 0.17]);
  ellipsoid(0, 0.2, -0.28, 0.07, 0.05, 0.12, [0.15, 0.15, 0.17]);
  ellipsoid(0, 0.3, 0.26, 0.085, 0.09, 0.1, [0.1, 0.4, 0.2]);
  ellipsoid(0, 0.25, 0.2, 0.065, 0.025, 0.065, [0.95, 0.95, 0.92]);
  put(g, new THREE.BoxGeometry(0.05, 0.02, 0.1), [0.95, 0.72, 0.15], new THREE.Matrix4().makeTranslation(0, 0.28, 0.38));
  return g.build();
}

export function loonGeometry(): THREE.BufferGeometry {
  const g = new GeoBuilder(true);
  const ellipsoid = (x: number, y: number, z: number, rx: number, ry: number, rz: number, c: RGB) => put(g, new THREE.SphereGeometry(1, 10, 6), c, new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeScale(rx, ry, rz)));
  ellipsoid(0, 0.1, -0.05, 0.2, 0.14, 0.4, [0.1, 0.1, 0.12]);
  ellipsoid(0, 0.02, 0.1, 0.19, 0.08, 0.3, [0.95, 0.95, 0.93]);
  // The checkered back: a few white flecks.
  const rng = new Rng(9);
  for (let k = 0; k < 14; k++) ellipsoid(rng.range(-0.12, 0.12), 0.235, rng.range(-0.3, 0.2), 0.022, 0.012, 0.022, [0.95, 0.95, 0.95]);
  ellipsoid(0, 0.3, 0.27, 0.06, 0.2, 0.06, [0.07, 0.09, 0.1]);
  ellipsoid(0, 0.42, 0.33, 0.085, 0.075, 0.12, [0.06, 0.09, 0.1]);
  put(g, new THREE.BoxGeometry(0.035, 0.035, 0.17), [0.13, 0.13, 0.14], new THREE.Matrix4().makeTranslation(0, 0.42, 0.47));
  ellipsoid(0, 0.24, 0.28, 0.063, 0.02, 0.063, [0.95, 0.95, 0.95]);
  return g.build();
}

/** How near (m) the camera, behind whoever is on the water, makes a loon dive, and for how long (s) it stays under. */
const DIVE_RANGE = 26;
const DIVE_TIME = 5;

/** Draws the lake's shore into the county: returns what moves each frame (the lamps' glow, the birds). */
export function buildLake(view: CountryView, kit: PlacesKit, wind: WindUniforms): (night: number, time: number, sim: ViewState | null, cam: Camera) => void {
  const world = view.world;
  const land = world.layout.country.lakeland;
  const ground = (x: number, z: number) => world.groundHeight(x, z);
  const p = kit.place('lake-lomas');

  // The cabins, the camp, the tables, the signs and the rest, each on its ground.
  const bands = cabinBands(kit);
  land.cabins.forEach((c, k) => drawCabin(kit, p, c, k, bands));
  for (const t of land.camp.tents) drawTent(p.plain, t);
  drawVan(p.plain, land.camp.van);
  drawToilet(kit, p, land.camp.toilet);
  drawFireRing(p.plain, land.camp, land.camp.fire.y);
  for (const t of land.tables) picnicTable(p.plain, t);
  for (const s of land.signs) drawSign(kit, p, s);
  drawRowboat(p.plain, land.rowboat, ground(land.rowboat.x, land.rowboat.z));
  drawDock(p.plain, land);

  // The reeds and the cattails: one draw each, swaying on the wind, culled with the county's cells.
  const reedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  swayOnWind(reedMat, wind, 1);
  view.add(reedGeometry(land), reedMat, { name: 'reeds', receive: false });
  const tails = cattailGeometry(land);
  if (tails.getAttribute('position')) {
    const tailMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    swayOnWind(tailMat, wind, 1);
    view.add(tails, tailMat, { name: 'cattails', receive: false });
  }

  // The lamps' halos and the pools of light under them, one draw each, their strength the night's.
  const lamps = lakeLamps(land);
  const haloGeo = new THREE.BufferGeometry();
  haloGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lamps.flatMap((l) => [l.x, l.y, l.z])), 3));
  const haloMat = new THREE.PointsMaterial({ map: glowTexture(), color: LAMP_GLOW, size: 2.2, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const halos = new THREE.Points(haloGeo, haloMat);
  halos.frustumCulled = false;
  halos.visible = false;
  halos.name = 'lake-lamp-halos';
  view.group.add(halos);
  const [pc, px] = canvas(64, 64);
  const grad = px.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,200,120,1)');
  grad.addColorStop(0.5, 'rgba(255,180,90,0.45)');
  grad.addColorStop(1, 'rgba(255,170,80,0)');
  px.fillStyle = grad;
  px.fillRect(0, 0, 64, 64);
  const poolGeo = new GeoBuilder(false);
  for (const l of lamps) poolGeo.flat(l.x - l.pool / 2, l.z - l.pool / 2, l.x + l.pool / 2, l.z + l.pool / 2, l.ground, { kind: 'unit' });
  const poolMat = new THREE.MeshBasicMaterial({ map: toTexture(pc, true, false), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  view.add(poolGeo.build(), poolMat, { name: 'lake-lamp-pools', split: false, receive: false });

  // The waterfowl: ducks and loons on their paths, the loons diving when someone comes close.
  const ducks = land.waterfowl.filter((b) => b.kind === 'duck');
  const loons = land.waterfowl.filter((b) => b.kind === 'loon');
  const birdMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
  const duckMesh = new THREE.InstancedMesh(duckGeometry(), birdMat, Math.max(1, ducks.length));
  const loonMesh = new THREE.InstancedMesh(loonGeometry(), birdMat, Math.max(1, loons.length));
  for (const m of [duckMesh, loonMesh]) {
    m.frustumCulled = false;
    m.castShadow = false;
    view.moving.add(m);
  }
  duckMesh.name = 'ducks';
  loonMesh.name = 'loons';
  const diving = loons.map(() => -Infinity);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const place = (mesh: THREE.InstancedMesh, i: number, x: number, z: number, heading: number, lift: number, scale: number): void => {
    q.setFromAxisAngle(up, heading);
    m4.compose(new THREE.Vector3(x, WATER_Y + lift, z), q, new THREE.Vector3(scale, scale, scale));
    mesh.setMatrixAt(i, m4);
  };
  const lakeCentre = { x: -2030, z: -270 };
  const cull = 360;
  return (night, time, _sim, cam) => {
    haloMat.opacity = night * 0.9;
    poolMat.opacity = night * 0.55;
    poolMat.visible = night > 0.01;
    const shown = Math.hypot(cam.x - lakeCentre.x, cam.z - lakeCentre.z) < cull;
    halos.visible = night > 0.01 && shown;
    duckMesh.visible = loonMesh.visible = shown;
    if (!shown) return;
    ducks.forEach((b, i) => {
      const a = b.phase + time * b.speed;
      place(duckMesh, i, b.cx + Math.cos(a) * b.rx, b.cz + Math.sin(a) * b.rz, Math.atan2(-Math.sin(a) * b.rx, Math.cos(a) * b.rz) + 0, Math.sin(time * 1.3 + i * 2) * 0.012, 1);
    });
    loons.forEach((b, i) => {
      const a = b.phase + time * b.speed;
      const x = b.cx + Math.cos(a) * b.rx;
      const z = b.cz + Math.sin(a) * b.rz;
      if (Math.hypot(cam.x - x, cam.z - z) < DIVE_RANGE && time - diving[i]! > DIVE_TIME + 3) diving[i] = time;
      const under = time - diving[i]!;
      // Bows, rolls under, stays down a while, then bobs up again.
      const k = under < 0.8 ? under / 0.8 : under < DIVE_TIME - 0.8 ? 1 : under < DIVE_TIME ? (DIVE_TIME - under) / 0.8 : 0;
      place(loonMesh, i, x, z, Math.atan2(-Math.sin(a) * b.rx, Math.cos(a) * b.rz), -k * 0.9 + Math.sin(time * 1.1 + i) * 0.01, k >= 1 ? 0.001 : 1);
    });
    duckMesh.instanceMatrix.needsUpdate = true;
    loonMesh.instanceMatrix.needsUpdate = true;
  };
}
