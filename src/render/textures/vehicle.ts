// Procedurally generated canvas textures: vehicle roof signs.

import * as THREE from 'three';
import { canvas, toTexture } from './misc';

export function taxiSignTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 64);
  ctx.fillStyle = '#f7d21c';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#111';
  ctx.font = '700 46px Anton, Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TAXI', 128, 34);
  return toTexture(c, true, false);
}
