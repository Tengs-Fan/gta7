// Procedural canvas textures for vehicles: cracked and shattered window glass.

import * as THREE from 'three';
import { Rng } from '../core/rng';

/** The window tint (sRGB), shared with the intact glass material's colour. */
export const GLASS_TINT = 0x1b2733;

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

/** A jagged crack from (x, y) heading `a`, `len` pixels long, possibly forking. */
function crack(ctx: CanvasRenderingContext2D, rng: Rng, x: number, y: number, a: number, len: number, width: number, depth: number): void {
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  let px = x;
  let py = y;
  let left = len;
  while (left > 0) {
    const step = Math.min(left, rng.range(6, 16));
    a += rng.range(-0.35, 0.35);
    px += Math.cos(a) * step;
    py += Math.sin(a) * step;
    ctx.lineTo(px, py);
    left -= step;
    if (depth > 0 && rng.chance(0.12)) {
      ctx.stroke();
      crack(ctx, rng, px, py, a + rng.range(0.5, 1.1) * (rng.chance(0.5) ? 1 : -1), left * rng.range(0.3, 0.6), Math.max(0.6, width * 0.7), depth - 1);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(px, py);
    }
  }
  ctx.stroke();
}

/**
 * Tiling window glass with cracks: the tint where the glass is whole and pale lines where it broke. `heavy` is a
 * shattered pane: dense spider webs with concentric rings and a frosted haze. The material's opacity applies on top.
 */
export function crackedGlassTexture(heavy: boolean): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  const rng = new Rng(heavy ? 913 : 377);
  const tint = `#${GLASS_TINT.toString(16).padStart(6, '0')}`;
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, S, S);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const webs = heavy ? 4 : 2;
  for (let w = 0; w < webs; w++) {
    const cx = rng.range(0.15, 0.85) * S;
    const cy = rng.range(0.15, 0.85) * S;
    const rays = heavy ? rng.int(9, 13) : rng.int(5, 8);
    ctx.strokeStyle = heavy ? 'rgba(214,226,236,0.95)' : 'rgba(196,212,226,0.9)';
    for (let k = 0; k < rays; k++) {
      const a = (k / rays) * Math.PI * 2 + rng.range(-0.25, 0.25);
      crack(ctx, rng, cx, cy, a, rng.range(heavy ? 70 : 40, heavy ? 150 : 110), heavy ? 1.6 : 1.2, heavy ? 2 : 1);
    }
    // Concentric breaks around the point of impact.
    const rings = heavy ? 3 : 1;
    for (let r = 0; r < rings; r++) {
      const rad = rng.range(8, 18) * (r + 1);
      ctx.lineWidth = heavy ? 1.2 : 0.9;
      ctx.beginPath();
      for (let k = 0; k <= 14; k++) {
        const a = (k / 14) * Math.PI * 2;
        const rr = rad * rng.range(0.8, 1.2);
        if (k === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      ctx.stroke();
    }
    if (heavy) {
      // Pulverised glass around the impact turns milky.
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 34);
      g.addColorStop(0, 'rgba(205,218,230,0.55)');
      g.addColorStop(1, 'rgba(205,218,230,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - 34, cy - 34, 68, 68);
    }
  }
  // Long stray cracks across the pane.
  ctx.strokeStyle = 'rgba(190,206,220,0.8)';
  for (let k = 0; k < (heavy ? 6 : 3); k++) crack(ctx, rng, rng.range(0, S), rng.range(0, S), rng.range(0, Math.PI * 2), rng.range(60, 160), 0.9, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  // Glass uvs are in metres: one crack pattern every 1.2 m.
  t.repeat.set(1 / 1.2, 1 / 1.2);
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
