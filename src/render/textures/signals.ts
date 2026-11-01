// The traffic signals' LED atlas: the ten countdown digits, a signal lens and the walk heads' figure and hand, each an
// array of LEDs. Red carries the LEDs that light, green every LED of the element, so a quad drawn from it (props.ts
// litQuads) shows its lit LEDs in its colour over the faint grid of the rest.

import * as THREE from 'three';
import { canvas, toTexture } from './misc';

const W = 1024;
const H = 128;
/** A digit's cell (portrait) and the square cells after the ten digits. */
const DIGIT_W = 64;

/** The atlas's tiles: the digits 0 to 9 are tiles 0 to 9. */
export const SIGNAL_TILE = { lens: 10, walk: 11, hand: 12 } as const;

/** Each tile's rectangle in the texture (u, v, width, height), tile id order. */
export const SIGNAL_TILE_RECTS: ReadonlyArray<readonly [number, number, number, number]> = [
  ...Array.from({ length: 10 }, (_, d) => [(d * DIGIT_W) / W, 0, DIGIT_W / W, 1] as const),
  ...[0, 1, 2].map((k) => [(10 * DIGIT_W + k * H) / W, 0, H / W, 1] as const),
];

/** A digit's LEDs: 8 columns by 16 rows, its segments two LEDs thick, corners shared. */
const SEGMENTS: Readonly<Record<string, (c: number, r: number) => boolean>> = {
  a: (_c, r) => r <= 1,
  b: (c, r) => c >= 6 && r <= 8,
  c: (c, r) => c >= 6 && r >= 7,
  d: (_c, r) => r >= 14,
  e: (c, r) => c <= 1 && r >= 7,
  f: (c, r) => c <= 1 && r <= 8,
  g: (_c, r) => r === 7 || r === 8,
};
const DIGIT_SEGMENTS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];

/** Draws one LED: red and green when it lights, green alone when it is only part of the element. */
function led(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, lit: boolean): void {
  ctx.fillStyle = lit ? '#ffff00' : '#00ff00';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** A figure as LEDs: `draw` paints its silhouette in white on a cell, and only the LEDs of a 7 px grid inside it are kept. */
function figure(ctx: CanvasRenderingContext2D, x0: number, draw: (c: CanvasRenderingContext2D) => void): void {
  const [cell, c] = canvas(H, H);
  c.fillStyle = '#ffffff';
  c.strokeStyle = '#ffffff';
  c.lineCap = 'round';
  c.lineJoin = 'round';
  draw(c);
  // One path of every LED: each fill in destination-in keeps only what that fill covers.
  c.globalCompositeOperation = 'destination-in';
  c.fillStyle = '#ffffff';
  c.beginPath();
  for (let y = 4.5; y < H; y += 7) {
    for (let x = 4.5; x < H; x += 7) {
      c.moveTo(x + 2.9, y);
      c.arc(x, y, 2.9, 0, Math.PI * 2);
    }
  }
  c.fill();
  ctx.drawImage(cell, x0, 0);
}

/** The LED atlas (linear: its channels are masks). */
export function signalAtlas(): THREE.CanvasTexture {
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  // The digits, 6 x 7 px apart with an 8 px margin, so their mipmaps keep apart down to 8 px.
  DIGIT_SEGMENTS.forEach((on, d) => {
    for (let r = 0; r < 16; r++) {
      for (let col = 0; col < 8; col++) {
        const part = Object.keys(SEGMENTS).filter((s) => SEGMENTS[s]!(col, r));
        if (part.length === 0) continue;
        led(ctx, d * DIGIT_W + 8 + col * 6 + 3, 8 + r * 7 + 3.5, 2.7, part.some((s) => on.includes(s)));
      }
    }
  });
  // The lens: a disc lit between its LEDs too (a lit lens reads as one at a distance), hex-packed LEDs over it.
  const lx = SIGNAL_TILE_RECTS[SIGNAL_TILE.lens]![0] * W + H / 2;
  ctx.fillStyle = '#8c0000';
  ctx.beginPath();
  ctx.arc(lx, H / 2, 61, 0, Math.PI * 2);
  ctx.fill();
  for (let row = -7; row <= 7; row++) {
    const y = H / 2 + row * 7.8;
    for (let k = -8; k <= 8; k++) {
      const x = lx + (k + (row % 2 === 0 ? 0 : 0.5)) * 9;
      if (Math.hypot(x - lx, y - H / 2) <= 57) led(ctx, x, y, 3.6, true);
    }
  }
  // The walking figure, mid-stride.
  figure(ctx, SIGNAL_TILE_RECTS[SIGNAL_TILE.walk]![0] * W, (f) => {
    f.beginPath();
    f.arc(60, 20, 11, 0, Math.PI * 2);
    f.fill();
    f.lineWidth = 15;
    f.beginPath();
    f.moveTo(62, 38);
    f.lineTo(66, 72);
    f.stroke();
    f.lineWidth = 11;
    for (const [a, b, e] of [[[62, 42], [44, 58], [36, 74]], [[62, 42], [80, 56], [92, 66]], [[66, 72], [50, 94], [38, 118]], [[66, 72], [80, 96], [94, 116]]] as const) {
      f.beginPath();
      f.moveTo(a[0], a[1]);
      f.lineTo(b[0], b[1]);
      f.lineTo(e[0], e[1]);
      f.stroke();
    }
  });
  // The raised hand: a palm, four fingers and the thumb.
  figure(ctx, SIGNAL_TILE_RECTS[SIGNAL_TILE.hand]![0] * W, (f) => {
    f.beginPath();
    f.roundRect(34, 54, 58, 62, 16);
    f.fill();
    f.lineWidth = 13;
    for (const [x, top] of [[40, 22], [56, 12], [72, 14], [87, 26]] as const) {
      f.beginPath();
      f.moveTo(x, 70);
      f.lineTo(x, top);
      f.stroke();
    }
    f.beginPath();
    f.moveTo(38, 92);
    f.lineTo(18, 64);
    f.stroke();
  });
  const t = toTexture(c, false, false);
  t.name = 'signal-atlas';
  return t;
}

/**
 * A signal lens's halo (props.ts SIGNAL_HALO): a ring of glow round a hollow middle the lens fills, so the halo adds
 * light round a lit lens without paling its own colour.
 */
export function signalGlowTexture(): THREE.CanvasTexture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.24, 'rgba(255,255,255,0)');
  g.addColorStop(0.32, 'rgba(255,255,255,0.8)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(c, true, false);
}
