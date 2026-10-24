// Procedurally generated canvas textures: text signs and billboards.

import * as THREE from 'three';
import { canvas, toTexture } from './misc';

/** Text sign texture (e.g. "HOSPITAL"). */
export function signTexture(text: string, color: string, bg = 'rgba(10,10,14,0.92)'): THREE.Texture {
  const [c, ctx] = canvas(1024, 192);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1024, 192);
  ctx.strokeStyle = color;
  ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, 1008, 176);
  ctx.font = '700 112px Anton, Impact, "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  let size = 112;
  while (ctx.measureText(text).width > 940 && size > 40) {
    size -= 6;
    ctx.font = `700 ${size}px Anton, Impact, "Arial Black", sans-serif`;
  }
  ctx.fillText(text, 512, 100);
  return toTexture(c, true, false);
}

const ADS: Array<{ title: string; tag: string; bg: [string, string]; fg: string }> = [
  { title: 'FIZZ-O', tag: 'The taste of bad decisions', bg: ['#ff3d6e', '#ffb03b'], fg: '#ffffff' },
  { title: 'AZURA AIR', tag: 'Fly away from your problems', bg: ['#1b6ff2', '#62d6ff'], fg: '#ffffff' },
  { title: 'SIZZLE BURGER', tag: 'Now with 40% more grease', bg: ['#ffcc00', '#ff6a00'], fg: '#3b1d00' },
  { title: 'NEON NIGHTS', tag: 'Casino & Resort · Ocean Beach', bg: ['#2b0a4f', '#c03ad9'], fg: '#7cf6ff' },
  { title: 'VOX MOBILE', tag: 'Hear everyone. Always.', bg: ['#0f2027', '#2c5364'], fg: '#a6ffcb' },
  { title: 'TURBO LUBE', tag: 'Go faster. Legally, mostly.', bg: ['#111111', '#444444'], fg: '#ff4040' },
];

export const AD_COUNT = ADS.length;

export function adTexture(index: number): THREE.Texture {
  const ad = ADS[index % ADS.length]!;
  const [c, ctx] = canvas(1024, 512);
  const g = ctx.createLinearGradient(0, 0, 1024, 512);
  g.addColorStop(0, ad.bg[0]);
  g.addColorStop(1, ad.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 512);
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(80 * i, 512 - ((i * 97) % 400), 40 + ((i * 37) % 80), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = ad.fg;
  ctx.textAlign = 'center';
  ctx.font = '700 150px Anton, Impact, "Arial Black", sans-serif';
  ctx.fillText(ad.title, 512, 260, 960);
  ctx.font = '600 52px Rajdhani, "Arial Narrow", sans-serif';
  ctx.fillText(ad.tag, 512, 360, 960);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 12;
  ctx.strokeRect(6, 6, 1012, 500);
  return toTexture(c, true, false);
}
