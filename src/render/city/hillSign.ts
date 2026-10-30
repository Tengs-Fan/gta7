// The SAN AZURA letters on Hillcrest Green's south slope, the two uplights that wash them at night, and the viewpoints'
// dressing (render/dressing.ts viewpoints: plaques, the sign, the fences and the coin telescopes). Three merged meshes,
// so three draws wherever they are in view: the letters with the uplights' lenses, the frames, and the plates.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hillSignLetters, type SignLetter } from '../../world/terrain';
import { viewpoints, type ViewpointItem } from '../dressing';
import { box, cyl, bar, ModelBuilder } from '../furniture';
import { canvas, toTexture } from '../textures/misc';
import type { CityView } from './index';

/** A glyph's strokes in its letter's frame (x across from -w/2, y up from its buried foot; the ground is at y 1). */
type Stroke = readonly [x0: number, y0: number, x1: number, y1: number] | { readonly d: readonly [xa: number, ya: number, xb: number, yb: number] };

/** Stroke width (m) of the block letters. */
const T = 1;
/** Block glyphs on the 4.4 m by 7 m letter (6 m out of the ground): bars and posts from the foot, diagonals as `d`. */
const GLYPHS: Readonly<Record<string, readonly Stroke[]>> = {
  S: [[-2.2, 6, 2.2, 7], [-2.2, 3.5, -2.2 + T, 7], [-2.2, 3.5, 2.2, 4.5], [2.2 - T, 0, 2.2, 4.5], [-2.2, 0, 2.2, 2]],
  A: [{ d: [-1.75, 1, -0.45, 7] }, { d: [1.75, 1, 0.45, 7] }, [-1, 6, 1, 7], [-1.3, 2.6, 1.3, 3.6], [-2.3, 0, -1.1, 1.4], [1.1, 0, 2.3, 1.4]],
  N: [[-2.2, 0, -2.2 + T, 7], [2.2 - T, 0, 2.2, 7], { d: [-1.5, 6.6, 1.5, 1.4] }],
  Z: [[-2.2, 6, 2.2, 7], [-2.2, 0, 2.2, 2], { d: [1.5, 6.3, -1.5, 1.7] }],
  U: [[-2.2, 0, -2.2 + T, 7], [2.2 - T, 0, 2.2, 7], [-2.2, 0, 2.2, 2]],
  R: [[-2.2, 0, -2.2 + T, 7], [-2.2, 6, 1.4, 7], [2.2 - T, 4, 2.2, 6.6], [-2.2, 3.5, 1.4, 4.5], { d: [-0.1, 3.8, 1.75, 1.2] }, [1.1, 0, 2.3, 1.4]],
};

/** The uplights' warm white, and how far (m) in front of the letters they stand on the lawn. */
const UPLIGHT = 0xffcf8a;
const UPLIGHT_OUT = 7;

/** The wash texture's rows: the letters' gradient runs up to WASH_TOP; above it, the uplights' lenses glow full. */
const WASH_TOP = 0.94;
const LENS_V = 0.99;

/** One letter's geometry in the world, its uv.y running 0 at its foot to WASH_TOP at its top (the wash fades up it). */
function letterGeometry(l: SignLetter): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const s of GLYPHS[l.char]!) {
    let g: THREE.BufferGeometry;
    if ('d' in s) {
      const [xa, ya, xb, yb] = s.d;
      g = new THREE.BoxGeometry(Math.hypot(xb - xa, yb - ya) + T * 0.4, T, l.d).rotateZ(Math.atan2(yb - ya, xb - xa)).translate((xa + xb) / 2, (ya + yb) / 2, 0);
    } else {
      const [x0, y0, x1, y1] = s;
      g = new THREE.BoxGeometry(x1 - x0, y1 - y0, l.d).translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
    }
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) uv.setXY(i, 0.5, WASH_TOP * Math.min(1, Math.max(0, pos.getY(i) / l.h)));
    parts.push(g);
  }
  const m = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  // Leaning on its foot's middle, positive tilt towards +x.
  return m.rotateZ(-l.tilt).translate(l.x, l.y0, l.z);
}

/**
 * The uplights' emissive map (linear): on the letters a wash brightest at their foot and nearly gone by their top, and
 * over WASH_TOP the lenses' full glow.
 */
function washTexture(): THREE.Texture {
  const [c, ctx] = canvas(4, 128);
  const g = ctx.createLinearGradient(0, 128, 0, 128 * (1 - WASH_TOP));
  g.addColorStop(0, '#5a5a5a');
  g.addColorStop(0.25, '#3a3a3a');
  g.addColorStop(1, '#0a0a0a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 128 * (1 - WASH_TOP), 4, 128 * WASH_TOP);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 4, 128 * (1 - WASH_TOP));
  return toTexture(c, false, false);
}

/** A plate's look by kind: background, border, text and heading colours. */
const PLATE_LOOK: Readonly<Record<'plaque' | 'sign' | 'telescope', { bg: string; edge: string; ink: string; head: string }>> = {
  plaque: { bg: '#4a3a22', edge: '#b99a5b', ink: '#efe3bf', head: '#efe3bf' },
  sign: { bg: '#f4f1e8', edge: '#c0392b', ink: '#1f1f1f', head: '#c0392b' },
  telescope: { bg: '#f2c94c', edge: '#1f1f1f', ink: '#1f1f1f', head: '#1f1f1f' },
};

/** Plate size (m): width and height, all 2:1 like their atlas cells. */
const PLATE_SIZE: Readonly<Record<'plaque' | 'sign' | 'telescope', readonly [number, number]>> = { plaque: [0.72, 0.36], sign: [2.3, 1.15], telescope: [0.3, 0.15] };

/** Atlas cells: 1024 by 512 each, stacked. */
const CELL_W = 1024;
const CELL_H = 512;

/** Draws a plate's text into its atlas cell: the first sentence as a heading, the rest under it, wrapped. */
function drawPlate(ctx: CanvasRenderingContext2D, row: number, kind: 'plaque' | 'sign' | 'telescope', text: string): void {
  const look = PLATE_LOOK[kind];
  const y0 = row * CELL_H;
  ctx.fillStyle = look.bg;
  ctx.fillRect(0, y0, CELL_W, CELL_H);
  ctx.strokeStyle = look.edge;
  ctx.lineWidth = 22;
  ctx.strokeRect(18, y0 + 18, CELL_W - 36, CELL_H - 36);
  const cut = text.indexOf('. ');
  const head = cut > 0 ? text.slice(0, cut + 1) : text;
  const rest = cut > 0 ? text.slice(cut + 2) : '';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = (s: string, font: string, max: number): string[] => {
    ctx.font = font;
    const out: string[] = [];
    let line = '';
    for (const w of s.split(' ')) {
      const next = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(next).width > max) {
        out.push(line);
        line = w;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  // The biggest type that fits the cell: the heading a third larger than the rest.
  let size = 120;
  let hl: string[] = [];
  let rl: string[] = [];
  const room = CELL_H - 110;
  for (; size > 24; size -= 4) {
    hl = lines(head, `700 ${Math.round(size * 1.3)}px Anton, Impact, "Arial Black", sans-serif`, CELL_W - 140);
    rl = rest ? lines(rest, `600 ${size}px Rajdhani, "Arial Narrow", sans-serif`, CELL_W - 140) : [];
    if (hl.length * size * 1.45 + rl.length * size * 1.1 + (rl.length ? size * 0.3 : 0) <= room) break;
  }
  const hh = size * 1.45;
  const rh = size * 1.1;
  const total = hl.length * hh + rl.length * rh + (rl.length ? size * 0.3 : 0);
  let y = y0 + CELL_H / 2 - total / 2;
  ctx.font = `700 ${Math.round(size * 1.3)}px Anton, Impact, "Arial Black", sans-serif`;
  ctx.fillStyle = look.head;
  for (const l of hl) {
    ctx.fillText(l, CELL_W / 2, y + hh / 2);
    y += hh;
  }
  y += size * 0.3;
  ctx.font = `600 ${size}px Rajdhani, "Arial Narrow", sans-serif`;
  ctx.fillStyle = look.ink;
  for (const l of rl) {
    ctx.fillText(l, CELL_W / 2, y + rh / 2);
    y += rh;
  }
}

/**
 * A plate (w by h) in its item's frame, `out` m in front of the face of a board tilted back by `lean` (rad) about its
 * middle at (0, y, z), facing +z; its uvs on its row of the atlas.
 */
function plateQuad(w: number, h: number, y: number, z: number, out: number, lean: number, row: number, rows: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h).translate(0, 0, out).rotateX(-lean).translate(0, y, z);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (row + 1 - uv.getY(i)) / rows);
  return g;
}

/** The frame of a viewpoint item (posts, boards, the telescope) in its own frame, vertex coloured. */
function frameGeometry(it: ViewpointItem, end: boolean, y2: number): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const wood = 0xe8e4da;
  switch (it.kind) {
    case 'plaque':
      b.add('post', box(0.14, 1.0, 0.14, 0, 0.5, 0), 0x3a3a36);
      b.add('plate', box(0.8, 0.44, 0.05, 0, 0, 0).rotateX(-0.6).translate(0, 1.02, 0.02), 0x2d2a24);
      break;
    case 'sign':
      for (const x of [-1.05, 1.05]) b.add('post', box(0.12, 1.95, 0.12, x, 0.975, -0.05), wood);
      b.add('board', box(2.4, 1.25, 0.06, 0, 1.3, 0), 0xffffff);
      break;
    case 'telescope':
      b.add('base', cyl(0.24, 0.28, 0.08, 10), 0x3b4a44);
      b.add('pedestal', cyl(0.07, 0.1, 1.05, 10, 0, 0.08, 0), 0x2f6b4f);
      b.add('head', box(0.5, 0.32, 0.42, 0, 1.3, 0), 0x2f6b4f);
      b.add('visor', box(0.56, 0.08, 0.3, 0, 1.48, 0.08), 0x2f6b4f, 0.85);
      for (const x of [-0.12, 0.12]) {
        b.add('lens', cyl(0.075, 0.075, 0.16, 10).rotateX(Math.PI / 2).translate(x, 1.32, 0.28), 0x1d2a33);
        b.add('eyepiece', cyl(0.045, 0.05, 0.08, 8).rotateX(Math.PI / 2).translate(x, 1.36, -0.25), 0x1d2a33);
      }
      break;
    case 'fence': {
      const len = Math.hypot(it.x2 - it.x, it.z2 - it.z);
      const dy = y2 - it.y;
      for (const x of end ? [0, len] : [0]) b.add('post', box(0.1, 1.0, 0.1, x, 0.5, 0).translate(0, x === 0 ? 0 : dy, 0), wood);
      for (const h of [0.45, 0.88]) b.add('rail', bar(new THREE.Vector3(0, h, 0), new THREE.Vector3(len, h + dy, 0), 0.035, 5), wood);
      break;
    }
  }
  return b.build(`viewpoint-${it.kind}`);
}

export class HillSign {
  private readonly letterMat: THREE.MeshStandardMaterial;

  constructor(view: CityView) {
    const world = view.world;
    const letters = hillSignLetters(world.layout.rises);
    const geos = letters.map(letterGeometry);
    // The uplights: one on the lawn in front of each word, tilted up at it; their housings go with the viewpoints'
    // frames, their lenses with the letters, which they light.
    const housings: THREE.BufferGeometry[] = [];
    for (const word of [letters.slice(0, 3), letters.slice(3)]) {
      const x = (word[0]!.x + word[word.length - 1]!.x) / 2;
      const z = word[0]!.z + UPLIGHT_OUT;
      const y = world.groundHeight(x, z);
      const tilt = new THREE.Matrix4().makeRotationX(0.75).setPosition(x, y + 0.35, z);
      const lamp = new ModelBuilder();
      lamp.add('housing', new THREE.BoxGeometry(0.7, 0.45, 0.4).applyMatrix4(tilt), 0x2b2d30);
      lamp.add('stand', box(0.12, 0.35, 0.12, x, y + 0.17, z), 0x2b2d30);
      housings.push(lamp.build('uplight'));
      const lens = new THREE.PlaneGeometry(0.58, 0.34).rotateX(Math.PI).translate(0, 0, -0.205).applyMatrix4(tilt);
      const uv = lens.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, LENS_V);
      geos.push(lens);
    }
    // White painted sheet metal; at night the uplights' wash glows warm up from the foot of each letter.
    this.letterMat = new THREE.MeshStandardMaterial({ color: 0xf3f1ea, roughness: 0.45, metalness: 0.15, emissive: UPLIGHT, emissiveMap: washTexture(), emissiveIntensity: 0 });
    view.add(mergeGeometries(geos, false)!, this.letterMat, { shadow: true, name: 'hill-sign', split: false });
    for (const g of geos) g.dispose();
    this.buildViewpoints(view, viewpoints(world), housings);
  }

  /** The plaques, the sign, the fences and the telescopes: their frames in one mesh, their plates in another. */
  private buildViewpoints(view: CityView, items: readonly ViewpointItem[], extra: THREE.BufferGeometry[]): void {
    const plates = items.filter((it): it is ViewpointItem & { kind: 'plaque' | 'sign' | 'telescope' } => it.kind !== 'fence');
    const keys = [...new Set(plates.map((it) => `${it.kind}|${it.text}`))];
    const [c, ctx] = canvas(CELL_W, CELL_H * keys.length);
    keys.forEach((k, row) => {
      const [kind, text] = k.split('|') as ['plaque' | 'sign' | 'telescope', string];
      drawPlate(ctx, row, kind, text);
    });
    const atlas = toTexture(c, true, false);
    const frames: THREE.BufferGeometry[] = [...extra];
    const faces: THREE.BufferGeometry[] = [];
    const world = view.world;
    const m = new THREE.Matrix4();
    for (const it of items) {
      const dir = it.kind === 'fence' ? Math.atan2(it.x2 - it.x, it.z2 - it.z) - Math.PI / 2 : it.rot;
      m.makeRotationY(dir).setPosition(it.x, it.y, it.z);
      const end = it.kind === 'fence' && !items.some((o) => o.kind === 'fence' && Math.abs(o.x - it.x2) < 1e-6 && Math.abs(o.z - it.z2) < 1e-6);
      const y2 = it.kind === 'fence' ? world.groundHeight(it.x2, it.z2) : it.y;
      frames.push(frameGeometry(it, end, y2).applyMatrix4(m));
      if (it.kind === 'fence') continue;
      const row = keys.indexOf(`${it.kind}|${it.text}`);
      const [w, h] = PLATE_SIZE[it.kind];
      // On the plaque's tilted plate, on the sign's board, and on the back of the telescope's head where the viewer stands.
      const plate =
        it.kind === 'plaque' ? plateQuad(w, h, 1.02, 0.02, 0.026, 0.6, row, keys.length)
        : it.kind === 'sign' ? plateQuad(w, h, 1.3, 0, 0.031, 0, row, keys.length)
        : plateQuad(w, h, 1.225, 0, 0.211, 0, row, keys.length).rotateY(Math.PI);
      faces.push(plate.applyMatrix4(m));
    }
    view.add(mergeGeometries(frames, false)!, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25 }), { shadow: true, name: 'viewpoints', split: false });
    for (const g of frames) g.dispose();
    view.add(mergeGeometries(faces, false)!, new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.55, metalness: 0.2 }), { name: 'viewpoint-plates', split: false });
    for (const g of faces) g.dispose();
  }

  /** Night factor 0..1: the uplights come on with the dark. */
  update(night: number): void {
    this.letterMat.emissiveIntensity = night * 2;
  }
}
