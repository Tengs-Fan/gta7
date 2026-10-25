// The broadleaf canopy atlas: leaves cut from a scanned leaf set (albedo + opacity) and laid out, deterministically, as
// 2x2 tiles of 512 px: three open leaf sprays with alpha (the canopy's cards) and one dense, opaque leaf mass (the
// canopy's core). Output is one RGBA WebP; transparent texels carry the mean leaf colour so mipmaps do not darken edges.
import { sharp } from './pipeline.mjs';
import { srcPath } from './lib.mjs';

const WEBP = { quality: 86, alphaQuality: 92, effort: 6, smartSubsample: false };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Spans of rows/columns where `mask` has any texel set. */
function runs(profile) {
  const out = [];
  let start = -1;
  profile.forEach((v, i) => {
    if (v > 0 && start < 0) start = i;
    if (v === 0 && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, profile.length - 1]);
  return out.filter(([a, b]) => b - a > 40);
}

/** The leaves of the source as { x0, y0, w, h } boxes (stem down), from the opacity map's row and column runs. */
function leafBoxes(alpha, w, h) {
  const col = new Array(w).fill(0);
  const row = new Array(h).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > 128) {
    col[x]++;
    row[y]++;
  }
  const boxes = [];
  for (const [y0, y1] of runs(row)) for (const [x0, x1] of runs(col)) boxes.push({ x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  return boxes;
}

/**
 * Draws one leaf into `dst` (RGBA float, side `size`): its stem at (sx, sy), pointing along `angle` (radians, 0 = up the
 * image), `len` px from stem to tip; colour scaled by `tint` [r, g, b]. Alpha-over, bilinear.
 */
function stamp(dst, size, src, leaf, sx, sy, angle, len, tint) {
  const scale = leaf.h / len;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const half = len * Math.max(1, leaf.w / leaf.h) * 0.75;
  const cx = sx + s * len * 0.5;
  const cy = sy - c * len * 0.5;
  const minX = Math.max(0, Math.floor(cx - half));
  const maxX = Math.min(size - 1, Math.ceil(cx + half));
  const minY = Math.max(0, Math.floor(cy - half));
  const maxY = Math.min(size - 1, Math.ceil(cy + half));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // Into the leaf's frame: v up from the stem along the leaf, u across it.
      const dx = x + 0.5 - sx;
      const dy = y + 0.5 - sy;
      const v = dx * s - dy * c;
      const u = dx * c + dy * s;
      const lx = leaf.x0 + leaf.w / 2 + u * scale;
      const ly = leaf.y0 + leaf.h - v * scale;
      if (lx < leaf.x0 || ly < leaf.y0 || lx >= leaf.x0 + leaf.w - 1 || ly >= leaf.y0 + leaf.h - 1) continue;
      const ix = Math.floor(lx);
      const iy = Math.floor(ly);
      const fx = lx - ix;
      const fy = ly - iy;
      const sample = (ch) => {
        const at = (xx, yy) => src[ch][yy * src.w + xx];
        return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
      };
      const a = sample(3) / 255;
      if (a <= 0.003) continue;
      const o = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) dst[o + k] = dst[o + k] * (1 - a) + Math.min(255, sample(k) * tint[k]) * a;
      dst[o + 3] = dst[o + 3] * (1 - a) + 255 * a;
    }
  }
}

/** A dark twig from (x0, y0) to (x1, y1), `width` px wide at its base. */
function twig(dst, size, x0, y0, x1, y1, width) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  for (let t = 0; t <= len; t += 0.5) {
    const k = t / len;
    const x = x0 + (x1 - x0) * k;
    const y = y0 + (y1 - y0) * k;
    const r = Math.max(0.8, width * (1 - k * 0.7)) / 2;
    for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++) {
      for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
        if (xx < 0 || yy < 0 || xx >= size || yy >= size || Math.hypot(xx + 0.5 - x, yy + 0.5 - y) > r) continue;
        const o = (yy * size + xx) * 4;
        dst[o] = 74;
        dst[o + 1] = 58;
        dst[o + 2] = 40;
        dst[o + 3] = 255;
      }
    }
  }
}

export const LEAF_TILE = 512;

/** Builds the atlas; returns { buffer, width, height } (WebP with alpha). */
export async function buildLeafAtlas(def) {
  const color = await sharp(srcPath(def.maps.albedo)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const opacity = await sharp(srcPath(def.maps.opacity)).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = color.info.width;
  const h = color.info.height;
  const n = w * h;
  const src = { w, 0: new Float32Array(n), 1: new Float32Array(n), 2: new Float32Array(n), 3: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    src[0][i] = color.data[i * 3];
    src[1][i] = color.data[i * 3 + 1];
    src[2][i] = color.data[i * 3 + 2];
    src[3][i] = opacity.data[i];
  }
  const leaves = leafBoxes(opacity.data, w, h);
  if (leaves.length < 6) throw new Error(`${def.set}: found ${leaves.length} leaves in the source`);
  const T = LEAF_TILE;
  const size = T * 2;
  const tiles = [];
  const rng = mulberry32(def.seed ?? 2207);
  const tint = (dark) => {
    const b = (0.62 + rng() * 0.42) * dark;
    const warm = rng() * 0.14;
    return [b * (1.0 + warm), b * (1.03 + warm * 0.4), b * (0.86 - warm * 0.3)];
  };
  for (let k = 0; k < 4; k++) {
    const tile = new Float32Array(T * T * 4);
    if (k < 3) {
      // A spray: a forked twig across the tile with leaves along it, the lower ones darker.
      const ox = T * (0.5 + (rng() - 0.5) * 0.1);
      const oy = T * 0.97;
      const tips = [[T * 0.5, T * 0.1], [T * 0.16, T * 0.32], [T * 0.84, T * 0.3], [T * 0.3, T * 0.14], [T * 0.7, T * 0.16]];
      const branches = tips.map(([tx, ty]) => ({ x0: ox, y0: oy, x1: tx + (rng() - 0.5) * 40, y1: ty + (rng() - 0.5) * 30 }));
      for (const b of branches) twig(tile, T, b.x0, b.y0, b.x1, b.y1, 4.5);
      const count = 70 + k * 8;
      for (let i = 0; i < count; i++) {
        const b = branches[i % branches.length];
        const t = 0.25 + rng() * 0.78;
        const sx = b.x0 + (b.x1 - b.x0) * Math.min(1, t);
        const sy = b.y0 + (b.y1 - b.y0) * Math.min(1, t);
        const dir = Math.atan2(b.x1 - b.x0, -(b.y1 - b.y0));
        const angle = dir + (rng() < 0.5 ? -1 : 1) * (0.35 + rng() * 0.9);
        const len = 50 + rng() * 42;
        // Keep the whole leaf inside the tile, so neighbouring tiles never bleed in.
        const tipX = sx + Math.sin(angle) * len;
        const tipY = sy - Math.cos(angle) * len;
        const pad = len * 0.42;
        if (tipX < pad || tipX > T - pad || tipY < pad || tipY > T - pad || sx < 6 || sy > T - 6) continue;
        stamp(tile, T, src, leaves[Math.floor(rng() * leaves.length)], sx, sy, angle, len, tint(0.82 + t * 0.22));
      }
    } else {
      // The inner leaf mass: a dark, dense round clump with a leafy edge (no straight card edges show between sprays).
      const R = T * 0.34;
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (Math.hypot(x + 0.5 - T / 2, y + 0.5 - T / 2) < R) tile.set([44, 66, 30, 255], (y * T + x) * 4);
      for (let i = 0; i < 340; i++) {
        const a = rng() * Math.PI * 2;
        const d = Math.sqrt(rng()) * T * 0.36;
        const sx = T / 2 + Math.cos(a) * d;
        const sy = T / 2 + Math.sin(a) * d;
        const len = 48 + rng() * 40;
        const angle = rng() * Math.PI * 2;
        const tipX = sx + Math.sin(angle) * len;
        const tipY = sy - Math.cos(angle) * len;
        const pad = len * 0.42;
        if (tipX < pad || tipX > T - pad || tipY < pad || tipY > T - pad) continue;
        stamp(tile, T, src, leaves[Math.floor(rng() * leaves.length)], sx, sy, angle, len, tint(0.7 + rng() * 0.25));
      }
    }
    tiles.push(tile);
  }
  // Mean leaf colour, written under every transparent texel.
  let r = 0, g = 0, b = 0, m = 0;
  for (const tile of tiles.slice(0, 3)) for (let i = 0; i < T * T; i++) if (tile[i * 4 + 3] > 200) {
    r += tile[i * 4];
    g += tile[i * 4 + 1];
    b += tile[i * 4 + 2];
    m++;
  }
  const mean = [r / m, g / m, b / m];
  const out = Buffer.alloc(size * size * 4);
  tiles.forEach((tile, k) => {
    const tx = (k % 2) * T;
    const ty = Math.floor(k / 2) * T;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const i = (y * T + x) * 4;
        const o = ((ty + y) * size + tx + x) * 4;
        const a = tile[i + 3] / 255;
        for (let c = 0; c < 3; c++) out[o + c] = Math.round(a > 0 ? tile[i + c] / Math.max(a, 1e-3) * a + mean[c] * (1 - a) : mean[c]);
        out[o + 3] = Math.round(tile[i + 3]);
      }
    }
  });
  const buffer = await sharp(out, { raw: { width: size, height: size, channels: 4 } }).resize(def.size ?? size, def.size ?? size, { kernel: 'lanczos3' }).webp(WEBP).toBuffer();
  return { buffer, width: def.size ?? size, height: def.size ?? size };
}
