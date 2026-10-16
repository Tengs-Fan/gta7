// Procedurally generated canvas textures. Nothing is loaded from disk.

import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { FacadeStyle } from '../world/layout';

export const FACADE_COLS = 8;
export const FACADE_ROWS = 8;

/** Physical size of one window cell (metres) per facade style. */
export const FACADE_CELL: Record<FacadeStyle, { w: number; h: number }> = {
  glassBlue: { w: 3.2, h: 3.8 },
  glassTeal: { w: 3.2, h: 3.8 },
  office: { w: 3.4, h: 3.7 },
  brick: { w: 3.0, h: 3.3 },
  stucco: { w: 3.2, h: 3.1 },
  house: { w: 3.6, h: 3.0 },
  warehouse: { w: 5.0, h: 4.0 },
  hotel: { w: 3.3, h: 3.2 },
};

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  // willReadFrequently: noise() reads pixels back with getImageData.
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function toTexture(c: HTMLCanvasElement, srgb = true, repeat = true): THREE.CanvasTexture {
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

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, rng: Rng, amount: number, size = 1): void {
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

export interface FacadeTextures {
  map: THREE.Texture;
  emissive: THREE.Texture;
  rough: THREE.Texture;
}

/** Window grid facade textures: colour, lit-window emissive mask and roughness. */
export function facadeTextures(style: FacadeStyle, seed: number): FacadeTextures {
  const S = 512;
  const cell = S / FACADE_COLS;
  const rng = new Rng(seed);
  const [cm, m] = canvas(S, S);
  const [ce, e] = canvas(S, S);
  const [cr, r] = canvas(S, S);
  e.fillStyle = '#000';
  e.fillRect(0, 0, S, S);

  const wall: Record<FacadeStyle, string> = {
    glassBlue: '#3a4756',
    glassTeal: '#2f4645',
    office: '#cdbb98',
    brick: '#8d3d2c',
    stucco: '#e8dcc4',
    house: '#efe5d6',
    warehouse: '#8f9aa5',
    hotel: '#f1efe9',
  };
  m.fillStyle = wall[style];
  m.fillRect(0, 0, S, S);
  r.fillStyle = '#e0e0e0';
  r.fillRect(0, 0, S, S);

  if (style === 'brick') {
    // Brick courses.
    m.strokeStyle = 'rgba(40,20,15,0.35)';
    m.lineWidth = 1;
    for (let y = 0; y < S; y += 8) {
      m.beginPath();
      m.moveTo(0, y + 0.5);
      m.lineTo(S, y + 0.5);
      m.stroke();
      for (let x = (y / 8) % 2 === 0 ? 0 : 8; x < S; x += 16) {
        m.beginPath();
        m.moveTo(x + 0.5, y);
        m.lineTo(x + 0.5, y + 8);
        m.stroke();
      }
    }
  } else if (style === 'warehouse') {
    for (let x = 0; x < S; x += 8) {
      m.fillStyle = x % 16 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)';
      m.fillRect(x, 0, 4, S);
    }
  }
  noise(m, S, S, rng, style === 'stucco' || style === 'house' || style === 'hotel' ? 10 : 16, 2);

  const glassGrad = (x: number, y: number, w: number, h: number, top: string, bottom: string) => {
    const g = m.createLinearGradient(x, y, x + w * 0.4, y + h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  };

  for (let row = 0; row < FACADE_ROWS; row++) {
    for (let col = 0; col < FACADE_COLS; col++) {
      const x0 = col * cell;
      const y0 = row * cell;
      let wx = x0;
      let wy = y0;
      let ww = cell;
      let wh = cell;
      let glassTop = '#4f6f8f';
      let glassBottom = '#22364a';
      switch (style) {
        case 'glassBlue':
          wx = x0 + 3;
          wy = y0 + 6;
          ww = cell - 6;
          wh = cell - 10;
          glassTop = '#7fb0de';
          glassBottom = '#2b4e78';
          break;
        case 'glassTeal':
          wx = x0 + 3;
          wy = y0 + 6;
          ww = cell - 6;
          wh = cell - 10;
          glassTop = '#7fd6cc';
          glassBottom = '#1d5a58';
          break;
        case 'office':
          wx = x0;
          wy = y0 + 18;
          ww = cell;
          wh = cell - 32;
          glassTop = '#6b8aa6';
          glassBottom = '#2c3f52';
          break;
        case 'brick':
          wx = x0 + 18;
          wy = y0 + 14;
          ww = cell - 36;
          wh = cell - 26;
          break;
        case 'stucco':
          wx = x0 + 14;
          wy = y0 + 14;
          ww = cell - 28;
          wh = cell - 26;
          break;
        case 'house':
          wx = x0 + 18;
          wy = y0 + 16;
          ww = cell - 36;
          wh = cell - 30;
          break;
        case 'warehouse':
          wx = x0 + 8;
          wy = y0 + 10;
          ww = cell - 16;
          wh = 14;
          break;
        case 'hotel':
          wx = x0 + 6;
          wy = y0 + 10;
          ww = cell - 12;
          wh = cell - 26;
          glassTop = '#7ab8d8';
          glassBottom = '#2c5a78';
          break;
      }
      if (style === 'house' && (col + row) % 3 === 1) continue; // blank walls on houses
      if (style === 'warehouse' && row % 2 === 1) continue;
      m.fillStyle = glassGrad(wx, wy, ww, wh, glassTop, glassBottom);
      m.fillRect(wx, wy, ww, wh);
      // Mullions / frames.
      if (style === 'brick' || style === 'stucco' || style === 'house') {
        m.strokeStyle = style === 'brick' ? '#e8e2d4' : '#ffffff';
        m.lineWidth = 3;
        m.strokeRect(wx, wy, ww, wh);
        m.beginPath();
        m.moveTo(wx + ww / 2, wy);
        m.lineTo(wx + ww / 2, wy + wh);
        m.stroke();
      } else if (style === 'office') {
        m.fillStyle = 'rgba(30,40,50,0.6)';
        for (let k = 0; k < 4; k++) m.fillRect(x0 + (cell / 4) * k, wy, 2, wh);
      } else if (style === 'hotel') {
        // Balcony rail.
        m.fillStyle = '#d8d4cc';
        m.fillRect(x0, y0 + cell - 16, cell, 6);
        m.fillStyle = 'rgba(40,40,40,0.5)';
        for (let k = 0; k < cell; k += 6) m.fillRect(x0 + k, y0 + cell - 22, 1.5, 8);
      }
      // Sky reflection streak on glass.
      m.fillStyle = 'rgba(255,255,255,0.10)';
      m.beginPath();
      m.moveTo(wx + ww * 0.15, wy);
      m.lineTo(wx + ww * 0.45, wy);
      m.lineTo(wx + ww * 0.15, wy + wh);
      m.lineTo(wx, wy + wh);
      m.closePath();
      m.fill();
      // Roughness: glass is shiny.
      r.fillStyle = style === 'glassBlue' || style === 'glassTeal' ? '#222' : '#555';
      r.fillRect(wx, wy, ww, wh);
      // Lit windows at night.
      const litChance = style === 'warehouse' ? 0.15 : style === 'house' ? 0.45 : 0.38;
      if (rng.chance(litChance)) {
        const warm = rng.chance(0.75);
        const v = rng.range(0.55, 1);
        e.fillStyle = warm ? `rgba(255,${Math.round(200 * v + 30)},${Math.round(120 * v)},1)` : `rgba(${Math.round(190 * v)},${Math.round(220 * v)},255,1)`;
        e.fillRect(wx + 1, wy + 1, ww - 2, wh - 2);
        // Curtains / partial light.
        if (rng.chance(0.4)) {
          e.fillStyle = 'rgba(0,0,0,0.55)';
          e.fillRect(wx + 1, wy + 1, ww * rng.range(0.2, 0.5), wh - 2);
        }
      }
    }
  }
  return { map: toTexture(cm), emissive: toTexture(ce), rough: toTexture(cr, false) };
}

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

/** Tileable water normal map from summed sine waves. */
export function waterNormalTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  const waves: Array<[number, number, number, number]> = [];
  const rng = new Rng(99);
  for (let i = 0; i < 9; i++) waves.push([rng.int(1, 6), rng.int(-5, 5), rng.range(0, 6.28), rng.range(0.3, 1) / (i + 1)]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      for (const [kx, ky, ph, a] of waves) v += Math.sin(((kx * x + ky * y) / S) * Math.PI * 2 + ph) * a;
      h[y * S + x] = v;
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = h[y * S + ((x + 1) % S)]! - h[y * S + ((x - 1 + S) % S)]!;
      const dy = h[((y + 1) % S) * S + x]! - h[((y - 1 + S) % S) * S + x]!;
      const nx = -dx * 2;
      const ny = -dy * 2;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = (y * S + x) * 4;
      img.data[i] = ((nx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((nz / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, false);
}

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
