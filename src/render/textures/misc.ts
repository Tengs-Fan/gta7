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

/** A white texture whose alpha is `profile(u)`, u the distance from its centre over its half size (none past 1). */
export function radialTexture(profile: (u: number) => number, size = 128): THREE.Texture {
  const [c, ctx] = canvas(size, size);
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = u < 1 ? Math.round(255 * profile(u)) : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, false, false);
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
// Bark: a tileable relief of plates between vertical furrows, broken now and then across, as an albedo and a normal
// map built in plain arithmetic (no canvas: the trunks draw the same in Node tests, under ?assets=0 and on any tier).

/** Texels of the bark tile: across (once round a trunk's half) and up. */
export const BARK_SIZE = [128, 256] as const;

/** A value noise on a lattice of `px` by `py` cells that wraps at the tile's edges (x, y in 0..1). */
function wrapNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const h = (i: number, j: number) => {
    const a = Math.sin((((i % px) + px) % px) * 127.1 + (((j % py) + py) % py) * 311.7 + seed * 74.7) * 43758.5453;
    return a - Math.floor(a);
  };
  const u = x * px, v = y * py;
  const i = Math.floor(u), j = Math.floor(v);
  const fx = u - i, fy = v - j;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const top = h(i, j) + (h(i + 1, j) - h(i, j)) * sx;
  const bot = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * sx;
  return top + (bot - top) * sy;
}

/** The bark's height (0 deep in a furrow, 1 on a plate) at (x, y) in the tile. */
export function barkHeight(x: number, y: number): number {
  // Furrows wander: their line is pushed sideways by a slow noise along the trunk.
  const warp = (wrapNoise(x, y, 4, 3, 1) - 0.5) * 0.22 + (wrapNoise(x, y, 8, 9, 2) - 0.5) * 0.06;
  const across = Math.abs(Math.sin(Math.PI * ((x + warp) * 6 + (wrapNoise(x, y, 6, 2, 3) - 0.5) * 0.8)));
  const furrow = Math.min(1, Math.max(0, (across - 0.12) / 0.4));
  // Cracks across a plate, about four per tile, not every one through.
  const crack = Math.abs(Math.sin(Math.PI * (y * 5 + (wrapNoise(x, y, 6, 5, 4) - 0.5) * 1.6)));
  const broken = wrapNoise(x, y, 6, 5, 5) > 0.45 ? Math.min(1, crack / 0.18) : 1;
  const grain = wrapNoise(x, y, 32, 48, 6);
  return furrow * (0.55 + 0.45 * broken) * (0.82 + 0.18 * grain);
}

let bark: { map: THREE.DataTexture; normalMap: THREE.DataTexture } | null = null;

/**
 * The broadleaf trunks' bark (sRGB albedo and tangent-space normals), shared by every trunk: grey-brown plates, dark
 * furrows, lichen in patches. One tile spans half a trunk's girth and about a metre of its height.
 */
export function barkTextures(): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  if (bark) return bark;
  const [W, H] = BARK_SIZE;
  const height = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) height[y * W + x] = barkHeight((x + 0.5) / W, (y + 0.5) / H);
  const albedo = new Uint8Array(W * H * 4);
  const normal = new Uint8Array(W * H * 4);
  const at = (x: number, y: number) => height[(((y + H) % H) * W) + ((x + W) % W)]!;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const h = at(x, y);
      const u = (x + 0.5) / W, v = (y + 0.5) / H;
      const tone = 0.85 + 0.3 * wrapNoise(u, v, 5, 7, 7);
      const lichen = Math.max(0, wrapNoise(u, v, 7, 9, 8) - 0.62) * 2.2 * h;
      const k = (0.36 + 0.64 * h) * tone;
      const i = (y * W + x) * 4;
      albedo[i] = Math.min(255, (118 * k + 40 * lichen) | 0);
      albedo[i + 1] = Math.min(255, (104 * k + 58 * lichen) | 0);
      albedo[i + 2] = Math.min(255, (88 * k + 30 * lichen) | 0);
      albedo[i + 3] = 255;
      // Sobel over the wrapped tile; the strength is the plates' relief over the texel's size.
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const nx = -dx * 0.9, ny = -dy * 0.9;
      const inv = 1 / Math.hypot(nx, ny, 1);
      normal[i] = (nx * inv * 0.5 + 0.5) * 255;
      normal[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      normal[i + 2] = (inv * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;
    }
  }
  const texture = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  bark = { map: texture(albedo, true), normalMap: texture(normal, false) };
  return bark;
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
