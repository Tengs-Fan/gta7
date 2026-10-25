// Small tileable noise textures for the volume puffs and scorch decals, generated once from a fixed seed (no image
// files). DataTextures keep their bytes, so three uploads them again after a WebGL context loss.

import * as THREE from 'three';

/** Integer hash to 0..1. */
export function hash01(n: number): number {
  let x = Math.imul(n | 0, 0x27d4eb2d) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Tileable value noise of period `p` cells at (x, y) in cell units. */
function valueNoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number) => hash01((((i % p) + p) % p) + (((j % p) + p) % p) * 1013 + seed * 7919);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise in 0..1, tileable over the unit square. */
function fbm(s: number, t: number, base: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = base;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(s * p, t * p, p, seed + o) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/** Stretches noise around its mean for more contrast. */
function contrast(v: number, k: number): number {
  return Math.min(1, Math.max(0, 0.5 + (v - 0.5) * k));
}

let puffNoise: THREE.DataTexture | null = null;

/** R: billowy low-frequency fbm, G: finer fbm, B: ridged (flame tongues), A: another low fbm. Repeat-wrapped. */
export function puffNoiseTexture(): THREE.DataTexture {
  if (puffNoise) return puffNoise;
  const n = 128;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const s = x / n;
      const t = y / n;
      const o = (y * n + x) * 4;
      data[o] = Math.round(contrast(fbm(s, t, 4, 4, 11), 1.7) * 255);
      data[o + 1] = Math.round(contrast(fbm(s, t, 8, 3, 23), 1.6) * 255);
      data[o + 2] = Math.round((1 - Math.abs(fbm(s, t, 6, 3, 37) * 2 - 1)) ** 2 * 255);
      data[o + 3] = Math.round(contrast(fbm(s, t, 3, 3, 51), 1.6) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'fx-puff-noise';
  tex.needsUpdate = true;
  puffNoise = tex;
  return tex;
}

let scorchTex: THREE.DataTexture | null = null;

/**
 * A scorch mark: R the soot density (a dark charred core, a broken sooty rim with radial streaks), G a fine grain.
 * Its edge is fully clear, so a decal quad never shows a border.
 */
export function scorchTexture(): THREE.DataTexture {
  if (scorchTex) return scorchTex;
  const n = 128;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n - 0.5;
      const v = (y + 0.5) / n - 0.5;
      const r = Math.hypot(u, v) * 2;
      const a = Math.atan2(v, u);
      const blot = fbm((u + 0.5), (v + 0.5), 4, 4, 71);
      const streak = fbm(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, 16, 2, 83);
      const edge = 0.8 + (blot - 0.5) * 0.4 + (streak - 0.5) * 0.4;
      const core = 1 - smooth(0.0, 0.7, r);
      let d = (1 - smooth(edge - 0.32, edge, r)) * (0.72 + 0.28 * core);
      d *= 0.85 + 0.3 * fbm(u + 0.5, v + 0.5, 12, 3, 97) - 0.15;
      d = Math.min(1, Math.max(0, d * (1 - smooth(0.9, 1.0, r))));
      const o = (y * n + x) * 4;
      data[o] = Math.round(d * 255);
      data[o + 1] = Math.round(fbm(u + 0.5, v + 0.5, 32, 2, 101) * 255);
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'fx-scorch';
  tex.needsUpdate = true;
  scorchTex = tex;
  return tex;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
