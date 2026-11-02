// The roadside furniture that breaks (world/country/oddities.ts ROADSIDE; PropsView draws it as one instanced batch): six
// mailboxes of six makes, a fish among them, and three hand-painted signs, each on its post, its front towards +z. Every
// shape is a part of one geometry, tagged with its index in the vertex attribute `aShape`; each instance names the shape it is
// in `aPick`, and the material's vertex shader sends the vertices of every other shape off the screen. So all the roadside
// is one draw, however many of them stand, and a knocked-over one falls with its instance (PropsView.breakProp).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../../core/rng';
import { ROADSIDE, SIGN_TEXT } from '../../world/country/oddities';
import { Atlas } from '../city/attractions';
import { bar, box, cyl, ModelBuilder } from '../furniture';
import { toTexture } from '../textures/misc';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function ball(r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, seg = 10): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1)).scale(sx, sy, sz).translate(x, y, z);
}

function slab(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).rotateX(rx).rotateY(ry).rotateZ(rz).translate(x, y, z);
}

/** The signs' boards, in metres: each as wide and tall as the part of its band it is painted on (painted()). */
const BOARDS: Readonly<Record<number, readonly [number, number]>> = { 6: [1.2, 0.85], 7: [1.2, 0.85], 8: [1.7, 1.0] };
/** The part of each band the board takes, across, and its band's height in px (the board's aspect at 512 px). */
const U_RANGE = [0.25, 0.75] as const;
const WOOD = 0x7a5a3a;

/** Every uv of `g` on the atlas's white strip, `v` up it. */
function setWhite(g: THREE.BufferGeometry, v: number): void {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, v);
}

/** The mailbox of make 0 and 5 (grey with a red flag, rusty with a yellow one): a box under an arched lid on its post. */
function plainBox(b: ModelBuilder, body: number, flag: number, shade = 1): void {
  b.add('post', box(0.09, 1.02, 0.09, 0, 0.51, 0), WOOD);
  b.add('box', box(0.22, 0.14, 0.5, 0, 1.09, 0), body, shade);
  b.add('lid', new THREE.CylinderGeometry(0.11, 0.11, 0.5, 10, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).translate(0, 1.16, 0), body, shade * 1.05);
  b.add('door', box(0.2, 0.2, 0.012, 0, 1.15, 0.255), 0x3a3d40);
  b.add('flag', box(0.015, 0.22, 0.05, 0.125, 1.22, -0.1), flag);
}

/** The fish: a blue-silver bass with its mouth open for the post, a tail fin and a dorsal, a white eye with a black pupil, a flag. */
function fish(b: ModelBuilder): void {
  b.add('post', box(0.09, 1.0, 0.09, 0, 0.5, -0.05), WOOD);
  b.add('body', ball(0.2, 0, 1.2, 0, 0.7, 0.85, 2.0, 12), 0x4a87b6);
  b.add('back', ball(0.2, 0, 1.25, -0.02, 0.62, 0.55, 1.85, 12), 0x2f5c84);
  b.add('belly', ball(0.17, 0, 1.12, 0.03, 0.55, 0.5, 1.6, 10), 0xdde8ee);
  for (const s of [-1, 1]) b.add('tail', slab(0.03, 0.34, 0.2, 0, 1.2 + s * 0.12, -0.44, s * 0.55), 0x36698f);
  b.add('dorsal', slab(0.03, 0.2, 0.3, 0, 1.4, -0.06, -0.45), 0x2a5273);
  for (const s of [-1, 1]) b.add('fin', slab(0.2, 0.03, 0.14, s * 0.17, 1.14, 0.1, 0, s * 0.5, s * 0.3), 0x36698f);
  b.add('mouth', ball(0.075, 0, 1.17, 0.375, 1, 0.8, 0.35, 8), 0x120808);
  b.add('lips', new THREE.TorusGeometry(0.08, 0.02, 5, 10).scale(1, 0.8, 1).translate(0, 1.17, 0.37), 0xc4423a);
  for (const s of [-1, 1]) {
    b.add('eye', ball(0.045, s * 0.1, 1.27, 0.24, 1, 1, 0.6, 8), 0xf4f4ee);
    b.add('pupil', ball(0.024, s * 0.112, 1.27, 0.26, 1, 1, 0.6, 6), 0x0a0a0a);
  }
  b.add('flag', box(0.015, 0.2, 0.05, 0.13, 1.3, -0.12), 0xd03a2a);
}

/** The barn: a red box with a white X on its door, a gable roof of tin, a hay loft over it, a yellow flag. */
function barn(b: ModelBuilder): void {
  b.add('post', box(0.09, 0.95, 0.09, 0, 0.475, 0), WOOD);
  b.add('walls', box(0.32, 0.26, 0.5, 0, 1.1, 0), 0xa8321f);
  for (const s of [-1, 1]) b.add('roof', slab(0.22, 0.03, 0.56, s * 0.1, 1.3, 0, 0, 0, -s * 0.72), 0x5b6066);
  b.add('gable', box(0.2, 0.1, 0.012, 0, 1.3, 0.255), 0xa8321f, 0.9);
  b.add('door', box(0.2, 0.16, 0.012, 0, 1.06, 0.256), 0x6e2216);
  for (const s of [-1, 1]) b.add('brace', slab(0.012, 0.22, 0.01, 0, 1.06, 0.262, 0, 0, s * 0.72), 0xf2eee2);
  b.add('flag', box(0.015, 0.2, 0.05, 0.175, 1.2, -0.1), 0xf0c030);
}

/** The milk churn: a steel can with a shoulder, a lid and two handles, a slot cut in its side for the post. */
function churn(b: ModelBuilder): void {
  b.add('post', box(0.09, 0.92, 0.09, 0, 0.46, 0), WOOD);
  b.add('can', cyl(0.14, 0.16, 0.42, 12, 0, 0.92, 0), 0xaab1b8);
  b.add('band', cyl(0.145, 0.145, 0.05, 12, 0, 1.08, 0), 0xc4262e);
  b.add('shoulder', cyl(0.085, 0.14, 0.09, 12, 0, 1.34, 0), 0xaab1b8);
  b.add('neck', cyl(0.085, 0.085, 0.07, 12, 0, 1.43, 0), 0xa0a7ae);
  b.add('lid', cyl(0.11, 0.1, 0.04, 12, 0, 1.5, 0), 0x3a3d40);
  for (const s of [-1, 1]) b.add('handle', new THREE.TorusGeometry(0.05, 0.012, 5, 8, Math.PI).rotateZ(s > 0 ? -Math.PI / 2 : Math.PI / 2).translate(s * 0.15, 1.28, 0), 0x8a9096);
  b.add('slot', box(0.14, 0.04, 0.02, 0, 1.2, 0.152), 0x15171a);
  b.add('flag', box(0.015, 0.2, 0.05, 0.17, 1.2, 0.0), 0xd03a2a);
}

/** The birdhouse: a box of pale wood under a red-brown gable, a round hole with a perch under it, a painted flower. */
function birdhouse(b: ModelBuilder): void {
  b.add('post', box(0.09, 1.0, 0.09, 0, 0.5, 0), WOOD);
  b.add('house', box(0.3, 0.3, 0.3, 0, 1.18, 0), 0xc3935e);
  for (const s of [-1, 1]) b.add('roof', slab(0.24, 0.03, 0.36, s * 0.11, 1.4, 0, 0, 0, -s * 0.8), 0x7a3b2a);
  b.add('hole', ball(0.06, 0, 1.22, 0.152, 1, 1, 0.15, 8), 0x111010);
  b.add('perch', bar(v3(0, 1.1, 0.15), v3(0, 1.1, 0.24), 0.013, 4), 0x5a3a22);
  b.add('stem', box(0.01, 0.07, 0.01, -0.09, 1.1, 0.152), 0x3f7a3a);
  b.add('flower', ball(0.028, -0.09, 1.15, 0.153, 1, 1, 0.3, 6), 0xf0c030);
  b.add('flag', box(0.015, 0.2, 0.05, 0.17, 1.15, -0.1), 0xd03a2a);
}

/** A hand-painted sign: two posts and a plank board (on the atlas's white strip at `white`) round `face`, to +z, tipped a little as a board nailed up by hand is. */
function sign(shape: number, face: THREE.BufferGeometry, white: number): THREE.BufferGeometry {
  const [w, h] = BOARDS[shape]!;
  const b = new ModelBuilder();
  for (const s of [-1, 1]) b.add('post', box(0.08, 1.6 + 0.4, 0.08, s * (w / 2 - 0.1), 1.0, -0.05), WOOD);
  b.add('board', box(w + 0.04, h + 0.04, 0.05, 0, 1.0 + 0.45, -0.025), 0x8a6a45);
  b.add('stay', box(0.06, 0.06, 0.04, 0, 1.0 + 0.45 - h / 2 - 0.02, -0.05), WOOD);
  const frame = b.build('sign-frame');
  setWhite(frame, white);
  const g = mergeGeometries([frame, face], false)!;
  frame.dispose();
  face.dispose();
  return g.rotateZ(0.025);
}

/** The shapes by index in ROADSIDE: what draws each one except the signs' painted faces. */
const MAKE: ReadonlyArray<(b: ModelBuilder) => void> = [
  (b) => plainBox(b, 0x8d9298, 0xc4262e),
  fish,
  barn,
  churn,
  birdhouse,
  (b) => plainBox(b, 0x8a4a2a, 0xe0b32a, 0.85),
];

/** The roadside atlas: one white strip (everything that is not a board's face samples it), then each sign's band. */
export function roadsideAtlas(): { texture: THREE.Texture; blank: [number, number]; bands: Record<number, [number, number]> } {
  const atlas = new Atlas(1536);
  const blank = atlas.band(8, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1024, 8);
  });
  const bands: Record<number, [number, number]> = {};
  const [x0, x1] = [U_RANGE[0] * 1024, U_RANGE[1] * 1024];
  for (const [shape, [w, h]] of Object.entries(BOARDS)) {
    const k = Number(shape);
    const bandH = Math.round(((x1 - x0) * h) / w);
    bands[k] = atlas.band(bandH, (ctx) => paintSign(ctx, k, x0, x1, bandH));
  }
  return { texture: toTexture(atlas.canvas, true, false), blank, bands };
}

/**
 * A sign's face, painted by hand: a board stained pale, its two lines of letters brushed on one at a time, each a little
 * off the line and the last ones squeezed to fit, a drip under some.
 */
function paintSign(ctx: CanvasRenderingContext2D, shape: number, x0: number, x1: number, h: number): void {
  const rng = new Rng(4400 + shape);
  const bg = shape === 8 ? '#e9c93a' : shape === 6 ? '#f2ecd8' : '#f0d27a';
  const ink = shape === 8 ? '#1b1b1b' : shape === 6 ? '#b3261e' : '#4a2c12';
  ctx.fillStyle = bg;
  ctx.fillRect(x0, 0, x1 - x0, h);
  // The grain of the plank, and a border brushed round it.
  ctx.strokeStyle = 'rgba(90,60,20,0.18)';
  ctx.lineWidth = 2;
  for (let y = 10; y < h; y += 14 + rng.int(0, 8)) {
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.bezierCurveTo(x0 + 140, y + rng.range(-4, 4), x0 + 360, y + rng.range(-5, 5), x1, y + rng.range(-3, 3));
    ctx.stroke();
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = 9;
  ctx.strokeRect(x0 + 10, 10, x1 - x0 - 20, h - 20);
  const lines = SIGN_TEXT[shape]!;
  const sizes = shape === 8 ? [120, 54] : [140, lines[1]!.length > 6 ? 62 : 140];
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;
  let y = (h - sizes.reduce((s, n) => s + n * 1.1, 0)) / 2;
  lines.forEach((text, i) => {
    let px = sizes[i]!;
    ctx.font = `700 ${px}px Anton, Impact, "Arial Black", sans-serif`;
    while (ctx.measureText(text).width > (x1 - x0) * 0.86 && px > 18) {
      px -= 4;
      ctx.font = `700 ${px}px Anton, Impact, "Arial Black", sans-serif`;
    }
    // One letter at a time, each its own height and slant.
    const widths = [...text].map((c) => ctx.measureText(c).width);
    let x = (x0 + x1) / 2 - widths.reduce((s, n) => s + n, 0) / 2;
    ctx.textAlign = 'left';
    for (const [k, c] of [...text].entries()) {
      ctx.save();
      ctx.translate(x, y + (px * 1.1) / 2 + rng.range(-3, 3));
      ctx.rotate(rng.range(-0.07, 0.07));
      ctx.fillText(c, 0, 0);
      ctx.restore();
      x += widths[k]!;
    }
    // A drip or two of paint under a letter.
    ctx.fillRect(x - widths.length * 4 - rng.range(0, 60), y + px * 1.05, 3, rng.range(6, 16));
    y += px * 1.1;
  });
  // The little pictures a sign painter adds: two eggs, a bee.
  ctx.fillStyle = ink;
  if (shape === 6) {
    ctx.beginPath();
    ctx.ellipse(x0 + 62, h - 52, 22, 28, 0, 0, Math.PI * 2);
    ctx.ellipse(x1 - 62, h - 52, 22, 28, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (shape === 7) {
    ctx.fillStyle = '#e0a420';
    ctx.beginPath();
    ctx.ellipse(x1 - 70, h - 58, 30, 20, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ink;
    for (const dx of [-12, 0, 12]) ctx.fillRect(x1 - 70 + dx - 3, h - 76, 5, 36);
  }
}

/**
 * The roadside geometry: every shape of ROADSIDE in one, `aShape` its index on each of its vertices (and `aPick`, the instance's
 * own, left to the caller: see PropsView.buildRoadside). Boards' faces are painted on `bands` of the atlas and the rest of it
 * samples the atlas's white strip.
 */
export function roadsideGeometry(blank: [number, number], bands: Record<number, [number, number]>): THREE.BufferGeometry {
  const white = (blank[0] + blank[1]) / 2;
  const shapes = ROADSIDE.map((_, k) => {
    let g: THREE.BufferGeometry;
    if (k < MAKE.length) {
      const b = new ModelBuilder();
      MAKE[k]!(b);
      g = b.build(ROADSIDE[k]!.name);
      setWhite(g, white);
    } else {
      const [w, h] = BOARDS[k]!;
      const band = bands[k]!;
      const plane = new THREE.PlaneGeometry(w, h).translate(0, 1.0 + 0.45, 0.003);
      const uv = plane.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, U_RANGE[0] + (U_RANGE[1] - U_RANGE[0]) * uv.getX(i), band[0] + (band[1] - band[0]) * uv.getY(i));
      g = sign(k, new ModelBuilder().add('face', plane, 0xffffff).build('sign-face'), white);
    }
    g.setAttribute('aShape', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(k), 1));
    return g;
  });
  const geo = mergeGeometries(shapes, false)!;
  for (const g of shapes) g.dispose();
  geo.name = 'roadside';
  return geo;
}

