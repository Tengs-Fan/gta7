// Procedurally generated canvas textures: ground, road, water and helipad surfaces.

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { canvas, toTexture, noise, normalFromHeight } from './misc';

export type GroundTex = 'asphalt' | 'sidewalk' | 'grass' | 'sand' | 'dirt' | 'plaza' | 'wood' | 'concrete' | 'roof' | 'metal';

export function groundTexture(kind: GroundTex, seed = 1): THREE.Texture {
  const S = 256;
  const rng = new Rng(seed * 977 + kind.length * 131);
  const [c, ctx] = canvas(S, S);
  const fill = (col: string) => {
    ctx.fillStyle = col;
    ctx.fillRect(0, 0, S, S);
  };
  switch (kind) {
    case 'asphalt':
      fill('#3a3b3e');
      noise(ctx, S, S, rng, 26, 1);
      noise(ctx, S, S, rng, 12, 4);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        ctx.beginPath();
        ctx.ellipse(rng.range(0, S), rng.range(0, S), rng.range(10, 40), rng.range(5, 20), rng.range(0, 3), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'sidewalk':
      fill('#a9a59d');
      noise(ctx, S, S, rng, 14, 2);
      ctx.strokeStyle = 'rgba(60,55,50,0.45)';
      ctx.lineWidth = 2;
      for (let k = 0; k <= 4; k++) {
        ctx.beginPath();
        ctx.moveTo((k * S) / 4, 0);
        ctx.lineTo((k * S) / 4, S);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, (k * S) / 4);
        ctx.lineTo(S, (k * S) / 4);
        ctx.stroke();
      }
      break;
    case 'grass':
      fill('#4c7d34');
      noise(ctx, S, S, rng, 30, 1);
      noise(ctx, S, S, rng, 20, 8);
      break;
    case 'sand':
      fill('#dcc89a');
      noise(ctx, S, S, rng, 22, 1);
      noise(ctx, S, S, rng, 10, 8);
      break;
    case 'dirt':
      fill('#7d7160');
      noise(ctx, S, S, rng, 34, 1);
      noise(ctx, S, S, rng, 18, 6);
      break;
    case 'plaza': {
      fill('#bdb6a8');
      const t = S / 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const v = rng.range(-12, 12);
          ctx.fillStyle = `rgb(${189 + v},${182 + v},${168 + v})`;
          ctx.fillRect(x * t + 1, y * t + 1, t - 2, t - 2);
        }
      }
      noise(ctx, S, S, rng, 10, 1);
      break;
    }
    case 'wood':
      fill('#8a6a46');
      for (let y = 0; y < S; y += 16) {
        ctx.fillStyle = `rgba(0,0,0,${rng.range(0.05, 0.2)})`;
        ctx.fillRect(0, y, S, 16);
        ctx.fillStyle = 'rgba(30,20,10,0.6)';
        ctx.fillRect(0, y, S, 2);
      }
      noise(ctx, S, S, rng, 18, 1);
      break;
    case 'concrete':
      fill('#9a9890');
      noise(ctx, S, S, rng, 20, 1);
      noise(ctx, S, S, rng, 10, 8);
      break;
    case 'roof':
      fill('#6b6a66');
      noise(ctx, S, S, rng, 24, 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      for (let k = 0; k < S; k += 32) {
        ctx.beginPath();
        ctx.moveTo(k, 0);
        ctx.lineTo(k, S);
        ctx.stroke();
      }
      break;
    case 'metal':
      fill('#8c8f93');
      for (let x = 0; x < S; x += 8) {
        ctx.fillStyle = x % 16 === 0 ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.15)';
        ctx.fillRect(x, 0, 4, S);
      }
      noise(ctx, S, S, rng, 10, 1);
      break;
  }
  return toTexture(c);
}

export interface GroundSurfaceTextures {
  map: THREE.Texture;
  rough: THREE.Texture;
  normal: THREE.Texture;
}

/**
 * A matched material set for the existing ground tiles. Surface relief is separate from
 * albedo: asphalt stains do not become craters and coloured pavers keep level tops.
 * Roughness and normals are linear data; all maps share the colour tile's dimensions.
 */
export function groundSurface(kind: GroundTex, seed = 1): GroundSurfaceTextures {
  const S = 256;
  const rng = new Rng((seed * 977 + kind.length * 131) ^ 0x510e527f);
  const [ch, h] = canvas(S, S);
  const [cr, r] = canvas(S, S);
  const heights = h.createImageData(S, S);
  const roughness = r.createImageData(S, S);
  const settings: Record<GroundTex, { grain: number; rough: number; strength: number }> = {
    asphalt: { grain: 16, rough: 224, strength: 2.8 },
    sidewalk: { grain: 6, rough: 209, strength: 2.5 },
    grass: { grain: 21, rough: 239, strength: 2.2 },
    sand: { grain: 12, rough: 232, strength: 1.8 },
    dirt: { grain: 20, rough: 236, strength: 2.3 },
    plaza: { grain: 4, rough: 187, strength: 2.4 },
    wood: { grain: 5, rough: 202, strength: 2.6 },
    concrete: { grain: 9, rough: 215, strength: 2.2 },
    roof: { grain: 12, rough: 225, strength: 2.5 },
    metal: { grain: 2, rough: 149, strength: 2.1 },
  };
  const spec = settings[kind];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const grain = (rng.next() - 0.5) * spec.grain;
      let relief = 128 + grain;
      let rough = spec.rough + grain * 0.45 + (rng.next() - 0.5) * 7;
      if (kind === 'wood') {
        // Long, gently meandering fibres run along the planks, with whole cycles per tile.
        const fibre = Math.sin(y * Math.PI / 2 + Math.sin(x * Math.PI / 64) * 0.6);
        relief += fibre * 3;
        rough += fibre * 5;
      } else if (kind === 'sand') {
        relief += Math.sin(y * Math.PI / 16 + Math.sin(x * Math.PI / 64) * 0.5) * 3;
      } else if (kind === 'metal') {
        // The albedo alternates light and dark strips every eight pixels.
        relief += Math.cos(x * Math.PI / 8) * 18;
        rough += Math.sin(y * Math.PI / 2) * 3;
      }
      for (let channel = 0; channel < 3; channel++) {
        heights.data[i + channel] = relief;
        roughness.data[i + channel] = rough;
      }
      heights.data[i + 3] = 255;
      roughness.data[i + 3] = 255;
    }
  }
  h.putImageData(heights, 0, 0);
  r.putImageData(roughness, 0, 0);

  if (kind === 'sidewalk' || kind === 'plaza') {
    const step = kind === 'sidewalk' ? 64 : 32;
    // Match the painted expansion joints; a shallow bevel catches grazing sunlight.
    h.strokeStyle = '#717171';
    h.lineWidth = 4;
    for (let k = 0; k <= S; k += step) {
      h.beginPath();
      h.moveTo(k, 0);
      h.lineTo(k, S);
      h.moveTo(0, k);
      h.lineTo(S, k);
      h.stroke();
    }
    h.strokeStyle = '#595959';
    h.lineWidth = 2;
    r.strokeStyle = '#ececec';
    r.lineWidth = 2;
    for (let k = 0; k <= S; k += step) {
      for (const ctx of [h, r]) {
        ctx.beginPath();
        ctx.moveTo(k, 0);
        ctx.lineTo(k, S);
        ctx.moveTo(0, k);
        ctx.lineTo(S, k);
        ctx.stroke();
      }
    }
  } else if (kind === 'wood') {
    h.fillStyle = '#686868';
    r.fillStyle = '#eeeeee';
    for (let y = 0; y < S; y += 16) {
      h.fillRect(0, y, S, 2);
      r.fillRect(0, y, S, 2);
    }
  } else if (kind === 'roof') {
    h.fillStyle = '#6c6c6c';
    r.fillStyle = '#eeeeee';
    for (let x = 0; x < S; x += 32) {
      h.fillRect(x, 0, 1, S);
      r.fillRect(x, 0, 1, S);
    }
  } else if (kind === 'asphalt' || kind === 'concrete' || kind === 'dirt') {
    // Scattered aggregate is shallow and small enough to disappear naturally in mipmaps.
    const count = kind === 'asphalt' ? 1700 : kind === 'dirt' ? 950 : 450;
    for (let i = 0; i < count; i++) {
      const x = rng.int(0, S - 1);
      const y = rng.int(0, S - 1);
      const radius = rng.range(0.35, kind === 'dirt' ? 1.4 : 1.0);
      const level = rng.int(135, 153);
      h.fillStyle = `rgb(${level},${level},${level})`;
      h.beginPath();
      h.arc(x, y, radius, 0, Math.PI * 2);
      h.fill();
    }
  }
  return { map: groundTexture(kind, seed), rough: toTexture(cr, false), normal: normalFromHeight(ch, spec.strength) };
}

/** Side of the sea's ripple tile (px). */
export const WATER_TILE = 256;
/** Crest trains summed into the tile, their wave numbers (whole cycles per tile, so it repeats seamlessly) between these. */
const WATER_WAVES = 24;
const WATER_K_MIN = 4;
const WATER_K_MAX = 14;
/** RMS tilt (length of the unit normal's x, y) of the tile: as the round-2 tile's, so the ripples keep their contrast. */
export const WATER_TILT = 0.214;

/**
 * The sea's ripple tile as RGBA tangent-space normals (row-major, WATER_TILE square): crest trains in
 * every direction, their heights falling as 1 / |k| so that each carries about the same slope and none
 * dominates the tile (one train of the round-2 tile held 61% of its power, and showed as a lattice
 * where dozens of tiles fit on screen); no long waves, which the coarse mipmaps would keep. The sea
 * draws the tile twice, at two scales and angles (Environment), so its repeat does not line up.
 */
export function waterNormalData(): Uint8ClampedArray {
  const S = WATER_TILE;
  const rng = new Rng(99);
  const waves: Array<[number, number, number, number]> = [];
  while (waves.length < WATER_WAVES) {
    const kx = rng.int(-WATER_K_MAX, WATER_K_MAX);
    const ky = rng.int(-WATER_K_MAX, WATER_K_MAX);
    const k = Math.hypot(kx, ky);
    if (k < WATER_K_MIN || k > WATER_K_MAX) continue;
    if (waves.some(([x, y]) => (x === kx && y === ky) || (x === -kx && y === -ky))) continue;
    waves.push([kx, ky, rng.range(0, Math.PI * 2), rng.range(0.75, 1) / k]);
  }
  // Each train a sin(u(x) + v(y)), summed as sin u cos v + cos u sin v from per-column and per-row tables.
  const h = new Float32Array(S * S);
  const su = new Float64Array(S);
  const cu = new Float64Array(S);
  const sv = new Float64Array(S);
  const cv = new Float64Array(S);
  for (const [kx, ky, ph, a] of waves) {
    for (let i = 0; i < S; i++) {
      const u = ((kx * i) / S) * Math.PI * 2;
      const v = ((ky * i) / S) * Math.PI * 2 + ph;
      su[i] = Math.sin(u);
      cu[i] = Math.cos(u);
      sv[i] = Math.sin(v) * a;
      cv[i] = Math.cos(v) * a;
    }
    for (let y = 0; y < S; y++) {
      const s = sv[y]!;
      const c = cv[y]!;
      for (let x = 0; x < S; x++) h[y * S + x] = h[y * S + x]! + su[x]! * c + cu[x]! * s;
    }
  }
  const gx = new Float32Array(S * S);
  const gy = new Float32Array(S * S);
  const g2 = new Float32Array(S * S);
  let sum2 = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      gx[i] = h[y * S + ((x + 1) % S)]! - h[y * S + ((x - 1 + S) % S)]!;
      gy[i] = h[((y + 1) % S) * S + x]! - h[((y - 1 + S) % S) * S + x]!;
      g2[i] = gx[i]! * gx[i]! + gy[i]! * gy[i]!;
      sum2 += g2[i]!;
    }
  }
  // The slope scale that gives the tile its RMS tilt. Normalising the normals only lowers the tilt, so
  // it lies above the small-slope estimate (and well under 1.5 times it): bisection between the two.
  const tilt = (g: number): number => {
    let sum = 0;
    for (let i = 0; i < S * S; i++) {
      const q = g2[i]! * g * g;
      sum += q / (q + 1);
    }
    return Math.sqrt(sum / (S * S));
  };
  let lo = WATER_TILT / Math.sqrt(sum2 / (S * S));
  let hi = lo * 1.5;
  while (tilt(hi) < WATER_TILT) hi *= 2;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (tilt(mid) < WATER_TILT) lo = mid;
    else hi = mid;
  }
  const g = (lo + hi) / 2;
  const data = new Uint8ClampedArray(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const nx = -gx[i]! * g;
    const ny = -gy[i]! * g;
    const l = Math.sqrt(nx * nx + ny * ny + 1);
    data[i * 4] = ((nx / l) * 0.5 + 0.5) * 255;
    data[i * 4 + 1] = ((ny / l) * 0.5 + 0.5) * 255;
    data[i * 4 + 2] = ((1 / l) * 0.5 + 0.5) * 255;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** Tileable water normal map (waterNormalData). */
export function waterNormalTexture(): THREE.Texture {
  const S = WATER_TILE;
  const [c, ctx] = canvas(S, S);
  const img = ctx.createImageData(S, S);
  img.data.set(waterNormalData());
  ctx.putImageData(img, 0, 0);
  return toTexture(c, false);
}

/**
 * Rubber left on the road by a skidding tyre (white; the material colours it): opaque streaks along the strip (v),
 * broken by gaps, thinning to nothing at both long edges (u = 0 and 1).
 */
export function tyreMarkTexture(): THREE.Texture {
  const W = 32;
  const H = 128;
  const rng = new Rng(4242);
  const [c, ctx] = canvas(W, H);
  const img = ctx.createImageData(W, H);
  const streak = Array.from({ length: W }, () => rng.range(0.55, 1));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const edge = Math.min(1, Math.min(u, 1 - u) * 6);
      const gap = 0.75 + 0.25 * Math.sin((y / H) * Math.PI * 6 + x * 0.7);
      const a = Math.max(0, Math.min(1, streak[x]! * edge * gap * rng.range(0.85, 1)));
      const i = (y * W + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}
export function helipadTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#4a4d52';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#f2c230';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(128, 128, 104, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 150px Anton, Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('H', 128, 136);
  return toTexture(c, true, false);
}
