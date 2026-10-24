// Procedurally generated canvas textures: shared canvas helpers, marker sprites and the cloud noise.

import * as THREE from 'three';
import { Rng } from '../../core/rng';

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  // willReadFrequently: noise() reads pixels back with getImageData.
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

export function toTexture(c: HTMLCanvasElement, srgb = true, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export function noise(ctx: CanvasRenderingContext2D, w: number, h: number, rng: Rng, amount: number, size = 1): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      const n = (rng.next() - 0.5) * amount;
      for (let yy = 0; yy < size && y + yy < h; yy++) {
        for (let xx = 0; xx < size && x + xx < w; xx++) {
          const i = ((y + yy) * w + (x + xx)) * 4;
          d[i] = Math.max(0, Math.min(255, d[i]! + n));
          d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
          d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n));
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Tangent normals from a dedicated relief canvas, never from painted reflections or shadows.
 * Wrapped Sobel samples preserve tile boundaries; the green channel accounts for canvas Y
 * increasing downwards while the uploaded, flipped texture's V increases upwards.
 */
export function normalFromHeight(source: HTMLCanvasElement, strength: number): THREE.Texture {
  const w = source.width;
  const h = source.height;
  const heights = source.getContext('2d')!.getImageData(0, 0, w, h).data;
  const [c, ctx] = canvas(w, h);
  const image = ctx.createImageData(w, h);
  const sample = (x: number, y: number): number => heights[(((y + h) % h) * w + (x + w) % w) * 4]! / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = sample(x - 1, y - 1);
      const t = sample(x, y - 1);
      const tr = sample(x + 1, y - 1);
      const l = sample(x - 1, y);
      const r = sample(x + 1, y);
      const bl = sample(x - 1, y + 1);
      const b = sample(x, y + 1);
      const br = sample(x + 1, y + 1);
      const nx = -((tr - tl) + 2 * (r - l) + (br - bl)) * strength / 4;
      const ny = ((bl - tl) + 2 * (b - t) + (br - tr)) * strength / 4;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      image.data[i] = (nx * inv * 0.5 + 0.5) * 255;
      image.data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      image.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return toTexture(c, false);
}

/** Small icon textures for pickups and markers. */
export function glowTexture(): THREE.Texture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(c, true, false);
}

/** Vertical gradient used by marker beams (opaque at the bottom, fading up). */
export function beamTexture(): THREE.Texture {
  const [c, ctx] = canvas(4, 128);
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  return toTexture(c, true, false);
}

// ---------------------------------------------------------------------------
// Cloud noise: one tileable channel of gradient noise that the sky shader samples once per
// octave (a texture fetch is far cheaper than hashing four lattice gradients per octave).

/** Lattice cells across one tile of the cloud noise (each cell is CLOUD_NOISE_SIZE / CLOUD_NOISE_CELLS texels). */
export const CLOUD_NOISE_CELLS = 16;
export const CLOUD_NOISE_SIZE = 128;
/** Noise values v (within about ±0.71) are stored as 0.5 + v * CLOUD_NOISE_SCALE. */
export const CLOUD_NOISE_SCALE = 0.7;

/** The cloud noise texels (row-major, CLOUD_NOISE_SIZE square), deterministic. */
export function cloudNoiseData(): Uint8Array {
  const S = CLOUD_NOISE_SIZE;
  const C = CLOUD_NOISE_CELLS;
  const rng = new Rng(1717);
  const gx = new Float64Array(C * C);
  const gy = new Float64Array(C * C);
  for (let i = 0; i < C * C; i++) {
    const a = rng.next() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const dot = (ix: number, iy: number, fx: number, fy: number) => {
    const k = (((iy % C) + C) % C) * C + (((ix % C) + C) % C);
    return gx[k]! * fx + gy[k]! * fy;
  };
  const data = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Texel centres, in lattice units.
      const u = ((x + 0.5) / S) * C;
      const v = ((y + 0.5) / S) * C;
      const ix = Math.floor(u);
      const iy = Math.floor(v);
      const fx = u - ix;
      const fy = v - iy;
      const a = dot(ix, iy, fx, fy);
      const b = dot(ix + 1, iy, fx - 1, fy);
      const c = dot(ix, iy + 1, fx, fy - 1);
      const d = dot(ix + 1, iy + 1, fx - 1, fy - 1);
      const sx = fade(fx);
      const sy = fade(fy);
      const n = a + (b - a) * sx + (c + (d - c) * sx - (a + (b - a) * sx)) * sy;
      data[y * S + x] = Math.max(0, Math.min(255, Math.round((0.5 + n * CLOUD_NOISE_SCALE) * 255)));
    }
  }
  return data;
}

/** The cloud noise as a repeating, mipmapped single-channel texture. */
export function cloudNoiseTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(cloudNoiseData(), CLOUD_NOISE_SIZE, CLOUD_NOISE_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * The sky shader's fbm over the cloud noise, evaluated on the CPU (bilinear, full resolution):
 * octaves rotated and doubled each step, mean 0.5. Used to calibrate cloud cover.
 */
export function cloudFbm(data: Uint8Array, px: number, py: number, octaves: number): number {
  const S = CLOUD_NOISE_SIZE;
  const sample = (qx: number, qy: number) => {
    const tx = (qx / CLOUD_NOISE_CELLS) * S - 0.5;
    const ty = (qy / CLOUD_NOISE_CELLS) * S - 0.5;
    const x0 = Math.floor(tx);
    const y0 = Math.floor(ty);
    const fx = tx - x0;
    const fy = ty - y0;
    const at = (x: number, y: number) => data[(((y % S) + S) % S) * S + (((x % S) + S) % S)]! / 255;
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return (top * (1 - fy) + bot * fy - 0.5) / CLOUD_NOISE_SCALE;
  };
  let a = 0.5;
  let s = 0;
  let n = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * sample(px, py);
    n += a;
    const nx = 1.6 * px - 1.2 * py + 17.1;
    const ny = 1.2 * px + 1.6 * py + 9.3;
    px = nx;
    py = ny;
    a *= 0.5;
  }
  return 0.5 + s / n;
}
